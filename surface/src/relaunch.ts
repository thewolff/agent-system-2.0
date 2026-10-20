// The dead-lane relaunch's reading of the ledger (PLAN wl-mvfqvd5hy8zv28 § 1.1, § 1.3, § 1.4, § 1.4a, § 1.8): how the
// newest attempt's lane ended (`laneEnd`) and whether the machinery owes the workload a relaunch now (`relaunchState`).
// Both are pure functions of the rows a launch decision reads (`Ledger.launchRows`); the launch predicate
// (`launchable`, surface/src/launch.ts) turns them into a cause or a refusal, and the surface's pre-read step reads
// `relaunchState` for the incident. Nothing here writes.
import type { ReserveRows } from "../../ledger/src/index";
import { nextRetry, progressAfter, RELAUNCH_BACKOFF_MS, RETRY_LIMIT } from "./incident";
import {
	type Attempt, attempts, type ControlEntry, controlEntries, doneBecause, heldLive, holdersOf, isIntendedOutcome, laneExit, laneStarted, prBindings,
} from "./launch";
import { isRunnerCeilingSlice } from "./turn-end";

/** The incident kind of a dead lane's spent relaunch budget (§ 1.5); its key is the dead lane. */
export const RELAUNCH_INCIDENT = "relaunch";

/** Whether a process with this pid exists; the predicate's one outside read (§ 1.1, review r1 M2), injectable for tests. */
export type PidAlive = (pid: number) => boolean;

/**
 * `process.kill(pid, 0)`: alive unless the kernel answers ESRCH (EPERM is a live process this user may not signal). A pid that
 * is not a positive integer names no process: 0 and negatives would address process groups.
 */
export const pidAlive: PidAlive = (pid) => {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
};

/**
 * A stop that vetoes the machinery (§ 1.1 step 2, review r1 F1): Jo's `lane-stop: L requested <reason> by jo`, accepted or
 * not, or the runner's `accepted ceiling`. A `launch-requested: by jo` older than one is answered by it and never launches.
 */
export function isVetoStop(c: ControlEntry): boolean {
	return c.prefix === "lane-stop" && (/^requested\s+\S+\s+by\s+jo(?:\s|$)/.test(c.rest) || /^accepted\s+ceiling\b/.test(c.rest));
}

/**
 * How lane L, the newest attempt's, ended (§ 1.1), checked in this order: `live` while any holder's lease is live;
 * `stopped` by Jo or the ceiling (the veto, whatever the order of stop and death, review r1 F1), with the stop entry;
 * `died`; else `intended`. A lapse with no exit whose runner's recorded pid is still alive (`alive`) is `live`, not `died`:
 * the runner outlived its lease (a sleeping Mac) and renews on wake, so no successor may take the workload (review r1 M2).
 */
export type LaneEnd =
	| { kind: "live" }
	| { kind: "stopped"; entryId: string; createdAt: string }
	| { kind: "died" }
	| { kind: "intended" };

export function laneEnd(w: ReserveRows["workload"], control: readonly ControlEntry[], laneId: string, now: string, alive: PidAlive = pidAlive): LaneEnd {
	if (heldLive(w, now)) return { kind: "live" };
	const mine = control.filter((c) => c.laneId === laneId);
	// The newest veto stop on this lane.
	const stop = mine.findLast(isVetoStop);
	if (stop) return { kind: "stopped", entryId: stop.id, createdAt: stop.createdAt };
	if (mine.some((c) => c.prefix === "launch-failed")) return { kind: "died" };
	const exit = laneExit(control, laneId);
	if (exit !== null && (!isIntendedOutcome(exit.outcome) || (exit.outcome === "stop" && exit.reason === "signal"))) return { kind: "died" };
	if (mine.some((c) => c.prefix === "lane-stop" && /^accepted\s+signal\b/.test(c.rest))) return { kind: "died" };
	if (exit === null && (w.holder === laneId || w.holder === null)) {
		const marked = mine.some((c) =>
			c.prefix === "lane-parked" || (c.prefix === "lane-decided" && isIntendedOutcome(c.rest)) || (c.prefix === "lane-stop" && /^accepted\b/.test(c.rest)));
		if (!marked) {
			const runner = laneStarted(mine, laneId)?.runnerPid ?? 0;
			return runner > 0 && alive(runner) ? { kind: "live" } : { kind: "died" };
		}
	}
	return { kind: "intended" };
}

/**
 * Whether the machinery owes the workload a relaunch of its dead lane L (§ 1.3, § 1.4a), with the relaunch's number n:
 * `due` now; `waiting` for the backoff to end at `until`; `exhausted` when n is past `RETRY_LIMIT` (the incident's
 * state); `unrecorded` when L died but no `lane-died:` message names it yet (never relaunched, § 1.4a); `none` otherwise.
 * Every outcome but `none` needs: an open autonomous workload, no holder `done-because:`, no valid `train:` entry (§ 1.8),
 * L `died`, at least one open slice (the runner's ceiling slice excepted) and no open question.
 */
export type RelaunchState =
	| { kind: "none" }
	| { kind: "due"; lane: string; n: number }
	| { kind: "waiting"; lane: string; n: number; until: string }
	| { kind: "exhausted"; lane: string; n: number }
	| { kind: "unrecorded"; lane: string; n: number };

/**
 * What the launch predicate reads about the newest attempt: its lane, how it ended (null with no attempt), whether the
 * workload is the merge train's (a valid `train:` entry, § 1.8), and the relaunch state.
 */
export interface RelaunchRead {
	lane: string | null;
	end: LaneEnd | null;
	train: boolean;
	state: RelaunchState;
}

/** The parsed rows `verdictOf` already holds; computed here when the caller passes none. */
export interface ParsedRows {
	holders: readonly string[];
	control: readonly ControlEntry[];
	receipt: string | null;
}

/** The newest attempt's relaunch reading over the rows a launch decision reads; `alive` probes the runner's recorded pid. */
export function relaunchRead(rows: ReserveRows, parsed?: ParsedRows, alive: PidAlive = pidAlive): RelaunchRead {
	const holders = parsed?.holders ?? holdersOf(rows.entries, rows.workload.holder, rows.holders);
	const control = parsed?.control ?? controlEntries(rows.entries, holders);
	const receipt = parsed === undefined ? doneBecause(rows.entries, holders) : parsed.receipt;
	const train = prBindings(rows.entries, rows.instructions, ["train"]).length > 0;
	const last = attempts(control).at(-1);
	if (last === undefined) return { lane: null, end: null, train, state: { kind: "none" } };
	const end = laneEnd(rows.workload, control, last.laneId, rows.now, alive);
	return { lane: last.laneId, end, train, state: train ? { kind: "none" } : stateOf(rows, holders, control, receipt, last, end) };
}

/** `relaunchRead`'s state alone: what the surface's incident step reads per open workload. */
export function relaunchState(rows: ReserveRows, alive: PidAlive = pidAlive): RelaunchState {
	return relaunchRead(rows, undefined, alive).state;
}

function stateOf(rows: ReserveRows, holders: readonly string[], control: readonly ControlEntry[], receipt: string | null, last: Attempt, end: LaneEnd): RelaunchState {
	const w = rows.workload;
	if (w.status !== "open" || w.mode !== "autonomous" || receipt !== null || end.kind !== "died") return { kind: "none" };
	// § 1.8: the merge-train workload (`train`) never reaches here.
	const slices = rows.slices.filter((s) => !isRunnerCeilingSlice(s));
	if (!slices.some((s) => s.state === "open") || rows.questions.some((q) => q.state === "open")) return { kind: "none" };
	const lane = last.laneId;
	const n = nextRetry(
		last,
		(a) => (a.cause?.kind === "relaunch" ? a.cause.n : null),
		(a) => progressAfter({ entries: rows.entries, control, holders, slices, questions: rows.questions }, a),
	);
	if (n > RETRY_LIMIT) return { kind: "exhausted", lane, n };
	const death = rows.deaths.find((d) => d.laneId === lane);
	if (death === undefined) return { kind: "unrecorded", lane, n };
	if (n === 1) return { kind: "due", lane, n };
	const until = new Date(Date.parse(death.createdAt) + RELAUNCH_BACKOFF_MS).toISOString();
	return Date.parse(rows.now) >= Date.parse(until) ? { kind: "due", lane, n } : { kind: "waiting", lane, n, until };
}
