// The orchestrator surface's seat on the status core (PLAN wl-mv8igegljun18g D2, D2a; the core is
// surface/src/status.ts and knows nothing of the ledger). This module reads what a status batch
// carries for Ilex and grades it with `gradeOf`, a fixed table Ilex restates and never regrades:
//
// 1. needs you: the § B3 lines the delivery lists (held lines re-checked against a fresh read, an
//    on-fire line riding the batch), each with the messages behind it; never capped.
// 2. in flight: ledger events with an identity that includes their state, so a later change is a new
//    identity — `wl-open:<id>`, `wl-closed:<id>`, `slice:<id>:r<rev>` (the row's rev rises on every
//    write, ledger/schema.sql), `entry:<id>` for a valid `lane-started:` / `lane-exit:` — read from
//    `ledger.slices(id)` (every state) on open workloads and workloads closed at or after the floor;
//    slice cuts collapse to one counted line per workload; the queued tick lines; and one counted line
//    for open workloads with no event.
// 3. lane messages: held messages to the orchestrator on open workloads (by state) and on workloads
//    closed at or after the floor, except those a current § B3 line owns (`ErrorLine.messageIds`),
//    every body whole.
//
// A `lane-exit:` an `idle` line already delivered said, or one a `lane-died` line delivered after it
// said, is told without being listed (silent).
import type { Ledger, MessageRow, SliceRow, WorkloadRow } from "../../ledger/src/index";
import { lineKey } from "./batch";
import type { ErrorLine } from "./errors";
import { controlEntries, laneExit, reservedPrefix } from "./launch";
import type { Grade, StatusItem, Told } from "./status";
import {
	ARTIFACT_FAILED_PREFIX, ARTIFACT_PASSED_PREFIX, LANE_DIED_PREFIX, ORCHESTRATOR_RECIPIENT, PROMPT_RESOLVED_PREFIX, PROMPT_WAIT_PREFIX, STANDING_WORKLOAD_ID,
	TEST_RUN_FAILED_PREFIX,
} from "./types";

/** The orchestrator surface's seat name: its cursor is `~/.agent-system-2/orchestrator/status-cursor.json`. */
export const ILEX_SEAT = "orchestrator";
/** A batch's sections, in order (D2: needs you first). */
export const NEEDS_YOU_SECTION = "needs you";
export const IN_FLIGHT_SECTION = "in flight";
export const MESSAGES_SECTION = "lane messages";
export const ILEX_SECTIONS = [NEEDS_YOU_SECTION, IN_FLIGHT_SECTION, MESSAGES_SECTION] as const;
/** The sections a render's delta carries (the wake and a turn show needs-you lines their own way). */
export const DELTA_SECTIONS = [IN_FLIGHT_SECTION, MESSAGES_SECTION] as const;
/** Item refs the seat takes back at confirmation and takeover: a needs-you line's key, a tick line. */
export const LINE_REF = "line:";
export const TICK_REF = "tick:";

/** What a status item is, for the grade table. */
export type IlexKind =
	| "on-fire-line" | "line" | "workload-opened" | "workload-closed" | "lane-started" | "lane-ended" | "slice-changed" | "tick" | "lane-message"
	| "slice-cut" | "signal-message" | "unchanged";

const GRADE_OF: Record<IlexKind, Grade> = {
	"on-fire-line": "on fire",
	line: "worth knowing",
	"workload-opened": "worth knowing",
	"workload-closed": "worth knowing",
	"lane-started": "worth knowing",
	"lane-ended": "worth knowing",
	"slice-changed": "worth knowing",
	tick: "worth knowing",
	"lane-message": "worth knowing",
	"slice-cut": "noise",
	"signal-message": "noise",
	unchanged: "noise",
};

/** The fixed grade of a kind (PLAN D2's table). */
export function gradeOf(kind: IlexKind): Grade {
	return GRADE_OF[kind];
}

const SIGNAL_PREFIXES = [ARTIFACT_PASSED_PREFIX, ARTIFACT_FAILED_PREFIX, LANE_DIED_PREFIX, PROMPT_WAIT_PREFIX, PROMPT_RESOLVED_PREFIX, TEST_RUN_FAILED_PREFIX];

/** A lane message opening with a signal or control prefix is noise; any other is worth knowing. */
export function messageKind(body: string): "lane-message" | "signal-message" {
	const head = body.trimStart();
	return SIGNAL_PREFIXES.some((p) => head.startsWith(p)) || reservedPrefix(head) !== null ? "signal-message" : "lane-message";
}

export const workloadOpenedIdentity = (id: string): string => `wl-open:${id}`;
export const workloadClosedIdentity = (id: string): string => `wl-closed:${id}`;
export const sliceIdentity = (s: Pick<SliceRow, "id" | "rev">): string => `slice:${s.id}:r${s.rev}`;
export const entryIdentity = (id: string): string => `entry:${id}`;

/** The title a workload line carries: the brief's first line, whitespace collapsed, cut at 80 characters with `…`. */
export function workloadTitle(brief: string): string {
	const first = (brief.split("\n").find((l) => l.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
	return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** What the core lends the source: the floor, the told test and the told set (for a slice's last told rev). */
export interface ToldView {
	readonly floor: string;
	eligible(identity: string, ts: string): boolean;
	readonly told: ReadonlyMap<string, string>;
}

export interface IlexInput {
	/** The § B3 lines this delivery lists under needs you (none for a render that shows them its own way). */
	needsYou: readonly ErrorLine[];
	/** Keys (`lineKey`) of the listed lines that are on fire. */
	fire: ReadonlySet<string>;
	/** The fresh read's lines: the messages they own are never lane-message bullets. */
	current: readonly ErrorLine[];
	/** Tick lines the delivery carries (none for a render with its own Applied block). */
	ticks: readonly string[];
	/** Whether this session delivered the line with this key (`Delivered.has`). */
	delivered(key: string): boolean;
	/** The read's stamp: the ordering stamp of items found by state. */
	readAt: string;
	/** Add the `N other workloads in flight, no change` count (a batch does; a render's delta section, beside a render that lists every workload, does not). */
	countUnchanged: boolean;
	/**
	 * The seat's decoration of a listed item's text (the plan paths beneath their mentions, PLAN
	 * wl-mv61a8dh4aeneo D2), applied here so the core's cap measures the text as it is sent
	 * (PLAN wl-mv8igegljun18g D2a [R3-5]).
	 */
	decorate(text: string): string;
}

/** The last told rev of every slice with a told identity. */
function toldRevs(told: ReadonlyMap<string, string>): Map<string, number> {
	const out = new Map<string, number>();
	for (const identity of told.keys()) {
		const m = /^slice:(.+):r(\d+)$/.exec(identity);
		if (!m) continue;
		const rev = Number(m[2]);
		if (rev > (out.get(m[1]!) ?? -1)) out.set(m[1]!, rev);
	}
	return out;
}

/** A changed slice as one line: its current state, `cut and …` when it was cut since the floor and never told, `(changed N times)` when its rev moved more than once since. */
function sliceItem(s: SliceRow, wl: string, floor: string, lastTold: number | undefined): StatusItem | "cut" {
	const cutNow = lastTold === undefined && s.created_at >= floor;
	if (cutNow && s.state === "open" && s.rev === 0) return "cut";
	const state = s.state === "open" ? "reopened" : s.state;
	const label = cutNow ? `cut and ${state}` : state;
	const base = lastTold ?? (cutNow ? 0 : undefined);
	const changes = base === undefined ? 0 : s.rev - base;
	const text = `slice ${s.id} on ${wl} ${label}: ${s.task}${changes > 1 ? ` (changed ${changes} times)` : ""}`;
	return { section: IN_FLIGHT_SECTION, grade: gradeOf("slice-changed"), text, at: s.changed_at, ts: s.changed_at, told: [{ identity: sliceIdentity(s), ts: s.changed_at }] };
}

/** Every item a status delivery offers now (PLAN D2), against the core's floor and told set. */
export function ilexItems(ledger: Ledger, view: ToldView, input: IlexInput): StatusItem[] {
	const floor = view.floor;
	const items: StatusItem[] = [];
	for (const l of input.needsYou) {
		const key = lineKey(l);
		items.push({
			section: NEEDS_YOU_SECTION, grade: gradeOf(input.fire.has(key) ? "on-fire-line" : "line"), text: `${l.n === undefined ? "" : `#${l.n} `}${l.line}`,
			at: "", ts: null, uncapped: true, ref: `${LINE_REF}${key}`, ...(l.messageIds ? { messageIds: l.messageIds } : {}),
		});
	}
	const revs = toldRevs(view.told);
	const ownedNow = new Set(input.current.flatMap((l) => l.messageIds ?? []));
	const listedLineMessages = new Set(input.needsYou.flatMap((l) => l.messageIds ?? []));
	const workloads = ledger.db.query<WorkloadRow, [string, string]>(
		"SELECT * FROM workloads WHERE id <> ? AND (status = 'open' OR closed_at >= ?) ORDER BY created_at, id").all(STANDING_WORKLOAD_ID, floor);
	let unchanged = 0;
	for (const w of workloads) {
		const before = items.length;
		const title = workloadTitle(w.brief);
		if (view.eligible(workloadOpenedIdentity(w.id), w.created_at)) {
			items.push({ section: IN_FLIGHT_SECTION, grade: gradeOf("workload-opened"), text: `${w.id} opened: ${title}`, at: w.created_at, ts: w.created_at, told: [{ identity: workloadOpenedIdentity(w.id), ts: w.created_at }] });
		}
		const cuts: SliceRow[] = [];
		for (const s of ledger.slices(w.id)) {
			if (!view.eligible(sliceIdentity(s), s.changed_at)) continue;
			const item = sliceItem(s, w.id, floor, revs.get(s.id));
			if (item === "cut") cuts.push(s);
			else items.push(item);
		}
		if (cuts.length > 0) {
			const at = cuts[0]!.created_at;
			items.push({
				section: IN_FLIGHT_SECTION, grade: gradeOf("slice-cut"), text: `${cuts.length} slice${cuts.length === 1 ? "" : "s"} cut on ${w.id}: ${cuts.map((s) => s.id).join(", ")}`,
				at, ts: at, told: cuts.map((s) => ({ identity: sliceIdentity(s), ts: s.changed_at })),
			});
		}
		const deaths: Pick<MessageRow, "id" | "state" | "created_at">[] = ledger.db.query<Pick<MessageRow, "id" | "state" | "created_at">, [string, string, string]>(
			"SELECT id, state, created_at FROM messages WHERE workload_id = ? AND recipient = ? AND body LIKE ? || '%'").all(w.id, ORCHESTRATOR_RECIPIENT, LANE_DIED_PREFIX);
		for (const c of controlEntries(ledger.entries(w.id, "assumption"))) {
			if ((c.prefix !== "lane-started" && c.prefix !== "lane-exit") || c.laneId === null) continue;
			const told: Told[] = [{ identity: entryIdentity(c.id), ts: c.createdAt }];
			if (!view.eligible(told[0]!.identity, c.createdAt)) continue;
			if (c.prefix === "lane-started") {
				items.push({ section: IN_FLIGHT_SECTION, grade: gradeOf("lane-started"), text: `lane ${c.laneId} started on ${w.id}`, at: c.createdAt, ts: c.createdAt, told });
				continue;
			}
			const said = input.delivered(`idle:${w.id}:${c.id}`) || deaths.some((d) => d.created_at >= c.createdAt && (d.state !== "held" || listedLineMessages.has(d.id)));
			const exit = laneExit([c], c.laneId);
			const outcome = exit ? `${exit.outcome}${exit.reason ? `, reason ${exit.reason}` : ""}` : c.rest;
			items.push({ section: IN_FLIGHT_SECTION, grade: gradeOf("lane-ended"), text: `lane ${c.laneId} ended on ${w.id} (${outcome})`, at: c.createdAt, ts: c.createdAt, told, ...(said ? { silent: true } : {}) });
		}
		if (w.closed_at !== null && view.eligible(workloadClosedIdentity(w.id), w.closed_at)) {
			items.push({ section: IN_FLIGHT_SECTION, grade: gradeOf("workload-closed"), text: `${w.id} closed: ${title}`, at: w.closed_at, ts: w.closed_at, told: [{ identity: workloadClosedIdentity(w.id), ts: w.closed_at }] });
		}
		if (w.status === "open" && items.slice(before).every((i) => i.silent)) unchanged++;
	}
	for (const line of input.ticks) items.push({ section: IN_FLIGHT_SECTION, grade: gradeOf("tick"), text: line, at: input.readAt, ts: null, ref: `${TICK_REF}${line}` });
	if (input.countUnchanged && unchanged > 0) {
		items.push({ section: IN_FLIGHT_SECTION, grade: gradeOf("unchanged"), text: `${unchanged} other workload${unchanged === 1 ? "" : "s"} in flight, no change`, at: input.readAt, ts: null });
	}
	const held = ledger.db.query<MessageRow & { wl_closed_at: string | null }, [string, string]>(
		`SELECT m.*, w.closed_at AS wl_closed_at FROM messages m JOIN workloads w ON w.id = m.workload_id
		 WHERE m.state = 'held' AND m.recipient = ? AND (w.status = 'open' OR w.closed_at >= ?) ORDER BY m.created_at, m.rowid`).all(ORCHESTRATOR_RECIPIENT, floor);
	for (const m of held) {
		if (ownedNow.has(m.id)) continue;
		items.push({
			section: MESSAGES_SECTION, grade: gradeOf(messageKind(m.body)), text: `${m.id} from ${m.sender} on ${m.workload_id}${m.slice_id ? ` (${m.slice_id})` : ""}: ${m.body.split("\n").join("\n  ")}`,
			at: m.created_at, ts: m.wl_closed_at, messageIds: [m.id],
		});
	}
	for (const i of items) if (!i.silent) i.text = input.decorate(i.text);
	return items;
}

/** The refs of `refs` that name needs-you lines, as line keys. */
export function lineRefs(refs: readonly string[]): string[] {
	return refs.filter((r) => r.startsWith(LINE_REF)).map((r) => r.slice(LINE_REF.length));
}

/** The refs of `refs` that name tick lines, as the lines. */
export function tickRefs(refs: readonly string[]): string[] {
	return refs.filter((r) => r.startsWith(TICK_REF)).map((r) => r.slice(TICK_REF.length));
}
