// Jev ranking's one ranking function and its rows (PLAN wl-mv8k039gvogt8g § 2 D1–D3). Jev answers narrow factual
// questions per workload (`rankQuestions`, asked through classifier/src/judge-ask.ts `askJudgment` by the as2_rank tool);
// this file turns the stored answers into an order with visible weights (`scoreSignal`, `RANK_WEIGHTS`), decides when a
// stored answer still holds (`signalCurrent`), and orders every open workload (`rankOpen`; `rankPick` for Jo's picks).
// Everything here is a pure read over ledger rows: no judge call, no write. The question set and weights are the shadow
// test's (jev-rank-test/rank.ts, RESULT.md: 0.781 pairwise agreement), with the deadline question made date-safe: Jev
// picks a window written out from the asking day, and urgency is computed from that window against `now` at every read.
import { createHash } from "node:crypto";
import type { EntryRow, Ledger, Mode, WorkloadRow } from "../../ledger/src/index";
import type { JudgmentAnswer, JudgmentQuestions } from "../../classifier/src/judge-ask";
import { stamp } from "./decision-log";
import { controlEntries, heldLive } from "./launch";
import { DUE_PREFIX, STANDING_WORKLOAD_ID } from "./types";

// ---- weights and questions (D2) ----------------------------------------------------------------------------------

/** The score's weights (D2), printed with every table. Refitting them is the Jev-monitoring workload's (wl-mv654hoqwpfhmo). */
export const RANK_WEIGHTS = { goal_max: 0.3, unblocks_jo: 0.2, fixes_breakage: 0.15, urgency: 0.2, cuts_spend: 0.15 } as const;
export type RankTermName = keyof typeof RANK_WEIGHTS;

/** Jev's deadline answer: a window relative to the asking day, its labels written out as dates (`rankQuestions`). */
export const DEADLINE_LABELS = ["none", "today", "tomorrow", "2-3-days", "4-7-days", "later"] as const;
export type DeadlineLabel = (typeof DEADLINE_LABELS)[number];
/** Each label's window in days after `asked-on`, inclusive; `later` is open-ended. */
const DEADLINE_WINDOWS: Record<DeadlineLabel, readonly [number, number | null] | null> = {
	none: null, today: [0, 0], tomorrow: [1, 1], "2-3-days": [2, 3], "4-7-days": [4, 7], later: [8, null],
};
/** The yes/no questions, asked as `bool` (noul on OMP's wire). */
const BOOL_NAMES = ["unblocks_jo", "cuts_spend", "fixes_breakage", "states_deadline", "irreversible", "builds_enforcer"] as const;
/**
 * Bools a stored signal may lack because they were added after signals were first written: such a signal still parses
 * (it reads `stale signal`) but is never current, so it is re-asked (`signalCurrent`).
 */
const LATER_BOOLS: readonly string[] = ["builds_enforcer"];
/** A `builds_enforcer` above this ranks the item in the enforcer band (D1, Jo's machinery-first word of 2026-10-14). */
const ENFORCER_YES = 0.65;
const GOAL_LEVELS = [
	"Unrelated: the work does nothing for this goal.",
	"Touches it: the work is near the goal's topic but does not move it forward.",
	"Partly delivers it: the work moves this goal forward in part.",
	"Delivers it: completing the work directly achieves or largely achieves this goal.",
] as const;
const GOAL_TOP = GOAL_LEVELS.length - 1;
/** At most this many goal lines of Jo's (D3 `rank-goals:`); the seed goals do not count. */
export const MAX_GOALS = 6;
/**
 * The goals asked before Jo's on every signal, always in force and never stale (Jo's machinery-first word of
 * 2026-10-14, input in-mv8vxstcczw0zk). With Jo's goals none or stale the goal term is the best seed goal's.
 */
export const SEED_GOALS: readonly string[] = [
	"Machinery first: build the enforcers (gates, reviews, checks) that govern how other work is planned, reviewed or checked before the work they govern.",
];
/** Jo's goals older than this no longer weigh: only the seed goals are asked and scored (D3). */
export const GOALS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Failed asks per (brief, goals) before the item is listed `unscored (jev failed)` and not asked again (D3). */
export const MAX_SIGNAL_FAILURES = 3;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `YYYY-MM-DD` as a UTC midnight, for calendar arithmetic only. */
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const addDays = (day: string, n: number): string => new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (day: string): string => WEEKDAYS[new Date(dayMs(day)).getUTCDay()]!;
const dated = (day: string): string => `${weekday(day)} ${day}`;

/** The local calendar day of an ISO instant (the decision log's day): the day signals are asked on and dated against. */
export function rankDay(iso: string): string {
	return stamp(iso).day;
}

/**
 * The goal lines Jev is asked, in `goal_<i>` order, for Jo's goal lines in force (`currentGoals(…).asked`, or the
 * lines Jo is setting now): SEED_GOALS, then Jo's. `rankQuestions`, `rankState` and `goalsHash` all take Jo's lines and
 * go through this, so the goals a signal is asked on and the hash it is stamped and checked with are decided here alone.
 */
export function goalsAsked(joGoals: readonly string[]): string[] {
	return [...SEED_GOALS, ...joGoals];
}

/**
 * The questions Jev answers about one workload (D2): `goal_<i>` a Score 0–3 per goal asked (`goalsAsked(joGoals)`:
 * the seed goals first, then Jo's); `unblocks_jo`, `cuts_spend`, `fixes_breakage`, `states_deadline`, `irreversible`,
 * `builds_enforcer` as `bool`; `deadline_when` a Choice whose labels are written out as dates from `today`
 * (`YYYY-MM-DD`), so Jev never does date arithmetic.
 */
export function rankQuestions(joGoals: readonly string[], today: string): JudgmentQuestions {
	const questions: JudgmentQuestions = {};
	goalsAsked(joGoals).forEach((g, i) => {
		questions[`goal_${i}`] = {
			type: "score",
			instructions: `How directly does completing the work described in \`item\` advance this goal: "${g}"?`,
			criteria: [...GOAL_LEVELS],
		};
	});
	questions.unblocks_jo = {
		type: "bool",
		instructions: "Does completing the work in `item` remove something that currently stops Jo from working, or remove a step Jo now does by hand (pasting, relaying, approving, clicking, checking)?",
		criteria: { true: "Yes: a Jo blocker or a manual Jo step goes away.", false: "No: Jo's own work is unchanged by it." },
	};
	questions.cuts_spend = {
		type: "bool",
		instructions: "Is a main purpose of the work in `item` to reduce model spend, token use, or Anthropic subscription quota use?",
	};
	questions.fixes_breakage = {
		type: "bool",
		instructions: "Does the work in `item` repair something that is broken or wrong right now (a failing test, a crash, a security hole, a wrong output, a resource blow-up)? New features and new capabilities are not repairs.",
	};
	questions.states_deadline = {
		type: "bool",
		instructions: "Does the text of `item` state a due date, a deadline, or a required time (for example \"due Thursday\", \"tonight\", \"before Saturday\")?",
	};
	questions.deadline_when = {
		type: "choice",
		instructions: `Today is ${dated(today)}. Which day does the text of \`item\` say the work is due? Pick "none" if the text states no due date.`,
		criteria: {
			none: "The text states no due date or deadline.",
			today: `Due today, ${dated(today)}, or now / tonight.`,
			tomorrow: `Due tomorrow, ${dated(addDays(today, 1))}.`,
			"2-3-days": `Due ${dated(addDays(today, 2))} or ${dated(addDays(today, 3))}.`,
			"4-7-days": `Due between ${dated(addDays(today, 4))} and ${dated(addDays(today, 7))}.`,
			later: `Due on a stated date after ${dated(addDays(today, 7))}.`,
		},
	};
	questions.irreversible = {
		type: "bool",
		instructions: "Would the work in `item` change something a git revert cannot undo, such as a live database migration, deleting data, sending messages to people, or publishing to the public?",
	};
	questions.builds_enforcer = {
		type: "bool",
		instructions: "Does the work in `item` build or change an enforcer, meaning a gate, review step, check or rule that governs how other work is planned, reviewed or checked?",
		criteria: { true: "Yes: it builds or changes such an enforcer.", false: "No: it is work an enforcer would govern, or unrelated to enforcers." },
	};
	return questions;
}

/** The first line of a brief: the workload's title in every view. */
export function rankTitle(brief: string): string {
	return brief.trim().split("\n")[0]!.trim();
}

/** The state Jev judges (D2): the goal lines asked (`goalsAsked(joGoals)`), `<first line>\n\n<brief>`, and today with its weekday. */
export function rankState(joGoals: readonly string[], brief: string, today: string): { goals: string[]; item: string; today: string } {
	return { goals: goalsAsked(joGoals), item: `${rankTitle(brief)}\n\n${brief}`, today: `${today} (${weekday(today)})` };
}

// ---- the score (D2) ----------------------------------------------------------------------------------------------

/** A stored answer: the typed value without its distribution (`priority-signal:` keeps it compact). */
export type SignalAnswer =
	| { type: "bool"; bool: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "choice"; choice: string; confidence: number };
export type SignalAnswers = Record<string, SignalAnswer>;

export interface RankTerm {
	value: number;
	/** `?` when an uncertain answer was counted as 0.5 (D2). */
	mark: "" | "?";
	/** What the value came from: `seed goal 1`, `goal 2`, `no goals asked`, `due 2026-10-15`, … */
	detail: string;
}
export type RankTerms = Record<RankTermName, RankTerm>;
export interface SignalScore {
	score: number;
	terms: RankTerms;
	flags: string[];
	/** The signal states a deadline: it is re-asked once its asking day is past (D2). */
	dated: boolean;
	/** `builds_enforcer` above 0.65: the item ranks in the enforcer band, above every item outside it (D1). */
	enforcer: boolean;
}

/** Uncertain answers do not move the rank: a `bool` in [0.35, 0.65] counts 0.5, marked `?` (D2 `noul`). */
function noul(a: SignalAnswer | undefined): { value: number; mark: "" | "?" } {
	const x = a?.type === "bool" ? a.bool : 0.5;
	return x >= 0.35 && x <= 0.65 ? { value: 0.5, mark: "?" } : { value: x, mark: "" };
}

/** The signal states a deadline (D2: `states_deadline` ≥ 0.5 after `noul`). */
function isDated(answers: SignalAnswers): boolean {
	return noul(answers.states_deadline).value >= 0.5;
}

/**
 * The D2 score of one signal at `now`: `goal_max` (the best goal's level / 3, a Score with confidence < 0.5 counting 0.5
 * `?`), the `noul` terms, and urgency from the deadline window anchored on `askedOn` (`days_left` ≤ 1 → 1, ≤ 3 → 0.5,
 * else 0; a past window stays 1). The goals are the signal's `goal_<i>` in `goalsAsked` order: the seed goals always
 * count, Jo's only while `joGoalsInForce`; with no goal answered the term is 0.5. An `irreversible` above 0.65 flags
 * the item; a `builds_enforcer` above 0.65 puts it in the enforcer band and one in [0.35, 0.65] flags `enforcer?`;
 * neither changes the score.
 */
export function scoreSignal(answers: SignalAnswers, askedOn: string, now: string, joGoalsInForce = true): SignalScore {
	let goal: RankTerm | null = null;
	for (let i = 0; answers[`goal_${i}`] !== undefined && (joGoalsInForce || i < SEED_GOALS.length); i++) {
		const a = answers[`goal_${i}`]!;
		if (a.type !== "score") continue;
		const detail = i < SEED_GOALS.length ? `seed goal ${i + 1}` : `goal ${i - SEED_GOALS.length + 1}`;
		const g: RankTerm = a.confidence < 0.5 ? { value: 0.5, mark: "?", detail } : { value: a.score / GOAL_TOP, mark: "", detail };
		if (goal === null || g.value > goal.value) goal = g;
	}
	const deadline = noul(answers.states_deadline);
	const when = answers.deadline_when;
	const label = when?.type === "choice" && (DEADLINE_LABELS as readonly string[]).includes(when.choice) ? (when.choice as DeadlineLabel) : "none";
	const window = DEADLINE_WINDOWS[label];
	let urgency: RankTerm = { value: 0, mark: deadline.mark, detail: "no deadline" };
	if (deadline.value >= 0.5 && window !== null) {
		const start = addDays(askedOn, window[0]);
		const daysLeft = (dayMs(start) - dayMs(rankDay(now))) / DAY_MS;
		const value = daysLeft <= 1 ? 1 : daysLeft <= 3 ? 0.5 : 0;
		const end = window[1] === null ? "" : addDays(askedOn, window[1]);
		urgency = { value, mark: deadline.mark, detail: end === start ? `due ${start}` : `due ${start}..${end}` };
	}
	const bool = (name: string): RankTerm => ({ ...noul(answers[name]), detail: name });
	const terms: RankTerms = {
		goal_max: goal ?? { value: 0.5, mark: "", detail: "no goals asked" },
		unblocks_jo: bool("unblocks_jo"),
		fixes_breakage: bool("fixes_breakage"),
		urgency,
		cuts_spend: bool("cuts_spend"),
	};
	let score = 0;
	for (const name of Object.keys(RANK_WEIGHTS) as RankTermName[]) score += RANK_WEIGHTS[name] * terms[name].value;
	const flags = noul(answers.irreversible).value > 0.65 ? ["irreversible: needs Jo"] : [];
	const builds = answers.builds_enforcer === undefined ? null : noul(answers.builds_enforcer);
	const enforcer = builds !== null && builds.value > ENFORCER_YES;
	if (enforcer) flags.push("enforcer: ranks first");
	else if (builds?.mark === "?") flags.push("enforcer?");
	return { score: Number(score.toFixed(4)), terms, flags, dated: isDated(answers), enforcer };
}

// ---- rows (D3) ---------------------------------------------------------------------------------------------------

const sha12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);
export function briefHash(brief: string): string {
	return sha12(brief);
}
/** The goals hash a signal is stamped and checked with, for Jo's lines in force: the hash of `goalsAsked(joGoals)`. */
export function goalsHash(joGoals: readonly string[]): string {
	return sha12(JSON.stringify(goalsAsked(joGoals)));
}

/** `0.0000481` from a dollar figure: fixed to ten places, trailing zeros dropped, never an exponent (as `pair-signal:`). */
function dollars(usd: number | null): string {
	return usd === null ? "unknown" : usd.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}
const numberOrNull = (s: string): number | null => {
	if (s === "unknown") return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
};

export interface Signal {
	brief: string;
	goals: string;
	askedOn: string;
	judge: string;
	tokens: number | null;
	cost: number | null;
	answers: SignalAnswers;
}

/** The stored form of the judge's answers: values and confidences, distributions dropped. */
function compact(answers: Record<string, SignalAnswer | JudgmentAnswer>): SignalAnswers {
	const out: SignalAnswers = {};
	for (const [name, a] of Object.entries(answers)) {
		out[name] = a.type === "bool" ? { type: "bool", bool: a.bool }
			: a.type === "score" ? { type: "score", score: a.score, confidence: a.confidence }
			: { type: "choice", choice: a.choice, confidence: a.confidence };
	}
	return out;
}

/**
 * A whole rank signal's answers: the fixed bools (a LATER_BOOLS one may be missing, never malformed), `deadline_when`
 * among the labels, and `goal_0…` contiguous Scores 0–3.
 */
function isRankAnswers(answers: unknown): answers is SignalAnswers {
	if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return false;
	const field = (name: string, key: string): unknown => {
		const v: unknown = Reflect.get(answers, name);
		return typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined;
	};
	const unit = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
	let goals = 0;
	while (`goal_${goals}` in answers) goals++;
	const names = new Set<string>([...BOOL_NAMES, "deadline_when", ...Array.from({ length: goals }, (_, i) => `goal_${i}`)]);
	if (!Object.keys(answers).every((k) => names.has(k))) return false;
	if (!BOOL_NAMES.every((name) => (LATER_BOOLS.includes(name) && !(name in answers)) || (field(name, "type") === "bool" && unit(field(name, "bool"))))) return false;
	if (field("deadline_when", "type") !== "choice" || !(DEADLINE_LABELS as readonly unknown[]).includes(field("deadline_when", "choice")) || !unit(field("deadline_when", "confidence"))) return false;
	for (let i = 0; i < goals; i++) {
		const score = field(`goal_${i}`, "score");
		if (field(`goal_${i}`, "type") !== "score" || typeof score !== "number" || !(score >= 0 && score <= GOAL_TOP) || !unit(field(`goal_${i}`, "confidence"))) return false;
	}
	return true;
}

/** `priority-signal: brief <sha12> goals <sha12> asked-on <YYYY-MM-DD> judge <provider/model> tokens <n|unknown> cost <usd|unknown> answers <JSON>`. */
export function formatSignal(s: Omit<Signal, "answers"> & { answers: Record<string, SignalAnswer | JudgmentAnswer> }): string {
	return `priority-signal: brief ${s.brief} goals ${s.goals} asked-on ${s.askedOn} judge ${s.judge} tokens ${s.tokens ?? "unknown"} cost ${dollars(s.cost)} answers ${JSON.stringify(compact(s.answers))}`;
}
const SIGNAL = /^priority-signal: brief ([0-9a-f]{12}) goals ([0-9a-f]{12}) asked-on (\d{4}-\d{2}-\d{2}) judge (\S+) tokens (\d+|unknown) cost (\S+) answers (\{.*\})$/;
/** A `priority-signal:` body parsed; null when malformed or its answers are not a whole rank signal. */
export function parseSignal(body: string): Signal | null {
	const m = SIGNAL.exec(body.trim());
	if (!m) return null;
	let answers: unknown;
	try {
		answers = JSON.parse(m[7]!);
	} catch {
		return null;
	}
	if (!isRankAnswers(answers)) return null;
	return { brief: m[1]!, goals: m[2]!, askedOn: m[3]!, judge: m[4]!, tokens: numberOrNull(m[5]!), cost: numberOrNull(m[6]!), answers: compact(answers) };
}

export type SignalFailure = "timeout" | "error" | "malformed";
export interface SignalFailed {
	brief: string;
	goals: string;
	attempt: number;
	failure: SignalFailure;
	tokens: number | null;
	cost: number | null;
}
/** `priority-signal-failed: brief <sha12> goals <sha12> attempt <n> <timeout|error|malformed> tokens <n|unknown> cost <usd|unknown>`. */
export function formatSignalFailed(f: SignalFailed): string {
	return `priority-signal-failed: brief ${f.brief} goals ${f.goals} attempt ${f.attempt} ${f.failure} tokens ${f.tokens ?? "unknown"} cost ${dollars(f.cost)}`;
}
const SIGNAL_FAILED = /^priority-signal-failed: brief ([0-9a-f]{12}) goals ([0-9a-f]{12}) attempt (\d+) (timeout|error|malformed) tokens (\d+|unknown) cost (\S+)$/;
export function parseSignalFailed(body: string): SignalFailed | null {
	const m = SIGNAL_FAILED.exec(body.trim());
	return m ? { brief: m[1]!, goals: m[2]!, attempt: Number(m[3]), failure: m[4] as SignalFailure, tokens: numberOrNull(m[5]!), cost: numberOrNull(m[6]!) } : null;
}

/** Why Jo's goal lines cannot be stored (1–6 lines, each one non-empty line), or null. */
export function goalsProblem(goals: readonly unknown[]): string | null {
	if (goals.length < 1 || goals.length > MAX_GOALS) return `goals are 1 to ${MAX_GOALS} lines, not ${goals.length}`;
	const bad = goals.findIndex((g) => typeof g !== "string" || g.trim() === "" || g.includes("\n"));
	return bad === -1 ? null : `goal ${bad + 1} is not one non-empty line`;
}
/** `rank-goals: input <in-id> goals <JSON array of 1–6 lines>`. */
export function formatGoals(g: { input: string; goals: readonly string[] }): string {
	return `rank-goals: input ${g.input} goals ${JSON.stringify(g.goals.map((x) => x.trim()))}`;
}
const GOALS = /^rank-goals: input (in-\S+) goals (\[.*\])$/;
export function parseGoals(body: string): { input: string; goals: string[] } | null {
	const m = GOALS.exec(body.trim());
	if (!m) return null;
	let goals: unknown;
	try {
		goals = JSON.parse(m[2]!);
	} catch {
		return null;
	}
	return Array.isArray(goals) && goalsProblem(goals) === null ? { input: m[1]!, goals: goals.filter((g): g is string => typeof g === "string") } : null;
}

export type RankState = "running" | "waiting";
/** One item of a `rank-shown:` order: `<wl>:<score|u>:<r|w>[:p]`. */
export interface ShownItem {
	workloadId: string;
	score: number | null;
	state: RankState;
	pinned: boolean;
}
export interface Shown {
	/** sha12 of the items list as written. */
	hash: string;
	/** `orchestrator`, `lane-…`, `hand:<agent id>` or `pick`. */
	by: string;
	goals: string;
	items: ShownItem[];
}
const SHOWN_BY = /^(orchestrator|pick|lane-\S+|hand:\S+)$/;
/** `rank-shown: <sha12> by <orchestrator|lane-…|hand:<agent id>|pick> goals <sha12> items <wl>:<score|u>:<r|w>[:p],…` (`-` for none). */
export function formatShown(s: { by: string; goals: string; items: readonly (Pick<RankItem, "workloadId" | "state"> & { score?: number | null; pinned?: unknown })[] }): string {
	const text = s.items.length === 0 ? "-"
		: s.items.map((i) => `${i.workloadId}:${i.score == null ? "u" : String(i.score)}:${i.state === "running" ? "r" : "w"}${i.pinned ? ":p" : ""}`).join(",");
	return `rank-shown: ${sha12(text)} by ${s.by} goals ${s.goals} items ${text}`;
}
const SHOWN = /^rank-shown: ([0-9a-f]{12}) by (\S+) goals ([0-9a-f]{12}) items (\S+)$/;
const SHOWN_ITEM = /^(wl-[^:\s,]+):(u|\d+(?:\.\d+)?):(r|w)(:p)?$/;
export function parseShown(body: string): Shown | null {
	const m = SHOWN.exec(body.trim());
	if (!m || !SHOWN_BY.test(m[2]!)) return null;
	const items: ShownItem[] = [];
	if (m[4] !== "-") {
		for (const part of m[4]!.split(",")) {
			const i = SHOWN_ITEM.exec(part);
			if (!i) return null;
			items.push({ workloadId: i[1]!, score: i[2] === "u" ? null : Number(i[2]), state: i[3] === "r" ? "running" : "waiting", pinned: i[4] !== undefined });
		}
	}
	return { hash: m[1]!, by: m[2]!, goals: m[3]!, items };
}

/**
 * `rank-override: <wl> input <in-id> shown <rank-shown entry id> [pos <k>]`: Jo's "X first", a pin (D4). `pos` is the
 * item's 1-based place in a ruled list (`first: [A, B, …]`, PLAN wl-mv8wzytml878b4 D1); a single `first` has none.
 */
export function formatOverride(o: { workloadId: string; input: string; shown: string; pos?: number }): string {
	return `rank-override: ${o.workloadId} input ${o.input} shown ${o.shown}${o.pos === undefined ? "" : ` pos ${o.pos}`}`;
}
const OVERRIDE = /^rank-override: (wl-\S+) input (in-\S+) shown (\S+?)(?: pos ([1-9]\d*))?$/;
export function parseOverride(body: string): { workloadId: string; input: string; shown: string; pos?: number } | null {
	const m = OVERRIDE.exec(body.trim());
	if (!m) return null;
	return m[4] === undefined ? { workloadId: m[1]!, input: m[2]!, shown: m[3]! } : { workloadId: m[1]!, input: m[2]!, shown: m[3]!, pos: Number(m[4]) };
}

/** `rank-unpin: <wl> input <in-id>`: Jo's "drop the pin on X" (D4). */
export function formatUnpin(u: { workloadId: string; input: string }): string {
	return `rank-unpin: ${u.workloadId} input ${u.input}`;
}
const UNPIN = /^rank-unpin: (wl-\S+) input (in-\S+)$/;
export function parseUnpin(body: string): { workloadId: string; input: string } | null {
	const m = UNPIN.exec(body.trim());
	return m ? { workloadId: m[1]!, input: m[2]! } : null;
}

export interface Audit {
	from: string;
	to: string;
	picks: number;
	scorable: number;
	top1: number;
	top3: number;
	/** Mean percentile of the picks among waiting items; null with no scorable pick. */
	meanpct: number | null;
	/** The report file, an absolute path. */
	report: string;
}
/** `rank-audit: window <from>..<to> picks <n> scorable <s> top1 <k> top3 <m> meanpct <x|unknown> report <abs path>` (D6). */
export function formatAudit(a: Audit): string {
	return `rank-audit: window ${a.from}..${a.to} picks ${a.picks} scorable ${a.scorable} top1 ${a.top1} top3 ${a.top3} meanpct ${a.meanpct === null ? "unknown" : String(a.meanpct)} report ${a.report}`;
}
const AUDIT = /^rank-audit: window (\S+?)\.\.(\S+) picks (\d+) scorable (\d+) top1 (\d+) top3 (\d+) meanpct (\S+) report (\/.*)$/;
export function parseAudit(body: string): Audit | null {
	const m = AUDIT.exec(body.trim());
	if (!m) return null;
	const meanpct = numberOrNull(m[7]!);
	if (meanpct === null && m[7] !== "unknown") return null;
	return { from: m[1]!, to: m[2]!, picks: Number(m[3]), scorable: Number(m[4]), top1: Number(m[5]), top3: Number(m[6]), meanpct, report: m[8]! };
}

// ---- reading the rows --------------------------------------------------------------------------------------------

export interface GoalsInForce {
	/** `set` within 7 days, `stale` after, `none` when Jo never set goals. The seed goals are in force in every state. */
	state: "set" | "stale" | "none";
	/** The newest `rank-goals:` lines, stale or not; [] when none. */
	lines: string[];
	/** Jo's lines in force: `lines` while `state` is `set`, else []. Jev is asked `goalsAsked(asked)`. */
	asked: string[];
	/** goalsHash(asked): the goals every current signal was asked against (D3 currency); stale lines are not in it. */
	hash: string;
	/** The newest `rank-goals:` entry and its time, or null. */
	entryId: string | null;
	setAt: string | null;
	/** The goals line every view prints: `goals: set <day>; seed goal …`, `goals: stale since <day> …`, `goals: none …`. */
	line: string;
}

const SET_GOALS_WORDS = "tell Ilex your goals; it records them with as2_rank { goals, inputId }";
const SEED_WORDS = `seed goal${SEED_GOALS.length === 1 ? "" : "s"}, asked first and never stale: ${SEED_GOALS.map((g) => `"${g}"`).join(", ")}`;

/**
 * The newest valid `rank-goals:` on the standing workload (SURFACE_BY), and whether it is in force at `now` (D3: 7 days).
 * The hash is over the goals actually asked: the seed goals, then Jo's lines only while set, so renewing lapsed lines
 * re-asks every item.
 */
export function currentGoals(ledger: Ledger, now: string): GoalsInForce {
	const control = controlEntries(ledger.entries(STANDING_WORKLOAD_ID));
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "rank-goals") continue;
		const g = parseGoals(c.body);
		if (!g) continue;
		const stale = Date.parse(now) - Date.parse(c.createdAt) > GOALS_STALE_MS;
		const asked = stale ? [] : g.goals;
		const line = stale
			? `goals: stale since ${rankDay(new Date(Date.parse(c.createdAt) + GOALS_STALE_MS).toISOString())} (only the seed goals weigh; ${SEED_WORDS}; ${SET_GOALS_WORDS})`
			: `goals: set ${rankDay(c.createdAt)}; ${SEED_WORDS}`;
		return { state: stale ? "stale" : "set", lines: g.goals, asked, hash: goalsHash(asked), entryId: c.id, setAt: c.createdAt, line };
	}
	return { state: "none", lines: [], asked: [], hash: goalsHash([]), entryId: null, setAt: null, line: `goals: none (only the seed goals weigh; ${SEED_WORDS}; ${SET_GOALS_WORDS})` };
}

/**
 * D3 currency: the signal was asked on this brief and these goals, answers every bool asked today (a signal from
 * before `builds_enforcer` was asked is re-asked), and — when it states a deadline — on today (a dated signal is stale
 * once its `asked-on` is before today, so a `later` deadline is re-read as it comes closer). Undated signals never go
 * stale by date.
 */
export function signalCurrent(signal: Signal, brief: string, goalsHashNow: string, now: string): boolean {
	if (signal.brief !== briefHash(brief) || signal.goals !== goalsHashNow) return false;
	if (!BOOL_NAMES.every((name) => signal.answers[name] !== undefined)) return false;
	return !isDated(signal.answers) || signal.askedOn >= rankDay(now);
}

export type UnscoredReason = "no signal" | "stale signal" | "jev failed";
export interface SignalRead {
	/** The newest signal on this (brief, goals), when it is current at `now`. */
	current: Signal | null;
	/** The newest signal on the workload, whatever it was asked on. */
	newest: Signal | null;
	/** Failed asks on this (brief, goals) since its newest signal. */
	failed: number;
	/** Why the workload has no score, or null when `current` holds one. */
	unscored: UnscoredReason | null;
}

/** The workload's signal rows (RANK_BY's only, `controlEntries`) read against its brief and the goals in force. */
export function readSignal(entries: readonly EntryRow[], brief: string, goalsHashNow: string, now: string): SignalRead {
	const bh = briefHash(brief);
	let newest: Signal | null = null;
	let onPair: Signal | null = null;
	let failed = 0;
	for (const c of controlEntries(entries)) {
		if (c.prefix === "priority-signal") {
			const s = parseSignal(c.body);
			if (!s) continue;
			newest = s;
			if (s.brief === bh && s.goals === goalsHashNow) {
				onPair = s;
				failed = 0;
			}
		} else if (c.prefix === "priority-signal-failed") {
			const f = parseSignalFailed(c.body);
			if (f && f.brief === bh && f.goals === goalsHashNow) failed++;
		}
	}
	const current = onPair !== null && signalCurrent(onPair, brief, goalsHashNow, now) ? onPair : null;
	const unscored: UnscoredReason | null = current !== null ? null : failed >= MAX_SIGNAL_FAILURES ? "jev failed" : newest !== null ? "stale signal" : "no signal";
	return { current, newest, failed, unscored };
}

export interface Pin {
	workloadId: string;
	input: string;
	/** The `rank-shown: … by pick` entry the override names. */
	shown: string;
	/** The item's place in its ruled list (`rank-override: … pos <k>`); absent on a single `first`. */
	pos?: number;
	entryId: string;
	at: string;
}

/**
 * Jo's live pins in rank order (D4; PLAN wl-mv8wzytml878b4 D1): a `rank-override:` lives until its workload closes or a
 * newer `rank-unpin:` names it. One ruling is one input row: the newest ruling first, a ruled list by its `pos`, so a
 * single `first` (no `pos`) sits above every older ruling and older single pins keep newest-first.
 */
export function livePins(ledger: Ledger): Pin[] {
	const control = controlEntries(ledger.entries(STANDING_WORKLOAD_ID));
	const decided = new Set<string>();
	const out: Pin[] = [];
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix === "rank-unpin") {
			const u = parseUnpin(c.body);
			if (u) decided.add(u.workloadId);
		} else if (c.prefix === "rank-override") {
			const o = parseOverride(c.body);
			if (!o || decided.has(o.workloadId)) continue;
			decided.add(o.workloadId);
			if (ledger.workload(o.workloadId)?.status === "open") out.push({ ...o, entryId: c.id, at: c.createdAt });
		}
	}
	// `out` is newest first: a ruling's place is where its newest live override stands; inside it, `pos` (a stable sort).
	const ruling = new Map<string, number>();
	for (const p of out) if (!ruling.has(p.input)) ruling.set(p.input, ruling.size);
	return out.sort((a, b) => ruling.get(a.input)! - ruling.get(b.input)! || (a.pos ?? 0) - (b.pos ?? 0));
}

// ---- the order (D1) ----------------------------------------------------------------------------------------------

export interface RankItem {
	workloadId: string;
	title: string;
	mode: Mode;
	/** `running` while any `lane-*` holder's lease is live (autonomous or interactive), else `waiting`. */
	state: RankState;
	createdAt: string;
	/** Jo's live pin: `pinned (Jo, <input>)`. */
	pinned?: Pin;
	/** Its 1-based place among Jo's ruled (pinned) items in this order: the table's `ruled #k` (PLAN wl-mv8wzytml878b4 D1). */
	pinPos?: number;
	score?: number;
	terms: RankTerms | null;
	flags: string[];
	/** Jev answered `builds_enforcer` above 0.65: ranked in the enforcer band (D1). */
	enforcer: boolean;
	unscored?: UnscoredReason;
}

export interface RankOptions {
	/** Honour Jo's pins (default true); `rankPick` ranks by Jev alone. */
	pins?: boolean;
	/** Leave out `running` items (default false). */
	waitingOnly?: boolean;
}

const olderFirst = (a: RankItem, b: RankItem): number => a.createdAt.localeCompare(b.createdAt) || a.workloadId.localeCompare(b.workloadId);

/**
 * Every open workload in rank order (D1, D4): Jo's pins first (`livePins` order: the newest ruling first, a ruled list by
 * its `pos`), then the enforcer band (scored items Jev says build an enforcer: Jo's machinery-first word of 2026-10-14),
 * then the other scored items, each by score (ties: the older workload first), then unscored items oldest first. Each
 * pinned item carries `pinPos`, its place among the pins. The standing workload and `due:` rows are never
 * ranked; user-driven workloads are. A pure read over stored rows: no judge call, no write.
 */
export function rankOpen(ledger: Ledger, now: string, opts: RankOptions = {}): RankItem[] {
	const goals = currentGoals(ledger, now);
	const pins = opts.pins === false ? [] : livePins(ledger);
	const open = ledger.db.query<WorkloadRow, []>("SELECT * FROM workloads WHERE status = 'open' ORDER BY created_at, id").all();
	const items: RankItem[] = [];
	for (const w of open) {
		if (w.id === STANDING_WORKLOAD_ID || w.brief.startsWith(DUE_PREFIX)) continue;
		const state: RankState = w.holder !== null && w.holder.startsWith("lane-") && heldLive(w, now) ? "running" : "waiting";
		if (opts.waitingOnly && state === "running") continue;
		const read = readSignal(ledger.entries(w.id, "assumption"), w.brief, goals.hash, now);
		const item: RankItem = { workloadId: w.id, title: rankTitle(w.brief), mode: w.mode, state, createdAt: w.created_at, terms: null, flags: [], enforcer: false };
		const pin = pins.find((p) => p.workloadId === w.id);
		if (pin) item.pinned = pin;
		if (read.current) {
			const s = scoreSignal(read.current.answers, read.current.askedOn, now, goals.state === "set");
			item.score = s.score;
			item.terms = s.terms;
			item.flags = s.flags;
			item.enforcer = s.enforcer;
		} else item.unscored = read.unscored!;
		items.push(item);
	}
	const pinned = pins.flatMap((p) => items.filter((i) => i.pinned === p));
	pinned.forEach((i, k) => (i.pinPos = k + 1));
	const scored = items.filter((i) => !i.pinned && i.score !== undefined).sort((a, b) => Number(b.enforcer) - Number(a.enforcer) || b.score! - a.score! || olderFirst(a, b));
	const unscored = items.filter((i) => !i.pinned && i.score === undefined).sort(olderFirst);
	return [...pinned, ...scored, ...unscored];
}

/** The order a pick is audited against (D6): the waiting items alone, Jev's order, pins ignored. */
export function rankPick(ledger: Ledger, now: string): RankItem[] {
	return rankOpen(ledger, now, { pins: false, waitingOnly: true });
}

/** Each ranked workload's 1-based place in `rankOpen`'s order (PLAN wl-mv8wzytml878b4 D1), for the render's `rank #n`. */
export function rankPosition(ledger: Ledger, now: string): Map<string, number> {
	return new Map(rankOpen(ledger, now).map((i, n) => [i.workloadId, n + 1]));
}
