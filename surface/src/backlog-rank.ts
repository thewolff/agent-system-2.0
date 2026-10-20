// The daily Jev re-rank of both backlogs and the board sync (PLAN wl-mvh42n85yo0m4g § 2 D3–D7): the pure logic only.
// Nothing here reads a file, spawns a process or calls the network; surface/scripts/backlog-rank.ts does the effects
// and hands every input in. The question set, the score and its tie rule are plumb-rank/rank.ts's, ported exactly,
// except that its `deadline_day` (dates keyed to the asking day) becomes `deadline_when`, anchored on the day the issue
// was filed, so an unchanged issue's question and answer never change and its cached answer never goes stale (D3, D4).
import { createHash } from "node:crypto";
import { checkJudgmentAnswers, type JudgmentAnswer, type JudgmentQuestions } from "../../classifier/src/judge-ask";

// ---- dates --------------------------------------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `YYYY-MM-DD` as a UTC midnight, for calendar arithmetic only. */
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const addDays = (day: string, n: number): string => new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
const daysFrom = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
const weekday = (day: string): string => WEEKDAYS[new Date(dayMs(day)).getUTCDay()]!;
const dated = (day: string): string => `${weekday(day)} ${day}`;
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(dayMs(s)).toISOString().slice(0, 10) === s;
/** One key of parsed JSON, unknown until checked; undefined when `raw` is not an object. */
const prop = (raw: unknown, key: string): unknown => (typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined);

/** The time zone issues are filed in (D3: the filed day is createdAt in Pacific time). */
export const FILED_TIME_ZONE = "America/Los_Angeles";

/** The calendar day (`YYYY-MM-DD`) of an instant in `timeZone`; the host's own zone when omitted (the run's local day). */
export function calendarDay(instant: string | Date, timeZone?: string): string {
	const date = typeof instant === "string" ? new Date(instant) : instant;
	if (Number.isNaN(date.getTime())) throw new Error(`not an instant: ${String(instant)}`);
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
	const get = (type: string): string => parts.find((p) => p.type === type)!.value;
	return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---- items (D3) ---------------------------------------------------------------------------------------------------

/** The two backlogs: the repo name in pins.json, its owner/name, and the prefix of its item ids. */
export const BACKLOG_REPOS = [
	{ repo: "jo-issues", nameWithOwner: "thewolff/jo-issues", prefix: "jo-issues" },
	{ repo: "agent-system-2.0", nameWithOwner: "thewolff/agent-system-2.0", prefix: "as2" },
] as const;
export type BacklogRepo = (typeof BACKLOG_REPOS)[number]["repo"];
/** `gh issue list --limit`: a list this long may be cut short, so it refuses the run (D3). */
export const ISSUE_LIST_LIMIT = 1000;
/** The judged text is the title plus this many characters of the body, as open-items-1220.json built it (D3). */
export const BODY_CHARS = 600;

/** One issue as `gh issue list --json id,number,title,body,createdAt` returns it. */
export interface GhIssue {
	/** The issue's node id: the content id a board item is added by. */
	id: string;
	number: number;
	title: string;
	body: string;
	createdAt: string;
}

export interface BacklogItem {
	/** `jo-issues#N` or `as2#N`. */
	id: string;
	repo: BacklogRepo;
	number: number;
	contentId: string;
	title: string;
	/** What Jev judges: the title, a blank line, the first BODY_CHARS characters of the body. */
	text: string;
	createdAt: string;
	/** createdAt's day in Pacific time. */
	filed: string;
}

/** The items of one repo's open-issue list; a list of ISSUE_LIST_LIMIT or more, or a malformed entry, throws. */
export function itemsFromIssues(repo: BacklogRepo, list: unknown): BacklogItem[] {
	const r = BACKLOG_REPOS.find((x) => x.repo === repo);
	if (!r) throw new Error(`not a backlog repo: ${repo}`);
	if (!Array.isArray(list)) throw new Error(`${r.nameWithOwner}: the issue list is not a list`);
	if (list.length >= ISSUE_LIST_LIMIT) throw new Error(`${r.nameWithOwner}: ${list.length} open issues listed, at the --limit ${ISSUE_LIST_LIMIT}; the list may be incomplete`);
	return list.map((raw: unknown, i) => {
		const [id, number, title, body, createdAt] = ["id", "number", "title", "body", "createdAt"].map((k) => prop(raw, k));
		const ok = typeof id === "string" && id !== "" && typeof number === "number" && Number.isInteger(number) && number > 0 && typeof title === "string"
			&& typeof body === "string" && typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt));
		if (!ok) throw new Error(`${r.nameWithOwner}: issue list entry ${i} lacks id, number, title, body or createdAt`);
		return {
			id: `${r.prefix}#${number}`,
			repo: r.repo,
			number,
			contentId: id,
			title,
			text: `${title}\n\n${body.slice(0, BODY_CHARS)}`,
			createdAt,
			filed: calendarDay(createdAt, FILED_TIME_ZONE),
		};
	});
}

// ---- goals (D2) ---------------------------------------------------------------------------------------------------

/** goals.md's `goal: ` lines, verbatim and in order, as rank.ts reads them. */
export function parseGoals(text: string): string[] {
	return text.split("\n").filter((l) => l.startsWith("goal: ")).map((l) => l.slice("goal: ".length).trim());
}

// ---- calendar-date candidates (D3) --------------------------------------------------------------------------------

export const MAX_DATE_CANDIDATES = 6;
/** A month-name date with no year takes the year that puts it nearest the filed day, within this window. */
export const YEARLESS_WINDOW = { before: 60, after: 305 } as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const MONTH_DATE = /(?<![A-Za-z])(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?[ \t]+((?:19|20)\d{2})(?!\d))?/gi;
/** Lowercase month words that are ordinary English ("may", "march") are not read as dates. */
const ENGLISH_WORDS: Record<string, true> = { may: true, march: true };

const pad = (n: number): string => String(n).padStart(2, "0");
/** `YYYY-MM-DD` when year/month/day name a real calendar day. */
function realDay(year: number, month: number, day: number): string | null {
	const d = new Date(Date.UTC(year, month - 1, day));
	return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null;
}

/**
 * Every calendar date in `text`, in text order, de-duplicated, at most MAX_DATE_CANDIDATES (D3). ISO `YYYY-MM-DD`, and
 * a month name (or its abbreviation) with a day and an optional year. A missing year is the one that puts the date
 * nearest `filed` within −60 to +305 days; a date that fits no year there is dropped. Past dates are kept.
 */
export function dateCandidates(text: string, filed: string): string[] {
	if (!isDay(filed)) throw new Error(`filed is not a day: ${filed}`);
	const found: { at: number; day: string }[] = [];
	for (const m of text.matchAll(ISO_DATE)) {
		const day = realDay(Number(m[1]), Number(m[2]), Number(m[3]));
		if (day) found.push({ at: m.index!, day });
	}
	for (const m of text.matchAll(MONTH_DATE)) {
		if (ENGLISH_WORDS[m[1]!]) continue;
		const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
		const day = Number(m[2]);
		let best: string | null = null;
		if (m[3]) best = realDay(Number(m[3]), month, day);
		else {
			const year = Number(filed.slice(0, 4));
			for (const y of [year - 1, year, year + 1]) {
				const d = realDay(y, month, day);
				if (!d) continue;
				const off = daysFrom(filed, d);
				if (off < -YEARLESS_WINDOW.before || off > YEARLESS_WINDOW.after) continue;
				if (best === null || Math.abs(off) < Math.abs(daysFrom(filed, best))) best = d;
			}
		}
		if (best) found.push({ at: m.index!, day: best });
	}
	const out: string[] = [];
	for (const { day } of found.sort((a, b) => a.at - b.at)) {
		if (!out.includes(day)) out.push(day);
		if (out.length === MAX_DATE_CANDIDATES) break;
	}
	return out;
}

// ---- the Jev question set (D3) ------------------------------------------------------------------------------------

/**
 * Bumped whenever the question set or its wording changes: it is part of every cache key (D4), so a new version
 * re-asks every item once.
 */
export const QUESTIONS_VERSION = "backlog-rank-1";

export const GOAL_LEVELS = [
	"Unrelated: the work does nothing for this goal.",
	"Touches it: the work is near the goal's topic but does not move it forward.",
	"Partly delivers it: the work moves this goal forward in part.",
	"Delivers it: completing the work directly achieves or largely achieves this goal.",
] as const;

const DATE_LABELS = Array.from({ length: MAX_DATE_CANDIDATES }, (_, i) => `date-${i + 1}`);
/** `deadline_when`'s labels: none, one per candidate slot, then windows relative to the filed day, then later. */
export const DEADLINE_LABELS = ["none", ...DATE_LABELS, "same-day", "next-day", "2-3-days", "4-7-days", "later"] as const;
/** Each relative label's window in days after the filed day, inclusive (D3). */
const RELATIVE_WINDOWS: Record<string, readonly [number, number]> = { "same-day": [0, 0], "next-day": [1, 1], "2-3-days": [2, 3], "4-7-days": [4, 7] };

/** The state Jev judges: the goal lines, the judged text, the filed day with its weekday, and the numbered dates. */
export function judgeState(goals: readonly string[], item: Pick<BacklogItem, "text" | "filed">, candidates: readonly string[]): { goals: string[]; item: string; filed: string; dates: string } {
	const dates = candidates.length === 0 ? "none" : candidates.map((d, i) => `[${i + 1}] ${d}`).join(" ");
	return { goals: [...goals], item: item.text, filed: `${item.filed} (${weekday(item.filed)})`, dates };
}

/**
 * The questions for one item, for classifier/src/judge-ask.ts `askJudgment`: rank.ts's set (goal_<i> per goal line,
 * unblocks_jo, cuts_spend, fixes_breakage, states_deadline, irreversible) with `deadline_when` in place of
 * `deadline_day`. Nothing in it depends on the day it is asked: the windows are written out from `filed`.
 */
export function backlogQuestions(goals: readonly string[], filed: string, candidates: readonly string[]): JudgmentQuestions {
	if (!isDay(filed)) throw new Error(`filed is not a day: ${filed}`);
	const questions: JudgmentQuestions = {};
	goals.forEach((g, i) => {
		questions[`goal_${i}`] = { type: "score", instructions: `How directly does completing the work described in \`item\` advance this goal: "${g}"?`, criteria: [...GOAL_LEVELS] };
	});
	questions.unblocks_jo = {
		type: "bool",
		instructions: "Does completing the work in `item` remove something that currently stops Jo from working, or remove a step Jo now does by hand (pasting, relaying, approving, clicking, checking)?",
		criteria: { true: "Yes: a Jo blocker or a manual Jo step goes away.", false: "No: Jo's own work is unchanged by it." },
	};
	questions.cuts_spend = { type: "bool", instructions: "Is a main purpose of the work in `item` to reduce model spend, token use, or Anthropic subscription quota use?" };
	questions.fixes_breakage = {
		type: "bool",
		instructions: "Does the work in `item` repair something that is broken or wrong right now (a failing test, a crash, a security hole, a wrong output, a resource blow-up)? New features and new capabilities are not repairs.",
	};
	questions.states_deadline = {
		type: "bool",
		instructions: "Does the text of `item` state a due date, a deadline, or a required time (for example \"due Thursday\", \"tonight\", \"before Saturday\")?",
	};
	const criteria: Record<string, string> = { none: "The text states no due date or deadline." };
	DATE_LABELS.forEach((label, i) => {
		const d = candidates[i];
		criteria[label] = d
			? `Candidate [${i + 1}] in \`dates\`, ${dated(d)}, is the date the text states as the deadline.`
			: `There is no candidate [${i + 1}] in \`dates\`; never pick this.`;
	});
	criteria["same-day"] = `Relative wording ("now", "today", "tonight") that puts the deadline on the filed day, ${dated(filed)}.`;
	criteria["next-day"] = `Relative wording ("tomorrow") that puts the deadline on the day after filing, ${dated(addDays(filed, 1))}.`;
	criteria["2-3-days"] = `Relative wording that puts the deadline on ${dated(addDays(filed, 2))} or ${dated(addDays(filed, 3))}.`;
	criteria["4-7-days"] = `Relative wording ("Thursday", "next week") that puts the deadline between ${dated(addDays(filed, 4))} and ${dated(addDays(filed, 7))}.`;
	criteria.later = `Relative wording that puts the deadline after ${dated(addDays(filed, 7))} with no calendar date ("next month").`;
	questions.deadline_when = {
		type: "choice",
		instructions:
			`The text of \`item\` was written on the day it was filed, ${dated(filed)} (\`filed\`). \`dates\` numbers every calendar date found in the text. `
			+ "Which day does the text say the work is due? When the deadline is one of the numbered dates, pick the date-k of the date the text states as the deadline, "
			+ "not the first date it mentions. Pick a relative label only for relative wording (\"tonight\", \"Thursday\", \"next week\"), read against the filed day. "
			+ "Pick \"none\" if the text states no due date.",
		criteria,
	};
	questions.irreversible = {
		type: "bool",
		instructions: "Would the work in `item` change something a git revert cannot undo, such as a live database migration, deleting data, sending messages to people, or publishing to the public?",
	};
	return questions;
}

// ---- the cache (D4) -----------------------------------------------------------------------------------------------

/** sha256 of `{ id, text, filed, goals, questionsVersion }`: nothing in it depends on the run day. */
export function cacheKey(item: Pick<BacklogItem, "id" | "text" | "filed">, goals: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify({ id: item.id, text: item.text, filed: item.filed, goals, questionsVersion: QUESTIONS_VERSION })).digest("hex");
}

/** One cache.jsonl line: one item's answers under its key, with the judge that gave them and what they cost. */
export interface CacheEntry {
	key: string;
	id: string;
	answers: Record<string, JudgmentAnswer>;
	/** `provider/model`, e.g. `typesafe/jev-1.13.0`. */
	judge: string;
	tokens: number | null;
	cost: number | null;
	at: string;
}

export function cacheLine(entry: CacheEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

/** cache.jsonl read: the last line per key wins; a line that is not a whole entry (a torn write) is counted and skipped. */
export function parseCache(text: string): { entries: Map<string, CacheEntry>; skipped: number } {
	const entries = new Map<string, CacheEntry>();
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			skipped++;
			continue;
		}
		const [key, id, answers, judge, tokens, cost, at] = ["key", "id", "answers", "judge", "tokens", "cost", "at"].map((k) => prop(e, k));
		const nullableNumber = (v: unknown): v is number | null => v === null || typeof v === "number";
		if (typeof key !== "string" || typeof id !== "string" || typeof answers !== "object" || answers === null || typeof judge !== "string"
			|| !nullableNumber(tokens) || !nullableNumber(cost) || typeof at !== "string") {
			skipped++;
			continue;
		}
		// The answers' shape is checked where they are used (`checkAnswers`), against the item's questions.
		const stored = answers as Record<string, JudgmentAnswer>;
		entries.set(key, { key, id, answers: stored, judge, tokens, cost, at });
	}
	return { entries, skipped };
}

/** A judge that is not `typesafe/jev-*` fails the run (D4). */
export function isJevJudge(judge: string): boolean {
	return judge.startsWith("typesafe/jev-");
}

/**
 * An answer set checked whole: askJudgment's own shape checks (`checkJudgmentAnswers`), then a `deadline_when` of
 * date-k must name one of the item's candidates (D3, D4). The answers, or why they are malformed. Fresh replies and
 * cached lines both go through this.
 */
export function checkAnswers(questions: JudgmentQuestions, candidates: readonly string[], answers: unknown): { ok: true; answers: Record<string, JudgmentAnswer> } | { ok: false; reason: string } {
	const shaped = checkJudgmentAnswers(questions, answers);
	if (typeof shaped === "string") return { ok: false, reason: `malformed: ${shaped}` };
	const when = shaped.deadline_when;
	if (when?.type === "choice") {
		const k = dateSlot(when.choice);
		if (k !== null && k > candidates.length) return { ok: false, reason: `malformed: deadline_when ${when.choice} names no candidate (${candidates.length} found)` };
	}
	return { ok: true, answers: shaped };
}

const dateSlot = (label: string): number | null => {
	const m = /^date-([1-9]\d*)$/.exec(label);
	return m ? Number(m[1]) : null;
};

// ---- deadlines (D3) -----------------------------------------------------------------------------------------------

/** The days a deadline answer names: one day for a date, the filed-day window for relative wording. */
export interface DeadlineWindow {
	start: string;
	end: string;
}

/** `deadline_when`'s window; null for none and later (they count 0 at every day). A date-k with no candidate throws. */
export function deadlineWindow(choice: string, filed: string, candidates: readonly string[]): DeadlineWindow | null {
	const k = dateSlot(choice);
	if (k !== null) {
		const d = candidates[k - 1];
		if (!d) throw new Error(`deadline_when ${choice} names no candidate`);
		return { start: d, end: d };
	}
	const w = RELATIVE_WINDOWS[choice];
	if (w) return { start: addDays(filed, w[0]), end: addDays(filed, w[1]) };
	if (choice === "none" || choice === "later") return null;
	throw new Error(`deadline_when ${choice} is not a label`);
}

/**
 * Urgency at local day `today`, in D3's order: more than a week past the end → 0 (stale); start − today ≤ 1 → 1 (due
 * today or tomorrow, or overdue within the week); ≤ 3 → 0.5; else 0.
 */
export function deadlineUrgency(window: DeadlineWindow | null, today: string): number {
	if (!window) return 0;
	if (daysFrom(window.end, today) > 7) return 0;
	const left = daysFrom(today, window.start);
	return left <= 1 ? 1 : left <= 3 ? 0.5 : 0;
}

/** One item's urgency at `today` from its `deadline_when`, before the states_deadline rule `scoreItem` applies. */
export function itemUrgency(answers: Record<string, ScoredAnswer>, filed: string, candidates: readonly string[], today: string): { urgency: number; detail: string } {
	const when = answers.deadline_when;
	if (when?.type !== "choice") throw new Error("deadline_when must be choice");
	const window = deadlineWindow(when.choice, filed, candidates);
	const at = window === null ? when.choice : window.start === window.end ? `due ${window.start}` : `due ${window.start}..${window.end}`;
	return { urgency: deadlineUrgency(window, today), detail: `${at} conf ${when.confidence.toFixed(2)}` };
}

// ---- the score (D3: rank.ts, ported exactly) ----------------------------------------------------------------------

export const JEV_WEIGHTS = { goal_max: 0.3, unblocks_jo: 0.2, fixes_breakage: 0.15, urgency: 0.2, cuts_spend: 0.15 } as const;

/** What scoring reads of an answer; askJudgment's JudgmentAnswer is one. */
export type ScoredAnswer =
	| { type: "bool"; bool: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "choice"; choice: string; confidence: number };

/** Uncertain answers do not move the rank: a bool in [0.35, 0.65] counts 0.5 (`?`). */
function noul(a: ScoredAnswer | undefined, name: string): { v: number; mark: string } {
	if (a?.type !== "bool") throw new Error(`${name}: expected bool, got ${a?.type ?? "nothing"}`);
	return a.bool >= 0.35 && a.bool <= 0.65 ? { v: 0.5, mark: "?" } : { v: a.bool, mark: "" };
}
/** A goal Score's level / 3; a confidence below 0.5 counts 0.5 (`?`). */
function goalFrac(a: ScoredAnswer | undefined, name: string): { v: number; mark: string } {
	if (a?.type !== "score") throw new Error(`${name}: expected score, got ${a?.type ?? "nothing"}`);
	return a.confidence < 0.5 ? { v: 0.5, mark: "?" } : { v: a.score / (GOAL_LEVELS.length - 1), mark: "" };
}

export interface ScoredItem {
	/** The unrounded score: the sort key. */
	raw: number;
	/** Rounded to 4 places, as rank.ts prints and the board stores it. */
	score: number;
	reasons: string[];
	flags: string[];
}

/**
 * rank.ts's score of one item: 0.3·best goal + 0.2·unblocks_jo + 0.15·fixes_breakage + 0.2·urgency + 0.15·cuts_spend,
 * summed in that order. `urgency` comes from the deadline function and counts only while states_deadline ≥ 0.5 after
 * the uncertainty rule. An irreversible above 0.65 flags the item.
 */
export function scoreItem(answers: Record<string, ScoredAnswer>, goalCount: number, urgency: number, urgencyDetail = ""): ScoredItem {
	if (goalCount < 1) throw new Error("no goals");
	const g = Array.from({ length: goalCount }, (_, i) => goalFrac(answers[`goal_${i}`], `goal_${i}`));
	const best = g.reduce((m, x, i) => (x.v > g[m]!.v ? i : m), 0);
	const ub = noul(answers.unblocks_jo, "unblocks_jo");
	const fx = noul(answers.fixes_breakage, "fixes_breakage");
	const cs = noul(answers.cuts_spend, "cuts_spend");
	const sd = noul(answers.states_deadline, "states_deadline");
	const u = sd.v >= 0.5 ? urgency : 0;
	const terms = { goal_max: g[best]!.v, unblocks_jo: ub.v, fixes_breakage: fx.v, urgency: u, cuts_spend: cs.v };
	const raw = Object.entries(terms).reduce((s, [k, v]) => s + JEV_WEIGHTS[k as keyof typeof JEV_WEIGHTS] * v, 0);
	const reasons = [
		`goal ${best + 1} ${g[best]!.v.toFixed(2)}${g[best]!.mark} ×${JEV_WEIGHTS.goal_max}`,
		`unblocks_jo ${ub.v.toFixed(2)}${ub.mark} ×${JEV_WEIGHTS.unblocks_jo}`,
		`fixes_breakage ${fx.v.toFixed(2)}${fx.mark} ×${JEV_WEIGHTS.fixes_breakage}`,
		`urgency ${u} (states_deadline ${sd.v.toFixed(2)}${sd.mark}${urgencyDetail ? `, ${urgencyDetail}` : ""}) ×${JEV_WEIGHTS.urgency}`,
		`cuts_spend ${cs.v.toFixed(2)}${cs.mark} ×${JEV_WEIGHTS.cuts_spend}`,
	];
	const irr = noul(answers.irreversible, "irreversible");
	const flags = irr.v > 0.65 ? [`irreversible ${irr.v.toFixed(2)}: needs Jo`] : [];
	return { raw, score: Number(raw.toFixed(4)), reasons, flags };
}

export interface RankInput {
	id: string;
	createdAt: string;
	answers: Record<string, ScoredAnswer>;
	/** The deadline function's value at the run day, before the states_deadline rule. */
	urgency: number;
	urgencyDetail?: string;
}
export interface Ranked extends ScoredItem {
	id: string;
}

/** Jev order: score high to low; ties by created time, then id (rank.ts `byCreated`). */
export function jevRank(inputs: readonly RankInput[], goalCount: number): Ranked[] {
	return inputs
		.map((it) => ({ it, s: scoreItem(it.answers, goalCount, it.urgency, it.urgencyDetail) }))
		.sort((a, b) => b.s.raw - a.s.raw || Date.parse(a.it.createdAt) - Date.parse(b.it.createdAt) || a.it.id.localeCompare(b.it.id))
		.map(({ it, s }) => ({ id: it.id, ...s }));
}

// ---- positional pins (D3) -----------------------------------------------------------------------------------------

/** One pins.json entry (D2). */
export interface Pin {
	repo: BacklogRepo;
	number: number;
	position: number;
	why: string;
}
export interface PlacedPin {
	id: string;
	position: number;
	why: string;
}
export interface SkippedPin extends PlacedPin {
	reason: "closed" | "not found";
}
export type PinCheck = { ok: true; placed: PlacedPin[]; skipped: SkippedPin[] } | { ok: false; reason: string };

/**
 * pins.json checked against the open items, before any Jev call or board write. Refused: not a list, a malformed
 * entry, a position that is not a positive integer, two pins on one position, one issue pinned twice, or an open pin
 * whose position is past the number of open items. A pin whose issue is not open is skipped: `closed` when `closed`
 * names it, else `not found`. `raw` undefined (no pins.json) is no pins.
 */
export function checkPins(raw: unknown, openIds: readonly string[], closed: ReadonlySet<string> = new Set()): PinCheck {
	if (raw === undefined) return { ok: true, placed: [], skipped: [] };
	if (!Array.isArray(raw)) return { ok: false, reason: "pins.json is not a list" };
	const pins: PlacedPin[] = [];
	for (const [i, p] of raw.entries()) {
		const [repoName, number, position, why] = ["repo", "number", "position", "why"].map((k) => prop(p, k));
		const repo = BACKLOG_REPOS.find((r) => r.repo === repoName);
		if (!repo || typeof number !== "number" || !Number.isInteger(number) || number < 1) {
			return { ok: false, reason: `pin ${i + 1} is malformed: it needs repo jo-issues or agent-system-2.0 and a positive issue number` };
		}
		const id = `${repo.prefix}#${number}`;
		if (typeof position !== "number" || !Number.isInteger(position) || position < 1) return { ok: false, reason: `${id}'s position ${JSON.stringify(position)} is not a positive integer` };
		pins.push({ id, position, why: typeof why === "string" ? why : "" });
	}
	for (const [i, a] of pins.entries()) {
		for (const b of pins.slice(i + 1)) {
			if (a.id === b.id) return { ok: false, reason: `${a.id} is pinned twice (positions ${a.position} and ${b.position})` };
			if (a.position === b.position) return { ok: false, reason: `${a.id} and ${b.id} are both pinned to position ${a.position}` };
		}
	}
	const open = new Set(openIds);
	const placed = pins.filter((p) => open.has(p.id));
	for (const p of placed) {
		if (p.position > open.size) return { ok: false, reason: `${p.id} is pinned to position ${p.position}, but only ${open.size} issues are open` };
	}
	const skipped = pins.filter((p) => !open.has(p.id)).map((p): SkippedPin => ({ ...p, reason: closed.has(p.id) ? "closed" : "not found" }));
	return { ok: true, placed, skipped };
}

/** Each placed pin at exactly its position (1-based); every other item fills the remaining positions in Jev order. */
export function applyPins(jevOrder: readonly string[], placed: readonly PlacedPin[]): string[] {
	const out: (string | undefined)[] = new Array(jevOrder.length);
	const pinned = new Set<string>();
	for (const p of placed) {
		if (!jevOrder.includes(p.id) || p.position > jevOrder.length || out[p.position - 1] !== undefined) throw new Error(`pin ${p.id} at ${p.position} cannot be placed; checkPins first`);
		out[p.position - 1] = p.id;
		pinned.add(p.id);
	}
	const rest = jevOrder.filter((id) => !pinned.has(id));
	for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = rest.shift();
	return out as string[];
}

// ---- the run lifecycle (D5, D5a) ----------------------------------------------------------------------------------

export const RUN_PHASES = ["ranking", "writing", "written"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export type RunOutcome = "pending" | "succeeded" | "abandoned";
/** The third failed attempt abandons the run (D5a). */
export const MAX_ATTEMPTS = 3;

/** last-run.json: the newest run (D2, D5a). */
export interface LastRun {
	runId: string;
	/** The local day the run started. */
	day: string;
	phase: RunPhase;
	outcome: RunOutcome;
	commented: boolean;
	/** Attempts started so far. */
	attempts: number;
}

/** last-run.json checked; anything else throws. */
export function parseLastRun(raw: unknown): LastRun {
	const [runId, day, phase, outcome, commented, attempts] = ["runId", "day", "phase", "outcome", "commented", "attempts"].map((k) => prop(raw, k));
	const isPhase = (v: unknown): v is RunPhase => RUN_PHASES.some((p) => p === v);
	const isOutcome = (v: unknown): v is RunOutcome => v === "pending" || v === "succeeded" || v === "abandoned";
	if (typeof runId !== "string" || runId === "" || !isDay(day) || !isPhase(phase) || !isOutcome(outcome) || typeof commented !== "boolean"
		|| typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0 || (commented && outcome === "pending") || (phase === "written") !== (outcome === "succeeded")) {
		throw new Error(`last-run.json is not a run record: ${JSON.stringify(raw)}`);
	}
	return { runId, day, phase, outcome, commented, attempts };
}

/** A run id: the UTC stamp and 4 random hex digits (D5a); the caller supplies the randomness. */
export function newRunId(now: Date, hex4: string): string {
	if (!/^[0-9a-f]{4}$/.test(hex4)) throw new Error(`not 4 hex digits: ${hex4}`);
	return `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z-${hex4}`;
}

export type Due = { action: "resume"; run: LastRun } | { action: "skip"; reason: string } | { action: "start" };

/**
 * D5's due rule, in order: a newest run whose comment is not confirmed is resumed (a new run never replaces it); a run
 * started on `today` that succeeded or was abandoned means no run; else a new run. `now` (`--now`) keeps the first
 * rule and skips the second. After a resumed run is commented, ask again: a `--now` or a new day then starts a run.
 */
export function dueRule(last: LastRun | null, today: string, now = false): Due {
	if (last && !last.commented) return { action: "resume", run: last };
	if (!now && last && last.day === today && last.outcome !== "pending") return { action: "skip", reason: `run ${last.runId} already ${last.outcome} today (${today})` };
	return { action: "start" };
}

/** A new run, recorded before any work: ranking, pending, uncommented, no attempt yet. */
export function startRun(runId: string, day: string): LastRun {
	return { runId, day, phase: "ranking", outcome: "pending", commented: false, attempts: 0 };
}

/** What a fire does with a run it holds: rank, write, post its comment, or nothing. */
export function nextStep(run: LastRun): "rank" | "write" | "comment" | "done" {
	if (run.commented) return "done";
	if (run.outcome !== "pending") return "comment";
	return run.phase === "ranking" ? "rank" : "write";
}

/** An attempt starts: only a pending run is attempted. */
export function beginAttempt(run: LastRun): LastRun {
	if (run.outcome !== "pending") throw new Error(`run ${run.runId} is ${run.outcome}; only its comment is left`);
	return { ...run, attempts: run.attempts + 1 };
}

/** ranking → writing (once the order is written) → written (the board matched on readback, so succeeded). */
export function advance(run: LastRun, phase: "writing" | "written"): LastRun {
	if (run.outcome !== "pending") throw new Error(`run ${run.runId} is ${run.outcome}`);
	const from = RUN_PHASES.indexOf(run.phase);
	const to = RUN_PHASES.indexOf(phase);
	if (to < from || to > from + 1) throw new Error(`run ${run.runId} cannot go from ${run.phase} to ${phase}`);
	return phase === "written" ? { ...run, phase, outcome: "succeeded" } : { ...run, phase };
}

/** An attempt failed: the run stays pending for the next fire, or is abandoned when this was attempt MAX_ATTEMPTS. */
export function failAttempt(run: LastRun): LastRun {
	if (run.outcome !== "pending") throw new Error(`run ${run.runId} is ${run.outcome}`);
	return run.attempts >= MAX_ATTEMPTS ? { ...run, outcome: "abandoned" } : run;
}

/** The comment for the stored outcome is on the issue (posted, or its marker found). */
export function markCommented(run: LastRun): LastRun {
	if (run.outcome === "pending") throw new Error(`run ${run.runId} has no outcome to comment on`);
	return { ...run, commented: true };
}

// ---- the board (D6) -----------------------------------------------------------------------------------------------

export type LaneState = "running" | "parked" | "blocked" | "none";
export const LANE_STATES: readonly LaneState[] = ["running", "parked", "blocked", "none"];
/** The fields the run writes; it never creates one (D6). */
export const RUN_FIELDS = { rank: ["Rank", "NUMBER"], score: ["Jev score", "NUMBER"], rankedAt: ["Ranked at", "TEXT"], laneState: ["Lane state", "SINGLE_SELECT"] } as const;

export interface BoardField {
	id: string;
	name: string;
	dataType: string;
	options?: { id: string; name: string }[];
	[key: string]: unknown;
}
/** Issue-owned values retain their discriminant and scalar/nullability after transport alias normalization. */
export type IssueFieldValue =
	| { __typename: "IssueFieldTextValue" | "IssueFieldDateValue"; value: string }
	| { __typename: "IssueFieldNumberValue"; value: number }
	| { __typename: "IssueFieldSingleSelectValue"; value: string; optionId: string | null }
	| { __typename: "IssueFieldMultiSelectValue"; value: string | null };

/** One fieldValues node, verbatim: `__typename`, its field, and its type's content (`text`, `number`, `optionId`, …). */
export interface BoardValue {
	__typename: string;
	field: { id: string; name: string; dataType: string };
	issueFieldValue?: IssueFieldValue | null;
	[key: string]: unknown;
}
export interface BoardItem {
	id: string;
	/** ISSUE, PULL_REQUEST, DRAFT_ISSUE, REDACTED. */
	type: string;
	contentId: string | null;
	/** owner/name of the content's repository; null for drafts. */
	repo: string | null;
	number: number | null;
	title?: string;
	isArchived: boolean;
	createdAt: string;
	fieldValues: BoardValue[];
}
export interface BoardSnapshot {
	projectId: string;
	fields: BoardField[];
	items: BoardItem[];
}

export interface RunFields {
	rank: string;
	score: string;
	rankedAt: string;
	laneState: { id: string; options: Record<LaneState, string> };
}

/** The four run fields' ids, or why the run is refused: a field missing, doubled or of another type, or Lane state's options not exactly running/parked/blocked/none. */
export function runFields(snapshot: BoardSnapshot): RunFields | string {
	const ids: Partial<Record<keyof typeof RUN_FIELDS, BoardField>> = {};
	for (const [key, [name, dataType]] of Object.entries(RUN_FIELDS) as [keyof typeof RUN_FIELDS, readonly [string, string]][]) {
		const found = snapshot.fields.filter((f) => f.name === name);
		if (found.length === 0) return `the board has no "${name}" field`;
		if (found.length > 1) return `the board has ${found.length} fields named "${name}"`;
		if (found[0]!.dataType !== dataType) return `the board's "${name}" field is ${found[0]!.dataType}, not ${dataType}`;
		ids[key] = found[0]!;
	}
	const options = ids.laneState!.options ?? [];
	const names = options.map((o) => o.name);
	if (names.length !== LANE_STATES.length || !LANE_STATES.every((s) => names.includes(s))) {
		return `the board's "Lane state" options are ${names.join(", ") || "none"}, not exactly ${LANE_STATES.join(", ")}`;
	}
	return {
		rank: ids.rank!.id,
		score: ids.score!.id,
		rankedAt: ids.rankedAt!.id,
		laneState: { id: ids.laneState!.id, options: Object.fromEntries(options.map((o) => [o.name, o.id])) as Record<LaneState, string> },
	};
}

/** `ProjectV2FieldValue`, the input `updateProjectV2ItemFieldValue` takes: exactly one key. */
export type FieldValueInput = { text: string } | { number: number } | { date: string } | { singleSelectOptionId: string } | { iterationId: string } | { multiSelectOptionIds: string[] };

export type BoardOp =
	| { kind: "add"; key: string; contentId: string }
	| { kind: "delete"; key: string; itemId: string; reason: "closed" | "duplicate" | "not in backup" }
	| { kind: "set"; key: string; itemId: string; fieldId: string; field: string; value: FieldValueInput }
	| { kind: "clear"; key: string; itemId: string; fieldId: string; field: string }
	| { kind: "archive" | "unarchive"; key: string; itemId: string };

/** One open issue's wanted card: its position and score, the run's Ranked at stamp, its Lane state. */
export interface DesiredItem {
	/** `jo-issues#N` or `as2#N`. */
	id: string;
	contentId: string;
	rank: number;
	score: number;
	rankedAt: string;
	laneState: LaneState;
}

/** The desired state from the final order: Rank is the position, Jev score the rounded score. */
export function desiredItems(order: readonly string[], items: readonly BacklogItem[], scores: ReadonlyMap<string, number>, rankedAtStamp: string, lanes: ReadonlyMap<string, LaneState>): DesiredItem[] {
	const byId = new Map(items.map((it) => [it.id, it]));
	return order.map((id, i) => {
		const it = byId.get(id);
		const score = scores.get(id);
		if (!it || score === undefined) throw new Error(`${id} is in the order but has no item or score`);
		return { id, contentId: it.contentId, rank: i + 1, score: Number(score.toFixed(4)), rankedAt: rankedAtStamp, laneState: lanes.get(id) ?? "none" };
	});
}

/** An item's short name: `jo-issues#N` / `as2#N` for the backlogs, `owner/repo#N` for others, the item id for a draft. */
export function boardKey(item: Pick<BoardItem, "id" | "repo" | "number">): string {
	if (item.repo === null || item.number === null) return item.id;
	const r = BACKLOG_REPOS.find((x) => x.nameWithOwner === item.repo);
	return r ? `${r.prefix}#${item.number}` : `${item.repo}#${item.number}`;
}

const isBacklogIssue = (item: BoardItem): boolean => item.type === "ISSUE" && item.number !== null && BACKLOG_REPOS.some((r) => r.nameWithOwner === item.repo);
const oldestFirst = (a: BoardItem, b: BoardItem): number => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
const valueOf = (item: BoardItem, fieldId: string): BoardValue | undefined => item.fieldValues.find((v) => v.field.id === fieldId);

export interface BoardDiff {
	adds: Extract<BoardOp, { kind: "add" }>[];
	deletes: Extract<BoardOp, { kind: "delete" }>[];
	updates: Extract<BoardOp, { kind: "set" }>[];
}

/**
 * What the board needs to match the desired state (D6): an add per open issue with no card; a delete per card whose
 * backlog issue is not open, and per duplicate card of one issue except the oldest; a set per Rank, Jev score, Ranked
 * at or Lane state that differs on a kept card. Cards of other repos, pull requests and drafts are not touched.
 * Re-run on a fresh snapshot after every batch, it is also the reconcile: whatever already landed drops out.
 */
export function boardDiff(snapshot: BoardSnapshot, desired: readonly DesiredItem[]): { ok: true; diff: BoardDiff } | { ok: false; reason: string } {
	const fields = runFields(snapshot);
	if (typeof fields === "string") return { ok: false, reason: fields };
	const want = new Map(desired.map((d) => [d.id, d]));
	const cards = new Map<string, BoardItem[]>();
	for (const item of snapshot.items.filter(isBacklogIssue).sort(oldestFirst)) {
		const key = boardKey(item);
		cards.set(key, [...(cards.get(key) ?? []), item]);
	}
	const diff: BoardDiff = { adds: [], deletes: [], updates: [] };
	for (const [key, items] of cards) {
		if (!want.has(key)) {
			for (const item of items) diff.deletes.push({ kind: "delete", key, itemId: item.id, reason: "closed" });
			continue;
		}
		for (const item of items.slice(1)) diff.deletes.push({ kind: "delete", key, itemId: item.id, reason: "duplicate" });
	}
	for (const d of desired) {
		const card = cards.get(d.id)?.[0];
		if (!card) {
			diff.adds.push({ kind: "add", key: d.id, contentId: d.contentId });
			continue;
		}
		const set = (fieldId: string, field: string, value: FieldValueInput) => diff.updates.push({ kind: "set", key: d.id, itemId: card.id, fieldId, field, value });
		const num = (fieldId: string) => valueOf(card, fieldId)?.number;
		const rank = num(fields.rank);
		if (typeof rank !== "number" || Math.abs(rank - d.rank) > 1e-9) set(fields.rank, "Rank", { number: d.rank });
		const score = num(fields.score);
		if (typeof score !== "number" || Math.abs(score - d.score) > 1e-9) set(fields.score, "Jev score", { number: d.score });
		if (valueOf(card, fields.rankedAt)?.text !== d.rankedAt) set(fields.rankedAt, "Ranked at", { text: d.rankedAt });
		const option = fields.laneState.options[d.laneState];
		if (valueOf(card, fields.laneState.id)?.optionId !== option) set(fields.laneState.id, "Lane state", { singleSelectOptionId: option });
	}
	return { ok: true, diff };
}

/** At most this many aliased mutations go in one request (D6). */
export const MAX_MUTATIONS_PER_REQUEST = 10;
/** The pause between mutation requests; GitHub asks for at least 1 s between mutations (D6). */
export const MUTATION_PAUSE_MS = 1500;

export interface MutationBatch {
	query: string;
	variables: Record<string, unknown>;
	ops: BoardOp[];
}

/** `ops` cut into requests of at most `size` aliased mutations (`m0`…), in order, every id passed as a variable. */
export function mutationBatches(projectId: string, ops: readonly BoardOp[], size = MAX_MUTATIONS_PER_REQUEST): MutationBatch[] {
	if (!Number.isInteger(size) || size < 1 || size > MAX_MUTATIONS_PER_REQUEST) throw new Error(`batch size ${size} is not 1..${MAX_MUTATIONS_PER_REQUEST}`);
	const batches: MutationBatch[] = [];
	for (let at = 0; at < ops.length; at += size) {
		const chunk = ops.slice(at, at + size);
		const decls = ["$p: ID!"];
		const fields: string[] = [];
		const variables: Record<string, unknown> = { p: projectId };
		chunk.forEach((op, i) => {
			const item = (itemId: string) => {
				decls.push(`$i${i}: ID!`);
				variables[`i${i}`] = itemId;
			};
			if (op.kind === "add") {
				decls.push(`$c${i}: ID!`);
				variables[`c${i}`] = op.contentId;
				fields.push(`m${i}: addProjectV2ItemById(input: {projectId: $p, contentId: $c${i}}) { item { id } }`);
			} else if (op.kind === "delete") {
				item(op.itemId);
				fields.push(`m${i}: deleteProjectV2Item(input: {projectId: $p, itemId: $i${i}}) { deletedItemId }`);
			} else if (op.kind === "set") {
				item(op.itemId);
				decls.push(`$f${i}: ID!`, `$v${i}: ProjectV2FieldValue!`);
				variables[`f${i}`] = op.fieldId;
				variables[`v${i}`] = op.value;
				fields.push(`m${i}: updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i${i}, fieldId: $f${i}, value: $v${i}}) { projectV2Item { id } }`);
			} else if (op.kind === "clear") {
				item(op.itemId);
				decls.push(`$f${i}: ID!`);
				variables[`f${i}`] = op.fieldId;
				fields.push(`m${i}: clearProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i${i}, fieldId: $f${i}}) { projectV2Item { id } }`);
			} else {
				item(op.itemId);
				fields.push(`m${i}: ${op.kind}ProjectV2Item(input: {projectId: $p, itemId: $i${i}}) { item { id } }`);
			}
		});
		batches.push({ query: `mutation(${decls.join(", ")}) {\n  ${fields.join("\n  ")}\n}`, variables, ops: chunk });
	}
	return batches;
}

/**
 * The value types the run and undo may write, by `__typename` (D6); multi-select only where the live schema has it. The
 * Title field's value comes back as a text value but is the issue's own title: content-derived, never written.
 */
function writableValue(v: BoardValue, multiSelect: boolean): FieldValueInput | null | undefined {
	if (v.field.dataType === "TITLE") return undefined;
	switch (v.__typename) {
		case "ProjectV2ItemFieldTextValue":
			return typeof v.text === "string" ? { text: v.text } : null;
		case "ProjectV2ItemFieldNumberValue":
			return typeof v.number === "number" ? { number: v.number } : null;
		case "ProjectV2ItemFieldDateValue":
			return typeof v.date === "string" ? { date: v.date } : null;
		case "ProjectV2ItemFieldSingleSelectValue":
			return typeof v.optionId === "string" ? { singleSelectOptionId: v.optionId } : null;
		case "ProjectV2ItemFieldIterationValue":
			return typeof v.iterationId === "string" ? { iterationId: v.iterationId } : null;
		case "ProjectV2ItemFieldMultiSelectValue":
			if (!multiSelect) return undefined;
			{
				const ids = Array.isArray(v.options) ? v.options.map((o: unknown) => prop(o, "id")) : null;
				return ids !== null && ids.every((x): x is string => typeof x === "string") ? { multiSelectOptionIds: ids } : null;
			}
		default:
			return undefined; // content-derived: labels, users, milestone, repository, pull requests, reviewers, issue fields
	}
}

/** JSON with sorted keys, so two verbatim nodes compare by content. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export interface UndoPlan {
	/** In apply order: deletes, adds, unarchives, sets and clears, archives. */
	ops: BoardOp[];
	/** Backup state no mutation can bring back (a deleted draft, a second card for one issue, a deleted field). */
	unrestorable: string[];
	/** Content-derived values that differ from the backup: listed, never written. */
	contentDiffs: string[];
}

/**
 * What makes the board's item set, writable values and archive state match `backup` (D6). Cards are matched by item
 * id, then by content id (a re-added card has a new item id). A backup card with no card for its content is re-added;
 * a card absent from the backup is deleted; every writable value that differs is set, or cleared when the backup had
 * none; archive state follows the backup. A re-added card's values come on the next plan, from the snapshot read
 * after the add, so applying plans until one is empty finishes the undo, and re-running it after a failure does too.
 */
export function undoPlan(backup: BoardSnapshot, current: BoardSnapshot, opts: { multiSelect: boolean }): UndoPlan {
	const plan = { deletes: [] as BoardOp[], adds: [] as BoardOp[], unarchive: [] as BoardOp[], values: [] as BoardOp[], archive: [] as BoardOp[] };
	const unrestorable: string[] = [];
	const contentDiffs: string[] = [];
	const pairs: [BoardItem, BoardItem][] = [];
	const free = new Map(current.items.map((i) => [i.id, i]));
	const unmatched: BoardItem[] = [];
	for (const b of [...backup.items].sort(oldestFirst)) {
		const c = free.get(b.id);
		if (c) {
			pairs.push([b, c]);
			free.delete(b.id);
		} else unmatched.push(b);
	}
	for (const b of unmatched) {
		const c = b.contentId === null ? undefined : [...free.values()].sort(oldestFirst).find((x) => x.contentId === b.contentId);
		if (c) {
			pairs.push([b, c]);
			free.delete(c.id);
			continue;
		}
		const key = boardKey(b);
		if (b.type === "DRAFT_ISSUE" || b.contentId === null) unrestorable.push(`${key}: a deleted ${b.type === "DRAFT_ISSUE" ? "draft" : "card with no content"} cannot be re-added`);
		else if (current.items.some((x) => x.contentId === b.contentId) || plan.adds.some((a) => a.kind === "add" && a.contentId === b.contentId)) {
			unrestorable.push(`${key}: the backup had a second card for this issue; a project holds one`);
		} else plan.adds.push({ kind: "add", key, contentId: b.contentId });
	}
	for (const c of free.values()) plan.deletes.push({ kind: "delete", key: boardKey(c), itemId: c.id, reason: "not in backup" });
	const fieldName = new Map(current.fields.map((f) => [f.id, f.name]));
	for (const [b, c] of pairs) {
		const key = boardKey(c);
		if (b.isArchived !== c.isArchived) (b.isArchived ? plan.archive : plan.unarchive).push({ kind: b.isArchived ? "archive" : "unarchive", key, itemId: c.id });
		const fieldIds = new Set([...b.fieldValues, ...c.fieldValues].map((v) => v.field.id));
		for (const fieldId of fieldIds) {
			const bv = valueOf(b, fieldId);
			const cv = valueOf(c, fieldId);
			const name = bv?.field.name ?? cv!.field.name;
			const bw = bv ? writableValue(bv, opts.multiSelect) : null;
			const cw = cv ? writableValue(cv, opts.multiSelect) : null;
			if (bw === undefined || cw === undefined) {
				if (stable(bv ?? null) !== stable(cv ?? null)) contentDiffs.push(`${key} ${name}: backup ${bv ? stable(bv) : "none"}, now ${cv ? stable(cv) : "none"}`);
				continue;
			}
			if (stable(bw) === stable(cw)) continue;
			if (!fieldName.has(fieldId)) {
				unrestorable.push(`${key} ${name}: the field is gone from the board`);
				continue;
			}
			plan.values.push(bw === null ? { kind: "clear", key, itemId: c.id, fieldId, field: name } : { kind: "set", key, itemId: c.id, fieldId, field: name, value: bw });
		}
	}
	return { ops: [...plan.deletes, ...plan.adds, ...plan.unarchive, ...plan.values, ...plan.archive], unrestorable, contentDiffs };
}

/** The Rank each backlog card held in the backup, by `jo-issues#N` / `as2#N` (null when it had none): a comment's "before". */
export function previousRanks(backup: BoardSnapshot): Map<string, number | null> {
	const rank = backup.fields.find((f) => f.name === RUN_FIELDS.rank[0])?.id;
	const out = new Map<string, number | null>();
	for (const item of backup.items.filter(isBacklogIssue).sort(oldestFirst)) {
		const key = boardKey(item);
		if (out.get(key) != null) continue;
		const n = rank === undefined ? undefined : valueOf(item, rank)?.number;
		out.set(key, typeof n === "number" ? n : null);
	}
	return out;
}

// ---- the #153 comment (D7) ----------------------------------------------------------------------------------------

/** `<!-- as2-backlog-rank run <run-id> -->`: one per run id on the comment issue. */
export function commentMarker(runId: string): string {
	return `<!-- as2-backlog-rank run ${runId} -->`;
}

/** Whether any existing comment already carries this run's marker. */
export function hasRunComment(comments: readonly { body?: string | null }[], runId: string): boolean {
	const marker = commentMarker(runId);
	return comments.some((c) => typeof c.body === "string" && c.body.includes(marker));
}

export function undoCommand(backupPath: string): string {
	const argument = /^[A-Za-z0-9_./-]+$/.test(backupPath) ? backupPath : `'${backupPath.replace(/'/g, "'\\''")}'`;
	return `as2 backlog-rank --undo ${argument}`;
}

export interface RankMoves {
	/** Items with no card before the run, with their new rank. */
	added: { id: string; rank: number }[];
	/** Cards before the run whose issue is no longer in the order. */
	left: string[];
	/** The top 10, each with its Rank before the run (null: no card, or no Rank). */
	top: { id: string; rank: number; before: number | null; added: boolean }[];
	/** Items below the top 10 whose Rank changed. */
	otherMoves: number;
}
export const TOP_N = 10;

/** The moves of the new order against the backup's Rank values. */
export function rankMoves(order: readonly string[], before: ReadonlyMap<string, number | null>): RankMoves {
	const added = order.flatMap((id, i) => (before.has(id) ? [] : [{ id, rank: i + 1 }]));
	const inOrder = new Set(order);
	const left = [...before.keys()].filter((id) => !inOrder.has(id));
	const top = order.slice(0, TOP_N).map((id, i) => ({ id, rank: i + 1, before: before.get(id) ?? null, added: !before.has(id) }));
	const otherMoves = order.slice(TOP_N).filter((id, i) => {
		const b = before.get(id);
		return b != null && b !== i + 1 + TOP_N;
	}).length;
	return { added, left, top, otherMoves };
}

export interface RunComment {
	runId: string;
	outcome: "succeeded" | "abandoned";
	/** Abandoned: the phase it stopped in, writes done of the planned total, the last error. */
	failure?: { phase: RunPhase; attempts: number; writesDone: number; writesTotal: number; error: string };
	/** Open items per backlog repo. */
	counts?: Partial<Record<BacklogRepo, number>>;
	pins?: { placed: readonly PlacedPin[]; skipped: readonly SkippedPin[] };
	moves?: RankMoves;
	titles?: ReadonlyMap<string, string>;
	jev?: { cost: number; newCalls: number };
	orderPath?: string;
	backupPath?: string | null;
}

const ordinal = (n: number): string => {
	const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
	return `${n}${s}`;
};

/** The #153 comment for one run (D7), marker first. */
export function commentBody(c: RunComment): string {
	const name = (id: string): string => (c.titles?.get(id) ? `${c.titles.get(id)} (${id})` : id);
	const out: string[] = [commentMarker(c.runId)];
	if (c.outcome === "succeeded") out.push(`**Backlog re-rank ${c.runId}: done**`);
	else {
		const f = c.failure;
		out.push(`**Backlog re-rank ${c.runId}: failed after ${f?.attempts ?? MAX_ATTEMPTS} attempts**`);
		if (f) out.push("", `It stopped in the ${f.phase} phase, with ${f.writesDone} of ${f.writesTotal} board writes done. Last error: ${f.error}`);
	}
	if (c.counts) {
		const parts = BACKLOG_REPOS.filter((r) => c.counts![r.repo] !== undefined).map((r) => `${c.counts![r.repo]} in ${r.repo}`);
		const total = Object.values(c.counts).reduce((s, n) => s + (n ?? 0), 0);
		out.push("", `Ranked ${total} open issues: ${parts.join(", ")}.`);
	}
	if (c.pins && (c.pins.placed.length > 0 || c.pins.skipped.length > 0)) {
		if (c.pins.placed.length > 0) out.push(`Pins applied: ${c.pins.placed.map((p) => `${p.id} ${ordinal(p.position)}`).join(", ")}.`);
		if (c.pins.skipped.length > 0) out.push(`Pins skipped: ${c.pins.skipped.map((p) => `${p.id} (${p.reason}, was for ${ordinal(p.position)})`).join(", ")}.`);
	}
	const m = c.moves;
	if (m) {
		if (m.added.length > 0) out.push("", "**New on the board**", ...m.added.map((a) => `- ${name(a.id)}: ${ordinal(a.rank)}`));
		if (m.left.length > 0) out.push("", "**Left the board**", ...m.left.map((id) => `- ${name(id)}`));
		if (m.top.length > 0) {
			out.push("", `**Top ${m.top.length}**`, ...m.top.map((t) => {
				const move = t.added ? "new" : t.before === null ? "no rank before" : t.before === t.rank ? "same" : `${t.before > t.rank ? "up" : "down"} from ${ordinal(t.before)}`;
				return `${t.rank}. ${name(t.id)}: ${move}`;
			}));
		}
		out.push("", `Other moves: ${m.otherMoves} ${m.otherMoves === 1 ? "item" : "items"} below the top ${TOP_N} changed rank.`);
	}
	if (c.jev) out.push("", `Jev: ${c.jev.newCalls} new ${c.jev.newCalls === 1 ? "call" : "calls"}, $${c.jev.cost.toFixed(4)}.`);
	const files: string[] = [];
	if (c.orderPath) files.push(`- Order: \`${c.orderPath}\``);
	if (c.backupPath) files.push(`- Undo the board: \`${undoCommand(c.backupPath)}\``);
	if (files.length > 0) out.push("", ...files);
	return `${out.join("\n")}\n`;
}

// ---- ported from plumb-rank/rank-issues.ts ------------------------------------------------------------------------

/** jo-issues references in a text: `jo-issues#N`, the issue URL, or `Jo's issue N`. */
export function issueReferences(text: string): number[] {
	const pattern = /(?<![\w/-])(?:jo-issues#|https:\/\/github\.com\/thewolff\/jo-issues\/issues\/|Jo['’]s issue\s+)([1-9]\d*)\b/gi;
	return [...new Set([...text.matchAll(pattern)].map((m) => Number(m[1])))];
}

export interface LaneWorkload {
	id: string;
	brief: string;
	status: string;
	created_at: string;
	lease_at: string | null;
	message: { state: string; body: string } | null;
}
export interface LaneInstruction {
	workload_id: string;
	body: string;
}

/**
 * Each jo-issues number's Lane state from the ledger's workloads: the newest open workload whose brief or
 * instructions reference it is `blocked` when its last lane message is held on a question or refusal, `running` when
 * its lease is under two minutes old, else `parked`; no open workload is `none`.
 */
export function laneStates(issues: readonly { number: number }[], workloads: readonly LaneWorkload[], instructions: readonly LaneInstruction[], now = Date.now()) {
	const links = new Map<string, Set<number>>();
	for (const w of workloads) if (w.id !== "wl-orchestrator") links.set(w.id, new Set(issueReferences(w.brief)));
	for (const i of instructions) for (const n of issueReferences(i.body)) links.get(i.workload_id)?.add(n);
	return issues.map((issue) => {
		const matches = workloads
			.filter((w) => links.get(w.id)?.has(issue.number))
			.sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
		const w = matches[0];
		let state: LaneState = "none";
		if (w?.status === "open") {
			const message = w.message;
			const blocked = message?.state === "held" && /\b(?:question|refus(?:al|ed|es|ing|e)|blocked)\b|\?|\b(?:cannot|can't|unable to) (?:proceed|continue|run|start)\b/i.test(message.body);
			const age = now - Date.parse(w.lease_at ?? "");
			state = blocked ? "blocked" : age >= 0 && age <= 120000 ? "running" : "parked";
		}
		return { number: issue.number, state, workload: w?.id ?? null, candidates: matches.map((m) => m.id), leaseAt: w?.lease_at ?? null };
	});
}

/** Lane state per item id: jo-issues items from `laneStates`, as2 items `none` (D3, as on 2026-10-20). */
export function itemLaneStates(items: readonly Pick<BacklogItem, "id" | "repo" | "number">[], workloads: readonly LaneWorkload[], instructions: readonly LaneInstruction[], now = Date.now()): Map<string, LaneState> {
	const ji = items.filter((it) => it.repo === "jo-issues");
	const states = new Map(laneStates(ji, workloads, instructions, now).map((s) => [s.number, s.state]));
	return new Map(items.map((it) => [it.id, it.repo === "jo-issues" ? (states.get(it.number) ?? "none") : "none"]));
}

/** The Ranked at stamp: `12:10 PM PDT Oct 20`, Pacific time. */
export function rankedAt(date = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short", month: "short", day: "numeric" }).formatToParts(date);
	const get = (type: string): string => parts.find((p) => p.type === type)!.value;
	return `${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")} ${get("month")} ${get("day")}`;
}

/**
 * rank.ts's printed ranking read back: every `N. <title> (<id>)  score <s>` line and the `jev cost $<c> job <j>` line.
 * Throws unless the lines are a complete, unique permutation of `items` with finite scores and a cost line.
 */
export function parseRanking(output: string, items: readonly { id: string; title: string }[]): { ranked: { id: string; title: string; score: number }[]; cost: number; job: string } {
	const found = [...output.matchAll(/^[ \t]*\d+\. .* \(((?:jo-issues|as2)#\d+)\)  score ([\d.]+)(?:  \[.*\])?$/gm)];
	const byId = new Map(items.map((i) => [i.id, i]));
	const ranked = found.map((m) => ({ id: m[1]!, title: byId.get(m[1]!)?.title ?? "", score: Number(m[2]) }));
	const cost = output.match(/^jev cost \$([\d.]+) job (\S+)$/m);
	if (!cost || ranked.length !== items.length || new Set(ranked.map((r) => r.id)).size !== items.length || ranked.some((r) => !byId.has(r.id) || !Number.isFinite(r.score))) {
		throw new Error("Ranker output is not a complete unique permutation with cost; refusing sync");
	}
	return { ranked, cost: Number(cost[1]), job: cost[2]! };
}
