// The runaway trips (MIGRATION.md item 111), beside the compaction loop (src/compaction-loop.ts): a lane the runner
// (surface/scripts/lane.ts `run`) stops, fail-closed, with an evidence entry and a needs-you death line, because it
// spends without getting anywhere. Measured 2026-10-12 over the lane session files under ~/.agent-system-2/lanes
// (assistant `usage.totalTokens`): the loop lanes of wl-mv457r7iqmq29s burned at an ordinary rate (its busiest
// 30 min, 18.6M tokens, sits at the median of 63 workloads) for hours, so the rate and lifetime caps here are
// backstops set above every healthy lane; the compaction loop and no-progress are the primary guards.
//  - no-progress: NO_PROGRESS_MS of IN-TURN time (agent_start → agent_end on the rpc stream; paused while held for hands)
//    with no ledger write by the lane but `wake-read` entries and `spend:` lines. An idle or finished lane accrues nothing.
//    Measured 2026-10-12 over 251 rpc logs (MIGRATION.md item 111): the longest in-turn stretch with no such write was at
//    most 26.9 min on every lane that did not end at the ceiling, the deadline or the loop; the loop lanes reached 44.2 and
//    49.2. The default, 35 min, sits between them;
//  - token-burn: more than BURN_TOKENS tokens in any BURN_WINDOW_MS (the busiest healthy workload: 191.5M / 30 min);
//  - token-total: more than TOTAL_TOKENS tokens since this run started (the largest completed lane: 188.9M).
import { LANE_DIED_PREFIX } from "./types";

export const NO_PROGRESS_REASON = "no-progress";
export const TOKEN_BURN_REASON = "token-burn";
export const TOKEN_TOTAL_REASON = "token-total";

/** The defaults; the runner reads AGENT_SYSTEM_LANE_NO_PROGRESS_MS, _BURN_TOKENS, _BURN_WINDOW_MS and _TOTAL_TOKENS over them. */
export const RUNAWAY_DEFAULTS = { noProgressMs: 35 * 60_000, burnTokens: 200_000_000, burnWindowMs: 30 * 60_000, totalTokens: 200_000_000 } as const;
export type RunawayLimits = { noProgressMs: number; burnTokens: number; burnWindowMs: number; totalTokens: number };

/**
 * A ledger row as the no-progress clock reads it: `kind` and `body` only for entries; `changed_by`/`changed_at` for the
 * mutable rows the runner passes (slices and questions), whose last change is a write too (`lane_complete_slice` updates
 * the slice row and adds no entry: PR #73 review).
 */
export interface WriteRow {
	created_by: string;
	created_at: string;
	changed_by?: string;
	changed_at?: string;
	kind?: string;
	body?: string;
}

/** A write that is progress: anything the lane wrote but a wake-read (the loop re-reads its wake turn after turn) or a spend: line. */
export const isProgress = (r: WriteRow): boolean => r.kind !== "wake-read" && !(r.body ?? "").startsWith("spend:");

/** The newest progress by `laneId` at or after `floor` (ms), as ms; `floor` when there is none. A row counts by its creation or by its last change, whichever the lane made. */
export function lastProgress(rows: Iterable<WriteRow>, laneId: string, floor: number): number {
	let last = floor;
	for (const r of rows) {
		if (!isProgress(r)) continue;
		if (r.created_by === laneId) last = Math.max(last, Date.parse(r.created_at));
		if (r.changed_by === laneId && r.changed_at !== undefined) last = Math.max(last, Date.parse(r.changed_at));
	}
	return last;
}

/**
 * The no-progress clock: in-turn milliseconds since the last progress write. `agent_start` starts a turn and `agent_end`
 * ends it (a nested `agent_start` inside a turn changes nothing); `accrued` holds the closed turns' time, `mark` the open
 * turn's start or the last reset.
 */
export interface FlightClock {
	inFlight: boolean;
	accrued: number;
	mark: number;
}
export const FLIGHT_CLOCK_START: FlightClock = { inFlight: false, accrued: 0, mark: 0 };

/** One rpc frame: only `agent_start` and `agent_end` move the clock. */
export function flightStep(c: FlightClock, type: string, at: number): FlightClock {
	if (type === "agent_start" && !c.inFlight) return { inFlight: true, accrued: c.accrued, mark: at };
	if (type === "agent_end" && c.inFlight) return { inFlight: false, accrued: c.accrued + Math.max(0, at - c.mark), mark: at };
	return c;
}
/** Progress (or a hold): the clock restarts from zero at `at`, in or out of a turn as it was. */
export const flightReset = (c: FlightClock, at: number): FlightClock => ({ inFlight: c.inFlight, accrued: 0, mark: at });
/** In-turn milliseconds since the last reset. */
export const flightElapsed = (c: FlightClock, at: number): number => c.accrued + (c.inFlight ? Math.max(0, at - c.mark) : 0);

/** The runner's token samples in this run: the first is the run's baseline, the rest cover the burn window. */
export interface BurnWatch {
	samples: readonly { at: number; tokens: number }[];
}
export const BURN_WATCH_START: BurnWatch = { samples: [] };
export interface BurnStep {
	watch: BurnWatch;
	/** Tokens since the newest sample at least a window old (the baseline before a window has passed). */
	window: number;
	/** Tokens since the run's baseline. */
	total: number;
	/** The minutes `window` covers. */
	windowMin: number;
}

/** One sample of the meter's token tally (workload-wide, cumulative); keeps the baseline and what the window needs. */
export function burnStep(w: BurnWatch, at: number, tokens: number, windowMs: number): BurnStep {
	const samples = [...w.samples, { at, tokens }];
	const base = samples[0]!;
	let from = 0;
	for (let i = 1; i < samples.length; i++) if (samples[i]!.at <= at - windowMs) from = i;
	const kept = [base, ...samples.slice(Math.max(from, 1))];
	const start = samples[from]!;
	return { watch: { samples: kept }, window: tokens - start.tokens, total: tokens - base.tokens, windowMin: (at - start.at) / 60_000 };
}

const min = (ms: number): string => `${Math.round(ms / 6_000) / 10} min`;
const mtok = (n: number): string => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : String(Math.round(n)));

export function noProgressEvidence(inTurnMs: number, limitMs: number, lastAt: number): string {
	return `${min(inTurnMs)} of in-turn time with no ledger write by the lane but wake-read entries and spend: lines (the last at ${new Date(lastAt).toISOString()}; limit ${min(limitMs)})`;
}
export function burnEvidence(s: BurnStep, limits: RunawayLimits, model: string | null): string {
	return `${mtok(s.window)} tokens in the last ${Math.round(s.windowMin * 10) / 10} min (limit ${mtok(limits.burnTokens)} in ${min(limits.burnWindowMs)}; ${mtok(s.total)} this run) on ${model ?? "the profile default model"}`;
}
export function totalEvidence(s: BurnStep, limits: RunawayLimits, model: string | null): string {
	return `${mtok(s.total)} tokens since this run started (limit ${mtok(limits.totalTokens)}) on ${model ?? "the profile default model"}`;
}

/** The runner's `assumption` entry for a trip (compaction-loop's has the same shape: `compactionLoopBody`). */
export function runawayBody(laneId: string, reason: string, evidence: string): string {
	return `${reason}: ${laneId} stopped by the runner: ${evidence}; a relaunch as it stands is expected to do the same (MIGRATION.md item 111)`;
}
/** `lane-died: <laneId>: <reason>: <evidence>`: the needs-you line (surface/src/errors.ts item 4). */
export function runawayDeathBody(laneId: string, reason: string, evidence: string): string {
	return `${LANE_DIED_PREFIX} ${laneId}: ${reason}: ${evidence}; read the lane's session before relaunching`;
}
