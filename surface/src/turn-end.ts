// The runner's turn-end decision (MIGRATION.md item 40; PLAN wl-muq1v31q5ly7ls D1–D6): what an
// autonomous lane's runner does once omp reports a prompt finished. The decision is a pure function
// over values the runner reads from the ledger and from omp's frames, so the order of the steps is
// tested as a table inside the fence (surface/test/turn-end.test.ts). The park is the one write the
// decision may make; it is passed in as a callback so the steps before it (an unsettled hand, a
// handoff) are proven to run without it. The texts the runner sends and enqueues are built here too,
// with the one ledger write the runner makes before EOF (`enqueueRunnerDeath`) and the hand predicate
// the lane tools share (`unsettledHands`). PLAN wl-mv5i3lulwwbbi8 D6 and D8 add the idle session
// (`settleIdle`: unsettled and silent, asked rather than waited on forever) and the lane's test runs
// (`liveTestRuns` holds like a hand; `deadTestRuns` asks once for a new run), as pure helpers the
// runner feeds from omp's frames, the ledger and the runs' heartbeat files.
import { parseHandSpawn, settledTokens } from "../../classifier/src/lab";
import { type EntryRow, LANE_RUNNER_BY, type Ledger, type RoutingRow, type SliceRow } from "../../ledger/src/index";
import { type ControlEntry } from "./launch";
import { laneDeaths } from "./signals";
import { ownsRequest, type RunRecord, runLive } from "./test-run";
import { LANE_DIED_PREFIX, LANE_FULL_TEST_TOOL, ORCHESTRATOR_RECIPIENT } from "./types";

/** Continue prompts one runner sends before it surfaces open work or holds for a hand (D2, D6). A relaunch starts at 0. */
export const CONTINUE_LIMIT = 2;
/** Idle prompts one runner sends an idle session in one idle episode before it surfaces open work (PLAN wl-mv5i3lulwwbbi8 D6). */
export const IDLE_LIMIT = 2;
/** The settle wait this long with no omp frame but the replies to the runner's own get_state is idle (D6); the runner's AGENT_SYSTEM_LANE_SETTLE_IDLE_MS overrides it. */
export const SETTLE_IDLE_MS = 15 * 60_000;
/** Appended to a runner death written while omp still reported background work (D3). */
export const BACKGROUND_SUFFIX = "; background work was in flight";
/** The runner's get_state ids: the first one (the session and model), the hold's settle check, the idle check (D6). */
export const STATE_ID = "state";
export const SETTLE_CHECK = "settle-check";
export const IDLE_CHECK = "idle-check";

/**
 * - `wait`: omp reported background work; nothing until `session_settled` (D1), unless the session is idle (D6).
 * - `continue`: send a continue prompt on the same omp (D2 step 6, D6 step 0); `TurnEnd.continued` says which.
 * - `hold`: a hand of this lane is unsettled, or a test run of the workload is live, and the continue prompts are spent,
 *   or an idle session has a reserved request waiting on Jo: keep omp, poll the ledger (D6; PLAN wl-mv5i3lulwwbbi8 D6, D8).
 * - the rest are the lane's outcome; `open-work`, `error` and `aborted` are deaths.
 */
export type TurnEndDecision = "wait" | "hold" | "continue" | "parked" | "resume-pending" | "completed" | "released" | "open-work" | "error" | "aborted";

/** A `test-requested:` with no result whose run is no longer live and that still owns its slice (PLAN wl-mv5i3lulwwbbi8 D8): its runner died. */
export interface DeadTestRun {
	runId: string;
	pr: number;
	slice: string;
}

/**
 * What a `continue` is about: the lane's hands, a dead test run (asked once, counted nowhere), live test runs, an idle
 * session (counted in `idleContinues`), or the open work.
 */
export type Continued = { kind: "hands" | "runs" | "idle" | "work" } | { kind: "dead-run"; run: DeadTestRun };

/** A `hand-spawn:` this lane wrote with no valid `hand-settled:` (D6): its token and the `spawn <name>` field (`-` when none). */
export interface UnsettledHand {
	token: string;
	job: string;
}

/** The lane's slices by state: `open`, `paused` (on a question), `done`. */
export interface SliceCounts {
	open: number;
	paused: number;
	done: number;
}

export interface TurnEndInput {
	/** omp's view: the last `prompt_result` said `sessionSettled` (a missing field counts as settled), or `session_settled` followed. */
	settled: boolean;
	/**
	 * The runner's settle wait went `SETTLE_IDLE_MS` with no omp frame and omp's get_state still says unsettled (PLAN
	 * wl-mv5i3lulwwbbi8 D6): the ladder runs instead of `wait`, and its last step asks the lane.
	 */
	idle: boolean;
	/** The worst status a prompt of this run ended with: `completed` until one ended `error` or `aborted` (D3 keeps it). */
	status: "completed" | "error" | "aborted";
	unsettledHands: readonly UnsettledHand[];
	/** The workload's test runs live by `runLive` (`liveTestRuns`): held like a hand (PLAN wl-mv5i3lulwwbbi8 D8). */
	liveTestRuns: readonly string[];
	/** The workload's dead test runs this runner has not prompted about yet (`deadTestRuns`): one uncounted continue each (D8). */
	deadTestRuns: readonly DeadTestRun[];
	/** A reserved request on the workload waits on Jo (`waitingReserved`, the needs-you predicate): an idle session holds for it (D6). */
	pendingReserved: boolean;
	/** The lane still holds the workload. */
	held: boolean;
	/** The holder is Jo: the lane called lane_handoff (D2 step 1). */
	handedOff: boolean;
	/** The open-slice count this lane's `released-open:` marker names, or null when it wrote none (D4). */
	releasedOpen: number | null;
	/** A holder's `done-because:` stands. */
	receipt: boolean;
	slices: SliceCounts;
	/** Continue prompts sent so far in this run (hands, live runs, open work; never a dead run's or an idle one). */
	continues: number;
	/** Idle prompts sent in this idle episode: the runner resets it to 0 whenever a turn ends with the session settled (D6). */
	idleContinues: number;
	limit: number;
	/** `parkLane` (D2 step 2); called only when the steps before it decide nothing. It may throw. */
	park: () => { parked: false } | { parked: true; open: number };
	/** omp's `error` on the first prompt that ended `error` (`promptErrorOf`), or null: the death line names it. */
	promptError?: PromptError | null;
}

/** omp's `RpcPromptError` (rpc-types.ts) on a `prompt_result` with status `error`: the provider's own words. */
export interface PromptError {
	message: string;
	provider: string | null;
	model: string | null;
	retryable: boolean;
}

/** The `error` of a `prompt_result` frame, or null when it carries none with a string `message`. */
export function promptErrorOf(frame: Record<string, unknown>): PromptError | null {
	const e = frame.error;
	if (typeof e !== "object" || e === null) return null;
	const message: unknown = Reflect.get(e, "message");
	if (typeof message !== "string") return null;
	const provider: unknown = Reflect.get(e, "provider");
	const model: unknown = Reflect.get(e, "model");
	return {
		message, provider: typeof provider === "string" ? provider : null, model: typeof model === "string" ? model : null, retryable: Reflect.get(e, "retryable") === true,
	};
}

export interface TurnEnd {
	decision: TurnEndDecision;
	/** Why the park failed, when the decision is `error` from the park. */
	parkError: string | null;
	/** Set only on a `continue`: what it is about (PLAN wl-mv5i3lulwwbbi8 D6, D8). */
	continued?: Continued;
}

/**
 * The turn-end decision (D2), step 0 (D6) first and the handoff before the park. PLAN wl-mv5i3lulwwbbi8: an idle session
 * runs the ladder instead of waiting (D6); after the hands, a dead test run is asked about once, uncounted, and live test
 * runs continue then hold like hands (D8); only the last step differs for an idle unsettled session: a reserved request
 * waiting on Jo holds, else up to `IDLE_LIMIT` idle prompts, then open work. A settled session's ladder is otherwise unchanged.
 */
export function turnEnd(i: TurnEndInput): TurnEnd {
	const decided = (decision: TurnEndDecision): TurnEnd => ({ decision, parkError: null });
	const resume = (continued: Continued): TurnEnd => ({ decision: "continue", parkError: null, continued });
	if (!i.settled && !i.idle) return decided("wait");
	if (i.unsettledHands.length > 0) return i.continues < i.limit ? resume({ kind: "hands" }) : decided("hold");
	const dead = i.deadTestRuns[0];
	if (dead !== undefined) return resume({ kind: "dead-run", run: dead });
	if (i.liveTestRuns.length > 0) return i.continues < i.limit ? resume({ kind: "runs" }) : decided("hold");
	if (i.handedOff) return decided("released");
	if (i.status !== "completed") return decided(i.status);
	let park: { parked: false } | { parked: true; open: number };
	try {
		park = i.park();
	} catch (err) {
		return { decision: "error", parkError: err instanceof Error ? err.message : String(err) };
	}
	if (park.parked) return decided(park.open > 0 ? "parked" : "resume-pending");
	if (!i.held) return decided(i.releasedOpen !== null ? "open-work" : "completed");
	if (i.receipt) return decided("completed");
	if (i.slices.open + i.slices.paused === 0 && i.slices.done > 0) return decided("completed");
	// D6: the last step for an idle session omp still reports unsettled.
	if (i.idle && !i.settled) {
		if (i.pendingReserved) return decided("hold");
		return i.idleContinues < IDLE_LIMIT ? resume({ kind: "idle" }) : decided("open-work");
	}
	return i.continues < i.limit ? resume({ kind: "work" }) : decided("open-work");
}

/** The counter a `continue` spends (D6, D8): `continues`, `idleContinues`, or none (a dead run's, which the runner records as prompted instead). */
export function continueCounter(t: TurnEnd): "continues" | "idle" | null {
	if (t.decision !== "continue") return null;
	const kind = t.continued?.kind ?? "work";
	return kind === "dead-run" ? null : kind === "idle" ? "idle" : "continues";
}

/** The continue prompt for the decision `continue` about hands, live test runs or open work, the `n`-th of `limit` (D2 step 6, D6 step 0; PLAN wl-mv5i3lulwwbbi8 D8). */
export function continuePrompt(workloadId: string, i: Pick<TurnEndInput, "unsettledHands" | "slices"> & { liveTestRuns?: readonly string[] }, n: number, limit: number): string {
	const count = `(continue ${n} of ${limit})`;
	if (i.unsettledHands.length > 0) {
		return `Hand(s) ${i.unsettledHands.map((h) => `${h.token} (job ${h.job})`).join(", ")} you spawned have no result on the ledger yet. Keep your turn alive until each result is auto-delivered. If a job no longer exists, say so with lane_message. ${count}`;
	}
	const runs = i.liveTestRuns ?? [];
	if (runs.length > 0) {
		return `Test run(s) ${runs.join(", ")} on ${workloadId} have no result on the ledger yet; each result arrives as an aside. While you wait, \`sleep 60\` in bash, or end your turn: the runner holds this lane while a run is live. ${count}`;
	}
	if (i.slices.open + i.slices.paused === 0) {
		return `Your turn ended on ${workloadId} with no slice cut, no open question from you and no done-because receipt. Continue: add the slices (on a plan-first workload, the judge plan slice first). ${count}`;
	}
	return `Your turn ended with work open on ${workloadId}: ${i.slices.open} open slice(s), ${i.slices.paused} paused, no open question from you, no done-because receipt. Continue. If only Jo can decide, raise it with lane_raise_question. When the done line is met, record done-because and lane_release. ${count}`;
}

/** The prompt for a `continue` about an idle session (PLAN wl-mv5i3lulwwbbi8 D6), the `n`-th of `limit` in this idle episode; the wait in whole minutes, or seconds under a minute (the runner's test knob). */
export function idlePrompt(workloadId: string, idleMs: number, n: number, limit: number): string {
	const wait = idleMs >= 60_000 ? `${Math.round(idleMs / 60_000)} min` : `${Math.round(idleMs / 1000)} s`;
	return `Your session on ${workloadId} has background work pending and no activity for ${wait}: if you need its result, \`wait\` for it; otherwise continue your slices, or release (record done-because first when the done line is met, then lane_release). (idle prompt ${n} of ${limit})`;
}

/** The prompt for a `continue` about a dead test run (PLAN wl-mv5i3lulwwbbi8 D8): once per run, counted nowhere. */
export function deadRunPrompt(run: DeadTestRun): string {
	return `The runner for ${run.runId} died: no heartbeat, no result on the ledger. Call ${LANE_FULL_TEST_TOOL} again (PR #${run.pr}, slice ${run.slice}): that call settles it as \`error runner died\` and starts a new run.`;
}

/** `lane-died: <laneId>: turn ended with open work after <limit> continue prompts (…)` (D2 step 6). */
export function openWorkDeathBody(laneId: string, limit: number): string {
	return `${LANE_DIED_PREFIX} ${laneId}: turn ended with open work after ${limit} continue prompts (no question, no done-because)`;
}
/** `lane-died: <laneId>: idle with open work after <limit> idle prompts (…)` (PLAN wl-mv5i3lulwwbbi8 D6): an unsettled session that never answered. */
export function idleDeathBody(laneId: string, limit: number): string {
	return `${LANE_DIED_PREFIX} ${laneId}: idle with open work after ${limit} idle prompts (no question, no done-because)`;
}
/** `lane-died: <laneId>: released with <k> open slice(s), no done-because` (D4). */
export function releasedOpenDeathBody(laneId: string, open: number): string {
	return `${LANE_DIED_PREFIX} ${laneId}: released with ${open} open slice(s), no done-because`;
}
/** `lane-died: <laneId>: turn-end park failed: <e>[; released with <k> open slice(s)]` (D2 step 2). */
export function parkFailedDeathBody(laneId: string, error: string, releasedOpen: number | null): string {
	const released = releasedOpen === null ? "" : `; released with ${releasedOpen} open slice(s)`;
	return `${LANE_DIED_PREFIX} ${laneId}: turn-end park failed: ${error.replace(/\s+/g, " ").trim()}${released}`;
}
/**
 * `lane-died: <laneId>: prompt ended <status>`: omp's own `error` / `aborted` before the deadline (D3). With omp's error
 * (MIGRATION.md item 85): `… prompt ended error: <provider>/<model>: <message, one line, at most 200 chars> (retryable <bool>)`.
 */
export function promptEndedDeathBody(laneId: string, status: "error" | "aborted", error: PromptError | null = null): string {
	const base = `${LANE_DIED_PREFIX} ${laneId}: prompt ended ${status}`;
	if (error === null) return base;
	const who = error.provider !== null || error.model !== null ? `${error.provider ?? "-"}/${error.model ?? "-"}: ` : "";
	return `${base}: ${who}${error.message.replace(/\s+/g, " ").trim().slice(0, 200)} (retryable ${error.retryable})`;
}
/** `lane-died: <laneId>: turn-end decision failed: <e>`: the runner could not read what the decision needs. */
export function turnEndFailedDeathBody(laneId: string, error: string): string {
	return `${LANE_DIED_PREFIX} ${laneId}: turn-end decision failed: ${error.replace(/\s+/g, " ").trim()}`;
}

/** The runner's death line for a decided turn-end outcome, or null for an intended one. */
export function turnEndDeathBody(laneId: string, t: TurnEnd, i: Pick<TurnEndInput, "held" | "releasedOpen" | "limit" | "promptError"> & Partial<Pick<TurnEndInput, "settled" | "idle">>): string | null {
	switch (t.decision) {
		case "open-work":
			if (!i.held && i.releasedOpen !== null) return releasedOpenDeathBody(laneId, i.releasedOpen);
			return i.idle === true && i.settled === false ? idleDeathBody(laneId, IDLE_LIMIT) : openWorkDeathBody(laneId, i.limit);
		case "error":
			return t.parkError !== null ? parkFailedDeathBody(laneId, t.parkError, i.releasedOpen) : promptEndedDeathBody(laneId, "error", i.promptError ?? null);
		case "aborted":
			return promptEndedDeathBody(laneId, "aborted");
		default:
			return null;
	}
}

/**
 * The outcome `finish()` records when omp exited before the runner decided one, with the death it enqueues whatever
 * the holder. A release carrying this lane's `released-open:` marker is `open-work` here too (D4): a woken turn's
 * `lane_release` can shut omp down before its `session_settled` reaches the turn-end decision.
 * `never-ready` and `died` keep `finish()`'s own death, which needs the lane to still hold the workload.
 */
export function exitOutcome(laneId: string, i: { ready: boolean; held: boolean; releasedOpen: number | null }): { outcome: "never-ready" | "died" | "open-work" | "released"; death: string | null } {
	if (!i.ready) return { outcome: "never-ready", death: null };
	if (i.held) return { outcome: "died", death: null };
	if (i.releasedOpen !== null) return { outcome: "open-work", death: releasedOpenDeathBody(laneId, i.releasedOpen) };
	return { outcome: "released", death: null };
}

/**
 * The plain message the runner sends once when it holds a lane (D6; not a death): for its hands, for the workload's live
 * test runs (PLAN wl-mv5i3lulwwbbi8 D8), or, for an idle session with neither, for a reserved request waiting on Jo (D6).
 */
export function heldOpenBody(laneId: string, hands: readonly UnsettledHand[], limit: number, runs: readonly string[] = [], reserved = false): string {
	const why = [...(hands.length > 0 ? [`hand(s) ${hands.map((h) => h.token).join(", ")} unsettled`] : []), ...(runs.length > 0 ? [`test run(s) ${runs.join(", ")} live`] : [])];
	const cause = why.length > 0 ? `${why.join(", ")} after ${limit} continue prompts` : reserved ? "a reserved request waits on Jo while the session is idle" : "nothing named";
	return `lane ${laneId} is held open: ${cause}; it ends at a stop, the ceiling or the deadline`;
}

/**
 * The runner's death line, enqueued before EOF and without the held condition (D3): at most one
 * `lane-died:` per lane id, the guard `finish()` and the lane's shutdown share. Returns the message
 * id, or null when a death for this lane is already on the ledger.
 */
export function enqueueRunnerDeath(ledger: Ledger, r: { workloadId: string; laneId: string; body: string }): string | null {
	return ledger.write(() => {
		if (laneDeaths(ledger, r.workloadId).some((d) => d.holder === r.laneId)) return null;
		return ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: r.workloadId, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: r.body });
	});
}

/** The lane's slices by state. */
export function sliceCounts(slices: readonly Pick<SliceRow, "state">[]): SliceCounts {
	const out: SliceCounts = { open: 0, paused: 0, done: 0 };
	for (const s of slices) {
		if (s.state === "open") out.open += 1;
		else if (s.state === "paused") out.paused += 1;
		else if (s.state === "done") out.done += 1;
	}
	return out;
}

/** `released-open: <laneId> slices <k>`, written by lane_release with the release (D4). */
export function releasedOpenBody(laneId: string, open: number): string {
	return `released-open: ${laneId} slices ${open}`;
}
/** The open-slice count the newest valid `released-open:` of `laneId` names, or null. */
export function releasedOpen(control: readonly ControlEntry[], laneId: string): number | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "released-open" || c.laneId !== laneId) continue;
		const m = /^slices\s+(\d+)$/.exec(c.rest);
		if (m) return Number(m[1]);
	}
	return null;
}

/**
 * D6's predicate, pure: the tokens of `hand-spawn:` entries `laneId` wrote with no valid
 * `hand-settled:`. A `hand-settled: <token> routing <rid>` counts only when `<rid>` is a row of these
 * routings (the workload's) created at or after the spawn: the classifier writes that row in the
 * same settle, and the entry's writer proves nothing (the classifier stamps the lane id).
 */
export function unsettledHandsOf(entries: readonly EntryRow[], routings: readonly Pick<RoutingRow, "id" | "created_at">[], laneId: string): UnsettledHand[] {
	const routed = new Map(routings.map((r) => [r.id, r.created_at]));
	const settles: { token: string; routing: string }[] = [];
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		for (const [token, routing] of settledTokens([e])) settles.push({ token, routing });
	}
	const out: UnsettledHand[] = [];
	for (const e of entries) {
		if (e.kind !== "assumption" || e.created_by !== laneId) continue;
		const spawn = parseHandSpawn(e.body);
		if (!spawn || out.some((h) => h.token === spawn.token)) continue;
		const settled = settles.some((s) => {
			const at = routed.get(s.routing);
			return s.token === spawn.token && at !== undefined && at >= e.created_at;
		});
		if (!settled) out.push({ token: spawn.token, job: spawn.spawnKey ?? "-" });
	}
	return out;
}

/** `unsettledHandsOf` over the workload's entries and routings as the ledger has them now. */
export function unsettledHands(ledger: Ledger, workloadId: string, laneId: string): UnsettledHand[] {
	return unsettledHandsOf(ledger.entries(workloadId), ledger.routings(workloadId), laneId);
}

/**
 * PLAN wl-mv5i3lulwwbbi8 D6, pure: the runner's settle wait is idle once `idleMs` (`SETTLE_IDLE_MS`) have passed since
 * both the wait began and omp's last frame that counts as activity (`idleActivity`).
 */
export function settleIdle(waitingSinceMs: number, lastFrameMs: number, nowMs: number, idleMs: number = SETTLE_IDLE_MS): boolean {
	return nowMs - Math.max(waitingSinceMs, lastFrameMs) >= idleMs;
}

/** An omp frame is activity for `settleIdle` unless it is the reply to one of the runner's own get_state calls (D6). */
export function idleActivity(frame: Record<string, unknown>): boolean {
	return !(frame.type === "response" && (frame.id === STATE_ID || frame.id === SETTLE_CHECK || frame.id === IDLE_CHECK));
}

/**
 * PLAN wl-mv5i3lulwwbbi8 D8, pure: the run ids among the workload's `testRuns` records (ledger order) that `runLive`
 * holds live, exactly its thresholds (no result; 60 s since the heartbeat file, or 120 s since the request with none);
 * the heartbeat is read by the caller (null when there is none or it does not parse).
 */
export function liveTestRuns(records: readonly RunRecord[], heartbeatAt: (runId: string) => number | null, nowMs: number): string[] {
	return records
		.filter((r) => r.results.length === 0 && runLive({ settled: false, requestedAtMs: Date.parse(r.request.createdAt), heartbeatAtMs: heartbeatAt(r.request.runId) }, nowMs))
		.map((r) => r.request.runId);
}

/**
 * D8, pure: the runs whose runner died, not yet in `prompted`: no result, not live (`liveTestRuns`), and still the newest
 * request on their slice (`ownsRequest`), so an older request a newer one replaced is never asked about.
 */
export function deadTestRuns(records: readonly RunRecord[], heartbeatAt: (runId: string) => number | null, nowMs: number, prompted: ReadonlySet<string>): DeadTestRun[] {
	const live = new Set(liveTestRuns(records, heartbeatAt, nowMs));
	return records
		.filter((r) => !prompted.has(r.request.runId) && !live.has(r.request.runId) && ownsRequest(records, r.request.runId))
		.map((r) => ({ runId: r.request.runId, pr: r.request.pr, slice: r.request.slice }));
}
