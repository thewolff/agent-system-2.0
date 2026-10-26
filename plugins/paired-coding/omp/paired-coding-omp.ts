// paired-coding-omp.ts — the OMP host adapter for the paired-coding gate.
//
// A thin shell. Every verdict comes from the gate core (core/gate.mjs) through the shared
// session layer (lib/verbs.mjs); this file only maps OMP's extension events onto it:
//
//   tool_call          -> verdict(): a refused tool returns { block: true }. OMP stops at the
//                         first handler that blocks (runner.ts emitToolCall), so no later
//                         extension can undo a refusal.
//   input              -> recordTrustedInput() with the event's own `source`. Only the
//                         interactive editor emits this event, always with source
//                         "interactive" (modes/controllers/input-controller.ts, the
//                         emitInput call in #runInputHandlers). Messages an extension injects
//                         with sendUserMessage never pass through it, so they never count as the
//                         user's words. A typed turn that is exactly "pair stop" ends pairing
//                         here, before the turn reaches the agent, and queues stopNotice as
//                         hidden context for that turn (sendMessage, deliverAs "nextTurn"), so
//                         the agent learns pairing ended and where the pair-accepted receipt
//                         is. The handler returns nothing: it never revises input.
//   registerTool       -> one OMP tool per PAIR_TOOLS entry. Each execute() calls executeVerb()
//                         on the arguments it received, which are the final ones: OMP hands
//                         execute the last tool_call revision, so a later extension that
//                         rewrites a pair_write path or a pair_run command is checked as
//                         rewritten (adversarial test 16). There is no stop tool.
//   session_shutdown   -> endSession(): reap every pair_run process group, take the final
//                         snapshot, write the pair-accepted receipt, go inactive.
//   session_before_switch, session_switch, session_before_branch, session_branch
//                      -> a session change inside the running process (/new, /fork, /resume
//                         emit the switch events; /btw's branch and a branch requested over RPC
//                         or by an extension, AgentSession.branch, emit the branch events)
//                         keeps this extension loaded but gives the agent a new session id.
//                         When the session being left was pairing, it ends like
//                         session_shutdown and the new session starts closed (carryInto): host
//                         writes refused until pair_start, ended by a typed stop. The old id is
//                         taken at the before event, because after it the context already
//                         reports the new one.
//   session_tree       -> a leaf move inside the same session file. /tree, and the interactive
//                         /branch to an earlier message (the selector calls navigateTree), keep
//                         the session id and fire session_tree after the move. The agent's
//                         context is then another branch, which does not hold the agreement, so
//                         a move while pairing is handled like /clear (clearInPlace): pairing
//                         ends, the card is dropped and the same session carries closed. The
//                         agent is told so as hidden context on its next turn (TREE_NOTICE,
//                         sendMessage deliverAs "nextTurn"), including that the files on disk
//                         were not rewound with the conversation.
//   /clear             -> OMP's /clear keeps the session id and drops the agent's context, and
//                         fires no extension event. It does append a `reset_boundary` entry to
//                         the session, so before every input and tool call the adapter compares
//                         the latest one with the one it saw last. A new one while pairing ends
//                         pairing as a session change would (clearInPlace) and carries the same
//                         session closed: the cleared agent no longer holds the agreement.
//
// INERT UNTIL pair_start. OMP loads every file in its extensions directory into every session,
// so each handler first checks the session's activation marker (an existsSync, no file
// created) and returns at once when it is absent.
//
// ONE WRITE GATE PER SESSION. Another gate that also owns write enforcement must not run beside
// this adapter, or the session would have two trusted-input stores and two sets of verdicts.
// OMP gives an extension no list of the other loaded extensions (getExtensionPaths lives on the
// runner, not on ExtensionAPI), so the install names one tool such a gate registers in
// $PAIRED_CODING_CONFLICTING_TOOLS (comma-separated). pair_start reads pi.getAllTools() and
// refuses to activate when any listed tool is present. Unset or empty, the check is skipped.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types and imports this file in the
// unit tests without Bun. `pi` is typed structurally; there are no imports from the host.

import { CARRIED_PHRASE, EARLIER_ROADMAP_CHOICES, PAIR_TOOLS, ROADMAP_STATUSES } from "../core/gate.mjs";
import { carryInto, clearInPlace, endSession, executeVerb, recordTrustedInput, sessionDirFor, verdict } from "../lib/verbs.mjs";

// ─── host shapes (structural; only what this adapter reads) ────────────────────────────

type TextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean };

export type OmpContext = {
	cwd: string;
	hasUI?: boolean;
	sessionManager: { getSessionId(): string; getEntries?(): ReadonlyArray<{ type: string; id?: string }> };
	ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
};

type Schema = unknown;
type ZodLike = {
	object(shape: Record<string, Schema>): Schema;
	string(): { describe(d: string): Schema & { optional(): Schema } } & { optional(): Schema };
	enum(values: readonly [string, ...string[]]): { describe(d: string): Schema & { optional(): Schema } };
	number(): { describe(d: string): Schema & { optional(): Schema } };
	boolean(): { describe(d: string): Schema & { optional(): Schema } };
	array(item: Schema): { describe(d: string): Schema & { optional(): Schema } };
};

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: Schema;
	loadMode?: "essential" | "discoverable";
	approval?: "read" | "write" | "exec";
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: OmpContext,
	): Promise<TextResult>;
};

export type PiLike = {
	zod: ZodLike;
	on(event: "tool_call", handler: (event: { toolName: string }, ctx: OmpContext) => unknown): void;
	on(event: "input", handler: (event: { text: string; source: string }, ctx: OmpContext) => unknown): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: OmpContext) => unknown): void;
	on(event: "session_before_switch" | "session_before_branch", handler: (event: unknown, ctx: OmpContext) => unknown): void;
	on(event: "session_switch" | "session_branch", handler: (event: { reason?: string }, ctx: OmpContext) => unknown): void;
	on(event: "session_tree", handler: (event: { newLeafId?: string | null; oldLeafId?: string | null }, ctx: OmpContext) => unknown): void;
	registerTool(tool: ToolDefinition): void;
	getAllTools(): Array<{ name: string }>;
	sendMessage?(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "nextTurn" }): void;
};

/**
 * What the agent is told, as hidden context on the turn, when the partner typed pair stop.
 * `receipt` is the pair-accepted receipt's path, or null when it could not be written (the
 * journal then records `receipt-failed`).
 */
export function stopNotice(receipt: string | null | undefined): string {
	const where = receipt
		? `The pair-accepted receipt is at ${receipt}; name that path in your closing summary. It records which change sets your partner agreed to and pair_done closed, and it does not say the code works.`
		: "The pair-accepted receipt could not be written; say so in your closing summary.";
	return `paired-coding: your partner typed pair stop, so pairing has ended in this session. The gate no longer refuses host tools. ${where} Pairing starts again only if your partner asks for it and you call pair_start.`;
}

/**
 * What the agent is told, as hidden context on the next turn, when a leaf move (/tree, the
 * interactive /branch to an earlier message) carried pairing over closed. The move rewinds the
 * conversation and nothing on disk, so the agent may meet edits it no longer remembers making.
 */
export const TREE_NOTICE =
	`paired-coding: the conversation was moved to another point in it (OMP /tree, or /branch to an earlier message). The files were not rewound: edits made for later cards may already be on disk. Because of the move, ${CARRIED_PHRASE}: there is no card and no change set, and host write, edit, shell and sub-agent tools are refused. Tell your partner this in one line, then ask plainly whether to keep pairing or whether they will type pair stop, and wait for their answer. Call pair_start only once they say to keep pairing.`;

// ─── session binding ───────────────────────────────────────────────────────────────────

/** This session's state directory, or null when OMP's session id is not a safe path segment. */
function dirOf(ctx: OmpContext, env: Record<string, string | undefined>): string | null {
	return sessionDirFor(ctx.sessionManager.getSessionId(), env);
}

/** The id of the session's latest `reset_boundary` entry (OMP /clear), null for none, undefined when unreadable. */
function latestReset(ctx: OmpContext): string | null | undefined {
	const sm = ctx.sessionManager;
	if (typeof sm.getEntries !== "function") return undefined;
	const entries = sm.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "reset_boundary") return String(entries[i].id ?? i);
	}
	return null;
}

/** Tool names from $PAIRED_CODING_CONFLICTING_TOOLS: comma-separated, trimmed, empties dropped. */
export function conflictingToolNames(env: Record<string, string | undefined>): string[] {
	return (env.PAIRED_CODING_CONFLICTING_TOOLS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Why another write gate is loaded in this session, or null: a tool the install listed in
 * $PAIRED_CODING_CONFLICTING_TOOLS is registered here. With no list, nothing is checked.
 */
export function conflictingGate(pi: Pick<PiLike, "getAllTools">, env: Record<string, string | undefined>): string | null {
	const listed = conflictingToolNames(env);
	if (listed.length === 0) return null;
	let tools: Array<{ name: string }>;
	try {
		tools = pi.getAllTools();
	} catch {
		return "the host's tool list could not be read, so another write gate cannot be ruled out";
	}
	const found = listed.find((name) => tools.some((t) => t.name === name));
	return found
		? `another write gate is loaded in this session (its tool ${found} is listed in PAIRED_CODING_CONFLICTING_TOOLS), so this adapter stays off`
		: null;
}

// ─── tools ─────────────────────────────────────────────────────────────────────────────

function text(t: string, isError: boolean, details?: unknown): TextResult {
	return { content: [{ type: "text", text: t }], ...(details === undefined ? {} : { details }), isError };
}

type ToolSpec = { label: string; description: string; approval: "read" | "write" | "exec"; parameters: (z: ZodLike) => Schema };

const STR = (z: ZodLike, d: string) => z.string().describe(d);
const OPT_STR = (z: ZodLike, d: string) => z.string().describe(d).optional();
const OPT_LIST = (z: ZodLike, d: string) => z.array(z.string()).describe(d).optional();

const SPECS: Record<string, ToolSpec> = {
	pair_start: {
		label: "Pair: start",
		description:
			"Start a paired-coding session in this worktree. From then on the host's write, edit, shell, eval and sub-agent tools are refused; files change only through pair_write or pair_edit inside a change set your partner agreed to, and commands run only through pair_run.",
		approval: "write",
		parameters: (z) => z.object({ exclusions: OPT_LIST(z, "Worktree-relative directories left out of snapshots (large generated directories such as node_modules). Journaled.") }),
	},
	pair_note: {
		label: "Pair: note",
		description:
			"Append a note to the pairing journal: free text, a roadmap, or both. The latest roadmap replaces the one before; pair_done lists its items still open or not ready, and the next pair_start in this worktree offers them. Answer a roadmap pair_start offered with earlierRoadmap. The only place to keep notes while pairing.",
		approval: "read",
		parameters: (z) =>
			z.object({
				text: OPT_STR(z, "The note."),
				roadmap: z
					.array(
						z.object({
							id: STR(z, "A short id, unique in the roadmap."),
							title: STR(z, "What the item is."),
							status: STR(z, `One of ${ROADMAP_STATUSES.join(", ")}.`),
							note: OPT_STR(z, "One line. Required for not-ready: what it waits for."),
						}),
					)
					.describe("The whole roadmap, replacing the previous one.")
					.optional(),
				earlierRoadmap: z
					.enum(EARLIER_ROADMAP_CHOICES as unknown as readonly [string, ...string[]])
					.describe(
						`Your partner's answer to the earlier roadmap pair_start offered, one of ${EARLIER_ROADMAP_CHOICES.join(", ")}: pick-up carries it into this session, start-fresh sets it aside for good. Not with roadmap.`,
					)
					.optional(),
			}),
	},
	pair_propose: {
		label: "Pair: propose card",
		description:
			"Record the next change card. Show it to your partner and wait: only a turn they type after this card can agree to it. A card with open points cannot be begun.",
		approval: "read",
		parameters: (z) =>
			z.object({
				boundary: z.array(z.string()).describe("Worktree-relative files the change may touch. `*`, `?`, `**` are globs; a trailing `/` covers a subtree."),
				whyNow: OPT_STR(z, "Why this change, now."),
				decision: OPT_STR(z, "The decision the card asks for."),
				currentCode: OPT_STR(z, "What the code does today."),
				effect: OPT_STR(z, "What will be different afterwards."),
				checks: OPT_LIST(z, "The checks that will show it works."),
				openPoints: OPT_LIST(z, "Questions still open. While any remain, pair_begin is refused."),
			}),
	},
	pair_begin: {
		label: "Pair: begin change set",
		description:
			"Open the change set for the latest card. `quote` must be your partner's words of agreement, copied verbatim from the turn they typed after the card. Refused if the boundary files changed since the card.",
		approval: "write",
		parameters: (z) =>
			z.object({
				cardId: STR(z, "The latest card's id, e.g. card-1."),
				quote: STR(z, "Your partner's words of agreement, verbatim from their latest turn."),
			}),
	},
	pair_done: {
		label: "Pair: done",
		description:
			"Close the open change set. Kills anything left running from its pair_run calls, then returns the machine-produced diff of the boundary since pair_begin for your partner to read back.",
		approval: "write",
		parameters: (z) => z.object({ cardId: STR(z, "The open change set's card id.") }),
	},
	pair_write: {
		label: "Pair: write file",
		description: "Write a whole file inside the open change set's boundary. Refused anywhere else.",
		approval: "write",
		parameters: (z) =>
			z.object({
				path: STR(z, "Worktree-relative path inside the boundary."),
				content: STR(z, "The complete new file content."),
			}),
	},
	pair_edit: {
		label: "Pair: edit file",
		description: "Replace text in a file inside the open change set's boundary. Refused anywhere else.",
		approval: "write",
		parameters: (z) =>
			z.object({
				path: STR(z, "Worktree-relative path inside the boundary."),
				oldString: STR(z, "Exact text to replace; must occur once unless replaceAll is true."),
				newString: STR(z, "Replacement text."),
				replaceAll: z.boolean().describe("Replace every occurrence.").optional(),
			}),
	},
	pair_run: {
		label: "Pair: run command",
		description:
			"Run a shell command in the worktree, in the foreground, under a sandbox built from the pairing state: no worktree writes without an open change set, and only the boundary (plus temp) while one is open. It has its own timeout; on timeout or abort the whole process group is killed.",
		approval: "exec",
		parameters: (z) =>
			z.object({
				command: STR(z, "The command, run with /bin/sh -c in the worktree root."),
				timeoutSeconds: z.number().describe("Timeout in seconds (default 600, max 3600).").optional(),
			}),
	},
};

// ─── registration ──────────────────────────────────────────────────────────────────────

export type AdapterDeps = {
	env?: Record<string, string | undefined>;
	/** Replaced in tests only. */
	execute?: typeof executeVerb;
};

export default function pairedCodingOmp(pi: PiLike, deps: AdapterDeps = {}): void {
	const env = deps.env ?? process.env;
	const run = deps.execute ?? executeVerb;

	// Latest reset_boundary seen per session id. The first look at a session only records it.
	const resetSeen = new Map<string, string | null>();
	const checkReset = (ctx: OmpContext, dir: string): void => {
		const latest = latestReset(ctx);
		if (latest === undefined) return;
		const id = ctx.sessionManager.getSessionId();
		const known = resetSeen.has(id);
		const before = resetSeen.get(id);
		resetSeen.set(id, latest);
		if (!known || before === latest) return;
		const r = clearInPlace({ sessionId: id, sessionDir: dir, reason: "omp:clear" });
		if (r.carried && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`paired coding: ${CARRIED_PHRASE}, because the conversation was cleared. Tell the agent to keep pairing, or type pair stop to end it`, "info");
		}
	};

	pi.on("tool_call", (event, ctx) => {
		const dir = dirOf(ctx, env);
		if (!dir) return undefined; // no usable session id: nothing can have been activated under it
		checkReset(ctx, dir);
		const v = verdict(event.toolName, { sessionDir: dir });
		return v.allow ? undefined : { block: true, reason: `paired coding: ${v.reason}` };
	});

	pi.on("input", (event, ctx) => {
		const dir = dirOf(ctx, env);
		if (!dir) return undefined;
		checkReset(ctx, dir);
		const r = recordTrustedInput({ sessionDir: dir, text: event.text, source: event.source });
		if (r.stopped) {
			pi.sendMessage?.({ customType: "paired-coding", content: stopNotice(r.receipt), display: false }, { deliverAs: "nextTurn" });
			if (ctx.hasUI && ctx.ui) ctx.ui.notify("paired coding is off: you typed pair stop", "info");
		}
		return undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const dir = dirOf(ctx, env);
		if (dir) endSession({ sessionDir: dir });
		return undefined;
	});

	// The session being left, taken before the switch or branch; consumed by the event after it.
	let leaving: string | null = null;
	const takeLeaving = (_event: unknown, ctx: OmpContext) => {
		leaving = ctx.sessionManager.getSessionId();
		return undefined;
	};
	const carryAcross = (reason: string, ctx: OmpContext) => {
		const from = leaving;
		leaving = null;
		const to = ctx.sessionManager.getSessionId();
		if (!from || from === to) return undefined;
		const fromDir = sessionDirFor(from, env);
		const toDir = sessionDirFor(to, env);
		if (!fromDir) return undefined;
		const ended = endSession({ sessionDir: fromDir });
		if (!ended.carry || !toDir) return undefined;
		const r = carryInto({ sessionId: to, sessionDir: toDir, root: ended.carry.root, exclusions: ended.carry.exclusions, protect: ended.carry.protect, from, reason: `omp:${reason}` });
		if (r.ok && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`paired coding: ${CARRIED_PHRASE} in this session. Tell the agent to keep pairing, or type pair stop to end it`, "info");
		}
		return undefined;
	};
	pi.on("session_before_switch", takeLeaving);
	pi.on("session_switch", (event, ctx) => carryAcross(event?.reason ?? "switch", ctx));
	// /btw's branch and AgentSession.branch: OMP mints a new session id (createBranchedSession or
	// newSession) and emits session_branch, not session_switch.
	pi.on("session_before_branch", takeLeaving);
	pi.on("session_branch", (_event, ctx) => carryAcross("branch", ctx));
	pi.on("session_tree", (event, ctx) => {
		if (!event || event.newLeafId === event.oldLeafId) return undefined;
		const dir = dirOf(ctx, env);
		if (!dir) return undefined;
		checkReset(ctx, dir);
		const r = clearInPlace({ sessionId: ctx.sessionManager.getSessionId(), sessionDir: dir, reason: "omp:tree" });
		if (r.carried) {
			pi.sendMessage?.({ customType: "paired-coding", content: TREE_NOTICE, display: false }, { deliverAs: "nextTurn" });
			if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(`paired coding: ${CARRIED_PHRASE}, because you moved to another point in the conversation. Tell the agent to keep pairing, or type pair stop to end it`, "info");
			}
		}
		return undefined;
	});

	for (const name of PAIR_TOOLS) {
		const spec = SPECS[name];
		if (!spec) throw new Error(`paired-coding: no OMP tool spec for ${name}`);
		pi.registerTool({
			name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters(pi.zod),
			loadMode: "essential",
			approval: spec.approval,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const sessionId = ctx.sessionManager.getSessionId();
				const dir = sessionDirFor(sessionId, env);
				if (!dir) return text(`${name} refused: this session's id cannot name a state directory`, true);
				if (name === "pair_start") {
					const conflict = conflictingGate(pi, env);
					if (conflict) return text(`pair_start refused: ${conflict}`, true);
				}
				const r = await run(name, params, { sessionId, sessionDir: dir, cwd: ctx.cwd, signal, runId: toolCallId });
				const halted = name === "pair_done" && (r.result as { halted?: boolean } | undefined)?.halted === true;
				if (ctx.hasUI && ctx.ui && (halted || (name === "pair_start" && r.ok))) {
					ctx.ui.notify(halted ? `paired coding stopped the session: ${r.text}` : "paired coding is on for this session", halted ? "error" : "info");
				}
				return text(r.text, !r.ok, r.result);
			},
		});
	}
}
