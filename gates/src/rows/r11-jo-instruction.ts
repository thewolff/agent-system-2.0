// P-11 row 11 (DESIGN-2.0.md:348; SPEC-2.0.md:428-429 § B5): Jo's direct instruction to a lane is
// recorded as a ledger entry, same as a surface message — written by machinery before the lane's
// turn, through the ledger module. Trigger: OMP's `input` event with source "interactive" (a person
// typed it; omp types.ts:913-918) in a lane bound to a workload.
//
// A failed write stops the turn (astra review B6): the adapter consumes the input (`handled: true`,
// omp types.ts InputEventResult) so no turn runs on an unrecorded instruction, and the recorder holds
// the text. The next input retries the held instruction first; a held instruction that did reach
// the ledger before the error (same lane, same body, since the attempt) is not written twice.
import type { GateLedger } from "../types";

export interface InstructionInput {
	text: string;
	source: "interactive" | "rpc" | "extension";
	workloadId: string;
	laneId: string;
}

/** The instruction body when the input is Jo's instruction; null for non-interactive, empty or slash-command input. */
function instructionBody(text: string, source: InstructionInput["source"]): string | null {
	const body = text.trim();
	return source !== "interactive" || body === "" || /^\/[\w:-]+(\s|$)/.test(body) ? null : body;
}

/**
 * Records the instruction; returns its id, or null when the input is not Jo's instruction
 * (non-interactive source, empty, or a harness slash command). Throws when the ledger write fails.
 */
export function recordJoInstruction(ledger: Pick<GateLedger, "recordInstruction">, input: InstructionInput): string | null {
	const body = instructionBody(input.text, input.source);
	if (body === null) return null;
	return ledger.recordInstruction({ by: input.laneId, workloadId: input.workloadId, body, author: "jo", channel: "direct" });
}

export type RecordOutcome = { ok: true; ids: string[] } | { ok: false; error: string; held: string[] };

/** Records each of Jo's instructions before the lane's turn, holding any that failed until they land. */
export class InstructionRecorder {
	#held: { body: string; since: string }[] = [];

	constructor(
		private readonly ledger: () => Pick<GateLedger, "recordInstruction" | "instructions">,
		private readonly workloadId: string,
		private readonly laneId: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	/** Instructions whose write failed and that the next input retries first. */
	get held(): string[] {
		return this.#held.map((h) => h.body);
	}

	/**
	 * Record the held instructions, then this input's. `ok: false` means at least one is still not
	 * in the ledger: the adapter consumes the input so no turn starts.
	 */
	onInput(text: string, source: InstructionInput["source"]): RecordOutcome {
		const body = instructionBody(text, source);
		const queue = [...this.#held];
		if (body !== null && !queue.some((h) => h.body === body)) queue.push({ body, since: this.now() });
		const ids: string[] = [];
		const still: { body: string; since: string }[] = [];
		let error = "";
		for (const item of queue) {
			if (still.length > 0) {
				still.push(item); // keep the order Jo gave them in
				continue;
			}
			try {
				const ledger = this.ledger();
				// Raw rows (PLAN wl-mvfxw3c4zqfzls D5): a landed row Jo since reversed still landed, and is not written again.
				const landed = ledger
					.instructions(this.workloadId, { withReversed: true })
					.find((i) => i.kind === "instruction" && i.body === item.body && i.created_by === this.laneId && i.created_at >= item.since);
				ids.push(landed ? landed.id : ledger.recordInstruction({ by: this.laneId, workloadId: this.workloadId, body: item.body, author: "jo", channel: "direct" }));
			} catch (err) {
				error = String(err);
				still.push(item);
			}
		}
		this.#held = still;
		return still.length === 0 ? { ok: true, ids } : { ok: false, error, held: still.map((h) => h.body) };
	}
}
