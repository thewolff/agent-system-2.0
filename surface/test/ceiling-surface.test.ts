// The workload ceiling at the surface (DESIGN-workload-ceiling.md § 1 B and D, § 2 items 2 and 5),
// driven through the ledger module and the fake extension API: the open tool writes the stakes-sized
// `ceiling:` (×3 when the brief was judged change-large), Jo's stakes word re-sizes it after writing
// its instruction, Jo's `ceiling` word sets an exact figure, an answer to the runner's ceiling
// question settles it (*extend* raises by one block, completes the slice and requests one relaunch;
// *stop* and *split* only complete the slice; numbered on the needs-you list it answers as a batch
// piece the same way, and `<n> withdraw` cancels it like a bare withdraw), the orchestrator's tool
// only lowers, and the one-liner and the render show the ceiling and the spend against it.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { CEILING_OPTIONS } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { apply, ceilingOf, interpret, interpretBatch, isCeilingQuestion } from "../src/input";
import { controlEntries } from "../src/launch";
import { Numbering } from "../src/numbering";
import { oneLiner, renderWorkload } from "../src/render";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, nameWork, notices, tempLedger, tmp } from "./helpers";

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

/** A normal workload opened and named by the surface with its ceiling entry, a lane launched on it once, and the runner's ceiling question raised (a machine question: no authored ask). */
function withCeilingQuestion(l: Ledger) {
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
	nameWork(l, wl, SURFACE_BY, "Header offset token");
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	const sl = l.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: "sl-ceiling-1", task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
	const q = l.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl, body: "80 % of the ceiling", options: [...CEILING_OPTIONS] });
	return { wl, sl, q };
}

describe("ceiling at open and on Jo's stakes word", () => {
	test("open writes the stakes size, ×3 only when judged change-large; the stakes word writes its instruction first, then re-sizes naming it", async () => {
		const f = fakePi();
		const e = env();
		orchestratorSurface(f.pi, e, { judge });
		const ctx = ctxOf();
		const openTool = f.tool("orchestrator_open_workload");
		const small = await openTool.execute("1", { brief: "rename a variable", name: "Variable rename", done: "renamed", stakes: "normal" }, undefined, undefined, ctx);
		const large = await openTool.execute("1", { brief: "build the billing subsystem", name: "Billing subsystem build", done: "billing runs", stakes: "normal" }, undefined, undefined, ctx);
		const prod = await openTool.execute("1", { brief: "ship the billing subsystem", name: "Billing subsystem ship", done: "shipped", stakes: "production" }, undefined, undefined, ctx);
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
		const { wl } = withCeilingQuestion(l);
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

describe("answering the runner's ceiling question", () => {
	test("the ceiling question is the runner's, on an sl-ceiling- slice", () => {
		const { ledger: l } = tempLedger();
		const { q, sl } = withCeilingQuestion(l);
		const row = l.question(q)!;
		expect(isCeilingQuestion(row, l.slice(sl))).toBe(true);
		expect(isCeilingQuestion({ ...row, created_by: "lane-t-1" }, l.slice(sl))).toBe(false);
		expect(isCeilingQuestion({ ...row, slice_id: "sl-other" }, { id: "sl-other" })).toBe(false);
	});

	test("extend raises by one block naming the answer, completes the slice, requests the relaunch; the input row launches once", async () => {
		const f = fakePi(undefined, { exec: true });
		const e = env();
		const seed = open(e);
		const { wl, sl, q } = withCeilingQuestion(seed);
		// a reserved request waiting elsewhere does not take the option words
		seed.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "reserved-request", body: "push main" });
		expect(interpret(seed, "extend")).toMatchObject({ kind: "answer", questionId: q, answer: "extend" });
		seed.close();
		orchestratorSurface(f.pi, e, {});
		notices.length = 0;
		await f.emit("before_agent_start", { prompt: "extend", systemPrompt: [] }, ctxOf());
		expect(notices[0]).toContain(`answered ${q} with "extend"`);
		expect(notices[0]).toContain("ceiling raised to $100 / 12h; no lane holds it live, so a relaunch is requested");
		expect(f.execs.calls).toHaveLength(1);
		expect(f.execs.calls[0]!.args.slice(1)).toEqual(["launch", wl, "--requested-by", "jo"]);
		const l = open(e);
		const answer = l.question(q)!.resolved_by!;
		expect(ceilingBodies(l, wl).at(-1)).toBe(`ceiling: usd 100 wall 720 source extend one block by ${answer}`);
		expect(ceilingOf(l, wl)).toEqual({ usd: 100, wallMin: 720 });
		expect(l.slice(sl)).toMatchObject({ state: "done", artifact: `answered extend ${answer}` });
		const requests = controlEntries(l.entries(wl, "assumption")).filter((c) => c.prefix === "launch-requested");
		expect(requests.map((r) => r.body)).toEqual([expect.stringMatching(/^launch-requested: by jo at \S+ \(ceiling extend\)$/)]);
		l.close();
	});

	test("extend while a lane still holds the workload raises and completes but requests no relaunch", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl, q } = withCeilingQuestion(l);
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		expect(apply(l, interpret(l, "extend")!)).toContain("lane-t-1 still holds it");
		expect(ceilingOf(l, wl)).toEqual({ usd: 100, wallMin: 720 });
		expect(l.slice(sl)!.state).toBe("done");
		expect(l.question(q)!.state).toBe("answered");
		expect(controlEntries(l.entries(wl, "assumption")).some((c) => c.prefix === "launch-requested")).toBe(false);
	});

	test("extend while the holder is stopping at the ceiling (its newest lane-stop: is accepted ceiling) requests the relaunch and says why", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withCeilingQuestion(l);
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 accepted ceiling" });
		expect(apply(l, interpret(l, "extend")!)).toContain("ceiling raised to $100 / 12h; lane-t-1 is stopping at the ceiling, so a relaunch is requested");
		expect(controlEntries(l.entries(wl, "assumption")).filter((c) => c.prefix === "launch-requested")).toHaveLength(1);
	});

	test("extend while the holder stops for another reason still counts it as going on: only a ceiling stop requests the relaunch", () => {
		const { ledger: l } = tempLedger();
		const { wl } = withCeilingQuestion(l);
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		const req = l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 requested mode-flip by jo" });
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `lane-stop: lane-t-1 accepted ${req}` });
		expect(apply(l, interpret(l, "extend")!)).toContain("lane-t-1 still holds it and goes on under it");
		expect(controlEntries(l.entries(wl, "assumption")).some((c) => c.prefix === "launch-requested")).toBe(false);
	});

	test("withdraw on the ceiling question cancels its slice (the stop default), and the workload can close; another question's withdraw still replans", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl, q } = withCeilingQuestion(l);
		const cmd = interpret(l, "withdraw");
		expect(cmd).toEqual({ kind: "withdraw", workloadId: wl, questionId: q, then: "cancel" });
		expect(apply(l, cmd!)).toContain(`slice ${sl} is cancelled: cancelled; the lane stops at the ceiling as the default`);
		expect(l.question(q)!.state).toBe("withdrawn");
		expect(l.instructions(wl).at(-1)).toMatchObject({ kind: "withdrawal", disposition: "cancel", author: "jo", channel: "surface" });
		expect(l.workload(wl)).toMatchObject({ open_slices: 0, paused_slices: 0, open_questions: 0 });
		l.closeWorkload(wl, { by: SURFACE_BY });
		expect(l.workload(wl)!.status).toBe("closed");

		const other = l.openWorkload({ by: SURFACE_BY, brief: "another", stakes: "normal", mode: "autonomous" });
		const osl = l.addSlice({ by: "lane-o-1", workloadId: other, task: "t", doneCondition: "d", inputs: "i" });
		const oq = l.raiseQuestion({ by: "lane-o-1", workloadId: other, sliceId: osl, body: "which?", options: ["a", "b"] });
		expect(interpret(l, "withdraw")).toEqual({ kind: "withdraw", workloadId: other, questionId: oq, then: "replan" });
	});

	test("stop and split only complete the slice: no new ceiling, no launch request, nothing launched", async () => {
		for (const word of ["stop", "split"]) {
			const f = fakePi(undefined, { exec: true });
			const e = env();
			const seed = open(e);
			const { wl, sl, q } = withCeilingQuestion(seed);
			seed.close();
			orchestratorSurface(f.pi, e, {});
			await f.emit("before_agent_start", { prompt: word, systemPrompt: [] }, ctxOf());
			expect(f.execs.calls).toHaveLength(0);
			const l = open(e);
			const answer = l.question(q)!.resolved_by!;
			expect(l.slice(sl)).toMatchObject({ state: "done", artifact: `answered ${word} ${answer}` });
			expect(ceilingBodies(l, wl)).toEqual(["ceiling: usd 50 wall 360 source stakes normal"]);
			expect(controlEntries(l.entries(wl, "assumption")).some((c) => c.prefix === "launch-requested")).toBe(false);
			l.close();
		}
	});
});

describe("the runner's ceiling question as a numbered needs-you line", () => {
	/** The ceiling question numbered the way the surface numbers the needs-you list. */
	function numberedCeiling(l: Ledger) {
		const r = withCeilingQuestion(l);
		const numbering = new Numbering();
		const line = numbering.assign(errorLines(l)).find((x) => x.rowId === r.q)!;
		return { ...r, numbering, line, n: line.n! };
	}

	test("the line carries a #n and the options stop / extend / split; `<n> extend` raises one block and completes the ceiling slice", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl, q, numbering, line, n } = numberedCeiling(l);
		expect(line).toMatchObject({ kind: "question", n: expect.any(Number), options: ["stop", "extend", "split"] });
		const r = interpretBatch(l, numbering, `${n} extend`);
		expect(r).toEqual({ ok: true, items: [{ n, cmd: { kind: "answer", workloadId: wl, questionId: q, answer: "extend" } }] });
		if (!r?.ok) throw new Error("not accepted");
		const [receipt] = l.write(() => r.items.map((i) => apply(l, i.cmd)));
		expect(receipt).toContain("ceiling raised to $100 / 12h");
		const answer = l.question(q)!.resolved_by!;
		expect(ceilingBodies(l, wl).at(-1)).toBe(`ceiling: usd 100 wall 720 source extend one block by ${answer}`);
		expect(ceilingOf(l, wl)).toEqual({ usd: 100, wallMin: 720 });
		expect(l.slice(sl)).toMatchObject({ state: "done", artifact: `answered extend ${answer}` });
	});

	test("`<n> withdraw` withdraws it with then cancel, the same as a bare withdraw", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl, q, numbering, n } = numberedCeiling(l);
		const r = interpretBatch(l, numbering, `${n} withdraw`);
		expect(r).toEqual({ ok: true, items: [{ n, cmd: { kind: "withdraw", workloadId: wl, questionId: q, then: "cancel" } }] });
		if (!r?.ok) throw new Error("not accepted");
		l.write(() => r.items.map((i) => apply(l, i.cmd)));
		expect(l.question(q)!.state).toBe("withdrawn");
		expect(l.instructions(wl).at(-1)).toMatchObject({ kind: "withdrawal", disposition: "cancel" });
		expect(l.slice(sl)!.state).toBe("cancelled");
	});

	test("`<n> stop` is accepted and only completes the slice", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl, q, numbering, n } = numberedCeiling(l);
		const r = interpretBatch(l, numbering, `${n} stop`);
		expect(r).toEqual({ ok: true, items: [{ n, cmd: { kind: "answer", workloadId: wl, questionId: q, answer: "stop" } }] });
		if (!r?.ok) throw new Error("not accepted");
		l.write(() => r.items.map((i) => apply(l, i.cmd)));
		expect(l.slice(sl)).toMatchObject({ state: "done", artifact: `answered stop ${l.question(q)!.resolved_by!}` });
		expect(ceilingBodies(l, wl)).toEqual(["ceiling: usd 50 wall 360 source stakes normal"]);
	});

	test("a bare extend with two ceiling questions open is ambiguous, never applied to the first", () => {
		const { ledger: l } = tempLedger();
		const a = withCeilingQuestion(l);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "second", stakes: "normal", mode: "autonomous" });
		const sl = l.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: "sl-ceiling-2", task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
		const q = l.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl, body: "80 % of the ceiling", options: [...CEILING_OPTIONS] });
		// Both workloads can open in the same ms, so the in-flight order (and with it the candidates' order) is not fixed: compare as a set.
		const cmd = interpret(l, "extend");
		expect(cmd).toMatchObject({ kind: "ambiguous", word: "extend" });
		if (cmd?.kind !== "ambiguous") throw new Error("not ambiguous");
		expect(cmd.candidates).toHaveLength(2);
		expect(cmd.candidates).toEqual(
			expect.arrayContaining([
				{ kind: "question", workloadId: a.wl, rowId: a.q },
				{ kind: "question", workloadId: wl, rowId: q },
			]),
		);
		expect(interpret(l, `extend ${q}`)).toMatchObject({ kind: "answer", questionId: q, answer: "extend" });
	});
});

describe("the orchestrator's lowering tool", () => {
	test("lowers either half; refuses a raise, no value, a closed, unknown or standing workload, writing nothing", async () => {
		const f = fakePi();
		const e = env();
		const seed = open(e);
		const { wl } = withCeilingQuestion(seed);
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
		const { wl } = withCeilingQuestion(l);
		expect(oneLiner(l, l.workload(wl)!)).toMatch(/ · ceiling \$50 \/ 6h$/);
		const block = () => renderWorkload(l, l.inFlight().find((w) => w.workload.id === wl)!);
		expect(block()).not.toContain("spent $");
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 3.1 tokens 1000 wall 10" });
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 40.4567 tokens 90000 wall 290.5" });
		l.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 1 tokens 1 wall 1" }); // a lane's forgery is dropped
		expect(block()).toContain("spent $40.46 of $50 · 290.5 of 360 min");
	});
});
