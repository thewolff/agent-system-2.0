// new guard: no fail-before
//
// sl-br-core of wl-mvh42n85yo0m4g (PLAN § 2 D3–D7; Requirements R2, R6, R11, R12, R13): the pure backlog re-rank logic
// surface/src/backlog-rank.ts, which does not exist before this slice, so this file fails on its import until the build.
// The effects (gh, the board, the judge, the state dir) are surface/test/backlog-rank-run.test.ts's.
//
// R12's fixture, fixtures/backlog-rank-1220/, is the 2026-10-20 12:09 PDT run of plumb-rank/rank.ts:
//   - rank-1220.out and GOALS.md, verbatim from agent-scratch/agent-system-2.0/rank-1020/;
//   - answers-1220.jsonl: per item, plumb-rank/answers/open-items-1220.jsonl's answers (without each answer's `legend`
//     and `probabilities`, which scoring never reads) joined with rank-1020/open-items-1220.json's title and created.
// Those answers carry rank.ts's old `deadline_day` choice; the replay maps it through rank.ts's URGENCY map for that day
// (PLAN D3: the mapping is fixture-side) and checks the formula, the ties and the order.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askJudgment, type JudgmentAnswer, type JudgmentJudge } from "../../classifier/src/judge-ask";
import {
	advance, applyPins, backlogQuestions, type BoardItem, type BoardSnapshot, type BoardValue, beginAttempt, boardDiff, cacheKey, cacheLine, calendarDay,
	checkAnswers, checkPins, commentBody, commentMarker, DEADLINE_LABELS, dateCandidates, deadlineUrgency, deadlineWindow, desiredItems, dueRule,
	FILED_TIME_ZONE, failAttempt, hasRunComment, isJevJudge, issueReferences, itemLaneStates, itemsFromIssues, itemUrgency, jevRank, judgeState,
	type LastRun, laneStates, MAX_ATTEMPTS, markCommented, mutationBatches, newRunId, nextStep, parseCache, parseGoals, parseLastRun, parseRanking,
	previousRanks, QUESTIONS_VERSION, type RankInput, rankedAt, rankMoves, type ScoredAnswer, scoreItem, startRun, undoCommand, undoPlan,
} from "../src/backlog-rank";

const FIXTURE = join(import.meta.dir, "fixtures", "backlog-rank-1220");
const GOALS = ["Work flows to main.", "Spend less per unit of work."];

/** A whole answer set in askJudgment's typed form; `over` replaces single answers. */
function answers(over: Record<string, JudgmentAnswer> = {}): Record<string, JudgmentAnswer> {
	const score = (s: number): JudgmentAnswer => ({ type: "score", score: s, confidence: 0.9, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 } });
	const bool = (b: number): JudgmentAnswer => ({ type: "bool", bool: b });
	const when = Object.fromEntries(DEADLINE_LABELS.map((l) => [l, l === "none" ? 1 : 0]));
	return {
		goal_0: score(2), goal_1: score(1), unblocks_jo: bool(0.1), cuts_spend: bool(0.1), fixes_breakage: bool(0.1), states_deadline: bool(0.05),
		deadline_when: { type: "choice", choice: "none", confidence: 1, probabilities: when }, irreversible: bool(0.1), ...over,
	};
}
const choice = (label: string): JudgmentAnswer => ({ type: "choice", choice: label, confidence: 0.9, probabilities: Object.fromEntries(DEADLINE_LABELS.map((l) => [l, l === label ? 1 : 0])) });

// ---- items -----------------------------------------------------------------------------------------------------------

describe("items from gh issue lists", () => {
	const issue = (n: number, over: Record<string, unknown> = {}) => ({ id: `I_${n}`, number: n, title: `Issue ${n}`, body: "b".repeat(700), createdAt: "2026-10-15T02:09:43Z", ...over });

	test("ids are jo-issues#N and as2#N; the text is the title and the body's first 600 characters; filed is the Pacific day", () => {
		const [ji] = itemsFromIssues("jo-issues", [issue(7)]);
		const [as2] = itemsFromIssues("agent-system-2.0", [issue(228, { body: "short" })]);
		expect(ji).toEqual({ id: "jo-issues#7", repo: "jo-issues", number: 7, contentId: "I_7", title: "Issue 7", text: `Issue 7\n\n${"b".repeat(600)}`, createdAt: "2026-10-15T02:09:43Z", filed: "2026-10-14" });
		expect(as2!.id).toBe("as2#228");
		expect(as2!.text).toBe("Issue 228\n\nshort");
		expect(calendarDay("2026-10-15T07:30:00Z", FILED_TIME_ZONE)).toBe("2026-10-15");
	});

	test("a list of 1000 or more is refused as possibly incomplete; 999 is whole", () => {
		const list = (n: number) => Array.from({ length: n }, (_, i) => issue(i + 1));
		expect(itemsFromIssues("jo-issues", list(999))).toHaveLength(999);
		expect(() => itemsFromIssues("jo-issues", list(1000))).toThrow(/1000 open issues listed.*incomplete/);
		expect(() => itemsFromIssues("agent-system-2.0", list(1001))).toThrow(/thewolff\/agent-system-2.0/);
	});

	test("an entry without its fields is refused, never ranked half-read", () => {
		expect(() => itemsFromIssues("jo-issues", [issue(1, { createdAt: undefined })])).toThrow(/entry 0/);
		expect(() => itemsFromIssues("jo-issues", [issue(1, { id: "" })])).toThrow(/entry 0/);
		expect(() => itemsFromIssues("jo-issues", { items: [] })).toThrow(/not a list/);
	});

	test("goals are goals.md's `goal: ` lines, verbatim", () => {
		expect(parseGoals("# Goals\ngoal: flow first \ndropped: install\ngoal: spend less\n")).toEqual(["flow first", "spend less"]);
		expect(parseGoals(readFileSync(join(FIXTURE, "GOALS.md"), "utf8"))).toHaveLength(3);
	});
});

// ---- dates and questions ---------------------------------------------------------------------------------------------

describe("calendar-date candidates", () => {
	test("ISO and month-name dates in text order, de-duplicated, at most 6, past dates kept", () => {
		expect(dateCandidates("Kickoff Oct 22; deadline December 1st, 2026. Was due 2026-10-01, see Oct. 22 again.", "2026-10-20")).toEqual(["2026-10-22", "2026-12-01", "2026-10-01"]);
		const many = "2026-11-01 2026-11-02 2026-11-03 2026-11-04 2026-11-05 2026-11-06 2026-11-07";
		expect(dateCandidates(many, "2026-10-20")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
		expect(dateCandidates("Stamped 2026-10-20T12:09:36-07:00", "2026-10-20")).toEqual(["2026-10-20"]);
	});

	test("impossible dates, bare month-years and lowercase may/march are not dates", () => {
		expect(dateCandidates("2026-02-30, Oct 2026, we may 5 times, march 3 lanes, Feb 30", "2026-10-20")).toEqual([]);
		expect(dateCandidates("May 5 and mar 3", "2026-10-20")).toEqual(["2027-05-05", "2027-03-03"]);
	});

	test("a missing year is the one nearest the filed day within -60..+305 days, across New Year", () => {
		expect(dateCandidates("due Jan 5", "2026-12-20")).toEqual(["2027-01-05"]);
		expect(dateCandidates("broken since Dec 28", "2027-01-10")).toEqual(["2026-12-28"]);
		expect(dateCandidates("Dec 31", "2026-03-01")).toEqual(["2025-12-31"]); // -60 is nearer than +305
		expect(dateCandidates("Dec 31", "2026-03-02")).toEqual(["2026-12-31"]); // -61 is out; +304 is in
		expect(dateCandidates("Feb 29", "2026-10-20")).toEqual([]); // no leap year in the window
		expect(dateCandidates("Feb 29", "2027-10-20")).toEqual(["2028-02-29"]);
		expect(dateCandidates("Oct 1, 2024", "2026-10-20")).toEqual(["2024-10-01"]); // a stated year stands
	});
});

describe("the Jev question set", () => {
	test("rank.ts's set with deadline_when for deadline_day, every window spelled out from the filed day", () => {
		const q = backlogQuestions(GOALS, "2026-10-20", ["2026-10-22", "2026-12-01"]);
		expect(Object.keys(q)).toEqual(["goal_0", "goal_1", "unblocks_jo", "cuts_spend", "fixes_breakage", "states_deadline", "deadline_when", "irreversible"]);
		expect(q.goal_1).toMatchObject({ type: "score", instructions: expect.stringContaining(GOALS[1]!) });
		const when = q.deadline_when!;
		if (when.type !== "choice") throw new Error("deadline_when is a choice");
		expect(Object.keys(when.criteria)).toEqual(["none", "date-1", "date-2", "date-3", "date-4", "date-5", "date-6", "same-day", "next-day", "2-3-days", "4-7-days", "later"]);
		expect(when.instructions).toContain("Tuesday 2026-10-20");
		expect(when.criteria["date-2"]).toContain("Tuesday 2026-12-01");
		expect(when.criteria["date-3"]).toContain("no candidate [3]");
		expect(when.criteria["same-day"]).toContain("Tuesday 2026-10-20");
		expect(when.criteria["next-day"]).toContain("Wednesday 2026-10-21");
		expect(when.criteria["2-3-days"]).toContain("Thursday 2026-10-22");
		expect(when.criteria["2-3-days"]).toContain("Friday 2026-10-23");
		expect(when.criteria["4-7-days"]).toContain("Saturday 2026-10-24");
		expect(when.criteria["4-7-days"]).toContain("Tuesday 2026-10-27");
		expect(when.criteria.later).toContain("after Tuesday 2026-10-27");
	});

	test("the state carries the filed day with its weekday and the numbered dates", () => {
		const item = { text: "Ship\n\nKickoff Oct 22; deadline Dec 1", filed: "2026-10-20" };
		expect(judgeState(GOALS, item, dateCandidates(item.text, item.filed))).toEqual({ goals: GOALS, item: item.text, filed: "2026-10-20 (Tuesday)", dates: "[1] 2026-10-22 [2] 2026-12-01" });
		expect(judgeState(GOALS, { text: "x", filed: "2026-10-20" }, []).dates).toBe("none");
	});

	test("askJudgment takes the set as it is and returns answers checkAnswers accepts", async () => {
		const q = backlogQuestions(GOALS, "2026-10-20", ["2026-10-22"]);
		const judge: JudgmentJudge = {
			judge: async (req) => {
				expect(req.questions.unblocks_jo!.type).toBe("noul");
				const wire = Object.fromEntries(Object.entries(answers({ deadline_when: choice("date-1") })).map(([k, a]) => [k, a.type === "bool" ? { noul: a.bool } : a]));
				return { answers: wire, model: "jev-1.13.0", provider: "typesafe", usage: { input: 1000 } };
			},
		};
		const r = await askJudgment(judge, judgeState(GOALS, { text: "t", filed: "2026-10-20" }, ["2026-10-22"]), q, { timeoutMs: 1000 });
		if (!r.ok) throw new Error(r.reason);
		expect(isJevJudge(`${r.provider}/${r.model}`)).toBe(true);
		expect(isJevJudge("anthropic/claude")).toBe(false);
		expect(checkAnswers(q, ["2026-10-22"], r.answers)).toEqual({ ok: true, answers: r.answers });
	});
});

// ---- the cache -------------------------------------------------------------------------------------------------------

describe("the Jev cache", () => {
	const item = { id: "jo-issues#7", text: "Title\n\nBody", filed: "2026-10-14" };

	test("the key is sha256 of id, text, filed, goals and the questions version: an edit or a goal change re-keys it", () => {
		const k = cacheKey(item, GOALS);
		expect(k).toMatch(/^[0-9a-f]{64}$/);
		expect(cacheKey({ ...item }, [...GOALS])).toBe(k);
		expect(cacheKey({ ...item, text: "Title\n\nBody edited" }, GOALS)).not.toBe(k);
		expect(cacheKey({ ...item, filed: "2026-10-15" }, GOALS)).not.toBe(k);
		expect(cacheKey({ ...item, id: "as2#7" }, GOALS)).not.toBe(k);
		expect(cacheKey(item, [GOALS[0]!])).not.toBe(k);
		expect(k).toBe(createHash("sha256").update(JSON.stringify({ ...item, goals: GOALS, questionsVersion: QUESTIONS_VERSION })).digest("hex"));
	});

	test("cache.jsonl: the last line per key wins; a torn or partial line is skipped and counted", () => {
		const entry = { key: "k1", id: "jo-issues#7", answers: answers(), judge: "typesafe/jev-1.13.0", tokens: 900, cost: 0.0000378, at: "2026-10-20T19:00:00Z" };
		const text = cacheLine(entry) + cacheLine({ ...entry, judge: "typesafe/jev-1.14.0" }) + '{"key":"k2","id":"as2#1"}\n{"key":"k3",';
		const { entries, skipped } = parseCache(text);
		expect([...entries.keys()]).toEqual(["k1"]);
		expect(entries.get("k1")!.judge).toBe("typesafe/jev-1.14.0");
		expect(skipped).toBe(2);
	});

	test("answers are checked whole: askJudgment's shape rules, and a date-k must name a candidate", () => {
		const q = backlogQuestions(GOALS, "2026-10-20", ["2026-10-22", "2026-12-01"]);
		expect(checkAnswers(q, ["2026-10-22", "2026-12-01"], answers({ deadline_when: choice("date-2") })).ok).toBe(true);
		const outOfRange = checkAnswers(q, ["2026-10-22", "2026-12-01"], answers({ deadline_when: choice("date-3") }));
		expect(outOfRange).toEqual({ ok: false, reason: "malformed: deadline_when date-3 names no candidate (2 found)" });
		expect(checkAnswers(q, [], answers({ unblocks_jo: { type: "bool", bool: 1.2 } }))).toMatchObject({ ok: false, reason: expect.stringContaining("unblocks_jo") });
		const missing: Record<string, JudgmentAnswer> = answers();
		delete missing.goal_1;
		expect(checkAnswers(q, [], missing)).toMatchObject({ ok: false, reason: expect.stringContaining("goal_1") });
		expect(checkAnswers(q, [], answers({ deadline_when: { type: "choice", choice: "oct-20", confidence: 1, probabilities: { "oct-20": 1 } } }))).toMatchObject({ ok: false });
	});
});

// ---- R13: deadline urgency of one unchanged cached issue over many run days ------------------------------------------

describe("R13: deadline urgency against the filed day", () => {
	/** One issue filed on `filed`, answered once; its urgency and score on each run day, from the same cached answers. */
	function issueOn(text: string, filed: string, label: string) {
		const candidates = dateCandidates(text, filed);
		const q = backlogQuestions(GOALS, filed, candidates);
		const a = answers({ states_deadline: { type: "bool", bool: 0.9 }, deadline_when: choice(label) });
		const checked = checkAnswers(q, candidates, a);
		if (!checked.ok) throw new Error(checked.reason);
		const key = cacheKey({ id: "jo-issues#9", text, filed }, GOALS);
		return {
			candidates,
			key,
			urgency: (today: string) => itemUrgency(checked.answers, filed, candidates, today).urgency,
			score: (today: string) => scoreItem(checked.answers, GOALS.length, itemUrgency(checked.answers, filed, candidates, today).urgency).score,
		};
	}

	test("an explicit date 16 days out, then 3, 1, 0, -3 and -8 days: 0, 0.5, 1, 1, 1, then stale 0", () => {
		const it = issueOn("Renew the cert. Due 2026-11-05.", "2026-10-20", "date-1");
		expect(it.candidates).toEqual(["2026-11-05"]);
		const days = ["2026-10-20", "2026-11-02", "2026-11-04", "2026-11-05", "2026-11-08", "2026-11-13"];
		expect(days.map(it.urgency)).toEqual([0, 0.5, 1, 1, 1, 0]);
		expect(it.score("2026-11-05") - it.score("2026-10-20")).toBeCloseTo(0.2, 10);
		expect(it.urgency("2026-11-12")).toBe(1); // 7 days past is still within the week
	});

	test("a relative 'tonight' counts on its filed day, stays overdue a week, and is stale three weeks later", () => {
		const it = issueOn("Fix the deploy tonight", "2026-10-20", "same-day");
		expect(it.candidates).toEqual([]);
		expect(["2026-10-20", "2026-10-27", "2026-10-28", "2026-11-10"].map(it.urgency)).toEqual([1, 1, 0, 0]);
	});

	test("a December date filed in October counts on its due day", () => {
		const it = issueOn("Ship the export by Dec 1", "2026-10-20", "date-1");
		expect(it.candidates).toEqual(["2026-12-01"]);
		expect(it.urgency("2026-10-20")).toBe(0);
		expect(it.urgency("2026-12-01")).toBe(1);
	});

	test("mixed dates with Jev's date-2: urgent only near Dec 1, never near the kickoff", () => {
		const it = issueOn("Kickoff Oct 22; deadline Dec 1", "2026-10-20", "date-2");
		expect(it.candidates).toEqual(["2026-10-22", "2026-12-01"]);
		expect(["2026-10-21", "2026-10-22", "2026-11-27", "2026-11-28", "2026-11-30"].map(it.urgency)).toEqual([0, 0, 0, 0.5, 1]);
	});

	test("a deadline already past at filing is overdue, then stale", () => {
		const it = issueOn("Deadline 2026-10-19", "2026-10-20", "date-1");
		expect(["2026-10-20", "2026-10-26", "2026-10-27"].map(it.urgency)).toEqual([1, 1, 0]);
	});

	test("`later` and `none` count 0 on every day", () => {
		const later = issueOn("Do it next month", "2026-10-20", "later");
		const none = issueOn("No date at all", "2026-10-20", "none");
		for (const d of ["2026-10-20", "2026-11-20", "2026-12-20"]) expect([later.urgency(d), none.urgency(d)]).toEqual([0, 0]);
	});

	test("an out-of-range date-k is malformed and has no window", () => {
		const q = backlogQuestions(GOALS, "2026-10-20", ["2026-11-05"]);
		expect(checkAnswers(q, ["2026-11-05"], answers({ deadline_when: choice("date-2") })).ok).toBe(false);
		expect(() => deadlineWindow("date-2", "2026-10-20", ["2026-11-05"])).toThrow(/names no candidate/);
	});

	test("relative windows are [filed+a, filed+b]; the questions and the cache key never depend on the run day", () => {
		expect(deadlineWindow("next-day", "2026-10-20", [])).toEqual({ start: "2026-10-21", end: "2026-10-21" });
		expect(deadlineWindow("2-3-days", "2026-10-20", [])).toEqual({ start: "2026-10-22", end: "2026-10-23" });
		expect(deadlineWindow("4-7-days", "2026-10-20", [])).toEqual({ start: "2026-10-24", end: "2026-10-27" });
		expect(deadlineUrgency({ start: "2026-10-24", end: "2026-10-27" }, "2026-10-21")).toBe(0.5);
		const a = issueOn("Due Thursday", "2026-10-20", "2-3-days");
		const b = issueOn("Due Thursday", "2026-10-20", "2-3-days");
		expect(a.key).toBe(b.key);
		expect(["2026-10-20", "2026-10-21", "2026-10-30", "2026-10-31"].map(a.urgency)).toEqual([0.5, 1, 1, 0]); // stale after end (10-23) + 7
	});

	test("urgency counts only when states_deadline is 0.5 or more after the uncertainty rule", () => {
		const a = (sd: number) => answers({ states_deadline: { type: "bool", bool: sd } });
		const base = scoreItem(a(0.2), 2, 0).raw;
		expect(scoreItem(a(0.2), 2, 1).raw).toBe(base);
		expect(scoreItem(a(0.4), 2, 1).raw - scoreItem(a(0.4), 2, 0).raw).toBeCloseTo(0.2, 10); // 0.4 counts 0.5
		expect(scoreItem(a(0.66), 2, 0.5).raw - scoreItem(a(0.66), 2, 0).raw).toBeCloseTo(0.1, 10);
	});
});

// ---- the score -------------------------------------------------------------------------------------------------------

describe("the score (rank.ts, ported)", () => {
	const s = (over: Record<string, ScoredAnswer>) => scoreItem({ ...answers(), ...over }, 2, 0);

	test("0.3 best goal + 0.2 unblocks + 0.15 fixes + 0.2 urgency + 0.15 spend; uncertain answers count 0.5", () => {
		const all = (v: number): Record<string, ScoredAnswer> => ({
			goal_0: { type: "score", score: 3 * v, confidence: 0.9 }, goal_1: { type: "score", score: 0, confidence: 0.9 },
			unblocks_jo: { type: "bool", bool: v }, fixes_breakage: { type: "bool", bool: v }, cuts_spend: { type: "bool", bool: v },
			states_deadline: { type: "bool", bool: 0.9 }, irreversible: { type: "bool", bool: 0.1 },
		});
		expect(scoreItem(all(1), 2, 1).raw).toBeCloseTo(1, 10);
		expect(scoreItem(all(0), 2, 1).raw).toBeCloseTo(0.2, 10);
		expect(scoreItem(all(1), 2, 0).raw).toBeCloseTo(0.8, 10);
		expect(s({ unblocks_jo: { type: "bool", bool: 0.35 } }).raw).toBeCloseTo(s({ unblocks_jo: { type: "bool", bool: 0.65 } }).raw, 12);
		expect(s({ unblocks_jo: { type: "bool", bool: 0.35 } }).reasons[1]).toBe("unblocks_jo 0.50? ×0.2");
		expect(s({ unblocks_jo: { type: "bool", bool: 0.34 } }).reasons[1]).toBe("unblocks_jo 0.34 ×0.2");
	});

	test("the best goal scores; a low-confidence goal counts 0.5", () => {
		const r = s({ goal_0: { type: "score", score: 0, confidence: 0.49 }, goal_1: { type: "score", score: 1, confidence: 0.9 } });
		expect(r.reasons[0]).toBe("goal 1 0.50? ×0.3");
		expect(s({ goal_1: { type: "score", score: 3, confidence: 0.9 } }).reasons[0]).toBe("goal 2 1.00 ×0.3");
		expect(s({ irreversible: { type: "bool", bool: 0.9 } }).flags).toEqual(["irreversible 0.90: needs Jo"]);
	});

	test("ties go by created time, then id", () => {
		const it = (id: string, createdAt: string): RankInput => ({ id, createdAt, answers: answers(), urgency: 0 });
		const order = jevRank([it("jo-issues#9", "2026-10-15T00:00:00Z"), it("as2#300", "2026-10-14T00:00:00Z"), it("as2#2", "2026-10-15T00:00:00Z")], 2).map((r) => r.id);
		expect(order).toEqual(["as2#300", "as2#2", "jo-issues#9"]);
	});
});

// ---- R12: the 2026-10-20 12:09 answers replay to rank-1220.out's Jev order ------------------------------------------

describe("R12: replay of the 2026-10-20 12:09 run", () => {
	type Line = { id: string; title: string; created: string; model: string; answers: Record<string, ScoredAnswer> };
	const lines: Line[] = readFileSync(join(FIXTURE, "answers-1220.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const goals = parseGoals(readFileSync(join(FIXTURE, "GOALS.md"), "utf8"));
	/** rank.ts's URGENCY map on 2026-10-20: KEY_TODAY, KEY_TOMORROW and KEY_SOON for that day. */
	const URGENCY_1020: Record<string, number> = { none: 0, "oct-20": 1, "oct-21": 1, "oct-22-23": 0.5, later: 0 };
	const replay = () =>
		jevRank(lines.map((l) => {
			const day = l.answers.deadline_day;
			if (day?.type !== "choice" || !(day.choice in URGENCY_1020)) throw new Error(`${l.id}: deadline_day ${JSON.stringify(day)}`);
			return { id: l.id, createdAt: l.created, answers: l.answers, urgency: URGENCY_1020[day.choice]! };
		}), goals.length);
	const expected = parseRanking(readFileSync(join(FIXTURE, "rank-1220.out"), "utf8"), lines.map((l) => ({ id: l.id, title: l.title })));

	test("all 185 items, the same order and the same 4-place scores", () => {
		expect(goals).toHaveLength(3);
		expect(lines).toHaveLength(185);
		const got = replay();
		expect(got.map((r) => r.id)).toEqual(expected.ranked.map((r) => r.id));
		expect(got.map((r) => r.score)).toEqual(expected.ranked.map((r) => r.score));
		expect(expected.cost).toBe(0.0004);
		expect(expected.job).toBe("jdgb-15adfb60c9d42eab");
	});

	test("equal scores are ordered by created time, not by id (as2#193 before jo-issues#65)", () => {
		const ids = replay().map((r) => r.id);
		expect(ids.indexOf("as2#193")).toBeLessThan(ids.indexOf("jo-issues#65"));
		expect(ids.indexOf("jo-issues#65")).toBeLessThan(ids.indexOf("as2#282"));
	});

	test("R2 on real data: the 12:18 placements put the new tickets 20th, 25th and 38th, #45 8th and #118 9th", () => {
		const jev = replay().map((r) => r.id);
		const pins = [174, 173, 170, 172, 168].map((number, i) => ({ repo: "jo-issues", number, position: [1, 3, 5, 6, 10][i]!, why: "Jo" }));
		const checked = checkPins(pins, jev);
		if (!checked.ok) throw new Error(checked.reason);
		const order = applyPins(jev, checked.placed);
		const at = (id: string) => order.indexOf(id) + 1;
		expect([at("jo-issues#174"), at("jo-issues#173"), at("jo-issues#170"), at("jo-issues#172"), at("jo-issues#168")]).toEqual([1, 3, 5, 6, 10]);
		expect([at("jo-issues#175"), at("jo-issues#177"), at("jo-issues#176"), at("jo-issues#45"), at("jo-issues#118")]).toEqual([20, 25, 38, 8, 9]);
		expect(new Set(order).size).toBe(185);
	});
});

// ---- R2: positional pins ---------------------------------------------------------------------------------------------

describe("R2: positional pins", () => {
	const jev = ["jo-issues#1", "jo-issues#2", "jo-issues#3", "as2#4", "as2#5", "jo-issues#6", "jo-issues#7", "jo-issues#8"];
	const pin = (repo: string, number: number, position: unknown) => ({ repo, number, position, why: "Jo" });

	test("each open pin takes exactly its position; the rest fill the gaps in Jev order", () => {
		const r = checkPins([pin("jo-issues", 3, 1), pin("jo-issues", 1, 5), pin("agent-system-2.0", 5, 8)], jev);
		if (!r.ok) throw new Error(r.reason);
		expect(applyPins(jev, r.placed)).toEqual(["jo-issues#3", "jo-issues#2", "as2#4", "jo-issues#6", "jo-issues#1", "jo-issues#7", "jo-issues#8", "as2#5"]);
		expect(checkPins(undefined, jev)).toEqual({ ok: true, placed: [], skipped: [] });
	});

	test("a closed or missing pin is skipped and reported, and moves no other pin", () => {
		const r = checkPins([pin("jo-issues", 99, 2), pin("jo-issues", 6, 3), pin("agent-system-2.0", 77, 1)], jev, new Set(["jo-issues#99"]));
		if (!r.ok) throw new Error(r.reason);
		expect(r.skipped).toEqual([{ id: "jo-issues#99", position: 2, why: "Jo", reason: "closed" }, { id: "as2#77", position: 1, why: "Jo", reason: "not found" }]);
		const order = applyPins(jev, r.placed);
		expect(order.indexOf("jo-issues#6") + 1).toBe(3);
		expect(order.slice(0, 2)).toEqual(["jo-issues#1", "jo-issues#2"]);
	});

	test("every refusal, before any Jev call: duplicate position, one issue twice, a bad position, a position past the open count, a malformed pin", () => {
		const refused = (pins: unknown) => {
			const r = checkPins(pins, jev, new Set(["jo-issues#99"]));
			if (r.ok) throw new Error("not refused");
			return r.reason;
		};
		expect(refused([pin("jo-issues", 1, 2), pin("jo-issues", 3, 2)])).toBe("jo-issues#1 and jo-issues#3 are both pinned to position 2");
		expect(refused([pin("jo-issues", 1, 2), pin("jo-issues", 99, 2)])).toContain("both pinned to position 2"); // a closed pin still clashes
		expect(refused([pin("jo-issues", 1, 2), pin("jo-issues", 1, 4)])).toBe("jo-issues#1 is pinned twice (positions 2 and 4)");
		for (const bad of [0, -1, 1.5, "3", null, undefined]) expect(refused([pin("jo-issues", 1, bad)])).toContain("is not a positive integer");
		expect(refused([pin("jo-issues", 1, 9)])).toBe("jo-issues#1 is pinned to position 9, but only 8 issues are open");
		expect(refused([pin("thewolff/jo-issues", 1, 1)])).toContain("pin 1 is malformed");
		expect(refused([pin("jo-issues", 0, 1)])).toContain("pin 1 is malformed");
		expect(refused([{ repo: "jo-issues", position: 1 }])).toContain("pin 1 is malformed");
		expect(refused({ "jo-issues#1": 1 })).toBe("pins.json is not a list");
	});

	test("a closed pin past the open count is skipped, not refused", () => {
		const r = checkPins([pin("jo-issues", 1, 8), pin("jo-issues", 99, 50)], jev, new Set(["jo-issues#99"]));
		expect(r).toMatchObject({ ok: true, skipped: [{ id: "jo-issues#99", reason: "closed" }] });
	});
});

// ---- R11: due rule and lifecycle -------------------------------------------------------------------------------------

describe("R11: one run per local day, resume first, abandon after 3 failed attempts", () => {
	const D = "2026-10-20";
	const NEXT = "2026-10-21";
	/** Persisted and read back, as last-run.json is between fires. */
	const saved = (run: LastRun): LastRun => parseLastRun(JSON.parse(JSON.stringify(run)));

	test("a run id is the UTC stamp and 4 hex digits", () => {
		expect(newRunId(new Date("2026-10-20T19:10:14.123Z"), "a3f9")).toBe("20261020T191014Z-a3f9");
		expect(() => newRunId(new Date(), "xyz1")).toThrow();
	});

	test("no run yet starts one; a succeeded, commented run holds the day; --now and the next day start another", () => {
		expect(dueRule(null, D)).toEqual({ action: "start" });
		let run = beginAttempt(startRun("r1", D));
		run = advance(run, "writing");
		run = advance(run, "written");
		expect(run.outcome).toBe("succeeded");
		expect(nextStep(run)).toBe("comment");
		run = saved(markCommented(run));
		expect(dueRule(run, D)).toMatchObject({ action: "skip", reason: expect.stringContaining("succeeded") });
		expect(dueRule(run, D, true)).toEqual({ action: "start" });
		expect(dueRule(run, NEXT)).toEqual({ action: "start" });
	});

	test("an unfinished run resumes first, in every phase, even with --now", () => {
		const ranking = saved(beginAttempt(startRun("r1", D)));
		const writing = saved(advance(ranking, "writing"));
		const written = saved(advance(writing, "written")); // killed after `written`, before posting
		for (const [run, step] of [[ranking, "rank"], [writing, "write"], [written, "comment"]] as const) {
			expect(dueRule(run, D)).toEqual({ action: "resume", run });
			expect(dueRule(run, D, true)).toEqual({ action: "resume", run });
			expect(nextStep(run)).toBe(step);
		}
	});

	test("a failed attempt stays pending for the next fire; the third failure abandons, and only the comment is left", () => {
		let run = startRun("r1", D);
		for (let i = 1; i < MAX_ATTEMPTS; i++) {
			run = saved(failAttempt(beginAttempt(run)));
			expect(run).toMatchObject({ attempts: i, outcome: "pending", commented: false });
			expect(dueRule(run, D)).toEqual({ action: "resume", run });
		}
		run = advance(beginAttempt(run), "writing");
		run = saved(failAttempt(run));
		expect(run).toMatchObject({ attempts: 3, outcome: "abandoned", phase: "writing", commented: false });
		expect(nextStep(run)).toBe("comment");
		expect(() => beginAttempt(run)).toThrow(/abandoned/);
		expect(() => advance(run, "written")).toThrow(/abandoned/); // a lost abandon post never turns into succeeded
		expect(dueRule(run, D)).toEqual({ action: "resume", run }); // the lost post is retried
		run = saved(markCommented(run));
		expect(dueRule(run, D)).toMatchObject({ action: "skip", reason: expect.stringContaining("abandoned") });
		expect(dueRule(run, NEXT)).toEqual({ action: "start" });
	});

	test("an unfinished run when a new day starts is resumed under its own id and day, then the new day runs", () => {
		const yesterday = saved(advance(beginAttempt(startRun("r1", D)), "writing"));
		const due = dueRule(yesterday, NEXT);
		expect(due).toEqual({ action: "resume", run: yesterday });
		const done = saved(markCommented(advance(beginAttempt(yesterday), "written")));
		expect(done).toMatchObject({ runId: "r1", day: D, attempts: 2 });
		expect(dueRule(done, NEXT)).toEqual({ action: "start" });
	});

	test("phases only move forward one step; a record that contradicts itself is refused", () => {
		const run = startRun("r1", D);
		expect(() => advance(run, "written")).toThrow(/ranking to written/);
		expect(advance(advance(run, "writing"), "writing").phase).toBe("writing"); // a resumed writing attempt
		expect(() => markCommented(run)).toThrow(/no outcome/);
		expect(() => parseLastRun({ ...run, commented: true })).toThrow();
		expect(() => parseLastRun({ ...run, phase: "written" })).toThrow();
		expect(() => parseLastRun({ ...run, day: "2026-13-01" })).toThrow();
		expect(() => parseLastRun({ ...run, attempts: -1 })).toThrow();
	});
});

// ---- the board -------------------------------------------------------------------------------------------------------

const FIELDS = [
	{ id: "F_rank", name: "Rank", dataType: "NUMBER" },
	{ id: "F_score", name: "Jev score", dataType: "NUMBER" },
	{ id: "F_at", name: "Ranked at", dataType: "TEXT" },
	{ id: "F_lane", name: "Lane state", dataType: "SINGLE_SELECT", options: [{ id: "o_run", name: "running" }, { id: "o_park", name: "parked" }, { id: "o_block", name: "blocked" }, { id: "o_none", name: "none" }] },
	{ id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "s1", name: "Todo" }] },
	{ id: "F_labels", name: "Labels", dataType: "LABELS" },
	{ id: "F_tags", name: "Tags", dataType: "MULTI_SELECT", options: [{ id: "t1", name: "a" }, { id: "t2", name: "b" }] },
];
const fieldRef = (id: string) => {
	const f = FIELDS.find((x) => x.id === id)!;
	return { id: f.id, name: f.name, dataType: f.dataType };
};
const num = (field: string, n: number): BoardValue => ({ __typename: "ProjectV2ItemFieldNumberValue", field: fieldRef(field), number: n });
const txt = (field: string, t: string): BoardValue => ({ __typename: "ProjectV2ItemFieldTextValue", field: fieldRef(field), text: t });
const sel = (field: string, optionId: string): BoardValue => ({ __typename: "ProjectV2ItemFieldSingleSelectValue", field: fieldRef(field), optionId, name: optionId });
const labels = (names: string[]): BoardValue => ({ __typename: "ProjectV2ItemFieldLabelValue", field: fieldRef("F_labels"), labels: { nodes: names.map((name) => ({ name })) } });
const card = (id: string, repo: string | null, number: number | null, createdAt: string, fieldValues: BoardValue[] = [], over: Partial<BoardItem> = {}): BoardItem => ({
	id, type: repo === null ? "DRAFT_ISSUE" : "ISSUE", contentId: `C_${repo ?? "draft"}_${number ?? id}`, repo, number, isArchived: false, createdAt, fieldValues, ...over,
});
const board = (items: BoardItem[], fields = FIELDS): BoardSnapshot => ({ projectId: "P_1", fields, items });
const JI = "thewolff/jo-issues";
const AS2 = "thewolff/agent-system-2.0";
const STAMP = "12:10 PM PDT Oct 20";
const current = (id: string, rank: number, score: number, lane = "o_none") => [num("F_rank", rank), num("F_score", score), txt("F_at", STAMP), sel("F_lane", lane)];

describe("board diff (D6)", () => {
	const desired = [
		{ id: "jo-issues#1", contentId: `C_${JI}_1`, rank: 1, score: 0.7, rankedAt: STAMP, laneState: "running" as const },
		{ id: "jo-issues#3", contentId: `C_${JI}_3`, rank: 2, score: 0.6, rankedAt: STAMP, laneState: "none" as const },
		{ id: "as2#4", contentId: `C_${AS2}_4`, rank: 3, score: 0.5, rankedAt: STAMP, laneState: "none" as const },
	];
	const snapshot = board([
		card("I_1new", JI, 1, "2026-10-19T00:00:00Z"),
		card("I_1old", JI, 1, "2026-10-15T00:00:00Z", [num("F_rank", 4), num("F_score", 0.5), txt("F_at", "9:00 AM PDT Oct 19"), sel("F_lane", "o_none"), sel("F_status", "s1")]),
		card("I_2", JI, 2, "2026-10-15T00:00:00Z", current("I_2", 2, 0.4)),
		card("I_3", JI, 3, "2026-10-15T00:00:00Z", current("I_3", 2, 0.6), { isArchived: true }),
		card("I_other", "thewolff/newdle", 5, "2026-10-15T00:00:00Z"),
		card("I_draft", null, null, "2026-10-15T00:00:00Z"),
		card("I_pr", JI, 50, "2026-10-15T00:00:00Z", [], { type: "PULL_REQUEST" }),
	]);

	test("adds missing issues, deletes closed ones and newer duplicates, sets only the values that differ; other repos, drafts and PRs untouched", () => {
		const r = boardDiff(snapshot, desired);
		if (!r.ok) throw new Error(r.reason);
		expect(r.diff.adds).toEqual([{ kind: "add", key: "as2#4", contentId: `C_${AS2}_4` }]);
		expect(r.diff.deletes).toEqual([
			{ kind: "delete", key: "jo-issues#1", itemId: "I_1new", reason: "duplicate" },
			{ kind: "delete", key: "jo-issues#2", itemId: "I_2", reason: "closed" },
		]);
		expect(r.diff.updates).toEqual([
			{ kind: "set", key: "jo-issues#1", itemId: "I_1old", fieldId: "F_rank", field: "Rank", value: { number: 1 } },
			{ kind: "set", key: "jo-issues#1", itemId: "I_1old", fieldId: "F_score", field: "Jev score", value: { number: 0.7 } },
			{ kind: "set", key: "jo-issues#1", itemId: "I_1old", fieldId: "F_at", field: "Ranked at", value: { text: STAMP } },
			{ kind: "set", key: "jo-issues#1", itemId: "I_1old", fieldId: "F_lane", field: "Lane state", value: { singleSelectOptionId: "o_run" } },
		]);
	});

	test("re-run on the board after the writes landed, the diff is empty (the reconcile finishes, never replays)", () => {
		const after = board([
			card("I_1old", JI, 1, "2026-10-15T00:00:00Z", [...current("I_1old", 1, 0.7, "o_run"), sel("F_status", "s1")]),
			card("I_3", JI, 3, "2026-10-15T00:00:00Z", current("I_3", 2, 0.6), { isArchived: true }),
			card("I_4", AS2, 4, "2026-10-20T00:00:00Z", current("I_4", 3, 0.5)),
			card("I_other", "thewolff/newdle", 5, "2026-10-15T00:00:00Z"),
		]);
		expect(boardDiff(after, desired)).toEqual({ ok: true, diff: { adds: [], deletes: [], updates: [] } });
	});

	test("a missing field, a doubled field, a field of another type, or Lane state options not exactly the four refuse the run", () => {
		const without = (name: string) => FIELDS.filter((f) => f.name !== name);
		for (const name of ["Rank", "Jev score", "Ranked at", "Lane state"]) expect(boardDiff(board([], without(name)), [])).toEqual({ ok: false, reason: `the board has no "${name}" field` });
		expect(boardDiff(board([], [...FIELDS, { id: "F_rank2", name: "Rank", dataType: "NUMBER" }]), [])).toMatchObject({ ok: false, reason: expect.stringContaining('2 fields named "Rank"') });
		expect(boardDiff(board([], FIELDS.map((f) => (f.name === "Ranked at" ? { ...f, dataType: "DATE" } : f))), [])).toMatchObject({ ok: false, reason: expect.stringContaining("is DATE, not TEXT") });
		const lane = (names: string[]) => FIELDS.map((f) => (f.name === "Lane state" ? { ...f, options: names.map((n) => ({ id: n, name: n })) } : f));
		expect(boardDiff(board([], lane(["running", "parked", "blocked", "none", "done"])), [])).toMatchObject({ ok: false, reason: expect.stringContaining("not exactly running, parked, blocked, none") });
		expect(boardDiff(board([], lane(["running", "parked", "blocked"])), [])).toMatchObject({ ok: false });
		expect(boardDiff(board([], lane(["running", "parked", "blocked", "None"])), [])).toMatchObject({ ok: false });
	});

	test("desired items: Rank is the position, Jev score rounded to 4 places, as2 lane states none", () => {
		const items = itemsFromIssues("jo-issues", [{ id: "C1", number: 1, title: "a", body: "", createdAt: "2026-10-15T00:00:00Z" }]).concat(
			itemsFromIssues("agent-system-2.0", [{ id: "C4", number: 4, title: "b", body: "", createdAt: "2026-10-15T00:00:00Z" }]));
		const d = desiredItems(["as2#4", "jo-issues#1"], items, new Map([["jo-issues#1", 0.61234567], ["as2#4", 0.7]]), STAMP, new Map([["jo-issues#1", "parked"]]));
		expect(d).toEqual([
			{ id: "as2#4", contentId: "C4", rank: 1, score: 0.7, rankedAt: STAMP, laneState: "none" },
			{ id: "jo-issues#1", contentId: "C1", rank: 2, score: 0.6123, rankedAt: STAMP, laneState: "parked" },
		]);
	});
});

describe("mutation batches (D6)", () => {
	test("at most 10 aliased mutations per request, in order, every id a variable", () => {
		const ops = [
			...Array.from({ length: 12 }, (_, i) => ({ kind: "set" as const, key: `jo-issues#${i}`, itemId: `I_${i}`, fieldId: "F_rank", field: "Rank", value: { number: i + 1 } })),
			{ kind: "add" as const, key: "as2#4", contentId: "C_4" },
			{ kind: "delete" as const, key: "jo-issues#2", itemId: "I_2", reason: "closed" as const },
			{ kind: "clear" as const, key: "jo-issues#3", itemId: "I_3", fieldId: "F_at", field: "Ranked at" },
			{ kind: "archive" as const, key: "jo-issues#3", itemId: "I_3" },
			{ kind: "unarchive" as const, key: "jo-issues#3", itemId: "I_3" },
		];
		const batches = mutationBatches("P_1", ops);
		expect(batches.map((b) => b.ops.length)).toEqual([10, 7]);
		expect(batches.flatMap((b) => b.ops)).toEqual(ops);
		for (const b of batches) {
			const aliases = [...b.query.matchAll(/\bm(\d+): (\w+)\(/g)];
			expect(aliases.length).toBe(b.ops.length);
			expect(aliases.map((a) => Number(a[1]))).toEqual(b.ops.map((_, i) => i));
			expect(b.variables.p).toBe("P_1");
			expect(b.query.startsWith("mutation(")).toBe(true);
		}
		expect(batches[0]!.variables.i9).toBe("I_9");
		expect(batches[0]!.variables.v9).toEqual({ number: 10 });
		const second = batches[1]!;
		expect([...second.query.matchAll(/\bm\d+: (\w+)\(/g)].map((m) => m[1])).toEqual([
			"updateProjectV2ItemFieldValue", "updateProjectV2ItemFieldValue", "addProjectV2ItemById", "deleteProjectV2Item", "clearProjectV2ItemFieldValue", "archiveProjectV2Item", "unarchiveProjectV2Item",
		]);
		expect(second.variables.c2).toBe("C_4");
		expect(() => mutationBatches("P_1", ops, 11)).toThrow();
		expect(mutationBatches("P_1", [])).toEqual([]);
	});
});

describe("undo plan from a backup (D6)", () => {
	const tags = (ids: string[]): BoardValue => ({ __typename: "ProjectV2ItemFieldMultiSelectValue", field: fieldRef("F_tags"), options: ids.map((id) => ({ id, name: id })) });
	const backup = board([
		card("I_1", JI, 1, "2026-10-15T00:00:00Z", [num("F_rank", 3), sel("F_status", "s1"), labels(["bug"]), tags(["t1"])]),
		card("I_2", JI, 2, "2026-10-15T00:00:00Z", [num("F_rank", 5), txt("F_at", "old")], { isArchived: true }),
		card("I_n", "thewolff/newdle", 9, "2026-10-15T00:00:00Z", [txt("F_at", "note")]),
		card("I_d", null, null, "2026-10-15T00:00:00Z", [num("F_rank", 7)]),
	]);
	const now = board([
		card("I_1", JI, 1, "2026-10-15T00:00:00Z", [num("F_rank", 1), num("F_score", 0.7), labels(["bug", "p1"]), tags(["t2"])]),
		card("I_n", "thewolff/newdle", 9, "2026-10-15T00:00:00Z", [txt("F_at", "note")]),
		card("I_3", AS2, 3, "2026-10-20T00:00:00Z", [num("F_rank", 2)]),
	]);

	test("deletes cards absent from the backup, re-adds deleted cards by content id, sets or clears every writable difference", () => {
		const plan = undoPlan(backup, now, { multiSelect: false });
		expect(plan.ops).toEqual([
			{ kind: "delete", key: "as2#3", itemId: "I_3", reason: "not in backup" },
			{ kind: "add", key: "jo-issues#2", contentId: `C_${JI}_2` },
			{ kind: "set", key: "jo-issues#1", itemId: "I_1", fieldId: "F_rank", field: "Rank", value: { number: 3 } },
			{ kind: "set", key: "jo-issues#1", itemId: "I_1", fieldId: "F_status", field: "Status", value: { singleSelectOptionId: "s1" } },
			{ kind: "clear", key: "jo-issues#1", itemId: "I_1", fieldId: "F_score", field: "Jev score" },
		]);
		expect(plan.unrestorable).toEqual(["I_d: a deleted draft cannot be re-added"]);
		expect(plan.contentDiffs).toHaveLength(2); // labels, and tags while multi-select is not writable
		expect(plan.contentDiffs[0]).toStartWith("jo-issues#1 Labels: backup");
		expect(plan.contentDiffs[1]).toStartWith("jo-issues#1 Tags: backup");
	});

	test("multi-select is written where the live schema has it", () => {
		const plan = undoPlan(backup, now, { multiSelect: true });
		expect(plan.ops).toContainEqual({ kind: "set", key: "jo-issues#1", itemId: "I_1", fieldId: "F_tags", field: "Tags", value: { multiSelectOptionIds: ["t1"] } });
		expect(plan.contentDiffs).toHaveLength(1);
	});

	test("the next plan, after the re-add, restores the new card's values and archive state; then nothing is left", () => {
		const readd = board([
			card("I_1", JI, 1, "2026-10-15T00:00:00Z", [num("F_rank", 3), sel("F_status", "s1"), labels(["bug", "p1"]), tags(["t1"])]),
			card("I_n", "thewolff/newdle", 9, "2026-10-15T00:00:00Z", [txt("F_at", "note")]),
			card("I_2new", JI, 2, "2026-10-21T00:00:00Z", []),
		]);
		const plan = undoPlan(backup, readd, { multiSelect: true });
		expect(plan.ops).toEqual([
			{ kind: "set", key: "jo-issues#2", itemId: "I_2new", fieldId: "F_rank", field: "Rank", value: { number: 5 } },
			{ kind: "set", key: "jo-issues#2", itemId: "I_2new", fieldId: "F_at", field: "Ranked at", value: { text: "old" } },
			{ kind: "archive", key: "jo-issues#2", itemId: "I_2new" },
		]);
		const restored = board([readd.items[0]!, readd.items[1]!, card("I_2new", JI, 2, "2026-10-21T00:00:00Z", [num("F_rank", 5), txt("F_at", "old")], { isArchived: true })]);
		expect(undoPlan(backup, restored, { multiSelect: true }).ops).toEqual([]);
	});

	test("the Title field's text value is the issue's own title: a changed title is listed, never written", () => {
		const title = (t: string): BoardValue => ({ __typename: "ProjectV2ItemFieldTextValue", field: { id: "F_title", name: "Title", dataType: "TITLE" }, text: t });
		const fields = [...FIELDS, { id: "F_title", name: "Title", dataType: "TITLE" }];
		const before = board([card("I_1", JI, 1, "2026-10-15T00:00:00Z", [title("Old title")])], fields);
		const after = board([card("I_1", JI, 1, "2026-10-15T00:00:00Z", [title("New title")])], fields);
		const plan = undoPlan(before, after, { multiSelect: true });
		expect(plan.ops).toEqual([]);
		expect(plan.contentDiffs).toHaveLength(1);
		expect(plan.contentDiffs[0]).toStartWith("jo-issues#1 Title: ");
	});

	test("previous Rank values by issue, for the comment's moves", () => {
		expect(previousRanks(backup)).toEqual(new Map([["jo-issues#1", 3], ["jo-issues#2", 5]]));
	});
});

// ---- R6: the #153 comment --------------------------------------------------------------------------------------------

describe("R6: the #153 comment", () => {
	const RUN = "20261020T191014Z-a3f9";

	test("one comment per run id: the marker is found again after a lost response, and no other run's marker matches", () => {
		const posted: { body: string }[] = [{ body: `${commentMarker("20261020T191014Z-a3f")}\nolder run` }];
		const body = commentBody({ runId: RUN, outcome: "succeeded" });
		expect(body.split("\n")[0]).toBe(`<!-- as2-backlog-rank run ${RUN} -->`);
		expect(hasRunComment(posted, RUN)).toBe(false); // a run id that is a prefix of this one is another run
		// a fire posts once; its response is lost; the next fire reads the comments and posts nothing
		for (let fire = 0; fire < 3; fire++) if (!hasRunComment(posted, RUN)) posted.push({ body });
		expect(posted.filter((c) => c.body.includes(commentMarker(RUN)))).toHaveLength(1);
		expect(hasRunComment([{ body: null }, {}], RUN)).toBe(false);
	});

	test("a done run says what moved: counts, pins, new and gone items, the top 10 against the backup, other moves, cost, paths, undo", () => {
		const order = Array.from({ length: 12 }, (_, i) => `jo-issues#${i + 1}`).concat("as2#20");
		const before = new Map<string, number | null>([...order.slice(0, 11).map((id, i): [string, number | null] => [id, i + 1]), ["jo-issues#30", 4]]);
		before.set("jo-issues#2", 5);
		before.set("jo-issues#5", 2);
		before.set("jo-issues#3", null);
		before.set("jo-issues#11", 12);
		const moves = rankMoves(order, before);
		expect(moves.added).toEqual([{ id: "jo-issues#12", rank: 12 }, { id: "as2#20", rank: 13 }]);
		expect(moves.left).toEqual(["jo-issues#30"]);
		expect(moves.otherMoves).toBe(1);
		const body = commentBody({
			runId: RUN, outcome: "succeeded", counts: { "jo-issues": 12, "agent-system-2.0": 1 },
			pins: { placed: [{ id: "jo-issues#1", position: 1, why: "Jo" }], skipped: [{ id: "jo-issues#99", position: 3, why: "Jo", reason: "closed" }] },
			moves, titles: new Map([["jo-issues#1", "Two trains"], ["jo-issues#30", "Old work"]]), jev: { cost: 0.0004, newCalls: 7 },
			orderPath: "/state/runs/r/order.json", backupPath: "/state/runs/r/backup.json",
		});
		expect(body).toContain(`**Backlog re-rank ${RUN}: done**`);
		expect(body).toContain("Ranked 13 open issues: 12 in jo-issues, 1 in agent-system-2.0.");
		expect(body).toContain("Pins applied: jo-issues#1 1st.");
		expect(body).toContain("Pins skipped: jo-issues#99 (closed, was for 3rd).");
		expect(body).toContain("**New on the board**\n- jo-issues#12: 12th\n- as2#20: 13th");
		expect(body).toContain("**Left the board**\n- Old work (jo-issues#30)");
		expect(body).toContain("1. Two trains (jo-issues#1): same");
		expect(body).toContain("2. jo-issues#2: up from 5th");
		expect(body).toContain("3. jo-issues#3: no rank before");
		expect(body).toContain("5. jo-issues#5: down from 2nd");
		expect(body).toContain("Other moves: 1 item below the top 10 changed rank.");
		expect(body).toContain("Jev: 7 new calls, $0.0004.");
		expect(body).toContain("- Order: `/state/runs/r/order.json`");
		expect(body).toContain(`- Undo the board: \`${undoCommand("/state/runs/r/backup.json")}\``);
		expect(undoCommand("/b.json")).toBe("as2 backlog-rank --undo /b.json");
	});

	test("the advertised undo command passes a hostile backup path as exactly one literal shell argument", () => {
		const path = "/state/a space/quote'/$HOME/back\\slash;echo injected/backup.json";
		const result = Bun.spawnSync(["/bin/sh", "-c", `as2() { printf '%s\\n' "$@"; }; ${undoCommand(path)}`], { env: { HOME: "/expanded-home" } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toBe(`backlog-rank\n--undo\n${path}\n`);
	});

	test("an abandoned run says it failed after 3 attempts, the phase, k of n writes, and the undo command only with a backup", () => {
		const failed = (backupPath: string | null) => commentBody({ runId: RUN, outcome: "abandoned", failure: { phase: "writing", attempts: 3, writesDone: 40, writesTotal: 120, error: "HTTP 502" }, backupPath });
		const withBackup = failed("/state/runs/r/backup.json");
		expect(withBackup).toContain(`**Backlog re-rank ${RUN}: failed after 3 attempts**`);
		expect(withBackup).toContain("It stopped in the writing phase, with 40 of 120 board writes done. Last error: HTTP 502");
		expect(withBackup).toContain("as2 backlog-rank --undo /state/runs/r/backup.json");
		expect(failed(null)).not.toContain("--undo");
		expect(failed(null)).not.toContain("done**");
	});
});

// ---- ported from rank-issues.ts --------------------------------------------------------------------------------------

describe("ported helpers", () => {
	test("issueReferences reads jo-issues#N, the issue URL and Jo's issue N, not other repos' numbers", () => {
		expect(issueReferences("Fixes jo-issues#12 and https://github.com/thewolff/jo-issues/issues/40; Jo's issue 7; thewolff/x#3; as2#5; foo-jo-issues#9")).toEqual([12, 40, 7]);
	});

	test("laneStates: blocked on a held question, running with a fresh lease, parked otherwise, none with no open workload", () => {
		const now = Date.parse("2026-10-20T19:00:00Z");
		const w = (id: string, brief: string, over: Record<string, unknown> = {}) => ({ id, brief, status: "open", created_at: "2026-10-20T10:00:00Z", lease_at: null, message: null, ...over });
		const states = laneStates([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }], [
			w("wl-a", "jo-issues#1", { message: { state: "held", body: "QUESTION: which way?" } }),
			w("wl-b", "jo-issues#2", { lease_at: "2026-10-20T18:59:00Z" }),
			w("wl-c", "jo-issues#3", { lease_at: "2026-10-20T18:50:00Z" }),
			w("wl-d", "jo-issues#4", { status: "closed" }),
			w("wl-e", "nothing"),
		], [{ workload_id: "wl-e", body: "also jo-issues#5" }], now);
		expect(states.map((s) => s.state)).toEqual(["blocked", "running", "parked", "none", "parked"]);
		const items = itemsFromIssues("jo-issues", [{ id: "C2", number: 2, title: "t", body: "", createdAt: "2026-10-15T00:00:00Z" }])
			.concat(itemsFromIssues("agent-system-2.0", [{ id: "C9", number: 2, title: "t", body: "", createdAt: "2026-10-15T00:00:00Z" }]));
		expect(itemLaneStates(items, [w("wl-b", "jo-issues#2", { lease_at: "2026-10-20T18:59:00Z" })], [], now)).toEqual(new Map([["jo-issues#2", "running"], ["as2#2", "none"]]));
	});

	test("rankedAt is the Pacific stamp", () => {
		expect(rankedAt(new Date("2026-10-20T19:10:14Z"))).toBe("12:10 PM PDT Oct 20");
		expect(rankedAt(new Date("2026-12-01T17:05:00Z"))).toBe("9:05 AM PST Dec 1");
	});

	test("parseRanking refuses an incomplete or doubled ranking", () => {
		const out = " 1. A (jo-issues#1)  score 0.5\n 2. B (as2#2)  score 0.4\njev cost $0.0001 job j1\n";
		expect(parseRanking(out, [{ id: "jo-issues#1", title: "A" }, { id: "as2#2", title: "B" }])).toEqual({ ranked: [{ id: "jo-issues#1", title: "A", score: 0.5 }, { id: "as2#2", title: "B", score: 0.4 }], cost: 0.0001, job: "j1" });
		expect(() => parseRanking(out, [{ id: "jo-issues#1", title: "A" }])).toThrow(/not a complete unique permutation/);
		expect(() => parseRanking(out.replace("jev cost", "cost"), [{ id: "jo-issues#1", title: "A" }, { id: "as2#2", title: "B" }])).toThrow();
	});
});
