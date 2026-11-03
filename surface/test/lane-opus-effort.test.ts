// Opus at medium for lanes (PLAN-p2 rev 4 § 2.3, Jo's in-mv8gcb2bbue4g0): the lane row's real `before_agent_start`
// handler (surface/extensions/lane.ts) on a fake pi and ctx. At each prompt it reads ctx.model; the first prompt of each
// entry to anthropic/claude-opus-5-5 calls pi.setThinkingLevel("medium") and writes one `thinking-level:` entry; a level
// set while the lane stays on that entry is kept; other models are untouched; a missing or throwing setter writes one
// `thinking-level-failed:` entry and the lane goes on. Events are driven directly: no timers, no clock.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import laneRow, { OPUS_MEDIUM_MODEL, thinkingLevelSetBody } from "../extensions/lane";
import { ctxOf, fakePi, tmp } from "./helpers";

type Model = { provider: string; id: string };
const OPUS: Model = { provider: "anthropic", id: "claude-opus-5-5" };
const SOL: Model = { provider: "openai-codex", id: "gpt-6.1-sol" };
const SONNET: Model = { provider: "anthropic", id: "claude-sonnet-5-5" };

/** A bound lane on a fresh ledger, its row registered on a fake pi whose thinking level starts at `level`. */
function lane(o: { model: Model | undefined; level?: string; setter?: "ok" | "throws" | "absent"; role?: string }) {
	const path = join(tmp("opus-effort"), "ledger.db");
	const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false });
	const wl = ledger.openWorkload({ by: "orch", brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
	const env = { AGENT_SYSTEM_ROLE: o.role ?? "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a", HOME: "/nonexistent-home" };
	const f = fakePi();
	const state = { level: o.level ?? "high", calls: [] as string[] };
	const setter = o.setter ?? "ok";
	if (setter !== "absent") {
		Object.assign(f.pi, {
			setThinkingLevel: (level: string) => {
				state.calls.push(level);
				if (setter === "throws") throw new Error("thinking level refused by host");
				state.level = level;
			},
		});
	}
	laneRow(f.pi, env);
	const ctx = Object.assign(ctxOf(), { model: o.model });
	const prompt = () => f.emit("before_agent_start", { prompt: "carry on", systemPrompt: [] }, ctx);
	const effortEntries = () => ledger.entries(wl).filter((e) => e.body.startsWith("thinking-level")).map((e) => ({ body: e.body, by: e.created_by }));
	return { ctx, state, prompt, effortEntries };
}

describe("lane Opus effort: medium once per entry to anthropic/claude-opus-5-5", () => {
	test("a lane at high on another model, moved to Opus, gets medium before its next prompt, recorded once", async () => {
		const l = lane({ model: SOL, level: "high" });
		await l.prompt();
		expect(l.state.calls).toEqual([]);
		l.ctx.model = OPUS;
		await l.prompt();
		expect(l.state.calls).toEqual(["medium"]);
		expect(l.state.level).toBe("medium");
		expect(l.effortEntries()).toEqual([{ body: thinkingLevelSetBody(OPUS_MEDIUM_MODEL), by: "lane-a" }]);
	});

	test("Opus → another model → Opus re-arms: the return gets medium again", async () => {
		const l = lane({ model: OPUS });
		await l.prompt();
		expect(l.state.calls).toEqual(["medium"]);
		l.state.level = "high"; // Jo raises it, then moves the lane off Opus
		l.ctx.model = SONNET;
		await l.prompt();
		expect(l.state.calls).toEqual(["medium"]);
		expect(l.state.level).toBe("high");
		l.ctx.model = OPUS;
		await l.prompt();
		expect(l.state.calls).toEqual(["medium", "medium"]);
		expect(l.state.level).toBe("medium");
		expect(l.effortEntries()).toHaveLength(2);
	});

	test("a level set while the lane stays on the same Opus entry is kept on the next prompt", async () => {
		const l = lane({ model: OPUS });
		await l.prompt();
		l.state.level = "xhigh"; // Jo's own choice on this entry
		await l.prompt();
		await l.prompt();
		expect(l.state.calls).toEqual(["medium"]);
		expect(l.state.level).toBe("xhigh");
		expect(l.effortEntries()).toHaveLength(1);
	});

	test("a lane starting on Opus gets medium once, at its first prompt", async () => {
		const l = lane({ model: OPUS, level: "high" });
		await l.prompt();
		await l.prompt();
		await l.prompt();
		expect(l.state.calls).toEqual(["medium"]);
		expect(l.effortEntries()).toHaveLength(1);
	});

	test("control: a gpt-6.1-sol lane is untouched, and so is a lane with no model reported", async () => {
		const sol = lane({ model: SOL, level: "high" });
		await sol.prompt();
		await sol.prompt();
		expect(sol.state.calls).toEqual([]);
		expect(sol.state.level).toBe("high");
		expect(sol.effortEntries()).toEqual([]);
		const none = lane({ model: undefined });
		await none.prompt();
		expect(none.state.calls).toEqual([]);
		expect(none.effortEntries()).toEqual([]);
	});

	test("control: the orchestrator on Opus is not a lane and is untouched", async () => {
		const orch = lane({ model: OPUS, role: "orchestrator" });
		await orch.prompt();
		expect(orch.state.calls).toEqual([]);
		expect(orch.effortEntries()).toEqual([]);
	});

	test("a throwing setThinkingLevel writes one failure entry naming the error, the prompt goes on, the level is unchanged", async () => {
		const l = lane({ model: OPUS, level: "high", setter: "throws" });
		await l.prompt();
		await l.prompt();
		expect(l.state.calls).toEqual(["medium"]);
		expect(l.state.level).toBe("high");
		const entries = l.effortEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.body).toStartWith(`thinking-level-failed: ${OPUS_MEDIUM_MODEL} entered; pi.setThinkingLevel("medium") failed: Error: thinking level refused by host;`);
		expect(entries[0]!.body).toContain("the level is left as it was");
	});

	test("a host with no setThinkingLevel writes the failure entry naming its absence", async () => {
		const l = lane({ model: OPUS, setter: "absent" });
		await l.prompt();
		const entries = l.effortEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.body).toContain("the host's extension API has no setThinkingLevel");
	});
});
