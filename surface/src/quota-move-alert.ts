// The quota-move alert (PLAN wl-mvwk0v0gmp6cjc D4; Jo's alarm rule, .ai/decision-log/2026-10-28--1400--plumb--alarms-show-a-silent-popup-before-any-sound.md):
// every lane moved off a lab (surface/scripts/lane.ts, the runner's confirmed `moveOff`) and every hand moved on a used-up week
// (D6, the classifier's spawn handler) reaches Jo at once and silently, on three channels, in order:
//  1. the needs-you NOW line: `recordQuotaMove` writes the event entry E (the move record itself: `lane-headroom: …` or
//     `hand-headroom: …`) and one orchestrator-bound `quota-move:` message (id `quotaMoveMessageId(E)`) in one transaction;
//     surface/src/errors.ts renders it `NOW: <subject> on <wl> moved <from> -> <to> (<reason>)`, on fire (surface/src/batch.ts),
//     consumed on delivery like `lane-died:`, and at a wake on a closed workload too when `trustedQuotaMove` (surface/src/delivery.ts);
//     lane_message refuses the prefix (surface/extensions/lane-tools.ts);
//  2. jo-issues (`comment`): one issue per event (marker `<!-- as2-quota-move <E> -->`, label as2-train), then one comment
//     starting @thewolff (marker `<!-- as2-quota-move-comment <E> -->`); every create and comment is looked up by its marker
//     first, so a create whose reply was lost is adopted, never repeated (surface/src/jo-issues.ts);
//  3. a silent popup (`popup`), after step 2's result whatever it is (ok, failed or exhausted): the popup is claimable only then,
//     so a worker that finds the comment unclaimed, spawned for or running leaves the popup to the comment's worker or the tick;
//     `display dialog` with "Read it to me" / "Dismiss (no voice)",
//     Dismiss the default and the cancel button, no giving up; Glass and `say` play only on "Read it to me".
// `spawnMoveAlert` writes `spawning` on each channel a worker can claim, then starts `bun surface/scripts/lane.ts move-alert
// <wl> <E>` detached, which runs `runMoveAlert`.
//
// Every claim, progress mark and result is a ledger entry by LANE_RUNNER_BY on E's workload (the one crash-safe store):
// `quota-move-alert: <E> <comment|popup> spawning` | `claim pid=<pid> attempt=<n>` | `showing` | `ok <url|button>` |
// `failed <error>` | `unstarted <why>` | `again <why>`. A channel is claimed in one write transaction only when its newest status
// is not ok, it has no live claim, and fewer than MOVE_ALERT_ATTEMPTS attempts (claims and unstarted rows) stand since its last
// `again`, so two workers never run one channel; the popup also only once the comment has a result (`claimChannel`). A claim is
// live while its pid is a `lane.ts move-alert` process (`PidProbe`)
// inside its deadline: a comment claim COMMENT_DEADLINE_MS from the claim, a popup claim POPUP_SHOW_DEADLINE_MS to its
// `showing` (after `showing` the popup waits on Jo with no deadline, its pid the only liveness test). Past its deadline a claim
// is stalled (SIGTERM, then `failed stalled: …`); a claim whose pid is gone with no result is dead (`failed worker <pid> ended
// without a result`); a channel with no claim UNSTARTED_AFTER_MS after the move or after its `spawning` (and its other channel
// not running) is unstarted. The train tick (surface/scripts/train-tick.ts) settles those over every workload, open or closed,
// through `superviseMove`, and spawns the worker again while a channel can still run. After MOVE_ALERT_ATTEMPTS failed
// attempts a channel is exhausted until `move-alert <wl> <E> --again` opens a new block. `moveAlertTroubles` is the
// state-derived failure line's query.
import { closeSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "bun";
import { SCRATCH_ENV } from "../../gates/src/scratch";
import { LANE_ENV, ROLE_ENV, WORKLOAD_ENV } from "../../gates/src/types";
import { homeDir, LANE_RUNNER_BY, type Ledger, type MessageRow } from "../../ledger/src/index";
import { field, fileNotice, type Gh, type GhResult, GhError, ghJsonOf, issueNumber, issueOps } from "./jo-issues";
import { LANE_SCRIPT, laneDir } from "./launch";
import { TRAIN_ALERT_MENTION, TRAIN_ALERT_REPO } from "./merge-train";
import { psAnswer, runPs } from "./omp-probe";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID } from "./types";

/** The orchestrator-bound message a move writes beside its event entry; a pushed signal no lane may write. */
export const QUOTA_MOVE_PREFIX = "quota-move:";
/** A channel's claim, progress and result rows, by LANE_RUNNER_BY on the move's workload. */
export const QUOTA_MOVE_ALERT_PREFIX = "quota-move-alert:";
/** Attempts per block before a channel is exhausted; `--again` opens a new block. */
export const MOVE_ALERT_ATTEMPTS = 3;
/** A comment claim's deadline from the claim: three gh calls of at most 60 s each. */
export const COMMENT_DEADLINE_MS = 180_000;
/** A popup claim's deadline from the claim to its `showing` row. */
export const POPUP_SHOW_DEADLINE_MS = 30_000;
/** A channel with no row this long after the move (or after its other channel's newest row) is unstarted. */
export const UNSTARTED_AFTER_MS = 60_000;
export const MOVE_ALERT_CHANNELS = ["comment", "popup"] as const;
export type MoveAlertChannel = (typeof MOVE_ALERT_CHANNELS)[number];
/** The popup's two buttons (the alarm rule): the voice one, and the silent default and cancel one. */
export const READ_IT_BUTTON = "Read it to me";
export const DISMISS_BUTTON = "Dismiss (no voice)";
/** The popup: a silent dialog that waits for Jo (no giving up), Dismiss the default for Return and the cancel for Escape. */
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
const errText = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err));

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

/** The id of event E's `quota-move:` message: it ties the message to its event for the supervisor and the failure line. */
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

/** The NOW line's text for a move (and the popup's and the comment's). */
export function moveText(move: QuotaMove): string {
	return `${move.subject} on ${move.workloadId} moved ${move.from} -> ${move.to} (${move.reason})`;
}

/** `as2: <lane|hand> moved off <from lab>`: the issue's and the popup's title. */
export function moveTitle(move: QuotaMove): string {
	return `as2: ${move.kind} moved off ${move.from.split("/")[0]}`;
}

export const issueMarker = (eventId: string): string => `<!-- as2-quota-move ${eventId} -->`;
export const commentMarker = (eventId: string): string => `<!-- as2-quota-move-comment ${eventId} -->`;

/** The @thewolff comment: the mention first, then the subject (lane, and hand token and slice for a hand), workload, from, to, reason, then its marker. */
export function commentBody(move: QuotaMove): string {
	return `${TRAIN_ALERT_MENTION} ${moveText(move)}. Lane move alert ${move.eventId}; nothing to answer.\n${commentMarker(move.eventId)}`;
}

/** One `quota-move-alert:` row of a move. */
export interface AlertRow {
	id: string;
	at: string;
	channel: MoveAlertChannel;
	status: string;
	rest: string;
}

const alertBody = (eventId: string, channel: MoveAlertChannel, status: string, rest = ""): string =>
	`${QUOTA_MOVE_ALERT_PREFIX} ${eventId} ${channel} ${status}${rest ? ` ${oneLine(rest)}` : ""}`;

/**
 * Every `quota-move-alert:` row of `move` by LANE_RUNNER_BY, oldest first (a lane-written look-alike is not one): on the move's
 * workload, and on the standing workload, where they go once the move's workload is closed (`recordAlertRow`).
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

/**
 * Write one of `move`'s rows (an `alertBody`) by LANE_RUNNER_BY: on its workload while that is open, else on the standing
 * workload (the ledger takes no entry on a closed workload, and a close must not strand an unfinished alert). Throws, naming
 * both, when neither is open. Returns the entry id.
 */
function recordAlertRow(ledger: Ledger, move: QuotaMove, body: string): string {
	return ledger.write(() => {
		const target = ledger.workload(move.workloadId)?.status === "open" ? move.workloadId : STANDING_WORKLOAD_ID;
		if (target === STANDING_WORKLOAD_ID && ledger.workload(STANDING_WORKLOAD_ID)?.status !== "open") {
			throw new Error(`quota-move-alert: ${move.eventId}: ${move.workloadId} is closed and the standing workload ${STANDING_WORKLOAD_ID} is not open, so "${body}" has nowhere to go; open the standing workload (the surface does at start)`);
		}
		return ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: target, kind: "assumption", body });
	});
}

/** Whether `pid` is a live `lane.ts move-alert` process; throws when ps cannot answer. */
export type PidProbe = (pid: number) => boolean;

/** A claim row and what followed it. */
export interface Claim {
	row: AlertRow;
	pid: number;
	attempt: number;
	showing: AlertRow | null;
}

/** Where one channel of one move stands now. `attempts` counts claims and unstarted rows since the last `again`. */
export type ChannelState =
	| { state: "ok"; attempts: number; row: AlertRow }
	| { state: "pending"; attempts: number }
	| { state: "spawning"; attempts: number; row: AlertRow; prior: AlertRow | null }
	| { state: "ready"; attempts: number; row: AlertRow }
	| { state: "running" | "waiting" | "dead"; attempts: number; claim: Claim }
	| { state: "stalled"; attempts: number; claim: Claim; missing: string; seconds: number }
	| { state: "unverifiable"; attempts: number; claim: Claim | null; error: string }
	| { state: "unstarted"; attempts: number; seconds: number; after: "move" | "spawn" }
	| { state: "failed" | "exhausted"; attempts: number; row: AlertRow };

/** The states a worker may claim from: never claimed yet, spawned for, `again`, or a failure with attempts left. */
const CLAIMABLE: Partial<Record<ChannelState["state"], true>> = { pending: true, spawning: true, ready: true, unstarted: true, failed: true };
/** The comment states that are a result: only after one is the popup claimable (the alarm rule: the silent channels first). */
const COMMENT_RESULT: Partial<Record<ChannelState["state"], true>> = { ok: true, failed: true, exhausted: true };

/** One channel's state from `rows` (all of the move's) at `nowMs`. */
export function channelState(move: QuotaMove, rows: readonly AlertRow[], channel: MoveAlertChannel, nowMs: number, probe: PidProbe): ChannelState {
	const mine = rows.filter((r) => r.channel === channel);
	const block = mine.slice(mine.findLastIndex((r) => r.status === "again") + 1);
	const attempts = block.filter((r) => r.status === "claim" || r.status === "unstarted").length;
	const ok = mine.findLast((r) => r.status === "ok");
	if (ok !== undefined) return { state: "ok", attempts, row: ok };
	const newest = mine.at(-1);
	if (newest === undefined || newest.status === "spawning") {
		// No worker has claimed the channel since the move (no row) or since a worker was spawned for it (`spawning`). The worker
		// runs the comment, then the popup: the channel waits while its other channel's claim runs, and is unstarted once
		// UNSTARTED_AFTER_MS passed since the move or the spawn with no claim.
		const other = channel === "comment" ? "popup" : "comment";
		const otherNewest = rows.findLast((r) => r.channel === other);
		// Only a claim of the other channel can be running; reading its state then never comes back here.
		const busy = otherNewest?.status === "claim" || otherNewest?.status === "showing";
		const o = busy ? channelState(move, rows, other, nowMs, probe).state : null;
		const since = Date.parse(newest?.at ?? move.at);
		if (o !== "running" && o !== "unverifiable" && nowMs - since >= UNSTARTED_AFTER_MS) {
			return { state: "unstarted", attempts, seconds: Math.round((nowMs - since) / 1000), after: newest === undefined ? "move" : "spawn" };
		}
		if (newest === undefined) return { state: "pending", attempts };
		return { state: "spawning", attempts, row: newest, prior: mine.findLast((r) => r.status !== "spawning") ?? null };
	}
	if (newest.status === "again") return { state: "ready", attempts, row: newest };
	if (newest.status === "claim" || newest.status === "showing") {
		const row = mine.findLast((r) => r.status === "claim");
		const m = row === undefined ? null : /^pid=(\d+) attempt=(\d+)$/.exec(row.rest);
		if (row === undefined || m === null) return { state: "unverifiable", attempts, claim: null, error: `${newest.id} follows no claim entry naming a pid` };
		const claim: Claim = { row, pid: Number(m[1]), attempt: Number(m[2]), showing: newest.status === "showing" ? newest : null };
		let alive: boolean;
		try {
			alive = probe(claim.pid);
		} catch (err) {
			return { state: "unverifiable", attempts, claim, error: `ps could not tell whether worker ${claim.pid} lives: ${errText(err)}` };
		}
		if (!alive) return { state: "dead", attempts, claim };
		if (channel === "popup" && claim.showing !== null) return { state: "waiting", attempts, claim };
		const elapsed = nowMs - Date.parse(row.at);
		if (elapsed < (channel === "comment" ? COMMENT_DEADLINE_MS : POPUP_SHOW_DEADLINE_MS)) return { state: "running", attempts, claim };
		return { state: "stalled", attempts, claim, missing: channel === "comment" ? "no comment result" : "no showing", seconds: Math.round(elapsed / 1000) };
	}
	return { state: attempts >= MOVE_ALERT_ATTEMPTS ? "exhausted" : "failed", attempts, row: newest };
}

/** What a settle needs: the pid probe and the SIGTERM sender. The clock is the ledger's (`ledger.now()`). */
export interface SettleSeams {
	probe: PidProbe;
	/** SIGTERM to `pid`; throws when it cannot be sent. */
	kill: (pid: number) => void;
}

/**
 * Settle one channel in one write: a stalled claim gets SIGTERM and `failed stalled: <missing> after <s> s (pid <pid>)`; a dead
 * one `failed worker <pid> ended without a result`; with `unstarted`, a channel with no row past UNSTARTED_AFTER_MS gets
 * `unstarted no claim <s> s after the move` (an attempt). Returns the body written, or null.
 */
export function settleChannel(ledger: Ledger, move: QuotaMove, channel: MoveAlertChannel, seams: SettleSeams, unstarted: boolean): string | null {
	return ledger.write(() => {
		const s = channelState(move, alertRows(ledger, move), channel, Date.parse(ledger.now()), seams.probe);
		let body: string | null = null;
		if (s.state === "stalled") {
			let note = "";
			try {
				seams.kill(s.claim.pid);
			} catch (err) {
				note = `; SIGTERM to ${s.claim.pid} failed: ${errText(err)}`;
			}
			body = alertBody(move.eventId, channel, "failed", `stalled: ${s.missing} after ${s.seconds} s (pid ${s.claim.pid})${note}`);
		} else if (s.state === "dead") body = alertBody(move.eventId, channel, "failed", `worker ${s.claim.pid} ended without a result`);
		else if (s.state === "unstarted" && unstarted) body = alertBody(move.eventId, channel, "unstarted", `no claim ${s.seconds} s after the ${s.after}`);
		if (body !== null) recordAlertRow(ledger, move, body);
		return body;
	});
}

/** A state in a few words, for a refusal or a log line. */
function stateText(s: ChannelState): string {
	switch (s.state) {
		case "ok":
			return `ok ${s.row.rest}`;
		case "running":
		case "waiting":
			return `${s.state === "waiting" ? "waiting on Jo" : "running"} (pid ${s.claim.pid}, attempt ${s.claim.attempt})`;
		case "exhausted":
			return `exhausted after ${s.attempts} attempts: ${s.row.status} ${s.row.rest}`;
		case "unverifiable":
			return `unverifiable: ${s.error}`;
		default:
			return s.state;
	}
}

/**
 * Claim one channel for worker `pid` in one write transaction: settle a stalled or dead claim first, then write `claim
 * pid=<pid> attempt=<n>` only when the channel is claimable (no row yet, `again`, or failed with attempts left). The popup is
 * claimable only once the comment has a result (`ok`, `failed` or `exhausted`; a stalled or dead comment claim is settled to
 * `failed` here first), never while the comment is unclaimed, spawned for, `again` or running. Returns the claim's entry id,
 * or why it was not claimed.
 */
export function claimChannel(ledger: Ledger, move: QuotaMove, channel: MoveAlertChannel, seams: SettleSeams & { pid: number }): { claimed: string; attempt: number } | { refused: string } {
	return ledger.write(() => {
		settleChannel(ledger, move, channel, seams, false);
		if (channel === "popup") settleChannel(ledger, move, "comment", seams, false);
		const rows = alertRows(ledger, move);
		const now = Date.parse(ledger.now());
		const s = channelState(move, rows, channel, now, seams.probe);
		if (CLAIMABLE[s.state] !== true || s.attempts >= MOVE_ALERT_ATTEMPTS) return { refused: stateText(s) };
		if (channel === "popup") {
			const comment = channelState(move, rows, "comment", now, seams.probe);
			if (COMMENT_RESULT[comment.state] !== true) {
				return { refused: `the comment has no result yet (comment ${stateText(comment)}): the popup follows it, so it is left to the worker that runs the comment, or to the train tick` };
			}
		}
		const attempt = s.attempts + 1;
		const claimed = recordAlertRow(ledger, move, alertBody(move.eventId, channel, "claim", `pid=${seams.pid} attempt=${attempt}`));
		return { claimed, attempt };
	});
}

/**
 * A worker's row for its claim `claimId`: `ok` is always written (a result that landed is never lost); `showing` and `failed`
 * only while that claim is still the channel's current one, else false (a settle or a newer claim superseded it).
 */
function writeClaimRow(ledger: Ledger, move: QuotaMove, channel: MoveAlertChannel, claimId: string, status: "showing" | "ok" | "failed", rest: string): boolean {
	return ledger.write(() => {
		const mine = alertRows(ledger, move).filter((r) => r.channel === channel);
		const current = mine.findLast((r) => r.status === "claim")?.id === claimId && (mine.at(-1)!.status === "claim" || mine.at(-1)!.status === "showing");
		if (status !== "ok" && !current) return false;
		recordAlertRow(ledger, move, alertBody(move.eventId, channel, status, rest));
		return true;
	});
}

/** One popup process as run: its exit code (null when killed by a signal) and both streams. */
export interface PopupResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** The worker's seams (`lane.ts move-alert` wires the real ones; tests pass fakes). The clock is the ledger's. */
export interface MoveAlertSeams extends SettleSeams {
	gh: Gh;
	/** The popup (`POPUP_SCRIPT` through osascript): waits for Jo's answer. */
	popup: (title: string, text: string) => PopupResult;
	/** Glass, then `say text`; only after "Read it to me". Returns null, or what failed. */
	voice: (text: string) => string | null;
	/** This worker's pid, recorded in its claims. */
	pid: number;
	log: (line: string) => void;
}

/** The comment channel's effects: the event's issue (found by marker or created), then the @thewolff comment (found by marker or posted); its url. */
function postComment(move: QuotaMove, gh: Gh): string {
	const ghJson = ghJsonOf(gh);
	const ops = issueOps(gh, ghJson);
	const body = [
		moveText(move),
		"",
		`Workload ${move.workloadId}, event ${move.eventId}. The needs-you NOW line and a silent popup carry the same move; nothing here needs an answer.`,
	].join("\n");
	const issue = fileNotice(ops, issueMarker(move.eventId), moveTitle(move), body);
	const n = issueNumber(issue);
	const comments = field(ghJson(["issue", "view", n, "-R", TRAIN_ALERT_REPO, "--json", "comments"]), "comments");
	if (!Array.isArray(comments)) throw new GhError(`gh issue view ${n} -R ${TRAIN_ALERT_REPO} --json comments returned no comments array`);
	const marker = commentMarker(move.eventId);
	const found = comments.find((c) => {
		const b = field(c, "body");
		return typeof b === "string" && b.includes(marker);
	});
	if (found !== undefined) {
		const url = field(found, "url");
		return typeof url === "string" && url !== "" ? url : issue;
	}
	const out = ops.run(["issue", "comment", n, "-R", TRAIN_ALERT_REPO, "--body", commentBody(move)]);
	return out.trim().split("\n").filter(Boolean).at(-1) ?? issue;
}

/**
 * `lane.ts move-alert <wl> <E> [--again]`: with `again`, open a new block on each exhausted channel; then the comment channel,
 * then the popup channel whatever the comment's result, each only when this worker claims it (the popup only once the comment
 * has a result: a worker that finds the comment running elsewhere leaves the popup to that worker or the tick, and says so).
 * Exit 0 when nothing failed and no channel is left exhausted, 1 otherwise (or when E is no move on `wl`).
 */
export function runMoveAlert(ledger: Ledger, seams: MoveAlertSeams, wl: string, eventId: string, again: boolean): number {
	const move = quotaMove(ledger, eventId);
	if (move === null || move.workloadId !== wl) {
		seams.log(`move-alert: ${eventId} is not a recorded move on ${wl} (no ${quotaMoveMessageId(eventId)} quota-move: message beside its event entry${move ? `; it is on ${move.workloadId}` : ""}); nothing was done: check the ids`);
		return 1;
	}
	if (again) {
		const opened = ledger.write(() =>
			MOVE_ALERT_CHANNELS.filter((c) => {
				const s = channelState(move, alertRows(ledger, move), c, Date.parse(ledger.now()), seams.probe);
				if (s.state !== "exhausted") {
					seams.log(`move-alert ${eventId}: ${c} is ${stateText(s)}, not exhausted: no new block`);
					return false;
				}
				recordAlertRow(ledger, move, alertBody(eventId, c, "again", `by hand after ${s.attempts} attempts`));
				return true;
			}));
		for (const c of opened) seams.log(`move-alert ${eventId}: ${c}: a new block of ${MOVE_ALERT_ATTEMPTS} attempts opened`);
	}
	let failed = false;
	const claim = (c: MoveAlertChannel): string | null => {
		const r = claimChannel(ledger, move, c, seams);
		if ("claimed" in r) return r.claimed;
		seams.log(`move-alert ${eventId}: ${c} not run: ${r.refused}`);
		if (r.refused.startsWith("exhausted") || r.refused.startsWith("unverifiable")) failed = true;
		return null;
	};
	const result = (c: MoveAlertChannel, claimId: string, status: "ok" | "failed", rest: string) => {
		if (status === "failed") failed = true;
		const written = writeClaimRow(ledger, move, c, claimId, status, rest);
		seams.log(`move-alert ${eventId}: ${c} ${status} ${rest}${written ? "" : ` (not recorded: claim ${claimId} was settled or superseded meanwhile)`}`);
	};
	// 1. jo-issues: the issue, then the @thewolff comment.
	const commentClaim = claim("comment");
	if (commentClaim !== null) {
		let url: string | null = null;
		try {
			url = postComment(move, seams.gh);
		} catch (err) {
			result("comment", commentClaim, "failed", errText(err));
		}
		if (url !== null) result("comment", commentClaim, "ok", url);
	}
	// 2. The popup, whatever the comment's result: `showing` immediately before the dialog, no sound unless Jo picks the voice.
	const popupClaim = claim("popup");
	if (popupClaim !== null) {
		if (!writeClaimRow(ledger, move, "popup", popupClaim, "showing", "")) {
			seams.log(`move-alert ${eventId}: popup not shown: claim ${popupClaim} was settled or superseded before the dialog`);
			return 1;
		}
		const text = moveText(move);
		let r: PopupResult | null = null;
		try {
			r = seams.popup(moveTitle(move), text);
		} catch (err) {
			result("popup", popupClaim, "failed", `the popup could not be run: ${errText(err)}`);
		}
		if (r !== null) {
			const button = r.code === 0 ? r.stdout.trim() || DISMISS_BUTTON : `${r.stderr}`.includes("(-128)") ? DISMISS_BUTTON : null;
			if (button === null) result("popup", popupClaim, "failed", `osascript exit ${r.code ?? "by signal"}: ${oneLine(r.stderr) || oneLine(r.stdout) || "no output"}`);
			else {
				const voiced = button === READ_IT_BUTTON ? seams.voice(text) : null;
				result("popup", popupClaim, "ok", voiced === null ? button : `${button}; the voice failed: ${voiced}`);
			}
		}
	}
	return failed ? 1 : 0;
}

/** The detached worker spawn: argv, env, and the log file its stdout and stderr append to; returns its pid or throws. */
export type MoveAlertSpawn = (argv: string[], env: Record<string, string>, log: string) => number;

/** `env` without the lane binding (role, workload, lane id, scratch root), as lane.ts `starterEnv` drops it: the worker is not a lane. */
export function unboundEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== ROLE_ENV && k !== WORKLOAD_ENV && k !== LANE_ENV && k !== SCRATCH_ENV) out[k] = v;
	return out;
}

/** Bun.spawn detached, stdin ignored, both streams appended to `log` (created with its directory), unref'd. */
export const spawnDetached: MoveAlertSpawn = (argv, env, log) => {
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(log, "a");
	try {
		const p = spawn(argv, { env, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
		p.unref();
		return p.pid;
	} finally {
		closeSync(fd);
	}
};

/** The bun that runs the worker: this process's when it is bun, else `bun` on PATH. */
const BUN = basename(process.execPath).startsWith("bun") ? process.execPath : "bun";

/**
 * Start `bun <repo>/surface/scripts/lane.ts move-alert <wl> <E>` detached, the lane binding dropped, logging to the lane dir's
 * move-alert.log; returns its pid. First, in one write, each channel a worker could claim (within its attempts) gets a
 * `spawning` row, so a worker that never claims it is unstarted UNSTARTED_AFTER_MS later (an attempt) and the train tick's
 * spawns stay bounded; with none, nothing is spawned and null is returned. A spawn failure is written, in one write, as
 * `unstarted spawn: <error>` on those channels (an attempt; the tick tries again within the bound) and returns null; when that
 * write fails too it throws naming both errors.
 */
export function spawnMoveAlert(ledger: Ledger, wl: string, eventId: string, spawnFn: MoveAlertSpawn = spawnDetached, probe: PidProbe = psMoveAlertProbe): number | null {
	const spawning = ledger.write(() => {
		const move = quotaMove(ledger, eventId);
		if (move === null || move.workloadId !== wl) throw new Error(`move-alert: ${eventId} is not a recorded move on ${wl}; no worker was spawned`);
		const rows = alertRows(ledger, move);
		const now = Date.parse(ledger.now());
		const open = MOVE_ALERT_CHANNELS.filter((c) => {
			const s = channelState(move, rows, c, now, probe);
			return CLAIMABLE[s.state] === true && s.attempts < MOVE_ALERT_ATTEMPTS;
		});
		for (const c of open) recordAlertRow(ledger, move, alertBody(eventId, c, "spawning"));
		return { move, open };
	});
	if (spawning.open.length === 0) return null;
	const argv = [BUN, LANE_SCRIPT, "move-alert", wl, eventId];
	try {
		return spawnFn(argv, unboundEnv(process.env), join(laneDir(wl, homeDir()), "move-alert.log"));
	} catch (err) {
		const why = errText(err);
		try {
			ledger.write(() => {
				for (const c of spawning.open) recordAlertRow(ledger, spawning.move, alertBody(eventId, c, "unstarted", `spawn: ${why}`));
			});
		} catch (writeErr) {
			throw new Error(`move-alert ${eventId} on ${wl}: the worker could not be spawned (${why}), and recording that failed too: ${errText(writeErr)}`);
		}
		return null;
	}
}

/** What the train tick's supervisor needs (`superviseMove`). */
export interface SuperviseSeams extends SettleSeams {
	spawn: MoveAlertSpawn;
}

/**
 * The train tick's pass over one move: nothing when both channels are ok or exhausted; else settle each stalled, dead and
 * unstarted channel, then spawn the worker when a channel can still run (failed with attempts left, or `again`); a channel a
 * worker was spawned for less than UNSTARTED_AFTER_MS ago gets no second one. Returns the lines to log.
 */
export function superviseMove(ledger: Ledger, move: QuotaMove, seams: SuperviseSeams): string[] {
	const states = () => {
		const rows = alertRows(ledger, move);
		const now = Date.parse(ledger.now());
		return MOVE_ALERT_CHANNELS.map((c) => channelState(move, rows, c, now, seams.probe));
	};
	if (states().every((s) => s.state === "ok" || s.state === "exhausted")) return [];
	const out: string[] = [];
	for (const c of MOVE_ALERT_CHANNELS) {
		const body = settleChannel(ledger, move, c, seams, true);
		if (body !== null) out.push(body);
	}
	const after = states();
	const runnable = MOVE_ALERT_CHANNELS.filter((_, i) => after[i]!.state === "failed" || after[i]!.state === "ready");
	if (runnable.length > 0) {
		const pid = spawnMoveAlert(ledger, move.workloadId, move.eventId, seams.spawn, seams.probe);
		out.push(pid === null ? `move-alert for ${runnable.join(", ")} could not be spawned (recorded unstarted)` : `move-alert spawned for ${runnable.join(", ")}: pid ${pid}`);
	}
	return out;
}

/** One move's failure for the needs-you line: its failing channels in words, the attempt, whether one is exhausted, and the state token. */
export interface MoveAlertTrouble {
	move: QuotaMove;
	/** `<channel> <status> <error>` per failing channel. */
	parts: string[];
	/** The highest attempt count among the failing channels. */
	attempt: number;
	exhausted: boolean;
	/** The newest status entry id of the move (E itself before any): a new failure is a new state, delivered again. */
	token: string;
}

/**
 * Every move on every workload, open or closed, with a channel failed, exhausted, stalled, dead, unstarted or unverifiable at
 * `nowMs`. A running claim, a popup showing with a live pid, a pending channel and an ok one are not failures.
 */
export function moveAlertTroubles(ledger: Ledger, nowMs: number, probe: PidProbe): MoveAlertTrouble[] {
	const out: MoveAlertTrouble[] = [];
	for (const move of quotaMoves(ledger)) {
		const rows = alertRows(ledger, move);
		const parts: string[] = [];
		let attempt = 0;
		let exhausted = false;
		for (const c of MOVE_ALERT_CHANNELS) {
			const s = channelState(move, rows, c, nowMs, probe);
			let part: string | null = null;
			if (s.state === "failed") part = `${c} ${s.row.status} ${s.row.rest}`;
			else if (s.state === "spawning" && s.prior !== null && (s.prior.status === "failed" || s.prior.status === "unstarted")) {
				// A retry was spawned and has not claimed yet: the failure it retries still shows.
				part = `${c} ${s.prior.status} ${s.prior.rest}`;
			} else if (s.state === "exhausted") {
				exhausted = true;
				part = `${c} exhausted after ${s.attempts} attempts, last ${s.row.status} ${s.row.rest}`;
			} else if (s.state === "stalled") part = `${c} stalled: ${s.missing} after ${s.seconds} s (pid ${s.claim.pid})`;
			else if (s.state === "dead") part = `${c} dead: worker ${s.claim.pid} ended without a result`;
			else if (s.state === "unstarted") part = `${c} unstarted: no claim ${s.seconds} s after the ${s.after}`;
			else if (s.state === "unverifiable") part = `${c} unverifiable: ${s.error}`;
			if (part === null) continue;
			parts.push(part.trim());
			attempt = Math.max(attempt, s.attempts);
		}
		// `spawning` is progress, not a status: the token is the newest other row, so a spawn alone delivers nothing again.
		if (parts.length > 0) out.push({ move, parts, attempt, exhausted, token: rows.findLast((r) => r.status !== "spawning")?.id ?? move.eventId });
	}
	return out;
}

/** gh at `bin` (AS2_MOVE_ALERT_GH, else `gh`), 60 s at most per call. */
export function ghCommand(bin: string): Gh {
	return (args) => {
		const r = spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
		return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.exitedDueToTimeout ? `${bin} ${args.slice(0, 3).join(" ")} timed out after 60 s` : r.stderr.toString() };
	};
}

/** The popup through osascript at `bin` (AS2_MOVE_ALERT_OSASCRIPT, else /usr/bin/osascript): no timeout, it waits on Jo. */
export function osascriptPopup(bin: string): MoveAlertSeams["popup"] {
	return (title, text) => {
		const r = spawnSync([bin, ...POPUP_SCRIPT.flatMap((l) => ["-e", l]), title, text], { stdout: "pipe", stderr: "pipe" });
		return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
	};
}

/** Glass, then `say`, each bounded; null, or what failed. */
export const glassAndSay: MoveAlertSeams["voice"] = (text) => {
	const failures: string[] = [];
	for (const argv of [["afplay", "/System/Library/Sounds/Glass.aiff"], ["say", text]]) {
		const r = spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
		if (r.exitCode !== 0) failures.push(`${argv[0]} exit ${r.exitCode ?? "by signal"}${r.stderr.toString().trim() ? `: ${oneLine(r.stderr.toString())}` : ""}`);
	}
	return failures.length > 0 ? failures.join("; ") : null;
};

/** ps's word on `pid` (`ps -p <pid> -o command=`, bounded): alive only as a `lane.ts move-alert` process. */
export const psMoveAlertProbe: PidProbe = (pid) => {
	const command = psAnswer(runPs, pid, "command=");
	return command !== null && command.includes("lane.ts") && /\bmove-alert\b/.test(command);
};

/** SIGTERM to `pid`. */
export const sigterm = (pid: number): void => {
	process.kill(pid, "SIGTERM");
};
