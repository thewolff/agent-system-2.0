// PR 1 of wl-mv67564rdkfvnk (PLAN rev 5 § 2 D7; § 5 `sl-trig-tests`): Jo's typed `pair` on a round-limit question that
// offered it, through the surface's own word path (`interpret` then `apply`, surface/src/input.ts). In one write it
// settles the question the way `stop` does (review-loop-end <sl> stop), flips the workload to user-driven as Jo via the
// surface, records `pair-taken: <q> by <answer> mode user-driven`, and asks a lane holding the workload live to stop
// (`lane-stop: <lane> requested …`). `pair` on a question with no valid offer is refused naming the question, and
// nothing is written. The round-limit question is the one raise site since PLAN wl-mvfkv7llkp7nk0 § 4.
//
// The question is built as the raise site writes it (the plan's D1; PLAN wl-mvb9mw00ycfjeo D1: the body carries no
// `pair:` line): raised by the lane with its `review-limit:` entry and a classifier-stamped
// `pair-offer: <q> site round-limit …`.
//
// PLAN wl-mvb9mw00ycfjeo R4 and R5: `pair` answered single, by its number (`1 pair`) and on a pasted line settles the same
// way, and pair on a question that does not offer it is refused on each path; the receipt ends on a line that is exactly
// `as2 lane <workload-id>`.
//
// Regression: fails on 946c016 by assertion (`pair` is answered as a plain word: no loop end, no flip, no pair-taken:).
import { describe, expect, test } from "bun:test";
import { reviewLimitBody, reviewLoopEndBody, reviewRoundBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { CLASSIFIER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { errorLines } from "../src/errors";
import { apply, interpret, interpretBatch, interpretPaste } from "../src/input";
import { controlEntries } from "../src/launch";
import { Numbering } from "../src/numbering";
import { SURFACE_BY } from "../src/types";
import { tempLedger } from "./helpers";

const LANE = "lane-t-1";

/** An autonomous normal workload; with `held`, lane-t-1 holds it under a live lease. */
function workload(ledger: Ledger, held: boolean): string {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Restyle the settings modal", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	if (held) {
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
	}
	return wl;
}

/** The classifier's round-limit question on a failed review loop, offering pair; `offer: false` leaves out its pair-offer:. */
function roundLimitQuestion(ledger: Ledger, o: { held: boolean; offer?: boolean; options?: string[] }): { wl: string; sl: string; q: string } {
	const wl = workload(ledger, o.held);
	const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "Restyle the modal", doneCondition: "review passes", inputs: "src/modal.css" });
	const findings = { counts: { blocking: { correctness: 1 }, major: {}, minor: {} }, titles: [] };
	ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewRoundBody({ slice: sl, round: 1, token: "dt-r1", group: "dg-r1", verdict: "accepted", findings }) });
	const q = ledger.raiseQuestion({
		by: LANE, workloadId: wl, sliceId: sl,
		body: `The review of ${sl} reached its round limit: 1 failed round of 1 allowed (normal stakes).`,
		options: o.options ?? [...ROUND_LIMIT_OPTIONS, "pair"],
	});
	ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
	if (o.offer !== false) ledger.recordEntry({ by: CLASSIFIER_BY, workloadId: wl, kind: "assumption", body: `pair-offer: ${q} site round-limit signals e` });
	return { wl, sl, q };
}

/** Jo types `text` at the surface: the receipt, or the refusal (interpret's refused command, or apply's throw). */
function typed(ledger: Ledger, text: string): { receipt?: string; refused?: string } {
	try {
		const cmd = interpret(ledger, text);
		if (cmd === null) return { refused: `"${text}" is no command` };
		return { receipt: apply(ledger, cmd) };
	} catch (error) {
		return { refused: error instanceof Error ? error.message : String(error) };
	}
}

/** Jo answers by number (`text` a numbered batch over the needs-you lines as numbered now): the receipts, or the refusal lines. */
function numbered(ledger: Ledger, text: string): { receipts?: string[]; refused?: string[] } {
	const numbering = new Numbering();
	numbering.assign(errorLines(ledger));
	const r = interpretBatch(ledger, numbering, text);
	if (r === null) return { refused: [`"${text}" is no batch`] };
	if (!r.ok) return { refused: r.lines };
	try {
		return { receipts: ledger.write(() => r.items.map(({ cmd }) => apply(ledger, cmd))) };
	} catch (error) {
		return { refused: [error instanceof Error ? error.message : String(error)] };
	}
}

/** Jo pastes `text` (several lines): the command receipts, or the refusal verdicts. */
function pasted(ledger: Ledger, text: string): { receipts?: string[]; refused?: string[] } {
	const numbering = new Numbering();
	numbering.assign(errorLines(ledger));
	const r = interpretPaste(ledger, numbering, text);
	if (r === null) return { refused: ["prose"] };
	if (!r.ok) return { refused: r.refused.map((f) => (f.why === null ? `line ${f.line} ok` : Array.isArray(f.why) ? f.why.join("; ") : "ambiguous")) };
	try {
		return { receipts: ledger.write(() => r.items.flatMap((i) => (i.kind === "command" ? [apply(ledger, i.cmd)] : i.kind === "batch" ? i.items.map(({ cmd }) => apply(ledger, cmd)) : []))) };
	} catch (error) {
		return { refused: [error instanceof Error ? error.message : String(error)] };
	}
}

/** Every row a refused answer must leave untouched. */
function snapshot(ledger: Ledger, wl: string) {
	return {
		entries: ledger.entries(wl).map((e) => e.id),
		instructions: ledger.instructions(wl).map((i) => i.id),
		questions: ledger.questions(wl).map((q) => [q.id, q.state]),
		slices: ledger.slices(wl).map((s) => [s.id, s.state]),
		mode: ledger.workload(wl)!.mode,
	};
}

const bodies = (ledger: Ledger, wl: string, prefix: string) => ledger.entries(wl).filter((e) => e.body.startsWith(prefix));
const laneStops = (ledger: Ledger, wl: string) => controlEntries(ledger.entries(wl, "assumption")).filter((c) => c.prefix === "lane-stop" && c.laneId === LANE);

/** The flip as Jo via the surface: the workload's mode and its one mode-flip instruction. */
function expectFlippedByJo(ledger: Ledger, wl: string): void {
	expect(ledger.workload(wl)!.mode).toBe("user-driven");
	const flips = ledger.instructions(wl).filter((i) => i.kind === "mode-flip");
	expect(flips.map((i) => [i.body, i.author, i.channel, i.created_by])).toEqual([["user-driven", "jo", "surface", SURFACE_BY]]);
}

describe("pair on an offered round-limit question (D7)", () => {
	test("held by a live lane: the question is answered pair, the loop ends `stop`, the slice is left as stop leaves it, the mode flips to user-driven, pair-taken: and the lane-stop: request are written", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = roundLimitQuestion(ledger, { held: true });
		const r = typed(ledger, "pair");
		expect(r.refused).toBeUndefined();
		const row = ledger.question(q)!;
		expect(row.state).toBe("answered");
		const answer = ledger.instructions(wl).find((i) => i.id === row.resolved_by)!;
		expect([answer.kind, answer.body, answer.author, answer.channel]).toEqual(["answer", "pair", "jo", "surface"]);
		const ends = bodies(ledger, wl, "review-loop-end:");
		expect(ends.map((e) => [e.body, e.created_by])).toEqual([[reviewLoopEndBody(sl, "stop"), SURFACE_BY]]);
		expectFlippedByJo(ledger, wl);
		expect(bodies(ledger, wl, "pair-taken:").map((e) => [e.body, e.created_by])).toEqual([[`pair-taken: ${q} by ${row.resolved_by} mode user-driven`, SURFACE_BY]]);
		const stops = laneStops(ledger, wl);
		expect(stops.map((c) => c.createdBy)).toEqual([SURFACE_BY]);
		expect(stops[0]!.rest).toStartWith("requested ");
		// the slice is in the state a plain `stop` answer leaves it in
		const { ledger: control } = tempLedger();
		const c = roundLimitQuestion(control, { held: true });
		expect(typed(control, "stop").refused).toBeUndefined();
		expect(ledger.slice(sl)!.state).toBe(control.slice(c.sl)!.state);
	});

	test("no lane holds it: the same settlement and flip, and no lane-stop:", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = roundLimitQuestion(ledger, { held: false });
		expect(typed(ledger, `pair ${q}`).refused).toBeUndefined();
		expect(bodies(ledger, wl, "review-loop-end:").map((e) => e.body)).toEqual([reviewLoopEndBody(sl, "stop")]);
		expectFlippedByJo(ledger, wl);
		expect(bodies(ledger, wl, "pair-taken:")).toHaveLength(1);
		expect(laneStops(ledger, wl)).toEqual([]);
	});
});

describe("pair with no valid offer (D7)", () => {
	test("a round-limit question listing pair with no pair-offer: entry: refused naming the question, nothing written", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true, offer: false });
		const before = snapshot(ledger, wl);
		expect(typed(ledger, "pair")).toEqual({ refused: expect.stringContaining(`${q} does not offer pair`) });
		expect(snapshot(ledger, wl)).toEqual(before);
	});
});

describe("pair by number and pasted (PLAN wl-mvb9mw00ycfjeo R4, R5)", () => {
	for (const [path, answer, words] of [["numbered", numbered, (_q: string) => "1 pair"], ["pasted", pasted, (q: string) => `pair ${q}\nKeep the token scale.`]] as const) {
		test(`${path}: an offered round-limit question held by a live lane settles as stop, flips to user-driven, writes pair-taken: and requests lane-stop:; the receipt ends on exactly \`as2 lane <wl>\``, () => {
			const { ledger } = tempLedger();
			const { wl, sl, q } = roundLimitQuestion(ledger, { held: true });
			const r = answer(ledger, words(q));
			expect(r.refused).toBeUndefined();
			expect(r.receipts).toHaveLength(1);
			expect(r.receipts![0]!.split("\n").at(-1)).toBe(`as2 lane ${wl}`);
			expect(ledger.question(q)!.state).toBe("answered");
			expect(bodies(ledger, wl, "review-loop-end:").map((e) => e.body)).toEqual([reviewLoopEndBody(sl, "stop")]);
			expectFlippedByJo(ledger, wl);
			expect(bodies(ledger, wl, "pair-taken:")).toHaveLength(1);
			expect(laneStops(ledger, wl).map((c) => c.createdBy)).toEqual([SURFACE_BY]);
		});

		test(`${path}: pair on a question listing pair with no pair-offer: entry is refused naming the question, nothing written`, () => {
			const { ledger } = tempLedger();
			const { wl, q } = roundLimitQuestion(ledger, { held: true, offer: false });
			const before = snapshot(ledger, wl);
			const r = answer(ledger, words(q));
			expect(r.receipts).toBeUndefined();
			expect(r.refused!.join("\n")).toContain(`${q} does not offer pair`);
			expect(snapshot(ledger, wl)).toEqual(before);
		});
	}

	test("pair on a question that never listed pair: refused on every path, nothing written", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true, offer: false, options: [...ROUND_LIMIT_OPTIONS] });
		const before = snapshot(ledger, wl);
		expect(typed(ledger, `pair ${q}`).receipt).toBeUndefined();
		expect(numbered(ledger, "1 pair").receipts).toBeUndefined();
		expect(pasted(ledger, `pair ${q}\nThanks.`).receipts).toBeUndefined();
		expect(snapshot(ledger, wl)).toEqual(before);
	});
});

describe("the pair receipt (PLAN wl-mvb9mw00ycfjeo D6, R5)", () => {
	test("ends on `in another terminal:` then a line that is exactly the by-hand command; no `continue it yourself` clause", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: false });
		const lines = typed(ledger, `pair ${q}`).receipt!.split("\n");
		expect(lines.slice(-2)).toEqual(["in another terminal:", `as2 lane ${wl}`]);
		expect(lines[0]).toStartWith(`answered ${q} with "pair"`);
		expect(lines.join("\n")).not.toContain("continue it yourself");
	});
});
