// The Jo channels, as provenance a forgery check can verify (PLAN wl-mvfxw3c4zqfzls D1).
//
// A Jo channel is a non-agent process whose harness code declares itself one, in code and never by env, with
// `declareJoChannel` once at start: the orchestrator's surface session when it becomes active
// (surface/src/session.ts) and the as2 lane launcher in Jo's terminal (surface/scripts/lane.ts cmdInteractive).
// From then on every `Ledger.open` in that process puts TEMP AFTER INSERT triggers on the new connection
// (`markTriggerSql`) that write one mark per Jo-authority row it inserts, in the same transaction, into the file's
// append-only `provenance` table: `(at = NEW.created_at, workload_id, lane_instance = 'jo-channel', tbl, row_id,
// action = 'insert', detail = 'surface' | 'launcher')`. A TEMP trigger inserts into `main.provenance` by its
// unqualified name, and the file's provenance triggers accept the lane instance (probed on a scratch file
// 2026-10-20). Marked rows: every `instructions` insert authored `jo`, and every `entries` insert stamped
// `orchestrator-surface` whose body opens with a jo-only control prefix (authority.ts AUTHORITY). A launcher's
// triggers hold its workload id as a literal and mark only that workload's rows.
//
// The declaration is process-wide: one slot on globalThis, so separately loaded copies of this module (OMP loads
// each extension on its own) see one declaration, and every connection the process opens is marked with no
// wiring. It is refused where the Jo-only boundary (authority.ts) is in force: an agent context whose ledger is a
// live (or unknown) file. `Ledger.open` refuses a declared process the same way on a connection that gets the
// boundary's triggers, and gives every such agent connection one more trigger (`markRefusalSql`): no insert of a
// `jo-channel` provenance row. Accident grade, as authority.ts: a deliberate copy of the call is out of scope.
//
// A reversal (PLAN D5): `forgery-reversed: <row id> by <in-id>`, kind assumption, stamped `orchestrator-surface`
// on the row's workload, voids the row for every decision read (`reversedRowIds`; Ledger.instructions, parkLane,
// surface/scripts/invariants.ts reservedView) unless a later effective reversal voids the reversal itself.
import { SURFACE_BY } from "../../surface/src/types";
import { AUTHORITY, agentContext, BOUNDARY } from "./authority";
import type { ProvenanceRow } from "./index";
import { defaultLedgerPath, inLiveRoot, TEST_ISOLATED_ENV } from "./locality";

/** A declared Jo channel: the surface, or the by-hand lane launcher of one workload. */
export type JoChannel = { kind: "surface" } | { kind: "launcher"; workload: string };

/** The `provenance.lane_instance` of a Jo-channel mark; its `detail` is the channel's kind. */
export const JO_CHANNEL_LANE = "jo-channel";

const SLOT = Symbol.for("agent-system-2.0/ledger/jo-channel");

function slot(): { channel: JoChannel | null } {
	const g = globalThis as unknown as Record<symbol, { channel: JoChannel | null } | undefined>;
	return (g[SLOT] ??= { channel: null });
}

const describe = (c: JoChannel) => (c.kind === "launcher" ? `the launcher of ${c.workload}` : "the surface");

/** The process's declared Jo channel, or null. */
export function joChannel(): JoChannel | null {
	return slot().channel;
}

/** The default ledger the process would open is in a live root, or the root set cannot be read: fails closed. */
function liveDefault(env: Record<string, string | undefined>): boolean {
	try {
		return inLiveRoot(defaultLedgerPath(env));
	} catch {
		return true;
	}
}

/**
 * Declare this process a Jo channel. Throws where the Jo-only boundary is in force: an agent context
 * (authority.ts agentContext) whose default ledger is a live file (or the live roots cannot be read); a test a lane
 * runs on a temp ledger can declare. Declaring the same channel again is a no-op; a different one throws.
 */
export function declareJoChannel(c: JoChannel, env: Record<string, string | undefined> = process.env): void {
	if (agentContext(env) && liveDefault(env)) {
		throw new Error(`${BOUNDARY}: an agent process may not declare itself a Jo channel (${describe(c)}); only the surface and the as2 lane launcher in Jo's terminal are (ledger/src/jo-channel.ts)`);
	}
	const s = slot();
	if (s.channel === null) s.channel = c;
	else if (describe(s.channel) !== describe(c)) throw new Error(`declareJoChannel: this process is already ${describe(s.channel)}; it cannot also be ${describe(c)}`);
}

/** Tests only (ledger/test/isolate-preload.ts, after each test): forget the declaration. Throws outside a test process. */
export function resetJoChannelForTest(): void {
	if (process.env.NODE_ENV !== "test" && !process.env[TEST_ISOLATED_ENV]) throw new Error("resetJoChannelForTest runs only under bun test");
	slot().channel = null;
}

const sql = (s: string) => `'${s.replaceAll("'", "''")}'`;
const SURFACE = sql(SURFACE_BY);
const LANE = sql(JO_CHANNEL_LANE);

/** The control prefixes only the surface writes for Jo (authority.ts AUTHORITY), without their colons. */
export function joOnlyPrefixes(): string[] {
	return AUTHORITY.filter((r) => r.kind === "control-prefix" && r.authority === "jo-only").map((r) => r.name);
}

/** The mark triggers for a connection of a process declared `c`: TEMP, this connection only; idempotent by name. */
export function markTriggerSql(c: JoChannel): string {
	const scope = c.kind === "launcher" ? ` AND NEW.workload_id = ${sql(c.workload)}` : "";
	const mark = (table: string) =>
		`INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail) VALUES (NEW.created_at, NEW.workload_id, ${LANE}, '${table}', NEW.id, 'insert', ${sql(c.kind)});`;
	const body = "ltrim(NEW.body, char(32, 9, 10, 13))";
	const prefixed = joOnlyPrefixes().map((p) => `${body} GLOB ${sql(`${p}:*`)}`).join(" OR ");
	return [
		`CREATE TEMP TRIGGER IF NOT EXISTS jo_channel_mark_instructions AFTER INSERT ON main.instructions WHEN NEW.author = 'jo'${scope} BEGIN ${mark("instructions")} END;`,
		`CREATE TEMP TRIGGER IF NOT EXISTS jo_channel_mark_entries AFTER INSERT ON main.entries WHEN NEW.created_by = ${SURFACE}${scope} AND (${prefixed}) BEGIN ${mark("entries")} END;`,
	].join("\n");
}

const MARK_REFUSED = sql(`${BOUNDARY}: an agent process may not write a ${JO_CHANNEL_LANE} provenance row; only a declared Jo channel marks its rows (ledger/src/jo-channel.ts)`);

/** The one trigger an agent connection (where authority.ts installBoundary runs) gets from this module. */
export function markRefusalSql(): string {
	return `CREATE TEMP TRIGGER IF NOT EXISTS jo_only_provenance_insert_jo_channel BEFORE INSERT ON main.provenance WHEN NEW.lane_instance = ${LANE} BEGIN SELECT RAISE(ABORT, ${MARK_REFUSED}); END;`;
}

/** The reversal entry's body (PLAN D5): Jo's `reverse <row id>` at the surface, input `inputId`. */
export function forgeryReversedBody(rowId: string, inputId: string): string {
	return `forgery-reversed: ${rowId} by ${inputId}`;
}

const REVERSED = /^forgery-reversed:\s+(\S+)\s+by\s+(in-\S+)$/;

/** A `forgery-reversed:` body parsed, or null. */
export function parseForgeryReversed(body: string): { rowId: string; by: string } | null {
	const m = REVERSED.exec(body.trim());
	return m ? { rowId: m[1]!, by: m[2]! } : null;
}

/** The `provenance` columns a mark is read from. */
type MarkRow = Pick<ProvenanceRow, "lane_instance" | "tbl" | "row_id" | "action" | "detail">;

/** The ids of the `table` rows a `surface` jo-channel mark names among `provenance`: the rows the surface session inserted for Jo. */
export function surfaceMarks(provenance: readonly MarkRow[], table: "entries" | "instructions"): Set<string> {
	const out = new Set<string>();
	for (const p of provenance) if (p.lane_instance === JO_CHANNEL_LANE && p.action === "insert" && p.detail === "surface" && p.tbl === table) out.add(p.row_id);
	return out;
}

const FORGERY_ANSWER = /^forgery-(confirmed|reversed):\s+(\S+)\s+by\s+(in-\S+)$/;

/**
 * Jo's answer to a forgery hit (PLAN wl-mvfxw3c4zqfzls D5), or null: the one trust rule every reader of `forgery-confirmed:`
 * and `forgery-reversed:` as Jo's answer applies (surface/src/forgery.ts checkForgery, surface/src/launch.ts forgeryHeld,
 * surface/src/forgery-hold.ts and through it the merge train, the close and surface/src/forgery-words.ts). The entry counts
 * only when it is kind assumption, stamped by the surface, carries a `surface` jo-channel mark on its own row id
 * (`marked`, from `surfaceMarks(…, "entries")` over the provenance of the workload the entry sits on), and names a row
 * other than itself. Trust is the entry's own mark and nothing else: a marked confirmation of another confirmation answers
 * that confirmation's hit only, never its target. No pre-cutover exception: the words ship with the marks, so the surface
 * that writes one marks it. `reversedRowIds` stays the effective-reversal reader and does not apply this rule.
 */
export function joForgeryAnswer(e: { id: string; kind: string; body: string; created_by: string }, marked: ReadonlySet<string>): { word: "confirmed" | "reversed"; rowId: string } | null {
	if (e.kind !== "assumption" || e.created_by !== SURFACE_BY || !marked.has(e.id)) return null;
	const m = FORGERY_ANSWER.exec(e.body.trim());
	if (!m || m[2] === e.id) return null;
	return { word: m[1] as "confirmed" | "reversed", rowId: m[2]! };
}

/**
 * The row ids a workload's effective reversals void. A reversal is a `forgery-reversed:` (kind assumption, stamped by
 * the surface), written at or before `asOf` when given. A reversal can only name an earlier row, so they are walked
 * newest first (`entries` oldest first, as every reader reads them: created_at, then rowid): one whose own id a newer
 * effective reversal already voided voids nothing, so reversing a reversal restores its target.
 */
export function reversedRowIds(entries: readonly { id: string; kind: string; body: string; created_by: string; created_at: string }[], asOf?: string): Set<string> {
	const reversals: { id: string; rowId: string; at: string; seq: number }[] = [];
	for (const e of entries) {
		if (e.kind !== "assumption" || e.created_by !== SURFACE_BY || (asOf !== undefined && e.created_at > asOf)) continue;
		const r = parseForgeryReversed(e.body);
		if (r) reversals.push({ id: e.id, rowId: r.rowId, at: e.created_at, seq: reversals.length });
	}
	reversals.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.seq - a.seq));
	const out = new Set<string>();
	for (const r of reversals) if (!out.has(r.id)) out.add(r.rowId);
	return out;
}

/** The SQL that reads a workload's candidate reversal entries (bind the workload id); `reversedRowIds` parses them. */
export const REVERSAL_ENTRIES_SQL =
	`SELECT id, kind, body, created_by, created_at FROM entries WHERE workload_id = ? AND kind = 'assumption' AND created_by = ${SURFACE} AND ltrim(body, char(32, 9, 10, 13)) GLOB 'forgery-reversed:*' ORDER BY created_at, rowid`;
