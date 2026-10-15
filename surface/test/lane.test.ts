// The lane row (surface/extensions/lane.ts, M5 fix round 1): a bound lane claims its workload at
// session start and renews the lease; a takeover records the old holder's death first; shutdown
// with open work writes the lane-died row and releases; a leaked human prompt is a prompt-wait row
// until it resolves; a declared artifact command's bash results write the slice's outcomes. Every
// row is read back through errorLines, the way the surface reads it.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CERTIFIED } from "../../gates/test/helpers";
import { registerFence } from "../../gates/src/fence";
import { Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines } from "../src/errors";
import { openPromptWaits, artifactCommandBody, artifactCommands, artifactTrees } from "../src/signals";
import { heartbeatText, settleArtifact, testRequestedBody, type TestRun, testRunBody } from "../src/test-run";
import { withdrawInstructionBody, withdrawnBody } from "../src/launch";
import { ARTIFACT_TOOL, INSTRUCTION_POLL_MS, LANE_RELEASE_TOOL, LEASE_MS, SURFACE_BY } from "../src/types";
import { workingTree } from "../src/wtree";
import { ctxOf, fakePi, git, notices, tempRepo, timers, tmp } from "./helpers";

function laneEnv(over: Record<string, string> = {}) {
	const path = join(tmp("ledger"), "ledger.db");
	const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false });
	const wl = ledger.openWorkload({ by: "orch", brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
	const sl = ledger.addSlice({ by: "orch", workloadId: wl, task: "Move the header offset into a token", doneCondition: "bun test passes", inputs: "src/header.css" });
	const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a", HOME: "/nonexistent-home", ...over };
	return { ledger, wl, sl, env };
}
const messages = (ledger: Ledger, wl: string) => ledger.db.query<{ state: string; sender: string; recipient: string; slice_id: string | null; body: string }, [string]>("SELECT state, sender, recipient, slice_id, body FROM messages WHERE workload_id = ? ORDER BY rowid").all(wl);

describe("lane row: claim and lease (§ B3 item 4 writer)", () => {
	test("session_start claims the workload for the lane with the lease; the renewal timer and turn end extend it; the orchestrator and an unbound lane do nothing", async () => {
		timers.length = 0;
		const { ledger, wl, env } = laneEnv();
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		const before = Date.now();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const w = ledger.workload(wl)!;
		expect(w.holder).toBe("lane-a");
		const until = Date.parse(w.holder_lease_until!);
		expect(until).toBeGreaterThanOrEqual(before + LEASE_MS - 1000);
		expect(until).toBeLessThanOrEqual(Date.now() + LEASE_MS + 1000);
		expect(timers).toHaveLength(1);
		expect(timers[0]!.ms).toBe(LEASE_MS / 3);
		// renewal moves the lease forward (the ledger stamps sqlite's clock: not before the first lease)
		timers[0]!.fn();
		expect(Date.parse(ledger.workload(wl)!.holder_lease_until!)).toBeGreaterThanOrEqual(until);
		await f.emit("agent_end", { willContinue: false }, ctx);
		expect(ledger.workload(wl)!.holder).toBe("lane-a");
		expect(errorLines(ledger).filter((l) => l.kind === "lane-died")).toEqual([]);

		// the orchestrator loading the same extension claims nothing
		timers.length = 0;
		const orch = fakePi();
		orchestratorSurface(orch.pi, { ...env, AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_WORKLOAD_ID: "", AGENT_SYSTEM_LANE_ID: "" });
		const other = laneEnv();
		await orch.emit("session_start", { type: "session_start" }, ctxOf());
		expect(other.ledger.workload(other.wl)!.holder).toBeNull();
		// a lane with no workload id claims nothing either
		const unbound = fakePi();
		orchestratorSurface(unbound.pi, { ...other.env, AGENT_SYSTEM_WORKLOAD_ID: "" });
		await unbound.emit("session_start", { type: "session_start" }, ctxOf());
		expect(other.ledger.workload(other.wl)!.holder).toBeNull();
	});

	test("a second lane taking over a lapsed lease records the first lane's death before the claim, so the death is surfaced once and the takeover is named", async () => {
		const { ledger, wl, env } = laneEnv({ AGENT_SYSTEM_LANE_ID: "lane-b" });
		// lane-a held it and died: a lease that lapsed in the past (the reclaim compares to sqlite's real now)
		ledger.db.query("UPDATE workloads SET holder = 'lane-a', holder_lease_until = '2026-09-01T11:00:00.000Z', rev = rev + 1 WHERE id = ?").run(wl);
		expect(errorLines(ledger).filter((l) => l.kind === "lane-died").map((l) => l.line)).toEqual([expect.stringContaining("lane lane-a on") ]);
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		await f.emit("session_start", { type: "session_start" }, ctxOf());
		expect(ledger.workload(wl)!.holder).toBe("lane-b");
		const dead = errorLines(ledger).filter((l) => l.kind === "lane-died");
		expect(dead).toHaveLength(1);
		expect(dead[0]!.line).toContain("lane lane-a on");
		expect(dead[0]!.line).toContain("lease lapsed 2026-09-01T11:00:00.000Z");
		expect(dead[0]!.line).toContain("lane-b holds it now");
		expect(messages(ledger, wl).map((m) => [m.state, m.recipient, m.body.slice(0, 18)])).toEqual([["held", "orchestrator", "lane-died: lane-a:"]]);
		// a live lease held by another lane is not taken: the lane is told
		const rival = fakePi();
		notices.length = 0;
		orchestratorSurface(rival.pi, { ...env, AGENT_SYSTEM_LANE_ID: "lane-c" });
		await rival.emit("session_start", { type: "session_start" }, ctxOf());
		expect(ledger.workload(wl)!.holder).toBe("lane-b");
		expect(notices.some((n) => n.includes("held by lane-b under a live lease"))).toBe(true);
		expect(messages(ledger, wl)).toHaveLength(1);
	});

	test("a lane whose lease lapsed before Jo's `withdraw <wl>` does not renew it: start, timer and turn end leave the lapsed lease, so the close is not held off (PLAN wl-mv8s939084z1ts D6)", async () => {
		timers.length = 0;
		const { ledger, wl, env } = laneEnv();
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		expect(ledger.workload(wl)!.holder).toBe("lane-a");
		// The lane stalls past its lease; Jo withdraws the workload (the rows the surface's word writes).
		const lapsed = "2026-09-01T11:00:00.000Z";
		ledger.db.query("UPDATE workloads SET holder_lease_until = ?, rev = rev + 1 WHERE id = ?").run(lapsed, wl);
		const ins = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: wl, body: withdrawInstructionBody(wl) });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: withdrawnBody(ins) });
		notices.length = 0;
		timers[0]!.fn();
		await f.emit("agent_end", { willContinue: false }, ctx);
		expect(ledger.workload(wl)!.holder_lease_until).toBe(lapsed);
		expect(notices.filter((n) => n.includes(`workload ${wl} was withdrawn by Jo (instruction ${ins})`))).toHaveLength(2);
		// A lane-written `withdrawn:` is no withdrawal: a fresh lane on another workload still claims as before.
		const other = laneEnv({ AGENT_SYSTEM_LANE_ID: "lane-z" });
		other.ledger.recordEntry({ by: "lane-z", workloadId: other.wl, kind: "assumption", body: withdrawnBody("in-forged") });
		const g = fakePi();
		orchestratorSurface(g.pi, other.env);
		await g.emit("session_start", { type: "session_start" }, ctxOf());
		expect(other.ledger.workload(other.wl)!.holder).toBe("lane-z");
	});

	test("session_shutdown with open work writes the lane-died row and releases the workload; with nothing open it only releases", async () => {
		const { ledger, wl, sl, env } = laneEnv();
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		expect(ledger.workload(wl)!.holder).toBeNull();
		const dead = errorLines(ledger).filter((l) => l.kind === "lane-died");
		expect(dead).toHaveLength(1);
		expect(dead[0]!.line).toMatch(/^lane lane-a on wl-.* died: session shutdown at .* with 1 open slice\(s\), 1 open slice\(s\)$/);
		expect(messages(ledger, wl).map((m) => [m.sender, m.recipient, m.state])).toEqual([["lane-a", "orchestrator", "held"]]);

		const done = laneEnv();
		done.ledger.completeSlice(done.sl, { by: "lane-a", artifact: "bun test exit 0" });
		const g = fakePi();
		orchestratorSurface(g.pi, done.env);
		const gctx = ctxOf();
		await g.emit("session_start", { type: "session_start" }, gctx);
		await g.emit("session_shutdown", { type: "session_shutdown" }, gctx);
		expect(done.ledger.workload(done.wl)!.holder).toBeNull();
		expect(messages(done.ledger, done.wl)).toEqual([]);
		void sl;
	});

	test("D5 (MIGRATION.md item 40): with the runner's death for this lane already enqueued, the shutdown writes no second one and still releases; another lane's death does not count", async () => {
		const deathIds = (ledger: Ledger, wl: string) => ledger.db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE workload_id = ? AND body LIKE 'lane-died:%' ORDER BY rowid").all(wl).map((m) => m.id);
		const shutdownWith = async (body: string) => {
			const { ledger, wl, env } = laneEnv();
			const f = fakePi();
			orchestratorSurface(f.pi, env);
			const ctx = ctxOf();
			await f.emit("session_start", { type: "session_start" }, ctx);
			const before = ledger.enqueue({ by: "lane-runner", workloadId: wl, sender: "lane-runner", recipient: "orchestrator", body });
			await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
			expect(ledger.workload(wl)!.holder).toBeNull();
			return { before, ids: deathIds(ledger, wl) };
		};
		const own = await shutdownWith("lane-died: lane-a: turn ended with open work after 2 continue prompts (no question, no done-because)");
		expect(own.ids).toEqual([own.before]);
		const other = await shutdownWith("lane-died: lane-z: deadline 2h with 1 open slice(s)");
		expect(other.ids).toHaveLength(2);
		expect(other.ids[0]).toBe(other.before);
	});

	// MIGRATION.md item 40, workload wl-mv049108m8whds: the runner records an intended decision (`lane-decided:`) before EOF.
	const deathBodies = (ledger: Ledger, wl: string) => ledger.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ? AND body LIKE 'lane-died:%' ORDER BY rowid").all(wl).map((m) => m.body);
	/** A slice open, lane-a claims, `before` writes to the ledger, then session_shutdown. */
	const shutdownAfter = async (before: (ledger: Ledger, wl: string) => void) => {
		const { ledger, wl, env } = laneEnv();
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		expect(ledger.workload(wl)!.holder).toBe("lane-a");
		before(ledger, wl);
		await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		return { holder: ledger.workload(wl)!.holder, deaths: deathBodies(ledger, wl) };
	};

	test("(a) the runner's lane-decided: <lane> completed with a slice open: the shutdown writes no lane-died: and releases", async () => {
		const end = await shutdownAfter((ledger, wl) => {
			ledger.recordEntry({ by: "lane-runner", workloadId: wl, kind: "assumption", body: "lane-decided: lane-a completed" });
		});
		expect(end).toEqual({ holder: null, deaths: [] });
	});

	test("(b) a holder's done-because: with a slice open and no runner decision (an external shutdown): the death is written as before, and the workload released", async () => {
		const end = await shutdownAfter((ledger, wl) => {
			ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: "done-because: the probe is done" });
		});
		expect(end.holder).toBeNull();
		expect(end.deaths).toEqual([expect.stringMatching(/^lane-died: lane-a: session shutdown at .* with 1 open slice\(s\)$/)]);
	});

	test("(c) a lane-decided: marker the runner did not write (the surface's, or the lane's own forged one) is no intent: the death is written", async () => {
		for (const by of ["orchestrator-surface", "lane-a"]) {
			const end = await shutdownAfter((ledger, wl) => {
				ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body: "lane-decided: lane-a completed" });
			});
			expect(end.holder).toBeNull();
			expect(end.deaths).toEqual([expect.stringMatching(/^lane-died: lane-a: session shutdown at /)]);
		}
	});
});

describe("lane row: leaked prompt (§ B3 item 5 writer)", () => {
	test("tool_approval_requested writes a prompt-wait row the surface renders as a question; tool_approval_resolved ends it", async () => {
		const { ledger, wl, sl, env } = laneEnv();
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("tool_approval_requested", { sessionId: "s-1", toolCallId: "call-7", toolName: "bash", reason: "rm -rf build needs approval" }, ctx);
		const waits = openPromptWaits(ledger, wl);
		expect(waits).toHaveLength(1);
		expect(waits[0]).toMatchObject({ lane: "lane-a", toolName: "bash", toolCallId: "call-7", sessionId: "s-1", reason: "rm -rf build needs approval" });
		expect(messages(ledger, wl)[0]!.slice_id).toBe(sl);
		const q = errorLines(ledger).filter((l) => l.kind === "question");
		expect(q).toHaveLength(1);
		expect(q[0]!.line).toContain("lane lane-a on");
		expect(q[0]!.line).toContain("is blocked on a human prompt it should never open (bash, tool call call-7");
		expect(q[0]!.line).toContain("rm -rf build needs approval");
		await f.emit("tool_approval_resolved", { sessionId: "s-1", toolCallId: "call-7", toolName: "bash", approved: false, reason: "denied by Jo" }, ctx);
		expect(openPromptWaits(ledger, wl)).toEqual([]);
		expect(errorLines(ledger).filter((l) => l.kind === "question")).toEqual([]);
		expect(messages(ledger, wl).map((m) => m.body.slice(0, 16))).toEqual(["prompt-wait: bas", "prompt-resolved:"]);
		// a resolution with no wait behind it writes nothing
		await f.emit("tool_approval_resolved", { sessionId: "s-1", toolCallId: "call-8", toolName: "bash", approved: true }, ctx);
		expect(messages(ledger, wl)).toHaveLength(2);
	});

	test("an `ask` execution is a prompt wait until it ends; a wait still open at shutdown is ended by the shutdown", async () => {
		const { ledger, wl, env } = laneEnv();
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("tool_execution_start", { toolName: "ask", toolCallId: "ask-1", args: { question: "Which token?" } }, ctx);
		expect(errorLines(ledger).filter((l) => l.kind === "question").map((l) => l.line)).toEqual([expect.stringContaining("(ask, tool call ask-1")]);
		await f.emit("tool_execution_end", { toolName: "ask", toolCallId: "ask-1", result: {}, isError: false }, ctx);
		expect(openPromptWaits(ledger, wl)).toEqual([]);
		await f.emit("tool_execution_start", { toolName: "ask", toolCallId: "ask-2", args: { question: "And this?" } }, ctx);
		expect(openPromptWaits(ledger, wl)).toHaveLength(1);
		await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		expect(openPromptWaits(ledger, wl)).toEqual([]);
		expect(messages(ledger, wl).map((m) => m.body.split(":")[0])).toEqual(["prompt-wait", "prompt-resolved", "prompt-wait", "prompt-resolved", "lane-died"]);
		expect(messages(ledger, wl)[3]!.body).toContain("ended: the session shut down");
	});
});

describe("lane row: runtime artifact (§ B3 item 3 writer)", () => {
	test("slice_artifact declares the command; two failing results surface the line; a passing result clears it; another command is not the artifact", async () => {
		const { ledger, wl, sl, env } = laneEnv();
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const declare = f.tool(ARTIFACT_TOOL);
		expect((await declare.execute("d0", { slice: sl, command: "  " }, undefined, undefined, ctx)).content[0]!.text).toContain("nothing was declared");
		expect((await declare.execute("d0", { slice: "sl-nope", command: "bun test" }, undefined, undefined, ctx)).content[0]!.text).toContain("is not on workload");
		const r = await declare.execute("d1", { slice: sl, command: "bun test surface/test/render.test.ts" }, undefined, undefined, ctx);
		expect(r.content[0]!.text).toMatch(/^Declared the runtime artifact of sl-/);
		expect(artifactCommands(ledger, wl)).toEqual(new Map([[sl, "bun test surface/test/render.test.ts"]]));
		const result = (id: string, command: string, code: number) =>
			f.emit("tool_result", { toolName: "bash", toolCallId: id, input: { command }, details: code === 0 ? {} : { exitCode: code }, isError: code !== 0 }, ctx);
		await result("b1", "bun test surface/test/render.test.ts", 1);
		await result("b2", "ls", 1); // not the artifact
		expect(errorLines(ledger).filter((l) => l.kind === "artifact")).toEqual([]);
		await result("b3", "bun test surface/test/render.test.ts", 1);
		const lines = errorLines(ledger).filter((l) => l.kind === "artifact");
		expect(lines).toHaveLength(1);
		expect(lines[0]!.line).toContain(`slice ${sl} (${wl}) failed its runtime artifact 2 times`);
		await result("b4", "bun test surface/test/render.test.ts", 0);
		expect(errorLines(ledger).filter((l) => l.kind === "artifact")).toEqual([]);
		expect(messages(ledger, wl).map((m) => [m.slice_id, m.body.slice(0, 16)])).toEqual([[sl, "artifact-failed:"], [sl, "artifact-failed:"], [sl, "artifact-passed:"]]);
		// a background run has no outcome yet
		await f.emit("tool_result", { toolName: "bash", toolCallId: "b5", input: { command: "bun test surface/test/render.test.ts" }, details: { async: { id: "job-1" } }, isError: false }, ctx);
		expect(messages(ledger, wl)).toHaveLength(3);
		// a pass with no surfaced failures behind it writes nothing
		await result("b6", "bun test surface/test/render.test.ts", 0);
		expect(messages(ledger, wl)).toHaveLength(3);
		// the orchestrator cannot declare
		const orch = fakePi();
		orchestratorSurface(orch.pi, { ...env, AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_WORKLOAD_ID: "" });
		expect((await orch.tool(ARTIFACT_TOOL).execute("d2", { slice: sl, command: "x" }, undefined, undefined, ctxOf())).content[0]!.text).toContain("not a lane bound to a workload");
	});
});

describe("lane row: artifact-tree record (wl-muptjioqjtvthc PLAN.md § 1)", () => {
	const ARTIFACT = "bun test surface/test/render.test.ts";
	/** A started lane in a clean temp repo with ARTIFACT declared on its slice; `f` may carry more rows (the fence). */
	async function lane(over: Record<string, string> = {}, f = fakePi()) {
		const { ledger, wl, sl, env } = laneEnv(over);
		const repo = tempRepo();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf({ cwd: repo });
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.tool(ARTIFACT_TOOL).execute("d1", { slice: sl, command: ARTIFACT }, undefined, undefined, ctx);
		/** One bash call: tool_call, then `between` (the run itself), then its tool_result with `details`. */
		const run = async (id: string, command: string, details: Record<string, unknown> = {}, between?: () => void) => {
			await f.emit("tool_call", { toolName: "bash", toolCallId: id, input: { command } }, ctx);
			between?.();
			await f.emit("tool_result", { toolName: "bash", toolCallId: id, input: { command }, details, isError: typeof details.exitCode === "number" }, ctx);
		};
		return { ledger, wl, sl, env, repo, f, ctx, run };
	}
	const treeBodies = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("artifact-tree:")).map((e) => [e.slice_id, e.created_by, e.body]);

	test("an exit-0 declared artifact writes one artifact-tree entry: the repo, the working tree it ran on, the command", async () => {
		const { ledger, wl, sl, repo, run } = await lane();
		await run("t1", ARTIFACT);
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).out;
		expect(treeBodies(ledger, wl)).toEqual([[sl, "lane-a", `artifact-tree: ${JSON.stringify({ repo, tree, command: ARTIFACT })}`]]);
		expect(artifactTrees(ledger, wl)).toEqual([{ sliceId: sl, repo, tree, command: ARTIFACT }]);
		// an untracked file present for the whole run is part of the tree it ran on
		writeFileSync(join(repo, "extra.ts"), "export {};\n");
		await run("t2", ARTIFACT);
		const withExtra = workingTree(repo)!.tree;
		expect(withExtra).not.toBe(tree);
		expect(artifactTrees(ledger, wl).map((t) => t.tree)).toEqual([tree, withExtra]);
	});

	test("a non-zero exit, an undeclared command, an edit during the run, or a backgrounded run writes none", async () => {
		const { ledger, wl, repo, f, ctx, run } = await lane();
		await run("n1", ARTIFACT, { exitCode: 1 });
		expect(ledger.db.query<{ n: number }, [string]>("SELECT count(*) n FROM messages WHERE workload_id = ? AND body LIKE 'artifact-failed:%'").get(wl)!.n).toBe(1);
		await run("n2", "bun test");
		await run("n3", ARTIFACT, {}, () => writeFileSync(join(repo, "README.md"), "edited mid-run\n"));
		await run("n4", ARTIFACT, { async: { id: "job-1" } });
		// the backgrounded call's snapshot was dropped: a later exit-0 result under its id has nothing to compare
		await f.emit("tool_result", { toolName: "bash", toolCallId: "n4", input: { command: ARTIFACT }, details: {}, isError: false }, ctx);
		expect(artifactTrees(ledger, wl)).toEqual([]);
	});

	test("a command declared on two slices records on each", async () => {
		const { ledger, wl, sl, run, ctx, f } = await lane();
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "i" });
		await f.tool(ARTIFACT_TOOL).execute("d2", { slice: sl2, command: ARTIFACT }, undefined, undefined, ctx);
		await run("s1", ARTIFACT);
		expect(artifactTrees(ledger, wl).map((t) => t.sliceId).sort()).toEqual([sl, sl2].sort());
	});

	test("under the M4b fence the executing command is the sandbox-exec wrapper; the original the fence stores is matched and the run records", async () => {
		const f = fakePi();
		const home = tmp("fence-home");
		const { ledger, wl, sl, env, repo, ctx } = await lane({ HOME: home, PATH: process.env.PATH ?? "" }, f);
		registerFence(f.pi, env, async () => ({ enabled: true, autoBackground: true }), CERTIFIED);
		const revised = (await f.emit("tool_call", { toolName: "bash", toolCallId: "w1", input: { command: ARTIFACT } }, ctx)) as { block?: boolean; reason?: string; input?: { command: string } } | undefined;
		expect(revised?.block).toBeUndefined();
		const wrapped = revised!.input!.command;
		expect(wrapped).toContain("sandbox-exec");
		expect(wrapped).not.toBe(ARTIFACT);
		await f.emit("tool_result", { toolName: "bash", toolCallId: "w1", input: { command: wrapped }, details: {}, isError: false }, ctx);
		expect(artifactTrees(ledger, wl)).toEqual([{ sliceId: sl, repo, tree: git(repo, ["rev-parse", "HEAD^{tree}"]).out, command: ARTIFACT }]);
	});

	// wl-mupzpidbb3ksg0 PLAN.md § 2 decision A: a done slice's declared command, re-run on a new commit.
	/** Commit a change to README.md (tracked, outside .ai/decision-log/) and return the new HEAD tree. */
	const newCommit = (repo: string): string => {
		writeFileSync(join(repo, "README.md"), `changed after the slice closed ${Date.now()}\n`);
		for (const args of [["add", "README.md"], ["commit", "-q", "-m", "after the slice closed"]]) {
			const r = git(repo, args);
			if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
		}
		return git(repo, ["rev-parse", "HEAD^{tree}"]).out;
	};

	test("a passing re-run of a done slice's declared command on a new commit records that tree on the done slice", async () => {
		const { ledger, wl, sl, repo, run } = await lane();
		await run("c1", ARTIFACT);
		const old = git(repo, ["rev-parse", "HEAD^{tree}"]).out;
		ledger.completeSlice(sl, { by: "lane-a", artifact: "passed" });
		expect(ledger.slice(sl)!.state).toBe("done");
		const now = newCommit(repo);
		expect(now).not.toBe(old);
		expect(artifactTrees(ledger, wl).filter((t) => t.tree === now)).toEqual([]);
		await run("c2", ARTIFACT);
		expect(artifactTrees(ledger, wl).filter((t) => t.tree === now)).toEqual([{ sliceId: sl, repo, tree: now, command: ARTIFACT }]);
		expect(artifactTrees(ledger, wl)).toEqual([{ sliceId: sl, repo, tree: old, command: ARTIFACT }, { sliceId: sl, repo, tree: now, command: ARTIFACT }]);
		// the outcome messages stay with live slices: a done slice's run writes none
		expect(messages(ledger, wl)).toEqual([]);
	});

	test("a cancelled slice's declared command records nothing", async () => {
		const { ledger, wl, sl, repo, run } = await lane();
		ledger.cancelSlice(sl, { by: "lane-a" });
		const now = newCommit(repo);
		await run("x1", ARTIFACT);
		expect(now).toBe(workingTree(repo)!.tree);
		expect(artifactTrees(ledger, wl)).toEqual([]);
	});

	test("a failing re-run of a done slice's command records nothing and sends no artifact-failed; a live slice on the same command still gets its outcome", async () => {
		const { ledger, wl, sl, repo, run, f, ctx } = await lane();
		ledger.completeSlice(sl, { by: "lane-a", artifact: "passed" });
		newCommit(repo);
		await run("x1", ARTIFACT, { exitCode: 1 });
		expect(artifactTrees(ledger, wl)).toEqual([]);
		expect(messages(ledger, wl)).toEqual([]);
		expect(ledger.slice(sl)!.state).toBe("done");
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "i" });
		await f.tool(ARTIFACT_TOOL).execute("d2", { slice: sl2, command: ARTIFACT }, undefined, undefined, ctx);
		await run("x2", ARTIFACT, { exitCode: 1 });
		expect(messages(ledger, wl).map((m) => [m.slice_id, m.body.slice(0, 16)])).toEqual([[sl2, "artifact-failed:"]]);
		expect(artifactTrees(ledger, wl)).toEqual([]);
	});

	test("a done slice's re-run during which the tree changes records nothing", async () => {
		const { ledger, wl, sl, repo, run } = await lane();
		ledger.completeSlice(sl, { by: "lane-a", artifact: "passed" });
		newCommit(repo);
		await run("x1", ARTIFACT, {}, () => writeFileSync(join(repo, "README.md"), "edited mid-run\n"));
		expect(artifactTrees(ledger, wl)).toEqual([]);
	});

	test("another workload's done slice with the same command records nothing on this workload", async () => {
		const { ledger, wl, sl, repo, run, f, ctx } = await lane();
		await f.tool(ARTIFACT_TOOL).execute("d2", { slice: sl, command: "bun test surface/test/other.test.ts" }, undefined, undefined, ctx);
		const wlB = ledger.openWorkload({ by: "orch", brief: "another workload", stakes: "normal", mode: "autonomous" });
		const slB = ledger.addSlice({ by: "orch", workloadId: wlB, task: "b", doneCondition: "d", inputs: "i" });
		ledger.recordEntry({ by: "lane-b", workloadId: wlB, sliceId: slB, kind: "assumption", body: artifactCommandBody(ARTIFACT) });
		ledger.completeSlice(slB, { by: "lane-b", artifact: "passed" });
		newCommit(repo);
		await run("x1", ARTIFACT);
		expect(artifactTrees(ledger, wl)).toEqual([]);
		expect(artifactTrees(ledger, wlB)).toEqual([]);
	});
});

describe("lane row: Jo's instructions reach the lane after its prompt was built", () => {
	const poll = () => timers.find((t) => t.ms === INSTRUCTION_POLL_MS)!;
	/** A started lane session: Jo's rows written through the surface, the before_agent_start messages and the pushes it receives. */
	async function lane(over: Record<string, string> = {}, before: string[] = []) {
		const { ledger, wl, env } = laneEnv(over);
		const jo = (body: string) => ledger.recordInstruction({ by: "orchestrator-surface", workloadId: wl, body, author: "jo", channel: "surface" });
		const written = before.map(jo);
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const start = async (prompt: string) => {
			const r = (await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as { messages: { customType: string; content: string }[] };
			return r.messages.filter((m) => m.customType === "lane-instructions");
		};
		const pushed = () => f.sent.filter((s) => s.message.customType === "lane-instructions");
		const toolResult = (toolName: string, id: string) => f.emit("tool_result", { toolName, toolCallId: id, input: toolName === "bash" ? { command: "ls" } : {}, isError: false }, ctx);
		return { ledger, wl, f, ctx, jo, written, start, pushed, toolResult };
	}

	test("an instruction written after the prompt was built (wl-muonhgx992outc) comes back at before_agent_start; one the prompt carries is not repeated", async () => {
		timers.length = 0;
		const l = await lane({}, ["proof script goes to Plumb, not Jo"]);
		const inPrompt = l.written[0]!;
		const late = l.jo("ledger note for Plumb,\nno message to Jo");
		const owed = await l.start(`Resume ${l.wl}. Jo's instructions:\n- ${inPrompt} (…): proof script goes to Plumb, not Jo`);
		expect(owed).toHaveLength(1);
		expect(owed[0]!.content).toContain(`Jo's instructions on ${l.wl} not in your prompt`);
		expect(owed[0]!.content).toContain(`- ${late} (`);
		expect(owed[0]!.content).toContain("ledger note for Plumb, no message to Jo");
		expect(owed[0]!.content).not.toContain(inPrompt);
		// both are handed over now: neither is pushed again
		poll().fn();
		await l.toolResult("read", "r1");
		expect(l.pushed()).toEqual([]);
		// a prompt that already names every row gets no message
		const g = await lane({ AGENT_SYSTEM_LANE_ID: "lane-b" }, ["one", "two"]);
		expect(await g.start(`instructions: ${g.written.join(", ")}`)).toEqual([]);
	});

	test("a Jo row written mid-run is pushed once as an aside on the poll or the next tool result; an orchestrator-authored row never is", async () => {
		timers.length = 0;
		const l = await lane();
		await l.start(`Work ${l.wl}.`);
		expect(poll()).toBeDefined();
		const first = l.jo("stop after the token move");
		l.ledger.recordInstruction({ by: "orchestrator-surface", workloadId: l.wl, body: "orchestrator's own note", author: "orchestrator", channel: "surface" });
		poll().fn();
		expect(l.pushed()).toHaveLength(1);
		expect(l.pushed()[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(l.pushed()[0]!.message.display).toBe(true);
		expect(l.pushed()[0]!.message.content).toContain(`New instruction(s) from Jo on ${l.wl} since your last turn`);
		expect(l.pushed()[0]!.message.content).toContain(`- ${first} (`);
		expect(l.pushed()[0]!.message.content).not.toContain("orchestrator's own note");
		poll().fn();
		await l.toolResult("bash", "b1");
		expect(l.pushed()).toHaveLength(1);
		// the next one lands on a tool result of any tool, before the poll fires
		const second = l.jo("and skip the docs");
		await l.toolResult("read", "r1");
		expect(l.pushed()).toHaveLength(2);
		expect(l.pushed()[1]!.message.content).toContain(`- ${second} (`);
		expect(l.pushed()[1]!.message.content).not.toContain(first);
		poll().fn();
		expect(l.pushed()).toHaveLength(2);
	});

	test("nothing is pushed before the first prompt starts, and nothing after the lane releases", async () => {
		timers.length = 0;
		const l = await lane();
		const early = l.jo("written before the first prompt");
		await l.toolResult("read", "r0");
		expect(l.pushed()).toEqual([]);
		expect(poll()).toBeUndefined();
		// the row is owed at before_agent_start instead
		expect((await l.start("go")).map((m) => m.content).join("\n")).toContain(early);
		const handle = timers.indexOf(poll()) + 1;
		const released = await l.f.tool(LANE_RELEASE_TOOL).execute("rel", {}, undefined, undefined, l.ctx);
		expect(released.content[0]!.text).toContain(`Released ${l.wl}`);
		expect(l.ctx.cleared).toContain(handle);
		l.jo("too late");
		poll().fn();
		await l.toolResult("read", "r1");
		expect(l.pushed()).toEqual([]);
		expect(await l.start("again")).toEqual([]);
	});
});

describe("lane row: the test runner's results reach the lane as asides (PLAN wl-muraerdsgw7gn4 § 4)", () => {
	afterEach(() => setSystemTime());
	const poll = () => timers.find((t) => t.ms === INSTRUCTION_POLL_MS)!;
	const SHA = "a".repeat(40);

	async function lane() {
		timers.length = 0;
		const runs = tmp("runs");
		const { ledger, wl, sl, env } = laneEnv({ AGENT_SYSTEM_TEST_RUNS: runs });
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const asides = () => f.sent.filter((s) => s.message.customType === "lane-test-run");
		const toolResult = (id: string) => f.emit("tool_result", { toolName: "read", toolCallId: id, input: {}, isError: false }, ctx);
		const request = (runId: string, by = TEST_RUNNER_BY, slice = sl) =>
			ledger.recordEntry({ by, workloadId: wl, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr: 17, sha: SHA, slice, by: "lane-a" }) });
		const result = (run: TestRun, by = TEST_RUNNER_BY) => ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body: testRunBody(run) });
		return { ledger, wl, sl, f, ctx, runs, asides, toolResult, request, result };
	}
	const run = (runId: string, runDir: string | null, over: Partial<TestRun> = {}): TestRun => ({
		runId, verdict: "red", sha: SHA, pr: 17, reason: null, headAtEnd: SHA, base: null, mergeBase: null,
		full: { pass: 40, fail: 11, skip: 2, exit: 1, ms: 9000, error: null },
		solo: [{ file: "./src/solo.test.ts", pass: 3, fail: 1, skip: 0, exit: 1, ms: 300, error: null }],
		failures: [
			...Array.from({ length: 11 }, (_, i) => ({ part: "full", name: `src/x.test.ts > header > case ${i + 1}`, firstError: `error: expect(received).toBe(expected) #${i + 1}` })),
			{ part: "./src/solo.test.ts", name: "src/solo.test.ts > alone", firstError: "error: state leaked" },
		],
		runDir, preflight: null, ...over,
	});

	test("one aside per test-run: entry, once, on the poll or the next tool result: verdict, counts, the first 10 failures, the result.json path", async () => {
		const l = await lane();
		l.request("tr-0abc1234aaaa");
		const red = l.result(run("tr-0abc1234aaaa", join(l.runs, "tr-0abc1234aaaa")));
		// nothing before the first prompt starts
		await l.toolResult("r0");
		expect(l.asides()).toEqual([]);
		await l.f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, l.ctx);
		poll().fn();
		expect(l.asides()).toHaveLength(1);
		const a = l.asides()[0]!;
		expect(a.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(a.message.display).toBe(true);
		const c = a.message.content;
		expect(c).toStartWith(`Test run tr-0abc1234aaaa on ${l.wl}: red at ${SHA} (PR #17, slice ${l.sl}, ledger entry ${red}).`);
		expect(c).toContain("Full suite: 40 passed, 11 failed, 2 skipped.");
		expect(c).toContain("Changed test files alone: ./src/solo.test.ts 3 passed, 1 failed, 0 skipped.");
		expect(c).toContain(`Failing (10 of 12; the rest are in ${join(l.runs, "tr-0abc1234aaaa", "result.json")}):`);
		expect(c).toContain("- [full] src/x.test.ts > header > case 1: error: expect(received).toBe(expected) #1\n");
		expect(c).toContain("- [full] src/x.test.ts > header > case 10: error: expect(received).toBe(expected) #10");
		expect(c).not.toContain("case 11:");
		expect(c).not.toContain("state leaked");
		expect(c).toContain(`Result: ${join(l.runs, "tr-0abc1234aaaa", "result.json")}`);
		expect(c).toContain(`${l.sl} stays open: fix, push, then call lane_full_test with pr 17 and slice ${l.sl} again.`);
		// handed over: neither the poll nor a tool result repeats it
		poll().fn();
		await l.toolResult("r1");
		expect(l.asides()).toHaveLength(1);
		// the next run's result lands on a tool result; a test-run: the lane forged never does
		l.request("tr-0abc1234bbbb");
		l.result(run("tr-0abc1234bbbb", null, { verdict: "green", full: { pass: 51, fail: 0, skip: 2, exit: 0, ms: 9000, error: null }, solo: [], failures: [] }));
		l.request("tr-0abc1234cccc");
		l.result(run("tr-0abc1234cccc", null, { verdict: "green", failures: [] }), "lane-a");
		await l.toolResult("r2");
		expect(l.asides()).toHaveLength(2);
		const g = l.asides()[1]!.message.content;
		expect(g).toStartWith(`Test run tr-0abc1234bbbb on ${l.wl}: green at ${SHA}`);
		expect(g).toContain("Changed test files alone: none.");
		expect(g).not.toContain("Failing");
		expect(g).toContain("Result: ledger entry en-");
		// nothing completed the slice: green, but not settled, and why
		expect(g).toContain(`Green, but not settled: the runner did not complete ${l.sl} (it is open); it completes only a slice still open when it writes its result.`);
		expect(g).not.toContain("The runner completed");
		expect(l.asides().map((x) => x.message.content).join("\n")).not.toContain("tr-0abc1234cccc");
		poll().fn();
		expect(l.asides()).toHaveLength(2);
	});

	test("a green aside says the runner completed the slice only when the slice is done with this run's own artifact; otherwise green, but not settled, and why", async () => {
		const l = await lane();
		await l.f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, l.ctx);
		const green = (runId: string): TestRun => run(runId, join(l.runs, runId), { verdict: "green", full: { pass: 51, fail: 0, skip: 0, exit: 0, ms: 9000, error: null }, solo: [], failures: [] });
		const last = () => l.asides().at(-1)!.message.content;
		// settled: the runner's own completion, in the result's transaction
		const settled = green("tr-0abc1234gggg");
		l.request(settled.runId);
		l.result(settled);
		l.ledger.completeSlice(l.sl, { by: TEST_RUNNER_BY, artifact: settleArtifact(settled) });
		poll().fn();
		expect(last()).toContain(`The runner completed ${l.sl} on this green; a push after it needs a new run.`);
		expect(last()).not.toContain("not settled");
		// a later green on the same, already done slice settled nothing
		const late = green("tr-0abc1234hhhh");
		l.request(late.runId);
		l.result(late);
		poll().fn();
		expect(last()).toStartWith(`Test run ${late.runId} on ${l.wl}: green`);
		expect(last()).toContain(`Green, but not settled: the runner did not complete ${l.sl} (it was already done, with another artifact)`);
		expect(last()).not.toContain("The runner completed");
		// a paused slice
		const paused = l.ledger.addSlice({ by: "lane-a", workloadId: l.wl, task: "full suite", doneCondition: "a green test-run", inputs: "the PR" });
		l.ledger.raiseQuestion({ by: "lane-a", workloadId: l.wl, sliceId: paused, body: "which PR?", options: ["17", "18"] });
		const onPaused = green("tr-0abc1234iiii");
		l.request(onPaused.runId, TEST_RUNNER_BY, paused);
		l.result(onPaused);
		poll().fn();
		expect(last()).toContain(`slice ${paused}`);
		expect(last()).toContain(`Green, but not settled: the runner did not complete ${paused} (it is paused on an open question)`);
		expect(l.asides()).toHaveLength(3);
	});

	test("a runner silent past the 120 s mark is reported dead once; a fresh heartbeat, the startup lease and a settled run are not", async () => {
		const l = await lane();
		await l.f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, l.ctx);
		const t0 = Date.now();
		l.request("tr-0abc1234dddd");
		const at = (s: number) => setSystemTime(new Date(t0 + s * 1000));
		const beat = (s: number) => {
			mkdirSync(join(l.runs, "tr-0abc1234dddd"), { recursive: true });
			writeFileSync(join(l.runs, "tr-0abc1234dddd", "heartbeat"), heartbeatText("tr-0abc1234dddd", t0 + s * 1000));
		};
		// inside the startup lease, no heartbeat yet
		at(100);
		poll().fn();
		expect(l.asides()).toEqual([]);
		// request 130 s old, heartbeat 30 s old: alive
		beat(100);
		at(130);
		poll().fn();
		// heartbeat 90 s old: past liveness's 60 s, not past the 120 s mark
		at(190);
		await l.toolResult("r1");
		expect(l.asides()).toEqual([]);
		// heartbeat 121 s old: dead, said once
		at(221);
		poll().fn();
		expect(l.asides()).toHaveLength(1);
		expect(l.asides()[0]!.message.content).toStartWith(`runner for tr-0abc1234dddd died; call lane_full_test again (PR #17, slice ${l.sl}): no heartbeat for 121 s`);
		expect(l.asides()[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		at(400);
		poll().fn();
		await l.toolResult("r2");
		expect(l.asides()).toHaveLength(1);
		// a request that never got a heartbeat is dead past 120 s; one settled by a result never is
		l.request("tr-0abc1234eeee");
		l.request("tr-0abc1234ffff");
		l.result(run("tr-0abc1234ffff", null, { verdict: "error", reason: "runner died", full: null, solo: [], failures: [] }));
		at(522);
		poll().fn();
		const said = l.asides().map((x) => x.message.content);
		expect(said).toHaveLength(3);
		expect(said.filter((x) => x.startsWith("runner for tr-0abc1234eeee died"))).toHaveLength(1);
		expect(said.filter((x) => x.startsWith("runner for tr-0abc1234ffff"))).toEqual([]);
		expect(said.filter((x) => x.startsWith("Test run tr-0abc1234ffff") && x.includes("Reason: runner died") && x.includes("Full suite: not run."))).toHaveLength(1);
	});
});
