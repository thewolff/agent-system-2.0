// The alert sources (PLAN wl-mw0vs9uc3xqtka D2, R2-R7 and the quota-move source): for each source, the ledger or file
// state that raises its subject and each state that clears it, driven through the real ledger and Jo's real words
// (`interpret`/`apply`), with the clock, the pid probe and the reports dir injected. An urgent workload's subjects start
// at level 2; everything else at 1, except a quota move, which always starts at 2.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { CEILING_ALARM_KIND } from "../../gates/src/routine-switch";
import type { AlertSubject } from "../src/alert-path";
import {
	alertSources, ceilingSubjects, chaosSubjects, diedSubjects, fsReportFiles, mainRedSubjects, parkedSubjects, quotaMoveSubjects, releasedAliveSubjects,
	type SourceProblem, type SourceSeams, trainSubjects,
} from "../src/alert-sources";
import { ceilingQuestionBody } from "../src/ceiling";
import { nightlyFault } from "../src/chaos";
import { ensureStandingWorkload } from "../src/identity";
import { apply, interpret } from "../src/input";
import { laneExitBody, laneHeadroomBody, laneReleasedBody, laneStartedBody, prBindingInstructionBody } from "../src/launch";
import { landFirstNoticeBody, mainRedNoticeBody, trainBody, trainSliceId } from "../src/merge-train";
import type { PidState } from "../src/omp-probe";
import { recordQuotaMove } from "../src/quota-move-alert";
import { laneDiedShutdownBody, promptResolvedBody, promptWaitBody, recordLapsedLease } from "../src/signals";
import { MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const T0 = "2026-11-03T10:00:00.000Z";

/** A ledger on a fake clock, with the standing workload open (the surface opens it at start). */
function fixture() {
	const c = clock(T0);
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	return { ledger, c };
}

/** The fake probe's answers, per lane: what ps would say about its omp and its runner pid. */
type Pids = Record<string, { omp: PidState; runner: PidState }>;

function seams(c: { now: () => string }, over: Partial<SourceSeams> & { pids?: Pids } = {}): SourceSeams {
	const pids = over.pids ?? {};
	return {
		now: c.now(),
		urgent: () => false,
		alarmFile: join(tmp("alarm"), "alarm.jsonl"),
		reportsDir: join(tmp("reports"), "none"),
		files: fsReportFiles,
		probe: (_wl, laneId) => {
			const p = { failure: null as string | null, omp: (): PidState => pids[laneId]?.omp ?? "gone", runner: (): PidState => pids[laneId]?.runner ?? "gone" };
			if (pids[laneId]?.omp === "failed" || pids[laneId]?.runner === "failed") p.failure = "ps: operation not permitted";
			return p;
		},
		trainRepo: () => "thewolff/agent-system-2.0",
		popupAnsweredAt: () => null,
		...over,
	};
}

const keys = (subjects: readonly AlertSubject[]): string[] => subjects.map((s) => s.key);
const open = (ledger: Ledger) => ledger.inFlight();
const jo = (ledger: Ledger, text: string): string => {
	const cmd = interpret(ledger, text);
	if (cmd === null) throw new Error(`interpret refused "${text}"`);
	return apply(ledger, cmd);
};

// ---- 1. ceiling (R2) ----------------------------------------------------------------------------------------------

/** A normal workload at $50 / 6h, lane-t-1 launched on it, one open slice. */
function ceilingWorkload(ledger: Ledger): string {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "Move the offset", doneCondition: "bun test passes", inputs: "src/header.css" });
	return wl;
}

/** The runner's ceiling stop of lane-t-1 at $50.20: the spend, the accepted stop, and (once gone) its exit. */
function stopAtCeiling(ledger: Ledger, wl: string, o: { exited: boolean } = { exited: true }): void {
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 50.2 tokens 1000 wall 40" });
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 accepted ceiling" });
	if (o.exited) ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-t-1", { code: 0, signal: null, outcome: "stop", reason: "ceiling" }) });
}

describe("ceiling (D2.1, R2)", () => {
	test("a ceiling stop with no lane on it raises ceiling:<wl> at level 1 naming the spend and Jo's words; the accepted stop alone raises it too", () => {
		const { ledger, c } = fixture();
		const wl = ceilingWorkload(ledger);
		expect(ceilingSubjects(ledger, open(ledger), seams(c))).toEqual([]);
		stopAtCeiling(ledger, wl, { exited: false });
		const [s] = ceilingSubjects(ledger, open(ledger), seams(c));
		expect(s).toMatchObject({ key: `ceiling:${wl}`, kind: "ceiling", workloadId: wl, startLevel: 1, next: `extend ${wl}, or ceiling <usd> [<hours>] ${wl}` });
		expect(s!.title).toContain("$50.20 of $50");
		expect(s!.text).toContain("lane-t-1 stopped: lane-stop: lane-t-1 accepted ceiling");
		stopAtCeiling(ledger, wl);
		expect(keys(ceilingSubjects(ledger, open(ledger), seams(c)))).toEqual([`ceiling:${wl}`]);
	});

	test("an urgent workload's ceiling subject starts at level 2", () => {
		const { ledger, c } = fixture();
		const wl = ceilingWorkload(ledger);
		stopAtCeiling(ledger, wl);
		expect(ceilingSubjects(ledger, open(ledger), seams(c, { urgent: (w) => w === wl }))[0]!.startLevel).toBe(2);
		expect(ceilingSubjects(ledger, open(ledger), seams(c, { urgent: (w) => w === "wl-other" }))[0]!.startLevel).toBe(1);
	});

	test("Jo's ceiling word above the spend clears it, and so does extend", () => {
		for (const word of ["ceiling 100", "extend"]) {
			const { ledger, c } = fixture();
			const wl = ceilingWorkload(ledger);
			stopAtCeiling(ledger, wl);
			expect(keys(ceilingSubjects(ledger, open(ledger), seams(c)))).toEqual([`ceiling:${wl}`]);
			c.plusHours(0.01);
			jo(ledger, `${word} ${wl}`);
			expect(ceilingSubjects(ledger, open(ledger), seams(c))).toEqual([]);
		}
	});

	test("Jo's halt clears it; a stop answer clears it only when it answers the runner's ceiling question", () => {
		const halted = fixture();
		const wl = ceilingWorkload(halted.ledger);
		stopAtCeiling(halted.ledger, wl);
		halted.c.plusHours(0.01);
		jo(halted.ledger, `halt ${wl}`);
		expect(ceilingSubjects(halted.ledger, open(halted.ledger), seams(halted.c))).toEqual([]);

		const { ledger, c } = fixture();
		const w2 = ceilingWorkload(ledger);
		stopAtCeiling(ledger, w2);
		const sl = ledger.slices(w2)[0]!.id;
		c.plusHours(0.01);
		const other = ledger.raiseQuestion({ by: "lane-t-1", workloadId: w2, sliceId: sl, body: "Keep the token name?", options: ["stop", "keep"] });
		ledger.answerQuestion(other, { by: SURFACE_BY, answer: "stop", author: "jo", channel: "surface" });
		expect(keys(ceilingSubjects(ledger, open(ledger), seams(c)))).toEqual([`ceiling:${w2}`]);
		const spend = { usd: 50.2, tokens: 1000, wallMin: 40 };
		const q = ledger.raiseQuestion({
			by: LANE_RUNNER_BY, workloadId: w2, sliceId: sl, options: ["extend", "stop"],
			body: ceilingQuestionBody(`ceiling reached on ${w2}: spend at the ceiling`, w2, spend, { usd: 50, wallMin: 360 }, "normal", null),
		});
		c.plusHours(0.01);
		ledger.answerQuestion(q, { by: SURFACE_BY, answer: "stop", author: "jo", channel: "surface" });
		expect(ceilingSubjects(ledger, open(ledger), seams(c))).toEqual([]);
	});

	test("a lane holding it live clears it; once that lane's lease lapses with the stop still the newest lifecycle entry, it is back", () => {
		const { ledger, c } = fixture();
		const wl = ceilingWorkload(ledger);
		stopAtCeiling(ledger, wl);
		ledger.claimWorkload(wl, { by: "lane-t-2", holder: "lane-t-2", leaseMs: 60_000 });
		expect(ceilingSubjects(ledger, open(ledger), seams(c))).toEqual([]);
		c.plusHours(1);
		expect(keys(ceilingSubjects(ledger, open(ledger), seams(c)))).toEqual([`ceiling:${wl}`]);
	});

	test("a newer lifecycle entry than the stop (a later lane started) is no ceiling stop, though the spend is still at the ceiling; close clears it", () => {
		const { ledger, c } = fixture();
		const wl = ceilingWorkload(ledger);
		stopAtCeiling(ledger, wl);
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody("lane-t-2", { pid: 501, start: "Tue Nov  3 10:00:00 2026", session: null, argv: [], runnerPid: 500 }) });
		expect(ceilingSubjects(ledger, open(ledger), seams(c))).toEqual([]);

		const closed = fixture();
		const w2 = ceilingWorkload(closed.ledger);
		stopAtCeiling(closed.ledger, w2);
		closed.ledger.cancelSlice(closed.ledger.slices(w2)[0]!.id, { by: "lane-t-1" });
		closed.ledger.closeWorkload(w2, { by: SURFACE_BY });
		expect(ceilingSubjects(closed.ledger, open(closed.ledger), seams(closed.c))).toEqual([]);
	});

	test("an uncleared CEILING ALARM line raises it with no stop in the ledger; Jo's ceiling word after the line clears it", () => {
		const { ledger, c } = fixture();
		const wl = ceilingWorkload(ledger);
		const alarmFile = join(tmp("alarm"), "alarm.jsonl");
		writeFileSync(alarmFile, `${JSON.stringify({ kind: CEILING_ALARM_KIND, at: T0, workload: wl, error: "ledger write failed: SQLITE_BUSY" })}\n`);
		c.plusHours(0.01);
		const [s] = ceilingSubjects(ledger, open(ledger), seams(c, { alarmFile }));
		expect(s).toMatchObject({ key: `ceiling:${wl}`, startLevel: 1 });
		expect(s!.text).toContain("SQLITE_BUSY");
		jo(ledger, `ceiling 100 ${wl}`);
		expect(ceilingSubjects(ledger, open(ledger), seams(c, { alarmFile }))).toEqual([]);
	});
});

// ---- 2. died (R3) -------------------------------------------------------------------------------------------------

/** A workload lane-a held, with one open slice, its lane released and dead (`lane-died:` at session shutdown). */
function deadLane(ledger: Ledger): { wl: string; sl: string } {
	const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move the header offset", doneCondition: "bun test passes", inputs: "src/header.css" });
	ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 });
	ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
	ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-a", ledger.now(), 1) });
	return { wl, sl };
}

describe("died (D2.2, R3)", () => {
	test("a death with an open slice raises died:<wl>; with no open or paused slice it does not", () => {
		const { ledger, c } = fixture();
		const { wl, sl } = deadLane(ledger);
		const [s] = diedSubjects(ledger, open(ledger), seams(c));
		expect(s).toMatchObject({ key: `died:${wl}`, kind: "died", workloadId: wl, startLevel: 1, next: `relaunch ${wl}, close it, or instruct` });
		expect(s!.text).toContain("lane lane-a died: session shutdown at");
		ledger.completeSlice(sl, { by: "lane-a", artifact: "bun test → 0" });
		expect(diedSubjects(ledger, open(ledger), seams(c))).toEqual([]);
	});

	test("a paused slice keeps it raised (a question pauses the slice); an urgent workload starts at 2", () => {
		const { ledger, c } = fixture();
		const { wl, sl } = deadLane(ledger);
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token?", options: ["a", "b"] });
		expect(ledger.workload(wl)!.paused_slices).toBe(1);
		expect(diedSubjects(ledger, open(ledger), seams(c, { urgent: () => true }))).toMatchObject([{ key: `died:${wl}`, startLevel: 2 }]);
	});

	test("a lane holding it live clears it, and so does a later launch (the ledger refuses to close a workload with open slices, so close is the no-slice case)", () => {
		const held = fixture();
		const a = deadLane(held.ledger);
		held.ledger.claimWorkload(a.wl, { by: "lane-b", holder: "lane-b", leaseMs: 60_000 });
		expect(diedSubjects(held.ledger, open(held.ledger), seams(held.c))).toEqual([]);

		const relaunched = fixture();
		const b = deadLane(relaunched.ledger);
		relaunched.c.plusHours(0.01);
		relaunched.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: b.wl, kind: "assumption", body: "launch: lane-b cause relaunch requested-by test" });
		expect(diedSubjects(relaunched.ledger, open(relaunched.ledger), seams(relaunched.c))).toEqual([]);
	});

	test("a lapsed lease is a death before any lane-died row records it, and the same one key after", () => {
		const { ledger, c } = fixture();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "user-driven" });
		ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move it", doneCondition: "d", inputs: "i" });
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 });
		expect(diedSubjects(ledger, open(ledger), seams(c))).toEqual([]);
		c.plusHours(0.1);
		const [before] = diedSubjects(ledger, open(ledger), seams(c));
		expect(before).toMatchObject({ key: `died:${wl}`, next: `continue it by hand (as2 lane ${wl}), close it, or instruct` });
		expect(before!.text).toContain("lease lapsed");
		recordLapsedLease(ledger, open(ledger).find((x) => x.workload.id === wl)!.workload, SURFACE_BY, c.now());
		expect(keys(diedSubjects(ledger, open(ledger), seams(c)))).toEqual([`died:${wl}`]);
	});
});

// ---- 3. released-alive (R4) ---------------------------------------------------------------------------------------

/** lane-t-1 started by the runner (omp 4242, runner 4241), held the workload, and released it through `lane_release`'s record. */
function releasedLane(ledger: Ledger): string {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody("lane-t-1", { pid: 4242, start: "Tue Nov  3 09:59:00 2026", session: null, argv: [], runnerPid: 4241 }) });
	ledger.claimWorkload(wl, { by: "lane-t-1", holder: "lane-t-1", leaseMs: 60_000 });
	ledger.write(() => {
		ledger.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: laneReleasedBody("lane-t-1") });
	});
	return wl;
}

describe("released-alive (D2.3, R4)", () => {
	test("a released lane whose omp is alive is a subject only from 5 minutes after its lane-released entry", () => {
		// The 5 minute grace is the subject: the injected fake clock (helpers.ts `clock`) sets the pass's `now`; nothing waits.
		const { ledger, c } = fixture();
		const wl = releasedLane(ledger);
		const pids: Pids = { "lane-t-1": { omp: "same", runner: "gone" } };
		c.at("2026-11-03T10:04:59.999Z");
		expect(releasedAliveSubjects(ledger, seams(c, { pids }), [])).toEqual([]);
		c.at("2026-11-03T10:05:00.000Z");
		const [s] = releasedAliveSubjects(ledger, seams(c, { pids }), []);
		expect(s).toMatchObject({ key: "lane:lane-t-1", kind: "released-alive", workloadId: wl, startLevel: 1 });
		expect(s!.text).toContain("omp pid 4242 is alive");
	});

	test("the runner alone alive counts too; both pids gone, or a lane-exit, clears it", () => {
		const { ledger, c } = fixture();
		const wl = releasedLane(ledger);
		c.plusHours(1);
		expect(releasedAliveSubjects(ledger, seams(c, { pids: { "lane-t-1": { omp: "gone", runner: "same" } } }), [])[0]!.text).toContain("runner pid 4241 is alive");
		expect(releasedAliveSubjects(ledger, seams(c, { pids: { "lane-t-1": { omp: "other", runner: "gone" } } }), [])).toEqual([]);
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-t-1", { code: 0, signal: null, outcome: "released", reason: null }) });
		expect(releasedAliveSubjects(ledger, seams(c, { pids: { "lane-t-1": { omp: "same", runner: "same" } } }), [])).toEqual([]);
	});

	test("ps refusing to answer is a problem naming the lane and the pid, not a subject; an urgent workload starts at 2", () => {
		const { ledger, c } = fixture();
		const wl = releasedLane(ledger);
		c.plusHours(1);
		const problems: SourceProblem[] = [];
		expect(releasedAliveSubjects(ledger, seams(c, { pids: { "lane-t-1": { omp: "failed", runner: "gone" } } }), problems)).toEqual([]);
		expect(problems).toHaveLength(1);
		expect(problems[0]!.error).toContain(`lane-t-1 on ${wl}: ps could not answer for its omp pid 4242 (ps: operation not permitted)`);
		expect(releasedAliveSubjects(ledger, seams(c, { urgent: () => true, pids: { "lane-t-1": { omp: "same", runner: "gone" } } }), [])[0]!.startLevel).toBe(2);
	});

	test("a lane with no lane-released entry is not seen however alive it is; a look-alike entry by another writer is not one", () => {
		const { ledger, c } = fixture();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix it", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody("lane-t-1", { pid: 4242, start: "x", session: null, argv: [], runnerPid: 4241 }) });
		ledger.recordEntry({ by: "lane-t-9", workloadId: wl, kind: "assumption", body: laneReleasedBody("lane-t-1") });
		c.plusHours(1);
		expect(releasedAliveSubjects(ledger, seams(c, { pids: { "lane-t-1": { omp: "same", runner: "same" } } }), [])).toEqual([]);
	});
});

// ---- 4. main-red (R5) ---------------------------------------------------------------------------------------------

const REPO = "thewolff/agent-system-2.0";
const TIP = "a".repeat(40);
const notice = (ledger: Ledger, body: string) => ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });

describe("main-red (D2.4, R5)", () => {
	test("an open regression or infrastructure stop raises main:<repo> until stop-cleared; a depth stop stays quiet", () => {
		for (const kind of ["regression", "infrastructure"] as const) {
			const { ledger, c } = fixture();
			notice(ledger, landFirstNoticeBody(REPO, { event: "stop-raised", kind, tip: TIP, g: null, suspects: [41], failing: 3 }));
			const [s] = mainRedSubjects(ledger, seams(c), []);
			expect(s).toMatchObject({ key: `main:${REPO}`, kind: "main-red", workloadId: null, startLevel: 1, title: `landing stopped on ${REPO}` });
			expect(s!.text).toContain(REPO);
			notice(ledger, landFirstNoticeBody(REPO, { event: "stop-cleared", why: "main green at the tip" }));
			expect(mainRedSubjects(ledger, seams(c), [])).toEqual([]);
		}
		const { ledger, c } = fixture();
		notice(ledger, landFirstNoticeBody(REPO, { event: "stop-raised", kind: "depth", tip: TIP, g: null, suspects: [], failing: null }));
		expect(mainRedSubjects(ledger, seams(c), [])).toEqual([]);
	});

	test("an uncleared main-red notice raises it until cleared; a stop and a notice on one repository are one key", () => {
		const { ledger, c } = fixture();
		const url = `https://github.com/${REPO}/issues/77`;
		notice(ledger, mainRedNoticeBody(url, "raised", "run 123"));
		const [s] = mainRedSubjects(ledger, seams(c), []);
		expect(s).toMatchObject({ key: `main:${REPO}`, title: `main is red on ${REPO}` });
		expect(s!.text).toContain(url);
		notice(ledger, landFirstNoticeBody(REPO, { event: "stop-raised", kind: "regression", tip: TIP, g: null, suspects: [41], failing: 3 }));
		expect(keys(mainRedSubjects(ledger, seams(c), []))).toEqual([`main:${REPO}`]);
		notice(ledger, landFirstNoticeBody(REPO, { event: "stop-cleared", why: "green" }));
		notice(ledger, mainRedNoticeBody(url, "cleared", "closed"));
		expect(mainRedSubjects(ledger, seams(c), [])).toEqual([]);
	});

	test("a notice row by another writer is not a notice", () => {
		const { ledger, c } = fixture();
		ledger.recordEntry({ by: "lane-x", workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: mainRedNoticeBody(`https://github.com/${REPO}/issues/1`, "raised", "run 1") });
		expect(mainRedSubjects(ledger, seams(c), [])).toEqual([]);
	});
});

// ---- 5. chaos (R6) ------------------------------------------------------------------------------------------------

function reports(files: Record<string, string>): string {
	const dir = join(tmp("chaos"), "reports");
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}
const nightly = (date: string) => `${date}-${nightlyFault(date)}.md`;
const report = (date: string, verdict: string) => `# chaos ${nightlyFault(date)}: ${verdict}\n\n- verdict: **${verdict}** — the lane did not resume\n`;

describe("chaos (D2.5, R6)", () => {
	test("the newest nightly FAIL or HARNESS-ERROR raises chaos:<report>; a newer nightly PASS clears it", () => {
		const { c } = fixture();
		for (const verdict of ["FAIL", "HARNESS-ERROR"]) {
			const dir = reports({ [nightly("2026-11-01")]: report("2026-11-01", "PASS"), [nightly("2026-11-02")]: report("2026-11-02", verdict) });
			const [s] = chaosSubjects(seams(c, { reportsDir: dir }), []);
			expect(s).toMatchObject({ key: `chaos:${nightly("2026-11-02")}`, kind: "chaos", workloadId: null, startLevel: 1, title: `nightly chaos ${nightlyFault("2026-11-02")}: ${verdict}` });
			expect(s!.text).toContain("the lane did not resume");
		}
		const dir = reports({ [nightly("2026-11-02")]: report("2026-11-02", "FAIL"), [nightly("2026-11-03")]: report("2026-11-03", "PASS") });
		expect(chaosSubjects(seams(c, { reportsDir: dir }), [])).toEqual([]);
	});

	test("a newer report that is no nightly (another fault on that date) neither raises nor clears; no reports dir is no subject", () => {
		const { c } = fixture();
		const dir = reports({ [nightly("2026-11-02")]: report("2026-11-02", "FAIL"), "2026-11-03-manual-probe.md": "# chaos manual-probe: PASS\n" });
		expect(keys(chaosSubjects(seams(c, { reportsDir: dir }), []))).toEqual([`chaos:${nightly("2026-11-02")}`]);
		expect(chaosSubjects(seams(c, { reportsDir: join(tmp("chaos"), "missing") }), [])).toEqual([]);
	});

	test("a newest nightly whose heading does not parse is a problem naming the file, not a silent pass", () => {
		const { c } = fixture();
		const dir = reports({ [nightly("2026-11-02")]: "half a report\n" });
		const problems: SourceProblem[] = [];
		expect(chaosSubjects(seams(c, { reportsDir: dir }), problems)).toEqual([]);
		expect(problems[0]!.error).toContain(join(dir, nightly("2026-11-02")));
	});
});

// ---- 6. parked, 7. train (R7) -------------------------------------------------------------------------------------

/** Workload `wl` made a merge train on PR 12 (Jo's `train` instruction and the surface's `train:` entry). */
function makeTrain(ledger: Ledger, wl: string): void {
	const ins = ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: prBindingInstructionBody("train", wl, [12]), author: "jo", channel: "surface" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: trainBody([12], ins) });
}

describe("parked (D2.6) and train (D2.7), R7", () => {
	test("a non-train open question, a waiting reserved request and an open prompt wait are one parked:<wl>; each clears on its answer", () => {
		const { ledger, c } = fixture();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the header", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move it", doneCondition: "d", inputs: "i" });
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		expect(parkedSubjects(ledger, open(ledger), seams(c))).toEqual([]);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token name?", options: ["short", "long"] });
		const r = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main (P-11 row 6 refused tool call c1)" });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("ask", "call-1", "s-1", "which branch?") });
		const [s] = parkedSubjects(ledger, open(ledger), seams(c));
		expect(s).toMatchObject({ key: `parked:${wl}`, kind: "parked", workloadId: wl, startLevel: 1, title: `${wl} is waiting on you (3 items)` });
		expect(s!.next).toBe(`approve ${r} or deny ${r}; answer lane-a's prompt in its session or end the session; answer ${q}: short / long`);
		ledger.answerQuestion(q, { by: SURFACE_BY, answer: "short", author: "jo", channel: "surface" });
		ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `deny ${r}`, author: "jo", channel: "surface" });
		expect(parkedSubjects(ledger, open(ledger), seams(c))[0]!.title).toBe(`${wl} is waiting on you (1 item)`);
		ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptResolvedBody("ask", "call-1", "s-1", "answered") });
		expect(parkedSubjects(ledger, open(ledger), seams(c))).toEqual([]);
	});

	test("an urgent workload's parked subject starts at level 2", () => {
		const { ledger, c } = fixture();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the header", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move it", doneCondition: "d", inputs: "i" });
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["a", "b"] });
		expect(parkedSubjects(ledger, open(ledger), seams(c, { urgent: (w) => w === wl }))[0]!.startLevel).toBe(2);
	});

	test("on a train every open question is its own q:<id> (PR slice or not) and never parked; the train's reserved request is its parked key", () => {
		const { ledger, c } = fixture();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "merge train", stakes: "normal", mode: "autonomous" });
		makeTrain(ledger, wl);
		const prSlice = ledger.addSlice({ by: MERGE_TRAIN_BY, workloadId: wl, id: trainSliceId(wl, 12), task: "PR 12", doneCondition: "d", inputs: "i" });
		const other = ledger.addSlice({ by: MERGE_TRAIN_BY, workloadId: wl, task: "meter", doneCondition: "d", inputs: "i" });
		const q1 = ledger.raiseQuestion({ by: MERGE_TRAIN_BY, workloadId: wl, sliceId: prSlice, body: "#12 failed twice", options: ["retry", "drop"] });
		const q2 = ledger.raiseQuestion({ by: MERGE_TRAIN_BY, workloadId: wl, sliceId: other, body: "The meter failed", options: ["ack", "stop"] });
		const subjects = trainSubjects(ledger, open(ledger), seams(c));
		expect(keys(subjects).sort()).toEqual([`q:${q1}`, `q:${q2}`].sort());
		const pr = subjects.find((s) => s.key === `q:${q1}`)!;
		expect(pr).toMatchObject({ kind: "train", workloadId: wl, startLevel: 1, title: "merge train: #12 needs you (failed twice)", next: `answer ${q1} with one word: retry / drop` });
		expect(pr.text).toContain(`https://github.com/${REPO}/pull/12`);
		expect(subjects.find((s) => s.key === `q:${q2}`)!.title).toBe(`merge train ${wl}: question ${q2} needs you (stall)`);
		expect(parkedSubjects(ledger, open(ledger), seams(c))).toEqual([]);
		ledger.recordEntry({ by: "lane-tr", workloadId: wl, kind: "reserved-request", body: "push main" });
		expect(keys(parkedSubjects(ledger, open(ledger), seams(c)))).toEqual([`parked:${wl}`]);
		ledger.answerQuestion(q1, { by: SURFACE_BY, answer: "retry", author: "jo", channel: "surface" });
		expect(keys(trainSubjects(ledger, open(ledger), seams(c)))).toEqual([`q:${q2}`]);
	});
});

// ---- 8. quota-move ------------------------------------------------------------------------------------------------

describe("quota-move (D2.8)", () => {
	const A = "anthropic/claude-opus-4-5";
	const SOL = "openai-codex/gpt-6-sol";
	const move = (ledger: Ledger, wl: string) =>
		recordQuotaMove(ledger, { workloadId: wl, laneId: "lane-a-1", kind: "lane", from: A, to: SOL, reason: "5h window at 97 %", by: LANE_RUNNER_BY, eventBody: laneHeadroomBody("lane-a-1", A, SOL, "5h window at 97 %") });

	test("every move starts at level 2 and stays until 24 h after its popup was answered", () => {
		// The 24 h keep is the subject: the injected fake clock (helpers.ts `clock`) sets the pass's `now`; nothing waits.
		const { ledger, c } = fixture();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix it", stakes: "normal", mode: "autonomous" });
		const e = move(ledger, wl);
		const [s] = quotaMoveSubjects(ledger, seams(c));
		expect(s).toMatchObject({ key: `move:${e}`, kind: "quota-move", workloadId: wl, startLevel: 2 });
		expect(s!.text).toContain(`lane lane-a-1 on ${wl} moved ${A} -> ${SOL}`);
		const answered = (key: string) => (key === `move:${e}` ? "2026-11-03T11:00:00.000Z" : null);
		c.at("2026-11-04T10:59:59.999Z");
		expect(keys(quotaMoveSubjects(ledger, seams(c, { popupAnsweredAt: answered })))).toEqual([`move:${e}`]);
		c.at("2026-11-04T11:00:00.000Z");
		expect(quotaMoveSubjects(ledger, seams(c, { popupAnsweredAt: answered }))).toEqual([]);
		expect(keys(quotaMoveSubjects(ledger, seams(c)))).toEqual([`move:${e}`]);
	});

	test("a legacy popup answer (`quota-move-alert: <E> popup ok`) counts as the answer", () => {
		const { ledger, c } = fixture();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix it", stakes: "normal", mode: "autonomous" });
		const e = move(ledger, wl);
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `quota-move-alert: ${e} popup ok OK` });
		c.plusHours(23.9);
		expect(keys(quotaMoveSubjects(ledger, seams(c)))).toEqual([`move:${e}`]);
		c.plusHours(0.2);
		expect(quotaMoveSubjects(ledger, seams(c))).toEqual([]);
	});
});

// ---- all ----------------------------------------------------------------------------------------------------------

describe("alertSources", () => {
	test("runs every source; one that throws is one problem naming it, and the others' subjects still count", () => {
		const { ledger, c } = fixture();
		const wl = ceilingWorkload(ledger);
		stopAtCeiling(ledger, wl);
		const broken: SourceSeams["files"] = { list: () => { throw new Error("EACCES: permission denied, scandir '/reports'"); }, read: () => "" };
		const { subjects, problems } = alertSources(ledger, seams(c, { files: broken }));
		expect(keys(subjects)).toEqual([`ceiling:${wl}`]);
		expect(problems).toEqual([{ source: "chaos", error: "the chaos source failed: EACCES: permission denied, scandir '/reports'" }]);
	});
});
