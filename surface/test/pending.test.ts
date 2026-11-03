// `pending` (PLAN wl-mv5msri070p0qo D1, § 3 sl-pending-lib): the items and the block of answer
// lines, from ledger state alone: the recommendation's precedence, one answer line per open row with
// reserved requests answered `approve en-…` and `also: deny`, the standing workload in and closed
// workloads out, the exact block for a fixed ledger, the line format, prompt waits under the fence
// and not counted, a multiword-option question under the fence and counted, and the empty case.
import { describe, expect, test } from "bun:test";
import type { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../src/identity";
import { doneBody, planFirstBody } from "../src/launch";
import { raiseOrchestratorQuestion } from "../src/orchestrator-question";
import { PENDING_EMPTY, PENDING_LINE_MAX, pendingBlock, pendingItems, pendingWaits, pendingWrapperLines } from "../src/pending";
import { promptWaitBody } from "../src/signals";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger } from "./helpers";

const HINT = "(paste the block back as is, or any of its lines; change a line's first word to pick another option)";
const DONE_A = "the header offset lives in one token";
const planBody = (verdict: string, extra = "tradeoff: one line") =>
	["/tmp/plan.md", "- sl-1: the one slice", extra, `review: ${verdict}, openai-codex/gpt-6-sol, /tmp/PLAN-REVIEW-r1.md`].join("\n");

/** An open workload with a `done:` line, held by `lane`, and one slice of it. */
function held(ledger: Ledger, lane: string, brief: string, done: string | null): { wl: string; sl: string } {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
	if (done !== null) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody(done) });
	expect(ledger.claimWorkload(wl, { by: lane, holder: lane, leaseMs: 3_600_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: lane, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	return { wl, sl };
}

/** A plan-first workload whose plan slice raised the plan question with `body`, as lane_raise_question writes it. */
function planQuestion(ledger: Ledger, body: string): { wl: string; q: string } {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Plan the pending word", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the pending word ships") });
	expect(ledger.claimWorkload(wl, { by: "lane-p", holder: "lane-p", leaseMs: 3_600_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: "lane-p", workloadId: wl, task: "plan", doneCondition: "plan approved", inputs: "brief" });
	const q = ledger.write(() => {
		const id = ledger.raiseQuestion({ by: "lane-p", workloadId: wl, sliceId: sl, body, options: ["approve", "revise", "cancel"] });
		ledger.recordEntry({ by: "lane-p", workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${id}` });
		return id;
	});
	return { wl, q };
}

/** A fixed ledger: a reserved request, three kinds of lane question, the plan question, and the orchestrator's own question. */
function fixture() {
	const c = clock();
	const { ledger } = tempLedger(c.now);
	const a = held(ledger, "lane-a", "Fix the feed header offset\nin newdle-web", `${DONE_A}.`);
	c.plusHours(0.1);
	const en = ledger.recordEntry({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, kind: "reserved-request", body: "push: git push origin main (P-11 row 6 refused tool call c1)" });
	c.plusHours(0.1);
	const qPlain = ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Which token name?\nleft keeps the old one", options: ["left", "right"] });
	c.plusHours(0.1);
	const qMarked = ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Keep the `legacy` alias? `keep` (recommended), or drop it", options: ["drop", "keep"] });
	c.plusHours(0.1);
	const qDefault = ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Ship the header dark first?\nflag (the default): behind the flag.", options: ["now", "flag", "later"] });
	c.plusHours(1);
	const p = planQuestion(ledger, planBody("approve-with-changes"));
	c.plusHours(1);
	ensureStandingWorkload(ledger);
	const qOrch = raiseOrchestratorQuestion(ledger, { body: "Merge #12 now or wait for the smoke run?", options: ["merge", "wait"], about: a.wl }).raised;
	return { c, ledger, a, en, qPlain, qMarked, qDefault, p, qOrch };
}

/** The answer lines inside the block's fence (a plan question's `  plan for …` line beneath its own left out). */
const fenceLines = (text: string): string[] => {
	const lines = text.split("\n");
	const open = lines.indexOf("```text");
	return open < 0 ? [] : lines.slice(open + 1, lines.indexOf("```", open + 1)).filter((l) => !l.startsWith("  plan for "));
};

describe("pending: the block (PLAN wl-mv5msri070p0qo D1)", () => {
	test("the empty case, with or without the standing workload", () => {
		const { ledger } = tempLedger();
		expect(pendingBlock(pendingItems(ledger))).toEqual({ text: PENDING_EMPTY, count: 0 });
		expect(PENDING_EMPTY).toBe("## pending: nothing is waiting on you");
		ensureStandingWorkload(ledger);
		expect(pendingBlock(pendingItems(ledger), pendingWaits(ledger))).toEqual({ text: PENDING_EMPTY, count: 0 });
	});

	test("the exact block for a fixed ledger: reserved first, then questions, one line per open row", () => {
		const { ledger, en, qPlain, qMarked, qDefault, p, qOrch } = fixture();
		const on = `— on ${DONE_A}`;
		expect(pendingBlock(pendingItems(ledger))).toEqual({
			count: 6,
			text: [
				`## pending: 6 things wait on you ${HINT}`,
				"```text",
				`approve ${en}  # reserved action: push: git push origin main ${on} · no recommendation recorded · also: deny`,
				`left ${qPlain}  # Which token name ${on} · no recommendation recorded · also: right / withdraw`,
				`keep ${qMarked}  # Keep the legacy alias? keep (recommended), or drop it ${on} · recommended · also: drop / withdraw`,
				`flag ${qDefault}  # Ship the header dark first ${on} · recommended (the default) · also: now / later / withdraw`,
				`approve ${p.q}  # plan for the pending word ships — on the pending word ships · recommended (review: approve-with-changes) · also: revise / cancel / withdraw`,
				`  plan for ${p.q}: /tmp/plan.md`,
				`merge ${qOrch}  # Merge #12 now or wait for the smoke run — on your orchestrator's question about ${DONE_A} · no recommendation recorded · also: wait / withdraw`,
				"```",
			].join("\n"),
		});
	});

	test("one item per open row, reserved as approve en-… with deny alone in its tail (no withdraw)", () => {
		const { ledger, en, qPlain } = fixture();
		const items = pendingItems(ledger);
		expect(items.map((i) => i.id)).toEqual([...new Set(items.map((i) => i.id))]);
		expect(items[0]).toMatchObject({ kind: "reserved", id: en, options: ["approve", "deny"], answer: "approve", recommended: null, recordedWhere: null });
		expect(items.slice(1).every((i) => i.kind === "question")).toBe(true);
		const lines = fenceLines(pendingBlock(items).text);
		expect(lines).toHaveLength(items.length);
		const reservedLine = lines.find((l) => l.startsWith(`approve ${en} `))!;
		expect(reservedLine.endsWith("· also: deny")).toBe(true);
		expect(reservedLine).not.toContain("withdraw");
		expect(lines.find((l) => l.includes(` ${qPlain} `))!.endsWith("/ withdraw")).toBe(true);
		// an answered question is no longer a row
		ledger.answerQuestion(qPlain, { by: SURFACE_BY, answer: "left", author: "jo", channel: "surface" });
		expect(pendingItems(ledger).map((i) => i.id)).not.toContain(qPlain);
		expect(pendingItems(ledger)).toHaveLength(items.length - 1);
	});

	test("every fenced line has the answer-line shape, no backticks, no trailing punctuation, at most 240 characters", () => {
		const { ledger, a } = fixture();
		ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: `${"A `very` long question, ".repeat(20)}ending here.`, options: ["yes", "no"] });
		ledger.recordEntry({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, kind: "reserved-request", body: `deploy: \`fly deploy\` ${"--flag ".repeat(30)}(P-11 row 6 refused tool call c9)` });
		const lines = fenceLines(pendingBlock(pendingItems(ledger)).text);
		expect(lines).toHaveLength(8);
		const shape = /^\S+ (q|en)-\S+ {2}# .+ — on .+ · (recommended( \(.+\))?|no recommendation recorded) · also: \S+( \/ \S+)*$/;
		for (const l of lines) {
			expect(l).toMatch(shape);
			expect(l).not.toContain("`");
			expect(l).not.toMatch(/[.,;:!?]$/);
			expect(l.length).toBeLessThanOrEqual(PENDING_LINE_MAX);
		}
		expect(lines.some((l) => l.includes("…"))).toBe(true);
		// the fence's one other line is the plan question's path line, right beneath a line naming its id
		const all = pendingBlock(pendingItems(ledger)).text.split("\n");
		const fence = all.slice(all.indexOf("```text") + 1, all.indexOf("```", all.indexOf("```text") + 1));
		const planAt = fence.flatMap((l, i) => (l.startsWith("  plan for ") ? [i] : []));
		expect(planAt).toHaveLength(1);
		const [, id] = /^ {2}plan for (q-[a-z0-9]+): \/\S+$/.exec(fence[planAt[0]!]!)!;
		expect(fence[planAt[0]! - 1]).toMatch(new RegExp(`^approve ${id} {2}# `));
	});

	test("a long one-token option: the also: list gives way behind … so the line fits; an answer word too long for any line puts its question under the fence (code review r1 finding 5, r2)", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Fix the header", null);
		const long = `x${"y".repeat(250)}`;
		const mid = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which one?", options: ["left", long, "right"] });
		const first = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "And this one?", options: [long, "no"] });
		const { text, count } = pendingBlock(pendingItems(ledger));
		const lines = fenceLines(text);
		const midLine = lines.find((l) => l.startsWith(`left ${mid}  # `))!;
		expect(midLine.length).toBeLessThanOrEqual(PENDING_LINE_MAX);
		expect(midLine.endsWith("· also: …")).toBe(true);
		// the answer word is the long option itself: no answer line fits, so the question is a counted sentence under the fence
		expect(lines.every((l) => l.length <= PENDING_LINE_MAX)).toBe(true);
		expect(lines.some((l) => l.includes(first))).toBe(false);
		expect(count).toBe(2);
		expect(text.split("\n").at(-1)).toStartWith(`${first} on `);
		expect(text.split("\n").at(-1)).toContain("are too long for an answer line");
		// a short option list is untouched
		const short = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Short?", options: ["yes", "no"] });
		expect(fenceLines(pendingBlock(pendingItems(ledger)).text).find((l) => l.includes(short))!.endsWith("· also: no / withdraw")).toBe(true);
	});

	test("an open plan question's path line sits beneath its answer line; read back it is wrapper in the whole block and beneath its own pasted answer line, Jo's words elsewhere (merge-train review of #106)", () => {
		const { ledger, p, qPlain } = fixture();
		const text = pendingBlock(pendingItems(ledger)).text;
		const lines = text.split("\n");
		const at = lines.indexOf(`  plan for ${p.q}: /tmp/plan.md`);
		expect(lines[at - 1]).toStartWith(`approve ${p.q}  # `);
		// the whole block: every line but the answer lines is wrapper, the plan line included
		const whole = pendingWrapperLines(lines);
		expect(lines.filter((_, i) => !whole.has(i))).toEqual(fenceLines(text));
		// a pasted answer line with its plan line beneath: the plan line is wrapper
		expect([...pendingWrapperLines([`approve ${p.q}`, `  plan for ${p.q}: /tmp/plan.md`])]).toEqual([1]);
		// beneath another question's answer line, or alone, it is Jo's
		expect([...pendingWrapperLines([`left ${qPlain}`, `plan for ${p.q}: /tmp/plan.md`])]).toEqual([]);
		expect([...pendingWrapperLines([`plan for ${p.q}: /tmp/plan.md`])]).toEqual([]);
	});

	test("every line naming an open plan question carries its path line; an edited paste (its answer line deleted, a path line moved) is still the block, a fence of path lines alone is not (merge-train review of #106, round 3)", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const p = planQuestion(ledger, planBody("approve"));
		c.plusHours(0.1);
		const { wl, sl } = held(ledger, "lane-a", "Fix the header", `${DONE_A}.`);
		const other = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: `Merge before ${p.q} is approved?`, options: ["yes", "no"] });
		const wait = `lane-x on ${DONE_A} is blocked on a ask prompt it should never open (since 09:00): about ${p.q}; answer it in that session or end the session.`;
		const path = `  plan for ${p.q}: /tmp/plan.md`;
		const lines = pendingBlock(pendingItems(ledger), [wait]).text.split("\n");
		const fence = lines.slice(lines.indexOf("```text") + 1, lines.indexOf("```", lines.indexOf("```text") + 1));
		expect(fence).toHaveLength(4);
		expect(fence[0]).toStartWith(`approve ${p.q}  # `);
		expect(fence[1]).toBe(path);
		expect(fence[2]).toStartWith(`yes ${other}  # Merge before ${p.q} is approved — on `);
		expect(fence[3]).toBe(path);
		expect(lines.slice(-2)).toEqual([wait, path]);
		const kept = (ls: string[]) => {
			const w = pendingWrapperLines(ls);
			return ls.filter((_, i) => !w.has(i));
		};
		expect(kept(lines)).toEqual([fence[0], fence[2]]);
		// the plan question's answer line deleted: a path line is first in the fence, the block is still read
		expect(kept(lines.filter((l) => l !== fence[0]))).toEqual([fence[2]]);
		// a path line moved to the fence's end
		const moved = [...lines];
		moved.splice(moved.indexOf(path), 1);
		moved.splice(moved.indexOf("```"), 0, path);
		expect(kept(moved)).toEqual([fence[0], fence[2]]);
		// both answer lines deleted: no answer line, no block; the heading and the fences are Jo's
		const bare = lines.filter((l) => l !== fence[0] && l !== fence[2]);
		expect(kept(bare)).toContain("```text");
		// outside a block: a path line beneath a pasted line naming its question, past sibling path lines, is wrapper
		expect([...pendingWrapperLines([fence[2]!, path])]).toEqual([1]);
		expect([...pendingWrapperLines([fence[2]!, `  plan for ${other}: /tmp/other.md`, path])]).toEqual([1, 2]);
		expect([...pendingWrapperLines([`yes ${other}`, path])]).toEqual([]);
	});
});

describe("pending: the recorded recommendation, in precedence", () => {
	test("plan question: approve only on a review verdict starting approve or accept; a revise verdict records none, marks notwithstanding", () => {
		const { ledger } = tempLedger();
		const approve = planQuestion(ledger, planBody("Accept-as-is"));
		const revise = planQuestion(ledger, planBody("revise-and-resubmit", "tradeoff: approve (recommended) reads well"));
		const items = pendingItems(ledger);
		expect(items.find((i) => i.id === approve.q)).toMatchObject({ answer: "approve", recommended: "approve", recordedWhere: "review: Accept-as-is", subject: "plan for the pending word ships" });
		expect(items.find((i) => i.id === revise.q)).toMatchObject({ answer: "approve", recommended: null, recordedWhere: null });
		const lines = fenceLines(pendingBlock(items).text);
		expect(lines.find((l) => l.includes(approve.q))).toContain("· recommended (review: Accept-as-is) · also: revise / cancel / withdraw");
		expect(lines.find((l) => l.includes(revise.q))).toContain("· no recommendation recorded · also: revise / cancel / withdraw");
	});

	test("a question offering approve that is not the plan question takes nothing from a review line", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Brief", null);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: planBody("approve-as-is"), options: ["approve", "revise", "cancel"] });
		expect(pendingItems(ledger).find((i) => i.id === q)).toMatchObject({ answer: "approve", recommended: null, workloadWords: "Brief" });
	});

	test("a (recommended), (the default) or (default) mark names the option, case-insensitively, the first match winning", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Brief", null);
		const raise = (body: string, options: string[]) => ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body, options });
		const rec = raise("Which? `Right` (Recommended), or left", ["left", "right"]);
		const def = raise("Which? wait (default), go (recommended)", ["go", "wait"]);
		const notOption = raise("Which? maybe (recommended)", ["left", "right"]);
		const items = pendingItems(ledger);
		expect(items.find((i) => i.id === rec)).toMatchObject({ answer: "right", recommended: "right", recordedWhere: "recommended" });
		expect(items.find((i) => i.id === def)).toMatchObject({ answer: "wait", recommended: "wait", recordedWhere: "the default" });
		expect(items.find((i) => i.id === notOption)).toMatchObject({ answer: "left", recommended: null, recordedWhere: null });
		const lines = fenceLines(pendingBlock(items).text);
		expect(lines.find((l) => l.includes(rec))).toContain("· recommended · also: left / withdraw");
		expect(lines.find((l) => l.includes(def))).toContain("· recommended (the default) · also: go / withdraw");
		expect(lines.find((l) => l.includes(notOption))).toMatch(/^left q-\S+ {2}# Which\? maybe \(recommended\) — on Brief · no recommendation recorded · also: right \/ withdraw$/);
	});
});

describe("pending: which rows are covered", () => {
	test("the standing workload's questions and reserved requests are in; a closed workload's rows are out", () => {
		const { ledger } = tempLedger();
		const standing = ensureStandingWorkload(ledger);
		expect(standing).toBe(STANDING_WORKLOAD_ID);
		const bare = raiseOrchestratorQuestion(ledger, { body: "Ship it?", options: ["ship", "hold"], about: null }).raised;
		const unbound = ledger.recordEntry({ by: "lane-4242", workloadId: standing, kind: "reserved-request", body: "deploy: fly deploy (P-11 row 6 refused tool call c1)" });
		// a closed workload: its question answered, its slice done, a request still unanswered when it closed
		const closed = ledger.openWorkload({ by: SURFACE_BY, brief: "Closed one", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-c", workloadId: closed, task: "t", doneCondition: "d", inputs: "i" });
		const answered = ledger.raiseQuestion({ by: "lane-c", workloadId: closed, sliceId: sl, body: "which?", options: ["a", "b"] });
		ledger.answerQuestion(answered, { by: SURFACE_BY, answer: "a", author: "jo", channel: "surface" });
		ledger.completeSlice(sl, { by: "lane-c", artifact: "done" });
		const stray = ledger.recordEntry({ by: "lane-c", workloadId: closed, kind: "reserved-request", body: "tag the release" });
		ledger.closeWorkload(closed, { by: SURFACE_BY });
		const items = pendingItems(ledger);
		expect(items.map((i) => i.id)).toEqual([unbound, bare]);
		expect(items.map((i) => i.id)).not.toContain(stray);
		expect(items[0]).toMatchObject({ kind: "reserved", workloadId: standing, workloadWords: "a session bound to no workload", subject: "reserved action: deploy: fly deploy" });
		expect(items[1]).toMatchObject({ kind: "question", workloadId: standing, answer: "ship", workloadWords: "your orchestrator's question", subject: "Ship it" });
	});

	test("prompt waits sit under the fence and are not counted", () => {
		const { ledger, a } = fixture();
		ledger.enqueue({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("ask", "c7", "s1", "ask: which `branch`?") });
		const waits = pendingWaits(ledger);
		expect(waits).toEqual([`lane-a on ${DONE_A} is blocked on a ask prompt it should never open (since 2026-10-01T12:24:00.000Z): ask: which branch; answer it in that session or end the session.`]);
		const items = pendingItems(ledger);
		const block = pendingBlock(items, waits);
		expect(block.count).toBe(6);
		expect(block.count).toBe(items.length);
		expect(block.text.startsWith("## pending: 6 things wait on you")).toBe(true);
		expect(block.text.endsWith(`\`\`\`\n${waits[0]}`)).toBe(true);
		expect(fenceLines(block.text)).toHaveLength(6);
	});

	test("a stored question with a multiword option is a sentence under the fence, counted, never an answer line", () => {
		const { ledger, a } = fixture();
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Which repo does the git invariant read by default?", options: ["the script's checkout", "AS2_REPO"] });
		const items = pendingItems(ledger);
		expect(items.find((i) => i.id === q)).toMatchObject({ answer: null, recommended: null });
		const block = pendingBlock(items);
		expect(block.count).toBe(7);
		expect(block.text.startsWith(`## pending: 7 things wait on you ${HINT}`)).toBe(true);
		expect(fenceLines(block.text)).toHaveLength(6);
		expect(fenceLines(block.text).some((l) => l.includes(q))).toBe(false);
		expect(block.text.endsWith(`\`\`\`\n${q} on ${DONE_A} asks: Which repo does the git invariant read by default; its options (the script's checkout / AS2_REPO) are not one word each, so it has no answer line (no recommendation recorded); answer it in words.`)).toBe(true);
	});

	test("one item alone: the singular header", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Brief", null);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Go?", options: ["go", "stop"] });
		expect(pendingBlock(pendingItems(ledger))).toEqual({
			count: 1,
			text: [`## pending: 1 thing waits on you ${HINT}`, "```text", `go ${q}  # Go — on Brief · no recommendation recorded · also: stop / withdraw`, "```"].join("\n"),
		});
	});
});
