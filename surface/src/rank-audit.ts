// Jev ranking's weekly audit (PLAN wl-mv8k039gvogt8g § 2 D6): Jo's observable picks of the last week, each scored
// against the `rank-shown: … by pick` snapshot written in the pick's own transaction (`rankPick`, surface/src/rank.ts:
// waiting items only, Jev order, pins ignored). The wake tick calls `runAudit`, which is a no-op until `auditDue`.
//
// Jo's picks: `rank-override:` (Jo's "X first", naming its snapshot by entry id), Jo's launch word (the launch tool's
// `launch-requested:`, which always writes its by-pick snapshot in the same transaction), and the interactive
// reservation's `launch: <lane> cause interactive` (ledger/src/index.ts `reserveLane`). A `launch-requested:` with no
// snapshot tied to it is a side effect (cancel-slice, ceiling extend, mode-flip), not a pick: it is only counted on one
// report line, in no metric. An override or reservation with no snapshot, or any pick whose snapshot lacks the picked
// item as waiting, is a pick and unscorable. A reservation whose lane never wrote `lane-started:` is still Jo's pick:
// it is scored and marked `start failed`.
//
// Tying a launch pick to its snapshot: a ledger write is one BEGIN IMMEDIATE transaction, so its entries take
// consecutive rowids with no other writer's entries between them, while their created_at values may differ (the clock
// is read per entry). The snapshot of a `launch-requested:` or a `launch: … cause interactive` is therefore the nearest
// earlier entry by rowid, stepping back only over non-pick entries on the picked workload itself (the launch tool's
// `lane-model:`). Any other entry in between means the snapshot belongs to another write.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EntryRow, Ledger } from "../../ledger/src/index";
import { attempts, type ControlEntry, controlEntries, laneStarted } from "./launch";
import {
	type Audit, formatAudit, GOALS_STALE_MS, goalsHash, parseAudit, parseGoals, parseOverride, parseShown, RANK_WEIGHTS, rankDay,
	type RankTermName, rankTitle, readSignal, scoreSignal, type Shown,
} from "./rank";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

/** Where the weekly reports go: `<dir>/<to-day>.md` (D6), beside the other agent-system-2.0 reports in agent-scratch. */
export const RANK_AUDIT_DIR = join(homedir(), "agent-scratch", "agent-system-2.0", "rank-audit");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The audit is due when no `rank-audit:` was written in the last 7 days and the first `rank-shown:` is at least 7 days
 * old (D6), so the first window is a whole week of ranking.
 */
export function auditDue(ledger: Ledger, now: string): boolean {
	const t = Date.parse(now);
	let firstShown: string | null = null;
	for (const c of controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"))) {
		if (c.prefix === "rank-audit" && parseAudit(c.body) !== null && t - Date.parse(c.createdAt) < WEEK_MS) return false;
		if (c.prefix === "rank-shown" && firstShown === null && parseShown(c.body) !== null) firstShown = c.createdAt;
	}
	return firstShown !== null && t - Date.parse(firstShown) >= WEEK_MS;
}

type PickKind = "first" | "launch" | "interactive";
interface SeqEntry extends EntryRow {
	seq: number;
}
interface ItemTerms {
	workloadId: string;
	title: string;
	/** The score the snapshot recorded, null for an unscored item. */
	score: number | null;
	/** `goal_max 0.33 · unblocks_jo 0.9? · …` from the item's signal current at the pick, or why there is none. */
	terms: string;
}
interface ScoredPick {
	kind: PickKind;
	workloadId: string;
	at: string;
	entryId: string;
	/** The snapshot entry id, when one was tied to the pick. */
	shown: string | null;
	/** 1-based rank among the snapshot's waiting items, and their count; null when unscorable. */
	rank: number | null;
	of: number | null;
	pct: number | null;
	notes: string[];
	/** For a scorable pick not at #1: the picked item, then every item Jev ranked above it. */
	picked?: ItemTerms;
	displaced?: ItemTerms[];
}

/** A `rank-shown: … by pick` entry: on the standing workload, written by the ranking machinery, parsable. */
function pickSnapshot(e: EntryRow | null): Shown | null {
	if (e === null || e.workload_id !== STANDING_WORKLOAD_ID) return null;
	const c = controlEntries([e])[0];
	if (c?.prefix !== "rank-shown") return null;
	const s = parseShown(c.body);
	return s !== null && s.by === "pick" ? s : null;
}

/** The goals hash in force at `at` and whether it weighs (D3: the newest `rank-goals:` then, under 7 days old). */
function goalsInForceAt(ledger: Ledger, at: string): { hash: string; inForce: boolean } {
	const control = controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"));
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "rank-goals" || c.createdAt > at) continue;
		const g = parseGoals(c.body);
		if (!g) continue;
		return { hash: goalsHash(g.goals), inForce: Date.parse(at) - Date.parse(c.createdAt) <= GOALS_STALE_MS };
	}
	return { hash: goalsHash([]), inForce: false };
}

/** One item's term breakdown from its signal current at the pick, asked on the snapshot's goals. */
function itemTerms(ledger: Ledger, workloadId: string, score: number | null, snapshotGoals: string, at: string): ItemTerms {
	const w = ledger.workload(workloadId);
	if (!w) return { workloadId, title: "(unknown workload)", score, terms: "no such workload" };
	const before = ledger.entries(workloadId, "assumption").filter((e) => e.created_at <= at);
	const read = readSignal(before, w.brief, snapshotGoals, at);
	const title = rankTitle(w.brief);
	if (!read.current) return { workloadId, title, score, terms: `unscored (${read.unscored})` };
	const goals = goalsInForceAt(ledger, at);
	const s = scoreSignal(read.current.answers, read.current.askedOn, at, goals.inForce && goals.hash === snapshotGoals);
	const terms = (Object.keys(RANK_WEIGHTS) as RankTermName[]).map((n) => `${n} ${Number(s.terms[n].value.toFixed(2))}${s.terms[n].mark}`).join(" · ");
	return { workloadId, title, score, terms: s.flags.length ? `${terms} · ${s.flags.join(", ")}` : terms };
}

/** Every entry from the first one created at or after `since` on, in write order (rowid), all workloads. */
function entriesSince(ledger: Ledger, since: string): SeqEntry[] {
	return ledger.db.query<SeqEntry, [string]>(
		"SELECT rowid AS seq, * FROM entries WHERE rowid >= (SELECT min(rowid) FROM entries WHERE created_at >= ?) ORDER BY rowid",
	).all(since);
}

/** The kind of Jo's pick a control entry is, or null. */
function pickKind(c: ControlEntry): PickKind | null {
	if (c.prefix === "rank-override") return parseOverride(c.body) !== null ? "first" : null;
	if (c.prefix === "launch-requested") return "launch";
	if (c.prefix === "launch") return attempts([c])[0]?.cause?.kind === "interactive" ? "interactive" : null;
	return null;
}

const pctOf = (rank: number, of: number): number => (of <= 1 ? 100 : (100 * (of - rank)) / (of - 1));
const round1 = (x: number): number => Number(x.toFixed(1));

/**
 * The audit of Jo's picks made in [from, to) against Jev's by-pick snapshots (D6). Pure: reads the ledger, writes
 * nothing. `reportDir` only names the report path the row will carry.
 */
export function rankAudit(ledger: Ledger, from: string, to: string, reportDir: string = RANK_AUDIT_DIR): { audit: Audit; report: string } {
	// A snapshot shares its pick's transaction, so it is never more than a moment older than the pick.
	const rows = entriesSince(ledger, new Date(Date.parse(from) - 24 * 60 * 60 * 1000).toISOString());
	const control = new Map<string, ControlEntry>();
	for (const c of controlEntries(rows)) control.set(c.id, c);
	const kindAt = (e: EntryRow): PickKind | null => {
		const c = control.get(e.id);
		return c ? pickKind(c) : null;
	};
	const picks: ScoredPick[] = [];
	let sideEffects = 0;
	for (let i = 0; i < rows.length; i++) {
		const e = rows[i]!;
		if (e.created_at < from || e.created_at >= to) continue;
		const kind = kindAt(e);
		if (kind === null) continue;
		const c = control.get(e.id)!;
		let snapshotEntry: EntryRow | null = null;
		let workloadId = e.workload_id;
		if (kind === "first") {
			const o = parseOverride(c.body)!;
			workloadId = o.workloadId;
			snapshotEntry = ledger.entry(o.shown);
		} else {
			for (let j = i - 1; j >= 0; j--) {
				const p = rows[j]!;
				if (pickSnapshot(p) !== null) {
					snapshotEntry = p;
					break;
				}
				if (p.workload_id !== e.workload_id || kindAt(p) !== null) break;
			}
		}
		if (kind === "launch" && snapshotEntry === null) {
			sideEffects++;
			continue;
		}
		const pick: ScoredPick = { kind, workloadId, at: e.created_at, entryId: e.id, shown: null, rank: null, of: null, pct: null, notes: [] };
		if (kind === "interactive" && laneStarted(controlEntries(ledger.entries(workloadId, "assumption")), c.laneId!) === null) pick.notes.push("start failed");
		const snapshot = pickSnapshot(snapshotEntry);
		if (snapshot === null) {
			pick.notes.unshift("unscorable: no by-pick snapshot");
		} else {
			pick.shown = snapshotEntry!.id;
			const waiting = snapshot.items.filter((x) => x.state === "waiting");
			const index = waiting.findIndex((x) => x.workloadId === workloadId);
			if (index < 0) {
				pick.notes.unshift("unscorable: picked item not in its snapshot");
			} else {
				pick.rank = index + 1;
				pick.of = waiting.length;
				pick.pct = round1(pctOf(pick.rank, pick.of));
				if (index > 0) {
					pick.picked = itemTerms(ledger, workloadId, waiting[index]!.score, snapshot.goals, e.created_at);
					pick.displaced = waiting.slice(0, index).map((x) => itemTerms(ledger, x.workloadId, x.score, snapshot.goals, e.created_at));
				}
			}
		}
		picks.push(pick);
	}
	const scored = picks.filter((p) => p.rank !== null);
	const audit: Audit = {
		from, to,
		picks: picks.length,
		scorable: scored.length,
		top1: scored.filter((p) => p.rank === 1).length,
		top3: scored.filter((p) => p.rank! <= 3).length,
		meanpct: scored.length === 0 ? null : round1(scored.reduce((s, p) => s + pctOf(p.rank!, p.of!), 0) / scored.length),
		report: join(reportDir, `${rankDay(to)}.md`),
	};
	return { audit, report: reportText(audit, picks, sideEffects) };
}

function reportText(a: Audit, picks: readonly ScoredPick[], sideEffects: number): string {
	const item = (i: ItemTerms): string => `${i.workloadId} ${i.title} (score ${i.score ?? "u"}): ${i.terms}`;
	const lines = [
		`# Jev rank audit ${rankDay(a.from)}..${rankDay(a.to)}`,
		"",
		`Window ${a.from} .. ${a.to}. Observable picks only: Jo's "X first" (rank-override:), Jo's launch word`,
		"(launch-requested: with its by-pick snapshot) and the interactive reservation (launch: … cause interactive). Each is",
		"scored only against the rank-shown: … by pick snapshot written with it (waiting items, Jev order, pins ignored);",
		"percentile 100 is Jev's #1, 0 its last.",
		"",
		`picks ${a.picks} · scorable ${a.scorable} · top1 ${a.top1} · top3 ${a.top3} · meanpct ${a.meanpct ?? "unknown"}`,
		`launch requests without a pick snapshot (cancel/extend/mode-flip side effects): ${sideEffects}`,
		"",
		"## Picks",
		"",
	];
	if (picks.length === 0) lines.push("No picks in the window.");
	for (const p of picks) {
		const where = p.rank === null ? "-" : `#${p.rank} of ${p.of} (pct ${p.pct})`;
		lines.push(`- ${p.at} ${p.kind} ${p.workloadId}: ${where}${p.notes.length ? `; ${p.notes.join("; ")}` : ""} (${p.entryId}${p.shown ? `, shown ${p.shown}` : ""})`);
	}
	const overrides = picks.filter((p) => p.picked !== undefined);
	if (overrides.length > 0) {
		lines.push("", "## Overrides", "");
		for (const p of overrides) {
			lines.push(`### ${p.workloadId} picked at #${p.rank} of ${p.of} (${p.kind}, ${p.at})`, "", `- picked ${item(p.picked!)}`);
			p.displaced!.forEach((d, i) => lines.push(`- Jev #${i + 1} ${item(d)}`));
			lines.push("");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The wake tick's audit: when due at `now`, audits [now − 7 d, now), writes `<reportDir>/<to-day>.md` and one
 * `rank-audit:` row (SURFACE_BY, standing workload), and returns the audit; otherwise null with nothing written. The
 * due check is repeated inside the write, so two ticks at once write one row.
 */
export function runAudit(ledger: Ledger, now: string, opts: { reportDir: string }): Audit | null {
	if (!auditDue(ledger, now)) return null;
	return ledger.write(() => {
		if (!auditDue(ledger, now)) return null;
		const { audit, report } = rankAudit(ledger, new Date(Date.parse(now) - WEEK_MS).toISOString(), now, opts.reportDir);
		mkdirSync(opts.reportDir, { recursive: true });
		writeFileSync(audit.report, report);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatAudit(audit) });
		return audit;
	});
}
