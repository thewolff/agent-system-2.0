/**
 * agent-system 2.0 pre-dispatch classifier (SPEC-2.0.md § A1.3; build question 1, DESIGN-2.0.md § D6).
 *
 * Per lane `task` call: brief → classifier → kind → tier → cap, then at spawn → model.
 *   1. `tool_call` on `task`: for each item whose `agent` names a dispatchable tier file, check the
 *      item names its ledger slice (`name: sl-…`, a slice of the brief's `workload:`; a `slice:` line
 *      and the session's bound workload, when present, must agree — SPEC-2.0.md § B9), reserve the
 *      slice, classify it, compute the tier (0.55 higher-of-top-two rule, stakes cap), and revise the
 *      call's input so the item's `agent` is the computed tier file (omp://extensions.md § Tool
 *      lifecycle). The slices are reserved before the judge is asked, so a second call on one of
 *      them is refused without a judge call; every classification of the call is published at
 *      once, only after all of them succeed.
 *   2. `before_subagent_spawn`: the model row comes from the tier the event carries (`agent`, the
 *      rewritten name) — never from which classification arrived first. The event's `spawnKey`
 *      (omp://extensions.md:378: "an optional stable `spawnKey`") is the item's `name` as written
 *      for a blocking spawn, or the allocated agent id — the name with an optional `<parent>.` prefix
 *      and `-N` collision suffix — for an async one (task/index.ts:854 and :1501,
 *      task/output-manager.ts #allocateUnique, task/structured-subagent.ts applySpawnHook); it finds
 *      the classification for the ledger record only. The event carries no per-dispatch identity,
 *      so step 1 refuses a dispatch whose slice id OMP would rewrite as an agent id, or whose spawn
 *      keys could coincide with a slice still waiting to spawn: every key then names one slice.
 *      The returned list is the row's candidates that are in the registry, on an enabled provider,
 *      and credentialed both session-free and for the spawn key, in row order: OMP's final
 *      selection (config/model-resolver.ts resolveModelOverrideWithAuthFallback, asked with the
 *      agent id) then meets a usable primary and has no reason to fall back to the parent's model.
 *      No usable candidate refuses.
 *   3. The hand's own session: this factory's instance there sees every assistant `message_end`
 *      (awaited, and drained by the session's `waitForIdle` before the hand's result exists:
 *      session/agent-session.ts #processAgentEvent, #emitSessionEvent, waitForIdle) and records the
 *      `provider/model` that answered on the hand, under the hand's session file path. Not
 *      `agent_end`: OMP fires the extension `agent_end` fire-and-forget
 *      (`void this.#emitAgentEndNotification`), so it is not ordered before the result, and it
 *      cannot withhold anything.
 *   4. Where the hand's output reaches the lane, every model that answered is checked against the
 *      tier row (one verdict per hand, `settle`): a blocking hand's `task` `tool_result` (plus the
 *      model the result reports); an async hand's `async-result` delivery, which reaches the lane's
 *      model only through the per-request `context` event (sdk.ts transformContext); and a job
 *      snapshot that shows an async hand's result in another tool's result — a `wait`, a
 *      `proc://<id>/kill` write, a `read proc://<id>` (PLAN wl-muq13bkdghblmo step 2). A hand
 *      that ran off its row, or whose models could not be read, has its output replaced by a
 *      refusal there. A hand whose every turn ended on a provider error is a failed dispatch: its
 *      output is withheld, its review round does not count, and a 401 / 403 writes
 *      `provider-refused:`, which keeps later spawns of the workload off that provider until the
 *      surface writes `provider-ok:`. The verdict is the one `routings` row for the dispatch
 *      (ledger/src/index.ts recordRouting, schema v5: `outcome`, `ran_models`, and the hand's
 *      `session_root` + final `agent_id`); a spawn refused for no usable model writes its row at the
 *      refusal. The row is also shown as the spawn's routing note. A delivery this instance cannot
 *      correlate is checked against the one row for exactly its session root and agent id; a tier
 *      hand's output with no such row is withheld (fail closed). A delivery is matched only to a hand
 *      dispatched by its time (its `timestamp`; a recreated instance reads the dispatch time off the
 *      `hand-spawn:` entry), so an earlier job's delivery never settles a newer hand OMP gave the same
 *      agent id. A job snapshot carries no time or root to match by: its entry is tied to a hand only
 *      when this process has run no other hand under that agent id, under any lane root; else it
 *      settles and releases nothing and its shown output is withheld. With no lane session file,
 *      any output a snapshot or a delivery shows is withheld.
 *
 * Hand identity (the contract every step above relies on). A hand's agent session file is
 * `<artifactsDir>/<agentId>.jsonl` (task/executor.ts:3366-3367), and its `artifactsDir` is the lane's
 * session file without `.jsonl` (task/structured-subagent.ts:416-418 leaseArtifacts). So a hand is
 * keyed by that full path: the lane's session root plus the agent id. Two lanes whose OMP output
 * managers each allocate `sl-one` (per-root allocation, astra review 3 B2) key two hands. The ledger
 * row carries the same two facts (`session_root`, `agent_id`: the id OMP finally allocated, which a
 * blocking spawn's key does not carry, task/structured-subagent.ts:658-671 then
 * task/output-manager.ts:84-90), so recovery after a restart matches exactly the hand it settled
 * (astra review 4 B1/S1). OMP never allocates one id twice under one root: its output manager seeds
 * the taken ids from the root's files on resume (task/output-manager.ts:20-22, :55-79).
 *
 * Items naming anything other than a tier file are left untouched for M4's refusal (P-11 row 4);
 * this extension never repairs a bad agent name.
 *
 * Cross-lab review (PLAN wl-mupu0sx2o046io D1–D6, MIGRATION.md follow-up 23; the rule itself is
 * classifier/src/lab.ts). A review dispatch (D2) is routed off the labs that built the workload,
 * read from the ledger at each spawn (D3: `builder-lab:` per lane, `hand-spawn:` / `hand-settled:`
 * per dispatch token, the non-review routings); at production stakes it fans out to one hand per
 * other available lab under a `<slice>--<lab>` dispatch name (D5); with no other lab it parks on a
 * `same-lab` / `wait` question (D6), unless the review loop it was dispatched in has ended since (a
 * stale review never parks). A review hand cannot change the work unseen: its editing tools
 * are refused, and a repository fingerprint (classifier/src/fingerprint.ts) taken at its spawn and
 * its settle withholds its output when they differ (`review-withheld:`), which `recover()` honours.
 *
 * Review round limit and stop (PLAN wl-mupu0sx2o046io D9/D10, MIGRATION.md follow-up 33; the pure
 * half is classifier/src/rounds.ts and classifier/src/review-stop.ts). Every review item's brief
 * gains the fixed `review-findings` paragraph. A production fan-out's whole membership is written
 * (`review-group:`) when its call is published, before any member spawns. Where a review hand
 * settles, its last findings block is parsed and `review-round:` is written with its verdict
 * (fan-out members refused at spawn, stopped at spawn, or dropped unspawned get one too; a listed
 * member that never spawned in a group this process does not hold is recorded dropped, and a late
 * spawn of it by another live instance is then refused; a member that spawned, has no verdict, and
 * whose spawning lane has a `lane-exit:` after its spawn is recorded withheld with unknown findings,
 * since its result died with that `omp` process). When a round is
 * complete — every member terminal, read from the ledger so it holds across a restart — a passing
 * round ends the loop (`review-loop-end: … pass`), and a failing round that reaches the limit raises
 * one extend / accept / stop question with its `review-limit:` entry. A group whose spawned members
 * all failed to dispatch is no round. A review dispatch is refused
 * while another round of its slice is still running or still spawning in this process (so every
 * round counts), while that question is open or the loop is at its limit, and on a loop Jo stopped
 * with `stop-reviews`; at spawn the stop, the open question, the end of the loop the review was
 * published in, another running round of the slice and a token already recorded terminal are checked
 * again in the transaction that writes `hand-spawn:`. A stopped
 * loop's running round still settles, ends the loop (`review-loop-end: … stop-reviews`) and
 * enqueues one orchestrator message with its findings.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LANE_ENV, WORKLOAD_ENV } from "../gates/src/types";
import { type HostModules, hostSettings, readSetting } from "../gates/src/host";
import { type EntryRow, Ledger, type QuestionRow, type RoutingOutcome, type Stakes } from "../ledger/src/index";
import { defaultLedgerPath } from "../ledger/src/locality";
import { briefField, briefSlice, briefStakes } from "./src/brief";
import {
	type Calibration,
	classify,
	type KindJudge,
	type KindQuestion,
	loadCalibration,
	loadKindQuestion,
	questionSha256,
} from "./src/classify";
import { repoFingerprint } from "./src/fingerprint";
import {
	type Builders,
	builderLabs,
	handBuilderBody,
	handSettledBody,
	handSpawnBody,
	handSpawns,
	isReviewDispatch,
	type Lab,
	labOf,
	laneBuilderBody,
	openParkQuestion,
	PARK_OPTIONS,
	parkQuestionBody,
	parseHandSpawn,
	reviewParkBody,
	type ReviewPlan,
	reviewPlan,
	reviewSameLabBody,
	reviewWithheldBody,
	settledTokens,
	spentGrants,
	tokenOfRouting,
	unspentGrant,
	withheldTokens,
} from "./src/lab";
import type { RoutingLedger } from "./src/ledger-port";
import { reviewStopOn } from "./src/review-stop";
import {
	countRounds,
	effectiveRoundLimit,
	FINDING_KINDS,
	type Findings,
	type FindingsOrUnknown,
	parseFindings,
	parseReviewRound,
	parseReviewLimit,
	parseReviewGroup,
	parseReviewLoopEnd,
	type Round,
	reviewGroupBody,
	reviewLimitBody,
	reviewLoop,
	reviewLoopEndBody,
	reviewRoundBody,
	type ReviewVerdict,
	ROUND_LIMIT_OPTIONS,
	roundLimitQuestionBody,
	SEVERITIES,
	severityLine,
	UNKNOWN,
} from "./src/rounds";
import { isTier, route, STAKES, type Routing, type Tier } from "./src/route";
import { identity, loadTierTable, modelIdentity, type TierTable } from "./src/tier-table";
import { heldLabs } from "../surface/src/lab-budget-io";
import { controlEntries } from "../surface/src/launch";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../surface/src/types";

/** The slice of OMP's model registry the spawn check reads (config/model-registry.ts). */
export interface ModelAvailability {
	getAvailable(): readonly { provider: string; id: string }[];
	/** `sessionId` selects a session-sticky account, as OMP's final selection passes the agent id. */
	getApiKey(model: { provider: string; id: string }, sessionId?: string): Promise<string | undefined>;
}

export interface ClassifierDeps {
	/** The judge for this session: OMP's `judge` role in production. */
	judge(ctx: ExtensionContext): Promise<KindJudge>;
	/** The profile's tier→model table; throws when the profile's table is invalid. */
	tierTable(): TierTable;
	/** OMP's `disabledProviders` setting: final selection drops these providers before matching. */
	disabledProviders(ctx: ExtensionContext): Promise<readonly string[]>;
	question: KindQuestion;
	/** The question and judge the 0.55 threshold was measured with (classifier/calibration.json). */
	calibration: Calibration;
	/** The ledger the routing rows land in; opened lazily in production. */
	ledger(): RoutingLedger;
	/**
	 * The labs over their budget (surface/src/lab-budget-io.ts `heldLabs`, MIGRATION.md item 113), each with the reason a
	 * dispatch on it is refused: their entries are skipped like a refused login, so a review needing one parks. None when absent.
	 */
	labHolds?(): ReadonlyMap<string, string>;
	/** `created_by` on routing rows: this lane's id. */
	laneId: string;
	/** The workload this session is bound to (`AGENT_SYSTEM_WORKLOAD_ID`, gates/src/types.ts), if any. */
	boundWorkload(): string | undefined;
	/** One-line diagnostics; the session's extension logger when absent. */
	log?(line: string): void;
	/**
	 * The read-only repository fingerprint a review hand is checked against at spawn and settle
	 * (classifier/src/fingerprint.ts `repoFingerprint` when absent). Throws when it cannot be taken.
	 */
	fingerprint?(cwd: string): string;
}

/** One classified tier item, waiting for its spawn. */
interface Pending {
	toolCallId: string;
	/** The item's position in the (rewritten) call: `index` on OMP's per-member progress (task/index.ts:850-862). */
	index: number;
	/** The ledger slice the dispatch works on: the `routings.slice_id`. */
	sliceId: string;
	/**
	 * The item's `name` as rewritten, the base of its spawn key: the slice id, or `<slice>--<lab>` for a
	 * production review fan-out member (D5). Everything that matches a spawn key or an agent id keys on it.
	 */
	dispatchName: string;
	workloadId: string;
	routing: Routing & { probabilities: Record<string, number>; judgeModel: string };
	/** The agent id OMP allocated to an async member, once its call's result reports it (`progress[].id`). */
	agentId?: string;
	/** This dispatch's unique token (`dt-…`, D3): links its `hand-spawn:` entry to its `hand-settled:` one. */
	token: string;
	/** Its dispatch group (`dg-…` one hand, `fg-…` a production fan-out): one review round (D9). */
	group: string;
	/** A review dispatch (D2). */
	review: boolean;
	/** A fan-out member's lab: its spawn row is that lab's entries only. */
	lab: Lab | null;
	/** A note for the spawn's routing note (a short fan-out, D5). */
	note: string | null;
	/**
	 * A review's loop (D9, `reviewLoop`): its slice's `review-loop-end:` count when the call was
	 * published, read in the transaction that writes a fan-out's `review-group:`. Null for other work.
	 */
	loop: number | null;
	/**
	 * When the call was published (ms since the epoch). Output delivered before it belongs to an earlier
	 * hand that OMP may have given the same agent id (a resumed lane session keeps its old deliveries),
	 * so it never settles, withholds or releases this one (PLAN wl-muq13bkdghblmo step 12).
	 */
	dispatchedAt: number;
}

/** A classification in flight: its reservations, and whether its answer may still be published. */
interface Attempt {
	toolCallId: string;
	/** Cleared when the turn ends with the attempt still awaiting (the runner stopped waiting for it). */
	live: boolean;
	abort: AbortController;
	reservations: { sliceId: string; toolCallId: string }[];
}

/** One member of a `task` call's `details.progress` (task/index.ts:858-877): its item, its allocated id, its state. */
type MemberProgress = { index?: number; id?: string; status?: string };

/**
 * A background job as a job-control snapshot reports it (async/job-control.ts:198-215 snapshotJobs):
 * the `wait` tool's `details.jobs` (`details.op` `wait`, tools/wait.ts:153), the jobs listing's (op
 * `jobs`), a `proc://<id>/kill` write's `details.proc.jobs` (`details.proc.op` `cancel`,
 * internal-urls/proc-protocol.ts:177-184, tools/write.ts:1317), the `read proc://` listing's
 * `details.proc.jobs` (no `op`), and a `read proc://<id>`'s `details.proc.job` with the job's output
 * in `details.proc.log` (proc-protocol.ts:141-155). A task job's label is its agent id. `resultText`
 * / `errorText` are present only while the result is not consumed (job-control.ts:210-215); the
 * `wait` and the kill write show them and consume them (:246, :277-294), so no `async-result`
 * delivery follows for that job.
 */
type JobSnapshot = { type?: string; status?: string; label?: string; resultText?: string; errorText?: string };

/** A tool result's `details` as far as a job snapshot shows in it (JobSnapshot). */
type SnapshotDetails = { op?: string; jobs?: unknown; proc?: { op?: string; jobs?: unknown; job?: JobSnapshot; log?: unknown } };

/** One assistant turn of a hand that ended on a provider error (`stopReason: "error"`, pi-ai src/types.ts AssistantMessage). */
type FailedTurn = { model: string; provider: string; status: number | null; error: string | null };

/** A tier hand past its spawn check, waiting for the verdict on the models that answered on it. */
interface Hand extends Pending {
	/** The lane's artifacts directory: the hand's session file is `<root>/<agentId>.jsonl`. */
	root: string;
	/** The spawn event's key: the agent id for an async spawn, the item name for a blocking one. */
	spawnKey: string | null;
	tier: Tier;
	/** The row's candidates usable at spawn, row order: what the spawn was constrained to. */
	models: string[];
	/**
	 * The allowlist for what answered, as `provider/id` identities: the tier row at spawn, or for a
	 * review the row filtered to the labs outside the builders (D4), plus the builder's entries when a
	 * same-lab grant was spent (D6).
	 */
	row: string[];
	/** The lane's working directory at spawn: the repository a review's fingerprint covers. */
	cwd: string;
	/** A review's spawn-time fingerprint, or why it could not be taken; null for a non-review hand. */
	before: { digest: string } | { error: string } | null;
}

/**
 * A production review fan-out (D5 [N2]) as this process holds it: every member's token, and the
 * terminal state of each member that ended here. A member with no terminal state is pending or
 * running. Membership is also durable: the whole group on its `review-group:` entry (written before
 * any member spawns) and each spawned member on its `hand-spawn:` entry (`group <id>`), so the
 * accounting is re-read from the ledger after a restart.
 */
interface FanOut {
	group: string;
	workloadId: string;
	sliceId: string;
	tokens: string[];
	ended: Map<string, string>;
	/** Members that reached a spawn (refused there or spawned): an all-dropped group never parks. */
	reached: Set<string>;
	/** Its members' loop (`Pending.loop`): once the slice's loop has moved on, the group never parks. */
	loop: number | null;
}

/** A park (D6): its question and whether this call raised it; null when the review's loop had ended, so nothing parked. */
type Parked = { questionId: string; raised: boolean } | null;

/** A settled hand: its `routings` outcome, and why its output is withheld when it is. */
interface Verdict {
	outcome: RoutingOutcome;
	refusal: string | null;
}

/**
 * A verdict and when the hand it belongs to was dispatched (ms; from the ledger, its `hand-spawn:`
 * entry's time): it answers only output delivered since (PLAN wl-muq13bkdghblmo step 12). `here`:
 * the hand ran in this process (`settle`), so its job lived in this process's job manager; false for
 * a verdict read off the ledger (`recover`), whose hand ran in an earlier process.
 */
type Settled = { since: number; verdict: Verdict; here: boolean };

/** A task tool result entry, as task/index.ts and task/executor.ts report it. */
type TaskResult = { id?: string; agent?: string; resolvedModelIdentity?: string; resolvedModel?: string; output?: string };

/**
 * A `task` tool result's `details` (TaskToolDetails, pi-tui/src/tools/task.ts:2012-2025): `async`
 * is present only on a call that returned with background jobs, and then it is an object
 * `{ state, jobId, type: "task" }` (task/index.ts:905-908), never a boolean.
 */
type TaskDetails = { async?: unknown; results?: TaskResult[]; progress?: MemberProgress[] };

/**
 * One job of an `async-result` delivery (session/async-job-delivery.ts:119-126). `jobId` is the job
 * manager's id, which it suffixes on a collision (async/job-manager.ts:338 #resolveJobId), so it is
 * not the hand's agent id. `label` is: a task job is registered with the agent id as its label
 * (task/index.ts:1110-1112 `manager.register("task", agentId, …)`; async/job-manager.ts:351).
 */
type DeliveredJob = { jobId?: string; type?: string; label?: string };

type TaskItem = { agent?: string; name?: string; task?: string; [key: string]: unknown };
type TaskInput = TaskItem & { tasks?: TaskItem[]; context?: string };

const refuse = (reason: string) => ({ block: true as const, reason });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Does `spawnKey` name the agent OMP allocated for `name`: `[<parent>.]name[-N]`? */
function spawnKeyNames(spawnKey: string, name: string): boolean {
	return new RegExp(`^(?:.+\\.)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-\\d+)?$`).test(spawnKey);
}

/**
 * The names OMP keeps as agent ids unchanged: task/structured-subagent.ts sanitizeAgentId strips
 * everything outside `[A-Za-z0-9_-]` and cuts at 48 characters. With no dot in the name, the
 * `<parent>.` prefix in a spawn key is unambiguous.
 */
const OMP_AGENT_ID = /^[A-Za-z0-9_-]{1,48}$/;

/**
 * The lane's artifacts directory, where OMP writes its hands' session files (session/session-manager.ts
 * artifactsDirectoryFor: the session file without `.jsonl`). `null` for a session with no file.
 */
function laneRoot(ctx: ExtensionContext): string | null {
	const file = ctx.sessionManager.getSessionFile();
	return file?.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : null;
}

/** A hand's key: its own session file (task/executor.ts:3366-3367 `<artifactsDir>/<id>.jsonl`). */
const handKey = (root: string, agentId: string) => join(root, `${agentId}.jsonl`);

/**
 * Could one spawn key name both slices? For valid agent ids the key sets are `[p.]a[-N]` and
 * `[p.]b[-N]`; they meet exactly when one name is the other or the other plus `-N`.
 */
function spawnKeysOverlap(a: string, b: string): boolean {
	return spawnKeyNames(a, b) || spawnKeyNames(b, a);
}

/** The first earlier slice whose spawn keys could coincide with `sliceId`'s, and how to say so. */
function spawnKeyConflict(sliceId: string, earlier: readonly { sliceId: string; where: string }[], pendingWord: string): string | null {
	for (const other of earlier) {
		if (other.sliceId === sliceId) {
			return pendingWord
				? `slice ${sliceId} already has a classified dispatch waiting to spawn (${other.where}); dispatch it again after that spawn, or after that call fails`
				: `slice ${sliceId} is named twice in this call (${other.where})`;
		}
		if (spawnKeysOverlap(sliceId, other.sliceId)) {
			return `slice ${sliceId} could share a spawn key with ${pendingWord}slice ${other.sliceId} (${other.where}); OMP suffixes a reused name with -N, so the spawn could not be told apart`;
		}
	}
	return null;
}

/** The model a settled task result reports, as a `provider/id` identity. */
function reportedModel(result: TaskResult): string | null {
	const reported = result.resolvedModelIdentity ?? result.resolvedModel;
	return reported ? identity(reported) : null;
}

function withheld(what: string, drift: readonly string[]): string {
	return `agent-system-2 classifier refused this ${what}: ${drift.join("; ")}. The output is withheld: a tier hand runs only on its tier's row (DESIGN-2.0.md P-11 row 15). Re-dispatch the slice once a row model is usable.`;
}

function routingNote(routing: Pending["routing"] | null, tier: Tier, models: string[], skipped: string[], extra: readonly string[] = []): string {
	const parts = routing ? [`${routing.kind} ${routing.confidence.toFixed(2)} → ${routing.classifiedTier}`] : [`tier ${tier} (unclassified)`];
	if (routing?.pullUp) parts.push(`pulled up to ${routing.pullUp.to} (below 0.55; top two ${routing.topTwo.join("/")})`);
	if (routing?.pullDown) parts.push(`capped to ${routing.pullDown.to} (stakes ${routing.stakes})`);
	parts.push(`${models[0]}${models.length > 1 ? ` (+${models.length - 1} same-tier fallback)` : ""}`);
	if (skipped.length > 0) parts.push(`skipped ${skipped.join(", ")}`);
	parts.push(...extra);
	return parts.join("; ");
}

/**
 * DESIGN-2.0.md P-11 row 15 / SPEC-2.0.md § B11: the row's entries OMP's final selection will keep —
 * in the registry, on an enabled provider, credentialed session-free and (given a spawn key) for it,
 * on a provider that has not refused the login on the workload (`refused`, `refusedProviders`), and
 * on no lab over its budget (`labHolds`) — in row order, and why each other entry was skipped.
 */
async function usableRow(
	row: readonly string[],
	registry: ModelAvailability,
	disabled: ReadonlySet<string>,
	refused: ReadonlyMap<string, string>,
	labHolds: ReadonlyMap<string, string>,
	spawnKey: string | null,
) {
	const available = registry.getAvailable();
	const usable: string[] = [];
	const why: Record<string, string> = {};
	for (const selector of row) {
		const model = available.find(m => `${m.provider}/${m.id}` === modelIdentity(selector));
		if (!model) why[selector] = "not in the model registry";
		else if (disabled.has(model.provider)) why[selector] = "provider disabled";
		else if (refused.has(model.provider)) why[selector] = `its provider refused the login on ${refused.get(model.provider)}`;
		else if (labHolds.has(labOf(model.provider) ?? "")) why[selector] = labHolds.get(labOf(model.provider)!)!;
		else if (!(await registry.getApiKey(model))) why[selector] = "no credentials";
		else if (spawnKey && !(await registry.getApiKey(model, spawnKey))) why[selector] = `no credentials for spawn ${spawnKey}`;
		else usable.push(selector);
	}
	return { usable, why, skipped: Object.entries(why).map(([selector, reason]) => `${selector} (${reason})`) };
}

/** A failed dispatch's login refusal (HTTP 401 / 403) by `provider`, on the hand of token `dt` (PLAN wl-muq13bkdghblmo step 9). */
const providerRefusedBody = (provider: string, status: number, token: string) => `provider-refused: ${provider} status ${status} token ${token}`;
const PROVIDER_REFUSED = /^provider-refused:\s+(\S+)\s+status\s+(\d+)\s+token\s+(\S+)$/;
/** `provider-ok: <provider> by <instruction>`: Jo's word re-enables a refused provider; only the surface writes it. */
const PROVIDER_OK = /^provider-ok:\s+(\S+)\s+by\s+(\S+)$/;

/**
 * The providers that refused the login on a workload (`provider-refused:`, written at a failed
 * dispatch's 401 / 403) with no `provider-ok:` from the surface since, each with the token it refused
 * on. A refused OAuth login does not fix itself, so the refusal lasts until Jo's word; a
 * `provider-ok:` from any other writer is ignored. `entries` are the workload's, oldest first.
 */
function refusedProviders(entries: readonly Pick<EntryRow, "kind" | "body" | "created_by">[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const body = e.body.trim();
		const refused = PROVIDER_REFUSED.exec(body);
		if (refused) out.set(refused[1]!, refused[3]!);
		const ok = e.created_by === SURFACE_BY ? PROVIDER_OK.exec(body) : null;
		if (ok) out.delete(ok[1]!);
	}
	return out;
}

/** D2 check 1: the tools that change files. A review hand's own session may not call them. */
const EDITING_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, notebook: true };

/** A dispatch token (`dt-…`) or group id (`dg-…` one hand, `fg-…` a fan-out): unique per process and across restarts. */
const newToken = (prefix: "dt" | "dg" | "fg") => `${prefix}-${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** D5 [R6]: a review's effective stakes, the higher of the brief's and the workload row's. */
function effectiveStakes(brief: Stakes | null, workload: Stakes | null): Stakes | null {
	if (brief === null) return workload;
	if (workload === null) return brief;
	return STAKES.indexOf(workload) > STAKES.indexOf(brief) ? workload : brief;
}

/**
 * D9: the fixed paragraph appended to every review item's brief. Its first line names no § B9 field
 * (gates/src/rows/r05-brief-fields.ts reads the first occurrence of each), so row 5 reads the brief
 * as before.
 */
export const REVIEW_FINDINGS_PARAGRAPH = [
	"",
	"",
	"Findings block (agent-system 2.0 review round limit): end your final report with one fenced code block whose info string is review-findings, holding JSON",
	'{"findings":[{"severity":"blocking|major|minor","kind":"correctness|security|tests|design|docs|other","title":"…"}]}',
	"with one entry per finding you report and an empty list when there is none. Only the last such block is read; a missing or malformed block fails the review round.",
].join("\n");

/** A review item's brief with the findings paragraph, appended once. */
function withFindingsParagraph(task: string | undefined): string {
	const text = task ?? "";
	return text.endsWith(REVIEW_FINDINGS_PARAGRAPH) ? text : `${text}${REVIEW_FINDINGS_PARAGRAPH}`;
}

/** Every string value of a JSON document, one per line (a yielded payload carries the report as a string); null when `text` is not JSON. */
function jsonStrings(text: string): string | null {
	let json: unknown;
	try {
		json = JSON.parse(text.trim());
	} catch {
		return null;
	}
	const out: string[] = [];
	const walk = (x: unknown): void => {
		if (typeof x === "string") out.push(x);
		else if (Array.isArray(x)) x.forEach(walk);
		else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk);
	};
	walk(json);
	return out.join("\n");
}

/** D9: the findings in one hand's reply: its last `review-findings` block, read as text or through a yielded JSON payload's strings. */
function findingsIn(text: string | null): FindingsOrUnknown {
	if (!text) return UNKNOWN;
	const direct = parseFindings(text);
	if (direct !== UNKNOWN) return direct;
	const strings = jsonStrings(text);
	return strings === null ? UNKNOWN : parseFindings(strings);
}

/**
 * D9: a review hand's findings, from what was delivered for it; when that carries no readable block
 * (OMP may cut a long result to a preview), from the full output OMP writes before the result exists
 * (`<artifactsDir>/<id>.md`, task/executor.ts finalizeRunResult).
 */
function handFindings(delivered: string | null, root: string, agentId: string): FindingsOrUnknown {
	const f = findingsIn(delivered);
	if (f !== UNKNOWN) return f;
	const file = join(root, `${agentId}.md`);
	try {
		return existsSync(file) ? findingsIn(readFileSync(file, "utf8")) : UNKNOWN;
	} catch {
		return UNKNOWN;
	}
}

/** A message's text: a string, or its text parts joined. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(part => (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

/**
 * One job's part of an `async-result` delivery: the whole text for one job; for several, the section
 * under its `── Job <jobId> (<label>) ──` header up to the next job's (prompts/tools/async-result.md).
 */
function jobSection(text: string, jobs: readonly DeliveredJob[], job: DeliveredJob): string | null {
	if (jobs.length <= 1) return text;
	const header = (j: DeliveredJob) => `── Job ${j.jobId}${j.label ? ` (${j.label})` : ""} ──`;
	const start = text.indexOf(header(job));
	if (start < 0) return null;
	let end = text.length;
	for (const other of jobs) {
		if (other === job) continue;
		const at = text.indexOf(header(other), start + 1);
		if (at > start && at < end) end = at;
	}
	return text.slice(start, end);
}

type InstructionView = Parameters<typeof reviewStopOn>[1][number] & Parameters<typeof effectiveRoundLimit>[1][number];

/**
 * D10: the `stop-reviews` instruction that stops `sliceId`'s review loop, or null. A stop counts when
 * it is newer than the loop's start: the slice's latest `review-loop-end:` for any reason other than
 * `stop-reviews` (a loop ended by the stop itself does not lift it).
 */
function loopStop(entries: readonly EntryRow[], instructions: readonly InstructionView[], workloadId: string, sliceId: string): string | null {
	const start = entries.findLastIndex(e => {
		const end = e.kind === "assumption" ? parseReviewLoopEnd(e.body) : null;
		return end !== null && end.slice === sliceId && end.reason !== "stop-reviews";
	});
	return reviewStopOn(entries.slice(start + 1), instructions, workloadId, sliceId);
}

/** D9: the open round-limit question on `sliceId` (a `review-limit:` entry names it), if any. */
function openLimitQuestion(entries: readonly EntryRow[], questions: readonly Pick<QuestionRow, "id" | "state">[], sliceId: string): string | null {
	const mine = new Set(
		entries.flatMap(e => {
			const l = e.kind === "assumption" ? parseReviewLimit(e.body) : null;
			return l !== null && l.slice === sliceId ? [l.questionId] : [];
		}),
	);
	return questions.find(q => q.state === "open" && mine.has(q.id))?.id ?? null;
}

/**
 * The loop fan-out `group` of `sliceId` was published in (D9): the slice's `review-loop-end:` count
 * before its `review-group:` entry, where `countRounds` places it. Null when no such entry exists.
 */
function groupLoop(entries: readonly EntryRow[], sliceId: string, group: string): number | null {
	const at = entries.findIndex(e => e.kind === "assumption" && parseReviewGroup(e.body)?.group === group);
	return at < 0 ? null : reviewLoop(entries.slice(0, at), sliceId);
}

/** D10: the one orchestrator message for a stopped loop's round that settled after the stop. */
function stoppedRoundMessage(sliceId: string, round: Round, stop: string): string {
	const unknown = round.members.filter(m => m.findings === UNKNOWN).map(m => m.token);
	const rejected = round.members.filter(m => !m.accepted).map(m => `${m.token} (${m.verdict === "accepted" ? "withheld" : m.verdict})`);
	// The members' findings merged: counts summed, titles in member order.
	const merged: Findings = { counts: { blocking: {}, major: {}, minor: {} }, titles: [] };
	for (const m of round.members) {
		if (m.findings === UNKNOWN) continue;
		for (const s of SEVERITIES) {
			for (const k of FINDING_KINDS) {
				const n = m.findings.counts[s][k];
				if (n) merged.counts[s][k] = (merged.counts[s][k] ?? 0) + n;
			}
		}
		merged.titles.push(...m.findings.titles);
	}
	const lines = [
		`Review round ${round.n} of ${sliceId} settled after stop-reviews (${stop}); the review loop of ${sliceId} is ended (review-loop-end: stop-reviews) and no further round starts. The round ${round.passed ? "passed" : "did not pass"}.`,
		`Remaining findings: ${unknown.length === round.members.length ? UNKNOWN : severityLine(merged)}${unknown.length > 0 ? ` · unknown: ${unknown.length} hand${unknown.length === 1 ? "" : "s"} with no readable findings block (${unknown.join(", ")})` : ""}; blocking ${round.blocking ?? UNKNOWN}.`,
	];
	if (rejected.length > 0) lines.push(`Output not accepted: ${rejected.join(", ")}.`);
	for (const s of SEVERITIES) for (const t of merged.titles) if (t.severity === s) lines.push(`- ${t.severity} ${t.kind}: ${t.title}`);
	return lines.join("\n");
}

/** D10: why a review dispatch or spawn on a stopped loop is refused. */
function stoppedLine(sliceId: string, stop: string): string {
	return `reviews of ${sliceId} are stopped by Jo's stop-reviews (instruction ${stop}, review-stop:); no further review round starts on a stopped loop. Report and hold the slice for Jo`;
}

/** D9: why a review dispatch or spawn is refused while the slice's round-limit question is open. */
function limitQuestionLine(sliceId: string, questionId: string): string {
	return `the review of ${sliceId} is at its round limit; question ${questionId} (review-limit:; options extend / accept / stop) is open. Jo answers it; do not re-dispatch the review until then`;
}

/** D9: why a review dispatch or spawn is refused while another round of the slice is still running. */
function runningRoundLine(sliceId: string, running: Round): string {
	return `review round ${running.n} of ${sliceId} is still running (${running.members.filter(m => m.verdict === null).map(m => m.token).join(", ")} not settled); a further round of ${sliceId} starts only after it settles, so every round counts toward the round limit`;
}

/**
 * Why review hand `hand` may not spawn now, read from the ledger, or null when it may. Its token
 * already has a terminal `review-round:` (another instance recorded it dropped): spawning it would run
 * a hand whose findings its round can no longer take (REVIEW-r2). The loop is stopped (D10) or its
 * round-limit question is open (D9). The loop it was published in has ended since (a
 * `review-loop-end:` newer than its publication, REVIEW-r3): its round was checked against that loop
 * and would escape the current one's accounting (`countRounds` keeps a fan-out in the loop its
 * `review-group:` was written in). The current loop has an incomplete round of the slice in another
 * dispatch group: two rounds would run at once (REVIEW-r2; read from `review-group:`, `hand-spawn:`
 * and `review-round:` entries, so it holds across instances). Inside the transaction that writes
 * `hand-spawn:` it decides the spawn atomically.
 */
function reviewHeld(ledger: RoutingLedger, hand: Pending): string | null {
	const entries = ledger.entries(hand.workloadId);
	for (const e of entries) {
		const r = e.kind === "assumption" ? parseReviewRound(e.body) : null;
		if (r?.token === hand.token) {
			return `review hand ${hand.token} (${hand.dispatchName}) of ${hand.sliceId} is already recorded ${r.verdict} in round ${r.round} (review-round:); a late spawn of it would run a hand its round no longer counts`;
		}
	}
	const stop = loopStop(entries, ledger.instructions(hand.workloadId), hand.workloadId, hand.sliceId);
	if (stop) return stoppedLine(hand.sliceId, stop);
	const limitQuestion = openLimitQuestion(entries, ledger.questions(hand.workloadId), hand.sliceId);
	if (limitQuestion) return limitQuestionLine(hand.sliceId, limitQuestion);
	if (hand.loop !== reviewLoop(entries, hand.sliceId)) {
		return `review hand ${hand.token} (${hand.dispatchName}): the review loop of ${hand.sliceId} it was dispatched in has ended since (review-loop-end:), so its round would not count toward the current loop; re-dispatch the review to start a round of the current loop`;
	}
	const running = countRounds(entries, hand.sliceId).rounds.find(r => !r.complete && r.group !== hand.group);
	return running ? runningRoundLine(hand.sliceId, running) : null;
}

export function createClassifierExtension(deps: ClassifierDeps) {
	// SPEC-2.0.md § A1.3 "Measured 2026-09-23": the threshold holds for one question text only.
	const questionProblem =
		questionSha256(deps.question) === deps.calibration.questionSha256
			? null
			: `the classifier question (sha256 ${questionSha256(deps.question).slice(0, 12)}…) is not the question the 0.55 threshold was measured with (${deps.calibration.questionSha256.slice(0, 12)}…); record a new sample and update classifier/calibration.json`;

	// Shared by every session this extension is bound to: the hand's own session records what
	// answered on it, and the lane's session reads that when the hand's output arrives. OMP binds
	// the parent's prepared factories into the child session in the same process
	// (task/executor.ts, preloadedPreparedExtensions), so the child's instance reaches this closure.
	// Every key carries the lane's session root (header, "Hand identity").
	const hands: Hand[] = [];
	/** Every `provider/id` that answered on a hand, first-seen order, by the hand's session file. */
	const answered = new Map<string, string[]>();
	/** Every turn of a hand that ended on a provider error instead of answering, by the hand's session file (step 8). */
	const failedTurns = new Map<string, FailedTurn[]>();
	/**
	 * Every verdict this process reached, by the hand's session file, oldest first: an async delivery
	 * is re-read on every model request. One agent id can name two hands under one root (a resumed
	 * lane session), so each verdict answers only output delivered since its hand's dispatch (step 12).
	 */
	const verdicts = new Map<string, Settled[]>();
	/**
	 * Verdicts on output that belongs to no hand this process or the ledger knows (no routing row, or
	 * a job that ended before its hand spawned), by the hand's session file and the delivery's time:
	 * they answer that delivery only, so a later hand with the same agent id never inherits one.
	 */
	const unmatched = new Map<string, Verdict>();
	/** Production review fan-outs by group id (D5 [N2]), while this process holds them. */
	const fanOuts = new Map<string, FanOut>();
	/** `<workload> <lane> <lab>` already recorded as a lane builder (D3 item 1): one entry per lab per lane. */
	const laneLabs = new Set<string>();
	const fingerprint = deps.fingerprint ?? repoFingerprint;

	/** Could `agentId` be the agent OMP allocated for this hand's spawn? */
	const couldBe = (hand: Hand, agentId: string) => hand.spawnKey === agentId || spawnKeyNames(agentId, hand.dispatchName);

	/**
	 * D3, recomputed from the ledger at each use. Review hands in flight in this process are checked
	 * by their own fingerprint at settle, so they do not count (lab.ts `builderLabs`).
	 */
	const buildersOf = (workloadId: string): Builders =>
		builderLabs(deps.ledger(), workloadId, new Set(hands.filter(h => h.review).map(h => h.token)));

	/** D2 check 2: why a review hand's output is withheld for changing the work, or null when it did not. */
	function workChanged(hand: Hand): string | null {
		if (!hand.before) return null;
		if ("error" in hand.before) return `its spawn-time repository fingerprint could not be taken (${hand.before.error})`;
		try {
			return fingerprint(hand.cwd) === hand.before.digest
				? null
				: `the repository at ${hand.cwd} changed between its spawn and its settle (its HEAD, its branch, the index or a worktree file)`;
		} catch (error) {
			return `its settle-time repository fingerprint could not be taken (${message(error)})`;
		}
	}

	/**
	 * D6: park the review of `sliceId`. One ledger write transaction checks for an open park question
	 * on the slice (one per slice), raises the question (which pauses the slice) and writes the
	 * `review-park:` entry that marks it as the classifier's. `loop`: the review's (`Pending.loop`);
	 * when the slice's loop has moved on since (another round passed, read in the same transaction,
	 * REVIEW-r4), the review belongs to an ended loop: nothing parks and null is returned. Null `loop`:
	 * a dispatch being classified now, in the current loop by definition.
	 */
	function park(workloadId: string, sliceId: string, reasons: readonly string[], loop: number | null): Parked {
		const ledger = deps.ledger();
		const builders = buildersOf(workloadId);
		return ledger.write(() => {
			const entries = ledger.entries(workloadId);
			if (loop !== null && loop !== reviewLoop(entries, sliceId)) return null;
			const open = openParkQuestion(entries, ledger.questions(workloadId), sliceId);
			if (open) return { questionId: open, raised: false };
			const questionId = ledger.raiseQuestion({
				by: deps.laneId,
				workloadId,
				sliceId,
				body: parkQuestionBody(sliceId, builders, reasons),
				options: [...PARK_OPTIONS],
			});
			ledger.recordEntry({ by: deps.laneId, workloadId, sliceId, kind: "assumption", body: reviewParkBody(questionId, sliceId) });
			return { questionId, raised: true };
		});
	}

	function parkedLine(sliceId: string, parked: Parked): string {
		return parked
			? `the review of ${sliceId} is parked on question ${parked.questionId} (review-park:; options same-lab / wait${parked.raised ? "" : "; that question was already open"}). Jo answers it; do not re-dispatch the review until then`
			: `the review loop of ${sliceId} it was dispatched in has ended since (review-loop-end:), so nothing parks and no question is raised`;
	}

	/**
	 * D5 [N2]: fan-out `group` parks once when every member is terminal — refused at spawn, dropped
	 * unspawned, or settled — and none settled `ran` with accepted output. Read from the members'
	 * `hand-spawn:` entries and their routing rows, so it holds after a restart; a member spawned in
	 * this process and not yet settled is running, and blocks the park. A group whose loop has ended
	 * (another round passed since it was published, REVIEW-r4) closes out with no question (`park`).
	 * So does a group whose spawned members all failed to dispatch (`review-round: … failed-dispatch`,
	 * PLAN wl-muq13bkdghblmo step 8; review r1 finding 3): it is no round (`countRounds`), and like a
	 * single failed dispatch the review is dispatched again.
	 */
	function checkFanOut(group: string, workloadId: string, sliceId: string, log: (line: string) => void): void {
		const fan = fanOuts.get(group);
		if (fan && fan.tokens.some(token => !fan.ended.has(token))) return;
		try {
			const ledger = deps.ledger();
			const entries = ledger.entries(workloadId);
			const members = handSpawns(entries).filter(spawn => spawn.group === group);
			if (members.length === 0 && (!fan || fan.reached.size === 0)) {
				fanOuts.delete(group); // nothing reached a spawn: no review was dispatched, so nothing parks
				return;
			}
			// Already parked after this group's last spawn (another process, or an earlier replay).
			const lastSpawn = entries.findLastIndex(e => members.some(m => e.body.startsWith(`hand-spawn: ${m.token} `)));
			const parks = entries.findLastIndex(e => e.body.startsWith("review-park: ") && e.slice_id === sliceId);
			if (!fan && members.length > 0 && parks > lastSpawn) return;
			const settled = settledTokens(entries);
			const changed = withheldTokens(entries);
			const rows = new Map(ledger.routings(workloadId).map(row => [row.id, row]));
			const failed = new Set(
				entries.flatMap(e => {
					const r = e.kind === "assumption" ? parseReviewRound(e.body) : null;
					return r?.verdict === "failed-dispatch" ? [r.token] : [];
				}),
			);
			if (members.length > 0 && members.every(m => failed.has(m.token))) {
				fanOuts.delete(group);
				log(`agent-system-2 classifier: production review fan-out ${group} of ${sliceId}: every spawned member failed to dispatch, so it is no round and nothing parks; the review is dispatched again`);
				return;
			}
			const reasons: string[] = [];
			for (const spawn of members) {
				if (hands.some(hand => hand.token === spawn.token)) return; // still running here
				const row = rows.get(settled.get(spawn.token) ?? "");
				if (row?.outcome === "ran" && !changed.has(spawn.token)) return; // an accepted review
				reasons.push(
					!row
						? `${spawn.spawnKey ?? spawn.token} ended with no settled routing row`
						: `${row.agent_id ?? spawn.token} withheld (${changed.has(spawn.token) ? "it changed the work" : row.outcome})`,
				);
			}
			for (const [token, why] of fan?.ended ?? []) if (!members.some(m => m.token === token)) reasons.push(why);
			fanOuts.delete(group);
			// D10: a loop Jo stopped takes no park question; its round ends with the stop's message.
			const stop = loopStop(entries, ledger.instructions(workloadId), workloadId, sliceId);
			if (stop) {
				log(`agent-system-2 classifier: production review fan-out ${group} of ${sliceId} ended with no accepted review on a loop stopped by ${stop}; no park question`);
				return;
			}
			const parked = park(workloadId, sliceId, reasons, fan ? fan.loop : groupLoop(entries, sliceId, group));
			log(`agent-system-2 classifier: production review fan-out ${group} of ${sliceId} ended with no accepted review; ${parkedLine(sliceId, parked)}`);
		} catch (error) {
			log(`agent-system-2 classifier: production review fan-out ${group} of ${sliceId} ended with no accepted review and could not be parked (${message(error)})`);
		}
	}

	/**
	 * D9: write review hand `p`'s `review-round:` entry, once per token (a replay finds it written).
	 * Call inside a ledger write transaction.
	 */
	function writeRound(ledger: RoutingLedger, p: Pick<Pending, "workloadId" | "sliceId" | "token" | "group">, verdict: ReviewVerdict, findings: FindingsOrUnknown): void {
		const entries = ledger.entries(p.workloadId);
		if (entries.some(e => e.body.startsWith("review-round: ") && e.body.includes(` token ${p.token} `))) return;
		const count = countRounds(entries, p.sliceId);
		const round = count.rounds.find(r => r.group === p.group)?.n ?? count.next;
		ledger.recordEntry({
			by: deps.laneId,
			workloadId: p.workloadId,
			sliceId: p.sliceId,
			kind: "assumption",
			body: reviewRoundBody({ slice: p.sliceId, round, token: p.token, group: p.group, verdict, findings }),
		});
	}

	/** `writeRound` in its own transaction; a failure is logged (the round then waits for a replay). */
	function recordRound(p: Pick<Pending, "workloadId" | "sliceId" | "token" | "group">, verdict: ReviewVerdict, findings: FindingsOrUnknown, log: (line: string) => void): void {
		try {
			const ledger = deps.ledger();
			ledger.write(() => writeRound(ledger, p, verdict, findings));
		} catch (error) {
			log(`agent-system-2 classifier: the review-round entry for ${p.token} (${p.sliceId}) could not be written (${message(error)})`);
		}
	}

	/**
	 * D9/D10: review round `group` of `sliceId` may have become complete. It is complete when every
	 * member this process holds is terminal and every member on the ledger (`review-group:`,
	 * `hand-spawn:` and `review-round:` entries, so it holds across a restart) has its `review-round:`.
	 * A member a `review-group:` lists that never spawned, in a group this process does not hold, is
	 * recorded dropped: its classification lived only in the process that made it. That process may
	 * still be live, so its late spawn of the member is refused (`reviewHeld`: the token is terminal)
	 * and the round keeps this accounting. It gets its `review-round: … dropped` here, in the same
	 * transaction. At a review dispatch on the slice (`dispatch`: its classification), a member that
	 * did spawn and has no verdict, whose spawning lane (its `hand-spawn:` entry's writer) has a
	 * `lane-exit:` after that spawn in ledger order, is settled in the same transaction (U2, PLAN
	 * wl-muq13bkdghblmo step 5 and its lane-5 finding): its hand ended with its `omp` process, so its
	 * result never arrives. It gets a `refused-model-unknown` routing row and `hand-settled:`, as
	 * `settle` writes when no answering model can be read, so its row stops counting as builders
	 * (`builderLabs`), and `review-round: … withheld` with unknown findings. `lane-exit:` has fixed
	 * writers, the runner and the starter, never a lane (`controlEntries`, surface/src/launch.ts);
	 * this process holds no hand of the group (checked above) and no pending fan-out member of it.
	 * Then: on a loop Jo
	 * stopped, `review-loop-end: … stop-reviews` and one orchestrator message with the round's
	 * findings; else a passing round ends the loop (`review-loop-end: … pass`); else a failing round
	 * that brings the loop's failed rounds to its limit raises the extend / accept / stop question and
	 * its `review-limit:` entry, once (an open one is not raised again). A round no longer in the
	 * current loop was already handled.
	 */
	function roundSettled(workloadId: string, sliceId: string, group: string, log: (line: string) => void, dispatch: Pending["routing"] | null): void {
		const fan = fanOuts.get(group);
		if (fan) {
			if (fan.tokens.some(token => !fan.ended.has(token))) return; // a member is pending or running
			fanOuts.delete(group);
		}
		if (hands.some(hand => hand.group === group)) return;
		try {
			const ledger = deps.ledger();
			const stakes = ledger.workload(workloadId)?.stakes ?? "normal";
			const done = ledger.write(() => {
				let entries = ledger.entries(workloadId);
				let round = countRounds(entries, sliceId).rounds.find(r => r.group === group);
				const dropped = round?.members.filter(m => m.verdict === null && !m.spawned) ?? [];
				for (const m of dropped) writeRound(ledger, { workloadId, sliceId, token: m.token, group }, "dropped", UNKNOWN);
				// "After" by ledger order (created_at, then rowid), not by created_at alone: two entries can share a millisecond.
				const exits = new Map(controlEntries(entries).flatMap(c => (c.prefix === "lane-exit" ? [[c.id, c.laneId] as const] : [])));
				// A spawn with no key (none since spawn keys are recorded) has no agent id to settle: it holds.
				const lost = (dispatch ? (round?.members ?? []) : []).flatMap(m => {
					if (m.verdict !== null || !m.spawned) return [];
					const at = entries.findIndex(e => e.kind === "assumption" && parseHandSpawn(e.body.trim())?.token === m.token);
					const spawn = at >= 0 ? parseHandSpawn(entries[at]!.body.trim()) : null;
					const laneId = entries[at]?.created_by;
					const agentId = spawn?.spawnKey;
					return spawn && agentId && entries.some((e, i) => i > at && exits.get(e.id) === laneId) ? [{ spawn, agentId }] : [];
				});
				for (const { spawn, agentId } of lost) {
					// The lost hand's classification lived in its process: the row carries this dispatch's
					// (the same slice's review) and the lost hand's own row of models. Its agent id is its spawn
					// key, the id OMP allocated for an async spawn (a hand that ran has one, schema CHECK); one
					// that collides with another row under that root aborts this write, and the round holds.
					const r = dispatch!;
					const routingId = ledger.recordRouting({
						by: deps.laneId,
						workloadId,
						sliceId,
						spawnKey: spawn.spawnKey,
						sessionRoot: spawn.root,
						agentId,
						kind: r.kind,
						confidence: r.confidence,
						probabilities: r.probabilities,
						classifiedTier: r.classifiedTier,
						pullUpTo: (r.pullUp?.to ?? null) as Exclude<Tier, "fast"> | null,
						stakes: r.stakes,
						pullDownTo: (r.pullDown?.to ?? null) as Exclude<Tier, "deep"> | null,
						tier: r.tier,
						models: spawn.row,
						outcome: "refused-model-unknown",
						ranModels: null,
						judgeModel: r.judgeModel,
					});
					ledger.recordEntry({ by: deps.laneId, workloadId, sliceId, kind: "assumption", body: handSettledBody(spawn.token, routingId) });
					writeRound(ledger, { workloadId, sliceId, token: spawn.token, group }, "withheld", UNKNOWN);
				}
				if (dropped.length + lost.length > 0) entries = ledger.entries(workloadId);
				const count = countRounds(entries, sliceId);
				round = count.rounds.find(r => r.group === group);
				if (!round?.complete) return null;
				const instructions = ledger.instructions(workloadId);
				const entry = (body: string) => ledger.recordEntry({ by: deps.laneId, workloadId, sliceId, kind: "assumption", body });
				const stop = loopStop(entries, instructions, workloadId, sliceId);
				if (stop) {
					entry(reviewLoopEndBody(sliceId, "stop-reviews"));
					const body = stoppedRoundMessage(sliceId, round, stop);
					ledger.enqueue({ by: deps.laneId, workloadId, sliceId, sender: deps.laneId, recipient: ORCHESTRATOR_RECIPIENT, body });
					return `review round ${round.n} of ${sliceId} settled on a loop stopped by ${stop}; the loop is ended and its findings are sent to the orchestrator`;
				}
				if (round.passed) {
					entry(reviewLoopEndBody(sliceId, "pass"));
					return `review round ${round.n} of ${sliceId} passed; its review loop is ended`;
				}
				const limit = effectiveRoundLimit(entries, instructions, stakes, sliceId);
				if (count.failed < limit.total || openLimitQuestion(entries, ledger.questions(workloadId), sliceId)) return null;
				const questionId = ledger.raiseQuestion({
					by: deps.laneId,
					workloadId,
					sliceId,
					body: roundLimitQuestionBody(sliceId, count, limit, stakes),
					options: [...ROUND_LIMIT_OPTIONS],
				});
				entry(reviewLimitBody(questionId, sliceId));
				return `review round ${round.n} of ${sliceId} brought the loop to its limit (${count.failed} failed of ${limit.total}); question ${questionId} (review-limit:; extend / accept / stop) is raised`;
			});
			if (done) log(`agent-system-2 classifier: ${done}`);
		} catch (error) {
			log(`agent-system-2 classifier: review round ${group} of ${sliceId} could not be closed (${message(error)})`);
		}
	}

	/**
	 * A fan-out member reached a terminal state (`why`); `reached`: it got as far as its spawn.
	 * `verdict`: a member refused at spawn, dropped unspawned, or stopped at spawn (D10: refused for a
	 * stopped loop or an open limit question; the round counts only the members that spawned) writes
	 * its `review-round:` here, so its round can complete (D9); a settled member wrote its own.
	 */
	function memberEnded(member: Pending, why: string, reached: boolean, log: (line: string) => void, verdict: "refused" | "dropped" | "stopped" | null): void {
		const fan = fanOuts.get(member.group);
		if (!fan) return;
		if (verdict) recordRound(member, verdict, UNKNOWN, log);
		fan.ended.set(member.token, why);
		if (reached) fan.reached.add(member.token);
		checkFanOut(member.group, fan.workloadId, fan.sliceId, log);
		roundSettled(member.workloadId, member.sliceId, member.group, log, null);
	}

	/**
	 * The one verdict on `agentId`'s hand: every model that answered on it (plus the model its task
	 * result reports, when there is one) against its row allowlist, and for a review hand the
	 * repository fingerprint (D2 check 2). Writes the dispatch's `routings` row, the review's
	 * `review-withheld:` and builder attribution, and `hand-settled:` in one transaction: none of them
	 * lands without the others, so a fault between them never lets `recover()` pass the review.
	 * No assistant turn seen in the hand's session means its models are unknown, whatever the result
	 * reports: the output is withheld (triad row 8). A hand whose every turn ended on a provider error
	 * is a failed dispatch (PLAN wl-muq13bkdghblmo step 8): withheld the same way, its row
	 * `refused-model-unknown` (the schema's outcome for "no model answered"), a review's verdict
	 * `failed-dispatch` (no round), no fingerprint check and no builder mark, no park; a 401 / 403 also
	 * writes `provider-refused:` (step 9). A review hand's `review-round:` (D9) lands in the
	 * same transaction, with the findings parsed from `delivered` (what reached the lane for it).
	 */
	function settle(hand: Hand, agentId: string, reported: string | null, log: (line: string) => void, delivered: string | null): Verdict {
		hands.splice(hands.indexOf(hand), 1);
		const key = handKey(hand.root, agentId);
		const seen = answered.get(key) ?? [];
		answered.delete(key);
		const errors = failedTurns.get(key) ?? [];
		failedTurns.delete(key);
		const failedDispatch = seen.length === 0 && errors.length > 0;
		const ran = seen.length === 0 ? [] : [...new Set([...seen, ...(reported ? [reported] : [])])];
		const off = ran.filter(model => !hand.row.includes(model));
		const outcome: RoutingOutcome = ran.length === 0 ? "refused-model-unknown" : off.length > 0 ? "refused-out-of-row" : "ran";
		if (seen.length === 0 && !failedDispatch) {
			log(`agent-system-2 classifier: no assistant message_end was seen in session ${key} for hand ${agentId}; its output is withheld as refused-model-unknown`);
		}
		let refusal =
			outcome === "ran"
				? null
				: outcome === "refused-out-of-row"
					? `${agentId} ran on ${off.join(", ")}, outside the ${hand.tier} row (${hand.row.join(", ")})`
					: failedDispatch
						? `${agentId}: a failed dispatch: no model answered on it, every turn ended on a provider error (${errors.map(e => `${e.model}${e.status === null ? "" : ` status ${e.status}`}${e.error ? `: ${e.error}` : ""}`).join("; ")})`
						: `${agentId}: no model that answered on it could be read${reported ? ` (its result reports ${reported}, but no turn was seen in ${key})` : ""}, so it cannot be checked against the ${hand.tier} row (${hand.row.join(", ")})`;
		const changed = hand.review && !failedDispatch ? workChanged(hand) : null;
		if (changed) {
			refusal = `${refusal ? `${refusal}; ` : ""}${agentId}: the review changed the work: ${changed}. A review hand does not change the work; the lane dispatches the fix as a change slice`;
		}
		const findings = hand.review ? handFindings(delivered, hand.root, agentId) : UNKNOWN;
		const roundVerdict: ReviewVerdict = failedDispatch ? "failed-dispatch" : refusal ? "withheld" : "accepted";
		const loginRefused = new Map(errors.flatMap(e => (e.status === 401 || e.status === 403 ? [[e.provider, e.status] as const] : [])));
		try {
			const ledger = deps.ledger();
			const entry = (body: string) => ledger.recordEntry({ by: deps.laneId, workloadId: hand.workloadId, sliceId: hand.sliceId, kind: "assumption", body });
			ledger.write(() => {
				const routingId = recordRouting(hand, hand.models, outcome, ran.length > 0 ? ran : null, agentId);
				if (changed) {
					entry(reviewWithheldBody(hand.token));
					// Its lab is a builder from now on (D3 item 2): every lab that answered, or every lab it could have run on.
					const models = ran.length > 0 ? ran : hand.models.map(modelIdentity);
					for (const model of new Map(models.map(m => [labOf(m) ?? m, m])).values()) entry(handBuilderBody(labOf(model), hand.token, model));
				}
				if (failedDispatch) for (const [provider, status] of loginRefused) entry(providerRefusedBody(provider, status, hand.token));
				entry(handSettledBody(hand.token, routingId));
				if (hand.review) writeRound(ledger, hand, roundVerdict, findings);
			});
		} catch (error) {
			// The row is the record of what ran (SPEC-2.0.md § A1.3); output with no record is refused.
			refusal = `${refusal ? `${refusal}; ` : ""}${agentId}: its routing row could not be written (${message(error)})`;
			if (hand.review) recordRound(hand, failedDispatch ? "failed-dispatch" : "withheld", findings, log); // its round still ends
		}
		if (hand.review && hand.group.startsWith("fg-")) {
			memberEnded(hand, `${agentId} ${failedDispatch ? "failed to dispatch" : refusal ? "withheld" : "accepted"}`, true, log, null);
		} else if (hand.review) {
			if (outcome === "refused-model-unknown" && !failedDispatch) {
				// D6 runtime outage: no model answered on a single review hand (e.g. every allowed entry failed).
				// A loop Jo stopped (D10) takes no park question. A failed dispatch is no round: the review is
				// dispatched again, routed off a provider that refused the login (step 9).
				try {
					const ledger = deps.ledger();
					const stop = loopStop(ledger.entries(hand.workloadId), ledger.instructions(hand.workloadId), hand.workloadId, hand.sliceId);
					if (!stop) {
						refusal = `${refusal}; ${parkedLine(hand.sliceId, park(hand.workloadId, hand.sliceId, [`the review hand ${agentId} ended with no model answering on ${hand.models.join(", ")}`], hand.loop))}`;
					}
				} catch (error) {
					refusal = `${refusal}; the review could not be parked (${message(error)})`;
				}
			}
			roundSettled(hand.workloadId, hand.sliceId, hand.group, log, null);
		}
		const verdict = { outcome, refusal };
		remember(key, hand.dispatchedAt, verdict, true);
		return verdict;
	}

	/** Keep `verdict` for the hand of `key` dispatched at `since`, in dispatch order (`verdicts`); `here`: it ran in this process. */
	function remember(key: string, since: number, verdict: Verdict, here: boolean): void {
		const kept = verdicts.get(key) ?? [];
		kept.push({ since, verdict, here });
		kept.sort((a, b) => a.since - b.since);
		verdicts.set(key, kept);
	}

	/**
	 * The verdict for a hand this instance holds no state on — a delivery replayed after the process
	 * or the factory was recreated, or one it cannot match: the one ledger row this lane wrote for
	 * exactly this session root and this allocated agent id (astra review 4 B1/S1). Its slice comes
	 * from that row; nothing is inferred from the id's shape. `null` when the agent id is not
	 * `[<parent>.]sl-…` — tier dispatches are named after their slice and slice ids are `sl-…`
	 * (ledger/schema.sql slices.id GLOB 'sl-?*') — so the job is not a tier hand. A tier hand with no
	 * row, more than one, or a ledger that cannot be read, is refused; so is a review whose token a
	 * `review-withheld:` entry names (D2 check 2). A production fan-out member's group is re-checked
	 * from its `hand-spawn:` entries (D5 [N2]). A review hand settled by no instance (lost with its
	 * process) gets its `review-round:` here, with its verdict and the findings in `delivered`, so its
	 * round can complete (D9/D10). `at`: when the output was delivered (ms). A verdict or a row whose
	 * hand was dispatched after that (its `hand-spawn:` entry is later) belongs to a newer hand with the
	 * same agent id, so it never answers this output, and no newer hand's round is written from it
	 * (PLAN wl-muq13bkdghblmo step 12).
	 */
	function recover(root: string, agentId: string, log: (line: string) => void, delivered: string | null, at: number): Verdict | null {
		const key = handKey(root, agentId);
		const known = unmatched.get(`${key} ${at}`) ?? verdicts.get(key)?.findLast(s => s.since <= at)?.verdict;
		if (known) return known;
		if (!agentId.slice(agentId.lastIndexOf(".") + 1).startsWith("sl-")) return null;
		let verdict: Verdict;
		try {
			const ledger = deps.ledger();
			const mine = ledger.routingsForHand(root, agentId).filter(r => r.created_by === deps.laneId);
			const workloadId = mine[0]?.workload_id ?? deps.boundWorkload();
			const entries = workloadId ? ledger.entries(workloadId) : [];
			// Each spawn's time (ms), by token: the dispatch time a recreated instance knows. A row with no
			// `hand-spawn:` entry for its token is taken as dispatched before any delivery (fail as before).
			const spawnedAt = new Map(
				entries.flatMap(e => {
					const spawn = e.kind === "assumption" ? parseHandSpawn(e.body.trim()) : null;
					return spawn ? [[spawn.token, Date.parse(e.created_at)] as const] : [];
				}),
			);
			const since = (token: string | null) => (token === null ? -Infinity : (spawnedAt.get(token) ?? -Infinity));
			const rows = mine.filter(r => since(tokenOfRouting(entries, r.id)) <= at);
			const row = rows[0];
			const token = row ? tokenOfRouting(entries, row.id) : null;
			verdict = !row
				? {
						outcome: "refused-model-unknown",
						refusal: `${agentId}: no settled routing row from lane ${deps.laneId} names session root ${root} and agent id ${agentId}, so the models that answered on it are unknown`,
					}
				: rows.length > 1
					? { outcome: "refused-model-unknown", refusal: `${agentId}: ${rows.length} routing rows (${rows.map(r => r.id).join(", ")}) name session root ${root} and this agent id, so which one is its verdict is unknown` }
					: row.outcome !== "ran"
						? { outcome: row.outcome, refusal: `${agentId}: its routing row ${row.id} (slice ${row.slice_id}) records ${row.outcome}${row.ran_models ? ` on ${JSON.parse(row.ran_models).join(", ")}` : ""}` }
						: token && withheldTokens(entries).has(token)
							? { outcome: "ran", refusal: `${agentId}: its routing row ${row.id} (slice ${row.slice_id}) is a review that changed the work (review-withheld: ${token}), so its output stays withheld` }
							: { outcome: "ran", refusal: null };
			if (rows.length === 1) remember(key, since(token), verdict, false);
			else unmatched.set(`${key} ${at}`, verdict);
			// The hand's spawn entry: by its routing's token, else by this root and a spawn key naming this agent id, spawned by then.
			const spawn = handSpawns(entries).findLast(s =>
				token ? s.token === token : s.root === root && s.spawnKey !== null && spawnKeyNames(agentId, s.spawnKey) && since(s.token) <= at,
			);
			if (workloadId && spawn?.review && spawn.sliceId) {
				const sliceId = spawn.sliceId;
				if (spawn.group.startsWith("fg-")) checkFanOut(spawn.group, workloadId, sliceId, log);
				const member = { workloadId, sliceId, token: spawn.token, group: spawn.group };
				recordRound(member, verdict.refusal ? "withheld" : "accepted", handFindings(delivered, root, agentId), log);
				roundSettled(workloadId, sliceId, spawn.group, log, null);
			}
		} catch (error) {
			return { outcome: "refused-model-unknown", refusal: `${agentId}: the ledger could not be read to check it (${message(error)})` };
		}
		return verdict;
	}

	/** `agentId`: the id OMP finally allocated to the hand; null for a spawn refused before any hand ran. Returns the routing id. */
	function recordRouting(
		hand: Pending & { tier: Tier; spawnKey: string | null; root: string },
		models: string[],
		outcome: RoutingOutcome,
		ranModels: string[] | null,
		agentId: string | null,
	): string {
		const r = hand.routing;
		// SPEC-2.0.md § A1.3 step 4 and "record the pull-up on the slice's ledger row".
		return deps.ledger().recordRouting({
			by: deps.laneId,
			workloadId: hand.workloadId,
			sliceId: hand.sliceId,
			spawnKey: hand.spawnKey,
			sessionRoot: hand.root,
			agentId,
			kind: r.kind,
			confidence: r.confidence,
			probabilities: r.probabilities,
			classifiedTier: r.classifiedTier,
			pullUpTo: (r.pullUp?.to ?? null) as Exclude<Tier, "fast"> | null,
			stakes: r.stakes,
			pullDownTo: (r.pullDown?.to ?? null) as Exclude<Tier, "deep"> | null,
			tier: hand.tier,
			models,
			outcome,
			ranModels,
			judgeModel: r.judgeModel,
		});
	}

	/**
	 * D3 item 1: an assistant turn in the lane's own session answered on `model`. The first time a lab
	 * answers for this lane on its bound workload, write `builder-lab: <lab> lane <laneId> model …`
	 * (once per lab per lane, across restarts: the ledger is checked in the same transaction).
	 */
	function laneAnswered(model: string, log: (line: string) => void): void {
		const workloadId = deps.boundWorkload();
		if (!workloadId) return;
		const lab = labOf(model);
		const seen = `${workloadId} ${deps.laneId} ${lab ?? model}`;
		if (laneLabs.has(seen)) return;
		try {
			const ledger = deps.ledger();
			const prefix = `builder-lab: ${lab ?? "unknown"} lane ${deps.laneId} model `;
			ledger.write(() => {
				if (lab && ledger.entries(workloadId).some(e => e.body.startsWith(prefix))) return;
				ledger.recordEntry({ by: deps.laneId, workloadId, kind: "assumption", body: laneBuilderBody(lab, deps.laneId, model) });
			});
			laneLabs.add(seen);
		} catch (error) {
			// Not recorded: this lane's provenance stays unknown, so its next review parks (fail closed).
			log(`agent-system-2 classifier: the lane's builder lab (${model}) could not be recorded on ${workloadId} (${message(error)})`);
		}
	}

	return function classifierExtension(pi: ExtensionAPI): void {
		// Per-session state in the factory closure: OMP re-invokes the factory per agent session
		// without re-importing the module (measured in ctx-first-search.ts, 2026-09-11).
		const pending: Pending[] = [];
		/** Slices of calls still being classified: held before the judge is asked (triad row 5). */
		const reserved: { sliceId: string; toolCallId: string }[] = [];
		/**
		 * Review spawns past their pending entry and not yet recorded or refused (awaiting credentials):
		 * their slice stays reserved, so no second round of it is dispatched in that gap (REVIEW-r2).
		 */
		const spawning: Pending[] = [];
		/** Classifications in flight, each owning its reservations (astra review 4 S3). */
		const attempts = new Set<Attempt>();
		/** Calls whose `tool_result` arrived: only these may keep pending entries past the turn. */
		const returned = new Set<string>();
		const log = (line: string) => (deps.log ? deps.log(line) : pi.logger?.warn(line));
		/**
		 * Drop an attempt's own reservations. By identity: a retired attempt's `finally` runs after the
		 * turn already released its reservations, and must not remove a newer attempt's.
		 */
		const release = (attempt: Attempt) => {
			for (const r of attempt.reservations) {
				const at = reserved.indexOf(r);
				if (at >= 0) reserved.splice(at, 1);
			}
		};
		/**
		 * Drop pending entry `i`: nothing will spawn for it. A fan-out member ends `dropped` (D5 [N2]).
		 */
		const dropPending = (i: number, why: string) => {
			const [entry] = pending.splice(i, 1);
			if (entry?.review) memberEnded(entry, `${entry.dispatchName} ${why} before its hand spawned`, false, log, "dropped");
		};
		/**
		 * An async member whose job ended before its hand spawned: nothing will spawn for its entry, so
		 * release its slice. Matched by the exact agent id OMP allocated (from its call's progress), and
		 * only for a job reported at `at` (ms) or later than its call's publish: an older job is an
		 * earlier hand's that OMP gave the same id (step 12).
		 */
		const dropUnspawned = (agentId: string, why: string, at: number) => {
			for (let i = pending.length - 1; i >= 0; i--) {
				if (pending[i]!.agentId !== agentId || pending[i]!.dispatchedAt > at) continue;
				log(`agent-system-2 classifier: ${agentId} (slice ${pending[i]!.sliceId}, call ${pending[i]!.toolCallId}) ${why} before its hand spawned; its slice is released`);
				dropPending(i, why);
			}
		};
		/**
		 * The verdict on `agentId`'s output, delivered at `at` (ms) under the lane's `root`: by an
		 * `async-result` delivery (`context`) or a result-bearing job snapshot (`tool_result`, PLAN
		 * wl-muq13bkdghblmo step 2). A hand this process holds settles on it only when it was dispatched
		 * by then (step 12); a pending member's job that ended before its hand spawned is released, its
		 * output withheld; anything else goes to `recover`. Null: not a tier hand.
		 */
		const settleDelivered = (root: string, agentId: string, output: string | null, at: number): Verdict | null => {
			const hand = hands.find(h => h.root === root && h.spawnKey === agentId && h.dispatchedAt <= at);
			if (hand) return settle(hand, agentId, null, log, output);
			if (pending.some(p => p.agentId === agentId && p.dispatchedAt <= at)) {
				// Its job ended before its hand spawned (a failed job is delivered, async/job-manager.ts:396-400):
				// no model ran on it. Release the slice; the job's text is withheld like any unrecorded hand's.
				dropUnspawned(agentId, "ended", at);
				unmatched.set(`${handKey(root, agentId)} ${at}`, {
					outcome: "refused-model-unknown",
					refusal: `${agentId}: its job ended before its hand spawned, so no model ran on it and there is no routing row for it`,
				});
			}
			return recover(root, agentId, log, output, at);
		};
		/**
		 * The hands a job snapshot entry labelled `agentId` could belong to (review r1 finding 1, review
		 * r2's finding). A snapshot entry carries no start time (OMP 18.4.4 async/job-control.ts:199-223
		 * snapshotJobs: `id`, `type`, `status`, `label`, `durationMs`, …), so unlike a delivery's
		 * `timestamp` it cannot be dated against a dispatch. Its job is one of this process's own: one
		 * job manager per process (sdk.ts:2092-2100, the `AsyncJobManager.instance()` singleton), which takes jobs only
		 * at `register` (async/job-manager.ts:416), and this extension is one instance per process (see
		 * `agentSystemClassifier`). That one manager holds the jobs of every lane root this process
		 * serves, and a root does not show in the entry, so the candidates are this process's hands
		 * with that agent id under any root: held, pending, or settled here (`Settled.here`, matched by
		 * `handKey` exactly); a hand known only from the ledger ran in an earlier process. One
		 * candidate: the entry is its job. More (`count` > 1): it cannot be tied to one, so it settles
		 * and releases nothing, and shown output is withheld unless every candidate settled with its
		 * output passed (`unchecked` false).
		 */
		const jobOwners = (agentId: string): { count: number; unchecked: boolean } => {
			const ran: Settled[] = [];
			for (const [key, kept] of verdicts) {
				if (key === handKey(dirname(key), agentId)) ran.push(...kept.filter(s => s.here));
			}
			const open = hands.filter(h => h.spawnKey === agentId).length + pending.filter(p => p.agentId === agentId).length;
			return { count: open + ran.length, unchecked: open > 0 || ran.some(s => s.verdict.refusal !== null) };
		};

		pi.on("tool_call", async (event, ctx) => {
			if (Object.hasOwn(EDITING_TOOLS, event.toolName)) {
				// D2 check 1: in a review hand's own session the editing tools are refused.
				const file = ctx.sessionManager.getSessionFile();
				const root = file ? dirname(file) : null;
				const agentId = file ? basename(file, ".jsonl") : null;
				if (root && agentId && hands.some(hand => hand.review && hand.root === root && couldBe(hand, agentId))) {
					return refuse(
						`agent-system-2 classifier refused ${event.toolName}: a review hand does not change the work; the lane dispatches the fix as a change slice. Report the change as a finding instead.`,
					);
				}
				return undefined;
			}
			if (event.toolName !== "task") return undefined;
			const input = (event.input ?? {}) as TaskInput;
			const batch = Array.isArray(input.tasks) && input.tasks.length > 0;
			const items: TaskItem[] = batch ? input.tasks! : [input];
			const context = batch ? input.context : undefined;
			const tierItems = items.flatMap((item, index) => (isTier(item.agent?.trim()) ? [{ item, index }] : []));
			if (tierItems.length === 0) return undefined;
			const fail = (reason: string) => refuse(`agent-system-2 classifier could not route this dispatch: ${reason}`);
			if (questionProblem) return fail(questionProblem);
			if (!laneRoot(ctx)) {
				return fail("this session has no session file, so its hands' sessions (<lane session>/<agent id>.jsonl) cannot be found and the models that answer on them cannot be checked");
			}

			// Every routing lands on its slice's ledger row (ruling 2026-09-28), so each tier item
			// names its slice; check that before spending a judge call.
			const problems: string[] = [];
			const targets: { item: TaskItem; index: number; sliceId: string; workloadId: string; workloadStakes: Stakes | null }[] = [];
			const bound = deps.boundWorkload();
			// A fan-out member waits under its slice (one dispatch per slice) and its own dispatch name.
			const waiting = () => [
				...[...pending, ...spawning].flatMap(p => [
					{ sliceId: p.sliceId, where: `call ${p.toolCallId}` },
					...(p.dispatchName === p.sliceId ? [] : [{ sliceId: p.dispatchName, where: `call ${p.toolCallId}` }]),
				]),
				...reserved.map(r => ({ sliceId: r.sliceId, where: `call ${r.toolCallId}, still being classified` })),
			];
			try {
				const ledger = deps.ledger();
				for (const { item, index } of tierItems) {
					const at = `task ${index + 1}`;
					const sliceId = typeof item.name === "string" ? item.name.trim() : "";
					const workloadId = briefField("workload", item.task, context);
					if (!sliceId) problems.push(`${at}: no \`name\`; a tier dispatch is named after its ledger slice id`);
					if (!workloadId) problems.push(`${at}: the brief has no \`workload:\` field`);
					if (!sliceId || !workloadId) continue;
					if (!OMP_AGENT_ID.test(sliceId) || item.name !== sliceId) {
						problems.push(
							`${at}: \`${sliceId}\` is not usable as an OMP agent id (letters, digits, _ and - only, at most 48 characters); OMP would rename the spawn and its routing could not be matched`,
						);
						continue;
					}
					// Triad row 7: one identity fact, one value. The dispatch's `name` is the slice; a `slice:`
					// line the gates read says the same, and the brief names the workload this session is bound to.
					const declaredSlice = briefSlice(item.task, context);
					if (declaredSlice !== null && declaredSlice !== sliceId) {
						problems.push(`${at}: the brief's \`slice: ${declaredSlice}\` is not the dispatch's \`name\` (${sliceId}); the name is the slice id (SPEC-2.0.md § B9)`);
						continue;
					}
					if (bound && workloadId !== bound) {
						problems.push(`${at}: the brief's \`workload: ${workloadId}\` is not the workload this session is bound to (${WORKLOAD_ENV}=${bound})`);
						continue;
					}
					if (ledger.slice(sliceId)?.workload_id !== workloadId) {
						problems.push(`${at}: \`${sliceId}\` is not a slice of workload ${workloadId} in the ledger`);
						continue;
					}
					// R2-B2: the spawn event carries no per-dispatch identity, only a key derived from the name.
					const conflict =
						spawnKeyConflict(sliceId, targets.map(t => ({ sliceId: t.sliceId, where: `task ${t.index + 1}` })), "") ??
						spawnKeyConflict(sliceId, waiting(), "pending ");
					if (conflict) {
						problems.push(`${at}: ${conflict}`);
						continue;
					}
					targets.push({ item, index, sliceId, workloadId, workloadStakes: ledger.workload(workloadId)?.stakes ?? null });
				}
			} catch (error) {
				return fail(`the ledger could not be read (${message(error)})`);
			}
			if (problems.length > 0) return fail(problems.join("; "));

			// Reserve before the first await: nothing else runs between the check above and this push,
			// so an overlapping call on one of these slices is refused by that check, not by a late one.
			const attempt: Attempt = {
				toolCallId: event.toolCallId,
				live: true,
				abort: new AbortController(),
				reservations: targets.map(t => ({ sliceId: t.sliceId, toolCallId: event.toolCallId })),
			};
			reserved.push(...attempt.reservations);
			attempts.add(attempt);
			// OMP's runner races a handler against its timeout and stops waiting, but the handler runs on
			// (extensibility/extensions/runner.ts:224-235, :250-325): after every await, a retired attempt
			// stops before it publishes anything.
			const retired = () =>
				new Error(`call ${event.toolCallId} was retired at the end of its turn while still being classified; its late classification is discarded`);
			try {
				const judge = await deps.judge(ctx);
				if (!attempt.live) throw retired();
				const classified = await Promise.all(
					targets.map(async ({ item, index, sliceId, workloadId, workloadStakes }) => {
						const classification = await classify(item.task ?? "", judge, deps.question, attempt.abort.signal);
						if (!attempt.live) throw retired();
						// S4 / R2-S1: a threshold measured on one judge says nothing about another's confidences.
						if (classification.judgeModel !== deps.calibration.judgeModel) {
							throw new Error(
								`judge drift: requested ${deps.calibration.judgeModel}, reported ${classification.judgeModel}; the 0.55 threshold holds only for the judge it was measured on, so re-sample the classifier on the reported model (research/classifier-sample.md) and update classifier/calibration.json before routing on it`,
							);
						}
						// SPEC-2.0.md § B9 field 5 feeds the § B4 cap; read task text first, then context.
						const brief = briefStakes(item.task, context);
						let routing = route(classification, brief);
						// D2: kind judge, or low-confidence with judge in the top two. D5 [R6]: a review's stakes
						// are the higher of the brief's and the workload row's; they feed the cap, the fan-out
						// decision and `routings.stakes`. Other dispatches keep the brief's.
						const review = isReviewDispatch(routing);
						if (review) routing = route(classification, effectiveStakes(brief, workloadStakes));
						return {
							item,
							index,
							sliceId,
							workloadId,
							review,
							routing: {
								...routing,
								probabilities: classification.probabilities as Record<string, number>,
								judgeModel: classification.judgeModel,
							},
						};
					}),
				);
				if (!attempt.live) throw retired();

				// D3 ordering: a review runs after the work it reviews has settled.
				for (const review of classified.filter(c => c.review)) {
					const work = classified.find(c => !c.review && c.workloadId === review.workloadId);
					if (work) {
						return fail(
							`task ${review.index + 1} (${review.sliceId}) is a review and task ${work.index + 1} (${work.sliceId}) is not, in one call on workload ${review.workloadId}; a review runs after the work it reviews has settled, so dispatch the work, let it settle, then dispatch the review`,
						);
					}
					const inFlight = [...hands, ...pending].filter(h => !h.review && h.workloadId === review.workloadId).map(h => h.dispatchName);
					if (inFlight.length > 0) {
						return fail(
							`task ${review.index + 1} (${review.sliceId}) is a review, and non-review work of workload ${review.workloadId} is still in flight (${[...new Set(inFlight)].join(", ")}); a review runs after the work it reviews has settled`,
						);
					}
				}

				// D10: a loop Jo stopped takes no further round. D9: a loop at its round limit, or whose
				// limit question is open, takes none until Jo answers; no second question is raised here;
				// and no round starts while another round of the slice is still running, so every round
				// counts toward the limit (read from the ledger, so it holds across a restart; a round
				// whose unspawned members are known dropped is closed first).
				// D6: a slice parked on its review question is not reviewed again until Jo answers.
				// D5: a production review is expanded into one item per other available lab.
				const plans = new Map<number, ReviewPlan | "granted">();
				for (const c of classified.filter(c => c.review)) {
					const ledger = deps.ledger();
					for (const r of countRounds(ledger.entries(c.workloadId), c.sliceId).rounds) {
						if (!r.complete) roundSettled(c.workloadId, c.sliceId, r.group, log, c.routing);
					}
					const entries = ledger.entries(c.workloadId);
					const instructions = ledger.instructions(c.workloadId);
					const stop = loopStop(entries, instructions, c.workloadId, c.sliceId);
					if (stop) return fail(`task ${c.index + 1}: ${stoppedLine(c.sliceId, stop)}`);
					const limitQuestion = openLimitQuestion(entries, ledger.questions(c.workloadId), c.sliceId);
					if (limitQuestion) return fail(`task ${c.index + 1}: ${limitQuestionLine(c.sliceId, limitQuestion)}`);
					const count = countRounds(entries, c.sliceId);
					const running = count.rounds.find(r => !r.complete);
					if (running) return fail(`task ${c.index + 1}: ${runningRoundLine(c.sliceId, running)}`);
					const limit = effectiveRoundLimit(entries, instructions, ledger.workload(c.workloadId)?.stakes ?? "normal", c.sliceId);
					if (count.failed >= limit.total) {
						return fail(
							`task ${c.index + 1}: the review of ${c.sliceId} is at its round limit (${count.failed} failed rounds of ${limit.total} allowed); no further round starts until Jo raises the limit (rounds <n>, or extend on its round-limit question)`,
						);
					}
					const open = openParkQuestion(entries, ledger.questions(c.workloadId), c.sliceId);
					if (open) return fail(`task ${c.index + 1}: ${parkedLine(c.sliceId, { questionId: open, raised: false })}`);
					if (c.routing.stakes !== "production") continue;
					// D6 [review 4 note 3]: a held same-lab grant is one hand on the row, spent at its spawn.
					if (unspentGrant(entries, instructions, c.sliceId) !== null) {
						plans.set(c.index, "granted");
						continue;
					}
					const row = deps.tierTable()[c.routing.tier];
					const disabled = new Set(await deps.disabledProviders(ctx));
					const { usable, why } = await usableRow(row, ctx.modelRegistry as unknown as ModelAvailability, disabled, refusedProviders(entries), deps.labHolds?.() ?? new Map(), null);
					if (!attempt.live) throw retired();
					const plan = reviewPlan({ row, usable, builders: buildersOf(c.workloadId), stakes: "production", grant: false, skipped: why });
					if (plan.kind === "fanout") {
						for (const member of plan.members) {
							const name = `${c.sliceId}--${member.lab}`;
							if (!OMP_AGENT_ID.test(name)) {
								return fail(`task ${c.index + 1}: \`${c.sliceId}\` is too long for its production review fan-out name \`${name}\` (at most 48 characters, an OMP agent id); use a shorter slice id`);
							}
							const conflict = spawnKeyConflict(name, waiting(), "pending ");
							if (conflict) return fail(`task ${c.index + 1}: ${conflict}`);
						}
					}
					plans.set(c.index, plan);
				}
				for (const c of classified) {
					const plan = plans.get(c.index);
					if (typeof plan === "object" && plan.kind === "park") {
						return fail(`task ${c.index + 1}: no lab other than the builder's can review ${c.sliceId}; ${parkedLine(c.sliceId, park(c.workloadId, c.sliceId, plan.reasons, null))}`);
					}
				}

				// Publish the whole call at once; its reservations become pending entries. Indices are the
				// rewritten call's: what OMP's per-member progress reports. A production fan-out's whole
				// membership is written (`review-group:`) before any member can spawn, so its round waits
				// for every member across a restart (D5/D9). Each review takes its slice's loop, read in the
				// same transaction (so a fan-out's matches the loop its `review-group:` puts it in): its
				// spawn after that loop ended is refused (REVIEW-r3).
				const byIndex = new Map(classified.map(c => [c.index, c]));
				const published: Pending[] = [];
				const revised: TaskItem[] = [];
				const groups: FanOut[] = [];
				const ledger = classified.some(c => c.review) ? deps.ledger() : null;
				const publish = () => {
					items.forEach((item, index) => {
						const c = byIndex.get(index);
						if (!c) {
							revised.push(item);
							return;
						}
						const plan = plans.get(index);
						const loop = c.review ? reviewLoop(ledger!.entries(c.workloadId), c.sliceId) : null;
						const base = { toolCallId: event.toolCallId, sliceId: c.sliceId, workloadId: c.workloadId, routing: c.routing, review: c.review, loop, dispatchedAt: Date.now() };
						if (typeof plan === "object" && plan.kind === "fanout") {
							const group = newToken("fg");
							const members = plan.members.map(member => {
								revised.push({ ...item, agent: c.routing.tier, name: `${c.sliceId}--${member.lab}`, task: withFindingsParagraph(item.task) });
								return { ...base, index: revised.length - 1, dispatchName: `${c.sliceId}--${member.lab}`, token: newToken("dt"), group, lab: member.lab, note: null };
							});
							groups.push({ group, workloadId: c.workloadId, sliceId: c.sliceId, tokens: members.map(m => m.token), ended: new Map(), reached: new Set(), loop });
							published.push(...members);
							return;
						}
						revised.push(c.review ? { ...item, agent: c.routing.tier, task: withFindingsParagraph(item.task) } : { ...item, agent: c.routing.tier });
						const note = plan === "granted" ? "production review: a same-lab grant is held, so one hand" : typeof plan === "object" && plan.kind === "single" ? plan.short : null;
						published.push({ ...base, index: revised.length - 1, dispatchName: c.sliceId, token: newToken("dt"), group: newToken("dg"), lab: null, note });
					});
					for (const g of groups) {
						ledger!.recordEntry({ by: deps.laneId, workloadId: g.workloadId, sliceId: g.sliceId, kind: "assumption", body: reviewGroupBody(g.sliceId, g.group, g.tokens) });
					}
				};
				if (ledger) ledger.write(publish);
				else publish();
				for (const g of groups) fanOuts.set(g.group, g);
				pending.push(...published);
				return { input: batch ? { ...input, tasks: revised } : revised.length === 1 ? revised[0]! : { context: "", tasks: revised } };
			} catch (error) {
				// SPEC-2.0.md § A1.3: a dispatch the classifier could not route is refused, not sent on
				// an unclassified guess. Nothing was published, so late answers have nowhere to land.
				attempt.abort.abort();
				if (!attempt.live) log(`agent-system-2 classifier: ${message(error)}`);
				return fail(message(error));
			} finally {
				attempts.delete(attempt);
				release(attempt);
			}
		});

		pi.on("before_subagent_spawn", async (event, ctx) => {
			if (!isTier(event.agent)) return undefined;
			const tier = event.agent;
			let found: Pending | null = null;
			/** A refused spawn is a fan-out member's terminal state (D5 [N2]). */
			const refused = (reason: string) => {
				if (found?.review) memberEnded(found, `${found.dispatchName} refused at spawn (${reason})`, true, log, "refused");
				return refuse(reason);
			};
			// A throwing handler must not let the spawn through on the native row: every failure refuses.
			try {
				const table = deps.tierTable();

				const root = laneRoot(ctx);
				if (event.invocationKind === "task") {
					// A member whose allocated id its call's result already reported matches on that id alone.
					const matches = event.spawnKey
						? pending.filter(p => (p.agentId !== undefined ? p.agentId === event.spawnKey : spawnKeyNames(event.spawnKey!, p.dispatchName)))
						: [];
					if (matches.length === 0) {
						return refuse(`agent-system-2 classifier: no classification for task spawn ${event.spawnKey ?? "(no spawn key)"}; a tier hand is dispatched only through a classified lane task call`);
					}
					if (matches.length > 1) {
						return refuse(`agent-system-2 classifier: spawn ${event.spawnKey} matches ${matches.length} classified slices (${matches.map(m => m.dispatchName).join(", ")}); refusing rather than guess`);
					}
					const match = matches[0]!;
					if (match.routing.tier !== tier) {
						return refuse(`agent-system-2 classifier: spawn ${event.spawnKey} is on ${tier} but its slice ${match.sliceId} was classified ${match.routing.tier}`);
					}
					if (!root) return refuse(`agent-system-2 classifier: spawn ${event.spawnKey}: the lane has no session file, so the hand's models could not be checked`);
					pending.splice(pending.indexOf(match), 1);
					found = match;
					if (match.review) spawning.push(match); // released in `finally`, once recorded or refused
				}

				// DESIGN-2.0.md P-11 row 15 / SPEC-2.0.md § B11: only this tier's row, only entries OMP's final
				// selection will keep: enabled provider, credentials session-free and for this spawn's key; and
				// not on a provider that refused the login on the workload (PLAN wl-muq13bkdghblmo step 9).
				const spawnKey = event.spawnKey ?? null;
				const disabled = new Set(await deps.disabledProviders(ctx));
				const loginRefused = found ? refusedProviders(deps.ledger().entries(found.workloadId)) : new Map<string, string>();
				const { usable, why, skipped } = await usableRow(table[tier], ctx.modelRegistry as unknown as ModelAvailability, disabled, loginRefused, deps.labHolds?.() ?? new Map(), spawnKey);
				if (found?.review) {
					// After the credential awaits, before planning (so a hold never parks): a review whose token
					// another instance recorded terminal, a loop stopped since classification (D10), an open
					// round-limit question (D9), the end of the loop it was published in (REVIEW-r3), or another
					// round of the slice now running holds the spawn. Its
					// round counts only the members that spawned, so a fan-out member's refusal is `stopped`
					// (terminal, not counted) and nothing parks. Checked again in the transaction that writes
					// `hand-spawn:`.
					const held = reviewHeld(deps.ledger(), found);
					if (held) {
						memberEnded(found, `${found.dispatchName} refused at spawn (${held})`, false, log, "stopped");
						return refuse(`agent-system-2 classifier: ${held}`);
					}
				}
				/** A spawn refused for no usable model writes its routing row at the refusal. */
				const refusedRow = (reason: string) => {
					try {
						if (found && root) recordRouting({ ...found, tier, spawnKey, root }, [], "refused-no-usable-model", null, null);
					} catch (error) {
						return `${reason}; its routing row could not be written (${message(error)})`;
					}
					return reason;
				};
				/**
				 * D3 item 3: every spawn's token, written before the hand runs (with a grant's spend, D6).
				 * For a review, the same transaction re-checks `reviewHeld` against what another instance could
				 * have written since: a hold writes nothing. `spent`: the grant was spent by another dispatch.
				 */
				const recordSpawn = (hand: Pending, models: string[], grant: string | null): "recorded" | "spent" | { held: string } => {
					const ledger = deps.ledger();
					return ledger.write(() => {
						const held = hand.review ? reviewHeld(ledger, hand) : null;
						if (held) return { held };
						const entries = ledger.entries(hand.workloadId);
						const entry = (body: string) => ledger.recordEntry({ by: deps.laneId, workloadId: hand.workloadId, sliceId: hand.sliceId, kind: "assumption", body });
						if (grant && spentGrants(entries).has(grant)) return "spent";
						if (grant) entry(reviewSameLabBody(grant, hand.token));
						entry(handSpawnBody({ token: hand.token, root: root!, spawnKey, review: hand.review, group: hand.group, row: models.map(modelIdentity) }));
						return "recorded";
					});
				};

				if (!found?.review || !root) {
					if (usable.length === 0) return refuse(refusedRow(`agent-system-2 classifier: no usable ${tier} model: ${skipped.join(", ")}`));
					// The row is written at the verdict, once what answered on the hand is known (settle).
					if (found && root) {
						recordSpawn(found, usable, null);
						hands.push({ ...found, root, spawnKey, tier, models: usable, row: table[tier].map(modelIdentity), cwd: ctx.cwd, before: null });
					}
					return { model: usable, note: routingNote(found?.routing ?? null, tier, usable, skipped, found?.note ? [found.note] : []) };
				}

				// D4: a review runs only on labs outside the builders, recomputed now; a fan-out member only
				// on its own lab. D6: a held same-lab grant appends the builder's entries, spent atomically
				// with the spawn record; a dispatch that finds it already spent gets the normal rule.
				const review: Pending = found;
				const ledger = deps.ledger();
				const builders = buildersOf(review.workloadId);
				const planInput = { row: table[tier], usable, builders, stakes: null, skipped: why, pin: review.lab ?? undefined };
				let grant = review.lab ? null : unspentGrant(ledger.entries(review.workloadId), ledger.instructions(review.workloadId), review.sliceId);
				for (;;) {
					const granted = grant ? reviewPlan({ ...planInput, grant: true }) : null;
					const plan = granted?.kind === "single" ? granted : reviewPlan({ ...planInput, grant: false });
					if (plan.kind !== "single") {
						const reasons = plan.kind === "park" ? plan.reasons : [];
						if (review.lab) {
							return refused(refusedRow(`agent-system-2 classifier: no ${review.lab} model can review ${review.sliceId} at this spawn: ${reasons.join(", ")}`));
						}
						let reason = refusedRow(`agent-system-2 classifier: no lab other than the builder's can review ${review.sliceId}`);
						try {
							reason += `; ${parkedLine(review.sliceId, park(review.workloadId, review.sliceId, reasons, review.loop))}`;
						} catch (error) {
							reason += `; the review could not be parked (${message(error)})`;
						}
						return refuse(reason);
					}
					const spend = plan.sameLab ? grant : null;
					const recorded = recordSpawn(review, plan.models, spend);
					if (recorded === "spent") {
						grant = null;
						continue;
					}
					if (recorded !== "recorded") {
						memberEnded(review, `${review.dispatchName} refused at spawn (${recorded.held})`, false, log, "stopped");
						return refuse(`agent-system-2 classifier: ${recorded.held}`);
					}
					let before: Hand["before"];
					try {
						before = { digest: fingerprint(ctx.cwd) };
					} catch (error) {
						before = { error: message(error) }; // withheld at settle: fail closed
					}
					hands.push({ ...review, root, spawnKey, tier, models: plan.models, row: plan.allow, cwd: ctx.cwd, before });
					const notes = [
						...(plan.excluded.length > 0 ? [`review routed off the builder lab${plan.excluded.length > 1 ? "s" : ""} ${plan.excluded.join(", ")}`] : []),
						...(spend ? [`same-lab grant ${spend} spent: the builder's entries follow the other labs'`] : []),
						...(review.note ? [review.note] : []),
					];
					return { model: plan.models, note: routingNote(review.routing, tier, plan.models, skipped, notes) };
				}
			} catch (error) {
				return refused(`agent-system-2 classifier could not route this spawn: ${message(error)}`);
			} finally {
				const at = found ? spawning.indexOf(found) : -1;
				if (at >= 0) spawning.splice(at, 1);
			}
		});

		// The hand's own session: record every model that answers on it (step 3 in the header). The
		// agent id is the session file's base name and the lane's root its directory ("Hand identity").
		// Any other session whose file is not inside another session's artifacts directory is the lane's
		// own: its answering lab is recorded as a builder (D3 item 1).
		pi.on("message_end", (event, ctx) => {
			const msg = event.message as { role?: string; provider?: string; model?: string; stopReason?: string; errorStatus?: number; errorMessage?: string };
			if (msg.role !== "assistant" || !msg.provider || !msg.model) return;
			const file = ctx.sessionManager.getSessionFile();
			if (!file?.endsWith(".jsonl")) return;
			const root = dirname(file);
			const agentId = basename(file, ".jsonl");
			const model = identity(`${msg.provider}/${msg.model}`);
			if (!hands.some(hand => hand.root === root && couldBe(hand, agentId))) {
				// A subagent's session file is `<parent session without .jsonl>/<id>.jsonl` (header, "Hand identity").
				if (!existsSync(`${root}.jsonl`)) laneAnswered(model, log);
				return;
			}
			if (msg.stopReason === "error") {
				// A provider error is no answer (PLAN wl-muq13bkdghblmo step 8): kept apart, for `settle`.
				const turns = failedTurns.get(file) ?? [];
				turns.push({ model, provider: msg.provider, status: typeof msg.errorStatus === "number" ? msg.errorStatus : null, error: msg.errorMessage ?? null });
				failedTurns.set(file, turns);
				return;
			}
			const models = answered.get(file) ?? [];
			if (!models.includes(model)) models.push(model);
			answered.set(file, models);
		});

		pi.on("tool_result", (event, ctx) => {
			if (event.toolName !== "task") {
				// A job snapshot in another tool's result (JobSnapshot). One that shows results — a `wait`, a
				// `proc://<id>/kill` write (both consume them: no `async-result` follows), a `read proc://<id>`
				// — is where a hand's output reaches the lane, so each finished task job in it settles like a
				// delivery (`settleDelivered`, PLAN wl-muq13bkdghblmo step 2): a held hand on its result, even
				// an empty one (its output file is read), except a cancelled one with nothing shown, which
				// stays held; an unheld one only when text is shown. A status-only listing (`op: "jobs"`, the
				// `read proc://` listing) settles nothing. Either way a queued task job can end before its hand
				// spawns: cancelled (async/job-manager.ts:417-424, no delivery follows) or aborted before
				// execution (task/index.ts:1129-1142); its slice is released (`dropUnspawned`). A job that
				// cannot be tied to one hand (`jobOwners`) settles and releases nothing, and its shown output
				// is withheld; so is any shown output when the lane has no session file, as in `context`.
				const details = (event.details ?? undefined) as SnapshotDetails | undefined;
				const list = (jobs: unknown) => (Array.isArray(jobs) ? (jobs as (JobSnapshot | undefined)[]) : []);
				const consumed = details?.op === "wait" || details?.op === "cancel" ? list(details.jobs) : details?.proc?.op === "cancel" ? list(details.proc.jobs) : null;
				const proc = details?.proc;
				const shown =
					consumed?.map(job => ({ job, text: job?.resultText || job?.errorText || null })) ??
					(proc?.op === undefined && proc?.job ? [{ job: proc.job, text: typeof proc.log === "string" && proc.log ? proc.log : null }] : []);
				const at = Date.now();
				const root = laneRoot(ctx);
				const drift: string[] = [];
				const jobs = shown.length > 0 ? shown : [...list(details?.jobs), ...list(proc?.jobs)].map(job => ({ job, text: null }));
				for (const { job, text } of jobs) {
					if (job?.type !== "task" || job.status === "running" || typeof job.label !== "string") continue;
					const agentId = job.label;
					if (root === null) {
						dropUnspawned(agentId, `ended ${job.status}`, at);
						if (text) drift.push(`${agentId}: the lane has no session file, so the models that answered on it cannot be read`);
						continue;
					}
					const owners = jobOwners(agentId);
					if (owners.count > 1) {
						if (text && owners.unchecked) {
							drift.push(
								`${agentId}: this job snapshot cannot be tied to one hand: this process ran ${owners.count} hands under agent id ${agentId}, and a job snapshot carries no start time to tell their jobs apart, so no hand settles or is released on it`,
							);
						}
						continue;
					}
					const held = hands.some(h => h.root === root && h.spawnKey === agentId && h.dispatchedAt <= at);
					if (shown.length === 0 || (held ? job.status === "cancelled" && !text : !text)) {
						if (!held) dropUnspawned(agentId, `ended ${job.status}`, at);
						continue;
					}
					const refusal = settleDelivered(root, agentId, text, at)?.refusal;
					if (refusal) drift.push(refusal);
				}
				return drift.length === 0 ? undefined : { isError: true, content: [{ type: "text" as const, text: withheld("job snapshot", drift) }] };
			}
			returned.add(event.toolCallId);
			const details = (event.details ?? undefined) as TaskDetails | undefined;
			// A failed or refused call spawns nothing more, and a finished blocking call has spawned all it
			// will: drop what it classified. Only a call that returned background jobs (`details.async` is
			// OMP's job object) keeps its entries — they spawn later. Anything else, `async: false` included,
			// is finished (triad row 9).
			const asyncCall = typeof details?.async === "object" && details.async !== null;
			if (event.isError || !asyncCall) {
				for (let i = pending.length - 1; i >= 0; i--) {
					if (pending[i]!.toolCallId === event.toolCallId) dropPending(i, event.isError ? "its call failed" : "its call finished");
				}
			} else {
				// Astra review 4 S2: an async call reports each member (task/index.ts:896-910). A member whose
				// job could not be scheduled is `failed` and never spawns (:914-938); release it. Every other
				// member keeps its entry, now bound to the agent id OMP allocated for it.
				const members = Array.isArray(details?.progress) ? details.progress : [];
				for (let i = pending.length - 1; i >= 0; i--) {
					const entry = pending[i]!;
					if (entry.toolCallId !== event.toolCallId) continue;
					const member = members.find(m =>
						typeof m?.index === "number" ? m.index === entry.index : typeof m?.id === "string" && spawnKeyNames(m.id, entry.dispatchName),
					);
					if (typeof member?.id !== "string") continue;
					entry.agentId = member.id;
					if (member.status === "failed" || member.status === "aborted") {
						log(`agent-system-2 classifier: ${member.id} (slice ${entry.sliceId}, call ${event.toolCallId}) was not scheduled (${member.status}); its slice is released`);
						dropPending(i, `was not scheduled (${member.status})`);
					}
				}
			}

			// R2-B1 / R3: the tier row is the allowlist for every model that answered on a blocking hand,
			// whatever the final selection or a retry fallback did after the spawn check.
			const root = laneRoot(ctx);
			const drift: string[] = [];
			for (const result of details?.results ?? []) {
				if (!isTier(result.agent) || !result.id) continue;
				const id = result.id;
				if (!root) {
					drift.push(`${id}: the lane has no session file, so the models that answered on it cannot be read`);
					continue;
				}
				const hand =
					hands.find(h => h.root === root && h.spawnKey === id) ??
					hands.find(h => h.root === root && h.toolCallId === event.toolCallId && spawnKeyNames(id, h.dispatchName));
				// D9: a review hand's findings are read from its own output (`results[].output`), else the call's text.
				const delivered = typeof result.output === "string" ? result.output : details?.results?.length === 1 ? messageText(event.content) : null;
				const verdict = hand ? settle(hand, id, reportedModel(result), log, delivered) : recover(root, id, log, delivered, Date.now());
				// A tier result this extension cannot place is refused, never passed (triad row 8).
				const refusal = verdict ? verdict.refusal : `${id}: no classified hand or routing row matches this ${result.agent} result`;
				if (!verdict) log(`agent-system-2 classifier: tier result ${id} matches no hand or routing row; withheld`);
				if (refusal) drift.push(refusal);
			}
			if (drift.length === 0) return undefined;
			return { isError: true, content: [{ type: "text" as const, text: withheld("task result", drift) }] };
		});

		// Triad row 4: a `task` call blocked by a later extension's `tool_call` handler never executes, so it
		// never gets a `tool_result` (extensibility/extensions/runner.ts emitToolCall returns at the first
		// block; pi-agent-core agent-loop.ts prepareToolCallDispatch marks it blocked and the run throws
		// before `tool.execute`, which is where extensions/wrapper.ts emits `tool_result`). A turn ends only
		// after its tool calls ran (agent-loop.ts emitTurnEnd after executeToolCalls; the session awaits
		// the extension `turn_end`, session/agent-session.ts #emitSessionEvent), so a pending entry whose
		// call has no result by then was never dispatched: release its slice. For the same reason a
		// classification still in flight belongs to a call the runner stopped waiting for (its handler
		// timed out, runner.ts:1310-1369): retire it, so a late judge answer publishes nothing, and
		// release its reservations now (astra review 4 S3).
		pi.on("turn_end", () => {
			for (const attempt of attempts) {
				attempt.live = false;
				attempt.abort.abort();
				release(attempt);
				log(`agent-system-2 classifier: call ${attempt.toolCallId} was still being classified at the end of its turn; it is retired and its slices are released`);
			}
			attempts.clear();
			for (let i = pending.length - 1; i >= 0; i--) {
				if (!returned.has(pending[i]!.toolCallId)) dropPending(i, "was never dispatched (its call got no result by the end of its turn)");
			}
			for (const id of returned) if (!pending.some(p => p.toolCallId === id)) returned.delete(id);
		});

		// An async hand's output reaches the lane's model only as an `async-result` custom message in
		// the per-request context (session/async-job-delivery.ts; sdk.ts transformContext). The session
		// history keeps the original, so a refused delivery is replaced on every request — by this
		// instance from memory, by a recreated one from the ledger rows (`recover`). A resumed session
		// keeps its earlier deliveries too, so each is matched by its own `timestamp` (its creation
		// time, restored from the session entry on resume) against the hand's dispatch (step 12).
		pi.on("context", (event, ctx) => {
			const root = laneRoot(ctx);
			let changed = false;
			const messages = event.messages.map(msg => {
				const delivery = msg as { role?: string; customType?: string; content?: unknown; details?: { jobs?: DeliveredJob[] }; timestamp?: unknown };
				if (delivery.role !== "custom" || delivery.customType !== "async-result") return msg;
				const delivered = delivery.details?.jobs ?? [];
				const jobs = delivered.filter(job => job.type === "task");
				const text = messageText(delivery.content);
				// A delivery with no time matches as it did before step 12: any hand under its agent id.
				const at = typeof delivery.timestamp === "number" ? delivery.timestamp : Infinity;
				const drift = jobs.flatMap(job => {
					// The agent id is the job's label; `jobId` may carry a collision suffix (astra review 3 B1).
					const agentId = job.label;
					if (!agentId) return [`job ${job.jobId ?? "(no id)"}: the delivery names no agent id, so its models cannot be checked`];
					if (!root) return [`${agentId}: the lane has no session file, so the models that answered on it cannot be read`];
					const refusal = settleDelivered(root, agentId, jobSection(text, delivered, job), at)?.refusal;
					return refusal ? [refusal] : [];
				});
				if (drift.length === 0) return msg;
				changed = true;
				const ids = jobs.map(job => job.label ?? job.jobId ?? "(no id)");
				const what = jobs.length > 1 ? `async task delivery (agents ${ids.join(", ")}, delivered together)` : "async task result";
				return { ...msg, content: withheld(what, drift) } as typeof msg;
			});
			return changed ? { messages } : undefined;
		});
	};
}

/**
 * The classifier's `labHolds` over the ledger the extension already holds open (PR #79 review S2): it never opens one of
 * its own, so a dispatch reads the lab budget from the same ledger its routing rows go to, and a process whose ledger is
 * not open yet (an unclassified eval spawn that reached no routing row) gates on no lab rather than opening the default
 * ledger path. A test seam: production passes the closure over its `ledger` variable.
 */
export function sharedLedgerLabHolds(shared: () => Pick<Ledger, "db"> | undefined, env: Record<string, string | undefined>): () => ReadonlyMap<string, string> {
	return () => {
		const open = shared();
		return open === undefined ? new Map() : heldLabs(open, env);
	};
}

/** Production wiring: the host's `judge` role, the active profile's config.yml, and the ledger. */
function productionExtension(): (pi: ExtensionAPI) => void {
	let agentDir: string | undefined;
	let ledger: Ledger | undefined;
	// Host-package imports are dynamic because this checkout carries no OMP install to import from
	// statically. OMP's legacy-pi-compat (extensibility/plugins/legacy-pi-compat.ts) serves a
	// bare `@oh-my-pi/*` specifier the running host's own in-process module, but only in modules it
	// reaches from the extension entry through relative imports; a module reached by an absolute-path
	// import resolves the specifier through bun instead, which picks its auto-install cache
	// (2026-09-29: pi-coding-agent@18.4.4, native addon missing, so the load fails). Measured live in
	// `omp -e` with that cache present: entry, `./x` and `../dir/x` got the host module
	// (`Settings.current` set), the absolute-path twin failed (M4b classifier-host probe). So these
	// imports stay in this entry file: moved to a module an absolute path reaches, or resolved to an
	// absolute `src/` path, they load a second copy of OMP (no `Settings.current`) or fail outright.
	// The reads themselves go through gates/src/host.ts (M4b fix 4): OMP 18.4.4 has no `Settings.get`,
	// a setting is read through its registered handle, and a host off the verified major.minor throws.
	const host = async (): Promise<HostModules> => {
		const [{ VERSION }, { Settings }, { lookup }] = await Promise.all([
			import("@oh-my-pi/pi-utils/dirs"),
			import("@oh-my-pi/pi-coding-agent/config/settings"),
			import("@oh-my-pi/pi-coding-agent/config/registry"),
		]);
		return { version: VERSION, Settings, lookup };
	};
	const settingsFor = async (ctx: ExtensionContext) => {
		const h = await host();
		return { host: h, settings: await hostSettings(h, ctx.cwd) };
	};
	const classifier = createClassifierExtension({
		question: loadKindQuestion(),
		calibration: loadCalibration(),
		laneId: process.env[LANE_ENV] || `lane-${process.pid}`,
		boundWorkload: () => process.env[WORKLOAD_ENV] || undefined,
		ledger: () => (ledger ??= Ledger.open(defaultLedgerPath(process.env))),
		// Read at a dispatch over the ledger the routing rows already opened: never at load, and never an open of its own.
		labHolds: sharedLedgerLabHolds(() => ledger, process.env),
		async judge(ctx) {
			// Same entry-module rule as settingsFor above.
			const [{ settings }, { resolveJudge }] = await Promise.all([
				settingsFor(ctx),
				import("@oh-my-pi/pi-coding-agent/judgment/index"),
			]);
			return resolveJudge({ settings: settings as never, registry: ctx.modelRegistry }) as unknown as KindJudge;
		},
		async disabledProviders(ctx) {
			// The same read OMP's final selection makes (config/model-resolver.ts resolveModelOverrideWithAuthFallback).
			const { host: h, settings } = await settingsFor(ctx);
			const disabled = readSetting(h, settings, "disabledProviders");
			if (!Array.isArray(disabled)) throw new Error(`disabledProviders read as ${JSON.stringify(disabled)}, not an array`);
			return [...new Set(disabled.filter((p): p is string => typeof p === "string"))];
		},
		tierTable() {
			if (!agentDir) {
				throw new Error("the profile's agent directory was not read at session start, so its config.yml tier table cannot be found");
			}
			return loadTierTable(join(agentDir, "config.yml"));
		},
	});
	return pi => {
		// The host serves `@oh-my-pi/pi-utils` as an async module, which `require()` cannot load
		// (live: `require() async module "omp-legacy-pi-bundled:@oh-my-pi/pi-utils" is unsupported`),
		// so the agent dir is read once here, awaited before any tool call (modes/runtime-init.ts,
		// task/executor.ts `await … emit({ type: "session_start" })`), and the spawn check stays synchronous.
		pi.on("session_start", async () => {
			agentDir ??= (await import("@oh-my-pi/pi-utils")).getAgentDir();
		});
		classifier(pi);
	};
}

/**
 * One instance per process: the lane's session and its hands' sessions share the hand state. That
 * holds because OMP runs a hand's session in the lane's process and binds the lane's already-prepared
 * extension factories into it rather than re-importing them: task/executor.ts:3796 passes
 * `preloadedPreparedExtensions` into the child's session options and :3875-3878 creates the child
 * with `createAgentSession` in-process; sdk.ts:2250-2261 binds those prepared factories
 * (`bindPreparedExtensions`) instead of loading the module again (verified in astra review 3).
 */
let production: ((pi: ExtensionAPI) => void) | undefined;

export default function agentSystemClassifier(pi: ExtensionAPI): void {
	(production ??= productionExtension())(pi);
}
