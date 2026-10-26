// The five flow signals (PLAN wl-mv654hoqwpfhmo § 3a, R38; Jo's flow ruling of 2026-10-19, in-mvfiyyv2kuha80): open
// workloads, quiet 24 h, dead and not relaunched, questions per day and provider errors per day, each computed with the
// query ROOT-CAUSE § 5 gives for it and red or green at the threshold written there
// (~/agent-scratch/agent-system-2.0/stuck-analysis/ROOT-CAUSE.md, "## 5. Early warning: five signals to watch daily").
// Net flow (query 1) is shown beside them with no colour and is not counted in `green <k>/5`: Jo's five do not name it.
//
// The queries are ROOT-CAUSE's as written, with `'now'` replaced by the as-of instant: each 24 h window runs from as-of
// minus 24 h to as-of (an upper bound ROOT-CAUSE's `now` did not need; the same rows when as-of is now), and the open,
// quiet and dead counts read workload status as it is in the file, as ROOT-CAUSE's do. Net flow is the previous full
// Pacific day: its boundaries are computed here with the zone database (`Intl`, America/Los_Angeles), not ROOT-CAUSE's
// fixed `'-7 hours'`, so a day across the November DST change is 25 h and every noon is noon Pacific whatever the
// machine's zone.
//
// Once per Pacific date one `flow-signals:` entry on the standing workload, by FLOW_SIGNALS_BY (surface/src/launch.ts),
// records the day's signals:
//   flow-signals: <date> open <n>/<t> quiet <n>/<t> dead <n>/<t> questions <n>/<t> provider <errors>,<skips>/0,5
//     net <opened>-<closed> green <k>/5 streak <d> cap <n> cap-source env|default source timer|fallback[ late]
// written by the orchestrator's invariant timer at its first tick at or after 12:00 Pacific (surface/extensions/wake.ts), or by
// the fallback job past 12:30 (surface/scripts/flow-signals.ts). `writeFlowSignals` checks "no entry for this date" and
// inserts in one write transaction, so the two writers racing on a date write one line. The streak counts consecutive Pacific
// dates ending today whose line says `green 5/5`, today's included; a date with no line breaks it. A line written after
// 13:00 Pacific ends ` late`. Nothing here reads a clock or the environment: callers pass as-of and the cap.
import type { Database } from "bun:sqlite";
import type { EntryRow, Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "./identity";
import { FLOW_SIGNALS_BY } from "./launch";
import { STANDING_WORKLOAD_ID } from "./types";

/** The invariants (surface/scripts/invariants.ts) a red signal is reported as; the invariant timer never tells these one by one. */
export const FLOW_INVARIANTS = ["flow-open", "flow-quiet", "flow-dead", "flow-questions", "flow-provider"] as const;
export type FlowInvariant = (typeof FLOW_INVARIANTS)[number];

export const FLOW_PREFIX = "flow-signals:";
export const PACIFIC = "America/Los_Angeles";

// ---- thresholds: ROOT-CAUSE § 5, changed only by a PR ------------------------------------------------
/** Query 2, "Started work against the lane cap": red when open workloads > OPEN_CAP_FACTOR × the live lane cap. */
export const OPEN_CAP_FACTOR = 2;
/** Query 3, "Stalled by progress, and dead without relaunch": each red when ≥ QUIET_DEAD_CAP_FACTOR × the live lane cap. */
export const QUIET_DEAD_CAP_FACTOR = 1;
/** Query 3's "quiet": no real progress (slices, questions, instructions, routings, non-lease workload changes) for this long. */
export const QUIET_MS = 24 * 3_600_000;
/** Query 4, "Questions to Jo in 24 hours": red above this many. */
export const QUESTIONS_24H_MAX = 20;
/** Query 5, "Provider health": red on more than this many provider-error messages in 24 h (any one). */
export const PROVIDER_ERRORS_MAX = 0;
/** Query 5: red on more than this many `headroom-skip:` entries in 24 h. */
export const HEADROOM_SKIPS_MAX = 5;
/** Every 24 h window ends at as-of. */
export const WINDOW_MS = 24 * 3_600_000;

// ---- trigger times, seconds after Pacific midnight -------------------------------------------------------
/** The timer writes at its first tick at or after 12:00 Pacific. */
export const NOON_S = 12 * 3600;
/** The fallback writes only past 12:30 Pacific. */
export const FALLBACK_AFTER_S = 12 * 3600 + 30 * 60;
/** A line written after 13:00 Pacific is marked `late`. */
export const LATE_AFTER_S = 13 * 3600;

// ---- the queries (ROOT-CAUSE § 5, `'now'` → :asOf) ----------------------------------------------------
const OPEN_SQL = `SELECT count(*) AS n FROM workloads WHERE status = 'open' AND id <> 'wl-orchestrator'`;
const QUIET_DEAD_SQL = `WITH o AS (SELECT w.id,
  (SELECT max(at) FROM provenance p WHERE p.workload_id = w.id AND p.at <= :asOf AND (p.tbl IN ('slices','questions','instructions','routings') OR (p.tbl = 'workloads' AND coalesce(p.detail,'') NOT LIKE 'lease %'))) real_last,
  (SELECT max(created_at) FROM messages m WHERE m.workload_id = w.id AND m.created_at <= :asOf AND m.body LIKE 'lane-died%') died,
  (SELECT max(created_at) FROM entries e WHERE e.workload_id = w.id AND e.created_at <= :asOf AND e.body LIKE 'launch:%') launched
  FROM workloads w WHERE w.status = 'open' AND w.id <> 'wl-orchestrator')
SELECT coalesce(sum(real_last IS NULL OR real_last < :quietSince), 0) AS quiet, coalesce(sum(died IS NOT NULL AND died >= launched), 0) AS dead FROM o`;
const QUESTIONS_SQL = `SELECT count(*) AS n FROM questions WHERE created_at >= :since AND created_at <= :asOf`;
const PROVIDER_SQL = `SELECT (SELECT count(*) FROM messages WHERE created_at >= :since AND created_at <= :asOf AND (body LIKE '%429%' OR body LIKE '%insufficient balance%' OR body LIKE '%exceeded_current_quota%' OR body LIKE '%usage limit%')) AS errors,
  (SELECT count(*) FROM entries WHERE created_at >= :since AND created_at <= :asOf AND body LIKE 'headroom-skip:%') AS skips`;
const NET_SQL = `SELECT (SELECT count(*) FROM workloads WHERE created_at >= :from AND created_at < :to) AS opened,
  (SELECT count(*) FROM workloads WHERE closed_at >= :from AND closed_at < :to) AS closed`;

export interface Count {
	n: number;
	/** The threshold shown after the slash. */
	t: number;
	red: boolean;
}

export interface FlowSignals {
	asOf: string;
	/** The lane cap the thresholds were computed with. */
	cap: number;
	/** The Pacific date of as-of. */
	date: string;
	open: Count;
	quiet: Count;
	dead: Count;
	questions: Count;
	provider: { errors: number; skips: number; red: boolean };
	/** Query 1 over the previous full Pacific day; no colour. */
	net: { day: string; opened: number; closed: number };
	/** Green signals of the five. */
	green: number;
	/** Each signal's query with its parameters inlined, pasteable into `sqlite3 -readonly`. */
	queries: Record<FlowInvariant | "flow-net", string>;
}

/** `sql` with each `:name` parameter replaced by its quoted value. */
function inline(sql: string, params: Record<string, string>): string {
	let shown = sql.replace(/\s+/g, " ").trim();
	for (const [k, v] of Object.entries(params).sort((a, b) => b[0].length - a[0].length)) shown = shown.replaceAll(k, `'${v.replaceAll("'", "''")}'`);
	return shown;
}

/** The five signals and net flow over the ledger `db` at `asOf`, with the live lane cap `cap`. */
export function flowSignals(db: Database, asOf: string, cap: number): FlowSignals {
	const at = Date.parse(asOf);
	const since = new Date(at - WINDOW_MS).toISOString();
	const quietSince = new Date(at - QUIET_MS).toISOString();
	const date = pacificDate(asOf);
	const day = addDays(date, -1);
	const from = pacificMidnight(day);
	const to = pacificMidnight(date);
	const get = <T>(sql: string, params: Record<string, string>): T => db.query(sql).get(params as never) as T;

	const open = get<{ n: number }>(OPEN_SQL, {}).n;
	const qd = get<{ quiet: number; dead: number }>(QUIET_DEAD_SQL, { ":asOf": asOf, ":quietSince": quietSince });
	const questions = get<{ n: number }>(QUESTIONS_SQL, { ":since": since, ":asOf": asOf }).n;
	const provider = get<{ errors: number; skips: number }>(PROVIDER_SQL, { ":since": since, ":asOf": asOf });
	const net = get<{ opened: number; closed: number }>(NET_SQL, { ":from": from, ":to": to });

	const openT = OPEN_CAP_FACTOR * cap;
	const qdT = QUIET_DEAD_CAP_FACTOR * cap;
	const signals = {
		open: { n: open, t: openT, red: open > openT },
		quiet: { n: qd.quiet, t: qdT, red: qd.quiet >= qdT },
		dead: { n: qd.dead, t: qdT, red: qd.dead >= qdT },
		questions: { n: questions, t: QUESTIONS_24H_MAX, red: questions > QUESTIONS_24H_MAX },
		provider: { errors: provider.errors, skips: provider.skips, red: provider.errors > PROVIDER_ERRORS_MAX || provider.skips > HEADROOM_SKIPS_MAX },
	};
	const green = Object.values(signals).filter((s) => !s.red).length;
	return {
		asOf, cap, date, ...signals,
		net: { day, opened: net.opened, closed: net.closed },
		green,
		queries: {
			"flow-open": inline(OPEN_SQL, {}),
			"flow-quiet": inline(QUIET_DEAD_SQL, { ":asOf": asOf, ":quietSince": quietSince }),
			"flow-dead": inline(QUIET_DEAD_SQL, { ":asOf": asOf, ":quietSince": quietSince }),
			"flow-questions": inline(QUESTIONS_SQL, { ":since": since, ":asOf": asOf }),
			"flow-provider": inline(PROVIDER_SQL, { ":since": since, ":asOf": asOf }),
			"flow-net": inline(NET_SQL, { ":from": from, ":to": to }),
		},
	};
}

/** Each red signal as `[invariant, text]`, in the five's order. */
export function redSignals(f: FlowSignals): [FlowInvariant, string][] {
	const out: [FlowInvariant, string][] = [];
	if (f.open.red) out.push(["flow-open", `${f.open.n} open workloads (the standing one excepted) is more than ${OPEN_CAP_FACTOR} × the lane cap ${f.cap} (${f.open.t}): work is started faster than lanes can carry it (ROOT-CAUSE § 5, signal 2).`]);
	if (f.quiet.red) out.push(["flow-quiet", `${f.quiet.n} open workloads made no real progress in 24 h, at or over the lane cap ${f.cap} (ROOT-CAUSE § 5, signal 3).`]);
	if (f.dead.red) out.push(["flow-dead", `${f.dead.n} open workloads have a lane-died newer than their last launch, at or over the lane cap ${f.cap} (ROOT-CAUSE § 5, signal 3).`]);
	if (f.questions.red) out.push(["flow-questions", `${f.questions.n} questions raised in the 24 h to ${f.asOf}, more than ${QUESTIONS_24H_MAX} (ROOT-CAUSE § 5, signal 4).`]);
	if (f.provider.red) out.push(["flow-provider", `${f.provider.errors} provider-error message(s) and ${f.provider.skips} headroom-skip entries in the 24 h to ${f.asOf} (red on any error or more than ${HEADROOM_SKIPS_MAX} skips; ROOT-CAUSE § 5, signal 5).`]);
	return out;
}

// ---- Pacific time ---------------------------------------------------------------------------------------

const PARTS = new Intl.DateTimeFormat("en-US", {
	timeZone: PACIFIC, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function pacificParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
	const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** The Pacific calendar date (`YYYY-MM-DD`) of an instant. */
export function pacificDate(iso: string): string {
	const p = pacificParts(Date.parse(iso));
	return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Seconds since Pacific midnight at an instant (0 … 86399). */
export function pacificSeconds(iso: string): number {
	const p = pacificParts(Date.parse(iso));
	return p.h * 3600 + p.mi * 60 + p.s;
}

/** The UTC instant (ISO) of 00:00 Pacific on `date`. Pacific midnight never falls in a DST gap (the changes are at 02:00). */
export function pacificMidnight(date: string): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const base = Date.UTC(y, m - 1, d);
	// The zone's offset at an instant: the wall clock read as UTC, minus the instant.
	const offset = (t: number): number => {
		const p = pacificParts(t);
		return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t;
	};
	let t = base + 8 * 3_600_000;
	for (let i = 0; i < 2; i++) t = base - offset(t);
	return new Date(t).toISOString();
}

/** `date` moved by `days` calendar days. */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ---- the line -------------------------------------------------------------------------------------------

/** Where a written line's cap came from. A dry-run's printed line may also say `flag` (`--cap <n>`); no written line does. */
export type CapSource = "env" | "default";
export type LineSource = "timer" | "fallback";

const LINE = /^flow-signals:\s+(\d{4}-\d{2}-\d{2})\s/;
const GREEN = /\sgreen (\d+)\/5\s/;
const CAP = /\scap (\d+) cap-source (env|default)\b/;

/** The `flow-signals:` entries FLOW_SIGNALS_BY wrote on the standing workload, oldest first. */
export function flowEntries(entries: readonly EntryRow[]): EntryRow[] {
	return entries.filter((e) => e.kind === "assumption" && e.created_by === FLOW_SIGNALS_BY && LINE.test(e.body));
}

/** The Pacific date a `flow-signals:` body is for, or null. */
export function lineDate(body: string): string | null {
	return LINE.exec(body)?.[1] ?? null;
}

/** The cap and its source the newest of `entries` (FLOW_SIGNALS_BY's lines) recorded, or null when none did. */
export function recordedCap(entries: readonly EntryRow[]): { cap: number; source: CapSource } | null {
	for (const e of flowEntries(entries).toReversed()) {
		const m = CAP.exec(e.body);
		if (m) return { cap: Number(m[1]), source: m[2] as CapSource };
	}
	return null;
}

/**
 * Consecutive Pacific dates ending `date` whose line says `green 5/5`, today's (`todayGreen`) included: 0 when today is not
 * green, 1 on a first green line; a date with no line (or a line not green) ends the count.
 */
export function streak(date: string, todayGreen: boolean, prior: readonly EntryRow[]): number {
	if (!todayGreen) return 0;
	const green = new Map<string, boolean>();
	for (const e of flowEntries(prior)) {
		const d = lineDate(e.body)!;
		if (!green.has(d)) green.set(d, GREEN.exec(e.body)?.[1] === "5");
	}
	let n = 1;
	for (let d = addDays(date, -1); green.get(d) === true; d = addDays(d, -1)) n++;
	return n;
}

/** The `flow-signals:` body for `f`, with its streak read from `prior` (FLOW_SIGNALS_BY's earlier lines); `flag` only for a dry-run's printed line. */
export function flowLine(f: FlowSignals, o: { capSource: CapSource | "flag"; source: LineSource; prior: readonly EntryRow[] }): string {
	const c = (x: Count) => `${x.n}/${x.t}`;
	const late = pacificSeconds(f.asOf) > LATE_AFTER_S ? " late" : "";
	return `${FLOW_PREFIX} ${f.date} open ${c(f.open)} quiet ${c(f.quiet)} dead ${c(f.dead)} questions ${c(f.questions)}`
		+ ` provider ${f.provider.errors},${f.provider.skips}/${PROVIDER_ERRORS_MAX},${HEADROOM_SKIPS_MAX} net ${f.net.opened}-${f.net.closed}`
		+ ` green ${f.green}/5 streak ${streak(f.date, f.green === 5, o.prior)} cap ${f.cap} cap-source ${o.capSource} source ${o.source}${late}`;
}

/**
 * Write `f`'s line on the standing workload unless its Pacific date already has one: the check and the insert run in one
 * write transaction (BEGIN IMMEDIATE, the pattern of surface/scripts/scratch-sweep.ts), so two writers racing on a date write
 * one line. Returns the entry id written (null when the date had one) and the body.
 */
export function writeFlowSignals(ledger: Ledger, f: FlowSignals, o: { capSource: CapSource; source: LineSource }): { entry: string | null; body: string } {
	let body = "";
	const entry = ledger.write(() => {
		ensureStandingWorkload(ledger);
		const prior = flowEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"));
		body = flowLine(f, { ...o, prior });
		if (prior.some((e) => lineDate(e.body) === f.date)) return null;
		return ledger.recordEntry({ by: FLOW_SIGNALS_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
	});
	return { entry, body };
}
