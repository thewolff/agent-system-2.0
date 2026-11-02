// The runner's ceiling meter (DESIGN-workload-ceiling.md § 2 item 4; PLAN wl-mvfkv7llkp7nk0 § 4, R11 and R12) without
// spawning anything: the pure step over the 80 / 100 thresholds and the notices already sent, and the ledger side of a
// notice (the held notice and its spend: in one write), of the notices per ceiling value, and of a relaunch that keeps
// the cumulative total, on a temp ledger. The 80 % notice asks nothing; at the first 100 % hit of a value an autonomous
// lane rises once by half on mechanical progress or asks Jo (PLAN wl-mvqwn80onq9hq8 D12, R29 and R31), with the git
// reads of the progress test run against real scratch repositories.
import { Database } from "bun:sqlite";
import { spawnSync } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handSpawnBody } from "../../classifier/src/lab";
import { type Findings, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, type Stakes } from "../../ledger/src/index";
import { type Ceiling, ceilingKey, effectiveCeiling, parseCeilingNotice, parseSpend, scanSpend, type Spend, wallMinutes } from "../src/ceiling";
import { controlEntries, laneExitBody, laneStartedBody, launchable } from "../src/launch";
import { apply, interpret } from "../src/input";
import { sendNotice } from "../src/notice";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import {
	ceilingNoticesSent, ceilingPromptLine, gitPushProbe, type HeadRead, type MeterState, meterPoll, meterStep, type PushBranch, pushCheck, type PushProbe, sendCeilingNotice,
} from "../scripts/lane";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

/** A fake PushProbe: one push URL, the heads by `<remote> <branch>` (absent: `none`), an error that makes every read unknown, and `carries`' answer. */
function fakeProbe(o: { heads?: Record<string, string>; url?: string; carries?: boolean | string } = {}) {
	const state = { heads: { ...(o.heads ?? {}) }, url: o.url ?? "file:///remote.git", error: null as string | null, carries: o.carries ?? true, reads: 0 };
	const probe: PushProbe = {
		read: (b) => {
			state.reads++;
			if (state.error !== null) return { ...b, url: state.url, head: "unknown", error: state.error };
			return { ...b, url: state.url, head: state.heads[`${b.remote} ${b.branch}`] ?? "none", error: null };
		},
		carries: () => state.carries,
	};
	return { probe, state };
}
const alarmFile = () => join(tmp("ceiling-alarms"), "auto-apply-alarms.jsonl");
const alarmLines = (file: string): Record<string, unknown>[] =>
	existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>) : [];

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
		}), { workloadId: wl, laneId: "lane-t-1", spend: atCeiling, state: fresh, probe: fakeProbe().probe, alarmFile: alarmFile() });
		expect(receipt).toContain("lane-t-1 still holds it and goes on under it");
		expect(polled).toMatchObject({ stop: false, accepted: false, notice: null, hit: null });
		expect(stops(ledger, wl)).toEqual([]);
		expect(ceilingNoticesSent(ledger, wl, NORMAL)).toEqual([]);
		expect(requests(ledger, wl)).toEqual([]);
		expect(ledger.questions(wl)).toEqual([]);
	});

	test("a raise landing after the poll's write sees the accepted ceiling stop, withdraws the runner's ceiling question and requests the relaunch", () => {
		const { ledger } = tempLedger();
		const wl = held(ledger);
		const polled = meterPoll(ledger, { workloadId: wl, laneId: "lane-t-1", spend: atCeiling, state: fresh, probe: fakeProbe().probe, alarmFile: alarmFile() });
		expect(polled).toMatchObject({ stop: true, accepted: true, notice: 100, hit: { kind: "asked" } });
		expect(stops(ledger, wl)).toEqual(["lane-stop: lane-t-1 accepted ceiling"]);
		const q = ledger.questions(wl)[0]!;
		expect(q.state).toBe("open");
		const receipt = apply(ledger, interpret(ledger, `extend ${wl}`)!);
		expect(receipt).toContain(`withdrew the ceiling question ${q.id}`);
		expect(receipt).toContain("lane-t-1 is stopping at the ceiling, so a relaunch is requested");
		expect(ledger.question(q.id)!.state).toBe("withdrawn");
		expect(requests(ledger, wl)).toHaveLength(1);
	});

	test("a stop whose writes fail still stands, unaccepted, leaves nothing half-written, and the hit's alarm line names the error", () => {
		const { ledger, path } = tempLedger();
		const wl = held(ledger);
		const db = new Database(path);
		db.exec("CREATE TRIGGER fail_stop BEFORE INSERT ON entries WHEN NEW.body LIKE 'lane-stop:%' BEGIN SELECT RAISE(ABORT, 'injected stop failure'); END;");
		db.close();
		const file = alarmFile();
		const polled = meterPoll(ledger, { workloadId: wl, laneId: "lane-t-1", spend: atCeiling, state: fresh, probe: fakeProbe().probe, alarmFile: file });
		expect(polled).toMatchObject({ stop: true, accepted: false, notice: 100, state: fresh, hit: { kind: "alarm" } });
		expect(ceilingNoticesSent(ledger, wl, NORMAL)).toEqual([]);
		expect(control(ledger, wl).filter((c) => c.prefix === "spend" || c.prefix === "ceiling-mark")).toEqual([]);
		expect(ledger.questions(wl)).toEqual([]);
		expect(alarmLines(file)).toEqual([expect.objectContaining({ kind: "ceiling", workload: wl, error: expect.stringContaining("injected stop failure") })]);
	});
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("PLAN wl-mvqwn80onq9hq8 D12: a 100 % hit rises once by half on progress, or asks Jo (meterPoll)", () => {
	const LANE = "lane-t-1";
	const T0 = "2026-10-27T10:00:00.000Z";
	/** An autonomous normal workload at $50 / 6h with one open slice, lane-t-1 holding it; `poll(usd)` is one meter poll a minute later. */
	function setup(o: { ceiling?: string; mode?: "autonomous" | "user-driven" } = {}) {
		const c = clock(T0);
		const { ledger, path } = tempLedger(c.now);
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: o.mode ?? "autonomous" });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: o.ceiling ?? "ceiling: usd 50 wall 360 source stakes normal" });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 3_600_000 }).won).toBe(true);
		const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "Move the offset", doneCondition: "bun test passes", inputs: "src/header.css" });
		const fake = fakeProbe({ heads: { [`origin wl/${wl}`]: SHA_A } });
		const file = alarmFile();
		const poll = (usd: number) => {
			c.plusHours(1 / 60);
			return meterPoll(ledger, { workloadId: wl, laneId: LANE, spend: spent(usd, 10), state: fresh, probe: fake.probe, alarmFile: file });
		};
		const control = () => controlEntries(ledger.entries(wl));
		const rows = (prefix: string) => control().filter((x) => x.prefix === prefix);
		const messages = () => ledger.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ? ORDER BY created_at, rowid").all(wl).map((m) => m.body);
		const ceiling = () => effectiveCeiling(control(), ledger.instructions(wl), "normal");
		return { c, ledger, path, wl, sl, fake, file, poll, control, rows, messages, ceiling };
	}
	const firstLine = (body: string) => body.split("\n")[0];
	const findings = (blocking: number): Findings => ({ counts: { blocking: blocking > 0 ? { correctness: blocking } : {}, major: {}, minor: {} }, titles: [] });
	/** Review round `n` on `sl`: its hand spawned and settled with `blocking` findings. */
	function round(ledger: Ledger, wl: string, sl: string, n: number, blocking: number): void {
		const token = `dt-${sl}-${n}`;
		const group = `dg-${sl}-${n}`;
		const entry = (body: string) => ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body });
		entry(handSpawnBody({ token, root: "/s/lane.jsonl", spawnKey: null, review: true, group, row: ["openai/gpt-6"] }));
		entry(reviewRoundBody({ slice: sl, round: n, token, group, verdict: "accepted", findings: findings(blocking) }));
	}

	test("R29 a slice closed since the window opened: one write holds the stop, the runner's ceiling: at half, its relaunch request and the one-line notice naming the slice; no stop notice", () => {
		const s = setup();
		expect(s.poll(25)).toMatchObject({ level: 0, stop: false, hit: null });
		// the first poll with no mark in the window marks the workload branch from its remote head
		expect(s.rows("ceiling-mark").map((x) => [x.body, x.createdBy])).toEqual([[`ceiling-mark: origin wl/${s.wl} file:///remote.git ${SHA_A}`, LANE_RUNNER_BY]]);
		s.poll(26);
		expect(s.rows("ceiling-mark")).toHaveLength(1);
		expect(s.fake.state.reads).toBe(1);
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "bun test → exit 0" });
		const hit = s.poll(50.2);
		const t = s.c.now();
		expect(hit).toMatchObject({ level: 100, stop: true, accepted: true, notice: 100, hit: { kind: "raised", ceiling: { usd: 75, wallMin: 540 }, progress: `slice-closed ${s.sl}` } });
		expect(s.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY).map((x) => x.body)).toEqual([`ceiling: usd 75 wall 540 source auto-raise half progress slice-closed ${s.sl}`]);
		expect(s.rows("launch-requested").map((x) => [x.body, x.createdBy])).toEqual([[`launch-requested: by lane-runner at ${t} (ceiling auto-raise)`, LANE_RUNNER_BY]]);
		expect(s.rows("lane-stop").map((x) => x.body)).toEqual([`lane-stop: ${LANE} accepted ceiling`]);
		expect(s.messages()).toEqual([
			`notice: ceiling raised once by half on ${s.wl}: $50→$75, 360→540 min; progress: slice-closed ${s.sl}. Next hit asks; \`ceiling <usd> [<hours>] ${s.wl}\` sets another figure, \`halt ${s.wl}\` stops it.`,
		]);
		expect(ceilingNoticesSent(s.ledger, s.wl, NORMAL)).toEqual([]);
		expect(s.ledger.questions(s.wl)).toEqual([]);
		expect(s.ceiling()).toEqual({ usd: 75, wallMin: 540 });
		// once the lane's lease is gone, the runner's request is what relaunches it
		const w = { ...s.ledger.workload(s.wl)!, holder: null };
		expect(launchable(w, s.control(), null, [], s.c.now(), 0, 3)).toEqual({ launch: true, cause: { kind: "request", id: s.rows("launch-requested")[0]!.id } });
	});

	test("R31 the second hit asks Jo, `auto-raise already used`, on a new sl-ceiling-<n> slice when none is open; Jo's `extend <wl>` withdraws it in the raise's write", () => {
		const s = setup();
		s.poll(25);
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "done" });
		expect(s.poll(50.2).hit).toMatchObject({ kind: "raised" });
		s.ledger.completeSlice(s.ledger.addSlice({ by: LANE, workloadId: s.wl, task: "more", doneCondition: "d", inputs: "i" }), { by: LANE, artifact: "done" });
		const second = s.poll(75.5);
		expect(second).toMatchObject({ stop: true, accepted: true, notice: 100, hit: { kind: "asked", first: `ceiling reached on ${s.wl}: auto-raise already used` } });
		const [q] = s.ledger.questions(s.wl);
		expect(firstLine(q!.body)).toBe(`ceiling reached on ${s.wl}: auto-raise already used`);
		expect(q!.body.split("\n")[1]).toStartWith(`ceiling 100 % at usd 75 wall 540 on ${s.wl}: $75.50 of $75`);
		expect(JSON.parse(q!.options)).toEqual(["extend", "stop"]);
		expect(q!.created_by).toBe(LANE_RUNNER_BY);
		const slice = s.ledger.slice(q!.slice_id)!;
		expect(slice.id).toMatch(/^sl-ceiling-\d+$/);
		expect([slice.task, slice.state]).toEqual(["decide the ceiling", "paused"]);
		expect(s.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY)).toHaveLength(1);
		expect(s.ceiling()).toEqual({ usd: 75, wallMin: 540 });
		// the question takes the stop notice's place, once per value: a relaunch on the same value asks nothing again
		expect(ceilingNoticesSent(s.ledger, s.wl, { usd: 75, wallMin: 540 })).toEqual([100]);
		expect(s.poll(75.6)).toMatchObject({ stop: true, notice: null, hit: null });
		expect(s.ledger.questions(s.wl)).toHaveLength(1);
		const receipt = apply(s.ledger, interpret(s.ledger, `extend ${s.wl}`)!);
		expect(receipt).toContain(`withdrew the ceiling question ${q!.id}`);
		expect(s.ledger.question(q!.id)!.state).toBe("withdrawn");
		expect(s.ceiling()).toEqual({ usd: 125, wallMin: 900 });
	});

	test("R31 no progress since the window opened asks Jo `no progress since <t>` on the newest open slice; nothing is raised", () => {
		const s = setup();
		s.poll(25);
		const hit = s.poll(50.2);
		expect(hit).toMatchObject({ stop: true, accepted: true, notice: 100, hit: { kind: "asked", first: `ceiling reached on ${s.wl}: no progress since ${T0}` } });
		const [q] = s.ledger.questions(s.wl);
		expect(q!.slice_id).toBe(s.sl);
		expect(s.ledger.slice(s.sl)!.state).toBe("paused");
		expect(s.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY)).toEqual([]);
		expect(s.rows("launch-requested")).toEqual([]);
		expect(s.rows("lane-stop").map((x) => x.body)).toEqual([`lane-stop: ${LANE} accepted ceiling`]);
		expect(s.messages()).toEqual([]);
		expect(s.ceiling()).toEqual(NORMAL);
	});

	test("R29 the window opens at the newest ceiling notice: a slice closed before the 80 % notice is no progress at the hit", () => {
		const s = setup();
		s.poll(25);
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "done" });
		expect(s.poll(40)).toMatchObject({ notice: 80, hit: null });
		const noticeAt = s.c.now();
		// the notice's write marks every branch again
		expect(s.rows("ceiling-mark")).toHaveLength(2);
		expect(s.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${s.wl}: no progress since ${noticeAt}` });
	});

	test("R29 a slice closed or a review round settled in the notice's own millisecond, before it, is no progress at the hit", () => {
		const s = setup();
		s.poll(25);
		s.c.plusHours(1 / 60);
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "done" });
		expect(meterPoll(s.ledger, { workloadId: s.wl, laneId: LANE, spend: spent(40, 10), state: fresh, probe: s.fake.probe, alarmFile: s.file })).toMatchObject({ notice: 80, hit: null });
		const noticeAt = s.c.now();
		expect(s.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${s.wl}: no progress since ${noticeAt}` });

		const r = setup();
		r.poll(25);
		round(r.ledger, r.wl, r.sl, 1, 3);
		r.c.plusHours(1 / 60);
		round(r.ledger, r.wl, r.sl, 2, 1);
		expect(meterPoll(r.ledger, { workloadId: r.wl, laneId: LANE, spend: spent(40, 10), state: fresh, probe: r.fake.probe, alarmFile: r.file })).toMatchObject({ notice: 80, hit: null });
		const roundNoticeAt = r.c.now();
		expect(r.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${r.wl}: no progress since ${roundNoticeAt}` });
	});

	test("R29 a baseline mark tied with the notice's own millisecond never stands in for the notice's mark", () => {
		const s = setup();
		s.poll(25); // the baseline poll marks head A
		s.fake.state.heads[`origin wl/${s.wl}`] = SHA_B;
		// the 80 % notice in the same millisecond marks head B: B was there when the window opened
		expect(meterPoll(s.ledger, { workloadId: s.wl, laneId: LANE, spend: spent(40, 10), state: fresh, probe: s.fake.probe, alarmFile: s.file })).toMatchObject({ notice: 80, hit: null });
		const noticeAt = s.c.now();
		expect(s.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${s.wl}: no progress since ${noticeAt}` });
	});

	test("R29 a commit on the workload branch or a push-dest branch the mark lacked is progress, named by remote, branch and sha", () => {
		const s = setup();
		s.ledger.recordEntry({ by: LANE, workloadId: s.wl, kind: "assumption", body: `push-dest: fork feature/offset ${SHA_A}` });
		s.poll(25);
		expect(s.rows("ceiling-mark").map((x) => x.body)).toEqual([
			`ceiling-mark: origin wl/${s.wl} file:///remote.git ${SHA_A}`,
			"ceiling-mark: fork feature/offset file:///remote.git none",
		]);
		s.fake.state.heads["fork feature/offset"] = SHA_B;
		expect(s.poll(50.2).hit).toEqual({ kind: "raised", ceiling: { usd: 75, wallMin: 540 }, progress: `commit-pushed fork feature/offset ${SHA_B}` });
	});

	test("R29 a head the mark already carries (moved back: carries false) is no progress", () => {
		const s = setup();
		s.poll(25);
		s.fake.state.heads[`origin wl/${s.wl}`] = SHA_B;
		s.fake.state.carries = false;
		expect(s.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${s.wl}: no progress since ${T0}` });
	});

	test("R31 an unknown push check with no other progress asks with the failed check on the first line; with a closed slice the raise carries it", () => {
		const a = setup();
		a.poll(25);
		a.fake.state.error = "`git ls-remote` timed out after 15 s";
		expect(a.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${a.wl}: push check failed: origin wl/${a.wl}: \`git ls-remote\` timed out after 15 s` });
		expect(a.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY)).toEqual([]);

		const b = setup();
		b.poll(25);
		b.ledger.completeSlice(b.sl, { by: LANE, artifact: "done" });
		b.fake.state.url = "file:///moved.git";
		const progress = `slice-closed ${b.sl}; push check failed: origin wl/${b.wl}: push URL changed`;
		expect(b.poll(50.2).hit).toEqual({ kind: "raised", ceiling: { usd: 75, wallMin: 540 }, progress });
		expect(b.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY).map((x) => x.body)).toEqual([`ceiling: usd 75 wall 540 source auto-raise half progress ${progress}`]);
		expect(b.messages()[0]).toContain(`progress: ${progress}.`);
	});

	test("R31 a hit with no mark in the window counts the push as unknown, never as no progress", () => {
		const s = setup();
		expect(s.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${s.wl}: push check failed: origin wl/${s.wl}: no ceiling-mark in the window` });
	});

	test("R31 ask-all asks Jo whatever the progress", () => {
		const s = setup();
		s.poll(25);
		apply(s.ledger, interpret(s.ledger, "ask-all")!);
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "done" });
		expect(s.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${s.wl}: ask-all` });
		expect(s.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY)).toEqual([]);
	});

	test("R29 a review round settled in the window whose known blocking count fell below the previous complete round of its loop is progress", () => {
		const fell = setup();
		fell.poll(25);
		round(fell.ledger, fell.wl, fell.sl, 1, 3);
		round(fell.ledger, fell.wl, fell.sl, 2, 1);
		expect(fell.poll(50.2).hit).toEqual({ kind: "raised", ceiling: { usd: 75, wallMin: 540 }, progress: `blocking-fell ${fell.sl} 3→1` });

		const flat = setup();
		flat.poll(25);
		round(flat.ledger, flat.wl, flat.sl, 1, 1);
		round(flat.ledger, flat.wl, flat.sl, 2, 2);
		expect(flat.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${flat.wl}: no progress since ${T0}` });

		// round 2 has a second hand with no readable findings block: its known sum (1) is not a drop from 3
		const partial = setup();
		partial.poll(25);
		round(partial.ledger, partial.wl, partial.sl, 1, 3);
		round(partial.ledger, partial.wl, partial.sl, 2, 1);
		const unread = (body: string) => partial.ledger.recordEntry({ by: LANE, workloadId: partial.wl, sliceId: partial.sl, kind: "assumption", body });
		unread(handSpawnBody({ token: `dt-${partial.sl}-2b`, root: "/s/lane.jsonl", spawnKey: null, review: true, group: `dg-${partial.sl}-2`, row: ["openai/gpt-6"] }));
		unread(reviewRoundBody({ slice: partial.sl, round: 2, token: `dt-${partial.sl}-2b`, group: `dg-${partial.sl}-2`, verdict: "accepted", findings: UNKNOWN }));
		expect(partial.poll(50.2).hit).toMatchObject({ kind: "asked", first: `ceiling reached on ${partial.wl}: no progress since ${T0}` });
	});

	test("R31 half of a ceiling that rounds to no raise is a failed raise: Jo is asked, nothing announces a raise", () => {
		const s = setup({ ceiling: "ceiling: usd 0.01 wall 1 source stakes normal" });
		s.c.plusHours(1 / 120); // the window opens at the ceiling row (T0); progress in its own millisecond is not proven
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "done" });
		const hit = s.poll(0.02);
		expect(hit).toMatchObject({ stop: true, accepted: true, hit: { kind: "asked", first: "ceiling auto-raise failed: half of $0.01 / 1 min rounds to no raise" } });
		const [q] = s.ledger.questions(s.wl);
		expect(q!.body.split("\n")[2]).toStartWith(`progress: slice-closed ${s.sl}`);
		expect(s.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY)).toEqual([]);
		expect(s.messages()).toEqual([]);
	});

	test("R31 a raise write that throws rolls back whole; the same poll keeps the stop and asks `ceiling auto-raise failed: <error>` with the evidence", () => {
		const s = setup();
		s.poll(25);
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "done" });
		const db = new Database(s.path);
		db.exec("CREATE TRIGGER fail_raise BEFORE INSERT ON messages WHEN NEW.body LIKE 'notice: ceiling raised%' BEGIN SELECT RAISE(ABORT, 'injected notice failure'); END;");
		db.close();
		const hit = s.poll(50.2);
		expect(hit).toMatchObject({ stop: true, accepted: true, notice: 100, hit: { kind: "asked" } });
		const [q] = s.ledger.questions(s.wl);
		expect(firstLine(q!.body)).toStartWith("ceiling auto-raise failed: ");
		expect(firstLine(q!.body)).toContain("injected notice failure");
		expect(q!.body).toContain(`progress: slice-closed ${s.sl}`);
		// nothing half-raised: no runner ceiling:, no relaunch request, no notice
		expect(s.rows("ceiling").filter((x) => x.createdBy === LANE_RUNNER_BY)).toEqual([]);
		expect(s.rows("launch-requested")).toEqual([]);
		expect(s.messages()).toEqual([]);
		expect(s.rows("lane-stop").map((x) => x.body)).toEqual([`lane-stop: ${LANE} accepted ceiling`]);
		expect(s.ceiling()).toEqual(NORMAL);
	});

	test("R31 when the question write throws too, the stop stands unaccepted, nothing is written, and one ceiling alarm line names both errors", () => {
		const s = setup();
		s.poll(25);
		s.ledger.completeSlice(s.sl, { by: LANE, artifact: "done" });
		const db = new Database(s.path);
		db.exec("CREATE TRIGGER fail_raise BEFORE INSERT ON entries WHEN NEW.body LIKE 'ceiling: usd % source auto-raise half%' BEGIN SELECT RAISE(ABORT, 'injected raise failure'); END;");
		db.exec("CREATE TRIGGER fail_question BEFORE INSERT ON questions BEGIN SELECT RAISE(ABORT, 'injected question failure'); END;");
		db.close();
		const before = s.control().length;
		const hit = s.poll(50.2);
		expect(hit).toMatchObject({ stop: true, accepted: false, notice: 100, state: fresh, hit: { kind: "alarm" } });
		expect(s.control()).toHaveLength(before);
		expect(s.ledger.questions(s.wl)).toEqual([]);
		const lines = alarmLines(s.file);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ kind: "ceiling", workload: s.wl });
		expect(typeof lines[0]!.at).toBe("string");
		expect(lines[0]!.error).toContain("injected raise failure");
		expect(lines[0]!.error).toContain("injected question failure");
		expect(lines[0]!.raiseError).toContain("injected raise failure");
		expect(lines[0]!.questionError).toContain("injected question failure");
	});

	test("a user-driven workload that still reaches the meter keeps today's stop notice", () => {
		const s = setup({ mode: "user-driven" });
		s.poll(25);
		expect(s.poll(50.2)).toMatchObject({ stop: true, notice: 100, hit: null });
		expect(ceilingNoticesSent(s.ledger, s.wl, NORMAL)).toEqual([100]);
		expect(s.ledger.questions(s.wl)).toEqual([]);
	});

	test("the lane's first prompt says what happens at 100 %", () => {
		expect(ceilingPromptLine(NORMAL, spent(10, 30))).toEndWith(
			"At 80 % Jo gets a notice; at 100 % the ceiling rises once by half when the work made progress since the last ceiling notice; otherwise this lane stops and Jo is asked.",
		);
	});
});

describe("PLAN wl-mvqwn80onq9hq8 D12: the push check on real repositories (R29)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});
	const git = (cwd: string, ...args: string[]): string => {
		const r = spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${r.exitCode}: ${r.stderr.toString()}`);
		return r.stdout.toString().trim();
	};
	const BRANCH = "wl/wl-git";
	const b: PushBranch = { remote: "origin", branch: BRANCH };
	/** A bare remote, a worktree clone of it with commit A pushed to the workload branch, and the probe on the worktree. */
	function repos() {
		const root = tmp("ceiling-git");
		roots.push(root);
		const remote = join(root, "remote.git");
		const work = join(root, "work");
		git(root, "init", "--bare", remote);
		git(root, "clone", remote, work);
		const commit = (dir: string, name: string) => {
			writeFileSync(join(dir, name), name);
			git(dir, "add", name);
			git(dir, "commit", "-m", name);
			return git(dir, "rev-parse", "HEAD");
		};
		const a = commit(work, "a.txt");
		git(work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		const probe = gitPushProbe(work);
		return { root, remote, work, commit, a, probe };
	}
	const check = (probe: PushProbe, mark: HeadRead) => pushCheck(b, mark, probe.read(b), probe);

	test("R29 a push of a new commit is progress; a dry run and an up-to-date push are not", () => {
		const r = repos();
		const mark = r.probe.read(b);
		expect(mark).toEqual({ ...b, url: r.remote, head: r.a, error: null });
		const bSha = r.commit(r.work, "b.txt");
		git(r.work, "push", "--dry-run", "origin", `HEAD:refs/heads/${BRANCH}`);
		expect(check(r.probe, mark)).toEqual({ kind: "none" });
		git(r.work, "push", "origin", `${r.a}:refs/heads/${BRANCH}`);
		expect(check(r.probe, mark)).toEqual({ kind: "none" });
		git(r.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		expect(check(r.probe, mark)).toEqual({ kind: "pushed", sha: bSha });
	});

	test("R29 a head moved back and a deleted branch are not a pushed commit; a branch created since a `none` mark is", () => {
		const r = repos();
		r.commit(r.work, "b.txt");
		git(r.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		const mark = r.probe.read(b);
		git(r.work, "push", "--force", "origin", `${r.a}:refs/heads/${BRANCH}`);
		expect(r.probe.read(b).head).toBe(r.a);
		expect(check(r.probe, mark)).toEqual({ kind: "none" });
		git(r.work, "push", "origin", `:refs/heads/${BRANCH}`);
		const gone = r.probe.read(b);
		expect(gone.head).toBe("none");
		expect(check(r.probe, mark)).toEqual({ kind: "none" });
		git(r.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		expect(check(r.probe, gone)).toMatchObject({ kind: "pushed" });
	});

	test("R29 a changed push URL is unknown, never progress", () => {
		const r = repos();
		const mark = r.probe.read(b);
		const other = join(r.root, "other.git");
		git(r.root, "init", "--bare", other);
		r.commit(r.work, "b.txt");
		git(r.work, "remote", "set-url", "--push", "origin", other);
		git(r.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		expect(check(r.probe, mark)).toEqual({ kind: "unknown", error: "push URL changed" });
	});

	test("R29 in a shallow clone the ancestry test is unknown (`shallow clone`), never progress", () => {
		const r = repos();
		r.commit(r.work, "b.txt");
		git(r.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		const shallow = join(r.root, "shallow");
		git(r.root, "clone", "--depth", "1", "--branch", BRANCH, `file://${r.remote}`, shallow);
		git(shallow, "remote", "set-url", "--push", "origin", r.remote);
		const probe = gitPushProbe(shallow);
		const mark = { ...probe.read(b), head: r.a };
		r.commit(r.work, "c.txt");
		git(r.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		expect(check(probe, mark)).toEqual({ kind: "unknown", error: "shallow clone" });
	});

	test("R29 a head pushed from another clone is fetched once and counted; a remote that cannot be read is unknown", () => {
		const r = repos();
		const mark = r.probe.read(b);
		const elsewhere = join(r.root, "elsewhere");
		git(r.root, "clone", "--branch", BRANCH, r.remote, elsewhere);
		const c = r.commit(elsewhere, "c.txt");
		git(elsewhere, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
		expect(spawnSync(["git", "cat-file", "-e", `${c}^{commit}`], { cwd: r.work, stderr: "pipe" }).exitCode).not.toBe(0);
		expect(check(r.probe, mark)).toEqual({ kind: "pushed", sha: c });
		git(r.work, "remote", "set-url", "--push", "origin", join(r.root, "missing.git"));
		const broken = r.probe.read(b);
		expect(broken.head).toBe("unknown");
		expect(broken.error).toContain("ls-remote");
		expect(pushCheck(b, { ...mark, url: broken.url }, broken, r.probe)).toMatchObject({ kind: "unknown", error: expect.stringContaining("ls-remote") });
	});

	test("R29 end to end: meterPoll marks the unpushed branch `none`, and a push before the hit raises the ceiling with the pushed sha", () => {
		const r = repos();
		const c = clock("2026-10-27T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "b", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-g-1 cause first requested-by test" });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-g-1", leaseMs: 3_600_000 }).won).toBe(true);
		ledger.addSlice({ by: "lane-g-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const file = alarmFile();
		const poll = (usd: number) => {
			c.plusHours(1 / 60);
			return meterPoll(ledger, { workloadId: wl, laneId: "lane-g-1", spend: spent(usd, 10), state: fresh, probe: r.probe, alarmFile: file });
		};
		poll(25);
		expect(controlEntries(ledger.entries(wl)).filter((x) => x.prefix === "ceiling-mark").map((x) => x.body)).toEqual([`ceiling-mark: origin wl/${wl} ${r.remote} none`]);
		git(r.work, "push", "origin", `HEAD:refs/heads/wl/${wl}`);
		expect(poll(50.2).hit).toEqual({ kind: "raised", ceiling: { usd: 75, wallMin: 540 }, progress: `commit-pushed origin wl/${wl} ${r.a}` });
	});
});
