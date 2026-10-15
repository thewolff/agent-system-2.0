/**
 * The review round limit's pure half (PLAN wl-mupu0sx2o046io D9, test list "Round limit (D9), pure"):
 * defaults by stakes, raises that need a Jo instruction, the stakes flip, slice extends, rounds as
 * dispatch groups, the findings parser, the limit question and the estimate. Rows are built in
 * memory in the ledger's shapes; nothing opens a ledger.
 */
import { describe, expect, test } from "bun:test";
import {
	countRounds,
	type EntryInput,
	effectiveRoundLimit,
	type Findings,
	type FindingsOrUnknown,
	type InstructionInput,
	parseFindings,
	parseReviewRound,
	REVIEW_ROUND_DEFAULTS,
	type ReviewVerdict,
	reviewLimitBody,
	reviewLoopEndBody,
	reviewRoundBody,
	reviewRoundsBody,
	reviewRoundsExtendBody,
	roundLimitQuestionBody,
	roundsEstimate,
	roundsInstructionBody,
	TITLE_CAP,
	UNKNOWN,
} from "../src/rounds";
import { linkHeader, type Links } from "../../surface/src/question-links";

/** Links as `linksAtRaise` would compute them; the header itself is surface/src/question-links.ts's to test. */
const LINKS: Links = {
	plan: { kind: "none", reason: "the workload was never plan-first" },
	reviews: { kind: "slice", files: [{ slice: "sl-x", round: 3, token: "dt-3a", path: "/l/reviews/wl-x/dt-3a.md" }] },
	prs: { prs: [], unverified: null },
};
const SL = "sl-x";
const SURFACE = "orchestrator-surface";
let clock = 0;
const at = () => `2026-10-01T10:${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock++ % 60).padStart(2, "0")}.000Z`;

const entry = (body: string, slice: string | null = SL): EntryInput => ({ kind: "assumption", slice_id: slice, body, created_at: at() });
const instr = (id: string, body: string, over: Partial<InstructionInput> = {}): InstructionInput =>
	({ id, kind: "instruction", question_id: null, author: "jo", body, created_by: SURFACE, created_at: at(), ...over });

const block = (findings: unknown) => `Verdict: revise.\n\n\`\`\`review-findings\n${JSON.stringify({ findings })}\n\`\`\`\n`;
const f = (severity: string, kind: string, title: string) => ({ severity, kind, title });
const parsed = (text: string): Findings => {
	const p = parseFindings(text);
	if (p === UNKNOWN) throw new Error("expected findings");
	return p;
};
const findingsWith = (blocking: number): Findings => parsed(block(Array.from({ length: blocking }, (_, i) => f("blocking", "correctness", `b${i}`))));

const spawn = (token: string, group: string, slice = SL, review = "yes") =>
	entry(`hand-spawn: ${token} session /tmp/s/lane-1 spawn ${slice} review ${review} group ${group} row openai-codex/gpt-6-astra`, slice);
const settle = (token: string, group: string, verdict: ReviewVerdict, findings: FindingsOrUnknown, round = 1, slice = SL) =>
	entry(reviewRoundBody({ slice, round, token, group, verdict, findings }), slice);
/** A single-hand round, spawned and settled. */
const round = (token: string, verdict: ReviewVerdict, findings: FindingsOrUnknown) => [spawn(token, `dg-${token}`), settle(token, `dg-${token}`, verdict, findings)];

describe("limit: defaults and raises", () => {
	test("defaults are 3 / 3 / 5 by stakes", () => {
		expect(REVIEW_ROUND_DEFAULTS).toEqual({ throwaway: 3, normal: 3, production: 5 });
		for (const s of ["throwaway", "normal", "production"] as const) {
			expect(effectiveRoundLimit([], [], s, SL)).toEqual({ workload: REVIEW_ROUND_DEFAULTS[s], extend: 0, total: REVIEW_ROUND_DEFAULTS[s] });
		}
	});

	test("a rounds: 4 raise wins when it names Jo's rounds instruction", () => {
		const i = instr("in-r4", roundsInstructionBody(4));
		expect(effectiveRoundLimit([entry(reviewRoundsBody(4, "rounds word", "in-r4"), null)], [i], "normal", SL).total).toBe(4);
	});

	test("a review-rounds entry naming any other row is ignored", () => {
		const cases: Array<[string, InstructionInput[]]> = [
			["no such instruction", []],
			["a lane-authored rounds row", [instr("in-r4", "rounds: 4", { author: "lane-mupu-1" })]],
			["an author-jo row the surface did not write", [instr("in-r4", "rounds: 4", { created_by: "lane-mupu-1" })]],
			["a Jo instruction that is not a raise", [instr("in-r4", "looks good, carry on")]],
			["a rounds instruction with another number", [instr("in-r4", "rounds: 2")]],
			["an extend answer to a question that is not a review-limit one", [instr("in-r4", "extend", { kind: "answer", question_id: "q-ceiling" })]],
		];
		for (const [label, instructions] of cases) {
			const got = effectiveRoundLimit([entry(reviewRoundsBody(4, "rounds word", "in-r4"), null)], instructions, "normal", SL).total;
			expect({ label, got }).toEqual({ label, got: 3 });
		}
	});

	test("the newest valid entry wins over an older one", () => {
		const r4 = instr("in-r4", "rounds: 4");
		const r7 = instr("in-r7", "rounds: 7");
		const entries = [entry(reviewRoundsBody(4, "rounds word", "in-r4"), null), entry(reviewRoundsBody(7, "rounds word", "in-r7"), null)];
		expect(effectiveRoundLimit(entries, [r4, r7], "normal", SL).workload).toBe(7);
	});

	test("a stakes flip after a raise re-sizes the limit to the new stakes' default", () => {
		const r4 = instr("in-r4", "rounds: 4");
		const entries = [entry(reviewRoundsBody(4, "rounds word", "in-r4"), null)];
		const flip = instr("in-flip", "stakes: production");
		expect(effectiveRoundLimit(entries, [r4, flip], "production", SL).workload).toBe(5);
		// A raise after the flip wins again.
		const r6 = instr("in-r6", "rounds: 6");
		const later = [...entries, entry(reviewRoundsBody(6, "rounds word", "in-r6"), null)];
		expect(effectiveRoundLimit(later, [r4, flip, r6], "production", SL).workload).toBe(6);
		// A stakes flip a lane wrote (not the surface) re-sizes nothing.
		const forged = instr("in-forged", "stakes: production", { created_by: "lane-mupu-1" });
		expect(effectiveRoundLimit(entries, [r4, forged], "production", SL).workload).toBe(4);
	});
});

describe("limit: slice extends", () => {
	const q = "q-limit-x";
	const answer = (id: string, question = q) => instr(id, "extend", { kind: "answer", question_id: question });

	test("an extend adds one default block to that slice only, once per answer", () => {
		const a = answer("in-ext");
		const entries = [
			entry(reviewLimitBody(q, SL)),
			entry(reviewRoundsExtendBody(SL, 3, "in-ext")),
			entry(reviewRoundsExtendBody(SL, 3, "in-ext")),
		];
		expect(effectiveRoundLimit(entries, [a], "normal", SL)).toEqual({ workload: 3, extend: 3, total: 6 });
		expect(effectiveRoundLimit(entries, [a], "normal", "sl-y").total).toBe(3);
	});

	test("an extend naming another slice's limit question, or not from Jo, adds nothing", () => {
		const entries = [entry(reviewLimitBody("q-limit-y", "sl-y")), entry(reviewRoundsExtendBody(SL, 3, "in-ext"))];
		expect(effectiveRoundLimit(entries, [answer("in-ext", "q-limit-y")], "normal", SL).total).toBe(3);
		const own = [entry(reviewLimitBody(q, SL)), entry(reviewRoundsExtendBody(SL, 3, "in-ext"))];
		expect(effectiveRoundLimit(own, [instr("in-ext", "extend", { kind: "answer", question_id: q, author: "lane-mupu-1" })], "normal", SL).total).toBe(3);
	});

	test("a new loop starts with the full allowance, without the old loop's extends", () => {
		const entries = [entry(reviewLimitBody(q, SL)), entry(reviewRoundsExtendBody(SL, 3, "in-ext")), entry(reviewLoopEndBody(SL, "accept"))];
		expect(effectiveRoundLimit(entries, [answer("in-ext")], "normal", SL).total).toBe(3);
	});
});

describe("countRounds", () => {
	test("a fan-out group of two hands is one round, complete only when both settled", () => {
		const both = [spawn("dt-a", "dg-1"), spawn("dt-b", "dg-1"), settle("dt-a", "dg-1", "accepted", findingsWith(2))];
		let c = countRounds(both, SL);
		expect(c.rounds).toHaveLength(1);
		expect(c.rounds[0]!.complete).toBe(false);
		expect(c.failed).toBe(0);
		c = countRounds([...both, settle("dt-b", "dg-1", "accepted", findingsWith(1))], SL);
		expect(c.rounds).toHaveLength(1);
		expect(c.rounds[0]).toMatchObject({ complete: true, passed: false, blocking: 3 });
		expect(c.failed).toBe(1);
		expect(c.next).toBe(2);
	});

	test("a production round with one accepted clean leg and one withheld clean leg fails", () => {
		const entries = [
			spawn("dt-a", "dg-1"), spawn("dt-b", "dg-1"),
			settle("dt-a", "dg-1", "accepted", findingsWith(0)),
			settle("dt-b", "dg-1", "withheld", findingsWith(0)),
		];
		expect(countRounds(entries, SL)).toMatchObject({ failed: 1, passed: false });
	});

	test("a clean accepted hand named by review-withheld: fails its round", () => {
		const entries = [...round("dt-a", "accepted", findingsWith(0)), entry("review-withheld: dt-a")];
		expect(countRounds(entries, SL)).toMatchObject({ failed: 1, passed: false });
		expect(countRounds(round("dt-a", "accepted", findingsWith(0)), SL)).toMatchObject({ failed: 0, passed: true });
	});

	test("a dispatch refused before any spawn is not a round", () => {
		// No hand-spawn entry; only refused or dropped members recorded.
		const entries = [
			settle("dt-r", "dg-r", "refused", UNKNOWN),
			settle("dt-d", "dg-d", "dropped", UNKNOWN),
			...round("dt-a", "accepted", findingsWith(1)),
		];
		const c = countRounds(entries, SL);
		expect(c.rounds.map((r) => r.group)).toEqual(["dg-dt-a"]);
		expect(c.rounds[0]!.n).toBe(1);
		expect(c.failed).toBe(1);
	});

	test("a member refused at spawn beside a clean one that ran leaves the round unread: no known block failed it", () => {
		const entries = [spawn("dt-a", "dg-1"), settle("dt-a", "dg-1", "accepted", findingsWith(0)), settle("dt-b", "dg-1", "refused", UNKNOWN)];
		const c = countRounds(entries, SL);
		expect(c.rounds).toHaveLength(1);
		expect(c.rounds[0]).toMatchObject({ complete: true, passed: false, unread: true, blocking: 0, unknown: 1 });
		expect(c).toMatchObject({ failed: 0, failedKnown: 0, unread: 1, passed: false });
	});

	test("a group whose spawned members all failed to dispatch is no round; one beside a member that ran is not counted", () => {
		const failed = [spawn("dt-f", "dg-f"), settle("dt-f", "dg-f", "failed-dispatch", UNKNOWN)];
		expect(countRounds(failed, SL)).toMatchObject({ rounds: [], failed: 0, next: 1 });
		const c = countRounds([...failed, ...round("dt-a", "accepted", findingsWith(0))], SL);
		expect(c.rounds.map((r) => [r.n, r.group])).toEqual([[1, "dg-dt-a"]]);
		expect(c.passed).toBe(true);
		const mixed = [spawn("dt-a", "dg-1"), spawn("dt-b", "dg-1"), settle("dt-a", "dg-1", "accepted", findingsWith(0)), settle("dt-b", "dg-1", "failed-dispatch", UNKNOWN)];
		expect(countRounds(mixed, SL).rounds).toMatchObject([{ n: 1, complete: true, passed: true, members: [{ token: "dt-a" }] }]);
	});

	test("an unknown block with nothing known leaves the round unread, not passed; the loop's first unread round is free", () => {
		const c = countRounds(round("dt-a", "accepted", parseFindings("Looks fine, no block.")), SL);
		expect(c.rounds[0]).toMatchObject({ complete: true, passed: false, unread: true, blocking: null, unknown: 1 });
		expect(c).toMatchObject({ failed: 0, failedKnown: 0, unread: 1, passed: false });
	});

	test("PLAN wl-mv5i3lulwwbbi8 D9, the q-mv50pdoft80x6o shape: four rounds with a known blocking hand beside an unread one, then one unread round", () => {
		const pair = (n: number, blocking: number) => [
			spawn(`dt-${n}a`, `dg-${n}`), spawn(`dt-${n}b`, `dg-${n}`),
			settle(`dt-${n}a`, `dg-${n}`, "accepted", findingsWith(blocking), n),
			settle(`dt-${n}b`, `dg-${n}`, "withheld", UNKNOWN, n),
		];
		const entries = [...pair(1, 2), ...pair(2, 3), ...pair(3, 1), ...pair(4, 4), ...round("dt-5", "withheld", UNKNOWN)];
		const c = countRounds(entries, SL);
		expect(c).toMatchObject({ failedKnown: 4, unread: 1, failed: 4, passed: false, next: 6 });
		expect(c.rounds.map((r) => r.blocking)).toEqual([2, 3, 1, 4, null]);
		expect(c.rounds.map((r) => r.unknown)).toEqual([1, 1, 1, 1, 1]);
		expect(c.rounds.map((r) => r.unread)).toEqual([false, false, false, false, true]);
		// At the production default of 5 the loop is not at its limit: the next review may run.
		expect(c.failed < effectiveRoundLimit(entries, [], "production", SL).total).toBe(true);
	});

	test("three unread rounds: the first is free, the other two count as failed", () => {
		const entries = [...round("dt-1", "withheld", UNKNOWN), ...round("dt-2", "accepted", UNKNOWN), ...round("dt-3", "dropped", UNKNOWN)];
		expect(countRounds(entries, SL)).toMatchObject({ failedKnown: 0, unread: 3, failed: 2 });
	});

	test("a known clean block beside an unknown one is unread; a known clean block not accepted fails", () => {
		const unread = [spawn("dt-a", "dg-1"), spawn("dt-b", "dg-1"), settle("dt-a", "dg-1", "accepted", findingsWith(0)), settle("dt-b", "dg-1", "accepted", UNKNOWN)];
		expect(countRounds(unread, SL)).toMatchObject({ rounds: [{ unread: true, passed: false, blocking: 0, unknown: 1 }], failedKnown: 0, unread: 1, failed: 0 });
		const failed = [...unread.slice(0, 3), settle("dt-b", "dg-1", "withheld", findingsWith(0))];
		expect(countRounds(failed, SL)).toMatchObject({ rounds: [{ unread: false, passed: false, blocking: 0, unknown: 0 }], failedKnown: 1, unread: 0, failed: 1 });
	});

	test("only rounds after the slice's latest review-loop-end: count; a round running at the end stays in the old loop", () => {
		const entries = [
			...round("dt-1", "accepted", findingsWith(4)),
			...round("dt-2", "accepted", findingsWith(3)),
			spawn("dt-3", "dg-3"),
			entry(reviewLoopEndBody(SL, "stop-reviews")),
			settle("dt-3", "dg-3", "accepted", findingsWith(1)),
			entry(reviewLoopEndBody("sl-y", "pass"), "sl-y"),
			...round("dt-4", "accepted", findingsWith(2)),
		];
		const c = countRounds(entries, SL);
		expect(c.rounds.map((r) => r.group)).toEqual(["dg-dt-4"]);
		expect(c.failed).toBe(1);
	});

	test("after a passing round and its loop end, the next review starts a fresh loop", () => {
		const entries = [
			...round("dt-1", "accepted", findingsWith(2)),
			...round("dt-2", "accepted", findingsWith(0)),
		];
		expect(countRounds(entries, SL)).toMatchObject({ failed: 1, passed: true });
		const after = [...entries, entry(reviewLoopEndBody(SL, "pass")), ...round("dt-3", "accepted", findingsWith(1))];
		expect(countRounds(after, SL)).toMatchObject({ failed: 1, passed: false, next: 2 });
	});

	test("other slices, non-review spawns and malformed bodies are not counted", () => {
		const entries = [
			spawn("dt-y", "dg-y", "sl-y"), settle("dt-y", "dg-y", "accepted", findingsWith(1), 1, "sl-y"),
			spawn("dt-c", "dg-c", SL, "no"),
			entry(`review-round: ${SL} round 1 token dt-z group dg-z verdict accepted blocking 0 counts {not json`),
			entry(`review-round: ${SL} round 1 token dt-z group dg-z verdict accepted blocking 5 counts ${JSON.stringify(findingsWith(1))}`),
		];
		expect(countRounds(entries, SL).rounds).toEqual([]);
	});
});

describe("parseFindings and the review-round body", () => {
	test("the parser takes the last review-findings block", () => {
		const text = `${block([f("blocking", "security", "early")])}\nRevised after re-reading:\n${block([f("minor", "docs", "typo"), f("major", "tests", "no edge test")])}`;
		const p = parsed(text);
		expect(p.counts).toEqual({ blocking: {}, major: { tests: 1 }, minor: { docs: 1 } });
		expect(p.titles.map((t) => t.title)).toEqual(["typo", "no edge test"]);
	});

	test("a missing block, unparsable JSON, or an out-of-list severity or kind is unknown, even after a valid block", () => {
		const valid = block([f("minor", "docs", "x")]);
		const malformed = [
			"no block at all",
			"```json\n{\"findings\":[]}\n```",
			`${valid}\n\`\`\`review-findings\n{"findings": [\n\`\`\``,
			`${valid}\n${block([f("critical", "docs", "x")])}`,
			`${valid}\n${block([f("minor", "style", "x")])}`,
			`${valid}\n${block([f("minor", "docs", "  ")])}`,
			`${valid}\n\`\`\`review-findings\n{"verdict":"ok"}\n\`\`\``,
			"```review-findings\n{\"findings\":[]}\n", // unterminated
		];
		for (const text of malformed) expect({ text, got: parseFindings(text) }).toEqual({ text, got: UNKNOWN });
	});

	test("REVIEW-r1 #5: a clean closed block followed by an unterminated final block is unknown, not the earlier clean findings", () => {
		const text = `${block([])}\nOne more pass:\n\`\`\`review-findings\n${JSON.stringify({ findings: [f("blocking", "correctness", "late")] })}\n`;
		expect(parseFindings(text)).toBe(UNKNOWN);
	});

	test("an empty findings list is known and clean", () => {
		const p = parsed(block([]));
		expect(p.counts).toEqual({ blocking: {}, major: {}, minor: {} });
	});

	test("counts cover every finding while titles are capped", () => {
		const many = Array.from({ length: TITLE_CAP + 5 }, (_, i) => f("minor", "other", `t${i}`));
		const p = parsed(block(many));
		expect(p.counts.minor.other).toBe(TITLE_CAP + 5);
		expect(p.titles).toHaveLength(TITLE_CAP);
	});

	test("a review-round body round-trips, unknown included", () => {
		const findings = parsed(block([f("blocking", "correctness", "off by one\nin paginate"), f("major", "design", "two conventions")]));
		const r = { slice: SL, round: 2, token: "dt-a", group: "dg-1", verdict: "accepted" as const, findings };
		const body = reviewRoundBody(r);
		expect(body).toStartWith(`review-round: ${SL} round 2 token dt-a group dg-1 verdict accepted blocking 1 counts {`);
		expect(findings.titles[0]!.title).toBe("off by one in paginate");
		expect(parseReviewRound(body)).toEqual(r);
		const u = { ...r, verdict: "refused" as const, findings: UNKNOWN };
		expect(reviewRoundBody(u)).toEndWith("verdict refused blocking unknown counts unknown");
		expect(parseReviewRound(reviewRoundBody(u))).toEqual(u);
	});
});

describe("roundsEstimate", () => {
	test("ceil(last / mean fall)", () => {
		expect(roundsEstimate([6, 3, 2])).toEqual({ kind: "estimate", rounds: 1, meanFall: 2, last: 2 });
		expect(roundsEstimate([9, 7, 5])).toEqual({ kind: "estimate", rounds: 3, meanFall: 2, last: 5 });
		expect(roundsEstimate([10, null, 4])).toEqual({ kind: "estimate", rounds: 1, meanFall: 6, last: 4 });
	});

	test("no estimate when flat, rising, or with fewer than two known rounds", () => {
		for (const counts of [[3, 3], [2, 4], [5, 3, 5], [4], [null, 4], []] as (number | null)[][]) {
			const e = roundsEstimate(counts);
			expect(e.kind).toBe("none");
			if (e.kind === "none") expect(e.reason).toStartWith("no estimate:");
		}
		const flat = roundsEstimate([3, 3]);
		expect(flat.kind === "none" && flat.reason).toBe("no estimate: the blocking count is not falling");
	});
});

describe("roundLimitQuestionBody", () => {
	test("lists severity × kind and titles for the final round, blocking per round, the labelled estimate and the three answers", () => {
		const r1 = findingsWith(6);
		const r2 = findingsWith(3);
		// The final round is a fan-out: one leg with findings, one leg with no block.
		const legA = parsed(block([
			f("minor", "docs", "stale comment"),
			f("blocking", "correctness", "null deref in settle"),
			f("major", "design", "second convention"),
			f("blocking", "tests", "no restart test"),
		]));
		const entries = [
			...round("dt-1", "accepted", r1),
			...round("dt-2", "accepted", r2),
			spawn("dt-3a", "dg-3"), spawn("dt-3b", "dg-3"),
			settle("dt-3a", "dg-3", "accepted", legA, 3),
			settle("dt-3b", "dg-3", "accepted", UNKNOWN, 3),
		];
		const count = countRounds(entries, SL);
		// Round 3's known leg reports blocking findings, so its unknown leg does not make it unread.
		expect(count).toMatchObject({ failed: 3, failedKnown: 3, unread: 0 });
		const limit = effectiveRoundLimit(entries, [], "normal", SL);
		const body = roundLimitQuestionBody(SL, count, limit, "normal", LINKS);
		const lines = body.split("\n");
		const header = linkHeader(LINKS);
		expect(lines.slice(0, header.length)).toEqual(header);
		expect(lines[header.length]).toBe(`The review of ${SL} reached its round limit: 3 failed rounds of 3 allowed (normal stakes).`);
		expect(body).toContain("Final round (round 3), remaining findings: blocking 2 (correctness 1, tests 1) · major 1 (design 1) · minor 1 (docs 1) · unknown: 1 hand with no readable findings block (dt-3b)");
		// Titles, blocking first.
		const titles = lines.filter((l) => l.startsWith("- "));
		expect(titles).toEqual(["- blocking correctness: null deref in settle", "- blocking tests: no restart test", "- major design: second convention", "- minor docs: stale comment"]);
		// Round 3's known leg sums to 2 with its unknown leg beside it; the estimate reads 6, 3, 2.
		expect(body).toContain("Blocking per round: round 1: 6 · round 2: 3 · round 3: 2 (+1 unknown)");
		expect(body).toContain("Estimate (not a measurement): about 1 more round, ceil(last 2 / mean fall 2 per round)");
		expect(lines.slice(-3).map((l) => l.split(":")[0])).toEqual(["extend", "accept", "stop"]);
		expect(body).toContain("extend: one more block of 3 rounds for sl-x");
	});

	test("says no estimate when the count is not falling, and names withheld hands", () => {
		const entries = [
			...round("dt-1", "accepted", findingsWith(2)),
			...round("dt-2", "withheld", findingsWith(2)),
		];
		const count = countRounds(entries, SL);
		const body = roundLimitQuestionBody(SL, count, { workload: 2, extend: 0, total: 2 }, "normal", LINKS);
		expect(body).toContain("Estimate (not a measurement): no estimate: the blocking count is not falling");
		expect(body).toContain("Output not accepted: dt-2 (withheld).");
		expect(body).toContain("Blocking per round: round 1: 2 · round 2: 2");
	});

	test("refuses to build a body without links", () => {
		const count = countRounds(round("dt-1", "accepted", findingsWith(2)), SL);
		expect(() => roundLimitQuestionBody(SL, count, { workload: 1, extend: 0, total: 1 }, "normal", undefined as unknown as Links)).toThrow("carries its links");
	});

	test("PLAN wl-mv5i3lulwwbbi8 D9: splits the failed rounds into those with findings and the unread, the first free", () => {
		const entries = [
			...round("dt-1", "accepted", findingsWith(2)),
			...round("dt-2", "withheld", UNKNOWN),
			...round("dt-3", "accepted", findingsWith(1)),
			...round("dt-4", "withheld", UNKNOWN),
		];
		const count = countRounds(entries, SL);
		expect(count).toMatchObject({ failedKnown: 2, unread: 2, failed: 3 });
		const body = roundLimitQuestionBody(SL, count, { workload: 3, extend: 0, total: 3 }, "normal", LINKS);
		expect(body.split("\n")[linkHeader(LINKS).length]).toBe(`The review of ${SL} reached its round limit: 3 failed rounds of 3 allowed (normal stakes): 2 failed with findings, 2 unread (1 free).`);
		expect(body).toContain("Blocking per round: round 1: 2 · round 2: unknown · round 3: 1 · round 4: unknown");
	});
});
