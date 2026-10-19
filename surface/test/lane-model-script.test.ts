// Jo's named model through the real runner against the fake omp (MIGRATION.md item 85; PLAN
// wl-mv45mh3byhixog v3 T1–T8): `--model` in the argv and kept across relaunches, a fresh session when
// the recorded one ran on another model, the get_state barrier that fails the launch closed before any
// prompt, `lane-ready:` written only just before the first prompt (so `builderLabs` can tell a lane
// that never got one), and omp's prompt error in the death line. The pure rows are in
// lane-model.test.ts; these spawn processes, so they run in the full suite outside the fence.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builderLabs } from "../../classifier/src/lab";
import { LANE_RUNNER_BY, Ledger, type QuestionRow } from "../../ledger/src/index";
import { ceilingBody } from "../src/ceiling";
import { recordRepo } from "../src/decision-log";
import { doneBody, exitClass, laneExit, laneModelBody, laneStarted, verdictOf } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { alive, drainSettled, type FakeScript, type FakeStep, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, until } from "./helpers";

const A = "anthropic/claude-opus-5-5";
const X = "openai-codex/gpt-6-sol";
const DONE: FakeStep[] = [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }];

const roots: LaneRoot[] = [];
// A root is removed only after settleDrains is done with it (every runner's drain, MIGRATION.md item 71, and every lane
// a drain launched has ended); the failure is thrown only after the removal.
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);
const makeRoot = (): LaneRoot => {
	const r = laneRoot();
	roots.push(r);
	return r;
};
const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
/** Write surface rows on the workload the way the tools do. */
function surfaceWrite(r: LaneRoot, wl: string, bodies: string[]): void {
	const l = ledgerOf(r);
	try {
		for (const body of bodies) l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body });
	} finally {
		l.close();
	}
}
/** An autonomous workload with its done: line and one open slice, and Jo's `lane-model:` when `model` is given. */
function openWorkload(r: LaneRoot, model: string | null): { wl: string; sl: string } {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "lane model probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		if (model !== null) l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody(model, l.now()) });
		const sl = l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "probe", doneCondition: "probed", inputs: "README.md" });
		return { wl, sl };
	} finally {
		l.close();
	}
}
const request = (r: LaneRoot, wl: string, model?: string) => {
	const l = ledgerOf(r);
	const now = l.now();
	l.close();
	surfaceWrite(r, wl, [...(model !== undefined ? [laneModelBody(model, now)] : []), `launch-requested: by jo at ${now}`]);
};
/**
 * No open slice at the death: the machinery's relaunch of a dead lane (PLAN wl-mvfqvd5hy8zv28 § 1.3) owes the workload
 * nothing, so the launch after the death is Jo's alone. These tests prove Jo's relaunch's model and session; the
 * automatic relaunch's cause is lane-script.test.ts's.
 */
const noOpenSlice = (r: LaneRoot, sl: string) => {
	const l = ledgerOf(r);
	l.cancelSlice(sl, { by: SURFACE_BY });
	l.close();
};
const launch = (r: LaneRoot, wl: string, script: FakeScript, by = "test") => {
	setScript(r, script);
	const out = sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", by], r.repo, r.env);
	expect(out.code).toBe(0);
};
const exitOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId));
/**
 * The lane's lane-exit:, once the drain its runner spawned has read the ledger and gone: a request or an answer written
 * after this is the next launch's to take, never the drain's (else the test's own launch races it and exits 7 held).
 */
const settledExit = async (r: LaneRoot, wl: string, laneId: string) => {
	const exit = await exitOf(r, wl, laneId);
	await drainSettled(r, laneId);
	return exit;
};
/** The n-th (1-based) fake omp spawn's record: argv, pid, session. */
const spawnRecord = (r: LaneRoot, n: number) => fakeRecords(r).filter((x) => x.argv !== undefined)[n - 1]!;
const eventsOf = (r: LaneRoot, pid: number) => fakeRecords(r).filter((x) => x.pid === pid && x.event).map((x) => x.event!);
const startsOf = (r: LaneRoot, wl: string, laneId: string) =>
	laneSnapshot(r, wl).control.filter((c) => c.prefix === "lane-started" && c.laneId === laneId)
		.map((c) => ({ by: c.createdBy, ...(JSON.parse(c.rest) as { session: string | null; model?: string | null; ranModel?: string | null; resumeSkipped?: string | null }) }));
const readyLines = (r: LaneRoot, wl: string, laneId: string) => laneSnapshot(r, wl).control.filter((c) => c.prefix === "lane-ready" && c.laneId === laneId);
const unknownOf = (r: LaneRoot, wl: string) => {
	const l = ledgerOf(r);
	try {
		return builderLabs(l, wl).unknown;
	} finally {
		l.close();
	}
};

describe("T1–T3: the runner starts on Jo's model and keeps the session only on it", () => {
	test("T1p: --model in the argv; lane-started: records model and ranModel; still two starts, ready, then the prompt", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, X);
		launch(r, wl, { steps: DONE });
		const lane1 = laneIdOf(wl, 1);
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		const rec = spawnRecord(r, 1);
		expect(rec.argv!.slice(-2)).toEqual(["--model", X]);
		const starts = startsOf(r, wl, lane1);
		expect(starts.map((s) => s.by)).toEqual([LANE_RUNNER_BY, LANE_RUNNER_BY]);
		expect(starts[0]).toMatchObject({ model: X, ranModel: null, resumeSkipped: null });
		expect(starts[1]).toMatchObject({ model: X, ranModel: X, resumeSkipped: null });
		const order = laneSnapshot(r, wl).control.filter((c) => c.laneId === lane1 && c.prefix !== "ctx-index").map((c) => c.prefix);
		expect(order).toEqual(["launch", "lane-started", "lane-started", "lane-ready", "lane-decided", "spend", "lane-exit"]);
		expect(eventsOf(r, rec.pid)).toEqual(["prompt", "eof"]);
	}, 60_000);

	test("T2p: after a death a relaunch with no model keeps --model and resumes the session on it", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, X);
		noOpenSlice(r, sl);
		launch(r, wl, { steps: [{ exit: 3 }] });
		const lane1 = laneIdOf(wl, 1);
		expect(await settledExit(r, wl, lane1)).toMatchObject({ outcome: "died" });
		const session1 = laneStarted(laneSnapshot(r, wl).control, lane1)!.session!;
		request(r, wl);
		launch(r, wl, { steps: DONE }, "jo");
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "completed" });
		expect(spawnRecord(r, 2).argv!.slice(-4)).toEqual(["--model", X, "--resume", session1]);
		expect(startsOf(r, wl, lane2).at(-1)).toMatchObject({ model: X, ranModel: X, resumeSkipped: null });
	}, 60_000);

	test("T2p: the tick's resume after Jo's answer keeps --model and the parked session", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, X);
		launch(r, wl, { steps: [{ tool: "lane_raise_question", args: { slice: sl, body: "push now?", options: ["yes", "no"] } }] });
		const lane1 = laneIdOf(wl, 1);
		expect(await settledExit(r, wl, lane1)).toMatchObject({ outcome: "parked" });
		const session1 = spawnRecord(r, 1).session!;
		const l = ledgerOf(r);
		l.answerQuestion(laneSnapshot(r, wl).questions[0]!.id, { by: SURFACE_BY, answer: "yes", author: "jo", channel: "surface" });
		l.close();
		launch(r, wl, { steps: [{ tool: "lane_complete_slice", args: { slice: sl, artifact: "done" } }, ...DONE] }, "tick");
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "completed" });
		expect(spawnRecord(r, 2).argv!.slice(-4)).toEqual(["--model", X, "--resume", session1]);
	}, 60_000);

	test("T2p: the tick's catch-up of Jo's request after a death keeps --model and resumes the session on it", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, X);
		noOpenSlice(r, sl);
		launch(r, wl, { steps: [{ exit: 3 }] });
		const lane1 = laneIdOf(wl, 1);
		expect(await settledExit(r, wl, lane1)).toMatchObject({ outcome: "died" });
		const session1 = laneStarted(laneSnapshot(r, wl).control, lane1)!.session!;
		// Jo's request with no model lands without a launch (the surface's exec did not run it): the tick's predicate finds it launchable.
		request(r, wl);
		const l = ledgerOf(r);
		const verdict = verdictOf(l.launchRows(wl, 3)!);
		l.close();
		expect(verdict).toMatchObject({ launch: true, cause: { kind: "request" } });
		launch(r, wl, { steps: DONE }, "tick");
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "completed" });
		const launched = laneSnapshot(r, wl).control.find((c) => c.prefix === "launch" && c.laneId === lane2)!;
		expect(launched.rest).toMatch(/^cause request \S+ requested-by tick$/);
		expect(spawnRecord(r, 2).argv!.slice(-4)).toEqual(["--model", X, "--resume", session1]);
		expect(startsOf(r, wl, lane2).at(-1)).toMatchObject({ model: X, ranModel: X, resumeSkipped: null });
	}, 60_000);

	test("T3p: a relaunch naming another model starts fresh: --model, no --resume, resumeSkipped names the old session", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, null);
		noOpenSlice(r, sl);
		launch(r, wl, { steps: [{ exit: 3 }] });
		const lane1 = laneIdOf(wl, 1);
		await settledExit(r, wl, lane1);
		const session1 = laneStarted(laneSnapshot(r, wl).control, lane1)!.session!;
		expect(spawnRecord(r, 1).argv).not.toContain("--model");
		request(r, wl, X);
		launch(r, wl, { steps: DONE }, "jo");
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "completed" });
		const argv = spawnRecord(r, 2).argv!;
		expect(argv.slice(-2)).toEqual(["--model", X]);
		expect(argv).not.toContain("--resume");
		expect(startsOf(r, wl, lane2).at(-1)).toMatchObject({ model: X, ranModel: X, resumeSkipped: `${session1} ran on default` });
	}, 60_000);
});

describe("T4: a named model OMP does not report fails the launch before any prompt", () => {
	/** The never-ready shape every model failure shares: no prompt, no lane-ready:, one launch-failed: at model, one lane-died:, released. */
	async function expectModelFailure(r: LaneRoot, wl: string, reason: string) {
		const lane1 = laneIdOf(wl, 1);
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "never-ready" });
		const snap = laneSnapshot(r, wl);
		expect(eventsOf(r, spawnRecord(r, 1).pid)).not.toContain("prompt");
		expect(readyLines(r, wl, lane1)).toEqual([]);
		const failed = snap.control.filter((c) => c.prefix === "launch-failed");
		expect(failed.map((c) => c.laneId)).toEqual([lane1]);
		expect(failed[0]!.rest).toStartWith(`model: ${reason} (omp exit code`);
		expect(snap.deaths).toEqual([`lane-died: ${lane1}: launch failed at model: ${reason}`]);
		expect(snap.workload!.holder).toBeNull();
		expect(unknownOf(r, wl).some((u) => u.includes(lane1))).toBe(false);
	}

	test("T4p: get_state answers late with another model: the claim alone sends nothing", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, X);
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" }, stateDelayMs: 1500 });
		await expectModelFailure(r, wl, `named ${X}, omp started ${A}`);
	}, 60_000);

	test("T4b-p: no model in get_state", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, X);
		launch(r, wl, { steps: DONE, stateModel: null });
		await expectModelFailure(r, wl, `named ${X}, get_state reported no provider/id model`);
	}, 60_000);

	test("T4b-p: get_state fails", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, X);
		launch(r, wl, { steps: DONE, stateFail: true });
		await expectModelFailure(r, wl, `named ${X}, get_state failed: fake get_state failure`);
	}, 60_000);

	test("T4b-p: no get_state answer within the readiness window", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, X);
		launch(r, wl, { steps: DONE, stateDelayMs: 10_000 });
		await expectModelFailure(r, wl, `named ${X}, no get_state model within 4s`);
	}, 60_000);

	test("T4r-p: a stop accepted after the model failure and before finalisation still leaves one launch-failed: and one lane-died:, both at model (R3-1)", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, X);
		// The window is held open by the fake, not by timing: its helper keeps omp's stdout open past the SIGKILL until the gate exists.
		const gate = join(r.root, "stdout-gate");
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" }, holdStdoutUntil: gate });
		const lane1 = laneIdOf(wl, 1);
		const ompPid = (await until("the fake omp's start record", () => fakeRecords(r).find((x) => x.argv !== undefined))).pid;
		// The model check failed: the death is on the ledger (written before the kill) or omp is gone; the runner has not finalised.
		await until("the model failure", () => laneSnapshot(r, wl).deaths.length > 0 || !alive(ompPid));
		expect(laneExit(laneSnapshot(r, wl).control, lane1)).toBeNull();
		const runnerPid = (await until("lane-started:", () => laneStarted(laneSnapshot(r, wl).control, lane1))).runnerPid;
		process.kill(runnerPid, "SIGTERM");
		await until("the stop's acceptance", () => laneSnapshot(r, wl).control.some((c) => c.prefix === "lane-stop" && c.laneId === lane1 && /^accepted\b/.test(c.rest)));
		// The race's condition holds: the end reads as intended and finish() has not run yet.
		const before = laneSnapshot(r, wl);
		expect(exitClass(before.control, lane1)).toBe("intended");
		expect(laneExit(before.control, lane1)).toBeNull();
		expect(before.control.some((c) => c.prefix === "launch-failed")).toBe(false);
		writeFileSync(gate, "");
		await expectModelFailure(r, wl, `named ${X}, omp started ${A}`);
	}, 60_000);
});

describe("T5c: lane-ready: only just before the first prompt", () => {
	test("an at-ceiling relaunch stops before lane-ready: and before any prompt; builderLabs names it neither builder nor unknown", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, X);
		surfaceWrite(r, wl, [ceilingBody({ usd: 1, wallMin: 60 }, "test tiny ceiling")]);
		launch(r, wl, { steps: [{ usage: { usd: 1.2, tokens: 5000 } }, { hang: true }] });
		expect(await settledExit(r, wl, laneIdOf(wl, 1))).toMatchObject({ outcome: "stop", reason: "ceiling" });
		const l = ledgerOf(r);
		const q = l.questions(wl).find((x: QuestionRow) => x.slice_id.startsWith("sl-ceiling-") && x.created_by === LANE_RUNNER_BY)!;
		const answer = l.answerQuestion(q.id, { by: SURFACE_BY, answer: "stop", author: "jo", channel: "surface" });
		l.completeSlice(q.slice_id, { by: SURFACE_BY, artifact: `answered stop ${answer}` });
		l.close();
		request(r, wl);
		launch(r, wl, { steps: [{ usage: { usd: 0.1, tokens: 10 } }, { hang: true }] });
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "stop", reason: "ceiling" });
		expect(readyLines(r, wl, lane2)).toEqual([]);
		expect(eventsOf(r, spawnRecord(r, 2).pid)).not.toContain("prompt");
		const unknown = unknownOf(r, wl);
		expect(unknown.some((u) => u.includes(laneIdOf(wl, 1)))).toBe(true);
		expect(unknown.some((u) => u.includes(lane2))).toBe(false);
	}, 60_000);
});

describe("T6: omp's prompt error rides the death line", () => {
	test("T6p: a refusal on prompt_result → lane-died: … prompt ended error: anthropic/<m>: Refusal … (retryable false)", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, A);
		launch(r, wl, { steps: [{ result: "error", error: { message: "Refusal (cyber): the request was declined", provider: "anthropic", model: "claude-opus-5-5", retryable: false } }] });
		const lane1 = laneIdOf(wl, 1);
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "error" });
		expect(laneSnapshot(r, wl).deaths).toEqual([`lane-died: ${lane1}: prompt ended error: anthropic/claude-opus-5-5: Refusal (cyber): the request was declined (retryable false)`]);
	}, 60_000);
});

describe("T8: named then cleared", () => {
	test("T8a-p: the X lane holding the newest session: default runs with neither --model nor --resume and names s2", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, null);
		noOpenSlice(r, sl);
		launch(r, wl, { steps: [{ exit: 3 }] });
		await settledExit(r, wl, laneIdOf(wl, 1));
		request(r, wl, X);
		launch(r, wl, { steps: [{ exit: 3 }] }, "jo");
		const lane2 = laneIdOf(wl, 2);
		await settledExit(r, wl, lane2);
		const s2 = laneStarted(laneSnapshot(r, wl).control, lane2)!.session!;
		request(r, wl, "default");
		launch(r, wl, { steps: DONE }, "jo");
		const lane3 = laneIdOf(wl, 3);
		expect(await exitOf(r, wl, lane3)).toMatchObject({ outcome: "completed" });
		const argv = spawnRecord(r, 3).argv!;
		expect(argv).not.toContain("--model");
		expect(argv).not.toContain("--resume");
		expect(startsOf(r, wl, lane3).at(-1)).toMatchObject({ model: null, resumeSkipped: `${s2} ran on ${X}` });
	}, 90_000);

	test("T8b-p: the X launch failed before a session: default resumes the default-era s1", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, null);
		noOpenSlice(r, sl);
		launch(r, wl, { steps: [{ exit: 3 }] });
		const lane1 = laneIdOf(wl, 1);
		await settledExit(r, wl, lane1);
		const s1 = laneStarted(laneSnapshot(r, wl).control, lane1)!.session!;
		request(r, wl, X);
		launch(r, wl, { steps: DONE, stateFail: true }, "jo");
		expect(await settledExit(r, wl, laneIdOf(wl, 2))).toMatchObject({ outcome: "never-ready" });
		request(r, wl, "default");
		launch(r, wl, { steps: DONE }, "jo");
		const lane3 = laneIdOf(wl, 3);
		expect(await exitOf(r, wl, lane3)).toMatchObject({ outcome: "completed" });
		const argv = spawnRecord(r, 3).argv!;
		expect(argv).not.toContain("--model");
		expect(argv.slice(-2)).toEqual(["--resume", s1]);
	}, 90_000);
});
