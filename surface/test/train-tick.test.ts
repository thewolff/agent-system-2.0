// The merge train's tick (PLAN wl-mv8s8srodefytc rev 17.1 D9-D10, part 3): settles once, opens one fix workload per PR,
// launches owners and the train, raises the failed-twice alert, files each alert once on jo-issues with the as2-train label,
// re-sends it louder at 4 h and 8 h until acknowledged, and keeps acting while a question is open. Auto-boarding (PLAN
// wl-mvbjiettjrfpxc D1, D3, D4, D6): the cutover, the live half of "a lane finished green", one skip row per head and reason,
// boarding oldest close first, and a protection episode that clears and wakes the trains it held. The relaunch loop (PLAN
// wl-mvgn310dpi5gcg D1, D3): a wake per request whichever starter serves it, and no request at the ceiling.
// Temp ledgers, temp git checkouts with a fake GitHub origin, a fake gh, a fake launcher and a fake notification only
// (surface/test/train-world.ts).
import { describe, expect, test } from "bun:test";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { type GhResult, tick } from "../scripts/train-tick";
import { type Ceiling, ceilingBody, type Spend, spendBody } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { controlEntries, decideLaunch, laneExitBody, launchFailedBody, trainBoardBody } from "../src/launch";
import { readLabWaitContext } from "../src/lab-wait";
import {
	fixBindings, TRAIN_ALERT_LABEL, TRAIN_ALERT_REPO, trainActivityArgs, trainAlertBody, trainAlertMarker, trainHeadWokenBody, trainPrs, trainRetries, trainSliceId,
} from "../src/merge-train";
import { makeRunId, testRequestedBody } from "../src/test-run";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { releasedOpenBody } from "../src/turn-end";
import {
	boardWorld, COMMIT_FILES_CAP, COMMIT_FILES_PER_PAGE, DECISION_LOG_FILE, type FakeDiffEntry, type FakeIssue, H0, H1, H2, JO, OWNER_LANE, protectedRules, REPO, TRAIN_LANE, world,
} from "./train-world";

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

	test("an actionable train no lane holds live is woken", () => {
		const w = world();
		w.task(101);
		w.c.plusHours(0.05);
		w.push(101, H1, "green");
		w.c.plusHours(0.2); // the train lane's lease has lapsed
		w.run();
		expect(w.launches).toContain(w.train);
		expect(controlEntries(w.ledger.entries(w.train)).some((c) => c.prefix === "launch-requested" && c.createdBy === MERGE_TRAIN_BY)).toBe(true);
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

	test("the live-owner shortcut keeps the PR pending: its train slices stay open, the tick reads it, and a later pass retries it", () => {
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
		w.run();
		expect(views()).toBeGreaterThan(before);
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
		expect(skipsOf(code)).toEqual([`train-board-skip: workload ${code} pr 120 head ${H1} commit ${H1} after the green sha touches src/x.ts, not only .ai/decision-log/`]);
		expect(skipsOf(behind)).toEqual([`train-board-skip: workload ${behind} pr 121 head ${H2} head ${H2} is not ahead of the green sha ${H0} (compare: behind)`]);
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
		expect(w.skips()).toEqual([`train-board-skip: workload ${wl} pr 126 head ${H1} commit ${H1} after the green sha touches src/late.ts, not only .ai/decision-log/`]);
	});

	test("R2: a commit after G renaming a file from outside .ai/decision-log/ into it never boards (review wl-mvbjiettjrfpxc r1 #2)", () => {
		const { w, wl } = aheadBy(127, H2, [{ filename: DECISION_LOG_FILE, status: "renamed", previous_filename: "src/notes.md" }]);
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.launches).toEqual([]);
		expect(w.skips()).toEqual([`train-board-skip: workload ${wl} pr 127 head ${H2} commit ${H2} after the green sha touches src/notes.md, not only .ai/decision-log/`]);
	});

	test("R2: a commit after G listing as many files as GitHub lists may have more, so it never boards; a rename within .ai/decision-log/ boards", () => {
		const { w, wl } = aheadBy(128, H1, logs(COMMIT_FILES_CAP));
		w.run();
		expect(w.boards()).toEqual([]);
		expect(w.skips()).toEqual([
			`train-board-skip: workload ${wl} pr 128 head ${H1} commit ${H1} after the green sha lists ${COMMIT_FILES_CAP} files, the most GitHub lists; its other files cannot be read`,
		]);
		const { w: v, wl: within } = aheadBy(129, H2, [...logs(COMMIT_FILES_PER_PAGE), { filename: DECISION_LOG_FILE, status: "renamed", previous_filename: ".ai/decision-log/old.md" }]);
		v.run();
		expect(v.boards()).toEqual([expect.objectContaining({ pr: 129, workload: within, head: H2 })]);
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

describe("the relaunch loop, replaying wl-mvggzumu8zs5xc (PLAN wl-mvgn310dpi5gcg D1, D3)", () => {
	const MIN = 60_000;
	const CAP = { code: 6, line: "lane-x not launched: cap" };
	/**
	 * A one-PR train whose first lane (launched by the starter) returned #101 to its owner and exited released; the owner's lane
	 * holds it live and pushes H2 only after the task's 2 h mark, so the next tick settles the task failed with H2 untested by the
	 * train. `at(m)` sets the clock m minutes after that tick.
	 */
	const settledWorld = () => {
		const w = world([101]);
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: w.train, kind: "assumption", body: `launch: ${TRAIN_LANE} cause first requested-by ${SURFACE_BY}` });
		w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 101), task: "PR #101", doneCondition: "terminal", inputs: "#101" });
		expect(w.ledger.claimWorkload(w.owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 6 * 3_600_000 }).won).toBe(true);
		w.task(101);
		expect(w.ledger.releaseWorkload(w.train, { by: TRAIN_LANE, holder: TRAIN_LANE }).released).toBe(true);
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.train, kind: "assumption", body: laneExitBody(TRAIN_LANE, { code: 0, signal: null, outcome: "released" }) });
		w.c.plusHours(2.05);
		const p = w.g.prs.get(101)!;
		p.head = H2;
		w.g.pushed(p.branch, H2, w.c.now());
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
			const wait = readLabWaitContext(w.ledger);
			const r = w.ledger.reserveLane(w.train, { by: LANE_STARTER_BY, cap: 10, leaseMs: 3 * MIN, requestedBy: LANE_RUNNER_BY, decide: (rows) => decideLaunch(rows, wait) });
			if (!r.ok) return;
			drained.push(w.c.now());
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
			const wait = readLabWaitContext(w.ledger);
			const r = w.ledger.reserveLane(wl, { by: LANE_STARTER_BY, cap: 10, leaseMs: 3 * MIN, requestedBy: MERGE_TRAIN_BY, decide: (rows) => decideLaunch(rows, wait) });
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
		for (const wl of [w.train, w.owner]) expect(w.requested(wl)).toBe(1);
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
