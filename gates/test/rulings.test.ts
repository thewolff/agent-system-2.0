// Jo's standing rulings (gates/src/rulings.ts, PLAN wl-mvfkv7llkp7nk0 § 1, R1–R4): `askJo` decides a covered question
// with no question row and the asker's `ruling-applied:` entry, and raises every other question as before; each ruling
// decides only its own kind, inside its scope, until its date or Jo's `end-ruling <id>`.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { askJo, checkRulings, endedRulings, questionKind, type Ruling, type RulingFacts, type RulingId, STANDING_RULINGS, subjectProblem } from "../src/rulings";
import { raiseOrchestratorQuestion } from "../../surface/src/orchestrator-question";
import { ESCALATION_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { tmp } from "./helpers";

const IN_WINDOW = Date.parse("2026-10-20T12:00:00-07:00");
const KIMI_END = Date.parse("2026-11-01T00:00:00-07:00");
const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
const ASTRA = "openai-codex/gpt-6-astra";

function ledger() {
	const l = Ledger.open(join(tmp("rulings"), "ledger.db"), { create: true, backup: false, backupOnOpen: false });
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
	const sl = l.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	return { l, wl, sl };
}

/** Jo's `end-ruling <id>` as the surface writes it: Jo's instruction on the standing workload. */
function endRuling(l: Ledger, id: string, over: { by?: string; author?: string } = {}): void {
	if (!l.workload(STANDING_WORKLOAD_ID)) l.openWorkload({ by: SURFACE_BY, id: STANDING_WORKLOAD_ID, brief: "standing", stakes: "normal", mode: "user-driven" });
	l.recordInstruction({ by: over.by ?? SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `end-ruling ${id}`, author: over.author ?? "jo", channel: "surface" });
}

const none = { now: IN_WINDOW, ended: new Set<RulingId>() };
const check = (options: string[], facts: RulingFacts, o: { body?: string; subject?: "lane-model" | "review-model"; now?: number; ended?: RulingId[] } = {}) =>
	checkRulings({ body: o.body ?? "which?", options, subject: o.subject ?? null }, facts, { now: o.now ?? none.now, ended: new Set(o.ended ?? []) });
const lane = (over: Partial<RulingFacts> = {}): RulingFacts => ({ asker: "lane", builders: { labs: ["anthropic", "openai"], unknown: [] }, stakes: "normal", train: false, ...over });

describe("R1: askJo is the check before any question row", () => {
	test("a decided question writes no question row, leaves the slice open, and records the asker's ruling-applied entry; the result is the ruling, answer and action", () => {
		const { l, wl, sl } = ledger();
		const r = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Open the docs workload now or later?", options: ["open", "later"] }, { asker: "lane", now: IN_WINDOW });
		expect(r).toEqual({ decided: { ruling: "flow-repair", answer: "later", action: STANDING_RULINGS.find((x) => x.id === "flow-repair")!.action({ body: "", options: [] }, "open-workload", { asker: "lane" }, "later") } });
		expect(l.questions(wl)).toEqual([]);
		expect(l.slice(sl)!.state).toBe("open");
		const applied = l.entries(wl).filter((e) => e.body.startsWith("ruling-applied:"));
		expect(applied.map((e) => [e.body, e.created_by, e.slice_id])).toEqual([[`ruling-applied: flow-repair kind open-workload slice ${sl} answer later`, "lane-a", sl]]);
	});

	test("an undecided question is raised as before: the row, the slice paused, no ruling-applied entry", () => {
		const { l, wl, sl } = ledger();
		const r = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Ship it?", options: ["ship", "hold"] }, { asker: "lane", now: IN_WINDOW });
		if (!("raised" in r)) throw new Error("expected a raised question");
		const q = l.questions(wl);
		expect(q.map((x) => [x.id, x.state, x.created_by])).toEqual([[r.raised, "open", "lane-a"]]);
		expect(l.slice(sl)!.state).toBe("paused");
		expect(l.entries(wl).some((e) => e.body.startsWith("ruling-applied:"))).toBe(false);
	});

	test("a model question declares its subject: refused without one when every option is a provider/model id, and refused when declared on any other set; nothing is written", () => {
		const { l, wl, sl } = ledger();
		expect(() => askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Which model?", options: [OPUS, SOL] }, { asker: "lane" })).toThrow("declare `subject`");
		expect(() => askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Ship?", options: ["ship", "hold"], subject: "lane-model" }, { asker: "lane" })).toThrow("only when every option");
		expect(subjectProblem([OPUS, SOL], "reviewer")).toContain("not reviewer");
		expect(l.questions(wl)).toEqual([]);
		expect(l.entries(wl)).toEqual([]);
	});

	test("Jo's end-ruling, read from the ledger, makes askJo raise what the ruling would have decided", () => {
		const { l, wl, sl } = ledger();
		endRuling(l, "flow-repair");
		const r = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Open it now?", options: ["open", "later"] }, { asker: "lane", now: IN_WINDOW });
		expect("raised" in r).toBe(true);
	});
});

describe("R2: kimi-out", () => {
	const PARK = ["same-lab", "wait"];
	test("a lane's same-lab question is decided while the rule is active with known builders that exclude Kimi; the action re-dispatches the review", () => {
		const d = check(PARK, lane());
		expect(d).toMatchObject({ ruling: "kimi-out", answer: "same-lab" });
		expect(d!.action).toContain("re-dispatch the review");
	});
	test("Kimi a builder, provenance unknown, no builders read, or the rule ended (its date or Jo's word): asked", () => {
		expect(check(PARK, lane({ builders: { labs: ["anthropic", "kimi"], unknown: [] } }))).toBeNull();
		expect(check(PARK, lane({ builders: { labs: [], unknown: [] } }))).toBeNull();
		expect(check(PARK, lane({ builders: { labs: ["anthropic"], unknown: ["lane-b"] } }))).toBeNull();
		expect(check(PARK, lane({ builders: null }))).toBeNull();
		expect(check(PARK, lane(), { now: KIMI_END - 1 })).not.toBeNull();
		expect(check(PARK, lane(), { now: KIMI_END })).toBeNull();
		expect(check(PARK, lane(), { ended: ["kimi-out"] })).toBeNull();
	});
	test("the classifier's park is decided by its own R1–R5 verdict alone", () => {
		expect(check(PARK, { asker: "classifier", kimiOut: false })).toBeNull();
		expect(check(PARK, { asker: "classifier", kimiOut: true })).toMatchObject({ ruling: "kimi-out", answer: "same-lab" });
		expect(check(PARK, { asker: "classifier", kimiOut: true }, { now: KIMI_END })).toBeNull();
	});
});

describe("R3: flow-repair, merges, models, gates-stakes, each in its scope until its end", () => {
	test("flow-repair decides an open-workload question with the queueing option, from any asker, until Jo ends it", () => {
		expect(check(["launch", "queue"], { asker: "orchestrator" })).toMatchObject({ ruling: "flow-repair", answer: "queue" });
		expect(check(["open", "hold"], { asker: "orchestrator" })).toMatchObject({ ruling: "flow-repair", answer: "hold" });
		expect(check(["open", "later"], { asker: "orchestrator" }, { ended: ["flow-repair"] })).toBeNull();
	});

	test("merges decides a lane's merge question on a normal-stakes workload that is no merge train, and nothing else", () => {
		const d = check(["merge", "wait"], lane());
		expect(d).toMatchObject({ ruling: "merges", answer: "train" });
		expect(d!.action).toContain("merge train");
		expect(check(["merge", "wait"], lane({ stakes: "production" }))).toBeNull();
		expect(check(["merge", "wait"], lane({ train: true }))).toBeNull();
		expect(check(["merge", "wait"], { asker: "orchestrator" })).toBeNull();
		expect(check(["merge", "wait"], lane(), { ended: ["merges"] })).toBeNull();
	});

	test("models: a lane-model question takes claude-opus-5-5 when offered and no provider refusal is cited", () => {
		expect(check([OPUS, SOL], lane(), { subject: "lane-model" })).toMatchObject({ ruling: "models", answer: OPUS });
		expect(check([SOL, ASTRA], lane(), { subject: "lane-model" })).toBeNull();
		expect(check([OPUS, SOL], lane(), { subject: "lane-model", body: "Opus answered 429 rate limit twice; switch?" })).toBeNull();
		expect(check([OPUS, SOL], lane(), { subject: "lane-model", ended: ["models"] })).toBeNull();
	});

	test("models: a review-model question with an astra option takes the review row's OpenAI model when it is offered", () => {
		const facts = lane({ reviewModel: () => SOL });
		expect(check([ASTRA, SOL], facts, { subject: "review-model" })).toMatchObject({ ruling: "models", answer: SOL });
		expect(check([ASTRA, OPUS], facts, { subject: "review-model" })).toBeNull();
		expect(check([SOL, OPUS], facts, { subject: "review-model" })).toBeNull();
		expect(check([ASTRA, SOL], lane({ reviewModel: () => null }), { subject: "review-model" })).toBeNull();
	});

	test("models decides only by the declared subject: the same option set with no subject is no model question", () => {
		expect(questionKind([OPUS, SOL])).toBe("other");
		expect(questionKind([OPUS, SOL], "lane-model")).toBe("lane-model");
		expect(check([OPUS, SOL], lane())).toBeNull();
		expect(check([ASTRA, SOL], lane({ reviewModel: () => SOL }), { subject: "lane-model" })).toBeNull();
	});

	test("gates-stakes decides a stakes question raised before a workload opens whose body names gates/, and nothing else", () => {
		const body = "The fix touches gates/src/rows/r08.ts: normal or production?";
		expect(check(["normal", "production"], { asker: "orchestrator", about: null }, { body })).toMatchObject({ ruling: "gates-stakes", answer: "production" });
		expect(check(["normal", "production"], { asker: "orchestrator", about: "wl-x" }, { body })).toBeNull();
		expect(check(["normal", "production"], { asker: "orchestrator", about: null }, { body: "normal or production?" })).toBeNull();
		expect(check(["normal", "production"], lane(), { body })).toBeNull();
		expect(check(["normal", "production"], { asker: "orchestrator", about: null }, { body, ended: ["gates-stakes"] })).toBeNull();
	});
});

describe("R4: a ruling decides only its own kind", () => {
	test("round-limit, ceiling, train, plan, safety and any other option set is `other` and always asks", () => {
		const sets = [
			["extend", "accept", "stop"],
			["extend", "accept", "stop", "pair"],
			["retry", "skip", "stop"],
			["approve", "revise", "cancel"],
			["approve", "merge"],
			["revert", "keep"],
		];
		for (const options of sets) {
			expect(questionKind(options)).toBe("other");
			for (const facts of [lane(), { asker: "orchestrator" } as RulingFacts, { asker: "train" } as RulingFacts, { asker: "classifier", kimiOut: true } as RulingFacts]) {
				expect(check(options, facts)).toBeNull();
			}
		}
	});

	test("each kind is read off its option set (count-questions.py's mapping)", () => {
		expect(questionKind(["same-lab", "wait"])).toBe("review-park");
		expect(questionKind(["open", "later"])).toBe("open-workload");
		expect(questionKind(["merged", "wait"])).toBe("merge");
		expect(questionKind(["integrate", "hold"])).toBe("merge");
		expect(questionKind(["normal", "production"])).toBe("stakes");
	});
});

describe("endedRulings: only Jo's word through the surface, for a ruling held here", () => {
	test("a lane's or a non-Jo instruction, an unknown id, or a different body ends nothing", () => {
		const { l } = ledger();
		endRuling(l, "merges", { by: "lane-a" });
		endRuling(l, "merges", { author: "lane" });
		endRuling(l, "no-such-ruling");
		l.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: "please end-ruling merges", author: "jo", channel: "surface" });
		expect([...endedRulings(l.instructions(STANDING_WORKLOAD_ID))]).toEqual([]);
		endRuling(l, "merges");
		expect([...endedRulings(l.instructions(STANDING_WORKLOAD_ID))]).toEqual(["merges"]);
	});
});

describe("phase 2 (PLAN wl-mvg1vs0rhnu3gg § 1.0, § 1.9, § 3.5): now, duplicates, ruling conflicts", () => {
	const escalations = (l: Ledger, wl: string) =>
		l.entries(wl).filter((e) => /^(now|ruling-conflict): /.test(e.body)).map((e) => [e.body, e.created_by, e.slice_id]);

	test("R1: now skips a covering ruling: the question is raised with ESCALATION_BY's now: mark in its write, for each of the seven words; any other word is refused with nothing written", () => {
		const { l, wl, sl } = ledger();
		const open = { by: "lane-a", workloadId: wl, sliceId: sl, body: "Open the docs workload now or later?", options: ["open", "later"] };
		expect(() => askJo(l, { ...open, now: "urgent" as never }, { asker: "lane", now: IN_WINDOW })).toThrow("nothing was asked");
		expect(l.questions(wl)).toEqual([]);
		expect(l.entries(wl)).toEqual([]);
		const r = askJo(l, { ...open, now: "security" }, { asker: "lane", now: IN_WINDOW });
		if (!("raised" in r)) throw new Error("expected the now question raised past flow-repair");
		expect(l.questions(wl).map((q) => [q.id, q.state])).toEqual([[r.raised, "open"]]);
		expect(l.slice(sl)!.state).toBe("paused");
		expect(escalations(l, wl)).toEqual([[`now: ${r.raised} security`, ESCALATION_BY, sl]]);
		expect(l.entries(wl).some((e) => e.body.startsWith("ruling-applied:"))).toBe(false);
		for (const word of ["integrity", "incident", "guard", "boundary", "irreversible", "money"] as const) {
			const other = l.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
			const asked = askJo(l, { ...open, sliceId: other, now: word }, { asker: "lane", now: IN_WINDOW });
			if (!("raised" in asked)) throw new Error(`expected the ${word} question raised`);
			expect(escalations(l, wl).at(-1)).toEqual([`now: ${asked.raised} ${word}`, ESCALATION_BY, other]);
		}
		expect(l.entries(wl).some((e) => e.body.startsWith("ruling-applied:"))).toBe(false);
	});

	test("R7: a duplicate of an open question returns the open id marked reused and writes nothing", () => {
		const { l, wl, sl } = ledger();
		const ask = { by: "lane-a", workloadId: wl, sliceId: sl, body: "Ship it?", options: ["ship", "hold"] };
		const first = askJo(l, ask, { asker: "lane", now: IN_WINDOW });
		if (!("raised" in first)) throw new Error("expected a raised question");
		const entries = l.entries(wl).length;
		expect(askJo(l, ask, { asker: "lane", now: IN_WINDOW })).toEqual({ raised: first.raised, reused: true });
		expect(l.questions(wl).map((q) => q.id)).toEqual([first.raised]);
		expect(l.entries(wl).length).toBe(entries);
		// A revised body, or other options, is a new question.
		const revised = askJo(l, { ...ask, body: "Ship it now?" }, { asker: "lane", now: IN_WINDOW });
		expect(revised).not.toHaveProperty("reused");
		expect(l.questions(wl).length).toBe(2);
	});

	test("R7: the same orchestrator body about two workloads raises two questions; a repeat about the first reuses its id", () => {
		const { l } = ledger();
		const a = l.openWorkload({ by: SURFACE_BY, brief: "A", stakes: "normal", mode: "autonomous" });
		const b = l.openWorkload({ by: SURFACE_BY, brief: "B", stakes: "normal", mode: "autonomous" });
		const ask = (about: string) => raiseOrchestratorQuestion(l, { body: "Keep the lane running?", options: ["keep", "stop"], about });
		const qa = ask(a);
		const qb = ask(b);
		if (!("raised" in qa) || !("raised" in qb)) throw new Error("expected two raised questions");
		expect(qb.raised).not.toBe(qa.raised);
		expect(qb).not.toHaveProperty("reused");
		expect(l.questions(STANDING_WORKLOAD_ID).filter((q) => q.state === "open").map((q) => q.id).sort()).toEqual([qa.raised, qb.raised].sort());
		expect(ask(a)).toEqual({ raised: qa.raised, reused: true });
		expect(l.questions(STANDING_WORKLOAD_ID).length).toBe(2);
	});

	test("R7: a repeated model-subject question raises again, while the same repeat of a plain question is reused", () => {
		const { l, wl, sl } = ledger();
		const plain = { by: "lane-a", workloadId: wl, sliceId: sl, body: "Ship it?", options: ["ship", "hold"] };
		const p1 = askJo(l, plain, { asker: "lane", now: IN_WINDOW });
		expect(askJo(l, plain, { asker: "lane", now: IN_WINDOW })).toEqual({ ...p1, reused: true });
		const model = { by: "lane-a", workloadId: wl, sliceId: sl, body: "Which model?", options: [SOL, ASTRA], subject: "lane-model" as const };
		const m1 = askJo(l, model, lane({ now: IN_WINDOW }));
		const m2 = askJo(l, model, lane({ now: IN_WINDOW }));
		if (!("raised" in m1) || !("raised" in m2)) throw new Error("expected both model questions raised");
		expect(m2.raised).not.toBe(m1.raised);
		expect(m2).not.toHaveProperty("reused");
		expect(l.questions(wl).length).toBe(3);
	});

	test("R7: a queued duplicate asked with now gains one now: mark for the open id; an already-NOW one gains none", () => {
		const { l, wl, sl } = ledger();
		const ask = { by: "lane-a", workloadId: wl, sliceId: sl, body: "Ship it?", options: ["ship", "hold"] };
		const first = askJo(l, ask, { asker: "lane", now: IN_WINDOW });
		if (!("raised" in first)) throw new Error("expected a raised question");
		expect(escalations(l, wl)).toEqual([]);
		expect(askJo(l, { ...ask, now: "guard" }, { asker: "lane", now: IN_WINDOW })).toEqual({ raised: first.raised, reused: true });
		expect(escalations(l, wl)).toEqual([[`now: ${first.raised} guard`, ESCALATION_BY, sl]]);
		const entries = l.entries(wl).length;
		expect(askJo(l, { ...ask, now: "money" }, { asker: "lane", now: IN_WINDOW })).toEqual({ raised: first.raised, reused: true });
		expect(l.entries(wl).length).toBe(entries);
		expect(l.questions(wl).length).toBe(1);
	});

	const injected = (id: RulingId, answer: string): Ruling => ({
		id,
		sources: ["in-test"],
		kinds: ["merge"],
		scope: () => true,
		answer: () => answer,
		action: (_q, _k, _f, a) => `${id} says ${a}`,
		exceptions: "none",
		ends: { at: null, event: "the test" },
	});

	test("R9: two active rulings that decide one question with different answers decide nothing: it is raised with ESCALATION_BY's ruling-conflict:", () => {
		const { l, wl, sl } = ledger();
		const rulings = [injected("merges", "merge"), injected("flow-repair", "wait")];
		const q = { body: "Merge PR #9?", options: ["merge", "wait"] };
		expect(checkRulings({ ...q, subject: null }, lane(), none, rulings)).toBeNull();
		const r = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, ...q }, lane({ now: IN_WINDOW }), rulings);
		if (!("raised" in r)) throw new Error("expected the conflicted question raised");
		expect(l.questions(wl).map((x) => x.id)).toEqual([r.raised]);
		expect(escalations(l, wl)).toEqual([[`ruling-conflict: ${r.raised} merges flow-repair`, ESCALATION_BY, sl]]);
		expect(l.entries(wl).some((e) => e.body.startsWith("ruling-applied:"))).toBe(false);
	});

	test("R9: active rulings that agree still decide, as the first of them", () => {
		const { l, wl, sl } = ledger();
		const rulings = [injected("merges", "merge"), injected("flow-repair", "merge")];
		const q = { body: "Merge PR #9?", options: ["merge", "wait"] };
		const r = askJo(l, { by: SURFACE_BY, workloadId: wl, sliceId: sl, ...q }, { asker: "orchestrator", now: IN_WINDOW }, rulings);
		expect(r).toEqual({ decided: { ruling: "merges", answer: "merge", action: "merges says merge" } });
		expect(l.questions(wl)).toEqual([]);
		expect(escalations(l, wl)).toEqual([]);
		expect(l.entries(wl).map((e) => e.body)).toEqual([`ruling-applied: merges kind merge slice ${sl} answer merge`]);
	});
});
