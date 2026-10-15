// Jo's short inputs at the surface (SPEC-2.0.md § A1.2, § B3 item 5, § B13.1): a stakes or mode
// word, an option name, `withdraw`, `approve <id>` / `deny <id>`, `ceiling <usd> [<hours>] [wl-…]`
// (up to four words, never read as a batch), `rounds <n> [wl-…]` (up to three words, never read as
// a batch), `stop-reviews [wl-… | sl-…]` (PLAN wl-mupu0sx2o046io D9, D10), `cancel-slice <sl-…>` and
// `supersede <wl-A> <wl-B>` (PLAN wl-mv5i3lulwwbbi8 D1, D2), `test-pr <wl-…> <N> [<N> …]`
// (any length, never read as a batch; PLAN wl-mv5qdfvv82ivwg § 2.1), `withdraw <wl-…>` (any length,
// never read as a batch; PLAN wl-mv8s939084z1ts D1), or a numbered batch
// answering needs-you lines by their session number ("1 approve, 2 deny", or one per line;
// MIGRATION.md § M7 follow-ups item 1). Read
// from the turn's prompt in `before_agent_start` rather than from the `input` event, because
// OMP emits `input` from the interactive TUI and rpc only (input-controller.ts, rpc-mode.ts), never
// for `omp -p`, and the surface has to behave the same from the TUI,
// an rpc front-end and `omp -p`. Every current answerable line is numbered first (the session's
// Numbering, surface/src/numbering.ts), so a number or a "which one?" refusal always names the row
// Jo sees. A batch of any length is checked whole and applied all-or-nothing in one transaction,
// one ledger row and one echo line per answer; a refused batch writes nothing and echoes one line
// per piece. A single word or word pair is applied as before, except that a bare answer word
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
// command per line, each read with the rules above, checked whole and applied all-or-nothing in
// one transaction, in order; a numbered batch one per line goes this way too, so every refusal
// names its line (the comma form on one line is item 1's batch, unchanged). A refused paste writes
// nothing and echoes one verdict per command line, naming the line's number and text, with the
// batch and "which one?" wording above; a command naming an id that does not resolve (`approve
// en-nope`) refuses the paste rather than passing as prose. A command the ledger refuses inside
// the transaction is named by its line the same way, and nothing is applied; a launch that fails
// after the commit is named after the applied lines, never as a refusal. The plain-words lines
// between commands reach the orchestrator as one instruction per run, named in the echo by their
// line span, for it to record as one row afterwards: the commands are transactional, the prose is
// handed on, not committed with them. A paste with no command line at all is prose.
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
// Lane launcher (DESIGN-lane-launcher.md decisions 7 and 9): an answer or a withdrawal is a
// resolution a parked lane resumes on, so the launch trigger runs after it (once per workload for
// a batch; `stop-reviews` withdraws the open review questions on its loops, and `cancel-slice` the
// cancelled slice's, so both run it too); a
// flip to autonomous writes Jo's `launch-requested:` cause and runs the trigger; a flip
// to user-driven while an autonomous lane holds the workload writes the `lane-stop:` request the
// runner accepts.
//
// Closing a withdrawn workload (PLAN wl-mv8s939084z1ts D4): after the transaction that applied a
// `withdraw <wl-…>` commits, on the single word and the paste path (never on a refused paste or a
// rolled-back transaction), `closeAfter` closes each withdrawn workload through
// `closeWorkloadWithEntry` (the close tool's body, no receipt: the withdrawal stands in for it) and
// appends its line to that command's echo: `Closed <wl>.` with the decision-log entry, or `<wl> stays
// open: <refusal>; the tick retries the close`. A close that throws is named the same way (`withdrawn,
// but the close failed: …`), never as "could not apply", since the withdrawal is committed; the wake
// tick finishes a close the word could not (surface/extensions/wake.ts `catchUp`). A withdrawal is
// no resolution a lane resumes on, so it runs no launch trigger.
//
// Surface words (PLAN wl-mv5msri070p0qo D1, D4), each only as the whole trimmed input: `pending`
// and `brb` are read from the `input` event and handled there, so OMP drops them and no turn starts
// (`pending` shows the block of every open answer line as a `surface-pending` message, queued for
// the next idle poll while the session streams; `brb` holds the routine needs-you pushes); neither
// goes on the typed FIFO. `back` reaches the model, and the wake row reads it in its
// `before_agent_start`; its turn takes its own typed entry and writes no row.
import type { Ledger } from "../../ledger/src/index";
import { AWAY_NOTICE, pendingText, surfaceWord } from "../src/batch";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import { apply, type Command, commandShaped, type HeartbeatOf, interpret, interpretBatch, interpretPaste, modeFlipControl, type PasteInstruction, runHeartbeat } from "../src/input";
import { withPlanPathsOrWarn } from "../src/plan-paths";
import { oneLinerCore } from "../src/render";
import { DISCARDED_KEPT, type SurfaceSession, surfaceSession, type TypedEntry } from "../src/session";
import { type Ctx, RECORD_INSTRUCTION_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY } from "../src/types";
import { triggerLaunch } from "./launch";
import { closeWorkloadWithEntry } from "./workload";

/** The workload an answer or a withdrawal resolves (a parked lane resumes on it), else null; `stop-reviews` and `cancel-slice` withdraw questions too. */
const resumes = (cmd: Command): string | null =>
	cmd.kind === "answer" || cmd.kind === "withdraw" || cmd.kind === "stop-reviews" || cmd.kind === "cancel-slice" ? cmd.workloadId : null;

/** The workload the launch trigger runs for after `cmd`: one a resolution resumes, or one a flip to autonomous hands to a lane; else null. */
const launches = (cmd: Command): string | null => resumes(cmd) ?? (cmd.kind === "mode" && cmd.mode === "autonomous" ? cmd.workloadId : null);

/** `line 5` or `lines 5–7`: the span of a paste's plain-words run. */
const span = (i: PasteInstruction): string => (i.from === i.to ? `line ${i.from}` : `lines ${i.from}–${i.to}`);

/** One applied command's echo line: `wl` the workload the launch trigger runs for after it; `closes` the workload a `withdraw <wl-…>` closes after its transaction commits (PLAN wl-mv8s939084z1ts D4). */
type Echo = { wl: string | null; line: string; closes?: string };

/**
 * Apply one word command: `apply`, plus the control entry a mode flip implies (`modeFlipControl`), in the caller's
 * transaction (decision 6; Codex review S3): a flip to autonomous without its `launch-requested:` would leave a
 * relaunch nothing to consume; a flip to user-driven while an autonomous lane holds the workload writes the
 * `lane-stop:` request the runner accepts. Jo's `pair` answer writes its own inside `apply` (PLAN wl-mv67564rdkfvnk D7).
 * `heartbeatOf` is the reader the command was interpreted with, so `cancel-slice` re-checks its live run against the same files.
 */
function applyOne(ledger: Ledger, cmd: Command, heartbeatOf: HeartbeatOf): string {
	const r = apply(ledger, cmd, heartbeatOf);
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

/** Show the `pending` block (D1): one `surface-pending` message, no turn; a ledger that cannot be read is said in its place. */
export function showPending(pi: SurfaceAPI, s: SurfaceSession): void {
	let content: string;
	try {
		content = pendingText(s.ledger());
	} catch (err) {
		content = `## pending: the ledger could not be read: ${String(err)}`;
	}
	pi.sendMessage?.({ customType: "surface-pending", content, display: true }, {});
}

export default function surfaceInputRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	/** Queue the echo lines for the next turn's context, record the input once, notify each line; each line decorated with its plan paths first (D2). */
	const echo = (s: SurfaceSession, ctx: Ctx, text: string, lines: string[], level: "info" | "warning"): void => {
		const shown = lines.map((l) => withPlanPathsOrWarn(() => s.ledger(), s.numbering, l, (m) => ctx.ui.notify(m, "warning")));
		s.notices.push(...shown);
		pi.appendEntry("surface-input", { text, receipt: lines.join("\n") });
		for (const l of shown) ctx.ui.notify(l, level === "warning" || l.startsWith("could not") ? "warning" : "info");
	};

	/** An error as the surface reports it: the message, without the class name a String() would prefix. */
	const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
			const inFlight = l.inFlight();
			const open = inFlight.find((w) => w.workload.id === STANDING_WORKLOAD_ID)?.openQuestions.map((q) => q.id) ?? [];
			if (open.length === 0 && !inFlight.some((w) => w.workload.id !== STANDING_WORKLOAD_ID)) return;
			const id = l.write(() => {
				ensureStandingWorkload(l);
				return l.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(l)?.id ?? null, body: text, author: "jo", channel: "surface" });
			});
			pi.appendEntry("surface-jo-input", { id });
			const answer = open.length > 0 ? `if they answer ${open.join(" or ")}, record that with ${RECORD_INSTRUCTION_TOOL} naming questionId and inputId ${id}; ` : "";
			echo(s, ctx, text, [`Jo's words above are input ${id}: ${answer}if they instruct you about an open workload, record that with ${RECORD_INSTRUCTION_TOOL} naming workloadId and inputId ${id} (Jo's words are read from the row, never from your parameters); if they do neither, record nothing`], "info");
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

	// The surface words (PLAN wl-mv5msri070p0qo D1, D4), each only as the whole input: `pending` and `brb` are handled here and take no
	// turn (OMP drops a handled input), so neither goes on the typed FIFO; `back` goes on to the model and is read in the wake row's
	// before_agent_start. Every typed input moves the quiet-stretch clock, and one that ends a stretch longer than quietMs marks the turn it starts.
	pi.on("input", (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		sweepTyped(s, ctx);
		const typed = event.source === "interactive" || event.source === "rpc";
		const prev = s.lastTypedAt;
		if (typed) s.lastTypedAt = s.now();
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
	/** Run the launch trigger once per workload the applied commands hand on, appending its line to the last echo for that workload; a trigger that throws is named there, the commands being applied already. */
	const launchAfter = async (ledger: Ledger, echoes: Echo[]): Promise<void> => {
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
	 * PLAN wl-mv8s939084z1ts D4: close each workload a committed `withdraw <wl-…>` withdrew, appending the close's line to that
	 * command's echo: its text when closed, else the refusal and that the tick retries; a close that throws is named there too, never
	 * as "could not apply", the withdrawal being committed already.
	 */
	const closeAfter = async (ledger: Ledger, ctx: Ctx, s: SurfaceSession, echoes: Echo[]): Promise<void> => {
		for (const e of echoes) {
			if (e.closes === undefined) continue;
			try {
				const r = await closeWorkloadWithEntry(pi, ledger, env, e.closes, { now: s.now(), cwd: ctx.cwd, receipt: null });
				e.line += r.closed ? `; ${r.text}` : `; ${e.closes} stays open: ${r.text}; the tick retries the close`;
			} catch (err) {
				e.line += `; withdrawn, but the close failed: ${reason(err)}; the tick retries`;
			}
		}
	};

	/** A turn's prompt as Jo's input (see the header): a command applies; prose goes to `asProse`, which the caller's take decides. */
	const turn = async (s: SurfaceSession, ctx: Ctx, text: string, asProse: (ledger: Ledger | null) => void): Promise<undefined> => {
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

		if (paste) {
			const heartbeatOf = runHeartbeat(env);
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
					line: `line ${f.line} "${f.text}": ${f.why === null ? "ok, not applied" : Array.isArray(f.why) ? f.why.join("; ") : whichOne(ledger, s, f.why)}`,
				}));
				refuse(verdicts, r.held, r.refused.find((f) => f.why !== null)!.line);
				return undefined;
			}
			let echoes: Echo[];
			try {
				// All-or-nothing, one transaction, in paste order; each command through apply(), so each is its own ledger row.
				echoes = ledger.write(() =>
					r.items.flatMap((item) => {
						if (item.kind === "instruction") return [{ wl: null, line: `${span(item)} → an instruction for you, one row: "${item.text.replace(/\s*\n\s*/g, " ")}"` }];
						try {
							if (item.kind === "batch") return item.items.map(({ n, cmd }) => ({ wl: launches(cmd), line: `#${n} → ${apply(ledger, cmd, heartbeatOf)}` }));
							return [{ wl: launches(item.cmd), line: applyOne(ledger, item.cmd, heartbeatOf), closes: item.cmd.kind === "withdraw-workload" ? item.cmd.workloadId : undefined }];
						} catch (err) {
							throw new LineFailure(item.line, item.text, err);
						}
					}),
				);
			} catch (err) {
				// The transaction rolled back: the ledger's refusal, on its line; every other command line stands unapplied.
				const held = r.items.filter((i): i is PasteInstruction => i.kind === "instruction");
				const failed = err instanceof LineFailure ? err : null;
				const verdicts = r.items.flatMap((i) => {
					if (i.kind === "instruction") return [];
					const why = failed?.line === i.line ? String(failed.cause) : "ok, not applied";
					return [{ at: i.line, line: `line ${i.line} "${i.text}": ${why}` }];
				});
				if (failed) refuse(verdicts, held, failed.line);
				else echo(s, ctx, text, [`could not apply "${text}": ${reason(err)}`], "warning");
				return undefined;
			}
			await launchAfter(ledger, echoes);
			await closeAfter(ledger, ctx, s, echoes);
			echo(s, ctx, text, echoes.map((e) => e.line), "info");
			return undefined;
		}

		const batch = interpretBatch(ledger, s.numbering, text);
		if (batch && !batch.ok) {
			echo(s, ctx, text, batch.lines, "warning");
			return undefined;
		}
		if (batch) {
			let lines: string[];
			try {
				// D4: all-or-nothing, one transaction; each answer through apply(), so each is its own ledger row.
				const echoes = ledger.write(() => batch.items.map(({ n, cmd }) => ({ wl: launches(cmd), line: `#${n} → ${apply(ledger, cmd)}` })));
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
			const heartbeatOf = runHeartbeat(env);
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
			const echoes: Echo[] = [{ wl: launches(cmd), line: ledger.write(() => applyOne(ledger, cmd, heartbeatOf)), closes: cmd.kind === "withdraw-workload" ? cmd.workloadId : undefined }];
			await launchAfter(ledger, echoes);
			await closeAfter(ledger, ctx, s, echoes);
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
		// `back` as the whole input is a surface word (D4), read by the wake row: never an answer, a command, or Jo's receipt.
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
			return await turn(s, ctx, text, asProse);
		} finally {
			if (take?.kind === "joined" && !prose) {
				echo(s, ctx, text, [`${take.texts.length} messages Jo typed arrived joined as one prompt (OMP steeringMode all); none got an input row: re-send the plain-words ones one at a time, or set steeringMode to one-at-a-time`], "warning");
			}
		}
	});
}
