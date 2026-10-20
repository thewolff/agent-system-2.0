#!/usr/bin/env bun
// The lane script (DESIGN-lane-launcher.md § 4 row "Lane script"; decisions 2, 3, 6, 8, 10, 11, 12,
// 14): one Bun file with subcommands, every ledger write through the module (P-11 row 10).
//
//   launch <wl> [--requested-by <who>]  the starter the surface execs: reserve (predicate inside the
//                                        transaction), preflight, worktree + branch, system prompt,
//                                        spawn `run` detached; prints `lane <laneId> runner <pid>`
//   run <wl> <laneId>                    the runner: one `omp --mode rpc --no-ui` child, the first prompt and
//                                        up to CONTINUE_LIMIT continue prompts on it, lane-started:/lane-ready:/
//                                        lane-exit:, the turn-end decision once omp is settled (src/turn-end.ts),
//                                        stop requests, its own deadline and the ceiling meter (spend:, the 80 %
//                                        question, the 100 % stop) polled every STOP_POLL_MS. It first takes the
//                                        lane id's run lock (takeRunnerLock, one owner per lane id) and then checks
//                                        the recorded omp and runner pids (liveRunnerOf); a lane id held or running,
//                                        or one whose owner ps could not verify, exits 7 (held) before any ledger
//                                        write or spawn; it spawns omp only while the lock still names it (startAsOwner,
//                                        else exit 7 with nothing written); only the lock's owner finalizes, and it
//                                        frees the lock on exit. Every ps call is bounded (PS_TIMEOUT_MS in
//                                        src/omp-probe.ts), since some run inside ledger writes. The quota guard
//                                        (PLAN wl-mv71x5rwdu7eo0 § 4, classifier/src/headroom.ts) is here only: Jo's
//                                        named model projected out spawns no omp (launch-failed: … headroom); an
//                                        unnamed lane on an out lab is moved by set_model before its first prompt
//                                        (lane-headroom:)
//   interactive <wl>                     `as2 lane <wl>`: reserve under the interactive policy, then
//                                        omp in the TUI in the foreground (--model when Jo named one, --resume
//                                        when recorded on that same model)
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
// Exit codes for launch/interactive: surface/src/launch.ts STARTER_EXIT.
import { type Subprocess, spawn, spawnSync } from "bun";
import { appendFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { headroom } from "../../classifier/src/headroom";
import { loadTierTable, modelIdentity } from "../../classifier/src/tier-table";
import { fenceTargets } from "../../gates/src/fence";
import { SCRATCH_ENV } from "../../gates/src/scratch";
import { ensureScratchRoot } from "../src/scratch-root";
import { canonicalPath, homeDir } from "../../ledger/src/locality";
import {
	type EntryRow, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, defaultLedgerPath, type QuestionRow, type ReserveResult, type SliceRow, type Stakes, type WorkloadRow,
} from "../../ledger/src/index";
import {
	type Ceiling, CEILING_OPTIONS, type CeilingOption, ceilingQuestionBody, crossed, effectiveCeiling, scanSpend, type Spend, spendBody, wallMinutes,
} from "../src/ceiling";
import { newLaneSession, runCtxIndex, topLevelSessions } from "../src/ctx-index";
import { decisionLogContext, repoOf } from "../src/decision-log";
import { factsBlock } from "../src/facts";
import { loadTestRunnerConfig } from "../src/close-entry";
import { checkoutOwnerRepo, isTrainOrFix, ownerTasks } from "../src/merge-train";
import {
	type As2Provenance, as2ProvenanceOf, branchBody, branchName, ceilingMaxTime, type ControlEntry, controlEntries, decideInteractive, doneBecause, exitClass, fencedBy, firstPrompt, holdersOf,
	INTENDED_OUTCOMES, interactiveArgv, JO_HOLDER, joInstructionsFor, LANE_MAX_TIME_ENV, laneArgv, laneCap, laneDiedDeadlineBody, laneDiedExitBody, laneDiedLaunchBody, laneDir, laneEnv, laneExit,
	laneExitBody, laneDecidedBody, laneHeadroomBody, laneMaxTime, laneModel, type LaneOutcome, laneReadyBody, laneStarted, laneStartedBody, laneStopAcceptedBody, laneStopRequestBody, launchFailedBody, doneLine,
	maxTimeMs, pendingStop, planFirst, PRECLAIM_LEASE_MS, resolutions, resumePlan, scratchCapMb, STARTER_EXIT, stateModelCheck, stateModelOf, STOP_POLL_MS, verdictOf, worktreeBody, worktreePath,
} from "../src/launch";
import {
	BACKGROUND_SUFFIX, CONTINUE_LIMIT, continueCounter, continuePrompt, deadRunPrompt, type DeadTestRun, deadTestRuns, enqueueRunnerDeath, exitOutcome, heldOpenBody, IDLE_CHECK, IDLE_LIMIT, idleActivity,
	idlePrompt, liveTestRuns, type PromptError, promptErrorOf, releasedOpen, SETTLE_CHECK, SETTLE_IDLE_MS, settleIdle, sliceCounts, STATE_ID, turnEnd, turnEndDeathBody, turnEndFailedDeathBody,
	type TurnEndInput, unsettledHandsOf,
} from "../src/turn-end";
import { waitingReserved } from "../src/errors";
import { ompPidState, type PidState, psAnswer, type PsRun, runPs, statStart } from "../src/omp-probe";
import { PAIR_OPTION, type PairSignalId, pairOffer, pairOfferBody, readPairSuggestConfig } from "../src/pair-suggest";
import { decideRanked, drainOrder, type RankConfig, rankShadowLine, readRankConfig, writePickSnapshot } from "../src/rank-launch";
import { laneDeaths } from "../src/signals";
import { readTracingSetting, tracingEnv } from "../src/tracing";
import { parseHeartbeat, runDirOf, runsRoot, testRuns } from "../src/test-run";
import { DECISION_LOG_ENV, LANE_TOOLS, LEASE_MS, LEASE_MS_ENV, ORCHESTRATOR_RECIPIENT, ROLE_ENV } from "../src/types";
import { readCleanShell } from "../../gates/src/clean-shell";
import { LANE_ENV, WORKLOAD_ENV } from "../../gates/src/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TIER_FILE = join(REPO_ROOT, "tiers", "lane.md");
/** A millisecond knob from the environment, or its fallback (the fake-omp tests shorten the two waits below). */
const msEnv = (name: string, fallback: number): number => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** The readiness window: the lane's own claim must land within the pre-claim lease (decisions 8, 14). */
const READY_MS = msEnv("AGENT_SYSTEM_LANE_READY_MS", PRECLAIM_LEASE_MS);
const READY_POLL_MS = 1_000;
/** After `abort` and stdin EOF, the wait before SIGKILL (§ 3 stop path). */
const END_GRACE_MS = msEnv("AGENT_SYSTEM_LANE_END_GRACE_MS", 30_000);
/** The settle wait with no omp activity that makes a session idle (PLAN wl-mv5i3lulwwbbi8 D6); the fake-omp tests shorten it. */
const SETTLE_IDLE = msEnv("AGENT_SYSTEM_LANE_SETTLE_IDLE_MS", SETTLE_IDLE_MS);
const PROFILE = process.env.AGENT_SYSTEM_PROFILE || process.env.OMP_PROFILE || "agent-system-2";
/** The installed profile's agent dir: its config.yml carries the clean-shell switch and the tier table (classifier/extension.ts reads the same file). */
const profileAgentDir = (): string => join(homeDir(), ".omp", "profiles", PROFILE, "agent");
/** The installed profile's config.yml: the file preflight checks and the tracing switch is read from at each spawn. */
const profileConfig = (): string => join(profileAgentDir(), "config.yml");
/** The lane's env (laneEnv), with the clean-shell switch read from the installed profile's agent dir at this spawn. */
const boundEnv = (workloadId: string, laneId: string): Record<string, string> =>
	laneEnv(process.env, { workloadId, laneId }, readCleanShell(profileAgentDir()));
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
/** The bound on each of `readAs2Provenance`'s two git reads; past it the field is null and the launch goes on. */
const PROVENANCE_GIT_TIMEOUT_MS = 10_000;

/**
 * The as2 checkout this script runs from (`repo`, default REPO_ROOT: the machinery the installed profile points at) as
 * `lane-started:` records it (PLAN wl-mv654hoqwpfhmo § 11.3): `git rev-parse HEAD` and `git status --porcelain
 * --untracked-files=no` (tracked changes only: the live checkout always holds untracked notes such as `.ai/`), the second
 * without optional locks so it never writes that checkout's index. A git that fails, times out or cannot be run leaves its
 * field null; nothing here throws, so provenance never blocks a launch.
 */
export function readAs2Provenance(repo: string = REPO_ROOT): As2Provenance {
	const ask = (args: string[]) => {
		try {
			const r = git(repo, args, PROVENANCE_GIT_TIMEOUT_MS);
			return r.timedOut ? null : r;
		} catch {
			return null;
		}
	};
	return as2ProvenanceOf(ask(["rev-parse", "--verify", "HEAD"]), ask(["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"]));
}

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

/** The one prompt (§ 7 item 3), from the rows as they stand at launch; a metered lane's ceiling line goes after the stakes line (DESIGN-workload-ceiling.md § 2 item 4). */
function promptFor(ledger: Ledger, w: WorkloadRow, laneId: string, p: Prepared, ceilingLine: string | null): string {
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
	const prompt = firstPrompt({
		workload: w, laneId, repo: p.repo, worktree: p.worktree, branch: p.branch, done: doneLine(control), planFirst: planFirst(control)?.trigger ?? null,
		decisionLog, facts, resolved, instructions: joInstructionsFor(control, instructions, laneId), machinery: canonicalPath(p.repo) === canonicalPath(REPO_ROOT), tools: LANE_TOOLS,
		scratch: { root: p.scratch, capMb: scratchCapMb(process.env) }, trainTasks: ownerTasks(ledger, w.id),
		runnerServed, trainOrFix: isTrainOrFix(entries, instructions),
	});
	if (ceilingLine === null) return prompt;
	const out = prompt.split("\n");
	out.splice(out.indexOf(`stakes: ${w.stakes} · mode: ${w.mode}`) + 1, 0, ceilingLine);
	return out.join("\n");
}

/**
 * The model and session this attempt starts on, read fresh at every spawn: Jo's named model (`laneModel`, null for the
 * profile default) and the session `resumeOrigin` picks (decisions 6, 7, 14), resumed only when its origin lane ran on that
 * same model (`resumePlan`, MIGRATION.md item 85); `skipped` says why a recorded session was not resumed.
 */
function resumeOf(ledger: Ledger, w: WorkloadRow, laneId: string): { model: string | null; resume: string | null; skipped: string | null } {
	const entries = ledger.entries(w.id);
	const control = controlEntries(entries, holdersOf(entries, w.holder));
	const model = laneModel(control);
	return { model, ...resumePlan(control, laneId, resolutions(control, ledger.questions(w.id), ledger.instructions(w.id), ledger.slices(w.id)), model) };
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
 * `decideLaunch` exactly. Interactive: `decideInteractive`, never gated; an admit writes Jo's pick snapshot
 * (`rank-shown: … by pick`, D6) in the same transaction, before `launch: … cause interactive`, and a refusal writes neither.
 */
export function reserve(ledger: Ledger, wl: string, who: string, interactive: boolean, config: RankConfig = readRankConfig()): ReserveResult {
	const input = { by: LANE_STARTER_BY, cap: laneCap(process.env), leaseMs: PRECLAIM_LEASE_MS, requestedBy: who };
	if (!interactive) return ledger.reserveLane(wl, { ...input, decide: (rows) => decideRanked(ledger, rows, config) });
	try {
		return ledger.write(() => {
			const r = ledger.reserveLane(wl, {
				...input,
				decide: (rows) => {
					const v = decideInteractive(rows);
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

/** The starter's environment for a launch the drain makes: the caller's, without the lane binding `laneEnv` writes, so the next lane's starter never carries the ended lane's role, workload, lane id or scratch root. */
export function starterEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== ROLE_ENV && k !== WORKLOAD_ENV && k !== LANE_ENV && k !== SCRATCH_ENV) out[k] = v;
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
 * reservation, so the drain waits for it.
 */
async function runStarter(wl: string): Promise<{ code: number; line: string }> {
	const p = spawn(["bun", import.meta.path, "launch", wl, "--requested-by", LANE_RUNNER_BY], {
		cwd: dirname(drainLogPath()), env: starterEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	const lines = (out.trim() || err.trim()).split("\n").filter(Boolean);
	return { code, line: lines.at(-1) ?? (p.signalCode ? `the starter was killed (${p.signalCode})` : "the starter printed nothing") };
}

/**
 * `drain <wl>`: sequential. Each round reads the open workloads in the order Jev ranking's mode names
 * (`jevRank`, read fresh each round, PLAN wl-mv8k039gvogt8g D7): oldest first (`inFlight`, the tick's
 * order) in `show`, `rankOpen` order (`drainOrder`, pins first) in `order` and `parallel`, and runs the
 * starter for the first one not yet tried whose predicate says launch, awaiting its own exit with no
 * timeout (`runStarter`: a killed starter could strand its committed reservation; its exception path
 * releases a failed one). The starter's reservation applies the rank gate, so a `ranked:` or `parallel:`
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
				const order = config.mode === "show" ? ledger.inFlight().map((w) => w.workload.id) : drainOrder(ledger, ledger.now());
				const next = order.find((id) => {
					if (tried.has(id)) return false;
					const rows = ledger.launchRows(id, cap);
					return rows !== null && verdictOf(rows).launch;
				});
				if (next === undefined) break;
				if (config.mode === "show") {
					try {
						drainLine(rankShadowLine(ledger, process.pid, next, tried, cap, config));
					} catch (err) {
						drainLine(`rank-shadow ${process.pid} failed: ${String(err)}`);
					}
				}
				tried.add(next);
				const r = await runStarter(next);
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

// ---- the ceiling meter (DESIGN-workload-ceiling.md § 2 item 4) ------------------------------------

/**
 * Where the ceiling question raised for one ceiling value stands: never raised (or only withdrawn: the
 * runner's own cancel at a clean finish, or Jo's withdraw), open, or answered with one of the options.
 */
export type CeilingQuestionState = "none" | "open" | CeilingOption;

/** The runner's memory across polls in this run: the ceiling values (`ceilingKey`) it raised a question for. */
export interface MeterState {
	raised: readonly string[];
}
export interface MeterInputs {
	/** The effective ceiling now (`effectiveCeiling`). */
	ceiling: Ceiling;
	/** The workload's spend so far: every session file's usage and the wall across runs. */
	spend: Spend;
	/** The ceiling question for this ceiling value, as the ledger shows it (`ceilingQuestionState`). */
	question: CeilingQuestionState;
}
/** One poll's decision. `raise` and `stop` both write a `spend:` entry; neither is "none". */
export interface MeterResult {
	state: MeterState;
	level: 0 | 80 | 100;
	/** Raise the ceiling question: once per ceiling value, from 80 % on. */
	raise: boolean;
	/** Stop the lane: at 100 %, whatever the question for this value says. */
	stop: boolean;
}

/** A ceiling value as the meter keys it: an extend or a lowering is a new value that may raise again. */
export const ceilingKey = (c: Ceiling): string => `usd ${c.usd} wall ${c.wallMin}`;

/**
 * One poll of the meter, pure. From 80 % of either half, the question is raised once per ceiling
 * value in this run while none is open or answered for it, and the lane keeps working. At 100 % the
 * lane stops, whatever the question says; when none is open or answered for this value (the spend
 * jumped past 80 % between polls, a relaunch after a withdrawn question, or Jo withdrew it), the
 * question is raised with the stop, so a ceiling stop always leaves Jo the three answers. A withdrawn
 * question reads as never raised (`ceilingQuestionState`), so a relaunch at 85 % raises afresh; this
 * run's memory keeps a question Jo withdrew from coming back before 100 %. An extend answer is a
 * raised ceiling, a new value the caller passes in, with its own question state; an extend whose
 * raise has not landed leaves the old value in force, and the old value stops (stop is the default).
 */
export function meterStep(state: MeterState, inputs: MeterInputs): MeterResult {
	const level = crossed(inputs.spend, inputs.ceiling);
	if (level === 0) return { state, level, raise: false, stop: false };
	const key = ceilingKey(inputs.ceiling);
	const raise = inputs.question === "none" && (level === 100 || !state.raised.includes(key));
	return { state: raise && !state.raised.includes(key) ? { raised: [...state.raised, key] } : state, level, raise, stop: level === 100 };
}

/** The runner's ceiling question: its slice is `sl-ceiling-…` and the runner raised it (the predicate surface/src/input.ts exports as `isCeilingQuestion`). */
const ceilingQuestion = (q: QuestionRow, slice: SliceRow): boolean => slice.id.startsWith("sl-ceiling-") && q.created_by === LANE_RUNNER_BY;

/** The ceiling slice's done condition ends with the ceiling value its question was raised for (`raiseCeilingQuestion`). */
const RAISED_FOR = /\bceiling (usd \S+ wall \S+)$/;

/**
 * The newest ceiling question raised for `ceiling`'s value that is open or answered, as `meterStep`
 * reads it; a withdrawn one is skipped (it no longer asks anything), so a value whose questions were
 * all withdrawn reads `"none"`. Jo's `pair` (PLAN wl-mv67564rdkfvnk D7: stop plus a flip to user-driven, settled by
 * the surface as stop) reads as stop by name; any other answer that is none of the options reads as stop, the default.
 */
export function ceilingQuestionState(
	questions: readonly QuestionRow[], slices: readonly SliceRow[], instructions: readonly InstructionRow[], ceiling: Ceiling,
): CeilingQuestionState {
	const key = ceilingKey(ceiling);
	for (let i = questions.length - 1; i >= 0; i--) {
		const q = questions[i]!;
		const slice = slices.find((s) => s.id === q.slice_id);
		if (!slice || !ceilingQuestion(q, slice) || RAISED_FOR.exec(slice.done_condition)?.[1] !== key || q.state === "withdrawn") continue;
		if (q.state === "open") return "open";
		const word = instructions.find((x) => x.id === q.resolved_by)?.body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		if (word === PAIR_OPTION) return "stop";
		return (CEILING_OPTIONS as readonly string[]).includes(word) ? (word as CeilingOption) : "stop";
	}
	return "none";
}

/** D1 at the ceiling raise: the offer, or null; a failure to compute it never blocks the raise (as the round-limit site's `roundLimitPairOffer`). */
function ceilingPairOffer(ledger: Ledger, workloadId: string): { signals: PairSignalId[] } | null {
	try {
		return pairOffer(ledger, workloadId, "ceiling", { config: readPairSuggestConfig() });
	} catch (err) {
		process.stderr.write(`runner: the pair offer on ${workloadId} could not be computed (${String(err)}); the ceiling question is raised without it\n`);
		return null;
	}
}

/**
 * The raise, in one write stamped `lane-runner`: the slice `sl-ceiling-<wl>-<n>` (slice ids are
 * ledger-wide, so the workload is in the id; n = 1 + the workload's ceiling slices), the question on
 * it with the three options (the file pauses the slice), and the `spend:` entry. When the installed
 * profile's `pairSuggest` switch covers the workload and a signal fired (PLAN wl-mv67564rdkfvnk D1,
 * surface/src/pair-suggest.ts `pairOffer`, read before anything is written), the question also stores
 * `pair` as its last option and a `pair-offer:` entry records it; the body is unchanged (PLAN
 * wl-mvb9mw00ycfjeo D1: the surface shows the offer on its own line). An offer that throws is logged
 * and the plain question raised. `ceilingQuestionState` reads an answer of `pair` as stop.
 */
export function raiseCeilingQuestion(ledger: Ledger, r: { workloadId: string; laneId: string; spend: Spend; ceiling: Ceiling; stakes: Stakes }): { sliceId: string; questionId: string } {
	return ledger.write(() => {
		const offer = ceilingPairOffer(ledger, r.workloadId);
		const prefix = `sl-ceiling-${r.workloadId.replace(/^wl-/, "")}-`;
		let n = 1 + ledger.slices(r.workloadId).filter((s) => s.id.startsWith(prefix)).length;
		while (ledger.slice(`${prefix}${n}`) !== null) n += 1;
		const sliceId = ledger.addSlice({
			by: LANE_RUNNER_BY, workloadId: r.workloadId, id: `${prefix}${n}`, task: "Jo decides the ceiling overrun",
			doneCondition: `Jo answers stop, extend or split for the ceiling ${ceilingKey(r.ceiling)}`, inputs: "ceiling",
		});
		const questionId = ledger.raiseQuestion({
			by: LANE_RUNNER_BY, workloadId: r.workloadId, sliceId,
			body: ceilingQuestionBody(r.workloadId, r.spend, r.ceiling, r.stakes), options: offer ? [...CEILING_OPTIONS, PAIR_OPTION] : [...CEILING_OPTIONS],
		});
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: r.workloadId, kind: "assumption", body: spendBody(r.laneId, r.spend) });
		if (offer) ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: r.workloadId, kind: "assumption", body: pairOfferBody(questionId, "ceiling", offer.signals) });
		return { sliceId, questionId };
	});
}

/** A lane that finished under the ceiling withdraws every open ceiling question (`then: cancel`), so the close is not blocked (§ 2 item 4). */
export function withdrawCeilingQuestions(ledger: Ledger, workloadId: string): string[] {
	const slices = ledger.slices(workloadId);
	const out: string[] = [];
	for (const q of ledger.questions(workloadId)) {
		const slice = slices.find((s) => s.id === q.slice_id);
		if (q.state !== "open" || !slice || !ceilingQuestion(q, slice)) continue;
		ledger.withdrawQuestion(q.id, { by: LANE_RUNNER_BY, reason: "finished under the ceiling", author: LANE_RUNNER_BY, channel: "direct", then: "cancel" });
		out.push(q.id);
	}
	return out;
}

/** What `recordDecision` wrote, step by step (the tests read it; the runner only logs failures). */
export interface DecisionRecord {
	death: "written" | "present" | "failed" | "none";
	withdrawn: boolean | "failed";
	marker: "written" | "skipped" | "failed" | "none";
}

/**
 * The runner's decided outcome on the ledger before stdin EOF (MIGRATION.md item 40), each step in its own try/catch that
 * logs and goes on: (1) a death enqueues its lane-died: line (D5; whatever the holder, so a release cannot hide it, D3),
 * with the background suffix when omp was not settled; (2) `completed` / `released` withdraw the open ceiling questions
 * (then cancel), so the close is not blocked and the lane's shutdown does not count the paused ceiling slice as its
 * unfinished work; (3) an intended outcome records `lane-decided:` so the lane row's session_shutdown reads the end as
 * intended (`exitClass`, decision 14), only when step 2 did not throw: a paused ceiling slice behind an intended marker
 * would be lost, so the shutdown death stands instead. A death outcome never writes the marker: its record is its death.
 */
export function recordDecision(
	ledger: Ledger,
	d: { workloadId: string; laneId: string; outcome: LaneOutcome; death: string | null; settled: boolean },
): DecisionRecord {
	const out: DecisionRecord = { death: "none", withdrawn: false, marker: "none" };
	if (d.death !== null) {
		try {
			const id = enqueueRunnerDeath(ledger, { workloadId: d.workloadId, laneId: d.laneId, body: d.settled ? d.death : `${d.death}${BACKGROUND_SUFFIX}` });
			out.death = id === null ? "present" : "written";
		} catch (err) {
			out.death = "failed";
			process.stderr.write(`runner: the lane-died: line could not be written: ${String(err)}\n`);
		}
	}
	if (d.outcome === "completed" || d.outcome === "released") {
		try {
			out.withdrawn = withdrawCeilingQuestions(ledger, d.workloadId).length > 0;
		} catch (err) {
			out.withdrawn = "failed";
			process.stderr.write(`runner: the ceiling question could not be withdrawn: ${String(err)}\n`);
		}
	}
	if (INTENDED_OUTCOMES[d.outcome]) {
		if (out.withdrawn === "failed") out.marker = "skipped";
		else {
			try {
				ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: d.workloadId, kind: "assumption", body: laneDecidedBody(d.laneId, d.outcome) });
				out.marker = "written";
			} catch (err) {
				out.marker = "failed";
				process.stderr.write(`runner: the lane-decided: line could not be written: ${String(err)}\n`);
			}
		}
	}
	return out;
}

/** The first prompt's ceiling line: the ceiling, the spend so far, and the remainder a brief's ceiling-share comes from. */
export function ceilingPromptLine(c: Ceiling, s: Spend): string {
	const usd = Math.max(0, c.usd - s.usd);
	const wall = Math.max(0, c.wallMin - s.wallMin);
	return `ceiling: $${c.usd} / ${c.wallMin} min for the workload; spent so far $${s.usd.toFixed(2)} / ${Math.round(s.wallMin)} min (${Math.round(s.tokens)} tokens); set each brief's ceiling-share from the remainder, $${usd.toFixed(2)} / ${Math.round(wall)} min. At 80 % Jo is asked; at 100 % this lane is stopped.`;
}

// ---- the run guard: one runner per lane id ---------------------------------------------------------

/** How the guard asks the machine about a `lane-started:` entry's two pids; the tests pass a fake. */
export interface RunnerProbe {
	/** The omp pid against the start time the entry recorded; with none recorded, `unknown` while the pid is alive (`gone` once it is not). */
	omp(pid: number, start: string): PidState;
	/** The runner pid, whose start time no entry records: `same` only while its command line is still `lane.ts run <wl> <laneId>` (`isRunnerCommand`). */
	runner(pid: number): PidState;
}

/**
 * The process a second `lane.ts run` on the same lane id would collide with: alive and this lane's, (`uninspected`) one
 * ps could not answer for, or (`unverified`) a live omp pid with no recorded start time.
 */
export interface LiveRunner {
	what: "omp" | "runner";
	pid: number;
	/** The probe answered `failed`: the pid may be this lane's live process, and the run is refused as retryable, not as running. */
	uninspected?: true;
	/** The probe answered `unknown`: a live pid no start time can tell from this lane's omp, refused as retryable until it exits. */
	unverified?: true;
}

/**
 * The live process of a lane id already running, or null when `lane.ts run` may start it (pure; the probe is the only
 * outside read). Every `lane-started:` for `laneId` after its newest `lane-exit:` is checked, newest first, so a pid that
 * a later start record superseded but that is still alive refuses too: a lane id with a live omp is running whichever
 * entry named it. An entry refuses when its omp pid is `same` (alive, and its start time matches the recorded one), or
 * when its runner pid is not `selfPid` and is `same` (still running `lane.ts run` on this workload and lane id: no start
 * time is recorded for the runner, so its command line is the identity check). `gone` and `other` (the pid was reused)
 * never refuse. `unknown` (the omp pid is alive and no start time was recorded for it) refuses as `unverified`: it cannot
 * be told apart from this lane's omp, so it is never permission to start (openai review r2 #1). `failed` (ps could not
 * answer for a recorded pid) refuses as `uninspected`: the owner was not shown gone, so a second runner could be a
 * duplicate and its finalizer could release the first one's workload (openai review r1 #4).
 * `selfPid` skips only the runner check, since this process matches its own command; an omp that entry names still counts.
 *
 * This is the second check, not the exclusion: `cmdRun` runs it while holding the lane id's run lock (`takeRunnerLock`),
 * which is what keeps two `run` calls on one lane id from both spawning omp. This check catches what the lock cannot
 * see: an omp still alive after its runner died (the lock was taken over from a dead pid), and a lane id an interactive
 * lane or a runner that predates the lock started.
 */
export function liveRunnerOf(control: readonly ControlEntry[], laneId: string, selfPid: number, probe: RunnerProbe): LiveRunner | null {
	const checked = new Set<string>();
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.laneId !== laneId) continue;
		if (c.prefix === "lane-exit") return null;
		if (c.prefix !== "lane-started") continue;
		const s = laneStarted([c], laneId);
		if (s === null) continue;
		// The runner re-records lane-started: once omp names its model and session; the pids repeat, so each pair is probed once.
		const key = `${s.pid} ${s.start} ${s.runnerPid}`;
		if (checked.has(key)) continue;
		checked.add(key);
		if (s.pid > 0) {
			const omp = probe.omp(s.pid, s.start);
			if (omp === "same") return { what: "omp", pid: s.pid };
			if (omp === "unknown") return { what: "omp", pid: s.pid, unverified: true };
			if (omp === "failed") return { what: "omp", pid: s.pid, uninspected: true };
		}
		if (s.runnerPid > 0 && s.runnerPid !== selfPid) {
			const runner = probe.runner(s.runnerPid);
			if (runner === "same") return { what: "runner", pid: s.runnerPid };
			if (runner === "failed") return { what: "runner", pid: s.runnerPid, uninspected: true };
		}
	}
	return null;
}

/** Whether a `ps -o command=` line is `lane.ts run <wl> <laneId>` (how `cmdLaunch` and chaos start a runner), whatever the path to lane.ts. */
export function isRunnerCommand(command: string, wl: string, laneId: string): boolean {
	const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[\\s/])lane\\.ts run ${esc(wl)} ${esc(laneId)}(?:\\s|$)`).test(command);
}

/**
 * The machine's probe for `liveRunnerOf`, over `run` (ps; the tests pass a fake). The omp pid is read by the shared
 * strict reader (`ompPidState`, surface/src/omp-probe.ts); the runner pid by its command line. A ps that cannot be
 * spawned or answers anything but a clean line or a clean "no such process" reads `failed`, its reason kept in
 * `failure` for the refusal.
 */
export function runnerProbe(wl: string, laneId: string, run: PsRun = runPs): RunnerProbe & { failure: string | null } {
	const p = {
		failure: null as string | null,
		omp: (pid: number, start: string): PidState =>
			ompPidState(pid, start, run, (reason) => {
				p.failure = reason;
			}),
		runner: (pid: number): PidState => {
			try {
				const command = psAnswer(run, pid, "command=");
				return command === null ? "gone" : isRunnerCommand(command, wl, laneId) ? "same" : "other";
			} catch (err) {
				p.failure = err instanceof Error ? err.message : String(err);
				return "failed";
			}
		},
	};
	return p;
}

// ---- the run lock: one owner per lane id -----------------------------------------------------------

/** A runner's identity in its run lock: its pid and that pid's ps start time, so a reused pid never reads as the owner. */
export interface RunnerIdentity {
	pid: number;
	start: string;
}

/** The lane id's run lock, under the lanes root beside the lane's system prompt, sessions and logs: `~/.agent-system-2/lanes/<wl>/<laneId>.run.lock`. */
export function runnerLockPath(wl: string, laneId: string, h: string = homeDir()): string {
	return join(laneDir(wl, h), `${laneId}.run.lock`);
}

/** The lock file's owner: null when there is no file, `unreadable` when its content is not a pid and a start time. */
function lockOwner(path: string): RunnerIdentity | null | "unreadable" {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		const o = JSON.parse(text) as { pid?: unknown; start?: unknown };
		if (typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0 && typeof o.start === "string") return { pid: o.pid, start: o.start };
	} catch {
		// not JSON: unreadable, below
	}
	return "unreadable";
}

/**
 * A run lock this runner took. `held` re-reads the file: true while no other runner holds the lane id, that is while the
 * file names `self`, or while it is gone (removed under the runner, as with its lane dir) and nobody has taken it since;
 * false once it names another runner or names none. `owns` is the strict read the spawn needs (`startAsOwner`): true only
 * while the file exists and names `self`. `release` removes the file only while it names `self`.
 */
export interface RunnerLock {
	path: string;
	self: RunnerIdentity;
	/** The stale owner this runner replaced (its pid gone, or reused by a process with another start time), or null. */
	tookOver: { owner: RunnerIdentity; state: "gone" | "other" } | null;
	held(): boolean;
	owns(): boolean;
	release(): void;
}

/**
 * Why `takeRunnerLock` refused: the owner is alive (`same`), alive with no start time to verify it by (`unknown`), ps
 * could not answer for it (`failed`), the file names no owner (`unreadable`), or a writer outside the protocol created
 * the file between the read and the link (`raced`). Every one is a refusal, never a takeover.
 */
export interface LockRefusal {
	owner: RunnerIdentity | null;
	state: "same" | "unknown" | "failed" | "unreadable" | "raced";
}

function heldLock(path: string, self: RunnerIdentity, tookOver: RunnerLock["tookOver"]): RunnerLock {
	/** Whether the file names this runner: null when there is no file, false when it names another runner or none. */
	const mine = (): boolean | null => {
		try {
			const o = lockOwner(path);
			return o === null ? null : o !== "unreadable" && o.pid === self.pid && o.start === self.start;
		} catch {
			return false;
		}
	};
	return {
		path, self, tookOver,
		held: () => mine() !== false,
		owns: () => mine() === true,
		// No other runner replaces a lock whose owner is alive, so the file read as this runner's is still this runner's at the rm.
		release: () => {
			if (mine() === true) rmSync(path, { force: true });
		},
	};
}

/**
 * Take a lane id's run lock at `path` for `self`, or refuse (openai review r2 #1). The file holds the owner's pid and ps
 * start time and is created exclusively: the identity is written to a file of this pid's own and hard-linked in, so the
 * lock never exists half-written, and the link fails EEXIST as an O_EXCL create does. An existing lock is taken over
 * only when `check` (the same pid-and-start-time check an omp gets) reads its owner `gone` or `other`; any other answer
 * refuses. The read, the check, the takeover and the create all run inside one ledger write: the ledger's BEGIN
 * IMMEDIATE is the cross-process mutex, so two runners that both find one stale owner cannot both replace it, and the
 * mutex is never left behind (SQLite drops it when its process dies). Nothing is written to the ledger. A lock that
 * already names `self` is held (a busy-retried transaction runs this body twice). `check` runs inside the write, so it
 * must be bounded: the runner's is `runnerProbe` over `runPs`, where a ps past PS_TIMEOUT_MS reads `failed` (a refusal).
 */
export function takeRunnerLock(ledger: Pick<Ledger, "write">, path: string, self: RunnerIdentity, check: (pid: number, start: string) => PidState): RunnerLock | LockRefusal {
	mkdirSync(dirname(path), { recursive: true });
	return ledger.write((): RunnerLock | LockRefusal => {
		const owner = lockOwner(path);
		if (owner === "unreadable") return { owner: null, state: "unreadable" };
		if (owner !== null && owner.pid === self.pid && owner.start === self.start) return heldLock(path, self, null);
		let tookOver: RunnerLock["tookOver"] = null;
		if (owner !== null) {
			const state = check(owner.pid, owner.start);
			if (state !== "gone" && state !== "other") return { owner, state };
			rmSync(path, { force: true });
			tookOver = { owner, state };
		}
		const tmp = `${path}.${self.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(self)}\n`, { mode: 0o600 });
		try {
			linkSync(tmp, path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const now = lockOwner(path);
			return { owner: now === "unreadable" ? null : now, state: "raced" };
		} finally {
			rmSync(tmp, { force: true });
		}
		return heldLock(path, self, tookOver);
	});
}

/** This process's identity for its run lock: its pid and its ps start time, read strictly (a ps failure throws). */
export function selfIdentity(run: PsRun = runPs, pid: number = process.pid): RunnerIdentity {
	const out = psAnswer(run, pid, "stat=,lstart=");
	const start = out === null ? "" : statStart(out).start;
	if (!start) throw new Error(`ps -p ${pid} -o stat=,lstart= answered ${out === null ? "no such process" : `no start time: ${out}`}`);
	return { pid, start };
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
 * lock to the next one's stale takeover.
 */
async function cmdRun(wl: string, laneId: string): Promise<number> {
	const ledger = openLedger();
	const w = ledger.workload(wl);
	if (!w) throw new Fail("run", `no workload ${wl}`, STARTER_EXIT.unknown!);
	const probe = runnerProbe(wl, laneId);
	const lock = holdRunnerLock(ledger, wl, laneId, probe);
	try {
		const live = liveRunnerOf(controlEntries(ledger.entries(wl)), laneId, process.pid, probe);
		if (live?.uninspected) {
			throw new Fail("run", `${laneId} not started: inspecting the recorded ${live.what} pid ${live.pid} failed (${oneLine(probe.failure ?? "ps did not answer")}); nothing was written, retryable once ps can answer`, STARTER_EXIT.held!);
		}
		if (live?.unverified) {
			throw new Fail("run", `${laneId} not started: the recorded ${live.what} pid ${live.pid} is alive and no start time was recorded for it, so it cannot be told from this lane's omp; nothing was written, retryable once it exits`, STARTER_EXIT.held!);
		}
		if (live !== null) throw new Fail("run", `${laneId} already running: ${live.what} pid ${live.pid}`, STARTER_EXIT.held!);
		return await runOwned(ledger, w, wl, laneId, lock);
	} finally {
		lock.release();
	}
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
	/** The open-slice count of this lane's `released-open:` marker (D4), read with the holders decideTurn uses, or null. */
	const releasedOpenNow = (): number | null => {
		const es = ledger.entries(wl);
		return releasedOpen(controlEntries(es, holdersOf(es, ledger.workload(wl)?.holder ?? null, ledger.holders(wl))), laneId);
	};
	/** OMP's `--max-time`: the ceiling's remaining wall plus the margin, or AGENT_SYSTEM_LANE_MAX_TIME when that is set and shorter; fixed at the spawn. */
	let maxTime = laneMaxTime(process.env);
	const spawnedAt = Date.now();
	let deadlineAt = spawnedAt + (maxTimeMs(maxTime) ?? Number.MAX_SAFE_INTEGER);
	const readyMinutes = READY_MS >= 60_000 ? `${Math.round(READY_MS / 60_000)}m` : `${Math.round(READY_MS / 1000)}s`;

	let child: Subprocess<"pipe", "pipe", "inherit"> | null = null;
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
	 * `provider/id` (`stateModelCheck`); an unnamed lane's model, when projected out of quota, must first be moved (`move`).
	 */
	let modelChecked = false;
	/** The quota signal, read once before the spawn (classifier/src/headroom.ts; `AS2_HEADROOM_POLLS` names the polls in tests). */
	const room = headroom();
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
	// The as2 checkout this runner runs from, read once before the spawn's write (git never runs inside a ledger write), so every
	// lane-started: of this run names the same commit (PLAN wl-mv654hoqwpfhmo § 11.3).
	const as2 = readAs2Provenance();
	const startRecord = (): string => {
		const c = child;
		if (c !== null && ompStart === null) {
			try {
				ompStart = startTime(c.pid) ?? "";
			} catch (err) {
				throw new Fail("run", `${laneId} not started: omp pid ${c.pid}'s start time, which its lane-started: records, could not be read (${oneLine(err)}); omp is killed and its start not recorded`, STARTER_EXIT.unknown!);
			}
		}
		return laneStartedBody(laneId, { pid: c?.pid ?? 0, start: ompStart ?? "", session, argv, runnerPid: process.pid, model, ranModel, resumeSkipped }, as2);
	};

	// The ceiling meter (DESIGN-workload-ceiling.md § 2 items 3, 4): the offsets live as long as the run and the first scan starts
	// every file at byte 0, so a relaunch counts the whole workload; the wall is the finished runs plus this one since its spawn.
	const offsets = new Map<string, number>();
	let tally: Spend = { usd: 0, tokens: 0, wallMin: 0 };
	let meterState: MeterState = { raised: [] };
	let sessionsDir: string | null = null;
	let runStart: number | null = null;
	const measure = (control: readonly ControlEntry[]): Spend => {
		if (sessionsDir !== null) tally = scanSpend(sessionsDir, offsets, tally);
		return { ...tally, wallMin: wallMinutes(control, Date.now(), runStart) };
	};
	/**
	 * One meter poll: raise at 80 % once per ceiling value, stop at 100 % through the stop path (acceptance `ceiling`, outcome stop,
	 * no lane-died:). A failure is logged, never fatal; a stop the step called for is taken even when its writes failed. Returns
	 * whether it stopped the lane.
	 */
	const meter = (stakes: Stakes, control: readonly ControlEntry[]): boolean => {
		let stopping = false;
		try {
			const spend = measure(control);
			const instructions = ledger.instructions(wl);
			const ceiling = effectiveCeiling(control, instructions, stakes);
			const step = meterStep(meterState, { ceiling, spend, question: ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), instructions, ceiling) });
			stopping = step.stop;
			if (step.raise) raiseCeilingQuestion(ledger, { workloadId: wl, laneId, spend, ceiling, stakes });
			else if (step.stop) record(spendBody(laneId, spend));
			meterState = step.state;
		} catch (err) {
			process.stderr.write(`runner: the ceiling meter failed: ${String(err)}\n`);
		}
		if (stopping) stop("ceiling", "ceiling");
		return stopping;
	};

	/** Once: stdin EOF, then SIGKILL after the grace period if the child has not exited. */
	const end = (): void => {
		if (ended || !child) return;
		ended = true;
		const c = child;
		try {
			c.stdin.end();
		} catch {
			// the pipe is already closed by a dead child
		}
		timers.push(setTimeout(() => {
			if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
		}, END_GRACE_MS));
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
			// omp exited before the runner decided: a release with this lane's released-open: marker is still open-work (D4).
			const exit = outcome === null ? exitOutcome(laneId, { ready, held, releasedOpen: releasedOpenNow() }) : null;
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
			let drained = false;
			const owned = writeAsOwner(ledger, lock, () => {
				if (exit?.death) enqueueRunnerDeath(ledger, { workloadId: wl, laneId, body: exit.death });
				if (held && !intended && !laneDeaths(ledger, wl).some((d) => d.holder === laneId)) {
					const body = final === "never-ready"
						? laneDiedLaunchBody(laneId, readinessStage, readinessFailure ?? `no claim in ${readyMinutes}`)
						: final === "deadline" ? laneDiedDeadlineBody(laneId, maxTime, inFlight) : laneDiedExitBody(laneId, final, code, signal);
					ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body });
				}
				if (final === "never-ready") record(launchFailedBody(laneId, readinessStage, `${readinessFailure ?? `never ready in ${readyMinutes}`} (omp exit code ${code ?? "-"} signal ${signal ?? "-"})`));
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
		} catch (err) {
			process.stderr.write(`runner: finalization failed: ${String(err)}\n`);
		}
	};

	/**
	 * A stop, from the ledger or a signal: acceptance persisted first, then abort and end (decision 14). A stop after the
	 * runner decided the outcome (and enqueued its death) is accepted and recorded, and the decided outcome stands (D3).
	 */
	const stop = (ref: string, reason: string): void => {
		if (outcome === "stop" || finished) return;
		try {
			record(laneStopAcceptedBody(laneId, ref));
		} catch (err) {
			process.stderr.write(`runner: the stop acceptance could not be written: ${String(err)}\n`);
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
				releasedOpen: releasedOpen(controlEntries(entries, holders), laneId),
				receipt: doneBecause(entries, holders) !== null,
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
				} else if (c?.kind === "idle") sendPrompt(idlePrompt(wl, SETTLE_IDLE, idleContinues, IDLE_LIMIT));
				else sendPrompt(continuePrompt(wl, input, continues, CONTINUE_LIMIT));
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
		{
			const { workload: cur, control } = controlNow();
			const ceiling = effectiveCeiling(control, ledger.instructions(wl), cur?.stakes ?? w.stakes);
			const remainingWallMin = Math.max(0, ceiling.wallMin - wallMinutes(control, Date.now(), null));
			const envMs = process.env[LANE_MAX_TIME_ENV]?.trim() ? maxTimeMs(maxTime) : null;
			const shorter = envMs !== null && envMs < (maxTimeMs(ceilingMaxTime(remainingWallMin)) ?? Number.MAX_SAFE_INTEGER);
			// Jo's named model and the session, read fresh at this spawn; a session recorded on another model is not resumed (item 85).
			const start = resumeOf(ledger, w, laneId);
			model = start.model;
			resumeSkipped = start.skipped;
			if (resumeSkipped !== null) process.stderr.write(`runner: ${laneId} starts a fresh session on ${model ?? "the profile default"}: ${resumeSkipped}\n`);
			if (room.note !== null) process.stderr.write(`runner: ${laneId} quota guard open: ${room.note}\n`);
			// PLAN wl-mv71x5rwdu7eo0 § 4: Jo's named model projected out of quota is refused before any omp, never replaced; the
			// catch below finalizes it as the runner (`failAfterReserve` by lane-runner).
			const out = model === null ? null : room.outFor(model);
			if (out !== null) throw new Fail(HEADROOM_STAGE, `named ${model}, ${out}`, STARTER_EXIT["not-launchable"]!);
			argv = laneArgv({
				worktree: p.worktree, sessionDir: p.sessionDir, systemPromptPath: p.systemPromptPath, maxTime, resume: start.resume, model,
				remainingWallMin: shorter ? null : remainingWallMin,
			});
			maxTime = argv[argv.indexOf("--max-time") + 1]!;
			deadlineAt = spawnedAt + (maxTimeMs(maxTime) ?? Number.MAX_SAFE_INTEGER);
		}
		const ordinal = (/-(\d+)$/.exec(laneId) ?? [])[1] ?? "0";
		const frames = join(p.dir, `lane-${ordinal}.jsonl`);
		const { env, notes } = laneSpawnEnv(process.env, profileConfig(), { workloadId: wl, laneId });
		env.OMP_PROFILE = PROFILE;
		for (const n of notes) process.stderr.write(`runner: ${laneId} tracing: ${n}\n`);
		/**
		 * The spawn and its lane-started: record are one ledger write, after the run lock is read as this runner's inside it
		 * (`startAsOwner`; openai review r3): a lock removed before this point, with the lane dir or alone, ends the run here
		 * with exit 7 and no omp, and this runner records and releases nothing, since a runner that took the vacant lock may
		 * own the lane id now. A busy-retried write runs the body again: the spawn happens once, the record is rewritten.
		 * The record's one ps call (omp's start time) is bounded (`runPs`, review r4), so the write holds the ledger's lock for
		 * at most PS_TIMEOUT_MS past the spawn; a ps past it rolls the write back and the run fails with omp killed (`startRecord`).
		 * Known limitation (moonshot review r3 minor 3): a SIGKILL of this runner after the spawn and before the write commits
		 * rolls the record back and leaves a live omp with no lane-started:, so the next runner cannot see it; its stdin pipe
		 * closes with this runner, which is the only end it gets.
		 */
		const omp = startAsOwner(ledger, lock, () => {
			if (child === null) {
				runStart = Date.now();
				child = spawn(["omp", ...argv], { cwd: p.worktree, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
			}
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
		send({ id: STATE_ID, type: "get_state" });

		// Readiness (B1): the lane's own claim, stamped with its id, within the pre-claim lease; no renewal before it. Every lane also
		// waits for OMP's first get_state (PLAN wl-mv71x5rwdu7eo0 § 4): a named model must be exactly that provider/id (item 85), and an
		// unnamed lane on a lab projected out of quota is moved first (`moveOff`). Ready means the claim, the model, the lane-ready:
		// receipt and the prompt all landed; a failure in any of them is fatal (review 2, R2).
		const readyPoll = setInterval(() => {
			if (ready || finished || outcome !== null || fatal !== null) return;
			try {
				const cur = ledger.workload(wl);
				const claimed = cur !== null && cur.holder === laneId && cur.changed_by === laneId;
				if (claimed && modelChecked) {
					clearInterval(readyPoll);
					const { workload: latest, control } = controlNow();
					const stakes = latest?.stakes ?? w.stakes;
					// A relaunch already at or past the ceiling stops here, before lane-ready: and before the first prompt spends a model turn past it.
					if (meter(stakes, control)) {
						ready = true;
						return;
					}
					const ceilingLine = ceilingPromptLine(effectiveCeiling(control, ledger.instructions(wl), stakes), measure(control));
					const prompt = promptFor(ledger, w, laneId, p, ceilingLine);
					// lane-ready: immediately before the first prompt (item 85): a runner lane that ended without one never got a prompt (builderLabs).
					record(laneReadyBody(laneId, ledger.now()));
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
		 * PLAN wl-mv71x5rwdu7eo0 § 4: an unnamed lane whose first get_state model `from` is projected out (`reason`) moves, before its
		 * first prompt, to the first entry of the installed profile's strong row (`:level` dropped) that is not out, in row order:
		 * `set_model`, then a get_state that must report it (omp://rpc.md § Model: `{ type: "set_model", provider, modelId }`).
		 * An unreadable tier table or a row with every entry out is never-ready at stage `headroom`.
		 */
		const moveOff = (from: string, reason: string): void => {
			let row: string[];
			try {
				row = loadTierTable(join(profileAgentDir(), "config.yml")).strong.map(modelIdentity);
			} catch (err) {
				failModel(`${from} is out (${reason}); the strong row could not be read: ${oneLine(err)}`, HEADROOM_STAGE);
				return;
			}
			const to = row.find((s) => room.outFor(s) === null);
			if (to === undefined) {
				failModel(`${from} is out (${reason}); every strong-row entry is out: ${row.map((s) => `${s} (${room.outFor(s)})`).join("; ")}`, HEADROOM_STAGE);
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
			try {
				const { workload: cur, control } = controlNow();
				const req = pendingStop(control, laneId);
				if (req) stop(req.entryId, req.reason);
				// The runner's own deadline (D1): an idle session with a live background job is past omp's --max-time reach.
				if (ready && outcome === null && Date.now() >= deadlineAt) {
					send({ id: "abort", type: "abort" });
					conclude("deadline", laneDiedDeadlineBody(laneId, maxTime, inFlightNow()));
				}
				if (ready && outcome === null) meter(cur?.stakes ?? w.stakes, control);
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
				// Renew the lease while ready and alive (the lane row renews too; this covers a lane whose timer stalled).
				if (ready && outcome === null && cur && cur.holder === laneId) {
					const n = Number(process.env[LEASE_MS_ENV]);
					ledger.claimWorkload(wl, { by: LANE_RUNNER_BY, holder: laneId, leaseMs: Number.isFinite(n) && n > 0 ? n : LEASE_MS });
				}
			} catch (err) {
				process.stderr.write(`runner: stop poll failed: ${String(err)}\n`);
			}
		}, STOP_POLL_MS);
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
				// an unnamed lane's is checked against the quota signal (PLAN wl-mv71x5rwdu7eo0 § 4): not out, or no model reported, is ready.
				if (o.type === "response" && o.id === STATE_ID && !stateSeen) {
					stateSeen = true;
					ranModel = stateModelOf(o);
					rerecord = ranModel !== null;
					if (model !== null) {
						const check = stateModelCheck(model, o);
						if (check.ok) modelChecked = true;
						else failModel(check.reason);
					} else {
						const out = ranModel === null ? null : room.outFor(ranModel);
						if (out === null) modelChecked = true;
						else moveOff(ranModel!, out);
					}
				}
				// The move's set_model answer: on success, ask OMP which model it now runs; a refusal fails the launch at `headroom`.
				if (o.type === "response" && o.id === SET_MODEL_ID && move !== null && outcome === null) {
					if (o.success === false) failModel(`set_model ${move.to} failed: ${typeof o.error === "string" ? oneLine(o.error) : "no error given"}`, HEADROOM_STAGE);
					else send({ id: MOVED_STATE_ID, type: "get_state" });
				}
				// The move holds only once get_state reports the target: then lane-headroom: is recorded, ranModel names it, and ready may follow.
				if (o.type === "response" && o.id === MOVED_STATE_ID && move !== null && !modelChecked && outcome === null) {
					const now = stateModelOf(o);
					if (now === move.to) {
						record(laneHeadroomBody(laneId, move.from, move.to, move.reason));
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
						if (settled) decideTurn();
						else awaitSettle();
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
		const code = await omp.exited;
		if (fatal !== null) throw fatal;
		finish(code, omp.signalCode ?? null);
	} catch (err) {
		const f = err instanceof Fail ? err : new Fail("run", String(err), STARTER_EXIT.unknown!);
		process.stderr.write(`runner: ${f.stage}: ${f.message}\n`);
		for (const t of timers) clearTimeout(t);
		if (child === null) {
			// Before the spawn: a launch failure (decision 9), in the starter's shape; finalization has nothing to reap. A lost
			// run lock writes nothing: the lane id may be another runner's now. The runner's own quota refusal of Jo's named model
			// (PLAN wl-mv71x5rwdu7eo0 § 4) is written as the runner.
			finished = true;
			if (!lostLock) failAfterReserve(ledger, wl, laneId, f, lock, f.stage === HEADROOM_STAGE ? LANE_RUNNER_BY : LANE_STARTER_BY);
			return f.code;
		}
		child.kill("SIGKILL");
		const code = await child.exited;
		if (!ready) readinessFailure = `${f.stage} failed: ${f.message}`;
		outcome ??= ready ? "died" : "never-ready";
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
		const { model, resume, skipped } = resumeOf(ledger, w, laneId);
		ledger.write(() => {
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: worktreeBody(p.worktree) });
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: branchBody(p.branch, p.base) });
		});
		const argv = interactiveArgv({ worktree: p.worktree, sessionDir: p.sessionDir, systemPromptPath: p.systemPromptPath, model, resume });
		const { env, notes } = laneSpawnEnv(process.env, profileConfig(), { workloadId: wl, laneId });
		env.OMP_PROFILE = PROFILE;
		for (const n of notes) process.stderr.write(`lane: tracing: ${n}\n`);
		line(`lane ${laneId} on ${wl} in ${p.worktree} (branch ${p.branch}); first prompt copied to ${join(p.dir, "prompt.md")}`);
		if (skipped !== null) line(`a fresh session on ${model ?? "the profile default"}: ${skipped}`);
		// Interactive lanes are not metered (DESIGN-workload-ceiling.md § 2, "Not covered"): no ceiling line.
		writeFileSync(join(p.dir, "prompt.md"), promptFor(ledger, w, laneId, p, null));
		// The TUI's ^C belongs to omp (a foreground process group signal reaches both); this wrapper waits for the exit.
		process.on("SIGINT", () => undefined);
		// The session files already here belong to earlier lanes: the one this OMP creates is the one not in this snapshot.
		const preexisting = topLevelSessions(p.sessionDir);
		const child = spawn(["omp", ...argv], { cwd: p.worktree, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		omp = child;
		// The lane's identity is OMP's process, not this wrapper's (Codex review B5): `lane.ts stop` compares this pid and start time.
		// The start time is read once, at the first record while omp runs, and reused, as `ompStart` in `cmdRun`: the session
		// re-record after omp exits runs no ps, so a ps failing there cannot end in the catch, which would record launch-failed:
		// for a lane that ran and drop its lane-exit: (openai review r5).
		let ompStart: string | null = null;
		const as2 = readAs2Provenance();
		const record = (session: string | null): void => {
			ompStart ??= startTime(child.pid) ?? "";
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(laneId, { pid: child.pid, start: ompStart, session, argv, runnerPid: process.pid, model, resumeSkipped: skipped }, as2) });
		};
		record(resume);
		const code = await child.exited;
		// The session OMP wrote: a new top-level file, never one that existed before the spawn; a resumed lane appends to its
		// resume path, which it already recorded, so it finds no new file.
		const session = newLaneSession(p.sessionDir, preexisting);
		if (session !== null && session !== resume) record(session);
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
