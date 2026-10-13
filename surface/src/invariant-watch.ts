// The invariant report on the orchestrator's timer (MIGRATION.md item 104): every INVARIANT_MS the
// surface runs `check()` from surface/scripts/invariants.ts in-process over a read-only connection to
// its own ledger, and each finding whose `key` was never surfaced becomes one needs-you line on the
// tick's queue (`tickNotices`, pushed as a `surface-notices` aside by surface/extensions/wake.ts). A
// key recurs while its condition holds and changes when the condition does, so "already surfaced" is
// the dedupe, not a time window.
//
// The surfaced-key set is the ledger: one `assumption` entry `invariant-surfaced: <key>` per key, by
// SURFACE_BY on the standing workload, written only once the line carrying the key is delivered (its
// push confirmed by `message_end`, or rendered into Jo's turn; surface/extensions/wake.ts). Until then
// the key is pending in the session (`pending`, line → keys): not queued twice, and not recorded, so
// a process that dies between queue and delivery tells the line again after the restart instead of
// silencing it. A recorded key survives a restart, so a new process does not re-announce what Jo was
// already told; the wake render never shows the standing workload (surface/src/render.ts), and
// silent-orchestrator does not count these entries as the orchestrator speaking
// (surface/scripts/invariants.ts ORCH_SQL).
//
// Skips are not surfaced, except one that persists: an invariant skipped on two consecutive runs of
// this process. The timer only runs live (never `--as-of`), where every invariant is expected to run on
// the orchestrator's machine, so a skip that holds across runs is a broken probe (pgrep, ps or git
// failing, no origin/main, the orchestrator's own process not found). Its key is
// `skipped:<invariant>:<reason>`, so a different reason is told again. The consecutive count is
// per process: after a restart a persistent skip is told no sooner than the second run.
//
// checkout-behind-main, process-older-than-head and ff-lull are told to Jo like every other finding;
// nothing here fast-forwards or restarts anything.
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { backupNamespace } from "../../ledger/src/index";
import type { Ledger } from "../../ledger/src/index";
import { BACKUP_GAP_MS, check, gitIn, type Invariant, liveLanesFromPgrep, orchestratorsFromPs, type Report } from "../scripts/invariants";
import { ensureStandingWorkload } from "./identity";
import { laneDir } from "./launch";
import { INVARIANT_SURFACED_PREFIX, STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

/** The report over the ledger at `ledgerPath` now, live (git, pgrep, ps on this machine), for the checkout at `repo`. */
export function liveReport(ledgerPath: string, repo: string, asOf: string, home: string): Report {
	const db = new Database(ledgerPath, { readonly: true });
	try {
		return check({
			db,
			asOf,
			replay: false,
			liveLanes: liveLanesFromPgrep(),
			lanesDirOf: (wl) => laneDir(wl, home),
			repo,
			git: Bun.which("git") ? gitIn(repo) : null,
			orchestrators: () => orchestratorsFromPs(repo),
			// The directory Ledger.open's default backup policy writes (surface/scripts/invariants.ts main does the same).
			backups: { dir: join(dirname(ledgerPath), "backups", backupNamespace(ledgerPath)), gapMs: BACKUP_GAP_MS },
		});
	} finally {
		db.close();
	}
}

/** The keys this surface already told Jo, read from the ledger. */
export function surfacedKeys(ledger: Ledger): Set<string> {
	const keys = new Set<string>();
	for (const e of ledger.entries(STANDING_WORKLOAD_ID, "assumption")) {
		if (e.created_by !== SURFACE_BY || !e.body.startsWith(INVARIANT_SURFACED_PREFIX)) continue;
		keys.add(e.body.slice(INVARIANT_SURFACED_PREFIX.length).trim());
	}
	return keys;
}

/**
 * One run's lines for Jo: each finding whose key was neither surfaced nor pending, then each
 * persistent skip (skipped on this run and on `previousSkips`, the run before) likewise, grouped by
 * reason. Each returned line goes into `pending` with its keys; nothing is written to the ledger
 * here (`confirmInvariantLines` does that on delivery). `previousSkips` is replaced with this run's skips.
 */
export function newInvariantLines(ledger: Ledger, report: Report, previousSkips: Map<Invariant, string>, pending: Map<string, string[]>): string[] {
	const told = surfacedKeys(ledger);
	for (const keys of pending.values()) for (const k of keys) told.add(k);
	const lines: string[] = [];
	for (const f of report.findings) {
		if (told.has(f.key)) continue;
		told.add(f.key);
		const line = `needs you: invariant ${f.invariant} on ${f.workload} since ${f.since}: ${f.text} (key ${f.key})`;
		pending.set(line, [f.key]);
		lines.push(line);
	}
	const byReason = new Map<string, { invariants: Invariant[]; keys: string[] }>();
	for (const s of report.skipped) {
		if (!previousSkips.has(s.invariant)) continue;
		const key = `skipped:${s.invariant}:${s.skipped}`;
		if (told.has(key)) continue;
		told.add(key);
		const g = byReason.get(s.skipped) ?? { invariants: [], keys: [] };
		g.invariants.push(s.invariant);
		g.keys.push(key);
		byReason.set(s.skipped, g);
	}
	for (const [reason, g] of byReason) {
		const line = `needs you: invariant ${g.invariants.join(", ")} skipped on two runs in a row, so it is not being checked: ${reason} — a broken probe; fix it or say it stays off (key ${g.keys.join(", ")})`;
		pending.set(line, g.keys);
		lines.push(line);
	}
	previousSkips.clear();
	for (const s of report.skipped) previousSkips.set(s.invariant, s.skipped);
	return lines;
}

/** Record the keys of every pending invariant line among `delivered` as surfaced, and drop them from `pending`. Other lines are ignored. */
export function confirmInvariantLines(ledger: Ledger, pending: Map<string, string[]>, delivered: readonly string[]): void {
	const keys = delivered.flatMap((line) => pending.get(line) ?? []);
	if (keys.length === 0) return;
	ensureStandingWorkload(ledger);
	for (const key of keys) ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `${INVARIANT_SURFACED_PREFIX} ${key}` });
	for (const line of delivered) pending.delete(line);
}
