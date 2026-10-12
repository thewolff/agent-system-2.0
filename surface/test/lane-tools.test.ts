// The lane's ledger tools and the plan-first / outcome machinery (DESIGN-lane-launcher.md § 8:
// lifecycle transition and plan-first tests), driven through the fake extension API: ownership
// refusals, reserved and pushed prefixes refused with nothing written, plan-first enforcement
// through Jo's answer at the surface, the plan question held until another lab reviewed the plan
// (PLAN wl-mupu0sx2o046io D8, and its D9 round-limit exception), and the terminal pair ending the
// lane without a death.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	handSettledBody, handSpawnBody, laneBuilderBody, PARK_OPTIONS, reviewParkBody, reviewSameLabBody, reviewWithheldBody,
} from "../../classifier/src/lab";
import {
	countRounds, effectiveRoundLimit, ROUND_LIMIT_OPTIONS, reviewLimitBody, reviewLoopEndBody, reviewRoundBody, reviewRoundsExtendBody, roundLimitQuestionBody,
} from "../../classifier/src/rounds";
import { gateSession } from "../../gates/src/session";
import { Ledger, type RoutingOutcome, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines, reservedStates, waitingReserved } from "../src/errors";
import { planReviewRefusal, TEST_RUNNER_SCRIPT } from "../extensions/lane-tools";
import { apply, interpret } from "../src/input";
import { controlEntries, holdersOf, PLAN_OPTIONS, planApprovedBody, planFirst, planFirstBody, doneBody } from "../src/launch";
import { testRequestedBody } from "../src/test-run";
import { releasedOpen } from "../src/turn-end";
import { recordRepo } from "../src/decision-log";
import { LANE_FULL_TEST_TOOL, LANE_READ_FACTS_TOOL, LANE_TOOLS, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, notices, tempLedger, tmp } from "./helpers";

const LANE_MODEL = "anthropic/claude-opus-5-5";
const OTHER_LAB = "openai-codex/gpt-6-astra";

// PLAN wl-muq22rnjcfrrpc D7: the plan file and the review verdict a plan question names are real files.
const PLAN_DIR = tmp("plan");
const PLAN_FILE = join(PLAN_DIR, "PLAN.md");
const VERDICT_FILE = join(PLAN_DIR, "PLAN-REVIEW-r1.md");
writeFileSync(PLAN_FILE, "# PLAN\n");
writeFileSync(VERDICT_FILE, "verdict: approve-as-is\n");
const REVIEW_LINE = `review: approve-as-is, ${OTHER_LAB}, ${VERDICT_FILE}`;
/** A plan-question body in D7's shape: the plan path, `slices` slice lines, `tradeoffs` tradeoff lines, the review line. */
const planBody = (slices = 2, tradeoffs = 1) => [
	PLAN_FILE,
	...Array.from({ length: slices }, (_, i) => `- sl-${i + 1}: slice ${i + 1}, one line`),
	...Array.from({ length: tradeoffs }, (_, i) => `tradeoff: tradeoff ${i + 1}`),
	REVIEW_LINE,
].join("\n");
const PLAN_BODY = planBody();

function laneFixture(over: { planFirst?: boolean; mode?: "autonomous" | "user-driven"; exec?: boolean } = {}) {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: over.mode ?? "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the header offset lives in one token") });
	if (over.planFirst) {
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
		// The classifier's record of the lab the planning lane answered on (D3 item 1): the plan's builder.
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: laneBuilderBody("anthropic", "lane-t-1", LANE_MODEL) });
	}
	ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: `launch: lane-t-1 cause first requested-by test` });
	expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
	const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-t-1", HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: over.exec ?? false });
	orchestratorSurface(f.pi, env, {});
	const ctx = ctxOf();
	const call = async (tool: string, params: Record<string, unknown>) => (await f.tool(tool).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	return { ledger, path, wl, env, f, ctx, call };
}

// The tool opens its own ledger on the real clock (gates/src/session.ts), so the D8 tests order
// their rows by moving the system clock: `tick()` freezes it 5 ms later; each test ends on real time.
const tick = () => setSystemTime(new Date(Date.now() + 5));
afterEach(() => setSystemTime());

let handSeq = 0;

/**
 * One settled review hand on `slice`, written as the classifier writes it (PLAN D2–D6, D9): an
 * optional spent `review-same-lab:` grant, `hand-spawn:`, the judge routing row, `review-withheld:`
 * when asked, `hand-settled:`, and a `review-round:` when `round` is given. Ticks the clock on both
 * sides so its rows sort strictly between the questions before and after it.
 */
function seedReview(
	ledger: Ledger, wl: string, slice: string,
	over: { ran?: string[]; outcome?: RoutingOutcome; withheld?: boolean; grant?: string; group?: string; round?: number; blocking?: number } = {},
): { token: string; routing: string } {
	tick();
	const n = ++handSeq;
	const token = `dt-t${n}`;
	const group = over.group ?? `dg-t${n}`;
	const ran = over.ran ?? [OTHER_LAB];
	const outcome = over.outcome ?? "ran";
	const entry = (body: string) => ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: slice, kind: "assumption", body });
	if (over.grant) entry(reviewSameLabBody(over.grant, token));
	entry(handSpawnBody({ token, root: "/tmp/lane-t-1", spawnKey: slice, review: true, group, row: ran }));
	const routing = ledger.recordRouting({
		by: "lane-t-1", workloadId: wl, sliceId: slice, spawnKey: slice, sessionRoot: "/tmp/lane-t-1", agentId: `${slice}-${n}`,
		kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 }, classifiedTier: "strong", tier: "strong",
		models: ran, judgeModel: "typesafe/jev-1.13.0", outcome, ranModels: outcome === "refused-model-unknown" ? null : ran,
	});
	if (over.withheld) entry(reviewWithheldBody(token));
	entry(handSettledBody(token, routing));
	if (over.round !== undefined) {
		const blocking = over.blocking ?? 0;
		entry(reviewRoundBody({
			slice, round: over.round, token, group, verdict: over.withheld || outcome !== "ran" ? "withheld" : "accepted",
			findings: { counts: { blocking: blocking > 0 ? { correctness: blocking } : {}, major: {}, minor: {} }, titles: [] },
		}));
	}
	tick();
	return { token, routing };
}

/** Jo's answer at the surface, through the ledger module, a tick after what came before. */
function jo(ledger: Ledger, questionId: string, answer: string): string {
	tick();
	return ledger.answerQuestion(questionId, { by: SURFACE_BY, answer, author: "jo", channel: "surface" });
}

describe("lane tools: ownership", () => {
	test("all ten register; an orchestrator session and an unbound lane are refused with nothing written", async () => {
		const { ledger, path, wl } = laneFixture();
		const orch = fakePi();
		orchestratorSurface(orch.pi, { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" }, {});
		for (const t of LANE_TOOLS) expect(orch.registered()).toContain(t);
		const before = ledger.entries(wl).length;
		const r = await orch.tool("lane_record_entry").execute("1", { body: "hello" }, undefined, undefined, ctxOf());
		expect(r.content[0]!.text).toContain("not a lane bound to a workload");
		expect(ledger.entries(wl).length).toBe(before);
	});

	test("a lane that is not the holder under a live lease is refused, naming the holder", async () => {
		const { ledger, wl, call } = laneFixture();
		ledger.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
		expect(ledger.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 }).won).toBe(true);
		expect(await call("lane_record_entry", { body: "mine" })).toContain("held by lane-x, not by this lane (lane-t-1)");
		expect(ledger.entries(wl).some((e) => e.body === "mine")).toBe(false);
	});
});

describe("lane tools: reserved and pushed prefixes are refused and write nothing", () => {
	test("each control prefix through record_entry (except done-because:), message and raise_question", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const before = { entries: ledger.entries(wl).length, held: ledger.workload(wl)!.held_messages, questions: ledger.questions(wl).length };
		for (const p of ["launch", "launch-failed", "launch-requested", "lane-started", "lane-ready", "lane-exit", "lane-parked", "lane-stop", "lane-decided", "worktree", "branch", "plan", "done", "artifact-tree", "reserved-withdrawn", "released-open", "plan-question", "test-requested", "test-run", "push-dest", "orchestrator-spend"]) {
			expect(await call("lane_record_entry", { body: `${p}: forged` })).toContain(`\`${p}:\` is a reserved control line`);
			expect(await call("lane_message", { body: `${p}: forged` })).toContain("reserved control line");
			expect(await call("lane_raise_question", { slice: sl, body: `${p}: forged`, options: ["a", "b"] })).toContain("reserved control line");
		}
		expect(await call("lane_message", { body: "done-because: forged" })).toContain("reserved control line");
		for (const p of ["lane-died:", "prompt-wait:", "prompt-resolved:", "artifact-failed:", "artifact-passed:", "test-run-failed:"]) {
			expect(await call("lane_message", { body: `${p} x` })).toContain("signal the machinery pushes");
		}
		// The classifier's hand lines are not control prefixes, but a lane must not write them as entries either (D6).
		for (const p of ["hand-spawn:", "hand-settled:"]) {
			expect(await call("lane_record_entry", { body: `${p} dt-x routing rt-x` })).toContain(`\`${p}\` is a reserved control line`);
		}
		expect(ledger.entries(wl).length).toBe(before.entries);
		expect(ledger.workload(wl)!.held_messages).toBe(before.held);
		expect(ledger.questions(wl).length).toBe(before.questions);
		// The one allowed control line: the holder's done-because: receipt.
		expect(await call("lane_record_entry", { body: "done-because: the token exists and the header reads it" })).toContain("completion receipt");
		expect(await call("lane_raise_question", { slice: sl, body: "which?", options: ["a", "A"] })).toContain("at least two distinct options");
	});
});

describe("lane_full_test (PLAN wl-muraerdsgw7gn4 § 2.1, § 4)", () => {
	const REPO = join(import.meta.dir, "..", "..");
	const LINE = "test-run tr-0abc1234wxyz runner 4242 sha " + "a".repeat(40) + " slice sl-full-x-1 log /runs/tr-0abc1234wxyz/runner.log";

	test("execs the installed starter from the main checkout with only the PR, the slice and this lane, and returns its line", async () => {
		const { ledger, wl, f, call } = laneFixture({ exec: true });
		expect(TEST_RUNNER_SCRIPT).toBe(join(REPO, "surface", "scripts", "test-runner.ts"));
		f.execs.answer = () => ({ stdout: `starting\n${LINE}\n`, stderr: "", code: 0, killed: false });
		const r = await call(LANE_FULL_TEST_TOOL, { pr: "17" });
		expect(r).toStartWith(LINE);
		expect(r).toContain("arrives as an aside");
		expect(f.execs.calls).toEqual([{ command: "bun", args: [TEST_RUNNER_SCRIPT, "start", wl, "17", "--requested-by", "lane-t-1"], options: { timeout: 30_000 } }]);
		// with an open slice on this workload; a numeric or `#`-prefixed PR is the same PR; extra keys never reach the starter
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "full suite", doneCondition: "green", inputs: "PR" });
		await call(LANE_FULL_TEST_TOOL, { pr: 17, slice: sl, command: "rm -rf /", repo: "evil/repo", sha: "b".repeat(40), env: { PATH: "/tmp" }, path: "/tmp/x.ts" });
		await call(LANE_FULL_TEST_TOOL, { pr: "#17", slice: ` ${sl} ` });
		const expected = [TEST_RUNNER_SCRIPT, "start", wl, "17", "--slice", sl, "--requested-by", "lane-t-1"];
		expect(f.execs.calls.slice(1).map((c) => c.args)).toEqual([expected, expected]);
		// the tool writes nothing itself: the starter is the writer
		expect(ledger.entries(wl).some((e) => e.body.startsWith("test-requested:"))).toBe(false);
	});

	test("a starter refusal, a killed starter and a host without exec return what happened, and say no run started", async () => {
		const { f, call } = laneFixture({ exec: true });
		f.execs.answer = () => ({ stdout: "", stderr: "test-runner: PR #17 is closed, not open\n", code: 1, killed: false });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toBe("No test run started (starter exit 1): test-runner: PR #17 is closed, not open");
		f.execs.answer = () => ({ stdout: "", stderr: "", code: 143, killed: true });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toBe("No test run started (the starter did not return within 30 s and was killed): the starter was killed before it printed");
		f.execs.answer = () => {
			throw new Error("spawn bun ENOENT");
		};
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toContain("the starter could not be run: Error: spawn bun ENOENT");
		const bare = laneFixture();
		expect(await bare.call(LANE_FULL_TEST_TOOL, { pr: "17" })).toContain("host has no exec");
	});

	test("a foreign, closed, paused or malformed slice, a bad PR and a lane that does not hold the workload are refused before any exec", async () => {
		const { ledger, wl, f, call } = laneFixture({ exec: true });
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "another workload", stakes: "normal", mode: "autonomous" });
		const foreign = ledger.addSlice({ by: SURFACE_BY, workloadId: other, task: "t", doneCondition: "d", inputs: "i" });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: foreign })).toBe(`Slice ${foreign} is not on workload ${wl}; nothing was requested.`);
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: "sl-nope" })).toContain("is not on workload");
		const flag = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i", id: "sl-x --requested-by jo" });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: flag })).toContain("is not a slice id the test runner records");
		const done = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		ledger.completeSlice(done, { by: "lane-t-1", artifact: "a" });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: done })).toBe(`Slice ${done} is done, not open; nothing was requested.`);
		const paused = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: paused, body: "green or red?", options: ["green", "red"] });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: paused })).toContain(`Slice ${paused} is paused, not open (a question on it waits on Jo`);
		for (const pr of ["", "abc", "0", "-1", "17; rm", "1.5", "99999999999999999999"]) {
			expect(await call(LANE_FULL_TEST_TOOL, { pr })).toContain("names its PR by number");
		}
		ledger.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
		expect(ledger.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 }).won).toBe(true);
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toContain("held by lane-x, not by this lane (lane-t-1)");
		expect(f.execs.calls).toEqual([]);
	});

	test("lane_complete_slice refuses a slice the runner was asked to settle; a request the lane forged does not count", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "full suite", doneCondition: "green", inputs: "PR" });
		const forgedOn = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "other", doneCondition: "d", inputs: "i" });
		const sha = "a".repeat(40);
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId: "tr-0abc1234aaaa", pr: 17, sha, slice: sl, by: "lane-t-1" }) });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: forgedOn, kind: "assumption", body: testRequestedBody({ runId: "tr-0abc1234bbbb", pr: 17, sha, slice: forgedOn, by: "lane-t-1" }) });
		expect(await call("lane_complete_slice", { slice: sl, artifact: "bun test passed" })).toBe(`the test runner settles ${sl}; call lane_full_test. Nothing was completed.`);
		expect(ledger.slice(sl)!.state).toBe("open");
		expect(await call("lane_complete_slice", { slice: forgedOn, artifact: "done" })).toContain(`Completed slice ${forgedOn}`);
	});

	test("`test-run-failed:` is refused as a body by record_entry, raise_question and message, with nothing written", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const before = { entries: ledger.entries(wl).length, held: ledger.workload(wl)!.held_messages, questions: ledger.questions(wl).length };
		const body = `test-run-failed: ${wl} ${sl} red at ${"a".repeat(40)}: 1 failing`;
		expect(await call("lane_record_entry", { body })).toContain("the test runner's signal");
		expect(await call("lane_raise_question", { slice: sl, body, options: ["a", "b"] })).toContain("the test runner's signal");
		expect(await call("lane_message", { body })).toContain("signal the machinery pushes");
		expect(ledger.entries(wl).length).toBe(before.entries);
		expect(ledger.workload(wl)!.held_messages).toBe(before.held);
		expect(ledger.questions(wl).length).toBe(before.questions);
	});
});

describe("lane_withdraw_reserved (MIGRATION.md item 31)", () => {
	const request = (ledger: Ledger, wl: string, body = "git push --force: git push --force origin main (P-11 row 6 refused tool call c1)") =>
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "reserved-request", body });

	test("withdraws a waiting request as the lane: one reserved-withdrawn: entry, the request stops waiting, the reason reaches the decision log's state", async () => {
		const { ledger, wl, call } = laneFixture();
		const en = request(ledger, wl);
		expect(waitingReserved(ledger, wl).map((r) => r.id)).toEqual([en]);
		expect(await call("lane_withdraw_reserved", { id: en, reason: "went\n another way" })).toContain(`Withdrew reserved request ${en}`);
		const written = ledger.entries(wl).at(-1)!;
		expect([written.kind, written.created_by, written.body]).toEqual(["assumption", "lane-t-1", `reserved-withdrawn: ${en} went another way`]);
		expect(waitingReserved(ledger, wl)).toEqual([]);
		expect(reservedStates(ledger, wl)[0]!.state).toMatchObject({ kind: "withdrawn", by: "lane-t-1", reason: "went another way" });
	});

	test("refuses with nothing written: another workload's request, an unknown id, a decided request, a second withdraw", async () => {
		const { ledger, wl, call } = laneFixture();
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "another", stakes: "normal", mode: "autonomous" });
		const foreign = request(ledger, other);
		const decided = request(ledger, wl, "deploy: fly deploy (P-11 row 6 refused tool call c2)");
		ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `deny ${decided}`, author: "jo", channel: "surface" });
		const en = request(ledger, wl);
		expect(await call("lane_withdraw_reserved", { id: en })).toContain("Withdrew");
		const before = ledger.entries(wl).length;
		expect(await call("lane_withdraw_reserved", { id: foreign })).toContain(`${foreign} is not a reserved request on workload ${wl}`);
		expect(await call("lane_withdraw_reserved", { id: "en-nope" })).toContain("is not a reserved request");
		expect(await call("lane_withdraw_reserved", { id: decided })).toContain("not waiting on Jo (it is denied)");
		expect(await call("lane_withdraw_reserved", { id: en })).toContain("not waiting on Jo (it is withdrawn)");
		expect(ledger.entries(wl).length).toBe(before);
		expect(ledger.entries(other).filter((e) => e.kind === "assumption")).toEqual([]);
	});
});

describe("lane_read_facts (MIGRATION.md item 106, PLAN wl-mv4r19j1q885xc § 2.4)", () => {
	const WEB = "/fixture/web";
	const API = "/fixture/api";
	/** Synthetic M8 facts in the live row shape, on their own workload (the reader reads facts on any workload). */
	const seed = (ledger: Ledger, facts: { n: number; repo: string; src: string; text: string; tag?: string }[]) => {
		const m8 = ledger.openWorkload({ by: SURFACE_BY, brief: "m8 facts", stakes: "normal", mode: "autonomous" });
		for (const f of facts) {
			const body = `m8-fact #${String(f.n).padStart(2, "0")} [${f.tag ?? "m8-sedge-wl-x"}] repo=${f.repo} src=${f.src} :: ${f.text}`;
			ledger.recordEntry({ by: "m8-sedge", workloadId: m8, kind: "assumption", body });
		}
	};
	const webFacts = [
		{ n: 1, repo: WEB, src: `${WEB}/docs/build.md:1-4`, text: "the build uses Bun" },
		{ n: 2, repo: WEB, src: `${WEB}/README.md:10-12`, text: "deploys go through Fly" },
		{ n: 3, repo: WEB, src: `${WEB}/docs/test.md:2-3`, text: "tests run with bun test" },
		{ n: 1, repo: API, src: `${API}/docs/db.md:5-9`, text: "the api keeps its schema in sqlite" },
	];

	test("reads the workload's repo (its repo: entry) by default, and another repo when named", async () => {
		const { ledger, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		const before = ledger.entries(wl).length;
		expect(await call(LANE_READ_FACTS_TOOL, {})).toBe([
			`3 facts for ${WEB}`,
			`- the build uses Bun (${ledger.facts(WEB)[0]!.id}; build.md:1-4)`,
			`- deploys go through Fly (${ledger.facts(WEB)[1]!.id}; README.md:10-12)`,
			`- tests run with bun test (${ledger.facts(WEB)[2]!.id}; test.md:2-3)`,
		].join("\n"));
		expect(await call(LANE_READ_FACTS_TOOL, { repo: "  " })).toStartWith(`3 facts for ${WEB}\n`);
		const api = await call(LANE_READ_FACTS_TOOL, { repo: API });
		expect(api).toBe(`1 facts for ${API}\n- the api keeps its schema in sqlite (${ledger.facts(API)[0]!.id}; db.md:5-9)`);
		expect(ledger.entries(wl).length).toBe(before);
	});

	test("with no repo: entry and no repo named, asks for repo", async () => {
		const { ledger, call } = laneFixture();
		seed(ledger, webFacts);
		const r = await call(LANE_READ_FACTS_TOOL, {});
		expect(r).toContain("has no `repo:` entry");
		expect(r).toContain("name `repo`");
		expect(await call(LANE_READ_FACTS_TOOL, { repo: WEB })).toStartWith(`3 facts for ${WEB}\n`);
	});

	test("a failing default-repo lookup returns the tool's error text, not a rejected call", async () => {
		const { ledger, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		expect(await call(LANE_READ_FACTS_TOOL, {})).toStartWith(`3 facts for ${WEB}\n`);
		// The `repo:` lookup reads entries; the ownership gate reads only the workload row.
		ledger.db.exec("ALTER TABLE entries RENAME TO entries_gone");
		const r = await call(LANE_READ_FACTS_TOOL, {});
		expect(r).toStartWith(`could not read facts for workload ${wl}'s repo (`);
		expect(r).toContain("entries");
	});

	test("match is a case-insensitive substring of text or src, with the N of M match line", async () => {
		const { ledger, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		const bun = (await call(LANE_READ_FACTS_TOOL, { match: "BUN" })).split("\n");
		expect(bun[0]).toBe(`2 of 3 match "BUN" for ${WEB}`);
		expect(bun.slice(1).map((l) => l.split(" (")[0])).toEqual(["- the build uses Bun", "- tests run with bun test"]);
		const readme = (await call(LANE_READ_FACTS_TOOL, { match: "readme" })).split("\n");
		expect(readme[0]).toBe(`1 of 3 match "readme" for ${WEB}`);
		expect(readme[1]).toStartWith("- deploys go through Fly (");
		expect(await call(LANE_READ_FACTS_TOOL, { match: "nothing like it" })).toBe(`0 of 3 match "nothing like it" for ${WEB}`);
		expect(await call(LANE_READ_FACTS_TOOL, { match: "" })).toStartWith(`3 facts for ${WEB}\n`);
	});

	test("has no budget: facts totalling more than 8,000 bytes all come back", async () => {
		const { ledger, wl, call } = laneFixture();
		const many = Array.from({ length: 60 }, (_, i) => ({ n: i + 1, repo: WEB, src: `${WEB}/docs/f${i + 1}.md:1-2`, text: `fact ${i + 1} ${"x".repeat(180)}` }));
		seed(ledger, many);
		recordRepo(ledger, wl, WEB);
		const r = await call(LANE_READ_FACTS_TOOL, {});
		const lines = r.split("\n");
		expect(lines[0]).toBe(`60 facts for ${WEB}`);
		expect(lines.length).toBe(61);
		expect(lines.slice(1).map((l) => l.split(" ")[2])).toEqual(many.map((f) => String(f.n)));
		expect(Buffer.byteLength(r)).toBeGreaterThan(8000);
	});

	test("refused when the caller is not the holder or the session is not a lane", async () => {
		const { ledger, path, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		const orch = fakePi();
		orchestratorSurface(orch.pi, { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" }, {});
		const o = (await orch.tool(LANE_READ_FACTS_TOOL).execute("1", { repo: WEB }, undefined, undefined, ctxOf())).content[0]!.text;
		expect(o).toContain("not a lane bound to a workload; nothing was read");
		expect(o).not.toContain("build uses Bun");
		ledger.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
		expect(ledger.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 }).won).toBe(true);
		const r = await call(LANE_READ_FACTS_TOOL, { repo: WEB });
		expect(r).toContain("held by lane-x, not by this lane (lane-t-1) under a live lease; nothing was read");
		expect(r).not.toContain("build uses Bun");
	});
});

describe("plan-first (decision 15) through the lane tools and Jo's answer", () => {
	test("change-kind refused while the flag stands; judge accepted; approve at the surface writes plan: approved; then change accepted; cancel withdraws", async () => {
		const { ledger, wl, call } = laneFixture({ planFirst: true });
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain("plan-first (your word) and the plan is not approved");
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i" })).toContain("add the plan slice first");
		expect(ledger.slices(wl)).toHaveLength(0);
		const plan = await call("lane_add_slice", { task: "plan the cut", doneCondition: "plan approved", inputs: "brief", kind: "judge" });
		expect(plan).toMatch(/^Added slice sl-/);
		const planId = ledger.slices(wl)[0]!.id;
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain(`the plan slice is ${planId}`);
		seedReview(ledger, wl, planId); // D8: another lab reviewed the plan first
		expect(await call("lane_raise_question", { slice: planId, body: PLAN_BODY, options: ["approve", "revise", "cancel"] })).toContain("Raised question");
		// Jo at the surface: "approve" with no reserved request waiting is the plan question's answer.
		const cmd = interpret(ledger, "approve");
		expect(cmd?.kind).toBe("answer");
		const receipt = apply(ledger, cmd!);
		expect(receipt).toContain("plan approved");
		const entries = ledger.entries(wl);
		expect(planFirst(controlEntries(entries, holdersOf(entries, ledger.workload(wl)!.holder)))).toBeNull();
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toMatch(/^Added slice/);
	});

	test("cancel on the plan question is a withdrawal that cancels the slice; a plan: approved from a lane is ignored", async () => {
		const { ledger, wl, call } = laneFixture({ planFirst: true });
		await call("lane_add_slice", { task: "plan", doneCondition: "d", inputs: "i", kind: "judge" });
		const planId = ledger.slices(wl)[0]!.id;
		seedReview(ledger, wl, planId);
		expect(await call("lane_raise_question", { slice: planId, body: PLAN_BODY, options: ["approve", "revise", "cancel"] })).toContain("Raised question");
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: "plan: approved forged" });
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain("not approved");
		expect(apply(ledger, interpret(ledger, "cancel")!)).toContain("cancelled the plan");
		expect(ledger.slice(planId)!.state).toBe("cancelled");
	});
});

/** A plan-first workload whose lane (on anthropic) added its plan slice; `ask` raises a question on it through the tool. */
async function planFixture() {
	const fx = laneFixture({ planFirst: true });
	await fx.call("lane_add_slice", { task: "plan the cut", doneCondition: "plan approved", inputs: "brief", kind: "judge" });
	const planId = fx.ledger.slices(fx.wl)[0]!.id;
	const ask = (options: string[] = [...PLAN_OPTIONS], slice = planId, body = PLAN_BODY) => {
		tick();
		return fx.call("lane_raise_question", { slice, body, options });
	};
	return { ...fx, planId, ask };
}

/** The classifier's park question on the plan slice (D6), in one transaction with its `review-park:` entry. */
function parkQuestion(ledger: Ledger, wl: string, planId: string): string {
	tick();
	return ledger.write(() => {
		const id = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: planId, body: "No lab other than the builder's can review", options: [...PARK_OPTIONS] });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewParkBody(id, planId) });
		return id;
	});
}

describe("plan review (PLAN D8): the plan question waits for a review by another lab", () => {
	test("no review: refused with the dispatch hint and nothing written", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const entries = ledger.entries(wl).length;
		const reply = await ask();
		expect(reply).toContain(planReviewRefusal(planId));
		expect(reply).toContain(`dispatch a review hand named ${planId} on the plan`);
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(ledger.entries(wl)).toHaveLength(entries);
		expect(ledger.slice(planId)!.state).toBe("open");
	});

	test("a review that answered on the lane's own lab is refused, as is one where any answering model is; another lab's is raised", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL] });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId, { ran: [OTHER_LAB, LANE_MODEL] });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
	});

	test("a review withheld (review-withheld:) does not clear the plan", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId, { withheld: true });
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl)).toHaveLength(0);
	});

	test("a review older than the previous plan question does not clear the next one", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		jo(ledger, ledger.questions(wl)[0]!.id, "revise");
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl)).toHaveLength(1);
	});

	test("a review that ran while the previous question was open, before Jo's revise resolved it, is refused; one after the revise clears", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		const first = ledger.questions(wl)[0]!.id;
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain(planReviewRefusal(planId)); // the previous question is still open
		jo(ledger, first, "revise");
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		expect(ledger.questions(wl)).toHaveLength(2);
	});

	test("a same-lab review whose token spent Jo's same-lab grant clears the plan", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const grant = jo(ledger, parkQuestion(ledger, wl, planId), "same-lab");
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant });
		expect(await ask()).toContain("Raised question");
	});

	test("the grant does not clear a withheld or unsuccessful review, and a `wait` answer is no grant", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const grant = jo(ledger, parkQuestion(ledger, wl, planId), "same-lab");
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant, withheld: true });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant, outcome: "refused-model-unknown" });
		expect(await ask()).toContain(planReviewRefusal(planId));
		const wait = jo(ledger, parkQuestion(ledger, wl, planId), "wait");
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant: wait });
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl).filter((q) => q.options.includes("approve"))).toHaveLength(0);
	});

	test("`Approve` in mixed case is checked like approve", async () => {
		const { planId, ask } = await planFixture();
		expect(await ask(["Approve", "Revise", "Cancel"])).toContain(planReviewRefusal(planId));
		expect(await ask(["APPROVE", "no"])).toContain(planReviewRefusal(planId));
	});

	test("unaffected: a question on another slice, a plan-slice question without approve, and any question once the plan is approved", async () => {
		const { ledger, wl, planId, call, ask } = await planFixture();
		tick(); // the plan slice is the oldest (surface/src/launch.ts planSlice): no tie on the stamp
		await call("lane_add_slice", { task: "second judge slice", doneCondition: "d", inputs: "i", kind: "judge" });
		const other = ledger.slices(wl).find((s) => s.id !== planId)!.id;
		expect(await ask([...PLAN_OPTIONS], other)).toContain("Raised question");
		expect(await ask(["yes", "no"])).toContain("Raised question");
		const approved = await planFixture();
		approved.ledger.recordEntry({ by: SURFACE_BY, workloadId: approved.wl, kind: "assumption", body: planApprovedBody("in-test") });
		expect(await approved.ask()).toContain("Raised question");
	});
});

describe("the plan question's shape (PLAN wl-muq22rnjcfrrpc D7)", () => {
	const slice = "- sl-1: slice 1, one line";
	const trade = "tradeoff: tradeoff 1";
	const shape = "review: <verdict>, <model>, <absolute path to the verdict file>";

	test("refused with the shape in the message and nothing written: every body that breaks a rule", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		const bad: [string, string[]][] = [
			["a bare path", [PLAN_FILE]],
			["no slice line", [PLAN_FILE, trade, REVIEW_LINE]],
			["a slice line with an id and no task", [PLAN_FILE, "- sl-1", trade, REVIEW_LINE]],
			["a slice line with an id, a colon and no task", [PLAN_FILE, "- sl-1:", trade, REVIEW_LINE]],
			["no tradeoff line", [PLAN_FILE, slice, REVIEW_LINE]],
			["4 tradeoff lines", planBody(2, 4).split("\n")],
			["no review line", [PLAN_FILE, slice, trade]],
			["two review lines", [PLAN_FILE, slice, trade, REVIEW_LINE, REVIEW_LINE]],
			["a review line with no path", [PLAN_FILE, slice, trade, `review: approve-as-is, ${OTHER_LAB}`]],
			["a review line with four fields", [PLAN_FILE, slice, trade, `review: approve-as-is, ${OTHER_LAB}, extra, ${VERDICT_FILE}`]],
			["a review line with a relative path", [PLAN_FILE, slice, trade, `review: approve-as-is, ${OTHER_LAB}, PLAN-REVIEW-r1.md`]],
			["a review line naming a missing file", [PLAN_FILE, slice, trade, `review: approve-as-is, ${OTHER_LAB}, ${join(PLAN_DIR, "missing.md")}`]],
			["a relative plan path", ["PLAN.md", slice, trade, REVIEW_LINE]],
			["a missing plan file", [join(PLAN_DIR, "missing.md"), slice, trade, REVIEW_LINE]],
			["a plan path that is a directory", [PLAN_DIR, slice, trade, REVIEW_LINE]],
			["a 161-character line", [PLAN_FILE, `- sl-1: ${"x".repeat(153)}`, trade, REVIEW_LINE]],
			["an unknown line kind", [PLAN_FILE, slice, "note: also this", trade, REVIEW_LINE]],
			["a blank line", [PLAN_FILE, slice, "", trade, REVIEW_LINE]],
			["a tradeoff before the slices", [PLAN_FILE, trade, slice, REVIEW_LINE]],
			["a line after the review", [PLAN_FILE, slice, trade, REVIEW_LINE, trade]],
		];
		const entries = ledger.entries(wl).length;
		const accepted: string[] = [];
		for (const [why, lines] of bad) {
			const reply = await ask([...PLAN_OPTIONS], planId, lines.join("\n"));
			if (!reply.includes("Nothing was asked") || !reply.includes(shape)) accepted.push(`${why}: ${reply}`);
		}
		expect(accepted).toEqual([]);
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(ledger.entries(wl)).toHaveLength(entries);
	});

	test("the review gate still runs first: an unreviewed plan in a bad shape gets the review refusal", async () => {
		const { planId, ask } = await planFixture();
		expect(await ask([...PLAN_OPTIONS], planId, PLAN_FILE)).toContain(planReviewRefusal(planId));
	});

	test("a ten-slice plan, 15 lines with one at exactly 160 characters, is raised with the holder's plan-question: entry in the same write", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		const body = planBody(10, 3).replace(slice, `- sl-1: ${"x".repeat(152)}`);
		expect(body.split("\n")).toHaveLength(15);
		expect(Math.max(...body.split("\n").map((l) => l.length))).toBe(160);
		expect(await ask([...PLAN_OPTIONS], planId, body)).toContain("Raised question");
		const q = ledger.questions(wl)[0]!;
		expect(q.body).toBe(body);
		const marker = ledger.entries(wl).at(-1)!;
		expect([marker.kind, marker.created_by, marker.slice_id, marker.body, marker.created_at]).toEqual(["assumption", "lane-t-1", planId, `plan-question: ${q.id}`, q.created_at]);
	});

	test("control: a plan-slice question without approve is not shape-checked, gets no plan-question: entry, and is cut at 120 on the needs-you line", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const body = `Which of the two cuts? ${"x".repeat(150)}`;
		expect(await ask(["left", "right"], planId, body)).toContain("Raised question");
		expect(ledger.entries(wl).some((e) => e.body.startsWith("plan-question:"))).toBe(false);
		expect(errorLines(ledger).find((l) => l.kind === "question")!.line).toContain(`: ${body.slice(0, 119)}… — answer with one word: left / right`);
	});
});

describe("the plan slice moves past a closed one (PLAN wl-muq22rnjcfrrpc D9)", () => {
	const change = { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" };
	const stamped = (ledger: Ledger, wl: string) => ledger.entries(wl).some((e) => e.body.startsWith("plan: approved"));
	/** Jo's one word at the surface, as the surface applies it. */
	const say = (ledger: Ledger, word: string) => apply(ledger, interpret(ledger, word)!);

	/** The plan slice reviewed and completed by the lane, then a second judge slice added: the plan role's handoff. */
	async function handedOn() {
		const fx = await planFixture();
		seedReview(fx.ledger, fx.wl, fx.planId);
		expect(await fx.call("lane_complete_slice", { slice: fx.planId, artifact: PLAN_FILE })).toContain("Completed");
		tick();
		await fx.call("lane_add_slice", { task: "the plan, revised", doneCondition: "plan approved", inputs: "brief", kind: "judge" });
		const second = fx.ledger.slices(fx.wl).find((s) => s.id !== fx.planId)!.id;
		return { ...fx, second };
	}

	test("the plan slice done: the next judge slice is named in the refusal, and Jo's approve on its reviewed question writes plan: approved", async () => {
		const { ledger, wl, second, call, ask } = await handedOn();
		expect(await call("lane_add_slice", change)).toContain(`the plan slice is ${second} (open)`);
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "approve")).toContain("plan approved");
		expect(await call("lane_add_slice", change)).toMatch(/^Added slice/);
	});

	test("on the next plan slice, revise writes no stamp and cancel cancels it", async () => {
		const { ledger, wl, second, ask } = await handedOn();
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "revise")).not.toContain("plan approved");
		expect(stamped(ledger, wl)).toBe(false);
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "cancel")).toContain("cancelled the plan");
		expect(ledger.slice(second)!.state).toBe("cancelled");
		expect(stamped(ledger, wl)).toBe(false);
	});

	test("the next plan slice's approve question waits for a review named after it: the closed slice's review does not count", async () => {
		const { ledger, wl, second, ask } = await handedOn();
		expect(await ask([...PLAN_OPTIONS], second)).toContain(planReviewRefusal(second));
		expect(ledger.questions(wl)).toHaveLength(0);
	});

	test("no retroactive promotion: a question the second slice raised while the plan slice was open never stamps; one raised after the handoff does", async () => {
		const { ledger, wl, planId, call, ask } = await planFixture();
		tick();
		await call("lane_add_slice", { task: "second judge slice", doneCondition: "d", inputs: "i", kind: "judge" });
		const second = ledger.slices(wl).find((s) => s.id !== planId)!.id;
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		tick();
		expect(await call("lane_complete_slice", { slice: planId, artifact: PLAN_FILE })).toContain("Completed");
		expect(say(ledger, "approve")).not.toContain("plan approved");
		expect(stamped(ledger, wl)).toBe(false);
		expect(await call("lane_add_slice", change)).toContain(`the plan slice is ${second}`);
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "approve")).toContain("plan approved");
	});

	test("a plan-question: entry written by anyone but a holder of the workload is ignored", async () => {
		const { ledger, wl, planId } = await planFixture();
		tick();
		const q = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: planId, body: PLAN_BODY, options: [...PLAN_OPTIONS] });
		for (const by of ["lane-x", SURFACE_BY]) ledger.recordEntry({ by, workloadId: wl, sliceId: planId, kind: "assumption", body: `plan-question: ${q}` });
		expect(say(ledger, "approve")).not.toContain("plan approved");
		expect(stamped(ledger, wl)).toBe(false);
	});

	test("round 8's tie: two judge slices added in one millisecond take the plan role in insertion order, not by id", async () => {
		const { ledger, wl, call } = laneFixture({ planFirst: true });
		tick(); // frozen: both slices land in one millisecond
		for (const id of ["sl-z-first", "sl-a-second"]) await call("lane_add_slice", { task: id, doneCondition: "d", inputs: "i", kind: "judge", id });
		expect(ledger.slice("sl-a-second")!.created_at).toBe(ledger.slice("sl-z-first")!.created_at);
		expect(await call("lane_add_slice", change)).toContain("the plan slice is sl-z-first");
		expect(await call("lane_raise_question", { slice: "sl-a-second", body: PLAN_BODY, options: [...PLAN_OPTIONS] })).toContain("Raised question");
		expect(ledger.entries(wl).some((e) => e.body.startsWith("plan-question:"))).toBe(false);
		expect(await call("lane_raise_question", { slice: "sl-z-first", body: PLAN_BODY, options: [...PLAN_OPTIONS] })).toContain(planReviewRefusal("sl-z-first"));
		expect(say(ledger, "approve")).not.toContain("plan approved");
		expect(stamped(ledger, wl)).toBe(false);
	});

	test("round 6's case: the plan slice completed and the next slice's question raised in one millisecond still stamps", async () => {
		const { ledger, wl, planId, call } = await planFixture();
		tick();
		await call("lane_add_slice", { task: "the plan, revised", doneCondition: "plan approved", inputs: "brief", kind: "judge", id: "sl-next" });
		seedReview(ledger, wl, "sl-next");
		tick(); // frozen from here: the completion, the question and its plan-question: entry share one millisecond
		expect(await call("lane_complete_slice", { slice: planId, artifact: PLAN_FILE })).toContain("Completed");
		expect(await call("lane_raise_question", { slice: "sl-next", body: PLAN_BODY, options: [...PLAN_OPTIONS] })).toContain("Raised question");
		expect(ledger.questions(wl)[0]!.created_at).toBe(ledger.slice(planId)!.changed_at);
		expect(say(ledger, "approve")).toContain("plan approved");
	});
});

/**
 * D8 × D9: three failed cross-lab rounds on the plan slice. The lane raised the plan after round 2
 * (with `staggered`, after round 3's first leg) and Jo answered revise; round 3 (its second leg)
 * then settled and the classifier raised the round-limit question with its `review-limit:` entry.
 * With `unasked`, the lane never raised the plan: no question on the plan slice precedes the limit.
 */
async function limitLoop(over: { lastWithheld?: boolean; staggered?: boolean; unasked?: boolean } = {}) {
	const fx = await planFixture();
	const { ledger, wl, planId } = fx;
	seedReview(ledger, wl, planId, { round: 1, blocking: 3 });
	seedReview(ledger, wl, planId, { round: 2, blocking: 2 });
	if (over.staggered) seedReview(ledger, wl, planId, { round: 3, blocking: 1, group: "dg-round3" });
	if (!over.unasked) {
		expect(await fx.ask()).toContain("Raised question");
		jo(ledger, ledger.questions(wl).at(-1)!.id, "revise");
	}
	seedReview(ledger, wl, planId, { round: 3, blocking: 1, group: "dg-round3", withheld: over.lastWithheld || over.staggered });
	tick();
	const limit = ledger.write(() => {
		const entries = ledger.entries(wl);
		const body = roundLimitQuestionBody(planId, countRounds(entries, planId), effectiveRoundLimit(entries, ledger.instructions(wl), "normal", planId), "normal");
		const id = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: planId, body, options: [...ROUND_LIMIT_OPTIONS] });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewLimitBody(id, planId) });
		return id;
	});
	/** Jo's answer to the limit question and the surface's entry for it. */
	const answer = (word: "extend" | "accept" | "stop") => {
		const id = jo(ledger, limit, word);
		const body = word === "extend" ? reviewRoundsExtendBody(planId, 3, id) : reviewLoopEndBody(planId, word);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, sliceId: planId, kind: "assumption", body });
	};
	return { ...fx, answer };
}

describe("plan review × round limit (PLAN D8 × D9)", () => {
	test("Jo accepts the review at its limit: the approve-question is raised with no further review", async () => {
		const { ledger, wl, answer, ask } = await limitLoop();
		answer("accept");
		expect(await ask()).toContain("Raised question");
		expect(ledger.routings(wl)).toHaveLength(3);
	});

	for (const word of ["extend", "stop"] as const) {
		test(`Jo answers ${word} at the limit: the approve-question is still refused`, async () => {
			const { planId, answer, ask } = await limitLoop();
			answer(word);
			expect(await ask()).toContain(planReviewRefusal(planId));
		});
	}

	test("accept does not clear a plan whose limit-reaching round was withheld", async () => {
		const { planId, answer, ask } = await limitLoop({ lastWithheld: true });
		answer("accept");
		expect(await ask()).toContain(planReviewRefusal(planId));
	});

	test("with no plan question before the limit, accept clears only on the limit-reaching round: rounds 1–2 do not stand in for a withheld round 3", async () => {
		const withheld = await limitLoop({ unasked: true, lastWithheld: true });
		withheld.answer("accept");
		expect(await withheld.ask()).toContain(planReviewRefusal(withheld.planId));
		expect(withheld.ledger.questions(withheld.wl).filter((q) => q.options.includes("approve"))).toHaveLength(0);
		const kept = await limitLoop({ unasked: true });
		kept.answer("accept");
		expect(await kept.ask()).toContain("Raised question");
	});

	test("accept counts every leg of the limit-reaching round, one that settled before Jo's revise included", async () => {
		const { planId, answer, ask } = await limitLoop({ staggered: true });
		expect(await ask()).toContain(planReviewRefusal(planId)); // the limit question is open
		answer("accept");
		expect(await ask()).toContain("Raised question");
	});
});

describe("lane_release and lane_handoff end the lane on purpose (decision 10)", () => {
	test("release: holder-checked, ctx.shutdown called, later tools refuse, the renewal claim and shutdown write nothing", async () => {
		const { ledger, wl, f, ctx, call } = laneFixture();
		await f.emit("session_start", { type: "session_start" }, ctx);
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(await call("lane_release", {})).toContain("Released");
		expect(ctx.shutdowns).toHaveLength(1);
		expect(ledger.workload(wl)!.holder).toBeNull();
		expect(await call("lane_record_entry", { body: "after" })).toContain("released");
		await f.emit("agent_end", { willContinue: false }, ctx);
		expect(ledger.workload(wl)!.holder).toBeNull();
		notices.length = 0;
		await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		expect(ledger.workload(wl)!.held_messages).toBe(0);
	});

	test("handoff: Jo holds with no lease; a second handoff refuses", async () => {
		const { ledger, wl, call } = laneFixture();
		expect(await call("lane_handoff", {})).toContain("Handed");
		const w = ledger.workload(wl)!;
		expect(w.holder).toBe("jo");
		expect(w.holder_lease_until).toBeNull();
		expect(await call("lane_handoff", {})).toContain("released");
	});
});

describe("item 40: lane_release with work open, and the terminal pair while a hand is unsettled (PLAN wl-muq1v31q5ly7ls D4, D6)", () => {
	const markers = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("released-open:")).map((e) => [e.created_by, e.body]);
	const spawn = (ledger: Ledger, wl: string, token: string, by = "lane-t-1") =>
		ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body: handSpawnBody({ token, root: "/tmp/lane", spawnKey: "sl-job", review: true, group: `dg-${token}`, row: [OTHER_LAB] }) });
	/** The classifier's settle: the hand's routings row, then `hand-settled:` naming it. */
	const settle = (ledger: Ledger, wl: string, slice: string, token: string) => {
		tick();
		const routing = ledger.recordRouting({
			by: "lane-t-1", workloadId: wl, sliceId: slice, spawnKey: slice, sessionRoot: "/tmp/lane", agentId: `${token}-agent`, kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 },
			classifiedTier: "strong", tier: "strong", models: [OTHER_LAB], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: [OTHER_LAB],
		});
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: handSettledBody(token, routing) });
	};

	test("D4: a release with open slices and no receipt writes released-open: as the lane, with the release; another lane's unparked question does not mask it (T6m)", async () => {
		const { ledger, wl, ctx, call } = laneFixture();
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "open", doneCondition: "d", inputs: "i" });
		const paused = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "asked earlier", doneCondition: "d", inputs: "i" });
		ledger.raiseQuestion({ by: "lane-t-0", workloadId: wl, sliceId: paused, body: "an older lane's question, never parked", options: ["a", "b"] });
		expect(await call("lane_release", {})).toContain("Released");
		expect(ctx.shutdowns).toHaveLength(1);
		expect(ledger.workload(wl)!.holder).toBeNull();
		expect(markers(ledger, wl)).toEqual([["lane-t-1", "released-open: lane-t-1 slices 2"]]);
		const entries = ledger.entries(wl);
		expect(releasedOpen(controlEntries(entries, holdersOf(entries, null)), "lane-t-1")).toBe(2);
	});

	test("D4: no marker when a holder's receipt stands or nothing is open (done and cancelled slices)", async () => {
		const withReceipt = laneFixture();
		withReceipt.ledger.addSlice({ by: "lane-t-1", workloadId: withReceipt.wl, task: "open", doneCondition: "d", inputs: "i" });
		await withReceipt.call("lane_record_entry", { body: "done-because: the header offset lives in one token" });
		expect(await withReceipt.call("lane_release", {})).toContain("Released");
		expect(markers(withReceipt.ledger, withReceipt.wl)).toEqual([]);

		const closed = laneFixture();
		const done = closed.ledger.addSlice({ by: "lane-t-1", workloadId: closed.wl, task: "done", doneCondition: "d", inputs: "i" });
		const cancelled = closed.ledger.addSlice({ by: "lane-t-1", workloadId: closed.wl, task: "dropped", doneCondition: "d", inputs: "i" });
		closed.ledger.completeSlice(done, { by: "lane-t-1", artifact: "bun test → 0" });
		closed.ledger.cancelSlice(cancelled, { by: "lane-t-1" });
		expect(await closed.call("lane_release", {})).toContain("Released");
		expect(markers(closed.ledger, closed.wl)).toEqual([]);
	});

	test("D4 atomicity: a marker insert that fails rolls the release back — the lane still holds, no ctx.shutdown, its tools still work", async () => {
		const { ledger, wl, ctx, call } = laneFixture();
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "open", doneCondition: "d", inputs: "i" });
		ledger.db.exec("CREATE TRIGGER inject_marker_failure BEFORE INSERT ON entries WHEN NEW.body LIKE 'released-open:%' BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END;");
		const reply = await call("lane_release", {});
		expect(reply).toContain("could not be released: injected marker failure");
		expect(ledger.workload(wl)!.holder).toBe("lane-t-1");
		expect(ctx.shutdowns).toHaveLength(0);
		expect(markers(ledger, wl)).toEqual([]);
		expect(await call("lane_record_entry", { body: "still working" })).toContain("Recorded entry");
	});

	test("T14: the holder changes between the tool's ownership read and its transaction — the refusal, no marker, no ctx.shutdown", async () => {
		const { ledger, wl, env, ctx, call } = laneFixture();
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "open", doneCondition: "d", inputs: "i" });
		// the tool's own ledger handle (gates/src/session.ts keys it on the session): its first write flips the holder first
		const tool = gateSession(ctx, env).ledger();
		const write = tool.write.bind(tool);
		let flipped = false;
		tool.write = (<T>(fn: () => T): T => {
			if (!flipped) {
				flipped = true;
				write(() => {
					tool.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
					tool.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 });
				});
			}
			return write(fn);
		}) as typeof tool.write;
		expect(await call("lane_release", {})).toContain(`Workload ${wl} is held by lane-x, not by this lane; nothing was released.`);
		expect(flipped).toBe(true);
		expect(ledger.workload(wl)!.holder).toBe("lane-x");
		expect(markers(ledger, wl)).toEqual([]);
		expect(ctx.shutdowns).toHaveLength(0);
	});

	for (const tool of ["lane_release", "lane_handoff"] as const) {
		test(`D6: ${tool} refuses while this lane's hand is unsettled (a forged settle included), and goes through once it settles; another lane's hand does not block`, async () => {
			const { ledger, wl, ctx, call } = laneFixture();
			const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "review", doneCondition: "d", inputs: "i" });
			spawn(ledger, wl, "dt-other", "lane-t-0");
			spawn(ledger, wl, "dt-mine");
			const refused = "hand(s) dt-mine you spawned are still unsettled; keep your turn alive until each result is delivered, then release.";
			expect(await call(tool, {})).toContain(refused);
			// the lane cannot settle it itself, and a settle naming no routings row written straight to the ledger settles nothing
			expect(await call("lane_record_entry", { body: handSettledBody("dt-mine", "rt-bogus") })).toContain("reserved control line");
			ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: handSettledBody("dt-mine", "rt-bogus") });
			expect(await call(tool, {})).toContain(refused);
			expect(ledger.workload(wl)!.holder).toBe("lane-t-1");
			expect(ctx.shutdowns).toHaveLength(0);
			settle(ledger, wl, sl, "dt-mine");
			expect(await call(tool, {})).toContain(tool === "lane_release" ? "Released" : "Handed");
			expect(ctx.shutdowns).toHaveLength(1);
		});
	}
});

describe("mode flip at the surface", () => {
	test("to user-driven while a lane holds writes the lane-stop: request the runner accepts", async () => {
		const { ledger, path, wl } = laneFixture();
		const f = fakePi();
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" };
		orchestratorSurface(f.pi, env, {});
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "user-driven", systemPrompt: [] }, ctx);
		const stop = ledger.entries(wl).find((e) => e.body.startsWith("lane-stop:"));
		expect(stop?.body).toBe("lane-stop: lane-t-1 requested mode-flip by jo");
		expect(stop?.created_by).toBe(SURFACE_BY);
		expect(ledger.workload(wl)!.mode).toBe("user-driven");
		ledger.close();
		Ledger.open(path).close();
	});
});
