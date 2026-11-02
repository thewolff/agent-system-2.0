// What of the merge train reaches Jo, and how often (PLAN wl-mvbjiettjrfpxc D6-D10): a production merge and an unfixable
// conflict reach Jo once (one question, one issue) across repeated passes; a red main once per main-red issue until that issue
// closes; an unverifiable protection check once per episode across passes, needs-you wakes and train turnover; and a train's
// idle and held lines stay off needs-you while its lane's death shows. Temp ledgers, temp git checkouts with a fake GitHub
// origin, a fake gh and a fake launcher only (surface/test/train-world.ts).
import { describe, expect, test } from "bun:test";
import { LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { applyTrain, interpret } from "../src/input";
import { landFirstBody, landFirstInstructionBody, laneExitBody } from "../src/launch";
import { landFirstNoticeBody, TRAIN_ALERT_LABEL, TRAIN_ALERT_REPO, trainPrs, trainReconciledBody, trainSliceId } from "../src/merge-train";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger } from "./helpers";
import { boardWorld, checkout, H1, H2, protectedRules, REPO, TRAIN_LANE, world } from "./train-world";

const ISSUE = `https://github.com/${TRAIN_ALERT_REPO}/issues/1`;
/** What the line and row helpers read of a world: its ledger, and a boarding world's standing-workload rows by prefix. */
interface Seen {
	ledger: Ledger;
}
interface BoardSeen extends Seen {
	standing: (prefix: string) => string[];
}

describe("once per decision (D8, D9)", () => {
	// The production question itself is raised by the train lane in its session (trainBrief step 7c, lane_raise_question), not by
	// the tick: this pins the tick's half, that one open production question yields one issue and one needs-you line across
	// passes and that the tick never adds a question of its own (review wl-mvbjiettjrfpxc r1 #4).
	test("R6: a production-stakes merge reaches Jo once: the lane's one question gets one issue and one needs-you line across repeated passes, and the tick adds no question", () => {
		const w = world();
		for (let i = 0; i < 3; i++) {
			w.run();
			w.c.plusHours(0.5);
		}
		expect(w.ledger.questions(w.train)).toHaveLength(0);
		const sl = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 106), task: "PR #106", doneCondition: "terminal", inputs: "#106" });
		w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: sl, body: "#106 production: merge it?", options: ["merged", "skip", "stop"] });
		for (let i = 0; i < 5; i++) {
			w.run();
			w.c.plusHours(0.5);
		}
		expect(w.ledger.questions(w.train)).toHaveLength(1);
		expect(w.creates()).toHaveLength(1);
		expect(w.g.issues[0]).toMatchObject({ title: "merge train: #106 needs you (production merge)", labels: [TRAIN_ALERT_LABEL] });
		expect(errorLines(w.ledger).filter((l) => l.workloadId === w.train && l.kind === "question")).toHaveLength(1);
	});

	test("R7: a conflict the resolver cannot fix reaches Jo once, when the owner's attempt 2 settles failed, with the PR still a member after the owner's push", () => {
		const w = world();
		const members = () => trainPrs(w.ledger.entries(w.train), w.ledger.instructions(w.train));
		w.task(101, "conflict");
		w.c.plusHours(0.05);
		w.push(101, H1, "red");
		w.run();
		// attempt 1 failed: the owner hears, Jo does not
		expect(w.ledger.questions(w.train)).toHaveLength(0);
		expect(w.creates()).toHaveLength(0);
		expect(members()).toEqual([101, 106]);
		w.task(101, "conflict");
		w.c.plusHours(0.05);
		w.push(101, H2, "red");
		for (let i = 0; i < 4; i++) {
			w.run();
			w.c.plusHours(0.5);
		}
		const qs = w.ledger.questions(w.train);
		expect(qs).toHaveLength(1);
		expect(qs[0]).toMatchObject({ slice_id: trainSliceId(w.train, 101), created_by: MERGE_TRAIN_BY });
		expect(w.creates()).toHaveLength(1);
		expect(members()).toEqual([101, 106]);
	});
});

describe("red main (D7)", () => {
	const MAIN_RED = `https://github.com/${REPO}/issues/9`;
	/** The tick's main-red rows on the standing workload. */
	const rows = (w: Seen) =>
		w.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.created_by === MERGE_TRAIN_BY && e.body.startsWith("train-notice: main-red ")).map((e) => e.body);
	const lines = (w: Seen) => errorLines(w.ledger).filter((l) => l.kind === "train");

	test("R8: a red main reaches Jo once per main-red issue (one notice, one issue, one needs-you line) and clears when that issue closes", () => {
		const w = world();
		ensureStandingWorkload(w.ledger);
		w.g.repoIssues.set(9, "OPEN");
		w.ledger.recordEntry({ by: TRAIN_LANE, workloadId: w.train, kind: "assumption", body: `main-red: ${MAIN_RED} run tr-abc1` });
		w.run();
		w.run();
		expect(rows(w)).toEqual([`train-notice: main-red ${MAIN_RED} raised run tr-abc1`, `train-notice: main-red ${MAIN_RED} filed ${ISSUE}`]);
		expect(w.creates()).toHaveLength(1);
		expect(w.g.issues[0]).toMatchObject({ title: `merge train: main is red on ${REPO}`, labels: [TRAIN_ALERT_LABEL] });
		expect(lines(w)).toEqual([expect.objectContaining({ workloadId: STANDING_WORKLOAD_ID, line: expect.stringContaining(`main is red: ${MAIN_RED} (run tr-abc1)`) })]);
		// the same url on a later run, and a url that is no issue on the train's repository: nothing more reaches Jo
		w.ledger.recordEntry({ by: TRAIN_LANE, workloadId: w.train, kind: "assumption", body: `main-red: ${MAIN_RED} run tr-abc2` });
		w.ledger.recordEntry({ by: TRAIN_LANE, workloadId: w.train, kind: "assumption", body: "main-red: https://github.com/someone/else/issues/3 run tr-abc3" });
		const out = w.run();
		expect(out).toContainEqual(expect.stringContaining("main-red https://github.com/someone/else/issues/3"));
		expect(rows(w)).toHaveLength(2);
		expect(w.creates()).toHaveLength(1);
		expect(lines(w)).toHaveLength(1);
		// the main-red issue closes: cleared, the jo-issues issue closed, the line gone
		w.g.repoIssues.set(9, "CLOSED");
		w.run();
		w.run();
		expect(rows(w).slice(2)).toEqual([`train-notice: main-red ${MAIN_RED} cleared ${MAIN_RED} closed`]);
		expect(w.g.issues[0]!.state).toBe("CLOSED");
		expect(lines(w)).toEqual([]);
	});

	test("R8: a train closed within 24 h is still read for main-red; one closed longer ago is not", () => {
		const recent = world();
		ensureStandingWorkload(recent.ledger);
		recent.g.repoIssues.set(9, "OPEN");
		recent.ledger.recordEntry({ by: TRAIN_LANE, workloadId: recent.train, kind: "assumption", body: `main-red: ${MAIN_RED} run tr-abc1` });
		recent.ledger.releaseWorkload(recent.train, { by: TRAIN_LANE, holder: TRAIN_LANE });
		recent.ledger.closeWorkload(recent.train, { by: SURFACE_BY });
		recent.c.plusHours(23);
		recent.run();
		expect(rows(recent)[0]).toBe(`train-notice: main-red ${MAIN_RED} raised run tr-abc1`);
		const old = world();
		ensureStandingWorkload(old.ledger);
		old.ledger.recordEntry({ by: TRAIN_LANE, workloadId: old.train, kind: "assumption", body: `main-red: ${MAIN_RED} run tr-abc1` });
		old.ledger.releaseWorkload(old.train, { by: TRAIN_LANE, holder: TRAIN_LANE });
		old.ledger.closeWorkload(old.train, { by: SURFACE_BY });
		old.c.plusHours(25);
		old.run();
		expect(rows(old)).toEqual([]);
		expect(old.creates()).toHaveLength(0);
	});
});

describe("main's protection, named once per episode (D6)", () => {
	/** The tick's protection rows on the standing workload, each as `<state> <text>`. */
	const notices = (w: BoardSeen) => w.standing("train-notice: protection").map((b) => b.slice(`train-notice: protection ${REPO} `.length));
	const lines = (w: Seen) => errorLines(w.ledger).filter((l) => l.kind === "train");
	/** Train `train`'s lane works #`pr` to a terminal slice, exits released, and the train closes. */
	const turnOver = (w: Seen, train: string, pr: number) => {
		const holder = w.ledger.workload(train)!.holder!;
		const sl = w.ledger.addSlice({ by: holder, workloadId: train, id: trainSliceId(train, pr), task: `PR #${pr}`, doneCondition: "terminal", inputs: `#${pr}` });
		w.ledger.recordEntry({ by: holder, workloadId: train, kind: "assumption", body: `train-error: pr ${pr} protection unverified` });
		w.ledger.completeSlice(sl, { by: holder, artifact: "left: protection" });
		w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: train, kind: "assumption", body: laneExitBody(holder, { code: 0, signal: null, outcome: "released" }) });
		w.ledger.releaseWorkload(train, { by: holder, holder });
		w.ledger.closeWorkload(train, { by: SURFACE_BY });
	};

	test("R9: a gap is named once per episode across passes, needs-you wakes and train turnover; a changed text is a new gap row the same line shows, never a new issue", () => {
		const w = boardWorld();
		w.g.main.bypass = "always";
		w.landing(160);
		w.run();
		w.run();
		const gap = "merging account can bypass ruleset 1 (always)";
		expect(notices(w)).toEqual([`gap ${gap}`, `raised ${gap}`, `filed ${ISSUE}`]);
		expect(w.creates()).toHaveLength(1);
		expect(w.g.issues[0]!.body).toContain(gap);
		const first = lines(w);
		expect(first).toEqual([expect.objectContaining({ workloadId: STANDING_WORKLOAD_ID, line: expect.stringContaining(`protection on ${REPO} is unverified: ${gap}`) })]);
		// every wake renders the same line, keyed by the same raised row: it is delivered once
		expect(lines(w).map((l) => l.rowId)).toEqual([first[0]!.rowId]);
		// the text changes: a new gap row; the line shows it under the same key; no new issue
		w.g.main.rules = protectedRules(false);
		w.c.plusHours(0.5);
		w.run();
		const notStrict = "the rule requiring as2/full-suite on main is not strict (a branch need not be up to date)";
		expect(notices(w).slice(3)).toEqual([`gap ${notStrict}`]);
		expect(lines(w)).toEqual([expect.objectContaining({ rowId: first[0]!.rowId, line: expect.stringContaining(notStrict) })]);
		// train turnover: the train closes and the next landing opens another; the episode, its issue and its line stay one
		const train = w.boards()[0]!.train;
		turnOver(w, train, 160);
		w.landing(161);
		w.c.plusHours(0.5);
		w.run();
		w.run();
		const trains = new Set(w.boards().map((b) => b.train));
		expect(trains.size).toBe(2);
		expect(w.creates()).toHaveLength(1);
		expect(notices(w)).toHaveLength(4);
		expect(lines(w).map((l) => l.rowId)).toEqual([first[0]!.rowId]);
	});

	test("R9: a failed read is unknown, never a gap; it raises only once it is the newest read and 10 min old", () => {
		const w = boardWorld();
		w.g.main.rules = null;
		w.landing(162);
		w.run();
		expect(notices(w)).toEqual([expect.stringMatching(/^unknown gh api .*Not Found/)]);
		expect(w.creates()).toHaveLength(0);
		expect(lines(w)).toEqual([]);
		w.c.plusHours(0.1);
		w.run();
		expect(notices(w)).toHaveLength(1);
		expect(w.creates()).toHaveLength(0);
		w.c.plusHours(0.1);
		w.run();
		expect(notices(w).slice(1)).toEqual([expect.stringMatching(/^raised gh api .*Not Found/), `filed ${ISSUE}`]);
		expect(w.creates()).toHaveLength(1);
		expect(lines(w)).toHaveLength(1);
		w.run();
		expect(w.creates()).toHaveLength(1);
	});
});

describe("a train's own lines (D10)", () => {
	test("R12: a train's intended exit with open slices and its held line stay off needs-you; an ordinary workload's show; a train lane's death still shows", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const cmd = interpret(ledger, "train 101");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const train = applyTrain(ledger, cmd, checkout()).workloadId;
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the header", stakes: "normal", mode: "autonomous" });
		for (const wl of [train, other]) {
			expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: TRAIN_LANE, leaseMs: 600_000 }).won).toBe(true);
			ledger.addSlice({ by: TRAIN_LANE, workloadId: wl, task: "PR #101", doneCondition: "terminal", inputs: "#101" });
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(TRAIN_LANE, { code: 0, signal: null, outcome: "released" }) });
			ledger.releaseWorkload(wl, { by: TRAIN_LANE, holder: TRAIN_LANE });
		}
		c.plusHours(2);
		const kinds = (wl: string) => errorLines(ledger, undefined, { now: c.now(), holdHours: 1 }).filter((l) => l.workloadId === wl).map((l) => l.kind).sort();
		expect(kinds(other)).toEqual(["held", "idle"]);
		expect(kinds(train)).toEqual([]);
		ledger.enqueue({ by: TRAIN_LANE, workloadId: train, sender: TRAIN_LANE, recipient: "orchestrator", body: `lane-died: ${TRAIN_LANE} shutdown: SIGTERM` });
		expect(kinds(train)).toEqual(["lane-died"]);
	});
});

describe("land-first's render lines, from the ledger alone (PLAN wl-mvq4edbaf13vnk D8, R19)", () => {
	test("R19: a stale tick over 15 minutes while land-first is on, landing stopped with its reasons, and the verifier's refusal and schema wait", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		ensureStandingWorkload(ledger);
		const T = "2".repeat(40);
		const G = "1".repeat(40);
		const lines = () => errorLines(ledger).map((l) => l.line);
		const tickRow = (body: string) => ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		// land-first off: no stale line
		expect(lines().filter((l) => l.startsWith("train tick has not reconciled"))).toEqual([]);
		const id = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(REPO, true) });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(REPO, true, id) });
		expect(lines()).toContainEqual(expect.stringMatching(new RegExp(`^train tick has not reconciled main since land-first went on on ${REPO}`)));
		const reasons = "oldest suspect 2222222 landed 41 minutes ago, over 40";
		tickRow(landFirstNoticeBody(REPO, { event: "stop-raised", kind: "infrastructure", tip: T, g: G, suspects: [201], failing: null }));
		tickRow(trainReconciledBody({ repo: REPO, at: c.now(), tip: T, g: G, open: false, oldest: c.now(), repair: null, read: null, reasons }));
		expect(lines().filter((l) => l.startsWith("train tick has not reconciled"))).toEqual([]);
		expect(lines()).toContainEqual(`landing stopped at 2222222 on ${REPO}: ${reasons}; suspects #201; main run requested, no result yet`);
		c.plusHours(0.26);
		expect(lines()).toContainEqual(expect.stringMatching(new RegExp(`^train tick has not reconciled main since .* on ${REPO}`)));
		tickRow(landFirstNoticeBody("*", { event: "tick-refused", reason: "tracked files modified: x.ts" }));
		tickRow(landFirstNoticeBody(REPO, { event: "promote-schema", sha: "8".repeat(40), g: T, current: G, issue: null }));
		expect(lines()).toEqual(expect.arrayContaining([
			expect.stringMatching(/^verifier: the train tick refuses to run: tracked files modified: x\.ts/),
			expect.stringMatching(new RegExp(`^verifier: promotion waits on Jo: 8888888 on ${REPO} changes the ledger schema`)),
		]));
		expect(lines()).toContainEqual(expect.stringContaining(`verified target ${T} — stop the tick, migrate the live ledger through ${T}, run bun surface/scripts/promote-verified.ts ${T}, restart`));
		// Retained old notices must remain visible, but must not turn an untested barrier into a promotion command.
		tickRow(`train-notice: land-first ${REPO} promote-schema ${"8".repeat(40)} current ${G} issue none`);
		const legacy = lines().find((line) => line.startsWith("verifier: promotion waits on Jo:"))!;
		expect(legacy).toContain("verified target missing");
		expect(legacy).toContain("rerun the train tick");
		expect(legacy).not.toContain("promote-verified.ts");
		// a forged writer's copy renders nothing
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstNoticeBody(REPO, { event: "stop-cleared", why: "forged" }) });
		expect(lines()).toContainEqual(expect.stringMatching(/^landing stopped at 2222222/));
	});
});
