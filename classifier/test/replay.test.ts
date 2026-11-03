/**
 * (a) Replay of the classifier samples through classify() and route(), answered from the recorded
 * TypeSafe responses. Offline by construction. Each replay asks the question its sample was
 * recorded with: the calibrated 2026-10-20 recording (research/classifier-sample.md § Re-measurement
 * 2026-10-20; fixtures/kind-question-2026-10-20.json) and the superseded 2026-09-28 one
 * (§ Re-measurement 2026-09-28; fixtures/kind-question-2026-09-28.json). The classifier's own
 * question is gated on classifier/calibration.json, not on this file.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type Classification, classify, loadKindQuestion, questionSha256 } from "../src/classify";
import { KIND_TIER, isKind, route, type Routing, STAKES, type Stakes, tierRank } from "../src/route";
import {
	FIXTURE_PATH_2026_09_23,
	FIXTURE_PATH_2026_09_28,
	loadSample,
	RECORDED_QUESTION_PATH_2026_09_23,
	RECORDED_QUESTION_PATH_2026_09_28,
	recordedJudge,
	recordedQuestion,
	type SampleRow,
} from "./helpers";

const sample = loadSample(FIXTURE_PATH_2026_09_28);
const { rows } = sample;
const question = loadKindQuestion(RECORDED_QUESTION_PATH_2026_09_28);

describe("classifier sample replay, 2026-09-28 (superseded)", () => {
	test("the fixture's recorded question is the one the sample's answers came from", () => {
		// An edit to the recorded question invalidates the recorded answers; re-record, don't patch.
		expect(questionSha256(question)).toBe(sample.questionSha256);
		expect(rows).toHaveLength(32);
		expect(rows.filter(row => row.addition).map(row => row.id)).toEqual(["AddTwoFileMechanical", "AddOneFileUncheckable"]);
	});

	test("the superseded 2026-09-23 recording still belongs to its own question", () => {
		const old = loadSample(FIXTURE_PATH_2026_09_23);
		expect(questionSha256(loadKindQuestion(RECORDED_QUESTION_PATH_2026_09_23))).toBe(old.questionSha256);
		expect(old.questionSha256).not.toBe(sample.questionSha256);
	});

	test("reproduces the sample's kind assignments, agreement and 8-of-32 flag count", async () => {
		const judge = recordedJudge(rows);
		const results = [];
		for (const row of rows) {
			const classification = await classify(row.text, judge, question);
			results.push({ row, classification, routing: route(classification, null) });
		}

		// Every brief went to the judge once, and every kind came back as recorded.
		expect(judge.calls).toHaveLength(32);
		for (const { row, classification } of results) {
			expect(classification.choice).toBe(row.response.choice);
			expect(classification.judgeModel).toBe("typesafe/jev-1.13.0");
		}

		// § Re-measurement 2026-09-28 § Agreement: 21/30 on the original thirty, 2/2 on the additions;
		// choices understand 17, change-large 5, judge 5, locate 3, change-small 2.
		const agrees = (r: (typeof results)[number]) => r.classification.choice === r.row.hand_label;
		expect(results.filter(r => !r.row.addition && agrees(r))).toHaveLength(21);
		expect(results.filter(r => r.row.addition && agrees(r))).toHaveLength(2);
		const choices: Record<string, number> = {};
		for (const r of results) choices[r.classification.choice] = (choices[r.classification.choice] ?? 0) + 1;
		expect(choices).toEqual({ understand: 17, "change-large": 5, judge: 5, locate: 3, "change-small": 2 });

		// § Threshold sweep at 0.55 (strictly below): 7 of 32 flagged, 2 of them disagreements. The
		// inclusive threshold (ruled 2026-09-29) adds LedgerLifecycle, recorded at exactly 0.55: 8 and 3.
		const flagged = results.filter(r => r.routing.lowConfidence);
		expect(flagged.map(r => r.row.id).sort()).toEqual(
			[
				"ExtSqliteTest",
				"LedgerLifecycle",
				"LedgerThirdParty",
				"LensAbolishedSeat",
				"Phase5Agenda",
				"ResearchSelfImprove",
				"ScoutSeatHomes",
				"ScoutSkills",
			].sort(),
		);
		expect(flagged.filter(r => !agrees(r)).map(r => r.row.id).sort()).toEqual(["LedgerLifecycle", "LensAbolishedSeat", "ResearchSelfImprove"]);
	});

	test("at 0.55 no brief is routed below its hand label's tier; the pull-ups are the recorded five", async () => {
		const judge = recordedJudge(rows);
		const pulled: Record<string, string> = {};
		for (const row of rows) {
			const routing = route(await classify(row.text, judge, question), null);
			expect(routing.pullDown).toBeNull();
			if (!isKind(row.hand_label)) throw new Error(`fixture hand label is not a kind: ${row.hand_label}`);
			// The threshold's job (SPEC-2.0.md § A1.3): an uncertain answer is served at the higher of
			// its top two, so a misread never lands a brief on a weaker tier than its kind needs.
			expect(tierRank(routing.tier)).toBeGreaterThanOrEqual(tierRank(KIND_TIER[row.hand_label]));
			if (routing.pullUp) pulled[row.id] = `${routing.pullUp.from}->${routing.pullUp.to}`;
		}
		expect(pulled).toEqual({
			Phase5Agenda: "standard->strong",
			LensAbolishedSeat: "standard->deep",
			ScoutSkills: "fast->strong",
			ScoutSeatHomes: "fast->strong",
			ExtSqliteTest: "standard->strong",
		});
	});

	test("an unrecorded brief never reaches a live judge", async () => {
		await expect(classify("a brief nobody recorded", recordedJudge(rows), question)).rejects.toThrow(
			"no recorded classifier response",
		);
	});
});

const current = loadSample();
const currentQuestion = recordedQuestion();

function stakesOf(row: SampleRow): Stakes | null {
	if (row.stakes === undefined) return null;
	if (!(STAKES as readonly string[]).includes(row.stakes)) throw new Error(`fixture stakes is not a stakes level: ${row.stakes}`);
	return row.stakes as Stakes;
}

/** The audit row number `n` from an id `audit-<n>-<slice>`. */
const auditNumber = (id: string): number => Number(/^audit-(\d+)-/.exec(id)?.[1]);

describe("classifier sample replay, 2026-10-20 (calibrated)", () => {
	type Replayed = { row: SampleRow; classification: Classification; routed: Routing; uncapped: Routing };
	const replayed: Replayed[] = [];
	let calls = 0;
	beforeAll(async () => {
		const judge = recordedJudge(current.rows);
		for (const row of current.rows) {
			const classification = await classify(row.text, judge, currentQuestion);
			// `routed` applies the brief's own stakes cap, as dispatch did; `uncapped` is the kind's tier alone.
			replayed.push({ row, classification, routed: route(classification, stakesOf(row)), uncapped: route(classification, null) });
		}
		calls = judge.calls.length;
	});
	const of = (pick: (row: SampleRow) => boolean) => replayed.filter(r => pick(r.row));
	const ids = (rs: Replayed[]) => rs.map(r => r.row.id);

	test("the recorded question is the live classifier question, answered by the calibrated judge", () => {
		// An edit to either question invalidates the recorded answers; re-record, don't patch.
		expect(questionSha256(currentQuestion)).toBe(current.questionSha256);
		expect(questionSha256(loadKindQuestion())).toBe(current.questionSha256);
		expect(current.judgeModel).toBe("typesafe/jev-1.13.0");
		expect(current.rows.every(row => row.judge_model === "typesafe/jev-1.13.0")).toBe(true);
		expect(current.questionSha256).not.toBe(sample.questionSha256);

		const sets: Record<string, number> = {};
		for (const row of current.rows) sets[row.set ?? ""] = (sets[row.set ?? ""] ?? 0) + 1;
		expect(sets).toEqual({ sample: 32, audit: 20, "heldout-A": 20, "heldout-B": 10 });
		// The thirty-two are the 2026-09-28 briefs, same ids and texts, answered afresh.
		expect(of(row => row.set === "sample").map(r => [r.row.id, r.row.text])).toEqual(rows.map(row => [row.id, row.text]));
	});

	test("every brief goes to the judge once and every kind comes back as recorded", () => {
		expect(calls).toBe(current.rows.length);
		for (const { row, classification } of replayed) {
			expect(classification.choice).toBe(row.response.choice);
			expect(classification.judgeModel).toBe("typesafe/jev-1.13.0");
		}
	});

	test("the audit's 8 firm over-sizes route standard or lower with their stakes (R1)", () => {
		const firm = of(row => row.set === "audit" && row.audit === "firm");
		expect(firm.map(r => auditNumber(r.row.id))).toEqual([1, 5, 9, 10, 13, 16, 17, 20]);
		expect(firm.every(r => stakesOf(r.row) !== null)).toBe(true);
		expect(ids(firm.filter(r => tierRank(r.routed.tier) > tierRank("standard")))).toEqual([]);
	});

	test("the audit's 9 correct briefs stay on strong with their stakes (R2)", () => {
		const correct = of(row => row.set === "audit" && row.audit === "correct");
		expect(correct.map(r => auditNumber(r.row.id))).toEqual([2, 4, 6, 7, 8, 12, 15, 18, 19]);
		expect(ids(correct.filter(r => r.routed.tier !== "strong"))).toEqual([]);
	});

	test("the audit's docs rows choose change-small and its smoke rows understand or locate (R10)", () => {
		const docs = of(row => row.set === "audit" && [1, 5, 9, 13, 16, 20].includes(auditNumber(row.id)));
		const smoke = of(row => row.set === "audit" && [10, 17].includes(auditNumber(row.id)));
		expect(docs).toHaveLength(6);
		expect(smoke).toHaveLength(2);
		expect(ids(docs.filter(r => r.classification.choice !== "change-small"))).toEqual([]);
		expect(ids(smoke.filter(r => !["understand", "locate"].includes(r.classification.choice)))).toEqual([]);
	});

	test("AddTwoFileMechanical, a module plus its own test, chooses change-small and routes standard (R11)", () => {
		const [add] = of(row => row.id === "AddTwoFileMechanical");
		expect(add?.classification.choice).toBe("change-small");
		expect(add?.uncapped.tier).toBe("standard");
	});

	test("every held-out correct brief, sets A and B, routes strong with its stakes (R12)", () => {
		const correct = of(row => (row.set === "heldout-A" || row.set === "heldout-B") && row.label === "correct");
		expect(correct).toHaveLength(21);
		expect(ids(correct.filter(r => r.routed.tier !== "strong"))).toEqual([]);
	});

	test("at least 4 of held-out set A's 6 over briefs route standard or lower with their stakes (R14)", () => {
		// Set B's over briefs are not pinned: none of its three reaches standard, a shortfall Jo accepted
		// (research/classifier-sample.md § Re-measurement 2026-10-20).
		const over = of(row => row.set === "heldout-A" && row.label === "over");
		expect(over).toHaveLength(6);
		expect(over.filter(r => tierRank(r.routed.tier) <= tierRank("standard")).length).toBeGreaterThanOrEqual(4);
	});

	test("at 0.55 no brief of the sample is routed below its hand label's tier (R5)", () => {
		// The threshold's job (SPEC-2.0.md § A1.3): an uncertain answer is served at the higher of its
		// top two. The recording under-serves no brief, so no row is excepted.
		const under: string[] = [];
		for (const { row, uncapped } of replayed) {
			if (!isKind(row.hand_label)) throw new Error(`fixture hand label is not a kind: ${row.hand_label}`);
			expect(uncapped.pullDown).toBeNull();
			if (tierRank(uncapped.tier) < tierRank(KIND_TIER[row.hand_label])) under.push(row.id);
		}
		expect(under).toEqual([]);
	});
});
