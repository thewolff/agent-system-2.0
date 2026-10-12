// The nightly chaos run's fault triggers as pure predicates (PLAN wl-mv5lpzqacbe5ts § 2.4 item 3), so a
// refactor of what they read (the launcher's `lane-started:` / `lane-exit:` records, the lane-died writers,
// the classifier's `hand-spawn:` / `hand-settled:` lines, the stub's holds) fails a plain `bun test`
// (surface/test/chaos-bindings.test.ts), not the next night. surface/scripts/chaos.ts `Run.trigger` and its
// stub matcher call them and keep every action (the kills, the stub modes, the second runner) and its order;
// each predicate decides only whether, and on what, its fault fires. Nothing here reads or writes anything.
import { parseHandSpawn, settledTokens } from "../../classifier/src/lab";
import type { EntryRow } from "../../ledger/src/index";
import { type LaneStart, laneStarts } from "./chaos";
import { LANE_ADD_SLICE_TOOL } from "./types";

type Entry = Pick<EntryRow, "id" | "kind" | "body" | "created_at">;

/** A `hand-spawn:` as the triggers read it: its token, whether it is a review, when it was written, and whether a `hand-settled:` names it. */
export interface ChaosSpawn {
	token: string;
	review: boolean;
	at: string;
	settled: boolean;
}

/** What a trigger reads of one stub hold (surface/scripts/chaos-stub.ts `HeldRequest`). */
export interface HeldView {
	id: number;
	kind: string;
	outcome: string;
}

/** One trigger check's reads: the workload's hand spawns and the stub's holds. */
export interface TriggerView {
	spawns: readonly ChaosSpawn[];
	held: readonly HeldView[];
}

/** Every `hand-spawn:` entry in entry order, each with its settled state (`handSpawns` in classifier/src/lab.ts is the classifier's own reader). */
export function chaosSpawns(entries: readonly Entry[]): ChaosSpawn[] {
	const settled = settledTokens(entries);
	return entries.flatMap((e) => {
		const s = parseHandSpawn(e.body);
		return s ? [{ token: s.token, review: s.review, at: e.created_at, settled: settled.has(s.token) }] : [];
	});
}

/** The stub's first open hold of session `kind`, if any. */
const openHeld = (held: readonly HeldView[], kind: string): HeldView | undefined => held.find((h) => h.kind === kind && h.outcome === "open");

/**
 * How the lane ended, if it has: its `lane-exit:` entry, else a `lane-died:` message naming it. `Run`'s trigger loop
 * refuses to inject once this is non-null, for every fault ("the lane ended before the trigger").
 */
export function laneEnd(entries: readonly Pick<EntryRow, "body" | "created_at">[], messages: readonly { body: string; created_at: string }[], laneId: string): { body: string; at: string } | null {
	const e = entries.find((x) => x.body.startsWith(`lane-exit: ${laneId} `));
	if (e) return { body: e.body, at: e.created_at };
	const m = messages.find((x) => x.body.startsWith(`lane-died: ${laneId}`));
	return m ? { body: m.body, at: m.created_at } : null;
}

/** Fault 1's target: the unsettled change hand, its open stub hold, and the lane's newest `lane-started:` (the omp to kill, and the runner). */
export interface HandKill {
	hand: ChaosSpawn;
	held: HeldView;
	start: LaneStart;
}

/**
 * Fault 1 (lane-kill-mid-hand): null until an unsettled non-review hand is spawned and the stub holds an open `hand`
 * request; then the target, or `{ error: "no lane-started" }` when the lane has no `lane-started:` record to kill by.
 * The error is the run's immediate HarnessError, never a not-ready poll.
 */
export function handKillTarget(o: { spawns: readonly ChaosSpawn[]; held: readonly HeldView[]; starts: readonly LaneStart[]; laneId: string }): HandKill | { error: "no lane-started" } | null {
	const hand = o.spawns.find((s) => !s.review && !s.settled);
	const held = openHeld(o.held, "hand");
	if (!hand || !held) return null;
	const start = o.starts.filter((s) => s.laneId === o.laneId).at(-1);
	if (!start) return { error: "no lane-started" };
	return { hand, held, start };
}

/** Fault 2's first step: the lane has a `lane-started:` record, so the orchestrator chaos kills later is started now (Run starts it once). */
export function orchestratorBootDue(entries: readonly Entry[], laneId: string): boolean {
	return laneStarts(entries).some((s) => s.laneId === laneId);
}

/** Fault 2 (orchestrator-kill-mid-review): the unsettled review hand and its open stub hold, once the orchestrator runs; else null. */
export function reviewKillTarget(view: TriggerView & { orchestratorRunning: boolean }): { review: ChaosSpawn; held: HeldView } | null {
	const review = view.spawns.find((s) => s.review && !s.settled);
	const held = openHeld(view.held, "review");
	if (!review || !held || !view.orchestratorRunning) return null;
	return { review, held };
}

/** Fault 3 (network-block-60s): the lane's first hand is spawned. */
export function firstSpawnSeen(view: Pick<TriggerView, "spawns">): boolean {
	return view.spawns.length > 0;
}

/**
 * Fault 4 (provider-refusal), not polled: the stub's lane matcher asks this of the request in hand, before the reply,
 * so the request that arms the refusal is the one refused. Arms once, on the lane's first request carrying a
 * `lane_add_slice` result (the turn after its first slice).
 */
export function refusalArms(request: { results: readonly { name: string | null }[] }, armed: boolean): boolean {
	return !armed && request.results.some((x) => x.name === LANE_ADD_SLICE_TOOL);
}

/** Fault 5 (duplicate-lane-runner): the lane's first `lane-started:` record, the start the second runner duplicates; null until there is one. */
export function firstLaneStart(entries: readonly Entry[], laneId: string): LaneStart | null {
	return laneStarts(entries).find((s) => s.laneId === laneId) ?? null;
}
