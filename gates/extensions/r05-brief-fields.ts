// P-11 row 5 as its own extension (astra review S4): a dispatch carries the six § B9 brief fields,
// and in a session bound to a workload, that workload (M4 fix round 4, S6). Each brief, and in a bound
// session each `pair_propose` card, carries a "How it fails" section (issue #334 item 2); a pass on the
// `How it fails: n/a, <reason>` line, or on the gate's error bypass, is recorded on the workload.
import { checkHowItFails, howItFailsNote } from "../src/how-it-fails";
import { dispatchItems } from "../src/rows/r04-tier-name";
import { checkBriefFields, checkCard } from "../src/rows/r05-brief-fields";
import { type GateSession, type GatesAPI, gateSession } from "../src/session";
import type { Refusal } from "../src/types";

/** Record each n/a or bypass pass; a failed write refuses the call (once, resubmittable) rather than let an unrecorded skip through. */
function recordPasses(s: GateSession, notes: string[]): Refusal {
	if (notes.length === 0 || s.workloadId === null) return null;
	try {
		for (const body of notes) s.ledger().recordEntry({ by: s.laneId, workloadId: s.workloadId, kind: "assumption", body });
		return null;
	} catch (err) {
		return {
			block: true,
			reason:
				`P-11 row 5: this call passed on the "How it fails: n/a" line, but recording that on the ledger failed (${err instanceof Error ? err.message : String(err)}), ` +
				'so it is refused rather than let an unrecorded skip through. Write a "How it fails" section instead, or submit it again.',
		};
	}
}

export default function briefFieldsRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "task" && event.toolName !== "pair_propose") return undefined;
		const s = gateSession(ctx, env);
		if (event.toolName === "pair_propose") {
			// A paired lane's card. Outside an as2 workload (Jo pairing in a plain session) the card is not as2's to gate.
			if (s.workloadId === null) return undefined;
			const { refusal, verdict } = checkCard(event.input);
			const note = howItFailsNote(verdict, "pair_propose card");
			return (refusal ?? recordPasses(s, note === null ? [] : [note])) ?? undefined;
		}
		const refusal = checkBriefFields(event.input, s.workloadId);
		if (refusal) return refusal;
		const context = typeof event.input.context === "string" ? event.input.context : "";
		const notes: string[] = [];
		for (const item of dispatchItems(event.input)) {
			const task = typeof item.task === "string" ? item.task : "";
			const name = typeof item.name === "string" ? item.name : "?";
			const note = howItFailsNote(checkHowItFails(`${context}\n${task}`, "the brief"), `dispatch brief ${name}`);
			if (note !== null) notes.push(note);
		}
		return recordPasses(s, notes) ?? undefined;
	});
}
