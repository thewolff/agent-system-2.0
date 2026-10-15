// plugins/index.ts drives the real vendored adapters (plugins/VENDOR.md): in the orchestrator session
// ask-graham's every-idea nudge and i-have-audhd's session-start core reach the turn, and the Stop
// settles without a block; in a lane or with no role nothing registers and nothing is sent.
// The i-have-audhd half spawns the vendored hooks/*.mjs under the temp HOME the test preload sets,
// the way the adapter does (`sh -lc 'node …'`); with no node there (the test runner's account), the
// adapter fails open and those two tests skip, visibly, rather than pass on nothing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginsLoader from "../index.ts";

const NO_NODE = Bun.spawnSync(["sh", "-lc", "command -v node"]).exitCode !== 0;
const NODE_SKIP = NO_NODE ? " [skipped: no node from `sh -lc`, which the i-have-audhd adapter spawns its hooks with]" : "";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const sent: { message: { customType: string; content: string; display: boolean }; options: { deliverAs: string } }[] = [];
	return {
		handlers,
		sent,
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: string }) {
			sent.push({ message, options });
		},
		async emit(name: string, event: unknown, ctx: unknown): Promise<unknown[]> {
			const out: unknown[] = [];
			for (const h of handlers.get(name) ?? []) out.push(await h(event, ctx));
			return out;
		},
	};
}

const SKILL = readFileSync(join(import.meta.dir, "..", "i-have-audhd", "skills", "i-have-audhd", "SKILL.md"), "utf8");
const INJECT_SPAN = SKILL.slice(SKILL.indexOf("<!-- inject:start -->") + "<!-- inject:start -->".length, SKILL.indexOf("<!-- inject:end -->")).trim();

let home: string;
let cwd: string;
let ctx: { cwd: string; sessionManager: { getSessionId: () => string; getEntries: () => unknown[] } };

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "plugins-loader-home-"));
	cwd = mkdtempSync(join(tmpdir(), "plugins-loader-cwd-"));
	mkdirSync(join(home, ".config", "ask-graham"), { recursive: true });
	writeFileSync(join(home, ".config", "ask-graham", "config"), "intensity=every-idea\n");
	ctx = { cwd, sessionManager: { getSessionId: () => "plugins-loader-test", getEntries: () => [] } };
});
afterAll(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("plugins/index.ts in the orchestrator session", () => {
	test("ask-graham at every-idea queues one hidden nextTurn nudge for an rpc or interactive input, none for extension text", async () => {
		const pi = fakePi();
		pluginsLoader(pi, { env: { AGENT_SYSTEM_ROLE: "orchestrator" }, home });
		await pi.emit("input", { text: "what if we built a dashboard", source: "rpc" }, ctx);
		await pi.emit("input", { text: "injected", source: "extension" }, ctx);
		await pi.emit("input", { text: "or a CLI", source: "interactive" }, ctx);
		expect(pi.sent.map((s) => [s.message.customType, s.message.display, s.options.deliverAs])).toEqual([
			["ask-graham", false, "nextTurn"],
			["ask-graham", false, "nextTurn"],
		]);
	});

	test("ask-graham at the default level (no config) sends nothing", async () => {
		const pi = fakePi();
		const bare = mkdtempSync(join(tmpdir(), "plugins-loader-bare-"));
		try {
			pluginsLoader(pi, { env: { AGENT_SYSTEM_ROLE: "orchestrator" }, home: bare });
			await pi.emit("input", { text: "what if we built a dashboard", source: "rpc" }, ctx);
			expect(pi.sent).toEqual([]);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	test.skipIf(NO_NODE)(`i-have-audhd: after session_start the next turn carries the SKILL.md core as one hidden message, until a context shows it delivered${NODE_SKIP}`, async () => {
		const pi = fakePi();
		pluginsLoader(pi, { env: { AGENT_SYSTEM_ROLE: "orchestrator" }, home });
		expect(await pi.emit("before_agent_start", { prompt: "hi" }, ctx)).not.toContainEqual(expect.objectContaining({ message: expect.anything() }));
		await pi.emit("session_start", {}, ctx);
		const offered = (await pi.emit("before_agent_start", { prompt: "hi" }, ctx)).filter(Boolean) as {
			message: { customType: string; content: string; display: boolean; details: { delivery: string } };
		}[];
		expect(offered).toHaveLength(1);
		const { message } = offered[0]!;
		expect(message.customType).toBe("i-have-audhd-session-start");
		expect(message.display).toBe(false);
		expect(message.content).toContain(INJECT_SPAN.split("\n")[0]!);
		expect(message.content).toContain("- 11. Machinery anchors");
		await pi.emit("context", { messages: [message] }, ctx);
		expect((await pi.emit("before_agent_start", { prompt: "next" }, ctx)).filter(Boolean)).toEqual([]);
	}, 20_000);

	test.skipIf(NO_NODE)(`i-have-audhd: a session_stop on a short reply settles without a block${NODE_SKIP}`, async () => {
		const pi = fakePi();
		pluginsLoader(pi, { env: { AGENT_SYSTEM_ROLE: "orchestrator" }, home });
		const results = await pi.emit("session_stop", { session_id: "p", last_assistant_message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		expect(results).toEqual([undefined]);
	}, 30_000);
});

describe("plugins/index.ts outside the orchestrator session", () => {
	for (const [label, env] of [
		["a lane (AGENT_SYSTEM_ROLE=lane)", { AGENT_SYSTEM_ROLE: "lane" }],
		["no role (a hand or a plain omp)", {}],
	] as const) {
		test(`${label}: no handler registers, so an rpc input and a session_start send nothing`, async () => {
			const pi = fakePi();
			pluginsLoader(pi, { env, home });
			expect([...pi.handlers.keys()]).toEqual([]);
			await pi.emit("input", { text: "what if we built a dashboard", source: "rpc" }, ctx);
			await pi.emit("session_start", {}, ctx);
			expect(pi.sent).toEqual([]);
		});
	}
});
