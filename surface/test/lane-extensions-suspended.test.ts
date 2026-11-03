// The runner ends a lane at once when the as2 extensions are suspended by a profile config change (decision
// en-mw01fr5uts72g0): install.sh re-renders the profile's `extensions:` block, OMP's live config listener suspends the
// loaded as2 extensions (the P-11 gates among them) with no frame of its own, and only says it would load the newly
// enabled copies after a restart. That notice is the trigger; the runner confirms against the profile config it read at the
// spawn and reads again (a loaded as2 path no longer enabled) before it ends the lane, and ends it unconfirmed when the
// config cannot be read. Through the real runner (surface/scripts/lane.ts) and the fake omp (surface/test/fake-omp.ts, its
// `writeFile` step rewriting the profile config as install.sh would and its `emit` step writing the real frames verbatim),
// as lane-script.test.ts drives them: the outcome is `error` with one lane-died: naming the cause, no continue prompt, no
// hold; an enable-only notice (every loaded as2 path still enabled) and an unrelated notice (a non-as2 extension enabled,
// compaction) never end a lane. A suspension OMP gives no notice for (A → A+B → B, a removal alone) is found by the
// runner's stop poll re-reading the changed config (review round 2 of PR #428), and a failed poll read never ends a lane.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handSpawnBody } from "../../classifier/src/lab";
import { Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneDir, laneExit } from "../src/launch";
import { heartbeatText, runDirOf, runsRoot, testRequestedBody, testRunBody } from "../src/test-run";
import { AS2_EXTENSION_ENTRIES, BACKGROUND_SUFFIX, extensionsSuspendedDeathBody, extensionsSuspendedOf, extensionsUnconfirmedDeathBody, readAs2ExtensionPaths } from "../src/turn-end";
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

/** The verified/current notice (helpers.ts SUSPENDED_FRAMES), as the fake writes it, and the as2 paths it enables (root B's). */
const notice = JSON.parse(SUSPENDED_FRAMES[1]) as Record<string, unknown>;
const enabled = extensionsSuspendedOf(notice)!;
/** Root A, where the lane's as2 extensions load from at the spawn; root B, the one the notice names. */
const ROOT_A = "/Users/jowolff/code/agent-system-2.0";
const ROOT_B = "/Users/jowolff/.agent-system-2/verified/current";
const as2At = (root: string): string[] => AS2_EXTENSION_ENTRIES.map((e) => `${root}/${e}`);
/** The installed profile config the runner reads (lane.ts profileConfig(); helpers.ts laneRoot writes it). */
const configPath = (r: LaneRoot): string => join(r.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml");
const configText = (paths: readonly string[]): string => `setupVersion: 2\nextensions:\n${paths.map((p) => `  - "${p}"\n`).join("")}`;
/** The profile config before the launch: the as2 entries at root A. */
const writeConfigA = (r: LaneRoot): void => writeFileSync(configPath(r), configText(as2At(ROOT_A)));
/** The fake's mid-run rewrite of the profile config, as install.sh would. */
const rewrite = (r: LaneRoot, text: string): FakeStep => ({ writeFile: { path: configPath(r), text } });
const INVALID_YAML = 'extensions: ["/a/gates/index.ts"\n  bad: : :\n';

describe("the runner: as2 extensions suspended mid-run (decision en-mw01fr5uts72g0)", () => {
	test("a slice open, the config re-rendered to root B and the real notice mid-turn → outcome error at once: one confirmed lane-died: (no open-work, no session shutdown line), released, an abort and only the first prompt", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		writeConfigA(r);
		setScript(r, { steps: [rewrite(r, configText(as2At(ROOT_B))), { emit: notice }, { hang: true }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		const death = extensionsSuspendedDeathBody(laneId, as2At(ROOT_A), enabled);
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([death]);
		expect(snap.workload!.holder).toBeNull();
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("abort");
		// The orchestrator's needs-you reads this lane's messages: the one it got names the suspension, nothing else.
		expect(orchestratorMessages(r, wl)).toEqual([death]);
	}, 30_000);

	test("enable-only (review round 1 finding 1): root A's entries kept, a root B copy and an unrelated …/surface/index.ts added, their notice, then the clean end → completed, no lane-died:, no abort", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		writeConfigA(r);
		const added = [...as2At(ROOT_B), "/x/other/surface/index.ts"];
		const addNotice: FakeStep = { emit: { type: "notice", level: "warning", message: `Restart omp to load newly enabled extensions: ${added.join(", ")}`, source: "extensions" } };
		setScript(r, { steps: [rewrite(r, configText([...as2At(ROOT_A), ...added])), addNotice, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "completed" });
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).not.toContain("abort");
		// The notice did reach the runner: it read the config again and said why the lane goes on.
		expect(readFileSync(join(laneDir(wl, r.home), "runner.log"), "utf8")).toContain(`runner: ${laneId} extensions notice enables ${[...as2At(ROOT_B), "/x/other/surface/index.ts"].join(", ")}; the loaded as2 extensions are still enabled; the lane goes on\n`);
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

	test("unconfirmed: the config rewritten as invalid YAML, then the notice → error at once with the unconfirmed death naming the parse failure", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		writeConfigA(r);
		setScript(r, { steps: [rewrite(r, INVALID_YAML), { emit: notice }, { hang: true }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		// The file still holds the invalid YAML: its read now is the error the runner's re-read met.
		const reread = readAs2ExtensionPaths(configPath(r));
		if (!("error" in reread)) throw new Error(`${configPath(r)} parsed; the test's INVALID_YAML must not`);
		expect(reread.error).toContain("does not parse");
		const death = extensionsUnconfirmedDeathBody(laneId, enabled, `the profile config re-read failed: ${reread.error}`);
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([death]);
		expect(snap.workload!.holder).toBeNull();
		expect(orchestratorMessages(r, wl)).toEqual([death]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("abort");
	}, 30_000);

	test("in flight, an unsettled review hand and a live test run at the notice → still error at once with the extensions death, no held-open message, no continue prompt", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r);
		writeConfigA(r);
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
		setScript(r, { steps: [spawn, rewrite(r, configText(as2At(ROOT_B))), { emit: notice }, { hang: true }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		// No prompt_result had ended the turn, so the runner's `settled` was still its start value (true): no background suffix.
		const death = extensionsSuspendedDeathBody(laneId, as2At(ROOT_A), enabled);
		expect(laneSnapshot(r, wl).deaths).toEqual([death]);
		expect(orchestratorMessages(r, wl)).toEqual([death]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("abort");
		expect(laneSnapshot(r, wl).workload!.holder).toBeNull();
	}, 30_000);

	test("in flight, the notice in a woken turn while the runner waits on omp's background job → error at once; the death carries the background suffix (settled was false)", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		writeConfigA(r);
		// The prompt ends sessionSettled: false; the job's woken turn (prompts[1]) rewrites the config and sends the notice. With
		// `background: 0` the woken turn runs on the fake's next tick, after its prompt_result frame: frame order carries the sequence.
		setScript(r, { prompts: [[{ background: 0 }], [rewrite(r, configText(as2At(ROOT_B))), { emit: notice }]] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		const death = `${extensionsSuspendedDeathBody(laneId, as2At(ROOT_A), enabled)}${BACKGROUND_SUFFIX}`;
		expect(laneSnapshot(r, wl).deaths).toEqual([death]);
		expect(orchestratorMessages(r, wl)).toEqual([death]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("background-done");
	}, 30_000);

	// Review round 2 of PR #428: OMP names a newly enabled path once per process and a removal never, so these suspensions
	// come with no notice; the runner's stop poll (every STOP_POLL_MS) finds them by re-reading the changed profile config.
	const runnerLog = (r: LaneRoot, wl: string): string => readFileSync(join(laneDir(wl, r.home), "runner.log"), "utf8");

	test("A → A+B → B (review round 2): the A+B notice leaves the lane going; the next turn's rewrite to B alone, which OMP never announces, ends it at the stop poll → error with one confirmed lane-died:, released, an abort", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		writeConfigA(r);
		// The rewrite to B alone is the second turn's: the fake runs it only once the runner sends the continue prompt, which it
		// does after it has read the A+B notice (frame order), so the notice's re-read sees A+B and only the poll can see B alone.
		setScript(r, { prompts: [[rewrite(r, configText([...as2At(ROOT_A), ...as2At(ROOT_B)])), { emit: notice }], [rewrite(r, configText(as2At(ROOT_B))), { hang: true }]] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		// The poll's body: A no longer enabled, and the as2 paths the config enables that the lane did not load (B's).
		const death = extensionsSuspendedDeathBody(laneId, as2At(ROOT_A), as2At(ROOT_B));
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([death]);
		expect(snap.workload!.holder).toBeNull();
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(eventsOf(r)).toContain("abort");
		expect(orchestratorMessages(r, wl)).toEqual([death]);
		const log = runnerLog(r, wl);
		expect(log).toContain(`runner: ${laneId} extensions notice enables ${enabled.join(", ")}; the loaded as2 extensions are still enabled; the lane goes on\n`);
		expect(log).toContain(`runner: ${laneId} extensions suspended with no notice: ${as2At(ROOT_A).join(", ")} no longer enabled in ${configPath(r)}; ending the lane\n`);
	}, 30_000);

	test("removal only (review round 2): the config rewritten with no as2 entry and no notice at all → error at the stop poll with the no-notice death naming root A's four paths", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		writeConfigA(r);
		setScript(r, { steps: [rewrite(r, "setupVersion: 2\nextensions:\n  - \"/Users/x/.omp/agent/extensions/foo.ts\"\n"), { hang: true }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "error" });
		const death = extensionsSuspendedDeathBody(laneId, as2At(ROOT_A));
		expect(death).not.toContain("OMP now enables");
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([death]);
		expect(snap.workload!.holder).toBeNull();
		expect(orchestratorMessages(r, wl)).toEqual([death]);
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1"]);
		expect(eventsOf(r)).toContain("abort");
	}, 30_000);

	test("a failed poll read never ends the lane (review round 2): the config rewritten as invalid YAML with no notice, the lane held for a live test run until the poll has logged the parse error, then the run lands → completed, no lane-died:, the error logged once", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r);
		writeConfigA(r);
		// A live test run holds the lane after its receipt (turn-end D8: two continue prompts, then the hold) until the test
		// lands the run's result, so the clean end cannot come before the poll has read the invalid config.
		const runId = "tr-0extpoll1";
		const sha = "b".repeat(40);
		const l = ledgerOf(r);
		l.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr: 17, sha, slice: sl, by: "lane-x" }) });
		l.close();
		const dir = runDirOf(runsRoot(r.env), runId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "heartbeat"), heartbeatText(runId, Date.now()));
		setScript(r, { prompts: [[rewrite(r, INVALID_YAML), { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }]], steps: [] });
		const laneId = launched(r, wl);
		const logPath = join(laneDir(wl, r.home), "runner.log");
		await until("the poll's config-check line in runner.log", () => (existsSync(logPath) && readFileSync(logPath, "utf8").includes(`runner: ${laneId} profile config check failed: `)) || null);
		// The file still holds the invalid YAML: its read now is the error the poll's re-read met.
		const reread = readAs2ExtensionPaths(configPath(r));
		if (!("error" in reread)) throw new Error(`${configPath(r)} parsed; the test's INVALID_YAML must not`);
		expect(reread.error).toContain("does not parse");
		const failed = `runner: ${laneId} profile config check failed: ${reread.error}; no evidence of a suspension, the lane goes on (an extensions notice still re-reads it)\n`;
		expect(runnerLog(r, wl)).toContain(failed);
		expect(laneExit(laneSnapshot(r, wl).control, laneId)).toBeNull();
		const l2 = ledgerOf(r);
		l2.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption",
			body: testRunBody({
				runId, verdict: "error", sha, pr: 17, reason: "runner died", headAtEnd: sha, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
		l2.close();
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "completed" });
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
		expect(eventsOf(r)).not.toContain("abort");
		expect(runnerLog(r, wl).split(failed).length - 1).toBe(1);
	}, 30_000);
});
