// P-11 row 6 as its own extension (astra review S4): the § A4 reserved actions, refused from any agent.
// Each refusal naming a reserved action is recorded as a `reserved-request` entry on the session's
// workload, which the orchestrator surface shows as § B3 item 1 until Jo approves or denies it
// (surface/src/errors.ts waitingReserved). A session with no workload — the orchestrator itself —
// records it on the orchestrator's standing workload (surface/src/identity.ts, opened on first use),
// the one open workload the surface reads that belongs to no lane; a session entry alone never
// reached the surface (M5 fix round 1, Codex S1 / fable F1a). The session entry is kept as the
// transcript's own copy.
import type { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../../surface/src/identity";
import { checkReserved, deploymentCandidate, judgeDeploy, recordDeployResult, type DeployPending, type DeployToolCall, type MergeView, reservedAction, reservedRequestBody } from "../src/rows/r06-reserved";
import { type Ctx, type GatesAPI, gateSession } from "../src/session";
import type { DeployFacts } from "../src/deploy-risk";

export interface ReservedOptions { deferAdmission?: boolean; timeoutMs?: number }

// With the aggregate extension, only the read-only reserved pass runs here; its admission handler
// is registered after the fence. Standalone row profiles have no later aggregate gates.
export default function reservedRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env, facts?: (ledger: Ledger) => DeployFacts, mergeView?: MergeView, options: ReservedOptions = {}): () => void {
	const pending = new Map<string, DeployPending>();
	pi.on("tool_result", (event, ctx) => {
		const admitted = event.toolCallId ? pending.get(event.toolCallId) : undefined;
		if (!admitted || event.toolName !== "bash") return;
		try {
			const details = event.details && typeof event.details === "object" ? event.details : {};
			const content = "content" in event && Array.isArray(event.content) ? event.content : [];
			const output = content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
			recordDeployResult(gateSession(ctx, env).ledger(), admitted, { ...details, ...(output ? { output } : {}) }, event.isError);
		} catch (err) {
			ctx.ui.notify(`P-11 row 6 could not record deploy/merge result; outcome remains unsettled: ${String(err)}`, "warning");
		} finally {
			pending.delete(event.toolCallId!);
		}
	});
	const handler = async (event: DeployToolCall, ctx: Ctx) => {
		const s = gateSession(ctx, env);
		const call = { ...event, input: s.originalInput(event) };
		const callCtx = { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode };
		if (deploymentCandidate(call, callCtx)) {
			try {
				const ledger = s.ledger();
				const judged = await judgeDeploy(call, callCtx, { ledger, workloadId: s.workloadId ?? ensureStandingWorkload(ledger), laneId: s.laneId, facts: facts?.(ledger), mergeView, timeoutMs: options.timeoutMs });
				if (judged) {
					const otherAction = reservedAction(judged.refusal);
					if (otherAction) ledger.recordEntry({ workloadId: s.workloadId ?? ensureStandingWorkload(ledger), sliceId: s.workloadId ? s.currentSlice() : null, by: s.laneId, kind: "reserved-request", body: reservedRequestBody(call, otherAction, event.toolCallId) });
					if (judged.pending && event.toolCallId) pending.set(event.toolCallId, judged.pending);
					return judged.refusal ?? undefined;
				}
			} catch (err) {
				return { block: true, reason: `P-11 row 6 hold: E0 deploy admission unavailable (${String(err)})` };
			}
		}
		const refusal = checkReserved(call, callCtx);
		const action = reservedAction(refusal);
		if (action) {
			const body = reservedRequestBody(call, action, event.toolCallId);
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
	};
	if (!options.deferAdmission) {
		pi.on("tool_call", handler);
		return () => {};
	}
	const candidate = (event: DeployToolCall, ctx: Ctx) => {
		const s = gateSession(ctx, env);
		return deploymentCandidate({ ...event, input: s.originalInput(event) }, { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode });
	};
	pi.on("tool_call", (event, ctx) => candidate(event, ctx) ? undefined : handler(event, ctx));
	return () => pi.on("tool_call", (event, ctx) => candidate(event, ctx) ? handler(event, ctx) : undefined);
}
