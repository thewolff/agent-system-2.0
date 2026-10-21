// The new helpers of PLAN wl-mv5i3lulwwbbi8 D6 and D8 at their boundaries, inside the fence: the settle wait's idleness
// (`settleIdle`, `idleActivity`), the workload's live and dead test runs by `runLive`'s own thresholds (`liveTestRuns`,
// `deadTestRuns`), the counter a continue spends, and the texts the runner sends for them. Boundary tests of new code,
// not regression tests: the turn-end ladder's fails-before cases are in turn-end.test.ts.
import { describe, expect, test } from "bun:test";
import { type RunRecord } from "../src/test-run";
import {
	CONTINUE_LIMIT, continueCounter, deadRunPrompt, deadTestRuns, heldOpenBody, IDLE_CHECK, IDLE_LIMIT, idleActivity, idlePrompt, liveTestRuns, SETTLE_CHECK, SETTLE_IDLE_MS, settleIdle, STATE_ID, turnEnd,
	turnEndDeathBody, type TurnEnd,
} from "../src/turn-end";

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const SHA = "a".repeat(40);

/** A `testRuns` record as the ledger order gives it: requested at `T0 + atMs`, with a result when `result` is set. */
function record(runId: string, slice: string, atMs = 0, result = false): RunRecord {
	const createdAt = new Date(T0 + atMs).toISOString();
	const res = result
		? {
			runId, verdict: "error" as const, sha: SHA, pr: 17, reason: "runner died", headAtEnd: null, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: null,
			entryId: `en-r-${runId}`, createdAt,
		}
		: null;
	return { request: { runId, pr: 17, sha: SHA, slice, by: "lane-a", entryId: `en-q-${runId}`, createdAt }, results: res ? [res] : [], result: res };
}

describe("settleIdle and idleActivity (D6)", () => {
	test("15 minutes in the settle wait with no frame is idle; 14:59 is not", () => {
		expect(SETTLE_IDLE_MS).toBe(15 * MIN);
		expect(settleIdle(T0, T0, T0 + 14 * MIN + 59_000)).toBe(false);
		expect(settleIdle(T0, T0, T0 + 15 * MIN)).toBe(true);
		// a frame older than the wait does not shorten it
		expect(settleIdle(T0, T0 - 60 * MIN, T0 + 14 * MIN + 59_000)).toBe(false);
	});

	test("a frame at 10 minutes resets the wait: idle only 15 minutes after it", () => {
		expect(settleIdle(T0, T0 + 10 * MIN, T0 + 15 * MIN)).toBe(false);
		expect(settleIdle(T0, T0 + 10 * MIN, T0 + 24 * MIN + 59_000)).toBe(false);
		expect(settleIdle(T0, T0 + 10 * MIN, T0 + 25 * MIN)).toBe(true);
	});

	test("the idle wait is the caller's (the runner's env knob)", () => {
		expect(settleIdle(T0, T0, T0 + 1_999, 2_000)).toBe(false);
		expect(settleIdle(T0, T0, T0 + 2_000, 2_000)).toBe(true);
	});

	test("the runner's own get_state replies are not activity; every other frame is", () => {
		for (const id of [STATE_ID, SETTLE_CHECK, IDLE_CHECK]) expect(idleActivity({ id, type: "response", command: "get_state", success: true, data: { isSettled: false } })).toBe(false);
		expect(idleActivity({ id: "p2", type: "response", command: "prompt", success: true })).toBe(true);
		expect(idleActivity({ type: "message_update" })).toBe(true);
		expect(idleActivity({ type: "session_settled" })).toBe(true);
		expect(idleActivity({ type: "prompt_result", id: "p1", status: "completed", sessionSettled: false })).toBe(true);
	});
});

describe("liveTestRuns and deadTestRuns: runLive's thresholds exactly (D8)", () => {
	const beat = (ms: number | null) => () => (ms === null ? null : T0 + ms);

	test("a heartbeat 59 s old is live, 61 s old is not", () => {
		const recs = [record("tr-0a", "sl-a")];
		expect(liveTestRuns(recs, beat(100_000), T0 + 159_000)).toEqual(["tr-0a"]);
		expect(liveTestRuns(recs, beat(100_000), T0 + 161_000)).toEqual([]);
	});

	test("no heartbeat: live 119 s after the request, not 121 s after it", () => {
		const recs = [record("tr-0a", "sl-a")];
		expect(liveTestRuns(recs, beat(null), T0 + 119_000)).toEqual(["tr-0a"]);
		expect(liveTestRuns(recs, beat(null), T0 + 121_000)).toEqual([]);
	});

	test("a run with a result is neither live nor dead, whatever its heartbeat", () => {
		const recs = [record("tr-0a", "sl-a", 0, true)];
		expect(liveTestRuns(recs, beat(0), T0 + 1_000)).toEqual([]);
		expect(deadTestRuns(recs, beat(null), T0 + 600_000, new Set())).toEqual([]);
	});

	test("dead: not live, no result, the newest request on its slice, not yet prompted", () => {
		const recs = [record("tr-0old", "sl-a"), record("tr-0new", "sl-a", 1_000), record("tr-0b", "sl-b", 2_000)];
		const now = T0 + 600_000;
		expect(deadTestRuns(recs, beat(null), now, new Set())).toEqual([{ runId: "tr-0new", pr: 17, slice: "sl-a" }, { runId: "tr-0b", pr: 17, slice: "sl-b" }]);
		expect(deadTestRuns(recs, beat(null), now, new Set(["tr-0new"]))).toEqual([{ runId: "tr-0b", pr: 17, slice: "sl-b" }]);
		// live runs are not dead
		expect(deadTestRuns(recs, beat(590_000), now, new Set())).toEqual([]);
		expect(deadTestRuns(recs, beat(null), T0 + 60_000, new Set())).toEqual([]);
	});
});

describe("the counter a continue spends and the texts (D6, D8)", () => {
	const t = (decision: TurnEnd["decision"], continued?: TurnEnd["continued"]): TurnEnd => ({ decision, parkError: null, ...(continued ? { continued } : {}) });

	test("hands, runs and open work spend continues; an idle prompt spends idleContinues; a dead run's spends nothing", () => {
		expect(continueCounter(t("continue", { kind: "hands" }))).toBe("continues");
		expect(continueCounter(t("continue", { kind: "runs" }))).toBe("continues");
		expect(continueCounter(t("continue", { kind: "work" }))).toBe("continues");
		expect(continueCounter(t("continue", { kind: "idle" }))).toBe("idle");
		expect(continueCounter(t("continue", { kind: "dead-run", run: { runId: "tr-0d", pr: 3, slice: "sl-a" } }))).toBeNull();
		expect(continueCounter(t("hold"))).toBeNull();
		expect(IDLE_LIMIT).toBe(2);
	});

	test("the idle prompt says what to do, in minutes or (the runner's test knob) seconds, and its place in the episode", () => {
		expect(idlePrompt("wl-x", SETTLE_IDLE_MS, 1, IDLE_LIMIT)).toBe(
			"Your session on wl-x has background work pending and no activity for 15 min: if you need its result, `wait` for it; otherwise continue your slices, or release (record done-because first when the done line is met, then lane_release). (idle prompt 1 of 2)",
		);
		expect(idlePrompt("wl-x", 2_000, 2, IDLE_LIMIT)).toContain("no activity for 2 s:");
	});

	test("the dead-run prompt names the run, the tool, the PR and the slice", () => {
		expect(deadRunPrompt({ runId: "tr-0d", pr: 31, slice: "sl-full" })).toBe(
			"The runner for tr-0d died: no heartbeat, no result on the ledger. Call lane_full_test again (PR #31, slice sl-full): that call settles it as `error runner died` and starts a new run.",
		);
	});

	test("the held-open message names the hands, the live runs, or the reserved request an idle session waits on", () => {
		const L = "lane-t-1";
		expect(heldOpenBody(L, [{ token: "dt-a", job: "sl-a" }], CONTINUE_LIMIT)).toBe(`lane ${L} is held open: hand(s) dt-a unsettled after 2 continue prompts; it ends at a stop, the ceiling or the deadline`);
		expect(heldOpenBody(L, [], CONTINUE_LIMIT, ["tr-0a"])).toBe(`lane ${L} is held open: test run(s) tr-0a live after 2 continue prompts; it ends at a stop, the ceiling or the deadline`);
		expect(heldOpenBody(L, [], CONTINUE_LIMIT, [], true)).toBe(`lane ${L} is held open: a reserved request waits on Jo while the session is idle; it ends at a stop, the ceiling or the deadline`);
	});

	test("an idle open-work death names the idle prompts; a settled one keeps the continue prompts' line", () => {
		const base = {
			status: "completed" as const, unsettledHands: [], liveTestRuns: [], deadTestRuns: [], pendingReserved: false, held: true, handedOff: false, releasedOpen: null, receipt: false, selfReleased: false,
			slices: { open: 1, paused: 0, done: 0 }, continues: 2, idleContinues: 2, limit: CONTINUE_LIMIT, park: () => ({ parked: false as const }),
		};
		const idle = { ...base, settled: false, idle: true };
		expect(turnEndDeathBody("lane-t-1", turnEnd(idle), idle)).toBe("lane-died: lane-t-1: idle with open work after 2 idle prompts (no question, no done-because)");
		const settled = { ...base, settled: true, idle: false };
		expect(turnEndDeathBody("lane-t-1", turnEnd(settled), settled)).toBe("lane-died: lane-t-1: turn ended with open work after 2 continue prompts (no question, no done-because)");
	});
});
