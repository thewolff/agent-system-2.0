#!/usr/bin/env bun
// stuck-report: the stuck-worker detector's field report (PLAN wl-mvq8x4pkjmx69s D5), printed as markdown.
//
//   bun surface/scripts/stuck-report.ts [--root <runs root>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//
// The root is the runner's (test-run.ts `runsRoot`: $AGENT_SYSTEM_TEST_RUNS, else `test-runs` beside the ledger, so
// ~/.agent-system-2/test-runs by default). A run is in the interval when the America/Los_Angeles day of its request
// (the run id's clock, test-run-waits.ts `requestMsOf`) is within --since and --until, both inclusive; either may be left
// open. Each run's runner.log and result.json are read; nothing is written and nothing is spawned.
//
// Inputs (the workload's CONTRACT.md): the executor's `stuck-*` stdout lines, which the runner echoes into runner.log
// (found anywhere in a line, each carrying its own ISO time and `part <stem>`); the runner's own lines (`<ts> took the
// lock`, `<ts> lock released`, `<ts> the lock was not released: …`, `<ts> stuck-containment-failed part …`, `<ts>
// executor-stalled part …`, `<ts> admission refused: …`); the runner's wrapper-call lines (`<ts> <exec> <full|solo|base-solo> <run id>[ <file>]: started pid <n>` and
// `… → exit <code>` or `→ <signal>`, ` (after the outlive sweep)` when the outlive sweep fired, ` (abandoned by the stuck
// backstop)` when the enforce backstop gave up on the call), with the exec's echoed
// `part <stem>` line and its `as2test: timeout: the part passed its cap of <ms> ms` stderr line between them; and
// result.json's verdict, reason and preflight (`bun <version>`).
//
// Incidents: every count below is per incident, keyed by (run, part, worker pid, zombie pid). One zombie pid is one child
// of one Bun.spawnSync call, so every line of that key is the same hang. A re-signature of the key after a clear is folded
// into its incident, not counted as a new candidate, because in shadow mode the signature capture's own `sample <W> 1` can
// drop the spinning worker under the hot share for a tick: the log then shows signature, would-stop, `cleared … matched
// yes`, captured, signature, would-stop for the same pair, and counting that clear as a recovery and the second would-stop
// as a second decision would report a false positive and a double decision for one hang that never ended. An incident's
// first signature is its first-signature time, its first would-stop or stop its decision (counted once), and its category
// comes from its final state: the last line of the key a clear (no later signature, would-stop or stop) → cleared, else
// still holding. The number of folded re-signatures is reported.
//
// Categories, kept apart: an incident (a candidate) finally cleared without a decision (`cleared-before-match`), never
// matched and never cleared (`no decision`), or became a decision (`would-stop` in shadow, `stop` in enforce). A
// decision's outcome is `stopped` (enforce); `recovered` (finally cleared after the decision), or `part-ended` (still
// holding when the part ended on its own), both false positives; `capped` (still holding when the wall cap fired; minutes
// from the decision to the cap, unassessed until the capture is read); or `undetermined` (still holding and the log has no
// end of the part). Post-signature slot time per decision is `lock released` minus the first
// signature; next-start is the next run's `took the lock` minus the first signature when a run was waiting (requested
// before the release); worst and p95 (nearest rank) over the decisions that have the times. Wall-cap timeouts with no
// decision, executor-stalled, containment-failed, admission-refused and lock-release-failed runs, detector-off parts and runs and Bun versions
// are counts, never decisions. Every total carries its denominator. An interval with no decision says
// "no hang observed: no latency evidence" when every run was readable, else "evidence incomplete: N of M runs unreadable;
// no hang observed in the readable runs"; each unreadable input (runner.log or result.json missing, unreadable or malformed)
// is listed in `## Input problems`. Exit 0 with the report (and a stderr warning when a run was unreadable); exit 2 on a bad
// argument or an unreadable root.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ptParts } from "../src/chaos";
import { RUN_ID_RE, runsRoot } from "../src/test-run";
import { requestMsOf } from "./test-run-waits";

const USAGE = "usage: bun surface/scripts/stuck-report.ts [--root <runs root>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]";
export const NO_DECISION = "no hang observed: no latency evidence";
const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const ISO = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z`;
const TS = `(${ISO})`;

// ---- lines -----------------------------------------------------------------------------------------

export type Mode = "shadow" | "enforce";
interface At {
	at: number;
	part: string;
}
interface Pair {
	worker: number;
	zombie: number;
}
export type StuckEvent =
	| (At & Pair & { kind: "signature"; since: number; mode: Mode; bun: string; revision: string })
	| (At & Pair & { kind: "cleared"; heldMs: number; matched: boolean })
	| (At & Pair & { kind: "would-stop" | "stop" })
	| (At & { kind: "captured"; file: string; ms: number })
	| (At & { kind: "killed"; pgids: string[]; ms: number; contained: boolean; unconfirmed: string | null })
	| (At & { kind: "detector-off"; reason: string });

const STUCK_KEYWORD = /(?:^|\s)stuck-(signature|cleared|would-stop|stop|captured|killed|detector-off) /;
const STUCK_HEAD = new RegExp(`(?:^|\\s)stuck-(signature|cleared|would-stop|stop|captured|killed|detector-off) ${TS} part (\\S+)(?: (.*))?$`);
const PAIR = String.raw`worker (\d+) zombie (\d+)`;
const STUCK_REST: Record<StuckEvent["kind"], RegExp> = {
	signature: new RegExp(`^${PAIR} since (\\d+) mode (shadow|enforce) bun (\\S+) (\\S+)$`),
	cleared: new RegExp(`^${PAIR} held (\\d+) matched (yes|no)$`),
	"would-stop": new RegExp(`^${PAIR}$`),
	stop: new RegExp(`^${PAIR}$`),
	captured: /^file (\S+) ms (\d+)$/,
	killed: /^pgids (\S+) ms (\d+) (contained|unconfirmed (\S+))$/,
	"detector-off": /^reason (.+)$/,
};

/**
 * The `stuck-*` line in a runner.log line (CONTRACT.md: `<keyword> <ISO time> part <stem> …`, anywhere in the line, so a
 * prefix the runner adds does not matter). Null when the line has no stuck keyword; `malformed` when it has one but the
 * rest is not the pinned form.
 */
export function parseStuckLine(line: string): StuckEvent | "malformed" | null {
	if (!STUCK_KEYWORD.test(line)) return null;
	const h = STUCK_HEAD.exec(line);
	if (!h) return "malformed";
	const kind = h[1] as StuckEvent["kind"];
	const at = Date.parse(h[2]!);
	const part = h[3]!;
	const m = STUCK_REST[kind].exec(h[4] ?? "");
	if (!m || Number.isNaN(at)) return "malformed";
	const pair = (): Pair => ({ worker: Number(m[1]), zombie: Number(m[2]) });
	switch (kind) {
		case "signature":
			return { kind, at, part, ...pair(), since: Number(m[3]), mode: m[4] as Mode, bun: m[5]!, revision: m[6]! };
		case "cleared":
			return { kind, at, part, ...pair(), heldMs: Number(m[3]), matched: m[4] === "yes" };
		case "would-stop":
		case "stop":
			return { kind, at, part, ...pair() };
		case "captured":
			return { kind, at, part, file: m[1]!, ms: Number(m[2]) };
		case "killed":
			return { kind, at, part, pgids: m[1]!.split(","), ms: Number(m[2]), contained: m[3] === "contained", unconfirmed: m[4] ?? null };
		case "detector-off":
			return { kind, at, part, reason: m[1]! };
	}
}

export type PartSub = "full" | "solo" | "base-solo";
export type RunnerEvent =
	| { kind: "lock" | "released" | "release-failed"; at: number }
	| { kind: "containment-failed"; at: number; part: string; pids: string }
	| { kind: "executor-stalled"; at: number; part: string; worker: number }
	| { kind: "admission-refused"; at: number; why: string }
	| { kind: "call-start"; at: number; sub: PartSub; file: string | null }
	| { kind: "call-end"; at: number; sub: PartSub; file: string | null; ending: string; code: number | null; outlived: boolean }
	| { kind: "part"; stem: string }
	| { kind: "cap"; capMs: number };

const LOCK_LINE = new RegExp(`^${TS} took the lock\\b`);
const RELEASED_LINE = new RegExp(`^${TS} lock released$`);
const CONTAIN_LINE = new RegExp(`^${TS} stuck-containment-failed part (\\S+) pids (\\S+)`);
const STALLED_LINE = new RegExp(`^${TS} executor-stalled part (\\S+) worker (\\d+)`);
const ADMISSION_LINE = new RegExp(`^${TS} admission refused: (.*)$`);
const RELEASE_FAILED_LINE = new RegExp(`^${TS} the lock was not released: `);
const CALL = String.raw`\S+ (full|solo|base-solo) tr-[a-z0-9]+(?: (\S+))?`;
const CALL_START = new RegExp(`^${TS} ${CALL}: started pid \\d+$`);
const CALL_END = new RegExp(`^${TS} ${CALL} → (exit (-?\\d+|null)|[A-Z0-9]+)( \\(after the outlive sweep\\))?( \\(abandoned by the stuck backstop\\))?$`);
const PART_LINE = /^part ((?:base-)?solo-\d+)$/;
const CAP_LINE = /^as2test: timeout: the part passed its cap of (\d+) ms/;

/** One of the runner's own runner.log lines this report reads (CONTRACT.md and test-runner.ts `wrap`); null for any other. */
export function parseRunnerLine(line: string): RunnerEvent | null {
	let m: RegExpExecArray | null;
	if ((m = LOCK_LINE.exec(line))) return { kind: "lock", at: Date.parse(m[1]!) };
	if ((m = RELEASED_LINE.exec(line))) return { kind: "released", at: Date.parse(m[1]!) };
	if ((m = RELEASE_FAILED_LINE.exec(line))) return { kind: "release-failed", at: Date.parse(m[1]!) };
	if ((m = CONTAIN_LINE.exec(line))) return { kind: "containment-failed", at: Date.parse(m[1]!), part: m[2]!, pids: m[3]! };
	if ((m = STALLED_LINE.exec(line))) return { kind: "executor-stalled", at: Date.parse(m[1]!), part: m[2]!, worker: Number(m[3]) };
	if ((m = ADMISSION_LINE.exec(line))) return { kind: "admission-refused", at: Date.parse(m[1]!), why: m[2]! };
	if ((m = CALL_START.exec(line))) return { kind: "call-start", at: Date.parse(m[1]!), sub: m[2] as PartSub, file: m[3] ?? null };
	if ((m = CALL_END.exec(line))) {
		const code = m[5] === undefined || m[5] === "null" ? null : Number(m[5]);
		const ending = m[7] === undefined ? m[4]! : `${m[4]} (abandoned)`;
		return { kind: "call-end", at: Date.parse(m[1]!), sub: m[2] as PartSub, file: m[3] ?? null, ending, code, outlived: m[6] !== undefined };
	}
	if ((m = PART_LINE.exec(line))) return { kind: "part", stem: m[1]! };
	if ((m = CAP_LINE.exec(line))) return { kind: "cap", capMs: Number(m[1]) };
	return null;
}

// ---- one run ---------------------------------------------------------------------------------------

export interface PartRecord {
	stem: string;
	sub: PartSub | null;
	file: string | null;
	startAt: number | null;
	endAt: number | null;
	/** `exit <code>` or the signal, as the runner logged the call's end; null when the log has no end. */
	ending: string | null;
	/** The wall cap fired: exit 124, or the outlive sweep fired on the call (test-run.ts `callTimedOut`). */
	capped: boolean;
	/** When the cap fired: the call's start plus the logged cap, else the call's end. */
	capAt: number | null;
	/** The `stuck-detector-off` reason, null when the part logged none. */
	detectorOff: string | null;
}

/** One incident: every stuck line of one (run, part, worker, zombie) key (see the incident rule in the header). */
export interface Episode {
	runId: string;
	part: string;
	worker: number;
	zombie: number;
	mode: Mode;
	bun: string;
	revision: string;
	/** The incident's first signature. */
	firstAt: number;
	/** Signature lines of the key: 1, plus one per re-signature folded into the incident. */
	signatures: number;
	/** The incident's first would-stop or stop: its one decision. */
	decision: { kind: "would-stop" | "stop"; at: number } | null;
	/** The incident's final clear: the key's last line was this clear; null while the key is still holding. */
	cleared: { at: number; heldMs: number; matched: boolean } | null;
	captured: boolean;
	killed: { contained: boolean; unconfirmed: string | null } | null;
}

export interface RunRecord {
	runId: string;
	requestMs: number;
	lockAt: number | null;
	releasedAt: number | null;
	parts: PartRecord[];
	episodes: Episode[];
	executorStalled: boolean;
	containmentFailed: boolean;
	admissionRefused: boolean;
	/** The runner.log has `the lock was not released`: a release ended with the row still held. */
	releaseFailed: boolean;
	/** The install's Bun version from result.json's preflight (`bun <version>`), null when there is none. */
	bun: string | null;
	verdict: string | null;
	reason: string | null;
	resultError: string | null;
	/** Every input this run could not be read from: runner.log missing or unreadable, result.json missing or malformed. */
	inputProblems: { file: string; error: string }[];
	/** Stuck lines that are not the pinned form. */
	malformed: number;
	/** Stuck lines about a (part, worker, zombie) with no signature before them. */
	orphans: number;
}

const PREFLIGHT_BUN = /\bbun ([0-9A-Za-z.+-]+?),/;

/** One run read from its runner.log text and result.json text (null when there is none). */
export function parseRun(runId: string, log: string, resultText: string | null): RunRecord {
	const rec: RunRecord = {
		runId, requestMs: requestMsOf(runId), lockAt: null, releasedAt: null, parts: [], episodes: [], executorStalled: false,
		containmentFailed: false, admissionRefused: false, releaseFailed: false, bun: null, verdict: null, reason: null, resultError: null, inputProblems: [], malformed: 0, orphans: 0,
	};
	const parts = new Map<string, PartRecord>();
	const partOf = (stem: string): PartRecord => {
		let p = parts.get(stem);
		if (!p) {
			p = { stem, sub: null, file: null, startAt: null, endAt: null, ending: null, capped: false, capAt: null, detectorOff: null };
			parts.set(stem, p);
			rec.parts.push(p);
		}
		return p;
	};
	// The open wrapper call: its sub, file and start; the stem is known at once for `full`, from `part <stem>` for a solo.
	let call: { sub: PartSub; file: string | null; startAt: number; stem: string | null; capMs: number | null } | null = null;
	// An incident's key is (part, worker, zombie) (CONTRACT.md) within this run; the header's incident rule.
	const incidents = new Map<string, Episode>();

	for (const line of log.split("\n")) {
		const s = parseStuckLine(line);
		if (s === "malformed") {
			rec.malformed++;
			continue;
		}
		if (s !== null) {
			if (call !== null && call.stem === null) call.stem = s.part;
			const part = partOf(s.part);
			if (s.kind === "detector-off") {
				part.detectorOff = s.reason;
				continue;
			}
			const key = "worker" in s ? `${s.part}\t${s.worker}\t${s.zombie}` : null;
			if (s.kind === "signature") {
				const prior = incidents.get(key!);
				if (prior !== undefined) {
					// A re-signature of the key: the same incident is holding again.
					prior.signatures++;
					prior.cleared = null;
					continue;
				}
				const e: Episode = {
					runId, part: s.part, worker: s.worker, zombie: s.zombie, mode: s.mode, bun: s.bun, revision: s.revision,
					firstAt: s.at, signatures: 1, decision: null, cleared: null, captured: false, killed: null,
				};
				rec.episodes.push(e);
				incidents.set(key!, e);
				continue;
			}
			// captured and killed name no pair: they belong to the part's decided episode (one capture per part).
			const e = key !== null
				? incidents.get(key)
				: rec.episodes.findLast((x) => x.part === s.part && x.decision !== null);
			if (!e) {
				rec.orphans++;
				continue;
			}
			if (s.kind === "cleared") e.cleared = { at: s.at, heldMs: s.heldMs, matched: s.matched };
			else if (s.kind === "would-stop" || s.kind === "stop") {
				e.decision ??= { kind: s.kind, at: s.at };
				e.cleared = null;
			} else if (s.kind === "captured") e.captured = true;
			else e.killed = { contained: s.contained, unconfirmed: s.unconfirmed };
			continue;
		}
		const r = parseRunnerLine(line);
		if (r === null) continue;
		switch (r.kind) {
			case "lock":
				rec.lockAt ??= r.at;
				break;
			case "released":
				rec.releasedAt = r.at;
				break;
			case "containment-failed":
				rec.containmentFailed = true;
				break;
			case "executor-stalled":
				rec.executorStalled = true;
				break;
			case "admission-refused":
				rec.admissionRefused = true;
				break;
			case "release-failed":
				rec.releaseFailed = true;
				break;
			case "call-start":
				call = { sub: r.sub, file: r.file, startAt: r.at, stem: r.sub === "full" ? "full" : null, capMs: null };
				break;
			case "part":
				if (call !== null) call.stem = r.stem;
				break;
			case "cap":
				if (call !== null) call.capMs = r.capMs;
				break;
			case "call-end": {
				const c = call !== null && call.sub === r.sub && call.file === r.file ? call : null;
				const stem = c?.stem ?? (r.sub === "full" ? "full" : `${r.sub} ${r.file ?? "?"}`);
				const p = partOf(stem);
				p.sub = r.sub;
				p.file = r.file;
				p.startAt = c?.startAt ?? null;
				p.endAt = r.at;
				p.ending = r.ending;
				p.capped = r.code === 124 || r.outlived;
				p.capAt = !p.capped ? null : c !== null && c.capMs !== null ? c.startAt + c.capMs : r.at;
				call = null;
				break;
			}
		}
	}

	if (resultText === null) rec.resultError = "no result.json";
	else {
		try {
			const v = JSON.parse(resultText) as { verdict?: unknown; reason?: unknown; preflight?: unknown };
			if (typeof v.verdict !== "string") throw new Error("no verdict");
			rec.verdict = v.verdict;
			rec.reason = typeof v.reason === "string" ? v.reason : null;
			if (typeof v.preflight === "string") rec.bun = PREFLIGHT_BUN.exec(v.preflight)?.[1] ?? null;
		} catch (e) {
			rec.resultError = `result.json unreadable (${e instanceof Error ? e.message : String(e)})`;
		}
	}
	if (rec.resultError !== null) rec.inputProblems.push({ file: "result.json", error: rec.resultError });
	// result.json's reason names the same run-level errors when the runner.log line is missing (PLAN D4 reasons).
	const reason = rec.reason ?? "";
	if (reason.includes("executor stalled during stuck detection")) rec.executorStalled = true;
	if (reason.includes("containment failed")) rec.containmentFailed = true;
	if (reason.includes("admission refused")) rec.admissionRefused = true;
	return rec;
}

// ---- outcomes and the summary -------------------------------------------------------------------------

export type Outcome = "cleared-before-match" | "no-decision" | "recovered" | "part-ended" | "capped" | "stopped" | "undetermined";

/** An incident's category (D5): a candidate's, or a decision's outcome, judged from the incident's final state. */
export function outcomeOf(e: Episode, part: PartRecord | undefined): Outcome {
	if (e.decision === null) return e.cleared !== null ? "cleared-before-match" : "no-decision";
	if (e.decision.kind === "stop") return "stopped";
	if (e.cleared !== null) return "recovered";
	if (part?.capped) return "capped";
	if (part?.endAt != null) return "part-ended";
	return "undetermined";
}

/** The p-th percentile by nearest rank (the smallest value with at least p% of values at or below it); null for none. */
export function nearestRank(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

export interface DecisionRow {
	episode: Episode;
	outcome: Outcome;
	/** Minutes from the decision to the cap, for `capped`. */
	toCapMin: number | null;
	/** lock released − first signature, ms. */
	slotMs: number | null;
	/** The next waiting run's `took the lock` − first signature, ms, and that run. */
	nextStartMs: number | null;
	nextRun: string | null;
}

export interface Summary {
	runs: RunRecord[];
	parts: number;
	partsBySub: Record<PartSub | "unknown", number>;
	detectorOffParts: number;
	detectorOffRuns: number;
	episodes: { episode: Episode; outcome: Outcome }[];
	decisions: DecisionRow[];
	cappedParts: number;
	unmatchedCaps: { runId: string; part: string }[];
	executorStalled: string[];
	containmentFailed: string[];
	admissionRefused: string[];
	releaseFailed: string[];
	malformed: number;
	/** The runs with at least one unreadable input, and each problem. */
	unreadableRuns: number;
	inputProblems: { runId: string; file: string; error: string }[];
	orphans: number;
}

/**
 * The summary of `runs` (the interval's runs); `all` is every run under the root, for the next run that was waiting when
 * a decision's run released the lock (requested at or before the release, and the first to take the lock at or after it).
 */
export function summarize(runs: readonly RunRecord[], all: readonly RunRecord[] = runs): Summary {
	const s: Summary = {
		runs: [...runs], parts: 0, partsBySub: { full: 0, solo: 0, "base-solo": 0, unknown: 0 }, detectorOffParts: 0, detectorOffRuns: 0,
		episodes: [], decisions: [], cappedParts: 0, unmatchedCaps: [], executorStalled: [], containmentFailed: [], admissionRefused: [], releaseFailed: [],
		malformed: 0, orphans: 0, unreadableRuns: 0, inputProblems: [],
	};
	for (const run of runs) {
		s.malformed += run.malformed;
		s.orphans += run.orphans;
		if (run.inputProblems.length > 0) s.unreadableRuns++;
		for (const p of run.inputProblems) s.inputProblems.push({ runId: run.runId, ...p });
		if (run.executorStalled) s.executorStalled.push(run.runId);
		if (run.containmentFailed) s.containmentFailed.push(run.runId);
		if (run.admissionRefused) s.admissionRefused.push(run.runId);
		if (run.releaseFailed) s.releaseFailed.push(run.runId);
		if (run.parts.some((p) => p.detectorOff !== null)) s.detectorOffRuns++;
		const next = run.releasedAt === null ? null : all
			.filter((o) => o.runId !== run.runId && o.requestMs <= run.releasedAt! && o.lockAt !== null && o.lockAt >= run.releasedAt!)
			.reduce<RunRecord | null>((m, o) => (m === null || o.lockAt! < m.lockAt! ? o : m), null);
		for (const p of run.parts) {
			s.parts++;
			s.partsBySub[p.sub ?? "unknown"]++;
			if (p.detectorOff !== null) s.detectorOffParts++;
			if (!p.capped) continue;
			s.cappedParts++;
			if (!run.episodes.some((e) => e.part === p.stem && e.decision !== null)) s.unmatchedCaps.push({ runId: run.runId, part: p.stem });
		}
		for (const e of run.episodes) {
			const part = run.parts.find((p) => p.stem === e.part);
			const outcome = outcomeOf(e, part);
			s.episodes.push({ episode: e, outcome });
			if (e.decision === null) continue;
			s.decisions.push({
				episode: e, outcome,
				toCapMin: outcome === "capped" && part?.capAt != null ? (part.capAt - e.decision.at) / 60_000 : null,
				slotMs: run.releasedAt === null ? null : run.releasedAt - e.firstAt,
				nextStartMs: next === null ? null : next.lockAt! - e.firstAt,
				nextRun: next?.runId ?? null,
			});
		}
	}
	return s;
}

// ---- rendering --------------------------------------------------------------------------------------

const sec = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const of = (n: number, d: number, what: string): string => `${n} of ${d} ${what}`;

function versions<T>(items: readonly T[], label: (t: T) => string): string {
	if (items.length === 0) return "none";
	const counts = new Map<string, number>();
	for (const t of items) counts.set(label(t), (counts.get(label(t)) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([v, n]) => `${v} ${n}`).join(", ");
}

function latency(lines: string[], what: string, rows: readonly DecisionRow[], value: (r: DecisionRow) => number | null, d: number): void {
	const have = rows.filter((r) => value(r) !== null);
	if (have.length === 0) {
		lines.push(`- ${what}: none measured (${of(0, d, "decisions")})`);
		return;
	}
	const worst = have.reduce((m, r) => (value(r)! > value(m)! ? r : m));
	const p95 = nearestRank(have.map((r) => value(r)!), 95)!;
	lines.push(`- ${what}: worst ${sec(value(worst)!)} (${worst.episode.runId} ${worst.episode.part}), p95 ${sec(p95)}, over ${of(have.length, d, "decisions")}`);
}

export interface ReportOptions {
	root: string;
	since: string | null;
	until: string | null;
}

/** The report's markdown lines. */
export function renderReport(s: Summary, o: ReportOptions): string[] {
	const n = s.runs.length;
	const d = s.decisions.length;
	const c = s.episodes.length;
	const count = (out: Outcome) => s.episodes.filter((e) => e.outcome === out).length;
	const dcount = (out: Outcome) => s.decisions.filter((r) => r.outcome === out).length;
	const lines: string[] = [
		"# Stuck-worker field report",
		"",
		`Root ${o.root}; requests from ${o.since ?? "the first run"} to ${o.until ?? "the last run"} (America/Los_Angeles days); ${n} runs.`,
		"",
		"## Totals",
		"",
		`- parts: ${s.parts} (full ${s.partsBySub.full}, solo ${s.partsBySub.solo}, base-solo ${s.partsBySub["base-solo"]}, no call line ${s.partsBySub.unknown})`,
		`- detector off: ${of(s.detectorOffParts, s.parts, "parts")}; runs with the detector off: ${of(s.detectorOffRuns, n, "runs")}`,
		`- signatures (candidates): ${c} (incidents by run, part, worker, zombie; ${s.episodes.reduce((n, e) => n + e.episode.signatures - 1, 0)} re-signatures folded in)`,
		`  - cleared-before-match: ${of(count("cleared-before-match"), c, "signatures")}`,
		`  - no decision and not cleared: ${of(count("no-decision"), c, "signatures")}`,
		`  - decisions: ${of(d, c, "signatures")} (would-stop ${s.decisions.filter((r) => r.episode.decision!.kind === "would-stop").length}, stop ${s.decisions.filter((r) => r.episode.decision!.kind === "stop").length})`,
		`- false positives: ${of(dcount("recovered") + dcount("part-ended"), d, "decisions")} (recovered ${dcount("recovered")}, part-ended ${dcount("part-ended")})`,
		`- capped (unrecovered, unassessed until the capture is read): ${of(dcount("capped"), d, "decisions")}`,
		`- stopped: ${of(dcount("stopped"), d, "decisions")} (contained ${s.decisions.filter((r) => r.outcome === "stopped" && r.episode.killed?.contained).length}, unconfirmed ${s.decisions.filter((r) => r.outcome === "stopped" && r.episode.killed !== null && !r.episode.killed.contained).length})`,
		`- undetermined (no end of the part in the log): ${of(dcount("undetermined"), d, "decisions")}`,
		`- wall-cap timeouts with no decision (unmatched): ${of(s.unmatchedCaps.length, s.cappedParts, "capped parts")}`,
		`- executor-stalled runs: ${of(s.executorStalled.length, n, "runs")}`,
		`- containment-failed runs: ${of(s.containmentFailed.length, n, "runs")}`,
		`- admission-refused runs: ${of(s.admissionRefused.length, n, "runs")}`,
		`- lock release failed: ${of(s.releaseFailed.length, n, "runs")}`,
		`- Bun versions (runs): ${versions(s.runs, (r) => r.bun ?? "unknown")} (of ${n} runs)`,
		`- Bun versions (signatures): ${versions(s.episodes, (e) => `${e.episode.bun} ${e.episode.revision}`)} (of ${c} signatures)`,
	];
	lines.push(`- runs with unreadable evidence: ${of(s.unreadableRuns, n, "runs")}`);
	if (s.malformed + s.orphans > 0) lines.push(`- unread stuck lines: ${s.malformed} not in the pinned form, ${s.orphans} with no signature before them`);

	if (s.inputProblems.length > 0) {
		lines.push("", "## Input problems", "");
		for (const p of s.inputProblems) lines.push(`- ${p.runId} ${p.file}: ${p.error}`);
	}

	lines.push("", "## Post-signature slot time", "");
	if (d === 0) lines.push(s.unreadableRuns > 0 ? `evidence incomplete: ${of(s.unreadableRuns, n, "runs")} unreadable; no hang observed in the readable runs` : NO_DECISION);
	else {
		latency(lines, "lock released − first signature", s.decisions, (r) => r.slotMs, d);
		latency(lines, "next run took the lock − first signature (a run was waiting)", s.decisions, (r) => r.nextStartMs, d);
		const toCap = s.decisions.filter((r) => r.toCapMin !== null);
		if (toCap.length > 0) lines.push(`- decision → cap (would-save): ${toCap.map((r) => `${r.toCapMin!.toFixed(1)} min (${r.episode.runId} ${r.episode.part})`).join(", ")}`);
	}

	lines.push("", "## Signatures", "");
	if (c === 0) lines.push("none");
	else {
		lines.push("| run | part | mode | worker | zombie | first signature | outcome | decision → cap | slot | next start | bun |", "|---|---|---|---|---|---|---|---|---|---|---|");
		for (const { episode: e, outcome } of s.episodes) {
			const r = s.decisions.find((x) => x.episode === e);
			lines.push(
				`| ${e.runId} | ${e.part} | ${e.mode} | ${e.worker} | ${e.zombie} | ${new Date(e.firstAt).toISOString()} | ${outcome} | ${r?.toCapMin != null ? `${r.toCapMin.toFixed(1)} min` : "-"} | ${r?.slotMs != null ? sec(r.slotMs) : "-"} | ${r?.nextStartMs != null ? `${sec(r.nextStartMs)} (${r.nextRun})` : "-"} | ${e.bun} ${e.revision} |`,
			);
		}
	}

	lines.push("", "## Parts", "");
	if (s.parts === 0) lines.push("none");
	else {
		lines.push("| run | part | file | ended | detector |", "|---|---|---|---|---|");
		for (const run of s.runs) {
			for (const p of run.parts) {
				const ended = p.ending === null ? "-" : `${p.ending}${p.capped ? " (cap)" : ""}`;
				lines.push(`| ${run.runId} | ${p.stem} | ${p.file ?? "-"} | ${ended} | ${p.detectorOff === null ? "on" : `off: ${p.detectorOff}`} |`);
			}
		}
	}

	const flagged = s.runs.filter((r) => r.executorStalled || r.containmentFailed || r.admissionRefused);
	if (flagged.length > 0) {
		lines.push("", "## Run errors", "");
		for (const r of flagged) {
			const what = [r.executorStalled && "executor-stalled", r.containmentFailed && "containment-failed", r.admissionRefused && "admission-refused"].filter(Boolean).join(", ");
			lines.push(`- ${r.runId}: ${what}${r.reason ? ` (${r.reason})` : ""}`);
		}
	}
	return lines;
}

// ---- the root and the CLI -------------------------------------------------------------------------

type Read = { text: string; error: null } | { text: null; error: string };

/** A file's text, or why it could not be read (`missing` for no such file); never a silent null. */
const readText = (path: string): Read => {
	try {
		return { text: readFileSync(path, "utf8"), error: null };
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return { text: null, error: code === "ENOENT" ? "missing" : `unreadable (${e instanceof Error ? e.message : String(e)})` };
	}
};

/** Every run under `root`, oldest request first. A runner.log that is missing or unreadable is an input problem of its run. */
export function readRuns(root: string): RunRecord[] {
	return readdirSync(root)
		.filter((n) => RUN_ID_RE.test(n) && n.length >= 12)
		.map((id) => {
			const log = readText(join(root, id, "runner.log"));
			const result = readText(join(root, id, "result.json"));
			const rec = parseRun(id, log.text ?? "", result.text);
			if (log.error !== null) rec.inputProblems.unshift({ file: "runner.log", error: log.error });
			if (result.error !== null && result.error !== "missing") {
				rec.resultError = `result.json ${result.error}`;
				rec.inputProblems = rec.inputProblems.filter((p) => p.file !== "result.json");
				rec.inputProblems.push({ file: "result.json", error: result.error });
			}
			return rec;
		})
		.sort((a, b) => a.requestMs - b.requestMs || (a.runId < b.runId ? -1 : 1));
}

/** Whether a run's request falls on a PT day within [since, until]. */
export function inInterval(run: RunRecord, since: string | null, until: string | null): boolean {
	const day = ptParts(new Date(run.requestMs)).day;
	return (since === null || day >= since) && (until === null || day <= until);
}

/** The report for a root and an interval, with the summary it was rendered from. */
export interface FieldReport {
	text: string;
	summary: Summary;
}

export function fieldReportOf(o: ReportOptions): FieldReport {
	const all = readRuns(o.root);
	const runs = all.filter((r) => inInterval(r, o.since, o.until));
	const summary = summarize(runs, all);
	return { text: `${renderReport(summary, o).join("\n")}\n`, summary };
}

/** The whole report for a root and an interval. */
export function fieldReport(o: ReportOptions): string {
	return fieldReportOf(o).text;
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): ReportOptions | string {
	let root: string | null = null;
	let since: string | null = null;
	let until: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		const v = argv[++i];
		if (v === undefined) return `${flag} needs a value`;
		if (flag === "--root") root = v;
		else if (flag === "--since") since = v;
		else if (flag === "--until") until = v;
		else return `unknown argument ${flag}`;
	}
	for (const [name, day] of [["--since", since], ["--until", until]] as const) {
		if (day !== null && (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))) return `${name} must be YYYY-MM-DD`;
	}
	if (since !== null && until !== null && since > until) return "--since is after --until";
	return { root: root ?? runsRoot(env), since, until };
}

function main(argv: string[]): number {
	const o = parseArgs(argv);
	if (typeof o === "string") {
		console.error(`stuck-report: ${o}\n${USAGE}`);
		return 2;
	}
	let out: FieldReport;
	try {
		out = fieldReportOf(o);
	} catch (e) {
		console.error(`stuck-report: could not read ${o.root} (${e instanceof Error ? e.message : String(e)})`);
		return 2;
	}
	process.stdout.write(out.text);
	if (out.summary.unreadableRuns > 0) {
		console.error(`stuck-report: warning: ${out.summary.unreadableRuns} of ${out.summary.runs.length} runs have unreadable evidence (see "## Input problems" in the report)`);
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
