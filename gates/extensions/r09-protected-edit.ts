// P-11 row 9 as its own extension (astra review S4): no file write on a protected branch. A pair_write,
// pair_edit or pair_run is judged as its write, edit or bash equivalent (src/pair-call.ts canonicalCall).
import { canonicalCall } from "../src/pair-call";
import { checkProtectedEdit } from "../src/rows/r09-protected-edit";
import { type GatesAPI, gateSession } from "../src/session";

export default function protectedEditRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("tool_call", (event, ctx) => {
		const s = gateSession(ctx, env);
		return checkProtectedEdit(canonicalCall(event, ctx.cwd), { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode }) ?? undefined;
	});
}
