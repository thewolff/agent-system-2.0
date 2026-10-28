// The merge train's return path (PLAN wl-mv8s8srodefytc rev 17.1 D6-D9, part 2): `recordTrainTask` writes a PR's task on the
// train, `settleTasks` gives each task one outcome bound to a fresh runner result, attempts count failed settles since Jo's
// `retry`, `openTrainFix` opens one fix workload per (repo, PR), the owner hears of its task in its first prompt and as one aside
// (`pushTrainTasks`), the train word keeps a PR on one open train, and `trainRouted` keeps a task's generic failures off needs-you.
// A green carries to a head past it only by decision-log commits (`ghCompare`, `carryPairs`, PLAN wl-mvpwkpqobyp20w D1-D2).
// Temp ledgers, temp git checkouts with a fake GitHub origin, and the fake pi only.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY, type WorkloadRow } from "../../ledger/src/index";
import * as laneScript from "../scripts/lane";
import orchestratorSurface from "../index";
import { recordRepo, repoOf } from "../src/decision-log";
import { errorLines, trainRouted } from "../src/errors";
import { applyTrain, interpret } from "../src/input";
import { controlEntries, firstPrompt, laneExitBody, launchRowsFor, trainFixBody, verdictOf } from "../src/launch";
import {
	carryPairs, COMMIT_FILES_CAP, fixBindings, forkOf, forkTaskAlert, ghCompare, nextAttempt, openTrainFix, ownerDeliveries, ownerTasks, recordTrainTask, settleTasks, type TaskView,
	TRAIN_TASK_KINDS, type TrainPush, type TrainTask, trainPushesOf,
	trainSliceId, trainTaskWindows, twiceFailed, unsettledTasks,
} from "../src/merge-train";
import type { RankConfig } from "../src/rank-launch";
import { type CompareResult, makeRunId, pushDestBody, testRequestedBody, type TestRun, testRunBody, testRunFailedBody, testRuns } from "../src/test-run";
import { INSTRUCTION_POLL_MS, LANE_TOOLS, LANE_TRAIN_RETURN_TOOL, MERGE_TRAIN_BY, SURFACE_BY, TRAIN_TASK_FAILED_PREFIX } from "../src/types";
import { clock, ctxOf, fakePi, laneIdOf, tempLedger, timers, tmp } from "./helpers";
import { carry305 } from "./train-world";

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
	 * every PR in `heads` (its listing read and empty). A PR missing from both has no push evidence this pass. `compares` is the
	 * tick's `ghCompare` results by `<S> <head>` (none by default).
	 */
	const settle = (heads: Record<number, string>, now = ledger.now(), pushes: Record<number, TrainPush[]> = {}, compares: ReadonlyMap<string, CompareResult | null> = new Map()) => {
		const evidence = new Map<number, TrainPush[]>(Object.keys(heads).map((k) => [Number(k), []]));
		for (const [k, v] of Object.entries(pushes)) evidence.set(Number(k), v);
		const lines = settleTasks(ledger, { train, heads: new Map(Object.entries(heads).map(([k, v]) => [Number(k), v])), pushes: evidence, compares }, now);
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

/**
 * gh's JSON as `ghCompare` reads it: `answers` by `gh api` path; every call is recorded, and a path with no answer throws as a
 * failed gh call does.
 */
function ghAnswers(answers: Record<string, unknown>) {
	const calls: string[][] = [];
	const read = (args: string[]): unknown => {
		calls.push(args);
		if (!Object.hasOwn(answers, args[1]!)) throw new Error(`gh api ${args[1]} exited 1: Not Found (HTTP 404)`);
		return answers[args[1]!];
	};
	return { read, calls };
}
/** GitHub's compare answering `ahead` by `commits`, each with its parent count (1 unless given). */
const aheadAnswer = (...commits: { sha: string; parents?: number }[]) => ({
	status: "ahead", total_commits: commits.length, commits: commits.map((k) => ({ sha: k.sha, parents: Array.from({ length: k.parents ?? 1 }, () => ({ sha: H0 })) })),
});
/** GitHub's get-a-commit with `--paginate --slurp`: one page holding `files` (a path is a modified file). */
const commitAnswer = (sha: string, files: (string | { filename: string; status: string; previous_filename?: string })[]) => [
	{ sha, files: files.map((f) => (typeof f === "string" ? { filename: f, status: "modified" } : f)) },
];
const LOG = ".ai/decision-log/2026-10-26--1530--ilex--note.md";
/** The #305 shape (PLAN wl-mvpwkpqobyp20w § 1): green at aebe37a4, one decision-log commit cde03460, GitHub's answers as saved. */
const { green: S305, head: H305, answers: answers305 } = carry305(REPO);
/** `ghCompare(REPO, from, to)` over `answers`, as the tick keys it for `settleTasks`; a compare GitHub cannot answer completely is absent. */
function comparesOf(from: string, to: string, answers: Record<string, unknown>): Map<string, CompareResult | null> {
	const c = ghCompare(REPO, from, to, ghAnswers(answers).read);
	return new Map<string, CompareResult | null>(c.ok ? [[`${from} ${to}`, c.compare]] : []);
}

describe("a green carries over decision-log commits (PLAN wl-mvpwkpqobyp20w D1, D2)", () => {
	/** A task at H0 on #101, then the owner's green at `s` and a moment later. */
	const greenThenMoved = (s: string) => {
		const c = clock();
		const w = world({ now: c.now });
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const t = w.task(101, H0);
		c.plusHours(0.1);
		const runId = w.run(w.owner, sl, 101, s, "green");
		c.plusHours(0.05);
		return { c, w, t, runId };
	};

	test("R1: a green at S and one decision-log-only commit to H settles the task fixed with no new run", () => {
		const { w, t, runId } = greenThenMoved(H1);
		expect(carryPairs(w.ledger, { train: w.train, heads: new Map([[101, H2]]) })).toEqual([{ pr: 101, from: H1, to: H2 }]);
		const compares = comparesOf(H1, H2, { [`repos/${REPO}/compare/${H1}...${H2}`]: aheadAnswer({ sha: H2 }), [`repos/${REPO}/commits/${H2}`]: commitAnswer(H2, [LOG]) });
		expect(w.settle({ 101: H2 }, w.ledger.now(), {}, compares)).toEqual([`train-task-settled: ${t.id} fixed run ${runId} green at ${H1}, head ${H2} decision-log only`]);
		expect(testRuns(w.ledger.entries(w.owner)).map((r) => r.request.sha)).toEqual([H1]);
	});

	test("R4: a commit touching another path, or a merge commit touching only .ai/decision-log/, does not settle", () => {
		const { w } = greenThenMoved(H1);
		const code = comparesOf(H1, H2, { [`repos/${REPO}/compare/${H1}...${H2}`]: aheadAnswer({ sha: H2 }), [`repos/${REPO}/commits/${H2}`]: commitAnswer(H2, [LOG, "surface/src/x.ts"]) });
		expect(w.settle({ 101: H2 }, w.ledger.now(), {}, code)).toEqual([]);
		const merge = comparesOf(H1, H2, { [`repos/${REPO}/compare/${H1}...${H2}`]: aheadAnswer({ sha: H2, parents: 2 }), [`repos/${REPO}/commits/${H2}`]: commitAnswer(H2, [LOG]) });
		expect(merge.get(`${H1} ${H2}`)?.commits).toEqual([{ sha: H2, parents: 2, files: [] }]);
		expect(w.settle({ 101: H2 }, w.ledger.now(), {}, merge)).toEqual([]);
		expect(unsettledTasks(w.ledger, w.train)).toHaveLength(1);
	});

	test("R6: the #305 fixture (green aebe37a4, decision-log commit cde03460) carries in settle", () => {
		const { w, t, runId } = greenThenMoved(S305);
		expect(w.settle({ 101: H305 }, w.ledger.now(), {}, comparesOf(S305, H305, answers305))).toEqual([
			`train-task-settled: ${t.id} fixed run ${runId} green at ${S305}, head ${H305} decision-log only`,
		]);
	});

	test("a pair missing from compares, a green at H0, or a head still at H0 never carries", () => {
		const { c, w, t } = greenThenMoved(H1);
		// the tick's fetch failed or GitHub could not answer completely: no compare, no carry
		expect(w.settle({ 101: H2 })).toEqual([]);
		// the head back at H0 is no fix, whatever the compare says
		expect(carryPairs(w.ledger, { train: w.train, heads: new Map([[101, H0]]) })).toEqual([]);
		expect(w.settle({ 101: H0 }, w.ledger.now(), {}, new Map([[`${H1} ${H0}`, { status: "identical", commits: [] }]]))).toEqual([]);
		// a green at H0 itself is the head the train returned
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101 again", doneCondition: "green", inputs: "#101" });
		c.plusHours(0.05);
		w.run(w.owner, sl, 101, H0, "green");
		// the green at H0 is now the newest request, and an older green never carries past a newer request
		expect(carryPairs(w.ledger, { train: w.train, heads: new Map([[101, H2]]) })).toEqual([]);
		expect(unsettledTasks(w.ledger, w.train).map((u) => u.id)).toEqual([t.id]);
	});

	test("an older green at S never carries past a newer request: a red at H settles failed, a pending one settles nothing", () => {
		const { c, w, t } = greenThenMoved(H1);
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite #101 at the head", doneCondition: "green", inputs: "#101" });
		const compares = comparesOf(H1, H2, { [`repos/${REPO}/compare/${H1}...${H2}`]: aheadAnswer({ sha: H2 }), [`repos/${REPO}/commits/${H2}`]: commitAnswer(H2, [LOG]) });
		const heads = { train: w.train, heads: new Map([[101, H2]]) };
		// still pending at H: no settle, no pair
		c.plusHours(0.05);
		const pending = w.run(w.owner, sl, 101, H2, null);
		expect(carryPairs(w.ledger, heads)).toEqual([]);
		expect(w.settle({ 101: H2 }, w.ledger.now(), {}, compares)).toEqual([]);
		// red at H, both recorded before the first settle: failed on the red, never fixed
		c.plusHours(0.05);
		w.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: w.owner, sliceId: sl, kind: "assumption",
			body: testRunBody({
				runId: pending, verdict: "red", sha: H2, pr: 101, reason: null, headAtEnd: H2, base: null, mergeBase: null,
				full: { pass: 0, fail: 1, skip: 0, exit: 1, ms: 10, error: null }, solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
		expect(carryPairs(w.ledger, heads)).toEqual([]);
		expect(w.settle({ 101: H2 }, w.ledger.now(), {}, compares)).toEqual([`train-task-settled: ${t.id} failed run ${pending} red at ${H2}`]);
	});

	test("ghCompare: from === to is identical with no gh call; what GitHub cannot answer completely is ok:false; a failed or misshapen answer throws", () => {
		const none = ghAnswers({});
		expect(ghCompare(REPO, H1, H1, none.read)).toEqual({ ok: true, compare: { status: "identical", commits: [] } });
		expect(none.calls).toEqual([]);
		const path = `repos/${REPO}/compare/${H1}...${H2}`;
		const commit = `repos/${REPO}/commits/${H2}`;
		// more commits than the compare lists
		expect(ghCompare(REPO, H1, H2, ghAnswers({ [path]: { ...aheadAnswer({ sha: H2 }), total_commits: 251 } }).read)).toEqual({
			ok: false, reason: `${H2} is 251 commits ahead of ${H1}, more than the compare lists (1)`,
		});
		// a commit listing as many files as GitHub lists may have more
		const many = Array.from({ length: COMMIT_FILES_CAP }, (_, i) => `.ai/decision-log/n-${i}.md`);
		expect(ghCompare(REPO, H1, H2, ghAnswers({ [path]: aheadAnswer({ sha: H2 }), [commit]: commitAnswer(H2, many) }).read)).toEqual({
			ok: false, reason: `commit ${H2} lists ${COMMIT_FILES_CAP} files, the most GitHub lists; its other files cannot be read`,
		});
		// a rename naming no previous path
		expect(ghCompare(REPO, H1, H2, ghAnswers({ [path]: aheadAnswer({ sha: H2 }), [commit]: commitAnswer(H2, [{ filename: LOG, status: "renamed" }]) }).read)).toEqual({
			ok: false, reason: `commit ${H2} renames ${LOG} from no listed path`,
		});
		// a rename contributes the path it left; files come from every page
		const renamed = ghAnswers({ [path]: aheadAnswer({ sha: H2 }), [commit]: [...commitAnswer(H2, [LOG]), ...commitAnswer(H2, [{ filename: LOG, status: "renamed", previous_filename: "src/notes.md" }])] });
		expect(ghCompare(REPO, H1, H2, renamed.read)).toEqual({ ok: true, compare: { status: "ahead", commits: [{ sha: H2, parents: 1, files: [LOG, LOG, "src/notes.md"] }] } });
		expect(renamed.calls).toEqual([["api", path], ["api", commit, "--paginate", "--slurp"]]);
		// behind or diverged: no commit read
		expect(ghCompare(REPO, H1, H2, ghAnswers({ [path]: { status: "behind", total_commits: 0, commits: [] } }).read)).toEqual({ ok: true, compare: { status: "behind", commits: [] } });
		expect(() => ghCompare(REPO, H1, H2, none.read)).toThrow("exited 1");
		expect(() => ghCompare(REPO, H1, H2, ghAnswers({ [path]: { status: "sideways", total_commits: 0, commits: [] } }).read)).toThrow("unexpected shape");
		expect(() => ghCompare(REPO, H1, H2, ghAnswers({ [path]: { status: "ahead", total_commits: 1, commits: [{ sha: H2 }] } }).read)).toThrow("no sha or parents");
		expect(() => ghCompare(REPO, H1, H2, ghAnswers({ [path]: aheadAnswer({ sha: H2 }), [commit]: { sha: H2 } }).read)).toThrow("unexpected shape");
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

	test("the fix workload's first launch consumes the train's launch-requested:, so after its done-because: it awaits close and is not relaunched (wl-mvs26z1lkaw6oc)", () => {
		const w = world();
		const t = w.task(106, H0, "conflict", "feature/other");
		const fix = openTrainFix(w.ledger, { task: t, repo: REPO, checkout: w.trainCheckout, view: view(106, H0, "feature/other"), stakes: "production" }).workloadId;
		const request = controlEntries(w.ledger.entries(fix)).find((c) => c.prefix === "launch-requested")!.id;
		const show: RankConfig = { mode: "show", parallelBudgetUsd: 0 };
		const gone = (): laneScript.RunnerProbe => ({ omp: () => "gone", runner: () => "gone" });
		// the train tick's launch, through the starter's own reservation in the live rank mode (show)
		const lane1 = laneIdOf(fix, 1);
		expect(laneScript.reserve(w.ledger, fix, MERGE_TRAIN_BY, false, show, gone, new Set())).toEqual({ ok: true, laneId: lane1, cause: `request ${request}` });
		// the lane finds its task settled, writes its receipt and releases; its runner records the exit
		w.ledger.recordEntry({ by: lane1, workloadId: fix, kind: "assumption", body: `done-because: merge-train task ${t.id} on PR #106 is settled failed` });
		w.ledger.releaseWorkload(fix, { by: lane1, holder: lane1 });
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: fix, kind: "assumption", body: laneExitBody(lane1, { code: 0, signal: null, outcome: "completed" }) });
		// the tick's next pass: awaiting close, and the starter refuses a second lane
		expect(verdictOf(launchRowsFor(w.ledger, fix, 3)!)).toEqual({ launch: false, reason: "awaiting-close" });
		expect(laneScript.reserve(w.ledger, fix, "tick", false, show, gone, new Set())).toMatchObject({ ok: false, reason: "awaiting-close" });
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
