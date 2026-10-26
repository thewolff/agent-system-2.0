// P-11 row 10 as its own extension (astra review S4): no raw write to the ledger file outside the module.
// A pair_write, pair_edit or pair_run is judged as its write, edit or bash equivalent (src/pair-call.ts canonicalCall).
import { canonicalCall } from "../src/pair-call";
import { checkRawLedgerWrite } from "../src/rows/r10-raw-ledger";
import { type GatesAPI, gateSession } from "../src/session";

export default function rawLedgerRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("tool_call", (event, ctx) => {
		const s = gateSession(ctx, env);
		return checkRawLedgerWrite(canonicalCall(event, ctx.cwd), { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode }) ?? undefined;
	});
}
