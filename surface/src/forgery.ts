// The forgery check (PLAN wl-mvfxw3c4zqfzls D2): a pure function over one workload's rows, its provenance and
// the two global Jo-channel cutovers, returning one hit per (row, rule). Detection, not prevention: nothing here
// writes; the tick, the launch reserve and `merge-train.ts stakes --hold-ok` read the rows, call it and act.
//
// A Jo channel (ledger/src/jo-channel.ts, D1) marks every Jo-authority row it inserts with a provenance row
// `lane_instance = 'jo-channel'`, `tbl` and `row_id` the marked row, `detail` `surface` or `launcher`. The
// cutover of a kind is the earliest mark of that kind ledger-wide (`Ledger.joChannelCutovers()`): before it nothing
// is flagged for lacking that kind of mark, so a deploy floods nothing.
import { AUTHORITY } from "../../ledger/src/authority";
import { type EntryRow, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, type ProvenanceRow, type QuestionRow } from "../../ledger/src/index";
import { joForgeryAnswer, reversedRowIds, surfaceMarks } from "../../ledger/src/jo-channel";
import { controlWriterRejected } from "./launch";
import { SURFACE_BY } from "./types";

export type ForgeryRule = "F1" | "F2" | "F3" | "F4" | "F5";
export type ForgeryTable = "instructions" | "entries" | "questions";

/**
 * One flagged (row, rule). F3 and F4 name the resolving instruction, not its question: that row is what Jo
 * confirms or reverses (D5). `questions` is in the shared contract; no rule here emits it.
 */
export interface ForgeryHit {
	rowId: string;
	table: ForgeryTable;
	rule: ForgeryRule;
	workloadId: string;
	/** Why the row was flagged, one line. */
	detail: string;
}

export interface JoChannelCutovers {
	/** The earliest `surface` mark in the ledger, or null before the first. */
	surface: string | null;
	/** The earliest `launcher` mark in the ledger, or null before the first. */
	launcher: string | null;
}

export interface ForgeryInput {
	workloadId: string;
	/** The workload's raw instructions, reversed rows included. */
	instructions: readonly InstructionRow[];
	questions: readonly QuestionRow[];
	entries: readonly EntryRow[];
	/** The workload's provenance (`Ledger.provenance(wl)`); only `jo-channel` insert rows count as marks. */
	provenance: readonly ProvenanceRow[];
	/** Global, from `Ledger.joChannelCutovers()`, never derived from this workload's marks. */
	cutovers: JoChannelCutovers;
	/** The workload's holders (`holdersOf`), for `validWriter`'s holder-written prefixes. */
	holders?: readonly string[];
}

/** A mark's `lane_instance`. */
export const JO_CHANNEL = "jo-channel";

/** The prefixes only the surface writes for Jo (AUTHORITY's control-prefix rows). */
const JO_ONLY_PREFIXES: ReadonlySet<string> = new Set(AUTHORITY.filter((r) => r.kind === "control-prefix" && r.authority === "jo-only").map((r) => r.name));

/** The jo-only control prefix an entry's body opens with, or null. */
export function joOnlyPrefix(body: string): string | null {
	const p = /^([a-z-]+):/.exec(body.trimStart())?.[1];
	return p !== undefined && JO_ONLY_PREFIXES.has(p) ? p : null;
}

/**
 * The exact lane id shape `Ledger.reserveLane` mints, `lane-<stem>-<n>` (ledger/src/index.ts): `lane-runner` and
 * `lane-starter` have no ordinal and are not lane ids.
 */
export function isLaneId(by: string): boolean {
	return /^lane-\S+-\d+$/.test(by);
}

/** Row 11's direct channel as G3 pins it: kind instruction, channel direct, no question, a lane id of this workload (`lane-<wl without wl->-<n>`). */
function row11(i: InstructionRow, workloadId: string): boolean {
	const head = `lane-${workloadId.replace(/^wl-/, "")}-`;
	return i.kind === "instruction" && i.channel === "direct" && i.question_id === null && i.created_by.startsWith(head) && /^\d+$/.test(i.created_by.slice(head.length));
}

/** At or after a cutover; never before the first mark of its kind. */
function after(at: string, cutover: string | null): boolean {
	return cutover !== null && at >= cutover;
}

/**
 * Row ids Jo confirmed as his: each `forgery-confirmed:` among `entries` that is Jo's answer (ledger/src/jo-channel.ts
 * `joForgeryAnswer`: surface-stamped, surface-marked on its own id, naming another row) and not voided by an effective surface
 * `forgery-reversed:` (`reversedRowIds`, as `controlEntries` drops it). No chain: a marked confirmation of a confirmation clears
 * that confirmation's own hit, never its target's.
 */
function confirmedIds(entries: readonly EntryRow[], marked: ReadonlySet<string>): Set<string> {
	const reversed = reversedRowIds(entries);
	const out = new Set<string>();
	for (const e of entries) {
		const a = reversed.has(e.id) ? null : joForgeryAnswer(e, marked);
		if (a?.word === "confirmed") out.add(a.rowId);
	}
	return out;
}

const TABLE_ORDER: Record<ForgeryTable, number> = { instructions: 0, questions: 1, entries: 2 };

export function checkForgery(input: ForgeryInput): ForgeryHit[] {
	const { workloadId, cutovers } = input;
	const marks = new Map<string, Set<string>>();
	for (const p of input.provenance) {
		if (p.lane_instance !== JO_CHANNEL || p.action !== "insert" || p.detail === null) continue;
		const key = `${p.tbl}\u0000${p.row_id}`;
		const kinds = marks.get(key) ?? new Set<string>();
		kinds.add(p.detail);
		marks.set(key, kinds);
	}
	const markOf = (table: ForgeryTable, id: string) => marks.get(`${table}\u0000${id}`);
	const confirmed = confirmedIds(input.entries, surfaceMarks(input.provenance, "entries"));
	const questions = new Map(input.questions.map((q) => [q.id, q]));
	const hits = new Map<string, ForgeryHit>();
	const hit = (table: ForgeryTable, rowId: string, rule: ForgeryRule, detail: string) => {
		if (confirmed.has(rowId)) return;
		const key = `${rowId}\u0000${rule}`;
		if (!hits.has(key)) hits.set(key, { rowId, table, rule, workloadId, detail });
	};

	for (const i of input.instructions) {
		const marked = markOf("instructions", i.id);
		const shape = `${i.kind} ${i.channel} by ${i.created_by}`;
		if (i.author === "jo") {
			if (i.created_by === SURFACE_BY) {
				if (after(i.created_at, cutovers.surface) && !marked) {
					hit("instructions", i.id, "F1", `F1 unmarked: author-jo ${shape} at ${i.created_at}, after the surface cutover ${cutovers.surface}, carries no jo-channel mark`);
				}
				if (i.channel === "direct") {
					hit("instructions", i.id, "F2", `F2 wrong-channel: author-jo ${shape}: no Jo channel writes a surface-stamped direct row`);
				}
			} else if (i.created_by === LANE_STARTER_BY) {
				// PLAN-3's lane-typed row: Jo's by-hand typed answer (or withdrawal), applied by the launcher.
				if (!(i.channel === "direct" && (i.kind === "answer" || i.kind === "withdrawal") && i.question_id !== null)) {
					hit("instructions", i.id, "F2", `F2 wrong-channel: author-jo ${shape} is not the lane-typed shape (answer or withdrawal, channel direct, question set)`);
				} else if (after(i.created_at, cutovers.launcher) && !marked?.has("launcher")) {
					hit("instructions", i.id, "F2", `F2 wrong-channel: lane-typed ${shape} at ${i.created_at}, after the launcher cutover ${cutovers.launcher}, carries no launcher mark`);
				}
			} else if (!row11(i, workloadId)) {
				hit("instructions", i.id, "F2", `F2 wrong-channel: author-jo ${shape}: stamped neither ${SURFACE_BY} nor ${LANE_STARTER_BY}, and not row 11's own-lane shape`);
			}
		}
		if (i.kind === "answer" || i.kind === "withdrawal") {
			const resolves = i.question_id ? `question ${i.question_id}` : "no question";
			if (isLaneId(i.created_by)) {
				hit("instructions", i.id, "F3", `F3 lane-resolves-own: ${i.kind} on ${resolves} stamped by lane ${i.created_by}`);
			} else if (i.kind === "answer" && i.author !== "jo") {
				hit("instructions", i.id, "F3", `F3 lane-resolves-own: answer on ${resolves} authored ${i.author}, not jo`);
			}
			if (i.kind === "withdrawal" && i.author !== "jo") {
				const q = i.question_id ? questions.get(i.question_id) : undefined;
				const runnersOwn = i.created_by === LANE_RUNNER_BY && q?.created_by === LANE_RUNNER_BY;
				if (!runnersOwn) {
					hit("instructions", i.id, "F4", `F4 machinery-resolves: withdrawal on ${resolves} authored ${i.author} by ${i.created_by}, not jo and not ${LANE_RUNNER_BY} withdrawing its own question`);
				}
			}
		}
	}

	for (const e of input.entries) {
		const prefix = joOnlyPrefix(e.body);
		if (prefix === null) continue;
		if (e.created_by === SURFACE_BY && after(e.created_at, cutovers.surface) && !markOf("entries", e.id)) {
			hit("entries", e.id, "F1", `F1 unmarked: jo-only ${prefix}: entry stamped ${SURFACE_BY} at ${e.created_at}, after the surface cutover ${cutovers.surface}, carries no jo-channel mark`);
		}
		if (controlWriterRejected(e, input.holders ?? []) !== null) {
			hit("entries", e.id, "F5", `F5 prefix-wrong-writer: jo-only ${prefix}: entry stamped ${e.created_by}, a writer validWriter rejects`);
		}
	}

	return [...hits.values()].sort((a, b) =>
		TABLE_ORDER[a.table] - TABLE_ORDER[b.table] || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}
