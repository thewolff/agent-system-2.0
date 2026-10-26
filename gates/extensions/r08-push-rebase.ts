// P-11 row 8 as its own extension (astra review S4): a push waits on containing the push target's
// freshly fetched upstream and on a passing test record for its tree on the session's workload,
// read from the ledger (`artifact-tree:`, written by surface/extensions/lane.ts). Refusals in a row
// on one slice become lane→orchestrator `artifact-failed:` messages (§ B3 item 3, PushFailures); the
// let-through push that then succeeds ends the run with one `artifact-passed:` (M5 fix round 1,
// Codex S3: decided on the result, since a let-through push the remote rejects is not a pass).
// A push row 8 lets through leaves one `push-dest: <remote> <branch> <sha>` entry per branch it
// updates (MIGRATION.md item 24; wl-muraerdsgw7gn4 PLAN.md § 2.2 step 2), written here at tool_call
// before the push runs, as the lane holding the workload: those branches bind the workload's test
// runs and close check. It does not wait for the push's success; a recorded push that then fails
// only adds a branch to the close check.
import { artifactTrees } from "../../surface/src/signals";
import { type PushDest, pushDestBody } from "../../surface/src/test-run";
import { bashCommand } from "../src/exec";
import { canonicalCall, canonicalResult } from "../src/pair-call";
import { blockingSuccess, judgePush, pushChecked } from "../src/rows/r08-push-rebase";
import { type GateSession, type GatesAPI, gateSession } from "../src/session";
import type { Refusal } from "../src/types";

/** The recipient of lane→orchestrator messages (surface/src/signals.ts reads them by body prefix and slice). */
const ORCHESTRATOR = "orchestrator";

/**
 * Writes the `push-dest:` entries of a push row 8 let through. A session outside any lane (no
 * workload, or the orchestrator) records nothing. An entry that cannot be written refuses the push:
 * an unrecorded destination is a branch the workload's close check would never see.
 */
function recordDestinations(s: GateSession, dests: PushDest[], cmd: string): Refusal {
	if (dests.length === 0 || !s.workloadId || s.role === "orchestrator") return null;
	try {
		const ledger = s.ledger();
		for (const d of dests) ledger.recordEntry({ by: s.laneId, workloadId: s.workloadId, kind: "assumption", body: pushDestBody(d) });
		return null;
	} catch (err) {
		return {
			block: true,
			reason: `P-11 row 8 refused this push: its destination could not be recorded on the workload (${String(err)}), and an unrecorded destination is a branch the close check would not see. Make the ledger writable. Then push in its own command. Command: ${cmd}`,
		};
	}
}

export default function pushRebaseRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	// A pair_run is judged, and its outcome counted, as its bash equivalent (src/pair-call.ts).
	pi.on("tool_result", (result, ctx) => {
		const event = canonicalResult(result, ctx.cwd);
		if (event.toolName !== "bash") return undefined;
		const s = gateSession(ctx, env);
		const original = String(s.originalInput(event).command ?? "");
		const ok = blockingSuccess(event.details, event.isError);
		const callCtx = { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode };
		if (ok && pushChecked({ toolName: "bash", input: { ...event.input, command: original } }, callCtx)) {
			const slice = s.workloadId ? s.currentSlice() : null;
			const body = s.pushFailures.passed(slice, event.toolCallId ?? "unknown");
			if (body && s.workloadId && slice) {
				try {
					s.ledger().enqueue({ by: s.laneId, workloadId: s.workloadId, sliceId: slice, sender: s.laneId, recipient: ORCHESTRATOR, body });
				} catch (err) {
					ctx.ui.notify(`P-11 row 8 let a push through and the artifact-passed message to the orchestrator could not be written: ${String(err)}`, "warning");
				}
			}
		}
		return undefined;
	});

	pi.on("tool_call", (typed, ctx) => {
		const event = canonicalCall(typed, ctx.cwd);
		const s = gateSession(ctx, env);
		const callCtx = { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode };
		const workloadId = s.workloadId;
		const judged = judgePush(event, callCtx, workloadId ? () => artifactTrees(s.ledger(), workloadId) : null);
		const refusal = judged.refusal ?? recordDestinations(s, judged.dests, bashCommand(event.input));
		if (!refusal) return undefined;
		// A session with no workload has no slice the surface could name, so no message is owed.
		if (s.workloadId) {
			try {
				const slice = s.currentSlice();
				if (slice) {
					for (const body of s.pushFailures.refused(slice, event.toolCallId ?? "unknown", refusal.reason)) {
						s.ledger().enqueue({ by: s.laneId, workloadId: s.workloadId, sliceId: slice, sender: s.laneId, recipient: ORCHESTRATOR, body });
					}
				}
			} catch (err) {
				ctx.ui.notify(`P-11 row 8 refused a push and the artifact-failed message to the orchestrator could not be written: ${String(err)}`, "warning");
			}
		}
		return refusal;
	});
}
