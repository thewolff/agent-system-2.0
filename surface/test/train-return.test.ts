// The merge train's return path (PLAN wl-mv8s8srodefytc rev 17.1 D6-D9, part 2): `recordTrainTask` writes a PR's task on the
// train, `settleTasks` gives each task one outcome bound to a fresh runner result, attempts count failed settles since Jo's
// `retry`, `openTrainFix` opens one fix workload per (repo, PR), the owner hears of its task in its first prompt and as one aside
// (`pushTrainTasks`), the train word keeps a PR on one open train, and `trainRouted` keeps a task's generic failures off needs-you.
// Temp ledgers, temp git checkouts with a fake GitHub origin, and the fake pi only.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY, type WorkloadRow } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { recordRepo, repoOf } from "../src/decision-log";
import { errorLines, trainRouted } from "../src/errors";
import { recordIncidentOnce, RETRY_LIMIT } from "../src/incident";
import { applyTrain, interpret } from "../src/input";
import {
	controlEntries, decideLaunch, firstPrompt, laneDiedExitBody, laneExitBody, launchRequestedBody, laneStopAcceptedBody, laneStopRequestBody, trainFixBody, verdictOf,
} from "../src/launch";
import {
	fixBindings, forkOf, forkTaskAlert, heldTrainPrs, nextAttempt, openTrainFix, ownerDeliveries, ownerTasks, raiseTwiceFailed, recordTrainTask, settleTasks, type TaskView,
	TRAIN_TASK_KINDS, trainHeldDetail, type TrainPush, type TrainTask, trainPushesOf, trainSliceId, trainTaskWindows, twiceFailed, unsettledTasks,
} from "../src/merge-train";
import { relaunchState } from "../src/relaunch";
import { makeRunId, pushDestBody, testRequestedBody, type TestRun, testRunBody, testRunFailedBody } from "../src/test-run";
import { INSTRUCTION_POLL_MS, LANE_TOOLS, LANE_TRAIN_RETURN_TOOL, MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, SURFACE_BY, TRAIN_TASK_FAILED_PREFIX } from "../src/types";
import { clock, ctxOf, fakePi, tempLedger, timers, tmp } from "./helpers";

const REPO = "thewolff/product";
const URL = `https://github.com/${REPO}.git`;
const TRAIN_LANE = "lane-train-1";
const OWNER_LANE = "lane-owner-1";
const JO = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
const H0 = "a".repeat(40);
const H1 = "b".repeat(40);
const H2 = "c".repeat(40);

/** A git checkout at a temp path whose origin is `url`, the `repo:` a workload is on. */
function checkout(url = URL): string {
	const dir = tmp("train-return-repo");
	for (const args of [["init", "-q"], ["config", "remote.origin.url", url]]) {
		const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	}
	return dir;
}

/** A PR view as `gh pr view --json TASK_VIEW_FIELDS` gives it: a same-repo branch by default. */
const view = (pr: number, head: string, branch: string): TaskView => ({
	number: pr, headRefName: branch, headRefOid: head, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" },
});

/**
 * A train on #101 and #106 held by TRAIN_LANE, and the owner workload of #101 (branch `wl/<owner>`, normal, autonomous, on a checkout
 * of the same repo), on one ledger with a settable clock (`now` given) or the real one.
 */
function world(opts: { now?: () => string; ownerMode?: WorkloadRow["mode"] } = {}) {
	const { ledger, path } = tempLedger(opts.now);
	const trainCheckout = checkout();
	const cmd = interpret(ledger, "train 101 106");
	if (cmd?.kind !== "train") throw new Error("not a train");
	const train = applyTrain(ledger, cmd, trainCheckout).workloadId;
	expect(ledger.claimWorkload(train, { by: LANE_STARTER_BY, holder: TRAIN_LANE, leaseMs: 600_000 }).won).toBe(true);
	const owner = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header", stakes: "normal", mode: opts.ownerMode ?? "autonomous" });
	recordRepo(ledger, owner, checkout());
	const branch = `wl/${owner}`;
	const ret = (pr: number, head: string, kind: TrainTask["kind"] = "red", headBranch = branch) =>
		recordTrainTask(ledger, { train, by: TRAIN_LANE, pr, kind, detail: `run tr-x red at ${head}\nsrc/x.test.ts > case 1: boom`, view: view(pr, head, headBranch), trainRepo: REPO });
	const task = (pr: number, head: string, kind: TrainTask["kind"] = "red", headBranch = branch): TrainTask => {
		const r = ret(pr, head, kind, headBranch);
		if (!r.ok) throw new Error(r.reason);
		return r.task;
	};
	/**
	 * The tick's settle pass at the PRs' `heads`, with GitHub's pushes to each head branch: `pushes[n]` when given, else none for
	 * every PR in `heads` (its listing read and empty). A PR missing from both has no push evidence this pass.
	 */
	const settle = (heads: Record<number, string>, now = ledger.now(), pushes: Record<number, TrainPush[]> = {}) => {
		const evidence = new Map<number, TrainPush[]>(Object.keys(heads).map((k) => [Number(k), []]));
		for (const [k, v] of Object.entries(pushes)) evidence.set(Number(k), v);
		const lines = settleTasks(ledger, { train, heads: new Map(Object.entries(heads).map(([k, v]) => [Number(k), v])), pushes: evidence }, now);
		for (const body of lines) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body });
		return lines;
	};
	let seq = 0;
	/** A runner request on `wl` for PR `pr` at `sha` on `slice`, and its result when `verdict` is given. */
	const run = (wl: string, slice: string, pr: number, sha: string, verdict: TestRun["verdict"] | null) => {
		const runId = makeRunId(Date.parse("2026-10-01T10:00:00.000Z") + ++seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice, by: OWNER_LANE }) });
		if (verdict === null) return runId;
		const full = { pass: 1, fail: verdict === "red" ? 1 : 0, skip: 0, exit: verdict === "red" ? 1 : 0, ms: 10, error: null };
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption",
			body: testRunBody({
				runId, verdict, sha, pr, reason: verdict === "error" ? "prepare failed" : null, headAtEnd: verdict === "error" ? null : sha, base: null, mergeBase: null,
				full: verdict === "error" ? null : full, solo: [], failures: verdict === "red" ? [{ part: "full", name: "src/x.test.ts > case 1", firstError: "boom" }] : [], runDir: null, preflight: null,
			}),
		});
		return runId;
	};
	return { ledger, path, train, owner, branch, trainCheckout, ret, task, settle, run };
}

describe("settling (D8): one terminal outcome per task, bound to a fresh result", () => {
	test("each task settles once: a later red or a later green writes nothing more", () => {
		const c = clock();
		const w = world({ now: c.now });
		const t = w.task(101, H0);
		expect(t).toMatchObject({ pr: 101, attempt: 1, kind: "red", head: H0, owner: w.owner });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H1, "green");
		expect(w.settle({ 101: H1 })).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${t.id} fixed `))]);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H2, "red");
		expect(w.settle({ 101: H2 })).toEqual([]);
		expect(w.settle({ 101: H2 }, new Date(Date.parse(c.now()) + 5 * 3_600_000).toISOString())).toEqual([]);
		expect(unsettledTasks(w.ledger, w.train)).toEqual([]);
	});

	test("a green requested before the task is ignored, as is a green at H0 or at a head the PR has left", () => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		w.run(w.owner, sl, 101, H1, "green");
		c.plusHours(0.1);
		const t = w.task(101, H0);
		expect(w.settle({ 101: H1 })).toEqual([]);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H0, "green");
		w.run(w.owner, sl, 101, H1, "green");
		// the PR moved on to H2: neither green is at the current head
		expect(w.settle({ 101: H2 })).toEqual([]);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H2, "green");
		expect(w.settle({ 101: H2 })).toEqual([expect.stringContaining(`${t.id} fixed`)]);
	});

	test("red → red → green on one reused slice: each task settles once, and the last only on the green at a new head", () => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const t1 = w.task(101, H0);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H1, "red");
		expect(w.settle({ 101: H1 })).toEqual([expect.stringContaining(`${t1.id} failed`)]);
		c.plusHours(0.1);
		const t2 = w.task(101, H1);
		expect(t2.attempt).toBe(2);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H2, "red");
		expect(w.settle({ 101: H2 })).toEqual([expect.stringContaining(`${t2.id} failed`)]);
		// attempt 2 failed: the tool refuses attempt 3 (Jo's alert is due) until Jo's retry
		c.plusHours(0.1);
		const refused = w.ret(101, H2);
		expect(refused.ok).toBe(false);
		const q = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 101), task: "PR #101", doneCondition: "terminal", inputs: "#101" });
		const alert = w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: q, body: "#101 failed twice", options: ["retry", "skip", "stop"] });
		c.plusHours(0.01);
		w.ledger.answerQuestion(alert, { ...JO, answer: "retry" });
		c.plusHours(0.01);
		const t3 = w.task(101, H2);
		expect(t3.attempt).toBe(1);
		// the slice's two reds were requested before t3: they settle nothing; a rerun at H2 (t3's own head) neither
		expect(w.settle({ 101: H2 })).toEqual([]);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H2, "green");
		expect(w.settle({ 101: H2 })).toEqual([]);
		c.plusHours(0.1);
		const H3 = "d".repeat(40);
		w.run(w.owner, sl, 101, H3, "green");
		expect(w.settle({ 101: H3 })).toEqual([expect.stringContaining(`${t3.id} fixed`)]);
	});

	test("an error never settles and is never an attempt; the next non-error result decides", () => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const t = w.task(101, H0);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H1, "error");
		expect(w.settle({ 101: H1 })).toEqual([]);
		expect(nextAttempt(w.ledger, w.train, 101)).toBe(1);
		c.plusHours(0.1);
		w.run(w.owner, sl, 101, H1, "green");
		expect(w.settle({ 101: H1 })).toEqual([expect.stringContaining(`${t.id} fixed`)]);
		expect(nextAttempt(w.ledger, w.train, 101)).toBe(1);
	});

	test("the owner's train-task-failed, a lane exit with no push, and 2 h with no push each settle failed", () => {
		const c = clock();
		const w = world({ now: c.now });
		const a = w.task(101, H0);
		const b = w.task(106, H0, "conflict", "feature/other");
		expect(b.owner).toBeNull();
		c.plusHours(0.1);
		w.ledger.recordEntry({ by: OWNER_LANE, workloadId: w.owner, kind: "assumption", body: `${TRAIN_TASK_FAILED_PREFIX} ${a.id} cannot reproduce` });
		// a lane's note counts only from a holder of the owner
		expect(w.settle({})).toEqual([]);
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 600_000 }).won).toBe(true);
		const lines = w.settle({});
		expect(lines).toEqual([expect.stringContaining(`${a.id} failed owner ${w.owner}`)]);
		// b has no owner yet: 2 h with no push on GitHub's record settles it
		c.plusHours(2);
		expect(w.settle({ 106: H0 })).toEqual([expect.stringContaining(`${b.id} failed no push for 2 h`)]);
	});

	test("an owner lane that exits with no push since the task settles it failed", () => {
		const c = clock();
		const w = world({ now: c.now });
		const t = w.task(101, H0);
		c.plusHours(0.1);
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.owner, kind: "assumption", body: laneExitBody(OWNER_LANE, { code: 0, signal: null, outcome: "released" }) });
		expect(w.settle({ 101: H0 })).toEqual([expect.stringContaining(`${t.id} failed lane ${OWNER_LANE}`)]);
	});

	test("a push-dest: is an attempt, not a push: an exit after one settles failed, and it does not move the 2 h mark; a push GitHub records does both", () => {
		const c = clock();
		const w = world({ now: c.now });
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 600_000 }).won).toBe(true);
		const t = w.task(101, H0);
		c.plusHours(0.1);
		// row 8 records the destination before the push runs; the remote rejected it and the head stayed at H0
		w.ledger.recordEntry({ by: OWNER_LANE, workloadId: w.owner, kind: "assumption", body: pushDestBody({ remote: "origin", branch: w.branch, sha: H1 }) });
		c.plusHours(0.1);
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.owner, kind: "assumption", body: laneExitBody(OWNER_LANE, { code: 0, signal: null, outcome: "released" }) });
		expect(w.settle({ 101: H0 })).toEqual([expect.stringContaining(`${t.id} failed lane ${OWNER_LANE}`)]);

		const c2 = clock();
		const v = world({ now: c2.now });
		expect(v.ledger.claimWorkload(v.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 600_000 }).won).toBe(true);
		const u = v.task(101, H0);
		c2.plusHours(1.5);
		v.ledger.recordEntry({ by: OWNER_LANE, workloadId: v.owner, kind: "assumption", body: pushDestBody({ remote: "origin", branch: v.branch, sha: H1 }) });
		c2.plusHours(0.6);
		expect(v.settle({ 101: H0 })).toEqual([expect.stringContaining(`${u.id} failed no push for 2 h since ${u.createdAt}`)]);

		// a push on GitHub's record: the exit after it settles nothing, and the 2 h runs from its time
		const c3 = clock();
		const x = world({ now: c3.now });
		const y = x.task(101, H0);
		c3.plusHours(1.5);
		const pushed: TrainPush = { sha: H1, at: c3.now() };
		c3.plusHours(0.1);
		x.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: x.owner, kind: "assumption", body: laneExitBody(OWNER_LANE, { code: 0, signal: null, outcome: "released" }) });
		c3.plusHours(1);
		expect(x.settle({ 101: H1 }, c3.now(), { 101: [pushed] })).toEqual([]);
		c3.plusHours(1);
		expect(x.settle({ 101: H1 }, c3.now(), { 101: [pushed] })).toEqual([expect.stringContaining(`${y.id} failed no push for 2 h since ${pushed.at}`)]);
	});

	test("a runner request is not a push, and without GitHub's record of the current head neither push rule settles", () => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const t = w.task(101, H0);
		c.plusHours(1.5);
		// the owner's runner request at H1 dates nothing: on GitHub's record the branch has no push since the task
		w.run(w.owner, sl, 101, H1, null);
		c.plusHours(0.6);
		expect(w.settle({ 101: H0 })).toEqual([expect.stringContaining(`${t.id} failed no push for 2 h since ${t.createdAt}`)]);

		const c2 = clock();
		const v = world({ now: c2.now });
		const u = v.task(101, H0);
		c2.plusHours(0.5);
		v.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: v.owner, kind: "assumption", body: laneExitBody(OWNER_LANE, { code: 0, signal: null, outcome: "released" }) });
		c2.plusHours(2);
		// the head moved to H1 but GitHub's record does not name it yet: no evidence, so no exit or 2 h settle
		expect(v.settle({ 101: H1 })).toEqual([]);
		// no listing at all this pass (gh failed): the same
		expect(v.settle({}, c2.now(), {})).toEqual([]);
		// the record catches up: H1 was pushed before the exit, and the 2 h since it has passed
		const pushed: TrainPush = { sha: H1, at: new Date(Date.parse(u.createdAt) + 0.25 * 3_600_000).toISOString() };
		expect(v.settle({ 101: H1 }, c2.now(), { 101: [pushed] })).toEqual([expect.stringContaining(`${u.id} failed no push for 2 h since ${pushed.at}`)]);
	});

	test("a green after the 2 h mark waits for push evidence rather than settling fixed without it", () => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const t = w.task(101, H0);
		c.plusHours(2.5);
		w.run(w.owner, sl, 101, H1, "green");
		c.plusHours(0.05);
		expect(w.settle({ 101: H1 }, c.now(), {})).toEqual([]);
		expect(w.settle({ 101: H1 }, c.now(), { 101: [{ sha: H1, at: new Date(Date.parse(t.createdAt) + 2.4 * 3_600_000).toISOString() }] }))
			.toEqual([expect.stringContaining(`${t.id} failed no push for 2 h since ${t.createdAt}`)]);
	});

	test("a 2 h stretch with no push fails the task at its mark even when a later push came before the tick", () => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const t = w.task(101, H0);
		// the first push comes 3 h after the task and its run is green; the tick runs only after both
		c.plusHours(3);
		const late: TrainPush = { sha: H1, at: c.now() };
		w.run(w.owner, sl, 101, H1, "green");
		c.plusHours(0.05);
		expect(w.settle({ 101: H1 }, c.now(), { 101: [late] })).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${t.id} failed .*${t.createdAt}`))]);
		// a gap between two pushes counts the same way
		const c2 = clock();
		const v = world({ now: c2.now });
		const sl2 = v.ledger.addSlice({ by: OWNER_LANE, workloadId: v.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const u = v.task(101, H0);
		c2.plusHours(1);
		const first: TrainPush = { sha: H1, at: c2.now() };
		v.run(v.owner, sl2, 101, H1, "error");
		c2.plusHours(2.5);
		const second: TrainPush = { sha: H2, at: c2.now() };
		v.run(v.owner, sl2, 101, H2, "green");
		expect(v.settle({ 101: H2 }, c2.now(), { 101: [first, second] })).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${u.id} failed .*${first.at}`))]);
	});
});

describe("push evidence is GitHub's push time, not a runner request's (review gtb-r2 F2)", () => {
	/** A task at 10:00 on #101 (head H0), and GitHub's push of H1 at `pushedAt` (an ISO time on 2026-10-01). */
	const scenario = (pushedAt: string) => {
		const c = clock("2026-10-01T10:00:00.000Z");
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const t = w.task(101, H0);
		expect(t.createdAt).toBe("2026-10-01T10:00:00.000Z");
		const pushes = { 101: [{ sha: H1, at: pushedAt }] };
		return { c, w, sl, t, pushes };
	};

	test("push at 11:30, no request, tick at 12:05: not failed", () => {
		const { c, w, pushes } = scenario("2026-10-01T11:30:00.000Z");
		c.at("2026-10-01T12:05:00.000Z");
		expect(w.settle({ 101: H1 }, c.now(), pushes)).toEqual([]);
	});

	test("push at 11:30, request at 12:05, green at 12:10: fixed", () => {
		const { c, w, sl, t, pushes } = scenario("2026-10-01T11:30:00.000Z");
		c.at("2026-10-01T12:05:00.000Z");
		const runId = w.run(w.owner, sl, 101, H1, null);
		c.at("2026-10-01T12:10:00.000Z");
		w.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: w.owner, sliceId: sl, kind: "assumption",
			body: testRunBody({
				runId, verdict: "green", sha: H1, pr: 101, reason: null, headAtEnd: H1, base: null, mergeBase: null,
				full: { pass: 1, fail: 0, skip: 0, exit: 0, ms: 10, error: null }, solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
		c.at("2026-10-01T12:15:00.000Z");
		expect(w.settle({ 101: H1 }, c.now(), pushes)).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${t.id} fixed run ${runId} green at ${H1}`))]);
	});

	test("push at 10:10, request at 11:50, no later push, tick at 13:10: failed at the 12:10 mark", () => {
		const { c, w, sl, t, pushes } = scenario("2026-10-01T10:10:00.000Z");
		c.at("2026-10-01T11:50:00.000Z");
		w.run(w.owner, sl, 101, H1, null);
		c.at("2026-10-01T13:10:00.000Z");
		expect(w.settle({ 101: H1 }, c.now(), pushes)).toEqual([`train-task-settled: ${t.id} failed no push for 2 h since 2026-10-01T10:10:00.000Z`]);
	});

	test("every head-moving activity is a push (a PR merged into the head branch included); a deletion is not (review gtb-r3)", () => {
		const at = (m: number) => `2026-10-01T11:${String(m).padStart(2, "0")}:00Z`;
		const act = (type: string, after: string, m: number, ref = "refs/heads/wl/x") => ({ activity_type: type, after, before: H0, ref, timestamp: at(m) });
		const page = [
			act("push", H0, 1), act("force_push", H1, 2), act("pr_merge", H0, 3), act("merge_queue_merge", H1, 4),
			act("branch_creation", H0, 5), act("branch_deletion", "0".repeat(40), 6), act("pr_merge", H1, 7, "refs/heads/other"),
		];
		expect(trainPushesOf([page], "wl/x")?.map((p) => p.sha)).toEqual([H0, H1, H0, H1, H0]);
		// A PR merged into the head branch at 11:30 makes the current head; its green settles the task.
		const { c, w, sl, t } = scenario("2026-10-01T11:30:00.000Z");
		const merged = trainPushesOf([[act("pr_merge", H1, 30)]], "wl/x")!;
		c.at("2026-10-01T12:05:00.000Z");
		const runId = w.run(w.owner, sl, 101, H1, null);
		w.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: w.owner, sliceId: sl, kind: "assumption",
			body: testRunBody({
				runId, verdict: "green", sha: H1, pr: 101, reason: null, headAtEnd: H1, base: null, mergeBase: null,
				full: { pass: 1, fail: 0, skip: 0, exit: 0, ms: 10, error: null }, solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
		c.at("2026-10-01T13:59:00.000Z");
		expect(w.settle({ 101: H1 }, c.now(), { 101: merged })).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${t.id} fixed run ${runId} green at ${H1}`))]);
	});
});

describe("recording a task (D6)", () => {
	test("the kinds, the owner by D1, the PR on the train, and one unsettled task per PR", () => {
		const w = world();
		expect([...TRAIN_TASK_KINDS]).toEqual(["red", "conflict", "stack"]);
		expect(w.ret(139, H0)).toMatchObject({ ok: false, reason: expect.stringContaining("not on merge train") });
		const t = w.task(101, H0, "stack");
		expect(w.ret(101, H0)).toMatchObject({ ok: false, reason: expect.stringContaining(t.id) });
		// a fork's PR has no owner
		const fork = recordTrainTask(w.ledger, { train: w.train, by: TRAIN_LANE, pr: 106, kind: "red", detail: "d", view: { ...view(106, H0, w.branch), isCrossRepository: true }, trainRepo: REPO });
		expect(fork).toMatchObject({ ok: true, task: { owner: null } });
		// the train-task: is a holder's control line; a lane that does not hold the train writes nothing that counts
		const body = controlEntries(w.ledger.entries(w.train), [TRAIN_LANE]).filter((e) => e.prefix === "train-task");
		expect(body).toHaveLength(2);
		expect(body[0]!.body).toStartWith(`train-task: ${t.id} pr 101 attempt 1 kind stack head ${H0} owner ${w.owner}\n`);
	});
});

describe("one train per PR (rev 17.1 D8)", () => {
	test("the train word refuses a PR on another open train of the same repo, opening or appending; another repo or a skipped PR is free", () => {
		const w = world();
		const again = interpret(w.ledger, "train 106 139");
		if (again?.kind !== "train") throw new Error("not a train");
		expect(() => applyTrain(w.ledger, again, w.trainCheckout)).toThrow(w.train);
		const other = interpret(w.ledger, "train 139");
		if (other?.kind !== "train") throw new Error("not a train");
		const second = applyTrain(w.ledger, other, w.trainCheckout).workloadId;
		expect(interpret(w.ledger, `train ${second} 101`)).toMatchObject({ kind: "refused", why: expect.stringContaining(w.train) });
		// another repo's #101 is another PR
		const elsewhere = interpret(w.ledger, "train 101");
		if (elsewhere?.kind !== "train") throw new Error("not a train");
		expect(() => applyTrain(w.ledger, elsewhere, checkout("https://github.com/thewolff/other.git"))).not.toThrow();
		// Jo's skip takes #106 off the first train, so a new train may carry it
		const sl = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 106), task: "PR #106", doneCondition: "terminal", inputs: "#106" });
		const q = w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: sl, body: "#106 production", options: ["merged", "skip", "stop"] });
		w.ledger.answerQuestion(q, { ...JO, answer: "skip" });
		expect(interpret(w.ledger, `train ${second} 106`)).toMatchObject({ kind: "train-append" });
	});

	test("the same repository is its GitHub owner/repo: a subdirectory or another checkout of it is refused too, whatever its case", () => {
		const w = world();
		const sub = join(w.trainCheckout, "surface");
		mkdirSync(sub);
		for (const where of [sub, checkout(), checkout("git@github.com:TheWolff/Product.git")]) {
			const again = interpret(w.ledger, "train 101");
			if (again?.kind !== "train") throw new Error("not a train");
			expect(() => applyTrain(w.ledger, again, where)).toThrow(w.train);
		}
		// a train opened from another checkout of the repo is refused #101 on append as well
		const other = interpret(w.ledger, "train 139");
		if (other?.kind !== "train") throw new Error("not a train");
		const second = applyTrain(w.ledger, other, checkout()).workloadId;
		expect(interpret(w.ledger, `train ${second} 101`)).toMatchObject({ kind: "refused", why: expect.stringContaining(w.train) });
	});
});

describe("fix workloads for owner none (D8)", () => {
	test("one fix workload per (repo, PR), reused; it carries repo:, done:, the binding, push-dest: and launch-requested: by merge-train", () => {
		const w = world();
		const t = w.task(106, H0, "conflict", "feature/other");
		expect(ownerDeliveries(w.ledger)).toEqual([{ kind: "fix", task: expect.objectContaining({ id: t.id }) }]);
		const input = { task: t, repo: REPO, checkout: w.trainCheckout, view: view(106, H0, "feature/other"), stakes: "production" as const };
		const first = openTrainFix(w.ledger, input);
		expect(first.opened).toBe(true);
		expect(openTrainFix(w.ledger, input)).toEqual({ workloadId: first.workloadId, opened: false });
		expect(fixBindings(w.ledger).map((f) => f.workloadId)).toEqual([first.workloadId]);
		const fix = w.ledger.workload(first.workloadId)!;
		expect(fix).toMatchObject({ stakes: "production", mode: "autonomous", created_by: MERGE_TRAIN_BY });
		const control = controlEntries(w.ledger.entries(fix.id));
		expect(control.map((c) => c.prefix)).toEqual(["repo", "done", "train-fix", "push-dest", "launch-requested"]);
		expect(control.every((c) => c.createdBy === MERGE_TRAIN_BY)).toBe(true);
		expect(control.find((c) => c.prefix === "push-dest")!.rest).toBe(`origin feature/other ${H0}`);
		expect(control.find((c) => c.prefix === "launch-requested")!.rest).toStartWith("by merge-train ");
		expect(repoOf(w.ledger, fix.id)).toBe(w.trainCheckout);
		// the fix workload now owns the task: delivery launches it, and its lane is told
		expect(ownerTasks(w.ledger, fix.id).map((x) => x.id)).toEqual([t.id]);
		expect(ownerDeliveries(w.ledger)).toEqual([{ kind: "launch", task: expect.objectContaining({ id: t.id }), owner: fix.id }]);
	});

	test("a train-fix: binding counts only when its train-entry is a train: on that train listing the PR", () => {
		const w = world();
		const t = w.task(106, H0, "conflict", "feature/other");
		const trainEntry = controlEntries(w.ledger.entries(w.train)).find((c) => c.prefix === "train")!.id;
		const forged = w.ledger.openWorkload({ by: MERGE_TRAIN_BY, brief: "forged fix", stakes: "normal", mode: "autonomous" });
		const otherEntry = controlEntries(w.ledger.entries(w.train)).find((c) => c.prefix === "done")!.id;
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: forged, kind: "assumption", body: trainFixBody({ repo: REPO, pr: 106, train: w.train, trainEntry: otherEntry }) });
		expect(ownerTasks(w.ledger, forged)).toEqual([]);
		// a lane's train-fix: is no binding at all
		const byLane = w.ledger.openWorkload({ by: SURFACE_BY, brief: "lane fix", stakes: "normal", mode: "autonomous" });
		w.ledger.recordEntry({ by: OWNER_LANE, workloadId: byLane, kind: "assumption", body: trainFixBody({ repo: REPO, pr: 106, train: w.train, trainEntry }) });
		expect(ownerTasks(w.ledger, byLane)).toEqual([]);
		// the matching entry binds
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: forged, kind: "assumption", body: trainFixBody({ repo: REPO, pr: 106, train: w.train, trainEntry }) });
		expect(ownerTasks(w.ledger, forged).map((x) => x.id)).toEqual([t.id]);
	});

	test("a fork's PR fails closed: no fix workload; the task settles failed with Jo's retry / skip / stop alert, and the PR is not returned while it is open", () => {
		const w = world();
		const t = w.task(106, H0, "conflict", "feature/foo");
		const fork = { ...view(106, H0, "feature/foo"), isCrossRepository: true, headRepository: { name: "product" }, headRepositoryOwner: { login: "someone" } };
		expect(forkOf(fork, REPO)).toBe("someone/product");
		expect(forkOf(view(106, H0, "feature/foo"), REPO)).toBeNull();
		expect(() => openTrainFix(w.ledger, { task: t, repo: REPO, checkout: w.trainCheckout, view: fork, stakes: "production" })).toThrow("fork");
		expect(fixBindings(w.ledger)).toEqual([]);
		const q = forkTaskAlert(w.ledger, t, fork, REPO);
		expect(q).not.toBeNull();
		expect(forkTaskAlert(w.ledger, t, fork, REPO)).toBeNull();
		expect(w.ledger.questions(w.train)).toEqual([expect.objectContaining({ id: q, slice_id: trainSliceId(w.train, 106), state: "open", options: JSON.stringify(["retry", "skip", "stop"]) })]);
		expect(controlEntries(w.ledger.entries(w.train)).filter((c) => c.prefix === "train-task-settled").map((c) => c.rest)).toEqual([expect.stringMatching(new RegExp(`^${t.id} failed `))]);
		expect(ownerDeliveries(w.ledger)).toEqual([]);
		// while Jo's alert is open the train cannot return the PR again (attempt 2 would be one more task no one can fix)
		const again = w.ret(106, H0, "conflict", "feature/foo");
		expect(again.ok).toBe(false);
		expect(twiceFailed(w.ledger, w.train)).toEqual([]);
	});
});

describe("the owner hears of its task (D7)", () => {
	test("firstPrompt lists the unsettled tasks with their detail and the open suite slice", () => {
		const w = world();
		const t = w.task(101, H0);
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		w.run(w.owner, sl, 101, H0, "red");
		const tasks = ownerTasks(w.ledger, w.owner);
		expect(tasks).toEqual([{ id: t.id, train: w.train, pr: 101, attempt: 1, kind: "red", head: H0, detail: t.detail, slice: sl }]);
		const prompt = firstPrompt({
			workload: w.ledger.workload(w.owner)!, laneId: OWNER_LANE, repo: "/r", worktree: "/w", branch: w.branch, done: null, planFirst: null, decisionLog: "", facts: "",
			resolved: [], instructions: [], machinery: false, tools: LANE_TOOLS, trainTasks: tasks,
		});
		for (const s of [t.id, w.train, "PR #101", "src/x.test.ts > case 1: boom", sl, `${TRAIN_TASK_FAILED_PREFIX} ${t.id}`]) expect(prompt).toContain(s);
		expect(firstPrompt({
			workload: w.ledger.workload(w.owner)!, laneId: OWNER_LANE, repo: "/r", worktree: "/w", branch: w.branch, done: null, planFirst: null, decisionLog: "", facts: "",
			resolved: [], instructions: [], machinery: false, tools: LANE_TOOLS, trainTasks: [],
		})).not.toContain(t.id);
	});

	test("pushTrainTasks: a task the first prompt named is not resent; a new one is pushed once per session", async () => {
		timers.length = 0;
		const w = world();
		const inPrompt = w.task(101, H0);
		const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: w.path, AGENT_SYSTEM_WORKLOAD_ID: w.owner, AGENT_SYSTEM_LANE_ID: OWNER_LANE, HOME: "/nonexistent-home" };
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const asides = () => f.sent.filter((s) => s.message.customType === "lane-train-task");
		const poll = () => timers.find((t) => t.ms === INSTRUCTION_POLL_MS)!;
		await f.emit("before_agent_start", { prompt: `tasks: ${inPrompt.id}`, systemPrompt: [] }, ctx);
		poll().fn();
		expect(asides()).toEqual([]);
		// a second PR comes back to the same owner while the lane is live
		const branch106 = view(106, H1, w.branch);
		const later = recordTrainTask(w.ledger, { train: w.train, by: TRAIN_LANE, pr: 106, kind: "conflict", detail: "MIGRATION.md conflict", view: branch106, trainRepo: REPO });
		if (!later.ok) throw new Error(later.reason);
		poll().fn();
		await f.emit("tool_result", { toolName: "read", toolCallId: "r1", input: {}, isError: false }, ctx);
		poll().fn();
		expect(asides()).toHaveLength(1);
		expect(asides()[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(asides()[0]!.message.content).toContain(later.task.id);
		expect(asides()[0]!.message.content).toContain("MIGRATION.md conflict");
	});

	test("lane_train_return reads the detail file and gh's view, and writes the task as the lane holding the train", async () => {
		const w = world();
		const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: w.path, AGENT_SYSTEM_WORKLOAD_ID: w.train, AGENT_SYSTEM_LANE_ID: TRAIN_LANE, HOME: "/nonexistent-home" };
		const f = fakePi(undefined, { exec: true });
		f.execs.answer = (command, args) =>
			command === "gh" && args.includes("view") ? { stdout: JSON.stringify(view(101, H1, w.branch)), stderr: "", code: 0, killed: false } : { stdout: "", stderr: "no", code: 1, killed: false };
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const detail = join(tmp("detail"), "detail.md");
		writeFileSync(detail, "run tr-1 red\nsrc/a.test.ts > b: boom\n");
		const r = await f.tool(LANE_TRAIN_RETURN_TOOL).execute("t1", { pr: "#101", kind: "red", detail }, undefined, undefined, ctx);
		expect(r.content[0]!.text).toContain(`owner ${w.owner}`);
		expect(f.execs.calls[0]!.args).toEqual(["pr", "view", "101", "-R", REPO, "--json", expect.stringContaining("headRefOid")]);
		const [t] = unsettledTasks(w.ledger, w.train);
		expect(t).toMatchObject({ pr: 101, kind: "red", head: H1, owner: w.owner, detail: "run tr-1 red\nsrc/a.test.ts > b: boom" });
		const rel = await f.tool(LANE_TRAIN_RETURN_TOOL).execute("t2", { pr: "101", kind: "red", detail: "detail.md" }, undefined, undefined, ctx);
		expect(rel.content[0]!.text).toContain("Nothing was returned");
		expect(unsettledTasks(w.ledger, w.train)).toHaveLength(1);
	});
});

describe("train-aware routing (D9 F16)", () => {
	test("trainRouted: inside a window, once per window for deaths; outside, never", () => {
		const windows = [{ taskId: "tt-1", pr: 101, from: "2026-10-01T10:00:00.000Z", to: "2026-10-01T12:00:00.000Z", counted: null }, { taskId: "tt-2", pr: 101, from: "2026-10-01T13:00:00.000Z", to: null, counted: null }];
		expect(trainRouted(windows, "2026-10-01T09:59:59.999Z")).toBeNull();
		expect(trainRouted(windows, "2026-10-01T11:00:00.000Z")?.taskId).toBe("tt-1");
		expect(trainRouted(windows, "2026-10-01T12:30:00.000Z")).toBeNull();
		expect(trainRouted(windows, "2026-10-02T00:00:00.000Z")?.taskId).toBe("tt-2");
		// a second death in the same window is not the first: it reaches Jo
		expect(trainRouted(windows, "2026-10-01T11:30:00.000Z", ["2026-10-01T11:00:00.000Z", "2026-10-01T11:30:00.000Z"])).toBeNull();
		expect(trainRouted(windows, "2026-10-01T11:00:00.000Z", ["2026-10-01T11:00:00.000Z", "2026-10-01T11:30:00.000Z"])?.taskId).toBe("tt-1");
	});

	test("an owner's first lane death, its intended exit with open work and the runner's no-live-lane notice stay off needs-you while its task is unsettled", () => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		const kinds = () => errorLines(w.ledger, undefined, { now: c.now() }).filter((l) => l.workloadId === w.owner).map((l) => l.kind).sort();
		// before any task: an intended exit with open work is an idle line
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.owner, kind: "assumption", body: laneExitBody("lane-old", { code: 0, signal: null, outcome: "released" }) });
		expect(kinds()).toEqual(["idle"]);
		c.plusHours(0.1);
		const t = w.task(101, H0);
		expect(trainTaskWindows(w.ledger).get(w.owner)).toEqual([{ taskId: t.id, pr: 101, from: t.createdAt, to: null, counted: null }]);
		c.plusHours(0.1);
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.owner, kind: "assumption", body: laneExitBody(OWNER_LANE, { code: 0, signal: null, outcome: "released" }) });
		w.ledger.enqueue({ by: OWNER_LANE, workloadId: w.owner, sender: OWNER_LANE, recipient: "orchestrator", body: `lane-died: ${OWNER_LANE} shutdown: SIGTERM` });
		w.run(w.owner, sl, 101, H1, "red");
		w.ledger.enqueue({
			by: TEST_RUNNER_BY, workloadId: w.owner, sliceId: sl, sender: TEST_RUNNER_BY, recipient: "orchestrator",
			body: testRunFailedBody({ workloadId: w.owner, slice: sl, verdict: "red", sha: H1, failing: 1, first: "src/x.test.ts" }),
		});
		expect(kinds()).toEqual([]);
		// a second death inside the same window is not the first: it reaches Jo
		c.plusHours(0.1);
		w.ledger.enqueue({ by: "lane-owner-2", workloadId: w.owner, sender: "lane-owner-2", recipient: "orchestrator", body: "lane-died: lane-owner-2 shutdown: SIGTERM" });
		expect(kinds()).toEqual(["lane-died"]);
	});

	test("a runner failure stays off needs-you only for the task's own PR while it is unsettled, or as the red its settle counted", () => {
		const c = clock();
		const w = world({ now: c.now });
		const shown = () => errorLines(w.ledger, undefined, { now: c.now() }).filter((l) => l.workloadId === w.owner && l.kind === "test-run").map((l) => l.rowId);
		const failed = (slice: string, verdict: "red" | "error", sha: string) =>
			w.ledger.enqueue({ by: TEST_RUNNER_BY, workloadId: w.owner, sliceId: slice, sender: TEST_RUNNER_BY, recipient: "orchestrator", body: testRunFailedBody({ workloadId: w.owner, slice, verdict, sha, failing: 1, first: null }) });
		const t = w.task(101, H0);
		c.plusHours(0.1);
		// the owner's other PR, #106, goes red while #101's task is open: not the task's to count, so Jo sees it
		const other = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #106", doneCondition: "green", inputs: "#106" });
		w.run(w.owner, other, 106, H1, "red");
		const m106 = failed(other, "red", H1);
		c.plusHours(0.1);
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		w.run(w.owner, sl, 101, H1, "error");
		const mError = failed(sl, "error", H1);
		c.plusHours(0.1);
		const red = w.run(w.owner, sl, 101, H2, "red");
		failed(sl, "red", H2);
		// #101's error and red are the open task's; #106's red is shown
		expect(shown()).toEqual([m106]);
		c.plusHours(0.1);
		expect(w.settle({ 101: H2 })).toEqual([expect.stringContaining(`${t.id} failed run ${red} red`)]);
		// settled: its counted red stays routed, but the error it never counted now reaches Jo
		expect(shown()).toEqual([mError]);
	});
});

describe("an owner death the relaunch takes on is not a train attempt (PLAN wl-mvfqvd5hy8zv28 § 1.7)", () => {
	const MIN_H = 1 / 60;
	/**
	 * The owner's lanes as the starter and the runner leave them on `w`'s ledger. `reserve` is `reserveLane` under the launch
	 * predicate, so its cause is the relaunch counter as written. `die` ends lane `laneId` as the runner does: an unintended
	 * `lane-exit:` and its `lane-died:`, or for `signal` the restart stop's acceptance, death and exit (§ 1.2); then the release.
	 */
	const lanes = (w: { ledger: Ledger; owner: string }) => {
		const reserve = (leaseMs = 10 * 60_000) => {
			const r = w.ledger.reserveLane(w.owner, { by: LANE_STARTER_BY, cap: 5, leaseMs, requestedBy: "tick", decide: decideLaunch });
			if (!r.ok) throw new Error(r.reason);
			return r;
		};
		const runner = (body: string) => w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.owner, kind: "assumption", body });
		const died = (body: string) => w.ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: w.owner, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body });
		const die = (laneId: string, how: "error" | "open-work" | "signal" = "error") => {
			if (how === "signal") {
				runner(laneStopAcceptedBody(laneId, "signal"));
				died(`lane-died: ${laneId}: stopped by signal SIGTERM (restart), 1 open slice(s)`);
				runner(laneExitBody(laneId, { code: null, signal: "SIGTERM", outcome: "stop", reason: "signal" }));
			} else {
				runner(laneExitBody(laneId, { code: 1, signal: null, outcome: how }));
				died(laneDiedExitBody(laneId, how, 1, null));
			}
			w.ledger.releaseWorkload(w.owner, { by: LANE_RUNNER_BY, holder: laneId });
		};
		/** The surface's incident on the owner (§ 1.5) through `recordIncidentOnce`, its detail naming the held PRs; `stillDue` defaults to the spent budget. */
		const incident = (deadLane: string, stillDue = () => relaunchState(w.ledger.launchRows(w.owner, 5)!).kind === "exhausted") =>
			recordIncidentOnce(w.ledger, {
				by: SURFACE_BY, kind: "relaunch", workloadId: w.owner, key: deadLane, count: RETRY_LIMIT, limit: RETRY_LIMIT,
				detail: `lane-died: ${deadLane}: error (exit 1); ${trainHeldDetail(heldTrainPrs(w.ledger, w.owner))}`,
			}, stillDue);
		const joWord = () => w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.owner, kind: "assumption", body: launchRequestedBody("jo", w.ledger.now()) });
		return { reserve, die, incident, joWord };
	};
	const messageBody = (l: Ledger, id: string) => l.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE id = ?").get(id)!.body;

	test.each(["error", "open-work", "signal"] as const)("an owner lane exit that is a death (%s) settles nothing; the relaunched lane gets the same task as the same attempt", (how) => {
		const c = clock();
		const w = world({ now: c.now });
		const { reserve, die } = lanes(w);
		const first = reserve();
		w.ledger.addSlice({ by: first.laneId, workloadId: w.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.01);
		const t = w.task(101, H0);
		c.plusHours(0.1);
		die(first.laneId, how);
		expect(w.settle({ 101: H0 })).toEqual([]);
		expect(ownerDeliveries(w.ledger)).toEqual([{ kind: "launch", task: expect.objectContaining({ id: t.id, attempt: 1 }), owner: w.owner }]);
		const next = reserve();
		expect(next.cause).toBe(`relaunch ${first.laneId} 1`);
		expect(ownerTasks(w.ledger, w.owner)).toEqual([expect.objectContaining({ id: t.id, attempt: 1, pr: 101 })]);
		c.plusHours(0.5);
		expect(w.settle({ 101: H0 })).toEqual([]);
		expect(nextAttempt(w.ledger, w.train, 101)).toBe(1);
	});

	test("an intended exit still settles failed: the relaunched lane's release with no push, and a death after Jo's stop of the lane", () => {
		const c = clock();
		const w = world({ now: c.now });
		const { reserve, die } = lanes(w);
		const first = reserve();
		w.ledger.addSlice({ by: first.laneId, workloadId: w.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.01);
		const t = w.task(101, H0);
		c.plusHours(0.1);
		die(first.laneId);
		expect(w.settle({ 101: H0 })).toEqual([]);
		const next = reserve();
		c.plusHours(0.1);
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.owner, kind: "assumption", body: laneExitBody(next.laneId, { code: 0, signal: null, outcome: "released" }) });
		w.ledger.releaseWorkload(w.owner, { by: LANE_RUNNER_BY, holder: next.laneId });
		expect(w.settle({ 101: H0 })).toEqual([expect.stringContaining(`${t.id} failed lane ${next.laneId} on ${w.owner} exited (code 0 signal - outcome released)`)]);

		// Jo stopped the lane: its error exit is no death the relaunch takes on (§ 1.1 step 2), so it is the attempt's end
		const c2 = clock();
		const v = world({ now: c2.now });
		const vl = lanes(v);
		const lane = vl.reserve();
		v.ledger.addSlice({ by: lane.laneId, workloadId: v.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c2.plusHours(0.01);
		const u = v.task(101, H0);
		c2.plusHours(0.1);
		v.ledger.recordEntry({ by: SURFACE_BY, workloadId: v.owner, kind: "assumption", body: laneStopRequestBody(lane.laneId, "as2-lane-stop", "jo") });
		vl.die(lane.laneId);
		expect(v.settle({ 101: H0 })).toEqual([expect.stringContaining(`${u.id} failed lane ${lane.laneId}`)]);
	});

	test("a live relaunched owner's 2 h with no push still settles failed, and two of them still raise the failed-twice question", () => {
		const c = clock();
		const w = world({ now: c.now });
		const { reserve, die } = lanes(w);
		const first = reserve();
		w.ledger.addSlice({ by: first.laneId, workloadId: w.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.01);
		const t1 = w.task(101, H0);
		c.plusHours(0.1);
		die(first.laneId);
		// the relaunched lane stays live through both tasks
		reserve(6 * 3_600_000);
		c.plusHours(1.5);
		expect(w.settle({ 101: H0 })).toEqual([]);
		c.plusHours(0.5);
		expect(w.settle({ 101: H0 })).toEqual([`train-task-settled: ${t1.id} failed no push for 2 h since ${t1.createdAt}`]);
		expect(twiceFailed(w.ledger, w.train)).toEqual([]);
		c.plusHours(0.01);
		const t2 = w.task(101, H0);
		expect(t2.attempt).toBe(2);
		c.plusHours(2);
		expect(w.settle({ 101: H0 })).toEqual([`train-task-settled: ${t2.id} failed no push for 2 h since ${t2.createdAt}`]);
		const due = twiceFailed(w.ledger, w.train);
		expect(due.map((d) => d.task.id)).toEqual([t2.id]);
		const q = raiseTwiceFailed(w.ledger, w.train, due[0]!);
		expect(q).not.toBeNull();
		expect(w.ledger.questions(w.train)).toEqual([expect.objectContaining({ id: q, slice_id: trainSliceId(w.train, 101), options: JSON.stringify(["retry", "skip", "stop"]) })]);
	});

	test("while the owner's incident holds #101, a second PR of the same owner with red runs still settles failed and raises the failed-twice question", () => {
		const c = clock();
		const w = world({ now: c.now });
		const { reserve, die, incident } = lanes(w);
		const first = reserve();
		const sl = w.ledger.addSlice({ by: first.laneId, workloadId: w.owner, task: "fix #101 and #106", doneCondition: "green", inputs: "#101 #106" });
		c.plusHours(0.01);
		const a = w.task(101, H0);
		const b = w.task(106, H0);
		expect(b.owner).toBe(w.owner);
		c.plusHours(0.1);
		die(first.laneId);
		c.plusHours(0.01);
		const inc = incident(first.laneId, () => true);
		expect(inc).not.toBeNull();
		expect(heldTrainPrs(w.ledger, w.owner)).toEqual([101, 106]);
		expect(messageBody(w.ledger, inc!)).toEndWith("; train #101 held, train #106 held");
		c.plusHours(0.1);
		const red1 = w.run(w.owner, sl, 106, H1, "red");
		expect(w.settle({ 101: H0, 106: H1 })).toEqual([`train-task-settled: ${b.id} failed run ${red1} red at ${H1}`]);
		c.plusHours(0.01);
		const b2 = w.task(106, H1);
		expect(b2.attempt).toBe(2);
		c.plusHours(0.1);
		const red2 = w.run(w.owner, sl, 106, H2, "red");
		c.plusHours(3);
		expect(w.settle({ 101: H0, 106: H2 })).toEqual([`train-task-settled: ${b2.id} failed run ${red2} red at ${H2}`]);
		const due = twiceFailed(w.ledger, w.train);
		expect(due.map((d) => d.pr)).toEqual([106]);
		expect(raiseTwiceFailed(w.ledger, w.train, due[0]!)).not.toBeNull();
		// #101 is held, not failed, 3 h on
		expect(unsettledTasks(w.ledger, w.train).map((t) => t.id)).toEqual([a.id]);
	});

	test("an incident on the owner stops the no-push rule until Jo's word launch; then 2 h after that launch with no push settles failed", () => {
		const c = clock();
		const w = world({ now: c.now });
		const { reserve, die, incident, joWord } = lanes(w);
		const first = reserve();
		w.ledger.addSlice({ by: first.laneId, workloadId: w.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.01);
		const t = w.task(101, H0);
		c.plusHours(0.1);
		die(first.laneId);
		c.plusHours(0.01);
		expect(incident(first.laneId, () => true)).not.toBeNull();
		c.plusHours(5);
		expect(w.settle({ 101: H0 })).toEqual([]);
		expect(twiceFailed(w.ledger, w.train)).toEqual([]);
		const word = joWord();
		const wordAt = c.now();
		expect(reserve().cause).toBe(`request ${word}`);
		expect(ownerTasks(w.ledger, w.owner)).toEqual([expect.objectContaining({ id: t.id, attempt: 1 })]);
		c.plusHours(1.5);
		expect(w.settle({ 101: H0 })).toEqual([]);
		c.plusHours(0.5);
		expect(w.settle({ 101: H0 })).toEqual([`train-task-settled: ${t.id} failed no push for 2 h since ${wordAt}`]);

		// only the surface's incident holds: a lane's note shaped like one does not
		const c2 = clock();
		const v = world({ now: c2.now });
		const u = v.task(101, H0);
		c2.plusHours(0.1);
		v.ledger.enqueue({ by: OWNER_LANE, workloadId: v.owner, sender: OWNER_LANE, recipient: ORCHESTRATOR_RECIPIENT, body: `incident: relaunch ${v.owner} key ${OWNER_LANE} after 3/3 retries without progress: x` });
		c2.plusHours(2);
		expect(v.settle({ 101: H0 })).toEqual([`train-task-settled: ${u.id} failed no push for 2 h since ${u.createdAt}`]);
	});

	test("r1 m6: an incident written before the task holds it too, until Jo's word; one Jo's word ended before the task holds nothing", () => {
		const c = clock();
		const w = world({ now: c.now });
		const { reserve, die, incident, joWord } = lanes(w);
		const first = reserve();
		w.ledger.addSlice({ by: first.laneId, workloadId: w.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.1);
		die(first.laneId);
		c.plusHours(0.01);
		expect(incident(first.laneId, () => true)).not.toBeNull();
		c.plusHours(0.1);
		// the train hands the already-exhausted owner a task
		const t = w.task(101, H0);
		c.plusHours(5);
		expect(w.settle({ 101: H0 })).toEqual([]);
		expect(twiceFailed(w.ledger, w.train)).toEqual([]);
		const word = joWord();
		const wordAt = c.now();
		expect(reserve().cause).toBe(`request ${word}`);
		c.plusHours(2);
		expect(w.settle({ 101: H0 })).toEqual([`train-task-settled: ${t.id} failed no push for 2 h since ${wordAt}`]);

		const c2 = clock();
		const v = world({ now: c2.now });
		const vl = lanes(v);
		const lane = vl.reserve();
		v.ledger.addSlice({ by: lane.laneId, workloadId: v.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c2.plusHours(0.1);
		vl.die(lane.laneId);
		c2.plusHours(0.01);
		expect(vl.incident(lane.laneId, () => true)).not.toBeNull();
		c2.plusHours(0.1);
		vl.joWord();
		c2.plusHours(0.1);
		const u = v.task(101, H0);
		c2.plusHours(2);
		expect(v.settle({ 101: H0 })).toEqual([`train-task-settled: ${u.id} failed no push for 2 h since ${u.createdAt}`]);
	});

	test("the full sequence: the original owner lane and three relaunched lanes die, the incident is written, the tick's settle and alert run each poll; the task stays unsettled and owned with no failed-twice question, and Jo's word launch gives the owner the same task", () => {
		const c = clock();
		const w = world({ now: c.now });
		const { reserve, die, incident, joWord } = lanes(w);
		const verdict = () => verdictOf(w.ledger.launchRows(w.owner, 5)!);
		const settled: string[] = [];
		const incidents: string[] = [];
		/** One poll: the train tick's settles and failed-twice alerts (train-tick.ts step 2), then the surface's incident step (§ 1.5). */
		const poll = () => {
			settled.push(...w.settle({ 101: H0 }));
			for (const due of twiceFailed(w.ledger, w.train)) raiseTwiceFailed(w.ledger, w.train, due);
			const s = relaunchState(w.ledger.launchRows(w.owner, 5)!);
			const id = s.kind === "exhausted" ? incident(s.lane) : null;
			if (id) incidents.push(id);
		};
		const first = reserve();
		expect(first.cause).toBe("first");
		w.ledger.addSlice({ by: first.laneId, workloadId: w.owner, task: "fix #101", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.01);
		const t = w.task(101, H0);
		let lane = first.laneId;
		for (let n = 1; n <= RETRY_LIMIT; n++) {
			c.plusHours(2 * MIN_H);
			die(lane);
			poll();
			// relaunch 1 at once, 2 and 3 after the backoff; the tick polls every minute meanwhile
			for (let i = 0; i < 15 && !verdict().launch; i++) {
				c.plusHours(MIN_H);
				poll();
			}
			const r = reserve();
			expect(r.cause).toBe(`relaunch ${lane} ${n}`);
			lane = r.laneId;
			poll();
		}
		c.plusHours(2 * MIN_H);
		die(lane);
		poll();
		expect(verdict()).toEqual({ launch: false, reason: "relaunch-exhausted" });
		expect(incidents).toHaveLength(1);
		expect(messageBody(w.ledger, incidents[0]!)).toStartWith(`incident: relaunch ${w.owner} key ${lane} after 3/3 retries without progress: `);
		expect(messageBody(w.ledger, incidents[0]!)).toEndWith("train #101 held");
		// six hours of polls, the train's own owner delivery re-requesting a launch the predicate refuses
		for (let i = 0; i < 36; i++) {
			c.plusHours(10 * MIN_H);
			if (i === 0) w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.owner, kind: "assumption", body: launchRequestedBody("merge-train", c.now(), `train task ${t.id} on #101`) });
			poll();
		}
		expect(verdict()).toEqual({ launch: false, reason: "relaunch-exhausted" });
		expect(settled).toEqual([]);
		expect(incidents).toHaveLength(1);
		expect(w.ledger.questions(w.train)).toEqual([]);
		expect(unsettledTasks(w.ledger, w.train).map((x) => x.id)).toEqual([t.id]);
		expect(ownerTasks(w.ledger, w.owner).map((x) => x.id)).toEqual([t.id]);
		// Jo's word: the owner relaunches and gets the same task, the same attempt
		const word = joWord();
		expect(ownerDeliveries(w.ledger)).toEqual([{ kind: "launch", task: expect.objectContaining({ id: t.id }), owner: w.owner }]);
		expect(reserve().cause).toBe(`request ${word}`);
		expect(ownerTasks(w.ledger, w.owner)).toEqual([expect.objectContaining({ id: t.id, attempt: 1, pr: 101 })]);
		poll();
		expect(settled).toEqual([]);
		expect(w.ledger.questions(w.train)).toEqual([]);
	});
});
