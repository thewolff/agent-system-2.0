import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { headroom } from "../../classifier/src/headroom";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { launchVerdict, triggerLaunch } from "../extensions/launch";
import orchestratorSurface from "../index";
import { reserve } from "../scripts/lane";
import { controlEntries, doneBody, laneExitBody, laneHeadroomBody, laneStartedBody, launchRequestedBody, STARTER_EXIT, trainBoardBody, verdictOf } from "../src/launch";
import { homeModel, type LabWaitContext, predictionOf, readLabWaitContext, recordLabWait, reconcileLabWait, standingWait, waits } from "../src/lab-wait";
import { rankGate } from "../src/rank-launch";
import { renderWake } from "../src/render";
import { type SurfaceSession, surfaceSession } from "../src/session";
import { MERGE_TRAIN_BY, SURFACE_BY } from "../src/types";
import { ctxOf, drainsSpawned, fakePi, fakeRecords, LANE_SCRIPT, laneRoot, type LaneRoot, setScript, settleDrains, tempLedger, timers, tmp, until } from "./helpers";
import { ensureStandingWorkload } from "../src/identity";
import { formatOverride } from "../src/rank";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { recordRepo } from "../src/decision-log";

const roots: { root: LaneRoot; syntheticExits: string[] }[] = [];
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map(({ root, syntheticExits }) => settleDrains(root, 60_000, syntheticExits)));
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

const A = "anthropic/claude-opus-5-5";
const S = "openai-codex/gpt-6.1-sol";
const NOW = Date.parse("2026-10-20T10:00:00Z");
const SHOW = { mode: "show" as const, parallelBudgetUsd: 0 };
const GONE = { omp: () => "gone" as const, runner: () => "gone" as const };
const control = (l: Ledger, wl: string) => controlEntries(l.entries(wl));
const note = (l: Ledger, wl: string, body: string, by: string = SURFACE_BY) => l.recordEntry({ by, workloadId: wl, kind: "assumption", body });
const opened = (l: Ledger, stakes: "normal" | "production" | "throwaway" = "normal", mode: "autonomous" | "user-driven" = "autonomous") => l.openWorkload({ by: SURFACE_BY, brief: "implement the wait", stakes, mode });
const snapshot = (out: boolean, prediction: string | null = null): LabWaitContext => ({
	room: headroom({ now: NOW, lines: [JSON.stringify({ t: NOW / 1000, rows: { "anthropic/5h": out ? 0.9 : 0.1 } })] }), strongRow: [A, S], prediction,
});
function start(l: Ledger, wl: string, over: { homeModel?: string; startModel?: string; ranModel?: string; model?: string; argv?: string[] } = {}) {
	const lane = `lane-${wl.slice(3)}-old`;
	note(l, wl, laneStartedBody(lane, { pid: 123, start: "x", session: null, runnerPid: 456, argv: [], ...over }), LANE_RUNNER_BY);
	return lane;
}
function waitingAttempt(l: Ledger, wl: string) {
	const r = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 100, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
	if (!r.ok) throw new Error(r.reason);
	l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: r.laneId });
	note(l, wl, laneExitBody(r.laneId, { code: 0, signal: null, outcome: "waiting" }), LANE_RUNNER_BY);
	return r.laneId;
}

// Fixtures use real quota snapshots and real ledger transactions, not source-text assertions.
describe("normal lanes' lab gate", () => {
	test("T1/T5a: a home out refuses before the starter, records once, retains the request and launches when admitted", async () => {
		const { ledger: l } = tempLedger();
		const wl = opened(l);
		start(l, wl, { homeModel: A });
		const request = note(l, wl, launchRequestedBody("jo", l.now()));
		const f = fakePi(undefined, { exec: true });
		const told = new Set<string>();
		for (let i = 0; i < 3; i++) {
			expect(launchVerdict(l, {}, wl, snapshot(true))).toMatchObject({ launch: false, reason: expect.stringContaining(`lab-out: ${A}`) });
			const r = await triggerLaunch(f.pi, l, {}, wl, "jo", { wait: snapshot(true), toldWaits: told });
			expect(r).toMatchObject({ attempted: false, code: null, line: expect.stringContaining("waits for anthropic") });
		}
		expect(f.execs.calls).toHaveLength(0);
		expect(control(l, wl).filter(c => c.prefix === "lab-wait")).toHaveLength(1);
		expect(told.size).toBe(1);
		expect(l.liveLaneHolders(l.now())).toHaveLength(0);
		expect(l.entries(wl).some(e => /^(launch:|launch-failed:|lane-died:)/.test(e.body))).toBe(false);
		expect(renderWake(l).text).toContain("lane: waiting for anthropic (");
		expect(renderWake(l, { trigger: "session-start" }).text).toContain("lane: waiting for anthropic (");
		reconcileLabWait(l, wl, snapshot(false));
		expect(launchVerdict(l, {}, wl, snapshot(false))).toEqual({ launch: true, cause: { kind: "first" } });
		await triggerLaunch(f.pi, l, {}, wl, "tick", { wait: snapshot(false) });
		expect(f.execs.calls).toHaveLength(1);
		expect(control(l, wl).some(c => c.id === request)).toBe(true);
		l.close();
	});

	test("T1b: binding lab-out is a wait, never a starter failure", async () => {
		const { ledger: l } = tempLedger();
		const wl = opened(l);
		start(l, wl, { homeModel: A });
		const f = fakePi(undefined, { exec: true });
		f.execs.answer = () => {
			const r = reserve(l, wl, "test", false, SHOW, () => GONE, snapshot(true));
			expect(r.ok).toBe(false);
			return { stdout: "", stderr: `${wl} not launched: ${!r.ok ? r.reason : "unexpected"}\n`, code: STARTER_EXIT["not-launchable"]!, killed: false };
		};
		const r = await triggerLaunch(f.pi, l, {}, wl, "open", { wait: snapshot(false) });
		expect(r.attempted).toBe(true);
		expect(r.code).toBe(STARTER_EXIT["not-launchable"]);
		expect(r.line).toContain("waits for anthropic");
		expect(r.line).not.toContain("launch failed");
		expect(control(l, wl).filter(c => c.prefix === "lab-wait")).toHaveLength(1);
		expect(control(l, wl).filter(c => c.prefix === "launch" || c.prefix === "launch-failed")).toHaveLength(0);
		l.close();
	});

	test("T7/T9: only normal autonomous unnamed non-trains wait", () => {
		const { ledger: l } = tempLedger();
		for (const stakes of ["normal", "production", "throwaway"] as const) for (const mode of ["autonomous", "user-driven"] as const) {
			const wl = opened(l, stakes, mode);
			start(l, wl, { homeModel: A });
			expect(waits(l.workload(wl)!, control(l, wl), l.entries(wl), l.instructions(wl))).toBe(stakes === "normal" && mode === "autonomous");
			const v = verdictOf(l.launchRows(wl, 100)!, snapshot(true));
			expect(!v.launch && v.reason.startsWith("lab-out:")).toBe(stakes === "normal" && mode === "autonomous");
		}
		for (const kind of ["model", "train", "fix"]) {
			const wl = opened(l);
			start(l, wl, { homeModel: A });
			if (kind === "model") note(l, wl, `lane-model: ${A} by jo at ${l.now()}`);
			if (kind === "train") note(l, wl, trainBoardBody({ pr: 7, workload: wl, head: "a".repeat(40), run: null, review: null }), MERGE_TRAIN_BY);
			if (kind === "fix") note(l, wl, "train-fix: repo example/repo pr 7 train wl-train train-entry en-train", MERGE_TRAIN_BY);
			expect(verdictOf(l.launchRows(wl, 100)!, snapshot(true)).launch).toBe(true);
		}
		const wl = opened(l);
		start(l, wl, { homeModel: A });
		for (const room of [headroom({ lines: [], now: NOW }), headroom({ lines: [JSON.stringify({ t: NOW / 1000 - 3600, rows: { "anthropic/5h": 0.99 } })], now: NOW }), headroom({ path: join(tmp("missing-polls"), "missing"), now: NOW })]) {
			expect(verdictOf(l.launchRows(wl, 100)!, { ...snapshot(true), room }).launch).toBe(true);
		}
		l.close();
	});

	test("T8: a waiting higher-ranked workload cannot block a lower-ranked launchable one", () => {
		const { ledger: l } = tempLedger();
		const hi = opened(l);
		const lo = opened(l);
		ensureStandingWorkload(l);
		note(l, STANDING_WORKLOAD_ID, formatOverride({ workloadId: hi, input: "in-pin", shown: "en-shown" }));
		start(l, hi, { homeModel: A });
		start(l, lo, { homeModel: S });
		// The higher workload is pinned, so the result does not depend on the fixture clock or random ids.
		expect(rankGate(l, l.launchRows(lo, 3)!, { mode: "order", parallelBudgetUsd: 0 }, snapshot(false))).toEqual({ launch: false, reason: `ranked: below ${hi}` });
		expect(rankGate(l, l.launchRows(lo, 3)!, { mode: "order", parallelBudgetUsd: 0 }, snapshot(true))).toEqual({ launch: true, cause: { kind: "first" } });
		expect(reserve(l, hi, "test", false, SHOW, () => GONE, snapshot(true))).toMatchObject({ ok: false, reason: expect.stringContaining("lab-out:") });
		l.close();
	});

	test("T10: waited belongs only to the latest attempt and is consumed even when its reservation releases", () => {
		const { ledger: l } = tempLedger();
		const wl = opened(l);
		const lane = waitingAttempt(l, wl);
		expect(verdictOf(l.launchRows(wl, 3)!, snapshot(false))).toEqual({ launch: true, cause: { kind: "waited", laneId: lane } });
		const r = reserve(l, wl, "test", false, SHOW, () => GONE, snapshot(false));
		expect(r).toMatchObject({ ok: true, cause: `waited ${lane}` });
		if (r.ok) l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: r.laneId });
		expect(reserve(l, wl, "test", false, SHOW, () => GONE, snapshot(false))).toEqual({ ok: false, reason: "died-not-relaunched" });
		// A late older waiting exit cannot revive the cause after a newer attempt.
		note(l, wl, laneExitBody(lane, { code: 0, signal: null, outcome: "waiting" }), LANE_RUNNER_BY);
		expect(verdictOf(l.launchRows(wl, 3)!, snapshot(false))).toEqual({ launch: false, reason: "died-not-relaunched" });
		l.close();
	});

	test("Jo's pending request stays unconsumed while its own lab is out", () => {
		const { ledger: l } = tempLedger();
		const wl = opened(l);
		waitingAttempt(l, wl);
		start(l, wl, { homeModel: A });
		const id = note(l, wl, launchRequestedBody("jo", l.now()));
		expect(reserve(l, wl, "jo", false, SHOW, () => GONE, snapshot(true))).toMatchObject({ ok: false, reason: expect.stringContaining("lab-out:") });
		expect(control(l, wl).filter(c => c.prefix === "launch")).toHaveLength(1);
		const r = reserve(l, wl, "jo", false, SHOW, () => GONE, snapshot(false));
		expect(r).toMatchObject({ ok: true, cause: `request ${id}` });
		l.close();
	});

	test("T10: two real lane.ts launch starters consume a waited cause exactly once", async () => {
		const root = laneRoot();
		const syntheticExits: string[] = [];
		roots.push({ root, syntheticExits });
		const l = Ledger.open(root.ledgerPath, { backup: false, backupOnOpen: false });
		try {
			const wl = opened(l);
			recordRepo(l, wl, root.repo);
			note(l, wl, doneBody("the probe is done"));
			const lane = waitingAttempt(l, wl);
			// This prior attempt is ledger-only: no runner existed to spawn its drain.
			syntheticExits.push(lane);
			setScript(root, {
				stateModel: { provider: "anthropic", id: "claude-opus-5-5" },
				steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }],
			});
			const children = [0, 1].map(() => Bun.spawn(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "race"], { cwd: root.repo, env: root.env, stdout: "pipe", stderr: "pipe" }));
			const results = await Promise.all(children.map(async p => {
				const stdout = await new Response(p.stdout).text();
				const stderr = await new Response(p.stderr).text();
				return { code: await p.exited, stdout, stderr };
			}));
			expect(results.filter(r => r.code === 0), JSON.stringify(results)).toHaveLength(1);
			expect(control(l, wl).filter(c => c.prefix === "launch" && c.rest.includes(`cause waited ${lane} `))).toHaveLength(1);
			expect(control(l, wl).filter(c => c.prefix === "launch")).toHaveLength(2);
			await until("the waited relaunch completed", () => control(l, wl).some(c => c.prefix === "lane-exit" && c.laneId !== lane && c.rest.includes("outcome completed")));
			const relaunched = control(l, wl).find(c => c.prefix === "launch" && c.laneId !== lane)!.laneId!;
			expect(fakeRecords(root).filter(r => r.argv !== undefined)).toHaveLength(1);
			await settleDrains(root, 60_000, syntheticExits);
			expect(drainsSpawned(root).map(d => d.by)).toEqual([relaunched]);
			expect(verdictOf(l.launchRows(wl, 3)!, snapshot(false))).toEqual({ launch: false, reason: "awaiting-close" });
		} finally {
			l.close();
		}
	}, 60_000);

	test("T11/D1: prediction is fresh unnamed startModel only; waiting fixes home even through a clear", () => {
		const { ledger: l } = tempLedger();
		const source = opened(l);
		start(l, source, { startModel: A, ranModel: S });
		expect(predictionOf(l)).toBe(A);
		const resumed = opened(l);
		start(l, resumed, { startModel: S, argv: ["--resume", "session"] });
		const named = opened(l);
		start(l, named, { startModel: S, model: S });
		expect(predictionOf(l)).toBe(A);
		const wl = opened(l);
		expect(verdictOf(l.launchRows(wl, 100)!, snapshot(true, predictionOf(l)))).toMatchObject({ launch: false, reason: expect.stringContaining(A) });
		recordLabWait(l, wl, A, "out");
		expect(homeModel(control(l, wl))).toBe(A);
		reconcileLabWait(l, wl, snapshot(false));
		expect(standingWait(control(l, wl))).toBeNull();
		expect(homeModel(control(l, wl))).toBe(A);
		// Legacy home is the move's source, not its destination, then ranModel without a move.
		const legacy = opened(l);
		const lane = start(l, legacy, { ranModel: S });
		note(l, legacy, laneHeadroomBody(lane, A, S, "out"), LANE_RUNNER_BY);
		expect(homeModel(control(l, legacy))).toBe(A);
		start(l, legacy, { homeModel: S, ranModel: A });
		expect(homeModel(control(l, legacy))).toBe(S);
		const unmoved = opened(l);
		start(l, unmoved, { ranModel: A });
		expect(homeModel(control(l, unmoved))).toBe(A);
		l.close();
	});

	test("T12: clear follows the wait's own condition, not cap, hold or rank; episodes reopen after clear", () => {
		const { ledger: l } = tempLedger();
		const wl = opened(l);
		recordLabWait(l, wl, A, "first");
		const other = opened(l);
		l.claimWorkload(other, { by: LANE_STARTER_BY, holder: "lane-other", leaseMs: 60_000 });
		expect(verdictOf(l.launchRows(wl, 1)!, snapshot(false))).toEqual({ launch: false, reason: "cap" });
		expect(reconcileLabWait(l, wl, snapshot(true))).not.toBeNull();
		l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-shutting-down", leaseMs: 60_000 });
		expect(reconcileLabWait(l, wl, snapshot(true))).not.toBeNull();
		expect(control(l, wl).filter(c => c.prefix === "lab-wait")).toHaveLength(1);
		reconcileLabWait(l, wl, snapshot(false));
		reconcileLabWait(l, wl, snapshot(false));
		expect(control(l, wl).filter(c => c.prefix === "lab-wait")).toHaveLength(2);
		expect(renderWake(l).text).not.toContain("waiting for anthropic");
		recordLabWait(l, wl, A, "second");
		expect(standingWait(control(l, wl))?.reason).toBe("second");
		note(l, wl, `lane-model: ${S} by jo at ${l.now()}`);
		reconcileLabWait(l, wl, snapshot(true));
		reconcileLabWait(l, wl, snapshot(true));
		expect(standingWait(control(l, wl))).toBeNull();
		expect(control(l, wl).filter(c => c.prefix === "lab-wait")).toHaveLength(4);
		l.close();
	});

	test("only machinery can stand or clear a wait; eligibility flips clear it once", () => {
		const { ledger: l } = tempLedger();
		for (const flip of ["stakes", "mode", "train"] as const) {
			const wl = opened(l);
			note(l, wl, `lab-wait: ${A} (forged)`, "lane-forger");
			expect(standingWait(control(l, wl))).toBeNull();
			const first = recordLabWait(l, wl, A, "out")!;
			expect(recordLabWait(l, wl, A, "changed percentages", LANE_RUNNER_BY)).toEqual(first);
			note(l, wl, `lab-wait: ${A} clear (forged)`, LANE_STARTER_BY);
			expect(standingWait(control(l, wl))?.entryId).toBe(first.entryId);
			if (flip === "stakes") l.setStakes(wl, { by: SURFACE_BY, stakes: "production" });
			if (flip === "mode") l.flipMode(wl, { by: SURFACE_BY, mode: "user-driven", author: "jo", channel: "surface" });
			if (flip === "train") note(l, wl, trainBoardBody({ pr: 7, workload: wl, head: "a".repeat(40), run: null, review: null }), MERGE_TRAIN_BY);
			expect(renderWake(l, { workloadId: wl }).text).not.toContain("lane: waiting for");
			reconcileLabWait(l, wl, snapshot(true));
			reconcileLabWait(l, wl, snapshot(true));
			expect(standingWait(control(l, wl))).toBeNull();
			expect(control(l, wl).filter(c => c.prefix === "lab-wait")).toHaveLength(2);
		}
		l.close();
	});

	test("m2: an unreadable strong row gives waiting decisions the empty comparison row", () => {
		const { ledger: l } = tempLedger();
		const wl = opened(l);
		start(l, wl, { homeModel: A });
		const polls = join(tmp("polls"), "polls.jsonl");
		const now = Date.now();
		const reset = now + 3.5 * 24 * 60 * 60_000;
		const poll = (at: number, a: number, s: number) => JSON.stringify({ t: at / 1000, limits: [
			{ provider: "anthropic", windowId: "7d", usedFraction: a, resetsAt: reset },
			{ provider: "openai-codex", windowId: "7d", usedFraction: s, resetsAt: reset },
		] });
		writeFileSync(polls, [poll(now - 30 * 60_000, 0.59, 0.2), poll(now, 0.60, 0.3)].join("\n"));
		const wait = readLabWaitContext(l, { HOME: tmp("broken-profile"), AS2_HEADROOM_POLLS: polls });
		expect(wait.strongRow).toEqual([]);
		expect(verdictOf(l.launchRows(wl, 3)!, wait)).toMatchObject({ launch: false, reason: expect.stringContaining("lab-out:") });
		// With a readable comparison row, the exact same source is retained by the guard's existing arithmetic.
		expect(verdictOf(l.launchRows(wl, 3)!, { ...wait, strongRow: [A, S] }).launch).toBe(true);
		l.close();
	});
});

async function pollTick(s: SurfaceSession) {
	timers[0]!.fn();
	while (s.launching) await new Promise<void>(resolve => setImmediate(resolve));
}

describe("waiting notices are standing ledger state", () => {
	test("T1/T12: tick records and tells once, keeps wait while cap fills, then clears independently", async () => {
		const { ledger: l, path } = tempLedger();
		const polls = join(tmp("tick-polls"), "polls.jsonl");
		const setOut = (out: boolean) => writeFileSync(polls, JSON.stringify({ t: Date.now() / 1000, rows: { "anthropic/5h": out ? 0.9 : 0.1 } }));
		setOut(true);
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AS2_HEADROOM_POLLS: polls, AGENT_SYSTEM_MAX_LANES: "1", HOME: tmp("tick-home") };
		const wl = opened(l);
		start(l, wl, { homeModel: A });
		const f = fakePi(undefined, { exec: true });
		orchestratorSurface(f.pi, env, {});
		const ctx = ctxOf({ idle: false });
		const s = surfaceSession(ctx, env);
		timers.length = 0;
		await f.emit("session_start", { type: "session_start" }, ctx);
		await pollTick(s);
		await pollTick(s);
		await pollTick(s);
		expect(s.tickNotices.filter(line => line.includes("waits for anthropic"))).toHaveLength(1);
		expect(f.execs.calls.filter(c => c.command === "bun")).toHaveLength(0);
		const other = opened(l);
		l.claimWorkload(other, { by: LANE_STARTER_BY, holder: "lane-other", leaseMs: 60_000 });
		await pollTick(s);
		expect(standingWait(control(l, wl))).not.toBeNull();
		expect(s.tickNotices.filter(line => line.includes("waits for anthropic"))).toHaveLength(1);
		setOut(false);
		await pollTick(s);
		expect(standingWait(control(l, wl))).toBeNull();
		expect(control(l, wl).filter(c => c.prefix === "lab-wait")).toHaveLength(2);
		l.releaseWorkload(other, { by: LANE_STARTER_BY, holder: "lane-other" });
		await pollTick(s);
		expect(f.execs.calls.some(c => c.command === "bun" && c.args[2] === wl)).toBe(true);
		l.close();
	});

	test("runner-written wait after session start is told once; existing wait is seeded and rendered without repeat", async () => {
		const { ledger: l, path } = tempLedger();
		const polls = join(tmp("runner-polls"), "polls.jsonl");
		writeFileSync(polls, JSON.stringify({ t: Date.now() / 1000, rows: { "anthropic/5h": 0.9 } }));
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AS2_HEADROOM_POLLS: polls, HOME: tmp("runner-home") };
		const existing = opened(l);
		recordLabWait(l, existing, A, "out before session", LANE_RUNNER_BY);
		const fresh = opened(l);
		const f = fakePi(undefined, { exec: true });
		orchestratorSurface(f.pi, env, {});
		const ctx = ctxOf({ idle: false });
		const s = surfaceSession(ctx, env);
		timers.length = 0;
		await f.emit("session_start", { type: "session_start" }, ctx);
		recordLabWait(l, fresh, A, "runner out", LANE_RUNNER_BY);
		await pollTick(s);
		await pollTick(s);
		expect(s.tickNotices.filter(line => line.includes(`${fresh} waits for anthropic`))).toHaveLength(1);
		expect(s.tickNotices.some(line => line.includes(`${existing} waits`))).toBe(false);
		expect(renderWake(l).text).toContain("waiting for anthropic (out before session)");
		l.close();
	});

	test("one tick shares its guard snapshot and prediction across workloads and trigger pre-checks", async () => {
		let time = NOW;
		const { ledger: l, path } = tempLedger(() => new Date(time++).toISOString());
		const polls = join(tmp("shared-polls"), "polls.jsonl");
		writeFileSync(polls, JSON.stringify({ t: Date.now() / 1000, rows: { "anthropic/5h": 0.1, "openai-codex/5h": 0.9 } }));
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AS2_HEADROOM_POLLS: polls, HOME: tmp("shared-home") };
		const first = opened(l);
		const second = opened(l);
		const third = opened(l);
		start(l, first, { homeModel: A });
		start(l, second, { homeModel: A });
		const f = fakePi(undefined, { exec: true });
		f.execs.answer = (_command, args) => {
			if (args[1] === "launch") {
				// A fresh start and new quota evidence appear after the pass took its snapshot.
				start(l, args[2]!, { startModel: S });
				writeFileSync(polls, JSON.stringify({ t: Date.now() / 1000, rows: { "anthropic/5h": 0.9, "openai-codex/5h": 0.9 } }));
			}
			return { stdout: "started", stderr: "", code: 0, killed: false };
		};
		orchestratorSurface(f.pi, env, {});
		const ctx = ctxOf({ idle: false });
		const s = surfaceSession(ctx, env);
		timers.length = 0;
		await f.emit("session_start", { type: "session_start" }, ctx);
		await pollTick(s);
		expect(f.execs.calls.filter(c => c.command === "bun").map(c => c.args[2]).sort()).toEqual([first, second, third].sort());
		await pollTick(s);
		expect(f.execs.calls.filter(c => c.command === "bun")).toHaveLength(3);
		expect([standingWait(control(l, first))?.model, standingWait(control(l, second))?.model, standingWait(control(l, third))?.model]).toEqual([A, A, S]);
		l.close();
	});
});
