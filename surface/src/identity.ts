// The orchestrator's identity (MIGRATION.md M5: first-wake step): one `assumption` entry on the
// standing workload, body `identity: <name> (<pronouns>)`. No schema bump; the newest such entry
// wins, so a rename is one more row. The standing workload is opened here on first use, and with
// it the standing slice every orchestrator question is raised on (MIGRATION.md item 105): a ledger
// from before that item has the workload and no slice, so the slice is ensured on its own too.
import type { Ledger, SliceRow } from "../../ledger/src/index";
import { IDENTITY_PREFIX, STANDING_BRIEF, STANDING_SLICE_ID, STANDING_SLICE_TASK, STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

export interface Identity {
	name: string;
	pronouns: string;
	/** The entry id, for a receipt. */
	entryId: string;
}

/** The standing workload and its standing slice, each opened when missing. Returns the workload id. */
export function ensureStandingWorkload(ledger: Ledger): string {
	if (!ledger.workload(STANDING_WORKLOAD_ID)) {
		ledger.openWorkload({ by: SURFACE_BY, id: STANDING_WORKLOAD_ID, brief: STANDING_BRIEF, stakes: "throwaway", mode: "autonomous" });
	}
	if (!standingSlice(ledger)) {
		// The fixed id, unless a slice of that id exists and is dead (done or cancelled by a direct write): then a fresh id, same task.
		const id = ledger.slice(STANDING_SLICE_ID) ? undefined : STANDING_SLICE_ID;
		ledger.addSlice({ by: SURFACE_BY, id, workloadId: STANDING_WORKLOAD_ID, task: STANDING_SLICE_TASK, doneCondition: "never: open as long as the orchestrator runs", inputs: "the orchestrator's closing asks to Jo" });
	}
	return STANDING_WORKLOAD_ID;
}

/** The live standing slice: the open or paused slice on the standing workload carrying the standing task (paused while a question on it is open); null before `ensureStandingWorkload`. */
export function standingSlice(ledger: Ledger): SliceRow | null {
	return ledger.slices(STANDING_WORKLOAD_ID).find((s) => s.task === STANDING_SLICE_TASK && (s.state === "open" || s.state === "paused")) ?? null;
}

const IDENTITY_BODY = /^identity:\s*(.+?)\s*\(([^()]+)\)\s*$/;

/** The identity in force: the newest well-formed identity entry, or null on a first wake. */
export function identityOf(ledger: Ledger): Identity | null {
	if (!ledger.workload(STANDING_WORKLOAD_ID)) return null;
	const rows = ledger.entries(STANDING_WORKLOAD_ID, "assumption");
	for (let i = rows.length - 1; i >= 0; i--) {
		const m = IDENTITY_BODY.exec(rows[i]!.body);
		if (m) return { name: m[1]!, pronouns: m[2]!.trim(), entryId: rows[i]!.id };
	}
	return null;
}

/** Record a (new) identity. Name and pronouns are trimmed; parentheses are not allowed in either. */
export function recordIdentity(ledger: Ledger, name: string, pronouns: string): Identity {
	const n = name.trim();
	const p = pronouns.trim();
	if (!n || !p) throw new Error("identity needs a name and pronouns");
	if (/[()]/.test(n) || /[()]/.test(p)) throw new Error("identity name and pronouns may not contain parentheses");
	ensureStandingWorkload(ledger);
	const entryId = ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `${IDENTITY_PREFIX} ${n} (${p})` });
	return { name: n, pronouns: p, entryId };
}

/** The author slot for decision-log entries, commit trailers and one-liners: the name, lower-cased for filenames. */
export function authorSlug(identity: Identity | null): string {
	return (identity?.name ?? "orchestrator").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orchestrator";
}
