/**
 * The `stop-reviews` word's entry (PLAN wl-mupu0sx2o046io D10; SPEC-2.0.md § B4, *Amended
 * 2026-10-01 — review round limit*). Jo's `stop-reviews [wl-… | sl-…]` at the surface writes the
 * instruction `stop-reviews: <target>`, then `review-stop: <target> by <instruction id>`; the
 * classifier reads the entry and refuses a further review round on a stopped loop. No OMP import,
 * no I/O: the surface writes the bodies, the classifier reads them back through `reviewStopOn`.
 */
import { joAuthority } from "../../ledger/src/authority";
import type { EntryRow, InstructionRow } from "../../ledger/src/index";

/** What a stop names: a whole workload (`wl-…`) or one slice's loop (`sl-…`). */
const TARGET = /^(?:wl|sl)-\S+$/;

/** The Jo instruction the surface's `stop-reviews` word writes. */
export function stopReviewsInstructionBody(target: string): string {
	return `stop-reviews: ${target}`;
}

/** `review-stop: <wl-…|sl-…> by <instruction id>`: the loops of `target` take no further review round. */
export function reviewStopBody(target: string, by: string): string {
	return `review-stop: ${target} by ${by}`;
}

const REVIEW_STOP = /^review-stop:\s+(\S+)\s+by\s+(in-\S+)$/;

export function parseReviewStop(body: string): { target: string; by: string } | null {
	const m = REVIEW_STOP.exec(body.trim());
	return m && TARGET.test(m[1]!) ? { target: m[1]!, by: m[2]! } : null;
}

/**
 * The instruction id of the oldest valid stop covering `sliceId` of `workloadId`, else null. A
 * `review-stop:` entry counts only when its `by` names a Jo instruction the surface wrote (author
 * `jo`, written by the surface) whose body is `stop-reviews: <the same target>`, and its target is
 * the workload or the slice. `entries` and `instructions` are the workload's.
 */
export function reviewStopOn(
	entries: readonly Pick<EntryRow, "kind" | "body">[],
	instructions: readonly Pick<InstructionRow, "id" | "author" | "body" | "created_by">[],
	workloadId: string,
	sliceId: string,
): string | null {
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const s = parseReviewStop(e.body);
		if (!s || (s.target !== workloadId && s.target !== sliceId)) continue;
		const i = instructions.find((x) => x.id === s.by && joAuthority(x));
		if (i && i.body.trim() === stopReviewsInstructionBody(s.target)) return s.by;
	}
	return null;
}
