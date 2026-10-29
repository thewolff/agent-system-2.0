// P-11 row 4 as its own extension (astra review S4): a dispatch names one of the four tier files.
import { selfRepairOn } from "../src/self-repair";
import { checkTierName } from "../src/rows/r04-tier-name";
import type { GatesAPI } from "../src/session";

export default function tierNameRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("tool_call", (event) => (event.toolName === "task" && !selfRepairOn(env) ? (checkTierName(event.input) ?? undefined) : undefined));
}
