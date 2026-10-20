// Adapter-only coverage; T4 baseline regressions remain in existing entry-point test files.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LinkRouter } from "../../gates/src/links";
import { setLinkRouter } from "../../gates/src/links";
import { linkedApi } from "../src/linked-api";
import orchestratorSurface from "../index";
import { surfaceSession } from "../src/session";
import type { FakeTool } from "./helpers";
import { ctxOf, fakePi, loadTestText, notices, tempLedger, timeouts, timers, tmp } from "./helpers";
import { INVARIANT_MS } from "../src/types";

// Runtime-selected installed host, the same discovery convention as plan-paths.test.ts.
let host: string | null = null;
const omp = Bun.which("omp");
if (omp) {
	let dir = dirname(realpathSync(omp));
	while (basename(dir) !== "@oh-my-pi" && dirname(dir) !== dir) dir = dirname(dir);
	const candidate = join(dir, "pi-coding-agent", "src", "internal-urls");
	if (existsSync(join(candidate, "local-protocol.ts"))) host = candidate;
}

describe("shared synchronous surface adapter", () => {
	test("ledger consumers keep old local handles plain despite same-named lane and Ilex files", async () => {
		timeouts.length = 0;
		timers.length = 0;
		const root = tmp("ledger-local-collision");
		const lane = join(root, "lane"), ilex = join(root, "ilex");
		for (const dir of [lane, ilex]) {
			mkdirSync(join(dir, "local"), { recursive: true });
			writeFileSync(join(dir, "local", "PLAN.md"), dir === lane ? "lane plan" : "unrelated Ilex plan");
		}
		const storedPath = join(lane, "local", "PLAN.md");
		const storedTarget = new URL(`file://${storedPath}`).href;
		const wrongTarget = new URL(`file://${join(ilex, "local", "PLAN.md")}`).href;
		let syncCalls = 0;
		const router: LinkRouter = {
			async locate() { throw new Error("ledger rendering must not recover old sessions"); },
			locateSync(handle, rc) {
				syncCalls++;
				return join(rc.localProtocolOptions!.getArtifactsDir!()!, "local", handle.split("://")[1]!);
			},
		};
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "fixture", brief: "Legacy handles", stakes: "normal", mode: "user-driven" });
		const sl = ledger.addSlice({ by: "lane-old", workloadId: wl, task: "review", doneCondition: "reviewed", inputs: "legacy" });
		const body = `local://PLAN.md memory://PLAN.md ${storedPath} https://example.com/plan`;
		ledger.recordEntry({ by: "lane-old", workloadId: wl, kind: "assumption", body: `entry ${body}` });
		ledger.raiseQuestion({ by: "lane-old", workloadId: wl, sliceId: sl, body: `question ${body}`, options: ["yes", "no"] });
		ledger.enqueue({ by: "lane-old", workloadId: wl, sender: "lane-old", recipient: "orchestrator", body: `relay ${body}` });
		const f = fakePi();
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_SURFACE_BATCH_MS: "0", HOME: "/nonexistent-home" };
		const ctx = Object.assign(ctxOf({ cwd: ilex }), {
			localProtocolOptions: { getArtifactsDir: () => ilex, getSessionId: () => "ilex" },
		});
		const plainHandles = (text: string) => {
			expect(text).toContain("local://PLAN.md");
			expect(text).toContain("memory://PLAN.md");
			expect(text).not.toContain("[local://");
			expect(text).not.toContain("[memory://");
			expect(text).not.toContain(wrongTarget);
		};
		setLinkRouter(router);
		try {
			await orchestratorSurface(f.pi, env, { loadText: loadTestText });
			await f.emit("session_start", {}, ctx);
			for (const timer of timeouts.splice(0)) timer.fn();
			const wake = f.sent.find((s) => s.message.customType === "surface-wake")!;
			plainHandles(wake.message.content);
			expect(wake.message.content).toContain("question local://PLAN.md");
			await f.admit(wake, ctx);

			const tool = f.tool("orchestrator_ledger") as FakeTool & {
				renderResult(result: unknown): { render(width: number): string[] };
			};
			const read = await tool.execute("1", { workload: wl }, undefined, undefined, ctx);
			plainHandles(read.content[0]!.text);
			expect(read.content[0]!.text).toContain(`[${storedPath}](${storedTarget})`);
			for (const origin of ["entry", "question", "relay"]) expect(read.content[0]!.text).toContain(`${origin} local://PLAN.md`);
			expect(read.content[0]!.text).toContain("<https://example.com/plan>");
			const display = tool.renderResult(read).render(10_000).join("\n");
			plainHandles(display);
			expect(display).toContain(`\x1b]8;;${storedTarget}\x07`);

			// A fresh between-wake question, not just the initial wake/on-demand render.
			ledger.raiseQuestion({ by: "lane-old", workloadId: wl, sliceId: sl, body: `later question ${body}`, options: ["yes", "no"] });
			// The invariant timer (MIGRATION.md item 104) pushes its own surface-notices; this test fires the poll only.
			const poll = () => { for (const timer of timers) if (timer.ms !== INVARIANT_MS) timer.fn(); };
			poll();
			const needsYou = f.sent.find((s) => s.message.customType === "surface-needs-you")!;
			plainHandles(needsYou.message.content);
			expect(needsYou.message.content).toContain("later question local://PLAN.md");

			await f.emit("input", { text: "pending", source: "interactive" }, ctx);
			plainHandles(f.sent.find((s) => s.message.customType === "surface-pending")!.message.content);
			const session = surfaceSession(ctx, env);
			session.tickNotices.push(`tick ${body}`);
			poll();
			plainHandles(f.sent.find((s) => s.message.customType === "surface-notices")!.message.content);
			session.notices.push(`applied ${body}`);
			const turn = await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx) as { messages: { content: string }[] };
			const returned = turn.messages.map((m) => m.content).join("\n");
			plainHandles(returned);
			expect(returned).toContain("## Applied from the surface since your last turn");
			expect(returned).toContain("applied local://PLAN.md");
			expect(syncCalls).toBe(0);

			// Identical text outside the ledger boundary still belongs to this caller.
			linkedApi(f.pi, ctx, router).sendMessage!({ customType: "current-caller", content: "local://PLAN.md", display: true });
			expect(f.sent.at(-1)!.message.content).toBe(`[local://PLAN.md](${wrongTarget})`);
			expect(syncCalls).toBe(1);
		} finally {
			setLinkRouter(undefined);
			ledger.close();
		}
	});

	test("new lane writes expand the original caller's handles before ledger rendering", async () => {
		const root = tmp("lane-write-collision");
		const lane = join(root, "lane"), ilex = join(root, "ilex");
		for (const dir of [lane, ilex]) {
			mkdirSync(join(dir, "local"), { recursive: true });
			writeFileSync(join(dir, "local", "PLAN.md"), dir);
		}
		const original = join(lane, "local", "PLAN.md");
		const { ledger, path } = tempLedger();
		const laneId = "lane-original";
		const wl = ledger.openWorkload({ by: "fixture", brief: "Original caller", stakes: "normal", mode: "user-driven" });
		expect(ledger.claimWorkload(wl, { by: laneId, holder: laneId, leaseMs: 60_000 }).won).toBe(true);
		const sl = ledger.addSlice({ by: laneId, workloadId: wl, task: "write", doneCondition: "stored", inputs: "handles" });
		const f = fakePi();
		const ctx = Object.assign(ctxOf({ cwd: lane }), {
			localProtocolOptions: { getArtifactsDir: () => lane, getSessionId: () => laneId },
		});
		const callers: string[] = [];
		setLinkRouter({
			async locate(handle, rc) {
				const dir = rc.localProtocolOptions!.getArtifactsDir!()!;
				callers.push(dir);
				const path = join(dir, "local", handle.slice("local://".length));
				return existsSync(path) ? path : null;
			},
			locateSync() { throw new Error("storage uses the original caller's async lookup"); },
		});
		try {
			await orchestratorSurface(f.pi, {
				AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: laneId, AGENT_SYSTEM_WORKLOAD_ID: wl,
				AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home",
			}, { loadText: loadTestText });
			const body = "local://PLAN.md local://missing.md";
			for (const name of ["lane_record_entry", "lane_message", "lane_raise_question"]) {
				await f.tool(name).execute("1", { body, slice: sl, options: ["yes", "no"] }, undefined, undefined, ctx);
			}
			const expanded = `${original} local://missing.md`;
			expect(ledger.entries(wl).find((e) => e.body === expanded)).toBeDefined();
			expect(ledger.inFlight().find((w) => w.workload.id === wl)!.pendingMessages.at(-1)!.body).toBe(expanded);
			expect(ledger.questions(wl).at(-1)!.body).toBe(expanded);
			expect(callers).toEqual(Array(6).fill(lane));
			expect(expanded).not.toContain("file://");
			expect(expanded).not.toContain("](");
		} finally {
			setLinkRouter(undefined);
			ledger.close();
		}
	});

	test.skipIf(host === null)("a real LocalProtocolHandler links a caller-local file before send returns, preserving A/B/C order and leaving artifact handles plain", async () => {
		// Static imports cannot name the OMP install selected from PATH at runtime.
		const [{ LocalProtocolHandler }, { parseInternalUrl }] = await Promise.all([
			import(join(host!, "local-protocol.ts")), import(join(host!, "parse.ts")),
		]);
		const local = new LocalProtocolHandler();
		const root = tmp("local-host");
		mkdirSync(join(root, "local"));
		const path = join(root, "PLAN with spaces.md");
		const localPath = join(root, "local", "a.md");
		writeFileSync(path, "plan");
		writeFileSync(localPath, "local");
		const router: LinkRouter = {
			locate: (handle, rc) => handle.startsWith("local://") ? local.locate(parseInternalUrl(handle), rc) : Promise.resolve(null),
			locateSync: (handle, rc) => handle.startsWith("local://") ? local.locateSync(parseInternalUrl(handle), rc) : undefined,
		};
		const ctx = Object.assign(ctxOf({ cwd: root }), {
			localProtocolOptions: { getArtifactsDir: () => root, getSessionId: () => "caller-local" },
		});
		const f = fakePi();
		const api = linkedApi(f.pi, ctx, router);
		const target = new URL(`file://${path}`).href;
		const localTarget = new URL(`file://${localPath}`).href;
		api.sendMessage!({ customType: "A", content: `${path} and local://a.md`, display: true });
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]!.message.content).toBe(`[${path}](${target}) and [local://a.md](${localTarget})`);
		api.sendMessage!({ customType: "B", content: "artifact://unresolved", display: true });
		api.sendMessage!({ customType: "C", content: "third", display: true });
		expect(f.sent.map((s) => s.message.customType)).toEqual(["A", "B", "C"]);
		expect(f.sent[1]!.message.content).toBe("artifact://unresolved");
	}, 30_000);

	test("registered handlers bind notify, returned messages and timer sends to their own cwd in the same call", async () => {
		timeouts.length = 0;
		notices.length = 0;
		const root = tmp("link-context");
		const path = join(root, "a.md");
		writeFileSync(path, "a");
		const target = new URL(`file://${path}`).href;
		const f = fakePi();
		const api = linkedApi(f.pi);
		api.on("before_agent_start", (_event, ctx) => {
			ctx.ui.notify("a.md", "info");
			api.sendMessage!({ customType: "immediate", content: "a.md", display: true });
			ctx.setTimeout(() => api.sendMessage!({ customType: "timer", content: "a.md", display: true }), 1);
			return { message: { customType: "returned", content: "a.md", display: true } };
		});
		const result = await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctxOf({ cwd: root })) as { messages: { content: string }[] };
		expect(f.sent[0]!.message.content).toBe(`[${path}](${target})`);
		expect(result.messages[0]!.content).toBe(`[${path}](${target})`);
		expect(notices[0]).toContain(`\x1b]8;;${target}\x07${path}\x1b]8;;\x07`);
		timeouts[0]!.fn();
		expect(f.sent[1]!.message.content).toBe(`[${path}](${target})`);
	});

	test("a synchronous send failure propagates without scheduling a replacement", () => {
		let calls = 0;
		const api = linkedApi({ sendMessage() { calls++; throw new Error("host refused"); } }, ctxOf());
		expect(() => api.sendMessage()).toThrow("host refused");
		expect(calls).toBe(1);
	});

	for (const toolName of ["lane_record_entry", "lane_message", "lane_raise_question"]) {
		test(`${toolName} refuses a write when ownership changes while locating a handle`, async () => {
			const { ledger, path } = tempLedger();
			const wl = ledger.openWorkload({ by: "fixture", brief: "Caller-local write", stakes: "normal", mode: "autonomous" });
			const laneId = "lane-locate-owner";
			expect(ledger.claimWorkload(wl, { by: laneId, holder: laneId, leaseMs: 60_000 }).won).toBe(true);
			const sl = ledger.addSlice({ by: laneId, workloadId: wl, task: "write", doneCondition: "written", inputs: "caller-local handle" });
			const f = fakePi();
			await orchestratorSurface(f.pi, {
				AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: laneId, AGENT_SYSTEM_WORKLOAD_ID: wl,
				AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home",
			}, { loadText: loadTestText });
			const entered = Promise.withResolvers<void>();
			const located = Promise.withResolvers<string | null>();
			let lookups = 0;
			setLinkRouter({
				locate() { lookups++; entered.resolve(); return located.promise; },
				locateSync() { return undefined; },
			});
			try {
				const before = { entries: ledger.entries(wl).length, questions: ledger.questions(wl).length, messages: ledger.workload(wl)!.held_messages };
				const ctx = ctxOf();
				const params = { body: "Read local://PLAN.md", slice: sl, options: ["yes", "no"] };
				const pending = f.tool(toolName).execute("1", params, undefined, undefined, ctx);
				await entered.promise;
				ledger.releaseWorkload(wl, { by: laneId, holder: laneId });
				expect(ledger.claimWorkload(wl, { by: "lane-new-owner", holder: "lane-new-owner", leaseMs: 60_000 }).won).toBe(true);
				located.resolve(join(ctx.cwd, "PLAN.md"));
				const reply = await pending;
				expect(reply.content[0]!.text).toContain("held by lane-new-owner");
				expect({ entries: ledger.entries(wl).length, questions: ledger.questions(wl).length, messages: ledger.workload(wl)!.held_messages }).toEqual(before);
				// The initial guard is retained: another refused call performs no resolver work.
				await f.tool(toolName).execute("2", params, undefined, undefined, ctx);
				expect(lookups).toBe(1);
			} finally {
				located.resolve(null);
				setLinkRouter(undefined);
				ledger.close();
			}
		});
	}

	test("ledger reads remain available when the optional host renderer cannot load", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "fixture", brief: "Keep ledger data readable", stakes: "normal", mode: "autonomous" });
		const f = fakePi();
		try {
			await orchestratorSurface(f.pi, {
				AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home",
			}, { loadText: async () => { throw new Error("host Text missing"); } });
			const tool = f.tool("orchestrator_ledger") as FakeTool & { renderResult(result: unknown): unknown };
			const result = await tool.execute("1", { workload: wl }, undefined, undefined, ctxOf());
			expect(result.content[0]!.text).toContain(wl);
			expect(result.content[0]!.text).toContain("Keep ledger data readable");
			expect(() => tool.renderResult(result)).toThrow("host Text missing");
		} finally {
			ledger.close();
		}
	});

	test.skipIf(host === null)("preloaded real host Text wraps OSC8 ledger links at narrow widths without a fresh execute", async () => {
		// The installed host module is platform-specific and selected from PATH, not a repo dependency.
		const { Text } = await import(join(host!, "..", "..", "..", "pi-tui", "src", "components", "text.ts"));
		const f = fakePi();
		const path = join(tmp("real-ledger-render"), "PLAN with spaces.md");
		writeFileSync(path, "plan");
		await orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: "orchestrator", HOME: "/nonexistent-home" }, { loadText: async () => Text });
		const tool = f.tool("orchestrator_ledger") as FakeTool & {
			renderResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown): { render(width: number): string[] };
		};
		const target = new URL(`file://${path}`).href;
		const component = tool.renderResult({ content: [{ type: "text", text: `[${path}](${target})` }] }, { expanded: true, isPartial: false }, {});
		const lines = component.render(40);
		expect(lines.every((line) => Bun.stringWidth(line) <= 40)).toBe(true);
		const painted = lines.join("").replace(/\x1b\]8;[^\x07]*(?:\x07)|\x1b\[[0-9;]*m/g, "");
		expect(painted).toContain(path);
		expect(painted).toContain(target);
		expect(lines.join("\n")).toContain(`\x1b]8;;${target}`);
	}, 30_000);
});
