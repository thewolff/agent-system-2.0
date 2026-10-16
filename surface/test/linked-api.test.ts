// Adapter-only coverage; T4 baseline regressions remain in existing entry-point test files.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LinkRouter } from "../../gates/src/links";
import { setLinkRouter } from "../../gates/src/links";
import { linkedApi } from "../src/linked-api";
import orchestratorSurface from "../index";
import type { FakeTool } from "./helpers";
import { ctxOf, fakePi, loadTestText, notices, tempLedger, timeouts, tmp } from "./helpers";

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

	test("host Text loader failure is explicit on a ledger read rather than returning an unsafe renderer", async () => {
		const f = fakePi();
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("unread-ledger"), "ledger.db"), HOME: "/nonexistent-home" };
		await orchestratorSurface(f.pi, env, { loadText: async () => { throw new Error("host Text missing"); } });
		await expect(f.tool("orchestrator_ledger").execute("1", {}, undefined, undefined, ctxOf())).rejects.toThrow("host Text missing");
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
