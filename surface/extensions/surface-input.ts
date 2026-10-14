// Jo's short inputs at the surface (SPEC-2.0.md § A1.2, § B3 item 5, § B13.1): a stakes or mode
// word, an option name, `withdraw`, `approve <id>` / `deny <id>`, `ceiling <usd> [<hours>] [wl-…]`
// (up to four words, never read as a batch), `rounds <n> [wl-…]` (up to three words, never read as
// a batch), `stop-reviews [wl-… | sl-…]` (PLAN wl-mupu0sx2o046io D9, D10), `cancel-slice <sl-…>` and
// `supersede <wl-A> <wl-B>` (PLAN wl-mv5i3lulwwbbi8 D1, D2), `test-pr <wl-…> <N> [<N> …]`
// (any length, never read as a batch; PLAN wl-mv5qdfvv82ivwg § 2.1), or a numbered batch
// answering needs-you lines by their session number ("1 approve, 2 deny", or one per line;
// MIGRATION.md § M7 follow-ups item 1). Read
// from the turn's prompt in `before_agent_start` rather than from the `input` event, because
// OMP emits `input` from the interactive TUI and rpc only (input-controller.ts, rpc-mode.ts), never
// for `omp -p`, and the surface has to behave the same from the TUI,
// an rpc front-end and `omp -p`. Every current answerable line is numbered first (the session's
// Numbering, surface/src/numbering.ts), so a number or a "which one?" refusal always names the row
// Jo sees. A numbered batch of any length applies every valid piece and skips only the bad ones
// (PLAN wl-mv66ylg1op3wg0 D9): a number not given, a row no longer waiting, a word the row does not
// take, a number given twice (every piece with it). The valid pieces apply in one transaction, each
// through apply() in its own nested transaction (a savepoint), so a piece the ledger refuses rolls
// back alone and is skipped with the ledger's reason; one ledger row per applied answer. The echo is
// `#n → <receipt>` per applied piece and `#n skipped: <reason>` per skipped one, in batch order; a
// batch whose every piece is skipped writes nothing. A single word or word pair is applied as before, except that a bare answer word
// fitting more than one row, or a bare stakes, mode, `ceiling`, `rounds` or `stop-reviews` word
// with more than one workload in view, is refused with "which one?" and writes nothing. Everything is applied
// through the ledger module as author "jo", channel "surface" (§ B5), Jo is notified at once, and
// the echo lines are queued for the wake row (registered after this one) to put in the turn's
// context, so the model's reply reflects the new state. Anything not recognised passes through
// untouched.
//
// Plan paths (PLAN wl-mv61a8dh4aeneo D2): each echo line carries, beneath it and in the same notify
// string, the path of every open plan question it names (surface/src/plan-paths.ts), and is stored
// decorated for the next turn's Applied block; a "which one?" line gets one `plan for #n` line per
// plan candidate, in candidate order.
//
// A paste of several lines (MIGRATION.md item 48; surface/src/input.ts interpretPaste): one
// command per line, each read with the rules above and applied in one transaction, in order; a
// numbered batch one per line goes this way too (the comma form on one line is item 1's batch).
// Numbered pieces follow the skip rule above, across every line of the paste, and never refuse it.
// A command line that is not numbered is checked whole with the paste: one naming an id that does
// not resolve (`approve en-nope`), an ambiguous or refused word, or a row resolved twice refuses the
// paste rather than passing as prose; a refused paste writes nothing and echoes one verdict per
// command line, naming the line's number and text, with the "which one?" wording above. Such a
// command the ledger refuses inside the transaction is named by its line the same way, and nothing
// is applied; a launch that fails
// after the commit is named after the applied lines, never as a refusal. Each plain-words run
// between commands is its own Jo input row, written with the commands: when Jo typed the whole
// paste (the rule for prose below, read once for all of it) and there is something it could answer
// or instruct, each run is written inside the paste's transaction, in paste order, as an
// `instruction` row by Jo on the standing workload, body = the run's text. Only after the commit is
// each row's `surface-jo-input` entry appended and its `in-…` id echoed, named by the run's line
// span, for orchestrator_record_instruction to spend. A refused paste, or one the ledger refuses
// inside its transaction, writes no row and names no id; a paste Jo did not type (or with nothing
// open) applies its commands and names each run with no row written. A paste with no command line
// at all is prose.
//
// Jo's prose as a receipt (Codex review of PR #55, B1; MIGRATION.md item 105 fix round 1; PLAN
// wl-mv65nllu5g181s): while an orchestrator question is open or a workload besides the standing one
// is, a prompt that applies as no command and that Jo typed is written first as an `instruction`
// row by Jo on the standing workload, body = the prompt, and its `in-…` id is echoed into the
// turn's context. That row is the one authority orchestrator_record_instruction may resolve a
// question or record an instruction with (naming questionId or workloadId, and inputId): Jo's words
// reach the ledger from that row, never from the model's parameters. "Jo typed" is OMP's `input`
// event, source interactive or rpc (never the hidden session-stop continuation, an aside, or
// `omp -p`, which emit none): each pushes one entry on a FIFO in submission order, so a message
// sent before OMP dequeues the one before it waits its turn instead of overwriting it. A turn takes
// only its own entry, command or prose: the oldest whose trimmed text is the prompt, or the one
// contiguous run whose "\n\n" join is the prompt (OMP's steeringMode `all` delivers queued messages
// joined that way, agent-session.ts #prepareQueuedUserMessages). A prose take of a run writes one
// row and one echo per typed message, never one merged row; a joined prompt on a command path
// writes none and warns; a prompt that matches more than one way takes nothing and warns. An entry
// no turn takes is removed at the first prose take of a newer entry, or by the sweep once the
// session is idle with nothing queued (at a deferred agent_end and at the top of the next `input`),
// and judged: a TUI `!cmd` / `$ code` silently (OMP ran it locally), a `/…` with an info line that
// names only the command, never its arguments, anything else with a warning to Jo and the model;
// the same words arriving later get no row and one more warning. A prompt Jo did not type, or one
// no entry matches, writes no row (fail closed): the model then has no receipt, and Jo answers by
// `<option> q-…` or instructs by a lane's word instead.
//
// The same typed input is the one authority for a command that answers or withdraws the
// orchestrator's own question (Codex review of PR #55 round 2, B1): `<option> q-…`, `withdraw q-…`,
// a numbered piece or a paste line naming such a row applies only when Jo typed it (`apply`'s
// `typed`: at `before_agent_start` the turn's take of exactly this prompt; `ok` and a typed batch on
// one line are applied in the `input` handler, source interactive or rpc, and pass it always), and
// `apply` refuses it otherwise, so an extension-sent prompt, a session_stop continuation, `omp -p`,
// a prompt no typed entry matches, or the same prompt arriving again with no new `input` resolves
// nothing: a numbered piece naming one is skipped with that refusal (D9), and a paste's other
// command line naming one refuses the paste. Every other command still applies from the prompt alone.
// Limit (MIGRATION.md item 105, ruled 2026-10-12): OMP hands this handler the text as rewritten by
// every `input` handler loaded before it, source unchanged, so an in-process extension that runs
// first can rewrite Jo's text undetected; in-process extensions are inside the trust boundary.
//
// Lane launcher (DESIGN-lane-launcher.md decisions 7 and 9): an answer or a withdrawal is a
// resolution a parked lane resumes on, so the launch trigger runs after it (once per workload for
// a batch; `stop-reviews` withdraws the open review questions on its loops, and `cancel-slice` the
// cancelled slice's, so both run it too); a
// flip to autonomous writes Jo's `launch-requested:` cause and runs the trigger; a flip
// to user-driven while an autonomous lane holds the workload writes the `lane-stop:` request the
// runner accepts.
//
// Surface words (PLAN wl-mv5msri070p0qo D1, D4), each only as the whole trimmed input: `pending`
// and `brb` are read from the `input` event and handled there, so OMP drops them and no turn starts
// (`pending` shows the block of every open answer line as a `surface-pending` message, queued for
// the next idle poll while the session streams; `brb` holds the routine needs-you pushes); neither
// goes on the typed FIFO. `back` reaches the model, and the wake row reads it in its
// `before_agent_start`; its turn takes its own typed entry and writes no row.
//
// `ok` and a typed numbered batch apply at submit (PLAN wl-mv66ylg1op3wg0 D6, D7), in the `input`
// handler ahead of the surface words and the FIFO push, and are handled there, so nothing reaches
// the model or the FIFO. `ok` is read only from source interactive or rpc, only as the whole trimmed
// input (case-insensitive), and only while the session holds the binding of the `send:` line last
// rendered (surface/extensions/send-line.ts): with none it is ordinary prose, and a programmatic
// `sendUserMessage("ok")` fires no `input` and is prose too. A binding rendered before a later
// display of needs-you or answer lines (`binding.seq !== displaySeq`: a `pending` block, a wake or a
// needs-you aside) refuses the `ok` whole, nothing written. Otherwise its pieces are read back
// through interpretBatch over the current ledger and numbering (D9's skip rule) and applied in one
// transaction: Jo's `ok` input row, each piece in its own savepoint, and one `send-applied: sr-…
// in-<ok row> <answer rows> skipped <numbers>` entry on the standing workload, all of it even when
// every piece is skipped. The binding is consumed. A numbered batch typed on one line applies the
// same way with no `ok` row or link (the D9 echo lines unchanged); a paste, and any prompt that did
// not come through `input` (`omp -p`, an extension), still applies at `before_agent_start` as above.
// Either reply is one display (send-line.ts showReply): the applied and skipped lines, then a fresh
// needs-Jo list and `send:` line; held while a turn streams, shown after its end. When an applied
// answer is to the orchestrator's own question, a hidden turn follows the reply. A paste with
// plain-words runs that applied answers takes its normal turn, and the `surface-batch-turn` entry
// row 1 reads is written before it starts.
import type { Ledger } from "../../ledger/src/index";
import { AWAY_NOTICE, pendingText, surfaceWord } from "../src/batch";
import { errorLines, reservedStates } from "../src/errors";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import {
	apply, type BatchPiece, type Command, commandShaped, type HeartbeatOf, interpret, interpretBatch, interpretPaste, isSkip, modeFlipControl, parseBatch, type PasteInstruction,
	runHeartbeat,
} from "../src/input";
import { withPlanPathsOrWarn } from "../src/plan-paths";
import { oneLinerCore } from "../src/render";
import { type AppliedBatch, type BatchReply, DISCARDED_KEPT, type SurfaceSession, surfaceSession, type TypedEntry } from "../src/session";
import { sendAppliedBody } from "../src/triage";
import { type Ctx, RECORD_INSTRUCTION_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY } from "../src/types";
import { triggerLaunch } from "./launch";
import { batchTurnEntry, showReply, type TriageJudgeOf } from "./send-line";

/** The workload an answer or a withdrawal resolves (a parked lane resumes on it), else null; `stop-reviews` and `cancel-slice` withdraw questions too. */
const resumes = (cmd: Command): string | null =>
	cmd.kind === "answer" || cmd.kind === "withdraw" || cmd.kind === "stop-reviews" || cmd.kind === "cancel-slice" ? cmd.workloadId : null;

/** The workload the launch trigger runs for after `cmd`: one a resolution resumes, or one a flip to autonomous hands to a lane; else null. */
const launches = (cmd: Command): string | null => resumes(cmd) ?? (cmd.kind === "mode" && cmd.mode === "autonomous" ? cmd.workloadId : null);

/** `line 5` or `lines 5–7`: the span of a paste's plain-words run. */
const span = (i: PasteInstruction): string => (i.from === i.to ? `line ${i.from}` : `lines ${i.from}–${i.to}`);

/** An error as the surface reports it: the message, without the class name a String() would prefix. */
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A skipped numbered piece's echo line (D9). */
const skipLine = (n: number, why: string): string => `#${n} skipped: ${why}`;

/** `ok` with a binding rendered before the last needs-you display (D6): refused whole. */
export const STALE_OK = "nothing applied: the send line is no longer the last thing shown; answer by number or wait for the next send line";

/** A row an applied command resolved (D6, D7): the question or reserved request, its number (null: answered by id), the Jo row that answered it, and whether it is the orchestrator's own question. */
interface AppliedRow {
	rowId: string;
	n: number | null;
	answerId: string | null;
	standing: boolean;
}

/** An applied command's line, the workload its launch trigger runs for, and the row it resolved (none for a skipped piece or a command that resolves no row). */
type Echo = { wl: string | null; line: string; applied?: AppliedRow };

/** The row `cmd` resolved, read back after it applied: an answer or withdrawal's question and its resolving row, a reserved request and Jo's decision on it. */
function appliedRow(ledger: Ledger, cmd: Command, n: number | null): AppliedRow | undefined {
	if (cmd.kind === "answer" || cmd.kind === "withdraw") {
		return { rowId: cmd.questionId, n, answerId: ledger.question(cmd.questionId)?.resolved_by ?? null, standing: cmd.workloadId === STANDING_WORKLOAD_ID };
	}
	if (cmd.kind === "reserved") {
		const state = reservedStates(ledger, cmd.workloadId).find((r) => r.id === cmd.entryId)?.state;
		return { rowId: cmd.entryId, n, answerId: state && "instructionId" in state ? state.instructionId : null, standing: false };
	}
	return undefined;
}

/** The rows a batch applied, for the batch-turn entry; with `standingOnly`, null unless one of them answers the orchestrator's own question. */
function appliedBatch(echoes: readonly Echo[], standingOnly: boolean): AppliedBatch | null {
	const rows = echoes.filter((e) => e.applied);
	const standing = rows.filter((e) => e.applied!.standing);
	if (rows.length === 0 || (standingOnly && standing.length === 0)) return null;
	return {
		appliedIds: rows.map((e) => e.applied!.rowId),
		numbers: rows.flatMap((e) => (e.applied!.n === null ? [] : [e.applied!.n])),
		lines: standing.map((e) => e.line),
	};
}

/**
 * Apply one piece of a numbered batch inside the caller's `ledger.write` (D9): a skipped piece is
 * its `#n skipped: <reason>` line; a valid one goes through `apply()` in its own nested
 * transaction (a savepoint), so a ledger refusal rolls back that piece alone and skips it with the
 * ledger's message while the others stay applied. Returns the echo line, the workload the launch
 * trigger runs for and the row resolved (an applied piece's only). `typed` is `apply`'s: Jo typed
 * the input carrying this piece (`ok` and a typed batch at `input`, always; a turn's batch or paste,
 * its take), so a piece answering the orchestrator's own question without it is skipped with
 * `apply`'s refusal. `heartbeatOf` is `apply`'s too: the run heartbeat reader `cancel-slice`
 * re-checks its live run with, the one the piece was read with.
 */
function applyPiece(ledger: Ledger, p: BatchPiece, typed: boolean, heartbeatOf: HeartbeatOf): Echo {
	if (isSkip(p)) return { wl: null, line: skipLine(p.n, p.skip) };
	try {
		const receipt = ledger.write(() => apply(ledger, p.cmd, typed, heartbeatOf));
		return { wl: launches(p.cmd), line: `#${p.n} → ${receipt}`, applied: appliedRow(ledger, p.cmd, p.n) };
	} catch (err) {
		return { wl: null, line: skipLine(p.n, reason(err)) };
	}
}

/** A numbered line's verdict in a refused paste: `ok, not applied` when every piece is valid, else each piece ok or skipped. */
const piecesVerdict = (pieces: readonly BatchPiece[]): string =>
	pieces.some(isSkip) ? pieces.map((p) => (isSkip(p) ? skipLine(p.n, p.skip) : `#${p.n} ok, not applied`)).join("; ") : "ok, not applied";

/**
 * What a Jo input row could answer or instruct (see the header): the ids of the standing workload's
 * open questions (empty when only a workload besides the standing one is open, to instruct), or null
 * when there is nothing and no row is written.
 */
function receivable(ledger: Ledger): string[] | null {
	const inFlight = ledger.inFlight();
	const open = inFlight.find((w) => w.workload.id === STANDING_WORKLOAD_ID)?.openQuestions.map((q) => q.id) ?? [];
	return open.length > 0 || inFlight.some((w) => w.workload.id !== STANDING_WORKLOAD_ID) ? open : null;
}

/** Write `body` as Jo's input row on the standing workload (ensured first), in the caller's transaction; returns its `in-…` id. */
function writeJoInput(ledger: Ledger, body: string): string {
	ensureStandingWorkload(ledger);
	return ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(ledger)?.id ?? null, body, author: "jo", channel: "surface" });
}

/** What the recorder does with input `id`, `open` the standing questions it could answer: the tail of every Jo-input echo line. */
function recorderTail(id: string, open: string[]): string {
	const answer = open.length > 0 ? `if they answer ${open.join(" or ")}, record that with ${RECORD_INSTRUCTION_TOOL} naming questionId and inputId ${id}; ` : "";
	return `${answer}if they instruct you about an open workload, record that with ${RECORD_INSTRUCTION_TOOL} naming workloadId and inputId ${id} (Jo's words are read from the row, never from your parameters); if they do neither, record nothing`;
}

/**
 * A paste run's echo line: `lines 4–6 are Jo's input in-…: "<text>" — <recorderTail>`, or, with no
 * row written (`input` null), the run and why: Jo did not type the paste, or (`typed`) nothing was
 * open for it to answer or instruct.
 */
function runLine(run: PasteInstruction, input: string | null, open: string[], typed: boolean): string {
	const words = run.text.replace(/\s*\n\s*/g, " ");
	if (input === null) return `${span(run)} → an instruction for you, no input row written (${typed ? "nothing open it could answer or instruct" : "this paste was not typed by Jo"}): "${words}"`;
	return `${span(run)} ${run.from === run.to ? "is" : "are"} Jo's input ${input}: "${words}" — ${recorderTail(input, open)}`;
}

/** A paste's echo line; a plain-words run carries its Jo input row's id (null: none written), its line filled in the transaction and shown only after the commit. */
type PasteEcho = Echo & { run?: { item: PasteInstruction; input: string | null } };

/**
 * Apply one word command: `apply`, plus the control entry a mode flip implies (`modeFlipControl`), in the caller's
 * transaction (decision 6; Codex review S3): a flip to autonomous without its `launch-requested:` would leave a
 * relaunch nothing to consume; a flip to user-driven while an autonomous lane holds the workload writes the
 * `lane-stop:` request the runner accepts. Jo's `pair` answer writes its own inside `apply` (PLAN wl-mv67564rdkfvnk D7).
 * `heartbeatOf` is the reader the command was interpreted with, so `cancel-slice` re-checks its live run against the same files.
 */
function applyOne(ledger: Ledger, cmd: Command, typed: boolean, heartbeatOf: HeartbeatOf): string {
	const r = apply(ledger, cmd, typed, heartbeatOf);
	return cmd.kind === "mode" ? r + modeFlipControl(ledger, cmd.workloadId, cmd.mode) : r;
}

/** A ledger refusal inside a paste's transaction, carrying the line it happened on. */
class LineFailure extends Error {
	constructor(
		readonly line: number,
		readonly text: string,
		readonly cause: unknown,
	) {
		super(String(cause));
	}
}

/** `body` cut to 60 characters, `…` marking the cut. */
const clip = (body: string): string => (body.length > 60 ? `${body.slice(0, 59)}…` : body);

/** What a turn's prompt took from Jo's typed FIFO (see the header): one entry, a joined run (`seq` the first one's), or nothing because it matched more than one way. */
type Take = { kind: "one"; seq: number } | { kind: "joined"; texts: string[]; seq: number } | { kind: "ambiguous" };

/**
 * The typed entry a turn's prompt takes (PLAN wl-mv65nllu5g181s D2): candidates are (a) each entry
 * whose trimmed text is the trimmed prompt, and (b) each contiguous run of two or more entries
 * whose `"\n\n"` join, trimmed, is the prompt (OMP 18.8.6 agent-session.ts
 * `#prepareQueuedUserMessages` joins a dequeued batch that way under steeringMode `all`). Only (a):
 * the oldest is removed (duplicates are the same words; FIFO order picks one). Only (b) and one run:
 * the run is removed. Both, or two runs: ambiguous, nothing removed. Neither: null.
 */
function takeTyped(s: SurfaceSession, prompt: string): Take | null {
	const fifo = s.typed;
	const exact = fifo.findIndex((e) => e.text.trim() === prompt);
	const runs: { from: number; to: number }[] = [];
	for (let from = 0; from < fifo.length; from++) {
		let joined = fifo[from]!.text;
		for (let to = from + 1; to < fifo.length; to++) {
			joined += `\n\n${fifo[to]!.text}`;
			const t = joined.trim();
			if (t === prompt) runs.push({ from, to });
			// A longer run only lengthens the trimmed join once it has a non-blank start.
			if (t.length > prompt.length) break;
		}
	}
	if (exact >= 0 && runs.length === 0) return { kind: "one", seq: fifo.splice(exact, 1)[0]!.seq };
	if (exact < 0 && runs.length === 1) {
		const taken = fifo.splice(runs[0]!.from, runs[0]!.to - runs[0]!.from + 1);
		return { kind: "joined", texts: taken.map((e) => e.text), seq: taken[0]!.seq };
	}
	return exact >= 0 || runs.length > 1 ? { kind: "ambiguous" } : null;
}

// OMP 18.8.6 pi-coding-agent/src/modes/controllers/input-controller.ts `looksLikePastedShellPrompt`
// (:159-188), mirrored because OMP does not export it: a `$ ` line that looks like a pasted shell
// prompt is prose, not Python.
const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const OMP_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;
const looksLikePastedShellPrompt = (code: string): boolean => {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return SHELL_PROMPT_COMMAND_RE.test(firstLine) || SHELL_PROMPT_OPERATOR_RE.test(firstLine) || OMP_STATUS_LINE_RE.test(code);
};

/**
 * Text OMP's TUI runs locally by its prefix alone, never as a prompt (input-controller.ts:1138-1176
 * on OMP 18.8.6): `!cmd` / `!!cmd` with a non-empty command (bash), and `$ code` / `$$ code` with
 * non-empty code (Python), mirroring `pythonCommandPrefixLength` and `parsePythonCommandInput`
 * (:195-212), which OMP does not export: the sigil counts only when whitespace follows it, so
 * `$HOME is set` is prose.
 */
function runsLocally(raw: string): boolean {
	const text = raw.trim();
	if (text.startsWith("!")) return (text.startsWith("!!") ? text.slice(2) : text.slice(1)).trim() !== "";
	if (text.charCodeAt(0) !== 36 /* $ */) return false;
	const prefix = text.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = text.charCodeAt(prefix);
	if (next !== 32 && next !== 9 && next !== 10 && next !== 13) return false;
	const code = text.slice(prefix).trim();
	return code !== "" && !(prefix === 1 && looksLikePastedShellPrompt(code));
}

/** The first eight words of `text`, `…` marking a cut. */
const firstWords = (text: string): string => {
	const words = text.trim().split(/\s+/);
	return words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : words.join(" ");
};

/**
 * `which one? "approve" fits #1 (reserved en-…: push main), #2 (q-… on sl-…) — answer with the number, e.g. "1 approve"`;
 * a workload word: `which one? "production" fits wl-a (Fix the header; stakes: normal · mode: autonomous · ceiling $50 / 6h), wl-b (…) — add the id, e.g. "production wl-a"`.
 */
function whichOne(ledger: Ledger, s: SurfaceSession, cmd: Extract<Command, { kind: "ambiguous" }>): string {
	const fits = cmd.candidates.map((t) => {
		if (t.kind === "workload") {
			const w = ledger.workload(t.workloadId);
			return w ? `${t.workloadId} (${clip(w.brief.split("\n")[0]!)}; ${oneLinerCore(ledger, w)})` : t.workloadId;
		}
		const n = s.numbering.numberOf(t.rowId);
		const num = n === null ? "" : `#${n} `;
		if (t.kind === "reserved") {
			const body = ledger.entries(t.workloadId, "reserved-request").find((e) => e.id === t.rowId)?.body ?? "";
			return `${num}(reserved ${t.rowId}: ${clip(body)})`;
		}
		return `${num}(${t.rowId} on ${ledger.question(t.rowId)?.slice_id ?? "?"})`;
	});
	const rows = cmd.candidates.flatMap((t) => (t.kind === "workload" ? [] : [t]));
	if (rows.length === 0) return `which one? "${cmd.word}" fits ${fits.join(", ")} — add the id, e.g. "${cmd.word} ${cmd.candidates[0]!.workloadId}"`;
	const first = s.numbering.numberOf(rows[0]!.rowId) ?? 1;
	return `which one? "${cmd.word}" fits ${fits.join(", ")} — answer with the number, e.g. "${first} ${cmd.word}"`;
}

/** Show the `pending` block (D1): one `surface-pending` message, no turn; a ledger that cannot be read is said in its place. It shows answer lines, so it takes the next displaySeq (a `send:` line before it is no longer the last thing shown). */
export function showPending(pi: SurfaceAPI, s: SurfaceSession): void {
	let content: string;
	try {
		content = pendingText(s.ledger());
	} catch (err) {
		content = `## pending: the ledger could not be read: ${String(err)}`;
	}
	s.displaySeq++;
	pi.sendMessage?.({ customType: "surface-pending", content, display: true }, {});
}

/** `judgeOf`: the judge a batch reply's fresh render triages with (surface/index.ts wires OMP's judge role; tests a fake); null fails every judged row closed. */
export default function surfaceInputRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env, judgeOf: TriageJudgeOf = null): void {
	/** Queue the echo lines for the next turn's context, record the input once, notify each line (a skipped number or a failure as a warning); each line decorated with its plan paths first (D2). */
	const echo = (s: SurfaceSession, ctx: Ctx, text: string, lines: string[], level: "info" | "warning"): void => {
		const shown = lines.map((l) => withPlanPathsOrWarn(() => s.ledger(), s.numbering, l, (m) => ctx.ui.notify(m, "warning")));
		s.notices.push(...shown);
		pi.appendEntry("surface-input", { text, receipt: lines.join("\n") });
		for (const l of shown) ctx.ui.notify(l, level === "warning" || l.startsWith("could not") || /^#\d+ skipped: /.test(l) ? "warning" : "info");
	};

	/**
	 * The Jo-input row for a prose prompt (see the header): written only when Jo typed this prompt
	 * (`joTyped`, the turn's take) and there is something it could answer or instruct (an open
	 * orchestrator question, or an open workload besides the standing one), its id echoed for the
	 * recorder. `ledger` is the turn's handle when the prompt was read against the ledger already,
	 * else opened here.
	 */
	const joInputRow = (s: SurfaceSession, ctx: Ctx, text: string, joTyped: boolean, ledger: Ledger | null): void => {
		if (!joTyped) return;
		try {
			const l = ledger ?? s.ledger();
			const open = receivable(l);
			if (open === null) return;
			const id = l.write(() => writeJoInput(l, text));
			pi.appendEntry("surface-jo-input", { id });
			echo(s, ctx, text, [`Jo's words above are input ${id}: ${recorderTail(id, open)}`], "info");
		} catch (err) {
			echo(s, ctx, text, [`could not write Jo's words as an input row: ${reason(err)}`], "warning");
		}
	};

	/**
	 * A typed entry no turn took, removed from the FIFO (see the header): a TUI `!cmd` / `$ code`
	 * silently; a `/…` with an info line naming only the command, never its arguments (OMP keeps
	 * `/login <code>` and the like out of history; they reach no entry and no model notice here);
	 * anything else warned to Jo and the model, its words kept on `s.discarded` for the late-arrival
	 * warning.
	 */
	const judge = (s: SurfaceSession, ctx: Ctx, e: TypedEntry): void => {
		if (e.source === "interactive" && runsLocally(e.text)) return;
		const text = e.text.trim();
		const slash = /^\/(\S*)(\s+\S)?/.exec(text);
		if (slash) {
			const shown = `/${slash[1]}${slash[2] ? " …" : ""}`;
			echo(s, ctx, shown, [`Jo's input "${shown}" got no input row; if OMP ran it as a command that is expected, if it was a message Jo re-sends it`], "info");
			return;
		}
		s.discarded.push(text);
		if (s.discarded.length > DISCARDED_KEPT) s.discarded.splice(0, s.discarded.length - DISCARDED_KEPT);
		echo(s, ctx, text, [`Jo's message "${firstWords(text)}" got no input row (typed input not matched to any prompt): Jo re-sends it, or answers by <option> q-…`], "warning");
	};

	/** Remove and judge every typed entry older than `seq`: a prose turn took a newer one, so OMP delivered past them (it dequeues in submission order). */
	const discardOlder = (s: SurfaceSession, ctx: Ctx, seq: number): void => {
		const n = s.typed.findIndex((e) => e.seq >= seq);
		for (const e of s.typed.splice(0, n === -1 ? s.typed.length : n)) judge(s, ctx, e);
	};

	/**
	 * Remove and judge every typed entry pushed before the latest turn started (`seq <= startSeq`)
	 * that no turn took, but only while the session is idle with nothing queued; a host that cannot
	 * say both is not known idle, and nothing is swept.
	 */
	const sweepTyped = (s: SurfaceSession, ctx: Ctx): void => {
		if (!ctx.isIdle?.() || ctx.hasPendingMessages?.() !== false) return;
		const n = s.typed.findIndex((e) => e.seq > s.startSeq);
		for (const e of s.typed.splice(0, n === -1 ? s.typed.length : n)) judge(s, ctx, e);
	};

	/** Run the launch trigger once per workload the applied commands hand on, appending its line to the last echo for that workload; a trigger that throws is named there, the commands being applied already. */
	const launchAfter = async (ledger: Ledger, echoes: { wl: string | null; line: string }[]): Promise<void> => {
		for (const wl of [...new Set(echoes.map((e) => e.wl).filter((wl) => wl !== null))]) {
			const last = echoes.findLast((e) => e.wl === wl)!;
			try {
				const launched = await triggerLaunch(pi, ledger, env, wl, "jo");
				if (launched.line) last.line += `; ${launched.line}`;
			} catch (err) {
				last.line += `; applied, but the launch on ${wl} after it failed: ${String(err)}`;
			}
		}
	};

	/**
	 * The reply to a batch applied at submit (D7): the input recorded once as a session entry (never
	 * queued for the model), then one display, shown now when the session is idle with no reply
	 * already held, else added to the held reply that the turn's end shows (surface/extensions/send-line.ts).
	 */
	const reply = async (s: SurfaceSession, ctx: Ctx, text: string, echoes: Echo[]): Promise<void> => {
		const lines = echoes.map((e) => e.line);
		pi.appendEntry("surface-input", { text, receipt: lines.join("\n") });
		const trigger = appliedBatch(echoes, true);
		const held = s.heldReply;
		if (held || ctx.isIdle?.() === false) {
			const merged: BatchReply["trigger"] = held?.trigger && trigger
				? { appliedIds: [...held.trigger.appliedIds, ...trigger.appliedIds], numbers: [...held.trigger.numbers, ...trigger.numbers], lines: [...held.trigger.lines, ...trigger.lines] }
				: (held?.trigger ?? trigger);
			s.heldReply = { lines: [...(held?.lines ?? []), ...lines], trigger: merged };
			return;
		}
		await showReply(pi, s, ctx, judgeOf, { lines, trigger });
	};

	/** The ledger with every answerable line numbered (as a turn's read does), or null after a warning naming why it could not be read. */
	const numberedLedger = (s: SurfaceSession, ctx: Ctx, text: string): Ledger | null => {
		try {
			const ledger = s.ledger();
			s.numbering.assign(errorLines(ledger));
			return ledger;
		} catch (err) {
			ctx.ui.notify(`could not apply "${text}": ${reason(err)}`, "warning");
			return null;
		}
	};

	/** `ok` (D6): the binding's pieces, read back now, applied with Jo's `ok` row and the `send-applied:` link in one transaction; the binding consumed. */
	const applyOk = async (s: SurfaceSession, ctx: Ctx, text: string): Promise<void> => {
		const bound = s.sendLine!;
		if (bound.seq !== s.displaySeq) {
			ctx.ui.notify(STALE_OK, "warning");
			return;
		}
		const ledger = numberedLedger(s, ctx, text);
		if (!ledger) return;
		let echoes: Echo[];
		try {
			const pieces = interpretBatch(ledger, s.numbering, bound.pieces) ?? [];
			const heartbeatOf = runHeartbeat(env);
			echoes = ledger.write(() => {
				const okRow = writeJoInput(ledger, text);
				// typed = true: `ok` arrived by `input` with source interactive or rpc (the caller's check), the attestation `apply`'s orchestrator-question guard needs.
				const out = pieces.map((p) => applyPiece(ledger, p, true, heartbeatOf));
				const answers = out.flatMap((e) => (e.applied?.answerId ? [e.applied.answerId] : []));
				const skipped = pieces.flatMap((p, i) => (out[i]!.applied ? [] : [p.n]));
				ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: sendAppliedBody(bound.id, okRow, answers, skipped) });
				return out;
			});
		} catch (err) {
			ctx.ui.notify(`could not apply "${text}": ${reason(err)}; nothing was written`, "warning");
			return;
		}
		s.sendLine = null;
		await launchAfter(ledger, echoes);
		await reply(s, ctx, text, echoes);
	};

	/** A numbered batch typed on one line (D7, D9): every valid piece applied in one transaction, each in its own savepoint, the bad ones skipped and named. */
	const applyTypedBatch = async (s: SurfaceSession, ctx: Ctx, text: string): Promise<void> => {
		const ledger = numberedLedger(s, ctx, text);
		if (!ledger) return;
		let echoes: Echo[];
		try {
			const batch = interpretBatch(ledger, s.numbering, text) ?? [];
			// typed = true: this text arrived by `input` with source interactive or rpc (the caller's check), the attestation `apply`'s orchestrator-question guard needs.
			const heartbeatOf = runHeartbeat(env);
			echoes = ledger.write(() => batch.map((p) => applyPiece(ledger, p, true, heartbeatOf)));
		} catch (err) {
			ctx.ui.notify(`could not apply "${text}": ${reason(err)}`, "warning");
			return;
		}
		await launchAfter(ledger, echoes);
		await reply(s, ctx, text, echoes);
	};

	// `ok` and a typed numbered batch on one line (PLAN wl-mv66ylg1op3wg0 D6, D7) apply here and are handled, ahead of the surface words and
	// the FIFO push, so neither reaches the model. The surface words (PLAN wl-mv5msri070p0qo D1, D4), each only as the whole input: `pending`
	// and `brb` are handled here and take no turn (OMP drops a handled input), so they never enter the FIFO; `back` goes on to the model and
	// is read in the wake row's before_agent_start. Every typed input moves the quiet-stretch clock, and one that ends a stretch longer than
	// quietMs marks the turn it starts.
	pi.on("input", async (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		sweepTyped(s, ctx);
		const typed = event.source === "interactive" || event.source === "rpc";
		const prev = s.lastTypedAt;
		if (typed) s.lastTypedAt = s.now();
		const text = event.text.trim();
		if (typed && s.sendLine && text.toLowerCase() === "ok") {
			await applyOk(s, ctx, text);
			return { handled: true };
		}
		if (typed && !text.includes("\n") && parseBatch(text) !== null) {
			await applyTypedBatch(s, ctx, text);
			return { handled: true };
		}
		const word = surfaceWord(event.text);
		if (word === "pending") {
			// While the session streams, a message without deliverAs would become a steer: the next idle poll shows it, rendered then.
			if (ctx.isIdle?.() === false) s.pendingDisplay = true;
			else showPending(pi, s);
			return { handled: true };
		}
		if (word === "brb") {
			s.away = { since: s.now() };
			ctx.ui.notify(AWAY_NOTICE, "info");
			return { handled: true };
		}
		if (event.source === "interactive" || event.source === "rpc") s.typed.push({ text: event.text, seq: ++s.typedSeq, source: event.source });
		s.quietTurn = typed && prev !== null && Date.parse(s.lastTypedAt!) - Date.parse(prev) > s.quietMs;
		return undefined;
	});
	pi.on("agent_end", (_event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active || s.typed.length === 0) return undefined;
		// One macrotask later, so OMP's settle (the idle flag, the queues) has run first.
		ctx.setTimeout(() => sweepTyped(s, ctx), 0);
		return undefined;
	});

	/** A turn's prompt as Jo's input (see the header): a command applies; prose goes to `asProse`, which the caller's take decides. `byJo`: Jo typed exactly this prompt, once (the take). */
	const turn = async (s: SurfaceSession, ctx: Ctx, text: string, byJo: boolean, asProse: (ledger: Ledger | null) => void): Promise<undefined> => {
		// Several lines are a paste, one command per line (a numbered batch one per line included, so its refusals name their lines).
		const paste = text.includes("\n");
		// Prose passes through untouched, without a ledger read (unless it is Jo's receipt, see the header): only a batch-shaped prompt, a short command, or a paste with such a line can be a command.
		if (paste ? !text.split("\n").some((l) => commandShaped(l.trim())) : !commandShaped(text)) {
			asProse(null);
			return undefined;
		}
		let ledger: Ledger;
		try {
			ledger = s.ledger();
			s.numbering.assign(errorLines(ledger)); // D6: every answerable row has its number before a number or a "which one?" names it
		} catch (err) {
			echo(s, ctx, text, [`could not apply "${text}": ${reason(err)}`], "warning");
			return undefined;
		}
		// The run heartbeat reader every command of this prompt is read and applied with (`cancel-slice`'s live-run check, PLAN wl-mv5i3lulwwbbi8 D1).
		const heartbeatOf = runHeartbeat(env);

		if (paste) {
			const r = interpretPaste(ledger, s.numbering, text, heartbeatOf);
			if (!r) {
				asProse(ledger);
				return undefined;
			}
			/** The refusal echo: one verdict per command line, the held instructions, then the one line to fix. */
			const refuse = (verdicts: { at: number; line: string }[], held: PasteInstruction[], fix: number): void => {
				const instructions = held.map((h) => ({ at: h.from, line: `${span(h)}: an instruction for you, held with the rest; record nothing from this paste` }));
				const lines = [...verdicts, ...instructions].sort((a, b) => a.at - b.at).map((x) => x.line);
				echo(s, ctx, text, [...lines, `nothing applied: fix line ${fix} and paste all of it again`], "warning");
			};
			if (!r.ok) {
				const verdicts = r.refused.map((f) => ({
					at: f.line,
					line: `line ${f.line} "${f.text}": ${f.why !== null ? (Array.isArray(f.why) ? f.why.join("; ") : whichOne(ledger, s, f.why)) : piecesVerdict(f.pieces ?? [])}`,
				}));
				refuse(verdicts, r.held, r.refused.find((f) => f.why !== null)!.line);
				return undefined;
			}
			// Jo's input rows (see the header): the paste is authenticated once, whole, by the turn's take (`byJo`).
			let echoes: PasteEcho[];
			try {
				// One transaction, in paste order; each command through apply(), so each is its own ledger row, and each plain-words run of a paste Jo typed its own Jo input row.
				// A numbered piece is applied or skipped on its own (applyPiece, D9); a command line the ledger refuses rolls the whole paste back.
				echoes = ledger.write(() => {
					const rows = byJo && receivable(ledger) !== null;
					const out = r.items.flatMap((item): PasteEcho[] => {
						if (item.kind === "instruction") return [{ wl: null, line: "", run: { item, input: rows ? writeJoInput(ledger, item.text) : null } }];
						if (item.kind === "batch") return item.pieces.map((p) => applyPiece(ledger, p, byJo, heartbeatOf));
						try {
							const line = applyOne(ledger, item.cmd, byJo, heartbeatOf);
							const row = appliedRow(ledger, item.cmd, null);
							return [{ wl: launches(item.cmd), line, applied: row && { ...row, n: s.numbering.numberOf(row.rowId) } }];
						} catch (err) {
							throw new LineFailure(item.line, item.text, err);
						}
					});
					// Worded against the state the commands leave (a question a line answered is no longer one a run could answer); shown only after the commit.
					const open = receivable(ledger) ?? [];
					for (const e of out) if (e.run) e.line = runLine(e.run.item, e.run.input, open, byJo);
					return out;
				});
			} catch (err) {
				// The transaction rolled back: the ledger's refusal, on its line; every other command line stands unapplied.
				const held = r.items.filter((i): i is PasteInstruction => i.kind === "instruction");
				const failed = err instanceof LineFailure ? err : null;
				const verdicts = r.items.flatMap((i) => {
					if (i.kind === "instruction") return [];
					const why = failed?.line === i.line ? String(failed.cause) : i.kind === "batch" ? piecesVerdict(i.pieces) : "ok, not applied";
					return [{ at: i.line, line: `line ${i.line} "${i.text}": ${why}` }];
				});
				if (failed) refuse(verdicts, held, failed.line);
				else echo(s, ctx, text, [`could not apply "${text}": ${reason(err)}`], "warning");
				return undefined;
			}
			for (const e of echoes) if (e.run?.input) pi.appendEntry("surface-jo-input", { id: e.run.input });
			await launchAfter(ledger, echoes);
			// D7: a paste with plain-words runs that applied answers takes its turn (the model records the runs), scoped by row 1's batch-turn rules.
			const applied = echoes.some((e) => e.run) ? appliedBatch(echoes, false) : null;
			if (applied) batchTurnEntry(pi, s, applied);
			echo(s, ctx, text, echoes.map((e) => e.line), "info");
			return undefined;
		}

		const batch = interpretBatch(ledger, s.numbering, text);
		if (batch && batch.every(isSkip)) {
			// Every piece skipped (D9): nothing to apply, every piece named.
			echo(s, ctx, text, batch.map((p) => skipLine(p.n, p.skip)), "warning");
			return undefined;
		}
		if (batch) {
			let lines: string[];
			try {
				// D9: the valid pieces in one transaction, each through apply() in its own savepoint (its own ledger row); the skipped ones named, in batch order.
				const echoes = ledger.write(() => batch.map((p) => applyPiece(ledger, p, byJo, heartbeatOf)));
				await launchAfter(ledger, echoes);
				lines = echoes.map((e) => e.line);
			} catch (err) {
				lines = [`could not apply "${text}": ${reason(err)}`];
			}
			echo(s, ctx, text, lines, "info");
			return undefined;
		}

		let receipt: string;
		try {
			const cmd = interpret(ledger, text, heartbeatOf);
			if (!cmd) {
				asProse(ledger);
				return undefined;
			}
			if (cmd.kind === "ambiguous") {
				echo(s, ctx, text, [whichOne(ledger, s, cmd)], "warning");
				return undefined;
			}
			if (cmd.kind === "refused") {
				echo(s, ctx, text, [cmd.why], "warning");
				return undefined;
			}
			const echoes = [{ wl: launches(cmd), line: ledger.write(() => applyOne(ledger, cmd, byJo, heartbeatOf)) }];
			await launchAfter(ledger, echoes);
			receipt = echoes[0]!.line;
		} catch (err) {
			receipt = `could not apply "${text}": ${reason(err)}`;
		}
		echo(s, ctx, text, [receipt], "info");
		return undefined;
	};

	pi.on("before_agent_start", async (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const text = event.prompt.trim();
		// Every entry pushed by now was pushed before this turn started; the turn takes only its own, whether or not the prompt applies as a command.
		s.startSeq = s.typedSeq;
		const take = takeTyped(s, text);
		// `back` as the whole input is a surface word (D4), read by the wake row: never an answer, a command, or Jo's receipt; it consumed its own entry above.
		if (surfaceWord(text) === "back") return undefined;
		if (take?.kind === "ambiguous") echo(s, ctx, text, ["this prompt matches more than one way Jo's typed messages could have been delivered; no input row: re-send it"], "warning");
		// Jo typed exactly this prompt, once.
		const joTyped = take?.kind === "one";
		let prose = false;
		/** The prose path: entries older than the take are judged first, then one row per typed message taken, or the late-arrival warning for words already warned about. */
		const asProse = (ledger: Ledger | null): void => {
			prose = true;
			if (take?.kind === "one" || take?.kind === "joined") discardOlder(s, ctx, take.seq);
			if (take?.kind === "joined") {
				for (const t of take.texts) joInputRow(s, ctx, t.trim(), true, ledger);
				return;
			}
			const late = joTyped ? -1 : s.discarded.indexOf(text);
			if (late >= 0) {
				s.discarded.splice(late, 1);
				echo(s, ctx, text, ["these words match Jo's message warned about above; they have no input row: Jo re-sends it"], "warning");
				return;
			}
			joInputRow(s, ctx, text, joTyped, ledger);
		};
		try {
			return await turn(s, ctx, text, joTyped, asProse);
		} finally {
			if (take?.kind === "joined" && !prose) {
				echo(s, ctx, text, [`${take.texts.length} messages Jo typed arrived joined as one prompt (OMP steeringMode all); none got an input row: re-send the plain-words ones one at a time, or set steeringMode to one-at-a-time`], "warning");
			}
		}
	});
}
