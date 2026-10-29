import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { checkOrchestratorRole, ORCHESTRATOR_ROLE_REFUSAL } from "../src/rows/r15-orchestrator-role";
import { selfRepairDispatchRefusal, selfRepairToolRefusal } from "../src/self-repair";
import type { CallContext, ToolCall } from "../src/types";
import { tmp } from "./helpers";

const repo = tmp("self-repair-repo");
const profile = tmp("self-repair-profile");
const outside = tmp("self-repair-outside");
const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_SELF_REPAIR: "1", AGENT_SYSTEM_SELF_REPAIR_ROOTS: `${repo}:${profile}` };
const ctx: CallContext = { role: "orchestrator", cwd: repo, env };

const call = (toolName: string, input: Record<string, unknown>): ToolCall => ({ toolName, input });

describe("AS2 self-repair boundary", () => {
	test("normal orchestrators still refuse dispatch and writes", () => {
		const normal: CallContext = { role: "orchestrator", cwd: repo, env: { AGENT_SYSTEM_ROLE: "orchestrator" } };
		expect(checkOrchestratorRole(call("task", { agent: "builder", task: "repair" }), normal)).toEqual({ block: true, reason: ORCHESTRATOR_ROLE_REFUSAL });
		expect(checkOrchestratorRole(call("write", { path: join(repo, "x.ts"), content: "x" }), normal)).toEqual({ block: true, reason: ORCHESTRATOR_ROLE_REFUSAL });
	});

	test("repair mode admits only the dedicated self-repair agent", () => {
		expect(selfRepairDispatchRefusal({ agent: "self-repair", task: "repair" })).toBeNull();
		expect(checkOrchestratorRole(call("task", { agent: "self-repair", task: "repair" }), ctx)).toBeNull();
		for (const agent of ["task", "strong", "builder", "scout", "unknown"]) {
			expect(checkOrchestratorRole(call("task", { agent, task: "repair" }), ctx)?.reason).toContain("self-repair dispatches only");
		}
	});

	test("repair mode admits bash to the OS confinement layer", () => {
		expect(checkOrchestratorRole(call("bash", { command: `printf x > ${join(repo, "x")}` }), ctx)).toBeNull();
	});

	test("repair mode confines file tools to the repair worktree and AS2 profile", () => {
		for (const target of [join(repo, "gates", "x.ts"), join(profile, "agent", "config.yml")]) {
			expect(selfRepairToolRefusal(call("write", { path: target, content: "x" }), repo, env)).toBeNull();
			expect(checkOrchestratorRole(call("write", { path: target, content: "x" }), ctx)).toBeNull();
		}
		for (const target of [join(outside, "x.ts"), "../outside.ts"]) {
			expect(checkOrchestratorRole(call("edit", { path: target }), ctx)?.reason).toContain("may write only inside its repair worktree and AS2 profile");
		}
	});

	test("repair roots are physical: a symlink inside the repository cannot target outside", () => {
		const isolatedRepo = tmp("self-repair-symlink-repo");
		const link = join(isolatedRepo, "outside-link");
		symlinkSync(outside, link);
		const isolatedEnv = { ...env, AGENT_SYSTEM_SELF_REPAIR_ROOTS: `${isolatedRepo}:${profile}` };
		const isolatedCtx: CallContext = { ...ctx, cwd: isolatedRepo, env: isolatedEnv };
		expect(checkOrchestratorRole(call("write", { path: join(link, "x.ts"), content: "x" }), isolatedCtx)?.reason).toContain("may write only inside its repair worktree and AS2 profile");
	});

	test("repair mode keeps eval disabled because it cannot confine in-process writes", () => {
		expect(checkOrchestratorRole(call("eval", { language: "js", code: "await Bun.write('/tmp/x', 'x')" }), ctx)?.reason).toContain("self-repair refuses eval");
	});
});
