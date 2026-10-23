// The waits tool (PLAN wl-mvg2kzuvwngdmo § 3 sl-tp-waits, § 4): per-run waits read from fixture run dirs
// (runner.log, result.json, heartbeat), the America/Los_Angeles day a request falls on, cross-PR suspects,
// the plain threshold exit, and each named condition of the `--qualify` gate, the source-sha ancestry
// checked against a real git repo built in a tmp dir. The CLI is run for real for its exit codes.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayRuns, qualifyFailures, readRun, requestMsOf, suspects, waitsReport } from "../scripts/test-run-waits";
import { heartbeatText, makeRunId } from "../src/test-run";
import { tmp } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "test-run-waits.ts");
const DAY = "2026-10-10";
/** 10:00 PDT on DAY. */
const T0 = Date.parse("2026-10-10T17:00:00.000Z");
/** The day after DAY has begun in PT. */
const ENDED = Date.parse("2026-10-12T00:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 0;
const entropy = (): string => `a${(++seq).toString(36).padStart(4, "0")}`;

interface Fx {
	at: number;
	pr?: number;
	/** Minutes from the request to `took the lock`; omitted: never locked. */
	lockAfter?: number;
	workers?: number | null;
	/** Minutes of the full part (prepare exit to `exec full` exit); omitted: no full part ran. */
	fullMin?: number;
	/** The result.json, merged over a green; null: no result.json. */
	result?: Record<string, unknown> | null;
	/** Minutes from the request to the run's final log line, for a never-locked run. */
	endAfter?: number;
	heartbeatMs?: number;
	source?: string;
}

/** One run dir under `root` shaped like the runner writes it; returns the run id. */
function run(root: string, fx: Fx): string {
	const id = makeRunId(fx.at, entropy());
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	const log: string[] = [];
	let t = fx.at;
	if (fx.lockAfter !== undefined) {
		t = fx.at + fx.lockAfter * MIN;
		log.push(`${iso(t)} took the lock`);
		log.push(`${iso(t + 1000)} /usr/local/libexec/as2test/exec sweep ${id} → exit 0`);
		if (fx.workers !== null) log.push(`${iso(t + 2000)} full workers ${fx.workers ?? 6}`);
		if (fx.fullMin !== undefined) {
			log.push(`${iso(t + 3000)} /usr/local/libexec/as2test/exec prepare ${id} ${"e".repeat(40)} → exit 0`);
			t = t + 3000 + fx.fullMin * MIN;
			log.push(`${iso(t)} /usr/local/libexec/as2test/exec full ${id} → exit 0`);
		}
	} else if (fx.endAfter !== undefined) {
		t = fx.at + fx.endAfter * MIN;
	}
	const verdict = fx.result === null ? null : String(fx.result?.verdict ?? "green");
	if (verdict !== null) log.push(`${iso(t + 1000)} test-run ${verdict}${fx.result?.reason ? `: ${fx.result.reason}` : ""}`);
	writeFileSync(join(dir, "runner.log"), log.length === 0 ? "" : `${log.join("\n")}\n`);
	if (fx.heartbeatMs !== undefined) writeFileSync(join(dir, "heartbeat"), heartbeatText(id, fx.heartbeatMs));
	if (fx.result !== null) {
		const ran = fx.fullMin !== undefined;
		const result = {
			runId: id, verdict: "green", sha: "e".repeat(40), pr: fx.pr ?? 1, reason: null,
			full: ran ? { pass: 10, fail: 0, skip: 0, exit: 0, ms: Math.round(fx.fullMin! * MIN), error: null } : null,
			solo: [], failures: [], runDir: dir,
			preflight: fx.lockAfter === undefined ? null : `install: _as2test 600:600, bun 1.3.14, source https://github.com/o/r.git at ${(fx.source ?? GOOD).slice(0, 12)}; probe: 23 paths unreachable as _as2test`,
			...fx.result,
		};
		writeFileSync(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	}
	return id;
}

// A real repo: root R, then MERGE on it, then GOOD on MERGE; OTHER is a sibling of MERGE on R (not a descendant).
let REPO = "";
let MERGE = "";
let GOOD = "";
let OTHER = "";
function git(...args: string[]): string {
	const r = Bun.spawnSync(["git", "-C", REPO, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}
beforeAll(() => {
	REPO = tmp("waits-repo");
	git("init", "-q", "-b", "main");
	git("commit", "-q", "--allow-empty", "-m", "root");
	const root = git("rev-parse", "HEAD");
	git("commit", "-q", "--allow-empty", "-m", "merge");
	MERGE = git("rev-parse", "HEAD");
	git("commit", "-q", "--allow-empty", "-m", "after");
	GOOD = git("rev-parse", "HEAD");
	git("checkout", "-q", "-b", "side", root);
	git("commit", "-q", "--allow-empty", "-m", "side");
	OTHER = git("rev-parse", "HEAD");
});

/** Ten executed, activated, error-free PR full parts, 30 minutes apart, each waiting 5 minutes. */
function qualifyingDay(): string {
	const root = tmp("waits-day");
	for (let i = 0; i < 10; i++) run(root, { at: T0 + i * 30 * MIN, pr: 100 + i, lockAfter: 5, fullMin: 4 });
	return root;
}
const gate = (root: string, nowMs = ENDED, workers = 6) =>
	qualifyFailures(dayRuns(root, DAY, nowMs), { day: DAY, nowMs, overMin: 30, workers, merge: MERGE, repo: REPO }).map((f) => f.name);

describe("per-run waits", () => {
	test("the request time is the run id's clock", () => {
		expect(requestMsOf(makeRunId(T0, "abcd"))).toBe(T0);
		expect(requestMsOf(makeRunId(T0 + 12_345, "zz99q"))).toBe(T0 + 12_345);
	});

	test("a locked run: wait to the lock, the logged worker count, prepare-to-full minutes, the install source, the verdict", () => {
		const root = tmp("waits-locked");
		const id = run(root, { at: T0, pr: 7, lockAfter: 42.5, workers: 6, fullMin: 3.5 });
		const r = readRun(root, id, ENDED);
		expect(r.state).toBe("done");
		expect(r.lockMs).toBe(T0 + 42.5 * MIN);
		expect(r.waitMin).toBeCloseTo(42.5, 6);
		expect(r.workers).toBe(6);
		expect(r.fullMin).toBeCloseTo(3.5, 6);
		expect(r.source).toBe(GOOD.slice(0, 12));
		expect([r.verdict, r.pr, r.reason]).toEqual(["green", 7, null]);
	});

	test("an error run carries its reason; with no full lines the duration falls back to result.full.ms", () => {
		const root = tmp("waits-reason");
		const id = run(root, { at: T0, lockAfter: 1, fullMin: 2, result: { verdict: "error", reason: "full: timeout" } });
		writeFileSync(join(root, id, "runner.log"), `${iso(T0 + MIN)} took the lock\n`);
		const r = readRun(root, id, ENDED);
		expect([r.verdict, r.reason]).toEqual(["error", "full: timeout"]);
		expect(r.fullMin).toBeCloseTo(2, 6);
	});

	test("a run that never took the lock waits until its last log line", () => {
		const root = tmp("waits-never");
		const id = run(root, { at: T0, endAfter: 61, result: { verdict: "error", reason: "queued too long", full: null } });
		const r = readRun(root, id, ENDED);
		expect([r.state, r.lockMs]).toEqual(["done", null]);
		expect(r.waitMin).toBeCloseTo(61 + 1 / 60, 6);
	});

	test("a run still queued (live heartbeat, no lock, no result) waits until now", () => {
		const root = tmp("waits-queued");
		const now = T0 + 95 * MIN;
		const id = run(root, { at: T0, result: null, heartbeatMs: now - 5_000 });
		const r = readRun(root, id, now);
		expect(r.state).toBe("queued");
		expect(r.waitMin).toBeCloseTo(95, 6);
		// the same run with its heartbeat gone quiet is dead, not queued: it waited until that heartbeat
		const dead = readRun(root, id, now + 10 * MIN);
		expect(dead.state).toBe("dead");
		expect(dead.waitMin).toBeCloseTo(95 - 5 / 60, 6);
	});

	test("the day is the America/Los_Angeles date of the request", () => {
		const root = tmp("waits-zone");
		const late = run(root, { at: Date.parse("2026-10-11T06:59:00.000Z"), lockAfter: 1, fullMin: 1 }); // 23:59 PDT 10-10
		run(root, { at: Date.parse("2026-10-11T07:00:00.000Z"), lockAfter: 1, fullMin: 1 }); // 00:00 PDT 10-11
		const early = run(root, { at: Date.parse("2026-10-10T07:00:00.000Z"), lockAfter: 1, fullMin: 1 }); // 00:00 PDT 10-10
		run(root, { at: Date.parse("2026-10-10T06:59:00.000Z"), lockAfter: 1, fullMin: 1 }); // 23:59 PDT 10-09
		mkdirSync(join(root, "base-cache"));
		expect(dayRuns(root, DAY, ENDED).map((r) => r.runId)).toEqual([early, late]);
	});
});

describe("suspects", () => {
	const red = (name: string) => ({ verdict: "red", failures: [{ part: "full", name, firstError: "error: x" }], full: { pass: 9, fail: 1, skip: 0, exit: 1, ms: MIN, error: null } });

	test("a test failing in red runs of two different PRs is a suspect; the same PR twice is not", () => {
		const root = tmp("waits-suspect");
		run(root, { at: T0, pr: 1, lockAfter: 1, fullMin: 1, result: red("a.test.ts > shared") });
		run(root, { at: T0 + 30 * MIN, pr: 2, lockAfter: 1, fullMin: 1, result: red("a.test.ts > shared") });
		run(root, { at: T0 + 60 * MIN, pr: 3, lockAfter: 1, fullMin: 1, result: red("b.test.ts > own") });
		run(root, { at: T0 + 90 * MIN, pr: 3, lockAfter: 1, fullMin: 1, result: red("b.test.ts > own") });
		expect(suspects(dayRuns(root, DAY, ENDED)).map((s) => [s.name, s.prs])).toEqual([["a.test.ts > shared", [1, 2]]]);
	});
});

describe("plain mode", () => {
	test("exits 1 when a wait passes --over (default 30), 0 when none does", () => {
		const root = tmp("waits-plain");
		run(root, { at: T0, lockAfter: 31, fullMin: 1 });
		run(root, { at: T0 + 60 * MIN, lockAfter: 2, fullMin: 1 });
		expect(waitsReport({ root, day: DAY, overMin: 30, nowMs: ENDED }).exit).toBe(1);
		expect(waitsReport({ root, day: DAY, overMin: 31.5, nowMs: ENDED }).exit).toBe(0);
	});

	test("the CLI prints every run with its wait and exits on the threshold", () => {
		const root = tmp("waits-cli");
		const slow = run(root, { at: T0, lockAfter: 149.6, fullMin: 1 });
		const quick = run(root, { at: T0 + 10 * MIN, lockAfter: 0.5, fullMin: 1 });
		const r = Bun.spawnSync([process.execPath, SCRIPT, "--day", DAY, "--root", root], { stdout: "pipe", stderr: "pipe" });
		const out = r.stdout.toString();
		expect(r.exitCode).toBe(1);
		expect(out).toMatch(new RegExp(`${slow}.* 149\\.6 `));
		expect(out).toMatch(new RegExp(`${quick}.* 0\\.5 `));
		expect(out).toContain(`max wait 149.6 min (${slow})`);
		const under = Bun.spawnSync([process.execPath, SCRIPT, "--day", DAY, "--root", root, "--over", "150"], { stdout: "pipe", stderr: "pipe" });
		expect(under.exitCode).toBe(0);
	});

	test("the CLI refuses a bad day and qualify flags without --qualify (exit 2)", () => {
		const root = tmp("waits-args");
		for (const argv of [["--day", "10/10/2026"], ["--day", DAY, "--workers", "6"], ["--day", DAY, "--qualify", "--workers", "0", "--merge", "a".repeat(40), "--repo", root]]) {
			const r = Bun.spawnSync([process.execPath, SCRIPT, ...argv, "--root", root], { stdout: "pipe", stderr: "pipe" });
			expect(r.exitCode).toBe(2);
		}
	});
});

describe("--qualify", () => {
	test("a qualifying day passes, through the CLI", () => {
		const root = qualifyingDay();
		expect(gate(root)).toEqual([]);
		const r = Bun.spawnSync([process.execPath, SCRIPT, "--day", DAY, "--root", root, "--qualify", "--workers", "6", "--merge", MERGE, "--repo", REPO], { stdout: "pipe", stderr: "pipe" });
		expect(r.stdout.toString()).toContain("qualify: pass");
		expect(r.exitCode).toBe(0);
	});

	test("a day not yet ended fails day-ended", () => {
		expect(gate(qualifyingDay(), Date.parse("2026-10-11T06:00:00.000Z"))).toEqual(["day-ended"]);
	});

	test("nine executed full parts are too few", () => {
		const root = tmp("waits-few");
		for (let i = 0; i < 9; i++) run(root, { at: T0 + i * 30 * MIN, pr: 100 + i, lockAfter: 5, fullMin: 4 });
		expect(gate(root)).toEqual(["executed-runs"]);
	});

	test("ten terminal pre-lock failures with no full part fail", () => {
		const root = tmp("waits-prelock");
		for (let i = 0; i < 10; i++) run(root, { at: T0 + i * 30 * MIN, pr: 100 + i, endAfter: 5, result: { verdict: "error", reason: "the PR is closed", full: null } });
		expect(gate(root)).toEqual(["executed-runs"]);
	});

	test("a run still queued fails all-terminal", () => {
		const root = qualifyingDay();
		const now = T0 + 20 * 60 * MIN; // 06:00 PDT the next day
		run(root, { at: T0 + 12 * 60 * MIN, result: null, heartbeatMs: now - 1000 }); // 22:00 PDT
		expect(gate(root, now)).toEqual(["all-terminal", "waits"]);
	});

	test("a wait over 30 fails waits", () => {
		const root = qualifyingDay();
		run(root, { at: T0 + 400 * MIN, pr: 200, lockAfter: 30.5, fullMin: 4 });
		expect(gate(root)).toEqual(["waits"]);
	});

	test("a timeout full part fails full-part-errors", () => {
		const root = qualifyingDay();
		run(root, { at: T0 + 400 * MIN, lockAfter: 1, fullMin: 20, result: { verdict: "error", reason: "full: timeout", full: { pass: 0, fail: 0, skip: 0, exit: 124, ms: 20 * MIN, error: "timeout" } } });
		expect(gate(root)).toEqual(["full-part-errors"]);
	});

	test("a non-timeout full-part error (exit with no failing test) fails full-part-errors", () => {
		const root = qualifyingDay();
		run(root, { at: T0 + 400 * MIN, lockAfter: 1, fullMin: 4, result: { verdict: "error", reason: "full: exit 1 with no failing test", full: { pass: 10, fail: 0, skip: 0, exit: 1, ms: 4 * MIN, error: "exit 1 with no failing test" } } });
		expect(gate(root)).toEqual(["full-part-errors"]);
	});

	test("a lock-holding run with no result fails missing-result", () => {
		const root = qualifyingDay();
		run(root, { at: T0 + 400 * MIN, lockAfter: 1, fullMin: 4, result: null });
		expect(gate(root)).toEqual(["missing-result"]);
	});

	test("a lock-holding run with the wrong worker count fails full-workers", () => {
		const root = qualifyingDay();
		run(root, { at: T0 + 400 * MIN, lockAfter: 1, fullMin: 4, workers: 1 });
		expect(gate(root)).toEqual(["full-workers"]);
		// every run at the wrong count: none of them counts as an executed run either
		expect(gate(qualifyingDay(), ENDED, 4)).toEqual(["executed-runs", "full-workers"]);
	});

	test("a lock-holding run that never logged its worker count fails full-workers", () => {
		const root = qualifyingDay();
		run(root, { at: T0 + 400 * MIN, lockAfter: 1, fullMin: 4, workers: null });
		expect(gate(root)).toEqual(["full-workers"]);
	});

	test("an install source that does not descend from the merge fails merged-source", () => {
		const root = qualifyingDay();
		run(root, { at: T0 + 400 * MIN, lockAfter: 1, fullMin: 4, source: OTHER });
		expect(gate(root)).toEqual(["merged-source"]);
	});

	test("a cross-PR suspect fails suspects", () => {
		const root = qualifyingDay();
		const red = { verdict: "red", failures: [{ part: "full", name: "a.test.ts > shared", firstError: "error: x" }], full: { pass: 9, fail: 1, skip: 0, exit: 1, ms: 4 * MIN, error: null } };
		run(root, { at: T0 + 400 * MIN, pr: 300, lockAfter: 1, fullMin: 4, result: red });
		run(root, { at: T0 + 430 * MIN, pr: 301, lockAfter: 1, fullMin: 4, result: red });
		expect(gate(root)).toEqual(["suspects"]);
	});

	test("the CLI prints each failing condition by name and exits 1", () => {
		const root = tmp("waits-cli-fail");
		for (let i = 0; i < 8; i++) run(root, { at: T0 + i * 30 * MIN, pr: 100 + i, lockAfter: 5, fullMin: 4 });
		run(root, { at: T0 + 400 * MIN, lockAfter: 45, fullMin: 4, source: OTHER });
		const r = Bun.spawnSync([process.execPath, SCRIPT, "--day", DAY, "--root", root, "--qualify", "--workers", "6", "--merge", MERGE, "--repo", REPO], { stdout: "pipe", stderr: "pipe" });
		const out = r.stdout.toString();
		expect(r.exitCode).toBe(1);
		for (const name of ["executed-runs", "merged-source", "waits"]) expect(out).toMatch(new RegExp(`^FAIL ${name}: `, "m"));
		expect(out).toContain("qualify: fail (executed-runs, merged-source, waits)");
	});
});
