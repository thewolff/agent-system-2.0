// plugins/index.ts under the installed OMP's own loader and runner (plugins/test/omp-host.ts), against the
// real vendored adapters (plugins/VENDOR.md, PLAN-2 D4):
//   - the orchestrator and every lane run i-have-audhd and ask-graham, and no lane but a by-hand one gets
//     a pair_* tool (paired-coding.test.ts covers the by-hand lane);
//   - a hand, which OMP builds by re-binding the parent's prepared factories into a child session with the
//     parent's env still set, runs no adapter callback and holds no pair_* tool, whether its session file
//     names a parent or it has no header at all;
//   - installed marketplace copies of all three adapters stay unloaded beside plugins/index.ts while a
//     control plugin seeded the same way loads;
//   - the real adapters read and write only the world's HOME (omp-host.ts world()): the startup hook's
//     child process and the adapter's in-process fail-open log both land there, and the real home's
//     ~/.claude/.i-have-audhd-state keeps its existence and mtime.
// i-have-audhd's session-start core comes from its hooks/*.mjs, which the adapter spawns with `sh -lc
// 'node …'`; with no node there the adapter fails open and the expected messages say so.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bindPrepared, countedPrepared, discoverWithSeededPlugins, HAS_OMP, INDEX, loadIndex, OMP_SKIP, pairTools, REAL_HOME, type SessionKind, session, stamp, world } from "./omp-host.ts";

const NO_NODE = Bun.spawnSync(["sh", "-lc", "command -v node"]).exitCode !== 0;
/** The hidden messages a prompt carries after session_start: i-have-audhd's core (when node runs its hook), then ask-graham's nudge. */
const STARTED = NO_NODE ? ["ask-graham"] : ["i-have-audhd-session-start", "ask-graham"];

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("plugins/index.ts loaded by OMP into a top-level session", () => {
	for (const [label, env] of [
		["the orchestrator", { AGENT_SYSTEM_ROLE: "orchestrator" }],
		["the orchestrator, even with AGENT_SYSTEM_BY_HAND=1", { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_BY_HAND: "1" }],
		["an autonomous lane", { AGENT_SYSTEM_ROLE: "lane" }],
	] as const) {
		test.skipIf(!HAS_OMP)(`${label}: nothing runs before session_start; after it a prompt carries i-have-audhd's core and ask-graham's nudge, and no pair_* tool exists${OMP_SKIP}`, async () => {
			const w = world(env);
			dispose = w.dispose;
			const s = await session(await loadIndex(w.cwd), w.cwd, "main", w.root);
			expect(await s.beforeAgentStart("what if we built a dashboard")).toEqual([]);
			await s.start();
			const messages = await s.beforeAgentStart("what if we built a dashboard");
			expect(messages.map((m) => m.customType)).toEqual(STARTED);
			expect(messages.every((m) => m.display === false)).toBe(true);
			expect(pairTools(s.tools())).toEqual([]);
			expect(s.registrations).toEqual([]);
		}, 30_000);
	}

	for (const [label, env] of [
		["no role (a plain omp on this profile)", {}],
		["no role with AGENT_SYSTEM_BY_HAND=1", { AGENT_SYSTEM_BY_HAND: "1" }],
	] as const) {
		test.skipIf(!HAS_OMP)(`${label}: the extension registers no handler and no tool${OMP_SKIP}`, async () => {
			const w = world(env);
			dispose = w.dispose;
			const s = await session(await loadIndex(w.cwd), w.cwd, "main", w.root);
			for (const event of ["session_start", "before_agent_start", "session_stop", "tool_call", "input"]) expect(s.runner.hasHandlers(event)).toBe(false);
			await s.start();
			expect(await s.beforeAgentStart("what if we built a dashboard")).toEqual([]);
			expect(s.tools()).toEqual([]);
		});
	}
});

describe("a hand: the parent's prepared plugins/index.ts re-bound into a child session, the parent's env still set", () => {
	const parents = [
		["an orchestrator", { AGENT_SYSTEM_ROLE: "orchestrator" }],
		["an autonomous lane", { AGENT_SYSTEM_ROLE: "lane" }],
		["a by-hand lane", { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_BY_HAND: "1" }],
	] as const;
	const children: [string, SessionKind][] = [
		["a persisted child (its header names the parent session)", "persisted-child"],
		["a headerless in-memory child", "headerless-child"],
	];
	for (const [parent, env] of parents) {
		for (const [child, kind] of children) {
			test.skipIf(!HAS_OMP)(`${parent}'s hand, ${child}: no adapter callback runs and no pair_* tool is registered${OMP_SKIP}`, async () => {
				const w = world(env);
				dispose = w.dispose;
				// The plain production factory, as the parent prepared it.
				const parentLoad = await loadIndex(w.cwd);
				const plain = await session(await bindPrepared(parentLoad.preparedExtensions, w.cwd), w.cwd, kind, w.root);
				await plain.start();
				await plain.start();
				expect(await plain.beforeAgentStart("what if we built a dashboard")).toEqual([]);
				expect(pairTools(plain.tools())).toEqual([]);
				expect(plain.registrations).toEqual([]);

				// The same factory with every adapter handler counted when OMP calls it.
				const calls: string[] = [];
				const s = await session(await bindPrepared([countedPrepared(calls)], w.cwd), w.cwd, kind, w.root);
				await s.start();
				await s.beforeAgentStart("what if we built a dashboard");
				await s.runner.emit({ type: "input", text: "pair with me", source: "interactive" });
				await s.runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "c1", input: { path: join(w.cwd, "x"), content: "x" } });
				await s.runner.emitSessionStop({ signal: new AbortController().signal, session_id: "hand", last_assistant_message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
				await s.start();
				expect(calls).toEqual([]);
				expect(pairTools(s.tools())).toEqual([]);
				expect(s.registrations).toEqual([]);
			});
		}
	}

	test.skipIf(!HAS_OMP)(`control: the same counted factory in the by-hand lane's own session does reach the adapters${OMP_SKIP}`, async () => {
		const w = world({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_BY_HAND: "1" });
		dispose = w.dispose;
		const calls: string[] = [];
		const s = await session(await bindPrepared([countedPrepared(calls)], w.cwd), w.cwd, "main", w.root);
		await s.start();
		await s.beforeAgentStart("what if we built a dashboard");
		expect(calls).toEqual(["i-have-audhd session_start", "i-have-audhd before_agent_start", "ask-graham before_agent_start"]);
		expect(pairTools(s.tools()).length).toBe(8);
	}, 30_000);
});

describe("the developer's HOME (the world's HOME stands in for it)", () => {
	const realState = join(REAL_HOME, ".claude", ".i-have-audhd-state");

	test.skipIf(!HAS_OMP || NO_NODE)(`the startup hook, a child process, reads no profile and leaves its judge notice marker under the world's HOME; the real state dir is untouched${OMP_SKIP}`, async () => {
		const w = world({ AGENT_SYSTEM_ROLE: "orchestrator" });
		dispose = w.dispose;
		const s = await session(await loadIndex(w.cwd), w.cwd, "main", w.root);
		const before = stamp(realState);
		await s.start();
		const messages = await s.beforeAgentStart("what if we built a dashboard");
		expect(stamp(realState)).toEqual(before);
		const core = messages.find((m) => m.customType === "i-have-audhd-session-start")?.content ?? "";
		expect(core).toContain("No reader profile is configured");
		expect(existsSync(join(w.home, ".claude", ".i-have-audhd-state", "judge-notice-shown"))).toBe(true);
	}, 30_000);

	test.skipIf(!HAS_OMP)(`a startup hook that fails is logged by the adapter in-process under the world's HOME; the real state dir is untouched${OMP_SKIP}`, async () => {
		const w = world({ AGENT_SYSTEM_ROLE: "orchestrator" });
		dispose = w.dispose;
		process.env.I_HAVE_AUDHD_PLUGIN_ROOT = join(w.root, "no-such-plugin");
		const s = await session(await loadIndex(w.cwd), w.cwd, "main", w.root);
		const before = stamp(realState);
		await s.start();
		const messages = await s.beforeAgentStart("what if we built a dashboard");
		expect(stamp(realState)).toEqual(before);
		expect(messages.map((m) => m.customType)).toEqual(["ask-graham"]);
		expect(readFileSync(join(w.home, ".claude", ".i-have-audhd-state", "errors.log"), "utf8")).toContain("omp-adapter fail-open: omp-adapter: CLI exited");
	}, 30_000);
});

describe("marketplace copies of the three adapters (VENDOR.md clash C11)", () => {
	test.skipIf(!HAS_OMP)(`OMP's discovery under profile/config.yml's disabledExtensions skips installed i-have-audhd, ask-graham and paired-coding while a control plugin and plugins/index.ts load${OMP_SKIP}`, () => {
		const w = world({});
		dispose = w.dispose;
		const { loaded, errors } = discoverWithSeededPlugins(w.root, ["i-have-audhd", "ask-graham", "paired-coding", "decoy-control"]);
		expect(errors).toEqual([]);
		expect(loaded.filter((p) => p.endsWith("/decoy-control/omp/decoy-control-omp.ts"))).toHaveLength(1);
		expect(loaded.filter((p) => /\/(i-have-audhd|ask-graham|paired-coding)\/omp\/[a-z-]+-omp\.ts$/.test(p))).toEqual([]);
		expect(loaded.filter((p) => p === INDEX)).toHaveLength(1);
	}, 30_000);
});
