import { selfRepairToolRefusal } from "../src/self-repair";
import { type GatesAPI, gateSession } from "../src/session";

export default function selfRepairRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("tool_call", (event, ctx) => selfRepairToolRefusal(event, ctx.cwd, env) ?? undefined);
}
