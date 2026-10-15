// The workload ceiling's pure half (DESIGN-workload-ceiling.md § 2, § 4) over plain rows and temp
// session files: sizing, the effective ceiling with the raise-needs-Jo rule, the incremental spend
// scan, wall time from the lane lifecycle entries, and the 80 / 100 thresholds.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, type EntryRow, type InstructionRow } from "../../ledger/src/index";
import { ceilingBody, ceilingQuestionBody, crossed, effectiveCeiling, parseCeiling, parseSpend, scanSpend, sizeFor, spendBody, wallMinutes } from "../src/ceiling";
import { controlEntries } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { tmp } from "./helpers";

let seq = 0;
const at = (minute: number) => `2026-10-01T09:${String(minute).padStart(2, "0")}:00.000Z`;
const entry = (by: string, body: string, minute = ++seq): EntryRow => ({
	id: `e-${minute}`, workload_id: "wl-m", slice_id: null, kind: "assumption", body, created_by: by, created_at: at(minute),
} as EntryRow);
const instruction = (id: string, author: string, minute: number, by = SURFACE_BY, shape: Pick<InstructionRow, "kind" | "body"> = { kind: "instruction", body: "ceiling: 80 6" }): InstructionRow => ({
	id, workload_id: "wl-m", slice_id: null, question_id: null, disposition: null, channel: "surface", author, created_by: by, created_at: at(minute), ...shape,
} as InstructionRow);
const ceilingAt = (minute: number, usd: number, wallMin: number, by?: string, writer = SURFACE_BY) => entry(writer, ceilingBody({ usd, wallMin }, "stakes normal", by), minute);

describe("sizing (§ 1 B, C)", () => {
	test("each stakes has its size; only a change-large judgment triples it", () => {
		expect(sizeFor("throwaway", null)).toEqual({ usd: 5, wallMin: 60 });
		expect(sizeFor("normal", null)).toEqual({ usd: 50, wallMin: 360 });
		expect(sizeFor("production", null)).toEqual({ usd: 150, wallMin: 720 });
		expect(sizeFor("throwaway", "change-large")).toEqual({ usd: 15, wallMin: 180 });
		expect(sizeFor("normal", "change-large")).toEqual({ usd: 150, wallMin: 1080 });
		expect(sizeFor("production", "change-large")).toEqual({ usd: 450, wallMin: 2160 });
		expect(sizeFor("normal", "change-small")).toEqual({ usd: 50, wallMin: 360 });
		expect(sizeFor("normal", "judge")).toEqual({ usd: 50, wallMin: 360 });
	});
});

describe("bodies round-trip through controlEntries", () => {
	test("ceiling: keeps a source that says `by` in words; only an in- id is the instruction", () => {
		const [c] = controlEntries([entry(SURFACE_BY, ceilingBody({ usd: 0.15, wallMin: 10 }, "lowered by  the\norchestrator", "in-abc"))]);
		expect(parseCeiling(c!.rest)).toEqual({ usd: 0.15, wallMin: 10, source: "lowered by the orchestrator", by: "in-abc" });
		const [d] = controlEntries([entry(SURFACE_BY, ceilingBody({ usd: 50, wallMin: 360 }, "stakes normal by jo"))]);
		expect(parseCeiling(d!.rest)).toEqual({ usd: 50, wallMin: 360, source: "stakes normal by jo", by: null });
		expect(parseCeiling("usd 0 wall 60 source x")).toBeNull();
		expect(parseCeiling("usd 5 wall 60")).toBeNull();
	});
	test("spend: is lane-scoped, runner-only, and rounds dollars to 4 places", () => {
		const body = spendBody("lane-m-2", { usd: 0.294023999, tokens: 36277, wallMin: 12.345 });
		expect(body).toBe("spend: lane-m-2 usd 0.294 tokens 36277 wall 12.3");
		const [c] = controlEntries([entry(LANE_RUNNER_BY, body)]);
		expect([c!.prefix, c!.laneId]).toEqual(["spend", "lane-m-2"]);
		expect(parseSpend(c!.rest)).toEqual({ usd: 0.294, tokens: 36277, wallMin: 12.3 });
		expect(controlEntries([entry("lane-m-2", body), entry(SURFACE_BY, body)])).toEqual([]);
	});
});

describe("effective ceiling (§ 2 item 1: a raise needs Jo)", () => {
	const eff = (rows: EntryRow[], ins: InstructionRow[] = []) => effectiveCeiling(controlEntries(rows), ins, "normal");
	test("no entry: the stakes size ×1", () => {
		expect(effectiveCeiling([], [], "throwaway")).toEqual({ usd: 5, wallMin: 60 });
	});
	test("the first entry sets it, whatever its size", () => {
		expect(eff([ceilingAt(1, 150, 1080)])).toEqual({ usd: 150, wallMin: 1080 });
	});
	test("a lower entry applies without an instruction, one half at a time", () => {
		expect(eff([ceilingAt(1, 50, 360), ceilingAt(2, 0.15, 360)])).toEqual({ usd: 0.15, wallMin: 360 });
		expect(eff([ceilingAt(1, 50, 360), ceilingAt(2, 50, 10)])).toEqual({ usd: 50, wallMin: 10 });
	});
	test("a raise with no instruction is ignored, and so is one that lowers one half and raises the other", () => {
		expect(eff([ceilingAt(1, 50, 360), ceilingAt(2, 100, 360)])).toEqual({ usd: 50, wallMin: 360 });
		expect(eff([ceilingAt(1, 50, 360), ceilingAt(2, 10, 720)])).toEqual({ usd: 50, wallMin: 360 });
	});
	test("a raise naming a Jo instruction older than the entry in force is ignored", () => {
		expect(eff([ceilingAt(5, 50, 360), ceilingAt(6, 100, 720, "in-old")], [instruction("in-old", "jo", 4)])).toEqual({ usd: 50, wallMin: 360 });
	});
	test("a raise naming a Jo instruction at or after the entry in force applies", () => {
		expect(eff([ceilingAt(5, 50, 360), ceilingAt(7, 100, 720, "in-new")], [instruction("in-new", "jo", 6)])).toEqual({ usd: 100, wallMin: 720 });
		expect(eff([ceilingAt(5, 50, 360), ceilingAt(7, 100, 720, "in-same")], [instruction("in-same", "jo", 5)])).toEqual({ usd: 100, wallMin: 720 });
	});
	test("one Jo instruction licenses one raise: after a lowering it is older than the entry in force", () => {
		const ins = [instruction("in-1", "jo", 6)];
		expect(eff([ceilingAt(5, 50, 360), ceilingAt(7, 100, 720, "in-1"), ceilingAt(8, 20, 720), ceilingAt(9, 100, 720, "in-1")], ins)).toEqual({ usd: 20, wallMin: 720 });
	});
	test("a raise naming a non-Jo instruction is ignored", () => {
		expect(eff([ceilingAt(5, 50, 360), ceilingAt(7, 100, 720, "in-orch")], [instruction("in-orch", "orchestrator", 6)])).toEqual({ usd: 50, wallMin: 360 });
	});
	test("a raise naming a newer author-jo instruction that a lane wrote is ignored: only the surface records Jo's word", () => {
		expect(eff([ceilingAt(5, 50, 360), ceilingAt(7, 100, 720, "in-lane")], [instruction("in-lane", "jo", 6, "lane-m-1")])).toEqual({ usd: 50, wallMin: 360 });
	});
	test("a raise counts only when the named instruction is one of the surface's raise shapes: the ceiling word, the stakes word, the extend answer", () => {
		const raise = (shape: Pick<InstructionRow, "kind" | "body">) =>
			eff([ceilingAt(5, 50, 360), ceilingAt(7, 100, 720, "in-x")], [instruction("in-x", "jo", 6, SURFACE_BY, shape)]);
		expect(raise({ kind: "instruction", body: "ceiling: 100 12" })).toEqual({ usd: 100, wallMin: 720 });
		expect(raise({ kind: "instruction", body: "stakes: production" })).toEqual({ usd: 100, wallMin: 720 });
		expect(raise({ kind: "answer", body: "extend" })).toEqual({ usd: 100, wallMin: 720 });
		// an orchestrator_record_instruction row: surface-written and author jo, but its text is the model's
		expect(raise({ kind: "instruction", body: 'Jo: "raise it to 100" — reading: ceiling: usd 100' })).toEqual({ usd: 50, wallMin: 360 });
		// another answer word; `extend` as a plain instruction rather than an answer; a withdrawal
		expect(raise({ kind: "answer", body: "stop" })).toEqual({ usd: 50, wallMin: 360 });
		expect(raise({ kind: "instruction", body: "extend" })).toEqual({ usd: 50, wallMin: 360 });
		expect(raise({ kind: "withdrawal", body: "withdrawn from the surface" })).toEqual({ usd: 50, wallMin: 360 });
	});
	test("a ceiling: written by a lane is dropped by controlEntries, as a first entry and as a lowering", () => {
		expect(controlEntries([ceilingAt(1, 500, 720, undefined, "lane-m-1")])).toEqual([]);
		expect(eff([ceilingAt(1, 500, 720, undefined, "lane-m-1")])).toEqual({ usd: 50, wallMin: 360 });
		expect(eff([ceilingAt(1, 50, 360), ceilingAt(2, 1, 1, undefined, "lane-m-1")])).toEqual({ usd: 50, wallMin: 360 });
	});
});

describe("ceiling question links", () => {
	test("refuses to build an extend question without a link header at runtime", () => {
		expect(() => ceilingQuestionBody("wl-m", { usd: 40, tokens: 1000, wallMin: 0 }, { usd: 50, wallMin: 360 }, "normal",
			undefined as unknown as Parameters<typeof ceilingQuestionBody>[4])).toThrow(/offers extend.*none were given/);
	});
});

describe("spend scan (§ 2 items 3, 4)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});
	// The shape OMP writes: one `message` entry per assistant turn with `usage.totalTokens` and `usage.cost.total`.
	const assistant = (cost: unknown, tokens: unknown) => `${JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "assistant", content: [], usage: { input: 1, output: 1, totalTokens: tokens, cost: { total: cost } } } })}\n`;
	const other = `${JSON.stringify({ type: "message", message: { role: "toolResult", usage: { totalTokens: 999, cost: { total: 9 } } } })}\n`;
	const zero = { usd: 0, tokens: 0, wallMin: 7 };

	test("the lane's file and a hand's nested file both count; other entries and non-jsonl files do not", () => {
		const dir = tmp("ceiling-scan");
		roots.push(dir);
		writeFileSync(join(dir, "2026_lane.jsonl"), `{"type":"session","id":"s"}\n${assistant(0.25, 1000)}${other}`);
		mkdirSync(join(dir, "2026_lane", "nested"), { recursive: true });
		writeFileSync(join(dir, "2026_lane", "0-Hand.jsonl"), assistant(0.5, 2000));
		writeFileSync(join(dir, "2026_lane", "nested", "1-Deep.jsonl"), assistant(0.125, 500));
		writeFileSync(join(dir, "2026_lane", "notes.log"), assistant(100, 100));
		expect(scanSpend(dir, new Map(), zero)).toEqual({ usd: 0.875, tokens: 3500, wallMin: 7 });
	});
	test("missing or partial usage counts 0; a missing directory adds nothing", () => {
		const dir = tmp("ceiling-scan");
		roots.push(dir);
		writeFileSync(join(dir, "s.jsonl"), `${assistant(undefined, 10)}${assistant(0.5, "12")}${JSON.stringify({ type: "message", message: { role: "assistant" } })}\nnot json\n`);
		expect(scanSpend(dir, new Map(), zero)).toEqual({ usd: 0.5, tokens: 10, wallMin: 7 });
		expect(scanSpend(join(dir, "absent"), new Map(), { usd: 1, tokens: 2, wallMin: 3 })).toEqual({ usd: 1, tokens: 2, wallMin: 3 });
	});
	test("offsets advance: a rescan adds only what was appended, a partial trailing line waits for its newline", () => {
		const dir = tmp("ceiling-scan");
		roots.push(dir);
		const file = join(dir, "s.jsonl");
		writeFileSync(file, assistant(1, 100));
		const offsets = new Map<string, number>();
		let acc = scanSpend(dir, offsets, zero);
		expect(acc).toEqual({ usd: 1, tokens: 100, wallMin: 7 });
		expect(scanSpend(dir, offsets, acc)).toEqual(acc);
		const line = assistant(2, 200);
		appendFileSync(file, line.slice(0, 40));
		acc = scanSpend(dir, offsets, acc);
		expect(acc).toEqual({ usd: 1, tokens: 100, wallMin: 7 });
		appendFileSync(file, line.slice(40));
		mkdirSync(join(dir, "s"));
		writeFileSync(join(dir, "s", "hand.jsonl"), assistant(4, 400));
		acc = scanSpend(dir, offsets, acc);
		expect(acc).toEqual({ usd: 7, tokens: 700, wallMin: 7 });
		expect(scanSpend(dir, offsets, acc)).toEqual(acc);
	});
});

describe("wall time (§ 2 item 3)", () => {
	test("each lane's first start to its exit, plus the current run; a lane with no exit adds nothing", () => {
		const started = (lane: string, minute: number) => entry(LANE_RUNNER_BY, `lane-started: ${lane} ${JSON.stringify({ pid: 1, start: "x", session: null, argv: [], runnerPid: 2 })}`, minute);
		const exited = (lane: string, minute: number) => entry(LANE_RUNNER_BY, `lane-exit: ${lane} code 0 signal - outcome parked`, minute);
		const control = controlEntries([
			started("lane-m-1", 0), started("lane-m-1", 2), exited("lane-m-1", 10), // 10 min; the second start record is session metadata
			started("lane-m-2", 20), exited("lane-m-2", 25), // 5 min; the 10 min parked between is not counted
			started("lane-m-3", 30), // the current run, counted through currentStart
		]);
		const now = Date.parse(at(42));
		expect(wallMinutes(control, now, Date.parse(at(30)))).toBe(27);
		expect(wallMinutes(control, now, null)).toBe(15);
	});
});

describe("thresholds (§ 2 item 4)", () => {
	const c = { usd: 50, wallMin: 360 };
	test("exactly 80 % and exactly 100 % cross, whichever half is higher", () => {
		expect(crossed({ usd: 39.99, tokens: 0, wallMin: 0 }, c)).toBe(0);
		expect(crossed({ usd: 40, tokens: 0, wallMin: 0 }, c)).toBe(80);
		expect(crossed({ usd: 0, tokens: 0, wallMin: 288 }, c)).toBe(80);
		expect(crossed({ usd: 49.99, tokens: 0, wallMin: 0 }, c)).toBe(80);
		expect(crossed({ usd: 50, tokens: 0, wallMin: 0 }, c)).toBe(100);
		expect(crossed({ usd: 1, tokens: 0, wallMin: 360 }, c)).toBe(100);
		expect(crossed({ usd: 45, tokens: 10_000_000, wallMin: 10 }, c)).toBe(80);
		expect(crossed({ usd: 0.12, tokens: 0, wallMin: 1 }, { usd: 0.15, wallMin: 10 })).toBe(80);
	});
});
