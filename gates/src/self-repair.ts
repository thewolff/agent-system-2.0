import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { writeTargets } from "./targets";
import type { Refusal, ToolCall } from "./types";

export const SELF_REPAIR_ENV = "AGENT_SYSTEM_SELF_REPAIR";
export const SELF_REPAIR_ROOTS_ENV = "AGENT_SYSTEM_SELF_REPAIR_ROOTS";
export const SELF_REPAIR_AGENTS = ["self-repair"] as const;

export function selfRepairOn(env: Record<string, string | undefined>): boolean {
	return env[SELF_REPAIR_ENV] === "1";
}

export function selfRepairRoots(env: Record<string, string | undefined>): string[] {
	if (!selfRepairOn(env)) return [];
	return [...new Set((env[SELF_REPAIR_ROOTS_ENV] ?? "").split(":").filter(Boolean).map((path) => resolve(path)))];
}

export function insideSelfRepairRoots(path: string, env: Record<string, string | undefined>): boolean {
	const lexical = resolve(path);
	let existing = lexical;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	const physical = resolve(realpathSync(existing), relative(existing, lexical));
	return selfRepairRoots(env).some((root) => {
		if (!existsSync(root)) return false;
		const child = relative(realpathSync(root), physical);
		return child === "" || (!child.startsWith("..") && !isAbsolute(child));
	});
}

function dispatchItems(input: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(input.tasks) ? input.tasks.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [input];
}

export function selfRepairDispatchRefusal(input: Record<string, unknown>): Refusal {
	const bad = dispatchItems(input).flatMap((item, index) =>
		typeof item.agent === "string" && (SELF_REPAIR_AGENTS as readonly string[]).includes(item.agent) ? [] : [`item ${index}: ${JSON.stringify(item.agent)}`],
	);
	return bad.length === 0
		? null
		: {
				block: true,
				reason: `AS2 self-repair dispatches only the repository agents ${SELF_REPAIR_AGENTS.join(", ")}; ${bad.join("; ")}`,
			};
}

export function selfRepairToolRefusal(call: ToolCall, cwd: string, env: Record<string, string | undefined>): Refusal {
	if (!selfRepairOn(env)) return null;
	if (call.toolName === "eval") {
		return { block: true, reason: "AS2 self-repair refuses eval because its file writes cannot be confined to the AS2 repository and install directories; use file tools or fenced bash" };
	}
	if (!Object.hasOwn({ write: true, edit: true, ast_edit: true }, call.toolName)) return null;
	const targets = writeTargets(call, cwd);
	const outside = targets.filter((target) => !insideSelfRepairRoots(target, env));
	if (targets.length > 0 && outside.length === 0) return null;
	return {
		block: true,
		reason: `AS2 self-repair may write only inside its repository and install directories; refused ${call.toolName} target(s): ${(outside.length ? outside : ["<no filesystem target>"]).join(", ")}`,
	};
}
