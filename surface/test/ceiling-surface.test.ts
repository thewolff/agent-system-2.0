// The workload ceiling at the surface (DESIGN-workload-ceiling.md § 1 B and D, § 2 items 2 and 5; PLAN
// wl-mvfkv7llkp7nk0 § 4, R13), driven through the ledger module and the fake extension API: the open tool writes the
// stakes-sized `ceiling:` (×3 when the brief was judged change-large), Jo's stakes word re-sizes it after writing its
// instruction, Jo's `ceiling` word sets an exact figure and Jo's `extend` word raises by one block of the workload's own
// size, both naming Jo's instruction and both relaunching a lane the runner stopped at the ceiling through one rule; the
// orchestrator's tool only lowers, and the one-liner and the render show the ceiling and the spend against it.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { apply, ceilingOf, interpret, interpretPaste } from "../src/input";
import { controlEntries, laneExitBody } from "../src/launch";
import { Numbering } from "../src/numbering";
import { oneLiner, renderWorkload } from "../src/render";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, HOW_IT_FAILS, notices, tempLedger, tmp } from "./helpers";

function env(): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}
const open = (e: Record<string, string>) => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });

/** A judge that calls a brief naming a "subsystem" change-large, anything else change-small, both confidently. */
const judge = async () => ({
	judge: async ({ state }: { state: string }) => {
		const choice = state.includes("subsystem") ? "change-large" : "change-small";
		const other = choice === "change-large" ? "change-small" : "change-large";
		return { answers: { kind: { choice, confidence: 0.9, probabilities: { [choice]: 0.9, [other]: 0.04, locate: 0.02, understand: 0.02, judge: 0.02 } } }, provider: "typesafe", model: "jev-test" };
	},
});

const ceilingBodies = (l: Ledger, wl: string) => controlEntries(l.entries(wl, "assumption")).filter((c) => c.prefix === "ceiling").map((c) => c.body);

/** A normal workload opened by the surface with its ceiling entry ($50 / 6h) and a lane launched on it once. */
function withLane(l: Ledger, mode: "autonomous" | "user-driven" = "autonomous") {
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	l.addSlice({ by: "lane-t-1", workloadId: wl, task: "Move the offset", doneCondition: "bun test passes", inputs: "src/header.css" });
	return { wl };
}

/** The runner's stop of lane-t-1 at 100 % of $50: its accepted ceiling stop, the spend it read, and (once it is gone) its exit. */
function stopAtCeiling(l: Ledger, wl: string, o: { exited: boolean } = { exited: true }) {
	l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 50.2 tokens 1000 wall 40" });
	l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 accepted ceiling" });
	if (o.exited) l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-t-1", { code: 0, signal: null, outcome: "stop", reason: "ceiling" }) });
}

const requests = (l: Ledger, wl: string) => controlEntries(l.entries(wl, "assumption")).filter((c) => c.prefix === "launch-requested");

describe("ceiling at open and on Jo's stakes word", () => {
	test("open writes the stakes size, ×3 only when judged change-large; the stakes word writes its instruction first, then re-sizes naming it", async () => {
		const f = fakePi();
		const e = env();
		orchestratorSurface(f.pi, e, { judge });
		const ctx = ctxOf();
		const openTool = f.tool("orchestrator_open_workload");
		const small = await openTool.execute("1", { brief: `rename a variable${HOW_IT_FAILS}`, done: "renamed", stakes: "normal" }, undefined, undefined, ctx);
		const large = await openTool.execute("1", { brief: `build the billing subsystem${HOW_IT_FAILS}`, done: "billing runs", stakes: "normal" }, undefined, undefined, ctx);
		const prod = await openTool.execute("1", { brief: `ship the billing subsystem${HOW_IT_FAILS}`, done: "shipped", stakes: "production" }, undefined, undefined, ctx);
		const idOf = (r: { details?: unknown }): string => {
			const d = r.details;
			if (d && typeof d === "object" && "id" in d && typeof d.id === "string") return d.id;
			throw new Error("the open tool returned no workload id");
		};
		const [a, b, c] = [small, large, prod].map(idOf);
		expect(small.content[0]!.text).toContain("· ceiling $50 / 6h");
		expect(large.content[0]!.text).toContain("· ceiling $150 / 18h");
		const l = open(e);
		expect(ceilingBodies(l, a!)).toEqual(["ceiling: usd 50 wall 360 source stakes normal"]);
		expect(ceilingBodies(l, b!)).toEqual(["ceiling: usd 150 wall 1080 source stakes normal x3 change-large"]);
		// production skips the judge: ×1 even for a large brief
		expect(ceilingBodies(l, c!)).toEqual(["ceiling: usd 150 wall 720 source stakes production"]);

		const receipt = apply(l, interpret(l, `production ${b}`)!);
		expect(receipt).toContain("ceiling $450 / 36h");
		const ins = l.instructions(b!).at(-1)!;
		expect(ins).toMatchObject({ body: "stakes: production", author: "jo", channel: "surface", created_by: SURFACE_BY });
		expect(ceilingBodies(l, b!).at(-1)).toBe(`ceiling: usd 450 wall 2160 source stakes production x3 change-large by ${ins.id}`);
		expect(ceilingOf(l, b!)).toEqual({ usd: 450, wallMin: 2160 });
		expect(l.workload(b!)!.stakes).toBe("production");
		// down again: a lowering, still sized with the ×3
		apply(l, interpret(l, `throwaway ${b}`)!);
		expect(ceilingOf(l, b!)).toEqual({ usd: 15, wallMin: 180 });
		// a workload never judged large re-sizes ×1
		apply(l, interpret(l, `production ${a}`)!);
		expect(ceilingOf(l, a!)).toEqual({ usd: 150, wallMin: 720 });
		l.close();
	});
});

describe("Jo's ceiling word", () => {
	test("records the instruction, then the entry naming it; omitted hours keep the wall; the workload is the only one in view or the named one, several in view and none named is ambiguous", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l);
		const cmd = interpret(l, "ceiling 80");
		expect(cmd).toEqual({ kind: "ceiling", workloadId: wl, usd: 80, wallMin: null });
		expect(apply(l, cmd!)).toContain(`ceiling on ${wl} → $80 / 6h`);
		const ins = l.instructions(wl).at(-1)!;
		expect(ins).toMatchObject({ body: "ceiling: 80 6", author: "jo", channel: "surface" });
		expect(ceilingBodies(l, wl).at(-1)).toBe(`ceiling: usd 80 wall 360 source your word by ${ins.id}`);
		expect(ceilingOf(l, wl)).toEqual({ usd: 80, wallMin: 360 });
		const other = l.openWorkload({ by: SURFACE_BY, brief: "second", stakes: "normal", mode: "autonomous" });
		// two in view, none named: "which one?", the command as typed for its word and both workloads as candidates
		// (both can open in the same ms, so their order is the ledger's: compare as a set)
		for (const [typed, word] of [["ceiling 120", "ceiling 120"], ["Ceiling $120 8h", "ceiling $120 8h"]]) {
			const amb = interpret(l, typed!);
			if (amb?.kind !== "ambiguous") throw new Error(`${typed}: expected ambiguous, got ${JSON.stringify(amb)}`);
			expect(amb.word).toBe(word!);
			expect(amb.candidates).toHaveLength(2);
			expect(amb.candidates).toEqual(expect.arrayContaining([{ kind: "workload", workloadId: wl }, { kind: "workload", workloadId: other }]));
		}
		apply(l, interpret(l, `ceiling $120 8h ${wl}`)!);
		expect(ceilingOf(l, wl)).toEqual({ usd: 120, wallMin: 480 });
		expect(ceilingOf(l, other)).toEqual({ usd: 50, wallMin: 360 });
		for (const bad of ["ceiling", "ceiling abc", "ceiling 0", `ceiling 10 0 ${wl}`, `ceiling 10 2 wl-nope`, `ceiling 10 2 ${wl} extra`]) expect(interpret(l, bad)).toBeNull();
	});

	test("reaches the ledger through the surface input row as a four-word prompt: the instruction, then the entry naming it", async () => {
		const f = fakePi();
		const e = env();
		const seed = open(e);
		const wl = seed.openWorkload({ by: SURFACE_BY, brief: "Fix", stakes: "normal", mode: "autonomous" });
		seed.close();
		orchestratorSurface(f.pi, e, {});
		notices.length = 0;
		await f.emit("before_agent_start", { prompt: `ceiling 60 8 ${wl}`, systemPrompt: [] }, ctxOf());
		expect(notices).toEqual([expect.stringContaining(`ceiling on ${wl} → $60 / 8h`)]);
		const l = open(e);
		const ins = l.instructions(wl).at(-1)!;
		expect(ins).toMatchObject({ body: "ceiling: 60 8", author: "jo", channel: "surface" });
		expect(ceilingBodies(l, wl).at(-1)).toBe(`ceiling: usd 60 wall 480 source your word by ${ins.id}`);
		expect(ceilingOf(l, wl)).toEqual({ usd: 60, wallMin: 480 });
		l.close();
	});
});

describe("Jo's extend word (R13)", () => {
	test("`extend <wl>` records Jo's instruction `ceiling: <usd> <hours>` at the value in force plus one block, then the entry naming it", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l);
		apply(l, interpret(l, `ceiling 70 ${wl}`)!);
		const cmd = interpret(l, `extend ${wl}`);
		expect(cmd).toEqual({ kind: "extend", workloadId: wl });
		expect(apply(l, cmd!)).toContain(`ceiling on ${wl} extended by $50 / 6h → $120 / 12h (instruction `);
		const ins = l.instructions(wl).at(-1)!;
		expect(ins).toMatchObject({ kind: "instruction", body: "ceiling: 120 12", author: "jo", channel: "surface", created_by: SURFACE_BY });
		expect(ceilingBodies(l, wl).at(-1)).toBe(`ceiling: usd 120 wall 720 source extend one block by ${ins.id}`);
		expect(ceilingOf(l, wl)).toEqual({ usd: 120, wallMin: 720 });
		expect(l.questions(wl)).toEqual([]);
	});

	test("the block is the workload's own size: ×3 for a brief judged change-large, the stakes size of production", () => {
		const { ledger: l } = tempLedger();
		const large = l.openWorkload({ by: SURFACE_BY, brief: "build the billing subsystem", stakes: "normal", mode: "autonomous" });
		l.recordEntry({ by: SURFACE_BY, workloadId: large, kind: "assumption", body: "brief-judged: change-large confidence 0.9" });
		l.recordEntry({ by: SURFACE_BY, workloadId: large, kind: "assumption", body: "ceiling: usd 150 wall 1080 source stakes normal x3 change-large" });
		apply(l, interpret(l, `extend ${large}`)!);
		expect(ceilingOf(l, large)).toEqual({ usd: 300, wallMin: 2160 });
		const prod = l.openWorkload({ by: SURFACE_BY, brief: "ship it", stakes: "production", mode: "autonomous" });
		l.recordEntry({ by: SURFACE_BY, workloadId: prod, kind: "assumption", body: "ceiling: usd 150 wall 720 source stakes production" });
		apply(l, interpret(l, `extend ${prod}`)!);
		expect(ceilingOf(l, prod)).toEqual({ usd: 300, wallMin: 1440 });
	});

	test("`extend` names an open workload: an unknown or closed one is refused, never prose; `extend` alone with nothing to answer is prose", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l);
		expect(interpret(l, "extend wl-nope")).toEqual({ kind: "refused", why: "wl-nope is not an open workload" });
		expect(interpret(l, `extend ${STANDING_WORKLOAD_ID}`)).toMatchObject({ kind: "refused" });
		expect(interpret(l, "extend")).toBeNull();
		expect(interpretPaste(l, new Numbering(), `extend ${wl}\nproduction ${wl}`)).toMatchObject({ ok: true });
		expect(interpretPaste(l, new Numbering(), `extend wl-nope\nproduction ${wl}`)).toMatchObject({ ok: false });
		const done = l.openWorkload({ by: SURFACE_BY, brief: "done", stakes: "normal", mode: "autonomous" });
		l.closeWorkload(done, { by: SURFACE_BY });
		expect(interpret(l, `extend ${done}`)).toMatchObject({ kind: "refused" });
	});

	test("through the surface, on a lane the runner stopped at the ceiling: the receipt says so and Jo's launch-requested: is written", async () => {
		const f = fakePi();
		const e = env();
		const seed = open(e);
		const { wl } = withLane(seed);
		stopAtCeiling(seed, wl);
		seed.close();
		orchestratorSurface(f.pi, e, {});
		notices.length = 0;
		await f.emit("before_agent_start", { prompt: `extend ${wl}`, systemPrompt: [] }, ctxOf());
		expect(notices[0]).toContain(`→ $100 / 12h`);
		expect(notices[0]).toContain("lane-t-1 stopped at the ceiling, so a relaunch is requested");
		const l = open(e);
		expect(requests(l, wl).map((r) => r.body)).toEqual([expect.stringMatching(/^launch-requested: by jo at \S+ \(ceiling extend\)$/)]);
		l.close();
	});
});

describe("the relaunch both raise words share (R13)", () => {
	test("`ceiling <usd>` relaunches a lane stopped at the ceiling too; a value the stop's spend still reaches relaunches nothing", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l);
		stopAtCeiling(l, wl);
		expect(apply(l, interpret(l, `ceiling 40 ${wl}`)!)).toContain("lane-t-1 stopped at the ceiling and its spend ($50.20 / 40 min) still reaches $40 / 6h, so nothing relaunches");
		expect(requests(l, wl)).toEqual([]);
		expect(apply(l, interpret(l, `ceiling 80 ${wl}`)!)).toContain(`ceiling on ${wl} → $80 / 6h (instruction `);
		expect(requests(l, wl).map((r) => r.body)).toEqual([expect.stringMatching(/\(ceiling word\)$/)]);
	});

	test("a second raise while the first relaunch request waits writes no second request", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l);
		stopAtCeiling(l, wl);
		apply(l, interpret(l, `extend ${wl}`)!);
		expect(apply(l, interpret(l, `ceiling 200 ${wl}`)!)).toContain("lane-t-1 stopped at the ceiling and a relaunch is already requested");
		expect(requests(l, wl)).toHaveLength(1);
	});

	test("while the holder is stopping at the ceiling (its lease live, its stop accepted) the relaunch is requested and the receipt says so", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l);
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		stopAtCeiling(l, wl, { exited: false });
		expect(apply(l, interpret(l, `extend ${wl}`)!)).toContain("lane-t-1 is stopping at the ceiling, so a relaunch is requested");
		expect(requests(l, wl)).toHaveLength(1);
	});

	test("no relaunch for a lane not stopped at the ceiling: a live holder goes on under the raise, a stop for another reason, a lane that finished, a newer lane", () => {
		const { ledger: l } = tempLedger();
		const live = withLane(l).wl;
		expect(l.claimWorkload(live, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		expect(apply(l, interpret(l, `extend ${live}`)!)).toContain("lane-t-1 still holds it and goes on under it");
		const req = l.recordEntry({ by: SURFACE_BY, workloadId: live, kind: "assumption", body: "lane-stop: lane-t-1 requested mode-flip by jo" });
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: live, kind: "assumption", body: `lane-stop: lane-t-1 accepted ${req}` });
		expect(apply(l, interpret(l, `ceiling 300 ${live}`)!)).toContain("lane-t-1 still holds it and goes on under it");
		expect(requests(l, live)).toEqual([]);

		const finished = withLane(l).wl;
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: finished, kind: "assumption", body: laneExitBody("lane-t-1", { code: 0, signal: null, outcome: "completed" }) });
		expect(apply(l, interpret(l, `extend ${finished}`)!)).not.toContain("relaunch");
		expect(requests(l, finished)).toEqual([]);

		const relaunched = withLane(l).wl;
		stopAtCeiling(l, relaunched);
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: relaunched, kind: "assumption", body: "launch: lane-t-2 cause first requested-by test" });
		apply(l, interpret(l, `extend ${relaunched}`)!);
		expect(requests(l, relaunched)).toEqual([]);
	});

	test("a user-driven workload stopped at the ceiling is raised but not relaunched", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l, "user-driven");
		stopAtCeiling(l, wl);
		expect(apply(l, interpret(l, `extend ${wl}`)!)).toContain(`lane-t-1 stopped at the ceiling and ${wl} is user-driven, so nothing relaunches`);
		expect(ceilingOf(l, wl)).toEqual({ usd: 100, wallMin: 720 });
		expect(requests(l, wl)).toEqual([]);
	});
});

describe("the orchestrator's lowering tool", () => {
	test("lowers either half; refuses a raise, no value, a closed, unknown or standing workload, writing nothing", async () => {
		const f = fakePi();
		const e = env();
		const seed = open(e);
		const { wl } = withLane(seed);
		const closed = seed.openWorkload({ by: SURFACE_BY, brief: "old", stakes: "normal", mode: "autonomous" });
		seed.closeWorkload(closed, { by: SURFACE_BY });
		seed.close();
		orchestratorSurface(f.pi, e, {});
		const ctx = ctxOf();
		const lower = async (params: Record<string, unknown>) => (await f.tool("orchestrator_lower_ceiling").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
		expect(await lower({ workloadId: wl, usd: "20" })).toContain(`Lowered the ceiling on ${wl} from $50 / 6h to $20 / 6h`);
		const refusals = [
			await lower({ workloadId: wl, usd: "30" }),
			await lower({ workloadId: wl, wallMinutes: "400" }),
			await lower({ workloadId: wl, usd: "10", wallMinutes: "400" }),
			await lower({ workloadId: wl }),
			await lower({ workloadId: wl, usd: "-1" }),
			await lower({ workloadId: closed, usd: "1" }),
			await lower({ workloadId: "wl-nope", usd: "1" }),
			await lower({ workloadId: STANDING_WORKLOAD_ID, usd: "1" }),
		];
		expect(refusals[0]).toContain("$30 is above the $20 in force");
		expect(refusals[1]).toContain("400 min is above the 360 min in force");
		for (const r of refusals) expect(r).toContain("nothing was written");
		expect(await lower({ workloadId: wl, wallMinutes: "120" })).toContain("to $20 / 2h");
		const l = open(e);
		expect(ceilingBodies(l, wl).slice(1)).toEqual(["ceiling: usd 20 wall 360 source lowered by orchestrator", "ceiling: usd 20 wall 120 source lowered by orchestrator"]);
		expect(ceilingOf(l, wl)).toEqual({ usd: 20, wallMin: 120 });
		l.close();
	});
});

describe("the one-liner and the render", () => {
	test("the one-liner carries the effective ceiling; the block shows the newest spend against it", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withLane(l);
		expect(oneLiner(l, l.workload(wl)!)).toMatch(/ · ceiling \$50 \/ 6h$/);
		const block = () => renderWorkload(l, l.inFlight().find((w) => w.workload.id === wl)!);
		expect(block()).not.toContain("spent $");
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 3.1 tokens 1000 wall 10" });
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 40.4567 tokens 90000 wall 290.5" });
		l.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 1 tokens 1 wall 1" }); // a lane's forgery is dropped
		expect(block()).toContain("spent $40.46 of $50 · 290.5 of 360 min");
	});
});
