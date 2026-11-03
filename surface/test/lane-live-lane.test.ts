// PLAN wl-mvgn310dpi5gcg R2 (T2, T2b): the lane starter refuses a reservation while an earlier lane's runner or omp on the
// workload is alive, released or not (`liveLaneOf` inside `reserve`'s transaction, D2), and a spawn whose reservation
// another starter took after its pre-claim lapsed spawns nothing (`spawnIfReserved`, D2b). Replays wl-mvggzumu8zs5xc, whose
// train lanes released (`released-open:`) and ran on for the settle wait while the next request launched beside them.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, doneBody, laneCap, laneExitBody, laneStartedBody, launchFailedBody, launchRequestedBody, PRECLAIM_LEASE_MS, STARTER_EXIT } from "../src/launch";
import { applyTrain, interpret } from "../src/input";
import { theTrain, TRAIN_DONE, trainBody, trainBrief, trainInstructionBody } from "../src/merge-train";
import type { PidState } from "../src/omp-probe";
import type { RankConfig } from "../src/rank-launch";
import type { RunnerProbe } from "../src/runner-probe";
import { releasedOpenBody } from "../src/turn-end";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
// A namespace import, as lane-script.test.ts does: a name lane.ts does not export fails only the test that calls it.
import * as laneScript from "../scripts/lane";
import { LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, settleDrains, sh, tempLedger, tmp } from "./helpers";

const SHOW: RankConfig = { mode: "show", parallelBudgetUsd: 0 };
const OMP_START = "Mon Oct 20 11:00:00 2026";
const ompPid = (n: number) => 4100 + n;
const runnerPid = (n: number) => 4000 + n;

/** A fake probe factory: each call answers `answer` for its kind and records the lane, the pid and whether the ledger was inside a transaction. */
function fakeProbe(l: Ledger, answer: { omp: PidState; runner: PidState }) {
	const calls: { laneId: string; what: "omp" | "runner"; pid: number; inTransaction: boolean }[] = [];
	const probeFor = (laneId: string): RunnerProbe => ({
		omp: (pid) => {
			calls.push({ laneId, what: "omp", pid, inTransaction: l.db.inTransaction });
			return answer.omp;
		},
		runner: (pid) => {
			calls.push({ laneId, what: "runner", pid, inTransaction: l.db.inTransaction });
			return answer.runner;
		},
	});
	return { calls, probeFor };
}

const started = (l: Ledger, wl: string, laneId: string, n: number, by = LANE_RUNNER_BY) =>
	l.recordEntry({ by, workloadId: wl, kind: "assumption", body: laneStartedBody(laneId, { pid: ompPid(n), start: OMP_START, session: null, argv: [], runnerPid: runnerPid(n) }) });
const exited = (l: Ledger, wl: string, laneId: string, by = LANE_RUNNER_BY) =>
	l.recordEntry({ by, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: 0, signal: null, outcome: "completed" }) });
const request = (l: Ledger, wl: string) => l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("merge-train", l.now()) });
const launches = (l: Ledger, wl: string) => l.entries(wl, "assumption").filter((e) => e.created_by === LANE_STARTER_BY && e.body.startsWith("launch: ")).map((e) => e.body);

/** One attempt as `reserveLane` writes it, its runner's `lane-started:`, and, when `exit`, its release and `lane-exit:`. */
function attempt(l: Ledger, wl: string, n: number, exit: boolean): string {
	const r = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
	if (!r.ok) throw new Error(r.reason);
	expect(r.laneId).toBe(laneIdOf(wl, n));
	started(l, wl, r.laneId, n);
	if (exit) {
		l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: r.laneId });
		exited(l, wl, r.laneId);
	}
	return r.laneId;
}

/**
 * The incident's shape: lanes 1 and 2 ended; lane-3 wrote `lane-started:`, then `released-open:` with its release (holder
 * null, lease gone) and no `lane-exit:` (its runner waits out the settle); then the tick's unconsumed `launch-requested:`.
 */
function incident() {
	const { ledger: l, path } = tempLedger();
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "train", stakes: "normal", mode: "autonomous" });
	attempt(l, wl, 1, true);
	attempt(l, wl, 2, true);
	const lane3 = attempt(l, wl, 3, false);
	l.recordEntry({ by: lane3, workloadId: wl, kind: "assumption", body: releasedOpenBody(lane3, 2) });
	l.releaseWorkload(wl, { by: lane3, holder: lane3 });
	const req = request(l, wl);
	expect(l.workload(wl)!.holder).toBeNull();
	return { l, path, wl, lane3, req };
}

describe("T2: reserve refuses while an earlier lane's runner or omp lives", () => {
	test("lane-3's runner alive after its release: held, no launch:, the request stays unconsumed, every probe inside the reservation's transaction", () => {
		const { l, wl, lane3, req } = incident();
		const p = fakeProbe(l, { omp: "gone", runner: "same" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (runner pid ${runnerPid(3)})` });
		expect(launches(l, wl)).toHaveLength(3);
		expect(launches(l, wl).some((b) => b.includes(req))).toBe(false);
		expect(l.workload(wl)!.holder).toBeNull();
		// lanes 1 and 2 ended: only lane-3 is probed
		expect(p.calls.map((c) => [c.laneId, c.what, c.pid])).toEqual([[lane3, "omp", ompPid(3)], [lane3, "runner", runnerPid(3)]]);
		expect(p.calls.every((c) => c.inTransaction)).toBe(true);
	});

	test("lane-3's omp alive: held naming the omp pid", () => {
		const { l, wl, lane3 } = incident();
		const p = fakeProbe(l, { omp: "same", runner: "gone" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (omp pid ${ompPid(3)})` });
		expect(launches(l, wl)).toHaveLength(3);
	});

	test("ps could not answer (failed, uninspected) or no start time to verify by (unknown, unverified): held", () => {
		for (const omp of ["failed", "unknown"] as const) {
			const { l, wl, lane3 } = incident();
			const p = fakeProbe(l, { omp, runner: "gone" });
			expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (omp pid ${ompPid(3)})` });
			expect(launches(l, wl)).toHaveLength(3);
		}
		const { l, wl, lane3 } = incident();
		const p = fakeProbe(l, { omp: "gone", runner: "failed" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (runner pid ${runnerPid(3)})` });
	});

	test("lane-3 crashed (both pids gone, or reused): admitted, consuming the request", () => {
		for (const answer of ["gone", "other"] as const) {
			const { l, wl, req } = incident();
			const p = fakeProbe(l, { omp: answer, runner: answer });
			expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: true, laneId: laneIdOf(wl, 4), cause: `request ${req}` });
			expect(launches(l, wl)[3]).toBe(`launch: ${laneIdOf(wl, 4)} cause request ${req} requested-by lane-runner`);
			expect(p.calls.length).toBeGreaterThan(0);
			expect(p.calls.every((c) => c.inTransaction)).toBe(true);
		}
	});

	test("after lane-3's lane-exit: admitted with no probe at all", () => {
		const { l, wl, lane3, req } = incident();
		exited(l, wl, lane3);
		const p = fakeProbe(l, { omp: "same", runner: "same" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: true, laneId: laneIdOf(wl, 4), cause: `request ${req}` });
		expect(p.calls).toEqual([]);
	});

	test("liveLaneOf: every lane with no lane-exit: is checked, newest first, and the first live one is named", () => {
		const { l, wl, lane3 } = incident();
		const lane4 = laneIdOf(wl, 4);
		started(l, wl, lane4, 4, LANE_STARTER_BY);
		const control = controlEntries(l.entries(wl));
		const live = (answers: Record<string, PidState>) =>
			laneScript.liveLaneOf(control, (laneId) => ({ omp: () => answers[laneId] ?? "gone", runner: () => "gone" }));
		expect(live({ [lane3]: "same", [lane4]: "same" })).toEqual({ laneId: lane4, what: "omp", pid: ompPid(4) });
		expect(live({ [lane3]: "same" })).toEqual({ laneId: lane3, what: "omp", pid: ompPid(3) });
		expect(live({ [lane3]: "unknown" })).toEqual({ laneId: lane3, what: "omp", pid: ompPid(3), unverified: true });
		expect(live({})).toBeNull();
	});

	test("interactive (`as2 lane <wl>`): held while an earlier lane's omp lives, with no pick snapshot; admitted once it is gone", () => {
		const { ledger: l } = tempLedger();
		ensureStandingWorkload(l);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "by hand", stakes: "normal", mode: "user-driven" });
		const first = laneScript.reserve(l, wl, "jo", true, SHOW, fakeProbe(l, { omp: "same", runner: "same" }).probeFor);
		expect(first).toMatchObject({ ok: true, cause: "interactive" });
		const lane1 = first.ok ? first.laneId : "";
		started(l, wl, lane1, 1, LANE_STARTER_BY);
		l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: lane1 });
		const shown = () => l.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("rank-shown:")).length;
		const before = shown();
		const p = fakeProbe(l, { omp: "same", runner: "gone" });
		expect(laneScript.reserve(l, wl, "jo", true, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane1} still running (omp pid ${ompPid(1)})` });
		expect(p.calls.every((c) => c.inTransaction)).toBe(true);
		expect(shown()).toBe(before);
		expect(launches(l, wl)).toHaveLength(1);
		expect(laneScript.reserve(l, wl, "jo", true, SHOW, fakeProbe(l, { omp: "gone", runner: "gone" }).probeFor)).toMatchObject({ ok: true, laneId: laneIdOf(wl, 2) });
	});
});

// ---- the starter as the process it is: the real probe, the exit code ------------------------------------------------

const roots: LaneRoot[] = [];
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

describe("T2: `lane.ts launch` against a live omp", () => {
	test("an unexited lane whose omp pid is alive: exit 7 (held), nothing written", () => {
		const r = laneRoot();
		roots.push(r);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "live omp probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		const res = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
		if (!res.ok) throw new Error(res.reason);
		// This test process stands in for lane-1's omp, recorded as an interactive lane's starter records it: alive, with no start
		// time, so the starter's real probe cannot tell it from lane-1's omp (unverified; uninspected where ps cannot answer).
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(res.laneId, { pid: process.pid, start: "", session: null, argv: [], runnerPid: 0 }) });
		l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: res.laneId });
		request(l, wl);
		const entries = l.entries(wl).length;
		l.close();
		const x = sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "lane-runner"], r.repo, r.env);
		const after = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		try {
			expect(x.err).toContain(`held: ${res.laneId} still running (omp pid ${process.pid})`);
			expect(x.code).toBe(STARTER_EXIT.held!);
			expect(after.entries(wl).length).toBe(entries);
			expect(after.workload(wl)!.holder).toBeNull();
		} finally {
			// The stand-in lane ends here; a starter-written lane has no drain for the root's settle (afterAll) to wait on.
			exited(after, wl, res.laneId, LANE_STARTER_BY);
			after.close();
		}
	});
});

describe("T2b: a spawn whose reservation another starter took spawns nothing", () => {
	/** Lanes 1-3 ended and an unconsumed request; starter A's handle runs a clock past its own pre-claim lease. */
	function lapsedA() {
		const { ledger: l, path } = tempLedger();
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "train", stakes: "normal", mode: "autonomous" });
		for (const n of [1, 2, 3]) attempt(l, wl, n, true);
		request(l, wl);
		const past = new Date(Date.now() - PRECLAIM_LEASE_MS - 60_000).toISOString();
		const a = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => past });
		const p = fakeProbe(l, { omp: "same", runner: "same" });
		const ra = laneScript.reserve(a, wl, "tick", false, SHOW, p.probeFor);
		a.close();
		expect(ra).toMatchObject({ ok: true, laneId: laneIdOf(wl, 4) });
		// lanes 1-3 exited: nothing to probe
		expect(p.calls).toEqual([]);
		const w = l.workload(wl)!;
		expect(w.holder).toBe(laneIdOf(wl, 4));
		expect(Date.parse(w.holder_lease_until!)).toBeLessThan(Date.now());
		return { l, wl, laneA: laneIdOf(wl, 4) };
	}
	const owns = { owns: () => true };

	test("B reserves lane-5 after A's lease lapsed: A's spawn write refuses (held, stage reserve) and its spawn is never called; B's passes", () => {
		const { l, wl, laneA } = lapsedA();
		// the lapsed lease with the holder unchanged still passes
		expect(laneScript.stillReserved(l.workload(wl), laneA)).toBe(true);
		const req = request(l, wl);
		const p = fakeProbe(l, { omp: "same", runner: "same" });
		const laneB = laneIdOf(wl, 5);
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: true, laneId: laneB, cause: `request ${req}` });
		expect(l.workload(wl)!.holder).toBe(laneB);
		expect(laneScript.stillReserved(l.workload(wl), laneA)).toBe(false);
		const spawned: string[] = [];
		let err: unknown = null;
		try {
			laneScript.startAsOwner(l, owns, () => laneScript.spawnIfReserved(l, wl, laneA, null, () => spawned.push(laneA)));
		} catch (e) {
			err = e;
		}
		expect(err).toMatchObject({ stage: "reserve", code: STARTER_EXIT.held });
		expect((err as Error).message).toContain(`held: ${wl} is held by ${laneB}, not ${laneA}`);
		expect(spawned).toEqual([]);
		expect(laneScript.startAsOwner(l, owns, () => laneScript.spawnIfReserved(l, wl, laneB, null, () => {
			spawned.push(laneB);
			return "omp-B";
		}))).toBe("omp-B");
		expect(spawned).toEqual([laneB]);
		// a busy-retried write passes the child it already spawned: no second spawn, whatever the holder now is
		expect(laneScript.spawnIfReserved(l, wl, laneA, "omp-A", () => "second")).toBe("omp-A");
	});

	test("A's spawn write first: its lane-started: lands with the spawn, and B's reservation then probes lane-4 live and is held", () => {
		const { l, wl, laneA } = lapsedA();
		const omp = laneScript.startAsOwner(l, owns, () => {
			const c = laneScript.spawnIfReserved(l, wl, laneA, null, () => "omp-A");
			started(l, wl, laneA, 4);
			return c;
		});
		expect(omp).toBe("omp-A");
		request(l, wl);
		const p = fakeProbe(l, { omp: "same", runner: "same" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${laneA} still running (omp pid ${ompPid(4)})` });
		expect(l.workload(wl)!.holder).toBe(laneA);
		expect(launches(l, wl)).toHaveLength(4);
	});
});

// ---- PLAN wl-mvpsrr4tr0p1xc: the train's lane outside the cap (D1), one train lane at a time (D3), the launch limit (D4) ----

/**
 * A merge train on `l` (its own temp checkout, so two trains never share a PR's repo): with none open, as Jo's `train <pr>`
 * word opens it; with one open, a stale second train built from the rows the word wrote before the one-train cutover (PLAN
 * wl-mvr888nftz0vcl D2: the word appends to the open train now), as one left open from before it would be.
 */
function openTrainOn(l: Ledger, pr: number, repo = tmp("train-repo")): string {
	if (theTrain(l) === null) {
		const cmd = interpret(l, `train ${pr}`);
		if (cmd?.kind !== "train") throw new Error(`not a train: ${JSON.stringify(cmd)}`);
		return applyTrain(l, cmd, repo).workloadId;
	}
	return l.write(() => {
		const id = l.openWorkload({ by: SURFACE_BY, brief: trainBrief("wl-stale", [pr]), stakes: "normal", mode: "autonomous" });
		recordRepo(l, id, repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: doneBody(TRAIN_DONE) });
		const ins = l.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: id, body: trainInstructionBody(id, [pr]) });
		l.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: trainBody([pr], ins) });
		return id;
	});
}
/** A train attempt that failed before readiness: reserved, `launch-failed:` and released, as the starter's failure path leaves it. */
function failedLaunch(l: Ledger, wl: string): string {
	const r = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
	if (!r.ok) throw new Error(r.reason);
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: launchFailedBody(r.laneId, "spawn", "omp exited 1") });
	l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: r.laneId });
	return r.laneId;
}
const joRequest = (l: Ledger, wl: string) => l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", l.now()) });
const limitReason = (lanes: string[]) => `not-launchable: train launch limit: 3 consecutive failed launches (${lanes.join(", ")})`;

describe("D1: the open train's lane is outside the lane cap", () => {
	test("with the cap full of ordinary lanes the train is admitted, and its live lane takes no slot from an ordinary workload", () => {
		const { ledger: l } = tempLedger();
		const gone = fakeProbe(l, { omp: "gone", runner: "gone" }).probeFor;
		const busy = Array.from({ length: laneCap(process.env) }, (_, i) => {
			const wl = l.openWorkload({ by: SURFACE_BY, brief: `busy ${i}`, stakes: "normal", mode: "autonomous" });
			attempt(l, wl, 1, false);
			return wl;
		});
		const next = l.openWorkload({ by: SURFACE_BY, brief: "next", stakes: "normal", mode: "autonomous" });
		expect(laneScript.reserve(l, next, "test", false, SHOW, gone)).toEqual({ ok: false, reason: "cap" });
		const train = openTrainOn(l, 101);
		expect(laneScript.reserve(l, train, "test", false, SHOW, gone)).toMatchObject({ ok: true, laneId: laneIdOf(train, 1) });
		expect(l.workload(train)!.holder).toBe(laneIdOf(train, 1));
		// one ordinary lane ends: its slot goes to the next ordinary workload although the train's lane is live
		l.releaseWorkload(busy[0]!, { by: LANE_STARTER_BY, holder: laneIdOf(busy[0]!, 1) });
		expect(laneScript.reserve(l, next, "test", false, SHOW, gone)).toMatchObject({ ok: true, laneId: laneIdOf(next, 1) });
	});
});

describe("D3: never two train lanes at once", () => {
	const owns = { owns: () => true };

	test("at reservation, both policies: another train's live pre-claim, then its pending attempt, holds the train (`held: train lane …`), nothing written; its launch-failed: frees it", () => {
		const { ledger: l } = tempLedger();
		ensureStandingWorkload(l);
		const a = openTrainOn(l, 101);
		const b = openTrainOn(l, 102);
		// the interactive policy (`as2 lane <wl>`) runs on a user-driven workload: a train flipped by rows. Rewritten for PLAN
		// wl-mvr888nftz0vcl D5: the train runs autonomous only, so the by-hand start is refused `train-autonomous` before the hold.
		const byHand = openTrainOn(l, 103);
		l.flipMode(byHand, { by: SURFACE_BY, mode: "user-driven", author: "jo", channel: "surface" });
		const gone = fakeProbe(l, { omp: "gone", runner: "gone" }).probeFor;
		expect(laneScript.reserve(l, a, "tick", false, SHOW, gone)).toMatchObject({ ok: true, laneId: laneIdOf(a, 1) });
		const laneA = laneIdOf(a, 1);
		const held = { ok: false, reason: `held: train lane ${laneA} live on ${a}` };
		const before = l.entries(b).length;
		const shown = l.entries(STANDING_WORKLOAD_ID).length;
		expect(laneScript.reserve(l, b, "tick", false, SHOW, gone)).toEqual(held);
		expect(laneScript.reserve(l, byHand, "jo", true, SHOW, gone)).toEqual({ ok: false, reason: "train-autonomous" });
		expect(l.entries(b).length).toBe(before);
		expect(l.entries(byHand).filter((e) => e.body.startsWith("launch: "))).toEqual([]);
		// no pick snapshot for the refused interactive start
		expect(l.entries(STANDING_WORKLOAD_ID).length).toBe(shown);
		expect(l.workload(b)!.holder).toBeNull();
		expect(l.workload(byHand)!.holder).toBeNull();
		// A's starter let go before any lane-started: the attempt is pending until its pre-claim window ends
		l.releaseWorkload(a, { by: LANE_STARTER_BY, holder: laneA });
		expect(laneScript.reserve(l, b, "tick", false, SHOW, gone)).toEqual(held);
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: a, kind: "assumption", body: launchFailedBody(laneA, "spawn", "omp exited 1") });
		expect(laneScript.reserve(l, b, "tick", false, SHOW, gone)).toMatchObject({ ok: true, laneId: laneIdOf(b, 1) });
	});

	test("at reservation: a released train lane whose runner still lives holds another train, probed inside the transaction; an ordinary workload is never held by it", () => {
		const { ledger: l } = tempLedger();
		const a = openTrainOn(l, 101);
		const b = openTrainOn(l, 102);
		const ordinary = l.openWorkload({ by: SURFACE_BY, brief: "ordinary", stakes: "normal", mode: "autonomous" });
		const laneA = attempt(l, a, 1, false);
		l.releaseWorkload(a, { by: laneA, holder: laneA });
		const live = fakeProbe(l, { omp: "gone", runner: "same" });
		expect(laneScript.reserve(l, b, "tick", false, SHOW, live.probeFor)).toEqual({ ok: false, reason: `held: train lane ${laneA} live on ${a}` });
		expect(live.calls.map((c) => [c.laneId, c.what])).toEqual([[laneA, "omp"], [laneA, "runner"]]);
		expect(live.calls.every((c) => c.inTransaction)).toBe(true);
		expect(laneScript.reserve(l, ordinary, "tick", false, SHOW, live.probeFor)).toMatchObject({ ok: true, laneId: laneIdOf(ordinary, 1) });
		expect(laneScript.reserve(l, b, "tick", false, SHOW, fakeProbe(l, { omp: "gone", runner: "gone" }).probeFor)).toMatchObject({ ok: true, laneId: laneIdOf(b, 1) });
	});

	test("at spawn: train A's pre-claim lapsed, train B reserved and started meanwhile; A's spawn write refuses (held, stage reserve) and spawns nothing until B's lane is gone", () => {
		const { ledger: l, path } = tempLedger();
		const a = openTrainOn(l, 101);
		const b = openTrainOn(l, 102);
		const gone = fakeProbe(l, { omp: "gone", runner: "gone" }).probeFor;
		const past = new Date(Date.now() - PRECLAIM_LEASE_MS - 60_000).toISOString();
		const old = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => past });
		expect(laneScript.reserve(old, a, "tick", false, SHOW, gone)).toMatchObject({ ok: true, laneId: laneIdOf(a, 1) });
		old.close();
		const laneA = laneIdOf(a, 1);
		const laneB = laneIdOf(b, 1);
		expect(laneScript.reserve(l, b, "tick", false, SHOW, gone)).toMatchObject({ ok: true, laneId: laneB });
		expect(laneScript.startAsOwner(l, owns, () => {
			const c = laneScript.spawnIfReserved(l, b, laneB, null, () => "omp-B", gone);
			started(l, b, laneB, 1);
			return c;
		})).toBe("omp-B");
		const spawned: string[] = [];
		const spawnA = (probeFor: (laneId: string) => RunnerProbe) => {
			try {
				return laneScript.startAsOwner(l, owns, () => laneScript.spawnIfReserved(l, a, laneA, null, () => {
					spawned.push(laneA);
					return "omp-A";
				}, probeFor));
			} catch (e) {
				return e;
			}
		};
		// B's pre-claim lease is live
		expect(spawnA(gone)).toMatchObject({ stage: "reserve", code: STARTER_EXIT.held, message: expect.stringContaining(`held: train lane ${laneB} live on ${b}`) });
		// B released, its runner still alive: the probe holds A
		l.releaseWorkload(b, { by: laneB, holder: laneB });
		expect(spawnA(fakeProbe(l, { omp: "same", runner: "gone" }).probeFor)).toMatchObject({ stage: "reserve", code: STARTER_EXIT.held });
		expect(spawned).toEqual([]);
		expect(spawnA(gone)).toBe("omp-A");
		expect(spawned).toEqual([laneA]);
	});
});

describe("D4: the train launch limit binds the reservation", () => {
	test("after three consecutive failed launches every cause is refused `not-launchable: train launch limit…`, nothing written; Jo's fresh launch word resets the count", () => {
		const { ledger: l } = tempLedger();
		const t = openTrainOn(l, 101);
		const gone = fakeProbe(l, { omp: "gone", runner: "gone" }).probeFor;
		const lanes = [failedLaunch(l, t), failedLaunch(l, t)];
		request(l, t);
		// two failures: still admitted
		const third = laneScript.reserve(l, t, "tick", false, SHOW, gone);
		expect(third).toMatchObject({ ok: true, laneId: laneIdOf(t, 3) });
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: t, kind: "assumption", body: launchFailedBody(laneIdOf(t, 3), "spawn", "omp exited 1") });
		l.releaseWorkload(t, { by: LANE_STARTER_BY, holder: laneIdOf(t, 3) });
		lanes.push(laneIdOf(t, 3));
		request(l, t);
		const n = l.entries(t).length;
		expect(laneScript.reserve(l, t, "tick", false, SHOW, gone)).toEqual({ ok: false, reason: limitReason(lanes) });
		// the interactive policy on a train flipped to user-driven: refused too, by D5's `train-autonomous` (PLAN wl-mvr888nftz0vcl,
		// rewritten from "the same refusal"), nothing written
		l.flipMode(t, { by: SURFACE_BY, mode: "user-driven", author: "jo", channel: "surface" });
		expect(laneScript.reserve(l, t, "jo", true, SHOW, gone)).toEqual({ ok: false, reason: "train-autonomous" });
		l.flipMode(t, { by: SURFACE_BY, mode: "autonomous", author: "jo", channel: "surface" });
		expect(l.entries(t).length).toBe(n);
		expect(l.workload(t)!.holder).toBeNull();
		joRequest(l, t);
		const r = laneScript.reserve(l, t, "lane-runner", false, SHOW, gone);
		expect(r).toMatchObject({ ok: true, laneId: laneIdOf(t, 4) });
		expect(r.ok && r.cause).toStartWith("request ");
	});

	test("an ordinary workload has no launch limit", () => {
		const { ledger: l } = tempLedger();
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "ordinary", stakes: "normal", mode: "autonomous" });
		for (let i = 0; i < 4; i++) failedLaunch(l, wl);
		request(l, wl);
		expect(laneScript.reserve(l, wl, "tick", false, SHOW, fakeProbe(l, { omp: "gone", runner: "gone" }).probeFor)).toMatchObject({ ok: true, laneId: laneIdOf(wl, 5) });
	});

	test("`lane.ts launch` at the limit: exit 10 (not-launchable) naming the limit and the lanes, nothing written", () => {
		const r = laneRoot();
		roots.push(r);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		const t = openTrainOn(l, 101, r.repo);
		const lanes = [failedLaunch(l, t), failedLaunch(l, t), failedLaunch(l, t)];
		request(l, t);
		const entries = l.entries(t).length;
		l.close();
		const x = sh(["bun", LANE_SCRIPT, "launch", t, "--requested-by", "lane-runner"], r.repo, r.env);
		const after = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		try {
			expect(x.err).toContain(limitReason(lanes));
			expect(x.code).toBe(STARTER_EXIT["not-launchable"]!);
			expect(after.entries(t).length).toBe(entries);
			expect(after.workload(t)!.holder).toBeNull();
		} finally {
			after.close();
		}
	});
});
