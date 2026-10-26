// The runner's turn-end decision (MIGRATION.md item 40; PLAN wl-muq1v31q5ly7ls D1–D6) as a table,
// inside the fence: the step order (an unsettled hand, then a handoff, before the park), the park
// that throws, the continue limit at its boundary, the texts the runner sends, the death writer's
// one-per-lane guard, and D6's hand predicate against forged and stale settles.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { handSettledBody, handSpawnBody } from "../../classifier/src/lab";
import { LANE_RUNNER_BY, type Ledger } from "../../ledger/src/index";
import { controlEntries, exitClass, holdersOf } from "../src/launch";
import { laneDeaths } from "../src/signals";
import {
	BACKGROUND_SUFFIX, CONTINUE_LIMIT, continuePrompt, enqueueRunnerDeath, exitOutcome, heldOpenBody, openWorkDeathBody, parkFailedDeathBody, releasedOpen, releasedOpenBody, sliceCounts, turnEnd,
	turnEndDeathBody, type TurnEndInput, unsettledHands,
} from "../src/turn-end";
import { recordDecision } from "../scripts/lane";
import { SURFACE_BY } from "../src/types";
import { tempLedger } from "./helpers";

const LANE = "lane-t-1";
const HAND = { token: "dt-a", job: "sl-plan" };

/** A settled turn of a lane that holds the workload with one open slice and nothing else; `park` records its calls. */
function input(over: Partial<TurnEndInput> = {}, parkResult: { parked: false } | { parked: true; open: number } = { parked: false }) {
	const calls: number[] = [];
	const i: TurnEndInput = {
		settled: true, idle: false, status: "completed", unsettledHands: [], liveTestRuns: [], deadTestRuns: [], pendingReserved: false, held: true, handedOff: false, releasedOpen: null, receipt: false,
		slices: { open: 1, paused: 0, done: 0 }, continues: 0, idleContinues: 0, limit: CONTINUE_LIMIT,
		park: () => {
			calls.push(1);
			return parkResult;
		},
		...over,
	};
	return { i, calls };
}

describe("turn end: the decision order (D1, D6 step 0, D2)", () => {
	test("an unsettled session waits, before anything is read or parked", () => {
		const { i, calls } = input({ settled: false, unsettledHands: [HAND], handedOff: true });
		expect(turnEnd(i).decision).toBe("wait");
		expect(calls).toHaveLength(0);
	});

	test("a hand of this lane unsettled: continue, then hold once the limit is spent, never a park — whatever the status, the handoff or a question", () => {
		for (const status of ["completed", "error", "aborted"] as const) {
			for (const [continues, decision] of [[0, "continue"], [1, "continue"], [2, "hold"]] as const) {
				const { i, calls } = input({ unsettledHands: [HAND], status, continues, handedOff: status === "aborted" }, { parked: true, open: 1 });
				expect(turnEnd(i).decision).toBe(decision);
				expect(calls).toHaveLength(0);
			}
		}
	});

	test("a handoff is released before the park: a question the lane raised is not parked", () => {
		const { i, calls } = input({ handedOff: true, held: false }, { parked: true, open: 1 });
		expect(turnEnd(i).decision).toBe("released");
		expect(calls).toHaveLength(0);
	});

	test("an error or aborted prompt keeps its status once no hand is unsettled, with no park and its own death line", () => {
		for (const status of ["error", "aborted"] as const) {
			const { i, calls } = input({ status, receipt: true });
			const t = turnEnd(i);
			expect(t.decision).toBe(status);
			expect(calls).toHaveLength(0);
			expect(turnEndDeathBody(LANE, t, i)).toBe(`lane-died: ${LANE}: prompt ended ${status}`);
		}
	});

	test("a park that throws is error, never completed; its death names the release marker when there is one (T12)", () => {
		const { i } = input({ held: false, releasedOpen: 1, park: () => {
			throw new Error("database is locked");
		} });
		const t = turnEnd(i);
		expect(t).toEqual({ decision: "error", parkError: "database is locked" });
		expect(turnEndDeathBody(LANE, t, i)).toBe(`lane-died: ${LANE}: turn-end park failed: database is locked; released with 1 open slice(s)`);
		expect(parkFailedDeathBody(LANE, "x", null)).toBe(`lane-died: ${LANE}: turn-end park failed: x`);
	});

	test("a parked question wins over everything after it: parked with one open, resume-pending with none open", () => {
		expect(turnEnd(input({}, { parked: true, open: 1 }).i).decision).toBe("parked");
		expect(turnEnd(input({ held: false, releasedOpen: 2 }, { parked: true, open: 0 }).i).decision).toBe("resume-pending");
	});

	test("released: with this lane's released-open marker it is open-work with the release's death line; without one, completed", () => {
		const marked = input({ held: false, releasedOpen: 1 }).i;
		const t = turnEnd(marked);
		expect(t.decision).toBe("open-work");
		expect(turnEndDeathBody(LANE, t, marked)).toBe(`lane-died: ${LANE}: released with 1 open slice(s), no done-because`);
		expect(turnEnd(input({ held: false }).i).decision).toBe("completed");
	});

	test("a receipt completes with slices still open; every slice done or cancelled with one done completes", () => {
		expect(turnEnd(input({ receipt: true, slices: { open: 2, paused: 1, done: 0 } }).i).decision).toBe("completed");
		const done = input({ slices: { open: 0, paused: 0, done: 2 } });
		expect(turnEnd(done.i).decision).toBe("completed");
		expect(done.calls).toHaveLength(1);
		expect(turnEnd(input({ slices: { open: 0, paused: 1, done: 2 } }).i).decision).toBe("continue");
	});

	test("open work at the limit's boundary: the first and second turn ends continue, the third is open-work with its death line", () => {
		const decisions = [0, 1, 2, 3].map((continues) => turnEnd(input({ continues }).i).decision);
		expect(decisions).toEqual(["continue", "continue", "open-work", "open-work"]);
		const last = input({ continues: 2 }).i;
		expect(turnEndDeathBody(LANE, turnEnd(last), last)).toBe(openWorkDeathBody(LANE, 2));
		expect(openWorkDeathBody(LANE, 2)).toBe(`lane-died: ${LANE}: turn ended with open work after 2 continue prompts (no question, no done-because)`);
		// a limit of 0 (Jo's "surface only") surfaces at once
		expect(turnEnd(input({ limit: 0 }).i).decision).toBe("open-work");
	});

	test("no slice cut (none at all, or every one cancelled) is open work too (Jo's \"no slice too\")", () => {
		const none = { open: 0, paused: 0, done: 0 };
		expect(turnEnd(input({ slices: none }).i).decision).toBe("continue");
		expect(turnEnd(input({ slices: none, continues: 2 }).i).decision).toBe("open-work");
	});
});

// PLAN wl-mv5i3lulwwbbi8 D6 and D8, through turnEnd's existing export only: the new inputs are fields origin/main ignores,
// so each case fails there on its assertion (D6: `wait`; D8: open-work). The new helpers' own cases are in turn-idle.test.ts.
describe("turn end: an idle session and the lane's test runs (PLAN wl-mv5i3lulwwbbi8 D6, D8)", () => {
	/** omp unsettled, the settle wait idle: the runner decides with idle: true, the open slice's continues already spent. */
	const idle = (over: Partial<TurnEndInput> = {}, parkResult?: { parked: false } | { parked: true; open: number }) => input({ settled: false, idle: true, continues: 2, ...over }, parkResult);
	const RUN = { runId: "tr-0dead1", pr: 17, slice: "sl-full" };

	test("D6: idle with an open slice and continues spent → continue with the idle prompt, counted apart from continues", () => {
		const t = turnEnd(idle({ idleContinues: 0 }).i);
		expect(t.decision).toBe("continue");
		expect(t.continued).toEqual({ kind: "idle" });
		expect(turnEnd(idle({ idleContinues: 1, continues: 0 }).i).continued).toEqual({ kind: "idle" });
	});

	test("D6: idle after two idle prompts → open-work, its death naming the idle prompts", () => {
		const { i } = idle({ idleContinues: 2 });
		const t = turnEnd(i);
		expect(t.decision).toBe("open-work");
		expect(turnEndDeathBody(LANE, t, i)).toBe(`lane-died: ${LANE}: idle with open work after 2 idle prompts (no question, no done-because)`);
	});

	test("D6: idle with a receipt → completed; parked as today", () => {
		expect(turnEnd(idle({ receipt: true }).i).decision).toBe("completed");
		expect(turnEnd(idle({}, { parked: true, open: 1 }).i).decision).toBe("parked");
	});

	test("D6: idle with an unsettled hand → hold, never a park", () => {
		const { i, calls } = idle({ unsettledHands: [HAND] });
		expect(turnEnd(i).decision).toBe("hold");
		expect(calls).toHaveLength(0);
	});

	test("D6: idle with a live test run → hold", () => {
		expect(turnEnd(idle({ liveTestRuns: ["tr-0live1"] }).i).decision).toBe("hold");
	});

	test("D6: idle with a reserved request waiting on Jo → hold; a settled session's ladder has no such step", () => {
		expect(turnEnd(idle({ pendingReserved: true, idleContinues: 2 }).i).decision).toBe("hold");
		expect(turnEnd(input({ pendingReserved: true, continues: 2 }).i).decision).toBe("open-work");
		// unsettled and not idle still waits
		expect(turnEnd(input({ settled: false, pendingReserved: true, liveTestRuns: ["tr-0live1"] }).i).decision).toBe("wait");
	});

	test("D8: an open slice and a live test run: continue naming the run below the limit, then hold, never open-work", () => {
		const below = input({ liveTestRuns: ["tr-0live1"], continues: 0 }).i;
		const t = turnEnd(below);
		expect(t.decision).toBe("continue");
		expect(t.continued).toEqual({ kind: "runs" });
		const prompt = continuePrompt("wl-x", below, 1, 2);
		expect(prompt).toStartWith("Test run(s) tr-0live1 on wl-x have no result on the ledger yet; each result arrives as an aside.");
		expect(prompt).toContain("`sleep 60`");
		expect(prompt).toEndWith("(continue 1 of 2)");
		const { i, calls } = input({ liveTestRuns: ["tr-0live1"], continues: 2 });
		expect(turnEnd(i).decision).toBe("hold");
		expect(calls).toHaveLength(0);
	});

	test("D8: a dead run not yet prompted → one continue naming it, uncounted, even with the continues spent; once prompted the generic ladder runs", () => {
		const t = turnEnd(input({ continues: 2, deadTestRuns: [RUN] }).i);
		expect(t.decision).toBe("continue");
		expect(t.continued).toEqual({ kind: "dead-run", run: RUN });
		// the runner records the run as prompted and passes it no more: open work at the spent limit, as before D8
		expect(turnEnd(input({ continues: 2, deadTestRuns: [] }).i).decision).toBe("open-work");
	});
});

describe("turn end: the texts", () => {
	test("the continue prompt names the hands and their jobs, the open counts, or that no slice is cut, and its place in the limit", () => {
		expect(continuePrompt("wl-x", { unsettledHands: [HAND, { token: "dt-b", job: "-" }], slices: { open: 1, paused: 0, done: 0 } }, 1, 2)).toBe(
			"Hand(s) dt-a (job sl-plan), dt-b (job -) you spawned have no result on the ledger yet. Keep your turn alive until each result is auto-delivered. If a job no longer exists, say so with lane_message. (continue 1 of 2)",
		);
		const open = continuePrompt("wl-x", { unsettledHands: [], slices: { open: 2, paused: 1, done: 3 } }, 2, 2);
		expect(open).toStartWith("Your turn ended with work open on wl-x: 2 open slice(s), 1 paused, no open question from you, no done-because receipt. Continue.");
		expect(open).toEndWith("(continue 2 of 2)");
		expect(continuePrompt("wl-x", { unsettledHands: [], slices: { open: 0, paused: 0, done: 0 } }, 1, 2)).toContain("with no slice cut");
		expect(heldOpenBody(LANE, [HAND], 2)).toBe(`lane ${LANE} is held open: hand(s) dt-a unsettled after 2 continue prompts; it ends at a stop, the ceiling or the deadline`);
	});

	test("slice counts: open, paused and done; cancelled slices count as nothing", () => {
		const s = (id: string, state: string) => ({ id, state: state as "open", created_by: LANE });
		expect(sliceCounts([s("sl-a", "open"), s("sl-b", "paused"), s("sl-c", "done"), s("sl-d", "cancelled"), s("sl-e", "paused")])).toEqual({ open: 1, paused: 2, done: 1 });
	});
});

/** A workload `LANE` holds on a temp ledger, with one open slice. */
function held(): { ledger: Ledger; wl: string; sl: string } {
	const { ledger } = tempLedger();
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "turn end", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
	const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	return { ledger, wl, sl };
}

describe("turn end: the runner's writes and reads", () => {
	test("the pre-EOF death is enqueued once per lane, also for a workload already released, and never beside another death of the lane (T12, D5)", () => {
		const { ledger, wl } = held();
		expect(ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
		expect(ledger.releaseWorkload(wl, { by: LANE, holder: LANE }).released).toBe(true);
		expect(ledger.workload(wl)!.holder).toBeNull();
		const body = parkFailedDeathBody(LANE, "boom", 1);
		expect(enqueueRunnerDeath(ledger, { workloadId: wl, laneId: LANE, body })).not.toBeNull();
		expect(enqueueRunnerDeath(ledger, { workloadId: wl, laneId: LANE, body: openWorkDeathBody(LANE, 2) })).toBeNull();
		expect(laneDeaths(ledger, wl).map((d) => [d.holder, d.body, d.state])).toEqual([[LANE, body, "held"]]);
		// another lane's death does not stop this lane's
		expect(enqueueRunnerDeath(ledger, { workloadId: wl, laneId: "lane-t-2", body: openWorkDeathBody("lane-t-2", 2) })).not.toBeNull();
	});

	test("omp gone before a decision (review round 1, B1): this lane's released-open marker is open-work with the release's death line, whatever the holder; otherwise never-ready, died or released as before", () => {
		expect(exitOutcome(LANE, { ready: true, held: false, releasedOpen: 1 })).toEqual({ outcome: "open-work", death: `lane-died: ${LANE}: released with 1 open slice(s), no done-because` });
		expect(exitOutcome(LANE, { ready: true, held: false, releasedOpen: null })).toEqual({ outcome: "released", death: null });
		// a lane still holding died (finish() writes that death itself); one never ready is never-ready, marker or not
		expect(exitOutcome(LANE, { ready: true, held: true, releasedOpen: null })).toEqual({ outcome: "died", death: null });
		expect(exitOutcome(LANE, { ready: false, held: false, releasedOpen: 2 })).toEqual({ outcome: "never-ready", death: null });
		// the death is the one decideTurn would have enqueued for the same marker, so the laneDeaths guard keeps it single
		const marked = input({ held: false, releasedOpen: 1 }).i;
		expect(exitOutcome(LANE, { ready: true, held: false, releasedOpen: 1 }).death).toBe(turnEndDeathBody(LANE, turnEnd(marked), marked));
	});

	test("the released-open marker is read only from the lane it names, written by that lane as a holder", () => {
		const { ledger, wl } = held();
		ledger.recordEntry({ by: "lane-t-9", workloadId: wl, kind: "assumption", body: releasedOpenBody(LANE, 3) });
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: releasedOpenBody("lane-t-2", 4) });
		const control = () => {
			const entries = ledger.entries(wl);
			return controlEntries(entries, holdersOf(entries, null));
		};
		expect(releasedOpen(control(), LANE)).toBeNull();
		expect(releasedOpen(control(), "lane-t-2")).toBeNull();
		ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: releasedOpenBody(LANE, 2) });
		expect(releasedOpen(control(), LANE)).toBe(2);
	});

	test("D6: a hand counts as settled only with a routings row of this workload created at or after its spawn; another lane's hand is not this lane's", () => {
		const { ledger, wl, sl } = held();
		const spawn = (token: string, by = LANE) =>
			ledger.recordEntry({ by, workloadId: wl, sliceId: sl, kind: "assumption", body: handSpawnBody({ token, root: "/tmp/r", spawnKey: sl, review: true, group: `dg-${token}`, row: ["openai-codex/gpt-6-astra"] }) });
		const routing = (agentId: string) => ledger.recordRouting({
			by: LANE, workloadId: wl, sliceId: sl, spawnKey: sl, sessionRoot: "/tmp/r", agentId, kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 },
			classifiedTier: "strong", tier: "strong", models: ["openai-codex/gpt-6-astra"], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: ["openai-codex/gpt-6-astra"],
		});
		const settle = (token: string, routingId: string) => ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: handSettledBody(token, routingId) });
		const tokens = () => unsettledHands(ledger, wl, LANE).map((h) => h.token);

		const stale = routing("old-hand");
		Bun.sleepSync(3);
		spawn("dt-good");
		spawn("dt-bogus");
		spawn("dt-stale");
		spawn("dt-other", "lane-t-2");
		expect(unsettledHands(ledger, wl, LANE)).toEqual([{ token: "dt-good", job: sl }, { token: "dt-bogus", job: sl }, { token: "dt-stale", job: sl }]);
		settle("dt-good", routing("good-hand"));
		settle("dt-bogus", "rt-bogus");
		settle("dt-stale", stale);
		expect(tokens()).toEqual(["dt-bogus", "dt-stale"]);
	});
});

describe("recordDecision: the runner's decided outcome on the ledger before EOF (MIGRATION.md item 40, wl-mv049108m8whds)", () => {
	/** `LANE` holds a workload with one open slice on a temp ledger; `path` lets a test inject a sqlite trigger. */
	const decided = () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "record the decision", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
		ledger.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
		const sql = (statement: string) => {
			const db = new Database(path);
			db.exec(statement);
			db.close();
		};
		const question = () => ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: ledger.slices(wl)[0]!.id, body: "Which?", options: ["a", "b"] });
		const markers = () => ledger.entries(wl).filter((e) => e.body.startsWith("lane-decided:")).map((e) => [e.created_by, e.body]);
		const deaths = () => laneDeaths(ledger, wl).map((d) => d.body);
		return { ledger, wl, sql, question, markers, deaths };
	};

	test("completed: the marker the shutdown reads as intended, no death", () => {
		const { ledger, wl, markers, deaths } = decided();
		expect(recordDecision(ledger, { workloadId: wl, laneId: LANE, outcome: "completed", death: null, settled: true })).toEqual({ death: "none", marker: "written" });
		expect(markers()).toEqual([[LANE_RUNNER_BY, `lane-decided: ${LANE} completed`]]);
		const entries = ledger.entries(wl);
		expect(exitClass(controlEntries(entries, holdersOf(entries, LANE)), LANE)).toBe("intended");
		expect(deaths()).toEqual([]);
	});

	test("open-work whose death insert throws: no death, no marker; the kept body then reaches the ledger once through enqueueRunnerDeath, the finish() retry's contract (round 3, major 2)", () => {
		const { ledger, wl, sql, markers, deaths } = decided();
		const body = openWorkDeathBody(LANE, CONTINUE_LIMIT);
		sql("CREATE TRIGGER fail_death BEFORE INSERT ON messages WHEN NEW.body LIKE 'lane-died:%' BEGIN SELECT RAISE(ABORT, 'injected death failure'); END;");
		expect(recordDecision(ledger, { workloadId: wl, laneId: LANE, outcome: "open-work", death: body, settled: true })).toEqual({ death: "failed", marker: "none" });
		expect(markers()).toEqual([]);
		expect(deaths()).toEqual([]);
		expect(ledger.entries(wl).filter((e) => e.created_by === LANE_RUNNER_BY)).toEqual([]);
		sql("DROP TRIGGER fail_death;");
		expect(enqueueRunnerDeath(ledger, { workloadId: wl, laneId: LANE, body })).not.toBeNull();
		expect(enqueueRunnerDeath(ledger, { workloadId: wl, laneId: LANE, body })).toBeNull();
		expect(deaths()).toEqual([body]);
		// the decision recorded again finds its death present and still writes no marker
		expect(recordDecision(ledger, { workloadId: wl, laneId: LANE, outcome: "open-work", death: body, settled: true })).toEqual({ death: "present", marker: "none" });
	});

	test("a death decided while omp reported background work carries the background suffix", () => {
		const { ledger, wl, markers, deaths } = decided();
		const body = openWorkDeathBody(LANE, CONTINUE_LIMIT);
		expect(recordDecision(ledger, { workloadId: wl, laneId: LANE, outcome: "open-work", death: body, settled: false })).toEqual({ death: "written", marker: "none" });
		expect(deaths()).toEqual([`${body}${BACKGROUND_SUFFIX}`]);
		expect(markers()).toEqual([]);
	});

	test("parked: the marker, an open question stays open, no death", () => {
		const { ledger, wl, question, markers, deaths } = decided();
		const q = question();
		expect(recordDecision(ledger, { workloadId: wl, laneId: LANE, outcome: "parked", death: null, settled: true })).toEqual({ death: "none", marker: "written" });
		expect(ledger.question(q)!.state).toBe("open");
		expect(markers()).toEqual([[LANE_RUNNER_BY, `lane-decided: ${LANE} parked`]]);
		expect(deaths()).toEqual([]);
	});
});
