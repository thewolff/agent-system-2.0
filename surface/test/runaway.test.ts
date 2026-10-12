// MIGRATION.md item 111: the runaway trips' pure parts (surface/src/runaway.ts), on synthetic samples and rows.
import { describe, expect, test } from "bun:test";
import { BURN_WATCH_START, type BurnWatch, burnStep, FLIGHT_CLOCK_START, type FlightClock, flightElapsed, flightReset, flightStep, isProgress, lastProgress, RUNAWAY_DEFAULTS } from "../src/runaway";

const MIN = 60_000;

describe("lastProgress (no-progress)", () => {
	const at = (m: number) => new Date(Date.UTC(2026, 9, 12, 1, m)).toISOString();
	const floor = Date.parse(at(0));
	test("wake-read entries and spend: lines are not progress; other writes by the lane are; other writers are ignored", () => {
		expect(isProgress({ created_by: "l-1", created_at: at(1), kind: "wake-read", body: "I resume" })).toBe(false);
		expect(isProgress({ created_by: "l-1", created_at: at(1), kind: "assumption", body: "spend: l-1 usd 1 tokens 2 wall 3" })).toBe(false);
		expect(isProgress({ created_by: "l-1", created_at: at(1), kind: "assumption", body: "hand-spawn: dt-1" })).toBe(true);
		expect(isProgress({ created_by: "l-1", created_at: at(1) })).toBe(true); // a slice or a question
		const rows = [
			{ created_by: "l-1", created_at: at(3), kind: "assumption", body: "builder-lab: openai" },
			...Array.from({ length: 20 }, (_, i) => ({ created_by: "l-1", created_at: at(4 + i), kind: "wake-read", body: "I resume" })),
			{ created_by: "lane-runner", created_at: at(30), kind: "assumption", body: "lane-started: l-1" },
		];
		expect(lastProgress(rows, "l-1", floor)).toBe(Date.parse(at(3)));
		expect(lastProgress(rows, "l-2", floor)).toBe(floor);
		// a write before the floor (before ready, or before a hold ended) does not move the clock back
		expect(lastProgress(rows, "l-1", Date.parse(at(10)))).toBe(Date.parse(at(10)));
	});
	test("a row's last change by the lane is progress (lane_complete_slice adds no entry); a change by someone else is not (PR #73 review)", () => {
		const before = { created_by: "surface", created_at: at(0), changed_by: "l-1", changed_at: at(7) }; // created before ready, completed by the lane
		const other = { created_by: "l-9", created_at: at(2), changed_by: "l-1", changed_at: at(9) }; // created by another lane, completed by this one
		const answered = { created_by: "l-1", created_at: at(1), changed_by: "jo", changed_at: at(12) }; // the lane's question, answered by Jo
		expect(lastProgress([before], "l-1", floor)).toBe(Date.parse(at(7)));
		expect(lastProgress([before, other], "l-1", floor)).toBe(Date.parse(at(9)));
		expect(lastProgress([answered], "l-1", floor)).toBe(Date.parse(at(1)));
		expect(lastProgress([other], "l-9", floor)).toBe(Date.parse(at(2)));
	});
});

describe("burnStep (token-burn and token-total)", () => {
	/** Samples every 5 min from a 1M baseline (tokens already counted before this run), `perStep` tokens each. */
	const run = (steps: number, perStep: number, windowMs = 30 * MIN) => {
		let w: BurnWatch = BURN_WATCH_START;
		let last = burnStep(w, 0, 1e6, windowMs);
		w = last.watch;
		for (let i = 1; i <= steps; i++) {
			last = burnStep(w, i * 5 * MIN, 1e6 + i * perStep, windowMs);
			w = last.watch;
		}
		return last;
	};
	test("the total is since the run's baseline, not the workload's tally", () => {
		expect(run(3, 100).total).toBe(300);
	});
	test("the window covers the newest sample at least a window old: a steady rate reads the same after an hour as after half of one", () => {
		const half = run(6, 1_000);
		expect(half).toMatchObject({ window: 6_000, total: 6_000, windowMin: 30 });
		const hour = run(12, 1_000);
		expect(hour).toMatchObject({ window: 6_000, total: 12_000, windowMin: 30 });
		// the watch keeps the baseline and the window, not every sample
		expect(hour.watch.samples.length).toBeLessThanOrEqual(8);
	});
	test("before a window has passed, the window is everything since the baseline (a burst trips early)", () => {
		expect(run(2, 5_000)).toMatchObject({ window: 10_000, windowMin: 10 });
	});
});

describe("the no-progress clock counts in-turn time only (flightStep / flightReset / flightElapsed)", () => {
	/** Frames as [minute, type]; returns the clock at `now` minutes. */
	const replay = (frames: [number, string][], now: number, resets: number[] = []): number => {
		let c: FlightClock = flightReset(FLIGHT_CLOCK_START, 0);
		const events = [...frames.map(([m, t]) => ({ m, t })), ...resets.map((m) => ({ m, t: "reset" }))].sort((a, b) => a.m - b.m);
		for (const e of events) c = e.t === "reset" ? flightReset(c, e.m * MIN) : flightStep(c, e.t, e.m * MIN);
		return flightElapsed(c, now * MIN);
	};
	test("between turns nothing accrues; a nested agent_start inside a turn changes nothing; an agent_end with no turn open changes nothing", () => {
		expect(replay([[0, "agent_start"], [5, "agent_end"]], 400)).toBe(5 * MIN);
		expect(replay([[0, "agent_start"], [2, "agent_start"], [5, "agent_end"], [6, "agent_end"]], 10)).toBe(5 * MIN);
		expect(replay([[0, "agent_start"], [5, "agent_end"], [100, "agent_start"]], 103)).toBe(8 * MIN);
		expect(replay([[3, "turn_start"], [4, "auto_compaction_start"]], 50)).toBe(0);
	});
	test("progress (or a hold) restarts it from zero, in or out of a turn", () => {
		expect(replay([[0, "agent_start"]], 30, [20])).toBe(10 * MIN);
		expect(replay([[0, "agent_start"], [10, "agent_end"]], 30, [20])).toBe(0);
	});
	test("today's lanes against the default (MIGRATION.md item 111): the done lane idle 388 min and the active lane's 27.6 min in-turn gap do not trip; the loop lanes' 44.2 and 49.2 min do", () => {
		const limit = RUNAWAY_DEFAULTS.noProgressMs;
		// lane-mv45mh3byhixog-2: its turn ended with done-because:, then the runner sat idle for 388 min
		expect(replay([[0, "agent_start"], [24, "agent_end"]], 24 + 388, [24])).toBeLessThan(limit);
		// lane-mv4rzy53lb8oao-1: in one turn, 27.6 min since its last write
		expect(replay([[0, "agent_start"]], 27.6)).toBeLessThan(limit);
		// lane-mv457r7iqmq29s-3 and -5 (the compaction loop): 44.2 and 49.2 min in a turn with no write
		expect(replay([[0, "agent_start"]], 44.2)).toBeGreaterThanOrEqual(limit);
		expect(replay([[0, "agent_start"]], 49.2)).toBeGreaterThanOrEqual(limit);
	});
});
