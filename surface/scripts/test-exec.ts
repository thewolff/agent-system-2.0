// test-exec: what the `_as2test` wrapper runs (MIGRATION.md item 24; the approved plan of workload
// wl-muraerdsgw7gn4, revision 12, § 2.3 steps 1 and 3, § 3.1). Installed as a single-file
// `bun build --target=bun` bundle beside the wrapper; a test runs this file directly.
//
//   exec prepare <run id> <sha>        clone <stage>/<run id>/repo.bundle into runs/<run id>/repo, detached at <sha>
//   exec full    <run id>              bun test, junit to runs/<run id>/full.xml, console to full.log, under the full cap;
//                                      with resource-admitted `--parallel=<n>` beneath caps.json `fullWorkers`' ceiling whenever
//                                      that ceiling is over 1, n = 1 included (`--parallel` implies --isolate, so isolation never
//                                      depends on host load); a ceiling of 1 passes no `--parallel`, and the part stays serial;
//                                      every part also bounds concurrent cases with `--max-concurrency=1`
//   exec solo    <run id> ./<file>     bun test ./<file> alone, to solo-<i>.xml/.log, under the solo cap
//   exec base-prepare <run id> <sha>   the same bundle cloned into runs/<run id>/base/repo at base's <sha> (PLAN wl-mv8s8srodefytc D8)
//   exec base-solo <run id> ./<file>   `solo` in the base clone, to base-solo-<i>.xml/.log
//   exec fast    <run id> ./<file>...  the given test files in one bun test call in the PR clone, junit to fast.xml, console
//                                      to fast.log, under caps.json `fastCapMin`, with full's workers (PLAN wl-mvq4edbaf13vnk
//                                      D4: the Mac fallback of the hosted fast check)
//   exec sweep   <run id>              SIGTERM, then SIGKILL, to the run's processes, holding locks/sweep.db
//   exec cleanup <run id> <old run id> delete runs/<old run id>
//   exec probe   <run id> <path>...    whether this user can open or write each path (the preflight)
//
// The wrapper fixes the root, bun, the env and the sweep's reach in AS2TEST_EXEC_CONFIG; argv picks
// only the subcommand and its operands. Every subcommand is fenced: it refuses unless
// <root>/stage/current names its run. Exit codes are test-run.ts WRAPPER_EXIT; `full`, `solo`, `base-solo` and `fast`
// otherwise pass bun's own exit through (128 + the signal number when bun died by a signal), except 125
// (`WRAPPER_EXIT.stuck`) after a stuck-worker stop.
//
// At a part's cap, before its group is killed, a bounded stuck capture (process tree, `sample` per bun process, `lsof` per
// process, the log's last 200 lines) goes to `<part stem>.stuck.log` beside the part's log (PLAN wl-mvq4edh02r5z40 D5).
//
// Stuck workers (PLAN wl-mvq8x4pkjmx69s D3): caps.json `stuckStop` (`shadow` when absent, `enforce`; anything else is
// refused). Every part gets `--preload <work>/stuck-preload-<stem>.js`, which holds an flock on
// `$AS2TEST_STUCK_MARKERS/<pid>` for exactly each `Bun.spawnSync` call, and a detector timer (surface/src/stuck-detect.ts,
// spawn-free) that writes `stuck-*` lines to stdout. On a match it takes one bounded signature capture to
// `<part stem>.signature.log` (both modes); in enforce it then kills every process group holding an owned process and
// exits 125. Shadow only logs `stuck-would-stop` and leaves the part to its cap.
//
// Resource policy: caps.json carries only the worker ceiling and optional fixed timingProof booleans, not costs,
// executable paths or arbitrary env. The wrapper fixes measured resources.json and pinned installed-omp.json.
// Each part records its actual admission and child argv in <part-stem>.resources.json; configured workers alone are not observation.
import { Database } from "bun:sqlite";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
	readFileSync, readSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { type ExecConfig, probeAnswerLine, REAL_GIT, UID_SWEEP } from "../src/as2test";
import { sweepLegacyNativeTemps } from "../src/as2test-temp";
import {
	admitResources, boundedTestArgs, parseResourceCosts, parseTimingProof, proofChildEnv, readInstalledOmp, readResourceInputs, verifyTrustedPath,
	type InstalledOmp, type ResourceAdmission, type ResourceCosts, type ResourceInputs,
} from "../src/test-resources";
import {
	liveOwned, type Observation, observe, type Proc as Seen, type Signature, type Snapshot, snapshot, STUCK_DEFAULTS, StuckDetector, type TickResult,
} from "../src/stuck-detect";
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
	if (!abs(c.root) || !abs(c.bun) || !abs(c.resourcesPath) || !abs(c.ompRuntimePath) || (c.sweep !== "groups" && c.sweep !== UID_SWEEP) || !(c.hooks === null || abs(c.hooks)) || !ms(c.killGraceMs) || !ms(c.sweepLockWaitMs) || !ms(c.captureMs)
		|| !ms(c.detectTickMs) || c.detectTickMs < 1 || !ms(c.detectPersistMs) || !ms(c.signatureCaptureMs) || !ms(c.stopGraceMs) || typeof c.detectTrace !== "boolean") {
		return refuse("wrapper config is malformed");
	}
	if (c.sweep !== "groups" && (c.hooks !== null || c.detectTrace)) return refuse("hooks and detectTrace are for a groups render only");
	return {
		root: c.root, bun: c.bun, sweep: c.sweep, hooks: c.hooks, killGraceMs: c.killGraceMs, sweepLockWaitMs: c.sweepLockWaitMs, captureMs: c.captureMs,
		resourcesPath: c.resourcesPath, ompRuntimePath: c.ompRuntimePath,
		detectTickMs: c.detectTickMs, detectPersistMs: c.detectPersistMs, signatureCaptureMs: c.signatureCaptureMs, stopGraceMs: c.stopGraceMs, detectTrace: c.detectTrace,
	};
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

/**
 * A test's pause point: when `<hooks>/<run>.<point>.pause` exists, write `.reached` (this pid, the time and `info`) and wait for
 * `.go`, or until `stop` says so (the stuck capture's hooks stop at its deadline).
 */
async function hook(cfg: Config, runId: string, point: string, o: { stop?: () => boolean; info?: Record<string, unknown> } = {}): Promise<void> {
	if (!cfg.hooks) return;
	const base = join(cfg.hooks, `${runId}.${point}`);
	if (!existsSync(`${base}.pause`)) return;
	writeFileSync(`${base}.reached`, JSON.stringify({ pid: process.pid, at: Date.now(), ...o.info }));
	while (!existsSync(`${base}.go`) && !o.stop?.()) await Bun.sleep(25);
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

/** Append once through a validated descriptor: a child may have replaced this pathname while it ran. */
function persistGroups(work: string, groups: number[]): void {
	const path = groupsFile(work);
	const text = groups.map((g) => `${g}\n`).join("");
	const errors: string[] = [];
	let fd: number | undefined;
	let operation = "open";
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		operation = "validate";
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error("not a regular file");
		operation = "append";
		const n = writeSync(fd, text);
		if (n !== text.length) throw new Error(`short write: ${n} of ${text.length} bytes`);
	} catch (e) {
		errors.push(`${operation} failed: ${errText(e)}`);
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (e) {
				errors.push(`close failed: ${errText(e)}`);
			}
		}
	}
	if (errors.length > 0) failed(`timeout cleanup: cannot persist descendant groups to ${path}: ${errors.join("; ")}`);
}

/**
 * Snapshot descendant group leaders before TERM can orphan them. Bun's parallel workers lead their own groups, so
 * killing only `pgid` relies on bun forwarding the signal. Persist those groups for a later sweep as well.
 * Discovery has one 2 s deadline; even a failed discovery must not prevent killing the groups already known.
 */
async function killGroup(cfg: Config, pgid: number, work: string): Promise<void> {
	const groups = new Set([pgid]);
	let cleanupError: unknown;
	try {
		const deadline = Date.now() + 2_000;
		const query = (flag: "-g" | "-P", ids: number[]): number[] => {
			const left = deadline - Date.now();
			if (left <= 0) failed(`timeout cleanup: discovering descendants of group ${pgid} exceeded 2000 ms`);
			const r = spawnSync("/usr/bin/pgrep", [flag, ids.join(",")], { encoding: "utf8", timeout: left, maxBuffer: PS_CAP });
			if (r.error || (r.status !== 0 && r.status !== 1)) {
				failed(`timeout cleanup: pgrep ${flag} ${ids.join(",")}: ${r.error?.message ?? (r.stderr.trim() || `exit ${r.status}, signal ${r.signal}`)}`);
			}
			return r.stdout.split("\n").filter((s) => /^[1-9]\d*$/.test(s)).map(Number);
		};
		const seen = new Set([pgid]);
		let frontier = [...new Set([pgid, ...query("-g", [pgid])])];
		for (let depth = 0; frontier.length > 0; depth++) {
			if (depth >= 32) failed(`timeout cleanup: descendants of group ${pgid} exceeded 32 levels`);
			for (const pid of frontier) if (groupAlive(pid)) groups.add(pid);
			frontier = query("-P", frontier).filter((pid) => !seen.has(pid));
			for (const pid of frontier) seen.add(pid);
		}
		persistGroups(work, [...groups].filter((g) => g !== pgid));
	} catch (e) {
		cleanupError = e;
	}
	const targets = [...groups];
	for (const g of targets) signalGroup(g, "SIGTERM");
	const until = Date.now() + cfg.killGraceMs;
	while (targets.some(groupAlive) && Date.now() < until) await Bun.sleep(50);
	for (const g of targets) signalGroup(g, "SIGKILL");
	if (cleanupError !== undefined) throw cleanupError;
}

// ---- the stuck capture (PLAN wl-mvq4edh02r5z40 revision 3, D5) -------------------------------------------

/** The most bytes a section of `<part>.stuck.log` holds; also a tool's stdout, a sample report read and the log tail read. */
const CAPTURE_CAP = 1 << 20;
/** ps lists every process; its stdout is filtered to the part's tree before the section cap applies. */
const PS_CAP = 8 << 20;
/** A tool that fails or is refused leaves the last this many bytes of its stderr. */
const STDERR_TAIL = 2_048;
const LOG_TAIL_LINES = 200;
const PS = ["/bin/ps", "-ax", "-o", "pid=,ppid=,pgid=,state=,etime=,command="];

/** Thrown inside the capture once it was cut or ended: the step after it never runs. */
class Abandoned extends Error {}

interface ToolRun {
	argv: string[];
	pid: number | undefined;
	code: number | null;
	signal: NodeJS.Signals | null;
	/** spawn's own failure (ENOENT, EPERM, …) when the tool never ran. */
	error: string | null;
	out: string;
	err: string;
	ms: number;
}

const errText = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e));

/** One capture: its O_EXCL output file, its deadline, the capture tools still running (each the leader of its own group), its cap dir and the sample reports it named there. */
class Capture {
	private fd: number | null;
	readonly started = Date.now();
	readonly deadline: number;
	/** The capture tools whose pipes have not closed, by process group. */
	private readonly live = new Map<number, ChildProcess>();
	capDir: string | null = null;
	/** The `sample-<pid>.txt` paths this capture named in its cap dir: the only names cleanup unlinks before the kill. */
	private readonly reports = new Set<string>();
	/** Whether the stuck log already says the cap dir was left for after the kill. */
	private capDirLeft = false;
	/** Set at the cut or the end: nothing after it is spawned, read or written as a section. */
	over = false;

	constructor(fd: number, captureMs: number) {
		this.fd = fd;
		this.deadline = this.started + captureMs;
	}

	alive(): void {
		if (this.over) throw new Abandoned();
	}

	/** Whether a hook wait or a report read must stop: the capture is over or its deadline passed. */
	readonly late = (): boolean => this.over || Date.now() >= this.deadline;

	write(text: string): void {
		if (this.fd === null) return;
		try {
			writeSync(this.fd, text);
		} catch (e) {
			process.stderr.write(`as2test: stuck capture: write failed: ${errText(e)}\n`);
			this.close();
		}
	}

	/** A headed, timed section, its body capped at CAPTURE_CAP bytes. */
	section(title: string, since: number, body: string): void {
		this.alive();
		const bytes = Buffer.from(body);
		const text = bytes.length > CAPTURE_CAP ? `${bytes.subarray(0, CAPTURE_CAP).toString()}\n[section cut at ${CAPTURE_CAP} bytes]\n` : body;
		this.write(`== ${title} (${Date.now() - since} ms) ==\n${text}${text.endsWith("\n") ? "" : "\n"}`);
	}

	/**
	 * Run one tool async, detached in its own process group, stdout kept to `outCap` bytes and stderr to its last
	 * STDERR_TAIL; resolves when its pipes close (never rejects once started). Nothing is spawned once the capture is over.
	 */
	tool(argv: string[], outCap = CAPTURE_CAP): Promise<ToolRun> {
		this.alive();
		const t0 = Date.now();
		const { promise, resolve } = Promise.withResolvers<ToolRun>();
		const out: Buffer[] = [];
		let outLen = 0;
		let err = Buffer.alloc(0);
		let child: ChildProcess | undefined;
		let settled = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null, error: string | null) => {
			if (settled) return;
			settled = true;
			if (child?.pid !== undefined) this.live.delete(child.pid);
			resolve({ argv, pid: child?.pid, code, signal, error, out: Buffer.concat(out).toString(), err: err.toString(), ms: Date.now() - t0 });
		};
		try {
			child = spawn(argv[0]!, argv.slice(1), { cwd: "/", stdio: ["ignore", "pipe", "pipe"], detached: true });
		} catch (e) {
			finish(null, null, errText(e));
			return promise;
		}
		if (child.pid !== undefined) this.live.set(child.pid, child);
		child.stdout?.on("data", (c: Buffer) => {
			const keep = Math.min(c.length, outCap - outLen);
			if (keep > 0) {
				out.push(c.subarray(0, keep));
				outLen += keep;
			}
		});
		child.stderr?.on("data", (c: Buffer) => {
			err = Buffer.concat([err, c]);
			if (err.length > STDERR_TAIL) err = err.subarray(err.length - STDERR_TAIL);
		});
		child.on("error", (e) => finish(null, null, errText(e)));
		child.on("close", (code, signal) => finish(code, signal, null));
		return promise;
	}

	/** End the capture: SIGKILL every capture group still running and abandon its pipes (never awaited); returns those groups. */
	stop(): number[] {
		this.over = true;
		const killed = [...this.live.keys()];
		for (const [pgid, child] of this.live) {
			signalGroup(pgid, "SIGKILL");
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
		}
		this.live.clear();
		return killed;
	}

	/** The path `sample` writes its report for `pid` to, inside the cap dir; recorded so cleanup unlinks exactly it. */
	reportPath(pid: number): string {
		const path = join(this.capDir!, `sample-${pid}.txt`);
		this.reports.add(path);
		return path;
	}

	/**
	 * Before the kill, bounded work only: unlink each sample report this capture named (lstat first; a link is unlinked itself,
	 * never followed; a directory is left), then one rmdir of the cap dir. When that rmdir fails (something else is in it, or a
	 * just-killed sample is still closing) the dir is left for `afterKill` and the stuck log says so, once.
	 */
	clearCapDir(): void {
		if (this.capDir === null) return;
		for (const report of this.reports) {
			try {
				if (!lstatSync(report).isDirectory()) unlinkSync(report);
			} catch {
				// already gone, or not removable here: the rmdir below fails and afterKill removes it
			}
		}
		this.reports.clear();
		try {
			rmdirSync(this.capDir);
			this.capDir = null;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				this.capDir = null;
				return;
			}
			if (this.capDirLeft) return;
			this.capDirLeft = true;
			this.write(code === "ENOTEMPTY" || code === "EEXIST" ? "cap dir not empty: left for after the kill\n" : `cap dir not removed: ${errText(e)}: left for after the kill\n`);
		}
	}

	/**
	 * After killGroup has killed the part's groups: remove a cap dir `clearCapDir` left, without following a link in it
	 * (removeTree; a just-killed sample may still be closing, so a few tries), then close the stuck log. Never throws.
	 */
	async afterKill(): Promise<void> {
		try {
			for (let attempt = 1; this.capDir !== null; attempt++) {
				try {
					removeTree(this.capDir);
					this.capDir = null;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code === "ENOENT") this.capDir = null;
					else if (attempt >= 5) {
						this.write(`cap dir ${this.capDir} not removed after the kill: ${errText(e)}\n`);
						this.capDir = null;
					} else await Bun.sleep(20);
				}
			}
		} finally {
			this.close();
		}
	}

	close(): void {
		this.over = true;
		if (this.fd === null) return;
		const fd = this.fd;
		this.fd = null;
		closeSync(fd);
	}
}

/** A tool's block in its section: the command, its pid, how it ended and its stdout; on a failure or refusal, its stderr tail. */
function toolBlock(r: ToolRun): string {
	const how = r.error !== null ? `not run: ${r.error}` : r.signal !== null ? `signal ${r.signal}` : `exit ${r.code}`;
	const failedTool = r.error !== null || r.code !== 0;
	const out = r.out === "" || r.out.endsWith("\n") ? r.out : `${r.out}\n`;
	const err = failedTool && r.err.trim() !== "" ? `stderr (last ${STDERR_TAIL} bytes):\n${r.err.trimEnd()}\n` : "";
	return `$ ${r.argv.join(" ")}  [pid ${r.pid ?? "none"}, ${how}, ${r.ms} ms]\n${out}${err}`;
}

/**
 * Read a file only when it is a regular file, without following a link or blocking: open O_RDONLY|O_NOFOLLOW|O_NONBLOCK,
 * fstat, then one positional read of at most `max` bytes, the first (`head`) or the last (`tail`).
 */
function readRegular(path: string, max: number, from: "head" | "tail"): { text: string } | { refused: string } {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (e) {
		return { refused: `${path}: open failed: ${errText(e)}` };
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) {
			const kind = st.isFIFO() ? "a FIFO" : st.isDirectory() ? "a directory" : st.isSocket() ? "a socket" : "a device";
			return { refused: `${path} is ${kind}, not a regular file` };
		}
		const len = Math.min(st.size, max);
		const buf = Buffer.alloc(len);
		const n = readSync(fd, buf, 0, len, from === "tail" ? st.size - len : 0);
		return { text: buf.subarray(0, n).toString() };
	} finally {
		closeSync(fd);
	}
}

interface Proc {
	pid: number;
	bun: boolean;
}

/** Whether a command line runs bun: its first word's basename. */
const runsBun = (command: string): boolean => basename(command.trim().split(/\s+/)[0] ?? "") === "bun";

/**
 * Section 1: the part's process group plus every descendant of its members (a child that moved group is still shown), from
 * one ps snapshot. Where ps is refused (a sandbox refuses its setuid exec), its exit and stderr, then the same tree from pgrep.
 */
async function processTree(c: Capture, pgid: number): Promise<{ body: string; procs: Proc[] }> {
	const ps = await c.tool(PS, PS_CAP);
	c.alive();
	if (ps.error === null && ps.code === 0) {
		const rows = ps.out.split("\n").flatMap((line) => {
			const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+(.*)$/.exec(line);
			return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]!, line: line.trim() }] : [];
		});
		const tree = new Set([pgid, ...rows.filter((r) => r.pgid === pgid).map((r) => r.pid)]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const r of rows) {
				if (tree.has(r.ppid) && !tree.has(r.pid)) {
					tree.add(r.pid);
					grew = true;
				}
			}
		}
		const mine = rows.filter((r) => tree.has(r.pid));
		return {
			body: ["PID PPID PGID STAT ELAPSED COMMAND", ...mine.map((r) => r.line), ""].join("\n"),
			procs: mine.map((r) => ({ pid: r.pid, bun: runsBun(r.command) })),
		};
	}
	const lines = [toolBlock(ps).trimEnd(), "fallback: /usr/bin/pgrep -lf (PID COMMAND; no ppid, state or elapsed)"];
	const found = new Map<number, string>();
	const pgrep = async (args: string[]): Promise<number[]> => {
		const r = await c.tool(["/usr/bin/pgrep", "-lf", ...args]);
		c.alive();
		// pgrep exits 1 when nothing matched; anything else is a failure worth keeping.
		if (r.error !== null || (r.code !== 0 && r.code !== 1)) lines.push(toolBlock(r).trimEnd());
		const fresh: number[] = [];
		for (const line of r.out.split("\n")) {
			const m = /^(\d+) (.*)$/.exec(line);
			if (!m || found.has(Number(m[1]))) continue;
			found.set(Number(m[1]), m[2]!);
			fresh.push(Number(m[1]));
		}
		return fresh;
	};
	let frontier = [pgid, ...(await pgrep(["-g", String(pgid)]))];
	for (let depth = 0; frontier.length > 0 && depth < 32; depth++) frontier = await pgrep(["-P", frontier.join(",")]);
	for (const [pid, command] of found) lines.push(`${pid} ${command}`);
	return { body: `${lines.join("\n")}\n`, procs: [...found].map(([pid, command]) => ({ pid, bun: runsBun(command) })) };
}

/**
 * One bun process: `sample <pid> <seconds>` into the cap dir, then (before the deadline only, after the `point` hook) its report
 * read the safe way. Never rejects.
 */
async function sampleOne(cfg: Config, runId: string, c: Capture, pid: number, seconds: number, point: string): Promise<string> {
	try {
		const report = c.reportPath(pid);
		const r = await c.tool(["/usr/bin/sample", String(pid), String(seconds), "-mayDie", "-file", report]);
		await hook(cfg, runId, point, { stop: c.late, info: { report } });
		if (c.late()) return `${toolBlock(r)}report not read: the capture is over\n`;
		const read = readRegular(report, CAPTURE_CAP, "head");
		return `${toolBlock(r)}${"text" in read ? `report (first ${CAPTURE_CAP} bytes at most):\n${read.text}` : `report refused: ${read.refused}`}\n`;
	} catch (e) {
		return e instanceof Abandoned ? "" : `sample ${pid}: failed: ${errText(e)}\n`;
	}
}

/** The last LOG_TAIL_LINES lines of the part's log, read the safe way (a capture's last section). */
function logTail(logPath: string): string {
	const tail = readRegular(logPath, CAPTURE_CAP, "tail");
	if ("refused" in tail) return `refused: ${tail.refused}\n`;
	const lines = tail.text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.length === 0 ? "(empty)\n" : `${lines.slice(-LOG_TAIL_LINES).join("\n")}\n`;
}

/** Sections 1-4 in order; sample and lsof start together once the tree is known. */
async function captureSections(cfg: Config, runId: string, c: Capture, pgid: number, work: string, stem: string, logPath: string): Promise<void> {
	c.capDir = mkdtempSync(join(work, `${stem}.stuck-`));
	let since = Date.now();
	const { body, procs } = await processTree(c, pgid);
	c.section(`1. process tree of group ${pgid}: ${PS.join(" ")}`, since, body);
	since = Date.now();
	const buns = procs.filter((p) => p.bun);
	const samples = buns.map((p) => sampleOne(cfg, runId, c, p.pid, 3, "stuck-sample-read"));
	const lsofs = procs.map((p) => c.tool(["/usr/sbin/lsof", "-nP", "-p", String(p.pid)]));
	await hook(cfg, runId, "stuck-capture", { stop: c.late });
	c.alive();
	const sampled = await Promise.all(samples);
	c.alive();
	c.section(`2. sample per bun process (${buns.length})`, since, buns.length === 0 ? "no bun process in the tree\n" : sampled.join("\n"));
	const listed = await Promise.all(lsofs);
	c.alive();
	c.section(`3. lsof per process (${procs.length})`, since, procs.length === 0 ? "no process in the tree\n" : listed.map(toolBlock).join("\n"));
	c.clearCapDir();
	since = Date.now();
	c.section(`4. last ${LOG_TAIL_LINES} lines of ${logPath}`, since, logTail(logPath));
}

/**
 * A bounded capture into `path`, opened O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW; when that open fails the capture is skipped with one
 * stderr line naming `what` and null comes back. One deadline (`ms`) owns it: at the deadline every capture group still running
 * is SIGKILLed, its readers are abandoned, the cap dir is cleared with bounded work only (`clearCapDir`) and the file says
 * `capture cut at <ms> ms`. The caller calls the returned capture's `afterKill` (a leftover cap dir goes, the file closes).
 * Never throws.
 */
async function boundedCapture(what: string, path: string, ms: number, header: (started: number) => string, sections: (c: Capture) => Promise<void>): Promise<Capture | null> {
	let fd: number;
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
	} catch (e) {
		process.stderr.write(`as2test: ${what} skipped: cannot create ${path}: ${errText(e)}\n`);
		return null;
	}
	const c = new Capture(fd, ms);
	try {
		c.write(header(c.started));
		const deadline = Promise.withResolvers<"cut">();
		const timer = setTimeout(() => deadline.resolve("cut"), ms);
		const run = sections(c).then(
			() => "done" as const,
			(e: unknown) => {
				if (!(e instanceof Abandoned)) c.write(`capture failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
				return "done" as const;
			},
		);
		const how = await Promise.race([run, deadline.promise]);
		clearTimeout(timer);
		const killed = c.stop();
		c.clearCapDir();
		if (how === "cut") c.write(`capture cut at ${Date.now() - c.started} ms\nkilled capture groups: ${killed.join(" ") || "none"}\n`);
		else if (killed.length > 0) c.write(`killed capture groups still running: ${killed.join(" ")}\n`);
	} catch (e) {
		c.write(`capture failed: ${errText(e)}\n`);
	}
	return c;
}

/**
 * D5: before the cap's kill, a bounded stuck capture into `<part stem>.stuck.log` beside the part's log (`boundedCapture`,
 * deadline cfg.captureMs). The caller kills the part's group, then calls the returned capture's `afterKill`. Nothing it does
 * changes the part's exit.
 */
async function stuckCapture(cfg: Config, runId: string, work: string, pgid: number, logPath: string, cap: number): Promise<Capture | null> {
	const stem = basename(logPath, ".log");
	return boundedCapture(
		"stuck capture",
		join(work, `${stem}.stuck.log`),
		cfg.captureMs,
		(started) => `stuck capture of ${stem} (process group ${pgid}) at its cap of ${cap} ms, ${new Date(started).toISOString()}, deadline ${cfg.captureMs} ms\n`,
		(c) => captureSections(cfg, runId, c, pgid, work, stem, logPath),
	);
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
 * and write their reports into `runs/<run id>`, base's as `base-solo-<i>.*`.
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

function capMs(a: Areas, runId: string, key: "fullCapMin" | "soloCapMin" | "fastCapMin"): number {
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

// ---- the stuck-worker detector (PLAN wl-mvq8x4pkjmx69s D3) ------------------------------------------------------------

type StuckMode = "shadow" | "enforce";

/** caps.json `stuckStop`: `shadow` when the key is absent; anything but `shadow` or `enforce` is refused, as a bad fullWorkers. */
function stuckMode(a: Areas, runId: string): StuckMode {
	const { path, v } = caps(a, runId);
	const m = v.stuckStop;
	if (m === undefined) return "shadow";
	if (m !== "shadow" && m !== "enforce") return refuse(`${path} has a stuckStop that is not shadow or enforce`);
	return m;
}

/**
 * The marker preload (D1, D3), written per part to `<work>/stuck-preload-<part>.js` and passed as `bun test --preload`. bun runs
 * a preload once per isolated test file, each in a fresh global (probe, bun 1.3.14), so each run wraps that global's
 * `Bun.spawnSync`. The marker is opened per call and closed after it (no fd outlives a call or a discarded global); it is created
 * at load so a test can act on it before its first call. No backtick and no dollar-brace in it: it is a String.raw constant.
 */
const STUCK_PRELOAD = String.raw`// agent-system 2.0 test runner: the stuck-worker marker preload (PLAN wl-mvq8x4pkjmx69s D1, D3). test-exec writes it for
// one part and removes it when the part ends. It wraps Bun.spawnSync (node's sync child_process APIs route through it): for
// each outermost call it writes "<since ms>\t<command>\n" to $AS2TEST_STUCK_MARKERS/<pid> and holds an flock on that file for
// exactly the call. The call returns or throws exactly what it would have; the wrapper's own fs and ffi errors only stop
// publication (a missed detection, never a false one). It publishes only a call whose every input is plain data, so a held
// marker means the native call itself is running, never test code the call runs while it reads its arguments (review r2
// finding 1, r3, r4): argv (or cmd) a dense, non-proxy array of own data strings; options, when given, a non-proxy, non-array
// object with prototype Object.prototype or null whose own properties are all data properties holding, per key: for env a
// primitive or such an object whose own properties are all data primitives (bun gets each own value); for stdio a primitive
// or a dense array of primitives; for any other key (stdin, stdout and stderr included) a primitive. An object with prototype
// Object.prototype also needs Object.prototype clean at the call: no accessor on it but the __proto__ it had at load. A
// function, a getter, a hole, a proxy, bytes (an ArrayBuffer or a view, a Buffer included) or any other object runs the call
// unpublished: bun looks up a byte container's Symbol.asyncIterator, own or inherited, before it takes the bytes, and that
// lookup runs a getter (review r4). So a call carrying bytes, as node's spawnSync, execSync and execFileSync with input,
// runs unpublished: a missed detection, never a false one. It reads only descriptors, through functions bound at load, so
// no getter, proxy trap or replaced builtin runs here.
import fs from "node:fs";
import { types } from "node:util";
import { dlopen, FFIType } from "bun:ffi";

const MARK = Symbol.for("as2test.stuck-marker");
const dir = process.env.AS2TEST_STUCK_MARKERS;
if (typeof dir === "string" && dir.startsWith("/") && process.platform === "darwin" && typeof Bun.spawnSync === "function" && !Bun.spawnSync[MARK]) {
	try {
		// Bound at load: a test that later replaces any of these cannot reach the marker.
		const openSync = fs.openSync;
		const closeSync = fs.closeSync;
		const ftruncateSync = fs.ftruncateSync;
		const writeSync = fs.writeSync;
		const nowMs = Date.now;
		const apply = Reflect.apply;
		const ownDescriptor = Object.getOwnPropertyDescriptor;
		const hasOwn = Object.hasOwn;
		const ownKeys = Reflect.ownKeys;
		const protoOf = Object.getPrototypeOf;
		const OBJECT_PROTO = Object.prototype;
		const isArray = Array.isArray;
		const isProxy = types.isProxy;
		const strSlice = String.prototype.slice;
		const strIndexOf = String.prototype.indexOf;
		const strLastIndexOf = String.prototype.lastIndexOf;
		const flock = dlopen("/usr/lib/libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
		const original = Bun.spawnSync;
		const path = dir + "/" + process.pid;
		// O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC (0x1000000 on darwin; bun's fs constants lack it): a child never inherits it.
		const FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | 0x1000000;
		const LOCK_EX = 2;
		const LOCK_NB = 4;
		const LOCK_UN = 8;
		closeSync(openSync(path, FLAGS, 0o600));
		let depth = 0;
		let off = false;
		// An own data property's value (a fresh descriptor's own "value", read without a getter), else undefined.
		const own = (o, key) => {
			const d = ownDescriptor(o, key);
			return d !== undefined && hasOwn(d, "value") ? d.value : undefined;
		};
		// The get and set of o's own accessor property key (a fresh descriptor's own fields), or null when key is no own accessor.
		const accessorOf = (o, key) => {
			const d = ownDescriptor(o, key);
			return d !== undefined && hasOwn(d, "get") ? { get: d.get, set: d.set } : null;
		};
		// Object.prototype's __proto__ accessor at load: the one accessor a clean Object.prototype keeps.
		const PROTO_ACCESSOR = accessorOf(OBJECT_PROTO, "__proto__");
		// Whether o's own property key is a data property whose value passes ok(value, key).
		const dataPasses = (o, key, ok) => {
			const d = ownDescriptor(o, key);
			return d !== undefined && hasOwn(d, "value") && ok(d.value, key);
		};
		const primitive = (v) => v === null || (typeof v !== "object" && typeof v !== "function");
		const isString = (v) => typeof v === "string";
		// A non-proxy real array with an own data property passing ok at every index (a hole is read through Array.prototype).
		const denseArray = (a, ok) => {
			if (a === null || typeof a !== "object" || isProxy(a) || !isArray(a)) return false;
			const n = own(a, "length");
			for (let i = 0; i < n; i++) if (!dataPasses(a, i, ok)) return false;
			return true;
		};
		// Whether Object.prototype holds no accessor but the __proto__ it held at load (descriptors only). bun 1.3.14 stops its
		// option lookups before Object.prototype (ObjectBindings.cpp, getNonIndexPropertySlotPrototypePollutionMitigation) and
		// reads a dense array by own index and length (JSArrayIterator), so neither prototype reaches test code today; this keeps
		// the options rule if a later bun reads Object.prototype (review r3).
		const cleanObjectProto = () => {
			const keys = ownKeys(OBJECT_PROTO);
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				const d = ownDescriptor(OBJECT_PROTO, key);
				if (d !== undefined && hasOwn(d, "value")) continue;
				if (key !== "__proto__" || PROTO_ACCESSOR === null || d === undefined || !hasOwn(d, "get")) return false;
				if (d.get !== PROTO_ACCESSOR.get || d.set !== PROTO_ACCESSOR.set) return false;
			}
			return true;
		};
		// A non-proxy, non-array object with prototype null, or Object.prototype while that is clean.
		const plainObject = (o) => {
			if (o === null || typeof o !== "object" || isProxy(o) || isArray(o)) return false;
			const proto = protoOf(o);
			return proto === null || (proto === OBJECT_PROTO && cleanObjectProto());
		};
		// Every own property of o (string and symbol keys) a data property whose value passes ok.
		const allOwnData = (o, ok) => {
			const keys = ownKeys(o);
			for (let i = 0; i < keys.length; i++) if (!dataPasses(o, keys[i], ok)) return false;
			return true;
		};
		// An option's value, per key, by what bun 1.3.14 does with it (js_bun_spawn_bindings.zig): cmd is the argv; env's own
		// keys are enumerated and each value got (JSPropertyIterator), so it must hold data primitives only; stdio is iterated by
		// index; every other option, stdin, stdout and stderr included, must be a primitive. A primitive is read or refused by
		// bun without running anything (node passes env: undefined; a probe saw no getter on String, Number, Boolean, Object or
		// Symbol.prototype run). Bytes are refused: bun's stdio extract hands a byte container to ReadableStream.fromJS first
		// (stdio.zig), whose Symbol.asyncIterator lookup runs an own or inherited getter (ReadableStream.cpp; review r4).
		const optionValue = (v, key) => {
			if (key === "cmd") return denseArray(v, isString);
			if (key === "env") return primitive(v) || (plainObject(v) && allOwnData(v, primitive));
			if (key === "stdio") return primitive(v) || denseArray(v, primitive);
			return primitive(v);
		};
		// The marker command of a call (argv[, options] or { cmd, ... }), or "" when any input the original reads is not plain
		// data, or argv0 names no usable command.
		const commandOf = (args) => {
			const n = args.length;
			if (n < 1 || n > 2) return "";
			const first = args[0];
			let options = n === 2 ? args[1] : undefined;
			if (first === null || typeof first !== "object" || isProxy(first)) return "";
			let argv = first;
			if (!isArray(first)) {
				if (options !== undefined) return "";
				options = first;
				argv = own(first, "cmd");
			}
			if (!denseArray(argv, isString)) return "";
			if (options !== undefined && !(plainObject(options) && allOwnData(options, optionValue))) return "";
			const argv0 = own(argv, "0");
			if (typeof argv0 !== "string") return "";
			const command = apply(strSlice, apply(strSlice, argv0, [apply(strLastIndexOf, argv0, ["/"]) + 1]), [0, 16]);
			return command.length > 0 && apply(strIndexOf, command, ["\t"]) === -1 && apply(strIndexOf, command, ["\n"]) === -1 ? command : "";
		};
		// The fd holding this call's lock, or -1 when the call runs unpublished. Lock first (LOCK_EX|LOCK_NB: a held lock or the
		// observer's momentary shared lock means this call runs unpublished), then the content; a write that fails unpublishes.
		const publish = (args) => {
			if (off) return -1;
			let fd = -1;
			let locked = false;
			try {
				const command = commandOf(args);
				if (command === "") return -1;
				fd = openSync(path, FLAGS, 0o600);
				if (flock(fd, LOCK_EX | LOCK_NB) !== 0) throw 0;
				locked = true;
				ftruncateSync(fd, 0);
				writeSync(fd, nowMs() + "\t" + command + "\n", 0);
				return fd;
			} catch {}
			if (locked) release(fd);
			else if (fd >= 0) {
				try {
					closeSync(fd);
				} catch {}
			}
			return -1;
		};
		const release = (fd) => {
			let unlocked = false;
			try {
				unlocked = flock(fd, LOCK_UN) === 0;
			} catch {}
			// An unlock that failed: the close below drops the lock, and nothing is published again.
			if (!unlocked) off = true;
			try {
				closeSync(fd);
			} catch {}
		};
		const spawnSync = function spawnSync(...args) {
			// A nested call (only test code inside an outer call's arguments makes one, so the outer is unpublished) is not
			// published either.
			if (depth > 0) return apply(original, this, args);
			depth++;
			let fd = -1;
			try {
				fd = publish(args);
				return apply(original, this, args);
			} finally {
				depth--;
				if (fd >= 0) release(fd);
			}
		};
		spawnSync[MARK] = true;
		Bun.spawnSync = spawnSync;
	} catch {
		// No marker for this process: a missed detection, never a false one.
	}
}
`;

/** Remove a file or a tree (no link followed) when it is there. */
function removeIfPresent(path: string): void {
	try {
		removeTree(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
}

/** One detector line on stdout (CONTRACT.md): `<keyword> <ISO time> part <part> <rest>`, written synchronously. */
function stuckLine(stem: string, keyword: string, rest: string): void {
	try {
		writeSync(1, `${keyword} ${new Date().toISOString()} part ${stem} ${rest}\n`);
	} catch {
		// stdout gone: the runner reads the exit and stderr
	}
}

/** A signature's identity: worker and zombie (pid and start) and the marker's since. */
const sigKey = (s: Signature): string => `${s.worker.pid}:${s.worker.startUs}|${s.zombie.pid}:${s.zombie.startUs}|${s.since}`;

/** An enforce match: the signature, how long it held, and the observation it matched on. */
interface StopDecision {
	sig: Signature;
	spunMs: number;
	snap: Snapshot;
	owned: Seen[];
}

interface WatchPart {
	cfg: Config;
	runId: string;
	work: string;
	stem: string;
	logPath: string;
	mode: StuckMode;
	leader: number;
	markerDir: string;
}

/**
 * The detector of one part (D3): one observation per tick from the spawn until the part ends, the cap fires or a stop is
 * decided. Each signature's first tick, its clearing and its match are stdout lines. A shadow match starts the part's one
 * signature capture and the part runs on; an enforce match writes `stuck-stop`, stops classifying and resolves `stopped`.
 */
class StuckWatch {
	private readonly det: StuckDetector;
	private readonly uid = process.getuid!();
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Set at the part's end, the cap or a stop decision: no tick classifies after it. */
	private ended = false;
	/** Each holding signature's first tick. */
	private readonly firstAt = new Map<string, number>();
	private readonly decided = Promise.withResolvers<StopDecision>();
	/** Resolves on an enforce match only. */
	readonly stopped = this.decided.promise;
	/** An enforce match was decided: the cap is ignored from here on. */
	stopping = false;
	/** The shadow capture (started at the first would-stop), awaited before the part's files go. */
	private shadowCapture: Promise<void> | null = null;
	/** The pgids of owned processes this part already added to the groups file (groups sweep only). */
	private readonly recordedGroups = new Set<number>();

	constructor(private readonly p: WatchPart) {
		this.det = new StuckDetector({ tickMs: p.cfg.detectTickMs, persistMs: p.cfg.detectPersistMs, bunPath: p.cfg.bun, leaderPid: p.leader });
	}

	start(): void {
		this.timer = setInterval(() => this.tick(), this.p.cfg.detectTickMs);
	}

	/** No tick classifies after this (the part ended, the cap fired, or a stop was decided). */
	end(): void {
		this.ended = true;
		clearInterval(this.timer);
	}

	/** The part's end: stop ticking and let a running shadow capture finish (bounded by its own deadline). */
	async settle(): Promise<void> {
		this.end();
		await this.shadowCapture;
	}

	private line(keyword: string, rest: string): void {
		stuckLine(this.p.stem, keyword, rest);
	}

	private tick(): void {
		if (this.ended) return;
		const { cfg, mode } = this.p;
		try {
			const obs = observe({ uid: this.uid, markerDir: this.p.markerDir, candidatesOf: (s) => this.det.candidatesOf(s), argvOf: (s) => this.det.argvNeeded(s) });
			if (obs.snap.kind === "unavailable") {
				this.line("stuck-detector-off", `reason ${obs.snap.why}`);
				this.end();
				return;
			}
			const r = this.det.tick(obs);
			if (cfg.sweep === "groups") this.recordGroups(r.owned);
			if (cfg.detectTrace) this.trace(obs, r);
			const pair = (s: Signature) => `worker ${s.worker.pid} zombie ${s.zombie.pid}`;
			for (const c of r.cleared) {
				this.firstAt.delete(sigKey(c.sig));
				this.line("stuck-cleared", `${pair(c.sig)} held ${Math.round(c.heldMs)} matched ${c.matched ? "yes" : "no"}`);
			}
			for (const s of r.started) {
				this.firstAt.set(sigKey(s), obs.at);
				this.line("stuck-signature", `${pair(s)} since ${s.since} mode ${mode} bun ${Bun.version} ${Bun.revision}`);
			}
			for (const m of r.matched) {
				const spunMs = Math.round(obs.at - (this.firstAt.get(sigKey(m)) ?? obs.at));
				if (mode === "enforce") {
					this.line("stuck-stop", pair(m));
					this.stopping = true;
					this.end();
					this.decided.resolve({ sig: m, spunMs, snap: obs.snap, owned: r.owned });
					return;
				}
				this.line("stuck-would-stop", pair(m));
				// One signature capture per part; in shadow nothing is killed, so the capture's file closes as soon as it ends.
				this.shadowCapture ??= this.capture({ sig: m, spunMs, snap: obs.snap, owned: r.owned }).then((c) => c?.afterKill());
			}
		} catch (e) {
			this.line("stuck-detector-off", `reason detector failed: ${e instanceof Error ? e.message : errText(e)}`);
			this.end();
		}
	}

	/**
	 * A groups sweep signals only the groups in the run's groups file, and `--parallel` workers lead their own groups: killing
	 * the leader's group at the cap leaves them, and their children, alive under launchd, so they would escape the sweep. Each tick
	 * adds the pgid of every owned process it has not added yet. A uid sweep needs none of this and the file is left as it was.
	 */
	private recordGroups(owned: readonly Seen[]): void {
		const fresh = [...new Set(owned.map((p) => p.pgid))].filter((g) => g > 1 && g !== this.p.leader && !this.recordedGroups.has(g));
		if (fresh.length === 0) return;
		persistGroups(this.p.work, fresh);
		for (const g of fresh) this.recordedGroups.add(g);
	}

	/** `detectTrace` (tests): the tick's markers, candidates (with CPU), live part tree and its zombies, as one JSON line. */
	private trace(obs: Observation, r: TickResult): void {
		const tree = obs.snap.kind === "ok" ? liveOwned(obs.snap, r.owned) : [];
		const pids = new Set(tree.map((p) => p.pid));
		const zombies = obs.snap.kind === "ok" ? obs.snap.procs.filter((p) => p.zombie && pids.has(p.ppid)) : [];
		const row = {
			at: Math.round(obs.at),
			snap: obs.snap.kind === "ok" ? "ok" : `${obs.snap.kind}: ${obs.snap.why}`,
			markers: obs.markers.kind === "ok" ? obs.markers.active : { denied: obs.markers.why },
			candidates: [...obs.cpu].map(([pid, cpuNs]) => ({ pid, cpuNs })),
			tree: tree.map(({ pid, ppid, pgid, comm }) => ({ pid, ppid, pgid, comm })),
			zombies: zombies.map(({ pid, ppid, startUs, comm }) => ({ pid, ppid, startUs, comm })),
			signatures: r.signatures.map((s) => ({ worker: s.worker.pid, zombie: s.zombie.pid, since: s.since, command: s.command })),
		};
		appendFileSync(join(this.p.work, `${this.p.stem}.stuck-trace.jsonl`), `${JSON.stringify(row)}\n`);
	}

	/** The part's one signature capture (D3), bounded by signatureCaptureMs; `stuck-captured` once its file is written. */
	async capture(d: StopDecision): Promise<Capture | null> {
		const { cfg, runId, work, stem, logPath, markerDir } = this.p;
		const { sig } = d;
		const c = await boundedCapture(
			"signature capture",
			join(work, `${stem}.signature.log`),
			cfg.signatureCaptureMs,
			(started) =>
				`signature capture of ${stem}: worker ${sig.worker.pid} spun ${d.spunMs} ms in Bun.spawnSync (marker since ${sig.since}, command ${sig.command}) with unreaped child ${sig.zombie.pid}; mode ${this.p.mode}, ${new Date(started).toISOString()}, deadline ${cfg.signatureCaptureMs} ms\n`,
			(c) => signatureSections(cfg, runId, c, d, work, stem, logPath, markerDir),
		);
		if (c !== null) this.line("stuck-captured", `file ${stem}.signature.log ms ${Date.now() - c.started}`);
		return c;
	}
}

/**
 * The signature capture's sections: 1 the part tree from the match's snapshot (no ps), 2 the worker's marker, 3 `sample` of the
 * worker for 1 s and 4 `lsof` of it (both started together), 5 the log's last lines.
 */
async function signatureSections(cfg: Config, runId: string, c: Capture, d: StopDecision, work: string, stem: string, logPath: string, markerDir: string): Promise<void> {
	const w = d.sig.worker.pid;
	c.capDir = mkdtempSync(join(work, `${stem}.signature-`));
	let since = Date.now();
	let tree = `inspection: ${d.snap.kind}\n`;
	if (d.snap.kind === "ok") {
		const live = liveOwned(d.snap, d.owned);
		const pids = new Set(live.map((p) => p.pid));
		const rows = [...live, ...d.snap.procs.filter((p) => p.zombie && pids.has(p.ppid))].map((p) => {
			const role = p.pid === w ? "  <- worker" : p.pid === d.sig.zombie.pid ? "  <- unreaped child" : "";
			return `${p.pid} ${p.ppid} ${p.pgid} ${p.zombie ? "Z" : "-"} ${new Date(p.startUs / 1000).toISOString()} ${p.comm}${role}`;
		});
		tree = ["PID PPID PGID ZOMBIE START COMM", ...rows, ""].join("\n");
	}
	c.section("1. part tree from the detector's snapshot", since, tree);
	since = Date.now();
	const markerPath = join(markerDir, String(w));
	const marker = readRegular(markerPath, 64, "head");
	c.section(
		`2. marker ${markerPath}`,
		since,
		`observed: since ${d.sig.since} (${new Date(d.sig.since).toISOString()}) command ${d.sig.command}\nnow: ${"text" in marker ? JSON.stringify(marker.text) : `refused: ${marker.refused}`}\n`,
	);
	since = Date.now();
	const sampled = sampleOne(cfg, runId, c, w, 1, "signature-sample-read");
	const listed = c.tool(["/usr/sbin/lsof", "-nP", "-p", String(w)]);
	await hook(cfg, runId, "signature-capture", { stop: c.late });
	c.alive();
	const sample = await sampled;
	c.alive();
	c.section(`3. sample of worker ${w}`, since, sample);
	const lsof = await listed;
	c.alive();
	c.section(`4. lsof of worker ${w}`, since, toolBlock(lsof));
	c.clearCapDir();
	since = Date.now();
	c.section(`5. last ${LOG_TAIL_LINES} lines of ${logPath}`, since, logTail(logPath));
}

/** What the enforce teardown did: the groups it signalled, how long it took, and whether every owned process is gone. */
interface Teardown {
	pgids: number[];
	ms: number;
	/** null when contained; else the `stuck-killed` token (`<pid,pid>`, `inspection-denied` or `cleanup-failed`) and stderr reason. */
	unconfirmed: { token: string; why: string } | null;
}

/**
 * The enforce teardown (D3), after the signature capture. Owned = every identity the detector saw (leader and descendants) plus
 * every live descendant of one in a fresh snapshot (new during the capture included). The stop set is the pgids with a live
 * owned member, matched by pid and start; it joins the groups file. SIGTERM each, wait ≤ stopGraceMs for the owned processes to
 * go, SIGKILL each, then poll ≤ verifyMs until no owned identity is alive (a zombie is dead). A denied fresh snapshot signals
 * nothing from stale data. Persistence refusal never skips the kill; it and signal errors leave containment unconfirmed.
 */
async function teardown(cfg: Config, work: string, owned: Seen[]): Promise<Teardown> {
	const uid = process.getuid!();
	const t0 = Date.now();
	const fresh = snapshot(uid);
	if (fresh.kind !== "ok") return { pgids: [], ms: Date.now() - t0, unconfirmed: { token: "inspection-denied", why: `inspection denied (${fresh.why})` } };
	const live = liveOwned(fresh, owned);
	const self = fresh.procs.find((p) => p.pid === process.pid)?.pgid;
	const pgids = [...new Set(live.map((p) => p.pgid))].filter((g) => g > 1 && g !== self);
	const errors: string[] = [];
	try {
		if (pgids.length > 0) persistGroups(work, pgids);
	} catch (e) {
		errors.push(e instanceof Error ? e.message : String(e));
	}
	const tracked = [...owned, ...live];
	/** The owned processes still alive, or null when the snapshot is denied. */
	const left = (): Seen[] | null => {
		const s = snapshot(uid);
		return s.kind === "ok" ? liveOwned(s, tracked) : null;
	};
	const signal = (sig: NodeJS.Signals) => {
		for (const g of pgids) {
			try {
				process.kill(-g, sig);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ESRCH") errors.push(`kill(-${g}, ${sig}): ${errText(e)}`);
			}
		}
	};
	signal("SIGTERM");
	let now = left();
	for (const until = Date.now() + cfg.stopGraceMs; (now === null || now.length > 0) && Date.now() < until; now = left()) await Bun.sleep(50);
	if (now === null || now.length > 0) {
		signal("SIGKILL");
		now = left();
		for (const until = Date.now() + STUCK_DEFAULTS.verifyMs; (now === null || now.length > 0) && Date.now() < until; now = left()) await Bun.sleep(50);
	}
	const ms = Date.now() - t0;
	let token = "cleanup-failed";
	if (now === null) {
		token = "inspection-denied";
		errors.push("inspection denied after the kill");
	} else if (now.length > 0) {
		token = now.map((p) => p.pid).join(",");
		errors.push(`${token} still alive ${STUCK_DEFAULTS.verifyMs} ms after SIGKILL`);
	}
	for (const e of errors) process.stderr.write(`as2test: stuck stop: ${e}\n`);
	return { pgids, ms, unconfirmed: errors.length > 0 ? { token, why: errors.join("; ") } : null };
}

/**
 * Run `bun test …` in `<dir>/repo` with `<dir>`'s child env, in its own process group under the cap; the group is recorded in the
 * run's groups file for a `groups` sweep. At the cap, the stuck capture (D5) runs, bounded by its own deadline, before the kill.
 * The stuck-worker detector (PLAN wl-mvq8x4pkjmx69s D3) watches the part from its spawn to its end, the cap or a stop: the part
 * runs with the marker preload and `AS2TEST_STUCK_MARKERS`, both removed when the part ends. An enforce match is stopped here
 * (signature capture, teardown) and exits WRAPPER_EXIT.stuck; a cap that fires during a stop is ignored, and a stop never
 * starts after the cap.
 */
async function part(cfg: Config, runId: string, work: string, dir: string, argv: string[], logPath: string, cap: number, mode: StuckMode): Promise<number> {
	const stem = basename(logPath, ".log");
	// Admission is shared by ordinary/proof, full/fast/solo and runs before any test child exists.
	// A part freezes both the outer workers and the concurrent-case limit; subprocess peaks are
	// included in measured worker costs, not claimed to be OS-enforced by Bun's case scheduler.
	const { v: staged } = caps(areas(cfg), runId);
	const configuredWorkers = stem === "full" || stem === "fast" ? fullWorkers(areas(cfg), runId) : 1;
	let inputs: ResourceInputs | null = null;
	let costs: ResourceCosts | null = null;
	let admission: ResourceAdmission | null = null;
	let omp: InstalledOmp | null = null;
	let bun: { path: string; version: string; controls: string[] } | null = null;
	let executionArgv: string[] | null = null;
	let env: Record<string, string>;
	let bounded: string[];
	const resourcesPath = join(work, `${stem}.resources.json`);
	const receipt = (error?: string): void => {
		const fd = openSync(resourcesPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
		const errors: string[] = [];
		try {
			writeFileSync(fd, `${JSON.stringify({ version: 1, status: error ? "error" : "admitted", configuredWorkers,
				selectedWorkers: admission?.selectedWorkers ?? null, nestedConcurrency: 1, inputs, costs, bun, installedOmp: omp, executionArgv, ...(error ? { error } : {}) })}\n`);
		} catch (e) { errors.push(`write ${resourcesPath}: ${errText(e)}`); }
		try { closeSync(fd); } catch (e) { errors.push(`close ${resourcesPath}: ${errText(e)}`); }
		if (errors.length) throw new Error(errors.join("; "));
	};
	try {
		const proof = parseTimingProof(staged.timingProof);
		inputs = readResourceInputs();
		try {
			if (cfg.sweep !== "groups") verifyTrustedPath(cfg.resourcesPath);
			costs = parseResourceCosts(JSON.parse(readFileSync(cfg.resourcesPath, "utf8")));
		} catch (e) {
			throw new Error(`resource calibration ${cfg.resourcesPath}: ${errText(e)}; provision measured worker (including nested subprocess peaks) and host plus historic-load reserve costs via install/as2test-setup.sh --resources=<file>`);
		}
		admission = admitResources(configuredWorkers, inputs, costs);
		const controlEnv = proofChildEnv(process.env, dir, null, null);
		const checked = (args: string[]): string => {
			const r = spawnSync(cfg.bun, args, { env: controlEnv, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
			if (r.error || r.status !== 0) throw new Error(`${cfg.bun} ${args.join(" ")} failed: ${r.error?.message ?? `exit ${r.status} signal ${r.signal}`} ${r.stderr}`);
			return `${r.stdout}${r.stderr}`;
		};
		const help = checked(["test", "--help"]);
		if (!help.includes("--parallel=") || !help.includes("--max-concurrency=")) throw new Error(`${cfg.bun} test --help does not expose --parallel and --max-concurrency; install a supported pinned Bun`);
		// The receipt's controls are the flags boundedTestArgs adds (`--parallel` iff the configured ceiling is over 1), never a second spelling of them.
		bun = { path: cfg.bun, version: checked(["--version"]).trim(), controls: boundedTestArgs(["test"], configuredWorkers, admission.selectedWorkers).slice(1) };
		if (proof?.installedOmp) {
			if (cfg.sweep === "groups") throw new Error("installed OMP proofs require the actual _as2test uid wrapper; a groups/operator fixture is not admitted");
			const id = spawnSync("/usr/bin/id", ["-u", AS2TEST_USER], { encoding: "utf8", timeout: 10_000 });
			if (id.error || id.status !== 0 || !/^[1-9]\d*\s*$/.test(id.stdout) || Number(id.stdout.trim()) !== process.getuid?.()) throw new Error(`installed OMP proof must run as ${AS2TEST_USER}; id evidence: ${id.error?.message ?? id.stderr} ${id.stdout}`);
			omp = readInstalledOmp(cfg.ompRuntimePath);
			const versionEnv = proofChildEnv(process.env, dir, proof, omp);
			const version = spawnSync(join(omp.root, "bin", "omp"), ["--version"], { env: versionEnv, cwd: dir, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
			if (version.error || version.status !== 0 || version.stdout.trim() !== omp.version) throw new Error(`installed OMP ${omp.root}/bin/omp --version does not match ${omp.version}: ${version.error?.message ?? `exit ${version.status} signal ${version.signal}`} stdout=${version.stdout} stderr=${version.stderr}`);
		}
		env = proofChildEnv(process.env, dir, proof, omp);
		bounded = boundedTestArgs(argv, configuredWorkers, admission.selectedWorkers);
	} catch (e) {
		const error = `part ${runId}/${stem} admission failed: ${errText(e)}`;
		try { receipt(error); } catch (writeError) { return failed(`${error}; resource receipt ${resourcesPath} failed: ${errText(writeError)}`); }
		return failed(`${error}; evidence ${resourcesPath}`);
	}
	const markerDir = join(work, `stuck-markers-${stem}`);
	const preload = join(work, `stuck-preload-${stem}.js`);
	let off: string | null = process.platform === "darwin" ? null : `not darwin (${process.platform})`;
	if (off === null) {
		try {
			removeIfPresent(markerDir);
			removeIfPresent(preload);
			mkdirSync(markerDir, { mode: 0o700 });
			const fd = openSync(preload, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
			try {
				writeSync(fd, STUCK_PRELOAD);
			} finally {
				closeSync(fd);
			}
		} catch (e) {
			off = `setup failed: ${errText(e)}`;
		}
	}
	// The allowlisted, proof-only environment was admitted before detector setup.
	if (off === null) env.AS2TEST_STUCK_MARKERS = markerDir;
	const args = off === null ? [bounded[0]!, "--preload", preload, ...bounded.slice(1)] : bounded;
	executionArgv = [cfg.bun, ...args];
	try { receipt(); } catch (e) { return failed(`part ${runId}/${stem} resource receipt ${resourcesPath} failed: ${errText(e)}; no test child launched`); }
	process.stdout.write(`resource admission ${stem}: configured ${configuredWorkers}, selected ${admission!.selectedWorkers}, nested 1; ${resourcesPath}\n`);
	const log = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
	const child = spawn(cfg.bun, args, { cwd: join(dir, "repo"), env, stdio: ["ignore", log, log], detached: true });
	closeSync(log);
	const pgid = child.pid;
	if (pgid === undefined) return failed(`bun did not start`);
	appendFileSync(groupsFile(work), `${pgid}\n`);
	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
	const watch = off === null ? new StuckWatch({ cfg, runId, work, stem, logPath, mode, leader: pgid, markerDir }) : null;
	if (off !== null) stuckLine(stem, "stuck-detector-off", `reason ${off}`);
	watch?.start();
	try {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const capped = new Promise<"cap">((r) => {
			timer = setTimeout(() => {
				if (watch?.stopping) return;
				watch?.end();
				r("cap");
			}, cap);
		});
		const first = await Promise.race([done, capped, watch?.stopped ?? new Promise<never>(() => {})]);
		clearTimeout(timer);
		if (first === "cap") {
			const capture = await stuckCapture(cfg, runId, work, pgid, logPath, cap);
			const errors: string[] = [];
			try {
				await killGroup(cfg, pgid, work);
			} catch (e) {
				errors.push(e instanceof Error ? e.message : String(e));
			} finally {
				// Off the kill path: a cap dir the capture could not clear goes after the groups are killed.
				try {
					await capture?.afterKill();
				} catch (e) {
					errors.push(`stuck capture finalization failed: ${e instanceof Error ? e.message : String(e)}`);
				} finally {
					await done;
				}
			}
			const timeout = `timeout: the part passed its cap of ${cap} ms; its group was killed`;
			if (errors.length > 0) throw new Exit(WRAPPER_EXIT.failed, `${timeout}\n${errors.join("\n")}`);
			throw new Exit(WRAPPER_EXIT.timeout, timeout);
		}
		if ("sig" in first) {
			const capture = await watch!.capture(first);
			const t = await teardown(cfg, work, first.owned);
			stuckLine(stem, "stuck-killed", `pgids ${t.pgids.join(",") || "none"} ms ${t.ms} ${t.unconfirmed === null ? "contained" : `unconfirmed ${t.unconfirmed.token}`}`);
			await capture?.afterKill();
			// Never an unbounded wait: a leader that outlived the teardown must not hold this process open.
			child.unref();
			await Promise.race([done, Bun.sleep(1_000)]);
			const { sig } = first;
			throw new Exit(
				WRAPPER_EXIT.stuck,
				`stuck: worker ${sig.worker.pid} spun ${first.spunMs} ms in Bun.spawnSync with unreaped child ${sig.zombie.pid}; ${t.pgids.length} process groups killed, containment ${t.unconfirmed === null ? "contained" : `unconfirmed: ${t.unconfirmed.why}`}`,
			);
		}
		// Anything the part left behind in its group is the sweep's (§ 2.3 step 4): the runner sweeps after every part.
		if (first.code !== null) return first.code;
		return 128 + (first.signal ? (osConstants.signals[first.signal] ?? 0) : 0);
	} finally {
		await watch?.settle();
		if (off === null) {
			for (const path of [markerDir, preload]) {
				try {
					removeIfPresent(path);
				} catch (e) {
					process.stderr.write(`as2test: stuck detector: ${path} not removed: ${errText(e)}\n`);
				}
			}
		}
	}
}

async function full(cfg: Config, a: Areas, runId: string): Promise<number> {
	fence(a, runId);
	const work = workDir(a, runId);
	const cap = capMs(a, runId, "fullCapMin");
	const mode = stuckMode(a, runId);
	const xml = join(work, "full.xml");
	const log = join(work, "full.log");
	for (const stale of ["full.xml", "full.log", "full.stuck.log", "full.signature.log", "full.stuck-trace.jsonl"]) unlinkIfPresent(join(work, stale));
	return part(cfg, runId, work, work, ["test", "--reporter=junit", `--reporter-outfile=${xml}`], log, cap, mode);
}

/** A test operand's repo-relative path: `./<plain relative path>` naming a Bun test file, checked before anything is touched. */
function testRel(file: string): string {
	if (!file.startsWith("./")) refuse(`${file} must be ./<relative path>`);
	const rel = file.slice(2);
	if (rel === "" || rel.includes("\0") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) refuse(`${file} is not a plain relative path`);
	if (!isBunTestFile(rel)) refuse(`${file} is not a Bun test file name`);
	return rel;
}

/** `<dir>/repo`, the side's clone: its realpath, which must be the path itself (prepare first). */
function cloneOf(dir: string): string {
	const repo = join(dir, "repo");
	let realRepo: string;
	try {
		realRepo = realpathSync(repo);
	} catch {
		return refuse(`${repo} is missing (prepare first)`);
	}
	if (realRepo !== repo) refuse(`${repo} is not a plain directory`);
	return realRepo;
}

/** `file` (`./<rel>`) resolves, symlinks followed, to a regular file inside the clone `repo`. */
function inClone(repo: string, file: string, rel: string): void {
	const target = join(repo, rel);
	if (!inside(target, repo) || realpathSync(target) === repo) refuse(`${file} resolves outside the clone`);
	if (!lstatSync(realpathSync(target)).isFile()) refuse(`${file} is not a file`);
}

async function solo(cfg: Config, a: Areas, runId: string, file: string, side: Side): Promise<number> {
	const rel = testRel(file);
	fence(a, runId);
	const work = workDir(a, runId);
	const dir = sideDir(a, runId, side);
	inClone(cloneOf(dir), file, rel);
	const cap = capMs(a, runId, "soloCapMin");
	const mode = stuckMode(a, runId);
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
	for (const stale of [".xml", ".stuck.log", ".signature.log", ".stuck-trace.jsonl"]) unlinkIfPresent(join(work, `${stem}-${i}${stale}`));
	writeSync(1, `part ${stem}-${i}\n`);
	return part(cfg, runId, work, dir, ["test", "--reporter=junit", `--reporter-outfile=${xml}`, `./${rel}`], log, cap, mode);
}

/**
 * PLAN wl-mvq4edbaf13vnk D4, the Mac fallback of the hosted fast check: the fast set's files, each `./<path>` to a regular file
 * inside the PR clone and named once, in ONE `bun test` call to `fast.xml`/`fast.log` under caps.json `fastCapMin`. It runs as
 * `full` does (the child env, its own process group, `fullWorkers`, the stuck capture at the cap); every operand is checked
 * before the fence, and every file before bun starts, so a refusal runs nothing.
 */
async function fast(cfg: Config, a: Areas, runId: string, files: string[]): Promise<number> {
	if (files.length === 0) refuse("fast takes one or more ./<test file>");
	const rels = files.map(testRel);
	const twice = rels.find((r, i) => rels.indexOf(r) !== i);
	if (twice !== undefined) refuse(`./${twice} is named more than once`);
	fence(a, runId);
	const work = workDir(a, runId);
	const repo = cloneOf(work);
	rels.forEach((rel, i) => inClone(repo, files[i]!, rel));
	const cap = capMs(a, runId, "fastCapMin");
	const mode = stuckMode(a, runId);
	const xml = join(work, "fast.xml");
	const log = join(work, "fast.log");
	for (const stale of ["fast.xml", "fast.log", "fast.resources.json", "fast.stuck.log", "fast.signature.log", "fast.stuck-trace.jsonl"]) unlinkIfPresent(join(work, stale));
	const argv = ["test", "--reporter=junit", `--reporter-outfile=${xml}`, ...rels.map((r) => `./${r}`)];
	return part(cfg, runId, work, work, argv, log, cap, mode);
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

const ARITY: Record<string, number> = { prepare: 1, full: 0, solo: 1, "base-prepare": 1, "base-solo": 1, sweep: 0, cleanup: 1 };

async function main(argv: string[]): Promise<number> {
	process.umask(0o022);
	const cfg = config();
	const [sub, runId, ...ops] = argv;
	if (sub === undefined || runId === undefined) return refuse("usage: exec <subcommand> <run id> [operand...]");
	if (!RUN_ID_RE.test(runId)) return refuse("run id must match ^tr-[a-z0-9]+$");
	if (sub === "probe") {
		if (ops.length < 1) return refuse("probe takes <run id> and one or more paths");
	} else if (sub === "fast") {
		if (ops.length < 1) return refuse("fast takes <run id> and one or more ./<test file>");
	} else if (!Object.hasOwn(ARITY, sub)) return refuse(`unknown subcommand ${sub}`);
	else if (ops.length !== ARITY[sub]) return refuse(`${sub} takes exactly ${ARITY[sub]} operand(s) after the run id`);
	const a = areas(cfg);
	switch (sub) {
		case "prepare":
		case "base-prepare":
			prepare(cfg, a, runId, ops[0]!, sub === "prepare" ? "pr" : "base");
			return WRAPPER_EXIT.ok;
		case "full":
			return full(cfg, a, runId);
		case "solo":
		case "base-solo":
			return solo(cfg, a, runId, ops[0]!, sub === "solo" ? "pr" : "base");
		case "fast":
			return fast(cfg, a, runId, ops);
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
		// The stuck reason is one bare `stuck: …` line: the runner takes it as the part's error (test-run.ts stuckReason).
		process.stderr.write(e.code === WRAPPER_EXIT.stuck ? `${e.message}\n` : `as2test: ${e.message}\n`);
		process.exitCode = e.code;
	} else {
		process.stderr.write(`as2test: failed: ${(e as Error).stack ?? String(e)}\n`);
		process.exitCode = WRAPPER_EXIT.failed;
	}
}
