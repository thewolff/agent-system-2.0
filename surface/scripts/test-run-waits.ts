#!/usr/bin/env bun
// test-run-waits: how long each full-suite request of one day waited for the test runner, and the qualifying-day gate
// of the parallel full part (PLAN wl-mvg2kzuvwngdmo § 3 sl-tp-waits, § 4).
//
//   bun surface/scripts/test-run-waits.ts --day YYYY-MM-DD [--over <min>] [--root <dir>]
//                                         [--qualify --workers <n> --merge <sha> --repo <dir>]
//
// The day is the America/Los_Angeles date (surface/src/chaos.ts `ptParts`) of a request's time, which is the run id's
// clock (`tr-` + 9 base-36 digits of ms, surface/src/test-run.ts `makeRunId`). The root is the runner's
// (test-run.ts `runsRoot`: $AGENT_SYSTEM_TEST_RUNS, else `test-runs` beside the ledger) unless --root names one.
// Per run it prints: request and lock time (PT), the wait in minutes (request to `took the lock`; a run that never
// took the lock waits until now while still queued, else until its last log line or heartbeat), the logged
// `full workers <n>`, the full part's minutes (prepare exit to `exec full` exit, else result.full.ms), the install
// source sha (result.json preflight `source <url> at <sha>`), the state (done: result.json read; queued/running:
// no result and a live heartbeat, test-run.ts `runLive`; dead: no result and no sign of life), the verdict and an
// error's reason. Suspects: a test failing in `red` runs of two or more different PRs that day, a heuristic for a
// look, not proof of a parallel-unsafe test.
//
// Plain mode exits 1 when any wait is over --over minutes (default 30), else 0. --qualify (the done line's gate,
// sl-tp-measure) prints every condition and exits 0 only when all hold:
//   day-ended         the PT day is over;
//   executed-runs     at least 10 runs took the lock and have a result with a non-null, error-free full part and
//                     `full workers <--workers>` logged;
//   all-terminal      no run is queued or running;
//   full-workers      every run that took the lock logged `full workers <--workers>`;
//   merged-source     every lock-holding run with a result names an install source that has --merge as an ancestor
//                     (`git -C <repo> merge-base --is-ancestor <merge> <source>`);
//   waits             no wait is over --over;
//   full-part-errors  no run's full part ended in an error (timeout, missing or malformed junit, exit with no failing test);
//   missing-result    every run that is neither queued nor running has a readable result.json;
//   suspects          there is no suspect.
// Read-only: nothing under the root is written. Exit 2 on a bad argument or an unreadable root.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ptParts } from "../src/chaos";
import { type Failure, parseHeartbeat, RUN_ID_RE, runLive, runsRoot, type TestVerdict } from "../src/test-run";

const USAGE = "usage: bun surface/scripts/test-run-waits.ts --day YYYY-MM-DD [--over <min>] [--root <dir>] [--qualify --workers <n> --merge <sha> --repo <dir>]";
const MIN = 60_000;
/** The executed full parts a qualifying day needs (PLAN § 3). */
export const QUALIFY_MIN_RUNS = 10;
const TS = String.raw`(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)`;
const TS_LINE = new RegExp(`^${TS} `);
const LOCK_LINE = new RegExp(`^${TS} took the lock\\b`);
const WORKERS_LINE = new RegExp(`^${TS} full workers (\\d+)$`);
const PREPARE_LINE = new RegExp(`^${TS} \\S+ prepare (tr-[a-z0-9]+) .*→ exit `);
const FULL_LINE = new RegExp(`^${TS} \\S+ full (tr-[a-z0-9]+) → exit `);
const SOURCE_RE = /\bsource \S+ at ([0-9a-f]{7,40})\b/;
const DAY_RE = /^\d{4}-\d\d-\d\d$/;

/** The request time of a run id: its 9 base-36 clock digits (test-run.ts `makeRunId`). */
export function requestMsOf(runId: string): number {
	if (!RUN_ID_RE.test(runId) || runId.length < 3 + 9) throw new Error(`${runId} is not a run id with a clock`);
	return Number.parseInt(runId.slice(3, 12), 36);
}

interface ResultFile {
	verdict: TestVerdict;
	pr: number | null;
	reason: string | null;
	full: { pass: number; fail: number; skip: number; exit: number | null; ms: number; error: string | null } | null;
	failures: Failure[];
	preflight: string | null;
}

export type RunState = "done" | "queued" | "running" | "dead";
export interface RunRow {
	runId: string;
	requestMs: number;
	lockMs: number | null;
	waitMin: number;
	workers: number | null;
	fullMin: number | null;
	source: string | null;
	state: RunState;
	verdict: TestVerdict | null;
	pr: number | null;
	reason: string | null;
	/** result.json, null when there is none or it does not parse (`resultError` says which). */
	result: ResultFile | null;
	resultError: string | null;
}

const readText = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/** One run dir read into its row, at `nowMs`. */
export function readRun(root: string, runId: string, nowMs: number): RunRow {
	const dir = join(root, runId);
	const requestMs = requestMsOf(runId);
	const lines = (readText(join(dir, "runner.log")) ?? "").split("\n");
	let lockMs: number | null = null;
	let lastLogMs: number | null = null;
	let workers: number | null = null;
	let prepareMs: number | null = null;
	let fullSpanMs: number | null = null;
	for (const line of lines) {
		const ts = TS_LINE.exec(line);
		if (!ts) continue;
		const at = Date.parse(ts[1]!);
		lastLogMs = lastLogMs === null ? at : Math.max(lastLogMs, at);
		if (lockMs === null && LOCK_LINE.test(line)) lockMs = at;
		const w = WORKERS_LINE.exec(line);
		if (w) workers = Number(w[2]);
		const p = PREPARE_LINE.exec(line);
		if (p && p[2] === runId) prepareMs = at;
		const f = FULL_LINE.exec(line);
		if (f && f[2] === runId && prepareMs !== null) fullSpanMs = at - prepareMs;
	}

	let result: ResultFile | null = null;
	let resultError: string | null = null;
	const resultPath = join(dir, "result.json");
	const raw = readText(resultPath);
	if (raw === null) resultError = "no result.json";
	else {
		try {
			const v = JSON.parse(raw) as Partial<ResultFile>;
			if (typeof v.verdict !== "string") throw new Error("no verdict");
			result = { verdict: v.verdict, pr: v.pr ?? null, reason: v.reason ?? null, full: v.full ?? null, failures: v.failures ?? [], preflight: v.preflight ?? null };
		} catch (e) {
			resultError = `result.json unreadable (${e instanceof Error ? e.message : String(e)})`;
		}
	}

	const hbText = readText(join(dir, "heartbeat"));
	const heartbeatMs = hbText === null ? null : parseHeartbeat(hbText, runId);
	// No result.json: queued or running while its heartbeat (or the startup lease) is live, else dead. An unreadable one is dead too.
	const live = raw === null && runLive({ settled: false, requestedAtMs: requestMs, heartbeatAtMs: heartbeatMs }, nowMs);
	const state: RunState = result !== null ? "done" : live ? (lockMs === null ? "queued" : "running") : "dead";

	let endMs: number;
	if (lockMs !== null) endMs = lockMs;
	else if (live) endMs = nowMs;
	else {
		const seen = [lastLogMs, heartbeatMs].filter((x): x is number => x !== null);
		endMs = seen.length > 0 ? Math.max(...seen) : raw !== null ? statSync(resultPath).mtimeMs : requestMs;
	}
	const fullMin = fullSpanMs !== null ? fullSpanMs / MIN : result?.full ? result.full.ms / MIN : null;
	return {
		runId, requestMs, lockMs, waitMin: Math.max(0, endMs - requestMs) / MIN, workers, fullMin,
		source: result?.preflight ? (SOURCE_RE.exec(result.preflight)?.[1] ?? null) : null,
		state,
		verdict: result?.verdict ?? null, pr: result?.pr ?? null, reason: result?.reason ?? null, result, resultError,
	};
}

/** Every run requested on the PT day `day`, oldest first. */
export function dayRuns(root: string, day: string, nowMs: number): RunRow[] {
	const ids = readdirSync(root).filter((n) => RUN_ID_RE.test(n) && n.length >= 12 && ptParts(new Date(requestMsOf(n))).day === day);
	return ids.map((id) => readRun(root, id, nowMs)).sort((a, b) => a.requestMs - b.requestMs || (a.runId < b.runId ? -1 : 1));
}

export interface Suspect {
	name: string;
	prs: number[];
	runs: string[];
}
/** Tests failing in `red` runs of two or more different PRs. */
export function suspects(rows: readonly RunRow[]): Suspect[] {
	const by = new Map<string, { prs: Set<number>; runs: Set<string> }>();
	for (const r of rows) {
		if (r.result?.verdict !== "red" || r.pr === null) continue;
		for (const f of r.result.failures) {
			const s = by.get(f.name) ?? { prs: new Set(), runs: new Set() };
			s.prs.add(r.pr);
			s.runs.add(r.runId);
			by.set(f.name, s);
		}
	}
	return [...by]
		.filter(([, s]) => s.prs.size >= 2)
		.map(([name, s]) => ({ name, prs: [...s.prs].sort((a, b) => a - b), runs: [...s.runs] }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface QualifyOptions {
	day: string;
	nowMs: number;
	overMin: number;
	workers: number;
	merge: string;
	repo: string;
}
export interface Condition {
	name: string;
	detail: string;
}

/** `git merge-base --is-ancestor`: true, false, or the error git gave. */
function isAncestor(repo: string, merge: string, source: string): boolean | string {
	const r = Bun.spawnSync(["git", "-C", repo, "merge-base", "--is-ancestor", merge, source], { stdout: "ignore", stderr: "pipe" });
	if (r.exitCode === 0) return true;
	if (r.exitCode === 1) return false;
	return `git merge-base exit ${r.exitCode}: ${r.stderr.toString().trim()}`;
}

/** Every condition of the qualifying-day gate that does not hold, in a fixed order; empty when the day qualifies. */
export function qualifyFailures(rows: readonly RunRow[], o: QualifyOptions): Condition[] {
	const out: Condition[] = [];
	const locked = rows.filter((r) => r.lockMs !== null);

	const today = ptParts(new Date(o.nowMs)).day;
	if (today <= o.day) out.push({ name: "day-ended", detail: `${o.day} has not ended (it is ${today} in America/Los_Angeles)` });

	const executed = locked.filter((r) => r.result?.full != null && r.result.full.error === null && r.workers === o.workers);
	if (executed.length < QUALIFY_MIN_RUNS) out.push({ name: "executed-runs", detail: `${executed.length} runs took the lock and ran an error-free PR full part with full workers ${o.workers}; ${QUALIFY_MIN_RUNS} needed` });

	const open = rows.filter((r) => r.state === "queued" || r.state === "running");
	if (open.length > 0) out.push({ name: "all-terminal", detail: `${open.length} not terminal: ${open.map((r) => `${r.runId} ${r.state}`).join(", ")}` });

	const badWorkers = locked.filter((r) => r.workers !== o.workers);
	if (badWorkers.length > 0) out.push({ name: "full-workers", detail: `${badWorkers.length} lock-holding runs did not log full workers ${o.workers}: ${badWorkers.map((r) => `${r.runId} ${r.workers ?? "none"}`).join(", ")}` });

	const cache = new Map<string, boolean | string>();
	const badSource: string[] = [];
	for (const r of locked) {
		if (r.result === null) continue;
		if (r.source === null) {
			badSource.push(`${r.runId} names no install source`);
			continue;
		}
		const a = cache.get(r.source) ?? isAncestor(o.repo, o.merge, r.source);
		cache.set(r.source, a);
		if (a !== true) badSource.push(`${r.runId} source ${r.source} ${a === false ? `does not descend from ${o.merge}` : a}`);
	}
	if (badSource.length > 0) out.push({ name: "merged-source", detail: badSource.join("; ") });

	const over = rows.filter((r) => r.waitMin > o.overMin);
	if (over.length > 0) out.push({ name: "waits", detail: `${over.length} waits over ${o.overMin} min: ${over.map((r) => `${r.runId} ${r.waitMin.toFixed(1)}`).join(", ")}` });

	const errored = rows.filter((r) => r.result?.full != null && r.result.full.error !== null);
	if (errored.length > 0) out.push({ name: "full-part-errors", detail: errored.map((r) => `${r.runId} ${r.result!.full!.error}`).join("; ") });

	const missing = rows.filter((r) => r.state === "dead");
	if (missing.length > 0) out.push({ name: "missing-result", detail: missing.map((r) => `${r.runId} ${r.lockMs !== null ? "took the lock, " : ""}${r.resultError}`).join("; ") });

	const sus = suspects(rows);
	if (sus.length > 0) out.push({ name: "suspects", detail: sus.map((s) => `${s.name} (PRs ${s.prs.map((p) => `#${p}`).join(", ")})`).join("; ") });
	return out;
}

const pt = (ms: number): string => {
	const p = ptParts(new Date(ms));
	return `${p.day.slice(5)} ${p.hhmm.slice(0, 2)}:${p.hhmm.slice(2)}`;
};

export interface WaitsOptions {
	root: string;
	day: string;
	overMin: number;
	nowMs: number;
	qualify?: { workers: number; merge: string; repo: string };
}

/** The report's lines and its exit code. */
export function waitsReport(o: WaitsOptions): { lines: string[]; exit: number } {
	const rows = dayRuns(o.root, o.day, o.nowMs);
	const lines: string[] = [`test-run waits for ${o.day} (America/Los_Angeles), root ${o.root}, over ${o.overMin} min`];
	lines.push(`${"run".padEnd(20)} ${"pr".padStart(4)} ${"requested".padEnd(11)} ${"lock".padEnd(11)} ${"wait".padStart(6)} ${"workers".padStart(7)} ${"full".padStart(6)} ${"source".padEnd(12)} ${"state".padEnd(7)} verdict`);
	for (const r of rows) {
		const verdict = r.verdict === null ? "-" : r.verdict === "error" && r.reason ? `error: ${r.reason}` : r.verdict;
		lines.push(
			`${r.runId.padEnd(20)} ${(r.pr === null ? "-" : String(r.pr)).padStart(4)} ${pt(r.requestMs).padEnd(11)} ${(r.lockMs === null ? "-" : pt(r.lockMs)).padEnd(11)} ${r.waitMin.toFixed(1).padStart(6)} ${(r.workers === null ? "-" : String(r.workers)).padStart(7)} ${(r.fullMin === null ? "-" : r.fullMin.toFixed(1)).padStart(6)} ${(r.source ?? "-").padEnd(12)} ${r.state.padEnd(7)} ${verdict}`,
		);
	}
	const over = rows.filter((r) => r.waitMin > o.overMin);
	const max = rows.reduce<RunRow | null>((m, r) => (m === null || r.waitMin > m.waitMin ? r : m), null);
	lines.push(`runs ${rows.length}, took the lock ${rows.filter((r) => r.lockMs !== null).length}, max wait ${max === null ? "-" : `${max.waitMin.toFixed(1)} min (${max.runId})`}, over ${o.overMin} min: ${over.length}`);
	const sus = suspects(rows);
	if (sus.length === 0) lines.push("suspects: none");
	for (const s of sus) lines.push(`suspect ${s.name}: PRs ${s.prs.map((p) => `#${p}`).join(", ")} (${s.runs.join(", ")})`);
	if (!o.qualify) return { lines, exit: over.length > 0 ? 1 : 0 };

	const failed = qualifyFailures(rows, { day: o.day, nowMs: o.nowMs, overMin: o.overMin, ...o.qualify });
	for (const f of failed) lines.push(`FAIL ${f.name}: ${f.detail}`);
	lines.push(failed.length === 0 ? "qualify: pass" : `qualify: fail (${failed.map((f) => f.name).join(", ")})`);
	return { lines, exit: failed.length === 0 ? 0 : 1 };
}

function parseArgs(argv: string[]): WaitsOptions | string {
	let day: string | null = null;
	let over = 30;
	let root: string | null = null;
	let qualify = false;
	let workers: number | null = null;
	let merge: string | null = null;
	let repo: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		if (flag === "--qualify") {
			qualify = true;
			continue;
		}
		const v = argv[++i];
		if (v === undefined) return `${flag} needs a value`;
		if (flag === "--day") day = v;
		else if (flag === "--over") over = Number(v);
		else if (flag === "--root") root = v;
		else if (flag === "--workers") workers = Number(v);
		else if (flag === "--merge") merge = v;
		else if (flag === "--repo") repo = v;
		else return `unknown argument ${flag}`;
	}
	if (day === null || !DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return "--day must be YYYY-MM-DD";
	if (!Number.isFinite(over) || over <= 0) return "--over must be a positive number of minutes";
	if (!qualify) {
		if (workers !== null || merge !== null || repo !== null) return "--workers, --merge and --repo go with --qualify";
		return { root: root ?? runsRoot(process.env), day, overMin: over, nowMs: Date.now() };
	}
	if (workers === null || !Number.isSafeInteger(workers) || workers < 1) return "--qualify needs --workers, an integer of 1 or more";
	if (merge === null || !/^[0-9a-f]{7,40}$/.test(merge)) return "--qualify needs --merge, a commit sha";
	if (repo === null || !existsSync(repo)) return "--qualify needs --repo, an existing checkout";
	return { root: root ?? runsRoot(process.env), day, overMin: over, nowMs: Date.now(), qualify: { workers, merge, repo } };
}

function main(argv: string[]): number {
	const o = parseArgs(argv);
	if (typeof o === "string") {
		console.error(`test-run-waits: ${o}\n${USAGE}`);
		return 2;
	}
	let report: { lines: string[]; exit: number };
	try {
		report = waitsReport(o);
	} catch (e) {
		console.error(`test-run-waits: could not read ${o.root} (${e instanceof Error ? e.message : String(e)})`);
		return 2;
	}
	console.log(report.lines.join("\n"));
	return report.exit;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
