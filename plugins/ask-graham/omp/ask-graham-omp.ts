// ask-graham-omp.ts — the OMP half of the every-idea nudge and of the Stop check.
//
// OMP does not run a plugin's hooks/hooks.json, so the Claude Code UserPromptSubmit and Stop hooks
// never fire there. This extension does both jobs on OMP events.
//
// THE NUDGE, on `before_agent_start`, which fires once per direct prompt and once per dequeued
// batch of user messages (a steer typed mid-turn is its own batch by default; with steeringMode
// "all" the queued steers form one batch: agent-session.ts #prepareQueuedUserMessages ->
// #prepareAgentStart -> emitBeforeAgentStart, OMP 18.8.6). It resolves the level from the
// session's working directory (skills/ask-graham/scripts/intensity.mjs) and, only at every-idea,
// returns NUDGE as a hidden custom message (display false) that OMP puts in the same request as
// the user's message. It never revises the message.
//
// Returning the message, rather than queueing it with sendMessage, keeps one nudge per batch: a
// queued "nextTurn" message parks while the agent streams and every mid-turn submission added
// another copy, all delivered together at the next idle prompt. The handler is pure (same cwd and
// settings give the same result), so OMP re-running the chain for one submission is harmless: it
// keeps only the accepted attempt's message.
//
// THE STOP CHECK, on `session_stop`: a turn that read the ask-graham skill and ended without a
// `**Verdict:**` line naming one of the four verdicts is blocked once, with a reason asking for
// that line (checkStop in skills/ask-graham/scripts/verdict.mjs, shared with the Claude Code Stop
// hook). A reply ending with the exact comparables question may wait without a verdict. The turn is read from event.session_file; the final text is event.last_assistant_message.
// OMP fires session_stop only for the main session, never for a subagent.
//
// OFF SWITCH: stop-check=off in the nearest .ask-graham or the user config (intensity.mjs,
// resolved from ctx.cwd) skips the check before the session file is read.
//
// ONCE PER TURN, keyed on the turn opener: `blockedOpener` maps the session manager's id (the
// payload's session_id only when that is unreadable, since the payload carries the provider id,
// which a context reset rotates) to the opener id of the turn this handler last blocked. A stop in
// that turn passes. stop_hook_active is not read: OMP sets it after any extension's continuation,
// so a stop that follows another extension's block is still checked. OMP's continuation after a
// block is a custom message attributed to the agent, which does not open a new turn.
//
// FAIL OPEN: any error (no session file, unreadable file, a throw anywhere) returns undefined, so
// the stop goes through.
//
// The plugin's package.json declares this file under omp.extensions, which OMP loads for an
// installed marketplace plugin.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types and imports this file in the
// unit tests without Bun. `pi` is typed structurally; there are no imports from the host.

import { readFileSync } from "node:fs";
import { NUDGE, resolveIntensity, stopCheckEnabled } from "../skills/ask-graham/scripts/intensity.mjs";
import { checkStop, parseJsonl } from "../skills/ask-graham/scripts/verdict.mjs";

export type OmpContext = {
	cwd: string;
	sessionManager?: { getSessionId?: () => unknown };
};

export type NudgeMessage = { customType: "ask-graham"; content: string; display: false };

export type StopEvent = {
	session_id?: unknown;
	session_file?: unknown;
	stop_hook_active?: unknown;
	last_assistant_message?: unknown;
};

export type StopResult = { decision: "block"; reason: string };

export type PiLike = {
	on(event: "before_agent_start", handler: (event: unknown, ctx: OmpContext) => unknown): void;
	on(event: "session_stop", handler: (event: StopEvent, ctx: OmpContext) => unknown): void;
};

export type AdapterDeps = {
	env?: Record<string, string | undefined>;
	home?: string;
};

// Session key -> opener id of the turn this handler last blocked. One per loaded module, so one per
// omp process. One small string per session that was ever blocked; never pruned.
const blockedOpener = new Map<string, string>();

// The session manager's id, or the payload's session_id when that is unreadable. "" when neither.
function sessionKey(event: StopEvent, ctx: OmpContext): string {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id) return id;
	} catch {
		// fall through to the payload id
	}
	return typeof event.session_id === "string" ? event.session_id : "";
}

// The finished message's text: string content, or its text blocks joined by newlines. Undefined
// when there is none, so checkStop falls back to the last assistant text in the session file.
// Same reduction as assistantText in plugins/i-have-audhd/omp/i-have-audhd-omp.ts.
function assistantText(message: unknown): string | undefined {
	if (!message || typeof message !== "object" || !("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === "object"))
		.filter((part): part is { type?: unknown; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	return text || undefined;
}

function sessionStop(event: StopEvent, ctx: OmpContext, settings: { env: AdapterDeps["env"]; home?: string }): StopResult | undefined {
	try {
		if (!stopCheckEnabled({ cwd: ctx.cwd, env: settings.env, home: settings.home })) return undefined;
		const file = event?.session_file;
		if (typeof file !== "string" || file === "") return undefined;
		const key = sessionKey(event, ctx);
		const r = checkStop({
			entries: parseJsonl(readFileSync(file, "utf8")),
			text: assistantText(event.last_assistant_message),
			blockedOpener: blockedOpener.get(key) ?? null,
		});
		if (!r.block) return undefined;
		blockedOpener.set(key, r.opener);
		return { decision: "block", reason: r.block };
	} catch {
		return undefined; // fail open: the stop goes through
	}
}

export default function askGrahamOmp(pi: PiLike, deps: AdapterDeps = {}): void {
	const env = deps.env ?? process.env;
	pi.on("before_agent_start", (_event, ctx): { message: NudgeMessage } | undefined => {
		let level: string;
		try {
			level = resolveIntensity({ cwd: ctx.cwd, env, home: deps.home }).level;
		} catch {
			return undefined; // fail open: an unreadable setting behaves as ask
		}
		if (level !== "every-idea") return undefined;
		return { message: { customType: "ask-graham", content: NUDGE, display: false } };
	});
	pi.on("session_stop", (event, ctx) => sessionStop(event, ctx, { env, home: deps.home }));
}
