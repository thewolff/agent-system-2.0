// Constants the orchestrator surface shares across its rows (MIGRATION.md M5; SPEC-2.0.md § A1.2,
// § A3, § B3, § B7, § B13.1). The surface reuses the gates' structural slice of OMP's extension API
// (gates/src/session.ts) so it loads and tests without the OMP package on the module path, and adds
// here the events and actions its own rows use beyond the gates' slice (measured on OMP 18.3.0,
// pi-coding-agent/src/extensibility/extensions/types.ts: ExtensionAPI.on for tool_approval_requested
// / tool_approval_resolved :1294-1295, tool_execution_end :1282, session_shutdown :1258;
// ExtensionAPI.sendMessage :1438-1441; ExtensionContext.setInterval :491, isIdle :455; on OMP 18.4.4:
// ExtensionContext.setTimeout :528, MessageEndEvent :868-871, ContextEventResult :1220-1222,
// BeforeAgentStartEventResult.message :1268 a CustomMessagePayload that keeps `details`).
import type { Ctx as GatesCtx, GatesAPI, ToolResult } from "../../gates/src/session";

export type { ToolResult } from "../../gates/src/session";
export { ROLE_ENV } from "../../gates/src/types";

/** The session context as the surface rows see it: the gates' slice plus the timer and idle query. */
export type Ctx = GatesCtx & {
	/** Timers and the terminal pair are host contract, pinned in gates/src/host.ts HOST_MEMBERS (ExtensionRunner#createContext on 18.4.4, runner.ts:1374-1407). */
	setInterval(callback: () => void, ms: number): unknown;
	/** A one-shot timer, cleared with the session's other timers at teardown (runner.ts:1406, :1432). */
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
	isIdle?(): boolean;
	/** Messages queued and not yet delivered (ExtensionContext.hasPendingMessages, types.ts:515 on OMP 18.8.6); absent → not known idle, so the typed-input sweep does nothing. */
	hasPendingMessages?(): boolean;
	/** Gracefully end this session and exit (types.ts:490 on OMP 18.4.4); a lane's terminal tools call it. */
	shutdown(): void;
	/** OMP's model registry (ExtensionContext.modelRegistry); the plan-first size judge resolves through it. */
	modelRegistry?: unknown;
	/** The session's current effective system prompt blocks (ExtensionContext.getSystemPrompt, types.ts:529 on OMP 18.8); at session_start the base prompt the launch built. */
	getSystemPrompt?(): string[];
};
type Handler<E, R = unknown> = (event: E, ctx: Ctx) => R | Promise<R>;
/** A custom message the surface sends or returns; `details` carries the push key the `context` guard reads (surface/extensions/wake.ts). */
export interface SurfaceMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}
/** A message as OMP hands it to `message_end` and `context` (an AgentMessage; only the fields the surface reads). */
export interface HostMessage {
	role: string;
	customType?: string;
	details?: unknown;
	/** An assistant message's text and tool-call blocks (pi-ai AssistantMessage.content); read through gates/src/session.ts `messageText`. */
	content?: unknown;
}
/**
 * The `session_before_compact` preparation as surface/extensions/plan-path.ts edits it (pi-agent-core
 * compaction/compaction.ts CompactionPreparation, OMP 18.8.6): handed over by reference, its arrays
 * read after the handlers; `recentEntryIds` runs parallel to `recentMessages` (the keep-tail boundary).
 * The gates' slice (gates/src/session.ts) types only the first two arrays.
 */
export interface CompactionPreparation {
	messagesToSummarize: HostMessage[];
	turnPrefixMessages: HostMessage[];
	recentMessages?: HostMessage[];
	recentEntryIds?: string[];
}
/** What `pi.exec` returns on OMP 18.4.4 (pi-coding-agent/src/exec/exec.ts:19-25). */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** The extension API as the surface rows see it: the gates' slice plus the lane-boundary events and the push action. */
export type SurfaceAPI = GatesAPI<Ctx> & {
	on(event: "tool_approval_requested", h: Handler<{ sessionId: string; toolCallId: string; toolName: string; reason?: string }>): void;
	on(event: "tool_approval_resolved", h: Handler<{ sessionId: string; toolCallId: string; toolName: string; approved: boolean; reason?: string }>): void;
	on(event: "tool_execution_end", h: Handler<{ toolCallId: string; toolName: string; result: unknown; isError: boolean }>): void;
	on(event: "session_shutdown", h: Handler<{ type: "session_shutdown" }>): void;
	/** OMP 18.4.4 types.ts:1267-1271: the turn's message may carry `details` (agent-session.ts:7306-7318 keeps them). */
	on(event: "before_agent_start", h: Handler<{ prompt: string; systemPrompt: string[] }, { systemPrompt?: string[]; message?: SurfaceMessage } | undefined>): void;
	/** Fires for a turn's input messages (pi-agent-core agent-loop.ts emitInputMessages) and for an aside folded into context (agent-session.ts:1178-1181). */
	on(event: "message_end", h: Handler<{ type: "message_end"; message: HostMessage }>): void;
	/** The messages about to reach the model; a returned `messages` replaces them (types.ts:1220-1222, runner.ts:1935). */
	on(event: "context", h: Handler<{ type: "context"; messages: HostMessage[] }, { messages?: HostMessage[] } | undefined>): void;
	/** OMP 18.3.0: `deliverAs: "aside"` injects at the next step boundary; an idle session starts a turn regardless of `triggerTurn`. */
	sendMessage?(message: SurfaceMessage, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" }): void;
	exec?(command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<ExecResult>;
	/** The zod members the lane tools use beyond the gates' slice (surface/extensions/lane-tools.ts). */
	zod: { array(item: unknown): ZodSchema; enum(values: readonly [string, ...string[]]): ZodSchema };
};
interface ZodSchema {
	describe(text: string): unknown;
	optional(): { describe(text: string): unknown };
}

/** The provenance stamp on every write the surface makes. */
export const SURFACE_BY = "orchestrator-surface";

/**
 * The orchestrator's standing workload: the one open workload that carries rows belonging to no
 * piece of work — the identity entry and scheduled rows. Opened on first wake, never closed.
 * The ledger's `entries` need an open workload (schema.sql entries_insert_workload), so the identity
 * row lives here rather than on whichever workload happens to be open.
 */
export const STANDING_WORKLOAD_ID = "wl-orchestrator";
export const STANDING_BRIEF = "orchestrator standing workload: identity and scheduled rows (never closed)";
/**
 * The standing slice on the standing workload (MIGRATION.md item 105): every QUESTION the
 * orchestrator puts to Jo is a `questions` row on it, so the row exists before Jo sees the ask,
 * Jo answers it by id, `stuck-question` counts it and a restart re-renders it. The insert trigger
 * (schema.sql questions_insert_workload) needs an open or paused slice; this one is ensured with
 * the workload (surface/src/identity.ts) and never cancelled: a withdrawal on it always replans.
 */
export const STANDING_SLICE_ID = "sl-orchestrator-questions";
export const STANDING_SLICE_TASK = "orchestrator questions to Jo: the standing slice every orchestrator question is raised on (never closed)";

/** Body prefix of the identity entry (kind `assumption`): `identity: <name> (<pronouns>)`. */
export const IDENTITY_PREFIX = "identity:";
/** Brief prefix of a scheduled row (M11): `due:<ISO date> <what to do>`; a workload of its own. */
export const DUE_PREFIX = "due:";
/** Body prefix of a lane→orchestrator message reporting a failed runtime artifact (§ B3 item 3). */
export const ARTIFACT_FAILED_PREFIX = "artifact-failed:";
/** Body prefix of a lane→orchestrator message reporting the same artifact passing: recovery clears the count (Codex S3). */
export const ARTIFACT_PASSED_PREFIX = "artifact-passed:";
/** How many artifact failures on one slice, since the last pass, reach the surface (§ B3 item 3: "twice", Jo's to change). */
export const ARTIFACT_FAILURES_SURFACED = 2;
/** Body prefix of the `assumption` entry a lane writes to declare a slice's runtime-artifact command (surface/src/signals.ts). */
export const ARTIFACT_COMMAND_PREFIX = "artifact-command:";
/**
 * Body prefix of the `assumption` entry the lane itself writes when a declared artifact command exits 0
 * and the working tree was the same before and after the run: `artifact-tree: {"repo","tree","command"}`
 * (surface/src/signals.ts). Reserved (surface/src/launch.ts CONTROL_PREFIXES): no lane *tool* can write it,
 * but a write through the ledger module can, as for every control line (wl-muptjioqjtvthc REVIEW.md N2).
 */
export const ARTIFACT_TREE_PREFIX = "artifact-tree:";
/** Body prefix of a message recording that a lane's session is gone with the workload still open (§ B3 item 4). */
export const LANE_DIED_PREFIX = "lane-died:";
/** Body prefixes of the leaked-prompt safety net (§ B3 item 5, first trigger): a wait began / it ended. */
export const PROMPT_WAIT_PREFIX = "prompt-wait:";
export const PROMPT_RESOLVED_PREFIX = "prompt-resolved:";
/** Body prefix of the test runner's message to the orchestrator for a non-green run on a workload no lane holds (MIGRATION.md item 24; surface/src/test-run.ts). */
export const TEST_RUN_FAILED_PREFIX = "test-run-failed:";
/** Control-entry prefixes of the test runner (surface/src/launch.ts WRITERS): the request, the result, and row 8's record of a push destination. */
export const TEST_REQUESTED_PREFIX = "test-requested:";
export const TEST_RUN_PREFIX = "test-run:";
export const PUSH_DEST_PREFIX = "push-dest:";
/** The recipient of every lane→orchestrator signal message; the surface consumes them at read. */
export const ORCHESTRATOR_RECIPIENT = "orchestrator";
/** § A3: a held thing older than this surfaces unsolicited. */
export const HOLD_HOURS = 4;
/** § B7: the last N ledger entries rendered per workload. */
export const LAST_N = 8;

/** Environment overrides. */
export const VOICE_ENV = "AGENT_SYSTEM_VOICE";
export const DECISION_LOG_ENV = "AGENT_SYSTEM_DECISION_LOG";
/** A lane's workload lease in ms (renewed at a third of it); default LEASE_MS. */
export const LEASE_MS_ENV = "AGENT_SYSTEM_LEASE_MS";
export const LEASE_MS = 15 * 60_000;
/** How often a primed lane re-reads the ledger for Jo's instruction rows it has not been handed (ms); default INSTRUCTION_POLL_MS. */
export const INSTRUCTION_POLL_MS_ENV = "AGENT_SYSTEM_LANE_INSTRUCTION_POLL_MS";
export const INSTRUCTION_POLL_MS = 15_000;
/** How often the surface re-reads the ledger between wakes for the § B3 lines (ms); default POLL_MS. */
export const POLL_MS_ENV = "AGENT_SYSTEM_SURFACE_POLL_MS";
export const POLL_MS = 60_000;
/** How long after session_start / session_compact the surface first tries to push a pending wake (ms); default WAKE_PUSH_MS. */
export const WAKE_PUSH_MS_ENV = "AGENT_SYSTEM_SURFACE_WAKE_PUSH_MS";
export const WAKE_PUSH_MS = 1_000;
/** How long the surface holds routine needs-you lines before pushing them as one aside (ms), from the first held line, never sliding; default BATCH_MS. 0 pushes at the poll that finds them. */
export const BATCH_MS_ENV = "AGENT_SYSTEM_SURFACE_BATCH_MS";
export const BATCH_MS = 300_000;
/** A Jo turn this long after his previous typed input carries the complete pending list once (ms); default QUIET_MS. */
export const QUIET_MS_ENV = "AGENT_SYSTEM_SURFACE_QUIET_MS";
export const QUIET_MS = 1_800_000;
/** How many times an unconfirmed wake or notice batch is sent before it falls back to Jo's next turn. */
export const PUSH_TRIES = 3;

/** Tools the surface registers on the orchestrator session. */
export const WAKE_READ_TOOL = "orchestrator_wake_read";
export const IDENTITY_TOOL = "orchestrator_identity";
export const OPEN_WORKLOAD_TOOL = "orchestrator_open_workload";
export const CLOSE_WORKLOAD_TOOL = "orchestrator_close_workload";
export const SCHEDULE_TOOL = "orchestrator_schedule";
/** Record Jo's answer or instruction on an open workload as an `instructions` row (M7 fix round 2, finding B). */
export const RECORD_INSTRUCTION_TOOL = "orchestrator_record_instruction";
/** Read the ledger between wakes: the wake render on demand (M7 fix round 2, finding C). */
export const LEDGER_TOOL = "orchestrator_ledger";
/** Jo's word to (re)launch an autonomous lane on a workload (DESIGN-lane-launcher.md § 4; surface/extensions/launch.ts). */
export const LAUNCH_LANE_TOOL = "orchestrator_launch_lane";
/** Lower a workload's ceiling; raising is Jo's (DESIGN-workload-ceiling.md § 2 item 2; surface/extensions/ceiling.ts). */
export const LOWER_CEILING_TOOL = "orchestrator_lower_ceiling";
/** Ask Jo a question as a `questions` row on the standing slice, before the QUESTION block names its id (MIGRATION.md item 105; surface/extensions/question.ts). */
export const RAISE_QUESTION_TOOL = "orchestrator_raise_question";
/** Record the orchestrator's recommended one-word answer for an answerable needs-you row (PLAN wl-mv66ylg1op3wg0 D3; surface/extensions/send-line.ts). */
export const RECOMMEND_TOOL = "orchestrator_recommend";
export const SURFACE_TOOLS = [WAKE_READ_TOOL, IDENTITY_TOOL, OPEN_WORKLOAD_TOOL, CLOSE_WORKLOAD_TOOL, SCHEDULE_TOOL, RECORD_INSTRUCTION_TOOL, LEDGER_TOOL, LAUNCH_LANE_TOOL, LOWER_CEILING_TOOL, RAISE_QUESTION_TOOL, RECOMMEND_TOOL] as const;
/** Surface tools that read rather than work (P-11 row 3's working-call test): the wake read records only that it read. */
export const SURFACE_READ_TOOLS = [WAKE_READ_TOOL, LEDGER_TOOL] as const;
/**
 * Surface tools that move a workload on — open, close, schedule — refused on the orchestrator while
 * a QUESTION it sent Jo about an open workload has no instruction row newer than it (P-11 row 15,
 * M7 fix round 2, finding B).
 */
export const HAND_ON_TOOLS = [OPEN_WORKLOAD_TOOL, CLOSE_WORKLOAD_TOOL, SCHEDULE_TOOL, LAUNCH_LANE_TOOL] as const;
/** The one tool the surface registers on a lane session: declare a slice's runtime-artifact command (surface/extensions/lane.ts). */
export const ARTIFACT_TOOL = "slice_artifact";
/** The lane's ledger tools (DESIGN-lane-launcher.md decision 4; surface/extensions/lane-tools.ts). */
export const LANE_ADD_SLICE_TOOL = "lane_add_slice";
export const LANE_COMPLETE_SLICE_TOOL = "lane_complete_slice";
export const LANE_RAISE_QUESTION_TOOL = "lane_raise_question";
export const LANE_RECORD_ENTRY_TOOL = "lane_record_entry";
export const LANE_MESSAGE_TOOL = "lane_message";
export const LANE_RELEASE_TOOL = "lane_release";
export const LANE_HANDOFF_TOOL = "lane_handoff";
/** Withdraw a held `reserved-request` this lane has gone past (MIGRATION.md item 31); writes `reserved-withdrawn: <id>[ <reason>]`. */
export const LANE_WITHDRAW_RESERVED_TOOL = "lane_withdraw_reserved";
/** Run the full suite outside the fence at a PR head (MIGRATION.md item 24; surface/src/test-run.ts; surface/extensions/lane-tools.ts). */
export const LANE_FULL_TEST_TOOL = "lane_full_test";
/** The unbudgeted read of a repo's M8 facts (MIGRATION.md item 106; surface/src/facts.ts readFacts; surface/extensions/lane-tools.ts). */
export const LANE_READ_FACTS_TOOL = "lane_read_facts";
export const LANE_TOOLS = [
	LANE_ADD_SLICE_TOOL, LANE_COMPLETE_SLICE_TOOL, LANE_RAISE_QUESTION_TOOL, LANE_RECORD_ENTRY_TOOL, LANE_MESSAGE_TOOL, LANE_WITHDRAW_RESERVED_TOOL, LANE_RELEASE_TOOL, LANE_HANDOFF_TOOL,
	LANE_FULL_TEST_TOOL, LANE_READ_FACTS_TOOL,
] as const;

/** The one-word flips Jo can type at the surface (§ A1.2, § B13.1). */
export const STAKES_WORDS = ["throwaway", "normal", "production"] as const;
export const MODE_WORDS = ["autonomous", "user-driven"] as const;
