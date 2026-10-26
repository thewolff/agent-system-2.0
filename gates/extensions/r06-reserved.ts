// P-11 row 6 as its own extension (astra review S4): the § A4 reserved actions, refused from any agent.
// Each refusal naming a reserved action is recorded as a `reserved-request` entry on the session's
// workload, which the orchestrator surface shows as § B3 item 1 until Jo approves or denies it
// (surface/src/errors.ts waitingReserved). A session with no workload — the orchestrator itself —
// records it on the orchestrator's standing workload (surface/src/identity.ts, opened on first use),
// the one open workload the surface reads that belongs to no lane; a session entry alone never
// reached the surface (M5 fix round 1, Codex S1 / fable F1a). The session entry is kept as the
// transcript's own copy. A pair_write, pair_edit or pair_run is judged, and its request recorded, as its
// write, edit or bash equivalent (src/pair-call.ts canonicalCall).
import { ensureStandingWorkload } from "../../surface/src/identity";
import { canonicalCall } from "../src/pair-call";
import { checkReserved, reservedAction, reservedRequestBody } from "../src/rows/r06-reserved";
import { type GatesAPI, gateSession } from "../src/session";

export default function reservedRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("tool_call", (typed, ctx) => {
		const event = canonicalCall(typed, ctx.cwd);
		const s = gateSession(ctx, env);
		const refusal = checkReserved(event, { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode });
		const action = reservedAction(refusal);
		if (action) {
			const body = reservedRequestBody(event, action, event.toolCallId);
			try {
				const ledger = s.ledger();
				const workloadId = s.workloadId ?? ensureStandingWorkload(ledger);
				ledger.recordEntry({ workloadId, sliceId: s.workloadId ? s.currentSlice() : null, kind: "reserved-request", body, by: s.laneId });
				if (!s.workloadId) pi.appendEntry("p11-reserved-request", { body, workloadId });
			} catch (err) {
				ctx.ui.notify(`P-11 row 6 refused a reserved action and the reserved-request entry could not be written: ${String(err)}`, "warning");
			}
		}
		return refusal ?? undefined;
	});
}
