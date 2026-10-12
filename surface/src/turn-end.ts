// The runner's turn-end decision (MIGRATION.md item 40; PLAN wl-muq1v31q5ly7ls D1–D6): what an
// autonomous lane's runner does once omp reports a prompt finished. The decision is a pure function
// over values the runner reads from the ledger and from omp's frames, so the order of the steps is
// tested as a table inside the fence (surface/test/turn-end.test.ts). The park is the one write the
// decision may make; it is passed in as a callback so the steps before it (an unsettled hand, a
// handoff) are proven to run without it. The texts the runner sends and enqueues are built here too,
// with the one ledger write the runner makes before EOF (`enqueueRunnerDeath`) and the hand predicate
// the lane tools share (`unsettledHands`).
import { parseHandSpawn, settledTokens } from "../../classifier/src/lab";
import { type EntryRow, LANE_RUNNER_BY, type Ledger, type RoutingRow, type SliceRow } from "../../ledger/src/index";
import { type ControlEntry } from "./launch";
import { laneDeaths } from "./signals";
import { LANE_DIED_PREFIX, ORCHESTRATOR_RECIPIENT } from "./types";

/** Continue prompts one runner sends before it surfaces open work or holds for a hand (D2, D6). A relaunch starts at 0. */
export const CONTINUE_LIMIT = 2;
/** Appended to a runner death written while omp still reported background work (D3). */
export const BACKGROUND_SUFFIX = "; background work was in flight";

/**
 * - `wait`: omp reported background work; nothing until `session_settled` (D1).
 * - `continue`: send a continue prompt on the same omp (D2 step 6, D6 step 0).
 * - `hold`: a hand of this lane is unsettled and the continue prompts are spent: keep omp, poll the ledger (D6).
 * - the rest are the lane's outcome; `open-work`, `error` and `aborted` are deaths.
 */
export type TurnEndDecision = "wait" | "hold" | "continue" | "parked" | "resume-pending" | "completed" | "released" | "open-work" | "error" | "aborted";

/** A `hand-spawn:` this lane wrote with no valid `hand-settled:` (D6): its token and the `spawn <name>` field (`-` when none). */
export interface UnsettledHand {
	token: string;
	job: string;
}

/** The lane's own slices, the runner's ceiling slice left out: `open`, `paused` (on a question), `done`. */
export interface SliceCounts {
	open: number;
	paused: number;
	done: number;
}

export interface TurnEndInput {
	/** omp's view: the last `prompt_result` said `sessionSettled` (a missing field counts as settled), or `session_settled` followed. */
	settled: boolean;
	/** The worst status a prompt of this run ended with: `completed` until one ended `error` or `aborted` (D3 keeps it). */
	status: "completed" | "error" | "aborted";
	unsettledHands: readonly UnsettledHand[];
	/** The lane still holds the workload. */
	held: boolean;
	/** The holder is Jo: the lane called lane_handoff (D2 step 1). */
	handedOff: boolean;
	/** The open-slice count this lane's `released-open:` marker names, or null when it wrote none (D4). */
	releasedOpen: number | null;
	/** A holder's `done-because:` stands. */
	receipt: boolean;
	slices: SliceCounts;
	/** Continue prompts sent so far in this run. */
	continues: number;
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
}

/** The turn-end decision (D2), step 0 (D6) first and the handoff before the park. */
export function turnEnd(i: TurnEndInput): TurnEnd {
	const decided = (decision: TurnEndDecision): TurnEnd => ({ decision, parkError: null });
	if (!i.settled) return decided("wait");
	if (i.unsettledHands.length > 0) return decided(i.continues < i.limit ? "continue" : "hold");
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
	return decided(i.continues < i.limit ? "continue" : "open-work");
}

/** The continue prompt for the decision `continue`, the `n`-th of `limit` (D2 step 6, D6 step 0). */
export function continuePrompt(workloadId: string, i: Pick<TurnEndInput, "unsettledHands" | "slices">, n: number, limit: number): string {
	const count = `(continue ${n} of ${limit})`;
	if (i.unsettledHands.length > 0) {
		return `Hand(s) ${i.unsettledHands.map((h) => `${h.token} (job ${h.job})`).join(", ")} you spawned have no result on the ledger yet. Keep your turn alive until each result is auto-delivered. If a job no longer exists, say so with lane_message. ${count}`;
	}
	if (i.slices.open + i.slices.paused === 0) {
		return `Your turn ended on ${workloadId} with no slice cut, no open question from you and no done-because receipt. Continue: add the slices (on a plan-first workload, the judge plan slice first). ${count}`;
	}
	return `Your turn ended with work open on ${workloadId}: ${i.slices.open} open slice(s), ${i.slices.paused} paused, no open question from you, no done-because receipt. Continue. If only Jo can decide, raise it with lane_raise_question. When the done line is met, record done-because and lane_release. ${count}`;
}

/** `lane-died: <laneId>: turn ended with open work after <limit> continue prompts (…)` (D2 step 6). */
export function openWorkDeathBody(laneId: string, limit: number): string {
	return `${LANE_DIED_PREFIX} ${laneId}: turn ended with open work after ${limit} continue prompts (no question, no done-because)`;
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
export function turnEndDeathBody(laneId: string, t: TurnEnd, i: Pick<TurnEndInput, "held" | "releasedOpen" | "limit" | "promptError">): string | null {
	switch (t.decision) {
		case "open-work":
			return !i.held && i.releasedOpen !== null ? releasedOpenDeathBody(laneId, i.releasedOpen) : openWorkDeathBody(laneId, i.limit);
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

/** The plain message the runner sends once when it holds a lane for its hands (D6; not a death). */
export function heldOpenBody(laneId: string, hands: readonly UnsettledHand[], limit: number): string {
	return `lane ${laneId} is held open: hand(s) ${hands.map((h) => h.token).join(", ")} unsettled after ${limit} continue prompts; it ends at a stop, the ceiling or the deadline`;
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

/** The slice the runner's ceiling meter adds (surface/scripts/lane.ts raiseCeilingQuestion): not the lane's work. */
export const isRunnerCeilingSlice = (s: Pick<SliceRow, "id" | "created_by">): boolean => s.id.startsWith("sl-ceiling-") && s.created_by === LANE_RUNNER_BY;

/** The lane's own slices by state, the runner's ceiling slice left out. */
export function sliceCounts(slices: readonly Pick<SliceRow, "id" | "created_by" | "state">[]): SliceCounts {
	const out: SliceCounts = { open: 0, paused: 0, done: 0 };
	for (const s of slices) {
		if (isRunnerCeilingSlice(s)) continue;
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
 * same settle, and the entry's writer proves nothing (the classifier stamps the lane id). The
 * starter's `orphaned` settle (MIGRATION.md item 109, no routing row) does not count here: it is
 * written for a lane already superseded, whose own turn end this predicate no longer governs.
 */
export function unsettledHandsOf(entries: readonly EntryRow[], routings: readonly Pick<RoutingRow, "id" | "created_at">[], laneId: string): UnsettledHand[] {
	const routed = new Map(routings.map((r) => [r.id, r.created_at]));
	const settles: { token: string; routing: string }[] = [];
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		for (const [token, routing] of settledTokens([e])) if (routing !== null) settles.push({ token, routing });
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
