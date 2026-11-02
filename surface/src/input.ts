// Jo's short inputs at the surface (SPEC-2.0.md § A1.2, § B3 item 5, § B5, § B13.1): a stakes
// word or a mode word flips the workload in view; an option name answers the open question that
// offers it; `withdraw` withdraws it (then replan); `approve` / `deny` answers a reserved request. `approve <id>` / `deny <id>`
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
// heading, the fence around its answer lines, the plan path and pair offer lines hung under them,
// the generated sentences under it, `pendingWrapperLines`) is dropped, so the block pasted whole
// forwards no instruction of its own;
// any other line Jo pasted, a fence of Jo's own included, is kept.
//
// The workload ceiling (DESIGN-workload-ceiling.md § 1 B and D, § 2 items 2 and 5; PLAN wl-mvfkv7llkp7nk0 § 4): the
// stakes word re-sizes the ceiling, `ceiling <usd> [<hours>] [wl-…]` sets Jo's exact figure, and `extend <wl-…>` raises
// it by one block of the workload's own size. Each raise names the Jo instruction written first (`ceiling: <usd>
// <hours>` for both words), which is what `effectiveCeiling` checks, and both words relaunch a lane stopped at the
// ceiling through `raiseCeiling`. The `ceiling` word is never a numbered batch; `extend` alone or `extend <q-…>` falls
// through to the answer path, so the round-limit question's `extend` still answers.
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
// The pair trigger (PLAN wl-mv67564rdkfvnk D7, surface/src/pair-suggest.ts): `pair` answers a round-limit question only
// when its raiser offered it (a `pair-offer:` with the classifier's stamp names it). It settles the question as `stop`
// does, flips the workload to user-driven as Jo, writes `pair-taken:`, and asks a live lane holder to stop, all in one
// transaction (`applyPair`); on any other question `pair` is refused naming it.
//
// Binding PRs for a test run with no push (PLAN wl-mv5qdfvv82ivwg § 2.1; migration/items/test-pr-binds-named-prs.md):
// `test-pr <wl-…> <N> [<N> …]` (numbers separated by spaces and/or commas, deduplicated, Jo's order
// kept, at most 50) writes Jo's instruction `test-pr <wl> <N…>` on the workload, then the surface's
// `test-pr: <N…> <instruction id>` naming it, in one transaction; the test runner admits those PRs
// (`boundPrs`, surface/src/launch.ts). The workload is always named, never inferred. The word is the
// command or `refused` with the reason (not an open workload, the standing one, no number, a bad
// number), never prose and never a numbered-batch piece, at any length.
//
// Waiving a merged PR for the close check (PLAN wl-mvfjen3q5mqi2o D3): `waive-pr <wl-…> <N> [<N> …]` is parsed and
// refused exactly as `test-pr` is (`prWordCommand`), and writes Jo's instruction `waive-pr <wl> <N…>`, then the
// surface's `waive-pr: <N…> <instruction id>` naming it, in one transaction; the close check reads them (`waivedPrs`,
// surface/src/launch.ts) and passes a MERGED PR nothing covers. It never binds a PR for a test run (`boundPrs`).
//
// The merge train (PLAN wl-mv8s8srodefytc § 1, PLAN wl-mvr888nftz0vcl D2, surface/src/merge-train.ts): there is one, and it is
// permanent. `train <N> [<N> …]` (numbers by spaces and/or commas, `#N` accepted, deduplicated, Jo's order kept, at most 50)
// appends to the open train (`theTrain`), refusing a PR of a repository other than the train's with nothing written, and opens
// one only when none is open, in one transaction (`applyTrain`: the preallocated id, the brief `trainBrief`, normal and
// autonomous, the surface's repo, `done:` TRAIN_DONE, no `ceiling:` and no `plan:`, Jo's instruction `train <wl> <N…>` and the
// surface's `train: <N…> <instruction id>`); `train <wl-…> <N> [<N> …]` adds PRs to that train (refused on any other workload,
// the standing one or a closed one). A PR already on the train boards again only once its current attempt is terminal
// (`trainAttemptFor`, lane decision en-mvznmxcdh0ucsj), except that on a train Jo's stop holds the word is the resume and may
// re-name its PRs. Appending writes Jo's `launch-requested:` when no lane holds the train live, so a stopped train relaunches.
// Either form refuses a PR already on another open train of the same repo, unless Jo skipped it there (rev 17.1 D8,
// `onOtherTrain`). Exactly two forms fall through to the answer path, since a question may offer the option `train`: `train`
// alone and `train <q-…>`; every other `train …` line is the command or `refused`, never prose. A train word inside a
// numbered batch is refused (`trainInBatch`). Jo's `skip` on a question on a train slice of PR n cancels the open slices of
// that PR's current attempt in the answer's transaction, keeping open one whose test run is live (`trainSkipClose`). On the
// train, `withdraw` and `supersede` (D3), `extend` and `ceiling` (D4) and `user-driven` (D5) are refused with nothing written,
// each naming its rule (`trainPermanentRefusal`, `trainNoWallRefusal`, `trainAutonomousRefusal`); a train's fix workload is
// an ordinary workload (R10).
//
// The budget raise (PLAN wl-mvr888nftz0vcl D7, R26, R28): `raise <usd> [q-…]` answers the train's budget pause question
// (`budgetPauseOf`) and adds `usd` to the paused PDT day's limit: one transaction checks again that the question is open and
// the pause's day is today, then writes Jo's answer `raise` and the surface's `train-raise: day <D> usd <x> answer <id>`.
// Refused, nothing written: `raise` alone, `raise <q-…>` or a numbered `raise` on a budget question, an amount that is not a
// positive plain number, a day already over, no budget question open. Any other question offering `raise` keeps its answers.
//
// Ending a standing ruling at once (PLAN wl-mvfkv7llkp7nk0 § 1, gates/src/rulings.ts): `end-ruling <ruling-id>` writes Jo's
// instruction `end-ruling <id>` on the standing workload, which `endedRulings` reads, so every later question of that
// ruling's kind goes to Jo again. One token, never an option word; an id `STANDING_RULINGS` does not hold, or a ruling
// already ended, is `refused` with the reason, never prose.
//
// Halting a plan (PLAN wl-mvfkv7llkp7nk0 § 3): `halt <wl-…>` writes Jo's instruction `halt <wl>` on that workload, the
// surface's `plan: halted <instruction>` (so `planFirst` reads it unapproved again, change slices are refused, the plan
// never starts on its own again, and `prStakes` holds its PRs), and a `lane-stop:` request when a lane holds it live.
// A workload not open, the standing one, or one already halted with no approve since is `refused`, never prose.
//
// Withdrawing a workload with no done-because: receipt (PLAN wl-mv8s939084z1ts D1–D4): `withdraw <wl-…>`
// (exactly one workload id; a line whose second word starts `wl-` is the command or `refused`, at
// any length, never prose and never a numbered-batch piece) writes Jo's instruction `withdraw <wl>`
// on the workload, then the surface's `withdrawn: <instruction id>` naming it, in one transaction;
// the close reads both (`withdrawnBy`) in place of the holder's receipt, and the surface closes the
// workload right after (surface/extensions/surface-input.ts `closeAfter`). Refused, writing nothing
// (`withdrawRefusal`, checked again inside `apply`): no such workload, the standing one, one not
// open, a scheduled `due:` row, any open or paused slice (named), any open question, or a holder
// under a live lease. Done and cancelled slices are both allowed. Bare `withdraw` and `withdraw
// <q-…>` keep their question meaning.
//
// Land-first activation and main retries (PLAN wl-mvq4edbaf13vnk § 2 Activation, Attempts; D12): `land-first <repo> on|off`
// writes Jo's instruction `land-first <repo> on|off` and the surface's `land-first:` binding in one transaction.
// Off also writes `land-first-off-pending:` there: merges stay held until tick revocation completes under the publication mutex.
// On is refused until § 2's bootstrap holds (`bootstrapRefusal`, surface/src/main-state.ts, read from the standing workload's entries), checked
// again inside `apply`. `main-retry <repo>` writes Jo's `main-retry <repo>` and the surface's `main-retry: <repo> <instruction
// id>` the same way; it opens the next attempt block of an exhausted main commit (`mainRetries`). Both words are the command
// or `refused` with the reason, at any length, never prose.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parkQuestions } from "../../classifier/src/lab";
import { END_RULING_WORD, endedRulings, endRulingBody, isRulingId, type RulingId, STANDING_RULINGS } from "../../gates/src/rulings";
import { reviewStopBody, stopReviewsInstructionBody } from "../../classifier/src/review-stop";
import {
	countRounds, effectiveRoundLimit, type FindingKind, type Findings, parseReviewLimit, REVIEW_ROUND_DEFAULTS, reviewLoopEndBody,
	reviewRoundsBody, reviewRoundsExtendBody, type Round, ROUND_LIMIT_OPTIONS, type RoundLimitOption, roundsInstructionBody, SEVERITIES,
	severityLine, UNKNOWN,
} from "../../classifier/src/rounds";
import { LOW_CONFIDENCE_THRESHOLD } from "../../classifier/src/route";
import { CLASSIFIER_BY, type Ledger, type Mode, newId, type QuestionRow, type RoutingKind, type Stakes } from "../../ledger/src/index";
import { type Ceiling, ceilingBody, crossed, effectiveCeiling, EXTEND_SOURCE, parseSpend, sizeFor } from "./ceiling";
import { recordRepo, repoOf } from "./decision-log";
import { closedReservedRefusal, waitingReserved, wordsOf } from "./errors";
import {
	attempts, byHandLine, consumedIds, type ControlEntry, controlEntries, doneBody, heldLive, holdersOf, isPlanQuestionIn, laneStopRequestBody, launchRequestedBody, planApprovedBody, planFirst, planHaltedBody,
	supersededBody, supersedeInstructionBody, testPrBody, testPrInstructionBody, waivePrBody, waivePrInstructionBody, withdrawInstructionBody, withdrawnBody,
	LAND_FIRST_WORD, landFirstBody, landFirstInstructionBody, landFirstOffBody, landFirstOffPending, MAIN_RETRY_WORD, mainRetryBody, mainRetryInstructionBody, REPO_WORD_RE,
} from "./launch";
import { bootstrapRefusal } from "./main-state";
import {
	currentAttemptSlice, isTrain, onOtherTrain, repoIdentity, TRAIN_DONE, trainAttemptFor, trainAttemptsOf, trainAutonomousRefusal, trainBody, trainBrief, trainCheckout, trainHold,
	trainInstructionBody, trainNoWallRefusal, trainPermanentRefusal, trainPrs, trainSlicePr, theTrain,
} from "./merge-train";
import { pdtDay, type TrainPause, trainBudgetSliceId, trainDayLimit, trainPauses, trainRaiseBody, usdText } from "./train-budget";
import type { Numbering, Target } from "./numbering";
import { ensureStandingWorkload } from "./identity";
import { answerOrchestratorQuestion } from "./orchestrator-question";
import { PAIR_OPTION, type PairSite, pairOfferLine, pairTakenBody, parsePairOffer, shownOptions } from "./pair-suggest";
import { parseHeartbeat, recordLive, type RunRecord, runDirOf, runsRoot, testRuns } from "./test-run";
import { pendingWrapperLines } from "./pending";
import { DUE_PREFIX, MERGE_TRAIN_BY, MODE_WORDS, STAKES_WORDS, STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

/** A "which one?" candidate: a needs-you row (`Target`) or, for a bare stakes, mode, `ceiling`, `rounds` or `stop-reviews` word, a workload in view. */
export type Candidate = Target | { kind: "workload"; workloadId: string };

export type Command =
	| { kind: "stakes"; workloadId: string; stakes: Stakes }
	| { kind: "mode"; workloadId: string; mode: Mode }
	| { kind: "answer"; workloadId: string; questionId: string; answer: string }
	| { kind: "withdraw"; workloadId: string; questionId: string }
	| { kind: "reserved"; workloadId: string; entryId: string; verdict: "approve" | "deny" }
	| { kind: "ceiling"; workloadId: string; usd: number; wallMin: number | null }
	/** `extend <wl-…>`: one more block of the workload's own size on its ceiling (PLAN wl-mvfkv7llkp7nk0 § 4). */
	| { kind: "extend"; workloadId: string }
	/** `rounds <n>`: the workload's review round limit (D9). */
	| { kind: "rounds"; workloadId: string; rounds: number }
	/** `stop-reviews`: `target` is the workload's id (every loop on it) or one slice's id (that loop) (D10). */
	| { kind: "stop-reviews"; workloadId: string; target: string }
	/** `cancel-slice <sl-…>`: cancel one open or paused slice (D1). */
	| { kind: "cancel-slice"; workloadId: string; sliceId: string }
	/** `supersede <wl-A> <wl-B>`: `workloadId` (A) is superseded by `by` (B) (D2). */
	| { kind: "supersede"; workloadId: string; by: string }
	/** `test-pr <wl-…> <N…>`: Jo binds these PR numbers to the workload for a test run with no push. */
	| { kind: "test-pr"; workloadId: string; prs: number[] }
	/** `waive-pr <wl-…> <N…>`: Jo waives these merged PR numbers on the workload for the close check. */
	| { kind: "waive-pr"; workloadId: string; prs: number[] }
	/** `land-first <repo> on|off`: Jo turns land-first on or off for a repository (PLAN wl-mvq4edbaf13vnk D12). */
	| { kind: "land-first"; repo: string; on: boolean }
	/** `main-retry <repo>`: Jo opens the next attempt block of the repository's exhausted main commits (PLAN wl-mvq4edbaf13vnk § 2 Attempts). */
	| { kind: "main-retry"; repo: string }
	/** `train <N…>`: Jo opens a merge train on these PRs (`applyTrain`, never `apply`: the open needs the surface's repo). */
	| { kind: "train"; prs: number[] }
	/** `train <wl-…> <N…>`: Jo adds these PRs to the open merge train `workloadId`. */
	| { kind: "train-append"; workloadId: string; prs: number[] }
	/** `end-ruling <ruling-id>`: Jo ends one standing ruling at once (gates/src/rulings.ts). */
	| { kind: "end-ruling"; ruling: RulingId }
	/** `halt <wl-…>`: Jo stops a workload's plan (PLAN wl-mvfkv7llkp7nk0 § 3): plan-first again, its live lane stopped, its PRs held. */
	| { kind: "halt"; workloadId: string }
	/** `withdraw <wl-…>`: Jo withdraws the workload, closed with no done-because: receipt (PLAN wl-mv8s939084z1ts D1). */
	| { kind: "withdraw-workload"; workloadId: string }
	/** `raise <usd> [q-…]`: Jo's answer `raise` to the merge train's budget pause question `questionId`, adding `usd` to the pause's PDT day (PLAN wl-mvr888nftz0vcl D7). */
	| { kind: "raise"; workloadId: string; questionId: string; usd: number }
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
 * and are the command or `refused`, never prose; so is a `withdraw` whose second word is a `wl-…`
 * id, at any length (PLAN wl-mv8s939084z1ts D1), while bare `withdraw` and `withdraw q-…` withdraw
 * a question as before. `heartbeatOf` reads a test run's heartbeat for `cancel-slice`'s live-run
 * refusal (the surface passes its own env's).
 */
export function interpret(ledger: Ledger, text: string, heartbeatOf: HeartbeatOf = runHeartbeat(process.env)): Command | null {
	const words = stripTail(text).trim().split(/\s+/);
	const word = words[0]!.toLowerCase();
	const view = workloadsInView(ledger);
	// The commands longer than two words; one that does not parse falls through, so an option named "ceiling" or "rounds" still answers.
	if (word === "ceiling") {
		const c = ceilingCommand(words.slice(1), view);
		// PLAN wl-mvr888nftz0vcl D4: the merge train has no ceiling; nothing is written.
		const why = c?.kind === "ceiling" ? trainNoWallRefusal(ledger, c.workloadId) : null;
		if (why !== null) return { kind: "refused", why };
		if (c) return c;
	}
	if (word === "rounds") {
		const c = roundsCommand(words.slice(1), view);
		if (c) return c;
	}
	// One token each (D1, D2), so neither is ever read as an option word: `cancel` stays the plan question's.
	if (word === "cancel-slice") return cancelSliceCommand(ledger, words.slice(1), heartbeatOf);
	if (word === "supersede") return supersedeCommand(ledger, words.slice(1));
	if (word === END_RULING_WORD) return endRulingCommand(ledger, words.slice(1));
	// `halt <wl-…>` is the command or `refused`; `halt` alone or naming no workload falls through, so an option named "halt" still answers.
	if (word === HALT_WORD && words.length === 2 && /^wl-/i.test(words[1]!)) return haltCommand(ledger, words[1]!);
	// `extend <wl-…>` likewise; `extend` alone or `extend <q-…>` falls through, so the round-limit question's `extend` still answers.
	if (word === EXTEND_WORD && words.length === 2 && /^wl-/i.test(words[1]!)) return extendCommand(ledger, words[1]!);
	// Always the command or `refused`, at any length, so a long binding never passes as prose.
	if (word === "test-pr" || word === "waive-pr") return prWordCommand(ledger, word, words.slice(1));
	if (word === LAND_FIRST_WORD) return landFirstCommand(ledger, words.slice(1));
	if (word === MAIN_RETRY_WORD) return mainRetryCommand(words.slice(1));
	// The command or `refused` at any length, except `train` alone and `train <q-…>`, which fall through to the answer path.
	if (word === "train") {
		const c = trainCommand(ledger, words.slice(1));
		if (c) return c;
	}
	// PLAN wl-mv8s939084z1ts D1: `withdraw wl-…` is the command or `refused` at any length; bare `withdraw` and `withdraw q-…` go on below.
	if (word === "withdraw" && /^wl-/i.test(words[1] ?? "")) return withdrawWorkloadCommand(ledger, words.slice(1));
	// PLAN wl-mvr888nftz0vcl D7: `raise <usd> [q-…]` on a budget pause question, ahead of the option answers; null lets `raise` and
	// `raise q-…` answer any other question that offers `raise` (R28).
	if (word === RAISE_WORD) {
		const c = raiseCommand(ledger, words.slice(1));
		if (c) return c;
	}
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
		if (!wl) return null;
		const mode = (word === "user driven" ? "user-driven" : word) as Mode;
		// D5: the merge train runs autonomous only; nothing is written.
		const why = mode === "user-driven" ? trainAutonomousRefusal(ledger, wl) : null;
		return why === null ? { kind: "mode", workloadId: wl, mode } : { kind: "refused", why };
	}
	// One token (D10), so it never answers an option named `stop`.
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
		return { kind: "withdraw", workloadId: q.workload_id, questionId: q.id };
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
/** A numbered piece that carries a train word with arguments (`1 train 101`). */
const NUMBERED_TRAIN = /^(?:#|q)?\d+\s*[:.)]?\s+train\s+\S/i;

/** The refusal of a train word inside a numbered batch (§ 1): it opens a workload, and a batch answers rows. */
export const TRAIN_IN_BATCH = "a train word opens or adds to a merge train, never inside a numbered batch: send `train …` on a line of its own";

/**
 * Is `text` a numbered batch with a train word in it (PLAN wl-mv8s8srodefytc § 1): split as `parseBatch` splits, the first
 * piece numbered and some piece a train word with arguments (`train 101`, `2 train 101`). `1 train` stays a batch piece
 * answering a question that offers `train`; a line that starts with `train` is the train word, never this.
 */
export function trainInBatch(text: string): boolean {
	const pieces = text.split(/[\n,]/).map((p) => p.trim()).filter((p) => p.length > 0);
	const first = pieces[0];
	if (first === undefined || !(BATCH_PIECE.test(first) || NUMBERED_TRAIN.test(first))) return false;
	return pieces.some((p) => NUMBERED_TRAIN.test(p) || /^train\s+\S/i.test(p));
}

export interface BatchItem {
	n: number;
	cmd: Command;
}
export type BatchResult = { ok: true; items: BatchItem[] } | { ok: false; lines: string[] };

/**
 * The words a single-line command may run to: `ceiling <usd> [<hours>] [wl-…]` is four, `rounds <n> [wl-…]`,
 * `supersede <wl-A> <wl-B>` and `raise <usd> [q-…]` (PLAN wl-mvr888nftz0vcl D7) three, `test-pr <wl-…> <N> [<N> …]`, `waive-pr <wl-…> <N> [<N> …]`,
 * `train [<wl-…>] <N> [<N> …]`, `withdraw wl-…` (PLAN wl-mv8s939084z1ts D1), `land-first …` and `main-retry …` any number
 * (`interpret` refuses past `TEST_PR_MAX`, `withdraw` past one id, and the land-first words past their shape), everything else two.
 */
export function maxWords(text: string): number {
	if (/^withdraw\s+wl-/i.test(text)) return Number.POSITIVE_INFINITY;
	const long = /^(ceiling|rounds|supersede|raise|test-pr|waive-pr|train|land-first|main-retry)(?:\s|$)/i.exec(text)?.[1]!.toLowerCase() ?? null;
	if (long === "ceiling") return 4;
	if (long === "rounds" || long === "supersede" || long === RAISE_WORD) return 3;
	return long === null ? 2 : Number.POSITIVE_INFINITY;
}

/** Could `text` (one line, trimmed) be a command: a numbered batch (a train word inside one included, to be refused), or short enough for a word command. A false means prose, with no ledger read. */
export function commandShaped(text: string): boolean {
	const t = stripTail(text);
	return t.length > 0 && (parseBatch(t) !== null || trainInBatch(t) || t.split(/\s+/).length <= maxWords(t));
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
 * any fails → one line per piece, nothing to apply. A train word inside a batch (`trainInBatch`)
 * refuses it whole.
 */
export function interpretBatch(ledger: Ledger, numbering: Numbering, text: string): BatchResult | null {
	if (trainInBatch(text)) return { ok: false, lines: [TRAIN_IN_BATCH] };
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
		if (w === "withdraw") return { n, cmd: { kind: "withdraw", workloadId: q.workload_id, questionId: q.id } };
		// D7: the option word alone carries no amount on a budget pause question; any other question's `raise` answers it (R28).
		if (w === RAISE_WORD && budgetPauseOf(ledger, q) !== null) return `#${n}: ${bareRaiseRefusal(q.id)}`;
		const answer = q.options.find((o) => o.toLowerCase() === w);
		if (answer === undefined) {
			const { takes, after } = takesOf(ledger, q);
			return `#${n} takes: ${takes}${after}`;
		}
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
	return [...STAKES_WORDS, ...MODE_WORDS, "approve", "deny", "withdraw", "ceiling", EXTEND_WORD, "rounds", "stop-reviews", HALT_WORD, RAISE_WORD, ...offered];
}

/**
 * The id-shaped targets a line of a paste names after a command word (`approve en-nope`, `left
 * q-nope`, `production wl-nope`, `ceiling 120 wl-nope`, `extend wl-nope`), or null when the line opens with no
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

/** What a command resolves, for the once-per-row check across a paste: the question it answers or withdraws, the reserved request it decides, the slice it cancels, the workload it supersedes, withdraws or halts, or the ruling it ends; else null. */
function resolves(cmd: Command): string | null {
	switch (cmd.kind) {
		case "answer":
		case "withdraw":
		case "raise":
			return cmd.questionId;
		case "reserved":
			return cmd.entryId;
		case "cancel-slice":
			return cmd.sliceId;
		case "supersede":
		case "withdraw-workload":
			return cmd.workloadId;
		case "end-ruling":
			return cmd.ruling;
		case "halt":
			return `${HALT_WORD} ${cmd.workloadId}`;
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
 *   its heading, the fence around its answer lines, the plan path and pair offer lines hung under
 *   them, the generated sentences under it): dropped,
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
		if (trainInBatch(t)) {
			read.push({ line, text: t, kind: "invalid", why: TRAIN_IN_BATCH });
			continue;
		}
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
		const cmd = looseWorkloadPair(t) ? null : interpret(ledger, t, heartbeatOf);
		if (cmd) read.push({ line, text: t, kind: "command", cmd });
		else if (ids === null) read.push({ line, text: t, kind: "prose" });
		else {
			// Every id resolves and the line still is no command: named with what the row takes.
			const q = ledger.inFlight().flatMap((w) => w.openQuestions).find((x) => x.id === ids[0]);
			const takes = q ? takesOf(ledger, q) : null;
			read.push({ line, text: t, kind: "invalid", why: `"${t}" is not a command the surface knows${takes ? ` (${ids[0]} takes: ${takes.takes})${takes.after}` : ""}` });
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
			const done =
				cmd.kind === "reserved" ? "decided" : cmd.kind === "cancel-slice" ? "cancelled" : cmd.kind === "supersede" ? "superseded" : cmd.kind === "withdraw-workload" ? "withdrawn"
				: cmd.kind === "end-ruling" ? "ended" : cmd.kind === "halt" ? "halted" : "answered";
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

/** The most PR numbers one `test-pr` or `waive-pr` word binds. */
export const TEST_PR_MAX = 50;

/** The words `prWordCommand` reads: Jo's PR bindings that name their workload and only add numbers to it. */
type PrWord = "test-pr" | "waive-pr";

/** Why `word` cannot bind PRs to `wl`, or null: an open workload in view, not the standing one. `apply` checks it again. */
function prWordRefusal(ledger: Ledger, word: PrWord, wl: string): string | null {
	if (wl === STANDING_WORKLOAD_ID) return `the standing workload takes no ${word} binding`;
	const w = ledger.workload(wl);
	if (!w) return `no workload ${wl}`;
	if (w.status !== "open" || !workloadsInView(ledger).includes(wl)) return `${wl} is ${w.status === "open" ? "not in view" : w.status}: only an open workload is bound`;
	return null;
}

/**
 * `test-pr <wl-…> <N> [<N> …]` or `waive-pr <wl-…> <N> [<N> …]` after the word: the workload (required), then PR numbers
 * separated by spaces and/or commas, each a positive whole number, deduplicated in Jo's order, at most `TEST_PR_MAX`;
 * `prWordRefusal` clear. Anything else is `refused` with the reason, never prose.
 */
function prWordCommand(ledger: Ledger, word: PrWord, rest: readonly string[]): Command {
	const usage = `${word} <wl-…> <N> [<N> …]`;
	const wl = rest[0]?.replace(/,+$/, "");
	if (wl === undefined || !/^wl-\S+$/i.test(wl)) return { kind: "refused", why: `${word} names the workload first: ${usage}` };
	const tokens = rest.slice(1).join(" ").split(/[\s,]+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return { kind: "refused", why: `${word} names at least one PR number: ${usage}` };
	const bad = tokens.find((t) => !/^[1-9]\d*$/.test(t) || !Number.isSafeInteger(Number(t)));
	if (bad !== undefined) return { kind: "refused", why: `${bad} is not a PR number (a positive whole number): ${usage}` };
	const prs = [...new Set(tokens.map(Number))];
	if (prs.length > TEST_PR_MAX) return { kind: "refused", why: `${word} binds at most ${TEST_PR_MAX} PRs at once; ${prs.length} named` };
	const why = prWordRefusal(ledger, word, wl);
	return why === null ? { kind: word, workloadId: wl, prs } : { kind: "refused", why };
}

/** The train word's usage, named in every refusal of a malformed `train …` line. */
const TRAIN_USAGE = "train <N> [<N> …] opens a merge train; train <wl-…> <N> [<N> …] adds PRs to one";

/**
 * Why `train [<wl>] <prs>` cannot add to `wl` (PLAN wl-mv8s8srodefytc § 1; PLAN wl-mvr888nftz0vcl D2), or null: an open
 * workload in view, not the standing one, that is a merge train (`trainPrs`: Jo's `train:` or the tick's `train-board:`, PLAN
 * wl-mvbjiettjrfpxc D2); every PR among `prs` boardable now (`trainAttemptFor`, lane decision en-mvznmxcdh0ucsj: a PR never on
 * the train takes attempt 1, a PR whose current attempt is terminal takes the next one, a PR whose current attempt is open or not
 * yet sliced is refused) unless Jo's stop holds the train (`trainHold`): then the word is the resume and may re-name its PRs,
 * starting no attempt for an open one (D2); and none on another open train of the same repo (rev 17.1 D8, `onOtherTrain`).
 * `apply` and `applyTrain` check it again inside their transaction.
 */
function trainAppendRefusal(ledger: Ledger, wl: string, prs: readonly number[]): string | null {
	if (wl === STANDING_WORKLOAD_ID) return "the standing workload is never a merge train";
	const w = ledger.workload(wl);
	if (!w) return `no workload ${wl}`;
	if (w.status !== "open" || !workloadsInView(ledger).includes(wl)) return `${wl} is ${w.status === "open" ? "not in view" : w.status}: only an open merge train takes PRs`;
	const entries = ledger.entries(wl);
	const instructions = ledger.instructions(wl);
	const on = trainPrs(entries, instructions);
	if (on.length === 0) return `${wl} is not a merge train (no train: or train-board: entry); open one with train <N> [<N> …]`;
	const held = trainHold({ entries, instructions, questions: ledger.questions(wl) }) !== null;
	if (!held) {
		for (const n of prs) {
			const a = trainAttemptFor(ledger, wl, n);
			if (!a.ok) return a.reason;
		}
	}
	const repo = repoOf(ledger, wl);
	return repo === null ? null : otherTrainRefusal(ledger, repo, prs, wl);
}

/** The refusal for a PR already on another open train of `repo` (rev 17.1 D8: one train, one task stream per PR), or null. */
function otherTrainRefusal(ledger: Ledger, repo: string, prs: readonly number[], except: string | null): string | null {
	const other = onOtherTrain(ledger, repo, prs, except);
	return other === null ? null : `#${other.pr} is already on open merge train ${other.train}; a PR rides one train at a time: add to that one with \`train ${other.train} …\`, or wait for it to close`;
}

/**
 * `train …` after the word (§ 1; PLAN wl-mvr888nftz0vcl D2): `train <N…>` adds to the one open train (`theTrain`) or opens it
 * when none is open, `train <wl-…> <N…>` adds to that train; PR numbers separated by spaces and/or commas, `#N` accepted, each
 * a positive whole number, deduplicated in Jo's order, at most `TEST_PR_MAX`. `train <N…>` with a train open is checked here as
 * an append (`trainAppendRefusal`); its repository check needs the surface's repo, so `applyTrain` makes it. Null for exactly
 * `train` alone and `train <q-…>`, which fall through to the answer path (a question may offer the option `train`); every
 * other line is the command or `refused` with the reason, never prose.
 */
function trainCommand(ledger: Ledger, rest: readonly string[]): Command | null {
	if (rest.length === 0 || (rest.length === 1 && /^q-/i.test(rest[0]!))) return null;
	const first = rest[0]!.replace(/,+$/, "");
	const wl = /^wl-/i.test(first) ? first : null;
	const tokens = (wl === null ? rest : rest.slice(1)).join(" ").split(/[\s,]+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return { kind: "refused", why: `train names at least one PR number: ${TRAIN_USAGE}` };
	const bad = tokens.find((t) => !/^#?[1-9]\d*$/.test(t) || !Number.isSafeInteger(Number(t.replace(/^#/, ""))));
	if (bad !== undefined) return { kind: "refused", why: `${bad} is not a PR number (a positive whole number, # allowed): ${TRAIN_USAGE}` };
	const prs = [...new Set(tokens.map((t) => Number(t.replace(/^#/, ""))))];
	if (prs.length > TEST_PR_MAX) return { kind: "refused", why: `train takes at most ${TEST_PR_MAX} PRs at once; ${prs.length} named` };
	if (wl === null) {
		const train = theTrain(ledger);
		const why = train === null ? null : trainAppendRefusal(ledger, train, prs);
		return why === null ? { kind: "train", prs } : { kind: "refused", why };
	}
	const why = trainAppendRefusal(ledger, wl, prs);
	return why === null ? { kind: "train-append", workloadId: wl, prs } : { kind: "refused", why };
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
 * The live test run on slice `id` (on `wl`), or undefined: a run is live by `runLive` (via `recordLive`: no result,
 * and a heartbeat under 60 s old or, before its first heartbeat, a request under 120 s old).
 */
function liveRunOn(ledger: Ledger, wl: string, id: string, heartbeatOf: HeartbeatOf): RunRecord | undefined {
	const nowMs = Date.parse(ledger.now());
	return testRuns(ledger.entries(wl)).find((r) => r.request.slice === id && recordLive(r, heartbeatOf(r.request.runId), nowMs));
}

/**
 * Why a live test run on slice `id` (on `wl`, `liveRunOn`) holds `cancel-slice` off (D1), or null. `apply` checks
 * it again inside its transaction, since a `test-requested:` can land between the word's reading and its apply.
 */
function liveRunRefusal(ledger: Ledger, wl: string, id: string, heartbeatOf: HeartbeatOf): string | null {
	const live = liveRunOn(ledger, wl, id, heartbeatOf);
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

/**
 * Why `supersede <a> <b>` cannot apply (D2), or null: A is an open workload other than the standing one and not the merge
 * train (permanent, PLAN wl-mvr888nftz0vcl D3), B exists, and they differ. `apply` checks it again.
 */
function supersedeRefusal(ledger: Ledger, a: string, b: string): string | null {
	if (a === b) return `${a} cannot supersede itself`;
	if (a === STANDING_WORKLOAD_ID || b === STANDING_WORKLOAD_ID) return "the standing workload is never superseded nor a successor";
	const wa = ledger.workload(a);
	if (!wa) return `no workload ${a}`;
	if (wa.status !== "open") return `${a} is ${wa.status}: only an open workload is superseded`;
	const permanent = trainPermanentRefusal(ledger, a);
	if (permanent !== null) return permanent;
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
 * Why `withdraw <wl>` cannot withdraw the workload as the ledger stands (PLAN wl-mv8s939084z1ts D2), or null: it exists,
 * is not the standing workload, is open, is no scheduled `due:` row (closed with its receipt through the close tool),
 * has no open or paused slice and no open question (one refusal names every one: a question always pauses its slice), and
 * no holder holds it under a live lease. Done and cancelled slices are both allowed, and so is no slice at all. `apply`
 * checks it again inside its transaction.
 */
function withdrawRefusal(ledger: Ledger, wl: string): string | null {
	if (wl === STANDING_WORKLOAD_ID) return "the standing workload is never withdrawn";
	const w = ledger.workload(wl);
	if (!w) return `no workload ${wl}`;
	if (w.status !== "open") return `${wl} is ${w.status}: only an open workload is withdrawn`;
	// PLAN wl-mvr888nftz0vcl D3: the merge train is permanent.
	const permanent = trainPermanentRefusal(ledger, wl);
	if (permanent !== null) return permanent;
	if (w.brief.startsWith(DUE_PREFIX)) return `${wl} is a scheduled row: close it with its receipt through the close tool`;
	const live = ledger.slices(wl).filter((s) => s.state === "open" || s.state === "paused").map((s) => `${s.id} (${s.state})`);
	const asked = ledger.questions(wl).filter((q) => q.state === "open").map((q) => q.id);
	if (live.length > 0 || asked.length > 0) {
		const questions = asked.length === 0 ? [] : [`open question${asked.length === 1 ? "" : "s"} ${asked.join(", ")}`];
		const what = [...(live.length === 0 ? [] : [live.join(", ")]), ...questions].join(" and ");
		return `${wl} has ${what}: cancel-slice each first (it withdraws the slice's questions too); only a workload with no open or paused slice and no open question is withdrawn`;
	}
	if (heldLive(w, ledger.now())) return `${wl} is held by ${w.holder} under a live lease: stop it first (as2 lane stop ${wl})`;
	return null;
}

/** `withdraw <wl-…>` after the word (PLAN wl-mv8s939084z1ts D1): exactly one workload id, `withdrawRefusal` clear; anything else is `refused` with the reason, never prose. */
function withdrawWorkloadCommand(ledger: Ledger, rest: readonly string[]): Command {
	if (rest.length !== 1 || !/^wl-\S+$/i.test(rest[0]!)) return { kind: "refused", why: "withdraw names one workload: withdraw wl-…" };
	const wl = rest[0]!;
	const why = withdrawRefusal(ledger, wl);
	return why === null ? { kind: "withdraw-workload", workloadId: wl } : { kind: "refused", why };
}

/** Why `end-ruling <id>` cannot apply, or null: the id names a standing ruling Jo has not ended. `apply` checks it again. */
function endRulingRefusal(ledger: Ledger, id: string): string | null {
	if (!isRulingId(id)) return `${id} is no standing ruling (${STANDING_RULINGS.map((r) => r.id).join(", ")})`;
	return endedRulings(ledger.instructions(STANDING_WORKLOAD_ID)).has(id) ? `the ruling ${id} is already ended` : null;
}

/** `end-ruling <ruling-id>` after the word: one id, `endRulingRefusal` clear; anything else is `refused` with the reason, never prose. */
function endRulingCommand(ledger: Ledger, rest: readonly string[]): Command {
	if (rest.length !== 1) return { kind: "refused", why: `end-ruling names one ruling: end-ruling <${STANDING_RULINGS.map((r) => r.id).join(" | ")}>` };
	const id = rest[0]!.toLowerCase();
	const why = endRulingRefusal(ledger, id);
	return why === null ? { kind: "end-ruling", ruling: id as RulingId } : { kind: "refused", why };
}

/** Why `land-first <repo> on` cannot apply, or null: § 2's bootstrap holds (`bootstrapRefusal`). `off` always applies. `apply` checks it again. */
function landFirstRefusal(ledger: Ledger, repo: string, on: boolean): string | null {
	if (!on) return null;
	const reasons = bootstrapRefusal(ledger.entries(STANDING_WORKLOAD_ID));
	return reasons.length === 0 ? null : `land-first ${repo} on waits for the bootstrap (PLAN wl-mvq4edbaf13vnk § 2): ${reasons.join("; ")}`;
}

/** `land-first <repo> on|off` after the word: a repository and `on` or `off`, `landFirstRefusal` clear; anything else is `refused` with the reason, never prose. */
function landFirstCommand(ledger: Ledger, rest: readonly string[]): Command {
	const state = rest[1]?.toLowerCase();
	if (rest.length !== 2 || !REPO_WORD_RE.test(rest[0]!) || (state !== "on" && state !== "off")) {
		return { kind: "refused", why: `${LAND_FIRST_WORD} names one repository and on or off: ${LAND_FIRST_WORD} <repo> on|off` };
	}
	const why = landFirstRefusal(ledger, rest[0]!, state === "on");
	return why === null ? { kind: "land-first", repo: rest[0]!, on: state === "on" } : { kind: "refused", why };
}

/** `main-retry <repo>` after the word: one repository; anything else is `refused` with the reason, never prose. */
function mainRetryCommand(rest: readonly string[]): Command {
	if (rest.length !== 1 || !REPO_WORD_RE.test(rest[0]!)) return { kind: "refused", why: `${MAIN_RETRY_WORD} names one repository: ${MAIN_RETRY_WORD} <repo>` };
	return { kind: "main-retry", repo: rest[0]! };
}

/** Jo's word that halts a workload's plan (PLAN wl-mvfkv7llkp7nk0 § 3). */
export const HALT_WORD = "halt";

/** Why `halt <wl>` cannot apply, or null: an open workload other than the standing one whose newest `plan:` entry is not `halted`. `apply` checks it again. */
function haltRefusal(ledger: Ledger, wl: string): string | null {
	if (wl === STANDING_WORKLOAD_ID || !workloadsInView(ledger).includes(wl)) return `${wl} is not an open workload`;
	const plan = controlOf(ledger, wl)?.filter((c) => c.prefix === "plan").at(-1);
	return plan !== undefined && /^halted\b/.test(plan.rest) ? `${wl} is already halted; approve its next plan question to start it again` : null;
}

/** `halt <wl-…>`: the command when `haltRefusal` is clear, else `refused` with the reason, never prose. */
function haltCommand(ledger: Ledger, wl: string): Command {
	const why = haltRefusal(ledger, wl);
	return why === null ? { kind: "halt", workloadId: wl } : { kind: "refused", why };
}

/** Jo's word that raises a workload's ceiling by one block of its own size (PLAN wl-mvfkv7llkp7nk0 § 4). */
export const EXTEND_WORD = "extend";

/** `extend <wl-…>`: the command on an open workload other than the standing one, else `refused`, never prose. */
function extendCommand(ledger: Ledger, wl: string): Command {
	if (!workloadsInView(ledger).includes(wl)) return { kind: "refused", why: `${wl} is not an open workload` };
	// PLAN wl-mvr888nftz0vcl D4: the merge train has no ceiling to extend; nothing is written.
	const why = trainNoWallRefusal(ledger, wl);
	return why === null ? { kind: "extend", workloadId: wl } : { kind: "refused", why };
}

/** Jo's word that raises the merge train's limit for a paused PDT day (PLAN wl-mvr888nftz0vcl D7). */
export const RAISE_WORD = "raise";

/**
 * The pause question `q` asks about (D7), or null: `q` is a question the train tick (MERGE_TRAIN_BY) raised on a merge train
 * on the budget slice of one of the train's runner-written `train-paused:` entries (`trainBudgetSliceId`). The meter-error
 * question shares the slice shape but is keyed to a `train-meter-error:` entry, so it is never one.
 */
export function budgetPauseOf(ledger: Ledger, q: Pick<QuestionRow, "workload_id" | "slice_id" | "created_by">): TrainPause | null {
	if (q.created_by !== MERGE_TRAIN_BY || !isTrain(ledger, q.workload_id)) return null;
	return trainPauses(controlEntries(ledger.entries(q.workload_id, "assumption"))).find((p) => trainBudgetSliceId(q.workload_id, p.entryId) === q.slice_id) ?? null;
}

/** The refusal of `raise` with no amount on budget pause question `q` (D7): the option word alone carries no amount. */
function bareRaiseRefusal(q: string): string {
	return `${q} is the merge train's budget question: \`raise\` alone carries no amount; type \`raise <usd>\`, for example \`raise 50\` (or \`raise 50 ${q}\`), or answer \`wait\``;
}

/** Why a raise on budget pause question `q` (pause `p`) cannot apply now (D7), or null: the question is open and its pause's PDT day is today. */
function raiseRefusal(ledger: Ledger, q: Pick<QuestionRow, "id" | "state">, p: TrainPause): string | null {
	if (q.state !== "open") return `${q.id} is ${q.state}: a raise answers only an open budget question`;
	const today = pdtDay(Date.parse(ledger.now()));
	if (p.day !== today) return `the paused day ${p.day} (PDT) is over (today is ${today}): a raise adds money only to the day it names; answer \`wait ${q.id}\` instead`;
	return null;
}

/**
 * `raise …` after the word (D7, R26), scoped to budget pause questions (`budgetPauseOf`); null falls through to the answer path,
 * so `raise` and `raise q-…` keep answering any other question that offers `raise` (R28), and `raise fifty` stays prose.
 * - no argument: `refused` (`bareRaiseRefusal`) when a budget question is open and no other open question offers `raise`;
 * - `raise <q-…>`: `refused` when that question is a budget question;
 * - `raise <amount> [q-…]`, the amount any token that starts like a number (`50`, `$50`, `-5`, `.5`, `1e3`): the command when the
 *   amount is a plain positive number of dollars (a leading `$` allowed, as `ceiling` takes it), the third word if any is a
 *   question id, the named question (or the only open budget question) is a budget question, and `raiseRefusal` is clear.
 *   Several open budget questions and none named is `ambiguous`; anything else is `refused`, never prose.
 */
function raiseCommand(ledger: Ledger, rest: readonly string[]): Command | null {
	const open = ledger.inFlight().flatMap((w) => w.openQuestions);
	const budget = open.filter((q) => budgetPauseOf(ledger, q) !== null);
	if (rest.length === 0) {
		const others = open.some((q) => budgetPauseOf(ledger, q) === null && q.options.some((o) => o.toLowerCase() === RAISE_WORD));
		return budget.length > 0 && !others ? { kind: "refused", why: bareRaiseRefusal(budget.length === 1 ? budget[0]!.id : "q-…") } : null;
	}
	if (rest.length === 1 && /^q-/i.test(rest[0]!)) {
		const named = budget.find((q) => q.id === rest[0]);
		return named ? { kind: "refused", why: bareRaiseRefusal(named.id) } : null;
	}
	if (!/^[$+-]?\.?\d/.test(rest[0]!)) return null;
	const usage = "raise <usd> [q-…], for example `raise 50`";
	if (rest.length > 2 || (rest.length === 2 && !/^q-/i.test(rest[1]!))) return { kind: "refused", why: `the raise word is ${usage}` };
	const m = /^\$?(\d+(?:\.\d+)?)$/.exec(rest[0]!);
	const usd = m ? Number(m[1]) : Number.NaN;
	if (!Number.isFinite(usd) || usd <= 0) return { kind: "refused", why: `${rest[0]} is not a positive number of dollars: ${usage}` };
	let q: (typeof open)[number] | undefined;
	if (rest.length === 2) {
		q = open.find((x) => x.id === rest[1]);
		if (!q) return { kind: "refused", why: `${rest[1]} is not an open question` };
		if (!budget.includes(q)) return { kind: "refused", why: `${q.id} is not the merge train's budget question; \`raise <usd>\` answers only that one` };
	} else {
		if (budget.length === 0) return { kind: "refused", why: "no merge-train budget question is open: a raise answers the train's pause question, and the train is not paused" };
		if (budget.length > 1) return { kind: "ambiguous", word: [RAISE_WORD, ...rest].join(" "), candidates: budget.map((x) => ({ kind: "question", workloadId: x.workload_id, rowId: x.id })) };
		q = budget[0]!;
	}
	const why = raiseRefusal(ledger, q, budgetPauseOf(ledger, q)!);
	return why === null ? { kind: "raise", workloadId: q.workload_id, questionId: q.id, usd } : { kind: "refused", why };
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
 * Cancel slice `sl` on `wl` inside the caller's transaction (cancel-slice's writer): every open question on it
 * withdrawn as Jo with `then cancel` and `reason` (the `withdraw` word's ledger call), then the slice cancelled
 * (`Ledger.cancelSlice`) unless the last withdrawal's cancel already did it. Returns the withdrawn questions and
 * one receipt piece per withdrawal.
 */
function cancelSliceRows(ledger: Ledger, wl: string, sl: string, reason: string): { withdrawn: QuestionRow[]; lines: string[] } {
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	const withdrawn = ledger.questions(wl).filter((q) => q.slice_id === sl && q.state === "open");
	const lines = withdrawn.map((q) => `withdrew ${q.id} (withdrawal ${ledger.withdrawQuestion(q.id, { ...stamp, reason, then: "cancel" })}, then cancel)`);
	if (ledger.slice(sl)!.state !== "cancelled") ledger.cancelSlice(sl, { by: SURFACE_BY });
	return { withdrawn, lines };
}

/**
 * After a cancel that settled `questions`: when one was raised by a launched lane and no lane holds `wl` live, Jo's
 * `launch-requested:` (`raiseCeiling`'s request), since a cancelled slice is no resolution a parked lane resumes on
 * (`resolutions`). Returns the receipt tail.
 */
function relaunchAfterCancel(ledger: Ledger, wl: string, questions: readonly QuestionRow[], reason: string): string {
	const w = ledger.workload(wl)!;
	const launched = new Set(attempts(controlEntries(ledger.entries(wl))).map((a) => a.laneId));
	if (!questions.some((q) => launched.has(q.created_by)) || w.mode !== "autonomous" || heldLive(w, ledger.now())) return "";
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), reason) });
	return "; no lane holds it live, so a relaunch is requested";
}

/**
 * `cancel-slice` applied (D1), inside one transaction: `sliceStateRefusal` and `liveRunRefusal`
 * checked again (each throws, writing nothing), Jo's instruction on the slice, then the slice
 * cancelled with its open questions withdrawn naming the instruction (`cancelSliceRows`), and Jo's
 * `launch-requested:` when a withdrawn question was a launched lane's (`relaunchAfterCancel`).
 * Returns the receipt.
 */
function cancelSlice(ledger: Ledger, cmd: Extract<Command, { kind: "cancel-slice" }>, heartbeatOf: HeartbeatOf): string {
	const { workloadId: wl, sliceId: sl } = cmd;
	const why = sliceStateRefusal(ledger, sl) ?? liveRunRefusal(ledger, wl, sl, heartbeatOf);
	if (why !== null) throw new Error(why);
	const id = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: wl, sliceId: sl, body: `cancel-slice ${sl}` });
	const { withdrawn, lines } = cancelSliceRows(ledger, wl, sl, `cancel-slice (instruction ${id})`);
	const relaunch = relaunchAfterCancel(ledger, wl, withdrawn, `cancel-slice ${sl}`);
	return [`cancelled slice ${sl} on ${wl} (instruction ${id})`, ...lines].join("; ") + relaunch;
}

/**
 * The skip close (PLAN wl-mv8s8srodefytc § 1), inside the transaction of Jo's answer `answerId` to `q`: when the
 * answer is `skip`, `q` sits on a train slice of PR n (`trainSlicePr`) and its workload carries a valid `train:`
 * entry, every open or paused slice of n's current attempt (`currentAttemptSlice`: its disposition slice and every full-suite
 * slice of it, lane decision en-mvznmxcdh0ucsj) is cancelled
 * with cancel-slice's writer, citing the answer, so a skipped red PR leaves nothing open; a lane parked on `q`
 * relaunches as after `cancel-slice`. A slice whose test run is live (`liveRunOn`, cancel-slice's refusal, read with
 * `heartbeatOf`) is kept open and named, since its `test-run:` settles it; the skip itself is never refused. Returns
 * the receipt tail; "" (nothing written) on any other question.
 */
function trainSkipClose(ledger: Ledger, q: QuestionRow, answerId: string, heartbeatOf: HeartbeatOf): string {
	const wl = q.workload_id;
	const n = trainSlicePr(q.slice_id, wl);
	if (n === null || trainPrs(ledger.entries(wl), ledger.instructions(wl)).length === 0) return "";
	// A cancelled slice is no resolution a lane parked on a question there resumes on (`resolutions` needs it open): the withdrawn
	// questions, and `q` itself when its own slice is cancelled, count for a relaunch. When q's slice is kept open (a live run), Jo's
	// answer is a normal resolution and q stays out.
	const settled: QuestionRow[] = [];
	const attempts = trainAttemptsOf(ledger, wl);
	const open = ledger.slices(wl).filter((s) => currentAttemptSlice(s.id, wl, attempts, n) && (s.state === "open" || s.state === "paused"));
	const lines = open.flatMap((s) => {
		const live = liveRunOn(ledger, wl, s.id, heartbeatOf);
		if (live) return [`kept ${s.id} open: test run ${live.request.runId} is live; it settles the slice`];
		const r = cancelSliceRows(ledger, wl, s.id, `skip on the merge train (answer ${answerId})`);
		if (s.id === q.slice_id) settled.push(q);
		settled.push(...r.withdrawn);
		return [`cancelled ${s.id}`, ...r.lines];
	});
	const relaunch = relaunchAfterCancel(ledger, wl, settled, `train skip #${n}`);
	return `; merge train: Jo skipped #${n}${lines.length > 0 ? `: ${lines.join(", ")}` : "; no train slice of it is open"}${relaunch}`;
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

/** Jo's instruction a raise names, for the `ceiling` and `extend` words alike: `ceiling: <usd> <hours>`, hours to two places. */
function ceilingInstructionBody(c: Ceiling): string {
	return `ceiling: ${c.usd} ${Number((c.wallMin / 60).toFixed(2))}`;
}

/**
 * Raise the ceiling to `next` on Jo's instruction `instructionId` (the `ceiling` and `extend` words, PLAN
 * wl-mvfkv7llkp7nk0 § 4), inside the caller's transaction: the `ceiling:` entry naming the instruction, then the relaunch
 * rule both words share. Jo's `launch-requested:` (the body the launch tool writes, cause `why`) is written when the
 * workload's newest lane was stopped at the ceiling (its `lane-stop: <lane> accepted ceiling`, whether it is still
 * stopping or gone), the workload is autonomous, the lane's last `spend:` is under `next` in both halves, and no
 * unconsumed request already waits; so that lane relaunches once its lease is gone. Otherwise nothing is requested: a
 * live holder not stopped at the ceiling reads the new value at its next poll and goes on, and a request written with
 * no lane stopped at the ceiling would outlive the raise and relaunch a finished workload. The runner reads the ceiling
 * and accepts its ceiling stop in one transaction (surface/scripts/lane.ts `meterPoll`) and this check runs in the
 * caller's, so a raise either lands first and the lane goes on, or sees the accepted stop here. Returns the receipt tail,
 * naming which case it was.
 */
function raiseCeiling(ledger: Ledger, wl: string, next: Ceiling, source: string, instructionId: string, why: string): string {
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody(next, source, instructionId) });
	const w = ledger.workload(wl)!;
	const live = w.holder !== null && heldLive(w, ledger.now());
	const control = controlOf(ledger, wl) ?? [];
	const tried = attempts(control);
	const lane = tried.at(-1)?.laneId;
	const mine = control.filter((c) => c.laneId === lane);
	if (lane === undefined || !mine.some((c) => c.prefix === "lane-stop" && /^accepted ceiling\b/.test(c.rest))) {
		return live && w.holder!.startsWith("lane-") ? `; ${w.holder} still holds it and goes on under it` : "";
	}
	const stopped = `${lane} ${live && w.holder === lane ? "is stopping" : "stopped"} at the ceiling`;
	if (w.mode !== "autonomous") return `; ${stopped} and ${wl} is ${w.mode}, so nothing relaunches`;
	const spent = mine.filter((c) => c.prefix === "spend").map((c) => parseSpend(c.rest)).filter((s) => s !== null).at(-1);
	if (spent && crossed(spent, next) === 100) {
		return `; ${stopped} and its spend ($${spent.usd.toFixed(2)} / ${Math.round(spent.wallMin)} min) still reaches ${ceilingText(next)}, so nothing relaunches`;
	}
	const consumed = consumedIds(tried);
	if (control.some((c) => c.prefix === "launch-requested" && !consumed.has(c.id))) return `; ${stopped} and a relaunch is already requested`;
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), why) });
	return `; ${stopped}, so a relaunch is requested`;
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
 * The valid `pair` offer of `q` (PLAN wl-mv67564rdkfvnk D9 (3); PLAN wl-mvb9mw00ycfjeo D2, D3), else null: `pair` is among
 * its options, it is the classifier's round-limit question, and a `pair-offer:` naming it at that site carries the
 * classifier's stamp. The site, and the signals of the newest such entry (what every render's offer line names).
 * `applyPair` refuses on null, and every render of a question shows the offer line only when this is not null.
 */
export function openPairOffer(
	ledger: Ledger,
	q: Pick<QuestionRow, "id" | "workload_id" | "slice_id" | "created_by"> & { options: readonly string[] },
): { site: PairSite; signals: string[] } | null {
	if (!q.options.some((o) => o.toLowerCase() === PAIR_OPTION) || !isReviewLimitQuestion(ledger, q)) return null;
	const offer = ledger.entries(q.workload_id, "assumption").flatMap((e) => {
		const o = e.created_by === CLASSIFIER_BY ? parsePairOffer(e.body) : null;
		return o !== null && o.questionId === q.id ? [o] : [];
	}).at(-1);
	return offer ? { site: offer.site, signals: offer.signals } : null;
}

/**
 * What a question takes, as the typed-input refusals list it (D2): its options less `pair`, then `withdraw`; and `after`,
 * the offer line on its own line (`\n` first) when the offer is valid, else empty, for the refusal to end with.
 */
function takesOf(ledger: Ledger, q: Pick<QuestionRow, "id" | "workload_id" | "slice_id" | "created_by"> & { options: readonly string[] }): { takes: string; after: string } {
	const offer = openPairOffer(ledger, q);
	const takes = [...shownOptions(q.options), "withdraw"].join(" / ");
	return { takes, after: offer ? `\n${pairOfferLine(wordsOf(ledger, q.workload_id), q.id, q.workload_id, offer.signals)}` : "" };
}

/**
 * Jo's `pair` on an offered question (D7), in one transaction: the answer; the settlement `stop` writes (the round
 * limit's `review-loop-end: <sl> reason stop`); the flip to user-driven as Jo via the surface; `pair-taken:`; and the
 * `lane-stop:` request a live lane holder accepts. A question with no valid offer is refused naming it, and nothing is
 * written. The receipt (PLAN
 * wl-mvb9mw00ycfjeo D6) ends on the line `in another terminal:` (after `when the lane has stopped (a few seconds), `
 * when a stop was requested: its lease must lapse before `as2 lane` is admitted) and then a line that is exactly the
 * by-hand command; the surface adds the clipboard line after it (surface/extensions/surface-input.ts).
 */
function applyPair(ledger: Ledger, q: QuestionRow, answer: string): string {
	const offer = openPairOffer(ledger, { ...q, options: JSON.parse(q.options) as string[] });
	if (offer === null) throw new Error(`${q.id} does not offer pair: no pair-offer: from its raiser names it at its site; refused, never applied`);
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	return ledger.write(() => {
		const answerId = ledger.answerQuestion(q.id, { ...stamp, answer });
		const settled = settleReviewLimit(ledger, q, "stop", answerId);
		const flip = ledger.flipMode(q.workload_id, { ...stamp, mode: "user-driven" });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: q.workload_id, kind: "assumption", body: pairTakenBody(q.id, answerId) });
		const stop = modeFlipControl(ledger, q.workload_id, "user-driven");
		const wait = stop === "" ? "" : "when the lane has stopped (a few seconds), ";
		return `answered ${q.id} with "${answer}" (answer ${answerId})${settled}; mode on ${q.workload_id} → user-driven (mode-flip ${flip})${stop}\n${wait}in another terminal:\n${byHandLine(q.workload_id)}`;
	});
}

/**
 * Apply a command through the ledger module as Jo via the surface. Returns the one-line receipt.
 * `heartbeatOf` is the run heartbeat reader `cancel-slice` re-checks its live-run refusal with, and a
 * train `skip` keeps a slice with a live run open by; pass the one `interpret` was given.
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
			// D5 (PLAN wl-mvr888nftz0vcl): checked again inside the flip's transaction; the merge train runs autonomous only.
			return ledger.write(() => {
				const why = cmd.mode === "user-driven" ? trainAutonomousRefusal(ledger, cmd.workloadId) : null;
				if (why !== null) throw new Error(`${why}; refused, never applied`);
				const id = ledger.flipMode(cmd.workloadId, { ...stamp, mode: cmd.mode });
				return `mode on ${cmd.workloadId} → ${cmd.mode} (mode-flip ${id}; effective before the lane's next turn)`;
			});
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
			// PLAN wl-mvr888nftz0vcl D7: `raise` with no amount never answers a budget pause question, whatever route built the answer.
			if (word === RAISE_WORD && budgetPauseOf(ledger, q0) !== null) throw new Error(`${bareRaiseRefusal(q0.id)}; refused, never applied`);
			// D4: *approve* on any other question while `plan: first` stands unapproved approves nothing, and the receipt says so.
			const notPlan = !plan && word === "approve" && planFirst(controlOf(ledger, q0.workload_id) ?? []) !== null;
			const roundLimit = (ROUND_LIMIT_OPTIONS as readonly string[]).includes(word) && isReviewLimitQuestion(ledger, q0);
			if (plan && word === "cancel") {
				const id = ledger.withdrawQuestion(cmd.questionId, { ...stamp, reason: "plan cancelled from the surface", then: "cancel" });
				return `cancelled the plan: withdrew ${cmd.questionId} (withdrawal ${id}); slice ${q0.slice_id} is ${ledger.slice(q0.slice_id)?.state ?? "unknown"}`;
			}
			let tail = "";
			const id = ledger.write(() => {
				const answerId = ledger.answerQuestion(cmd.questionId, { ...stamp, answer: cmd.answer });
				if (plan && word === "approve") ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: planApprovedBody(answerId) });
				if (roundLimit) tail = settleReviewLimit(ledger, q0, word as RoundLimitOption, answerId);
				if (word === "skip") tail += trainSkipClose(ledger, q0, answerId, heartbeatOf);
				return answerId;
			});
			const slice = ledger.slice(q0.slice_id);
			const approved = plan && word === "approve" ? "; plan approved: change slices may now be added" : notPlan ? "; not the plan question: no plan approval written" : "";
			return `answered ${cmd.questionId} with "${cmd.answer}" (answer ${id}); slice ${q0.slice_id} is ${slice?.state ?? "unknown"}${approved}${tail}`;
		}
		case "withdraw": {
			// The standing slice is never cancelled (item 105), and no other question's withdrawal cancels: every one replans.
			const id = ledger.withdrawQuestion(cmd.questionId, { ...stamp, reason: "withdrawn from the surface", then: "replan" });
			const q = ledger.question(cmd.questionId)!;
			const slice = ledger.slice(q.slice_id);
			if (cmd.workloadId === STANDING_WORKLOAD_ID) return `withdrew the orchestrator's ${cmd.questionId} (withdrawal ${id}, then replan); the standing slice stays ${slice?.state ?? "unknown"}`;
			return `withdrew ${cmd.questionId} (withdrawal ${id}, then replan); slice ${q.slice_id} is ${slice?.state ?? "unknown"}: replanned, not executed`;
		}
		case "reserved": {
			const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: `${cmd.verdict} ${cmd.entryId}` });
			return `${cmd.verdict === "approve" ? "approved" : "denied"} reserved request ${cmd.entryId} (instruction ${id})`;
		}
		case "ceiling": {
			// Jo's exact figure (§ 1 D): the instruction, then the entry naming it; omitted hours keep the wall in force.
			return ledger.write(() => {
				const train = trainNoWallRefusal(ledger, cmd.workloadId);
				if (train !== null) throw new Error(`${train}; refused, never applied`);
				const next = { usd: cmd.usd, wallMin: cmd.wallMin ?? ceilingOf(ledger, cmd.workloadId).wallMin };
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: ceilingInstructionBody(next) });
				const tail = raiseCeiling(ledger, cmd.workloadId, next, "your word", id, "ceiling word");
				return `ceiling on ${cmd.workloadId} → ${ceilingText(next)} (instruction ${id})${tail}`;
			});
		}
		case "extend": {
			// One more block of the workload's own size on the value in force (PLAN wl-mvfkv7llkp7nk0 § 4), shaped like the ceiling word.
			return ledger.write(() => {
				const train = trainNoWallRefusal(ledger, cmd.workloadId);
				if (train !== null) throw new Error(`${train}; refused, never applied`);
				const w = ledger.workload(cmd.workloadId)!;
				const block = sizeFor(w.stakes, judgedKindOf(ledger, cmd.workloadId));
				const cur = ceilingOf(ledger, cmd.workloadId);
				const next = { usd: cur.usd + block.usd, wallMin: cur.wallMin + block.wallMin };
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: ceilingInstructionBody(next) });
				const tail = raiseCeiling(ledger, cmd.workloadId, next, EXTEND_SOURCE, id, "ceiling extend");
				return `ceiling on ${cmd.workloadId} extended by ${ceilingText(block)} → ${ceilingText(next)} (instruction ${id})${tail}`;
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
				const why = prWordRefusal(ledger, "test-pr", cmd.workloadId);
				if (why !== null) throw new Error(why);
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: testPrInstructionBody(cmd.workloadId, cmd.prs) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: testPrBody(cmd.prs, id) });
				const prs = cmd.prs.map((n) => `#${n}`).join(", ");
				return `${cmd.prs.length === 1 ? "PR" : "PRs"} ${prs} bound to ${cmd.workloadId} for test runs with no push (instruction ${id})`;
			});
		}
		case "waive-pr": {
			// Jo's instruction first, then the surface's `waive-pr:` naming it, in one transaction; the close check reads both (`waivedPrs`).
			return ledger.write(() => {
				const why = prWordRefusal(ledger, "waive-pr", cmd.workloadId);
				if (why !== null) throw new Error(why);
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: waivePrInstructionBody(cmd.workloadId, cmd.prs) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: waivePrBody(cmd.prs, id) });
				const prs = cmd.prs.map((n) => `#${n}`).join(", ");
				return `${cmd.prs.length === 1 ? "PR" : "PRs"} ${prs} waived on ${cmd.workloadId} for the close check (instruction ${id})`;
			});
		}
		case "train":
			throw new Error("train opens a workload in the surface's repo: applyTrain applies it, never apply");
		case "train-append":
			// Jo's instruction first, then the surface's `train:` naming it, in one transaction; a train no lane holds live relaunches.
			return ledger.write(() => appendTrain(ledger, cmd.workloadId, cmd.prs));
		case "end-ruling": {
			// Jo's instruction on the standing workload is the end (`endedRulings`); nothing else is written.
			return ledger.write(() => {
				const why = endRulingRefusal(ledger, cmd.ruling);
				if (why !== null) throw new Error(why);
				ensureStandingWorkload(ledger);
				const id = ledger.recordInstruction({ ...stamp, workloadId: STANDING_WORKLOAD_ID, body: endRulingBody(cmd.ruling) });
				return `Jo's ruling ${cmd.ruling} is ended (instruction ${id}); its questions go to you again`;
			});
		}
		case "land-first": {
			// Raw word and pending off marker commit together; acknowledgement is not revocation completion.
			return ledger.write(() => {
				const why = landFirstRefusal(ledger, cmd.repo, cmd.on);
				if (why !== null) throw new Error(why);
				ensureStandingWorkload(ledger);
				const id = ledger.recordInstruction({ ...stamp, workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(cmd.repo, cmd.on) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(cmd.repo, cmd.on, id) });
				if (!cmd.on) ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody(cmd.repo, "pending", id) });
				const pending = landFirstOffPending(ledger.entries(STANDING_WORKLOAD_ID), ledger.instructions(STANDING_WORKLOAD_ID), cmd.repo);
				if (pending.length > 0) return `land-first ${cmd.on ? "on" : "off"} requested for ${cmd.repo} (instruction ${id}); off reconciliation pending: merges held until the tick revokes fast/tree successes`;
				return `land-first is on for ${cmd.repo} (instruction ${id})`;
			});
		}
		case "main-retry": {
			// Jo's instruction, then the surface's `main-retry:` naming it, on the standing workload in one transaction (`mainRetries`).
			return ledger.write(() => {
				ensureStandingWorkload(ledger);
				const id = ledger.recordInstruction({ ...stamp, workloadId: STANDING_WORKLOAD_ID, body: mainRetryInstructionBody(cmd.repo) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: mainRetryBody(cmd.repo, id) });
				return `main runs of ${cmd.repo} may retry: an exhausted main commit's next block of 3 attempts is open (instruction ${id})`;
			});
		}
		case "halt": {
			// Jo's instruction, the surface's `plan: halted <instruction>`, and a stop request to a lane holding it live, in one write.
			return ledger.write(() => {
				const why = haltRefusal(ledger, cmd.workloadId);
				if (why !== null) throw new Error(why);
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: `${HALT_WORD} ${cmd.workloadId}` });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: planHaltedBody(id) });
				const w = ledger.workload(cmd.workloadId)!;
				let stop = "";
				if (w.holder?.startsWith("lane-") && heldLive(w, ledger.now())) {
					ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: laneStopRequestBody(w.holder, HALT_WORD, "jo") });
					stop = `; stop requested of ${w.holder} (it accepts at its next poll)`;
				}
				return `${cmd.workloadId} is halted (instruction ${id}): its plan needs your approve again, change slices are refused and the train holds its PRs${stop}`;
			});
		}
		case "withdraw-workload": {
			// PLAN wl-mv8s939084z1ts D2, D3: refusal re-checked, then Jo's instruction and the surface's `withdrawn:` naming it, in one
			// transaction; the close reads both (`withdrawnBy`) in place of a done-because: receipt.
			return ledger.write(() => {
				const why = withdrawRefusal(ledger, cmd.workloadId);
				if (why !== null) throw new Error(why);
				const id = ledger.recordInstruction({ ...stamp, workloadId: cmd.workloadId, body: withdrawInstructionBody(cmd.workloadId) });
				ledger.recordEntry({ by: SURFACE_BY, workloadId: cmd.workloadId, kind: "assumption", body: withdrawnBody(id) });
				return `withdrew ${cmd.workloadId} (instruction ${id}); closing it with no done-because: receipt`;
			});
		}
		case "raise": {
			// PLAN wl-mvr888nftz0vcl D7: in one transaction, the question open and its pause's day today checked again (a reading made
			// before midnight never applies a stale raise after it), then Jo's answer `raise` and the surface's `train-raise:` naming it.
			return ledger.write(() => {
				const q = ledger.question(cmd.questionId);
				const p = q ? budgetPauseOf(ledger, q) : null;
				if (!q || !p) throw new Error(`${cmd.questionId} is not the merge train's budget question; refused, never applied`);
				const why = raiseRefusal(ledger, q, p);
				if (why !== null) throw new Error(`${why}; refused, never applied`);
				const answerId = ledger.answerQuestion(q.id, { ...stamp, answer: RAISE_WORD });
				const raiseId = ledger.recordEntry({ by: SURFACE_BY, workloadId: q.workload_id, kind: "assumption", body: trainRaiseBody(p.day, cmd.usd, answerId) });
				const limit = trainDayLimit(controlEntries(ledger.entries(q.workload_id, "assumption")), p.day);
				return `raised merge train ${q.workload_id}'s limit for ${p.day} (PDT) by $${usdText(cmd.usd)} to $${usdText(limit)}: answered ${q.id} with "raise" (answer ${answerId}; train-raise ${raiseId}); the next train tick relaunches it`;
			});
		}
		case "ambiguous":
			throw new Error(`"${cmd.word}" fits ${cmd.candidates.length} rows; an ambiguous word is refused, never applied`);
		case "refused":
			throw new Error(`${cmd.why}; refused, never applied`);
	}
}

/**
 * Add `prs` to merge train `wl` inside the caller's transaction (`train <wl> <N…>`, and `train <N…>` while a train is open):
 * `trainAppendRefusal` checked again, then Jo's instruction `train <wl> <N…>` and the surface's `train:` naming it, and Jo's
 * `launch-requested:` when the train is autonomous and no lane holds it live. A PR whose current attempt on the train is
 * terminal boards its next attempt (lane decision en-mvznmxcdh0ucsj), named in the receipt. Returns the receipt.
 */
function appendTrain(ledger: Ledger, wl: string, prs: readonly number[]): string {
	const why = trainAppendRefusal(ledger, wl, prs);
	if (why !== null) throw new Error(`${why}; refused, never applied`);
	// Read before the write: once the train: row names a PR, its next attempt is the current one.
	const named = prs.map((n) => {
		const a = trainAttemptFor(ledger, wl, n);
		return a.ok && a.attempt > 1 ? `#${n} (attempt ${a.attempt})` : `#${n}`;
	});
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	const id = ledger.recordInstruction({ ...stamp, workloadId: wl, body: trainInstructionBody(wl, prs) });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: trainBody(prs, id) });
	const w = ledger.workload(wl)!;
	let relaunch = "";
	if (w.mode === "autonomous" && !heldLive(w, ledger.now())) {
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), "train append") });
		relaunch = "; no lane holds it live, so a relaunch is requested";
	}
	return `added ${named.join(", ")} to merge train ${wl} (instruction ${id}); order ${trainPrs(ledger.entries(wl), ledger.instructions(wl)).join(", ")}${relaunch}`;
}

/**
 * Jo's `train <N…>` applied (PLAN wl-mv8s8srodefytc § 1; PLAN wl-mvr888nftz0vcl D2), in one transaction, so two openers
 * serialize and the second appends. With the merge train open (`theTrain`) it appends to it (`appendTrain`), after checking
 * that `repo` (the surface's cwd, known only here) is the train's repository (`repoIdentity` of its `repo:` checkout):
 * another repository, or a train with no `repo:` entry, throws naming the train and its repository, writing nothing. With
 * none open it opens the train: the id preallocated (`newId`) so the brief names its slice ids, normal and autonomous with
 * brief `trainBrief(wl, prs)`, its repo `repo`, `done:` TRAIN_DONE, no `plan:` (the procedure is the plan) and no `ceiling:`
 * (a train's ceiling rows are never read, D4); then Jo's instruction `train <wl> <N…>` and the surface's `train:` naming it.
 * Returns the receipt and the train's id, which the routes launch (never parsed back from the receipt).
 */
export function applyTrain(ledger: Ledger, cmd: Extract<Command, { kind: "train" }>, repo: string): { line: string; workloadId: string } {
	return ledger.write(() => {
		const train = theTrain(ledger);
		if (train !== null) {
			const checkout = trainCheckout(ledger, train);
			const prs = cmd.prs.map((n) => `#${n}`).join(", ");
			if (checkout === null) throw new Error(`merge train ${train} records no repository (no repo: entry), so ${prs} cannot be checked against it; nothing was written; refused, never applied`);
			if (repoIdentity(checkout) !== repoIdentity(repo)) {
				throw new Error(`merge train ${train} serves ${checkout} (${repoIdentity(checkout)}), and ${repo} (${repoIdentity(repo)}) is another repository: the one merge train takes PRs of its own repository only, so ${prs} is not added; nothing was written; refused, never applied`);
			}
			return { line: appendTrain(ledger, train, cmd.prs), workloadId: train };
		}
		const wl = newId("workload");
		ledger.openWorkload({ by: SURFACE_BY, id: wl, brief: trainBrief(wl, cmd.prs), stakes: "normal", mode: "autonomous" });
		recordRepo(ledger, wl, repo);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody(TRAIN_DONE) });
		const id = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: wl, body: trainInstructionBody(wl, cmd.prs) });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: trainBody(cmd.prs, id) });
		return { line: `opened merge train ${wl} for ${cmd.prs.map((n) => `#${n}`).join(", ")} (instruction ${id})`, workloadId: wl };
	});
}
