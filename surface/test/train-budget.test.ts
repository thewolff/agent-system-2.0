// The permanent merge train's daily budget (PLAN wl-mvr888nftz0vcl D4, D5, D7, D13; surface/src/train-budget.ts): PDT days
// across both DST changes, the strict incremental scan and every defect it refuses, the day's limit and its raises, the
// gate's three episodes and what clears each, the pause question, and the PR a stopping lane was on. Every instant is a
// fixed argument or the test ledger's settable clock: nothing here reads the machine's time.
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, type Ledger } from "../../ledger/src/index";
import { applyTrain, interpret } from "../src/input";
import { controlEntries, launchRequestedBody } from "../src/launch";
import { trainFullSliceId, trainSliceId } from "../src/merge-train";
import {
	activeTrainPr, askTrainPause, emptyTrainScan, nextPdtMidnight, pdtDay, prevPdtDay, scanTrainDays, TRAIN_DAILY_USD, TRAIN_METER_NAMED, TRAIN_RUN_MAX_TIME_MIN, TRAIN_TZ,
	trainBudgetGate, trainBudgetRows, trainBudgetSliceId, trainDayLimit, trainMaxTime, trainMeterErrorBody, trainPausedBody, trainPauses, trainRaiseBody,
} from "../src/train-budget";
import { MERGE_TRAIN_BY, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const H = 3_600_000;
const ms = (iso: string): number => Date.parse(iso);

describe("PDT days (D4)", () => {
	test("the rule's constants", () => {
		expect([TRAIN_DAILY_USD, TRAIN_TZ, TRAIN_RUN_MAX_TIME_MIN]).toEqual([150, "America/Los_Angeles", 1440]);
	});

	test("pdtDay is the Los Angeles calendar day, in PDT and in PST", () => {
		expect(pdtDay(ms("2026-10-31T06:59:59.999Z"))).toBe("2026-10-30");
		expect(pdtDay(ms("2026-10-31T07:00:00.000Z"))).toBe("2026-10-31");
		expect(pdtDay(ms("2026-11-03T07:59:59.999Z"))).toBe("2026-11-02");
		expect(pdtDay(ms("2026-11-03T08:00:00.000Z"))).toBe("2026-11-03");
		expect(() => pdtDay(Number.NaN)).toThrow(/not a finite time/);
	});

	test("2026-11-01 is 25 hours: midnight is 07:00Z, the next midnight 08:00Z the day after", () => {
		const start = ms("2026-11-01T07:00:00.000Z");
		expect(nextPdtMidnight(ms("2026-10-31T23:00:00.000Z"))).toBe(start);
		for (const at of ["2026-11-01T07:00:00.000Z", "2026-11-01T09:30:00.000Z", "2026-11-01T10:30:00.000Z", "2026-11-02T07:59:59.999Z"]) {
			expect(nextPdtMidnight(ms(at))).toBe(ms("2026-11-02T08:00:00.000Z"));
		}
		expect(nextPdtMidnight(start) - start).toBe(25 * H);
		expect(pdtDay(ms("2026-11-02T07:30:00.000Z"))).toBe("2026-11-01");
	});

	test("2027-03-14 is 23 hours: midnight is 08:00Z, the next midnight 07:00Z the day after", () => {
		const start = ms("2027-03-14T08:00:00.000Z");
		expect(nextPdtMidnight(ms("2027-03-14T07:59:59.999Z"))).toBe(start);
		for (const at of ["2027-03-14T08:00:00.000Z", "2027-03-14T09:59:00.000Z", "2027-03-14T10:00:00.000Z", "2027-03-15T06:59:59.999Z"]) {
			expect(nextPdtMidnight(ms(at))).toBe(ms("2027-03-15T07:00:00.000Z"));
		}
		expect(nextPdtMidnight(start) - start).toBe(23 * H);
	});

	test("an ordinary day is 24 hours, and a month and year end roll over", () => {
		expect(nextPdtMidnight(ms("2026-10-27T15:00:00.000Z")) - ms("2026-10-27T07:00:00.000Z")).toBe(24 * H);
		expect(nextPdtMidnight(ms("2026-12-31T20:00:00.000Z"))).toBe(ms("2027-01-01T08:00:00.000Z"));
		expect(prevPdtDay("2027-03-01")).toBe("2027-02-28");
		expect(prevPdtDay("2027-01-01")).toBe("2026-12-31");
		expect(() => prevPdtDay("2027-1-1")).toThrow(/not a YYYY-MM-DD day/);
	});

	test("the run's --max-time is the 1440m backstop; only a shorter AGENT_SYSTEM_LANE_MAX_TIME wins", () => {
		expect(trainMaxTime({})).toBe("1440m");
		expect(trainMaxTime({ AGENT_SYSTEM_LANE_MAX_TIME: "30m" })).toBe("30m");
		expect(trainMaxTime({ AGENT_SYSTEM_LANE_MAX_TIME: "48h" })).toBe("1440m");
		expect(trainMaxTime({ AGENT_SYSTEM_LANE_MAX_TIME: "   " })).toBe("1440m");
		expect(trainMaxTime({ AGENT_SYSTEM_LANE_MAX_TIME: "soon" })).toBe("1440m");
	});
});

// ---- the strict scan ------------------------------------------------------------------------------

/** One assistant line in the shape OMP writes (a real session's: top-level `timestamp`, `message.usage.cost.total`). */
const assistant = (timestamp: string, total: number): string =>
	JSON.stringify({ type: "message", id: "m", parentId: null, timestamp, message: { role: "assistant", content: [], usage: { input: 1, output: 1, cost: { input: 0, output: 0, total } } } });
const user = (timestamp: string): string => JSON.stringify({ type: "message", timestamp, message: { role: "user", content: [] } });

describe("scanTrainDays: the strict incremental reader (D4, R4, R5)", () => {
	test("each line lands on its own timestamp's PDT day, hands' nested files included, other files and lines ignored", () => {
		const dir = tmp("train-scan");
		mkdirSync(join(dir, "sess-1"), { recursive: true });
		writeFileSync(join(dir, "lane.jsonl"), [
			JSON.stringify({ type: "session", id: "s" }),
			assistant("2026-11-02T06:59:00.000Z", 10),
			user("2026-11-02T07:00:00.000Z"),
			assistant("2026-11-02T08:00:00.000Z", 2.5),
		].join("\n") + "\n");
		writeFileSync(join(dir, "sess-1", "hand.jsonl"), `${assistant("2026-11-02T09:00:00.000Z", 1.25)}\n`);
		writeFileSync(join(dir, "notes.txt"), "not a session\n");
		const r = scanTrainDays(dir, emptyTrainScan());
		expect(r.errors).toEqual([]);
		expect([...r.scan.days].sort()).toEqual([["2026-11-01", 10], ["2026-11-02", 3.75]]);
	});

	test("incremental: a rescan counts only new complete lines; a trailing partial line waits for its newline", () => {
		const dir = tmp("train-scan");
		const f = join(dir, "lane.jsonl");
		const line = assistant("2026-11-02T18:00:00.000Z", 4);
		writeFileSync(f, `${assistant("2026-11-02T17:00:00.000Z", 1)}\n${line.slice(0, 20)}`);
		const first = scanTrainDays(dir, emptyTrainScan());
		expect(first.errors).toEqual([]);
		expect(first.scan.days.get("2026-11-02")).toBe(1);
		const again = scanTrainDays(dir, first.scan);
		expect(again.scan.days.get("2026-11-02")).toBe(1);
		appendFileSync(f, `${line.slice(20)}\n`);
		const done = scanTrainDays(dir, again.scan);
		expect(done.errors).toEqual([]);
		expect(done.scan.days.get("2026-11-02")).toBe(5);
		expect(done.scan.files.get(f)).toEqual({ offset: Buffer.byteLength(`${assistant("2026-11-02T17:00:00.000Z", 1)}\n${line}\n`), lines: 2 });
		// The input scan is never changed: a restarted runner's empty scan reads everything again.
		expect(first.scan.days.get("2026-11-02")).toBe(1);
		expect(scanTrainDays(dir, emptyTrainScan()).scan.days.get("2026-11-02")).toBe(5);
	});

	test("a missing directory is no spend and no error", () => {
		const r = scanTrainDays(join(tmp("train-scan"), "never"), emptyTrainScan());
		expect(r.errors).toEqual([]);
		expect(r.scan.days.size).toBe(0);
	});

	test("every defect is an error naming the file and line, the scan goes on past it, and no defect counts as zero", () => {
		const dir = tmp("train-scan");
		const f = join(dir, "lane.jsonl");
		writeFileSync(f, [
			assistant("2026-11-02T17:00:00.000Z", 3),
			"{not json",
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }),
			JSON.stringify({ type: "message", timestamp: "yesterday-ish", message: { role: "assistant", usage: { cost: { total: 1 } } } }),
			JSON.stringify({ type: "message", timestamp: "2026-11-02T17:01:00.000Z", message: { role: "assistant", usage: { input: 3 } } }),
			JSON.stringify({ type: "message", timestamp: "2026-11-02T17:02:00.000Z", message: { role: "assistant", usage: { cost: { total: -1 } } } }),
			JSON.stringify({ type: "message", timestamp: "2026-11-02T17:03:00.000Z", message: { role: "assistant", usage: { cost: { total: "2" } } } }),
			assistant("2026-11-02T17:04:00.000Z", 4),
		].join("\n") + "\n");
		const r = scanTrainDays(dir, emptyTrainScan());
		expect(r.errors.map((e) => [e.file, e.line, e.reason])).toEqual([
			[f, 2, "the line is not JSON"],
			[f, 3, "an assistant line with no parseable top-level timestamp"],
			[f, 4, "an assistant line with no parseable top-level timestamp"],
			[f, 5, "an assistant line with no finite non-negative message.usage.cost.total"],
			[f, 6, "an assistant line with no finite non-negative message.usage.cost.total"],
			[f, 7, "an assistant line with no finite non-negative message.usage.cost.total"],
		]);
		expect(r.scan.days.get("2026-11-02")).toBe(7);
		expect(trainMeterErrorBody("lane-x", r.errors, { path: "/l/meter-errors/lane-x-t.json" })).toBe(
			`train-meter-error: lane-x ${r.errors.map((e) => `${e.file}:${e.line} ${e.reason}`).join("; ")}; evidence /l/meter-errors/lane-x-t.json`,
		);
	});

	test("train-meter-error: with its evidence file names the first TRAIN_METER_NAMED defects and counts the rest; with none, names nothing more", () => {
		const defects = Array.from({ length: TRAIN_METER_NAMED + 2 }, (_, i) => ({ file: "/s/x.jsonl", line: i + 1, reason: "the line is not JSON" }));
		const named = defects.slice(0, TRAIN_METER_NAMED).map((d) => `/s/x.jsonl:${d.line} the line is not JSON`).join("; ");
		expect(trainMeterErrorBody("lane-x", defects, { path: "/e.json" })).toBe(`train-meter-error: lane-x ${named}; and 2 more; evidence /e.json`);
		expect(trainMeterErrorBody("lane-x", defects.slice(0, TRAIN_METER_NAMED), { path: "/e.json" })).toBe(`train-meter-error: lane-x ${named}; evidence /e.json`);
		expect(trainMeterErrorBody("lane-x", defects.slice(0, 1), null)).toBe("train-meter-error: lane-x /s/x.jsonl:1 the line is not JSON");
		expect(() => trainMeterErrorBody("lane-x", [], null)).toThrow(/no defect given for lane-x/);
	});

	test("review r2 B1: when the evidence file could not be written, train-meter-error: names every one of more than TRAIN_METER_NAMED distinct defects beside the write failure", () => {
		const defects = Array.from({ length: TRAIN_METER_NAMED + 3 }, (_, i) => ({ file: `/s/file-${i}.jsonl`, line: 100 + i, reason: `defect number ${i} of its own kind` }));
		const body = trainMeterErrorBody("lane-x", defects, { failed: "ENOSPC: disk\nfull" });
		expect(body).toBe(`train-meter-error: lane-x ${defects.map((d) => `${d.file}:${d.line} ${d.reason}`).join("; ")}; evidence write failed: ENOSPC: disk full`);
		for (const d of defects) expect(body).toContain(`${d.file}:${d.line} ${d.reason}`);
		expect(body).not.toContain(" more;");
	});

	test("a file that shrank below what was counted is an error, not a rescan", () => {
		const dir = tmp("train-scan");
		const f = join(dir, "lane.jsonl");
		writeFileSync(f, `${assistant("2026-11-02T17:00:00.000Z", 3)}\n`);
		const first = scanTrainDays(dir, emptyTrainScan());
		truncateSync(f, 5);
		const r = scanTrainDays(dir, first.scan);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.file).toBe(f);
		expect(r.errors[0]!.reason).toMatch(/could not be read \(the file shrank to 5 bytes/);
		expect(r.scan.days.get("2026-11-02")).toBe(3);
	});

	test("an unreadable directory is an error, never an empty spend", () => {
		const dir = tmp("train-scan");
		const sub = join(dir, "sess-locked");
		mkdirSync(sub);
		writeFileSync(join(sub, "hand.jsonl"), `${assistant("2026-11-02T17:00:00.000Z", 3)}\n`);
		chmodSync(sub, 0o000);
		try {
			const r = scanTrainDays(dir, emptyTrainScan());
			expect(r.errors.map((e) => [e.file, e.line])).toEqual([[sub, 0]]);
			expect(r.errors[0]!.reason).toMatch(/the directory could not be read \(EACCES/);
		} finally {
			chmodSync(sub, 0o755);
		}
	});
});

// ---- the ledger rows: a real train ----------------------------------------------------------------

const LANE = "lane-train-budget-1";
const JO = { by: SURFACE_BY, author: "jo", channel: "surface" as const };

/** A merge train opened by Jo's word on a temp ledger whose clock the test sets. */
function train() {
	const c = clock("2026-11-02T16:00:00.000Z");
	const { ledger } = tempLedger(c.now);
	const cmd = interpret(ledger, "train 101 106");
	if (cmd?.kind !== "train") throw new Error(`not a train: ${JSON.stringify(cmd)}`);
	const wl = applyTrain(ledger, cmd, tmp("train-repo")).workloadId;
	return { ledger, c, wl };
}

/** The runner's `train-paused:` for `day` at the clock's now; its entry id. */
function pause(ledger: Ledger, wl: string, day: string, until: string, usd = 150.4, limit = 150): string {
	return ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: trainPausedBody({ laneId: LANE, day, usd, limit, pr: 106, until }) });
}
/** The surface's `train-raise:` for `day` (with the answer it records). */
const raise = (ledger: Ledger, wl: string, day: string, usd: number, answerId = "in-x"): string =>
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: trainRaiseBody(day, usd, answerId) });
const joLaunch = (ledger: Ledger, wl: string): string => ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now()) });
const gate = (ledger: Ledger, wl: string) =>
	trainBudgetGate(trainBudgetRows({ workload: { id: wl }, entries: ledger.entries(wl), questions: ledger.questions(wl), instructions: ledger.instructions(wl) }), ledger.now());
const limitOn = (ledger: Ledger, wl: string, day: string) => trainDayLimit(controlEntries(ledger.entries(wl)), day);

// 2026-11-02 PST: the day runs 08:00Z to 2026-11-03T08:00Z.
const UNTIL_2 = "2026-11-03T08:00:00.000Z";
const UNTIL_3 = "2026-11-04T08:00:00.000Z";

describe("trainDayLimit (D4, R3)", () => {
	test("$150 a day; a raise covers only its own PDT day, the next day's limit is $150", () => {
		const { ledger, wl } = train();
		expect(limitOn(ledger, wl, "2026-11-02")).toBe(150);
		raise(ledger, wl, "2026-11-02", 50);
		raise(ledger, wl, "2026-11-02", 25.5);
		expect(limitOn(ledger, wl, "2026-11-02")).toBe(225.5);
		expect(limitOn(ledger, wl, "2026-11-03")).toBe(150);
		expect(limitOn(ledger, wl, "2026-11-01")).toBe(150);
	});

	test("only the surface's train-raise: counts: a lane or the tick writing one raises nothing", () => {
		const { ledger, wl } = train();
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: trainRaiseBody("2026-11-02", 500, "in-forged") });
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainRaiseBody("2026-11-02", 500, "in-forged") });
		expect(limitOn(ledger, wl, "2026-11-02")).toBe(150);
	});
});

describe("trainBudgetGate (D5, R6, R8)", () => {
	test("no pause: nothing refused", () => {
		const { ledger, wl } = train();
		expect(gate(ledger, wl)).toBeNull();
	});

	test("budget-paused until midnight, then a single-day pause resumes on its own", () => {
		const { ledger, c, wl } = train();
		const p = pause(ledger, wl, "2026-11-02", UNTIL_2);
		expect(gate(ledger, wl)).toMatchObject({ reason: "budget-paused", entryId: p });
		c.at("2026-11-03T07:59:59.999Z");
		expect(gate(ledger, wl)?.reason).toBe("budget-paused");
		c.at(UNTIL_2);
		expect(gate(ledger, wl)).toBeNull();
	});

	test("a Jo launch request written while paused is refused: only midnight or a raise lifts the pause", () => {
		const { ledger, c, wl } = train();
		pause(ledger, wl, "2026-11-02", UNTIL_2);
		c.plusHours(1);
		joLaunch(ledger, wl);
		expect(gate(ledger, wl)?.reason).toBe("budget-paused");
	});

	test("a same-day raise written after the pause lifts budget-paused", () => {
		const { ledger, c, wl } = train();
		pause(ledger, wl, "2026-11-02", UNTIL_2);
		c.plusHours(1);
		raise(ledger, wl, "2026-11-02", 50);
		expect(gate(ledger, wl)).toBeNull();
	});

	test("a raise for another day, or one written before the pause, does not lift it; a forged pause pauses nothing", () => {
		const { ledger, c, wl } = train();
		raise(ledger, wl, "2026-11-02", 50);
		c.plusHours(1);
		pause(ledger, wl, "2026-11-02", UNTIL_2, 200.1, 200);
		raise(ledger, wl, "2026-11-01", 50);
		expect(gate(ledger, wl)?.reason).toBe("budget-paused");
		const other = train();
		other.ledger.recordEntry({ by: LANE, workloadId: other.wl, kind: "assumption", body: trainPausedBody({ laneId: LANE, day: "2026-11-02", usd: 151, limit: 150, pr: 101, until: UNTIL_2 }) });
		expect(gate(other.ledger, other.wl)).toBeNull();
	});

	test("two PDT days in a row: budget-decision past midnight until Jo answers; a second-day raise clears it", () => {
		const { ledger, c, wl } = train();
		pause(ledger, wl, "2026-11-01", "2026-11-02T08:00:00.000Z");
		c.at("2026-11-03T05:00:00.000Z");
		const p2 = pause(ledger, wl, "2026-11-02", UNTIL_2);
		const q = askTrainPause(ledger, wl, p2);
		expect(gate(ledger, wl)?.reason).toBe("budget-paused");
		c.at("2026-11-03T09:00:00.000Z");
		expect(gate(ledger, wl)).toMatchObject({ reason: "budget-decision", entryId: p2 });
		// Jo's `raise 50` answer: the surface writes the answer and the second day's raise in one transaction.
		const answerId = ledger.answerQuestion(q, { ...JO, answer: "raise 50" });
		raise(ledger, wl, "2026-11-02", 50, answerId);
		expect(gate(ledger, wl)).toBeNull();
	});

	test("budget-decision is cleared by `wait`, or by a Jo launch request written at or after until, never one before it", () => {
		const { ledger, c, wl } = train();
		pause(ledger, wl, "2026-11-01", "2026-11-02T08:00:00.000Z");
		c.at("2026-11-03T05:00:00.000Z");
		const p2 = pause(ledger, wl, "2026-11-02", UNTIL_2);
		const q = askTrainPause(ledger, wl, p2);
		c.plusHours(1);
		joLaunch(ledger, wl);
		c.at("2026-11-03T12:00:00.000Z");
		expect(gate(ledger, wl)?.reason).toBe("budget-decision");
		joLaunch(ledger, wl);
		expect(gate(ledger, wl)).toBeNull();

		const second = train();
		pause(second.ledger, second.wl, "2026-11-01", "2026-11-02T08:00:00.000Z");
		second.c.at("2026-11-03T05:00:00.000Z");
		const q2 = askTrainPause(second.ledger, second.wl, pause(second.ledger, second.wl, "2026-11-02", UNTIL_2));
		second.c.at("2026-11-03T12:00:00.000Z");
		expect(gate(second.ledger, second.wl)?.reason).toBe("budget-decision");
		// The tick's launch request is not Jo's word.
		second.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: second.wl, kind: "assumption", body: launchRequestedBody("merge-train", second.ledger.now()) });
		expect(gate(second.ledger, second.wl)?.reason).toBe("budget-decision");
		second.ledger.answerQuestion(q2, { ...JO, answer: "wait" });
		expect(gate(second.ledger, second.wl)).toBeNull();
		expect(q).not.toBe(q2);
	});

	test("pauses on non-adjacent days are each a single-day pause", () => {
		const { ledger, c, wl } = train();
		pause(ledger, wl, "2026-10-31", "2026-11-01T07:00:00.000Z");
		pause(ledger, wl, "2026-11-02", UNTIL_2);
		c.at("2026-11-03T09:00:00.000Z");
		expect(gate(ledger, wl)).toBeNull();
	});

	test("meter-error refuses until Jo's relaunch answer or his launch word after it; hold keeps it", () => {
		const { ledger, c, wl } = train();
		const defects = [{ file: "/s/lane.jsonl", line: 4, reason: "the line is not JSON" }, { file: "/s/lane.jsonl", line: 9, reason: "an assistant line with no parseable top-level timestamp" }];
		const e = ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: trainMeterErrorBody(LANE, defects, { path: "/l/meter-errors/e.json" }) });
		expect(gate(ledger, wl)?.detail).toContain("/s/lane.jsonl:4 the line is not JSON; /s/lane.jsonl:9 an assistant line with no parseable top-level timestamp; evidence /l/meter-errors/e.json");
		expect(gate(ledger, wl)).toMatchObject({ reason: "meter-error", entryId: e });
		// Jo's answer to the meter error's question (D9's raise is another slice's; this one is asked here as the tick would).
		const sl = trainBudgetSliceId(wl, e);
		ledger.addSlice({ by: MERGE_TRAIN_BY, workloadId: wl, id: sl, task: "meter error", doneCondition: "Jo answered", inputs: e });
		const q = ledger.raiseQuestion({ by: MERGE_TRAIN_BY, workloadId: wl, sliceId: sl, body: "the meter failed", options: ["relaunch", "hold"] });
		c.at("2026-11-04T12:00:00.000Z");
		expect(gate(ledger, wl)?.reason).toBe("meter-error");
		ledger.answerQuestion(q, { ...JO, answer: "relaunch" });
		expect(gate(ledger, wl)).toBeNull();

		const other = train();
		other.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: other.wl, kind: "assumption", body: trainMeterErrorBody(LANE, [{ file: "/s", line: 0, reason: "EACCES" }], { failed: "ENOTDIR" }) });
		other.c.plusHours(1);
		joLaunch(other.ledger, other.wl);
		expect(gate(other.ledger, other.wl)).toBeNull();
	});

	test("a lane-written meter error is not the runner's and refuses nothing", () => {
		const { ledger, wl } = train();
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: trainMeterErrorBody(LANE, [{ file: "/s", line: 1, reason: "forged" }], null) });
		expect(gate(ledger, wl)).toBeNull();
	});

	test("a now that is not a time throws: the gate never guesses", () => {
		expect(() => trainBudgetGate({ workloadId: "wl-x", control: [], questions: [], instructions: [] }, "later")).toThrow(/not a time/);
	});
});

describe("the pause question (D7, R27)", () => {
	test("one raise/wait question per pause on its budget slice, ensure-or-reuse; the first line has dollars, PR and resume time", () => {
		const { ledger, wl } = train();
		const p = pause(ledger, wl, "2026-11-02", UNTIL_2, 150.42);
		const q = askTrainPause(ledger, wl, p);
		expect(askTrainPause(ledger, wl, p)).toBe(q);
		const rows = ledger.questions(wl).filter((x) => x.slice_id === trainBudgetSliceId(wl, p));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.created_by).toBe(MERGE_TRAIN_BY);
		expect(JSON.parse(rows[0]!.options)).toEqual(["raise", "wait"]);
		const lines = rows[0]!.body.split("\n");
		expect(lines[0]).toBe(`merge train ${wl} spent $150.42 of its $150 for 2026-11-02 (PDT) while on PR #106; paused until midnight PDT (${UNTIL_2})`);
		expect(lines[1]).toMatch(/^Answer `raise <usd>`/);
		expect(lines[2]).toMatch(/resumes at midnight PDT on its own, at \$150/);
		expect(trainBudgetSliceId(wl, p)).toBe(`sl-train-${wl.slice(3)}-budget-${p.slice(3)}`);
		// Never a PR slice id: the budget slice names no PR.
		expect(ledger.slice(trainBudgetSliceId(wl, p))?.workload_id).toBe(wl);
	});

	test("a second pause gets its own question; the second of two days says what wait and no answer do", () => {
		const { ledger, c, wl } = train();
		const p1 = pause(ledger, wl, "2026-11-01", "2026-11-02T08:00:00.000Z");
		c.plusHours(20);
		const p2 = ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: trainPausedBody({ laneId: LANE, day: "2026-11-02", usd: 151, limit: 150, pr: null, until: UNTIL_2 }) });
		const q1 = askTrainPause(ledger, wl, p1);
		const q2 = askTrainPause(ledger, wl, p2);
		expect(q1).not.toBe(q2);
		const body = ledger.questions(wl).find((x) => x.id === q2)!.body;
		expect(body.split("\n")[0]).toContain("while on no PR;");
		expect(body).toContain("second full PDT day in a row");
		expect(body).toContain("no answer keeps it paused past midnight until you answer");
	});

	test("asking for an entry that is no runner pause throws and asks nothing", () => {
		const { ledger, wl } = train();
		const forged = ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: trainPausedBody({ laneId: LANE, day: "2026-11-02", usd: 151, limit: 150, pr: 101, until: UNTIL_2 }) });
		expect(() => askTrainPause(ledger, wl, forged)).toThrow(/no runner-written train-paused/);
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(trainPauses(controlEntries(ledger.entries(wl)))).toEqual([]);
	});
});

describe("activeTrainPr (D13)", () => {
	const rowsOf = (ledger: Ledger, wl: string) => ({ workloadId: wl, entries: ledger.entries(wl), slices: ledger.slices(wl) });

	test("the lane's newest train-pr: marker first", () => {
		const { ledger, c, wl } = train();
		ledger.addSlice({ by: LANE, workloadId: wl, id: trainSliceId(wl, 101), task: "PR 101", doneCondition: "merged", inputs: "PR" });
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: "train-pr: 106 start" });
		c.plusHours(1);
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", sliceId: trainSliceId(wl, 101), body: "note on 101" });
		expect(activeTrainPr(rowsOf(ledger, wl), LANE)).toBe(106);
		ledger.recordEntry({ by: "lane-other", workloadId: wl, kind: "assumption", body: "train-pr: 101 start" });
		expect(activeTrainPr(rowsOf(ledger, wl), LANE)).toBe(106);
	});

	test("no marker: the PR whose slice holds the lane's newest row, full-suite slices included", () => {
		const { ledger, c, wl } = train();
		ledger.addSlice({ by: LANE, workloadId: wl, id: trainSliceId(wl, 101), task: "PR 101", doneCondition: "merged", inputs: "PR" });
		c.plusHours(1);
		ledger.addSlice({ by: "lane-test-runner", workloadId: wl, id: trainFullSliceId(wl, 106, 1), task: "full", doneCondition: "green", inputs: "PR" });
		expect(activeTrainPr(rowsOf(ledger, wl), LANE)).toBe(101);
		c.plusHours(1);
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", sliceId: trainFullSliceId(wl, 106, 1), body: "waiting on the run" });
		expect(activeTrainPr(rowsOf(ledger, wl), LANE)).toBe(106);
	});

	test("a lane that touched no PR has none", () => {
		const { ledger, wl } = train();
		ledger.addSlice({ by: "lane-other", workloadId: wl, id: trainSliceId(wl, 101), task: "PR 101", doneCondition: "merged", inputs: "PR" });
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: "looking around" });
		expect(activeTrainPr(rowsOf(ledger, wl), LANE)).toBeNull();
	});
});
