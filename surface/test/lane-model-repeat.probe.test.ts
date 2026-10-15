// THROWAWAY (PLAN wl-mv615mkeaf1yio rev 8 § 1, after the fix): lane-model-script.test.ts's T2p (both), T2p catch-up,
// T8a-p and T8b-p sequences in their fixed order, 20 runs each. Forced: every lane a launch cause follows holds its
// fake omp's stdout until the test opens a gate, so its runner's lane-exit: and drain spawn (MIGRATION.md item 71)
// come only then, and the cause is written only after that drain has read the ledger and gone (drainSettled). The
// by-hand launch is then the only launcher. Each run settles its root's drains and lanes before removing it. The
// sequences are restated here, not imported: importing a test file registers its tests in the importer's run.
// Deleted before the final head. It spawns processes, so it runs outside the fence.
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneExit, laneModelBody, laneStarted, verdictOf } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import {
	alive, drainSettled, type FakeScript, type FakeStep, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, until,
} from "./helpers";

const RUNS = 20;
const X = "openai-codex/gpt-6-sol";
const DONE: FakeStep[] = [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }];

/** An autonomous workload with its done: line and one open slice, and Jo's `lane-model:` when `model` is given. */
function openWorkload(r: LaneRoot, model: string | null): { wl: string; sl: string } {
	const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "lane model repeat probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		if (model !== null) l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody(model, l.now()) });
		const sl = l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "probe", doneCondition: "probed", inputs: "README.md" });
		return { wl, sl };
	} finally {
		l.close();
	}
}
/** Jo's `launch-requested:`, with Jo's `lane-model:` first when `model` is given, written as the surface writes them. */
function request(r: LaneRoot, wl: string, model?: string): void {
	const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
	try {
		const now = l.now();
		for (const body of [...(model !== undefined ? [laneModelBody(model, now)] : []), `launch-requested: by jo at ${now}`]) {
			l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body });
		}
	} finally {
		l.close();
	}
}
function launch(r: LaneRoot, wl: string, script: FakeScript, by = "test"): void {
	setScript(r, script);
	expect(sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", by], r.repo, r.env).code).toBe(0);
}
/** Until `laneId`'s lane-exit:, then until the drain its runner spawned has read the ledger and gone (the fixed order). */
async function exitOf(r: LaneRoot, wl: string, laneId: string) {
	const exit = await until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId));
	await drainSettled(r, laneId);
	return exit;
}
/** The gate lane `n`'s fake omp holds its stdout for (`holdStdoutUntil`). */
const gateOf = (r: LaneRoot, n: number) => join(r.root, `exit-gate-${n}`);
/**
 * Lane `n` launched with `holdStdoutUntil: gateOf(r, n)`: until its fake omp is gone with no lane-exit: written (the
 * runner is held), then the gate opens and `exitOf` waits for the exit and the drain it spawns.
 */
async function heldExitOf(r: LaneRoot, wl: string, n: number) {
	const laneId = laneIdOf(wl, n);
	const omp = await until(`fake omp spawn ${n}`, () => fakeRecords(r).filter((x) => x.argv !== undefined)[n - 1]);
	await until(`fake omp ${omp.pid} gone`, () => !alive(omp.pid));
	expect(laneExit(laneSnapshot(r, wl).control, laneId)).toBeNull();
	writeFileSync(gateOf(r, n), "");
	return exitOf(r, wl, laneId);
}
/** The n-th (1-based) fake omp spawn's record: argv, pid, session. */
const spawnRecord = (r: LaneRoot, n: number) => fakeRecords(r).filter((x) => x.argv !== undefined)[n - 1]!;
const lastStart = (r: LaneRoot, wl: string, laneId: string) => {
	const start = laneSnapshot(r, wl).control.filter((c) => c.prefix === "lane-started" && c.laneId === laneId).at(-1)!;
	return JSON.parse(start.rest) as { session: string | null; model?: string | null; ranModel?: string | null; resumeSkipped?: string | null };
};

const SEQUENCES: [string, (r: LaneRoot) => Promise<void>][] = [
	["T2p: after a death a relaunch with no model keeps --model and resumes the session on it", async (r) => {
		const { wl } = openWorkload(r, X);
		launch(r, wl, { steps: [{ exit: 3 }], holdStdoutUntil: gateOf(r, 1) });
		expect(await heldExitOf(r, wl, 1)).toMatchObject({ outcome: "died" });
		const session1 = laneStarted(laneSnapshot(r, wl).control, laneIdOf(wl, 1))!.session!;
		request(r, wl);
		launch(r, wl, { steps: DONE }, "jo");
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "completed" });
		expect(spawnRecord(r, 2).argv!.slice(-4)).toEqual(["--model", X, "--resume", session1]);
		expect(lastStart(r, wl, lane2)).toMatchObject({ model: X, ranModel: X, resumeSkipped: null });
	}],
	["T2p: the tick's resume after Jo's answer keeps --model and the parked session", async (r) => {
		const { wl, sl } = openWorkload(r, X);
		launch(r, wl, { steps: [{ tool: "lane_raise_question", args: { slice: sl, body: "push now?", options: ["yes", "no"] } }], holdStdoutUntil: gateOf(r, 1) });
		expect(await heldExitOf(r, wl, 1)).toMatchObject({ outcome: "parked" });
		const session1 = spawnRecord(r, 1).session!;
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		l.answerQuestion(laneSnapshot(r, wl).questions[0]!.id, { by: SURFACE_BY, answer: "yes", author: "jo", channel: "surface" });
		l.close();
		launch(r, wl, { steps: [{ tool: "lane_complete_slice", args: { slice: sl, artifact: "done" } }, ...DONE] }, "tick");
		expect(await exitOf(r, wl, laneIdOf(wl, 2))).toMatchObject({ outcome: "completed" });
		expect(spawnRecord(r, 2).argv!.slice(-4)).toEqual(["--model", X, "--resume", session1]);
	}],
	["T2p: the tick's catch-up of Jo's request after a death keeps --model and resumes the session on it", async (r) => {
		const { wl } = openWorkload(r, X);
		launch(r, wl, { steps: [{ exit: 3 }], holdStdoutUntil: gateOf(r, 1) });
		expect(await heldExitOf(r, wl, 1)).toMatchObject({ outcome: "died" });
		const session1 = laneStarted(laneSnapshot(r, wl).control, laneIdOf(wl, 1))!.session!;
		request(r, wl);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		const verdict = verdictOf(l.launchRows(wl, 3)!);
		l.close();
		expect(verdict).toMatchObject({ launch: true, cause: { kind: "request" } });
		launch(r, wl, { steps: DONE }, "tick");
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "completed" });
		const launched = laneSnapshot(r, wl).control.find((c) => c.prefix === "launch" && c.laneId === lane2)!;
		expect(launched.rest).toMatch(/^cause request \S+ requested-by tick$/);
		expect(spawnRecord(r, 2).argv!.slice(-4)).toEqual(["--model", X, "--resume", session1]);
		expect(lastStart(r, wl, lane2)).toMatchObject({ model: X, ranModel: X, resumeSkipped: null });
	}],
	["T8a-p: the X lane holding the newest session: default runs with neither --model nor --resume and names s2", async (r) => {
		const { wl } = openWorkload(r, null);
		launch(r, wl, { steps: [{ exit: 3 }], holdStdoutUntil: gateOf(r, 1) });
		await heldExitOf(r, wl, 1);
		request(r, wl, X);
		launch(r, wl, { steps: [{ exit: 3 }], holdStdoutUntil: gateOf(r, 2) }, "jo");
		await heldExitOf(r, wl, 2);
		const s2 = laneStarted(laneSnapshot(r, wl).control, laneIdOf(wl, 2))!.session!;
		request(r, wl, "default");
		launch(r, wl, { steps: DONE }, "jo");
		const lane3 = laneIdOf(wl, 3);
		expect(await exitOf(r, wl, lane3)).toMatchObject({ outcome: "completed" });
		const argv = spawnRecord(r, 3).argv!;
		expect(argv).not.toContain("--model");
		expect(argv).not.toContain("--resume");
		expect(lastStart(r, wl, lane3)).toMatchObject({ model: null, resumeSkipped: `${s2} ran on ${X}` });
	}],
	["T8b-p: the X launch failed before a session: default resumes the default-era s1", async (r) => {
		const { wl } = openWorkload(r, null);
		launch(r, wl, { steps: [{ exit: 3 }], holdStdoutUntil: gateOf(r, 1) });
		await heldExitOf(r, wl, 1);
		const s1 = laneStarted(laneSnapshot(r, wl).control, laneIdOf(wl, 1))!.session!;
		request(r, wl, X);
		launch(r, wl, { steps: DONE, stateFail: true, holdStdoutUntil: gateOf(r, 2) }, "jo");
		expect(await heldExitOf(r, wl, 2)).toMatchObject({ outcome: "never-ready" });
		request(r, wl, "default");
		launch(r, wl, { steps: DONE }, "jo");
		expect(await exitOf(r, wl, laneIdOf(wl, 3))).toMatchObject({ outcome: "completed" });
		const argv = spawnRecord(r, 3).argv!;
		expect(argv).not.toContain("--model");
		expect(argv.slice(-2)).toEqual(["--resume", s1]);
	}],
];

for (const [name, run] of SEQUENCES) {
	describe(name, () => {
		for (let i = 1; i <= RUNS; i++) {
			test(`run ${i} of ${RUNS}`, async () => {
				// Each run's root goes once its drains and lanes are settled; the sequence's own failure wins over a settle failure.
				const r = laneRoot();
				let failure: unknown = null;
				try {
					await run(r);
				} catch (err) {
					failure = err;
				}
				try {
					await settleDrains(r);
				} catch (err) {
					failure ??= err;
				} finally {
					rmSync(r.root, { recursive: true, force: true });
				}
				if (failure !== null) throw failure;
			}, 180_000);
		}
	});
}
