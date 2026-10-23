// P-11 row 5 as its own extension (astra review S4): a dispatch carries the six § B9 brief fields,
// and in a session bound to a workload, that workload (M4 fix round 4, S6).
import { selfRepairOn } from "../src/self-repair";
import { checkBriefFields } from "../src/rows/r05-brief-fields";
import { type GatesAPI, gateSession } from "../src/session";

export default function briefFieldsRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("tool_call", (event, ctx) =>
		event.toolName === "task" && !selfRepairOn(env) ? (checkBriefFields(event.input, gateSession(ctx, env).workloadId) ?? undefined) : undefined,
	);
}
