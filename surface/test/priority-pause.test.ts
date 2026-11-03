// Priority pause end to end (PLAN wl-mv8wzytml878b4 D3, test T6): the real starter, runner and drain
// (surface/scripts/lane.ts) against the fake omp (surface/test/helpers.ts `laneRoot`), cap 1, the installed
// profile in the temp HOME at `jevRank.mode: order`, and the wake tick (surface/extensions/wake.ts) as the
// entrypoint that runs `preemptFor`. The tick's own exec is fake: the starters it would run are not needed here,
// the drains the runners spawn do the launching.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { doneBody, laneExit, laneStarted, launchRequestedBody, PRIORITY_REASON_PREFIX, STARTER_EXIT, verdictOf } from "../src/launch";
import { briefHash, formatOverride, formatSignal, goalsHash, rankDay, type SignalAnswers } from "../src/rank";
import { surfaceSession } from "../src/session";
import { RANK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import {
	ctxOf, drainLinesOf, drainsSpawned, fakePi, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, timers, tmp, until,
} from "./helpers";

const ORDER_YAML = "setupVersion: 2\njevRank:\n  mode: order\n  parallelBudgetUsd: 0\n";
const roots: LaneRoot[] = [];
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
function withLedger<T>(r: LaneRoot, f: (l: Ledger) => T): T {
	const l = ledgerOf(r);
	try {
		return f(l);
	} finally {
		l.close();
	}
}
/** A whole rank signal with no goals set: `unblocks` alone orders the items. */
const answers = (unblocks: number): SignalAnswers => ({
	unblocks_jo: { type: "bool", bool: unblocks }, cuts_spend: { type: "bool", bool: 0.1 }, fixes_breakage: { type: "bool", bool: 0.1 },
	states_deadline: { type: "bool", bool: 0.05 }, irreversible: { type: "bool", bool: 0.05 }, deadline_when: { type: "choice", choice: "none", confidence: 0.9 },
	builds_enforcer: { type: "bool", bool: 0.1 },
});
/** An autonomous workload on the root's repo with its done: line and a current Jev signal. */
const openIn = (r: LaneRoot, brief: string, unblocks: number): string =>
	withLedger(r, (l) => {
		ensureStandingWorkload(l);
		const wl = l.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		l.recordEntry({
			by: RANK_BY, workloadId: wl, kind: "assumption",
			body: formatSignal({ brief: briefHash(brief), goals: goalsHash([]), askedOn: rankDay(l.now()), judge: "typesafe/jev-1.13.0", tokens: 1, cost: 0, answers: answers(unblocks) }),
		});
		return wl;
	});
/** Jo's ruling: `wl` first (`rank-override:`, the row `as2_rank first` writes). */
const rule = (r: LaneRoot, wl: string) =>
	withLedger(r, (l) => l.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatOverride({ workloadId: wl, input: `in-${wl}`, shown: "en-shown" }) }));
const lane = (r: LaneRoot, args: string[], over: Record<string, string> = {}) => sh(["bun", LANE_SCRIPT, ...args], r.repo, { ...r.env, ...over });
const readyOf = (r: LaneRoot, wl: string, laneId: string) =>
	until(`lane-ready: of ${laneId}`, () => laneSnapshot(r, wl).control.find((c) => c.prefix === "lane-ready" && c.laneId === laneId), 60_000);
const exitOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId), 60_000);
const launchesOf = (r: LaneRoot, wl: string) => laneSnapshot(r, wl).bodies.filter((b) => b.startsWith(`${LANE_STARTER_BY} launch: `));
const stopsOf = (r: LaneRoot, wl: string) => laneSnapshot(r, wl).bodies.filter((b) => b.startsWith(`${SURFACE_BY} lane-stop: `));
const verdict = (r: LaneRoot, wl: string) => withLedger(r, (l) => verdictOf(l.launchRows(wl, 1)!));

/** The orchestrator surface on the root's ledger and HOME, its exec fake; `tick()` runs one poll's catch-up to its end. */
function surfaceOn(r: LaneRoot) {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE");
	const env = { ...r.env, AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_VOICE: voice };
	const f = fakePi(undefined, { exec: true });
	orchestratorSurface(f.pi, env, {});
	const ctx = ctxOf({ cwd: r.repo });
	const s = surfaceSession(ctx, env);
	const tick = async () => {
		timers[0]!.fn();
		while (s.launching) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
	};
	const told = async (): Promise<string[]> => {
		const turn = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as { messages: { content: string }[] };
		return (turn.messages[0]?.content ?? "").split("\n").filter((x) => x.startsWith("- tick: priority-pausing"));
	};
	return {
		start: async () => {
			timers.length = 0;
			await f.emit("session_start", { type: "session_start" }, ctx);
			expect(timers).toHaveLength(1);
		},
		tick, told,
	};
}

describe("T6 priority pause end to end (cap 1, order)", () => {
	test("Jo rules X first: L's runner takes the priority stop (no lane-died:), the drain starts X; X releases and L relaunches with --resume of its session; a competing Jo request holding the slot leaves X2 waiting and the next tick pauses again", async () => {
		const r = laneRoot({ AGENT_SYSTEM_MAX_LANES: "1" });
		roots.push(r);
		writeFileSync(join(r.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml"), ORDER_YAML);
		const surface = surfaceOn(r);

		// L runs, its omp hanging until a stop
		const L = openIn(r, "L: running, Jev ranks it low", 0.1);
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", L, "--requested-by", "test"]).code).toBe(STARTER_EXIT.ok);
		const laneL1 = laneIdOf(L, 1);
		await readyOf(r, L, laneL1);
		const sessionL1 = laneStarted(laneSnapshot(r, L).control, laneL1)!.session;
		expect(sessionL1).toBeTruthy();

		// Jo rules X first; the tick at cap writes one priority stop on L and tells it
		const X = openIn(r, "X: Jo rules it first", 0.2);
		rule(r, X);
		expect(verdict(r, X)).toEqual({ launch: false, reason: "cap" });
		// X's omp reads this script when the drain starts it: it works a while, then records its receipt and completes
		setScript(r, { steps: [{ sleepMs: 4_000 }, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		await surface.start();
		await surface.tick();
		await surface.tick();
		expect(stopsOf(r, L)).toEqual([`${SURFACE_BY} lane-stop: ${laneL1} requested ${PRIORITY_REASON_PREFIX}${X} by rank`]);
		expect(await surface.told()).toEqual([`- tick: priority-pausing ${laneL1} on ${L} for ${X}`]);

		// L's runner accepts it through the stop path: outcome stop, reason priority-for-X, no lane-died:
		expect(await exitOf(r, L, laneL1)).toMatchObject({ outcome: "stop", reason: `${PRIORITY_REASON_PREFIX}${X}` });
		expect(laneSnapshot(r, L).deaths).toEqual([]);
		// the drain L's runner spawned starts X, the top-ranked launchable workload
		const laneX = laneIdOf(X, 1);
		await readyOf(r, X, laneX);
		expect(launchesOf(r, X)).toEqual([`${LANE_STARTER_BY} launch: ${laneX} cause first requested-by lane-runner`]);
		expect(launchesOf(r, L)).toHaveLength(1);
		const exitL1 = laneSnapshot(r, L).control.find((c) => c.prefix === "lane-exit" && c.laneId === laneL1)!.id;
		// L's relaunch reads this script: it hangs again
		setScript(r, { steps: [{ hang: true }] });

		// X completes and releases: the drain X's runner spawned relaunches L by itself, cause priority, resuming L's session
		expect(await exitOf(r, X, laneX)).toMatchObject({ outcome: "completed" });
		const laneL2 = laneIdOf(L, 2);
		await readyOf(r, L, laneL2);
		expect(launchesOf(r, L)).toEqual([
			`${LANE_STARTER_BY} launch: ${laneL1} cause first requested-by test`,
			`${LANE_STARTER_BY} launch: ${laneL2} cause priority ${exitL1} requested-by lane-runner`,
		]);
		const recL2 = fakeRecords(r).find((x) => x.env?.AGENT_SYSTEM_LANE_ID === laneL2 && x.argv)!;
		expect(recL2.argv).toContain("--resume");
		expect(recL2.argv![recL2.argv!.indexOf("--resume") + 1]).toBe(sessionL1!);
		withLedger(r, (l) => l.closeWorkload(X, { by: SURFACE_BY }));

		// A competing Jo request: C, launched on Jo's word, holds the one slot L's next pause frees (staging: C's starter
		// runs with a one-off cap of 2 so the slot it takes is deterministic, rather than racing the drain for it). The
		// same-cap arbitration, Jo's request and ruled X racing for the one slot a pause frees, is covered by the
		// "freed slot" test in rank-launch.test.ts.
		const C = openIn(r, "C: Jo asked for it", 0.5);
		const X2 = openIn(r, "X2: Jo rules it first", 0.2);
		withLedger(r, (l) => l.recordEntry({ by: SURFACE_BY, workloadId: C, kind: "assumption", body: launchRequestedBody("jo", l.now()) }));
		expect(lane(r, ["launch", C, "--requested-by", "test"], { AGENT_SYSTEM_MAX_LANES: "2" }).code).toBe(STARTER_EXIT.ok);
		const laneC = laneIdOf(C, 1);
		await readyOf(r, C, laneC);
		rule(r, X2);
		await surface.tick();
		// L ranks lowest below X2: it is paused, not C
		expect(stopsOf(r, L)).toEqual([
			`${SURFACE_BY} lane-stop: ${laneL1} requested ${PRIORITY_REASON_PREFIX}${X} by rank`,
			`${SURFACE_BY} lane-stop: ${laneL2} requested ${PRIORITY_REASON_PREFIX}${X2} by rank`,
		]);
		expect(stopsOf(r, C)).toEqual([]);
		expect(await exitOf(r, L, laneL2)).toMatchObject({ outcome: "stop", reason: `${PRIORITY_REASON_PREFIX}${X2}` });
		// the drain L's runner spawned tries X2 first and stops at the cap C holds: X2 is left waiting
		const drain = await until("L's drain", () => drainsSpawned(r).find((d) => d.by === laneL2));
		await until(`the end of drain ${drain.pid}`, () => drainLinesOf(r, drain.pid).some((x) => x.startsWith("end ")), 60_000);
		expect(launchesOf(r, X2)).toEqual([]);
		expect(verdict(r, X2)).toEqual({ launch: false, reason: "cap" });
		// From here every omp that starts finishes by itself, so none outlives the test: C's runner inherited the one-off cap
		// of 2, and its drain may start a second lane. L, priority-paused for X2, is closed so nothing relaunches it.
		setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		withLedger(r, (l) => l.closeWorkload(L, { by: SURFACE_BY }));
		// the next tick sees no priority stop on its way and pauses again: C, the lowest running lane below X2
		await surface.tick();
		expect(stopsOf(r, C)).toEqual([`${SURFACE_BY} lane-stop: ${laneC} requested ${PRIORITY_REASON_PREFIX}${X2} by rank`]);
		expect(await exitOf(r, C, laneC)).toMatchObject({ outcome: "stop", reason: `${PRIORITY_REASON_PREFIX}${X2}` });
		// the freed slot goes to X2, the top-ranked launchable workload
		const laneX2 = laneIdOf(X2, 1);
		expect(await exitOf(r, X2, laneX2)).toMatchObject({ outcome: "completed" });
		expect(launchesOf(r, X2)).toEqual([`${LANE_STARTER_BY} launch: ${laneX2} cause first requested-by lane-runner`]);
	}, 240_000);
});
