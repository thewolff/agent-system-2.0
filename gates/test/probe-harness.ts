import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../ledger/test/tmp";
import type { FenceSettings, FenceTarget, ShellStartCheck } from "../src/fence";
import type { Ctx, GatesAPI } from "../src/session";
import { CERTIFIED } from "./helpers";
type Wrapper = { head: string; quoted: boolean };
export type Probe = {
	id: string;
	source: string;
	historicalCommit: string;
	refusingRow: number;
	intermediate?: { commit: string; firstRefusingRow: number; provenance: string };
	command: { text: string; wrappers: Wrapper[] };
};
export type Fixture = { header: string; cases: Probe[]; control: { id: string; command: Probe["command"]; stdout: string } };
/** A gates module at any commit: snapshots before the shell-start certificate ignore `startCheck`. */
export type GateModule = {
	default: (pi: GatesAPI, env: Record<string, string | undefined>, settings: (ctx: Ctx) => Promise<FenceSettings>, startCheck?: ShellStartCheck) => void;
};
export type FenceModule = {
	fenceTargets: (command: string, cwd: string, env: Record<string, string | undefined>) => FenceTarget[];
	fenceProfile: (targets: FenceTarget[]) => string;
};
export type Outcome = { id: string; kind: "refused" | "landed" | "executed" | "wrong-row" | "not-landed" | "execution-failed" | "execution-unavailable" | "gate-error"; row?: number; exitCode?: number | null };
type Revision = { block?: boolean; reason?: string; input?: { command?: string } } | undefined;
type Handler = (event: { toolName: string; toolCallId: string; input: { command: string } }, ctx: Ctx) => Promise<Revision> | Revision;

export function fixture(): Fixture {
	return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "probe-cases.json"), "utf8")) as Fixture;
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function command(shape: Probe["command"], profile: string): string {
	return shape.wrappers.reduce((inner, wrapper) => `${wrapper.quoted ? quote(wrapper.head) : wrapper.head} -p ${quote(profile)} /bin/bash -c ${quote(inner)}`, shape.text);
}

function invoke(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
	const result = spawnSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd, env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error("probe repository setup failed");
	return result.stdout.trim();
}

/** No inherited git, shell, ledger, or agent environment reaches a spawned command. */
function environment(home: string, ledger: string): NodeJS.ProcessEnv {
	return {
		HOME: home,
		AGENT_SYSTEM_LEDGER_DB: ledger,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Probe",
		GIT_AUTHOR_EMAIL: "probe@example.invalid",
		GIT_COMMITTER_NAME: "Probe",
		GIT_COMMITTER_EMAIL: "probe@example.invalid",
		XDG_CONFIG_HOME: home,
		TMPDIR: home,
	};
}

/** Each call owns its complete repository and origin; no caller can supply a live target. */
export async function runProbe(
	id: string,
	shape: Probe["command"],
	gates: GateModule,
	fence: FenceModule,
	expected: { row: number } | { stdout: string } | { landing: true },
): Promise<Outcome> {
	const root = tmpDir("as2-probe-");
	try {
		const home = join(root, "home");
		const origin = join(root, "origin.git");
		const seed = join(root, "seed");
		const work = join(root, "work");
		mkdirSync(join(home, ".agent-system-2"), { recursive: true });
		const env = environment(home, join(home, ".agent-system-2", "ledger.db"));
		invoke(["init", "--bare", "-b", "main", origin], root, env);
		invoke(["init", "-b", "main", seed], root, env);
		writeFileSync(join(seed, "seed"), "seed\n");
		invoke(["add", "seed"], seed, env);
		invoke(["commit", "-m", "seed"], seed, env);
		invoke(["remote", "add", "origin", origin], seed, env);
		invoke(["push", "origin", "main"], seed, env);
		invoke(["clone", origin, work], root, env);
		invoke(["config", "core.hooksPath", "/dev/null"], work, env);
		invoke(["config", "commit.gpgsign", "false"], work, env);
		writeFileSync(join(work, "next"), "next\n");
		invoke(["add", "next"], work, env);
		invoke(["commit", "-m", "next"], work, env);
		const before = invoke(["--git-dir", origin, "rev-parse", "refs/heads/main"], root, env);
		const target = invoke(["rev-parse", "HEAD"], work, env);
		if (before === target) throw new Error("probe repository setup failed");

		const profile = fence.fenceProfile(fence.fenceTargets("", work, env));
		const typed = command(shape, profile);
		const handlers: Handler[] = [];
		const pi = {
			on: (name: string, handler: Handler) => { if (name === "tool_call") handlers.push(handler); },
			getActiveTools: () => ["bash", "read"],
			getAllTools: () => [{ name: "bash" }, { name: "read" }],
			setActiveTools: async () => {}, appendEntry: () => {}, registerTool: () => {},
			zod: { object: () => ({}), string: () => ({ describe: () => ({}), optional: () => ({ describe: () => ({}) }) }) },
		};
		gates.default(pi as unknown as GatesAPI, env, async () => ({ enabled: true, autoBackground: true }), CERTIFIED);
		const ctx = { hasUI: true, cwd: work, sessionManager: { getHeader: () => null, getEntries: () => [] }, ui: { notify: () => {} } };
		const event = { toolName: "bash", toolCallId: id, input: { command: typed } };
		let revision: Revision;
		try {
			for (const handler of handlers) {
				const next = await handler(event, ctx) as Revision;
				if (!next) continue;
				if (next.block) {
					const row = /^P-11 row (\d+)\b/.exec(next.reason ?? "");
					const after = invoke(["--git-dir", origin, "rev-parse", "refs/heads/main"], root, env);
					if (after !== before) return { id, kind: "landed" };
					return { id, kind: "row" in expected && Number(row?.[1]) === expected.row ? "refused" : "wrong-row", row: row ? Number(row[1]) : undefined };
				}
				revision = next;
			}
		} catch {
			return { id, kind: "gate-error" };
		}
		const executed = spawnSync("/bin/bash", ["-c", revision?.input?.command ?? typed], {
			cwd: work, env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
		});
		const after = invoke(["--git-dir", origin, "rev-parse", "refs/heads/main"], root, env);
		if (executed.status !== 0) return { id, kind: executed.status === 71 && executed.stderr.includes("sandbox_apply") ? "execution-unavailable" : "execution-failed", exitCode: executed.status };
		if ("landing" in expected) return { id, kind: after === target ? "landed" : "not-landed" };
		if ("stdout" in expected) return { id, kind: after === before && executed.stdout === expected.stdout ? "executed" : "not-landed" };
		return { id, kind: after === target ? "landed" : "not-landed" };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
