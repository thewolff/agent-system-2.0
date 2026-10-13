// Jo's short inputs at the surface (SPEC-2.0.md § A1.2, § B3 item 5, § B13.1): a stakes or mode
// word, an option name, `withdraw`, `approve <id>` / `deny <id>`, `ceiling <usd> [<hours>] [wl-…]`
// (up to four words, never read as a batch), `rounds <n> [wl-…]` (up to three words, never read as
// a batch), `stop-reviews [wl-… | sl-…]` (PLAN wl-mupu0sx2o046io D9, D10), or a numbered batch
// answering needs-you lines by their session number ("1 approve, 2 deny", or one per line;
// MIGRATION.md § M7 follow-ups item 1). Read
// from the turn's prompt in `before_agent_start` rather than from the
// `input` event, because OMP emits `input` only from the interactive TUI
// (modes/controllers/input-controller.ts:966) and the surface has to behave the same from the TUI,
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
// Jo's prose as a receipt (Codex review of PR #55, B1; MIGRATION.md item 105 fix round 1): while an
// orchestrator question is open or a workload besides the standing one is, a prompt that applies as
// no command and that Jo typed (OMP's `input` event, source interactive or rpc — never the hidden
// session-stop continuation, an aside, or `omp -p`, which emit none) is written first as an
// `instruction` row by Jo on the standing workload, body = the prompt, and its `in-…` id is echoed
// into the turn's context. That row is the one authority orchestrator_record_instruction may
// resolve a question or record an instruction with (naming questionId or workloadId, and inputId):
// Jo's words reach the ledger from that row, never from the model's parameters. No `input` event,
// or a prompt the `input` text does not match, writes nothing: the model then has no receipt, and
// Jo answers by `<option> q-…` or instructs by a lane's word instead (fail closed).
//
// The same typed input is the one authority for a command that answers or withdraws the
// orchestrator's own question (Codex review of PR #55 round 2, B1): `<option> q-…`, `withdraw q-…`,
// a numbered batch or a paste line naming such a row applies only when Jo typed this exact prompt
// (source interactive or rpc, read once per turn), and `apply` refuses it otherwise, so an
// extension-sent prompt, a session_stop continuation, `omp -p`, a prompt the typed text does not
// match, or the same prompt arriving again with no new `input` resolves nothing, and a batch or
// paste carrying one applies nothing. Every other command still applies from the prompt alone.
// Limit (MIGRATION.md item 105, ruled 2026-10-12): OMP hands this handler the text as rewritten by
// every `input` handler loaded before it, source unchanged, so an in-process extension that runs
// first can rewrite Jo's text undetected; in-process extensions are inside the trust boundary.
//
// Lane launcher (DESIGN-lane-launcher.md decisions 7 and 9): an answer or a withdrawal is a
// resolution a parked lane resumes on, so the launch trigger runs after it (once per workload for
// a batch; `stop-reviews` withdraws the open review questions on its loops, so it runs it too); a
// flip to autonomous writes Jo's `launch-requested:` cause and runs the trigger; a flip
// to user-driven while an autonomous lane holds the workload writes the `lane-stop:` request the
// runner accepts.
import type { Ledger } from "../../ledger/src/index";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import { apply, type Command, commandShaped, interpret, interpretBatch, interpretPaste, type PasteInstruction } from "../src/input";
import { heldLive, laneStopRequestBody, launchRequestedBody } from "../src/launch";
import { oneLinerCore } from "../src/render";
import { type SurfaceSession, surfaceSession } from "../src/session";
import { type Ctx, RECORD_INSTRUCTION_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY } from "../src/types";
import { triggerLaunch } from "./launch";

/** The workload an answer or a withdrawal resolves (a parked lane resumes on it), else null; `stop-reviews` withdraws the review questions on its loops. */
const resumes = (cmd: Command): string | null => (cmd.kind === "answer" || cmd.kind === "withdraw" || cmd.kind === "stop-reviews" ? cmd.workloadId : null);

/** The workload the launch trigger runs for after `cmd`: one a resolution resumes, or one a flip to autonomous hands to a lane; else null. */
const launches = (cmd: Command): string | null => resumes(cmd) ?? (cmd.kind === "mode" && cmd.mode === "autonomous" ? cmd.workloadId : null);

/** `line 5` or `lines 5–7`: the span of a paste's plain-words run. */
const span = (i: PasteInstruction): string => (i.from === i.to ? `line ${i.from}` : `lines ${i.from}–${i.to}`);

/**
 * Apply one word command: `apply`, plus the control entry a mode flip implies, in the caller's
 * transaction (decision 6; Codex review S3): a flip to autonomous without its `launch-requested:`
 * would leave a relaunch nothing to consume; a flip to user-driven while an autonomous lane holds
 * the workload writes the `lane-stop:` request the runner accepts.
 */
function applyOne(ledger: Ledger, cmd: Command, typed: boolean): string {
	let r = apply(ledger, cmd, typed);
	if (cmd.kind === "mode") {
		const w = ledger.workload(cmd.workloadId);
		if (cmd.mode === "user-driven" && w && w.holder?.startsWith("lane-") && heldLive(w, ledger.now())) {
			ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: laneStopRequestBody(w.holder, "mode-flip", "jo") });
			r += `; stop requested of ${w.holder} (it accepts at its next poll)`;
		} else if (cmd.mode === "autonomous") {
			ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), "mode-flip") });
		}
	}
	return r;
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

export default function surfaceInputRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	/** Queue the echo lines for the next turn's context, record the input once, notify each line. */
	const echo = (s: SurfaceSession, ctx: Ctx, text: string, lines: string[], level: "info" | "warning"): void => {
		s.notices.push(...lines);
		pi.appendEntry("surface-input", { text, receipt: lines.join("\n") });
		for (const l of lines) ctx.ui.notify(l, level === "warning" || l.startsWith("could not") ? "warning" : "info");
	};

	/** An error as the surface reports it: the message, without the class name a String() would prefix. */
	const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

	/**
	 * The Jo-input row for a prose prompt (see the header): written only when Jo typed this prompt
	 * and there is something it could answer or instruct (an open orchestrator question, or an open
	 * workload besides the standing one), its id echoed for the recorder. `ledger` is the turn's
	 * handle when the prompt was read against the ledger already, else opened here.
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

	pi.on("input", (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		s.typed = event.source === "interactive" || event.source === "rpc" ? event.text : null;
		return undefined;
	});
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

	pi.on("before_agent_start", async (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const text = event.prompt.trim();
		// What Jo typed for this turn, if OMP's `input` said so; taken whether or not the prompt applies as a command.
		const typed = s.typed;
		s.typed = null;
		// Jo typed exactly this prompt (read once, above): the one authority an answer or withdrawal of the orchestrator's own question applies under (`apply`).
		const joTyped = typed !== null && typed.trim() === text;
		// Several lines are a paste, one command per line (a numbered batch one per line included, so its refusals name their lines).
		const paste = text.includes("\n");
		// Prose passes through untouched, without a ledger read (unless it is Jo's receipt, see the header): only a batch-shaped prompt, a short command, or a paste with such a line can be a command.
		if (paste ? !text.split("\n").some((l) => commandShaped(l.trim())) : !commandShaped(text)) {
			joInputRow(s, ctx, text, joTyped, null);
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
			const r = interpretPaste(ledger, s.numbering, text);
			if (!r) {
				joInputRow(s, ctx, text, joTyped, ledger);
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
			let echoes: { wl: string | null; line: string }[];
			try {
				// All-or-nothing, one transaction, in paste order; each command through apply(), so each is its own ledger row.
				echoes = ledger.write(() =>
					r.items.flatMap((item) => {
						if (item.kind === "instruction") return [{ wl: null, line: `${span(item)} → an instruction for you, one row: "${item.text.replace(/\s*\n\s*/g, " ")}"` }];
						try {
							if (item.kind === "batch") return item.items.map(({ n, cmd }) => ({ wl: launches(cmd), line: `#${n} → ${apply(ledger, cmd, joTyped)}` }));
							return [{ wl: launches(item.cmd), line: applyOne(ledger, item.cmd, joTyped) }];
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
				const echoes = ledger.write(() => batch.items.map(({ n, cmd }) => ({ wl: launches(cmd), line: `#${n} → ${apply(ledger, cmd, joTyped)}` })));
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
			const cmd = interpret(ledger, text);
			if (!cmd) {
				joInputRow(s, ctx, text, joTyped, ledger);
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
			const echoes = [{ wl: launches(cmd), line: ledger.write(() => applyOne(ledger, cmd, joTyped)) }];
			await launchAfter(ledger, echoes);
			receipt = echoes[0]!.line;
		} catch (err) {
			receipt = `could not apply "${text}": ${reason(err)}`;
		}
		echo(s, ctx, text, [receipt], "info");
		return undefined;
	});
}
