// The merge train's tick (PLAN wl-mv8s8srodefytc rev 17.1 D9-D10, part 3): settles once, opens one fix workload per PR,
// launches owners and the train, raises the failed-twice alert, files each alert once on jo-issues with the as2-train label,
// re-sends it louder at 4 h and 8 h until acknowledged, and keeps acting while a question is open. Auto-boarding (PLAN
// wl-mvbjiettjrfpxc D1, D3, D4, D6): the cutover, the live half of "a lane finished green", one skip row per head and reason,
// boarding oldest close first, and a protection episode that clears and wakes the trains it held. The relaunch loop (PLAN
// wl-mvgn310dpi5gcg D1, D3): a wake per request whichever starter serves it, and no request at the ceiling. A green carries over
// decision-log commits in settle and boarding through GitHub's compare (PLAN wl-mvpwkpqobyp20w D2, D3).
// Temp ledgers, temp git checkouts with a fake GitHub origin, a fake gh, a fake launcher and a fake notification only
// (surface/test/train-world.ts).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { type GhResult, tick } from "../scripts/train-tick";
import { type Ceiling, ceilingBody, type Spend, spendBody } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { apply, applyTrain, interpret } from "../src/input";
import {
	controlEntries, decideLaunch, laneExitBody, laneReadyBody, launchFailedBody, launchRequestedBody, landFirstBody, landFirstInstructionBody, mainRetryBody, mainRetryInstructionBody,
	planApprovedBody, planAutoApprovedBody, planHaltedBody, trainBoardBody,
} from "../src/launch";
import {
	actionable, type ControlRoot, fixBindings, openTrainFix, landFirstNoticeBody, landFirstRows, latestTrainReconciled, mainRedNotices, protectionEpisodes, recordTrainTask, TRAIN_ALERT_LABEL, TRAIN_ALERT_REPO, trainActivityArgs,
	trainAlertBody, trainAlertMarker, trainFullSliceId, trainHeadWokenBody, trainHoldBody, trainPrs, trainRetries, trainSliceId, type TrainTask, trainWakeBody, type WakeDeferral,
} from "../src/merge-train";
import { trainMergedNoticeBody } from "../src/notice";
import { fastPlanBody, makeRunId, testRequestedBody, type TestRun, testRunBody, testRuns, withFullSuitePublication } from "../src/test-run";
import { ESCALATION_BY, MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { releasedOpenBody } from "../src/turn-end";
import {
	boardWorld, carry305, checkout, COMMIT_FILES_CAP, COMMIT_FILES_PER_PAGE, DECISION_LOG_FILE, type FakeDiffEntry, type FakeIssue, H0, H1, H2, JO, OWNER_LANE, protectedRules, REPO, TRAIN_LANE,
	world,
} from "./train-world";
import { tmp } from "./helpers";

describe("settles and deliveries (D8, D10)", () => {
	test("a settle is written once across two ticks", () => {
		const w = world();
		const t = w.task(101);
		w.c.plusHours(0.05);
		w.push(101, H1, "green");
		w.run();
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${t.id} fixed `))]);
	});

	test("an unsettled task launches its autonomous owner once, with launch-requested: by merge-train; a live train is not woken", () => {
		const w = world();
		w.task(101);
		w.run();
		w.run();
		expect(w.launches).toEqual([w.owner]);
		expect(controlEntries(w.ledger.entries(w.owner)).filter((c) => c.prefix === "launch-requested").map((c) => c.createdBy)).toEqual([MERGE_TRAIN_BY]);
		expect(w.launches).not.toContain(w.train);
	});

	test("an actionable train no lane holds live is woken; never launched, it launches on its own cause `first`, with no request (PLAN wl-mvpsrr4tr0p1xc D2)", () => {
		const w = world();
		w.task(101);
		w.c.plusHours(0.05);
		w.push(101, H1, "green");
		w.c.plusHours(0.2); // the train lane's lease has lapsed
		w.run();
		expect(w.launches).toContain(w.train);
		expect(controlEntries(w.ledger.entries(w.train)).filter((c) => c.prefix === "launch").map((c) => c.rest)).toEqual([`cause first requested-by ${MERGE_TRAIN_BY}`]);
		expect(controlEntries(w.ledger.entries(w.train)).some((c) => c.prefix === "launch-requested")).toBe(false);
	});

	test("attempt 1 failed with the owner gone: exactly one fix workload, reused for attempt 2", () => {
		const w = world();
		w.task(101);
		w.ledger.closeWorkload(w.owner, { by: SURFACE_BY });
		w.run();
		w.c.plusHours(2.1); // no push for 2 h: attempt 1 settles failed
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringContaining("failed no push for 2 h")]);
		w.task(101);
		w.run();
		w.run();
		const fixes = fixBindings(w.ledger);
		expect(fixes.map((f) => f.pr)).toEqual([101]);
		expect(w.ledger.workload(fixes[0]!.workloadId)).toMatchObject({ status: "open", created_by: MERGE_TRAIN_BY });
		expect(w.launches).toContain(fixes[0]!.workloadId);
	});

	test("the 2 h rule reads GitHub's push activity on the head branch, and waits while that listing cannot be read (review gtb-r2 F2)", () => {
		const w = world();
		const t = w.task(101);
		const p = w.g.prs.get(101)!;
		// the owner pushes H1 at 1.5 h and has not asked for a run yet: no runner request dates the push, GitHub does
		w.c.plusHours(1.5);
		const pushedAt = w.c.now();
		p.head = H1;
		w.g.pushed(p.branch, H1, pushedAt);
		w.c.plusHours(0.6);
		w.run();
		expect(w.settles()).toEqual([]);
		expect(w.g.calls).toContainEqual(trainActivityArgs(REPO, p.branch));
		// past the push's own 2 h mark, while GitHub's activity cannot be read: no push rule settles, and the gh error is logged
		w.g.failWhen((a) => a[0] === "api" && a[1] === `repos/${REPO}/activity`);
		w.c.plusHours(1.5);
		w.run();
		expect(w.settles()).toEqual([]);
		expect(w.ledger.entries(w.train).some((e) => e.body.startsWith("train-error: tick") && e.body.includes("activity"))).toBe(true);
		w.g.failWhen(null);
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([`train-task-settled: ${t.id} failed no push for 2 h since ${pushedAt}`]);
	});
});

describe("ended full-suite slices: the tick cancels them as merge-train (#378's fix workload, #377 merged outside the train)", () => {
	let seq = 0;
	/** A runner request on `wl`'s slice `slice` for PR `pr` at `sha` stamped `now`, and its result `verdict`; null leaves the run waiting. */
	const runOn = (ledger: Ledger, now: string, wl: string, slice: string, pr: number, sha: string, verdict: TestRun["verdict"] | null) => {
		const runId = makeRunId(Date.parse(now) + ++seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice, by: "lane-x-1" }) });
		if (verdict === null) return;
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption",
			body: testRunBody({
				runId, verdict, sha, pr, reason: null, headAtEnd: sha, base: null, mergeBase: null,
				full: { pass: 1, fail: verdict === "red" ? 1 : 0, skip: 0, exit: verdict === "red" ? 1 : 0, ms: 10, error: null },
				solo: [], failures: verdict === "red" ? [{ part: "full", name: "src/x.test.ts > case 1", firstError: "boom" }] : [], runDir: null, preflight: null,
			}),
		});
	};

	test("a fix workload's red full-suite slice is cancelled once its task settles failed; a slice whose run still waits stays open", () => {
		const w = world();
		const t = w.task(106); // #106's head branch is no workload's: owner none, so the tick opens a fix workload
		w.run();
		const fix = fixBindings(w.ledger).find((f) => f.pr === 106)!.workloadId;
		w.c.plusHours(0.05);
		const red = w.ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: fix, id: `sl-full-${fix.slice(3)}-1`, task: "full suite outside the fence at PR #106", doneCondition: "green", inputs: `PR #106 at ${H0}` });
		const waiting = w.ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: fix, id: `sl-full-${fix.slice(3)}-2`, task: "full suite outside the fence at PR #106", doneCondition: "green", inputs: `PR #106 at ${H0}` });
		runOn(w.ledger, w.c.now(), fix, red, 106, H0, "red");
		runOn(w.ledger, w.c.now(), fix, waiting, 106, H0, null);
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringContaining(`train-task-settled: ${t.id} failed`)]);
		expect(w.ledger.slice(red)).toMatchObject({ state: "cancelled", changed_by: MERGE_TRAIN_BY });
		expect(w.ledger.slice(waiting)!.state).toBe("open");
	});

	test("the train's own red full-suite slice outlives a settled task (the next attempt runs on it) and is cancelled once the PR's disposition is done (merged outside the train)", () => {
		const w = world();
		const disposition = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 106), task: "PR #106", doneCondition: "terminal", inputs: "#106" });
		const full = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainFullSliceId(w.train, 106, 1), task: "suite #106", doneCondition: "green", inputs: "#106" });
		runOn(w.ledger, w.c.now(), w.train, full, 106, H0, "red");
		w.task(106);
		w.run();
		w.c.plusHours(2.1); // no push for 2 h: the task settles failed
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringContaining("failed no push for 2 h")]);
		expect(w.ledger.slice(full)!.state).toBe("open");
		w.ledger.completeSlice(disposition, { by: TRAIN_LANE, artifact: "skipped: MERGED (gh pr view 106 → MERGED)" });
		w.run();
		expect(w.ledger.slice(full)).toMatchObject({ state: "cancelled", changed_by: MERGE_TRAIN_BY });
	});

	test("a reused fix workload's red slice outlives a skipped PR's old train while the new train it rides has unsettled work; it is cancelled once that work settles (PR #391 review B1)", () => {
		const w = world();
		w.task(106); // owner none: the tick opens a fix workload bound to #106 on train A
		w.run();
		const fix = fixBindings(w.ledger).find((f) => f.pr === 106)!.workloadId;
		w.c.plusHours(0.05);
		// the fix workload's run on its full-suite slice comes back red: nothing waits on the slice
		const red = w.ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: fix, id: `sl-full-${fix.slice(3)}-1`, task: "full suite outside the fence at PR #106", doneCondition: "green", inputs: `PR #106 at ${H0}` });
		runOn(w.ledger, w.c.now(), fix, red, 106, H0, "red");
		w.c.plusHours(0.05);
		// Jo skips #106 on train A, which stays open on #101; a new train B carries #106, and its task is the fix workload's too
		const disposition = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 106), task: "PR #106", doneCondition: "terminal", inputs: "#106" });
		const q = w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: disposition, body: "#106 production", options: ["merged", "skip", "stop"] });
		w.ledger.answerQuestion(q, { ...JO, answer: "skip" });
		const cmd = interpret(w.ledger, "train 106");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const trainBCheckout = checkout();
		const trainB = applyTrain(w.ledger, cmd, trainBCheckout).workloadId;
		expect(w.ledger.claimWorkload(trainB, { by: LANE_STARTER_BY, holder: "lane-train-2", leaseMs: 600_000 }).won).toBe(true);
		const p = w.g.prs.get(106)!;
		const view = { number: 106, headRefName: p.branch, headRefOid: p.head, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" } };
		const onB = recordTrainTask(w.ledger, { train: trainB, by: "lane-train-2", pr: 106, kind: "red", detail: `run tr-y red at ${p.head}\nsrc/x.test.ts > case 1: boom`, view, trainRepo: REPO });
		if (!onB.ok) throw new Error(onB.reason);
		expect(openTrainFix(w.ledger, { task: onB.task, repo: REPO, checkout: trainBCheckout, view, stakes: "normal" })).toEqual({ workloadId: fix, opened: false });
		// train A disposes of #106 (its skip cancels the disposition); B's task on the reused workload is unsettled
		w.ledger.cancelSlice(disposition, { by: TRAIN_LANE });
		w.run();
		expect(w.ledger.slice(red)!.state).toBe("open");
		w.c.plusHours(2.1); // no push for 2 h: B's task settles failed, and the fix workload's train work has ended on every train
		w.run();
		expect(w.ledger.entries(trainB).some((e) => e.body.startsWith(`train-task-settled: ${onB.task.id} failed`))).toBe(true);
		expect(w.ledger.slice(red)).toMatchObject({ state: "cancelled", changed_by: MERGE_TRAIN_BY });
	});
});

describe("a green carries over decision-log commits in settle (PLAN wl-mvpwkpqobyp20w D2)", () => {
	/** A task on #101 at H0, the owner's push of `s` green, then a commit pushed on it to `head` (GitHub records both). */
	const greenThenCommit = (s: string, head: string) => {
		const w = world();
		const t = w.task(101);
		w.c.plusHours(0.05);
		w.push(101, s, "green");
		w.c.plusHours(0.05);
		const p = w.g.prs.get(101)!;
		p.head = head;
		w.g.pushed(p.branch, head, w.c.now());
		// every ledger transaction of the pass, and whether a compare was read inside it
		const write = w.ledger.write.bind(w.ledger);
		const inside: string[][] = [];
		w.ledger.write = <T>(fn: () => T): T => {
			const before = w.g.calls.length;
			const r = write(fn);
			inside.push(...w.g.calls.slice(before));
			return r;
		};
		return { w, t, inside };
	};
	const compares = (calls: string[][]) => calls.filter((a) => a[0] === "api" && a[1]!.includes("/compare/"));

	test("R1, R7: a green at S and one decision-log-only commit to H settles fixed with no new run; the compare is read outside the settle transaction", () => {
		const { w, t, inside } = greenThenCommit(H1, H2);
		w.g.compares.set(`${H1}...${H2}`, { status: "ahead", commits: [H2] });
		w.g.commitFiles.set(H2, [DECISION_LOG_FILE]);
		w.run();
		const run = testRuns(w.ledger.entries(w.owner));
		expect(w.settles().map((e) => e.body)).toEqual([`train-task-settled: ${t.id} fixed run ${run[0]!.request.runId} green at ${H1}, head ${H2} decision-log only`]);
		expect(run.map((r) => r.request.sha)).toEqual([H1]);
		expect(compares(w.g.calls)).toEqual([["api", `repos/${REPO}/compare/${H1}...${H2}`]]);
		expect(compares(inside)).toEqual([]);
	});

	test("R4: a commit touching another path, or a merge commit touching only .ai/decision-log/, does not settle", () => {
		const { w: code } = greenThenCommit(H1, H2);
		code.g.compares.set(`${H1}...${H2}`, { status: "ahead", commits: [H2] });
		code.g.commitFiles.set(H2, [DECISION_LOG_FILE, "src/x.ts"]);
		code.run();
		expect(code.settles()).toEqual([]);
		const { w: merge } = greenThenCommit(H1, H2);
		merge.g.compares.set(`${H1}...${H2}`, { status: "ahead", commits: [{ sha: H2, parents: 2 }] });
		merge.g.commitFiles.set(H2, [DECISION_LOG_FILE]);
		merge.run();
		expect(merge.settles()).toEqual([]);
		// a merge's files are never read
		expect(merge.g.calls.some((a) => a[1] === `repos/${REPO}/commits/${H2}`)).toBe(false);
	});

	test("R6: the #305 fixture (green aebe37a4, decision-log commit cde03460) settles fixed; a compare gh cannot read settles nothing and is logged", () => {
		const f = carry305();
		const { w, t } = greenThenCommit(f.green, f.head);
		for (const [path, answer] of Object.entries(f.answers)) w.g.saved.set(path, answer);
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${t.id} fixed run \\S+ green at ${f.green}, head ${f.head} decision-log only$`))]);
		const { w: v } = greenThenCommit(f.green, f.head);
		v.run();
		expect(v.settles()).toEqual([]);
		expect(v.ledger.entries(v.train).filter((e) => e.body.startsWith("train-error: tick ")).map((e) => e.body)).toEqual([expect.stringContaining("exited 1")]);
	});
});

describe("alerts (D9)", () => {
	test("attempt 2 failed: one retry / skip / stop question and one issue labelled as2-train; a second tick files no duplicate", () => {
		const w = world();
		w.failTwice();
		const qs = w.ledger.questions(w.train);
		expect(qs).toHaveLength(1);
		expect(qs[0]).toMatchObject({ slice_id: trainSliceId(w.train, 101), state: "open", created_by: MERGE_TRAIN_BY });
		expect(JSON.parse(qs[0]!.options)).toEqual(["retry", "skip", "stop"]);
		expect(w.creates()).toHaveLength(1);
		expect(w.creates()[0]).toEqual(expect.arrayContaining(["-R", TRAIN_ALERT_REPO, "--label", TRAIN_ALERT_LABEL]));
		expect(w.g.issues[0]!.title).toBe("merge train: #101 needs you (failed twice)");
		expect(w.g.issues[0]!.body).toContain(qs[0]!.id);
		w.run();
		w.c.plusHours(1);
		w.run();
		expect(w.creates()).toHaveLength(1);
		expect(w.ledger.questions(w.train)).toHaveLength(1);
	});

	test("not acknowledged: one louder re-send at 4 h, the next at 8 h, nothing after; as2-train is never removed", () => {
		const w = world();
		w.failTwice();
		const q = w.ledger.questions(w.train)[0]!.id;
		const issue = w.g.issues[0]!;
		w.c.plusHours(3.9);
		w.run();
		expect(issue.comments).toEqual([]);
		w.c.plusHours(0.2);
		w.run();
		w.run();
		expect(issue.comments).toHaveLength(1);
		expect(issue.comments[0]).toContain("@thewolff");
		expect(issue.comments[0]).toContain("unacknowledged 4 h");
		expect(issue.labels).toEqual([TRAIN_ALERT_LABEL, "loud"]);
		expect(w.notes).toHaveLength(1);
		const line = errorLines(w.ledger).find((l) => l.rowId === q);
		expect(line?.line).toStartWith("LOUD (unacknowledged 4 h)");
		w.c.plusHours(4);
		w.run();
		w.run();
		expect(issue.comments).toHaveLength(2);
		expect(issue.labels).toEqual([TRAIN_ALERT_LABEL, "loud", "critical"]);
		expect(w.notes).toHaveLength(2);
		expect(errorLines(w.ledger).find((l) => l.rowId === q)?.line).toStartWith("LOUD, critical (unacknowledged 8 h)");
		w.c.plusHours(24);
		w.run();
		expect(issue.comments).toHaveLength(2);
		expect(w.notes).toHaveLength(2);
		expect(w.creates()).toHaveLength(1);
		expect(w.g.calls.some((a) => a.includes("--remove-label"))).toBe(false);
	});

	test("a crash between sending and sent: the retry posts no second comment and notifies once", () => {
		const w = world();
		w.failTwice();
		const issue = w.g.issues[0]!;
		w.c.plusHours(4.1);
		w.g.failWhen((a) => a[0] === "issue" && a[1] === "edit");
		w.run();
		expect(issue.comments).toHaveLength(1);
		expect(w.notes).toHaveLength(0);
		w.g.failWhen(null);
		w.run();
		w.run();
		expect(issue.comments).toHaveLength(1);
		expect(issue.labels).toContain("loud");
		expect(w.notes).toHaveLength(1);
	});

	test("acknowledged by closing the issue: no re-send; Jo's answer closes an open issue", () => {
		const w = world();
		w.failTwice();
		const issue = w.g.issues[0]!;
		issue.state = "CLOSED";
		w.c.plusHours(4.1);
		w.run();
		w.c.plusHours(4);
		w.run();
		expect(issue.comments).toEqual([]);
		expect(w.notes).toEqual([]);
		expect(w.ledger.questions(w.train)[0]!.state).toBe("open");

		const v = world();
		v.failTwice();
		v.ledger.answerQuestion(v.ledger.questions(v.train)[0]!.id, { ...JO, answer: "skip" });
		v.run();
		expect(v.g.issues[0]!.state).toBe("CLOSED");
		v.c.plusHours(5);
		v.run();
		expect(v.g.issues[0]!.comments).toEqual([]);
		expect(v.g.calls.filter((a) => a[0] === "issue" && a[1] === "close")).toHaveLength(1);
	});

	test("a production-stakes PR's merge question is an alert", () => {
		const w = world();
		const sl = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 106), task: "PR #106", doneCondition: "terminal", inputs: "#106" });
		w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: sl, body: "#106 production: merge it?", options: ["merged", "skip", "stop"] });
		w.run();
		w.run();
		expect(w.creates()).toHaveLength(1);
		expect(w.creates()[0]).toEqual(expect.arrayContaining(["--label", TRAIN_ALERT_LABEL]));
		expect(w.g.issues[0]!.title).toBe("merge train: #106 needs you (production merge)");
	});

	test("an open question on the train does not stop the tick acting on other PRs", () => {
		const w = world();
		const sl = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 106), task: "PR #106", doneCondition: "terminal", inputs: "#106" });
		w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: sl, body: "#106 production: merge it?", options: ["merged", "skip", "stop"] });
		const t = w.task(101);
		w.run();
		expect(w.launches).toEqual([w.owner]);
		w.c.plusHours(0.05);
		w.push(101, H1, "red");
		w.c.plusHours(0.2);
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringContaining(`${t.id} failed`)]);
		expect(w.launches).toContain(w.train);
	});
});

describe("retries of a released train and fork PRs (D8-D10, review gtb-r1)", () => {
	/** What these helpers read of a world: its ledger, its train and the fake launcher's record. */
	interface World {
		ledger: Ledger;
		train: string;
		launches: string[];
	}
	/** The train's PR slices, added by `lane` as step 1 does, so no PR reads as not yet worked. */
	const worked = (w: World, lane: string) => {
		for (const n of [101, 106]) {
			const sl = trainSliceId(w.train, n);
			if (!w.ledger.slice(sl)) w.ledger.addSlice({ by: lane, workloadId: w.train, id: sl, task: `PR #${n}`, doneCondition: "terminal", inputs: `#${n}` });
		}
	};
	/** `lane` passes #101 over with `train-error: pr 101 <why>` (when given) and exits released. */
	const exit = (w: World, lane: string, why: string | null) => {
		worked(w, lane);
		if (why !== null) w.ledger.recordEntry({ by: lane, workloadId: w.train, kind: "assumption", body: `train-error: pr 101 ${why}` });
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(lane, { code: 0, signal: null, outcome: "released" }) });
	};
	const trainLaunches = (w: World) => w.launches.filter((l) => l === w.train).length;
	const holder = (w: World) => w.ledger.workload(w.train)!.holder!;

	test("a PR passed over with train-error: wakes the released train after 15 min, then after 30 min, never every tick", () => {
		const w = world();
		exit(w, TRAIN_LANE, "merge-refused HTTP 502");
		w.c.plusHours(0.2); // 12 min: the lease has lapsed, the retry wait has not
		w.run();
		expect(trainLaunches(w)).toBe(0);
		w.c.plusHours(0.1); // 18 min
		w.run();
		w.run();
		expect(trainLaunches(w)).toBe(1);
		// the retried pass is refused again: the next wait doubles
		exit(w, holder(w), "merge-refused HTTP 502 again");
		w.c.plusHours(0.4); // 24 min after that exit
		w.run();
		expect(trainLaunches(w)).toBe(1);
		w.c.plusHours(0.12); // 31 min
		w.run();
		expect(trainLaunches(w)).toBe(2);
	});

	test("a board of another PR between a pass-over and the lane's exit keeps the passed-over PR's retry (review wl-mvbjiettjrfpxc r1 #1)", () => {
		const w = world();
		worked(w, TRAIN_LANE);
		w.ledger.recordEntry({ by: TRAIN_LANE, workloadId: w.train, kind: "assumption", body: "train-error: pr 101 merge-refused HTTP 502" });
		// the tick boards #102 while the lane is on another member; the lane's final reread works #102, then it exits released
		w.g.prs.set(102, { head: H0, branch: "feature/boarded" });
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.train, kind: "assumption", body: trainBoardBody({ pr: 102, workload: w.owner, head: H0, run: null, review: null }) });
		const sl = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 102), task: "PR #102", doneCondition: "terminal", inputs: "#102" });
		w.ledger.completeSlice(sl, { by: TRAIN_LANE, artifact: "merged" });
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(TRAIN_LANE, { code: 0, signal: null, outcome: "released" }) });
		w.c.plusHours(0.3); // 18 min: #101's first retry wait has passed
		expect(trainRetries(w.ledger, w.train, new Map())).toEqual({ passedOver: [{ pr: 101, count: 1 }], untested: [] });
		w.run();
		expect(trainLaunches(w)).toBe(1);
	});

	/** #101's task settles fixed at H1 and the train consumes it; then the head moves to H2 and the tick wakes the train for it once. */
	const wokenForH2 = () => {
		const w = world();
		w.task(101);
		w.c.plusHours(0.05);
		w.push(101, H1, "green");
		w.c.plusHours(0.2);
		w.run();
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringContaining("fixed")]);
		expect(trainLaunches(w)).toBe(1);
		// the train's pass consumes the settle and ends without a run at a new head
		exit(w, holder(w), null);
		w.c.plusHours(0.1);
		w.run();
		expect(trainLaunches(w)).toBe(1);
		// the PR's head moves again: the train is woken for it
		w.g.prs.get(101)!.head = H2;
		w.run();
		expect(trainLaunches(w)).toBe(2);
		expect(wakes(w)).toBe(1);
		return w;
	};
	const wakes = (w: World) => w.ledger.entries(w.train).filter((e) => e.created_by === MERGE_TRAIN_BY && e.body === trainHeadWokenBody(101, H2)).length;

	test("a head woken for a lane that ends before working it is due again under the backoff, never every tick (review gtb-r2 F1)", () => {
		const w = wokenForH2();
		// the launched lane ends with no run at H2, no train-error: pr 101 and no task: the wake did not work the head
		exit(w, holder(w), null);
		w.c.plusHours(0.2); // 12 min
		w.run();
		w.run();
		expect(trainLaunches(w)).toBe(2);
		w.c.plusHours(0.1); // 18 min
		w.run();
		w.run();
		expect(trainLaunches(w)).toBe(3);
		expect(wakes(w)).toBe(2);
		// again with nothing done: the wait doubles to 30 min
		exit(w, holder(w), null);
		w.c.plusHours(0.4); // 24 min
		w.run();
		expect(trainLaunches(w)).toBe(3);
		w.c.plusHours(0.12); // 31 min
		w.run();
		expect(trainLaunches(w)).toBe(4);
		// a runner that never became ready writes launch-failed: and no lane-exit: the wait (now 1 h) runs from it
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: launchFailedBody(holder(w), "ready", "the lane never became ready") });
		w.c.plusHours(0.9);
		w.run();
		expect(trainLaunches(w)).toBe(4);
		w.c.plusHours(0.15);
		w.run();
		expect(trainLaunches(w)).toBe(5);
		expect(wakes(w)).toBe(4);
	});

	test("the train working the woken head ends its wakes: a train run at that head, or a pass-over whose own retry then applies", () => {
		const w = wokenForH2();
		const lane = holder(w);
		const full = w.ledger.addSlice({ by: lane, workloadId: w.train, id: `${trainSliceId(w.train, 101)}-full-2`, task: "#101 suite", doneCondition: "green", inputs: "#101" });
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: w.train, sliceId: full, kind: "assumption", body: testRequestedBody({ runId: makeRunId(Date.parse(w.c.now()), "trn1"), pr: 101, sha: H2, slice: full, by: lane }) });
		exit(w, lane, null);
		w.c.plusHours(5);
		w.run();
		expect(trainLaunches(w)).toBe(2);
		expect(trainRetries(w.ledger, w.train, new Map([[101, H2]]))).toEqual({ passedOver: [], untested: [] });

		const v = wokenForH2();
		exit(v, holder(v), "merge-refused HTTP 502");
		v.c.plusHours(0.3);
		expect(trainRetries(v.ledger, v.train, new Map([[101, H2]]))).toEqual({ passedOver: [{ pr: 101, count: 1 }], untested: [] });
		v.run();
		expect(trainLaunches(v)).toBe(3);
		expect(wakes(v)).toBe(1);
	});

	test("the live-owner shortcut keeps the PR pending: its train slices stay open, the tick reads it, and retries it once the owner's lease ends (D13)", () => {
		const w = world();
		// the train's own full-suite run on #101 is red, and the PR goes back to its owner, whose lane stays live
		worked(w, TRAIN_LANE);
		const full = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: `${trainSliceId(w.train, 101)}-full-1`, task: "#101 suite", doneCondition: "green", inputs: "#101" });
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: w.train, sliceId: full, kind: "assumption", body: testRequestedBody({ runId: makeRunId(Date.parse(w.c.now()), "trn0"), pr: 101, sha: H0, slice: full, by: TRAIN_LANE }) });
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 6 * 3_600_000 }).won).toBe(true);
		w.task(101);
		w.c.plusHours(0.05);
		w.push(101, H1, "green");
		w.c.plusHours(0.2);
		w.run();
		expect(trainLaunches(w)).toBe(1);
		// the train finds the owner live: it passes #101 over and exits, leaving both slices open
		exit(w, holder(w), `live lane ${OWNER_LANE}`);
		expect([trainSliceId(w.train, 101), full].map((s) => w.ledger.slice(s)!.state)).toEqual(["open", "open"]);
		const views = () => w.g.calls.filter((a) => a[0] === "pr" && a[1] === "view" && a[2] === "101").length;
		const before = views();
		w.c.plusHours(0.3);
		const lines = w.run();
		expect(views()).toBeGreaterThan(before);
		// D13: the retry is #101's own reason, and its owner holds a live lease: deferred, one line, no launch
		expect(lines.filter((l) => l.includes("#101 wake deferred while its owner is busy"))).toHaveLength(1);
		expect(trainLaunches(w)).toBe(1);
		// an owner lease held past its expiry is not busy: the deferred retry wakes the train
		w.c.plusHours(6);
		w.run();
		expect(trainLaunches(w)).toBe(2);
	});

	test("a fork's ownerless task opens no fix workload: the tick settles it failed and files Jo's alert", () => {
		const w = world();
		const t = w.task(106);
		const gh = (args: string[]): GhResult => {
			const r = w.g.gh(args);
			if (args[0] !== "pr" || args[1] !== "view" || args[2] !== "106") return r;
			return { ...r, stdout: JSON.stringify({ ...JSON.parse(r.stdout), isCrossRepository: true, headRepositoryOwner: { login: "someone" } }) };
		};
		const pass = () => tick({ ledger: w.ledger, gh, launch: (wl) => ({ code: 0, line: `launched ${wl}` }), notify: () => true });
		pass();
		pass();
		expect(fixBindings(w.ledger)).toEqual([]);
		expect(w.settles().map((e) => e.body)).toEqual([expect.stringMatching(new RegExp(`^train-task-settled: ${t.id} failed `))]);
		const qs = w.ledger.questions(w.train);
		expect(qs).toEqual([expect.objectContaining({ slice_id: trainSliceId(w.train, 106), state: "open", created_by: MERGE_TRAIN_BY })]);
		expect(JSON.parse(qs[0]!.options)).toEqual(["retry", "skip", "stop"]);
		expect(w.creates()).toHaveLength(1);
		expect(w.creates()[0]).toEqual(expect.arrayContaining(["--label", TRAIN_ALERT_LABEL]));
	});

	/** `lane` holds #101 at H0 until `until` (`train-hold:`, PLAN wl-mvfkv7llkp7nk0 § 3), leaves its slices open, and exits released. */
	const held = (w: World, lane: string, until: string): string => {
		worked(w, lane);
		const id = w.ledger.recordEntry({ by: lane, workloadId: w.train, kind: "assumption", body: trainHoldBody(101, H0, until) });
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(lane, { code: 0, signal: null, outcome: "released" }) });
		return id;
	};
	const holdWakes = (w: World, holdId: string) => w.ledger.entries(w.train).filter((e) => e.created_by === MERGE_TRAIN_BY && e.body === trainWakeBody(101, holdId)).length;

	test("a timed hold wakes the released train once its time passes, with one train-wake: that consumes it (PLAN wl-mvfkv7llkp7nk0 § 3, R10)", () => {
		const w = world();
		const holdId = held(w, TRAIN_LANE, "2026-10-01T12:00:00.000Z");
		w.c.plusHours(1.5);
		w.run();
		expect(trainLaunches(w)).toBe(0);
		expect(actionable(w.ledger, w.train)).toEqual([]);
		w.c.at("2026-10-01T12:00:00.000Z");
		expect(actionable(w.ledger, w.train)).toEqual([`#101 hold-expired (${holdId})`]);
		w.run();
		expect(trainLaunches(w)).toBe(1);
		expect(holdWakes(w, holdId)).toBe(1);
		expect(w.ledger.slice(trainSliceId(w.train, 101))!.state).toBe("open");
		// the woken lane dies before it records an outcome: the consumed hold does not wake the train again
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(holder(w), { code: 0, signal: null, outcome: "released" }) });
		w.c.plusHours(1);
		w.run();
		w.run();
		expect(trainLaunches(w)).toBe(1);
		expect(holdWakes(w, holdId)).toBe(1);
	});

	for (const pending of [false, true]) {
		test(`a capped hold-expiry request (${pending ? "pending before expiry" : "newly written"}) served by the drain consumes the expiry once, without a second launch`, () => {
			const w = world([101]);
			w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: `launch: ${TRAIN_LANE} cause first requested-by ${SURFACE_BY}` });
			w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneReadyBody(TRAIN_LANE, w.c.now()) });
			const holdId = held(w, TRAIN_LANE, "2026-10-01T12:00:00.000Z");
			const pendingId = pending ? w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.train, kind: "assumption", body: launchRequestedBody(MERGE_TRAIN_BY, w.c.now(), "prior wake") }) : null;
			w.c.at("2026-10-01T12:00:00.000Z");
			let calls = 0;
			const pass = () => tick({
				ledger: w.ledger, gh: w.g.gh, notify: () => true,
				launch: () => {
					calls += 1;
					return { code: 6, line: "lane-x not launched: cap" };
				},
			});
			const requests = () => controlEntries(w.ledger.entries(w.train)).filter((c) => c.prefix === "launch-requested" && c.createdBy === MERGE_TRAIN_BY);
			pass();
			expect(requests()).toHaveLength(1);
			if (pendingId !== null) expect(requests()[0]!.id).toBe(pendingId);
			expect(holdWakes(w, holdId)).toBe(1);
			expect(actionable(w.ledger, w.train)).toEqual([]);
			// Another starter consumes the request the tick could not serve.
			w.c.plusHours(0.01);
			const r = w.ledger.reserveLane(w.train, { by: LANE_STARTER_BY, cap: 10, leaseMs: 60_000, requestedBy: LANE_RUNNER_BY, decide: decideLaunch });
			expect(r).toMatchObject({ ok: true, cause: `request ${requests()[0]!.id}` });
			if (!r.ok) throw new Error(r.reason);
			w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneReadyBody(r.laneId, w.c.now()) });
			expect(w.ledger.releaseWorkload(w.train, { by: r.laneId, holder: r.laneId }).released).toBe(true);
			w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(r.laneId, { code: 0, signal: null, outcome: "released" }) });
			w.c.plusHours(1);
			pass();
			pass();
			expect(calls).toBe(1);
			expect(requests()).toHaveLength(1);
			expect(holdWakes(w, holdId)).toBe(1);
		});
	}

	test("an expired hold at the ceiling stays unconsumed until Jo raises the ceiling, then wakes once", () => {
		const w = world([101]);
		const holdId = held(w, TRAIN_LANE, "2026-10-01T12:00:00.000Z");
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.train, kind: "assumption", body: ceilingBody({ usd: 10, wallMin: 360 }, "lowered by the orchestrator") });
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: spendBody(TRAIN_LANE, { usd: 10, tokens: 1000, wallMin: 30 }) });
		w.c.at("2026-10-01T12:00:00.000Z");
		const requests = () => controlEntries(w.ledger.entries(w.train)).filter((c) => c.prefix === "launch-requested" && c.createdBy === MERGE_TRAIN_BY);
		const lines = w.run();
		w.run();
		expect(lines).toContainEqual(expect.stringContaining("not requested: stopped at its ceiling"));
		expect(requests()).toEqual([]);
		expect(trainLaunches(w)).toBe(0);
		expect(holdWakes(w, holdId)).toBe(0);
		expect(actionable(w.ledger, w.train)).toEqual([`#101 hold-expired (${holdId})`]);
		w.c.plusHours(0.01);
		const by = w.ledger.recordInstruction({ ...JO, workloadId: w.train, body: "ceiling: 20 6" });
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.train, kind: "assumption", body: ceilingBody({ usd: 20, wallMin: 360 }, "ceiling word by jo", by) });
		w.run();
		w.run();
		expect(trainLaunches(w)).toBe(1);
		// never launched: the train's own cause `first` starts it, so the tick writes no request (PLAN wl-mvpsrr4tr0p1xc D2)
		expect(requests()).toEqual([]);
		expect(holdWakes(w, holdId)).toBe(1);
	});

	test("an `until jo` hold wakes the train only when the PR's workload no longer holds it, here on Jo's approve after a halt", () => {
		const w = world();
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.owner, kind: "assumption", body: planHaltedBody("in-1") });
		const holdId = held(w, TRAIN_LANE, "jo");
		w.c.plusHours(10);
		w.run();
		w.run();
		expect(trainLaunches(w)).toBe(0);
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.owner, kind: "assumption", body: "plan: approved in-2" });
		w.run();
		expect(trainLaunches(w)).toBe(1);
		expect(holdWakes(w, holdId)).toBe(1);
	});
});

describe("alert sends with an uncertain outcome (D9, review gtb-r1 findings 9 and 10)", () => {
	/** The production merge question on #106 of `train`: an open alert the next tick files at level 1. */
	const mergeQuestion = (ledger: Ledger, train: string): string => {
		const sl = ledger.addSlice({ by: TRAIN_LANE, workloadId: train, id: trainSliceId(train, 106), task: "PR #106", doneCondition: "terminal", inputs: "#106" });
		return ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: train, sliceId: sl, body: "#106 production: merge it?", options: ["merged", "skip", "stop"] });
	};
	/** The tick's `train-alert:` entries for question `q` on `train`, oldest first. */
	const alertEntries = (ledger: Ledger, train: string, q: string): string[] =>
		ledger.entries(train).filter((e) => e.created_by === MERGE_TRAIN_BY && e.body.startsWith(`train-alert: ${q} `)).map((e) => e.body);
	/** A tick that wrote level 1 `sending` for `q` and died before `sent`. */
	const sendingOnly = (ledger: Ledger, train: string, q: string): void => {
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body: trainAlertBody(q, 1, "sending") });
	};

	test("a create that files the issue but exits nonzero: the marker is found again, the issue adopted, nothing filed twice", () => {
		const w = world();
		const q = mergeQuestion(w.ledger, w.train);
		const real = w.g.gh;
		let lost = 0;
		w.g.gh = (args) => {
			const r = real(args);
			if (args[0] === "issue" && args[1] === "create" && lost++ === 0) return { code: 1, stdout: "", stderr: "HTTP 502: the reply was lost" };
			return r;
		};
		w.run();
		w.run();
		expect(w.g.issues).toHaveLength(1);
		expect(w.creates()).toHaveLength(1);
		expect(alertEntries(w.ledger, w.train, q)).toEqual([`train-alert: ${q} level 1 sending`, `train-alert: ${q} level 1 sent ${w.g.issues[0]!.url}`]);
	});

	test("a create that fails for another reason is not retried: the error is logged and the next tick files the issue once", () => {
		const w = world();
		mergeQuestion(w.ledger, w.train);
		w.g.failWhen((a) => a[0] === "issue" && a[1] === "create");
		w.run();
		expect(w.creates()).toHaveLength(1);
		expect(w.g.calls.some((a) => a[0] === "label")).toBe(false);
		expect(w.ledger.entries(w.train).some((e) => e.body.startsWith("train-error: tick"))).toBe(true);
		w.g.failWhen(null);
		w.run();
		expect(w.g.issues).toHaveLength(1);
		expect(w.creates()).toHaveLength(2);
	});

	test("a missing as2-train label: the label is created and the issue filed once", () => {
		const w = world();
		const q = mergeQuestion(w.ledger, w.train);
		const real = w.g.gh;
		const labels = new Set<string>();
		w.g.gh = (args) => {
			if (args[0] === "label" && args[1] === "create") {
				labels.add(args[2]!);
				return { code: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "issue" && args[1] === "create" && !labels.has(TRAIN_ALERT_LABEL)) {
				w.g.calls.push(args);
				return { code: 1, stdout: "", stderr: `could not add label: '${TRAIN_ALERT_LABEL}' not found` };
			}
			return real(args);
		};
		w.run();
		expect([...labels]).toEqual([TRAIN_ALERT_LABEL]);
		expect(w.g.issues).toHaveLength(1);
		expect(w.creates()).toHaveLength(2);
		expect(alertEntries(w.ledger, w.train, q).at(-1)).toBe(`train-alert: ${q} level 1 sent ${w.g.issues[0]!.url}`);
	});

	test("answered after a crash between level 1 sending and sent: the marked issue is found and closed once, the end written", () => {
		const w = world();
		const q = mergeQuestion(w.ledger, w.train);
		sendingOnly(w.ledger, w.train, q);
		const url = `https://github.com/${TRAIN_ALERT_REPO}/issues/1`;
		w.g.issues.push({ number: 1, url, title: "merge train: #106 needs you (production merge)", body: `${trainAlertMarker(q, 1)}\n…`, state: "OPEN", labels: [TRAIN_ALERT_LABEL], comments: [] });
		w.ledger.answerQuestion(q, { ...JO, answer: "skip" });
		w.run();
		w.run();
		expect(w.g.issues[0]!.state).toBe("CLOSED");
		expect(w.g.calls.filter((a) => a[0] === "issue" && a[1] === "close")).toHaveLength(1);
		expect(w.creates()).toEqual([]);
		expect(alertEntries(w.ledger, w.train, q)).toEqual([`train-alert: ${q} level 1 sending`, expect.stringMatching(new RegExp(`^train-alert: ${q} closed `))]);
	});

	test("withdrawn after level 1 sending with no issue filed: the end is written and nothing is created", () => {
		const w = world();
		const q = mergeQuestion(w.ledger, w.train);
		sendingOnly(w.ledger, w.train, q);
		w.ledger.withdrawQuestion(q, { ...JO, reason: "not needed", then: "replan" });
		w.run();
		w.run();
		expect(w.g.issues).toEqual([]);
		expect(w.creates()).toEqual([]);
		expect(w.g.calls.some((a) => a[0] === "issue" && a[1] === "close")).toBe(false);
		expect(alertEntries(w.ledger, w.train, q)).toEqual([`train-alert: ${q} level 1 sending`, expect.stringMatching(new RegExp(`^train-alert: ${q} closed `))]);
	});

	/** Issue #1 carrying `q`'s level 1 marker, then `others` as2-train issues filed after it: a newest-first listing reaches #1 last. */
	const buried = (w: { g: { issues: FakeIssue[] } }, q: string, others: number): FakeIssue => {
		w.g.issues.push({ number: 1, url: `https://github.com/${TRAIN_ALERT_REPO}/issues/1`, title: "merge train: #106 needs you (production merge)", body: `${trainAlertMarker(q, 1)}\n…`, state: "OPEN", labels: [TRAIN_ALERT_LABEL], comments: [] });
		for (let n = 2; n <= others + 1; n++) {
			w.g.issues.push({ number: n, url: `https://github.com/${TRAIN_ALERT_REPO}/issues/${n}`, title: `merge train: #${n} needs you (failed twice)`, body: `${trainAlertMarker(`q-other${n}`, 1)}\n…`, state: "CLOSED", labels: [TRAIN_ALERT_LABEL], comments: [] });
		}
		return w.g.issues[0]!;
	};
	/** The tick's marker lookup, in either form gh offers. */
	const listing = (a: string[]) => (a[0] === "api" && a[1] === `repos/${TRAIN_ALERT_REPO}/issues`) || (a[0] === "issue" && a[1] === "list");

	test("answered after a crash, its marked issue far beyond the first page of the listing: found and closed, never recorded as no issue (review gtb-r2 F3)", () => {
		const w = world();
		const q = mergeQuestion(w.ledger, w.train);
		sendingOnly(w.ledger, w.train, q);
		const target = buried(w, q, 600);
		w.ledger.answerQuestion(q, { ...JO, answer: "skip" });
		w.run();
		w.run();
		expect(target.state).toBe("CLOSED");
		expect(w.g.calls.filter((a) => a[0] === "issue" && a[1] === "close")).toEqual([expect.arrayContaining(["close", "1"])]);
		const end = alertEntries(w.ledger, w.train, q).at(-1)!;
		expect(end).toMatch(new RegExp(`^train-alert: ${q} closed `));
		expect(end).not.toContain("no issue was filed");
	});

	test("a marker lookup that fails or reads an unexpected shape writes nothing durable: no close recorded, no issue created, and the next tick finishes (review gtb-r2 F3)", () => {
		// the close after Jo's answer
		const w = world();
		const q = mergeQuestion(w.ledger, w.train);
		sendingOnly(w.ledger, w.train, q);
		const target = buried(w, q, 600);
		w.ledger.answerQuestion(q, { ...JO, answer: "skip" });
		const real = w.g.gh;
		w.g.gh = (args) => (listing(args) ? { code: 0, stdout: JSON.stringify({ message: "Server Error" }), stderr: "" } : real(args));
		w.run();
		w.g.gh = real;
		w.g.failWhen(listing);
		w.run();
		expect(target.state).toBe("OPEN");
		expect(alertEntries(w.ledger, w.train, q)).toEqual([`train-alert: ${q} level 1 sending`]);
		expect(w.ledger.entries(w.train).filter((e) => e.body.startsWith("train-error: tick")).length).toBeGreaterThan(0);
		w.g.failWhen(null);
		w.run();
		expect(target.state).toBe("CLOSED");
		expect(alertEntries(w.ledger, w.train, q).at(-1)).not.toContain("no issue was filed");

		// level 1's lookup before a create: the question is open and its issue was filed before a crash
		const v = world();
		const q2 = mergeQuestion(v.ledger, v.train);
		sendingOnly(v.ledger, v.train, q2);
		const filed = buried(v, q2, 600);
		v.g.failWhen(listing);
		v.run();
		expect(v.creates()).toEqual([]);
		expect(alertEntries(v.ledger, v.train, q2)).toEqual([`train-alert: ${q2} level 1 sending`]);
		v.g.failWhen(null);
		v.run();
		expect(v.creates()).toEqual([]);
		expect(alertEntries(v.ledger, v.train, q2).at(-1)).toBe(`train-alert: ${q2} level 1 sent ${filed.url}`);
	});
});

describe("auto-boarding, the live half (PLAN wl-mvbjiettjrfpxc D1, D3, D4)", () => {
	test("R1: a lane finished green boards on the next pass: the tick opens a train, boards #n at G and launches it; the cutover is written once", () => {
		const w = boardWorld();
		expect(w.standing("train-autoboard:")).toHaveLength(1);
		const wl = w.landing(117);
		w.run();
		const b = w.boards();
		expect(b).toEqual([expect.objectContaining({ pr: 117, workload: wl, head: H0 })]);
		expect(trainPrs(w.ledger.entries(b[0]!.train), w.ledger.instructions(b[0]!.train))).toEqual([117]);
		expect(w.launches).toEqual([b[0]!.train]);
		w.run();
		expect(w.boards()).toHaveLength(1);
		expect(w.standing("train-autoboard:")).toHaveLength(1);
		expect(w.skips()).toEqual([]);
	});

	test("R1: a head ahead of G only by commits that each touch only .ai/decision-log/ boards at that head", () => {
		const w = boardWorld();
		const wl = w.landing(118);
		w.g.prs.get(118)!.head = H2;
		w.g.compares.set(`${H0}...${H2}`, { status: "ahead", commits: [H1, H2] });
		w.g.commitFiles.set(H1, [DECISION_LOG_FILE]);
		w.g.commitFiles.set(H2, [DECISION_LOG_FILE]);
		w.run();
		expect(w.boards()).toEqual([expect.objectContaining({ pr: 118, workload: wl, head: H2 })]);
	});

	test("R2: no board when the live half fails (a later commit touching code, a head behind G, base not main, a branch not wl/<W>, a fork) or the ledger half does (production); each leaves its reason", () => {
		const w = boardWorld();
		const code = w.landing(120);
		w.g.prs.get(120)!.head = H1;
		w.g.compares.set(`${H0}...${H1}`, { status: "ahead", commits: [H1] });
		w.g.commitFiles.set(H1, [DECISION_LOG_FILE, "src/x.ts"]);
		const behind = w.landing(121);
		w.g.prs.get(121)!.head = H2;
		w.g.compares.set(`${H0}...${H2}`, { status: "behind", commits: [] });
		const base = w.landing(122);
		w.g.prs.get(122)!.base = "release";
		const branch = w.landing(123);
		w.g.prs.get(123)!.branch = "feature/header";
		const fork = w.landing(124);
		w.g.prs.get(124)!.fork = true;
		const production = w.landing(125, { stakes: "production" });
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.launches).toEqual([]);
		const skipsOf = (wl: string) => w.skips().filter((s) => s.includes(`workload ${wl} `));
		expect(skipsOf(code)).toEqual([`train-board-skip: workload ${code} pr 120 head ${H1} head ${H1} is not the green ${H0}: commit bbbbbbb changes src/x.ts`]);
		expect(skipsOf(behind)).toEqual([`train-board-skip: workload ${behind} pr 121 head ${H2} head ${H2} is not the green ${H0}: it is behind the green`]);
		expect(skipsOf(base)).toEqual([`train-board-skip: workload ${base} pr 122 head ${H0} #122's base is release, not main`]);
		expect(skipsOf(branch)).toEqual([`train-board-skip: workload ${branch} pr 123 head ${H0} #123's head branch feature/header is not wl/${branch}`]);
		expect(skipsOf(fork)).toEqual([expect.stringMatching(new RegExp(`^train-board-skip: workload ${fork} pr 124 head ${H0} #124 is production: `))]);
		expect(skipsOf(production)).toEqual([`train-board-skip: workload ${production} pr none head none stakes production`]);
		expect(w.views(125)).toBe(0);
	});

	/** A boarding world with landing `pr` whose head `head` is one commit ahead of G, that commit's files `files` as GitHub lists them. */
	const aheadBy = (pr: number, head: string, files: (string | FakeDiffEntry)[]) => {
		const w = boardWorld();
		const wl = w.landing(pr);
		w.g.prs.get(pr)!.head = head;
		w.g.compares.set(`${H0}...${head}`, { status: "ahead", commits: [head] });
		w.g.commitFiles.set(head, files);
		return { w, wl };
	};
	const logs = (n: number) => Array.from({ length: n }, (_, i) => `.ai/decision-log/2026-10-01--1000--jev--note-${i}.md`);

	test("R2: a commit after G whose code file is on a later page of its files never boards (review wl-mvbjiettjrfpxc r1 #2)", () => {
		const { w, wl } = aheadBy(126, H1, [...logs(COMMIT_FILES_PER_PAGE), "src/late.ts"]);
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.launches).toEqual([]);
		expect(w.skips()).toEqual([`train-board-skip: workload ${wl} pr 126 head ${H1} head ${H1} is not the green ${H0}: commit bbbbbbb changes src/late.ts`]);
	});

	test("R2: a commit after G renaming a file from outside .ai/decision-log/ into it never boards (review wl-mvbjiettjrfpxc r1 #2)", () => {
		const { w, wl } = aheadBy(127, H2, [{ filename: DECISION_LOG_FILE, status: "renamed", previous_filename: "src/notes.md" }]);
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.launches).toEqual([]);
		expect(w.skips()).toEqual([`train-board-skip: workload ${wl} pr 127 head ${H2} head ${H2} is not the green ${H0}: commit ccccccc changes src/notes.md`]);
	});

	test("R2: a commit after G listing as many files as GitHub lists may have more, so it never boards; a rename within .ai/decision-log/ boards", () => {
		const { w, wl } = aheadBy(128, H1, logs(COMMIT_FILES_CAP));
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.skips()).toEqual([
			`train-board-skip: workload ${wl} pr 128 head ${H1} head ${H1} is not the green ${H0}: commit ${H1} lists ${COMMIT_FILES_CAP} files, the most GitHub lists; its other files cannot be read`,
		]);
		const { w: v, wl: within } = aheadBy(129, H2, [...logs(COMMIT_FILES_PER_PAGE), { filename: DECISION_LOG_FILE, status: "renamed", previous_filename: ".ai/decision-log/old.md" }]);
		v.run();
		expect(v.boards()).toEqual([expect.objectContaining({ pr: 129, workload: within, head: H2 })]);
	});

	test("R4: a merge commit after G touching only .ai/decision-log/ never boards (PLAN wl-mvpwkpqobyp20w D3)", () => {
		const w = boardWorld();
		const wl = w.landing(134);
		w.g.prs.get(134)!.head = H2;
		w.g.compares.set(`${H0}...${H2}`, { status: "ahead", commits: [H1, { sha: H2, parents: 2 }] });
		w.g.commitFiles.set(H1, [DECISION_LOG_FILE]);
		w.g.commitFiles.set(H2, [DECISION_LOG_FILE]);
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.launches).toEqual([]);
		expect(w.skips()).toEqual([`train-board-skip: workload ${wl} pr 134 head ${H2} head ${H2} is not the green ${H0}: commit ccccccc is a merge`]);
	});

	test("R6: the #305 fixture (green aebe37a4, decision-log commit cde03460) boards at cde03460 (PLAN wl-mvpwkpqobyp20w D3)", () => {
		const f = carry305();
		const w = boardWorld();
		const wl = w.landing(135, { sha: f.green });
		w.g.prs.get(135)!.head = f.head;
		for (const [path, answer] of Object.entries(f.answers)) w.g.saved.set(path, answer);
		w.run();
		expect(w.boards()).toEqual([expect.objectContaining({ pr: 135, workload: wl, head: f.head })]);
		expect(w.skips()).toEqual([]);
	});

	test("R17: a draft PR never boards; once it is ready for review it boards", () => {
		const w = boardWorld();
		const wl = w.landing(130);
		w.g.prs.get(130)!.draft = true;
		w.run();
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.skips()).toEqual([`train-board-skip: workload ${wl} pr 130 head ${H0} #130 is a draft`]);
		w.g.prs.get(130)!.draft = false;
		w.run();
		expect(w.boards()).toEqual([expect.objectContaining({ pr: 130, workload: wl, head: H0 })]);
	});

	test("PLAN wl-mvfkv7llkp7nk0 § 3: a PR its plan's auto-start holds never boards, its skip names the hold; one Jo approved after the auto-start boards", () => {
		const w = boardWorld();
		const auto = { by: ESCALATION_BY, body: planAutoApprovedBody("dg-1") };
		const held = w.landing(132, { entries: [auto] });
		w.run();
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.skips()).toEqual([expect.stringMatching(new RegExp(`^train-board-skip: workload ${held} pr 132 head ${H0} #132 is held: .* until jo$`))]);
		const approved = w.landing(133, { entries: [auto, { by: SURFACE_BY, body: planApprovedBody("in-1") }] });
		w.run();
		expect(w.boards()).toEqual([expect.objectContaining({ pr: 133, workload: approved, head: H0 })]);
	});

	test("R3: one skip row per head and reason across passes, a new head a new row; a PR seen MERGED ends its scan for good", () => {
		const w = boardWorld();
		const wl = w.landing(131);
		const pr = w.g.prs.get(131)!;
		pr.base = "release";
		w.run();
		w.run();
		w.run();
		expect(w.skips()).toEqual([`train-board-skip: workload ${wl} pr 131 head ${H0} #131's base is release, not main`]);
		pr.head = H1;
		w.run();
		w.run();
		expect(w.skips()).toEqual([
			`train-board-skip: workload ${wl} pr 131 head ${H0} #131's base is release, not main`,
			`train-board-skip: workload ${wl} pr 131 head ${H1} #131's base is release, not main`,
		]);
		pr.state = "MERGED";
		w.run();
		expect(w.skips().at(-1)).toBe(`train-board-skip: workload ${wl} pr 131 head ${H1} ended: #131 is MERGED on GitHub`);
		const viewed = w.views(131);
		// even a PR that looks boardable again is never read: W's scan ended
		[pr.state, pr.base] = ["OPEN", "main"];
		w.run();
		w.run();
		expect(w.views(131)).toBe(viewed);
		expect(w.skips()).toHaveLength(3);
		expect(w.boards()).toEqual([]);
	});

	test("R18: PRs boardable in one pass board oldest close first onto one train, and its members keep boarding order across passes", () => {
		const w = boardWorld();
		const first = w.landing(141);
		const second = w.landing(140);
		w.run();
		const third = w.landing(139);
		w.c.plusHours(0.1);
		w.run();
		const b = w.boards();
		expect(b.map((x) => [x.pr, x.workload])).toEqual([[141, first], [140, second], [139, third]]);
		expect(new Set(b.map((x) => x.train)).size).toBe(1);
		expect(trainPrs(w.ledger.entries(b[0]!.train), w.ledger.instructions(b[0]!.train))).toEqual([141, 140, 139]);
	});
});

describe("main's protection, verified again (PLAN wl-mvbjiettjrfpxc D6)", () => {
	/** What these helpers read of a boarding world. */
	interface World {
		ledger: Ledger;
		standing: (prefix: string) => string[];
	}
	/** The tick's protection rows on the standing workload, each as `<state> <text>`. */
	const notices = (w: World) => w.standing("train-notice: protection").map((b) => b.slice(`train-notice: protection ${REPO} `.length));
	const GAP = "no active rule on main requires status checks";
	const ISSUE = `https://github.com/${TRAIN_ALERT_REPO}/issues/1`;
	/** The train lane on `train` works #`pr` (its slice), passes it over for protection and exits released. */
	const passOver = (w: World, train: string, pr: number) => {
		const holder = w.ledger.workload(train)!.holder!;
		w.ledger.addSlice({ by: holder, workloadId: train, id: trainSliceId(train, pr), task: `PR #${pr}`, doneCondition: "terminal", inputs: `#${pr}` });
		w.ledger.recordEntry({ by: holder, workloadId: train, kind: "assumption", body: `train-error: pr ${pr} protection ${GAP}` });
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: train, kind: "assumption", body: laneExitBody(holder, { code: 0, signal: null, outcome: "released" }) });
		w.ledger.releaseWorkload(train, { by: holder, holder });
		return holder;
	};

	test("R11: a gap that verifies again clears its notice, closes its issue with a comment and wakes the train that passed a PR over; until then no backoff wake", () => {
		const w = boardWorld();
		w.g.main.rules = [];
		w.landing(150);
		w.run();
		const train = w.boards()[0]!.train;
		expect(w.launches).toEqual([train]);
		expect(notices(w)).toEqual([`gap ${GAP}`, `raised ${GAP}`, `filed ${ISSUE}`]);
		passOver(w, train, 150);
		w.c.plusHours(1);
		w.run();
		w.run();
		expect(w.launches).toEqual([train]);
		w.g.main.rules = protectedRules();
		w.run();
		expect(notices(w).slice(3)).toEqual(["ok verified", `cleared verified again; ${ISSUE} closed`]);
		expect(w.g.issues[0]).toMatchObject({ state: "CLOSED", closedWith: expect.stringContaining(`protection on ${REPO} verifies again`) });
		expect(w.launches).toEqual([train, train]);
		w.c.plusHours(1);
		w.run();
		expect(w.creates()).toHaveLength(1);
		expect(notices(w)).toHaveLength(5);
	});

	test("R11: with no train left open the open episode is still read: verified again, it clears, closes its issue and leaves no needs-you line", () => {
		const w = boardWorld();
		w.g.main.rules = [];
		w.landing(151);
		w.run();
		const train = w.boards()[0]!.train;
		const holder = passOver(w, train, 151);
		w.ledger.completeSlice(trainSliceId(train, 151), { by: holder, artifact: "left: protection" });
		w.ledger.closeWorkload(train, { by: SURFACE_BY });
		w.run();
		expect(errorLines(w.ledger).filter((l) => l.kind === "train")).toHaveLength(1);
		w.g.main.rules = protectedRules();
		w.run();
		expect(notices(w).slice(3)).toEqual(["ok verified", `cleared verified again; ${ISSUE} closed`]);
		expect(w.g.issues[0]!.state).toBe("CLOSED");
		expect(errorLines(w.ledger).filter((l) => l.kind === "train")).toEqual([]);
		expect(w.boards()).toHaveLength(1);
	});
});

describe("one merge notice per PR the train merged (PLAN wl-mvg8itbt0rz3ls D4)", () => {
	const MERGED = (pr: number) => `merged by train ${"d".repeat(40)} (run tr-${pr})`;
	/** A train world with the standing workload, the train lane's PR slices completed with `artifacts` (by PR). */
	const merged = (artifacts: Record<number, string>, o: { signoff?: { pr: number; by: string } } = {}) => {
		const w = world();
		ensureStandingWorkload(w.ledger);
		for (const [pr, artifact] of Object.entries(artifacts)) {
			const sl = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, Number(pr)), task: `PR #${pr}`, doneCondition: "terminal", inputs: `#${pr}` });
			if (o.signoff?.pr === Number(pr)) {
				w.ledger.recordEntry({ by: o.signoff.by, workloadId: w.train, sliceId: sl, kind: "assumption", body: `ruling-applied: train-signoff kind merge slice ${sl} answer merge` });
			}
			w.ledger.completeSlice(sl, { by: TRAIN_LANE, artifact });
		}
		return w;
	};
	/** The tick's merge control entries on the standing workload. */
	const entries = (w: { ledger: Ledger }) =>
		w.ledger.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.created_by === MERGE_TRAIN_BY && e.body.startsWith("train-notice: merged")).map((e) => e.body);
	/** Every notice on the standing workload, as sent. */
	const sent = (w: { ledger: Ledger }) =>
		w.ledger.db.query<{ body: string; created_by: string }, [string]>("SELECT body, created_by FROM messages WHERE workload_id = ? ORDER BY created_at, rowid").all(STANDING_WORKLOAD_ID);
	const close = (w: { ledger: Ledger; train: string }) => {
		w.ledger.releaseWorkload(w.train, { by: TRAIN_LANE, holder: TRAIN_LANE });
		w.ledger.closeWorkload(w.train, { by: SURFACE_BY });
	};

	test("R7: a PR the train merged gets one notice and one control entry across two ticks; Jo's own merge gets none", () => {
		const w = merged({ 101: MERGED(101), 106: `merged by Jo ${"e".repeat(40)}` });
		w.run();
		expect(entries(w)).toEqual([`train-notice: merged ${REPO} #101 ${w.train}`]);
		expect(sent(w)).toEqual([{ body: `notice: merge train merged #101 (${REPO}, normal stakes): ${MERGED(101)}`, created_by: MERGE_TRAIN_BY }]);
		expect(errorLines(w.ledger).filter((l) => l.kind === "notice").map((l) => l.line)).toEqual([expect.stringContaining(`merge train merged #101 (${REPO}, normal stakes)`)]);
		w.c.plusHours(0.1);
		w.run();
		expect(entries(w)).toHaveLength(1);
		expect(sent(w)).toHaveLength(1);
	});

	test("R7: a skipped PR gets no notice", () => {
		const w = merged({ 101: "skipped: CLOSED", 106: `merged by Jo ${"e".repeat(40)}` });
		w.run();
		expect(entries(w)).toEqual([]);
		expect(sent(w)).toEqual([]);
	});

	test("R7: the train's ruling-applied: train-signoff on the slice names Jo's train word; written by anyone but a holder it does not", () => {
		const prod = merged({ 101: MERGED(101) }, { signoff: { pr: 101, by: TRAIN_LANE } });
		prod.run();
		expect(sent(prod).map((m) => m.body)).toEqual([`notice: merge train merged #101 (${REPO}, production, Jo's train word (ruling train-signoff)): ${MERGED(101)}`]);
		const other = merged({ 101: MERGED(101) }, { signoff: { pr: 101, by: OWNER_LANE } });
		other.run();
		expect(sent(other).map((m) => m.body)).toEqual([`notice: merge train merged #101 (${REPO}, normal stakes): ${MERGED(101)}`]);
	});

	test("R7: a train closed 2 h earlier still notifies, one closed 25 h earlier does not", () => {
		const recent = merged({ 101: MERGED(101) });
		close(recent);
		recent.c.plusHours(2);
		recent.run();
		expect(entries(recent)).toEqual([`train-notice: merged ${REPO} #101 ${recent.train}`]);
		expect(sent(recent)).toHaveLength(1);
		const old = merged({ 101: MERGED(101) });
		close(old);
		old.c.plusHours(25);
		old.run();
		expect(entries(old)).toEqual([]);
		expect(sent(old)).toEqual([]);
	});

	test("the control entry disturbs neither the protection nor the red-main reader; the artifact is collapsed and clipped to 160", () => {
		const w = merged({ 101: MERGED(101), 106: MERGED(106) }); // no PR left pending: main's protection is not read
		w.run();
		expect(entries(w)).toHaveLength(2);
		expect(protectionEpisodes(w.ledger).size).toBe(0);
		expect(mainRedNotices(w.ledger).size).toBe(0);
		const body = trainMergedNoticeBody(REPO, 7, false, `merged by train\n  ${"x".repeat(300)}`);
		const artifact = body.slice(`merge train merged #7 (${REPO}, normal stakes): `.length);
		expect(artifact).toHaveLength(160);
		expect(artifact).toBe(`merged by train ${"x".repeat(143)}…`);
	});
});

describe("the relaunch loop, replaying wl-mvggzumu8zs5xc (PLAN wl-mvgn310dpi5gcg D1, D3)", () => {
	const MIN = 60_000;
	const CAP = { code: 6, line: "lane-x not launched: cap" };
	/**
	 * A one-PR train whose first lane (launched by the starter) returned #101 to its owner and exited released; the owner's lane
	 * pushes H2 only after the task's 2 h mark and then ends (its lease released), so the next tick settles the task failed with
	 * H2 untested by the train. With `ownerLive` the owner's 6 h lease stays held (the incident's shape, deferred by D13).
	 * `at(m)` sets the clock m minutes after that tick.
	 */
	const settledWorld = (ownerLive = false) => {
		const w = world([101]);
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: `launch: ${TRAIN_LANE} cause first requested-by ${SURFACE_BY}` });
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneReadyBody(TRAIN_LANE, w.c.now()) });
		w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 101), task: "PR #101", doneCondition: "terminal", inputs: "#101" });
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 6 * 3_600_000 }).won).toBe(true);
		w.task(101);
		expect(w.ledger.releaseWorkload(w.train, { by: TRAIN_LANE, holder: TRAIN_LANE }).released).toBe(true);
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(TRAIN_LANE, { code: 0, signal: null, outcome: "released" }) });
		w.c.plusHours(2.05);
		const p = w.g.prs.get(101)!;
		p.head = H2;
		w.g.pushed(p.branch, H2, w.c.now());
		if (!ownerLive) expect(w.ledger.releaseWorkload(w.owner, { by: OWNER_LANE, holder: OWNER_LANE }).released).toBe(true);
		w.c.plusHours(0.01);
		const t0 = Date.parse(w.c.now());
		const at = (m: number) => w.c.at(new Date(t0 + m * MIN).toISOString());
		const offset = (iso: string) => (Date.parse(iso) - t0) / MIN;
		const requests = () => controlEntries(w.ledger.entries(w.train)).filter((c) => c.prefix === "launch-requested" && c.createdBy === MERGE_TRAIN_BY);
		const wakes = () => w.ledger.entries(w.train).filter((e) => e.created_by === MERGE_TRAIN_BY && e.body === trainHeadWokenBody(101, H2)).length;
		const tickWith = (launch: (wl: string) => { code: number; line: string }) => tick({ ledger: w.ledger, gh: w.g.gh, launch, notify: () => true });
		return { ...w, at, offset, requests, wakes, tickWith };
	};

	test("T1: the drain serves each request the tick's capped launch left: wakes count, so requests come at +0, +20, +55, +120 min only", () => {
		const w = settledWorld();
		const drained: string[] = [];
		/** The drain a minute after a tick: `reserveLane`'s own predicate serves a pending request; the lane does the incident's pass. */
		const drain = () => {
			const r = w.ledger.reserveLane(w.train, { by: LANE_STARTER_BY, cap: 10, leaseMs: 3 * MIN, requestedBy: LANE_RUNNER_BY, decide: decideLaunch });
			if (!r.ok) return;
			drained.push(w.c.now());
			w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneReadyBody(r.laneId, w.c.now()) });
			// the pass-over only inside a longer note (review r1 #3), then lane_release with #101 open, then the runner's exit
			w.ledger.recordEntry({ by: r.laneId, workloadId: w.train, kind: "assumption", body: `train chain (${r.laneId}): #101 left with its owner; train-error: pr 101 live lane ${OWNER_LANE} on wl/${w.owner}` });
			w.ledger.recordEntry({ by: r.laneId, workloadId: w.train, kind: "assumption", body: releasedOpenBody(r.laneId, 1) });
			expect(w.ledger.releaseWorkload(w.train, { by: r.laneId, holder: r.laneId }).released).toBe(true);
			w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(r.laneId, { code: 0, signal: null, outcome: "released" }) });
		};
		let refused = 0;
		for (let m = 0; m < 180; m += 5) {
			w.at(m);
			w.tickWith(() => {
				refused += 1;
				return CAP;
			});
			w.at(m + 1);
			drain();
		}
		// trainRetries: 15, 30, 60 min after each lane's exit (+1, +21, +56), rounded up to the next tick; the next is 120 min after +121
		expect(w.requests().map((c) => w.offset(c.createdAt))).toEqual([0, 20, 55, 120]);
		expect(drained.map(w.offset)).toEqual([1, 21, 56, 121]);
		expect(refused).toBe(4);
		expect(w.wakes()).toBe(4);
	});

	test("T1b: a request the tick's own launcher refuses and later serves is one wake, not two", () => {
		const w = settledWorld();
		const launch = (wl: string) => {
			if (w.offset(w.c.now()) < 20) return CAP;
			const r = w.ledger.reserveLane(wl, { by: LANE_STARTER_BY, cap: 10, leaseMs: 3 * MIN, requestedBy: MERGE_TRAIN_BY, decide: decideLaunch });
			return r.ok ? { code: 0, line: `launched ${r.laneId}` } : { code: 1, line: r.reason };
		};
		w.at(0);
		w.tickWith(launch);
		expect(w.wakes()).toBe(1);
		for (const m of [5, 10, 15]) {
			w.at(m);
			w.tickWith(launch);
		}
		w.at(20);
		expect(trainRetries(w.ledger, w.train, new Map([[101, H2]])).untested).toEqual([{ pr: 101, sha: H2, woken: 1 }]);
		const lines = w.tickWith(launch);
		expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^${w.train}: launch \\(.*#101 head ${H2} untested by the train after 1 wake\\(s\\), retry due.*\\): exit 0: launched lane-`)));
		expect(w.wakes()).toBe(1);
		expect(w.requests()).toHaveLength(1);
	});

	test("D13: while the owner's lane holds a live lease, #101's settled task and untested head wake nothing; one line per pass; the lease's expiry wakes it", () => {
		const w = settledWorld(true);
		const launched: number[] = [];
		const lines: string[] = [];
		for (let m = 0; m < 180; m += 5) {
			w.at(m);
			lines.push(...w.tickWith(() => {
				launched.push(m);
				return CAP;
			}).filter((l) => l.includes("#101 wake deferred")));
		}
		expect(w.requests()).toEqual([]);
		expect(w.wakes()).toBe(0);
		expect(launched).toEqual([]);
		expect(lines).toHaveLength(36);
		expect(lines[0]).toContain(`${w.owner} is held live by ${OWNER_LANE}`);
		expect(lines[0]).toContain(`#101 head ${H2} untested by the train`);
		// the 6 h lease (claimed ~2 h before t0) expires at about +238 min: the deferred reasons wake the train once
		w.at(240);
		w.tickWith(() => CAP);
		expect(w.requests().map((c) => w.offset(c.createdAt))).toEqual([240]);
		expect(w.wakes()).toBe(1);
	});

	/** A released train made actionable by a new board, and #101's task due to its autonomous owner: both would be requested. */
	const ceilingWorld = () => {
		const w = world();
		w.task(101);
		expect(w.ledger.releaseWorkload(w.train, { by: TRAIN_LANE, holder: TRAIN_LANE }).released).toBe(true);
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(TRAIN_LANE, { code: 0, signal: null, outcome: "released" }) });
		w.g.prs.set(102, { head: H0, branch: "feature/boarded" });
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: w.train, kind: "assumption", body: trainBoardBody({ pr: 102, workload: w.owner, head: H0, run: null, review: null }) });
		let lane = 0;
		/** The surface's lowered `ceiling:`, then the runner's `spend:` rows, one lane each. */
		const stopAt = (wl: string, ceiling: Ceiling, ...spends: Spend[]) => {
			w.ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody(ceiling, "lowered by the orchestrator") });
			spend(wl, ...spends);
		};
		const spend = (wl: string, ...spends: Spend[]) => {
			for (const s of spends) w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: spendBody(`lane-${wl.slice(3)}-${++lane}`, s) });
		};
		const requested = (wl: string) => controlEntries(w.ledger.entries(wl)).filter((c) => c.prefix === "launch-requested" && c.createdBy === MERGE_TRAIN_BY).length;
		/** The tick's one log line for `wl` at its ceiling, `<x> of <y>` in dollars. */
		const stopped = (lines: string[], wl: string, usd: string) =>
			expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^${wl}: launch \\(.+\\) not requested: stopped at its ceiling usd ${usd.replaceAll(".", "\\.")}$`)));
		return { ...w, stopAt, spend, requested, stopped };
	};

	test("T3: at its ceiling neither the train wake nor the owner delivery is requested; the max spend row counts; a Jo raise requests again", () => {
		const w = ceilingWorld();
		for (const wl of [w.train, w.owner]) w.stopAt(wl, { usd: 42, wallMin: 360 }, { usd: 42.0173, tokens: 1_200_000, wallMin: 95 });
		let lines = w.run();
		for (const wl of [w.train, w.owner]) {
			expect(w.requested(wl)).toBe(0);
			w.stopped(lines, wl, "42.0173 of 42");
		}
		expect(w.launches).toEqual([]);
		// a later lane's spend row below the ceiling: still stopped at the highest
		for (const wl of [w.train, w.owner]) w.spend(wl, { usd: 3.5, tokens: 90_000, wallMin: 6 });
		lines = w.run();
		expect(w.launches).toEqual([]);
		for (const wl of [w.train, w.owner]) w.stopped(lines, wl, "42.0173 of 42");
		// Jo's `ceiling 80 6`: the surface's instruction and the raised ceiling: naming it
		for (const wl of [w.train, w.owner]) {
			const by = w.ledger.recordInstruction({ ...JO, workloadId: wl, body: "ceiling: 80 6" });
			w.ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody({ usd: 80, wallMin: 360 }, "ceiling word by jo", by) });
		}
		lines = w.run();
		expect(lines.filter((l) => l.includes("not requested"))).toEqual([]);
		// the owner on the tick's request; the never-launched train on its own cause `first`, with no request (PLAN wl-mvpsrr4tr0p1xc D2)
		expect(w.requested(w.owner)).toBe(1);
		expect(w.requested(w.train)).toBe(0);
		expect([...w.launches].sort()).toEqual([w.train, w.owner].sort());
	});

	test("T3: a wall-only stop (spend wall at the wall ceiling, dollars under) is stopped too", () => {
		const w = ceilingWorld();
		for (const wl of [w.train, w.owner]) w.stopAt(wl, { usd: 50, wallMin: 30 }, { usd: 1.5, tokens: 40_000, wallMin: 30 });
		const lines = w.run();
		for (const wl of [w.train, w.owner]) {
			expect(w.requested(wl)).toBe(0);
			w.stopped(lines, wl, "1.5 of 50");
		}
		expect(w.launches).toEqual([]);
	});
});

describe("land-first in the tick (PLAN wl-mvq4edbaf13vnk D6, D13, § 2 Protect the verifier)", () => {
	const G = "1".repeat(40);
	const T = "2".repeat(40);
	const HX = "3".repeat(40);
	const MIN = 60_000;
	/**
	 * A served REPO with land-first on, main at T (PR #201) on G (green); a fake runner and a control root that passes the
	 * self-check; `gh` answers main's ref, chain, PRs, statuses, the tag and status posts, else the boarding world's fake.
	 */
	const lf = (o: { on?: boolean } = {}) => {
		const w = boardWorld();
		let seq = 0;
		const jo = (word: string, body: (id: string) => string) => {
			const id = w.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: word });
			w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: body(id) });
		};
		if (o.on ?? true) jo(landFirstInstructionBody(REPO, true), (id) => landFirstBody(REPO, true, id));
		const mainRun = (sha: string, verdict: "green" | "red" | "error") => w.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption",
			body: testRunBody({
				runId: makeRunId(Date.parse(w.ledger.now()) + ++seq, "main"), verdict, sha, pr: 0, reason: verdict === "error" ? "runner died" : null, headAtEnd: sha, base: null, mergeBase: null,
				full: { pass: 400, fail: verdict === "red" ? 1 : 0, skip: 0, exit: verdict === "green" ? 0 : 1, ms: 900, error: null }, solo: [],
				failures: verdict === "red" ? [{ part: "full", name: "x.test.ts > broken", firstError: "error: nope" }] : [], runDir: null, preflight: "ok",
				scope: "full", main: true, host: "mac", exec: verdict === "error" ? null : { files: 40, tests: 400, treeFiles: 40 },
			}),
		});
		mainRun(G, "green");
		const gh = {
			tip: T, landed: w.ledger.now(), tag: G as string | null, open: new Map<number, string>(), status: new Map<string, { state: string; description: string }>(),
			postFails: false, posts: [] as string[][],
		};
		const answer = (v: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
		const publicationRoot = tmp("tick-publication");
		const onGh = { fn: (_args: string[], _timeoutMs?: number) => {} };
		const fakeGh = (args: string[], timeoutMs?: number): GhResult => {
			onGh.fn(args, timeoutMs);
			const p = `repos/${REPO}/`;
			const [noun, verb] = args;
			if (noun === "api" && verb === `${p}git/ref/heads/main`) return answer({ object: { sha: gh.tip } });
			if (noun === "api" && verb?.startsWith(`${p}git/commits/`)) {
				const sha = verb.slice(`${p}git/commits/`.length);
				return answer({ sha, tree: { sha: sha === G ? "4".repeat(40) : "5".repeat(40) }, committer: { date: sha === G ? "2026-01-01T00:00:00.000Z" : gh.landed }, parents: sha === G ? [] : [{ sha: G }] });
			}
			if (noun === "api" && verb === `${p}commits/${T}/pulls`) return answer([{ number: 201 }]);
			if (noun === "api" && verb?.startsWith(`${p}commits/`) && verb.endsWith("/pulls")) return answer(verb.includes(G) ? [{ number: 200 }] : []);
			if (noun === "api" && verb?.endsWith("/statuses") && verb.startsWith(`${p}commits/`)) {
				const s = gh.status.get(verb.slice(`${p}commits/`.length, -"/statuses".length));
				return answer(s ? [{ context: "as2/full-suite", ...s }] : []);
			}
			if (noun === "api" && verb === "-X") {
				gh.posts.push(args);
				return gh.postFails ? { code: 1, stdout: "", stderr: "HTTP 502" } : answer({});
			}
			if (noun === "api" && verb === `${p}git/ref/tags/as2-verified`) return gh.tag === null ? { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" } : answer({ object: { type: "commit", sha: gh.tag } });
			if (noun === "pr" && verb === "list") return answer([...gh.open].map(([number, headRefOid]) => ({ number, headRefOid })));
			return w.g.gh(args);
		};
		const runnerCalls: string[][] = [];
		const runner = { answer: (_args: string[]): GhResult => ({ code: 0, stdout: "", stderr: "" }) };
		const root: ControlRoot = { root: "/v/current", head: G, modified: [], current: "/v/current", currentHead: G, repo: REPO };
		const logs: string[] = [];
		const onLog = { fn: (_l: string) => {} };
		const pass = () => tick({
			ledger: w.ledger, gh: fakeGh, launch: () => ({ code: 1, line: "not launched" }), notify: () => true, config: { repos: [{ origin: REPO, command: "bun test" }] },
			land: { runner: (a) => (runnerCalls.push(a), runner.answer(a)), root: () => root, runsRoot: publicationRoot }, log: (l) => (logs.push(l), onLog.fn(l)),
		});
		const rows = () => landFirstRows(w.ledger.entries(STANDING_WORKLOAD_ID), REPO);
		const reconciled = () => latestTrainReconciled(w.ledger.entries(STANDING_WORKLOAD_ID), REPO);
		const at = (m: number) => w.c.at(new Date(Date.parse(gh.landed) + m * MIN).toISOString());
		return { ...w, gh, mainRun, jo, runnerCalls, runner, root, logs, onLog, onGh, publicationRoot, pass, rows, reconciled, at };
	};
	const mainCalls = (x: ReturnType<typeof lf>) => x.runnerCalls.filter((a) => a[0] === "main");

	test("R17, R18: reap first, one main run requested for a tip with no verdict, train-reconciled open after the pass; a verdict stops requests", () => {
		const x = lf();
		x.pass();
		expect(x.runnerCalls).toEqual([["reap"], ["main", "--repo", REPO, "--sha", T]]);
		const r = x.reconciled()!;
		expect(r.createdAt).toBe(x.ledger.now());
		expect(r.r).toMatchObject({ repo: REPO, tip: T, g: G, open: true, repair: null, reasons: "" });
		expect(r.r.read).toBe(controlEntries(x.ledger.entries(STANDING_WORKLOAD_ID)).findLast((c) => c.prefix === "test-run")!.id);
		x.mainRun(T, "green");
		x.c.plusHours(0.1);
		x.pass();
		expect(mainCalls(x)).toHaveLength(1);
		expect(x.reconciled()!.r).toMatchObject({ g: T, open: true });
	});

	test("R17: a failed reap requests nothing; an inconclusive run is retried only 15 min on, 3 per block, then one exhausted row until main-retry", () => {
		const x = lf();
		x.runner.answer = (a) => (a[0] === "reap" ? { code: 1, stdout: "", stderr: "ledger locked" } : { code: 0, stdout: "", stderr: "" });
		x.pass();
		expect(mainCalls(x)).toEqual([]);
		expect(x.logs).toContainEqual(expect.stringContaining("reap exited 1: ledger locked"));
		x.runner.answer = () => ({ code: 0, stdout: "", stderr: "" });
		x.mainRun(T, "error");
		x.at(10);
		x.pass();
		expect(mainCalls(x)).toEqual([]);
		x.at(16);
		x.pass();
		expect(mainCalls(x)).toHaveLength(1);
		x.mainRun(T, "error");
		x.at(32);
		x.pass();
		x.mainRun(T, "error");
		x.at(48);
		x.pass();
		x.at(70);
		x.pass();
		expect(mainCalls(x)).toHaveLength(2);
		expect(x.rows().filter((r) => r.event === "exhausted")).toEqual([expect.objectContaining({ sha: T, block: 1 })]);
		expect(errorLines(x.ledger).map((l) => l.line)).toContainEqual(`main runs exhausted at ${T.slice(0, 7)}: fix the runner, then say main-retry ${REPO}`);
		x.at(80);
		x.jo(mainRetryInstructionBody(REPO), (id) => mainRetryBody(REPO, id));
		x.at(81);
		x.pass();
		expect(mainCalls(x)).toHaveLength(3);
		expect(errorLines(x.ledger).map((l) => l.line).filter((l) => l.startsWith("main runs exhausted"))).toEqual([]);
	});

	test("landing revocation holds the bounded publication mutex only for the final POST, not bulk discovery", () => {
		const x = lf();
		x.mainRun(T, "red");
		x.gh.open.set(202, HX);
		x.gh.status.set(HX, { state: "success", description: "fast green" });
		withFullSuitePublication(x.publicationRoot, REPO, () => {});
		const path = join(x.publicationRoot, readdirSync(x.publicationRoot).find((name) => name.includes(".publication-"))!);
		let reads = 0;
		let posts = 0;
		x.onGh.fn = (args, timeoutMs) => {
			const post = args[1] === "-X" && args[3] === `repos/${REPO}/statuses/${HX}`;
			const read = (args[0] === "pr" && args[1] === "list") || args[1] === `repos/${REPO}/commits/${HX}/statuses`;
			if (!post && !read) return;
			const db = new Database(path);
			try {
				db.exec("PRAGMA busy_timeout = 1");
				if (post) {
					expect(() => db.exec("BEGIN IMMEDIATE")).toThrow();
					expect(timeoutMs).toBeGreaterThan(0);
					expect(timeoutMs).toBeLessThanOrEqual(30_000);
					posts++;
				} else {
					db.exec("BEGIN IMMEDIATE");
					expect(timeoutMs).toBeUndefined();
					reads++;
				}
			} finally { db.close(); }
		};
		x.pass();
		expect(reads).toBeGreaterThan(0);
		expect(posts).toBe(1);
		expect(x.gh.posts).toHaveLength(1);
	});

	for (const point of ["listing", "status"] as const) test(`off during landing ${point} discovery preserves a newly settled full green`, () => {
		const x = lf();
		x.mainRun(T, "red");
		x.gh.open.set(202, HX);
		x.gh.status.set(HX, { state: "success", description: "fast green" });
		let changed = false;
		x.onGh.fn = (args) => {
			if (changed || !(point === "listing" ? args[0] === "pr" && args[1] === "list" : args[1] === `repos/${REPO}/commits/${HX}/statuses`)) return;
			changed = true;
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			const wl = x.ledger.openWorkload({ by: SURFACE_BY, brief: "full result during off", stakes: "normal", mode: "autonomous" });
			const entry = (body: string) => x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body });
			withFullSuitePublication(x.publicationRoot, REPO, () => {
				entry(testRequestedBody({ runId: "tr-tickfull", pr: 202, sha: HX, slice: "sl-tickfull", by: "lane-test" }));
				entry(fastPlanBody("tr-tickfull", { ref: "wl/test", scope: "full", reasons: ["schema"] }));
				entry(testRunBody({ runId: "tr-tickfull", pr: 202, sha: HX, verdict: "green", reason: null, headAtEnd: HX, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: "full", host: "mac", main: false, exec: null }));
				x.gh.status.set(HX, { state: "success", description: "genuine full green" });
			});
		};
		x.pass();
		expect(changed).toBe(true);
		expect(x.gh.posts).toEqual([]);
		expect(x.gh.status.get(HX)?.description).toBe("genuine full green");
		expect(x.rows().filter((r) => r.event === "revoke-failed")).toEqual([]);
		expect(x.logs).toContainEqual(expect.stringContaining("skipped stale landing revocation"));
	});

	test("a new activation generation during landing discovery invalidates the old on-mode revocation", () => {
		const x = lf();
		x.mainRun(T, "red");
		x.gh.open.set(202, HX);
		x.gh.status.set(HX, { state: "success", description: "new activation green" });
		let changed = false;
		x.onGh.fn = (args) => {
			if (!changed && args[1] === `repos/${REPO}/commits/${HX}/statuses`) {
				changed = true;
				x.jo(landFirstInstructionBody(REPO, true), (id) => landFirstBody(REPO, true, id));
			}
		};
		x.pass();
		expect(changed).toBe(true);
		expect(x.gh.posts).toEqual([]);
		expect(x.rows().filter((r) => r.event === "revoke-failed")).toEqual([]);
		expect(x.logs).toContainEqual(expect.stringContaining("skipped stale landing revocation"));
	});

	test("main recovery during landing discovery invalidates the old stop at serialized POST", () => {
		const x = lf();
		x.mainRun(T, "red");
		x.gh.open.set(202, HX);
		x.gh.status.set(HX, { state: "success", description: "green after main recovery" });
		let recovered = false;
		x.onGh.fn = (args) => {
			if (!recovered && args[1] === `repos/${REPO}/commits/${HX}/statuses`) {
				recovered = true;
				x.mainRun(T, "green");
			}
		};
		x.pass();
		expect(recovered).toBe(true);
		expect(x.gh.posts).toEqual([]);
		expect(x.reconciled()).toBeNull();
		expect(x.rows().filter((r) => r.event === "revoke-failed")).toEqual([]);
		expect(x.logs).toContainEqual(expect.stringContaining("skipped stale landing revocation"));
	});

	test("legacy off failures never consume a later landing-stop revocation block at the same head", () => {
		const x = lf();
		x.mainRun(T, "red");
		x.gh.open.set(202, HX);
		x.gh.status.set(HX, { state: "success", description: "fast green after re-on" });
		x.gh.postFails = true;
		for (let attempt = 1; attempt <= 3; attempt++) {
			x.ledger.recordEntry({
				by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption",
				body: landFirstNoticeBody(REPO, { event: "revoke-failed", pr: 202, head: HX, attempt, error: "off reconciliation pending: HTTP 502; next tick retries" }),
			});
		}
		for (const minute of [1, 6, 11, 16]) {
			x.at(minute);
			x.pass();
		}
		expect(x.gh.posts).toHaveLength(3);
		expect(x.rows().flatMap((r) => r.event === "revoke-failed" && !r.error.startsWith("off reconciliation pending:") ? [r.attempt] : [])).toEqual([1, 2, 3]);
		expect(x.rows().filter((r) => r.event === "revoke-gave-up")).toHaveLength(1);
		expect(errorLines(x.ledger).some((line) => line.line.startsWith("revocation failed on #202 "))).toBe(true);
	});

	test("R17: a red tip opens one stop episode with one issue, revokes an open green 3 times then gives up once, records the repair and fails it at 30 min", () => {
		const x = lf();
		x.mainRun(T, "red");
		x.gh.open.set(202, HX);
		x.gh.status.set(HX, { state: "success", description: "fast green" });
		x.gh.postFails = true;
		for (const m of [1, 6, 11, 16]) {
			x.at(m);
			x.pass();
		}
		const events = x.rows().map((r) => r.event);
		expect(events.filter((e) => e === "stop-raised")).toHaveLength(1);
		expect(events.filter((e) => e === "stop-filed")).toHaveLength(1);
		expect(x.creates()).toHaveLength(1);
		expect(events.filter((e) => e === "revoke-failed")).toHaveLength(3);
		expect(events.filter((e) => e === "revoke-gave-up")).toHaveLength(1);
		expect(x.gh.posts).toHaveLength(3);
		expect(x.rows().find((r) => r.event === "repair-woken")).toMatchObject({ tip: T, train: null });
		expect(x.reconciled()!.r).toMatchObject({ open: false, tip: T, g: G });
		const lines = errorLines(x.ledger).map((l) => l.line);
		expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^main red at ${T.slice(0, 7)} since .* on ${REPO}: 1 failing; suspects #201; repair woken `)));
		expect(lines).toContainEqual(expect.stringMatching(/^revocation failed on #202 /));
		expect(events).not.toContain("repair-failed");
		x.at(31);
		x.pass();
		expect(x.rows().filter((r) => r.event === "repair-failed")).toHaveLength(1);
		x.at(36);
		x.pass();
		expect(x.rows().filter((r) => r.event === "repair-failed")).toHaveLength(1);
		// the head moves on: the given-up revocation clears; main's fix lands green and the episode closes with its issue
		x.gh.open.set(202, "7".repeat(40));
		x.gh.tip = "6".repeat(40);
		x.mainRun(x.gh.tip, "green");
		x.at(40);
		x.pass();
		expect(x.rows().map((r) => r.event)).toEqual(expect.arrayContaining(["revoke-cleared", "stop-cleared"]));
		expect(x.g.issues[0]!.state).toBe("CLOSED");
		expect(errorLines(x.ledger).map((l) => l.line).filter((l) => /^(main red|revocation failed|landing stopped)/.test(l))).toEqual([]);
	});

	test("R17: an infrastructure stop (oldest suspect over 40 min, no verdict) files its issue and revokes, but wakes no repair", () => {
		const x = lf();
		x.gh.open.set(202, HX);
		x.gh.status.set(HX, { state: "success", description: "fast green" });
		x.at(41);
		x.pass();
		expect(x.rows().map((r) => r.event)).toEqual(["stop-raised", "stop-filed"]);
		expect(x.rows()[0]).toMatchObject({ kind: "infrastructure" });
		expect(x.gh.posts).toEqual([expect.arrayContaining([`repos/${REPO}/statuses/${HX}`, "state=failure"])]);
		expect(errorLines(x.ledger).map((l) => l.line)).toContainEqual(expect.stringMatching(new RegExp(`^landing stopped at ${T.slice(0, 7)} on ${REPO}: oldest suspect`)));
	});

	test("R18: a main-run settle newer than the pass's watermark writes no train-reconciled; the next pass does", () => {
		const x = lf();
		x.onLog.fn = (l) => {
			if (l.includes("test-runner main exited")) x.mainRun(T, "green");
		};
		x.pass();
		expect(x.reconciled()).toBeNull();
		expect(x.logs).toContainEqual(expect.stringContaining("no train-reconciled: a main-run settle landed after this pass read"));
		x.onLog.fn = () => {};
		x.c.plusHours(0.1);
		x.pass();
		expect(x.reconciled()!.r).toMatchObject({ g: T, open: true });
	});

	test("R18: a tick whose root fails the self-check while land-first is on refuses: one row, nothing run; with land-first off it runs (shadow mode)", () => {
		const x = lf();
		x.root.modified = ["surface/scripts/train-tick.ts"];
		x.pass();
		x.c.plusHours(0.1);
		x.pass();
		expect(x.runnerCalls).toEqual([]);
		expect(landFirstRows(x.ledger.entries(STANDING_WORKLOAD_ID), "*").map((r) => r.event)).toEqual(["tick-refused"]);
		expect(x.reconciled()).toBeNull();
		expect(errorLines(x.ledger).map((l) => l.line)).toContainEqual(expect.stringMatching(/^verifier: the train tick refuses to run: tracked files modified: surface\/scripts\/train-tick\.ts/));
		const y = lf({ on: false });
		y.root.modified = ["x"];
		y.pass();
		expect(y.runnerCalls).toEqual([["reap"], ["main", "--repo", REPO, "--sha", T]]);
		expect(y.reconciled()).toBeNull();
	});

	test("R31: a lagging promotion is retried once per pass, 3 failures per G then one gave-up; a schema stop files one issue and waits", () => {
		const x = lf();
		x.root.currentHead = "9".repeat(40);
		x.runner.answer = (a) => (a[0] === "promote" ? { code: 1, stdout: "", stderr: "fetch failed" } : { code: 0, stdout: "", stderr: "" });
		for (let i = 0; i < 5; i++) {
			x.c.plusHours(0.1);
			x.pass();
		}
		expect(x.runnerCalls.filter((a) => a[0] === "promote")).toEqual(Array(3).fill(["promote", "--sha", G]));
		expect(x.rows().map((r) => r.event)).toEqual(["promote-failed", "promote-failed", "promote-failed", "promote-gave-up"]);
		expect(errorLines(x.ledger).map((l) => l.line)).toContainEqual(expect.stringMatching(/^verifier: promotion of 1111111 on thewolff\/product failed 3 times: exit 1: fetch failed/));
		const y = lf();
		y.gh.tag = null;
		y.mainRun(T, "green"); // The verified target is a descendant, not the schema barrier returned by promotion.
		y.runner.answer = (a) => (a[0] === "promote" ? { code: 0, stdout: `schema ${"8".repeat(40)}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
		y.pass();
		y.c.plusHours(0.1);
		y.pass();
		expect(y.runnerCalls.filter((a) => a[0] === "promote")).toHaveLength(1);
		expect(y.rows().filter((r) => r.event === "promote-schema")).toEqual([expect.objectContaining({ sha: "8".repeat(40), g: T, current: G })]);
		expect(y.creates()).toHaveLength(1);
		expect(y.g.issues[0]!.body).toContain(`schema barrier ${"8".repeat(40)}`);
		expect(y.g.issues[0]!.body).toContain(`promote-verified.ts ${T}`);
		expect(y.g.issues[0]!.body).not.toContain(`promote-verified.ts ${"8".repeat(40)}`);
		expect(errorLines(y.ledger).map((l) => l.line)).toContainEqual(expect.stringContaining(`verified target ${T} — stop the tick, migrate the live ledger through ${T}, run bun surface/scripts/promote-verified.ts ${T}, restart`));
		// A newer verified target behind the same barrier must replace the old recovery, not be suppressed by current alone.
		y.gh.tip = HX;
		y.mainRun(HX, "green");
		y.pass();
		expect(y.rows().filter((r) => r.event === "promote-schema")).toHaveLength(2);
		expect(y.g.issues.at(-1)!.body).toContain(`promote-verified.ts ${HX}`);
	});
});

describe("D13: a busy owner defers its PR's wake reasons (R38)", () => {
	/** actionable with D13's owners: `why` the per-PR reasons it woke on (the train's own `train:` entry is train-wide), `all` every reason. */
	const deferrals = (w: ReturnType<typeof world>) => {
		const out: WakeDeferral[] = [];
		const all = actionable(w.ledger, w.train, [101], new Map(), new Set(), () => null, { headRefs: new Map([[101, `wl/${w.owner}`]]), defer: (d) => out.push(d) });
		return { all, why: all.filter((r) => !r.startsWith("train: ")), out };
	};

	test("an owner whose only open slice waits on an unsettled run defers; a second open slice, a settle or an expired lease does not", () => {
		const w = world();
		const sl = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "suite", doneCondition: "green", inputs: "#101" });
		const runId = makeRunId(Date.parse(w.c.now()), "abcd");
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: w.owner, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr: 101, sha: H0, slice: sl, by: OWNER_LANE }) });
		let d = deferrals(w);
		expect(d.why).toEqual([]);
		expect(d.out).toEqual([{ pr: 101, owner: w.owner, busy: `${w.owner}'s only open work waits on its test run ${runId}`, reasons: ["#101's dependency merged"] }]);
		const other = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "more", doneCondition: "done", inputs: "x" });
		d = deferrals(w);
		expect(d.why).toEqual(["#101's dependency merged"]);
		expect(d.out).toEqual([]);
		w.ledger.cancelSlice(other, { by: OWNER_LANE });
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 60_000 }).won).toBe(true);
		w.ledger.releaseWorkload(w.owner, { by: OWNER_LANE, holder: OWNER_LANE });
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 60_000 }).won).toBe(true);
		w.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: w.owner, sliceId: sl, kind: "assumption",
			body: testRunBody({ runId, verdict: "green", sha: H0, pr: 101, reason: null, headAtEnd: H0, base: null, mergeBase: null, full: { pass: 1, fail: 0, skip: 0, exit: 0, ms: 1, error: null }, solo: [], failures: [], runDir: null, preflight: null }),
		});
		d = deferrals(w);
		expect(d.out.map((x) => x.busy)).toEqual([`${w.owner} is held live by ${OWNER_LANE} until ${w.ledger.workload(w.owner)!.holder_lease_until}`]);
		w.c.plusHours(0.1);
		d = deferrals(w);
		expect(d.out).toEqual([]);
		expect(d.why).toEqual(["#101's dependency merged"]);
	});

	test("train-wide reasons are never deferred", () => {
		const w = world();
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 3_600_000 }).won).toBe(true);
		const d = deferrals(w);
		expect(d.all).toEqual([expect.stringMatching(/^train: #101 #106 /)]);
		expect(d.out).toEqual([expect.objectContaining({ pr: 101, reasons: ["#101's dependency merged"] })]);
	});
});
