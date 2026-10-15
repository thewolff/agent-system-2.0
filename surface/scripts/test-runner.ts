#!/usr/bin/env bun
// The outside-the-fence test runner (MIGRATION.md item 24; plan of wl-muraerdsgw7gn4, revision 12,
// § 2.2 to § 2.4; Jo's batch run, plan wl-mv615mkeaf1yio § 4). One Bun file with three subcommands;
// every decision it makes is surface/src/test-run.ts's or, for a batch, surface/src/test-batch.ts's.
//
//   start <wl> <pr> [--slice <id>] --requested-by <laneId>
//       the starter `lane_full_test` execs (30 s): the workload's repo is served, the PR is open, same
//       repo and on a branch the workload is bound to or a number Jo bound to it with `test-pr`
//       (`boundPrs`; every `gh` call names `-R`); then the run's admission to the runs.db queue
//       commits (its place in request order); then one ledger transaction settles dead runs, adds
//       the full-suite slice when none was named and writes `test-requested:` (a refusal or failure
//       there removes the admission); then `run` is spawned detached. Prints
//       `test-run <run id> runner <pid> sha <head> slice <slice> log <path>`, plus
//       ` bound-by <instruction id>` when only Jo's binding admitted the PR, exit 0. A refusal is one
//       stderr line `test-runner start: <reason>` and exit 2; a failure the same, exit 3; usage exit 1.
//   run <run id>
//       the detached run: heartbeat at once, the runs.db lock granted in admission order (queued while
//       another run holds it or an earlier live admission waits; dropped only when its request is
//       superseded, its PR reads MERGED or CLOSED, or past the queueMaxMin backstop, after which a
//       single run re-requests itself at the queue tail: `queueWaitDecision`), `current` published and the
//       admission removed in the acquiring transaction, the install check (a drifted bundle is
//       refreshed once through `sudo -n <libexec>/refresh`), sweep, probe, retention, the trusted
//       clone, the doc-only main-merge decision (plan wl-mv615mkeaf1yio § 3) and the bundle, then
//       every untrusted step through `sudo -n -u _as2test <exec> …` (the full suite unless the
//       decision is doc-merge, then each changed test file alone), a sweep after each part, the head
//       re-check, one `test-run:` entry and the settle in one ledger transaction, the lock released
//       and the admission removed on every exit.
//   start-batch <wl> <instruction id>
//       the starter the surface execs for Jo's `test-batch` word (30 s): Jo's instruction and the
//       surface's `test-batch:` entry naming it (`batchInstruction`), each PR open, same repo, its head
//       pinned from gh and a full green at exactly that head on its own workload (`batchAdmissible`);
//       then the admission to the queue, then one ledger transaction (`requestBatch`) re-checking the
//       instruction is still unused and each PR still admissible at the same pinned heads against
//       its own workload's runs read inside it, settling each earlier batch on the workload whose
//       runner died (`deadBatches`: `error runner died`), adding the batch slice and writing
//       `test-batch-requested:`, then `run` detached. Prints
//       `test-batch <run id> runner <pid> prs <#N@sha7,…> slice <slice> log <path>`; exits as `start`.
//   run <run id> also runs a batch (`test-batch-requested:`) and a red batch's attribution (the
//   `test-batch-run:` naming the id): the same lock, install check, sweep, probe and retention; the batch's
//   trusted phase merges the PRs onto origin/main in Jo's order and one full suite runs at the last
//   step; on red, still holding the lock, the result naming a fresh attribution id is written, the
//   bundle hard-linked into that id's stage dir, its queue row admitted at the tail and its runner
//   spawned. The attribution bisects over full-suite prefixes in sub-runs that keep the lock row
//   (only `current` names a sub-run, `publishSub`) and writes `test-batch-attribution:`.
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
//   AGENT_SYSTEM_TEST_RUNNER_PR_CHECK_MS    how often a queued single run reads its PR's state (default PR_CHECK_EVERY_MS, 5 min)
//   AGENT_SYSTEM_TEST_RUNNER_BUSY_MS        runs.db busy_timeout (default 5 s)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS    the refresh helper's cap (default REFRESH_CAP_S plus a minute, 15 min)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS  its SIGTERM-to-SIGKILL grace (default 10 s)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS   how long it then waits for sudo to exit (default 30 s)
//   AGENT_SYSTEM_TEST_HOOKS                 a directory of pause/mark files at named boundaries (`hook`), and the
//                                           `<run id>.refresh-signal.refuse` file: the runner's signals to the refresh
//                                           helper's sudo are refused, as the kernel may refuse Jo's signal to a root sudo
//   AGENT_SYSTEM_TEST_RUNNER_CRASH_AT       `after-result` or `after-admit`: a red batch kills itself (SIGKILL) at that
//                                           step of its attribution handoff (`crashAt`)
import { spawn, spawnSync, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
	appendFileSync, chmodSync, closeSync, constants as FS, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
	renameSync, rmSync, type Stats, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertNotLiveLedgerUnderTest, defaultLedgerPath, Ledger, TEST_RUNNER_BY, type WorkloadStatusRow } from "../../ledger/src/index";
import {
	AS2TEST_LIBEXEC, AS2TEST_SUDOERS, CHECKOUT_DRIFT, type DsclRead, type InstallFacts, installDecision, type InstallVerdict, type OwnerIds, preflightDecision,
	preflightProbes, probeCall, probeDecision, readInstall, REBUILT_FILES, REFRESH_CAP_S, REFRESH_EXIT, REFRESH_FAILED, type Verdict,
} from "../src/as2test";
import { repoOf } from "../src/decision-log";
import { boundPrs, holdersOf, worktreePath } from "../src/launch";
import {
	type Admission, AS2TEST_ROOT, AS2TEST_USER, backstopReason, boundBranches, buildTestRun, changedTestFiles, decideRun, docMergeDecision, failuresOf, fullSuiteSlice, HEARTBEAT_EVERY_MS,
	heartbeatText, KEEP_RUNS, lockHolderStale, makeRunId, type MergeFacts, notifiesOrchestrator, ownsRequest, parseHeartbeat, parseTestRequested, type PartInput,
	type PartResult, partResult, PR_CHECK_EVERY_MS, prAdmissible, type PrView, pruneRuns, queueHead, queueWaitDecision, reportCapBytes, rerequestedAs, reservation, resultJson, RUN_ID_RE,
	type RunFacts, runDirOf, runLive, runnerDiedRun, runsDbOf, runsRoot, servedRepo, settleArtifact, stageDirOf, type TestRequested, type TestRun, testRequestedBody, testRunBody,
	testRunFailedBody, testRunFailedOf, type TestRunnerConfig, testRunnerConfig, testRuns, workDirOf, WRAPPER_EXIT, type WrapperCall, wrapperArgv,
} from "../src/test-run";
import {
	type AttributionOutcome, attributionText, batchAdmissible, batchCreditsOf, batchInstruction, batchResultText, batchRunnerDiedRun, batchRuns, batchSettleArtifact, batchSlice,
	type BatchPr, type BatchStep, bisectNext, conflictReason, deadBatches, decideBatch, fullSuiteVerdict, ownWorkloadOf, parseTestBatchRequested, parseTestBatchRun, type Probe, type TestBatchAttribution,
	testBatchAttributionBody, testBatchCreditBody, type TestBatchRequested, testBatchRequestedBody, testBatchResultBody, type TestBatchRun, testBatchRunBody,
} from "../src/test-batch";
import { ORCHESTRATOR_RECIPIENT } from "../src/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The starter's exit codes (S3 maps them): a refusal is the request's fault, a failure the machine's. */
export const START_EXIT = { ok: 0, usage: 1, refused: 2, failed: 3 } as const;
/** A sweep that ends by a signal is retried this many times while the lock row and `current` still name the run (§ 2.3 step 1). */
export const SWEEP_RETRIES = 3;
/** The wrapper outliving its own cap by this much makes the runner sweep (§ 2.3 step 3). */
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
/** The queue backstop (`queueWaitDecision`): an `error` the single run re-requests once its result is written. */
class Backstop extends Stop {}
/** The run lost its lock or its request: it writes `superseded` and settles nothing. */
class Superseded extends Error {}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
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

// ---- test hooks ---------------------------------------------------------------------------------

/**
 * A named boundary. With AGENT_SYSTEM_TEST_HOOKS set, every pass appends a line to
 * `<dir>/<run id>.<point>.marks`; when `<dir>/<run id>.<point>.pause` exists, it writes
 * `.reached` and waits for `.go`, then removes all three (one pause per arming). Unset, it is inert.
 */
function hookMark(runId: string, point: string, info: Record<string, unknown> = {}): { base: string } | null {
	const dir = process.env.AGENT_SYSTEM_TEST_HOOKS;
	if (!dir) return null;
	const base = join(dir, `${runId}.${point}`);
	appendFileSync(`${base}.marks`, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...info })}\n`);
	return { base };
}
function hookResume(base: string): void {
	for (const s of [".pause", ".go", ".reached"]) rmSync(base + s, { force: true });
}
/** The synchronous form, for a boundary inside an open SQLite transaction. */
function hookSync(runId: string, point: string, info: Record<string, unknown> = {}): void {
	const h = hookMark(runId, point, info);
	if (!h || !existsSync(`${h.base}.pause`)) return;
	writeFileSync(`${h.base}.reached`, JSON.stringify({ pid: process.pid, at: Date.now(), ...info }));
	while (!existsSync(`${h.base}.go`)) Bun.sleepSync(25);
	hookResume(h.base);
}
async function hook(runId: string, point: string, info: Record<string, unknown> = {}): Promise<void> {
	const h = hookMark(runId, point, info);
	if (!h || !existsSync(`${h.base}.pause`)) return;
	writeFileSync(`${h.base}.reached`, JSON.stringify({ pid: process.pid, at: Date.now(), ...info }));
	while (!existsSync(`${h.base}.go`)) await Bun.sleep(25);
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

/** `<root>/runs.db` with its one-row lock table and its admission queue (plan wl-mv615mkeaf1yio § 2); busy_timeout first. */
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
	busyLoop(() => db.exec("CREATE TABLE IF NOT EXISTS queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT UNIQUE NOT NULL, admittedAt INTEGER NOT NULL)"));
	return db;
}

export const lockRow = (db: Database): LockRow | null => db.query<LockRow, []>("SELECT runId, pid, pgid, runDir, heartbeatAt FROM lock WHERE id = 1").get();

/** The admission queue, in request order. */
export const queueRows = (db: Database): Admission[] => db.query<Admission, []>("SELECT seq, runId, admittedAt FROM queue ORDER BY seq").all();

/** The starter's admission (plan § 2): one BEGIN IMMEDIATE insert. The order admissions commit in is the request order; returns the run's `seq`. */
export function admit(db: Database, runId: string, nowMs: number = Date.now()): number {
	return busyLoop(() => db.transaction(() => Number(db.query("INSERT INTO queue (runId, admittedAt) VALUES (?, ?)").run(runId, nowMs).lastInsertRowid)).immediate());
}

/** Remove a run's admission, on every exit path; a run with none is left as it is. */
export function withdraw(db: Database, runId: string): void {
	busyLoop(() => db.query("DELETE FROM queue WHERE runId = ?").run(runId));
}

/** The run asking for the lock. */
export interface Claimant {
	runId: string;
	pid: number;
	runDir: string;
}

/**
 * One poll of the lock wait (plan § 2), in one BEGIN IMMEDIATE transaction. A run with no admission
 * (its starter predates the queue, or its row was deleted as dead) is admitted now, at the tail. Dead
 * admissions are deleted. The lock is taken only when this run is the queue head (`queueHead`; the
 * asking run counts as live, since it is the process asking) and the lock row is free, this run's or
 * stale. Taking it installs the holder, deletes this run's admission and publishes `current`, all in
 * this one transaction, so no reader sees the run in neither place. Null while the run waits. The
 * clock is read once the transaction holds the write lock, unless the caller gives one.
 */
export function tryAcquire(
	db: Database, stageRoot: string, me: Claimant, heartbeatOf: (runId: string) => number | null, nowMs?: number,
): { displaced: string | null } | null {
	return db.transaction(() => {
		const now = nowMs ?? Date.now();
		let rows = queueRows(db);
		if (!rows.some((r) => r.runId === me.runId)) {
			db.query("INSERT INTO queue (runId, admittedAt) VALUES (?, ?)").run(me.runId, now);
			rows = queueRows(db);
		}
		const q = queueHead(rows, (id) => (id === me.runId ? now : heartbeatOf(id)), now);
		for (const d of q.dead) db.query("DELETE FROM queue WHERE seq = ?").run(d.seq);
		if (q.head?.runId !== me.runId) return null;
		const row = lockRow(db);
		if (row && row.runId !== me.runId && !lockHolderStale(row.heartbeatAt, now)) return null;
		db.query("INSERT OR REPLACE INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, ?, ?, ?, ?, ?)").run(me.runId, me.pid, me.pid, me.runDir, now);
		db.query("DELETE FROM queue WHERE runId = ?").run(me.runId);
		writeCurrent(stageRoot, me.runId);
		hookSync(me.runId, "acquire-tx");
		return { displaced: row && row.runId !== me.runId ? row.runId : null };
	}).immediate();
}

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

/** `<stage>/current` := `<run id>\n`, by an atomic rename of a 0640 temp file. Call only inside a runs.db transaction that holds the row for `runId` (or, for a sub-run, for its holder: `publishSub`). */
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

/**
 * A sub-run's publication (plan wl-mv615mkeaf1yio § 4, sub-runs with the lock never moving): in one
 * BEGIN IMMEDIATE transaction, `current := sub` only when the lock row still holds `holder`. The
 * lock row and its heartbeat keep the holder's id throughout; only `current` names the sub-run.
 * Returns whether it published.
 */
export function publishSub(db: Database, stageRoot: string, holder: string, sub: string): boolean {
	return busyLoop(() => db.transaction(() => {
		if (lockRow(db)?.runId !== holder) return false;
		writeCurrent(stageRoot, sub);
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

// ---- start ------------------------------------------------------------------------------------------

const GH_PR_VIEW_TIMEOUT_MS = 15_000;
const ghPrViewArgv = (ownerRepo: string, pr: number): string[] =>
	["gh", "pr", "view", String(pr), "-R", ownerRepo, "--json", "number,state,headRefOid,headRefName,baseRefName,isCrossRepository"];

/** `gh pr view`'s answer for PR `pr`: `failed` is why gh did not exit 0 (null when it did), `out` its stdout. */
function prViewOf(ownerRepo: string, pr: number, failed: string | null, out: string): PrView {
	if (failed !== null) throw new Fail(`gh pr view ${pr} -R ${ownerRepo} failed: ${failed}`, START_EXIT.failed);
	let v: Record<string, unknown>;
	try {
		v = JSON.parse(out) as Record<string, unknown>;
	} catch {
		throw new Fail(`gh pr view ${pr} -R ${ownerRepo} did not return json`, START_EXIT.failed);
	}
	if (typeof v.number !== "number" || typeof v.state !== "string" || typeof v.headRefOid !== "string" || typeof v.headRefName !== "string" ||
		typeof v.baseRefName !== "string" || typeof v.isCrossRepository !== "boolean") {
		throw new Fail(`gh pr view ${pr} -R ${ownerRepo} returned an unexpected shape`, START_EXIT.failed);
	}
	if (v.number !== pr) throw new Fail(`gh pr view ${pr} answered for PR #${v.number}`, START_EXIT.failed);
	return v as unknown as PrView;
}

function ghPrView(ownerRepo: string, pr: number): PrView {
	const r = spawnSync(ghPrViewArgv(ownerRepo, pr), { stdout: "pipe", stderr: "pipe", timeout: GH_PR_VIEW_TIMEOUT_MS });
	const failed = r.exitCode === 0 ? null : r.exitedDueToTimeout ? "timed out" : r.stderr.toString().trim().split("\n").at(-1) || `exit ${r.exitCode}`;
	return prViewOf(ownerRepo, pr, failed, r.stdout.toString());
}

/** `ghPrView` without blocking the event loop (the runner's heartbeat timer keeps firing; the batch starter's views run side by side), with the same env: this process's own. */
async function ghPrViewAsync(ownerRepo: string, pr: number, cwd: string): Promise<PrView> {
	const r = await run(ghPrViewArgv(ownerRepo, pr), { cwd, env: process.env, timeoutMs: GH_PR_VIEW_TIMEOUT_MS });
	const failed = r.code === 0 ? null : r.code === null ? "timed out or killed" : r.err.split("\n").at(-1) || `exit ${r.code}`;
	return prViewOf(ownerRepo, pr, failed, r.out);
}

/** A fresh run id: `makeRunId` with lowercase base-36 entropy (a run, a batch, an attribution, a sub-run). */
const newRunId = (): string => makeRunId(Date.now(), Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""));

/** `run <runId>` spawned detached, its output to `<run dir>/runner.log`, its pid in runner.json. */
function spawnRunner(root: string, runId: string): { pid: number; log: string } {
	const runDir = runDirOf(root, runId);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const log = join(runDir, "runner.log");
	const fd = openSync(log, "a", 0o600);
	let pid: number;
	try {
		const child = spawn([process.execPath, import.meta.path, "run", runId], { cwd: runDir, env: process.env, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
		child.unref();
		pid = child.pid;
	} finally {
		closeSync(fd);
	}
	writeFileSync(join(runDir, "runner.json"), `${JSON.stringify({ pid, pgid: pid, runId })}\n`, { mode: 0o600 });
	return { pid, log };
}

/** The caps the wrapper reads from `<stage dir>/caps.json` (0640). */
function writeCaps(stage: string, config: TestRunnerConfig): void {
	const caps = join(stage, "caps.json");
	writeFileSync(caps, `${JSON.stringify({ fullCapMin: config.fullCapMin, soloCapMin: config.soloCapMin })}\n`, { mode: 0o640 });
	chmodSync(caps, 0o640);
}

/** Test only: AGENT_SYSTEM_TEST_RUNNER_CRASH_AT names a step of the red batch's handoff where the run SIGKILLs itself (plan wl-mv615mkeaf1yio § 4, crash windows). */
function crashAt(point: "after-result" | "after-admit"): void {
	if (process.env.AGENT_SYSTEM_TEST_RUNNER_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
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
 * The starter's PR checks (§ 2.2 steps 1–2), shared by `start` and the backstop's re-request: the
 * workload open, the PR open, same repo, on a branch the workload is bound to or a number Jo bound to
 * it with `test-pr`. Returns Jo's instruction when only that binding admitted the PR; refusals throw.
 */
function admissiblePr(ledger: Ledger, wl: string, view: PrView): { boundBy: string | null } {
	const w = ledger.workload(wl);
	if (!w || w.status !== "open") throw new Fail(`no open workload ${wl}`, START_EXIT.refused);
	const entries = ledger.entries(wl);
	const bound = boundBranches(wl, entries, holdersOf(entries, w.holder, ledger.holders(wl)));
	const jo = boundPrs(entries, ledger.instructions(wl));
	const admissible = prAdmissible(view, bound, jo.map((b) => b.pr));
	if (!admissible.ok) throw new Fail(admissible.reason, START_EXIT.refused);
	// Admitted only through Jo's `test-pr` binding: the starter's line names the instruction, so every such run is traceable to it.
	return { boundBy: bound.includes(view.headRefName) ? null : (jo.find((b) => b.pr === view.number)?.instructionId ?? null) };
}

/**
 * The request's ledger half (§ 2.2 step 3), called inside a ledger write by `start` and by the
 * backstop's re-request: the reservation (refused while a run is live on the workload), the named
 * slice open or the full-suite slice added, dead runs settled, then `test-requested:`. Returns the slice.
 */
function writeRequest(ledger: Ledger, wl: string, root: string, o: { runId: string; pr: number; sha: string; sliceArg: string | null; by: string }): string {
	const now = Date.parse(ledger.now());
	const res = reservation(testRuns(ledger.entries(wl)), (id) => heartbeatOf(root, id), now);
	if (!res.ok) {
		const live = res.live.request;
		throw new Fail(`run ${live.runId} (PR #${live.pr}, slice ${live.slice}) is live on ${wl}; its test-run: settles it`, START_EXIT.refused);
	}
	let sl: string;
	if (o.sliceArg !== null) {
		const s = ledger.slice(o.sliceArg);
		if (!s || s.workload_id !== wl) throw new Fail(`no slice ${o.sliceArg} on ${wl}`, START_EXIT.refused);
		if (s.state !== "open") throw new Fail(`slice ${o.sliceArg} is ${s.state}, not open`, START_EXIT.refused);
		sl = s.id;
	} else {
		const f = fullSuiteSlice(wl, o.pr, ledger.slices(wl).map((s) => s.id));
		sl = ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: wl, id: f.id, task: f.task, doneCondition: f.doneCondition, inputs: `PR #${o.pr} at ${o.sha}` });
	}
	for (const d of res.settleDead) {
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: d.request.slice, kind: "assumption", body: testRunBody(runnerDiedRun(d.request, runDirOf(root, d.request.runId))) });
	}
	ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId: o.runId, pr: o.pr, sha: o.sha, slice: sl, by: o.by }) });
	return sl;
}

function cmdStart(wl: string, pr: number, sliceArg: string | null, by: string): number {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w || w.status !== "open") throw new Fail(`no open workload ${wl}`, START_EXIT.refused);
	const config = loadConfig();
	const { ownerRepo } = servedOf(ledger, wl, config);
	const view = ghPrView(ownerRepo, pr);
	const { boundBy } = admissiblePr(ledger, wl, view);

	const root = runsRoot(process.env);
	const runId = newRunId();
	const runDir = runDirOf(root, runId);
	// Admission (plan wl-mv615mkeaf1yio § 2): the run's place in the lock queue commits before its request is written.
	const lockDb = openLockDb(root);
	const leave = (): void => {
		try {
			withdraw(lockDb, runId);
		} catch (e) {
			process.stderr.write(`test-runner start: the admission of ${runId} was not removed: ${errText(e)}\n`);
		}
	};
	try {
		admit(lockDb, runId);
		let slice: string;
		try {
			slice = ledger.write(() => writeRequest(ledger, wl, root, { runId, pr, sha: view.headRefOid, sliceArg, by }));
		} catch (e) {
			// Refused or failed: no request, so no place in the queue.
			leave();
			throw e;
		}

		try {
			const { pid, log } = spawnRunner(root, runId);
			process.stdout.write(`test-run ${runId} runner ${pid} sha ${view.headRefOid} slice ${slice} log ${log}${boundBy ? ` bound-by ${boundBy}` : ""}\n`);
			return START_EXIT.ok;
		} catch (e) {
			const reason = `the runner did not start: ${errText(e)}`;
			leave();
			try {
				recordError(ledger, wl, { runId, pr, sha: view.headRefOid, slice, by }, runDir, reason);
			} catch (e2) {
				process.stderr.write(`test-runner start: the failure could not be recorded: ${errText(e2)}\n`);
			}
			throw new Fail(reason, START_EXIT.failed);
		}
	} finally {
		lockDb.close();
	}
}

/**
 * The batch starter (plan wl-mv615mkeaf1yio § 4), exec'd by the surface for Jo's word: Jo's
 * instruction and the surface entry naming it, each PR's view from gh and its own workload's runs
 * (`batchAdmissible`), then `requestBatch` with the same views, then the detached run. The views are
 * read concurrently, so the surface's deadline on the starter bounds the slowest one, not their sum.
 */
async function cmdStartBatch(wl: string, instructionId: string): Promise<number> {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w || w.status !== "open") throw new Fail(`no open workload ${wl}`, START_EXIT.refused);
	const asked = batchInstruction(wl, instructionId, ledger.instructions(wl), ledger.entries(wl));
	if (!asked.ok) throw new Fail(asked.reason, START_EXIT.refused);
	const config = loadConfig();
	const { ownerRepo } = servedOf(ledger, wl, config);
	const views = await Promise.all(asked.prs.map((n) => ghPrViewAsync(ownerRepo, n, process.cwd())));
	const admissible = batchAdmissible(batchItems(ledger, views));
	if (!admissible.ok) throw new Fail(admissible.reason, START_EXIT.refused);

	const root = runsRoot(process.env);
	const runId = newRunId();
	const lockDb = openLockDb(root);
	try {
		const { slice, prs } = requestBatch(ledger, lockDb, root, wl, instructionId, runId, views);
		try {
			const { pid, log } = spawnRunner(root, runId);
			process.stdout.write(`test-batch ${runId} runner ${pid} prs ${prs.map((p) => `#${p.pr}@${p.sha.slice(0, 7)}`).join(",")} slice ${slice} log ${log}\n`);
			return START_EXIT.ok;
		} catch (e) {
			const reason = `the runner did not start: ${errText(e)}`;
			leaveBatchQueue(lockDb, runId);
			try {
				recordBatchError(ledger, { kind: "batch", workloadId: wl, request: { runId, prs, slice, by: "jo" } }, runDirOf(root, runId), reason);
			} catch (e2) {
				process.stderr.write(`test-runner start-batch: the failure could not be recorded: ${errText(e2)}\n`);
			}
			throw new Fail(reason, START_EXIT.failed);
		}
	} finally {
		lockDb.close();
	}
}

/** `batchAdmissible`'s input: each PR's gh view with the runs of the workload its head branch names, as the ledger holds them now (null when it names none the ledger has). */
function batchItems(ledger: Ledger, views: readonly PrView[]) {
	return views.map((view) => {
		const own = ownWorkloadOf(view.headRefName);
		return { view, records: own !== null && ledger.workload(own) ? testRuns(ledger.entries(own)) : null };
	});
}

/** A batch start that will not run removes its admission; a removal that fails is said on stderr. */
function leaveBatchQueue(lockDb: Database, runId: string): void {
	try {
		withdraw(lockDb, runId);
	} catch (e) {
		process.stderr.write(`test-runner start-batch: the admission of ${runId} was not removed: ${errText(e)}\n`);
	}
}

/**
 * The batch starter's admission and request (plan wl-mv615mkeaf1yio § 4), in the part-2 order: the
 * place in the queue commits first; then one ledger transaction re-checks Jo's instruction
 * (`batchInstruction`: one instruction starts one batch, so a concurrent starter that passed the
 * early check finds the other's `test-batch-requested:` here and is refused; review r1 finding 3)
 * and each PR's admission (`batchAdmissible` on the starter's gh `views`, no gh call here, against
 * its own workload's runs read in this transaction: a run requested or a red written there since
 * the early check refuses the batch; review r2 finding 2), settles every earlier batch on the
 * workload whose runner died as `runner died`, adds the batch slice and writes
 * `test-batch-requested:`. A refusal or failure there removes the admission. Returns the slice and
 * the pinned PRs.
 */
export function requestBatch(ledger: Ledger, lockDb: Database, root: string, wl: string, instructionId: string, runId: string, views: readonly PrView[]): { slice: string; prs: BatchPr[] } {
	admit(lockDb, runId);
	try {
		return ledger.write(() => {
			const asked = batchInstruction(wl, instructionId, ledger.instructions(wl), ledger.entries(wl));
			if (!asked.ok) throw new Fail(asked.reason, START_EXIT.refused);
			const admissible = batchAdmissible(batchItems(ledger, views));
			if (!admissible.ok) throw new Fail(admissible.reason, START_EXIT.refused);
			const prs = admissible.prs;
			// The reservation's settle (§ 2.2 step 3) for batches: every earlier batch on this workload whose runner died gets its `error runner died` row and line, and its open slice settles on it.
			for (const d of deadBatches(ledger.entries(wl), (id) => heartbeatOf(root, id), Date.parse(ledger.now()))) {
				recordBatchError(ledger, { kind: "batch", workloadId: wl, request: d }, runDirOf(root, d.runId), "runner died");
			}
			const f = batchSlice(wl, asked.prs, ledger.slices(wl).map((s) => s.id));
			const sl = ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: wl, id: f.id, task: f.task, doneCondition: f.doneCondition, inputs: `instruction ${instructionId}; ${prs.map((p) => `PR #${p.pr} at ${p.sha}`).join(", ")}` });
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testBatchRequestedBody({ runId, prs: [...prs], slice: sl, by: "jo" }) });
			return { slice: sl, prs };
		});
	} catch (e) {
		leaveBatchQueue(lockDb, runId);
		throw e;
	}
}

/**
 * A batch or an attribution that cannot run (no runner spawned, no profile to run under, its runner died) gets its `error` row and the orchestrator its line;
 * a batch's still-open slice settles on that row in the same write (a refused settle leaves the row and the line standing).
 */
function recordBatchError(ledger: Ledger, found: Extract<Found, { kind: "batch" | "attribution" }>, runDir: string, reason: string): void {
	const wl = found.workloadId;
	ledger.write(() => {
		let runId: string;
		let text: string;
		let slice: string | null = null;
		if (found.kind === "batch") {
			const q = found.request;
			const run: TestBatchRun = { ...batchRunnerDiedRun(q, runDir), reason };
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: q.slice, kind: "assumption", body: testBatchRunBody(run) });
			if (ledger.slice(q.slice)?.state === "open") {
				try {
					ledger.completeSlice(q.slice, { by: TEST_RUNNER_BY, artifact: batchSettleArtifact(run) });
				} catch (e) {
					process.stderr.write(`test-runner: the settle of ${q.slice} on ${q.runId}'s error was refused: ${errText(e)}\n`);
				}
			}
			[runId, text, slice] = [q.runId, batchResultText(run), q.slice];
		} else {
			const a: TestBatchAttribution = { runId: found.runId, batch: found.batch.runId, outcome: { kind: "error", reason: oneLine(reason), probes: [] } };
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchAttributionBody(a) });
			[runId, text] = [a.runId, `attribution of batch ${a.batch}: ${attributionText(a.outcome)}`];
		}
		ledger.enqueue({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: testBatchResultBody({ workloadId: wl, runId, text }) });
	});
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---- run --------------------------------------------------------------------------------------------

/** What `run <run id>` runs: a single-PR run, a batch, or a batch's attribution (plan wl-mv615mkeaf1yio § 4), and its workload. */
type Found =
	| { kind: "single"; workloadId: string; request: TestRequested }
	| { kind: "batch"; workloadId: string; request: TestBatchRequested }
	| { kind: "attribution"; workloadId: string; runId: string; batch: TestBatchRun };

/** The runner's entry naming `runId`: its `test-requested:`, its `test-batch-requested:`, or the red `test-batch-run:` that handed off to it. */
function findRunSubject(ledger: Ledger, runId: string): Found | null {
	const like = (pattern: string) => ledger.db.query<{ workload_id: string; body: string }, [string, string]>(
		"SELECT workload_id, body FROM entries WHERE kind = 'assumption' AND created_by = ? AND body LIKE ? ORDER BY created_at, rowid",
	).all(TEST_RUNNER_BY, pattern);
	for (const r of like(`test-requested: ${runId} %`)) {
		const req = parseTestRequested(r.body);
		if (req && req.runId === runId) return { kind: "single", workloadId: r.workload_id, request: req };
	}
	for (const r of like(`test-batch-requested: ${runId} %`)) {
		const req = parseTestBatchRequested(r.body);
		if (req && req.runId === runId) return { kind: "batch", workloadId: r.workload_id, request: req };
	}
	for (const r of like(`test-batch-run: % "attribution":"${runId}"%`)) {
		const batch = parseTestBatchRun(r.body);
		if (batch && batch.attribution === runId) return { kind: "attribution", workloadId: r.workload_id, runId, batch };
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

/** One command, stdout verbatim: never trimmed, since NUL-delimited output (`git diff -z`) may begin or end with a path's own whitespace. */
async function run(cmd: string[], o: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): Promise<{ code: number | null; out: string; err: string }> {
	const p = spawn(cmd, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs);
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	await p.exited;
	clearTimeout(timer);
	return { code: p.exitCode, out, err: err.trim() };
}

/**
 * The doc-only main-merge rule's facts (plan wl-mv615mkeaf1yio § 3), read from the trusted clone at
 * `repo` with the trusted env: origin/main (`main`) as fetched, H's parents, then, for a two-parent
 * H, whether P2 is on `main`'s first-parent chain and `git merge-base --all P1 P2`, then, for a
 * single merge base B, the five `--no-renames --name-only -z` lists. A git failure is the run's
 * error; `git merge-base --all` exiting 1 (no common ancestor) is no merge base.
 */
export async function gatherMergeFacts(repo: string, env: Record<string, string>, head: string, main: string): Promise<MergeFacts> {
	const git = async (args: string[], what: string, codes: readonly number[] = [0]): Promise<string> => {
		const r = await run(["git", ...NO_HOOKS, ...args], { cwd: repo, env, timeoutMs: 120_000 });
		if (r.code === null || !codes.includes(r.code)) throw new Stop(`${what} failed: ${r.err.split("\n").at(-1) || `exit ${r.code}`}`);
		return r.out;
	};
	const tip = (await git(["rev-parse", "--verify", `${main}^{commit}`], "reading origin/main")).trim();
	const parents = (await git(["rev-list", "--parents", "-n", "1", head], "reading the head's parents")).trim().split(" ").slice(1);
	if (parents.length !== 2) return { parents, tip, mainOnChain: null, mergeBases: null, diffs: null };
	const [p1, p2] = parents as [string, string];
	const mainOnChain = (await git(["rev-list", "--first-parent", main], "git rev-list --first-parent")).split("\n").includes(p2);
	const mergeBases = (await git(["merge-base", "--all", p1, p2], "git merge-base --all", [0, 1])).split("\n").filter((l) => l !== "");
	if (mergeBases.length !== 1) return { parents, tip, mainOnChain, mergeBases, diffs: null };
	const b = mergeBases[0]!;
	const names = async (from: string, to: string): Promise<string[]> =>
		(await git(["diff", "--no-renames", "--name-only", "-z", from, to], `git diff ${from.slice(0, 7)}..${to.slice(0, 7)}`)).split("\0").filter((p) => p !== "");
	return { parents, tip, mainOnChain, mergeBases, diffs: { baseP1: await names(b, p1), baseP2: await names(b, p2), p1p2: await names(p1, p2), p1h: await names(p1, head), p2h: await names(p2, head) } };
}

/** The committer of the batch's merge commits (no global config in the trusted env). */
const BATCH_IDENTITY = {
	GIT_AUTHOR_NAME: "agent-system test-runner", GIT_AUTHOR_EMAIL: "test-runner@agent-system.invalid",
	GIT_COMMITTER_NAME: "agent-system test-runner", GIT_COMMITTER_EMAIL: "test-runner@agent-system.invalid",
};

/**
 * The batch's merges (plan wl-mv615mkeaf1yio § 4) in the trusted clone at `repo`: detached at M0
 * (step 0), then `git merge --no-ff` of each PR head in Jo's order, each step named
 * `refs/heads/as2-batch-<k>` (a branch, so `git remote remove origin` keeps it and the bundle
 * carries it). A merge that conflicts (exit 1) is aborted and its 1-based step returned with the
 * steps before it; any other git failure is the run's error.
 */
export async function buildBatch(repo: string, env: Record<string, string>, m0: string, heads: readonly string[]): Promise<{ steps: BatchStep[]; conflict: number | null }> {
	const genv = { ...env, ...BATCH_IDENTITY };
	const git = async (args: string[], what: string, codes: readonly number[] = [0]): Promise<{ code: number; out: string }> => {
		const r = await run(["git", ...NO_HOOKS, ...args], { cwd: repo, env: genv, timeoutMs: 600_000 });
		if (r.code === null || !codes.includes(r.code)) throw new Stop(`${what} failed: ${r.err.split("\n").at(-1) || `exit ${r.code}`}`);
		return { code: r.code, out: r.out.trim() };
	};
	const steps: BatchStep[] = [];
	const step = async (k: number): Promise<void> => {
		const [commit, tree] = (await git(["rev-parse", "HEAD", "HEAD^{tree}"], `reading step ${k}`)).out.split("\n") as [string, string];
		await git(["update-ref", `refs/heads/as2-batch-${k}`, commit], `naming step ${k}`);
		steps.push({ commit, tree });
	};
	await git(["checkout", "-q", "--detach", m0], "checking out origin/main");
	await step(0);
	for (const [i, sha] of heads.entries()) {
		const m = await git(["merge", "--no-ff", "--no-edit", "-q", sha], `merging step ${i + 1}`, [0, 1]);
		if (m.code === 1) {
			await git(["merge", "--abort"], `aborting the merge of step ${i + 1}`);
			return { steps, conflict: i + 1 };
		}
		await step(i + 1);
	}
	return { steps, conflict: null };
}

/**
 * The attribution's first check (plan wl-mv615mkeaf1yio § 4): the bundle it was handed still holds
 * every step the batch recorded, each commit with its recorded tree. A bare clone into `dir`
 * (removed after); null when every step holds, else what did not.
 */
export async function verifyBundleSteps(bundle: string, dir: string, env: Record<string, string>, steps: readonly BatchStep[]): Promise<string | null> {
	try {
		const c = await run(["git", ...NO_HOOKS, "clone", "-q", "--bare", bundle, dir], { cwd: dirname(dir), env, timeoutMs: 600_000 });
		if (c.code !== 0) return `git clone of ${bundle} failed: ${c.err.split("\n").at(-1) || `exit ${c.code}`}`;
		for (const [k, s] of steps.entries()) {
			const r = await run(["git", ...NO_HOOKS, "rev-parse", "--verify", "-q", `${s.commit}^{tree}`], { cwd: dir, env, timeoutMs: 60_000 });
			if (r.code !== 0) return `step ${k} (${s.commit.slice(0, 7)}) is not in the bundle`;
			const tree = r.out.trim();
			if (tree !== s.tree) return `step ${k} has tree ${tree.slice(0, 7)}, not the recorded ${s.tree.slice(0, 7)}`;
		}
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

type Wrapped = { code: number | null; signal: string | null; out: string };

/**
 * One run that holds the lock: the queue wait, the heartbeat, the checkpoints, the wrapper calls and
 * retention, shared by a single-PR run, a batch and an attribution. The lock row and the heartbeat
 * carry `id` throughout; `subject` is the run id the wrapper calls and `current` name, which an
 * attribution moves to each probe's sub-run (plan wl-mv615mkeaf1yio § 4) and back.
 */
abstract class LockedRun {
	readonly root = runsRoot(process.env);
	readonly runDir: string;
	readonly as2root = process.env.AGENT_SYSTEM_TEST_RUNNER_ROOT || AS2TEST_ROOT;
	readonly install = installSpec();
	readonly exec = join(this.install.libexec, "exec");
	protected repo = "";
	protected url = "";
	protected ownerRepo = "";
	readonly stageRoot: string;
	readonly lockDb: Database;
	readonly capBytes: number;
	/** The run id the wrapper calls and `current` name: `id`, or an attribution's probe sub-run. */
	protected subject: string;
	private timer: Timer | undefined;
	/** The run took the lock row at some point. */
	protected held = false;
	/** The run learnt it no longer holds the row (heartbeat or checkpoint) or its request. */
	protected superseded: string | null = null;
	private soloCalls = 0;
	/** The run-level failure (lock wait, preflight, a phase, the wrapper), else null. */
	protected error: string | null = null;
	protected preflightNote: string | null = null;

	constructor(readonly ledger: Ledger, readonly wl: string, readonly id: string, readonly config: TestRunnerConfig) {
		this.runDir = runDirOf(this.root, id);
		this.stageRoot = join(this.as2root, "stage");
		this.lockDb = openLockDb(this.root);
		this.capBytes = reportCapBytes(config);
		this.subject = id;
	}

	get stage(): string {
		return stageDirOf(this.subject, this.as2root);
	}

	get workDir(): string {
		return workDirOf(this.subject, this.as2root);
	}

	/** Where the subject's reports are imported: the run dir, or the probe sub-run's own run dir. */
	get partDir(): string {
		return runDirOf(this.root, this.subject);
	}

	/** Whether the run still owns what it was started for (a single run's request); checked at each lock poll. */
	protected abstract stillWanted(): boolean;
	protected abstract body(): Promise<void>;
	/** The result rows, written while the lock row is read in the same transaction; then result.json. */
	protected abstract finish(): void;

	log(s: string): void {
		process.stdout.write(`${new Date().toISOString()} ${s}\n`);
	}

	protected served(): void {
		({ url: this.url, repo: this.repo, ownerRepo: this.ownerRepo } = servedOf(this.ledger, this.wl, this.config));
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

	protected lose(why: string): void {
		if (!this.superseded) {
			this.superseded = why;
			this.log(`superseded: ${why}`);
		}
	}

	/** The lock row as `finish` reads it: null while this run holds it, else why not. */
	protected lockLost(lockMine: boolean): string | null {
		return this.superseded ?? (lockMine ? null : `the lock row holds ${lockRow(this.lockDb)?.runId ?? "no run"}`);
	}

	/** `write(lockMine)` inside a BEGIN IMMEDIATE on runs.db for a run that held the lock, so no takeover lands in between; else directly. */
	protected underLock<T>(write: (lockMine: boolean) => T): T {
		return this.held ? busyLoop(() => this.lockDb.transaction(() => write(lockRow(this.lockDb)?.runId === this.id)).immediate()) : write(true);
	}

	/** The PR a queued run watches for MERGED or CLOSED (a single run's), else null: a batch or an attribution watches none. */
	protected watchedPr(): number | null {
		return null;
	}

	/**
	 * Wait for the lock in request order (plan wl-mv615mkeaf1yio § 2): each poll is one `tryAcquire`,
	 * which takes the lock clean or from a stale holder only for the queue head and publishes `current`
	 * in that same transaction. A queued run is dropped only by Jo's rule (`queueWaitDecision`): its
	 * request superseded (withdrawn at its next poll), its watched PR read MERGED or CLOSED (read at
	 * most every PR_CHECK_EVERY_MS, off the heartbeat's path; an unread state keeps it waiting), or the
	 * `queueMaxMin` backstop (`Backstop`).
	 */
	async acquire(): Promise<void> {
		await hook(this.id, "before-acquire");
		const waitStart = Date.now();
		const pollMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_POLL_MS", 2_000);
		const checkMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_PR_CHECK_MS", PR_CHECK_EVERY_MS);
		const pr = this.watchedPr();
		let checkedAt = waitStart;
		let prState: string | null = null;
		mkdirSync(this.stageRoot, { recursive: true });
		const me: Claimant = { runId: this.id, pid: process.pid, runDir: this.runDir };
		for (;;) {
			if (!this.stillWanted()) throw new Superseded("the request was superseded while the run was queued");
			let took: { displaced: string | null } | null = null;
			try {
				took = tryAcquire(this.lockDb, this.stageRoot, me, (id) => heartbeatOf(this.root, id));
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
			if (pr !== null && Date.now() - checkedAt >= checkMs) {
				checkedAt = Date.now();
				try {
					prState = (await ghPrViewAsync(this.ownerRepo, pr, this.runDir)).state;
				} catch (e) {
					prState = null;
					this.log(`PR #${pr}'s state was not read (${errText(e)}); the run keeps waiting`);
				}
				hookMark(this.id, "pr-state", { state: prState });
			}
			const wait = queueWaitDecision({ waitedMs: Date.now() - waitStart, pr, prState, config: this.config });
			if (wait.act === "superseded") throw new Superseded(wait.reason);
			if (wait.act === "backstop") throw new Backstop(wait.reason);
			hookMark(this.id, "queued");
			await Bun.sleep(pollMs);
		}
	}

	/**
	 * Before each phase and wrapper call (§ 2.3 step 1, losing the lock): the row still holds this
	 * run, and `current` is (re)published under that check, naming the subject (`publishSub` for a
	 * probe sub-run, the lock row unchanged).
	 */
	async checkpoint(phase: string): Promise<void> {
		await hook(this.id, `phase-${phase}`);
		if (this.superseded) throw new Superseded(this.superseded);
		const published = this.subject === this.id
			? publishIfOwner(this.lockDb, this.stageRoot, this.id)
			: publishSub(this.lockDb, this.stageRoot, this.id, this.subject);
		if (!published) {
			this.lose(`the lock row holds ${lockRow(this.lockDb)?.runId ?? "no run"}`);
			throw new Superseded(this.superseded!);
		}
	}

	/**
	 * One wrapper call: `sudo -n -u _as2test <exec> <sub> <run id> …` (wrapperArgv). Its stderr goes to runner.log; stdout is captured and echoed there.
	 * It starts in the as2test root, which `_as2test` can read: the run dir is Jo's 0700 dir, and a cwd the child cannot read kills bun on getcwd.
	 */
	async wrap(call: WrapperCall, capMs: number | null = null): Promise<Wrapped> {
		const argv = wrapperArgv(call, this.exec);
		const p = spawn(argv, { cwd: this.as2root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
		hookMark(this.id, `spawn-${call.sub}`, { pid: p.pid });
		let outlived = false;
		const watchdog = capMs === null ? null : setTimeout(() => {
			outlived = true;
			this.log(`${call.sub} outlived its cap by ${OUTLIVE_MS / 1000} s; sweeping`);
			void this.wrap({ sub: "sweep", runId: call.runId }).catch((e) => this.log(`the outlive sweep failed: ${errText(e)}`));
		}, capMs + OUTLIVE_MS);
		const out = await new Response(p.stdout).text();
		await p.exited;
		clearTimeout(watchdog ?? undefined);
		if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
		const r = { code: p.exitCode, signal: p.signalCode ?? null, out };
		this.log(`${argv.slice(4).join(" ")} → ${r.signal ?? `exit ${r.code}`}${outlived ? " (after the outlive sweep)" : ""}`);
		return r;
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
			const r = await this.wrap({ sub: "sweep", runId: this.subject });
			if (r.code === WRAPPER_EXIT.ok) return;
			if (r.code === WRAPPER_EXIT.fenced) await this.fenced("the sweep");
			if (r.signal !== null && attempt < SWEEP_RETRIES) {
				this.log(`the sweep after ${after} ended by ${r.signal}; retry ${attempt + 1} of ${SWEEP_RETRIES}`);
				continue;
			}
			if (r.code === WRAPPER_EXIT.sweepLockHeld) throw new Stop("sweep lock held");
			throw new Stop(r.signal !== null
				? `the sweep after ${after} ended by ${r.signal} ${attempt + 1} times; its ${SWEEP_RETRIES} retries are spent`
				: `the sweep after ${after} failed: exit ${r.code}`);
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
			this.preflightNote = `preflight: ${reason}`;
			throw new Stop(this.preflightNote);
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
		const r = await this.wrap(probeCall(this.subject, items));
		if (r.code === WRAPPER_EXIT.fenced) await this.fenced("the probe");
		const v = preflightDecision(install, probeDecision(items, r.signal !== null ? null : r.code, r.out));
		this.preflightNote = v.ok ? v.summary : v.reason;
		if (!v.ok) throw new Stop(v.reason);
	}

	/**
	 * Retention (§ 2.3 step 9): the newest KEEP_RUNS stay whole; older ones lose their stage dir, their
	 * work dir (fenced `cleanup`) and the run dir's scratch files. A run still live in the queue keeps
	 * everything, whatever its age: an attribution handed its bundle waits there (plan
	 * wl-mv615mkeaf1yio § 4).
	 */
	async retention(): Promise<void> {
		const ids = new Set<string>([this.id]);
		for (const dir of [this.root, this.stageRoot, join(this.as2root, "runs")]) {
			try {
				for (const n of readdirSync(dir)) if (RUN_ID_RE.test(n)) ids.add(n);
			} catch {
				// a root that does not exist yet holds no runs
			}
		}
		const now = Date.now();
		const liveQueued = new Set(queueRows(this.lockDb)
			.filter((q) => runLive({ settled: false, requestedAtMs: q.admittedAt, heartbeatAtMs: heartbeatOf(this.root, q.runId) }, now))
			.map((q) => q.runId));
		const at = (id: string): number => parseInt(id.slice(3, 12), 36) || 0;
		const prune = pruneRuns([...ids].map((id) => ({ id, at: at(id) })), KEEP_RUNS, liveQueued).filter((id) => id !== this.id);
		for (const old of prune) {
			rmSync(stageDirOf(old, this.as2root), { recursive: true, force: true });
			if (existsSync(workDirOf(old, this.as2root))) {
				await this.checkpoint("cleanup");
				const r = await this.wrap({ sub: "cleanup", runId: this.subject, oldRunId: old });
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

	/** The trusted phase's git env: a fresh empty global config in the run dir. */
	protected trustedGit(): Record<string, string> {
		const gitconfig = join(this.runDir, "trusted.gitconfig");
		writeFileSync(gitconfig, "", { mode: 0o600 });
		return trustedEnv(gitconfig);
	}

	async prepare(sha: string): Promise<void> {
		await this.checkpoint("prepare");
		const r = await this.wrap({ sub: "prepare", runId: this.subject, sha });
		if (r.code === WRAPPER_EXIT.fenced) await this.fenced("prepare");
		if (r.code !== WRAPPER_EXIT.ok) throw new Stop(`prepare failed: ${r.signal ?? `exit ${r.code}`}`);
	}

	/** One part through the wrapper, then its junit and log imported into the subject's run dir and read into a result. */
	async part(call: { sub: "full" } | { sub: "solo"; file: string }): Promise<PartResult> {
		await this.checkpoint(call.sub === "full" ? "full" : "solo");
		const capMs = (call.sub === "full" ? this.config.fullCapMin : this.config.soloCapMin) * 60_000;
		const started = Date.now();
		const r = await this.wrap(call.sub === "full" ? { sub: "full", runId: this.subject } : { sub: "solo", runId: this.subject, file: call.file }, capMs);
		const ms = Date.now() - started;
		if (r.code === WRAPPER_EXIT.fenced) await this.fenced(call.sub);
		let name = "full";
		if (call.sub === "solo") {
			this.soloCalls++;
			name = /^part (solo-\d+)$/m.exec(r.out)?.[1] ?? `solo-${this.soloCalls}`;
		}
		if (r.code === WRAPPER_EXIT.refused || r.code === WRAPPER_EXIT.failed) {
			return { ...partResult({ junit: null, log: null, exit: r.code, ms }), error: `the wrapper ${r.code === WRAPPER_EXIT.refused ? "refused" : "failed"} ${call.sub} (exit ${r.code})` };
		}
		const imported = importPart(this.workDir, this.partDir, name, this.capBytes);
		return partResult({ ...imported, exit: r.signal !== null ? null : r.code, ms, timedOut: r.code === WRAPPER_EXIT.timeout, maxBytes: this.capBytes });
	}

	/** `git ls-remote <origin> refs/pull/<N>/head` with the trusted settings (§ 2.3 step 5); null when it cannot answer. */
	async headNow(pr: number): Promise<string | null> {
		const r = await run(["git", ...NETWORK, "ls-remote", this.url, `refs/pull/${pr}/head`], {
			cwd: this.runDir, env: trustedEnv(join(this.runDir, "trusted.gitconfig")), timeoutMs: 120_000,
		});
		if (r.code !== 0) {
			this.log(`ls-remote failed: ${r.err.split("\n").at(-1) || `exit ${r.code}`}`);
			return null;
		}
		return new RegExp(`^([0-9a-f]{40})\\trefs/pull/${pr}/head$`, "m").exec(r.out)?.[1] ?? null;
	}

	async main(): Promise<number> {
		try {
			mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
			this.beat();
			this.timer = setInterval(() => this.beat(), msEnv("AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS", HEARTBEAT_EVERY_MS));
			try {
				await this.body();
			} catch (e) {
				if (e instanceof Superseded) this.lose(e.message);
				else if (e instanceof Stop) this.error = e.message;
				else if (e instanceof Fail) this.error = e.message;
				else this.error = `the runner failed: ${errText(e)}`;
				if (!(e instanceof Superseded)) this.log(`stopped: ${this.error}`);
			}
			this.subject = this.id;
			await hook(this.id, "result");
			this.finish();
			return 0;
		} finally {
			clearInterval(this.timer);
			// The run lock goes even when a refresh helper this run started may outlive it (installCheck's `live`):
			// releasing it proves nothing about that helper. Refreshes are serialised by the helper's own lockf lock
			// on refresh.d/lock, which the next run's refresh waits on (exit 69, lock, while the old helper holds it).
			if (this.held) {
				try {
					busyLoop(() => this.lockDb.query("DELETE FROM lock WHERE runId = ?").run(this.id));
				} catch (e) {
					this.log(`the lock was not released: ${errText(e)}`);
				}
			}
			// Every exit leaves the queue: a run that never took the lock (the backstop, its PR merged or closed, an error or a superseded request first) still holds its admission.
			try {
				withdraw(this.lockDb, this.id);
			} catch (e) {
				this.log(`the admission was not removed: ${errText(e)}`);
			}
			this.lockDb.close();
		}
	}
}

/** A single run's written result: the `test-run:` record, and the settle's outcome (null when the decision did not settle). */
interface RunWritten {
	run: TestRun;
	settled: { ok: true } | { ok: false; reason: string } | null;
}

/** A single PR's run (§ 2.3): its head alone, the full suite (or the doc-merge rule), then each changed test file alone. */
class Runner extends LockedRun {
	private readonly f: Omit<RunFacts, "error" | "owner" | "sliceState"> & { base: string | null; mergeBase: string | null };
	/** Set at the backstop: the PR's view the re-request starts from, or why gh could not give it. */
	private backstopView: PrView | string | null = null;

	constructor(ledger: Ledger, wl: string, readonly request: TestRequested, config: TestRunnerConfig) {
		super(ledger, wl, request.runId, config);
		this.f = {
			requestedSha: request.sha, fetchedSha: null, full: null, solo: [], headAtStart: request.sha, headAtEnd: null,
			base: null, mergeBase: null, mode: "full", basis: null, merge: null,
		};
	}

	protected stillWanted(): boolean {
		return ownsRequest(testRuns(this.ledger.entries(this.wl)), this.id);
	}

	protected watchedPr(): number | null {
		return this.request.pr;
	}

	/** The trusted phase (§ 2.3 step 2): clone, fetch, the sha check, checkout, base, changed files, the bundle. Null when the fetched head is not the requested sha. */
	async trusted(): Promise<string[] | null> {
		await this.checkpoint("trusted");
		const repo = join(this.stage, "repo");
		rmSync(this.stage, { recursive: true, force: true });
		mkdirSync(repo, { recursive: true, mode: 0o750 });
		const env = this.trustedGit();
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
		// The doc-only main-merge rule (plan wl-mv615mkeaf1yio § 3), decided here from this clone and the runner's own records, before origin goes.
		const merge = docMergeDecision(await gatherMergeFacts(repo, env, q.sha, "refs/remotes/origin/main"), testRuns(this.ledger.entries(this.wl)), q.pr);
		if (merge.mode === "doc-merge") {
			this.f.mode = "doc-merge";
			this.f.basis = merge.basis;
			this.f.merge = merge.merge;
			this.log(`doc-merge on basis ${merge.basis.runId} at ${merge.basis.sha}, main ${merge.merge.main}, docs: ${merge.merge.docs.join(" ") || "none"}; no full suite`);
		} else {
			this.log(`the full suite runs: ${merge.reason}`);
		}
		await git([...NO_HOOKS, "remote", "remove", "origin"], "git remote remove");
		// The tested commit as a branch, so the bundle carries it whatever HEAD's handling.
		await git([...NO_HOOKS, "update-ref", `refs/heads/as2-tested-pr-${q.pr}`, q.sha], "naming the tested commit");
		// The trusted base for `migration-items check`: origin/main's sha as a tag the clone keeps (overwrites any fetched tag of that name).
		await git([...NO_HOOKS, "update-ref", "refs/tags/as2-trusted-main", this.f.base], "tagging the trusted base");
		const bundle = join(this.stage, "repo.bundle");
		await git([...NO_HOOKS, "bundle", "create", "-q", bundle, "--all"], "git bundle create");
		chmodSync(bundle, 0o640);
		writeCaps(this.stage, this.config);
		chmodSync(this.stage, 0o750);
		this.log(`trusted phase: ${q.sha} on base ${this.f.base}, merge-base ${this.f.mergeBase}; changed test files: ${changed.join(" ") || "none"}`);
		return changed;
	}

	/** Steps in the plan's order: lock and publish → install check (and refresh) → sweep → probe → retention → trusted → prepare → parts with a sweep after each → head re-check. */
	protected async body(): Promise<void> {
		this.served();
		try {
			await this.acquire();
		} catch (e) {
			// At the backstop the PR is read once more: the re-request starts from that view, and a PR read MERGED or CLOSED ends the run superseded, not re-requested.
			if (e instanceof Backstop) {
				let view: PrView | string;
				try {
					view = await ghPrViewAsync(this.ownerRepo, this.request.pr, this.runDir);
				} catch (e2) {
					view = errText(e2);
				}
				const gone = typeof view === "string" ? null : queueWaitDecision({ waitedMs: 0, pr: this.request.pr, prState: view.state, config: this.config });
				if (gone?.act === "superseded") throw new Superseded(gone.reason);
				this.backstopView = view;
			}
			throw e;
		}
		const install = await this.installCheck();
		await this.sweep("publish");
		await this.preflight(install);
		await this.retention();
		const changed = await this.trusted();
		if (changed === null) return;
		await this.prepare(this.request.sha);
		if (this.f.mode === "full") {
			this.f.full = await this.part({ sub: "full" });
			await this.sweep("full");
		}
		for (const file of changed) {
			this.f.solo.push({ file, ...(await this.part({ sub: "solo", file })) });
			await this.sweep(file);
		}
		await hook(this.id, "head-recheck");
		this.f.headAtEnd = await this.headNow(this.request.pr);
	}

	/**
	 * The result (§ 2.3 steps 6–8): with the runs.db row held in a BEGIN IMMEDIATE transaction (so no
	 * takeover lands in between), one ledger transaction checks ownership and the slice's state,
	 * decides, writes `test-run:`, settles (completes the slice) when the decision says so and, for a
	 * run that is not green on a workload no lane holds, writes the `test-run-failed:` message. The
	 * settle commits with the check it rests on: no successor request, pause or cancel lands between
	 * them, and a slice that is not open is never touched. Then `result.json`. A run stopped by the
	 * queue backstop re-requests itself first (`rerequest`); only a refused re-request comes here.
	 */
	protected finish(): void {
		if (this.backstopView !== null && this.rerequest(this.backstopView)) return;
		this.reported(this.underLock((lockMine) => this.ledger.write(() => this.record(lockMine, this.error))));
	}

	/** The result transaction's body: `test-run:` with `error` as the run-level failure, the settle, the orchestrator's message. Call inside a ledger write. */
	private record(lockMine: boolean, error: string | null): RunWritten {
		const owner = lockMine && !this.superseded && ownsRequest(testRuns(this.ledger.entries(this.wl)), this.id);
		const facts: RunFacts = { ...this.f, error, owner, sliceState: this.ledger.slice(this.request.slice)?.state ?? null };
		const decided = decideRun(facts);
		// A run displaced from the lock says so; decideRun's reason alone speaks only of the request.
		const lost = this.lockLost(lockMine);
		const decision = decided.verdict === "superseded" && lost ? { ...decided, reason: `${lost}; ${decided.reason}` } : decided;
		const run = buildTestRun(this.request, facts, decision, { base: this.f.base, mergeBase: this.f.mergeBase, runDir: this.runDir, preflight: this.preflightNote });
		this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: this.request.slice, kind: "assumption", body: testRunBody(run) });
		// decision.settle holds only for an owner whose slice this transaction read as open. The
		// completion is a nested write (a savepoint): a refusal rolls back only itself, and the
		// `test-run:` entry still commits.
		let settled: RunWritten["settled"] = null;
		if (decision.settle) {
			try {
				this.ledger.completeSlice(this.request.slice, { by: TEST_RUNNER_BY, artifact: settleArtifact(run) });
				settled = { ok: true };
			} catch (e) {
				settled = { ok: false, reason: errText(e) };
			}
		}
		// A run the backstop re-requested has nothing for the orchestrator to act on: its re-request's own result follows.
		const heldLive = this.ledger.liveLaneHolders().some((h) => h.workloadId === this.wl);
		const failed = notifiesOrchestrator(run.verdict, heldLive) && rerequestedAs(run.reason) === null ? testRunFailedOf(this.wl, this.request.slice, run) : null;
		if (failed) {
			this.ledger.enqueue({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: this.request.slice, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: testRunFailedBody(failed) });
		}
		return { run, settled };
	}

	/** The result's log lines and `result.json`, after its transaction committed. */
	private reported({ run, settled }: RunWritten): void {
		this.log(`test-run ${run.verdict}${run.reason ? `: ${run.reason}` : ""}`);
		if (settled?.ok) this.log(`settled ${this.request.slice}`);
		else if (settled) this.log(`the settle of ${this.request.slice} was refused: ${settled.reason}`);
		try {
			writeFileSync(join(this.runDir, "result.json"), resultJson(run), { mode: 0o600 });
		} catch (e) {
			this.log(`result.json not written: ${errText(e)}`);
		}
	}

	/**
	 * The backstop's re-request (Jo, in-mv9340e04pgbnk: "dropped runs re-request at once") through the
	 * starter's own steps for the same PR, slice and requester: the PR checks (`admissiblePr`) on the
	 * view read at the backstop, then one ledger transaction writing this run's `error` (`queued past the
	 * <N> min backstop; re-requested as <run id>`) and, now that this run is settled, the new
	 * `test-requested:` (`writeRequest`: the reservation, the slice still open). After the commit
	 * `handOn` moves the queue. A refusal before the commit rolls both back, sets `this.error` to the
	 * `re-request refused: <why>` form and returns false, as does a run that no longer owns its request
	 * (the usual finish then writes `superseded`).
	 */
	private rerequest(view: PrView | string): boolean {
		const q = this.request;
		const next: TestRequested = { runId: newRunId(), pr: q.pr, sha: typeof view === "string" ? q.sha : view.headRefOid, slice: q.slice, by: q.by };
		let done: RunWritten | null;
		try {
			if (typeof view === "string") throw new Fail(view, START_EXIT.failed);
			admissiblePr(this.ledger, this.wl, view);
			done = this.ledger.write(() => {
				if (!ownsRequest(testRuns(this.ledger.entries(this.wl)), this.id)) return null;
				const written = this.record(true, backstopReason(this.config.queueMaxMin, { runId: next.runId }));
				writeRequest(this.ledger, this.wl, this.root, { runId: next.runId, pr: next.pr, sha: next.sha, sliceArg: next.slice, by: next.by });
				return written;
			});
		} catch (e) {
			this.error = backstopReason(this.config.queueMaxMin, { refused: errText(e) });
			this.log(`the re-request was refused: ${errText(e)}`);
			return false;
		}
		if (done === null) return false;
		this.reported(done);
		this.handOn(next);
		return true;
	}

	/**
	 * After the re-request commits: this run's admission withdrawn, the new run admitted at the queue
	 * tail (a failed admission is made at its first poll, `tryAcquire`) and its runner spawned; a spawn
	 * that fails withdraws that admission and writes the new run's `error`, as `start` does.
	 */
	private handOn(next: TestRequested): void {
		try {
			withdraw(this.lockDb, this.id);
		} catch (e) {
			this.log(`the admission was not removed: ${errText(e)}`);
		}
		try {
			admit(this.lockDb, next.runId);
		} catch (e) {
			this.log(`${next.runId} was not admitted here; its runner admits itself at the tail: ${errText(e)}`);
		}
		try {
			const { pid, log } = spawnRunner(this.root, next.runId);
			this.log(`re-requested as ${next.runId}: runner ${pid} sha ${next.sha} slice ${next.slice} log ${log}`);
		} catch (e) {
			const reason = `the runner did not start: ${errText(e)}`;
			this.log(`re-request ${next.runId}: ${reason}`);
			try {
				withdraw(this.lockDb, next.runId);
				recordError(this.ledger, this.wl, next, runDirOf(this.root, next.runId), reason);
			} catch (e2) {
				this.log(`the re-request's failure could not be recorded: ${errText(e2)}`);
			}
		}
	}
}

/** A part's counts without its failure list (the batch row carries the failures beside them). */
function countsOf(p: PartResult): Probe["full"] {
	return { pass: p.pass, fail: p.fail, skip: p.skip, exit: p.exit, ms: p.ms, error: p.error };
}

/**
 * The batch (plan wl-mv615mkeaf1yio § 4): one clone, every PR head fetched and checked against its
 * pin, M0 = origin/main, the PRs merged onto it in Jo's order, one full suite at the last step, each
 * head re-read at the end. One `test-batch-run:`, which settles the batch slice whatever its verdict;
 * a green writes each PR's credit on its own workload; a red with a full suite hands its bundle to an attribution run.
 */
class BatchRunner extends LockedRun {
	private fetched: string[] | null = null;
	private base: string | null = null;
	private steps: BatchStep[] = [];
	private conflict: number | null = null;
	private full: PartResult | null = null;
	private headsAtEnd: (string | null)[] | null = null;
	/** Each PR's own workload, read after the head re-check; null (no credits) when unread or gh did not answer. */
	private owners: (string | null)[] | null = null;

	constructor(ledger: Ledger, wl: string, readonly request: TestBatchRequested, config: TestRunnerConfig) {
		super(ledger, wl, request.runId, config);
	}

	/**
	 * The batch's request still has no `test-batch-run:` (as `ownsRequest` for a single run): a later
	 * start-batch on the workload settles a batch whose heartbeat went stale as `runner died`, and from
	 * then on that row is the batch's result.
	 */
	protected stillWanted(): boolean {
		return !batchRuns(this.ledger.entries(this.wl)).some((r) => r.runId === this.id);
	}

	/** Clone, fetch every head and main, the pin check, the merges, the bundle. False when nothing is to be tested (a head off its pin, a conflict). */
	async trusted(): Promise<boolean> {
		await this.checkpoint("trusted");
		const repo = join(this.stage, "repo");
		rmSync(this.stage, { recursive: true, force: true });
		mkdirSync(repo, { recursive: true, mode: 0o750 });
		const env = this.trustedGit();
		const git = async (args: string[], what: string): Promise<string> => {
			const r = await run(["git", ...args], { cwd: repo, env, timeoutMs: 600_000 });
			if (r.code !== 0) throw new Stop(`${what} failed: ${r.err.split("\n").at(-1) || `exit ${r.code}`}`);
			return r.out.trim();
		};
		const prs = this.request.prs;
		await git([...NETWORK, "clone", "-q", "--no-checkout", this.url, "."], "git clone");
		await git([...NETWORK, "fetch", "-q", "origin", ...prs.map((p) => `+refs/pull/${p.pr}/head:refs/remotes/origin/pr/${p.pr}`), "+refs/heads/main:refs/remotes/origin/main"], "git fetch");
		const fetched: string[] = [];
		for (const p of prs) fetched.push(await git([...NO_HOOKS, "rev-parse", "--verify", `refs/remotes/origin/pr/${p.pr}^{commit}`], `reading PR #${p.pr}'s head`));
		this.fetched = fetched;
		if (prs.some((p, i) => fetched[i] !== p.sha)) return false;
		this.base = await git([...NO_HOOKS, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], "reading origin/main");
		const built = await buildBatch(repo, env, this.base, prs.map((p) => p.sha));
		this.steps = built.steps;
		this.conflict = built.conflict;
		if (built.conflict !== null) {
			this.log(conflictReason(prs, built.conflict));
			return false;
		}
		await git([...NO_HOOKS, "remote", "remove", "origin"], "git remote remove");
		await git([...NO_HOOKS, "update-ref", "refs/tags/as2-trusted-main", this.base], "tagging the trusted base");
		const bundle = join(this.stage, "repo.bundle");
		await git([...NO_HOOKS, "bundle", "create", "-q", bundle, "--all"], "git bundle create");
		chmodSync(bundle, 0o640);
		writeCaps(this.stage, this.config);
		chmodSync(this.stage, 0o750);
		this.log(`trusted phase: ${prs.map((p) => `#${p.pr}@${p.sha.slice(0, 7)}`).join(" ")} merged onto ${this.base}; final tree ${this.steps.at(-1)!.tree}`);
		return true;
	}

	protected async body(): Promise<void> {
		this.served();
		await this.acquire();
		const install = await this.installCheck();
		await this.sweep("publish");
		await this.preflight(install);
		await this.retention();
		if (!(await this.trusted())) return;
		await this.prepare(this.steps[this.request.prs.length]!.commit);
		this.full = await this.part({ sub: "full" });
		await this.sweep("full");
		await hook(this.id, "head-recheck");
		const heads: (string | null)[] = [];
		for (const p of this.request.prs) heads.push(await this.headNow(p.pr));
		this.headsAtEnd = heads;
		if (this.full !== null && this.ownerRepo !== "") this.owners = await this.readOwners();
	}

	/** Each PR's own workload from its head branch, read from gh one PR at a time; null (no credits) when gh does not answer. */
	private async readOwners(): Promise<(string | null)[] | null> {
		try {
			const owners: (string | null)[] = [];
			for (const p of this.request.prs) owners.push(ownWorkloadOf((await ghPrViewAsync(this.ownerRepo, p.pr, this.runDir)).headRefName));
			return owners;
		} catch (e) {
			this.log(`no credits: the PRs' head branches could not be read: ${errText(e)}`);
			return null;
		}
	}

	/**
	 * The result, with the lock row read in the same transaction as the ledger write: decide, write
	 * `test-batch-run:`, settle the still-open slice on any verdict, write a green's credit on each PR's own
	 * workload (a nested write each: a refusal skips only that credit), and the `test-batch-result:`
	 * line to the orchestrator. Then result.json, then a red's handoff to its attribution.
	 */
	protected finish(): void {
		const q = this.request;
		const n = q.prs.length;
		const owners = this.owners;
		const attributionId = newRunId();
		const done = this.underLock((lockMine) => this.ledger.write(() => {
			// Only an unsettled batch writes its result, checked in the transaction that writes it: one settled as runner died writes, settles, credits and hands off nothing.
			if (!this.stillWanted()) return null;
			const d = decideBatch({
				prs: q.prs, fetched: this.fetched, error: this.error, conflict: this.conflict, full: this.full, headsAtEnd: this.headsAtEnd,
				lockLost: this.lockLost(lockMine), sliceState: this.ledger.slice(q.slice)?.state ?? null,
			});
			const run: TestBatchRun = {
				runId: this.id, verdict: d.verdict, base: this.base, prs: q.prs, steps: this.steps, full: this.full ? countsOf(this.full) : null,
				failures: failuresOf(this.full, []), attribution: d.verdict === "red" && this.full !== null && this.steps.length === n + 1 ? attributionId : null,
				reason: d.reason, headsAtEnd: this.headsAtEnd, runDir: this.runDir, preflight: this.preflightNote,
			};
			this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: q.slice, kind: "assumption", body: testBatchRunBody(run) });
			let settled: { ok: true } | { ok: false; reason: string } | null = null;
			if (d.settle) {
				try {
					this.ledger.completeSlice(q.slice, { by: TEST_RUNNER_BY, artifact: batchSettleArtifact(run) });
					settled = { ok: true };
				} catch (e) {
					settled = { ok: false, reason: errText(e) };
				}
			}
			const credited: number[] = [];
			if (run.verdict === "green" && owners !== null) {
				for (const { workloadId, credit } of batchCreditsOf(run, owners)) {
					if (!this.ledger.workload(workloadId)) continue;
					try {
						this.ledger.write(() => this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId, kind: "assumption", body: testBatchCreditBody(credit) }));
						credited.push(credit.pr);
					} catch (e) {
						this.log(`the credit for PR #${credit.pr} on ${workloadId} was not written: ${errText(e)}`);
					}
				}
			}
			this.ledger.enqueue({
				by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: q.slice, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT,
				body: testBatchResultBody({ workloadId: this.wl, runId: this.id, text: batchResultText(run, run.verdict === "green" && owners === null ? null : credited) }),
			});
			return { run, settled, credited };
		}));
		if (done === null) {
			this.log(`nothing written: ${this.id} already has its test-batch-run: (settled as runner died while this run gave no heartbeat)`);
			return;
		}
		const { run, settled, credited } = done;
		this.log(`test-batch ${run.verdict}${run.reason ? `: ${run.reason}` : ""}${credited.length > 0 ? `; credits for #${credited.join(", #")}` : ""}`);
		if (settled?.ok) this.log(`settled ${q.slice}`);
		else if (settled) this.log(`the settle of ${q.slice} was refused: ${settled.reason}`);
		try {
			writeFileSync(join(this.runDir, "result.json"), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
		} catch (e) {
			this.log(`result.json not written: ${errText(e)}`);
		}
		if (run.attribution !== null) this.handoff(run);
	}

	/**
	 * A red's handoff (plan wl-mv615mkeaf1yio § 4), after its result row: the bundle hard-linked into
	 * the attribution's stage dir with caps, the attribution admitted to the queue, its runner spawned.
	 * A link that fails leaves the attribution to report the bundle unavailable; an admission that
	 * fails leaves it never run, which the surface reads as lost; a spawn that fails withdraws the
	 * admission and writes the attribution's error row.
	 */
	private handoff(run: TestBatchRun): void {
		const id = run.attribution!;
		crashAt("after-result");
		try {
			const stage = stageDirOf(id, this.as2root);
			mkdirSync(stage, { recursive: true, mode: 0o750 });
			linkSync(join(stageDirOf(this.id, this.as2root), "repo.bundle"), join(stage, "repo.bundle"));
			writeCaps(stage, this.config);
			chmodSync(stage, 0o750);
		} catch (e) {
			this.log(`the bundle was not handed to ${id}: ${errText(e)}`);
		}
		try {
			admit(this.lockDb, id);
		} catch (e) {
			this.log(`attribution ${id} was not admitted: ${errText(e)}`);
			return;
		}
		crashAt("after-admit");
		try {
			const { pid, log } = spawnRunner(this.root, id);
			this.log(`attribution ${id} runner ${pid} log ${log}`);
		} catch (e) {
			const reason = `the attribution runner did not start: ${errText(e)}`;
			this.log(reason);
			try {
				withdraw(this.lockDb, id);
				recordBatchError(this.ledger, { kind: "attribution", workloadId: this.wl, runId: id, batch: run }, runDirOf(this.root, id), reason);
			} catch (e2) {
				this.log(`the attribution's failure could not be recorded: ${errText(e2)}`);
			}
		}
	}
}

/**
 * A red batch's attribution (plan wl-mv615mkeaf1yio § 4): it holds the lock under its own id, checks
 * the bundle it was handed still holds every recorded step, then bisects over full-suite prefixes,
 * each probe a sub-run (its own stage dir, work dir and reports; `current` names it, the lock row
 * does not move). One `test-batch-attribution:` row and one `test-batch-result:` line.
 */
class AttributionRunner extends LockedRun {
	private readonly probes: Probe[] = [];
	private outcome: AttributionOutcome | null = null;

	constructor(ledger: Ledger, wl: string, id: string, readonly batch: TestBatchRun, config: TestRunnerConfig) {
		super(ledger, wl, id, config);
	}

	protected stillWanted(): boolean {
		return true;
	}

	protected async body(): Promise<void> {
		this.served();
		await this.acquire();
		const install = await this.installCheck();
		await this.sweep("publish");
		await this.preflight(install);
		await this.retention();
		await this.checkpoint("verify");
		const bad = await verifyBundleSteps(join(this.stage, "repo.bundle"), join(this.runDir, "verify.git"), this.trustedGit(), this.batch.steps);
		if (bad !== null) {
			this.outcome = { kind: "error", reason: `batch bundle unavailable: ${bad}`, probes: [] };
			return;
		}
		const n = this.batch.prs.length;
		for (;;) {
			const next = bisectNext(n, this.probes);
			if ("done" in next) {
				const d = next.done;
				this.outcome = d.kind === "main-red"
					? { kind: "main-red", probes: [...this.probes] }
					: { kind: "broken", step: d.step, pr: this.batch.prs[d.step - 1]!.pr, probes: [...this.probes] };
				return;
			}
			this.probes.push(await this.probe(next.probe));
		}
	}

	/** Step k's full suite as a sub-run: a fresh id, the bundle hard-linked into its stage dir with caps, `current` moved to it and back. */
	private async probe(k: number): Promise<Probe> {
		const sub = newRunId();
		const stage = stageDirOf(sub, this.as2root);
		mkdirSync(stage, { recursive: true, mode: 0o750 });
		linkSync(join(stageDirOf(this.id, this.as2root), "repo.bundle"), join(stage, "repo.bundle"));
		writeCaps(stage, this.config);
		chmodSync(stage, 0o750);
		mkdirSync(runDirOf(this.root, sub), { recursive: true, mode: 0o700 });
		this.log(`probe of step ${k} as ${sub}`);
		let full: PartResult;
		this.subject = sub;
		try {
			await this.prepare(this.batch.steps[k]!.commit);
			full = await this.part({ sub: "full" });
			await this.sweep(`the probe of step ${k}`);
		} finally {
			this.subject = this.id;
		}
		await this.checkpoint("holder");
		// An errored probe (a timeout, a kill) names no PR, whatever it failed before it stopped: the Stop ends the attribution as `error`.
		const v = fullSuiteVerdict(full);
		if (v.verdict === "error") throw new Stop(`the probe of step ${k} (${sub}): ${v.why}`);
		return { step: k, verdict: v.verdict, full: countsOf(full) };
	}

	protected finish(): void {
		const a = this.underLock((lockMine) => this.ledger.write(() => {
			const lost = this.lockLost(lockMine);
			const probes = [...this.probes];
			const outcome: AttributionOutcome = lost !== null
				? { kind: "error", reason: oneLine(`the attribution lost the lock: ${lost}`), probes }
				: this.error !== null
					? { kind: "error", reason: oneLine(this.error), probes }
					: this.outcome ?? { kind: "error", reason: "the attribution did not finish", probes };
			const a: TestBatchAttribution = { runId: this.id, batch: this.batch.runId, outcome };
			this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: this.wl, kind: "assumption", body: testBatchAttributionBody(a) });
			this.ledger.enqueue({
				by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: null, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT,
				body: testBatchResultBody({ workloadId: this.wl, runId: this.id, text: `attribution of batch ${a.batch}: ${attributionText(outcome)}` }),
			});
			return a;
		}));
		this.log(`attribution of ${a.batch}: ${attributionText(a.outcome)}`);
		try {
			writeFileSync(join(this.runDir, "result.json"), `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
		} catch (e) {
			this.log(`result.json not written: ${errText(e)}`);
		}
	}
}

async function cmdRun(runId: string): Promise<number> {
	process.umask(0o027);
	if (!RUN_ID_RE.test(runId)) throw new Fail(`${runId} is not a run id`, START_EXIT.usage);
	let runner: LockedRun | null;
	try {
		runner = runnerOf(runId);
	} catch (e) {
		dequeue(runId);
		throw e;
	}
	if (!runner) {
		dequeue(runId);
		return 0;
	}
	return runner.main();
}

/** The run for `runId`, or null when there is no profile to run under and the run got its error result instead. */
function runnerOf(runId: string): LockedRun | null {
	const ledger = openLedger();
	const found = findRunSubject(ledger, runId);
	if (!found) throw new Fail(`no test-requested:, test-batch-requested: or batch handoff for ${runId}`, START_EXIT.failed);
	const w: WorkloadStatusRow | null = ledger.workload(found.workloadId);
	if (!w) throw new Fail(`no workload ${found.workloadId}`, START_EXIT.failed);
	let config: TestRunnerConfig;
	try {
		config = loadConfig();
	} catch (e) {
		// No caps to run under: the run still gets its error result.
		process.stdout.write(`${new Date().toISOString()} ${errText(e)}\n`);
		const runDir = runDirOf(runsRoot(process.env), runId);
		if (found.kind === "single") recordError(ledger, found.workloadId, found.request, runDir, errText(e));
		else recordBatchError(ledger, found, runDir, errText(e));
		return null;
	}
	if (found.kind === "single") return new Runner(ledger, found.workloadId, found.request, config);
	if (found.kind === "batch") return new BatchRunner(ledger, found.workloadId, found.request, config);
	return new AttributionRunner(ledger, found.workloadId, found.runId, found.batch, config);
}

/** A run that ends before its Runner exists leaves the queue too (plan wl-mv615mkeaf1yio § 2, every exit path). */
function dequeue(runId: string): void {
	try {
		const db = openLockDb(runsRoot(process.env));
		try {
			withdraw(db, runId);
		} finally {
			db.close();
		}
	} catch (e) {
		process.stdout.write(`${new Date().toISOString()} the admission was not removed: ${errText(e)}\n`);
	}
}

// ---- main ---------------------------------------------------------------------------------------------

const USAGE = "usage: test-runner.ts start <wl> <pr> [--slice <id>] --requested-by <laneId> | start-batch <wl> <instruction id> | run <run id>";

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
	if (cmd === "start-batch") {
		const [wl, instructionId, ...extra] = rest;
		if (!wl || !/^wl-\S+$/.test(wl) || !instructionId || !/^in-[a-z0-9]+$/.test(instructionId) || extra.length > 0) throw new Fail(USAGE, START_EXIT.usage);
		return await cmdStartBatch(wl, instructionId);
	}
	if (cmd === "run" && rest.length === 1) return cmdRun(rest[0]!);
	throw new Fail(USAGE, START_EXIT.usage);
}

if (import.meta.main) {
	const sub = process.argv[2] === "run" || process.argv[2] === "start-batch" ? process.argv[2] : "start";
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			const f = err instanceof Fail ? err : new Fail(errText(err), START_EXIT.failed);
			process.stderr.write(`test-runner ${sub}: ${f.message.replace(/\s+/g, " ")}\n`);
			process.exit(f.code);
		},
	);
}
