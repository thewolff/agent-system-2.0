import { describe, expect, test } from "bun:test";
import reservedRow from "../extensions/r06-reserved";
import turnShapeRow from "../extensions/r01-turn-shape";
import type { GatesAPI } from "../src/session";
import { tempLedger, tmp } from "./helpers";
type Event = Record<string, unknown>;
interface TestContext {
	hasUI: boolean;
	cwd: string;
	sessionManager: { getHeader(): Record<string, never>; getEntries(): never[] };
	ui: { notify(message: string): number };
}
type Result = { block?: boolean; decision?: string; handled?: boolean; reason?: string } | undefined;
type Handler = (event: Event, context: TestContext) => Result | Promise<Result>;

function host() {
	const handlers = new Map<string, Handler[]>();
	const entries: { type: string; data: unknown }[] = [];
	return {
		pi: {
			on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			appendEntry: (type: string, data?: unknown) => entries.push({ type, data }),
		} as unknown as GatesAPI,
		entries,
		async emit(name: string, event: Event, context: TestContext): Promise<Result> {
			let last: Result;
			for (const handler of handlers.get(name) ?? []) {
				const result = await handler(event, context);
				if (result !== undefined) last = result;
				if (result?.block || result?.decision === "block" || result?.handled) return result;
			}
			return last;
		},
	};
}
function ctx(cwd = tmp("handoff-cwd")) {
	const notices: string[] = [];
	return {
		notices,
		value: {
			hasUI: true,
			cwd,
			sessionManager: { getHeader: () => ({}), getEntries: () => [] },
			ui: { notify: (message: string) => notices.push(message) },
		},
	};
}

describe("typed either-or fallback through gate extensions", () => {
	test("immediate fallback context, no approval row, retry stays deduped", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "orch", brief: "purge ctx", stakes: "normal", mode: "autonomous" });
		ledger.addSlice({ by: "orch", workloadId: wl, task: "purge ctx", doneCondition: "ctx removed or command handed off", inputs: "/Users/gheath/.ctx" });
		ledger.claimWorkload(wl, { holder: "lane-a", leaseMs: 60_000, by: "lane-a" });
		const h = host();
		const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a" };
		turnShapeRow(h.pi, env);
		reservedRow(h.pi, env);
		const c = ctx();
		await h.emit("input", { text: "Purge /Users/gheath/.ctx.", source: "interactive" }, c.value);
		await h.emit("input", { text: "Please fucking do it for me or give me the command to do it myself.", source: "interactive" }, c.value);
		const call = { toolName: "bash", input: { command: "rm -rf /Users/gheath/.ctx" } };
		const first = await h.emit("tool_call", { ...call, toolCallId: "c1" }, c.value);
		expect(first.block).toBe(true);
		expect(first.reason).toContain("Do not ask again");
		expect(first.reason).toContain("Execution status: not completed");
		expect(first.reason).toContain("Impact: Permanently deletes /Users/gheath/.ctx");
		expect(first.reason).toContain("Reversal: No direct undo");
		expect(ledger.entries(wl, "reserved-request")).toHaveLength(0);
		expect(ledger.entries(wl, "assumption").map((entry) => entry.body)).toContain("reserved-fallback: rm -rf (recursive force-delete): rm -rf /Users/gheath/.ctx status not completed");
		const prefixSubstitution = await h.emit("tool_call", { toolName: "bash", toolCallId: "c-prefix", input: { command: "rm -rf /Users/gheath/.ctx-old" } }, c.value);
		expect(prefixSubstitution.reason).not.toContain("Execution status: not completed");
		const multiTarget = await h.emit("tool_call", { toolName: "bash", toolCallId: "c-multi", input: { command: "rm -rf /Users/gheath/other /Users/gheath/.ctx" } }, c.value);
		expect(multiTarget.reason).not.toContain("Execution status: not completed");
		expect(ledger.entries(wl, "reserved-request")).toHaveLength(2);
		const substituted = await h.emit("tool_call", { toolName: "bash", toolCallId: "c-substitute", input: { command: "rm -rf /Users/gheath/other" } }, c.value);
		expect(substituted.reason).not.toContain("Execution status: not completed");

		const rendered = await h.emit("assistant_message", { type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "Use a safer command instead." }] } }, c.value) as { content?: { type: string; text?: string }[] } | undefined;
		expect(rendered?.content?.[0]?.text).toContain("Execution status: not completed");
		expect(rendered?.content?.[0]?.text).toContain("rm -rf /Users/gheath/.ctx");
		expect(rendered?.content?.[0]?.text).not.toContain("Use a safer command instead");
		expect(rendered?.content?.[0]?.text).toContain("rm -rf /Users/gheath/.ctx");
		expect(rendered?.content?.[0]?.text).not.toContain("rm -rf /Users/gheath/other");

		for (const source of ["extension", "rpc"] as const) {
			await h.emit("input", { text: "Execute it or give me the command.", source }, c.value);
			const blocked = await h.emit("tool_call", { ...call, toolCallId: `c-${source}` }, c.value);
			expect(blocked.reason).not.toContain("Execution status: not completed");
		}

		await h.emit("input", { text: "Delete /Users/gheath/.ctx or give me the command.", source: "interactive" }, c.value);
		await h.emit("tool_call", { toolName: "bash", toolCallId: "c-fence", input: { command: "rm -rf /Users/gheath/.ctx # ```not a fence```" } }, c.value);
		const fenced = await h.emit("assistant_message", { type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } }, c.value) as { content?: { text?: string }[] } | undefined;
		expect(fenced?.content?.[0]?.text).toContain("````bash");
		expect(fenced?.content?.[0]?.text).toContain("rm -rf /Users/gheath/.ctx # ```not a fence```");
		const requests = ledger.entries(wl, "reserved-request");
		expect(requests.filter((entry) => entry.body.includes("rm -rf /Users/gheath/.ctx (P-11"))).toHaveLength(1);
	});

	test("descriptive delete text cannot seed fallback authority", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "orch", brief: "cleanup", stakes: "normal", mode: "autonomous" });
		ledger.addSlice({ by: "orch", workloadId: wl, task: "cleanup", doneCondition: "done", inputs: "/Users/gheath/cache" });
		ledger.claimWorkload(wl, { holder: "lane-a", leaseMs: 60_000, by: "lane-a" });
		const h = host();
		const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a" };
		turnShapeRow(h.pi, env);
		reservedRow(h.pi, env);
		const c = ctx();
		await h.emit("input", { text: "The cleanup job may delete /Users/gheath/cache.", source: "interactive" }, c.value);
		await h.emit("input", { text: "Execute it or give me the command.", source: "interactive" }, c.value);
		const result = await h.emit("tool_call", { toolName: "bash", toolCallId: "c-description", input: { command: "rm -rf /Users/gheath/cache" } }, c.value);
		expect(result.reason).not.toContain("Execution status: not completed");
		expect(ledger.entries(wl, "reserved-request")).toHaveLength(1);
	});

	test("an unrelated input expires a pending delete request", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "orch", brief: "cleanup", stakes: "normal", mode: "autonomous" });
		ledger.addSlice({ by: "orch", workloadId: wl, task: "cleanup", doneCondition: "done", inputs: "/Users/gheath/cache" });
		ledger.claimWorkload(wl, { holder: "lane-a", leaseMs: 60_000, by: "lane-a" });
		const h = host();
		const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a" };
		turnShapeRow(h.pi, env);
		reservedRow(h.pi, env);
		const c = ctx();
		await h.emit("input", { text: "Delete /Users/gheath/cache.", source: "interactive" }, c.value);
		await h.emit("input", { text: "Tell me the weather.", source: "interactive" }, c.value);
		await h.emit("input", { text: "Execute it or give me the command.", source: "interactive" }, c.value);
		const result = await h.emit("tool_call", { toolName: "bash", toolCallId: "c-expired", input: { command: "rm -rf /Users/gheath/cache" } }, c.value);
		expect(result.reason).not.toContain("Execution status: not completed");
	});
	test("lane final messages receive presentation warnings", async () => {
		const h = host();
		turnShapeRow(h.pi, { HOME: "/nonexistent-home" });
		const c = ctx();
		const result = await h.emit("session_stop", { last_assistant_message: { role: "assistant", content: [{ type: "text", text: "**ACTION**\n```bash\nrm -rf /tmp/x\n```" }] } }, c.value);
		expect(result).toBeUndefined();
		expect(c.notices.at(-1)).toContain("command presentation is missing");
	});
});
