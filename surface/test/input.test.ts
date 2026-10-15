// Stakes/mode inference (§ A1.2, § B13.1) and Jo's short inputs (§ B5, § B3 item 5): every
// applied word is a ledger row with author jo, channel surface; unrecognised text is left alone; a
// bare answer word with more than one target is ambiguous; a numbered batch is checked whole
// against the session numbering (MIGRATION.md § M7 follow-ups item 1); the review round limit's
// words and answers (PLAN wl-mupu0sx2o046io D9, D10); `cancel-slice`, `supersede` and the plan-first
// approve receipt (PLAN wl-mv5i3lulwwbbi8 D1, D2, D4).
import { describe, expect, test } from "bun:test";
import { handSpawnBody, reviewParkBody } from "../../classifier/src/lab";
import { reviewStopOn } from "../../classifier/src/review-stop";
import { countRounds, effectiveRoundLimit, type Findings, reviewLimitBody, reviewRoundBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { CEILING_OPTIONS } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { apply, type BatchResult, commandShaped, interpret, interpretBatch, interpretPaste, maxWords, parseBatch, type PasteResult, TEST_PR_MAX, workloadsInView } from "../src/input";
import { boundPrs, controlEntries, holdersOf, planFirst, planFirstBody, verdictOf } from "../src/launch";
import { pendingBlock, pendingItems, pendingShaped, pendingWaits } from "../src/pending";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import { Numbering } from "../src/numbering";
import { inferMode, inferStakes, saidPlanIt } from "../src/stakes";
import { promptResolvedBody, promptWaitBody } from "../src/signals";
import { testRequestedBody } from "../src/test-run";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, nameWork, raiseAsked, tempLedger, workloadWithSlice } from "./helpers";

/**
 * A plan-first workload held by lane-a whose plan slice raised the plan question (decision 15), with
 * lane-a's `plan-question:` entry written in the same transaction, as lane_raise_question writes it
 * (PLAN wl-muq22rnjcfrrpc D9 part two): the entry counts only from a holder of the workload.
 */
function planQuestion(ledger: Ledger): { wl: string; sl: string; q: string } {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Plan the cut", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
	const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "plan", doneCondition: "plan approved", inputs: "brief" });
	const q = ledger.write(() => {
		const id = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "/tmp/plan.md", options: ["approve", "revise", "cancel"] });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${id}` });
		return id;
	});
	return { wl, sl, q };
}

/** The session numbering as the surface holds it: every current answerable line numbered. */
function numbered(ledger: Ledger, numbering = new Numbering()): Numbering {
	numbering.assign(errorLines(ledger));
	return numbering;
}

/** Apply an accepted batch the way the surface does: one transaction, one row per answer. */
function applyBatch(ledger: Ledger, r: BatchResult | null): string[] {
	if (!r?.ok) throw new Error(`not an accepted batch: ${JSON.stringify(r)}`);
	return ledger.write(() => r.items.map((i) => apply(ledger, i.cmd)));
}

const allInstructions = (ledger: Ledger) => ledger.inFlight().flatMap((w) => ledger.instructions(w.workload.id));

describe("stakes and mode inference", () => {
	test("default normal; production from words, protected branch or a reserved target; throwaway from words or a scratch repo", () => {
		expect(inferStakes({ said: "fix the header offset" })).toMatchObject({ value: "normal" });
		expect(inferStakes({ said: "hotfix the checkout page" })).toMatchObject({ value: "production", reason: 'you said "hotfix"' });
		expect(inferStakes({ said: "tidy", branch: "main" })).toMatchObject({ value: "production", reason: "target branch main is protected" });
		expect(inferStakes({ said: "tidy", reservedTarget: true }).value).toBe("production");
		expect(inferStakes({ said: "spike a prototype of the parser" }).value).toBe("throwaway");
		expect(inferStakes({ said: "measure it", repo: "/Users/jo/agent-scratch/x" })).toMatchObject({ value: "throwaway" });
		// production wins over throwaway when both match
		expect(inferStakes({ said: "throwaway experiment against production" }).value).toBe("production");
	});

	test("mode is autonomous unless Jo asked to steer; 'plan it' alone is plan-first, not steering (decision 15)", () => {
		expect(inferMode("fix the feed")).toMatchObject({ value: "autonomous" });
		expect(inferMode("plan it with me")).toMatchObject({ value: "user-driven", reason: 'you said "with me"' });
		expect(inferMode("plan it")).toMatchObject({ value: "autonomous" });
		expect(saidPlanIt("plan it")).toBe(true);
		expect(saidPlanIt("fix the feed")).toBe(false);
		expect(inferMode("walk me through the migration").value).toBe("user-driven");
	});
});

describe("one-word inputs", () => {
	test("a stakes word flips the only workload in view and records the instruction; a mode word flips mode", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const s = interpret(ledger, "production")!;
		expect(s).toMatchObject({ kind: "stakes", workloadId: wl, stakes: "production" });
		expect(apply(ledger, s)).toMatch(/^stakes on wl-.* → production/);
		expect(ledger.workload(wl)!.stakes).toBe("production");
		const m = interpret(ledger, "user-driven")!;
		expect(apply(ledger, m)).toContain("→ user-driven");
		expect(ledger.workload(wl)!.mode).toBe("user-driven");
		const rows = ledger.instructions(wl);
		expect(rows.map((r) => [r.kind, r.body, r.author, r.channel])).toEqual([
			["instruction", "stakes: production", "jo", "surface"],
			["mode-flip", "user-driven", "jo", "surface"],
		]);
	});

	test("with two workloads in view a bare stakes or mode word is ambiguous, the workloads as candidates; a second word picks the workload", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const a = workloadWithSlice(ledger).wl;
		c.plusHours(0.01); // b opens after a, so the view order (oldest first) is fixed
		const b = workloadWithSlice(ledger, { brief: "second" }).wl;
		const candidates = [{ kind: "workload", workloadId: a }, { kind: "workload", workloadId: b }];
		expect(interpret(ledger, "throwaway")).toEqual({ kind: "ambiguous", word: "throwaway", candidates });
		expect(interpret(ledger, "User-Driven")).toEqual({ kind: "ambiguous", word: "user-driven", candidates });
		expect(interpret(ledger, `throwaway ${b}`)).toEqual({ kind: "stakes", workloadId: b, stakes: "throwaway" });
		expect(interpret(ledger, `user-driven ${a}`)).toEqual({ kind: "mode", workloadId: a, mode: "user-driven" });
		expect(interpret(ledger, "throwaway wl-nope")).toBeNull();
		expect(() => apply(ledger, interpret(ledger, "throwaway")!)).toThrow("refused, never applied");
		expect(ledger.instructions(a)).toEqual([]);
		expect(ledger.instructions(b)).toEqual([]);
	});

	test("an option word answers the oldest open question (case-insensitive) and the slice resumes; withdraw replans", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Token name?", options: ["Header-Offset", "nav-offset"] });
		expect(interpret(ledger, "nope")).toBeNull();
		const a = interpret(ledger, "header-offset")!;
		expect(a).toMatchObject({ kind: "answer", questionId: q, answer: "Header-Offset" });
		const receipt = apply(ledger, a);
		expect(receipt).toContain(`slice ${sl} is open`);
		expect(ledger.question(q)!.state).toBe("answered");
		expect(ledger.slice(sl)!.state).toBe("open");
		const q2 = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Really?", options: ["yes", "no"] });
		const w = interpret(ledger, "withdraw")!;
		expect(w).toMatchObject({ kind: "withdraw", questionId: q2, then: "replan" });
		expect(apply(ledger, w)).toContain("replanned, not executed");
		expect(ledger.question(q2)!.state).toBe("withdrawn");
		expect(ledger.slice(sl)!.state).toBe("open");
		const last = ledger.instructions(wl).at(-1)!;
		expect(last).toMatchObject({ kind: "withdrawal", disposition: "replan", author: "jo", channel: "surface" });
	});

	test("approve / deny with one reserved request waiting name it; with two the bare word is ambiguous and the id picks", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		expect(interpret(ledger, "approve")).toBeNull();
		const e1 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		expect(interpret(ledger, "approve")).toMatchObject({ kind: "reserved", entryId: e1, verdict: "approve" });
		const e2 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy" });
		expect(interpret(ledger, "deny")).toEqual({
			kind: "ambiguous",
			word: "deny",
			candidates: [
				{ kind: "reserved", workloadId: wl, rowId: e1 },
				{ kind: "reserved", workloadId: wl, rowId: e2 },
			],
		});
		const d = interpret(ledger, `deny ${e2}`)!;
		expect(apply(ledger, d)).toContain(`denied reserved request ${e2}`);
		expect(ledger.instructions(wl).at(-1)!.body).toBe(`deny ${e2}`);
		// one left waiting: the bare word names it again
		expect(interpret(ledger, "deny")).toMatchObject({ kind: "reserved", entryId: e1 });
	});

	test("approve / deny of a reserved request whose lane stopped is refused with its state, never prose; a waiting one still applies", () => {
		const c = clock("2026-10-09T07:26:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-a", leaseMs: null }).won).toBe(true);
		c.at("2026-10-09T07:49:51.000Z");
		const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		c.at("2026-10-09T08:47:31.000Z");
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		c.at("2026-10-11T22:30:00.000Z");
		expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-b", leaseMs: null }).won).toBe(true);
		const receipt = `${en} is not waiting: lane-stopped (lane lane-a stopped 2026-10-09T08:47:31.000Z); nothing to deny`;
		const refused = interpret(ledger, `deny ${en}`);
		expect(refused).toEqual({ kind: "refused", why: receipt });
		expect(interpret(ledger, `approve ${en}`)).toEqual({ kind: "refused", why: receipt.replace("nothing to deny", "nothing to approve") });
		expect(() => apply(ledger, refused!)).toThrow("refused, never applied");
		expect(ledger.instructions(wl)).toEqual([]);
		// in a paste the same line refuses the paste with the same reason
		const paste = interpretPaste(ledger, numbered(ledger), `deny ${en}\nthen carry on`);
		expect(paste).toEqual({
			ok: false,
			refused: [{ line: 1, text: `deny ${en}`, why: [receipt] }],
			held: [{ kind: "instruction", from: 2, to: 2, text: "then carry on" }],
		});
		// a decided request names its decision
		const waiting = ledger.recordEntry({ by: "lane-b", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy" });
		const d = interpret(ledger, `deny ${waiting}`)!;
		expect(d).toEqual({ kind: "reserved", workloadId: wl, entryId: waiting, verdict: "deny" });
		expect(apply(ledger, d)).toContain(`denied reserved request ${waiting}`);
		expect(interpret(ledger, `approve ${waiting}`)).toEqual({ kind: "refused", why: `${waiting} is not waiting: denied 2026-10-11T22:30:00.000Z; nothing to approve` });
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual([`deny ${waiting}`]);
	});

	test("a request on a closed workload is looked up by id and refused with its state and the close, never prose", () => {
		const c = clock("2026-10-09T07:26:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-a", leaseMs: null }).won).toBe(true);
		c.at("2026-10-09T07:49:51.000Z");
		const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		c.at("2026-10-09T08:47:31.000Z");
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		c.at("2026-10-09T09:00:00.000Z");
		ledger.completeSlice(sl, { by: "lane-a", artifact: "done" });
		ledger.closeWorkload(wl, { by: SURFACE_BY });
		expect(workloadsInView(ledger)).toEqual([]);
		const receipt = `${en} is not waiting: lane-stopped (lane lane-a stopped 2026-10-09T08:47:31.000Z) (workload closed 2026-10-09T09:00:00.000Z); nothing to deny`;
		expect(interpret(ledger, `deny ${en}`)).toEqual({ kind: "refused", why: receipt });
		expect(interpretPaste(ledger, numbered(ledger), `deny ${en}\nthen carry on`)).toEqual({
			ok: false,
			refused: [{ line: 1, text: `deny ${en}`, why: [receipt] }],
			held: [{ kind: "instruction", from: 2, to: 2, text: "then carry on" }],
		});
		// a request still waiting when its workload closed (an unbound session's, never a holder) reads the close alone
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "Other", stakes: "normal", mode: "autonomous" });
		const stray = ledger.recordEntry({ by: "lane-4242", workloadId: other, kind: "reserved-request", body: "deploy" });
		c.at("2026-10-09T10:00:00.000Z");
		ledger.closeWorkload(other, { by: SURFACE_BY });
		expect(interpret(ledger, `approve ${stray}`)).toEqual({ kind: "refused", why: `${stray} is not waiting: workload closed 2026-10-09T10:00:00.000Z; nothing to approve` });
		expect(ledger.instructions(wl)).toEqual([]);
		expect(ledger.instructions(other)).toEqual([]);
	});

	test("the 21:34Z incident: bare approve with a reserved request and a plan question waiting is ambiguous, never the reserved request", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const e1 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		const p = planQuestion(ledger);
		const cmd = interpret(ledger, "approve")!;
		expect(cmd).toEqual({
			kind: "ambiguous",
			word: "approve",
			candidates: [
				{ kind: "reserved", workloadId: wl, rowId: e1 },
				{ kind: "question", workloadId: p.wl, rowId: p.q },
			],
		});
		expect(() => apply(ledger, cmd)).toThrow("refused, never applied");
		expect(allInstructions(ledger)).toHaveLength(0);
		// the two-word forms still pick
		expect(interpret(ledger, `approve ${e1}`)).toMatchObject({ kind: "reserved", entryId: e1 });
		expect(interpret(ledger, `approve ${p.q}`)).toMatchObject({ kind: "answer", questionId: p.q, answer: "approve" });
	});

	test("an option word or withdraw that fits two open questions is ambiguous; the question id picks", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const q1 = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Use the token?", options: ["accept", "reject"] });
		const q2 = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Rename it?", options: ["Accept", "skip"] });
		// both raised in the same millisecond: the open-question order between them is the ledger's, not the test's
		for (const word of ["accept", "withdraw"]) {
			const cmd = interpret(ledger, word);
			if (cmd?.kind !== "ambiguous") throw new Error(`${word}: expected ambiguous, got ${JSON.stringify(cmd)}`);
			expect(cmd.word).toBe(word);
			expect(cmd.candidates.map((t) => [t.kind, t.workloadId, t.kind === "workload" ? null : t.rowId]).sort()).toEqual([["question", wl, q1], ["question", wl, q2]].sort());
		}
		expect(interpret(ledger, `accept ${q2}`)).toMatchObject({ kind: "answer", questionId: q2, answer: "Accept" });
		// a word only one question offers has one target and applies
		expect(interpret(ledger, "skip")).toMatchObject({ kind: "answer", questionId: q2, answer: "skip" });
		expect(interpret(ledger, `withdraw ${q1}`)).toMatchObject({ kind: "withdraw", questionId: q1 });
	});

	test("ordinary sentences are not commands", () => {
		const { ledger } = tempLedger();
		workloadWithSlice(ledger);
		expect(interpret(ledger, "please make it production grade")).toBeNull();
		expect(interpret(ledger, "")).toBeNull();
	});
});

describe("numbered batches", () => {
	/** Two reserved requests waiting on one workload, numbered #1 and #2. */
	function reservedPair() {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const e1 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		const e2 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy" });
		return { ledger, wl, sl, e1, e2, numbering: numbered(ledger) };
	}

	test("`1 approve, 2 deny`, one per line, `#1`/`q2:`/`1)` forms: each answer is its own instruction row", () => {
		for (const text of ["1 approve, 2 deny", "1 approve\n2 deny", "#1 approve\nq2: deny", " 1) Approve,\n\n Q2. DENY ,"]) {
			const { ledger, wl, e1, e2, numbering } = reservedPair();
			const r = interpretBatch(ledger, numbering, text);
			expect(r).toMatchObject({ ok: true, items: [{ n: 1 }, { n: 2 }] });
			const receipts = applyBatch(ledger, r);
			expect(receipts).toEqual([expect.stringContaining(`approved reserved request ${e1}`), expect.stringContaining(`denied reserved request ${e2}`)]);
			expect(ledger.instructions(wl).map((i) => [i.kind, i.body, i.author, i.channel])).toEqual([
				["instruction", `approve ${e1}`, "jo", "surface"],
				["instruction", `deny ${e2}`, "jo", "surface"],
			]);
			expect(errorLines(ledger).filter((l) => l.kind === "reserved")).toEqual([]);
		}
	});

	test("a mixed batch: a reserved request and the plan question; plan approve writes plan: approved", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const e1 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		const p = planQuestion(ledger);
		const numbering = numbered(ledger);
		expect(numbering.numberOf(e1)).toBe(1);
		expect(numbering.numberOf(p.q)).toBe(2);
		const r = interpretBatch(ledger, numbering, "1 deny, 2 APPROVE");
		expect(r).toEqual({
			ok: true,
			items: [
				{ n: 1, cmd: { kind: "reserved", workloadId: wl, entryId: e1, verdict: "deny" } },
				{ n: 2, cmd: { kind: "answer", workloadId: p.wl, questionId: p.q, answer: "approve" } },
			],
		});
		expect(applyBatch(ledger, r)[1]).toContain("plan approved");
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual([`deny ${e1}`]);
		expect(ledger.question(p.q)!.state).toBe("answered");
		const entries = ledger.entries(p.wl);
		expect(entries.some((e) => e.body.startsWith("plan: approved"))).toBe(true);
		expect(planFirst(controlEntries(entries, holdersOf(entries, ledger.workload(p.wl)!.holder)))).toBeNull();
	});

	test("withdraw on a numbered question withdraws it, then replan", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["left", "right"] });
		const r = interpretBatch(ledger, numbered(ledger), "1 withdraw");
		expect(r).toEqual({ ok: true, items: [{ n: 1, cmd: { kind: "withdraw", workloadId: wl, questionId: q, then: "replan" } }] });
		applyBatch(ledger, r);
		expect(ledger.question(q)!.state).toBe("withdrawn");
	});

	test("one bad piece refuses the whole batch with one line per piece: unknown number, wrong word, duplicate", () => {
		const { ledger, numbering } = reservedPair();
		expect(interpretBatch(ledger, numbering, "1 approve, 2 maybe, 7 deny")).toEqual({
			ok: false,
			lines: ["#1 ok, not applied", "#2 takes: approve / deny", "#7 is not on the needs-you list"],
		});
		expect(interpretBatch(ledger, numbering, "1 approve\n2 deny\n1 deny")).toEqual({
			ok: false,
			lines: ["#1 appears more than once in this batch", "#2 ok, not applied", "#1 appears more than once in this batch"],
		});
		expect(allInstructions(ledger)).toHaveLength(0);
	});

	test("a stale number is refused: its row was answered since it was numbered; a question takes its options or withdraw", () => {
		const { ledger, wl, sl, e1, numbering } = reservedPair();
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["Left", "right"] });
		numbered(ledger, numbering);
		expect(numbering.numberOf(q)).toBe(3);
		apply(ledger, interpret(ledger, `approve ${e1}`)!);
		expect(interpretBatch(ledger, numbering, "1 deny, 3 up")).toEqual({
			ok: false,
			lines: [`#1 (${e1}) is no longer waiting`, "#3 takes: Left / right / withdraw"],
		});
		apply(ledger, interpret(ledger, `right ${q}`)!);
		expect(interpretBatch(ledger, numbering, "3 left")).toEqual({ ok: false, lines: [`#3 (${q}) is no longer waiting`] });
		// a fresh assign does not hand #1 or #3 to another row
		const e3 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "tag" });
		numbered(ledger, numbering);
		expect(numbering.numberOf(e3)).toBe(4);
		expect(interpretBatch(ledger, numbering, "1 approve")).toEqual({ ok: false, lines: [`#1 (${e1}) is no longer waiting`] });
	});

	test("prose is not a batch: every piece must be `<n> <word>`", () => {
		const { ledger, numbering } = reservedPair();
		expect(interpretBatch(ledger, numbering, "2 things to fix")).toBeNull();
		expect(interpretBatch(ledger, numbering, "1 approve, and then 2 deny")).toBeNull();
		expect(interpretBatch(ledger, numbering, "approve")).toBeNull();
		expect(interpretBatch(ledger, numbering, " , \n")).toBeNull();
		expect(interpretBatch(ledger, numbering, "1 approve")).toMatchObject({ ok: true, items: [{ n: 1 }] });
	});

	test("`ceiling 60 8` is the ceiling command, never a batch, even with numbered rows waiting", () => {
		const { ledger, wl, numbering } = reservedPair();
		expect(parseBatch("ceiling 60 8")).toBeNull();
		expect(interpretBatch(ledger, numbering, "ceiling 60 8")).toBeNull();
		expect(interpret(ledger, "ceiling 60 8")).toEqual({ kind: "ceiling", workloadId: wl, usd: 60, wallMin: 480 });
	});
});

describe("a paste of several lines (MIGRATION.md item 48)", () => {
	/** Two reserved requests (#1, #2) and a question (#3) on one workload, numbered. */
	function rows() {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const e1 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		const e2 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["left", "right"] });
		return { ledger, wl, sl, e1, e2, q, numbering: numbered(ledger) };
	}
	/** Apply an accepted paste the way the surface does: one transaction, in order, one row per command. */
	function applyPaste(ledger: Ledger, r: PasteResult | null): string[] {
		if (!r?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(r)}`);
		return ledger.write(() => r.items.flatMap((i) => (i.kind === "instruction" ? [] : i.kind === "batch" ? i.items.map((b) => apply(ledger, b.cmd)) : [apply(ledger, i.cmd)])));
	}

	test("commandShaped: a numbered piece or a line short enough for its word; `ceiling` runs to four words, `rounds` to three", () => {
		expect(commandShaped("approve")).toBe(true);
		expect(commandShaped("production wl-x")).toBe(true);
		expect(commandShaped("1 approve, 2 deny")).toBe(true);
		expect(commandShaped("ceiling $120 8h wl-x")).toBe(true);
		expect(commandShaped("rounds 5 wl-x")).toBe(true);
		expect(commandShaped("rounds 5 wl-x please")).toBe(false);
		expect(commandShaped("relaunch the classifier fix now")).toBe(false);
		expect(commandShaped("")).toBe(false);
	});

	test("two commands on two lines are both read and applied in order: stakes then an exact ceiling on the same workload", () => {
		const { ledger, wl, numbering } = rows();
		const r = interpretPaste(ledger, numbering, `production ${wl}\nceiling 120 ${wl}`);
		expect(r).toEqual({
			ok: true,
			items: [
				{ line: 1, text: `production ${wl}`, kind: "command", cmd: { kind: "stakes", workloadId: wl, stakes: "production" } },
				{ line: 2, text: `ceiling 120 ${wl}`, kind: "command", cmd: { kind: "ceiling", workloadId: wl, usd: 120, wallMin: null } },
			],
		});
		const receipts = applyPaste(ledger, r);
		expect(receipts[0]).toMatch(/^stakes on wl-.* → production/);
		expect(receipts[1]).toContain(`ceiling on ${wl} → $120 / 12h`); // the stakes word's 12 h wall, then Jo's exact figure
		expect(ledger.workload(wl)!.stakes).toBe("production");
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual(["stakes: production", "ceiling: 120 12"]);
	});

	test("a numbered batch line keeps its comma form; a trailing plain-words line is one instruction for the orchestrator (item 48's example)", () => {
		const { ledger, wl, e1, e2, numbering } = rows();
		const r = interpretPaste(ledger, numbering, "1 approve, 2 deny\nRelaunch the classifier fix now");
		expect(r).toEqual({
			ok: true,
			items: [
				{
					line: 1, text: "1 approve, 2 deny", kind: "batch",
					items: [
						{ n: 1, cmd: { kind: "reserved", workloadId: wl, entryId: e1, verdict: "approve" } },
						{ n: 2, cmd: { kind: "reserved", workloadId: wl, entryId: e2, verdict: "deny" } },
					],
				},
				{ kind: "instruction", from: 2, to: 2, text: "Relaunch the classifier fix now" },
			],
		});
		applyPaste(ledger, r);
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual([`approve ${e1}`, `deny ${e2}`]);
	});

	test("consecutive plain-words lines are one instruction, blank lines included; a command line between two runs separates two; a short line that is no command is plain words", () => {
		const { ledger, wl, numbering } = rows();
		const text = ["3 left", "Relaunch the classifier fix now.", "", "Use the same plan, and tell me when the review is back.", `production ${wl}`, "fix it", "approve please"].join("\n");
		const r = interpretPaste(ledger, numbering, text);
		if (!r?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(r)}`);
		expect(r.items.map((i) => (i.kind === "instruction" ? [i.from, i.to, i.text] : [i.line, i.kind]))).toEqual([
			[1, "batch"],
			[2, 4, "Relaunch the classifier fix now.\n\nUse the same plan, and tell me when the review is back."],
			[5, "command"],
			[6, 7, "fix it\napprove please"],
		]);
	});

	test("a command naming an id that does not resolve refuses the whole paste on its line, never as prose (Codex review of PR #30, B1)", () => {
		const { ledger, wl, sl, q, numbering } = rows();
		const c = ledger.openWorkload({ by: SURFACE_BY, brief: "Closed", stakes: "normal", mode: "autonomous" });
		ledger.closeWorkload(c, { by: SURFACE_BY });
		const cases: [string, string][] = [
			["approve en-nope", "no entry en-nope on the needs-you list"],
			["deny en-nope", "no entry en-nope on the needs-you list"],
			["left q-nope", "q-nope is not an open question"],
			["withdraw q-nope", "q-nope is not an open question"],
			["production wl-nope", "wl-nope is not an open workload"],
			["user-driven wl-nope", "wl-nope is not an open workload"],
			[`autonomous ${c}`, `${c} is not an open workload`],
			["ceiling 120 wl-nope", "wl-nope is not an open workload"],
			["rounds 5 wl-nope", "wl-nope is not an open workload"],
			["stop-reviews sl-nope", "sl-nope is not a slice of an open workload"],
			["left sl-nope", "sl-nope is not a slice of an open workload"],
			// the id resolves, the line still is no command: named with what the row takes
			[`approve ${q}`, `"approve ${q}" is not a command the surface knows (${q} takes: left / right / withdraw)`],
			[`approve ${wl}`, `"approve ${wl}" is not a command the surface knows`],
			[`left ${sl}`, `"left ${sl}" is not a command the surface knows`],
		];
		for (const [line, why] of cases) {
			const r = interpretPaste(ledger, numbering, `production ${wl}\n${line}`);
			expect(r).toEqual({ ok: false, refused: [{ line: 1, text: `production ${wl}`, why: null }, { line: 2, text: line, why: [why] }], held: [] });
		}
		// a word no open question offers is no command word: with an id it is still prose, as `cancel` is here
		expect(interpretPaste(ledger, numbering, `production ${wl}\ncancel sl-nope`)).toMatchObject({ ok: true, items: [{ line: 1 }, { kind: "instruction", from: 2, to: 2, text: "cancel sl-nope" }] });
		// an answered line before the bad one is refused with it (Probe A `answer-then-invalid`)
		expect(interpretPaste(ledger, numbering, `left ${q}\napprove en-nope`)).toEqual({
			ok: false,
			refused: [{ line: 1, text: `left ${q}`, why: null }, { line: 2, text: "approve en-nope", why: ["no entry en-nope on the needs-you list"] }],
			held: [],
		});
		// the single-line path is untouched: alone, the same line passes through
		expect(interpret(ledger, "approve en-nope")).toBeNull();
		expect(ledger.workload(wl)!.stakes).toBe("normal");
		expect(ledger.question(q)!.state).toBe("open");
		expect(allInstructions(ledger)).toHaveLength(0);
	});

	test("a bare id prefix after a command word (`production wl-`, a paste cut short) is an id that does not resolve, never the sole workload or prose (Codex review of PR #30, round 2)", () => {
		const { ledger, wl, sl, q, numbering } = rows();
		// a second question offering `cancel`, so `cancel sl-` opens with a command word
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "/tmp/plan.md", options: ["approve", "revise", "cancel"] });
		const cases: [string, string][] = [
			["production wl-", "wl- is not an open workload"],
			["autonomous wl-", "wl- is not an open workload"],
			["ceiling 120 wl-", "wl- is not an open workload"],
			["approve en-", "no entry en- on the needs-you list"],
			["left q-", "q- is not an open question"],
			["cancel sl-", "sl- is not a slice of an open workload"],
		];
		for (const [line, why] of cases) {
			expect(interpretPaste(ledger, numbering, `left ${q}\n${line}`)).toEqual({
				ok: false,
				refused: [{ line: 1, text: `left ${q}`, why: null }, { line: 2, text: line, why: [why] }],
				held: [],
			});
		}
		// the sole workload in view is not taken for a `wl-` the line supplied
		expect(interpretPaste(ledger, numbering, "production wl-\nUse the same plan.")).toMatchObject({ ok: false, refused: [{ line: 1, why: ["wl- is not an open workload"] }], held: [{ from: 2, to: 2 }] });
		expect(ledger.workload(wl)!.stakes).toBe("normal");
		expect(ledger.question(q)!.state).toBe("open");
	});

	test("in a paste a stakes or mode word takes only a wl- id: `production ready` and `autonomous now` are prose (Codex review of PR #30, B2)", () => {
		const { ledger, wl, numbering } = rows();
		expect(interpretPaste(ledger, numbering, "The build is\nproduction ready")).toBeNull();
		expect(interpretPaste(ledger, numbering, "go\nautonomous now\nuser-driven please")).toBeNull();
		const r = interpretPaste(ledger, numbering, `normal ${wl}\nproduction ready`);
		expect(r).toEqual({
			ok: true,
			items: [{ line: 1, text: `normal ${wl}`, kind: "command", cmd: { kind: "stakes", workloadId: wl, stakes: "normal" } }, { kind: "instruction", from: 2, to: 2, text: "production ready" }],
		});
		// bare, and with the id, the word is the command
		expect(interpretPaste(ledger, numbering, "production\nthen go")).toMatchObject({ ok: true, items: [{ line: 1, cmd: { kind: "stakes", workloadId: wl } }, { kind: "instruction" }] });
		expect(interpretPaste(ledger, numbering, `production ${wl}\nthen go`)).toMatchObject({ ok: true, items: [{ line: 1, cmd: { kind: "stakes", workloadId: wl } }, { kind: "instruction" }] });
		// the single-line path is untouched (its permissive second word is flagged to Jo separately)
		expect(interpret(ledger, "production ready")).toEqual({ kind: "stakes", workloadId: wl, stakes: "production" });
		expect(ledger.workload(wl)!.stakes).toBe("normal");
	});

	test("a question or reserved request answered twice across lines, in any form, is refused on the later line (Codex review of PR #30, S1)", () => {
		const { ledger, wl, e1, q, numbering } = rows();
		expect(numbering.numberOf(q)).toBe(3);
		expect(interpretPaste(ledger, numbering, `left ${q}\nright ${q}`)).toEqual({
			ok: false,
			refused: [{ line: 1, text: `left ${q}`, why: null }, { line: 2, text: `right ${q}`, why: [`${q} is already answered on line 1; once per row`] }],
			held: [],
		});
		expect(interpretPaste(ledger, numbering, `3 left\nright ${q}`)).toEqual({
			ok: false,
			refused: [{ line: 1, text: "3 left", why: null }, { line: 2, text: `right ${q}`, why: [`${q} is already answered on line 1 (#3); once per row`] }],
			held: [],
		});
		expect(interpretPaste(ledger, numbering, `withdraw ${q}\n1 approve, 3 left`)).toEqual({
			ok: false,
			refused: [{ line: 1, text: `withdraw ${q}`, why: null }, { line: 2, text: "1 approve, 3 left", why: [`#3: ${q} is already answered on line 1; once per row`] }],
			held: [],
		});
		expect(interpretPaste(ledger, numbering, `approve ${e1}\ndeny ${e1}`)).toMatchObject({
			ok: false,
			refused: [{ line: 1, why: null }, { line: 2, why: [`${e1} is already decided on line 1; once per row`] }],
		});
		// two stakes words on one workload are not a duplicate: the later wins, as two messages would
		expect(interpretPaste(ledger, numbering, `production ${wl}\nnormal ${wl}`)).toMatchObject({ ok: true });
		expect(ledger.question(q)!.state).toBe("open");
		expect(allInstructions(ledger)).toHaveLength(0);
	});

	test("a paste with no command line is prose: null, nothing read as a command", () => {
		const { ledger, numbering } = rows();
		expect(interpretPaste(ledger, numbering, "new workload, normal stakes:\nmove the header offset into a token\nthen drop the old class")).toBeNull();
		expect(interpretPaste(ledger, numbering, "fix it\nplease")).toBeNull();
	});

	test("one bad line refuses the whole paste: the verdict names each command line by number and text, nothing is applied", () => {
		const { ledger, wl, e1, numbering } = rows();
		const bad = interpretPaste(ledger, numbering, `production ${wl}\n9 deny\nthen relaunch it`);
		expect(bad).toEqual({
			ok: false,
			refused: [
				{ line: 1, text: `production ${wl}`, why: null },
				{ line: 2, text: "9 deny", why: ["#9 is not on the needs-you list"] },
			],
			held: [{ kind: "instruction", from: 3, to: 3, text: "then relaunch it" }],
		});
		// a bare word fitting several rows: the ambiguous command is the verdict, for the caller's "which one?"
		const which = interpretPaste(ledger, numbering, `approve\nproduction ${wl}`);
		expect(which).toMatchObject({ ok: false, refused: [{ line: 1, text: "approve", why: { kind: "ambiguous", word: "approve" } }, { line: 2, why: null }], held: [] });
		// a number given on two lines is caught across the paste, as in one batch
		expect(interpretPaste(ledger, numbering, `1 approve\nproduction ${wl}\n1 deny`)).toMatchObject({
			ok: false,
			refused: [{ line: 1, why: ["#1 appears more than once in this batch"] }, { line: 2, why: null }, { line: 3, why: ["#1 appears more than once in this batch"] }],
		});
		expect(ledger.workload(wl)!.stakes).toBe("normal");
		expect(allInstructions(ledger)).toHaveLength(0);
		expect(errorLines(ledger).some((l) => l.rowId === e1)).toBe(true);
	});

	describe("answer lines of the pending block (PLAN wl-mv5msri070p0qo D2)", () => {
		/** `rows()` plus a plan-shaped question offering approve / revise / cancel, and a question no line answers. */
		function block() {
			const r = rows();
			const p = r.ledger.raiseQuestion({ by: "lane-a", workloadId: r.wl, sliceId: r.sl, body: "/tmp/plan.md", options: ["approve", "revise", "cancel"] });
			const other = r.ledger.raiseQuestion({ by: "lane-a", workloadId: r.wl, sliceId: r.sl, body: "Ship it?", options: ["yes", "no"] });
			return { ...r, p, other, numbering: numbered(r.ledger) };
		}
		/** A pending-block tail: two spaces, `#`, the subject, the recommendation note, the other options. */
		const tail = (subject: string, also = "right / withdraw") => `  # ${subject} — on fix the feed header offset · no recommendation recorded · also: ${also}`;

		test("a paste of tailed lines, one per row, applies exactly those answers in one transaction", () => {
			const { ledger, wl, e1, e2, q, p, other, numbering } = block();
			const lines = [
				`approve ${e1}  # reserved action: push main — on fix the feed header offset · no recommendation recorded · also: deny`,
				`deny ${e2}  # reserved action: deploy — on fix the feed header offset · no recommendation recorded · also: approve`,
				`approve ${p}  # plan for x — on y · recommended (review: approve) · also: revise / cancel / withdraw`,
				`left ${q}${tail("Which?")}`,
			];
			const r = interpretPaste(ledger, numbering, lines.join("\n"));
			expect(r).toEqual({
				ok: true,
				items: [
					{ line: 1, text: `approve ${e1}`, kind: "command", cmd: { kind: "reserved", workloadId: wl, entryId: e1, verdict: "approve" } },
					{ line: 2, text: `deny ${e2}`, kind: "command", cmd: { kind: "reserved", workloadId: wl, entryId: e2, verdict: "deny" } },
					{ line: 3, text: `approve ${p}`, kind: "command", cmd: { kind: "answer", workloadId: wl, questionId: p, answer: "approve" } },
					{ line: 4, text: `left ${q}`, kind: "command", cmd: { kind: "answer", workloadId: wl, questionId: q, answer: "left" } },
				],
			});
			applyPaste(ledger, r);
			expect(ledger.instructions(wl).map((i) => [i.question_id, i.body])).toEqual([
				[null, `approve ${e1}`],
				[null, `deny ${e2}`],
				[p, "approve"],
				[q, "left"],
			]);
			expect([ledger.question(p)!.state, ledger.question(q)!.state, ledger.question(other)!.state]).toEqual(["answered", "answered", "open"]);
			expect(errorLines(ledger).map((l) => l.rowId)).toEqual([other]);
		});

		test("one tailed line applies alone: as a one-line paste, and as a single input", () => {
			const { ledger, wl, q, numbering } = block();
			const line = `left ${q}${tail("Which?")}`;
			expect(interpretPaste(ledger, numbering, line)).toEqual({
				ok: true,
				items: [{ line: 1, text: `left ${q}`, kind: "command", cmd: { kind: "answer", workloadId: wl, questionId: q, answer: "left" } }],
			});
			// the single-input path (surface-input.ts): commandShaped gates the ledger read, a batch is tried, then interpret
			expect(commandShaped(line)).toBe(true);
			expect(interpretBatch(ledger, numbering, line)).toBeNull();
			const cmd = interpret(ledger, line)!;
			expect(cmd).toEqual({ kind: "answer", workloadId: wl, questionId: q, answer: "left" });
			expect(ledger.write(() => apply(ledger, cmd))).toContain(`answered ${q} with "left"`);
			expect(ledger.question(q)!.state).toBe("answered");
		});

		test("a plan question's command pasted with its path line beneath, or the block with that command deleted: no path line is Jo's words (merge-train review of #106, round 3)", () => {
			const { ledger } = tempLedger();
			const p = planQuestion(ledger);
			const other = ledger.raiseQuestion({ by: "lane-a", workloadId: p.wl, sliceId: p.sl, body: "Ship it?", options: ["yes", "no"] });
			const numbering = numbered(ledger);
			const whole = pendingBlock(pendingItems(ledger), pendingWaits(ledger)).text.split("\n");
			const answer = `approve ${p.q}`;
			const path = `  plan for ${p.q}: /tmp/plan.md`;
			expect(whole[whole.indexOf(answer) + 1]).toBe(path);
			const pair = interpretPaste(ledger, numbering, `${answer}\n${path}`);
			if (!pair?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(pair)}`);
			expect(pair.items).toEqual([{ line: 1, text: answer, kind: "command", cmd: { kind: "answer", workloadId: p.wl, questionId: p.q, answer: "approve" } }]);
			const editedLines = whole.filter((l) => l !== answer);
			const edited = interpretPaste(ledger, numbering, editedLines.join("\n"));
			if (!edited?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(edited)}`);
			// the 1-based line of the other row's command in the paste as edited, whichever order pending lists the two rows in
			expect(edited.items).toEqual([{ line: editedLines.indexOf(`yes ${other}`) + 1, text: `yes ${other}`, kind: "command", cmd: { kind: "answer", workloadId: p.wl, questionId: other, answer: "yes" } }]);
			// beneath another row's command a path line is Jo's: an instruction
			const moved = interpretPaste(ledger, numbering, `yes ${other}\n${path}`);
			expect(moved).toMatchObject({ ok: true, items: [{ line: 1, kind: "command" }, { kind: "instruction", from: 2, to: 2, text: path.trim() }] });
		});

		test("command / prose / tailed command / prose: two instructions, neither holding a tail", () => {
			const { ledger, wl, q, numbering } = block();
			const text = [`production ${wl}`, "Relaunch the classifier fix now.", `left ${q}${tail("Which?")}`, "Then tell me when the review is back."].join("\n");
			const r = interpretPaste(ledger, numbering, text);
			if (!r?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(r)}`);
			expect(r.items.map((i) => (i.kind === "instruction" ? [i.from, i.to, i.text] : [i.line, i.kind, i.text]))).toEqual([
				[1, "command", `production ${wl}`],
				[2, 2, "Relaunch the classifier fix now."],
				[3, "command", `left ${q}`],
				[4, 4, "Then tell me when the review is back."],
			]);
			expect(r.items.filter((i) => i.kind === "instruction").some((i) => i.text.includes("#"))).toBe(false);
		});

		test("only `<word> <id>` loses a tail: `fix # 3 now` and other `#` lines stay prose", () => {
			const { ledger, q, numbering } = block();
			for (const line of ["fix # 3 now", "fix it # now", `left ${q} please # now`, `# left ${q}`]) {
				expect(commandShaped(line)).toBe(false);
				expect(interpret(ledger, line)).toBeNull();
			}
			expect(interpretPaste(ledger, numbering, "fix # 3 now\nthen go")).toBeNull();
			const r = interpretPaste(ledger, numbering, `left ${q}\nfix # 3 now`);
			expect(r).toMatchObject({ ok: true, items: [{ line: 1, kind: "command" }, { kind: "instruction", from: 2, to: 2, text: "fix # 3 now" }] });
			expect(ledger.question(q)!.state).toBe("open");
		});

		describe("a pending block pasted back (PLAN wl-mv7gidggnlkem8)", () => {
			/** A described workload with a reserved request and an asked question, and an undescribed plan-first workload's plan question; numbered, and the block as /copy takes it. */
			function described() {
				const { ledger } = tempLedger();
				const { wl, sl } = workloadWithSlice(ledger, { name: "Feed header offset" });
				const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
				const q = raiseAsked(ledger, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["left", "right"], ask: "Which token name should replace the header offset?" });
				const p = planQuestion(ledger);
				return { ledger, wl, sl, en, q, p, numbering: numbered(ledger), copy: blockOf(ledger) };
			}
			const blockOf = (ledger: Ledger) => pendingBlock(pendingItems(ledger), pendingWaits(ledger)).text;
			/** The entry of `text` whose command names `id`: its field lines, the command, and a plan path line beneath. */
			function entryOf(text: string, id: string): string[] {
				const lines = text.split("\n");
				const end = lines.findIndex((l) => l.split(" ")[1] === id);
				let start = end;
				while (start > 0 && lines[start - 1]!.startsWith("# ")) start--;
				return lines.slice(start, end + (lines[end + 1]?.startsWith("  plan for ") ? 2 : 1));
			}
			const refused = { ok: false, kind: "refused", why: expect.stringContaining("run `pending` again"), held: [] };

			test("the block pasted whole applies every command; its heading, fence, fields, Metadata and plan lines are no instruction", () => {
				const { ledger, wl, en, q, p, numbering, copy } = described();
				const lines = copy.split("\n");
				const at = (l: string) => lines.indexOf(l) + 1;
				const r = interpretPaste(ledger, numbering, copy);
				expect(r).toEqual({
					ok: true,
					items: [
						{ line: at(`approve ${en}`), text: `approve ${en}`, kind: "command", cmd: { kind: "reserved", workloadId: wl, entryId: en, verdict: "approve" } },
						{ line: at(`left ${q}`), text: `left ${q}`, kind: "command", cmd: { kind: "answer", workloadId: wl, questionId: q, answer: "left" } },
						{ line: at(`approve ${p.q}`), text: `approve ${p.q}`, kind: "command", cmd: { kind: "answer", workloadId: p.wl, questionId: p.q, answer: "approve" } },
					],
				});
				// the block carries a Metadata line for the undescribed plan workload: generated, no instruction either
				expect(copy).toContain(`# Metadata: missing name for ${p.wl}`);
				// Jo's own words after the block: exactly they are the instruction
				const after = interpretPaste(ledger, numbering, `${copy}\nthen ship it`);
				if (!after?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(after)}`);
				expect(after.items.filter((i) => i.kind === "instruction")).toEqual([{ kind: "instruction", from: lines.length + 1, to: lines.length + 1, text: "then ship it" }]);
				applyPaste(ledger, r);
				expect([ledger.question(q)!.state, ledger.question(p.q)!.state]).toEqual(["answered", "answered"]);
			});

			test("one entry from any of its lines down to its command, or two entries: exactly those commands, nothing else", () => {
				const { ledger, wl, en, q, p, numbering, copy } = described();
				const one = (id: string, cmd: object) => {
					const entry = entryOf(copy, id);
					const command = entry.findLastIndex((l) => l.split(" ")[1] === id);
					for (let k = 0; k <= command; k++) {
						const r = interpretPaste(ledger, numbering, entry.slice(k).join("\n"));
						expect(r).toEqual({ ok: true, items: [{ line: command - k + 1, text: entry[command], kind: "command", cmd }] });
					}
				};
				one(q, { kind: "answer", workloadId: wl, questionId: q, answer: "left" });
				one(en, { kind: "reserved", workloadId: wl, entryId: en, verdict: "approve" });
				// the plan entry: its Metadata lines, its command and the path line beneath it
				expect(entryOf(copy, p.q).at(-1)).toBe(`  plan for ${p.q}: /tmp/plan.md`);
				one(p.q, { kind: "answer", workloadId: p.wl, questionId: p.q, answer: "approve" });
				// a changed first word picks another option, its fields still attached
				const right = entryOf(copy, q).map((l) => (l === `left ${q}` ? `right ${q}` : l));
				expect(interpretPaste(ledger, numbering, right.join("\n"))).toMatchObject({ ok: true, items: [{ kind: "command", cmd: { answer: "right" } }] });
				// two entries with a blank line between them
				const two = interpretPaste(ledger, numbering, [...entryOf(copy, en), "", ...entryOf(copy, q)].join("\n"));
				if (!two?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(two)}`);
				expect(two.items.map((i) => i.text)).toEqual([`approve ${en}`, `left ${q}`]);
			});

			test("the block with a command deleted leaves that row alone and applies the rest", () => {
				const { ledger, en, q, p, numbering, copy } = described();
				const r = interpretPaste(ledger, numbering, copy.split("\n").filter((l) => l !== `left ${q}`).join("\n"));
				if (!r?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(r)}`);
				expect(r.items.map((i) => i.text)).toEqual([`approve ${en}`, `approve ${p.q}`]);
			});

			test("fields attached to another row's command, an edited field, or a mouse-wrapped line refuse the whole paste", () => {
				const { ledger, en, q, numbering, copy } = described();
				const question = entryOf(copy, q)[1]!;
				expect(question).toStartWith("# Question: ");
				expect(interpretPaste(ledger, numbering, `${question}\napprove ${en}`)).toEqual({ ...refused, held: [], why: expect.stringContaining("line 1 looks like pending's own text") });
				const edited = copy.replace("# Default: left ", "# Default: right ");
				expect(edited).not.toBe(copy);
				expect(interpretPaste(ledger, numbering, edited)).toEqual(refused);
				const wrapped = copy.replace("# Request: push main", "# Request: push\nmain");
				expect(interpretPaste(ledger, numbering, wrapped)).toMatchObject({ ok: false, kind: "refused" });
			});

			test("a row arriving after the copy leaves the copy good; a row answered or a description filled since the copy refuses it", () => {
				const fresh = described();
				const added = raiseAsked(fresh.ledger, { by: "lane-a", workloadId: fresh.wl, sliceId: fresh.sl, body: "New?", options: ["yes", "no"], ask: "Should the new question wait?" });
				const r = interpretPaste(fresh.ledger, numbered(fresh.ledger, fresh.numbering), fresh.copy);
				if (!r?.ok) throw new Error(`not an accepted paste: ${JSON.stringify(r)}`);
				applyPaste(fresh.ledger, r);
				expect(fresh.ledger.question(added)!.state).toBe("open");
				expect([fresh.ledger.question(fresh.q)!.state, fresh.ledger.question(fresh.p.q)!.state]).toEqual(["answered", "answered"]);
				expect(fresh.ledger.instructions(fresh.wl)).toContainEqual(expect.objectContaining({ question_id: fresh.q, body: "left" }));
				expect(fresh.ledger.instructions(fresh.p.wl)).toContainEqual(expect.objectContaining({ question_id: fresh.p.q, body: "approve" }));

				const answered = described();
				answered.ledger.write(() => apply(answered.ledger, interpret(answered.ledger, `right ${answered.q}`)!));
				expect(interpretPaste(answered.ledger, numbered(answered.ledger, answered.numbering), answered.copy)).toMatchObject({ ok: false, kind: "refused" });

				const filled = described();
				nameWork(filled.ledger, filled.p.wl, SURFACE_BY, "Plan the cut");
				expect(interpretPaste(filled.ledger, filled.numbering, filled.copy)).toEqual(refused);
			});

			test("a block with no command: only pending's text is wrapperOnly; with Jo's words it is refused and the words are held, not passed on", () => {
				const { ledger } = tempLedger();
				ensureStandingWorkload(ledger);
				expect(interpretPaste(ledger, new Numbering(), pendingBlock(pendingItems(ledger)).text)).toEqual({ ok: false, kind: "wrapperOnly" });
				const { wl, sl } = workloadWithSlice(ledger, { name: "Cleanup" });
				raiseAsked(ledger, { by: "lane-a", workloadId: wl, sliceId: sl, body: "How far?", options: ["go on", "stop here"], ask: "How far should the cleanup go?" });
				ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("ask", "c7", "s1", "which branch?") });
				const copy = blockOf(ledger);
				expect(copy).not.toMatch(/^\S+ (?:q|en)-/m);
				const numbering = numbered(ledger);
				expect(interpretPaste(ledger, numbering, copy)).toEqual({ ok: false, kind: "wrapperOnly" });
				const n = copy.split("\n").length + 1;
				expect(interpretPaste(ledger, numbering, `${copy}\nplease also check the footer`)).toEqual({
					ok: false,
					kind: "refused",
					why: expect.stringContaining("no answer line"),
					held: [{ kind: "instruction", from: n, to: n, text: "please also check the footer" }],
				});
				// a block whose commands Jo deleted is pending's own text alone
				const d = described();
				const commandless = d.copy.split("\n").filter((l) => ![`approve ${d.en}`, `left ${d.q}`, `approve ${d.p.q}`].includes(l)).join("\n");
				expect(interpretPaste(d.ledger, d.numbering, commandless)).toEqual({ ok: false, kind: "wrapperOnly" });
			});
			test("a legacy unbound question without a name is consumed only as a whole current headerless card", () => {
				const { ledger } = tempLedger();
				ensureStandingWorkload(ledger);
				const q = ledger.raiseQuestion({
					by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(ledger)!.id,
					body: "Which work should I prioritize?", options: ["fix headers", "review parser"],
				});
				const card = blockOf(ledger).split("```text\n")[1]!.split("\n```")[0]!;
				const numbering = numbered(ledger);
				expect(card.split("\n").slice(0, 2)).toEqual([
					`# Metadata: missing name for ${q}; pending descriptions need initialization`,
					`# Metadata: missing ask for ${q}; pending descriptions need initialization`,
				]);
				expect(card).not.toContain("# Work:");
				expect(card).toContain("# Answer: in words; no pasteable command");
				expect(pendingShaped(card)).toBe(true); // the input hook reads complete cards even with no command
				expect(interpretPaste(ledger, numbering, card)).toEqual({ ok: false, kind: "wrapperOnly" });
				expect(interpretPaste(ledger, numbering, `${card}\ncheck the footer`)).toMatchObject({
					ok: false, kind: "refused", held: [{ kind: "instruction", text: "check the footer" }],
				});
				const missingAskOnly = card.split("\n").filter((line) => !line.startsWith("# Metadata: missing name")).join("\n");
				const missingNameOnly = card.split("\n").filter((line) => !line.startsWith("# Metadata: missing ask")).join("\n");
				for (const fragment of [missingAskOnly, missingNameOnly]) {
					expect(pendingShaped(fragment)).toBe(false);
					expect(interpretPaste(ledger, numbering, fragment)).toBeNull();
				}
				expect(interpretPaste(ledger, numbering, card.replace(`missing name for ${q}`, "missing name for q-edited"))).toMatchObject({
					ok: false, kind: "refused", held: [],
				});
				expect(interpretPaste(ledger, numbering, card.split("\n").slice(0, -1).join("\n"))).toBeNull();
				expect(pendingShaped(card.split("\n").slice(0, -1).join("\n"))).toBe(false);
				expect(interpretPaste(ledger, numbering, `# Metadata: missing ask for ${q}\n# Default: fix headers\n# Answer: in words; no pasteable command`)).toBeNull();
				const other = ledger.raiseQuestion({
					by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(ledger)!.id,
					body: "Which area should I inspect?", options: ["inspect logs", "inspect code"],
				});
				const otherCard = blockOf(ledger).split("```text\n")[1]!.split("\n```")[0]!.split("\n\n")[1]!;
				const mixed = card.replace(`# Metadata: missing ask for ${q}`, `# Metadata: missing ask for ${other}`);
				expect(otherCard).toContain(`# Metadata: missing ask for ${other}; pending descriptions need initialization`);
				expect(interpretPaste(ledger, numbered(ledger), mixed)).toMatchObject({ ok: false, kind: "refused", held: [] });
				expect(ledger.question(q)!.state).toBe("open");
				expect(ledger.instructions(STANDING_WORKLOAD_ID)).toEqual([]);
				ledger.answerQuestion(q, { by: SURFACE_BY, answer: "fix headers", author: "jo", channel: "surface" });
				expect(interpretPaste(ledger, numbering, card)).toMatchObject({ ok: false, kind: "refused", held: [] });
			});
			test("complete headerless unpasteable cards are consumed atomically; incomplete fields remain prose", () => {
				const { ledger } = tempLedger();
				const { wl, sl } = workloadWithSlice(ledger, { name: "Cleanup" });
				const q = raiseAsked(ledger, { by: "lane-a", workloadId: wl, sliceId: sl, body: "How far?", options: ["go on", "stop here"], ask: "How far should the cleanup go?" });
				ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("ask", "c7", "s1", "which branch?") });
				const [question, wait] = blockOf(ledger).split("```text\n")[1]!.split("\n```")[0]!.split("\n\n");
				const numbering = numbered(ledger);
				for (const card of [question!, wait!, `${question}\n\n${wait}`]) {
					expect(interpretPaste(ledger, numbering, card)).toEqual({ ok: false, kind: "wrapperOnly" });
					expect(interpretPaste(ledger, numbering, `${card}\ncheck the footer`)).toMatchObject({
						ok: false, kind: "refused", held: [{ kind: "instruction", text: "check the footer" }],
					});
				}
				expect(interpretPaste(ledger, numbering, question!.split("\n").slice(0, -1).join("\n"))).toBeNull();
				expect(interpretPaste(ledger, numbering, "# Work: Cleanup\n# Question: How far should the cleanup go?")).toBeNull();
				for (const edited of [
					question!.replace("How far should", "Where should"),
					question!.replace("# Default:", "# Work: changed\n# Default:"),
					[question!.split("\n")[1], question!.split("\n")[0], ...question!.split("\n").slice(2)].join("\n"),
					wait!.replace("# Since:", "# Since: edited "),
				]) {
					expect(interpretPaste(ledger, numbering, edited)).toMatchObject({ ok: false, kind: "refused", held: [] });
				}
				ledger.answerQuestion(q, { by: SURFACE_BY, answer: "go on", author: "jo", channel: "surface" });
				expect(interpretPaste(ledger, numbering, question!)).toMatchObject({ ok: false, kind: "refused", held: [] });
				ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptResolvedBody("ask", "c7", "s1", "answered") });
				expect(interpretPaste(ledger, numbering, wait!)).toMatchObject({ ok: false, kind: "refused", held: [] });
			});

			test("a missing-name prompt wait is a complete card, but its individual fields are prose", () => {
				const { ledger } = tempLedger();
				const { wl, sl } = workloadWithSlice(ledger);
				ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("bash", "c8", "s2", "approval needed") });
				const card = pendingWaits(ledger)[0]!;
				expect(card).not.toContain("# Work:");
				expect(card).toContain(`# Metadata: missing name for ${wl}`);
				expect(interpretPaste(ledger, numbered(ledger), card)).toEqual({ ok: false, kind: "wrapperOnly" });
				expect(interpretPaste(ledger, numbered(ledger), card.split("\n").slice(0, -1).join("\n"))).toBeNull();
			});
			test("fields borrowed from two live unpasteable rows never form a current card", () => {
				const { ledger } = tempLedger();
				const { wl, sl } = workloadWithSlice(ledger, { name: "Cleanup" });
				raiseAsked(ledger, { by: "lane-a", workloadId: wl, sliceId: sl, body: "First?", options: ["go on", "stop here"], ask: "Should cleanup proceed?" });
				raiseAsked(ledger, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Second?", options: ["hold on", "carry on"], ask: "Should cleanup pause?" });
				const [first, second] = blockOf(ledger).split("```text\n")[1]!.split("\n```")[0]!.split("\n\n");
				const hybrid = first!.split("\n").map((line) => line.startsWith("# Default:") ? second!.split("\n").find((other) => other.startsWith("# Default:"))! : line).join("\n");
				expect(interpretPaste(ledger, numbered(ledger), first!)).toEqual({ ok: false, kind: "wrapperOnly" });
				expect(interpretPaste(ledger, numbered(ledger), hybrid)).toMatchObject({ ok: false, kind: "refused", held: [] });
			});
			test("an unasked legacy question with missing name and ask is still a complete unpasteable card", () => {
				const { ledger } = tempLedger();
				const { wl, sl } = workloadWithSlice(ledger);
				const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "How far?", options: ["go on", "stop here"] });
				const card = blockOf(ledger).split("```text\n")[1]!.split("\n```")[0]!;
				expect(card.split("\n").slice(0, 2)).toEqual([
					`# Metadata: missing name for ${wl}; pending descriptions need initialization`,
					`# Metadata: missing ask for ${q}; pending descriptions need initialization`,
				]);
				expect(card).not.toContain("# Question:");
				expect(interpretPaste(ledger, numbered(ledger), card)).toEqual({ ok: false, kind: "wrapperOnly" });
				expect(interpretPaste(ledger, numbered(ledger), card.replace(`missing ask for ${q}`, "missing ask for q-edited"))).toMatchObject({ ok: false, kind: "refused", held: [] });
			});
			test("a named legacy question with only its ask missing is a complete card too", () => {
				const { ledger } = tempLedger();
				const { wl, sl } = workloadWithSlice(ledger, { name: "Cleanup" });
				const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "How far?", options: ["go on", "stop here"] });
				const card = blockOf(ledger).split("```text\n")[1]!.split("\n```")[0]!;
				expect(card.split("\n").slice(0, 2)).toEqual([
					"# Work: Cleanup",
					`# Metadata: missing ask for ${q}; pending descriptions need initialization`,
				]);
				expect(interpretPaste(ledger, numbered(ledger), card)).toEqual({ ok: false, kind: "wrapperOnly" });
			});

			test("an older layout's block is refused whole before any line is read; its standalone tailed lines still apply; Jo's heading-like prose stays prose", () => {
				const { ledger, q, numbering } = described();
				const oldHint = "(paste the block back as is, or any of its lines; change a line's first word to pick another option)";
				const old = [`## pending: 1 thing waits on you ${oldHint}`, "```text", `left ${q}${tail("Which?")}`, "```"].join("\n");
				expect(interpretPaste(ledger, numbering, old)).toEqual({ ...refused, why: expect.stringContaining("line 1 heads a pending block") });
				expect(interpretPaste(ledger, numbering, `## pending: 3 things wait on you\nleft ${q}`)).toEqual(refused);
				expect(interpretPaste(ledger, numbering, `left ${q}${tail("Which?")}`)).toMatchObject({ ok: true, items: [{ text: `left ${q}`, kind: "command" }] });
				for (const line of ["## pending: 3 things wait on you, but do the header first", "## pending: the header fix", "## Pending: 3 things wait on you", "```text", "```"]) {
					expect(interpretPaste(ledger, numbering, `left ${q}\n${line}`)).toMatchObject({ ok: true, items: [{ line: 1, kind: "command" }, { kind: "instruction", from: 2, to: 2, text: line }] });
				}
			});

			test("field lines with no command and no heading are Jo's prose; a fence of Jo's own outside a block is kept", () => {
				const { ledger, q, numbering, copy } = described();
				expect(interpretPaste(ledger, numbering, entryOf(copy, q).slice(0, -1).join("\n"))).toBeNull();
				expect(interpretPaste(ledger, numbering, `left ${q}\nfirst this\n\`\`\`\nthen that`)).toMatchObject({ ok: true, items: [{ line: 1 }, { kind: "instruction", from: 2, to: 4, text: "first this\n```\nthen that" }] });
				// an unclosed block fence: the rest is the block's, Jo's words inside it an instruction
				const heading = copy.split("\n")[0]!;
				const unclosed = interpretPaste(ledger, numbering, [heading, "```text", `left ${q}`, "a note of mine"].join("\n"));
				expect(unclosed).toMatchObject({ ok: true, items: [{ line: 3, kind: "command" }, { kind: "instruction", from: 4, to: 4, text: "a note of mine" }] });
			});
		});

		/** A user-driven workload with a question offering the mode words and the stakes words; with `two`, a second workload opened after it. */
		function modeQuestion(two: boolean) {
			const c = clock();
			const { ledger } = tempLedger(c.now);
			const { wl, sl } = workloadWithSlice(ledger, { mode: "user-driven" });
			const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "How should the next slice run?", options: ["autonomous", "user-driven", "normal", "production"] });
			c.plusHours(0.01);
			const b = two ? workloadWithSlice(ledger, { brief: "second", mode: "user-driven" }).wl : null;
			return { ledger, wl, b, q, views: [wl, ...(b ? [b] : [])] };
		}

		for (const two of [false, true]) {
			test(`\`autonomous q-X\` answers a question offering \`autonomous\` and flips no mode (${two ? "two workloads" : "one workload"} in view)`, () => {
				const { ledger, wl, q, views } = modeQuestion(two);
				expect(workloadsInView(ledger)).toEqual(views);
				expect(interpret(ledger, `production ${q}`)).toEqual({ kind: "answer", workloadId: wl, questionId: q, answer: "production" });
				const cmd = interpret(ledger, `autonomous ${q}`)!;
				expect(cmd).toEqual({ kind: "answer", workloadId: wl, questionId: q, answer: "autonomous" });
				expect(ledger.write(() => apply(ledger, cmd))).toContain(`answered ${q} with "autonomous"`);
				expect(ledger.question(q)!.state).toBe("answered");
				for (const id of views) {
					expect(ledger.workload(id)!.mode).toBe("user-driven");
					expect(ledger.workload(id)!.stakes).toBe("normal");
					expect(ledger.instructions(id).filter((i) => i.kind === "mode-flip" || i.body.startsWith("stakes:"))).toEqual([]);
				}
			});
		}

		test("a mode or stakes word with an en- id is no flip; a bare mode word and `<word> wl-…` still flip", () => {
			const { ledger, wl } = modeQuestion(false);
			const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "reserved-request", body: "push main" });
			expect(interpret(ledger, `autonomous ${en}`)).toBeNull();
			expect(interpret(ledger, `production ${en}`)).toBeNull();
			expect(interpret(ledger, "autonomous")).toEqual({ kind: "mode", workloadId: wl, mode: "autonomous" });
			expect(interpret(ledger, `production ${wl}`)).toEqual({ kind: "stakes", workloadId: wl, stakes: "production" });
			expect(ledger.workload(wl)!.mode).toBe("user-driven");
		});

		test("`autonomous q-X` inside a paste is a command: applied when the question offers it, refused with what it takes when not", () => {
			const { ledger, wl, q } = modeQuestion(true);
			const numbering = numbered(ledger);
			const r = interpretPaste(ledger, numbering, `autonomous ${q}${tail("How should the next slice run?", "user-driven / normal / production / withdraw")}\nthen carry on`);
			expect(r).toEqual({
				ok: true,
				items: [
					{ line: 1, text: `autonomous ${q}`, kind: "command", cmd: { kind: "answer", workloadId: wl, questionId: q, answer: "autonomous" } },
					{ kind: "instruction", from: 2, to: 2, text: "then carry on" },
				],
			});
			applyPaste(ledger, r);
			expect(ledger.question(q)!.state).toBe("answered");
			expect(ledger.workload(wl)!.mode).toBe("user-driven");
			// a question that does not offer the word: a command attempt refused on its line, never prose
			const { ledger: l2, sl } = rows();
			const q2 = l2.raiseQuestion({ by: "lane-a", workloadId: l2.inFlight()[0]!.workload.id, sliceId: sl, body: "Which?", options: ["left", "right"] });
			expect(interpretPaste(l2, numbered(l2), `autonomous ${q2}\nthen carry on`)).toMatchObject({
				ok: false,
				refused: [{ line: 1, why: [`"autonomous ${q2}" is not a command the surface knows (${q2} takes: left / right / withdraw)`] }],
			});
		});
	});
});

describe("review round limit (D9) and stop-reviews (D10)", () => {
	const LANE = "lane-r-1";
	const findings = (blocking: number): Findings => ({
		counts: { blocking: blocking > 0 ? { correctness: blocking } : {}, major: { tests: 2 }, minor: {} },
		titles: [],
	});
	/** A review hand of round `n` on `sl` spawned (the classifier's `hand-spawn:`), and settled with `blocking` findings unless `running`. */
	function round(ledger: Ledger, wl: string, sl: string, n: number, o: { blocking?: number; running?: boolean; unknown?: boolean } = {}): void {
		const token = `dt-${sl}-${n}`;
		const group = `dg-${sl}-${n}`;
		const entry = (body: string) => ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body });
		entry(handSpawnBody({ token, root: "/s/lane.jsonl", spawnKey: null, review: true, group, row: ["openai/gpt-6"] }));
		if (!o.running) entry(reviewRoundBody({ slice: sl, round: n, token, group, verdict: "accepted", findings: o.unknown ? "unknown" : findings(o.blocking ?? 1) }));
	}
	/** The classifier's round-limit question on `sl` and its `review-limit:` entry. */
	function limitQuestion(ledger: Ledger, wl: string, sl: string): string {
		const q = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "The review reached its round limit", options: [...ROUND_LIMIT_OPTIONS] });
		ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
		return q;
	}
	/** The classifier's park question on `sl` and its `review-park:` entry. */
	function parkQuestion(ledger: Ledger, wl: string, sl: string): string {
		const q = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "No other lab can review", options: ["same-lab", "wait"] });
		ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewParkBody(q, sl) });
		return q;
	}
	/** A workload at its limit on `sl`: three failed rounds and the open limit question. */
	function atLimit(ledger: Ledger) {
		const { wl, sl } = workloadWithSlice(ledger);
		for (const n of [1, 2, 3]) round(ledger, wl, sl, n, { blocking: 4 - n });
		return { wl, sl, q: limitQuestion(ledger, wl, sl) };
	}
	const bodies = (ledger: Ledger, wl: string, prefix: string) => ledger.entries(wl, "assumption").map((e) => e.body).filter((b) => b.startsWith(prefix));
	const limitOf = (ledger: Ledger, wl: string, sl: string) => effectiveRoundLimit(ledger.entries(wl), ledger.instructions(wl), ledger.workload(wl)!.stakes, sl);

	test("`rounds 5` with one workload in view writes the instruction, then the review-rounds: entry naming it, and the limit is 5", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		expect(limitOf(ledger, wl, sl).workload).toBe(3);
		const cmd = interpret(ledger, "rounds 5");
		expect(cmd).toEqual({ kind: "rounds", workloadId: wl, rounds: 5 });
		expect(apply(ledger, cmd!)).toMatch(new RegExp(`^review round limit on ${wl} → 5 failed rounds per review loop \\(instruction in-\\S+\\)$`));
		const [i] = ledger.instructions(wl);
		expect(i).toMatchObject({ kind: "instruction", body: "rounds: 5", author: "jo", channel: "surface" });
		expect(bodies(ledger, wl, "review-rounds:")).toEqual([`review-rounds: 5 source your word by ${i!.id}`]);
		expect(limitOf(ledger, wl, sl)).toEqual({ workload: 5, extend: 0, total: 5 });
		// not the command: no number, zero, a non-workload third word, a workload not in view; never a numbered batch
		for (const text of ["rounds", "rounds five", "rounds 0", `rounds 5 ${sl}`, "rounds 5 wl-nope"]) expect(interpret(ledger, text)).toBeNull();
		expect(parseBatch("rounds 5")).toBeNull();
	});

	test("`rounds 5` bare with two workloads in view asks which one and writes nothing; `rounds 5 wl-…` picks", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const a = workloadWithSlice(ledger).wl;
		c.plusHours(0.01);
		const b = workloadWithSlice(ledger, { brief: "second" }).wl;
		const cmd = interpret(ledger, "rounds 5")!;
		expect(cmd).toEqual({ kind: "ambiguous", word: "rounds 5", candidates: [{ kind: "workload", workloadId: a }, { kind: "workload", workloadId: b }] });
		expect(() => apply(ledger, cmd)).toThrow("refused, never applied");
		expect(allInstructions(ledger)).toEqual([]);
		expect([...bodies(ledger, a, "review-rounds"), ...bodies(ledger, b, "review-rounds")]).toEqual([]);
		apply(ledger, interpret(ledger, `rounds 5 ${b}`)!);
		expect(ledger.instructions(a)).toEqual([]);
		expect(ledger.instructions(b).map((i) => i.body)).toEqual(["rounds: 5"]);
	});

	test("`extend` on a review-limit: question adds one block to that slice only and reopens it", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = atLimit(ledger);
		const other = ledger.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(ledger.slice(sl)!.state).not.toBe("open");
		const cmd = interpret(ledger, "extend")!;
		expect(cmd).toMatchObject({ kind: "answer", questionId: q, answer: "extend" });
		const receipt = apply(ledger, cmd);
		const answer = ledger.instructions(wl).find((i) => i.kind === "answer")!;
		expect(receipt).toContain(`slice ${sl} is open; 3 more review rounds for ${sl} (its limit is now 6 failed rounds)`);
		expect(bodies(ledger, wl, "review-rounds-extend:")).toEqual([`review-rounds-extend: ${sl} +3 by ${answer.id}`]);
		expect(ledger.slice(sl)!.state).toBe("open");
		expect(limitOf(ledger, wl, sl)).toEqual({ workload: 3, extend: 3, total: 6 });
		expect(limitOf(ledger, wl, other).total).toBe(3);
		expect(bodies(ledger, wl, "review-loop-end:")).toEqual([]);
	});

	test("`accept` ends the loop as accepted and reopens the slice, completing nothing; `stop` ends the loop", () => {
		for (const word of ["accept", "stop"] as const) {
			const { ledger } = tempLedger();
			const { wl, sl } = atLimit(ledger);
			const receipt = apply(ledger, interpret(ledger, word)!);
			expect(bodies(ledger, wl, "review-loop-end:")).toEqual([`review-loop-end: ${sl} reason ${word}`]);
			expect(bodies(ledger, wl, "review-rounds")).toEqual([]);
			expect(ledger.slice(sl)!.state).toBe("open");
			expect(ledger.slices(wl).filter((s) => s.state === "done")).toEqual([]);
			expect(countRounds(ledger.entries(wl), sl).rounds).toEqual([]); // the next review starts a fresh loop
			expect(receipt).toContain(word === "accept" ? `the review of ${sl} counts as passed with its findings left` : `no further review round on ${sl}`);
		}
	});

	test("a question offering extend / accept / stop with no review-limit: entry naming it is an ordinary question", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const q = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "Go on?", options: [...ROUND_LIMIT_OPTIONS] });
		// an entry naming the question on another slice, or written by someone other than the asker, does not make it one
		ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, "sl-other") });
		ledger.recordEntry({ by: "lane-x-1", workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
		apply(ledger, interpret(ledger, "extend")!);
		expect(ledger.question(q)!.state).toBe("answered");
		expect(bodies(ledger, wl, "review-rounds-extend:")).toEqual([]);
		expect(bodies(ledger, wl, "review-loop-end:")).toEqual([]);
	});

	test("bare `stop-reviews`: instruction + review-stop:, the open limit question withdrawn then cancel, idle loops ended, the echo per loop", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = atLimit(ledger); // round 3 left blocking 1
		const busy = ledger.addSlice({ by: LANE, workloadId: wl, task: "t2", doneCondition: "d", inputs: "i" });
		round(ledger, wl, busy, 1, { blocking: 2 });
		round(ledger, wl, busy, 2, { running: true });
		const quiet = ledger.addSlice({ by: LANE, workloadId: wl, task: "t3", doneCondition: "d", inputs: "i" });
		const cmd = interpret(ledger, "stop-reviews")!;
		expect(cmd).toEqual({ kind: "stop-reviews", workloadId: wl, target: wl });
		const receipt = apply(ledger, cmd);
		const [i] = ledger.instructions(wl).filter((x) => x.kind === "instruction");
		expect(i).toMatchObject({ body: `stop-reviews: ${wl}`, author: "jo", channel: "surface" });
		expect(bodies(ledger, wl, "review-stop:")).toEqual([`review-stop: ${wl} by ${i!.id}`]);
		expect(ledger.question(q)!.state).toBe("withdrawn");
		expect(ledger.instructions(wl).find((x) => x.kind === "withdrawal")).toMatchObject({ question_id: q, disposition: "cancel", author: "jo" });
		expect(ledger.slice(sl)!.state).toBe("cancelled");
		// the idle loop ends here; the running round's settle ends the busy one (the classifier)
		expect(bodies(ledger, wl, "review-loop-end:")).toEqual([`review-loop-end: ${sl} reason stop-reviews`]);
		expect(receipt).toContain(`stopped every review loop on ${wl} (instruction ${i!.id})`);
		expect(receipt).toContain(`${sl}: round 3 left blocking 1 (correctness 1) · major 2 (tests 2) · minor 0; withdrew ${q}`);
		expect(receipt).toContain(`${busy}: round 2 still running`);
		expect(receipt).not.toContain(quiet);
		// the classifier reads the stop back on every slice of the workload
		for (const s of [sl, busy, quiet]) expect(reviewStopOn(ledger.entries(wl), ledger.instructions(wl), wl, s)).toBe(i!.id);
	});

	test("`stop-reviews sl-…` stops that loop only: its open park question withdrawn then cancel, another slice's left open", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const other = ledger.addSlice({ by: LANE, workloadId: wl, task: "t2", doneCondition: "d", inputs: "i" });
		const p1 = parkQuestion(ledger, wl, sl);
		const p2 = parkQuestion(ledger, wl, other);
		const cmd = interpret(ledger, `stop-reviews ${sl}`)!;
		expect(cmd).toEqual({ kind: "stop-reviews", workloadId: wl, target: sl });
		const receipt = apply(ledger, cmd);
		const i = ledger.instructions(wl).find((x) => x.kind === "instruction")!;
		expect(i).toMatchObject({ body: `stop-reviews: ${sl}`, slice_id: sl });
		expect(bodies(ledger, wl, "review-stop:")).toEqual([`review-stop: ${sl} by ${i.id}`]);
		expect(ledger.question(p1)!.state).toBe("withdrawn");
		expect(ledger.question(p2)!.state).toBe("open");
		expect(bodies(ledger, wl, "review-loop-end:")).toEqual([`review-loop-end: ${sl} reason stop-reviews`]);
		const withdrawal = ledger.instructions(wl).find((x) => x.kind === "withdrawal")!;
		expect(withdrawal).toMatchObject({ question_id: p1, disposition: "cancel" });
		expect(receipt).toBe(`stopped the review loop on ${sl} (instruction ${i.id}); ${sl}: no review round settled in this loop; withdrew ${p1} (withdrawal ${withdrawal.id}, then cancel)`);
		expect(reviewStopOn(ledger.entries(wl), ledger.instructions(wl), wl, sl)).toBe(i.id);
		expect(reviewStopOn(ledger.entries(wl), ledger.instructions(wl), wl, other)).toBeNull();
	});

	test("bare `stop-reviews` with two workloads in view asks which one and writes nothing; `wl-…` and `sl-…` pick", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const a = workloadWithSlice(ledger);
		c.plusHours(0.01);
		const b = workloadWithSlice(ledger, { brief: "second" });
		const cmd = interpret(ledger, "stop-reviews")!;
		expect(cmd).toEqual({ kind: "ambiguous", word: "stop-reviews", candidates: [{ kind: "workload", workloadId: a.wl }, { kind: "workload", workloadId: b.wl }] });
		expect(() => apply(ledger, cmd)).toThrow("refused, never applied");
		expect(allInstructions(ledger)).toEqual([]);
		expect(interpret(ledger, `stop-reviews ${b.wl}`)).toEqual({ kind: "stop-reviews", workloadId: b.wl, target: b.wl });
		expect(interpret(ledger, `stop-reviews ${a.sl}`)).toEqual({ kind: "stop-reviews", workloadId: a.wl, target: a.sl });
		for (const text of ["stop-reviews wl-nope", "stop-reviews sl-nope", "stop-reviews q-1"]) expect(interpret(ledger, text)).toBeNull();
		apply(ledger, interpret(ledger, `stop-reviews ${b.wl}`)!);
		expect(ledger.instructions(a.wl)).toEqual([]);
		expect(bodies(ledger, b.wl, "review-stop:")).toHaveLength(1);
	});

	test("the echo names a settled round's unreadable findings", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		round(ledger, wl, sl, 1, { unknown: true });
		expect(apply(ledger, interpret(ledger, "stop-reviews")!)).toContain(`${sl}: round 1 left unknown`);
	});

	test("the ceiling question's bare `stop` still answers the ceiling question, untouched by `stop-reviews`", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const park = parkQuestion(ledger, wl, sl);
		const ceilingSlice = ledger.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: "sl-ceiling-1", task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
		const cq = ledger.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: wl, sliceId: ceilingSlice, body: "80 % of the ceiling", options: [...CEILING_OPTIONS] });
		expect(CEILING_OPTIONS).toContain("stop");
		apply(ledger, interpret(ledger, "stop-reviews")!);
		expect(ledger.question(park)!.state).toBe("withdrawn");
		expect(ledger.question(cq)!.state).toBe("open");
		const stop = interpret(ledger, "stop")!;
		expect(stop).toEqual({ kind: "answer", workloadId: wl, questionId: cq, answer: "stop" });
		apply(ledger, stop);
		expect(ledger.question(cq)!.state).toBe("answered");
		expect(ledger.slice(ceilingSlice)!.state).toBe("done");
		expect(bodies(ledger, wl, "review-loop-end:")).toEqual([`review-loop-end: ${sl} reason stop-reviews`]);
	});
});

describe("cancel-slice (PLAN wl-mv5i3lulwwbbi8 D1)", () => {
	const noBeat = () => null;
	const RUN = "tr-0cancel1";
	/** The runner's `test-requested:` for a run on `sl`, written at the clock's time. */
	const requestRun = (ledger: Ledger, wl: string, sl: string) =>
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId: RUN, pr: 17, sha: "a".repeat(40), slice: sl, by: "lane-a" }) });
	/** Everything a refusal must leave as it was. */
	const state = (ledger: Ledger, wl: string, sl: string) => ({
		slice: ledger.slice(sl)?.state, instructions: ledger.instructions(wl).length, entries: ledger.entries(wl).length, questions: ledger.questions(wl).map((q) => q.state),
	});
	const launchRequests = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("launch-requested:")).map((e) => e.body);

	test("an open slice is cancelled: one instruction row by jo through the surface, the slice cancelled by the surface, no relaunch asked", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const cmd = interpret(ledger, `cancel-slice ${sl}`, noBeat);
		expect(cmd).toEqual({ kind: "cancel-slice", workloadId: wl, sliceId: sl });
		const receipt = apply(ledger, cmd!);
		const [ins] = ledger.instructions(wl);
		expect(receipt).toBe(`cancelled slice ${sl} on ${wl} (instruction ${ins!.id})`);
		expect(ledger.instructions(wl).map((i) => [i.kind, i.body, i.author, i.channel, i.created_by, i.slice_id])).toEqual([
			["instruction", `cancel-slice ${sl}`, "jo", "surface", SURFACE_BY, sl],
		]);
		expect(ledger.slice(sl)).toMatchObject({ state: "cancelled", changed_by: SURFACE_BY });
		expect(launchRequests(ledger, wl)).toEqual([]);
	});

	test("a paused slice: its open question withdrawn (then cancel) naming the instruction, the slice cancelled, and a relaunch asked for the parked lane", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by test" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which header?", options: ["left", "right"] });
		expect(ledger.slice(sl)!.state).toBe("paused");
		const cmd = interpret(ledger, `cancel-slice ${sl}`, noBeat);
		expect(cmd).toEqual({ kind: "cancel-slice", workloadId: wl, sliceId: sl });
		const receipt = apply(ledger, cmd!);
		const [ins, withdrawal] = ledger.instructions(wl);
		expect(receipt).toBe(
			`cancelled slice ${sl} on ${wl} (instruction ${ins!.id}); withdrew ${q} (withdrawal ${withdrawal!.id}, then cancel); no lane holds it live, so a relaunch is requested`,
		);
		expect([withdrawal!.kind, withdrawal!.disposition, withdrawal!.question_id, withdrawal!.author, withdrawal!.channel]).toEqual(["withdrawal", "cancel", q, "jo", "surface"]);
		expect(withdrawal!.body).toBe(`cancel-slice (instruction ${ins!.id})`);
		expect(ledger.question(q)!.state).toBe("withdrawn");
		expect(ledger.slice(sl)!.state).toBe("cancelled");
		expect(launchRequests(ledger, wl)).toEqual([expect.stringMatching(new RegExp(`^launch-requested: by jo at \\S+ \\(cancel-slice ${sl}\\)$`))]);
		expect(verdictOf(ledger.launchRows(wl, 3)!)).toMatchObject({ launch: true, cause: { kind: "request" } });
	});

	test("while a lane holds the workload live, the question is withdrawn and no relaunch is asked", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by test" });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-a", leaseMs: null }).won).toBe(true);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which header?", options: ["left", "right"] });
		const cmd = interpret(ledger, `cancel-slice ${sl}`, noBeat);
		expect(cmd).toEqual({ kind: "cancel-slice", workloadId: wl, sliceId: sl });
		expect(apply(ledger, cmd!)).not.toContain("relaunch");
		expect(ledger.question(q)!.state).toBe("withdrawn");
		expect(ledger.slice(sl)!.state).toBe("cancelled");
		expect(launchRequests(ledger, wl)).toEqual([]);
	});

	test("refused with the reason, never prose, and nothing written: no slice, a done slice, a closed workload, wrong arity", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const done = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		ledger.completeSlice(done, { by: "lane-a", artifact: "x" });
		const closed = workloadWithSlice(ledger);
		ledger.completeSlice(closed.sl, { by: "lane-a", artifact: "x" });
		ledger.closeWorkload(closed.wl, { by: SURFACE_BY });
		const before = state(ledger, wl, sl);
		expect(interpret(ledger, "cancel-slice sl-nope", noBeat)).toEqual({ kind: "refused", why: "no slice sl-nope" });
		expect(interpret(ledger, `cancel-slice ${done}`, noBeat)).toEqual({ kind: "refused", why: `${done} is done: only an open or paused slice is cancelled` });
		expect(interpret(ledger, `cancel-slice ${closed.sl}`, noBeat)).toEqual({ kind: "refused", why: `${closed.sl} is on ${closed.wl}, which is closed: nothing to cancel` });
		expect(interpret(ledger, "cancel-slice", noBeat)).toEqual({ kind: "refused", why: "cancel-slice names one slice: cancel-slice sl-…" });
		expect(interpret(ledger, `cancel-slice ${sl} ${done}`, noBeat)).toEqual({ kind: "refused", why: "cancel-slice names one slice: cancel-slice sl-…" });
		expect(() => apply(ledger, { kind: "cancel-slice", workloadId: wl, sliceId: done })).toThrow(`${done} is done`);
		expect(state(ledger, wl, sl)).toEqual(before);
		expect(ledger.slice(done)!.state).toBe("done");
	});

	test("refused while a test run on the slice is live: requested 10 s ago with no heartbeat, or a heartbeat 5 s old; a dead run does not hold it", () => {
		const c = clock("2026-10-12T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		requestRun(ledger, wl, sl);
		const live = { kind: "refused", why: `test run ${RUN} (PR #17) on ${sl} is live: its test-run: settles the slice; cancel it once the run has ended` };
		c.at("2026-10-12T10:00:10.000Z");
		const before = state(ledger, wl, sl);
		expect(interpret(ledger, `cancel-slice ${sl}`, noBeat)).toEqual(live);
		c.at("2026-10-12T10:10:00.000Z");
		const beat = (ms: number) => (runId: string) => (runId === RUN ? Date.parse(ledger.now()) - ms : null);
		expect(interpret(ledger, `cancel-slice ${sl}`, beat(5_000))).toEqual(live);
		expect(state(ledger, wl, sl)).toEqual(before);
		// A heartbeat over 60 s old, or no heartbeat past the 120 s startup lease: the run is dead.
		expect(interpret(ledger, `cancel-slice ${sl}`, beat(61_000))).toEqual({ kind: "cancel-slice", workloadId: wl, sliceId: sl });
		expect(interpret(ledger, `cancel-slice ${sl}`, noBeat)).toEqual({ kind: "cancel-slice", workloadId: wl, sliceId: sl });
	});

	test("a run that goes live between interpret and apply: apply throws the live-run refusal, writing nothing, and the slice stays open", () => {
		const c = clock("2026-10-12T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		const cmd = interpret(ledger, `cancel-slice ${sl}`, noBeat);
		expect(cmd).toEqual({ kind: "cancel-slice", workloadId: wl, sliceId: sl });
		requestRun(ledger, wl, sl);
		c.at("2026-10-12T10:00:10.000Z");
		const before = state(ledger, wl, sl);
		expect(() => apply(ledger, cmd!, noBeat)).toThrow(`test run ${RUN} (PR #17) on ${sl} is live: its test-run: settles the slice; cancel it once the run has ended`);
		expect(state(ledger, wl, sl)).toEqual(before);
		expect(ledger.instructions(wl)).toEqual([]);
		expect(ledger.slice(sl)!.state).toBe("open");
	});

	test("`cancel` stays the plan question's option; a paste that cancels one slice twice is refused once per row", () => {
		const { ledger } = tempLedger();
		const { q } = planQuestion(ledger);
		expect(interpret(ledger, "cancel", noBeat)).toMatchObject({ kind: "answer", questionId: q, answer: "cancel" });
		const { sl } = workloadWithSlice(ledger);
		const r = interpretPaste(ledger, numbered(ledger), `cancel-slice ${sl}\ncancel-slice ${sl}`, noBeat);
		expect(r?.ok).toBe(false);
		expect(r!.ok === false && r!.refused.flatMap((x) => x.why ?? [])).toEqual([`${sl} is already cancelled on line 1; once per row`]);
		expect(ledger.slice(sl)!.state).toBe("open");
	});
});

describe("supersede (PLAN wl-mv5i3lulwwbbi8 D2)", () => {
	test("writes Jo's instruction on A and the surface's `superseded:` entry naming it, a valid control entry", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const a = workloadWithSlice(ledger).wl;
		c.plusHours(0.01);
		const b = workloadWithSlice(ledger).wl;
		const cmd = interpret(ledger, `supersede ${a} ${b}`);
		expect(cmd).toEqual({ kind: "supersede", workloadId: a, by: b });
		const receipt = apply(ledger, cmd!);
		const ins = ledger.instructions(a);
		expect(ins.map((i) => [i.kind, i.body, i.author, i.channel, i.created_by])).toEqual([["instruction", `supersede ${a} ${b}`, "jo", "surface", SURFACE_BY]]);
		expect(receipt).toBe(`${a} is superseded by ${b} (instruction ${ins[0]!.id}); its close takes this in place of a done-because: receipt`);
		const control = controlEntries(ledger.entries(a)).filter((e) => e.prefix === ("superseded" as string));
		expect(control.map((e) => e.body)).toEqual([`superseded: ${b} ${ins[0]!.id}`]);
		expect(ledger.instructions(b)).toEqual([]);
	});

	test("refused with the reason, never prose, and nothing written: unknown, closed, itself, wrong arity", () => {
		const { ledger } = tempLedger();
		const a = workloadWithSlice(ledger).wl;
		const closed = workloadWithSlice(ledger);
		ledger.completeSlice(closed.sl, { by: "lane-a", artifact: "x" });
		ledger.closeWorkload(closed.wl, { by: SURFACE_BY });
		const n = ledger.entries(a).length;
		expect(interpret(ledger, `supersede ${a} wl-nope`)).toEqual({ kind: "refused", why: "no workload wl-nope" });
		expect(interpret(ledger, `supersede wl-nope ${a}`)).toEqual({ kind: "refused", why: "no workload wl-nope" });
		expect(interpret(ledger, `supersede ${closed.wl} ${a}`)).toEqual({ kind: "refused", why: `${closed.wl} is closed: only an open workload is superseded` });
		expect(interpret(ledger, `supersede ${a} ${a}`)).toEqual({ kind: "refused", why: `${a} cannot supersede itself` });
		const arity = { kind: "refused", why: "supersede names two workloads: supersede <wl-A> <wl-B> (A is superseded by B)" };
		expect(interpret(ledger, `supersede ${a}`)).toEqual(arity);
		expect(interpret(ledger, `supersede ${a} ${closed.sl}`)).toEqual(arity);
		// A closed successor is a successor: the work landed there.
		expect(interpret(ledger, `supersede ${a} ${closed.wl}`)).toEqual({ kind: "supersede", workloadId: a, by: closed.wl });
		expect(ledger.entries(a).length).toBe(n);
		expect(ledger.instructions(a)).toEqual([]);
		expect(commandShaped(`supersede ${a} ${closed.wl}`)).toBe(true);
	});
});

describe("plan-first approve receipt (PLAN wl-mv5i3lulwwbbi8 D4)", () => {
	test("approve on a question that is not the plan question, while plan: first stands, says it approved no plan", () => {
		const { ledger } = tempLedger();
		const { wl, q } = planQuestion(ledger);
		const other = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "spike", doneCondition: "d", inputs: "i" });
		const q2 = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: other, body: "Ship the spike?", options: ["approve", "deny"] });
		const receipt = apply(ledger, interpret(ledger, `approve ${q2}`)!);
		expect(receipt).toContain(`answered ${q2} with "approve"`);
		expect(receipt).toContain("; not the plan question: no plan approval written");
		const entries = ledger.entries(wl);
		expect(planFirst(controlEntries(entries, holdersOf(entries, "lane-a")))).not.toBeNull();
		// The plan question's own approve still approves, and says so.
		expect(apply(ledger, interpret(ledger, `approve ${q}`)!)).toContain("; plan approved: change slices may now be added");
	});
});

describe("test-pr: Jo binds PRs to a workload for a test run with no push (PLAN wl-mv5qdfvv82ivwg § 2.1)", () => {
	/** Every row the word could write on `wl`: its instructions and the surface's `test-pr:` entries. */
	const written = (ledger: Ledger, wl: string) => [...ledger.instructions(wl), ...ledger.entries(wl).filter((e) => e.body.startsWith("test-pr"))];

	test("`test-pr wl-x 79 70` writes Jo's instruction, then the surface's test-pr: naming it, and echoes the binding", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const cmd = interpret(ledger, `test-pr ${wl} 79 70`)!;
		expect(cmd).toEqual({ kind: "test-pr", workloadId: wl, prs: [79, 70] });
		const receipt = apply(ledger, cmd);
		const [i] = ledger.instructions(wl);
		expect(i).toMatchObject({ kind: "instruction", body: `test-pr ${wl} 79 70`, author: "jo", channel: "surface", created_by: SURFACE_BY });
		expect(ledger.entries(wl).filter((e) => e.body.startsWith("test-pr")).map((e) => [e.created_by, e.body])).toEqual([[SURFACE_BY, `test-pr: 79 70 ${i!.id}`]]);
		expect(receipt).toBe(`PRs #79, #70 bound to ${wl} for test runs with no push (instruction ${i!.id})`);
		expect(boundPrs(ledger.entries(wl), ledger.instructions(wl))).toEqual([{ pr: 79, instructionId: i!.id }, { pr: 70, instructionId: i!.id }]);
		// one PR reads singular; a second word adds to the first
		const one = apply(ledger, interpret(ledger, `test-pr ${wl} 73`)!);
		expect(one).toStartWith(`PR #73 bound to ${wl}`);
		expect(boundPrs(ledger.entries(wl), ledger.instructions(wl)).map((b) => b.pr)).toEqual([79, 70, 73]);
	});

	test("commas and spaces both separate; duplicates dropped in Jo's order; the word is case-insensitive", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		expect(interpret(ledger, `test-pr ${wl} 79,70, 73 79 ,70`)).toEqual({ kind: "test-pr", workloadId: wl, prs: [79, 70, 73] });
		expect(interpret(ledger, `Test-PR ${wl}, 79`)).toEqual({ kind: "test-pr", workloadId: wl, prs: [79] });
		apply(ledger, interpret(ledger, `test-pr ${wl} 79,70, 73 79`)!);
		expect(ledger.instructions(wl)[0]!.body).toBe(`test-pr ${wl} 79 70 73`);
	});

	test("refused, writing nothing: no workload named, one not open or not known, the standing workload, no number, a bad number, too many", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		ensureStandingWorkload(ledger);
		const closed = ledger.openWorkload({ by: SURFACE_BY, brief: "Closed", stakes: "normal", mode: "autonomous" });
		ledger.closeWorkload(closed, { by: SURFACE_BY });
		const many = Array.from({ length: TEST_PR_MAX + 1 }, (_, k) => k + 1).join(" ");
		const cases: [string, string][] = [
			// the workload is never inferred, even with one in view
			["test-pr 79 70", "test-pr names the workload first: test-pr <wl-…> <N> [<N> …]"],
			["test-pr", "test-pr names the workload first: test-pr <wl-…> <N> [<N> …]"],
			[`test-pr ${closed} 79`, `${closed} is closed: only an open workload is bound`],
			["test-pr wl-nope 79", "no workload wl-nope"],
			[`test-pr ${STANDING_WORKLOAD_ID} 79`, "the standing workload takes no test-pr binding"],
			[`test-pr ${wl}`, "test-pr names at least one PR number: test-pr <wl-…> <N> [<N> …]"],
			[`test-pr ${wl} 79 0`, "0 is not a PR number (a positive whole number): test-pr <wl-…> <N> [<N> …]"],
			[`test-pr ${wl} -1`, "-1 is not a PR number (a positive whole number): test-pr <wl-…> <N> [<N> …]"],
			[`test-pr ${wl} #79`, "#79 is not a PR number (a positive whole number): test-pr <wl-…> <N> [<N> …]"],
			[`test-pr ${wl} 7a`, "7a is not a PR number (a positive whole number): test-pr <wl-…> <N> [<N> …]"],
			[`test-pr ${wl} 079`, "079 is not a PR number (a positive whole number): test-pr <wl-…> <N> [<N> …]"],
			[`test-pr ${wl} ${many}`, `test-pr binds at most ${TEST_PR_MAX} PRs at once; ${TEST_PR_MAX + 1} named`],
		];
		for (const [text, why] of cases) {
			const cmd = interpret(ledger, text);
			expect(cmd).toEqual({ kind: "refused", why });
			expect(() => apply(ledger, cmd!)).toThrow("refused, never applied");
		}
		for (const w of [wl, closed, STANDING_WORKLOAD_ID]) expect(written(ledger, w)).toEqual([]);
		// exactly the cap is accepted
		const cap = Array.from({ length: TEST_PR_MAX }, (_, k) => k + 1);
		expect(interpret(ledger, `test-pr ${wl} ${cap.join(" ")}`)).toEqual({ kind: "test-pr", workloadId: wl, prs: cap });
	});

	test("apply checks the workload again: closed between the reading and the apply, it throws and writes nothing", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const cmd = interpret(ledger, `test-pr ${wl} 79`)!;
		ledger.completeSlice(sl, { by: "lane-a", artifact: "done" });
		ledger.closeWorkload(wl, { by: SURFACE_BY });
		expect(() => apply(ledger, cmd)).toThrow(`${wl} is closed: only an open workload is bound`);
		expect(written(ledger, wl)).toEqual([]);
	});

	test("a test-pr line of any length is command-shaped and never a numbered batch", () => {
		const long = `test-pr wl-x ${Array.from({ length: TEST_PR_MAX }, (_, k) => k + 1).join(" ")}`;
		expect(maxWords(long)).toBe(Number.POSITIVE_INFINITY);
		expect(commandShaped(long)).toBe(true);
		expect(commandShaped("test-pr wl-mv5o6dxc009tz4 79 70 73 76 94 95 68 75 72 74")).toBe(true);
		expect(commandShaped("test-pr")).toBe(true);
		expect(parseBatch("test-pr wl-x 79, 70")).toBeNull();
		expect(parseBatch("test-pr wl-x 79")).toBeNull();
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		expect(interpretBatch(ledger, numbered(ledger), `test-pr ${wl} 79, 70`)).toBeNull();
	});

	test("in a paste a test-pr line is a command: applied in order with the others; a refused one refuses the paste", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const numbering = numbered(ledger);
		const r = interpretPaste(ledger, numbering, `production ${wl}\ntest-pr ${wl} 79, 70\nthen run it`);
		expect(r).toEqual({
			ok: true,
			items: [
				{ line: 1, text: `production ${wl}`, kind: "command", cmd: { kind: "stakes", workloadId: wl, stakes: "production" } },
				{ line: 2, text: `test-pr ${wl} 79, 70`, kind: "command", cmd: { kind: "test-pr", workloadId: wl, prs: [79, 70] } },
				{ kind: "instruction", from: 3, to: 3, text: "then run it" },
			],
		});
		if (!r?.ok) throw new Error("not accepted");
		ledger.write(() => r.items.flatMap((i) => (i.kind === "command" ? [apply(ledger, i.cmd)] : [])));
		expect(boundPrs(ledger.entries(wl), ledger.instructions(wl)).map((b) => b.pr)).toEqual([79, 70]);
		expect(interpretPaste(ledger, numbering, `normal ${wl}\ntest-pr ${wl} 79 x`)).toEqual({
			ok: false,
			refused: [{ line: 1, text: `normal ${wl}`, why: null }, { line: 2, text: `test-pr ${wl} 79 x`, why: ["x is not a PR number (a positive whole number): test-pr <wl-…> <N> [<N> …]"] }],
			held: [],
		});
	});
});
