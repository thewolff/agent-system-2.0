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
// reply's rows are cited in the ledger (recordPublication). The binding also runs on every message
// that carries a tool call (round 2, B3), whose text reaches Jo though row 1 does not judge it: a
// refusal there replaces its text blocks and keeps the tool calls, and that hold stands until the
// turn's `session_stop` delivers it, so a later passing reply cannot end the turn over it.
// `session_stop` re-binds the last reply against the citations, so a QUESTION that reached Jo with
// no row never ends the turn. A ledger that cannot be read refuses rather than passing the reply
// unchecked. A reply naming no question never opens the ledger, and a ledger that cannot be read
// still refuses a reply that names one. The hold is kept on the session (`heldReply`) past the
// stop's block, until a reply passes or Jo's next `input`: row 15 refuses working calls under it,
// since the session file carries only the marker.
import { checkTurnShape } from "../src/rows/r01-turn-shape";
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

/**
 * Row 15's binding alone: the refusal reason, or null. Records the citation when the text passes.
 * The ledger is opened only for text carrying a QUESTION block (checkQuestionPublication opens it
 * itself, and a citation is written only for ids it returned): a reply or a tool-bearing message
 * with no QUESTION never reads it, so an unreadable ledger (the `_as2test` runner, which cannot read
 * `~/.agent-system-2`) costs such a message nothing, while a QUESTION over it is held (fail closed).
 */
function bindQuestions(s: GateSession, text: string): string | null {
	try {
		const bound = checkQuestionPublication(text, () => s.ledger());
		if (!bound.ok) return bound.reason;
		recordPublication(() => s.ledger(), bound.questionIds, s.laneId);
		return null;
	} catch (err) {
		return `P-11 row 15 could not bind this reply's QUESTION to the ledger (${String(err)}); the reply is held`;
	}
}

/** Row 1, then row 15's binding, over the orchestrator's final reply: the refusal reason, or null. Records the citation when the reply passes. */
function orchestratorReply(s: GateSession, text: string): string | null {
	const shape = checkTurnShape(text, "orchestrator");
	return shape ? shape.reason : bindQuestions(s, text);
}

export default function turnShapeRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env): void {
	// Jo's next input (typed at the TUI or sent over rpc) lifts a hold; an extension-sent input is not Jo, so it lifts nothing (Codex round 3 on PR #68, S1).
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return undefined;
		const s = gateSession(ctx, env);
		markerShown.delete(s);
		s.heldReply = null;
		return undefined;
	});

	pi.on("assistant_message", (event, ctx) => {
		const s = gateSession(ctx, env);
		const content = event.message.content;
		if (s.role !== "orchestrator" || !Array.isArray(content)) return undefined;
		const original = messageText(event.message);
		// A message with a tool call is not the final reply, so row 1 does not judge it; its text still reaches Jo, so row 15's binding does (round 2, B3).
		const working = content.some((p) => p.type === "toolCall");
		const reason = working ? bindQuestions(s, original) : orchestratorReply(s, original);
		if (!reason) {
			// A passing final reply lifts a hold `session_stop` already delivered; a passing working message lifts nothing.
			if (!working && !s.heldReply?.untilStop) {
				s.heldReply = null;
				markerShown.delete(s);
			}
			return undefined;
		}
		// A hold on a working message stands until `session_stop` delivers it: a later passing reply would otherwise end the turn with it unsaid.
		// A second hold before that stop adds to it, so the stop delivers both.
		const prior = s.heldReply?.untilStop ? s.heldReply : null;
		s.heldReply = prior ? { original: `${prior.original}\n\n${original}`, reason: `${prior.reason}\n\n${reason}`, untilStop: true } : { original, reason, untilStop: working };
		// The text blocks are replaced; every other block (the tool calls among them) is kept, so row 15 still judges each call under the hold.
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
			// Delivered now: the rewrite that passes lifts it.
			withheld.untilStop = false;
			return { decision: "block", reason: `${withheld.reason}\n\nYour held reply was:\n\n${withheld.original}` };
		}
		const text = messageText(event.last_assistant_message);
		const refusal = checkTurnShape(text, s.role === "orchestrator" ? "orchestrator" : "lane");
		if (refusal) return { decision: "block", reason: refusal.reason };
		if (s.role !== "orchestrator") return undefined;
		try {
			const bound = checkQuestionPublication(text, () => s.ledger(), true);
			return bound.ok ? undefined : { decision: "block", reason: bound.reason };
		} catch (err) {
			return { decision: "block", reason: `P-11 row 15 could not bind this reply's QUESTION to the ledger (${String(err)}); the turn does not end unchecked` };
		}
	});
}
