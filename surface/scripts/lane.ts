#!/usr/bin/env bun
// The lane script (DESIGN-lane-launcher.md § 4 row "Lane script"; decisions 2, 3, 6, 8, 10, 11, 12,
// 14): one Bun file with subcommands, every ledger write through the module (P-11 row 10).
//
//   launch <wl> [--requested-by <who>]  the starter the surface execs: reserve (predicate inside the
//                                        transaction, after the live-lane check: an earlier lane whose runner or
//                                        omp still runs refuses `held`, liveLaneOf, unless that lane released
//                                        itself: its pids are stale, ended by the next spawner), preflight,
//                                        worktree + branch, system prompt, spawn `run` detached; prints
//                                        `lane <laneId> runner <pid>`
//   run <wl> <laneId>                    the runner: one `omp --mode rpc --no-ui` child, the first prompt and
//                                        up to CONTINUE_LIMIT continue prompts on it, lane-started:/lane-ready:/
//                                        lane-metrics:/lane-exit:, the turn-end decision once omp is settled, or at once
//                                        when the lane released itself or a holder's receipt stands (src/turn-end.ts),
//                                        stop requests, its own deadline, the ceiling meter (spend:, the 80 %
//                                        notice, the 100 % stop and its notice) and the profile config's as2 extensions
//                                        (a suspension with no notice) polled every STOP_POLL_MS. omp ends with stdin
//                                        EOF, SIGTERM after SHUTDOWN_GRACE_MS, SIGKILL END_GRACE_MS later. It first takes the
//                                        lane id's run lock (takeRunnerLock, one owner per lane id) and then checks
//                                        the recorded omp and runner pids (liveRunnerOf); a lane id held or running,
//                                        or one whose owner ps could not verify, exits 7 (held) before any ledger
//                                        write or spawn; before its spawn it ends the omps of lanes that released
//                                        themselves and never exited (staleOmps, endStale); it spawns omp only while the lock still names it (startAsOwner,
//                                        else exit 7 with nothing written) and the workload is still held by its lane id
//                                        (spawnIfReserved, else exit 7 with launch-failed:); only the lock's owner finalizes, and it
//                                        frees the lock on exit. Every ps call is bounded (PS_TIMEOUT_MS in
//                                        src/omp-probe.ts), since some run inside ledger writes. The quota guard
//                                        (classifier/src/headroom.ts) is here only: configured budget comparisons may
//                                        retain a week-only out source without changing its model. Otherwise Jo's
//                                        named model refuses before omp (launch-failed: … headroom); an unnamed lane
//                                        moves to a base-in-quota strong-row model before its first prompt (lane-headroom:)
//   interactive <wl>                     `as2 lane <wl>`: reserve under the interactive policy (after the same
//                                        live-lane check), end the self-released lanes' stale omps (endStale), then
//                                        omp in the TUI in the foreground (--model when Jo
//                                        named one, --resume when recorded on that same model), spawned in one write
//                                        with its lane-started: while the workload is still held by its lane id, its
//                                        first prompt and the workload's state supplied as `@prompt.md` (resume too);
//                                        AGENT_SYSTEM_BY_HAND=1
//   stop <wl>                            write the lane-stop: request; wait for lane-exit:; with no
//                                        runner alive, accept, end omp (SIGTERM, then SIGKILL after the
//                                        grace, each only while the pid's start time matches
//                                        lane-started:), release only once it is gone
//   cleanup <wl>                         remove the worktree when clean and pushed; keep the branch
//   log <wl>                             print the runner log path and tail it
//   ctx-index <wl> <laneId> --by runner|starter
//                                        after a lane's exit, detached: claim once per lane, import the
//                                        workload's sessions folder into ctx, check the lane's session by
//                                        id, record ctx-index: (MIGRATION.md item 43, src/ctx-index.ts)
//   drain <wl>                           after a runner's exit, detached: start the queued launches the freed slot
//                                        admits, one starter at a time, oldest workload first (MIGRATION.md item 71),
//                                        or in Jev rank order under `jevRank` order/parallel (src/rank-launch.ts);
//                                        <wl> names the workload whose lane ended, for drain.log only
//
// Stamps: every subcommand writes as `lane-starter`, except `run`, which writes as `lane-runner`, and
// `ctx-index`, which writes as the one its `--by` names. `drain` writes nothing itself: its starters write as `lane-starter`.
// After a quota move and after a ceiling stop the runner kicks the alert pass (src/notify.ts `kickAlerts`, PLAN
// wl-mw0vs9uc3xqtka D3): `bun surface/scripts/alert-tick.ts`, detached.
// Exit codes for launch/interactive: surface/src/launch.ts STARTER_EXIT.
import { type Subprocess, spawn, spawnSync } from "bun";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { headroom } from "../../classifier/src/headroom";
import { countRounds, parseReviewRound } from "../../classifier/src/rounds";
import { loadTierTable, modelIdentity } from "../../classifier/src/tier-table";
import { fenceTargets } from "../../gates/src/fence";
import { askJo, raisedId } from "../../gates/src/rulings";
import { alarmFilePath, CEILING_ALARM_KIND, describeOff, routineState } from "../../gates/src/routine-switch";
import { SCRATCH_ENV } from "../../gates/src/scratch";
import { ensureScratchRoot } from "../src/scratch-root";
import { canonicalPath, homeDir } from "../../ledger/src/locality";
import {
	type EntryRow, type HolderChange, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, defaultLedgerPath, type QuestionRow, type ReserveResult, type ReserveRows, type ReserveVerdict, type SliceRow, type Stakes,
	type WorkloadRow,
} from "../../ledger/src/index";
import {
	AUTO_RAISE_SOURCE, autoRaiseUsed, type Ceiling, ceilingBody, ceilingInForce, ceilingKey, type CeilingMark, ceilingMarkBody, type CeilingNoticeLevel, ceilingNoticeBody, ceilingQuestionBody,
	ceilingRaisedNoticeBody, CEILING_QUESTION_OPTIONS, crossed, effectiveCeiling, halfRaise, originalCeiling, pairedCeilingPromptLine, parseCeilingMark, parseCeilingNotice, parseCeilingQuestion, scanSpend,
	type Spend, spendBody, wallMinutes,
} from "../src/ceiling";
import { newLaneSession, runCtxIndex, topLevelSessions } from "../src/ctx-index";
import { decisionLogContext, repoOf } from "../src/decision-log";
import { factsBlock } from "../src/facts";
import { loadTestRunnerConfig } from "../src/close-entry";
import { checkoutOwnerRepo, isTrainOrFix, openTrains, ownerTasks, TRAIN_LAUNCH_LIMIT, trainAttempts, trainLaunchFailures, trainMembers } from "../src/merge-train";
import {
	activeTrainPr, askTrainPause, emptyTrainScan, nextPdtMidnight, pdtDay, scanTrainDays, trainBudgetGate, trainBudgetPromptLine, trainBudgetRows, trainDayLimit, trainMaxTime,
	trainMeterErrorBody, type TrainMeterEvidence, trainPausedBody, trainRuleBody, type TrainScan, type TrainScanError,
} from "../src/train-budget";
import {
	attempts, branchBody, branchName, BY_HAND_ENV, ceilingMaxTime, type ControlEntry, controlEntries, decideInteractive, exitClass, fencedBy, firstPrompt, heldLive, holdersOf,
	INTENDED_OUTCOMES, interactiveArgv, JO_HOLDER, joInstructionsFor, LANE_MAX_TIME_ENV, laneArgv, laneCap, laneDiedDeadlineBody, laneDiedExitBody, laneDiedLaunchBody, laneDir, laneEnv, laneExit,
	laneExitBody, laneDecidedBody, laneHeadroomBody, laneMaxTime, laneModel, type LaneOutcome, laneReadyBody, laneReceipt, laneStarted, laneStartedBody, laneStopAcceptedBody, laneStopRequestBody, launchFailedBody,
	launchRequestedBody, doneLine, maxTimeMs, pendingStop, planFirst, PRECLAIM_LEASE_MS, resolutions, resumeOrigin, resumePlan, scratchCapMb, sessionOrigin, STARTER_EXIT, stateModelCheck, stateModelOf,
	STOP_POLL_MS, trainBindings, worktreeBody, worktreePath,
} from "../src/launch";
import {
	BACKGROUND_SUFFIX, CONTINUE_LIMIT, continueCounter, continuePrompt, deadRunPrompt, type DeadTestRun, deadTestRuns, enqueueRunnerDeath, exitOutcome, extensionsSuspendedDeathBody, extensionsSuspendedOf,
	extensionsUnconfirmedDeathBody, configStamp, type PolledSuspension, polledSuspensionOf, readAs2ExtensionPaths, suspensionOf,
	heldOpenBody, IDLE_CHECK, IDLE_LIMIT, idleActivity, idlePrompt, liveTestRuns, type PromptError, promptErrorOf, releasedIdle, releasedOpen, selfReleased, SETTLE_CHECK, SETTLE_IDLE_MS, settleIdle, sliceCounts, STATE_ID,
	turnEnd, turnEndDeathBody, turnEndFailedDeathBody,
	type TurnEndInput, unsettledHandsOf,
} from "../src/turn-end";
import { waitingReserved } from "../src/errors";
import { laneMetrics, laneMetricsBody, psSampler, RSS_SAMPLE_MS, rssMeter } from "../src/metrics";
import { type PsRun, runPs, statStart } from "../src/omp-probe";
import { sendNotice } from "../src/notice";
import {
	decideRanked, DRAIN_TRIED_ENV, drainPick, formatDrainTried, type RankConfig, rankShadowLine, readDrainTried, readRankConfig, writePickSnapshot,
} from "../src/rank-launch";
import { renderWorkload } from "../src/render";
import { laneDeaths } from "../src/signals";
import { readTracingSetting, tracingEnv } from "../src/tracing";
import { parseHeartbeat, parsePushDest, runDirOf, runsRoot, testRuns } from "../src/test-run";
import { recordQuotaMove } from "../src/quota-move-alert";
import { kickAlerts } from "../src/notify";
import {
	type LiveRunner, liveRunnerOf, type LockRefusal, type RunnerIdentity, type RunnerLock, type RunnerProbe, runnerProbe, selfIdentity, takeRunnerLock,
} from "../src/runner-probe";
import { DECISION_LOG_ENV, LANE_TOOLS, LEASE_MS, LEASE_MS_ENV, ORCHESTRATOR_RECIPIENT, ROLE_ENV } from "../src/types";
import { readCleanShell } from "../../gates/src/clean-shell";
import { LANE_ENV, WORKLOAD_ENV } from "../../gates/src/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TIER_FILE = join(REPO_ROOT, "tiers", "lane.md");
/** A millisecond knob from the environment, or its fallback (the fake-omp tests shorten the waits below). */
const msEnv = (name: string, fallback: number): number => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** The readiness window: the lane's own claim must land within the pre-claim lease (decisions 8, 14). */
const READY_MS = msEnv("AGENT_SYSTEM_LANE_READY_MS", PRECLAIM_LEASE_MS);
const READY_POLL_MS = 1_000;
/** After stdin EOF, the wait for omp's own graceful rpc shutdown before SIGTERM (PLAN wl-mvidsu83epvpj4 D3). */
const SHUTDOWN_GRACE_MS = msEnv("AGENT_SYSTEM_LANE_SHUTDOWN_GRACE_MS", 10_000);
/** After SIGTERM, the wait before SIGKILL (§ 3 stop path; D3). */
const END_GRACE_MS = msEnv("AGENT_SYSTEM_LANE_END_GRACE_MS", 30_000);
/** The least time between two RSS samples of the omp tree (PLAN wl-mvbcjageg7o2yo § 2.2); the fake-omp tests shorten it. */
const RSS_SAMPLE_INTERVAL_MS = msEnv("AGENT_SYSTEM_LANE_RSS_SAMPLE_MS", RSS_SAMPLE_MS);
/** The runner's ledger poll: stop requests, its deadline, the meter, the hold, the idle check, a self-release or receipt (D2), the lease renewal. */
const STOP_POLL = msEnv("AGENT_SYSTEM_LANE_STOP_POLL_MS", STOP_POLL_MS);
/** endStale's one aggregate deadline, inside the pre-claim lease that runs from the reservation (D4). */
const STALE_END_MS = msEnv("AGENT_SYSTEM_LANE_STALE_END_MS", 60_000);
/** The settle wait with no omp activity that makes a session idle (PLAN wl-mv5i3lulwwbbi8 D6); the fake-omp tests shorten it. */
const SETTLE_IDLE = msEnv("AGENT_SYSTEM_LANE_SETTLE_IDLE_MS", SETTLE_IDLE_MS);
const PROFILE = process.env.AGENT_SYSTEM_PROFILE || process.env.OMP_PROFILE || "agent-system-2";
/** The installed profile's agent dir: its config.yml carries the clean-shell switch and the tier table (classifier/extension.ts reads the same file). */
const profileAgentDir = (): string => join(homeDir(), ".omp", "profiles", PROFILE, "agent");
/** The installed profile's config.yml: the file preflight checks and the tracing switch is read from at each spawn. */
const profileConfig = (): string => join(profileAgentDir(), "config.yml");
/** The lane's env (laneEnv), with the clean-shell switch read from the installed profile's agent dir at this spawn; a drain's tried set (`DRAIN_TRIED_ENV`) is this starter's alone and never reaches the runner. */
const boundEnv = (workloadId: string, laneId: string): Record<string, string> =>
	laneEnv({ ...process.env, [DRAIN_TRIED_ENV]: undefined }, { workloadId, laneId }, readCleanShell(profileAgentDir()));
/**
 * PLAN wl-mv71x5rwdu7eo0 § 4 (Jo's in-mv8p5m2t005tts, in-mv8qzqym1ihmv4): the stage a quota refusal or a failed move names in
 * `launch-failed:` and `lane-died:`, and the ids of the move's `set_model` and its confirming `get_state`.
 */
const HEADROOM_STAGE = "headroom";
const SET_MODEL_ID = "headroom-set-model";
const MOVED_STATE_ID = "headroom-state";

/**
 * A lane omp's environment, the one builder both spawn sites call (runner and `as2 lane <wl>`): `laneEnv`'s
 * binding over `base` (with the clean-shell switch read from `configPath`'s directory), then the tracing switch
 * read from `configPath` now (wl-mv65t5d34lts00 PLAN.md § 2, surface/src/tracing.ts): every inherited OTEL_* name
 * dropped, then off (`OTEL_SDK_DISABLED=true`) or, when `observability.phoenix` covers the workload, its otel map
 * with the lane's service name and resource attributes. An unreadable or malformed setting is off and never fails
 * the launch; `notes` says why, for the caller to log.
 */
export function laneSpawnEnv(base: Record<string, string | undefined>, configPath: string, binding: { workloadId: string; laneId: string }): { env: Record<string, string>; notes: string[] } {
	const r = readTracingSetting(configPath);
	return { env: tracingEnv(laneEnv(base, binding, readCleanShell(dirname(configPath))), r.setting, { role: "lane", ...binding }), notes: r.notes };
}

class Fail extends Error {
	constructor(readonly stage: string, message: string, readonly code: number) {
		super(message);
	}
}

const line = (s: string): void => {
	process.stdout.write(`${s}\n`);
};
const git = (repo: string, args: string[], timeoutMs?: number): { code: number; out: string; err: string; timedOut: boolean } => {
	const r = spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
	return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim(), timedOut: r.exitedDueToTimeout === true };
};
/** The bound on the starter's `git fetch` before it cuts a branch; a fetch past it counts as failed. Well inside the 30 s the trigger gives the whole starter (surface/extensions/launch.ts). */
const FETCH_TIMEOUT_MS = msEnv("AGENT_SYSTEM_LANE_FETCH_TIMEOUT_MS", 10_000);
const which = (bin: string): string | null => Bun.which(bin);

/**
 * `ps -p <pid> -o stat=,lstart=`: the process start time, or null when no such process (macOS first, § 7 item 5).
 * A zombie (state Z) is null too: it has exited and only waits for a parent that is not reaping it (a hung or
 * SIGSTOPped runner), so no signal can end it and `lane.ts stop` must not count it as alive. Throws when ps cannot
 * be spawned, does not answer within PS_TIMEOUT_MS (`runPs`), or is killed by a signal (exit code null, as `psAnswer`
 * reads it; moonshot review r5), so a ps that never answered never reads as gone: only a clean nonzero exit does.
 * `run` is ps (the tests pass a fake).
 */
export function startTime(pid: number, run: PsRun = runPs): string | null {
	const r = run(["-p", String(pid), "-o", "stat=,lstart="]);
	if (r.exitCode === null) throw new Error(`ps -p ${pid} -o stat=,lstart= exited by signal${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
	const out = r.stdout.trim();
	if (r.exitCode !== 0 || !out) return null;
	const { zombie, start } = statStart(out);
	return zombie ? null : start || null;
}

function openLedger(): Ledger {
	try {
		return Ledger.open(defaultLedgerPath(process.env));
	} catch (err) {
		throw new Fail("ledger", `the ledger could not be opened: ${String(err)}`, STARTER_EXIT.ledger!);
	}
}

interface Base {
	/** `origin/<default>` whenever that ref resolves; local `<default>` only with no `origin` or no remote default ref; `HEAD` for a detached checkout with neither. */
	ref: string;
	sha: string;
	/** The fetch's first error line, or null when it succeeded or there is no `origin`. */
	fetchFailed: string | null;
}

interface Prepared {
	repo: string;
	worktree: string;
	branch: string;
	/** Set only when this run cut the branch; a reused branch or worktree keeps the base it was cut from. */
	base: Base | null;
	dir: string;
	systemPromptPath: string;
	sessionDir: string;
	/** The workload's scratch root (`ensureScratchRoot`), the same path `laneEnv` exports as AS2_SCRATCH. */
	scratch: string;
}

/**
 * The base a new lane branch is cut from (DESIGN-lane-launcher.md § 4, lane script row): fetch
 * `origin` (bounded, a failure is recorded and not fatal), then `origin/<default>` whenever it
 * resolves — whether local `<default>` is ahead, behind, equal, or diverged. Jo commits locally and
 * pushes in batches, so local `<default>` may carry unpushed commits: cutting from origin keeps
 * them out of every lane branch and its PR, and local `<default>` can never block a launch. Local
 * `<default>` is the base only when there is no `origin` or no remote ref for the default.
 */
function chooseBase(repo: string): Base {
	let fetchFailed: string | null = null;
	if (git(repo, ["remote", "get-url", "origin"]).code === 0) {
		const f = git(repo, ["fetch", "--prune", "origin"], FETCH_TIMEOUT_MS);
		if (f.code !== 0) fetchFailed = f.timedOut ? `timed out after ${FETCH_TIMEOUT_MS} ms` : (f.err || f.out || `exit ${f.code}`).split("\n")[0]!;
	}
	const head = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	const name = head.code === 0 && head.out ? head.out.replace(/^origin\//, "") : git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
	const commit = (ref: string): string | null => {
		const r = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		return r.code === 0 && r.out ? r.out : null;
	};
	const named = name && name !== "HEAD";
	const remote = named ? commit(`refs/remotes/origin/${name}`) : null;
	if (remote !== null) return { ref: `origin/${name}`, sha: remote, fetchFailed };
	const local = named ? commit(`refs/heads/${name}`) : null;
	if (local !== null) return { ref: name, sha: local, fetchFailed };
	const detached = name === "HEAD" ? commit("HEAD") : null;
	if (detached === null) throw new Fail("preflight", `the default branch of ${repo} cannot be resolved`, STARTER_EXIT["repo-or-fence"]!);
	return { ref: "HEAD", sha: detached, fetchFailed };
}

/** Preflight (exit 2/3/4), worktree and branch (exit 5; the base is `chooseBase`'s, never refused), the scratch root, the system prompt file. Runs after the reservation. */
function prepare(ledger: Ledger, wl: string, interactive: boolean): Prepared {
	if (!which("omp")) throw new Fail("preflight", "no `omp` on PATH", STARTER_EXIT["no-omp"]!);
	const config = profileConfig();
	if (!existsSync(config)) throw new Fail("preflight", `no profile config at ${config}; run: as2 install`, STARTER_EXIT["no-profile"]!);
	const repo = repoOf(ledger, wl);
	if (!repo) throw new Fail("preflight", `workload ${wl} records no repository`, STARTER_EXIT["repo-or-fence"]!);
	const top = git(repo, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) throw new Fail("preflight", `${repo} is not a git checkout: ${top.err}`, STARTER_EXIT["repo-or-fence"]!);
	const worktree = worktreePath(top.out, wl);
	// § 6 "fence denies the worktree path": the canonical destination against the same targets the fence denies for a command in the checkout.
	const fenced = fencedBy(canonicalPath(worktree), fenceTargets("true", top.out, process.env));
	if (fenced !== null) throw new Fail("preflight", `worktree ${worktree} lies inside a fenced path ${fenced}`, STARTER_EXIT["repo-or-fence"]!);
	const branch = branchName(wl);
	let base: Base | null = null;
	if (!existsSync(join(worktree, ".git"))) {
		mkdirSync(dirname(worktree), { recursive: true });
		const exists = git(top.out, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
		if (!exists) base = chooseBase(top.out);
		// the sha, not the ref: the branch starts at exactly what the entry records, with no upstream set from origin/<default>
		const add = base === null ? git(top.out, ["worktree", "add", worktree, branch]) : git(top.out, ["worktree", "add", "-b", branch, worktree, base.sha]);
		if (add.code !== 0) throw new Fail("worktree", `git worktree add failed: ${add.err || add.out}`, STARTER_EXIT.worktree!);
	}
	const dir = laneDir(wl, homeDir());
	mkdirSync(dir, { recursive: true });
	let scratch: string;
	try {
		scratch = ensureScratchRoot(homeDir(), wl);
	} catch (err) {
		throw new Fail("scratch", String(err instanceof Error ? err.message : err), STARTER_EXIT.unknown!);
	}
	const tier = readFileSync(TIER_FILE, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
	const systemPromptPath = join(dir, "system.md");
	writeFileSync(systemPromptPath, `${tier.trim()}\n\n${interactive ? "This lane runs in Jo's terminal; Jo is present." : "This lane runs unattended; questions go to Jo through lane_raise_question."}\n`);
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	return { repo: top.out, worktree, branch, base, dir, systemPromptPath, sessionDir, scratch };
}

/** The one prompt (§ 7 item 3), from the rows as they stand at launch; the ceiling line (the runner's `ceilingPromptLine`, a by-hand lane's `pairedCeilingPromptLine`) goes after the stakes line (DESIGN-workload-ceiling.md § 2 item 4). */
function promptFor(ledger: Ledger, w: WorkloadRow, laneId: string, p: Prepared, ceilingLine: string): string {
	const entries = ledger.entries(w.id);
	const control = controlEntries(entries, holdersOf(entries, w.holder));
	const instructions = ledger.instructions(w.id);
	const resolved = resolutions(control, ledger.questions(w.id), instructions, ledger.slices(w.id)).map((r) => ({
		...r, question: ledger.question(r.questionId)?.body ?? "",
	}));
	const logDir = process.env[DECISION_LOG_ENV] || join(p.repo, ".ai", "decision-log");
	let decisionLog = "";
	try {
		decisionLog = existsSync(logDir) ? decisionLogContext(logDir) : "";
	} catch {
		decisionLog = "";
	}
	const facts = factsBlock(ledger, p.repo);
	// D10 (PLAN wl-mvbjiettjrfpxc): a lane on a repo the test runner serves hands its green, reviewed PR to the merge train.
	const cfg = loadTestRunnerConfig(process.env);
	const origin = cfg.ok && cfg.config.repos.length > 0 ? checkoutOwnerRepo(p.repo)?.toLowerCase() : undefined;
	const runnerServed = cfg.ok && origin !== undefined && cfg.config.repos.some((r) => r.origin.toLowerCase() === origin);
	// PLAN wl-mvr888nftz0vcl D11: the merge train's prompt shows TRAIN_DONE and its brief built now from its first membership.
	const membership = trainBindings(entries, instructions)[0];
	const prompt = firstPrompt({
		workload: w, laneId, repo: p.repo, worktree: p.worktree, branch: p.branch, done: doneLine(control), planFirst: planFirst(control)?.trigger ?? null,
		decisionLog, facts, resolved, instructions: joInstructionsFor(control, instructions, laneId), machinery: canonicalPath(p.repo) === canonicalPath(REPO_ROOT), tools: LANE_TOOLS,
		scratch: { root: p.scratch, capMb: scratchCapMb(process.env) }, trainTasks: ownerTasks(ledger, w.id),
		runnerServed, trainOrFix: isTrainOrFix(entries, instructions),
		train: membership === undefined ? null : { prs: membership.prs, source: membership.source, attempts: trainAttempts(entries, instructions) },
	});
	const out = prompt.split("\n");
	out.splice(out.indexOf(`stakes: ${w.stakes} · mode: ${w.mode}`) + 1, 0, ceilingLine);
	return out.join("\n");
}

/**
 * The by-hand lane's first prompt (PLAN-2 D1b): `promptFor`'s, then `## Workload state now` with the workload's block as
 * the orchestrator's on-demand read renders it (`renderWorkload`: slices, open questions, pending messages, recent entries),
 * read from the ledger at launch. Read-only: the lane gets no orchestrator tool. The runner's prompt is `promptFor`'s alone.
 */
function byHandPromptFor(ledger: Ledger, w: WorkloadRow, laneId: string, p: Prepared): string {
	const now = ledger.inFlight().find((x) => x.workload.id === w.id);
	if (!now) throw new Fail("interactive", `workload ${w.id} is not open`, STARTER_EXIT.closed!);
	// Jo's ruling (in-mvfo7nphl9xn28, PLAN wl-mvfkv7llkp7nk0 § 4.1): by-hand lanes have spend context, not a meter.
	// Only cmdRun stops at the ceiling or sends ceiling notices; the extension reports paired spend to the lane and Jo's pane.
	const es = ledger.entries(w.id);
	const control = controlEntries(es, holdersOf(es, now.workload.holder));
	const instructions = ledger.instructions(w.id);
	const spent: Spend = { ...scanSpend(p.sessionDir, new Map(), { usd: 0, tokens: 0, wallMin: 0 }), wallMin: wallMinutes(control, Date.now(), null) };
	const pairedLine = pairedCeilingPromptLine(effectiveCeiling(control, instructions, w.stakes), originalCeiling(control, instructions, w.stakes), spent);
	return `${promptFor(ledger, w, laneId, p, pairedLine)}\n\n## Workload state now\n\n${renderWorkload(ledger, now)}\n`;
}

/**
 * The model and session this attempt starts on, read fresh at every spawn: Jo's named model (`laneModel`, null for the
 * profile default) and the session `resumeOrigin` picks (decisions 6, 7, 14), resumed only when its origin lane ran on that
 * same model (`resumePlan`, MIGRATION.md item 85); `skipped` says why a recorded session was not resumed.
 */
function resumeOf(ledger: Ledger, w: WorkloadRow, laneId: string): { model: string | null; resume: string | null; skipped: string | null; recovered: string | null } {
	const entries = ledger.entries(w.id);
	const control = controlEntries(entries, holdersOf(entries, w.holder));
	const model = laneModel(control);
	const resolved = resolutions(control, ledger.questions(w.id), ledger.instructions(w.id), ledger.slices(w.id));
	const origin = resumeOrigin(control, laneId, resolved);
	if (origin === null || regularRealpath(origin.session) !== null) {
		return { model, ...resumePlan(control, laneId, resolved, model), recovered: null };
	}
	const dir = join(laneDir(w.id, homeDir()), "sessions");
	let newest: { path: string; canonical: string; mtime: number } | null = null;
	for (const name of topLevelSessions(dir)) {
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (!stat.isFile()) continue;
			const canonical = realpathSync(path);
			if (newest === null || stat.mtimeMs > newest.mtime || (stat.mtimeMs === newest.mtime && path > newest.path)) {
				newest = { path, canonical, mtime: stat.mtimeMs };
			}
		} catch {
			// A candidate removed during discovery is not usable.
		}
	}
	const missing = `recorded session ${origin.session} is missing`;
	if (newest === null) return { model, resume: null, skipped: `${missing}; no usable top-level workload session`, recovered: null };
	let candidateLane: string | null = null;
	for (let i = control.length - 1; i >= 0; i--) {
		const candidate = sessionOrigin([control[i]!]);
		if (candidate !== null && regularRealpath(candidate.session) === newest.canonical) {
			candidateLane = candidate.laneId;
			break;
		}
	}
	const started = candidateLane === null ? null : laneStarted(control, candidateLane);
	const ran = started === null ? undefined : started.model;
	if (ran !== model) {
		return { model, resume: null, skipped: `${missing}; newest ${newest.path} ran on ${ran === undefined ? "unknown" : ran ?? "default"}`, recovered: null };
	}
	return { model, resume: newest.path, skipped: null, recovered: `${missing}; recovering newest workload session ${newest.path}` };
}

/** Existing regular files only: aliases may prove provenance, nonexistent paths never do. */
function regularRealpath(path: string): string | null {
	try {
		return statSync(path).isFile() ? realpathSync(path) : null;
	} catch {
		return null;
	}
}

interface StderrCapture {
	settle: () => Promise<void>;
	context: () => string;
}

/** Drain immediately after spawn; retain only the final 8 KiB, independent of frames or newlines. */
function captureStderr(stream: ReadableStream<Uint8Array>): StderrCapture {
	const reader = stream.getReader();
	const tail = new Uint8Array(8192);
	let used = 0;
	let truncated = false;
	const drained = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				const keep = Math.min(value.length, tail.length);
				const retained = Math.min(used, tail.length - keep);
				truncated ||= used + value.length > tail.length;
				tail.copyWithin(0, used - retained, used);
				tail.set(value.subarray(value.length - keep), retained);
				used = retained + keep;
				process.stderr.write(value);
			}
		} catch (err) {
			process.stderr.write(`runner: omp stderr drain failed: ${oneLine(err)}\n`);
		}
	})();
	let settling: Promise<void> | null = null;
	return {
		settle: () => settling ??= (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([drained, new Promise<void>((done) => { timer = setTimeout(done, 250); })]);
			} finally {
				clearTimeout(timer);
				// Cancellation may itself wait on an inherited pipe: never await it.
				void reader.cancel().catch(() => undefined);
			}
		})(),
		context: () => {
			const text = new TextDecoder().decode(tail.subarray(0, used)).replace(/\s+/g, " ").trim();
			return text ? `stderr: ${truncated || text.length > 1000 ? "…" : ""}${text.slice(-1000)}` : "no stderr";
		},
	};
}

/**
 * After a reservation, a failure writes launch-failed: and the lane-died: message and releases the pre-claim. With
 * `lock` (the runner), all of it only while that lock still names this runner (`writeAsOwner`): a non-owner releases nothing.
 * `by` is the writer: the starter's shape by default; the runner's own pre-spawn refusal (a named model projected out of
 * quota, PLAN wl-mv71x5rwdu7eo0 § 4) writes as the runner, as `finish` does.
 */
function failAfterReserve(ledger: Ledger, wl: string, laneId: string, f: Fail, lock: Pick<RunnerLock, "held" | "path"> | null = null, by: string = LANE_STARTER_BY): void {
	try {
		const body = (): void => {
			ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body: launchFailedBody(laneId, f.stage, f.message) });
			ledger.enqueue({ by, workloadId: wl, sender: by, recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedLaunchBody(laneId, f.stage, f.message) });
			ledger.releaseWorkload(wl, { by, holder: laneId });
		};
		if (lock === null) ledger.write(body);
		else if (!writeAsOwner(ledger, lock, body)) process.stderr.write(`lane: ${lock.path} names another runner or none; the failure was not recorded and nothing was released\n`);
	} catch (err) {
		process.stderr.write(`lane: the failure could not be recorded: ${String(err)}\n`);
	}
}

/** A refused reservation inside the interactive pick's transaction: thrown to roll the pick snapshot back, then returned. */
class Refused extends Error {
	constructor(readonly result: ReserveResult) {
		super("refused");
	}
}

/**
 * The reservation (decision 8) under the policy for the path. Autonomous: `decideLaunch` with Jev ranking's gate composed
 * (`decideRanked`, PLAN wl-mv8k039gvogt8g D7; `config` is the profile's `jevRank`, read fresh here), inside
 * `reserveLane`'s one transaction, so the drain, the open tool and the wake tick are gated alike; in `show` it is
 * `decideLaunch` with only the intake queue's gate (PLAN wl-mvbcjadqgblr7k D5). `tried` is the tried set the drain that
 * ran this starter handed it (`DRAIN_TRIED_ENV`, `readDrainTried`; empty on every other path), so the queue gate here
 * agrees with the drain's pick: a workload the drain already tried never holds the queue. Interactive:
 * `decideInteractive`, never gated (D6), `tried` unused; an admit writes Jo's pick snapshot
 * (`rank-shown: … by pick`, D6) in the same transaction, before `launch: … cause interactive`, and a refusal writes neither.
 * Both policies first run the live-lane check (`liveRefusal`, PLAN wl-mvgn310dpi5gcg D2) in that transaction, its ps through
 * `probeFor` (the tests pass a fake), so no other reservation lands between the probe and the claim. The open merge trains
 * are the cap-exempt set (`openTrains`, PLAN wl-mvpsrr4tr0p1xc D1), read inside the transaction; an admitted train then
 * passes `trainGate` (D3, D4) in the same transaction.
 */
export function reserve(
	ledger: Ledger, wl: string, who: string, interactive: boolean, config: RankConfig = readRankConfig(),
	probeFor: (laneId: string, workloadId: string) => RunnerProbe = (laneId, of) => runnerProbe(of, laneId),
	tried: ReadonlySet<string> = readDrainTried(process.env),
): ReserveResult {
	const input = {
		by: LANE_STARTER_BY, cap: laneCap(process.env), leaseMs: PRECLAIM_LEASE_MS, requestedBy: who, capExempt: () => new Set(openTrains(ledger)),
	};
	if (!interactive) {
		return ledger.reserveLane(wl, { ...input, decide: (rows) => liveRefusal(rows, probeFor) ?? trainGate(ledger, rows, probeFor, decideRanked(ledger, rows, config, tried)) });
	}
	try {
		return ledger.write(() => {
			const r = ledger.reserveLane(wl, {
				...input,
				decide: (rows) => {
					const held = liveRefusal(rows, probeFor);
					if (held !== null) return held;
					const v = trainGate(ledger, rows, probeFor, decideInteractive(rows));
					if (v.launch) writePickSnapshot(ledger, rows.now);
					return v;
				},
			});
			if (!r.ok) throw new Refused(r);
			return r;
		});
	} catch (err) {
		if (err instanceof Refused) return err.result;
		throw err;
	}
}

/**
 * D2: `held: <laneId> still running (<omp|runner> pid <n>)` while an earlier lane on the workload is live (`liveLaneOf`), else
 * null. A lane that released itself is skipped (PLAN wl-mvidsu83epvpj4 D4), read from the holder history the transaction read.
 */
function liveRefusal(rows: ReserveRows, probeFor: (laneId: string, workloadId: string) => RunnerProbe): ReserveVerdict | null {
	const control = controlEntries(rows.entries, holdersOf(rows.entries, rows.workload.holder, rows.holders));
	const live = liveLaneOf(control, rows.holderChanges, (laneId) => probeFor(laneId, rows.workload.id));
	return live === null ? null : { launch: false, reason: `held: ${live.laneId} still running (${live.what} pid ${live.pid})` };
}

/**
 * PLAN wl-mvpsrr4tr0p1xc D3 and D4 on an admitted cap-exempt train (`rows.capExempt`), inside the reservation's transaction;
 * any other verdict passes unchanged. D3: `held: train lane <laneId> live on <wl>` while another open train has a lane
 * (`liveTrainLane`, its pre-claimed attempts included). D4: `not-launchable: train launch limit: <n> consecutive failed
 * launches (<lane ids>)` once `trainLaunchFailures` counts TRAIN_LAUNCH_LIMIT, whatever the cause: Jo's fresh word is a
 * reset, so it already counts from zero. PLAN wl-mvr888nftz0vcl D5: the daily budget gate (`trainBudgetGate`) refuses
 * first, `budget-paused`, `budget-decision` or `meter-error`, so every reservation path waits on it, whatever verdict it got.
 */
function trainGate(ledger: Ledger, rows: ReserveRows, probeFor: (laneId: string, workloadId: string) => RunnerProbe, v: ReserveVerdict): ReserveVerdict {
	if (!v.launch || !rows.capExempt) return v;
	const budget = trainBudgetGate(trainBudgetRows(rows), rows.now);
	if (budget !== null) return { launch: false, reason: budget.reason };
	const other = liveTrainLane(ledger, rows.workload.id, rows.now, probeFor, true);
	if (other !== null) return { launch: false, reason: `held: train lane ${other.laneId} live on ${other.workloadId}` };
	const failed = trainLaunchFailures({
		entries: rows.entries, instructions: rows.instructions, questions: rows.questions, holder: rows.workload.holder, holderLeaseUntil: rows.workload.holder_lease_until, now: rows.now,
	});
	if (failed.count >= TRAIN_LAUNCH_LIMIT) {
		return { launch: false, reason: `not-launchable: train launch limit: ${TRAIN_LAUNCH_LIMIT} consecutive failed launches (${failed.lanes.join(", ")})` };
	}
	return v;
}

/**
 * D3 (PLAN wl-mvpsrr4tr0p1xc): a lane of an open merge train other than `wl`, or null: one holding it under a live lease, one
 * `liveLaneOf` finds alive (its ps through `probeFor`), and with `pending` (the reservation) a `launch:` attempt with no
 * `lane-started:`, `launch-failed:` or `lane-exit:` whose pre-claim lease (PRECLAIM_LEASE_MS from the attempt) has not
 * lapsed at `now`. Global across repositories: one served repository today, and no git call inside the transaction.
 */
function liveTrainLane(
	ledger: Ledger, wl: string, now: string, probeFor: (laneId: string, workloadId: string) => RunnerProbe, pending: boolean,
): { laneId: string; workloadId: string } | null {
	for (const other of openTrains(ledger)) {
		if (other === wl) continue;
		const w = ledger.workload(other);
		if (w === null) continue;
		if (w.holder !== null && heldLive(w, now)) return { laneId: w.holder, workloadId: other };
		const entries = ledger.entries(other);
		const control = controlEntries(entries, holdersOf(entries, w.holder, ledger.holders(other)));
		// No holder history: a peer train's lane refuses while its runner or omp lives, self-released or not (PLAN
		// wl-mw0ytmzi89d683 F1); only the next spawner on the same workload ends a stale omp, so only that check skips it.
		const live = liveLaneOf(control, [], (laneId) => probeFor(laneId, other));
		if (live !== null) return { laneId: live.laneId, workloadId: other };
		if (!pending) continue;
		for (const a of attempts(control)) {
			const ended = control.some((c) => c.laneId === a.laneId && (c.prefix === "lane-started" || c.prefix === "launch-failed" || c.prefix === "lane-exit"));
			if (!ended && Date.parse(a.createdAt) + PRECLAIM_LEASE_MS >= Date.parse(now)) return { laneId: a.laneId, workloadId: other };
		}
	}
	return null;
}

function reserveOrExit(ledger: Ledger, wl: string, who: string, interactive: boolean): string {
	const r = reserve(ledger, wl, who, interactive);
	if (r.ok) return r.laneId;
	const code = /^cap\b/.test(r.reason) ? STARTER_EXIT.cap! : /^held\b/.test(r.reason) ? STARTER_EXIT.held! : /^closed\b/.test(r.reason) ? STARTER_EXIT.closed! : STARTER_EXIT["not-launchable"]!;
	throw new Fail("reserve", `${wl} not launched: ${r.reason}`, code);
}

// ---- launch --------------------------------------------------------------------------------------

function cmdLaunch(wl: string, who: string): number {
	const ledger = openLedger();
	const laneId = reserveOrExit(ledger, wl, who, false);
	try {
		const p = prepare(ledger, wl, false);
		ledger.write(() => {
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: worktreeBody(p.worktree) });
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: branchBody(p.branch, p.base) });
		});
		const log = openSync(join(p.dir, "runner.log"), "a");
		const runner = spawn(["bun", import.meta.path, "run", wl, laneId], {
			cwd: p.worktree, env: boundEnv(wl, laneId), stdin: "ignore", stdout: log, stderr: log, detached: true,
		});
		runner.unref();
		line(`lane ${laneId} runner ${runner.pid}`);
		return STARTER_EXIT.ok!;
	} catch (err) {
		const f = err instanceof Fail ? err : new Fail("launch", String(err), STARTER_EXIT.unknown!);
		failAfterReserve(ledger, wl, laneId, f);
		throw f;
	}
}

/**
 * The per-workload ctx index (MIGRATION.md item 43): `ctx-index` in its own detached process, stdio to
 * the lane dir's `ctx-index.log`, spawned as cmdLaunch spawns the runner. Every exit path calls it
 * after its exit, release and death writes, so nothing waits on ctx; the subcommand's claim lets one
 * worker per lane proceed. A spawn failure goes to stderr and changes nothing else.
 */
function spawnCtxIndex(wl: string, laneId: string, by: "runner" | "starter"): void {
	try {
		const dir = laneDir(wl, homeDir());
		mkdirSync(dir, { recursive: true });
		const log = openSync(join(dir, "ctx-index.log"), "a");
		const worker = spawn(["bun", import.meta.path, "ctx-index", wl, laneId, "--by", by], {
			cwd: dir, env: process.env, stdin: "ignore", stdout: log, stderr: log, detached: true,
		});
		worker.unref();
	} catch (err) {
		process.stderr.write(`lane: the ctx-index worker for ${laneId} could not be spawned: ${String(err)}\n`);
	}
}

// ---- the drain (MIGRATION.md item 71) --------------------------------------------------------------

/** The drain's log, one file for every lane: `~/.agent-system-2/lanes/drain.log` under the ledger's HOME. */
export function drainLogPath(h: string = homeDir()): string {
	return join(h, ".agent-system-2", "lanes", "drain.log");
}

/** One timestamped line in drain.log (its directory made first: the drain's starters run there); a failed append goes to stderr and changes nothing else. */
function drainLine(text: string): void {
	try {
		const log = drainLogPath();
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, `${new Date().toISOString()} ${text}\n`);
	} catch (err) {
		process.stderr.write(`lane: drain.log could not be appended (${text}): ${String(err)}\n`);
	}
}

/**
 * The starter's environment for a launch the drain makes: the caller's, without the lane binding `laneEnv` writes, so the
 * next lane's starter never carries the ended lane's role, workload, lane id or scratch root, and without a drain's tried
 * set (`DRAIN_TRIED_ENV`), which `runStarter` sets for each starter from its own drain.
 */
export function starterEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== ROLE_ENV && k !== WORKLOAD_ENV && k !== LANE_ENV && k !== SCRATCH_ENV && k !== DRAIN_TRIED_ENV) out[k] = v;
	return out;
}

/**
 * The runner's last act (MIGRATION.md item 71): `drain <wl>` in its own detached process, spawned as
 * spawnCtxIndex spawns its worker, so the runner's exit never waits on it. Called inside the exit write's
 * transaction: `spawned <pid> by <laneId>` is in drain.log before lane-exit: commits, and the drain's
 * first write waits for that commit. A spawn failure goes to stderr and changes nothing else.
 */
function spawnDrain(wl: string, laneId: string): void {
	try {
		const log = drainLogPath();
		mkdirSync(dirname(log), { recursive: true });
		const out = openSync(log, "a");
		const worker = spawn(["bun", import.meta.path, "drain", wl], {
			cwd: dirname(log), env: starterEnv(process.env), stdin: "ignore", stdout: out, stderr: out, detached: true,
		});
		worker.unref();
		drainLine(`spawned ${worker.pid} by ${laneId}`);
	} catch (err) {
		process.stderr.write(`lane: the drain for ${laneId} could not be spawned: ${String(err)}\n`);
	}
}

/**
 * One `launch <wl> --requested-by lane-runner`, awaited to its own exit with no bound and no kill: its
 * exit code and its last output line. A kill could land after the starter's reservation commits and
 * before its runner spawns, leaving the pre-claim holding the slot until its lease lapses with no
 * runner to release it and no drain to follow, so the queue behind it waits for an orchestrator tick.
 * The starter's own exception path (`cmdLaunch` → `failAfterReserve`) is what releases a failed
 * reservation, so the drain waits for it. `tried` (the drain's tried set, `wl` included) goes to the
 * starter as `DRAIN_TRIED_ENV`, so its reservation's queue gate skips the workloads the pick skipped.
 */
async function runStarter(wl: string, tried: ReadonlySet<string>): Promise<{ code: number; line: string }> {
	const p = spawn(["bun", import.meta.path, "launch", wl, "--requested-by", LANE_RUNNER_BY], {
		cwd: dirname(drainLogPath()), env: { ...starterEnv(process.env), [DRAIN_TRIED_ENV]: formatDrainTried(tried) }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	const lines = (out.trim() || err.trim()).split("\n").filter(Boolean);
	return { code, line: lines.at(-1) ?? (p.signalCode ? `the starter was killed (${p.signalCode})` : "the starter printed nothing") };
}

/**
 * `drain <wl>`: sequential. Each round reads the open workloads in the order Jev ranking's mode names
 * (`jevRank`, read fresh each round, PLAN wl-mv8k039gvogt8g D7): oldest first (`inFlight`, the tick's
 * order) in `show`, `rankOpen` order (`drainOrder`, pins first) in `order` and `parallel`, with the intake
 * queue's workloads in queue order in the positions they occupy (`drainCandidates`, PLAN wl-mvbcjadqgblr7k D5),
 * and runs the starter for the first one not yet tried whose predicate says launch and the queue gate admits
 * (`drainPick`, where a tried workload never holds the queue; the starter gets the tried set, `runStarter`), awaiting its own exit with no
 * timeout (`runStarter`: a killed starter could strand its committed reservation; its exception path
 * releases a failed one). The starter's reservation applies the rank gate, so a `ranked:`, `parallel:` or `queued:`
 * refusal is an attempt line like any other and the drain goes on to the next. Exit `cap` stops the
 * drain; any other exit (launched, failed after the reservation, refused) re-reads and goes on. Each
 * workload is tried at most once, so the drain ends after at most one attempt per open workload. Logs
 * `start`, in `show` one `rank-shadow` line per pick (what `order` would have tried, `rankShadowLine`),
 * one `attempt` line per starter, and `end` to drain.log.
 */
async function cmdDrain(after: string): Promise<number> {
	drainLine(`start ${process.pid} after ${after}`);
	let code = 0;
	const tried = new Set<string>();
	try {
		const ledger = openLedger();
		try {
			// Waits for the spawning runner's exit write to commit (BEGIN IMMEDIATE): the reads below see the freed slot.
			ledger.write(() => undefined);
			const cap = laneCap(process.env);
			for (;;) {
				const config = readRankConfig();
				const next = drainPick(ledger, tried, cap, config);
				if (next === null) break;
				if (config.mode === "show") {
					try {
						drainLine(rankShadowLine(ledger, process.pid, next, tried, cap, config));
					} catch (err) {
						drainLine(`rank-shadow ${process.pid} failed: ${String(err)}`);
					}
				}
				tried.add(next);
				const r = await runStarter(next, tried);
				drainLine(`attempt ${process.pid} ${next} exit ${r.code}: ${r.line}`);
				if (r.code === STARTER_EXIT.cap) break;
			}
		} finally {
			ledger.close();
		}
	} catch (err) {
		code = 1;
		drainLine(`failed ${process.pid} ${err instanceof Fail ? err.message : String(err)}`);
	} finally {
		drainLine(`end ${process.pid} attempts ${tried.size}`);
	}
	return code;
}

// ---- the ceiling meter (DESIGN-workload-ceiling.md § 2 item 4; PLAN wl-mvfkv7llkp7nk0 § 4) ---------------------------

/** The runner's memory across polls in this run: the notices it sent, each keyed `<level> <ceilingKey>`. */
export interface MeterState {
	sent: readonly string[];
}
export interface MeterInputs {
	/** The effective ceiling now (`effectiveCeiling`). */
	ceiling: Ceiling;
	/** The workload's spend so far: every session file's usage and the wall across runs. */
	spend: Spend;
	/** The levels the ledger already holds a ceiling notice for at this ceiling value (`ceilingNoticesSent`). */
	sent: readonly CeilingNoticeLevel[];
}
/** One poll's decision. A notice and a stop both write a `spend:` entry. */
export interface MeterResult {
	state: MeterState;
	level: 0 | 80 | 100;
	/** Send the notice for this level: once per level per ceiling value. */
	notice: CeilingNoticeLevel | null;
	/** Stop the lane: at 100 %, every time. */
	stop: boolean;
}

/**
 * One poll of the meter, pure. From 80 % of either half, the 80 % notice is sent once per ceiling value and the lane
 * keeps working; at 100 % the lane stops and the stop notice is sent once per ceiling value (a poll that jumps past 80 %
 * straight to 100 % sends only the stop notice). Once per value is the ledger's notices for it (a relaunch on the same
 * value sends nothing again) and this run's memory. Nothing is asked and nothing extends: a raised ceiling is Jo's word
 * (`extend`, `ceiling`), a new value the caller passes in, which may notify again at its own 80 % and 100 %.
 */
export function meterStep(state: MeterState, inputs: MeterInputs): MeterResult {
	const level = crossed(inputs.spend, inputs.ceiling);
	if (level === 0) return { state, level, notice: null, stop: false };
	const key = `${level} ${ceilingKey(inputs.ceiling)}`;
	const notice = inputs.sent.includes(level) || state.sent.includes(key) ? null : level;
	return { state: notice === null ? state : { sent: [...state.sent, key] }, level, notice, stop: level === 100 };
}

/**
 * The levels the workload already holds a ceiling notice for at `ceiling`'s value (`parseCeilingNotice`), whatever their
 * delivery state, plus 100 when the runner already asked Jo at that value (`parseCeilingQuestion`: the question that
 * takes the stop notice's place at a 100 % hit it did not raise, PLAN wl-mvqwn80onq9hq8 D12), so a relaunch on the same
 * value asks nothing again.
 */
export function ceilingNoticesSent(ledger: Ledger, workloadId: string, ceiling: Ceiling): CeilingNoticeLevel[] {
	const key = ceilingKey(ceiling);
	const rows = ledger.db.query<{ body: string }, [string, string]>(
		"SELECT body FROM messages WHERE workload_id = ? AND created_by = ? AND body LIKE 'notice: ceiling %' ORDER BY created_at, id",
	).all(workloadId, LANE_RUNNER_BY);
	const levels = rows.flatMap((m) => {
		const n = parseCeilingNotice(m.body);
		return n !== null && n.key === key && n.workloadId === workloadId ? [n.level] : [];
	});
	const asked = ledger.questions(workloadId).some((q) => {
		const c = q.created_by === LANE_RUNNER_BY ? parseCeilingQuestion(q.body) : null;
		return c !== null && c.key === key && c.workloadId === workloadId;
	});
	return asked ? [...levels, 100] : levels;
}

/** The notice for `level`, in one write stamped `lane-runner` with the `spend:` entry: the notice (surface/src/notice.ts) and the spend it reports. Returns the message id. */
export function sendCeilingNotice(
	ledger: Ledger, r: { workloadId: string; laneId: string; level: CeilingNoticeLevel; spend: Spend; ceiling: Ceiling; stakes: Stakes },
): string {
	return ledger.write(() => {
		const id = sendNotice(ledger, { by: LANE_RUNNER_BY, workloadId: r.workloadId, body: ceilingNoticeBody(r.level, r.workloadId, r.spend, r.ceiling, r.stakes) });
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: r.workloadId, kind: "assumption", body: spendBody(r.laneId, r.spend) });
		return id;
	});
}

// ---- the hit at 100 %: progress, the one raise by half, or Jo asked (PLAN wl-mvqwn80onq9hq8 D12) ----------------------

/** A workload branch whose remote head the progress test reads: `(origin, wl/<wl>)` and every `push-dest:` `(remote, branch)`. */
export interface PushBranch {
	remote: string;
	branch: string;
}

/** A branch's remote head as read now: the mark's fields, plus why the URL or the head is `unknown` (null when both were read). */
export interface HeadRead extends CeilingMark {
	error: string | null;
}

/** One branch's verdict at the hit: a commit the window's mark lacked is on the remote, nothing new is, or it cannot be told. */
export type PushCheck = { kind: "pushed"; sha: string } | { kind: "none" } | { kind: "unknown"; error: string };

/** The git reads of the progress test, against the workload's worktree; a test passes a fake or a probe on scratch repositories. */
export interface PushProbe {
	/** `git remote get-url --push <remote>`, then `git ls-remote --exit-code <url> refs/heads/<branch>`: one try each, 15 s. */
	read(b: PushBranch): HeadRead;
	/**
	 * Whether `head` carries a commit `base` lacks (`git merge-base --is-ancestor <head> <base>` exits 1), false when it exits
	 * 0, else the reason it cannot be told: a shallow repository, or a test that fails even after one fetch of a missing head.
	 */
	carries(url: string, branch: string, head: string, base: string): boolean | string;
}

/** The bound on each remote read of the progress test (D12): `get-url` and `ls-remote`. */
export const REMOTE_READ_MS = 15_000;
/** The bound on the one fetch of a head object missing locally (D12). */
export const OBJECT_FETCH_MS = 30_000;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The probe the runner uses: plain git in `worktree`, no terminal prompt (a credential prompt fails the read instead of hanging it). */
export function gitPushProbe(worktree: string): PushProbe {
	const run = (args: string[], timeoutMs: number) => {
		const r = spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
		const timedOut = r.exitedDueToTimeout === true;
		const code = r.exitCode ?? -1;
		const err = r.stderr.toString().replace(/\s+/g, " ").trim();
		const why = `\`git ${args.join(" ")}\` in ${worktree} ${timedOut ? `timed out after ${timeoutMs / 1000} s` : `exited ${code}${err === "" ? "" : `: ${err}`}`}`;
		return { code: timedOut ? -1 : code, out: r.stdout.toString().trim(), why };
	};
	return {
		read(b) {
			const u = run(["remote", "get-url", "--push", b.remote], REMOTE_READ_MS);
			const url = u.out.split("\n")[0]!.trim();
			if (u.code !== 0 || url === "") return { ...b, url: "unknown", head: "unknown", error: u.code === 0 ? `${u.why} with no URL` : u.why };
			if (/\s/.test(url)) return { ...b, url: "unknown", head: "unknown", error: `the push URL of ${b.remote} holds whitespace, which a ceiling-mark cannot record` };
			const ref = `refs/heads/${b.branch}`;
			const ls = run(["ls-remote", "--exit-code", url, ref], REMOTE_READ_MS);
			if (ls.code === 2) return { ...b, url, head: "none", error: null };
			if (ls.code !== 0) return { ...b, url, head: "unknown", error: ls.why };
			const line = ls.out.split("\n").map((l) => l.split("\t")).find((p) => p[1] === ref);
			if (line === undefined) return { ...b, url, head: "none", error: null };
			return SHA.test(line[0]!) ? { ...b, url, head: line[0]!, error: null } : { ...b, url, head: "unknown", error: `${ls.why} printed ${line[0]} for ${ref}, not a sha` };
		},
		carries(url, branch, head, base) {
			const shallow = run(["rev-parse", "--is-shallow-repository"], REMOTE_READ_MS);
			if (shallow.code !== 0) return shallow.why;
			if (shallow.out === "true") return "shallow clone";
			if (run(["cat-file", "-e", `${head}^{commit}`], REMOTE_READ_MS).code !== 0) {
				const f = run(["fetch", "--no-write-fetch-head", url, `refs/heads/${branch}`], OBJECT_FETCH_MS);
				if (f.code !== 0) return f.why;
			}
			const a = run(["merge-base", "--is-ancestor", head, base], REMOTE_READ_MS);
			return a.code === 1 ? true : a.code === 0 ? false : a.why;
		},
	};
}

/** The progress test of one branch at the hit (D12): its head read now against the window's mark. */
export function pushCheck(b: PushBranch, mark: CeilingMark | undefined, now: HeadRead | undefined, probe: PushProbe): PushCheck {
	const unknown = (error: string): PushCheck => ({ kind: "unknown", error });
	if (now === undefined) return unknown("the remote was not read before the deciding write");
	if (mark === undefined) return unknown("no ceiling-mark in the window");
	if (now.url === "unknown") return unknown(now.error ?? "the push URL could not be read");
	if (mark.url === "unknown") return unknown("the mark's push URL is unknown");
	if (now.url !== mark.url) return unknown("push URL changed");
	if (mark.head === "unknown") return unknown("the mark's head is unknown");
	if (now.head === "unknown") return unknown(now.error ?? "the head could not be read");
	// A deletion, an unchanged head (a dry run, an up-to-date push) and a head moved back are never a pushed commit.
	if (now.head === "none" || now.head === mark.head) return { kind: "none" };
	if (mark.head === "none") return { kind: "pushed", sha: now.head };
	const c = probe.carries(now.url, b.branch, now.head, mark.head);
	return c === true ? { kind: "pushed", sha: now.head } : c === false ? { kind: "none" } : unknown(c);
}

/** `(origin, wl/<wl>)`, then every `(remote, branch)` the workload's `push-dest:` rows name, once each. */
export function ceilingBranches(workloadId: string, control: readonly ControlEntry[]): PushBranch[] {
	const out: PushBranch[] = [{ remote: "origin", branch: branchName(workloadId) }];
	for (const c of control) {
		const d = c.prefix === "push-dest" ? parsePushDest(c.body) : null;
		if (d !== null && !out.some((b) => b.remote === d.remote && b.branch === d.branch)) out.push({ remote: d.remote, branch: d.branch });
	}
	return out;
}

const branchKey = (b: PushBranch): string => `${b.remote} ${b.branch}`;

/** What one meter poll reads off the ledger, before its write and again inside it. */
interface MeterView {
	w: WorkloadRow;
	control: ControlEntry[];
	ceiling: Ceiling;
	step: MeterResult;
	/** Where the progress window opens: the newest 80 or 100 % ceiling notice, else the `ceiling:` row in force; null with neither. */
	start: string | null;
	branches: PushBranch[];
	/**
	 * Per `branchKey`, the window's mark: the branch's newest `ceiling-mark:` at or after `start`. Newest, not oldest: a
	 * baseline poll in the notice's own millisecond writes a mark that ties with the notice's own, and the notice's (the later
	 * head) must win; a later mark only moves the baseline forward, so it can only ask Jo more, never raise more.
	 */
	marks: Map<string, CeilingMark>;
}

function meterView(ledger: Ledger, r: { workloadId: string; spend: Spend; state: MeterState }): MeterView {
	const w = ledger.workload(r.workloadId);
	if (!w) throw new Error(`no workload ${r.workloadId}`);
	const es = ledger.entries(r.workloadId);
	const control = controlEntries(es, holdersOf(es, w.holder, ledger.holders(r.workloadId)));
	const inForce = ceilingInForce(control, ledger.instructions(r.workloadId), w.stakes);
	const step = meterStep(r.state, { ceiling: inForce.ceiling, spend: r.spend, sent: ceilingNoticesSent(ledger, r.workloadId, inForce.ceiling) });
	const notices = ledger.db.query<{ body: string; created_at: string }, [string, string]>(
		"SELECT body, created_at FROM messages WHERE workload_id = ? AND created_by = ? AND body LIKE 'notice: ceiling %' ORDER BY created_at DESC, id DESC",
	).all(r.workloadId, LANE_RUNNER_BY);
	const start = notices.find((m) => parseCeilingNotice(m.body)?.workloadId === r.workloadId)?.created_at ?? inForce.at;
	const marks = new Map<string, CeilingMark>();
	for (const c of control) {
		const m = c.prefix === "ceiling-mark" && (start === null || c.createdAt >= start) ? parseCeilingMark(c.rest) : null;
		if (m !== null) marks.set(branchKey(m), m);
	}
	return { w, control, ceiling: inForce.ceiling, step, start, branches: ceilingBranches(r.workloadId, control), marks };
}

/**
 * The progress inside the window (D12), mechanical: a slice of the workload moved to done; a branch whose remote head
 * carries a commit its mark lacked (`pushes`, read before the write); a complete review round settled in the window whose
 * known blocking count is below the previous complete round of the same loop. `found` is the first, as `<kind> <evidence>`;
 * `unknown` is every branch that could not be told, as `push check failed: <remote> <branch>: <error>`.
 */
function progressOf(ledger: Ledger, v: MeterView, pushes: ReadonlyMap<string, PushCheck> | null): { found: string | null; unknown: string[] } {
	const wl = v.w.id;
	// Strictly after the window opens: a slice closed or a round settled in the notice's own millisecond may precede it, so a
	// tie is never proven progress (it asks Jo). Marks keep `>=` (meterView): the notice's own write records them, from heads read before it.
	const inWindow = (t: string) => v.start === null || t > v.start;
	const found: string[] = [];
	const unknown: string[] = [];
	const slices = ledger.slices(wl);
	const done = slices.find((s) => s.state === "done" && inWindow(s.changed_at));
	if (done) found.push(`slice-closed ${done.id}`);
	for (const b of v.branches) {
		const p = pushes?.get(branchKey(b)) ?? { kind: "unknown", error: "the remote was not read before the deciding write" };
		if (p.kind === "pushed") found.push(`commit-pushed ${b.remote} ${b.branch} ${p.sha}`);
		else if (p.kind === "unknown") unknown.push(`push check failed: ${b.remote} ${b.branch}: ${p.error}`);
	}
	const entries = ledger.entries(wl, "assumption");
	for (const s of slices) {
		const rounds = countRounds(entries, s.id).rounds.filter((x) => x.complete);
		for (let i = 1; i < rounds.length; i++) {
			const prev = rounds[i - 1]!;
			const cur = rounds[i]!;
			// Both rounds' counts fully known (as fellEveryRound reads them): a member with no readable findings is missing evidence, never a drop.
			if (prev.blocking === null || prev.unknown > 0 || prev.unread || cur.blocking === null || cur.unknown > 0 || cur.unread || cur.blocking >= prev.blocking) continue;
			const settled = entries.filter((e) => {
				const rr = parseReviewRound(e.body);
				return rr !== null && rr.slice === s.id && rr.group === cur.group;
			}).map((e) => e.created_at).reduce((a, b) => (b > a ? b : a), "");
			if (settled !== "" && inWindow(settled)) found.push(`blocking-fell ${s.id} ${prev.blocking}→${cur.blocking}`);
		}
	}
	return { found: found[0] ?? null, unknown };
}

/** The ceiling question's raise failed: `raiseError` (null when no raise was tried) and `questionError` both, for the alarm line. */
class CeilingAskError extends Error {
	constructor(readonly raiseError: string | null, readonly questionError: string) {
		super(raiseError === null ? `the ceiling question failed: ${questionError}` : `the ceiling raise failed: ${raiseError}; the ceiling question failed too: ${questionError}`);
	}
}

/**
 * Ask Jo at the hit (D12), inside the caller's write, through `askJo`: on the workload's newest slice still open (running
 * or paused), else on a new `sl-ceiling-<n>` slice ("decide the ceiling") the same write adds. Options `extend` / `stop`.
 */
function raiseCeilingQuestion(ledger: Ledger, r: { workloadId: string; spend: Spend }, v: MeterView, first: string, progress: string | null): string {
	const wl = r.workloadId;
	let sl = ledger.slices(wl).findLast((s) => s.state === "open" || s.state === "paused")?.id;
	if (sl === undefined) {
		let n = 1;
		while (ledger.slice(`sl-ceiling-${n}`) !== null) n++;
		sl = ledger.addSlice({
			by: LANE_RUNNER_BY, workloadId: wl, id: `sl-ceiling-${n}`, task: "decide the ceiling",
			doneCondition: `Jo answered the runner's ceiling question on ${wl} (extend or stop)`, inputs: `the runner's ceiling question on ${wl}`,
		});
	}
	const body = ceilingQuestionBody(first, wl, r.spend, v.ceiling, v.w.stakes, progress);
	const asked = askJo(ledger, { by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl, body, options: [...CEILING_QUESTION_OPTIONS] }, { asker: "lane", now: Date.parse(ledger.now()) });
	return raisedId(asked, `the ceiling question of ${wl}`);
}

/** What a 100 % hit of an autonomous lane did instead of the stop notice (D12). */
export type CeilingHit =
	| { kind: "raised"; ceiling: Ceiling; progress: string }
	| { kind: "asked"; questionId: string; first: string }
	/** Every write failed: the stop stands unaccepted and a `ceiling` alarm line names the errors. */
	| { kind: "alarm"; error: string };

/**
 * The hit at 100 % of an autonomous lane (D12), inside the meter's write. Eligible (progress in the window, no earlier
 * `auto-raise half` row, auto-apply on): one nested write of the runner's `ceiling:` at `halfRaise`, its
 * `launch-requested:` and the one-line raise notice. Not eligible, or `halfRaise` null, or that write thrown (rolled back
 * whole): Jo is asked, the reason on the question's first line. A question that cannot be written throws
 * `CeilingAskError` naming every error.
 */
function ceilingHit(ledger: Ledger, r: { workloadId: string; spend: Spend }, v: MeterView, pushes: ReadonlyMap<string, PushCheck> | null, alarmFile: () => string): CeilingHit {
	const wl = r.workloadId;
	const ask = (first: string, progress: string | null, raiseError: string | null = null): CeilingHit => {
		try {
			return { kind: "asked", questionId: raiseCeilingQuestion(ledger, r, v, first, progress), first };
		} catch (err) {
			throw new CeilingAskError(raiseError, oneLine(err));
		}
	};
	if (autoRaiseUsed(v.control)) return ask(`ceiling reached on ${wl}: auto-raise already used`, null);
	let routine: ReturnType<typeof routineState>;
	try {
		routine = routineState(ledger, Date.parse(ledger.now()), { alarmFile: alarmFile() });
	} catch (err) {
		// routineState throws rather than default to on (D1): the hit asks Jo, naming why.
		return ask(`ceiling reached on ${wl}: auto-apply state unreadable: ${oneLine(err)}`, null);
	}
	if (!routine.on) {
		const off = routine.offs.at(-1);
		const why = off?.by === "ask-all" ? "ask-all"
			: routine.rulingEndedBy !== null ? `auto-apply off: ruling routine-calls ended by ${routine.rulingEndedBy}`
			: off !== undefined ? `auto-apply off: ${describeOff(off)}`
			: routine.latches.length > 0 ? `auto-apply off: ${describeOff(routine.latches[0]!)}`
			: "auto-apply off";
		return ask(`ceiling reached on ${wl}: ${why}`, null);
	}
	const p = progressOf(ledger, v, pushes);
	if (p.found === null) return ask(`ceiling reached on ${wl}: ${p.unknown.length > 0 ? p.unknown.join("; ") : `no progress since ${v.start ?? v.w.created_at}`}`, null);
	const progress = [p.found, ...p.unknown].join("; ");
	const next = halfRaise(v.ceiling);
	if (next === null) return ask(`ceiling auto-raise failed: half of $${v.ceiling.usd} / ${v.ceiling.wallMin} min rounds to no raise`, progress);
	try {
		ledger.write(() => {
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: ceilingBody(next, `${AUTO_RAISE_SOURCE} progress ${progress}`) });
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody(LANE_RUNNER_BY, ledger.now(), "ceiling auto-raise") });
			sendNotice(ledger, { by: LANE_RUNNER_BY, workloadId: wl, body: ceilingRaisedNoticeBody(wl, v.ceiling, next, progress) });
		});
		return { kind: "raised", ceiling: next, progress };
	} catch (err) {
		const raiseError = oneLine(err);
		return ask(`ceiling auto-raise failed: ${raiseError}`, progress, raiseError);
	}
}

/** Append D12's `kind: "ceiling"` alarm line (the `CEILING ALARM <wl>` needs-you line); a failed append is named on stderr with the errors it carried. */
function appendCeilingAlarm(alarmFile: () => string, line: { workload: string; error: string; raiseError: string | null; questionError: string | null }): void {
	let file = "the alarm file";
	try {
		file = alarmFile();
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ kind: CEILING_ALARM_KIND, at: new Date().toISOString(), ...line })}\n`);
	} catch (err) {
		process.stderr.write(`runner: the ceiling alarm line could not be appended to ${file}: ${oneLine(err)}; it carried: ${line.error}\n`);
	}
}

/** One meter poll's outcome: the step, whether its ceiling stop's `lane-stop: <lane> accepted ceiling` is on the ledger, and what a 100 % hit did. */
export interface MeterPoll extends MeterResult {
	accepted: boolean;
	hit: CeilingHit | null;
}

/**
 * One meter poll on the ledger, in one transaction: the ceiling in force read now (the workload's control entries, its
 * instructions and its stakes), the step over `spend`, the notice or the stop's `spend:` entry, and on a stop the
 * `lane-stop: <lane> accepted ceiling`. A raise (surface/src/input.ts `raiseCeiling`, also one transaction) therefore
 * lands either before it, and the lane goes on under the new value, or after it, and sees the accepted stop and requests
 * the relaunch; never between a stop decided on the old value and its acceptance.
 *
 * PLAN wl-mvqwn80onq9hq8 D12: the first 100 % hit at a ceiling value of an autonomous lane sends no stop notice; the same
 * write rises once by half or asks Jo (`ceilingHit`). The remote heads are read before the write, never inside it
 * (`probe`, at most 15 s a read): every branch at a notice or a hit, and a branch with no mark in the window at any poll.
 * Each such read is written as a `ceiling-mark:` in the write. When the writes fail after a stop was decided, the stop
 * still stands (`accepted` false: the caller accepts it on its own) and the state is unchanged; when that write was a
 * hit's, a `ceiling` alarm line in `alarmFile` names every error. Any other failure throws.
 */
export function meterPoll(
	ledger: Ledger, r: { workloadId: string; laneId: string; spend: Spend; state: MeterState; probe: PushProbe; alarmFile?: string },
): MeterPoll {
	const alarmFile = () => r.alarmFile ?? alarmFilePath(process.env);
	const pre = meterView(ledger, r);
	const read = pre.step.notice !== null ? pre.branches : pre.branches.filter((b) => !pre.marks.has(branchKey(b)));
	const heads = new Map(read.map((b) => [branchKey(b), r.probe.read(b)] as const));
	const pushes = pre.step.notice === 100 && pre.w.mode === "autonomous" && !autoRaiseUsed(pre.control)
		? new Map(pre.branches.map((b) => [branchKey(b), pushCheck(b, pre.marks.get(branchKey(b)), heads.get(branchKey(b)), r.probe)] as const))
		: null;
	let decided = null as MeterResult | null;
	let hitTried = false as boolean;
	try {
		const out = ledger.write(() => {
			decided = null;
			hitTried = false;
			const v = meterView(ledger, r);
			const s = v.step;
			decided = s;
			const entry = (body: string) => ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: r.workloadId, kind: "assumption", body });
			for (const b of s.notice !== null ? v.branches : v.branches.filter((x) => !v.marks.has(branchKey(x)))) {
				const h = heads.get(branchKey(b));
				if (h !== undefined) entry(ceilingMarkBody(h));
			}
			let hit: CeilingHit | null = null;
			if (s.notice === 100 && v.w.mode === "autonomous") {
				hitTried = true;
				entry(spendBody(r.laneId, r.spend));
				// `pushes` was checked against the pre-write window: a branch whose window start or mark changed since (a ceiling
				// word, a notice, a mark landing in between) is unknown, never progress, so a push read before the window opened cannot raise.
				const current = pushes === null ? null : new Map(v.branches.map((b) => {
					const k = branchKey(b);
					const unchanged = v.start === pre.start && JSON.stringify(v.marks.get(k) ?? null) === JSON.stringify(pre.marks.get(k) ?? null);
					const p: PushCheck = unchanged ? (pushes.get(k) ?? { kind: "unknown", error: "the remote was not read before the deciding write" }) : { kind: "unknown", error: "the window or its mark changed between the remote read and the deciding write" };
					return [k, p] as const;
				}));
				hit = ceilingHit(ledger, r, v, current, alarmFile);
			} else if (s.notice !== null) sendCeilingNotice(ledger, { workloadId: r.workloadId, laneId: r.laneId, level: s.notice, spend: r.spend, ceiling: v.ceiling, stakes: v.w.stakes });
			else if (s.stop) entry(spendBody(r.laneId, r.spend));
			if (s.stop) entry(laneStopAcceptedBody(r.laneId, "ceiling"));
			return { s, hit };
		});
		return { ...out.s, accepted: out.s.stop, hit: out.hit };
	} catch (err) {
		if (decided === null || !decided.stop) throw err;
		process.stderr.write(`runner: the ceiling stop's writes failed: ${oneLine(err)}\n`);
		if (!hitTried) return { ...decided, state: r.state, accepted: false, hit: null };
		const ask = err instanceof CeilingAskError ? err : null;
		const error = ask?.message ?? `the ceiling hit's write failed: ${oneLine(err)}`;
		appendCeilingAlarm(alarmFile, { workload: r.workloadId, error, raiseError: ask?.raiseError ?? null, questionError: ask?.questionError ?? null });
		return { ...decided, state: r.state, accepted: false, hit: { kind: "alarm", error } };
	}
}

/** One train meter poll's outcome (PLAN wl-mvr888nftz0vcl D4): whether the lane stops, why, and what the poll wrote. */
export interface TrainMeterPoll {
	stop: boolean;
	/** The stop's acceptance: `meter-error` when the scan found a defect (a pause on the same poll is still written), else `budget`. */
	ref: "budget" | "meter-error" | null;
	/** The acceptance `lane-stop: <lane> accepted <ref>` is on the ledger; false when the writes failed after a stop was decided. */
	accepted: boolean;
	day: string;
	spent: number;
	errorId: string | null;
	/** On a scan defect, where every defect was kept (`writeMeterEvidence`): the evidence file's path, or why it was not written. */
	evidence: TrainMeterEvidence | null;
	pauseId: string | null;
	questionId: string | null;
}

/**
 * A meter error's evidence (PLAN wl-mvr888nftz0vcl D5, D9): every defect of one poll, as JSON, in a new file
 * `<laneDir>/meter-errors/<lane>-<instant>.json` under the lane directory the runner already writes this workload's files in
 * (`prepare`'s `dir`). Never overwrites a kept file (`wx`). Returns the path, or why the write failed; it never throws, so
 * the stop it is evidence for still happens. On a failed write it logs the failure and every defect, one per line, and the
 * `train-meter-error:` (`trainMeterErrorBody` with `{ failed }`) names every defect too (review r2 B1).
 */
export function writeMeterEvidence(
	laneDir: string, r: { workloadId: string; laneId: string; errors: readonly TrainScanError[]; nowMs: number },
): TrainMeterEvidence {
	try {
		const at = new Date(r.nowMs).toISOString();
		const dir = join(laneDir, "meter-errors");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${r.laneId}-${at.replace(/:/g, "-")}.json`);
		const defects = r.errors.map((e) => ({ file: e.file, line: e.line, reason: e.reason }));
		writeFileSync(path, `${JSON.stringify({ workloadId: r.workloadId, laneId: r.laneId, at, count: defects.length, defects }, null, "\t")}\n`, { flag: "wx" });
		return { path };
	} catch (err) {
		const failed = `${oneLine(err)} (under ${laneDir})`;
		const lines = r.errors.map((e) => `runner:   ${r.laneId} meter defect ${e.file}:${e.line} ${oneLine(e.reason)}\n`).join("");
		process.stderr.write(
			`runner: the train meter's evidence file for ${r.laneId} on ${r.workloadId} could not be written: ${failed}; its train-meter-error: names all ${r.errors.length} defects instead, and so do these lines:\n${lines}`,
		);
		return { failed };
	}
}

/**
 * One train meter poll on the ledger, in one transaction (D4): today's PDT spend from `scan` against `trainDayLimit` read
 * now, so a raise lands wholly before or after it. Under the limit nothing is written (no notice, no wall). At or over it:
 * `train-paused:` (the PR `activeTrainPr` names for this lane), its raise/wait question (`askTrainPause`, keyed to the
 * pause) and `lane-stop: <lane> accepted budget`. A scan defect first keeps every defect in an evidence file under `laneDir`
 * (`writeMeterEvidence`), then writes `train-meter-error:` naming the first TRAIN_METER_NAMED defects, how many more, and
 * that file, or, when the file could not be written, every defect and why (`trainMeterErrorBody`), and `lane-stop: <lane>
 * accepted meter-error`; a pause the same poll reaches is written too, so one failure never hides the other. When the writes
 * fail after a stop was decided (any scan defect is one), the stop still stands (`accepted` false: the caller accepts it on
 * its own), the meter error is logged whole, and the log says the stop counts against the launch limit: with no episode row
 * naming the lane, `trainMeterStopped` (surface/src/merge-train.ts) does not exempt it. Any other failure throws.
 */
export function trainMeterPoll(
	ledger: Ledger,
	r: { workloadId: string; laneId: string; laneDir: string; scan: TrainScan; errors: readonly TrainScanError[]; nowMs: number },
): TrainMeterPoll {
	const day = pdtDay(r.nowMs);
	const spent = r.scan.days.get(day) ?? 0;
	const failed = r.errors.length > 0;
	let ref: TrainMeterPoll["ref"] = failed ? "meter-error" : null;
	const evidence = failed ? writeMeterEvidence(r.laneDir, r) : null;
	const errorBody = failed ? trainMeterErrorBody(r.laneId, r.errors, evidence) : null;
	try {
		return ledger.write(() => {
			const recordAs = (body: string): string => ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: r.workloadId, kind: "assumption", body });
			if (!ledger.workload(r.workloadId)) throw new Error(`no workload ${r.workloadId}`);
			const entries = ledger.entries(r.workloadId);
			const limit = trainDayLimit(controlEntries(entries), day);
			const over = spent >= limit;
			ref = failed ? "meter-error" : over ? "budget" : null;
			const errorId = errorBody === null ? null : recordAs(errorBody);
			let pauseId: string | null = null;
			let questionId: string | null = null;
			if (over) {
				const pr = activeTrainPr({ workloadId: r.workloadId, entries, slices: ledger.slices(r.workloadId) }, r.laneId);
				pauseId = recordAs(trainPausedBody({ laneId: r.laneId, day, usd: spent, limit, pr, until: new Date(nextPdtMidnight(r.nowMs)).toISOString() }));
				questionId = askTrainPause(ledger, r.workloadId, pauseId);
			}
			if (ref !== null) recordAs(laneStopAcceptedBody(r.laneId, ref));
			return { stop: ref !== null, ref, accepted: ref !== null, day, spent, errorId, evidence, pauseId, questionId };
		});
	} catch (err) {
		if (ref === null) throw err;
		const lost = errorBody === null ? "" : `; the meter error it could not record: ${errorBody}`;
		// Review r2 B2: with no train-paused: or train-meter-error: naming this lane, its stop is no recorded episode, so
		// trainLaunchFailures (surface/src/merge-train.ts) counts it as a failed launch and TRAIN_LAUNCH_LIMIT bounds the relaunches.
		process.stderr.write(
			`runner: the train meter's ${ref} stop could not be written on ${r.workloadId}: ${String(err)}; the lane is stopped anyway, and with no episode row naming ${r.laneId} this stop counts against the train's launch limit (${TRAIN_LAUNCH_LIMIT} failed launches)${lost}\n`,
		);
		return { stop: true, ref, accepted: false, day, spent, errorId: null, evidence, pauseId: null, questionId: null };
	}
}

/** What `recordDecision` wrote, step by step (the tests read it; the runner only logs failures). */
export interface DecisionRecord {
	death: "written" | "present" | "failed" | "none";
	marker: "written" | "failed" | "none";
}

/**
 * The runner's decided outcome on the ledger before stdin EOF (MIGRATION.md item 40), each step in its own try/catch that
 * logs and goes on: (1) a death enqueues its lane-died: line (D5; whatever the holder, so a release cannot hide it, D3),
 * with the background suffix when omp was not settled; (2) an intended outcome records `lane-decided:` so the lane row's
 * session_shutdown reads the end as intended (`exitClass`, decision 14). A death outcome never writes the marker: its
 * record is its death.
 */
export function recordDecision(
	ledger: Ledger,
	d: { workloadId: string; laneId: string; outcome: LaneOutcome; death: string | null; settled: boolean },
): DecisionRecord {
	const out: DecisionRecord = { death: "none", marker: "none" };
	if (d.death !== null) {
		try {
			const id = enqueueRunnerDeath(ledger, { workloadId: d.workloadId, laneId: d.laneId, body: d.settled ? d.death : `${d.death}${BACKGROUND_SUFFIX}` });
			out.death = id === null ? "present" : "written";
		} catch (err) {
			out.death = "failed";
			process.stderr.write(`runner: the lane-died: line could not be written: ${String(err)}\n`);
		}
	}
	if (INTENDED_OUTCOMES[d.outcome]) {
		try {
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: d.workloadId, kind: "assumption", body: laneDecidedBody(d.laneId, d.outcome) });
			out.marker = "written";
		} catch (err) {
			out.marker = "failed";
			process.stderr.write(`runner: the lane-decided: line could not be written: ${String(err)}\n`);
		}
	}
	return out;
}

/** The first prompt's ceiling line: the ceiling, the spend so far, and the remainder a brief's ceiling-share comes from. */
export function ceilingPromptLine(c: Ceiling, s: Spend): string {
	const usd = Math.max(0, c.usd - s.usd);
	const wall = Math.max(0, c.wallMin - s.wallMin);
	return `ceiling: $${c.usd} / ${c.wallMin} min for the workload; spent so far $${s.usd.toFixed(2)} / ${Math.round(s.wallMin)} min (${Math.round(s.tokens)} tokens); set each brief's ceiling-share from the remainder, $${usd.toFixed(2)} / ${Math.round(wall)} min. At 80 % Jo gets a notice; at 100 % the ceiling rises once by half when the work made progress since the last ceiling notice; otherwise this lane stops and Jo is asked.`;
}

// ---- the run guard: one runner per lane id ---------------------------------------------------------

/**
 * The first live lane on a workload (PLAN wl-mvgn310dpi5gcg D2), or null: every lane id with a `lane-started:` after its newest
 * `lane-exit:`, newest first, checked by `liveRunnerOf` with `probeFor(laneId)`. A lane whose runner or omp is alive refuses
 * a new reservation, and so does one ps could not answer for (`uninspected`) or could not verify (`unverified`), as `cmdRun`
 * treats them, unless the lane released itself (`selfReleased` over `changes`, the workload's holder history; PLAN
 * wl-mvidsu83epvpj4 D4): its pids are stale, and the process that spawns the next omp ends them first (`staleOmps`,
 * `endStale`). A lane whose lease lapsed, that was taken over, or that crashed mid-turn did not release itself and still
 * refuses while live. A crashed runner (both pids gone) never refuses.
 */
export function liveLaneOf(
	control: readonly ControlEntry[], changes: readonly HolderChange[], probeFor: (laneId: string) => RunnerProbe,
): (LiveRunner & { laneId: string }) | null {
	const done = new Set<string>();
	for (let i = control.length - 1; i >= 0; i--) {
		const { prefix, laneId } = control[i]!;
		if (laneId === null || done.has(laneId)) continue;
		if (prefix === "lane-exit") done.add(laneId);
		if (prefix !== "lane-started") continue;
		done.add(laneId);
		if (selfReleased(changes, laneId)) continue;
		const live = liveRunnerOf(control, laneId, process.pid, probeFor(laneId));
		if (live !== null) return { laneId, ...live };
	}
	return null;
}

/** One stale omp (D4): a self-released lane's omp pid and the ps start time its `lane-started:` recorded. */
export interface StaleOmp {
	laneId: string;
	pid: number;
	start: string;
}

/**
 * D4's stale set, pure: every lane id but `selfLaneId` with a `lane-started:` after its newest `lane-exit:` that released
 * itself (`selfReleased`), with each distinct omp pid and start time those entries recorded (the runner re-records
 * `lane-started:` with the same pids once omp names its session). A lane that did not release itself is never stale.
 */
export function staleOmps(control: readonly ControlEntry[], changes: readonly HolderChange[], selfLaneId: string): StaleOmp[] {
	const out: StaleOmp[] = [];
	const done = new Set<string>([selfLaneId]);
	const seen = new Set<string>();
	for (let i = control.length - 1; i >= 0; i--) {
		const { prefix, laneId } = control[i]!;
		if (laneId === null || done.has(laneId)) continue;
		if (prefix === "lane-exit") {
			done.add(laneId);
			continue;
		}
		if (prefix !== "lane-started" || !selfReleased(changes, laneId)) continue;
		const s = laneStarted([control[i]!], laneId);
		if (s === null || s.pid <= 0 || seen.has(`${s.pid} ${s.start}`)) continue;
		seen.add(`${s.pid} ${s.start}`);
		out.push({ laneId, pid: s.pid, start: s.start });
	}
	return out;
}

/** `endStale`'s outside world: ps, the signal, the clock and its sleep, the log line, the cancel check; the tests pass short waits or a fake clock. */
export interface EndStaleOptions {
	/** Called before every probe and every poll tick; true ends `endStale` at once (a stop was accepted). */
	cancelled?: () => boolean;
	/** One line per ps or kill failure, and per pid left alive (runner.log for the runner, stderr for the interactive starter). */
	log?: (line: string) => void;
	run?: PsRun;
	kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	deadlineMs?: number;
	graceMs?: number;
	pollMs?: number;
	/** The clock every grace and the aggregate deadline are read on (default `Date.now`). */
	now?: () => number;
	/** The wait between polls (default `Bun.sleep`); a fake clock advances `now` here. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * D4 (r1 F4): end the stale omps before this process spawns its own, within one aggregate deadline (`STALE_END_MS`). Each
 * is sent SIGTERM only while `ps -p <pid> -o stat=,lstart=` still matches its recorded start time (`ompPidState` `same`:
 * a reused pid, a zombie, a gone pid or one with no recorded start time is never signalled); they are polled together.
 * A pid gets SIGKILL `END_GRACE_MS` after its own SIGTERM, or one poll before the deadline, whichever comes first, and
 * each signal follows that pid's own fresh probe in the same pass, never a match cached from an earlier one. The deadline
 * and the cancel check come before every probe, so it returns by the deadline plus one ps bound. It never throws: every
 * ps or kill failure is one `log` line, and it returns what is still alive (or was never shown gone) at the deadline, on
 * cancel, or once none is left. Only POSIX `ps` fields and `process.kill` (D5). Callers wait outside any ledger
 * transaction and spawn whatever it returns.
 */
export async function endStale(stale: readonly StaleOmp[], o: EndStaleOptions = {}): Promise<StaleOmp[]> {
	const run = o.run ?? runPs;
	const log = o.log ?? ((l: string) => process.stderr.write(`${l}\n`));
	const kill = o.kill ?? ((pid: number, signal: "SIGTERM" | "SIGKILL") => process.kill(pid, signal));
	const cancelled = o.cancelled ?? (() => false);
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
	const deadline = now() + (o.deadlineMs ?? STALE_END_MS);
	const pollMs = o.pollMs ?? 250;
	const graceMs = o.graceMs ?? END_GRACE_MS;
	// The last escalation is due one poll before the deadline, so its pass still probes before the deadline stops probing.
	const killCap = deadline - pollMs;
	/** The pid is still the recorded omp; a failed probe is logged and counted as alive (never shown gone), never signalled. */
	const state = (s: StaleOmp): PidState => ompPidState(s.pid, s.start, run, (reason) => log(`endStale: ${s.laneId} omp pid ${s.pid}: ps failed: ${reason}`));
	const signal = (s: StaleOmp, sig: "SIGTERM" | "SIGKILL"): void => {
		try {
			kill(s.pid, sig);
		} catch (err) {
			log(`endStale: ${s.laneId} omp pid ${s.pid}: ${sig} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const past = (): boolean => now() >= deadline;
	/** Each pid's SIGKILL due time, set at its own SIGTERM. */
	const killDue = new Map<StaleOmp, number>();
	/** One probe of every pid in `of`, the cancel check and the deadline before each; the unprobed rest is kept as is. */
	const probe = (of: readonly StaleOmp[]): StaleOmp[] => {
		const next: StaleOmp[] = [];
		for (let i = 0; i < of.length; i++) {
			if (cancelled() || past()) return [...next, ...of.slice(i)];
			const s = of[i]!;
			const st = state(s);
			if (st === "unknown") log(`endStale: ${s.laneId} omp pid ${s.pid}: alive with no recorded start time, not signalled`);
			if (st !== "same" && st !== "failed") continue;
			if (st === "same") {
				const due = killDue.get(s);
				if (due === undefined) {
					killDue.set(s, Math.min(now() + graceMs, killCap));
					signal(s, "SIGTERM");
				} else if (now() >= due) signal(s, "SIGKILL");
			}
			next.push(s);
		}
		return next;
	};
	/** The pids not shown gone at their newest probe (a failed probe counts as alive and is never signalled). */
	let left = probe(stale);
	while (left.length > 0 && !cancelled() && !past()) {
		const nextDue = Math.min(deadline, ...left.map((s) => killDue.get(s) ?? deadline).filter((d) => d > now()));
		await sleep(Math.max(1, Math.min(pollMs, nextDue - now())));
		left = probe(left);
	}
	for (const s of left) log(`endStale: ${s.laneId} omp pid ${s.pid}: not shown gone when endStale returned`);
	return left;
}

/** D4: the stale set as the ledger stands now (`staleOmps`), read by the process about to spawn omp, outside any transaction. */
export function staleOf(ledger: Ledger, wl: string, laneId: string): StaleOmp[] {
	const es = ledger.entries(wl);
	return staleOmps(controlEntries(es, holdersOf(es, ledger.workload(wl)?.holder ?? null, ledger.holders(wl))), ledger.holderChanges(wl), laneId);
}

/**
 * D4 at the spawner (the runner, `cmdInteractive`): read the stale set (`staleOf`) and end it (`endStale`), one stderr line
 * per pid and per failure, prefixed `who:`. Never throws: a failed read is logged and the spawn proceeds.
 */
async function endStaleBeforeSpawn(ledger: Ledger, wl: string, laneId: string, who: string, cancelled?: () => boolean): Promise<void> {
	const log = (l: string): void => {
		process.stderr.write(`${who}: ${l}\n`);
	};
	let stale: StaleOmp[];
	try {
		stale = staleOf(ledger, wl, laneId);
	} catch (err) {
		log(`endStale: the stale set could not be read: ${oneLine(err)}`);
		return;
	}
	if (stale.length === 0) return;
	log(`${laneId} ending the stale omp(s) of self-released lane(s): ${stale.map((s) => `${s.laneId} pid ${s.pid}`).join(", ")}`);
	await endStale(stale, { log, cancelled });
}

/** Whether `laneId` still holds the workload it reserved (D2b): a lapsed lease with the holder unchanged still does. */
export function stillReserved(workload: Pick<WorkloadRow, "holder"> | null, laneId: string): boolean {
	return workload !== null && workload.holder === laneId;
}

/**
 * D2b: the spawn, inside the one ledger write that spawns omp and records its `lane-started:` (the runner's `startAsOwner`
 * body, `cmdInteractive`'s spawn write). With nothing spawned yet (`current` null), the workload must still be held by
 * `laneId` (`stillReserved`), else nothing is spawned and a `held` Fail (stage `reserve`) rolls the write back: another
 * starter reserved after this reservation's pre-claim lapsed. On an open merge train (PLAN wl-mvpsrr4tr0p1xc D3) the same
 * refusal follows while another open train holds a live lease or has a started lane `liveLaneOf` finds alive (its ps
 * through `probeFor`): the spawn and its record share this write, so two trains' spawns serialize and the second sees the
 * first's `lane-started:`. A busy-retried write passes the child it already spawned, which is returned as is: one spawn per lane.
 */
export function spawnIfReserved<C>(
	ledger: Ledger, wl: string, laneId: string, current: C | null, spawnChild: () => C,
	probeFor: (laneId: string, workloadId: string) => RunnerProbe = (l, of) => runnerProbe(of, l),
): C {
	if (current !== null) return current;
	const w = ledger.workload(wl);
	if (!stillReserved(w, laneId)) {
		throw new Fail("reserve", `${laneId} not started: held: ${wl} is held by ${w?.holder ?? "no one"}, not ${laneId}; another starter reserved it after this reservation's pre-claim lapsed; no omp spawned`, STARTER_EXIT.held!);
	}
	if (openTrains(ledger).includes(wl)) {
		const other = liveTrainLane(ledger, wl, ledger.now(), probeFor, false);
		if (other !== null) throw new Fail("reserve", `${laneId} not started: held: train lane ${other.laneId} live on ${other.workloadId}; no omp spawned`, STARTER_EXIT.held!);
	}
	return spawnChild();
}

// ---- the run lock: one owner per lane id -----------------------------------------------------------

/** The lane id's run lock, under the lanes root beside the lane's system prompt, sessions and logs: `~/.agent-system-2/lanes/<wl>/<laneId>.run.lock`. */
export function runnerLockPath(wl: string, laneId: string, h: string = homeDir()): string {
	return join(laneDir(wl, h), `${laneId}.run.lock`);
}

/**
 * `fn` in one ledger write, run only while `lock.held()` (no other runner holds the lane id), read inside that write;
 * returns whether it ran. The runner's finalizer and its pre-spawn failure write through this, so a runner whose lane id
 * another runner now holds never releases the workload and never writes its lane-exit:.
 */
export function writeAsOwner(ledger: Pick<Ledger, "write">, lock: Pick<RunnerLock, "held">, fn: () => void): boolean {
	return ledger.write(() => {
		if (!lock.held()) return false;
		fn();
		return true;
	});
}

/**
 * `start` (the omp spawn and its lane-started: record) in one ledger write, run only while `lock.owns()`: the lock file
 * exists and names this runner, read inside that write; returns `start`'s result, or null when the lock is gone or names
 * another runner (openai review r3). `takeRunnerLock` runs under the same write, so no runner takes a vacant lock between
 * this read and the record, and a runner that takes it afterwards finds the record (`liveRunnerOf`). A missing lock aborts
 * rather than being taken again here: the vacancy may be another runner's removed lock after its own spawn, and taking it
 * back without rereading the start records would spawn a second omp beside that one; the aborted runner's pre-claim lapses
 * with its lease. A busy-retried write runs `start` again, so `start` must spawn at most once.
 */
export function startAsOwner<T>(ledger: Pick<Ledger, "write">, lock: Pick<RunnerLock, "owns">, start: () => T): T | null {
	return ledger.write(() => (lock.owns() ? start() : null));
}

const oneLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");

/** The run lock for `lane.ts run`, or the refusal as a Fail: exit `held` (7, retryable) unless the lock file could not be written at all. */
function holdRunnerLock(ledger: Ledger, wl: string, laneId: string, probe: RunnerProbe & { failure: string | null }): RunnerLock {
	const path = runnerLockPath(wl, laneId);
	let self: RunnerIdentity;
	try {
		self = selfIdentity();
	} catch (err) {
		throw new Fail("run", `${laneId} not started: this runner's own start time, which its run lock ${path} records, could not be read (${oneLine(err)}); nothing was written, retryable once ps can answer`, STARTER_EXIT.held!);
	}
	let r: RunnerLock | LockRefusal;
	try {
		r = takeRunnerLock(ledger, path, self, (pid, start) => probe.omp(pid, start));
	} catch (err) {
		throw new Fail("run", `${laneId} not started: its run lock ${path} could not be taken (${oneLine(err)}); nothing was written`, STARTER_EXIT.unknown!);
	}
	if ("held" in r) {
		if (r.tookOver !== null) process.stderr.write(`runner: ${laneId} took over ${path} from runner pid ${r.tookOver.owner.pid} (${r.tookOver.state === "gone" ? "no such process" : "the pid now runs another process"})\n`);
		return r;
	}
	const pid = r.owner?.pid ?? "-";
	switch (r.state) {
		case "same":
		case "raced":
			throw new Fail("run", `${laneId} already running: runner pid ${pid} holds ${path}`, STARTER_EXIT.held!);
		case "unknown":
			throw new Fail("run", `${laneId} not started: ${path} names runner pid ${pid}, alive, with no start time to verify it by; nothing was written, retryable once it exits`, STARTER_EXIT.held!);
		case "failed":
			throw new Fail("run", `${laneId} not started: inspecting the run lock's runner pid ${pid} failed (${oneLine(probe.failure ?? "ps did not answer")}); nothing was written, retryable once ps can answer`, STARTER_EXIT.held!);
		case "unreadable":
			throw new Fail("run", `${laneId} not started: ${path} names no runner (a pid and a start time); nothing was written; remove it once no runner of ${laneId} is alive`, STARTER_EXIT.held!);
	}
}

// ---- run (the runner) -----------------------------------------------------------------------------

type Frame = Record<string, unknown>;

/**
 * `lane.ts run <wl> <laneId>`: the lane id's run lock first (`takeRunnerLock`), so at most one runner owns a lane id at a
 * time, then the recorded omp and runner pids (`liveRunnerOf`). A refusal at either step exits `held` with no ledger write,
 * no preparation, no spawn and no finalization, since the lifecycle, the claim and the omp may belong to a runner already
 * there. The owner runs the lane (`runOwned`) and frees the lock however it ends; a runner killed before that leaves the
 * lock to the next one's stale takeover. A lock that cannot be read or removed at the release is the run's failure when
 * the run went through, and a line on stderr beside the run's own error when it did not (review r2 N3).
 */
async function cmdRun(wl: string, laneId: string): Promise<number> {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w) throw new Fail("run", `no workload ${wl}`, STARTER_EXIT.unknown!);
	const probe = runnerProbe(wl, laneId);
	const lock = holdRunnerLock(ledger, wl, laneId, probe);
	/** Release the lock; why it failed (naming the lock path), or null. */
	const release = (): string | null => {
		try {
			lock.release();
			return null;
		} catch (err) {
			return `${laneId}: its run lock was not released (${oneLine(err)}); the next runner takes it over once this pid is gone`;
		}
	};
	let code: number;
	try {
		const live = liveRunnerOf(controlEntries(ledger.entries(wl)), laneId, process.pid, probe);
		if (live?.uninspected) {
			throw new Fail("run", `${laneId} not started: inspecting the recorded ${live.what} pid ${live.pid} failed (${oneLine(probe.failure ?? "ps did not answer")}); nothing was written, retryable once ps can answer`, STARTER_EXIT.held!);
		}
		if (live?.unverified) {
			throw new Fail("run", `${laneId} not started: the recorded ${live.what} pid ${live.pid} is alive and no start time was recorded for it, so it cannot be told from this lane's omp; nothing was written, retryable once it exits`, STARTER_EXIT.held!);
		}
		if (live !== null) throw new Fail("run", `${laneId} already running: ${live.what} pid ${live.pid}`, STARTER_EXIT.held!);
		code = await runOwned(ledger, w, wl, laneId, lock);
	} catch (err) {
		// One failure never hides another: the run's own error stays the one thrown, with the release's beside it in the log.
		const why = release();
		if (why !== null) process.stderr.write(`runner: ${why}\n`);
		throw err;
	}
	const why = release();
	if (why !== null) throw new Fail("run", why, STARTER_EXIT.unknown!);
	return code;
}

/**
 * The runner (§ 5 pseudocode), run by the lane id's lock owner. Lifecycle ownership starts at the first line: whatever fails after
 * the reservation — preparation, the spawn, a read, a ledger write — ends in one finalization that
 * records the end and releases the pre-claim (Codex review B3). Readiness is the lane's own claim
 * (`changed_by` = the lane id) within the pre-claim lease, never an rpc frame (B1); a turn ends at
 * the `prompt_result` for the prompt this runner sent, with its status kept (B2), and is decided
 * only once omp is settled (MIGRATION.md item 40, src/turn-end.ts): a continue prompt, a hold for
 * the lane's own hands, or the outcome, a death enqueued before EOF; a stop, from the ledger or a
 * signal, persists its acceptance before `abort`, then stdin EOF, then SIGKILL after a bounded wait
 * (B4), and leaves an outcome the runner already decided as it is. The finalization (release, lane-exit:, launch-failed:)
 * writes only while `lock` still names this runner (`writeAsOwner`); the spawn only while the lock file exists and names it (`startAsOwner`).
 */
async function runOwned(ledger: Ledger, w: WorkloadRow, wl: string, laneId: string, lock: RunnerLock): Promise<number> {
	const record = (body: string): void => {
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body });
	};
	const controlNow = () => {
		const es = ledger.entries(wl);
		const workload = ledger.workload(wl);
		return { workload, control: controlEntries(es, holdersOf(es, workload?.holder ?? null)) };
	};
	/**
	 * This lane's release markers, read with the holders decideTurn uses: the open-slice count of its `released-open:` (D4), or
	 * null, and whether it wrote `released-idle:` (PLAN wl-mvr888nftz0vcl D13, a merge train's quiet idle release).
	 */
	const releaseMarkersNow = (): { releasedOpen: number | null; releasedIdle: boolean } => {
		const es = ledger.entries(wl);
		const control = controlEntries(es, holdersOf(es, ledger.workload(wl)?.holder ?? null, ledger.holders(wl)));
		return { releasedOpen: releasedOpen(control, laneId), releasedIdle: releasedIdle(control, laneId) };
	};
	/** OMP's `--max-time`: the ceiling's remaining wall plus the margin (a train: TRAIN_RUN_MAX_TIME_MIN), or AGENT_SYSTEM_LANE_MAX_TIME when that is set and shorter; fixed at the spawn. */
	let maxTime = laneMaxTime(process.env);
	let deadlineAt = Number.MAX_SAFE_INTEGER;
	const readyMinutes = READY_MS >= 60_000 ? `${Math.round(READY_MS / 60_000)}m` : `${Math.round(READY_MS / 1000)}s`;

	let child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	let stderrCapture: StderrCapture | null = null;
	let childExited = false;
	let outcome: LaneOutcome | null = null;
	/** The accepted stop's reason for `lane-exit: … outcome stop reason <r>` (decision 6; Codex review 2, R6). */
	let stopReason: string | null = null;
	/** The death line conclude() (with its background suffix) or failModel() decided, retried first in finish() whatever the holder. */
	let decidedDeath: string | null = null;
	let ready = false;
	/** A callback's failure (the readiness step): omp is killed and the read loop's end rethrows it into finalization (Codex review 2, R2). */
	let fatal: Fail | null = null;
	/** Why readiness failed, when it was not a missing claim: the launch-failed: and lane-died: bodies name it. */
	let readinessFailure: string | null = null;
	/**
	 * The stage those two bodies name, set once beside the failure: `readiness`, `model` for a named model OMP did not confirm
	 * (R3-1) or a `get_state` that never answered, or `headroom` for an unnamed lane's move off an out lab that failed (PLAN
	 * wl-mv71x5rwdu7eo0 § 4).
	 */
	let readinessStage = "readiness";
	/** Jo's named model for this spawn (`laneModel`), why a recorded session was not resumed, and what `get_state` reported (MIGRATION.md item 85). */
	let model: string | null = null;
	let resumeSkipped: string | null = null;
	let ranModel: string | null = null;
	/**
	 * Ready also waits for the first `get_state` (every lane, PLAN wl-mv71x5rwdu7eo0 § 4): a named model must be exactly that
	 * `provider/id` (`stateModelCheck`); an unnamed lane's model, when still out after budget comparison, must first be moved (`move`).
	 */
	let modelChecked = false;
	/** The quota signal, read once before the spawn (classifier/src/headroom.ts; `AS2_HEADROOM_POLLS` names the polls in tests). */
	const room = headroom();
	// Installed strong-row order is counterfactual budget evidence, not verified spawn availability or permission to replace a pin.
	// A broken table disables only comparison; ordinary admission remains possible and moveOff reports the existing failure.
	let strongRow: string[] = [];
	let strongRowFailure: string | null = null;
	try {
		strongRow = loadTierTable(profileConfig()).strong.map(modelIdentity);
	} catch (err) {
		strongRowFailure = oneLine(err);
	}
	/** An unnamed lane's move off an out lab: `set_model` to `to` was sent; ready waits for `get_state` to report `to` (set in `moveOff`). */
	let move = null as { from: string; to: string; reason: string } | null;
	/** omp's error on the first prompt that ended `error` (D3 keeps the first), for the death line. */
	let promptError: PromptError | null = null;
	let session: string | null = null;
	let ended = false;
	let finished = false;
	/** The pre-spawn read found the run lock gone or another runner's: the run ends with no omp and no write (`startAsOwner`). */
	let lostLock = false;
	let argv: string[] = [];
	/** The prompt this runner waits on: `p1`, then `p<n>` for each continue prompt (D2), null between them. */
	let current: string | null = null;
	let prompts = 0;
	let continues = 0;
	/** Idle prompts in this idle episode (PLAN wl-mv5i3lulwwbbi8 D6): reset to 0 whenever a turn ends with omp settled. */
	let idleContinues = 0;
	/** omp's view at the last prompt_result (D1): false while a background job could still wake the session. */
	let settled = true;
	/** A prompt_result reported `sessionSettled: false`: the decision waits for `session_settled`, or for the session to go idle (D6). */
	let awaitingSettle = false;
	/** When the current settle wait began, and when omp last sent a frame that is activity (`idleActivity`): `settleIdle`'s inputs (D6). */
	let waitingSince = 0;
	let lastFrameAt = Date.now();
	/** The idle check's get_state is out: its `isSettled: false` decides with `idle: true` (D6). */
	let idleAsked = false;
	/** D3: a prompt that ended `error` / `aborted` keeps that status for the lane's end, once its hands settle. */
	let failedStatus: "error" | "aborted" | null = null;
	/** D6: held for this lane's unsettled hands (or the workload's live test runs, D8) after the continue prompts; the stop poll re-checks the ledger. */
	let holding = false;
	let heldOpenSent = false;
	/** Dead test runs this runner already asked the lane to restart (PLAN wl-mv5i3lulwwbbi8 D8): each is asked about once. */
	const promptedDead = new Set<string>();
	const awaitSettle = (): void => {
		awaitingSettle = true;
		waitingSince = Date.now();
	};
	/** The workload's live and not-yet-prompted dead test runs now (D8), each run's heartbeat read from its file under the runs root. */
	const testRunsRoot = runsRoot(process.env);
	const runsNow = (entries: readonly EntryRow[]): { live: string[]; dead: DeadTestRun[] } => {
		const records = testRuns(entries);
		const heartbeatAt = (runId: string): number | null => {
			try {
				return parseHeartbeat(readFileSync(join(runDirOf(testRunsRoot, runId), "heartbeat"), "utf8"), runId);
			} catch {
				return null;
			}
		};
		const nowMs = Date.now();
		return { live: liveTestRuns(records, heartbeatAt, nowMs), dead: deadTestRuns(records, heartbeatAt, nowMs, promptedDead) };
	};
	const timers: ReturnType<typeof setTimeout>[] = [];
	const send = (frame: Frame): void => {
		if (child && !ended) child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	/**
	 * omp's ps start time ("" when ps found it already gone), read once, at the spawn's record inside `startAsOwner`'s
	 * write: it never changes, so a busy retry and the re-record once omp names its session run no ps. ps is bounded
	 * (`runPs`); a ps that fails or stalls past the bound throws here, which rolls the spawn's write back and ends the run
	 * through the post-spawn failure path: omp is killed and reaped, then the failure is finalized as the lock's owner.
	 */
	let ompStart: string | null = null;
	const startRecord = (): string => {
		const c = child;
		if (c !== null && ompStart === null) {
			try {
				ompStart = startTime(c.pid) ?? "";
			} catch (err) {
				throw new Fail("run", `${laneId} not started: omp pid ${c.pid}'s start time, which its lane-started: records, could not be read (${oneLine(err)}); omp is killed and its start not recorded`, STARTER_EXIT.unknown!);
			}
		}
		return laneStartedBody(laneId, { pid: c?.pid ?? 0, start: ompStart ?? "", session, argv, runnerPid: process.pid, model, ranModel, resumeSkipped });
	};

	// The ceiling meter (DESIGN-workload-ceiling.md § 2 items 3, 4): the offsets live as long as the run and the first scan starts
	// every file at byte 0, so a relaunch counts the whole workload; the wall is the finished runs plus this one since its spawn.
	const offsets = new Map<string, number>();
	let tally: Spend = { usd: 0, tokens: 0, wallMin: 0 };
	let meterState: MeterState = { sent: [] };
	let sessionsDir: string | null = null;
	/** The progress test's git reads (D12), in the worktree once `prepare` gave it. */
	let pushProbe: PushProbe | null = null;
	/** This workload's lane directory (`prepare`'s `dir`, `laneDir`), set with `sessionsDir`: where a meter error's evidence file goes. */
	let laneFilesDir: string | null = null;
	let runStart: number | null = null;
	const measure = (control: readonly ControlEntry[]): Spend => {
		if (sessionsDir !== null) tally = scanSpend(sessionsDir, offsets, tally);
		return { ...tally, wallMin: wallMinutes(control, Date.now(), runStart) };
	};
	/** This run's spend baseline, measured once right after the spawn record: lane-metrics: reports the final measure minus it. */
	let baseline: Spend | null = null;
	/** The omp tree's peak RSS, sampled on the stop poll (PLAN wl-mvbcjageg7o2yo § 2.2). */
	const rss = rssMeter(psSampler, RSS_SAMPLE_INTERVAL_MS);
	/**
	 * One meter poll (`meterPoll`): the 80 % notice once per ceiling value; at 100 % the stop through the stop path
	 * (acceptance `ceiling`, outcome stop, no lane-died:), the ceiling read and the acceptance in one transaction, and in
	 * the same write, once per ceiling value, the one raise by half with its relaunch request or Jo's question (PLAN
	 * wl-mvqwn80onq9hq8 D12). `control` is the poll's snapshot, for the wall only. A failure is logged, never fatal; a stop
	 * the step called for is taken even when its writes failed. Returns whether it stopped the lane.
	 */
	const ceilingMeter = (control: readonly ControlEntry[]): boolean => {
		let stopping = false;
		let accepted = false;
		try {
			const probe: PushProbe = pushProbe ?? {
				read: (b) => ({ ...b, url: "unknown", head: "unknown", error: `the runner of ${laneId} has no worktree yet` }),
				carries: () => `the runner of ${laneId} has no worktree yet`,
			};
			const polled = meterPoll(ledger, { workloadId: wl, laneId, spend: measure(control), state: meterState, probe });
			if (polled.hit !== null) process.stderr.write(`runner: ceiling hit on ${wl}: ${JSON.stringify(polled.hit)}\n`);
			stopping = polled.stop;
			accepted = polled.accepted;
			meterState = polled.state;
		} catch (err) {
			process.stderr.write(`runner: the ceiling meter failed: ${String(err)}\n`);
		}
		if (stopping) stop("ceiling", "ceiling", accepted);
		return stopping;
	};
	// A merge train's daily budget meter (PLAN wl-mvr888nftz0vcl D4) in place of the ceiling meter: a train is permanent and
	// has no wall, no ceiling notice and no ceiling stop. Its strict scan restarts at byte 0 with each runner, every line on
	// its own PDT day. Fixed at the run's start: train membership is never taken back (D1).
	const train = trainMembers(ledger.entries(wl), ledger.instructions(wl)).length > 0;
	let trainScan: TrainScan = emptyTrainScan();
	/**
	 * One train meter poll (`trainMeterPoll`): at the day's limit the pause, its question and the stop `budget`; on a scan
	 * defect the meter error and the stop `meter-error`. It fails closed: a poll that throws (a ledger or clock failure) is
	 * recorded as a meter error when the ledger takes it, logged, and stops the lane, since no spend is allowed past a meter
	 * that cannot read. Returns whether it stopped the lane.
	 */
	const trainMeter = (): boolean => {
		if (sessionsDir === null || laneFilesDir === null) return false;
		let ref: "budget" | "meter-error" | null = null;
		let accepted = false;
		try {
			const scanned = scanTrainDays(sessionsDir, trainScan);
			trainScan = scanned.scan;
			const polled = trainMeterPoll(ledger, { workloadId: wl, laneId, laneDir: laneFilesDir, scan: scanned.scan, errors: scanned.errors, nowMs: Date.now() });
			ref = polled.ref;
			accepted = polled.accepted;
		} catch (err) {
			ref = "meter-error";
			process.stderr.write(`runner: the train budget meter failed on ${wl}: ${String(err)}; stopping ${laneId} (fail closed)\n`);
			try {
				record(trainMeterErrorBody(laneId, [{ file: "the runner's train meter", line: 0, reason: String(err) }], null));
			} catch (writeErr) {
				process.stderr.write(
					`runner: the train-meter-error: line could not be written either: ${String(writeErr)}; with no episode row naming ${laneId} this stop counts against the train's launch limit (${TRAIN_LAUNCH_LIMIT} failed launches)\n`,
				);
			}
		}
		if (ref !== null) stop(ref, ref, accepted);
		return ref !== null;
	};
	const meter = (control: readonly ControlEntry[]): boolean => (train ? trainMeter() : ceilingMeter(control));

	/**
	 * Once, every end but the readiness and failure paths' direct SIGKILL (PLAN wl-mvidsu83epvpj4 D3): stdin EOF (omp's own
	 * graceful rpc shutdown), SIGTERM after SHUTDOWN_GRACE_MS if omp has not exited, SIGKILL END_GRACE_MS after the SIGTERM.
	 */
	const end = (): void => {
		if (ended || !child) return;
		ended = true;
		const c = child;
		const alive = (): boolean => c.exitCode === null && c.signalCode === null;
		try {
			c.stdin.end();
		} catch {
			// the pipe is already closed by a dead child
		}
		timers.push(setTimeout(() => {
			if (!alive()) return;
			c.kill("SIGTERM");
			timers.push(setTimeout(() => {
				if (alive()) c.kill("SIGKILL");
			}, END_GRACE_MS));
		}, SHUTDOWN_GRACE_MS));
	};

	/** Once: the exit record, the death message when the end was not intended, the conditional release; all of it only while this runner owns the lane id's lock. */
	const finish = (code: number | null, signal: string | null): void => {
		if (finished) return;
		finished = true;
		for (const t of timers) clearTimeout(t);
		// A decided death whose enqueue in conclude() or failModel() failed reaches the ledger here, whatever the holder: a stop accepted during
		// teardown can make the end intended and the lane row release before this point. A no-op when the death is there (D5).
		if (decidedDeath !== null) {
			try {
				enqueueRunnerDeath(ledger, { workloadId: wl, laneId, body: decidedDeath });
			} catch (err) {
				process.stderr.write(`runner: the lane-died: line could not be written on retry: ${String(err)}\n`);
			}
		}
		try {
			const { workload: cur, control } = controlNow();
			const held = cur !== null && cur.status === "open" && cur.holder === laneId;
			// omp exited before the runner decided: a release with this lane's released-open: marker is still open-work (D4); a
			// merge train's released-idle: is its quiet idle release, intended (PLAN wl-mvr888nftz0vcl D13).
			const exit = outcome === null ? exitOutcome(laneId, { ready, held, ...releaseMarkersNow() }) : null;
			const final: LaneOutcome = outcome ?? exit!.outcome;
			const intended = INTENDED_OUTCOMES[final] || exitClass(control, laneId) === "intended";
			const inFlight = cur ? cur.open_slices + cur.paused_slices : 0;
			// The final spend, when an omp was spawned; a failed scan never blocks the exit record.
			let spend: Spend | null = null;
			try {
				if (runStart !== null) spend = measure(control);
			} catch (err) {
				process.stderr.write(`runner: the final spend scan failed: ${String(err)}\n`);
			}
			// This run's metrics (PLAN wl-mvbcjageg7o2yo § 2.2) in a write of their own before the finalization's, so a failure
			// here never rolls back the release, spend: or lane-exit: below.
			if (runStart !== null) {
				try {
					const metrics = laneMetrics({
						runStartMs: runStart, runEndMs: Date.now(), final: spend, baseline, model, ranModel, prompts, continues, outcome: final, peakRssMb: rss.peakMb, rssSamples: rss.samples,
					});
					writeAsOwner(ledger, lock, () => record(laneMetricsBody(laneId, metrics)));
				} catch (err) {
					process.stderr.write(`runner: the lane-metrics: entry could not be written: ${String(err)}\n`);
				}
			}
			let drained = false;
			const owned = writeAsOwner(ledger, lock, () => {
				if (exit?.death) enqueueRunnerDeath(ledger, { workloadId: wl, laneId, body: exit.death });
				if (held && !intended && !laneDeaths(ledger, wl).some((d) => d.holder === laneId)) {
					const body = final === "never-ready"
						? laneDiedLaunchBody(laneId, readinessStage, readinessFailure ?? `no claim in ${readyMinutes}`)
						: final === "deadline" ? laneDiedDeadlineBody(laneId, maxTime, inFlight) : laneDiedExitBody(laneId, final, code, signal);
					ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body });
				}
				if (final === "never-ready") record(launchFailedBody(laneId, readinessStage, readinessStage === "startup"
					? readinessFailure!
					: `${readinessFailure ?? `never ready in ${readyMinutes}`} (omp exit code ${code ?? "-"} signal ${signal ?? "-"})`));
				if (held) ledger.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: laneId });
				if (spend !== null && laneExit(control, laneId) === null) record(spendBody(laneId, spend));
				if (laneExit(control, laneId) === null) record(laneExitBody(laneId, { code, signal, outcome: final, reason: final === "stop" ? stopReason : null }));
				// The freed slot starts the queue (MIGRATION.md item 71); once, though a busy retry runs this body again.
				if (!drained) {
					drained = true;
					spawnDrain(wl, laneId);
				}
			});
			if (!owned) {
				process.stderr.write(`runner: ${lock.path} names another runner or none; no release, no lane-exit: written\n`);
				return;
			}
			// The exit is on the ledger (this write's, or the one `lane.ts stop` wrote first): index the workload's sessions.
			spawnCtxIndex(wl, laneId, "runner");
			// A ceiling stop is an alert once no lane holds the workload, which this write made true: start the alert pass now.
			if (final === "stop" && stopReason === "ceiling") {
				try {
					kickAlerts(`ceiling stop of ${laneId}`);
				} catch (err) {
					process.stderr.write(`runner: ${laneId}: ${String(err)}\n`);
				}
			}
		} catch (err) {
			process.stderr.write(`runner: finalization failed: ${String(err)}\n`);
		}
	};

	/**
	 * A stop, from the ledger or a signal: acceptance persisted first, then abort and end (decision 14). A stop after the
	 * runner decided the outcome (and enqueued its death) is accepted and recorded, and the decided outcome stands (D3).
	 * `accepted`: the acceptance is already on the ledger (the meter's ceiling stop, `meterPoll`).
	 */
	const stop = (ref: string, reason: string, accepted = false): void => {
		if (outcome === "stop" || finished) return;
		if (!accepted) {
			try {
				record(laneStopAcceptedBody(laneId, ref));
			} catch (err) {
				process.stderr.write(`runner: the stop acceptance could not be written: ${String(err)}\n`);
			}
		}
		if (outcome === null) {
			outcome = "stop";
			stopReason = reason;
			send({ id: "abort", type: "abort" });
		}
		end();
	};

	const sendPrompt = (message: string): void => {
		prompts += 1;
		current = `p${prompts}`;
		send({ id: current, type: "prompt", message });
	};

	/** The open and paused slices now, for a deadline death; a failed read counts none rather than losing the death. */
	const inFlightNow = (): number => {
		try {
			const cur = ledger.workload(wl);
			return cur ? cur.open_slices + cur.paused_slices : 0;
		} catch {
			return 0;
		}
	};

	/**
	 * The runner decides the outcome and records it before EOF (`recordDecision`): a death enqueues its lane-died:, whatever
	 * the holder, so the lane's session_shutdown finds it (D5) and a release cannot hide it (D3); an intended outcome records
	 * `lane-decided:` so the shutdown reads the end as intended. The death body is kept for finish()'s retry. Then EOF.
	 */
	const conclude = (final: LaneOutcome, death: string | null): void => {
		outcome = final;
		recordDecision(ledger, { workloadId: wl, laneId, outcome: final, death, settled });
		if (death !== null) decidedDeath = settled ? death : `${death}${BACKGROUND_SUFFIX}`;
		end();
	};

	/**
	 * PLAN wl-mvidsu83epvpj4 D2's terminal signals as the ledger stands: this lane released itself (`selfReleased`, from the
	 * holder history), and a holder's `done-because:` stands (`laneReceipt`: never on a merge train, the same rule as the
	 * turn-end input, PLAN wl-mvr888nftz0vcl D3 and wl-mw0ytmzi89d683 F3).
	 */
	const terminalNow = (): { selfReleased: boolean; receipt: boolean } => {
		const entries = ledger.entries(wl);
		const holders = holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl));
		return { selfReleased: selfReleased(ledger.holderChanges(wl), laneId), receipt: laneReceipt(entries, holders, train) };
	};

	/**
	 * The turn-end decision (src/turn-end.ts) over the ledger as it stands, and its action. `idle`: omp is unsettled and the
	 * settle wait went idle (PLAN wl-mv5i3lulwwbbi8 D6); a turn decided with omp settled ends the idle episode.
	 */
	const decideTurn = (idle = false): void => {
		if (outcome !== null || finished) return;
		try {
			if (settled) idleContinues = 0;
			const cur = ledger.workload(wl);
			const entries = ledger.entries(wl);
			const holders = holdersOf(entries, cur?.holder ?? null, ledger.holders(wl));
			const runs = runsNow(entries);
			const control = controlEntries(entries, holders);
			const input: TurnEndInput = {
				settled,
				idle,
				status: failedStatus ?? "completed",
				unsettledHands: unsettledHandsOf(entries, ledger.routings(wl), laneId),
				liveTestRuns: runs.live,
				deadTestRuns: runs.dead,
				pendingReserved: idle && waitingReserved(ledger, wl).length > 0,
				held: cur !== null && cur.status === "open" && cur.holder === laneId,
				handedOff: cur?.holder === JO_HOLDER,
				releasedOpen: releasedOpen(control, laneId),
				releasedIdle: releasedIdle(control, laneId),
				// PLAN wl-mvr888nftz0vcl D3: a merge train is permanent, so a legacy standing done-because on it is no receipt.
				receipt: laneReceipt(entries, holders, train),
				selfReleased: selfReleased(ledger.holderChanges(wl), laneId),
				slices: sliceCounts(ledger.slices(wl)),
				continues,
				idleContinues,
				limit: CONTINUE_LIMIT,
				park: () => ledger.parkLane(wl, { by: LANE_RUNNER_BY, laneId, session: session ?? "" }),
				promptError,
			};
			const t = turnEnd(input);
			if (t.parkError !== null) process.stderr.write(`runner: park failed: ${t.parkError}\n`);
			if (t.decision === "wait") awaitSettle();
			else if (t.decision === "continue") {
				// The prompt starts a turn: its prompt_result decides next, not a session_settled from before it.
				awaitingSettle = false;
				const counter = continueCounter(t);
				if (counter === "continues") continues += 1;
				else if (counter === "idle") idleContinues += 1;
				const c = t.continued;
				if (c?.kind === "dead-run") {
					promptedDead.add(c.run.runId);
					sendPrompt(deadRunPrompt(c.run));
				} else if (c?.kind === "idle") sendPrompt(idlePrompt(wl, SETTLE_IDLE, idleContinues, IDLE_LIMIT, train));
				else sendPrompt(continuePrompt(wl, input, continues, CONTINUE_LIMIT, train));
			} else if (t.decision === "hold") {
				// The stop poll releases the hold and asks omp (SETTLE_CHECK) before deciding again.
				awaitingSettle = false;
				holding = true;
				if (!heldOpenSent) {
					heldOpenSent = true;
					try {
						ledger.enqueue({
							by: LANE_RUNNER_BY, workloadId: wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT,
							body: heldOpenBody(laneId, input.unsettledHands, CONTINUE_LIMIT, input.liveTestRuns, input.pendingReserved),
						});
					} catch (err) {
						process.stderr.write(`runner: the held-open message could not be written: ${String(err)}\n`);
					}
				}
			} else conclude(t.decision, turnEndDeathBody(laneId, t, input));
		} catch (err) {
			process.stderr.write(`runner: the turn-end decision failed: ${String(err)}\n`);
			conclude("error", turnEndFailedDeathBody(laneId, String(err)));
		}
	};
	process.on("SIGTERM", () => stop("signal", "signal"));
	process.on("SIGINT", () => stop("signal", "signal"));
	process.on("SIGHUP", () => undefined);

	try {
		const p = prepare(ledger, wl, false);
		sessionsDir = p.sessionDir;
		pushProbe = gitPushProbe(p.worktree);
		laneFilesDir = p.dir;
		// PLAN wl-mvidsu83epvpj4 D4: end the omps of lanes that released themselves and never exited, before this spawn and
		// outside any ledger write; the starter never waits on it. A stop (ledger request or signal) ends it and the run, no omp.
		await endStaleBeforeSpawn(ledger, wl, laneId, "runner", () => {
			try {
				const req = pendingStop(controlNow().control, laneId);
				if (req) stop(req.entryId, req.reason);
			} catch (err) {
				process.stderr.write(`runner: the cleanup's stop check failed: ${String(err)}\n`);
			}
			return outcome !== null;
		});
		if (outcome !== null) throw new Fail("stop", `${laneId} stopped before its spawn; no omp spawned`, 0);
		{
			// A train has no wall (PLAN wl-mvr888nftz0vcl D4): its ceiling rows are never read, and `--max-time` is the 24 h hang
			// backstop (`trainMaxTime`, a shorter AGENT_SYSTEM_LANE_MAX_TIME still wins). Any other workload: the ceiling's wall.
			let remainingWallMin: number | null = null;
			if (train) maxTime = trainMaxTime(process.env);
			else {
				const { workload: cur, control } = controlNow();
				const ceiling = effectiveCeiling(control, ledger.instructions(wl), cur?.stakes ?? w.stakes);
				const remaining = Math.max(0, ceiling.wallMin - wallMinutes(control, Date.now(), null));
				const envMs = process.env[LANE_MAX_TIME_ENV]?.trim() ? maxTimeMs(maxTime) : null;
				const shorter = envMs !== null && envMs < (maxTimeMs(ceilingMaxTime(remaining)) ?? Number.MAX_SAFE_INTEGER);
				remainingWallMin = shorter ? null : remaining;
			}
			// Jo's named model and the session, read fresh at this spawn; a session recorded on another model is not resumed (item 85).
			const start = resumeOf(ledger, w, laneId);
			model = start.model;
			resumeSkipped = start.skipped;
			if (resumeSkipped !== null) process.stderr.write(`runner: ${laneId} starts a fresh session on ${model ?? "the profile default"}: ${resumeSkipped}\n`);
			if (room.note !== null) process.stderr.write(`runner: ${laneId} quota guard open: ${room.note}\n`);
			// Budget comparison can retain Jo's named source, never substitute it. An out decision still fails before any omp,
			// and the catch below finalizes it as the runner (`failAfterReserve` by lane-runner).
			if (model !== null) {
				if (strongRowFailure !== null) process.stderr.write(`runner: ${laneId} quota guard comparison unavailable: the strong row could not be read: ${strongRowFailure}\n`);
				const decision = room.decisionFor(model, strongRow);
				if (decision.retained !== null) process.stderr.write(`runner: ${laneId} ${decision.retained}\n`);
				if (decision.out !== null) throw new Fail(HEADROOM_STAGE, `named ${model}, ${decision.out}`, STARTER_EXIT["not-launchable"]!);
			}
			argv = laneArgv({
				worktree: p.worktree, sessionDir: p.sessionDir, systemPromptPath: p.systemPromptPath, maxTime, resume: start.resume, model,
				remainingWallMin,
			});
			if (start.recovered !== null) process.stderr.write(`runner: ${laneId} ${start.recovered}; argv ${JSON.stringify(argv)}\n`);
			maxTime = argv[argv.indexOf("--max-time") + 1]!;
		}
		const ordinal = (/-(\d+)$/.exec(laneId) ?? [])[1] ?? "0";
		const frames = join(p.dir, `lane-${ordinal}.jsonl`);
		const { env, notes } = laneSpawnEnv(process.env, profileConfig(), { workloadId: wl, laneId });
		// The as2 entry paths the lane's omp loads, read from the profile config it runs on (OMP_PROFILE), once, beside the spawn:
		// a suspension notice later is confirmed against it (`suspensionOf`), and the stop poll compares a changed config with it
		// (`polledSuspensionOf`). The stamp is taken before the read: a change between them makes the first poll re-read (one
		// extra read), never miss it; a failed stamp leaves null, so the first poll re-reads too.
		const spawnStamp = configStamp(profileConfig());
		const loadedAs2 = readAs2ExtensionPaths(profileConfig());
		if ("error" in loadedAs2) process.stderr.write(`runner: ${laneId} profile extensions unreadable at spawn: ${loadedAs2.error}; a suspension notice will end the lane unconfirmed\n`);
		/** The config stamp the stop poll last read (`configStamp`), and its last logged check error (written once until it changes or clears). */
		let configSeen: string | null = "stamp" in spawnStamp ? spawnStamp.stamp : null;
		let configCheckError: string | null = null;
		env.OMP_PROFILE = PROFILE;
		for (const n of notes) process.stderr.write(`runner: ${laneId} tracing: ${n}\n`);
		/**
		 * The spawn and its lane-started: record are one ledger write, after the run lock is read as this runner's inside it
		 * (`startAsOwner`; openai review r3): a lock removed before this point, with the lane dir or alone, ends the run here
		 * with exit 7 and no omp, and this runner records and releases nothing, since a runner that took the vacant lock may
		 * own the lane id now. Then, before the spawn, the workload must still be held by this lane id (`spawnIfReserved`, D2b):
		 * another starter's reservation after this one's pre-claim lapsed ends the run with exit 7, no omp, and launch-failed:.
		 * A busy-retried write runs the body again: the spawn happens once, the record is rewritten.
		 * The record's one ps call (omp's start time) is bounded (`runPs`, review r4), so the write holds the ledger's lock for
		 * at most PS_TIMEOUT_MS past the spawn; a ps past it rolls the write back and the run fails with omp killed (`startRecord`).
		 * Known limitation (moonshot review r3 minor 3): a SIGKILL of this runner after the spawn and before the write commits
		 * rolls the record back and leaves a live omp with no lane-started:, so the next runner cannot see it; its stdin pipe
		 * closes with this runner, which is the only end it gets.
		 */
		const omp = startAsOwner(ledger, lock, () => {
			// A stop that landed after the cleanup's last check spawns nothing either (D4); the catch ends the run as stopped.
			if (child === null && outcome !== null) throw new Fail("stop", `${laneId} stopped before its spawn; no omp spawned`, 0);
			child = spawnIfReserved(ledger, wl, laneId, child, () => {
				runStart = Date.now();
				const omp = spawn(["omp", ...argv], { cwd: p.worktree, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
				stderrCapture = captureStderr(omp.stderr);
				return omp;
			});
			record(startRecord());
			return child;
		});
		if (omp === null) {
			let now: string;
			try {
				const o = lockOwner(lock.path);
				now = o === null ? "it is gone" : o === "unreadable" ? "it names no runner" : `it names runner pid ${o.pid}`;
			} catch (err) {
				now = `it could not be read: ${oneLine(err)}`;
			}
			lostLock = true;
			throw new Fail("run", `${laneId} not started: lost the run lock ${lock.path} before the spawn (${now}); no omp spawned, nothing recorded or released`, STARTER_EXIT.held!);
		}
		try {
			baseline = measure(controlNow().control);
		} catch (err) {
			process.stderr.write(`runner: the baseline spend scan failed: ${String(err)}\n`);
		}
		// Preparation can block on git and profile reads. The child's readiness window and
		// max-time start at its actual spawn, just like the ceiling meter's live wall time.
		const spawnedAt = runStart!;
		deadlineAt = spawnedAt + (maxTimeMs(maxTime) ?? Number.MAX_SAFE_INTEGER);
		const exited = omp.exited.then(async (code) => {
			childExited = true;
			await stderrCapture?.settle();
			if (!ready && outcome === null && fatal === null) {
				readinessStage = "startup";
				readinessFailure = `omp exit code ${code} signal ${omp.signalCode ?? "-"} before ready; ${stderrCapture?.context() ?? "no stderr"}`;
				outcome = "never-ready";
			}
			return code;
		});
		send({ id: STATE_ID, type: "get_state" });

		// Readiness (B1): the lane's own claim, stamped with its id, within the pre-claim lease; no renewal before it. Every lane also
		// waits for OMP's first get_state (PLAN wl-mv71x5rwdu7eo0 § 4): a named model must be exactly that provider/id (item 85), and an
		// unnamed lane still out after budget comparison is moved first (`moveOff`). Ready means the claim, the model, the lane-ready:
		// receipt and the prompt all landed; a failure in any of them is fatal (review 2, R2).
		const readyPoll = setInterval(() => {
			if (ready || finished || childExited || outcome !== null || fatal !== null) return;
			try {
				const cur = ledger.workload(wl);
				const claimed = cur !== null && cur.holder === laneId && cur.changed_by === laneId;
				if (claimed && modelChecked) {
					clearInterval(readyPoll);
					const { workload: latest, control } = controlNow();
					const stakes = latest?.stakes ?? w.stakes;
					// A relaunch already at or past the ceiling (a train: at or past the day's limit) stops here, before lane-ready: and
					// before the first prompt spends a model turn past it.
					if (meter(control)) {
						ready = true;
						return;
					}
					// A train's line is its daily budget (PLAN wl-mvr888nftz0vcl D4), from the scan the meter just ran; never a ceiling.
					const nowMs = Date.now();
					const ceilingLine = train
						? trainBudgetPromptLine(trainDayLimit(control, pdtDay(nowMs)), trainScan.days.get(pdtDay(nowMs)) ?? 0, new Date(nextPdtMidnight(nowMs)).toISOString())
						: ceilingPromptLine(effectiveCeiling(control, ledger.instructions(wl), stakes), measure(control));
					// The prompt's row cut (PLAN wl-mvpsrr4tr0p1xc D2): taken before `promptFor` reads the rows, so every instruction older
					// than lane-ready:'s time was in this prompt, and a train's resolution counts as delivered only then (`consumedByReady`).
					const readAt = ledger.now();
					const prompt = promptFor(ledger, w, laneId, p, ceilingLine);
					// Every train lane start's live receipt of the permanent rule (D10, R22), beside its lane-ready:.
					if (train) record(trainRuleBody(laneId, maxTime));
					// lane-ready: immediately before the first prompt (item 85): a runner lane that ended without one never got a prompt (builderLabs).
					record(laneReadyBody(laneId, readAt));
					sendPrompt(prompt);
					ready = true;
				} else if (Date.now() - spawnedAt >= READY_MS) {
					if (claimed) {
						if (move !== null) failModel(`moving ${move.from} -> ${move.to} (${move.reason}): no get_state confirmed ${move.to} within ${readyMinutes}`, HEADROOM_STAGE);
						else failModel(model !== null ? `named ${model}, no get_state model within ${readyMinutes}` : `no get_state answer within ${readyMinutes}`);
						return;
					}
					clearInterval(readyPoll);
					process.stderr.write(`runner: ${laneId} never claimed ${wl} within ${readyMinutes}; killing omp\n`);
					outcome = "never-ready";
					omp.kill("SIGKILL");
				}
			} catch (err) {
				clearInterval(readyPoll);
				fatal = new Fail("readiness", String(err), STARTER_EXIT.unknown!);
				process.stderr.write(`runner: readiness failed: ${String(err)}; killing omp\n`);
				omp.kill("SIGKILL");
			}
		}, READY_POLL_MS);
		timers.push(readyPoll);
		/**
		 * A named model OMP did not confirm (item 85), a get_state that never answered, or an unnamed lane's failed move off an
		 * out lab (stage `headroom`, PLAN wl-mv71x5rwdu7eo0 § 4): the never-ready path with that stage, so one launch-failed: and one
		 * lane-died: name it (R3-1). The death is decided here and enqueued before the kill, whatever the holder: a stop accepted
		 * between the kill and finish() makes the end read as intended, and finish()'s held branch would then write none. The
		 * body is the one finish() writes for never-ready; finish() retries it, and enqueueRunnerDeath keeps it to one per lane.
		 */
		const failModel = (reason: string, stage = "model"): void => {
			if (ready || finished || outcome !== null || fatal !== null) return;
			clearInterval(readyPoll);
			readinessStage = stage;
			readinessFailure = reason;
			outcome = "never-ready";
			decidedDeath = laneDiedLaunchBody(laneId, readinessStage, readinessFailure);
			try {
				enqueueRunnerDeath(ledger, { workloadId: wl, laneId, body: decidedDeath });
			} catch (err) {
				process.stderr.write(`runner: the lane-died: line could not be written: ${String(err)}\n`);
			}
			process.stderr.write(`runner: ${laneId} ${stage} check failed: ${reason}; killing omp\n`);
			omp.kill("SIGKILL");
		};
		/**
		 * An unnamed lane whose first get_state model `from` remains out (`reason`) after budget comparison moves, before its
		 * first prompt, to the first base-in-quota entry of the installed strong row (`:level` dropped), in row order.
		 * Destination decisions never use comparators: retention protects the source, not another out destination.
		 * `set_model`, then a get_state must report it. An unreadable tier table or every entry out is never-ready at `headroom`.
		 */
		const moveOff = (from: string, reason: string): void => {
			if (strongRowFailure !== null) {
				failModel(`${from} is out (${reason}); the strong row could not be read: ${strongRowFailure}`, HEADROOM_STAGE);
				return;
			}
			const to = strongRow.find((s) => room.decisionFor(s).out === null);
			if (to === undefined) {
				failModel(`${from} is out (${reason}); every strong-row entry is out: ${strongRow.map((s) => `${s} (${room.decisionFor(s).out})`).join("; ")}`, HEADROOM_STAGE);
				return;
			}
			move = { from, to, reason };
			process.stderr.write(`runner: ${laneId} moving ${from} -> ${to}: ${reason}\n`);
			const slash = to.indexOf("/");
			send({ id: SET_MODEL_ID, type: "set_model", provider: to.slice(0, slash), modelId: to.slice(slash + 1) });
		};
		let stateSeen = false;

		const stopPoll = setInterval(() => {
			if (finished) return;
			if (omp.exitCode === null && omp.signalCode === null) void rss.tick(omp.pid, Date.now());
			// The as2 extensions suspended with no notice (review round 2 of PR #428): OMP's config listener suspends a loaded path
			// no longer enabled on every config change but names a newly enabled path once per process and a removal never, so
			// A → A+B (a notice; the lane goes on) → B, or a removal alone, suspends the lane's tools and gates in silence. Each
			// poll stats the profile config and re-reads it only when it changed since the last read (the spawn read's first): a
			// loaded as2 path no longer enabled ends the lane as the notice path does, within one poll. A failed stat, read or
			// parse here is no evidence of a suspension (unlike the notice, nothing says OMP's set changed), so it is logged once
			// per distinct error and the lane goes on; a notice still re-reads and ends it unconfirmed. An empty or failed spawn
			// read skips the check: nothing to compare (the notice path ends those unconfirmed). Its own try: a ledger failure in
			// the poll below never hides it, nor it them.
			if (outcome === null && "paths" in loadedAs2 && loadedAs2.paths.length > 0) {
				try {
					const stamp = configStamp(profileConfig());
					let s: PolledSuspension | null = null;
					if ("error" in stamp) {
						configSeen = null;
						s = { kind: "unreadable", error: stamp.error };
					} else if (stamp.stamp !== configSeen) {
						configSeen = stamp.stamp;
						s = polledSuspensionOf(loadedAs2.paths, readAs2ExtensionPaths(profileConfig()));
					}
					if (s?.kind === "unreadable") {
						if (s.error !== configCheckError) process.stderr.write(`runner: ${laneId} profile config check failed: ${s.error}; no evidence of a suspension, the lane goes on (an extensions notice still re-reads it)\n`);
						configCheckError = s.error;
					} else if (s !== null) {
						configCheckError = null;
						if (s.kind === "confirmed") {
							process.stderr.write(`runner: ${laneId} extensions suspended with no notice: ${s.suspended.join(", ")} no longer enabled in ${profileConfig()}; ending the lane\n`);
							send({ id: "abort", type: "abort" });
							conclude("error", extensionsSuspendedDeathBody(laneId, s.suspended, s.enabled));
						}
					}
				} catch (err) {
					process.stderr.write(`runner: ${laneId} stop poll's profile config check failed: ${String(err)}\n`);
				}
			}
			try {
				const { workload: cur, control } = controlNow();
				const req = pendingStop(control, laneId);
				if (req) stop(req.entryId, req.reason);
				// The runner's own deadline (D1): an idle session with a live background job is past omp's --max-time reach.
				if (ready && outcome === null && Date.now() >= deadlineAt) {
					send({ id: "abort", type: "abort" });
					conclude("deadline", laneDiedDeadlineBody(laneId, maxTime, inFlightNow()));
				}
				if (ready && outcome === null) meter(control);
				// PLAN wl-mvidsu83epvpj4 D2 (b): a self-release while the runner waits or holds, or a receipt while it waits, decides
				// now: a woken turn that wrote it has no prompt_result of the runner's own. A receipt while holding is not re-decided.
				if (ready && outcome === null && current === null && (awaitingSettle || holding)) {
					const t = terminalNow();
					if (t.selfReleased || (t.receipt && awaitingSettle)) {
						holding = false;
						decideTurn();
					}
				}
				// D6: held for the lane's hands, and (PLAN wl-mv5i3lulwwbbi8 D8) the workload's live test runs; once none is left,
				// omp's own word on settled (get_state) comes first.
				if (holding && outcome === null) {
					const entries = ledger.entries(wl);
					if (unsettledHandsOf(entries, ledger.routings(wl), laneId).length === 0 && runsNow(entries).live.length === 0) {
						holding = false;
						send({ id: SETTLE_CHECK, type: "get_state" });
					}
				}
				// PLAN wl-mv5i3lulwwbbi8 D6: a settle wait with no omp activity for SETTLE_IDLE asks omp once; isSettled false decides idle.
				if (ready && outcome === null && awaitingSettle && !holding && !idleAsked && settleIdle(waitingSince, lastFrameAt, Date.now(), SETTLE_IDLE)) {
					idleAsked = true;
					send({ id: IDLE_CHECK, type: "get_state" });
				}
				// Renew the lease while ready and alive (the lane row renews too; this covers a lane whose timer stalled). renewLease's
				// own WHERE holder = laneId is the guard, so a release committed since this tick's read is never undone (D2b).
				if (ready && outcome === null) {
					const n = Number(process.env[LEASE_MS_ENV]);
					ledger.renewLease(wl, { by: LANE_RUNNER_BY, holder: laneId, leaseMs: Number.isFinite(n) && n > 0 ? n : LEASE_MS });
				}
			} catch (err) {
				process.stderr.write(`runner: stop poll failed: ${String(err)}\n`);
			}
		}, STOP_POLL);
		timers.push(stopPoll);

		const reader = omp.stdout.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				const raw = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!raw.trim()) continue;
				appendFileSync(frames, `${raw}\n`);
				let o: Frame;
				try {
					o = JSON.parse(raw) as Frame;
				} catch {
					lastFrameAt = Date.now();
					continue;
				}
				// D6: any frame but the replies to the runner's own get_state is activity, so the settle wait is not idle.
				if (idleActivity(o)) lastFrameAt = Date.now();
				const data = "data" in o && typeof o.data === "object" && o.data !== null ? (o.data as Frame) : null;
				const sessionFile = data && typeof data.sessionFile === "string" ? data.sessionFile : typeof o.sessionFile === "string" ? o.sessionFile : null;
				let rerecord = false;
				// OMP's first get_state answer names the model it started (item 85): recorded as ranModel; a named model must equal it, and
				// an unnamed lane's source receives the same budget comparison: in quota or retained, or no model reported, is ready.
				if (o.type === "response" && o.id === STATE_ID && !stateSeen) {
					stateSeen = true;
					ranModel = stateModelOf(o);
					rerecord = ranModel !== null;
					if (model !== null) {
						const check = stateModelCheck(model, o);
						if (check.ok) modelChecked = true;
						else failModel(check.reason);
					} else {
						if (ranModel === null) modelChecked = true;
						else {
							const decision = room.decisionFor(ranModel, strongRow);
							if (decision.retained !== null) process.stderr.write(`runner: ${laneId} ${decision.retained}\n`);
							if (decision.out === null) modelChecked = true;
							else moveOff(ranModel, decision.out);
						}
					}
				}
				// The move's set_model answer: on success, ask OMP which model it now runs; a refusal fails the launch at `headroom`.
				if (o.type === "response" && o.id === SET_MODEL_ID && move !== null && outcome === null) {
					if (o.success === false) failModel(`set_model ${move.to} failed: ${typeof o.error === "string" ? oneLine(o.error) : "no error given"}`, HEADROOM_STAGE);
					else send({ id: MOVED_STATE_ID, type: "get_state" });
				}
				// The move holds only once get_state reports the target: then the lane-headroom: record and its on-fire quota-move:
				// message are written in one transaction (D4; a failed write takes the runner's failure path, as the bare record did),
				// the alert pass is kicked, ranModel names the target, and ready may follow. The move is recorded by then, so a kick
				// that cannot start is logged, not fatal: the train tick's next alert pass raises it.
				if (o.type === "response" && o.id === MOVED_STATE_ID && move !== null && !modelChecked && outcome === null) {
					const now = stateModelOf(o);
					if (now === move.to) {
						const eventId = recordQuotaMove(ledger, {
							workloadId: wl, laneId, kind: "lane", from: move.from, to: move.to, reason: move.reason, by: LANE_RUNNER_BY,
							eventBody: laneHeadroomBody(laneId, move.from, move.to, move.reason),
						});
						try {
							kickAlerts(`quota move ${eventId}`);
						} catch (err) {
							process.stderr.write(`runner: ${laneId}: ${String(err)}\n`);
						}
						ranModel = now;
						rerecord = true;
						modelChecked = true;
					} else failModel(`set_model ${move.to} sent, get_state reported ${now ?? "no provider/id model"}`, HEADROOM_STAGE);
				}
				if (session === null && sessionFile !== null) {
					session = sessionFile;
					rerecord = true;
				}
				if (rerecord) record(startRecord());
				// The as2 extensions suspended by a profile config change (decision en-mw01fr5uts72g0): the lane's tools and the P-11
				// gates are gone, so the lane ends now as `error` with that death, before any hold, continue, settle or idle check
				// (each of them needs outcome null), and before ready (the ready poll stops on an outcome). The notice is only the
				// trigger: the profile config, read again now, confirms a loaded as2 path is no longer enabled. Every loaded one
				// still enabled (an added copy, an unrelated path ending in an as2 entry) leaves the lane going; a config that
				// cannot show which ends it unconfirmed, since the gates may be gone. A suspension OMP gives no notice for (a removal,
				// or a path it announced before) is the stop poll's to find.
				const enabled = outcome === null ? extensionsSuspendedOf(o) : null;
				if (enabled !== null) {
					const s = suspensionOf(loadedAs2, readAs2ExtensionPaths(profileConfig()));
					if (s.kind === "still-enabled") process.stderr.write(`runner: ${laneId} extensions notice enables ${enabled.join(", ")}; the loaded as2 extensions are still enabled; the lane goes on\n`);
					else {
						const death = s.kind === "confirmed" ? extensionsSuspendedDeathBody(laneId, s.suspended, enabled) : extensionsUnconfirmedDeathBody(laneId, enabled, s.reason);
						process.stderr.write(`runner: ${laneId} ${s.kind === "confirmed" ? `extensions suspended: ${s.suspended.join(", ")} no longer enabled` : `extensions likely suspended, not confirmed: ${s.reason}`}; OMP now enables ${enabled.join(", ")}; ending the lane\n`);
						send({ id: "abort", type: "abort" });
						conclude("error", death);
					}
				}
				// A turn ends (B2) at the prompt_result for the prompt this runner sent, its status kept; agent_end is not an end.
				if (o.type === "prompt_result" && o.id === current && outcome === null) {
					current = null;
					const status = typeof o.status === "string" ? o.status : "error";
					// D1: an older omp with no sessionSettled field reads as settled.
					settled = o.sessionSettled !== false;
					if (status === "aborted" && Date.now() >= deadlineAt) conclude("deadline", laneDiedDeadlineBody(laneId, maxTime, inFlightNow()));
					else {
						if (status !== "completed") failedStatus ??= status === "aborted" ? "aborted" : "error";
						if (status === "error") promptError ??= promptErrorOf(o);
						// PLAN wl-mvidsu83epvpj4 D2 (a): unsettled, the decision still comes now when the lane released itself or a receipt stands.
						if (settled) decideTurn();
						else {
							let terminal = false;
							try {
								const t = terminalNow();
								terminal = t.selfReleased || t.receipt;
							} catch (err) {
								process.stderr.write(`runner: the release/receipt read failed: ${String(err)}\n`);
							}
							if (terminal) decideTurn();
							else awaitSettle();
						}
					}
				}
				if (o.type === "session_settled" && awaitingSettle && outcome === null) {
					awaitingSettle = false;
					idleAsked = false;
					settled = true;
					decideTurn();
				}
				// The hold's settle check: decide now, or wait for the woken turn's session_settled.
				if (o.type === "response" && o.id === SETTLE_CHECK && outcome === null) {
					if (data?.isSettled === false) {
						settled = false;
						awaitSettle();
					} else {
						settled = true;
						decideTurn();
					}
				}
				// PLAN wl-mv5i3lulwwbbi8 D6, the idle check: still unsettled after the idle wait decides with idle: true (the lane is
				// asked, never killed outright); settled decides as usual. A wait that already ended (session_settled first) ignores it.
				if (o.type === "response" && o.id === IDLE_CHECK && outcome === null && idleAsked) {
					idleAsked = false;
					if (awaitingSettle) {
						if (data?.isSettled === false) {
							settled = false;
							decideTurn(true);
						} else {
							awaitingSettle = false;
							settled = true;
							decideTurn();
						}
					}
				}
			}
		}
		const code = await exited;
		if (fatal !== null) throw fatal;
		finish(code, omp.signalCode ?? null);
	} catch (err) {
		const f = err instanceof Fail ? err : new Fail("run", String(err), STARTER_EXIT.unknown!);
		process.stderr.write(`runner: ${f.stage}: ${f.message}\n`);
		for (const t of timers) clearTimeout(t);
		if (child === null && outcome === "stop") {
			// PLAN wl-mvidsu83epvpj4 D4: a stop accepted during the pre-spawn cleanup ends the run with no omp, finalized as the
			// lock's owner like any stop: the workload released as the stopped lane, `lane-exit: … outcome stop reason <r>`.
			finish(null, null);
			return 0;
		}
		if (child === null) {
			// Before the spawn: a launch failure (decision 9), in the starter's shape; finalization has nothing to reap. A lost
			// run lock writes nothing: the lane id may be another runner's now. The runner's own quota refusal of Jo's named model
			// (PLAN wl-mv71x5rwdu7eo0 § 4) is written as the runner.
			finished = true;
			if (!lostLock) failAfterReserve(ledger, wl, laneId, f, lock, f.stage === HEADROOM_STAGE ? LANE_RUNNER_BY : LANE_STARTER_BY);
			return f.code;
		}
		// Decide before killing: the child-exit handler must not turn this runner failure into startup SIGKILL.
		if (!ready && outcome === null) {
			readinessStage = f.stage;
			readinessFailure = `${f.stage} failed: ${f.message}`;
		}
		outcome ??= ready ? "died" : "never-ready";
		child.kill("SIGKILL");
		const code = await child.exited;
		await stderrCapture?.settle();
		finish(code, child.signalCode ?? null);
		return f.code;
	}
	return 0;
}

// ---- interactive ----------------------------------------------------------------------------------

/** SIGTERM, then SIGKILL after END_GRACE_MS, and the exit awaited: a child this process spawned is never left running. */
async function terminate(child: Pick<Subprocess, "kill" | "exited" | "exitCode" | "signalCode">): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(END_GRACE_MS).then(() => false)]);
	if (!exited) {
		child.kill("SIGKILL");
		await child.exited;
	}
}

async function cmdInteractive(wl: string): Promise<number> {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w) throw new Fail("interactive", `no workload ${wl}`, STARTER_EXIT.unknown!);
	const laneId = reserveOrExit(ledger, wl, "jo", true);
	// Held across the catch: a failure after the spawn terminates and reaps omp before the release (Codex review 2, R3).
	let omp: Subprocess<"inherit", "inherit", "inherit"> | null = null;
	try {
		const p = prepare(ledger, wl, true);
		// Jo's named model, and a session recorded on another model is not resumed, as in the runner (item 85).
		const { model, resume, skipped, recovered } = resumeOf(ledger, w, laneId);
		ledger.write(() => {
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: worktreeBody(p.worktree) });
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: branchBody(p.branch, p.base) });
		});
		// PLAN-2 D1/D2: written before the spawn and passed as OMP's `@file` initial message, on a fresh session and a resume alike.
		const firstPromptPath = join(p.dir, "prompt.md");
		writeFileSync(firstPromptPath, byHandPromptFor(ledger, w, laneId, p));
		const argv = interactiveArgv({ worktree: p.worktree, sessionDir: p.sessionDir, systemPromptPath: p.systemPromptPath, model, resume, firstPromptPath });
		const { env, notes } = laneSpawnEnv(process.env, profileConfig(), { workloadId: wl, laneId });
		env.OMP_PROFILE = PROFILE;
		// After `laneEnv`, which drops any inherited value: only this by-hand launch carries it (PLAN-2 D4).
		env[BY_HAND_ENV] = "1";
		for (const n of notes) process.stderr.write(`lane: tracing: ${n}\n`);
		// PLAN wl-mvidsu83epvpj4 D4: the self-released lanes' stale omps end before this spawn (Jo's terminal has no timeout).
		await endStaleBeforeSpawn(ledger, wl, laneId, "lane");
		line(`lane ${laneId} on ${wl} in ${p.worktree} (branch ${p.branch}); first prompt supplied from ${firstPromptPath}`);
		if (skipped !== null) line(`a fresh session on ${model ?? "the profile default"}: ${skipped}`);
		if (recovered !== null) line(recovered);
		// The TUI's ^C belongs to omp (a foreground process group signal reaches both); this wrapper waits for the exit.
		process.on("SIGINT", () => undefined);
		// The session files already here belong to earlier lanes: the one this OMP creates is the one not in this snapshot.
		const preexisting = topLevelSessions(p.sessionDir);
		// The lane's identity is OMP's process, not this wrapper's (Codex review B5): `lane.ts stop` compares this pid and start time.
		// The start time is read once, at the first record while omp runs, and reused, as `ompStart` in `cmdRun`: the session
		// re-record after omp exits runs no ps, so a ps failing there cannot end in the catch, which would record launch-failed:
		// for a lane that ran and drop its lane-exit: (openai review r5).
		let ompStart: string | null = null;
		const record = (pid: number, session: string | null): void => {
			ompStart ??= startTime(pid) ?? "";
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(laneId, { pid, start: ompStart, session, argv, runnerPid: process.pid, model, resumeSkipped: skipped }) });
		};
		// The spawn and its first lane-started: in one write, only while the workload is still held by this lane id
		// (`spawnIfReserved`, D2b); a busy-retried write spawns once, as the runner's does.
		const child = ledger.write(() => {
			const c = spawnIfReserved(ledger, wl, laneId, omp, () => spawn(["omp", ...argv], { cwd: p.worktree, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }));
			omp = c;
			record(c.pid, resume);
			return c;
		});
		const code = await child.exited;
		// The session OMP wrote: a new top-level file, never one that existed before the spawn; a resumed lane appends to its
		// resume path, which it already recorded, so it finds no new file.
		const session = newLaneSession(p.sessionDir, preexisting);
		if (session !== null && session !== resume) record(child.pid, session);
		// Once per lane, in one transaction with the release: `lane.ts stop` may have written the exit already; when it accepted
		// the stop but has not written it yet (it waits to see omp gone), this wrapper writes the same stop exit with the real code.
		ledger.write(() => {
			const cur = ledger.workload(wl);
			if (cur && cur.status === "open" && cur.holder === laneId) ledger.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: laneId });
			const es = ledger.entries(wl);
			const control = controlEntries(es, holdersOf(es, cur?.holder ?? null));
			if (laneExit(control, laneId) !== null) return;
			const byHand = control.some((c) => c.prefix === "lane-stop" && c.laneId === laneId && /^accepted\b/.test(c.rest));
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code, signal: child.signalCode ?? null, outcome: byHand ? "stop" : "interactive", reason: byHand ? "by-hand" : null }) });
		});
		// Spawned even when `lane.ts stop` wrote the exit: only this wrapper knew the session once OMP exited.
		spawnCtxIndex(wl, laneId, "starter");
		return code;
	} catch (err) {
		const f = err instanceof Fail ? err : new Fail("interactive", String(err), STARTER_EXIT.unknown!);
		if (omp !== null) {
			try {
				await terminate(omp);
			} catch (cleanup) {
				// The original failure is the one reported; the cleanup's own failure goes to stderr beside it.
				process.stderr.write(`lane: omp pid ${omp.pid} could not be terminated: ${String(cleanup)}\n`);
			}
		}
		failAfterReserve(ledger, wl, laneId, f);
		throw f;
	}
}

// ---- stop, cleanup, log ------------------------------------------------------------------------------

async function cmdStop(wl: string): Promise<number> {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w) throw new Fail("stop", `no workload ${wl}`, 1);
	const es = ledger.entries(wl);
	const control = controlEntries(es, holdersOf(es, w.holder));
	const started = laneStarted(control);
	const laneId = w.holder?.startsWith("lane-") ? w.holder : started?.laneId ?? null;
	if (!laneId) {
		line(`${wl} has no lane to stop (holder ${w.holder ?? "nobody"})`);
		return 0;
	}
	const req = ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(laneId, "as2-lane-stop", "jo") });
	line(`stop requested of ${laneId} (entry ${req}); waiting for lane-exit:`);
	const runnerAlive = started !== null && started.runnerPid > 0 && startTime(started.runnerPid) !== null;
	const deadline = Date.now() + (runnerAlive ? 60_000 : 0);
	while (Date.now() < deadline) {
		const e2 = ledger.entries(wl);
		if (laneExit(controlEntries(e2, holdersOf(e2, ledger.workload(wl)?.holder ?? null)), laneId)) {
			line(`${laneId} exited`);
			return 0;
		}
		await Bun.sleep(1000);
	}
	// No runner (or it did not answer): accept the request here. The release and the exit wait until the recorded omp is
	// verified gone — SIGTERM, then SIGKILL after the grace, each only while the pid's start time still matches
	// lane-started: — and a process that cannot be shown gone is a failed stop, never a released lane (Codex review 2, R1).
	ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopAcceptedBody(laneId, req) });
	if (started && started.laneId === laneId && started.pid > 0) {
		const pid = started.pid;
		const ended = await endRecorded(pid, started.start);
		if (ended === "unverifiable" || ended === "survived") {
			const why = ended === "survived" ? "survived SIGTERM and SIGKILL" : "is alive and lane-started: recorded no start time to verify it against";
			process.stderr.write(`lane stop: omp pid ${pid} ${why}; ${wl} stays held by ${laneId} and no lane-exit: is written\n`);
			return 1;
		}
		line(ended === "gone" ? `omp pid ${pid} is gone` : ended === "other" ? `omp pid ${pid} has a different start time; not signalled` : `omp pid ${pid} ended after ${ended} (start time matched lane-started:)`);
	}
	// Once per lane, against the interactive wrapper that may have written the same exit when its omp ended.
	const r = ledger.write(() => {
		const released = ledger.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: laneId });
		const e3 = ledger.entries(wl);
		const wrote = laneExit(controlEntries(e3, holdersOf(e3, ledger.workload(wl)?.holder ?? null)), laneId) === null;
		if (wrote) ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: null, signal: null, outcome: "stop", reason: "by-hand" }) });
		return { ...released, wrote };
	});
	// This stop wrote the exit: it spawns the index too, whether or not a supervisor was alive (one taken over after 60 s
	// may never finalize); the claim keeps a late supervisor's worker from repeating it.
	if (r.wrote) spawnCtxIndex(wl, laneId, "starter");
	line(r.released ? `released ${wl} from ${laneId}` : `${wl} is held by ${r.holder ?? "nobody"}, not ${laneId}; nothing released`);
	return 0;
}

/** Is `pid` still the process lane-started: recorded? `unknown` when no start time was recorded to compare. */
function recordedState(pid: number, start: string): "same" | "gone" | "other" | "unknown" {
	const now = startTime(pid);
	return now === null ? "gone" : !start ? "unknown" : now === start ? "same" : "other";
}

/** Poll until the recorded process is no longer `same`, or `ms` pass; true when it is gone (or the pid was reused). */
async function leftWithin(pid: number, start: string, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (recordedState(pid, start) !== "same") return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(100);
	}
}

/** Signal a process by hand only while it is verifiably the recorded one; `SIGTERM`/`SIGKILL` name the signal it ended after. */
async function endRecorded(pid: number, start: string): Promise<"gone" | "other" | "unverifiable" | "survived" | "SIGTERM" | "SIGKILL"> {
	const state = recordedState(pid, start);
	if (state === "gone" || state === "other") return state;
	if (state === "unknown") return "unverifiable";
	const signal = (sig: NodeJS.Signals): void => {
		try {
			if (recordedState(pid, start) === "same") process.kill(pid, sig);
		} catch {
			// ESRCH: it ended between the check and the signal
		}
	};
	signal("SIGTERM");
	if (await leftWithin(pid, start, END_GRACE_MS)) return "SIGTERM";
	signal("SIGKILL");
	return (await leftWithin(pid, start, 5_000)) ? "SIGKILL" : "survived";
}

function cmdCleanup(wl: string): number {
	const ledger = openLedger();
	const repo = repoOf(ledger, wl);
	if (!repo) throw new Fail("cleanup", `workload ${wl} records no repository`, 1);
	const worktree = worktreePath(repo, wl);
	if (!existsSync(worktree)) {
		line(`no worktree at ${worktree}`);
		return 0;
	}
	const dirty = git(worktree, ["status", "--porcelain"]);
	if (dirty.out) throw new Fail("cleanup", `${worktree} is dirty; commit or stash first`, 1);
	const unpushed = git(worktree, ["log", "--oneline", "@{upstream}..HEAD"]);
	if (unpushed.code !== 0) throw new Fail("cleanup", `${branchName(wl)} has no upstream; push it first`, 1);
	if (unpushed.out) throw new Fail("cleanup", `${branchName(wl)} has unpushed commits; push first`, 1);
	const rm = git(repo, ["worktree", "remove", worktree]);
	if (rm.code !== 0) throw new Fail("cleanup", `git worktree remove failed: ${rm.err}`, 1);
	line(`removed worktree ${worktree}; branch ${branchName(wl)} kept`);
	return 0;
}

function cmdLog(wl: string): number {
	const path = join(laneDir(wl, homeDir()), "runner.log");
	line(path);
	if (existsSync(path)) {
		const tail = readFileSync(path, "utf8").split("\n").slice(-40).join("\n");
		process.stdout.write(`${tail}\n`);
	}
	return 0;
}

// ---- main ------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
	const [cmd, wl, ...rest] = argv;
	if (!cmd || !wl) {
		process.stderr.write("usage: lane.ts launch|run|interactive|stop|cleanup|log|ctx-index|drain <workload> [...]\n");
		return 1;
	}
	switch (cmd) {
		case "launch": {
			const i = rest.indexOf("--requested-by");
			return cmdLaunch(wl, i >= 0 && rest[i + 1] ? rest[i + 1]! : "by-hand");
		}
		case "run": {
			const laneId = rest[0];
			if (!laneId) throw new Fail("run", "run needs <wl> <laneId>", 1);
			return cmdRun(wl, laneId);
		}
		case "interactive":
			return cmdInteractive(wl);
		case "stop":
			return cmdStop(wl);
		case "cleanup":
			return cmdCleanup(wl);
		case "log":
			return cmdLog(wl);
		case "ctx-index": {
			const i = rest.indexOf("--by");
			return runCtxIndex({
				openLedger, workloadId: wl, laneId: rest[0], by: i >= 0 ? rest[i + 1] : undefined, pid: process.pid,
				sessionsDir: join(laneDir(wl, homeDir()), "sessions"), env: process.env, log: (s) => process.stderr.write(`${s}\n`),
			});
		}
		case "drain":
			return cmdDrain(wl);
		default:
			process.stderr.write(`lane.ts: unknown subcommand ${cmd}\n`);
			return 1;
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			const f = err instanceof Fail ? err : new Fail("unknown", String(err), 1);
			process.stderr.write(`lane ${f.stage}: ${f.message}\n`);
			process.exit(f.code);
		},
	);
}
