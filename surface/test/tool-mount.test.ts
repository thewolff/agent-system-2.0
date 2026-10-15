// M7 finding 1 regression (2026-09-30): OMP 18.x mounts extension tools that omit `loadMode` as
// xd:// devices while `tools.xdev` is on (its default), so in Jo's first real session the model
// reached the wake read only as `write xd://orchestrator_wake_read`, and the wake gate, keyed on the
// tool name, refused it. Fixed at ff86593 with `loadMode: "essential"` on every ledger tool.
//
// This drives a real `omp --mode rpc` session (the installed binary on PATH) against a scripted
// local OpenAI-compatible stub model, with a scratch HOME whose config.yml leaves `tools` unset, the
// surface and gates loaded as profile/config.yml lists them, and AGENT_SYSTEM_ROLE=orchestrator as
// `as2` sets it. No `--tools` flag: an explicit tool list turns the xd:// transport off
// (pi-coding-agent src/sdk.ts syncXdevState `!restrictToolNames`), which would hide the bug.
// It proves both halves of "presented top-level": every ledger tool is in the tool list the model
// receives, and none of them is in the `read xd://` device listing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { WAKE_READ_TOOL as LANE_WAKE_READ_TOOL } from "../../gates/src/rows/r07-wake-read";
import { ARTIFACT_TOOL, CLOSE_WORKLOAD_TOOL, IDENTITY_TOOL, LEDGER_TOOL, OPEN_WORKLOAD_TOOL, RECORD_INSTRUCTION_TOOL, SCHEDULE_TOOL, WAKE_READ_TOOL } from "../src/types";
import { tmpDir } from "../../ledger/test/tmp";

const REPO = resolve(import.meta.dir, "..", "..");
const LEDGER_TOOLS = [WAKE_READ_TOOL, IDENTITY_TOOL, OPEN_WORKLOAD_TOOL, CLOSE_WORKLOAD_TOOL, SCHEDULE_TOOL, RECORD_INSTRUCTION_TOOL, LEDGER_TOOL, ARTIFACT_TOOL, LANE_WAKE_READ_TOOL];

type Step = { tool: string; args: Record<string, unknown> } | { text: string };
interface Seen {
	tools: string[];
	messages: { role: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }[];
}

const textOf = (c: unknown): string =>
	typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("") : "";
const chunk = (delta: unknown, finish: string | null) => ({
	id: "stub",
	object: "chat.completion.chunk",
	created: 0,
	model: "stub",
	choices: [{ index: 0, delta, finish_reason: finish }],
	...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } } : {}),
});
const sse = (chunks: unknown[]) =>
	new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

// The as2test runner's user has no `omp` on PATH (item 24, run tr-0mv0ks648wy8d2q): the whole block,
// beforeAll included, is skipped there with the reason in its name, never weakened.
const NO_OMP = Bun.which("omp") === null;
const SKIP_REASON = NO_OMP ? " [skipped: no omp binary on PATH]" : "";
describe.skipIf(NO_OMP)(`real omp session, tools.xdev at its default: the nine ledger tools are presented top-level${SKIP_REASON}`, () => {
	const seen: Seen[] = [];
	const script: Step[] = [
		{ tool: WAKE_READ_TOOL, args: { body: "tool-mount probe: fresh ledger, nothing open" } },
		{ tool: "read", args: { path: "xd://" } },
		{ text: "done" },
	];
	let cursor = 0;
	let server: Server<undefined> | undefined;
	let root: string;
	let stderr = "";

	beforeAll(async () => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
				const body = (await req.json()) as { messages: Seen["messages"]; tools?: { function?: { name: string } }[] };
				// A request with no tools is OMP summarising or titling out of band; it takes no script step.
				if (!body.tools?.length) return sse([chunk({ role: "assistant", content: "summary" }, null), chunk({}, "stop")]);
				seen.push({ tools: body.tools.map((t) => t.function?.name ?? "?"), messages: body.messages });
				const step = script[cursor++] ?? { text: "done" };
				if ("text" in step) return sse([chunk({ role: "assistant", content: step.text }, null), chunk({}, "stop")]);
				return sse([
					chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${cursor}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null),
					chunk({}, "tool_calls"),
				]);
			},
		});

		root = tmpDir("surface-tool-mount-");
		const home = join(root, "home");
		const cwd = join(root, "cwd");
		mkdirSync(join(home, ".omp", "agent"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(home, ".omp", "agent", "models.yml"),
			`providers:\n  stub:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: stub\n        name: Stub\n        reasoning: false\n        input: [text]\n        contextWindow: 200000\n        maxTokens: 4096\n`,
		);
		// No `tools:` key: tools.xdev stays at OMP's default.
		writeFileSync(join(home, ".omp", "agent", "config.yml"), "setupVersion: 2\n");
		const ledger = join(home, ".agent-system-2", "ledger.db");
		Ledger.open(ledger, { create: true, backup: false, backupOnOpen: false }).close();

		const env: Record<string, string | undefined> = { ...process.env, HOME: home, AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: ledger };
		for (const k of ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES", "PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX", "CLAUDE_CONFIG_DIR", "AGENT_SYSTEM_WORKLOAD_ID", "AGENT_SYSTEM_LANE_ID"]) delete env[k];
		const argv = [
			"omp", "--mode", "rpc", "--model", "stub/stub", "--session-dir", join(home, "sessions"), "--no-title",
			"--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--approval-mode", "yolo", "--thinking", "off", "--cwd", cwd,
			// surface before gates, as profile/config.yml lists them
			"-e", join(REPO, "surface", "index.ts"), "-e", join(REPO, "gates", "index.ts"),
		];
		const proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const errText = new Response(proc.stderr).text().then((t) => {
			stderr = t;
		});
		const ended = (async () => {
			const reader = proc.stdout.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return false;
				buf += decoder.decode(value, { stream: true });
				for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					let event: unknown;
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					if (event && typeof event === "object" && "type" in event && event.type === "agent_end") return true;
				}
			}
		})();
		proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "hello" })}\n`);
		// A deadline, not a wait: a hung session fails with its stderr instead of the runner's bare timeout.
		const timeout = new Promise<false>((r) => setTimeout(() => r(false), 90_000));
		const finished = await Promise.race([ended, timeout]);
		proc.stdin.end();
		proc.kill();
		await proc.exited;
		await errText;
		if (!finished) throw new Error(`omp session did not reach agent_end; ${seen.length} model requests; stderr: ${stderr.slice(0, 2000)}`);
	}, 120_000);

	afterAll(() => {
		server?.stop(true);
		if (root) rmSync(root, { recursive: true, force: true });
	});

	test("the first request's tool list carries every ledger tool by name", () => {
		expect(seen.length).toBeGreaterThan(0);
		const tools = seen[0]!.tools;
		expect(LEDGER_TOOLS.filter((t) => !tools.includes(t))).toEqual([]);
		// the xd:// transport is live in this session, so the check above is not vacuous
		expect(tools).toContain("read");
		expect(tools).toContain("write");
	});

	test("the read xd:// listing is a real device listing and names no ledger tool", () => {
		const after = seen.find((r) => r.messages.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function?.name === "read")));
		expect(after).toBeDefined();
		const listing = after!.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)).at(-1) ?? "";
		expect(listing).toContain("xd://");
		expect(LEDGER_TOOLS.filter((t) => listing.includes(t))).toEqual([]);
	});

	test("the wake read called by name ran as the tool, not as an unknown or refused call", () => {
		const after = seen.find((r) => r.messages.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function?.name === WAKE_READ_TOOL)));
		expect(after).toBeDefined();
		const result = after!.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)).at(-1) ?? "";
		expect(result).toContain("Recorded wake-read entry");
	});
});
