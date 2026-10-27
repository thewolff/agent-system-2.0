// The stuck-worker field report (PLAN wl-mvq8x4pkjmx69s D5): the CONTRACT.md line forms parsed, then one fixture root of
// run dirs (runner.log with the executor's echoed stuck-* lines and the runner's own lines, result.json) read into every
// category: cleared-before-match, no decision, decisions with each outcome (recovered, part-ended, capped with minutes to
// the cap, stopped), post-signature slot time and next-start with worst and p95, unmatched wall-cap timeouts,
// executor-stalled, containment-failed, admission-refused and lock-release-failed runs, detector-off parts and runs, Bun versions, each total
// with its denominator; one incident per (run, part, worker, zombie) when the shadow capture clears and re-signs the same
// pair; an interval with no decision; the --since/--until interval; the CLI run for real.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fieldReport, NO_DECISION, nearestRank, parseArgs, parseRun, parseRunnerLine, parseStuckLine, readRuns, renderReport, summarize } from "../scripts/stuck-report";
import { makeRunId } from "../src/test-run";
import { tmp } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "stuck-report.ts");
const EXEC = "/usr/local/libexec/as2test/exec";
/** 10:00 PDT on 2026-10-10. */
const T0 = Date.parse("2026-10-10T17:00:00.000Z");
const S = 1000;
const MIN = 60 * S;
const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 0;
const newId = (at: number): string => makeRunId(at, `b${(++seq).toString(36).padStart(4, "0")}`);

// The executor's stdout lines (CONTRACT.md), as the runner echoes them into runner.log.
const sig = (at: number, part: string, w: number, z: number, mode = "shadow") => `stuck-signature ${iso(at)} part ${part} worker ${w} zombie ${z} since ${at - 500} mode ${mode} bun 1.3.14 abc1234`;
const cleared = (at: number, part: string, w: number, z: number, held: number, matched: "yes" | "no") => `stuck-cleared ${iso(at)} part ${part} worker ${w} zombie ${z} held ${held} matched ${matched}`;
const decide = (kind: "would-stop" | "stop", at: number, part: string, w: number, z: number) => `stuck-${kind} ${iso(at)} part ${part} worker ${w} zombie ${z}`;
const captured = (at: number, part: string) => `stuck-captured ${iso(at)} part ${part} file ${part}.signature.log ms 2100`;

/** One wrapper call as test-runner.ts `wrap` logs it: started, the exec's stderr and echoed stdout, the ending. */
function call(id: string, sub: "full" | "solo" | "base-solo", file: string | null, start: number, end: number, inner: string[], ending = "exit 0"): string[] {
	const argv = `${EXEC} ${sub} ${id}${file ? ` ${file}` : ""}`;
	return [`${iso(start)} ${argv}: started pid 4242`, ...inner, `${iso(end)} ${argv} → ${ending}`];
}

const preflight = (bun: string) => `install: _as2test 600:600, bun ${bun}, source https://github.com/o/r.git at 0123456789ab; probe: 23 paths unreachable as _as2test`;

/** One run dir: runner.log from `lines`, result.json merged over a green unless `result` is null. */
function write(root: string, id: string, lines: string[], result: Record<string, unknown> | null = {}): void {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "runner.log"), `${lines.join("\n")}\n`);
	if (result === null) return;
	const body = { runId: id, verdict: "green", sha: "e".repeat(40), pr: 1, reason: null, full: null, solo: [], failures: [], runDir: dir, preflight: preflight("1.3.14"), ...result };
	writeFileSync(join(dir, "result.json"), `${JSON.stringify(body, null, 2)}\n`);
}

interface World {
	root: string;
	ids: Record<string, string>;
}

/** Nine runs, ten minutes apart, one per category. */
function world(): World {
	const root = tmp("stuck-report");
	const ids: Record<string, string> = {};
	const lock = (t: number) => `${iso(t)} took the lock`;
	const released = (t: number) => `${iso(t)} lock released`;

	// recovered + cleared-before-match: A breaks after 2 s; B is decided at +25 s and clears at +40 s; released at +70 s.
	let t = T0;
	let id = (ids.recovered = newId(t));
	write(root, id, [
		lock(t + S),
		...call(id, "full", null, t + 2 * S, t + 60 * S, [
			sig(t + 10 * S, "full", 101, 201), cleared(t + 12 * S, "full", 101, 201, 2000, "no"),
			sig(t + 20 * S, "full", 102, 202), decide("would-stop", t + 25 * S, "full", 102, 202), captured(t + 28 * S, "full"),
			cleared(t + 40 * S, "full", 102, 202, 20000, "yes"),
		]),
		released(t + 70 * S),
	]);

	// part-ended: decided at +15 s, the part exits 0 at +30 s, released at +40 s.
	t = T0 + 10 * MIN;
	id = ids.partEnded = newId(t);
	write(root, id, [lock(t + S), ...call(id, "full", null, t + 2 * S, t + 30 * S, [sig(t + 10 * S, "full", 103, 203), decide("would-stop", t + 15 * S, "full", 103, 203)]), released(t + 40 * S)]);

	// capped: a solo part started at +100 s with a 10 min cap, decided at +190 s (8.5 min before the cap), exit 124 at +703 s.
	t = T0 + 20 * MIN;
	id = ids.capped = newId(t);
	write(root, id, [
		lock(t + S),
		...call(id, "full", null, t + 2 * S, t + 90 * S, [], "exit 1"),
		...call(id, "solo", "./a.test.ts", t + 100 * S, t + 703 * S, [
			"as2test: timeout: the part passed its cap of 600000 ms; its group was killed",
			"part solo-1", sig(t + 185 * S, "solo-1", 106, 206), decide("would-stop", t + 190 * S, "solo-1", 106, 206),
		], "exit 124"),
		released(t + 720 * S),
	], { verdict: "red" });

	// stopped (enforce), with the next run requested while it held the lock.
	t = T0 + 40 * MIN;
	id = ids.stopped = newId(t);
	write(root, id, [
		lock(t + S),
		...call(id, "full", null, t + 2 * S, t + 20 * S, [
			sig(t + 10 * S, "full", 104, 204, "enforce"), decide("stop", t + 15 * S, "full", 104, 204), captured(t + 17 * S, "full"),
			`stuck-killed ${iso(t + 19 * S)} part full pgids 4243,4250 ms 1600 contained`,
		], "exit 125"),
		released(t + 30 * S),
	], { verdict: "error", reason: "full: stuck: worker 104 spun 5000 ms in Bun.spawnSync with unreaped child 204; 2 process groups killed, containment contained" });

	// the waiting run: requested 5 s after the stopped run, took the lock 2 s after its release; one malformed and one orphan line.
	id = ids.waiting = newId(t + 5 * S);
	write(root, id, [
		lock(t + 32 * S),
		...call(id, "full", null, t + 33 * S, t + 50 * S, [`stuck-stop ${iso(t + 40 * S)} part full worker x`, cleared(t + 41 * S, "full", 9, 9, 100, "no")]),
		released(t + 60 * S),
	], { preflight: preflight("1.3.15") });

	// an unmatched wall-cap timeout (full, after the outlive sweep) and a base-solo part with the detector off.
	t = T0 + 50 * MIN;
	id = ids.unmatched = newId(t);
	write(root, id, [
		lock(t + S),
		...call(id, "full", null, t + 2 * S, t + 80 * S, [], "exit 124 (after the outlive sweep)"),
		...call(id, "base-solo", "./b.test.ts", t + 90 * S, t + 95 * S, ["part base-solo-1", `stuck-detector-off ${iso(t + 91 * S)} part base-solo-1 reason sysctl unavailable`]),
		released(t + 100 * S),
	], { verdict: "error", reason: "full: timeout" });

	// executor stalled: an enforce candidate with no decision, the call abandoned by the backstop.
	t = T0 + 60 * MIN;
	id = ids.stalled = newId(t);
	write(root, id, [
		lock(t + S),
		...call(id, "full", null, t + 2 * S, t + 27 * S, [sig(t + 10 * S, "full", 105, 205, "enforce")], "exit null (abandoned by the stuck backstop)"),
		`${iso(t + 27 * S)} executor-stalled part full worker 105`,
		released(t + 40 * S),
	], { verdict: "error", reason: "full: executor stalled during stuck detection; worker 105 was a candidate, not confirmed" });

	// containment failed: known from the runner line alone.
	t = T0 + 70 * MIN;
	id = ids.contain = newId(t);
	write(root, id, [lock(t + S), ...call(id, "full", null, t + 2 * S, t + 20 * S, [], "exit 125"), `${iso(t + 90 * S)} stuck-containment-failed part full pids 900,901`, released(t + 91 * S)], {
		verdict: "error", reason: "full: stuck: executor did not finish the stop",
	});

	// admission refused: no part, no preflight in the result.
	t = T0 + 80 * MIN;
	id = ids.refused = newId(t);
	write(root, id, [lock(t + S), `${iso(t + 35 * S)} admission refused: live _as2test processes 900`, released(t + 36 * S)], {
		verdict: "error", reason: "admission refused: live _as2test processes 900", preflight: null,
	});
	return { root, ids };
}

describe("line forms", () => {
	test("each stuck-* line parses, anywhere in a line; a stuck keyword in another form is malformed", () => {
		const at = T0;
		expect(parseStuckLine(sig(at, "full", 1, 2, "enforce"))).toEqual({ kind: "signature", at, part: "full", worker: 1, zombie: 2, since: at - 500, mode: "enforce", bun: "1.3.14", revision: "abc1234" });
		expect(parseStuckLine(`${iso(at)} ${cleared(at, "solo-2", 1, 2, 4100, "no")}`)).toEqual({ kind: "cleared", at, part: "solo-2", worker: 1, zombie: 2, heldMs: 4100, matched: false });
		expect(parseStuckLine(decide("would-stop", at, "full", 1, 2))).toEqual({ kind: "would-stop", at, part: "full", worker: 1, zombie: 2 });
		expect(parseStuckLine(decide("stop", at, "full", 1, 2))).toEqual({ kind: "stop", at, part: "full", worker: 1, zombie: 2 });
		expect(parseStuckLine(captured(at, "full"))).toEqual({ kind: "captured", at, part: "full", file: "full.signature.log", ms: 2100 });
		expect(parseStuckLine(`stuck-killed ${iso(at)} part full pgids 7,8 ms 900 unconfirmed 7,9`)).toEqual({ kind: "killed", at, part: "full", pgids: ["7", "8"], ms: 900, contained: false, unconfirmed: "7,9" });
		expect(parseStuckLine(`stuck-detector-off ${iso(at)} part full reason not darwin`)).toEqual({ kind: "detector-off", at, part: "full", reason: "not darwin" });
		expect(parseStuckLine(`stuck-stop ${iso(at)} part full worker x`)).toBe("malformed");
		expect(parseStuckLine(`stuck-signature yesterday part full`)).toBe("malformed");
		expect(parseStuckLine(`${iso(at)} stuck-containment-failed part full pids 1`)).toBeNull();
		expect(parseStuckLine(`${iso(at)} test-run error: full: stuck: worker 1`)).toBeNull();
	});

	test("the runner's own lines parse; a test-run line naming admission refused is not the admission line", () => {
		const at = T0;
		expect(parseRunnerLine(`${iso(at)} took the lock from the stale holder tr-x`)).toEqual({ kind: "lock", at });
		expect(parseRunnerLine(`${iso(at)} lock released`)).toEqual({ kind: "released", at });
		expect(parseRunnerLine(`${iso(at)} stuck-containment-failed part full pids denied`)).toEqual({ kind: "containment-failed", at, part: "full", pids: "denied" });
		expect(parseRunnerLine(`${iso(at)} executor-stalled part solo-1 worker 77`)).toEqual({ kind: "executor-stalled", at, part: "solo-1", worker: 77 });
		expect(parseRunnerLine(`${iso(at)} admission refused: inspection denied`)).toEqual({ kind: "admission-refused", at, why: "inspection denied" });
		expect(parseRunnerLine(`${iso(at)} test-run error: admission refused: inspection denied`)).toBeNull();
		expect(parseRunnerLine(`${iso(at)} ${EXEC} solo tr-abc123456789 ./a.test.ts: started pid 9`)).toEqual({ kind: "call-start", at, sub: "solo", file: "./a.test.ts" });
		expect(parseRunnerLine(`${iso(at)} ${EXEC} full tr-abc123456789 → exit 124 (after the outlive sweep)`)).toEqual({ kind: "call-end", at, sub: "full", file: null, ending: "exit 124", code: 124, outlived: true });
		expect(parseRunnerLine(`${iso(at)} ${EXEC} full tr-abc123456789 → SIGKILL`)).toEqual({ kind: "call-end", at, sub: "full", file: null, ending: "SIGKILL", code: null, outlived: false });
		expect(parseRunnerLine(`${iso(at)} ${EXEC} full tr-abc123456789 → exit null (abandoned by the stuck backstop)`)).toEqual({ kind: "call-end", at, sub: "full", file: null, ending: "exit null (abandoned)", code: null, outlived: false });
		expect(parseRunnerLine(`${iso(at)} ${EXEC} sweep tr-abc123456789 → exit 0`)).toBeNull();
		expect(parseRunnerLine("part base-solo-3")).toEqual({ kind: "part", stem: "base-solo-3" });
	});

	test("p95 is the nearest rank", () => {
		const twenty = Array.from({ length: 20 }, (_, i) => 20 - i);
		expect(nearestRank(twenty, 95)).toBe(19);
		expect(nearestRank([...twenty, 21], 95)).toBe(20);
		expect(nearestRank([5], 95)).toBe(5);
		expect(nearestRank([], 95)).toBeNull();
	});
});

describe("the fixture root", () => {
	const w = world();
	const all = readRuns(w.root);
	const s = summarize(all);
	const text = renderReport(s, { root: w.root, since: null, until: null });
	const outcome = (runId: string) => s.episodes.filter((e) => e.episode.runId === runId).map((e) => e.outcome);
	const decision = (runId: string) => s.decisions.find((r) => r.episode.runId === runId)!;

	test("every signature lands in its category", () => {
		expect(outcome(w.ids.recovered!)).toEqual(["cleared-before-match", "recovered"]);
		expect(outcome(w.ids.partEnded!)).toEqual(["part-ended"]);
		expect(outcome(w.ids.capped!)).toEqual(["capped"]);
		expect(outcome(w.ids.stopped!)).toEqual(["stopped"]);
		expect(outcome(w.ids.stalled!)).toEqual(["no-decision"]);
		expect(s.decisions).toHaveLength(4);
		expect(decision(w.ids.capped!).toCapMin).toBeCloseTo(8.5, 9);
		expect(decision(w.ids.stopped!).episode.killed).toEqual({ contained: true, unconfirmed: null });
	});

	test("slot time is lock released minus first signature; next-start only when a run was waiting", () => {
		expect([w.ids.recovered, w.ids.partEnded, w.ids.capped, w.ids.stopped].map((id) => decision(id!).slotMs)).toEqual([50 * S, 30 * S, 535 * S, 20 * S]);
		expect(decision(w.ids.stopped!)).toMatchObject({ nextStartMs: 22 * S, nextRun: w.ids.waiting });
		for (const id of [w.ids.recovered, w.ids.partEnded, w.ids.capped]) expect(decision(id!).nextStartMs).toBeNull();
	});

	test("the run-level counts and the unread lines", () => {
		expect(s.unmatchedCaps).toEqual([{ runId: w.ids.unmatched!, part: "full" }]);
		expect([s.executorStalled, s.containmentFailed, s.admissionRefused]).toEqual([[w.ids.stalled!], [w.ids.contain!], [w.ids.refused!]]);
		expect([s.malformed, s.orphans]).toEqual([1, 1]);
	});

	// Review r2 finding 2: a release that ended with the row still held is a run count (`the lock was not released`, test-runner.ts `release`).
	test("lock release failed: runs whose runner.log has `the lock was not released`, once a run, among the run counts", () => {
		const root = tmp("stuck-report-release");
		const t = T0 + 200 * MIN;
		const failed = newId(t);
		const retried = newId(t + 10 * MIN);
		const clean = newId(t + 20 * MIN);
		const busy = "database is locked";
		write(root, failed, [
			`${iso(t + S)} took the lock`,
			`${iso(t + 30 * S)} the lock release failed: ${busy}; retrying until ${iso(t + 75 * S)}`,
			`${iso(t + 76 * S)} the lock was not released: ${busy} (1200 attempts; the row's heartbeatAt ${iso(t + 15 * S)} is stale for a waiter since ${iso(t + 75 * S)}); the row holds this run until a waiter takes it`,
			`${iso(t + 77 * S)} the lock was not released: ${busy} (1201 attempts; the row's heartbeatAt ${iso(t + 15 * S)} is stale for a waiter since ${iso(t + 75 * S)}); the row holds this run until a waiter takes it`,
		]);
		write(root, retried, [`${iso(t + 10 * MIN + S)} took the lock`, `${iso(t + 10 * MIN + 30 * S)} the lock release failed: ${busy}; retrying until ${iso(t + 11 * MIN)}`, `${iso(t + 10 * MIN + 34 * S)} lock released`]);
		write(root, clean, [`${iso(t + 20 * MIN + S)} took the lock`, `${iso(t + 20 * MIN + 30 * S)} lock released`]);
		expect(parseRunnerLine(`${iso(t)} the lock was not released: ${busy} (3 attempts)`)).toEqual({ kind: "release-failed", at: t });
		expect(parseRunnerLine(`${iso(t)} the lock release failed: ${busy}; retrying until ${iso(t)}`)).toBeNull();
		const r = summarize(readRuns(root));
		expect(r.releaseFailed).toEqual([failed]);
		expect(r.runs.find((x) => x.runId === retried)!.releasedAt).toBe(t + 10 * MIN + 34 * S);
		const report = renderReport(r, { root, since: null, until: null });
		expect(report).toContain("- lock release failed: 1 of 3 runs");
		expect(report.indexOf("- lock release failed: 1 of 3 runs")).toBe(report.indexOf("- admission-refused runs: 0 of 3 runs") + 1);
		expect(text).toContain("- lock release failed: 0 of 9 runs");
		rmSync(root, { recursive: true, force: true });
	});

	test("the report states every category with its denominator", () => {
		for (const line of [
			"- parts: 10 (full 8, solo 1, base-solo 1, no call line 0)",
			"- detector off: 1 of 10 parts; runs with the detector off: 1 of 9 runs",
			"- signatures (candidates): 6 (incidents by run, part, worker, zombie; 0 re-signatures folded in)",
			"  - cleared-before-match: 1 of 6 signatures",
			"  - no decision and not cleared: 1 of 6 signatures",
			"  - decisions: 4 of 6 signatures (would-stop 3, stop 1)",
			"- false positives: 2 of 4 decisions (recovered 1, part-ended 1)",
			"- capped (unrecovered, unassessed until the capture is read): 1 of 4 decisions",
			"- stopped: 1 of 4 decisions (contained 1, unconfirmed 0)",
			"- undetermined (no end of the part in the log): 0 of 4 decisions",
			"- wall-cap timeouts with no decision (unmatched): 1 of 2 capped parts",
			"- executor-stalled runs: 1 of 9 runs",
			"- containment-failed runs: 1 of 9 runs",
			"- admission-refused runs: 1 of 9 runs",
			"- Bun versions (runs): 1.3.14 7, 1.3.15 1, unknown 1 (of 9 runs)",
			"- Bun versions (signatures): 1.3.14 abc1234 6 (of 6 signatures)",
			"- unread stuck lines: 1 not in the pinned form, 1 with no signature before them",
		]) expect(text).toContain(line);
	});

	test("worst and p95 over the decisions that have the times", () => {
		expect(text).toContain(`- lock released − first signature: worst 535.0 s (${w.ids.capped} solo-1), p95 535.0 s, over 4 of 4 decisions`);
		expect(text).toContain(`- next run took the lock − first signature (a run was waiting): worst 22.0 s (${w.ids.stopped} full), p95 22.0 s, over 1 of 4 decisions`);
		expect(text).toContain(`- decision → cap (would-save): 8.5 min (${w.ids.capped} solo-1)`);
		expect(text).not.toContain(NO_DECISION);
	});

	test("the signature and part tables", () => {
		expect(text).toContain(`| ${w.ids.capped} | solo-1 | shadow | 106 | 206 | ${iso(T0 + 20 * MIN + 185 * S)} | capped | 8.5 min | 535.0 s | - | 1.3.14 abc1234 |`);
		expect(text).toContain(`| ${w.ids.stopped} | full | enforce | 104 | 204 | ${iso(T0 + 40 * MIN + 10 * S)} | stopped | - | 20.0 s | 22.0 s (${w.ids.waiting}) | 1.3.14 abc1234 |`);
		expect(text).toContain(`| ${w.ids.unmatched} | full | - | exit 124 (cap) | on |`);
		expect(text).toContain(`| ${w.ids.unmatched} | base-solo-1 | ./b.test.ts | exit 0 | off: sysctl unavailable |`);
		expect(text).toContain(`| ${w.ids.stalled} | full | - | exit null (abandoned) | on |`);
	});

	test("a slot p95 below the worst: the nearest rank over the decisions' slot times", () => {
		// 20 decisions with slots 1..20 s: worst 20 s, p95 19 s.
		const runs = Array.from({ length: 20 }, (_, i) => {
			const at = T0 + i * 10 * MIN;
			const id = newId(at);
			const log = [`${iso(at + S)} took the lock`, ...call(id, "full", null, at + 2 * S, at + 30 * S, [sig(at + 5 * S, "full", 1, 2), decide("would-stop", at + 6 * S, "full", 1, 2)]), `${iso(at + (6 + i) * S)} lock released`];
			return parseRun(id, log.join("\n"), null);
		});
		const lines = renderReport(summarize(runs), { root: "/r", since: null, until: null });
		expect(lines).toContain(`- lock released − first signature: worst 20.0 s (${runs[19]!.runId} full), p95 19.0 s, over 20 of 20 decisions`);
		expect(lines).toContain("- false positives: 20 of 20 decisions (recovered 0, part-ended 20)");
	});
});

describe("one incident per (run, part, worker, zombie)", () => {
	// The executor's shadow sequence: the capture's own `sample <W> 1` drops the worker under the hot share for a tick, so
	// the same pair clears during the capture and signs again, with a second would-stop.
	const shadowCapture = (t: number): string[] => [
		sig(t + 10 * S, "solo-1", 301, 401), decide("would-stop", t + 15 * S, "solo-1", 301, 401),
		cleared(t + 16 * S, "solo-1", 301, 401, 2276, "yes"), captured(t + 18 * S, "solo-1"),
		sig(t + 19 * S, "solo-1", 301, 401), decide("would-stop", t + 24 * S, "solo-1", 301, 401),
	];
	const run = (t: number, inner: string[], end: number, ending: string) => {
		const id = newId(t);
		const log = [`${iso(t + S)} took the lock`, ...call(id, "solo", "./a.test.ts", t + 2 * S, end, inner, ending), `${iso(end + 8 * S)} lock released`];
		return parseRun(id, log.join("\n"), null);
	};

	test("a clear during the capture, a re-signature and the part's cap: one decision, capped, no false positive", () => {
		const t = T0;
		const r = run(t, ["as2test: timeout: the part passed its cap of 60000 ms; its group was killed", "part solo-1", ...shadowCapture(t)], t + 62 * S, "exit 124");
		const s = summarize([r]);
		expect(s.episodes.map((e) => e.outcome)).toEqual(["capped"]);
		expect(s.episodes[0]!.episode).toMatchObject({ firstAt: t + 10 * S, signatures: 2, decision: { kind: "would-stop", at: t + 15 * S }, cleared: null, captured: true });
		expect(s.decisions).toHaveLength(1);
		expect(s.decisions[0]!.toCapMin).toBeCloseTo(47 / 60, 9);
		expect(s.decisions[0]!.slotMs).toBe(60 * S);
		const lines = renderReport(s, { root: "/r", since: null, until: null });
		for (const line of [
			"- signatures (candidates): 1 (incidents by run, part, worker, zombie; 1 re-signatures folded in)",
			"  - cleared-before-match: 0 of 1 signatures",
			"  - decisions: 1 of 1 signatures (would-stop 1, stop 0)",
			"- false positives: 0 of 1 decisions (recovered 0, part-ended 0)",
			"- capped (unrecovered, unassessed until the capture is read): 1 of 1 decisions",
			"- wall-cap timeouts with no decision (unmatched): 0 of 1 capped parts",
		]) expect(lines).toContain(line);
	});

	test("the same sequence, then a final clear while the part runs on: recovered, one false positive", () => {
		const t = T0 + 10 * MIN;
		const r = run(t, ["part solo-1", ...shadowCapture(t), cleared(t + 30 * S, "solo-1", 301, 401, 11000, "yes")], t + 90 * S, "exit 0");
		const s = summarize([r]);
		expect(s.episodes.map((e) => e.outcome)).toEqual(["recovered"]);
		expect(s.episodes[0]!.episode).toMatchObject({ signatures: 2, decision: { kind: "would-stop", at: t + 15 * S }, cleared: { at: t + 30 * S, heldMs: 11000, matched: true } });
		const lines = renderReport(s, { root: "/r", since: null, until: null });
		for (const line of [
			"- signatures (candidates): 1 (incidents by run, part, worker, zombie; 1 re-signatures folded in)",
			"  - decisions: 1 of 1 signatures (would-stop 1, stop 0)",
			"- false positives: 1 of 1 decisions (recovered 1, part-ended 0)",
			"- capped (unrecovered, unassessed until the capture is read): 0 of 1 decisions",
		]) expect(lines).toContain(line);
	});
});

describe("intervals", () => {
	test("an interval with no decision says there is no latency evidence", () => {
		const root = tmp("stuck-report-quiet");
		const id = newId(T0);
		write(root, id, [`${iso(T0 + S)} took the lock`, ...call(id, "full", null, T0 + 2 * S, T0 + 30 * S, [sig(T0 + 5 * S, "full", 1, 2), cleared(T0 + 7 * S, "full", 1, 2, 2000, "no")]), `${iso(T0 + 40 * S)} lock released`]);
		const text = fieldReport({ root, since: null, until: null });
		expect(text).toContain(`## Post-signature slot time\n\n${NO_DECISION}\n`);
		expect(text).toContain("  - decisions: 0 of 1 signatures (would-stop 0, stop 0)");
		expect(text).toContain("- false positives: 0 of 0 decisions (recovered 0, part-ended 0)");
		expect(text).toContain("- wall-cap timeouts with no decision (unmatched): 0 of 0 capped parts");
	});

	describe("unreadable evidence is reported, never read as no hang", () => {
		const INCOMPLETE = "evidence incomplete: 1 of 2 runs unreadable; no hang observed in the readable runs";
		/** A readable quiet run plus one run the caller damages. */
		function twoRuns(name: string): { root: string; good: string; bad: string } {
			const root = tmp(name);
			const good = newId(T0);
			const bad = newId(T0 + 5 * MIN);
			write(root, good, [`${iso(T0 + S)} took the lock`, `${iso(T0 + 40 * S)} lock released`]);
			write(root, bad, [`${iso(T0 + 5 * MIN + S)} took the lock`, `${iso(T0 + 5 * MIN + 40 * S)} lock released`]);
			return { root, good, bad };
		}

		test("every run readable: no section, a zero totals line, the plain wording", () => {
			const { root } = twoRuns("stuck-report-readable");
			const text = fieldReport({ root, since: null, until: null });
			expect(text).toContain("- runs with unreadable evidence: 0 of 2 runs");
			expect(text).not.toContain("## Input problems");
			expect(text).toContain(`## Post-signature slot time\n\n${NO_DECISION}\n`);
		});

		test("a missing runner.log", () => {
			const { root, bad } = twoRuns("stuck-report-no-log");
			rmSync(join(root, bad, "runner.log"));
			const text = fieldReport({ root, since: null, until: null });
			expect(text).toContain(`## Input problems\n\n- ${bad} runner.log: missing\n`);
			expect(text).toContain("- runs with unreadable evidence: 1 of 2 runs");
			expect(text).toContain(`## Post-signature slot time\n\n${INCOMPLETE}\n`);
			expect(text).not.toContain(NO_DECISION);
		});

		test.skipIf(process.getuid?.() === 0)("an unreadable runner.log names the error", () => {
			const { root, bad } = twoRuns("stuck-report-chmod-log");
			const path = join(root, bad, "runner.log");
			chmodSync(path, 0o000);
			try {
				const text = fieldReport({ root, since: null, until: null });
				expect(text).toMatch(new RegExp(`- ${bad} runner\\.log: unreadable \\(.*EACCES.*\\)`));
				expect(text).toContain("- runs with unreadable evidence: 1 of 2 runs");
				expect(text).toContain(`## Post-signature slot time\n\n${INCOMPLETE}\n`);
			} finally {
				chmodSync(path, 0o644);
			}
		});

		test("a malformed result.json", () => {
			const { root, bad } = twoRuns("stuck-report-bad-result");
			writeFileSync(join(root, bad, "result.json"), "{not json");
			const text = fieldReport({ root, since: null, until: null });
			expect(text).toMatch(new RegExp(`## Input problems\\n\\n- ${bad} result\\.json: result\\.json unreadable \\(`));
			expect(text).toContain("- runs with unreadable evidence: 1 of 2 runs");
			expect(text).toContain(`## Post-signature slot time\n\n${INCOMPLETE}\n`);
		});

		test("a missing result.json", () => {
			const { root, bad } = twoRuns("stuck-report-no-result");
			rmSync(join(root, bad, "result.json"));
			const text = fieldReport({ root, since: null, until: null });
			expect(text).toContain(`- ${bad} result.json: no result.json\n`);
			expect(text).toContain(`## Post-signature slot time\n\n${INCOMPLETE}\n`);
		});

		test("the CLI still exits 0 and warns on stderr", () => {
			const { root, bad } = twoRuns("stuck-report-cli-warn");
			rmSync(join(root, bad, "runner.log"));
			const r = Bun.spawnSync([process.execPath, SCRIPT, "--root", root], { stdout: "pipe", stderr: "pipe" });
			expect(r.exitCode).toBe(0);
			expect(r.stdout.toString()).toContain("## Input problems");
			expect(r.stderr.toString()).toContain("warning: 1 of 2 runs have unreadable evidence");
		});
	});

	test("--since and --until keep runs requested on those PT days; the waiting run may fall outside", () => {
		const root = tmp("stuck-report-days");
		// 23:59:50 PDT on 10-10: a stopped run; the run waiting behind it is requested at 00:00:05 PDT on 10-11.
		const late = Date.parse("2026-10-11T06:59:50.000Z");
		const a = newId(late);
		write(root, a, [`${iso(late + S)} took the lock`, ...call(a, "full", null, late + 2 * S, late + 20 * S, [sig(late + 5 * S, "full", 1, 2, "enforce"), decide("stop", late + 10 * S, "full", 1, 2)], "exit 125"), `${iso(late + 30 * S)} lock released`]);
		const b = newId(late + 15 * S);
		write(root, b, [`${iso(late + 31 * S)} took the lock`, `${iso(late + 60 * S)} lock released`]);
		const day1 = fieldReport({ root, since: "2026-10-10", until: "2026-10-10" });
		expect(day1).toContain("; 1 runs.");
		expect(day1).toContain(`worst 26.0 s (${a} full), p95 26.0 s, over 1 of 1 decisions`);
		expect(fieldReport({ root, since: "2026-10-11", until: null })).toContain(`; 1 runs.`);
		expect(fieldReport({ root, since: "2026-10-12", until: null })).toContain(NO_DECISION);
	});

	test("arguments", () => {
		expect(parseArgs([], { HOME: "/h" })).toEqual({ root: "/h/.agent-system-2/test-runs", since: null, until: null });
		expect(parseArgs(["--root", "/r", "--since", "2026-10-01", "--until", "2026-10-07"], {})).toEqual({ root: "/r", since: "2026-10-01", until: "2026-10-07" });
		expect(parseArgs(["--since", "10/01"], {})).toBe("--since must be YYYY-MM-DD");
		expect(parseArgs(["--since", "2026-10-08", "--until", "2026-10-07"], {})).toBe("--since is after --until");
		expect(parseArgs(["--day", "2026-10-08"], {})).toBe("unknown argument --day");
		expect(parseArgs(["--root"], {})).toBe("--root needs a value");
	});

	test("the CLI prints the report and exits 0; a bad argument exits 2 with the usage", () => {
		const { root } = world();
		const ok = Bun.spawnSync([process.execPath, SCRIPT, "--root", root, "--since", "2026-10-10"], { stdout: "pipe", stderr: "pipe" });
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout.toString()).toStartWith("# Stuck-worker field report\n");
		expect(ok.stdout.toString()).toContain("- false positives: 2 of 4 decisions (recovered 1, part-ended 1)");
		const bad = Bun.spawnSync([process.execPath, SCRIPT, "--until", "soon"], { stdout: "pipe", stderr: "pipe" });
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr.toString()).toContain("stuck-report: --until must be YYYY-MM-DD\nusage: bun surface/scripts/stuck-report.ts");
		const missing = Bun.spawnSync([process.execPath, SCRIPT, "--root", join(root, "nope")], { stdout: "pipe", stderr: "pipe" });
		expect(missing.exitCode).toBe(2);
		expect(missing.stderr.toString()).toContain("stuck-report: could not read");
	});
});
