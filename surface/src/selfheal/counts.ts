/**
 * Self-heal Phase 1: the daily report's counts (PLAN wl-mvbcjageg7o2yo § 2.4), pure over rows already read
 * read-only from every workload, open and closed (surface/scripts/daily-report.ts reads them). Nothing here
 * writes: closed workloads take no rows, and a count is only ever reported.
 *
 * - Lane deaths in the window by cause, from the `lane-died:` body (surface/src/signals.ts, launch.ts,
 *   turn-end.ts): `lease lapsed`, `session shutdown`, `runner exit` (`<outcome> (exit <code>)` /
 *   `(signal <s>)`), `deadline`, `never-ready` (`launch failed at <stage>: …`, the runner's never-ready and
 *   launch-failure body), and `other: <first words>` for any body it does not know, so a cause added later is
 *   counted under its own words, not lost.
 * - Lapsed leases: the deaths in the window whose cause is `lease lapsed`, plus the open workloads whose
 *   lease has lapsed with no `lane-died:` row recording it yet (`unrecordedLapse`, read at the run).
 * - Held messages on closed workloads: no surface will ever render them (delivery reads open workloads only).
 * - Lane runs (§ 2.6): `lane-metrics:` rows in the window (runs, wall, run-delta dollars by model, peak RSS
 *   p50 and max), runner lanes that ended in the window with no `lane-metrics:` (unmetered: a killed runner),
 *   and interactive lanes (`lane-started:` by the starter), which are not metered in this phase.
 */
import { LANE_RUNNER_BY, LANE_STARTER_BY } from "../../../ledger/src/index";
import type { ControlEntry } from "../launch";
import type { Window } from "./types";

/** A `lane-died:` message, on any workload. */
export interface DeathRow {
	id: string;
	workloadId: string;
	body: string;
	createdAt: string;
}

/** An open workload whose holder's lease lapsed with no `lane-died:` row for it yet (`unrecordedLapse`). */
export interface LapseRow {
	workloadId: string;
	holder: string;
	leaseUntil: string;
}

/** A message still `held` on a closed workload. */
export interface HeldRow {
	id: string;
	workloadId: string;
	createdAt: string;
}

export interface CountRows {
	/** Every `lane-died:` message, any workload, any time. */
	deaths: readonly DeathRow[];
	unrecordedLapses: readonly LapseRow[];
	heldClosed: readonly HeldRow[];
	/** Valid `lane-started:`, `lane-exit:` and `lane-metrics:` control entries (`controlEntries`), any workload, any time. */
	lanes: readonly ControlEntry[];
}

/** The named causes, in report order; anything else is `other: <first words>`. */
export const DEATH_CAUSES = ["lease lapsed", "session shutdown", "runner exit", "deadline", "never-ready"] as const;

const DEATH_BODY = /^lane-died:\s*(\S+?):\s+([\s\S]*)$/;

/** The lane a `lane-died:` body names, or null. */
export function deathHolder(body: string): string | null {
	return DEATH_BODY.exec(body.trim())?.[1] ?? null;
}

/** Up to three leading words of `text`, stopping before a word with a digit and after a word ending in `:`. */
function firstWords(text: string): string {
	const out: string[] = [];
	for (const word of text.split(/\s+/).filter((w) => w !== "")) {
		if (out.length > 0 && /\d/.test(word)) break;
		const stop = /[:;,]$/.test(word);
		out.push(word.replace(/[:;,]+$/, ""));
		if (stop || out.length === 3) break;
	}
	return out.join(" ") || "?";
}

/** The cause of one death, from its `lane-died:` body. */
export function deathCause(body: string): string {
	const m = DEATH_BODY.exec(body.trim());
	const rest = (m ? m[2]! : body).trim();
	if (/^lease lapsed\b/.test(rest)) return "lease lapsed";
	if (/^session shutdown\b/.test(rest)) return "session shutdown";
	if (/^deadline\b/.test(rest)) return "deadline";
	if (/^launch failed at\b/.test(rest)) return "never-ready";
	if (/^[a-z-]+ \((?:exit|signal) [^)]*\)$/.test(rest)) return "runner exit";
	return `other: ${firstWords(rest)}`;
}

/** Whether `at` lies in the half-open window `[from, to)`. */
export function inWindow(at: string, w: Window): boolean {
	const t = Date.parse(at);
	return t >= Date.parse(w.from) && t < Date.parse(w.to);
}

export interface LaneRunCounts {
	/** `lane-metrics:` rows in the window. */
	runs: number;
	wallMin: number;
	/** Run-delta dollars by model (`ranModel`, else `model`, else `unknown`), largest first. */
	usdByModel: [string, number][];
	/** Over the rows that carry a peak RSS; null when none does. */
	peakRssMb: { p50: number; max: number; samples: number } | null;
	/** Runner lanes that ended in the window (a `lane-exit:` or a `lane-died:`) with no `lane-metrics:` row ever. */
	unmetered: string[];
	/** Lanes the starter started in the window (`as2 lane`): not metered in this phase. */
	interactive: string[];
}

export interface Counts {
	deaths: { total: number; byCause: [string, number][] };
	lapsed: { total: number; recorded: number; unrecorded: LapseRow[] };
	heldClosed: { total: number; inWindow: number; workloads: number };
	lanes: LaneRunCounts;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function laneRuns(rows: CountRows, w: Window, deathsInWindow: readonly DeathRow[]): LaneRunCounts {
	const metered = new Set<string>();
	const runner = new Set<string>();
	const ended = new Set<string>();
	const interactive = new Set<string>();
	const usd = new Map<string, number>();
	const rss: number[] = [];
	let runs = 0;
	let wallMin = 0;
	for (const c of rows.lanes) {
		if (c.laneId === null) continue;
		const here = inWindow(c.createdAt, w);
		if (c.prefix === "lane-metrics") {
			metered.add(c.laneId);
			if (!here) continue;
			let m: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(c.rest);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				m = parsed as Record<string, unknown>;
			} catch {
				continue;
			}
			runs++;
			wallMin += num(m.wallMin) ?? 0;
			const model = [m.ranModel, m.model].find((v): v is string => typeof v === "string" && v !== "") ?? "unknown";
			usd.set(model, (usd.get(model) ?? 0) + (num(m.usd) ?? 0));
			const peak = num(m.peakRssMb);
			if (peak !== null) rss.push(peak);
		} else if (c.prefix === "lane-started") {
			if (c.createdBy === LANE_RUNNER_BY) runner.add(c.laneId);
			else if (c.createdBy === LANE_STARTER_BY && here) interactive.add(c.laneId);
		} else if (c.prefix === "lane-exit" && c.createdBy === LANE_RUNNER_BY && here) {
			ended.add(c.laneId);
		}
	}
	for (const d of deathsInWindow) {
		const lane = deathHolder(d.body);
		if (lane && runner.has(lane)) ended.add(lane);
	}
	rss.sort((a, b) => a - b);
	return {
		runs,
		wallMin,
		usdByModel: [...usd].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
		peakRssMb: rss.length === 0 ? null : { p50: rss[Math.floor((rss.length - 1) / 2)]!, max: rss[rss.length - 1]!, samples: rss.length },
		unmetered: [...ended].filter((l) => !metered.has(l)).sort(),
		interactive: [...interactive].sort(),
	};
}

/** The report's counts over `rows` for the window `w`. */
export function computeCounts(rows: CountRows, w: Window): Counts {
	const deaths = rows.deaths.filter((d) => inWindow(d.createdAt, w));
	const byCause = new Map<string, number>();
	for (const d of deaths) {
		const cause = deathCause(d.body);
		byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
	}
	const recorded = byCause.get("lease lapsed") ?? 0;
	const named: [string, number][] = DEATH_CAUSES.filter((c) => byCause.has(c)).map((c) => [c, byCause.get(c)!]);
	const other = [...byCause].filter(([c]) => !(DEATH_CAUSES as readonly string[]).includes(c)).sort((a, b) => a[0].localeCompare(b[0]));
	return {
		deaths: { total: deaths.length, byCause: [...named, ...other] },
		lapsed: { total: recorded + rows.unrecordedLapses.length, recorded, unrecorded: [...rows.unrecordedLapses] },
		heldClosed: {
			total: rows.heldClosed.length,
			inWindow: rows.heldClosed.filter((m) => inWindow(m.createdAt, w)).length,
			workloads: new Set(rows.heldClosed.map((m) => m.workloadId)).size,
		},
		lanes: laneRuns(rows, w, deaths),
	};
}
