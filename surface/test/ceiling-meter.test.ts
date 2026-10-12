// The runner's ceiling meter (DESIGN-workload-ceiling.md § 2 item 4, § 6) without spawning anything:
// the pure step over the 80 / 100 thresholds and the ceiling question's state, and the ledger side
// of a raise (slice, question and spend: in one write), of the question's state per ceiling value,
// of the withdrawal at a clean finish, and of a relaunch that keeps the cumulative total, on a temp ledger.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY } from "../../ledger/src/index";
import { type Ceiling, CEILING_OPTIONS, ceilingQuestionBody, parseSpend, scanSpend, type Spend, wallMinutes } from "../src/ceiling";
import { controlEntries, laneExitBody, laneStartedBody } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { ceilingKey, ceilingQuestionState, type CeilingQuestionState, type MeterState, meterStep, raiseCeilingQuestion, withdrawCeilingQuestions } from "../scripts/lane";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

const NORMAL: Ceiling = { usd: 50, wallMin: 360 };
const EXTENDED: Ceiling = { usd: 100, wallMin: 720 };
const spent = (usd: number, wallMin = 0): Spend => ({ usd, tokens: 1000, wallMin });
const fresh: MeterState = { raised: [] };
const step = (state: MeterState, ceiling: Ceiling, spend: Spend, question: CeilingQuestionState) => meterStep(state, { ceiling, spend, question });

describe("meterStep: the step matrix", () => {
	test("below 80 % of both halves: nothing", () => {
		expect(step(fresh, NORMAL, spent(39.99, 287), "none")).toEqual({ state: fresh, level: 0, raise: false, stop: false });
	});

	test("exactly 80 % raises once and the lane keeps working; a second poll at 85 % does not raise again, from the ledger's open question or from the runner's own memory", () => {
		const first = step(fresh, NORMAL, spent(40), "none");
		expect(first).toMatchObject({ level: 80, raise: true, stop: false });
		expect(first.state.raised).toEqual([ceilingKey(NORMAL)]);
		expect(step(first.state, NORMAL, spent(42.5), "open")).toMatchObject({ level: 80, raise: false, stop: false });
		// the raise this runner wrote is not in the rows it read (or they were read before the write): memory holds
		expect(step(first.state, NORMAL, spent(42.5), "none")).toMatchObject({ raise: false, stop: false });
		// a relaunched runner has no memory; the ledger's question is enough
		expect(step(fresh, NORMAL, spent(42.5), "open")).toMatchObject({ raise: false, stop: false });
	});

	test("the wall half alone crosses 80 % and 100 %", () => {
		expect(step(fresh, NORMAL, spent(1, 288), "none")).toMatchObject({ level: 80, raise: true, stop: false });
		expect(step(fresh, NORMAL, spent(1, 360), "open")).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("100 % with the question open stops, without a second question", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		expect(step(raised, NORMAL, spent(50), "open")).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("100 % answered stop or split stops, without a second question", () => {
		for (const q of ["stop", "split"] as const) expect(step(fresh, NORMAL, spent(51), q)).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("100 % with no question open or answered for the value raises with the stop, even when this run raised it at 80 % and Jo withdrew it", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		// Jo withdrew it at 85 %: this run does not ask again before 100 %
		expect(step(raised, NORMAL, spent(42.5), "none")).toMatchObject({ level: 80, raise: false, stop: false });
		const stopped = step(raised, NORMAL, spent(50), "none");
		expect(stopped).toMatchObject({ level: 100, raise: true, stop: true });
		expect(stopped.state.raised).toEqual([ceilingKey(NORMAL)]);
	});

	test("answered extend: the raised ceiling is the new value, so the lane at the old 100 % continues; an extend whose raise has not landed still stops at the old value", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		expect(step(raised, EXTENDED, spent(50, 100), "none")).toMatchObject({ level: 0, raise: false, stop: false });
		expect(step(raised, NORMAL, spent(50), "extend")).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("a jump from 50 % to 100 % between polls stops, and raises the question with the stop so Jo has the answers", () => {
		expect(step(fresh, NORMAL, spent(25), "none")).toMatchObject({ level: 0, raise: false, stop: false });
		const jumped = step(fresh, NORMAL, spent(50), "none");
		expect(jumped).toMatchObject({ level: 100, raise: true, stop: true });
		expect(jumped.state.raised).toEqual([ceilingKey(NORMAL)]);
	});

	test("a new ceiling after extend raises again at its own 80 %, once", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		expect(step(raised, EXTENDED, spent(79.99), "none")).toMatchObject({ raise: false, stop: false });
		const again = step(raised, EXTENDED, spent(80), "none");
		expect(again).toMatchObject({ level: 80, raise: true, stop: false });
		expect(again.state.raised).toEqual([ceilingKey(NORMAL), ceilingKey(EXTENDED)]);
		expect(step(again.state, EXTENDED, spent(90), "none")).toMatchObject({ raise: false, stop: false });
	});
});

describe("the ledger side of the meter", () => {
	test("a raise is one write stamped lane-runner: the ceiling slice (paused by its question), the question with stop / extend / split, the spend: entry", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const laneId = `lane-${wl.slice(3)}-1`;
		const spend: Spend = { usd: 40.5, tokens: 123456, wallMin: 12.34 };
		const { sliceId, questionId } = raiseCeilingQuestion(ledger, { workloadId: wl, laneId, spend, ceiling: NORMAL, stakes: "normal" });
		expect(sliceId).toBe(`sl-ceiling-${wl.slice(3)}-1`);
		const slice = ledger.slice(sliceId)!;
		expect(slice).toMatchObject({ workload_id: wl, task: "Jo decides the ceiling overrun", inputs: "ceiling", state: "paused", created_by: LANE_RUNNER_BY });
		const q = ledger.question(questionId)!;
		expect(q).toMatchObject({ slice_id: sliceId, state: "open", created_by: LANE_RUNNER_BY, body: ceilingQuestionBody(wl, spend, NORMAL, "normal") });
		expect(JSON.parse(q.options)).toEqual([...CEILING_OPTIONS]);
		const spends = controlEntries(ledger.entries(wl)).filter((e) => e.prefix === "spend");
		expect(spends).toHaveLength(1);
		expect(spends[0]).toMatchObject({ laneId, createdBy: LANE_RUNNER_BY });
		expect(parseSpend(spends[0]!.rest)).toEqual({ usd: 40.5, tokens: 123456, wallMin: 12.3 });
		expect(ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL)).toBe("open");
		// a second ceiling question on the workload gets the next id
		expect(raiseCeilingQuestion(ledger, { workloadId: wl, laneId, spend, ceiling: EXTENDED, stakes: "normal" }).sliceId).toBe(`sl-ceiling-${wl.slice(3)}-2`);
	});

	test("a raise whose spend: write fails leaves neither the slice nor the question", () => {
		const { ledger, path } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const db = new Database(path);
		db.exec("CREATE TRIGGER fail_spend BEFORE INSERT ON entries WHEN NEW.body LIKE 'spend:%' BEGIN SELECT RAISE(ABORT, 'injected spend failure'); END;");
		db.close();
		expect(() => raiseCeilingQuestion(ledger, { workloadId: wl, laneId: `lane-${wl.slice(3)}-1`, spend: spent(40), ceiling: NORMAL, stakes: "normal" })).toThrow(/injected spend failure/);
		expect(ledger.slices(wl).filter((s) => s.id.startsWith("sl-ceiling-"))).toEqual([]);
		expect(ledger.questions(wl)).toEqual([]);
	});

	test("the question's state is per ceiling value: another value reads none; Jo's answer reads as its option; a lane's own sl-ceiling- slice is not the runner's", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const lane = ledger.addSlice({ by: "lane-a", workloadId: wl, id: `sl-ceiling-plan-${wl.slice(3)}`, task: "plan the ceiling", doneCondition: `the ceiling ${ceilingKey(NORMAL)}`, inputs: "x" });
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: lane, body: "approve?", options: ["approve", "revise"] });
		const state = () => ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL);
		expect(state()).toBe("none");
		c.plusHours(1);
		const { questionId } = raiseCeilingQuestion(ledger, { workloadId: wl, laneId: "lane-x-1", spend: spent(40), ceiling: NORMAL, stakes: "normal" });
		expect(state()).toBe("open");
		expect(ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), EXTENDED)).toBe("none");
		c.plusHours(1);
		ledger.answerQuestion(questionId, { by: SURFACE_BY, answer: "extend", author: "jo", channel: "surface" });
		expect(state()).toBe("extend");
	});

	test("a clean finish withdraws the open ceiling question (then cancel: the slice is cancelled), and nothing else; the value then reads as never asked", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const own = ledger.addSlice({ by: "lane-a", workloadId: wl, id: `sl-ceiling-own-${wl.slice(3)}`, task: "t", doneCondition: "d", inputs: "i" });
		const ownQ = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: own, body: "b", options: ["a", "b"] });
		c.plusHours(1);
		const { sliceId, questionId } = raiseCeilingQuestion(ledger, { workloadId: wl, laneId: "lane-x-1", spend: spent(40), ceiling: NORMAL, stakes: "normal" });
		c.plusHours(1);
		expect(withdrawCeilingQuestions(ledger, wl)).toEqual([questionId]);
		expect(ledger.question(questionId)!.state).toBe("withdrawn");
		const withdrawal = ledger.instructions(wl).find((i) => i.id === ledger.question(questionId)!.resolved_by)!;
		expect(withdrawal).toMatchObject({ kind: "withdrawal", disposition: "cancel", author: LANE_RUNNER_BY, channel: "direct", created_by: LANE_RUNNER_BY, body: "finished under the ceiling" });
		expect(ledger.slice(sliceId)!.state).toBe("cancelled");
		expect(ledger.question(ownQ)!.state).toBe("open");
		expect(withdrawCeilingQuestions(ledger, wl)).toEqual([]);
		expect(ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL)).toBe("none");
	});
});

describe("a relaunch on the same ceiling (§ 2 items 3, 4)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});
	const assistant = (cost: number) => `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 1000, cost: { total: cost } } } })}\n`;
	const started = (laneId: string) => laneStartedBody(laneId, { pid: 1, start: "x", session: null, argv: [], runnerPid: 2 });

	test("keeps the cumulative total: a fresh runner's scan counts every run's session files, its wall counts the earlier run, and 85 % raises afresh after the clean finish withdrew the first question", () => {
		const c = clock("2026-10-01T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const record = (body: string) => ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body });
		const control = () => controlEntries(ledger.entries(wl));
		const dir = tmp("ceiling-relaunch");
		roots.push(dir);
		const laneFile = join(dir, "2026_lane.jsonl");

		// Run 1: an hour, $30 on the lane and $10 on a hand; 80 % raises, then the clean finish withdraws it.
		const lane1 = `lane-${wl.slice(3)}-1`;
		record(started(lane1));
		const start1 = Date.parse(c.now());
		writeFileSync(laneFile, assistant(30));
		mkdirSync(join(dir, "2026_lane"));
		writeFileSync(join(dir, "2026_lane", "0-Hand.jsonl"), assistant(10));
		c.at("2026-10-01T11:00:00.000Z");
		const run1: Spend = { ...scanSpend(dir, new Map(), { usd: 0, tokens: 0, wallMin: 0 }), wallMin: wallMinutes(control(), Date.parse(c.now()), start1) };
		expect(run1).toEqual({ usd: 40, tokens: 2000, wallMin: 60, labs: {} });
		const first = step(fresh, NORMAL, run1, ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL));
		expect(first).toMatchObject({ level: 80, raise: true, stop: false });
		raiseCeilingQuestion(ledger, { workloadId: wl, laneId: lane1, spend: run1, ceiling: NORMAL, stakes: "normal" });
		expect(withdrawCeilingQuestions(ledger, wl)).toHaveLength(1);
		record(laneExitBody(lane1, { code: 0, signal: null, outcome: "completed" }));

		// Parked on Jo for two hours, then run 2 resumes the lane session (--resume appends to the same file) with a fresh runner.
		c.at("2026-10-01T13:00:00.000Z");
		const lane2 = `lane-${wl.slice(3)}-2`;
		record(started(lane2));
		const start2 = Date.parse(c.now());
		writeFileSync(laneFile, assistant(2.5), { flag: "a" });
		c.at("2026-10-01T13:30:00.000Z");
		const run2: Spend = { ...scanSpend(dir, new Map(), { usd: 0, tokens: 0, wallMin: 0 }), wallMin: wallMinutes(control(), Date.parse(c.now()), start2) };
		expect(run2).toEqual({ usd: 42.5, tokens: 3000, wallMin: 90, labs: {} });
		const state = () => ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL);
		expect(state()).toBe("none");
		expect(step({ raised: [] }, NORMAL, run2, state())).toMatchObject({ level: 80, raise: true, stop: false });
		raiseCeilingQuestion(ledger, { workloadId: wl, laneId: lane2, spend: run2, ceiling: NORMAL, stakes: "normal" });
		expect(state()).toBe("open");
		expect(ledger.questions(wl).filter((q) => q.state === "open")).toHaveLength(1);
	});

	test("a relaunch that jumps straight past 100 % after a withdrawn question raises with the stop, so the stop leaves Jo an open question", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		raiseCeilingQuestion(ledger, { workloadId: wl, laneId: `lane-${wl.slice(3)}-1`, spend: spent(40), ceiling: NORMAL, stakes: "normal" });
		withdrawCeilingQuestions(ledger, wl);
		const state = ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL);
		expect(step(fresh, NORMAL, spent(55), state)).toMatchObject({ level: 100, raise: true, stop: true });
	});
});
