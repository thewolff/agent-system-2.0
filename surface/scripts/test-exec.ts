// test-exec: what the `_as2test` wrapper runs (MIGRATION.md item 24; the approved plan of workload
// wl-muraerdsgw7gn4, revision 12, § 2.3 steps 1 and 3, § 3.1). Installed as a single-file
// `bun build --target=bun` bundle beside the wrapper; a test runs this file directly.
//
//   exec prepare <run id> <sha>        clone <stage>/<run id>/repo.bundle into runs/<run id>/repo, detached at <sha>
//   exec full    <run id>              bun test, junit to runs/<run id>/full.xml, console to full.log, under the full cap;
//                                      with `--parallel=<n>` when caps.json carries `fullWorkers` over 1 (profile/config.yml
//                                      `testRunner.fullWorkers`; no key runs serially)
//   exec solo    <run id> ./<file>     bun test ./<file> alone, to solo-<i>.xml/.log, under the solo cap
//   exec base-prepare <run id> <sha>   the same bundle cloned into runs/<run id>/base/repo at base's <sha> (PLAN wl-mv8s8srodefytc D8)
//   exec base-full <run id>            `full` in the base clone, to base-full.xml/.log; always serial, whatever fullWorkers says,
//                                      so the base cache holds only serial results
//   exec base-solo <run id> ./<file>   `solo` in the base clone, to base-solo-<i>.xml/.log
//   exec sweep   <run id>              SIGTERM, then SIGKILL, to the run's processes, holding locks/sweep.db
//   exec cleanup <run id> <old run id> delete runs/<old run id>
//   exec probe   <run id> <path>...    whether this user can open or write each path (the preflight)
//
// The wrapper fixes the root, bun, the env and the sweep's reach in AS2TEST_EXEC_CONFIG; argv picks
// only the subcommand and its operands. Every subcommand is fenced: it refuses unless
// <root>/stage/current names its run. Exit codes are test-run.ts WRAPPER_EXIT; `full`, `solo` and their base forms
// otherwise pass bun's own exit through (128 + the signal number when bun died by a signal).
//
// Parallel files (workload wl-mvg2kzuvwngdmo): the worker count rides in caps.json, never in argv, so `full <run id>`
// keeps its operand count and the installed wrapper needs no change. The runner logs `full workers <n>` before the PR
// full part; surface/scripts/test-run-waits.ts reads it back per run. The reversal is `fullWorkers: 1` in the profile.
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import {
	accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
	realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { type ExecConfig, probeAnswerLine, REAL_GIT, UID_SWEEP } from "../src/as2test";
import { sweepLegacyNativeTemps } from "../src/as2test-temp";
import {
	AS2TEST_USER, childEnv, childGitconfigText, childLayout, gitShimText, isBunTestFile, RUN_ID_RE, SHA_RE, WRAPPER_EXIT,
} from "../src/test-run";

class Exit extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}
const refuse = (why: string): never => {
	throw new Exit(WRAPPER_EXIT.refused, `refused: ${why}`);
};
const failed = (why: string): never => {
	throw new Exit(WRAPPER_EXIT.failed, `failed: ${why}`);
};

type Config = ExecConfig;

function config(): Config {
	let v: unknown;
	try {
		v = JSON.parse(process.env.AS2TEST_EXEC_CONFIG ?? "");
	} catch {
		return refuse("no wrapper config (run through the exec wrapper)");
	}
	if (!v || typeof v !== "object") return refuse("wrapper config is not an object");
	const c = v as Record<string, unknown>;
	const abs = (x: unknown): x is string => typeof x === "string" && isAbsolute(x) && normalize(x) === x;
	const ms = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
	if (!abs(c.root) || !abs(c.bun) || (c.sweep !== "groups" && c.sweep !== UID_SWEEP) || !(c.hooks === null || abs(c.hooks)) || !ms(c.killGraceMs) || !ms(c.sweepLockWaitMs)) {
		return refuse("wrapper config is malformed");
	}
	if (c.sweep !== "groups" && (c.hooks !== null)) return refuse("hooks are for a groups render only");
	return { root: c.root, bun: c.bun, sweep: c.sweep, hooks: c.hooks, killGraceMs: c.killGraceMs, sweepLockWaitMs: c.sweepLockWaitMs };
}

/** The canonical root and its three areas. */
interface Areas {
	root: string;
	stage: string;
	runs: string;
	locks: string;
}

/** The root is fixed in the wrapper, so its realpath is trusted. */
function areas(cfg: Config): Areas {
	let root: string;
	try {
		root = realpathSync(cfg.root);
	} catch {
		return failed(`root ${cfg.root} is missing`);
	}
	const a = { root, stage: join(root, "stage"), runs: join(root, "runs"), locks: join(root, "locks") };
	for (const dir of [a.stage, a.runs, a.locks]) if (!inside(dir, dir)) failed(`${dir} is missing or not a plain directory`);
	return a;
}

/** `<stage>/current` names `runId`, or the call is fenced (§ 2.3 step 1, Fencing). */
function readCurrent(a: Areas): string | null {
	try {
		return readFileSync(join(a.stage, "current"), "utf8").trim();
	} catch {
		return null;
	}
}
function fence(a: Areas, runId: string): void {
	const current = readCurrent(a);
	if (current !== runId) throw new Exit(WRAPPER_EXIT.fenced, `fenced: ${join(a.stage, "current")} names ${current ?? "no run"}, not ${runId}`);
}

/** `path` resolves (symlinks followed) to `base` itself or beneath it. */
function inside(path: string, base: string): boolean {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return false;
	}
	return real === base || real.startsWith(`${base}/`);
}

/** The run's work dir: `runs/<run id>`, a real directory (no symlink) that resolves to itself. */
function workDir(a: Areas, runId: string): string {
	const work = join(a.runs, runId);
	let st;
	try {
		st = lstatSync(work);
	} catch {
		return refuse(`${work} does not exist (prepare first)`);
	}
	if (!st.isDirectory() || realpathSync(work) !== work) return refuse(`${work} is not a directory under ${a.runs}`);
	return work;
}

async function hook(cfg: Config, runId: string, point: string): Promise<void> {
	if (!cfg.hooks) return;
	const base = join(cfg.hooks, `${runId}.${point}`);
	if (!existsSync(`${base}.pause`)) return;
	writeFileSync(`${base}.reached`, JSON.stringify({ pid: process.pid, at: Date.now() }));
	while (!existsSync(`${base}.go`)) await Bun.sleep(25);
}

// ---- process groups --------------------------------------------------------------------------------

const groupsFile = (work: string) => join(work, "groups");

/** Whether process group `pgid` still has a member this user can signal. */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pgid, sig);
	} catch {
		// gone, or not ours
	}
}

/** SIGTERM the group, wait up to the grace for it to empty, then SIGKILL it (the cap, § 2.3 step 3). */
async function killGroup(cfg: Config, pgid: number): Promise<void> {
	signalGroup(pgid, "SIGTERM");
	const until = Date.now() + cfg.killGraceMs;
	while (groupAlive(pgid) && Date.now() < until) await Bun.sleep(50);
	signalGroup(pgid, "SIGKILL");
}

// ---- prepare ---------------------------------------------------------------------------------------

function git(args: string[], env: Record<string, string>, cwd: string): void {
	const r = spawnSync(REAL_GIT, ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "credential.helper=", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (r.status !== 0) failed(`git ${args[0]}: ${(r.stderr || r.stdout || String(r.error ?? "")).trim().split("\n").at(-1)}`);
}

/** chmod u=rwX,go=rX over a tree, never following a symlink. */
function openUp(path: string): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) return;
	if (st.isDirectory()) {
		chmodSync(path, 0o755);
		for (const name of readdirSync(path)) openUp(join(path, name));
	} else if (st.isFile()) chmodSync(path, st.mode & 0o100 ? 0o755 : 0o644);
}

/**
 * Where a side runs (PLAN wl-mv8s8srodefytc rev 17.1 D8): the PR side in `runs/<run id>` itself, base in `runs/<run id>/base`,
 * each with its own clone (`<dir>/repo`) and child layout. Both sides record their process groups in `runs/<run id>/groups`
 * and write their reports into `runs/<run id>`, base's as `base-full.*` and `base-solo-<i>.*`.
 */
type Side = "pr" | "base";
const REPORT_PREFIX: Record<Side, string> = { pr: "", base: "base-" };

/** The side's directory: the run's work dir, or its `base` child, a real directory that resolves to itself. */
function sideDir(a: Areas, runId: string, side: Side): string {
	const work = workDir(a, runId);
	if (side === "pr") return work;
	const base = join(work, "base");
	if (!inside(base, work) || realpathSync(base) !== base) return refuse(`${base} is not a directory (base-prepare first)`);
	return base;
}

function prepare(cfg: Config, a: Areas, runId: string, sha: string, side: Side): void {
	if (!SHA_RE.test(sha)) refuse(`${sha} is not a full sha`);
	fence(a, runId);
	const stageRun = join(a.stage, runId);
	const bundle = join(stageRun, "repo.bundle");
	if (!existsSync(bundle)) failed(`${bundle} is missing`);
	if (!inside(bundle, stageRun) || realpathSync(bundle) === stageRun) refuse(`${bundle} resolves outside ${stageRun}`);
	// Base clones beside the PR's clone, after it: the run's work dir and its groups file already exist.
	const runWork = side === "pr" ? join(a.runs, runId) : workDir(a, runId);
	const work = side === "pr" ? runWork : join(runWork, "base");
	if (side === "pr" && existsSync(work)) {
		// The shell must make TMPDIR before Bun starts, including a sweep/probe before prepare.
		// Only that bootstrap layout may preexist; claim preparation exclusively before any other write.
		workDir(a, runId);
		const tmp = join(work, ".wrapper-tmp");
		const entries = readdirSync(work);
		if (entries.length !== 1 || entries[0] !== ".wrapper-tmp") refuse(`${work} already exists`);
		const st = lstatSync(tmp);
		if (!st.isDirectory() || realpathSync(tmp) !== tmp || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) refuse(`${tmp} is not an owned private plain directory`);
	} else {
		try {
			mkdirSync(work, { mode: 0o755 });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") refuse(`${work} already exists`);
			throw e;
		}
	}
	// A failed/interrupted prepare is not reusable, nor can two prepare processes share a run.
	try {
		mkdirSync(join(work, ".prepare"), { mode: 0o700 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") refuse(`${work} already exists`);
		throw e;
	}
	const l = childLayout(work);
	for (const d of [l.home, l.tmp, l.xdgConfig, l.xdgCache, l.xdgData, l.bunCache, dirname(l.ledger), l.shimDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
	writeFileSync(l.gitconfig, childGitconfigText(), { mode: 0o644 });
	writeFileSync(join(l.shimDir, "git"), gitShimText(REAL_GIT), { mode: 0o755 });
	symlinkSync(cfg.bun, join(l.shimDir, "bun"));
	if (side === "pr") writeFileSync(groupsFile(work), "", { mode: 0o644 });
	// The clone sees no system config and an empty global one.
	const env = { ...childEnv(process.env, work), GIT_CONFIG_GLOBAL: "/dev/null" };
	git(["clone", "--quiet", "--no-checkout", realpathSync(bundle), join(work, "repo")], env, work);
	git(["checkout", "--quiet", "--detach", sha], env, join(work, "repo"));
	git(["remote", "remove", "origin"], env, join(work, "repo"));
	chmodSync(work, 0o755);
	// Native extraction artifacts in the wrapper's private startup TMPDIR stay private.
	for (const name of readdirSync(work)) if (name !== ".wrapper-tmp") openUp(join(work, name));
	process.stdout.write(`prepared ${join(work, "repo")} at ${sha}\n`);
}

// ---- full and solo ---------------------------------------------------------------------------------

/** `<stage>/<run id>/caps.json`, written by the runner in its trusted phase before any part. */
function caps(a: Areas, runId: string): { path: string; v: Record<string, unknown> } {
	const path = join(a.stage, runId, "caps.json");
	let v: unknown;
	try {
		v = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return refuse(`${path} is missing or not json (the runner writes the caps before a part)`);
	}
	return { path, v: v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {} };
}

function capMs(a: Areas, runId: string, key: "fullCapMin" | "soloCapMin"): number {
	const { path, v } = caps(a, runId);
	const n = v[key];
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return refuse(`${path} has no positive ${key}`);
	return Math.round(n * 60_000);
}

/** The PR full part's workers: caps.json `fullWorkers`, 1 (serial) when the key is absent; anything but an integer of 1 or more is refused. */
function fullWorkers(a: Areas, runId: string): number {
	const { path, v } = caps(a, runId);
	const n = v.fullWorkers;
	if (n === undefined) return 1;
	if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return refuse(`${path} has a fullWorkers that is not an integer of 1 or more`);
	return n;
}

/** Remove a stale report so a part that writes none is read as missing, never as an earlier one. */
function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
}

/** Run `bun test …` in `<dir>/repo` with `<dir>`'s child env, in its own process group under the cap; the group is recorded in the run's groups file for a `groups` sweep. */
async function part(cfg: Config, work: string, dir: string, argv: string[], logPath: string, cap: number): Promise<number> {
	const log = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
	const child = spawn(cfg.bun, argv, { cwd: join(dir, "repo"), env: childEnv(process.env, dir), stdio: ["ignore", log, log], detached: true });
	closeSync(log);
	const pgid = child.pid;
	if (pgid === undefined) return failed(`bun did not start`);
	appendFileSync(groupsFile(work), `${pgid}\n`);
	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const capped = new Promise<"cap">((r) => {
		timer = setTimeout(() => r("cap"), cap);
	});
	const first = await Promise.race([done, capped]);
	clearTimeout(timer);
	if (first === "cap") {
		await killGroup(cfg, pgid);
		await done;
		throw new Exit(WRAPPER_EXIT.timeout, `timeout: the part passed its cap of ${cap} ms; its group was killed`);
	}
	// Anything the part left behind in its group is the sweep's (§ 2.3 step 4): the runner sweeps after every part.
	if (first.code !== null) return first.code;
	return 128 + (first.signal ? (osConstants.signals[first.signal] ?? 0) : 0);
}

async function full(cfg: Config, a: Areas, runId: string, side: Side): Promise<number> {
	fence(a, runId);
	const work = workDir(a, runId);
	const dir = sideDir(a, runId, side);
	const cap = capMs(a, runId, "fullCapMin");
	// Only the PR side runs in parallel: base reruns stay serial, so the base cache only ever holds serial results.
	const workers = side === "pr" ? fullWorkers(a, runId) : 1;
	const xml = join(work, `${REPORT_PREFIX[side]}full.xml`);
	const log = join(work, `${REPORT_PREFIX[side]}full.log`);
	unlinkIfPresent(xml);
	unlinkIfPresent(log);
	return part(cfg, work, dir, ["test", "--reporter=junit", `--reporter-outfile=${xml}`, ...(workers > 1 ? [`--parallel=${workers}`] : [])], log, cap);
}

async function solo(cfg: Config, a: Areas, runId: string, file: string, side: Side): Promise<number> {
	if (!file.startsWith("./")) refuse(`${file} must be ./<relative path>`);
	const rel = file.slice(2);
	if (rel === "" || rel.includes("\0") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) refuse(`${file} is not a plain relative path`);
	if (!isBunTestFile(rel)) refuse(`${file} is not a Bun test file name`);
	fence(a, runId);
	const work = workDir(a, runId);
	const dir = sideDir(a, runId, side);
	const repo = join(dir, "repo");
	let realRepo: string;
	try {
		realRepo = realpathSync(repo);
	} catch {
		return refuse(`${repo} is missing (prepare first)`);
	}
	if (realRepo !== repo) refuse(`${repo} is not a plain directory`);
	const target = join(repo, rel);
	if (!inside(target, realRepo) || realpathSync(target) === realRepo) refuse(`${file} resolves outside the clone`);
	if (!lstatSync(realpathSync(target)).isFile()) refuse(`${file} is not a file`);
	const cap = capMs(a, runId, "soloCapMin");
	// Claim the lowest free index: <stem>-<i>.log is created exclusively.
	let i = 1;
	let log = "";
	const stem = `${REPORT_PREFIX[side]}solo`;
	for (; ; i++) {
		log = join(work, `${stem}-${i}.log`);
		try {
			lstatSync(log);
		} catch {
			break;
		}
	}
	const xml = join(work, `${stem}-${i}.xml`);
	unlinkIfPresent(xml);
	process.stdout.write(`part ${stem}-${i}\n`);
	return part(cfg, work, dir, ["test", "--reporter=junit", `--reporter-outfile=${xml}`, `./${rel}`], log, cap);
}

// ---- sweep -------------------------------------------------------------------------------------------

function isBusy(e: unknown): boolean {
	const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
	return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

/**
 * The sweep (§ 2.3 steps 1 and 3): hold `BEGIN EXCLUSIVE` on `locks/sweep.db` (journal in memory, so
 * no file is ever created beside it) for the whole sweep, in this process, which also sends every
 * signal. With the lock held: `current` must name this run; SIGTERM; wait out the grace; read
 * `current` again and abort if it changed; SIGKILL. The lock goes when the process exits.
 */
async function sweep(cfg: Config, a: Areas, runId: string): Promise<number> {
	fence(a, runId);
	const lockPath = join(a.locks, "sweep.db");
	if (!inside(lockPath, a.locks) || realpathSync(lockPath) !== lockPath) failed(`${lockPath} is not a plain file under ${a.locks}`);
	let db: Database;
	try {
		db = new Database(lockPath, { readwrite: true, create: false });
	} catch (e) {
		return failed(`cannot open ${lockPath}: ${(e as Error).message} (re-run install/as2test-setup.sh)`);
	}
	// Setting the journal mode reads the file under a shared lock, so it waits on a holder exactly
	// like BEGIN EXCLUSIVE does: both sit in the one retry loop, bounded by the lock wait.
	const deadline = Date.now() + cfg.sweepLockWaitMs;
	let journal = false;
	for (;;) {
		const left = deadline - Date.now();
		db.run(`PRAGMA busy_timeout=${Math.max(0, Math.min(left, 5_000))}`);
		try {
			if (!journal) {
				const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=MEMORY").get()?.journal_mode;
				if (mode !== "memory") return failed(`${lockPath} would not take journal_mode=MEMORY (got ${mode}); re-run install/as2test-setup.sh`);
				journal = true;
			}
			db.run("BEGIN EXCLUSIVE");
			break;
		} catch (e) {
			if (e instanceof Exit) throw e;
			if (!isBusy(e)) return failed(`sweep lock: ${(e as Error).message} (re-run install/as2test-setup.sh if ${lockPath} is corrupt)`);
			if (Date.now() >= deadline) throw new Exit(WRAPPER_EXIT.sweepLockHeld, `error sweep lock held: waited ${cfg.sweepLockWaitMs} ms for ${lockPath}`);
			await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
		}
	}
	if (readCurrent(a) !== runId) throw new Exit(WRAPPER_EXIT.fenced, `fenced: current no longer names ${runId}; nothing signalled`);
	await hook(cfg, runId, "sweep-read1");

	const work = join(a.runs, runId);
	const groups = (): number[] => {
		if (cfg.sweep !== "groups") return [];
		let text = "";
		try {
			text = readFileSync(groupsFile(work), "utf8");
		} catch {
			return [];
		}
		return [...new Set(text.split("\n").filter((s) => /^[1-9]\d*$/.test(s)).map(Number))].filter((g) => g !== process.pid);
	};
	// Resolve the actual account, not an argv/config UID. Refuse before signaling or touching /private/tmp
	// unless this is really that user's process. Groups fixtures never resolve the account or sweep temp.
	let ownerUid: number | null = null;
	if (cfg.sweep !== "groups") {
		const id = spawnSync("/usr/bin/id", ["-u", AS2TEST_USER], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const uid = /^\d+\s*$/.test(id.stdout ?? "") ? Number(id.stdout.trim()) : NaN;
		if (id.status !== 0 || !Number.isSafeInteger(uid) || uid <= 0 || process.getuid?.() !== uid) refuse(`uid sweep must run as ${AS2TEST_USER}`);
		ownerUid = uid;
	}
	const signal = (sig: "TERM" | "KILL"): void => {
		if (cfg.sweep === "groups") for (const g of groups()) signalGroup(g, `SIG${sig}`);
		else spawnSync("/usr/bin/pkill", [`-${sig}`, "-U", String(ownerUid)], { stdio: "ignore" });
	};
	const anyLeft = (): boolean => {
		if (cfg.sweep === "groups") return groups().some(groupAlive);
		return spawnSync("/usr/bin/pgrep", ["-U", String(ownerUid)], { stdio: "ignore" }).status === 0;
	};

	signal("TERM");
	const until = Date.now() + cfg.killGraceMs;
	while (anyLeft() && Date.now() < until) await Bun.sleep(50);
	if (readCurrent(a) !== runId) throw new Exit(WRAPPER_EXIT.fenced, `fenced: current changed during the sweep; aborted before SIGKILL`);
	await hook(cfg, runId, "sweep-read2");
	signal("KILL");
	if (cfg.sweep === "groups" && existsSync(groupsFile(work))) writeFileSync(groupsFile(work), groups().filter(groupAlive).map((g) => `${g}\n`).join(""));
	if (ownerUid !== null) {
		for (const removal of sweepLegacyNativeTemps("/private/tmp", ownerUid)) {
			const line = `native-temp: ${JSON.stringify(removal)}\n`;
			if (removal.kind === "removed") process.stdout.write(line);
			else process.stderr.write(line);
		}
	}
	db.run("COMMIT");
	db.close();
	process.stdout.write(`swept ${runId} (${cfg.sweep === "groups" ? "groups" : `uid ${AS2TEST_USER}`})\n`);
	return WRAPPER_EXIT.ok;
}

// ---- cleanup -----------------------------------------------------------------------------------------

/** Delete a tree without following any symlink in it; directories are opened up first so a read-only one goes too. */
function removeTree(path: string): void {
	const st = lstatSync(path);
	if (st.isDirectory()) {
		chmodSync(path, 0o700);
		for (const name of readdirSync(path)) removeTree(join(path, name));
		rmdirSync(path);
	} else unlinkSync(path);
}

function cleanup(a: Areas, runId: string, oldRunId: string): number {
	if (!RUN_ID_RE.test(oldRunId)) refuse(`${oldRunId} is not a run id`);
	if (oldRunId === runId) refuse("cleanup never deletes its own run");
	fence(a, runId);
	const target = join(a.runs, oldRunId);
	let st;
	try {
		st = lstatSync(target);
	} catch {
		process.stdout.write(`cleanup: ${target} is already gone\n`);
		return WRAPPER_EXIT.ok;
	}
	if (st.isSymbolicLink() || !st.isDirectory()) refuse(`${target} is not a real directory`);
	if (realpathSync(target) !== target || dirname(target) !== a.runs) refuse(`${target} is not a direct child of ${a.runs}`);
	removeTree(target);
	process.stdout.write(`cleanup: removed ${target}\n`);
	return WRAPPER_EXIT.ok;
}

// ---- probe ---------------------------------------------------------------------------------------------

/** Whether this user can open `path` for reading (O_NONBLOCK: a FIFO cannot block it), and write it or create it. */
function probeOne(path: string): { path: string; read: boolean; write: boolean } {
	let read = false;
	try {
		closeSync(openSync(path, constants.O_RDONLY | constants.O_NONBLOCK));
		read = true;
	} catch {
		// unreadable or absent
	}
	// A missing path is writable when its nearest existing ancestor is.
	let p = path;
	for (;;) {
		try {
			lstatSync(p);
			break;
		} catch {
			const up = dirname(p);
			if (up === p) break;
			p = up;
		}
	}
	let write = false;
	try {
		accessSync(p, constants.W_OK);
		write = true;
	} catch {
		// not writable
	}
	return { path, read, write };
}

function probe(a: Areas, runId: string, paths: string[]): number {
	if (paths.length === 0 || !paths.every((p) => isAbsolute(p) && !p.includes("\0"))) refuse("probe takes one or more absolute paths");
	fence(a, runId);
	const answers = paths.map((p) => probeOne(resolve(p)));
	process.stdout.write(answers.map((x, i) => `${probeAnswerLine({ ...x, path: paths[i]! })}\n`).join(""));
	return answers.some((x) => x.read || x.write) ? WRAPPER_EXIT.probeReachable : WRAPPER_EXIT.ok;
}

// ---- main ------------------------------------------------------------------------------------------------

const ARITY: Record<string, number> = { prepare: 1, full: 0, solo: 1, "base-prepare": 1, "base-full": 0, "base-solo": 1, sweep: 0, cleanup: 1 };

async function main(argv: string[]): Promise<number> {
	process.umask(0o022);
	const cfg = config();
	const [sub, runId, ...ops] = argv;
	if (sub === undefined || runId === undefined) return refuse("usage: exec <subcommand> <run id> [operand...]");
	if (!RUN_ID_RE.test(runId)) return refuse("run id must match ^tr-[a-z0-9]+$");
	if (sub === "probe") {
		if (ops.length < 1) return refuse("probe takes <run id> and one or more paths");
	} else if (!Object.hasOwn(ARITY, sub)) return refuse(`unknown subcommand ${sub}`);
	else if (ops.length !== ARITY[sub]) return refuse(`${sub} takes exactly ${ARITY[sub]} operand(s) after the run id`);
	const a = areas(cfg);
	switch (sub) {
		case "prepare":
		case "base-prepare":
			prepare(cfg, a, runId, ops[0]!, sub === "prepare" ? "pr" : "base");
			return WRAPPER_EXIT.ok;
		case "full":
		case "base-full":
			return full(cfg, a, runId, sub === "full" ? "pr" : "base");
		case "solo":
		case "base-solo":
			return solo(cfg, a, runId, ops[0]!, sub === "solo" ? "pr" : "base");
		case "sweep":
			return sweep(cfg, a, runId);
		case "cleanup":
			return cleanup(a, runId, ops[0]!);
		default:
			return probe(a, runId, ops);
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (e) {
	if (e instanceof Exit) {
		process.stderr.write(`as2test: ${e.message}\n`);
		process.exitCode = e.code;
	} else {
		process.stderr.write(`as2test: failed: ${(e as Error).stack ?? String(e)}\n`);
		process.exitCode = WRAPPER_EXIT.failed;
	}
}
