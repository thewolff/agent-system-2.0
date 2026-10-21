// Jo's standing rulings, checked before any question reaches Jo (escalation policy, PLAN
// wl-mvfkv7llkp7nk0 § 1; DRAFT.md § 4 "Already decided", REVIEW.md Appendix A4 for each scope and end).
//
// `askJo` is the one production path to `Ledger.raiseQuestion`. It reads the question's kind off
// its option set (`questionKind`), checks every active ruling (`checkRulings`) and either decides the
// question, writing no question row but a `ruling-applied: <ruling> kind <k> slice <sl> answer <a>`
// entry by the asker, or raises it as before. A ruling comes only from Jo's words and is added only by
// a code change here; it ends at its date, at the event its source names, or at once on Jo's
// `end-ruling <id>` (surface/src/input.ts), an instruction on the standing workload that
// `endedRulings` reads. A ruling decides only its own kind: round-limit, train, plan and
// every other question is `other` and always asks.
//
// Callers pass the facts a scope needs (`RulingFacts`): the classifier its R1–R5 verdict for a park
// (classifier/extension.ts), a lane the workload's builders, stakes and train flag
// (surface/extensions/lane-tools.ts), the orchestrator the workload its ask is about
// (surface/src/orchestrator-question.ts). surface/scripts/invariants.ts `ruling-miss` replays the
// same check over question rows to catch a raise path that bypassed it.
//
// Phase 2 (PLAN wl-mvg1vs0rhnu3gg § 1.0, § 1.9, § 3.5): before the rulings, an ask whose identity (workload, slice,
// body, options and, for the orchestrator, the `about` workload of the open question's `question-about:` entry) equals
// an open question's is not raised again: it returns that id as reused and writes nothing, except one `now:` mark when
// the repeat carries `now` and the open one has none. A model-subject question is never deduplicated (no row records
// its subject). An ask with `now` (one of `NOW_CATEGORIES`) skips every ruling and is raised with ESCALATION_BY's
// `now: <q-…> <category>` in the same write. Two or more active rulings that decide one question with different
// answers decide nothing: the question is raised with ESCALATION_BY's `ruling-conflict: <q-…> <ruling ids…>`.
// Both lines are control entries (surface/src/launch.ts), so a look-alike by anyone else is no mark.
//
// No import of surface/src/orchestrator-question.ts or surface/src/merge-train.ts: both call `askJo`,
// and gates/src/rows already imports the former.
import type { EntryRow, InstructionRow, Ledger } from "../../ledger/src/index";
import { type Builders, KIMI_OUT_RULE, labOf, reviewRow } from "../../classifier/src/lab";
import { loadTierTable, modelIdentity } from "../../classifier/src/tier-table";
import { controlEntries } from "../../surface/src/launch";
import { installedConfigPath } from "../../surface/src/pair-suggest";
import { ESCALATION_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";

export type RulingId = "kimi-out" | "flow-repair" | "merges" | "models" | "gates-stakes";

/** What a question asks, from its option set (count-questions.py's mapping); a `model` question's kind is its declared subject. */
export type QuestionKind = "review-park" | "open-workload" | "merge" | "stakes" | "lane-model" | "review-model" | "other";

/** The declared subject of a question whose every option is a `provider/model` id: the option set alone cannot tell them apart. */
export const MODEL_SUBJECTS = ["lane-model", "review-model"] as const;
export type ModelSubject = (typeof MODEL_SUBJECTS)[number];

/** Who raises the question: the classifier (park, round limit), a lane's tool, the orchestrator's tool, or the merge train's tick. */
export type Asker = "classifier" | "lane" | "orchestrator" | "train";

export interface RulingQuestion {
	body: string;
	options: readonly string[];
	subject?: ModelSubject | null;
}

/** The facts a ruling's scope reads, passed by the asker; a fact the asker does not know is left out and no ruling relies on it. */
export interface RulingFacts {
	asker: Asker;
	/** The classifier's R1–R5 verdict on a review park (classifier/extension.ts): true when Kimi-out decides it. */
	kimiOut?: boolean;
	/** A lane's workload builders now (classifier/src/lab.ts `builderLabs`). */
	builders?: Builders | null;
	/** A lane's workload stakes. */
	stakes?: string | null;
	/** A lane's workload is a merge train. */
	train?: boolean;
	/** The open workload the orchestrator's question is about, or null for none. */
	about?: string | null;
	/** The classifier review row's OpenAI model, read only when a review-model question needs it. */
	reviewModel?: () => string | null;
	/** The clock the rulings' dates are read on (ms since the epoch); `Date.now()` when absent. */
	now?: number;
}

export interface Ruling {
	id: RulingId;
	/** Jo's instruction ids the ruling comes from. */
	sources: readonly string[];
	/** The question kinds it may decide. */
	kinds: readonly QuestionKind[];
	/** Does it cover this question? */
	scope(q: RulingQuestion, kind: QuestionKind, f: RulingFacts): boolean;
	/** Its answer to a covered question. */
	answer(q: RulingQuestion, kind: QuestionKind, f: RulingFacts): string;
	/** What the asker does instead of asking. */
	action(q: RulingQuestion, kind: QuestionKind, f: RulingFacts, answer: string): string;
	/** What it leaves to Jo, in words (the scope is the code). */
	exceptions: string;
	/** Its end: `at` (ms since the epoch) when the source names a date, and the event the source names; Jo's `end-ruling <id>` ends any. */
	ends: { at: number | null; event: string };
}

export interface Decision {
	ruling: RulingId;
	answer: string;
	action: string;
}

/** Every option a `provider/model` id (`openai-codex/gpt-6.1-sol`). */
const MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*$/i;
const allModels = (options: readonly string[]) => options.length > 0 && options.every((o) => MODEL_ID.test(o));

/** The lane model Jo ruled (in-mvfiu1uyldnksg). */
export const RULED_LANE_MODEL = "anthropic/claude-opus-5-5";
/** A body that cites a provider refusal: the lane-model ruling then asks (a refused model is not one Jo ruled to keep). */
const PROVIDER_REFUSAL = /refus|\b(?:401|403|429)\b|quota|suspend|rate.?limit|overloaded|usage polic|non-retryable/i;
/** The words an open-workload question queues with, in the order the answer prefers. */
const QUEUE_WORDS = ["queue", "later", "hold"];

/**
 * The question's kind, deterministic on the option set: `approve` is the plan question (`other`); `same-lab` a
 * review park; every option a `provider/model` id the declared `subject` (`other` when none is declared, which the
 * tools refuse before asking: `subjectProblem`); `normal` and `production` stakes; `open`/`launch` with
 * `later`/`hold`/`queue` an open-workload question; `merged`/`merge`/`integrate` a merge question; anything else `other`.
 */
export function questionKind(options: readonly string[], subject?: ModelSubject | null): QuestionKind {
	const s = new Set(options.map((o) => o.toLowerCase()));
	if (s.has("approve")) return "other";
	if (s.has("same-lab")) return "review-park";
	if (allModels(options)) return subject ?? "other";
	if (s.has("normal") && s.has("production")) return "stakes";
	if ((s.has("open") || s.has("launch")) && QUEUE_WORDS.some((w) => s.has(w))) return "open-workload";
	if (s.has("merged") || s.has("merge") || s.has("integrate")) return "merge";
	return "other";
}

/** Why a declared subject does not fit the options, or null: required when every option is a `provider/model` id, refused otherwise. */
export function subjectProblem(options: readonly string[], subject: string | null | undefined): string | null {
	const declared = subject !== null && subject !== undefined && subject !== "";
	if (declared && !(MODEL_SUBJECTS as readonly string[]).includes(subject)) return `subject is ${MODEL_SUBJECTS.join(" or ")}, not ${subject}`;
	if (allModels(options) && !declared) {
		return "every option is a provider/model id, so declare `subject`: lane-model (the model a lane runs on) or review-model (the model a review runs on)";
	}
	if (!allModels(options) && declared) return "`subject` is declared only when every option is a provider/model id";
	return null;
}

const option = (q: RulingQuestion, word: string) => q.options.find((o) => o.toLowerCase() === word.toLowerCase());

/** The five rulings of DRAFT.md § 4, with scope and end as their sources and REVIEW.md A4 give them. */
export const STANDING_RULINGS: readonly Ruling[] = [
	{
		id: "kimi-out",
		sources: [KIMI_OUT_RULE.input],
		kinds: ["review-park"],
		// A lane's question: decided only when its builders are known (at least one recorded, none unknown) and Kimi is none of them.
		scope: (_q, _k, f) =>
			f.asker === "classifier"
				? f.kimiOut === true
				: f.asker === "lane" && f.builders != null && f.builders.unknown.length === 0 && f.builders.labs.length > 0 && !f.builders.labs.includes("kimi"),
		answer: () => "same-lab",
		action: (_q, _k, f) =>
			f.asker === "classifier"
				? "the review runs same-lab at its spawn (review-same-lab-rule:)"
				: "re-dispatch the review: the classifier decides same-lab at spawn, and if R3–R5 fail there it raises the park itself",
		exceptions:
			"Kimi a builder lab, no builder recorded, or builder provenance unknown: asked. A classifier park asks unless its own R1–R5 verdict holds (another lab being out does not stop R1–R5).",
		ends: { at: KIMI_OUT_RULE.endsAt, event: "Jo's word" },
	},
	{
		id: "flow-repair",
		sources: ["in-mvfiyyv2kuha80"],
		kinds: ["open-workload"],
		scope: () => true,
		answer: (q) => QUEUE_WORDS.map((w) => option(q, w)).find((o) => o !== undefined) ?? "queue",
		action: () => "queue it and tell Jo `queued, position N`; a listed flow fix opens without asking",
		exceptions: "Work Jo already approved, or that already has a lane, keeps running; a listed flow fix opens without asking.",
		ends: { at: null, event: "the five daily flow signals (ROOT-CAUSE.md § 5) green three days running, on Jo's `end-ruling flow-repair`" },
	},
	{
		id: "merges",
		sources: ["in-mv91wdhs446ark"],
		kinds: ["merge"],
		scope: (_q, _k, f) => f.asker === "lane" && f.stakes === "normal" && f.train === false,
		answer: () => "train",
		action: () => "send lane_message that PR #N is green at <sha> and ready for the merge train, then release (lane_release)",
		exceptions: "Production-stakes workloads and merge-train workloads ask.",
		ends: { at: null, event: "Jo's word" },
	},
	{
		id: "models",
		sources: ["in-mv5qagioc4en0g", "in-mvfiu1uyldnksg"],
		kinds: ["lane-model", "review-model"],
		scope: (q, kind, f) => {
			if (kind === "lane-model") return option(q, RULED_LANE_MODEL) !== undefined && !PROVIDER_REFUSAL.test(q.body);
			if (!q.options.some((o) => /\/gpt-6-astra(?::[a-z]+)?$/i.test(o))) return false;
			const row = f.reviewModel?.() ?? null;
			return row !== null && option(q, row) !== undefined;
		},
		answer: (q, kind, f) => option(q, kind === "lane-model" ? RULED_LANE_MODEL : f.reviewModel!()!)!,
		action: (_q, kind, _f, answer) =>
			kind === "lane-model" ? `run the lane on ${answer}` : `route the review's OpenAI leg to ${answer}, never gpt-6-astra`,
		exceptions:
			"A lane-model question whose body cites a provider refusal, or whose options lack anthropic/claude-opus-5-5, asks; a review-model question asks unless an option is on gpt-6-astra and the review row's OpenAI model is among the options.",
		ends: { at: null, event: "the review-cost framework workload lands (in-mv5qagioc4en0g) or Jo's word" },
	},
	{
		id: "gates-stakes",
		sources: ["in-mv0novd17fre9s"],
		kinds: ["stakes"],
		scope: (q, _k, f) => f.asker === "orchestrator" && (f.about ?? null) === null && /\bgates\//.test(q.body),
		answer: (q) => option(q, "production")!,
		action: () => "open it at production stakes: a workload whose PR touches gates/ is production at open (Jo's standing rule until item 82 is built)",
		exceptions: "A stakes question about an open workload is a conversion Jo decides: asked.",
		ends: { at: null, event: "item 82 is built" },
	},
];

/** Is `id` a ruling `STANDING_RULINGS` holds? */
export const isRulingId = (id: string): id is RulingId => STANDING_RULINGS.some((r) => r.id === id);

/** Jo's word that ends a ruling at once: `end-ruling <id>`. */
export const END_RULING_WORD = "end-ruling";
/** The instruction body Jo's `end-ruling` word writes on the standing workload. */
export const endRulingBody = (id: RulingId): string => `${END_RULING_WORD} ${id}`;
const END_RULING = /^end-ruling ([a-z-]+)$/;

/**
 * The rulings Jo ended among `instructions` (the standing workload's, oldest first): a plain instruction by Jo through
 * the surface, written by the surface, whose body is exactly `end-ruling <id>` for a ruling held here.
 */
export function endedRulings(instructions: readonly Pick<InstructionRow, "kind" | "author" | "channel" | "created_by" | "body">[]): Set<RulingId> {
	const out = new Set<RulingId>();
	for (const i of instructions) {
		if (i.kind !== "instruction" || i.author !== "jo" || i.channel !== "surface" || i.created_by !== SURFACE_BY) continue;
		const m = END_RULING.exec(i.body.trim());
		if (m && isRulingId(m[1]!)) out.add(m[1]);
	}
	return out;
}

/** The ledger reads the end check needs. */
export type RulingsView = Pick<Ledger, "instructions">;

/** Is ruling `id` active at `now`: before its date (when it has one) and not ended by Jo's `end-ruling`. */
export function rulingActive(view: RulingsView, id: RulingId, now: number): boolean {
	const ruling = STANDING_RULINGS.find((r) => r.id === id)!;
	return (ruling.ends.at === null || now < ruling.ends.at) && !endedRulings(view.instructions(STANDING_WORKLOAD_ID)).has(id);
}

/** What the active rulings say about a question: one decision (every ruling that decides agrees), a conflict (two or more decide with different answers), or null (none decides). */
export type RulingOutcome = { decided: Decision } | { conflict: RulingId[] } | null;

/**
 * Every active ruling of `rulings` (`STANDING_RULINGS` unless a test injects others) that covers `q`, checked together:
 * when all that decide give one answer, the first one's decision; when two or more answer differently, a conflict that
 * decides nothing (PLAN wl-mvg1vs0rhnu3gg § 1.9); none, null. `state` is the clock and the rulings Jo has ended
 * (`endedRulings`).
 */
export function rulingOutcome(
	q: RulingQuestion,
	facts: RulingFacts,
	state: { now: number; ended: ReadonlySet<RulingId> },
	rulings: readonly Ruling[] = STANDING_RULINGS,
): RulingOutcome {
	const kind = questionKind(q.options, q.subject);
	if (kind === "other") return null;
	const decisions: Decision[] = [];
	for (const r of rulings) {
		if (!r.kinds.includes(kind) || state.ended.has(r.id) || (r.ends.at !== null && state.now >= r.ends.at)) continue;
		if (!r.scope(q, kind, facts)) continue;
		const answer = r.answer(q, kind, facts);
		decisions.push({ ruling: r.id, answer, action: r.action(q, kind, facts, answer) });
	}
	const first = decisions[0];
	if (first === undefined) return null;
	if (decisions.some((d) => d.answer !== first.answer)) return { conflict: decisions.map((d) => d.ruling) };
	return { decided: first };
}

/**
 * The decision the active rulings agree on for `q`, or null when the question goes to Jo (none decides, or they
 * conflict: `rulingOutcome`). The live check reads `state` now, `ruling-miss` as of the question's raise.
 */
export function checkRulings(
	q: RulingQuestion,
	facts: RulingFacts,
	state: { now: number; ended: ReadonlySet<RulingId> },
	rulings: readonly Ruling[] = STANDING_RULINGS,
): Decision | null {
	const outcome = rulingOutcome(q, facts, state, rulings);
	return outcome !== null && "decided" in outcome ? outcome.decided : null;
}

/** The asker's record of a decided question: `ruling-applied: <ruling> kind <k> slice <sl> answer <a>`. */
export const RULING_APPLIED_PREFIX = "ruling-applied";
export const rulingAppliedBody = (d: Decision, kind: QuestionKind, sliceId: string): string =>
	`${RULING_APPLIED_PREFIX}: ${d.ruling} kind ${kind} slice ${sliceId} answer ${d.answer}`;

/** ESCALATION_BY's record of rulings that disagreed on a question it then raised: `ruling-conflict: <q-…> <ruling id> <ruling id>…`. */
export const RULING_CONFLICT_PREFIX = "ruling-conflict";
export const rulingConflictBody = (questionId: string, rulings: readonly RulingId[]): string =>
	`${RULING_CONFLICT_PREFIX}: ${questionId} ${rulings.join(" ")}`;

/** DRAFT §1's three now bullets as words: a question asked with one reaches Jo at once, past every ruling (PLAN wl-mvg1vs0rhnu3gg § 1.0). */
export const NOW_CATEGORIES = ["integrity", "security", "incident", "guard", "boundary", "irreversible", "money"] as const;
export type NowCategory = (typeof NOW_CATEGORIES)[number];
export const isNowCategory = (word: string): word is NowCategory => (NOW_CATEGORIES as readonly string[]).includes(word);

/** ESCALATION_BY's mark of a NOW question, written in the raise's (or the upgrade's) transaction: `now: <q-…> <category>`. */
export const NOW_PREFIX = "now";
export const nowBody = (questionId: string, category: NowCategory): string => `${NOW_PREFIX}: ${questionId} ${category}`;
const NOW_REST = /^(q-[a-z0-9]+) ([a-z]+)$/;

/**
 * The NOW category of each question a valid `now:` control entry among `entries` names (surface/src/launch.ts
 * `controlEntries`: ESCALATION_BY's alone, so a look-alike by anyone else marks nothing); a question's first mark wins.
 */
export function nowMarks(entries: readonly EntryRow[]): Map<string, NowCategory> {
	const out = new Map<string, NowCategory>();
	for (const c of controlEntries(entries)) {
		if (c.prefix !== NOW_PREFIX) continue;
		const m = NOW_REST.exec(c.rest);
		if (m && isNowCategory(m[2]!) && !out.has(m[1]!)) out.set(m[1]!, m[2]);
	}
	return out;
}

/** The ledger calls `askJo` makes; `Ledger` and the classifier's `RoutingLedger` satisfy it. */
export type AskLedger = Pick<Ledger, "write" | "raiseQuestion" | "recordEntry" | "instructions" | "questions" | "entries">;

export interface AskInput {
	by: string;
	workloadId: string;
	sliceId: string;
	body: string;
	options: string[];
	subject?: ModelSubject | null;
	/** Jo hears it at once: one of `NOW_CATEGORIES`; any other word is refused and nothing is asked. */
	now?: NowCategory | null;
}

/** A raised question, the open one an identical ask reused (nothing raised again), or a ruling's decision. */
export type AskResult = { raised: string } | { raised: string; reused: true } | { decided: Decision };

/**
 * The orchestrator's subject entry, as surface/src/orchestrator-question.ts `questionSubjectBody` writes it (the surface,
 * on the standing workload, in the raise's transaction); read here because that module imports this one.
 */
const QUESTION_ABOUT = /^question-about: (q-[a-z0-9]+) (wl-[a-z0-9]+)$/;
function questionAbout(entries: readonly EntryRow[], questionId: string): string | null {
	for (const e of entries) {
		if (e.created_by !== SURFACE_BY) continue;
		const m = QUESTION_ABOUT.exec(e.body);
		if (m && m[1] === questionId) return m[2]!;
	}
	return null;
}

/**
 * The open question `input` repeats, or null: same workload, slice, body and options and, for the orchestrator, the same
 * `about` workload as the open question's subject entry (PLAN wl-mvg1vs0rhnu3gg § 3.5). A model-subject ask never
 * repeats one: the subject is not stored, so equality cannot be checked.
 */
function openRepeat(ledger: AskLedger, input: AskInput, facts: RulingFacts): string | null {
	if (input.subject != null) return null;
	const options = JSON.stringify(input.options);
	let entries: EntryRow[] | null = null;
	for (const q of ledger.questions(input.workloadId)) {
		if (q.state !== "open" || q.slice_id !== input.sliceId || q.body !== input.body || q.options !== options) continue;
		if (facts.asker === "orchestrator") {
			entries ??= ledger.entries(input.workloadId, "assumption");
			if (questionAbout(entries, q.id) !== (facts.about ?? null)) continue;
		}
		return q.id;
	}
	return null;
}

/**
 * Ask Jo, unless the question is already open or a standing ruling already answered, in one write:
 * - an ask repeating an open question (`openRepeat`) returns its id as reused and writes nothing, except ESCALATION_BY's
 *   `now:` mark for that id when the ask carries `now` and the open one has no valid mark (queue → NOW);
 * - an ask with `now` skips the rulings and is raised with ESCALATION_BY's `now:` mark;
 * - otherwise the rulings are checked: a decided question writes no question row and records `ruling-applied:` as the
 *   asker on the question's workload and slice; rulings in conflict decide nothing, and the question is raised with
 *   ESCALATION_BY's `ruling-conflict:`; with none deciding the question is raised (which pauses its slice).
 * Throws, asking nothing, when the declared subject does not fit the options or `now` is not one of `NOW_CATEGORIES`.
 * `rulings` is `STANDING_RULINGS` except where a test injects others.
 */
export function askJo(ledger: AskLedger, input: AskInput, facts: RulingFacts, rulings: readonly Ruling[] = STANDING_RULINGS): AskResult {
	const problem = subjectProblem(input.options, input.subject);
	if (problem !== null) throw new Error(`${problem}; nothing was asked`);
	const now = input.now ?? null;
	if (now !== null && !isNowCategory(now)) throw new Error(`now is one of ${NOW_CATEGORIES.join(", ")}, not ${now}; nothing was asked`);
	const escalation = (body: string) =>
		ledger.recordEntry({ by: ESCALATION_BY, workloadId: input.workloadId, sliceId: input.sliceId, kind: "assumption", body });
	return ledger.write(() => {
		const open = openRepeat(ledger, input, facts);
		if (open !== null) {
			if (now !== null && !nowMarks(ledger.entries(input.workloadId, "assumption")).has(open)) escalation(nowBody(open, now));
			return { raised: open, reused: true as const };
		}
		const q = { body: input.body, options: input.options, subject: input.subject ?? null };
		const outcome =
			now === null
				? rulingOutcome(q, facts, { now: facts.now ?? Date.now(), ended: endedRulings(ledger.instructions(STANDING_WORKLOAD_ID)) }, rulings)
				: null;
		if (outcome !== null && "decided" in outcome) {
			const kind = questionKind(q.options, q.subject);
			ledger.recordEntry({ by: input.by, workloadId: input.workloadId, sliceId: input.sliceId, kind: "assumption", body: rulingAppliedBody(outcome.decided, kind, input.sliceId) });
			return { decided: outcome.decided };
		}
		const raised = ledger.raiseQuestion({ by: input.by, workloadId: input.workloadId, sliceId: input.sliceId, body: input.body, options: input.options });
		if (now !== null) escalation(nowBody(raised, now));
		if (outcome !== null) escalation(rulingConflictBody(raised, outcome.conflict));
		return { raised };
	});
}

/** The question id of a question no ruling decides (a round-limit or train question); a decision there is a defect, thrown. */
export function raisedId(r: AskResult, what: string): string {
	if ("raised" in r) return r.raised;
	throw new Error(`Jo's ruling ${r.decided.ruling} decided ${what}, a kind no ruling covers`);
}

/** The tools' reply to a decided question: no question id, no QUESTION block. */
export const decidedText = (d: Decision): string =>
	`decided by Jo's ruling ${d.ruling}: ${d.action}; no question was raised; do not publish a QUESTION block`;

/**
 * The classifier review row's OpenAI model (classifier/src/lab.ts `reviewRow`, `REVIEW_ROW_FROM`: the strong row's
 * OpenAI entry, as `provider/model`) in the installed profile's tier table (surface/src/pair-suggest.ts
 * `installedConfigPath`, the file the classifier and the lane runner read); null when it cannot be read or names none.
 */
export function installedReviewModel(env: Record<string, string | undefined>): string | null {
	try {
		const openai = reviewRow(loadTierTable(installedConfigPath(env)), "strong").find((s) => labOf(s) === "openai");
		return openai === undefined ? null : modelIdentity(openai);
	} catch {
		return null;
	}
}
