// The dead-lane relaunch through the surface tick (PLAN wl-mvfqvd5hy8zv28 § 1.3, § 1.4a, § 1.5, § 1.6; sl-rl-surface): a
// real ledger file, the orchestrator surface with its poll timer fired by hand, and a fake `pi.exec` that plays the lane
// starter (`reserveLane` under the starter's own ranked decision, on a second handle, as the starter process does). The
// system clock is set with `setSystemTime`, so the surface's `s.now`, every handle's stamps and the injected advances are
// one clock; it starts well before the wall clock, so SQLite's own lease checks never refuse a claim the predicate allows.
//
// Every needs-you line any read shows (the poll's asides, a wake render, the on-demand read) is collected; a dead lane the
// machinery relaunches or waits to relaunch shows nothing, and a spent budget shows exactly one line, the incident.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { recordRepo } from "../src/decision-log";
import { applyTrain, interpret } from "../src/input";
import {
	DONE_BECAUSE_PREFIX, LANE_CAP_ENV, laneCap, laneDiedExitBody, laneExitBody, launchRequestedBody, laneStopAcceptedBody, laneStopRequestBody, STARTER_EXIT,
} from "../src/launch";
import { ownerTasks, raiseTwiceFailed, recordTrainTask, settleTasks, type TaskView, twiceFailed } from "../src/merge-train";
import { briefHash, formatSignal, goalsHash, rankDay, type SignalAnswers } from "../src/rank";
import { decideRanked, type RankMode, readRankConfig } from "../src/rank-launch";
import { type SurfaceSession, surfaceSession } from "../src/session";
import { LAUNCH_LANE_TOOL, LEDGER_TOOL, MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, RANK_BY, SURFACE_BY, WAKE_READ_TOOL } from "../src/types";
import { ctxOf, fakePi, timers, tmp } from "./helpers";

const MIN = 60_000;
const T0 = Date.parse("2026-03-02T10:00:00.000Z");
/** A relaunched lane's lease: long enough that only a death or an explicit lapse ends it. */
const LEASE = 30 * MIN;
const H0 = "a".repeat(40);

let t = T0;
const at = (ms: number) => {
	t = ms;
	setSystemTime(new Date(ms));
};
const adv = (ms: number) => at(t + ms);
afterEach(() => setSystemTime());

interface Launch {
	wl: string;
	laneId: string;
	cause: string;
	by: string;
}

/** The needs-you bullets in a text: every `- …` line under a `## needs you…` heading, up to the next blank line. */
function needsYouBullets(text: string): string[] {
	const out: string[] = [];
	let inBlock = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("## needs you")) {
			inBlock = true;
			continue;
		}
		if (line.trim() === "" || line.startsWith("#")) inBlock = false;
		else if (inBlock && line.startsWith("- ")) out.push(line.slice(2));
	}
	return out;
}

/** A surface's env: a ledger file, the voice, a HOME whose profile config sets Jev ranking's mode, the lane cap. */
function envFor(o: { cap?: number; rank?: RankMode } = {}): Record<string, string> {
	const home = tmp("relaunch-home");
	const dir = join(home, ".omp", "profiles", "agent-system-2", "agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), `jevRank:\n  mode: ${o.rank ?? "show"}\n`);
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const e = {
		AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: home,
		[LANE_CAP_ENV]: String(o.cap ?? 3),
	};
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}

/** One orchestrator session of a world: its reads (each pushes its needs-you lines to the world's), Jo's turn and launch word. */
interface Session {
	s: SurfaceSession;
	/** Jo's turn: its text; a pending wake rides it as the render, and the wake read is recorded. */
	turn(prompt?: string): Promise<string>;
	/** The on-demand read (LEDGER_TOOL): its needs-you lines. */
	ledgerRead(): Promise<string[]>;
	/** A compaction's wake, taken by Jo's next turn: its needs-you lines. */
	wake(): Promise<string[]>;
	/** One poll: the timer fires (the poll's read, then the catch-up), and the catch-up it started finishes. Its needs-you lines. */
	tick(): Promise<string[]>;
	/** Jo's word to launch a workload (LAUNCH_LANE_TOOL): the tool's text. */
	launchWord(wl: string): Promise<string>;
}

/** One world (see `world`). */
interface World {
	e: Record<string, string>;
	l: Ledger;
	launches: Launch[];
	lines: string[];
	start(): Promise<Session>;
	surface(): Session;
	open(brief: string, mode?: "autonomous" | "user-driven"): string;
	reserve(wl: string): string;
	die(wl: string, laneId: string, h?: Ledger): void;
	launchesOf(wl: string): Launch[];
	lastLane(wl: string): string;
}

/**
 * One world: the env, the lanes' handle on the ledger (the starter's and the runner's writes), every starter run the
 * surface exec'd, and the needs-you lines every read showed. `start()` starts an orchestrator session (a restart when
 * one ran before) whose first read is the wake render, taken by Jo's first turn; `surface()` is the newest session.
 */
function world(o: { cap?: number; rank?: RankMode } = {}): World {
	at(T0);
	const e = envFor(o);
	const l = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
	const launches: Launch[] = [];
	const lines: string[] = [];
	/** The fake starter: `bun lane.ts launch <wl> --requested-by <who>`, reserved as the starter does, the lane then holds the workload. */
	const starter = (args: string[]) => {
		const wl = args[2]!;
		const by = args[4]!;
		const r = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: laneCap(e), leaseMs: LEASE, requestedBy: by, decide: (rows) => decideRanked(l, rows, readRankConfig(e)) });
		if (!r.ok) return { stdout: `not launched: ${r.reason}\n`, stderr: "", code: STARTER_EXIT["not-launchable"]!, killed: false };
		launches.push({ wl, laneId: r.laneId, cause: r.cause, by });
		return { stdout: `launched ${r.laneId}\n`, stderr: "", code: 0, killed: false };
	};

	let session: Session | null = null;
	const start = async (): Promise<Session> => {
		timers.length = 0;
		const f = fakePi(undefined, { exec: true });
		f.execs.answer = (command, args) => (command === "bun" && args[1] === "launch" ? starter(args) : { stdout: "", stderr: "", code: 0, killed: false });
		orchestratorSurface(f.pi, e, {});
		const ctx = ctxOf();
		const s = surfaceSession(ctx, e);
		await f.emit("session_start", { type: "session_start" }, ctx);
		let sentSeen = 0;
		const sess: Session = {
			s,
			turn: async (prompt = "hi") => {
				const r = (await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as { messages: { content: string }[] };
				const text = r.messages.map((m) => m.content).join("\n");
				lines.push(...needsYouBullets(text));
				if (s.owed) await f.tool(WAKE_READ_TOOL).execute("w", { body: "resuming" }, undefined, undefined, ctx);
				return text;
			},
			ledgerRead: async () => {
				const r = (await f.tool(LEDGER_TOOL).execute("l", {}, undefined, undefined, ctx)) as { content: { text: string }[] };
				const got = needsYouBullets(r.content[0]!.text);
				lines.push(...got);
				return got;
			},
			wake: async () => {
				await f.emit("session_compact", { type: "session_compact" }, ctx);
				const before = lines.length;
				await sess.turn();
				return lines.slice(before);
			},
			tick: async () => {
				timers[0]!.fn();
				while (s.launching) {
					const { promise, resolve } = Promise.withResolvers<void>();
					setImmediate(resolve);
					await promise;
				}
				const got = f.sent.slice(sentSeen).filter((x) => x.message.customType === "surface-needs-you").flatMap((x) => needsYouBullets(x.message.content));
				sentSeen = f.sent.length;
				lines.push(...got);
				return got;
			},
			launchWord: async (wl) => {
				const r = (await f.tool(LAUNCH_LANE_TOOL).execute("j", { workloadId: wl }, undefined, undefined, ctx)) as { content: { text: string }[] };
				return r.content[0]!.text;
			},
		};
		await sess.turn();
		session = sess;
		return sess;
	};

	const open = (brief: string, mode: "autonomous" | "user-driven" = "autonomous") => {
		const wl = l.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode });
		l.addSlice({ by: SURFACE_BY, workloadId: wl, task: `do ${brief}`, doneCondition: "done", inputs: "none" });
		return wl;
	};
	/** A lane launched outside the tick (setup): the reservation under the plain predicate. */
	const reserve = (wl: string) => {
		const r = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 9, leaseMs: LEASE, requestedBy: "test", decide: (rows) => decideRanked(l, rows, { mode: "show", parallelBudgetUsd: 0 }) });
		if (!r.ok) throw new Error(r.reason);
		return r.laneId;
	};
	/** The runner's unintended end of `laneId` on `wl`, on handle `h`: an error exit, its `lane-died:`, the release, in one transaction. */
	const die = (wl: string, laneId: string, h: Ledger = l) =>
		h.write(() => {
			h.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: 1, signal: null, outcome: "error" }) });
			h.enqueue({ by: LANE_RUNNER_BY, workloadId: wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedExitBody(laneId, "error", 1, null) });
			h.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: laneId });
		});
	const launchesOf = (wl: string) => launches.filter((x) => x.wl === wl);
	const lastLane = (wl: string) => launchesOf(wl).at(-1)!.laneId;
	const surface = () => session!;
	return { e, l, launches, lines, start, surface, open, reserve, die, launchesOf, lastLane };
}

/** Lines naming a lane's death or an idle end: what § 1.6 hides while the machinery owns the death. */
const deathLines = (lines: readonly string[]) => lines.filter((x) => / died: /.test(x) || / ended \(/.test(x));
const incidentLine = (wl: string, lane: string) => `incident on ${wl}: relaunch of ${lane} stopped after 3/3 retries without progress: `;

/**
 * `wl`'s first lane launched by the tick, then three deaths each relaunched by the tick: relaunch 1 at once, 2 and 3 after
 * the 10-minute gap, polled every minute with no line and no launch inside the gap. Returns the fourth lane, live.
 */
async function threeRelaunches(w: World, wl: string): Promise<string> {
	const s = w.surface();
	if (w.launchesOf(wl).length === 0) {
		await s.tick();
		expect(w.launchesOf(wl)).toHaveLength(1);
	}
	for (let n = 1; n <= 3; n++) {
		adv(2 * MIN);
		const dead = w.lastLane(wl);
		w.die(wl, dead);
		const before = w.launchesOf(wl).length;
		if (n === 1) {
			expect(await s.tick()).toEqual([]);
		} else {
			// the gap: nine polls a minute apart show nothing and launch nothing
			expect(await s.tick()).toEqual([]);
			for (let i = 1; i < 10; i++) {
				adv(MIN);
				expect(await s.tick()).toEqual([]);
				expect(w.launchesOf(wl)).toHaveLength(before);
			}
			adv(MIN);
			expect(await s.tick()).toEqual([]);
		}
		expect(w.launchesOf(wl)).toHaveLength(before + 1);
		expect(w.launchesOf(wl).at(-1)!.cause).toBe(`relaunch ${dead} ${n}`);
	}
	expect(deathLines(w.lines)).toEqual([]);
	return w.lastLane(wl);
}

const answers = (unblocks: number): SignalAnswers => ({
	unblocks_jo: { type: "bool", bool: unblocks }, cuts_spend: { type: "bool", bool: 0.1 }, fixes_breakage: { type: "bool", bool: 0.1 },
	states_deadline: { type: "bool", bool: 0.05 }, irreversible: { type: "bool", bool: 0.05 }, deadline_when: { type: "choice", choice: "none", confidence: 0.9 },
	builds_enforcer: { type: "bool", bool: 0.1 },
});
/** Jev's current signal on `wl`: `unblocks` decides the order. */
function rankSignal(l: Ledger, wl: string, brief: string, unblocks: number) {
	l.recordEntry({
		by: RANK_BY, workloadId: wl, kind: "assumption",
		body: formatSignal({ brief: briefHash(brief), goals: goalsHash([]), askedOn: rankDay(l.now()), judge: "typesafe/jev-1.13.0", tokens: 1, cost: 0, answers: answers(unblocks) }),
	});
}

describe("the tick relaunches a dead lane within the cap, in Jev rank order (§ 1.3)", () => {
	test("two dead workloads, cap 1: the higher-ranked is relaunched first; the other when the slot frees; no death line", async () => {
		const w = world({ cap: 1, rank: "order" });
		const lo = w.open("lo: ranked low");
		rankSignal(w.l, lo, "lo: ranked low", 0.1);
		const hi = w.open("hi: ranked high");
		rankSignal(w.l, hi, "hi: ranked high", 0.9);
		const loLane = w.reserve(lo);
		const hiLane = w.reserve(hi);
		await w.start();
		adv(MIN);
		w.die(lo, loLane);
		w.die(hi, hiLane);
		const s = w.surface();
		expect(await s.tick()).toEqual([]);
		expect(w.launches).toEqual([{ wl: hi, laneId: expect.any(String), cause: `relaunch ${hiLane} 1`, by: "tick" }]);
		// lo waits for the slot: no launch, no line
		adv(MIN);
		expect(await s.tick()).toEqual([]);
		expect(w.launches).toHaveLength(1);
		// hi's relaunched lane ends as intended (parked): the slot frees and lo's relaunch takes it
		const hi2 = w.lastLane(hi);
		w.l.write(() => {
			w.l.recordEntry({ by: LANE_RUNNER_BY, workloadId: hi, kind: "assumption", body: `lane-parked: ${hi2} questions q-1 session /s` });
			w.l.recordEntry({ by: LANE_RUNNER_BY, workloadId: hi, kind: "assumption", body: laneExitBody(hi2, { code: 0, signal: null, outcome: "parked" }) });
			w.l.releaseWorkload(hi, { by: LANE_RUNNER_BY, holder: hi2 });
		});
		adv(MIN);
		await s.tick();
		expect(w.launches.map((x) => [x.wl, x.cause])).toEqual([[hi, `relaunch ${hiLane} 1`], [lo, `relaunch ${loLane} 1`]]);
		expect(deathLines(w.lines)).toEqual([]);
	});

	for (const order of ["train-before-tick", "tick-before-train"] as const) {
		test(`${order}: a merge-train request on a dead lane gives one launch, the higher-ranked first, and no recovered-death line`, async () => {
			const w = world({ cap: 1, rank: "order" });
			const lo = w.open("lo: never launched");
			rankSignal(w.l, lo, "lo: never launched", 0.1);
			const hi = w.open("hi: train owner");
			rankSignal(w.l, hi, "hi: train owner", 0.9);
			const hiLane = w.reserve(hi);
			await w.start();
			const s = w.surface();
			// the reservation holds the only slot: lo is queued
			expect(await s.tick()).toEqual([]);
			expect(w.launches).toEqual([]);
			adv(MIN);
			w.die(hi, hiLane);
			const trainRequest = () =>
				w.l.recordEntry({ by: MERGE_TRAIN_BY, workloadId: hi, kind: "assumption", body: launchRequestedBody("merge-train", w.l.now(), "train task tt-1 on #101") });
			if (order === "train-before-tick") trainRequest();
			expect(await s.tick()).toEqual([]);
			if (order === "tick-before-train") {
				adv(MIN);
				trainRequest();
			}
			for (let i = 0; i < 5; i++) {
				adv(MIN);
				expect(await s.tick()).toEqual([]);
			}
			expect(w.launches).toHaveLength(1);
			expect(w.launches[0]).toMatchObject({ wl: hi, by: "tick" });
			expect(w.launches[0]!.cause).toStartWith(`relaunch ${hiLane} 1`);
			expect(deathLines(w.lines)).toEqual([]);
		});
	}
});

describe("three relaunches, then one incident (§ 1.4a, § 1.5)", () => {
	test("the gaps run on the clock with no line; the fourth death is one incident line, shown once across polls and a restart", async () => {
		const w = world();
		const wl = w.open("fix the flaky thing");
		await w.start();
		const fourth = await threeRelaunches(w, wl);
		adv(2 * MIN);
		w.die(wl, fourth);
		const s = w.surface();
		const shown = await s.tick();
		expect(shown).toHaveLength(1);
		expect(shown[0]).toStartWith(incidentLine(wl, fourth));
		expect(shown[0]).toContain(`lane-died: ${fourth}: error (exit 1)`);
		expect(shown[0]).toContain(`relaunch with \`${LAUNCH_LANE_TOOL}\`, close, or instruct`);
		expect(w.launchesOf(wl)).toHaveLength(4);
		for (let i = 0; i < 12; i++) {
			adv(10 * MIN);
			expect(await s.tick()).toEqual([]);
		}
		await w.start();
		await w.surface().tick();
		expect(await w.surface().ledgerRead()).toEqual([]);
		expect(w.lines).toEqual([shown[0]]);
		expect(w.launchesOf(wl)).toHaveLength(4);
	});

	test("the slot the last death frees is filled by another workload: the incident is still written, and the dead one is not launched", async () => {
		const w = world({ cap: 1 });
		const a = w.open("a: keeps dying");
		await w.start();
		const fourth = await threeRelaunches(w, a);
		const b = w.open("b: waiting for a slot");
		adv(MIN);
		expect(await w.surface().tick()).toEqual([]);
		expect(w.launchesOf(b)).toEqual([]);
		w.die(a, fourth);
		const shown = await w.surface().tick();
		expect(shown).toHaveLength(1);
		expect(shown[0]).toStartWith(incidentLine(a, fourth));
		expect(w.launchesOf(b)).toEqual([{ wl: b, laneId: expect.any(String), cause: "first", by: "tick" }]);
		expect(w.launchesOf(a)).toHaveLength(4);
	});

	test("progress resets the counter: a relaunched lane that opened a slice dies and is relaunched at once as relaunch 1", async () => {
		const w = world();
		const wl = w.open("fix it");
		await w.start();
		const s = w.surface();
		await s.tick();
		const first = w.lastLane(wl);
		adv(MIN);
		w.die(wl, first);
		await s.tick();
		const second = w.lastLane(wl);
		adv(MIN);
		w.die(wl, second);
		await s.tick();
		// relaunch 2 waits; then it launches
		adv(10 * MIN);
		await s.tick();
		const third = w.lastLane(wl);
		expect(w.launchesOf(wl).at(-1)!.cause).toBe(`relaunch ${second} 2`);
		adv(MIN);
		w.l.addSlice({ by: third, workloadId: wl, task: "the next part", doneCondition: "done", inputs: "none" });
		adv(MIN);
		w.die(wl, third);
		expect(await s.tick()).toEqual([]);
		expect(w.launchesOf(wl).at(-1)!.cause).toBe(`relaunch ${third} 1`);
		expect(deathLines(w.lines)).toEqual([]);
	});
});

describe("no relaunch where the machinery owes none (§ 1.1, § 1.3)", () => {
	const cases: [string, (w: World, wl: string, lane: string) => void][] = [
		["parked", (w, wl, lane) => w.l.write(() => {
			w.l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `lane-parked: ${lane} questions q-1 session /s` });
			w.l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(lane, { code: 0, signal: null, outcome: "parked" }) });
			w.l.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: lane });
		})],
		["done-because", (w, wl, lane) => {
			w.l.recordEntry({ by: lane, workloadId: wl, kind: "assumption", body: `${DONE_BECAUSE_PREFIX} the work is done` });
			w.die(wl, lane);
		}],
		["Jo-stopped", (w, wl, lane) => {
			w.l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(lane, "as2-lane-stop", "jo") });
			w.die(wl, lane);
		}],
		["ceiling-stopped", (w, wl, lane) => w.l.write(() => {
			w.l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneStopAcceptedBody(lane, "ceiling") });
			w.l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(lane, { code: null, signal: null, outcome: "stop", reason: "ceiling" }) });
			w.l.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: lane });
		})],
		["paused-only", (w, wl, lane) => {
			const sl = w.l.slices(wl)[0]!.id;
			w.l.raiseQuestion({ by: lane, workloadId: wl, sliceId: sl, body: "which one?", options: ["a", "b"] });
			w.die(wl, lane);
		}],
		["open-question", (w, wl, lane) => {
			const sl = w.l.addSlice({ by: lane, workloadId: wl, task: "ask", doneCondition: "answered", inputs: "none" });
			w.l.raiseQuestion({ by: lane, workloadId: wl, sliceId: sl, body: "which one?", options: ["a", "b"] });
			w.die(wl, lane);
		}],
		["user-driven", (w, wl, lane) => {
			w.l.flipMode(wl, { by: SURFACE_BY, author: "jo", channel: "surface", mode: "user-driven" });
			w.die(wl, lane);
		}],
	];
	for (const [name, end] of cases) {
		test(`${name}: the tick launches nothing for half an hour`, async () => {
			const w = world();
			const wl = w.open(`ends ${name}`);
			const lane = w.reserve(wl);
			await w.start();
			adv(MIN);
			end(w, wl, lane);
			for (let i = 0; i < 30; i++) {
				adv(MIN);
				await w.surface().tick();
			}
			expect(w.launches).toEqual([]);
		});
	}
});

describe("the fourth death is shown as the incident, never raw, whichever read comes first (§ 1.5, § 1.6)", () => {
	const reads: [string, (w: World) => Promise<string[]>][] = [
		["the poll", (w) => w.surface().tick()],
		["a wake render", (w) => w.surface().wake()],
		["the on-demand read", (w) => w.surface().ledgerRead()],
		["the first read after a restart", async (w) => {
			const before = w.lines.length;
			await w.start();
			return w.lines.slice(before);
		}],
	];
	for (const [name, read] of reads) {
		test(`${name}: exactly one line, the incident; later reads show nothing more`, async () => {
			const w = world();
			const wl = w.open("fix the flaky thing");
			await w.start();
			const fourth = await threeRelaunches(w, wl);
			adv(2 * MIN);
			w.die(wl, fourth);
			const shown = await read(w);
			expect(shown).toHaveLength(1);
			expect(shown[0]).toStartWith(incidentLine(wl, fourth));
			adv(MIN);
			expect(await w.surface().tick()).toEqual([]);
			expect(await w.surface().ledgerRead()).toEqual([]);
			expect(w.lines).toEqual(shown);
		});
	}

	test("after the incident: Jo's word launch, progress, more polls and a restart never show that death again", async () => {
		const w = world();
		const wl = w.open("fix the flaky thing");
		await w.start();
		const fourth = await threeRelaunches(w, wl);
		adv(2 * MIN);
		w.die(wl, fourth);
		expect(await w.surface().tick()).toHaveLength(1);
		adv(5 * MIN);
		expect(await w.surface().launchWord(wl)).toContain("launched");
		const fifth = w.lastLane(wl);
		expect(w.launchesOf(wl).at(-1)!.cause).toStartWith("request ");
		adv(MIN);
		w.l.addSlice({ by: fifth, workloadId: wl, task: "a new part", doneCondition: "done", inputs: "none" });
		for (let i = 0; i < 5; i++) {
			adv(5 * MIN);
			expect(await w.surface().tick()).toEqual([]);
		}
		await w.start();
		await w.surface().wake();
		await w.surface().ledgerRead();
		expect(await w.surface().tick()).toEqual([]);
		expect(w.lines.filter((x) => x.includes(fourth))).toHaveLength(1);
		expect(deathLines(w.lines)).toEqual([]);
	});

	test("review r6: a runner death committed between the read's steps is refused by the read's one transaction; the raw death is in no read", async () => {
		const w = world();
		const wl = w.open("fix the flaky thing");
		await w.start();
		const fourth = await threeRelaunches(w, wl);
		// the runner's own connection: no waiting on a lock, so a write inside the surface's transaction fails at once
		const runner = Ledger.open(w.e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false, busyTimeoutMs: 1, busyRetries: 0 });
		const surfaceLedger = w.surface().s.ledger();
		const inFlight = surfaceLedger.inFlight.bind(surfaceLedger);
		let calls = 0;
		const attempts: string[] = [];
		// the read's third inFlight is the lines' own (after the lapse and incident steps): the old split read's gap
		surfaceLedger.inFlight = () => {
			if (++calls === 3) {
				try {
					w.die(wl, fourth, runner);
					attempts.push("committed");
				} catch (err) {
					attempts.push(String(err));
				}
			}
			return inFlight();
		};
		adv(2 * MIN);
		expect(await w.surface().tick()).toEqual([]);
		surfaceLedger.inFlight = inFlight;
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatch(/busy|locked/i);
		// the runner retries after the read: committed; the next read shows the incident only
		w.die(wl, fourth, runner);
		adv(MIN);
		const shown = await w.surface().tick();
		expect(shown).toHaveLength(1);
		expect(shown[0]).toStartWith(incidentLine(wl, fourth));
		expect(await w.surface().wake()).toEqual([]);
		expect(await w.surface().ledgerRead()).toEqual([]);
		expect(deathLines(w.lines)).toEqual([]);
		runner.close();
	});
});

describe("a lapse the drain meets before the tick recorded it (§ 1.4a)", () => {
	test("the drain does not relaunch an unrecorded lapse; the tick records it, and relaunch 2 waits 10 minutes from that record", async () => {
		const w = world();
		const wl = w.open("fix it");
		await w.start();
		const s = w.surface();
		await s.tick();
		const first = w.lastLane(wl);
		adv(MIN);
		w.die(wl, first);
		await s.tick();
		const second = w.lastLane(wl);
		expect(w.launchesOf(wl).at(-1)!.cause).toBe(`relaunch ${first} 1`);
		// the second lane's runner is gone without a word: its lease lapses with no lane-died: row
		adv(LEASE + MIN);
		// the runner's drain (the starter, by another process) runs first: refused, nothing written
		const drain = w.l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: LEASE, requestedBy: "drain", decide: (rows) => decideRanked(w.l, rows, readRankConfig(w.e)) });
		expect(drain).toEqual({ ok: false, reason: "died-not-relaunched" });
		// the next tick records the lapse: its time is the backoff's
		expect(await s.tick()).toEqual([]);
		const recorded = w.l.db.query<{ created_at: string }, [string, string]>("SELECT created_at FROM messages WHERE workload_id = ? AND body LIKE ?").get(wl, `lane-died: ${second}%`);
		expect(recorded?.created_at).toBe(new Date(t).toISOString());
		const recordedAt = t;
		expect(w.launchesOf(wl)).toHaveLength(2);
		for (let i = 1; i < 10; i++) {
			adv(MIN);
			expect(await s.tick()).toEqual([]);
			expect(w.launchesOf(wl)).toHaveLength(2);
		}
		at(recordedAt + 10 * MIN);
		expect(await s.tick()).toEqual([]);
		expect(w.launchesOf(wl).at(-1)!.cause).toBe(`relaunch ${second} 2`);
		expect(deathLines(w.lines)).toEqual([]);
	});
});

describe("a train-owned workload (§ 1.5, § 1.7): the train's settle and alert run each poll", () => {
	const REPO = "thewolff/product";
	const checkout = (): string => {
		const dir = tmp("relaunch-tick-repo");
		for (const args of [["init", "-q"], ["config", "remote.origin.url", `https://github.com/${REPO}.git`]]) {
			const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
			if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
		}
		return dir;
	};
	const view = (pr: number, head: string, branch: string): TaskView => ({
		number: pr, headRefName: branch, headRefOid: head, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" },
	});

	test("the original owner lane and three relaunches die: no needs-you line through the first three deaths, one line (the incident) after the fourth, no failed-twice question", async () => {
		const w = world();
		const cmd = interpret(w.l, "train 101 106");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const train = applyTrain(w.l, cmd, checkout()).workloadId;
		expect(w.l.claimWorkload(train, { by: LANE_STARTER_BY, holder: "lane-train-1", leaseMs: 24 * 60 * MIN }).won).toBe(true);
		const owner = w.open("Fix the feed header");
		recordRepo(w.l, owner, checkout());
		await w.start();
		const s = w.surface();
		const settled: string[] = [];
		const trainPoll = () => {
			const lines = settleTasks(w.l, { train, heads: new Map([[101, H0]]), pushes: new Map([[101, []]]) }, w.l.now());
			for (const body of lines) w.l.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body });
			settled.push(...lines);
			for (const due of twiceFailed(w.l, train)) raiseTwiceFailed(w.l, train, due);
		};
		const poll = async () => {
			trainPoll();
			return s.tick();
		};
		await poll();
		expect(w.launchesOf(owner)).toHaveLength(1);
		adv(MIN);
		const task = recordTrainTask(w.l, { train, by: "lane-train-1", pr: 101, kind: "red", detail: `run tr-x red at ${H0}\nsrc/x.test.ts > case 1: boom`, view: view(101, H0, `wl/${owner}`), trainRepo: REPO });
		if (!task.ok) throw new Error(task.reason);
		for (let n = 1; n <= 3; n++) {
			adv(2 * MIN);
			const dead = w.lastLane(owner);
			w.die(owner, dead);
			const before = w.launchesOf(owner).length;
			for (let i = 0; i < 15 && w.launchesOf(owner).length === before; i++) {
				expect(await poll()).toEqual([]);
				adv(MIN);
			}
			expect(w.launchesOf(owner).at(-1)!.cause).toStartWith(`relaunch ${dead} ${n}`);
		}
		const fourth = w.lastLane(owner);
		adv(2 * MIN);
		w.die(owner, fourth);
		const shown = await poll();
		expect(shown).toHaveLength(1);
		expect(shown[0]).toStartWith(incidentLine(owner, fourth));
		expect(shown[0]).toContain("train #101 held");
		for (let i = 0; i < 9; i++) {
			adv(10 * MIN);
			expect(await poll()).toEqual([]);
		}
		expect(w.lines).toEqual(shown);
		expect(settled).toEqual([]);
		expect(w.l.questions(train)).toEqual([]);
		expect(ownerTasks(w.l, owner).map((x) => x.id)).toEqual([task.task.id]);
		expect(w.launchesOf(owner)).toHaveLength(4);
	});
});
