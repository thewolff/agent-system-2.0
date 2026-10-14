// The orchestrator's recommendations and the machine `send:` line (PLAN wl-mv66ylg1op3wg0 D3, D5, D7;
// surface/src/triage.ts).
//
// Recommendations (D3). The tool `orchestrator_recommend` records the word Ilex recommends for one
// answerable needs-you row (`#n` from the session Numbering, or its q-…/en-… id) as a `recommend:
// <row-id> <word> — <reason>` entry by the surface on the row's workload; it refuses a row that is
// unknown or no longer waiting, a row whose options are not one word each, and a word that is not one
// of the row's options (approve / deny for a reserved request). triageItems reads the entry before
// pending.ts's recorded recommendation. At the orchestrator's `session_stop`, one advisory
// continuation (never a block) names the answerable rows still lacking Ilex's recommendation; a row
// it named is not named again until Jo's next typed input, so one stop yields at most one
// continuation and the continuation's own stop yields none unless a new row appeared.
//
// The render (D5). At the terminal `agent_end` of every orchestrator turn whose needs-you view holds
// a line, one display message (`surface-send-line`, display, no turn) after the turn's text: the
// `needs Jo:` list (each line `#n <id> (<reason>) — <subject>`, or `<reason>: <wl> — <subject> (no
// one-word answer)`), then `send: 3 approve, 5 extend` from triageItems' routine list. A `send:` line
// is written as a `send-line: sr-… <pieces>` entry on the standing workload, then as a
// `surface-send-line` session entry `{ id, pieces, seq }`, and kept as the session's binding (the
// line Jo's `ok` applies, surface/extensions/surface-input.ts). No routine item: no `send:` line and
// no binding. Every render takes the next displaySeq. A non-terminal settle (`willContinue`, e.g. the
// stop nudge's continuation) renders nothing: the continuation's own end does.
//
// Timing (OMP 18.8.x as installed): AgentSession#settleAgentEnd reports idle, publishes the session's
// agent_end, then notifies extensions fire-and-forget (`void #emitAgentEndNotification`); the
// extension runner awaits each `agent_end` handler in turn (ExtensionRunner#emit, 30 s handler
// timeout). So the handler may await triage (its judge call) without holding the session: the session
// is already idle and nothing waits on it; an `ok` typed before the render lands applies the line
// shown before it.
//
// The batch reply (D7). A typed numbered batch or `ok` applied at submit is answered by one display
// (`surface-send-line`): its applied and skipped lines, then a fresh render (a new binding at the
// next displaySeq). Idle at submit it is shown at once; while a turn streams it is held on the session
// and shown one macrotask after that turn's terminal `agent_end`, in place of that turn's render.
// When an applied answer is to the orchestrator's own question, after the reply the surface writes a
// `surface-batch-turn` session entry `{ nonce, appliedIds, numbers }` and sends one hidden
// `surface-batch-trigger` message carrying the same nonce that starts a turn (row 1's batch-turn
// rules, gates/extensions/r01-turn-shape.ts, read both).
//
// Inert on every session that is not the surface.
import type { ErrorLine } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { type AppliedBatch, type BatchReply, type SurfaceSession, surfaceSession } from "../src/session";
import { type JudgeSource, NEEDS_JO_HEADING, needsJoLine, recordRecommendation, sendLineBody, sendPieces, type TriageJudge, triageItems, unrecommended } from "../src/triage";
import { type Ctx, RECOMMEND_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY, type ToolResult } from "../src/types";

/** The display customType of the render and the batch reply; the session entry of a binding. */
export const SEND_LINE_TYPE = "surface-send-line";
/** The session entry scoping a batch turn, and the hidden message that starts it (the shared contract with row 1). */
export const BATCH_TURN_TYPE = "surface-batch-turn";
export const BATCH_TRIGGER_TYPE = "surface-batch-trigger";

/** The judge triage asks: OMP's judge role resolved for a session (surface/index.ts hostJudge), or a fake in tests; null when none is wired. */
export type TriageJudgeOf = ((ctx: Ctx) => Promise<TriageJudge>) | null;

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** OMP's advisory stop result (omp://extensions.md § session_stop): one more turn carrying the context, never a refusal. */
interface StopAdvice {
	continue: true;
	additionalContext: string;
}
/** `session_stop` as OMP takes it; the gates' slice types only the block result. */
type StopOn = { on(event: "session_stop", h: (event: unknown, ctx: Ctx) => StopAdvice | undefined): void };

/** Rows the nudge already named since Jo's last typed input, per surface session. */
const nudged = new WeakMap<SurfaceSession, Set<string>>();
/** The judge each surface session resolved: resolved on the first row that needs one, kept once it resolves (a failed resolution is tried again at the next render). */
const judges = new WeakMap<SurfaceSession, TriageJudge>();

const judgeSource = (s: SurfaceSession, ctx: Ctx, judgeOf: TriageJudgeOf): JudgeSource =>
	judgeOf === null
		? null
		: async () => {
				const known = judges.get(s);
				if (known) return known;
				const j = await judgeOf(ctx);
				judges.set(s, j);
				return j;
			};

/** A fresh send-line id: `sr-<ms base36><random base36>`. */
const sendLineId = (): string => `sr-${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;

/**
 * One render (D5): the needs-Jo list and the `send:` line, with `lead` (a batch reply's applied and
 * skipped lines) above them, as one `surface-send-line` display at the next displaySeq. With no lead
 * and no needs-you line nothing is shown and false is returned. A `send:` line is ledgered and bound
 * before the display goes out; one the ledger refuses is shown as `no send line: …` with no binding.
 */
export async function renderSendLine(pi: SurfaceAPI, s: SurfaceSession, ctx: Ctx, judgeOf: TriageJudgeOf, lead: readonly string[] = []): Promise<boolean> {
	const body: string[] = [];
	let bound: { id: string; pieces: string } | null = null;
	try {
		const ledger = s.ledger();
		const t = await triageItems(ledger, s.numbering, judgeSource(s, ctx, judgeOf), { now: s.now() });
		if (lead.length === 0 && t.routine.length === 0 && t.needsJo.length === 0) return false;
		if (t.needsJo.length > 0) body.push(NEEDS_JO_HEADING, ...t.needsJo.map(needsJoLine));
		if (t.routine.length > 0) {
			const pieces = sendPieces(t.routine);
			const id = sendLineId();
			try {
				ledger.write(() => {
					ensureStandingWorkload(ledger);
					ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: sendLineBody(id, pieces) });
				});
				bound = { id, pieces };
				body.push(`send: ${pieces}`);
			} catch (err) {
				body.push(`no send line: the ledger refused its record (${reason(err)}); answer by number`);
			}
		}
	} catch (err) {
		body.splice(0, body.length, `${NEEDS_JO_HEADING} the ledger could not be read for the send line: ${reason(err)}`);
		bound = null;
	}
	const seq = ++s.displaySeq;
	s.sendLine = bound ? { ...bound, seq } : null;
	if (bound) pi.appendEntry(SEND_LINE_TYPE, { id: bound.id, pieces: bound.pieces, seq });
	const content = [...lead, ...(lead.length > 0 && body.length > 0 ? [""] : []), ...body].join("\n");
	pi.sendMessage?.({ customType: SEND_LINE_TYPE, content, display: true, details: { seq, ...(bound ? { id: bound.id } : {}) } }, {});
	return true;
}

/** Write the `surface-batch-turn` entry for `b` (the shared contract with row 1); returns its nonce. */
export function batchTurnEntry(pi: SurfaceAPI, s: SurfaceSession, b: AppliedBatch): string {
	const nonce = `bt-${s.mintId()}`;
	pi.appendEntry(BATCH_TURN_TYPE, { nonce, appliedIds: b.appliedIds, numbers: b.numbers });
	return nonce;
}

/** Show a batch reply (D7): the lines above a fresh render; then, for an answer to the orchestrator's own question, the batch-turn entry and the hidden message that starts its turn. */
export async function showReply(pi: SurfaceAPI, s: SurfaceSession, ctx: Ctx, judgeOf: TriageJudgeOf, reply: BatchReply): Promise<void> {
	await renderSendLine(pi, s, ctx, judgeOf, reply.lines);
	if (!reply.trigger) return;
	const nonce = batchTurnEntry(pi, s, reply.trigger);
	pi.sendMessage?.({ customType: BATCH_TRIGGER_TYPE, content: `act on these answers: ${reply.trigger.lines.join("; ")}`, display: false, details: { nonce } }, { triggerTurn: true });
}

export default function sendLineRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env, judgeOf: TriageJudgeOf = null): void {
	const z = pi.zod;
	pi.registerTool({
		name: RECOMMEND_TOOL,
		loadMode: "essential",
		label: "Recommend An Answer",
		description:
			"Record the one-word answer you recommend to Jo for one open needs-you item: a reserved request (approve / deny) or a question whose options are one word each. " +
			"Name it by its number (`#3`) or its id (`q-…`, `en-…`); `word` must be one of its options; `reason` is one line. " +
			"Only items with a recommendation can go in Jo's `send:` line; a reserved request and a plan approval are always Jo's to decide.",
		parameters: z.object({
			item: z.string().describe("The item: `#n` as numbered on the needs-you list, or its q-… / en-… id."),
			word: z.string().describe("The answer you recommend: one of the item's options (approve or deny for a reserved request)."),
			reason: z.string().describe("Why, in one line."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const r = recordRecommendation(s.ledger(), s.numbering, { item: String(params.item ?? ""), word: String(params.word ?? ""), reason: String(params.reason ?? "") }, { now: s.now() });
			if (!r.ok) return text(r.reason);
			return text(`Recorded: ${r.n !== null ? `#${r.n} ` : ""}${r.rowId} → ${r.word} (entry ${r.entryId} on ${r.workloadId}).`, r);
		},
	});

	pi.on("input", (_event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (s.active) nudged.delete(s);
		return undefined;
	});

	// D5 and D7: a held batch reply goes out one macrotask after the turn's end (OMP's settle has run, so it is no steer), in place
	// of the render; otherwise the render. A render that throws past its own catch is dropped: the poll and the wake report the ledger.
	pi.on("agent_end", async (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active || event.willContinue === true) return undefined;
		if (s.heldReply) {
			ctx.setTimeout(async () => {
				const reply = s.heldReply;
				s.heldReply = null;
				if (!reply) return;
				try {
					await showReply(pi, s, ctx, judgeOf, reply);
				} catch (err) {
					process.stderr.write(`surface: the held batch reply could not be shown: ${reason(err)}\n`);
				}
			}, 0);
			return undefined;
		}
		try {
			await renderSendLine(pi, s, ctx, judgeOf);
		} catch (err) {
			process.stderr.write(`surface: the send-line render failed: ${reason(err)}\n`);
		}
		return undefined;
	});

	(pi as unknown as StopOn).on("session_stop", (_event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		let lacking: ErrorLine[];
		try {
			lacking = unrecommended(s.ledger(), s.numbering, { now: s.now() });
		} catch {
			// Advisory only: a ledger that cannot be read here never holds the stop (the wake and row 1 report it).
			return undefined;
		}
		const seen = nudged.get(s) ?? new Set<string>();
		if (!lacking.some((l) => !seen.has(l.rowId))) return undefined;
		for (const l of lacking) seen.add(l.rowId);
		nudged.set(s, seen);
		const names = lacking.map((l) => `${l.n !== undefined ? `#${l.n} ` : ""}${l.rowId}`).join(", ");
		return {
			continue: true,
			additionalContext: `Before you stop: these open items have no recommendation from you: ${names}. Record one per item with ${RECOMMEND_TOOL} (item, word, a one-line reason); an item with none is listed for Jo as needs Jo and is never in the send: line. Then stop; say nothing more to Jo about it.`,
		};
	});
}
