// P-11 row 3 as its own extension (astra review S4): the session's tool history, a hand's yield
// flagged in place (never blocked), and a top-level turn's receipts flagged into the session. A
// turn is `before_agent_start` to `session_stop`; its working calls (workCall) feed the zero-label
// check and its trivial-ask carve-out (src/rows/r03-receipts.ts header). A pair_write, pair_edit or
// pair_run counts as its write, edit or bash equivalent (src/pair-call.ts).
import { canonicalCall, canonicalResult } from "../src/pair-call";
import { checkReceipts, historyEvent, renderFlags, workCall } from "../src/rows/r03-receipts";
import { type GatesAPI, type GateSession, gateSession, messageText } from "../src/session";

/** Names of the working calls each session's current turn has made. Kept here: no other row reads it. */
const turns = new WeakMap<GateSession, string[]>();

/**
 * Every string in a yield's `data`, flagged in place: a hand's report may sit in any field or nested
 * object, not only `data.report` (astra review S2). Returns the value unchanged when nothing flags.
 */
function flagStrings(value: unknown, check: (s: string) => string[], depth = 0): { value: unknown; flagged: boolean } {
	if (typeof value === "string") {
		const flags = check(value);
		return flags.length > 0 ? { value: value + renderFlags(flags), flagged: true } : { value, flagged: false };
	}
	if (depth >= 6 || value === null || typeof value !== "object") return { value, flagged: false };
	let flagged = false;
	if (Array.isArray(value)) {
		const out = value.map((v) => {
			const r = flagStrings(v, check, depth + 1);
			flagged ||= r.flagged;
			return r.value;
		});
		return { value: flagged ? out : value, flagged };
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		const r = flagStrings(v, check, depth + 1);
		flagged ||= r.flagged;
		out[k] = r.value;
	}
	return { value: flagged ? out : value, flagged };
}

export default function receiptsRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	pi.on("before_agent_start", (_event, ctx) => {
		turns.set(gateSession(ctx, env), []);
		return undefined;
	});

	pi.on("tool_result", (result, ctx) => {
		const event = canonicalResult(result, ctx.cwd);
		const s = gateSession(ctx, env);
		const h = historyEvent(event.toolName, s.originalInput(event), event.details, event.isError);
		if (h) s.history.push(h);
		return undefined;
	});

	// Row 3 at a hand's exit: flag the report, never block (SPEC-2.0.md § B15 item 5).
	pi.on("tool_call", (event, ctx) => {
		const s = gateSession(ctx, env);
		const call = canonicalCall(event, ctx.cwd);
		if (s.role !== "hand" && workCall(call.toolName, call.input, ctx.cwd, env)) {
			const turn = turns.get(s);
			if (turn) turn.push(event.toolName);
			else turns.set(s, [event.toolName]);
		}
		if (s.role !== "hand" || event.toolName !== "yield") return undefined;
		const r = flagStrings(event.input.data, (text) => checkReceipts(text, s.history, ctx.cwd));
		return r.flagged ? { input: { ...event.input, data: r.value } } : undefined;
	});

	pi.on("session_stop", (event, ctx) => {
		const s = gateSession(ctx, env);
		if (s.role === "hand") return undefined;
		const flags = checkReceipts(messageText(event.last_assistant_message), s.history, ctx.cwd, turns.get(s) ?? []);
		if (flags.length > 0) pi.appendEntry("p11-receipts", { flags });
		return undefined;
	});
}
