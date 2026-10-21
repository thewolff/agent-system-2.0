// PLAN wl-mvgn310dpi5gcg R2 (T2, T2b) as PLAN wl-mvidsu83epvpj4 D4 changes it: the lane starter refuses a reservation while an
// earlier lane's runner or omp on the workload is alive (`liveLaneOf` inside `reserve`'s transaction) unless that lane released
// itself (`selfReleased`, read from the holder history): a self-released lane's live pids are stale, and the process that
// spawns the next omp ends them first (`staleOmps`, `endStale`). A lane whose lease lapsed, that was taken over, or whose pids
// ps cannot answer for still refuses. A spawn whose reservation another starter took after its pre-claim lapsed spawns nothing
// (`spawnIfReserved`, D2b). Replays wl-mvggzumu8zs5xc, whose train lanes released (`released-open:`) and ran on for the settle
// wait: their next launch is now admitted, and the stale omp ended before the new one spawns.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, doneBody, laneExitBody, laneStartedBody, launchRequestedBody, PRECLAIM_LEASE_MS, STARTER_EXIT } from "../src/launch";
import type { PidState } from "../src/omp-probe";
import type { RankConfig } from "../src/rank-launch";
import { releasedOpenBody } from "../src/turn-end";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
// A namespace import, as lane-script.test.ts does: a name lane.ts does not export fails only the test that calls it.
import * as laneScript from "../scripts/lane";
import { LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, settleDrains, sh, tempLedger, until } from "./helpers";

const SHOW: RankConfig = { mode: "show", parallelBudgetUsd: 0 };
const OMP_START = "Mon Oct 20 11:00:00 2026";
const ompPid = (n: number) => 4100 + n;
const runnerPid = (n: number) => 4000 + n;

/** A fake probe factory: each call answers `answer` for its kind and records the lane, the pid and whether the ledger was inside a transaction. */
function fakeProbe(l: Ledger, answer: { omp: PidState; runner: PidState }) {
	const calls: { laneId: string; what: "omp" | "runner"; pid: number; inTransaction: boolean }[] = [];
	const probeFor = (laneId: string): laneScript.RunnerProbe => ({
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
 * The incident's shape: lanes 1 and 2 ended; lane-3 wrote `lane-started:`, then left the workload without a `lane-exit:` (its
 * runner waits out the settle); then the tick's unconsumed `launch-requested:`. `how` lane-3 left: `self`, its own
 * `released-open:` and release (the incident); `taken-over`, its lease lapsed and Jo claimed and released the workload.
 */
function incident(how: "self" | "taken-over" = "self") {
	const { ledger: l, path } = tempLedger();
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "train", stakes: "normal", mode: "autonomous" });
	attempt(l, wl, 1, true);
	attempt(l, wl, 2, true);
	let lane3: string;
	if (how === "self") {
		lane3 = attempt(l, wl, 3, false);
		l.recordEntry({ by: lane3, workloadId: wl, kind: "assumption", body: releasedOpenBody(lane3, 2) });
		l.releaseWorkload(wl, { by: lane3, holder: lane3 });
	} else {
		// lane-3 reserved by a handle whose clock is past the lease, so the lease has lapsed by now
		const past = new Date(Date.now() - 120_000).toISOString();
		const old = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => past });
		const r = old.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
		old.close();
		if (!r.ok) throw new Error(r.reason);
		lane3 = r.laneId;
		started(l, wl, lane3, 3);
		expect(l.claimWorkload(wl, { by: "orch-1", holder: "jo", leaseMs: null })).toEqual({ won: true });
		l.releaseWorkload(wl, { by: "orch-1", holder: "jo" });
	}
	const req = request(l, wl);
	expect(l.workload(wl)!.holder).toBeNull();
	return { l, path, wl, lane3, req };
}

describe("T2: reserve admits past a self-released lane, and refuses while another earlier lane's runner or omp lives", () => {
	test("the incident inverted: lane-3 released itself, its omp or runner alive (or unanswerable): admitted, consuming the request, with no probe at all", () => {
		for (const answer of [{ omp: "same", runner: "gone" }, { omp: "gone", runner: "same" }, { omp: "same", runner: "same" }, { omp: "failed", runner: "failed" }, { omp: "unknown", runner: "gone" }] as const) {
			const { l, wl, req } = incident("self");
			const p = fakeProbe(l, answer);
			expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: true, laneId: laneIdOf(wl, 4), cause: `request ${req}` });
			expect(launches(l, wl)[3]).toBe(`launch: ${laneIdOf(wl, 4)} cause request ${req} requested-by lane-runner`);
			expect(p.calls).toEqual([]);
		}
	});

	test("lane-3 taken over after its lease lapsed (not a self-release), its runner alive: held, no launch:, the request stays unconsumed, every probe inside the reservation's transaction", () => {
		const { l, wl, lane3, req } = incident("taken-over");
		const p = fakeProbe(l, { omp: "gone", runner: "same" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (runner pid ${runnerPid(3)})` });
		expect(launches(l, wl)).toHaveLength(3);
		expect(launches(l, wl).some((b) => b.includes(req))).toBe(false);
		expect(l.workload(wl)!.holder).toBeNull();
		// lanes 1 and 2 ended: only lane-3 is probed
		expect(p.calls.map((c) => [c.laneId, c.what, c.pid])).toEqual([[lane3, "omp", ompPid(3)], [lane3, "runner", runnerPid(3)]]);
		expect(p.calls.every((c) => c.inTransaction)).toBe(true);
	});

	test("taken over, lane-3's omp alive: held naming the omp pid", () => {
		const { l, wl, lane3 } = incident("taken-over");
		const p = fakeProbe(l, { omp: "same", runner: "gone" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (omp pid ${ompPid(3)})` });
		expect(launches(l, wl)).toHaveLength(3);
	});

	test("taken over, ps could not answer (failed, uninspected) or no start time to verify by (unknown, unverified): held", () => {
		for (const omp of ["failed", "unknown"] as const) {
			const { l, wl, lane3 } = incident("taken-over");
			const p = fakeProbe(l, { omp, runner: "gone" });
			expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (omp pid ${ompPid(3)})` });
			expect(launches(l, wl)).toHaveLength(3);
		}
		const { l, wl, lane3 } = incident("taken-over");
		const p = fakeProbe(l, { omp: "gone", runner: "failed" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: false, reason: `held: ${lane3} still running (runner pid ${runnerPid(3)})` });
	});

	test("taken over, lane-3 crashed (both pids gone, or reused): admitted, consuming the request", () => {
		for (const answer of ["gone", "other"] as const) {
			const { l, wl, req } = incident("taken-over");
			const p = fakeProbe(l, { omp: answer, runner: answer });
			expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: true, laneId: laneIdOf(wl, 4), cause: `request ${req}` });
			expect(launches(l, wl)[3]).toBe(`launch: ${laneIdOf(wl, 4)} cause request ${req} requested-by lane-runner`);
			expect(p.calls.length).toBeGreaterThan(0);
			expect(p.calls.every((c) => c.inTransaction)).toBe(true);
		}
	});

	test("after lane-3's lane-exit: admitted with no probe at all", () => {
		const { l, wl, lane3, req } = incident("taken-over");
		exited(l, wl, lane3);
		const p = fakeProbe(l, { omp: "same", runner: "same" });
		expect(laneScript.reserve(l, wl, "lane-runner", false, SHOW, p.probeFor)).toEqual({ ok: true, laneId: laneIdOf(wl, 4), cause: `request ${req}` });
		expect(p.calls).toEqual([]);
	});

	test("liveLaneOf: every lane with no lane-exit: that did not release itself is checked, newest first, and the first live one is named", () => {
		const { l, wl, lane3 } = incident("taken-over");
		const lane4 = laneIdOf(wl, 4);
		started(l, wl, lane4, 4, LANE_STARTER_BY);
		const control = controlEntries(l.entries(wl));
		const live = (answers: Record<string, PidState>, changes = l.holderChanges(wl)) =>
			laneScript.liveLaneOf(control, changes, (laneId) => ({ omp: () => answers[laneId] ?? "gone", runner: () => "gone" }));
		expect(live({ [lane3]: "same", [lane4]: "same" })).toEqual({ laneId: lane4, what: "omp", pid: ompPid(4) });
		expect(live({ [lane3]: "same" })).toEqual({ laneId: lane3, what: "omp", pid: ompPid(3) });
		expect(live({ [lane3]: "unknown" })).toEqual({ laneId: lane3, what: "omp", pid: ompPid(3), unverified: true });
		expect(live({})).toBeNull();
		// lane-4 released itself: skipped, so lane-3 is named
		const selfRelease = [...l.holderChanges(wl), { at: l.now(), from: null, to: lane4, by: lane4 }, { at: l.now(), from: lane4, to: null, by: lane4 }];
		expect(live({ [lane3]: "same", [lane4]: "same" }, selfRelease)).toEqual({ laneId: lane3, what: "omp", pid: ompPid(3) });
	});

	test("interactive (`as2 lane <wl>`): held while an earlier lane that did not release itself has a live omp, with no pick snapshot; admitted once it is gone", () => {
		const { ledger: l } = tempLedger();
		ensureStandingWorkload(l);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "by hand", stakes: "normal", mode: "user-driven" });
		const first = laneScript.reserve(l, wl, "jo", true, SHOW, fakeProbe(l, { omp: "same", runner: "same" }).probeFor);
		expect(first).toMatchObject({ ok: true, cause: "interactive" });
		const lane1 = first.ok ? first.laneId : "";
		started(l, wl, lane1, 1, LANE_STARTER_BY);
		// released by the starter (as `lane.ts stop` does), not by the lane: not a self-release
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

	test("interactive admits past a self-released lane whose omp is alive, the same way: a pick snapshot and launch:, no probe", () => {
		const { ledger: l } = tempLedger();
		ensureStandingWorkload(l);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "by hand", stakes: "normal", mode: "user-driven" });
		const first = laneScript.reserve(l, wl, "jo", true, SHOW, fakeProbe(l, { omp: "same", runner: "same" }).probeFor);
		const lane1 = first.ok ? first.laneId : "";
		started(l, wl, lane1, 1, LANE_STARTER_BY);
		l.releaseWorkload(wl, { by: lane1, holder: lane1 });
		const shown = () => l.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("rank-shown:")).length;
		const before = shown();
		const p = fakeProbe(l, { omp: "same", runner: "same" });
		expect(laneScript.reserve(l, wl, "jo", true, SHOW, p.probeFor)).toMatchObject({ ok: true, laneId: laneIdOf(wl, 2), cause: "interactive" });
		expect(p.calls).toEqual([]);
		expect(shown()).toBe(before + 1);
		expect(launches(l, wl)).toHaveLength(2);
	});
});

describe("D4: the stale set, read from the ledger", () => {
	test("staleOmps / staleOf name exactly the self-released lanes with no lane-exit:, each omp pid once, never the reader's own lane", () => {
		const { l, wl, lane3 } = incident("self");
		// lane-3's runner re-records lane-started: once omp names its session: the same pids, one stale omp
		started(l, wl, lane3, 3);
		// lane-4 holds and never released itself: not stale
		const lane4 = attempt(l, wl, 4, false);
		const stale = [{ laneId: lane3, pid: ompPid(3), start: OMP_START }];
		const control = controlEntries(l.entries(wl));
		expect(laneScript.staleOmps(control, l.holderChanges(wl), lane4)).toEqual(stale);
		expect(laneScript.staleOf(l, wl, lane4)).toEqual(stale);
		expect(laneScript.staleOf(l, wl, lane3)).toEqual([]);
		// lanes 1 and 2 exited, and so does lane-3 once its runner writes lane-exit:
		exited(l, wl, lane3);
		expect(laneScript.staleOf(l, wl, lane4)).toEqual([]);
	});

	test("a taken-over lane's live omp is not stale: it refuses instead", () => {
		const { l, wl } = incident("taken-over");
		expect(laneScript.staleOf(l, wl, laneIdOf(wl, 4))).toEqual([]);
	});
});

// Real processes and the real ps on purpose (D5): the waits below are endStale's own grace and deadline against the platform
// clock, kept short; no fake clock can stand in for a process ignoring SIGTERM.
describe("D4: endStale on real child processes", () => {
	/** A child to stand in for a stale omp: `sleep 60`, or one that ignores SIGTERM (an `exec`ed sleep keeps the ignored disposition). */
	const child = (ignoreTerm: boolean) => Bun.spawn(ignoreTerm ? ["sh", "-c", "trap '' TERM; exec sleep 60"] : ["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
	/** Each child is `sleep` itself (the shell's trap set and exec'd), with its ps start time as a lane-started: records it. */
	const staleFor = async (cs: { pid: number }[]) => {
		for (const c of cs) {
			await until(`pid ${c.pid} exec'd sleep`, () => /^(\S*\/)?sleep\b/.test(Bun.spawnSync(["ps", "-p", String(c.pid), "-o", "command="]).stdout.toString().trim()), 5_000);
		}
		return cs.map((c, i) => ({ laneId: `lane-${i}`, pid: c.pid, start: laneScript.startTime(c.pid)! }));
	};
	const killer = () => {
		const calls: [number, string][] = [];
		return { calls, kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
			calls.push([pid, signal]);
			process.kill(pid, signal);
		} };
	};

	test("a matching start time is ended: SIGTERM, then SIGKILL after the grace for one that ignores TERM", async () => {
		const a = child(false);
		const b = child(true);
		const stale = await staleFor([a, b]);
		const k = killer();
		const logs: string[] = [];
		const left = await laneScript.endStale(stale, { kill: k.kill, log: (x) => logs.push(x), graceMs: 500, deadlineMs: 10_000, pollMs: 50 });
		expect(left).toEqual([]);
		await Promise.all([a.exited, b.exited]);
		expect(a.signalCode).toBe("SIGTERM");
		expect(b.signalCode).toBe("SIGKILL");
		expect(k.calls).toEqual([[a.pid, "SIGTERM"], [b.pid, "SIGTERM"], [b.pid, "SIGKILL"]]);
		expect(logs).toEqual([]);
	}, 20_000);

	test("a mismatching start time (a reused pid) is never signalled", async () => {
		const a = child(false);
		try {
			await staleFor([a]);
			const k = killer();
			const left = await laneScript.endStale([{ laneId: "lane-a", pid: a.pid, start: "Mon Jan  1 00:00:00 2001" }], { kill: k.kill, log: () => undefined, graceMs: 200, deadlineMs: 2_000, pollMs: 50 });
			expect(left).toEqual([]);
			expect(k.calls).toEqual([]);
			expect(a.exitCode).toBeNull();
			expect(a.signalCode).toBeNull();
		} finally {
			a.kill("SIGKILL");
		}
	});

	test("a failing ps probe is reported, never thrown, and never signalled", async () => {
		const k = killer();
		const logs: string[] = [];
		const run = () => {
			throw new Error("ps: operation not permitted");
		};
		const left = await laneScript.endStale([{ laneId: "lane-a", pid: 999_999, start: OMP_START }], { run, kill: k.kill, log: (x) => logs.push(x), graceMs: 100, deadlineMs: 400, pollMs: 50 });
		expect(left).toEqual([{ laneId: "lane-a", pid: 999_999, start: OMP_START }]);
		expect(k.calls).toEqual([]);
		expect(logs.some((x) => x.includes("lane-a omp pid 999999: ps failed: ps: operation not permitted"))).toBe(true);
	});

	test("three stale omps that all ignore TERM: SIGKILL at the one aggregate deadline, returned within it plus one ps bound", async () => {
		const cs = [child(true), child(true), child(true)];
		const stale = await staleFor(cs);
		const k = killer();
		const deadlineMs = 1_500;
		const t0 = Date.now();
		await laneScript.endStale(stale, { kill: k.kill, log: () => undefined, graceMs: 60_000, deadlineMs, pollMs: 100 });
		const ms = Date.now() - t0;
		expect(ms).toBeGreaterThanOrEqual(deadlineMs);
		expect(ms).toBeLessThan(deadlineMs + 10_000);
		await Promise.all(cs.map((c) => c.exited));
		expect(cs.map((c) => c.signalCode)).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
		expect(k.calls.filter(([, s]) => s === "SIGKILL").map(([pid]) => pid).sort()).toEqual(cs.map((c) => c.pid).sort());
	}, 20_000);

	// Review sl-review-exit: a slow probe of one pid crosses the grace after another pid's omp exited and its number was
	// reused; the escalation must re-probe that pid, not SIGKILL it on the match its earlier probe cached. Simulated pids
	// and a recording kill: no real process is signalled.
	test("a pid reused while another pid's slow probe crosses the grace is not SIGKILLed", async () => {
		const calls: [number, string][] = [];
		let reused = false;
		let slowProbes = 0;
		const run = (args: string[]) => {
			const pid = Number(args[1]);
			if (pid === 102 && ++slowProbes === 2) {
				Bun.sleepSync(300);
				reused = true;
			}
			const start = pid === 101 && reused ? "Tue Oct 21 12:00:00 2026" : OMP_START;
			return { exitCode: 0, stdout: `S ${start}\n`, stderr: "" };
		};
		const stale = [{ laneId: "lane-a", pid: 101, start: OMP_START }, { laneId: "lane-b", pid: 102, start: OMP_START }];
		await laneScript.endStale(stale, { run, kill: (pid, sig) => calls.push([pid, sig]), log: () => undefined, graceMs: 100, deadlineMs: 800, pollMs: 50 });
		expect(calls.filter(([pid]) => pid === 101)).toEqual([[101, "SIGTERM"]]);
		expect(calls.filter(([pid]) => pid === 102).slice(0, 2)).toEqual([[102, "SIGTERM"], [102, "SIGKILL"]]);
	});

	// Review sl-review-exit r2: the SIGKILL pass probes under the same aggregate deadline as every other pass, so slow
	// probes of many pids end at the deadline plus one probe, not one probe per pid past it. Simulated pids.
	test("ten slow-probing stale omps: endStale returns by the deadline plus one probe", async () => {
		const run = () => {
			Bun.sleepSync(50);
			return { exitCode: 0, stdout: `S ${OMP_START}\n`, stderr: "" };
		};
		const stale = Array.from({ length: 10 }, (_, i) => ({ laneId: `lane-${i}`, pid: 200 + i, start: OMP_START }));
		const t0 = Date.now();
		const left = await laneScript.endStale(stale, { run, kill: () => undefined, log: () => undefined, graceMs: 100, deadlineMs: 300, pollMs: 50 });
		const ms = Date.now() - t0;
		expect(ms).toBeLessThan(300 + 50 + 150);
		expect(left.length).toBeGreaterThan(0);
	});

	// Review sl-review-exit r2: a pid whose probes failed at first gets its SIGTERM late; its SIGKILL waits its own grace.
	test("a pid first seen after the others' grace still gets its own grace between SIGTERM and SIGKILL", async () => {
		const calls: [string, number][] = [];
		const t0 = Date.now();
		const run = () => {
			if (Date.now() - t0 < 400) throw new Error("ps: temporarily unavailable");
			return { exitCode: 0, stdout: `S ${OMP_START}\n`, stderr: "" };
		};
		await laneScript.endStale([{ laneId: "lane-a", pid: 301, start: OMP_START }], { run, kill: (_pid, sig) => calls.push([sig, Date.now()]), log: () => undefined, graceMs: 300, deadlineMs: 2_000, pollMs: 50 });
		const term = calls.find(([s]) => s === "SIGTERM")?.[1];
		const killAt = calls.find(([s]) => s === "SIGKILL")?.[1];
		expect(term).toBeDefined();
		expect(killAt).toBeDefined();
		expect(killAt! - term!).toBeGreaterThanOrEqual(300);
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
