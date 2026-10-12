// The nightly chaos run's alert (PLAN wl-mv5lpzqacbe5ts §§ 2.1–2.3): the files the nightly run
// leaves under R = <HOME>/agent-scratch/agent-system-2.0/chaos, and the surface's reconciler that
// turns a night that failed, crashed or never ran into one `chaos-failed:` message on the standing
// workload, which surface/src/errors.ts shows once as a needs-you line. Chaos itself never writes
// the live ledger: the only writer of the alert is the surface (`SURFACE_BY`), a live actor, so the
// next run's isolation diff lists the rows and does not fail them (§ 2.3).
//
// The files, all in R/nightly:
// - `<PT date>-<fault>[-HHMM[-n]].md`: a nightly report, published by `publishReport` (written to
//   `<name>.md.tmp`, then renamed), so a listing of `*.md` never sees half a report. Its verdict is
//   the `- verdict: **X** — reason` line surface/src/chaos.ts `renderReport` writes.
// - `<PT date>.attempt`: JSON `{ startedAt, fault, pid }`, written by `writeAttemptMarker` (temp
//   file, then rename) once `--nightly` is due and before the run starts. No run token, no scratch
//   path. It tells "started and left no report" (CRASHED) from "never started" (MISSED).
// - `arming.log`: the append-only arming history install/install.sh writes, one `on|off <UTC ISO Z>`
//   line per change. Armed intervals are its `[on, off)` pairs; a last `on` with no `off` is open.
//
// Pure: the path helpers, `parseArmingLog`, `parseReportVerdict`, `chaosObligations`,
// `chaosFailedBody` / `parseChaosFailed`. Read-only: `readNightly`, `alertedDates`. Writers:
// `writeAttemptMarker` and `publishReport` (the run side, surface/scripts/chaos.ts), and
// `recordChaosAlerts`, the surface's reconciler, called before every surface read
// (surface/extensions/wake.ts): with no `arming.log` it does nothing; it computes what is owed outside
// any transaction and opens one `ledger.write` only when something is.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { NIGHTLY_END_MINUTE, NIGHTLY_START_MINUTE, nightlyFault, ptParts, type VerdictKind } from "./chaos";
import { ensureStandingWorkload } from "./identity";
import {
	CHAOS_ARMING_LOG, CHAOS_FAILED_PREFIX, CHAOS_GRACE_MS, CHAOS_LAUNCHD_LOG, CHAOS_NIGHTLY_DIR, CHAOS_ROOT_RELATIVE, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY,
} from "./types";

// ---- paths (§ 2.1) ------------------------------------------------------------------------------

/** R, the chaos root under a HOME: `<home>/agent-scratch/agent-system-2.0/chaos`. */
export const chaosRoot = (home: string): string => join(home, CHAOS_ROOT_RELATIVE);
/** `R/nightly`, the nightly-only dir: reports, attempt markers and `arming.log`. */
export const nightlyDir = (root: string): string => join(root, CHAOS_NIGHTLY_DIR);
/** `R/nightly/arming.log`. */
export const armingLogPath = (root: string): string => join(nightlyDir(root), CHAOS_ARMING_LOG);
/** `R/nightly/<PT date>.attempt`. */
export const attemptPath = (root: string, day: string): string => join(nightlyDir(root), `${day}.attempt`);
/** `R/launchd.log`, where launchd sends the nightly job's output (install/com.agent-system-2.chaos.plist). */
export const launchdLogPath = (root: string): string => join(root, CHAOS_LAUNCHD_LOG);

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date `YYYY-MM-DD` (not `2026-02-30`). */
function isCalendarDay(day: string): boolean {
	const m = DAY.exec(day);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === day;
}

/** The calendar day after `day`. */
function nextDay(day: string): string {
	const m = DAY.exec(day)!;
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}

// ---- the run side's writers (§ 2.1) -------------------------------------------------------------

/** The attempt marker's content: when the nightly run started, its fault and its pid. */
export interface AttemptMarker {
	startedAt: string;
	fault: string;
	pid: number;
}

/** Write `data` to `path` atomically: `<path>.tmp`, then rename over `path`. The directory is made when missing. */
function writeAtomic(path: string, data: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

/** Write `R/nightly/<day>.attempt` (temp file, then rename); returns its path. */
export function writeAttemptMarker(root: string, day: string, marker: AttemptMarker): string {
	if (!isCalendarDay(day)) throw new Error(`not a YYYY-MM-DD date: ${day}`);
	const path = attemptPath(root, day);
	writeAtomic(path, `${JSON.stringify({ startedAt: marker.startedAt, fault: marker.fault, pid: marker.pid })}\n`);
	return path;
}

/** Publish a report at `path` (`….md`): written to `<path>.tmp`, then renamed, so a `*.md` listing never sees half of it. */
export function publishReport(path: string, text: string): void {
	if (!path.endsWith(".md")) throw new Error(`a report path ends in .md: ${path}`);
	writeAtomic(path, text);
}

// ---- arming.log (§ 2.1, § 2.2) ------------------------------------------------------------------

/** One `arming.log` line, strictly: `on` or `off`, one space, a UTC second-precision ISO time with `Z` (`date -u +%Y-%m-%dT%H:%M:%SZ`). */
export const ARMING_LINE = /^(on|off) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/;

/** An armed interval `[on, off)`; `off` null while it is still open. */
export interface ArmedInterval {
	on: string;
	off: string | null;
}

export interface ArmingLog {
	intervals: ArmedInterval[];
	/** Lines that are not `ARMING_LINE` (or name no real instant), 1-based, skipped. */
	malformed: { line: number; text: string }[];
}

/**
 * The armed intervals in `arming.log`'s text. Strict: a line that is not `on|off <UTC ISO Z>`, or
 * whose time is not a real instant, is skipped and returned in `malformed`. A second `on` while one
 * is open keeps the first; an `off` with no open interval is ignored; a last `on` stays open.
 */
export function parseArmingLog(text: string): ArmingLog {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const intervals: ArmedInterval[] = [];
	const malformed: { line: number; text: string }[] = [];
	let open: string | null = null;
	lines.forEach((raw, i) => {
		const m = ARMING_LINE.exec(raw);
		const at = m ? Date.parse(m[2]!) : Number.NaN;
		if (!m || !Number.isFinite(at) || new Date(at).toISOString() !== m[2]!.replace("Z", ".000Z")) {
			malformed.push({ line: i + 1, text: raw });
			return;
		}
		if (m[1] === "on") {
			open ??= m[2]!;
			return;
		}
		if (open !== null) {
			intervals.push({ on: open, off: m[2]! });
			open = null;
		}
	});
	if (open !== null) intervals.push({ on: open, off: null });
	return { intervals, malformed };
}

// ---- the nightly listing (§ 2.2) ----------------------------------------------------------------

/** A report's verdict line as surface/src/chaos.ts `renderReport` writes it: `- verdict: **X** — reason`. */
const VERDICT_LINE = /^- verdict: \*\*(PASS|FAIL|HARNESS-ERROR)\*\* — (.*)$/m;
/** `<PT date>-<fault>.md`, or with the `-HHMM` / `-HHMM-n` suffix `reportPath` adds on a clash. */
const REPORT_NAME = /^(\d{4}-\d\d-\d\d)-(.+?)(?:-\d{4}(?:-\d+)?)?\.md$/;
const ATTEMPT_NAME = /^(\d{4}-\d\d-\d\d)\.attempt$/;
/** How much of a report is read for its verdict line (the third line; observed up to ~2 KB). */
const REPORT_HEAD_BYTES = 16 * 1024;

export interface ReportVerdict {
	verdict: VerdictKind;
	reason: string;
}

/** The verdict and reason of a report's text (its first `- verdict:` line), or null when none parses. */
export function parseReportVerdict(text: string): ReportVerdict | null {
	const m = VERDICT_LINE.exec(text);
	return m ? { verdict: m[1] as VerdictKind, reason: m[2]!.trim() } : null;
}

export interface NightlyReport {
	day: string;
	fault: string;
	name: string;
	path: string;
	mtimeMs: number;
	/** The parsed verdict line; null when none parses, the file could not be read, or its day was skipped (`readNightly`). */
	verdict: ReportVerdict | null;
}

export interface NightlyAttempt {
	day: string;
	path: string;
	/** The marker's fields; null each when the marker does not hold them (it still counts as an attempt). */
	startedAt: string | null;
	fault: string | null;
	pid: number | null;
}

export interface NightlyListing {
	/** Where a CRASHED or MISSED alert points: launchd's log of the job. */
	launchdLog: string;
	reports: NightlyReport[];
	attempts: NightlyAttempt[];
}

/** A missing file or directory on the way to it: the thing is absent, not broken. */
const gone = (err: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((err as { code?: string } | null)?.code ?? "");

function readHead(path: string): string {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(REPORT_HEAD_BYTES);
		const n = readSync(fd, buf, 0, REPORT_HEAD_BYTES, 0);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * The listing of `R/nightly` (read-only): every `*.md` report with its parsed verdict and every
 * `*.attempt` marker; temp files and anything else are not listed, nor a name whose date is not a
 * real one. A report of a day in `skip` (the days already alerted, which are never judged again) is
 * listed without being opened. An entry that vanished between the listing and its read is left out;
 * a report that cannot be read has no verdict.
 */
export function readNightly(root: string, skip: ReadonlySet<string> = new Set()): NightlyListing {
	const dir = nightlyDir(root);
	const listing: NightlyListing = { launchdLog: launchdLogPath(root), reports: [], attempts: [] };
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch (err) {
		if (gone(err)) return listing;
		throw err;
	}
	for (const name of names) {
		const path = join(dir, name);
		const report = REPORT_NAME.exec(name);
		if (report && isCalendarDay(report[1]!)) {
			const day = report[1]!;
			let mtimeMs: number;
			try {
				mtimeMs = statSync(path).mtimeMs;
			} catch (err) {
				if (gone(err)) continue;
				throw err;
			}
			let verdict: ReportVerdict | null = null;
			if (!skip.has(day)) {
				try {
					verdict = parseReportVerdict(readHead(path));
				} catch (err) {
					if (gone(err)) continue;
				}
			}
			listing.reports.push({ day, fault: report[2]!, name, path, mtimeMs, verdict });
			continue;
		}
		const attempt = ATTEMPT_NAME.exec(name);
		if (attempt && isCalendarDay(attempt[1]!)) {
			let fields: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (parsed && typeof parsed === "object") fields = parsed as Record<string, unknown>;
			} catch (err) {
				if (gone(err)) continue;
			}
			listing.attempts.push({
				day: attempt[1]!, path,
				startedAt: typeof fields.startedAt === "string" ? fields.startedAt : null,
				fault: typeof fields.fault === "string" ? fields.fault : null,
				pid: typeof fields.pid === "number" ? fields.pid : null,
			});
		}
	}
	return listing;
}

// ---- the obligations (§ 2.2, pure) --------------------------------------------------------------

/** What an alerted night resolved to: the run's own non-PASS verdict, or what the files say happened. */
export const CHAOS_ALERT_VERDICTS = ["FAIL", "HARNESS-ERROR", "UNREADABLE", "CRASHED", "MISSED"] as const;
export type ChaosAlertVerdict = (typeof CHAOS_ALERT_VERDICTS)[number];

/** One owed night that did not pass: the body of one `chaos-failed:` message. */
export interface ChaosAlert {
	/** The PT date of the night. */
	day: string;
	fault: string | null;
	verdict: ChaosAlertVerdict;
	/** The report (FAIL, HARNESS-ERROR, UNREADABLE) or launchd's log (CRASHED, MISSED). */
	report: string | null;
	reason: string;
}

export interface ChaosObligationsInput {
	/** ISO instant. */
	now: string;
	intervals: readonly ArmedInterval[];
	nightly: NightlyListing;
	/** The PT dates that already have a `chaos-failed:` message, in any state. */
	alerted: ReadonlySet<string>;
}

/** The instant of 03:00 PT (`NIGHTLY_START_MINUTE`) on the PT date `day`: the night's scheduled launch. */
export function launchInstant(day: string): number {
	const m = DAY.exec(day);
	if (!m) throw new Error(`not a YYYY-MM-DD date: ${day}`);
	// PT is UTC-7 (PDT) or UTC-8 (PST); 03:00 exists exactly once on every PT date, DST days included.
	for (const offsetHours of [7, 8]) {
		const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), offsetHours, NIGHTLY_START_MINUTE);
		const p = ptParts(new Date(t));
		if (p.day === day && p.minuteOfDay === NIGHTLY_START_MINUTE) return t;
	}
	throw new Error(`no ${NIGHTLY_START_MINUTE / 60}:00 PT on ${day}`);
}

/** When a night is judged: the end of the nightly window (03:15 PT) plus `CHAOS_GRACE_MS`. */
export function judgedAt(day: string): number {
	return launchInstant(day) + (NIGHTLY_END_MINUTE - NIGHTLY_START_MINUTE) * 60_000 + CHAOS_GRACE_MS;
}

const newestLast = (a: NightlyReport, b: NightlyReport): number => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name);

/**
 * The nights owed and not yet alerted that did not pass, oldest first (pure; § 2.2). Call it only
 * when `arming.log` exists. A PT date D is owed when D's 03:00 PT launch instant lies in an armed
 * interval (`on ≤ t < off`), or when `nightly` holds an attempt marker or a report for D whatever the
 * intervals say. D is judged once 03:15 PT plus `CHAOS_GRACE_MS` is at or before `now`, and resolves:
 * - reports, every one PASS → nothing;
 * - reports, any not PASS → the newest non-PASS one: its FAIL or HARNESS-ERROR with its reason, or
 *   UNREADABLE when no verdict line parses; the alert names that report;
 * - no report, an attempt marker → CRASHED ("started <t>, pid <p>, no report after 2 h");
 * - neither → MISSED, naming the newest nightly report seen.
 * CRASHED and MISSED name launchd's log. One alert per night, never collapsed.
 */
export function chaosObligations(input: ChaosObligationsInput): ChaosAlert[] {
	const nowMs = Date.parse(input.now);
	if (!Number.isFinite(nowMs)) throw new Error(`not an instant: ${input.now}`);
	const { nightly, alerted } = input;
	const owed = new Set<string>();
	for (const iv of input.intervals) {
		const on = Date.parse(iv.on);
		const off = iv.off === null ? Number.POSITIVE_INFINITY : Date.parse(iv.off);
		const until = Math.min(off, nowMs);
		if (!(until >= on)) continue;
		const last = ptParts(new Date(until)).day;
		for (let day = ptParts(new Date(on)).day; day <= last; day = nextDay(day)) {
			const t = launchInstant(day);
			if (on <= t && t < off) owed.add(day);
		}
	}
	for (const r of nightly.reports) owed.add(r.day);
	for (const a of nightly.attempts) owed.add(a.day);

	const out: ChaosAlert[] = [];
	for (const day of [...owed].sort()) {
		if (alerted.has(day) || judgedAt(day) > nowMs) continue;
		const reports = nightly.reports.filter((r) => r.day === day).sort(newestLast);
		if (reports.length > 0) {
			const failed = reports.filter((r) => r.verdict?.verdict !== "PASS").at(-1);
			if (!failed) continue;
			out.push(failed.verdict
				? { day, fault: failed.fault, verdict: failed.verdict.verdict as ChaosAlertVerdict, report: failed.path, reason: failed.verdict.reason }
				: { day, fault: failed.fault, verdict: "UNREADABLE", report: failed.path, reason: "no `- verdict: **X** — reason` line parses in the report" });
			continue;
		}
		const attempt = nightly.attempts.find((a) => a.day === day);
		if (attempt) {
			out.push({
				day, fault: attempt.fault ?? nightlyFault(day), verdict: "CRASHED", report: nightly.launchdLog,
				reason: `started ${attempt.startedAt ?? "(time not recorded)"}, pid ${attempt.pid ?? "(not recorded)"}, no report after ${CHAOS_GRACE_MS / 3_600_000} h`,
			});
			continue;
		}
		const seen = [...nightly.reports].sort(newestLast).at(-1);
		out.push({
			day, fault: nightlyFault(day), verdict: "MISSED", report: nightly.launchdLog,
			reason: `did not start: no attempt marker and no report; newest nightly report seen: ${seen ? seen.path : "none"}`,
		});
	}
	return out;
}

// ---- the body (§ 2.2) ---------------------------------------------------------------------------

/** How much of the reason the body keeps, on one line. */
export const CHAOS_REASON_MAX = 300;

/** `chaos-failed: <PT date> <fault|-> <VERDICT> report <path|->: <reason ≤300, one line>`. */
export function chaosFailedBody(a: ChaosAlert): string {
	const fault = a.fault === null || a.fault.trim() === "" ? "-" : a.fault.replace(/\s+/g, "_");
	const report = a.report === null || a.report === "" ? "-" : a.report.replace(/[\r\n]+/g, " ");
	const reason = a.reason.replace(/\s+/g, " ").trim();
	return `${CHAOS_FAILED_PREFIX} ${a.day} ${fault} ${a.verdict} report ${report}: ${reason.length > CHAOS_REASON_MAX ? `${reason.slice(0, CHAOS_REASON_MAX - 1)}…` : reason}`;
}

const CHAOS_FAILED_BODY = new RegExp(`^${CHAOS_FAILED_PREFIX} (\\d{4}-\\d\\d-\\d\\d) (\\S+) (${CHAOS_ALERT_VERDICTS.join("|")}) report (.+?): (.*)$`);

/** A `chaos-failed:` body back into its alert, or null when the body is not one. */
export function parseChaosFailed(body: string): ChaosAlert | null {
	const m = CHAOS_FAILED_BODY.exec(body);
	if (!m || !isCalendarDay(m[1]!)) return null;
	return { day: m[1]!, fault: m[2] === "-" ? null : m[2]!, verdict: m[3] as ChaosAlertVerdict, report: m[4] === "-" ? null : m[4]!, reason: m[5]! };
}

// ---- the reconciler (§ 2.2, impure) -------------------------------------------------------------

/** The PT dates that already have a `chaos-failed:` message by `by` to the orchestrator on the standing workload, in any state. */
export function alertedDates(ledger: Ledger, by: string = SURFACE_BY): Set<string> {
	const rows = ledger.db.query<{ body: string }, [string, string, string, string]>(
		"SELECT body FROM messages WHERE workload_id = ? AND created_by = ? AND recipient = ? AND body LIKE ?",
	).all(STANDING_WORKLOAD_ID, by, ORCHESTRATOR_RECIPIENT, `${CHAOS_FAILED_PREFIX}%`);
	const out = new Set<string>();
	for (const r of rows) {
		const a = parseChaosFailed(r.body);
		if (a) out.add(a.day);
	}
	return out;
}

/** Malformed `arming.log` lines already reported by this process (`<path>\0<line>\0<text>`): each is reported once. */
const reportedMalformed = new Set<string>();

export interface RecordChaosAlertsOptions {
	/** Where a malformed `arming.log` line or a failed reconcile is reported; default the surface's stderr line. */
	log?: (line: string) => void;
}

/**
 * Persist each owed, failed night as one `chaos-failed:` message to the orchestrator on the standing
 * workload; returns the message ids written. HOME is `env.HOME` (the surface session's env). With no
 * `arming.log` under it, nothing further is read and nothing written. Otherwise the obligations are
 * computed from the files and a plain read of the alerted dates, outside any transaction; only when
 * something is owed does one `ledger.write` ensure the standing workload, re-read the alerted dates
 * and enqueue each alert still new, so two surfaces cannot both write a night. Never throws: an fs or
 * ledger error goes to the log and the caller's read goes on.
 */
export function recordChaosAlerts(ledger: Ledger, by: string, now: string, env: Record<string, string | undefined>, opts: RecordChaosAlertsOptions = {}): string[] {
	// The surface's error log: a `surface: …` line on stderr, as surface/extensions/wake.ts writes its tick failures.
	const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	try {
		const home = env.HOME;
		if (!home) return [];
		const root = chaosRoot(home);
		const armingPath = armingLogPath(root);
		let text: string;
		try {
			text = readFileSync(armingPath, "utf8");
		} catch (err) {
			if (gone(err)) return [];
			throw err;
		}
		const arming = parseArmingLog(text);
		for (const m of arming.malformed) {
			const key = `${armingPath}\0${m.line}\0${m.text}`;
			if (reportedMalformed.has(key)) continue;
			reportedMalformed.add(key);
			log(`surface: chaos alerts: ${armingPath} line ${m.line} is not "on|off <UTC ISO Z>" and was skipped: ${JSON.stringify(m.text)}`);
		}
		const alerted = alertedDates(ledger, by);
		const owed = chaosObligations({ now, intervals: arming.intervals, nightly: readNightly(root, alerted), alerted });
		if (owed.length === 0) return [];
		return ledger.write(() => {
			ensureStandingWorkload(ledger);
			const again = alertedDates(ledger, by);
			return owed.filter((a) => !again.has(a.day)).map((a) =>
				ledger.enqueue({ by, workloadId: STANDING_WORKLOAD_ID, sender: by, recipient: ORCHESTRATOR_RECIPIENT, body: chaosFailedBody(a) }));
		});
	} catch (err) {
		log(`surface: chaos alerts could not be reconciled: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}
