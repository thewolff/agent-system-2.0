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
// Answer lines (PLAN wl-mv5msri070p0qo D2): a line that is exactly `<word> <id>` followed by
// whitespace, `#` and any text (a line of the `pending` block) is read as `<word> <id>`
// (`stripTail`), alone and in a paste; nothing else loses a `#` (`fix # 3 now` stays prose). A
// stakes or mode word naming a question or reserved request (`autonomous q-…`) is an answer to it,
// never a flip: the flip takes no id or a `wl-…` id.
//
// A paste of several lines (MIGRATION.md item 48): each non-empty line is read on its own with the
// rules above (a numbered batch line keeps its comma form; `ceiling` and `rounds` keep their long
// forms; a stakes or mode word takes only a `wl-…` id, or a `q-…`/`en-…` id it answers), checked whole and applied
// all-or-nothing in order, so `production wl-x` then `ceiling 120 wl-x` both land. A command naming
// an id that does not resolve (`approve en-nope`) refuses the paste, and so does a question or
// reserved request answered twice across lines. Consecutive lines that are no command form one
// plain-words instruction for the orchestrator, which records it as one row
// (`orchestrator_record_instruction`) after the commands land; a command line between two such
// runs separates two instructions. A paste with no command line at all is prose and passes through
// untouched, as a single prose line does. The wrapper of a `pending` block pasted back (its
// heading, the fence around its answer lines, the generated sentences under it,
// `pendingWrapperLines`) is dropped, so the block pasted whole forwards no instruction of its own;
// any other line Jo pasted, a fence of Jo's own included, is kept.
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
//
// Settling a stuck row by Jo's word (PLAN wl-mv5i3lulwwbbi8 D1, D2): `cancel-slice <sl-…>` cancels an
// open or paused slice of an open workload, refused while a test run on the slice is live (`runLive`'s
// rule over the runner's heartbeat file): the instruction, the slice's open questions withdrawn
// (then cancel) naming it, the slice cancelled, and Jo's `launch-requested:` when a withdrawn
// question was a launched lane's and no lane holds the workload live, so a lane parked on it goes on.
// `supersede <wl-A> <wl-B>` writes the instruction on A and the surface's `superseded:` entry naming
// it, which the close reads (`supersededBy`). Both are one token, never an option word (`cancel` is
// the plan question's), and refuse with the reason rather than pass as prose. An `approve` answering
// a question that is not the plan question while `plan: first` stands says so in its receipt (D4).
//
// The pair trigger (PLAN wl-mv67564rdkfvnk D7, surface/src/pair-suggest.ts): `pair` answers a round-limit or ceiling
// question only when that question's raiser offered it (a `pair-offer:` with the site's stamp names it). It settles the
// question as `stop` does, flips the workload to user-driven as Jo, writes `pair-taken:`, and asks a live lane holder to
// stop, all in one transaction (`applyPair`); on any other question `pair` is refused naming it.
//
// Jo's batch run (plan wl-mv615mkeaf1yio § 4): `test-batch <wl-…> <N> <N> …` names the workload and 2 to 8
// PRs (spaces or commas between them), Jo's order kept; a PR named twice, a word that is no PR number, or
// a workload not open in view is refused with the reason, never prose. The surface applies it, not `apply`
// (which throws, so a request is never written without its start): surface/extensions/surface-input.ts writes
// Jo's instruction `test-batch <wl> <N…>` and the surface's `test-batch: <N…> <instruction id>` in one
// transaction (`requestTestBatch`), then execs the starter. It runs only on its own line: never in a
// numbered batch, and a paste naming it is refused.
// Binding PRs for a test run with no push (PLAN wl-mv5qdfvv82ivwg § 2.1; migration/items/test-pr-binds-named-prs.md):
// `test-pr <wl-…> <N> [<N> …]` (numbers separated by spaces and/or commas, deduplicated, Jo's order
// kept, at most 50) writes Jo's instruction `test-pr <wl> <N…>` on the workload, then the surface's
// `test-pr: <N…> <instruction id>` naming it, in one transaction; the test runner admits those PRs
// (`boundPrs`, surface/src/launch.ts). The workload is always named, never inferred. The word is the
// command or `refused` with the reason (not an open workload, the standing one, no number, a bad
// number), never prose and never a numbered-batch piece, at any length.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import {
	attempts, type ControlEntry, controlEntries, heldLive, holdersOf, isPlanQuestionIn, laneStopRequestBody, launchRequestedBody, planApprovedBody, planFirst,
	supersededBody, supersedeInstructionBody, testPrBody, testPrInstructionBody,
} from "./launch";
import type { Numbering, Target } from "./numbering";
import { answerOrchestratorQuestion } from "./orchestrator-question";
import { PAIR_OPTION, type PairSite, pairOfferStamp, pairTakenBody, parsePairOffer } from "./pair-suggest";
import { batchPrs, prList, testBatchBody, testBatchInstructionBody } from "./test-batch";
import { parseHeartbeat, recordLive, runDirOf, runsRoot, testRuns } from "./test-run";
import { pendingWrapperLines } from "./pending";
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
	/** `cancel-slice <sl-…>`: cancel one open or paused slice (D1). */
	| { kind: "cancel-slice"; workloadId: string; sliceId: string }
	/** `supersede <wl-A> <wl-B>`: `workloadId` (A) is superseded by `by` (B) (D2). */
	| { kind: "supersede"; workloadId: string; by: string }
	/** `test-batch <wl-…> <N> <N> …`: Jo's batch run of 2 to 8 PRs, in Jo's order (plan wl-mv615mkeaf1yio § 4). */
	| { kind: "test-batch"; workloadId: string; prs: number[] }
	/** `test-pr <wl-…> <N…>`: Jo binds these PR numbers to the workload for a test run with no push. */
	| { kind: "test-pr"; workloadId: string; prs: number[] }
	/** A bare word that fits more than one row or workload: refused, never applied. */
	| { kind: "ambiguous"; word: string; candidates: Candidate[] }
	/** A command naming a row it cannot take (`deny en-…` for a request no longer waiting): refused with `why`, never applied and never prose. */
	| { kind: "refused"; why: string };

/** Workloads Jo's words apply to: the open workloads other than the standing one, oldest first. */
export function workloadsInView(ledger: Ledger): string[] {
	return ledger.inFlight().map((w) => w.workload.id).filter((id) => id !== STANDING_WORKLOAD_ID);
}

/** A run's heartbeat time in ms (the runner's `<run dir>/heartbeat` file), or null when it has none. */
export type HeartbeatOf = (runId: string) => number | null;

/** The heartbeat reader over the runs root `env` resolves (`runsRoot`): the file the runner writes, as the lane extension reads it. */
export function runHeartbeat(env: Record<string, string | undefined>): HeartbeatOf {
	return (runId) => {
		try {
			return parseHeartbeat(readFileSync(join(runDirOf(runsRoot(env), runId), "heartbeat"), "utf8"), runId);
		} catch {
			return null;
		}
	};
}

/**
 * Interpret `text`. A stakes/mode word alone targets the only workload in view (or the one given
 * as a second word: `production wl-…`); with several in view it is `ambiguous`, the workloads as
 * candidates; `stop-reviews` and `rounds <n>` read their workload the same way, and `stop-reviews
 * sl-…` names one slice's loop. An answer word (`approve`/`deny`, `withdraw`, an option) alone
 * applies only when it fits exactly one row; fitting several it is `ambiguous`, and the second word
 * (an entry or question id) picks the row. `cancel-slice` and `supersede` always name their rows
 * and are the command or `refused`, never prose; `heartbeatOf` reads a test run's heartbeat for
 * `cancel-slice`'s live-run refusal (the surface passes its own env's).
 */
export function interpret(ledger: Ledger, text: string, heartbeatOf: HeartbeatOf = runHeartbeat(process.env)): Command | null {
	const words = stripTail(text).trim().split(/\s+/);
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
	// One token each (D1, D2), so neither is ever read as an option word: `cancel` stays the plan question's.
	if (word === "cancel-slice") return cancelSliceCommand(ledger, words.slice(1), heartbeatOf);
	if (word === "supersede") return supersedeCommand(ledger, words.slice(1));
	// Any length, and always the command or a refusal: a mistyped batch is never prose for the orchestrator.
	if (word === "test-batch") return testBatchCommand(words.slice(1), view);
	// Always the command or `refused`, at any length, so a long binding never passes as prose.
	if (word === "test-pr") return testPrCommand(ledger, words.slice(1));
	if (words.length === 0 || words.length > 2) return null;
	const arg = words[1];
	const target = (): string | null => (arg && view.includes(arg) ? arg : view.length === 1 ? view[0]! : null);
	// A stakes or mode word naming a question or reserved request (`autonomous q-…`) answers it: it skips the flip for the answer path below (D2).
	const workloadWord =
		!(arg !== undefined && ANSWER_ID.test(arg)) &&
		((STAKES_WORDS as readonly string[]).includes(word) || (MODE_WORDS as readonly string[]).includes(word) || word === "user driven");
	if (workloadWord && !arg && view.length > 1) return { kind: "ambiguous", word, candidates: workloadCandidates(view) };

	if (workloadWord && (STAKES_WORDS as readonly string[]).includes(word)) {
		const wl = target();
		return wl ? { kind: "stakes", workloadId: wl, stakes: word as Stakes } : null;
	}
	if (workloadWord) {
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

/**
 * The words a single-line command may run to: `ceiling <usd> [<hours>] [wl-…]` is four, `rounds <n> [wl-…]` and
 * `supersede <wl-A> <wl-B>` three, `test-pr <wl-…> <N> [<N> …]` any number (`interpret` refuses past `TEST_PR_MAX`),
 * `test-batch` any number, everything else two.
 */
export function maxWords(text: string): number {
	const long = /^(ceiling|rounds|supersede|test-pr|test-batch)(?:\s|$)/i.exec(text)?.[1]!.toLowerCase() ?? null;
	return long === "ceiling" ? 4 : long === "rounds" || long === "supersede" ? 3 : long === "test-pr" || long === "test-batch" ? Number.POSITIVE_INFINITY : 2;
}

/** Could `text` (one line, trimmed) be a command: a numbered batch, or short enough for a word command. A false means prose, with no ledger read. */
export function commandShaped(text: string): boolean {
	const t = stripTail(text);
	return t.length > 0 && (parseBatch(t) !== null || t.split(/\s+/).length <= maxWords(t));
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
/** A second word that names a question or a reserved request: after a stakes or mode word it is an answer, never a flip (D2). */
const ANSWER_ID = /^(q|en)-/i;
/** `<word> <second>`, whitespace, then `#` followed by whitespace or the line's end and any text: the shape of a `pending` answer line with its tail. A `#` glued to a word (`#79`) is no tail. */
const TAILED = /^(\S+)\s+(\S+)\s+#(?:\s.*)?$/;

/**
 * A line that is exactly `<word> <id>` (an `ID_TOKEN`) followed by whitespace, `#`, then whitespace and any text,
 * as `<word> <id>`; any other line unchanged (`fix # 3 now` stays prose, `test-pr wl-… #79` keeps its `#79`). The `pending` block's
 * answer lines carry such a tail (PLAN wl-mv5msri070p0qo D2). `interpret` and `commandShaped` read
 * through it, and `interpretPaste` applies it to each line.
 */
export function stripTail(line: string): string {
	const m = TAILED.exec(line.trim());
	return m && ID_TOKEN.test(m[2]!) ? `${m[1]} ${m[2]}` : line;
}

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

/** In a paste a stakes or mode word is a command only bare, with a `wl-…` id, or with a `q-…`/`en-…` id it answers (D2): `production ready` is prose; `production wl-nope` is `unresolvedId`'s refusal. */
function looseWorkloadPair(text: string): boolean {
	const words = text.split(/\s+/);
	const word = words[0]!.toLowerCase();
	const workloadWord = (STAKES_WORDS as readonly string[]).includes(word) || (MODE_WORDS as readonly string[]).includes(word);
	return workloadWord && words.length === 2 && !/^wl-/i.test(words[1]!) && !ANSWER_ID.test(words[1]!);
}

/** What a command resolves, for the once-per-row check across a paste: the question it answers or withdraws, the reserved request it decides, the slice it cancels or the workload it supersedes; else null. */
function resolves(cmd: Command): string | null {
	switch (cmd.kind) {
		case "answer":
		case "withdraw":
			return cmd.questionId;
		case "reserved":
			return cmd.entryId;
		case "cancel-slice":
			return cmd.sliceId;
		case "supersede":
			return cmd.workloadId;
		default:
			return null;
	}
}

/**
 * Interpret a paste of several lines (MIGRATION.md item 48). Each non-empty line is one of:
 * - a numbered batch line (`parseBatch`), its pieces checked against the numbering as one batch
 *   with every other batch line's, so a number given twice across lines is refused;
 * - a word command (`interpret`, when the line is `commandShaped`), except that a stakes or mode
 *   word with a second word that is no `wl-…`, `q-…` or `en-…` id is prose (`production ready`);
 *   a line `<word> <id>  # …` is read as `<word> <id>` (`stripTail`), the tail dropped;
 * - a command the surface knows naming an id that does not resolve (`namedIds`, `unresolvedId`:
 *   `approve en-nope`, `production wl-nope`): refused, never prose;
 * - plain words otherwise; consecutive plain-words lines form one instruction and a command line
 *   separates two;
 * - a line of a `pending` block pasted back that is its generated wrapper (`pendingWrapperLines`:
 *   its heading, the fence around its answer lines, the generated sentences under it): dropped,
 *   neither a command nor part of an instruction; a fence or heading-like line of Jo's own is kept.
 * Null when no line is a command or a refused one: the paste is prose and passes through. Every
 * command line must resolve before any is applied, and a question or reserved request answered
 * twice across lines (`1 left` then `right q-X` when #1 is q-X) is refused on the later line;
 * otherwise `refused` carries one verdict per command line and `held` the instructions, and
 * nothing is to be applied.
 */
export function interpretPaste(ledger: Ledger, numbering: Numbering, text: string, heartbeatOf: HeartbeatOf = runHeartbeat(process.env)): PasteResult | null {
	const raw = text.split("\n");
	const generated = pendingWrapperLines(raw);
	type Read = { line: number; text: string } & (
		| { kind: "batch"; pieces: { n: number; word: string }[] }
		| { kind: "command"; cmd: Command }
		| { kind: "invalid"; why: string }
		| { kind: "prose" }
	);
	const read: Read[] = [];
	for (const [i, l] of raw.entries()) {
		const t = stripTail(l.trim());
		if (t.length === 0 || generated.has(i)) continue;
		const line = i + 1;
		const pieces = parseBatch(t);
		if (pieces) {
			read.push({ line, text: t, kind: "batch", pieces });
			continue;
		}
		if (/^test-batch(?:\s|$)/i.test(t)) {
			read.push({ line, text: t, kind: "invalid", why: "test-batch runs on its own line, not in a paste" });
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
		const cmd = looseWorkloadPair(t) ? null : interpret(ledger, t, heartbeatOf);
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
		if (first[id] !== undefined) {
			const done = cmd.kind === "reserved" ? "decided" : cmd.kind === "cancel-slice" ? "cancelled" : cmd.kind === "supersede" ? "superseded" : "answered";
			return `${id} is already ${done} on ${first[id]}; once per row`;
		}
		first[id] = where;
		return null;
	};
	let prose: { from: number; to: number } | null = null;
	const endProse = () => {
		if (prose === null) return;
		const lines = raw.slice(prose.from - 1, prose.to).filter((_, k) => !generated.has(prose!.from - 1 + k));
		const instruction: PasteInstruction = { kind: "instruction", from: prose.from, to: prose.to, text: lines.join("\n").trim() };
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
 * `test-batch <wl-…> <N> <N> …` after the word (plan wl-mv615mkeaf1yio § 4): the workload first, open
 * and in view, then the PRs (`batchPrs`). Anything else is refused with the reason.
 */
function testBatchCommand(rest: readonly string[], view: readonly string[]): Command {
	const wl = (rest[0] ?? "").replace(/,$/, "");
	if (!/^wl-\S+$/.test(wl)) return { kind: "refused", why: "test-batch names the workload first: test-batch <wl-…> <N> <N> …" };
	if (!view.includes(wl)) return { kind: "refused", why: `${wl} is not an open workload` };
	const prs = batchPrs(rest.slice(1));
	return prs.ok ? { kind: "test-batch", workloadId: wl, prs: prs.prs } : { kind: "refused", why: prs.why };
}

/**
 * Jo's batch word applied (plan wl-mv615mkeaf1yio § 4): Jo's instruction, then the surface's
 * `test-batch:` entry naming it, in one transaction. The starter accepts the batch only with both;
 * the caller execs it with the instruction id.
 */
export function requestTestBatch(ledger: Ledger, cmd: Extract<Command, { kind: "test-batch" }>): { instructionId: string; line: string } {
	return ledger.write(() => {
		const id = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: cmd.workloadId, body: testBatchInstructionBody(cmd.workloadId, cmd.prs) });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: testBatchBody(cmd.prs, id) });
		return { instructionId: id, line: `batch of PRs ${prList(cmd.prs)} on ${cmd.workloadId} requested (instruction ${id})` };
	});
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

/** The most PR numbers one `test-pr` word binds. */
export const TEST_PR_MAX = 50;

/** Why `test-pr` cannot bind PRs to `wl`, or null: an open workload in view, not the standing one. `apply` checks it again. */
function testPrRefusal(ledger: Ledger, wl: string): string | null {
	if (wl === STANDING_WORKLOAD_ID) return "the standing workload takes no test-pr binding";
	const w = ledger.workload(wl);
	if (!w) return `no workload ${wl}`;
	if (w.status !== "open" || !workloadsInView(ledger).includes(wl)) return `${wl} is ${w.status === "open" ? "not in view" : w.status}: only an open workload is bound`;
	return null;
}

/**
 * `test-pr <wl-…> <N> [<N> …]` after the word: the workload (required), then PR numbers separated
 * by spaces and/or commas, each a positive whole number, deduplicated in Jo's order, at most
 * `TEST_PR_MAX`; `testPrRefusal` clear. Anything else is `refused` with the reason, never prose.
 */
function testPrCommand(ledger: Ledger, rest: readonly string[]): Command {
	const usage = "test-pr <wl-…> <N> [<N> …]";
	const wl = rest[0]?.replace(/,+$/, "");
	if (wl === undefined || !/^wl-\S+$/i.test(wl)) return { kind: "refused", why: `test-pr names the workload first: ${usage}` };
	const tokens = rest.slice(1).join(" ").split(/[\s,]+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return { kind: "refused", why: `test-pr names at least one PR number: ${usage}` };
	const bad = tokens.find((t) => !/^[1-9]\d*$/.test(t) || !Number.isSafeInteger(Number(t)));
	if (bad !== undefined) return { kind: "refused", why: `${bad} is not a PR number (a positive whole number): ${usage}` };
	const prs = [...new Set(tokens.map(Number))];
	if (prs.length > TEST_PR_MAX) return { kind: "refused", why: `test-pr binds at most ${TEST_PR_MAX} PRs at once; ${prs.length} named` };
	const why = testPrRefusal(ledger, wl);
	return why === null ? { kind: "test-pr", workloadId: wl, prs } : { kind: "refused", why };
}

/**
 * Why `cancel-slice <id>` cannot cancel the slice as the ledger stands (D1), or null: the slice
 * exists, is open or paused, and sits on an open workload other than the standing one (whose slice
 * is never cancelled, item 105). `apply` checks it again inside its transaction.
 */
function sliceStateRefusal(ledger: Ledger, id: string): string | null {
	const slice = ledger.slice(id);
	if (!slice) return `no slice ${id}`;
	if (slice.workload_id === STANDING_WORKLOAD_ID) return `${id} is the standing slice, never cancelled`;
	const w = ledger.workload(slice.workload_id);
	if (w?.status !== "open") return `${id} is on ${slice.workload_id}, which is ${w?.status ?? "missing"}: nothing to cancel`;
	if (slice.state !== "open" && slice.state !== "paused") return `${id} is ${slice.state}: only an open or paused slice is cancelled`;
	return null;
}

/**
 * Why a test run on slice `id` (on `wl`) holds `cancel-slice` off (D1), or null: a run is live by
 * `runLive` (via `recordLive`: no result, and a heartbeat under 60 s old or, before its first
 * heartbeat, a request under 120 s old). `apply` checks it again inside its transaction, since a
 * `test-requested:` can land between the word's reading and its apply.
 */
function liveRunRefusal(ledger: Ledger, wl: string, id: string, heartbeatOf: HeartbeatOf): string | null {
	const nowMs = Date.parse(ledger.now());
	const live = testRuns(ledger.entries(wl)).find((r) => r.request.slice === id && recordLive(r, heartbeatOf(r.request.runId), nowMs));
	if (!live) return null;
	const { runId, pr } = live.request;
	return `test run ${runId} (PR #${pr}) on ${id} is live: its test-run: settles the slice; cancel it once the run has ended`;
}

/**
 * `cancel-slice <sl-…>` after the word (D1): exactly one slice id, `sliceStateRefusal` clear, and
 * `liveRunRefusal` clear; any of these failing is `refused` with the reason, never prose.
 */
function cancelSliceCommand(ledger: Ledger, rest: readonly string[], heartbeatOf: HeartbeatOf): Command {
	if (rest.length !== 1 || !/^sl-\S+$/i.test(rest[0]!)) return { kind: "refused", why: "cancel-slice names one slice: cancel-slice sl-…" };
	const id = rest[0]!;
	const why = sliceStateRefusal(ledger, id);
	if (why !== null) return { kind: "refused", why };
	const wl = ledger.slice(id)!.workload_id;
	const live = liveRunRefusal(ledger, wl, id, heartbeatOf);
	if (live !== null) return { kind: "refused", why: live };
	return { kind: "cancel-slice", workloadId: wl, sliceId: id };
}

/** Why `supersede <a> <b>` cannot apply (D2), or null: A is an open workload other than the standing one, B exists, and they differ. `apply` checks it again. */
function supersedeRefusal(ledger: Ledger, a: string, b: string): string | null {
	if (a === b) return `${a} cannot supersede itself`;
	if (a === STANDING_WORKLOAD_ID || b === STANDING_WORKLOAD_ID) return "the standing workload is never superseded nor a successor";
	const wa = ledger.workload(a);
	if (!wa) return `no workload ${a}`;
	if (wa.status !== "open") return `${a} is ${wa.status}: only an open workload is superseded`;
	if (!ledger.workload(b)) return `no workload ${b}`;
	return null;
}

/** `supersede <wl-A> <wl-B>` after the word (D2): two workload ids, `supersedeRefusal` clear; anything else is `refused` with the reason, never prose. */
function supersedeCommand(ledger: Ledger, rest: readonly string[]): Command {
	if (rest.length !== 2 || !rest.every((w) => /^wl-\S+$/i.test(w))) return { kind: "refused", why: "supersede names two workloads: supersede <wl-A> <wl-B> (A is superseded by B)" };
	const [a, b] = rest as [string, string];
	const why = supersedeRefusal(ledger, a, b);
	return why === null ? { kind: "supersede", workloadId: a, by: b } : { kind: "refused", why };
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

/**
 * `cancel-slice` applied (D1), inside one transaction: `sliceStateRefusal` and `liveRunRefusal`
 * checked again (each throws, writing nothing), Jo's instruction on the slice, every open question
 * on it withdrawn with `then cancel` naming the instruction (the `withdraw` word's ledger call),
 * and the slice cancelled (`Ledger.cancelSlice`) unless the last withdrawal's cancel already did
 * it. When a withdrawn question was raised by a launched lane and no lane holds the workload live,
 * Jo's `launch-requested:` follows (`settleCeiling`'s rule), since a cancel withdrawal is no
 * resolution a parked lane resumes on (`resolutions`). Returns the receipt.
 */
function cancelSlice(ledger: Ledger, cmd: Extract<Command, { kind: "cancel-slice" }>, heartbeatOf: HeartbeatOf): string {
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	const { workloadId: wl, sliceId: sl } = cmd;
	const why = sliceStateRefusal(ledger, sl) ?? liveRunRefusal(ledger, wl, sl, heartbeatOf);
	if (why !== null) throw new Error(why);
	const id = ledger.recordInstruction({ ...stamp, workloadId: wl, sliceId: sl, body: `cancel-slice ${sl}` });
	const open = ledger.questions(wl).filter((q) => q.slice_id === sl && q.state === "open");
	const withdrawn = open.map((q) => `withdrew ${q.id} (withdrawal ${ledger.withdrawQuestion(q.id, { ...stamp, reason: `cancel-slice (instruction ${id})`, then: "cancel" })}, then cancel)`);
	if (ledger.slice(sl)!.state !== "cancelled") ledger.cancelSlice(sl, { by: SURFACE_BY });
	const w = ledger.workload(wl)!;
	const launched = new Set(attempts(controlEntries(ledger.entries(wl))).map((a) => a.laneId));
	let relaunch = "";
	if (open.some((q) => launched.has(q.created_by)) && w.mode === "autonomous" && !heldLive(w, ledger.now())) {
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), `cancel-slice ${sl}`) });
		relaunch = "; no lane holds it live, so a relaunch is requested";
	}
	return [`cancelled slice ${sl} on ${wl} (instruction ${id})`, ...withdrawn].join("; ") + relaunch;
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

/** A workload's valid control entries, every holder counted (`holdersOf` with the ledger's recorded holders); null when there is no such workload. */
function controlOf(ledger: Ledger, workloadId: string): ControlEntry[] | null {
	const w = ledger.workload(workloadId);
	if (!w) return null;
	const entries = ledger.entries(workloadId);
	return controlEntries(entries, holdersOf(entries, w.holder, ledger.holders(workloadId)));
}

/** Is `q` the plan question (decision 15, PLAN wl-muq22rnjcfrrpc D9 part two): `isPlanQuestionIn` on its workload's control entries. */
export function isPlanQuestion(ledger: Ledger, q: { id: string; workload_id: string }): boolean {
	const control = controlOf(ledger, q.workload_id);
	return control !== null && isPlanQuestionIn(control, q);
}

/**
 * The control entry a mode flip implies, written in the caller's transaction (decision 6; Codex review S3): a flip to
 * user-driven while an autonomous lane holds the workload live writes the `lane-stop:` request the runner accepts; a
 * flip to autonomous writes Jo's `launch-requested:` cause, so a relaunch has something to consume. Returns the
 * receipt tail. Jo's `mode` word and Jo's `pair` answer (D7) both go through it.
 */
export function modeFlipControl(ledger: Ledger, workloadId: string, mode: Mode): string {
	const w = ledger.workload(workloadId);
	if (mode === "user-driven" && w && w.holder?.startsWith("lane-") && heldLive(w, ledger.now())) {
		ledger.recordEntry({ by: SURFACE_BY, workloadId, kind: "assumption", body: laneStopRequestBody(w.holder, "mode-flip", "jo") });
		return `; stop requested of ${w.holder} (it accepts at its next poll)`;
	}
	if (mode === "autonomous") ledger.recordEntry({ by: SURFACE_BY, workloadId, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), "mode-flip") });
	return "";
}

/**
 * The site at which `q` validly offers `pair` (PLAN wl-mv67564rdkfvnk D9 (3)), else null: `pair` is among its options,
 * it is the classifier's round-limit question or the runner's ceiling question, and a `pair-offer:` naming it at that
 * site carries that site's stamp (the classifier at the round limit, the lane runner at the ceiling).
 */
function pairOfferSite(ledger: Ledger, q: QuestionRow): PairSite | null {
	if (!(JSON.parse(q.options) as string[]).some((o) => o.toLowerCase() === PAIR_OPTION)) return null;
	const site: PairSite | null = isCeilingQuestion(q, ledger.slice(q.slice_id)) ? "ceiling" : isReviewLimitQuestion(ledger, q) ? "round-limit" : null;
	if (site === null) return null;
	const by = pairOfferStamp(site);
	const offered = ledger.entries(q.workload_id, "assumption").some((e) => {
		const o = e.created_by === by ? parsePairOffer(e.body) : null;
		return o !== null && o.questionId === q.id && o.site === site;
	});
	return offered ? site : null;
}

/**
 * Jo's `pair` on an offered question (D7), in one transaction: the answer; the settlement `stop` writes (the round
 * limit's `review-loop-end: <sl> reason stop`, or the ceiling slice done `answered stop <answer>`, so the runner reads
 * stop); the flip to user-driven as Jo via the surface; `pair-taken:`; and the `lane-stop:` request a live lane holder
 * accepts. A question with no valid offer is refused naming it, and nothing is written.
 */
function applyPair(ledger: Ledger, q: QuestionRow, answer: string): string {
	const site = pairOfferSite(ledger, q);
	if (site === null) throw new Error(`${q.id} does not offer pair: no pair-offer: from its raiser names it at its site; refused, never applied`);
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	return ledger.write(() => {
		const answerId = ledger.answerQuestion(q.id, { ...stamp, answer });
		const settled = site === "round-limit" ? settleReviewLimit(ledger, q, "stop", answerId) : settleCeiling(ledger, q, "stop", answerId);
		const flip = ledger.flipMode(q.workload_id, { ...stamp, mode: "user-driven" });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: q.workload_id, kind: "assumption", body: pairTakenBody(q.id, answerId) });
		const stop = modeFlipControl(ledger, q.workload_id, "user-driven");
		const what = site === "round-limit" ? settled : `; the ceiling question reads stop`;
		return `answered ${q.id} with "${answer}" (answer ${answerId})${what}; mode on ${q.workload_id} → user-driven (mode-flip ${flip}); continue it yourself: as2 lane ${q.workload_id}${stop}`;
	});
}

/**
 * Apply a command through the ledger module as Jo via the surface. Returns the one-line receipt.
 * `heartbeatOf` is the run heartbeat reader `cancel-slice` re-checks its live-run refusal with; pass
 * the one `interpret` was given.
 */
export function apply(ledger: Ledger, cmd: Command, heartbeatOf: HeartbeatOf = runHeartbeat(process.env)): string {
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
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
			// D7: `pair` is honoured only on a question that validly offered it; anywhere else it is refused, never a plain word.
			if (word === PAIR_OPTION) return applyPair(ledger, q0, cmd.answer);
			// D4: *approve* on any other question while `plan: first` stands unapproved approves nothing, and the receipt says so.
			const notPlan = !plan && word === "approve" && planFirst(controlOf(ledger, q0.workload_id) ?? []) !== null;
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
			const approved = plan && word === "approve" ? "; plan approved: change slices may now be added" : notPlan ? "; not the plan question: no plan approval written" : "";
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
		case "test-batch":
			throw new Error("test-batch is applied by the surface, which writes the request and starts the batch (requestTestBatch + startBatch)");
		case "cancel-slice":
			return ledger.write(() => cancelSlice(ledger, cmd, heartbeatOf));
		case "supersede": {
			// D2: the instruction on A first, then the surface's `superseded:` naming it, in one transaction; the close reads both (`supersededBy`).
			return ledger.write(() => {
				const why = supersedeRefusal(ledger, cmd.workloadId, cmd.by);
				if (why !== null) throw new Error(why);
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: supersedeInstructionBody(cmd.workloadId, cmd.by) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: supersededBody(cmd.by, id) });
				return `${cmd.workloadId} is superseded by ${cmd.by} (instruction ${id}); its close takes this in place of a done-because: receipt`;
			});
		}
		case "test-pr": {
			// Jo's instruction first, then the surface's `test-pr:` naming it, in one transaction; the runner reads both (`boundPrs`).
			return ledger.write(() => {
				const why = testPrRefusal(ledger, cmd.workloadId);
				if (why !== null) throw new Error(why);
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: testPrInstructionBody(cmd.workloadId, cmd.prs) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: testPrBody(cmd.prs, id) });
				const prs = cmd.prs.map((n) => `#${n}`).join(", ");
				return `${cmd.prs.length === 1 ? "PR" : "PRs"} ${prs} bound to ${cmd.workloadId} for test runs with no push (instruction ${id})`;
			});
		}
		case "ambiguous":
			throw new Error(`"${cmd.word}" fits ${cmd.candidates.length} rows; an ambiguous word is refused, never applied`);
		case "refused":
			throw new Error(`${cmd.why}; refused, never applied`);
	}
}
