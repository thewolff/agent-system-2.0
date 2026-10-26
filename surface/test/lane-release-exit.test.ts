// PLAN wl-mvidsu83epvpj4 (jo-issues#184, agent-system-2.0#283): a lane that released itself, or whose holder's
// done-because: stands, is ended by its runner at once — stdin EOF, SIGTERM after the shutdown grace, SIGKILL after the end
// grace — and `lane-exit:` follows; the next launch proceeds, and the process that spawns the next omp ends a self-released
// lane's stale omp first. Through the real `lane.ts launch`, runner and `lane.ts interactive`, against the fake omp in
// omp 18.8.6's shape (`deferShutdown`: the lane's ctx.shutdown() only requests it; `{ pending: true }`: background work that
// never settles; `ignoreEof`). AGENT_SYSTEM_LANE_SETTLE_IDLE_MS stays at its 15-minute default, so a runner that waits for
// the settle (the pre-change tree) never writes `lane-exit:` inside these windows.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneExit, laneExitBody, laneStarted, laneStopAcceptedBody, laneStopRequestBody, launchRequestedBody, STARTER_EXIT } from "../src/launch";
import { SURFACE_BY } from "../src/types";
// A namespace import: a name lane.ts does not export fails only the test that calls it.
import * as laneScript from "../scripts/lane";
import { alive, type FakeScript, type FakeStep, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, until } from "./helpers";

const roots: LaneRoot[] = [];
/** Stale omps a case leaves alive on purpose: SIGKILLed after the file, whatever the case's outcome. */
const leftovers: number[] = [];
/** Lanes whose runner a case SIGKILLed: their lane-exit: is written for them after the file, as `lane.ts stop`'s no-runner fallback writes it (by the starter), so settleDrains finds every runner's lane ended. */
const killedLanes: { r: LaneRoot; wl: string; laneId: string }[] = [];
/** Short polls and graces; the settle-idle window stays at its default (see the header). */
const makeRoot = (over: Record<string, string> = {}): LaneRoot => {
	const r = laneRoot({ AGENT_SYSTEM_LANE_STOP_POLL_MS: "200", ...over });
	roots.push(r);
	return r;
};
afterAll(async () => {
	for (const pid of leftovers) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const k of killedLanes) {
		if (laneExit(laneSnapshot(k.r, k.wl).control, k.laneId) !== null) continue;
		const l = ledgerOf(k.r);
		try {
			l.recordEntry({ by: LANE_STARTER_BY, workloadId: k.wl, kind: "assumption", body: laneExitBody(k.laneId, { code: null, signal: "SIGKILL", outcome: "died" }) });
		} finally {
			l.close();
		}
	}
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
function openWorkload(r: LaneRoot): string {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "release exit probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		return wl;
	} finally {
		l.close();
	}
}
const lane = (r: LaneRoot, args: string[], over: Record<string, string> = {}) => sh(["bun", LANE_SCRIPT, ...args], r.repo, { ...r.env, ...over });
/** `lane.ts launch`, exit 0, and the runner pid it printed. */
const launch = (r: LaneRoot, wl: string, over: Record<string, string> = {}): number => {
	const out = lane(r, ["launch", wl, "--requested-by", "test"], over);
	expect(out.err).not.toContain("still running");
	expect(out.code).toBe(STARTER_EXIT.ok);
	return Number(/^lane \S+ runner (\d+)$/.exec(out.out)![1]);
};
const request = (r: LaneRoot, wl: string) => {
	const l = ledgerOf(r);
	try {
		return l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("test", l.now()) });
	} finally {
		l.close();
	}
};
const eventsOf = (r: LaneRoot, pid: number) => fakeRecords(r).filter((x) => x.pid === pid && x.event).map((x) => x.event!);
/** The shutdown events in the order the fake recorded them. */
const shutdownEvents = (r: LaneRoot, pid: number) => eventsOf(r, pid).filter((e) => ["shutdown-requested", "eof", "sigterm"].includes(e));
const spawnedPids = (r: LaneRoot) => [...new Set(fakeRecords(r).filter((x) => x.argv !== undefined).map((x) => x.pid))];
const exitOf = (r: LaneRoot, wl: string, laneId: string, ms = 30_000) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId), ms);
const startedOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-started: of ${laneId}`, () => laneStarted(laneSnapshot(r, wl).control, laneId));
const promptsOf = (r: LaneRoot) => fakeRecords(r).filter((x) => x.event === "prompt");
/** Gone to ps: no row, or a zombie awaiting its reaper (the stale omp is an orphan). */
const gone = (pid: number): boolean => {
	const p = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "pipe" });
	const stat = p.stdout.toString().trim();
	return stat === "" || stat.startsWith("Z");
};
const holderChanges = (r: LaneRoot, wl: string) => {
	const l = ledgerOf(r);
	try {
		return l.holderChanges(wl);
	} finally {
		l.close();
	}
};

const DONE: FakeStep = { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } };
const ADD: FakeStep = { tool: "lane_add_slice", args: { task: "probe", doneCondition: "probed", inputs: "README.md", kind: "change-small" } };
const COMPLETE: FakeStep = { tool: "lane_complete_slice", args: { slice: "$slice", artifact: "probed" } };
const RELEASE: FakeStep = { tool: "lane_release", args: {} };
const PENDING: FakeStep = { pending: true };
/** omp 18.8.6 as in the incidents: the release only requests the shutdown, and EOF does not end it. */
const deferred = (s: Omit<FakeScript, "deferShutdown" | "ignoreEof">): FakeScript => ({ deferShutdown: true, ignoreEof: true, ...s });

describe("a released lane's omp ends and lane-exit: follows (R1, R3, R8)", () => {
	test("1: release in the owned turn with background pending → shutdown-requested, EOF, SIGTERM; lane-exit: completed within 30 s; the next launch reserves and starts its lane", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, COMPLETE, DONE, PENDING, RELEASE] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
		// the next launch on the same workload: reserved, its runner starts the next lane
		request(r, wl);
		setScript(r, { steps: [RELEASE] });
		launch(r, wl);
		const lane2 = laneIdOf(wl, 2);
		expect((await startedOf(r, wl, lane2))!.pid).not.toBe(started.pid);
		await exitOf(r, wl, lane2);
	}, 60_000);

	test("2: release with a receipt in a woken turn, background still pending → the stop poll decides; EOF, SIGTERM, lane-exit: completed", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, COMPLETE, PENDING, { wake: { ms: 1500, steps: [DONE, RELEASE] } }] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		expect(eventsOf(r, started.pid)).toContain("wake");
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	test("2a: receipt-free release in the owned turn (an open slice, released-open:) → decided at once: lane-exit: open-work with the released-open death", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, PENDING, RELEASE] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "open-work" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		const snap = laneSnapshot(r, wl);
		expect(snap.bodies.some((b) => b.includes("done-because:"))).toBe(false);
		expect(snap.deaths).toEqual([`lane-died: ${lane1}: released with 1 open slice(s), no done-because; background work was in flight`]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	test("2b: receipt-free release in a woken turn → the stop poll decides open-work the same way", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, PENDING, { wake: { ms: 1500, steps: [RELEASE] } }] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "open-work" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(laneSnapshot(r, wl).deaths).toEqual([`lane-died: ${lane1}: released with 1 open slice(s), no done-because; background work was in flight`]);
	}, 60_000);

	test("2c (R17): a third-party release while the runner waits is not a self-release; the runner's lease renewal never re-claims it", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [PENDING] }));
		const runner = launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		await startedOf(r, wl, lane1);
		// the lane's own claim (lane-ready: follows it), then its one turn, which ends unsettled at once
		await until("lane 1's lane-ready:", () => laneSnapshot(r, wl).control.some((c) => c.prefix === "lane-ready" && c.laneId === lane1));
		await until("lane 1's prompt", () => promptsOf(r).length === 1);
		await Bun.sleep(1_000);
		expect(laneSnapshot(r, wl).workload!.holder).toBe(lane1);
		const l = ledgerOf(r);
		expect(l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: lane1 })).toEqual({ released: true });
		l.close();
		const at = holderChanges(r, wl).length;
		// many stop-poll ticks (200 ms here; 5 s by default)
		await Bun.sleep(6_000);
		expect(holderChanges(r, wl).slice(at)).toEqual([]);
		expect(laneSnapshot(r, wl).workload!.holder).toBeNull();
		expect(laneExit(laneSnapshot(r, wl).control, lane1)).toBeNull();
		process.kill(runner, "SIGTERM");
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "stop" });
	}, 60_000);

	test("3: a receipt only, owned turn, background pending → completed at once: omp ended, the workload released, no idle prompt", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [DONE, PENDING] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		expect(shutdownEvents(r, started.pid)).toEqual(["eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
		expect(laneSnapshot(r, wl).workload!.holder).toBeNull();
	}, 60_000);

	test("4: a receipt only, written by a woken turn, background still pending → the stop poll decides completed; lane-exit: follows", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [PENDING, { wake: { ms: 1500, steps: [DONE] } }] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		expect(eventsOf(r, started.pid)).toContain("wake");
		expect(shutdownEvents(r, started.pid)).toEqual(["eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	test("5: case 1 with an omp that ignores SIGTERM → SIGKILL after the end grace, lane-exit: still written", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ ignoreTerm: true, steps: [ADD, COMPLETE, DONE, PENDING, RELEASE] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed", signal: "SIGKILL" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(alive(started.pid)).toBe(false);
	}, 60_000);
});

/**
 * Cases 6–8's setup: lane 1 releases itself (receipt, background pending) with an omp that ignores EOF and SIGTERM; its runner
 * holds a long shutdown grace and is SIGKILLed once it has sent EOF, so lane 1 has no lane-exit: and its omp lives on.
 */
async function staleLane(r: LaneRoot) {
	const wl = openWorkload(r);
	setScript(r, deferred({ ignoreTerm: true, steps: [ADD, COMPLETE, DONE, PENDING, RELEASE] }));
	const runner = launch(r, wl, { AGENT_SYSTEM_LANE_SHUTDOWN_GRACE_MS: "120000" });
	const lane1 = laneIdOf(wl, 1);
	const stale = (await startedOf(r, wl, lane1))!;
	leftovers.push(stale.pid);
	await until("lane 1's EOF", () => eventsOf(r, stale.pid).includes("eof"));
	process.kill(runner, "SIGKILL");
	killedLanes.push({ r, wl, laneId: lane1 });
	await until("lane 1's runner gone", () => !alive(runner));
	expect(laneExit(laneSnapshot(r, wl).control, lane1)).toBeNull();
	expect(laneScript.startTime(stale.pid)).toBe(stale.start);
	expect(holderChanges(r, wl).at(-1)).toMatchObject({ from: lane1, to: null, by: lane1 });
	return { wl, lane1, stale };
}

/** Waits for `laneId`'s lane-started:, asserting at every sighting that the stale pid is already gone. */
const startedAfterGone = (r: LaneRoot, wl: string, laneId: string, stalePid: number) =>
	until(`lane-started: of ${laneId}`, () => {
		const s = laneStarted(laneSnapshot(r, wl).control, laneId);
		if (s) expect(gone(stalePid)).toBe(true);
		return s;
	}, 60_000);

describe("a self-released lane's stale omp at the next spawn (R5, R7, R15)", () => {
	test("6: the starter exits 0 at once with the stale omp still alive; the new runner ends it (SIGTERM, SIGKILL after 5 s) before its own lane-started:", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_END_GRACE_MS: "5000" });
		const { wl, stale } = await staleLane(r);
		request(r, wl);
		setScript(r, { steps: [RELEASE] });
		launch(r, wl);
		// read right after the starter exits: the stale omp still runs as recorded, so the starter did not wait on it
		expect(laneScript.startTime(stale.pid)).toBe(stale.start);
		expect(gone(stale.pid)).toBe(false);
		const lane2 = laneIdOf(wl, 2);
		const s2 = (await startedAfterGone(r, wl, lane2, stale.pid))!;
		expect(s2.pid).not.toBe(stale.pid);
		expect(eventsOf(r, stale.pid)).toContain("sigterm");
		await exitOf(r, wl, lane2);
	}, 90_000);

	for (const how of ["signal", "ledger"] as const) {
		test(`7${how === "signal" ? "a" : "b"}: a stop (${how === "signal" ? "SIGTERM to the new runner" : "a ledger stop request, no lane.ts stop"}) during the cleanup → no omp spawned, lane-exit: outcome stop by lane-runner`, async () => {
			const r = makeRoot({ AGENT_SYSTEM_LANE_END_GRACE_MS: "5000" });
			const { wl, stale } = await staleLane(r);
			request(r, wl);
			setScript(r, { steps: [RELEASE] });
			const runner = launch(r, wl);
			const lane2 = laneIdOf(wl, 2);
			await until("the cleanup's SIGTERM to the stale omp", () => eventsOf(r, stale.pid).includes("sigterm"));
			expect(gone(stale.pid)).toBe(false);
			let req: string | null = null;
			if (how === "signal") process.kill(runner, "SIGTERM");
			else {
				const l = ledgerOf(r);
				req = l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(lane2, "test-stop", "test") });
				l.close();
			}
			expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "stop" });
			const snap = laneSnapshot(r, wl);
			expect(snap.control.find((c) => c.prefix === "lane-exit" && c.laneId === lane2)!.createdBy).toBe(LANE_RUNNER_BY);
			expect(laneStarted(snap.control, lane2)).toBeNull();
			expect(spawnedPids(r)).toEqual([stale.pid]);
			expect(snap.workload!.holder).toBeNull();
			if (req !== null) {
				const accepted = snap.entries.find((e) => e.body === laneStopAcceptedBody(lane2, req!));
				expect(accepted?.created_by).toBe(LANE_RUNNER_BY);
			}
		}, 90_000);
	}

	test("8: lane.ts interactive past a stale omp → SIGTERM, then gone after the 5 s grace, before the interactive lane-started:; closing Jo's terminal ends it with outcome interactive", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_END_GRACE_MS: "5000" });
		const { wl, stale } = await staleLane(r);
		const l = ledgerOf(r);
		l.flipMode(wl, { by: SURFACE_BY, mode: "user-driven", author: "jo", channel: "surface" });
		l.close();
		setScript(r, { steps: [{ hang: true }] });
		// The TUI's stdio is inherited from the wrapper: a pipe held open stands in for Jo's terminal.
		const tui = Bun.spawn(["bun", LANE_SCRIPT, "interactive", wl], { cwd: r.repo, env: r.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const lane2 = laneIdOf(wl, 2);
		const s2 = (await startedAfterGone(r, wl, lane2, stale.pid))!;
		expect(eventsOf(r, stale.pid)).toContain("sigterm");
		expect(s2.pid).not.toBe(stale.pid);
		await until("the interactive omp's spawn", () => spawnedPids(r).includes(s2.pid));
		tui.stdin.end();
		await tui.exited;
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "interactive" });
	}, 90_000);
});
