// The test runner's pure half (MIGRATION.md item 24; plan rev 12 § 2 to § 4) over plain values: the
// four bodies, the profile block, the junit report and console log of Bun 1.3.14 (captured fixtures
// plus one live run of the installed bun on a tiny fixture), the changed-test-file filter, the
// verdict and settle decision with ownership, liveness and the starter's reservation, retention,
// the bound-branch rule, the close-freshness decision, the untrusted child's env with its git shim
// (run for real through `env -i`), and the wrapper's argv contract.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryRow, type InstructionRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import { boundPrs, holdersOf, testPrBody, testPrInstructionBody } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import {
	AS2TEST_EXEC, authoritativeRun, baseCompareFor, baseParts, boundBranches, buildTestRun, callStuck, callTimedOut, carriedRun, changedTestFiles, CHILD_ENV_ALLOWLIST, childEnv, childGitconfigText, childLayout,
	type ClosePr, closeFreshness, decideRun, decisionLogFault, decisionLogOnly, executedFiles, fullSuiteSlice, gitShimText, heartbeatText, isBunTestFile, isSecurityPath, KEEP_RUNS, lockHolderStale,
	logFirstErrors, mainRed, makeRunId, notifiesOrchestrator, ownerRepoOf, ownsRequest, parseHeartbeat, parseJunit, parsePushDest, parseTestRequested,
	parseTestRun, parseTestRunFailed, partResult, type PartResult, prAdmissible, type PrView, pruneRuns, queueAhead, queuedTooLong, type QueueRow, queueWaiterLive, type RangeCommit,
	recordLive, reportCapBytes, reservation, resultJson, type RunFacts, runDirOf, runLive, runnerDiedRun, runsRoot, servedRepo, settleArtifact, soloPlan, stageDirOf, pushDestBody,
	TEST_RUNNER_DEFAULTS, type TestRequested, testRequestedBody, type TestRun, testRunBody, testRunFailedBody, testRunFailedOf, testRunnerConfig,
	TestRunShapeError, testRuns, WRAPPER_EXIT, wrapperArgv, workDirOf, failuresOf, parseSecurityRed, securityFailuresOf, securityRedBody, securityRedOf, executorStalledReason, StuckWatch, stuckReason,
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
	failures: verdict === "red" ? [{ part: "full", name: "x.test.ts > broken", firstError: "error: nope" }] : [], runDir: `/runs/${r.runId}`, preflight: "ok", ...over,
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
/**
 * Bun 1.3.14 from a repo root holding `gates/test/sec.test.ts` (one failing test in `describe("row 3")`, one passing) and
 * `surface/test/plain.test.ts` (one failing test): the full suite, then `bun test ./gates/test/sec.test.ts` alone. The
 * `file` attribute is repo-relative with no `./` in both, so a failure's name starts `gates/test/…`; only the solo part is `./…`.
 */
const JUNIT_GATES_FULL = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="2" failures="2" skipped="0" time="0.014538">
  <testsuite name="gates/test/sec.test.ts" file="gates/test/sec.test.ts" tests="2" assertions="1" failures="1" skipped="0" time="0" hostname="h">
    <testsuite name="row 3" file="gates/test/sec.test.ts" line="2" tests="1" assertions="1" failures="1" skipped="0" time="0.001" hostname="h">
      <testcase name="fails" classname="row 3" time="0.001342" file="gates/test/sec.test.ts" line="2" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="ok" classname="" time="0.000025" file="gates/test/sec.test.ts" line="3" assertions="0" />
  </testsuite>
  <testsuite name="surface/test/plain.test.ts" file="surface/test/plain.test.ts" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="h">
    <testcase name="plain fails" classname="" time="0.000055" file="surface/test/plain.test.ts" line="2" assertions="1">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
`;
const JUNIT_GATES_SOLO = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="1" failures="1" skipped="0" time="0.006601">
  <testsuite name="gates/test/sec.test.ts" file="gates/test/sec.test.ts" tests="2" assertions="1" failures="1" skipped="0" time="0" hostname="h">
    <testsuite name="row 3" file="gates/test/sec.test.ts" line="2" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="h">
      <testcase name="fails" classname="row 3" time="0.000133" file="gates/test/sec.test.ts" line="2" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="ok" classname="" time="0.000004" file="gates/test/sec.test.ts" line="3" assertions="0" />
  </testsuite>
</testsuites>
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
	test("security-red: securityFailuresOf takes a real junit report's gates/test/ failures for red and red-main, none for a non-gates failure", () => {
		const r = request("tr-0abc12", 17, A);
		const full = partResult({ junit: JUNIT_GATES_FULL, log: null, exit: 1, ms: 10 });
		const solo = [{ file: "./gates/test/sec.test.ts", ...partResult({ junit: JUNIT_GATES_SOLO, log: null, exit: 1, ms: 5 }) }];
		const failures = failuresOf(full, solo);
		const SEC = "gates/test/sec.test.ts > row 3 > fails";
		expect(failures.map((f) => [f.part, f.name])).toEqual([["full", SEC], ["full", "surface/test/plain.test.ts > plain fails"], ["./gates/test/sec.test.ts", SEC]]);
		const security = [failures[0], failures[2]];
		const red = run(r, "red", { failures });
		expect(securityFailuresOf(red)).toEqual(security);
		const redMain = run(r, "red-main", { failures, baseCompare: { sha: C, parts: [{ part: "full", failing: [SEC, failures[1]!.name], baseFailing: [SEC, failures[1]!.name], baseError: null }] } });
		expect(securityFailuresOf(redMain)).toEqual(security);
		for (const v of ["stale", "error", "green"] as const) expect(securityFailuresOf(run(r, v, { failures }))).toEqual(security);
		expect(securityFailuresOf(run(r, "superseded", { failures }))).toEqual([]);
		// a non-gates failure is none, in any part; a path that only contains or resembles gates/test/ is none
		expect(securityFailuresOf(run(r, "red", { failures: [failures[1]!] }))).toEqual([]);
		const near = [{ part: "full", name: "src/gates/test/x.test.ts > a", firstError: "e" }, { part: "./gates/testing/x.test.ts", name: "gates/testing/x.test.ts > a", firstError: "e" }];
		expect(securityFailuresOf(run(r, "red", { failures: near }))).toEqual([]);
		// the solo part alone is enough
		const byPart = { part: "./gates/test/y.test.ts", name: "y.test.ts > a", firstError: "e" };
		expect(securityFailuresOf(run(r, "red", { failures: [byPart] }))).toEqual([byPart]);
		// the signal: run id, sha, the count and the first name; none without a security failure
		expect(securityRedOf("wl-t", "sl-full-t-1", redMain)).toEqual({ workloadId: "wl-t", slice: "sl-full-t-1", runId: "tr-0abc12", sha: A, failing: 2, first: SEC });
		expect(securityRedOf("wl-t", "sl-full-t-1", run(r, "red", { failures: [failures[1]!] }))).toBeNull();
		expect(securityRedOf("wl-t", "sl-full-t-1", run(r, "superseded", { failures }))).toBeNull();
		// the ordinary signal still ignores red-main
		expect(testRunFailedOf("wl-t", "sl-full-t-1", redMain)).toBeNull();
	});
	test("isSecurityPath (PLAN wl-mvq4edh02r5z40 D0): repo-relative with any ./ dropped, starting with a SECURITY_TEST_PATHS entry", () => {
		for (const p of ["gates/test/a.test.ts", "./gates/test/a.test.ts", "gates/test/sub/b_spec.ts"]) expect(isSecurityPath(p)).toBe(true);
		for (const p of ["src/gates/test/a.test.ts", "./gates/testing/a.test.ts", "gates/a.test.ts", "surface/test/gates/test/x.test.ts", "?"]) expect(isSecurityPath(p)).toBe(false);
	});
	test("compatibility: a frozen pre-wl-mvq4edh02r5z40 red-main body with a `full` baseCompare part and a security failure parses, and securityFailuresOf reads it", () => {
		const SEC = "gates/test/sec.test.ts > row 3 > fails";
		const body = `test-run: tr-0old17 red-main sha=${A} pr=17 {"sha":"${A}","pr":17,"reason":"every failing test also fails on base ccccccc","headAtEnd":"${A}","base":"${C}","mergeBase":"${D}","full":{"pass":3,"fail":2,"skip":0,"exit":1,"ms":1200,"error":null},"solo":[{"file":"./gates/test/sec.test.ts","pass":1,"fail":1,"skip":0,"exit":1,"ms":300,"error":null}],"failures":[{"part":"full","name":"${SEC}","firstError":"error: nope"},{"part":"full","name":"x.test.ts > broken","firstError":"error: main"},{"part":"./gates/test/sec.test.ts","name":"${SEC}","firstError":"error: nope"}],"runDir":"/runs/tr-0old17","preflight":"ok","baseCompare":{"sha":"${C}","parts":[{"part":"full","failing":["${SEC}","x.test.ts > broken"],"baseFailing":["${SEC}","x.test.ts > broken"],"baseError":null},{"part":"./gates/test/sec.test.ts","failing":["${SEC}"],"baseFailing":["${SEC}"],"baseError":null}]}}`;
		const t = parseTestRun(body);
		expect(t).not.toBeNull();
		expect(t!.verdict).toBe("red-main");
		expect(t!.baseCompare!.parts.map((p) => p.part)).toEqual(["full", "./gates/test/sec.test.ts"]);
		expect(securityFailuresOf(t!).map((f) => [f.part, f.name])).toEqual([["full", SEC], ["./gates/test/sec.test.ts", SEC]]);
		expect(securityRedOf("wl-t", "sl-full-t-1", t!)).toMatchObject({ runId: "tr-0old17", failing: 2, first: SEC });
		expect(testRunBody(t!)).toBe(body);
	});
	test("security-red: (a pushed signal) formats and parses exactly; malformed bodies are rejected", () => {
		const s = { workloadId: "wl-mvg1vs0rhnu3gg", slice: "sl-full-mvg1vs0rhnu3gg-1", runId: "tr-0abc12", sha: A, failing: 2, first: "gates/test/sec.test.ts > row 3 > fails" };
		const body = securityRedBody(s);
		expect(body).toBe(`security-red: wl-mvg1vs0rhnu3gg sl-full-mvg1vs0rhnu3gg-1 tr-0abc12 ${A} 2 gates/test/sec.test.ts > row 3 > fails`);
		expect(parseSecurityRed(body)).toEqual(s);
		expect(securityRedBody({ ...s, first: "a\n  b" }).endsWith(" 2 a b")).toBe(true);
		for (const bad of [body.replace(" 2 ", " 0 "), body.replace(" 2 ", " x "), body.replace("tr-0abc12", "tr-X"), body.replace(A, "abc"), body.replace("wl-", "w-"), body.slice(0, body.lastIndexOf(" 2 ") + 2)])
			expect(parseSecurityRed(bad)).toBeNull();
		for (const over of [{ failing: 0 }, { runId: "run-1" }, { sha: "nope" }, { first: "  " }]) expect(() => securityRedBody({ ...s, ...over })).toThrow(TestRunShapeError);
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
	test("the checkout's profile/config.yml serves agent-system-2.0 with bun test; each cap is present and in range, parsed as written", () => {
		const doc = Bun.YAML.parse(readFileSync(join(REPO, "profile", "config.yml"), "utf8")) as { testRunner: Record<string, unknown> };
		const raw = doc.testRunner;
		const c = testRunnerConfig(doc);
		expect(c.ok).toBe(true);
		if (!c.ok) throw new Error(c.error);
		expect(c.config.repos).toEqual([{ origin: "thewolff/agent-system-2.0", command: "bun test" }]);
		// No literal cap: each key is in the committed block (a dropped key would fall back to a default unseen), in range, and parsed as written.
		for (const key of ["fullCapMin", "soloCapMin", "reportCapMb", "queueMaxMin"] as const) {
			expect(raw).toHaveProperty(key);
			const v = raw[key];
			expect(typeof v === "number" && Number.isFinite(v) && v > 0).toBe(true);
			expect(c.config[key]).toBe(v as number);
		}
		expect(raw).toHaveProperty("fullWorkers");
		expect(Number.isInteger(raw.fullWorkers) && (raw.fullWorkers as number) >= 1).toBe(true);
		expect(c.config.fullWorkers).toBe(raw.fullWorkers as number);
		const config = c.config;
		for (const url of ["https://github.com/thewolff/agent-system-2.0.git", "git@github.com:thewolff/agent-system-2.0.git", "ssh://git@github.com/TheWolff/agent-system-2.0", "thewolff/agent-system-2.0"]) {
			expect(servedRepo(config, url)?.command).toBe("bun test");
		}
		expect(servedRepo(config, "https://github.com/thewolff/other.git")).toBeNull();
		expect(servedRepo(config, "/Users/jo/code/agent-system-2.0")).toBeNull();
		expect(reportCapBytes(config)).toBe(Math.floor(config.reportCapMb * 1024 * 1024));
	});
	test("no block serves nothing; a malformed block is an error, never a default", () => {
		expect(testRunnerConfig({})).toEqual({ ok: true, config: { repos: [], ...TEST_RUNNER_DEFAULTS } });
		expect(testRunnerConfig({ testRunner: { repos: [{ origin: "o/r", command: "bun test" }] } })).toEqual({ ok: true, config: { repos: [{ origin: "o/r", command: "bun test" }], ...TEST_RUNNER_DEFAULTS } });
		for (const bad of [{ testRunner: [] }, { testRunner: { repos: {} } }, { testRunner: { repos: [{ origin: "/local/path", command: "bun test" }] } }, { testRunner: { repos: [{ origin: "o/r" }] } }, { testRunner: { fullCapMin: 0 } }, { testRunner: { soloCapMin: "10" } }]) {
			expect(testRunnerConfig(bad).ok).toBe(false);
		}
		expect(ownerRepoOf("https://gitlab.com/o/r.git")).toBeNull();
	});
	test("fullWorkers: an integer of 1 or more, 1 when absent; 0, 2.5, \"6\", negatives and non-numbers are refused", () => {
		const repos = [{ origin: "o/r", command: "bun test" }];
		const parsed = (v: unknown) => testRunnerConfig({ testRunner: { repos, fullWorkers: v } });
		expect(TEST_RUNNER_DEFAULTS.fullWorkers).toBe(1);
		expect(TEST_RUNNER_DEFAULTS.queueMaxMin).toBe(1440);
		const absent = testRunnerConfig({ testRunner: { repos } });
		expect(absent.ok && absent.config.fullWorkers).toBe(1);
		for (const n of [1, 6, 32]) {
			const c = parsed(n);
			expect(c.ok && c.config.fullWorkers).toBe(n);
		}
		for (const bad of [0, 2.5, "6", -1, -6, null, true, Number.NaN, Number.POSITIVE_INFINITY, [6]]) {
			expect({ bad, c: parsed(bad) }).toEqual({ bad, c: { ok: false, error: "testRunner.fullWorkers is not an integer of 1 or more" } });
		}
		// The yml form: the parse reads it as the profile is read.
		const yml = testRunnerConfig(Bun.YAML.parse("testRunner:\n  fullWorkers: 4\n"));
		expect(yml.ok && yml.config.fullWorkers).toBe(4);
		expect(testRunnerConfig(Bun.YAML.parse('testRunner:\n  fullWorkers: "4"\n')).ok).toBe(false);
	});
	test("stuckStop (PLAN wl-mvq8x4pkjmx69s D4): shadow when absent, shadow or enforce as written, anything else refused", () => {
		const repos = [{ origin: "o/r", command: "bun test" }];
		expect(TEST_RUNNER_DEFAULTS.stuckStop).toBe("shadow");
		const absent = testRunnerConfig({ testRunner: { repos } });
		expect(absent.ok && absent.config.stuckStop).toBe("shadow");
		for (const v of ["shadow", "enforce"] as const) {
			const c = testRunnerConfig({ testRunner: { repos, stuckStop: v } });
			expect(c.ok && c.config.stuckStop).toBe(v);
		}
		for (const bad of ["Enforce", "off", "", null, true, 1, ["enforce"]]) {
			expect({ bad, c: testRunnerConfig({ testRunner: { repos, stuckStop: bad } }) }).toEqual({ bad, c: { ok: false, error: "testRunner.stuckStop is not shadow or enforce" } });
		}
		const yml = testRunnerConfig(Bun.YAML.parse("testRunner:\n  stuckStop: enforce\n"));
		expect(yml.ok && yml.config.stuckStop).toBe("enforce");
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
	test("PLAN wl-mvq4edh02r5z40 D0: a timeout comes before an import refusal or a report error, and an imported junit keeps its failures", () => {
		// the log refused (over the cap) while the junit was imported: the failures stay, the error names the refusal
		const refusedLog = partResult({ junit: JUNIT_C, log: null, exit: 1, ms: 1, importError: "full.log is over the 5-byte report cap" });
		expect(refusedLog.error).toBe("report import refused: full.log is over the 5-byte report cap");
		expect(refusedLog.failures.map((f) => f.name)).toEqual(["c.test.ts > type error", "c.test.ts > string thrown", "c.test.ts > empty message", "c.test.ts > d > b ok", "c.test.ts > timeout"]);
		expect([refusedLog.pass, refusedLog.fail]).toEqual([0, 5]);
		// timed out with that refusal: the error starts `timeout`, the junit's failures are kept
		const both = partResult({ junit: JUNIT_C, log: null, exit: 124, ms: 1, timedOut: true, importError: "full.log is over the 5-byte report cap" });
		expect(both.error).toBe("timeout; report import refused: full.log is over the 5-byte report cap");
		expect(both.failures).toHaveLength(5);
		// a refused junit: no failures to keep, the timeout still first
		expect(partResult({ junit: null, log: null, exit: 124, ms: 1, timedOut: true, importError: "full.xml is a symlink" }).error).toBe("timeout; report import refused: full.xml is a symlink");
		// a partial junit that does not parse: timeout, then the report's error
		expect(partResult({ junit: JUNIT_A.slice(0, 400), log: null, exit: 124, ms: 1, timedOut: true }).error).toMatch(/^timeout; .*does not parse/);
		// a timed-out part with a readable failing junit: error timeout, failures kept
		const partial = partResult({ junit: manyFailures(3), log: null, exit: 124, ms: 1, timedOut: true });
		expect(partial).toMatchObject({ error: "timeout", fail: 3 });
		expect(partial.failures).toHaveLength(3);
	});
	test("PLAN wl-mvq4edh02r5z40 D0: a call timed out when the wrapper exited 124 or the outlive sweep fired on it, whatever its later exit", () => {
		expect(callTimedOut({ code: WRAPPER_EXIT.timeout, outlived: false })).toBe(true);
		for (const code of [0, 1, WRAPPER_EXIT.failed, WRAPPER_EXIT.refused, null]) expect(callTimedOut({ code, outlived: true })).toBe(true);
		for (const code of [0, 1, WRAPPER_EXIT.failed, WRAPPER_EXIT.refused, null]) expect(callTimedOut({ code, outlived: false })).toBe(false);
	});
	test("PLAN wl-mvq8x4pkjmx69s D4: a call is stuck when it exited 125 or its stdout has a stuck-stop line, however it ended", () => {
		expect(WRAPPER_EXIT.stuck).toBe(125);
		const stop = "part full\nstuck-signature 2026-10-27T05:00:00.000Z part full worker 41 zombie 42 since 5000 mode enforce bun 1.3.14 abc\nstuck-stop 2026-10-27T05:00:05.000Z part full worker 41 zombie 42\n";
		expect(callStuck({ code: WRAPPER_EXIT.stuck, out: "" })).toBe(true);
		// a stop line then a signal exit, another exit, the backstop's abandonment (no exit) or an early refusal: still stuck
		for (const code of [null, 0, 1, WRAPPER_EXIT.timeout, WRAPPER_EXIT.failed, WRAPPER_EXIT.refused]) expect(callStuck({ code, out: stop })).toBe(true);
		// a signature alone, a shadow `stuck-would-stop`, a cleared signature: not stuck
		const shadow = "stuck-signature 2026-10-27T05:00:00.000Z part full worker 41 zombie 42 since 5000 mode shadow bun 1.3.14 abc\nstuck-would-stop 2026-10-27T05:00:05.000Z part full worker 41 zombie 42\n";
		for (const out of ["", shadow, "a log line mentioning stuck-stop part full worker 1 zombie 2\n"]) expect(callStuck({ code: 0, out })).toBe(false);
	});
	test("D4: a stuck part's reason starts `stuck:`: the exec's own line, else one built from the stop line; an abandoned stop says so", () => {
		const stop = "stuck-stop 2026-10-27T05:00:05.000Z part full worker 41 zombie 42\n";
		const own = "stuck: worker 41 spun 5200 ms in Bun.spawnSync with unreaped child 42; 2 process groups killed, containment contained";
		expect(stuckReason({ code: 125, out: stop, err: `noise\n${own}`, abandoned: false })).toBe(own);
		expect(stuckReason({ code: null, out: stop, err: "", abandoned: false })).toBe("stuck: worker 41 spun in Bun.spawnSync with unreaped child 42");
		expect(stuckReason({ code: null, out: stop, err: "", abandoned: true })).toBe("stuck: worker 41 spun in Bun.spawnSync with unreaped child 42; executor did not finish the stop");
		expect(stuckReason({ code: 125, out: "", err: "", abandoned: false })).toBe("stuck: the executor exited 125 with no stop line");
	});
	describe("D4: the enforce backstop over a part's stdout", () => {
		const t0 = Date.parse("2026-10-27T05:00:00.000Z");
		const at = (ms: number) => new Date(t0 + ms).toISOString();
		const sig = (ms: number, w: number, z: number) => `stuck-signature ${at(ms)} part full worker ${w} zombie ${z} since 5000 mode enforce bun 1.3.14 abc\n`;
		const cleared = (ms: number, w: number, z: number) => `stuck-cleared ${at(ms)} part full worker ${w} zombie ${z} held 800 matched no\n`;
		const stopLine = (ms: number, w: number, z: number) => `stuck-stop ${at(ms)} part full worker ${w} zombie ${z}\n`;
		test("a signature opens a deadline at its own time plus the backstop; nothing else does", () => {
			const s = new StuckWatch(16_500);
			s.feed("part full\nsome output\n", t0);
			expect(s.first()).toBeNull();
			s.feed(`part full\nsome output\n${sig(1000, 41, 42)}`, t0 + 9_000);
			expect(s.first()).toEqual({ worker: 41, zombie: 42, deadline: t0 + 1000 + 16_500 });
			// an incomplete line is read once it ends
			const partial = `part full\nsome output\n${sig(1000, 41, 42)}stuck-cleared ${at(2000)} part full worker 41`;
			s.feed(partial, t0 + 9_500);
			expect(s.first()?.worker).toBe(41);
			s.feed(`${partial} zombie 42 held 1000 matched no\n`, t0 + 9_600);
			expect(s.first()).toBeNull();
		});
		test("a signature then stuck-cleared: the backstop is disarmed and the part runs on", () => {
			const s = new StuckWatch(1_000);
			s.feed(sig(0, 41, 42) + cleared(500, 41, 42), t0 + 600);
			expect(s.first()).toBeNull();
			expect(s.stopSeen).toBe(false);
		});
		test("overlapping signatures A and B, A cleared: B's deadline still fires", () => {
			const s = new StuckWatch(16_500);
			s.feed(sig(0, 41, 42) + sig(2000, 51, 52) + cleared(3000, 41, 42), t0 + 3000);
			expect(s.first()).toEqual({ worker: 51, zombie: 52, deadline: t0 + 2000 + 16_500 });
			// a clear of another key closes only its own
			s.feed(sig(0, 41, 42) + sig(2000, 51, 52) + cleared(3000, 41, 42) + cleared(3500, 41, 99), t0 + 3500);
			expect(s.first()?.worker).toBe(51);
		});
		test("the earliest open deadline is the call's", () => {
			const s = new StuckWatch(16_500);
			s.feed(sig(2000, 51, 52) + sig(0, 41, 42), t0 + 2000);
			expect(s.first()?.worker).toBe(41);
		});
		test("a stop line makes the deadline terminal: a later stuck-cleared neither disarms nor extends it", () => {
			const s = new StuckWatch(16_500);
			s.feed(sig(0, 41, 42) + stopLine(5000, 41, 42) + cleared(6000, 41, 42) + sig(7000, 41, 42), t0 + 7000);
			expect(s.stopSeen).toBe(true);
			expect(s.first()).toEqual({ worker: 41, zombie: 42, deadline: t0 + 16_500 });
		});
		test("a stop line with no signature opens its own deadline; an unparsable time counts from the read", () => {
			const s = new StuckWatch(1_000);
			s.feed(stopLine(5000, 41, 42), t0 + 5100);
			expect(s.first()).toEqual({ worker: 41, zombie: 42, deadline: t0 + 6000 });
			const u = new StuckWatch(1_000);
			u.feed("stuck-signature not-a-time part full worker 41 zombie 42 since 5000 mode enforce bun 1 x\n", t0);
			expect(u.first()?.deadline).toBe(t0 + 1_000);
		});
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
	test("executedFiles (PLAN wl-mvq4edh02r5z40 D1): a file counts once one of its cases has no <skipped>; skip and todo cases alone never count", () => {
		const xml = `<testsuites tests="6" failures="1" skipped="3">
  <testsuite name="a.test.ts" file="a.test.ts"><testcase name="s" file="a.test.ts"><skipped /></testcase><testcase name="t" file="a.test.ts"><skipped message="TODO" /></testcase></testsuite>
  <testsuite name="sub/b.test.ts" file="sub/b.test.ts"><testsuite name="outer" file="sub/b.test.ts"><testcase name="s" file="sub/b.test.ts"><skipped /></testcase><testcase name="fails" file="sub/b.test.ts"><failure type="AssertionError" /></testcase></testsuite></testsuite>
  <testsuite name="c.test.ts" file="c.test.ts"><testcase name="ok" file="c.test.ts" /></testsuite>
  <testsuite name="./d.test.ts" file="./d.test.ts"><testcase name="ok" file="./d.test.ts" /></testsuite>
</testsuites>`;
		expect(executedFiles(xml)).toEqual(["sub/b.test.ts", "c.test.ts", "d.test.ts"]);
		// a report that does not parse, or is not a report, ran nothing
		for (const bad of ["", JUNIT_A.slice(0, 400), "<testsuite tests='1' failures='0'><testcase name='a'/></testsuite>"]) expect(executedFiles(bad)).toEqual([]);
		expect(executedFiles(JUNIT_GATES_FULL)).toEqual(["gates/test/sec.test.ts", "surface/test/plain.test.ts"]);
	});
	test("executedFiles reads the installed bun's own report: an all-skip and an all-todo file are not executed (format drift fails here)", () => {
		const dir = tmp("junit-executed");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "ran.test.ts"), 'import { test } from "bun:test";\ntest("ok", () => {});\ntest.skip("s", () => {});\n');
		writeFileSync(join(dir, "skips.test.ts"), 'import { test } from "bun:test";\ntest.skip("s", () => {});\n');
		writeFileSync(join(dir, "todos.test.ts"), 'import { test } from "bun:test";\ntest.todo("t");\n');
		const out = join(dir, "out.xml");
		const p = Bun.spawnSync([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${out}`], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
		expect(p.exitCode).toBe(0);
		expect(executedFiles(readFileSync(out, "utf8"))).toEqual(["sub/ran.test.ts"]);
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
		requestedSha: A, fetchedSha: A, error: null, full: part(), fullTimedOut: false, solo: [{ file: "./x.test.ts", ...part() }], headAtStart: A, headAtEnd: A, owner: true, sliceState: "open", baseRuns: null,
		stuck: null, executorStalled: null, ...over,
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
	// PLAN wl-mvpwkpqobyp20w D4c: a train's carried green records where it came from, in its reason and its slice's artifact.
	test("a real green's reason is null, so its artifact has no suffix; a carried green keeps R's counts and run dir, parses, and its artifact appends its reason", () => {
		const g = buildTestRun(request("tr-0abc12", 17, A), facts(), decideRun(facts()), { base: B, mergeBase: C, runDir: "/runs/tr-0abc12", preflight: "ok" });
		expect(g.reason).toBeNull();
		const c = carriedRun(request("tr-0carry", 17, B), g);
		expect(c).toEqual({
			runId: "tr-0carry", verdict: "green", sha: B, pr: 17, reason: `carried from tr-0abc12 at ${A} (decision-log only)`, headAtEnd: null, base: B, mergeBase: C,
			full: g.full, solo: g.solo, failures: [], runDir: "/runs/tr-0abc12", preflight: null,
		});
		expect(parseTestRun(testRunBody(c))).toEqual(c);
		expect(settleArtifact(c)).toBe(`test-run tr-0carry: green at ${B} on PR #17; full 10/0/0; alone: ./x.test.ts 10/0; /runs/tr-0abc12; carried from tr-0abc12 at ${A} (decision-log only)`);
		// carrying again from a carried green names the green it carried from
		expect(carriedRun(request("tr-0again", 17, B), c).reason).toBe(`carried from tr-0carry at ${B} (decision-log only)`);
		// only a green on the same PR carries
		expect(() => carriedRun(request("tr-0x", 18, B), g)).toThrow(TestRunShapeError);
		expect(() => carriedRun(request("tr-0x", 17, B), { ...g, verdict: "red" })).toThrow(TestRunShapeError);
	});
	test("the orchestrator hears a non-green, owned result only when no lane holds the workload live", () => {
		expect(notifiesOrchestrator("red", false)).toBe(true);
		expect(notifiesOrchestrator("error", false)).toBe(true);
		expect(notifiesOrchestrator("stale", false)).toBe(true);
		expect(notifiesOrchestrator("red", true)).toBe(false);
		expect(notifiesOrchestrator("green", false)).toBe(false);
		expect(notifiesOrchestrator("superseded", false)).toBe(false);
	});
	// PLAN wl-mv8s8srodefytc rev 17.1 D8, PLAN wl-mvq4edh02r5z40 D3: each failing file rerun alone is compared with base's run of that file alone.
	const named = (names: string[], over: Partial<PartResult> = {}): PartResult =>
		part(names.length, { failures: names.map((name) => ({ name, firstError: `error: ${name}` })), ...over });
	const onBase = (parts: Record<string, PartResult>) => ({ sha: C, parts });
	const solo = (file: string, r: PartResult) => ({ file, ...r });
	test("red-main: each failing file's solo part is compared with base's solo run of that file; base never runs the full suite", () => {
		const pr = facts({ full: named(["x.test.ts > t1", "y.test.ts > t2"]), solo: [solo("./x.test.ts", named(["x.test.ts > t1"])), solo("./y.test.ts", named(["y.test.ts > t2"]))] });
		expect(baseParts(pr)).toEqual(["./x.test.ts", "./y.test.ts"]);
		// both fail on base, each alone: red-main, settled like a green
		const both = facts({ ...pr, baseRuns: onBase({ "./x.test.ts": named(["x.test.ts > t1", "x.test.ts > other"]), "./y.test.ts": named(["y.test.ts > t2"]) }) });
		expect(decideRun(both)).toEqual({ verdict: "red-main", outcome: "red-main", reason: `every failing test also fails on base ${C.slice(0, 7)}`, settle: true });
		expect(baseCompareFor(both)).toEqual({
			sha: C, parts: [
				{ part: "./x.test.ts", failing: ["x.test.ts > t1"], baseFailing: ["x.test.ts > t1", "x.test.ts > other"], baseError: null },
				{ part: "./y.test.ts", failing: ["y.test.ts > t2"], baseFailing: ["y.test.ts > t2"], baseError: null },
			],
		});
		// a `full` base result (what an older runner cached) is never read: y's own solo run on base is missing, so red
		const fullOnly = facts({ ...pr, baseRuns: onBase({ full: named(["x.test.ts > t1", "y.test.ts > t2"]), "./x.test.ts": named(["x.test.ts > t1"]) }) });
		expect(decideRun(fullOnly)).toMatchObject({ verdict: "red", settle: false });
		expect(baseCompareFor(fullOnly)!.parts.map((p) => [p.part, p.baseError])).toEqual([["./x.test.ts", null], ["./y.test.ts", "not run on base"]]);
		// red-main settles an open slice only
		expect(decideRun({ ...both, sliceState: "paused" })).toMatchObject({ verdict: "red-main", settle: false });
	});
	test("red-main needs every full failure reproduced alone: a failing file that passes alone, or two identical full failures reproduced once, stay red", () => {
		// the file passed alone: red whatever base says, its full failure kept, the reason names it
		const passedAlone = facts({ full: named(["x.test.ts > flaky in the suite"]), solo: [solo("./x.test.ts", part())], baseRuns: onBase({}) });
		expect(baseParts(passedAlone)).toEqual([]);
		const d = decideRun(passedAlone);
		expect(d).toEqual({ verdict: "red", outcome: "red", reason: "failing in the full part; passed alone: ./x.test.ts", settle: false });
		const t = buildTestRun(request("tr-0abc12", 17, A), passedAlone, d, { base: C, mergeBase: B, runDir: "/runs/tr-0abc12", preflight: "ok" });
		expect(t.failures).toEqual([{ part: "full", name: "x.test.ts > flaky in the suite", firstError: "error: x.test.ts > flaky in the suite" }]);
		// two identical full failures, reproduced once alone, though base fails it twice: red
		const twice = facts({
			full: named(["auth.test.ts > access", "auth.test.ts > access"]), solo: [solo("./auth.test.ts", named(["auth.test.ts > access"]))],
			baseRuns: onBase({ "./auth.test.ts": named(["auth.test.ts > access", "auth.test.ts > access"]) }),
		});
		expect(decideRun(twice)).toMatchObject({ verdict: "red", reason: null, settle: false });
		// reproduced twice alone and failed twice on base: red-main
		const reproduced = facts({ ...twice, solo: [solo("./auth.test.ts", named(["auth.test.ts > access", "auth.test.ts > access"]))] });
		expect(decideRun(reproduced)).toMatchObject({ verdict: "red-main", settle: true });
		// a failing file with no solo part (not runnable alone): red
		const unrerun = facts({ full: named(["x.test.ts > t1", "? > t2"]), solo: [solo("./x.test.ts", named(["x.test.ts > t1"]))], baseRuns: onBase({ "./x.test.ts": named(["x.test.ts > t1"]) }) });
		expect(decideRun(unrerun)).toMatchObject({ verdict: "red", settle: false });
	});
	test("red-main: base failures compare as a multiset, so a second failure under a name base fails once gives red", () => {
		const twice = facts({
			full: named(["auth.test.ts > access", "auth.test.ts > access"]), solo: [solo("./auth.test.ts", named(["auth.test.ts > access", "auth.test.ts > access"]))],
			baseRuns: onBase({ "./auth.test.ts": named(["auth.test.ts > access"]) }),
		});
		expect(decideRun(twice)).toMatchObject({ verdict: "red", settle: false });
		expect(mainRed({ sha: C, parts: [{ part: "./a.test.ts", failing: ["a > x", "a > x"], baseFailing: ["a > x", "a > x"], baseError: null }] })).toBe(true);
		expect(mainRed({ sha: C, parts: [{ part: "./a.test.ts", failing: ["a > x"], baseFailing: ["a > x", "a > x"], baseError: null }] })).toBe(true);
		expect(mainRed({ sha: C, parts: [{ part: "./a.test.ts", failing: ["a > x", "a > new"], baseFailing: ["a > x"], baseError: null }] })).toBe(false);
	});
	test("red-main: a base solo run that errored, or never ran, gives red", () => {
		const f = facts({ full: named(["x.test.ts > t2"]), solo: [solo("./x.test.ts", named(["x.test.ts > t2"]))] });
		const errored = { ...f, baseRuns: onBase({ "./x.test.ts": named([], { error: "the wrapper refused base-solo (exit 64)" }) }) };
		expect(decideRun(errored)).toMatchObject({ verdict: "red", settle: false });
		expect(baseCompareFor(errored)!.parts).toEqual([{ part: "./x.test.ts", failing: ["x.test.ts > t2"], baseFailing: null, baseError: "the wrapper refused base-solo (exit 64)" }]);
		const missing = { ...f, baseRuns: onBase({}) };
		expect(decideRun(missing)).toMatchObject({ verdict: "red" });
		expect(baseCompareFor(missing)!.parts[0]!.baseError).toBe("not run on base");
	});
	test("clean-parts guard: a failing full part with a non-timeout error, or a failing solo beside a broken one, has no base parts and is never red-main, even when base fails the same", () => {
		const failsOnBase = onBase({ "./x.test.ts": named(["x.test.ts > t1"]), "./y.test.ts": named([]) });
		const fullBroken = facts({ full: named(["x.test.ts > t1"], { error: "killed before it exited", exit: null }), solo: [solo("./x.test.ts", named(["x.test.ts > t1"]))] });
		expect(baseParts(fullBroken)).toEqual([]);
		expect(decideRun({ ...fullBroken, baseRuns: failsOnBase })).toMatchObject({ verdict: "red", settle: false });
		const brokenSolo = facts({ full: named(["x.test.ts > t1"]), solo: [solo("./x.test.ts", named(["x.test.ts > t1"])), solo("./y.test.ts", part(0, { error: "junit report missing" }))] });
		expect(baseParts(brokenSolo)).toEqual([]);
		expect(decideRun({ ...brokenSolo, baseRuns: failsOnBase })).toMatchObject({ verdict: "red", settle: false });
		// a solo with no failing test that exited non-zero is broken too
		const exited = facts({ full: named(["x.test.ts > t1"]), solo: [solo("./x.test.ts", named(["x.test.ts > t1"])), solo("./y.test.ts", part(0, { exit: 2 }))] });
		expect(baseParts(exited)).toEqual([]);
		expect(decideRun({ ...exited, baseRuns: failsOnBase }).verdict).toBe("red");
		expect(baseParts(facts())).toEqual([]);
	});
	test("security: a failure in a security test, in the full part or a coverage solo, is never red-main and never named for base", () => {
		const sec = "gates/test/g.test.ts > gate";
		// a security failure in the full part beside a reproduced, base-failing plain one
		const inFull = facts({ full: named([sec, "x.test.ts > t1"]), solo: [solo("./x.test.ts", named(["x.test.ts > t1"]))], baseRuns: onBase({ "./x.test.ts": named(["x.test.ts > t1"]) }) });
		expect(baseParts(inFull)).toEqual(["./x.test.ts"]);
		expect(decideRun(inFull)).toMatchObject({ verdict: "red", settle: false });
		// a coverage solo of a security file (the full part passed but never ran it) that fails: red, no base part
		const coverage = facts({ full: part(), solo: [solo("./gates/test/g.test.ts", named([sec]))], baseRuns: onBase({ "./gates/test/g.test.ts": named([sec]) }) });
		expect(baseParts(coverage)).toEqual([]);
		expect(baseCompareFor(coverage)!.parts).toEqual([]);
		expect(decideRun(coverage)).toMatchObject({ verdict: "red", settle: false });
		expect(securityFailuresOf(buildTestRun(request("tr-0abc12", 17, A), coverage, decideRun(coverage), { base: C, mergeBase: B, runDir: "/r", preflight: "ok" })).map((f) => f.part)).toEqual(["./gates/test/g.test.ts"]);
	});
	test("a timed-out full part (PLAN wl-mvq4edh02r5z40 D2) is error naming the timeout, before the failures its partial junit kept, which stay in the entry", () => {
		const full = named(["x.test.ts > t1"], { error: "timeout", exit: 124 });
		const f = facts({ full, fullTimedOut: true, solo: [] });
		const d = decideRun(f);
		expect(d).toEqual({ verdict: "error", outcome: "error", reason: "full: timeout", settle: false });
		expect(buildTestRun(request("tr-0abc12", 17, A), f, d, { base: C, mergeBase: B, runDir: "/r", preflight: "ok" }).failures.map((x) => [x.part, x.name])).toEqual([["full", "x.test.ts > t1"]]);
		// the import refusal rides along; the outlive path (a later exit, no `timeout` error string) still names the timeout
		expect(decideRun(facts({ full: named(["x.test.ts > t1"], { error: "timeout; report import refused: full.log is over the 5-byte report cap", exit: 124 }), fullTimedOut: true, solo: [] })).reason)
			.toBe("full: timeout; report import refused: full.log is over the 5-byte report cap");
		expect(decideRun(facts({ full: named(["x.test.ts > t1"]), fullTimedOut: true, solo: [] })).reason).toBe("full: timeout");
		expect(decideRun(facts({ full: part(0, { error: "the wrapper failed full (exit 70)", exit: 70 }), fullTimedOut: true, solo: [] })).reason).toBe("full: timeout; the wrapper failed full (exit 70)");
		// a stale head still outranks it
		expect(decideRun(facts({ full, fullTimedOut: true, solo: [], headAtEnd: B })).verdict).toBe("stale");
	});
	test("a stuck part (PLAN wl-mvq8x4pkjmx69s D4) is error with its reason, over failures and a timeout; failures stay; never green or red-main", () => {
		const reason = "full: stuck: worker 41 spun 5200 ms in Bun.spawnSync with unreaped child 42; 2 process groups killed, containment contained";
		const sec = "gates/test/g.test.ts > gate";
		const full = named(["x.test.ts > t1", sec], { error: "stuck: worker 41 …", exit: 125 });
		const f = facts({ full, solo: [], stuck: reason });
		const d = decideRun(f);
		expect(d).toEqual({ verdict: "error", outcome: "error", reason, settle: false });
		const t = buildTestRun(request("tr-0abc12", 17, A), f, d, { base: C, mergeBase: B, runDir: "/r", preflight: "ok" });
		expect(t.failures.map((x) => x.name)).toEqual(["x.test.ts > t1", sec]);
		expect(securityFailuresOf(t).map((x) => x.name)).toEqual([sec]);
		// over a timeout
		expect(decideRun(facts({ full, fullTimedOut: true, solo: [], stuck: reason })).reason).toBe(reason);
		// a stuck solo or base part in a run whose every part would be green, or red-main, is still error
		expect(decideRun(facts({ stuck: "./x.test.ts: stuck: worker 1 spun in Bun.spawnSync with unreaped child 2" }))).toMatchObject({ verdict: "error", reason: "./x.test.ts: stuck: worker 1 spun in Bun.spawnSync with unreaped child 2" });
		const mainRedFacts = facts({ full: named(["x.test.ts > t1"]), solo: [solo("./x.test.ts", named(["x.test.ts > t1"]))], baseRuns: onBase({ "./x.test.ts": named(["x.test.ts > t1"]) }) });
		expect(decideRun(mainRedFacts).verdict).toBe("red-main");
		expect(decideRun({ ...mainRedFacts, stuck: "base ./x.test.ts: stuck: x" })).toMatchObject({ verdict: "error", reason: "base ./x.test.ts: stuck: x" });
		// a run-level error rides after it; a fetched head that is not the request, or a head that moved, is still stale
		expect(decideRun(facts({ stuck: reason, error: "post-sweep deadline exceeded before publication" })).reason).toBe(`${reason}; post-sweep deadline exceeded before publication`);
		expect(decideRun(facts({ stuck: reason, fetchedSha: B })).verdict).toBe("stale");
		expect(decideRun(facts({ stuck: reason, headAtEnd: B })).verdict).toBe("stale");
		// a head re-check that could not answer leaves the stuck reason
		expect(decideRun(facts({ stuck: reason, headAtEnd: null }))).toMatchObject({ verdict: "error", reason });
	});
	test("a stalled executor (D4) is error with its own reason, never a stuck one", () => {
		const reason = `full: ${executorStalledReason(41)}`;
		expect(reason).toBe("full: executor stalled during stuck detection; worker 41 was a candidate, not confirmed");
		const d = decideRun(facts({ full: part(0, { error: executorStalledReason(41), exit: null }), solo: [], executorStalled: reason }));
		expect(d).toEqual({ verdict: "error", outcome: "error", reason, settle: false });
		expect(d.reason).not.toContain("stuck:");
	});
	test("red-main: the entry carries base's sha and both failure sets, round-trips, settles with an artifact naming base, and signals no failure", () => {
		const r = request("tr-0abc12", 17, A);
		const f = facts({ full: named(["x.test.ts > t1"]), solo: [solo("./x.test.ts", named(["x.test.ts > t1"]))], baseRuns: onBase({ "./x.test.ts": named(["x.test.ts > t1", "x.test.ts > other"]) }) });
		const t = buildTestRun(r, f, decideRun(f), { base: C, mergeBase: B, runDir: "/runs/tr-0abc12", preflight: "ok" });
		expect(t.verdict).toBe("red-main");
		expect(t.baseCompare).toEqual({ sha: C, parts: [{ part: "./x.test.ts", failing: ["x.test.ts > t1"], baseFailing: ["x.test.ts > t1", "x.test.ts > other"], baseError: null }] });
		expect(parseTestRun(testRunBody(t))).toEqual(t);
		expect(settleArtifact(t)).toBe(`test-run tr-0abc12: red-main at ${A} on PR #17; full 10/1/0; alone: ./x.test.ts 10/1; every failure also fails on base ${C} (./x.test.ts 1); /runs/tr-0abc12`);
		expect(testRunFailedOf("wl-t", "sl-full-1", t)).toBeNull();
		expect(notifiesOrchestrator("red-main", false)).toBe(false);
		// a red-main without the comparison it rests on is no shape the parser or the formatter accepts
		const { baseCompare: _, ...bare } = t;
		expect(() => testRunBody(bare)).toThrow(TestRunShapeError);
		expect(parseTestRun(testRunBody(t).replace(/,"baseCompare":.*\}$/, "}"))).toBeNull();
	});
});

describe("the solo policy (PLAN wl-mvq4edh02r5z40 D1)", () => {
	const ok = (over: Partial<PartResult> = {}): PartResult => ({ pass: 3, fail: 0, skip: 0, exit: 0, ms: 5, error: null, failures: [], ...over });
	const failing = (names: string[], over: Partial<PartResult> = {}): PartResult => ok({ fail: names.length, exit: 1, failures: names.map((name) => ({ name, firstError: "e" })), ...over });
	const changed = ["./a.test.ts", "./sub/b_spec.ts", "./gates/test/g.test.ts"];
	test("a timed-out full part stops the run, whatever its partial junit or the changed files", () => {
		expect(soloPlan({ full: failing(["a.test.ts > t"], { error: "timeout" }), timedOut: true, changed, executed: ["a.test.ts"] })).toEqual({ stop: true });
		expect(soloPlan({ full: ok({ error: "timeout", exit: 124 }), timedOut: true, changed, executed: [] })).toEqual({ stop: true });
		// the outlive path: a part that looks clean but whose call timed out still stops
		expect(soloPlan({ full: ok(), timedOut: true, changed, executed: [] })).toEqual({ stop: true });
	});
	test("a stuck or stalled full part (PLAN wl-mvq8x4pkjmx69s D4) stops the run, whatever it reported", () => {
		expect(soloPlan({ full: failing(["a.test.ts > t"], { error: "stuck: worker 1" }), timedOut: false, halted: true, changed, executed: ["a.test.ts"] })).toEqual({ stop: true });
		expect(soloPlan({ full: ok(), timedOut: false, halted: true, changed, executed: [] })).toEqual({ stop: true });
	});
	test("an all-pass full part runs alone only the changed files it ran no test of, a security file among them (a first run, not a rerun)", () => {
		expect(soloPlan({ full: ok(), timedOut: false, changed, executed: ["a.test.ts", "sub/b_spec.ts", "gates/test/g.test.ts", "other.test.ts"] })).toEqual({ stop: false, files: [] });
		expect(soloPlan({ full: ok(), timedOut: false, changed, executed: ["./a.test.ts"] })).toEqual({ stop: false, files: ["./sub/b_spec.ts", "./gates/test/g.test.ts"] });
		expect(soloPlan({ full: ok(), timedOut: false, changed, executed: [] })).toEqual({ stop: false, files: changed });
		expect(soloPlan({ full: ok(), timedOut: false, changed: [], executed: [] })).toEqual({ stop: false, files: [] });
	});
	test("a clean red full part runs alone each failing file once, in report order, never a security file, never a file that cannot run alone, never a changed file that did not fail", () => {
		const full = failing(["sub/b_spec.ts > d > t1", "z.test.ts > t2", "sub/b_spec.ts > t3", "gates/test/g.test.ts > gate", "? > lost", "helpers.ts > t4", "../up.test.ts > t5"]);
		expect(soloPlan({ full, timedOut: false, changed, executed: [] })).toEqual({ stop: false, files: ["./sub/b_spec.ts", "./z.test.ts"] });
		expect(soloPlan({ full: failing(["gates/test/g.test.ts > gate"]), timedOut: false, changed, executed: [] })).toEqual({ stop: false, files: [] });
	});
	test("any other full error (not a timeout) runs every changed file alone but a security file that failed in the full part", () => {
		const broken = failing(["gates/test/g.test.ts > gate", "a.test.ts > t"], { error: "killed before it exited", exit: null });
		expect(soloPlan({ full: broken, timedOut: false, changed: [...changed, "./gates/test/h.test.ts"], executed: [] })).toEqual({ stop: false, files: ["./a.test.ts", "./sub/b_spec.ts", "./gates/test/h.test.ts"] });
		for (const error of ["junit report missing", "exit 2 with no failing test", "report import refused: full.log is a symlink"]) {
			expect(soloPlan({ full: ok({ error, exit: 2 }), timedOut: false, changed, executed: [] })).toEqual({ stop: false, files: changed });
		}
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
		expect(boundPrs([ent], [ins])).toEqual([{ pr: 79, by: ins.id }, { pr: 70, by: ins.id }]);
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
			{ pr: 79, by: one.ins.id }, { pr: 70, by: one.ins.id }, { pr: 73, by: two.ins.id },
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
		expect(queuedTooLong(NOW - 60 * 60_000, NOW, { queueMaxMin: 60 }, false)).toBe(false);
		expect(queuedTooLong(NOW - 60 * 60_000 - 1, NOW, { queueMaxMin: 60 }, false)).toBe(true);
		// a merge train's run never ends on the wait cap (jo-issues #213)
		expect(queuedTooLong(NOW - 60 * 60_000 - 86_400_000, NOW, { queueMaxMin: 60 }, true)).toBe(false);
		expect(queuedTooLong(NOW - 60 * 60_000 - 365 * 86_400_000, NOW, { queueMaxMin: 60 }, true)).toBe(false);
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
	test("T4: a queued waiter is live on its own record: none or settled is dead; a fresh heartbeat keeps an old request live; no heartbeat lives only in the startup lease", () => {
		const r1 = request("tr-1", 17, A);
		const rec = testRuns([reqEntry(r1)])[0]!;
		const requestedAt = Date.parse(rec.request.createdAt);
		expect(queueWaiterLive(undefined, requestedAt, requestedAt + 1_000)).toBe(false);
		const settled = testRuns([reqEntry(r1), runEntry(runnerDiedRun(r1))])[0]!;
		expect(queueWaiterLive(settled, requestedAt + 1_000, requestedAt + 2_000)).toBe(false);
		expect(queueWaiterLive(rec, requestedAt + 599_000, requestedAt + 600_000)).toBe(true);
		expect(queueWaiterLive(rec, requestedAt + 539_000, requestedAt + 600_000)).toBe(false);
		expect(queueWaiterLive(rec, null, requestedAt + 5_000)).toBe(true);
		expect(queueWaiterLive(rec, null, requestedAt + 121_000)).toBe(false);
	});
	test("T4: queueAhead orders by requestedAt then run id, reports the dead rows ahead, stops at the first live one, never judges rows behind", () => {
		const row = (runId: string, requestedAt: number): QueueRow => ({ runId, workloadId: "wl-t", requestedAt });
		const rows = [row("tr-c", 30), row("tr-self", 20), row("tr-b", 10), row("tr-a", 10), row("tr-z", 5)];
		const judged: string[] = [];
		const liveSet = (live: string[]) => (q: QueueRow) => {
			judged.push(q.runId);
			return live.includes(q.runId);
		};
		expect(queueAhead(rows, "tr-self", liveSet([]))).toEqual({ blocker: null, dead: ["tr-z", "tr-a", "tr-b"] });
		expect(judged).toEqual(["tr-z", "tr-a", "tr-b"]);
		judged.length = 0;
		expect(queueAhead(rows, "tr-self", liveSet(["tr-b", "tr-c"]))).toEqual({ blocker: "tr-b", dead: ["tr-z", "tr-a"] });
		judged.length = 0;
		expect(queueAhead(rows, "tr-self", liveSet(["tr-z", "tr-a"]))).toEqual({ blocker: "tr-z", dead: [] });
		expect(judged).toEqual(["tr-z"]);
		// the oldest waiter has no one ahead; rows behind it, live or not, are never judged
		judged.length = 0;
		expect(queueAhead(rows, "tr-z", liveSet(["tr-a", "tr-c"]))).toEqual({ blocker: null, dead: [] });
		expect(judged).toEqual([]);
		// a tie on requestedAt goes by run id: tr-a is ahead of tr-b
		expect(queueAhead(rows, "tr-b", liveSet(["tr-a"]))).toEqual({ blocker: "tr-a", dead: ["tr-z"] });
		expect(queueAhead(rows, "tr-a", liveSet(["tr-b"]))).toEqual({ blocker: null, dead: ["tr-z"] });
		expect(() => queueAhead(rows, "tr-missing", liveSet([]))).toThrow(TestRunShapeError);
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
});

// ---- 9. close freshness ---------------------------------------------------------------------------------------

describe("close freshness (§ 2.4 item 4)", () => {
	const green = (sha: string, runId = "tr-1") => ({ runId, verdict: "green" as const, sha });
	const pr = (over: Partial<ClosePr> = {}): ClosePr => ({
		number: 17, state: "OPEN", headRefName: "wl/wl-t", headSha: A, result: green(A), headCompare: null, candidateCompare: null, waivedRun: null, trainSkipped: null, onTrain: false,
		mergeCommit: null, cover: null, waivedByJo: null, ...over,
	});
	const facts = (prs: ClosePr[], changed: string[] = ["surface/src/x.ts"], candidate = A) => ({ failure: null, branch: "wl/wl-t", defaultBranch: "main", candidate: { sha: candidate, changed }, prs });
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
		const refused = closeFreshness(facts([pr({ result: { runId: auth.result!.runId, verdict: auth.result!.verdict, sha: auth.result!.sha } })]));
		expect(refused).toEqual({ close: false, reason: "PR #17's newest test-run tr-2 is red: fix it and call lane_full_test (a waiver passes only a merged PR)" });
		const old = request("tr-3", 17, A);
		const newer = request("tr-4", 17, A);
		const late = testRuns([reqEntry(old), reqEntry(newer), runEntry(run(newer, "green")), runEntry(run(old, "superseded"))]);
		const a2 = authoritativeRun(late, 17)!;
		expect(a2.request.runId).toBe("tr-4");
		expect(a2.result!.verdict).toBe("green");
		expect(closeFreshness(facts([pr({ result: { runId: "tr-4", verdict: "green", sha: A } })])).close).toBe(true);
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
	test("PLAN wl-mv5i3lulwwbbi8 D3: a merged PR passes on Jo's waiver of its authoritative red at its head; an older run, another sha or an open PR do not", () => {
		const red = (sha: string, runId = "tr-2") => ({ runId, verdict: "red" as const, sha });
		// Tinker's shape: merged, red at the merged head, that run waived, no code delta on the candidate
		expect(closeFreshness(facts([pr({ state: "MERGED", result: red(A), waivedRun: "tr-2" })], []))).toEqual({
			close: true, why: "every PR in the set is green at its head or merged with a waived run (#17 (tr-2))",
		});
		// a waiver of an older run binds nothing: the authoritative run is tr-2; the refusal keeps its text and appends D4's two ways (PLAN wl-mvfjen3q5mqi2o)
		const ways = "; it also passes once a green run's commit that contains aaaaaaa is on main (for example, the next green PR that merges main in, once it has merged), or on Jo's `waive-pr wl-t 17`";
		expect(closeFreshness(facts([pr({ state: "MERGED", mergeCommit: A, result: red(A), waivedRun: "tr-1" })], []))).toEqual({
			close: false, reason: `PR #17's newest test-run tr-2 is red: a merged PR passes only on Jo's \`waive\` answering a question that offers waive on the run's slice, asked after the result${ways}`,
		});
		// the waived run tested another sha than the merged head
		expect(closeFreshness(facts([pr({ state: "MERGED", mergeCommit: A, headSha: B, result: red(A), waivedRun: "tr-2" })], []))).toEqual({
			close: false, reason: `PR #17's newest test-run tr-2 is red and waived, but at aaaaaaa, not the merged head bbbbbbb${ways}`,
		});
		// PLAN wl-mvfjen3q5mqi2o: the same merged red passes on a covering green on main, or on Jo's waive-pr; an open red on neither
		const cover = { runId: "tr-9", sha: C, workloadId: "wl-other", how: "merge" as const };
		expect(closeFreshness(facts([pr({ state: "MERGED", mergeCommit: A, result: red(A), cover })], []))).toEqual({
			close: true, why: "every other PR in the set is green at its head; PR #17 merged; covered by test-run tr-9 green at ccccccc (wl-other), which contains merge commit aaaaaaa",
		});
		expect(closeFreshness(facts([pr({ state: "MERGED", mergeCommit: A, result: red(A), waivedByJo: "in-1" })], []))).toEqual({
			close: true, why: "every other PR in the set is green at its head; waived by Jo: #17 (in-1)",
		});
		expect(closeFreshness(facts([pr({ state: "OPEN", result: red(A), cover, waivedByJo: "in-1" })], [])).close).toBe(false);
		// an open PR never passes on a waiver
		expect(closeFreshness(facts([pr({ state: "OPEN", result: red(A), waivedRun: "tr-2" })], []))).toEqual({
			close: false, reason: "PR #17's newest test-run tr-2 is red: fix it and call lane_full_test (a waiver passes only a merged PR)",
		});
		// a waiver covers no code delta on the candidate: that still needs a green from the branch
		expect(closeFreshness(facts([pr({ state: "MERGED", result: red(A), waivedRun: "tr-2" })], ["surface/src/x.ts"], A))).toEqual({
			close: false, reason: "local wl/wl-t has untested commit aaaaaaa",
		});
	});
	test("PLAN wl-mv8s8srodefytc rev 17.1 D8: red-main passes only a train PR the train merged, at exactly that head", () => {
		const mainRed = (sha: string, runId = "tr-5") => ({ runId, verdict: "red-main" as const, sha });
		// merged, on a train, at the red-main's sha: it counts as that PR's green and covers the candidate it tested
		const ok = closeFreshness(facts([pr({ state: "MERGED", onTrain: true, result: mainRed(A) })]));
		expect(ok.close).toBe(true);
		expect(ok.close && ok.why).toContain("#17");
		// a PR on no train, an open train PR, a closed-unmerged train PR with the delta, or another head: refused
		expect(closeFreshness(facts([pr({ state: "MERGED", onTrain: false, result: mainRed(A) })])).close).toBe(false);
		expect(closeFreshness(facts([pr({ state: "OPEN", onTrain: true, result: mainRed(A) })])).close).toBe(false);
		expect(closeFreshness(facts([pr({ state: "CLOSED", onTrain: true, result: mainRed(A) })])).close).toBe(false);
		const moved = closeFreshness(facts([pr({ state: "MERGED", onTrain: true, headSha: B, result: mainRed(A), headCompare: ahead(one(B, [".ai/decision-log/a.md"])) })]));
		expect(moved.close).toBe(false);
		expect(!moved.close && moved.reason).toContain("tr-5");
		// it covers no candidate commit it did not test
		expect(closeFreshness(facts([pr({ state: "MERGED", onTrain: true, result: mainRed(A) })], ["surface/src/x.ts"], B)).close).toBe(false);
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
		expect(wrapperArgv({ sub: "base-prepare", runId: "tr-1", sha: C })).toEqual([...head, "base-prepare", "tr-1", C]);
		expect(wrapperArgv({ sub: "base-solo", runId: "tr-1", file: "./surface/test/x.test.ts" })).toEqual([...head, "base-solo", "tr-1", "./surface/test/x.test.ts"]);
		for (const bad of [
			{ sub: "full", runId: "tr-UP" }, { sub: "full", runId: "tr-1;rm" }, { sub: "prepare", runId: "tr-1", sha: "HEAD" }, { sub: "solo", runId: "tr-1", file: "x.test.ts" },
			{ sub: "solo", runId: "tr-1", file: "./../x.test.ts" }, { sub: "solo", runId: "tr-1", file: "./src/x.ts" }, { sub: "cleanup", runId: "tr-1", oldRunId: "tr-1" },
			{ sub: "cleanup", runId: "tr-1", oldRunId: "../x" }, { sub: "probe", runId: "tr-1", paths: [] }, { sub: "probe", runId: "tr-1", paths: ["rel"] },
			{ sub: "base-prepare", runId: "tr-1", sha: "main" }, { sub: "base-solo", runId: "tr-1", file: "./../x.test.ts" },
			// base never runs the full suite (PLAN wl-mvq4edh02r5z40 D3): `base-full` is no wrapper subcommand
			{ sub: "base-full", runId: "tr-1" },
		] as Parameters<typeof wrapperArgv>[0][]) expect(() => wrapperArgv(bad)).toThrow(TestRunShapeError);
		expect(WRAPPER_EXIT).toEqual({ ok: 0, probeReachable: 65, failed: 70, sweepLockHeld: 75, refused: 64, fenced: 77, timeout: 124, stuck: 125 });
	});
});
