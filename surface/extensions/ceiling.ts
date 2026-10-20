// The orchestrator's half of the workload ceiling (DESIGN-workload-ceiling.md § 2 item 2): lowering.
// Raising is Jo's, through the `ceiling` and `extend` words (surface/src/input.ts), each of
// which names Jo's instruction; this tool writes a `ceiling:` entry that lowers either half and
// refuses any value above the one in force, so it never needs one.
import { ceilingBody } from "../src/ceiling";
import { ceilingOf, ceilingText } from "../src/input";
import { surfaceSession } from "../src/session";
import { LOWER_CEILING_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY, type ToolResult } from "../src/types";

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");

export default function ceilingRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;
	pi.registerTool({
		name: LOWER_CEILING_TOOL,
		loadMode: "essential",
		label: "Lower Ceiling",
		description:
			"Lower an open workload's ceiling: dollars, wall minutes, or both, each at or below the value in force. " +
			"Raising is Jo's alone (the words `ceiling <usd> [<hours>] <wl>` and `extend <wl>`); a value above the current one is refused.",
		parameters: z.object({
			workloadId: z.string().describe("The open workload (wl-…)."),
			usd: z.string().optional().describe("The new dollar ceiling, a number (e.g. 20); at or below the current one."),
			wallMinutes: z.string().optional().describe("The new wall ceiling in minutes of lane run time, a number (e.g. 120); at or below the current one."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const id = String(params.workloadId ?? "").trim();
			if (id === STANDING_WORKLOAD_ID) return text("The standing orchestrator workload has no ceiling; nothing was written.");
			const ledger = s.ledger();
			const w = ledger.workload(id);
			if (!w) return text(`No workload ${id}; nothing was written.`);
			if (w.status === "closed") return text(`${id} is closed (${w.closed_at}); nothing was written.`);
			const given = (v: unknown): number | null => (v === undefined || v === null || String(v).trim() === "" ? null : Number(v));
			const usd = given(params.usd);
			const wallMin = given(params.wallMinutes);
			if (usd === null && wallMin === null) return text("Pass usd, wallMinutes, or both; nothing was written.");
			for (const [name, v, raw] of [["usd", usd, params.usd], ["wallMinutes", wallMin, params.wallMinutes]] as const) {
				if (v !== null && !(Number.isFinite(v) && v > 0)) return text(`${name} must be a positive number, not ${String(raw)}; nothing was written.`);
			}
			const cur = ceilingOf(ledger, id);
			const over = [
				...(usd !== null && usd > cur.usd ? [`$${usd} is above the $${cur.usd} in force`] : []),
				...(wallMin !== null && wallMin > cur.wallMin ? [`${wallMin} min is above the ${cur.wallMin} min in force`] : []),
			];
			if (over.length > 0) return text(`Refused: ${over.join("; ")}. Raising is Jo's (the words \`ceiling <usd> [<hours>] ${id}\` and \`extend ${id}\`); nothing was written.`);
			const next = { usd: usd ?? cur.usd, wallMin: wallMin ?? cur.wallMin };
			const entryId = ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: ceilingBody(next, "lowered by orchestrator") });
			pi.appendEntry("surface-ceiling", { id, entryId, ...next });
			return text(`Lowered the ceiling on ${id} from ${ceilingText(cur)} to ${ceilingText(next)} (entry ${entryId}).`, { id, entryId, ceiling: next, was: cur });
		},
	});
}
