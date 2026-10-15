// The test runner's pure half (MIGRATION.md item 24; plan rev 12 § 2 to § 4) over plain values: the
// four bodies, the profile block, the junit report and console log of Bun 1.3.14 (captured fixtures
// plus one live run of the installed bun on a tiny fixture), the changed-test-file filter, the
// verdict and settle decision with ownership, liveness and the starter's reservation, retention,
// the bound-branch rule, the doc-only main-merge rule (plan wl-mv615mkeaf1yio § 3), the
// close-freshness decision, the untrusted child's env with its git shim (run for real through
// `env -i`), and the wrapper's argv contract.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryRow, type InstructionRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import { boundPrs, holdersOf, testPrBody, testPrInstructionBody } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import {
	type Admission, AS2TEST_EXEC, authoritativeRun, backstopReason, boundBranches, buildTestRun, changedTestFiles, CHILD_ENV_ALLOWLIST, childEnv, childGitconfigText, childLayout,
	type CloseCredit, type ClosePr, closeFreshness, decideRun, decisionLogFault, decisionLogOnly, DOC_MERGE_DOCS, docMergeDecision, fullSuiteSlice, gitShimText, heartbeatText, isBunTestFile,
	KEEP_RUNS, lockHolderStale, type MergeDiffs, type MergeFacts,
	logFirstErrors, makeRunId, notifiesOrchestrator, ownerRepoOf, ownsRequest, parseHeartbeat, parseJunit, parsePushDest, parseTestRequested,
	parseTestRun, parseTestRunFailed, partResult, type PartResult, prAdmissible, prGoneOf, type PrView, pruneRuns, queueHead, queueWaitDecision, type RangeCommit, recordLive, reportCapBytes,
	rerequestedAs, reservation, resultJson, type RunFacts, type RunRecord, runDirOf, runLive, runnerDiedRun, runsRoot, servedRepo, settleArtifact, stageDirOf, pushDestBody,
	TEST_RUNNER_DEFAULTS, type TestRequested, testRequestedBody, type TestRun, testRunBody, testRunFailedBody, testRunFailedOf, testRunnerConfig,
	TestRunShapeError, testRuns, WRAPPER_EXIT, wrapperArgv, workDirOf,
} from "../src/test-run";
import { tmp } from "./helpers";

const REPO = join(import.meta.dir, "..", "..");
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const NOW = Date.parse("2026-10-08T10:00:00.000Z");

let seq = 0;
const entry = (by: string, body: string, minute = ++seq, slice: string | null = null): EntryRow => ({
	id: `e-${minute}`, workload_id: "wl-t", slice_id: slice, kind: "assumption", body, created_by: by,
	created_at: new Date(NOW + (minute - 1000) * 60_000).toISOString(),
} as EntryRow);
const request = (runId: string, pr: number, sha: string, slice = "sl-full-t-1", by = "lane-t-1"): TestRequested => ({ runId, pr, sha, slice, by });
const run = (r: TestRequested, verdict: TestRun["verdict"], over: Partial<TestRun> = {}): TestRun => ({
	runId: r.runId, verdict, sha: r.sha, pr: r.pr, reason: null, headAtEnd: r.sha, base: D, mergeBase: D,
	full: { pass: 3, fail: verdict === "red" ? 1 : 0, skip: 0, exit: verdict === "red" ? 1 : 0, ms: 1200, error: null }, solo: [],
	failures: verdict === "red" ? [{ part: "full", name: "x.test.ts > broken", firstError: "error: nope" }] : [], runDir: `/runs/${r.runId}`, preflight: "ok",
	mode: "full", basis: null, merge: null, ...over,
});
const reqEntry = (r: TestRequested, by = TEST_RUNNER_BY) => entry(by, testRequestedBody(r), ++seq, r.slice);
const runEntry = (t: TestRun, by = TEST_RUNNER_BY) => entry(by, testRunBody(t), ++seq);

// ---- captured Bun 1.3.14 output (bun test --reporter=junit --reporter-outfile=…, console 2>&1) ------

const JUNIT_A = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" assertions="3" failures="2" skipped="2" time="0.008136">
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="h">
    <testcase name="b ok" classname="" time="0.000041" file="b.test.ts" line="2" assertions="1" />
  </testsuite>
  <testsuite name="sub/a.test.ts" file="sub/a.test.ts" tests="5" assertions="2" failures="2" skipped="2" time="0" hostname="h">
    <testsuite name="outer" file="sub/a.test.ts" line="2" tests="4" assertions="2" failures="1" skipped="2" time="0" hostname="h">
      <testsuite name="inner" file="sub/a.test.ts" line="3" tests="2" assertions="2" failures="1" skipped="0" time="0" hostname="h">
        <testcase name="passes" classname="inner &amp;gt; outer" time="0.00001" file="sub/a.test.ts" line="4" assertions="1" />
        <testcase name="fails &lt;here&gt; &amp; &quot;there&quot;" classname="inner &amp;gt; outer" time="0.000978" file="sub/a.test.ts" line="5" assertions="1">
          <failure type="AssertionError" />
        </testcase>
      </testsuite>
      <testcase name="skipped one" classname="outer" time="0" file="sub/a.test.ts" line="7" assertions="0">
        <skipped />
      </testcase>
      <testcase name="todo one" classname="outer" time="0" file="sub/a.test.ts" line="8" assertions="0">
        <skipped message="TODO" />
      </testcase>
    </testsuite>
    <testcase name="top throws" classname="" time="0.000059" file="sub/a.test.ts" line="10" assertions="0">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
`;
const LOG_A = String.raw`bun test v1.3.14 (0d9b296a)

sub/a.test.ts:
1 | import { describe, expect, test } from "bun:test";
2 | describe("outer", () => {
3 |   describe("inner", () => {
4 |     test("passes", () => { expect(1).toBe(1); });
5 |     test("fails <here> & \"there\"", () => { expect({a: 1}).toEqual({a: 2}); });
                                                                ^
error: expect(received).toEqual(expected)

  {
-   "a": 2,
+   "a": 1,
  }

      at <anonymous> (/private/tmp/junit-probe/sub/a.test.ts:5:61)
(fail) outer > inner > fails <here> & "there" [0.98ms]
 9 | });
10 | test("top throws", () => { throw new Error("boom\nsecond line"); });
                                                                   ^
error: boom
second line
      at <anonymous> (/private/tmp/junit-probe/sub/a.test.ts:10:63)
(fail) top throws [0.06ms]

 2 pass
 1 skip
 1 todo
 2 fail
Ran 6 tests across 2 files. [8.00ms]
`;
const JUNIT_C = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="1" failures="5" skipped="0" time="0.057162">
  <testsuite name="c.test.ts" file="c.test.ts" tests="5" assertions="1" failures="5" skipped="0" time="0.051" hostname="h">
    <testcase name="type error" classname="" time="0.00013" file="c.test.ts" line="2" assertions="0">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="string thrown" classname="" time="0.000024" file="c.test.ts" line="3" assertions="0">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="empty message" classname="" time="0.000032" file="c.test.ts" line="4" assertions="0">
      <failure type="AssertionError" />
    </testcase>
    <testsuite name="d" file="c.test.ts" line="5" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="h">
      <testcase name="b ok" classname="d" time="0.000042" file="c.test.ts" line="5" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="timeout" classname="" time="0.051186" file="c.test.ts" line="6" assertions="0">
      <failure type="TimeoutError" />
    </testcase>
  </testsuite>
</testsuites>
`;
const LOG_C = String.raw`bun test v1.3.14 (0d9b296a)

c.test.ts:
error: fake from console
1 | import { test, expect, describe } from "bun:test";
2 | test("type error", () => { console.log("error: fake from console"); throw new TypeError("bad type"); });
                                                                                                      ^
TypeError: bad type
      at <anonymous> (/private/tmp/junit-probe/c.test.ts:2:99)
(fail) type error [0.13ms]
3 | test("string thrown", () => { throw "just a string"; });
                                        ^
error: just a string
      at <anonymous> (/private/tmp/junit-probe/c.test.ts:3:37)
(fail) string thrown [0.02ms]
4 | test("empty message", () => { throw new Error(""); });
                                                    ^
Error: 
      at <anonymous> (/private/tmp/junit-probe/c.test.ts:4:49)
(fail) empty message [0.03ms]
5 | describe("d", () => { test("b ok", () => { expect(1).toBe(2); }); });
                                                         ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/private/tmp/junit-probe/c.test.ts:5:54)
(fail) d > b ok [0.04ms]
(fail) timeout [51.19ms]
  ^ this test timed out after 50ms.

 0 pass
 5 fail
Ran 5 tests across 1 file. [57.00ms]
`;

/** A junit report with `n` failing cases, each with its own message, for the >20 failures case. */
function manyFailures(n: number): string {
	const cases = Array.from({ length: n }, (_, i) => `<testcase name="case ${i}" file="m.test.ts"><failure type="AssertionError" message="line one of ${i}&#10;line two" /></testcase>`);
	return `<testsuites tests="${n}" failures="${n}" skipped="0"><testsuite name="m.test.ts" file="m.test.ts">${cases.join("")}</testsuite></testsuites>`;
}

// ---- 1. bodies --------------------------------------------------------------------------------------

describe("bodies: format and parse round-trip exactly; malformed bodies are rejected", () => {
	test("test-requested:", () => {
		const r = request("tr-0abc12", 17, A, "sl-full-muraer-1", "lane-wl-t-3");
		const body = testRequestedBody(r);
		expect(body).toBe(`test-requested: tr-0abc12 pr=17 sha=${A} slice=sl-full-muraer-1 by=lane-wl-t-3`);
		expect(parseTestRequested(body)).toEqual(r);
		for (const bad of [
			`test-requested: tr-0abc12 pr=17 sha=${A} slice=sl-x`, `test-requested: TR-0 pr=17 sha=${A} slice=sl-x by=l`, `test-requested: tr-0 pr=0 sha=${A} slice=sl-x by=l`,
			`test-requested: tr-0 pr=17 sha=${A.slice(1)} slice=sl-x by=l`, `test-requested: tr-0 pr=17 sha=${A} slice=x by=l`, `test-run: tr-0 pr=17 sha=${A} slice=sl-x by=l`,
			`test-requested: tr-0 pr=17 sha=${A} slice=sl-x by=l extra`,
		]) expect(parseTestRequested(bad)).toBeNull();
		expect(() => testRequestedBody({ ...r, sha: "abc" })).toThrow(TestRunShapeError);
		expect(() => testRequestedBody({ ...r, runId: "tr-UP" })).toThrow(TestRunShapeError);
	});
	test("test-run: carries sha, base, merge-base, counts, and every failing name with its full first error line (more than 20)", () => {
		const r = request("tr-0abc12", 17, A);
		const failures = Array.from({ length: 27 }, (_, i) => ({ part: i < 20 ? "full" : "./surface/test/x.test.ts", name: `surface/test/x.test.ts > group > case ${i} with "quotes" and } braces`, firstError: `error: expect(received).toBe(expected) — case ${i}, a long line `.repeat(4).trim() }));
		const t: TestRun = {
			...run(r, "red"), headAtEnd: A, base: B, mergeBase: C,
			full: { pass: 2600, fail: 20, skip: 3, exit: 1, ms: 245_000, error: null },
			solo: [{ file: "./surface/test/x.test.ts", pass: 4, fail: 7, skip: 0, exit: 1, ms: 900, error: null }], failures,
		};
		const body = testRunBody(t);
		expect(body.startsWith(`test-run: tr-0abc12 red sha=${A} pr=17 {`)).toBe(true);
		expect(body.includes("\n")).toBe(false);
		const back = parseTestRun(body)!;
		expect(back).toEqual(t);
		expect(back.failures).toHaveLength(27);
		expect(back.failures[26]!.firstError).toBe(failures[26]!.firstError);
		expect([back.base, back.mergeBase, back.full!.pass, back.full!.fail, back.full!.skip]).toEqual([B, C, 2600, 20, 3]);
		expect(JSON.parse(resultJson(t))).toMatchObject({ runId: "tr-0abc12", verdict: "red", sha: A, pr: 17, base: B, mergeBase: C });
	});
	test("test-run: the dead-runner settle and a stale-before-tests run have no counts and round-trip", () => {
		const r = request("tr-0abc12", 17, A);
		const died = runnerDiedRun(r);
		expect(testRunBody(died).startsWith(`test-run: tr-0abc12 error sha=${A} pr=17 {"sha":"${A}","pr":17,"reason":"runner died"`)).toBe(true);
		expect(parseTestRun(testRunBody(died))).toEqual(died);
		const stale = { ...runnerDiedRun(r), verdict: "stale" as const, reason: "requested aaaaaaa but the PR head was bbbbbbb" };
		expect(parseTestRun(testRunBody(stale))).toEqual(stale);
	});
	test("test-run: mode; a row from before modes parses as full; a doc-merge row carries basis and merge and round-trips; mismatched mode fields are rejected", () => {
		const r = request("tr-0abc12", 17, C);
		const full = testRunBody(run(r, "green"));
		expect(full.endsWith(`"preflight":"ok","mode":"full"}`)).toBe(true);
		// a body exactly as the runner wrote it before this change: no mode, no basis, no merge
		const old = full.replace(',"mode":"full"', "");
		expect(old.includes("mode")).toBe(false);
		expect(parseTestRun(old)).toMatchObject({ runId: "tr-0abc12", verdict: "green", mode: "full", basis: null, merge: null });
		const dm = run(r, "green", { full: null, mode: "doc-merge", basis: { runId: "tr-0basis1", sha: A }, merge: { main: B, tip: D, docs: ["MIGRATION.md", ".ai/decision-log/x.md"] } });
		const body = testRunBody(dm);
		expect(body).toContain(`"mode":"doc-merge","basis":{"runId":"tr-0basis1","sha":"${A}"},"merge":{"main":"${B}","tip":"${D}","docs":["MIGRATION.md",".ai/decision-log/x.md"]}`);
		expect(parseTestRun(body)).toEqual(dm);
		for (const bad of [
			body.replace('"mode":"doc-merge"', '"mode":"fast"'), body.replace('"mode":"doc-merge"', '"mode":"full"'), body.replace(`"basis":{"runId":"tr-0basis1","sha":"${A}"},`, ""),
			body.replace('"runId":"tr-0basis1"', '"runId":"basis"'), body.replace(`"main":"${B}"`, '"main":"abc"'), body.replace('"docs":["MIGRATION.md"', '"docs":[3'),
			full.replace('"mode":"full"', `"mode":"full","basis":{"runId":"tr-0basis1","sha":"${A}"}`),
		]) expect(parseTestRun(bad)).toBeNull();
		expect(() => testRunBody({ ...dm, merge: null })).toThrow(TestRunShapeError);
	});
	test("test-run: malformed bodies are rejected", () => {
		const r = request("tr-0abc12", 17, A);
		const good = testRunBody(run(r, "green"));
		const json = good.slice(good.indexOf("{"));
		for (const bad of [
			good.replace(" green ", " amber "), good.replace(`sha=${A}`, `sha=${B}`), good.replace("pr=17", "pr=18"), good.replace(json, "{not json"),
			good.replace(json, "[]"), good.replace('"pass":3', '"pass":-1'), good.replace('"pass":3', '"pass":"3"'), good.replace('"solo":[]', '"solo":[{"file":"x.test.ts"}]'),
			good.replace('"failures":[]', '"failures":[{"part":"full"}]'), good.replace(`"headAtEnd":"${A}"`, '"headAtEnd":"abc"'), good.replace(json, ""),
		]) expect(parseTestRun(bad)).toBeNull();
		expect(() => testRunBody({ ...run(r, "green"), sha: "nope" })).toThrow(TestRunShapeError);
	});
	test("test-run-failed: (a pushed signal), with and without a first name", () => {
		const f = { workloadId: "wl-muraerdsgw7gn4", slice: "sl-full-muraerdsgw7gn4-1", verdict: "red" as const, sha: A, failing: 23, first: "surface/test/x.test.ts > takeover > races, first try" };
		const body = testRunFailedBody(f);
		expect(body).toBe(`test-run-failed: wl-muraerdsgw7gn4 sl-full-muraerdsgw7gn4-1 red at ${A}: 23 failing, first surface/test/x.test.ts > takeover > races, first try`);
		expect(parseTestRunFailed(body)).toEqual(f);
		const err = { ...f, verdict: "error" as const, failing: 0, first: null };
		expect(testRunFailedBody(err)).toBe(`test-run-failed: wl-muraerdsgw7gn4 sl-full-muraerdsgw7gn4-1 error at ${A}: 0 failing`);
		expect(parseTestRunFailed(testRunFailedBody(err))).toEqual(err);
		expect(testRunFailedBody({ ...f, first: "a\n  b" }).endsWith("first a b")).toBe(true);
		for (const bad of [body.replace(" red ", " green "), body.replace(" red ", " superseded "), body.replace("23 failing", "x failing"), body.replace("wl-", "w-"), `${body.split(",")[0]},`])
			expect(parseTestRunFailed(bad)).toBeNull();
		expect(() => testRunFailedBody({ ...f, verdict: "green" as unknown as "red" })).toThrow(TestRunShapeError);
	});
	test("test-run-failed: is built from a finished run; green and superseded send none", () => {
		const r = request("tr-0abc12", 17, A);
		expect(testRunFailedOf("wl-t", "sl-full-t-1", run(r, "red"))).toEqual({ workloadId: "wl-t", slice: "sl-full-t-1", verdict: "red", sha: A, failing: 1, first: "x.test.ts > broken" });
		expect(testRunFailedOf("wl-t", "sl-full-t-1", run(r, "green"))).toBeNull();
		expect(testRunFailedOf("wl-t", "sl-full-t-1", run(r, "superseded"))).toBeNull();
	});
	test("push-dest:", () => {
		const d = { remote: "origin", branch: "wl/wl-other", sha: A };
		expect(pushDestBody(d)).toBe(`push-dest: origin wl/wl-other ${A}`);
		expect(parsePushDest(pushDestBody(d))).toEqual(d);
		for (const bad of [`push-dest: origin refs/heads/wl/x ${A}`, `push-dest: origin wl/x`, `push-dest: origin wl/x ${A} extra`, `push-dest: -o wl/x ${A}`, `push-dest: origin wl/x HEAD`])
			expect(parsePushDest(bad)).toBeNull();
		expect(() => pushDestBody({ ...d, branch: "refs/heads/wl/x" })).toThrow(TestRunShapeError);
	});
	test("run ids sort by start time and match the wrapper's pattern", () => {
		const a = makeRunId(NOW, "q9z1");
		const b = makeRunId(NOW + 1, "0000");
		expect(a).toMatch(/^tr-[a-z0-9]+$/);
		expect(a < b).toBe(true);
		expect(() => makeRunId(NOW, "AB")).toThrow(TestRunShapeError);
	});
});

// ---- profile -----------------------------------------------------------------------------------------

describe("profile: the testRunner block", () => {
	test("the checkout's profile/config.yml serves agent-system-2.0 with bun test and the plan's caps", () => {
		const doc = Bun.YAML.parse(readFileSync(join(REPO, "profile", "config.yml"), "utf8"));
		const c = testRunnerConfig(doc);
		expect(c).toEqual({ ok: true, config: { repos: [{ origin: "thewolff/agent-system-2.0", command: "bun test" }], fullCapMin: 20, soloCapMin: 10, reportCapMb: 50, queueMaxMin: 360 } });
		if (!c.ok) throw new Error(c.error);
		const config = c.config;
		for (const url of ["https://github.com/thewolff/agent-system-2.0.git", "git@github.com:thewolff/agent-system-2.0.git", "ssh://git@github.com/TheWolff/agent-system-2.0", "thewolff/agent-system-2.0"]) {
			expect(servedRepo(config, url)?.command).toBe("bun test");
		}
		expect(servedRepo(config, "https://github.com/thewolff/other.git")).toBeNull();
		expect(servedRepo(config, "/Users/jo/code/agent-system-2.0")).toBeNull();
		expect(reportCapBytes(config)).toBe(50 * 1024 * 1024);
	});
	test("no block serves nothing; a malformed block is an error, never a default", () => {
		expect(testRunnerConfig({})).toEqual({ ok: true, config: { repos: [], ...TEST_RUNNER_DEFAULTS } });
		expect(testRunnerConfig({ testRunner: { repos: [{ origin: "o/r", command: "bun test" }] } })).toEqual({ ok: true, config: { repos: [{ origin: "o/r", command: "bun test" }], ...TEST_RUNNER_DEFAULTS } });
		for (const bad of [{ testRunner: [] }, { testRunner: { repos: {} } }, { testRunner: { repos: [{ origin: "/local/path", command: "bun test" }] } }, { testRunner: { repos: [{ origin: "o/r" }] } }, { testRunner: { fullCapMin: 0 } }, { testRunner: { soloCapMin: "10" } }]) {
			expect(testRunnerConfig(bad).ok).toBe(false);
		}
		expect(ownerRepoOf("https://gitlab.com/o/r.git")).toBeNull();
	});
	test("the runs root: the override, else test-runs beside the resolved ledger; run, work and stage dirs", () => {
		expect(runsRoot({ HOME: "/h", AGENT_SYSTEM_TEST_RUNS: "/tmp/runs" })).toBe("/tmp/runs");
		expect(runsRoot({ HOME: "/h" })).toBe("/h/.agent-system-2/test-runs");
		expect(runsRoot({ HOME: "/h", AGENT_SYSTEM_LEDGER_DB: "/w/home/.agent-system-2/ledger.db" })).toBe("/w/home/.agent-system-2/test-runs");
		expect(runDirOf("/r", "tr-1")).toBe("/r/tr-1");
		expect(workDirOf("tr-1")).toBe("/Users/Shared/as2test/runs/tr-1");
		expect(stageDirOf("tr-1", "/x")).toBe("/x/stage/tr-1");
		expect(() => runDirOf("/r", "../x")).toThrow(TestRunShapeError);
	});
});

// ---- 2. junit and the log -------------------------------------------------------------------------------

describe("junit: counts and failing names with their first error line; anything unreadable is an error", () => {
	test("Bun 1.3.14's report: counts from <testsuites>, names from the nested suites, entities decoded", () => {
		const j = parseJunit(JUNIT_A);
		expect(j.ok).toBe(true);
		if (!j.ok) return;
		expect([j.tests, j.pass, j.fail, j.skip]).toEqual([6, 2, 2, 2]);
		expect(j.failures.map((f) => f.fullName)).toEqual(['sub/a.test.ts > outer > inner > fails <here> & "there"', "sub/a.test.ts > top throws"]);
		expect(j.failures.map((f) => [f.message, f.type])).toEqual([[null, "AssertionError"], [null, "AssertionError"]]);
	});
	test("the first error line comes from the log: after the excerpt's caret, never the test's own console output; a timeout's line follows its marker", () => {
		expect(logFirstErrors(LOG_A, ["sub/a.test.ts", "b.test.ts"])).toEqual(new Map([
			['sub/a.test.ts > outer > inner > fails <here> & "there"', ["error: expect(received).toEqual(expected)"]],
			["sub/a.test.ts > top throws", ["error: boom"]],
		]));
		const c = partResult({ junit: JUNIT_C, log: LOG_C, exit: 1, ms: 57 });
		expect(c.failures).toEqual([
			{ name: "c.test.ts > type error", firstError: "TypeError: bad type" },
			{ name: "c.test.ts > string thrown", firstError: "error: just a string" },
			{ name: "c.test.ts > empty message", firstError: "Error:" },
			{ name: "c.test.ts > d > b ok", firstError: "error: expect(received).toBe(expected)" },
			{ name: "c.test.ts > timeout", firstError: "this test timed out after 50ms." },
		]);
		expect([c.pass, c.fail, c.skip, c.exit, c.error]).toEqual([0, 5, 0, 1, null]);
		// colour codes are stripped
		expect(logFirstErrors("\x1b[1mc.test.ts:\x1b[0m\n4 | x\n   ^\n\x1b[31mTypeError: x\x1b[0m\n\x1b[31m(fail)\x1b[0m t [1ms]", ["c.test.ts"]).get("c.test.ts > t")).toEqual(["TypeError: x"]);
	});
	test("a report's own message wins over the log; with neither, the failure type stands in; more than 20 failures all kept", () => {
		const p = partResult({ junit: manyFailures(25), log: null, exit: 1, ms: 10 });
		expect(p.fail).toBe(25);
		expect(p.failures).toHaveLength(25);
		expect(p.failures[24]).toEqual({ name: "m.test.ts > case 24", firstError: "line one of 24" });
		expect(partResult({ junit: JUNIT_A, log: null, exit: 1, ms: 1 }).failures[0]!.firstError).toBe("AssertionError (no message in the report or the log)");
	});
	test("missing, empty, over-cap, malformed or inconsistent reports never pass", () => {
		const bad: [string, string][] = [
			["", "empty"], [JUNIT_A.slice(0, JUNIT_A.indexOf('<testsuite name="sub/a.test.ts"')), "never closed"], [JUNIT_A.slice(0, 400), "does not parse"],
			["<testsuite tests='1' failures='0'/>", "not <testsuites>"],
			["<testsuites tests='1' failures='0'><testcase name='a'></testsuite></testsuites>", "closes"], ["<testsuites tests='x' failures='0'/>", "whole numbers"],
			["<testsuites tests='1' failures='0'>&nbsp;</testsuites>", "entity"], ["junk<testsuites tests='0' failures='0'/>", "outside the root"],
			["<testsuites tests='1' failures='2' skipped='0'/>", "do not add up"], ["<testsuites tests='2' failures='0'><testcase name='a'/></testsuites>", "lists 1 test cases"],
			["<testsuites tests='1' failures='1'><testcase name='a'/></testsuites>", "failing cases"], ["<testsuites tests='0' failures='0'/><testsuites tests='0' failures='0'/>", "second root"],
			["<!DOCTYPE x><testsuites tests='0' failures='0'/>", "DOCTYPE"], ["<testsuites tests='0' tests='0' failures='0'/>", "twice"],
		];
		for (const [xml, why] of bad) {
			const j = parseJunit(xml);
			expect(j).toMatchObject({ ok: false, error: expect.stringContaining(why) });
		}
		expect(parseJunit(JUNIT_A, { maxBytes: 100 })).toEqual({ ok: false, error: "junit report is over the 100-byte cap" });
		expect(partResult({ junit: null, log: "x", exit: 0, ms: 1 }).error).toBe("junit report missing");
		expect(partResult({ junit: JUNIT_A, log: null, exit: 1, ms: 1, maxBytes: 100 }).error).toContain("cap");
		expect(partResult({ junit: JUNIT_A, log: null, exit: 1, ms: 1, importError: "a symlink" }).error).toBe("report import refused: a symlink");
		expect(partResult({ junit: null, log: null, exit: null, ms: 1, timedOut: true }).error).toBe("timeout");
		const green = "<testsuites tests='1' failures='0'><testsuite name='g.test.ts' file='g.test.ts'><testcase name='ok'/></testsuite></testsuites>";
		expect(partResult({ junit: green, log: null, exit: 0, ms: 1 })).toEqual({ pass: 1, fail: 0, skip: 0, exit: 0, ms: 1, error: null, failures: [] });
		expect(partResult({ junit: green, log: null, exit: 1, ms: 1 }).error).toBe("exit 1 with no failing test");
		expect(partResult({ junit: green, log: null, exit: null, ms: 1 }).error).toBe("killed before it exited");
		expect(partResult({ junit: green, log: null, exit: 0, ms: 1, timedOut: true }).error).toBe("timeout");
	});
	test("the installed bun's own report and log parse the same way (format drift fails here)", () => {
		const dir = tmp("junit-live");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "a.test.ts"), [
			'import { describe, expect, test } from "bun:test";',
			'describe("outer", () => { test("passes", () => { expect(1).toBe(1); }); test("fails", () => { expect(1).toBe(2); }); });',
			'test.skip("skipped", () => {});',
			'test("throws", () => { console.log("error: decoy"); throw new TypeError("bad type"); });',
		].join("\n"));
		const out = join(dir, "out.xml");
		const p = Bun.spawnSync([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${out}`], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
		const log = `${p.stdout.toString()}${p.stderr.toString()}`;
		const r = partResult({ junit: readFileSync(out, "utf8"), log, exit: p.exitCode, ms: 1 });
		expect([r.pass, r.fail, r.skip, r.exit, r.error]).toEqual([1, 2, 1, 1, null]);
		expect(r.failures).toEqual([
			{ name: "sub/a.test.ts > outer > fails", firstError: "error: expect(received).toBe(expected)" },
			{ name: "sub/a.test.ts > throws", firstError: "TypeError: bad type" },
		]);
	});
});

// ---- 3. changed test files -----------------------------------------------------------------------------

describe("changed test files: Bun's discovery names as exact ./ paths", () => {
	test("every discovery shape and extension is kept, everything else dropped", () => {
		const names = ["a.test.ts", "b_test.tsx", "c.spec.js", "d_spec.jsx", "e.test.mjs", "f.test.cjs", "g.spec.mts", "h_test.cts"];
		for (const n of names) expect(isBunTestFile(`dir/${n}`)).toBe(true);
		for (const n of ["a.test.md", "atest.ts", "a.tests.ts", "test.ts", "a.test.ts.bak", "test/helpers.ts", "a.spec", "a-test.ts"]) expect(isBunTestFile(n)).toBe(false);
	});
	test("from git diff --name-only output: order kept, repeats and unsafe paths dropped, quoting undone, -z accepted", () => {
		const out = ["surface/test/a.test.ts", "surface/src/a.ts", "README.md", "gates/test/b_spec.mts", "surface/test/a.test.ts", "/abs/x.test.ts", "../up.test.ts", "x//y.test.ts", '"surface/test/na\\303\\257ve \\"q\\".test.ts"', ""].join("\n");
		expect(changedTestFiles(out)).toEqual(["./surface/test/a.test.ts", "./gates/test/b_spec.mts", './surface/test/naïve "q".test.ts']);
		expect(changedTestFiles("a.test.ts\0b.txt\0dir/new line\n.test.ts\0")).toEqual(["./a.test.ts", "./dir/new line\n.test.ts"]);
		expect(changedTestFiles('"broken\\q.test.ts"')).toEqual([]);
		expect(changedTestFiles("")).toEqual([]);
	});
});

// ---- 4. verdict, settle, ownership ----------------------------------------------------------------------

describe("verdict and settle", () => {
	const part = (fail = 0, over: Partial<PartResult> = {}): PartResult => ({
		pass: 10, fail, skip: 0, exit: fail > 0 ? 1 : 0, ms: 5, error: null, failures: Array.from({ length: fail }, (_, i) => ({ name: `f > t${i}`, firstError: `error: e${i}` })), ...over,
	});
	const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
		requestedSha: A, fetchedSha: A, error: null, full: part(), solo: [{ file: "./x.test.ts", ...part() }], headAtStart: A, headAtEnd: A, owner: true, sliceState: "open",
		mode: "full", basis: null, merge: null, ...over,
	});
	test("green at an unchanged head settles an open slice, and only an open one", () => {
		expect(decideRun(facts())).toEqual({ verdict: "green", outcome: "green", reason: null, settle: true });
		for (const s of ["paused", "done", "cancelled", null] as const) expect(decideRun(facts({ sliceState: s }))).toMatchObject({ verdict: "green", settle: false });
	});
	test("a solo failure with the suite green is red; red never settles", () => {
		expect(decideRun(facts({ solo: [{ file: "./x.test.ts", ...part(1) }] }))).toEqual({ verdict: "red", outcome: "red", reason: null, settle: false });
		expect(decideRun(facts({ full: part(2) }))).toMatchObject({ verdict: "red", settle: false });
		// a failing test outranks another part's error
		expect(decideRun(facts({ full: part(1), solo: [{ file: "./x.test.ts", ...part(0, { error: "junit report missing" }) }] }))).toMatchObject({ verdict: "red" });
	});
	test("head moved by the end: stale whatever the counts, no settle", () => {
		expect(decideRun(facts({ headAtEnd: B }))).toMatchObject({ verdict: "stale", settle: false });
		expect(decideRun(facts({ headAtEnd: B, full: part(3) })).verdict).toBe("stale");
		expect(decideRun(facts({ headAtEnd: B }))!.reason).toContain("moved to bbbbbbb");
	});
	test("a fetched head that is not the requested sha: stale before any test", () => {
		const d = decideRun(facts({ fetchedSha: B, full: null, solo: [], headAtEnd: null }));
		expect(d).toMatchObject({ verdict: "stale", settle: false });
		expect(d.reason).toContain("nothing was tested");
	});
	test("errors: a run-level failure, an unfetched head, a missing full part, a failed re-read, a broken part", () => {
		expect(decideRun(facts({ error: "clone failed" }))).toEqual({ verdict: "error", outcome: "error", reason: "clone failed", settle: false });
		expect(decideRun(facts({ fetchedSha: null })).verdict).toBe("error");
		expect(decideRun(facts({ full: null })).verdict).toBe("error");
		expect(decideRun(facts({ headAtEnd: null })).verdict).toBe("error");
		expect(decideRun(facts({ solo: [{ file: "./x.test.ts", ...part(0, { error: "timeout", exit: null }) }] }))).toMatchObject({ verdict: "error", reason: "./x.test.ts: timeout" });
		expect(decideRun(facts({ full: part(0, { exit: 2 }) }))).toMatchObject({ verdict: "error", reason: "full: exit 2" });
	});
	test("not the owner: superseded, with what it found, settling nothing", () => {
		const d = decideRun(facts({ owner: false }));
		expect(d).toMatchObject({ verdict: "superseded", outcome: "green", settle: false });
		expect(d.reason).toContain("lost ownership");
		expect(decideRun(facts({ owner: false, full: part(1) }))).toMatchObject({ verdict: "superseded", outcome: "red", settle: false });
	});
	test("the entry built from the facts carries every failure of every part; the artifact names the counts", () => {
		const r = request("tr-0abc12", 17, A);
		const f = facts({ full: part(21), solo: [{ file: "./x.test.ts", ...part(2) }] });
		const t = buildTestRun(r, f, decideRun(f), { base: B, mergeBase: C, runDir: "/runs/tr-0abc12", preflight: "ok" });
		expect(t.failures).toHaveLength(23);
		expect(t.failures.filter((x) => x.part === "./x.test.ts")).toHaveLength(2);
		expect(parseTestRun(testRunBody(t))).toEqual(t);
		const g = buildTestRun(r, facts(), decideRun(facts()), { base: B, mergeBase: C, runDir: "/runs/tr-0abc12", preflight: "ok" });
		expect(settleArtifact(g)).toBe(`test-run tr-0abc12: green at ${A} on PR #17; full 10/0/0; alone: ./x.test.ts 10/0; /runs/tr-0abc12`);
		expect(() => settleArtifact(t)).toThrow(TestRunShapeError);
	});
	test("doc-merge (plan wl-mv615mkeaf1yio § 3): no full part is green only with a basis; the parts it ran still decide; the entry and the artifact name the basis", () => {
		const basis = { runId: "tr-0basis1", sha: B };
		const merge = { main: C, tip: D, docs: ["MIGRATION.md"] };
		const dm = (over: Partial<RunFacts> = {}) => facts({ full: null, mode: "doc-merge", basis, merge, ...over });
		expect(decideRun(dm())).toEqual({ verdict: "green", outcome: "green", reason: null, settle: true });
		// no test file changed: no part ran at all, and the green rests on the basis
		expect(decideRun(dm({ solo: [] }))).toEqual({ verdict: "green", outcome: "green", reason: null, settle: true });
		// full === null and no basis: error, whatever the mode says
		expect(decideRun(dm({ basis: null }))).toEqual({ verdict: "error", outcome: "error", reason: "the full suite did not run", settle: false });
		expect(decideRun(facts({ full: null, mode: "full" }))).toMatchObject({ verdict: "error", reason: "the full suite did not run" });
		expect(decideRun(dm({ solo: [{ file: "./x.test.ts", ...part(1) }] }))).toMatchObject({ verdict: "red", settle: false });
		expect(decideRun(dm({ solo: [{ file: "./x.test.ts", ...part(0, { exit: 3 }) }] }))).toMatchObject({ verdict: "error", reason: "./x.test.ts: exit 3" });
		expect(decideRun(dm({ headAtEnd: B }))).toMatchObject({ verdict: "stale" });
		const r = request("tr-0abc12", 17, A);
		const t = buildTestRun(r, dm({ solo: [] }), decideRun(dm({ solo: [] })), { base: D, mergeBase: C, runDir: "/runs/tr-0abc12", preflight: "ok" });
		expect(t).toMatchObject({ verdict: "green", full: null, solo: [], mode: "doc-merge", basis, merge });
		expect(parseTestRun(testRunBody(t))).toEqual(t);
		expect(settleArtifact(t)).toBe(`test-run tr-0abc12: green at ${A} on PR #17; doc-merge on basis tr-0basis1 at ${B}; alone: none; /runs/tr-0abc12`);
		const withSolo = buildTestRun(r, dm(), decideRun(dm()), { base: D, mergeBase: C, runDir: null, preflight: "ok" });
		expect(settleArtifact(withSolo)).toBe(`test-run tr-0abc12: green at ${A} on PR #17; doc-merge on basis tr-0basis1 at ${B}; alone: ./x.test.ts 10/0; no run dir`);
	});
	test("the orchestrator hears a non-green, owned result only when no lane holds the workload live", () => {
		expect(notifiesOrchestrator("red", false)).toBe(true);
		expect(notifiesOrchestrator("error", false)).toBe(true);
		expect(notifiesOrchestrator("stale", false)).toBe(true);
		expect(notifiesOrchestrator("red", true)).toBe(false);
		expect(notifiesOrchestrator("green", false)).toBe(false);
		expect(notifiesOrchestrator("superseded", false)).toBe(false);
	});
});

describe("ownership and the runner's records", () => {
	test("only the runner's parsable entries count; a result needs its request", () => {
		const r1 = request("tr-1", 17, A);
		const recs = testRuns([reqEntry(r1), reqEntry(request("tr-2", 17, A), "lane-t-1"), entry(TEST_RUNNER_BY, "test-requested: garbage"), runEntry(run(request("tr-9", 17, A), "green"))]);
		expect(recs.map((r) => [r.request.runId, r.results.length])).toEqual([["tr-1", 0]]);
	});
	test("the newest request on its slice with no result owns; a result or a newer request ends it", () => {
		const r1 = request("tr-1", 17, A);
		const r2 = request("tr-2", 17, B);
		const other = request("tr-3", 17, B, "sl-other");
		expect(ownsRequest(testRuns([reqEntry(r1)]), "tr-1")).toBe(true);
		expect(ownsRequest(testRuns([reqEntry(r1), reqEntry(other)]), "tr-1")).toBe(true);
		expect(ownsRequest(testRuns([reqEntry(r1), reqEntry(r2)]), "tr-1")).toBe(false);
		expect(ownsRequest(testRuns([reqEntry(r1), runEntry(runnerDiedRun(r1))]), "tr-1")).toBe(false);
		expect(ownsRequest(testRuns([reqEntry(r1)]), "tr-404")).toBe(false);
	});
	test("a run's own result is its first non-superseded one; a late superseded write is diagnostic only", () => {
		const r1 = request("tr-1", 17, A);
		const [rec] = testRuns([reqEntry(r1), runEntry(runnerDiedRun(r1)), runEntry(run(r1, "superseded"))]);
		expect(rec!.results.map((x) => x.verdict)).toEqual(["error", "superseded"]);
		expect(rec!.result!.verdict).toBe("error");
		const [only] = testRuns([reqEntry(r1), runEntry(run(r1, "superseded"))]);
		expect(only!.result).toBeNull();
	});
});

// ---- 5. bound branch --------------------------------------------------------------------------------------

describe("bound branch", () => {
	const pr = (over: Partial<PrView> = {}): PrView => ({ number: 17, state: "OPEN", headRefOid: A, headRefName: "wl/wl-t", baseRefName: "main", isCrossRepository: false, ...over });
	test("wl/<wl> is bound; a push-dest: binds its branch only when a holder wrote it", () => {
		const launch = entry("lane-starter", "launch: lane-t-1 cause first requested-by jo");
		const byHolder = entry("lane-t-1", pushDestBody({ remote: "origin", branch: "wl/wl-other", sha: A }));
		const byStranger = entry("lane-x-9", pushDestBody({ remote: "origin", branch: "wl/wl-stolen", sha: A }));
		const rows = [launch, byHolder, byStranger];
		const bound = boundBranches("wl-t", rows, holdersOf(rows, null));
		expect(bound).toEqual(["wl/wl-t", "wl/wl-other"]);
		expect(prAdmissible(pr(), bound)).toEqual({ ok: true });
		expect(prAdmissible(pr({ headRefName: "wl/wl-other" }), bound)).toEqual({ ok: true });
		expect(prAdmissible(pr({ headRefName: "wl/wl-stolen" }), bound)).toMatchObject({ ok: false });
		expect(prAdmissible(pr({ headRefName: "wl/wl-other" }), boundBranches("wl-t", [launch], holdersOf([launch], null)))).toMatchObject({ ok: false });
	});
	test("a PR that is not open, comes from a fork, or has no full head sha is refused", () => {
		const bound = ["wl/wl-t"];
		expect(prAdmissible(pr({ state: "CLOSED" }), bound)).toEqual({ ok: false, reason: "PR #17 is closed, not open" });
		expect(prAdmissible(pr({ state: "MERGED" }), bound)).toMatchObject({ ok: false });
		expect(prAdmissible(pr({ isCrossRepository: true }), bound)).toMatchObject({ ok: false, reason: expect.stringContaining("fork") });
		expect(prAdmissible(pr({ headRefOid: "abc" }), bound)).toMatchObject({ ok: false });
	});
	// PLAN wl-mv5qdfvv82ivwg § 3, pre-fail selection: only origin/main's exports and literals, so this test alone fails there on its assertion.
	test("pre-fail: a PR Jo bound by number is admitted though its head branch is outside the bound branches", () => {
		expect(prAdmissible(pr({ number: 79, headRefName: "plumb/x" }), ["wl/wl-t"], [79])).toEqual({ ok: true });
	});
	test("guard: an unbound plumb/x PR is refused", () => {
		expect(prAdmissible(pr({ number: 79, headRefName: "plumb/x" }), ["wl/wl-t"])).toMatchObject({
			ok: false, reason: expect.stringContaining("plumb/x is not one this workload is bound to"),
		});
	});
	test("guard: PR #M is refused while only #N is bound, its branch outside the bound branches", () => {
		expect(prAdmissible(pr({ number: 70, headRefName: "plumb/y" }), ["wl/wl-t"], [79])).toMatchObject({
			ok: false, reason: expect.stringContaining("plumb/y is not one this workload is bound to"),
		});
	});
	test("guard: a bound PR that is closed, merged or from a fork is refused with the state reason", () => {
		const bound = ["wl/wl-t"];
		const plumb = { number: 79, headRefName: "plumb/x" };
		expect(prAdmissible(pr({ ...plumb, state: "CLOSED" }), bound, [79])).toEqual({ ok: false, reason: "PR #79 is closed, not open" });
		expect(prAdmissible(pr({ ...plumb, state: "MERGED" }), bound, [79])).toEqual({ ok: false, reason: "PR #79 is merged, not open" });
		expect(prAdmissible(pr({ ...plumb, isCrossRepository: true }), bound, [79])).toEqual({ ok: false, reason: "PR #79 comes from a fork; a fork head never runs" });
	});
	test("the refusal names both the bound branches and Jo's binding word; a bound number still needs a full head sha", () => {
		expect(prAdmissible(pr({ number: 70, headRefName: "plumb/y" }), ["wl/wl-t"], [79])).toEqual({
			ok: false,
			reason: "PR #70's head branch plumb/y is not one this workload is bound to (wl/wl-t) and Jo has not bound PR #70 to it (`test-pr wl-t 70`)",
		});
		expect(prAdmissible(pr({ number: 79, headRefName: "plumb/x", headRefOid: "abc" }), ["wl/wl-t"], [79])).toEqual({ ok: false, reason: "PR #79 reports no full head sha" });
	});
});

describe("boundPrs: Jo's test-pr binding (PLAN wl-mv5qdfvv82ivwg § 2.2, § 2.3)", () => {
	let n = 0;
	const instruction = (over: Partial<InstructionRow> = {}): InstructionRow => ({
		id: `in-${++n}`, workload_id: "wl-t", slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface",
		author: "jo", body: "", created_by: SURFACE_BY, created_at: new Date(NOW).toISOString(), ...over,
	});
	/** Jo's instruction for `prs` on wl-t plus the surface's entry naming it, as `apply` writes them. */
	const bind = (prs: number[], over: Partial<InstructionRow> = {}) => {
		const ins = instruction({ body: testPrInstructionBody("wl-t", prs), ...over });
		return { ins, ent: entry(SURFACE_BY, testPrBody(prs, ins.id)) };
	};
	test("the bodies: Jo's instruction and the surface's entry naming it", () => {
		expect(testPrInstructionBody("wl-t", [79, 70])).toBe("test-pr wl-t 79 70");
		expect(testPrBody([79, 70], "in-1")).toBe("test-pr: 79 70 in-1");
	});
	test("a surface entry naming Jo's surface instruction with the same numbers binds them, with that instruction", () => {
		const { ins, ent } = bind([79, 70]);
		expect(boundPrs([ent], [ins])).toEqual([{ pr: 79, instructionId: ins.id }, { pr: 70, instructionId: ins.id }]);
	});
	test("a lane-written entry binds nothing, even naming Jo's real instruction", () => {
		const { ins } = bind([79]);
		expect(boundPrs([entry("lane-t-1", testPrBody([79], ins.id))], [ins])).toEqual([]);
		expect(boundPrs([entry(TEST_RUNNER_BY, testPrBody([79], ins.id))], [ins])).toEqual([]);
	});
	test("a surface entry naming an instruction that is not Jo's surface instruction binds nothing", () => {
		for (const over of [{ author: "lane-t-1" }, { created_by: "lane-t-1" }, { kind: "answer" as const }, { channel: "direct" as const, created_by: "lane-t-1" }]) {
			const { ins, ent } = bind([79], over);
			expect(boundPrs([ent], [ins])).toEqual([]);
		}
		const { ent } = bind([79]);
		expect(boundPrs([ent], [])).toEqual([]);
	});
	test("an instruction on another workload binds nothing here", () => {
		const ins = instruction({ workload_id: "wl-other", body: testPrInstructionBody("wl-other", [79]) });
		expect(boundPrs([entry(SURFACE_BY, testPrBody([79], ins.id))], [ins])).toEqual([]);
		const sameBody = instruction({ workload_id: "wl-other", body: testPrInstructionBody("wl-t", [79]) });
		expect(boundPrs([entry(SURFACE_BY, testPrBody([79], sameBody.id))], [sameBody])).toEqual([]);
	});
	test("numbers that differ from the instruction's bind nothing", () => {
		const ins = instruction({ body: testPrInstructionBody("wl-t", [79]) });
		expect(boundPrs([entry(SURFACE_BY, testPrBody([79, 70], ins.id))], [ins])).toEqual([]);
		expect(boundPrs([entry(SURFACE_BY, testPrBody([70], ins.id))], [ins])).toEqual([]);
		expect(boundPrs([entry(SURFACE_BY, `test-pr: 079 ${ins.id}`)], [instruction({ id: ins.id, body: "test-pr wl-t 079" })])).toEqual([]);
		expect(boundPrs([entry(SURFACE_BY, `test-pr: ${ins.id}`)], [ins])).toEqual([]);
	});
	test("the orchestrator's recorded instruction shape binds nothing", () => {
		const ins = instruction({ body: 'Jo: "test-pr wl-t 79" — reading: bind PR 79 to wl-t for a test run' });
		expect(boundPrs([entry(SURFACE_BY, testPrBody([79], ins.id))], [ins])).toEqual([]);
	});
	test("two words accumulate in order; a number bound twice keeps its first instruction", () => {
		const one = bind([79, 70]);
		const two = bind([73, 79]);
		expect(boundPrs([one.ent, two.ent], [one.ins, two.ins])).toEqual([
			{ pr: 79, instructionId: one.ins.id }, { pr: 70, instructionId: one.ins.id }, { pr: 73, instructionId: two.ins.id },
		]);
	});
});

// ---- 6. the child's env and the git shim -----------------------------------------------------------------

describe("the untrusted child's env and git shim (§ 3)", () => {
	const parent: Record<string, string> = {
		PATH: "/opt/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", USER: "_as2test", LOGNAME: "_as2test", SHELL: "/bin/sh", TERM: "dumb",
		HOME: "/Users/jo", TMPDIR: "/var/folders/x", GH_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk", OPENAI_ORG_ID: "org", MOONSHOT_API_KEY: "ms",
		SSH_AUTH_SOCK: "/tmp/agent.sock", OMP_PROFILE: "agent-system-2", AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: "/Users/jo/.agent-system-2/ledger.db",
		AGENT_SYSTEM_TEST_RUNS: "/Users/jo/.agent-system-2/test-runs", GIT_CONFIG_GLOBAL: "/Users/jo/.gitconfig", XDG_CONFIG_HOME: "/Users/jo/.config",
	};
	test("empty plus the allowlist plus the throwaway home and git settings; no credential survives", () => {
		const env = childEnv(parent, "/Users/Shared/as2test/runs/tr-1");
		const w = "/Users/Shared/as2test/runs/tr-1";
		expect(env).toEqual({
			PATH: `${w}/shim:/opt/bin:/usr/bin:/bin`, LANG: "en_US.UTF-8", USER: "_as2test", LOGNAME: "_as2test", SHELL: "/bin/sh", TERM: "dumb",
			HOME: `${w}/home`, TMPDIR: `${w}/home/tmp`, XDG_CONFIG_HOME: `${w}/home/.config`, XDG_CACHE_HOME: `${w}/home/.cache`, XDG_DATA_HOME: `${w}/home/.local/share`,
			BUN_INSTALL_CACHE_DIR: `${w}/home/.bun/install/cache`, AGENT_SYSTEM_LEDGER_DB: `${w}/home/.agent-system-2/ledger.db`,
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: `${w}/home/.gitconfig`, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false",
		});
		for (const k of Object.keys(env)) expect(k).not.toMatch(/^(GH_|ANTHROPIC_|OPENAI_|MOONSHOT_|SSH_|OMP_)/);
		expect(Object.keys(env).filter((k) => k.startsWith("AGENT_SYSTEM_"))).toEqual(["AGENT_SYSTEM_LEDGER_DB"]);
		expect([...CHILD_ENV_ALLOWLIST]).toEqual(["PATH", "LANG", "USER", "LOGNAME", "SHELL", "TERM"]);
		expect(childEnv({}, w).PATH).toBe(`${w}/shim:/usr/bin:/bin:/usr/sbin:/sbin`);
		expect(childLayout(w).shimDir).toBe(`${w}/shim`);
		expect(() => childEnv(parent, "relative/dir")).toThrow(TestRunShapeError);
		expect(() => childEnv(parent, "/a:b")).toThrow(TestRunShapeError);
		expect(childGitconfigText()).toBe("[user]\n\tname = as2 test runner\n\temail = as2-test-runner@localhost\n");
	});
	test("a descendant that rebuilds its env as {HOME, PATH} still runs git through the shim, with the settings re-asserted", () => {
		const w = tmp("shim");
		const l = childLayout(w);
		mkdirSync(l.shimDir, { recursive: true });
		const fake = join(w, "real git");
		writeFileSync(fake, '#!/bin/sh\nprintf "%s|%s|%s|%s|%s\\n" "$GIT_CONFIG_NOSYSTEM" "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$HOME" "$*"\n');
		chmodSync(fake, 0o755);
		writeFileSync(join(l.shimDir, "git"), gitShimText(fake));
		chmodSync(join(l.shimDir, "git"), 0o755);
		const env = childEnv({ PATH: "/usr/bin:/bin" }, w);
		const descendantHome = join(w, "descendant-home");
		const p = Bun.spawnSync(["/usr/bin/env", "-i", `HOME=${descendantHome}`, `PATH=${env.PATH}`, "/bin/sh", "-c", "git status --short 'two words'"], { stdout: "pipe", stderr: "pipe" });
		expect(p.stderr.toString()).toBe("");
		expect(p.stdout.toString()).toBe(`1|0|/usr/bin/false|${descendantHome}|-c credential.helper= status --short two words\n`);
		expect(gitShimText("/odd/it's/git")).toContain(`exec '/odd/it'\\''s/git' -c credential.helper= "$@"`);
		expect(() => gitShimText("git")).toThrow(TestRunShapeError);
	});
	test("through the real git, the shim leaves no credential helper from system config", () => {
		const real = Bun.which("git", { PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" });
		expect(real).not.toBeNull();
		const w = tmp("shim-real");
		const l = childLayout(w);
		mkdirSync(l.shimDir, { recursive: true });
		writeFileSync(join(l.shimDir, "git"), gitShimText(real!));
		chmodSync(join(l.shimDir, "git"), 0o755);
		const p = Bun.spawnSync(["/usr/bin/env", "-i", `HOME=${w}`, `PATH=${l.shimDir}:/usr/bin:/bin`, "git", "config", "--show-origin", "--get-all", "credential.helper"], { stdout: "pipe", stderr: "pipe" });
		expect(p.stdout.toString()).not.toContain("osxkeychain");
		expect(p.stdout.toString().split("\n").filter((x) => x.trim() !== "")).toEqual(["command line:\t"]);
	});
});

// ---- 7. liveness, heartbeat, reservation --------------------------------------------------------------------

describe("liveness from the heartbeat", () => {
	test("live iff no result and (heartbeat under 60 s, or no heartbeat and the request under 120 s)", () => {
		const at = (s: number) => NOW - s * 1000;
		expect(runLive({ settled: false, requestedAtMs: at(10), heartbeatAtMs: null }, NOW)).toBe(true);
		expect(runLive({ settled: false, requestedAtMs: at(119), heartbeatAtMs: null }, NOW)).toBe(true);
		expect(runLive({ settled: false, requestedAtMs: at(120), heartbeatAtMs: null }, NOW)).toBe(false);
		expect(runLive({ settled: false, requestedAtMs: at(3600), heartbeatAtMs: at(59) }, NOW)).toBe(true);
		expect(runLive({ settled: false, requestedAtMs: at(3600), heartbeatAtMs: at(60) }, NOW)).toBe(false);
		// a heartbeat, once there, decides: a stale one is dead even inside the startup lease
		expect(runLive({ settled: false, requestedAtMs: at(10), heartbeatAtMs: at(61) }, NOW)).toBe(false);
		expect(runLive({ settled: true, requestedAtMs: at(1), heartbeatAtMs: at(1) }, NOW)).toBe(false);
	});
	test("the heartbeat file round-trips for its own run only; the lock row's staleness is separate", () => {
		expect(parseHeartbeat(heartbeatText("tr-1", NOW), "tr-1")).toBe(NOW);
		expect(parseHeartbeat(heartbeatText("tr-1", NOW), "tr-2")).toBeNull();
		expect(parseHeartbeat("garbage", "tr-1")).toBeNull();
		expect(lockHolderStale(NOW - 60_000, NOW)).toBe(false);
		expect(lockHolderStale(NOW - 60_001, NOW)).toBe(true);
	});
	// Jo's queue drop rule (in-mv92rsb78t4em8, in-mv9340e04pgbnk): only superseded or past the 6 h backstop.
	test("a run queued 61 minutes is not dropped under the default config, whatever an open or unread PR state", () => {
		const config = { queueMaxMin: TEST_RUNNER_DEFAULTS.queueMaxMin };
		for (const prState of [null, "OPEN"]) expect(queueWaitDecision({ waitedMs: 61 * 60_000, pr: 17, prState, config })).toEqual({ act: "wait" });
		expect(queueWaitDecision({ waitedMs: 360 * 60_000, pr: 17, prState: "OPEN", config })).toEqual({ act: "wait" });
		expect(config.queueMaxMin).toBe(360);
	});
	test("past queueMaxMin the backstop drops the run; the reason names the re-request or why it was refused", () => {
		const config = { queueMaxMin: TEST_RUNNER_DEFAULTS.queueMaxMin };
		expect(queueWaitDecision({ waitedMs: 360 * 60_000 + 1, pr: 17, prState: "OPEN", config })).toEqual({ act: "backstop", reason: "queued past the 360 min backstop" });
		// An unreadable PR state never drops a run, nor keeps it past the backstop.
		expect(queueWaitDecision({ waitedMs: 361 * 60_000, pr: 17, prState: null, config })).toEqual({ act: "backstop", reason: "queued past the 360 min backstop" });
		// A batch or an attribution watches no PR: the backstop alone drops it.
		expect(queueWaitDecision({ waitedMs: 361 * 60_000, pr: null, prState: "MERGED", config })).toEqual({ act: "backstop", reason: "queued past the 360 min backstop" });
		expect(queueWaitDecision({ waitedMs: 61 * 60_000, pr: null, prState: "MERGED", config })).toEqual({ act: "wait" });
		const again = backstopReason(360, { runId: "tr-0abc1234zzzz" });
		expect(again).toBe("queued past the 360 min backstop; re-requested as tr-0abc1234zzzz");
		expect(rerequestedAs(again)).toBe("tr-0abc1234zzzz");
		const refused = backstopReason(360, { refused: "slice sl-x is paused, not open" });
		expect(refused).toBe("queued past the 360 min backstop; re-request refused: slice sl-x is paused, not open");
		expect(rerequestedAs(refused)).toBeNull();
		expect(rerequestedAs(backstopReason(0.01, { runId: "tr-0abc1234zzzz" }))).toBe("tr-0abc1234zzzz");
		expect(rerequestedAs("runner died")).toBeNull();
		expect(rerequestedAs(null)).toBeNull();
	});
	test("a queued run whose PR is MERGED or CLOSED is superseded, before the backstop and past it", () => {
		const config = { queueMaxMin: 360 };
		for (const state of ["MERGED", "CLOSED"] as const) {
			for (const waitedMs of [5 * 60_000, 400 * 60_000]) {
				const d = queueWaitDecision({ waitedMs, pr: 17, prState: state, config });
				expect(d).toEqual({ act: "superseded", reason: `PR #17 is ${state}` });
				if (d.act !== "superseded") throw new Error("not superseded");
				expect(prGoneOf(d.reason)).toEqual({ pr: 17, state });
				// finish prefixes the lost lock or request to decideRun's own reason.
				expect(prGoneOf(`${d.reason}; lost ownership of the request; the run found error (the PR head was never fetched)`)).toEqual({ pr: 17, state });
			}
		}
		expect(prGoneOf("the request was superseded while the run was queued; lost ownership of the request")).toBeNull();
		expect(prGoneOf(null)).toBeNull();
	});
	test("the starter's reservation: refused while a run is live (startup lease included); dead unsettled requests are settled first", () => {
		const r1 = request("tr-1", 17, A);
		const recs = testRuns([reqEntry(r1)]);
		const requestedAt = Date.parse(recs[0]!.request.createdAt);
		expect(reservation(recs, () => null, requestedAt + 5_000)).toMatchObject({ ok: false, live: { request: { runId: "tr-1" } } });
		expect(recordLive(recs[0]!, null, requestedAt + 5_000)).toBe(true);
		// a queued run keeps beating past the startup lease and stays live
		expect(reservation(recs, () => requestedAt + 590_000, requestedAt + 600_000).ok).toBe(false);
		const dead = reservation(recs, () => null, requestedAt + 121_000);
		expect(dead.ok && dead.settleDead.map((r) => r.request.runId)).toEqual(["tr-1"]);
		const settled = testRuns([reqEntry(r1), runEntry(run(r1, "green"))]);
		expect(reservation(settled, () => null, requestedAt + 1_000)).toEqual({ ok: true, settleDead: [] });
	});
	test("the full-suite slice the starter adds", () => {
		expect(fullSuiteSlice("wl-muraerdsgw7gn4", 17, [])).toEqual({ id: "sl-full-muraerdsgw7gn4-1", task: "full suite outside the fence at PR #17", doneCondition: "a green test-run at the PR head" });
		expect(fullSuiteSlice("wl-m", 3, ["sl-full-m-1", "sl-full-m-4", "sl-full-mx-9", "sl-other"]).id).toBe("sl-full-m-5");
	});
});

describe("the lock queue's head (plan wl-mv615mkeaf1yio § 2)", () => {
	const at = (s: number) => NOW - s * 1000;
	const adm = (seq: number, runId: string, admittedAgoS: number): Admission => ({ seq, runId, admittedAt: at(admittedAgoS) });
	test("delayed start: A was admitted first and its runner has not beaten yet, B beats; A is the head while its 120 s startup lease runs", () => {
		const A = adm(1, "tr-00000000aaaa", 30);
		const B = adm(2, "tr-00000000bbbb", 5);
		const beats: Record<string, number> = { [B.runId]: at(1) };
		expect(queueHead([A, B], (id) => beats[id] ?? null, NOW)).toEqual({ head: A, dead: [] });
		// one second before the lease ends A is still the head; at 120 s it is dead and B leads
		expect(queueHead([A, B], (id) => (id === B.runId ? at(-88) : null), at(-89))).toEqual({ head: A, dead: [] });
		expect(queueHead([A, B], (id) => (id === B.runId ? at(-89) : null), at(-90))).toEqual({ head: B, dead: [A] });
	});
	test("seq order wins over run-id order, whatever order the rows come in", () => {
		const later = adm(7, "tr-000000000aaa", 10);
		const earlier = adm(3, "tr-zzzzzzzzzzzz", 10);
		expect(queueHead([later, earlier], () => at(1), NOW)).toEqual({ head: earlier, dead: [] });
	});
	test("dead admissions are skipped and returned for deletion: a stale heartbeat, or no heartbeat past the lease", () => {
		const stale = adm(1, "tr-00000000dead", 300);
		const silent = adm(2, "tr-0000000silen", 120);
		const live = adm(3, "tr-00000000live", 300);
		const behind = adm(4, "tr-0000000behin", 2);
		const beats: Record<string, number> = { [stale.runId]: at(60), [live.runId]: at(59) };
		expect(queueHead([behind, live, silent, stale], (id) => beats[id] ?? null, NOW)).toEqual({ head: live, dead: [stale, silent] });
	});
	test("an empty queue, or one of dead rows only, has no head", () => {
		expect(queueHead([], () => null, NOW)).toEqual({ head: null, dead: [] });
		const gone = adm(1, "tr-00000000gone", 121);
		expect(queueHead([gone], () => null, NOW)).toEqual({ head: null, dead: [gone] });
	});
});

// ---- 8. retention -------------------------------------------------------------------------------------------

describe("retention", () => {
	test("the newest ten stay whole; older runs are pruned, oldest first", () => {
		const runs = Array.from({ length: 13 }, (_, i) => ({ id: `tr-${String(i).padStart(2, "0")}`, at: NOW + i * 1000 }));
		expect(pruneRuns(runs.toReversed())).toEqual(["tr-00", "tr-01", "tr-02"]);
		expect(pruneRuns(runs.slice(0, KEEP_RUNS))).toEqual([]);
		expect(pruneRuns([{ id: "tr-b", at: 1 }, { id: "tr-a", at: 1 }, { id: "tr-c", at: 2 }], 1)).toEqual(["tr-a", "tr-b"]);
		expect(pruneRuns([], 10)).toEqual([]);
	});
	test("a run live in the queue is never pruned, whatever its age, and the rest prune as before (plan wl-mv615mkeaf1yio § 4)", () => {
		const runs = Array.from({ length: 13 }, (_, i) => ({ id: `tr-${String(i).padStart(2, "0")}`, at: NOW + i * 1000 }));
		expect(pruneRuns(runs, KEEP_RUNS, new Set(["tr-00", "tr-nosuch"]))).toEqual(["tr-01", "tr-02"]);
		expect(pruneRuns(runs, KEEP_RUNS, new Set())).toEqual(["tr-00", "tr-01", "tr-02"]);
	});
});

// ---- 9. the doc-only main-merge rule (plan wl-mv615mkeaf1yio § 3) -----------------------------------------------

/** One finished run of the runner on the workload: its request and its `test-run:`, parsed back through testRuns. */
const finished = (runId: string, pr: number, sha: string, verdict: TestRun["verdict"] = "green", over: Partial<TestRun> = {}): RunRecord[] => {
	const q = request(runId, pr, sha);
	return testRuns([reqEntry(q), runEntry(run(q, verdict, over))]);
};

describe("the doc-only main-merge rule (plan wl-mv615mkeaf1yio § 3)", () => {
	// H = D merges P1 = A (the branch's green head) with P2 = B (a main state); C is their merge base.
	const diffs = (o: Partial<MergeDiffs> = {}): MergeDiffs => ({ baseP1: [], baseP2: [], p1p2: [], p1h: [], p2h: [], ...o });
	const facts = (o: Partial<MergeFacts> = {}): MergeFacts => ({ parents: [A, B], tip: B, mainOnChain: true, mergeBases: [C], diffs: diffs(), ...o });
	const basis = finished("tr-1", 17, A);
	const full = (reason: string) => ({ mode: "full" as const, reason });
	// the branch changed x.ts and MIGRATION.md, main changed y.ts and MIGRATION.md, MIGRATION.md resolved by hand
	const docOnly = diffs({
		baseP1: ["MIGRATION.md", "surface/src/x.ts"], baseP2: ["MIGRATION.md", "ledger/src/y.ts"], p1p2: ["MIGRATION.md", "ledger/src/y.ts", "surface/src/x.ts"],
		p1h: ["MIGRATION.md", "ledger/src/y.ts"], p2h: ["MIGRATION.md", "surface/src/x.ts"],
	});
	test("the doc list is exactly MIGRATION.md and USER-GUIDE.md at the root, plus the decision-log prefix", () => {
		expect(DOC_MERGE_DOCS).toEqual({ files: ["MIGRATION.md", "USER-GUIDE.md"], prefixes: [".ai/decision-log/"] });
	});
	test("a doc-only resolution passes: the basis, the merged main, the fetched tip and the docs it touched are recorded", () => {
		expect(docMergeDecision(facts({ diffs: docOnly }), basis, 17)).toEqual({ mode: "doc-merge", basis: { runId: "tr-1", sha: A }, merge: { main: B, tip: B, docs: ["MIGRATION.md"] } });
		// every listed doc may differ in any way; the tip may be ahead of the merged main state
		const docs = ["MIGRATION.md", "USER-GUIDE.md", ".ai/decision-log/2026-10-13--x.md"];
		expect(docMergeDecision(facts({ tip: D, diffs: diffs({ p1h: docs, p2h: docs }) }), basis, 17)).toEqual({ mode: "doc-merge", basis: { runId: "tr-1", sha: A }, merge: { main: B, tip: D, docs: [".ai/decision-log/2026-10-13--x.md", "MIGRATION.md", "USER-GUIDE.md"] } });
	});
	test("a code file trivially merged from one side passes, from either side, with no doc touched", () => {
		const oneSide = diffs({ baseP1: ["surface/src/x.ts"], baseP2: ["ledger/src/y.ts"], p1p2: ["ledger/src/y.ts", "surface/src/x.ts"], p1h: ["ledger/src/y.ts"], p2h: ["surface/src/x.ts"] });
		expect(docMergeDecision(facts({ diffs: oneSide }), basis, 17)).toEqual({ mode: "doc-merge", basis: { runId: "tr-1", sha: A }, merge: { main: B, tip: B, docs: [] } });
		// both sides made the same change: no conflict, H equals both parents there
		const same = diffs({ baseP1: ["surface/src/x.ts"], baseP2: ["surface/src/x.ts"] });
		expect(docMergeDecision(facts({ diffs: same }), basis, 17)).toMatchObject({ mode: "doc-merge" });
	});
	test("H must have exactly two parents", () => {
		expect(docMergeDecision(facts({ parents: [A], mainOnChain: null, mergeBases: null, diffs: null }), basis, 17)).toEqual(full("the head has 1 parent(s), not 2"));
		expect(docMergeDecision(facts({ parents: [A, B, C] }), basis, 17)).toEqual(full("the head has 3 parent(s), not 2"));
	});
	test("(1) the earlier green: no run at P1, a red, one without a full part, a doc-merge green, another PR's green, and a newer red over a green all fail", () => {
		const at = (verdict: TestRun["verdict"], over: Partial<TestRun> = {}) => docMergeDecision(facts({ diffs: docOnly }), finished("tr-1", 17, A, verdict, over), 17);
		expect(docMergeDecision(facts({ diffs: docOnly }), [], 17)).toEqual(full("PR #17 has no run at the first parent aaaaaaa"));
		expect(docMergeDecision(facts({ diffs: docOnly }), finished("tr-1", 17, B), 17)).toEqual(full("PR #17 has no run at the first parent aaaaaaa"));
		expect(docMergeDecision(facts({ diffs: docOnly }), finished("tr-1", 18, A), 17)).toEqual(full("PR #17 has no run at the first parent aaaaaaa"));
		expect(at("red")).toEqual(full("the newest run at the first parent aaaaaaa, tr-1, is red"));
		expect(at("green", { full: null })).toEqual(full("the newest run at the first parent aaaaaaa, tr-1, is a full green without a full part"));
		const reduced = { full: null, mode: "doc-merge" as const, basis: { runId: "tr-0", sha: C }, merge: { main: B, tip: B, docs: [] } };
		expect(at("green", reduced)).toEqual(full("the newest run at the first parent aaaaaaa, tr-1, is a doc-merge green without a full part"));
		const newerRed = [...basis, ...finished("tr-2", 17, A, "red")];
		expect(docMergeDecision(facts({ diffs: docOnly }), newerRed, 17)).toEqual(full("the newest run at the first parent aaaaaaa, tr-2, is red"));
		// a request with no result yet (unfinished) is the newest run and is not a green
		const unfinished = testRuns([reqEntry(request("tr-1", 17, A))]);
		expect(docMergeDecision(facts({ diffs: docOnly }), unfinished, 17)).toEqual(full("the newest run at the first parent aaaaaaa, tr-1, is unfinished"));
	});
	test("(2) P2 off origin/main's first-parent chain fails", () => {
		expect(docMergeDecision(facts({ diffs: docOnly, mainOnChain: false }), basis, 17)).toEqual(full("the second parent bbbbbbb is not on origin/main's first-parent chain"));
	});
	test("(3) two merge bases (a criss-cross) fail, and so does none", () => {
		expect(docMergeDecision(facts({ mergeBases: [C, D], diffs: null }), basis, 17)).toEqual(full("the parents have 2 merge bases, not 1"));
		expect(docMergeDecision(facts({ mergeBases: [], diffs: null }), basis, 17)).toEqual(full("the parents have 0 merge bases, not 1"));
	});
	test("(4) each of the three five-diff kinds on a code path fails, whichever side; a path outside the list fails as code", () => {
		// changed on both sides to different content (an --ours/--theirs or hand resolution of a conflicted code file)
		const both = diffs({ baseP1: ["surface/src/x.ts"], baseP2: ["surface/src/x.ts"], p1p2: ["surface/src/x.ts"], p2h: ["surface/src/x.ts"] });
		expect(docMergeDecision(facts({ diffs: both }), basis, 17)).toEqual(full("the merge resolution touched surface/src/x.ts: both sides changed it to different content"));
		// H holds neither parent's version of a file neither side changed (an evil merge)
		const neither = diffs({ p1h: ["surface/src/z.ts"], p2h: ["surface/src/z.ts"] });
		expect(docMergeDecision(facts({ diffs: neither }), basis, 17)).toEqual(full("the merge resolution touched surface/src/z.ts: the merge holds neither parent's version"));
		// H dropped the one side that changed the file: the branch's, then main's
		const droppedBranch = diffs({ baseP1: ["surface/src/x.ts"], p1p2: ["surface/src/x.ts"], p1h: ["surface/src/x.ts"] });
		expect(docMergeDecision(facts({ diffs: droppedBranch }), basis, 17)).toEqual(full("the merge resolution touched surface/src/x.ts: the merge dropped the branch's change, the only side that changed it"));
		const droppedMain = diffs({ baseP2: ["ledger/src/y.ts"], p1p2: ["ledger/src/y.ts"], p2h: ["ledger/src/y.ts"] });
		expect(docMergeDecision(facts({ diffs: droppedMain }), basis, 17)).toEqual(full("the merge resolution touched ledger/src/y.ts: the merge dropped main's change, the only side that changed it"));
		// not on Jo's list: a nested USER-GUIDE.md and a migration item are code to this rule
		for (const p of ["docs/USER-GUIDE.md", "migration/items/x.md", ".ai/decision-logx.md"]) {
			expect(docMergeDecision(facts({ diffs: diffs({ p1h: [p, "MIGRATION.md"], p2h: [p, "MIGRATION.md"] }) }), basis, 17)).toEqual(full(`the merge resolution touched ${p}: the merge holds neither parent's version`));
		}
	});
});

// ---- 10. close freshness --------------------------------------------------------------------------------------

describe("close freshness (§ 2.4 item 4)", () => {
	const green = (sha: string, runId = "tr-1") => ({ runId, verdict: "green" as const, sha, mode: "full" as const, basis: null, merge: null });
	const pr = (over: Partial<ClosePr> = {}): ClosePr => ({ number: 17, state: "OPEN", headRefName: "wl/wl-t", headSha: A, result: green(A), docMerge: null, headCompare: null, candidateCompare: null, waivedRun: null, ...over });
	const facts = (prs: ClosePr[], changed: string[] = ["surface/src/x.ts"], candidate = A, runs: RunRecord[] = []) => ({ failure: null, branch: "wl/wl-t", candidate: { sha: candidate, changed }, prs, runs });
	const one = (sha: string, files: string[], parents = 1): RangeCommit => ({ sha, parents, files });
	const ahead = (...commits: RangeCommit[]) => ({ status: "ahead" as const, commits });
	const logOnly = ahead(one(B, [".ai/decision-log/2026-10-08--1200--ilex--x.md"]));
	test("green at head closes", () => {
		expect(closeFreshness(facts([pr()]))).toMatchObject({ close: true });
	});
	test("head ahead only by .ai/decision-log/ closes; ahead by any other file refuses", () => {
		expect(closeFreshness(facts([pr({ headSha: B, headCompare: logOnly })], ["surface/src/x.ts"], A))).toMatchObject({ close: true });
		expect(closeFreshness(facts([pr({ headSha: B, headCompare: logOnly, candidateCompare: logOnly })], ["surface/src/x.ts"], B))).toMatchObject({ close: true });
		const code = ahead(one(B, [".ai/decision-log/x.md", "surface/src/x.ts"]));
		const r = closeFreshness(facts([pr({ headSha: B, headCompare: code })]));
		expect(r).toEqual({ close: false, reason: "PR #17's head bbbbbbb is not the green aaaaaaa: commit bbbbbbb changes surface/src/x.ts; call lane_full_test" });
		expect(closeFreshness(facts([pr({ headSha: B, headCompare: { status: "diverged", commits: [] } })]))).toMatchObject({ close: false, reason: expect.stringContaining(": it has diverged from the green;") });
		expect(closeFreshness(facts([pr({ headSha: B, headCompare: null })])).close).toBe(false);
		expect(decisionLogOnly({ status: "identical", commits: [] })).toBe(true);
		expect(decisionLogOnly({ status: "behind", commits: [] })).toBe(false);
	});
	test("review r1 B3: each commit between S and the head must touch only .ai/decision-log/; the net diff is never enough", () => {
		// a code commit and its revert: the endpoints' trees are equal, yet two commits touch code
		const revert = ahead(one(D, ["surface/src/x.ts"]), one(C, ["surface/src/x.ts"]));
		expect(decisionLogFault(revert)).toBe("commit ddddddd changes surface/src/x.ts");
		expect(closeFreshness(facts([pr({ headSha: D, headCompare: revert })]))).toEqual({
			close: false, reason: "PR #17's head ddddddd is not the green aaaaaaa: commit ddddddd changes surface/src/x.ts; call lane_full_test",
		});
		// the same pair on the local candidate C only: it is untested
		expect(closeFreshness(facts([pr({ candidateCompare: revert })], ["surface/src/x.ts"], D))).toEqual({ close: false, reason: "local wl/wl-t has untested commit ddddddd" });
		// a chain of decision-log-only commits closes; an empty commit (one parent, no file changed) touches nothing and is allowed
		const chain = ahead(one(D, [".ai/decision-log/b.md"]), one(C, []), one(B, [".ai/decision-log/a.md"]));
		expect(decisionLogFault(chain)).toBeNull();
		expect(closeFreshness(facts([pr({ headSha: D, headCompare: chain, candidateCompare: chain })], ["surface/src/x.ts"], D))).toMatchObject({ close: true });
		// a merge in the range is not linear descent, whatever it touches; ahead with no commit listed covers nothing
		expect(decisionLogFault(ahead(one(D, [".ai/decision-log/b.md"]), one(C, [], 2)))).toBe("commit ccccccc is a merge");
		expect(decisionLogOnly(ahead())).toBe(false);
	});
	test("a newer red supersedes an older green; a late superseded does not override a newer green", () => {
		const g = request("tr-1", 17, A);
		const r = request("tr-2", 17, A);
		const recs = testRuns([reqEntry(g), runEntry(run(g, "green")), reqEntry(r), runEntry(run(r, "red"))]);
		const auth = authoritativeRun(recs, 17)!;
		expect(auth.result!.verdict).toBe("red");
		const refused = closeFreshness(facts([pr({ result: { ...green(A), runId: auth.result!.runId, verdict: auth.result!.verdict, sha: auth.result!.sha } })]));
		expect(refused).toEqual({ close: false, reason: "PR #17's newest test-run tr-2 is red: fix it and call lane_full_test (a waiver passes only a merged PR)" });
		const old = request("tr-3", 17, A);
		const newer = request("tr-4", 17, A);
		const late = testRuns([reqEntry(old), reqEntry(newer), runEntry(run(newer, "green")), runEntry(run(old, "superseded"))]);
		const a2 = authoritativeRun(late, 17)!;
		expect(a2.request.runId).toBe("tr-4");
		expect(a2.result!.verdict).toBe("green");
		expect(closeFreshness(facts([pr({ result: green(A, "tr-4") })])).close).toBe(true);
		expect(authoritativeRun(late, 99)).toBeNull();
	});
	test("no PR with a code delta refuses; an empty set with no delta closes; decision-log-only is no delta", () => {
		expect(closeFreshness(facts([]))).toEqual({ close: false, reason: "wl/wl-t changes surface/src/x.ts but has no PR: push and open the PR, then lane_full_test" });
		expect(closeFreshness(facts([], []))).toEqual({ close: true, why: "no PR and no code delta" });
		expect(closeFreshness(facts([], [".ai/decision-log/a.md"]))).toMatchObject({ close: true });
		// a PR set made only of another branch's PR (a push-dest:) still leaves the code delta without a PR
		expect(closeFreshness(facts([pr({ headRefName: "wl/wl-other" })]))).toMatchObject({ close: false, reason: expect.stringContaining("has no PR") });
	});
	test("a PR with no result refuses; a closed-unmerged PR with a code delta refuses; a merged PR is checked at its final head", () => {
		expect(closeFreshness(facts([pr({ result: null })]))).toEqual({ close: false, reason: "PR #17 has no test-run result: call lane_full_test" });
		expect(closeFreshness(facts([pr({ state: "CLOSED", result: null })]))).toEqual({ close: false, reason: "PR #17 is closed; reopen it, or reset the branch" });
		expect(closeFreshness(facts([pr({ state: "MERGED" })]))).toMatchObject({ close: true });
		expect(closeFreshness(facts([pr({ state: "MERGED", headSha: B, headCompare: ahead(one(B, ["x.ts"])) })])).close).toBe(false);
	});
	test("an untested local commit refuses; a candidate ahead of the green by decision-log only closes", () => {
		expect(closeFreshness(facts([pr()], ["surface/src/x.ts"], B))).toEqual({ close: false, reason: "local wl/wl-t has untested commit bbbbbbb" });
		expect(closeFreshness(facts([pr({ candidateCompare: logOnly })], ["surface/src/x.ts"], B))).toMatchObject({ close: true });
		expect(closeFreshness(facts([pr({ candidateCompare: ahead(one(B, ["surface/src/y.ts"])) })], ["surface/src/x.ts"], B)).close).toBe(false);
	});
	test("git or gh failing refuses (fails closed)", () => {
		expect(closeFreshness({ ...facts([pr()]), failure: "gh: HTTP 502" })).toEqual({ close: false, reason: "the close check could not answer: gh: HTTP 502" });
		expect(closeFreshness({ ...facts([], []), failure: "git: not a repository" }).close).toBe(false);
	});
	// A doc-merge green tr-2 at H = A, on the basis tr-1 (a full green of PR #17 at P1 = B), merging the main state P2 = C.
	const dmGreen = (basis = { runId: "tr-1", sha: B }) => ({ runId: "tr-2", verdict: "green" as const, sha: A, mode: "doc-merge" as const, basis, merge: { main: C, tip: D, docs: ["MIGRATION.md"] } });
	const dmPr = (over: Partial<ClosePr> = {}): ClosePr => pr({ result: dmGreen(), docMerge: { parents: [B, C], mainOnChain: true }, ...over });
	const basisRuns = finished("tr-1", 17, B);
	const refuse = (why: string) => ({ close: false as const, reason: `PR #17's doc-merge green tr-2 does not hold: ${why}; call lane_full_test` });
	test("a doc-merge green closes when its basis, its parents and the merged main hold (plan wl-mv615mkeaf1yio § 3); descent after it is unchanged", () => {
		expect(closeFreshness(facts([dmPr()], ["surface/src/x.ts"], A, basisRuns))).toEqual({
			close: true, why: "every PR in the set is green at its head (PR #17: doc-merge tr-2 on basis tr-1 at bbbbbbb, main ccccccc) and covers aaaaaaa",
		});
		const log = ahead(one(D, [".ai/decision-log/x.md"]));
		expect(closeFreshness(facts([dmPr({ headSha: D, headCompare: log, candidateCompare: log })], ["surface/src/x.ts"], D, basisRuns))).toMatchObject({ close: true });
		const code = ahead(one(D, ["surface/src/x.ts"]));
		expect(closeFreshness(facts([dmPr({ headSha: D, headCompare: code })], ["surface/src/x.ts"], A, basisRuns))).toEqual({
			close: false, reason: "PR #17's head ddddddd is not the green aaaaaaa: commit ddddddd changes surface/src/x.ts; call lane_full_test",
		});
	});
	test("a doc-merge green whose basis does not resolve to a full green of the same PR on this workload refuses", () => {
		// a forged basis id: no run tr-9 anywhere
		expect(closeFreshness(facts([dmPr({ result: dmGreen({ runId: "tr-9", sha: B }) })], ["surface/src/x.ts"], A, basisRuns))).toEqual(refuse("its basis tr-9 is not a finished run on this workload"));
		// a basis from another workload: tr-1 is only in that workload's records; this one's hold an unrelated green tr-5
		const otherWorkload = finished("tr-1", 17, B);
		expect(otherWorkload[0]!.result!.verdict).toBe("green");
		expect(closeFreshness(facts([dmPr()], ["surface/src/x.ts"], A, finished("tr-5", 17, B)))).toEqual(refuse("its basis tr-1 is not a finished run on this workload"));
		// a basis from another PR
		expect(closeFreshness(facts([dmPr()], ["surface/src/x.ts"], A, finished("tr-1", 18, B)))).toEqual(refuse("its basis tr-1 is a run of PR #18"));
		// a basis that ran at another sha than the one the green names
		expect(closeFreshness(facts([dmPr({ result: dmGreen({ runId: "tr-1", sha: D }) })], ["surface/src/x.ts"], A, basisRuns))).toEqual(refuse("its basis tr-1 ran at bbbbbbb, not ddddddd"));
		// a red basis, a green without a full part, a doc-merge basis
		expect(closeFreshness(facts([dmPr()], ["surface/src/x.ts"], A, finished("tr-1", 17, B, "red")))).toEqual(refuse("its basis tr-1 is not a full green (red, mode full)"));
		expect(closeFreshness(facts([dmPr()], ["surface/src/x.ts"], A, finished("tr-1", 17, B, "green", { full: null })))).toEqual(refuse("its basis tr-1 is not a full green (green, mode full)"));
		const reduced = { full: null, mode: "doc-merge" as const, basis: { runId: "tr-0", sha: D }, merge: { main: C, tip: C, docs: [] } };
		expect(closeFreshness(facts([dmPr()], ["surface/src/x.ts"], A, finished("tr-1", 17, B, "green", reduced)))).toEqual(refuse("its basis tr-1 is not a full green (green, mode doc-merge)"));
	});
	test("a doc-merge green whose re-read parents are not exactly basis.sha and merge.main, or whose merged main is off origin's first-parent chain, refuses", () => {
		const parents = (p: string[]) => closeFreshness(facts([dmPr({ docMerge: { parents: p, mainOnChain: true } })], ["surface/src/x.ts"], A, basisRuns));
		expect(parents([C, B])).toEqual(refuse("aaaaaaa's parents are ccccccc bbbbbbb, not the basis bbbbbbb and main ccccccc"));
		expect(parents([B, D])).toEqual(refuse("aaaaaaa's parents are bbbbbbb ddddddd, not the basis bbbbbbb and main ccccccc"));
		expect(parents([B])).toEqual(refuse("aaaaaaa's parents are bbbbbbb, not the basis bbbbbbb and main ccccccc"));
		expect(parents([B, C, D])).toEqual(refuse("aaaaaaa's parents are bbbbbbb ccccccc ddddddd, not the basis bbbbbbb and main ccccccc"));
		expect(closeFreshness(facts([dmPr({ docMerge: { parents: [B, C], mainOnChain: false } })], ["surface/src/x.ts"], A, basisRuns))).toEqual(refuse("the merged main ccccccc is not on origin's first-parent chain"));
		expect(closeFreshness(facts([dmPr({ docMerge: null })], ["surface/src/x.ts"], A, basisRuns))).toEqual(refuse("the merge aaaaaaa was not re-read"));
	});
	// A batch tr-b1 of PRs #17 at B and #18 at C onto M0, green with final tree T9; landed as L1 = merge(M0, B), L2 = merge(L1, C) with tree T9.
	const M0 = "0".repeat(40);
	const [L1, L2, T8, T9, E] = ["1", "2", "8", "9", "e"].map((c) => c.repeat(40)) as [string, string, string, string, string];
	const credit = (over: Partial<CloseCredit> = {}): CloseCredit => ({
		runId: "tr-b1", pr: 17, sha: B, base: M0, step: 1, n: 2, finalTree: T9,
		batch: { verdict: "green", prs: [{ pr: 17, sha: B }, { pr: 18, sha: C }], finalTree: T9 },
		landed: [{ sha: L1, parents: [M0, B], tree: T8 }, { sha: L2, parents: [L1, C], tree: T9 }], candidateCompare: null, ...over,
	});
	const merged = (over: Partial<ClosePr> = {}) => pr({ state: "MERGED", headSha: B, result: null, credits: [credit()], ...over });
	const refuseCredit = (why: string) => ({ close: false as const, reason: `PR #17 has no test-run result: call lane_full_test; its batch credit tr-b1 does not hold: ${why}` });
	test("a merged PR with no green of its own closes on a batch credit that landed (plan wl-mv615mkeaf1yio § 4); the candidate is covered at the credited sha or past it by decision-log only", () => {
		expect(closeFreshness(facts([merged()], ["surface/src/x.ts"], B))).toEqual({
			close: true, why: "every PR in the set is green at its head (PR #17: batch tr-b1 green at bbbbbbb, step 1 of 2 onto 0000000, landed) and covers bbbbbbb",
		});
		// a red own run is replaced by the credit the same way
		expect(closeFreshness(facts([merged({ result: { ...green(B), verdict: "red" } })], ["surface/src/x.ts"], B)).close).toBe(true);
		const log = ahead(one(E, [".ai/decision-log/x.md"]));
		expect(closeFreshness(facts([merged({ credits: [credit({ candidateCompare: log })] })], ["surface/src/x.ts"], E)).close).toBe(true);
		expect(closeFreshness(facts([merged({ credits: [credit({ candidateCompare: ahead(one(E, ["surface/src/x.ts"])) })] })], ["surface/src/x.ts"], E))).toEqual({
			close: false, reason: "local wl/wl-t has untested commit eeeeeee",
		});
	});
	test("a credit refuses when the PR is open, when the batch did not land as tested, or when it does not credit this PR at its merged head", () => {
		expect(closeFreshness(facts([merged({ state: "OPEN" })], ["surface/src/x.ts"], B))).toEqual({
			close: false, reason: "PR #17 has no test-run result: call lane_full_test (its batch credit tr-b1 counts only once the PR is merged)",
		});
		expect(closeFreshness(facts([merged({ credits: [credit({ landed: [] })] })], ["surface/src/x.ts"], B))).toEqual(
			refuseCredit("the batch did not land: origin's first-parent chain has 0 commit(s) after its base 0000000, not 2"),
		);
		// the PRs landed in another order
		const swapped = [{ sha: L1, parents: [M0, C], tree: T8 }, { sha: L2, parents: [L1, B], tree: T9 }];
		expect(closeFreshness(facts([merged({ credits: [credit({ landed: swapped })] })], ["surface/src/x.ts"], B))).toEqual(
			refuseCredit("the batch did not land: 1111111, commit 1 after 0000000 on origin's first-parent chain, is not the merge of PR #17 at bbbbbbb onto 0000000"),
		);
		// landed with a tree the suite never ran
		const otherTree = [{ sha: L1, parents: [M0, B], tree: T8 }, { sha: L2, parents: [L1, C], tree: T8 }];
		expect(closeFreshness(facts([merged({ credits: [credit({ landed: otherTree })] })], ["surface/src/x.ts"], B))).toEqual(
			refuseCredit("the batch did not land: 2222222's tree 8888888 is not the tested final tree 9999999"),
		);
		expect(closeFreshness(facts([merged({ credits: [credit({ batch: null })] })], ["surface/src/x.ts"], B))).toEqual(refuseCredit("its batch tr-b1 has no test-batch-run row"));
		expect(closeFreshness(facts([merged({ credits: [credit({ batch: { verdict: "red", prs: [{ pr: 17, sha: B }, { pr: 18, sha: C }], finalTree: T9 } })] })], ["surface/src/x.ts"], B))).toEqual(
			refuseCredit("its batch tr-b1 is red"),
		);
		expect(closeFreshness(facts([merged({ credits: [credit({ step: 2 })] })], ["surface/src/x.ts"], B))).toEqual(refuseCredit("its batch tr-b1 does not list PR #17 at bbbbbbb as step 2 of 2"));
		expect(closeFreshness(facts([merged({ credits: [credit({ finalTree: T8 })] })], ["surface/src/x.ts"], B))).toEqual(refuseCredit("its batch tr-b1's final tree is not the credited 8888888"));
		expect(closeFreshness(facts([merged({ headSha: E })], ["surface/src/x.ts"], B))).toEqual(refuseCredit("it credits bbbbbbb, not the merged head eeeeeee"));
		expect(closeFreshness(facts([merged({ credits: [] })], ["surface/src/x.ts"], B))).toEqual({ close: false, reason: "PR #17 has no test-run result: call lane_full_test" });
	});
	test("every credit at the merged head is read: a newer credit that did not land never shadows an older one that did; with none holding, the newest one's fault is named (review r1 finding 2)", () => {
		const landedOld = credit({ runId: "tr-old" });
		const unlanded = credit({ runId: "tr-new", landed: [] });
		expect(closeFreshness(facts([merged({ credits: [landedOld, unlanded] })], ["surface/src/x.ts"], B))).toEqual({
			close: true, why: "every PR in the set is green at its head (PR #17: batch tr-old green at bbbbbbb, step 1 of 2 onto 0000000, landed) and covers bbbbbbb",
		});
		// the order does not matter: an older credit that did not land beside a newer one that did
		expect(closeFreshness(facts([merged({ credits: [unlanded, credit({ runId: "tr-newer" })] })], ["surface/src/x.ts"], B)).close).toBe(true);
		// the candidate is covered through any credit that holds
		const log = ahead(one(E, [".ai/decision-log/x.md"]));
		expect(closeFreshness(facts([merged({ credits: [credit({ runId: "tr-old", candidateCompare: log }), credit({ runId: "tr-new", landed: [], candidateCompare: log })] })], ["surface/src/x.ts"], E)).close).toBe(true);
		// none holds: the refusal names the newest credit and its own fault
		expect(closeFreshness(facts([merged({ credits: [credit({ runId: "tr-old", batch: null }), unlanded] })], ["surface/src/x.ts"], B))).toEqual({
			close: false,
			reason: "PR #17 has no test-run result: call lane_full_test; its batch credit tr-new does not hold: the batch did not land: origin's first-parent chain has 0 commit(s) after its base 0000000, not 2",
		});
		// an open PR still never passes on one, naming the newest
		expect(closeFreshness(facts([merged({ state: "OPEN", credits: [landedOld, unlanded] })], ["surface/src/x.ts"], B))).toEqual({
			close: false, reason: "PR #17 has no test-run result: call lane_full_test (its batch credit tr-new counts only once the PR is merged)",
		});
	});
	test("PLAN wl-mv5i3lulwwbbi8 D3: a merged PR passes on Jo's waiver of its authoritative red at its head; an older run, another sha or an open PR do not", () => {
		const red = (sha: string, runId = "tr-2") => ({ ...green(sha, runId), verdict: "red" as const });
		// Tinker's shape: merged, red at the merged head, that run waived, no code delta on the candidate
		expect(closeFreshness(facts([pr({ state: "MERGED", result: red(A), waivedRun: "tr-2" })], []))).toEqual({
			close: true, why: "every PR in the set is green at its head or merged with a waived run (#17 (tr-2))",
		});
		// a waiver of an older run binds nothing: the authoritative run is tr-2
		expect(closeFreshness(facts([pr({ state: "MERGED", result: red(A), waivedRun: "tr-1" })], []))).toEqual({
			close: false, reason: "PR #17's newest test-run tr-2 is red: a merged PR passes only on Jo's `waive` answering a question that offers waive on the run's slice, asked after the result",
		});
		// the waived run tested another sha than the merged head
		expect(closeFreshness(facts([pr({ state: "MERGED", headSha: B, result: red(A), waivedRun: "tr-2" })], []))).toEqual({
			close: false, reason: "PR #17's newest test-run tr-2 is red and waived, but at aaaaaaa, not the merged head bbbbbbb",
		});
		// an open PR never passes on a waiver
		expect(closeFreshness(facts([pr({ state: "OPEN", result: red(A), waivedRun: "tr-2" })], []))).toEqual({
			close: false, reason: "PR #17's newest test-run tr-2 is red: fix it and call lane_full_test (a waiver passes only a merged PR)",
		});
		// a waiver covers no code delta on the candidate: that still needs a green from the branch
		expect(closeFreshness(facts([pr({ state: "MERGED", result: red(A), waivedRun: "tr-2" })], ["surface/src/x.ts"], A))).toEqual({
			close: false, reason: "local wl/wl-t has untested commit aaaaaaa",
		});
	});
});

// ---- the wrapper's argv contract --------------------------------------------------------------------------------

describe("the _as2test wrapper's argv contract", () => {
	test("each subcommand's exact argv; calls the wrapper would refuse throw first", () => {
		const head = ["sudo", "-n", "-u", "_as2test", AS2TEST_EXEC];
		expect(wrapperArgv({ sub: "prepare", runId: "tr-1", sha: A })).toEqual([...head, "prepare", "tr-1", A]);
		expect(wrapperArgv({ sub: "full", runId: "tr-1" })).toEqual([...head, "full", "tr-1"]);
		expect(wrapperArgv({ sub: "solo", runId: "tr-1", file: "./surface/test/x.test.ts" })).toEqual([...head, "solo", "tr-1", "./surface/test/x.test.ts"]);
		expect(wrapperArgv({ sub: "sweep", runId: "tr-1" }, "/tmp/w/exec")).toEqual(["sudo", "-n", "-u", "_as2test", "/tmp/w/exec", "sweep", "tr-1"]);
		expect(wrapperArgv({ sub: "cleanup", runId: "tr-2", oldRunId: "tr-1" })).toEqual([...head, "cleanup", "tr-2", "tr-1"]);
		expect(wrapperArgv({ sub: "probe", runId: "tr-1", paths: ["/Users/jo/.ssh", "/Users/jo/.netrc"] })).toEqual([...head, "probe", "tr-1", "/Users/jo/.ssh", "/Users/jo/.netrc"]);
		for (const bad of [
			{ sub: "full", runId: "tr-UP" }, { sub: "full", runId: "tr-1;rm" }, { sub: "prepare", runId: "tr-1", sha: "HEAD" }, { sub: "solo", runId: "tr-1", file: "x.test.ts" },
			{ sub: "solo", runId: "tr-1", file: "./../x.test.ts" }, { sub: "solo", runId: "tr-1", file: "./src/x.ts" }, { sub: "cleanup", runId: "tr-1", oldRunId: "tr-1" },
			{ sub: "cleanup", runId: "tr-1", oldRunId: "../x" }, { sub: "probe", runId: "tr-1", paths: [] }, { sub: "probe", runId: "tr-1", paths: ["rel"] },
		] as Parameters<typeof wrapperArgv>[0][]) expect(() => wrapperArgv(bad)).toThrow(TestRunShapeError);
		expect(WRAPPER_EXIT).toEqual({ ok: 0, probeReachable: 65, failed: 70, sweepLockHeld: 75, refused: 64, fenced: 77, timeout: 124 });
	});
});
