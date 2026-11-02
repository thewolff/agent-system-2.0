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
//       is spawned; activation-aware status publication follows the commit, and the line has `runner none`, `log none` and ends ` carried <R>`.
//       Off mode carries only full Mac execution authority (never fast/tree plans, even through another decision-log carry).
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
//       into the run dir under the report checks; a missing or refused capture is one runner.log line and changes nothing. Then
//       the head re-check, one `test-run:` entry and the settle
//       in one ledger transaction; then the lock released (`<ts> lock released`; a release that ends with the row still held logs
//       `the lock was not released` and the run exits 3, START_EXIT.failed) and, when the fetch confirmed the requested
//       sha, the `as2/full-suite` commit status on
//       that sha for any PR (green and red-main success, red failure, error error; stale and superseded post none; PLAN
//       wl-mv8s8srodefytc rev 17.1 D2, D8). No `pending` is posted: a missing status already blocks a
//       protected merge. A failed status post is logged and never changes the verdict.
//
//       Parallel files (workload wl-mvg2kzuvwngdmo): the trusted phase writes the profile's `testRunner.fullWorkers` into
//       caps.json beside the caps, and the run logs `<ts> full workers <n>` right before the PR full part; test-exec runs that
//       part with `bun test --parallel=<n>` when n is over 1. Solo parts, on the PR and on base, run one file each.
//       surface/scripts/test-run-waits.ts reads the waits, the `full workers` lines and the results back per day.
//
//       Land-first (PLAN wl-mvq4edbaf13vnk D4): on a land-first repository `start` posts `pending` first (a refused post refuses
//       the request) and records `fast-plan:` in the admission's transaction: a tree carry (no run), the fast set, or the full
//       suite by exception, which runs as above. A fast-set run holds no Mac slot for its hosted part: its preflight reconciles
//       current/tag/bundle under promotion.db (one refresh at most), with asynchronous acquisition and a shared bounded
//       refresh-plus-finalization holder/wait budget, then the trusted clone and the parse check over the plan's parse
//       targets (one that does not transpile makes the run red and nothing runs), then `as2-fast.yml` dispatched on `as2-verified`
//       (`hostedFast`); fast.xml, fast.log and
//       fast.summary are imported into the run dir and judged (`fastExec`: a planned file with no executed test makes it red).
//       A dispatch failure, a workflow run of other code than the tag's, or no result in fastWaitMin records `fast-fallback:
//       <run> <reason>` and runs the same set once on the Mac (`exec fast`), under the lock with the install check, sweep and
//       probe a full run has; the hosted run is never retried. Its `test-run:` carries scope fast and host linux or mac, and the
//       final status, for a fast or a full plan, is the merge gate's (`postGate`; a refused post records `status-failed:`).
//       Every run writes one `runner-preflight:` row on the standing workload after its preflight (main-state.ts D5).
//   reap
//       settle-only (D6, R37): every open workload's runner request with no settle and no live heartbeat gets `runner died`;
//       it admits nothing. Prints `reaped none` or `reaped <run id>…`, exit 0; a workload it could not settle on is exit 3,
//       after every other workload was tried.
//   promote --sha <sha>
//       reconciles a green believable main verdict to a detached verified/<sha12> release and atomic current symlink,
//       then as2-verified; keeps three releases. Idempotent after root/tag partial publication. Prints `promoted <sha>`
//       or `schema <first crossing sha>` (exit 0; the tick files the issue/notice), or verifier-stalled (exit 3).
//       Schema crossings require Jo's stop tick -> migrate live ledger -> promote-verified.ts <verified sha> -> restart.
//       Shadow mode earns the first G/tag before setup and verified install; only actual root/tag/helper/SOURCE facts
//       earn an ok runner-preflight receipt. Neither command performs a ledger migration.
//       Stuck workers (PLAN wl-mvq8x4pkjmx69s D4): caps.json carries `testRunner.stuckStop` (`shadow` by default, `enforce`) for
//       the exec's detector. A stuck part (exit 125 or a `stuck-stop` line) or a stalled executor (enforce only: the backstop
//       abandons a call STUCK_BACKSTOP_MS after a `stuck-signature` no stop line followed) ends the run with an error, its junit and
//       log imported whatever the wrapper's ending: one bounded sweep (its runs.db ownership checkpoint under the same deadline,
//       nonblocking), a spawn-free containment check of `_as2test`'s processes (retried up to STUCK_CONTAIN_MS, then
//       `stuck-containment-failed`), the shorter STUCK_FINALIZE_MS and the release (retried until the row would be stale for a
//       waiter, HEARTBEAT_STALE_MS past its last heartbeatAt; `release`). Shadow never arms the
//       backstop. After a `stuck-captured` line the run imports `<stem>.signature.log`; each run logs `stuck detector <mode>`. Every
//       run checks containment after its first sweep and runs no part while a survivor lives (`admission refused` after ADMIT_MS).
//
// Stamps: everything is written as `test-runner` (TEST_RUNNER_BY).
//
// Test-only knobs (the fence's tests set them; Jo's environment never does, and none crosses the
// wrapper's `env -i`):
//   AGENT_SYSTEM_TEST_RUNS                  the runs root (plan § 2.3 step 1; also read by the lane)
//   AGENT_SYSTEM_TEST_RUNNER_CONFIG         a yml replacing <checkout>/profile/config.yml
//   AGENT_SYSTEM_TEST_RUNNER_ORIGIN         the URL cloned and ls-remoted instead of the repo's origin
//   AGENT_SYSTEM_TEST_RUNNER_ROOT           the as2test root instead of AS2TEST_ROOT
//   AGENT_SYSTEM_TEST_RUNNER_VERIFIED       isolated verified directory instead of ~/.agent-system-2/verified
//   AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT   isolated own-root fixture for verified self-checks
//   AGENT_SYSTEM_TEST_RUNNER_INSTALL        json {libexec, sudoers, ids: {root, wheel, jo}, account: {uid, gid}}: a test
//                                           install the preflight checks instead of the real one (`installSpec`)
//   AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS   the heartbeat period (default 15 s)
//   AGENT_SYSTEM_TEST_RUNNER_POLL_MS        the lock wait's poll (default 2 s)
//   AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS    shared post-sweep head/result/publication deadline (default 150 s)
//   AGENT_SYSTEM_TEST_RUNNER_FAST_WAIT_MS   how long the hosted fast check may take before the Mac fallback (default fastWaitMin)
//   AGENT_SYSTEM_TEST_RUNNER_FAST_POLL_MS   the hosted fast check's poll (default 15 s)
//   AGENT_SYSTEM_TEST_RUNNER_STUCK_FINALIZE_MS  the same after a stuck or stalled part (default 12 s, never over FINALIZE_MS)
//   AGENT_SYSTEM_TEST_RUNNER_STUCK_BACKSTOP_MS  an enforce signature's backstop deadline after its line (default 16.5 s)
//   AGENT_SYSTEM_TEST_RUNNER_STUCK_POLL_MS  how often the backstop reads a part's stdout (default 1 s)
//   AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS one deadline over every attempt of a bounded sweep (default 12 s)
//   AGENT_SYSTEM_TEST_RUNNER_STUCK_CONTAIN_MS  how long containment may be retried after the stuck fact (default 60 s)
//   AGENT_SYSTEM_TEST_RUNNER_CONTAIN_RETRY_MS  between containment checks (default 5 s)
//   AGENT_SYSTEM_TEST_RUNNER_ADMIT_MS       how long the admission gate retries (default 30 s)
//   AGENT_SYSTEM_TEST_RUNNER_CONTAIN_SCOPE  `uid` makes a test install's containment check read the caller's uid; by default a
//                                           test install's check counts only live members of a `<as2test root>/runs/*/groups` pgid
//   AGENT_SYSTEM_TEST_RUNNER_OUTLIVE_MS     how long a part's wrapper may outlive its cap before the runner sweeps (default 60 s)
//   AGENT_SYSTEM_TEST_RUNNER_BUSY_MS        runs.db busy_timeout (default 5 s); a stuck run's halt, its publication and its release use 0
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS    the refresh helper's cap (default REFRESH_CAP_S plus a minute, 15 min)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS  its SIGTERM-to-SIGKILL grace (default 10 s)
//   AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS   how long it then waits for sudo to exit (default 30 s)
//   AGENT_SYSTEM_TEST_HOOKS                 a directory of pause/mark files at named boundaries (`hook`), and the
//                                           `<run id>.refresh-signal.refuse` file: the runner's signals to the refresh
//                                           helper's sudo are refused, as the kernel may refuse Jo's signal to a root sudo
import { spawn, spawnSync, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
	appendFileSync, chmodSync, closeSync, constants as FS, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync,
	rmSync, symlinkSync, type Stats, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertNotLiveLedgerUnderTest, defaultLedgerPath, type EntryRow, Ledger, TEST_RUNNER_BY, type WorkloadStatusRow } from "../../ledger/src/index";
import {
	AS2_VERIFIED_TAG, AS2TEST_LIBEXEC, AS2TEST_SUDOERS, CHECKOUT_DRIFT, type DsclRead, type InstallFacts, installDecision, type InstallVerdict, type OwnerIds, preflightDecision,
	preflightProbes, probeCall, probeDecision, readInstall, REBUILT_FILES, REFRESH_CAP_S, REFRESH_EXIT, REFRESH_FAILED, type Verdict,
} from "../src/as2test";
import { repoOf } from "../src/decision-log";
import { FastSetError, type FastRun, type FullRun, fastSet, parseCheck, type ReadFile } from "../src/fast-set";
import { ensureStandingWorkload } from "../src/identity";
import { boundPrs, controlEntries, holdersOf, landFirstOn, mainRetries, sameRepo, worktreePath } from "../src/launch";
import {
	attemptBlock, attribute, CHAIN_MAX, type ChainCommit, type GateDecision, type GateFacts, ghMainChain, mainResults, type MainState, mainState, mainVerdicts, type MainVerdictKind, mergeGate,
	runnerPreflightBody,
} from "../src/main-state";
import { type ControlRoot, controlRootRefusal, FULL_SUITE_STATUS, fixBindings, fixBinds, ghCompare, type LandFirstRow, landFirstRows, stopEpisode, trainHold, trainPrs } from "../src/merge-train";
import { bodyDeps, DEFAULT_BRANCH } from "../src/merge-train-stack";
import {
	AS2TEST_ROOT, AS2TEST_USER, authoritativeRun, baseParts, boundBranches, buildTestRun, callStuck, callTimedOut, carriedRun, changedTestFiles, countedTestFiles, decideRun, decisionLogFault, type ExecCounts, execOf, executedFiles, executorStalledReason,
	type FastPlan, type FastSetPlan, fastPlanBody, fastPlanOf, withFullSuitePublication,
	fullSuiteSlice, HEARTBEAT_EVERY_MS, HEARTBEAT_STALE_MS, heartbeatText, KEEP_RUNS, lockHolderStale, makeRunId, notifiesOrchestrator, ownerRepoOf, ownsRequest, parseHeartbeat, parseTestRequested, type PartInput, type PartResult,
	partResult, prAdmissible, type PrView, pruneRuns, queueAhead, queuedTooLong, type QueueRow, queueWaiterLive, recordLive, reportCapBytes, reservation, type ResultRecord, resultJson, RUN_ID_RE, type RunDecision, type RunFacts, runDirOf,
	runnerDiedRun, type RunRecord, runsDbOf, runsRoot, securityRedBody, securityRedOf, servedRepo, settleArtifact, stageDirOf, StuckWatch, stuckReason, type TestHost, type TestRequested, type TestRun, testRequestedBody,
	testRunBody, testRunFailedBody, testRunFailedOf, type TestVerdict, soloPlan, type TestRunnerConfig, testRunnerConfig, testRuns, workDirOf, WRAPPER_EXIT, type WrapperCall, wrapperArgv,
} from "../src/test-run";
import { liveProcs, snapshot, STUCK_DEFAULTS } from "../src/stuck-detect";
import { MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID } from "../src/types";

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

/**
 * The stuck-worker detector's runner side (PLAN wl-mvq8x4pkjmx69s D4). The backstop of an enforce part abandons the wrapper call
 * this long after a `stuck-signature` line's own time: the executor's persistence, signature capture, stop grace and 2 s
 * verification, plus STUCK_SLACK_MS; 16.5 s with the production defaults (AGENT_SYSTEM_TEST_RUNNER_STUCK_BACKSTOP_MS in tests).
 */
const STUCK_SLACK_MS = 5_000;
const STUCK_BACKSTOP_MS = STUCK_DEFAULTS.persistMs + STUCK_DEFAULTS.signatureCaptureMs + STUCK_DEFAULTS.stopGraceMs + STUCK_DEFAULTS.verifyMs + STUCK_SLACK_MS;
/** How often the backstop reads an enforce part's stdout (AGENT_SYSTEM_TEST_RUNNER_STUCK_POLL_MS). */
const STUCK_POLL_MS = 1_000;
/** One deadline over every attempt of the sweep after a stuck or stalled part, the only cleanup step (AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS). */
const STUCK_SWEEP_MS = 12_000;
/** The post-sweep deadline of a stuck or stalled run, under FINALIZE_MS (AGENT_SYSTEM_TEST_RUNNER_STUCK_FINALIZE_MS). */
const STUCK_FINALIZE_MS = 12_000;
/** How long after the stuck fact the containment check may retry before the run names its failure (AGENT_SYSTEM_TEST_RUNNER_STUCK_CONTAIN_MS). */
const STUCK_CONTAIN_MS = 60_000;
/** Between containment checks, a bounded sweep and this wait (AGENT_SYSTEM_TEST_RUNNER_CONTAIN_RETRY_MS). */
const CONTAIN_RETRY_MS = 5_000;
/** How long a run retries the admission gate before it ends `admission refused` (AGENT_SYSTEM_TEST_RUNNER_ADMIT_MS). */
const ADMIT_MS = 30_000;
/** The post-sweep finalization deadline of a run that was not stuck (AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS). */
const FINALIZE_MS = 150_000;

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
function originOf(repo: string, deadline = Infinity): string | null {
	const r = spawnSync(["git", "-C", repo, "config", "--get", "remote.origin.url"], { stdout: "pipe", stderr: "pipe", timeout: deadline === Infinity ? undefined : verifierTimeout(deadline, 120_000, `reading origin of ${repo}`) });
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
	// D5's one pending main target per repository (lowercased owner/repo): replaced by each newer landing, admitted when the active main run
	// settles. It lives here, not in the ledger, on purpose: the tick re-requests every main tip that has no verdict on each pass, so losing
	// runs.db loses nothing durable, and a replaced target never needs an inconclusive test-run of its own.
	busyLoop(() => db.exec("CREATE TABLE IF NOT EXISTS main_pending (repo TEXT PRIMARY KEY, sha TEXT NOT NULL, at INTEGER NOT NULL)"));
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
	return busyLoop(() => publishTx(db, stageRoot, runId).published);
}

/** One attempt of publishIfOwner's transaction, under the connection's busy_timeout: whether it published, and the run the row holds. */
function publishTx(db: Database, stageRoot: string, runId: string): { published: boolean; holder: string | null } {
	return db.transaction(() => {
		const holder = lockRow(db)?.runId ?? null;
		if (holder !== runId) return { published: false, holder };
		writeCurrent(stageRoot, runId);
		return { published: true, holder };
	}).immediate();
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

/** A main request's entries name no slice (`sl-main-<id>` is a name, not a slice row); a PR request's name its slice. */
const sliceOf = (r: TestRequested): string | undefined => (r.main === undefined ? r.slice : undefined);

/** The `error` result of a request whose run never ran or died, `runner died` unless a reason is given; a main request's stays a main run. */
export function diedRun(request: TestRequested, runDir: string | null, reason = "runner died"): TestRun {
	return { ...runnerDiedRun(request, runDir), reason, main: request.main !== undefined };
}

/** After a reservation, a run that cannot proceed (no runner spawned, no profile to run under) gets its `error` result, while it still owns its request. */
function recordError(ledger: Ledger, root: string, wl: string, request: TestRequested, runDir: string, reason: string): void {
	const written = ledger.write(() => {
		if (!ownsRequest(testRuns(ledger.entries(wl)), request.runId)) return false;
		const prior = testRuns(ledger.entries(wl)).find((r) => r.request.runId === request.runId)?.results[0];
		if (request.main !== undefined && prior !== undefined) return false;
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sliceOf(request), kind: "assumption", body: testRunBody(diedRun(request, runDir, reason)) });
		return true;
	});
	if (written && request.main !== undefined) {
		const log = mainPublicationLog(ledger, wl, request.runId, (s) => {
			process.stdout.write(`${s}\n`);
			try {
				mkdirSync(runDir, { recursive: true, mode: 0o700 });
				appendFileSync(join(runDir, "publication.log"), `${s}\n`, { mode: 0o600 });
			} catch (e) {
				process.stdout.write(`publication.log in ${runDir} not written: ${errText(e)}; retain this process log and repair the run directory\n`);
			}
		});
		revokeIfActive(ledger, root, realGh, request.main.repo, `main ${request.sha.slice(0, 7)} error: ${reason}`, log);
		postStatus(realGh, request.main.repo, "error", request.sha, `main full error, run ${request.runId}`, log, MAIN_FULL_STATUS);
	}
}

// ---- GitHub: the runner's one seam -------------------------------------------------------------------

/** One gh process: its exit code (null when it was killed at its timeout) and output. */
export interface GhResult {
	code: number | null;
	stdout: string;
	stderr: string;
}
/** Every gh call of the status posts, the gate, the hosted fast check, main runs and revocation goes through this seam, so a test stubs GitHub. */
export type Gh = (args: string[], timeoutMs?: number) => GhResult;
/** gh found on PATH with this process's env, killed at `timeoutMs` (default 30 s). */
export const realGh: Gh = (args, timeoutMs = 30_000) => {
	const r = spawnSync(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
	if (r.exitedDueToTimeout) return { code: null, stdout: r.stdout.toString(), stderr: `gh ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs / 1000} s` };
	return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
/** A failed gh call's last line: its stderr's, else its stdout's, else its exit. */
export const ghWhy = (r: GhResult): string => r.stderr.trim().split("\n").at(-1) || r.stdout.trim().split("\n").at(-1) || `exit ${r.code}`;
/** gh's JSON answer for `args`; a failed call or an answer that is no JSON throws, naming the call. */
export function ghJsonOf(gh: Gh, args: string[]): unknown {
	const what = `gh ${args.slice(0, 2).join(" ")}`;
	const r = gh(args);
	if (r.code !== 0) throw new Error(`${what} failed: ${ghWhy(r)}`);
	try {
		return JSON.parse(r.stdout);
	} catch {
		throw new Error(`${what} did not return json`);
	}
}
const field = (v: unknown, k: string): unknown => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined);
const SHA40 = /^[0-9a-f]{40}$/;
/** The informational status a main run posts on its commit (D5); never required by the ruleset. */
export const MAIN_FULL_STATUS = "as2/main-full";

/**
 * A commit status `context` (as2/full-suite by default, FULL_SUITE_STATUS) `state` on exactly `sha` in `ownerRepo`: `gh api -X POST
 * repos/<owner/repo>/statuses/<sha>`. GitHub refuses a description over 140 characters, so a longer one is cut. Logged through `log`;
 * returns why it was not posted, or null when it was. It never throws.
 */
export function postStatus(
	gh: Gh, ownerRepo: string, state: "pending" | "success" | "failure" | "error", sha: string, description: string, log: (s: string) => void, context = FULL_SUITE_STATUS,
): string | null {
	const what = `status ${context} ${state} on ${sha}`;
	if (!ownerRepo) {
		log(`${what} not posted: the run has no served repo`);
		return "the run has no served repo";
	}
	const desc = description.length > 140 ? `${description.slice(0, 139)}…` : description;
	let why: string | null;
	try {
		const r = gh(["api", "-X", "POST", `repos/${ownerRepo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${desc}`], 15_000);
		why = r.code === 0 ? null : ghWhy(r);
	} catch (e) {
		why = errText(e);
	}
	log(why === null ? `${what} posted` : `${what} not posted: ${why}`);
	return why;
}

// ---- land-first (PLAN wl-mvq4edbaf13vnk D4, D5) -------------------------------------------------------

/** Land-first is on for `ownerRepo`, read now from the standing workload (`landFirstOn`, D12). */
function landFirstNow(ledger: Ledger, ownerRepo: string): boolean {
	return landFirstOn(ledger.entries(STANDING_WORKLOAD_ID), ledger.instructions(STANDING_WORKLOAD_ID), ownerRepo);
}

/** Safety publication never depends on an audit write; the runner's local log retains both the outcome and each audit failure. */
function mainPublicationLog(ledger: Ledger, wl: string, runId: string, local: (s: string) => void): (s: string) => void {
	return (s) => {
		local(s);
		try {
			// One nonblocking BEGIN, outside Ledger.write's retry policy. No retry delays a later head's status attempt.
			ledger.db.exec("PRAGMA busy_timeout = 0");
			ledger.db.transaction(() => ledger.recordEntry({
				by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: `main-publication: ${runId} ${s.replace(/\s+/g, " ")}`,
			})).immediate();
		} catch (e) {
			local(`main-publication audit for ${runId} not recorded: ${errText(e)}; outcome retained locally; repair ledger writes before the tick reconciles`);
		}
	};
}

/** Shadow main runs keep their informational status. Activation and every revocation share the off/publication mutex. */
function revokeIfActive(ledger: Ledger, root: string, gh: Gh, repo: string, reason: string, log: (s: string) => void): void {
	try {
		hookMark(repo.replaceAll("/", "_"), "main-revocation-acquiring");
		const on = withFullSuitePublication(root, repo, () => landFirstNow(ledger, repo));
		if (!on) {
			log(`shadow main on ${repo}: required PR statuses unchanged (land-first is off)`);
			return;
		}
		revokeOpen(gh, repo, reason, log, (head) => withFullSuitePublication(root, repo, (remainingMs) => {
			if (!landFirstNow(ledger, repo)) {
				log(`shadow main on ${repo}: required PR status at ${head} unchanged (land-first is off)`);
				return false;
			}
			const boundedGh: Gh = (args, timeoutMs = 30_000) => gh(args, Math.min(timeoutMs, remainingMs()));
			return postStatus(boundedGh, repo, "failure", head, `landing stopped: ${reason}`, log);
		}));
	} catch (e) {
		// A missing/busy mutex or cleanup failure cannot cancel the independent informational main status.
		log(`revocation on ${repo} could not complete under the publication mutex: ${errText(e)}; the tick must reconcile; original main outcome: ${reason}`);
	}
}

/** A git command for the runner's own trusted reads (`trustedEnv`, no hooks), synchronous; a failure throws naming it. */
function gitSync(gitDir: string, args: string[], env: Record<string, string>, opts: { stdin?: Uint8Array; timeoutMs?: number } = {}): Buffer {
	const r = spawnSync(["git", `--git-dir=${gitDir}`, ...NO_HOOKS, ...args], { env, stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs ?? 120_000 });
	if (r.exitCode !== 0) {
		const why = r.exitedDueToTimeout ? `timed out after ${(opts.timeoutMs ?? 120_000) / 1000} s` : r.stderr.toString().trim().split("\n").at(-1) || `exit ${r.exitCode}`;
		throw new Error(`git ${args.slice(0, 2).join(" ")} in ${gitDir} failed: ${why}`);
	}
	return r.stdout;
}

const MODULE_SOURCE = /\.(?:[cm]?[jt]sx?|sql)$/;
export interface CommitTree {
	files: string[];
	read: ReadFile;
}
/**
 * A commit's tracked files and a reader over their contents (`ReadFile`, null for a path the tree does not hold), from the
 * git dir `gitDir`: one `ls-tree`, then, with `prefetch`, every module source (and `.sql`) in one `cat-file --batch`, the
 * rest read on demand. The fast set reads every module of the tree (its import graph); the base side reads one file.
 */
export function treeAt(gitDir: string, commit: string, env: Record<string, string>, prefetch: boolean): CommitTree {
	const blobs = new Map<string, string>();
	for (const line of gitSync(gitDir, ["ls-tree", "-r", "-z", "--full-tree", commit], env).toString("utf8").split("\0")) {
		const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/s.exec(line);
		if (m) blobs.set(m[2]!, m[1]!);
	}
	const cache = new Map<string, string>();
	if (prefetch) {
		const want = [...blobs].filter(([p]) => MODULE_SOURCE.test(p));
		const out = gitSync(gitDir, ["cat-file", "--batch"], env, { stdin: Buffer.from(want.map(([, sha]) => `${sha}\n`).join("")) });
		let at = 0;
		for (const [path, sha] of want) {
			const nl = out.indexOf(10, at);
			const header = /^([0-9a-f]{40}) blob (\d+)$/.exec(out.subarray(at, nl).toString("utf8"));
			if (!header || header[1] !== sha) throw new Error(`git cat-file --batch in ${gitDir} answered ${out.subarray(at, nl).toString("utf8")} for ${path} (${sha})`);
			const size = Number(header[2]);
			cache.set(path, out.subarray(nl + 1, nl + 1 + size).toString("utf8"));
			at = nl + 1 + size + 1;
		}
	}
	const read: ReadFile = (path) => {
		const hit = cache.get(path);
		if (hit !== undefined) return hit;
		const sha = blobs.get(path);
		if (sha === undefined) return null;
		const text = gitSync(gitDir, ["cat-file", "blob", sha], env).toString("utf8");
		cache.set(path, text);
		return text;
	};
	return { files: [...blobs.keys()], read };
}

/** The runner's bare mirror of `ownerRepo` under the runs root: admissions fetch each head into `refs/as2/<run id>/…` there, so concurrent fetches never share a ref. */
function mirrorOf(root: string, ownerRepo: string, env: Record<string, string>): string {
	const dir = join(root, "mirror", `${ownerRepo.replace("/", "__")}.git`);
	if (!existsSync(join(dir, "HEAD"))) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		gitSync(dir, ["init", "-q", "--bare"], env);
	}
	return dir;
}
/** Remove a run's `refs/as2/<run id>/…` from the mirror; a failure is logged and leaves only a ref. */
function dropRunRefs(gitDir: string, runId: string, env: Record<string, string>, log: (s: string) => void): void {
	for (const ref of ["head", "main"]) {
		try {
			gitSync(gitDir, ["update-ref", "-d", `refs/as2/${runId}/${ref}`], env);
		} catch (e) {
			log(`the mirror ref refs/as2/${runId}/${ref} was not removed: ${errText(e)}`);
		}
	}
}

/** The commit the `as2-verified` tag names on `repo` (§ 2 The bundle); null when the tag does not exist (404). Throws when GitHub cannot answer. */
export function verifiedTagOf(gh: Gh, repo: string): string | null {
	const path = `repos/${repo}/git/ref/tags/${AS2_VERIFIED_TAG}`;
	const r = gh(["api", path]);
	if (r.code !== 0) {
		if (/HTTP 404|Not Found/.test(`${r.stderr}\n${r.stdout}`)) return null;
		throw new Error(`gh api ${path} failed: ${ghWhy(r)}`);
	}
	let v: unknown;
	try {
		v = JSON.parse(r.stdout);
	} catch {
		throw new Error(`gh api ${path} did not return json`);
	}
	const sha = field(field(v, "object"), "sha");
	if (field(field(v, "object"), "type") !== "commit" || typeof sha !== "string" || !SHA40.test(sha)) throw new Error(`gh api ${path} does not name a commit`);
	return sha;
}

/** The incident's designated repair, shared by admission and publication. A branch for any other tip grants no repair permission. */
function incidentRepair(gh: Gh, ledger: Ledger, repo: string, pr: number, ref: string, state: MainState): GateFacts["repair"] {
	if (state.open) return null;
	const ep = stopEpisode(landFirstRows(ledger.entries(STANDING_WORKLOAD_ID), repo));
	if (ep?.state.kind !== "regression" || ep.state.tip !== state.tip) return null;
	if (ref === `train/revert-${state.tip.slice(0, 7)}`) return "revert";
	return namedFix(gh, ledger, repo, pr) ? "fix" : null;
}
/**
 * PR `pr` is the fix the open stop episode's issue names (§ 2 The merge gate, D7): a line of the issue's body or a comment that says
 * `fix` and names `#<pr>` or `/pull/<pr>`. False with no open episode or no filed issue. Throws when GitHub cannot answer.
 */
export function namedFix(gh: Gh, ledger: Ledger, repo: string, pr: number): boolean {
	const ep = stopEpisode(landFirstRows(ledger.entries(STANDING_WORKLOAD_ID), repo));
	if (ep?.filed == null) return false;
	const v = ghJsonOf(gh, ["issue", "view", ep.filed, "--json", "body,comments"]);
	const comments = field(v, "comments");
	const texts = [field(v, "body"), ...(Array.isArray(comments) ? comments.map((c) => field(c, "body")) : [])].filter((t): t is string => typeof t === "string");
	const names = new RegExp(`\\bfix\\b.*(?:#|/pull/)${pr}\\b`, "i");
	return texts.some((t) => t.split("\n").some((l) => names.test(l)));
}

/** What the gate reads of a head besides its result: the repo, the head and its branch, the PR, and what it must pass. */
export interface GateInput {
	gh: Gh;
	ledger: Ledger;
	repo: string;
	head: string;
	ref: string;
	pr: number;
	need: "fast" | "full";
	result: GateFacts["result"];
}

/** Main facts captured outside the publication mutex; age is re-evaluated against these same facts before POST. */
export interface MainSnapshot {
	tip: string;
	chain: ChainCommit[];
	state: MainState;
	results: ResultRecord[];
}

/** Main as the gate reads it now: GitHub's tip of `repo`, its first-parent chain back to G (`ghMainChain`) and main state (`mainState`) over the runner's main results. Throws when GitHub cannot answer. */
export function readMain(gh: Gh, ledger: Ledger, repo: string): MainSnapshot {
	const ghJson = (args: string[]) => ghJsonOf(gh, args);
	const results = mainResults(ledger.entries(STANDING_WORKLOAD_ID));
	const greens = new Set([...mainVerdicts(results).values()].filter((v) => v.verdict === "green").map((v) => v.sha));
	const tipPath = `repos/${repo}/git/ref/heads/${DEFAULT_BRANCH}`;
	const tip = field(field(ghJson(["api", tipPath]), "object"), "sha");
	if (typeof tip !== "string" || !SHA40.test(tip)) throw new Error(`gh api ${tipPath} returned an unexpected shape`);
	const chain = ghMainChain(repo, tip, ghJson, greens);
	return { tip, chain, state: mainState(chain, results, Date.parse(ledger.now())), results };
}

/**
 * Only durable inputs that can change this gate's authority. Main results are global in mainState (including its believability
 * baseline); activation and stop-episode rows are repo-specific. Keep row ids, not a hash of unrelated standing-ledger activity.
 * Capture before network computation and compare again under the publication mutex, so even an off/on cycle invalidates it.
 */
function gateAuthority(ledger: Ledger, repo: string): { on: boolean; watermark: string } {
	const entries = ledger.entries(STANDING_WORKLOAD_ID);
	const instructions = ledger.instructions(STANDING_WORKLOAD_ID);
	const activation = controlEntries(entries).filter((c) =>
		(c.prefix === "land-first" || c.prefix === "land-first-off-pending" || c.prefix === "land-first-off-complete")
		&& sameRepo(c.rest.split(" ")[0]!, repo)).map((c) => c.id);
	const words = instructions.filter((i) => {
		const m = /^land-first (\S+) (on|off)$/.exec(i.body);
		return m !== null && sameRepo(m[1]!, repo);
	}).map((i) => i.id);
	const incident = landFirstRows(entries, repo).filter((r) => r.event.startsWith("stop-")).map((r) => r.entryId);
	return { on: landFirstOn(entries, instructions, repo), watermark: JSON.stringify([mainResults(entries).map((r) => r.entryId), activation, words, incident]) };
}

/**
 * The merge gate's decision on `head` (§ 2 The merge gate), re-read now from the ledger and GitHub: main's tip, its chain back to G
 * and state (`readMain`), whether the head contains the tip (GitHub's compare), and whether it is the incident's repair (a
 * `train/revert-…` head whose tree is G's, or the fix the incident's issue names). Throws when GitHub cannot answer.
 */
export function gateDecision(i: GateInput): GateDecision {
	return gateSnapshot(i).decision;
}

/** Bulk GitHub facts plus the main snapshot whose age must still be valid at the serialized POST. */
function gateSnapshot(i: GateInput): { decision: GateDecision; main: MainSnapshot } {
	const ghJson = (args: string[]) => ghJsonOf(i.gh, args);
	const main = readMain(i.gh, i.ledger, i.repo);
	const { tip, chain, state } = main;
	let containsTip = tip === i.head;
	if (!containsTip) {
		const status = field(ghJson(["api", `repos/${i.repo}/compare/${tip}...${i.head}`]), "status");
		if (typeof status !== "string") throw new Error(`gh api repos/${i.repo}/compare/${tip.slice(0, 7)}...${i.head.slice(0, 7)} returned no status`);
		containsTip = status === "ahead" || status === "identical";
	}
	const repair = incidentRepair(i.gh, i.ledger, i.repo, i.pr, i.ref, state);
	let treeEqualsG = false;
	if (repair === "revert") {
		const gTree = chain.find((c) => c.sha === state.g)?.tree ?? null;
		const headTree = field(field(ghJson(["api", `repos/${i.repo}/git/commits/${i.head}`]), "tree"), "sha");
		if (typeof headTree !== "string") throw new Error(`gh api repos/${i.repo}/git/commits/${i.head} returned no tree`);
		treeEqualsG = gTree !== null && headTree === gTree;
	}
	return { decision: mergeGate({ head: i.head, containsTip, state, need: i.need, result: i.result, repair, treeEqualsG }), main };
}

/**
 * Post the gate's state on the head (D4, through #320's mechanism), re-reading activation and authority at publication: off refuses fast/tree
 * plans and applies FULL_SUITE_STATE only to a full Mac result at the head; on uses mergeGate's main policy. Stale snapshots fail closed.
 * Main-result/incident/activation watermarks and mainState's age policy are revalidated locally under the short lock; bulk network stays outside.
 * An unreadable gate posts failure (F7).
 * A post GitHub refuses records `status-failed: <run id> <state> on <sha>: <error>` (F6), leaving the head pending.
 * Lock acquisition/deadline failures instead record status-failed without posting a false test failure. The optional ref resolver
 * runs only for on-mode gate computation, outside the lock; offDescription retains a full result's original publication wording.
 */
export function postGate(i: Omit<GateInput, "ref"> & { ref: string | (() => string); root: string; wl: string; runId: string; log: (s: string) => void; offDescription?: string }): { state: "success" | "failure" | "error"; description: string; error: string | null } {
	// Main-chain/compare/repair reads scale independently of a single status post; never hold the publication mutex for them.
	let onDecision: { state: "success" | "failure"; description: string } | null = null;
	let authority: string | null = null;
	let mainSnapshot: MainSnapshot | null = null;
	try {
		const initial = gateAuthority(i.ledger, i.repo);
		if (initial.on) {
			authority = initial.watermark;
			const snapshot = gateSnapshot({ ...i, ref: typeof i.ref === "function" ? i.ref() : i.ref });
			mainSnapshot = snapshot.main;
			const d = snapshot.decision;
			onDecision = d.state === "success" ? { state: "success", description: d.description } : { state: "failure", description: d.reasons.join("; ") };
		}
	} catch (e) {
		onDecision = { state: "failure", description: `the gate could not read activation, main or the head: ${errText(e)}` };
	}
	let outcome: { state: "success" | "failure" | "error"; description: string; error: string | null };
	try {
		outcome = withFullSuitePublication(i.root, i.repo, (remainingMs) => {
			let decided: { state: "success" | "failure" | "error"; description: string };
			try {
				const current = gateAuthority(i.ledger, i.repo);
				if (!current.on) {
					if (i.need === "fast") decided = { state: "failure", description: "land-first is off: a fast/tree plan is not a full-suite result; request the full suite" };
					else if (i.result?.sha === i.head && i.result.scope === "full" && i.result.host === "mac") {
						decided = { state: FULL_SUITE_STATE[i.result.verdict] ?? "failure", description: i.offDescription ?? `full suite ${i.result.verdict}` };
					} else decided = { state: "failure", description: "land-first is off: a full-suite Mac result at this head is required" };
				} else if (onDecision === null) {
					decided = { state: "failure", description: "land-first activated during publication: request a fresh gate decision" };
				} else if (authority !== null && authority !== current.watermark) {
					decided = { state: "failure", description: "gate authority changed during publication (main results, incident or activation); request a fresh gate decision" };
				} else {
					// No network under the mutex: reapply the existing age policy to exactly the facts the decision used.
					let ageChanged = false;
					if (mainSnapshot !== null) {
						const fresh = mainState(mainSnapshot.chain, mainSnapshot.results, Date.parse(i.ledger.now()));
						ageChanged = fresh.open !== mainSnapshot.state.open || fresh.stop !== mainSnapshot.state.stop || fresh.unknown !== mainSnapshot.state.unknown;
					}
					decided = ageChanged
						? { state: "failure", description: "main age validity changed during publication; request a fresh gate decision" }
						: onDecision;
				}
			} catch (e) {
				decided = { state: "failure", description: `the gate could not read publication authority: ${errText(e)}` };
			}
			i.log(`gate on ${i.head}: ${decided.state}: ${decided.description}`);
			const boundedGh: Gh = (args, timeoutMs = 30_000) => i.gh(args, Math.min(timeoutMs, remainingMs()));
			return { ...decided, error: postStatus(boundedGh, i.repo, decided.state, i.head, decided.description, i.log) };
		});
	} catch (e) {
		const error = errText(e);
		i.log(`gate publication on ${i.head} not posted: ${error}; status unchanged; retry publication`);
		outcome = { state: "error", description: "publication unavailable; status unchanged", error };
	}
	// Audit outside the short holder section. Mutex acquisition is publication failure, never a failed test or unreadable gate.
	if (outcome.error !== null) recordStatusFailure(i, outcome.state, outcome.error);
	return outcome;
}

function recordStatusFailure(i: { ledger: Ledger; wl: string; runId: string; head: string; log: (s: string) => void }, state: string, error: string): void {
	try {
		i.ledger.write(() => i.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: i.wl, kind: "assumption", body: `status-failed: ${i.runId} ${state} on ${i.head}: ${error.replace(/\s+/g, " ")}`,
		}));
	} catch (receiptError) {
		throw new AggregateError([new Error(error), receiptError], `publication failed: ${error}; status-failed receipt on ${i.wl} not recorded: ${errText(receiptError)}; repair ledger writes and retry publication`);
	}
}

/**
 * Revoke every open success (§ 2 Revocation): each open PR head of `repo` whose newest `as2/full-suite` is a success that is not the
 * gate's repair (`repair: …`) gets failure `landing stopped: <reason>`. One attempt per head; a failure is logged, and the tick's pass
 * revokes what is still owed (D6). Never throws: a list GitHub cannot answer is logged and revokes nothing.
 */
export function revokeOpen(gh: Gh, repo: string, reason: string, log: (s: string) => void, publish?: (head: string) => string | null | false): { revoked: number[]; failed: number[] } {
	const out = { revoked: [] as number[], failed: [] as number[] };
	let list: unknown;
	try {
		list = ghJsonOf(gh, ["pr", "list", "-R", repo, "--state", "open", "--json", "number,headRefOid", "--limit", "500"]);
		if (!Array.isArray(list)) throw new Error(`gh pr list -R ${repo} returned an unexpected shape`);
	} catch (e) {
		log(`revocation on ${repo} not attempted: ${errText(e)}; the tick revokes what is owed on its next pass`);
		return out;
	}
	for (const p of list as unknown[]) {
		const n = field(p, "number");
		const head = field(p, "headRefOid");
		if (typeof n !== "number" || typeof head !== "string" || !SHA40.test(head)) {
			log(`revocation on ${repo}: gh pr list named a PR with no number or head; skipped`);
			continue;
		}
		let newest: unknown;
		try {
			const statuses = ghJsonOf(gh, ["api", `repos/${repo}/commits/${head}/statuses`]);
			if (!Array.isArray(statuses)) throw new Error(`gh api repos/${repo}/commits/${head}/statuses returned an unexpected shape`);
			newest = statuses.find((s) => field(s, "context") === FULL_SUITE_STATUS);
		} catch (e) {
			log(`revocation of #${n} at ${head.slice(0, 7)} not attempted: ${errText(e)}`);
			out.failed.push(n);
			continue;
		}
		const description = field(newest, "description");
		if (field(newest, "state") !== "success" || (typeof description === "string" && description.startsWith("repair:"))) continue;
		if (publish) hookSync(repo.replaceAll("/", "_"), "main-revocation-head", { head, pr: n });
		try {
			const error = publish ? publish(head) : postStatus(gh, repo, "failure", head, `landing stopped: ${reason}`, log);
			if (error === null) out.revoked.push(n);
			else if (error !== false) out.failed.push(n);
		} catch (e) {
			log(`revocation of #${n} at ${head.slice(0, 7)} not posted under publication mutex: ${errText(e)}; the tick must reconcile`);
			out.failed.push(n);
		}
	}
	return out;
}

/** What the hosted fast check answered: its artifact downloaded into `dir`, or why the one Mac fallback runs instead (D4). */
export type HostedFast = { ok: true; workflowRunId: number; dir: string } | { ok: false; reason: string };
export interface HostedFastDeps {
	gh: Gh;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (s: string) => void;
}
/** The fast check's workflow (D3), dispatched on the verified tag. */
export const FAST_WORKFLOW = "as2-fast.yml";

/**
 * The hosted fast check (D4): dispatch `as2-fast.yml` on `as2-verified` with inputs `sha`, `files` (space-separated `./<path>`) and
 * `request` (the run id), taking `workflow_run_id` from the answer; poll the run every `pollMs` until it completes or `waitMs` passes;
 * then download its artifact `as2-fast-<request>` (fast.xml, fast.log, fast.summary) into `dir`. A dispatch GitHub refuses (the tag
 * unreadable included), a run whose `head_sha` is not the tag's commit, or no result in time is `ok: false` with the reason, and the
 * caller runs the set once on the Mac: the hosted run is never retried. A poll GitHub cannot answer is logged and polled again.
 */
export async function hostedFast(d: HostedFastDeps, o: { repo: string; runId: string; sha: string; files: readonly string[]; waitMs: number; pollMs: number; dir: string }): Promise<HostedFast> {
	const start = d.now();
	let tag: string | null;
	try {
		tag = verifiedTagOf(d.gh, o.repo);
	} catch (e) {
		return { ok: false, reason: `dispatch failed: the ${AS2_VERIFIED_TAG} tag could not be read: ${errText(e)}` };
	}
	if (tag === null) return { ok: false, reason: `dispatch failed: ${o.repo} has no ${AS2_VERIFIED_TAG} tag` };
	const dispatch = d.gh([
		"api", "-X", "POST", `repos/${o.repo}/actions/workflows/${FAST_WORKFLOW}/dispatches`, "-f", `ref=${AS2_VERIFIED_TAG}`, "-f", `inputs[sha]=${o.sha}`,
		"-f", `inputs[files]=${o.files.map((f) => `./${f}`).join(" ")}`, "-f", `inputs[request]=${o.runId}`, "-F", "return_run_details=true",
	]);
	if (dispatch.code !== 0) return { ok: false, reason: `dispatch failed: ${ghWhy(dispatch)}` };
	let id: unknown;
	try {
		id = field(JSON.parse(dispatch.stdout), "workflow_run_id");
	} catch {
		id = undefined;
	}
	if (typeof id !== "number" || !Number.isSafeInteger(id)) return { ok: false, reason: "dispatch failed: the answer names no workflow_run_id" };
	d.log(`fast check dispatched: workflow run ${id} on ${AS2_VERIFIED_TAG} (${tag.slice(0, 12)})`);
	let status = "unknown";
	for (;;) {
		const r = d.gh(["api", `repos/${o.repo}/actions/runs/${id}`]);
		if (r.code === 0) {
			let v: unknown = null;
			try {
				v = JSON.parse(r.stdout);
			} catch {
				d.log(`fast check poll of run ${id}: the answer is no json`);
			}
			const headSha = field(v, "head_sha");
			if (typeof headSha === "string" && headSha !== tag) return { ok: false, reason: `run ${id} ran workflow code at ${headSha.slice(0, 12)}, not ${AS2_VERIFIED_TAG} ${tag.slice(0, 12)}` };
			const s = field(v, "status");
			if (typeof s === "string") status = s;
			if (status === "completed" && typeof headSha === "string") break;
		} else d.log(`fast check poll of run ${id} failed: ${ghWhy(r)}`);
		if (d.now() - start >= o.waitMs) return { ok: false, reason: `no result in ${Math.round(o.waitMs / 60_000)} min (run ${id} ${status})` };
		await d.sleep(Math.max(1, Math.min(o.pollMs, start + o.waitMs - d.now())));
	}
	const dl = d.gh(["run", "download", String(id), "-R", o.repo, "-n", `as2-fast-${o.runId}`, "-D", o.dir], 120_000);
	if (dl.code !== 0) return { ok: false, reason: `no result: artifact as2-fast-${o.runId} of run ${id} not downloaded: ${ghWhy(dl)}` };
	return { ok: true, workflowRunId: id, dir: o.dir };
}

/**
 * The fast set's executed counts (R12): of the Linux `files`, how many show an executed test in the JUnit, and the ones that show
 * none. Any such file fails the check. A report that does not parse is an error, never zero counts.
 */
export function fastExec(junit: string, files: readonly string[]): { ok: true; exec: ExecCounts; missing: string[] } | { ok: false; error: string } {
	const e = execOf(junit, files);
	if (!e.ok) return e;
	return { ok: true, exec: e.exec, missing: files.filter((f) => !e.perFile.has(f)) };
}

/** The hosted fast check's poll period (D4); AGENT_SYSTEM_TEST_RUNNER_FAST_POLL_MS in tests. */
const FAST_POLL_MS = 15_000;

/** `fast-fallback: <run id> <reason>` (D4, F5, F10): the hosted fast check gave no usable answer, so the set runs once on the Mac. */
export function fastFallbackBody(runId: string, reason: string): string {
	if (!RUN_ID_RE.test(runId)) throw new Error(`fast-fallback: ${runId} is not a run id`);
	const why = reason.replace(/\s+/g, " ").trim();
	if (why === "") throw new Error(`fast-fallback: ${runId} names no reason`);
	return `fast-fallback: ${runId} ${why}`;
}

/** The hosted run's `fast.summary` (D3, `.github/workflows/as2-fast.yml`): `request <run id> sha <sha> files <n> exit <code> wall <s> s`. */
export interface FastSummary {
	request: string;
	sha: string;
	files: number;
	exit: number;
	wallS: number;
}
/** `fast.summary`'s one line read, or null when the text is not that line. */
export function parseFastSummary(text: string): FastSummary | null {
	const m = /^request (tr-[a-z0-9]+) sha ([0-9a-f]{40}) files (\d+) exit (\d+) wall (\d+) s$/.exec(text.trim());
	if (!m) return null;
	return { request: m[1]!, sha: m[2]!, files: Number(m[3]), exit: Number(m[4]), wallS: Number(m[5]) };
}

/** What the fast check found beyond its part's counts (D4, R12): parse targets that do not transpile, and planned files with no executed test. */
export interface FastFindings {
	parse: readonly { path: string; error: string }[];
	missing: readonly string[];
}
/** The part a parse-check failure stands in for (nothing ran), so decideRun still checks the fetch, the head and the owner. */
const NOTHING_RAN: PartResult = { pass: 0, fail: 0, skip: 0, exit: 0, ms: 0, error: null, failures: [] };
/**
 * The fast run's decision (D4, R12): decideRun over the run's facts, a parse-check failure standing in for the part that never ran;
 * then a parse target that does not transpile, or a planned Linux file with no executed test, makes a green or red run red, each
 * named in the reason. A red never settles. A superseded or stale decision stands; an error keeps its verdict with them appended.
 */
export function fastDecision(f: RunFacts, found: FastFindings): RunDecision {
	const d = decideRun(found.parse.length > 0 && f.full === null ? { ...f, full: NOTHING_RAN } : f);
	if (d.verdict === "superseded" || d.outcome === "stale") return d;
	const parse = found.parse.length === 0 ? null : `parse check failed: ${found.parse.map((p) => `${p.path} ${p.error}`).join("; ")}`;
	const missing = found.missing.length === 0 ? null : `no executed test in the fast set's ${found.missing.join(", ")}`;
	const extra = [parse, missing].filter((s) => s !== null).join("; ");
	if (extra === "") return d;
	const reason = d.reason === null ? extra : `${d.reason}; ${extra}`;
	if (d.outcome === "green" || d.outcome === "red") return { verdict: "red", outcome: "red", reason, settle: false };
	return { ...d, reason };
}

/** A main run is re-requested only by the tick (D6); its queue key is moved this far ahead of every PR request, so it takes the Mac slot first (D5). */
const MAIN_QUEUE_LEAD_MS = 1e12;
/** Run directories a main run, a `main-red:` row or an open incident cites are kept this long, outside KEEP_RUNS (D5, R16). */
export const CITED_KEEP_MS = 30 * 86_400_000;

/**
 * The run ids retention keeps outside KEEP_RUNS (D5, R16), from the standing workload's entries: every main run requested in the last
 * 30 days, every run a runner `main-red:` row of the last 30 days names, and, while a stop episode (an open incident) is open on a
 * repository, every main run and `main-red:` run since that episode was raised, however old.
 */
export function citedRuns(entries: readonly EntryRow[], nowMs: number): Set<string> {
	const out = new Set<string>();
	const opened = new Map<string, number>();
	for (const r of landFirstRows(entries)) {
		if (opened.has(r.repo)) continue;
		const ep = stopEpisode(landFirstRows(entries, r.repo));
		// StopEpisode's `raised` type narrows to never (merge-train.ts extracts one event from a two-event member); the row is a LandFirstRow.
		const raised = ep?.raised as LandFirstRow | undefined;
		if (raised !== undefined) opened.set(r.repo, Date.parse(raised.createdAt));
	}
	const since = Math.min(nowMs - CITED_KEEP_MS, ...opened.values());
	for (const rec of testRuns(entries)) {
		if (rec.request.main !== undefined && Date.parse(rec.request.createdAt) >= since) out.add(rec.request.runId);
	}
	for (const e of entries) {
		if (e.created_by !== TEST_RUNNER_BY || !e.body.startsWith("main-red:") || Date.parse(e.created_at) < since) continue;
		for (const id of e.body.match(/\btr-[a-z0-9]+\b/g) ?? []) out.add(id);
	}
	return out;
}
/** Retention's prune list (§ 2.3 step 9, R16): the runs past the newest KEEP_RUNS among those no main run, `main-red:` or open incident cites; never `self`. */
export function retentionPrune(runs: readonly { id: string; at: number }[], cited: ReadonlySet<string>, self: string): string[] {
	return pruneRuns(runs.filter((r) => !cited.has(r.id)), KEEP_RUNS).filter((id) => id !== self);
}

/** A main request's answer (`main --repo --sha`, D5): what it did, for the one line the tick logs. */
export type MainAdmission =
	| { action: "verdict" | "active" | "pending-same" | "pending"; line: string }
	| { action: "admitted"; runId: string; line: string };

/** Durable regression facts beside the main TestRun; not the holder's issue-url `main-red:` row. */
export interface MainRedFacts {
	repo: string;
	sha: string;
	runId: string;
	verdict: "red" | "implausible";
	suspects: string[];
	failing: string[];
	attribution: { sha: string; files: string[] }[];
}
export function mainRedFactsBody(facts: MainRedFacts): string {
	return `main-red: ${facts.repo.toLowerCase()} ${JSON.stringify(facts)}`;
}

/** Promotion and self-check use the same root; overrides are only for isolated process fixtures. */
export function verifiedDirectory(): string {
	return process.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED || join(homedir(), ".agent-system-2", "verified");
}
function controlCheckout(): string { return process.env.AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT || REPO_ROOT; }

/** Trusted git, bounded, with no caller gitconfig, hooks or templates. */
function verifierGit(cwd: string, args: string[], deadline = Infinity): string {
	const r = spawnSync(["git", "-C", cwd, ...NETWORK, ...args], {
		env: trustedEnv("/dev/null"), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: verifierTimeout(deadline, 120_000, `git ${args.join(" ")} in ${cwd}`),
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.exitedDueToTimeout ? "timed out within the verifier operation/holder budget" : r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
	return r.stdout.toString().trim();
}
function resolvedCurrent(dir: string): string | null {
	try { return realpathSync(join(dir, "current")); }
	catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export function runnerControlRoot(root = controlCheckout(), dir = verifiedDirectory(), deadline = Infinity): ControlRoot {
	const own = realpathSync(root);
	const current = resolvedCurrent(dir);
	return {
		root: own, head: verifierGit(own, ["rev-parse", "HEAD"], deadline),
		modified: verifierGit(own, ["status", "--porcelain", "--untracked-files=no"], deadline).split("\n").filter(Boolean),
		current, currentHead: current === null ? null : verifierGit(current, ["rev-parse", "HEAD"], deadline),
		repo: ownerRepoOf(originOf(own, deadline) ?? "")?.toLowerCase() ?? null,
	};
}
/** Publish only a lightweight commit tag, after the root. A read-after-write makes partial failures safely retryable. */
export function pointVerifiedTag(gh: Gh, repo: string, sha: string): void {
	const old = verifiedTagOf(gh, repo);
	if (old === sha) return;
	const path = `repos/${repo}/git/${old === null ? "refs" : `refs/tags/${AS2_VERIFIED_TAG}`}`;
	const args = old === null
		? ["api", "-X", "POST", path, "-f", `ref=refs/tags/${AS2_VERIFIED_TAG}`, "-f", `sha=${sha}`]
		: ["api", "-X", "PATCH", path, "-f", `sha=${sha}`, "-F", "force=true"];
	const r = gh(args);
	if (r.code !== 0) throw new Error(`updating ${AS2_VERIFIED_TAG} on ${repo}: ${ghWhy(r)}; retry promote --sha ${sha}`);
	if (verifiedTagOf(gh, repo) !== sha) throw new Error(`${AS2_VERIFIED_TAG} on ${repo} did not resolve to ${sha} after update; retry promotion`);
}


/** The activation receipt is earned from actual filesystem/tag/helper facts, even in shadow mode. */
export function verifiedPreflight(
	ledger: Ledger, repo: string, source: string | null, helper: string, gh: Gh = realGh,
	root = controlCheckout(), directory = verifiedDirectory(), deadline = Infinity,
): string[] {
	try {
		const facts = runnerControlRoot(root, directory, deadline);
		const refusal = controlRootRefusal(facts, ledger.entries(STANDING_WORKLOAD_ID));
		if (refusal.length > 0) return refusal;
		const tag = verifiedTagOf(verifierGh(deadline, gh), repo);
		if (tag !== facts.currentHead) refusal.push(`${AS2_VERIFIED_TAG} ${tag ?? "missing"} does not name current ${facts.currentHead}`);
		if (source !== facts.currentHead) refusal.push(`bundle SOURCE ${source ?? "unreadable"} does not equal current/tag commit ${facts.currentHead}`);
		if (!readFileSync(helper, "utf8").includes(`refs/tags/${AS2_VERIFIED_TAG}:refs/tags/${AS2_VERIFIED_TAG}`)) refusal.push(`refresh helper ${helper} does not fetch refs/tags/${AS2_VERIFIED_TAG}; rerun install/as2test-setup.sh`);
		return refusal;
	} catch (e) { return [`verified preflight could not read root/tag/helper: ${errText(e)}`]; }
}
/** Both CLIs share the verdict guard; manual alone may cross schema commits after Jo's live migration. */
export function promoteVerified(sha: string, manual = false): number {
	if (!SHA40.test(sha)) throw new Fail(`promotion requires a full commit sha: ${sha}`, START_EXIT.usage);
	const repo = ownerRepoOf(originOf(controlCheckout()) ?? "");
	if (repo === null) throw new Fail(`cannot identify GitHub repository of ${controlCheckout()}; nothing promoted`, START_EXIT.failed);
	const ledger = openLedger();
	try {
		const r = promoteMain(ledger, repo, sha, (s) => process.stderr.write(`${s}\n`), { manual });
		if (!r.ok) throw new Fail(r.reason, START_EXIT.failed);
		process.stdout.write(r.schema === null ? `promoted ${r.sha}\n` : `schema ${r.schema}\n`);
		return START_EXIT.ok;
	} finally { ledger.db.close(); }
}
export type Promotion = { ok: true; sha: string; schema: string | null } | { ok: false; reason: string };
export interface PromotionOptions { directory?: string; origin?: string; gh?: Gh; manual?: boolean }
/**
 * One protected holder may need a complete refresh (including signal/reap waits) plus the existing finalization budget
 * for verifier git/GitHub work. Waiters allow that same bounded work, not the old five-second SQLite default.
 * The existing refresh/finalization test overrides shorten both budgets; there is no independent retry or config knob.
 */
function promotionBudgetMs(): number {
	return msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS", REFRESH_TIMEOUT_MS)
		+ msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS", REFRESH_KILL_GRACE_MS)
		+ msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS", REFRESH_REAP_MS)
		+ msEnv("AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS", FINALIZE_MS);
}
function verifierTimeout(deadline: number, cap: number, operation: string): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Stop(`verified reconciliation/promotion holder deadline exceeded before ${operation}; retry after inspecting the verifier`);
	return Math.min(cap, remaining);
}
/** Bound every GitHub call to the holder's single deadline, retaining the normal per-operation cap. */
function verifierGh(deadline: number, gh: Gh = realGh): Gh {
	return (args, timeoutMs = 30_000) => gh(args, verifierTimeout(deadline, timeoutMs, `gh ${args.join(" ")}`));
}

/** One serialization store for promotion and preflight's current/tag/bundle reconciliation. Caller closes even a failed BEGIN. */
function openPromotionDb(directory: string): Database {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (realpathSync(directory) !== directory) throw new Error(`verified directory ${directory} is a symlink; refusing reconciliation`);
	return new Database(join(directory, "promotion.db"));
}

/**
 * D5/R14/R15: immutable main verdict -> detached release -> atomic current -> tag -> retention.
 * The SQLite write lock serializes publishers and disappears on process death. No live ledger migration is attempted.
 * A stopped schema crossing is the tick's existing `schema <sha>` contract (it owns the issue and notice).
 */
export function promoteMain(ledger: Ledger, repo: string, sha: string, log: (s: string) => void, o: PromotionOptions = {}): Promotion {
	let db: Database | null = null;
	try {
		if (!SHA40.test(sha) || mainVerdicts(mainResults(ledger.entries(STANDING_WORKLOAD_ID))).get(sha)?.verdict !== "green") {
			throw new Error(`${sha} has no green believable main verdict; nothing promoted`);
		}
		const dir = resolve(o.directory ?? verifiedDirectory());
		db = openPromotionDb(dir);
		hookMark(sha, "promotion-acquiring");
		db.exec(`PRAGMA busy_timeout = ${Math.trunc(promotionBudgetMs())}; BEGIN IMMEDIATE`);
		const deadline = Date.now() + promotionBudgetMs();
		const git = (cwd: string, args: string[]) => verifierGit(cwd, args, deadline);
		const clone = join(dir, "repo");
		const origin = o.origin ?? process.env.AGENT_SYSTEM_TEST_RUNNER_ORIGIN ?? `https://github.com/${repo}.git`;
		if (!existsSync(clone)) git(dir, ["clone", "--no-checkout", "--no-local", "--template=", origin, clone]);
		if (realpathSync(clone) !== clone || git(clone, ["rev-parse", "--show-toplevel"]) !== clone) throw new Error(`dedicated verified clone ${clone} is not its own root`);
		const configuredOrigin = git(clone, ["config", "--get", "remote.origin.url"]);
		if (configuredOrigin !== origin && ownerRepoOf(configuredOrigin)?.toLowerCase() !== repo.toLowerCase()) throw new Error(`verified clone ${clone} has a different origin than ${origin}`);
		git(clone, ["fetch", "--no-tags", origin, sha]);
		if (git(clone, ["rev-parse", `${sha}^{commit}`]) !== sha) throw new Error(`fetched promotion target is not ${sha}`);
		const current = resolvedCurrent(dir);
		const before = current === null ? null : git(current, ["rev-parse", "HEAD"]);
		if (!o.manual && before !== null && before !== sha) {
			const chain = git(clone, ["rev-list", "--first-parent", "--reverse", sha]).split("\n");
			const at = chain.indexOf(before);
			if (at < 0) throw new Error(`current ${before} is not on ${sha}'s first-parent chain; manual repair required`);
			for (const next of chain.slice(at + 1)) {
				const diff = git(clone, ["diff", `${next}^1`, next, "--", "ledger/schema.sql"]);
				const version = git(clone, ["diff", "--unified=0", `${next}^1`, next, "--", "ledger/src/index.ts"]);
				if (diff || version.split("\n").some((l) => /^[+-](?![+-])/.test(l) && /\bSCHEMA_VERSION\b/.test(l))) {
					log(`verifier-stalled: schema change at ${next}; Jo must migrate the ledger and run promote-verified.ts with a verified sha`);
					ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `verifier-stalled: ${repo.toLowerCase()} ${sha} schema ${next}` });
					return { ok: true, sha: before, schema: next };
				}
			}
		}
		const release = join(dir, sha.slice(0, 12));
		if (!existsSync(release)) git(clone, ["worktree", "add", "--detach", release, sha]);
		if (realpathSync(release) !== release || git(release, ["rev-parse", "HEAD"]) !== sha
			|| git(release, ["rev-parse", "--git-common-dir"]) !== join(clone, ".git")
			|| git(release, ["status", "--porcelain", "--untracked-files=no"]) !== "") throw new Error(`verified release ${release} is foreign, dirty or names another commit; repair it before retrying`);
		const link = join(dir, `.current-${process.pid}`);
		// A crashed publisher may leave only this symlink. Never replace a directory or an unrelated file.
		if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } })()) {
			if (!lstatSync(link).isSymbolicLink()) throw new Error(`promotion staging path ${link} is not a symlink`);
			rmSync(link);
		}
		symlinkSync(release, link);
		renameSync(link, join(dir, "current"));
		pointVerifiedTag(verifierGh(deadline, o.gh), repo, sha);
		// Only registered, owned detached worktrees directly below this root may be removed.
		const releases = git(clone, ["worktree", "list", "--porcelain"]).split("\n\n").flatMap((block) => {
			const path = /^worktree (.+)$/m.exec(block)?.[1];
			return path && dirname(path) === dir && /^[0-9a-f]{12}$/.test(path.slice(dir.length + 1)) && /^detached$/m.test(block) ? [path] : [];
		}).sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
		const keep = new Set(releases.slice(0, 3));
		keep.add(release); // A manual rollback may make current older than the newest three; never delete it.
		for (const path of releases) {
			if (keep.has(path) || resolvedCurrent(dir) === path) continue;
			if (realpathSync(path) !== path || git(path, ["rev-parse", "--git-common-dir"]) !== join(clone, ".git")) throw new Error(`refusing retention of foreign worktree ${path}`);
			git(clone, ["worktree", "remove", path]);
		}
		log(`promoted ${sha}`);
		return { ok: true, sha, schema: null };
	} catch (e) {
		const reason = errText(e).replace(/\s+/g, " ");
		log(`verifier-stalled: ${sha}: ${reason}`);
		try { ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `verifier-stalled: ${repo.toLowerCase()} ${sha} ${reason}` }); }
		catch (recordError) { log(`verifier-stalled record failed: ${errText(recordError)}; original promotion failure: ${reason}`); }
		return { ok: false, reason };
	} finally {
		db?.close();
	}
}

/**
 * D5's main request at `sha` of `repo`, in one ledger transaction on the standing workload: nothing when `sha` has a verdict; refused
 * (Fail, refused) when its attempt block is exhausted (`attemptBlock`, reopened by Jo's `main-retry:`); every main request of the
 * repo with no settle and no live heartbeat settled `runner died` first; nothing when `sha` is the active run or the pending target;
 * with another run active, `sha` replaces the pending target (runs.db `main_pending`), and the active run is never cancelled; with
 * none active, the `test-requested: … main=1 repo=<repo>` admitting it. The caller spawns the admitted run.
 */
export function admitMain(ledger: Ledger, lockDb: Database, root: string, repo: string, sha: string, by: string): MainAdmission {
	if (ledger.workload(STANDING_WORKLOAD_ID) === null) throw new Fail(`no standing workload ${STANDING_WORKLOAD_ID}: a main run is recorded there`, START_EXIT.failed);
	const want = repo.toLowerCase();
	const admission = ledger.write((): MainAdmission | Fail => {
		const entries = ledger.entries(STANDING_WORKLOAD_ID);
		const results = mainResults(entries);
		const verdict = mainVerdicts(results).get(sha);
		if (verdict !== undefined) {
			busyLoop(() => lockDb.query("DELETE FROM main_pending WHERE repo = ? AND sha = ?").run(want, sha));
			return { action: "verdict", line: `main ${sha} has its verdict ${verdict.verdict} (run ${verdict.runId}); nothing requested` };
		}
		const now = Date.parse(ledger.now());
		let active: RunRecord | null = null;
		for (const rec of testRuns(entries)) {
			if (rec.request.main?.repo.toLowerCase() !== want || rec.results.length > 0) continue;
			if (recordLive(rec, heartbeatOf(root, rec.request.runId), now)) active = rec;
			else ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: testRunBody(diedRun(rec.request, runDirOf(root, rec.request.runId))) });
		}
		const block = attemptBlock(sha, mainResults(ledger.entries(STANDING_WORKLOAD_ID)), mainRetries(entries, ledger.instructions(STANDING_WORKLOAD_ID), repo));
		if (block.exhausted) return new Fail(`main ${sha} has spent attempt block ${block.block} (${block.attempts} inconclusive runs): fix the runner, then Jo says main-retry ${repo}`, START_EXIT.refused);
		if (active !== null) {
			if (active.request.sha === sha) return { action: "active", line: `main ${sha} is the active main run ${active.request.runId}; nothing requested` };
			const pending = busyLoop(() => lockDb.query<{ sha: string }, [string]>("SELECT sha FROM main_pending WHERE repo = ?").get(want));
			if (pending?.sha === sha) return { action: "pending-same", line: `main ${sha} is already the pending target behind ${active.request.runId}; nothing requested` };
			busyLoop(() => lockDb.query("INSERT OR REPLACE INTO main_pending (repo, sha, at) VALUES (?, ?, ?)").run(want, sha, now));
			return { action: "pending", line: `main ${sha} is the pending target behind the active run ${active.request.runId}${pending ? ` (replacing ${pending.sha})` : ""}` };
		}
		const runId = makeRunId(Date.now(), Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""));
		const request: TestRequested = { runId, pr: 0, sha, slice: `sl-main-${runId.slice(3)}`, by, main: { repo } };
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: testRequestedBody(request) });
		busyLoop(() => lockDb.query("DELETE FROM main_pending WHERE repo = ?").run(want));
		return { action: "admitted", runId, line: `main ${sha} admitted as run ${runId}` };
	});
	if (admission instanceof Fail) throw admission;
	return admission;
}

/**
 * `reap` (D6, R37): every open workload's runner request with no settle and no live heartbeat (`recordLive`) settled `runner died`,
 * each workload in its own transaction that re-reads its rows. It admits nothing; none to settle is a no-op. Returns the settled run
 * ids and, for each workload whose transaction failed, `<wl>: <error>`; one failed workload never stops the others.
 */
export function reap(ledger: Ledger, root: string): { settled: string[]; failed: string[] } {
	const wls = ledger.db.query<{ workload_id: string }, [string]>(
		"SELECT DISTINCT workload_id FROM entries WHERE kind = 'assumption' AND created_by = ? AND body LIKE 'test-requested: %'",
	).all(TEST_RUNNER_BY).map((r) => r.workload_id);
	const settled: string[] = [];
	const failed: string[] = [];
	for (const wl of wls) {
		try {
			if (ledger.workload(wl)?.status !== "open") continue;
			settled.push(...ledger.write(() => {
				const now = Date.parse(ledger.now());
				const out: string[] = [];
				for (const rec of testRuns(ledger.entries(wl))) {
					if (rec.results.length > 0 || recordLive(rec, heartbeatOf(root, rec.request.runId), now)) continue;
					ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sliceOf(rec.request), kind: "assumption", body: testRunBody(diedRun(rec.request, runDirOf(root, rec.request.runId))) });
					out.push(rec.request.runId);
				}
				return out;
			}));
		} catch (e) {
			failed.push(`${wl}: ${errText(e)}`);
		}
	}
	return { settled, failed };
}

/**
 * The detached `run <run id>` (the starter's and a main admission's spawn): its log is `<run dir>/runner.log`, and `runner.json`
 * names its pid. Throws when the process cannot start.
 */
function spawnRunner(runDir: string, runId: string): number {
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const fd = openSync(join(runDir, "runner.log"), "a", 0o600);
	try {
		const child = spawn([process.execPath, import.meta.path, "run", runId], { cwd: runDir, env: process.env, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
		child.unref();
		writeFileSync(join(runDir, "runner.json"), `${JSON.stringify({ pid: child.pid, pgid: child.pid, runId })}\n`, { mode: 0o600 });
		return child.pid;
	} finally {
		closeSync(fd);
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
function carryAuthority(ledger: Ledger, sources: readonly string[], pr: number, fullOnly = false): ResultRecord | null {
	const rows = ledger.db.query<EntryRow, string[]>(`SELECT * FROM entries WHERE workload_id IN (${sources.map(() => "?").join(", ")}) ORDER BY created_at, rowid`).all(...sources);
	const records = testRuns(rows);
	const last = authoritativeRun(records, pr);
	const on = last === null ? undefined : rows.find((e) => e.id === last.request.entryId)?.workload_id;
	const own = on === undefined ? null : (testRuns(ledger.entries(on)).find((r) => r.request.runId === last!.request.runId)?.result ?? null);
	if (own?.verdict !== "green") return null;
	if (fullOnly) {
		// A tree plan copies full/Mac counts without executing them. Follow decision-log carries back to their execution authority.
		const seen = new Set<string>();
		let source = own;
		for (;;) {
			if (seen.has(source.runId) || source.scope !== "full" || source.host !== "mac" || source.verdict !== "green") return null;
			seen.add(source.runId);
			const plan = fastPlanOf(rows, source.runId);
			if (plan !== null && plan.scope !== "full") return null;
			if (source.reason?.startsWith("carried from main run ")) return null;
			const carried = /^carried from (tr-[a-z0-9]+) at [0-9a-f]{40} \(decision-log only\)$/.exec(source.reason ?? "");
			if (carried === null) break;
			const previous = records.find((r) => r.request.runId === carried[1])?.result;
			if (!previous) return null;
			source = previous;
		}
	}
	return own;
}

/**
 * D4b, before any transaction (no gh call holds the ledger's lock): the authority's green at S when the PR's head `head` is S
 * (`identical`, no gh call) or passes `decisionLogFault` on GitHub's compare of the two (`ghCompare`); else null, and the request
 * runs as any other. A compare GitHub cannot answer completely, or a gh call that fails, carries nothing.
 */
function carryCandidate(ledger: Ledger, sources: readonly string[], pr: number, head: string, ownerRepo: string): ResultRecord | null {
	const from = carryAuthority(ledger, sources, pr, !landFirstNow(ledger, ownerRepo));
	if (from === null) return null;
	try {
		const c = ghCompare(ownerRepo, from.sha, head, ghJson);
		return decisionLogFault(c.ok ? c.compare : null) === null ? from : null;
	} catch {
		return null;
	}
}

/** The mirror's git env (`trustedEnv`) over an empty gitconfig under the runs root. */
function mirrorEnv(root: string): Record<string, string> {
	const gitconfig = join(root, "mirror", "trusted.gitconfig");
	if (!existsSync(gitconfig)) {
		mkdirSync(dirname(gitconfig), { recursive: true, mode: 0o700 });
		writeFileSync(gitconfig, "", { mode: 0o600 });
	}
	return trustedEnv(gitconfig);
}

/** A land-first admission's decision (D4): the plan, and for a tree carry G's green main run, which is the head's result. */
export interface LandAdmission {
	plan: FastPlan;
	carryFrom: ResultRecord | null;
}

/**
 * D4's admission reads for PR `pr` at `head` on a land-first repository, before any transaction: the PR head and main fetched into the
 * runs root's mirror under `refs/as2/<run id>/`; a tree carry when X's tree is G's tree (`readMain`; a main GitHub cannot read carries
 * nothing, logged); else the fast set over the tree at X against its merge-base with main (`fastSet`), or the full suite by exception.
 * The mirror refs are dropped before it returns. A head that moved since the PR view, or a fast set the config cannot compute, refuses.
 */
function landAdmission(o: {
	ledger: Ledger; root: string; ownerRepo: string; url: string; runId: string; pr: number; head: string; ref: string; config: TestRunnerConfig;
	log: (s: string) => void;
}): LandAdmission {
	const env = mirrorEnv(o.root);
	const mirror = mirrorOf(o.root, o.ownerRepo, env);
	const headRef = `refs/as2/${o.runId}/head`;
	const mainRef = `refs/as2/${o.runId}/main`;
	try {
		try {
			gitSync(mirror, [...NETWORK.slice(NO_HOOKS.length), "fetch", "-q", "--no-tags", o.url, `+refs/pull/${o.pr}/head:${headRef}`, `+refs/heads/${DEFAULT_BRANCH}:${mainRef}`], env, { timeoutMs: 600_000 });
		} catch (e) {
			throw new Fail(`the fast plan could not fetch PR #${o.pr} and ${DEFAULT_BRANCH} from ${o.ownerRepo}: ${errText(e)}`, START_EXIT.failed);
		}
		const x = gitSync(mirror, ["rev-parse", "--verify", `${headRef}^{commit}`], env).toString().trim();
		if (x !== o.head) throw new Fail(`PR #${o.pr}'s head moved to ${x} after it was read at ${o.head}; request again`, START_EXIT.refused);
		try {
			const { chain, state, results } = readMain(realGh, o.ledger, o.ownerRepo);
			const gTree = state.g === null ? null : (chain.find((c) => c.sha === state.g)?.tree ?? null);
			if (state.g !== null && gTree !== null && gTree === gitSync(mirror, ["rev-parse", "--verify", `${x}^{tree}`], env).toString().trim()) {
				const verdict = mainVerdicts(results).get(state.g);
				const from = verdict === undefined ? undefined : results.find((r) => r.runId === verdict.runId);
				if (from !== undefined) return { plan: { ref: o.ref, scope: "tree", g: state.g, run: from.runId }, carryFrom: from };
			}
			const repair = incidentRepair(realGh, o.ledger, o.ownerRepo, o.pr, o.ref, state);
			if (repair !== null) return {
				plan: { ref: o.ref, scope: "full", reasons: [repair === "revert" ? "incident-designated partial revert requires the full Mac suite" : "incident-designated named fix requires the full Mac suite"] },
				carryFrom: null,
			};
		} catch (e) {
			throw new Fail(`the fast plan could not read main or its designated repair: ${errText(e)}`, START_EXIT.failed);
		}
		const mergeBase = gitSync(mirror, ["merge-base", x, mainRef], env).toString().trim();
		const changed = gitSync(mirror, ["diff", "--no-renames", "--name-only", "-z", mergeBase, x], env).toString("utf8").split("\0").filter((p) => p !== "");
		const tree = treeAt(mirror, x, env, true);
		const base = treeAt(mirror, mergeBase, env, false);
		let s: FastRun | FullRun;
		try {
			s = fastSet(changed, tree.files, tree.read, base.read, o.config);
		} catch (e) {
			if (e instanceof FastSetError) throw new Fail(e.message, START_EXIT.refused);
			throw e;
		}
		const plan: FastPlan = s.kind === "fast" ? { ref: o.ref, scope: "fast", files: s.files, parse: s.parse, macOnly: s.macOnly } : { ref: o.ref, scope: "full", reasons: s.reasons };
		return { plan, carryFrom: null };
	} finally {
		dropRunRefs(mirror, o.runId, env, o.log);
	}
}

/**
 * A tree carry's green (D4, § 2 The merge gate): head X's tree is G's tree, so G's green main run `from` is X's result with no run:
 * its counts, run dir, scope and host, reason `carried from main run <R> at <G> (tree equals G's)`.
 */
export function treeCarriedRun(request: TestRequested, from: TestRun): TestRun {
	if (!from.main || from.verdict !== "green") throw new Error(`test-run ${from.runId} is no green main run to carry`);
	return {
		runId: request.runId, verdict: "green", sha: request.sha, pr: request.pr, reason: `carried from main run ${from.runId} at ${from.sha} (tree equals G's)`, headAtEnd: null,
		base: null, mergeBase: null, full: from.full, solo: from.solo, failures: [], runDir: from.runDir, preflight: null,
		scope: from.scope, main: false, host: from.host, exec: from.exec,
	};
}

async function cmdStart(wl: string, pr: number, sliceArg: string | null, by: string): Promise<number> {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w || w.status !== "open") throw new Fail(`no open workload ${wl}`, START_EXIT.refused);
	const config = loadConfig();
	const { ownerRepo, url } = servedOf(ledger, wl, config);
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
	const say = (s: string) => process.stderr.write(`test-runner start: ${s}\n`);
	// D4: on a land-first repository every request takes the gate. `pending` goes first, so no older success on this head counts while it
	// runs, and a refused post refuses the request; then the tree carry, the fast set, or the full suite by exception.
	let land: LandAdmission | null = null;
	if (landFirstNow(ledger, ownerRepo)) {
		const why = postStatus(realGh, ownerRepo, "pending", view.headRefOid, `as2 check requested, run ${runId}`, say);
		if (why !== null) throw new Fail(`the pending status on ${view.headRefOid} was not posted (${why}); nothing was requested`, START_EXIT.refused);
		land = landAdmission({ ledger, root, ownerRepo, url, runId, pr, head: view.headRefOid, ref: view.headRefName, config, log: say });
	}
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
		const from = candidate === null ? null : carryAuthority(ledger, carrySources(ledger, wl, pr, view.headRefName, ownerRepo, origins), pr, land === null || land.plan.scope === "full");
		const carry = from !== null && from.runId === candidate!.runId && from.sha === candidate!.sha ? from : null;
		const request: TestRequested = { runId, pr, sha: view.headRefOid, slice: sl, by };
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody(request) });
		// D4: the land-first plan rides in the admission's transaction with the request it decides.
		if (land !== null) ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: fastPlanBody(runId, land.plan) });
		// The tree carry first (D4): X's tree is G's, so G's green main run is X's result; then the decision-log carry (D4b).
		const run = land?.carryFrom ? treeCarriedRun(request, land.carryFrom) : carry !== null ? carriedRun(request, carry) : null;
		if (run === null) return { slice: sl, carried: null };
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRunBody(run) });
		ledger.completeSlice(sl, { by: TEST_RUNNER_BY, artifact: settleArtifact(run) });
		hookSync(wl, "carry-written");
		return { slice: sl, carried: { run, from: land?.carryFrom ?? carry! } };
	});

	if (carried !== null) {
		// D4d, after the commit: the status the run would post, outside any transaction; a failed post is logged and the green stands.
		await hook(wl, "gate-publication", {}, Date.now() + FINALIZE_MS);
		// Every carry, including one admitted off, shares activation-aware publication with off completion.
		postGate({
			gh: realGh, ledger, root, repo: ownerRepo, head: view.headRefOid, ref: view.headRefName, pr, need: land?.plan.scope === "fast" || land?.plan.scope === "tree" ? "fast" : "full",
			result: { verdict: carried.run.verdict, sha: carried.run.sha, scope: carried.run.scope, host: carried.run.host }, wl, runId, log: say,
			offDescription: `carried from run ${carried.from.runId} at ${carried.from.sha.slice(0, 7)} (decision-log only)`,
		});
		process.stdout.write(`test-run ${runId} runner none sha ${view.headRefOid} slice ${slice} log none${boundBy ? ` bound-by ${boundBy}` : ""} carried ${carried.from.runId}\n`);
		return START_EXIT.ok;
	}

	try {
		const pid = spawnRunner(runDir, runId);
		process.stdout.write(`test-run ${runId} runner ${pid} sha ${view.headRefOid} slice ${slice} log ${join(runDir, "runner.log")}${boundBy ? ` bound-by ${boundBy}` : ""}\n`);
		return START_EXIT.ok;
	} catch (e) {
		const reason = `the runner did not start: ${errText(e)}`;
		try {
			recordError(ledger, root, wl, { runId, pr, sha: view.headRefOid, slice, by }, runDir, reason);
		} catch (e2) {
			say(`the failure could not be recorded: ${errText(e2)}`);
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
 * Each caller owns its private output directory; no output is trimmed except stderr.
 * `watch` (the stuck backstop, PLAN wl-mvq8x4pkjmx69s D4) reads the stdout so far every `everyMs` and answers the time to abandon
 * the call at (Infinity for none; it may move, never past the timeout); at that time the stdout is read once more, and when the
 * answer still holds the child gets SIGKILL and the call returns at once, `abandoned`, with no exit of its own.
 */
export async function run(cmd: string[], o: {
	cwd: string; env: Record<string, string | undefined>; timeoutMs: number; inheritStderr?: boolean;
	onSpawn?: (pid: number) => void;
	watch?: { everyMs: number; abandonAt: (out: string, nowMs: number) => number };
}): Promise<{ code: number | null; signal: string | null; out: string; err: string; abandoned: boolean }> {
	const dir = mkdtempSync(join(tmpdir(), "as2-runner-command-"));
	const outPath = join(dir, "stdout");
	const errPath = join(dir, "stderr");
	const outFd = openSync(outPath, "w", 0o600);
	const errFd = openSync(errPath, "w", 0o600);
	let p: Subprocess | undefined;
	try {
		try {
			p = spawn(cmd, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: outFd, stderr: o.inheritStderr ? "inherit" : errFd });
		} finally {
			closeSync(outFd);
			closeSync(errFd);
		}
		o.onSpawn?.(p.pid);
		const deadline = Date.now() + o.timeoutMs;
		let abandonAt = Infinity;
		let nextRead = 0;
		while (p.exitCode === null && p.signalCode === null) {
			const now = Date.now();
			if (now >= deadline) {
				// Release the wait even if signalling is refused or Bun never reports completion.
				try { p.kill("SIGKILL"); } catch { /* the deadline still applies */ }
				throw new Stop(`command timed out after ${o.timeoutMs} ms: ${cmd.join(" ")}`);
			}
			if (o.watch && (now >= nextRead || now >= abandonAt)) {
				abandonAt = o.watch.abandonAt(readFileSync(outPath, "utf8"), now);
				nextRead = now + o.watch.everyMs;
				if (now >= abandonAt) {
					try { p.kill("SIGKILL"); } catch { /* the wait is abandoned either way */ }
					return { code: null, signal: null, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8").trim(), abandoned: true };
				}
			}
			await Bun.sleep(Math.min(25, Math.max(1, Math.min(deadline, abandonAt) - Date.now())));
		}
		return { code: p.exitCode, signal: p.signalCode ?? null, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8").trim(), abandoned: false };
	} finally {
		p?.unref();
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * One wrapper call's end: its exit, and whether the outlive sweep fired on it (PLAN wl-mvq4edh02r5z40 D0; `callTimedOut`); for a part,
 * its stderr (echoed into runner.log), and whether the stuck backstop abandoned it with the worker of the signature it fired on
 * (PLAN wl-mvq8x4pkjmx69s D4; `callStuck`).
 */
type Wrapped = { code: number | null; signal: string | null; out: string; outlived: boolean; err: string; abandoned: boolean; candidate: number | null };

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
	/** The run holds the lock row as far as it knows: set when it takes the row, cleared only once `release` deleted it or found it held by another run. */
	private held = false;
	/** Set at `release`'s first call: from then on the heartbeat leaves the row alone, so its heartbeatAt only ages. */
	private releasing = false;
	/** The heartbeatAt this run last wrote to its row (taking it, then each heartbeat that updated it): the release horizon's base. */
	private rowBeatAt = 0;
	/** The run's failed release deletes so far, over every call (the first one logs `the lock release failed`). */
	private releaseFailures = 0;
	/** A release's read of the row failed other than busy, and said so (once a run). */
	private releaseReadFailed = false;
	/** runs.db's busy_timeout on `lockDb` now (`lockBusy`): AGENT_SYSTEM_TEST_RUNNER_BUSY_MS until a deadline-bound step sets 0. */
	private lockBusyMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_BUSY_MS", 5_000);
	/** The run learnt it no longer holds the row (heartbeat or checkpoint) or its request. */
	private superseded: string | null = null;
	private soloCalls = 0;
	private postSweepDeadline = Infinity;
	private baseSoloCalls = 0;
	private basePrepared = false;
	private url = "";
	/** The served repo's `owner/repo` (`servedOf`), every status post's target; empty until the run resolves it. */
	private ownerRepo = "";
	/** D4: this run's `fast-plan:` of scope fast with what the check found and where it ran; null for a full run. */
	private fast: (FastFindings & { plan: FastSetPlan; host: TestHost; exec: ExecCounts | null }) | null = null;
	/** D4: the hosted part holds no Mac slot, so its checkpoints check supersession only, never the lock row. */
	private slotless = false;
	/** The installed bundle's SOURCE commit as the newest install read found it, or why SOURCE did not parse (D5's row). */
	private source: { ok: true; sha: string } | { ok: false; error: string } = { ok: false, error: "the install was not read" };
	/** D5: this process wrote its one `runner-preflight:` row (or logged why it could not). */
	private preflightRecorded = false;
	/** The final verifier check made under promotion.db; publication of its receipt must not re-sample a later promotion. */
	private verifiedReasons: string[] | null = null;
	private mainExec: ExecCounts | null = null;
	private mainTree: CommitTree | null = null;
	private mainSuspects: string[] = [];
	private mainDiffs = new Map<string, string[]>();
	/** The run's place in the lock queue: its `test-requested:` entry's created_at in ms, read once at start. */
	readonly requestedAt: number;
	private readonly f: RunFacts & { base: string | null; mergeBase: string | null; preflight: string | null };
	/** `_as2test`'s uid as the install check read it (dscl), for the spawn-free containment check; null until then or when unknown. */
	private as2testUid: number | null = null;

	constructor(readonly ledger: Ledger, readonly wl: string, readonly request: TestRequested, readonly config: TestRunnerConfig) {
		this.runDir = runDirOf(this.root, request.runId);
		this.stageRoot = join(this.as2root, "stage");
		this.stage = stageDirOf(request.runId, this.as2root);
		this.workDir = workDirOf(request.runId, this.as2root);
		const rec = testRuns(ledger.entries(wl)).find((r) => r.request.runId === request.runId);
		if (!rec) throw new Fail(`no test-requested: record for ${request.runId} on ${wl}`, START_EXIT.failed);
		this.requestedAt = Date.parse(rec.request.createdAt);
		this.lockDb = openLockDb(this.root, this.lockBusyMs);
		this.capBytes = reportCapBytes(config);
		this.f = {
			requestedSha: request.sha, fetchedSha: null, error: null, full: null, fullTimedOut: false, solo: [], headAtStart: request.sha, headAtEnd: null, owner: true, sliceState: null, baseRuns: null,
			stuck: null, executorStalled: null, base: null, mergeBase: null, preflight: null,
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
		if (!this.held || this.superseded || this.releasing) return;
		hookSync(this.id, "heartbeat-update");
		try {
			const at = Date.now();
			const changes = this.lockDb.query("UPDATE lock SET heartbeatAt = ? WHERE runId = ?").run(at, this.id).changes;
			hookMark(this.id, "heartbeat", { changes });
			if (changes === 0) this.lose("the lock row no longer holds this run (heartbeat updated no row)");
			else this.rowBeatAt = at;
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

	/** `lockDb`'s busy_timeout := `ms`, remembered so a step that needs nonblocking attempts can put the one before it back. */
	private lockBusy(ms: number): void {
		this.lockBusyMs = ms;
		this.lockDb.exec(`PRAGMA busy_timeout = ${Math.trunc(ms)}`);
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
				let beatAt = 0;
				try {
					took = this.lockDb.transaction(() => {
						this.lockDb.query("INSERT OR IGNORE INTO queue (runId, workloadId, requestedAt) VALUES (?, ?, ?)").run(this.id, this.wl, this.requestedAt);
						const blocker = this.queueBlocker();
						const row = lockRow(this.lockDb);
						if (row && row.runId !== this.id && !lockHolderStale(row.heartbeatAt, Date.now())) return null;
						if (blocker !== null) return null;
						beatAt = Date.now();
						this.lockDb.query("INSERT OR REPLACE INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, ?, ?, ?, ?, ?)")
							.run(this.id, process.pid, process.pid, this.runDir, beatAt);
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
					this.rowBeatAt = beatAt;
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
		// Priority comes from the durable request, not a second queue flag/schema that could drift.
		const standing = testRuns(this.ledger.entries(STANDING_WORKLOAD_ID));
		for (const row of rows) row.main = standing.some((r) => r.request.runId === row.runId && r.request.main !== undefined);
		// An admitted main process may not have registered its queue row yet. Reserve its priority now so a waiting PR
		// cannot slip into the Mac slot between main settlement and its successor's process startup.
		if (this.request.main === undefined) {
			for (const rec of standing) {
				if (rec.request.main === undefined || rows.some((r) => r.runId === rec.request.runId)) continue;
				if (recordLive(rec, heartbeatOf(this.root, rec.request.runId), Date.now())) {
					rows.push({ runId: rec.request.runId, workloadId: STANDING_WORKLOAD_ID, requestedAt: Date.parse(rec.request.createdAt), main: true });
				}
			}
		}
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

	/**
	 * Before each phase and wrapper call (§ 2.3 step 1, losing the lock): the row still holds this run, and `current` is (re)published
	 * under that check. A slotless phase (D4's hosted part) holds no row, so it checks only that the run was not superseded.
	 */
	async checkpoint(phase: string): Promise<void> {
		await hook(this.id, `phase-${phase}`);
		if (this.superseded) throw new Superseded(this.superseded);
		if (this.slotless) {
			if (!ownsRequest(testRuns(this.ledger.entries(this.wl)), this.id)) {
				this.lose("lost ownership of the request before the slotless phase");
				throw new Superseded(this.superseded!);
			}
			return;
		}
		if (!publishIfOwner(this.lockDb, this.stageRoot, this.id)) {
			this.lose(`the lock row holds ${lockRow(this.lockDb)?.runId ?? "no run"}`);
			throw new Superseded(this.superseded!);
		}
	}

	/**
	 * `checkpoint` bounded by `deadline` (a bounded sweep's, D4): `publishTx` with busy_timeout 0, retried every 50 ms until the
	 * deadline (one attempt even past it), since a synchronous SQLite busy wait cannot be cut short by a JS timer; the busy_timeout
	 * before it is put back. A displaced run throws Superseded, as `checkpoint` does. Returns false, with one runner.log line naming
	 * `what`, when runs.db stayed busy (or the test hook stayed paused) to the deadline: the caller goes on without the step.
	 */
	private async checkpointBy(phase: string, what: string, deadline: number): Promise<boolean> {
		try {
			await hook(this.id, `phase-${phase}`, {}, deadline);
		} catch (e) {
			if (!(e instanceof Stop)) throw e;
			this.log(`${what}: the ownership checkpoint was paused at its test hook past its deadline; going on without it`);
			return false;
		}
		if (this.superseded) throw new Superseded(this.superseded);
		const before = this.lockBusyMs;
		this.lockBusy(0);
		let attempts = 0;
		let tx: { published: boolean; holder: string | null } | null = null;
		try {
			for (;;) {
				attempts++;
				try {
					tx = publishTx(this.lockDb, this.stageRoot, this.id);
					break;
				} catch (e) {
					if (!isBusy(e)) throw e;
					hookMark(this.id, "checkpoint-busy", { phase, attempts });
				}
				const left = deadline - Date.now();
				if (left <= 0) break;
				await Bun.sleep(Math.min(50, left));
			}
		} finally {
			this.lockBusy(before);
		}
		if (tx === null) {
			this.log(`${what}: runs.db stayed busy through ${attempts} ownership checkpoint attempts until the deadline ${new Date(deadline).toISOString()}; going on without it`);
			return false;
		}
		if (!tx.published) {
			this.lose(`the lock row holds ${tx.holder ?? "no run"}`);
			throw new Superseded(this.superseded!);
		}
		return true;
	}

	/**
	 * One wrapper call: `sudo -n -u _as2test <exec> <sub> <run id> …` (wrapperArgv). Its stderr goes to runner.log (a part's after the
	 * call, so its `stuck:` reason can be read); stdout is captured and echoed there. It starts in the as2test root, which `_as2test`
	 * can read: the run dir is Jo's 0700 dir, and a cwd the child cannot read kills bun on getcwd. `timeoutMs` bounds a call that has
	 * no cap (a stuck run's sweep, D4): past it the call is abandoned and the Stop thrown. A part under `testRunner.stuckStop:
	 * enforce` carries the stuck backstop (`StuckWatch`, PLAN wl-mvq8x4pkjmx69s D4); shadow never arms it.
	 */
	async wrap(call: WrapperCall, capMs: number | null = null, timeoutMs?: number): Promise<Wrapped> {
		const argv = wrapperArgv(call, this.exec);
		const outliveMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_OUTLIVE_MS", OUTLIVE_MS);
		let outlived = false;
		const watchdog = capMs === null ? null : setTimeout(() => {
			outlived = true;
			this.log(`${call.sub} outlived its cap by ${outliveMs / 1000} s; sweeping`);
			void this.wrap({ sub: "sweep", runId: this.id }).catch((e) => this.log(`the outlive sweep failed: ${errText(e)}`));
		}, capMs + outliveMs);
		const backstop = capMs !== null && this.config.stuckStop === "enforce" ? new StuckWatch(msEnv("AGENT_SYSTEM_TEST_RUNNER_STUCK_BACKSTOP_MS", STUCK_BACKSTOP_MS)) : null;
		const r = await run(argv, {
			cwd: this.as2root, env: process.env,
			timeoutMs: timeoutMs ?? (capMs ?? 0) + outliveMs + 120_000, inheritStderr: capMs === null,
			onSpawn: (pid) => {
				hookMark(this.id, `spawn-${call.sub}`, { pid });
				this.log(`${argv.slice(4).join(" ")}: started pid ${pid}`);
			},
			...(backstop && {
				watch: {
					everyMs: msEnv("AGENT_SYSTEM_TEST_RUNNER_STUCK_POLL_MS", STUCK_POLL_MS),
					abandonAt: (out: string, now: number) => {
						backstop.feed(out, now);
						return backstop.first()?.deadline ?? Infinity;
					},
				},
			}),
		}).finally(() => clearTimeout(watchdog ?? undefined));
		const { out, err } = r;
		if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
		if (capMs !== null && err) process.stderr.write(`${err}\n`);
		const ended = r.abandoned ? "exit null (abandoned by the stuck backstop)" : `${r.signal ?? `exit ${r.code}`}${outlived ? " (after the outlive sweep)" : ""}`;
		this.log(`${argv.slice(4).join(" ")} → ${ended}`);
		return { code: r.code, signal: r.signal, out, outlived, err, abandoned: r.abandoned, candidate: r.abandoned ? (backstop?.first()?.worker ?? null) : null };
	}

	/** A fenced exit (77) while this run believes it holds the lock: the checkpoint decides whether it was displaced. */
	private async fenced(what: string): Promise<never> {
		await this.checkpoint("fenced");
		throw new Stop(`${what} was fenced although the lock row holds this run`);
	}

	/** `fenced` with its checkpoint bounded by `deadline` (`checkpointBy`); a checkpoint runs.db could not answer in time stops the run too. */
	private async fencedBy(what: string, deadline: number): Promise<never> {
		if (await this.checkpointBy("fenced", what, deadline)) throw new Stop(`${what} was fenced although the lock row holds this run`);
		throw new Stop(`${what} was fenced, and runs.db did not answer the ownership checkpoint before its deadline`);
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
			throw new Stop(r.signal !== null
				? `the sweep after ${after} ended by ${r.signal} ${attempt + 1} times; its ${SWEEP_RETRIES} retries are spent`
				: `the sweep after ${after} failed: exit ${r.code}`);
		}
	}

	/**
	 * The sweep after a stuck or stalled part (PLAN wl-mvq8x4pkjmx69s D4), the only cleanup step, and the admission gate's sweep:
	 * each attempt is its own call bounded by `deadline`, one deadline over all of them and over each attempt's ownership checkpoint
	 * (`checkpointBy`: runs.db busy to the deadline is logged and ends the sweep, never waited out), and an attempt still running
	 * there is abandoned (its sudo child SIGKILLed), never awaited. A signal retries as `sweep` does. Returns whether a sweep finished
	 * clean; a failure is logged, never thrown (the containment check after it judges what is left), but a fenced exit goes through
	 * `fencedBy`.
	 */
	private async boundedSweep(after: string, deadline: number): Promise<boolean> {
		for (let attempt = 0; attempt <= SWEEP_RETRIES; attempt++) {
			if (Date.now() >= deadline) break;
			if (!(await this.checkpointBy("sweep", `the sweep after ${after}`, deadline))) return false;
			const left = deadline - Date.now();
			if (left <= 0) break;
			hookMark(this.id, "sweep", { after, attempt });
			let r: Wrapped;
			try {
				r = await this.wrap({ sub: "sweep", runId: this.id }, null, left);
			} catch (e) {
				if (!(e instanceof Stop)) throw e;
				this.log(`the sweep after ${after} was abandoned at its deadline: ${e.message}`);
				return false;
			}
			if (r.code === WRAPPER_EXIT.ok) return true;
			if (r.code === WRAPPER_EXIT.fenced) await this.fencedBy("the sweep", deadline);
			if (r.signal === null) {
				this.log(`the sweep after ${after} failed: exit ${r.code}`);
				return false;
			}
			if (attempt < SWEEP_RETRIES) this.log(`the sweep after ${after} ended by ${r.signal}; retry ${attempt + 1} of ${SWEEP_RETRIES}`);
		}
		this.log(`the sweep after ${after} did not finish before its deadline`);
		return false;
	}

	/**
	 * The spawn-free containment check (D4): `snapshot()` of `_as2test`'s uid (sysctl, stuck-detect.ts), contained when it lists no
	 * live (non-zombie) process; the real install always checks the uid. A test install (AGENT_SYSTEM_TEST_RUNNER_INSTALL: a `groups`
	 * render running as the caller, whose every process is the caller's) reads the caller's own uid and counts only the live processes
	 * whose pgid is in a `<as2test root>/runs/<run>/groups` file, unless AGENT_SYSTEM_TEST_RUNNER_CONTAIN_SCOPE=uid. A snapshot that
	 * is not `ok`, or no known uid, is `denied`.
	 */
	private containment(): { kind: "contained" } | { kind: "live"; pids: number[] } | { kind: "denied"; why: string } {
		const groups = !!process.env.AGENT_SYSTEM_TEST_RUNNER_INSTALL && process.env.AGENT_SYSTEM_TEST_RUNNER_CONTAIN_SCOPE !== "uid";
		const uid = groups ? process.getuid!() : this.as2testUid;
		if (uid === null) return { kind: "denied", why: `the ${AS2TEST_USER} uid is unknown` };
		const s = snapshot(uid);
		if (s.kind !== "ok") return { kind: "denied", why: s.why };
		let live = liveProcs(s);
		if (groups) {
			const runs = join(this.as2root, "runs");
			const pgids = new Set<number>();
			let ids: string[] = [];
			try {
				ids = readdirSync(runs);
			} catch {
				// no runs yet
			}
			for (const id of ids) {
				try {
					for (const l of readFileSync(join(runs, id, "groups"), "utf8").split("\n")) if (/^\d+$/.test(l)) pgids.add(Number(l));
				} catch {
					// a run with no groups file
				}
			}
			live = live.filter((p) => pgids.has(p.pgid));
		}
		return live.length === 0 ? { kind: "contained" } : { kind: "live", pids: live.map((p) => p.pid) };
	}

	/**
	 * After a stuck or stalled part `stem` (D4), in place of its sweep: the bounded sweep (STUCK_SWEEP_MS over every attempt and its
	 * ownership checkpoint, the deadline taken first), then the containment check; not contained or denied, another bounded sweep
	 * and a check every CONTAIN_RETRY_MS until contained or STUCK_CONTAIN_MS after `at`, the stuck fact. Never contained: runner.log's
	 * `stuck-containment-failed part <stem> pids <a,b|denied>`, and the run's stuck (or stalled) reason gains `; containment failed:
	 * <a,b | inspection denied>`. Either way the run then finalizes and releases its lock, to the next run's admission gate. From here
	 * runs.db's busy_timeout is 0 for the rest of the run: no synchronous busy wait (a heartbeat's included) outlasts a deadline.
	 */
	private async halt(stem: string, at: number): Promise<void> {
		const sweepMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS", STUCK_SWEEP_MS);
		const sweepBy = Date.now() + sweepMs;
		this.lockBusy(0);
		const after = stem;
		const retryMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_CONTAIN_RETRY_MS", CONTAIN_RETRY_MS);
		const deadline = at + msEnv("AGENT_SYSTEM_TEST_RUNNER_STUCK_CONTAIN_MS", STUCK_CONTAIN_MS);
		await this.boundedSweep(after, sweepBy);
		for (;;) {
			const checkedAt = Date.now();
			const c = this.containment();
			if (c.kind === "contained") {
				this.log(`contained after ${after}: no live ${AS2TEST_USER} process`);
				return;
			}
			const pids = c.kind === "live" ? c.pids.join(",") : null;
			this.log(`not contained after ${after}: ${pids !== null ? `live ${AS2TEST_USER} processes ${pids}` : `inspection denied: ${c.kind === "denied" ? c.why : ""}`}`);
			if (checkedAt >= deadline) {
				this.log(`stuck-containment-failed part ${stem} pids ${pids ?? "denied"}`);
				const failed = `; containment failed: ${pids ?? "inspection denied"}`;
				if (this.f.stuck !== null) this.f.stuck += failed;
				else if (this.f.executorStalled !== null) this.f.executorStalled += failed;
				return;
			}
			await this.boundedSweep(after, Math.min(deadline, Date.now() + sweepMs));
			const wait = Math.min(checkedAt + retryMs, deadline) - Date.now();
			if (wait > 0) await Bun.sleep(wait);
		}
	}

	/**
	 * The admission gate (D4), every run, after its first sweep and before its first part: no part runs while a live `_as2test`
	 * process remains (`containment`). Not contained, a bounded sweep and the check again every CONTAIN_RETRY_MS for up to ADMIT_MS;
	 * still not, the run's error is `admission refused: live _as2test processes <a,b>` (or `inspection denied`), logged as that line,
	 * and it runs no part. Returns whether the run was admitted.
	 */
	private async admit(): Promise<boolean> {
		const sweepMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS", STUCK_SWEEP_MS);
		const retryMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_CONTAIN_RETRY_MS", CONTAIN_RETRY_MS);
		const deadline = Date.now() + msEnv("AGENT_SYSTEM_TEST_RUNNER_ADMIT_MS", ADMIT_MS);
		for (;;) {
			const checkedAt = Date.now();
			const c = this.containment();
			if (c.kind === "contained") return true;
			const why = c.kind === "live" ? `live ${AS2TEST_USER} processes ${c.pids.join(",")}` : "inspection denied";
			if (checkedAt >= deadline) {
				this.f.error = `admission refused: ${why}`;
				this.log(this.f.error);
				return false;
			}
			this.log(`admission: ${why}${c.kind === "denied" ? ` (${c.why})` : ""}; sweeping and checking again`);
			await this.boundedSweep("admission", Math.min(deadline, Date.now() + sweepMs));
			const wait = Math.min(checkedAt + retryMs, deadline) - Date.now();
			if (wait > 0) await Bun.sleep(wait);
		}
	}

	/** Install facts against current's bundle inputs (or the development checkout in shadow); SOURCE is retained for D5's row. */
	private decideInstall(): { facts: InstallFacts; v: InstallVerdict } {
		const spec = this.install;
		// The bundle follows current/tag even while this already-running process finishes on an older verified release.
		const checkout = landFirstNow(this.ledger, this.ownerRepo) ? resolvedCurrent(verifiedDirectory()) ?? controlCheckout() : REPO_ROOT;
		const facts = readInstall({ checkout, libexec: spec.libexec, root: this.as2root, sudoers: spec.sudoers, dscl: spec.dscl });
		this.source = facts.source.ok ? { ok: true, sha: facts.source.source.sourceSha } : { ok: false, error: facts.source.error };
		this.as2testUid = facts.account?.uid ?? null;
		return { facts, v: installDecision(facts, spec.ids) };
	}

	/**
	 * D5: write ok only after actual verified-root/tag/helper/SOURCE checks pass. In shadow mode a refused row
	 * is still recorded, but does not prevent the first main run earning G. Activation consumes this same receipt.
	 * A SOURCE that did not parse is written as forty zeros; recording failure is loud in runner.log.
	 */
	private recordPreflight(refusal: string | null): void {
		if (this.preflightRecorded) return;
		this.preflightRecorded = true;
		const src = this.source;
		try {
			const reasons = [...(refusal === null ? [] : [refusal]), ...(this.verifiedReasons ?? verifiedPreflight(this.ledger, this.ownerRepo, src.ok ? src.sha : null, join(this.install.libexec, "refresh")))];
			const body = runnerPreflightBody({ ok: reasons.length === 0, reason: reasons.length === 0 ? null : reasons.join("; "), source: src.ok ? src.sha : "0".repeat(40), root: realpathSync(controlCheckout()) });
			this.ledger.write(() => {
				ensureStandingWorkload(this.ledger);
				this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
			});
			this.log(body);
		} catch (e) {
			this.log(`runner-preflight: not recorded: ${errText(e)}; original preflight outcome: ${refusal ?? "install checks passed"}; inspect this run's runner.log before retrying activation`);
		}
	}

	/** D5's row for a preflight that threw: refused with the stop's reason; a superseded run decided nothing, which is logged. */
	private preflightThrew(e: unknown): void {
		if (e instanceof Superseded) this.log(`runner-preflight: not recorded: the run was superseded before its preflight decided (${e.message})`);
		else this.recordPreflight(e instanceof Stop || e instanceof Fail ? e.message : `the runner failed: ${errText(e)}`);
	}

	/**
	 * `sudo -n <libexec>/refresh`, with no argument (PLAN wl-mv718fxhwwcn40 § 1.3), capped at REFRESH_TIMEOUT_MS (the test knobs
	 * AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS, _GRACE_MS and _REAP_MS shorten it): SIGTERM, SIGKILL after the grace, then at most
	 * REFRESH_REAP_MS more for sudo to exit, and `exited: false` when it has not. Its stdout and stderr go to run-dir files,
	 * never pipes a root grandchild could hold open past the cap, and are then copied into runner.log.
	 */
	async refresh(deadline = Infinity): Promise<{ code: number | null; signal: string | null; timedOut: boolean; exited: boolean; cap: string; reap: string; out: string; err: string }> {
		const argv = ["sudo", "-n", join(this.install.libexec, "refresh")];
		const graceMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS", REFRESH_KILL_GRACE_MS);
		const reapMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS", REFRESH_REAP_MS);
		const capMs = verifierTimeout(deadline - graceMs - reapMs, msEnv("AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS", REFRESH_TIMEOUT_MS), "refreshing the verifier bundle");
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
		const on = landFirstNow(this.ledger, this.ownerRepo);
		if (!on) return this.reconcileInstall(false);
		const directory = resolve(verifiedDirectory());
		const db = openPromotionDb(directory);
		let failure: unknown;
		try {
			// Do not block the event loop/heartbeat while a released predecessor is still promoting. This is the sole retry
			// layer: nonblocking BEGINs, bounded backoff and one deadline, followed by exactly one reconciliation.
			db.exec("PRAGMA busy_timeout = 0");
			const budget = promotionBudgetMs();
			const deadline = Date.now() + budget;
			let waitMs = 25;
			for (;;) {
				try {
					db.exec("BEGIN IMMEDIATE");
					break;
				} catch (e) {
					if (!isBusy(e)) throw e;
					if (Date.now() >= deadline) throw new Stop(`verified reconciliation could not acquire ${join(directory, "promotion.db")} within its holder budget: ${errText(e)}; retry after the publisher finishes`);
					if (waitMs === 25) this.log(`verified reconciliation waiting for ${join(directory, "promotion.db")}`);
					hookMark(this.id, "promotion-busy");
					await Bun.sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())));
					waitMs = Math.min(waitMs * 2, 250);
				}
			}
			return await this.reconcileInstall(true, Date.now() + budget);
		} catch (e) {
			failure = e;
			throw e;
		} finally {
			try { db.close(); }
			catch (e) {
				throw new Error(`verified reconciliation could not close ${join(directory, "promotion.db")}: ${errText(e)}${failure === undefined ? "" : `; original failure: ${errText(failure)}`}; repair the verifier lock before retrying`);
			}
		}
	}

	/** Current/tag, input hashes, the one refresh and the final coherence check all share the publisher's transaction. */
	private async reconcileInstall(on: boolean, deadline = Infinity): Promise<Verdict> {
		const stop: (reason: string) => never = (reason) => {
			this.f.preflight = `preflight: ${reason}`;
			throw new Stop(this.f.preflight);
		};
		let { facts, v } = this.decideInstall();
		let refreshed: string | null = null;
		let verifierMismatch = false;
		if (on) {
			const own = runnerControlRoot(undefined, undefined, deadline);
			const rootRefusal = controlRootRefusal(own, this.ledger.entries(STANDING_WORKLOAD_ID));
			if (rootRefusal.length > 0) return stop(rootRefusal.join("; "));
			const reasons = verifiedPreflight(this.ledger, this.ownerRepo, this.source.ok ? this.source.sha : null, join(this.install.libexec, "refresh"), realGh, undefined, undefined, deadline);
			if (reasons.length > 0) {
				if (!readFileSync(join(this.install.libexec, "refresh"), "utf8").includes(`refs/tags/${AS2_VERIFIED_TAG}:refs/tags/${AS2_VERIFIED_TAG}`)) return stop(reasons.join("; "));
				this.log(`verified preflight: ${reasons.join("; ")}; re-pointing the tag and refreshing once`);
				pointVerifiedTag(verifierGh(deadline), this.ownerRepo, own.currentHead!);
				verifierMismatch = true;
			}
		}
		if (verifierMismatch || (!v.ok && v.kind !== "install")) {
			this.log(`preflight: ${!v.ok ? v.reason : "bundle/tag mismatch"}; running the refresh helper`);
			const r = await this.refresh(deadline);
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
				const head = await run(["git", ...NO_HOOKS, "rev-parse", "--verify", "HEAD"], { cwd: REPO_ROOT, env: trustedEnv("/dev/null"), timeoutMs: verifierTimeout(deadline, 30_000, "reading the drifted checkout") });
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
		if (on) {
			this.verifiedReasons = verifiedPreflight(this.ledger, this.ownerRepo, this.source.ok ? this.source.sha : null, join(this.install.libexec, "refresh"), realGh, undefined, undefined, deadline);
			if (this.verifiedReasons.length > 0) return stop(`verified preflight refused after one refresh: ${this.verifiedReasons.join("; ")}`);
		}
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
		// D5, R16: a run a main run, a runner `main-red:` or an open incident cites is kept 30 days, outside KEEP_RUNS.
		const cited = this.ledger.workload(STANDING_WORKLOAD_ID) === null ? new Set<string>() : citedRuns(this.ledger.entries(STANDING_WORKLOAD_ID), Date.now());
		const prune = retentionPrune([...ids].map((id) => ({ id, at: at(id) })), cited, this.id);
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
		if (q.main !== undefined) {
			await git([...NETWORK, "fetch", "-q", "origin", q.sha], "fetching the requested main commit");
			this.f.fetchedSha = await git([...NO_HOOKS, "rev-parse", "--verify", "FETCH_HEAD^{commit}"], "reading the requested main commit");
		} else {
			await git([...NETWORK, "fetch", "-q", "origin", `+refs/pull/${q.pr}/head:refs/remotes/origin/pr/${q.pr}`, "+refs/heads/main:refs/remotes/origin/main"], "git fetch");
			this.f.fetchedSha = await git([...NO_HOOKS, "rev-parse", "--verify", `refs/remotes/origin/pr/${q.pr}^{commit}`], "reading the PR head");
		}
		if (this.f.fetchedSha !== q.sha) return null;
		await git([...NO_HOOKS, "checkout", "-q", "--detach", q.sha], "git checkout");
		this.f.headAtStart = await git([...NO_HOOKS, "rev-parse", "HEAD"], "reading HEAD");
		let changed: string[] = [];
		if (q.main !== undefined) {
			this.mainTree = treeAt(join(repo, ".git"), q.sha, env, false);
			const verdicts = mainVerdicts(mainResults(this.ledger.entries(STANDING_WORKLOAD_ID)));
			const chain = (await git([...NO_HOOKS, "rev-list", "--first-parent", `--max-count=${CHAIN_MAX}`, q.sha], "reading main suspects")).split("\n");
			for (const sha of chain) {
				if (verdicts.get(sha)?.verdict === "green") break;
				this.mainSuspects.unshift(sha);
				const parents = (await git([...NO_HOOKS, "rev-list", "--parents", "-n", "1", sha], "reading suspect parents")).split(" ");
				const diff = await git(parents.length > 1
					? [...NO_HOOKS, "diff", "--no-renames", "--name-only", "-z", parents[1]!, sha]
					: [...NO_HOOKS, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha], "reading suspect first-parent changes");
				this.mainDiffs.set(sha, diff.split("\0").filter(Boolean));
			}
		} else {
			this.f.base = await git([...NO_HOOKS, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], "reading origin/main");
			this.f.mergeBase = await git([...NO_HOOKS, "merge-base", q.sha, "refs/remotes/origin/main"], "git merge-base");
			const diff = await run(["git", ...NO_HOOKS, "diff", "--name-only", "-z", "--diff-filter=AMR", this.f.mergeBase, q.sha], { cwd: repo, env, timeoutMs: 120_000 });
			if (diff.code !== 0) throw new Stop(`git diff failed: ${diff.err.split("\n").at(-1) || `exit ${diff.code}`}`);
			changed = changedTestFiles(diff.out);
		}
		await git([...NO_HOOKS, "remote", "remove", "origin"], "git remote remove");
		// The tested commit as a branch, so the bundle carries it whatever HEAD's handling.
		await git([...NO_HOOKS, "update-ref", q.main !== undefined ? "refs/heads/as2-tested-main" : `refs/heads/as2-tested-pr-${q.pr}`, q.sha], "naming the tested commit");
		// Main has no comparison base; its migration check uses the requested main commit itself.
		await git([...NO_HOOKS, "update-ref", "refs/tags/as2-trusted-main", this.f.base ?? q.sha], "tagging the trusted base");
		const bundle = join(this.stage, "repo.bundle");
		await git([...NO_HOOKS, "bundle", "create", "-q", bundle, "--all"], "git bundle create");
		chmodSync(bundle, 0o640);
		const caps = join(this.stage, "caps.json");
		writeFileSync(caps, `${JSON.stringify({ fullCapMin: this.config.fullCapMin, soloCapMin: this.config.soloCapMin, fullWorkers: this.config.fullWorkers, fastCapMin: this.config.fastCapMin, stuckStop: this.config.stuckStop })}\n`, { mode: 0o640 });
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
	 * is one runner.log line and never changes the result. `base-solo` runs the file in the base clone (D8), reports `base-solo-<i>.*`.
	 * `fast` is D4's Mac fallback: the fast set's files (`./<path>`) in one call under `fastCapMin`, reported as `fast.*`.
	 * The stuck-worker detector (PLAN wl-mvq8x4pkjmx69s D4): after a part whose stdout has `stuck-captured`, its `<part>.signature.log`
	 * is imported the same way. A stuck call (`callStuck`, however it ended) or one the backstop abandoned with no stop line (the
	 * executor stalled) gets its `stuck:` or `executor stalled` error over any other, never a timeout, sets the run's `stuck` or
	 * `executorStalled` fact, and `halt` takes the place of the part's sweep: `halted` tells the caller to sweep nothing and run no
	 * further part. Such a call's junit and log are imported whatever its ending, a wrapper refusal or failure (64, 70) included, so
	 * its partial failures and security evidence stay in the verdict (PLAN wl-mvq8x4pkjmx69s R5).
	 */
	async part(call: { sub: "full" } | { sub: "solo" | "base-solo"; file: string } | { sub: "fast"; files: string[] }): Promise<{ result: PartResult; junit: string | null; timedOut: boolean; halted: boolean }> {
		await this.checkpoint(call.sub);
		const capMs = (call.sub === "full" ? this.config.fullCapMin : call.sub === "fast" ? this.config.fastCapMin : this.config.soloCapMin) * 60_000;
		const started = Date.now();
		const wrapped: WrapperCall = call.sub === "full" ? { sub: call.sub, runId: this.id } : call.sub === "fast" ? { sub: call.sub, runId: this.id, files: call.files } : { sub: call.sub, runId: this.id, file: call.file };
		const r = await this.wrap(wrapped, capMs);
		const ms = Date.now() - started;
		if (r.code === WRAPPER_EXIT.fenced) await this.fenced(call.sub);
		let name: string = call.sub;
		if (call.sub === "solo") {
			this.soloCalls++;
			name = /^part (solo-\d+)$/m.exec(r.out)?.[1] ?? `solo-${this.soloCalls}`;
		} else if (call.sub === "base-solo") {
			this.baseSoloCalls++;
			name = /^part (base-solo-\d+)$/m.exec(r.out)?.[1] ?? `base-solo-${this.baseSoloCalls}`;
		}
		const stuck = callStuck(r);
		const stalled = !stuck && r.abandoned;
		const halt = stuck ? stuckReason(r) : stalled ? executorStalledReason(r.candidate ?? 0) : null;
		const timedOut = halt === null && callTimedOut(r);
		if (timedOut) this.importCapture(`${name}.stuck.log`);
		if (/^stuck-captured /m.test(r.out)) this.importCapture(`${name}.signature.log`);
		let out: { result: PartResult; junit: string | null };
		if (halt === null && (r.code === WRAPPER_EXIT.refused || r.code === WRAPPER_EXIT.failed)) {
			const wrapper = `the wrapper ${r.code === WRAPPER_EXIT.refused ? "refused" : "failed"} ${call.sub} (exit ${r.code})`;
			out = { result: { ...partResult({ junit: null, log: null, exit: r.code, ms }), error: timedOut ? `timeout; ${wrapper}` : wrapper }, junit: null };
		} else {
			const imported = importPart(this.workDir, this.runDir, name, this.capBytes);
			out = { result: partResult({ ...imported, exit: r.signal !== null ? null : r.code, ms, timedOut, maxBytes: this.capBytes }), junit: imported.junit };
		}
		if (halt === null) return { ...out, timedOut, halted: false };
		const at = Date.now();
		out.result = { ...out.result, error: halt };
		// The verdict's part label (`full`, a solo's `./<file>`, `base ./<file>`); runner.log's lines name the stem, as the exec's do.
		const label = call.sub === "full" || call.sub === "fast" ? call.sub : call.sub === "solo" ? call.file : `base ${call.file}`;
		if (stuck) this.f.stuck = `${label}: ${halt}`;
		else {
			this.f.executorStalled = `${label}: ${halt}`;
			this.log(`executor-stalled part ${name} worker ${r.candidate ?? 0}`);
		}
		this.log(`${name}: ${halt}; no further part`);
		await this.halt(name, at);
		return { ...out, timedOut, halted: true };
	}

	/**
	 * A capture of the wrapper's into the run dir under importReport's checks: a timed-out part's `<part>.stuck.log` (PLAN
	 * wl-mvq4edh02r5z40 D5), a detector match's `<part>.signature.log` (PLAN wl-mvq8x4pkjmx69s D3); logged, never thrown.
	 */
	private importCapture(file: string): void {
		try {
			const r = importReport(this.workDir, this.runDir, file, this.capBytes);
			this.log(r.error !== null ? `${file} not imported: ${r.error}` : r.text === null ? `${file} not imported: the wrapper wrote none` : `${file} imported`);
		} catch (e) {
			this.log(`${file} not imported: ${errText(e)}`);
		}
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
			const { result, halted } = await this.part({ sub: "base-solo", file });
			results[file] = result;
			if (halted) break;
			await this.sweep(`base ${file}`);
			if (result.error === null) writeBaseCache(this.root, sha, file, result);
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
	 * Steps in the plan's order: lock and publish → install check (and refresh) → sweep → admission gate (PLAN wl-mvq8x4pkjmx69s
	 * D4) → probe, then the `runner-preflight:` row → retention → trusted → prepare → the full part and its sweep → the solo
	 * parts `soloPlan` names (none after a timed-out, stuck or stalled full part), a sweep after each → base runs → post-sweep
	 * finalization deadline → head re-check. A fast plan takes `fastBody` instead. A stuck or stalled part ends the parts there,
	 * its `halt` in place of the sweep, and its finalization deadline is the shorter STUCK_FINALIZE_MS.
	 */
	async body(): Promise<void> {
		if (this.request.main !== undefined) {
			const repo = this.request.main.repo;
			if (!this.config.repos.some((r) => r.origin.toLowerCase() === repo.toLowerCase())) throw new Stop(`the test runner does not serve main repository ${repo}`);
			this.ownerRepo = repo;
			this.repo = REPO_ROOT;
			this.url = process.env.AGENT_SYSTEM_TEST_RUNNER_ORIGIN || `https://github.com/${repo}.git`;
		} else ({ url: this.url, repo: this.repo, ownerRepo: this.ownerRepo } = servedOf(this.ledger, this.wl, this.config));
		const fastPlan = fastPlanOf(this.ledger.entries(this.wl), this.id);
		if (fastPlan?.scope === "fast") return this.fastBody(fastPlan);
		await this.acquire();
		await this.macPreflight();
		await this.retention();
		const changed = await this.trusted();
		if (changed === null) return;
		await this.prepare();
		this.log(`full workers ${this.config.fullWorkers}`);
		this.log(`stuck detector ${this.config.stuckStop}`);
		const full = await this.part({ sub: "full" });
		this.f.full = full.result;
		this.f.fullTimedOut = full.timedOut;
		if (this.request.main !== undefined && full.junit !== null) {
			const counted = execOf(full.junit, countedTestFiles(this.mainTree!.files, this.config.mainSkip));
			if (counted.ok) this.mainExec = counted.exec;
			else this.f.error = `main executed counts could not be read from full.xml: ${counted.error}`;
		}
		let halted = full.halted;
		if (!halted) await this.sweep("full");
		const plan = soloPlan({ full: full.result, timedOut: full.timedOut, halted, changed, executed: full.junit === null ? [] : executedFiles(full.junit) });
		if (plan.stop) this.log(`full part ${halted ? "stopped the run" : "timed out"}: no solo or base parts`);
		else {
			this.log(`solo parts: ${plan.files.join(" ") || "none"}`);
			for (const file of plan.files) {
				const solo = await this.part({ sub: "solo", file });
				this.f.solo.push({ file, ...solo.result });
				if ((halted = solo.halted)) break;
				await this.sweep(file);
			}
			if (!halted && this.request.main === undefined) await this.baseRuns();
		}
		await this.headRecheck();
	}

	/** The Mac preflight under the lock (§ 3.1): install check (and refresh), sweep, probe; then D5's row, ok or refused with the stop's reason. */
	private async macPreflight(): Promise<void> {
		try {
			const install = await this.installCheck();
			await this.sweep("publish");
			if (!(await this.admit())) throw new Stop(this.f.error ?? "admission refused");
			await this.preflight(install);
		} catch (e) {
			this.preflightThrew(e);
			throw e;
		}
		this.recordPreflight(null);
	}

	/** The post-sweep finalization deadline, then the head re-check (§ 2.3 step 5). */
	private async headRecheck(): Promise<void> {
		const finalizeMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS", 150_000);
		const halted = this.f.stuck !== null || this.f.executorStalled !== null;
		this.postSweepDeadline = Date.now() + (halted ? Math.min(finalizeMs, msEnv("AGENT_SYSTEM_TEST_RUNNER_STUCK_FINALIZE_MS", STUCK_FINALIZE_MS)) : finalizeMs);
		this.log(`post-sweep finalization started; deadline ${new Date(this.postSweepDeadline).toISOString()}`);
		await hook(this.id, "head-recheck", {}, this.postSweepDeadline);
		this.f.headAtEnd = this.request.main !== undefined ? this.f.fetchedSha : await this.headNow(Math.max(1, this.postSweepDeadline - Date.now()));
	}

	/**
	 * D4's fast run, holding no Mac slot: on-mode preflight reconciles the verifier under promotion.db; off-mode records and logs
	 * Mac install drift without stopping hosted work (a Mac fallback refreshes or stops on it). Then D5's row → trusted → parse
	 * targets at the tree (one that does not transpile makes the run red and nothing runs) → the hosted check (`hosted`) → on a
	 * dispatch failure, other workflow code or no result, the one Mac fallback (`macFast`) → the head re-check.
	 */
	private async fastBody(plan: FastSetPlan): Promise<void> {
		this.fast = { plan, host: "linux", parse: [], missing: [], exec: null };
		this.slotless = true;
		// Hosted work still executes control code locally: on-mode install facts must be read inside the reconciliation lock.
		try {
			const v = landFirstNow(this.ledger, this.ownerRepo) ? await this.installCheck() : this.decideInstall().v;
			this.f.preflight = v.ok ? v.summary : `preflight: ${v.reason}`;
			if (!v.ok) this.log(`preflight: ${v.reason}; the hosted fast check runs none of the Mac install, so it goes on (a Mac fallback refreshes or stops on it)`);
			this.recordPreflight(v.ok ? null : v.reason);
		} catch (e) {
			this.preflightThrew(e);
			throw e;
		}
		const changed = await this.trusted();
		if (changed === null) return;
		const tree = treeAt(join(this.stage, "repo", ".git"), this.request.sha, trustedEnv(join(this.runDir, "trusted.gitconfig")), false);
		this.fast.parse = parseCheck(plan.parse, tree.read);
		if (this.fast.parse.length > 0) this.log(`parse check failed: ${this.fast.parse.map((p) => `${p.path} ${p.error}`).join("; ")}; the fast set does not run`);
		else if (plan.files.length === 0) throw new Stop(`fast-plan of ${this.id} names no Linux test file, so the fast check has nothing to run; name one in testRunner.fastSmoke (profile/config.yml)`);
		else {
			this.log(`parse check: ${plan.parse.length} target(s) transpile; fast set on linux: ${plan.files.join(" ")}`);
			const fallback = await this.hosted(plan);
			if (fallback !== null) await this.macFast(plan, fallback);
		}
		await this.headRecheck();
	}

	/**
	 * The hosted fast check (D4): `hostedFast` downloads the artifact into `<run dir>/hosted`, then fast.summary, fast.xml and
	 * fast.log are imported into the run dir under the report checks and judged. Returns null when judged, else the fallback's
	 * reason: hostedFast's, or an artifact whose fast.summary is missing, unreadable or names another request or sha (no result).
	 */
	private async hosted(plan: FastSetPlan): Promise<string | null> {
		const dir = join(this.runDir, "hosted");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const waitMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_FAST_WAIT_MS", this.config.fastWaitMin * 60_000);
		const h = await hostedFast(
			{ gh: realGh, now: () => Date.now(), sleep: (ms) => Bun.sleep(ms), log: (s) => this.log(s) },
			{ repo: this.ownerRepo, runId: this.id, sha: this.request.sha, files: plan.files, waitMs, pollMs: msEnv("AGENT_SYSTEM_TEST_RUNNER_FAST_POLL_MS", FAST_POLL_MS), dir },
		);
		if (!h.ok) return h.reason;
		const summary = importReport(dir, this.runDir, "fast.summary", this.capBytes);
		const s = summary.text === null ? null : parseFastSummary(summary.text);
		if (s === null) {
			const why = summary.error ?? (summary.text === null ? "it is missing" : "it is not the summary line");
			return `no result: workflow run ${h.workflowRunId}'s fast.summary is unusable: ${why}`;
		}
		if (s.request !== this.id || s.sha !== this.request.sha) {
			return `no result: workflow run ${h.workflowRunId}'s fast.summary names request ${s.request} at ${s.sha.slice(0, 12)}, not ${this.id} at ${this.request.sha.slice(0, 12)}`;
		}
		const imported = importPart(dir, this.runDir, "fast", this.capBytes);
		const timedOut = s.exit === WRAPPER_EXIT.timeout;
		this.f.full = partResult({ ...imported, exit: s.exit, ms: s.wallS * 1000, timedOut, maxBytes: this.capBytes });
		this.f.fullTimedOut = timedOut;
		this.log(`fast check on linux: workflow run ${h.workflowRunId} exit ${s.exit} in ${s.wallS} s`);
		this.judgeFast(imported.junit);
		return null;
	}

	/**
	 * D4's one Mac fallback: `fast-fallback: <run> <reason>` on the run's workload first (a write that fails is logged), then the lock,
	 * the Mac preflight, prepare and the same set once through `exec fast`, and its sweep. The hosted run is never retried.
	 */
	private async macFast(plan: FastSetPlan, reason: string): Promise<void> {
		this.log(`fast check falls back to the Mac once: ${reason}`);
		try {
			const body = fastFallbackBody(this.id, reason);
			this.ledger.write(() => this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: this.request.slice, kind: "assumption", body }));
		} catch (e) {
			this.log(`fast-fallback: not recorded: ${errText(e)}; the fallback still runs, and its test-run: says host mac`);
		}
		this.fast!.host = "mac";
		this.slotless = false;
		await this.acquire();
		await this.macPreflight();
		await this.retention();
		await this.prepare();
		const r = await this.part({ sub: "fast", files: plan.files.map((f) => `./${f}`) });
		this.f.full = r.result;
		this.f.fullTimedOut = r.timedOut;
		if (!r.halted) await this.sweep("fast");
		this.judgeFast(r.junit);
	}

	/** R12 over the fast part's JUnit (`fastExec`): the executed counts, and each planned file with no executed test; counts that cannot be read are the run's error. */
	private judgeFast(junit: string | null): void {
		const fast = this.fast!;
		if (junit === null) return;
		const e = fastExec(junit, fast.plan.files);
		if (!e.ok) {
			this.f.error = `the fast check's executed counts could not be read from fast.xml: ${e.error}`;
			return;
		}
		fast.exec = e.exec;
		fast.missing = e.missing;
		if (e.missing.length > 0) this.log(`no executed test in the fast set's ${e.missing.join(", ")}`);
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
			const facts: RunFacts = { ...this.f, owner, sliceState: this.request.main === undefined ? this.ledger.slice(this.request.slice)?.state ?? null : null };
			const decided = this.fast === null ? decideRun(facts) : fastDecision(facts, this.fast);
			// A run displaced from the lock says so; decideRun's reason alone speaks only of the request.
			const lost = this.superseded ?? (lockMine ? null : `the lock row holds ${lockRow(this.lockDb)?.runId ?? "no run"}`);
			const decision = decided.verdict === "superseded" && lost ? { ...decided, reason: `${lost}; ${decided.reason}` } : decided;
			const built = buildTestRun(this.request, facts, decision, { base: this.f.base, mergeBase: this.f.mergeBase, runDir: this.runDir, preflight: this.f.preflight });
			// A fast run's row says scope fast, where it ran, and its executed counts (D4).
			const run: TestRun = this.request.main !== undefined ? { ...built, main: true, scope: "full", host: "mac", exec: this.mainExec }
				: this.fast === null ? built : { ...built, scope: "fast", host: this.fast.host, exec: this.fast.exec };
			// Exactly one settle per request, including a duplicate detached process after the first process settled.
			const prior = testRuns(this.ledger.entries(this.wl)).find((r) => r.request.runId === this.id)?.results[0];
			if (this.request.main !== undefined && prior !== undefined) return { run: prior, settled: null };
			this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: this.wl, sliceId: sliceOf(this.request), kind: "assumption", body: testRunBody(run) });
			if (this.request.main !== undefined) {
				const verdict = mainVerdicts(mainResults(this.ledger.entries(this.wl))).get(run.sha);
				if (verdict?.runId === run.runId && verdict.verdict !== "green") {
					const failing = [...new Set(run.failures.map((f) => f.name.split(" > ")[0]!.replace(/^\.\//, "")))];
					const facts: MainRedFacts = {
						repo: this.ownerRepo, sha: run.sha, runId: run.runId, verdict: verdict.verdict, suspects: this.mainSuspects,
						failing, attribution: this.mainTree === null ? [] : attribute(this.mainSuspects, failing, this.mainDiffs, this.mainTree),
					};
					this.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: this.wl, kind: "assumption", body: mainRedFactsBody(facts) });
				}
				return { run, settled: null };
			}
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
			if (!Number.isFinite(this.postSweepDeadline)) {
				const finalizeMs = msEnv("AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS", FINALIZE_MS);
				const stopped = this.f.stuck !== null || this.f.executorStalled !== null;
				this.postSweepDeadline = Date.now() + (stopped ? Math.min(finalizeMs, msEnv("AGENT_SYSTEM_TEST_RUNNER_STUCK_FINALIZE_MS", STUCK_FINALIZE_MS)) : finalizeMs);
			}
			try {
				await hook(this.id, "result", {}, this.postSweepDeadline);
				if (Date.now() >= this.postSweepDeadline) throw new Stop("post-sweep deadline exceeded before publication");
			} catch (e) {
				this.f.error = errText(e);
				this.log(`stopped: ${this.f.error}`);
			}
			// Synchronous SQLite waits cannot be interrupted by JS timers. Publication retries
			// nonblocking BEGINs against the shared deadline, not nested fixed retry budgets.
			this.lockBusy(0);
			this.ledger.db.exec("PRAGMA busy_timeout = 0");
			let run: TestRun;
			try {
				run = this.finish();
			} catch (e) {
				// A locked/unavailable ledger cannot accept a transaction. Preserve a local
				// error verdict instead of silently leaving no artifact; never settle here.
				const reason = `result publication failed: ${errText(e)}${this.f.error ? `; ${this.f.error}` : ""}`;
				const built = buildTestRun(this.request, this.f, { verdict: "error", outcome: "error", reason, settle: false }, {
					base: this.f.base, mergeBase: this.f.mergeBase, runDir: this.runDir, preflight: this.f.preflight,
				});
				const run: TestRun = this.request.main !== undefined ? { ...built, main: true, exec: this.mainExec }
					: this.fast === null ? built : { ...built, scope: "fast", host: this.fast.host, exec: this.fast.exec };
				this.log(`test-run error: ${reason}`);
				this.writeResult(run);
				this.admitPendingMain();
				await this.release();
				if (this.request.main !== undefined) {
					// The ledger is unavailable: result.json and runner.log retain the error, and the tick reaps the request.
					// Revocation must not depend on a working ledger or on another logging write succeeding.
					const log = (s: string) => this.log(s);
					revokeIfActive(this.ledger, this.root, realGh, this.request.main.repo, `main ${run.sha.slice(0, 7)} publication error, run ${run.runId}: ${reason}`, log);
					postStatus(realGh, this.request.main.repo, "error", run.sha, `main full publication error, run ${run.runId}`, log, MAIN_FULL_STATUS);
				}
				return START_EXIT.failed;
			}
			if (this.request.main !== undefined) await hook(this.id, "main-published", {}, this.postSweepDeadline);
			this.admitPendingMain();
			// PR338: no GitHub call holds the Mac slot. A failed release is still a failed runner, even if publication succeeds.
			const released = await this.release();
			if (this.request.main !== undefined) {
				const log = mainPublicationLog(this.ledger, this.wl, this.id, (s) => this.log(s));
				const verdict = mainVerdicts(mainResults(this.ledger.entries(this.wl))).get(run.sha);
				if (verdict?.verdict === "green") {
					const controlRepo = ownerRepoOf(originOf(controlCheckout()) ?? "")?.toLowerCase() ?? null;
					if (controlRepo === this.ownerRepo.toLowerCase()) promoteMain(this.ledger, this.ownerRepo, run.sha, log);
					else log(`verified promotion skipped for served repository ${this.ownerRepo}: this runner's control repository is ${controlRepo ?? "unreadable (repair its origin before promotion)"}`);
				} else revokeIfActive(this.ledger, this.root, realGh, this.ownerRepo, `main ${run.sha.slice(0, 7)} ${verdict?.verdict ?? run.verdict}, run ${run.runId}`, log);
				const state = verdict?.verdict === "green" ? "success" : verdict !== undefined ? "failure" : "error";
				postStatus(realGh, this.ownerRepo, state, run.sha, `main full ${verdict?.verdict ?? run.verdict}, run ${run.runId}`, log, MAIN_FULL_STATUS);
				return released ? 0 : START_EXIT.failed;
			}
			// Publication consults live activation too: a full run admitted before on still takes today's merge gate.
			const state = this.f.fetchedSha === run.sha ? FULL_SUITE_STATE[run.verdict] : undefined;
			if (state) {
				try {
					await hook(this.wl, "gate-publication", {}, this.postSweepDeadline);
					const plan = fastPlanOf(this.ledger.entries(this.wl), this.id);
					const ref = plan?.ref ?? (() => ghPrView(this.ownerRepo, run.pr).headRefName);
					const contained = /; containment failed: /.test(`${this.f.stuck ?? ""}${this.f.executorStalled ?? ""}`) ? ", containment failed" : "";
					postGate({
						gh: realGh, ledger: this.ledger, root: this.root, repo: this.ownerRepo, head: run.sha, ref, pr: run.pr, need: plan?.scope === "fast" || plan?.scope === "tree" ? "fast" : "full",
						result: { verdict: run.verdict, sha: run.sha, scope: run.scope, host: run.host }, wl: this.wl, runId: this.id, log: (s) => this.log(s),
						offDescription: `full suite ${run.verdict}, run ${run.runId}${contained}`,
					});
				} catch (e) {
					const reason = `the publication could not complete: ${errText(e)}`;
					this.log(`${reason}; required status unchanged; retry publication`);
					try { recordStatusFailure({ ledger: this.ledger, wl: this.wl, runId: this.id, head: run.sha, log: (s) => this.log(s) }, state, reason); }
					catch (receiptError) { this.log(errText(receiptError)); }
				}
			}
			return released ? 0 : START_EXIT.failed;
		} finally {
			clearInterval(this.timer);
			if (this.held) this.admitPendingMain();
			await this.release();
			this.leaveQueue();
			this.lockDb.close();
		}
	}

	/** Admit the durable successor before releasing the Mac, so a waiting PR cannot overtake pending main. */
	private admitPendingMain(): void {
		if (this.request.main === undefined) return;
		try {
			const pending = this.lockDb.query<{ sha: string }, [string]>("SELECT sha FROM main_pending WHERE repo = ?").get(this.request.main.repo.toLowerCase());
			if (pending === null) return;
			const a = admitMain(this.ledger, this.lockDb, this.root, this.request.main.repo, pending.sha, MERGE_TRAIN_BY);
			if (a.action !== "admitted") return;
			try {
				spawnRunner(runDirOf(this.root, a.runId), a.runId);
			} catch (e) {
				const reason = `the pending main runner did not start: ${errText(e)}`;
				try {
					recordError(this.ledger, this.root, this.wl, findRequest(this.ledger, a.runId)!.request, runDirOf(this.root, a.runId), reason);
				} catch (audit) {
					this.log(`${reason}; its error result was not recorded: ${errText(audit)}; the tick must reap it`);
				}
				throw e;
			}
		} catch (e) {
			mainPublicationLog(this.ledger, this.wl, this.id, (s) => this.log(s))(`pending main admission failed: ${errText(e)}; the tick must request the tip again`);
		}
	}

	/**
	 * Delete this run's lock row and log `lock released` (the field report's slot end, PLAN wl-mvq8x4pkjmx69s D5). The run
	 * lock goes even when a refresh helper this run started may outlive it (installCheck's `live`): releasing it proves nothing about
	 * that helper. Refreshes are serialised by the helper's own lockf lock on refresh.d/lock, which the next run's refresh waits on
	 * (exit 69, lock, while the old helper holds it). From the first call the heartbeat leaves the row alone. Each attempt is one
	 * nonblocking delete (busy_timeout 0), retried every 50 ms until it deletes the row, the row is found not to hold this run, or
	 * the row would be stale for a waiter (`lockHolderStale`: HEARTBEAT_STALE_MS past its heartbeatAt), when a waiter may take it
	 * anyway. The horizon's heartbeatAt is this run's own last write, replaced by what a nonblocking read of the row finds after
	 * each failed delete (a read can go through while another writer holds runs.db). Nothing in the loop awaits but the sleep; the
	 * `release` hook before it is inert outside tests. The run stays `held` until the row is gone, so main's finally calls this
	 * again for one attempt more; each call that ends with the row held logs `the lock was not released` and returns false.
	 */
	private async release(): Promise<boolean> {
		if (!this.held) return true;
		if (!this.releasing) {
			this.releasing = true;
			await hook(this.id, "release");
		}
		this.lockBusy(0);
		let beatAt = this.rowBeatAt;
		for (let attempt = 1; ; attempt++) {
			let failed: unknown;
			try {
				const { changes } = this.lockDb.query("DELETE FROM lock WHERE runId = ?").run(this.id);
				this.held = false;
				this.log(changes > 0 ? "lock released" : "lock released: the row no longer held this run");
				return true;
			} catch (e) {
				failed = e;
			}
			this.releaseFailures++;
			hookMark(this.id, "release-failed", { attempt, error: errText(failed) });
			try {
				const row = lockRow(this.lockDb);
				if (row === null || row.runId !== this.id) {
					this.held = false;
					this.log("lock released: the row no longer held this run");
					return true;
				}
				beatAt = row.heartbeatAt;
			} catch (e) {
				// busy is the hold the delete met; anything else is said once, and the horizon keeps the last heartbeatAt known.
				if (!isBusy(e) && !this.releaseReadFailed) {
					this.releaseReadFailed = true;
					this.log(`the lock row was not read during its release: ${errText(e)}; the release horizon stays on heartbeatAt ${new Date(beatAt).toISOString()}`);
				}
			}
			const horizon = beatAt + HEARTBEAT_STALE_MS;
			if (this.releaseFailures === 1) this.log(`the lock release failed: ${errText(failed)}; retrying until ${new Date(horizon).toISOString()}`);
			const now = Date.now();
			if (lockHolderStale(beatAt, now)) {
				this.log(`the lock was not released: ${errText(failed)} (${this.releaseFailures} attempts; the row's heartbeatAt ${new Date(beatAt).toISOString()} is stale for a waiter since ${new Date(horizon).toISOString()}); the row holds this run until a waiter takes it`);
				return false;
			}
			await Bun.sleep(Math.min(50, horizon - now + 1));
		}
	}
}

async function cmdRun(runId: string): Promise<number> {
	process.umask(0o027);
	if (!RUN_ID_RE.test(runId)) throw new Fail(`${runId} is not a run id`, START_EXIT.usage);
	const ledger = openLedger();
	const found = findRequest(ledger, runId);
	if (!found) throw new Fail(`no test-requested: for ${runId}`, START_EXIT.failed);
	if (found.request.main !== undefined && testRuns(ledger.entries(found.workloadId)).find((r) => r.request.runId === runId)?.results.length) return START_EXIT.ok;
	const w: WorkloadStatusRow | null = ledger.workload(found.workloadId);
	if (!w) throw new Fail(`no workload ${found.workloadId}`, START_EXIT.failed);
	let config: TestRunnerConfig;
	try {
		config = loadConfig();
	} catch (e) {
		// No caps to run under: the request still gets its error result.
		process.stdout.write(`${new Date().toISOString()} ${errText(e)}\n`);
		recordError(ledger, runsRoot(process.env), found.workloadId, found.request, runDirOf(runsRoot(process.env), runId), errText(e));
		return 0;
	}
	return new Runner(ledger, found.workloadId, found.request, config).main();
}

// ---- main ---------------------------------------------------------------------------------------------

const USAGE = "usage: test-runner.ts start <wl> <pr> [--slice <id>] --requested-by <laneId> | run <run id> | reap | main --repo <owner/repo> --sha <sha> | promote --sha <sha>";

/**
 * `reap` (D6, R37; surface/scripts/train-tick.ts `LandDeps.runner`): settle every admitted request with no settle and no live
 * heartbeat `runner died`; admits nothing. Exit 0 whether it settled some or none (none is a no-op); a workload it could not
 * settle on is exit 3 (`START_EXIT.failed`) naming each, after the others were settled, and the tick requests no main run that pass.
 */
function cmdReap(): number {
	const { settled, failed } = reap(openLedger(), runsRoot(process.env));
	process.stdout.write(settled.length === 0 ? "reaped none\n" : `reaped ${settled.join(" ")}\n`);
	if (failed.length > 0) throw new Fail(`reap could not settle on ${failed.join("; ")}; the next reap tries again`, START_EXIT.failed);
	return START_EXIT.ok;
}

/** `main --repo --sha` (D5): admit a main run (spawning it), replace the pending target, or nothing; one line on stdout. */
function cmdMain(repo: string, sha: string): number {
	const ledger = openLedger();
	const root = runsRoot(process.env);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const db = openLockDb(root);
	try {
		const a = admitMain(ledger, db, root, repo, sha, MERGE_TRAIN_BY);
		if (a.action === "admitted") {
			try {
				spawnRunner(runDirOf(root, a.runId), a.runId);
			} catch (e) {
				const reason = `the runner did not start: ${errText(e)}`;
				recordError(ledger, root, STANDING_WORKLOAD_ID, findRequest(ledger, a.runId)!.request, runDirOf(root, a.runId), reason);
				throw new Fail(reason, START_EXIT.failed);
			}
		}
		process.stdout.write(`${a.line}\n`);
		return START_EXIT.ok;
	} finally {
		db.close();
	}
}

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
	if (cmd === "reap" && rest.length === 0) return cmdReap();
	if (cmd === "main" && rest.length === 4 && rest[0] === "--repo" && rest[2] === "--sha" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rest[1]!) && SHA40.test(rest[3]!)) {
		return cmdMain(rest[1]!, rest[3]!);
	}
	if (cmd === "promote" && rest.length === 2 && rest[0] === "--sha" && SHA40.test(rest[1]!)) {
		return promoteVerified(rest[1]!);
	}
	throw new Fail(USAGE, START_EXIT.usage);
}

if (import.meta.main) {
	const sub = ["run", "reap", "main", "promote"].includes(process.argv[2] ?? "") ? process.argv[2]! : "start";
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			const f = err instanceof Fail ? err : new Fail(errText(err), START_EXIT.failed);
			process.stderr.write(`test-runner ${sub}: ${f.message.replace(/\s+/g, " ")}\n`);
			process.exit(f.code);
		},
	);
}
