// P-11 row 1 as its own extension (astra review S4): the turn shape of a message to Jo, refused at a
// top-level session's stop. Hands never talk to Jo (and OMP fires no session_stop for them). The
// orchestrator is held to its own rule: it hands Jo no command at all.
//
// On the orchestrator a refused reply is withheld (MIGRATION.md item 37, Jo's "withhold"):
// `assistant_message` checks the turn's final reply (no toolCall block) before OMP
// persists or sends it on (types.ts:873-887), replaces its text with one fixed marker line and
// keeps the original here. The marker quotes nothing from the draft or the refusal, since the
// refusal names the defect (a refused command among them) and Jo must not see it republished.
// Text already streamed is not retracted, so a stream-rendering client may show the draft while
// it streams; the finalized reply is the marker. The `session_stop` that follows decides from that
// stored refusal, never from the marker (which itself passes the check), and its hidden
// continuation carries the full reason and the original so the rewrite starts from the draft.
// Jo's history holds the marker and the corrected reply, once each. One marker shows per prompt:
// a later hold in the same prompt (a refused rewrite) has each text block replaced by "…" instead,
// with the same block shape, and still blocks at `session_stop` with its full reason and original.
// The marker shows again after Jo's `input` or a reply that passes row 1. A lane's reply is never
// rewritten: its refusal and rewrite both stay on screen, as before.
//
// Row 15's publication binding rides the same hold (Codex review of PR #55, B2): an orchestrator
// reply that passes row 1 is then bound to its question rows (gates/src/rows/r15-orchestrator-role.ts
// checkQuestionPublication) — every `q-…` its QUESTION blocks name is an open row on the standing
// slice no earlier reply cited — and a refusal is withheld exactly like a row 1 refusal; a passing
// reply's rows are cited in the ledger (recordPublication). `session_stop` re-binds the last reply
// against the citations, so a QUESTION that reached Jo with no row never ends the turn. A ledger
// that cannot be read refuses rather than passing the reply unchecked. A reply naming no question
// never opens the ledger, and a ledger that cannot be read still refuses a reply that names one.
// The hold is kept on the session (`heldReply`) past the stop's block, until a reply passes or Jo's
// next `input`: row 15 refuses working calls under it, since the session file carries only the marker.
import { affirmativeDeleteRequest, fallbackAuthorization } from "../src/dispositions";
import { checkTurnShape, turnShapeWarnings } from "../src/rows/r01-turn-shape";
import { checkQuestionPublication, recordPublication } from "../src/rows/r15-orchestrator-role";
import { type GatesAPI, type GateSession, gateSession, messageText } from "../src/session";

/**
 * Sessions that have shown WITHHELD_MARKER in the current prompt. Cleared by Jo's `input` and by a
 * reply that passes row 1 (so an aside-started turn, which has no `input`, shows it again); never by
 * `before_agent_start`, which also fires on the session_stop continuation that carries the rewrite.
 */
const markerShown = new WeakSet<GateSession>();

/** What Jo sees in place of a withheld reply: fixed, so nothing refused reaches Jo's screen. Passes row 1. */
const WITHHELD_MARKER = "(Reply held by P-11 row 1. The corrected reply follows.)";

/** Every text block of a later hold in the same prompt. Non-empty after trim: an empty reply is an empty stop to OMP, which skips session_stop. */
const LATER_HOLD = "…";

/** Row 1, then row 15's binding, over the orchestrator's final reply: the refusal reason, or null. Records the citation when the reply passes. */
function orchestratorReply(s: GateSession, text: string): string | null {
	const shape = checkTurnShape(text, "orchestrator");
	if (shape) return shape.reason;
	try {
		const bound = checkQuestionPublication(text, () => s.ledger());
		if (!bound.ok) return bound.reason;
		recordPublication(() => s.ledger(), bound.questionIds, s.laneId);
		return null;
	} catch (err) {
		return `P-11 row 15 could not bind this reply's QUESTION to the ledger (${String(err)}); the reply is held`;
	}
}

export default function turnShapeRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	const trustedAction = new WeakMap<GateSession, string>();
	pi.on("input", (event, ctx) => {
		const s = gateSession(ctx, env);
		markerShown.delete(s);
		s.heldReply = null;
		if (event.source === "interactive") {
			const prior = trustedAction.get(s);
			const direct = fallbackAuthorization(event.text);
			const inherited = prior ? fallbackAuthorization(event.text, prior) : null;
			s.commandFallbackAuthorization = direct ?? inherited;
			if (affirmativeDeleteRequest(event.text)) trustedAction.set(s, event.text);
			else trustedAction.delete(s);
		} else {
			s.commandFallbackAuthorization = null;
			trustedAction.delete(s);
		}
		s.pendingCommandFallback = null;
		return undefined;
	});

	pi.on("assistant_message", (event, ctx) => {
		const s = gateSession(ctx, env);
		const content = event.message.content;
		if (s.pendingCommandFallback && Array.isArray(content) && !content.some((p) => p.type === "toolCall")) {
			const { fallback, blocker } = s.pendingCommandFallback;
			s.pendingCommandFallback = null;
			const longest = Math.max(2, ...[...fallback.command.matchAll(/`+/g)].map((m) => m[0].length));
			const fence = "`".repeat(longest + 1);
			const rendered = [
				`Execution blocker: ${blocker}`,
				`Execution status: ${fallback.status}.`,
				`Impact: ${fallback.impact}`,
				`Reversal: ${fallback.reversal}`,
				`${fence}bash`,
				fallback.command,
				fence,
			].join("\n");
			const first = content.findIndex((p) => p.type === "text");
			return { content: content.map((p, i) => (p.type !== "text" ? p : { ...p, text: i === first ? rendered : "" })) };
		}
		if (s.role !== "orchestrator" || !Array.isArray(content) || content.some((p) => p.type === "toolCall")) return undefined;
		const original = messageText(event.message);
		const reason = orchestratorReply(s, original);
		if (!reason) {
			s.heldReply = null;
			markerShown.delete(s);
			for (const warning of turnShapeWarnings(original, "orchestrator")) ctx.ui.notify(`P-11 row 1 warning: ${warning}`, "warning");
			return undefined;
		}
		s.heldReply = { original, reason };
		if (markerShown.has(s)) return { content: content.map((p) => (p.type !== "text" ? p : { ...p, text: LATER_HOLD })) };
		markerShown.add(s);
		const first = content.findIndex((p) => p.type === "text");
		return { content: content.map((p, i) => (p.type !== "text" ? p : { ...p, text: i === first ? WITHHELD_MARKER : "" })) };
	});

	pi.on("session_stop", (event, ctx) => {
		const s = gateSession(ctx, env);
		if (s.role === "hand") return undefined;
		// The hold stands past the block (row 15 refuses work under it) until a reply passes or Jo's next input.
		const withheld = s.heldReply;
		if (withheld) {
			return { decision: "block", reason: `${withheld.reason}\n\nYour held reply was:\n\n${withheld.original}` };
		}
		const text = messageText(event.last_assistant_message);
		const role = s.role === "orchestrator" ? "orchestrator" : "lane";
		const refusal = checkTurnShape(text, role);
		if (refusal) return { decision: "block", reason: refusal.reason };
		if (s.role !== "orchestrator") {
			for (const warning of turnShapeWarnings(text, "lane")) ctx.ui.notify(`P-11 row 1 warning: ${warning}`, "warning");
			return undefined;
		}
		try {
			const bound = checkQuestionPublication(text, () => s.ledger(), true);
			return bound.ok ? undefined : { decision: "block", reason: bound.reason };
		} catch (err) {
			return { decision: "block", reason: `P-11 row 15 could not bind this reply's QUESTION to the ledger (${String(err)}); the turn does not end unchecked` };
		}
	});
}
