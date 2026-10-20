// The retry budget and its one incident line (PLAN wl-mvfqvd5hy8zv28 § 1.4, § 1.4a, § 1.5): the limit, the backoff, the
// next retry number, what counts as progress, the incident body and its once-only writer. The dead-lane relaunch
// (surface/src/relaunch.ts) is the first user; escalation phase 2 (DRAFT.md § 3, "transient machinery faults: 3 retries,
// then one incident") imports `RETRY_LIMIT`, `nextRetry` and `recordIncidentOnce` from here with its own `kind`, so the
// number, the counting rule and the line are defined once. Nothing here decides a launch.
import type { EntryRow, Ledger, QuestionRow, SliceRow } from "../../ledger/src/index";
import type { ControlEntry } from "./launch";
import { isRunnerFullSuiteSlice } from "./test-run";
import { ARTIFACT_TREE_PREFIX, ORCHESTRATOR_RECIPIENT } from "./types";

/**
 * Automatic retries without progress before the machinery stops and writes one incident (DRAFT.md § 3's "3 retries, then
 * one incident"; on 2026-10-19 each restart death recovered on its first relaunch, so 3 leaves two spare).
 */
export const RETRY_LIMIT = 3;
/** The least wait before retry 2 and 3, from the ledger time of the death they replace (Jo's steer in-mvfrxewspo835s). */
export const RELAUNCH_BACKOFF_MS = 10 * 60_000;

/**
 * The number of the next retry, read from the newest attempt alone (review r2 F2): 1 when there is no attempt, when the
 * attempt carries no retry number of its own (a first launch, Jo's word, a train task: each starts an episode), or when
 * progress happened after it; otherwise the attempt's own number plus one. Each attempt records its own number, so the
 * count never re-derives older failures.
 */
export function nextRetry<A>(attempt: A | null, ownN: (a: A) => number | null, progressedAfter: (a: A) => boolean): number {
	if (attempt === null) return 1;
	const n = ownN(attempt);
	if (n === null || progressedAfter(attempt)) return 1;
	return n + 1;
}

/** The rows progress is read from: entries in ledger order, the valid control entries among them, the holders, slices, questions. */
export interface ProgressRows {
	entries: readonly EntryRow[];
	control: readonly ControlEntry[];
	holders: readonly string[];
	slices: readonly SliceRow[];
	questions: readonly QuestionRow[];
}

/**
 * The tree a valid `artifact-tree:` entry records, or null: an `assumption` on a slice, written by a holder (the lane's own
 * artifact observer, surface/extensions/lane.ts), whose body parses to non-empty `repo`, `tree` and `command` strings (the
 * shape `artifactTrees` in surface/src/signals.ts reads).
 */
function artifactTreeOf(e: EntryRow, holders: readonly string[]): string | null {
	if (e.kind !== "assumption" || e.slice_id === null || !holders.includes(e.created_by) || !e.body.startsWith(ARTIFACT_TREE_PREFIX)) return null;
	let v: unknown;
	try {
		v = JSON.parse(e.body.slice(ARTIFACT_TREE_PREFIX.length));
	} catch {
		return null;
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const { repo, tree, command } = v as Record<string, unknown>;
	return typeof repo === "string" && repo && typeof tree === "string" && tree && typeof command === "string" && command ? tree : null;
}

/**
 * Whether the workload made progress after the attempt entry `since` (§ 1.4, review r1 F2, F6): a slice created after it,
 * a slice in state `done` changed after it, a question created after it, a valid `done-because:` after it, or a valid
 * `artifact-tree:` after it whose tree no earlier valid `artifact-tree:` on the workload names. Re-running the same artifact
 * on the same tree is not progress, nor is the full-suite slice the test runner adds for a run requested with no slice
 * (`isRunnerFullSuiteSlice`, review r1 M3): a test request is the lane asking, not the work moving. "After" is ledger order
 * for entries and a strictly later timestamp for slice and question rows: an equal timestamp counts as before, since the
 * relaunched lane cannot write in its reservation's millisecond.
 */
export function progressAfter(rows: ProgressRows, since: { entryId: string; createdAt: string }): boolean {
	const t = since.createdAt;
	if (rows.slices.some((s) => !isRunnerFullSuiteSlice(s) && (s.created_at > t || (s.state === "done" && s.changed_at > t)))) return true;
	if (rows.questions.some((q) => q.created_at > t)) return true;
	const at = rows.entries.findIndex((e) => e.id === since.entryId);
	const order = new Map(rows.entries.map((e, i) => [e.id, i] as const));
	if (rows.control.some((c) => c.prefix === "done-because" && (order.get(c.id) ?? -1) > at)) return true;
	const seen = new Set<string>();
	for (let i = 0; i < rows.entries.length; i++) {
		const tree = artifactTreeOf(rows.entries[i]!, rows.holders);
		if (tree === null) continue;
		if (i > at && !seen.has(tree)) return true;
		seen.add(tree);
	}
	return false;
}

// ---- the incident ------------------------------------------------------------------------------------------------------

/** Body prefix of the one line a spent retry budget writes to Jo. */
export const INCIDENT_PREFIX = "incident:";
/** The most characters of detail an incident line carries. */
export const INCIDENT_DETAIL_MAX = 200;

export interface Incident {
	/** What was retried: `relaunch` for a dead lane; escalation phase 2 names its own. */
	kind: string;
	workloadId: string;
	/** What the retries were of (for `relaunch`, the dead lane): one incident per kind, workload and key. */
	key: string;
	/** Retries spent. */
	count: number;
	limit: number;
	/** What the last failure said, folded to one line and cut to `INCIDENT_DETAIL_MAX` characters. */
	detail: string;
}

/** `incident: <kind> <wl> key `: what every incident of one kind on one workload starts with. */
export function incidentScope(i: Pick<Incident, "kind" | "workloadId">): string {
	return `${INCIDENT_PREFIX} ${i.kind} ${i.workloadId} key `;
}

/** `incident: <kind> <wl> key <key> after `: the part of the body that identifies one incident. */
export function incidentKey(i: Pick<Incident, "kind" | "workloadId" | "key">): string {
	return `${incidentScope(i)}${i.key} after `;
}

/** What follows the count in every incident body. */
const INCIDENT_COUNT_TAIL = " retries without progress: ";

/** `incident: <kind> <wl> key <key> after <count>/<limit> retries without progress: <detail>` (§ 1.5). */
export function incidentBody(i: Incident): string {
	const detail = i.detail.replace(/\s+/g, " ").trim().slice(0, INCIDENT_DETAIL_MAX);
	return `${incidentKey(i)}${i.count}/${i.limit}${INCIDENT_COUNT_TAIL}${detail}`;
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const INCIDENT_BODY = new RegExp(`^${reEscape(INCIDENT_PREFIX)} (\\S+) (\\S+) key (\\S+) after (\\d+)/(\\d+)${reEscape(INCIDENT_COUNT_TAIL)}(.*)$`, "s");

/** `incidentBody` read back; null when the body is not one. Every reader of an incident body parses it here. */
export function parseIncident(body: string): Incident | null {
	const m = INCIDENT_BODY.exec(body);
	return m ? { kind: m[1]!, workloadId: m[2]!, key: m[3]!, count: Number(m[4]), limit: Number(m[5]), detail: m[6]! } : null;
}

/**
 * The incidents of `kind` on `workloadId` that `by` wrote, held or delivered, oldest first: the rows a reader keys a hold or a
 * hidden death to. Only `by`'s own messages count, as in `recordIncidentOnce`.
 */
export function incidentsOn(ledger: Ledger, by: string, kind: string, workloadId: string): { createdAt: string; incident: Incident }[] {
	const scope = incidentScope({ kind, workloadId });
	return ledger.db.query<{ body: string; created_at: string }, [string, string, number, string]>(
		"SELECT body, created_at FROM messages WHERE workload_id = ? AND created_by = ? AND substr(body, 1, ?) = ? ORDER BY created_at, rowid",
	).all(workloadId, by, scope.length, scope).flatMap((m) => {
		const incident = parseIncident(m.body);
		return incident ? [{ createdAt: m.created_at, incident }] : [];
	});
}

/**
 * Write the incident once (§ 1.5): one write transaction that re-runs `stillDue()` against what it reads now, then enqueues
 * the body as a held message from `by` to the orchestrator unless a message `by` wrote with the same kind, workload and
 * key exists, held or not. Only `by`'s own messages count, so a lane's note shaped like an incident cannot pre-empt it.
 * Returns the new message id, or null when nothing was written.
 */
export function recordIncidentOnce(ledger: Ledger, input: Incident & { by: string }, stillDue: () => boolean): string | null {
	return ledger.write(() => {
		if (!stillDue()) return null;
		const key = incidentKey(input);
		const exists = ledger.db.query<{ id: string }, [string, string, number, string]>(
			"SELECT id FROM messages WHERE workload_id = ? AND created_by = ? AND substr(body, 1, ?) = ? LIMIT 1",
		).get(input.workloadId, input.by, key.length, key);
		if (exists) return null;
		return ledger.enqueue({ by: input.by, workloadId: input.workloadId, sender: input.by, recipient: ORCHESTRATOR_RECIPIENT, body: incidentBody(input) });
	});
}
