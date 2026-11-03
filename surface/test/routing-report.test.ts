// The routing report's counting rules (PLAN wl-mv71x5rwdu7eo0 rev 4 § 2.1) on a fixture ledger built through the ledger
// module in a temp dir, with hand session files written beside it; never the live ledger. Also the two cross-workload
// readers the report reads through (Ledger.routingsIn, Ledger.entriesWithPrefix).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger, RoutingKind, RoutingOutcome, Tier } from "../../ledger/src/index";
import { scanSpend } from "../src/ceiling";
import { HEADROOM_SKIP_PREFIX, readHandUsage, renderRoutingReport, type RoutingReport, routingReport } from "../src/routing-report";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

const JEV = "typesafe/jev-1.13.0";

/** One assistant message line as OMP writes it, with its cost and tokens. */
const assistant = (usd: number, tokens: number) =>
	JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: { totalTokens: tokens, cost: { total: usd } } } });
const user = JSON.stringify({ type: "message", message: { role: "user", content: "go" } });

interface RowSpec {
	at: string;
	kind: RoutingKind;
	tier: Tier;
	outcome?: RoutingOutcome;
	agentId?: string | null;
	sessionRoot?: string;
	models?: string[];
	ranModels?: string[] | null;
	pullUpTo?: "standard" | "strong" | "deep" | null;
	pullDownTo?: "fast" | "standard" | "strong" | null;
	probabilities?: Record<string, number>;
	judgeModel?: string;
	workloadId?: string;
	sliceId?: string;
}

interface Fixture {
	ledger: Ledger;
	path: string;
	at: (iso: string) => void;
	wl: string;
	sl: string;
	root: string;
	add: (s: RowSpec) => string;
}

let agentSeq = 0;

function fixture(): Fixture {
	const c = clock("2026-10-10T00:00:00.000Z");
	const { ledger, path } = tempLedger(c.now);
	const { wl, sl } = workloadWithSlice(ledger);
	const root = join(tmp("routing-report"), "sessions", "lane-session");
	mkdirSync(root, { recursive: true });
	const add = (s: RowSpec): string => {
		c.at(s.at);
		const outcome = s.outcome ?? "ran";
		const models = s.models ?? (outcome === "refused-no-usable-model" ? [] : ["anthropic/claude-opus-5-5"]);
		return ledger.recordRouting({
			by: "lane-a", workloadId: s.workloadId ?? wl, sliceId: s.sliceId ?? sl, sessionRoot: s.sessionRoot ?? root,
			agentId: s.agentId === undefined ? (outcome === "refused-no-usable-model" ? null : `hand-${++agentSeq}`) : s.agentId,
			kind: s.kind, confidence: 0.9, probabilities: s.probabilities ?? { [s.kind]: 0.9 }, classifiedTier: s.tier,
			pullUpTo: s.pullUpTo ?? null, pullDownTo: s.pullDownTo ?? null, tier: s.tier, models,
			judgeModel: s.judgeModel ?? JEV, outcome,
			ranModels: s.ranModels === undefined ? (outcome === "ran" || outcome === "refused-out-of-row" ? [models[0]!] : null) : s.ranModels,
		});
	};
	return { ledger, path, at: c.at, wl, sl, root, add };
}

const report = (f: Fixture, opts: { split?: string; since?: string; until?: string } = {}): RoutingReport => {
	const range = { since: opts.since, until: opts.until };
	return routingReport(f.ledger.routingsIn(range), { usage: readHandUsage, entries: f.ledger.entriesWithPrefix(HEADROOM_SKIP_PREFIX, range), split: opts.split ?? null, range });
};

describe("routing report: counting rules", () => {
	test("rows, jev, code rows, outcomes, models, pull-ups, pull-downs and headroom skips per kind × tier", () => {
		const f = fixture();
		f.add({ at: "2026-10-10T01:00:00.000Z", kind: "change-large", tier: "strong" });
		f.add({ at: "2026-10-10T01:01:00.000Z", kind: "change-large", tier: "strong", models: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"], ranModels: ["openai-codex/gpt-6.1-sol"] });
		f.add({ at: "2026-10-10T01:02:00.000Z", kind: "change-large", tier: "strong", outcome: "refused-model-unknown", models: ["moonshot/kimi-k3"], ranModels: null });
		f.add({ at: "2026-10-10T01:03:00.000Z", kind: "change-small", tier: "standard", models: ["anthropic/claude-sonnet-5-5"], judgeModel: "other/judge-1" });
		f.add({ at: "2026-10-10T01:04:00.000Z", kind: "understand", tier: "strong", pullUpTo: "strong" });
		f.add({ at: "2026-10-10T01:05:00.000Z", kind: "judge", tier: "strong", pullDownTo: "strong", models: ["openai-codex/gpt-6-sol"] });
		f.add({ at: "2026-10-10T01:06:00.000Z", kind: "judge", tier: "strong", outcome: "refused-no-usable-model", pullDownTo: "strong" });
		f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "headroom-skip: openai-codex/gpt-6.1-sol token dt-1 openai-codex 7d 0.9 used" });
		f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "headroom-skip: openai-codex/gpt-6.1-sol token dt-2 openai-codex 7d 0.9 used" });
		f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "headroom-skip: anthropic/claude-opus-5-5 token dt-3 anthropic 5h 0.93 used > 0.80" });
		const odd = f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "headroom-skip: garbled" });
		f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "hand-spawn: dt-1 not a skip" });

		const r = report(f);
		const all = r.all;
		expect(all.rows).toBe(7);
		expect(all.jev).toBe(6);
		expect([all.changeLarge, all.changeSmall, all.codeRows]).toEqual([3, 1, 4]);
		expect(all.changeSmallShare).toBe(0.25);
		expect(all.outcomes).toEqual({ ran: 5, "refused-model-unknown": 1, "refused-no-usable-model": 1 });
		expect(all.judgeModels).toEqual({ [JEV]: 6, "other/judge-1": 1 });
		expect(all.noHand).toBe(1);
		expect(all.cells.map((c) => `${c.kind}/${c.tier}`)).toEqual(["understand/strong", "change-small/standard", "change-large/strong", "judge/strong"]);
		const large = all.cells.find((c) => c.kind === "change-large")!;
		// ran_models[0], else model: the second row ran on its second candidate; the refused row names its model.
		expect(large.models).toEqual({ "anthropic/claude-opus-5-5": 1, "openai-codex/gpt-6.1-sol": 1, "moonshot/kimi-k3": 1 });
		expect(large.outcomes).toEqual({ ran: 2, "refused-model-unknown": 1 });
		expect(all.cells.find((c) => c.kind === "understand")!.pullUps).toEqual({ strong: 1 });
		const judge = all.cells.find((c) => c.kind === "judge")!;
		expect(judge.pullDowns).toEqual({ strong: 2 });
		expect(judge.models).toEqual({ "openai-codex/gpt-6-sol": 1, "(none)": 1 });
		expect(all.headroomSkips).toEqual({ "openai-codex/gpt-6.1-sol": 2, "anthropic/claude-opus-5-5": 1 });
		expect(all.headroomUnparsed).toEqual([odd]);

		const text = renderRoutingReport(r);
		expect(text.split("\n")[0]).toBe("7 rows · jev 6 · change-large 3 of 4 code rows");
		expect(text).toContain("headroom-skip entries: 4");
		expect(text).toContain(`no selector in 1: ${odd}`);
	});

	test("the window: --since inclusive, --until exclusive, one workload", () => {
		const f = fixture();
		f.add({ at: "2026-10-10T01:00:00.000Z", kind: "change-large", tier: "strong" });
		f.add({ at: "2026-10-10T02:00:00.000Z", kind: "change-small", tier: "standard" });
		f.add({ at: "2026-10-10T03:00:00.000Z", kind: "judge", tier: "deep" });
		const other = f.ledger.openWorkload({ by: "lane-b", brief: "another workload", stakes: "normal", mode: "autonomous" });
		const otherSlice = f.ledger.addSlice({ by: "lane-b", workloadId: other, task: "t", doneCondition: "d", inputs: "i" });
		f.add({ at: "2026-10-10T02:30:00.000Z", kind: "judge", tier: "strong", workloadId: other, sliceId: otherSlice });

		expect(f.ledger.routingsIn({ since: "2026-10-10T02:00:00.000Z", until: "2026-10-10T03:00:00.000Z" }).map((r) => r.kind)).toEqual(["change-small", "judge"]);
		expect(f.ledger.routingsIn({ workloadId: other }).map((r) => r.workload_id)).toEqual([other]);
		expect(f.ledger.routingsIn().length).toBe(4);
		const r = report(f, { until: "2026-10-10T02:00:00.000Z" });
		expect(renderRoutingReport(r).split("\n")[0]).toBe("1 rows · jev 1 · change-large 1 of 1 code rows");
	});

	test("entriesWithPrefix compares the prefix exactly: LIKE pattern characters are literal", () => {
		const f = fixture();
		f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "a_b% one" });
		f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "axbz two" });
		expect(f.ledger.entriesWithPrefix("a_b%").map((e) => e.body)).toEqual(["a_b% one"]);
		expect(() => f.ledger.entriesWithPrefix("")).toThrow("empty prefix");
	});
});

describe("routing report: review vs build", () => {
	test("judge kind is review; a pull-up with judge in the top two is review; any other row builds", () => {
		const f = fixture();
		f.add({ at: "2026-10-10T01:00:00.000Z", kind: "judge", tier: "strong" });
		f.add({ at: "2026-10-10T01:01:00.000Z", kind: "change-large", tier: "deep", pullUpTo: "deep", probabilities: { "change-large": 0.5, judge: 0.4, understand: 0.1 } });
		f.add({ at: "2026-10-10T01:02:00.000Z", kind: "change-large", tier: "deep", pullUpTo: "deep", probabilities: { "change-large": 0.5, understand: 0.4, judge: 0.1 } });
		f.add({ at: "2026-10-10T01:03:00.000Z", kind: "change-large", tier: "strong", probabilities: { "change-large": 0.5, judge: 0.45 } });
		const all = report(f).all;
		expect([all.review, all.build]).toEqual([2, 2]);
		const deep = all.cells.find((c) => c.kind === "change-large" && c.tier === "deep")!;
		expect([deep.review, deep.build]).toEqual([1, 1]);
		expect(all.cells.find((c) => c.kind === "change-large" && c.tier === "strong")!.build).toBe(1);
	});
});

describe("routing report: cost per hand", () => {
	test("a missing session file is n/a and counted in the header, never a zero; an unreadable file and a torn line are reported", () => {
		const f = fixture();
		writeFileSync(join(f.root, "read.jsonl"), [user, assistant(0.25, 1000), assistant(0.5, 2000), ""].join("\n"));
		f.add({ at: "2026-10-10T01:00:00.000Z", kind: "change-large", tier: "strong", agentId: "read" });
		f.add({ at: "2026-10-10T01:01:00.000Z", kind: "change-large", tier: "strong", agentId: "gone" });
		mkdirSync(join(f.root, "dir.jsonl"));
		f.add({ at: "2026-10-10T01:02:00.000Z", kind: "judge", tier: "strong", agentId: "dir" });
		writeFileSync(join(f.root, "torn.jsonl"), [assistant(1, 10), '{"type":"message","message":{"role":"assistant","usage":'].join("\n"));
		f.add({ at: "2026-10-10T01:03:00.000Z", kind: "judge", tier: "strong", agentId: "torn" });

		const r = report(f);
		expect(r.all.cost).toEqual({ hands: 4, read: 2, missing: 1, unreadable: 1, usd: 1.75, tokens: 3010, malformedLines: 1 });
		const large = r.all.cells.find((c) => c.kind === "change-large")!;
		expect(large.cost).toMatchObject({ hands: 2, read: 1, missing: 1, usd: 0.75, tokens: 3000 });
		const gone = r.hands.find((h) => h.file.endsWith("gone.jsonl"))!;
		expect(gone).toMatchObject({ state: "missing", usd: null, tokens: null });
		const dir = r.hands.find((h) => h.file.endsWith("dir.jsonl"))!;
		expect(dir.state).toBe("unreadable");
		expect(dir.error).toContain("EISDIR");

		const lines = renderRoutingReport(r).split("\n");
		expect(lines[0]).toBe("4 rows · jev 4 · change-large 2 of 2 code rows");
		expect(lines[1]).toBe("hands 4 · cost read 2 · n/a 2 (session file missing 1, unreadable 1) · no hand 0 · unparsed assistant lines 1");
		expect(lines).toContain(`  n/a ${gone.routingId} ${f.wl} change-large/strong session file missing: ${join(f.root, "gone.jsonl")}`);
		expect(lines.some((l) => l.startsWith(`  n/a ${dir.routingId} `) && l.includes("unreadable (") && l.includes("EISDIR"))).toBe(true);
		expect(lines).toContain(`  ${r.hands.find((h) => h.file.endsWith("torn.jsonl"))!.routingId} ${f.wl} 1 line(s): ${join(f.root, "torn.jsonl")}`);
	});

	test("a cell with no readable hand prints n/a for its dollars, not 0", () => {
		const f = fixture();
		f.add({ at: "2026-10-10T01:00:00.000Z", kind: "change-small", tier: "standard", agentId: "gone" });
		const text = renderRoutingReport(report(f));
		expect(text).toContain("  cost       usd n/a · tokens n/a · read 0 of 1 hands · per hand n/a · n/a 1");
		expect(text).not.toContain("usd 0.0000");
	});

	test("two hands under one session root are attributed separately, and the ceiling meter's total over the root is their sum", () => {
		const f = fixture();
		writeFileSync(join(f.root, "sl-a.jsonl"), [user, assistant(0.1, 100), assistant(0.2, 200), ""].join("\n"));
		writeFileSync(join(f.root, "sl-b.jsonl"), [user, assistant(3, 5000), ""].join("\n"));
		f.add({ at: "2026-10-10T01:00:00.000Z", kind: "change-large", tier: "strong", agentId: "sl-a" });
		f.add({ at: "2026-10-10T01:01:00.000Z", kind: "judge", tier: "deep", agentId: "sl-b" });
		const r = report(f);
		const a = r.hands.find((h) => h.file === join(f.root, "sl-a.jsonl"))!;
		const b = r.hands.find((h) => h.file === join(f.root, "sl-b.jsonl"))!;
		expect(a.usd).toBeCloseTo(0.3, 10);
		expect(a.tokens).toBe(300);
		expect(b.usd).toBe(3);
		expect(b.tokens).toBe(5000);
		expect(r.all.cells.find((c) => c.kind === "change-large")!.cost.usd).toBeCloseTo(0.3, 10);
		expect(r.all.cells.find((c) => c.kind === "judge")!.cost.usd).toBe(3);
		const meter = scanSpend(join(f.root, ".."), new Map(), { usd: 0, tokens: 0, wallMin: 0 });
		expect(meter.usd).toBeCloseTo(a.usd! + b.usd!, 10);
		expect(meter.tokens).toBe(a.tokens! + b.tokens!);
	});
});

describe("routing report: --split", () => {
	test("two cohorts, each with its code rows and change-small share", () => {
		const f = fixture();
		f.add({ at: "2026-10-10T01:00:00.000Z", kind: "change-large", tier: "strong" });
		f.add({ at: "2026-10-10T01:01:00.000Z", kind: "change-large", tier: "strong" });
		f.add({ at: "2026-10-10T01:02:00.000Z", kind: "change-small", tier: "standard" });
		f.add({ at: "2026-10-10T01:03:00.000Z", kind: "judge", tier: "strong" });
		f.add({ at: "2026-10-20T04:00:00.000Z", kind: "change-small", tier: "standard" });
		f.add({ at: "2026-10-20T04:01:00.000Z", kind: "change-large", tier: "strong" });
		f.ledger.recordEntry({ by: "lane-a", workloadId: f.wl, kind: "assumption", body: "headroom-skip: openai-codex/gpt-6.1-sol token dt-1 why" });
		const split = "2026-10-20T03:30:00.000Z";
		const r = report(f, { split });
		const { before, after } = r.split!;
		expect([before.rows, before.codeRows, before.changeSmall, before.changeSmallShare]).toEqual([4, 3, 1, 1 / 3]);
		expect([after.rows, after.codeRows, after.changeSmall, after.changeSmallShare]).toEqual([2, 2, 1, 0.5]);
		// The entry was written at the clock's last value (after the split).
		expect([Object.keys(before.headroomSkips).length, after.headroomSkips]).toEqual([0, { "openai-codex/gpt-6.1-sol": 1 }]);
		const lines = renderRoutingReport(r).split("\n");
		expect(lines[0]).toBe("6 rows · jev 6 · change-large 3 of 5 code rows");
		const b = lines.indexOf(`== before ${split} ==`);
		const a = lines.indexOf(`== after ${split} ==`);
		expect(b).toBeGreaterThan(0);
		expect(a).toBeGreaterThan(b);
		expect(lines[b + 1]).toBe("4 rows · jev 4 · change-large 2 of 3 code rows");
		expect(lines[b + 3]).toStartWith("change-small 1 of 3 code rows (33.3 %)");
		expect(lines[a + 1]).toBe("2 rows · jev 2 · change-large 1 of 2 code rows");
		expect(lines[a + 3]).toStartWith("change-small 1 of 2 code rows (50.0 %)");
	});
});
