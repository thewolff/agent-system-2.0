// Jo's short inputs at the surface (SPEC-2.0.md § A1.2, § B3 item 5, § B5, § B13.1): a stakes
// word or a mode word flips the workload in view; an option name answers the open question that
// offers it; `withdraw` withdraws it (then replan; then cancel on the runner's ceiling question, whose
// default is the stop); `approve` / `deny` answers a reserved request. `approve <id>` / `deny <id>`
// naming a reserved request that exists but no longer waits (its lane stopped, decided, withdrawn,
// superseded) is refused with its state (`closedReservedRefusal`), never passed on as prose.
// A bare answer word with more than one possible target is refused as ambiguous ("which one?");
// `approve <id>`, `<option> <q-id>`, `withdraw <q-id>` name the target. A bare stakes, mode or
// `ceiling` word with more than one workload in view is refused the same way, the workloads as
// candidates; `<word> wl-…` names the workload. A numbered batch
// ("1 approve, 2 deny", or one per line) answers needs-you lines by their session number
// (surface/src/numbering.ts): validated whole, applied all-or-nothing (MIGRATION.md § M7 follow-ups
// item 1). Every applied word is a ledger row (§ B5: the flip is a ledgered instruction), author
// "jo", channel "surface". Anything else is ordinary conversation for the orchestrator model.
//
// A paste of several lines (MIGRATION.md item 48): each non-empty line is read on its own with the
// rules above (a numbered batch line keeps its comma form; `ceiling` and `rounds` keep their long
// forms; a stakes or mode word takes only a `wl-…` second word), checked whole and applied
// all-or-nothing in order, so `production wl-x` then `ceiling 120 wl-x` both land. A command naming
// an id that does not resolve (`approve en-nope`) refuses the paste, and so does a question or
// reserved request answered twice across lines. Consecutive lines that are no command form one
// plain-words instruction for the orchestrator, which records it as one row
// (`orchestrator_record_instruction`) after the commands land; a command line between two such
// runs separates two instructions. A paste with no command line at all is prose and passes through
// untouched, as a single prose line does.
//
// The workload ceiling (DESIGN-workload-ceiling.md § 1 B and D, § 2 items 2 and 5): the stakes word
// re-sizes the ceiling, `ceiling <usd> [<hours>] [wl-…]` sets Jo's exact figure, and an answer to the
// runner's ceiling question settles it (*extend* raises by one block and requests the relaunch). Each
// raise names the Jo instruction written first, which is what `effectiveCeiling` checks. The
// `ceiling` word is never a numbered batch.
//
// The review round limit (PLAN wl-mupu0sx2o046io D9, D10; SPEC-2.0.md § B4): `rounds <n> [wl-…]`
// sets the workload's limit (the instruction, then the `review-rounds:` entry naming it; never a
// numbered batch); an answer to the classifier's round-limit question (a `review-limit:` entry names
// it) settles the slice's loop: *extend* adds one block of rounds to that slice, *accept* and *stop*
// end the loop. `stop-reviews [wl-… | sl-…]` writes the instruction and `review-stop:`, withdraws
// (then cancel) every open round-limit or park question on the stopped loops, ends each loop with no
// round running, and echoes per loop the latest settled round's findings or the round still running.
// A bare `rounds <n>` or `stop-reviews` with several workloads in view asks "which one?".
import { parkQuestions } from "../../classifier/src/lab";
import { reviewStopBody, stopReviewsInstructionBody } from "../../classifier/src/review-stop";
import {
	countRounds, effectiveRoundLimit, type FindingKind, type Findings, parseReviewLimit, REVIEW_ROUND_DEFAULTS, reviewLoopEndBody,
	reviewRoundsBody, reviewRoundsExtendBody, type Round, ROUND_LIMIT_OPTIONS, type RoundLimitOption, roundsInstructionBody, SEVERITIES,
	severityLine, UNKNOWN,
} from "../../classifier/src/rounds";
import { LOW_CONFIDENCE_THRESHOLD } from "../../classifier/src/route";
import { LANE_RUNNER_BY, type Ledger, type Mode, type QuestionRow, type RoutingKind, type SliceRow, type Stakes } from "../../ledger/src/index";
import { type Ceiling, CEILING_OPTIONS, ceilingBody, effectiveCeiling, sizeFor } from "./ceiling";
import { closedReservedRefusal, waitingReserved } from "./errors";
import { controlEntries, heldLive, holdersOf, isPlanQuestionIn, launchRequestedBody, planApprovedBody } from "./launch";
import type { Numbering, Target } from "./numbering";
import { answerOrchestratorQuestion } from "./orchestrator-question";
import { MODE_WORDS, STAKES_WORDS, STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

/** A "which one?" candidate: a needs-you row (`Target`) or, for a bare stakes, mode, `ceiling`, `rounds` or `stop-reviews` word, a workload in view. */
export type Candidate = Target | { kind: "workload"; workloadId: string };

export type Command =
	| { kind: "stakes"; workloadId: string; stakes: Stakes }
	| { kind: "mode"; workloadId: string; mode: Mode }
	| { kind: "answer"; workloadId: string; questionId: string; answer: string }
	| { kind: "withdraw"; workloadId: string; questionId: string; then: "replan" | "cancel" }
	| { kind: "reserved"; workloadId: string; entryId: string; verdict: "approve" | "deny" }
	| { kind: "ceiling"; workloadId: string; usd: number; wallMin: number | null }
	/** `rounds <n>`: the workload's review round limit (D9). */
	| { kind: "rounds"; workloadId: string; rounds: number }
	/** `stop-reviews`: `target` is the workload's id (every loop on it) or one slice's id (that loop) (D10). */
	| { kind: "stop-reviews"; workloadId: string; target: string }
	/** A bare word that fits more than one row or workload: refused, never applied. */
	| { kind: "ambiguous"; word: string; candidates: Candidate[] }
	/** A command naming a row it cannot take (`deny en-…` for a request no longer waiting): refused with `why`, never applied and never prose. */
	| { kind: "refused"; why: string };

/** Workloads Jo's words apply to: the open workloads other than the standing one, oldest first. */
export function workloadsInView(ledger: Ledger): string[] {
	return ledger.inFlight().map((w) => w.workload.id).filter((id) => id !== STANDING_WORKLOAD_ID);
}

/**
 * Interpret `text`. A stakes/mode word alone targets the only workload in view (or the one given
 * as a second word: `production wl-…`); with several in view it is `ambiguous`, the workloads as
 * candidates; `stop-reviews` and `rounds <n>` read their workload the same way, and `stop-reviews
 * sl-…` names one slice's loop. An answer word (`approve`/`deny`, `withdraw`, an option) alone
 * applies only when it fits exactly one row; fitting several it is `ambiguous`, and the second word
 * (an entry or question id) picks the row.
 */
export function interpret(ledger: Ledger, text: string): Command | null {
	const words = text.trim().split(/\s+/);
	const word = words[0]!.toLowerCase();
	const view = workloadsInView(ledger);
	// The commands longer than two words; one that does not parse falls through, so an option named "ceiling" or "rounds" still answers.
	if (word === "ceiling") {
		const c = ceilingCommand(words.slice(1), view);
		if (c) return c;
	}
	if (word === "rounds") {
		const c = roundsCommand(words.slice(1), view);
		if (c) return c;
	}
	if (words.length === 0 || words.length > 2) return null;
	const arg = words[1];
	const target = (): string | null => (arg && view.includes(arg) ? arg : view.length === 1 ? view[0]! : null);
	const workloadWord = (STAKES_WORDS as readonly string[]).includes(word) || (MODE_WORDS as readonly string[]).includes(word) || word === "user driven";
	if (workloadWord && !arg && view.length > 1) return { kind: "ambiguous", word, candidates: workloadCandidates(view) };

	if ((STAKES_WORDS as readonly string[]).includes(word)) {
		const wl = target();
		return wl ? { kind: "stakes", workloadId: wl, stakes: word as Stakes } : null;
	}
	if ((MODE_WORDS as readonly string[]).includes(word) || word === "user driven") {
		const wl = target();
		return wl ? { kind: "mode", workloadId: wl, mode: (word === "user driven" ? "user-driven" : word) as Mode } : null;
	}
	// One token (D10), so it never answers the ceiling question's `stop` option.
	if (word === "stop-reviews") return stopReviewsCommand(ledger, arg, view);
	if (!arg) {
		const candidates = bareTargets(ledger, view, word);
		if (candidates.length > 1) return { kind: "ambiguous", word, candidates };
	}
	if (word === "approve" || word === "deny") {
		// The orchestrator's own reserved refusals sit on the standing workload (gates/extensions/r06-reserved.ts): searched last.
		for (const wl of [...view, STANDING_WORKLOAD_ID]) {
			const waiting = waitingReserved(ledger, wl);
			const hit = arg ? waiting.find((r) => r.id === arg) : waiting[0];
			if (hit) return { kind: "reserved", workloadId: wl, entryId: hit.id, verdict: word };
		}
		// A reserved request named that exists, on any workload, but no longer waits (its lane stopped, decided, withdrawn, superseded, workload closed): refused with its state.
		const closed = arg ? closedReservedRefusal(ledger, arg, word) : null;
		if (closed) return { kind: "refused", why: closed };
		// No reserved request waits: *approve* is then an ordinary option word (the plan question's, decision 15).
	}
	const questions = ledger.inFlight().flatMap((w) => w.openQuestions);
	if (word === "withdraw") {
		const q = arg ? questions.find((x) => x.id === arg) : questions[0];
		if (!q) return null;
		// The ceiling question has nothing to replan: withdrawing it cancels its slice, so the close is not blocked, and the lane stops at the ceiling (the default).
		const then = isCeilingQuestion(q, ledger.slice(q.slice_id)) ? "cancel" : "replan";
		return { kind: "withdraw", workloadId: q.workload_id, questionId: q.id, then };
	}
	const matches = questions.filter((q) => q.options.some((o) => o.toLowerCase() === word));
	const q = arg ? matches.find((x) => x.id === arg) : matches[0];
	if (!q) return null;
	const answer = q.options.find((o) => o.toLowerCase() === word)!;
	return { kind: "answer", workloadId: q.workload_id, questionId: q.id, answer };
}

/**
 * Every row a bare answer word could answer, reserved requests first (the needs-you order):
 * `approve` / `deny` fit every waiting reserved request (the standing workload's included) and every
 * open question offering the word; `withdraw` fits every open question; another word fits every
 * open question offering it.
 */
function bareTargets(ledger: Ledger, view: string[], word: string): Target[] {
	const out: Target[] = [];
	if (word === "approve" || word === "deny") {
		for (const wl of [...view, STANDING_WORKLOAD_ID]) {
			for (const r of waitingReserved(ledger, wl)) out.push({ kind: "reserved", workloadId: wl, rowId: r.id });
		}
	}
	for (const q of ledger.inFlight().flatMap((w) => w.openQuestions)) {
		if (word === "withdraw" || q.options.some((o) => o.toLowerCase() === word)) out.push({ kind: "question", workloadId: q.workload_id, rowId: q.id });
	}
	return out;
}

/** One piece of a numbered batch: `1 approve`, `#1 approve`, `1: approve`, `q1: approve`, `1) deny`. */
const BATCH_PIECE = /^(?:#|q)?(\d+)\s*[:.)]?\s+(\S+)$/i;

export interface BatchItem {
	n: number;
	cmd: Command;
}
export type BatchResult = { ok: true; items: BatchItem[] } | { ok: false; lines: string[] };

/** The words a single-line command may run to: `ceiling <usd> [<hours>] [wl-…]` is four, `rounds <n> [wl-…]` three, everything else two. */
export function maxWords(text: string): number {
	const long = /^(ceiling|rounds)\s/i.exec(text)?.[1]!.toLowerCase() ?? null;
	return long === "ceiling" ? 4 : long === "rounds" ? 3 : 2;
}

/** Could `text` (one line, trimmed) be a command: a numbered batch, or short enough for a word command. A false means prose, with no ledger read. */
export function commandShaped(text: string): boolean {
	return text.length > 0 && (parseBatch(text) !== null || text.split(/\s+/).length <= maxWords(text));
}

/** The pieces of a numbered batch (split on newlines and commas, trimmed, empties dropped), or null when any piece is not `<n> <word>`. */
export function parseBatch(text: string): { n: number; word: string }[] | null {
	const pieces = text.split(/[\n,]/).map((p) => p.trim()).filter((p) => p.length > 0);
	if (pieces.length === 0) return null;
	const parsed: { n: number; word: string }[] = [];
	for (const p of pieces) {
		const m = BATCH_PIECE.exec(p);
		if (!m) return null;
		parsed.push({ n: Number(m[1]), word: m[2]! });
	}
	return parsed;
}

/**
 * Interpret `text` as a numbered batch (`parseBatch`); null when it is not one, so prose passes
 * through. Each piece is checked against the session numbering: the number was given, its row
 * still waits, the word fits the row, the number appears once. All pass → the commands in order;
 * any fails → one line per piece, nothing to apply.
 */
export function interpretBatch(ledger: Ledger, numbering: Numbering, text: string): BatchResult | null {
	const parsed = parseBatch(text);
	if (!parsed) return null;
	const checked = checkBatch(ledger, numbering, parsed);
	const items = checked.filter((c): c is BatchItem => typeof c !== "string");
	if (items.length === checked.length) return { ok: true, items };
	return { ok: false, lines: checked.map((c) => (typeof c === "string" ? c : `#${c.n} ok, not applied`)) };
}

/** Each piece of a parsed batch checked against the session numbering (`interpretBatch`): the command, or the one-line refusal. */
function checkBatch(ledger: Ledger, numbering: Numbering, parsed: readonly { n: number; word: string }[]): (BatchItem | string)[] {
	const inFlight = ledger.inFlight();
	const open = new Set(inFlight.map((w) => w.workload.id));
	const questions = new Map(inFlight.flatMap((w) => w.openQuestions).map((q) => [q.id, q]));
	return parsed.map(({ n, word }): BatchItem | string => {
		if (parsed.filter((x) => x.n === n).length > 1) return `#${n} appears more than once in this batch`;
		const t = numbering.target(n);
		if (!t) return `#${n} is not on the needs-you list`;
		const stale = `#${n} (${t.rowId}) is no longer waiting`;
		const w = word.toLowerCase();
		if (t.kind === "reserved") {
			if (!open.has(t.workloadId) || !waitingReserved(ledger, t.workloadId).some((r) => r.id === t.rowId)) return stale;
			if (w !== "approve" && w !== "deny") return `#${n} takes: approve / deny`;
			return { n, cmd: { kind: "reserved", workloadId: t.workloadId, entryId: t.rowId, verdict: w } };
		}
		const q = questions.get(t.rowId);
		if (!q) return stale;
		if (w === "withdraw") {
			// The same rule as a bare `withdraw`: the runner's ceiling question cancels, every other question replans.
			const then = isCeilingQuestion(q, ledger.slice(q.slice_id)) ? "cancel" : "replan";
			return { n, cmd: { kind: "withdraw", workloadId: q.workload_id, questionId: q.id, then } };
		}
		const answer = q.options.find((o) => o.toLowerCase() === w);
		if (answer === undefined) return `#${n} takes: ${[...q.options, "withdraw"].join(" / ")}`;
		return { n, cmd: { kind: "answer", workloadId: q.workload_id, questionId: q.id, answer } };
	});
}

/** One command line of a paste (`interpretPaste`): a numbered batch line (its pieces checked), or one word command; `line` is 1-based in the paste. */
export type PasteCommand = { line: number; text: string } & ({ kind: "batch"; items: BatchItem[] } | { kind: "command"; cmd: Exclude<Command, { kind: "ambiguous" | "refused" }> });
/** A run of plain-words lines of a paste, `from`–`to` (1-based, inclusive), for the orchestrator to record as one instruction row. */
export interface PasteInstruction {
	kind: "instruction";
	from: number;
	to: number;
	text: string;
}
export type PasteItem = PasteCommand | PasteInstruction;
/** A refused paste's verdict per command line: `why` is the batch pieces' refusals, the ambiguous command (the caller words "which one?"), or null for a line that would have applied. */
export interface PasteRefusal {
	line: number;
	text: string;
	why: string[] | Extract<Command, { kind: "ambiguous" }> | null;
}
export type PasteResult = { ok: true; items: PasteItem[] } | { ok: false; refused: PasteRefusal[]; held: PasteInstruction[] };

/**
 * An id-shaped token: a reserved request (`en-…`), a question (`q-…`), a workload (`wl-…`) or a
 * slice (`sl-…`). A bare prefix (`wl-`, a paste cut short) is one too, so it is refused as an id
 * that does not resolve rather than read as a bare word that falls back to the sole workload.
 */
const ID_TOKEN = /^(en|q|wl|sl)-\S*$/i;

/** The words that open a command: the stakes and mode words, the answer words, every option an open question offers, and the long commands. */
function commandWords(ledger: Ledger): string[] {
	const offered = ledger.inFlight().flatMap((w) => w.openQuestions).flatMap((q) => q.options.map((o) => o.toLowerCase()));
	return [...STAKES_WORDS, ...MODE_WORDS, "approve", "deny", "withdraw", "ceiling", "rounds", "stop-reviews", ...offered];
}

/**
 * The id-shaped targets a line of a paste names after a command word (`approve en-nope`, `left
 * q-nope`, `production wl-nope`, `ceiling 120 wl-nope`), or null when the line opens with no
 * command word or names no id, so short prose (`fix it`, `approve please`) stays prose. Such a line
 * is a command attempt: it is refused, never prose, when an id does not resolve (`unresolvedId`) or
 * when `interpret` still refuses it. Only the paste reads this: the same line alone passes through
 * today.
 */
function namedIds(ledger: Ledger, text: string): string[] | null {
	const words = text.split(/\s+/);
	const ids = words.slice(1).filter((w) => ID_TOKEN.test(w));
	return ids.length > 0 && commandWords(ledger).includes(words[0]!.toLowerCase()) ? ids : null;
}

/** The refusal naming the first of `ids` (named after the command word `word`) that does not resolve to an open row in view; null when every one does. */
function unresolvedId(ledger: Ledger, ids: readonly string[], word: string): string | null {
	const view = workloadsInView(ledger);
	const questions = ledger.inFlight().flatMap((w) => w.openQuestions);
	for (const id of ids) {
		const kind = id.slice(0, id.indexOf("-")).toLowerCase();
		if (kind === "wl" && !view.includes(id)) return `${id} is not an open workload`;
		if (kind === "q" && !questions.some((q) => q.id === id)) return `${id} is not an open question`;
		if (kind === "en" && ![...view, STANDING_WORKLOAD_ID].some((wl) => waitingReserved(ledger, wl).some((r) => r.id === id))) {
			const verdict = word.toLowerCase();
			const closed = verdict === "approve" || verdict === "deny" ? closedReservedRefusal(ledger, id, verdict) : null;
			return closed ?? `no entry ${id} on the needs-you list`;
		}
		if (kind === "sl") {
			const slice = ledger.slice(id);
			if (!slice || !view.includes(slice.workload_id)) return `${id} is not a slice of an open workload`;
		}
	}
	return null;
}

/** In a paste a stakes or mode word is a command only bare or with a `wl-…` id: `production ready` is prose; `production wl-nope` is `unresolvedId`'s refusal. */
function looseWorkloadPair(text: string): boolean {
	const words = text.split(/\s+/);
	const word = words[0]!.toLowerCase();
	const workloadWord = (STAKES_WORDS as readonly string[]).includes(word) || (MODE_WORDS as readonly string[]).includes(word);
	return workloadWord && words.length === 2 && !/^wl-/i.test(words[1]!);
}

/** What a command resolves, for the once-per-row check across a paste: the question it answers or withdraws, or the reserved request it decides; else null. */
function resolves(cmd: Command): string | null {
	return cmd.kind === "answer" || cmd.kind === "withdraw" ? cmd.questionId : cmd.kind === "reserved" ? cmd.entryId : null;
}

/**
 * Interpret a paste of several lines (MIGRATION.md item 48). Each non-empty line is one of:
 * - a numbered batch line (`parseBatch`), its pieces checked against the numbering as one batch
 *   with every other batch line's, so a number given twice across lines is refused;
 * - a word command (`interpret`, when the line is `commandShaped`), except that a stakes or mode
 *   word with a second word that is no `wl-…` id is prose (`production ready`);
 * - a command the surface knows naming an id that does not resolve (`namedIds`, `unresolvedId`:
 *   `approve en-nope`, `production wl-nope`): refused, never prose;
 * - plain words otherwise; consecutive plain-words lines form one instruction and a command line
 *   separates two.
 * Null when no line is a command or a refused one: the paste is prose and passes through. Every
 * command line must resolve before any is applied, and a question or reserved request answered
 * twice across lines (`1 left` then `right q-X` when #1 is q-X) is refused on the later line;
 * otherwise `refused` carries one verdict per command line and `held` the instructions, and
 * nothing is to be applied.
 */
export function interpretPaste(ledger: Ledger, numbering: Numbering, text: string): PasteResult | null {
	const raw = text.split("\n");
	type Read = { line: number; text: string } & (
		| { kind: "batch"; pieces: { n: number; word: string }[] }
		| { kind: "command"; cmd: Command }
		| { kind: "invalid"; why: string }
		| { kind: "prose" }
	);
	const read: Read[] = [];
	for (const [i, l] of raw.entries()) {
		const t = l.trim();
		if (t.length === 0) continue;
		const line = i + 1;
		const pieces = parseBatch(t);
		if (pieces) {
			read.push({ line, text: t, kind: "batch", pieces });
			continue;
		}
		if (!commandShaped(t)) {
			read.push({ line, text: t, kind: "prose" });
			continue;
		}
		const ids = namedIds(ledger, t);
		const unresolved = ids === null ? null : unresolvedId(ledger, ids, t.split(/\s+/)[0]!);
		if (unresolved !== null) {
			read.push({ line, text: t, kind: "invalid", why: unresolved });
			continue;
		}
		const cmd = looseWorkloadPair(t) ? null : interpret(ledger, t);
		if (cmd) read.push({ line, text: t, kind: "command", cmd });
		else if (ids === null) read.push({ line, text: t, kind: "prose" });
		else {
			// Every id resolves and the line still is no command: named with what the row takes.
			const q = ledger.inFlight().flatMap((w) => w.openQuestions).find((x) => x.id === ids[0]);
			const takes = q ? ` (${ids[0]} takes: ${[...q.options, "withdraw"].join(" / ")})` : "";
			read.push({ line, text: t, kind: "invalid", why: `"${t}" is not a command the surface knows${takes}` });
		}
	}
	if (!read.some((r) => r.kind !== "prose")) return null;
	// Every batch piece of the paste is one batch: checked together, so a number twice across lines is caught.
	const pieces = read.flatMap((r) => (r.kind === "batch" ? r.pieces : []));
	const checked = checkBatch(ledger, numbering, pieces);
	let next = 0;
	const items: PasteItem[] = [];
	const refused: PasteRefusal[] = [];
	const held: PasteInstruction[] = [];
	/** Each row a command resolves → where the paste first resolves it (`line 1`, `line 1 (#2)`). */
	const first: Record<string, string> = {};
	const twice = (cmd: Command, where: string): string | null => {
		const id = resolves(cmd);
		if (id === null) return null;
		if (first[id] !== undefined) return `${id} is already ${cmd.kind === "reserved" ? "decided" : "answered"} on ${first[id]}; once per row`;
		first[id] = where;
		return null;
	};
	let prose: { from: number; to: number } | null = null;
	const endProse = () => {
		if (prose === null) return;
		const instruction: PasteInstruction = { kind: "instruction", from: prose.from, to: prose.to, text: raw.slice(prose.from - 1, prose.to).join("\n").trim() };
		items.push(instruction);
		held.push(instruction);
		prose = null;
	};
	for (const r of read) {
		if (r.kind === "prose") {
			prose = prose === null ? { from: r.line, to: r.line } : { from: prose.from, to: r.line };
			continue;
		}
		endProse();
		if (r.kind === "batch") {
			const own = checked.slice(next, next + r.pieces.length);
			next += r.pieces.length;
			const bad = own.flatMap((c) => {
				if (typeof c === "string") return [c];
				const dup = twice(c.cmd, `line ${r.line} (#${c.n})`);
				return dup === null ? [] : [`#${c.n}: ${dup}`];
			});
			refused.push({ line: r.line, text: r.text, why: bad.length > 0 ? bad : null });
			items.push({ line: r.line, text: r.text, kind: "batch", items: own.filter((c): c is BatchItem => typeof c !== "string") });
		} else if (r.kind === "invalid") {
			refused.push({ line: r.line, text: r.text, why: [r.why] });
		} else if (r.cmd.kind === "ambiguous") {
			refused.push({ line: r.line, text: r.text, why: r.cmd });
		} else if (r.cmd.kind === "refused") {
			refused.push({ line: r.line, text: r.text, why: [r.cmd.why] });
		} else {
			const dup = twice(r.cmd, `line ${r.line}`);
			refused.push({ line: r.line, text: r.text, why: dup === null ? null : [dup] });
			items.push({ line: r.line, text: r.text, kind: "command", cmd: r.cmd });
		}
	}
	endProse();
	return refused.every((r) => r.why === null) ? { ok: true, items } : { ok: false, refused, held };
}

/** Every workload in view as a "which one?" candidate, oldest first. */
function workloadCandidates(view: readonly string[]): Candidate[] {
	return view.map((id) => ({ kind: "workload", workloadId: id }));
}

/**
 * `ceiling <usd> [<hours>] [wl-…]` after the word: dollars (a leading `$` allowed), then hours (a
 * trailing `h` allowed) and the workload in either order; the workload defaults to the only one in
 * view. With several in view and none named it is `ambiguous`, its word the command as typed
 * (`ceiling $120 8h`) and the workloads as candidates.
 */
function ceilingCommand(rest: readonly string[], view: readonly string[]): Command | null {
	if (rest.length < 1 || rest.length > 3) return null;
	const usd = /^\$?(\d+(?:\.\d+)?)$/.exec(rest[0]!);
	if (!usd || Number(usd[1]) <= 0) return null;
	let wallMin: number | null = null;
	let named: string | null = null;
	for (const w of rest.slice(1)) {
		const h = /^(\d+(?:\.\d+)?)h?$/i.exec(w);
		if (h && wallMin === null) wallMin = Math.round(Number(h[1]) * 60);
		else if (w.startsWith("wl-") && named === null) named = w;
		else return null;
	}
	if (wallMin === 0) return null;
	if (named === null && view.length > 1) return { kind: "ambiguous", word: ["ceiling", ...rest].join(" "), candidates: workloadCandidates(view) };
	const wl = named !== null ? (view.includes(named) ? named : null) : view.length === 1 ? view[0]! : null;
	return wl ? { kind: "ceiling", workloadId: wl, usd: Number(usd[1]), wallMin } : null;
}

/**
 * `rounds <n> [wl-…]` after the word: a whole number of rounds of at least one, then optionally the
 * workload; it defaults to the only one in view. With several in view and none named it is
 * `ambiguous`, its word the command as typed (`rounds 5`) and the workloads as candidates.
 */
function roundsCommand(rest: readonly string[], view: readonly string[]): Command | null {
	if (rest.length < 1 || rest.length > 2) return null;
	if (!/^\d+$/.test(rest[0]!) || Number(rest[0]) < 1) return null;
	const rounds = Number(rest[0]);
	const named = rest[1] ?? null;
	if (named !== null && !named.startsWith("wl-")) return null;
	if (named === null && view.length > 1) return { kind: "ambiguous", word: `rounds ${rounds}`, candidates: workloadCandidates(view) };
	const wl = named !== null ? (view.includes(named) ? named : null) : view.length === 1 ? view[0]! : null;
	return wl ? { kind: "rounds", workloadId: wl, rounds } : null;
}

/**
 * `stop-reviews [wl-… | sl-…]` (D10): bare, the only workload in view (several → `ambiguous`, the
 * workloads as candidates); `wl-…`, that workload in view; `sl-…`, that slice's loop when its
 * workload is in view. Anything else is not the command.
 */
function stopReviewsCommand(ledger: Ledger, arg: string | undefined, view: readonly string[]): Command | null {
	if (arg === undefined) {
		if (view.length > 1) return { kind: "ambiguous", word: "stop-reviews", candidates: workloadCandidates(view) };
		return view.length === 1 ? { kind: "stop-reviews", workloadId: view[0]!, target: view[0]! } : null;
	}
	if (arg.startsWith("wl-")) return view.includes(arg) ? { kind: "stop-reviews", workloadId: arg, target: arg } : null;
	const slice = arg.startsWith("sl-") ? ledger.slice(arg) : null;
	return slice && view.includes(slice.workload_id) ? { kind: "stop-reviews", workloadId: slice.workload_id, target: slice.id } : null;
}

/**
 * Is `q` the runner's ceiling question (DESIGN-workload-ceiling.md § 2 item 4): raised by the lane
 * runner on a slice of its own, `sl-ceiling-<n>`. The runner (surface/scripts/lane.ts) uses the same test.
 */
export function isCeilingQuestion(q: Pick<QuestionRow, "slice_id" | "created_by">, slice: Pick<SliceRow, "id"> | null): boolean {
	return slice !== null && slice.id === q.slice_id && slice.id.startsWith("sl-ceiling-") && q.created_by === LANE_RUNNER_BY;
}

/**
 * Is `q` the classifier's round-limit question (D9): a `review-limit: <q> slice <its slice>` entry
 * on its workload, written by whoever raised it (the classifier writes both in one transaction).
 * Read from the entry, never from the slice id.
 */
export function isReviewLimitQuestion(ledger: Ledger, q: Pick<QuestionRow, "id" | "workload_id" | "slice_id" | "created_by">): boolean {
	return ledger.entries(q.workload_id, "assumption").some((e) => {
		const l = parseReviewLimit(e.body);
		return l !== null && l.questionId === q.id && l.slice === q.slice_id && e.created_by === q.created_by;
	});
}

/**
 * Settle the round-limit question after Jo's answer `answerId` (D9), inside the answer's
 * transaction; the answer itself reopens the slice. *extend* writes one more block of the stakes
 * default for the slice, naming the answer; *accept* ends the loop as passed with its findings left
 * (the lane closes the slice); *stop* ends it unpassed (the lane holds the slice for Jo). Returns the
 * receipt tail.
 */
function settleReviewLimit(ledger: Ledger, q: QuestionRow, word: RoundLimitOption, answerId: string): string {
	const wl = q.workload_id;
	const sl = q.slice_id;
	const entry = (body: string) => ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, sliceId: sl, kind: "assumption", body });
	if (word === "extend") {
		const w = ledger.workload(wl)!;
		const block = REVIEW_ROUND_DEFAULTS[w.stakes];
		entry(reviewRoundsExtendBody(sl, block, answerId));
		const limit = effectiveRoundLimit(ledger.entries(wl), ledger.instructions(wl), w.stakes, sl);
		return `; ${block} more review rounds for ${sl} (its limit is now ${limit.total} failed rounds); the lane may dispatch the next review`;
	}
	if (word === "accept") {
		entry(reviewLoopEndBody(sl, "accept"));
		return `; the review of ${sl} counts as passed with its findings left; the lane may close it`;
	}
	entry(reviewLoopEndBody(sl, "stop"));
	return `; no further review round on ${sl}; the review does not count as passed and the lane holds it for you`;
}

/**
 * `stop-reviews` applied (D10), inside one transaction: the instruction, then `review-stop:` naming
 * it. The stopped loops are the slice named, or every slice of the workload with a round in its
 * current loop or an open round-limit or park question. On each, every open round-limit or park
 * question is withdrawn with `then cancel`; a loop with no round running ends here
 * (`review-loop-end: … reason stop-reviews`), while a running round's settle ends it in the
 * classifier. Returns the receipt: per loop, the latest settled round's remaining findings, or the
 * round still running.
 */
function stopReviews(ledger: Ledger, cmd: Extract<Command, { kind: "stop-reviews" }>): string {
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	const wl = cmd.workloadId;
	const one = cmd.target === wl ? null : cmd.target;
	const id = ledger.recordInstruction({ ...stamp, workloadId: wl, sliceId: one, body: stopReviewsInstructionBody(cmd.target) });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, sliceId: one, kind: "assumption", body: reviewStopBody(cmd.target, id) });
	const entries = ledger.entries(wl);
	const open = ledger.questions(wl).filter((q) => q.state === "open");
	const reviewQuestions = (sl: string) => {
		const parks = parkQuestions(entries, sl);
		return open.filter((q) => q.slice_id === sl && (parks.has(q.id) || isReviewLimitQuestion(ledger, q)));
	};
	const loops = one !== null ? [one] : ledger.slices(wl).map((s) => s.id).filter((sl) => countRounds(entries, sl).rounds.length > 0 || reviewQuestions(sl).length > 0);
	const lines = loops.map((sl) => {
		const rounds = countRounds(entries, sl).rounds;
		const running = rounds.find((r) => !r.complete);
		const withdrawn = reviewQuestions(sl).map((q) => {
			const w = ledger.withdrawQuestion(q.id, { ...stamp, reason: `stop-reviews (instruction ${id})`, then: "cancel" });
			return `withdrew ${q.id} (withdrawal ${w}, then cancel)`;
		});
		let line: string;
		if (running) line = `${sl}: round ${running.n} still running; its findings come to you when it settles`;
		else {
			ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLoopEndBody(sl, "stop-reviews") });
			const settled = rounds.findLast((r) => r.complete);
			line = settled ? `${sl}: round ${settled.n} left ${roundFindingsText(settled)}` : `${sl}: no review round settled in this loop`;
		}
		return [line, ...withdrawn].join("; ");
	});
	const what = one !== null ? `the review loop on ${one}` : `every review loop on ${wl}`;
	return `stopped ${what} (instruction ${id}); ${lines.length > 0 ? lines.join(" | ") : "no review loop is open"}`;
}

/** A settled round's remaining findings: its members' blocks merged into one severity line, plus the hands whose block was unreadable. */
function roundFindingsText(r: Round): string {
	const merged: Findings = { counts: { blocking: {}, major: {}, minor: {} }, titles: [] };
	let unknown = 0;
	for (const m of r.members) {
		if (m.findings === UNKNOWN) {
			unknown++;
			continue;
		}
		for (const s of SEVERITIES) {
			for (const [k, n] of Object.entries(m.findings.counts[s])) merged.counts[s][k as FindingKind] = (merged.counts[s][k as FindingKind] ?? 0) + (n ?? 0);
		}
	}
	const text = unknown === r.members.length ? UNKNOWN : severityLine(merged);
	return unknown > 0 && unknown < r.members.length ? `${text} · unknown: ${unknown} hand${unknown === 1 ? "" : "s"} with no readable findings block` : text;
}

/**
 * The open-time classifier's verdict on the brief, read back from the `brief-judged:` entry the open
 * tool wrote, with the open tool's rule: change-large above the low-confidence threshold, else null.
 */
export function judgedKindOf(ledger: Ledger, workloadId: string): RoutingKind | null {
	const e = ledger.entries(workloadId, "assumption").find((x) => x.created_by === SURFACE_BY && x.body.startsWith("brief-judged: "));
	const m = e ? /^brief-judged: (\S+) confidence (\S+)/.exec(e.body) : null;
	return m && m[1] === "change-large" && Number(m[2]) > LOW_CONFIDENCE_THRESHOLD ? "change-large" : null;
}

/** The `source` of a stakes-sized `ceiling:` entry: `stakes <s>`, or `stakes <s> x3 change-large`. */
export function stakesSource(stakes: Stakes, judged: RoutingKind | null): string {
	return `stakes ${stakes}${judged === "change-large" ? " x3 change-large" : ""}`;
}

/** The workload's effective ceiling now (`effectiveCeiling` over its surface-written entries and its instructions). */
export function ceilingOf(ledger: Ledger, workloadId: string): Ceiling {
	const w = ledger.workload(workloadId);
	if (!w) throw new Error(`no workload ${workloadId}`);
	return effectiveCeiling(controlEntries(ledger.entries(workloadId, "assumption")), ledger.instructions(workloadId), w.stakes);
}

/** `$50 / 6h`: hours to two places at most. */
export function ceilingText(c: Ceiling): string {
	return `$${Number(c.usd.toFixed(2))} / ${Number((c.wallMin / 60).toFixed(2))}h`;
}

/**
 * Settle the ceiling question after Jo's answer `answerId` (§ 2 item 5), inside the answer's
 * transaction. *extend* writes the ceiling plus one block of the workload's own size, naming the
 * answer; every answer completes the ceiling slice; *extend* then writes Jo's `launch-requested:`
 * (the body the launch tool writes), so a lane the runner stopped at the ceiling relaunches: when no
 * lane holds the workload under a live lease, or when the holder's newest valid `lane-stop:` is
 * `accepted ceiling` (it is stopping at the ceiling and will not read the raise). A live holder that
 * is still running reads the raised ceiling at its next poll and goes on: a request written then would
 * outlive it and relaunch a finished workload. Returns the receipt tail, naming which case it was.
 */
function settleCeiling(ledger: Ledger, q: QuestionRow, word: string, answerId: string): string {
	const wl = q.workload_id;
	if (word !== "extend") {
		ledger.completeSlice(q.slice_id, { by: SURFACE_BY, artifact: `answered ${word} ${answerId}` });
		return "";
	}
	const w = ledger.workload(wl)!;
	const block = sizeFor(w.stakes, judgedKindOf(ledger, wl));
	const cur = ceilingOf(ledger, wl);
	const next = { usd: cur.usd + block.usd, wallMin: cur.wallMin + block.wallMin };
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody(next, "extend one block", answerId) });
	ledger.completeSlice(q.slice_id, { by: SURFACE_BY, artifact: `answered extend ${answerId}` });
	const raised = `; ceiling raised to ${ceilingText(next)}`;
	let why = "no lane holds it live";
	if (w.holder?.startsWith("lane-") && heldLive(w, ledger.now())) {
		const entries = ledger.entries(wl);
		const stops = controlEntries(entries, holdersOf(entries, w.holder)).filter((c) => c.prefix === "lane-stop" && c.laneId === w.holder);
		if (!/^accepted ceiling\b/.test(stops.at(-1)?.rest ?? "")) return `${raised}; ${w.holder} still holds it and goes on under it`;
		why = `${w.holder} is stopping at the ceiling`;
	}
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), "ceiling extend") });
	return `${raised}; ${why}, so a relaunch is requested`;
}

/** Is `q` the plan question (decision 15, PLAN wl-muq22rnjcfrrpc D9 part two): `isPlanQuestionIn` on its workload's control entries. */
export function isPlanQuestion(ledger: Ledger, q: { id: string; workload_id: string }): boolean {
	const w = ledger.workload(q.workload_id);
	if (!w) return false;
	const entries = ledger.entries(q.workload_id);
	return isPlanQuestionIn(controlEntries(entries, holdersOf(entries, w.holder, ledger.holders(q.workload_id))), q);
}

/** The orchestrator's own question (MIGRATION.md item 105) `cmd` answers or withdraws, else null. */
export const standingQuestionOf = (cmd: Command): string | null =>
	(cmd.kind === "answer" || cmd.kind === "withdraw") && cmd.workloadId === STANDING_WORKLOAD_ID ? cmd.questionId : null;

/** The refusal for an orchestrator question resolved by a prompt Jo did not type (PR #55 round 2, B1). */
export const untypedStandingRefusal = (questionId: string): string =>
	`${questionId} is the orchestrator's own question, and only words Jo typed at the surface answer or withdraw it; this prompt carried no matching typed input, so nothing was applied`;

/**
 * Apply a command through the ledger module as Jo via the surface. Returns the one-line receipt.
 * `typed`: the prompt carrying `cmd` is what Jo typed this turn (OMP's `input`, source interactive
 * or rpc, matching the prompt, read once; surface/extensions/surface-input.ts). An answer or a
 * withdrawal of the orchestrator's own question throws without it (Codex review of PR #55 round 2,
 * B1): an extension-sent prompt, a session_stop continuation or an `omp -p` prompt resolves none.
 */
export function apply(ledger: Ledger, cmd: Command, typed = false): string {
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	const own = standingQuestionOf(cmd);
	if (own !== null && !typed) throw new Error(untypedStandingRefusal(own));
	switch (cmd.kind) {
		case "stakes": {
			// The instruction goes first, so the re-sized `ceiling:` entry can name it when it raises (§ 2 item 2).
			return ledger.write(() => {
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: `stakes: ${cmd.stakes}` });
				ledger.setStakes(cmd.workloadId, { by: SURFACE_BY, stakes: cmd.stakes });
				const judged = judgedKindOf(ledger, cmd.workloadId);
				const size = sizeFor(cmd.stakes, judged);
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: ceilingBody(size, stakesSource(cmd.stakes, judged), id) });
				return `stakes on ${cmd.workloadId} → ${cmd.stakes} (instruction ${id}); ceiling ${ceilingText(size)}`;
			});
		}
		case "mode": {
			const id = ledger.flipMode(cmd.workloadId, { ...stamp, mode: cmd.mode });
			return `mode on ${cmd.workloadId} → ${cmd.mode} (mode-flip ${id}; effective before the lane's next turn)`;
		}
		case "answer": {
			// Decision 15: on the plan slice's question, *approve* also writes `plan: approved <instruction>` (surface-stamped, same
			// transaction) and *cancel* is a withdrawal that cancels the slice; *revise* is an ordinary answer that reopens it.
			const q0 = ledger.question(cmd.questionId)!;
			if (q0.workload_id === STANDING_WORKLOAD_ID) {
				// The orchestrator's own ask (MIGRATION.md item 105): the row resolved, and the decision mirrored on the subject workload;
				// a subject that cannot take the mirror throws, the answer is not written and the question stays open (review B4).
				const r = answerOrchestratorQuestion(ledger, q0, { answer: cmd.answer, mirrorBody: `Jo: "${cmd.answer}" — answers ${q0.id}: ${q0.body}` });
				const mirror = r.mirrorId ? `; recorded on ${r.about} as instruction ${r.mirrorId}` : "";
				return `answered the orchestrator's ${cmd.questionId} with "${cmd.answer}" (answer ${r.answerId})${mirror}`;
			}
			const plan = isPlanQuestion(ledger, q0);
			const word = cmd.answer.toLowerCase();
			const ceiling = isCeilingQuestion(q0, ledger.slice(q0.slice_id)) && (CEILING_OPTIONS as readonly string[]).includes(word);
			const roundLimit = !ceiling && (ROUND_LIMIT_OPTIONS as readonly string[]).includes(word) && isReviewLimitQuestion(ledger, q0);
			if (plan && word === "cancel") {
				const id = ledger.withdrawQuestion(cmd.questionId, { ...stamp, reason: "plan cancelled from the surface", then: "cancel" });
				return `cancelled the plan: withdrew ${cmd.questionId} (withdrawal ${id}); slice ${q0.slice_id} is ${ledger.slice(q0.slice_id)?.state ?? "unknown"}`;
			}
			let tail = "";
			const id = ledger.write(() => {
				const answerId = ledger.answerQuestion(cmd.questionId, { ...stamp, answer: cmd.answer });
				if (plan && word === "approve") ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: planApprovedBody(answerId) });
				if (ceiling) tail = settleCeiling(ledger, q0, word, answerId);
				if (roundLimit) tail = settleReviewLimit(ledger, q0, word as RoundLimitOption, answerId);
				return answerId;
			});
			const slice = ledger.slice(q0.slice_id);
			const approved = plan && word === "approve" ? "; plan approved: change slices may now be added" : "";
			return `answered ${cmd.questionId} with "${cmd.answer}" (answer ${id}); slice ${q0.slice_id} is ${slice?.state ?? "unknown"}${approved}${tail}`;
		}
		case "withdraw": {
			// The standing slice is never cancelled (item 105): a withdrawal of the orchestrator's own ask always replans, whatever the command carries.
			const standing = cmd.workloadId === STANDING_WORKLOAD_ID;
			const then = standing ? "replan" : cmd.then;
			const id = ledger.withdrawQuestion(cmd.questionId, { ...stamp, reason: "withdrawn from the surface", then });
			const q = ledger.question(cmd.questionId)!;
			const slice = ledger.slice(q.slice_id);
			if (standing) return `withdrew the orchestrator's ${cmd.questionId} (withdrawal ${id}, then replan); the standing slice stays ${slice?.state ?? "unknown"}`;
			const what = then === "replan" ? "replanned, not executed"
				: isCeilingQuestion(q, slice) ? "cancelled; the lane stops at the ceiling as the default" : "cancelled";
			return `withdrew ${cmd.questionId} (withdrawal ${id}, then ${then}); slice ${q.slice_id} is ${slice?.state ?? "unknown"}: ${what}`;
		}
		case "reserved": {
			const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: `${cmd.verdict} ${cmd.entryId}` });
			return `${cmd.verdict === "approve" ? "approved" : "denied"} reserved request ${cmd.entryId} (instruction ${id})`;
		}
		case "ceiling": {
			// Jo's exact figure (§ 1 D): the instruction, then the entry naming it; omitted hours keep the wall in force.
			return ledger.write(() => {
				const next = { usd: cmd.usd, wallMin: cmd.wallMin ?? ceilingOf(ledger, cmd.workloadId).wallMin };
				const hours = Number((next.wallMin / 60).toFixed(2));
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: `ceiling: ${next.usd} ${hours}` });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: ceilingBody(next, "your word", id) });
				return `ceiling on ${cmd.workloadId} → ${ceilingText(next)} (instruction ${id})`;
			});
		}
		case "rounds": {
			// D9, shaped like the ceiling word: the instruction, then the `review-rounds:` entry naming it.
			return ledger.write(() => {
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: roundsInstructionBody(cmd.rounds) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: reviewRoundsBody(cmd.rounds, "your word", id) });
				return `review round limit on ${cmd.workloadId} → ${cmd.rounds} failed round${cmd.rounds === 1 ? "" : "s"} per review loop (instruction ${id})`;
			});
		}
		case "stop-reviews":
			return ledger.write(() => stopReviews(ledger, cmd));
		case "ambiguous":
			throw new Error(`"${cmd.word}" fits ${cmd.candidates.length} rows; an ambiguous word is refused, never applied`);
		case "refused":
			throw new Error(`${cmd.why}; refused, never applied`);
	}
}
