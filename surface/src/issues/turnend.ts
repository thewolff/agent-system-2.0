// The turn-end check (PLAN wl-mv66ylim0gahog § 13.3): every Ilex turn that acts on a workload
// creates or updates its issue, and the sidecar keeps a receipt per workload per turn.
//
// A turn's range is `(turn_mark, max(seq)]` read at `agent_end` with `willContinue` false, where
// the session's `turn_mark` (sidecar `state` key `turn_mark:<session id>`, `turnMarkKey`) is the
// `max(seq)` at that session's previous turn end, or at its start for the first turn. Each surface
// session keeps its own mark, so a second session starting never moves the first one's range; a
// session's key is deleted at its shutdown (`clearTurnMark`). A mark's value is `<seq> <iso>` (a
// bare `<seq>`, the earlier form, still reads as its seq); a session that ends without its shutdown
// leaves its key, so each session start deletes every mark older than 7 days or with no time
// (`markSessionStart`). A live session's mark never ages that far: each turn end refreshes its
// time, and so does every surface poll of the session (`touchTurnMark`, the heartbeat; the seq
// stays), so an idle session keeps its range. No start hook is read, so
// writes made in `before_agent_start` (input-row commands) and turns an aside started (no `before_agent_start`,
// surface/extensions/wake.ts) are inside the range; lane writes between two turns fall in it too,
// which over-covers and never under-covers.
//
// At the turn end (`recordTurnEnd`, local, no network call) each workload with provenance in the
// range (the same exclusions as ingest in surface/src/issues/projector.ts: wl-orchestrator and
// lease-only renewals) gets one `turns` row whose `seq` is that workload's own highest seq in the
// range. A projected workload's link is marked dirty with `priority = 1` (the push takes it before
// `last_seq` order) and the row is `pending`; a workload no tracker applies to, a closed one never
// linked (no backfill), or any workload while the switch is off is `not-projected` at once.
//
// After every tick (`settleTurns`) a pending row settles `updated` once its link's `pushed_seq`
// (written with every successful push, a no-diff push included) reaches the row's `seq`, or
// `not-projected` when the switch went off or the link says no tracker applies. A row still pending
// after two ticks records one notice `issue for wl-X not updated after turn <t>: <reason>`, never a
// second, and one line in the next drift entry (`turnDrift`, marked carried by `markTurnDrift`
// only after that entry is written). Nothing is retried here: the link's own backoff applies.
import type { Ledger } from "../../../ledger/src/index";
import { STANDING_WORKLOAD_ID } from "../types";
import type { IssuesConfig } from "./config";
import type { TickReport } from "./projector";
import { type LinkRow, STATE, type Sidecar, type TurnRow } from "./sidecar";
import { readSwitch } from "./switch";
import { linkTracker } from "./tracker";

/** Ticks a turn row may stay pending before its one notice (§ 13.3). */
export const TURN_NOTICE_TICKS = 2;

const MAX_SEQ = "SELECT max(seq) AS m FROM provenance";

/** A turn mark older than this is deleted at any session's start: its session ended without a shutdown (a crash, a kill). */
export const TURN_MARK_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The sidecar `state` key of one surface session's turn mark. */
export function turnMarkKey(sessionId: string): string {
	return `${STATE.turnMark}:${sessionId}`;
}

/** A turn mark's value, `<seq> <iso>` (when it was set); a bare `<seq>`, the form before the time was kept, has no time (`at` null). */
export function parseTurnMark(value: string): { seq: number; at: number | null } {
	const [seq, iso] = value.split(" ");
	const at = iso === undefined ? Number.NaN : Date.parse(iso);
	return { seq: Number(seq), at: Number.isNaN(at) ? null : at };
}

const markValue = (seq: number, nowMs: number): string => `${seq} ${new Date(nowMs).toISOString()}`;

/**
 * At session start: the session's first turn range begins after everything already in the ledger.
 * Every other session's mark older than TURN_MARK_MAX_AGE_MS, or with no time (a bare seq), is
 * deleted first: a session that ended without its shutdown leaves its key, and nothing else removes it.
 */
export function markSessionStart(ledger: Ledger, sidecar: Sidecar, sessionId: string, nowMs: number): void {
	const hi = ledger.db.query<{ m: number | null }, []>(MAX_SEQ).get()?.m ?? 0;
	sidecar.immediate(() => {
		const prefix = `${STATE.turnMark}:`;
		const marks = sidecar.db.query<{ key: string; value: string }, [string]>("SELECT key, value FROM state WHERE substr(key, 1, length(?1)) = ?1").all(prefix);
		for (const m of marks) {
			const at = parseTurnMark(m.value).at;
			if (at === null || nowMs - at > TURN_MARK_MAX_AGE_MS) sidecar.setState(m.key, null);
		}
		sidecar.setState(turnMarkKey(sessionId), markValue(hi, nowMs));
	});
}

/** At session shutdown: the session's own mark goes; every other session's stays. */
export function clearTurnMark(sidecar: Sidecar, sessionId: string): void {
	sidecar.immediate(() => sidecar.setState(turnMarkKey(sessionId), null));
}

/** At every surface poll of a live session: its own mark's time moves to now, its seq stays (the heartbeat). No mark, nothing set. */
export function touchTurnMark(sidecar: Sidecar, sessionId: string, nowMs: number): void {
	const key = turnMarkKey(sessionId);
	sidecar.immediate(() => {
		const prior = sidecar.state(key);
		if (prior !== null) sidecar.setState(key, markValue(parseTurnMark(prior).seq, nowMs));
	});
}

/**
 * At a real turn end of session `sessionId`: one `turns` row per workload the range touched, the
 * projected ones' links dirty with priority, the session's mark moved to the range's top. Returns
 * the rows written. With no mark (the sidecar was first opened mid-session) only the mark is set.
 */
export function recordTurnEnd(o: { ledger: Ledger; sidecar: Sidecar; config: IssuesConfig; nowMs: number; sessionId: string }): TurnRow[] {
	const { ledger, sidecar } = o;
	const key = turnMarkKey(o.sessionId);
	const hi = ledger.db.query<{ m: number | null }, []>(MAX_SEQ).get()?.m ?? 0;
	const prior = sidecar.state(key);
	if (prior === null) {
		sidecar.immediate(() => sidecar.setState(key, markValue(hi, o.nowMs)));
		return [];
	}
	const from = parseTurnMark(prior).seq;
	if (hi <= from) {
		// Nothing new: only the mark's time moves, so a live session's mark never reads as stale.
		sidecar.immediate(() => sidecar.setState(key, markValue(from, o.nowMs)));
		return [];
	}
	// The same exclusions as ingest (projector.ts `Tick.ingest`).
	const touched = ledger.db
		.query<{ workload_id: string; seq: number }, [number, number, string]>(
			`SELECT workload_id, max(seq) AS seq FROM provenance
			  WHERE seq > ? AND seq <= ? AND workload_id <> ?
			    AND NOT (tbl = 'workloads' AND action = 'update' AND detail LIKE 'lease %')
			  GROUP BY workload_id ORDER BY seq`,
		)
		.all(from, hi, STANDING_WORKLOAD_ID);
	const on = readSwitch(ledger).on;
	return sidecar.immediate(() => {
		const rows: TurnRow[] = [];
		const insert = sidecar.db.query<TurnRow, [number, string, number, string]>("INSERT INTO turns (turn_end_at, workload_id, seq, outcome) VALUES (?, ?, ?, ?) RETURNING *");
		for (const t of touched) {
			const link = sidecar.link(t.workload_id);
			const projected =
				on &&
				(link === null ? ledger.workload(t.workload_id)?.status === "open" : link.repo === null || linkTracker(ledger, o.config, t.workload_id, link.repo) !== null);
			if (projected) {
				// A new link's repo is resolved by the push (projector.ts `pushLink`), like any link cached unresolved.
				sidecar.upsertLink(t.workload_id, { repo: null, dirty: true, lastSeq: t.seq });
				sidecar.db.query("UPDATE links SET priority = 1 WHERE workload_id = ?").run(t.workload_id);
			}
			rows.push(insert.get(o.nowMs, t.workload_id, t.seq, projected ? "pending" : "not-projected")!);
		}
		sidecar.setState(key, markValue(hi, o.nowMs));
		return rows;
	});
}

/** Why a pending row's link has not caught up, in the notice's words (§ 13.3). */
function pendingReason(o: SettleOptions, link: LinkRow): string {
	if (link.tracker?.startsWith("linear:") && !o.linearKey) return "missing key (LINEAR_API_KEY is not set)";
	if (link.fails >= o.config.parkAfterFails) return `parked after ${link.fails} failed pushes`;
	if (o.report?.stopped === "failed") return "tracker down";
	if (link.fails > 0) return `backoff after ${link.fails} failed push${link.fails === 1 ? "" : "es"}`;
	if (o.report?.stopped === "budget") return "budget";
	if (o.report === null) return "the issues tick failed";
	if (!o.report.claimed) return "another drainer holds the claim";
	return "not pushed yet";
}

export interface SettleOptions {
	ledger: Ledger;
	sidecar: Sidecar;
	config: IssuesConfig;
	nowMs: number;
	/** The tick that just ran, or null when it threw. */
	report: TickReport | null;
	/** Whether a Linear key is present (a missing one is a reason). */
	linearKey: boolean;
}

/**
 * After a tick: settle what can settle, count the tick against the rest, and return one notice
 * line per row reaching TURN_NOTICE_TICKS pending (each row once). A link no pending row still
 * waits on loses its priority.
 */
export function settleTurns(o: SettleOptions): string[] {
	const { ledger, sidecar } = o;
	const on = readSwitch(ledger).on;
	return sidecar.immediate(() => {
		const db = sidecar.db;
		const lines: string[] = [];
		const pending = db.query<TurnRow, []>("SELECT * FROM turns WHERE outcome = 'pending' ORDER BY id").all();
		for (const row of pending) {
			const link = sidecar.link(row.workload_id);
			// No link: the push retired it (opened and closed while never pushed) or the workload is gone.
			if (!on || link === null || (link.repo !== null && linkTracker(ledger, o.config, row.workload_id, link.repo) === null)) {
				db.query("UPDATE turns SET outcome = 'not-projected' WHERE id = ?").run(row.id);
			} else if (link.pushed_seq !== null && link.pushed_seq >= row.seq) {
				db.query("UPDATE turns SET outcome = 'updated' WHERE id = ?").run(row.id);
			} else {
				const ticks = row.ticks + 1;
				if (ticks >= TURN_NOTICE_TICKS && row.noticed === 0) {
					const reason = pendingReason(o, link);
					db.query("UPDATE turns SET ticks = ?, noticed = 1, reason = ? WHERE id = ?").run(ticks, reason, row.id);
					lines.push(`issue for ${row.workload_id} not updated after turn ${new Date(row.turn_end_at).toISOString()}: ${reason}`);
				} else {
					db.query("UPDATE turns SET ticks = ? WHERE id = ?").run(ticks, row.id);
				}
			}
		}
		db.run("UPDATE links SET priority = 0 WHERE priority <> 0 AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.outcome = 'pending' AND t.workload_id = links.workload_id)");
		return lines;
	});
}

/**
 * For the reconciler's next drift entry (§ 13.3): one line per noticed row no drift entry has
 * carried yet, and those rows' ids. Reads only: the rows stay uncarried until `markTurnDrift`,
 * which the phase calls after the entry carrying the lines is written.
 */
export function turnDrift(sidecar: Sidecar): { ids: number[]; lines: string[] } {
	const rows = sidecar.db.query<TurnRow, []>("SELECT * FROM turns WHERE noticed = 1 AND drifted = 0 ORDER BY id").all();
	return {
		ids: rows.map((r) => r.id),
		lines: rows.map((r) => `turn ${new Date(r.turn_end_at).toISOString()}: ${r.workload_id} ${r.outcome === "pending" ? "not updated" : r.outcome} (${r.reason ?? "no reason"})`),
	};
}

/** Mark the rows `turnDrift` returned as carried; run inside the sidecar transaction that follows the written entry. */
export function markTurnDrift(sidecar: Sidecar, ids: readonly number[]): void {
	const mark = sidecar.db.query("UPDATE turns SET drifted = 1 WHERE id = ?");
	for (const id of ids) mark.run(id);
}
