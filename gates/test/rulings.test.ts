// Jo's standing rulings (gates/src/rulings.ts, PLAN wl-mvfkv7llkp7nk0 § 1, R1–R4): `askJo` decides a covered question
// with no question row and the asker's `ruling-applied:` entry, and raises every other question as before; each ruling
// decides only its own kind, inside its scope, until its date or Jo's `end-ruling <id>`.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import {
	askJo, checkRulings, endedRulings, machineOptionSpelling, questionKind, RECORD_ANNOUNCE_OPTION, routineScreen, type Ruling, type RulingFacts, type RulingId, STANDING_RULINGS, subjectProblem,
	type TrainSignoffFact, trainSignoffAction,
} from "../src/rulings";
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
		const applied = l.entries(wl).filter((e) => e.body.startsWith("ruling-applied:"));
		expect(r).toEqual({ decided: { ruling: "flow-repair", answer: "later", action: STANDING_RULINGS.find((x) => x.id === "flow-repair")!.action({ body: "", options: [] }, "open-workload", { asker: "lane" }, "later") }, applied: applied[0]!.id });
		expect(l.questions(wl)).toEqual([]);
		expect(l.slice(sl)!.state).toBe("open");
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
	test("ceiling, train, plan, safety and any other option set is `other` and always asks", () => {
		const sets = [
			["retry", "skip", "stop"],
			["approve", "revise", "cancel"],
			["approve", "merge"],
			["revert", "keep"],
			["extend", "accept", "stop", "retry"],
		];
		for (const options of sets) {
			expect(questionKind(options)).toBe("other");
			for (const facts of [lane(), { asker: "orchestrator" } as RulingFacts, { asker: "train" } as RulingFacts, { asker: "classifier", kimiOut: true } as RulingFacts]) {
				expect(check(options, facts)).toBeNull();
			}
		}
	});

	test("the round-limit set (extend / accept / stop, with or without pair) is `round-limit`, and without the classifier's D10 facts it asks", () => {
		for (const options of [["extend", "accept", "stop"], ["extend", "accept", "stop", "pair"], ["stop", "extend", "accept"]]) {
			expect(questionKind(options)).toBe("round-limit");
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

describe("routine-calls (PLAN wl-mvqwn80onq9hq8 D6; R10, R11): a lane's routine call is recorded and announced, nothing more", () => {
	const OPTIONS = ["keep", "move", RECORD_ANNOUNCE_OPTION];
	const RECORD = "keep the offset where it is";
	const routine = (over: Partial<RulingFacts> = {}): RulingFacts => lane({ onPlanSlice: false, routineOn: () => true, ...over });
	const decide = (facts: RulingFacts, o: { body?: string; record?: string; options?: string[]; recommend?: string | null; ended?: RulingId[] } = {}) =>
		checkRulings(
			{ body: o.body ?? "Leave the offset?", options: o.options ?? OPTIONS, subject: null, recommend: o.recommend === undefined ? RECORD_ANNOUNCE_OPTION : o.recommend, record: o.record ?? RECORD },
			facts,
			{ now: IN_WINDOW, ended: new Set(o.ended ?? []) },
		);

	test("the ruling is held: its source is Jo's in-mvqwmr95k54feo, its kind record-announce, ended by Jo's word only", () => {
		const r = STANDING_RULINGS.find((x) => x.id === "routine-calls")!;
		expect({ sources: r.sources, kinds: r.kinds, at: r.ends.at }).toEqual({ sources: ["in-mvqwmr95k54feo"], kinds: ["record-announce"], at: null });
		const { l } = ledger();
		endRuling(l, "routine-calls");
		expect([...endedRulings(l.instructions(STANDING_WORKLOAD_ID))]).toEqual(["routine-calls"]);
	});

	test("record-announce is the kind only when the machinery recommends the option and the lane offered one of its own", () => {
		expect(questionKind(OPTIONS, null, RECORD_ANNOUNCE_OPTION)).toBe("record-announce");
		expect(questionKind(OPTIONS)).toBe("other");
		expect(questionKind([RECORD_ANNOUNCE_OPTION], null, RECORD_ANNOUNCE_OPTION)).toBe("other");
		expect(questionKind(["keep", "move"], null, RECORD_ANNOUNCE_OPTION)).toBe("other");
		// a plan or merge question stays its own kind even with the option appended
		expect(questionKind(["approve", "revise", RECORD_ANNOUNCE_OPTION], null, RECORD_ANNOUNCE_OPTION)).toBe("other");
		expect(questionKind(["merged", "wait", RECORD_ANNOUNCE_OPTION], null, RECORD_ANNOUNCE_OPTION)).toBe("merge");
	});

	test("R10: decides record-and-announce for a lane off the plan slice while auto-apply is on, with an action that changes nothing", () => {
		const d = decide(routine());
		expect(d).toMatchObject({ ruling: "routine-calls", answer: RECORD_ANNOUNCE_OPTION });
		expect(d!.action).toContain("change nothing");
	});

	test("R11: asked on the plan slice, from any asker but a lane, with auto-apply off or unread, without the machinery's recommend, or after Jo's end-ruling", () => {
		expect(decide(routine({ onPlanSlice: true }))).toBeNull();
		expect(decide(routine({ onPlanSlice: undefined }))).toBeNull();
		expect(decide(routine({ routineOn: () => false }))).toBeNull();
		expect(decide(routine({ routineOn: undefined }))).toBeNull();
		for (const asker of ["orchestrator", "classifier", "train"] as const) expect(decide({ ...routine(), asker })).toBeNull();
		expect(decide(routine(), { recommend: null })).toBeNull();
		expect(decide(routine(), { ended: ["routine-calls"] })).toBeNull();
	});

	test("R11: the screen sends to Jo a body or record line naming a § A4 action, in either field", () => {
		const named: [string, string][] = [
			["force-push", "force-push the rebased branch"],
			["force-push", "git push --force origin wl/x"],
			["reset --hard", "git reset --hard HEAD~1"],
			["branch or tag deletion", "git branch -D wl/old"],
			["branch or tag deletion", "delete the stale branch"],
			["branch or tag deletion", "git tag -d v1"],
			["rm -rf", "rm -rf node_modules"],
			["DROP", "DROP TABLE users"],
			["DROP", "drop the cache table"],
			["TRUNCATE", "TRUNCATE entries"],
			["production database", "query the production database"],
			["production database", "copy prod db rows"],
			["teardown", "tear down the preview stack"],
			["teardown", "teardown of the old env"],
			["destroy", "destroy the bucket"],
			["secret", "store the secret in the env file"],
			["rotate", "rotate the token"],
			["protected branch", "change the protected branch rule"],
		];
		for (const [action, text] of named) {
			expect({ text, screen: routineScreen(text) }).toEqual({ text, screen: action });
			expect({ text, body: decide(routine(), { body: text }), record: decide(routine(), { record: text }) }).toEqual({ text, body: null, record: null });
		}
		for (const text of ["keep the offset where it is", "drop the idea and keep the header", "leave the comment in place", "the branch name stays wl/x"]) {
			expect({ text, screen: routineScreen(text) }).toEqual({ text, screen: null });
		}
	});

	test("machineOptionSpelling catches the three machine options in any case or with any separators, and nothing else", () => {
		for (const o of ["record-and-announce", "RECORD_AND_ANNOUNCE", "record and announce", "announce-only", "AnnounceOnly", "record.only"]) expect({ o, m: machineOptionSpelling(o) }).toEqual({ o, m: true });
		for (const o of ["record", "announce", "keep", "record-and-move"]) expect({ o, m: machineOptionSpelling(o) }).toEqual({ o, m: false });
	});

	test("askJo: decided writes routine-recorded:, ruling-applied: and one notice in one write; no question or instruction", () => {
		const { l, wl, sl } = ledger();
		const r = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Leave the offset?", options: OPTIONS, routine: { record: RECORD } }, { ...routine(), now: IN_WINDOW });
		expect(r).toMatchObject({ decided: { ruling: "routine-calls", answer: RECORD_ANNOUNCE_OPTION } });
		const entries = l.entries(wl);
		expect(entries.map((e) => [e.body, e.created_by])).toEqual([
			[`routine-recorded: ${sl} ${RECORD}`, ESCALATION_BY],
			[`ruling-applied: routine-calls kind record-announce slice ${sl} answer ${RECORD_ANNOUNCE_OPTION}`, "lane-a"],
		]);
		expect("recorded" in r && r.recorded).toEqual({ entry: entries[0]!.id, notice: expect.stringMatching(/^msg-/) });
		const notices = l.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ?1").all(wl);
		expect(notices.map((n) => n.body)).toEqual([`notice: auto-answered ${sl} ${RECORD_ANNOUNCE_OPTION} (ruling routine-calls): ${RECORD}`]);
		expect(l.questions(wl)).toEqual([]);
		expect(l.instructions(wl)).toEqual([]);
	});

	test("askJo: the switch is read inside the write, and a record line over 120 characters is cut in the notice", () => {
		const { l, wl, sl } = ledger();
		let reads = 0;
		const long = `${"x".repeat(150)}`;
		askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Leave it?", options: OPTIONS, routine: { record: long } }, {
			...routine({ routineOn: () => (reads++, true) }),
			now: IN_WINDOW,
		});
		expect(reads).toBe(1);
		const notice = l.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ?1").get(wl)!.body;
		expect(notice).toBe(`notice: auto-answered ${sl} ${RECORD_ANNOUNCE_OPTION} (ruling routine-calls): ${"x".repeat(119)}…`);
	});

	test("askJo refuses a routine ask whose options lack the machinery's option or whose record line is not one line; nothing is written", () => {
		const { l, wl, sl } = ledger();
		const ask = (options: string[], record: string) => () => askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "b", options, routine: { record } }, routine());
		expect(ask(["keep", "move"], RECORD)).toThrow(`a routine ask carries the option ${RECORD_ANNOUNCE_OPTION}`);
		expect(ask(OPTIONS, "a\nb")).toThrow("it has a line break; nothing was asked");
		expect(ask(OPTIONS, "")).toThrow("it is empty; nothing was asked");
		expect(l.entries(wl)).toEqual([]);
		expect(l.questions(wl)).toEqual([]);
	});
});

describe("review-auto-extend (PLAN wl-mvqwn80onq9hq8 D10; R23, R24): a falling review loop extends once by itself", () => {
	const LIMIT = ["extend", "accept", "stop"];
	const falling = (over: Partial<RulingFacts> = {}): RulingFacts => ({ asker: "classifier", stakes: "normal", fell: true, extended: false, routineOn: () => true, ...over });

	test("decides the classifier's round-limit question with extend at normal or production stakes, a falling count, no extend yet and auto-apply on", () => {
		for (const stakes of ["normal", "production"] as const) {
			expect(check(LIMIT, falling({ stakes }))).toMatchObject({ ruling: "review-auto-extend", answer: "extend" });
			expect(check([...LIMIT, "pair"], falling({ stakes }))).toMatchObject({ ruling: "review-auto-extend", answer: "extend" });
		}
		const ruling = STANDING_RULINGS.find((x) => x.id === "review-auto-extend")!;
		expect(ruling.sources).toEqual(["in-mvqyknri0dy4g0"]);
		expect(ruling.kinds).toEqual(["round-limit"]);
	});

	test("asks at throwaway stakes, with a flat, rising or unknown count, an extend already, auto-apply off, another asker, or Jo's end-ruling", () => {
		expect(check(LIMIT, falling({ stakes: "throwaway" }))).toBeNull();
		expect(check(LIMIT, falling({ stakes: undefined }))).toBeNull();
		expect(check(LIMIT, falling({ fell: false }))).toBeNull();
		expect(check(LIMIT, falling({ fell: undefined }))).toBeNull();
		expect(check(LIMIT, falling({ extended: true }))).toBeNull();
		expect(check(LIMIT, falling({ extended: undefined }))).toBeNull();
		expect(check(LIMIT, falling({ routineOn: () => false }))).toBeNull();
		expect(check(LIMIT, falling({ routineOn: undefined }))).toBeNull();
		for (const asker of ["lane", "orchestrator", "train"] as const) expect(check(LIMIT, { ...falling(), asker })).toBeNull();
		expect(check(LIMIT, falling(), { ended: ["review-auto-extend"] })).toBeNull();
		// Not a round-limit option set: the ruling never reaches it.
		expect(check(["retry", "skip", "stop"], falling())).toBeNull();
	});

	test("askJo: a decided round-limit question raises no row, writes the asker's ruling-applied entry and returns its id; `now` skips the ruling", () => {
		const { l, wl, sl } = ledger();
		const r = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "The review reached its round limit.", options: LIMIT }, { ...falling(), now: IN_WINDOW });
		if (!("decided" in r)) throw new Error("expected the ruling to decide");
		expect(r.decided.ruling).toBe("review-auto-extend");
		expect(l.questions(wl)).toEqual([]);
		expect(l.entry(r.applied)?.body).toBe(`ruling-applied: review-auto-extend kind round-limit slice ${sl} answer extend`);
		const raised = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "The review reached its round limit again.", options: LIMIT, now: "incident" }, { ...falling(), now: IN_WINDOW });
		expect("raised" in raised).toBe(true);
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
		const applied = l.entries(wl).find((e) => e.body.startsWith("ruling-applied:"))!.id;
		expect(r).toEqual({ decided: { ruling: "merges", answer: "merge", action: "merges says merge" }, applied });
		expect(l.questions(wl)).toEqual([]);
		expect(escalations(l, wl)).toEqual([]);
		expect(l.entries(wl).map((e) => e.body)).toEqual([`ruling-applied: merges kind merge slice ${sl} answer merge`]);
	});
});
