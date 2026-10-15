// Plan-first at open (DESIGN-lane-launcher.md decision 15, amended by MIGRATION.md item 42): at
// normal stakes a workload opens plan-first unless the open-time judge answers change-small at 0.9
// or higher, or Jo says "no plan" (or the orchestrator passes `plan: "none"`). A judge that is not
// wired, throws or answers malformed fails toward a plan. Production is always plan-first, Jo's plan
// words win over "no plan", and throwaway keeps the large-change-only rule. The ceiling's ×3 still
// follows only a judged change-large, so "no plan" keeps the judge running.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { controlEntries } from "../src/launch";
import { PLAN_SKIP_CONFIDENCE, planFirstTrigger, saidNoPlan } from "../src/stakes";
import { ctxOf, fakePi, tmp } from "./helpers";

function env(): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}

const KINDS = ["locate", "understand", "change-small", "change-large", "judge"] as const;

/** A well-formed kind answer: `choice` at `confidence`, the rest spread evenly over the other four kinds. */
function answer(choice: string, confidence: number) {
	const probabilities = Object.fromEntries(KINDS.map((k) => [k, k === choice ? confidence : (1 - confidence) / 4]));
	return { answers: { kind: { choice, confidence, probabilities } }, provider: "typesafe", model: "jev-test" };
}

type Deps = Parameters<typeof orchestratorSurface>[2];
/** A judge that answers every brief with `choice` at `confidence`. */
const judging = (choice: string, confidence: number): Deps => ({ judge: async () => ({ judge: async () => answer(choice, confidence) }) });

/** The open tool's `details.<key>` as a string or null, narrowed rather than cast. */
function detail(details: unknown, key: "id" | "planFirst"): string | null {
	if (!details || typeof details !== "object" || !(key in details)) throw new Error(`the open tool returned no ${key}`);
	const v: unknown = Reflect.get(details, key);
	if (v !== null && typeof v !== "string") throw new Error(`the open tool's ${key} is not a string or null`);
	return v;
}

/** Open one workload through the open tool under its authored `name`; return the tool's text and the workload's plan and ceiling control lines. */
async function openWith(deps: Deps, params: { name: string } & Record<string, unknown>) {
	const f = fakePi();
	const e = env();
	orchestratorSurface(f.pi, e, deps);
	const r = await f.tool("orchestrator_open_workload").execute("1", { done: "it is done", ...params }, undefined, undefined, ctxOf());
	const id = detail(r.details, "id")!;
	const l = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });
	const control = controlEntries(l.entries(id, "assumption"));
	l.close();
	return {
		text: r.content[0]!.text,
		plan: control.filter((c) => c.prefix === "plan").map((c) => c.body),
		ceiling: control.filter((c) => c.prefix === "ceiling").map((c) => c.body),
		planFirst: detail(r.details, "planFirst"),
	};
}

const NORMAL_X1 = "ceiling: usd 50 wall 360 source stakes normal";
const NORMAL_X3 = "ceiling: usd 150 wall 1080 source stakes normal x3 change-large";

describe("normal stakes: plan-first unless judged change-small at 0.9 or higher (regressions, each wrote no flag before)", () => {
	test("(a) judged change-small 0.70 writes `plan: first default`, ceiling ×1", async () => {
		const o = await openWith(judging("change-small", 0.7), { brief: "rename a variable", name: "Variable rename", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first default"]);
		expect(o.ceiling).toEqual([NORMAL_X1]);
		expect(o.planFirst).toBe("default");
	});
	test("(b) judged understand 0.63 writes `plan: first default`", async () => {
		const o = await openWith(judging("understand", 0.63), { brief: "look at how the header offset is computed", name: "Header offset computation", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first default"]);
		expect(o.ceiling).toEqual([NORMAL_X1]);
	});
	test("(c) judged change-large 0.22 writes `plan: first default`, ceiling ×1 (only change-large > 0.55 sizes ×3)", async () => {
		const o = await openWith(judging("change-large", 0.22), { brief: "move the header offset into a token", name: "Header offset token", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first default"]);
		expect(o.ceiling).toEqual([NORMAL_X1]);
	});
	test("(d) no judge wired writes `plan: first default` and says the brief was not sized", async () => {
		const o = await openWith({}, { brief: "move the header offset into a token", name: "Header offset token", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first default"]);
		expect(o.ceiling).toEqual([NORMAL_X1]);
		expect(o.text).toContain("no judge is wired");
	});
	test("(e) a judge that throws writes `plan: first default`", async () => {
		const o = await openWith({ judge: async () => ({ judge: async () => { throw new Error("judge offline"); } }) }, { brief: "move the header offset into a token", name: "Header offset token", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first default"]);
		expect(o.text).toContain("judge offline");
	});
	test("(e) a judge with a malformed distribution writes `plan: first default`", async () => {
		const bad = answer("change-small", 0.95);
		bad.answers.kind.probabilities = { "change-small": 0.95, "change-large": 0.5, locate: 0, understand: 0, judge: 0 };
		const o = await openWith({ judge: async () => ({ judge: async () => bad }) }, { brief: "rename a variable", name: "Variable rename", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first default"]);
		expect(o.ceiling).toEqual([NORMAL_X1]);
	});
});

describe("controls (hold before and after)", () => {
	test("judged change-small 0.95 writes no flag and names the skip", async () => {
		const o = await openWith(judging("change-small", 0.95), { brief: "rename a variable", name: "Variable rename", stakes: "normal" });
		expect(o.plan).toEqual([]);
		expect(o.ceiling).toEqual([NORMAL_X1]);
		expect(o.planFirst).toBeNull();
		expect(o.text).toContain("change-small");
	});
	test("judged change-large 0.82 writes `plan: first large change`, ceiling ×3", async () => {
		const o = await openWith(judging("change-large", 0.82), { brief: "build the billing subsystem", name: "Billing subsystem", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first large change"]);
		expect(o.ceiling).toEqual([NORMAL_X3]);
	});
});

describe('the "no plan" word', () => {
	test('"no plan" on a brief judged change-large 0.82 writes no flag and keeps the ×3 ceiling', async () => {
		const o = await openWith(judging("change-large", 0.82), { brief: "build the billing subsystem, no plan", name: "Billing subsystem", stakes: "normal" });
		expect(o.plan).toEqual([]);
		expect(o.ceiling).toEqual([NORMAL_X3]);
		expect(o.text).toContain('no plan first: you said "no plan".');
		expect(o.text).not.toContain("the orchestrator passed");
	});
	test('`plan: "none"` writes no flag, the judge still sizes the ceiling', async () => {
		const o = await openWith(judging("change-large", 0.82), { brief: "build the billing subsystem", name: "Billing subsystem", stakes: "normal", plan: "none" });
		expect(o.plan).toEqual([]);
		expect(o.ceiling).toEqual([NORMAL_X3]);
		expect(o.text).toContain('no plan first: the orchestrator passed plan: "none".');
		expect(o.text).not.toContain("you said");
	});
	test('the quoted mention "no plan" alone is not the word: `plan: first default`', async () => {
		const o = await openWith(judging("change-small", 0.7), { brief: 'skip the plan only when the judge says small or I say "no plan"', name: "Plan skip rule", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first default"]);
	});
	test('"no plan" together with "plan it" fails toward a plan: `your word`', async () => {
		const o = await openWith(judging("change-small", 0.95), { brief: "no plan needed? no, plan it", name: "Planned change", stakes: "normal" });
		expect(o.plan).toEqual(["plan: first your word"]);
	});
	test('"no plan" at production stakes does not lift it: `production`, and the result says so', async () => {
		const o = await openWith(judging("change-small", 0.95), { brief: "fix the header, no plan", name: "Header fix", stakes: "production" });
		expect(o.plan).toEqual(["plan: first production"]);
		expect(o.text).toContain('"no plan" does not lift it');
	});
});

describe("throwaway keeps today's rule: plan-first only on a judged large change", () => {
	test("judged change-small 0.5 writes no flag", async () => {
		const o = await openWith(judging("change-small", 0.5), { brief: "try out a header token", name: "Header token trial", stakes: "throwaway" });
		expect(o.plan).toEqual([]);
	});
	test("judged change-large 0.82 writes `plan: first large change`", async () => {
		const o = await openWith(judging("change-large", 0.82), { brief: "build the billing subsystem", name: "Billing subsystem", stakes: "throwaway" });
		expect(o.plan).toEqual(["plan: first large change"]);
	});
});

describe("saidNoPlan: an unquoted occurrence is the word, the phrase quoted on its own is a mention", () => {
	test("unquoted, any case, spaced or hyphenated, counts", () => {
		for (const s of ["fix it, no plan", "No Plan, just fix the header", "no-plan: rename it", "NO PLAN"]) expect(saidNoPlan(s)).toBe(true);
	});
	test("the phrase quoted on its own with straight, curly or back quotes does not count", () => {
		for (const s of ['or I say "no plan"', "or I say 'no plan'", "or I say \u201cno plan\u201d", "or I say \u2018no plan\u2019", "or I say `no plan`", 'say "no-plan"']) expect(saidNoPlan(s)).toBe(false);
	});
	test("inside a longer quoted span it counts", () => {
		expect(saidNoPlan('Jo: "the header is off by 4px, no plan, just fix it"')).toBe(true);
		expect(saidNoPlan("Jo: \u201cno plan, just fix it\u201d")).toBe(true);
	});
	test("one unquoted occurrence beside a quoted mention counts; mismatched quotes are not a mention", () => {
		expect(saidNoPlan('when I say "no plan" I mean it: no plan')).toBe(true);
		expect(saidNoPlan("say \u201cno plan'")).toBe(true);
	});
	test("other words containing the letters do not count", () => {
		for (const s of ["a piano plan", "no planning needed", "no plans were made", "make a plan"]) expect(saidNoPlan(s)).toBe(false);
	});
});

describe("planFirstTrigger boundaries", () => {
	test(`normal: change-small at exactly PLAN_SKIP_CONFIDENCE skips, just below it is plan-first by default`, () => {
		expect(planFirstTrigger({ stakes: "normal", saidPlan: false, noPlan: null, judged: { choice: "change-small", confidence: PLAN_SKIP_CONFIDENCE } }).trigger).toBeNull();
		expect(planFirstTrigger({ stakes: "normal", saidPlan: false, noPlan: null, judged: { choice: "change-small", confidence: 0.89 } }).trigger).toBe("default");
	});
	test("normal: change-large at exactly 0.55 is `default`, above it `large change`", () => {
		expect(planFirstTrigger({ stakes: "normal", saidPlan: false, noPlan: null, judged: { choice: "change-large", confidence: 0.55 } }).trigger).toBe("default");
		expect(planFirstTrigger({ stakes: "normal", saidPlan: false, noPlan: null, judged: { choice: "change-large", confidence: 0.56 } }).trigger).toBe("large change");
	});
	test('throwaway: "no plan" lifts a large change; an unsized brief is not plan-first', () => {
		expect(planFirstTrigger({ stakes: "throwaway", saidPlan: false, noPlan: "brief", judged: { choice: "change-large", confidence: 0.82 } }).trigger).toBeNull();
		expect(planFirstTrigger({ stakes: "throwaway", saidPlan: false, noPlan: null, judged: null }).trigger).toBeNull();
	});
});
