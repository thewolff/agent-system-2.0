// Jev ranking's launch gate (PLAN wl-mv8k039gvogt8g § 2 D6, D7; § 3 tests T12, T15–T20). The gate is driven through the
// real paths: the starter's reservation (`reserve` in surface/scripts/lane.ts, the policy `reserveOrExit` hands to
// `reserveLane`), the surface's pre-check and exec (surface/extensions/launch.ts `triggerLaunch` / `launchVerdict`, the
// open tool's and the wake tick's), and the drain as the process it is, against the fake omp (surface/test/helpers.ts
// `laneRoot`). The in-process cases run the same `reserve` on a temp ledger with the `jevRank` value passed in; the
// real-process cases read it from the temp HOME's profile config, as the starter and the drain do.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { launchVerdict, triggerLaunch } from "../extensions/launch";
import orchestratorSurface from "../index";
import { spendBody } from "../src/ceiling";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, doneBody, laneDiedExitBody, laneExitBody, laneStopRequestBody, launchRequestedBody, STARTER_EXIT, verdictOf } from "../src/launch";
import { briefHash, formatOverride, formatSignal, goalsHash, parseShown, rankDay, rankOpen, type SignalAnswers } from "../src/rank";
import { parallelRead, parallelVerdict, parseRankConfig, type RankConfig, readRankConfig } from "../src/rank-launch";
import { testRequestedBody } from "../src/test-run";
import { MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, RANK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
// A namespace import, as lane-script.test.ts does: a name lane.ts stops exporting fails only the test that calls it.
import * as laneScript from "../scripts/lane";
import {
	ctxOf, drainLinesOf, drainLog, fakePi, git, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, tempLedger, tempRepo, tmp,
} from "./helpers";

const REPO = resolve(import.meta.dir, "..", "..");
const SHOW: RankConfig = { mode: "show", parallelBudgetUsd: 0 };
const ORDER: RankConfig = { mode: "order", parallelBudgetUsd: 0 };
const parallel = (usd: number): RankConfig => ({ mode: "parallel", parallelBudgetUsd: usd });

// ---- fixtures ------------------------------------------------------------------------------------------------------

/** A whole rank signal with no goals set: every term fixed but `unblocks_jo`, so `unblocks` alone orders the items. */
const answers = (unblocks: number): SignalAnswers => ({
	unblocks_jo: { type: "bool", bool: unblocks }, cuts_spend: { type: "bool", bool: 0.1 }, fixes_breakage: { type: "bool", bool: 0.1 },
	states_deadline: { type: "bool", bool: 0.05 }, irreversible: { type: "bool", bool: 0.05 }, deadline_when: { type: "choice", choice: "none", confidence: 0.9 },
	builds_enforcer: { type: "bool", bool: 0.1 },
});
/** A current `priority-signal:` on `wl` as the ranking machinery writes it. */
function signal(l: Ledger, wl: string, unblocks: number): void {
	l.recordEntry({
		by: RANK_BY, workloadId: wl, kind: "assumption",
		body: formatSignal({ brief: briefHash(l.workload(wl)!.brief), goals: goalsHash([]), askedOn: rankDay(l.now()), judge: "typesafe/jev-1.13.0", tokens: 1, cost: 0, answers: answers(unblocks) }),
	});
}
/** Jo's pin (`rank-override:`) on `wl`. */
const pin = (l: Ledger, wl: string) =>
	l.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatOverride({ workloadId: wl, input: `in-${wl}`, shown: "en-shown" }) });
/** Jo's unconsumed `launch-requested:`; its entry id is the cause a launch names. */
const request = (l: Ledger, wl: string) => l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", l.now()) });
/** A lane under a live lease on `wl` (a `lane-*` holder, of either mode). */
const running = (l: Ledger, wl: string) => {
	const r = l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: laneIdOf(wl, 1), leaseMs: 600_000 });
	if (!r.won) throw new Error(`${wl} not claimed`);
};
/** An earlier attempt that ended (`launch:`, released, `lane-exit:`): with no new cause, died-not-relaunched. */
function priorAttempt(l: Ledger, wl: string): void {
	const res = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
	if (!res.ok) throw new Error(res.reason);
	l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: res.laneId });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(res.laneId, { code: 0, signal: null, outcome: "completed" }) });
}
const launches = (l: Ledger, wl: string) => l.entries(wl, "assumption").filter((e) => e.created_by === LANE_STARTER_BY && e.body.startsWith("launch: ")).map((e) => e.body);
const snapshots = (l: Ledger) => controlEntries(l.entries(STANDING_WORKLOAD_ID)).filter((c) => c.prefix === "rank-shown");

const REPO_A = tempRepo();
const REPO_B = tempRepo();

/** A temp ledger with the standing workload, and an open helper: autonomous by default, on REPO_A, scored when `unblocks` is given. */
function world() {
	const { ledger: l } = tempLedger();
	ensureStandingWorkload(l);
	const open = (brief: string, o: { unblocks?: number; repo?: string | null; mode?: "autonomous" | "user-driven" } = {}): string => {
		const wl = l.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: o.mode ?? "autonomous" });
		if (o.repo !== null) recordRepo(l, wl, o.repo ?? REPO_A);
		if (o.unblocks !== undefined) signal(l, wl, o.unblocks);
		return wl;
	};
	return { l, open };
}
const reserve = (l: Ledger, wl: string, config: RankConfig, interactive = false) => laneScript.reserve(l, wl, interactive ? "jo" : "test", interactive, config);

/** An env whose HOME holds the installed profile config `text` (none when null), where `readRankConfig` reads it. */
function homeWith(text: string | null): Record<string, string> {
	const home = tmp("rank-home");
	if (text !== null) {
		const config = join(home, ".omp", "profiles", "agent-system-2", "agent", "config.yml");
		mkdirSync(dirname(config), { recursive: true });
		writeFileSync(config, text);
	}
	return { HOME: home, AGENT_SYSTEM_PROFILE: "agent-system-2" };
}
const ORDER_YAML = "setupVersion: 2\njevRank:\n  mode: order\n  parallelBudgetUsd: 0\n";

// ---- real-process fixtures (lane-script.test.ts's) -----------------------------------------------------------------

const roots: LaneRoot[] = [];
const makeRoot = (yaml: string | null, over: Record<string, string> = {}): LaneRoot => {
	const r = laneRoot(over);
	if (yaml !== null) writeFileSync(join(r.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml"), yaml);
	roots.push(r);
	return r;
};
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);
const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
/** An autonomous workload on the root's repo with its done: line, scored when `unblocks` is given. */
function openIn(r: LaneRoot, brief: string, unblocks?: number): string {
	const l = ledgerOf(r);
	try {
		ensureStandingWorkload(l);
		const wl = l.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		if (unblocks !== undefined) signal(l, wl, unblocks);
		return wl;
	} finally {
		l.close();
	}
}
const lane = (r: LaneRoot, args: string[]) => sh(["bun", LANE_SCRIPT, ...args], r.repo, r.env);
/**
 * Runs the drain itself to its end (`lane.ts drain <after>`, the process a runner's exit spawns detached) and returns its
 * pid from its `start` line. The starters it runs reserve and spawn runners whose fake omp hangs (`setScript` first), so a
 * launched lane holds its slot for the rest of the test and the drain's next round sees it; `stopAll` ends them.
 */
function drain(r: LaneRoot, after: string): number {
	const x = lane(r, ["drain", after]);
	expect(x.code).toBe(0);
	const starts = [...readFileSync(drainLog(r), "utf8").matchAll(new RegExp(`start (\\d+) after ${after}\\b`, "g"))];
	return Number(starts[starts.length - 1]![1]);
}
/**
 * Jo's stop for every lane the test launched, so no hanging fake omp outlives it (the runners' drains settle in afterAll).
 * The script is switched to one that completes first: a stopped runner's exit spawns a drain, which can launch a
 * workload still waiting (with one slot, the one this test's drain skipped), and that lane must end on its own.
 */
function stopAll(r: LaneRoot, wls: readonly string[]): void {
	setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
	const l = ledgerOf(r);
	for (const wl of wls) {
		const holder = l.workload(wl)?.holder;
		if (holder?.startsWith("lane-")) l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(holder, "mode-flip", "jo") });
	}
	l.close();
}
const hang = (r: LaneRoot) => setScript(r, { steps: [{ hang: true }] });
/** A fake pi whose exec runs the real starter the surface names, in the root's environment. */
function execPi(r: LaneRoot) {
	const f = fakePi(undefined, { exec: true });
	f.execs.answer = (command, args) => {
		const x = sh([command, ...args], r.repo, r.env);
		return { stdout: x.out, stderr: x.err, code: x.code, killed: false };
	};
	return f;
}

// ---- T12 -----------------------------------------------------------------------------------------------------------

describe("T12 as2 rank-mode", () => {
	const SCRIPT = join(REPO, "surface", "scripts", "rank-mode.ts");
	const TEMPLATE = join(REPO, "profile", "config.yml");
	function setup(text: string | null) {
		const env = homeWith(text);
		const bin = tmp("rank-mode-bin");
		const ran = join(bin, "omp-ran");
		writeFileSync(join(bin, "omp"), `#!/bin/sh\ntouch '${ran}'\nexit 97\n`, { mode: 0o755 });
		const config = join(env.HOME!, ".omp", "profiles", "agent-system-2", "agent", "config.yml");
		const run = (...args: string[]) => {
			const p = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: { ...env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
			return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
		};
		const parsed = () => Bun.YAML.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
		const others = (doc: Record<string, unknown>) => Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "jevRank"));
		return { env, config, run, parsed, others, ompRan: () => existsSync(ran) };
	}

	test("on the installed template: sets jevRank.mode and the budget, prints old -> new, keeps every other key, never runs omp; readRankConfig reads what it wrote", () => {
		const s = setup("");
		copyFileSync(TEMPLATE, s.config);
		const before = s.parsed();
		expect(before.jevRank).toEqual({ mode: "show", parallelBudgetUsd: 0 });

		const order = s.run("order");
		expect(order.code).toBe(0);
		expect(order.out).toContain("jevRank: mode show parallelBudgetUsd 0 -> mode order parallelBudgetUsd 0");
		expect(s.parsed().jevRank).toEqual({ mode: "order", parallelBudgetUsd: 0 });
		expect(s.others(s.parsed())).toEqual(s.others(before));
		expect(readRankConfig(s.env)).toEqual({ mode: "order", parallelBudgetUsd: 0 });

		const par = s.run("parallel", "--budget", "12.5");
		expect(par.code).toBe(0);
		expect(par.out).toContain("jevRank: mode order parallelBudgetUsd 0 -> mode parallel parallelBudgetUsd 12.5");
		expect(readRankConfig(s.env)).toEqual({ mode: "parallel", parallelBudgetUsd: 12.5 });

		// show reverses the mode; with no --budget the budget in force is kept
		const show = s.run("show");
		expect(show.code).toBe(0);
		expect(show.out).toContain("-> mode show parallelBudgetUsd 12.5");
		expect(readRankConfig(s.env)).toEqual({ mode: "show", parallelBudgetUsd: 12.5 });
		expect(s.others(s.parsed())).toEqual(s.others(before));
		expect(s.ompRan()).toBe(false);
	});

	test("an unknown mode or a malformed budget is refused and writes nothing; a missing config is refused", () => {
		const s = setup("setupVersion: 2\njevRank:\n  mode: order\n  parallelBudgetUsd: 3\npairSuggest: off\n");
		const bytes = readFileSync(s.config, "utf8");
		for (const args of [["fast"], [], ["ORDER"], ["order", "--budget", "abc"], ["order", "--budget", "-1"], ["order", "--budget"], ["order", "--budget", ""], ["order", "--cheap", "3"]]) {
			const r = s.run(...args);
			expect({ args, code: r.code }).toEqual({ args, code: 1 });
			expect(r.err).toContain("nothing was written");
			expect(readFileSync(s.config, "utf8")).toBe(bytes);
		}
		expect(s.run("fast").err).toContain('unknown mode "fast"');
		const none = setup(null);
		const r = none.run("order");
		expect(r.code).toBe(1);
		expect(r.err).toContain("no installed profile config");
		expect(s.ompRan()).toBe(false);
	});

	test("a config with no jevRank gets the block; one written as a flow mapping is replaced whole", () => {
		const s = setup("setupVersion: 2\npairSuggest: off\n");
		expect(s.run("order", "--budget", "4").code).toBe(0);
		expect(s.parsed()).toEqual({ setupVersion: 2, pairSuggest: "off", jevRank: { mode: "order", parallelBudgetUsd: 4 } });
		const flow = setup("setupVersion: 2\njevRank: {mode: parallel, parallelBudgetUsd: 9}\npairSuggest: [wl-a]\n");
		const r = flow.run("show");
		expect(r.out).toContain("jevRank: mode parallel parallelBudgetUsd 9 -> mode show parallelBudgetUsd 9");
		expect(flow.parsed()).toEqual({ setupVersion: 2, jevRank: { mode: "show", parallelBudgetUsd: 9 }, pairSuggest: ["wl-a"] });
	});
});

// ---- T15 -----------------------------------------------------------------------------------------------------------

describe("T15 mode read; show changes no launch", () => {
	test("missing, malformed and show read as show; a valid mode keeps it, a malformed budget reads 0", () => {
		expect(readRankConfig(homeWith(null))).toEqual(SHOW);
		expect(readRankConfig(homeWith("setupVersion: 2\n"))).toEqual(SHOW);
		expect(readRankConfig(homeWith("jevRank: loud\n"))).toEqual(SHOW);
		expect(readRankConfig(homeWith("jevRank:\n  mode: fast\n  parallelBudgetUsd: 5\n"))).toEqual(SHOW);
		expect(readRankConfig(homeWith("jevRank: [order]\n"))).toEqual(SHOW);
		expect(readRankConfig(homeWith("jevRank: {\n"))).toEqual(SHOW);
		expect(readRankConfig(homeWith("jevRank:\n  mode: show\n  parallelBudgetUsd: 5\n"))).toEqual({ mode: "show", parallelBudgetUsd: 5 });
		expect(readRankConfig(homeWith("jevRank:\n  mode: parallel\n  parallelBudgetUsd: -3\n"))).toEqual({ mode: "parallel", parallelBudgetUsd: 0 });
		expect(readRankConfig(homeWith("jevRank:\n  mode: parallel\n  parallelBudgetUsd: lots\n"))).toEqual({ mode: "parallel", parallelBudgetUsd: 0 });
		expect(readRankConfig(homeWith(ORDER_YAML))).toEqual(ORDER);
	});

	test("show: the open and tick paths admit the lower-ranked workload as today (cause first, even with Jo's request pending), and the starter reserves it", async () => {
		const { l, open } = world();
		const lo = open("lo: older, Jev ranks it lower", { unblocks: 0.1 });
		const hi = open("hi: newer, Jev ranks it higher", { unblocks: 0.9 });
		const req = request(l, lo);
		const env = homeWith("setupVersion: 2\n");
		expect(launchVerdict(l, env, lo)).toEqual({ launch: true, cause: { kind: "first" } });
		const f = fakePi(undefined, { exec: true });
		const out = await triggerLaunch(f.pi, l, env, lo, "open");
		expect(out.attempted).toBe(true);
		expect(f.execs.calls.map((c) => c.args.slice(1, 3))).toEqual([["launch", lo]]);
		// the starter's reservation: today's cause, and today's leftover request (PLAN § 7 risk 5) stays unconsumed
		const r = reserve(l, lo, SHOW);
		expect(r).toMatchObject({ ok: true, cause: "first" });
		expect(launches(l, lo)).toEqual([`launch: ${laneIdOf(lo, 1)} cause first requested-by test`]);
		expect(launches(l, lo).some((b) => b.includes(req))).toBe(false);
		expect(reserve(l, hi, SHOW)).toMatchObject({ ok: true, cause: "first" });
	});

	test("show: the drain picks today's workload (oldest first, not Jev's top) and logs one rank-shadow line naming what order would have tried", () => {
		const r = makeRoot(null, { AGENT_SYSTEM_MAX_LANES: "1" });
		const lo = openIn(r, "lo: older, Jev ranks it lower", 0.1);
		const hi = openIn(r, "hi: newer, Jev ranks it higher", 0.9);
		hang(r);
		const pid = drain(r, "wl-ended");
		stopAll(r, [lo, hi]);
		expect(drainLinesOf(r, pid).map((x) => x.replace(/: .*$/, ""))).toEqual([
			`start ${pid} after wl-ended`, `rank-shadow ${pid} picked ${lo} ranked-would ${hi} parallel start`, `attempt ${pid} ${lo} exit 0`, `end ${pid} attempts 1`,
		]);
		expect(laneSnapshot(r, lo).bodies).toContain(`${LANE_STARTER_BY} launch: ${laneIdOf(lo, 1)} cause first requested-by lane-runner`);
	}, 60_000);
});

// ---- T16 -----------------------------------------------------------------------------------------------------------

describe("T16 order gate", () => {
	test("two launchable: the lower-ranked is refused `ranked: below <top>` by the reservation and the surface's open and tick checks; the top launches; then the lower one is admitted", async () => {
		const { l, open } = world();
		const lo = open("lo: older, Jev ranks it lower", { unblocks: 0.1 });
		const hi = open("hi: newer, Jev ranks it higher", { unblocks: 0.9 });
		const env = homeWith(ORDER_YAML);
		expect(reserve(l, lo, ORDER)).toEqual({ ok: false, reason: `ranked: below ${hi}` });
		expect(launches(l, lo)).toEqual([]);
		expect(launchVerdict(l, env, lo)).toEqual({ launch: false, reason: `ranked: below ${hi}` });
		const f = fakePi(undefined, { exec: true });
		expect(await triggerLaunch(f.pi, l, env, lo, "open")).toEqual({ attempted: false, code: null, line: `${lo} queued behind ${hi} (Jev rank); it launches once nothing ranked above it is launchable` });
		expect(f.execs.calls).toEqual([]);
		expect(reserve(l, hi, ORDER)).toMatchObject({ ok: true, cause: "first" });
		// hi now runs: nothing above lo is launchable
		expect(reserve(l, lo, ORDER)).toMatchObject({ ok: true, cause: "first" });
	});

	test("a pinned workload Jev ranks lower is admitted first; the unpinned top is refused below it", () => {
		const { l, open } = world();
		const lo = open("lo, pinned by Jo", { unblocks: 0.1 });
		const hi = open("hi", { unblocks: 0.9 });
		pin(l, lo);
		expect(reserve(l, hi, ORDER)).toEqual({ ok: false, reason: `ranked: below ${lo}` });
		expect(reserve(l, lo, ORDER)).toMatchObject({ ok: true });
	});

	test("Jo's request on a never-attempted lower-ranked workload admits with cause request <id>; after that lane's done-because: and release, launchable no longer sees the request", () => {
		const { l, open } = world();
		const lo = open("lo", { unblocks: 0.1 });
		open("hi", { unblocks: 0.9 });
		const req = request(l, lo);
		const rows = l.launchRows(lo, 3)!;
		expect(verdictOf(rows)).toEqual({ launch: true, cause: { kind: "first" } });
		const r = reserve(l, lo, ORDER);
		expect(r).toEqual({ ok: true, laneId: laneIdOf(lo, 1), cause: `request ${req}` });
		l.recordEntry({ by: laneIdOf(lo, 1), workloadId: lo, kind: "assumption", body: "done-because: the probe is done" });
		l.releaseWorkload(lo, { by: laneIdOf(lo, 1), holder: laneIdOf(lo, 1) });
		expect(verdictOf(l.launchRows(lo, 3)!)).toEqual({ launch: false, reason: "awaiting-close" });
		expect(reserve(l, lo, ORDER)).toEqual({ ok: false, reason: "awaiting-close" });
		expect(launches(l, lo)).toHaveLength(1);
	});

	test("a relaunch request and an interactive start are admitted below a launchable top", () => {
		const { l, open } = world();
		const lo = open("lo, ran once", { unblocks: 0.1 });
		const byHand = open("by hand", { unblocks: 0.2, mode: "user-driven" });
		open("hi", { unblocks: 0.9 });
		priorAttempt(l, lo);
		const req = request(l, lo);
		expect(reserve(l, lo, ORDER)).toEqual({ ok: true, laneId: laneIdOf(lo, 2), cause: `request ${req}` });
		expect(reserve(l, byHand, ORDER, true)).toMatchObject({ ok: true, cause: "interactive" });
	});

	/** A lane on `wl` that died with an open slice and its `lane-died:` recorded: relaunch 1 is due. */
	function deadLane(l: Ledger, wl: string): string {
		const res = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
		if (!res.ok) throw new Error(res.reason);
		l.addSlice({ by: res.laneId, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(res.laneId, { code: 1, signal: null, outcome: "error" }) });
		l.enqueue({ by: LANE_RUNNER_BY, workloadId: wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedExitBody(res.laneId, "error", 1, null) });
		l.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: res.laneId });
		return res.laneId;
	}

	test("PLAN wl-mvfqvd5hy8zv28 § 1.3: a train request for a dead lane is folded into its relaunch and waits below a higher-ranked launchable workload; then admitted, consuming it", () => {
		const { l, open } = world();
		const lo = open("lo, its lane died", { unblocks: 0.1 });
		const hi = open("hi", { unblocks: 0.9 });
		const dead = deadLane(l, lo);
		const train = l.recordEntry({ by: MERGE_TRAIN_BY, workloadId: lo, kind: "assumption", body: launchRequestedBody(MERGE_TRAIN_BY, l.now(), "train task tt-1 owner") });
		expect(verdictOf(l.launchRows(lo, 3)!)).toEqual({ launch: true, cause: { kind: "relaunch", lane: dead, n: 1, request: train } });
		expect(reserve(l, lo, ORDER)).toEqual({ ok: false, reason: `ranked: below ${hi}` });
		expect(launches(l, lo)).toHaveLength(1);
		running(l, hi);
		expect(reserve(l, lo, ORDER)).toEqual({ ok: true, laneId: laneIdOf(lo, 2), cause: `relaunch ${dead} 1 ${train}` });
	});

	test("PLAN wl-mvfqvd5hy8zv28 § 1.3: Jo's request on a dead lane still jumps the rank", () => {
		const { l, open } = world();
		const lo = open("lo, its lane died", { unblocks: 0.1 });
		open("hi", { unblocks: 0.9 });
		deadLane(l, lo);
		const req = request(l, lo);
		expect(reserve(l, lo, ORDER)).toEqual({ ok: true, laneId: laneIdOf(lo, 2), cause: `request ${req}` });
	});

	test("real paths: the open check queues the lower one with no starter run, the starter the tick execs refuses it with nothing written, the top launches, and a drain then starts the lower one", async () => {
		const r = makeRoot(ORDER_YAML);
		const lo = openIn(r, "lo: older, Jev ranks it lower", 0.1);
		const hi = openIn(r, "hi: newer, Jev ranks it higher", 0.9);
		hang(r);
		const l = ledgerOf(r);
		try {
			const f = execPi(r);
			expect((await triggerLaunch(f.pi, l, r.env, lo, "open")).line).toBe(`${lo} queued behind ${hi} (Jev rank); it launches once nothing ranked above it is launchable`);
			expect(f.execs.calls).toEqual([]);
			expect(launchVerdict(l, r.env, lo)).toEqual({ launch: false, reason: `ranked: below ${hi}` });
			const tick = lane(r, ["launch", lo, "--requested-by", "tick"]);
			expect(tick.code).toBe(STARTER_EXIT["not-launchable"]);
			expect(tick.err).toContain(`${lo} not launched: ranked: below ${hi}`);
			expect(launches(l, lo)).toEqual([]);
			const top = await triggerLaunch(f.pi, l, r.env, hi, "open");
			expect(top).toMatchObject({ attempted: true, code: 0 });
			expect(top.line).toStartWith(`${hi}: lane ${laneIdOf(hi, 1)} runner `);
			// hi holds its slot now: nothing above lo is launchable, and the drain starts it
			const pid = drain(r, hi);
			expect(drainLinesOf(r, pid).filter((x) => x.startsWith("attempt ")).map((x) => x.replace(/: .*$/, ""))).toEqual([`attempt ${pid} ${lo} exit 0`]);
			expect(launches(l, lo)).toEqual([`launch: ${laneIdOf(lo, 1)} cause first requested-by lane-runner`]);
		} finally {
			l.close();
			stopAll(r, [lo, hi]);
		}
	}, 60_000);

	test("real drain: it walks Jev's order, so with one slot the newer top workload starts, not the oldest, and the refused one is never started", () => {
		const r = makeRoot(ORDER_YAML, { AGENT_SYSTEM_MAX_LANES: "1" });
		const lo = openIn(r, "lo: older, Jev ranks it lower", 0.1);
		const hi = openIn(r, "hi: newer, Jev ranks it higher", 0.9);
		hang(r);
		const pid = drain(r, "wl-ended");
		stopAll(r, [lo, hi]);
		expect(drainLinesOf(r, pid).map((x) => x.replace(/: .*$/, ""))).toEqual([`start ${pid} after wl-ended`, `attempt ${pid} ${hi} exit 0`, `end ${pid} attempts 1`]);
		const l = ledgerOf(r);
		expect(launches(l, lo)).toEqual([]);
		l.close();
	}, 60_000);
});

// ---- T17 -----------------------------------------------------------------------------------------------------------

describe("T17 parallel: files", () => {
	const big = parallel(1_000);
	test("one repository however it is spelled holds; no repo: row or an unresolvable one holds; two repositories start", () => {
		const { l, open } = world();
		const x = open("x, running", { unblocks: 0.9 });
		running(l, x);
		const link = join(tmp("rank-link"), "repo-link");
		symlinkSync(REPO_A, link);
		const worktree = join(tmp("rank-wt"), "wt");
		expect(git(REPO_A, ["worktree", "add", "-q", "-b", `wt-${Date.now()}`, worktree]).code).toBe(0);
		const holds: [string | null, RegExp][] = [
			[REPO_A, /^files: same repository as /],
			[`${REPO_A}/`, /^files: same repository as /],
			[link, /^files: same repository as /],
			[worktree, /^files: same repository as /],
			[null, /records no repository$/],
			[join(tmp("rank-none"), "missing"), /does not resolve/],
		];
		for (const [repo, why] of holds) {
			const c = open(`candidate on ${repo}`, { unblocks: 0.1, repo });
			const v = parallelVerdict(l, c, l.now(), big);
			expect({ repo, verdict: v.verdict }).toEqual({ repo, verdict: "hold" });
			expect(v.reason).toMatch(why);
		}
		expect(parallelVerdict(l, open("candidate on B", { unblocks: 0.1, repo: REPO_B }), l.now(), big)).toEqual({ verdict: "start", reason: `clear of ${x}` });
	});

	test("the gate refuses `parallel: files: …` through the reservation and admits the other repository's workload", () => {
		const { l, open } = world();
		const x = open("x, running", { unblocks: 0.9 });
		running(l, x);
		const same = open("same repo", { unblocks: 0.3 });
		const other = open("other repo", { unblocks: 0.1, repo: REPO_B });
		// `same` ranks above `other`; the parallel rule holds `same`, and a held higher one never queues the ones below it
		const r = reserve(l, same, big);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.reason).toStartWith(`parallel: files: same repository as ${x}`);
		expect(reserve(l, other, big)).toMatchObject({ ok: true, cause: "first" });
	});

	test("an interactive lane counts as running", () => {
		const { l, open } = world();
		const u = open("by hand, running", { unblocks: 0.9, mode: "user-driven" });
		running(l, u);
		expect(parallelVerdict(l, open("same repo", { unblocks: 0.1 }), l.now(), big).reason).toBe(`files: same repository as ${u} (${resolve(REPO_A, ".git")})`);
		expect(parallelVerdict(l, open("other repo", { unblocks: 0.1, repo: REPO_B }), l.now(), big).verdict).toBe("start");
	});

	test("parallelRead gives the verdict for the top items in every mode, running ones as hold", () => {
		const { l, open } = world();
		const x = open("x, running", { unblocks: 0.9 });
		running(l, x);
		const same = open("same repo", { unblocks: 0.7 });
		const other = open("other repo", { unblocks: 0.1, repo: REPO_B });
		expect(parallelRead(l, l.now(), rankOpen(l, l.now()), big).map((p) => [p.workloadId, p.verdict])).toEqual([[x, "hold"], [same, "hold"], [other, "start"]]);
		expect(parallelRead(l, l.now(), rankOpen(l, l.now()), SHOW, 1)).toEqual([{ workloadId: x, verdict: "hold", reason: "running" }]);
	});
});

// ---- T18 -----------------------------------------------------------------------------------------------------------

describe("T18 parallel: budget", () => {
	function twoRepos() {
		const w = world();
		const x = w.open("x, running", { unblocks: 0.9 });
		running(w.l, x);
		const c = w.open("candidate", { unblocks: 0.1, repo: REPO_B });
		return { ...w, x, c };
	}
	const spend = (l: Ledger, wl: string, usd: number) =>
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: spendBody(laneIdOf(wl, 1), { usd, tokens: 0, wallMin: 1 }) });

	test("the remaining ceilings ($50 each at normal stakes, less metered spend) must fit parallelBudgetUsd", () => {
		const { l, x, c } = twoRepos();
		expect(parallelVerdict(l, c, l.now(), parallel(100)).verdict).toBe("start");
		expect(parallelVerdict(l, c, l.now(), parallel(99.99)).reason).toStartWith("budget: $100 left on");
		spend(l, x, 30);
		expect(parallelVerdict(l, c, l.now(), parallel(70)).verdict).toBe("start");
		expect(parallelVerdict(l, c, l.now(), parallel(69)).verdict).toBe("hold");
		expect(reserve(l, c, parallel(69))).toMatchObject({ ok: false, reason: expect.stringMatching(/^parallel: budget: \$70 left/) });
		expect(reserve(l, c, parallel(70))).toMatchObject({ ok: true });
	});

	test("a budget of 0 or none holds", () => {
		const { l, c } = twoRepos();
		expect(parallelVerdict(l, c, l.now(), parallel(0)).reason).toStartWith("budget unknown");
		const missing = parseRankConfig({ jevRank: { mode: "parallel" } });
		expect(missing).toEqual(parallel(0));
		expect(reserve(l, c, missing)).toMatchObject({ ok: false, reason: expect.stringMatching(/^parallel: budget unknown/) });
	});

	test("a candidate at or over 80 % of its own ceiling holds", () => {
		const { l, c } = twoRepos();
		spend(l, c, 39.99);
		expect(parallelVerdict(l, c, l.now(), parallel(1_000)).verdict).toBe("start");
		spend(l, c, 40);
		expect(parallelVerdict(l, c, l.now(), parallel(1_000)).reason).toBe(`budget: ${c} is at or past 80 % of its $50 ceiling`);
	});
});

// ---- T19 -----------------------------------------------------------------------------------------------------------

describe("T19 parallel: merge order", () => {
	const big = parallel(1_000);
	test("scores within 0.02 hold; 0.04 apart start; a pin is never a tie", () => {
		const { l, open } = world();
		const x = open("x, running", { unblocks: 0.9 });
		running(l, x);
		const equal = open("equal", { unblocks: 0.9, repo: REPO_B });
		const near = open("near: 0.016 below", { unblocks: 0.82, repo: REPO_B });
		const apart = open("apart: 0.04 below", { unblocks: 0.7, repo: REPO_B });
		expect(parallelVerdict(l, equal, l.now(), big).reason).toMatch(/^merge order: wl-\S+ and wl-\S+ score within 0\.02$/);
		expect(parallelVerdict(l, near, l.now(), big).reason).toMatch(/score within 0\.02$/);
		expect(parallelVerdict(l, apart, l.now(), big).verdict).toBe("start");
		pin(l, x);
		expect(parallelVerdict(l, equal, l.now(), big).verdict).toBe("start");
	});

	test("an unscored one has no merge order and holds", () => {
		const { l, open } = world();
		const x = open("x, running", { unblocks: 0.9 });
		running(l, x);
		const c = open("unscored", { repo: REPO_B });
		expect(parallelVerdict(l, c, l.now(), big).reason).toBe(`merge order: ${c} is unscored`);
	});

	test("a higher-ranked brief naming the lower one's id or PR holds", () => {
		const { l, open } = world();
		const x = open("x, running, ranked lower", { unblocks: 0.1 });
		running(l, x);
		l.recordEntry({
			by: "test-runner", workloadId: x, kind: "assumption",
			body: testRequestedBody({ runId: "tr-abc1", pr: 17, sha: "a".repeat(40), slice: "sl-x", by: laneIdOf(x, 1) }),
		});
		const byId = open(`follow-up once ${x} lands`, { unblocks: 0.9, repo: REPO_B });
		const byPr = open("rebase onto PR #17 first", { unblocks: 0.9, repo: REPO_B });
		const otherPr = open("unrelated to PR #170", { unblocks: 0.9, repo: REPO_B });
		expect(parallelVerdict(l, byId, l.now(), big).reason).toBe(`merge order: ${byId}'s brief names ${x}`);
		expect(parallelVerdict(l, byPr, l.now(), big).reason).toBe(`merge order: ${byPr}'s brief names PR 17 of ${x}`);
		expect(parallelVerdict(l, otherPr, l.now(), big).verdict).toBe("start");
		// through the gate: the equally scored byId (held) and otherPr (closed) do not queue byPr below them
		l.closeWorkload(otherPr, { by: SURFACE_BY });
		expect(reserve(l, byPr, big)).toMatchObject({ ok: false, reason: expect.stringMatching(/^parallel: merge order: /) });
	});
});

// ---- T20 -----------------------------------------------------------------------------------------------------------

describe("T20 Jo's picks write their snapshot in the pick's transaction", () => {
	test("the interactive reservation writes one rank-shown: … by pick (waiting only, Jev order, pins ignored) before launch: … cause interactive", () => {
		const { l, open } = world();
		const x = open("x, running", { unblocks: 0.9 });
		running(l, x);
		const lo = open("lo, pinned", { unblocks: 0.1 });
		const hi = open("hi", { unblocks: 0.7 });
		const u = open("by hand", { unblocks: 0.2, mode: "user-driven" });
		pin(l, lo);
		const r = reserve(l, u, ORDER, true);
		expect(r).toMatchObject({ ok: true, cause: "interactive" });
		const shown = snapshots(l);
		expect(shown).toHaveLength(1);
		expect(shown[0]!.createdBy).toBe(RANK_BY);
		const s = parseShown(shown[0]!.body)!;
		expect(s.by).toBe("pick");
		expect(s.items.map((i) => [i.workloadId, i.state, i.pinned])).toEqual([[hi, "waiting", false], [u, "waiting", false], [lo, "waiting", false]]);
		const launch = l.entries(u, "assumption").find((e) => e.body.startsWith("launch: "))!;
		expect(launch.body).toBe(`launch: ${laneIdOf(u, 1)} cause interactive requested-by jo`);
		expect(shown[0]!.createdAt <= launch.created_at).toBe(true);
	});

	test("a refused interactive reservation (live holder, closed workload) writes neither; a failed launch: write rolls the snapshot back", () => {
		const { l, open } = world();
		const held = open("held by hand", { mode: "user-driven" });
		running(l, held);
		expect(reserve(l, held, SHOW, true)).toEqual({ ok: false, reason: "held" });
		const closed = open("closed", { mode: "user-driven" });
		l.closeWorkload(closed, { by: SURFACE_BY });
		expect(reserve(l, closed, SHOW, true)).toEqual({ ok: false, reason: "closed" });
		const fresh = open("fresh", { mode: "user-driven" });
		l.db.exec("CREATE TRIGGER no_launch BEFORE INSERT ON entries WHEN NEW.body LIKE 'launch: %' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
		expect(() => reserve(l, fresh, SHOW, true)).toThrow("injected");
		expect(snapshots(l)).toEqual([]);
		expect([held, closed, fresh].flatMap((w) => launches(l, w))).toEqual([]);
	});

	test("orchestrator_launch_lane writes one rank-shown: … by pick before its launch-requested:, in one transaction; a refusal writes neither", async () => {
		const voice = join(tmp("voice"), "VOICE.md");
		writeFileSync(voice, "VOICE");
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
		const l = Ledger.open(env.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false });
		const openWl = (brief: string, unblocks: number) => {
			const wl = l.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
			signal(l, wl, unblocks);
			return wl;
		};
		const lo = openWl("lo", 0.1);
		const hi = openWl("hi", 0.9);
		const busy = openWl("busy", 0.5);
		running(l, busy);
		const f = fakePi();
		orchestratorSurface(f.pi, env, {});
		const call = (params: Record<string, unknown>) => f.tool("orchestrator_launch_lane").execute("1", params, undefined, undefined, ctxOf());

		const r = await call({ workloadId: lo });
		const details = r.details;
		const requestId = details && typeof details === "object" && "requestId" in details ? String(details.requestId) : "";
		expect(r.content[0]!.text).toContain(`Recorded launch request ${requestId} on ${lo}`);
		const shown = snapshots(l);
		expect(shown).toHaveLength(1);
		const s = parseShown(shown[0]!.body)!;
		expect(s.by).toBe("pick");
		expect(s.items.map((i) => i.workloadId)).toEqual([hi, lo]);
		const req = l.entries(lo, "assumption").find((e) => e.id === requestId)!;
		expect(req.body).toStartWith("launch-requested: by jo at ");
		expect(shown[0]!.createdAt <= req.created_at).toBe(true);

		// refused (a live lane holds it): nothing written, no snapshot
		expect((await call({ workloadId: busy })).content[0]!.text).toContain("Nothing was written.");
		expect(snapshots(l)).toHaveLength(1);
		// the request's insert fails: the snapshot written before it in the same transaction is rolled back
		l.db.exec("CREATE TRIGGER no_request BEFORE INSERT ON entries WHEN NEW.body LIKE 'launch-requested:%' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
		await expect(call({ workloadId: hi })).rejects.toThrow("injected");
		expect(snapshots(l)).toHaveLength(1);
		l.close();
	});
});
