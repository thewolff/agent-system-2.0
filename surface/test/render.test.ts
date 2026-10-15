// The wake render (§ B7) and the five § B3 lines, the § A3 hold, the M11 due row, the test runner's
// failed-run line (MIGRATION.md item 24), identity and the stakes/mode one-liner, all from ledger state.
import { describe, expect, test } from "bun:test";
import { TEST_RUNNER_BY } from "../../ledger/src/index";
import { consumeLines } from "../src/delivery";
import { errorLines, parseDue, reservedStates, waitingReserved } from "../src/errors";
import { ensureStandingWorkload, identityOf, recordIdentity } from "../src/identity";
import { laneExitBody, planFirstBody } from "../src/launch";
import { Numbering } from "../src/numbering";
import { oneLiner, renderWake } from "../src/render";
import { artifactFailures, laneDiedShutdownBody } from "../src/signals";
import { testRequestedBody, type TestRun, testRunBody, testRunFailedBody, testRunFailedOf } from "../src/test-run";
import { ARTIFACT_FAILED_PREFIX, LEDGER_TOOL, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, workloadWithSlice } from "./helpers";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";

/** An 8-line plan question in PLAN wl-muq22rnjcfrrpc D7's shape, well over the 120-character cut. */
const PLAN_LINES = [
	"/Users/jo/agent-scratch/wl-x/PLAN.md",
	"- sl-flip: plan-first by default unless the judge says change-small at 0.9 or Jo says no plan",
	"- sl-inline: the plan question carries the plan, one line per slice, checked by lane_raise_question",
	"- sl-docs: SPEC § B6, the lane tier file and MIGRATION.md item 42",
	"- sl-review: a cross-lab review of the whole diff",
	"tradeoff: more plans on small work, fewer large changes without one",
	"tradeoff: the lane writes the summary; nothing is extracted from PLAN.md",
	"review: approve-as-is, openai-codex/gpt-6-sol, /Users/jo/agent-scratch/wl-x/PLAN-REVIEW-r9.md",
];
const PLAN_BODY = PLAN_LINES.join("\n");
const PLAN_ASK = ["approve", "revise", "cancel"];

/**
 * A workload held by lane-a whose first slice raised the 8-line plan question; `planFirst` writes the
 * surface's `plan: first`, and `marker` is who writes `plan-question: <id>` in the question's
 * transaction (lane_raise_question writes it as the holder; null writes none).
 */
function planQuestion(ledger: Ledger, over: { planFirst?: boolean; marker?: string | null } = {}) {
	const { wl, sl } = workloadWithSlice(ledger);
	if (over.planFirst ?? true) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
	const marker = over.marker === undefined ? "lane-a" : over.marker;
	const q = ledger.write(() => {
		const id = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: PLAN_BODY, options: PLAN_ASK });
		if (marker !== null) ledger.recordEntry({ by: marker, workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${id}` });
		return id;
	});
	return { wl, sl, q };
}

/** The needs-you line `errorLines` writes with a body cut at 120 (surface/src/errors.ts `short`). */
const cutLine = (wl: string, q: string, sl: string) =>
	`lane on ${wl} is waiting on you (${q}, slice ${sl}): ${PLAN_BODY.slice(0, 119)}… — answer with one word: approve / revise / cancel (or \`withdraw\`)`;

describe("needs-you lines (§ B3, § A3, M11)", () => {
	test("nothing open renders a needs-you block that says nothing, and no workloads", () => {
		const { ledger } = tempLedger();
		const r = renderWake(ledger, { trigger: "session-start" });
		expect(r.lines).toEqual([]);
		expect(r.text).toContain("## needs you\nnothing:");
		expect(r.text).toContain("## open workloads\nnone");
		expect(r.text).toContain("no identity row yet");
	});

	test("line 5: an open question renders at once with its options; answered, it is gone and the slice is open again", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Token name?", options: ["header-offset", "nav-offset"] });
		const lines = errorLines(ledger);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ kind: "question", rowId: q, options: ["header-offset", "nav-offset"] });
		expect(lines[0]!.line).toContain("header-offset / nav-offset");
		expect(ledger.slice(sl)!.state).toBe("paused");
		ledger.answerQuestion(q, { by: "surface", answer: "header-offset", author: "jo", channel: "surface" });
		expect(errorLines(ledger)).toEqual([]);
		expect(ledger.slice(sl)!.state).toBe("open");
	});

	test("a plan question offering approve shows whole: the path on the line beneath the q- id, every other line indented under it, the answer tail last (PLAN wl-muq22rnjcfrrpc D8, PLAN wl-mv61a8dh4aeneo D2)", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = planQuestion(ledger);
		const r = renderWake(ledger);
		const whole = `- #1 lane on ${wl} is waiting on you (${q}, slice ${sl}):\n  ${PLAN_LINES.join("\n  ")} — answer with one word: approve / revise / cancel (or \`withdraw\`)`;
		expect(r.text).toContain(`\n${whole}\n`);
		expect(r.lines.map((l) => l.line)).toEqual([whole.slice("- #1 ".length)]);
		// the workload block starts the body on the line beneath the q- id the same way
		expect(r.text).toContain(`\n- ${q} on ${sl}:\n  ${PLAN_LINES.join("\n  ")} — options: approve / revise / cancel\n`);
	});

	test("controls: a question on a workload that is not plan-first, and one whose plan-question: entry no holder wrote, keep the 120-character cut", () => {
		for (const over of [{ planFirst: false }, { marker: "lane-x" }, { marker: null }]) {
			const { ledger } = tempLedger();
			const { wl, sl, q } = planQuestion(ledger, over);
			expect(errorLines(ledger).map((l) => l.line)).toEqual([cutLine(wl, q, sl)]);
		}
	});

	test("line 2: a held message surfaces at four hours, not before; the line carries the age", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		ledger.enqueue({ by: "surface", workloadId: wl, sliceId: sl, sender: "jo", recipient: "lane-a", body: "use the token" });
		c.plusHours(3.9);
		expect(errorLines(ledger, undefined, { now: c.now() }).filter((l) => l.kind === "held")).toEqual([]);
		c.plusHours(0.2);
		const held = errorLines(ledger, undefined, { now: c.now() }).filter((l) => l.kind === "held");
		expect(held).toHaveLength(1);
		expect(held[0]!.line).toMatch(/^held 4\.1h on wl-/);
	});

	test("line 2 second form: open slices, no lane, no activity for four hours", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		workloadWithSlice(ledger);
		c.plusHours(5);
		const held = errorLines(ledger, undefined, { now: c.now() }).filter((l) => l.kind === "held");
		expect(held).toHaveLength(1);
		expect(held[0]!.line).toContain("1 open slice(s), no lane");
	});

	test("line 3: a slice surfaces after two artifact-failed messages, not one; a done slice never does", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const fail = () => ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} bun test exit 1` });
		fail();
		expect(artifactFailures(ledger, wl).get(sl)?.n).toBe(1);
		expect(errorLines(ledger).filter((l) => l.kind === "artifact")).toEqual([]);
		fail();
		const lines = errorLines(ledger).filter((l) => l.kind === "artifact");
		expect(lines).toHaveLength(1);
		expect(lines[0]!.line).toContain("failed its runtime artifact 2 times");
		ledger.completeSlice(sl, { by: "lane-a", artifact: "bun test exit 0" });
		expect(errorLines(ledger).filter((l) => l.kind === "artifact")).toEqual([]);
	});

	test("line 4: a lane whose lease lapsed is reported dead; a live lease is not", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		expect(errorLines(ledger, undefined, { now: c.now() }).filter((l) => l.kind === "lane-died")).toEqual([]);
		c.plusHours(2);
		const dead = errorLines(ledger, undefined, { now: c.now() }).filter((l) => l.kind === "lane-died");
		expect(dead).toHaveLength(1);
		expect(dead[0]!.line).toContain("lane lane-a on wl-");
	});

	test("line 1: a reserved request waits until an instruction names it; `approve <id>` clears it", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push to main" });
		expect(waitingReserved(ledger, wl).map((r) => r.id)).toEqual([en]);
		const line = errorLines(ledger).find((l) => l.kind === "reserved")!;
		expect(line.line).toContain(`approve ${en}`);
		ledger.recordInstruction({ by: "surface", workloadId: wl, body: `approve ${en}`, author: "jo", channel: "surface" });
		expect(waitingReserved(ledger, wl)).toEqual([]);
	});

	test("due: a scheduled row is listed once past due and not before; parseDue rejects a bad date", () => {
		const c = clock("2026-10-30T00:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		ledger.openWorkload({ by: "surface", brief: "due:2026-10-31 re-measure the classifier threshold; method = routing_review", stakes: "throwaway", mode: "autonomous" });
		expect(errorLines(ledger, undefined, { now: c.now() })).toEqual([]);
		c.at("2026-10-31T00:00:01.000Z");
		const due = errorLines(ledger, undefined, { now: c.now() });
		expect(due).toHaveLength(1);
		expect(due[0]!.kind).toBe("due");
		expect(due[0]!.line).toContain("re-measure the classifier threshold");
		expect(parseDue("due:notadate do it")).toBeNull();
		expect(parseDue("fix the feed")).toBeNull();
	});

	test("order is § B3 order: reserved, held, artifact, lane-died, question, then due", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl2, body: "which?", options: ["a", "b"] });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy" });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} 1` });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} 2` });
		// the held-message form: the workload-level form is left out while a question or a reserved request carries the workload (PLAN wl-mv8wzipdczs2rk D3)
		ledger.enqueue({ by: "surface", workloadId: wl, sliceId: sl, sender: "jo", recipient: "lane-a", body: "use the token" });
		ledger.openWorkload({ by: "surface", brief: "due:2020-01-01 overdue thing", stakes: "throwaway", mode: "autonomous" });
		c.plusHours(5);
		expect(errorLines(ledger, undefined, { now: c.now() }).map((l) => l.kind)).toEqual(["reserved", "held", "artifact", "question", "due"]);
	});
});

describe("needs-you: the test runner's failed run on an unheld workload (MIGRATION.md item 24, PLAN § 2.5)", () => {
	const SHA = "c0ffee1".padEnd(40, "0");
	/** An open workload with a full-suite slice and no lane; `run` writes the runner's request, result and (when not green) its message. */
	function unheld() {
		const c = clock("2026-10-08T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		let n = 0;
		const run = (verdict: TestRun["verdict"], o: { failures?: string[]; by?: string } = {}) => {
			const runId = `tr-${++n}`;
			c.plusHours(0.1);
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr: 7, sha: SHA, slice: sl, by: "lane-a" }) });
			c.plusHours(0.1);
			const names = o.failures ?? (verdict === "red" ? ["x.test.ts > broken", "y.test.ts > also"] : []);
			const t: TestRun = {
				runId, verdict, sha: SHA, pr: 7, reason: verdict === "error" ? "runner died" : null, headAtEnd: SHA, base: null, mergeBase: null,
				full: verdict === "error" ? null : { pass: 5, fail: names.length, skip: 0, exit: names.length ? 1 : 0, ms: 900, error: null }, solo: [],
				failures: names.map((name) => ({ part: "full", name, firstError: "error: nope" })), runDir: `/runs/${runId}`, preflight: "ok",
			};
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRunBody(t) });
			const failed = testRunFailedOf(wl, sl, t);
			const by = o.by ?? TEST_RUNNER_BY;
			return failed ? ledger.enqueue({ by, workloadId: wl, sliceId: sl, sender: by, recipient: "orchestrator", body: testRunFailedBody(failed) }) : null;
		};
		const lines = () => errorLines(ledger, undefined, { now: c.now() }).filter((l) => l.kind === "test-run");
		return { c, ledger, wl, sl, run, lines };
	}

	test("shows once for an unheld red: the line names verdict, sha7, count, first failing and the run dir; consuming it clears it", () => {
		const { ledger, wl, run, lines } = unheld();
		const m = run("red")!;
		const shown = lines();
		expect(shown).toEqual([{ kind: "test-run", workloadId: wl, rowId: m, messageIds: [m], line: `full suite red on ${wl} at c0ffee1: 2 failing, first x.test.ts > broken — relaunch to fix (/runs/tr-1)` }]);
		expect(consumeLines(ledger, shown)).toBe(1);
		expect(ledger.message(m)!.state).toBe("delivered");
		expect(lines()).toEqual([]);
	});

	test("clears on a newer green; a later red shows again with its own run dir, and an error with no failing name reads plainly", () => {
		const { run, lines, wl } = unheld();
		const first = run("red")!;
		expect(lines()).toHaveLength(1);
		expect(run("green")).toBeNull();
		expect(lines()).toEqual([]);
		const m = run("red", { failures: ["z.test.ts > late"] })!;
		expect(lines().map((l) => [l.rowId, l.line])).toEqual([[m, `full suite red on ${wl} at c0ffee1: 1 failing, first z.test.ts > late — relaunch to fix (/runs/tr-3)`]]);
		const e = run("error")!;
		const [line] = lines();
		expect(line!.rowId).toBe(e);
		expect(line!.line).toBe(`full suite error on ${wl} at c0ffee1: 0 failing — relaunch to fix (/runs/tr-4)`);
		// one line per workload, the newest; a delivery consumes every held one behind it, the cleared first red too
		expect(line!.messageIds).toEqual([first, m, e]);
	});

	test("hidden while a lane holds the workload under a live lease, shown again once that lease lapses; a message the runner did not write is ignored", () => {
		const { c, ledger, wl, run, lines } = unheld();
		run("red", { by: "lane-a" });
		expect(lines()).toEqual([]);
		const m = run("red")!;
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		expect(lines()).toEqual([]);
		c.plusHours(2);
		expect(lines().map((l) => [l.rowId, l.messageIds])).toEqual([[m, [m]]]);
	});

	test("sits after the artifact lines and before a lane death in the needs-you order", () => {
		const { ledger, wl, sl, run } = unheld();
		ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} 1` });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} 2` });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: "orchestrator", body: "lane-died: lane-a: session shutdown at 2026-10-08T10:00:00.000Z with 1 open slice(s)" });
		run("red");
		expect(errorLines(ledger).map((l) => l.kind)).toEqual(["artifact", "test-run", "lane-died"]);
	});
});

describe("held reserved requests: repeat and self-close (MIGRATION.md item 31)", () => {
	const call = (id: string) => `kubectl delete: eval: const repo = "x" (P-11 row 6 refused tool call ${id})`;
	/** A workload held by lane-a, with a clock at 18:00Z. */
	function held() {
		const c = clock("2026-10-01T18:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		const request = (id: string, by = "lane-a") => ledger.recordEntry({ by, workloadId: wl, sliceId: sl, kind: "reserved-request", body: call(id) });
		const decide = (word: "approve" | "deny", en: string) => ledger.recordInstruction({ by: "surface", workloadId: wl, body: `${word} ${en}`, author: "jo", channel: "surface" });
		const reservedLines = () => errorLines(ledger, undefined, { now: c.now() }).filter((l) => l.kind === "reserved");
		return { c, ledger, wl, request, decide, reservedLines };
	}

	test("a repeat of an approved call names it with Jo's UTC time, before the approve/deny hint", () => {
		const { c, request, decide, reservedLines } = held();
		const a = request("c1");
		decide("approve", a);
		c.at("2026-10-01T18:07:00.000Z");
		const b = request("c2");
		const lines = reservedLines();
		expect(lines.map((l) => l.rowId)).toEqual([b]);
		expect(lines[0]!.line).toEndWith(`: kubectl delete: eval: const repo = "x" (P-11 row 6 refused tool call c2) — same call as ${a}, approved 18:00 — \`approve ${b}\` or \`deny ${b}\``);
	});

	test("a repeat of a denied call says denied with its time; a different call is no repeat", () => {
		const { c, ledger, wl, request, decide, reservedLines } = held();
		const a = request("c1");
		c.at("2026-10-01T18:02:30.000Z");
		decide("deny", a);
		const b = request("c2");
		const other = ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "reserved-request", body: "deploy: fly deploy (P-11 row 6 refused tool call c3)" });
		const lines = reservedLines();
		expect(lines.find((l) => l.rowId === b)!.line).toContain(`— same call as ${a}, denied 18:02 — \`approve ${b}\``);
		expect(lines.find((l) => l.rowId === other)!.line).not.toContain("same call as");
	});

	test("a later repeat supersedes a waiting request: only the newest shows, naming the earliest as superseded", () => {
		const { ledger, wl, request, reservedLines } = held();
		const a = request("c1");
		const b = request("c2");
		const c3 = request("c3");
		expect(waitingReserved(ledger, wl).map((r) => r.id)).toEqual([c3]);
		expect(reservedStates(ledger, wl).map((r) => r.state)).toEqual([{ kind: "superseded", by: b }, { kind: "superseded", by: c3 }, { kind: "waiting" }]);
		expect(reservedLines().map((l) => l.line)).toEqual([expect.stringContaining(`— same call as ${a} (superseded) — \`approve ${c3}\``)]);
	});

	test("the raising lane stops holding (release, handoff): its requests close; a relaunch under a new lane id repeating it names the closed one", () => {
		const { ledger, wl, request, reservedLines } = held();
		const a = request("c1");
		expect(reservedLines()).toHaveLength(1);
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		expect(reservedLines()).toEqual([]);
		expect(reservedStates(ledger, wl)[0]!.state).toEqual({ kind: "lane-stopped", lane: "lane-a" });
		expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-b", leaseMs: 3_600_000 }).won).toBe(true);
		expect(reservedLines()).toEqual([]);
		const b = request("c2", "lane-b");
		expect(reservedLines().map((l) => l.line)).toEqual([expect.stringContaining(`— same call as ${a}, closed (lane-a stopped holding) — \`approve ${b}\``)]);
		ledger.handoffWorkload(wl, { by: "lane-b", holder: "lane-b", to: "jo" });
		expect(reservedLines()).toEqual([]);
	});

	test("a request from a session that never held the workload stays waiting (an unbound session's lane-<pid> on the standing workload)", () => {
		const { ledger } = tempLedger();
		const standing = ensureStandingWorkload(ledger);
		const en = ledger.recordEntry({ by: "lane-4242", workloadId: standing, kind: "reserved-request", body: call("c1") });
		expect(waitingReserved(ledger, standing).map((r) => r.id)).toEqual([en]);
		expect(errorLines(ledger).filter((l) => l.kind === "reserved").map((l) => l.rowId)).toEqual([en]);
	});

	test("a holder's reserved-withdrawn: closes the request and a repeat says withdrawn with its time; one by a non-holder is ignored", () => {
		const { c, ledger, wl, request, reservedLines } = held();
		const a = request("c1");
		ledger.recordEntry({ by: "lane-x", workloadId: wl, kind: "assumption", body: `reserved-withdrawn: ${a} forged` });
		expect(reservedLines().map((l) => l.rowId)).toEqual([a]);
		c.at("2026-10-01T18:11:00.000Z");
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: `reserved-withdrawn: ${a} went another way` });
		expect(reservedLines()).toEqual([]);
		expect(reservedStates(ledger, wl)[0]!.state).toMatchObject({ kind: "withdrawn", by: "lane-a", reason: "went another way" });
		const b = request("c2");
		expect(reservedLines().map((l) => l.line)).toEqual([expect.stringContaining(`— same call as ${a}, withdrawn 18:11 — \`approve ${b}\``)]);
	});
});

describe("render and one-liner (§ B7, § A1.2, § B13.1)", () => {
	test("the render carries the one-liner, slices, open questions regardless of last-N, pending messages with states, and the last N entries", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger, { stakes: "production", mode: "user-driven" });
		for (let i = 0; i < 12; i++) ledger.recordInstruction({ by: "lane-a", workloadId: wl, body: `note ${i}`, author: "jo", channel: "direct" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token?", options: ["x", "y"] });
		const m = ledger.enqueue({ by: "surface", workloadId: wl, sender: "jo", recipient: "lane-a", body: "go" });
		ledger.advanceMessage(m, "delivered", { by: "lane-a" });
		const r = renderWake(ledger, { lastN: 3 });
		expect(r.text).toContain(`## ${wl}`);
		expect(r.text).toContain("stakes: production · mode: user-driven");
		expect(r.text).toContain(`- ${sl} [paused] Move the header offset`);
		expect(r.text).toContain(`- ${q} on ${sl}: Which token? — options: x / y`);
		expect(r.text).toContain(`- ${m} [delivered] jo → lane-a: go`);
		expect(r.text).toContain("last 3 ledger entries:");
		expect(r.text).toContain("note 11");
		expect(r.text).not.toContain("note 8");
		expect(r.text.indexOf("## needs you")).toBeLessThan(r.text.indexOf(`## ${wl}`));
		expect(r.text).not.toContain(`## ${STANDING_WORKLOAD_ID}`);
	});

	test("a wake renders one line per open workload and no block; the on-demand read of one workload still renders its whole block", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger, { stakes: "production", mode: "user-driven" });
		const other = ledger.openWorkload({ by: "surface", brief: "Second workload\nwith a second brief line", stakes: "normal", mode: "autonomous" });
		for (let i = 0; i < 12; i++) ledger.recordInstruction({ by: "lane-a", workloadId: wl, body: `note ${i}`, author: "jo", channel: "direct" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token?", options: ["x", "y"] });
		const m = ledger.enqueue({ by: "surface", workloadId: wl, sender: "jo", recipient: "lane-a", body: "go" });
		const wake = renderWake(ledger, { trigger: "compaction" });
		const workloadLines = wake.text.split("\n").filter((l) => l.startsWith("- wl-"));
		expect(workloadLines).toHaveLength(2);
		const n = wake.lines.find((l) => l.rowId === q)!.n;
		expect(workloadLines.find((l) => l.startsWith(`- ${wl}: `))).toMatch(
			new RegExp(`^- ${wl}: .+ · stakes: production · mode: user-driven · ceiling .+ · lane: none · slices: 1 paused · needs you: #${n} · open questions: ${q} · 1 message\\(s\\) not yet acted on$`),
		);
		expect(workloadLines.find((l) => l.startsWith(`- ${other}: `))).toContain(`- ${other}: Second workload · stakes: normal · mode: autonomous`);
		expect(wake.text).toContain(`${LEDGER_TOOL} with workload: <wl-…>`);
		// no block: no block heading, no slice task, no question options, no message body, no recent entries
		expect(wake.text).not.toContain(`## ${wl}`);
		expect(wake.text).not.toContain("brief:");
		expect(wake.text).not.toContain("Move the header offset");
		expect(wake.text).not.toContain("options: x / y");
		expect(wake.text).not.toContain(m);
		expect(wake.text).not.toContain("ledger entries:");
		expect(wake.text.indexOf("## needs you")).toBeLessThan(wake.text.indexOf("## open workloads"));
		// the on-demand read of one workload (surface/extensions/wake.ts LEDGER_TOOL): the whole block, as before
		const one = renderWake(ledger, { heading: `read on demand: ${wl}`, workloadId: wl });
		expect(one.text).toContain(`## ${wl}`);
		expect(one.text).toContain(`- ${sl} [paused] Move the header offset`);
		expect(one.text).toContain(`- ${q} on ${sl}: Which token? — options: x / y`);
		expect(one.text).toContain(`- ${m} [held] jo → lane-a: go`);
		expect(one.text).toContain("note 11");
		expect(one.text).not.toContain(`## ${other}`);
	});

	test("needs-you bullets carry #n on answerable lines: 1..k in line order by default, the passed numbering's numbers when given", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token?", options: ["x", "y"] });
		const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push to main" });
		const fresh = renderWake(ledger);
		expect(fresh.text).toContain("\n- #1 reserved action waiting on you");
		expect(fresh.text).toContain("\n- #2 lane on");
		expect(fresh.lines.map((l) => [l.rowId, l.n])).toEqual([[en, 1], [q, 2]]);
		const numbering = new Numbering();
		numbering.assign(errorLines(ledger).reverse()); // the question seen first: q is #1, the request #2
		const r = renderWake(ledger, { numbering });
		expect(r.text).toContain("\n- #2 reserved action waiting on you");
		expect(r.text).toContain("\n- #1 lane on");
		expect(r.text).not.toContain("#3");
	});

	test("a mode flip shows as pending until a mode-effective entry with the new mode lands after it", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		expect(oneLiner(ledger, ledger.workload(wl)!)).toContain("mode: autonomous — flip either with one word");
		ledger.flipMode(wl, { by: "surface", mode: "user-driven", author: "jo", channel: "surface" });
		expect(oneLiner(ledger, ledger.workload(wl)!)).toContain("mode: user-driven (flip pending");
		c.plusHours(0.01);
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "mode-effective", body: "user-driven" });
		expect(oneLiner(ledger, ledger.workload(wl)!)).toContain("mode: user-driven — flip");
	});

	test("identity: none on first wake; recorded on the standing workload; the newest wins; parentheses refused", () => {
		const { ledger } = tempLedger();
		expect(identityOf(ledger)).toBeNull();
		const first = recordIdentity(ledger, "Sable", "they/them");
		expect(ledger.workload(STANDING_WORKLOAD_ID)?.status).toBe("open");
		expect(ledger.entries(STANDING_WORKLOAD_ID, "assumption").map((e) => e.body)).toEqual(["identity: Sable (they/them)"]);
		expect(identityOf(ledger)).toMatchObject({ name: "Sable", pronouns: "they/them", entryId: first.entryId });
		recordIdentity(ledger, "Wren", "she/her");
		expect(identityOf(ledger)?.name).toBe("Wren");
		expect(() => recordIdentity(ledger, "A (b)", "x")).toThrow(/parentheses/);
		expect(ensureStandingWorkload(ledger)).toBe(STANDING_WORKLOAD_ID);
		expect(renderWake(ledger).text).toContain("you are Wren (she/her)");
	});
});

describe("a lane that ended on purpose with work open and nobody holding it (MIGRATION.md item 68)", () => {
	/**
	 * Item 24's shape on 2026-10-09: lane-a launched by the starter, two slices open, parked by hand
	 * (released, `lane-exit: … outcome completed`), no question. Returns the exit entry id.
	 */
	function endedLane(ledger: Ledger, outcome = "completed") {
		const { wl, sl } = workloadWithSlice(ledger);
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by surface" });
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		const exit = ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-a", { code: 0, signal: null, outcome }) });
		return { wl, sl, sl2, exit };
	}
	const idle = (ledger: Ledger) => errorLines(ledger).filter((l) => l.kind === "idle");

	test("lane-exit completed, two open slices, no question, no holder: one idle line keyed by the exit entry, not numbered", () => {
		const { ledger } = tempLedger();
		const { wl, exit } = endedLane(ledger);
		const lines = new Numbering().assign(errorLines(ledger));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ kind: "idle", workloadId: wl, rowId: exit, line: `lane lane-a on ${wl} ended (completed) with 2 open slice(s) and no question; relaunch, close, or instruct` });
		expect(lines[0]!.n).toBeUndefined();
		expect(lines[0]!.state).toBeUndefined();
	});

	test("parked and released are intended ends too; a spend: or ctx-index: landing after the exit does not hide it", () => {
		for (const outcome of ["parked", "released"]) {
			const { ledger } = tempLedger();
			const { wl } = endedLane(ledger, outcome);
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-a usd 1 tokens 10 wall-min 2" });
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "ctx-index: lane-a indexed" });
			expect(idle(ledger).map((l) => l.line)).toEqual([expect.stringContaining(`ended (${outcome}) with 2 open slice(s)`)]);
		}
	});

	test("not idle: a held workload, one with an open question, one whose lane died, one being relaunched, a closed one", () => {
		const held = tempLedger().ledger;
		const h = endedLane(held);
		expect(held.claimWorkload(h.wl, { by: "lane-starter", holder: "lane-b", leaseMs: 3_600_000 }).won).toBe(true);
		expect(idle(held)).toEqual([]);

		const asking = tempLedger().ledger;
		const a = endedLane(asking);
		asking.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "which?", options: ["x", "y"] });
		expect(errorLines(asking).map((l) => l.kind)).toEqual(["question"]);

		// a death: the runner's exit is `died` (unintended) and the lane-died: row is the line
		const dead = tempLedger().ledger;
		const { wl, sl } = workloadWithSlice(dead);
		dead.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-a", "2026-10-09T03:13:00.000Z", 1) });
		dead.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-a", { code: 1, signal: null, outcome: "died" }) });
		expect(errorLines(dead).map((l) => l.kind)).toEqual(["lane-died"]);

		// a launch: after the exit: a lane is on its way
		const relaunching = tempLedger().ledger;
		const r = endedLane(relaunching);
		relaunching.recordEntry({ by: LANE_STARTER_BY, workloadId: r.wl, kind: "assumption", body: "launch: lane-b cause first requested-by surface" });
		expect(idle(relaunching)).toEqual([]);

		const closed = tempLedger().ledger;
		const c = endedLane(closed);
		closed.completeSlice(c.sl, { by: "lane-a", artifact: "done" });
		closed.completeSlice(c.sl2, { by: "lane-a", artifact: "done" });
		closed.closeWorkload(c.wl, { by: SURFACE_BY });
		expect(errorLines(closed)).toEqual([]);
	});

	test("the wake render lists it under needs you, and the nothing line names the case", () => {
		const { ledger } = tempLedger();
		expect(renderWake(ledger).text).toContain("no lane died, no lane left work idle, no lane waiting on you");
		const { wl } = endedLane(ledger);
		const r = renderWake(ledger);
		expect(r.text).toContain(`## needs you\n- lane lane-a on ${wl} ended (completed) with 2 open slice(s) and no question; relaunch, close, or instruct\n`);
	});
});

describe("the workload-level held line after a lane ended (PLAN wl-mv8wzipdczs2rk D3)", () => {
	/**
	 * lane-a launched by the starter, claimed, released, and the runner's `lane-exit: … outcome <outcome>`;
	 * `open` slices left open (the rest completed), `receipt` a holder's `done-because:` before the exit; then 5 h pass.
	 */
	function ended(outcome: string, o: { open: number; receipt?: boolean }) {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(ledger);
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by surface" });
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		for (const s of [sl, sl2].slice(0, 2 - o.open)) ledger.completeSlice(s, { by: "lane-a", artifact: "bun test exit 0" });
		if (o.receipt) ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: "done-because: bun test passes on the PR head" });
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-a", { code: 0, signal: null, outcome }) });
		c.plusHours(5);
		return { wl, lines: errorLines(ledger, undefined, { now: c.now() }).map((l) => l.line) };
	}

	test("(d) intended exit with open slices: the idle line only, no held line beside it", () => {
		const { wl, lines } = ended("completed", { open: 2 });
		expect(lines).toEqual([`lane lane-a on ${wl} ended (completed) with 2 open slice(s) and no question; relaunch, close, or instruct`]);
	});

	test("(e) intended exit, no open slice, a holder's done-because: recorded: awaiting close, no line", () => {
		expect(ended("completed", { open: 0, receipt: true }).lines).toEqual([]);
	});

	test("kept: intended exit (completed, and stop at the ceiling), no open slice, no done-because:: the held line", () => {
		for (const outcome of ["completed", "stop"]) {
			const { wl, lines } = ended(outcome, { open: 0 });
			expect(lines).toEqual([expect.stringMatching(new RegExp(`^held 5h on ${wl}: 0 open slice\\(s\\), no lane, no activity since `))]);
		}
	});

	test("kept: an unintended exit (open-work, error) with open slices: the held line, no idle line", () => {
		for (const outcome of ["open-work", "error"]) {
			const { wl, lines } = ended(outcome, { open: 2 });
			expect(lines).toEqual([expect.stringMatching(new RegExp(`^held 5h on ${wl}: 2 open slice\\(s\\), no lane, no activity since `))]);
		}
	});
});
