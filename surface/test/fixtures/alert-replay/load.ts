// Loads snapshot-10-52Z.json (PLAN wl-mw0vs9uc3xqtka D8) into a ledger file through the file's own triggers: every row is
// inserted the way the triggers require a new row to look (rev 0, open or held, stamps equal to its creation), then moved
// to its snapshot state at its changed_at, in time order, so the questions pause and reopen their slices as they did live.
// The state fields are checked after the replay; a mismatch throws naming the row. Rev counts are not reproduced.
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, string | number | null>;
const TABLES = ["workloads", "slices", "questions", "instructions", "entries", "messages"] as const;
type Table = (typeof TABLES)[number];

export interface ReplaySnapshot {
	as_of: string;
	rows: Record<Table, Row[]>;
}

/** The snapshot file beside this loader. */
export const SNAPSHOT_PATH = join(import.meta.dir, "snapshot-10-52Z.json");

/** What a new row of `t` must look like on insert (the `*_insert_*` triggers). */
function fresh(t: Table, r: Row): Row {
	const stamp = { changed_by: r.created_by!, changed_at: r.created_at!, rev: 0 };
	switch (t) {
		case "workloads":
			return { ...r, ...stamp, status: "open", holder: null, holder_lease_until: null, closed_at: null };
		case "slices":
			return { ...r, ...stamp, state: "open", artifact: null };
		case "questions":
			return { ...r, ...stamp, state: "open", resolved_by: null };
		case "messages":
			return { ...r, ...stamp, state: "held" };
		default:
			return r;
	}
}

/** The fields an update sets, per table (state and its stamp only; the immutable columns never move). */
const MUTABLE: Partial<Record<Table, string[]>> = {
	workloads: ["status", "holder", "holder_lease_until", "closed_at"],
	slices: ["state", "artifact"],
	questions: ["state", "resolved_by"],
	messages: ["state"],
};
/** Updates at one instant: a question's answer first (it reopens its slice), then the rest. */
const UPDATE_RANK: Record<Table, number> = { questions: 0, workloads: 1, slices: 2, messages: 3, instructions: 9, entries: 9 };
/** The message states in the order the triggers allow them. */
const MESSAGE_STATES = ["held", "delivered", "consumed", "acted-on"];

/** Replays `snap` into `db` in one transaction; throws naming every row whose state fields differ afterwards. */
export function loadSnapshot(db: Database, snap: ReplaySnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"))): void {
	type Ev = { at: string; phase: 0 | 1; rank: number; order: number; run: () => void };
	const events: Ev[] = [];
	let order = 0;
	for (const [rank, t] of TABLES.entries()) {
		for (const r of snap.rows[t]) {
			const row = fresh(t, r);
			const cols = Object.keys(row);
			events.push({
				at: r.created_at as string, phase: 0, rank, order: order++,
				run: () => db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c] ?? null)),
			});
			const fields = MUTABLE[t];
			if (fields === undefined || r.changed_at === null || r.changed_at === undefined || r.changed_at === r.created_at) continue;
			events.push({
				at: r.changed_at as string, phase: 1, rank: UPDATE_RANK[t], order: order++,
				run: () => {
					if (t === "messages") {
						// held -> delivered -> consumed -> acted-on, one step at a time, all at changed_at.
						const now = db.query<{ state: string }, [string]>("SELECT state FROM messages WHERE id = ?").get(r.id as string)?.state ?? "missing";
						for (let i = MESSAGE_STATES.indexOf(now) + 1; i <= MESSAGE_STATES.indexOf(r.state as string); i++) {
							db.prepare("UPDATE messages SET state = ?, changed_by = ?, changed_at = ?, rev = rev + 1 WHERE id = ?").run(MESSAGE_STATES[i]!, r.changed_by!, r.changed_at!, r.id!);
						}
						return;
					}
					const set = [...fields, "changed_by", "changed_at"];
					db.prepare(`UPDATE ${t} SET ${set.map((c) => `${c} = ?`).join(", ")}, rev = rev + 1 WHERE id = ?`).run(...set.map((c) => r[c] ?? null), r.id!);
				},
			});
		}
	}
	events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.phase - b.phase || a.rank - b.rank || a.order - b.order));
	db.transaction(() => {
		for (const e of events) e.run();
	})();
	const wrong: string[] = [];
	for (const t of TABLES) {
		const fields = MUTABLE[t];
		if (fields === undefined) continue;
		for (const r of snap.rows[t]) {
			const got = db.query<Row, [string]>(`SELECT ${fields.join(", ")} FROM ${t} WHERE id = ?`).get(r.id as string);
			if (got === null) {
				wrong.push(`${t} ${r.id}: missing after the replay`);
				continue;
			}
			for (const f of fields) if ((got[f] ?? null) !== (r[f] ?? null)) wrong.push(`${t} ${r.id}.${f}: snapshot ${String(r[f])}, loaded ${String(got[f])}`);
		}
	}
	if (wrong.length > 0) throw new Error(`loadSnapshot: the replay did not reproduce the snapshot (surface/test/fixtures/alert-replay/load.ts): ${wrong.join("; ")}`);
}
