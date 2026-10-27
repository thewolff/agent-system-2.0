// State the P-11 rows share within one OMP session, and the structural slice of OMP's extension API
// they use. Each row registers from its own extension file (gates/extensions/, astra review S4), so
// a profile can drop one row without the rest; the rows that share state (the ledger connection,
// the session's tool history, the wake obligation, row 8's push-failure run) find it here, keyed on the
// session's SessionManager. The store hangs off globalThis so separately loaded extension modules
// still share one store. Hands re-bind the extensions (task/executor.ts:503-505) with their own
// SessionManager, so a hand's state never mixes with its lane's.
//
// OMP types are declared structurally rather than imported, so the gates load and test from a fresh
// clone with no OMP package on the module path. Event contracts measured on OMP 18.3.0: tool_call
// {block, reason} and revised `input` (omp://extensions.md:83, :369), before_agent_start
// {systemPrompt, message} (types.ts:1154-1158), input {handled} (types.ts:1131-1138),
// session_stop {decision:"block", reason} for top-level sessions only (omp://extensions.md:349),
// registerTool (types.ts:602-650, :1307). On OMP 18.4.4: assistant_message {message} → {content},
// text blocks rewritten in place, positions and every other block unchanged (types.ts:873-887,
// :1224-1237; runner.ts emitAssistantMessage).
import { Ledger } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";
import type { CommandFallback, FallbackAuthorization } from "./dispositions";
import { bashCommand } from "./exec";
import type { HistoryEvent } from "./rows/r03-receipts";
import { WakeRead } from "./rows/r07-wake-read";
import { PushFailures } from "./rows/r08-push-rebase";
import { InstructionRecorder } from "./rows/r11-jo-instruction";
import type { ModeController, ModeState } from "./rows/r14-ask-policy";
import { LANE_ENV, ROLE_ENV, type Role, type ToolCall, WORKLOAD_ENV } from "./types";

interface TextPart {
	type: string;
	text?: string;
}
export interface AgentMessageLike {
	role?: string;
	content?: string | TextPart[];
}
/** An entry on the session's current branch, as far as the gates read it (OMP session/session-entries.ts SessionMessageEntry, CustomEntry). */
export interface BranchEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
}
export interface Ctx {
	hasUI: boolean;
	cwd: string;
	/** `getBranch`: the current branch, root to leaf, custom entries included (OMP session/session-manager.ts getBranch); optional because not every host or fake carries it. */
	sessionManager: { getHeader(): { parentSession?: string } | null; getEntries(): { type: string }[]; getBranch?(): BranchEntry[]; getSessionFile?(): string | undefined; getSessionId?(): string };
	/** The calling host's local:// mapping (OMP ExtensionContext.localProtocolOptions). */
	localProtocolOptions?: { getArtifactsDir?: () => string | null; getSessionId?: () => string | null };
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
/**
 * A message in OMP's `context` event, as far as the gates read it (pi-ai types.ts AssistantMessage
 * and ToolResultMessage, session/messages.ts CustomMessage); every other field is carried through.
 */
export interface ContextMessage {
	role?: string;
	timestamp?: number;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	customType?: string;
	details?: unknown;
	[key: string]: unknown;
}
type Handler<E, R = unknown, C extends Ctx = Ctx> = (event: E, ctx: C) => R | Promise<R>;
interface StringSchema {
	describe(text: string): unknown;
	optional(): { describe(text: string): unknown };
}
export interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}
/** The extension API slice the gates use; `C` is the context type a consumer knows more about (the surface's Ctx adds the timer and lifecycle members). */
export interface GatesAPI<C extends Ctx = Ctx> {
	on(event: "session_start", h: Handler<{ type: "session_start" }, unknown, C>): void;
	on(event: "session_compact", h: Handler<{ type: "session_compact" }, unknown, C>): void;
	on(event: "before_agent_start", h: Handler<{ prompt: string; systemPrompt: string[] }, { systemPrompt?: string[]; message?: { customType: string; content: string; display: boolean } } | undefined, C>): void;
	on(event: "input", h: Handler<{ text: string; source: "interactive" | "rpc" | "extension" }, { handled: true } | undefined, C>): void;
	/** `additionalContext`: handler-authored text OMP delivers to the model after the batch's tool results (OMP 18.8.5 extensibility/shared-events.ts ToolCallEventResult; accumulated across handlers, dropped when any handler blocks or the call's result is an error). */
	on(event: "tool_call", h: Handler<{ toolName: string; toolCallId?: string; input: Record<string, unknown> }, { block?: boolean; reason?: string; input?: Record<string, unknown>; additionalContext?: string } | undefined, C>): void;
	/** `additionalContext` here is delivered even when the call failed (shared-events.ts ToolResultEventResult). */
	on(event: "tool_result", h: Handler<{ toolName: string; toolCallId?: string; input: Record<string, unknown>; details?: unknown; isError: boolean }, { additionalContext?: string } | undefined, C>): void;
	on(event: "tool_execution_start", h: Handler<{ toolName: string; toolCallId: string; args: unknown }, undefined, C>): void;
	on(event: "agent_end", h: Handler<{ willContinue?: boolean }, undefined, C>): void;
	on(event: "assistant_message", h: Handler<{ type: "assistant_message"; message: AgentMessageLike }, { content: TextPart[] } | undefined, C>): void;
	/** The messages about to be sent to the model (a copy; OMP 18.8.6 extensibility/extensions/runner.ts emitContext): `messages` replaces them for this request only, nothing is persisted. */
	on(event: "context", h: Handler<{ type: "context"; messages: ContextMessage[] }, { messages: ContextMessage[] } | undefined, C>): void;
	/**
	 * Before a compaction (OMP 18.8.6 extensibility/shared-events.ts SessionBeforeCompactEvent): `preparation` is handed over
	 * by reference and its message arrays are read after the handlers (session/session-maintenance.ts), so replacing them
	 * changes what is summarized or archived. `branchEntries` is the branch being compacted, root to leaf. The gates return
	 * nothing: no `cancel`, no `compaction`.
	 */
	on(event: "session_before_compact", h: Handler<{ type: "session_before_compact"; preparation: { messagesToSummarize: ContextMessage[]; turnPrefixMessages: ContextMessage[] }; branchEntries: BranchEntry[] }, undefined, C>): void;
	on(event: "session_stop", h: Handler<{ last_assistant_message?: AgentMessageLike }, { decision: "block"; reason: string } | undefined, C>): void;
	getActiveTools(): string[];
	getAllTools(): { name: string }[];
	setActiveTools(names: string[]): Promise<void>;
	appendEntry(customType: string, data?: unknown): void;
	/** Session-local slash commands; skill entries carry this caller's skill file path. */
	getCommands?(): { name: string; source?: string; path?: string }[];
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		approval?: "read" | "write" | "exec";
		/** OMP presents extension tools as `xd://` devices by default (`tools.xdev: true`, driven through `read`/`write`), so a
		 *  `tool_call` handler keyed on the tool name never sees them and the model has to discover the schema first. `"essential"`
		 *  keeps the tool top-level with its schema shipped (pi-coding-agent extensibility/extensions/types.ts:618). Found in Jo's
		 *  first real session 2026-09-30: the wake gate refused `write xd://orchestrator_wake_read` as "not the wake read". */
		loadMode?: "essential" | "discoverable";
		/** OMP passes the session's context fifth (omp://extensions.md, "Current `execute` signature"). */
		/** OMP's Component-shaped custom result renderer (extensions/types.ts ToolDefinition.renderResult). */
		renderResult?(result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: unknown, args?: Record<string, unknown>): { render(width: number): readonly string[]; invalidate(): void };
		execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: C): Promise<ToolResult>;
	}): void;
	zod: { object(shape: Record<string, unknown>): unknown; string(): StringSchema };
}

/** The text of an assistant message. */
export const messageText = (m: AgentMessageLike | undefined): string =>
	typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");

/** A hand is a subagent session: no UI and a parent session (task/executor.ts:3661-3664, :3829). */
function roleOf(ctx: Ctx, env: Record<string, string | undefined>): Role {
	if (!ctx.hasUI && ctx.sessionManager.getHeader()?.parentSession) return "hand";
	return env[ROLE_ENV] === "orchestrator" ? "orchestrator" : "lane";
}

export class GateSession {
	readonly role: Role;
	readonly workloadId: string | null;
	readonly laneId: string;
	/** What the session did, from `tool_result` (row 3). */
	readonly history: HistoryEvent[] = [];
	/** Row 8 refusals in a row on one slice, for the § B3 item 3 `artifact-failed:` messages. */
	readonly pushFailures = new PushFailures();
	/** The wake obligation (row 7), for a lane bound to a workload. */
	readonly wake: WakeRead | null;
	/** Jo's instructions, held until recorded (row 11), for a lane bound to a workload. */
	readonly instructions: InstructionRecorder | null;
	/** The mode in force for this turn (row 14), set before each lane turn. */
	mode: ModeState | null = null;
	modes: ModeController | null = null;
	/** Each bash call's command before the M4b fence wrapped it, by tool call id (fence.ts), until its result. */
	readonly bashOriginals = new Map<string, string>();
	/** The fence-off entry was written for this session (fence.ts). */
	fenceOffRecorded = false;
	/** The orchestrator's reply withheld this turn (r01-turn-shape), until its `session_stop`; row 15 refuses work while it stands. */
	heldReply: { original: string; reason: string } | null = null;
	/** Jo's trusted either/or authorization, bound to concrete requested paths. */
	commandFallbackAuthorization: FallbackAuthorization | null = null;
	/** Host-owned fallback rendered directly after a reserved execution refusal. */
	pendingCommandFallback: { fallback: CommandFallback; blocker: string } | null = null;
	#ledger: Ledger | null = null;

	constructor(
		ctx: Ctx,
		readonly env: Record<string, string | undefined>,
	) {
		this.role = roleOf(ctx, env);
		this.workloadId = env[WORKLOAD_ENV] || null;
		this.laneId = env[LANE_ENV] || `lane-${process.pid}`;
		const bound = this.bound;
		this.wake = bound ? new WakeRead(this.workloadId!, this.laneId, () => this.ledger()) : null;
		this.instructions = bound ? new InstructionRecorder(() => this.ledger(), this.workloadId!, this.laneId) : null;
	}

	/** The ledger, opened on first use through the module (row 10: the module is the only writer). */
	ledger(): Ledger {
		this.#ledger ??= Ledger.open(defaultLedgerPath(this.env));
		return this.#ledger;
	}

	/** A lane bound to a workload: the rows that read or write the ledger apply. */
	get bound(): boolean {
		return this.role === "lane" && this.workloadId !== null;
	}

	/**
	 * The slice this session works on: the workload's one slice in state `open`, else null (none, or
	 * several and nothing in the session says which). No slice binding reaches a session yet.
	 */
	currentSlice(): string | null {
		if (!this.workloadId) return null;
		const open = this.ledger().inFlight().find((w) => w.workload.id === this.workloadId)?.slices.filter((s) => s.state === "open") ?? [];
		return open.length === 1 ? open[0]!.id : null;
	}

	/**
	 * A `tool_result`'s input as the model wrote it: a bash call the M4b fence wrapped carries the
	 * wrapper in `input.command` (step 1, build note 2), so rows 3 and 8 read the original instead.
	 * A call the fence has not recorded (a `tool_call` handler reading before the fence runs, or the
	 * fence off) is read with a copied fence wrapper taken off (exec.ts bashCommand), so the surface
	 * and the rows see the command the model meant to run.
	 */
	originalInput(event: { toolName: string; toolCallId?: string; input: Record<string, unknown> }): Record<string, unknown> {
		if (event.toolName !== "bash") return event.input;
		const original = event.toolCallId ? this.bashOriginals.get(event.toolCallId) : undefined;
		return { ...event.input, command: original ?? bashCommand(event.input) };
	}
}

const STORE = Symbol.for("agent-system-2.0/p11-gates/sessions");
type Store = WeakMap<object, GateSession>;

/** This session's shared gate state, created on first use. */
export function gateSession(ctx: Ctx, env: Record<string, string | undefined>): GateSession {
	const g = globalThis as { [STORE]?: Store };
	const store = (g[STORE] ??= new WeakMap());
	let s = store.get(ctx.sessionManager);
	if (!s) {
		s = new GateSession(ctx, env);
		store.set(ctx.sessionManager, s);
	}
	return s;
}

const CONFINED = Symbol.for("agent-system-2.0/p11-gates/confined");

/**
 * Bash calls a scratch-root rule let through (PLAN wl-mv5oikd5jtquww § 1.2: row 6's rules 1–4 and 6,
 * row 8's skip), by tool call id, like GateSession.bashOriginals. The rows see the OMP event but not
 * its ctx, so this is keyed by id alone (ids are unique per call) and hangs off globalThis like the
 * session store. The fence (fence.ts) runs a marked call under the confined profile or refuses it,
 * and drops the id at the call's result.
 */
function confinedIds(): Set<string> {
	const g = globalThis as { [CONFINED]?: Set<string> };
	return (g[CONFINED] ??= new Set());
}

/** Mark `call` confined; a call with no tool call id cannot be (the fence refuses such a call anyway). */
export function markConfined(call: ToolCall): void {
	const id = "toolCallId" in call ? call.toolCallId : undefined;
	if (typeof id === "string" && id !== "") confinedIds().add(id);
}

/** Whether a row marked the call with this id confined. */
export function isConfined(toolCallId: string): boolean {
	return confinedIds().has(toolCallId);
}

/** Forget the mark, once the call has a result. */
export function releaseConfined(toolCallId: string): void {
	confinedIds().delete(toolCallId);
}
