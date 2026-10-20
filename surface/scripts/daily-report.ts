#!/usr/bin/env bun
// daily-report: the daily self-heal report (PLAN wl-mvbcjageg7o2yo § 2.6), run by launchd at 07:00 local time
// (install/com.agent-system-2.daily-report.plist, written by install.sh --daily-report). Detect and report only:
// nothing is repaired, and the one ledger write is the report's own entry.
//
//   bun surface/scripts/daily-report.ts [--dry-run] [--home <dir>] [--now <iso>]
//
// One run, in order:
//  1. The ledger ($AGENT_SYSTEM_LEDGER_DB, else <home>/.agent-system-2/ledger.db) is opened read-only for
//     everything the report computes. The window is `[from, to)`: `to` is now; `from` is the `to` of the newest
//     `daily-report:` entry (its body's `window <from>..<to>`), else 24 h before the run, and never more than
//     7 days before the run (the report says so when capped). A kickstart or a late wake run neither gaps nor
//     overlaps, and a job re-enabled after weeks does not stream weeks of session files.
//  2. The seven detectors (surface/src/selfheal/read.ts readDetectorInputs, detectors.ts runDetectors) and the
//     counts (surface/src/selfheal/counts.ts: lane deaths by cause, lapsed leases, held messages on closed
//     workloads, lane runs) over that window. The profile whose sessions are read is AGENT_SYSTEM_PROFILE, then
//     OMP_PROFILE, then `agent-system-2`.
//  3. The report is written to its own file first,
//     <home>/agent-scratch/agent-system-2.0/self-heal/<local YYYY-MM-DD>-<HHMMSS>-<pid>.md.
//  4. Then one write on a read-write handle opened only now (the scratch sweep's pattern): under the write lock,
//     the standing workload is ensured and checked for a `daily-report:` entry of this local date; when there is
//     none, one entry by DAILY_REPORT_BY is written naming that exact file:
//     `daily-report: <date> window <from>..<to> findings <n> (<detector> <k>, …) deaths <d> lapsed <l> held-closed <h> — <path>`.
//  5. A run that finds an entry of its date, or whose entry write fails, deletes its own file: no file is left
//     without an entry and no entry names a missing file.
// At the end the run prints its own peak RSS in MiB (process.resourceUsage().maxRSS: bytes under Bun 1.3 on darwin,
// KiB under Node; a value under 1/64 of the current RSS can only be KiB, and the peak is never below the current RSS).
//
// --dry-run prints the report and writes nothing (no file, no entry). --home and --now exist for tests.
// Exit: 0 written, or skipped because the date already has its entry; 1 the ledger could not be read, a reader or
// detector failed, or the file or the entry could not be written; 2 bad arguments (nothing done).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultLedgerPath, type EntryRow, Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../src/identity";
import { type ControlEntry, controlEntries, DAILY_REPORT_BY } from "../src/launch";
import { type CountRows, computeCounts, type Counts, type DeathRow, type HeldRow, type LapseRow } from "../src/selfheal/counts";
import type { DetectorInputs } from "../src/selfheal/detectors";
import type { readDetectorInputs } from "../src/selfheal/read";
import { DETECTOR_IDS, type Finding, type Window } from "../src/selfheal/types";
import { unrecordedLapse } from "../src/signals";
import { STANDING_WORKLOAD_ID } from "../src/types";

const HOUR_MS = 60 * 60 * 1000;
/** With no earlier report, the window is this long. */
export const DEFAULT_WINDOW_MS = 24 * HOUR_MS;
/** The window never starts more than this long before the run. */
export const MAX_WINDOW_MS = 7 * 24 * HOUR_MS;

const USAGE = "usage: bun surface/scripts/daily-report.ts [--dry-run] [--home <dir>] [--now <iso>]";

export interface ReportArgs {
	dryRun: boolean;
	home: string;
	/** The run's clock (tests); null = the real time. */
	now: Date | null;
}

export function parseArgs(argv: readonly string[], home: string = homedir()): ReportArgs | string {
	const args: ReportArgs = { dryRun: false, home, now: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--home") {
			const v = argv[++i];
			if (v === undefined || !isAbsolute(v)) return "--home needs an absolute directory";
			args.home = v;
		} else if (a === "--now") {
			const v = argv[++i];
			if (v === undefined || Number.isNaN(Date.parse(v))) return "--now needs an ISO-8601 time";
			args.now = new Date(v);
		} else return `unknown argument ${JSON.stringify(a)}`;
	}
	if (!isAbsolute(args.home)) return `HOME is not absolute: ${JSON.stringify(args.home)}`;
	return args;
}

/** The detectors' two halves (surface/src/selfheal/read.ts, detectors.ts); injected so tests pass fakes. */
export interface ReportDeps {
	readDetectorInputs: typeof readDetectorInputs;
	runDetectors: (inputs: DetectorInputs, window: Window) => Finding[];
}

/** Test seam: `inLock` runs inside the entry's write transaction, after the date check, right before the entry is written. */
export interface ReportHooks {
	inLock?: () => void;
}

export interface ReportResult {
	exit: number;
	report: string;
	/** The report file left on disk (null: dry run, skipped, or failed). */
	reportPath: string | null;
	/** The entry written, or null. */
	entry: string | null;
	body: string | null;
	window: Window | null;
	/** What happened to the ledger, one line. */
	ledgerLine: string;
}

const REPORT_REST = /^(\d{4}-\d{2}-\d{2}) window (\S+)\.\.(\S+)\s/;

/** The valid `daily-report:` entries (writer DAILY_REPORT_BY) among a standing workload's entries, oldest first. */
export function reportEntries(entries: readonly EntryRow[]): (ControlEntry & { date: string; from: string; to: string })[] {
	const out: (ControlEntry & { date: string; from: string; to: string })[] = [];
	for (const c of controlEntries(entries)) {
		const m = c.prefix === "daily-report" ? REPORT_REST.exec(c.rest) : null;
		if (m && !Number.isNaN(Date.parse(m[2]!)) && !Number.isNaN(Date.parse(m[3]!))) out.push({ ...c, date: m[1]!, from: m[2]!, to: m[3]! });
	}
	return out;
}

/** The window for a run at `now`: from the newest report's `to` (else 24 h back), never more than 7 days back. */
export function reportWindow(previousTo: string | null, now: Date): Window & { capped: boolean } {
	const to = now.toISOString();
	const floor = now.getTime() - MAX_WINDOW_MS;
	const start = previousTo === null ? now.getTime() - DEFAULT_WINDOW_MS : Date.parse(previousTo);
	return start < floor ? { from: new Date(floor).toISOString(), to, capped: true } : { from: new Date(start).toISOString(), to, capped: false };
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function reportDir(home: string): string {
	return join(home, "agent-scratch", "agent-system-2.0", "self-heal");
}

/** Every row the counts read, from the read-only handle (counts.ts is pure over these). */
export function readCountRows(ledger: Ledger, nowIso: string): CountRows {
	const deaths = ledger.db.query<{ id: string; workload_id: string; body: string; created_at: string }, []>(
		"SELECT id, workload_id, body, created_at FROM messages WHERE body LIKE 'lane-died:%' ORDER BY created_at, rowid",
	).all().map((m): DeathRow => ({ id: m.id, workloadId: m.workload_id, body: m.body, createdAt: m.created_at }));
	const unrecordedLapses: LapseRow[] = [];
	const lapsed = ledger.db.query<{ id: string }, [string]>(
		"SELECT id FROM workloads WHERE status = 'open' AND holder IS NOT NULL AND holder_lease_until < ? ORDER BY id",
	).all(nowIso);
	for (const { id } of lapsed) {
		const w = ledger.workload(id);
		if (w && unrecordedLapse(ledger, w, nowIso)) unrecordedLapses.push({ workloadId: id, holder: w.holder!, leaseUntil: w.holder_lease_until! });
	}
	const heldClosed = ledger.db.query<{ id: string; workload_id: string; created_at: string }, []>(
		"SELECT m.id, m.workload_id, m.created_at FROM messages m JOIN workloads w ON w.id = m.workload_id WHERE m.state = 'held' AND w.status = 'closed' ORDER BY m.created_at, m.rowid",
	).all().map((m): HeldRow => ({ id: m.id, workloadId: m.workload_id, createdAt: m.created_at }));
	const lanes = controlEntries(ledger.db.query<EntryRow, []>(
		"SELECT * FROM entries WHERE kind = 'assumption' AND (body LIKE 'lane-started:%' OR body LIKE 'lane-exit:%' OR body LIKE 'lane-metrics:%') ORDER BY created_at, rowid",
	).all());
	return { deaths, unrecordedLapses, heldClosed, lanes };
}

/** `<id> <k>` for every detector that fired, in DETECTOR_IDS order. */
function perDetector(findings: readonly Finding[]): string[] {
	return DETECTOR_IDS.map((id) => [id, findings.filter((f) => f.detector === id).length] as const).filter(([, k]) => k > 0).map(([id, k]) => `${id} ${k}`);
}

/** The entry body: `daily-report: <date> window <from>..<to> findings <n> (<id> <k>, …) deaths <d> lapsed <l> held-closed <h> — <path>`. */
export function entryBody(date: string, w: Window, findings: readonly Finding[], counts: Counts, path: string): string {
	const parts = perDetector(findings);
	return `daily-report: ${date} window ${w.from}..${w.to} findings ${findings.length}${parts.length ? ` (${parts.join(", ")})` : ""} deaths ${counts.deaths.total} lapsed ${counts.lapsed.total} held-closed ${counts.heldClosed.total} — ${path}`;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function render(o: { date: string; nowIso: string; dryRun: boolean; ledgerPath: string; profile: string; window: Window & { capped: boolean }; previousTo: string | null; findings: readonly Finding[]; counts: Counts }): string {
	const { window: w, counts: c, findings } = o;
	const hours = Math.round(((Date.parse(w.to) - Date.parse(w.from)) / HOUR_MS) * 10) / 10;
	const start = o.previousTo === null ? "no earlier report: 24 h back" : `the previous report's window ended ${o.previousTo}`;
	const out: string[] = [
		`# daily self-heal report ${o.date}${o.dryRun ? " (dry run: nothing written)" : ""}`,
		"",
		`- run: ${o.nowIso}`,
		`- window: ${w.from}..${w.to} (${hours} h; ${start}${w.capped ? "; capped at 7 days before the run" : ""})`,
		`- ledger: ${o.ledgerPath} (read-only)`,
		`- profile: ${o.profile}`,
		"",
		`## findings (${findings.length})`,
		"",
	];
	const parts = perDetector(findings);
	out.push(parts.length ? `- by detector: ${parts.join(", ")}` : "- none", "");
	if (findings.length > 0) {
		out.push("| detector | at | workload | lane | summary | evidence |", "|---|---|---|---|---|---|");
		for (const f of [...findings].sort((a, b) => a.at.localeCompare(b.at))) {
			out.push(`| ${f.detector} | ${f.at} | ${f.workloadId ?? "-"} | ${f.laneId ?? "-"} | ${cell(f.summary)} | ${cell(f.evidence)} |`);
		}
		out.push("");
	}
	out.push(`## lane deaths in the window (${c.deaths.total})`, "");
	out.push(...(c.deaths.byCause.length ? c.deaths.byCause.map(([cause, n]) => `- ${cause}: ${n}`) : ["- none"]), "");
	out.push(
		`## lapsed leases (${c.lapsed.total})`,
		"",
		`- recorded in the window (lane-died: lease lapsed): ${c.lapsed.recorded}`,
		`- unrecorded now (no lane-died: row yet): ${c.lapsed.unrecorded.length}${c.lapsed.unrecorded.length ? ` (${c.lapsed.unrecorded.map((l) => `${l.workloadId} ${l.holder} lease ${l.leaseUntil}`).join("; ")})` : ""}`,
		"",
		`## held messages on closed workloads (${c.heldClosed.total})`,
		"",
		`- total: ${c.heldClosed.total} on ${c.heldClosed.workloads} closed workload(s); new in the window: ${c.heldClosed.inWindow}`,
		"- no surface renders these (delivery reads open workloads only); counted, never rewritten",
		"",
		"## lane runs",
		"",
	);
	const l = c.lanes;
	const usd = l.usdByModel.map(([m, d]) => `${m} $${d.toFixed(2)}`).join(", ");
	out.push(
		`- metered runs (lane-metrics:): ${l.runs}; wall ${Math.round(l.wallMin * 10) / 10} min${usd ? `; run-delta dollars: ${usd}` : ""}`,
		`- peak RSS: ${l.peakRssMb ? `p50 ${l.peakRssMb.p50} MiB, max ${l.peakRssMb.max} MiB over ${l.peakRssMb.samples} run(s) (an upper bound from 15 s samples; a shorter spike can be missed)` : "no samples"}`,
		`- unmetered runner lanes (ended with no lane-metrics:): ${l.unmetered.length}${l.unmetered.length ? ` (${l.unmetered.join(", ")})` : ""}`,
		`- interactive lanes (not metered in this phase): ${l.interactive.length}${l.interactive.length ? ` (${l.interactive.join(", ")})` : ""}`,
		"",
	);
	return out.join("\n");
}

export async function dailyReport(args: ReportArgs, env: Readonly<Record<string, string | undefined>>, deps: ReportDeps, hooks: ReportHooks = {}): Promise<ReportResult> {
	const now = args.now ?? new Date();
	const nowIso = now.toISOString();
	const ledgerPath = defaultLedgerPath({ ...env, HOME: args.home });
	const profile = env.AGENT_SYSTEM_PROFILE || env.OMP_PROFILE || "agent-system-2";
	const failed = (why: string, window: Window | null = null): ReportResult => ({ exit: 1, report: "", reportPath: null, entry: null, body: null, window, ledgerLine: why });

	let ro: Ledger;
	try {
		ro = Ledger.open(ledgerPath, { readonly: true });
	} catch (e) {
		return failed(`the ledger ${ledgerPath} could not be read (${e instanceof Error ? e.message : String(e)}); nothing written`);
	}
	let window: Window & { capped: boolean };
	let previousTo: string | null;
	let findings: Finding[];
	let counts: Counts;
	try {
		previousTo = (ro.workload(STANDING_WORKLOAD_ID) ? reportEntries(ro.entries(STANDING_WORKLOAD_ID, "assumption")).at(-1)?.to : undefined) ?? null;
		window = reportWindow(previousTo, now);
		const span: Window = { from: window.from, to: window.to };
		findings = deps.runDetectors(await deps.readDetectorInputs({ ledger: ro, home: args.home, profile, window: span }), span);
		counts = computeCounts(readCountRows(ro, nowIso), span);
	} catch (e) {
		return failed(`the ledger, the detectors or the counts could not be read (${e instanceof Error ? e.message : String(e)}); nothing written`);
	} finally {
		ro.close();
	}

	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const reportPath = join(reportDir(args.home), `${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${process.pid}.md`);
	const report = render({ date, nowIso, dryRun: args.dryRun, ledgerPath, profile, window, previousTo, findings, counts });
	const body = entryBody(date, window, findings, counts, reportPath);
	const w: Window = { from: window.from, to: window.to };
	if (args.dryRun) return { exit: 0, report, reportPath: null, entry: null, body, window: w, ledgerLine: `would write on ${STANDING_WORKLOAD_ID}: ${body}` };

	try {
		mkdirSync(reportDir(args.home), { recursive: true });
		writeFileSync(reportPath, report);
	} catch (e) {
		rmSync(reportPath, { force: true });
		return { ...failed(`the report ${reportPath} could not be written (${e instanceof Error ? e.message : String(e)}); no entry written`, w), report };
	}
	let entry: string | null;
	let existing: string | null = null;
	try {
		const rw = Ledger.open(ledgerPath, { backupOnOpen: false, ...(args.now ? { clock: () => nowIso } : {}) });
		try {
			entry = rw.write(() => {
				ensureStandingWorkload(rw);
				// Re-read under the write lock: two runs on the same date write one entry.
				const same = reportEntries(rw.entries(STANDING_WORKLOAD_ID, "assumption")).find((r) => r.date === date);
				if (same) {
					existing = same.id;
					return null;
				}
				hooks.inLock?.();
				return rw.recordEntry({ by: DAILY_REPORT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
			});
		} finally {
			rw.close();
		}
	} catch (e) {
		rmSync(reportPath, { force: true });
		return { ...failed(`the entry could not be written (${e instanceof Error ? e.message : String(e)}); this run's file ${reportPath} removed`, w), report, body };
	}
	if (entry === null) {
		rmSync(reportPath, { force: true });
		return { exit: 0, report, reportPath: null, entry: null, body, window: w, ledgerLine: `${date} already has its entry (${existing}); this run's file removed, nothing written` };
	}
	return { exit: 0, report, reportPath, entry, body, window: w, ledgerLine: `wrote ${entry} on ${STANDING_WORKLOAD_ID}: ${body}` };
}

/**
 * This process's peak RSS in MiB. maxRSS is bytes under Bun 1.3 on darwin (observed within 0.1 % of memoryUsage().rss) and
 * KiB under Node: a KiB figure is about 1/1024 of the RSS in bytes, so one under 1/64 of it is read as KiB. A bytes figure
 * sampled a little before the current RSS grew can sit just under it, so the larger of the two is the peak.
 */
export function peakRssMib(): number {
	const max = process.resourceUsage().maxRSS;
	const rss = process.memoryUsage().rss;
	const bytes = Math.max(max < rss / 64 ? max * 1024 : max, rss);
	return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const args = parseArgs(argv);
	if (typeof args === "string") {
		process.stderr.write(`daily-report: ${args}\n${USAGE}\n`);
		return 2;
	}
	const [read, detectors] = await Promise.all([import("../src/selfheal/read"), import("../src/selfheal/detectors")]);
	const r = await dailyReport({ ...args, home: resolve(args.home) }, process.env, { readDetectorInputs: read.readDetectorInputs, runDetectors: detectors.runDetectors });
	if (r.report) process.stdout.write(r.report);
	process.stdout.write(`ledger: ${r.ledgerLine}\n`);
	if (r.reportPath) process.stdout.write(`report: ${r.reportPath}\n`);
	if (r.exit !== 0) process.stderr.write(`daily-report: ${r.ledgerLine}\n`);
	process.stdout.write(`peak RSS: ${peakRssMib()} MiB\n`);
	return r.exit;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
