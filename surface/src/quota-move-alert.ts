// The quota move (PLAN wl-mvwk0v0gmp6cjc D4, D6; PLAN wl-mw0vs9uc3xqtka D3): every lane moved off a lab (surface/scripts/lane.ts,
// the runner's confirmed `moveOff`) and every hand moved on a used-up week (the classifier's spawn handler) is recorded here:
// `recordQuotaMove` writes the event entry E (the move record itself: `lane-headroom: …` or `hand-headroom: …`) and one
// orchestrator-bound `quota-move:` message (id `quotaMoveMessageId(E)`) in one transaction. surface/src/errors.ts renders it
// `NOW: <subject> on <wl> moved <from> -> <to> (<reason>)`, on fire (surface/src/batch.ts), consumed on delivery like
// `lane-died:`, and at a wake on a closed workload too when `trustedQuotaMove` (surface/src/delivery.ts); lane_message refuses
// the prefix (surface/extensions/lane-tools.ts).
//
// What reaches Jo outside the session is the alert pass's (surface/scripts/alert-tick.ts): each move is the `move:<E>` subject
// (surface/src/alert-sources.ts), its issue, @thewolff comment and silent popup on the alert ladder, and the move's writers
// kick the pass at once (surface/src/notify.ts `kickAlerts`). The move alert's own comment and popup channel is retired; what
// stays of it is read at cutover, to adopt an alert in flight (PLAN D3 "Legacy adoption"): its `quota-move-alert:` rows
// (`alertRows`), its issue and comment markers, and the legacy dialog's argv (`POPUP_SCRIPT`, `moveTitle`, `moveText`) that
// identifies a legacy popup still on screen.
import { LANE_RUNNER_BY, type Ledger, type MessageRow } from "../../ledger/src/index";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID } from "./types";

/** The orchestrator-bound message a move writes beside its event entry; a pushed signal no lane may write. */
export const QUOTA_MOVE_PREFIX = "quota-move:";
/** The retired move alert's claim, progress and result rows, by LANE_RUNNER_BY on the move's workload (read at cutover only). */
export const QUOTA_MOVE_ALERT_PREFIX = "quota-move-alert:";
/** The retired move alert's two channels. */
export type MoveAlertChannel = "comment" | "popup";
/** The legacy popup's two buttons: the voice one, and the silent default and cancel one. */
export const READ_IT_BUTTON = "Read it to me";
export const DISMISS_BUTTON = "Dismiss (no voice)";
/**
 * The legacy popup's AppleScript, one `-e` argument per line, then `moveTitle(move)` and `moveText(move)` as its last two
 * arguments: how the alert pass tells a legacy dialog still on screen from any other osascript (PLAN D3 "Legacy popups").
 */
export const POPUP_SCRIPT = [
	"on run argv",
	'tell application "System Events"',
	"activate",
	`set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"${READ_IT_BUTTON}", "${DISMISS_BUTTON}"} default button "${DISMISS_BUTTON}" cancel button "${DISMISS_BUTTON}"`,
	"end tell",
	"return button returned of r",
	"end run",
];
const MESSAGE_ID_PREFIX = "msg-qm-";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A move to record: a lane's (`lane-headroom:`) or a hand's (`hand-headroom:`, D6); `eventBody` is that record. */
export interface QuotaMoveEvent {
	workloadId: string;
	laneId: string;
	kind: "lane" | "hand";
	/** A hand's token, or its spawn key when unclassified. */
	token?: string;
	/** A classified hand's slice; none for an unclassified hand. */
	slice?: string;
	from: string;
	to: string;
	reason: string;
	by: string;
	eventBody: string;
}

/** `lane <lane>`, `hand <token> (slice <sl>) of lane <lane>`, or for an unclassified hand `unclassified hand <key|no key> of lane <lane>`. */
export function quotaMoveSubject(e: Pick<QuotaMoveEvent, "kind" | "laneId" | "token" | "slice">): string {
	if (e.kind === "lane") return `lane ${e.laneId}`;
	return e.slice ? `hand ${e.token ?? "no key"} (slice ${e.slice}) of lane ${e.laneId}` : `unclassified hand ${e.token ?? "no key"} of lane ${e.laneId}`;
}

/** The id of event E's `quota-move:` message: it ties the message to its event. */
export function quotaMoveMessageId(eventId: string): string {
	return `${MESSAGE_ID_PREFIX}${eventId}`;
}

/**
 * The move record and its NOW message in one write transaction: the event entry (`e.eventBody`) and the orchestrator-bound
 * `quota-move: <subject> on <wl>: <from> -> <to> (<reason>)`, both by `e.by`. Returns the event entry id E. A failed write
 * leaves neither and throws.
 */
export function recordQuotaMove(ledger: Ledger, e: QuotaMoveEvent): string {
	const body = `${QUOTA_MOVE_PREFIX} ${quotaMoveSubject(e)} on ${e.workloadId}: ${e.from} -> ${e.to} (${oneLine(e.reason)})`;
	return ledger.write(() => {
		const id = ledger.recordEntry({ by: e.by, workloadId: e.workloadId, kind: "assumption", body: e.eventBody });
		ledger.enqueue({ id: quotaMoveMessageId(id), by: e.by, workloadId: e.workloadId, sender: e.by, recipient: ORCHESTRATOR_RECIPIENT, body });
		return id;
	});
}

/** One recorded move, read back from its `quota-move:` message. */
export interface QuotaMove {
	eventId: string;
	messageId: string;
	workloadId: string;
	subject: string;
	kind: "lane" | "hand";
	from: string;
	to: string;
	reason: string;
	/** The message's time: the move's. */
	at: string;
}

/** A `quota-move:` message written by `recordQuotaMove` (its id names its event), parsed; null for any other message. */
export function parseQuotaMove(m: MessageRow): QuotaMove | null {
	if (!m.id.startsWith(MESSAGE_ID_PREFIX) || !m.body.startsWith(`${QUOTA_MOVE_PREFIX} `)) return null;
	const rest = m.body.slice(QUOTA_MOVE_PREFIX.length + 1);
	const sep = ` on ${m.workload_id}: `;
	const at = rest.indexOf(sep);
	if (at <= 0) return null;
	const parts = /^(\S+) -> (\S+) \(([\s\S]*)\)$/.exec(rest.slice(at + sep.length));
	if (!parts) return null;
	const subject = rest.slice(0, at);
	return {
		eventId: m.id.slice(MESSAGE_ID_PREFIX.length), messageId: m.id, workloadId: m.workload_id, subject, kind: subject.startsWith("lane ") ? "lane" : "hand",
		from: parts[1]!, to: parts[2]!, reason: parts[3]!, at: m.created_at,
	};
}

/** A parsed move whose event entry exists on the message's workload; null otherwise. */
function moveOf(ledger: Ledger, m: MessageRow): QuotaMove | null {
	const move = parseQuotaMove(m);
	return move !== null && ledger.entry(move.eventId)?.workload_id === m.workload_id ? move : null;
}

/**
 * A held `quota-move:` message the surface may consume on a closed workload (surface/src/delivery.ts), as it does a trusted
 * `security-red:`: `parseQuotaMove`'s form (id `msg-qm-<E>`, a body naming its own workload), its event entry E on that workload,
 * and the writer `recordQuotaMove` uses for both, sender included: LANE_RUNNER_BY for a lane move (E `lane-headroom: <lane> …`), or
 * for a hand move the lane its subject names (`… of lane <by>`, E `hand-headroom: <subject> …`). Null for anything else.
 */
export function trustedQuotaMove(ledger: Ledger, m: MessageRow): QuotaMove | null {
	const move = parseQuotaMove(m);
	if (move === null || m.sender !== m.created_by) return null;
	const event = ledger.entry(move.eventId);
	if (event === null || event.workload_id !== m.workload_id || event.created_by !== m.created_by) return null;
	if (move.kind === "lane") return m.created_by === LANE_RUNNER_BY && event.body.startsWith(`lane-headroom: ${move.subject.slice("lane ".length)} `) ? move : null;
	const writer = /^lane-\S+$/.test(m.created_by) && move.subject.endsWith(` of lane ${m.created_by}`);
	return writer && event.body.startsWith(`hand-headroom: ${move.subject} `) ? move : null;
}

/** Every recorded move on every workload, open or closed, oldest first. */
export function quotaMoves(ledger: Ledger): QuotaMove[] {
	// An id range (`msg-qm-` up to `msg-qm.`, the next byte after `-`) reads the primary key's index, not every message.
	const rows = ledger.db.query<MessageRow, [string, string, string]>(
		"SELECT * FROM messages WHERE id >= ?1 AND id < ?2 AND instr(body, ?3) = 1 ORDER BY created_at, rowid",
	).all(MESSAGE_ID_PREFIX, `${MESSAGE_ID_PREFIX.slice(0, -1)}.`, QUOTA_MOVE_PREFIX);
	return rows.flatMap((m) => moveOf(ledger, m) ?? []);
}

/** Event E's move, or null when no `quota-move:` message names it. */
export function quotaMove(ledger: Ledger, eventId: string): QuotaMove | null {
	const m = ledger.message(quotaMoveMessageId(eventId));
	return m === null ? null : moveOf(ledger, m);
}

/** The NOW line's text for a move (and the alert's, and the legacy dialog's last argument). */
export function moveText(move: QuotaMove): string {
	return `${move.subject} on ${move.workloadId} moved ${move.from} -> ${move.to} (${move.reason})`;
}

/** `as2: <lane|hand> moved off <from lab>`: the alert's title, and the legacy dialog's second-to-last argument. */
export function moveTitle(move: QuotaMove): string {
	return `as2: ${move.kind} moved off ${move.from.split("/")[0]}`;
}

/** The retired move alert's issue marker (in the issue body) and its comment marker, read at cutover. */
export const issueMarker = (eventId: string): string => `<!-- as2-quota-move ${eventId} -->`;
export const commentMarker = (eventId: string): string => `<!-- as2-quota-move-comment ${eventId} -->`;

/** One `quota-move-alert:` row of a move. */
export interface AlertRow {
	id: string;
	at: string;
	channel: MoveAlertChannel;
	status: string;
	rest: string;
}

/**
 * Every `quota-move-alert:` row of `move` by LANE_RUNNER_BY, oldest first (a lane-written look-alike is not one): on the move's
 * workload, and on the standing workload, where the retired worker put them once the move's workload was closed.
 */
export function alertRows(ledger: Ledger, move: QuotaMove): AlertRow[] {
	const head = `${QUOTA_MOVE_ALERT_PREFIX} ${move.eventId} `;
	const rows = ledger.db.query<{ id: string; body: string; created_at: string }, [string, string, string, string]>(
		"SELECT id, body, created_at FROM entries WHERE workload_id IN (?1, ?2) AND created_by = ?3 AND instr(body, ?4) = 1 ORDER BY created_at, rowid",
	).all(move.workloadId, STANDING_WORKLOAD_ID, LANE_RUNNER_BY, head);
	return rows.flatMap((e) => {
		const m = /^(comment|popup) (\S+)(?: ([\s\S]*))?$/.exec(e.body.slice(head.length));
		return m ? [{ id: e.id, at: e.created_at, channel: m[1] as MoveAlertChannel, status: m[2]!, rest: m[3] ?? "" }] : [];
	});
}
