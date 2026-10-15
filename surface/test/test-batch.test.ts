// The batch run (plan wl-mv615mkeaf1yio § 4), pure and in-process: Jo's word and its rows, the
// starter's checks, the bodies the runner writes, the verdict, the bisection, the credits and the
// attribution reader over every window a red batch's handoff can stop in, and the needs-you lines.
// Nothing here spawns: the runner's own describes in test-runner.test.ts build real merges.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_RUNNER_BY } from "../../ledger/src/index";
import { errorLines } from "../src/errors";
import { controlEntries } from "../src/launch";
import {
	type AttributionOutcome, attributionStateText, attributionText, batchAdmissible, batchAttribution, batchCredits, batchCreditsOf, batchInstruction, batchPrs, batchResultText,
	batchRunnerDiedRun, batchRunOf, batchSettleArtifact, batchSlice, bisectNext, conflictReason, deadBatches, decideBatch, type BatchFacts, fullSuiteVerdict, heartbeatFileOf, newestBatchAttribution,
	ownWorkloadOf, parseTestBatch, parseTestBatchAttribution, parseTestBatchCredit, parseTestBatchInstruction, parseTestBatchRequested, parseTestBatchResult, parseTestBatchRun,
	readRunsSnapshot, startBatch, testBatchAttributionBody, testBatchBody, testBatchCreditBody, testBatchInstructionBody, testBatchRequestedBody, testBatchResultBody,
	type TestBatchRun, testBatchRunBody,
} from "../src/test-batch";
import { heartbeatText, makeRunId, type PartResult, type PrView, type RunRecord, runnerDiedRun } from "../src/test-run";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const M0 = "0".repeat(40);
const T = (c: string) => c.repeat(40);
const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const BATCH = makeRunId(T0, "batch1");
const ATTR = makeRunId(T0 + 1, "attr01");
const full = (fail: number, o: Partial<PartResult> = {}): PartResult => ({ pass: 10, fail, skip: 0, exit: fail > 0 ? 1 : 0, ms: 1000, error: null, failures: fail > 0 ? [{ name: "a.test.ts > breaks", firstError: "boom" }] : [], ...o });
const counts = (fail: number) => {
	const { failures: _, ...c } = full(fail);
	return c;
};
const steps = (n: number) => Array.from({ length: n + 1 }, (_, k) => ({ commit: T(String(k + 1)), tree: T(String.fromCharCode(100 + k)) }));

function batchRun(over: Partial<TestBatchRun> = {}): TestBatchRun {
	return {
		runId: BATCH, verdict: "green", base: M0, prs: [{ pr: 12, sha: A }, { pr: 15, sha: B }], steps: steps(2), full: counts(0), failures: [], attribution: null, reason: null,
		headsAtEnd: [A, B], runDir: "/runs/tr-x", preflight: "preflight ok", ...over,
	};
}

describe("Jo's word: test-batch <wl> <N> <N> …", () => {
	test("spaces, commas and # are accepted in Jo's order; a non-number, a repeat, or a count outside 2 to 8 is refused with the usage", () => {
		expect(batchPrs(["12", "15"])).toEqual({ ok: true, prs: [12, 15] });
		expect(batchPrs(["#15,", "12,#3"])).toEqual({ ok: true, prs: [15, 12, 3] });
		expect(batchPrs(["12,15,"])).toEqual({ ok: true, prs: [12, 15] });
		expect(batchPrs(["12", "x"])).toEqual({ ok: false, why: "x is not a PR number (a positive whole number): test-batch <wl-…> <N> <N> …" });
		expect(batchPrs(["12", "0"]).ok).toBe(false);
		expect(batchPrs(["12", "-3"]).ok).toBe(false);
		expect(batchPrs(["12", "12"])).toEqual({ ok: false, why: "PR #12 is named twice; a batch names each PR once: test-batch <wl-…> <N> <N> …" });
		expect(batchPrs(["12"])).toEqual({ ok: false, why: "a batch takes 2 to 8 PRs; 1 named: test-batch <wl-…> <N> <N> …" });
		expect(batchPrs(["1", "2", "3", "4", "5", "6", "7", "8"]).ok).toBe(true);
		expect(batchPrs(["1", "2", "3", "4", "5", "6", "7", "8", "9"]).ok).toBe(false);
	});

	test("Jo's instruction and the surface entry round-trip; anything else does not parse", () => {
		expect(testBatchInstructionBody("wl-x", [15, 12])).toBe("test-batch wl-x 15 12");
		expect(parseTestBatchInstruction("test-batch wl-x 15 12")).toEqual({ workloadId: "wl-x", prs: [15, 12] });
		expect(parseTestBatchInstruction("test-batch wl-x 15")).toBeNull();
		expect(parseTestBatchInstruction("test-batch wl-x 15 15")).toBeNull();
		expect(testBatchBody([15, 12], "in-abc")).toBe("test-batch: 15 12 in-abc");
		expect(parseTestBatch("test-batch: 15 12 in-abc")).toEqual({ prs: [15, 12], instructionId: "in-abc" });
		expect(parseTestBatch("test-batch: 15 in-abc")).toBeNull();
		expect(() => testBatchBody([15], "in-abc")).toThrow();
	});
});

describe("the starter's checks", () => {
	function asked() {
		const c = clock("2026-10-20T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "batch", stakes: "normal", mode: "autonomous" });
		const id = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: wl, body: testBatchInstructionBody(wl, [12, 15]) });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: testBatchBody([12, 15], id) });
		const check = (instructionId = id) => batchInstruction(wl, instructionId, ledger.instructions(wl), ledger.entries(wl));
		return { c, ledger, wl, id, check };
	}

	test("Jo's instruction with the surface entry naming it is accepted; a missing entry, another workload, or a lane's row is refused", () => {
		const { ledger, wl, id, check } = asked();
		expect(check()).toEqual({ ok: true, prs: [12, 15] });
		expect(check("in-nosuch")).toEqual({ ok: false, reason: `no instruction in-nosuch on ${wl}` });
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "other", stakes: "normal", mode: "autonomous" });
		expect(batchInstruction(other, id, ledger.instructions(other), ledger.entries(other)).ok).toBe(false);
		// an instruction with no surface entry naming it
		const bare = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: wl, body: testBatchInstructionBody(wl, [12, 15]) });
		expect(check(bare)).toEqual({ ok: false, reason: `no surface test-batch: entry names ${bare}` });
		// an entry naming it with another PR list does not count
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: testBatchBody([15, 12], bare) });
		expect(check(bare).ok).toBe(false);
		// a test-batch: entry from anyone but the surface is not a control entry
		const lane = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: wl, body: testBatchInstructionBody(wl, [3, 4]) });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: testBatchBody([3, 4], lane) });
		expect(check(lane).ok).toBe(false);
	});

	test("one instruction starts one batch: a request with the same PRs written since the instruction refuses a replay", () => {
		const { c, ledger, wl, check } = asked();
		c.at("2026-10-20T10:00:01.000Z");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRequestedBody({ runId: BATCH, prs: [{ pr: 12, sha: A }, { pr: 15, sha: B }], slice: "sl-batch-x-1", by: "jo" }) });
		expect(check()).toEqual({ ok: false, reason: expect.stringMatching(new RegExp(`already started batch ${BATCH}$`)) });
	});

	test("ownWorkloadOf reads wl/<id> only", () => {
		expect(ownWorkloadOf("wl/wl-abc")).toBe("wl-abc");
		expect(ownWorkloadOf("feature/x")).toBeNull();
		expect(ownWorkloadOf("wl/wl-abc/extra")).toBeNull();
	});

	const view = (n: number, sha: string, o: Partial<PrView> = {}): PrView => ({ number: n, state: "OPEN", headRefOid: sha, headRefName: `wl/wl-own${n}`, baseRefName: "main", isCrossRepository: false, ...o });
	function records(pr: number, sha: string, o: { verdict?: "green" | "red"; mode?: "full" | "doc-merge"; full?: boolean; ranAt?: string; result?: boolean } = {}): RunRecord[] {
		const request = { runId: makeRunId(T0, "own0"), pr, sha, slice: "sl-full-x-1", by: "lane-a", entryId: "e-1", createdAt: "2026-10-19T00:00:00.000Z" };
		if (o.result === false) return [{ request, results: [], result: null }];
		const result = {
			...runnerDiedRun(request), verdict: o.verdict ?? "green", sha: o.ranAt ?? sha, reason: null, mode: o.mode ?? "full",
			full: o.full === false ? null : counts(0), entryId: "e-2", createdAt: "2026-10-19T00:01:00.000Z",
		} as RunRecord["results"][number];
		return [{ request, results: [result], result }];
	}

	test("admission: open, no fork, a full sha, then a full green at exactly the pinned head on the PR's own workload; the first PR that fails refuses the whole batch", () => {
		const ok = batchAdmissible([{ view: view(12, A), records: records(12, A) }, { view: view(15, B), records: records(15, B) }]);
		expect(ok).toEqual({ ok: true, prs: [{ pr: 12, sha: A }, { pr: 15, sha: B }] });
		const one = (v: PrView, r: RunRecord[] | null) => batchAdmissible([{ view: view(12, A), records: records(12, A) }, { view: v, records: r }]);
		expect(one(view(15, B, { state: "MERGED" }), records(15, B))).toEqual({ ok: false, reason: "PR #15 is merged, not open" });
		expect(one(view(15, B, { isCrossRepository: true }), records(15, B))).toEqual({ ok: false, reason: "PR #15 comes from a fork; a fork head never runs" });
		expect(one(view(15, "abc"), records(15, B))).toEqual({ ok: false, reason: "PR #15 reports no full head sha" });
		expect(one(view(15, B, { headRefName: "feature/x" }), null).ok).toBe(false);
		expect(one(view(15, B), null)).toEqual({ ok: false, reason: "PR #15 has no full green at bbbbbbb (its head branch wl/wl-own15 names no wl/<id> workload in the ledger)" });
		expect(one(view(15, B), [])).toEqual({ ok: false, reason: "PR #15 has no full green at bbbbbbb (no run of it on wl-own15)" });
		expect(one(view(15, B), records(15, B, { result: false })).ok).toBe(false);
		expect(one(view(15, B), records(15, B, { verdict: "red" })).ok).toBe(false);
		expect(one(view(15, B), records(15, B, { mode: "doc-merge", full: false }))).toEqual({
			ok: false, reason: expect.stringContaining("is a doc-merge green without a full suite"),
		});
		expect(one(view(15, B), records(15, B, { ranAt: C }))).toEqual({ ok: false, reason: expect.stringContaining("ran at ccccccc") });
	});

	test("the batch slice takes the next free number", () => {
		expect(batchSlice("wl-abc", [12, 15], []).id).toBe("sl-batch-abc-1");
		expect(batchSlice("wl-abc", [12, 15], ["sl-batch-abc-1", "sl-batch-abc-4", "sl-other"]).id).toBe("sl-batch-abc-5");
		expect(batchSlice("wl-abc", [12, 15], []).task).toBe("batch run outside the fence of PRs #12, #15 merged onto main in that order");
	});
});

describe("the runner's rows", () => {
	test("test-batch-requested: round-trips; a bad body does not parse", () => {
		const r = { runId: BATCH, prs: [{ pr: 12, sha: A }, { pr: 15, sha: B }], slice: "sl-batch-x-1", by: "jo" as const };
		const body = testBatchRequestedBody(r);
		expect(body).toBe(`test-batch-requested: ${BATCH} prs=12@${A},15@${B} slice=sl-batch-x-1 by=jo`);
		expect(parseTestBatchRequested(body)).toEqual(r);
		expect(parseTestBatchRequested(body.replace("by=jo", "by=lane-a"))).toBeNull();
	});

	test("test-batch-run: is canonical: a green needs every step, a full part and a base; an attribution rides only a red with a full part and every step", () => {
		const green = batchRun();
		expect(parseTestBatchRun(testBatchRunBody(green))).toEqual(green);
		expect(() => testBatchRunBody(batchRun({ steps: steps(1) }))).toThrow();
		expect(() => testBatchRunBody(batchRun({ full: null }))).toThrow();
		expect(() => testBatchRunBody(batchRun({ base: null }))).toThrow();
		expect(() => testBatchRunBody(batchRun({ attribution: ATTR }))).toThrow();
		const red = batchRun({ verdict: "red", full: counts(1), failures: [{ part: "full", name: "a.test.ts > breaks", firstError: "boom" }], attribution: ATTR });
		expect(parseTestBatchRun(testBatchRunBody(red))).toEqual(red);
		expect(() => testBatchRunBody({ ...red, steps: steps(1) })).toThrow();
		const conflict = batchRun({ verdict: "red", full: null, steps: steps(0), reason: conflictReason(green.prs, 1), headsAtEnd: null });
		expect(parseTestBatchRun(testBatchRunBody(conflict))).toEqual(conflict);
		expect(parseTestBatchRun(testBatchRunBody(green).replace("green", "blue"))).toBeNull();
	});

	test("batchRunOf finds a batch's row by id on whichever workload it was written, from the runner only", () => {
		const { ledger } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "batch", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: testBatchRunBody(batchRun({ reason: "forged" })) });
		expect(batchRunOf(ledger, BATCH)).toBeNull();
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRunBody(batchRun()) });
		expect(batchRunOf(ledger, BATCH)).toEqual(batchRun());
		expect(batchRunOf(ledger, ATTR)).toBeNull();
	});

	test("credits: one per PR whose head branch names a workload, carrying its step, the base and the final tree; the body round-trips", () => {
		const run = batchRun();
		const credits = batchCreditsOf(run, ["wl-own12", null]);
		expect(credits).toEqual([{ workloadId: "wl-own12", credit: { runId: BATCH, pr: 12, sha: A, base: M0, step: 1, n: 2, finalTree: run.steps[2]!.tree } }]);
		const body = testBatchCreditBody(credits[0]!.credit);
		expect(body).toBe(`test-batch-credit: ${BATCH} pr=12 sha=${A} base=${M0} step=1/2 final-tree=${run.steps[2]!.tree}`);
		expect(parseTestBatchCredit(body)).toEqual(credits[0]!.credit);
		expect(() => batchCreditsOf(batchRun({ verdict: "red", full: counts(1) }), ["wl-own12", null])).toThrow();
		const { ledger } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "own", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body });
		expect(batchCredits(ledger.entries(wl))).toEqual([]);
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body });
		expect(batchCredits(ledger.entries(wl))).toEqual([credits[0]!.credit]);
	});

	test("the settle artifact and the orchestrator line", () => {
		expect(batchSettleArtifact(batchRun())).toBe(`test-batch-run ${BATCH}: green; PRs #12@aaaaaaa, #15@bbbbbbb merged onto 0000000 in that order, final tree fffffff; full 10/0/0; /runs/tr-x`);
		const red = batchRun({ verdict: "red", full: counts(1), failures: [{ part: "full", name: "a.test.ts > breaks", firstError: "boom" }], attribution: ATTR });
		expect(batchSettleArtifact(red)).toBe(`test-batch-run ${BATCH}: red; PRs #12@aaaaaaa, #15@bbbbbbb onto 0000000; full 10/1/0; attribution ${ATTR}; /runs/tr-x`);
		const conflict = batchRun({ verdict: "red", steps: steps(2).slice(0, 2), full: null, reason: "PR #15 does not merge onto main + #12; no tests ran", headsAtEnd: null });
		expect(batchSettleArtifact(conflict)).toBe(`test-batch-run ${BATCH}: red; PRs #12@aaaaaaa, #15@bbbbbbb onto 0000000; PR #15 does not merge onto main + #12; no tests ran; /runs/tr-x`);
		// a runner that died before it fetched main: no base, no run dir, a reason over two lines kept to one
		const died = { ...batchRunnerDiedRun({ runId: BATCH, prs: [{ pr: 12, sha: A }, { pr: 15, sha: B }], slice: "sl-batch-x-1", by: "jo" }), reason: "the runner did not start:\nspawn failed" };
		expect(batchSettleArtifact(died)).toBe(`test-batch-run ${BATCH}: error; PRs #12@aaaaaaa, #15@bbbbbbb onto unfetched main; the runner did not start: spawn failed; no run dir`);
		expect(batchResultText(batchRun(), [12])).toBe(`batch ${BATCH} of PRs #12, #15 green onto 0000000: full 10/0/0; credit written for #12`);
		expect(batchResultText(batchRun())).toContain("no PR's head branch names a workload, so no credit");
		// gh did not answer for the head branches at the end: the line says so instead of claiming no PR names a workload
		expect(batchResultText(batchRun(), null)).toBe(`batch ${BATCH} of PRs #12, #15 green onto 0000000: full 10/0/0; the PRs' head branches could not be read from gh, so no credit was written`);
		expect(batchResultText(red)).toBe(`batch ${BATCH} of PRs #12, #15 red: full 10/1/0, first a.test.ts > breaks; attribution ${ATTR} queued`);
		const body = testBatchResultBody({ workloadId: "wl-x", runId: BATCH, text: "line\none" });
		expect(parseTestBatchResult(body)).toEqual({ workloadId: "wl-x", runId: BATCH, text: "line one" });
	});
});

describe("the verdict (decideBatch)", () => {
	const prs = [{ pr: 12, sha: A }, { pr: 15, sha: B }];
	const f = (o: Partial<BatchFacts> = {}): BatchFacts => ({ prs, fetched: [A, B], error: null, conflict: null, full: full(0), headsAtEnd: [A, B], lockLost: null, sliceState: "open", ...o });

	test("each outcome in the plan's order; every verdict settles while its slice is open, none once it is not", () => {
		expect(decideBatch(f())).toEqual({ verdict: "green", reason: null, settle: true });
		expect(decideBatch(f({ sliceState: "paused" }))).toEqual({ verdict: "green", reason: null, settle: false });
		expect(decideBatch(f({ fetched: [A, C], error: "anything" }))).toEqual({ verdict: "stale", reason: "PR #15 was pinned at bbbbbbb but its head was ccccccc; nothing was tested", settle: true });
		expect(decideBatch(f({ fetched: [A, C], error: "anything", sliceState: "paused" }))).toMatchObject({ verdict: "stale", settle: false });
		expect(decideBatch(f({ error: "preflight: no" }))).toEqual({ verdict: "error", reason: "preflight: no", settle: true });
		expect(decideBatch(f({ error: "preflight: no", sliceState: "paused" }))).toMatchObject({ verdict: "error", settle: false });
		expect(decideBatch(f({ error: "preflight: no", sliceState: null }))).toMatchObject({ verdict: "error", settle: false });
		expect(decideBatch(f({ lockLost: "the lock row holds tr-other" }))).toMatchObject({ verdict: "error", reason: "the batch lost the lock: the lock row holds tr-other", settle: true });
		expect(decideBatch(f({ fetched: null, full: null, headsAtEnd: null }))).toMatchObject({ verdict: "error", reason: "the PR heads were never fetched", settle: true });
		expect(decideBatch(f({ conflict: 2, full: null, headsAtEnd: null }))).toMatchObject({ verdict: "red", reason: "PR #15 does not merge onto main + #12; no tests ran", settle: true });
		expect(decideBatch(f({ full: null }))).toMatchObject({ verdict: "error", reason: "the full suite did not run", settle: true });
		expect(decideBatch(f({ headsAtEnd: [A, null] }))).toMatchObject({ verdict: "error", settle: true });
		expect(decideBatch(f({ headsAtEnd: [A, C], full: full(3) }))).toMatchObject({ verdict: "stale", reason: "PR #15's head moved to ccccccc during the batch", settle: true });
		expect(decideBatch(f({ full: full(3) }))).toEqual({ verdict: "red", reason: null, settle: true });
		expect(decideBatch(f({ full: full(3), sliceState: "paused" }))).toEqual({ verdict: "red", reason: null, settle: false });
		expect(decideBatch(f({ full: full(0, { exit: 2 }) }))).toMatchObject({ verdict: "error", reason: "full: exit 2", settle: true });
		expect(conflictReason(prs, 1)).toBe("PR #12 does not merge onto main; no tests ran");
	});
	test("a full suite that errored is never red, whatever it failed before it stopped: the batch is error with no attribution, and a probe stops (review r1 finding 1)", () => {
		const timedOut = full(3, { error: "timeout" });
		expect(decideBatch(f({ full: timedOut }))).toEqual({ verdict: "error", reason: "full: timeout", settle: true });
		expect(decideBatch(f({ full: full(2, { exit: null, error: "killed before it exited" }) }))).toEqual({ verdict: "error", reason: "full: killed before it exited", settle: true });
		// a batch-run row carries an attribution only on a red: an error with one does not parse
		expect(parseTestBatchRun(testBatchRunBody(batchRun({ verdict: "error", full: counts(3), reason: "full: timeout" })))).toMatchObject({ verdict: "error", attribution: null });
		expect(() => testBatchRunBody(batchRun({ verdict: "error", full: counts(3), reason: "full: timeout", attribution: ATTR }))).toThrow();
		// the probe's rule: an errored part is error (the attribution ends as error, naming no PR); a complete one is red or green
		expect(fullSuiteVerdict(timedOut)).toEqual({ verdict: "error", why: "timeout" });
		expect(fullSuiteVerdict(full(3, { error: "report import refused: a symlink" }))).toEqual({ verdict: "error", why: "report import refused: a symlink" });
		expect(fullSuiteVerdict(full(3))).toEqual({ verdict: "red" });
		expect(fullSuiteVerdict(full(0))).toEqual({ verdict: "green" });
		expect(fullSuiteVerdict(full(0, { exit: 2 }))).toEqual({ verdict: "error", why: "exit 2" });
	});
});

describe("attribution: the bisection and its row", () => {
	test("step 0 first; red there names no PR; otherwise a binary search for a green→red pair, n being the batch's own red", () => {
		expect(bisectNext(4, [])).toEqual({ probe: 0 });
		expect(bisectNext(4, [{ step: 0, verdict: "red" }])).toEqual({ done: { kind: "main-red" } });
		expect(bisectNext(4, [{ step: 0, verdict: "green" }])).toEqual({ probe: 2 });
		expect(bisectNext(4, [{ step: 0, verdict: "green" }, { step: 2, verdict: "green" }])).toEqual({ probe: 3 });
		expect(bisectNext(4, [{ step: 0, verdict: "green" }, { step: 2, verdict: "green" }, { step: 3, verdict: "red" }])).toEqual({ done: { kind: "broken", step: 3 } });
		expect(bisectNext(1, [{ step: 0, verdict: "green" }])).toEqual({ done: { kind: "broken", step: 1 } });
		// a later PR that repairs a break: 1 breaks, 2 repairs, 4 breaks again; the search lands on a real green→red step, not the first
		const verdictAt: Record<number, "green" | "red"> = { 0: "green", 1: "red", 2: "green", 3: "green", 4: "red" };
		const probes: { step: number; verdict: "green" | "red" }[] = [];
		let next = bisectNext(4, probes);
		while ("probe" in next) {
			probes.push({ step: next.probe, verdict: verdictAt[next.probe]! });
			next = bisectNext(4, probes);
		}
		expect(next).toEqual({ done: { kind: "broken", step: 4 } });
		expect(() => bisectNext(4, [{ step: 1, verdict: "green" }])).toThrow();
	});

	test("the row's line is the json's own rendering: a hand-made line never parses", () => {
		const outcome: AttributionOutcome = { kind: "broken", step: 2, pr: 15, probes: [{ step: 0, verdict: "green", full: counts(0) }, { step: 1, verdict: "green", full: counts(0) }] };
		const a = { runId: ATTR, batch: BATCH, outcome };
		const body = testBatchAttributionBody(a);
		expect(body).toBe(`test-batch-attribution: ${ATTR} batch=${BATCH} broken by PR #15 at step 2: probed step 0 green 10/0/0, step 1 green 10/0/0 ${JSON.stringify(outcome)}`);
		expect(parseTestBatchAttribution(body)).toEqual(a);
		expect(parseTestBatchAttribution(body.replace("PR #15 at", "PR #12 at"))).toBeNull();
		expect(attributionText({ kind: "main-red", probes: [{ step: 0, verdict: "red", full: counts(2) }] })).toBe("main is already red at M0; no PR is named: probed step 0 red 10/2/0");
		expect(attributionText({ kind: "error", reason: "batch bundle unavailable: gone", probes: [] })).toBe("error: batch bundle unavailable: gone");
		expect(() => testBatchAttributionBody({ runId: ATTR, batch: BATCH, outcome: { kind: "error", reason: "two\nlines", probes: [] } })).toThrow();
		expect(() => testBatchAttributionBody({ runId: BATCH, batch: BATCH, outcome })).toThrow();
	});
});

describe("the attribution reader across every window of the handoff", () => {
	const red = { runId: BATCH, attribution: ATTR };
	const now = T0 + 10_000;

	test("each window: before the admission, admitted with no runner, queued live, holding the lock, a stale holder, and done", () => {
		// the batch died after its result row, before the queue row
		expect(batchAttribution(red, [], null, [], now)).toEqual({ state: "lost", id: ATTR });
		// admitted, no runner yet: running through the startup lease, lost after it
		const admitted = [{ seq: 1, runId: ATTR, admittedAt: now - 1_000, heartbeatAt: null }];
		expect(batchAttribution(red, admitted, null, [], now)).toEqual({ state: "running", id: ATTR, where: "queued" });
		expect(batchAttribution(red, admitted, null, [], now + 120_000)).toEqual({ state: "lost", id: ATTR });
		// queued behind another holder, its runner beating
		const beating = [{ seq: 1, runId: ATTR, admittedAt: now - 600_000, heartbeatAt: now - 5_000 }];
		expect(batchAttribution(red, beating, { runId: "tr-otherholder", heartbeatAt: now }, [], now)).toEqual({ state: "running", id: ATTR, where: "queued" });
		// queued with a heartbeat gone stale: its runner died in the queue
		expect(batchAttribution(red, [{ ...beating[0]!, heartbeatAt: now - 61_000 }], null, [], now)).toEqual({ state: "lost", id: ATTR });
		// holding the lock (its queue row gone in the same transaction)
		expect(batchAttribution(red, [], { runId: ATTR, heartbeatAt: now - 5_000 }, [], now)).toEqual({ state: "running", id: ATTR, where: "holding the lock" });
		expect(batchAttribution(red, [], { runId: ATTR, heartbeatAt: now - 61_000 }, [], now)).toEqual({ state: "lost", id: ATTR });
		// done: the row decides, whatever runs.db says
		const outcome: AttributionOutcome = { kind: "main-red", probes: [{ step: 0, verdict: "red", full: counts(1) }] };
		expect(batchAttribution(red, [], null, [{ runId: ATTR, batch: BATCH, outcome }], now)).toEqual({ state: "done", id: ATTR, outcome });
		// a row for another batch does not count
		expect(batchAttribution(red, [], null, [{ runId: ATTR, batch: makeRunId(T0, "other1"), outcome }], now)).toEqual({ state: "lost", id: ATTR });
		expect(batchAttribution({ runId: BATCH, attribution: null }, [], null, [], now)).toBeNull();
		expect(attributionStateText({ state: "lost", id: ATTR })).toBe(`attribution: lost (${ATTR} never ran); run test-batch again for attribution`);
		expect(attributionStateText({ state: "running", id: ATTR, where: "queued" })).toBe(`attribution: running (${ATTR}, queued)`);
	});

	test("a runs root with no runs.db is an empty snapshot", () => {
		expect(readRunsSnapshot(tmp("batch-runs"))).toEqual({ queue: [], lock: null });
	});
});

describe("the needs-you lines", () => {
	test("each held test-batch-result: from the runner is a line; a red batch whose attribution never ran is a lost line until its row lands", () => {
		const { ledger } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "batch", stakes: "normal", mode: "autonomous" });
		const runs = tmp("batch-lines");
		const lines = () => errorLines(ledger, undefined, { runs }).filter((l) => l.kind === "test-run");
		const redRun = batchRun({ verdict: "red", full: counts(1), failures: [{ part: "full", name: "a.test.ts > breaks", firstError: "boom" }], attribution: ATTR });
		const entry = ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRunBody(redRun) });
		const m = ledger.enqueue({ by: TEST_RUNNER_BY, workloadId: wl, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: testBatchResultBody({ workloadId: wl, runId: BATCH, text: batchResultText(redRun) }) });
		// a forged result from a lane is no line
		ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: testBatchResultBody({ workloadId: wl, runId: BATCH, text: "green, honest" }) });
		expect(lines()).toEqual([
			{ kind: "test-run", workloadId: wl, rowId: m, messageIds: [m], line: `test batch ${BATCH} on ${wl}: ${batchResultText(redRun)}` },
			{
				kind: "test-run", workloadId: wl, rowId: entry, state: "lost",
				line: `test batch ${BATCH} on ${wl} is red and its attribution ${ATTR} never ran: the red stands, no PR is named — run \`test-batch ${wl} 12 15\` again for attribution`,
			},
		]);
		expect(newestBatchAttribution(runs, () => ledger.entries(wl), Date.now())!.state).toEqual({ state: "lost", id: ATTR });
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchAttributionBody({ runId: ATTR, batch: BATCH, outcome: { kind: "error", reason: "x", probes: [] } }) });
		expect(lines().map((l) => l.rowId)).toEqual([m]);
		// the lost line names the runner's own entries only: the reader parses only control entries
		expect(controlEntries(ledger.entries(wl)).filter((c) => c.prefix === "test-batch-run")).toHaveLength(1);
	});
});

describe("a batch whose runner died: the reservation's settle for batches (§ 2.2 step 3)", () => {
	const PRS = [{ pr: 12, sha: A }, { pr: 15, sha: B }];
	const OTHER = makeRunId(T0, "batch2");
	function requested() {
		const c = clock("2026-10-20T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "batch", stakes: "normal", mode: "autonomous" });
		const entry = ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRequestedBody({ runId: BATCH, prs: PRS, slice: "sl-batch-x-1", by: "jo" }) });
		return { c, ledger, wl, entry };
	}

	test("deadBatches: unsettled and not live (no heartbeat past the 120 s lease, or a heartbeat 60 s old); its own test-batch-run: takes it off; a lane's forged request is none", () => {
		const { ledger, wl } = requested();
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRequestedBody({ runId: OTHER, prs: PRS, slice: "sl-batch-x-2", by: "jo" }) });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: testBatchRequestedBody({ runId: makeRunId(T0, "forged"), prs: PRS, slice: "sl-batch-x-3", by: "jo" }) });
		const dead = (heartbeat: (id: string) => number | null, nowMs: number) => deadBatches(ledger.entries(wl), heartbeat, nowMs).map((r) => r.runId);
		const none = () => null;
		expect(dead(none, T0 + 119_000)).toEqual([]);
		expect(dead(none, T0 + 121_000)).toEqual([BATCH, OTHER]);
		// a batch beats from its start, through its wait in the queue: a heartbeat under 60 s old keeps it live past the lease
		const beat = (id: string) => (id === BATCH ? T0 + 100_000 : null);
		expect(dead(beat, T0 + 159_000)).toEqual([OTHER]);
		expect(dead(beat, T0 + 161_000)).toEqual([BATCH, OTHER]);
		// the settle the next start-batch writes: the batch's own row, `error runner died`, nothing built or run
		const died = batchRunnerDiedRun({ runId: BATCH, prs: PRS, slice: "sl-batch-x-1", by: "jo" }, `/runs/${BATCH}`);
		expect(died).toEqual({
			runId: BATCH, verdict: "error", base: null, prs: PRS, steps: [], full: null, failures: [], attribution: null, reason: "runner died", headsAtEnd: null, runDir: `/runs/${BATCH}`, preflight: null,
		});
		expect(parseTestBatchRun(testBatchRunBody(died))).toEqual(died);
		expect(batchResultText(died)).toBe(`batch ${BATCH} of PRs #12, #15 error: runner died`);
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRunBody(died) });
		expect(dead(none, T0 + 121_000)).toEqual([OTHER]);
		// a result written by anyone but the runner settles nothing
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: testBatchRunBody({ ...died, runId: OTHER }) });
		expect(dead(none, T0 + 121_000)).toEqual([OTHER]);
	});

	test("heartbeatFileOf reads the run's own heartbeat file under the runs root; none, or another run's, is null", () => {
		const runs = tmp("batch-heartbeat");
		expect(heartbeatFileOf(runs, BATCH)).toBeNull();
		mkdirSync(join(runs, BATCH), { recursive: true });
		writeFileSync(join(runs, BATCH, "heartbeat"), heartbeatText(BATCH, T0 + 5_000));
		expect(heartbeatFileOf(runs, BATCH)).toBe(T0 + 5_000);
		writeFileSync(join(runs, BATCH, "heartbeat"), heartbeatText(OTHER, T0 + 5_000));
		expect(heartbeatFileOf(runs, BATCH)).toBeNull();
	});

	test("the needs-you line: a batch whose runner died is one line, read from its heartbeat file, until its settle row lands", () => {
		const { c, ledger, wl, entry } = requested();
		const runs = tmp("batch-died");
		const lines = (now: string) => errorLines(ledger, undefined, { runs, now }).filter((l) => l.kind === "test-run");
		expect(lines("2026-10-20T10:01:00.000Z")).toEqual([]);
		mkdirSync(join(runs, BATCH), { recursive: true });
		writeFileSync(join(runs, BATCH, "heartbeat"), heartbeatText(BATCH, T0 + 150_000));
		expect(lines("2026-10-20T10:03:00.000Z")).toEqual([]);
		expect(lines("2026-10-20T10:04:00.000Z")).toEqual([{
			kind: "test-run", workloadId: wl, rowId: entry, state: "died",
			line: `test batch ${BATCH} on ${wl} (PRs #12, #15): its runner died before its result, and slice sl-batch-x-1 has none — run \`test-batch ${wl} 12 15\` again; that start settles it as error runner died`,
		}]);
		c.at("2026-10-20T10:05:00.000Z");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRunBody(batchRunnerDiedRun({ runId: BATCH, prs: PRS, slice: "sl-batch-x-1", by: "jo" })) });
		expect(lines("2026-10-20T10:06:00.000Z")).toEqual([]);
	});
});

describe("the surface's exec of the starter", () => {
	test("its last line on exit 0; the reason otherwise; a host with no exec says how to start it by hand", async () => {
		const ok = await startBatch(async () => ({ stdout: "noise\ntest-batch tr-x runner 1\n", stderr: "", code: 0, killed: false }), "wl-x", "in-abc");
		expect(ok).toBe("test-batch tr-x runner 1");
		const refused = await startBatch(async () => ({ stdout: "", stderr: "test-runner start-batch: PR #15 has no full green\n", code: 2, killed: false }), "wl-x", "in-abc");
		expect(refused).toBe("no batch started (starter exit 2): test-runner start-batch: PR #15 has no full green");
		const killed = await startBatch(async () => ({ stdout: "", stderr: "", code: 1, killed: true }), "wl-x", "in-abc");
		expect(killed).toBe("no batch started (the starter did not return within 30 s and was killed): the starter was killed before it printed");
		const none = await startBatch(undefined, "wl-x", "in-abc");
		expect(none).toContain(`start-batch wl-x in-abc`);
		expect(none).toContain(join("surface", "scripts", "test-runner.ts"));
	});
});
