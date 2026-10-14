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
//
// Batch turns (SPEC-2.0.md § B16 item 3, amended 2026-10-13): both hooks read the orchestrator's
// session entries (`readTurn`) for the surface's `surface-batch-turn` entry and pass row 1 the
// applied ids and numbers when this turn is the one it scopes, else `{ batch: null }`. A lane is
// never on a batch turn. Entries that cannot be read refuse the reply, naming why.
import { checkTurnShape, type TurnInput } from "../src/rows/r01-turn-shape";
import { checkQuestionPublication, recordPublication } from "../src/rows/r15-orchestrator-role";
import { type AgentMessageLike, type GatesAPI, type GateSession, gateSession, messageText } from "../src/session";

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
 * The surface's record of a batch it applied for Jo (surface/extensions/send-line.ts), an OMP
 * CustomEntry from `pi.appendEntry`: `{ type: "custom", customType, data: { nonce, appliedIds,
 * numbers } }`. When the batch needs Ilex to act, the hidden message that triggers the turn is a
 * CustomMessageEntry once OMP persists it: `{ type: "custom_message", customType, details: { nonce } }`
 * (pi-coding-agent 18.8.6 session/session-entries.ts CustomEntry, CustomMessageEntry;
 * session/session-manager.ts appendCustomEntry, appendCustomMessageEntry).
 */
const BATCH_ENTRY = "surface-batch-turn";
const BATCH_TRIGGER = "surface-batch-trigger";
/** The hidden message OMP sends after a blocked session_stop (session/agent-session.ts #emitSessionStopEvent): the rewrite continues the same turn. */
const STOP_CONTINUATION = "session-stop-continuation";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
type Message = AgentMessageLike & { timestamp?: unknown };

/** A batch entry's data, or null when it cannot be read: a nonce, the applied ids, the applied numbers. */
function batchData(e: Obj): { nonce: string; appliedIds: string[]; numbers: number[] } | null {
	const d = obj(e.data);
	if (!d || typeof d.nonce !== "string" || !d.nonce) return null;
	const { appliedIds, numbers } = d;
	if (!Array.isArray(appliedIds) || !appliedIds.every((x) => typeof x === "string" && x)) return null;
	if (!Array.isArray(numbers) || !numbers.every((n) => Number.isInteger(n) && (n as number) >= 0)) return null;
	return { nonce: d.nonce, appliedIds: appliedIds as string[], numbers: numbers as number[] };
}

/**
 * Row 1's view of this turn on the orchestrator, from its session entries; a lane is never on a
 * batch turn. The turn starts after the last final assistant reply (no tool call) that ended a
 * turn: not a held reply's marker, not a reply a blocked session_stop continued, and not `current`,
 * the reply being checked, when OMP has already persisted it. A `surface-batch-turn` entry scopes
 * this turn when either
 * - this turn holds the hidden trigger, no user message follows it, and the latest entry before it
 *   carries its nonce (an `ok`: the surface writes the entry, then sends the trigger); or
 * - the latest entry sits in this turn after any trigger, with at most one user message after it and no reply
 *   before that one (a paste: the entry is written at `before_agent_start`, which OMP runs before it
 *   persists the prompt, so the paste's own user message follows the entry).
 * A later turn, or a new user message, falls outside both. Entries that cannot be read, or an entry
 * or trigger that cannot be read where it could scope this turn, refuse with the reason (fail closed).
 */
function turnOf(s: GateSession, ctx: { sessionManager: { getEntries(): unknown } }, current: Message | undefined): { turn: TurnInput } | { reason: string } {
	if (s.role !== "orchestrator") return { turn: { batch: null } };
	const fail = (why: string) => ({ reason: `P-11 row 1 could not read this turn's session entries (${why}), so it cannot tell a batch turn from a normal one and refuses rather than pass the reply unchecked` });
	try {
		const entries: unknown = ctx.sessionManager.getEntries();
		if (!Array.isArray(entries)) return fail("getEntries() returned no list");
		const es: Obj[] = [];
		for (const [i, v] of entries.entries()) {
			const e = obj(v);
			if (!e || typeof e.type !== "string") return fail(`entry ${i} has no type`);
			if (e.type === "message" && !obj(e.message)) return fail(`message entry ${i} carries no message`);
			es.push(e);
		}
		const msg = (e: Obj): Message | null => (e.type === "message" ? (e.message as Message) : null);
		const isUser = (e: Obj) => msg(e)?.role === "user";
		const final = (e: Obj) => {
			const m = msg(e);
			return m?.role === "assistant" && !(Array.isArray(m.content) && m.content.some((p) => obj(p)?.type === "toolCall"));
		};
		const held = (e: Obj) => {
			const parts = messageText(msg(e)!).split("\n").map((l) => l.trim()).filter(Boolean);
			return parts.length > 0 && parts.every((l) => l === WITHHELD_MARKER || l === LATER_HOLD);
		};
		const continued = (i: number) => {
			const next = es.slice(i + 1).find((e) => e.type === "message" || e.type === "custom_message");
			return next?.type === "custom_message" && next.customType === STOP_CONTINUATION;
		};
		const same = (m: Message, c: Message) =>
			typeof m.timestamp === "number" && typeof c.timestamp === "number" ? m.timestamp === c.timestamp : messageText(m) === messageText(c);
		const lastReply = es.findLastIndex((e) => msg(e)?.role === "assistant");
		const skip = current && lastReply >= 0 && final(es[lastReply]!) && same(msg(es[lastReply]!)!, current) ? lastReply : -1;
		let start = 0;
		for (let i = es.length - 1; i >= 0; i--) {
			if (i === skip || !final(es[i]!) || held(es[i]!) || continued(i)) continue;
			start = i + 1;
			break;
		}
		const isEntry = (e: Obj) => e.type === "custom" && e.customType === BATCH_ENTRY;
		const trigger = es.findLastIndex((e, i) => i >= start && e.type === "custom_message" && e.customType === BATCH_TRIGGER);
		const after = (from: number, p: (e: Obj) => boolean) => es.slice(from + 1).filter(p).length;
		if (trigger >= 0 && after(trigger, isUser) === 0) {
			const nonce = obj(es[trigger]!.details)?.nonce;
			if (typeof nonce !== "string" || !nonce) return fail(`the ${BATCH_TRIGGER} message at entry ${trigger} carries no nonce`);
			const e = es.findLastIndex((x, i) => i < trigger && isEntry(x));
			if (e < 0) return fail(`no ${BATCH_ENTRY} entry precedes the ${BATCH_TRIGGER} message carrying nonce ${nonce}`);
			const data = batchData(es[e]!);
			if (!data) return fail(`the ${BATCH_ENTRY} entry at entry ${e} has no readable nonce, appliedIds and numbers`);
			if (data.nonce !== nonce) return fail(`the latest ${BATCH_ENTRY} entry carries nonce ${data.nonce}, the ${BATCH_TRIGGER} message ${nonce}`);
			return { turn: { batch: { appliedIds: data.appliedIds, numbers: data.numbers } } };
		}
		const e = es.findLastIndex(isEntry);
		if (e < Math.max(start, trigger + 1)) return { turn: { batch: null } };
		const firstUser = es.findIndex((x, i) => i > e && isUser(x));
		const replyBefore = firstUser >= 0 && es.slice(e + 1, firstUser).some((x) => msg(x)?.role === "assistant");
		if (after(e, isUser) > 1 || replyBefore) return { turn: { batch: null } };
		const data = batchData(es[e]!);
		if (!data) return fail(`the ${BATCH_ENTRY} entry at entry ${e} has no readable nonce, appliedIds and numbers`);
		return { turn: { batch: { appliedIds: data.appliedIds, numbers: data.numbers } } };
	} catch (err) {
		return fail(String(err));
	}
}

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

/** Row 1 (with this turn's batch view), then row 15's binding, over the orchestrator's final reply: the refusal reason, or null. Records the citation when the reply passes. */
function orchestratorReply(s: GateSession, text: string, turn: TurnInput): string | null {
	const shape = checkTurnShape(text, "orchestrator", turn);
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
		// A message with a tool call is not the final reply, so row 1 does not judge it (nor reads the batch turn); its text still reaches Jo, so row 15's binding does (round 2, B3).
		const working = content.some((p) => p.type === "toolCall");
		let reason: string | null;
		if (working) reason = bindQuestions(s, original);
		else {
			const read = turnOf(s, ctx, event.message);
			reason = "reason" in read ? read.reason : orchestratorReply(s, original, read.turn);
		}
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
		const read = turnOf(s, ctx, event.last_assistant_message);
		if ("reason" in read) return { decision: "block", reason: read.reason };
		const refusal = checkTurnShape(text, s.role === "orchestrator" ? "orchestrator" : "lane", read.turn);
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
