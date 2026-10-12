// surface/src/chaos.ts against hand-built throwaway ledgers (PLAN wl-mv45yxnkw2251c § 3, sl-chaos-lib):
// the judge ((a) by `kind:rowId`, (b), (c) through `builderLabs`, the settle re-check), the verdict's
// evidence rules, the isolation snapshot and diff over a temp "live" ledger, git repo and lanes root,
// the 03:00 PT window, the rotation, the report path and the report; and the code review r1 fixes: the
// run-owned kill targets (killTargets, killRefusal), fault 5's first holder (firstHolder) and the
// no-follow scratch writers (scratchWriteRefusal and the writers over it); and the r2 fixes: the
// release / lane-exit: straddle (END_RECEIPT_SKEW_MS) and fault 5's second runner judged by its pid
// on a snapshot after its exit, with only exit 7 "already running" a refusal (secondRunnerJudgement);
// and the r3 fix: firstHolder's end receipts bounded below by the injection.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { handSpawnBody } from "../../classifier/src/lab";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { isRunnerCommand } from "../scripts/lane";
import {
	copyIntoScratch, daysSinceEpoch, END_RECEIPT_SKEW_MS, emptySeen, type Evidence, type EvidenceItem, FAULT_EVIDENCE, FAULTS, type FaultName, firstHolder, HarnessError, ISOLATION_LIMIT,
	isolationDiff, type IsolationSnapshot, isolationSnapshot, isScratchRunner, judgePoll, killRefusal, killTargets, laneStarts, liveActorsOf, newStarts, nightlyDue, nightlyFault, type Poll, type ProcRow, PS_SHIM,
	psLine, REFLOG_SKEW_MS, reflogBranchWrites, REMOTE_TRACKING, removeFromScratch, renderReport, reportPath, SECOND_RUNNER_EVIDENCE, sameStart, scratchNewPathRefusal, scratchWriteRefusal, secondRunnerJudgement, type Seen,
	verdict, writeScratchFile,
} from "../src/chaos";
import { laneExitBody, laneStartedBody } from "../src/launch";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { clock, tmp } from "./helpers";

const T0 = "2026-10-11T10:00:00.000Z";
const at = (s: number): string => new Date(Date.parse(T0) + s * 1000).toISOString();
const LANE = "lane-chaos-run1-1";
const noSessions = () => [];

/** A throwaway ledger with the run's workload, its clock at injection. */
function world() {
	const c = clock(T0);
	const ledger = Ledger.open(join(tmp("chaos"), "ledger.db"), { create: true, backup: false, backupOnOpen: false, clock: c.now });
	const wl = ledger.openWorkload({ by: "chaos", brief: "chaos run workload", stakes: "normal", mode: "autonomous", id: "wl-chaos-run1" });
	let seen: Seen = emptySeen();
	const polls: Poll[] = [];
	/** One judge poll `s` seconds after injection. */
	const poll = (s: number): Poll => {
		c.at(at(s));
		const p = judgePoll(ledger, wl, seen, { sessionModels: noSessions });
		seen = p.seen;
		polls.push(p);
		return p;
	};
	return { c, ledger, wl, poll, polls };
}
/** What the scenario builders write through: the throwaway ledger and its workload. */
interface World {
	ledger: Ledger;
	wl: string;
}

/** The lane's normal end: one slice done, then the chaos-hold question raised and the workload released on park. */
function parkedOnQuestion(w: World): { q: string; hold: string } {
	w.ledger.claimWorkload(w.wl, { by: LANE, holder: LANE, leaseMs: 120_000 });
	const done = w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "append one line to chaos/scratch.txt", doneCondition: "bun test chaos/ passes", inputs: "chaos/" });
	w.ledger.completeSlice(done, { by: LANE, artifact: "bun test chaos/ exit 0" });
	const hold = w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "chaos-hold", doneCondition: "Jo answers", inputs: "-" });
	const q = w.ledger.raiseQuestion({ by: LANE, workloadId: w.wl, sliceId: hold, body: "close or keep?", options: ["close", "keep"] });
	w.ledger.releaseWorkload(w.wl, { by: LANE, holder: LANE });
	return { q, hold };
}

/** The runner's record of a killed lane: its death line (held for the surface), its exit, and the release. */
function laneKilled(w: World, laneId = LANE, exitBy = LANE_RUNNER_BY): string {
	const msg = w.ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: w.wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: `lane-died: ${laneId}: died (signal SIGKILL)` });
	w.ledger.recordEntry({ by: exitBy, workloadId: w.wl, kind: "assumption", body: laneExitBody(laneId, { code: null, signal: "SIGKILL", outcome: "died" }) });
	w.ledger.releaseWorkload(w.wl, { by: LANE_RUNNER_BY, holder: laneId });
	return msg;
}

/** Every evidence item the fault names, observed at injection. */
function evidence(fault: FaultName, over: Partial<Evidence> = {}, items?: EvidenceItem[]): Evidence {
	return {
		fault, injectedAt: T0, nonceMisses: [], egress: [], harness: [],
		items: items ?? FAULT_EVIDENCE[fault].map((name) => ({ name, observed: "seen", at: T0 })),
		...over,
	};
}

describe("judge and verdict", () => {
	test("pass: one question line, nothing orphaned, no dead hand; the settle re-check 30 s on agrees", () => {
		const w = world();
		const { q } = parkedOnQuestion(w);
		for (const s of [5, 10, 20, 30, 35, 40]) w.poll(s);
		const p0 = w.polls[0]!;
		expect(p0.a).toEqual({ ok: true, union: [`question:${q}`], present: [`question:${q}`] });
		expect(p0.b).toMatchObject({ ok: true, holder: null, orphans: [] });
		expect(p0.c).toEqual({ ok: true, exitedHands: [], counted: [] });
		const v = verdict(w.polls, evidence("orchestrator-kill-mid-review"));
		expect(v.verdict).toBe("PASS");
		expect(v.deciding?.at).toBe(at(5));
		expect(v.settle?.at).toBe(at(35));
		expect(v.settle).toMatchObject({ ok: true, a: { ok: true }, b: { ok: true }, c: { ok: true } });
		expect(v.atMs).toBe(5_000);
		const ps = { kind: "stand-in", blocked: "EPERM: Operation not permitted, posix_spawn '/bin/ps'" } as const;
		const report = renderReport({
			fault: "orchestrator-kill-mid-review", variant: null, token: "run1", fence: "on", ps, verdict: v,
			timings: { startedAt: T0, setupMs: 61_000, triggerAt: T0, injectedAt: T0 }, evidence: evidence("orchestrator-kill-mid-review"),
			egressLog: [{ phase: "preflight", host: "api.anthropic.com" }], rows: null, runners: [], stubCounts: { "anthropic/claude-sonnet-4-5": 7 },
			isolation: null, scratch: { path: "/tmp/as2-chaos-run1", kept: false }, notes: [],
		});
		const lines = report.split("\n");
		// the report carries the run's structured parts: one ps line as psLine renders it, the isolation limit, the line identity
		expect(lines.filter((l) => l.startsWith("- ps: "))).toEqual([psLine(ps)]);
		expect(lines.some((l) => l.endsWith(ISOLATION_LIMIT))).toBe(true);
		expect(report).toContain(`question:${q}`);
	});

	test("the report's ps line: one per source, naming the stand-in and why the real ps or the stand-in failed", () => {
		const real = psLine({ kind: "real" });
		const standIn = psLine({ kind: "stand-in", blocked: "EPERM-1" });
		const none = psLine({ kind: "none", blocked: "EPERM-2", standIn: "exit-2-3" });
		const unchecked = psLine({ kind: "unchecked" });
		expect([real, standIn, none, unchecked].every((l) => l.startsWith("- ps: "))).toBe(true);
		expect(new Set([real, standIn, none, unchecked]).size).toBe(4);
		expect([real, standIn, none, unchecked].map((l) => l.includes(PS_SHIM))).toEqual([false, true, true, false]);
		expect([standIn.includes("EPERM-1"), none.includes("EPERM-2"), none.includes("exit-2-3")]).toEqual([true, true, true]);
	});

	test("two-line fail: a second identity fails the run at that poll, though the first poll had passed", () => {
		const w = world();
		const { q } = parkedOnQuestion(w);
		w.poll(5);
		const msg = w.ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: w.wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: `lane-died: ${LANE}: died (signal SIGKILL)` });
		const p1 = w.poll(10);
		// the union is in identity order (kind first), not first-seen order: lane-died before question
		expect(p1.a.union).toEqual([`lane-died:${msg}`, `question:${q}`]);
		w.poll(40);
		const v = verdict(w.polls, evidence("orchestrator-kill-mid-review"));
		expect(v).toMatchObject({ verdict: "FAIL", atMs: 10_000, settle: null });
		expect(v.deciding?.at).toBe(at(5));
		expect(v.last?.at).toBe(at(10));
		expect(v.last?.a).toEqual({ ok: false, union: [`lane-died:${msg}`, `question:${q}`], present: [`lane-died:${msg}`, `question:${q}`] });
	});

	test("a changed-text same-identity line counts once: the death line's open-slice count moves, its kind:rowId does not", () => {
		const w = world();
		w.ledger.claimWorkload(w.wl, { by: LANE, holder: LANE, leaseMs: 120_000 });
		const s1 = w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "first", doneCondition: "d", inputs: "i" });
		w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "second", doneCondition: "d", inputs: "i" });
		const msg = laneKilled(w);
		const p0 = w.poll(5);
		w.ledger.completeSlice(s1, { by: SURFACE_BY, artifact: "by hand" });
		const p1 = w.poll(10);
		w.poll(40);
		expect(p1.lines[0]!.identity).toBe(p0.lines[0]!.identity);
		expect(p1.lines[0]!.text).not.toBe(p0.lines[0]!.text);
		expect(p1.a).toEqual({ ok: true, union: [`lane-died:${msg}`], present: [`lane-died:${msg}`] });
		expect(p1.seen.lines.get(`lane-died:${msg}`)).toMatchObject({ firstText: p0.lines[0]!.text, text: p1.lines[0]!.text, firstPoll: 0 });
		// the open slice is unheld but surfaced by the single death line: (b) holds
		expect(p1.b).toMatchObject({ ok: true, holder: null, orphans: [] });
		expect(verdict(w.polls, evidence("lane-kill-mid-hand")).verdict).toBe("PASS");
	});

	test("an orphaned open slice: unheld and the single line is a question, not a death; the window ends without a pass", () => {
		const w = world();
		w.ledger.claimWorkload(w.wl, { by: LANE, holder: LANE, leaseMs: 120_000 });
		const stray = w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "left open", doneCondition: "d", inputs: "i" });
		const hold = w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "chaos-hold", doneCondition: "d", inputs: "i" });
		w.ledger.raiseQuestion({ by: LANE, workloadId: w.wl, sliceId: hold, body: "close or keep?", options: ["close", "keep"] });
		const held = w.poll(5);
		expect(held.b).toMatchObject({ ok: true, liveHolder: true });
		w.ledger.releaseWorkload(w.wl, { by: LANE, holder: LANE });
		const p = w.poll(10);
		expect(p.a.ok).toBe(true);
		expect(p.b).toEqual({ ok: false, holder: null, liveHolder: false, openSlices: [stray], orphans: [{ sliceId: stray, task: "left open" }] });
		// judged from the release on (the held poll above would itself pass and decide)
		const v = verdict(w.polls.slice(1), evidence("orchestrator-kill-mid-review"), 10_000);
		expect(v).toMatchObject({ verdict: "FAIL", deciding: null, settle: null, atMs: 10_000 });
		expect(v.last?.b.orphans).toEqual([{ sliceId: stray, task: "left open" }]);
	});

	test("a dead hand still counted: its lane exited, but builderLabs counts its fallback row (c)", () => {
		const spawned = (exitBy: string) => {
			const w = world();
			w.ledger.claimWorkload(w.wl, { by: LANE, holder: LANE, leaseMs: 120_000 });
			w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: `lane-started: ${LANE} {"pid":4242}` });
			const sl = w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "append a line", doneCondition: "d", inputs: "i" });
			w.ledger.recordEntry({
				by: LANE, workloadId: w.wl, sliceId: sl, kind: "assumption",
				body: handSpawnBody({ token: "dt-1", root: join(tmp("sessions"), "lane"), spawnKey: "Hand1", review: false, group: "fast", row: ["openai-codex/gpt-5.1-codex-mini", "moonshot/kimi-k2"] }),
			});
			laneKilled(w, LANE, exitBy);
			return w.poll(5);
		};
		// the lane-exit: comes from the lane itself, so builderLabs' death rule (runner or starter only) does not fire
		const counted = spawned(LANE);
		expect(counted.c.ok).toBe(false);
		expect(counted.c.exitedHands).toEqual(["dt-1"]);
		expect(counted.c.counted).toEqual([expect.objectContaining({ token: "dt-1", lane: LANE })]);
		expect(counted.c.counted[0]!.why).toContain("openai; kimi");
		expect(counted.ok).toBe(false);
		// the runner's lane-exit: makes the hand dead to builderLabs too; with no session file it counts nothing
		const dead = spawned(LANE_RUNNER_BY);
		expect(dead.c).toEqual({ ok: true, exitedHands: ["dt-1"], counted: [] });
		expect(dead.builders.labs).toEqual([]);
		expect(dead.ok).toBe(true);
	});

	test("a late orphan appearing in the settle window fails the re-check", () => {
		const w = world();
		parkedOnQuestion(w);
		w.poll(5);
		w.poll(10);
		const late = w.ledger.addSlice({ by: LANE, workloadId: w.wl, task: "late", doneCondition: "d", inputs: "i" });
		w.poll(20);
		w.poll(35);
		const v = verdict(w.polls, evidence("orchestrator-kill-mid-review"));
		expect(v).toMatchObject({ verdict: "FAIL", atMs: 35_000 });
		expect(v.deciding?.at).toBe(at(5));
		expect(v.settle?.at).toBe(at(35));
		expect(v.settle?.b).toEqual({ ok: false, holder: null, liveHolder: false, openSlices: [late], orphans: [{ sliceId: late, task: "late" }] });
		expect(v.settle?.a.ok).toBe(true);
	});

	test("evidence rules: egress and nonce misses fail, a missing or unobserved item is a harness error, a missed system item fails, lost evidence fails the settle", () => {
		const w = world();
		parkedOnQuestion(w);
		for (const s of [5, 20, 35]) w.poll(s);
		const fault = "duplicate-lane-runner";
		const names = FAULT_EVIDENCE[fault];
		const egress = verdict(w.polls, evidence(fault, { egress: ["api.anthropic.com"] }));
		expect(egress).toMatchObject({ verdict: "FAIL", deciding: null, atMs: null });
		expect(egress.reason).toContain("api.anthropic.com");
		expect(verdict(w.polls, evidence(fault, { nonceMisses: ["lane turn 3"] }))).toMatchObject({ verdict: "FAIL", deciding: null, atMs: null });
		expect(verdict(w.polls, evidence(fault, { harness: ["unrouted model x/y"] }))).toMatchObject({ verdict: "HARNESS-ERROR", deciding: null, atMs: null });
		const some = verdict(w.polls, evidence(fault, {}, [{ name: names[0]!, observed: "exit 3, stderr held", at: T0 }]));
		expect(some).toMatchObject({ verdict: "HARNESS-ERROR", deciding: null, atMs: null });
		expect(some.reason).toContain(names[2]!);
		const all = (over: Partial<EvidenceItem>[]) => evidence(fault, {}, names.map((name, i) => ({ name, observed: "seen", at: T0, ...over[i] })));
		expect(verdict(w.polls, all([{ at: null, observed: "second launch still running" }]))).toMatchObject({ verdict: "HARNESS-ERROR", deciding: null, atMs: null });
		const systemMiss = verdict(w.polls, all([{}, { at: null, observed: "wrote lane-started: lane-chaos-run1-2", systemFault: true }]));
		expect(systemMiss).toMatchObject({ verdict: "FAIL", deciding: null, atMs: null });
		expect(systemMiss.last?.at).toBe(at(35));
		expect(systemMiss.reason).toContain("lane-chaos-run1-2");
		const lost = verdict(w.polls, all([{}, {}, { lostAt: at(25), observed: "lane-chaos-run1-2 reserved the workload" }]));
		expect(lost).toMatchObject({ verdict: "FAIL", atMs: 35_000 });
		expect([lost.deciding?.at, lost.settle?.at]).toEqual([at(5), at(35)]);
		expect(lost.settle?.ok).toBe(true);
		expect(lost.reason).toContain(names[2]!);
		const noSettle = verdict(w.polls.slice(0, 2), all([]));
		expect(noSettle).toMatchObject({ verdict: "HARNESS-ERROR", settle: null, atMs: 5_000 });
		expect(noSettle.deciding?.at).toBe(at(5));
	});
});

describe("isolation snapshot and diff", () => {
	const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	const git = (dir: string, ...args: string[]) => {
		const r = Bun.spawnSync(["git", "-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
		return r.stdout.toString().trim();
	};
	/** A "live" system in temp dirs: a ledger with one held workload, a checkout with a dirty file, a lanes root with that workload's dir. */
	function live() {
		const root = realpathSync(tmp("chaos-live")); // `git worktree list` prints real paths
		const ledgerDb = join(root, "ledger.db");
		const c = clock(T0);
		const ledger = Ledger.open(ledgerDb, { create: true, backup: false, backupOnOpen: false, clock: c.now });
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Jo's live workload", stakes: "normal", mode: "autonomous", id: "wl-live" });
		ledger.claimWorkload(wl, { by: "lane-live-1", holder: "lane-live-1", leaseMs: 3_600_000 });
		const sl = ledger.addSlice({ by: "lane-live-1", workloadId: wl, task: "live work", doneCondition: "d", inputs: "i" });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-live-1 requested by jo" });
		const checkout = join(root, "checkout");
		mkdirSync(checkout);
		git(checkout, "init", "-q", "-b", "main");
		writeFileSync(join(checkout, "a.txt"), "committed\n");
		git(checkout, "add", "a.txt");
		git(checkout, "commit", "-q", "-m", "init");
		writeFileSync(join(checkout, "a.txt"), "dirty 1\n");
		const lanes = join(root, "lanes");
		mkdirSync(join(lanes, "wl-live", "sessions"), { recursive: true });
		const paths = { ledgerDb, checkout, lanesRoots: [lanes] };
		return { c, ledger, wl, sl, checkout, lanes, paths, snap: () => isolationSnapshot(paths) };
	}

	test("an updated live ledger row is listed with its table, id, actor and workload; strangers and the run's token fail", () => {
		const l = live();
		const before = l.snap();
		expect(before.ledger.error).toBeNull();
		expect(before.checkout.error).toBeNull();
		const liveActors = liveActorsOf(before);
		expect([...liveActors]).toEqual(expect.arrayContaining([SURFACE_BY, "lane-live-1", LANE_STARTER_BY]));
		l.ledger.completeSlice(l.sl, { by: "lane-live-1", artifact: "bun test exit 0" });
		const after = l.snap();
		const d = isolationDiff(before, after, ["run1tok", "/tmp/as2-chaos-run1tok", "wl-chaos-run1tok"], liveActors);
		expect(d.ledger.rows).toContainEqual({ table: "slices", key: l.sl, change: "update", actor: "lane-live-1", workload: "wl-live", fail: null });
		expect(d.ledger.rows.filter((r) => r.table === "provenance").every((r) => r.change === "insert" && r.actor === "lane-live-1")).toBe(true);
		expect(d.failures).toEqual([]);
		expect(d.ok).toBe(true);

		// a relaunch of Jo's lane during the run: the starter (live) names the new lane id, so its rows are live too
		l.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: l.wl, kind: "assumption", body: "launch: lane-live-2 requested by jo" });
		l.ledger.recordEntry({ by: "lane-live-2", workloadId: l.wl, kind: "wake-read", body: "resuming" });
		expect(isolationDiff(before, l.snap(), "run1tok", liveActors).ok).toBe(true);

		const stranger = l.ledger.recordEntry({ by: "lane-stranger-1", workloadId: l.wl, kind: "assumption", body: "hello" });
		const named = l.ledger.recordEntry({ by: "lane-live-1", workloadId: l.wl, kind: "assumption", body: "saw /tmp/as2-chaos-run1tok/home" });
		const chaos = l.ledger.recordEntry({ by: "chaos", workloadId: l.wl, kind: "assumption", body: "launch requested" });
		const bad = isolationDiff(before, l.snap(), ["run1tok"], liveActors);
		expect(bad.ok).toBe(false);
		const fails = Object.fromEntries(bad.ledger.rows.filter((r) => r.table === "entries" && r.fail).map((r) => [r.key, r.fail]));
		expect(fails).toEqual({
			[stranger]: "actor lane-stranger-1 was not active on the live ledger before the run",
			[named]: "names the run (run1tok)",
			[chaos]: "written by chaos actor chaos",
		});
	});

	test("a dirty file's content change shows in the checkout diff although git status is unchanged; untouched snapshots compare equal", () => {
		const l = live();
		const s1 = l.snap();
		const s1again = l.snap();
		const quiet = isolationDiff(s1, s1again, "run1tok", liveActorsOf(s1));
		expect(quiet.checkout).toEqual([]);
		expect(quiet.ok).toBe(true);
		expect(Object.keys(s1.checkout.status)).toEqual(["a.txt"]);
		writeFileSync(join(l.checkout, "a.txt"), "dirty 2\n");
		const s2 = l.snap();
		expect(s2.checkout.status).toEqual(s1.checkout.status);
		const d = isolationDiff(s1, s2, "run1tok", liveActorsOf(s1));
		expect(d.checkout).toEqual([{ field: "file", detail: `a.txt: ${s1.checkout.files["a.txt"]} → ${s2.checkout.files["a.txt"]}`, attributedTo: null }]);
		expect(d.failures).toEqual([`live checkout file changed: a.txt: ${s1.checkout.files["a.txt"]} → ${s2.checkout.files["a.txt"]}`]);
		writeFileSync(join(l.checkout, "new file.txt"), "x\n");
		const s3 = l.snap();
		const fields = isolationDiff(s2, s3, "run1tok", liveActorsOf(s2)).checkout.map((c) => `${c.field} ${c.detail.split(":")[0]}`);
		expect(fields).toEqual(["status new file.txt", "file new file.txt"]);
	});

	test("refs and lanes roots: a live lane's wl/<id> ref and its dir are listed; another ref, or an entry naming the run, fails", () => {
		const l = live();
		const s1 = l.snap();
		git(l.checkout, "branch", "wl/wl-live");
		writeFileSync(join(l.lanes, "wl-live", "sessions", "lane-live-1.log"), "x");
		const s2 = l.snap();
		const d = isolationDiff(s1, s2, "run1tok", liveActorsOf(s1));
		expect(d.checkout).toEqual([expect.objectContaining({ field: "ref", attributedTo: "wl-live" })]);
		expect(d.listings.map((x) => [x.workload, x.change, x.path, x.fail])).toEqual([
			["wl-live", "changed", "wl-live/sessions", false],
			["wl-live", "added", "wl-live/sessions/lane-live-1.log", false],
		]);
		expect(d.ok).toBe(true);
		git(l.checkout, "branch", "other");
		mkdirSync(join(l.lanes, "wl-chaos-run1tok"));
		const bad = isolationDiff(s2, l.snap(), "run1tok", liveActorsOf(s2));
		expect(bad.failures).toEqual(expect.arrayContaining([
			expect.stringMatching(/^live checkout ref changed: refs\/heads\/other: absent → /),
			`live lanes root ${l.lanes}: added wl-chaos-run1tok names the run`,
		]));
	});

	test("a remote-tracking ref move (a live lane's fetch) is listed and does not fail; a refs/heads/main move still fails", () => {
		const l = live();
		git(l.checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
		const s1 = l.snap();
		const next = git(l.checkout, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "fetched");
		git(l.checkout, "update-ref", "refs/remotes/origin/main", next);
		const s2 = l.snap();
		const fetched = isolationDiff(s1, s2, "run1tok", liveActorsOf(s1));
		expect(fetched.checkout).toEqual([{ field: "ref", detail: `refs/remotes/origin/main: ${s1.checkout.refs.split(" ")[0]} commit → ${next} commit`, attributedTo: REMOTE_TRACKING }]);
		expect(fetched.ok).toBe(true);
		git(l.checkout, "update-ref", "refs/heads/main", next);
		const moved = isolationDiff(s2, l.snap(), "run1tok", liveActorsOf(s2));
		expect(moved.ok).toBe(false);
		expect(moved.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^live checkout ref changed: refs\/heads\/main: \w+ commit → \w+ commit$/), expect.stringMatching(/^live checkout HEAD changed: /)]));
		expect(moved.failures.some((f) => f.includes("refs/remotes/"))).toBe(false);
	});

	// The HEAD reflog of the live Plumb lane worktree wl-mv4z7bd2vgg35s that failed the 2026-10-12
	// lane-kill-mid-hand run (window 17:13:31Z to 17:14:51Z): lane/pr70 made by a checkout, lane/pr73
	// checked out and then merged into.
	const PLUMB = "wl-mv4z7bd2vgg35s";
	const [BASE, PR68, PR70, PR73_START, PR73] = [
		"5a1012c818d075d18a0a1d82dc6558e669ec72a8", "352209f3f8278da711767bb6d1234d26b81986d2", "8668a528138ea2a1dd16315e2e11544753b3f02e",
		"83e2d066f9124d33168ef1b13c0f77e6da66d564", "62d1c91de31d78fcb0e0e22f677195be1fde663b",
	];
	const entry = (old: string, sha: string, s: number, message?: string) => `${old} ${sha} t <t@t> ${s} -0700${message === undefined ? "" : `\t${message}`}`;
	const PLUMB_REFLOG = [
		entry("0".repeat(40), BASE, 1791793171),
		entry(BASE, BASE, 1791793171, "reset: moving to HEAD"),
		entry(BASE, PR68, 1791825165, `checkout: moving from wl/${PLUMB} to lane/pr68`),
		entry(PR68, PR68, 1791825181, "reset: moving to HEAD"),
		entry(PR68, BASE, 1791825187, `checkout: moving from lane/pr68 to wl/${PLUMB}`),
		entry(BASE, PR70, 1791825224, `checkout: moving from wl/${PLUMB} to lane/pr70`),
		entry(PR70, PR70, 1791825241, "reset: moving to HEAD"),
		entry(PR70, BASE, 1791825244, `checkout: moving from lane/pr70 to wl/${PLUMB}`),
		entry(BASE, PR73_START, 1791825280, `checkout: moving from wl/${PLUMB} to lane/pr73`),
		entry(PR73_START, PR73, 1791825291, "merge origin/main: Merge made by the 'ort' strategy."),
		entry(PR73, BASE, 1791825941, `checkout: moving from lane/pr73 to wl/${PLUMB}`),
	];
	const MERGE_MS = 1791825291_000;
	const RUN = [Date.parse("2026-10-12T17:13:31.124Z"), Date.parse("2026-10-12T17:14:51.700Z")] as const;
	const writes = (s: Set<string>) => [...s].map((w) => w.replace("\0", " "));
	/** `s` with refs added and its worktree reflogs and for-each-ref time replaced: a synthetic snapshot of the same live system. */
	const withRefs = (s: IsolationSnapshot, refsAtMs: number, refs: Record<string, string>, reflogs: Record<string, string>): IsolationSnapshot => ({
		...s, checkout: { ...s.checkout, refsAtMs, reflogs, refs: s.checkout.refs + Object.entries(refs).map(([name, sha]) => `${sha} commit\t${name}\n`).join("") },
	});

	test("reflogBranchWrites: the branch HEAD is on at each entry, with the entry's new sha, inside the window only", () => {
		const text = PLUMB_REFLOG.join("\n");
		expect(writes(reflogBranchWrites(text, ...RUN))).toEqual([`lane/pr70 ${PR70}`, `wl/${PLUMB} ${BASE}`, `lane/pr73 ${PR73_START}`, `lane/pr73 ${PR73}`]);
		// the bounds are inclusive; before the first checkout HEAD was on that checkout's `from` branch
		expect(writes(reflogBranchWrites(text, MERGE_MS, MERGE_MS))).toEqual([`lane/pr73 ${PR73}`]);
		expect(writes(reflogBranchWrites(text, 1791793171_000, 1791793171_000))).toEqual([`wl/${PLUMB} ${BASE}`]);
		expect(reflogBranchWrites(text, MERGE_MS + 1, MERGE_MS + 60_000).size).toBe(0);
		// a rebase detaches HEAD until it returns to the branch; a line that does not parse gives nothing
		const rebase = [
			entry(BASE, PR70, 100, "checkout: moving from main to feat"),
			entry(PR70, PR68, 101, "rebase (start): checkout main"),
			entry(PR68, PR73_START, 102, "rebase (pick): b"),
			entry(PR73_START, PR73_START, 103, "rebase (finish): returning to refs/heads/feat"),
			"not a reflog line",
		].join("\n");
		expect(writes(reflogBranchWrites(rebase, 0, 200_000))).toEqual([`feat ${PR70}`, `feat ${PR73_START}`]);
	});

	test("a branch a live lane worktree's HEAD reflog wrote during the run is listed as that lane's: lane/pr70 (checkout) and lane/pr73 (checkout, then merge)", () => {
		const l = live();
		const s = l.snap();
		const wt = join(l.lanes, PLUMB);
		const before = withRefs(s, RUN[0], {}, { [wt]: PLUMB_REFLOG.slice(0, 5).join("\n") });
		const after = withRefs(s, RUN[1], { "refs/heads/lane/pr70": PR70, "refs/heads/lane/pr73": PR73 }, { [wt]: PLUMB_REFLOG.slice(0, 10).join("\n") });
		const d = isolationDiff(before, after, ["run1tok"], liveActorsOf(s));
		expect(d.checkout).toEqual([
			{ field: "ref", detail: `refs/heads/lane/pr70: absent → ${PR70} commit`, attributedTo: `${PLUMB} (worktree reflog)` },
			{ field: "ref", detail: `refs/heads/lane/pr73: absent → ${PR73} commit`, attributedTo: `${PLUMB} (worktree reflog)` },
		]);
		expect(d.failures).toEqual([]);
		expect(d.ok).toBe(true);
		const report = renderReport({
			fault: "lane-kill-mid-hand", variant: null, token: "run1tok", fence: "on", ps: { kind: "real" },
			verdict: { verdict: "PASS", reason: "held", deciding: null, settle: null, atMs: null, last: null },
			timings: { startedAt: T0, setupMs: null, triggerAt: null, injectedAt: null },
			evidence: { fault: "lane-kill-mid-hand", injectedAt: T0, items: [], nonceMisses: [], egress: [], harness: [] },
			egressLog: [], rows: null, runners: [], stubCounts: {}, isolation: d, scratch: { path: "/tmp/as2-chaos-run1tok", kept: false }, notes: [],
		});
		expect(report.split("\n")).toEqual(expect.arrayContaining([
			`| ref | refs/heads/lane/pr70: absent → ${PR70} commit | ${PLUMB} (worktree reflog) |`,
			`| ref | refs/heads/lane/pr73: absent → ${PR73} commit | ${PLUMB} (worktree reflog) |`,
		]));
		// the merge's whole-second reflog time may lie up to REFLOG_SKEW_MS after the after-snapshot's for-each-ref
		const early = { ...after, checkout: { ...after.checkout, refsAtMs: MERGE_MS - REFLOG_SKEW_MS } };
		expect(isolationDiff(before, early, ["run1tok"], liveActorsOf(s)).ok).toBe(true);
	});

	test("a branch with no reflog evidence, evidence outside the window, another sha, a deletion, or a tag of the same name fails", () => {
		const l = live();
		const s = l.snap();
		const reflogs = { [join(l.lanes, PLUMB)]: PLUMB_REFLOG.join("\n") };
		const refs = { "refs/heads/lane/pr70": PR70, "refs/heads/lane/pr73": PR73 };
		const failing = (before: IsolationSnapshot, after: IsolationSnapshot) => {
			const d = isolationDiff(before, after, ["run1tok"], liveActorsOf(s));
			expect(d.failures.length).toBe(d.checkout.filter((c) => c.attributedTo === null).length);
			return d.checkout.filter((c) => c.attributedTo === null).map((c) => c.detail.split(":")[0]);
		};
		expect(failing(withRefs(s, RUN[0], {}, {}), withRefs(s, RUN[1], refs, {}))).toEqual(["refs/heads/lane/pr70", "refs/heads/lane/pr73"]);
		// the same writes, ten minutes before a run's window
		expect(failing(withRefs(s, RUN[0] + 600_000, {}, reflogs), withRefs(s, RUN[1] + 600_000, refs, reflogs))).toEqual(["refs/heads/lane/pr70", "refs/heads/lane/pr73"]);
		// the merge more than REFLOG_SKEW_MS after the after-snapshot's for-each-ref
		expect(failing(withRefs(s, RUN[0], {}, reflogs), withRefs(s, MERGE_MS - REFLOG_SKEW_MS - 1, refs, reflogs))).toEqual(["refs/heads/lane/pr73"]);
		expect(failing(withRefs(s, RUN[0], {}, reflogs), withRefs(s, RUN[1], { "refs/heads/lane/pr70": PR73 }, reflogs))).toEqual(["refs/heads/lane/pr70"]);
		// no HEAD reflog entry deletes a branch
		expect(failing(withRefs(s, RUN[0], { "refs/heads/lane/pr70": PR70 }, reflogs), withRefs(s, RUN[1], {}, reflogs))).toEqual(["refs/heads/lane/pr70"]);
		expect(failing(withRefs(s, RUN[0], {}, reflogs), withRefs(s, RUN[1], { "refs/tags/lane/pr70": PR70, "refs/notes/lane/pr70": PR70 }, reflogs))).toEqual(["refs/tags/lane/pr70", "refs/notes/lane/pr70"]);
	});

	test("reflog evidence from a worktree outside the lanes roots or naming the run attributes nothing; a branch naming the run fails even with evidence", () => {
		const l = live();
		const s = l.snap();
		const attributed = (reflogs: Record<string, string>, refs: Record<string, string>) =>
			isolationDiff(withRefs(s, RUN[0], {}, {}), withRefs(s, RUN[1], refs, reflogs), ["run1tok"], liveActorsOf(s)).checkout.map((c) => c.attributedTo);
		const text = PLUMB_REFLOG.join("\n");
		const pr70 = { "refs/heads/lane/pr70": PR70 };
		expect(attributed({ [join(l.lanes, PLUMB)]: text }, pr70)).toEqual([`${PLUMB} (worktree reflog)`]);
		expect(attributed({ [join(`${l.lanes}-other`, PLUMB)]: text }, pr70)).toEqual([null]);
		expect(attributed({ [join(dirname(l.lanes), PLUMB)]: text }, pr70)).toEqual([null]);
		expect(attributed({ [join(l.lanes, "wl-chaos-run1tok")]: text }, pr70)).toEqual([null]);
		const checkoutTo = (branch: string) => entry(BASE, PR70, 1791825224, `checkout: moving from wl/${PLUMB} to ${branch}`);
		expect(attributed({ [join(l.lanes, PLUMB)]: checkoutTo("lane/x") }, { "refs/heads/lane/x": PR70 })).toEqual([`${PLUMB} (worktree reflog)`]);
		expect(attributed({ [join(l.lanes, PLUMB)]: checkoutTo("lane/run1tok") }, { "refs/heads/lane/run1tok": PR70 })).toEqual([null]);
	});

	test("end to end in a temp repo: a checkout and commit in a linked worktree under a lanes root are attributed by its reflog; the same outside the lanes roots fails", () => {
		const l = live();
		const wt = join(l.lanes, "wl-wt");
		const out = join(dirname(l.lanes), "elsewhere");
		git(l.checkout, "worktree", "add", "-q", "-b", "wl/wl-wt", wt);
		git(l.checkout, "worktree", "add", "-q", "-b", "wl/elsewhere", out);
		const s1 = l.snap();
		expect(s1.checkout.error).toBeNull();
		expect(Object.keys(s1.checkout.reflogs).sort()).toEqual([out, wt].sort());
		git(wt, "checkout", "-q", "-b", "lane/pr70");
		writeFileSync(join(wt, "b.txt"), "b\n");
		git(wt, "add", "b.txt");
		git(wt, "commit", "-q", "-m", "pr70");
		git(out, "checkout", "-q", "-b", "lane/stray");
		const s2 = l.snap();
		const d = isolationDiff(s1, s2, "run1tok", liveActorsOf(s1));
		expect(d.checkout.filter((c) => c.field === "ref").map((c) => [c.detail.split(":")[0], c.attributedTo])).toEqual([
			["refs/heads/lane/pr70", "wl-wt (worktree reflog)"],
			["refs/heads/lane/stray", null],
		]);
		expect(d.failures.filter((f) => f.startsWith("live checkout ref changed"))).toEqual([expect.stringMatching(/^live checkout ref changed: refs\/heads\/lane\/stray: absent → \w+ commit$/)]);
	});
});

describe("nightly window and rotation", () => {
	// nightlyDue(now, R) takes the chaos root R and reads R/nightly (PLAN wl-mv5lpzqacbe5ts § 2.1); the literal
	// "nightly" keeps this file on symbols origin/main has, so the regression case below fails there by assertion.
	const reports = () => tmp("chaos-reports");
	const nightly = (root: string): string => {
		const dir = join(root, "nightly");
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	test("due at PT 03:05, not at 03:20; the window is [03:00, 03:15) and a nightly report for the PT date stops it", () => {
		const dir = reports();
		expect(nightlyDue(new Date("2026-07-15T10:05:00Z"), dir)).toBe(true); // 03:05 PDT
		expect(nightlyDue(new Date("2026-07-15T10:20:00Z"), dir)).toBe(false); // 03:20 PDT
		expect(nightlyDue(new Date("2026-07-15T10:00:00Z"), dir)).toBe(true);
		expect(nightlyDue(new Date("2026-07-15T10:14:59Z"), dir)).toBe(true);
		expect(nightlyDue(new Date("2026-07-15T09:59:59Z"), dir)).toBe(false);
		expect(nightlyDue(new Date("2026-07-15T10:15:00Z"), dir)).toBe(false);
		writeFileSync(join(dir, "launchd.log"), "");
		writeFileSync(join(nightly(dir), "arming.log"), "on 2026-07-01T00:00:00Z\n");
		expect(nightlyDue(new Date("2026-07-15T10:05:00Z"), dir)).toBe(true);
		writeFileSync(join(nightly(dir), "2026-07-15-provider-refusal.md"), "# report");
		expect(nightlyDue(new Date("2026-07-15T10:05:00Z"), dir)).toBe(false);
		expect(nightlyDue(new Date("2026-07-16T10:05:00Z"), dir)).toBe(true);
	});

	test("a manual --fault report does not stop that night's --nightly", () => {
		const dir = reports();
		const now = new Date("2026-07-15T10:05:00Z"); // 03:05 PDT
		// A manual run earlier the same PT date wrote its report in R itself, as every manual run does.
		const manual = reportPath(dir, new Date("2026-07-15T07:28:00Z"), "duplicate-lane-runner");
		expect(manual).toBe(join(dir, "2026-07-15-duplicate-lane-runner.md"));
		writeFileSync(manual, "# report");
		writeFileSync(join(dir, "2026-07-15-lane-kill-mid-hand.md"), "# report");
		expect(nightlyDue(now, dir)).toBe(true);
	});

	test("a nightly report stops only its own PT date; no R at all, or an empty R/nightly, is due", () => {
		const root = reports();
		expect(nightlyDue(new Date("2026-07-15T10:05:00Z"), join(root, "absent"))).toBe(true);
		const dir = nightly(root);
		expect(nightlyDue(new Date("2026-07-15T10:05:00Z"), root)).toBe(true);
		writeFileSync(join(dir, "2026-07-14-lane-kill-mid-hand.md"), "# report");
		writeFileSync(join(dir, "2026-07-16-network-block-60s.md.tmp"), "# half a report");
		expect(nightlyDue(new Date("2026-07-15T10:05:00Z"), root)).toBe(true);
		expect(nightlyDue(new Date("2026-07-14T10:05:00Z"), root)).toBe(false);
		expect(nightlyDue(new Date("2026-07-16T10:05:00Z"), root)).toBe(true);
	});

	test("the night's report goes to R/nightly/<PT date>-<fault>.md, and once there that night is no longer due", () => {
		const root = reports();
		const now = new Date("2026-10-12T10:05:00Z"); // 2026-10-12 03:05 PDT
		expect(nightlyDue(now, root)).toBe(true);
		const path = reportPath(nightly(root), now, nightlyFault(now));
		expect(path).toBe(join(root, "nightly", `2026-10-12-${nightlyFault("2026-10-12")}.md`));
		writeFileSync(path, "# report");
		expect(nightlyDue(now, root)).toBe(false);
		expect(nightlyDue(new Date("2026-10-13T10:05:00Z"), root)).toBe(true);
	});

	test("from a UTC+5:30 clock: 15:35 IST is 03:05 PDT and due, 15:50 IST is not", () => {
		const prior = process.env.TZ;
		process.env.TZ = "Asia/Kolkata";
		try {
			const ist = new Date("2026-07-15T15:35:00+05:30");
			expect([ist.getHours(), ist.getMinutes(), ist.getTimezoneOffset()]).toEqual([15, 35, -330]);
			expect(nightlyDue(ist, reports())).toBe(true);
			expect(nightlyDue(new Date("2026-07-15T15:50:00+05:30"), reports())).toBe(false);
			// every IST quarter hour is a UTC quarter hour: one fire of a whole PT day lands in the window
			const dir = reports();
			const fires = Array.from({ length: 96 }, (_, i) => new Date(Date.parse("2026-07-15T12:30:00+05:30") + i * 900_000)).filter((d) => nightlyDue(d, dir));
			expect(fires.map((d) => d.toISOString())).toEqual(["2026-07-15T10:00:00.000Z"]);
		} finally {
			if (prior === undefined) delete process.env.TZ;
			else process.env.TZ = prior;
		}
	});

	test("both 2026 DST transitions: exactly one quarter-hourly fire of the PT day is due, at 03:00 local", () => {
		const firesOf = (fromIso: string, hours: number) => {
			const dir = reports();
			return Array.from({ length: hours * 4 }, (_, i) => new Date(Date.parse(fromIso) + i * 900_000)).filter((d) => nightlyDue(d, dir)).map((d) => d.toISOString());
		};
		// 2026-03-08: 02:00 PST jumps to 03:00 PDT; the PT day is 23 hours from 08:00Z
		expect(firesOf("2026-03-08T08:00:00Z", 23)).toEqual(["2026-03-08T10:00:00.000Z"]);
		expect(nightlyDue(new Date("2026-03-08T10:05:00Z"), reports())).toBe(true); // 03:05 PDT
		expect(nightlyDue(new Date("2026-03-08T11:05:00Z"), reports())).toBe(false); // 04:05 PDT
		// 2026-11-01: 02:00 PDT falls back to 01:00 PST; the PT day is 25 hours from 07:00Z
		expect(firesOf("2026-11-01T07:00:00Z", 25)).toEqual(["2026-11-01T11:00:00.000Z"]);
		expect(nightlyDue(new Date("2026-11-01T10:05:00Z"), reports())).toBe(false); // 02:05 PST
		expect(nightlyDue(new Date("2026-11-01T11:05:00Z"), reports())).toBe(true); // 03:05 PST
	});

	test("nightlyFault cycles through the five faults by PT date", () => {
		expect(nightlyFault("1970-01-01")).toBe(FAULTS[0]);
		expect(daysSinceEpoch("2026-10-11")).toBe(20737);
		expect(nightlyFault("2026-10-11")).toBe("network-block-60s");
		const days = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 9, 11 + i)).toISOString().slice(0, 10));
		const seq = days.map((d) => nightlyFault(d));
		expect(new Set(seq.slice(0, 5)).size).toBe(5);
		expect(seq.slice(5)).toEqual(seq.slice(0, 5));
		expect(seq.slice(0, 3)).toEqual(["network-block-60s", "provider-refusal", "duplicate-lane-runner"]);
		// 05:30Z on the 12th is 22:30 PDT on the 11th: the PT date picks the fault
		expect(nightlyFault(new Date("2026-10-12T05:30:00Z"))).toBe("network-block-60s");
	});

	test("report path: PT date, then a -HHMM suffix on collision", () => {
		const dir = reports();
		const now = new Date("2026-10-12T05:30:00Z"); // 2026-10-11 22:30 PDT
		const first = reportPath(dir, now, "provider-refusal");
		expect(first).toBe(join(dir, "2026-10-11-provider-refusal.md"));
		writeFileSync(first, "");
		const second = reportPath(dir, now, "provider-refusal");
		expect(second).toBe(join(dir, "2026-10-11-provider-refusal-2230.md"));
		writeFileSync(second, "");
		expect(reportPath(dir, now, "provider-refusal")).toBe(join(dir, "2026-10-11-provider-refusal-2230-2.md"));
		expect(reportPath(dir, now, "lane-kill-mid-hand")).toBe(join(dir, "2026-10-11-lane-kill-mid-hand.md"));
	});
});

describe("run-owned kills (code review r1 finding 1)", () => {
	const S = "/private/var/folders/xy/T/as2-chaos-run1";
	const REPO = `${S}/repo`;
	const WL = "wl-chaos-run1";
	const L = (n: number): string => `Mon Oct 12 10:00:${String(n).padStart(2, "0")} 2026`;
	const row = (pid: number, ppid: number, n: number, command = "bun x"): ProcRow => ({ pid, ppid, lstart: L(n), command });

	test("killTargets: owned roots by their start time and everything below them, parents first; nothing that only names S, no recycled pid, never chaos or its ancestors", () => {
		const table: ProcRow[] = [
			row(100, 50, 1, `omp --mode rpc --cwd ${REPO}`), // a chaos child
			row(101, 100, 2), // below it
			row(102, 101, 3), // below that
			row(200, 1, 4, `ls ${REPO}`), // names the scratch root, owned by nobody
			row(201, 200, 5),
			row(300, 1, 9, "omp --cwd /Users/jo/live"), // pid 300 was owned at L(6); this is another process on the recycled pid
			row(301, 300, 10),
			row(400, 100, 11, "bun surface/scripts/chaos.ts"), // chaos itself, below an owned root
			row(401, 400, 12),
			row(600, 1, 13, "zsh"), // an ancestor of chaos
			row(1, 0, 0, "/sbin/launchd"),
		];
		const owned = [
			{ pid: 100, lstart: "Mon Oct 12  10:00:01 2026", what: "chaos child" }, // ps pads: whitespace does not decide
			{ pid: 300, lstart: L(6), what: "lane omp of lane-1" },
			{ pid: 600, lstart: L(13), what: "wrongly owned ancestor" },
			{ pid: 1, lstart: L(0), what: "launchd" },
			{ pid: 999, lstart: L(7), what: "gone" },
		];
		const targets = killTargets(table, owned, 400, new Set([600]));
		expect(targets.map((t) => t.pid)).toEqual([100, 101, 102]);
		expect(targets.map((t) => t.lstart)).toEqual([L(1), L(2), L(3)]);
		// nothing owned: nothing selected, whatever the commands name
		expect(killTargets(table, [], 400, new Set())).toEqual([]);
	});

	test("killRefusal: the runner must be this run's `lane.ts run <wl> <lane>` from the scratch repo, alive, with its recorded start; chaos and its ancestors never", () => {
		const runner = `bun ${REPO}/surface/scripts/lane.ts run ${WL} ${LANE}`;
		const want = (c: string): boolean => isScratchRunner(c, REPO, WL, LANE, isRunnerCommand);
		const t = { pid: 4242, what: "lane runner", start: L(1), want };
		const self = 1000;
		const ancestors = new Set([1001]);
		expect(killRefusal(t, { lstart: "Mon Oct 12 10:00:01  2026", command: runner }, self, ancestors)).toBeNull();
		// the /private/var → /var alias a command line may spell
		expect(killRefusal(t, { lstart: L(1), command: runner.replace("/private/var/", "/var/") }, self, ancestors)).toBeNull();
		const refused = [
			killRefusal(t, null, self, ancestors), // gone
			killRefusal(t, { lstart: L(1), command: `bun /Users/jo/code/agent-system-2.0/surface/scripts/lane.ts run ${WL} ${LANE}` }, self, ancestors), // a live checkout's runner
			killRefusal(t, { lstart: L(1), command: `bun ${REPO}/surface/scripts/lane.ts run ${WL} lane-chaos-run1-2` }, self, ancestors), // another lane
			killRefusal(t, { lstart: L(1), command: `bun ${REPO}/surface/scripts/lane.ts run wl-other ${LANE}` }, self, ancestors), // another workload
			killRefusal(t, { lstart: L(1), command: `less ${REPO}/surface/scripts/lane.ts run` }, self, ancestors), // only names the path
			killRefusal(t, { lstart: L(2), command: runner }, self, ancestors), // the pid was recycled
			killRefusal({ ...t, start: "" }, { lstart: L(1), command: runner }, self, ancestors), // no recorded start
			killRefusal({ ...t, start: "" }, { lstart: "", command: runner }, self, ancestors),
			killRefusal({ ...t, pid: self }, { lstart: L(1), command: runner }, self, ancestors),
			killRefusal({ ...t, pid: 1001 }, { lstart: L(1), command: runner }, self, ancestors),
			killRefusal({ ...t, pid: 1 }, { lstart: L(1), command: runner }, self, ancestors),
		];
		expect(refused.map((r) => r !== null)).toEqual(refused.map(() => true));
		expect(sameStart(L(1), ` ${L(1).replace(" ", "  ")} `)).toBe(true);
		expect(sameStart("", "")).toBe(false);
	});
});

describe("fault 5's first holder (code review r1 finding 3)", () => {
	const base = { laneId: LANE, injectedAt: at(0), entries: [] as { id: string; body: string; created_at: string }[], questions: [] as { id: string; state: string; created_by: string; created_at: string }[] };
	const released = { holder: null, changed_at: at(20) };
	const entry = (body: string, s: number) => ({ id: `en-${s}`, body, created_at: at(s) });
	const question = (s: number, over: Partial<{ state: string; created_by: string }> = {}) => ({ id: `q-${s}`, state: "open", created_by: LANE, created_at: at(s), ...over });
	const state = (o: Partial<typeof base> & { workload: { holder: string | null; changed_at: string } | null }) => firstHolder({ ...base, ...o }).state;

	test("a null holder before the lane's own end is lost; its end receipts, written no later than the release, end it", () => {
		expect(state({ workload: { holder: LANE, changed_at: at(1) } })).toBe("held");
		expect(state({ workload: released })).toBe("lost");
		// the receipt after the release does not excuse it
		expect(state({ workload: released, entries: [entry(`lane-exit: ${LANE} code 0 signal - outcome parked`, 21)] })).toBe("lost");
		expect(state({ workload: released, entries: [entry(`lane-exit: ${LANE} code 0 signal - outcome parked`, 20)] })).toBe("ended");
		expect(state({ workload: released, entries: [entry(`lane-parked: ${LANE} questions q-1 session /s`, 19)] })).toBe("ended");
		expect(state({ workload: released, entries: [entry(`lane-decided: ${LANE} completed`, 19)] })).toBe("ended");
		expect(state({ workload: released, entries: [entry("lane-exit: lane-chaos-run1-2 code 0 signal - outcome parked", 19)] })).toBe("lost");
		expect(state({ workload: released, questions: [question(19)] })).toBe("ended");
		expect(state({ workload: released, questions: [question(19, { created_by: "jo" })] })).toBe("lost");
		expect(state({ workload: released, questions: [question(19, { state: "resolved" })] })).toBe("lost");
		expect(state({ workload: released, questions: [question(21)] })).toBe("lost");
	});

	test("another holder, a gone row, or another lane's launch after the injection is lost; one before it is not", () => {
		expect(state({ workload: { holder: "lane-chaos-run1-2", changed_at: at(5) } })).toBe("lost");
		expect(state({ workload: null })).toBe("lost");
		const held = { holder: LANE, changed_at: at(1) };
		expect(state({ workload: held, entries: [entry("launch: lane-chaos-run1-2 cause first requested-by jo", 3)] })).toBe("lost");
		expect(state({ workload: held, entries: [entry('lane-started: lane-chaos-run1-2 {"pid":7}', 3)] })).toBe("lost");
		expect(state({ workload: held, entries: [entry("launch: lane-chaos-run1-2 cause first requested-by jo", -3)] })).toBe("held");
		expect(state({ workload: held, entries: [entry(`launch: ${LANE} cause first requested-by jo`, 3)] })).toBe("held");
	});

	test("on a real ledger: the park releases after its question (ended); a bare release, its lane-exit: written a second after, is lost", () => {
		const parked = world();
		parkedOnQuestion(parked);
		const read = (w: World) =>
			firstHolder({ laneId: LANE, injectedAt: T0, workload: w.ledger.workload(w.wl), entries: w.ledger.entries(w.wl), questions: w.ledger.questions(w.wl) });
		expect(read(parked).state).toBe("ended");
		const bare = world();
		bare.ledger.claimWorkload(bare.wl, { by: LANE, holder: LANE, leaseMs: 120_000 });
		expect(read(bare).state).toBe("held");
		bare.c.at(at(20));
		bare.ledger.releaseWorkload(bare.wl, { by: LANE_RUNNER_BY, holder: LANE });
		bare.c.at(at(21));
		bare.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: bare.wl, kind: "assumption", body: laneExitBody(LANE, { code: null, signal: "SIGKILL", outcome: "died" }) });
		expect(read(bare)).toMatchObject({ state: "lost" });
	});

	test("the straddle (moonshot review r2 #1): the lane's own end receipt in the millisecond after the release ends it; past the bound it is lost", () => {
		expect(END_RECEIPT_SKEW_MS).toBe(500);
		const after = (msAfter: number) => new Date(Date.parse(at(20)) + msAfter).toISOString();
		const receipt = (body: string, msAfter: number) => ({ id: `en-${msAfter}`, body, created_at: after(msAfter) });
		const exit = `lane-exit: ${LANE} code 0 signal - outcome done`;
		expect(state({ workload: released, entries: [receipt(exit, 1)] })).toBe("ended");
		expect(state({ workload: released, entries: [receipt(exit, END_RECEIPT_SKEW_MS)] })).toBe("ended");
		expect(state({ workload: released, entries: [receipt(`lane-decided: ${LANE} completed`, 1)] })).toBe("ended");
		expect(state({ workload: released, entries: [receipt(`lane-parked: ${LANE} questions q-1 session /s`, 1)] })).toBe("ended");
		expect(state({ workload: released, entries: [receipt(exit, END_RECEIPT_SKEW_MS + 1)] })).toBe("lost");
		expect(state({ workload: released, entries: [receipt("lane-exit: lane-chaos-run1-2 code 0 signal - outcome done", 1)] })).toBe("lost");
		// the bound covers end receipts only: a question raised after the release is still no excuse
		expect(state({ workload: released, questions: [{ id: "q-x", state: "open", created_by: LANE, created_at: after(1) }] })).toBe("lost");
		// on a real ledger, as lane.ts finish() writes them: the release, then lane-exit: with its own clock read a millisecond on
		const w = world();
		w.ledger.claimWorkload(w.wl, { by: LANE, holder: LANE, leaseMs: 120_000 });
		w.c.at(at(20));
		w.ledger.write(() => {
			w.ledger.releaseWorkload(w.wl, { by: LANE_RUNNER_BY, holder: LANE });
			w.c.at(after(1));
			w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: laneExitBody(LANE, { code: 0, signal: null, outcome: "done" }) });
		});
		expect(w.ledger.workload(w.wl)?.changed_at).toBe(at(20));
		expect(firstHolder({ laneId: LANE, injectedAt: T0, workload: w.ledger.workload(w.wl), entries: w.ledger.entries(w.wl), questions: w.ledger.questions(w.wl) }).state).toBe("ended");
	});

	test("the lower bound (moonshot review r3 #2): a stale end receipt or question of the same lane id written before the injection is not this end", () => {
		const before = (msBefore: number) => new Date(Date.parse(T0) - msBefore).toISOString();
		const stale = (body: string, msBefore: number) => ({ id: `en-stale-${msBefore}`, body, created_at: before(msBefore) });
		const exit = `lane-exit: ${LANE} code 0 signal - outcome done`;
		expect(state({ workload: released, entries: [stale(exit, 1)] })).toBe("lost");
		expect(state({ workload: released, entries: [stale(exit, 60_000)] })).toBe("lost");
		expect(state({ workload: released, entries: [stale(`lane-decided: ${LANE} completed`, 1)] })).toBe("lost");
		expect(state({ workload: released, entries: [stale(`lane-parked: ${LANE} questions q-1 session /s`, 1)] })).toBe("lost");
		expect(state({ workload: released, questions: [{ id: "q-stale", state: "open", created_by: LANE, created_at: before(1) }] })).toBe("lost");
		// at the injection itself it counts, and a stale receipt beside a fresh one does not hide the fresh one
		expect(state({ workload: released, entries: [stale(exit, 0)] })).toBe("ended");
		expect(state({ workload: released, entries: [stale(exit, 1), entry(exit, 20)] })).toBe("ended");
		expect(state({ workload: released, questions: [question(0)] })).toBe("ended");
		// on a real ledger: a lane-exit: of the same lane id written before the injection, then a bare release after it
		const w = world();
		w.c.at(before(1_000));
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: laneExitBody(LANE, { code: 0, signal: null, outcome: "done" }) });
		w.c.at(T0);
		w.ledger.claimWorkload(w.wl, { by: LANE, holder: LANE, leaseMs: 120_000 });
		w.c.at(at(20));
		w.ledger.releaseWorkload(w.wl, { by: LANE_RUNNER_BY, holder: LANE });
		expect(w.ledger.workload(w.wl)?.holder).toBeNull();
		expect(firstHolder({ laneId: LANE, injectedAt: T0, workload: w.ledger.workload(w.wl), entries: w.ledger.entries(w.wl), questions: w.ledger.questions(w.wl) })).toMatchObject({ state: "lost" });
	});
});

describe("fault 5's second runner (code review r2: openai #2, moonshot #1)", () => {
	const FIRST = 201;
	const SECOND = 301;
	const REFUSED = `lane run: ${LANE} already running: runner pid ${FIRST}`;
	/** A throwaway ledger whose first runner recorded its start; `before` is the start records at the second runner's spawn. */
	function watch() {
		const w = world();
		const start = (runnerPid: number, pid: number, session: string | null, s: number) => {
			w.c.at(at(s));
			return w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: laneStartedBody(LANE, { pid, start: "Sun Oct 11 03:00:00 2026", session, argv: [], runnerPid }) });
		};
		start(FIRST, 101, null, 1);
		const before = new Set(laneStarts(w.ledger.entries(w.wl)).map((s) => s.entryId));
		const snapshot = () => laneStarts(w.ledger.entries(w.wl));
		const judge = (o: { code: number | null; stderr: string; killed?: boolean; omp?: number | null }) =>
			secondRunnerJudgement({ laneId: LANE, runnerPid: SECOND, before, starts: snapshot(), omp: o.omp ?? null, killed: o.killed ?? false, code: o.code, stderr: o.stderr, watchMs: 30_000 });
		return { start, before, snapshot, judge };
	}

	test("the first runner's session update during the watch is its own, not the second runner's: the refusal holds", () => {
		const { start, before, snapshot, judge } = watch();
		start(FIRST, 101, "/s/session.jsonl", 5);
		const split = newStarts(snapshot(), LANE, SECOND, before);
		expect(split.second).toEqual([]);
		expect(split.others.map((s) => s.runnerPid)).toEqual([FIRST]);
		const j = judge({ code: 7, stderr: REFUSED });
		expect(j.held).toBe(true);
		expect(j.observed).toContain(`1 new lane-started: of ${LANE} by runner pid ${FIRST} (not the second runner's), not counted`);
	});

	test("a duplicate that writes lane-started: and exits between two polls is caught by the snapshot after its exit", () => {
		const { start, before, snapshot, judge } = watch();
		// the last poll, at +4 s, saw nothing of the second runner's
		expect(newStarts(snapshot(), LANE, SECOND, before).second).toEqual([]);
		const id = start(SECOND, 102, null, 4.2);
		// and it exited before the poll at +4.5 s; the final snapshot is taken after the exit
		const j = judge({ code: 0, stderr: "" });
		expect(j.held).toBe(false);
		expect(j.observed).toContain(`the second runner (pid ${SECOND}) wrote lane-started: for ${LANE} (entry ${id}, omp pid 102)`);
		// even when it then exits 7: a start record by its pid is the defect, whatever the exit
		expect(judge({ code: 7, stderr: REFUSED }).held).toBe(false);
	});

	test("only exit 7 'already running' is a refusal: another exit, exit 7 for another reason, a signal, or a kill is not", () => {
		const { judge } = watch();
		expect(judge({ code: 7, stderr: REFUSED }).held).toBe(true);
		const crashed = judge({ code: 1, stderr: "lane unknown: boom" });
		expect(crashed.held).toBe(false);
		expect(crashed.observed).toContain("exited 1, not a refusal");
		expect(judge({ code: 0, stderr: "" }).held).toBe(false);
		expect(judge({ code: 7, stderr: `lane run: ${LANE} not started: inspecting the recorded runner pid ${FIRST} failed (ps did not answer)` }).held).toBe(false);
		expect(judge({ code: 1, stderr: REFUSED }).held).toBe(false);
		expect(judge({ code: null, stderr: "" }).observed).toContain("exited by a signal, not a refusal");
		expect(judge({ code: null, stderr: "", killed: true }).observed).toContain("still running after 30 s");
		expect(judge({ code: 7, stderr: REFUSED, omp: 999 }).observed).toContain("spawned omp pid 999");
	});

	test("the evidence name fault 5 records is the one FAULT_EVIDENCE lists", () => {
		expect(FAULT_EVIDENCE["duplicate-lane-runner"]).toContain(SECOND_RUNNER_EVIDENCE);
	});
});

describe("scratch writes never follow a link (code review r1 finding 2)", () => {
	function scratch() {
		const base = realpathSync(tmp("chaos-scratch"));
		const root = join(base, "repo");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		return { base, root, outside };
	}

	test("a new nested file is written, an existing regular file replaced, with the mode asked for", () => {
		const { root, outside } = scratch();
		const dest = join(root, "chaos", "scratch.test.ts");
		writeScratchFile(root, dest, "one");
		writeScratchFile(root, dest, "two");
		expect(readFileSync(dest, "utf8")).toBe("two");
		const src = join(outside, "run.sh");
		writeFileSync(src, "#!/bin/sh\n");
		chmodSync(src, 0o755);
		copyIntoScratch(root, src, join(root, "bin", "run.sh"));
		expect(statSync(join(root, "bin", "run.sh")).mode & 0o777).toBe(0o755);
	});

	test("a symlinked ancestor is refused, not followed: nothing lands outside the scratch root", () => {
		const { root, outside } = scratch();
		symlinkSync(outside, join(root, "chaos"));
		expect(() => writeScratchFile(root, join(root, "chaos", "scratch.test.ts"), "x")).toThrow(HarnessError);
		expect(() => writeScratchFile(root, join(root, "chaos", "deeper", "x.ts"), "x")).toThrow(HarnessError);
		expect([existsSync(join(outside, "scratch.test.ts")), existsSync(join(outside, "deeper"))]).toEqual([false, false]);
		// a link that stays inside the root is refused too: a scratch write never follows one
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "inner"));
		expect(scratchWriteRefusal(root, join(root, "inner", "x.ts"))).not.toBeNull();
		expect(scratchNewPathRefusal(root, join(root, "chaos", "node_modules"))).not.toBeNull();
	});

	test("a symlink at the path is refused for a write and unlinked, never followed, for a removal", () => {
		const { root, outside } = scratch();
		const secret = join(outside, "secret");
		writeFileSync(secret, "keep");
		const link = join(root, "f.ts");
		symlinkSync(secret, link);
		expect(() => writeScratchFile(root, link, "x")).toThrow(HarnessError);
		const src = join(outside, "src.ts");
		writeFileSync(src, "y");
		expect(() => copyIntoScratch(root, src, link)).toThrow(HarnessError);
		expect(readFileSync(secret, "utf8")).toBe("keep");
		removeFromScratch(root, link);
		expect(() => lstatSync(link)).toThrow();
		expect(readFileSync(secret, "utf8")).toBe("keep");
		// a symlinked source is not copied either
		symlinkSync(secret, join(outside, "src-link"));
		expect(() => copyIntoScratch(root, join(outside, "src-link"), join(root, "g.ts"))).toThrow(HarnessError);
	});

	test("an escaping path, the root itself, a root that is not its own realpath, a directory or a file ancestor are refused", () => {
		const { base, root } = scratch();
		expect(scratchWriteRefusal(root, join(root, "..", "outside", "x"))).not.toBeNull();
		expect(scratchWriteRefusal(root, root)).not.toBeNull();
		symlinkSync(root, join(base, "alias"));
		expect(scratchWriteRefusal(join(base, "alias"), join(base, "alias", "x"))).not.toBeNull();
		mkdirSync(join(root, "dir"));
		expect(scratchWriteRefusal(root, join(root, "dir"))).not.toBeNull();
		writeFileSync(join(root, "file"), "");
		expect(scratchWriteRefusal(root, join(root, "file", "x"))).not.toBeNull();
		expect(scratchWriteRefusal(root, join(root, "ok", "x"))).toBeNull();
		expect(scratchNewPathRefusal(root, join(root, "node_modules"))).toBeNull();
		expect(scratchNewPathRefusal(root, join(root, "file"))).not.toBeNull();
	});
});
