// The lane script against the fake omp (DESIGN-lane-launcher.md § 8 "Fake-omp shim unit tests",
// "the runner against the shim"): surface/test/fake-omp.ts sits on PATH as `omp` ahead of the real
// binary, speaks the 18.4.4 rpc frames and runs the real lane rows in-process, so every subcommand
// of surface/scripts/lane.ts (launch, run, stop, cleanup, log) is exercised as the processes it
// really is, on a temp HOME, a temp ledger and a temp git repo. The Codex-review regressions the
// runner owns are here: readiness is the lane's own claim (B1), the runner finalizes once on any
// exit including a thrown exception after the reservation (B3), a stop persists its acceptance
// then abort → stdin EOF → bounded SIGKILL (B4), and every exit is classified with a requested stop
// never writing lane-died:.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handSpawnBody } from "../../classifier/src/lab";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, type QuestionRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import { ceilingBody, CEILING_OPTIONS, parseSpend } from "../src/ceiling";
import { recordRepo } from "../src/decision-log";
import { branchName, type ControlEntry, doneBody, laneCap, laneDir, laneEnv, laneExit, laneExitBody, laneStarted, laneStopAcceptedBody, laneStopRequestBody, STARTER_EXIT, verdictOf, worktreePath } from "../src/launch";
import { heartbeatText, runDirOf, runsRoot, testRequestedBody, testRunBody } from "../src/test-run";
// A namespace import, not named ones: a name lane.ts stops exporting fails only the test that calls it, not the module load.
import * as laneScript from "../scripts/lane";
import { SURFACE_BY } from "../src/types";
import {
	alive, drainEnded, drainLinesOf, drainSettled, drainsSpawned, type FakeStep, fakeRecords, git, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, until,
} from "./helpers";

const roots: LaneRoot[] = [];
const makeRoot = (over: Record<string, string> = {}): LaneRoot => {
	const r = laneRoot(over);
	roots.push(r);
	return r;
};
// A root is removed only after settleDrains is done with it: every runner's drain (MIGRATION.md item 71) and every
// lane a drain launched has ended, or, when that wait failed, every runner and drain of the root still alive was
// SIGKILLed and is gone; the failure is thrown only after the removal.
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
/** An autonomous workload on the root's repo with its done: line and, when asked, one open slice. */
function openWorkload(r: LaneRoot, o: { slice?: boolean; brief?: string } = {}): { wl: string; sl: string | null } {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: o.brief ?? "lane script probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		const sl = o.slice ? l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "probe", doneCondition: "probed", inputs: "README.md" }) : null;
		return { wl, sl };
	} finally {
		l.close();
	}
}
const lane = (r: LaneRoot, args: string[], over: Record<string, string> = {}) => sh(["bun", LANE_SCRIPT, ...args], r.repo, { ...r.env, ...over });
const eventsOf = (r: LaneRoot, pid: number) => fakeRecords(r).filter((x) => x.pid === pid && x.event).map((x) => x.event!);
const exitOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId));
const startedOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-started: of ${laneId}`, () => laneStarted(laneSnapshot(r, wl).control, laneId));
const readyOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-ready: of ${laneId}`, () => laneSnapshot(r, wl).control.find((c) => c.prefix === "lane-ready" && c.laneId === laneId));
/** Fault injection on the temp ledger only: a trigger that aborts the insert of an entry whose body starts with `prefix`. */
function failEntryInsert(r: LaneRoot, prefix: string, message: string): void {
	const db = new Database(r.ledgerPath);
	try {
		db.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON entries WHEN NEW.body LIKE '${prefix}%' BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
	} finally {
		db.close();
	}
}
/** A fake `ctx` first on PATH (the root's bin) that logs its argv: any ctx call under the temp HOME lands in this log, never in a real ctx. */
function fakeCtx(r: LaneRoot): { bin: string; log: string } {
	const bin = join(r.root, "bin", "ctx");
	const log = join(r.root, "ctx-argv.log");
	writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`);
	chmodSync(bin, 0o755);
	return { bin, log };
}
/** The lane's ctx-index: entries once `n` of them have landed (the claim, then the outcome): its worker runs detached after the exit. */
const ctxIndexOf = (r: LaneRoot, wl: string, laneId: string, n = 2) =>
	until(`${n} ctx-index: entries of ${laneId}`, () => {
		const rows = laneSnapshot(r, wl).control.filter((c) => c.prefix === "ctx-index" && c.laneId === laneId);
		return rows.length >= n ? rows : null;
	});

describe("lane script: launch, run, log, cleanup against the fake omp", () => {
	test("launch reserves and prints the lane and runner; the runner records start (twice: null then the session), ready after the lane's own claim, the prompt, completion, release and lane-exit: completed; a second launch while held is refused with nothing written", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		const launch = lane(r, ["launch", wl, "--requested-by", "test"]);
		expect(launch.code).toBe(STARTER_EXIT.ok);
		const m = /^lane (\S+) runner (\d+)$/.exec(launch.out);
		expect(m).not.toBeNull();
		const laneId = laneIdOf(wl, 1);
		expect(m![1]).toBe(laneId);
		const runnerPid = Number(m![2]);
		// held under the pre-claim: a second starter is refused `held` and writes nothing. Only the starter's rows are counted:
		// the runner is live and writes its own lane-started: whenever its omp spawns, which can land inside this window.
		const starterRows = () => laneSnapshot(r, wl).bodies.filter((b) => b.startsWith(`${LANE_STARTER_BY} `)).length;
		const before = starterRows();
		const again = lane(r, ["launch", wl, "--requested-by", "test"]);
		expect(again.code).toBe(STARTER_EXIT.held);
		expect(again.err).toContain("not launched: held");
		expect(starterRows()).toBe(before);

		const exit = await exitOf(r, wl, laneId);
		expect(exit).toMatchObject({ code: "0", signal: "-", outcome: "completed" });
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([]);
		// the runner's two start records: the first with session null, the second with the session get_state returned
		const starts = snap.control.filter((c) => c.prefix === "lane-started" && c.laneId === laneId);
		expect(starts.map((s) => s.createdBy)).toEqual([LANE_RUNNER_BY, LANE_RUNNER_BY]);
		const parsed = starts.map((s) => JSON.parse(s.rest) as { pid: number; session: string | null; argv: string[]; runnerPid: number; start: string });
		expect(parsed[0]!.session).toBeNull();
		expect(parsed[1]!.session).not.toBeNull();
		expect(parsed[1]!.runnerPid).toBe(runnerPid);
		expect(parsed[1]!.start).not.toBe("");
		const [rec] = fakeRecords(r);
		expect(rec!.pid).toBe(parsed[1]!.pid);
		expect(rec!.session).toBe(parsed[1]!.session!);
		// argv exactly as laneArgv renders it (--max-time: the normal stakes ceiling's 360 min, none used yet, plus the 10 min margin);
		// env carries the binding with the profile, never the orchestrator role
		const worktree = worktreePath(r.repo, wl);
		expect(rec!.argv).toEqual(["--mode", "rpc", "--no-ui", "--cwd", worktree, "--session-dir", join(laneDir(wl, r.home), "sessions"), "--append-system-prompt", join(laneDir(wl, r.home), "system.md"), "--max-time", "370m"]);
		expect(rec!.cwd).toBe(worktree);
		expect(rec!.env).toMatchObject({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: laneId, OMP_PROFILE: "agent-system-2" });
		// readiness (B1): the ready line lands after the lane's claim (changed_by = the lane), then the one prompt; the runner's
		// lane-decided: before EOF (item 40, wl-mv049108m8whds), the final spend: before the exit
		// (the ctx index's entries follow the exit from a detached worker; the ctx index scenario below orders them)
		const order = snap.control.filter((c) => c.laneId === laneId && c.prefix !== "ctx-index").map((c) => c.prefix);
		expect(order).toEqual(["launch", "lane-started", "lane-started", "lane-ready", "lane-decided", "spend", "lane-exit"]);
		expect(eventsOf(r, rec!.pid)).toEqual(["prompt", "eof"]);
		expect(readFileSync(rec!.session!, "utf8")).toContain(`You are lane ${laneId} on workload ${wl}.`);
		expect(snap.bodies).toContain(`${laneId} done-because: the probe is done`);
		// the worktree and branch the starter recorded exist
		expect(snap.bodies).toContain(`${LANE_STARTER_BY} worktree: ${worktree}`);
		expect(snap.bodies).toContain(`${LANE_STARTER_BY} branch: ${branchName(wl)} base origin/main ${git(r.repo, ["rev-parse", "origin/main"]).out}`);
		expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).out).toBe(branchName(wl));
		await until("runner gone", () => !alive(runnerPid), 10_000);

		// log prints the runner log path and its tail
		const log = lane(r, ["log", wl]);
		expect(log.code).toBe(0);
		expect(log.out.split("\n")[0]).toBe(join(laneDir(wl, r.home), "runner.log"));

		// cleanup: refused with no upstream, then with unpushed commits; removes the worktree once pushed; the branch stays
		const noUpstream = lane(r, ["cleanup", wl]);
		expect(noUpstream.code).toBe(1);
		expect(noUpstream.err).toContain("no upstream; push it first");
		expect(git(worktree, ["push", "-q", "-u", "origin", branchName(wl)]).code).toBe(0);
		writeFileSync(join(worktree, "x.txt"), "x\n");
		git(worktree, ["add", "x.txt"]);
		git(worktree, ["commit", "-q", "-m", "x"]);
		const unpushed = lane(r, ["cleanup", wl]);
		expect(unpushed.code).toBe(1);
		expect(unpushed.err).toContain("unpushed commits");
		expect(git(worktree, ["push", "-q"]).code).toBe(0);
		const clean = lane(r, ["cleanup", wl]);
		expect(clean.code).toBe(0);
		expect(clean.out).toContain(`removed worktree ${worktree}`);
		expect(existsSync(worktree)).toBe(false);
		expect(git(r.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName(wl)}`]).code).toBe(0);
		const none = lane(r, ["cleanup", wl]);
		expect(none.code).toBe(0);
		expect(none.out).toContain("no worktree at");
	}, 60_000);

	test("parked: an open question parks the lane (lane-parked: with the session), the shutdown writes no lane-died:; the answer relaunches with --resume of that session and the fake continues the recorded conversation; the stale request after the park is refused (predicate: resume consumed once)", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ tool: "lane_raise_question", args: { slice: sl, body: "push now?", options: ["yes", "no"], ask: "Should the lane push the branch now?" } }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const lane1 = laneIdOf(wl, 1);
		const exit1 = await exitOf(r, wl, lane1);
		expect(exit1).toMatchObject({ code: "0", signal: "-", outcome: "parked" });
		const snap1 = laneSnapshot(r, wl);
		expect(snap1.workload!.holder).toBeNull();
		expect(snap1.deaths).toEqual([]);
		const parked = snap1.control.find((c) => c.prefix === "lane-parked" && c.laneId === lane1)!;
		const session1 = fakeRecords(r)[0]!.session!;
		expect(parked.rest).toBe(`questions ${snap1.questions[0]!.id} session ${session1}`);
		// no new cause: a launch by hand is refused (died-not-relaunched) with nothing written
		const stale = lane(r, ["launch", wl, "--requested-by", "test"]);
		expect(stale.code).toBe(STARTER_EXIT["not-launchable"]);
		expect(stale.err).toContain("died-not-relaunched");
		// the drain lane 1's exit spawned has read the ledger and gone: the answer below is the relaunch's to take
		await drainSettled(r, lane1);
		const l = ledgerOf(r);
		l.answerQuestion(snap1.questions[0]!.id, { by: SURFACE_BY, answer: "yes", author: "jo", channel: "surface" });
		l.close();
		setScript(r, { steps: [{ tool: "lane_complete_slice", args: { slice: sl, artifact: "done" } }, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		const relaunch = lane(r, ["launch", wl, "--requested-by", "test"]);
		expect(relaunch.code).toBe(0);
		const lane2 = laneIdOf(wl, 2);
		const exit2 = await exitOf(r, wl, lane2);
		expect(exit2.outcome).toBe("completed");
		const snap2 = laneSnapshot(r, wl);
		expect(snap2.bodies.some((b) => b.startsWith(`${LANE_STARTER_BY} launch: ${lane2} cause resume `))).toBe(true);
		const rec2 = fakeRecords(r).filter((x) => x.argv)[1]!;
		expect(rec2.argv!.slice(-2)).toEqual(["--resume", session1]);
		expect(rec2.resumed).toBe(session1);
		const conversation = readFileSync(rec2.session!, "utf8");
		expect(conversation).toContain(`You are lane ${lane1} on workload ${wl}.`);
		expect(conversation).toContain(`"from":${JSON.stringify(session1)}`);
		// the resume prompt leads with the answer
		expect(conversation).toMatch(/"type":"message","role":"user","text":"[^"]*yes/);
		expect(snap2.slices[0]!.state).toBe("done");
		expect(snap2.workload!.holder).toBeNull();
		expect(snap2.deaths).toEqual([]);
	}, 60_000);

	test("resume-pending: the answer lands before the park, so the runner's outcome is resume-pending and the drain its exit spawns relaunches once with cause resume", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ tool: "lane_raise_question", args: { slice: sl, body: "q?", options: ["a", "b"], ask: "Should the probe take path a or path b?" } }, { sleepMs: 2500 }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const lane1 = laneIdOf(wl, 1);
		const q = await until("question", () => laneSnapshot(r, wl).questions[0]);
		const l = ledgerOf(r);
		l.answerQuestion(q.id, { by: SURFACE_BY, answer: "a", author: "jo", channel: "surface" });
		l.close();
		// lane 1's omp read its script at its start: this one is the relaunch's
		setScript(r, { steps: [{ tool: "lane_complete_slice", args: { slice: sl, artifact: "done" } }] });
		const exit1 = await exitOf(r, wl, lane1);
		expect(exit1.outcome).toBe("resume-pending");
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
		const lane2 = laneIdOf(wl, 2);
		await exitOf(r, wl, lane2);
		const snap = laneSnapshot(r, wl);
		const launches = snap.bodies.filter((b) => b.startsWith(`${LANE_STARTER_BY} launch: `));
		expect(launches.map((b) => b.split(" ")[4])).toEqual(["first", "resume"]);
		expect(launches[1]).toEndWith(" requested-by lane-runner");
		expect(fakeRecords(r).filter((x) => x.argv)[1]!.resumed).toBe(fakeRecords(r)[0]!.session!);
		expect(lane(r, ["launch", wl, "--requested-by", "tick"]).code).toBe(STARTER_EXIT["not-launchable"]);
	}, 60_000);

	test("repo facts (MIGRATION.md item 106): the prompt the fake omp receives carries the root's facts after the tools line and before the decision-log context, never another repo's; a relaunch after an m8-rollback drops that batch", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		// keyed exactly as prepare resolves the repo; another repo's fact must not reach this prompt
		const repo = git(r.repo, ["rev-parse", "--show-toplevel"]).out;
		const other = join(r.root, "other-repo");
		const l0 = ledgerOf(r);
		const m8 = l0.openWorkload({ by: SURFACE_BY, brief: "m8 facts", stakes: "normal", mode: "autonomous" });
		const fact = (n: number, tag: string, key: string, text: string) =>
			l0.recordEntry({ by: "m8-sedge", workloadId: m8, kind: "assumption", body: `m8-fact #${n} [${tag}] repo=${key} src=${key}/docs/notes.md:${n}-${n + 2} :: ${text}` });
		fact(11, "m8-tinker-wl-a", repo, "probe fact alpha: the rolled-back batch");
		fact(12, "m8-sedge-wl-b", repo, "probe fact beta: the batch that stays");
		fact(13, "m8-sedge-wl-b", other, "probe fact gamma: another repo");
		l0.close();
		// one valid decision-log entry, so the prompt has its decision-log section
		const now = new Date().toISOString();
		writeFileSync(
			join(r.repo, ".ai", "decision-log", `${now.slice(0, 10)}--${now.slice(11, 13)}${now.slice(14, 16)}--tester--facts-probe.md`),
			`---\nstatus: accepted\ndate: ${now}\n---\n## Decisions made\n- a synthetic decision for the facts probe\n`,
		);
		const promptOf = (n: number) => fakeRecords(r).filter((x) => x.event === "prompt")[n]!.message!;

		setScript(r, { steps: [{ tool: "lane_raise_question", args: { slice: sl, body: "go on?", options: ["yes", "no"], ask: "Should the probe go on?" } }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		expect((await exitOf(r, wl, laneIdOf(wl, 1))).outcome).toBe("parked");
		// the drain lane 1's exit spawned has read the ledger and gone: the answer below is the explicit relaunch's to take
		await drainSettled(r, laneIdOf(wl, 1));
		const first = promptOf(0);
		const tools = first.indexOf("Call `ledger_wake_read` first");
		const header = first.indexOf(`## Repo facts (${repo}): showing 2 of 2 under 8,000 bytes`);
		const alpha = first.indexOf("- probe fact alpha: the rolled-back batch (");
		const beta = first.indexOf("- probe fact beta: the batch that stays (");
		const log = first.indexOf("## Decision-log context");
		expect(tools).toBeGreaterThan(-1);
		expect(header).toBeGreaterThan(tools);
		expect(alpha).toBeGreaterThan(header);
		expect(beta).toBeGreaterThan(alpha);
		expect(log).toBeGreaterThan(beta);
		expect(first).toContain("a synthetic decision for the facts probe");
		expect(first).not.toContain("probe fact gamma");

		// the drain lane 1's exit spawned has read the ledger and gone: the answer below is the relaunch's to take
		await drainSettled(r, laneIdOf(wl, 1));
		const l = ledgerOf(r);
		l.recordEntry({ by: "m8-tinker", workloadId: m8, kind: "assumption", body: "m8-rollback [m8-tinker-wl-a] synthetic batch withdrawn" });
		l.answerQuestion(laneSnapshot(r, wl).questions[0]!.id, { by: SURFACE_BY, answer: "yes", author: "jo", channel: "surface" });
		l.close();
		setScript(r, { steps: [{ tool: "lane_complete_slice", args: { slice: sl, artifact: "done" } }, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		expect((await exitOf(r, wl, laneIdOf(wl, 2))).outcome).toBe("completed");
		const second = promptOf(1);
		const header2 = second.indexOf(`## Repo facts (${repo}): showing 1 of 1 under 8,000 bytes`);
		expect(header2).toBeGreaterThan(second.indexOf("Call `ledger_wake_read` first"));
		expect(second.indexOf("- probe fact beta: the batch that stays (")).toBeGreaterThan(header2);
		expect(second.indexOf("## Decision-log context")).toBeGreaterThan(header2);
		expect(second).not.toContain("probe fact alpha");
		expect(second).not.toContain("probe fact gamma");
	}, 60_000);

	test("the shell-start hooks reach a lane's omp unless the installed profile's clean-shell switch is on for its workload (review r1 finding 2: off is main's env)", async () => {
		// One root per launch: a lane's exit spawns the drain (MIGRATION.md item 71), which would start a second
		// open workload in the same root itself, so the explicit launch below would find it held.
		const hooksOf = async (listed: boolean): Promise<string[] | undefined> => {
			const r = makeRoot({ BASH_ENV: "/dev/null", CDPATH: "/nonexistent-cdpath" });
			const wl = openWorkload(r, { brief: listed ? "listed" : "not listed" }).wl;
			writeFileSync(join(r.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml"), `setupVersion: 2\ngates:\n  cleanShell:\n    - ${listed ? wl : "wl-another"}\n`);
			setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
			const launched = lane(r, ["launch", wl, "--requested-by", "test"]);
			expect({ code: launched.code, err: launched.err }).toMatchObject({ code: STARTER_EXIT.ok });
			expect((await exitOf(r, wl, laneIdOf(wl, 1))).outcome).toBe("completed");
			return fakeRecords(r).find((x) => x.env?.AGENT_SYSTEM_WORKLOAD_ID === wl && x.argv)?.hooks;
		};
		expect(await hooksOf(true)).toEqual([]);
		expect(await hooksOf(false)).toEqual(["BASH_ENV", "CDPATH"]);
	}, 60_000);
});

describe("lane script: every exit is classified (decision 14; Codex review B1, B2, B3, B4)", () => {
	test("B1 never-claims: valid rpc frames without the lane's claim → SIGKILL at the readiness window, launch-failed: + lane-died:, lease released, no prompt sent", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		setScript(r, { claim: false, steps: [] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		const t0 = Date.now();
		const exit = await exitOf(r, wl, laneId);
		expect(Date.now() - t0).toBeLessThan(20_000);
		expect(exit).toMatchObject({ signal: "SIGKILL", outcome: "never-ready" });
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([`lane-died: ${laneId}: launch failed at readiness: no claim in 4s`]);
		expect(snap.bodies.some((b) => b.startsWith(`${LANE_RUNNER_BY} launch-failed: ${laneId} readiness: never ready in 4s`))).toBe(true);
		// Codex review 2 R4: the runner's readiness failure is a valid control entry, not only a raw body
		expect(snap.control.filter((c) => c.prefix === "launch-failed" && c.laneId === laneId).map((c) => c.createdBy)).toEqual([LANE_RUNNER_BY]);
		expect(snap.control.some((c) => c.prefix === "lane-ready")).toBe(false);
		const [rec] = fakeRecords(r);
		expect(eventsOf(r, rec!.pid)).toEqual([]);
		expect(readFileSync(rec!.session!, "utf8")).not.toContain("You are lane");
		// the pre-claim was never renewed: the lease the starter set is the one the row still shows (lapsed or cleared), and changed_by never became the lane
		expect(snap.workload!.changed_by).not.toBe(laneId);
	}, 30_000);

	test("B3 before the spawn: the runner fails in prepare (no repo: entry) → launch-failed: + lane-died: from the starter path, released, exit repo-or-fence", async () => {
		const r = makeRoot();
		const l = ledgerOf(r);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "no repo", stakes: "normal", mode: "autonomous" });
		const res = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
		l.close();
		if (!res.ok) throw new Error(res.reason);
		const run = lane(r, ["run", wl, res.laneId]);
		expect(run.code).toBe(STARTER_EXIT["repo-or-fence"]);
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([`lane-died: ${res.laneId}: launch failed at preflight: workload ${wl} records no repository`]);
		expect(snap.bodies).toContain(`${LANE_STARTER_BY} launch-failed: ${res.laneId} preflight: workload ${wl} records no repository`);
		expect(fakeRecords(r)).toEqual([]);
	}, 30_000);

	test("B3 after the spawn: a thrown exception in the read loop (the lane dir removed under the runner) kills omp and finalizes once: lane-died:, released, one lane-exit:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ sleepMs: 2000 }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const started = (await startedOf(r, wl, laneId))!;
		rmSync(laneDir(wl, r.home), { recursive: true, force: true });
		const exit = await exitOf(r, wl, laneId);
		expect(exit).toMatchObject({ signal: "SIGKILL", outcome: "died" });
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([`lane-died: ${laneId}: died (signal SIGKILL)`]);
		expect(snap.control.filter((c) => c.prefix === "lane-exit" && c.laneId === laneId)).toHaveLength(1);
		await until("runner gone", () => !alive(started.runnerPid), 10_000);
		expect(alive(started.pid)).toBe(false);
	}, 30_000);

	test("R2 (review 2): the lane claims but the runner's lane-ready: write fails → no prompt, no renewal: omp is killed and the runner finalizes once (launch-failed: naming the failure, lane-died:, released, lane-exit: never-ready)", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		failEntryInsert(r, "lane-ready:", "injected ready write failure");
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, laneId))!;
		const exit = await until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId), 15_000);
		expect(exit).toMatchObject({ signal: "SIGKILL", outcome: "never-ready" });
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toHaveLength(1);
		expect(snap.deaths[0]).toMatch(new RegExp(`^lane-died: ${laneId}: launch failed at readiness: .*injected ready write failure`));
		const failed = snap.control.filter((c) => c.prefix === "launch-failed" && c.laneId === laneId);
		expect(failed).toHaveLength(1);
		expect(failed[0]!.rest).toMatch(/^readiness: .*injected ready write failure/);
		expect(snap.control.filter((c) => c.prefix === "lane-exit" && c.laneId === laneId)).toHaveLength(1);
		expect(eventsOf(r, started.pid)).toEqual([]);
		await until("runner gone", () => !alive(started.runnerPid), 10_000);
		expect(alive(started.pid)).toBe(false);
	}, 40_000);

	test("died: omp exits mid-prompt with no prompt_result → lane-died: (exit code kept), released; SIGKILLed from outside → lane-died: within 5 s", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ exit: 3 }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const lane1 = laneIdOf(wl, 1);
		const exit1 = await exitOf(r, wl, lane1);
		expect(exit1).toMatchObject({ code: "3", signal: "-", outcome: "died" });
		expect(laneSnapshot(r, wl).deaths).toEqual([`lane-died: ${lane1}: died (exit 3)`]);
		expect(laneSnapshot(r, wl).workload!.holder).toBeNull();
		await drainSettled(r, lane1);

		const l = ledgerOf(r);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `launch-requested: by jo at ${l.now()}` });
		l.close();
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", wl, "--requested-by", "jo"]).code).toBe(0);
		const lane2 = laneIdOf(wl, 2);
		await readyOf(r, wl, lane2);
		const started = (await startedOf(r, wl, lane2))!;
		const t0 = Date.now();
		process.kill(started.pid, "SIGKILL");
		const exit2 = await exitOf(r, wl, lane2);
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(exit2).toMatchObject({ signal: "SIGKILL", outcome: "died" });
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([`lane-died: ${lane1}: died (exit 3)`, `lane-died: ${lane2}: died (signal SIGKILL)`]);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.bodies.filter((b) => b.startsWith(`${LANE_STARTER_BY} launch: `)).map((b) => b.split(" ")[4])).toEqual(["first", "request"]);
	}, 40_000);

	test("B4 stop from the ledger: acceptance persisted, then abort → stdin EOF → SIGKILL after the grace when omp ignores both; outcome stop, no lane-died:, released", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ hang: true }], ignoreAbort: true, ignoreEof: true });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const started = (await startedOf(r, wl, laneId))!;
		const t0 = Date.now();
		const stop = lane(r, ["stop", wl]);
		const ms = Date.now() - t0;
		expect(stop.code).toBe(0);
		expect(stop.out).toContain(`stop requested of ${laneId}`);
		expect(stop.out).toContain(`${laneId} exited`);
		const snap = laneSnapshot(r, wl);
		const exit = laneExit(snap.control, laneId)!;
		// Codex review 2 R6: the exit carries the accepted request's reason
		expect(exit).toMatchObject({ signal: "SIGKILL", outcome: "stop", reason: "as2-lane-stop" });
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
		// the request (starter) then the acceptance (runner) naming it, both before the final spend: and the exit
		const stops = snap.control.filter((c) => c.prefix === "lane-stop" && c.laneId === laneId);
		expect(stops.map((s) => s.createdBy)).toEqual([LANE_STARTER_BY, LANE_RUNNER_BY]);
		expect(stops[1]!.rest).toBe(`accepted ${stops[0]!.id}`);
		expect(snap.control.filter((c) => c.prefix !== "ctx-index").map((c) => c.prefix).slice(-4)).toEqual(["lane-stop", "lane-stop", "spend", "lane-exit"]);
		// abort, then EOF, then the kill: omp saw both frames and outlived them until the grace ran out
		expect(eventsOf(r, started.pid)).toEqual(["prompt", "abort", "eof"]);
		expect(ms).toBeGreaterThanOrEqual(1500);
		expect(ms).toBeLessThan(20_000);
		expect(alive(started.pid)).toBe(false);
	}, 40_000);

	test("B4 stop from a signal: SIGTERM to the runner persists `accepted signal`, abort ends the prompt, outcome stop, no lane-died:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const started = (await startedOf(r, wl, laneId))!;
		process.kill(started.runnerPid, "SIGTERM");
		const exit = await exitOf(r, wl, laneId);
		expect(exit).toMatchObject({ code: "0", signal: "-", outcome: "stop", reason: "signal" });
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.bodies).toContain(`${LANE_RUNNER_BY} lane-stop: ${laneId} accepted signal`);
		expect(eventsOf(r, started.pid)).toEqual(["prompt", "abort", "eof"]);
	}, 30_000);

	test("R5 (review 2): the session record that lands after an accepted stop keeps the stop intended — the shutdown with a slice open writes no lane-died:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		// get_state answers only when the abort arrives and the shutdown waits after EOF: the runner's lane-started: with the
		// session follows its acceptance and lands before the lane row's shutdown classifies the exit
		setScript(r, { steps: [{ hang: true }], stateOnAbort: true, eofDelayMs: 700 });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const l = ledgerOf(r);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(laneId, "mode-flip", "jo") });
		l.close();
		const exit = await exitOf(r, wl, laneId);
		// Codex review 2 R6: decision 6's receipt, `outcome stop reason mode-flip`
		expect(exit).toMatchObject({ outcome: "stop", reason: "mode-flip" });
		const snap = laneSnapshot(r, wl);
		const mine = snap.control.filter((c) => c.laneId === laneId);
		const accepted = mine.findIndex((c) => c.prefix === "lane-stop" && c.rest.startsWith("accepted"));
		const withSession = mine.findIndex((c) => c.prefix === "lane-started" && !c.rest.includes('"session":null'));
		expect(accepted).toBeGreaterThanOrEqual(0);
		expect(withSession).toBeGreaterThan(accepted);
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
	}, 30_000);

	test("stop with no runner alive: the starter accepts the request itself, signals omp only when the pid's start time matches, releases, writes lane-exit: stop reason by-hand", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const started = (await startedOf(r, wl, laneId))!;
		process.kill(started.runnerPid, "SIGKILL");
		await until("runner gone", () => !alive(started.runnerPid), 10_000);
		// omp lives on with EOF on its stdin: the fake shuts down at EOF, releasing through the lane row
		await until("omp gone", () => !alive(started.pid), 10_000);
		const stop = lane(r, ["stop", wl]);
		expect(stop.code).toBe(0);
		expect(stop.out).toContain(`omp pid ${started.pid} is gone`);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, laneId)).toMatchObject({ code: "-", signal: "-", outcome: "stop", reason: "by-hand" });
		expect(snap.workload!.holder).toBeNull();
		expect(snap.bodies).toContain(`${LANE_STARTER_BY} lane-stop: ${laneId} requested as2-lane-stop by jo`);
		// the stop wrote the exit, so its worker claims the ctx index after it (the runner is dead and spawns none)
		const rows = await ctxIndexOf(r, wl, laneId);
		expect(rows.map((c) => c.createdBy)).toEqual([LANE_STARTER_BY, LANE_STARTER_BY]);
		expect(rows[0]!.rest).toMatch(/^claimed \d+$/);
		const ids = laneSnapshot(r, wl).control.map((c) => c.id);
		expect(ids.indexOf(rows[0]!.id)).toBeGreaterThan(ids.indexOf(snap.control.find((c) => c.prefix === "lane-exit" && c.laneId === laneId)!.id));
	}, 30_000);

	test("takeover (finding r3-1): a stop that takes over from a runner alive but not answering (SIGSTOPped) writes the exit and its worker claims the ctx index; the runner, continued, finalizes and its worker finds the claim taken", async () => {
		const r = makeRoot();
		const ctx = fakeCtx(r);
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const started = (await startedOf(r, wl, laneId))!;
		process.kill(started.runnerPid, "SIGSTOP");
		// the runner is alive (ps finds it) and writes nothing: the stop waits its 60 s, then accepts and ends omp itself.
		// The runner stays stopped until the stop's worker has written its claim and outcome: the claim is first-come, and a
		// runner continued earlier races that worker for it (alone, the runner won; Plumb's round 2 at 2804be6).
		const { stop, rows } = await (async () => {
			try {
				const stop = lane(r, ["stop", wl]);
				const rows: ControlEntry[] = stop.code === 0 ? await ctxIndexOf(r, wl, laneId) : [];
				return { stop, rows };
			} finally {
				process.kill(started.runnerPid, "SIGCONT");
			}
		})();
		expect(stop.code).toBe(0);
		expect(stop.out).not.toContain(`${laneId} exited`);
		const exit = laneSnapshot(r, wl).control.find((c) => c.prefix === "lane-exit" && c.laneId === laneId)!;
		expect(exit).toMatchObject({ createdBy: LANE_STARTER_BY });
		expect(rows.map((c) => c.createdBy)).toEqual([LANE_STARTER_BY, LANE_STARTER_BY]);
		expect(rows[0]!.rest).toMatch(/^claimed \d+$/);
		const ids = laneSnapshot(r, wl).control.map((c) => c.id);
		expect(ids.indexOf(rows[0]!.id)).toBeGreaterThan(ids.indexOf(exit.id));
		// the continued runner sees omp gone, finalizes (the exit already written) and spawns its own worker: refused the claim, it does nothing
		await until("runner gone", () => !alive(started.runnerPid), 20_000);
		await until("the runner's worker", () => readFileSync(join(laneDir(wl, r.home), "ctx-index.log"), "utf8").includes(`${laneId}: another worker holds the claim`));
		expect(laneSnapshot(r, wl).control.filter((c) => c.prefix === "ctx-index" && c.laneId === laneId)).toHaveLength(2);
		expect(laneSnapshot(r, wl).control.filter((c) => c.prefix === "lane-exit" && c.laneId === laneId)).toHaveLength(1);
		expect(existsSync(ctx.log)).toBe(false);
	}, 120_000);

	test("startTime: a zombie (exited, its parent not reaping) is gone, its live parent is not, and the start time is spelled as `ps -o lstart=` spells it", async () => {
		// sh forks `sleep 0` and execs into `sleep 5`, which never waits: the finished child stays a zombie of a live parent
		const parent = Bun.spawn(["sh", "-c", "sleep 0 & echo $!; exec sleep 5"], { stdout: "pipe" });
		try {
			const reader = parent.stdout.getReader();
			const zombie = Number(new TextDecoder().decode((await reader.read()).value).trim());
			expect(zombie).toBeGreaterThan(0);
			await until("the child is a zombie", () => sh(["ps", "-p", String(zombie), "-o", "stat="], process.cwd()).out.startsWith("Z"), 5_000);
			expect(laneScript.startTime(zombie)).toBeNull();
			expect(laneScript.startTime(parent.pid)).toBe(sh(["ps", "-p", String(parent.pid), "-o", "lstart="], process.cwd()).out);
		} finally {
			parent.kill("SIGKILL");
			await parent.exited;
		}
	}, 15_000);

	test("ctx index (MIGRATION.md item 43): a completed lane's runner spawns the worker after lane-exit:; it claims, resolves this lane's own session id, and under the temp HOME skips at the home guard with no ctx call", async () => {
		const r = makeRoot();
		const ctx = fakeCtx(r);
		// a ctx call from the worker would resolve to the fake, not a real ctx
		expect(sh(["sh", "-c", "command -v ctx"], r.root, r.env).out).toBe(ctx.bin);
		const { wl } = openWorkload(r);
		setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "completed" });
		const rows = await ctxIndexOf(r, wl, laneId);
		const [rec] = fakeRecords(r);
		const head: unknown = JSON.parse(readFileSync(rec!.session!, "utf8").split("\n")[1]!);
		const uuid = typeof head === "object" && head !== null && "type" in head && head.type === "session" && "id" in head && typeof head.id === "string" ? head.id : null;
		expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
		expect(rows.map((c) => [c.createdBy, c.rest.replace(/^claimed \d+$/, "claimed")])).toEqual([[LANE_RUNNER_BY, "claimed"], [LANE_RUNNER_BY, `skipped ${uuid} home-guard`]]);
		const ids = laneSnapshot(r, wl).control.map((c) => c.id);
		expect(ids.indexOf(rows[0]!.id)).toBeGreaterThan(ids.indexOf(laneSnapshot(r, wl).control.find((c) => c.prefix === "lane-exit" && c.laneId === laneId)!.id));
		expect(existsSync(ctx.log)).toBe(false);
		expect(readFileSync(join(laneDir(wl, r.home), "ctx-index.log"), "utf8")).toContain(`ctx-index: ${laneId} skipped ${uuid} home-guard`);
	}, 60_000);

	test("R1 (review 2): stop with no runner and an omp that survives SIGTERM → the stop escalates to SIGKILL on the same verified process and releases only after it is gone", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ hang: true }], ignoreEof: true, ignoreTerm: true });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const started = (await startedOf(r, wl, laneId))!;
		process.kill(started.runnerPid, "SIGKILL");
		await until("runner gone", () => !alive(started.runnerPid), 10_000);
		expect(alive(started.pid)).toBe(true);
		const stop = lane(r, ["stop", wl]);
		// the moment the stop returns (its release and exit already written), the omp it stopped is gone
		const ompAlive = alive(started.pid);
		if (ompAlive) process.kill(started.pid, "SIGKILL");
		expect(ompAlive).toBe(false);
		expect(stop.code).toBe(0);
		expect(eventsOf(r, started.pid)).toContain("sigterm");
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, laneId)).toMatchObject({ outcome: "stop", reason: "by-hand" });
		expect(snap.control.filter((c) => c.prefix === "lane-exit" && c.laneId === laneId)).toHaveLength(1);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([]);
	}, 30_000);

	test("interactive (B5): the wrapper records omp's pid; a stop accepted by hand while the TUI runs (its exit and release written, omp signalled) leaves one lane-exit: for the lane, the by-hand one, not a second from the wrapper", async () => {
		const r = makeRoot();
		const l = ledgerOf(r);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "interactive by-hand stop probe", stakes: "normal", mode: "user-driven" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		l.close();
		setScript(r, { steps: [{ hang: true }] });
		// The TUI's stdio is inherited from the wrapper: a pipe held open stands in for Jo's terminal.
		const tui = Bun.spawn(["bun", LANE_SCRIPT, "interactive", wl], { cwd: r.repo, env: r.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const laneId = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, laneId))!;
		expect(started.pid).not.toBe(tui.pid);
		expect(started.runnerPid).toBe(tui.pid);
		await until("the lane's own claim", () => laneSnapshot(r, wl).workload?.changed_by === laneId);
		// What `lane.ts stop` leaves after its wait for a runner that is not there: acceptance, release, the by-hand exit, SIGTERM to omp.
		const l2 = ledgerOf(r);
		const req = l2.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(laneId, "as2-lane-stop", "jo") });
		l2.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopAcceptedBody(laneId, req) });
		expect(l2.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: laneId }).released).toBe(true);
		l2.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: null, signal: null, outcome: "stop", reason: "by-hand" }) });
		l2.close();
		process.kill(started.pid, "SIGTERM");
		const code = await tui.exited;
		tui.stdin.end();
		expect(code).toBe(0);
		const snap = laneSnapshot(r, wl);
		expect(snap.bodies.filter((b) => b.includes(`lane-exit: ${laneId} `))).toEqual([`${LANE_STARTER_BY} ${laneExitBody(laneId, { code: null, signal: null, outcome: "stop", reason: "by-hand" })}`]);
		expect(laneExit(snap.control, laneId)).toMatchObject({ outcome: "stop", reason: "by-hand" });
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([]);
	}, 30_000);

	test("R1 (review 2), interactive: a by-hand stop accepted but not yet finalized (it waits to see omp gone) → the wrapper writes the one exit as outcome stop reason by-hand with omp's real code, and releases", async () => {
		const r = makeRoot();
		const l = ledgerOf(r);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "interactive accepted stop probe", stakes: "normal", mode: "user-driven" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		l.close();
		setScript(r, { steps: [{ hang: true }] });
		const tui = Bun.spawn(["bun", LANE_SCRIPT, "interactive", wl], { cwd: r.repo, env: r.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const laneId = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, laneId))!;
		await until("the lane's own claim", () => laneSnapshot(r, wl).workload?.changed_by === laneId);
		// `lane.ts stop` state at the moment it signals: request and acceptance written, no release, no exit yet.
		const l2 = ledgerOf(r);
		const req = l2.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(laneId, "as2-lane-stop", "jo") });
		l2.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopAcceptedBody(laneId, req) });
		l2.close();
		process.kill(started.pid, "SIGTERM");
		await tui.exited;
		tui.stdin.end();
		const snap = laneSnapshot(r, wl);
		expect(snap.control.filter((c) => c.prefix === "lane-exit" && c.laneId === laneId)).toHaveLength(1);
		expect(laneExit(snap.control, laneId)).toMatchObject({ code: "0", outcome: "stop", reason: "by-hand" });
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([]);
	}, 30_000);

	test("R3 (review 2): interactive, the first lane-started: write fails after the spawn → the wrapper terminates and reaps omp before it records the failure and releases; no omp outlives it", async () => {
		const r = makeRoot();
		const l = ledgerOf(r);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "interactive post-spawn failure probe", stakes: "normal", mode: "user-driven" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		l.close();
		failEntryInsert(r, "lane-started:", "injected start write failure");
		setScript(r, { steps: [{ hang: true }] });
		// A pipe held open stands in for Jo's terminal: omp's stdin never reaches EOF while the test holds it.
		const tui = Bun.spawn(["bun", LANE_SCRIPT, "interactive", wl], { cwd: r.repo, env: r.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const laneId = laneIdOf(wl, 1);
		const code = await tui.exited;
		// anything still running with this root on its command line is an omp the wrapper left behind
		const leftover = sh(["pgrep", "-f", r.root], r.root).out;
		sh(["pkill", "-f", r.root], r.root);
		tui.stdin.end();
		expect(code).toBe(STARTER_EXIT.unknown!);
		expect(leftover).toBe("");
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.bodies.some((b) => b.startsWith(`${LANE_STARTER_BY} launch-failed: ${laneId} interactive: `) && b.includes("injected start write failure"))).toBe(true);
		expect(snap.deaths).toHaveLength(1);
	}, 40_000);

	test("deadline: --max-time from AGENT_SYSTEM_LANE_MAX_TIME reaches omp's argv; the aborted prompt_result past it is outcome deadline; the open slice makes it a death (one lane-died:), released", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_MAX_TIME: "2s" });
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		const exit = await exitOf(r, wl, laneId);
		expect(exit).toMatchObject({ code: "0", signal: "-", outcome: "deadline" });
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toHaveLength(1);
		expect(snap.deaths[0]).toMatch(new RegExp(`^lane-died: ${laneId}: (deadline 2s with 1 open slice\\(s\\)|session shutdown at .* with 1 open slice\\(s\\))$`));
		const [rec] = fakeRecords(r);
		expect(rec!.argv!.slice(-2)).toEqual(["--max-time", "2s"]);
	}, 30_000);

	for (const status of ["aborted", "error"]) {
		test(`${status}: a prompt_result with that status before the deadline keeps it as the outcome; it is a death the runner writes before EOF (once: the lane row's shutdown adds none, MIGRATION.md item 40 D3/D5), released`, async () => {
			const r = makeRoot();
			const { wl } = openWorkload(r, { slice: true });
			setScript(r, { steps: [{ result: status }] });
			expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
			const laneId = laneIdOf(wl, 1);
			const exit = await exitOf(r, wl, laneId);
			expect(exit).toMatchObject({ code: "0", signal: "-", outcome: status });
			const snap = laneSnapshot(r, wl);
			expect(snap.workload!.holder).toBeNull();
			expect(snap.deaths).toEqual([`lane-died: ${laneId}: prompt ended ${status}`]);
		}, 30_000);
	}

	test("a runner's finalization is idempotent across the two writers: the lane row's shutdown death lands first and the runner writes no second lane-died:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		// the fake shuts down on SIGTERM without the runner: shutdown → lane row's lane-died: (slice open, no intended entry) → release; then the runner sees the exit
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await readyOf(r, wl, laneId);
		const started = (await startedOf(r, wl, laneId))!;
		process.kill(started.pid, "SIGTERM");
		const exit = await exitOf(r, wl, laneId);
		expect(exit.outcome).toBe("released");
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toHaveLength(1);
		expect(snap.deaths[0]).toMatch(new RegExp(`^lane-died: ${laneId}: session shutdown at .* with 1 open slice\\(s\\)$`));
		expect(snap.workload!.holder).toBeNull();
	}, 30_000);
});

describe("item 40: turn end with work open (PLAN wl-muq1v31q5ly7ls; T12 and T14 are in turn-end.test.ts and lane-tools.test.ts)", () => {
	const promptsOf = (r: LaneRoot) => fakeRecords(r).filter((x) => x.event === "prompt");
	const messagesOf = (r: LaneRoot, wl: string): string[] => {
		const l = ledgerOf(r);
		try {
			return l.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ? ORDER BY rowid").all(wl).map((m) => m.body);
		} finally {
			l.close();
		}
	};
	const note: FakeStep = { tool: "lane_record_entry", args: { body: "progress note" } };
	const openWork = (laneId: string) => `lane-died: ${laneId}: turn ended with open work after 2 continue prompts (no question, no done-because)`;
	/** The classifier's hand-spawn: as a fixture step writes it (as the lane), for a review on `slice`. */
	const spawnStep = (token: string, slice: string): FakeStep => ({
		ledger: { body: handSpawnBody({ token, root: "/tmp/lane", spawnKey: slice, review: true, group: `dg-${token}`, row: ["openai-codex/gpt-6-astra"] }), slice },
	});
	/** The classifier's settle: the routings row, then hand-settled: naming it. */
	const settleSteps = (token: string, slice: string): FakeStep[] => [{ ledger: { routing: { slice } } }, { ledger: { body: `hand-settled: ${token} routing $routing` } }];
	const launched = (r: LaneRoot, wl: string) => {
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		return laneIdOf(wl, 1);
	};

	test("T1: a slice open, the turn ends after a plain entry; continue 1 parks a question → two prompts on the same omp, parked, no lane-died:", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, { prompts: [[note], [{ tool: "lane_raise_question", args: { slice: sl, body: "which way?", options: ["a", "b"], ask: "Which way should the probe go, a or b?" } }]] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "parked" });
		const ps = promptsOf(r);
		expect(ps.map((p) => [p.id, p.pid])).toEqual([["p1", ps[0]!.pid], ["p2", ps[0]!.pid]]);
		expect(ps[1]!.message).toBe(`Your turn ended with work open on ${wl}: 1 open slice(s), 0 paused, no open question from you, no done-because receipt. Continue. If only Jo can decide, raise it with lane_raise_question. When the done line is met, record done-because and lane_release. (continue 1 of 2)`);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("T1z: occurrence 1, no slice at all: continue 1 names \"no slice cut\", adds the plan slice and parks a go/hold question → parked", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		setScript(r, {
			prompts: [
				[{ tool: "lane_record_entry", args: { body: "next step: add the judge-kind plan slice" } }],
				[{ tool: "lane_add_slice", args: { task: "plan", doneCondition: "the plan file", inputs: "the brief", kind: "judge" } }, { tool: "lane_raise_question", args: { slice: "$slice", body: "go?", options: ["go", "hold"], ask: "Should the probe go ahead or hold?" } }],
			],
		});
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "parked" });
		const ps = promptsOf(r);
		expect(ps.map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(ps[1]!.message).toContain(`Your turn ended on ${wl} with no slice cut`);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("T1z: no slice at all and every prompt just stops → three prompts, open-work, one lane-died:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		setScript(r, { steps: [note] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "open-work" });
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		expect(laneSnapshot(r, wl).deaths).toEqual([openWork(laneId)]);
	}, 60_000);

	test("T1c: no slice cut because the only slice was cancelled; every prompt stops → three prompts, open-work, one lane-died:", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		const l = ledgerOf(r);
		l.cancelSlice(sl!, { by: SURFACE_BY });
		l.close();
		setScript(r, { steps: [note] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "open-work" });
		const ps = promptsOf(r);
		expect(ps.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		expect(ps[2]!.message).toContain("with no slice cut");
		expect(laneSnapshot(r, wl).deaths).toEqual([openWork(laneId)]);
	}, 60_000);

	test("T1d (control): every slice done, no receipt, nothing parked → completed after one prompt, no lane-died:", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		const l = ledgerOf(r);
		l.completeSlice(sl!, { by: SURFACE_BY, artifact: "probed" });
		l.close();
		setScript(r, { steps: [note] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "completed" });
		expect(promptsOf(r)).toHaveLength(1);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("T2: a slice open, every prompt just stops → three prompts, open-work, exactly one lane-died: naming the continue prompts, released", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [note] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ code: "0", outcome: "open-work" });
		const ps = promptsOf(r);
		expect(ps.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		expect(ps[2]!.message).toEndWith("(continue 2 of 2)");
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([openWork(laneId)]);
		expect(snap.workload!.holder).toBeNull();
	}, 60_000);

	test("T3: occurrence 2, a background job with a slice open: the runner waits for session_settled, the woken turn completes, writes done-because and releases → no EOF before background-done, no lane-died:", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, {
			prompts: [
				[{ background: 1500 }],
				[{ tool: "lane_complete_slice", args: { slice: sl, artifact: "probed" } }, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }, { tool: "lane_release", args: {} }],
			],
		});
		const laneId = launched(r, wl);
		const exit = await exitOf(r, wl, laneId);
		// the fake shuts down on lane_release, so the runner sees omp gone (released) unless the settled frame lands first (completed)
		expect(["released", "completed"]).toContain(exit.outcome);
		const events = eventsOf(r, promptsOf(r)[0]!.pid);
		expect(events.indexOf("background-done")).toBeGreaterThan(0);
		expect(events).not.toContain("background-killed");
		if (events.includes("eof")) expect(events.indexOf("eof")).toBeGreaterThan(events.indexOf("background-done"));
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("T4: background work in flight and a stop request lands while unsettled → outcome stop, the job is killed, no lane-died:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { prompts: [[{ background: "never" }]] });
		const laneId = launched(r, wl);
		// the runner holds on omp's `sessionSettled: false` before the stop lands
		await until("the unsettled prompt_result", () => existsSync(join(laneDir(wl, r.home), "lane-1.jsonl")) && readFileSync(join(laneDir(wl, r.home), "lane-1.jsonl"), "utf8").includes('"sessionSettled":false'));
		const l = ledgerOf(r);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(laneId, "mode-flip", "jo") });
		l.close();
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "stop", reason: "mode-flip" });
		expect(eventsOf(r, promptsOf(r)[0]!.pid)).toContain("background-killed");
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("T4b (control): a slice open, a stop request, the lane's shutdown releases, then finish() → outcome stop, no lane-died: at all", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ hang: true }] });
		const laneId = launched(r, wl);
		await readyOf(r, wl, laneId);
		const l = ledgerOf(r);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(laneId, "mode-flip", "jo") });
		l.close();
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "stop" });
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
	}, 60_000);

	test("T5 (controls): a parked question, a done-because, and a release with nothing open each end after one prompt as today, no lane-died:", async () => {
		const question = makeRoot();
		const q = openWorkload(question, { slice: true });
		setScript(question, { steps: [{ tool: "lane_raise_question", args: { slice: q.sl, body: "which way?", options: ["a", "b"], ask: "Which way should the probe go, a or b?" } }] });
		expect(await exitOf(question, q.wl, launched(question, q.wl))).toMatchObject({ outcome: "parked" });
		expect(promptsOf(question)).toHaveLength(1);

		const receipt = makeRoot();
		const d = openWorkload(receipt);
		setScript(receipt, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		expect(await exitOf(receipt, d.wl, launched(receipt, d.wl))).toMatchObject({ outcome: "completed" });
		expect(promptsOf(receipt)).toHaveLength(1);

		const release = makeRoot();
		const e = openWorkload(release, { slice: true });
		setScript(release, { steps: [{ tool: "lane_complete_slice", args: { slice: e.sl, artifact: "probed" } }, { tool: "lane_release", args: {} }] });
		const laneId = launched(release, e.wl);
		expect(["completed", "released"]).toContain((await exitOf(release, e.wl, laneId)).outcome);
		expect(promptsOf(release)).toHaveLength(1);
		const snap = laneSnapshot(release, e.wl);
		expect(snap.control.filter((c) => c.prefix === "released-open")).toEqual([]);
		for (const [r, wl] of [[question, q.wl], [receipt, d.wl], [release, e.wl]] as const) expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 90_000);

	test("T15 (wl-mv049108m8whds): a slice open and the turn's done-because, no hand, no wake → completed after one prompt, the runner's lane-decided: before EOF, no lane-died: (N2's gap without D6)", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "completed" });
		expect(promptsOf(r)).toHaveLength(1);
		const snap = laneSnapshot(r, wl);
		expect(snap.control.filter((c) => c.prefix === "lane-decided").map((c) => [c.createdBy, c.body])).toEqual([[LANE_RUNNER_BY, `lane-decided: ${laneId} completed`]]);
		expect(snap.deaths).toEqual([]);
	}, 60_000);

	test("T6: D4, a slice open, no receipt, no question, then lane_release → released-open: with the release, outcome open-work, one lane-died: naming it", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { steps: [note, { tool: "lane_release", args: {} }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "open-work" });
		const snap = laneSnapshot(r, wl);
		expect(snap.control.filter((c) => c.prefix === "released-open").map((c) => [c.createdBy, c.body])).toEqual([[laneId, `released-open: ${laneId} slices 1`]]);
		expect(snap.deaths).toEqual([`lane-died: ${laneId}: released with 1 open slice(s), no done-because`]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	test("T6m: D4 masking, a previous lane's question never parked; the current lane releases with the slice open → released-open:, open-work, one lane-died:", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		const l = ledgerOf(r);
		l.raiseQuestion({ by: "lane-old-1", workloadId: wl, sliceId: sl!, body: "an older lane's question", options: ["a", "b"] });
		l.close();
		setScript(r, { steps: [{ tool: "lane_release", args: {} }] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "open-work" });
		const snap = laneSnapshot(r, wl);
		expect(snap.bodies).toContain(`${laneId} released-open: ${laneId} slices 1`);
		expect(snap.deaths).toEqual([`lane-died: ${laneId}: released with 1 open slice(s), no done-because`]);
	}, 60_000);

	for (const asked of [false, true]) {
		test(`T6h: lane_handoff with a slice open${asked ? " and a question the lane raised earlier" : ""} → released, no lane-parked:, no lane-died:`, async () => {
			const r = makeRoot();
			const { wl, sl } = openWorkload(r, { slice: true });
			const ask: FakeStep[] = asked ? [{ tool: "lane_raise_question", args: { slice: sl, body: "which way?", options: ["a", "b"], ask: "Which way should the probe go, a or b?" } }] : [];
			setScript(r, { steps: [...ask, { tool: "lane_handoff", args: {} }] });
			const laneId = launched(r, wl);
			expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "released" });
			const snap = laneSnapshot(r, wl);
			expect(snap.workload!.holder).toBe("jo");
			expect(snap.control.filter((c) => c.prefix === "lane-parked")).toEqual([]);
			expect(snap.deaths).toEqual([]);
		}, 60_000);
	}

	test("T7: a background job that never finishes and a short deadline → outcome deadline from the runner's own check, one lane-died: written before EOF with the in-flight suffix, no session shutdown death", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_MAX_TIME: "2s" });
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { prompts: [[{ background: "never" }]] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "deadline" });
		expect(laneSnapshot(r, wl).deaths).toEqual([`lane-died: ${laneId}: deadline 2s with 1 open slice(s); background work was in flight`]);
		expect(eventsOf(r, promptsOf(r)[0]!.pid)).toContain("background-killed");
	}, 60_000);

	test("T8: D6, the lane's hand-spawn: unsettled when it parks a question; continue 1 names the hand and its job, its settle lands, then parked", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, {
			prompts: [
				[spawnStep("dt-t8", sl!), { tool: "lane_raise_question", args: { slice: sl, body: "which way?", options: ["a", "b"], ask: "Which way should the probe go, a or b?" } }],
				settleSteps("dt-t8", sl!),
			],
		});
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "parked" });
		const ps = promptsOf(r);
		expect(ps.map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(ps[1]!.message).toStartWith(`Hand(s) dt-t8 (job ${sl}) you spawned have no result on the ledger yet.`);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("T9: D6, the hand never settles and every prompt stops → three prompts, one held-open message, the lane stays up until the deadline: outcome deadline, one lane-died:", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_MAX_TIME: "4s" });
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, { prompts: [[spawnStep("dt-t9", sl!)]] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "deadline" });
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		expect(messagesOf(r, wl).filter((m) => m.includes("is held open"))).toEqual([`lane ${laneId} is held open: hand(s) dt-t9 unsettled after 2 continue prompts; it ends at a stop, the ceiling or the deadline`]);
		expect(laneSnapshot(r, wl).deaths).toEqual([`lane-died: ${laneId}: deadline 4s with 1 open slice(s)`]);
	}, 60_000);

	test("T10: D3/D6 precedence, a prompt ends error with the lane's hand unsettled → no EOF and no release before the settle, then outcome error (never completed)", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, { prompts: [[spawnStep("dt-t10", sl!), { result: "error" }], settleSteps("dt-t10", sl!)] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "error" });
		const events = eventsOf(r, promptsOf(r)[0]!.pid);
		expect(events.slice(0, 3)).toEqual(["prompt", "prompt", "eof"]);
		const snap = laneSnapshot(r, wl);
		const settledAt = snap.bodies.findIndex((b) => b.includes("hand-settled: dt-t10 routing"));
		const exitAt = snap.bodies.findIndex((b) => b.startsWith(`${LANE_RUNNER_BY} lane-exit: ${laneId}`));
		expect(settledAt).toBeGreaterThan(0);
		expect(exitAt).toBeGreaterThan(settledAt);
		expect(snap.deaths).toEqual([`lane-died: ${laneId}: prompt ended error`]);
	}, 60_000);

	for (const [row, steps, outcome, death] of [
		["T11", [note], "open-work", "turn ended with open work after 2 continue prompts (no question, no done-because)"],
		["T13", [{ result: "error" }], "error", "prompt ended error"],
	] as const) {
		test(`${row}: a stop that lands after the runner decided ${outcome} (EOF delayed 1 s) is accepted and recorded, and the decided outcome stands with exactly one lane-died:`, async () => {
			const r = makeRoot();
			const { wl } = openWorkload(r, { slice: true });
			setScript(r, { steps: [...steps], eofDelayMs: 1000 });
			const laneId = launched(r, wl);
			const started = (await startedOf(r, wl, laneId))!;
			await until("the runner's death line", () => laneSnapshot(r, wl).deaths.length > 0, 30_000);
			process.kill(started.runnerPid, "SIGTERM");
			expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome });
			const snap = laneSnapshot(r, wl);
			expect(snap.deaths).toEqual([`lane-died: ${laneId}: ${death}`]);
			expect(snap.bodies).toContain(`${LANE_RUNNER_BY} lane-stop: ${laneId} accepted signal`);
		}, 60_000);
	}

	test("B1 (review round 1): a woken turn releases with the slice open and omp shuts down before any session_settled → finish() reads the released-open: marker: open-work, exactly one lane-died: naming the release", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		setScript(r, { prompts: [[{ background: 1500 }], [note, { tool: "lane_release", args: {} }]] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "open-work" });
		const snap = laneSnapshot(r, wl);
		expect(snap.control.filter((c) => c.prefix === "released-open").map((c) => c.body)).toEqual([`released-open: ${laneId} slices 1`]);
		expect(snap.deaths).toEqual([`lane-died: ${laneId}: released with 1 open slice(s), no done-because`]);
		expect(promptsOf(r)).toHaveLength(1);
		expect(eventsOf(r, promptsOf(r)[0]!.pid)).toContain("background-done");
	}, 60_000);

	/** The `isSettled` of each settle-check get_state reply in the runner's frames file (D6's hold → settle → decide). */
	const settleChecks = (r: LaneRoot, wl: string, id = "settle-check"): unknown[] =>
		readFileSync(join(laneDir(wl, r.home), "lane-1.jsonl"), "utf8").split("\n").filter((l) => l.includes(`"id":"${id}"`)).map((l) => {
			const frame: unknown = JSON.parse(l);
			const data = frame && typeof frame === "object" && "data" in frame ? frame.data : null;
			return data && typeof data === "object" && "isSettled" in data ? data.isSettled : null;
		});

	test("N2 (review round 1), D6 recovery: held for the hand, whose settle lands in a woken turn still running → the settle-check get_state answers isSettled false, and the runner decides only at session_settled (the question the turn raises after it parks the lane)", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		// the stop poll (5 s) sees the settle inside the woken turn's 7 s sleep; a decision at the get_state would be open-work
		const woken: FakeStep[] = [...settleSteps("dt-n2", sl!), { sleepMs: 7000 }, { tool: "lane_raise_question", args: { slice: sl, body: "which way?", options: ["a", "b"], ask: "Which way should the probe go, a or b?" } }];
		setScript(r, { prompts: [[spawnStep("dt-n2", sl!), { wake: { ms: 3000, steps: woken } }]], steps: [note] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "parked" });
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		expect(messagesOf(r, wl).filter((m) => m.includes("is held open"))).toHaveLength(1);
		expect(eventsOf(r, promptsOf(r)[0]!.pid)).toContain("wake");
		expect(settleChecks(r, wl)).toEqual([false]);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("N2 (review round 1), D6 recovery: held for the hand, whose settle lands in a woken turn that has already ended → the settle-check get_state answers isSettled true and the runner decides at once: the turn's receipt completes the lane", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		const woken: FakeStep[] = [...settleSteps("dt-n2t", sl!), { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }];
		setScript(r, { prompts: [[spawnStep("dt-n2t", sl!), { wake: { ms: 3000, steps: woken } }]], steps: [note] });
		const laneId = launched(r, wl);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "completed" });
		expect(promptsOf(r).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		expect(settleChecks(r, wl)).toEqual([true]);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("D6 (PLAN wl-mv5i3lulwwbbi8): a background job that never settles and no omp frame for the idle wait → the idle check's get_state answers isSettled false and the lane gets the idle prompt, not an endless hold; it completes its slice, records done-because and releases → no lane-died:", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_SETTLE_IDLE_MS: "2000" });
		const { wl, sl } = openWorkload(r, { slice: true });
		setScript(r, {
			prompts: [
				[{ background: "never" }],
				[{ tool: "lane_complete_slice", args: { slice: sl, artifact: "probed" } }, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }, { tool: "lane_release", args: {} }],
			],
		});
		const laneId = launched(r, wl);
		expect(["completed", "released"]).toContain((await exitOf(r, wl, laneId)).outcome);
		const prompts = promptsOf(r);
		expect(prompts.map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(prompts[1]!.message).toStartWith(`Your session on ${wl} has background work pending and no activity for 2 s:`);
		expect(prompts[1]!.message).toEndWith("(idle prompt 1 of 2)");
		expect(settleChecks(r, wl, "idle-check")).toEqual([false]);
		expect(messagesOf(r, wl).filter((m) => m.includes("is held open"))).toEqual([]);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);

	test("D8 (PLAN wl-mv5i3lulwwbbi8): a live test run (a test-requested: with a fresh heartbeat, no result) when the open slice's prompts stop → continues naming the run, then held open for it, never open-work; its test-run: lands → the hold releases and the woken turn's receipt completes the lane", async () => {
		const r = makeRoot();
		const { wl, sl } = openWorkload(r, { slice: true });
		const runId = "tr-0d8live1";
		const sha = "a".repeat(40);
		const l = ledgerOf(r);
		l.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl!, kind: "assumption", body: testRequestedBody({ runId, pr: 17, sha, slice: sl!, by: "lane-x" }) });
		l.close();
		const dir = runDirOf(runsRoot(r.env), runId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "heartbeat"), heartbeatText(runId, Date.now()));
		setScript(r, { prompts: [[note], [note], [{ wake: { ms: 1000, steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] } }]] });
		const laneId = launched(r, wl);
		const held = `lane ${laneId} is held open: test run(s) ${runId} live after 2 continue prompts; it ends at a stop, the ceiling or the deadline`;
		await until("the held-open message", () => messagesOf(r, wl).includes(held));
		const prompts = promptsOf(r);
		expect(prompts.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		expect(prompts[1]!.message).toStartWith(`Test run(s) ${runId} on ${wl} have no result on the ledger yet;`);
		expect(laneExit(laneSnapshot(r, wl).control, laneId)).toBeNull();
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
		// the woken turn's receipt first, so the result is what releases the hold
		await until("the woken turn's done-because:", () => {
			const l1 = ledgerOf(r);
			try {
				return l1.entries(wl).some((e) => e.body.startsWith("done-because:"));
			} finally {
				l1.close();
			}
		});
		const l2 = ledgerOf(r);
		l2.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption",
			body: testRunBody({
				runId, verdict: "error", sha, pr: 17, reason: "runner died", headAtEnd: sha, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
		l2.close();
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "completed" });
		expect(messagesOf(r, wl).filter((m) => m.includes("is held open"))).toEqual([held]);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
	}, 60_000);
});

describe("lane script: the worktree base is origin/<default>, local <default> only with no origin (Jo's unpushed commits never enter a lane branch)", () => {
	const commitIn = (repo: string, file: string): string => {
		writeFileSync(join(repo, file), `${file}\n`);
		for (const args of [["add", file], ["commit", "-q", "-m", file]]) expect(git(repo, args).code).toBe(0);
		return git(repo, ["rev-parse", "HEAD"]).out;
	};
	/** A commit on the remote the checkout has not fetched yet: made in a second clone and pushed from there. */
	const pushFromElsewhere = (r: LaneRoot): string => {
		const other = join(r.root, "other");
		expect(sh(["git", "clone", "-q", r.remote, other], r.root).code).toBe(0);
		for (const args of [["config", "user.email", "o@example.invalid"], ["config", "user.name", "o"]]) git(other, args);
		const sha = commitIn(other, "remote.txt");
		expect(git(other, ["push", "-q", "origin", "main"]).code).toBe(0);
		return sha;
	};
	/** Launch a lane that finishes at once; the starter's branch entry and the worktree's HEAD. */
	const launchAndRead = async (r: LaneRoot) => {
		const { wl } = openWorkload(r);
		setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(STARTER_EXIT.ok);
		await exitOf(r, wl, laneIdOf(wl, 1));
		const branch = laneSnapshot(r, wl).bodies.find((b) => b.startsWith(`${LANE_STARTER_BY} branch: `))!;
		return { branch, head: git(worktreePath(r.repo, wl), ["rev-parse", "HEAD"]).out, wl };
	};

	/** Exit code of `git merge-base --is-ancestor`: 0 when `older` is in `newer`'s history, 1 when it is not. */
	const isAncestor = (repo: string, older: string, newer: string): number => git(repo, ["merge-base", "--is-ancestor", older, newer]).code;

	test("local ahead of origin (an unpushed commit): the branch is cut from origin/main, local main is untouched and its commit is not in the lane branch", async () => {
		const r = makeRoot();
		const remote = git(r.repo, ["rev-parse", "origin/main"]).out;
		const local = commitIn(r.repo, "local.txt");
		const { branch, head, wl } = await launchAndRead(r);
		expect(branch).toBe(`${LANE_STARTER_BY} branch: ${branchName(wl)} base origin/main ${remote}`);
		expect(head).toBe(remote);
		expect(git(r.repo, ["rev-parse", "main"]).out).toBe(local);
		expect(isAncestor(r.repo, local, branchName(wl))).toBe(1);
	}, 60_000);

	test("origin ahead of local (pushed from elsewhere): the starter fetches and cuts from origin/main; local main is untouched and the lane branch has no upstream", async () => {
		const r = makeRoot();
		const before = git(r.repo, ["rev-parse", "main"]).out;
		const remote = pushFromElsewhere(r);
		const { branch, head, wl } = await launchAndRead(r);
		expect(branch).toBe(`${LANE_STARTER_BY} branch: ${branchName(wl)} base origin/main ${remote}`);
		expect(head).toBe(remote);
		expect(git(r.repo, ["rev-parse", "main"]).out).toBe(before);
		expect(git(r.repo, ["rev-parse", "--abbrev-ref", `${branchName(wl)}@{upstream}`]).code).not.toBe(0);
	}, 60_000);

	test("origin advanced elsewhere and local main has an unpushed commit: the launch succeeds from origin/main, without the local commit", async () => {
		const r = makeRoot();
		const remote = pushFromElsewhere(r);
		const local = commitIn(r.repo, "local.txt");
		const { branch, head, wl } = await launchAndRead(r);
		expect(branch).toBe(`${LANE_STARTER_BY} branch: ${branchName(wl)} base origin/main ${remote}`);
		expect(head).toBe(remote);
		expect(git(r.repo, ["rev-parse", "main"]).out).toBe(local);
		expect(isAncestor(r.repo, local, branchName(wl))).toBe(1);
	}, 60_000);

	test("the fetch fails: the branch is cut from the origin/main already fetched, not local main, and the branch entry records the failure", async () => {
		const r = makeRoot();
		const remote = git(r.repo, ["rev-parse", "origin/main"]).out;
		const local = commitIn(r.repo, "local.txt");
		git(r.repo, ["remote", "set-url", "origin", join(r.root, "no-such-remote.git")]);
		const { branch, head, wl } = await launchAndRead(r);
		const [first, second] = branch.split("\n");
		expect(first).toBe(`${LANE_STARTER_BY} branch: ${branchName(wl)} base origin/main ${remote}`);
		expect(second).toMatch(/^fetch: failed \S/);
		expect(head).toBe(remote);
		expect(isAncestor(r.repo, local, branchName(wl))).toBe(1);
	}, 60_000);

	test("no origin at all: the branch is cut from local main, unpushed commit included, with no fetch line", async () => {
		const r = makeRoot();
		git(r.repo, ["remote", "remove", "origin"]);
		const local = commitIn(r.repo, "local.txt");
		const { branch, head, wl } = await launchAndRead(r);
		expect(branch).toBe(`${LANE_STARTER_BY} branch: ${branchName(wl)} base main ${local}`);
		expect(head).toBe(local);
	}, 60_000);
});

/** The fake's script with only `steps` (surface/test/fake-omp.ts header: a usage step writes one assistant message with that usage). */
const setMeterScript = (r: LaneRoot, steps: FakeStep[]) => writeFileSync(r.script, JSON.stringify({ steps }));
/** A tiny ceiling, the way the open tool writes one: a `ceiling:` entry stamped orchestrator-surface. */
function tinyCeiling(r: LaneRoot, wl: string, usd: number): void {
	const l = ledgerOf(r);
	try {
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody({ usd, wallMin: 60 }, "test tiny ceiling") });
	} finally {
		l.close();
	}
}
const spendsOf = (control: readonly ControlEntry[], laneId: string) => control.filter((c) => c.prefix === "spend" && c.laneId === laneId).map((c) => parseSpend(c.rest)!);
const ceilingQuestionsOf = (questions: readonly QuestionRow[]) => questions.filter((q) => q.slice_id.startsWith("sl-ceiling-") && q.created_by === LANE_RUNNER_BY);

describe("lane script: the ceiling meter (DESIGN-workload-ceiling.md § 2 item 4)", () => {
	test("80 %: one question over two polls, the lane goes on and completes; finishing under the ceiling withdraws it (then cancel); the prompt carries the ceiling; the final spend: counts everything", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r);
		tinyCeiling(r, wl, 1);
		// two stop polls (STOP_POLL_MS 5 s) land inside the 11 s at 85 %
		setMeterScript(r, [
			{ usage: { usd: 0.85, tokens: 1000 } }, { sleepMs: 11_000 }, { usage: { usd: 0.05, tokens: 100 } },
			{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } },
		]);
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		const exit = await exitOf(r, wl, laneId);
		expect(exit).toMatchObject({ outcome: "completed" });
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([]);
		const qs = ceilingQuestionsOf(snap.questions);
		expect(qs).toHaveLength(1);
		expect(JSON.parse(qs[0]!.options)).toEqual([...CEILING_OPTIONS]);
		expect(qs[0]!.state).toBe("withdrawn");
		expect(snap.slices.find((s) => s.id === qs[0]!.slice_id)!.state).toBe("cancelled");
		const spends = spendsOf(snap.control, laneId);
		expect(spends).toHaveLength(2);
		expect(spends[0]!.usd).toBeCloseTo(0.85, 4);
		expect(spends[1]).toMatchObject({ tokens: 1100 });
		expect(spends[1]!.usd).toBeCloseTo(0.9, 4);
		const [rec] = fakeRecords(r);
		expect(eventsOf(r, rec!.pid)).toEqual(["prompt", "eof"]);
		expect(readFileSync(rec!.session!, "utf8")).toContain("ceiling: $1 / 60 min for the workload; spent so far $0.00");
	}, 60_000);

	test("100 % unanswered (a jump past 80 % between polls): the question is raised with the stop, lane-stop: accepted ceiling, outcome stop reason ceiling, no lane-died: though a slice is open, released", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		tinyCeiling(r, wl, 1);
		setMeterScript(r, [{ usage: { usd: 1.2, tokens: 5000 } }, { hang: true }]);
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		const exit = await exitOf(r, wl, laneId);
		expect(exit).toMatchObject({ outcome: "stop", reason: "ceiling" });
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
		const stops = snap.control.filter((c) => c.prefix === "lane-stop" && c.laneId === laneId);
		expect(stops.map((s) => [s.createdBy, s.rest])).toEqual([[LANE_RUNNER_BY, "accepted ceiling"]]);
		const qs = ceilingQuestionsOf(snap.questions);
		expect(qs.map((q) => q.state)).toEqual(["open"]);
		expect(spendsOf(snap.control, laneId).at(-1)).toMatchObject({ usd: 1.2, tokens: 5000 });
		const [rec] = fakeRecords(r);
		expect(eventsOf(r, rec!.pid)).toEqual(["prompt", "abort", "eof"]);
	}, 60_000);

	test("a hand's session file nested under the lane's session dir counts: 0.5 in the lane's file and 0.6 in the hand's cross the $1 ceiling together", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		tinyCeiling(r, wl, 1);
		setMeterScript(r, [{ usage: { usd: 0.5, tokens: 10 } }, { usage: { usd: 0.6, tokens: 20 }, hand: "0-Hand" }, { hang: true }]);
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		const exit = await exitOf(r, wl, laneId);
		expect(exit).toMatchObject({ outcome: "stop", reason: "ceiling" });
		const [rec] = fakeRecords(r);
		expect(existsSync(join(rec!.session!.replace(/\.jsonl$/, ""), "0-Hand.jsonl"))).toBe(true);
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([]);
		const last = spendsOf(snap.control, laneId).at(-1)!;
		expect(last.usd).toBeCloseTo(1.1, 4);
		expect(last.tokens).toBe(30);
	}, 60_000);

	test("a relaunch already past 100 % (Jo answered stop, then a relaunch is requested): the runner meters before the first prompt and stops without sending it, no second question, no lane-died:", async () => {
		const r = makeRoot();
		const { wl } = openWorkload(r, { slice: true });
		tinyCeiling(r, wl, 1);
		setMeterScript(r, [{ usage: { usd: 1.2, tokens: 5000 } }, { hang: true }]);
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		expect(await exitOf(r, wl, laneIdOf(wl, 1))).toMatchObject({ outcome: "stop", reason: "ceiling" });
		await drainSettled(r, laneIdOf(wl, 1));
		const l = ledgerOf(r);
		const [q] = ceilingQuestionsOf(l.questions(wl));
		const answer = l.answerQuestion(q!.id, { by: SURFACE_BY, answer: "stop", author: "jo", channel: "surface" });
		l.completeSlice(q!.slice_id, { by: SURFACE_BY, artifact: `answered stop ${answer}` });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `launch-requested: by jo at ${l.now()}` });
		l.close();
		setMeterScript(r, [{ usage: { usd: 0.1, tokens: 10 } }, { hang: true }]);
		expect(lane(r, ["launch", wl, "--requested-by", "test"]).code).toBe(0);
		const lane2 = laneIdOf(wl, 2);
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "stop", reason: "ceiling" });
		const snap = laneSnapshot(r, wl);
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.control.filter((c) => c.prefix === "lane-stop" && c.laneId === lane2).map((c) => c.rest)).toEqual(["accepted ceiling"]);
		expect(ceilingQuestionsOf(snap.questions)).toHaveLength(1);
		expect(spendsOf(snap.control, lane2).at(-1)).toMatchObject({ usd: 1.2, tokens: 5000 });
		const starts = fakeRecords(r).filter((x) => x.argv !== undefined);
		expect(starts).toHaveLength(2);
		expect(eventsOf(r, starts[1]!.pid)).toEqual(["abort", "eof"]);
	}, 60_000);
});

describe("item 71: a queued launch starts when a lane slot frees (the runner's drain)", () => {
	/** An earlier attempt that ended: `launch:` (cause first), released, `lane-exit:`; with no new cause the predicate says died-not-relaunched. */
	const priorAttempt = (r: LaneRoot, wl: string): string => {
		const l = ledgerOf(r);
		try {
			const res = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
			if (!res.ok) throw new Error(res.reason);
			l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: res.laneId });
			l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(res.laneId, { code: 0, signal: null, outcome: "completed" }) });
			return res.laneId;
		} finally {
			l.close();
		}
	};
	/** Jo's unconsumed `launch-requested:`; its entry id is the cause the next launch names. */
	const requestLaunch = (r: LaneRoot, wl: string): string => {
		const l = ledgerOf(r);
		try {
			return l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `launch-requested: by jo at ${l.now()}` });
		} finally {
			l.close();
		}
	};
	const verdict = (r: LaneRoot, wl: string) => {
		const l = ledgerOf(r);
		try {
			return verdictOf(l.launchRows(wl, laneCap(r.env))!);
		} finally {
			l.close();
		}
	};
	const requestStop = (r: LaneRoot, wl: string, laneId: string): void => {
		const l = ledgerOf(r);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(laneId, "mode-flip", "jo") });
		l.close();
	};
	const launchesOf = (r: LaneRoot, wl: string) => laneSnapshot(r, wl).bodies.filter((b) => b.startsWith(`${LANE_STARTER_BY} launch: `));
	const completes: FakeStep[] = [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }];
	/** A, the live lane holding the cap-1 slot: launched by hand, its omp hanging until a stop request. */
	const liveA = async (r: LaneRoot): Promise<{ a: string; laneA: string }> => {
		const a = openWorkload(r, { brief: "live A" }).wl;
		setScript(r, { steps: [{ hang: true }] });
		expect(lane(r, ["launch", a, "--requested-by", "test"]).code).toBe(STARTER_EXIT.ok);
		const laneA = laneIdOf(a, 1);
		await readyOf(r, a, laneA);
		return { a, laneA };
	};

	test("starterEnv drops the lane binding laneEnv writes (role, workload, lane id) and keeps every other variable", () => {
		const base = { HOME: "/h", PATH: "/bin", AGENT_SYSTEM_LEDGER_DB: "/h/ledger.db", OMP_PROFILE: "agent-system-2", AGENT_SYSTEM_MAX_LANES: "1" };
		const bound = laneEnv(base, { workloadId: "wl-a", laneId: "lane-a-1" }, { ok: true, value: "off" });
		expect(bound).toMatchObject({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: "wl-a", AGENT_SYSTEM_LANE_ID: "lane-a-1" });
		expect(laneScript.starterEnv({ ...bound, UNSET: undefined })).toEqual(base);
	});

	test("cap 1: B (an earlier attempt and an unconsumed launch-requested:) is queued behind A's live lane; A's lane exits and B gets launch: <lane-B> cause request <req> requested-by lane-runner, its omp bound to B", async () => {
		const r = makeRoot({ AGENT_SYSTEM_MAX_LANES: "1" });
		const b = openWorkload(r, { brief: "queued B" }).wl;
		priorAttempt(r, b);
		const { a, laneA } = await liveA(r);
		const req = requestLaunch(r, b);
		expect(verdict(r, b)).toEqual({ launch: false, reason: "cap" });
		// A's omp read its script at its start: this one is B's lane's
		setScript(r, { steps: completes });
		requestStop(r, a, laneA);
		expect(await exitOf(r, a, laneA)).toMatchObject({ outcome: "stop" });
		const laneB = laneIdOf(b, 2);
		expect(await exitOf(r, b, laneB)).toMatchObject({ outcome: "completed" });
		expect(launchesOf(r, b)).toContain(`${LANE_STARTER_BY} launch: ${laneB} cause request ${req} requested-by lane-runner`);
		const recB = fakeRecords(r).find((x) => x.env?.AGENT_SYSTEM_WORKLOAD_ID === b)!;
		expect(recB.env).toMatchObject({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: b, AGENT_SYSTEM_LANE_ID: laneB });
		const pid = await drainSettled(r, laneA);
		expect(drainLinesOf(r, pid).map((l) => l.replace(/: .*$/, ""))).toEqual([`start ${pid} after ${a}`, `attempt ${pid} ${b} exit 0`, `end ${pid} attempts 1`]);
	}, 60_000);

	test("control, cap 1: C has an earlier attempt and no cause; A's lane exits and C is not launched", async () => {
		const r = makeRoot({ AGENT_SYSTEM_MAX_LANES: "1" });
		const c = openWorkload(r, { brief: "C, no cause" }).wl;
		priorAttempt(r, c);
		const { a, laneA } = await liveA(r);
		expect(verdict(r, c)).toEqual({ launch: false, reason: "cap" });
		requestStop(r, a, laneA);
		expect(await exitOf(r, a, laneA)).toMatchObject({ outcome: "stop" });
		// the runner writes its drain's `spawned` line before it exits: once it is gone, every drain it spawned is in the log
		const runnerPid = laneStarted(laneSnapshot(r, a).control, laneA)!.runnerPid;
		await until("A's runner gone", () => !alive(runnerPid), 10_000);
		for (const d of drainsSpawned(r)) await drainEnded(r, d.pid);
		expect(launchesOf(r, c)).toHaveLength(1);
		expect(verdict(r, c)).toEqual({ launch: false, reason: "died-not-relaunched" });
	}, 60_000);

	test("order, cap 1: B1 (older) and B2 queued; A's exit launches B1 and that drain stops at the cap with B2 unlaunched; B1's exit launches B2", async () => {
		const r = makeRoot({ AGENT_SYSTEM_MAX_LANES: "1" });
		const b1 = openWorkload(r, { brief: "queued B1" }).wl;
		priorAttempt(r, b1);
		const b2 = openWorkload(r, { brief: "queued B2" }).wl;
		priorAttempt(r, b2);
		const { a, laneA } = await liveA(r);
		const req1 = requestLaunch(r, b1);
		const req2 = requestLaunch(r, b2);
		expect([verdict(r, b1), verdict(r, b2)]).toEqual([{ launch: false, reason: "cap" }, { launch: false, reason: "cap" }]);
		// B1's lane hangs (the script A's started with) and holds the slot until the stop below
		requestStop(r, a, laneA);
		expect(await exitOf(r, a, laneA)).toMatchObject({ outcome: "stop" });
		const laneB1 = laneIdOf(b1, 2);
		await readyOf(r, b1, laneB1);
		const drainA = await drainSettled(r, laneA);
		expect(launchesOf(r, b1)).toContain(`${LANE_STARTER_BY} launch: ${laneB1} cause request ${req1} requested-by lane-runner`);
		expect(launchesOf(r, b2)).toHaveLength(1);
		expect(verdict(r, b2)).toEqual({ launch: false, reason: "cap" });
		expect(drainLinesOf(r, drainA).filter((l) => l.startsWith("attempt "))).toHaveLength(1);

		// B1's omp read its script at its start: this one is B2's lane's
		setScript(r, { steps: completes });
		requestStop(r, b1, laneB1);
		expect(await exitOf(r, b1, laneB1)).toMatchObject({ outcome: "stop" });
		const laneB2 = laneIdOf(b2, 2);
		expect(await exitOf(r, b2, laneB2)).toMatchObject({ outcome: "completed" });
		expect(launchesOf(r, b2)).toContain(`${LANE_STARTER_BY} launch: ${laneB2} cause request ${req2} requested-by lane-runner`);
		const drainB1 = await drainSettled(r, laneB1);
		expect(drainLinesOf(r, drainB1).filter((l) => l.startsWith("attempt ")).map((l) => l.replace(/: .*$/, ""))).toEqual([`attempt ${drainB1} ${b2} exit 0`]);
	}, 90_000);
});
