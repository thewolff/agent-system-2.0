// sl-queue-core of wl-mvbcjadqgblr7k (PLAN rev 3 D1-D8): the intake queue. An ask arriving while started-but-idle
// workloads outnumber the lane slots opens `queued:` with its position in rank order (`rankOpen` filtered to queued
// workloads); the queue gate (`queueGate`, composed into `rankGate` / `decideRanked` in every `jevRank` mode) lets a
// queued workload take a slot only when no queued workload ranked above it is launchable; the drain walks queued
// workloads in queue order (`drainCandidates` / `drainPick`); Jo's request and `as2 lane` are never gated; the held
// warning skips a queued workload. The open tool runs as the surface registers it, on a temp ledger, with a fake judge
// (sizing and rank asks) and, where a launch is wanted, an exec that runs the starter's own reservation in process
// (`reserve` in surface/scripts/lane.ts), since a real lane runner cannot start here. The drain is driven through its own
// pick (`drainPick`) and the starter's reservation, as `cmdDrain` composes them.
import { describe, expect, test } from "bun:test";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, LANE_CAP_ENV, laneExitBody, laneReadyBody, laneStartedBody, launchRequestedBody, queuedBody, queuedOf, STARTER_EXIT } from "../src/launch";
import type { PidState } from "../src/omp-probe";
import { inputSpent } from "../src/orchestrator-question";
import { briefHash, formatOverride, formatSignal, goalsHash, rankDay, type SignalAnswers } from "../src/rank";
import {
	DRAIN_TRIED_ENV, drainCandidates, drainPick, formatDrainTried, preemptFor, queueOrder, queuePosition, type RankConfig, readDrainTried, startedIdle,
} from "../src/rank-launch";
import { RANK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import * as laneScript from "../scripts/lane";
import { ctxOf, fakePi, laneIdOf, tempLedger, tempRepo } from "./helpers";

const SHOW: RankConfig = { mode: "show", parallelBudgetUsd: 0 };
const ORDER: RankConfig = { mode: "order", parallelBudgetUsd: 0 };
const PARALLEL: RankConfig = { mode: "parallel", parallelBudgetUsd: 1_000_000 };
const MODES = [SHOW, ORDER, PARALLEL];
const REPO_A = tempRepo();
const REPO_B = tempRepo();

// ---- ledger fixtures -----------------------------------------------------------------------------------------------

/** A whole rank signal with no goals set: `unblocks` alone orders the items. */
const answers = (unblocks: number): SignalAnswers => ({
	unblocks_jo: { type: "bool", bool: unblocks }, cuts_spend: { type: "bool", bool: 0.1 }, fixes_breakage: { type: "bool", bool: 0.1 },
	states_deadline: { type: "bool", bool: 0.05 }, irreversible: { type: "bool", bool: 0.05 }, deadline_when: { type: "choice", choice: "none", confidence: 0.9 },
	builds_enforcer: { type: "bool", bool: 0.1 },
});
function signal(l: Ledger, wl: string, unblocks: number): void {
	l.recordEntry({
		by: RANK_BY, workloadId: wl, kind: "assumption",
		body: formatSignal({ brief: briefHash(l.workload(wl)!.brief), goals: goalsHash([]), askedOn: rankDay(l.now()), judge: "typesafe/jev-1.13.0", tokens: 1, cost: 0, answers: answers(unblocks) }),
	});
}
const queue = (l: Ledger, wl: string) => l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: queuedBody("intake queue") });
const isQueuedNow = (l: Ledger, wl: string) => queuedOf(controlEntries(l.entries(wl, "assumption"))) !== null;
const request = (l: Ledger, wl: string) => l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", l.now()) });
const pin = (l: Ledger, wl: string) =>
	l.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatOverride({ workloadId: wl, input: `in-${wl.slice(3)}`, shown: "en-shown" }) });
/** A lane under a live lease that its starter reserved (`launch:` cause first) and whose runner reported ready. */
function live(l: Ledger, wl: string): string {
	const r = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 99, leaseMs: 600_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
	if (!r.ok) throw new Error(r.reason);
	l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneReadyBody(r.laneId, l.now()) });
	return r.laneId;
}
/** The lane exits: released and its `lane-exit:` written; with no new cause the workload is started-but-idle. */
function exits(l: Ledger, wl: string, laneId: string): void {
	l.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: laneId });
	l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: 0, signal: null, outcome: "completed" }) });
}
const launches = (l: Ledger, wl: string) => l.entries(wl, "assumption").filter((e) => e.created_by === LANE_STARTER_BY && e.body.startsWith("launch: ")).map((e) => e.body);

function withCap<T>(cap: number, f: () => T): T {
	const before = process.env[LANE_CAP_ENV];
	process.env[LANE_CAP_ENV] = String(cap);
	try {
		return f();
	} finally {
		if (before === undefined) delete process.env[LANE_CAP_ENV];
		else process.env[LANE_CAP_ENV] = before;
	}
}
/** A probe factory answering `omp` and `runner` for every lane, recording each ask (surface/test/lane-live-lane.test.ts's pattern); the real ps is never run. */
function fakeProbe(answer: { omp: PidState; runner: PidState }) {
	const calls: { laneId: string; what: "omp" | "runner"; pid: number }[] = [];
	const probeFor = (laneId: string): laneScript.RunnerProbe => ({
		omp: (pid) => {
			calls.push({ laneId, what: "omp", pid });
			return answer.omp;
		},
		runner: (pid) => {
			calls.push({ laneId, what: "runner", pid });
			return answer.runner;
		},
	});
	return { calls, probeFor };
}
/** No earlier lane is alive: both pids answer gone. */
const NO_LIVE_LANE = fakeProbe({ omp: "gone", runner: "gone" }).probeFor;
/**
 * The starter's reservation, `decideRanked` composed, at `cap`; `probeFor` is the live-lane check's probe (a fake, never the
 * real ps); `tried` as a drain hands it (unset: read from `DRAIN_TRIED_ENV`).
 */
const reserve = (
	l: Ledger, wl: string, config: RankConfig, cap = 3, interactive = false, tried?: ReadonlySet<string>, probeFor: (laneId: string) => laneScript.RunnerProbe = NO_LIVE_LANE,
) => withCap(cap, () => laneScript.reserve(l, wl, interactive ? "jo" : "test", interactive, config, probeFor, tried));
/** One drain to its end, as `cmdDrain` runs it: `drainPick`, mark tried, the starter's reservation with the tried set; `cap` stops it. */
function drain(l: Ledger, cap: number, config: RankConfig): { wl: string; cause: string }[] {
	const tried = new Set<string>();
	const out: { wl: string; cause: string }[] = [];
	for (let next = drainPick(l, tried, cap, config); next !== null; next = drainPick(l, tried, cap, config)) {
		tried.add(next);
		const r = reserve(l, next, config, cap, false, tried);
		if (r.ok) out.push({ wl: next, cause: r.cause });
		else if (r.reason === "cap") break;
	}
	return out;
}

/** A temp ledger whose clock moves forward a millisecond per stamp, so creation order is open order. */
function world() {
	let last = 0;
	const { ledger: l, path } = tempLedger(() => new Date((last = Math.max(Date.now(), last + 1))).toISOString());
	ensureStandingWorkload(l);
	const open = (brief: string, o: { unblocks?: number; mode?: "autonomous" | "user-driven"; repo?: string; queued?: boolean } = {}): string => {
		const wl = l.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: o.mode ?? "autonomous" });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `repo: ${o.repo ?? REPO_A}` });
		if (o.unblocks !== undefined) signal(l, wl, o.unblocks);
		if (o.queued) queue(l, wl);
		return wl;
	};
	/** A workload whose lane ran and exited: started-but-idle. */
	const idle = (brief: string): string => {
		const wl = open(brief);
		exits(l, wl, live(l, wl));
		return wl;
	};
	return { l, path, open, idle };
}

// ---- the open tool's world -----------------------------------------------------------------------------------------

type Wire = { state: { goals?: string[]; item?: string } | string; questions: Record<string, { type: string; instructions?: string; criteria?: unknown }> };
/** The rank answers on the wire: an item whose brief says `HIGH` unblocks Jo, every other one does not. */
function wireAnswers(req: Wire) {
	const item = typeof req.state === "string" ? req.state : String(req.state.item ?? "");
	const out: Record<string, unknown> = {};
	for (const [name, q] of Object.entries(req.questions)) {
		if (q.type === "noul") out[name] = { type: "noul", noul: name === "unblocks_jo" && item.includes("HIGH") ? 0.95 : 0.05 };
		else if (q.type === "choice") {
			const labels = Object.keys(q.criteria as Record<string, string>);
			out[name] = { type: "choice", choice: "none", confidence: 0.95, probabilities: Object.fromEntries(labels.map((x) => [x, x === "none" ? 0.95 : 0.05 / (labels.length - 1)])) };
		} else out[name] = { type: "score", score: 0, confidence: 0.9, probabilities: { 0: 0.9, 1: 0.05, 2: 0.03, 3: 0.02 } };
	}
	return { answers: out, model: "jev-1.13.0", provider: "typesafe", usage: { input: 900 } };
}
const KINDS = ["locate", "understand", "change-small", "change-large", "judge"];
const SIZED = { answers: { kind: { choice: "change-large", confidence: 0.9, probabilities: Object.fromEntries(KINDS.map((k) => [k, k === "change-large" ? 0.9 : 0.025])) } }, provider: "typesafe", model: "jev" };

interface SurfaceOptions {
	cap: number;
	/** Runs inside each rank ask before it answers (a launch during the wait). */
	duringRank?: () => void;
	/** `deps.judge(ctx)` answers the sizing call and then never resolves again (judge resolution hangs). */
	hangAfterSizing?: boolean;
	/** The exec runs the starter's reservation in process; without it the host has no exec. */
	exec?: boolean;
	askTimeoutMs?: number;
}

/** The orchestrator surface over a fresh `world()` ledger, its open tool, and Jo's input rows. */
function surface(o: SurfaceOptions) {
	const w = world();
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: w.path, HOME: "/nonexistent-home", [LANE_CAP_ENV]: String(o.cap) };
	const judge = {
		judge: async (req: Wire) => {
			if ("kind" in req.questions) return SIZED;
			o.duringRank?.();
			return wireAnswers(req);
		},
	};
	let factory = 0;
	const deps = {
		judge: () => (o.hangAfterSizing && factory++ > 0 ? new Promise<never>(() => undefined) : Promise.resolve(judge as never)),
		askTimeoutMs: o.askTimeoutMs ?? 2_000,
	};
	const f = fakePi(undefined, { exec: o.exec ?? false });
	f.execs.answer = (_command, args) => {
		const r = reserve(w.l, args[2]!, ORDER, o.cap);
		return r.ok
			? { stdout: `lane ${r.laneId} reserved\n`, stderr: "", code: STARTER_EXIT.ok, killed: false }
			: { stdout: "", stderr: `${args[2]} not launched: ${r.reason}\n`, code: STARTER_EXIT["not-launchable"], killed: false };
	};
	orchestratorSurface(f.pi, env, deps);
	const ctx = ctxOf();
	/** Jo's ask through the open tool (the world's `open` writes a workload row directly). */
	const ask = async (brief: string, extra: Record<string, unknown> = {}) => {
		const r = await f.tool("orchestrator_open_workload").execute("1", { brief, done: "it is done", stakes: "normal", repo: REPO_A, ...extra }, undefined, undefined, ctx);
		return { id: (r.details as { id?: string } | undefined)?.id ?? null, text: r.content[0]!.text, details: r.details as { intake?: unknown; queued?: string | null } | undefined };
	};
	const input = (words: string) => {
		w.l.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: words, author: "jo", channel: "surface" });
		return w.l.instructions(STANDING_WORKLOAD_ID).at(-1)!.id;
	};
	const workloads = () => w.l.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n;
	return { ...w, f, ask, input, workloads };
}
const POSITION = (n: number, m: number) => `queued, position ${n} of ${m} (rank order; moves as ranks change)`;

// ---- the done line ---------------------------------------------------------------------------------------------------

describe("done line: an ask past the intake cap is queued with its rank position, and the queue top opens when a lane frees", () => {
	test("cap 2, two live lanes, three started-idle: A then B queue, B (ranked above A) is 1; a lane exits and the drain launches B (cause first); A is then 1", async () => {
		const s = surface({ cap: 2 });
		const { l } = s;
		const l1 = s.open("live one");
		const lane1 = live(l, l1);
		live(l, s.open("live two"));
		for (const n of [1, 2, 3]) s.idle(`started ${n}`);
		expect(startedIdle(l, l.now())).toHaveLength(3);

		const a = await s.ask("Tidy the README wording");
		expect(a.text).toContain(POSITION(1, 1));
		const b = await s.ask("HIGH: stop Jo pasting lane ids by hand");
		expect(b.text).toContain(POSITION(1, 2));
		expect(b.details!.intake).toEqual({ position: 1, of: 2 });
		expect(b.details!.queued).toBe("3 started-idle workloads over 2 lane slots");
		expect(queueOrder(l, l.now()).map((i) => i.workloadId)).toEqual([b.id, a.id]);
		expect(queuePosition(l, a.id!, l.now())).toMatchObject({ position: 2, of: 2 });
		// R5: the queued ask is an ordinary open workload with its done:, repo:, ceiling: and Jev signal; nothing dropped
		const bodies = l.entries(a.id!, "assumption").map((e) => e.body);
		for (const prefix of ["done: it is done", `repo: ${REPO_A}`, "ceiling: ", "priority-signal: ", "queued: "]) expect({ prefix, has: bodies.some((x) => x.startsWith(prefix)) }).toEqual({ prefix, has: true });
		expect(l.workload(a.id!)!.status).toBe("open");
		// at cap nothing launches; the queue gate holds A behind B in every mode
		for (const config of MODES) expect({ mode: config.mode, r: reserve(l, a.id!, config, 2) }).toEqual({ mode: config.mode, r: { ok: false, reason: "cap" } });

		exits(l, l1, lane1);
		expect(drain(l, 2, ORDER)).toEqual([{ wl: b.id!, cause: "first" }]);
		expect(launches(l, b.id!)).toEqual([`launch: ${laneIdOf(b.id!, 1)} cause first requested-by test`]);
		expect(isQueuedNow(l, b.id!)).toBe(false);
		expect(queuePosition(l, a.id!, l.now())).toMatchObject({ position: 1, of: 1 });
		expect(launches(l, a.id!)).toEqual([]);
	});

	test("two free slots, older A ranked below younger B: one drain launches B then A, in every mode", () => {
		for (const config of MODES) {
			const { l, open, idle } = world();
			idle("started, nothing left to do");
			const a = open("A: older, Jev ranks it lower", { unblocks: 0.1, repo: REPO_A, queued: true });
			const b = open("B: younger, Jev ranks it higher", { unblocks: 0.9, repo: REPO_B, queued: true });
			// the gate refuses A while B is launchable, in this mode too
			expect({ mode: config.mode, r: reserve(l, a, config, 2) }).toEqual({ mode: config.mode, r: { ok: false, reason: "queued: position 2" } });
			const candidates = drainCandidates(l, l.now(), config);
			expect({ mode: config.mode, bBeforeA: candidates.indexOf(b) < candidates.indexOf(a) }).toEqual({ mode: config.mode, bBeforeA: true });
			expect({ mode: config.mode, launched: drain(l, 2, config) }).toEqual({ mode: config.mode, launched: [{ wl: b, cause: "first" }, { wl: a, cause: "first" }] });
			expect([isQueuedNow(l, a), isQueuedNow(l, b)]).toEqual([false, false]);
		}
	});

	test("a queue top the drain already tried, whose starter wrote no launch:, never holds the queue: the pick takes B and the starter's reservation with the tried set admits it", () => {
		const { l, open } = world();
		const a = open("A: Jev ranks it higher", { unblocks: 0.9, repo: REPO_A, queued: true });
		const b = open("B: Jev ranks it lower", { unblocks: 0.1, repo: REPO_B, queued: true });
		expect(queueOrder(l, l.now()).map((i) => i.workloadId)).toEqual([a, b]);
		// the drain tried A; its starter exited without a launch:, so A is still queued and launchable
		const tried = new Set([a]);
		expect([launches(l, a), isQueuedNow(l, a)]).toEqual([[], true]);
		for (const config of MODES) expect({ mode: config.mode, pick: drainPick(l, tried, 2, config) }).toEqual({ mode: config.mode, pick: b });
		// without the tried set (every path but a drain's starter) the queue gate still holds B behind A
		for (const config of MODES) expect({ mode: config.mode, r: reserve(l, b, config, 2) }).toEqual({ mode: config.mode, r: { ok: false, reason: "queued: position 2" } });
		// order: the queue gate lets B by; the rank gate's `higherLaunchable` is unchanged and still names A
		expect(reserve(l, b, ORDER, 2, false, tried)).toEqual({ ok: false, reason: `ranked: below ${a}` });
		// show: the starter reads the set the drain handed it through DRAIN_TRIED_ENV and admits B, cause first
		const before = process.env[DRAIN_TRIED_ENV];
		process.env[DRAIN_TRIED_ENV] = formatDrainTried(tried);
		try {
			expect(reserve(l, b, SHOW, 2)).toEqual({ ok: true, laneId: laneIdOf(b, 1), cause: "first" });
		} finally {
			if (before === undefined) delete process.env[DRAIN_TRIED_ENV];
			else process.env[DRAIN_TRIED_ENV] = before;
		}
		expect(launches(l, b)).toEqual([`launch: ${laneIdOf(b, 1)} cause first requested-by test`]);
		expect(launches(l, a)).toEqual([]);
	});

	test("the drain's tried set through DRAIN_TRIED_ENV: only wl- ids are read, junk is ignored, unset or empty reads none, and starterEnv drops it", () => {
		expect(formatDrainTried(["wl-abc", "junk", "wl-chaos-run1"])).toBe("wl-abc,wl-chaos-run1");
		const raw = " wl-abc ,junk,,wl-chaos-run1,WL-UP,wl-,wl-a;rm -rf /,wl-x/../y,lane-wl-q-1, wl-def";
		expect([...readDrainTried({ [DRAIN_TRIED_ENV]: raw })]).toEqual(["wl-abc", "wl-chaos-run1", "wl-def"]);
		expect(readDrainTried({}).size).toBe(0);
		expect(readDrainTried({ [DRAIN_TRIED_ENV]: "" }).size).toBe(0);
		expect(readDrainTried({ [DRAIN_TRIED_ENV]: ",,junk" }).size).toBe(0);
		expect(laneScript.starterEnv({ PATH: "/bin", [DRAIN_TRIED_ENV]: "wl-abc" })).toEqual({ PATH: "/bin" });
	});
});

// ---- the open tool ---------------------------------------------------------------------------------------------------

describe("the open tool's intake (D2-D4)", () => {
	test("a rank ask that never resolves (judge resolution hangs after sizing): the open returns within the deadline with an unscored position", async () => {
		const s = surface({ cap: 3, hangAfterSizing: true, askTimeoutMs: 300 });
		const t0 = Date.now();
		const r = await s.ask("Tidy the README wording", { intake: "queue" });
		const took = Date.now() - t0;
		expect(took).toBeGreaterThanOrEqual(250);
		expect(took).toBeLessThan(5_000);
		expect(r.text).toContain(POSITION(1, 1));
		expect(r.text).toContain("rank: still unscored: the open-time Jev ask did not land within 0.3s");
		expect(queuePosition(s.l, r.id!, s.l.now())!.item.unscored).toBe("no signal");
	});

	test("a workload launched during the rank wait: the line reads `queued, then started at once` and the open's own trigger does not run", async () => {
		const ref: { l: Ledger | null } = { l: null };
		const launched: string[] = [];
		const s = surface({
			cap: 3, exec: true,
			duringRank: () => {
				const l = ref.l!;
				const wl = l.inFlight().map((x) => x.workload.id).filter((id) => id !== STANDING_WORKLOAD_ID).at(-1)!;
				const r = reserve(l, wl, ORDER, 3);
				if (r.ok) launched.push(wl);
			},
		});
		ref.l = s.l;
		const r = await s.ask("Tidy the README wording", { intake: "queue" });
		expect(launched).toEqual([r.id]);
		expect(r.text).toContain(`queued, then started at once: launch: ${laneIdOf(r.id!, 1)} cause first requested-by test`);
		expect(r.text).not.toContain("queued, position");
		expect(s.f.execs.calls).toEqual([]);
		expect(isQueuedNow(s.l, r.id!)).toBe(false);
	});

	test("intake queue below the cap: queued at 1 of 1, then the open's trigger starts it into a free slot (cause first)", async () => {
		const s = surface({ cap: 3, exec: true });
		expect(startedIdle(s.l, s.l.now())).toEqual([]);
		const r = await s.ask("Tidy the README wording", { intake: "queue" });
		expect(r.details!.queued).toBe("intake queue");
		expect(r.text).toContain(`${POSITION(1, 1)}; started at once into a free slot`);
		expect(launches(s.l, r.id!)).toEqual([`launch: ${laneIdOf(r.id!, 1)} cause first requested-by test`]);
		expect(isQueuedNow(s.l, r.id!)).toBe(false);
	});

	test("a started-idle count equal to the cap does not queue; one more does", async () => {
		const s = surface({ cap: 2 });
		s.idle("started 1");
		s.idle("started 2");
		const equal = await s.ask("Tidy the README wording");
		expect(equal.text).not.toContain("queued,");
		expect(equal.details!.queued).toBeNull();
		expect(s.l.entries(equal.id!, "assumption").some((e) => e.body.startsWith("queued:"))).toBe(false);
		s.idle("started 3");
		const over = await s.ask("Tidy the docs index");
		expect(over.text).toContain(POSITION(1, 1));
	});

	test("intake now: Jo's unspent input opens past the cap and spends it; the same input again, none, or not Jo's is refused with nothing opened", async () => {
		const s = surface({ cap: 1 });
		s.idle("started 1");
		s.idle("started 2");
		const input = s.input("open it now, past the queue");
		const r = await s.ask("HIGH: the urgent fix", { intake: "now", inputId: input });
		expect(r.details!.queued).toBeNull();
		expect(r.text).not.toContain("queued,");
		expect(inputSpent(s.l, input)).toBe(r.id);
		const reading = s.l.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.body.startsWith("reading: "));
		expect(reading.map((e) => [e.created_by, e.body])).toEqual([[SURFACE_BY, `reading: open past the intake cap (input ${input} instructs ${r.id})`]]);

		const before = s.workloads();
		const again = await s.ask("HIGH: another urgent fix", { intake: "now", inputId: input });
		expect(again.text).toBe(`Refused: ${input} already instructed ${r.id}, and one input is recorded once. Nothing was opened.`);
		const none = await s.ask("HIGH: another urgent fix", { intake: "now" });
		expect(none.text).toStartWith("Refused: intake now opens past the intake cap on Jo's word: pass inputId");
		const forged = await s.ask("HIGH: another urgent fix", { intake: "now", inputId: "in-notjos" });
		expect(forged.text).toBe("Refused: in-notjos is not an input Jo typed at the surface. Nothing was opened.");
		const stray = await s.ask("HIGH: another urgent fix", { inputId: s.input("something else") });
		expect(stray.text).toStartWith("Refused: inputId spends Jo's input on intake now");
		expect(s.workloads()).toBe(before);
	});
});

// ---- the gate --------------------------------------------------------------------------------------------------------

describe("the queue gate (D5-D7)", () => {
	test("Jo's launch-requested on a queued workload below the top launches it at once (cause request in every mode, so the first launch consumes it), ending its queued state", () => {
		for (const config of [ORDER, SHOW]) {
			const { l, open } = world();
			const top = open("HIGH top", { unblocks: 0.9, queued: true });
			const low = open("low", { unblocks: 0.1, queued: true });
			expect(reserve(l, low, config)).toEqual({ ok: false, reason: "queued: position 2" });
			const req = request(l, low);
			expect({ mode: config.mode, r: reserve(l, low, config) }).toEqual({ mode: config.mode, r: { ok: true, laneId: laneIdOf(low, 1), cause: `request ${req}` } });
			expect(isQueuedNow(l, low)).toBe(false);
			expect(queuePosition(l, top, l.now())).toMatchObject({ position: 1, of: 1 });
		}
	});

	test("an earlier lane still live refuses a queued workload the queue gate would hold: held, before the gate, with no launch: and no rank-shown: written, in every mode (PLAN wl-mvifaz8r8dieps R14)", () => {
		for (const config of MODES) {
			const { l, open } = world();
			open("HIGH top", { unblocks: 0.9, repo: REPO_B, queued: true });
			const low = open("low", { unblocks: 0.1, queued: true });
			// an earlier lane's runner started on low and has no lane-exit:; with no launch: of its own, low stays queued, cause first
			const earlier = laneIdOf(low, 1);
			l.recordEntry({ by: LANE_RUNNER_BY, workloadId: low, kind: "assumption", body: laneStartedBody(earlier, { pid: 4101, start: "Mon Oct 20 11:00:00 2026", session: null, argv: [], runnerPid: 4001 }) });
			const rankShown = () => l.db.query<{ n: number }, []>("SELECT count(*) AS n FROM entries WHERE body LIKE 'rank-shown:%'").get()!.n;
			const shownBefore = rankShown();
			// with that lane gone, the queue gate alone refuses low: top, queued above it, is launchable
			expect({ mode: config.mode, r: reserve(l, low, config) }).toEqual({ mode: config.mode, r: { ok: false, reason: "queued: position 2" } });
			const p = fakeProbe({ omp: "same", runner: "gone" });
			expect({ mode: config.mode, r: reserve(l, low, config, 3, false, undefined, p.probeFor) }).toEqual({ mode: config.mode, r: { ok: false, reason: `held: ${earlier} still running (omp pid 4101)` } });
			expect(p.calls).toEqual([{ laneId: earlier, what: "omp", pid: 4101 }]);
			expect(launches(l, low)).toEqual([]);
			expect(rankShown()).toBe(shownBefore);
			expect(isQueuedNow(l, low)).toBe(true);
		}
	});

	test("`as2 lane` on a queued user-driven workload is never gated and ends its queued state", () => {
		const { l, open } = world();
		open("HIGH top", { unblocks: 0.9, queued: true });
		const byHand = open("by hand", { unblocks: 0.1, mode: "user-driven", queued: true });
		expect(reserve(l, byHand, ORDER, 3, true)).toMatchObject({ ok: true, cause: "interactive" });
		expect(isQueuedNow(l, byHand)).toBe(false);
	});

	test("a queued user-driven workload keeps its position but never holds a slot from the autonomous one below it", () => {
		const { l, open } = world();
		const user = open("HIGH: by hand", { unblocks: 0.9, mode: "user-driven", queued: true });
		const auto = open("autonomous", { unblocks: 0.1, queued: true });
		expect(queuePosition(l, user, l.now())).toMatchObject({ position: 1, of: 2 });
		expect(queuePosition(l, auto, l.now())).toMatchObject({ position: 2, of: 2 });
		expect(reserve(l, auto, ORDER)).toMatchObject({ ok: true, cause: "first" });
	});

	test("only the surface writes queued:; a lane's queued: line is dropped", () => {
		const { l, open } = world();
		const wl = open("x");
		l.recordEntry({ by: "lane-x-1", workloadId: wl, kind: "assumption", body: "queued: forged" });
		expect(isQueuedNow(l, wl)).toBe(false);
		queue(l, wl);
		expect(isQueuedNow(l, wl)).toBe(true);
	});

	test("preemptFor counts a pinned queued workload as waiting only when the queue gate admits it", () => {
		const { l, open } = world();
		const running = open("L, running, unruled", { unblocks: 0.05 });
		live(l, running);
		const q2 = open("Q2, queued, ruled second", { queued: true });
		const q1 = open("Q1, queued, ruled first", { queued: true });
		pin(l, q2);
		pin(l, q1);
		expect(queueOrder(l, l.now()).map((i) => i.workloadId)).toEqual([q1, q2]);
		expect(preemptFor(l, l.now(), 1, ORDER, SURFACE_BY).paused).toMatchObject({ workloadId: running, forWl: q1 });
		// Q2 is below Q1 in the queue, so it is not a second waiter that would ask for a second stop
		expect(preemptFor(l, l.now(), 1, ORDER, SURFACE_BY)).toEqual({ paused: null, reason: "1 priority stop(s) already on their way for 1 ruled workload(s)" });
	});
});

// ---- the held warning (D8) -------------------------------------------------------------------------------------------

describe("errorLines and a queued workload (D8)", () => {
	test("no held line for a queued workload past holdHours; a held message on it still surfaces", () => {
		const { l, open } = world();
		const queued = open("queued", { queued: true });
		const plain = open("not queued");
		const later = new Date(Date.parse(l.now()) + 48 * 3_600_000).toISOString();
		const held = () => errorLines(l, l.inFlight(), { now: later, holdHours: 24 }).filter((e) => e.kind === "held");
		expect(held().map((e) => e.workloadId)).toEqual([plain]);
		const msg = l.enqueue({ by: SURFACE_BY, workloadId: queued, sender: "jo", recipient: laneIdOf(queued, 1), body: "a note for its lane" });
		const lines = held();
		expect(lines.map((e) => [e.workloadId, e.rowId])).toEqual([[queued, msg], [plain, plain]]);
		expect(lines[0]!.line).toContain(`message ${msg}`);
	});
});
