// Jo's standing rulings (gates/src/rulings.ts, PLAN wl-mvfkv7llkp7nk0 § 1, R1–R4): `askJo` decides a covered question
// with no question row and the asker's `ruling-applied:` entry, and raises every other question as before; each ruling
// decides only its own kind, inside its scope, until its date or Jo's `end-ruling <id>`.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import {
	askJo, checkRulings, endedRulings, questionKind, type RulingFacts, type RulingId, STANDING_RULINGS, subjectProblem, type TrainSignoffFact, trainSignoffAction,
} from "../src/rulings";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
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

describe("train-signoff (PLAN wl-mvg8itbt0rz3ls D1; R3, R4): Jo's train word on a production PR is his merge sign-off", () => {
	const MERGE = ["merged", "skip", "stop"];
	const HEAD = "c".repeat(40);
	const OK: TrainSignoffFact = { ok: true, pr: 267, slice: "sl-train-mvg46wxgwnsw00-267", repo: "thewolff/agent-system-2.0", head: HEAD, run: "tr-0abc1234" };
	const trainLane = (over: Partial<RulingFacts> = {}) => lane({ train: true, trainSignoff: OK, ...over });

	test("decides only a lane's merge question on a train whose fact is ok", () => {
		expect(check(MERGE, trainLane())).toMatchObject({ ruling: "train-signoff", answer: "merge" });
		expect(check(MERGE, trainLane({ trainSignoff: { ok: false, reason: "no green at its head" } }))).toBeNull();
		expect(check(MERGE, trainLane({ trainSignoff: undefined }))).toBeNull();
		// no train: never train-signoff (a normal-stakes lane's merge question is the merges ruling's)
		expect(check(MERGE, trainLane({ train: false }))?.ruling).toBe("merges");
		expect(check(MERGE, trainLane({ train: false, stakes: "production" }))).toBeNull();
		expect(check(MERGE, trainLane({ train: undefined, stakes: "production" }))).toBeNull();
		for (const asker of ["orchestrator", "classifier", "train"] as const) expect(check(MERGE, { asker, train: true, trainSignoff: OK })).toBeNull();
		// a train's other questions are never merge questions
		expect(check(["retry", "skip", "stop"], trainLane())).toBeNull();
		expect(check(MERGE, trainLane(), { ended: ["train-signoff"] })).toBeNull();
	});

	test("the action is step 7 c. to e.: a merge commit at the verified head, verify, record; the command carries none of --admin, --squash, --rebase or --auto", () => {
		const action = check(MERGE, trainLane())!.action;
		expect(action).toBe(trainSignoffAction(OK));
		const merge = /`(gh pr merge [^`]*)`/.exec(action)?.[1];
		expect(merge).toBe(`gh pr merge 267 -R thewolff/agent-system-2.0 --merge --match-head-commit ${HEAD}`);
		for (const flag of ["--admin", "--squash", "--rebase", "--auto"]) expect(merge).not.toContain(flag);
		expect(action).toContain("gh pr view 267 -R thewolff/agent-system-2.0 --json state,mergeCommit");
		expect(action).toContain("train-error: pr 267 merge-refused");
		expect(action).toContain("complete sl-train-mvg46wxgwnsw00-267 with artifact `merged by train <merge commit sha> (run tr-0abc1234)`");
	});

	test("askJo records ruling-applied: train-signoff with no question row; after Jo's end-ruling train-signoff the same question is raised", () => {
		const { l, wl, sl } = ledger();
		const ask = () => askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Merge #267?", options: MERGE }, { ...trainLane(), now: IN_WINDOW });
		expect(ask()).toMatchObject({ decided: { ruling: "train-signoff", answer: "merge" } });
		expect(l.questions(wl)).toEqual([]);
		expect(l.entries(wl).map((e) => e.body)).toEqual([`ruling-applied: train-signoff kind merge slice ${sl} answer merge`]);
		endRuling(l, "train-signoff");
		expect([...endedRulings(l.instructions(STANDING_WORKLOAD_ID))]).toEqual(["train-signoff"]);
		const r = ask();
		expect("raised" in r).toBe(true);
		expect(l.questions(wl).map((q) => q.state)).toEqual(["open"]);
	});
});
