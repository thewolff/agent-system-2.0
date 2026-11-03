// The runner ends a lane at once when OMP's extensions notice shows the as2 extensions suspended (decision
// en-mw01fr5uts72g0): install.sh re-renders the profile's `extensions:` block, OMP's live config listener suspends the
// loaded as2 extensions (the P-11 gates among them) with no frame of its own, and only says it would load the newly
// enabled copies after a restart. Through the real runner (surface/scripts/lane.ts) and the fake omp
// (surface/test/fake-omp.ts, its `emit` step writing the real frames verbatim), as lane-script.test.ts drives them:
// the outcome is `error` with one lane-died: naming the cause, no continue prompt, no hold, and an unrelated notice
// (a non-as2 extension enabled, compaction) never ends a lane.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handSpawnBody } from "../../classifier/src/lab";
import { Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneExit } from "../src/launch";
import { heartbeatText, runDirOf, runsRoot, testRequestedBody } from "../src/test-run";
import { BACKGROUND_SUFFIX, extensionsSuspendedDeathBody, extensionsSuspendedOf } from "../src/turn-end";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { COMPACTION_FRAME, type FakeStep, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, SUSPENDED_FRAMES, until } from "./helpers";

const roots: LaneRoot[] = [];
const makeRoot = (): LaneRoot => {
	const r = laneRoot();
	roots.push(r);
	return r;
};
// As lane-script.test.ts: a root is removed only after every runner's drain of it has ended.
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
/** An autonomous workload on the root's repo with its done: line and one open slice. */
function openWorkload(r: LaneRoot): { wl: string; sl: string } {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "extensions suspended probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		const sl = l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "probe", doneCondition: "probed", inputs: "README.md" });
		return { wl, sl };
	} finally {
		l.close();
	}
}
const launched = (r: LaneRoot, wl: string): string => {
	expect(sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "test"], r.repo, r.env).code).toBe(0);
	return laneIdOf(wl, 1);
};
const exitOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId));
const promptsOf = (r: LaneRoot) => fakeRecords(r).filter((x) => x.event === "prompt");
const eventsOf = (r: LaneRoot) => fakeRecords(r).filter((x) => x.event).map((x) => x.event!);
/** The workload's orchestrator-facing messages, oldest first. */
const orchestratorMessages = (r: LaneRoot, wl: string): string[] => {
	const l = ledgerOf(r);
	try {
		return l.db.query<{ body: string }, [string, string]>("SELECT body FROM messages WHERE workload_id = ? AND recipient = ? ORDER BY rowid").all(wl, ORCHESTRATOR_RECIPIENT).map((m) => m.body);
	} finally {
		l.close();
	}
};

/** The verified/current notice (helpers.ts SUSPENDED_FRAMES), as the fake writes it, and the as2 paths it enables. */
const notice = JSON.parse(SUSPENDED_FRAMES[1]) as Record<string, unknown>;
const enabled = extensionsSuspendedOf(notice)!;

describe("the runner: as2 extensions suspended mid-run (decision en-mw01fr5uts72g0)", () => {
	test("a slice open, the real notice mid-turn → outcome error at once: one lane-died: naming the cause (no open-work, no session shutdown line), released, an abort and only the first prompt", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		setScript(r, { steps: [{ emit: notice }, { hang: true }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		const death = extensionsSuspendedDeathBody(laneId, enabled);
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([death]);
		expect(snap.workload!.holder).toBeNull();
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("abort");
		// The orchestrator's needs-you reads this lane's messages: the one it got names the suspension, nothing else.
		expect(orchestratorMessages(r, wl)).toEqual([death]);
	}, 30_000);

	test("an enable notice naming only a non-as2 extension, then a compaction notice, then the clean end → completed, no lane-died:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		const other: FakeStep = { emit: { type: "notice", level: "warning", message: "Restart omp to load newly enabled extensions: /Users/x/.omp/agent/extensions/foo.ts", source: "extensions" } };
		// A real compaction notice, verbatim (helpers.ts COMPACTION_FRAME).
		const compaction: FakeStep = { emit: JSON.parse(COMPACTION_FRAME) as Record<string, unknown> };
		setScript(r, { steps: [other, compaction, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "completed" });
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).not.toContain("abort");
	}, 30_000);

	test("in flight, an unsettled review hand and a live test run at the notice → still error at once with the extensions death, no held-open message, no continue prompt", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r);
		const runId = "tr-0extsusp1";
		const sha = "a".repeat(40);
		const l = ledgerOf(r);
		l.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr: 17, sha, slice: sl, by: "lane-x" }) });
		l.close();
		const dir = runDirOf(runsRoot(r.env), runId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "heartbeat"), heartbeatText(runId, Date.now()));
		// The classifier's hand-spawn: as a fixture writes it (lane-script.test.ts spawnStep), never settled.
		const spawn: FakeStep = { ledger: { body: handSpawnBody({ token: "dt-ext1", root: "/tmp/lane", spawnKey: sl, review: true, group: "dg-dt-ext1", row: ["openai-codex/gpt-6-astra"] }), slice: sl } };
		setScript(r, { steps: [spawn, { emit: notice }, { hang: true }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		// No prompt_result had ended the turn, so the runner's `settled` was still its start value (true): no background suffix.
		const death = extensionsSuspendedDeathBody(laneId, enabled);
		expect(laneSnapshot(r, wl).deaths).toEqual([death]);
		expect(orchestratorMessages(r, wl)).toEqual([death]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("abort");
		expect(laneSnapshot(r, wl).workload!.holder).toBeNull();
	}, 30_000);

	test("in flight, the notice in a woken turn while the runner waits on omp's background job → error at once; the death carries the background suffix (settled was false)", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		// The prompt ends sessionSettled: false; the job's woken turn (prompts[1]) sends the notice.
		setScript(r, { prompts: [[{ background: 1000 }], [{ emit: notice }]] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		const death = `${extensionsSuspendedDeathBody(laneId, enabled)}${BACKGROUND_SUFFIX}`;
		expect(laneSnapshot(r, wl).deaths).toEqual([death]);
		expect(orchestratorMessages(r, wl)).toEqual([death]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("background-done");
	}, 30_000);
});
