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
// (classifier/extension.ts), a lane the workload's builders, stakes and train flag, and on a train's merge question the
// `trainSignoff` fact the tool computes from the ledger and live gh reads (surface/extensions/lane-tools.ts,
// surface/src/merge-train.ts `trainSignoff`; PLAN wl-mvg8itbt0rz3ls D1, D2), the orchestrator the workload its ask is about
// (surface/src/orchestrator-question.ts). surface/scripts/invariants.ts `ruling-miss` replays the
// same check over question rows to catch a raise path that bypassed it.
//
// No import of surface/src/orchestrator-question.ts or surface/src/merge-train.ts: both call `askJo`,
// and gates/src/rows already imports the former.
import type { InstructionRow, Ledger } from "../../ledger/src/index";
import { type Builders, KIMI_OUT_RULE, labOf, reviewRow } from "../../classifier/src/lab";
import { loadTierTable, modelIdentity } from "../../classifier/src/tier-table";
import { installedConfigPath } from "../../surface/src/pair-suggest";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";

export type RulingId = "kimi-out" | "flow-repair" | "merges" | "models" | "gates-stakes" | "train-signoff";

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

/**
 * PLAN wl-mvg8itbt0rz3ls D2: a train PR's merge sign-off as the lane tool computed it (surface/src/merge-train.ts
 * `trainSignoff`): ok with the PR, its disposition slice, the train's `owner/repo`, the head gh read and the green run at it;
 * or the first rule that failed. Defined here so this module needs no import of merge-train.ts.
 */
export type TrainSignoffFact = { ok: true; pr: number; slice: string; repo: string; head: string; run: string } | { ok: false; reason: string };

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
	/** A train lane's merge question: Jo's train word, the PR's workload, its review, green and main's protection (PLAN wl-mvg8itbt0rz3ls D2). */
	trainSignoff?: TrainSignoffFact;
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

/**
 * PLAN wl-mvg8itbt0rz3ls D1: what a train lane does when `train-signoff` decides its production PR's merge question, step 7 c. to
 * e. as for a normal PR, self-contained so a train opened on an older brief acts on it too.
 */
export function trainSignoffAction(f: Extract<TrainSignoffFact, { ok: true }>): string {
	const { pr, repo, head, slice, run } = f;
	return (
		`merge #${pr} now as step 7 c. to e. for a normal PR: \`gh pr merge ${pr} -R ${repo} --merge --match-head-commit ${head}\` ` +
		"(a merge commit, never --admin, --squash, --rebase or --auto); " +
		`verify \`gh pr view ${pr} -R ${repo} --json state,mergeCommit\` shows MERGED (a refused merge: back to step 7 a. once, then ` +
		`lane_record_entry \`train-error: pr ${pr} merge-refused <gh's messages>\` and pass the PR over); ` +
		`complete ${slice} with artifact \`merged by train <merge commit sha> (run ${run})\`; the train tick tells Jo`
	);
}

/** The six rulings: DRAFT.md § 4's five, with scope and end as their sources and REVIEW.md A4 give them, and train-signoff (PLAN wl-mvg8itbt0rz3ls D1). */
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
	{
		// PLAN wl-mvg8itbt0rz3ls D1: Jo's train word on a production-stakes PR is his merge sign-off (jo-issues #155). Only a train
		// lane's tool computes `trainSignoff`, so no other asker (orchestrator, classifier, the tick, `ruling-miss`) is covered.
		id: "train-signoff",
		sources: ["in-mvg8clpoo9xn28", "in-mvg8ibntzpnzeo", "in-mvg9zz54ejepz4"],
		kinds: ["merge"],
		scope: (_q, _k, f) => f.asker === "lane" && f.train === true && f.trainSignoff?.ok === true,
		answer: () => "merge",
		action: (_q, _k, f) => trainSignoffAction(f.trainSignoff as Extract<TrainSignoffFact, { ok: true }>),
		exceptions:
			"A PR whose merge question is already open on any of its train slices (Jo's answer stands), a merge question asked on a full-suite slice rather than the PR's disposition slice, a train Jo stopped and has not resumed with his train word, a PR no Jo `train` word named, a PR with no ledger workload (non-`wl/` branch, fork), a workload not at production stakes, held by Jo's halt (or the auto-start's hold), whose plan is not yet approved, or whose newest review has not passed or is still running, a head no green run tested, main's protection not verified ok live, or gh failing: asked.",
		ends: { at: null, event: "Jo's end-ruling train-signoff (jo-issues #155: Jo's train word is the production sign-off)" },
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

/**
 * The decision of the first active ruling that covers `q`, or null when the question goes to Jo. `state` is the clock
 * and the rulings Jo has ended (`endedRulings`); the live check reads them now, `ruling-miss` as of the question's raise.
 */
export function checkRulings(q: RulingQuestion, facts: RulingFacts, state: { now: number; ended: ReadonlySet<RulingId> }): Decision | null {
	const kind = questionKind(q.options, q.subject);
	if (kind === "other") return null;
	for (const r of STANDING_RULINGS) {
		if (!r.kinds.includes(kind) || state.ended.has(r.id) || (r.ends.at !== null && state.now >= r.ends.at)) continue;
		if (!r.scope(q, kind, facts)) continue;
		const answer = r.answer(q, kind, facts);
		return { ruling: r.id, answer, action: r.action(q, kind, facts, answer) };
	}
	return null;
}

/** The asker's record of a decided question: `ruling-applied: <ruling> kind <k> slice <sl> answer <a>`. */
export const RULING_APPLIED_PREFIX = "ruling-applied";
export const rulingAppliedBody = (d: Decision, kind: QuestionKind, sliceId: string): string =>
	`${RULING_APPLIED_PREFIX}: ${d.ruling} kind ${kind} slice ${sliceId} answer ${d.answer}`;

/** The ledger calls `askJo` makes; `Ledger` and the classifier's `RoutingLedger` satisfy it. */
export type AskLedger = Pick<Ledger, "write" | "raiseQuestion" | "recordEntry" | "instructions">;

export interface AskInput {
	by: string;
	workloadId: string;
	sliceId: string;
	body: string;
	options: string[];
	subject?: ModelSubject | null;
}

export type AskResult = { raised: string } | { decided: Decision };

/**
 * Ask Jo, unless a standing ruling already answered: in one write, the rulings are checked; a decided question writes
 * no question row and records `ruling-applied:` as the asker on the question's workload and slice; otherwise the
 * question is raised (which pauses its slice). Throws when the declared subject does not fit the options.
 */
export function askJo(ledger: AskLedger, input: AskInput, facts: RulingFacts): AskResult {
	const problem = subjectProblem(input.options, input.subject);
	if (problem !== null) throw new Error(`${problem}; nothing was asked`);
	return ledger.write(() => {
		const q = { body: input.body, options: input.options, subject: input.subject ?? null };
		const decided = checkRulings(q, facts, { now: facts.now ?? Date.now(), ended: endedRulings(ledger.instructions(STANDING_WORKLOAD_ID)) });
		if (decided !== null) {
			const kind = questionKind(q.options, q.subject);
			ledger.recordEntry({ by: input.by, workloadId: input.workloadId, sliceId: input.sliceId, kind: "assumption", body: rulingAppliedBody(decided, kind, input.sliceId) });
			return { decided };
		}
		const { subject: _subject, ...raise } = input;
		return { raised: ledger.raiseQuestion(raise) };
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
