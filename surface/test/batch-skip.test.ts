// A numbered batch applies every valid answer and skips only the bad numbers (PLAN wl-mv66ylg1op3wg0
// D9, Jo's in-mv6uf1b4z6jsao): a number not given, a row no longer waiting, a word the row does not
// take, or a number given twice (every piece with it) is skipped and named with its reason; each
// valid piece goes through apply() in its own nested transaction, so one the ledger refuses rolls
// back alone and is skipped with the ledger's message. The echo is `#n → <receipt>` or `#n skipped:
// <reason>` per piece, in batch order. In a paste the numbered lines follow the same rule; a
// non-numbered command line that does not resolve still refuses the paste whole. Driven through the
// real extension with the fake host, as surface/test/paste-blocks.test.ts does (`input`, then
// `before_agent_start`).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLimitBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import type { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines } from "../src/errors";
import { apply, interpret } from "../src/input";
import { Numbering } from "../src/numbering";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, notices, tempLedger, tmp, workloadWithSlice } from "./helpers";

/** A surface over `db`, as a fresh process would load it; the lane starter's exec is recorded, never run. */
function surface(db: string) {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: db, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: true });
	orchestratorSurface(f.pi, env);
	const ctx = ctxOf();
	/**
	 * The turn's prompt, after OMP's `input` when Jo typed it: the turn's notices. A typed numbered batch is applied and answered at
	 * submit (PLAN wl-mv66ylg1op3wg0 D7) and OMP starts no turn for a handled input: its lines are then the reply display's lead.
	 */
	const turn = async (prompt: string, typed = true): Promise<string[]> => {
		const sentBefore = f.sent.length;
		notices.length = 0;
		const r = typed ? await f.emit("input", { text: prompt, source: "interactive" }, ctx) : undefined;
		if (typeof r === "object" && r !== null && "handled" in r && r.handled === true) {
			const reply = f.sent.slice(sentBefore).find((m) => m.message.customType === "surface-send-line");
			return reply ? reply.message.content.split("\n\n")[0]!.split("\n") : [...notices];
		}
		notices.length = 0;
		await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx);
		return [...notices];
	};
	const raise = async (params: Record<string, unknown>): Promise<string> => {
		const text = (await f.tool("orchestrator_raise_question").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
		const m = /^Raised question (q-\S+)/.exec(text);
		if (!m) throw new Error(`not raised: ${text}`);
		return m[1]!;
	};
	return { f, ctx, turn, raise };
}

/** The number a fresh session gives row `id`: the surface numbers every answerable line before it reads a batch. */
const numberOf = (ledger: Ledger, id: string): number => new Numbering().assign(errorLines(ledger)).find((l) => l.rowId === id)!.n!;

/** Every answer row on `wl` as `[question, answer]`, sorted (rows written in one ms list in the ledger's order). */
const answers = (ledger: Ledger, wl: string) => ledger.instructions(wl).filter((i) => i.kind === "answer").map((i) => [i.question_id, i.body]).sort();

/** Jo's input rows on the standing workload. */
const joRows = (ledger: Ledger) => ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => i.kind === "instruction" && i.author === "jo");

/** A workload with three plan-style questions open on three slices; `qs[k]` is #k+1 on the needs-you list (rows raised in one ms number in the ledger's order, not raise order). */
function threeQuestions() {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	const qs = [1, 2, 3].map((n) => {
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: `plan ${n}`, doneCondition: "d", inputs: "a.ts" });
		return ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: `Plan ${n}: approve?`, options: ["approve", "revise", "cancel"] });
	});
	qs.sort((x, y) => numberOf(ledger, x) - numberOf(ledger, y));
	expect(qs.map((q) => numberOf(ledger, q))).toEqual([1, 2, 3]);
	return { ledger, path, wl, qs };
}

/** `threeQuestions`, a surface that has numbered them (a bare `approve` asks "which one?" and writes nothing), and #2 answered since. */
async function secondAnswered() {
	const t = threeQuestions();
	const s = surface(t.path);
	expect((await s.turn("approve"))[0]).toStartWith('which one? "approve" fits #1');
	apply(t.ledger, interpret(t.ledger, `revise ${t.qs[1]}`)!);
	expect(answers(t.ledger, t.wl)).toHaveLength(1);
	return { ...t, s };
}

describe("a numbered batch skips bad numbers, never the whole batch (D9)", () => {
	test("nested ledger.write is a savepoint: an inner refusal rolls back only the inner rows, the outer transaction commits the rest", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const note = (body: string) => ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body });
		ledger.write(() => {
			note("outer before");
			expect(() =>
				ledger.write(() => {
					note("inner");
					throw new Error("inner refused");
				}),
			).toThrow("inner refused");
			note("outer after");
		});
		expect(ledger.entries(wl, "assumption").map((e) => e.body)).toEqual(["outer before", "outer after"]);
	});

	test("(a) `1 approve, 2 deny, 9 approve` with #2 answered since it was numbered and #9 never given: #1 applied, #2 and #9 skipped with reasons, one answer row", async () => {
		const { ledger, wl, qs, s } = await secondAnswered();
		const lines = await s.turn("1 approve, 2 deny, 9 approve");
		expect(lines).toEqual([
			expect.stringMatching(new RegExp(`^#1 → answered ${qs[0]} with "approve" \\(answer \\S+\\)`)),
			`#2 skipped: ${qs[1]} is no longer waiting`,
			"#9 skipped: not on the needs-you list",
		]);
		expect(ledger.question(qs[0]!)!.state).toBe("answered");
		expect(answers(ledger, wl)).toEqual([[qs[1], "revise"], [qs[0], "approve"]].sort());
		expect(ledger.question(qs[2]!)!.state).toBe("open");
		// the applied answer resumes the workload: the launch trigger ran once
		expect(s.f.execs.calls).toHaveLength(1);
	});

	test("(b) `1 aprove` (a word the row does not take) with a valid piece: the valid one applied, the typo skipped with its takes list", async () => {
		const { ledger, path, wl, qs } = threeQuestions();
		const s = surface(path);
		const lines = await s.turn("1 aprove, 2 approve");
		expect(lines).toEqual([
			"#1 skipped: takes: approve / revise / cancel / withdraw",
			expect.stringMatching(new RegExp(`^#2 → answered ${qs[1]} with "approve"`)),
		]);
		expect(answers(ledger, wl)).toEqual([[qs[1], "approve"]]);
		expect(ledger.question(qs[0]!)!.state).toBe("open");
	});

	test("(c) a number given twice: both pieces skipped, the other pieces applied; the launch trigger runs once for the workload both answers resume", async () => {
		const { ledger, path, wl, qs } = threeQuestions();
		const s = surface(path);
		const lines = await s.turn("1 approve, 2 approve, 1 revise, 3 cancel");
		expect(lines).toEqual([
			"#1 skipped: appears more than once in this batch",
			expect.stringMatching(new RegExp(`^#2 → answered ${qs[1]} with "approve"`)),
			"#1 skipped: appears more than once in this batch",
			expect.stringMatching(new RegExp(`^#3 → answered ${qs[2]} with "cancel"`)),
		]);
		expect(answers(ledger, wl)).toEqual([[qs[1], "approve"], [qs[2], "cancel"]].sort());
		expect(ledger.question(qs[0]!)!.state).toBe("open");
		expect(s.f.execs.calls).toHaveLength(1);
	});

	test("(d) a piece the ledger refuses inside the transaction is skipped with the ledger's reason; the other piece's row stays", async () => {
		const { ledger, path } = tempLedger();
		const { wl: a, sl } = workloadWithSlice(ledger);
		const qa = ledger.raiseQuestion({ by: "lane-a", workloadId: a, sliceId: sl, body: "Which?", options: ["left", "right"] });
		const b = ledger.openWorkload({ by: "lane-b", brief: "The subject", stakes: "normal", mode: "autonomous" });
		const s = surface(path);
		// the orchestrator's question about b, then b closes: answering it throws in the ledger (fix round 1, B4)
		const oq = await s.raise({ body: "Now or later?", options: ["now", "later"], about: b });
		ledger.closeWorkload(b, { by: "lane-b" });
		const [no, na] = [numberOf(ledger, oq), numberOf(ledger, qa)];
		const lines = await s.turn(`${no} now, ${na} left`);
		expect(lines).toEqual([
			expect.stringMatching(new RegExp(`^#${no} skipped: ${oq} is about ${b}, which is closed .*${oq} stays open`)),
			expect.stringMatching(new RegExp(`^#${na} → answered ${qa} with "left"`)),
		]);
		expect(ledger.question(oq)!.state).toBe("open");
		expect(ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => i.question_id === oq)).toEqual([]);
		expect(ledger.instructions(b)).toEqual([]);
		expect(answers(ledger, a)).toEqual([[qa, "left"]]);
	});

	test("(d) in a paste: `stop-reviews` withdraws the round-limit question, so the numbered `extend` after it fails in the ledger and is skipped; the stop stands", async () => {
		const { ledger, path } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Round limit reached", options: [...ROUND_LIMIT_OPTIONS] });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
		const n = numberOf(ledger, q);
		const s = surface(path);
		const lines = await s.turn(`stop-reviews ${sl}\n${n} extend`);
		expect(lines).toEqual([
			expect.stringMatching(new RegExp(`^stopped the review loop on ${sl} \\(instruction \\S+\\)`)),
			expect.stringMatching(new RegExp(`^#${n} skipped: .*must name an open question`)),
		]);
		expect(ledger.question(q)!.state).toBe("withdrawn");
		expect(answers(ledger, wl)).toEqual([]);
		expect(ledger.entries(wl, "assumption").some((e) => e.body.startsWith("review-stop: "))).toBe(true);
		expect(ledger.entries(wl, "assumption").some((e) => e.body.startsWith("review-rounds-extend: "))).toBe(false);
	});

	test("(e) the same mix one per line as a paste, with prose between: valid answers applied, bad numbers skipped, the prose Jo rows written", async () => {
		const { ledger, wl, qs, s } = await secondAnswered();
		const prose = ["Here is what I decided on the three plans.", "The second one is settled already, I think.", "Tell me when the first has a PR open."];
		const paste = [prose[0], "1 approve", prose[1], "2 deny", "9 approve", "3 aprove", prose[2]].join("\n");
		const lines = await s.turn(paste);
		const rows = joRows(ledger);
		expect(rows.map((r) => r.body)).toEqual(prose);
		expect(lines).toEqual([
			expect.stringMatching(new RegExp(`^line 1 is Jo's input ${rows[0]!.id}: `)),
			expect.stringMatching(new RegExp(`^#1 → answered ${qs[0]} with "approve"`)),
			expect.stringMatching(new RegExp(`^line 3 is Jo's input ${rows[1]!.id}: `)),
			`#2 skipped: ${qs[1]} is no longer waiting`,
			"#9 skipped: not on the needs-you list",
			"#3 skipped: takes: approve / revise / cancel / withdraw",
			expect.stringMatching(new RegExp(`^line 7 is Jo's input ${rows[2]!.id}: `)),
		]);
		expect(answers(ledger, wl)).toEqual([[qs[1], "revise"], [qs[0], "approve"]].sort());
		expect(ledger.question(qs[2]!)!.state).toBe("open");
		expect(s.f.entries.filter((e) => e.type === "surface-jo-input").map((e) => e.data)).toEqual(rows.map((r) => ({ id: r.id })));
		expect(s.f.execs.calls).toHaveLength(1);
	});

	test("(f) a paste with a non-numbered id that does not resolve (`approve en-nope`) is still refused whole: zero rows, nothing launched", async () => {
		const { ledger, path, wl, qs } = threeQuestions();
		const s = surface(path);
		const lines = await s.turn(["Here is my answer.", "1 approve", "approve en-nope", "9 deny"].join("\n"));
		expect(lines).toEqual([
			"line 1: an instruction for you, held with the rest; record nothing from this paste",
			'line 2 "1 approve": ok, not applied',
			'line 3 "approve en-nope": no entry en-nope on the needs-you list',
			'line 4 "9 deny": #9 skipped: not on the needs-you list',
			"nothing applied: fix line 3 and paste all of it again",
		]);
		expect(ledger.instructions(wl)).toEqual([]);
		expect(joRows(ledger)).toEqual([]);
		expect(ledger.question(qs[0]!)!.state).toBe("open");
		expect(s.f.execs.calls).toEqual([]);
	});
});
