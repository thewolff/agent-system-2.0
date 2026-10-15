// The lane launcher end to end through the surface (DESIGN-lane-launcher.md § 8 "the close tool
// commits its entry (a temp repo shows the commit) and refuses while held"; § 6 resolutions): the
// orchestrator's tools and Jo's one-word answer drive the real starter, runner and lane rows
// against the fake omp (surface/test/fake-omp.ts) on a temp git repo, with the surface's `exec`
// running the real processes. Open → launch → park on a question → answer → relaunch with
// `--resume` of the raising lane's session → release → close, where the close tool's git path
// commits the decision-log entry on the lane branch wl/<id> in the lane worktree as the checkout's
// author, pushes it and opens its PR (a fake `gh` on PATH), and leaves the checkout's main
// untouched (decision 13 as amended, MIGRATION.md § "M7 follow-ups" item 11). The two close
// refusals from the Codex review are here too: held under a live lease, including a reservation
// landing while the close tool waits for git (S2), and a `done-because:` a later note by the
// holder supersedes (S1).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { launchVerdict } from "../extensions/launch";
import orchestratorSurface from "../index";
import { recordRepo } from "../src/decision-log";
import { branchName, doneBody, laneExit, laneStarted, worktreePath } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { ctxOf, drainSettled, fakePi, fakeRecords, git, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, notices, setScript, settleDrains, sh, timers, until } from "./helpers";

const roots: LaneRoot[] = [];
// A root is removed only after settleDrains is done with it: every runner's drain (MIGRATION.md item 71) and every
// lane a drain launched has ended, or, when that wait failed, every runner and drain of the root still alive was
// SIGKILLed and is gone; the failure is thrown only after the removal.
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

const PR_URL = "https://github.com/example/repo/pull/7";
/** The orchestrator surface over the root's ledger, its `exec` running the real command in the root's environment; a fake `gh` on the root's PATH lists no PR and creates one. */
function orchestrator(r: LaneRoot) {
	writeFileSync(join(r.root, "bin", "gh"), `#!/bin/sh\ncase "$1 $2" in\n  "pr list") echo '[]' ;;\n  "pr create") echo "${PR_URL}" ;;\n  *) exit 2 ;;\nesac\n`);
	chmodSync(join(r.root, "bin", "gh"), 0o755);
	const f = fakePi(undefined, { exec: true });
	f.execs.answer = (command, args) => {
		const p = sh([command, ...args], r.repo, r.env);
		return { stdout: p.out, stderr: p.err, code: p.code, killed: false };
	};
	orchestratorSurface(f.pi, { ...r.env, AGENT_SYSTEM_ROLE: "orchestrator" }, {});
	const ctx = ctxOf({ cwd: r.repo });
	const call = async (tool: string, params: Record<string, unknown>) => {
		const res = await f.tool(tool).execute("1", params, undefined, undefined, ctx);
		return { text: res.content[0]!.text, details: res.details as Record<string, unknown> | undefined };
	};
	/** Jo's first turn takes the wake and he reads it, so a later tick's poll pushes notices rather than the wake (MIGRATION.md item 37). */
	const awake = async () => {
		timers.length = 0;
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
		await call("orchestrator_wake_read", { body: "nothing open" });
	};
	/** The tick's notices, pushed as `surface-notices` asides. */
	const pushedNotices = () => f.sent.filter((s) => s.message.customType === "surface-notices");
	return { f, ctx, call, awake, pushedNotices };
}
const exitOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId), 60_000);
const addSlice = { tool: "lane_add_slice", args: { task: "add the line", doneCondition: "README has the line", inputs: "README.md", kind: "change-small" } };

describe("lane smoke: the surface launches, parks, resumes and closes with a commit", () => {
	test("open → launch → park on a question → Jo's answer relaunches with --resume of the raising lane's session → release → close commits the entry (author, tracked); the wake render shows the slice done", async () => {
		const r = laneRoot();
		roots.push(r);
		const { call, f, ctx } = orchestrator(r);
		setScript(r, {
			steps: [
				addSlice,
				{ tool: "lane_raise_question", args: { slice: "$slice", body: "push the branch now?", options: ["yes", "no"], ask: "Should the lane push the verify-line branch now?" } },
			],
		});
		const opened = await call("orchestrator_open_workload", { brief: "Add a verify line to the README, no plan", name: "README verify line", done: "README.md carries a verify line", repo: r.repo });
		const wl = opened.details!.id as string;
		expect(opened.text).toContain(`Opened ${wl} on ${r.repo}.`);
		const lane1 = laneIdOf(wl, 1);
		// the open tool launched through exec: the starter's line is in the result, the exec was `bun lane.ts launch <wl> --requested-by open`
		expect(opened.text).toMatch(new RegExp(`${wl}: lane ${lane1} runner \\d+`));
		expect(f.execs.calls[0]!.command).toBe("bun");
		expect(f.execs.calls[0]!.args.slice(1)).toEqual(["launch", wl, "--requested-by", "open"]);
		const exit1 = await exitOf(r, wl, lane1);
		expect(exit1.outcome).toBe("parked");
		const snap1 = laneSnapshot(r, wl);
		expect(snap1.workload!.holder).toBeNull();
		expect(snap1.deaths).toEqual([]);
		const q = snap1.questions[0]!;
		expect(q.state).toBe("open");
		const sl = q.slice_id;
		const session1 = fakeRecords(r)[0]!.session!;
		expect(snap1.control.find((c) => c.prefix === "lane-parked")!.rest).toBe(`questions ${q.id} session ${session1}`);

		// the close is refused while the question is open (nothing is held, but work is)
		expect((await call("orchestrator_close_workload", { workloadId: wl })).text).toContain("cannot close: 0 open slice(s), 1 paused, 1 open question(s)");

		// the drain lane 1's exit spawned has read the ledger and gone: the relaunch below is the answer path's
		await drainSettled(r, lane1);
		// Jo's one word at the surface: the answer lands, the answer path relaunches with --resume of lane 1's session
		setScript(r, {
			steps: [
				{ tool: "lane_complete_slice", args: { slice: sl, artifact: "README.md carries the verify line" } },
				{ tool: "lane_record_entry", args: { body: "done-because: README.md carries a verify line" } },
				{ tool: "lane_release", args: {} },
			],
		});
		notices.length = 0;
		await f.emit("before_agent_start", { prompt: "yes", systemPrompt: [] }, ctx);
		const lane2 = laneIdOf(wl, 2);
		expect(notices[0]).toContain(`answered ${q.id} with "yes"`);
		expect(notices[0]).toMatch(new RegExp(`${wl}: lane ${lane2} runner \\d+`));
		const exit2 = await exitOf(r, wl, lane2);
		expect(exit2.outcome).toBe("completed");
		const snap2 = laneSnapshot(r, wl);
		expect(snap2.bodies.some((b) => b.startsWith(`${LANE_STARTER_BY} launch: ${lane2} cause resume `))).toBe(true);
		const started2 = laneStarted(snap2.control, lane2)!;
		expect(started2.argv.slice(-2)).toEqual(["--resume", session1]);
		const rec2 = fakeRecords(r).filter((x) => x.argv)[1]!;
		expect(rec2.resumed).toBe(session1);
		const conversation = fakeRecords(r).filter((x) => x.argv)[1]!.session!;
		expect(Bun.file(conversation).size).toBeGreaterThan(0);
		expect(snap2.slices[0]!.state).toBe("done");
		expect(snap2.workload!.holder).toBeNull();
		expect(snap2.deaths).toEqual([]);

		// close: the entry is rendered into the lane worktree's decision log, committed on wl/<id> by the close tool's git path and pushed; main is untouched
		const closed = await call("orchestrator_close_workload", { workloadId: wl });
		const branch = branchName(wl);
		const lane = worktreePath(r.repo, wl);
		expect(closed.text).toMatch(/^Closed wl-.* Decision-log entry .* committed on wl\/wl-.*; pushed to origin; PR opened: https:\/\/github\.com\/example\/repo\/pull\/7\.$/);
		expect(closed.details!.commit).toBeNull();
		const path = closed.details!.path as string;
		expect(path.startsWith(`${lane}/.ai/decision-log/`)).toBe(true);
		expect(git(r.repo, ["status", "--porcelain"]).out).toBe("");
		expect(git(r.repo, ["log", "-1", "--format=%an <%ae>", branch]).out).toBe("t <t@example.invalid>");
		expect(git(r.repo, ["log", "-1", "--format=%s", branch]).out).toBe(`docs: decision-log entry ${path.replace(/^.*\//, "").replace(/\.md$/, "")} (workload ${wl})`);
		expect(git(lane, ["ls-files", "--error-unmatch", path]).code).toBe(0);
		expect(git(r.repo, ["log", "--oneline", "main"]).out.split("\n")).toHaveLength(1);
		expect(git(r.repo, ["log", "--oneline", branch]).out.split("\n")).toHaveLength(2);
		expect(git(r.repo, ["ls-remote", "origin", `refs/heads/${branch}`]).out.split(/\s/)[0]).toBe(git(r.repo, ["rev-parse", branch]).out);
		expect(laneSnapshot(r, wl).workload!.status).toBe("closed");
		// git commit ran in the lane worktree, never in the checkout
		expect(f.execs.calls.filter((c) => c.command === "git" && c.args[2] === "commit").map((c) => c.args[1])).toEqual([lane]);
	}, 120_000);

	test("close refused while a lane holds the workload (S2): the check before git, and a reservation landing during the close tool's git wait leaves it open with the entry committed", async () => {
		const r = laneRoot();
		roots.push(r);
		const { call, f } = orchestrator(r);
		setScript(r, { steps: [addSlice, { hang: true }] });
		const opened = await call("orchestrator_open_workload", { brief: "Add a verify line to the README, no plan", name: "README verify line", done: "README.md carries a verify line", repo: r.repo });
		const wl = opened.details!.id as string;
		const lane1 = laneIdOf(wl, 1);
		await until("the lane's claim", () => laneSnapshot(r, wl).workload?.changed_by === lane1);
		const held = await call("orchestrator_close_workload", { workloadId: wl });
		expect(held.text).toBe(`${wl} cannot close: held by ${lane1} under a live lease; stop it first: \`as2 lane stop ${wl}\``);
		// stop the lane by hand; the slice it added stays open, so it must be settled before the git path is reached
		expect(sh(["bun", f.execs.calls[0]!.args[0]!, "stop", wl], r.repo, r.env).code).toBe(0);
		await exitOf(r, wl, lane1);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		l.completeSlice(laneSnapshot(r, wl).slices[0]!.id, { by: lane1, artifact: "by hand" });
		l.recordEntry({ by: lane1, workloadId: wl, kind: "assumption", body: "done-because: README.md carries a verify line" });
		l.close();
		// S2: the reservation lands while the close tool awaits git: its checks passed, its close is refused inside the ledger's transaction
		f.execs.answer = (command, args) => {
			if (command === "git" && args[2] === "add") {
				const l2 = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
				const res = l2.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "race", decide: () => ({ launch: true, cause: "request" }) });
				l2.close();
				if (!res.ok) throw new Error(res.reason);
			}
			const p = sh([command, ...args], r.repo, r.env);
			return { stdout: p.out, stderr: p.err, code: p.code, killed: false };
		};
		const raced = await call("orchestrator_close_workload", { workloadId: wl });
		const lane2 = laneIdOf(wl, 2);
		expect(raced.text).toBe(`${wl} stays open: cannot close workload ${wl}: held by ${lane2} under a live lease. The decision-log entry at ${raced.details!.path} is rendered and committed on ${branchName(wl)}; it is re-rendered at the next close.`);
		expect(raced.details!.closed).toBe(false);
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.status).toBe("open");
		expect(snap.workload!.holder).toBe(lane2);
		expect(git(r.repo, ["status", "--porcelain"]).out).toBe("");
	}, 120_000);

	test("close refused without the holder's newest done-because: (S1): a later note by the lane supersedes its receipt; a fresh receipt closes", async () => {
		const r = laneRoot();
		roots.push(r);
		const { call } = orchestrator(r);
		setScript(r, {
			steps: [
				addSlice,
				{ tool: "lane_complete_slice", args: { slice: "$slice", artifact: "the line" } },
				{ tool: "lane_record_entry", args: { body: "done-because: README.md carries a verify line" } },
				{ tool: "lane_record_entry", args: { body: "the line was added to the wrong README; acceptance is no longer met" } },
				{ tool: "lane_release", args: {} },
			],
		});
		const opened = await call("orchestrator_open_workload", { brief: "Add a verify line to the README, no plan", name: "README verify line", done: "README.md carries a verify line", repo: r.repo });
		const wl = opened.details!.id as string;
		const lane1 = laneIdOf(wl, 1);
		await exitOf(r, wl, lane1);
		expect(laneSnapshot(r, wl).workload!.holder).toBeNull();
		const refused = await call("orchestrator_close_workload", { workloadId: wl });
		expect(refused.text).toContain(`${wl} cannot close: no \`done-because:\` receipt from its holder against the done: line (README.md carries a verify line), or a later note by the lane or the surface supersedes it.`);
		expect(laneSnapshot(r, wl).workload!.status).toBe("open");
		expect(git(r.repo, ["log", "--oneline", branchName(wl)]).out.split("\n")).toHaveLength(1);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		l.recordEntry({ by: lane1, workloadId: wl, kind: "assumption", body: "done-because: README.md carries a verify line, on the right README this time" });
		l.close();
		const closed = await call("orchestrator_close_workload", { workloadId: wl });
		expect(closed.text).toMatch(/^Closed wl-.* committed on wl\/wl-.*; pushed to origin; PR opened: .*\.$/);
		expect(laneSnapshot(r, wl).workload!.status).toBe("closed");
		expect(git(r.repo, ["log", "--oneline", branchName(wl)]).out.split("\n")).toHaveLength(2);
		expect(git(r.repo, ["log", "--oneline", "main"]).out.split("\n")).toHaveLength(1);
	}, 120_000);

	/** The by-hand shape of L1 (wl-muoaxc8vnba3nk, 2026-09-30): a lane claims by hand (no `launch:` entry), writes its receipt and releases. */
	const byHand = (r: LaneRoot, o: { completeSlice: boolean }) => {
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "Add a verify line to the README", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("README.md carries a verify line") });
		const hand = "lane-plumb-by-hand";
		expect(l.claimWorkload(wl, { by: hand, holder: hand, leaseMs: 60_000 }).won).toBe(true);
		const sl = l.addSlice({ by: hand, workloadId: wl, task: "add the line", doneCondition: "README has the line", inputs: "README.md" });
		if (o.completeSlice) l.completeSlice(sl, { by: hand, artifact: "the line" });
		l.recordEntry({ by: hand, workloadId: wl, kind: "assumption", body: "done-because: README.md carries a verify line\nchecked by reading it" });
		l.releaseWorkload(wl, { by: hand, holder: hand });
		expect(l.holders(wl)).toEqual([hand]);
		expect(launchVerdict(l, r.env, wl)).toEqual({ launch: false, reason: "awaiting-close" });
		l.close();
		return wl;
	};
	const APPLIED = "## Applied from the surface since your last turn\n";

	test("the tick closes a released workload whose by-hand holder wrote done-because: (L1): no lane launched, the entry committed, the close stamped as the surface, one notice line", async () => {
		const r = laneRoot();
		roots.push(r);
		const { f, awake, pushedNotices } = orchestrator(r);
		const wl = byHand(r, { completeSlice: true });
		await awake();
		timers[0]!.fn();
		await until("the tick's close", () => laneSnapshot(r, wl).workload?.status === "closed");
		// no lane ever launched: wl/<id> is cut from origin/main through a temporary worktree, which is gone again; main is untouched
		expect(f.execs.calls.filter((c) => c.command === "git" && c.args[2] === "commit").map((c) => c.args[1])).not.toContain(r.repo);
		expect(git(r.repo, ["status", "--porcelain"]).out).toBe("");
		expect(git(r.repo, ["log", "--oneline", "main"]).out.split("\n")).toHaveLength(1);
		expect(git(r.repo, ["log", "--oneline", branchName(wl)]).out.split("\n")).toHaveLength(2);
		expect(git(r.repo, ["log", "-1", "--format=%s", branchName(wl)]).out).toMatch(new RegExp(`^docs: decision-log entry .* \\(workload ${wl}\\)$`));
		expect(git(r.repo, ["worktree", "list", "--porcelain"]).out.split("\n").filter((l) => l.startsWith("worktree "))).toEqual([`worktree ${r.repo}`]);
		expect(git(r.repo, ["ls-remote", "origin", `refs/heads/${branchName(wl)}`]).out.split(/\s/)[0]).toBe(git(r.repo, ["rev-parse", branchName(wl)]).out);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		const close = l.provenance(wl).filter((p) => p.tbl === "workloads" && (p.detail ?? "").includes("status open->closed"));
		l.close();
		expect(close.map((p) => p.lane_instance)).toEqual([SURFACE_BY]);
		// the close's notice is pushed when the catch-up ends, after the awaited close
		const [notice] = await until("the tick's notice", () => (pushedNotices().length > 0 ? pushedNotices() : null));
		const applied = notice!.message.content.split(APPLIED)[1]!.split("\n");
		expect(applied).toHaveLength(1);
		expect(applied[0]).toStartWith(`- tick: closed ${wl}: README.md carries a verify line — Decision-log entry `);
		expect(applied[0]).toEndWith(` committed on ${branchName(wl)}; pushed to origin; PR opened: ${PR_URL}.`);
	}, 120_000);

	test("the tick's close names a publish failure in its one notice line: gh failing leaves the entry committed and pushed, the close done, and Jo told there is no PR and why", async () => {
		const r = laneRoot();
		roots.push(r);
		const { f, awake, pushedNotices } = orchestrator(r);
		const real = f.execs.answer;
		f.execs.answer = (command, args) => (command === "gh" ? { stdout: "", stderr: "gh: not logged in", code: 1, killed: false } : real(command, args));
		const wl = byHand(r, { completeSlice: true });
		await awake();
		timers[0]!.fn();
		await until("the tick's close", () => laneSnapshot(r, wl).workload?.status === "closed");
		expect(git(r.repo, ["ls-remote", "origin", `refs/heads/${branchName(wl)}`]).out.split(/\s/)[0]).toBe(git(r.repo, ["rev-parse", branchName(wl)]).out);
		const [notice] = await until("the tick's notice", () => (pushedNotices().length > 0 ? pushedNotices() : null));
		const applied = notice!.message.content.split(APPLIED)[1]!.split("\n");
		expect(applied).toHaveLength(1);
		expect(applied[0]).toStartWith(`- tick: closed ${wl}: README.md carries a verify line — Decision-log entry `);
		expect(applied[0]).toEndWith(` committed on ${branchName(wl)}; pushed to origin; no PR: gh pr list exited 1: gh: not logged in; open one from ${branchName(wl)}.`);
	}, 120_000);

	test("the tick does not close a workload awaiting close while a slice is open, and says so once per state: one notice after two ticks, again when the slice count changes", async () => {
		const r = laneRoot();
		roots.push(r);
		const { f, ctx, awake, pushedNotices } = orchestrator(r);
		const wl = byHand(r, { completeSlice: false });
		/** The pushed notices so far, each confirmed the way OMP admits it (its message_end), as their lines. */
		const told = async () => {
			const pushed = pushedNotices();
			for (const p of pushed) await f.admit(p, ctx);
			return pushed.map((p) => p.message.content.split(APPLIED)[1]!);
		};
		await awake();
		// the stuck path awaits nothing (no close, no starter), so the catch-up has finished when the tick returns
		timers[0]!.fn();
		expect(await told()).toEqual([`- tick: ${wl} is finished but cannot close: 1 open slice(s), 0 paused, 0 open question(s) — resolve them or close by hand`]);
		timers[0]!.fn();
		expect(laneSnapshot(r, wl).workload!.status).toBe("open");
		expect(f.execs.calls).toEqual([]);
		expect(git(r.repo, ["log", "--oneline"]).out.split("\n")).toHaveLength(1);
		// same state on the next tick: nothing new
		timers[0]!.fn();
		expect(await told()).toHaveLength(1);
		// the counts change: told again, still no close and no launch
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "one more", doneCondition: "d", inputs: "i" });
		l.close();
		timers[0]!.fn();
		expect((await told()).slice(1)).toEqual([`- tick: ${wl} is finished but cannot close: 2 open slice(s), 0 paused, 0 open question(s) — resolve them or close by hand`]);
		timers[0]!.fn();
		expect(await told()).toHaveLength(2);
		// confirmed, the queue is drained: Jo's next turn carries no Applied block
		const turn = (await f.emit("before_agent_start", { prompt: "ok", systemPrompt: [] }, ctx)) as { messages: { content: string }[] };
		expect(turn.messages.map((m) => m.content).join("\n")).not.toContain(APPLIED);
		expect(laneSnapshot(r, wl).workload!.status).toBe("open");
		expect(f.execs.calls).toEqual([]);
	}, 120_000);
});
