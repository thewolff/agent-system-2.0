// paired-coding in as2 (plugins/VENDOR.md, PLAN-2 D3 and D4):
//   - the pin: all three vendored trees come from the one commit VENDOR.md names, at the versions it
//     names, with each tree's source digest and executable files as recorded there;
//   - a by-hand lane (AGENT_SYSTEM_ROLE=lane, AGENT_SYSTEM_BY_HAND=1) loaded by the installed OMP gets all
//     three adapters: each of the eight pair_* tools is registered exactly once, at the first
//     session_start, and a second session_start registers nothing and adds no handler while the
//     adapters' startup callback runs once more; pair_start through OMP's registered tool turns pairing
//     on, after which paired-coding refuses a host write.
// Hands and autonomous lanes are in loader.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { bindPrepared, countedPrepared, HAS_OMP, loadIndex, OMP_SKIP, PAIR_TOOLS, pairTools, session, world } from "./omp-host.ts";

const PLUGINS = join(import.meta.dir, "..");
const VENDOR = readFileSync(join(PLUGINS, "VENDOR.md"), "utf8");
const NAMES = ["i-have-audhd", "ask-graham", "paired-coding"] as const;

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

function files(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...files(path));
		else if (entry.isFile() && entry.name !== ".DS_Store") out.push(path);
	}
	return out;
}

/** The executable paths VENDOR.md records for one plugin. */
function recordedExecutables(plugin: string): string[] {
	const listed = new RegExp(`^- ${plugin}: (.+)$`, "m").exec(VENDOR)?.[1] ?? "";
	return [...listed.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort();
}

describe("the pin (plugins/VENDOR.md)", () => {
	const rows = new Map(
		[...VENDOR.matchAll(/^\| (i-have-audhd|ask-graham|paired-coding) \| ([^ |]+) \| .+ \| `([0-9a-f]{40})` \(origin\/main\) \| (\d{4}-\d\d-\d\d) \| `([0-9a-f]{64})` \|$/gm)].map((m) => [
			m[1]!,
			{ version: m[2]!, commit: m[3]!, digest: m[5]! },
		]),
	);

	test("one row per vendored plugin, all at one commit", () => {
		expect([...rows.keys()].sort()).toEqual([...NAMES].sort());
		expect(new Set([...rows.values()].map((r) => r.commit)).size).toBe(1);
	});

	for (const plugin of NAMES) {
		test(`${plugin}: versions match, lazy instruction files exist, no .test.mjs is shipped, and executable modes match the record`, () => {
			const row = rows.get(plugin)!;
			const root = join(PLUGINS, plugin);
			expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(row.version);
			expect(JSON.parse(readFileSync(join(root, ".omp-plugin", "plugin.json"), "utf8")).version).toBe(row.version);
			expect(readFileSync(join(root, "skills", plugin, "SKILL.md"), "utf8")).toContain("Read [instructions.md](instructions.md)");
			expect(readFileSync(join(root, "skills", plugin, "instructions.md"), "utf8").length).toBeGreaterThan(100);
			const all = files(root);
			expect(all.filter((f) => f.endsWith(".test.mjs"))).toEqual([]);
			const got = all.filter((f) => (statSync(f).mode & 0o111) !== 0).map((f) => relative(root, f)).sort();
			expect(got).toEqual(recordedExecutables(plugin));
		});
	}
});

const BY_HAND = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_BY_HAND: "1" } as const;

describe("a by-hand lane loaded by OMP", () => {
	test.skipIf(!HAS_OMP)(`all three adapters: the eight pair_* tools appear at the first session_start, once each, and a repeated session_start registers none again${OMP_SKIP}`, async () => {
		const w = world(BY_HAND);
		dispose = w.dispose;
		const loaded = await loadIndex(w.cwd);
		const s = await session(loaded, w.cwd, "main", w.root);
		expect(pairTools(s.tools())).toEqual([]);
		await s.start();
		expect(pairTools(s.tools()).sort()).toEqual([...PAIR_TOOLS].sort());
		expect(s.registrations.sort()).toEqual([...PAIR_TOOLS].sort());
		const handlers = (event: string) => loaded.extensions[0].handlers.get(event)?.length ?? 0;
		const before = ["session_start", "tool_call", "input", "before_agent_start", "session_stop"].map(handlers);
		await s.start();
		expect(s.registrations.sort()).toEqual([...PAIR_TOOLS].sort());
		expect(pairTools(s.tools()).sort()).toEqual([...PAIR_TOOLS].sort());
		expect(["session_start", "tool_call", "input", "before_agent_start", "session_stop"].map(handlers)).toEqual(before);
		const messages = await s.beforeAgentStart("what if we built a dashboard");
		expect(messages.map((m) => m.customType)).toContain("ask-graham");
	}, 30_000);

	test.skipIf(!HAS_OMP)(`the adapters' startup callback runs once on the first session_start and once on a repeated one${OMP_SKIP}`, async () => {
		const w = world(BY_HAND);
		dispose = w.dispose;
		const calls: string[] = [];
		const s = await session(await bindPrepared([countedPrepared(calls)], w.cwd), w.cwd, "main", w.root);
		const starts = () => calls.filter((c) => c.endsWith(" session_start"));
		await s.start();
		expect(starts()).toEqual(["i-have-audhd session_start"]);
		await s.start();
		expect(starts()).toEqual(["i-have-audhd session_start", "i-have-audhd session_start"]);
		expect(s.registrations.filter((n) => n === "pair_start")).toEqual(["pair_start"]);
	}, 30_000);

	test.skipIf(!HAS_OMP)(`pair_start through OMP's registered tool turns pairing on in the lane's worktree, and paired-coding then refuses a host write${OMP_SKIP}`, async () => {
		const w = world(BY_HAND);
		dispose = w.dispose;
		const s = await session(await loadIndex(w.cwd), w.cwd, "main", w.root);
		await s.start();
		const write = { type: "tool_call", toolName: "write", toolCallId: "w1", input: { path: join(w.cwd, "a.txt"), content: "a" } };
		expect(await s.runner.emitToolCall(write)).toBeUndefined();
		const pairStart = s.runner.getRegisteredTool("pair_start").definition;
		const started = await pairStart.execute("call-1", {}, undefined, undefined, s.runner.createContext());
		expect(started.isError).toBe(false);
		expect(started.content[0].text).toContain("Pairing started.");
		const refused = await s.runner.emitToolCall({ ...write, toolCallId: "w2" });
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("paired coding: write is the host's own mutating tool");
	}, 30_000);
});
