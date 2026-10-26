// The runner's ceiling meter (DESIGN-workload-ceiling.md § 2 item 4; PLAN wl-mvfkv7llkp7nk0 § 4, R11 and R12) without
// spawning anything: the pure step over the 80 / 100 thresholds and the notices already sent, and the ledger side of a
// notice (the held notice and its spend: in one write), of the notices per ceiling value, and of a relaunch that keeps
// the cumulative total, on a temp ledger. No level asks Jo anything and nothing extends the ceiling.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, type Stakes } from "../../ledger/src/index";
import { type Ceiling, ceilingKey, effectiveCeiling, parseCeilingNotice, parseSpend, scanSpend, type Spend, wallMinutes } from "../src/ceiling";
import { controlEntries, laneExitBody, laneStartedBody } from "../src/launch";
import { apply, interpret } from "../src/input";
import { sendNotice } from "../src/notice";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { ceilingNoticesSent, type MeterState, meterPoll, meterStep, sendCeilingNotice } from "../scripts/lane";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

const NORMAL: Ceiling = { usd: 50, wallMin: 360 };
const EXTENDED: Ceiling = { usd: 100, wallMin: 720 };
const spent = (usd: number, wallMin = 0): Spend => ({ usd, tokens: 1000, wallMin });
const fresh: MeterState = { sent: [] };
const step = (state: MeterState, ceiling: Ceiling, spend: Spend, sent: readonly (80 | 100)[] = []) => meterStep(state, { ceiling, spend, sent });

describe("meterStep: the step matrix", () => {
	test("below 80 % of both halves: nothing", () => {
		expect(step(fresh, NORMAL, spent(39.99, 287))).toEqual({ state: fresh, level: 0, notice: null, stop: false });
	});

	test("R11 exactly 80 % sends the 80 % notice once and the lane keeps working; a second poll at 85 % sends nothing, from the ledger's notice or from the runner's own memory", () => {
		const first = step(fresh, NORMAL, spent(40));
		expect(first).toMatchObject({ level: 80, notice: 80, stop: false });
		expect(first.state.sent).toEqual([`80 ${ceilingKey(NORMAL)}`]);
		expect(step(first.state, NORMAL, spent(42.5), [80])).toMatchObject({ level: 80, notice: null, stop: false });
		// the notice this runner wrote is not in the rows it read (or they were read before the write): memory holds
		expect(step(first.state, NORMAL, spent(42.5))).toMatchObject({ notice: null, stop: false });
		// a relaunched runner has no memory; the ledger's notice is enough
		expect(step(fresh, NORMAL, spent(42.5), [80])).toMatchObject({ notice: null, stop: false });
	});

	test("the wall half alone crosses 80 % and 100 %", () => {
		expect(step(fresh, NORMAL, spent(1, 288))).toMatchObject({ level: 80, notice: 80, stop: false });
		expect(step(fresh, NORMAL, spent(1, 360), [80])).toMatchObject({ level: 100, notice: 100, stop: true });
	});

	test("R12 100 % stops and sends the stop notice once per ceiling value; every later poll at 100 % stops with no second notice", () => {
		const warned = step(fresh, NORMAL, spent(40)).state;
		const stopped = step(warned, NORMAL, spent(50), [80]);
		expect(stopped).toMatchObject({ level: 100, notice: 100, stop: true });
		expect(stopped.state.sent).toEqual([`80 ${ceilingKey(NORMAL)}`, `100 ${ceilingKey(NORMAL)}`]);
		expect(step(stopped.state, NORMAL, spent(51), [80])).toMatchObject({ level: 100, notice: null, stop: true });
		expect(step(fresh, NORMAL, spent(51), [80, 100])).toMatchObject({ level: 100, notice: null, stop: true });
	});

	test("R12 a jump from 50 % to 100 % between polls stops and sends only the stop notice", () => {
		expect(step(fresh, NORMAL, spent(25))).toMatchObject({ level: 0, notice: null, stop: false });
		const jumped = step(fresh, NORMAL, spent(50));
		expect(jumped).toMatchObject({ level: 100, notice: 100, stop: true });
		expect(jumped.state.sent).toEqual([`100 ${ceilingKey(NORMAL)}`]);
	});

	test("a raised ceiling is a new value: the lane at the old 100 % goes on, and the new value notifies again at its own 80 % and 100 %, once each", () => {
		const stopped = step(step(fresh, NORMAL, spent(40)).state, NORMAL, spent(50)).state;
		expect(step(stopped, EXTENDED, spent(50, 100))).toMatchObject({ level: 0, notice: null, stop: false });
		const again = step(stopped, EXTENDED, spent(80));
		expect(again).toMatchObject({ level: 80, notice: 80, stop: false });
		expect(step(again.state, EXTENDED, spent(90))).toMatchObject({ notice: null, stop: false });
		expect(step(again.state, EXTENDED, spent(100))).toMatchObject({ level: 100, notice: 100, stop: true });
	});
});

describe("the ledger side of the meter", () => {
	const notices = (ledger: Ledger, wl: string) =>
		ledger.db.query<{ id: string; body: string; state: string; created_by: string; sender: string; recipient: string }, [string]>(
			"SELECT * FROM messages WHERE workload_id = ? ORDER BY created_at, id",
		).all(wl);

	test("R11: the 80 % notice is one write stamped lane-runner, a held notice to the orchestrator naming `extend <wl>` and `ceiling <usd> [<hours>] <wl>`, and the spend: entry; no question, no slice", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const slices = ledger.slices(wl).length;
		const laneId = `lane-${wl.slice(3)}-1`;
		const spend: Spend = { usd: 40.5, tokens: 123456, wallMin: 12.34 };
		const id = sendCeilingNotice(ledger, { workloadId: wl, laneId, level: 80, spend, ceiling: NORMAL, stakes: "normal" });
		const m = ledger.message(id)!;
		expect(m).toMatchObject({ created_by: LANE_RUNNER_BY, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, state: "held" });
		expect(parseCeilingNotice(m.body)).toEqual({ level: 80, key: ceilingKey(NORMAL), workloadId: wl });
		expect(m.body).toContain(`\`extend ${wl}\``);
		expect(m.body).toContain(`\`ceiling <usd> [<hours>] ${wl}\``);
		expect(m.body).not.toContain("user-driven");
		const spends = controlEntries(ledger.entries(wl)).filter((e) => e.prefix === "spend");
		expect(spends).toHaveLength(1);
		expect(spends[0]).toMatchObject({ laneId, createdBy: LANE_RUNNER_BY });
		expect(parseSpend(spends[0]!.rest)).toEqual({ usd: 40.5, tokens: 123456, wallMin: 12.3 });
		expect(ledger.questions(wl)).toEqual([]);
		expect(ledger.slices(wl)).toHaveLength(slices);
		expect(ceilingNoticesSent(ledger, wl, NORMAL)).toEqual([80]);
	});

	test("R12: at every stakes, the stop notice names `extend`, `ceiling` and `user-driven <wl>`, asks nothing and leaves the ceiling where it was", () => {
		for (const stakes of ["throwaway", "normal", "production"] as const satisfies readonly Stakes[]) {
			const c = clock();
			const { ledger } = tempLedger(c.now);
			const { wl } = workloadWithSlice(ledger, { stakes });
			const before = effectiveCeiling(controlEntries(ledger.entries(wl)), ledger.instructions(wl), stakes);
			const id = sendCeilingNotice(ledger, { workloadId: wl, laneId: `lane-${wl.slice(3)}-1`, level: 100, spend: spent(before.usd), ceiling: before, stakes });
			const body = ledger.message(id)!.body;
			expect(parseCeilingNotice(body)).toEqual({ level: 100, key: ceilingKey(before), workloadId: wl });
			for (const word of [`\`extend ${wl}\``, `\`ceiling <usd> [<hours>] ${wl}\``, `\`user-driven ${wl}\``]) expect(body).toContain(word);
			expect(ledger.questions(wl)).toEqual([]);
			expect(controlEntries(ledger.entries(wl)).filter((e) => e.prefix === "ceiling" && e.createdBy === LANE_RUNNER_BY)).toEqual([]);
			expect(effectiveCeiling(controlEntries(ledger.entries(wl)), ledger.instructions(wl), stakes)).toEqual(before);
		}
	});

	test("a notice whose spend: write fails leaves no notice", () => {
		const { ledger, path } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const db = new Database(path);
		db.exec("CREATE TRIGGER fail_spend BEFORE INSERT ON entries WHEN NEW.body LIKE 'spend:%' BEGIN SELECT RAISE(ABORT, 'injected spend failure'); END;");
		db.close();
		expect(() => sendCeilingNotice(ledger, { workloadId: wl, laneId: `lane-${wl.slice(3)}-1`, level: 80, spend: spent(40), ceiling: NORMAL, stakes: "normal" })).toThrow(/injected spend failure/);
		expect(notices(ledger, wl)).toEqual([]);
	});

	test("the notices sent are per ceiling value and per workload, delivered or not; a notice not written by the runner never counts", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const { wl: other } = workloadWithSlice(ledger);
		const laneId = `lane-${wl.slice(3)}-1`;
		// a lane forging the runner's text
		sendNotice(ledger, { by: laneId, workloadId: wl, body: `ceiling 80 % at ${ceilingKey(NORMAL)} on ${wl}: forged` });
		expect(ceilingNoticesSent(ledger, wl, NORMAL)).toEqual([]);
		c.plusHours(1);
		const id = sendCeilingNotice(ledger, { workloadId: wl, laneId, level: 80, spend: spent(40), ceiling: NORMAL, stakes: "normal" });
		ledger.advanceMessage(id, "delivered", { by: SURFACE_BY });
		c.plusHours(1);
		sendCeilingNotice(ledger, { workloadId: other, laneId: `lane-${other.slice(3)}-1`, level: 100, spend: spent(50), ceiling: NORMAL, stakes: "normal" });
		expect(ceilingNoticesSent(ledger, wl, NORMAL)).toEqual([80]);
		expect(ceilingNoticesSent(ledger, wl, EXTENDED)).toEqual([]);
		expect(ceilingNoticesSent(ledger, other, NORMAL)).toEqual([100]);
	});
});

describe("a relaunch on the same ceiling (§ 2 items 3, 4)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});
	const assistant = (cost: number) => `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 1000, cost: { total: cost } } } })}\n`;
	const started = (laneId: string) => laneStartedBody(laneId, { pid: 1, start: "x", session: null, argv: [], runnerPid: 2 });

	test("keeps the cumulative total: a fresh runner's scan counts every run's session files, its wall counts the earlier run, and the 80 % notice is not sent twice for the same value", () => {
		const c = clock("2026-10-01T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const record = (body: string) => ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body });
		const control = () => controlEntries(ledger.entries(wl));
		const dir = tmp("ceiling-relaunch");
		roots.push(dir);
		const laneFile = join(dir, "2026_lane.jsonl");

		// Run 1: an hour, $30 on the lane and $10 on a hand; 80 % notifies.
		const lane1 = `lane-${wl.slice(3)}-1`;
		record(started(lane1));
		const start1 = Date.parse(c.now());
		writeFileSync(laneFile, assistant(30));
		mkdirSync(join(dir, "2026_lane"));
		writeFileSync(join(dir, "2026_lane", "0-Hand.jsonl"), assistant(10));
		c.at("2026-10-01T11:00:00.000Z");
		const run1: Spend = { ...scanSpend(dir, new Map(), { usd: 0, tokens: 0, wallMin: 0 }), wallMin: wallMinutes(control(), Date.parse(c.now()), start1) };
		expect(run1).toEqual({ usd: 40, tokens: 2000, wallMin: 60 });
		const first = step(fresh, NORMAL, run1, ceilingNoticesSent(ledger, wl, NORMAL));
		expect(first).toMatchObject({ level: 80, notice: 80, stop: false });
		sendCeilingNotice(ledger, { workloadId: wl, laneId: lane1, level: 80, spend: run1, ceiling: NORMAL, stakes: "normal" });
		record(laneExitBody(lane1, { code: 0, signal: null, outcome: "completed" }));

		// Parked on Jo for two hours, then run 2 resumes the lane session (--resume appends to the same file) with a fresh runner.
		c.at("2026-10-01T13:00:00.000Z");
		const lane2 = `lane-${wl.slice(3)}-2`;
		record(started(lane2));
		const start2 = Date.parse(c.now());
		writeFileSync(laneFile, assistant(2.5), { flag: "a" });
		c.at("2026-10-01T13:30:00.000Z");
		const run2: Spend = { ...scanSpend(dir, new Map(), { usd: 0, tokens: 0, wallMin: 0 }), wallMin: wallMinutes(control(), Date.parse(c.now()), start2) };
		expect(run2).toEqual({ usd: 42.5, tokens: 3000, wallMin: 90 });
		expect(step(fresh, NORMAL, run2, ceilingNoticesSent(ledger, wl, NORMAL))).toMatchObject({ level: 80, notice: null, stop: false });
		// and at 100 % the relaunched runner stops with the stop notice, which the ledger did not hold
		expect(step(fresh, NORMAL, { ...run2, usd: 50 }, ceilingNoticesSent(ledger, wl, NORMAL))).toMatchObject({ level: 100, notice: 100, stop: true });
		expect(ledger.questions(wl)).toEqual([]);
	});
});

describe("a raise racing the 100 % stop (meterPoll)", () => {
	/** An autonomous normal workload at $50 / 6h, lane-t-1 launched on it and holding it under a live lease. */
	function held(l: Ledger) {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		return wl;
	}
	/** `ledger` with `raise` run once, at the first transaction the caller opens: the moment between the runner's poll snapshot and its first write. */
	function raisingAtFirstWrite(ledger: Ledger, raise: () => void): Ledger {
		let fired = false;
		return new Proxy(ledger, {
			get(target, key) {
				const v = Reflect.get(target, key, target);
				if (key === "write") {
					return <T>(fn: () => T): T => {
						if (!fired) {
							fired = true;
							raise();
						}
						return target.write(fn);
					};
				}
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
	}
	const atCeiling: Spend = { usd: 50.2, tokens: 1000, wallMin: 40 };
	const control = (l: Ledger, wl: string) => controlEntries(l.entries(wl));
	const stops = (l: Ledger, wl: string) => control(l, wl).filter((c) => c.prefix === "lane-stop").map((c) => c.body);
	const requests = (l: Ledger, wl: string) => control(l, wl).filter((c) => c.prefix === "launch-requested");

	test("a raise landing after the poll measured 100 % of the old value and before its write: the runner reads the new value and goes on, nothing stops, no relaunch is needed", () => {
		const { ledger } = tempLedger();
		const wl = held(ledger);
		let receipt = "";
		const polled = meterPoll(raisingAtFirstWrite(ledger, () => {
			receipt = apply(ledger, interpret(ledger, `extend ${wl}`)!);
		}), { workloadId: wl, laneId: "lane-t-1", spend: atCeiling, state: fresh });
		expect(receipt).toContain("lane-t-1 still holds it and goes on under it");
		expect(polled).toMatchObject({ stop: false, accepted: false, notice: null });
		expect(stops(ledger, wl)).toEqual([]);
		expect(ceilingNoticesSent(ledger, wl, NORMAL)).toEqual([]);
		expect(requests(ledger, wl)).toEqual([]);
	});

	test("a raise landing after the poll's write sees the accepted ceiling stop and requests the relaunch", () => {
		const { ledger } = tempLedger();
		const wl = held(ledger);
		const polled = meterPoll(ledger, { workloadId: wl, laneId: "lane-t-1", spend: atCeiling, state: fresh });
		expect(polled).toMatchObject({ stop: true, accepted: true, notice: 100 });
		expect(stops(ledger, wl)).toEqual(["lane-stop: lane-t-1 accepted ceiling"]);
		expect(apply(ledger, interpret(ledger, `extend ${wl}`)!)).toContain("lane-t-1 is stopping at the ceiling, so a relaunch is requested");
		expect(requests(ledger, wl)).toHaveLength(1);
	});

	test("a stop whose writes fail still stands, unaccepted, and leaves nothing half-written", () => {
		const { ledger, path } = tempLedger();
		const wl = held(ledger);
		const db = new Database(path);
		db.exec("CREATE TRIGGER fail_stop BEFORE INSERT ON entries WHEN NEW.body LIKE 'lane-stop:%' BEGIN SELECT RAISE(ABORT, 'injected stop failure'); END;");
		db.close();
		const polled = meterPoll(ledger, { workloadId: wl, laneId: "lane-t-1", spend: atCeiling, state: fresh });
		expect(polled).toMatchObject({ stop: true, accepted: false, notice: 100, state: fresh });
		expect(ceilingNoticesSent(ledger, wl, NORMAL)).toEqual([]);
		expect(control(ledger, wl).filter((c) => c.prefix === "spend")).toEqual([]);
	});
});
