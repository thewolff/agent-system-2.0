// P-11 row 15 (tiers/orchestrator.md: "You open workloads and hand them to lanes"; "What you never
// do"): the orchestrator session does no lane work. In Jo's first 2.0 session (M7, 2026-09-30) the
// orchestrator, finding no lane, made a worktree, edited, committed, rebased, pushed and opened
// thewolff/agent-system-2.0 PR #1 itself; every lane row fired correctly and none said "not your
// role". On a session whose role is `orchestrator` this row refuses the lane's tools: the file
// writers (targets.ts WRITE_TOOLS), `write` to anything but one of the surface's ledger-tool
// `xd://` devices or one of the ctx MCP server's read tools, `task` dispatch, `eval`, and any `bash` command that is not read-only.
//
// Read-only is decided by the tables rows 6 and 10 already read (exec.ts, git-model.ts): every
// command the shell would run (expandShell, substitutions and pipes included) is typed as literal
// text with no wrapper and no variable assignment, and is one of: a READ_ONLY_HEADS or OUTPUT_ONLY
// name with no output option (readHeadUnmodeled); a SEARCH_HEADS name (grep, rg, find, sort, uniq,
// cut, awk) with none of its write or run forms (searchHeadUnmodeled); a git history read (gitReads:
// status, log, diff, show, rev-parse, ls-files, blame, describe, branch in list mode, remote with
// options only, worktree list, stash list, each with the options git-model allows, so an option
// that runs a program or writes a file is refused; global options per gitUnmodeled); a ctx
// history read (ctxUnmodeled: search, show, locate, blame, status, sources, doctor, graph search,
// none in a write form; M8 ctx wiring); or a `cd` to a literal directory. The only write destination allowed
// is a literal `/dev/null` (writeDestinations lists every redirect target; discarding output writes
// nothing). No inline code and nothing blind. Anything else is refused, an unmodeled form included:
// loud over silent. Lanes and hands are untouched.
//
// Intended ordering (Main, 2026-09-30): row 15 registers before row 6, so a reserved bash action on
// the orchestrator gets this refusal and records no `reserved-request`; the orchestrator never runs
// the command at all, so there is nothing for Jo to approve. Row 6 still records browser writes,
// which row 15 does not refuse.
//
// Answer first (M7 fix round 2, finding B; Jo's design via Main, 2026-09-30; MIGRATION.md item 105):
// Ilex asked Jo a QUESTION about an open workload, Jo answered "use your draft", and nothing reached
// the ledger, so the lane that picked the workload up had to reconstruct the decision from chat. Row
// 11 records Jo's input only on a lane bound to a workload; the orchestrator is bound to none, so it
// never fired here, and it records every input, which is wrong at the surface: Jo's next message may
// be a question about the question. Item 105 then found the asks themselves missing: the orchestrator's
// QUESTIONs were chat alone, invisible to the needs-you render, the invariant report and a restart.
// So every ask is a `questions` row first: the orchestrator raises it with orchestrator_raise_question
// (a row on its standing slice, surface/src/orchestrator-question.ts) and names the `q-…` id in the
// QUESTION block. The ask is bound to its rows at two points (Codex review of PR #55, B2 and B3):
//
// - At publication (`checkQuestionPublication`, run by gates/extensions/r01-turn-shape.ts on the
//   orchestrator's final reply, which it withholds on a refusal, and again at session_stop): every
//   `q-…` id the reply's QUESTION blocks name must be a row on the standing slice, still open, and
//   cited by no earlier published reply; a block naming none, an unknown id, a lane's row, a row off
//   the standing slice, a resolved row or a re-cited row refuses the reply (an ask with no row is not
//   asked). The rows a passing reply cites are recorded as one `assumption` entry on the standing
//   workload (`question-published: q-…`), so a later reply cannot cite them again. No wall-clock
//   comparison between the message and the row: ordering is the citation, not a timestamp.
// - At the next working call (`unansweredQuestion`): the latest assistant message carrying a real
//   **QUESTION** block (row 1's reading, questionBlocks) is *unrecorded* while any id it names is no
//   row on the standing slice, or names a resolved row never published (fail closed), and *open*
//   while any such row is still open; a reply the gates withheld (`GateSession.heldReply`) is *held*
//   with its reason, since the session file carries only its marker. Any of these refuses the call:
//   one this row refuses anyway (the answer-first line is the one Jo's words need, so it is said
//   first) or a HAND_ON_TOOLS call (open, close, schedule, launch). A row answered after publication
//   lifts it: Jo's `<option> q-…` at the surface resolves the row and mirrors the decision on the
//   subject workload; an answer in prose is recorded by the orchestrator with
//   orchestrator_record_instruction naming the question and Jo's input row, which does the same.
//   Reads, the wake read, the ledger read, the question tool and the recorder stay allowed.
// - Item 72 (the launch tool refused a relaunch over an answered question): its two causes were a
//   QUESTION naming several workloads and two clocks compared (the session entry's against the
//   ledger row's). Here the row's state is the order — the recorder answers the row in the same call
//   that produces its result, so the session's entries are not read for the answer and no clock is
//   compared — and a launch or a close that names exactly one workload (a non-empty string
//   `workloadId`, or in the device form a `content` that parses as a JSON object carrying one) is
//   refused only while an open row is about that workload or about nothing, so Jo's answer on A lets
//   A's relaunch through while B waits on its own row; a call whose target cannot be read is
//   unscoped, and every unscoped working call is refused while any row is open.
import { basename, resolve } from "node:path";
import type { Ledger, QuestionRow } from "../../../ledger/src/index";
import { standingSlice } from "../../../surface/src/identity";
import { questionSubject } from "../../../surface/src/orchestrator-question";
import { CLOSE_WORKLOAD_TOOL, HAND_ON_TOOLS, LAUNCH_LANE_TOOL, RAISE_QUESTION_TOOL, RECORD_INSTRUCTION_TOOL, STANDING_WORKLOAD_ID, SURFACE_TOOLS } from "../../../surface/src/types";
import { bashCommand, ctxUnmodeled, type Exec, type Expansion, expandShell, gitCall, gitUnmodeled, OUTPUT_ONLY, READ_ONLY_HEADS, readHeadUnmodeled, SEARCH_HEADS, searchHeadUnmodeled, writeDestinations } from "../exec";
import { gitReads } from "../git-model";
import { type AgentMessageLike, messageText } from "../session";
import { WRITE_TOOLS } from "../targets";
import type { CallContext, Refusal, ToolCall } from "../types";
import { questionBlocks } from "./r01-turn-shape";

export const ORCHESTRATOR_ROLE_REFUSAL = "the orchestrator opens workloads; a lane does this — open one with orchestrator_open_workload";

/** Tools that do a lane's work outright on the orchestrator: dispatch and code execution. */
const LANE_TOOLS: Record<string, true> = { task: true, eval: true };

/**
 * The ctx MCP server's tools (profile/mcp.json, server `ctx`), as OMP names them (`mcp__<server>_<tool>`).
 * OMP mounts MCP tools as `xd://` devices under the default tools.xdev, so the orchestrator reaches
 * them as `write xd://mcp__ctx_search`. ctx documents every one as a read ("The MCP process never
 * becomes a provider-history or derived-state writer", `ctx docs show mcp`, ctx 2.1.3). Listed by
 * name, not by prefix: a server named `ctx_x` would mint `mcp__ctx_x_…`.
 */
export const CTX_MCP_TOOLS = ["status", "sources", "search", "show_session", "show_event", "query_events", "blame"].map((t) => `mcp__ctx_${t}`);

/** The `xd://` devices the orchestrator may write: the surface's own ledger tools and ctx's read tools, mounted as devices. */
const LEDGER_DEVICES: Record<string, true> = Object.fromEntries([...SURFACE_TOOLS, ...CTX_MCP_TOOLS].map((t) => [`xd://${t}`, true]));

/**
 * The MCP tools the orchestrator may call by name: ctx's reads. With tools.xdev off OMP mounts MCP tools as
 * direct tools (`mcp__linear_save_issue`) rather than devices, so every other `mcp__` name is refused the
 * same as its device form, whatever server it belongs to.
 */
const CTX_MCP_DIRECT: Record<string, true> = Object.fromEntries(CTX_MCP_TOOLS.map((t) => [t, true]));

/** The surface tools that move a workload on, by name and as their `xd://` devices. */
const HAND_ON: Record<string, true> = Object.fromEntries(HAND_ON_TOOLS.flatMap((t) => [[t, true], [`xd://${t}`, true]]));

/** The hand-on tools that name one workload, so the answer-first check reads only that workload's questions (MIGRATION.md item 72). */
const SCOPED: Record<string, true> = { [LAUNCH_LANE_TOOL]: true, [CLOSE_WORKLOAD_TOOL]: true };

const record = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A workload id as the surface tools read it (`String(…).trim()`), or null when it is not a non-empty string: fail closed. */
const workloadIdOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The orchestrator's latest QUESTION to Jo as the ledger sees it: no row for it, rows still open, or a reply held unpublished. */
export type Unanswered =
	/** The QUESTION block names no `q-…` row on the standing slice, or one never published: the ask was never recorded. */
	| { kind: "unrecorded" }
	/** The block's rows that are still open, in the block's order, each with its subject workload (null: an ask with no subject, which scopes to nothing). */
	| { kind: "open"; questionIds: string[]; subjects: (string | null)[] }
	/** The session's last reply was withheld (r01-turn-shape) for `reason`: nothing works until a reply passes. */
	| { kind: "held"; reason: string };

/** One session entry as the answer-first check reads it (OMP session JSONL: `type`, `message`). */
export interface EntryLike {
	type: string;
	timestamp?: string;
	message?: AgentMessageLike;
}

const Q_ID = /\bq-[a-z0-9]+\b/g;

/** The `assumption` entry recording the rows a published reply cited: `question-published: q-a q-b`. */
export const publishedBody = (ids: readonly string[]): string => `question-published: ${ids.join(" ")}`;
const PUBLISHED = /^question-published: (.+)$/;

/** Every question id a published reply has cited (the standing workload's `question-published:` entries). */
export function publishedQuestionIds(ledger: Ledger): Set<string> {
	const out = new Set<string>();
	for (const e of ledger.entries(STANDING_WORKLOAD_ID, "assumption")) {
		const m = PUBLISHED.exec(e.body);
		if (m) for (const id of m[1]!.split(" ")) out.add(id);
	}
	return out;
}

/** The `q-…` ids `text`'s QUESTION blocks name, in order, once each; null when it carries no QUESTION block. */
export function questionIdsOf(text: string): string[] | null {
	const blocks = questionBlocks(text);
	return blocks.length === 0 ? null : [...new Set(blocks.join("\n").match(Q_ID) ?? [])];
}

/** The row `id`, when it is a question on the standing slice; null for an unknown id, a lane's row, or a row off the standing slice. */
function standingRow(ledger: Ledger, id: string): QuestionRow | null {
	const q = ledger.question(id);
	const slice = standingSlice(ledger);
	return q !== null && slice !== null && q.workload_id === STANDING_WORKLOAD_ID && q.slice_id === slice.id ? q : null;
}

/**
 * The latest QUESTION the orchestrator sent Jo, when the ledger does not show it answered: no row
 * for it (`unrecorded`), or a row still open. The ledger is opened only when there is a question.
 */
export function unansweredQuestion(entries: readonly EntryLike[], openLedger: () => Ledger): Unanswered | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const ids = questionIdsOf(messageText(e.message));
		if (ids === null) continue;
		if (ids.length === 0) return { kind: "unrecorded" };
		const ledger = openLedger();
		const rows = ids.map((id) => standingRow(ledger, id));
		if (rows.some((q) => q === null)) return { kind: "unrecorded" };
		const open = rows.filter((q) => q!.state === "open").map((q) => q!.id);
		if (open.length > 0) return { kind: "open", questionIds: open, subjects: open.map((id) => questionSubject(ledger, id)) };
		// Every row resolved: the ask lifted only if it was published with them (a resolved row never cited was never asked).
		const published = publishedQuestionIds(ledger);
		return ids.every((id) => published.has(id)) ? null : { kind: "unrecorded" };
	}
	return null;
}

/** The one line refusing a working call, or the reply itself, while the orchestrator's QUESTION has no ledger row. */
export const UNRECORDED_QUESTION_REFUSAL =
	`your QUESTION to Jo is not in the ledger: raise it with ${RAISE_QUESTION_TOOL} first and name the q-… id it returns in the QUESTION block, so Jo can answer it by id; a question with no row is not asked`;

/** The one line refusing a reply whose QUESTION names a row that was already resolved or already asked. */
export const reusedQuestionRefusal = (id: string, why: "answered" | "withdrawn" | "published"): string =>
	`your QUESTION to Jo names ${id}, ${why === "published" ? "which an earlier reply already asked" : `a row already ${why}`}: raise the ask again with ${RAISE_QUESTION_TOOL} and name the id it returns; a row is asked once`;

/** The one line refusing a working call while Jo's answer to the orchestrator's question is unrecorded. */
export const answerFirstRefusal = (ids: readonly string[]): string =>
	`your QUESTION to Jo (${ids.join(", ")}) is open in the ledger: if Jo's reply answers it, record it with ${RECORD_INSTRUCTION_TOOL} naming questionId ${ids[0]} and the inputId the surface named for Jo's words before any working call (Jo's own \`<option> ${ids[0]}\` at the surface does the same); a reply that does not answer it gets words, not work`;

/** The refusal for an `Unanswered`. */
export const unansweredRefusal = (q: Unanswered): string => (q.kind === "unrecorded" ? UNRECORDED_QUESTION_REFUSAL : q.kind === "held" ? q.reason : answerFirstRefusal(q.questionIds));

/** What publication found: the rows to cite, or the refusal. */
export type Publication = { ok: true; questionIds: string[] } | { ok: false; reason: string };

/**
 * Bind a reply's QUESTION blocks to their rows at publication: every id named is a row on the
 * standing slice, open, and cited by no earlier published reply. `ok` with no ids when the reply
 * carries no QUESTION block (the ledger is not opened). The caller records the citation
 * (`recordPublication`) once the reply is out; at `session_stop` (`published: true`) the reply's
 * own citation already exists, so a cited row passes there and only an uncited one is refused.
 */
export function checkQuestionPublication(text: string, openLedger: () => Ledger, published = false): Publication {
	const ids = questionIdsOf(text);
	if (ids === null) return { ok: true, questionIds: [] };
	if (ids.length === 0) return { ok: false, reason: UNRECORDED_QUESTION_REFUSAL };
	const ledger = openLedger();
	const cited = publishedQuestionIds(ledger);
	for (const id of ids) {
		const q = standingRow(ledger, id);
		if (!q) return { ok: false, reason: UNRECORDED_QUESTION_REFUSAL };
		if (published) {
			if (!cited.has(id)) return { ok: false, reason: UNRECORDED_QUESTION_REFUSAL };
			continue;
		}
		if (q.state !== "open") return { ok: false, reason: reusedQuestionRefusal(id, q.state) };
		if (cited.has(id)) return { ok: false, reason: reusedQuestionRefusal(id, "published") };
	}
	return { ok: true, questionIds: ids };
}

/**
 * Record that a published reply cited `questionIds`: one entry on the standing workload, by `by`.
 * Nothing for an empty list, and then the ledger is not opened: a reply naming no question never
 * depends on a readable ledger (MIGRATION.md item 105, fix round 2).
 */
export function recordPublication(openLedger: () => Ledger, questionIds: readonly string[], by: string): string | null {
	if (questionIds.length === 0) return null;
	const ledger = openLedger();
	return ledger.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(ledger)?.id ?? null, kind: "assumption", body: publishedBody(questionIds) });
}

/** A `cd` to one literal directory (or none): it moves the shell, and expandShell tracks where. */
const literalCd = (e: Exec): boolean => e.argv.length <= 2 && e.argv.every((w) => !w.opaque && !w.expanded && !w.glob);

/** Is `e` a read by the exec.ts and git-model.ts tables (see the header)? */
function readOnlyExec(e: Exec, assigned: Expansion["assigned"], env: Record<string, string | undefined>): boolean {
	const head = e.argv[0]!;
	const name = basename(head.text);
	if (head.opaque || head.expanded || head.glob || name !== head.text) return false;
	if (e.mods.wrappers.length > 0 || e.mods.assigns.length > 0) return false;
	if (writeDestinations(e).some((w) => w.opaque || w.expanded || w.text !== "/dev/null")) return false;
	if (READ_ONLY_HEADS[name] || OUTPUT_ONLY[name]) return readHeadUnmodeled(e) === null;
	if (SEARCH_HEADS[name]) return searchHeadUnmodeled(e, env) === null;
	if (name === "ctx") return ctxUnmodeled(e) === null;
	if (name === "cd") return literalCd(e);
	if (name !== "git") return false;
	const g = gitCall(e);
	return g !== null && gitUnmodeled(e, assigned) === null && gitReads(g);
}

/** True when every command `command` runs only reads, by the exec.ts and git-model.ts tables. */
export function readOnlyBash(command: string, cwd: string, env: Record<string, string | undefined>, toolEnv?: unknown): boolean {
	const x = expandShell(command, cwd, env, toolEnv);
	if (x.blind.length > 0 || x.code.length > 0 || x.assigned.size > 0 || x.commands.length === 0) return false;
	return x.commands.every((e) => readOnlyExec(e, x.assigned, env));
}

/** Row 15's role check alone: the lane's tools refused on the orchestrator. */
function roleRefusal(call: ToolCall, ctx: CallContext): Refusal {
	const { toolName, input } = call;
	const refuse: Refusal = { block: true, reason: ORCHESTRATOR_ROLE_REFUSAL };
	if (LANE_TOOLS[toolName]) return refuse;
	if (toolName.startsWith("mcp__")) return CTX_MCP_DIRECT[toolName] ? null : refuse;
	if (toolName === "write") return typeof input.path === "string" && LEDGER_DEVICES[input.path] ? null : refuse;
	if (WRITE_TOOLS[toolName]) return refuse;
	if (toolName === "bash") {
		const cwd = typeof input.cwd === "string" ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
		return readOnlyBash(bashCommand(input), cwd, ctx.env, input.env) ? null : refuse;
	}
	return null;
}

/** The one workload a launch or a close names, read fail-closed: a non-empty string `workloadId`, or in the device form a `content` that parses as a JSON object carrying one. Anything else is no target. */
function scopedTarget(call: ToolCall): string | null {
	const { toolName, input } = call;
	if (SCOPED[toolName]) return workloadIdOf(input.workloadId);
	if (toolName !== "write" || typeof input.path !== "string" || !input.path.startsWith("xd://") || !SCOPED[input.path.slice("xd://".length)]) return null;
	if (typeof input.content !== "string") return null;
	try {
		return workloadIdOf(record(JSON.parse(input.content))?.workloadId);
	} catch {
		return null;
	}
}

/**
 * Row 15 over one tool call: null off the orchestrator, and for every tool the orchestrator keeps.
 * `unanswered` is read only for a working call (see the header); it may throw, and the caller
 * refuses on that rather than guessing. A launch or close naming one workload is refused only
 * while an open row is about that workload or about nothing (MIGRATION.md item 72); every other
 * working call while any is, and every working call while the ask is unrecorded or held.
 */
export function checkOrchestratorRole(call: ToolCall, ctx: CallContext, unanswered: () => Unanswered | null = () => null): Refusal {
	if (ctx.role !== "orchestrator") return null;
	const role = roleRefusal(call, ctx);
	const handsOn = HAND_ON[call.toolName] || (call.toolName === "write" && typeof call.input.path === "string" && HAND_ON[call.input.path]);
	if (!role && !handsOn) return null;
	const q = unanswered();
	if (!q) return role;
	if (q.kind === "open") {
		const target = scopedTarget(call);
		if (target !== null && q.subjects.every((wl) => wl !== null && wl !== target)) return role;
	}
	return { block: true, reason: unansweredRefusal(q) };
}
