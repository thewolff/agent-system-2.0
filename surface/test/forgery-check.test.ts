// The forgery check over plain rows (PLAN wl-mvfxw3c4zqfzls D2, R1-R5, the check side of R6/R7, R9): which
// Jo-authority rows each rule flags, which Jo channels pass, the per-kind global cutovers, row 11's own-lane shape,
// and a confirmed row.
import { describe, expect, test } from "bun:test";
import { type EntryRow, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, type ProvenanceRow, type QuestionRow } from "../../ledger/src/index";
import { forgeryReversedBody } from "../../ledger/src/jo-channel";
import { checkForgery, type ForgeryHit, type ForgeryInput, isLaneId, JO_CHANNEL } from "../src/forgery";
import { controlEntries, laneStopRequestBody, planApprovedBody, planFirst, planFirstBody } from "../src/launch";
import { MERGE_TRAIN_BY, SURFACE_BY } from "../src/types";

const WL = "wl-mfx";
const OWN_LANE = "lane-mfx-2";
const OTHER_LANE = "lane-other-1";
const CUT = "2026-10-20T00:00:00.000Z";
const BEFORE = "2026-10-19T23:00:00.000Z";
const AFTER = "2026-10-20T01:00:00.000Z";

let seq = 0;
/** Zero-padded, so ids sort as created and the check's row-id order is the fixture order. */
const next = () => String(++seq).padStart(4, "0");
const ins = (over: Partial<InstructionRow> = {}): InstructionRow => ({
	id: `in-${next()}`, workload_id: WL, slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface",
	author: "jo", body: "words", created_by: SURFACE_BY, created_at: AFTER, ...over,
});
const ent = (body: string, created_by: string = SURFACE_BY, created_at = AFTER): EntryRow => ({
	id: `en-${next()}`, workload_id: WL, slice_id: null, kind: "assumption", body, created_by, created_at,
});
const q = (created_by: string, id = `q-${next()}`): QuestionRow => ({
	id, workload_id: WL, slice_id: "sl-x", body: "?", options: "[]", state: "open", resolved_by: null, created_by, created_at: BEFORE,
	changed_by: created_by, changed_at: BEFORE, rev: 0,
});
const mark = (tbl: "instructions" | "entries", row: { id: string; created_at: string }, detail: "surface" | "launcher"): ProvenanceRow => ({
	seq: ++seq, at: row.created_at, workload_id: WL, lane_instance: JO_CHANNEL, tbl, row_id: row.id, action: "insert", detail,
});
const BOTH = { surface: CUT, launcher: CUT };
const NONE = { surface: null, launcher: null };
const check = (over: Partial<ForgeryInput>): ForgeryHit[] =>
	checkForgery({ workloadId: WL, instructions: [], questions: [], entries: [], provenance: [], cutovers: BOTH, ...over });
const rules = (hits: ForgeryHit[]) => hits.map((h) => `${h.rowId} ${h.rule}`);

describe("F1 unmarked (R1)", () => {
	test("after the surface cutover, an unmarked author-jo surface-stamped instructions row of any kind is flagged", () => {
		const rows = (["instruction", "answer", "withdrawal", "mode-flip"] as const).map((kind) =>
			ins({ kind, question_id: kind === "answer" || kind === "withdrawal" ? "q-1" : null }));
		const hits = check({ instructions: rows });
		expect(rules(hits)).toEqual(rows.map((r) => `${r.id} F1`));
		expect(hits.every((h) => h.table === "instructions" && h.workloadId === WL && h.detail.startsWith("F1 unmarked"))).toBe(true);
	});

	test("an unmarked surface-stamped jo-only entry is flagged; a plain note is not", () => {
		const plan = ent(planApprovedBody("in-9"));
		const repo = ent("repo: /x/y");
		const note = ent("notice: something");
		expect(rules(check({ entries: [plan, repo, note] }))).toEqual([`${plan.id} F1`, `${repo.id} F1`]);
	});

	test("a mark of either kind on the row's own id passes; a mark on another id or table does not", () => {
		const a = ins();
		const b = ins();
		const c = ins();
		const e = ent(planApprovedBody(a.id));
		const hits = check({
			instructions: [a, b, c], entries: [e],
			provenance: [mark("instructions", a, "surface"), mark("instructions", b, "launcher"), mark("entries", c, "surface"), mark("entries", e, "launcher")],
		});
		expect(rules(hits)).toEqual([`${c.id} F1`]);
	});

	test("a provenance row that is not a jo-channel insert is not a mark", () => {
		const a = ins();
		const p = mark("instructions", a, "surface");
		expect(rules(check({ instructions: [a], provenance: [{ ...p, lane_instance: SURFACE_BY }] }))).toEqual([`${a.id} F1`]);
	});

	test("a row before the surface cutover is not flagged", () => {
		expect(check({ instructions: [ins({ created_at: BEFORE })], entries: [ent("plan: first x", SURFACE_BY, BEFORE)] })).toEqual([]);
	});

	test("an instruction not authored jo is not a Jo-authority row for F1", () => {
		expect(check({ instructions: [ins({ author: "orchestrator" })] })).toEqual([]);
	});
});

describe("F2 wrong-channel (R2)", () => {
	const question = q(OWN_LANE, "q-own");
	const typed = (over: Partial<InstructionRow> = {}) =>
		ins({ kind: "answer", channel: "direct", question_id: question.id, created_by: LANE_STARTER_BY, ...over });

	test("(a) an author-jo lane-starter row not of the lane-typed shape is flagged, cutover or not", () => {
		const wrong = [
			typed({ kind: "instruction", question_id: null }),
			typed({ channel: "surface" }),
			typed({ question_id: null }),
			typed({ kind: "mode-flip", question_id: null }),
		];
		const provenance = wrong.map((r) => mark("instructions", r, "launcher"));
		const hits = check({ instructions: wrong, provenance, cutovers: NONE });
		expect(rules(hits)).toEqual(wrong.map((r) => `${r.id} F2`));
	});

	test("(a) after the launcher cutover a lane-typed row needs a launcher mark on its own id", () => {
		const unmarked = typed();
		const surfaceMarked = typed();
		const launcherMarked = typed();
		const withdrawal = typed({ kind: "withdrawal", disposition: "cancel" });
		const hits = check({
			instructions: [unmarked, surfaceMarked, launcherMarked, withdrawal], questions: [question],
			provenance: [mark("instructions", surfaceMarked, "surface"), mark("instructions", launcherMarked, "launcher"), mark("instructions", withdrawal, "launcher")],
		});
		expect(rules(hits)).toEqual([`${unmarked.id} F2`, `${surfaceMarked.id} F2`]);
	});

	test("(a) before the launcher cutover an unmarked lane-typed row passes", () => {
		expect(check({ instructions: [typed()], questions: [question], cutovers: { surface: CUT, launcher: null } })).toEqual([]);
		expect(check({ instructions: [typed({ created_at: BEFORE })], questions: [question] })).toEqual([]);
	});

	test("(b) an author-jo surface-stamped direct row is always flagged, marked or not", () => {
		const direct = ins({ channel: "direct" });
		const hits = check({ instructions: [direct], provenance: [mark("instructions", direct, "surface")], cutovers: NONE });
		expect(rules(hits)).toEqual([`${direct.id} F2`]);
	});

	test("(c) an author-jo row stamped other than the surface or lane-starter is flagged outside row 11's own-lane shape", () => {
		const byHand = ins({ channel: "direct", created_by: "lane-plumb-by-hand" });
		const otherLane = ins({ channel: "direct", created_by: OTHER_LANE });
		const ownLaneSurfaceChannel = ins({ channel: "surface", created_by: OWN_LANE });
		const ownLaneWithQuestion = ins({ channel: "direct", created_by: OWN_LANE, question_id: "q-own" });
		const runner = ins({ channel: "direct", created_by: LANE_RUNNER_BY });
		const hits = check({ instructions: [byHand, otherLane, ownLaneSurfaceChannel, ownLaneWithQuestion, runner], cutovers: NONE });
		expect(rules(hits)).toEqual([byHand, otherLane, ownLaneSurfaceChannel, ownLaneWithQuestion, runner].map((r) => `${r.id} F2`));
	});

	test("row 11's own-lane shape passes with every cutover set and no mark", () => {
		const row11 = ins({ channel: "direct", created_by: OWN_LANE });
		const firstLane = ins({ channel: "direct", created_by: "lane-mfx-1" });
		expect(check({ instructions: [row11, firstLane] })).toEqual([]);
	});

	test("a lane id of a workload whose id extends this one's is not this workload's lane", () => {
		expect(rules(check({ instructions: [ins({ id: "in-ext", channel: "direct", created_by: "lane-mfx-x-1" })] }))).toEqual(["in-ext F2"]);
	});
});

describe("F3 lane-resolves-own (R3)", () => {
	test("a question resolved by an instruction stamped with an exact lane id is flagged", () => {
		const answer = ins({ kind: "answer", channel: "direct", question_id: "q-1", author: "jo", created_by: OWN_LANE });
		const withdrawal = ins({ kind: "withdrawal", channel: "direct", question_id: "q-2", author: OWN_LANE, created_by: OWN_LANE, disposition: "replan" });
		const hits = check({ instructions: [answer, withdrawal], questions: [q(OWN_LANE, "q-1"), q(OWN_LANE, "q-2")], cutovers: NONE });
		expect(hits.filter((h) => h.rule === "F3").map((h) => h.rowId)).toEqual([answer.id, withdrawal.id]);
		expect(hits.find((h) => h.rule === "F3")?.detail).toContain(`stamped by lane ${OWN_LANE}`);
	});

	test("an answer authored other than jo is flagged whatever its stamp", () => {
		const answer = ins({ kind: "answer", question_id: "q-1", author: "orchestrator" });
		const runnerAnswer = ins({ kind: "answer", channel: "direct", question_id: "q-1", author: LANE_RUNNER_BY, created_by: LANE_RUNNER_BY });
		const hits = check({ instructions: [answer, runnerAnswer], cutovers: NONE });
		expect(rules(hits)).toEqual([`${answer.id} F3`, `${runnerAnswer.id} F3`]);
	});

	test("lane-runner and lane-starter are not lane ids", () => {
		expect(isLaneId(LANE_RUNNER_BY)).toBe(false);
		expect(isLaneId(LANE_STARTER_BY)).toBe(false);
		expect(isLaneId("lane-plumb-by-hand")).toBe(false);
		expect(isLaneId(OWN_LANE)).toBe(true);
		expect(isLaneId("lane-mvfxw3c4zqfzls-12")).toBe(true);
	});

	test("a lane-typed answer (lane-starter) and Jo's surface answer are not F3", () => {
		const typed = ins({ kind: "answer", channel: "direct", question_id: "q-1", created_by: LANE_STARTER_BY });
		const surface = ins({ kind: "answer", question_id: "q-2" });
		const hits = check({
			instructions: [typed, surface], questions: [q(OWN_LANE, "q-1"), q(OWN_LANE, "q-2")],
			provenance: [mark("instructions", typed, "launcher"), mark("instructions", surface, "surface")],
		});
		expect(hits).toEqual([]);
	});
});

describe("F4 machinery-resolves (R4)", () => {
	const withdraw = (questionId: string, by: string, author = by) =>
		ins({ kind: "withdrawal", channel: "direct", question_id: questionId, author, created_by: by, disposition: "replan" });

	test("lane-runner withdrawing a question lane-runner raised is not flagged by any rule", () => {
		const ceilingQ = q(LANE_RUNNER_BY);
		expect(check({ instructions: [withdraw(ceilingQ.id, LANE_RUNNER_BY)], questions: [ceilingQ] })).toEqual([]);
	});

	test("a withdrawal not authored jo is flagged otherwise", () => {
		const laneQ = q(OWN_LANE);
		const runnersOther = withdraw(laneQ.id, LANE_RUNNER_BY);
		const unknownQ = withdraw("q-gone", LANE_RUNNER_BY);
		const train = withdraw(laneQ.id, MERGE_TRAIN_BY);
		const authoredRunnerBySurface = withdraw(q(LANE_RUNNER_BY, "q-r").id, SURFACE_BY, LANE_RUNNER_BY);
		const hits = check({ instructions: [runnersOther, unknownQ, train, authoredRunnerBySurface], questions: [laneQ, q(LANE_RUNNER_BY, "q-r")] });
		expect(rules(hits)).toEqual([runnersOther, unknownQ, train, authoredRunnerBySurface].map((r) => `${r.id} F4`));
	});

	test("Jo's marked surface withdrawal is not flagged", () => {
		const w = ins({ kind: "withdrawal", question_id: "q-1", disposition: "cancel" });
		expect(check({ instructions: [w], questions: [q(OWN_LANE, "q-1")], provenance: [mark("instructions", w, "surface")] })).toEqual([]);
	});
});

describe("F5 prefix-wrong-writer (R5)", () => {
	test("a jo-only control entry validWriter rejects is flagged", () => {
		const lanePlan = ent(planApprovedBody("in-1"), OWN_LANE);
		const laneDone = ent("done: it works", OWN_LANE);
		const laneRequest = ent("launch-requested: go", OWN_LANE);
		const laneStop = ent(laneStopRequestBody(OWN_LANE, "x", "jo"), OWN_LANE);
		const runnerCeiling = ent("ceiling: 10", LANE_RUNNER_BY);
		const hits = check({ entries: [lanePlan, laneDone, laneRequest, laneStop, runnerCeiling], cutovers: NONE });
		expect(rules(hits)).toEqual([lanePlan, laneDone, laneRequest, laneStop, runnerCeiling].map((e) => `${e.id} F5`));
		expect(hits[0]!.detail).toContain(`stamped ${OWN_LANE}`);
	});

	test("the prefix's other WRITERS pass, and a non-jo-only prefix from its wrong writer is not F5", () => {
		const train = ent("launch-requested: train fix", MERGE_TRAIN_BY);
		const trainDone = ent("done: green", MERGE_TRAIN_BY);
		const starterStop = ent(laneStopRequestBody(OWN_LANE, "by-hand", "jo"), LANE_STARTER_BY);
		const machinery = ent(`lane-started: ${OWN_LANE} {}`, OWN_LANE);
		const nonAssumption: EntryRow = { ...ent("plan: approved in-1", OWN_LANE), kind: "wake-read" };
		expect(check({ entries: [train, trainDone, starterStop, machinery, nonAssumption], cutovers: NONE })).toEqual([]);
	});
});

describe("Jo channels pass (R6, R7 check side)", () => {
	test("surface-marked instructions, answers and jo-only entries pass", () => {
		const words = ins();
		const answer = ins({ kind: "answer", question_id: "q-1" });
		const flip = ins({ kind: "mode-flip" });
		const plan = ent(planApprovedBody(answer.id));
		const stop = ent(laneStopRequestBody(OWN_LANE, "jo", "jo"));
		const rows = { instructions: [words, answer, flip], entries: [plan, stop] };
		const provenance = [...rows.instructions.map((r) => mark("instructions", r, "surface")), ...rows.entries.map((r) => mark("entries", r, "surface"))];
		expect(check({ ...rows, questions: [q(OWN_LANE, "q-1")], provenance })).toEqual([]);
	});

	test("a launcher-marked lane-typed answer and its surface-stamped companion pass", () => {
		const question = q(OWN_LANE);
		const typed = ins({ kind: "answer", channel: "direct", question_id: question.id, created_by: LANE_STARTER_BY, body: "approve" });
		const companion = ent(planApprovedBody(typed.id));
		const provenance = [mark("instructions", typed, "launcher"), mark("entries", companion, "launcher")];
		expect(check({ instructions: [typed], questions: [question], entries: [companion], provenance })).toEqual([]);
	});
});

describe("cutovers are global and per mark kind (R9)", () => {
	const row = ins({ id: "in-r9" });
	const entry = ent("ceiling: 20", SURFACE_BY);

	test("before the first surface mark an unmarked surface row is not flagged, even after a launcher mark exists", () => {
		expect(check({ instructions: [row], entries: [entry], cutovers: { surface: null, launcher: CUT } })).toEqual([]);
	});

	test("once a surface cutover exists, the unmarked row is flagged though its workload has no marks", () => {
		expect(rules(check({ instructions: [row], entries: [entry], provenance: [], cutovers: { surface: CUT, launcher: null } })))
			.toEqual(["in-r9 F1", `${entry.id} F1`]);
	});

	test("a row at the cutover instant counts as after it", () => {
		expect(rules(check({ instructions: [ins({ id: "in-at", created_at: CUT })] }))).toEqual(["in-at F1"]);
	});
});

describe("confirmed rows and output shape", () => {
	test("a row named by a surface-stamped, surface-marked forgery-confirmed entry is not flagged; one stamped otherwise does not count", () => {
		const confirmed = ins();
		const lane = ins();
		const entries = [ent(`forgery-confirmed: ${confirmed.id} by in-abc`), ent(`forgery-confirmed: ${lane.id} by in-abc`, OWN_LANE)];
		// Only the instructions: the lane-stamped confirm entry's own standing is F5's, not this rule.
		expect(rules(check({ instructions: [confirmed, lane], entries, provenance: [mark("entries", entries[0]!, "surface")] }).filter((h) => h.table === "instructions"))).toEqual([`${lane.id} F1`]);
	});

	test("a confirmed entry and a confirmed resolving row pass every rule", () => {
		const lanePlan = ent(planApprovedBody("in-1"), OWN_LANE);
		const laneAnswer = ins({ kind: "answer", channel: "direct", question_id: "q-1", created_by: OWN_LANE });
		const entries = [lanePlan, ent(`forgery-confirmed: ${lanePlan.id} by in-a`), ent(`forgery-confirmed: ${laneAnswer.id} by in-b`)];
		expect(check({ instructions: [laneAnswer], entries, provenance: entries.slice(1).map((e) => mark("entries", e, "surface")) })).toEqual([]);
	});

	test("a confirmation a surface reversal names exempts nothing: its unmarked target is flagged, with no earlier hit of its own", () => {
		// A forged `plan: approved` and a forged confirmation of it, both unmarked and surface-stamped, before any hit names the plan;
		// then Jo's marked reversal of the confirmation.
		const plan = ent(planApprovedBody("in-1"));
		const confirmation = ent(`forgery-confirmed: ${plan.id} by in-a`);
		const reversal = ent(forgeryReversedBody(confirmation.id, "in-b"));
		const hits = check({ entries: [plan, confirmation, reversal], provenance: [mark("entries", reversal, "surface")] });
		expect(rules(hits)).toEqual([`${plan.id} F1`, `${confirmation.id} F1`]);
	});

	test("an unmarked confirmation after the surface cutover that names itself is an F1 hit", () => {
		const self = { ...ent("placeholder"), id: "en-self" };
		const confirmation = { ...self, body: `forgery-confirmed: ${self.id} by in-a` };
		expect(rules(check({ entries: [confirmation] }))).toEqual([`${self.id} F1`]);
	});

	test("an unmarked confirmation of an unmarked target leaves both flagged; so do an unmarked chain and cycle", () => {
		const plan = ent(planApprovedBody("in-1"));
		const confirmation = ent(`forgery-confirmed: ${plan.id} by in-a`);
		expect(rules(check({ entries: [plan, confirmation] }))).toEqual([`${plan.id} F1`, `${confirmation.id} F1`]);
		const chained = ent(`forgery-confirmed: ${confirmation.id} by in-b`);
		expect(rules(check({ entries: [plan, confirmation, chained] }))).toEqual([`${plan.id} F1`, `${confirmation.id} F1`, `${chained.id} F1`]);
		const a = { ...ent("placeholder"), id: "en-cycle-a", body: "forgery-confirmed: en-cycle-b by in-c" };
		const b = { ...ent("placeholder"), id: "en-cycle-b", body: "forgery-confirmed: en-cycle-a by in-d" };
		expect(rules(check({ entries: [a, b] }))).toEqual(["en-cycle-a F1", "en-cycle-b F1"]);
	});

	test("a marked confirmation exempts its target only: no chain through it, and no pre-cutover exception", () => {
		const plan = ent(planApprovedBody("in-1"));
		const confirmation = ent(`forgery-confirmed: ${plan.id} by in-a`);
		expect(check({ entries: [plan, confirmation], provenance: [mark("entries", confirmation, "surface")] })).toEqual([]);
		// a launcher mark is not the surface's: the confirmation is marked (no F1 of its own) but exempts nothing
		expect(rules(check({ entries: [plan, confirmation], provenance: [mark("entries", confirmation, "launcher")] }))).toEqual([`${plan.id} F1`]);
		// Jo's marked confirmation of the unmarked confirmation clears that confirmation's hit, never the plan's
		const root = ent(`forgery-confirmed: ${confirmation.id} by in-b`);
		expect(rules(check({ entries: [plan, confirmation, root], provenance: [mark("entries", root, "surface")] }))).toEqual([`${plan.id} F1`]);
		// before the surface cutover an unmarked confirmation is no answer either: a lane's plan stays F5
		const early = ent(planApprovedBody("in-2"), OWN_LANE, BEFORE);
		const earlyConfirmation = ent(`forgery-confirmed: ${early.id} by in-c`, SURFACE_BY, BEFORE);
		expect(rules(check({ entries: [early, earlyConfirmation] }))).toEqual([`${early.id} F5`]);
	});

	test("mode-compensation: is a jo-only prefix: unmarked after the cutover it is F1, from another writer F5, marked it passes", () => {
		const marked = ent("mode-compensation: in-c1 reverses in-f1");
		const unmarked = ent("mode-compensation: in-c2 reverses in-f2");
		const lane = ent("mode-compensation: in-c3 reverses in-f3", OWN_LANE);
		const hits = check({ entries: [marked, unmarked, lane], provenance: [mark("entries", marked, "surface")] });
		expect(rules(hits)).toEqual([`${unmarked.id} F1`, `${lane.id} F5`]);
	});

	test("a reversed reversal voids nothing: Jo's reversal of a forged reversal brings back a plan gate and a confirmation", () => {
		const gate = ent(planFirstBody("jo"));
		const forged = ent(forgeryReversedBody(gate.id, "in-x"));
		expect(planFirst(controlEntries([gate, forged]))).toBeNull();
		const jo = ent(forgeryReversedBody(forged.id, "in-y"));
		expect(planFirst(controlEntries([gate, forged, jo]))).toEqual({ trigger: "jo", entryId: gate.id });
		expect(controlEntries([gate, forged, jo]).map((c) => c.id)).toEqual([gate.id, jo.id]);
		// the same for a confirmation: a forged reversal of Jo's marked confirmation, reversed by Jo, exempts the target again
		const plan = ent(planApprovedBody("in-1"));
		const confirmation = ent(`forgery-confirmed: ${plan.id} by in-a`);
		const hide = ent(forgeryReversedBody(confirmation.id, "in-b"));
		const restore = ent(forgeryReversedBody(hide.id, "in-c"));
		const provenance = [confirmation, restore].map((e) => mark("entries", e, "surface"));
		expect(rules(check({ entries: [plan, confirmation, hide], provenance }))).toEqual([`${plan.id} F1`, `${hide.id} F1`]);
		expect(rules(check({ entries: [plan, confirmation, hide, restore], provenance }))).toEqual([`${hide.id} F1`]);
	});

	test("one hit per (row, rule), sorted by table, row id and rule, whatever the input order", () => {
		const a = ins({ id: "in-b", kind: "answer", channel: "direct", question_id: "q-1", created_by: OTHER_LANE });
		const b = ins({ id: "in-a", channel: "direct" });
		const e = ent(planApprovedBody("in-a"), OTHER_LANE);
		const rows = { instructions: [a, b, a], entries: [e] };
		const hits = check(rows);
		expect(rules(hits)).toEqual(["in-a F1", "in-a F2", "in-b F2", "in-b F3", `${e.id} F5`]);
		expect(check({ instructions: [b, a], entries: [e] })).toEqual(hits);
	});
});
