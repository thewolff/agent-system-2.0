// PLAN wl-mvpsrr4tr0p1xc T1-T7: the merge train always has a live lane, outside the lane cap (jo-issues #212). One world per
// test: a temp ledger on a settable clock, the real tick (`tick()`) with a fake gh, and a launcher that runs the real starter
// reservation (`reserve()` in surface/scripts/lane.ts) with a fake runner probe, under AGENT_SYSTEM_MAX_LANES=5. After a
// reservation the fake runner plays the lane's start as the test scripts it: ready (`lane-started:`, `lane-ready:`, the lane's
// own lease), never ready (the runner's `launch-failed:` and `lane-exit: … never-ready`, the 2026-10-26 morning's shape), or
// a crash before readiness that finalizes nothing. Tests read ledger rows, exit codes and which lane starts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { askJo, raisedId } from "../../gates/src/rulings";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { launchVerdict, triggerLaunch } from "../extensions/launch";
import { onFire } from "../src/batch";
import { recordRepo } from "../src/decision-log";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { applyTrain, interpret } from "../src/input";
import {
	attempts, consumedIds, controlEntries, LANE_CAP_ENV, laneCap, laneExitBody, laneReadyBody, laneStartedBody, launchFailedBody, launchRequestedBody, launchRowsFor,
	type LaneOutcome, STARTER_EXIT, trainBoardBody, verdictOf,
} from "../src/launch";
import { actionable, fixBindings, recordTrainTask, TRAIN_ALERT_REPO, TRAIN_LAUNCH_OPTIONS, TRAIN_RETRY_OPTIONS, trainLaunchFailures, trainSliceId } from "../src/merge-train";
import type { PidState } from "../src/omp-probe";
import { briefHash, formatOverride, formatSignal, goalsHash, rankDay, type SignalAnswers } from "../src/rank";
import type { RankConfig } from "../src/rank-launch";
import { makeRunId, testRequestedBody, type TestRun, testRunBody } from "../src/test-run";
import { releasedOpenBody } from "../src/turn-end";
import { MERGE_TRAIN_BY, RANK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { type GhResult, tick } from "../scripts/train-tick";
// A namespace import, as lane-script.test.ts does: a name lane.ts stops exporting fails only the test that calls it.
import * as laneScript from "../scripts/lane";
import { clock, fakePi, tempLedger, tmp } from "./helpers";
import { checkout, fakeGh, H0, H1, JO, REPO } from "./train-world";

const CAP = 5;
const SHOW: RankConfig = { mode: "show", parallelBudgetUsd: 0 };
const ORDER: RankConfig = { mode: "order", parallelBudgetUsd: 0 };
const PARALLEL: RankConfig = { mode: "parallel", parallelBudgetUsd: 0 };
const OMP_START = "Mon Oct 26 06:00:00 2026";
const LEASE_MS = 6 * 3_600_000;
/** One tick interval on the clock between passes. */
const STEP_H = 0.01;

let savedCap: string | undefined;
beforeAll(() => {
	savedCap = process.env[LANE_CAP_ENV];
	process.env[LANE_CAP_ENV] = String(CAP);
});
afterAll(() => {
	if (savedCap === undefined) delete process.env[LANE_CAP_ENV];
	else process.env[LANE_CAP_ENV] = savedCap;
});

/** What the fake runner does after a train reservation: reach readiness, never get ready, or die before either is written. */
type Start = "ready" | "never-ready" | "crash" | { beforeReady: () => void };

/** The starter's exit code for a refused reservation, as `lane.ts launch` maps it (`reserveOrExit`). */
const refusalCode = (reason: string): number =>
	/^cap\b/.test(reason) ? STARTER_EXIT.cap! : /^held\b/.test(reason) ? STARTER_EXIT.held! : /^closed\b/.test(reason) ? STARTER_EXIT.closed! : STARTER_EXIT["not-launchable"]!;

/**
 * The world: train `prs` (one checkout with REPO's origin), an autonomous owner on `wl/<owner>` for #101's tasks, a fake gh
 * whose PR views carry the bodies and merge states `views` sets, and the launcher the tick runs.
 */
function live(prs: readonly number[] = [101], config: RankConfig = SHOW) {
	const c = clock("2026-10-26T06:00:00.000Z");
	const { ledger, path } = tempLedger(c.now);
	const repo = checkout();
	const cmd = interpret(ledger, `train ${prs.join(" ")}`);
	if (cmd?.kind !== "train") throw new Error("not a train");
	const train = applyTrain(ledger, cmd, repo).workloadId;
	const owner = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
	recordRepo(ledger, owner, checkout());
	const g = fakeGh();
	for (const n of prs) g.prs.set(n, { head: H0, branch: n === 101 ? `wl/${owner}` : `feature/${n}` });
	const views = new Map<number, { body?: string; state?: string; mergedAt?: string | null }>();
	const gh = (args: string[]): GhResult => {
		const r = g.gh(args);
		const extra = args[0] === "pr" && args[1] === "view" && r.code === 0 ? views.get(Number(args[2])) : undefined;
		return extra ? { ...r, stdout: JSON.stringify({ ...JSON.parse(r.stdout), ...extra }) } : r;
	};

	// The runner probe: a lane is alive (`same`) from its `lane-started:` until its exit; every other pid is gone.
	const alive = new Set<string>();
	const answer = (laneId: string): PidState => (alive.has(laneId) ? "same" : "gone");
	const probeFor = (laneId: string): laneScript.RunnerProbe => ({ omp: () => answer(laneId), runner: () => answer(laneId) });
	let pid = 5000;
	const started = (wl: string, laneId: string) => {
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(laneId, { pid: ++pid, start: OMP_START, session: null, argv: [], runnerPid: ++pid }) });
		alive.add(laneId);
	};
	/** The lane got its first prompt: the runner's `lane-ready:` at the row cut, then the lane's own lease. */
	const ready = (wl: string, laneId: string) => {
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneReadyBody(laneId, ledger.now()) });
		expect(ledger.claimWorkload(wl, { by: laneId, holder: laneId, leaseMs: LEASE_MS }).won).toBe(true);
	};
	/** The script for the next train reservations' runners, in order; `ready` once it is empty. */
	const starts: Start[] = [];
	const run = (wl: string, laneId: string, start: Start) => {
		started(wl, laneId);
		if (start === "crash") {
			alive.delete(laneId);
			return;
		}
		if (start === "never-ready") {
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: launchFailedBody(laneId, "claim", "never ready in 2 min (omp exit code - signal SIGKILL)") });
			ledger.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: laneId });
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: null, signal: "SIGKILL", outcome: "never-ready" }) });
			alive.delete(laneId);
			return;
		}
		if (typeof start === "object") start.beforeReady();
		c.plusHours(0.001);
		ready(wl, laneId);
	};
	/**
	 * `lane.ts launch <wl> --requested-by <who>`: the real reservation, then the fake runner; its exit code and line. `on` is the
	 * connection the reservation runs on (another process's, in a race test); the runner writes on the world's.
	 */
	const starter = (wl: string, who: string = MERGE_TRAIN_BY, rank: RankConfig = config, on: Ledger = ledger): { code: number; line: string } => {
		const r = laneScript.reserve(on, wl, who, false, rank, probeFor);
		if (!r.ok) return { code: refusalCode(r.reason), line: `${wl} not launched: ${r.reason}` };
		run(wl, r.laneId, wl === train ? (starts.shift() ?? "ready") : "ready");
		return { code: 0, line: `launched ${r.laneId} cause ${r.cause}` };
	};
	const launched: { wl: string; code: number; line: string }[] = [];
	const launch = (wl: string) => {
		const r = starter(wl);
		launched.push({ wl, ...r });
		return r;
	};
	const logs: string[] = [];
	/** One tick pass, one interval after the last; `on` is the ledger the tick reads (a test's interposing view of `ledger`). */
	const pass = (on: Ledger = ledger) => {
		c.plusHours(STEP_H);
		return tick({ ledger: on, gh, launch, notify: () => true, log: (l) => logs.push(l) });
	};
	/** The exit drain, in-process: `cmdDrain`'s walk in `show` (oldest first, `launchRowsFor` + `verdictOf`), each launch through the starter. */
	const drain = () => {
		const tried = new Set<string>();
		const out: { wl: string; code: number; line: string }[] = [];
		for (;;) {
			const next = ledger.inFlight().map((x) => x.workload.id).find((id) => {
				if (tried.has(id)) return false;
				const rows = launchRowsFor(ledger, id, laneCap(process.env));
				return rows !== null && verdictOf(rows).launch;
			});
			if (next === undefined) break;
			tried.add(next);
			const r = starter(next, LANE_RUNNER_BY);
			out.push({ wl: next, ...r });
			if (r.code === STARTER_EXIT.cap) break;
		}
		return out;
	};

	const control = (wl: string = train) => controlEntries(ledger.entries(wl));
	/** The train's `launch:` attempts: `<laneId> <cause …>`. */
	const trainLaunches = () => control().filter((c) => c.prefix === "launch").map((c) => `${c.laneId} ${c.rest}`);
	/** The `launch-requested:` rows the tick wrote on `wl`. */
	const tickRequests = (wl: string = train) => control(wl).filter((c) => c.prefix === "launch-requested" && c.createdBy === MERGE_TRAIN_BY);
	/** The tick's `launch-requested:` rows on `wl` that no `launch:` attempt names yet. */
	const pendingTickRequests = (wl: string = train) => {
		const consumed = consumedIds(attempts(control(wl)));
		return tickRequests(wl).filter((c) => !consumed.has(c.id));
	};
	/** The train lane the newest attempt reserved. */
	const lane = () => control().filter((c) => c.prefix === "launch").at(-1)!.laneId!;
	/** The train lane's exit: its `released-open:` when `open` slices are left (lane_release's marker), its release, the runner's `lane-exit:`. */
	const exit = (outcome: LaneOutcome, o: { releasedOpen?: number; laneId?: string; wl?: string } = {}) => {
		const l = o.laneId ?? lane();
		const wl = o.wl ?? train;
		if (o.releasedOpen !== undefined) ledger.recordEntry({ by: l, workloadId: wl, kind: "assumption", body: releasedOpenBody(l, o.releasedOpen) });
		if (ledger.workload(wl)!.holder === l) ledger.releaseWorkload(wl, { by: l, holder: l });
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(l, { code: 0, signal: null, outcome }) });
		alive.delete(l);
	};
	/** The live train lane adds PR `n`'s disposition slice (trainBrief step 1), unless one exists. */
	const work = (n: number) => {
		const sl = trainSliceId(train, n);
		if (!ledger.slice(sl)) ledger.addSlice({ by: lane(), workloadId: train, id: sl, task: `PR #${n}`, doneCondition: "terminal", inputs: `#${n}` });
		return sl;
	};
	/** The live train lane raises a question on PR `n`'s slice and parks: `lane-parked:`, its release, `lane-exit: … parked`. */
	const park = (n: number): string => {
		const l = lane();
		const q = ledger.raiseQuestion({ by: l, workloadId: train, sliceId: work(n), body: `#${n}: merge it now or hold for the review?`, options: ["merge", "hold"] });
		expect(ledger.parkLane(train, { by: LANE_RUNNER_BY, laneId: l, session: `/tmp/${l}.jsonl` }).parked).toBe(true);
		exit("parked");
		return q;
	};
	/** Jo's answer to a question: the instruction id a `resume` cause names. */
	const answer_ = (q: string, a: string) => ledger.answerQuestion(q, { ...JO, answer: a });
	/** `n` ordinary workloads, each held by a live lane under a long lease (the cap's lanes). */
	const busy = (n: number, onRepo?: string): string[] =>
		Array.from({ length: n }, (_, i) => {
			const wl = ledger.openWorkload({ by: SURFACE_BY, brief: `ordinary ${i}`, stakes: "normal", mode: "autonomous" });
			recordRepo(ledger, wl, onRepo ?? checkout());
			const r = ledger.reserveLane(wl, { by: LANE_STARTER_BY, cap: 99, leaseMs: LEASE_MS, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
			if (!r.ok) throw new Error(r.reason);
			started(wl, r.laneId);
			return wl;
		});
	/** An ordinary workload with no lane, with Jo's `launch-requested: by jo` when `requested`. */
	const ordinary = (brief: string, requested = true): string => {
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
		recordRepo(ledger, wl, checkout());
		if (requested) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now()) });
		return wl;
	};
	/** Jo's `launch-requested: by jo` on `wl`. */
	const joRequest = (wl: string = train) => ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now()) });
	/** The tick's D4 questions on the train (options relaunch / stop). */
	const limitQuestions = () => ledger.questions(train).filter((q) => q.created_by === MERGE_TRAIN_BY && JSON.parse(q.options).includes("relaunch"));
	const creates = () => g.calls.filter((a) => a[0] === "issue" && a[1] === "create");
	/** The live lane on the train returns #`pr` (lane_train_return) at its current head. */
	const task = (pr: number) => {
		const p = g.prs.get(pr)!;
		const view = { number: pr, headRefName: p.branch, headRefOid: p.head, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" } };
		const r = recordTrainTask(ledger, { train, by: lane(), pr, kind: "red", detail: `run tr-x red at ${p.head}\nsrc/x.test.ts > case 1: boom`, view, trainRepo: REPO });
		if (!r.ok) throw new Error(r.reason);
		return r.task;
	};
	let seq = 0;
	/** The owner pushes `sha` to #`pr` (GitHub records it now) and its runner result there is `verdict`. */
	const push = (pr: number, sha: string, verdict: TestRun["verdict"]) => {
		const p = g.prs.get(pr)!;
		p.head = sha;
		g.pushed(p.branch, sha, c.now());
		const by = "lane-owner-1";
		const slice = ledger.addSlice({ by, workloadId: owner, task: `suite #${pr}`, doneCondition: "green", inputs: `#${pr}` });
		const runId = makeRunId(Date.parse(c.now()) + ++seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: owner, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice, by }) });
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: owner, sliceId: slice, kind: "assumption",
			body: testRunBody({
				runId, verdict, sha, pr, reason: null, headAtEnd: sha, base: null, mergeBase: null,
				full: { pass: 1, fail: verdict === "red" ? 1 : 0, skip: 0, exit: verdict === "red" ? 1 : 0, ms: 10, error: null },
				solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
	};
	/**
	 * The quiet train: its first lane got ready, added every PR's slice and released with them open (`released-open:`, exit
	 * `open-work`), so no trigger is left; one more pass launches nothing.
	 */
	const quiet = () => {
		pass();
		expect(trainLaunches()).toEqual([expect.stringMatching(/ cause first requested-by merge-train$/)]);
		for (const n of prs) work(n);
		exit("open-work", { releasedOpen: prs.length });
		const before = trainLaunches().length;
		pass();
		expect(trainLaunches()).toHaveLength(before);
	};
	/** The morning shape: a fresh train's three launches each end never ready (`launch-failed:` and `lane-exit: … never-ready`). */
	const threeFailures = () => {
		starts.push("never-ready", "never-ready", "never-ready");
		for (let i = 0; i < 3; i++) pass();
		expect(trainLaunches()).toHaveLength(3);
	};
	return {
		c, ledger, path, repo, train, owner, g, views, alive, probeFor, starts, starter, launched, logs, pass, drain, control, trainLaunches, tickRequests,
		pendingTickRequests, lane, exit, work, park, answer: answer_, busy, ordinary, joRequest, limitQuestions, creates, task, push, ready, started, quiet,
		threeFailures,
	};
}

describe("T1 (acceptance 3): cap full of ordinary lanes, Jo answers the train lane's question, one tick pass relaunches the train", () => {
	test("five live ordinary lanes; the train's lane parked on a question; Jo answers: one pass launches the train on `resume <answer>`, no request; a sixth ordinary workload is still refused `cap`", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		const ordinaryLanes = w.busy(CAP);
		const sixth = w.ordinary("the sixth ordinary workload");
		expect(w.starter(sixth, SURFACE_BY)).toEqual({ code: STARTER_EXIT.cap!, line: `${sixth} not launched: cap` });
		w.pass();
		expect(w.trainLaunches()).toHaveLength(1);

		const ans = w.answer(q, "merge");
		const lines = w.pass();
		expect(w.tickRequests()).toEqual([]);
		expect(w.trainLaunches()).toEqual([expect.any(String), `${w.lane()} cause resume ${ans} requested-by merge-train`]);
		expect(w.ledger.workload(w.train)!.holder).toBe(w.lane());
		expect(lines).toContainEqual(expect.stringContaining(`question ${q} answered, not yet resumed`));
		// the cap still reads five: the train's lane took no slot, and the sixth ordinary workload waits
		expect(launchRowsFor(w.ledger, sixth, CAP)!.liveLanes).toBe(CAP);
		expect(w.starter(sixth, SURFACE_BY)).toEqual({ code: STARTER_EXIT.cap!, line: `${sixth} not launched: cap` });
		// one ordinary lane ends: the sixth launches beside the live train lane
		w.exit("completed", { wl: ordinaryLanes[0]!, laneId: w.ledger.workload(ordinaryLanes[0]!)!.holder! });
		expect(w.starter(sixth, SURFACE_BY).code).toBe(0);
		expect(w.ledger.workload(w.train)!.holder).toBe(w.lane());

		// the train lane exits with nothing new: the answer is consumed; further passes and a drain launch nothing
		w.exit("released");
		w.pass();
		w.pass();
		expect(w.drain()).toEqual([]);
		expect(w.trainLaunches()).toHaveLength(2);
		expect(w.tickRequests()).toEqual([]);
	});
});

describe("T2 (acceptance 2): whatever the train's work, one tick pass launches it with the cap full", () => {
	test("each trigger once, cap full: a PR boarded, a task settled, a tick alert answered: the train launches on the pass that sees it", () => {
		const w = live([101, 106]);
		w.quiet();
		w.busy(CAP);
		const trainLaunches = () => w.trainLaunches().length;

		// a PR boarded (the tick's `train-board:`)
		w.g.prs.set(130, { head: H0, branch: "feature/130" });
		const landing = w.ordinary("the landing workload of #130", false);
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.train, kind: "assumption", body: trainBoardBody({ pr: 130, workload: landing, head: H0, run: null, review: null }) });
		let n = trainLaunches();
		expect(w.pass()).toContainEqual(expect.stringContaining("#130 boarded"));
		expect(trainLaunches()).toBe(n + 1);
		// the woken lane returns #101 to its owner and releases
		w.work(130);
		const t = w.task(101);
		w.exit("open-work", { releasedOpen: 3 });
		n = trainLaunches();
		w.pass(); // the owner's delivery is refused `cap`; nothing wakes the train
		expect(w.launched.filter((l) => l.wl === w.owner).map((l) => l.code)).toEqual([STARTER_EXIT.cap!]);
		expect(trainLaunches()).toBe(n);

		// a task settled: the owner's green push
		w.push(101, H1, "green");
		expect(w.pass()).toContainEqual(expect.stringContaining(`task ${t.id} on #101 settled`));
		expect(trainLaunches()).toBe(n + 1);
		w.exit("released");
		n = trainLaunches();
		w.pass();
		expect(trainLaunches()).toBe(n);

		// a tick alert answered (the tick's own question: no lane raised it, so no resume consumes it)
		const alert = raisedId(
			askJo(w.ledger, { by: MERGE_TRAIN_BY, workloadId: w.train, sliceId: trainSliceId(w.train, 106), body: "#106 failed twice", options: [...TRAIN_RETRY_OPTIONS] }, { asker: "train" }),
			"the alert",
		);
		w.pass();
		expect(trainLaunches()).toBe(n);
		w.answer(alert, "skip");
		expect(w.pass()).toContainEqual(expect.stringContaining(`alert ${alert} on #106 answered`));
		expect(trainLaunches()).toBe(n + 1);
	});

	test("an answer that lands while a tick request is pending: the request-cause launch that gets ready consumes it, and no second wake follows its exit", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		w.busy(CAP);
		// a pass whose launcher could not serve its request left it pending
		const req = w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.train, kind: "assumption", body: launchRequestedBody(MERGE_TRAIN_BY, w.ledger.now(), "prior wake") });
		w.c.plusHours(STEP_H);
		w.answer(q, "merge");
		w.pass();
		expect(w.trainLaunches().at(-1)).toBe(`${w.lane()} cause request ${req} requested-by merge-train`);
		w.exit("released");
		const n = w.trainLaunches().length;
		w.pass();
		w.pass();
		expect(w.drain()).toEqual([]);
		expect(w.trainLaunches()).toHaveLength(n);
	});

	test("the same request-cause launch ending never-ready consumes nothing: the next pass wakes the train for the answer again", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		w.busy(CAP);
		const req = w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.train, kind: "assumption", body: launchRequestedBody(MERGE_TRAIN_BY, w.ledger.now(), "prior wake") });
		w.c.plusHours(STEP_H);
		const ans = w.answer(q, "merge");
		w.starts.push("never-ready");
		w.pass();
		expect(w.trainLaunches().at(-1)).toBe(`${w.lane()} cause request ${req} requested-by merge-train`);
		expect(w.pass()).toContainEqual(expect.stringContaining(`question ${q} answered, not yet resumed`));
		expect(w.trainLaunches().at(-1)).toBe(`${w.lane()} cause resume ${ans} requested-by merge-train`);
	});

	test("a resume-cause launch (no request pending) ending never-ready leaves the answer unconsumed: the next pass launches `resume` again", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		w.busy(CAP);
		const ans = w.answer(q, "merge");
		w.starts.push("never-ready");
		w.pass();
		w.pass();
		const resumes = w.trainLaunches().filter((l) => l.includes(`cause resume ${ans} `));
		expect(resumes).toHaveLength(2);
		expect(w.tickRequests()).toEqual([]);
	});

	test("an answer written after a request-cause reservation and before readiness is in the first prompt: that lane-ready: consumes it", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		w.busy(CAP);
		const req = w.joRequest();
		w.starts.push({ beforeReady: () => w.answer(q, "merge") });
		// a drain (or Jo's launch) serves the request; the answer lands between its reservation and its readiness
		expect(w.starter(w.train, LANE_RUNNER_BY).code).toBe(0);
		expect(w.trainLaunches().at(-1)).toBe(`${w.lane()} cause request ${req} requested-by lane-runner`);
		w.exit("released");
		const n = w.trainLaunches().length;
		w.pass();
		expect(w.drain()).toEqual([]);
		expect(w.trainLaunches()).toHaveLength(n);
	});

	test("a boarded PR whose binding predates a never-ready attempt still wakes the train", () => {
		const w = live();
		w.quiet();
		w.busy(CAP);
		w.g.prs.set(130, { head: H0, branch: "feature/130" });
		const landing = w.ordinary("the landing workload of #130", false);
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.train, kind: "assumption", body: trainBoardBody({ pr: 130, workload: landing, head: H0, run: null, review: null }) });
		w.starts.push("never-ready");
		const n = w.trainLaunches().length;
		w.pass();
		expect(w.trainLaunches()).toHaveLength(n + 1);
		expect(w.pass()).toContainEqual(expect.stringContaining("#130 boarded"));
		expect(w.trainLaunches()).toHaveLength(n + 2);
		expect(w.ledger.workload(w.train)!.holder).toBe(w.lane());
	});

	test("a dependency that merged before a never-ready attempt's exit still wakes the train on the next pass", () => {
		const w = live();
		w.views.set(101, { body: "Depends-on: #200" });
		w.g.prs.set(200, { head: H1, branch: "feature/200" });
		w.quiet();
		w.busy(CAP);
		w.views.set(200, { state: "MERGED", mergedAt: w.c.now() });
		w.starts.push("never-ready");
		const n = w.trainLaunches().length;
		expect(w.pass()).toContainEqual(expect.stringContaining("#101's dependency merged"));
		expect(w.trainLaunches()).toHaveLength(n + 1);
		expect(w.pass()).toContainEqual(expect.stringContaining("#101's dependency merged"));
		expect(w.trainLaunches()).toHaveLength(n + 2);
	});
});

describe("T3 (acceptance 4): never two train lanes at once; a train fix workload counts against the cap", () => {
	test("a second request on the live train lane is refused `held`; a second open train with work is refused `held: train lane … live on <first>`", () => {
		const w = live();
		w.pass();
		const first = w.lane();
		w.joRequest();
		expect(w.starter(w.train, SURFACE_BY)).toEqual({ code: STARTER_EXIT.held!, line: `${w.train} not launched: held: ${first} still running (omp pid 5001)` });
		const cmd = interpret(w.ledger, "train 102");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const other = applyTrain(w.ledger, cmd, tmp("second-train-repo")).workloadId;
		expect(other).not.toBe(w.train);
		const before = w.ledger.entries(other).length;
		expect(w.starter(other)).toEqual({ code: STARTER_EXIT.held!, line: `${other} not launched: held: train lane ${first} live on ${w.train}` });
		expect(w.ledger.entries(other)).toHaveLength(before);
		// the first train's lane ends: the second train launches
		w.exit("released");
		expect(w.starter(other).code).toBe(0);
	});

	test("train A reserves, its pre-claim lapses before spawn, train B reserves and starts; A's spawn write refuses (stage reserve, held) and spawns nothing", () => {
		const w = live();
		const cmd = interpret(w.ledger, "train 102");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const b = applyTrain(w.ledger, cmd, tmp("second-train-repo")).workloadId;
		const ra = laneScript.reserve(w.ledger, w.train, MERGE_TRAIN_BY, false, SHOW, w.probeFor);
		if (!ra.ok) throw new Error(ra.reason);
		w.c.plusHours(0.1); // past A's three-minute pre-claim
		const rb = laneScript.reserve(w.ledger, b, MERGE_TRAIN_BY, false, SHOW, w.probeFor);
		if (!rb.ok) throw new Error(rb.reason);
		const owns = { owns: () => true };
		expect(laneScript.startAsOwner(w.ledger, owns, () => {
			const child = laneScript.spawnIfReserved(w.ledger, b, rb.laneId, null, () => "omp-B", w.probeFor);
			w.started(b, rb.laneId);
			return child;
		})).toBe("omp-B");
		const spawned: string[] = [];
		let refused: unknown = null;
		try {
			laneScript.startAsOwner(w.ledger, owns, () => laneScript.spawnIfReserved(w.ledger, w.train, ra.laneId, null, () => {
				spawned.push(ra.laneId);
				return "omp-A";
			}, w.probeFor));
		} catch (e) {
			refused = e;
		}
		expect(spawned).toEqual([]);
		const f = refused as Error & { stage: string; code: number };
		const message = String(f.message);
		expect({ stage: f.stage, code: f.code }).toEqual({ stage: "reserve", code: STARTER_EXIT.held! });
		expect(message).toContain(`held: train lane ${rb.laneId} live on ${b}`);
		// the starter's failure path records it (`failAfterReserve`): A's attempt ends at stage reserve
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: launchFailedBody(ra.laneId, f.stage, message) });
		expect(w.control().filter((c) => c.prefix === "launch-failed").map((c) => c.rest)).toEqual([expect.stringMatching(/^reserve: .*held: train lane /)]);
	});

	test("a train fix workload the tick opens is no train: its launch counts against the cap and is refused `cap` while the cap is full", () => {
		const w = live([101, 106]);
		w.pass();
		w.work(101);
		w.work(106);
		w.busy(CAP);
		w.task(106); // #106's branch is no workload's: the tick opens a fix workload for it
		w.exit("open-work", { releasedOpen: 2 });
		w.pass();
		const fixes = fixBindings(w.ledger);
		expect(fixes).toHaveLength(1);
		const fix = fixes[0]!.workloadId;
		expect(launchRowsFor(w.ledger, fix, CAP)!.capExempt).toBe(false);
		expect(w.launched.filter((l) => l.wl === fix)).toEqual([{ wl: fix, code: STARTER_EXIT.cap!, line: `${fix} not launched: cap` }]);
	});
});

describe("T4 (acceptance 5): no work, no lane", () => {
	for (const full of [false, true]) {
		test(`an open train with nothing actionable, cap ${full ? "full" : "empty"}: several passes and an exit drain write no launch-requested: and no launch:`, () => {
			const w = live();
			w.quiet();
			if (full) w.busy(CAP);
			const n = w.trainLaunches().length;
			for (let i = 0; i < 4; i++) w.pass();
			expect(w.drain().filter((d) => d.wl === w.train)).toEqual([]);
			expect(actionable(w.ledger, w.train)).toEqual([]);
			expect(w.trainLaunches()).toHaveLength(n);
			expect(w.tickRequests()).toEqual([]);
		});
	}

	test("a train whose lane parked on an open question gets no launch until the answer", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		for (let i = 0; i < 3; i++) w.pass();
		expect(w.drain().filter((d) => d.wl === w.train)).toEqual([]);
		expect(w.trainLaunches()).toHaveLength(1);
		expect(w.tickRequests()).toEqual([]);
		w.answer(q, "hold");
		w.pass();
		expect(w.trainLaunches()).toHaveLength(2);
	});

	test("another launch path reserves the actionable train after step 4 read it unheld, before request() reads its rows: the pass writes no request and starts nothing; after that lane readies and exits with nothing new, nothing launches (review r1 F2)", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		const ans = w.answer(q, "merge");
		// Jo's launch path serves the answer in the gap: the tick's view of the ledger runs it just before request() reads the
		// train's launch rows, so those rows read `held`
		let raced: { code: number; line: string } | null = null;
		const racing = new Proxy(w.ledger, {
			get(target, key) {
				const v = Reflect.get(target, key, target);
				if (typeof v !== "function") return v;
				if (key !== "launchRows") return v.bind(target);
				return (wl: string, ...rest: unknown[]) => {
					if (wl === w.train && raced === null) raced = w.starter(w.train, SURFACE_BY);
					return v.apply(target, [wl, ...rest]);
				};
			},
		});
		const lines = w.pass(racing);
		expect(raced).toMatchObject({ code: 0 });
		expect(w.trainLaunches()).toEqual([expect.any(String), `${w.lane()} cause resume ${ans} requested-by ${SURFACE_BY}`]);
		expect(w.tickRequests()).toEqual([]);
		expect(w.launched.filter((l) => l.wl === w.train)).toHaveLength(1);
		expect(lines).toContainEqual(expect.stringMatching(/ not requested: held$/));
		// that lane got ready with the answer in its prompt and exits with nothing new: no pass and no drain launches the train
		w.exit("released");
		w.pass();
		w.pass();
		expect(w.drain().filter((d) => d.wl === w.train)).toEqual([]);
		expect(w.trainLaunches()).toHaveLength(2);
		expect(w.tickRequests()).toEqual([]);
	});

	test("another starter records Jo's request and reserves the train after request() read its rows, before its request is written: the competing write cannot land inside the tick's transaction, so no tick request outlives a lane; after the lane readies and exits with nothing new, nothing launches (review r2 F5)", () => {
		const w = live();
		w.pass();
		// the first lane dies before it works #101: the train is actionable and its verdict reads died-not-relaunched
		w.exit("died");
		expect(actionable(w.ledger, w.train)).toEqual(["#101 not yet worked"]);
		expect(verdictOf(launchRowsFor(w.ledger, w.train, CAP)!)).toEqual({ launch: false, reason: "died-not-relaunched" });
		// another process (Jo's launch word, then its starter) on its own connection to the same file, with no busy wait and no
		// retry, runs the moment request()'s read of the train's launch rows returns
		const other = Ledger.open(w.path, { backup: false, backupOnOpen: false, clock: w.c.now, busyTimeoutMs: 0, busyRetries: 0 });
		let raced: "busy" | { code: number; line: string } | null = null;
		const racing = new Proxy(w.ledger, {
			get(target, key) {
				const v = Reflect.get(target, key, target);
				if (typeof v !== "function") return v;
				if (key !== "launchRows") return v.bind(target);
				return (wl: string, ...rest: unknown[]) => {
					const rows = v.apply(target, [wl, ...rest]);
					if (wl === w.train && raced === null) {
						try {
							other.recordEntry({ by: SURFACE_BY, workloadId: w.train, kind: "assumption", body: launchRequestedBody("jo", other.now()) });
							raced = w.starter(w.train, SURFACE_BY, SHOW, other);
						} catch (err) {
							if (!(err instanceof Error && "code" in err && String(err.code).startsWith("SQLITE_BUSY"))) throw err;
							raced = "busy";
						}
					}
					return rows;
				};
			},
		});
		try {
			w.pass(racing);
			// whichever lane holds the train now gets ready, works #101 and exits with nothing new: no pass and no drain launches it
			w.work(101);
			w.exit("open-work", { releasedOpen: 1 });
			w.pass();
			w.pass();
			expect(w.drain().filter((d) => d.wl === w.train)).toEqual([]);
			expect(w.pendingTickRequests()).toEqual([]);
			expect(w.trainLaunches()).toHaveLength(2);
			// the competing write was refused busy while the tick held its transaction, so the tick's own launch served its request
			expect(raced).toBe("busy");
			expect(w.trainLaunches()[1]).toBe(`${w.lane()} cause request ${w.tickRequests()[0]!.id} requested-by ${MERGE_TRAIN_BY}`);
		} finally {
			other.close();
		}
	});
});

describe("T5 (acceptance 6): three consecutive failed train launches stop every path, and Jo hears it NOW", () => {
	test("replay of 2026-10-26: after three never-ready launches the next passes request nothing and start nothing; one NOW (incident) question, on fire, one jo-issues issue", () => {
		const w = live();
		w.threeFailures();
		const requests = w.tickRequests().length;
		const lines = w.pass();
		w.pass();
		w.pass();
		expect(w.trainLaunches()).toHaveLength(3);
		expect(w.tickRequests()).toHaveLength(requests);
		expect(lines).toContainEqual(expect.stringContaining("not requested: train launch limit: 3 consecutive failed launches"));
		const qs = w.limitQuestions();
		expect(qs).toHaveLength(1);
		const q = qs[0]!;
		expect(JSON.parse(q.options)).toEqual([...TRAIN_LAUNCH_OPTIONS]);
		expect(q.slice_id).toBe(trainSliceId(w.train, 101));
		for (const l of w.trainLaunches()) expect(q.body).toContain(l.split(" ")[0]!);
		const line = errorLines(w.ledger).find((l) => l.kind === "question" && l.rowId === q.id)!;
		expect(line).toMatchObject({ state: "now", line: expect.stringMatching(/^NOW \(incident\): /) });
		expect(onFire(w.ledger, line)).toBe(true);
		expect(w.creates()).toHaveLength(1);
		expect(w.creates()[0]).toEqual(expect.arrayContaining(["-R", TRAIN_ALERT_REPO]));
	});

	test("at the limit a drain and a `resume` cause are refused `not-launchable: train launch limit`", () => {
		const w = live();
		w.pass();
		const q = w.park(101);
		const ans = w.answer(q, "merge");
		// three resume launches each end never ready: the answer stays unconsumed (D2), so launchable still reads `resume`
		w.starts.push("never-ready", "never-ready", "never-ready");
		for (let i = 0; i < 3; i++) w.pass();
		expect(w.trainLaunches().filter((l) => l.includes(`cause resume ${ans} `))).toHaveLength(3);
		expect(verdictOf(launchRowsFor(w.ledger, w.train, CAP)!)).toEqual({ launch: true, cause: { kind: "resume", ids: [ans] } });
		// the exit drain (here before the tick's next pass) and the resume reservation both stop at the limit
		expect(w.drain().filter((d) => d.wl === w.train)).toEqual([{ wl: w.train, code: STARTER_EXIT["not-launchable"]!, line: expect.stringContaining("not-launchable: train launch limit: 3 consecutive failed launches") }]);
		expect(laneScript.reserve(w.ledger, w.train, LANE_RUNNER_BY, false, SHOW, w.probeFor)).toMatchObject({ ok: false, reason: expect.stringMatching(/^not-launchable: train launch limit: /) });
		w.pass();
		w.pass();
		expect(w.trainLaunches()).toHaveLength(4);
		expect(w.limitQuestions()).toHaveLength(1);
	});
});

describe("T6 (acceptance 6): episodes, resets, and the PR the train never worked", () => {
	test("relaunch: the next pass launches and its lane-ready: resets the count; stop on a later episode: no second question, nothing launched; Jo's launch word starts a new episode; three more failures raise a new question and a new issue", () => {
		const w = live();
		w.threeFailures();
		w.pass();
		const [first] = w.limitQuestions();
		w.answer(first!.id, "relaunch");
		w.pass();
		expect(w.trainLaunches()).toHaveLength(4);
		expect(w.ledger.workload(w.train)!.holder).toBe(w.lane());
		// the ready lane dies before it touches #101 (the D4 question's tick-created slice): the PR is not yet worked
		w.exit("died");
		w.starts.push("never-ready", "never-ready", "never-ready");
		for (let i = 0; i < 3; i++) w.pass();
		expect(w.trainLaunches()).toHaveLength(7);
		w.pass();
		const second = w.limitQuestions().filter((q) => q.id !== first!.id);
		expect(second).toHaveLength(1);
		expect(w.creates()).toHaveLength(2);
		w.answer(second[0]!.id, "stop");
		for (let i = 0; i < 3; i++) w.pass();
		expect(w.trainLaunches()).toHaveLength(7);
		expect(w.limitQuestions()).toHaveLength(2);
		// Jo's launch word: a reset; the tick's next pass serves it
		const word = w.joRequest();
		w.starts.push("never-ready", "never-ready", "never-ready");
		w.pass();
		expect(w.trainLaunches().at(-1)).toBe(`${w.lane()} cause request ${word} requested-by merge-train`);
		w.pass();
		w.pass();
		expect(w.trainLaunches()).toHaveLength(10);
		w.pass();
		expect(w.trainLaunches()).toHaveLength(10);
		const third = w.limitQuestions().filter((q) => q.id !== first!.id && q.id !== second[0]!.id);
		expect(third).toHaveLength(1);
		expect(w.creates()).toHaveLength(3);
	});

	test("an unfinalized crash (no ready, no failure record) counts once its lease lapses; one still held under a live lease does not", () => {
		const w = live();
		w.starts.push("never-ready", "never-ready", "crash");
		for (let i = 0; i < 3; i++) w.pass();
		expect(w.trainLaunches()).toHaveLength(3);
		w.pass(); // the crashed attempt's pre-claim is live: in flight, not counted
		expect(w.limitQuestions()).toEqual([]);
		expect(w.trainLaunches()).toHaveLength(3);
		w.c.plusHours(0.1);
		w.pass();
		expect(w.limitQuestions()).toHaveLength(1);
		expect(w.trainLaunches()).toHaveLength(3);
	});

	test("a one-PR train never worked: relaunch, a never-ready attempt, a ready lane that crashes, then a ready lane that parks on the PR: each pass before the park launches, none after", () => {
		const w = live();
		w.threeFailures();
		w.pass();
		const [q] = w.limitQuestions();
		expect(w.ledger.slice(trainSliceId(w.train, 101))!.created_by).toBe(MERGE_TRAIN_BY);
		w.answer(q!.id, "relaunch");
		w.starts.push("never-ready");
		w.pass();
		expect(w.trainLaunches()).toHaveLength(4);
		expect(actionable(w.ledger, w.train)).toContain("#101 not yet worked");
		w.pass(); // ready, then dies before it writes anything on #101's slice
		expect(w.trainLaunches()).toHaveLength(5);
		w.exit("died");
		expect(actionable(w.ledger, w.train)).toEqual(["#101 not yet worked"]);
		w.pass(); // ready: it works #101 and parks on a question about it
		expect(w.trainLaunches()).toHaveLength(6);
		w.park(101);
		for (let i = 0; i < 3; i++) w.pass();
		expect(w.trainLaunches()).toHaveLength(6);
	});

	test("a one-PR train whose PR waits on a dependency: a ready lane passes it over and releases (`released-open:`, open-work): nothing launches until the dependency merges", () => {
		const w = live();
		w.views.set(101, { body: "Depends-on: #200" });
		w.g.prs.set(200, { head: H1, branch: "feature/200" });
		w.threeFailures();
		w.pass();
		const [q] = w.limitQuestions();
		w.answer(q!.id, "relaunch");
		w.pass();
		expect(w.trainLaunches()).toHaveLength(4);
		// #101 is `waiting`: passed over with no entry, then lane_release with its slice open
		w.exit("open-work", { releasedOpen: 1 });
		for (let i = 0; i < 3; i++) w.pass();
		expect(w.trainLaunches()).toHaveLength(4);
		w.views.set(200, { state: "MERGED", mergedAt: w.c.now() });
		w.pass();
		expect(w.trainLaunches()).toHaveLength(5);
	});

	test("the same lane exiting open-work with no released-open: (OMP died mid-pass) leaves #101 not yet worked", () => {
		const w = live();
		w.views.set(101, { body: "Depends-on: #200" });
		w.g.prs.set(200, { head: H1, branch: "feature/200" });
		w.threeFailures();
		w.pass();
		const [q] = w.limitQuestions();
		w.answer(q!.id, "relaunch");
		w.pass();
		w.exit("open-work");
		w.pass();
		expect(w.trainLaunches()).toHaveLength(5);
	});

	test("four Jo requests written before three failures: the fourth, still pending, is refused at the limit", () => {
		const w = live();
		const requests = Array.from({ length: 4 }, () => w.joRequest());
		w.threeFailures();
		expect(w.trainLaunches().map((l) => l.replace(/^\S+ /, ""))).toEqual(requests.slice(0, 3).map((r) => `cause request ${r} requested-by merge-train`));
		w.pass();
		expect(w.trainLaunches()).toHaveLength(3);
		expect(w.limitQuestions()).toHaveLength(1);
		expect(w.drain().filter((d) => d.wl === w.train)).toEqual([{ wl: w.train, code: STARTER_EXIT["not-launchable"]!, line: expect.stringContaining("not-launchable: train launch limit") }]);
		expect(w.trainLaunches()).toHaveLength(3);
		expect(w.trainLaunches().some((l) => l.includes(requests[3]!))).toBe(false);
	});

	test("a train Jo flipped to user-driven refuses every by-hand reservation (train-autonomous, PLAN wl-mvr888nftz0vcl D5): no lane holds it, no lane row is written, and no failed launch counts", () => {
		const w = live();
		ensureStandingWorkload(w.ledger);
		w.ledger.flipMode(w.train, { by: SURFACE_BY, mode: "user-driven", author: "jo", channel: "surface" });
		const before = w.ledger.entries(w.train).length;
		for (let i = 0; i < 4; i++) {
			expect(laneScript.reserve(w.ledger, w.train, "jo", true, SHOW, w.probeFor)).toMatchObject({ ok: false, reason: "train-autonomous" });
			w.c.plusHours(STEP_H);
		}
		const now = w.ledger.workload(w.train)!;
		expect(now.holder).toBeNull();
		expect(w.ledger.entries(w.train).slice(before).filter((e) => /^lane-(started|ready|exit):/.test(e.body))).toEqual([]);
		expect(trainLaunchFailures({
			entries: w.ledger.entries(w.train), instructions: w.ledger.instructions(w.train), questions: w.ledger.questions(w.train), holder: now.holder, holderLeaseUntil: now.holder_lease_until, now: w.ledger.now(),
		}).count).toBe(0);
	});
});

// ---- T7: under Jev ranking ------------------------------------------------------------------------------------------

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
/** An env whose HOME holds the profile config for `rank` (where `readRankConfig` reads it), with the cap at five. */
function envFor(rank: RankConfig): Record<string, string> {
	const home = tmp("train-live-home");
	const config = join(home, ".omp", "profiles", "agent-system-2", "agent", "config.yml");
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, `setupVersion: 2\njevRank:\n  mode: ${rank.mode}\n  parallelBudgetUsd: ${rank.parallelBudgetUsd}\n`);
	return { HOME: home, AGENT_SYSTEM_PROFILE: "agent-system-2", [LANE_CAP_ENV]: String(CAP) };
}

describe("T7 (acceptances 1 and 2 under ranking): show, order and parallel", () => {
	for (const rank of [SHOW, ORDER, PARALLEL]) {
		test(`${rank.mode}: cap full, a higher-ranked ordinary workload, a same-repo lane live: the train's request-free answer resume is admitted by the surface path and by reserve; no ordinary workload is ranked below the train`, async () => {
			const w = live([101], rank);
			ensureStandingWorkload(w.ledger);
			w.pass();
			const q = w.park(101);
			// the cap's lanes, one of them on the train's repository (the parallel rule's same-repo hold)
			const lanes = [...w.busy(1, w.repo), ...w.busy(CAP - 1)];
			const hi = w.ordinary("hi: ranked above the train", false);
			signal(w.ledger, hi, 0.9);
			signal(w.ledger, w.train, 0.1);
			const ans = w.answer(q, "merge");
			const env = envFor(rank);
			expect(launchVerdict(w.ledger, env, w.train)).toEqual({ launch: true, cause: { kind: "resume", ids: [ans] } });
			// the surface's launch path; its exec runs the starter's reservation in-process. Both lanes below end never ready, so
			// the answer stays unconsumed and the train stays launchable for the ranking check after them.
			w.starts.push("never-ready", "never-ready");
			const f = fakePi(undefined, { exec: true });
			f.execs.answer = (_cmd, args) => {
				const r = w.starter(args[2]!, args[4]!, rank);
				return { stdout: `${r.line}\n`, stderr: "", code: r.code, killed: false };
			};
			const out = await triggerLaunch(f.pi, w.ledger, env, w.train, "test");
			expect(out).toMatchObject({ attempted: true, code: 0 });
			expect(w.trainLaunches().at(-1)).toBe(`${w.lane()} cause resume ${ans} requested-by test`);
			// reserve, the drain's and the tick's path: the same cause
			expect(w.starter(w.train, LANE_RUNNER_BY, rank)).toMatchObject({ code: 0 });
			expect(w.trainLaunches().at(-1)).toBe(`${w.lane()} cause resume ${ans} requested-by lane-runner`);
			expect(launchVerdict(w.ledger, env, w.train)).toEqual({ launch: true, cause: { kind: "resume", ids: [ans] } });
			// a slot frees: Jo pins the train above `hi`; `hi` is never ranked below the train (it takes no slot)
			w.exit("completed", { wl: lanes[1]!, laneId: w.ledger.workload(lanes[1]!)!.holder! });
			w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatOverride({ workloadId: w.train, input: `in-${w.train}`, shown: "en-shown" }) });
			const h = laneScript.reserve(w.ledger, hi, SURFACE_BY, false, rank, w.probeFor);
			const reason = h.ok ? null : h.reason;
			// parallel's budget of 0 holds every ordinary workload (`parallel: budget unknown`); never a rank refusal naming the train
			expect(reason === null || reason.startsWith("parallel: ")).toBe(true);
			expect(rank.mode === "parallel" ? reason !== null : h.ok).toBe(true);
			expect(reason ?? "").not.toContain(w.train);
		});
	}
});
