#!/usr/bin/env bun
// The outside-the-fence test runner (MIGRATION.md item 24; plan of wl-muraerdsgw7gn4, revision 12,
// § 2.2 to § 2.4). One Bun file with two subcommands; every decision it makes is surface/src/test-run.ts's.
//
//   start <wl> <pr> [--slice <id>] --requested-by <laneId>
//       the starter `lane_full_test` execs (30 s): the workload's repo is served, the PR is open, same
//       repo and on a branch the workload is bound to or a number Jo bound to it with `test-pr` or
//       `train` (`boundPrs`; every `gh` call names `-R`); on a merge train, a PR whose `Depends-on:` PR
//       is not merged or whose base is not main is refused (PLAN wl-mv8s8srodefytc § 1b); then one
//       ledger transaction refuses a PR while Jo's stop holds the merge train (`trainHold`, § 1 D4), settles dead runs, adds
//       the full-suite slice when none was named and writes `test-requested:`; then `run` is spawned
//       detached. Prints `test-run <run id> runner <pid> sha <head> slice <slice> log <path>`, plus
//       ` bound-by <instruction id>` when only Jo's binding admitted the PR, exit 0. A refusal is one
//       stderr line `test-runner start: <reason>` and exit 2; a failure the same, exit 3; usage exit 1.
//       The carried green (PLAN wl-mvpwkpqobyp20w D4): on a merge train, when the PR's last request across the train, its
//       head branch's workload and its fix workloads is green at S and the head is S or past it only by decision-log commits
//       (`ghCompare` before the transaction, the authority re-read in it), the transaction writes `test-requested:` and a green
//       `test-run:` at the head (reason `carried from <R> at <S> (decision-log only)`, R's counts) and settles the slice; no run
//       is spawned, `as2/full-suite` success is posted after the commit, and the line has `runner none`, `log none` and ends ` carried <R>`.
//   run <run id>
//       the detached run: heartbeat at once, the runs.db lock (queued while another run holds it; queued runs take it oldest
//       request first, by their `test-requested:` entry's time in runs.db's `queue` table, skipping dead waiters), `current` published
//       in the acquiring transaction, the install check (a drifted bundle is refreshed once through `sudo -n
//       <libexec>/refresh`), sweep, probe, retention, the trusted clone and bundle, then every untrusted step through
//       `sudo -n -u _as2test <exec> …`, a sweep after each part. After the full part the solo policy (`soloPlan`, PLAN
//       wl-mvq4edh02r5z40 D1) decides what runs alone: a full part that timed out (exit 124, or the outlive sweep fired on it)
//       ends the run there (runner.log `full part timed out: no solo or base parts`; its sweep and the head re-check still run,
//       and the verdict is error naming the timeout); an all-pass full part runs alone only the changed test files its junit ran
//       no test of; a full part with failing tests runs alone only its failing files, never a security test; any other full
//       error runs every changed test file alone but a failing security test. A rerun is diagnostic: it never turns a failure
//       green nor drops it. Then, when every part reported cleanly (`baseParts`, D3), each failing file rerun alone is run alone
//       on base too (`base-solo` in a clone at base's sha, cached per base sha and `./<file>` under <runs root>/base-cache; the
//       full suite never runs on base). After a call that timed out, the wrapper's stuck capture `<part>.stuck.log` is imported
//       into the run dir under the report checks; a missing or refused capture is one runner.log line and changes nothing. After
//       every part, whatever its outcome, the wrapper's cleanup report `<part>.cleanup.log` (survivors of the part's session, or a
//       failed lookup; PLAN wl-mvqu69tjvpy96o C9) is imported the same way, and the cleanup line on the wrapper's stderr joins the
//       part's error (a timed-out part stays a timeout); a sweep that is not ok names its stderr's survivor line in the run's error.
//       Host load (E1, announce-only): runner.log and result.json's `load` carry os.loadavg() and the core count at the start and
//       end of every part; a part over OVERLOAD_PER_CORE × the cores at either gets `<part>.load.log`, one `ps` snapshot of the
//       busiest processes (bounded, its failure written into the file), and a red or error run's reason and status name the
//       overload. Load never changes a verdict. Then the head re-check, one `test-run:` entry and the settle
//       in one ledger transaction; then, when the fetch confirmed the requested sha, the `as2/full-suite` commit status on
//       that sha for any PR (green and red-main success, red failure, error error; stale and superseded post none; PLAN
//       wl-mv8s8srodefytc rev 17.1 D2, D8), and the lock released. No `pending` is posted: a missing status already blocks a
//       protected merge. A failed status post is logged and never changes the verdict.
//
//       Parallel files (workload wl-mvg2kzuvwngdmo): the trusted phase writes the profile's `testRunner.fullWorkers` into
//       caps.json beside the caps, and the run logs `<ts> full workers <n>` right before the PR full part; test-exec runs that
//       part with `bun test --parallel=<n>` when n is over 1. Solo parts, on the PR and on base, run one file each.
//       surface/scripts/test-run-waits.ts reads the waits, the `full workers` lines and the results back per day.
//
// Stamps: everything is written as `test-runner` (TEST_RUNNER_BY).
//
// Test-only knobs (the fence's tests set them; Jo's environment never does, and none crosses the
// wrapper's `env -i`):
//   AGENT_SYSTEM_TEST_RUNS                  the runs root (plan § 2.3 step 1; also read by the lane)
//   AGENT_SYSTEM_TEST_RUNNER_CONFIG         a yml replacing <checkout>/profile/config.yml
//   AGENT_SYSTEM_TEST_RUNNER_ORIGIN         the URL cloned and ls-remoted instead of the repo's origin
//   AGENT_SYSTEM_TEST_RUNNER_ROOT           the as2test root instead of AS2TEST_ROOT
//   AGENT_SYSTEM_TEST_RUNNER_INSTALL        json {libexec, sudoers, ids: {root, wheel, jo}, account: {uid, gid}}: a test
//                                           install the preflight checks instead of the real one (`installSpec`)
//   AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS   the heartbeat period (default 15 s)
//   AGENT_SYSTEM_TEST_RUNNER_POLL_MS        the lock wait's poll (default 2 s)
//   AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS    shared post-sweep head/result/publication deadline (default 150 s)
//   AGENT_SYSTEM_TEST_RUNNER_OUTLIVE_MS     how long a part's wrapper may outlive its cap before the runner sweeps (default 60 s)
//   AGENT_SYSTEM_TEST_RUNNER_BUSY_MS        runs.db busy_timeout (default 5 s)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS    the refresh helper's cap (default REFRESH_CAP_S plus a minute, 15 min)
//   AGENT_SYSTEM_TEST_RUNNER_LOADAVG        `<1m> <5m> <15m> <cores>`: the host load every reading returns instead of os.loadavg()
//   AGENT_SYSTEM_TEST_RUNNER_PS_MS          the overload snapshot's `ps` cap (default 5 s)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS  its SIGTERM-to-SIGKILL grace (default 10 s)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS   how long it then waits for sudo to exit (default 30 s)
//   AGENT_SYSTEM_TEST_HOOKS                 a directory of pause/mark files at named boundaries (`hook`), and the
//                                           `<run id>.refresh-signal.refuse` file: the runner's signals to the refresh
//                                           helper's sudo are refused, as the kernel may refuse Jo's signal to a root sudo
import { spawn, spawnSync, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
	appendFileSync, chmodSync, closeSync, constants as FS, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync,
	rmSync, type Stats, writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertNotLiveLedgerUnderTest, defaultLedgerPath, type EntryRow, Ledger, TEST_RUNNER_BY, type WorkloadStatusRow } from "../../ledger/src/index";
import {
	AS2TEST_LIBEXEC, AS2TEST_SUDOERS, CHECKOUT_DRIFT, type DsclRead, type InstallFacts, installDecision, type InstallVerdict, type OwnerIds, preflightDecision,
	preflightProbes, probeCall, probeDecision, readInstall, REBUILT_FILES, REFRESH_CAP_S, REFRESH_EXIT, REFRESH_FAILED, type Verdict,
} from "../src/as2test";
import { repoOf } from "../src/decision-log";
import { boundPrs, holdersOf, worktreePath } from "../src/launch";
import { FULL_SUITE_STATUS, fixBindings, fixBinds, ghCompare, trainHold, trainPrs } from "../src/merge-train";
import { bodyDeps, DEFAULT_BRANCH } from "../src/merge-train-stack";
import {
	AS2TEST_ROOT, AS2TEST_USER, authoritativeRun, baseParts, boundBranches, buildTestRun, callTimedOut, carriedRun, changedTestFiles, cleanupReportOf, decideRun, decisionLogFault, executedFiles,
	fullSuiteSlice, HEARTBEAT_EVERY_MS, heartbeatText, KEEP_RUNS, LOAD_SNAPSHOT_ROWS, type LoadReading, loadOver, lockHolderStale, makeRunId, notifiesOrchestrator, OVERLOAD_PER_CORE, overloadNote,
	ownerRepoOf, ownsRequest, parseHeartbeat, parseTestRequested, type PartInput, type PartLoad, type PartResult, partResult, prAdmissible,
	type PrView, pruneRuns, queueAhead, queuedTooLong, type QueueRow, queueWaiterLive, reportCapBytes, reservation, type ResultRecord, resultJson, RUN_ID_RE, type RunFacts, runDirOf, runnerDiedRun, type RunRecord,
	runsDbOf, runsRoot, securityRedBody, securityRedOf, servedRepo, settleArtifact, stageDirOf, sweepFailureOf, type TestRequested, type TestRun, testRequestedBody, testRunBody, testRunFailedBody, testRunFailedOf,
	type TestVerdict, soloPlan, topByCpu, type TestRunnerConfig, testRunnerConfig, testRuns, workDirOf, WRAPPER_EXIT, type WrapperCall, wrapperArgv,
} from "../src/test-run";
import { ORCHESTRATOR_RECIPIENT } from "../src/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The starter's exit codes (S3 maps them): a refusal is the request's fault, a failure the machine's. */
export const START_EXIT = { ok: 0, usage: 1, refused: 2, failed: 3 } as const;
/** A sweep that ends by a signal is retried this many times while the lock row and `current` still name the run (§ 2.3 step 1). */
export const SWEEP_RETRIES = 3;
/** The wrapper outliving its own cap by this much makes the runner sweep (§ 2.3 step 3); AGENT_SYSTEM_TEST_RUNNER_OUTLIVE_MS in tests. */
const OUTLIVE_MS = 60_000;
/**
 * The runner's cap on the refresh helper (PLAN wl-mv718fxhwwcn40 § 1.3), a minute above the helper's own REFRESH_CAP_S;
 * the grace between its SIGTERM and SIGKILL; and how long it then waits for sudo to exit before it goes on. Jo's user
 * cannot signal root processes directly: the runner signals only its own sudo, which may refuse the signal or never pass
 * it on, so the helper's own cap and trap are what bound the root process tree. The runner's cap bounds only its wait.
 */
const REFRESH_TIMEOUT_MS = REFRESH_CAP_S * 1000 + 60_000;
const REFRESH_KILL_GRACE_MS = 10_000;
const REFRESH_REAP_MS = 30_000;

const msEnv = (name: string, fallback: number): number => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Where the preflight finds the install it checks, and the ids its owners must carry. */
export interface InstallSpec {
	libexec: string;
	sudoers: string;
	ids: OwnerIds;
	/** The account reader; undefined is the real `dscl`. */
	dscl?: DsclRead;
}

/** The real install (root-owned, Jo's uid), or the test install AGENT_SYSTEM_TEST_RUNNER_INSTALL describes; the wrapper is `<libexec>/exec` either way. */
export function installSpec(env: Record<string, string | undefined> = process.env): InstallSpec {
	const raw = env.AGENT_SYSTEM_TEST_RUNNER_INSTALL;
	if (!raw) return { libexec: AS2TEST_LIBEXEC, sudoers: AS2TEST_SUDOERS, ids: { root: 0, wheel: 0, jo: process.getuid!() } };
	const v = JSON.parse(raw) as { libexec?: unknown; sudoers?: unknown; ids?: Partial<OwnerIds>; account?: { uid?: unknown; gid?: unknown } };
	const nat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
	const { uid, gid } = v.account ?? {};
	if (typeof v.libexec !== "string" || typeof v.sudoers !== "string" || !v.ids || !nat(v.ids.root) || !nat(v.ids.wheel) || !nat(v.ids.jo) || !nat(uid) || !nat(gid)) {
		throw new Fail("AGENT_SYSTEM_TEST_RUNNER_INSTALL is not {libexec, sudoers, ids: {root, wheel, jo}, account: {uid, gid}}", START_EXIT.failed);
	}
	const dscl: DsclRead = (record, key) => {
		if (record === `/Users/${AS2TEST_USER}`) return key === "UniqueID" ? uid : key === "PrimaryGroupID" ? gid : null;
		return record === `/Groups/${AS2TEST_USER}` && key === "PrimaryGroupID" ? gid : null;
	};
	return { libexec: v.libexec, sudoers: v.sudoers, ids: { root: v.ids.root, wheel: v.ids.wheel, jo: v.ids.jo }, dscl };
}

class Fail extends Error {
	constructor(message: string, readonly code: number) {
		super(message);
	}
}
/** A run-level failure: the verdict is `error` with this reason. */
class Stop extends Error {}
/** The run lost its lock or its request: it writes `superseded` and settles nothing. */
class Superseded extends Error {}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The state a verdict posts on the sha the fetch confirmed; stale and superseded post none (no result for that sha), and nothing posts
 * `pending`. A red-main posts success (PLAN wl-mv8s8srodefytc rev 17.1 D8): the PR adds no failure to main's, and main's own red is a bug.
 */
const FULL_SUITE_STATE: Partial<Record<TestVerdict, "success" | "failure" | "error">> = { green: "success", "red-main": "success", red: "failure", error: "error" };

const isBusy = (e: unknown): boolean => e instanceof Error && "code" in e && typeof e.code === "string" && e.code.startsWith("SQLITE_BUSY");

function openLedger(): Ledger {
	try {
		return Ledger.open(defaultLedgerPath(process.env));
	} catch (e) {
		throw new Fail(`the ledger could not be opened: ${errText(e)}`, START_EXIT.failed);
	}
}

/** The profile's `testRunner:` block from the checkout this script runs from (§ 6 S8), or the test override. */
export function loadConfig(env: Record<string, string | undefined> = process.env): TestRunnerConfig {
	const path = env.AGENT_SYSTEM_TEST_RUNNER_CONFIG || join(REPO_ROOT, "profile", "config.yml");
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Fail(`the profile ${path} could not be read: ${errText(e)}`, START_EXIT.failed);
	}
	const c = testRunnerConfig(doc);
	if (!c.ok) throw new Fail(`the profile ${path}: ${c.error}`, START_EXIT.failed);
	return c.config;
}

/** `git -C <repo> config --get remote.origin.url`, or null. */
function originOf(repo: string): string | null {
	const r = spawnSync(["git", "-C", repo, "config", "--get", "remote.origin.url"], { stdout: "pipe", stderr: "pipe" });
	const out = r.stdout.toString().trim();
	return r.exitCode === 0 && out ? out : null;
}

/** The repo, its `owner/repo` and the URL the run clones (the origin, or the test override). */
function servedOf(ledger: Ledger, wl: string, config: TestRunnerConfig): { repo: string; ownerRepo: string; url: string } {
	const repo = repoOf(ledger, wl);
	if (!repo) throw new Fail(`${wl} has no repo: entry`, START_EXIT.refused);
	const origin = originOf(repo);
	if (!origin) throw new Fail(`${repo} has no origin remote`, START_EXIT.refused);
	const served = servedRepo(config, origin);
	if (!served) throw new Fail(`the test runner does not serve ${origin} (profile testRunner.repos)`, START_EXIT.refused);
	return { repo, ownerRepo: served.origin, url: process.env.AGENT_SYSTEM_TEST_RUNNER_ORIGIN || origin };
}

/** The heartbeat file's time for a run, or null when it has none or it does not parse. */
export function heartbeatOf(root: string, runId: string): number | null {
	try {
		return parseHeartbeat(readFileSync(join(runDirOf(root, runId), "heartbeat"), "utf8"), runId);
	} catch {
		return null;
	}
}

/**
 * The host load now (E1, PLAN wl-mvqu69tjvpy96o): os.loadavg() and the core count, read in process with no spawn, each average
 * to two decimals; or the test knob AGENT_SYSTEM_TEST_RUNNER_LOADAVG (`<1m> <5m> <15m> <cores>`), which throws when malformed.
 */
export function hostLoad(env: Record<string, string | undefined> = process.env, now: number = Date.now()): LoadReading {
	const knob = env.AGENT_SYSTEM_TEST_RUNNER_LOADAVG;
	let avg: number[];
	let cores: number;
	if (knob !== undefined) {
		const n = knob.trim().split(/\s+/).map(Number);
		if (n.length !== 4 || n.some((x) => !Number.isFinite(x) || x < 0) || !Number.isSafeInteger(n[3]) || n[3]! < 1) {
			throw new Error(`AGENT_SYSTEM_TEST_RUNNER_LOADAVG must be "<1m> <5m> <15m> <cores>" (three loads, a whole core count over 0), not ${JSON.stringify(knob)}`);
		}
		avg = n.slice(0, 3);
		cores = n[3]!;
	} else {
		avg = loadavg();
		cores = availableParallelism();
	}
	const [load1, load5, load15] = avg.map((x) => Math.round(x * 100) / 100) as [number, number, number];
	return { at: new Date(now).toISOString(), load1, load5, load15, cores };
}

// ---- test hooks ---------------------------------------------------------------------------------

/**
 * A named boundary. With AGENT_SYSTEM_TEST_HOOKS set, every pass appends a line to
 * `<dir>/<id>.<point>.marks` (`id` is the run id; the starter's carry, which has no run, names its workload);
 * when `<dir>/<id>.<point>.pause` exists, it writes `.reached` and waits for `.go`, then removes all three
 * (one pause per arming). Unset, it is inert.
 */
function hookMark(id: string, point: string, info: Record<string, unknown> = {}): { base: string } | null {
	const dir = process.env.AGENT_SYSTEM_TEST_HOOKS;
	if (!dir) return null;
	const base = join(dir, `${id}.${point}`);
	appendFileSync(`${base}.marks`, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...info })}\n`);
	return { base };
}
function hookResume(base: string): void {
	for (const s of [".pause", ".go", ".reached"]) rmSync(base + s, { force: true });
}
/** The synchronous form, for a boundary inside an open SQLite transaction. */
function hookSync(id: string, point: string, info: Record<string, unknown> = {}): void {
	const h = hookMark(id, point, info);
	if (!h || !existsSync(`${h.base}.pause`)) return;
	writeFileSync(`${h.base}.reached`, JSON.stringify({ pid: process.pid, at: Date.now(), ...info }));
	while (!existsSync(`${h.base}.go`)) Bun.sleepSync(25);
	hookResume(h.base);
}
async function hook(runId: string, point: string, info: Record<string, unknown> = {}, deadline = Infinity): Promise<void> {
	const h = hookMark(runId, point, info);
	if (!h || !existsSync(`${h.base}.pause`)) return;
	writeFileSync(`${h.base}.reached`, JSON.stringify({ pid: process.pid, at: Date.now(), ...info }));
	while (!existsSync(`${h.base}.go`)) {
		if (Date.now() >= deadline) throw new Stop(`post-sweep deadline exceeded at ${point}`);
		await Bun.sleep(25);
	}
	hookResume(h.base);
}

// ---- the runs lock (§ 2.3 step 1) ------------------------------------------------------------------

export interface LockRow {
	runId: string;
	pid: number;
	pgid: number;
	runDir: string;
	heartbeatAt: number;
}

/**
 * `<root>/runs.db` with its one-row lock table and the `queue` table of the runs waiting for it (each waiter's request
 * `created_at` in ms, `requestedAt`: the order they take the lock in); busy_timeout first.
 */
export function openLockDb(root: string, busyMs: number = msEnv("AGENT_SYSTEM_TEST_RUNNER_BUSY_MS", 5_000)): Database {
	// Under test, a runs root or a runs.db (a symlink included) inside a live ledger root is refused before anything is created there.
	assertNotLiveLedgerUnderTest(root);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	assertNotLiveLedgerUnderTest(runsDbOf(root));
	const db = new Database(runsDbOf(root), { create: true, strict: true });
	db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyMs)}`);
	busyLoop(() => db.exec(
		"CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), runId TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, runDir TEXT NOT NULL, heartbeatAt INTEGER NOT NULL)",
	));
	busyLoop(() => db.exec("CREATE TABLE IF NOT EXISTS queue (runId TEXT PRIMARY KEY, workloadId TEXT NOT NULL, requestedAt INTEGER NOT NULL)"));
	return db;
}

export const lockRow = (db: Database): LockRow | null => db.query<LockRow, []>("SELECT runId, pid, pgid, runDir, heartbeatAt FROM lock WHERE id = 1").get();

/** Retry `fn` on SQLITE_BUSY (each attempt already waited busy_timeout). */
function busyLoop<T>(fn: () => T, attempts = 12): T {
	for (let i = 0; ; i++) {
		try {
			return fn();
		} catch (e) {
			if (!isBusy(e) || i + 1 >= attempts) throw e;
			Bun.sleepSync(50);
		}
	}
}

/** `<stage>/current` := `<run id>\n`, by an atomic rename of a 0640 temp file. Call only inside a runs.db transaction that holds the row for `runId`. */
function writeCurrent(stageRoot: string, runId: string): void {
	const tmp = join(stageRoot, `.current.${runId}.${process.pid}`);
	writeFileSync(tmp, `${runId}\n`, { mode: 0o640 });
	chmodSync(tmp, 0o640);
	renameSync(tmp, join(stageRoot, "current"));
}

/**
 * The guarded publication (§ 2.3 step 1, "Publishing `current`, linearized"): in one BEGIN IMMEDIATE
 * transaction, publish only when the lock row holds `runId`. A displaced runner publishes nothing,
 * and SQLite orders this after any takeover's own publication. Returns whether it published.
 */
export function publishIfOwner(db: Database, stageRoot: string, runId: string): boolean {
	return busyLoop(() => db.transaction(() => {
		if (lockRow(db)?.runId !== runId) return false;
		writeCurrent(stageRoot, runId);
		return true;
	}).immediate());
}

// ---- the report import (§ 2.2 step 4) -------------------------------------------------------------

/**
 * Copy `<work dir>/<name>` into `<run dir>/<name>` and return its text: opened O_NOFOLLOW|O_NONBLOCK
 * (a symlink fails; a FIFO cannot block), a regular file by fstat on that descriptor, read up to
 * `capBytes`. A missing file is `{ text: null, error: null }`; every refusal names its reason.
 */
export function importReport(workDir: string, runDir: string, name: string, capBytes: number): { text: string | null; error: string | null } {
	let st: Stats;
	try {
		st = lstatSync(workDir);
	} catch {
		return { text: null, error: null };
	}
	if (!st.isDirectory()) return { text: null, error: `${workDir} is not a directory` };
	let fd: number;
	try {
		fd = openSync(join(workDir, name), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
	} catch (e) {
		const code = e instanceof Error && "code" in e ? String(e.code) : "";
		if (code === "ENOENT") return { text: null, error: null };
		if (code === "ELOOP") return { text: null, error: `${name} is a symlink` };
		return { text: null, error: `${name} is unreadable (${code || errText(e)})` };
	}
	try {
		const fs = fstatSync(fd);
		if (!fs.isFile()) return { text: null, error: `${name} is not a regular file` };
		if (fs.size > capBytes) return { text: null, error: `${name} is over the ${capBytes}-byte report cap` };
		const buf = Buffer.alloc(capBytes + 1);
		let n = 0;
		for (;;) {
			const k = readSync(fd, buf, n, buf.length - n, null);
			if (k <= 0) break;
			n += k;
			if (n > capBytes) return { text: null, error: `${name} is over the ${capBytes}-byte report cap` };
		}
		const data = buf.subarray(0, n);
		writeFileSync(join(runDir, name), data, { mode: 0o600 });
		return { text: data.toString("utf8"), error: null };
	} catch (e) {
		return { text: null, error: `${name} is unreadable (${errText(e)})` };
	} finally {
		closeSync(fd);
	}
}

/** One part's junit and log, imported under the same checks; the first refusal makes the part `error`. */
export function importPart(workDir: string, runDir: string, part: string, capBytes: number): Pick<PartInput, "junit" | "log" | "importError"> {
	const junit = importReport(workDir, runDir, `${part}.xml`, capBytes);
	const log = importReport(workDir, runDir, `${part}.log`, capBytes);
	return { junit: junit.text, log: log.text, importError: junit.error ?? log.error };
}

/** `<runs root>/base-cache/<base sha>/<part, URI-encoded>.json`: base's result of one part (D8), written by Jo's runner only. */
function baseCachePath(root: string, sha: string, part: string): string {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${sha} is not a full sha`);
	return join(root, "base-cache", sha, `${encodeURIComponent(part)}.json`);
}

/** A cached base result (D8), or null when none is cached or the file is not a clean result (a cached error never counts). */
export function readBaseCache(root: string, sha: string, part: string): PartResult | null {
	let v: unknown;
	try {
		v = JSON.parse(readFileSync(baseCachePath(root, sha, part), "utf8"));
	} catch {
		return null;
	}
	if (v === null || typeof v !== "object") return null;
	const p = v as Record<string, unknown>;
	const counts = ["pass", "fail", "skip", "ms"].every((k) => {
		const n = p[k];
		return typeof n === "number" && Number.isInteger(n) && n >= 0;
	});
	const failures = Array.isArray(p.failures)
		&& p.failures.every((f: unknown) => f !== null && typeof f === "object" && "name" in f && typeof f.name === "string" && "firstError" in f && typeof f.firstError === "string");
	if (!counts || !failures || p.error !== null || !(p.exit === null || Number.isInteger(p.exit))) return null;
	// Every field PartResult names was checked above.
	const result = v as PartResult;
	return result;
}

/** Cache base's clean result of one part (D8): written to a temp name and renamed, so a reader sees the whole file or none. */
export function writeBaseCache(root: string, sha: string, part: string, result: PartResult): void {
	const path = baseCachePath(root, sha, part);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(result)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

// ---- start ------------------------------------------------------------------------------------------

/** gh's JSON for `args` (gh found on PATH with this process's env); a gh failure or an answer that is no JSON fails the start, named `what`. */
function ghJson(args: string[], what = `gh ${args.join(" ")}`): unknown {
	const r = spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
	if (r.exitCode !== 0) {
		const why = r.exitedDueToTimeout ? "timed out" : r.stderr.toString().trim().split("\n").at(-1) || `exit ${r.exitCode}`;
		throw new Fail(`${what} failed: ${why}`, START_EXIT.failed);
	}
	try {
		return JSON.parse(r.stdout.toString());
	} catch {
		throw new Fail(`${what} did not return json`, START_EXIT.failed);
	}
}

/** `gh pr view <pr> -R <owner/repo> --json <fields>`'s object. */
function ghPrJson(ownerRepo: string, pr: number, fields: string): Record<string, unknown> {
	return ghJson(["pr", "view", String(pr), "-R", ownerRepo, "--json", fields], `gh pr view ${pr} -R ${ownerRepo}`) as Record<string, unknown>;
}

function ghPrView(ownerRepo: string, pr: number): PrView & { body: string } {
	const v = ghPrJson(ownerRepo, pr, "number,state,headRefOid,headRefName,baseRefName,isCrossRepository,body");
	if (typeof v.number !== "number" || typeof v.state !== "string" || typeof v.headRefOid !== "string" || typeof v.headRefName !== "string" ||
		typeof v.baseRefName !== "string" || typeof v.isCrossRepository !== "boolean" || (v.body !== undefined && typeof v.body !== "string")) {
		throw new Fail(`gh pr view ${pr} -R ${ownerRepo} returned an unexpected shape`, START_EXIT.failed);
	}
	if (v.number !== pr) throw new Fail(`gh pr view ${pr} answered for PR #${v.number}`, START_EXIT.failed);
	// gh answers `body: ""` for an empty body; an answer without the field reads as one.
	return { ...(v as unknown as PrView), body: (v.body as string | undefined) ?? "" };
}

/**
 * Why a merge-train PR may not run yet (PLAN wl-mv8s8srodefytc § 1b, dependencies land first), or null: a
 * `Depends-on:` PR in its body that is not MERGED (one `gh pr view <A> --json state` each, in body order), or a
 * base branch other than DEFAULT_BRANCH (a stack not yet retargeted). Reads no ledger row.
 */
function stackRefusal(ownerRepo: string, view: PrView & { body: string }): string | null {
	for (const dep of bodyDeps(view.body)) {
		if (dep === view.number) continue;
		const state = ghPrJson(ownerRepo, dep, "state").state;
		if (typeof state !== "string") throw new Fail(`gh pr view ${dep} -R ${ownerRepo} returned an unexpected shape`, START_EXIT.failed);
		if (state !== "MERGED") return `#${view.number} depends on #${dep} (${state}): land #${dep} first`;
	}
	if (view.baseRefName !== DEFAULT_BRANCH) return `#${view.number} targets ${view.baseRefName}; retarget it to ${DEFAULT_BRANCH} once its dependency has landed`;
	return null;
}

/** After a reservation, a run that cannot proceed (no runner spawned, no profile to run under) gets its `error` result, while it still owns its request. */
function recordError(ledger: Ledger, wl: string, request: TestRequested, runDir: string, reason: string): void {
	ledger.write(() => {
		if (!ownsRequest(testRuns(ledger.entries(wl)), request.runId)) return;
		const run: TestRun = { ...runnerDiedRun(request, runDir), reason };
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: request.slice, kind: "assumption", body: testRunBody(run) });
	});
}

/**
 * The `as2/full-suite` commit status (FULL_SUITE_STATUS) on exactly `sha` in the served repo `ownerRepo`, for any PR (PLAN wl-mv8s8srodefytc
 * rev 17.1 D2: branch protection on main requires it): `gh api -X POST repos/<owner/repo>/statuses/<sha>`, gh found on PATH with this
 * process's env, as the starter's `gh pr view` is; posted by a run on its verdict and by the starter on a carried green. A failed post is
 * logged through `log` and never changes the verdict; it never throws, and gh is killed after 15 s.
 */
async function postFullSuite(ownerRepo: string, state: "success" | "failure" | "error", sha: string, description: string, log: (s: string) => void): Promise<void> {
	const what = `status ${FULL_SUITE_STATUS} ${state} on ${sha}`;
	if (!ownerRepo) {
		log(`${what} not posted: the run has no served repo`);
		return;
	}
	const argv = ["gh", "api", "-X", "POST", `repos/${ownerRepo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${FULL_SUITE_STATUS}`, "-f", `description=${description}`];
	try {
		const p = spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
		const err = await new Response(p.stderr).text();
		await p.exited;
		clearTimeout(timer);
		log(p.exitCode === 0 ? `${what} posted` : `${what} not posted: ${err.trim().split("\n").at(-1) || (p.signalCode ?? `exit ${p.exitCode}`)}`);
	} catch (e) {
		log(`${what} not posted: ${errText(e)}`);
	}
}

// ---- the carried green (PLAN wl-mvpwkpqobyp20w D4) ------------------------------------------------------

/**
 * D4a's sources for PR `pr` on merge train `train`: the train; the workload a `wl/<W>` head branch names; and every workload, open or
 * closed, whose `train-fix:` is for this repo and binds the PR on the train (`fixBinds`). W and each fix count only when their `repo:`
 * checkout's origin is the served `ownerRepo`; `origins` keeps each checkout's origin once read, so a re-read in a transaction runs git
 * only for a checkout it has not seen.
 */
function carrySources(ledger: Ledger, train: string, pr: number, headRefName: string, ownerRepo: string, origins: Map<string, string | null>): string[] {
	const want = ownerRepo.toLowerCase();
	const served = (id: string): boolean => {
		const repo = repoOf(ledger, id);
		if (repo === null) return false;
		if (!origins.has(repo)) origins.set(repo, originOf(repo));
		const origin = origins.get(repo);
		return origin != null && ownerRepoOf(origin)?.toLowerCase() === want;
	};
	const out = [train];
	const owner = headRefName.startsWith("wl/") ? headRefName.slice(3) : null;
	if (owner !== null && owner !== train && ledger.workload(owner) !== null && served(owner)) out.push(owner);
	for (const f of fixBindings(ledger, { closed: true })) {
		if (!out.includes(f.workloadId) && f.repo.toLowerCase() === want && fixBinds(ledger, f, train, pr) && served(f.workloadId)) out.push(f.workloadId);
	}
	return out;
}

/**
 * D4a's authority: the last `test-requested:` for PR `pr` across `sources` in ledger order, created_at then rowid (one query: the
 * order `ledger.entries` and `authoritativeRun` read within one workload, so equal stamps across workloads resolve by insertion), and
 * that request's own result, read from its own workload's records. Null unless that result is a green: a newer red, error, stale or
 * superseded request, or one still pending, carries nothing, whatever older greens exist.
 */
function carryAuthority(ledger: Ledger, sources: readonly string[], pr: number): ResultRecord | null {
	const rows = ledger.db.query<EntryRow, string[]>(`SELECT * FROM entries WHERE workload_id IN (${sources.map(() => "?").join(", ")}) ORDER BY created_at, rowid`).all(...sources);
	const last = authoritativeRun(testRuns(rows), pr);
	const on = last === null ? undefined : rows.find((e) => e.id === last.request.entryId)?.workload_id;
	const own = on === undefined ? null : (testRuns(ledger.entries(on)).find((r) => r.request.runId === last!.request.runId)?.result ?? null);
	return own?.verdict === "green" ? own : null;
}

/**
 * D4b, before any transaction (no gh call holds the ledger's lock): the authority's green at S when the PR's head `head` is S
 * (`identical`, no gh call) or passes `decisionLogFault` on GitHub's compare of the two (`ghCompare`); else null, and the request
 * runs as any other. A compare GitHub cannot answer completely, or a gh call that fails, carries nothing.
 */
function carryCandidate(ledger: Ledger, sources: readonly string[], pr: number, head: string, ownerRepo: string): ResultRecord | null {
	const from = carryAuthority(ledger, sources, pr);
	if (from === null) return null;
	try {
		const c = ghCompare(ownerRepo, from.sha, head, ghJson);
		return decisionLogFault(c.ok ? c.compare : null) === null ? from : null;
	} catch {
		return null;
	}
}

async function cmdStart(wl: string, pr: number, sliceArg: string | null, by: string): Promise<number> {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w || w.status !== "open") throw new Fail(`no open workload ${wl}`, START_EXIT.refused);
	const config = loadConfig();
	const { ownerRepo } = servedOf(ledger, wl, config);
	const view = ghPrView(ownerRepo, pr);
	const entries = ledger.entries(wl);
	const instructions = ledger.instructions(wl);
	const bound = boundBranches(wl, entries, holdersOf(entries, w.holder, ledger.holders(wl)));
	// A train member is bound by Jo's `train:` or the tick's `train-board:` (PLAN wl-mvbjiettjrfpxc D2); a fix workload's
	// `train-fix:` binds its PR through that membership entry on the train (PLAN wl-mv8s8srodefytc rev 17.1 D8).
	const bindings = boundPrs(entries, instructions, ledger);
	const admissible = prAdmissible(view, bound, bindings.map((b) => b.pr));
	if (!admissible.ok) throw new Fail(admissible.reason, START_EXIT.refused);
	// A merge train lands dependencies first (§ 1b): checked on gh before the reservation; off a train nothing changes.
	const stacked = trainPrs(entries, instructions).length > 0 ? stackRefusal(ownerRepo, view) : null;
	if (stacked !== null) throw new Fail(stacked, START_EXIT.refused);
	// Admitted only through a binding: the starter's line names it (Jo's instruction, or the train's board entry), so every such run is traceable to it.
	const boundBy = bound.includes(view.headRefName) ? null : (bindings.find((b) => b.pr === view.number)?.by ?? null);
	// D4b: on a merge train, the green this request may carry to the head this start read (evidence for R, S and that head).
	const origins = new Map<string, string | null>();
	const candidate = trainPrs(entries, instructions).includes(pr)
		? carryCandidate(ledger, carrySources(ledger, wl, pr, view.headRefName, ownerRepo, origins), pr, view.headRefOid, ownerRepo)
		: null;
	if (candidate !== null) hookSync(wl, "carry-evidence");

	const root = runsRoot(process.env);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const runId = makeRunId(Date.now(), Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""));
	const runDir = runDirOf(root, runId);
	const { slice, carried } = ledger.write(() => {
		if (candidate !== null) hookSync(wl, "carry-open");
		const now = Date.parse(ledger.now());
		const res = reservation(testRuns(ledger.entries(wl)), (id) => heartbeatOf(root, id), now);
		if (!res.ok) {
			const live = res.live.request;
			throw new Fail(`run ${live.runId} (PR #${live.pr}, slice ${live.slice}) is live on ${wl}; its test-run: settles it`, START_EXIT.refused);
		}
		// The merge train's stop hold (PLAN wl-mv8s8srodefytc § 1 D4), on the rows this transaction reads, so a stop answered since admission still holds.
		const held = trainHold({ entries: ledger.entries(wl), instructions: ledger.instructions(wl), questions: ledger.questions(wl) });
		if (held !== null) throw new Fail(held, START_EXIT.refused);
		let sl: string;
		if (sliceArg !== null) {
			const s = ledger.slice(sliceArg);
			if (!s || s.workload_id !== wl) throw new Fail(`no slice ${sliceArg} on ${wl}`, START_EXIT.refused);
			if (s.state !== "open") throw new Fail(`slice ${sliceArg} is ${s.state}, not open`, START_EXIT.refused);
			sl = s.id;
		} else {
			const f = fullSuiteSlice(wl, pr, ledger.slices(wl).map((s) => s.id));
			sl = ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: wl, id: f.id, task: f.task, doneCondition: f.doneCondition, inputs: `PR #${pr} at ${view.headRefOid}` });
		}
		for (const d of res.settleDead) {
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: d.request.slice, kind: "assumption", body: testRunBody(runnerDiedRun(d.request, runDirOf(root, d.request.runId))) });
		}
		// D4c: the carry commits only on the authority D4b compared (same R, same S, the head this start read), re-read from this
		// transaction's rows before this request joins them; any other falls through to the run. No gh call here: Ledger.write may run this again.
		const from = candidate === null ? null : carryAuthority(ledger, carrySources(ledger, wl, pr, view.headRefName, ownerRepo, origins), pr);
		const carry = from !== null && from.runId === candidate!.runId && from.sha === candidate!.sha ? from : null;
		const request: TestRequested = { runId, pr, sha: view.headRefOid, slice: sl, by };
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody(request) });
		if (carry === null) return { slice: sl, carried: null };
		const run = carriedRun(request, carry);
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRunBody(run) });
		ledger.completeSlice(sl, { by: TEST_RUNNER_BY, artifact: settleArtifact(run) });
		hookSync(wl, "carry-written");
		return { slice: sl, carried: carry };
	});

	if (carried !== null) {
		// D4d, after the commit: the status the run would post, outside any transaction; a failed post is logged and the green stands.
		await postFullSuite(ownerRepo, "success", view.headRefOid, `carried from run ${carried.runId} at ${carried.sha.slice(0, 7)} (decision-log only)`, (s) => process.stderr.write(`test-runner start: ${s}\n`));
		process.stdout.write(`test-run ${runId} runner none sha ${view.headRefOid} slice ${slice} log none${boundBy ? ` bound-by ${boundBy}` : ""} carried ${carried.runId}\n`);
		return START_EXIT.ok;
	}

	const log = join(runDir, "runner.log");
	try {
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		const fd = openSync(log, "a", 0o600);
		const child = spawn([process.execPath, import.meta.path, "run", runId], {
			cwd: runDir, env: process.env, stdin: "ignore", stdout: fd, stderr: fd, detached: true,
		});
		child.unref();
		closeSync(fd);
		writeFileSync(join(runDir, "runner.json"), `${JSON.stringify({ pid: child.pid, pgid: child.pid, runId })}\n`, { mode: 0o600 });
		process.stdout.write(`test-run ${runId} runner ${child.pid} sha ${view.headRefOid} slice ${slice} log ${log}${boundBy ? ` bound-by ${boundBy}` : ""}\n`);
		return START_EXIT.ok;
	} catch (e) {
		const reason = `the runner did not start: ${errText(e)}`;
		try {
			recordError(ledger, wl, { runId, pr, sha: view.headRefOid, slice, by }, runDir, reason);
		} catch (e2) {
			process.stderr.write(`test-runner start: the failure could not be recorded: ${errText(e2)}\n`);
		}
		throw new Fail(reason, START_EXIT.failed);
	}
}

// ---- run --------------------------------------------------------------------------------------------

/** The `test-requested:` the runner wrote for `runId`, and its workload. */
function findRequest(ledger: Ledger, runId: string): { workloadId: string; request: TestRequested } | null {
	const rows = ledger.db.query<{ workload_id: string; body: string }, [string, string]>(
		"SELECT workload_id, body FROM entries WHERE kind = 'assumption' AND created_by = ? AND body LIKE ? ORDER BY created_at, rowid",
	).all(TEST_RUNNER_BY, `test-requested: ${runId} %`);
	for (const r of rows) {
		const req = parseTestRequested(r.body);
		if (req && req.runId === runId) return { workloadId: r.workload_id, request: req };
	}
	return null;
}

/** git for the trusted phase: no system config, an empty global config, no inherited GIT_* variable, no prompt. */
function trustedEnv(gitconfig: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
	return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitconfig, GIT_TERMINAL_PROMPT: "0" };
}
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
/** The network commands' extra settings (§ 2.3 step 2): no template, and only the keychain helper. */
const NETWORK = [...NO_HOOKS, "-c", "init.templateDir=", "-c", "credential.helper=", "-c", "credential.helper=osxkeychain"];

/**
 * File-backed output cannot wait for EOF held by a grandchild. Poll the exit status with a
 * deadline as well: signalling a process does not bound an unresolved stream/exited promise.
 * Each caller owns its private output directory; no output is trimmed except stderr. With `echoStderr`, the stderr file is
 * also copied onto this process's stderr (runner.log) as it grows, on every poll and once more at the end, so a caller both
 * reads the command's stderr and logs it live.
 */
export async function run(cmd: string[], o: {
	cwd: string; env: Record<string, string | undefined>; timeoutMs: number; echoStderr?: boolean;
	onSpawn?: (pid: number) => void;
}): Promise<{ code: number | null; signal: string | null; out: string; err: string }> {
	const dir = mkdtempSync(join(tmpdir(), "as2-runner-command-"));
	const outPath = join(dir, "stdout");
	const errPath = join(dir, "stderr");
	const outFd = openSync(outPath, "w", 0o600);
	const errFd = openSync(errPath, "w", 0o600);
	let p: Subprocess | undefined;
	let echoFd: number | null = null;
	let echoed = 0;
	const echo = (): void => {
		if (echoFd === null) return;
		const buf = Buffer.alloc(64 * 1024);
		for (let k = readSync(echoFd, buf, 0, buf.length, echoed); k > 0; k = readSync(echoFd, buf, 0, buf.length, echoed)) {
			process.stderr.write(buf.subarray(0, k));
			echoed += k;
		}
	};
	try {
		try {
			if (o.echoStderr) echoFd = openSync(errPath, "r");
			p = spawn(cmd, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: outFd, stderr: errFd });
		} finally {
			closeSync(outFd);
			closeSync(errFd);
		}
		o.onSpawn?.(p.pid);
		const deadline = Date.now() + o.timeoutMs;
		while (p.exitCode === null && p.signalCode === null) {
			echo();
			if (Date.now() >= deadline) {
				// Release the wait even if signalling is refused or Bun never reports completion.
				try { p.kill("SIGKILL"); } catch { /* the deadline still applies */ }
				throw new Stop(`command timed out after ${o.timeoutMs} ms: ${cmd.join(" ")}`);
			}
			await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
		}
		const out = readFileSync(outPath, "utf8");
		const err = readFileSync(errPath, "utf8");
		return { code: p.exitCode, signal: p.signalCode ?? null, out, err: err.trim() };
	} finally {
		p?.unref();
		if (echoFd !== null) {
			try {
				echo();
			} catch (e) {
				process.stderr.write(`the stderr of ${cmd.join(" ")} was not all copied to this log: ${errText(e)}\n`);
			} finally {
				closeSync(echoFd);
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

/** One wrapper call's end: its exit, its stdout and stderr, and whether the outlive sweep fired on it (PLAN wl-mvq4edh02r5z40 D0; `callTimedOut`). */
type Wrapped = { code: number | null; signal: string | null; out: string; err: string; outlived: boolean };

class Runner {
	readonly root = runsRoot(process.env);
	readonly runDir: string;
	readonly as2root = process.env.AGENT_SYSTEM_TEST_RUNNER_ROOT || AS2TEST_ROOT;
	readonly install = installSpec();
	readonly exec = join(this.install.libexec, "exec");
	private repo = "";
	readonly stageRoot: string;
	readonly stage: string;
	readonly workDir: string;
	readonly lockDb: Database;
	readonly capBytes: number;
	private timer: Timer | undefined;
	/** The run took the lock row at some point. */
	private held = false;
	/** The run learnt it no longer holds the row (heartbeat or checkpoint) or its request. */
	private superseded: string | null = null;
	private soloCalls = 0;
	private postSweepDeadline = Infinity;
	private baseSoloCalls = 0;
	private basePrepared = false;
	private url = "";
	/** The served repo's `owner/repo` (`servedOf`), every status post's target; empty until the run resolves it. */
	private ownerRepo = "";
	/** The run's place in the lock queue: its `test-requested:` entry's created_at in ms, read once at start. */
	readonly requestedAt: number;
	private readonly f: RunFacts & { load: PartLoad[]; base: string | null; mergeBase: string | null; preflight: string | null };

	constructor(readonly ledger: Ledger, readonly wl: string, readonly request: TestRequested, readonly config: TestRunnerConfig) {
		this.runDir = runDirOf(this.root, request.runId);
		this.stageRoot = join(this.as2root, "stage");
		this.stage = stageDirOf(request.runId, this.as2root);
		this.workDir = workDirOf(request.runId, this.as2root);
		const rec = testRuns(ledger.entries(wl)).find((r) => r.request.runId === request.runId);
		if (!rec) throw new Fail(`no test-requested: record for ${request.runId} on ${wl}`, START_EXIT.failed);
		this.requestedAt = Date.parse(rec.request.createdAt);
		this.lockDb = openLockDb(this.root);
		this.capBytes = reportCapBytes(config);
		this.f = {
			requestedSha: request.sha, fetchedSha: null, error: null, full: null, fullTimedOut: false, solo: [], headAtStart: request.sha, headAtEnd: null, owner: true, sliceState: null, baseRuns: null,
			load: [],
			base: null, mergeBase: null, preflight: null,
		};
	}

	get id(): string {
		return this.request.runId;
	}

	log(s: string): void {
		process.stdout.write(`${new Date().toISOString()} ${s}\n`);
	}

	/** One tick of the 15 s timer (§ 2.2 step 4): the heartbeat file, then the lock row's heartbeatAt by this run's own id. */
	beat(): void {
		const now = Date.now();
		try {
			const tmp = join(this.runDir, `.heartbeat.${process.pid}`);
			writeFileSync(tmp, heartbeatText(this.id, now), { mode: 0o600 });
			renameSync(tmp, join(this.runDir, "heartbeat"));
		} catch (e) {
			this.log(`heartbeat file not written: ${errText(e)}`);
		}
		if (!this.held || this.superseded) return;
		hookSync(this.id, "heartbeat-update");
		try {
			const changes = this.lockDb.query("UPDATE lock SET heartbeatAt = ? WHERE runId = ?").run(Date.now(), this.id).changes;
			hookMark(this.id, "heartbeat", { changes });
			if (changes === 0) this.lose("the lock row no longer holds this run (heartbeat updated no row)");
		} catch (e) {
			this.log(`lock heartbeat not written: ${errText(e)}`);
		}
	}

	private lose(why: string): void {
		if (!this.superseded) {
			this.superseded = why;
			this.log(`superseded: ${why}`);
		}
	}

	/**
	 * Wait for the lock (queued, oldest request first), take it clean or from a stale holder, and publish `current` in that same
	 * transaction. Every attempt is one BEGIN IMMEDIATE transaction: register in `queue` (a no-op once registered; a row pruned
	 * while this run was suspended comes back with the same requestedAt), prune the dead waiters ahead and find the first live
	 * one, then the holder check; a live holder or a live waiter ahead keeps the run queued. Taking the lock removes the run's row.
	 */
	async acquire(): Promise<void> {
		const waitStart = Date.now();
		const pollMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_POLL_MS", 2_000);
		mkdirSync(this.stageRoot, { recursive: true });
		// A merge train's run never ends on the wait cap (`queuedTooLong`); membership only grows while a train is open, so it is read once.
		const train = trainPrs(this.ledger.entries(this.wl), this.ledger.instructions(this.wl)).length > 0;
		try {
			for (;;) {
				let took: { displaced: string | null } | null = null;
				try {
					took = this.lockDb.transaction(() => {
						this.lockDb.query("INSERT OR IGNORE INTO queue (runId, workloadId, requestedAt) VALUES (?, ?, ?)").run(this.id, this.wl, this.requestedAt);
						const blocker = this.queueBlocker();
						const row = lockRow(this.lockDb);
						if (row && row.runId !== this.id && !lockHolderStale(row.heartbeatAt, Date.now())) return null;
						if (blocker !== null) return null;
						this.lockDb.query("INSERT OR REPLACE INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, ?, ?, ?, ?, ?)")
							.run(this.id, process.pid, process.pid, this.runDir, Date.now());
						this.lockDb.query("DELETE FROM queue WHERE runId = ?").run(this.id);
						writeCurrent(this.stageRoot, this.id);
						hookSync(this.id, "acquire-tx");
						return { displaced: row && row.runId !== this.id ? row.runId : null };
					}).immediate();
				} catch (e) {
					if (!isBusy(e)) throw e;
					hookMark(this.id, "acquire-busy");
				}
				if (took) {
					this.held = true;
					hookMark(this.id, "acquired", took);
					this.log(took.displaced ? `took the lock from the stale holder ${took.displaced}` : "took the lock");
					this.beat();
					return;
				}
				if (queuedTooLong(waitStart, Date.now(), this.config, train)) throw new Stop("queued too long");
				hookMark(this.id, "queued");
				await Bun.sleep(pollMs);
			}
		} catch (e) {
			this.leaveQueue();
			throw e;
		}
	}

	/**
	 * Inside the acquiring transaction, after this run registered: the first live waiter ahead of it in (requestedAt, run id)
	 * order, or null. Each waiter ahead is judged on its ledger record and heartbeat file (`queueWaiterLive`, one entries read
	 * per workload); the dead ones before the first live one are deleted.
	 */
	private queueBlocker(): string | null {
		const rows = this.lockDb.query<QueueRow, []>("SELECT runId, workloadId, requestedAt FROM queue ORDER BY requestedAt, runId").all();
		const records = new Map<string, RunRecord[]>();
		const now = Date.now();
		const { blocker, dead } = queueAhead(rows, this.id, (q) => {
			let recs = records.get(q.workloadId);
			if (!recs) records.set(q.workloadId, (recs = testRuns(this.ledger.entries(q.workloadId))));
			return queueWaiterLive(recs.find((r) => r.request.runId === q.runId), heartbeatOf(this.root, q.runId), now);
		});
		const prune = this.lockDb.query("DELETE FROM queue WHERE runId = ?");
		for (const runId of dead) prune.run(runId);
		if (dead.length > 0) this.log(`pruned the dead waiters ${dead.join(", ")} from the lock queue`);
		return blocker;
	}

	/** Leave the lock queue (best effort): when acquire ends without the lock, and at the end of the run. */
	private leaveQueue(): void {
		try {
			busyLoop(() => this.lockDb.query("DELETE FROM queue WHERE runId = ?").run(this.id));
		} catch (e) {
			this.log(`the lock queue row was not removed: ${errText(e)}`);
		}
	}

	/** Before each phase and wrapper call (§ 2.3 step 1, losing the lock): the row still holds this run, and `current` is (re)published under that check. */
	async checkpoint(phase: string): Promise<void> {
		await hook(this.id, `phase-${phase}`);
		if (this.superseded) throw new Superseded(this.superseded);
		if (!publishIfOwner(this.lockDb, this.stageRoot, this.id)) {
			this.lose(`the lock row holds ${lockRow(this.lockDb)?.runId ?? "no run"}`);
			throw new Superseded(this.superseded!);
		}
	}

	/**
	 * One wrapper call: `sudo -n -u _as2test <exec> <sub> <run id> …` (wrapperArgv). Its stdout and stderr are captured, returned and echoed to runner.log.
	 * It starts in the as2test root, which `_as2test` can read: the run dir is Jo's 0700 dir, and a cwd the child cannot read kills bun on getcwd.
	 */
	async wrap(call: WrapperCall, capMs: number | null = null): Promise<Wrapped> {
		const argv = wrapperArgv(call, this.exec);
		const outliveMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_OUTLIVE_MS", OUTLIVE_MS);
		let outlived = false;
		const watchdog = capMs === null ? null : setTimeout(() => {
			outlived = true;
			this.log(`${call.sub} outlived its cap by ${outliveMs / 1000} s; sweeping`);
			void this.wrap({ sub: "sweep", runId: this.id }).catch((e) => this.log(`the outlive sweep failed: ${errText(e)}`));
		}, capMs + outliveMs);
		const r = await run(argv, {
			cwd: this.as2root, env: process.env,
			timeoutMs: (capMs ?? 0) + outliveMs + 120_000, echoStderr: true,
			onSpawn: (pid) => {
				hookMark(this.id, `spawn-${call.sub}`, { pid });
				this.log(`${argv.slice(4).join(" ")}: started pid ${pid}`);
			},
		}).finally(() => clearTimeout(watchdog ?? undefined));
		const { out } = r;
		if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
		this.log(`${argv.slice(4).join(" ")} → ${r.signal ?? `exit ${r.code}`}${outlived ? " (after the outlive sweep)" : ""}`);
		return { code: r.code, signal: r.signal, out, err: r.err, outlived };
	}

	/** A fenced exit (77) while this run believes it holds the lock: the checkpoint decides whether it was displaced. */
	private async fenced(what: string): Promise<never> {
		await this.checkpoint("fenced");
		throw new Stop(`${what} was fenced although the lock row holds this run`);
	}

	/** `sweep`, retried after a signal at most SWEEP_RETRIES times while the row and `current` still name this run (§ 2.3 step 1). */
	async sweep(after: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			await this.checkpoint("sweep");
			hookMark(this.id, "sweep", { after, attempt });
			const r = await this.wrap({ sub: "sweep", runId: this.id });
			if (r.code === WRAPPER_EXIT.ok) return;
			if (r.code === WRAPPER_EXIT.fenced) await this.fenced("the sweep");
			if (r.signal !== null && attempt < SWEEP_RETRIES) {
				this.log(`the sweep after ${after} ended by ${r.signal}; retry ${attempt + 1} of ${SWEEP_RETRIES}`);
				continue;
			}
			if (r.code === WRAPPER_EXIT.sweepLockHeld) throw new Stop("sweep lock held");
			// A sweep that is not ok names why in the run's error: its survivor line (PLAN wl-mvqu69tjvpy96o C9), else its first stderr line.
			const why = r.signal === null ? sweepFailureOf(r.err) : null;
			throw new Stop(r.signal !== null
				? `the sweep after ${after} ended by ${r.signal} ${attempt + 1} times; its ${SWEEP_RETRIES} retries are spent`
				: `the sweep after ${after} failed: exit ${r.code}${why === null ? "" : `: ${why}`}`);
		}
	}

	/** The install facts of the runner's own checkout (REPO_ROOT) against the install, and their verdict. */
	private decideInstall(): { facts: InstallFacts; v: InstallVerdict } {
		const spec = this.install;
		const facts = readInstall({ checkout: REPO_ROOT, libexec: spec.libexec, root: this.as2root, sudoers: spec.sudoers, dscl: spec.dscl });
		return { facts, v: installDecision(facts, spec.ids) };
	}

	/**
	 * `sudo -n <libexec>/refresh`, with no argument (PLAN wl-mv718fxhwwcn40 § 1.3), capped at REFRESH_TIMEOUT_MS (the test knobs
	 * AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS, _GRACE_MS and _REAP_MS shorten it): SIGTERM, SIGKILL after the grace, then at most
	 * REFRESH_REAP_MS more for sudo to exit, and `exited: false` when it has not. Its stdout and stderr go to run-dir files,
	 * never pipes a root grandchild could hold open past the cap, and are then copied into runner.log.
	 */
	async refresh(): Promise<{ code: number | null; signal: string | null; timedOut: boolean; exited: boolean; cap: string; reap: string; out: string; err: string }> {
		const argv = ["sudo", "-n", join(this.install.libexec, "refresh")];
		const capMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS", REFRESH_TIMEOUT_MS);
		const graceMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS", REFRESH_KILL_GRACE_MS);
		const reapMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS", REFRESH_REAP_MS);
		const outFile = join(this.runDir, "refresh.out");
		const errFile = join(this.runDir, "refresh.err");
		const outFd = openSync(outFile, "w", 0o600);
		const errFd = openSync(errFile, "w", 0o600);
		let p: Subprocess;
		try {
			p = spawn(argv, { cwd: this.as2root, env: process.env, stdin: "ignore", stdout: outFd, stderr: errFd });
		} finally {
			closeSync(outFd);
			closeSync(errFd);
		}
		this.log(`${argv.join(" ")}: started`);
		// sudo runs as root, so the kernel may refuse Jo's signal to it: a refusal is logged, never thrown. Under test, the
		// `<run id>.refresh-signal.refuse` hook file stands in for that refusal.
		const signal = (sig: "SIGTERM" | "SIGKILL") => {
			const h = hookMark(this.id, "refresh-signal", { sig });
			if (h && existsSync(`${h.base}.refuse`)) {
				this.log(`${argv.join(" ")}: ${sig} refused: the test hook ${h.base}.refuse`);
				return;
			}
			try {
				p.kill(sig);
			} catch (e) {
				this.log(`${argv.join(" ")}: ${sig} refused: ${(e as Error).message}`);
			}
		};
		let timedOut = false;
		let timer: Timer | undefined;
		const exited = await new Promise<boolean>((done) => {
			void p.exited.then(() => done(true));
			timer = setTimeout(() => {
				timedOut = true;
				signal("SIGTERM");
				timer = setTimeout(() => {
					signal("SIGKILL");
					timer = setTimeout(() => done(false), reapMs);
				}, graceMs);
			}, capMs);
		});
		clearTimeout(timer);
		const [out, err] = [outFile, errFile].map((f) => {
			let text = "";
			try {
				text = readFileSync(f, "utf8");
			} catch {
				// nothing written
			}
			rmSync(f, { force: true });
			return text;
		}) as [string, string];
		if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
		if (err.trim()) process.stderr.write(err.endsWith("\n") ? err : `${err}\n`);
		// The cap and the reap wait in words: whole minutes as `N min`, anything else (a test knob's) in seconds.
		const words = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`);
		const [cap, reap] = [words(capMs), words(reapMs)];
		const r = { code: exited ? p.exitCode : null, signal: exited ? (p.signalCode ?? null) : null, timedOut, exited, cap, reap, out, err };
		const ended = exited ? (r.signal ?? `exit ${r.code}`) : `still running ${reap} after its SIGKILL`;
		this.log(`${argv.join(" ")} → ${ended}${timedOut ? ` (past its ${cap} cap)` : ""}`);
		return r;
	}

	/**
	 * The install half of the preflight (§ 3.1; PLAN wl-mv718fxhwwcn40 § 1.3), before any wrapper call runs the installed `exec`.
	 * A drift the refresh helper can fix (`file-drift`, `input-drift`) gets one `refresh` and one decision more, never a loop; an
	 * `install` failure, which only setup fixes, stops the run as it is. Every stop is the run's `error` verdict and nothing more.
	 * Returns the install verdict, whose summary carries the helper's `refreshed <old12>..<new12>` line when it ran.
	 */
	async installCheck(): Promise<Verdict> {
		await this.checkpoint("install");
		const stop: (reason: string) => never = (reason) => {
			this.f.preflight = `preflight: ${reason}`;
			throw new Stop(this.f.preflight);
		};
		let { facts, v } = this.decideInstall();
		let refreshed: string | null = null;
		if (!v.ok && v.kind !== "install") {
			this.log(`preflight: ${v.reason}; running the refresh helper`);
			const r = await this.refresh();
			if (r.code !== REFRESH_EXIT.ok) {
				// The REFRESH_EXIT name of the code (`fetch` for 70); `failed` for a code the helper does not define, such as sudo's own refusal.
				const name = Object.entries(REFRESH_EXIT).find(([, c]) => c === r.code)?.[0] ?? "failed";
				const how = !r.exited ? `still running ${r.reap} after its SIGKILL` : r.code === null ? `ended by ${r.signal ?? "a signal"}` : `${name} (exit ${r.code})`;
				const cap = r.timedOut ? ` after the runner's ${r.cap} cap` : "";
				// Past the cap, a sudo with no exit code of its own (never reaped, or ended by the runner's signal) says
				// nothing of the root helper under it, which may still be running and holding refresh.d/lock. This run's
				// lock, released in main's finally, is no proof it ended: the helper's own lockf lock is what serialises
				// refreshes, so the next run's refresh waits on it and exits 69 (lock) while the old helper holds it.
				const live = r.timedOut && r.code === null ? "; the helper may still be running, and the next refresh waits on its lock (exit 69, lock, while it holds it)" : "";
				stop(`${REFRESH_FAILED}: the refresh helper ${how}${cap}${live}: ${r.err.trim().split("\n").at(-1) || "no stderr"}`);
			}
			refreshed = r.out.trim().split("\n").at(-1) || null;
			({ facts, v } = this.decideInstall());
			if (!v.ok && v.kind === "input-drift" && facts.source.ok) {
				const src = facts.source.source;
				const rel = Object.keys(src.inputs).find((k) => facts.inputHashes[k] !== src.inputs[k]);
				const head = await run(["git", ...NO_HOOKS, "rev-parse", "--verify", "HEAD"], { cwd: REPO_ROOT, env: trustedEnv("/dev/null"), timeoutMs: 30_000 });
				const sha = /^[0-9a-f]{40}$/.test(head.out.trim()) ? head.out.trim().slice(0, 12) : "unknown";
				stop(`${CHECKOUT_DRIFT}: ${rel} in the runner's checkout ${REPO_ROOT} (HEAD ${sha}) differs from the bundle, which is built from origin/main ${src.sourceSha.slice(0, 12)}; bring the checkout to origin/main`);
			}
			if (!v.ok && v.kind === "file-drift") {
				const reason = v.reason;
				const file = REBUILT_FILES.find((n) => reason.startsWith(`installed ${n} `)) ?? REBUILT_FILES.join(" or ");
				stop(`${REFRESH_FAILED}: the helper exited 0 but installed ${file} does not match SOURCE`);
			}
		}
		if (!v.ok) return stop(v.reason);
		return refreshed ? { ok: true, summary: `${v.summary}; ${refreshed}` } : v;
	}

	/** The probe half of the preflight (§ 3.1), after the sweep: `probe` over the paths the runner itself resolved, decided with the install verdict; a failure is the run's `error`. */
	async preflight(install: Verdict): Promise<void> {
		await this.checkpoint("preflight");
		const items = preflightProbes({ env: process.env, runsRoot: this.root, mainCheckout: this.repo, lanesRoot: dirname(worktreePath(this.repo, this.wl)), root: this.as2root });
		const r = await this.wrap(probeCall(this.id, items));
		if (r.code === WRAPPER_EXIT.fenced) await this.fenced("the probe");
		const v = preflightDecision(install, probeDecision(items, r.signal !== null ? null : r.code, r.out));
		this.f.preflight = v.ok ? v.summary : v.reason;
		if (!v.ok) throw new Stop(v.reason);
	}

	/** Retention (§ 2.3 step 9): the newest KEEP_RUNS stay whole; older ones lose their stage dir, their work dir (fenced `cleanup`) and the run dir's scratch files. */
	async retention(): Promise<void> {
		const ids = new Set<string>([this.id]);
		for (const dir of [this.root, this.stageRoot, join(this.as2root, "runs")]) {
			try {
				for (const n of readdirSync(dir)) if (RUN_ID_RE.test(n)) ids.add(n);
			} catch {
				// a root that does not exist yet holds no runs
			}
		}
		const at = (id: string): number => parseInt(id.slice(3, 12), 36) || 0;
		const prune = pruneRuns([...ids].map((id) => ({ id, at: at(id) })), KEEP_RUNS).filter((id) => id !== this.id);
		for (const old of prune) {
			rmSync(stageDirOf(old, this.as2root), { recursive: true, force: true });
			if (existsSync(workDirOf(old, this.as2root))) {
				await this.checkpoint("cleanup");
				const r = await this.wrap({ sub: "cleanup", runId: this.id, oldRunId: old });
				if (r.code === WRAPPER_EXIT.fenced) await this.fenced("cleanup");
				if (r.code !== WRAPPER_EXIT.ok) this.log(`cleanup of ${old} failed: ${r.signal ?? `exit ${r.code}`}`);
			}
			const dir = join(this.root, old);
			try {
				for (const n of readdirSync(dir)) if (!/\.(xml|log)$/.test(n) && n !== "result.json") rmSync(join(dir, n), { recursive: true, force: true });
			} catch {
				// no run dir for this id
			}
		}
	}

	/** The trusted phase (§ 2.3 step 2): clone, fetch, the sha check, checkout, base, changed files, the bundle. Null when the fetched head is not the requested sha. */
	async trusted(): Promise<string[] | null> {
		await this.checkpoint("trusted");
		const repo = join(this.stage, "repo");
		rmSync(this.stage, { recursive: true, force: true });
		mkdirSync(repo, { recursive: true, mode: 0o750 });
		const gitconfig = join(this.runDir, "trusted.gitconfig");
		writeFileSync(gitconfig, "", { mode: 0o600 });
		const env = trustedEnv(gitconfig);
		/** A git step whose output is one object name (or nothing), trimmed. */
		const git = async (args: string[], what: string): Promise<string> => {
			const r = await run(["git", ...args], { cwd: repo, env, timeoutMs: 600_000 });
			if (r.code !== 0) throw new Stop(`${what} failed: ${r.err.split("\n").at(-1) || `exit ${r.code}`}`);
			return r.out.trim();
		};
		const { request: q } = this;
		await git([...NETWORK, "clone", "-q", "--no-checkout", this.url, "."], "git clone");
		await git([...NETWORK, "fetch", "-q", "origin", `+refs/pull/${q.pr}/head:refs/remotes/origin/pr/${q.pr}`, "+refs/heads/main:refs/remotes/origin/main"], "git fetch");
		this.f.fetchedSha = await git([...NO_HOOKS, "rev-parse", "--verify", `refs/remotes/origin/pr/${q.pr}^{commit}`], "reading the PR head");
		if (this.f.fetchedSha !== q.sha) return null;
		await git([...NO_HOOKS, "checkout", "-q", "--detach", q.sha], "git checkout");
		this.f.headAtStart = await git([...NO_HOOKS, "rev-parse", "HEAD"], "reading HEAD");
		this.f.base = await git([...NO_HOOKS, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], "reading origin/main");
		this.f.mergeBase = await git([...NO_HOOKS, "merge-base", q.sha, "refs/remotes/origin/main"], "git merge-base");
		const diff = await run(["git", ...NO_HOOKS, "diff", "--name-only", "-z", "--diff-filter=AMR", this.f.mergeBase, q.sha], { cwd: repo, env, timeoutMs: 120_000 });
		if (diff.code !== 0) throw new Stop(`git diff failed: ${diff.err.split("\n").at(-1) || `exit ${diff.code}`}`);
		const changed = changedTestFiles(diff.out);
		await git([...NO_HOOKS, "remote", "remove", "origin"], "git remote remove");
		// The tested commit as a branch, so the bundle carries it whatever HEAD's handling.
		await git([...NO_HOOKS, "update-ref", `refs/heads/as2-tested-pr-${q.pr}`, q.sha], "naming the tested commit");
		// The trusted base for `migration-items check`: origin/main's sha as a tag the clone keeps (overwrites any fetched tag of that name).
		await git([...NO_HOOKS, "update-ref", "refs/tags/as2-trusted-main", this.f.base], "tagging the trusted base");
		const bundle = join(this.stage, "repo.bundle");
		await git([...NO_HOOKS, "bundle", "create", "-q", bundle, "--all"], "git bundle create");
		chmodSync(bundle, 0o640);
		const caps = join(this.stage, "caps.json");
		writeFileSync(caps, `${JSON.stringify({ fullCapMin: this.config.fullCapMin, soloCapMin: this.config.soloCapMin, fullWorkers: this.config.fullWorkers })}\n`, { mode: 0o640 });
		chmodSync(caps, 0o640);
		chmodSync(this.stage, 0o750);
		this.log(`trusted phase: ${q.sha} on base ${this.f.base}, merge-base ${this.f.mergeBase}; changed test files: ${changed.join(" ") || "none"}`);
		return changed;
	}

	async prepare(): Promise<void> {
		await this.checkpoint("prepare");
		const r = await this.wrap({ sub: "prepare", runId: this.id, sha: this.request.sha });
		if (r.code === WRAPPER_EXIT.fenced) await this.fenced("prepare");
		if (r.code !== WRAPPER_EXIT.ok) throw new Stop(`prepare failed: ${r.signal ?? `exit ${r.code}`}`);
	}

	/**
	 * One part through the wrapper, then its junit and log imported into the run dir and read into a result, with the junit's text
	 * (executedFiles reads it) and whether the call timed out (`callTimedOut`: exit 124 or the outlive sweep, PLAN wl-mvq4edh02r5z40
	 * D0). After a timed-out call the wrapper's stuck capture `<part>.stuck.log` (D5) is imported too; a missing or refused capture
	 * is one runner.log line and never changes the result. After every call, whatever its outcome, the wrapper's cleanup report
	 * `<part>.cleanup.log` is imported the same way (PLAN wl-mvqu69tjvpy96o C9), and the cleanup line on its stderr (`cleanupReportOf`)
	 * joins the part's error after the timeout, so a timed-out part names both its cap and its survivors. The host load is read at the
	 * part's start and end (`recordLoad`, E1). `base-solo` runs the file in the base clone (D8), reports `base-solo-<i>.*`.
	 */
	async part(call: { sub: "full" } | { sub: "solo" | "base-solo"; file: string }): Promise<{ result: PartResult; junit: string | null; timedOut: boolean }> {
		await this.checkpoint(call.sub);
		const capMs = (call.sub === "full" ? this.config.fullCapMin : this.config.soloCapMin) * 60_000;
		const label = call.sub === "full" ? "full" : `${call.sub} ${call.file}`;
		const start = this.loadAt(label, "start");
		// A part that starts overloaded gets its process snapshot beside it (bounded by the snapshot's own cap), awaited after the part.
		const startSnapshot = loadOver(start) ? this.loadSnapshot(label, "start", start) : null;
		const started = Date.now();
		let r: Wrapped | null = null;
		let ms = 0;
		let name: string = call.sub;
		try {
			r = await this.wrap(call.sub === "full" ? { sub: call.sub, runId: this.id } : { sub: call.sub, runId: this.id, file: call.file }, capMs);
			ms = Date.now() - started;
		} finally {
			const out = r?.out ?? "";
			if (call.sub === "solo") {
				this.soloCalls++;
				name = /^part (solo-\d+)$/m.exec(out)?.[1] ?? `solo-${this.soloCalls}`;
			} else if (call.sub === "base-solo") {
				this.baseSoloCalls++;
				name = /^part (base-solo-\d+)$/m.exec(out)?.[1] ?? `base-solo-${this.baseSoloCalls}`;
			}
			await this.recordLoad(name, call.sub === "full" ? null : call.file, label, start, startSnapshot);
		}
		if (r.code === WRAPPER_EXIT.fenced) await this.fenced(call.sub);
		const timedOut = callTimedOut(r);
		if (timedOut) this.importWrapperReport(`${name}.stuck.log`, true);
		this.importWrapperReport(`${name}.cleanup.log`, false);
		const cleanup = cleanupReportOf(r.err);
		if (r.code === WRAPPER_EXIT.refused || r.code === WRAPPER_EXIT.failed) {
			const wrapper = `the wrapper ${r.code === WRAPPER_EXIT.refused ? "refused" : "failed"} ${call.sub} (exit ${r.code})`;
			const error = [...(timedOut ? ["timeout"] : []), wrapper, ...(cleanup === null ? [] : [cleanup])].join("; ");
			return { result: { ...partResult({ junit: null, log: null, exit: r.code, ms }), error }, junit: null, timedOut };
		}
		const imported = importPart(this.workDir, this.runDir, name, this.capBytes);
		const result = partResult({ ...imported, exit: r.signal !== null ? null : r.code, ms, timedOut, cleanup, maxBytes: this.capBytes });
		return { result, junit: imported.junit, timedOut };
	}

	/**
	 * One of the wrapper's own reports of a part (`<part>.stuck.log`, D5; `<part>.cleanup.log`, C9) into the run dir under importReport's
	 * checks; logged, never thrown. A missing file is logged only when `expected` (a stuck capture after a timeout): a cleanup report
	 * exists only when the cleanup left survivors or could not look them up.
	 */
	private importWrapperReport(file: string, expected: boolean): void {
		try {
			const r = importReport(this.workDir, this.runDir, file, this.capBytes);
			if (r.error !== null) this.log(`${file} not imported: ${r.error}`);
			else if (r.text !== null) this.log(`${file} imported`);
			else if (expected) this.log(`${file} not imported: the wrapper wrote none`);
		} catch (e) {
			this.log(`${file} not imported: ${errText(e)}`);
		}
	}

	/** The host load now (`hostLoad`), logged as `load <part> <start|end>: …`, with the overload named when it is over the threshold. */
	private loadAt(label: string, when: "start" | "end"): LoadReading {
		const r = hostLoad();
		const over = loadOver(r) ? `; over ${OVERLOAD_PER_CORE} × ${r.cores} cores` : "";
		this.log(`load ${label} ${when}: ${r.load1} ${r.load5} ${r.load15} (1, 5, 15 min) on ${r.cores} cores${over}`);
		return r;
	}

	/**
	 * One bounded process snapshot of an overloaded host (E1): `ps -Ao pid,user,nice,pcpu,etime,comm`, async and killed at its cap
	 * (5 s; AGENT_SYSTEM_TEST_RUNNER_PS_MS in tests), cut to the LOAD_SNAPSHOT_ROWS busiest by %CPU. Never rejects: a ps that fails,
	 * is refused or runs past its cap is written into the text it returns.
	 */
	private async loadSnapshot(label: string, when: "start" | "end", at: LoadReading): Promise<string> {
		const argv = ["ps", "-Ao", "pid,user,nice,pcpu,etime,comm"];
		const capMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_PS_MS", 5_000);
		const head = `${label} at its ${when}, ${at.at}: load ${at.load1} ${at.load5} ${at.load15} (1, 5, 15 min) on ${at.cores} cores, over ${OVERLOAD_PER_CORE} × the cores\n`
			+ `${argv.join(" ")}, the ${LOAD_SNAPSHOT_ROWS} busiest by %CPU (cap ${capMs} ms):\n`;
		try {
			const r = await run(argv, { cwd: this.runDir, env: process.env, timeoutMs: capMs });
			const rows = topByCpu(r.out);
			const failed = r.code === 0 ? "" : `ps failed: ${r.signal ?? `exit ${r.code}`}: ${r.err || "no stderr"}\n`;
			return `${head}${failed}${rows.length > 0 ? `${rows.join("\n")}\n` : "ps printed no process\n"}`;
		} catch (e) {
			return `${head}ps failed: ${errText(e)}\n`;
		}
	}

	/**
	 * The part's end reading, its snapshot (the start's, else one taken now when the end is overloaded) written to `<part>.load.log`
	 * in the run dir, and its `load` entry (E1). Logged, never thrown: load never changes a result.
	 */
	private async recordLoad(name: string, file: string | null, label: string, start: LoadReading, startSnapshot: Promise<string> | null): Promise<void> {
		const end = this.loadAt(label, "end");
		const pending = startSnapshot ?? (loadOver(end) ? this.loadSnapshot(label, "end", end) : null);
		let snapshot: string | null = null;
		if (pending !== null) {
			const out = `${name}.load.log`;
			try {
				writeFileSync(join(this.runDir, out), await pending, { mode: 0o600 });
				snapshot = out;
				this.log(`${out} written: the host was overloaded during ${label}`);
			} catch (e) {
				this.log(`${out} not written: ${errText(e)}`);
			}
		}
		this.f.load.push({ part: name, file, start, end, snapshot });
	}

	/**
	 * Each failing solo file rerun alone on base (PLAN wl-mv8s8srodefytc rev 17.1 D8, PLAN wl-mvq4edh02r5z40 D3; `baseParts`): the
	 * same file alone (`base-solo`) in a clone of the same bundle at base's sha (origin/main as the trusted phase fetched it); the
	 * full suite never runs on base. A base result without an error is cached per base sha and `./<file>` label (`baseCache`), so a
	 * second PR on the same red main reruns nothing; an error is not cached. A `full` entry an older runner cached is never read.
	 */
	async baseRuns(): Promise<void> {
		const parts = baseParts(this.f);
		const sha = this.f.base;
		if (parts.length === 0 || sha === null) return;
		const results: Record<string, PartResult> = {};
		for (const file of parts) {
			const cached = readBaseCache(this.root, sha, file);
			if (cached !== null) {
				this.log(`base ${file} at ${sha}: cached`);
				results[file] = cached;
				continue;
			}
			if (!this.basePrepared) {
				await this.checkpoint("base-prepare");
				const r = await this.wrap({ sub: "base-prepare", runId: this.id, sha });
				if (r.code === WRAPPER_EXIT.fenced) await this.fenced("base-prepare");
				if (r.code !== WRAPPER_EXIT.ok) {
					this.log(`base-prepare failed: ${r.signal ?? `exit ${r.code}`}; the comparison stands without base`);
					break;
				}
				this.basePrepared = true;
			}
			const { result } = await this.part({ sub: "base-solo", file });
			await this.sweep(`base ${file}`);
			if (result.error === null) writeBaseCache(this.root, sha, file, result);
			results[file] = result;
		}
		this.f.baseRuns = { sha, parts: results };
	}

	/** `git ls-remote <origin> refs/pull/<N>/head` with the trusted settings (§ 2.3 step 5); null when it cannot answer. */
	async headNow(timeoutMs = 120_000): Promise<string | null> {
		const pr = this.request.pr;
		const r = await run(["git", ...NETWORK, "ls-remote", this.url, `refs/pull/${pr}/head`], {
			cwd: this.runDir, env: trustedEnv(join(this.runDir, "trusted.gitconfig")), timeoutMs,
		});
		if (r.code !== 0) {
			this.log(`ls-remote failed: ${r.err.split("\n").at(-1) || `exit ${r.code}`}`);
			return null;
		}
		return new RegExp(`^([0-9a-f]{40})\\trefs/pull/${pr}/head$`, "m").exec(r.out)?.[1] ?? null;
	}

	/**
	 * Steps in the plan's order: lock and publish → install check (and refresh) → sweep → probe → retention → trusted → prepare →
	 * the full part and its sweep → the solo parts `soloPlan` names (none after a timed-out full part), a sweep after each → base runs
	 * (none after a timeout) → post-sweep finalization deadline → head re-check.
	 */
	async body(): Promise<void> {
		({ url: this.url, repo: this.repo, ownerRepo: this.ownerRepo } = servedOf(this.ledger, this.wl, this.config));
		await this.acquire();
		const install = await this.installCheck();
		await this.sweep("publish");
		await this.preflight(install);
		await this.retention();
		const changed = await this.trusted();
		if (changed === null) return;
		await this.prepare();
		this.log(`full workers ${this.config.fullWorkers}`);
		const full = await this.part({ sub: "full" });
		this.f.full = full.result;
		this.f.fullTimedOut = full.timedOut;
		await this.sweep("full");
		const plan = soloPlan({ full: full.result, timedOut: full.timedOut, changed, executed: full.junit === null ? [] : executedFiles(full.junit) });
		if (plan.stop) this.log("full part timed out: no solo or base parts");
		else {
			this.log(`solo parts: ${plan.files.join(" ") || "none"}`);
			for (const file of plan.files) {
				this.f.solo.push({ file, ...(await this.part({ sub: "solo", file })).result });
				await this.sweep(file);
			}
			await this.baseRuns();
		}
		this.postSweepDeadline = Date.now() + msEnv("AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS", 150_000);
		this.log(`post-sweep finalization started; deadline ${new Date(this.postSweepDeadline).toISOString()}`);
		await hook(this.id, "head-recheck", {}, this.postSweepDeadline);
		this.f.headAtEnd = await this.headNow(Math.max(1, this.postSweepDeadline - Date.now()));
	}

	/**
	 * The result (§ 2.3 steps 6–8): with the runs.db row held in a BEGIN IMMEDIATE transaction (so no
	 * takeover lands in between), one ledger transaction checks ownership and the slice's state,
	 * decides, writes `test-run:`, settles (completes the slice) when the decision says so and, for a
	 * run that is not green on a workload no lane holds, writes the `test-run-failed:` message, and for a run with a failing
	 * security test, whoever holds the workload, the `security-red:` message. The
	 * settle commits with the check it rests on: no successor request, pause or cancel lands between
	 * them, and a slice that is not open is never touched. Then `result.json`.
	 */
	finish(): TestRun {
		// Acquire BEGIN outside ledger.write's retry policy: once held, recordEntry/completeSlice
		// use nested savepoints. Only the publication loop below retries either database.
		const write = (lockMine: boolean) => this.ledger.db.transaction(() => {
			const owner = lockMine && !this.superseded && ownsRequest(testRuns(this.ledger.entries(this.wl)), this.id);
			const facts: RunFacts = { ...this.f, owner, sliceState: this.ledger.slice(this.request.slice)?.state ?? null };
			const decided = decideRun(facts);
			// A run displaced from the lock says so; decideRun's reason alone speaks only of the request.
			const lost = this.superseded ?? (lockMine ? null : `the lock row holds ${lockRow(this.lockDb)?.runId ?? "no run"}`);
			const decision = decided.verdict === "superseded" && lost ? { ...decided, reason: `${lost}; ${decided.reason}` } : decided;
			const run = buildTestRun(this.request, facts, decision, { base: this.f.base, mergeBase: this.f.mergeBase, runDir: this.runDir, preflight: this.f.preflight });
			this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: this.request.slice, kind: "assumption", body: testRunBody(run) });
			// decision.settle holds only for an owner whose slice this transaction read as open. The
			// completion is a nested write (a savepoint): a refusal rolls back only itself, and the
			// `test-run:` entry still commits.
			let settled: { ok: true } | { ok: false; reason: string } | null = null;
			if (decision.settle) {
				try {
					this.ledger.completeSlice(this.request.slice, { by: TEST_RUNNER_BY, artifact: settleArtifact(run) });
					settled = { ok: true };
				} catch (e) {
					settled = { ok: false, reason: errText(e) };
				}
			}
			const heldLive = this.ledger.liveLaneHolders().some((h) => h.workloadId === this.wl);
			const failed = notifiesOrchestrator(run.verdict, heldLive) ? testRunFailedOf(this.wl, this.request.slice, run) : null;
			if (failed) {
				this.ledger.enqueue({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: this.request.slice, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: testRunFailedBody(failed) });
			}
			// PLAN wl-mvg1vs0rhnu3gg § 3.3: a failing security test reaches Jo whatever holds the workload, so this ignores heldLive.
			const security = securityRedOf(this.wl, this.request.slice, run);
			if (security) {
				this.ledger.enqueue({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: this.request.slice, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: securityRedBody(security) });
			}
			return { run, settled };
		}).immediate();
		let published: { run: TestRun; settled: { ok: true } | { ok: false; reason: string } | null };
		for (;;) {
			try {
				// Even an expired head/result guard gets one nonblocking attempt to record its error.
				published = this.held
					? this.lockDb.transaction(() => write(lockRow(this.lockDb)?.runId === this.id)).immediate()
					: write(true);
				break;
			} catch (e) {
				if (!isBusy(e)) throw e;
				hookMark(this.id, "publication-busy");
				const remaining = this.postSweepDeadline - Date.now();
				if (remaining <= 0) throw new Stop("post-sweep deadline exceeded during publication");
				Bun.sleepSync(Math.min(50, remaining));
				if (Date.now() >= this.postSweepDeadline) throw new Stop("post-sweep deadline exceeded during publication");
			}
		}
		const { run, settled } = published;
		this.log(`test-run ${run.verdict}${run.reason ? `: ${run.reason}` : ""}`);
		if (settled?.ok) this.log(`settled ${this.request.slice}`);
		else if (settled) this.log(`the settle of ${this.request.slice} was refused: ${settled.reason}`);
		this.writeResult(run);
		return run;
	}

	private writeResult(run: TestRun): void {
		const tmp = join(this.runDir, `.result.${process.pid}.json`);
		try {
			writeFileSync(tmp, resultJson(run), { mode: 0o600 });
			renameSync(tmp, join(this.runDir, "result.json"));
		} catch (e) {
			this.log(`result.json not written: ${errText(e)}`);
		} finally {
			rmSync(tmp, { force: true });
		}
	}

	async main(): Promise<number> {
		mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
		this.beat();
		this.timer = setInterval(() => this.beat(), msEnv("AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS", HEARTBEAT_EVERY_MS));
		try {
			try {
				await this.body();
			} catch (e) {
				if (e instanceof Superseded) this.lose(e.message);
				else if (e instanceof Stop) this.f.error = e.message;
				else if (e instanceof Fail) this.f.error = e.message;
				else this.f.error = `the runner failed: ${errText(e)}`;
				if (!(e instanceof Superseded)) this.log(`stopped: ${this.f.error}`);
			}
			if (!Number.isFinite(this.postSweepDeadline)) this.postSweepDeadline = Date.now() + msEnv("AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS", 150_000);
			try {
				await hook(this.id, "result", {}, this.postSweepDeadline);
				if (Date.now() >= this.postSweepDeadline) throw new Stop("post-sweep deadline exceeded before publication");
			} catch (e) {
				this.f.error = errText(e);
				this.log(`stopped: ${this.f.error}`);
			}
			// Synchronous SQLite waits cannot be interrupted by JS timers. Publication retries
			// nonblocking BEGINs against the shared deadline, not nested fixed retry budgets.
			this.lockDb.exec("PRAGMA busy_timeout = 0");
			this.ledger.db.exec("PRAGMA busy_timeout = 0");
			let run: TestRun;
			try {
				run = this.finish();
			} catch (e) {
				// A locked/unavailable ledger cannot accept a transaction. Preserve a local
				// error verdict instead of silently leaving no artifact; never settle here.
				const reason = `result publication failed: ${errText(e)}${this.f.error ? `; ${this.f.error}` : ""}`;
				const run = buildTestRun(this.request, this.f, { verdict: "error", outcome: "error", reason, settle: false }, {
					base: this.f.base, mergeBase: this.f.mergeBase, runDir: this.runDir, preflight: this.f.preflight,
				});
				this.log(`test-run error: ${reason}`);
				this.writeResult(run);
				return START_EXIT.failed;
			}
			// Only a terminal state, and only on the sha the fetch confirmed this run tested (trusted's sha check).
			// postFullSuite never throws and kills gh after 15 s.
			const state = this.f.fetchedSha === run.sha ? FULL_SUITE_STATE[run.verdict] : undefined;
			// A red or error status names the host overload (E1, announce-only); the state itself is the verdict's, whatever the load.
			const overloaded = (run.verdict === "red" || run.verdict === "error") && overloadNote(this.f.load) !== null;
			const description = `full suite ${run.verdict}, run ${run.runId}${overloaded ? "; host overloaded (see its load)" : ""}`;
			if (state) await postFullSuite(this.ownerRepo, state, run.sha, description, (s) => this.log(s));
			return 0;
		} finally {
			clearInterval(this.timer);
			// The run lock goes even when a refresh helper this run started may outlive it (installCheck's `live`):
			// releasing it proves nothing about that helper. Refreshes are serialised by the helper's own lockf lock
			// on refresh.d/lock, which the next run's refresh waits on (exit 69, lock, while the old helper holds it).
			if (this.held) {
				this.lockDb.exec("PRAGMA busy_timeout = 100");
				try {
					busyLoop(() => this.lockDb.query("DELETE FROM lock WHERE runId = ?").run(this.id));
				} catch (e) {
					this.log(`the lock was not released: ${errText(e)}`);
				}
			}
			this.leaveQueue();
			this.lockDb.close();
		}
	}
}

async function cmdRun(runId: string): Promise<number> {
	process.umask(0o027);
	if (!RUN_ID_RE.test(runId)) throw new Fail(`${runId} is not a run id`, START_EXIT.usage);
	const ledger = openLedger();
	const found = findRequest(ledger, runId);
	if (!found) throw new Fail(`no test-requested: for ${runId}`, START_EXIT.failed);
	const w: WorkloadStatusRow | null = ledger.workload(found.workloadId);
	if (!w) throw new Fail(`no workload ${found.workloadId}`, START_EXIT.failed);
	let config: TestRunnerConfig;
	try {
		config = loadConfig();
	} catch (e) {
		// No caps to run under: the request still gets its error result.
		process.stdout.write(`${new Date().toISOString()} ${errText(e)}\n`);
		recordError(ledger, found.workloadId, found.request, runDirOf(runsRoot(process.env), runId), errText(e));
		return 0;
	}
	return new Runner(ledger, found.workloadId, found.request, config).main();
}

// ---- main ---------------------------------------------------------------------------------------------

const USAGE = "usage: test-runner.ts start <wl> <pr> [--slice <id>] --requested-by <laneId> | run <run id>";

export async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	if (cmd === "start") {
		const [wl, prArg, ...opts] = rest;
		let slice: string | null = null;
		let by: string | null = null;
		for (let i = 0; i < opts.length; i += 2) {
			const v = opts[i + 1];
			if (opts[i] === "--slice" && v) slice = v;
			else if (opts[i] === "--requested-by" && v) by = v;
			else throw new Fail(USAGE, START_EXIT.usage);
		}
		if (!wl || !/^wl-\S+$/.test(wl) || !prArg || !/^[1-9]\d{0,9}$/.test(prArg) || by === null || !/^[^\s-]\S*$/.test(by)) throw new Fail(USAGE, START_EXIT.usage);
		if (slice !== null && !/^sl-\S+$/.test(slice)) throw new Fail(USAGE, START_EXIT.usage);
		return cmdStart(wl, Number(prArg), slice, by);
	}
	if (cmd === "run" && rest.length === 1) return cmdRun(rest[0]!);
	throw new Fail(USAGE, START_EXIT.usage);
}

if (import.meta.main) {
	const sub = process.argv[2] === "run" ? "run" : "start";
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			const f = err instanceof Fail ? err : new Fail(errText(err), START_EXIT.failed);
			process.stderr.write(`test-runner ${sub}: ${f.message.replace(/\s+/g, " ")}\n`);
			process.exit(f.code);
		},
	);
}
