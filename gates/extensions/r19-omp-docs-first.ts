// P-11 row 19 as its own extension: a question about OMP is answered after reading OMP's own docs or
// source (gates/src/rows/r19-omp-docs-first.ts has the rule). This file maps OMP's events onto it.
//
// - The question: Ilex's and lanes' `input` (interactive or rpc; OMP 18.8.6 emits no other source) and a
//   hand's first `before_agent_start` (its task prompt; hands get no `input`) each start one, and only
//   they do. The judge call starts there and is awaited at the first answer boundary.
// - The consult: `tool_result`, any role.
// - The answer boundaries, each held on every attempt while the question is triggered and unconsulted:
//   - Ilex's and a lane's final reply: `assistant_message` replaces its text with HELD_MARKER (the row 1
//     pattern, gates/extensions/r01-turn-shape.ts; LATER_HOLD after the first), keeping the draft, and
//     the `session_stop` after it blocks with the reason and the draft, so the continuation rewrites it.
//   - Ilex's and a lane's outward tools (orchestrator_reply, orchestrator_raise_question, lane_message,
//     lane_raise_question, by name or as `xd://` devices) are refused at `tool_call`.
//   - A hand's `yield` is refused at `tool_call` (OMP fires no session_stop for a subagent).
// - Row 1 and row 19 stay independent: row 19 registers before row 1 (gates/index.ts). OMP hands each
//   assistant_message handler the previous rewrite and returns the first session_stop result (runner.ts),
//   so a reply row 19 holds reaches row 1 only as row 19's marker (which passes row 1): row 1 neither
//   judges it nor cites its QUESTION rows (row 15's publication binding refuses a row an earlier reply
//   cited, so citing a held draft would refuse its rewrite for good), and the stop ends on row 19's reason.
//   A reply row 19 lets through is row 1's to judge, and a row 1 hold is never one of row 19's. So each
//   continuation answers one row: row 1's loop is row 1's own, and row 19's ends at the first OMP read.
// - No release: row 19 holds every attempt until that read (PLAN R7). Its reason names WAY_OUT, a read that
//   always exists, so the way out of the loop is always in the model's hands.
import type { JudgmentJudge } from "../../classifier/src/judge-ask";
import { HELD_MARKER, LATER_HOLD, OmpQuestion, consultsOmp, outwardTool } from "../src/rows/r19-omp-docs-first";
import { type Ctx, type GatesAPI, type GateSession, gateSession, messageText } from "../src/session";

/** OMP's `judge` role for a session (gates/index.ts hostJudge); tests hand in a fake. */
export type OmpJudge = (ctx: Ctx) => Promise<JudgmentJudge>;

export interface DocsFirstDeps {
	/** Absent: every input counts as a question about OMP (fail closed). */
	judge?: OmpJudge;
	/** The judge's bound; JUDGE_TIMEOUT_MS unless a test sets it. */
	timeoutMs?: number;
}

/** Each session's current question. Kept here: no other row reads it. */
const questions = new WeakMap<GateSession, OmpQuestion>();

export default function ompDocsFirstRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env, deps: DocsFirstDeps = {}): void {
	const start = (s: GateSession, ctx: Ctx, text: string) => {
		const judge = deps.judge;
		questions.set(s, new OmpQuestion(text, judge && (() => judge(ctx)), deps.timeoutMs));
	};

	pi.on("input", (event, ctx) => {
		const s = gateSession(ctx, env);
		if (s.role !== "hand" && (event.source === "interactive" || event.source === "rpc")) start(s, ctx, event.text);
		return undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		const s = gateSession(ctx, env);
		if (s.role === "hand" && !questions.has(s)) start(s, ctx, event.prompt);
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		const q = questions.get(gateSession(ctx, env));
		if (q && consultsOmp(event.toolName, event.input, event.details, event.isError)) q.consulted = true;
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const s = gateSession(ctx, env);
		const q = questions.get(s);
		if (!q) return undefined;
		const boundary = s.role === "hand" ? (event.toolName === "yield" ? "yield" : null) : outwardTool(event.toolName, event.input);
		if (!boundary) return undefined;
		const a = await q.attempt();
		return a.kind === "hold" ? { block: true, reason: a.reason } : undefined;
	});

	pi.on("assistant_message", async (event, ctx) => {
		const s = gateSession(ctx, env);
		const q = questions.get(s);
		const content = event.message.content;
		if (!q || s.role === "hand" || !Array.isArray(content) || content.some((p) => p.type === "toolCall")) return undefined;
		const draft = messageText(event.message);
		const a = await q.attempt();
		if (a.kind !== "hold") return undefined;
		q.draft = draft;
		if (q.markerShown) return { content: content.map((p) => (p.type !== "text" ? p : { ...p, text: LATER_HOLD })) };
		q.markerShown = true;
		const first = content.findIndex((p) => p.type === "text");
		return { content: content.map((p, i) => (p.type !== "text" ? p : { ...p, text: i === first ? HELD_MARKER : "" })) };
	});

	pi.on("session_stop", async (event, ctx) => {
		const s = gateSession(ctx, env);
		const q = questions.get(s);
		if (!q || s.role === "hand") return undefined;
		const draft = q.draft;
		q.draft = null;
		if (draft !== null) {
			// Held at assistant_message; nothing can be read between it and this stop.
			return (await q.holding()) ? { decision: "block", reason: `${q.reason}\n\nYour held reply was:\n\n${draft}` } : undefined;
		}
		// A reply assistant_message did not see (a host or a message shape it skips): its attempt counts here.
		const a = await q.attempt();
		return a.kind === "hold" ? { decision: "block", reason: a.reason } : undefined;
	});
}
