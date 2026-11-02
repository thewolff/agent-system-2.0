// Jo's word to set a workload's lane model without launching (PLAN wl-mvwk0v0gmp6cjc D1).
//
// `orchestrator_set_lane_model { workloadId, model }` writes exactly one `lane-model:` entry
// (`laneModelBody`, by the surface) on an open workload: autonomous or user-driven, idle or held by a
// lane under a live lease. It writes no `launch-requested:`, execs no starter, releases no hold, takes
// no pick snapshot and touches no lease, so a running lane keeps its model and the next lane on the
// workload starts on the new one (`laneModel` is read at every spawn). A bad model, a missing or
// closed workload, the standing workload and a `due:` row are refused with nothing written, as the
// launch tool refuses them (surface/extensions/launch.ts). P-11 row 15 scopes its answer-first check
// to the named workload's questions (gates/src/rows/r15-orchestrator-role.ts SCOPED).
import { JO_HOLDER, laneModelBody, modelProblem } from "../src/launch";
import { surfaceSession } from "../src/session";
import { DUE_PREFIX, SET_LANE_MODEL_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY, type ToolResult } from "../src/types";

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");

export default function laneModelRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;
	pi.registerTool({
		name: SET_LANE_MODEL_TOOL,
		loadMode: "essential",
		label: "Set Lane Model",
		description:
			"Jo's word only: set the model this workload's lanes run on, without launching anything. " +
			"Writes one `lane-model:` entry on an open workload (autonomous or user-driven, idle or held by a running lane) and nothing else: no launch request, no lane start, no lease change. " +
			"A lane already running keeps its current model; the next lane on the workload starts on the new one. " +
			"`model` is an exact `provider/model` (e.g. `openai-codex/gpt-6-sol`) on a provider with a known lab, no `:level` suffix; `default` clears a named model, so lanes run on the profile default.",
		parameters: z.object({
			workloadId: z.string().describe("The open workload (wl-…)."),
			model: z.string().describe("Jo's named model: exact provider/model (e.g. openai-codex/gpt-6-sol), no :level; `default` clears it."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const id = String(params.workloadId ?? "").trim();
			const model = typeof params.model === "string" ? params.model.trim() : "";
			const problem = model === ""
				? "no model was named; name an exact provider/model, e.g. openai-codex/gpt-6-sol, or `default`"
				: modelProblem(model);
			if (problem !== null) return text(`Refused: ${problem}. Nothing was written.`);
			if (id === STANDING_WORKLOAD_ID) return text("Refused: the standing orchestrator workload never has a lane. Nothing was written.");
			const ledger = s.ledger();
			const w = ledger.workload(id);
			if (!w) return text(`Refused: no workload ${id}. Nothing was written.`);
			if (w.status === "closed") return text(`Refused: ${id} is closed (${w.closed_at}). Nothing was written.`);
			if (w.brief.startsWith(DUE_PREFIX)) return text(`Refused: ${id} is a scheduled row: it never has a lane. Nothing was written.`);
			const now = s.now();
			const entryId = ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: laneModelBody(model, now) });
			// The launch tool's live-lease test (surface/extensions/launch.ts): a lane holder whose lease has not run out.
			const liveLane = w.holder !== null && w.holder !== JO_HOLDER && (w.holder_lease_until === null || w.holder_lease_until >= now) ? w.holder : null;
			const tail = liveLane === null ? "" : ` ${liveLane} keeps running on its current model; the next lane on ${id} starts on ${model}.`;
			return text(`Recorded lane model ${model} (${entryId}) on ${id}. No lane launched.${tail}`, { id, entryId, model, liveLane });
		},
	});
}
