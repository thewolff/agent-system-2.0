// The alert path (PLAN wl-mw0vs9uc3xqtka D1, D3, D5): one ladder for every event that needs Jo, generalized from the merge
// train's alert ladder (merge-train.ts part 3, rev 17.1 D9-D10, which this replaces).
//
// An alert subject is one thing Jo must hear about, computed fresh by every pass from ledger state and files (the sources,
// surface/src/alert-sources.ts, and the quota watch, surface/src/quota-watch.ts). One key per (event kind, thing): a repeat
// of the event is the same key and the same episode. The pass's memory is the `alert:` rows ALERT_BY writes on the standing
// workload (writers in surface/src/launch.ts `alertBody`), read back here as episodes (`alertRecords`): `raised` opens one
// (its entry id is the episode id), `level <n> sending|sent` records each send, `updated` a changed text's one comment,
// `error` a failed channel, `adopted` a legacy alert taken over at cutover, `acked` and `closed` the ends. `alertActions` is
// the pure decision: subjects, records, what the pass read of the issues and Jo's `ack` words, and the time, in; the raises,
// sends, updates, acks and closes owed now, out. surface/scripts/alert-tick.ts does the effects.
//
// Also here: `urgencyOf` (D5: Jo's urgent / asap / calm word, else the Jo input the brief cites or its quoted words),
// `stopIssueUrl` (D2.4: the incident issue a land-first stop's named fix is read from), the markers each effect carries,
// and the parsers of the legacy alerts' rows and markers that cutover adoption reads (D3).
import { createHash } from "node:crypto";
import type { EntryRow, InstructionRow } from "../../ledger/src/index";
import { ALERT_POPUP_STEPS, type AlertPopupStep, type AlertRow, type ControlEntry, controlEntries } from "./launch";
import type { StopEpisode } from "./merge-train";

/** What kind of event a subject is; one key per (kind, thing). */
export type AlertKind =
	| "ceiling"
	| "died"
	| "parked"
	| "train"
	| "released-alive"
	| "main-red"
	| "chaos"
	| "quota-move"
	| "quota";

/**
 * One thing Jo must hear about, computed fresh by every pass from ledger state and files (level-triggered).
 * `key` is `<kind prefix>:<id>`: `ceiling:wl-…`, `died:wl-…`, `parked:wl-…`, `q:q-…`, `lane:lane-…`,
 * `main:<owner/repo>`, `chaos:<report file name>`, `move:<entry id>`, `quota:<rows key>:<rule>`.
 */
export interface AlertSubject {
	key: string;
	kind: AlertKind;
	workloadId: string | null;
	/** 1, or 2 (the popup level) for quota moves, quota alerts and urgent workloads' subjects. */
	startLevel: 1 | 2;
	/** One line naming the thing in words. */
	title: string;
	/** The facts, one or more lines. */
	text: string;
	/** The one thing Jo does, e.g. `extend wl-…`. */
	next: string;
}

/** Every kind, for the `raised` row's parse (a kind missing here fails to compile). */
const ALERT_KINDS: Record<AlertKind, true> = {
	ceiling: true, died: true, parked: true, train: true, "released-alive": true, "main-red": true, chaos: true, "quota-move": true, quota: true,
};

// ---- the ladder ---------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** A channel one ladder level uses: the needs-you line, the jo-issues issue, an @thewolff comment, a label, the silent popup. */
export type AlertChannel = "line" | "issue" | "comment" | "label" | "popup";

export interface AlertLadderStep {
	level: 1 | 2 | 3;
	/** How long after level 1 was sent this level is due (level 1: at raise). A subject starting at 2 gets level 2 at raise. */
	afterMs: number;
	/** The labels this level adds beside as2-train. */
	labels: readonly string[];
	/** Its channels, in the order the pass runs them (silent channels first, the popup last; the 10/28 rule). */
	channels: readonly AlertChannel[];
}

/**
 * The send ladder (D1; it replaces merge-train.ts's TRAIN_ALERT_LADDER with the same levels and timings, the notification
 * replaced by the popup). Level 1 at raise: the ALERT needs-you line and a jo-issues issue (label as2-train, so the issues intake
 * keeps skipping it). Level 2, 4 h after level 1 was sent (or at raise for a subject starting at 2): an @thewolff comment, the
 * `loud` label, the LOUD line and a silent stay-up popup. Level 3, 8 h after level 1: a comment, the `critical` label and the
 * popup again. Nothing is sent after level 3.
 */
export const ALERT_LADDER: readonly AlertLadderStep[] = [
	{ level: 1, afterMs: 0, labels: [], channels: ["line", "issue"] },
	{ level: 2, afterMs: 4 * HOUR_MS, labels: ["loud"], channels: ["comment", "label", "line", "popup"] },
	{ level: 3, afterMs: 8 * HOUR_MS, labels: ["loud", "critical"], channels: ["comment", "label", "popup"] },
];

/** The short digest of what a subject says (title, text, next): a change is one `updated` comment. */
export function alertDigest(s: Pick<AlertSubject, "title" | "text" | "next">): string {
	return createHash("sha256").update(`${s.title}\n${s.text}\n${s.next}`).digest("hex").slice(0, 12);
}

/**
 * The marker each effect of episode `episode` carries (D3, r2 C), looked up before the effect so a lost reply is adopted,
 * never repeated: `create` in the issue body, `level <n>` and `update <digest>` in comments, `merged-into` on a merged
 * legacy issue's closing comment.
 */
export function alertMarker(key: string, episode: string, effect: "create" | `level ${number}` | `update ${string}` | "merged-into"): string {
	return `<!-- as2-alert ${key} ${episode} ${effect} -->`;
}

// ---- the records --------------------------------------------------------------------------------

/** One `alert:` row as read: its entry, its key and the parsed row. */
export interface AlertRowEntry {
	id: string;
	at: string;
	key: string;
	row: AlertRow;
}

const ROW_RE = /^(\S+) (raised|level|updated|error|adopted|merged|merged-closed|legacy-popup|acked|closed)(?: ([\s\S]*))?$/;

/** The `alert:` rest (`controlEntries`' `rest`) parsed, or null when it is not that grammar (`alertBody`'s inverse). */
export function parseAlertRow(rest: string): { key: string; row: AlertRow } | null {
	const top = ROW_RE.exec(rest);
	if (!top) return null;
	const key = top[1]!;
	const tail = top[3] ?? "";
	let m: RegExpExecArray | null;
	switch (top[2]) {
		case "raised":
			m = /^(\S+) start ([12]) (\S+)$/.exec(tail);
			if (!m || !Object.hasOwn(ALERT_KINDS, m[1]!)) return null;
			return { key, row: { row: "raised", kind: m[1] as AlertKind, start: Number(m[2]) as 1 | 2, digest: m[3]! } };
		case "level":
			m = /^([1-9]) (sending|sent)(?: (\S+))?$/.exec(tail);
			return m ? { key, row: { row: "level", level: Number(m[1]), step: m[2] as "sending" | "sent", url: m[3] ?? null } } : null;
		case "updated":
			m = /^(\S+)$/.exec(tail);
			return m ? { key, row: { row: "updated", digest: m[1]! } } : null;
		case "error":
			m = /^(\S+) (.+)$/.exec(tail);
			return m ? { key, row: { row: "error", channel: m[1]!, text: m[2]! } } : null;
		case "adopted":
			m = /^(\S+) level ([0-3]) from (.+)$/.exec(tail);
			return m ? { key, row: { row: "adopted", url: m[1] === "none" ? null : m[1]!, level: Number(m[2]), from: m[3]! } } : null;
		case "merged":
			m = /^(\S+) into (\S+)$/.exec(tail);
			return m ? { key, row: { row: "merged", url: m[1]!, into: m[2]! } } : null;
		case "merged-closed":
			m = /^(\S+)$/.exec(tail);
			return m ? { key, row: { row: "merged-closed", url: m[1]! } } : null;
		case "legacy-popup":
			return tail === "" ? null : { key, row: { row: "legacy-popup", text: tail } };
		default:
			return { key, row: { row: top[2] as "acked" | "closed", why: tail } };
	}
}

/** One episode of a key: from its `raised` (or `adopted`) row to its `closed` row. */
export interface AlertEpisode {
	key: string;
	/** The opening row's entry id. */
	id: string;
	openedAt: string;
	opened: "raised" | "adopted";
	/** The raise's kind and start level; null for an adopted episode. */
	kind: AlertKind | null;
	start: 1 | 2 | null;
	/** The legacy alert an adopted episode took over (`from <ref>`), else null. */
	adoptedFrom: string | null;
	/** The digest of the text the issue last carried: the raise's, then each `updated`; null for an adopted episode until updated. */
	digest: string | null;
	/** The issue: level 1's `sent` url, or the adopted one. */
	url: string | null;
	/** Per level, when `sending` and `sent` were first written (an adopted level n counts levels 1..n sent at adoption). */
	sending: Map<number, string>;
	sent: Map<number, string>;
	/** The newest error per channel (`gh`, `popup`, …). */
	errors: Map<string, { text: string; at: string; id: string }>;
	/** Each legacy issue merged into this one: its canonical url, and when `merged-closed` was written. */
	merged: Map<string, { into: string; closedAt: string | null }>;
	acked: { why: string; at: string } | null;
	closed: { why: string; at: string } | null;
}

/** Every row and episode of one key: the episodes oldest first, and the rows that fell outside any (`legacy-popup`, a pre-adoption `error`). */
export interface AlertKeyRecord {
	key: string;
	episodes: AlertEpisode[];
	loose: AlertRowEntry[];
}

/**
 * Every key's record among the standing workload's control entries (`alert:`, valid only from ALERT_BY), oldest first. One
 * episode per key at a time: a `raised` or `adopted` row while an episode is open is kept as a loose row and opens nothing;
 * a row after `closed` that is not a new opening is loose too.
 */
export function alertRecords(control: readonly ControlEntry[]): Map<string, AlertKeyRecord> {
	const out = new Map<string, AlertKeyRecord>();
	for (const c of control) {
		if (c.prefix !== "alert") continue;
		const p = parseAlertRow(c.rest);
		if (p === null) continue;
		const rec = out.get(p.key) ?? { key: p.key, episodes: [], loose: [] };
		out.set(p.key, rec);
		const entry: AlertRowEntry = { id: c.id, at: c.createdAt, key: p.key, row: p.row };
		const open = openEpisode(rec);
		const r = p.row;
		if (r.row === "raised" || r.row === "adopted") {
			if (open !== null) {
				rec.loose.push(entry);
				continue;
			}
			const raised = r.row === "raised";
			const ep: AlertEpisode = {
				key: p.key, id: c.id, openedAt: c.createdAt, opened: r.row, kind: raised ? r.kind : null, start: raised ? r.start : null,
				adoptedFrom: raised ? null : r.from, digest: raised ? r.digest : null, url: raised ? null : r.url,
				sending: new Map(), sent: new Map(), errors: new Map(), merged: new Map(), acked: null, closed: null,
			};
			// An adopted level n counts levels 1..n as begun and sent at adoption.
			for (let l = 1; l <= (raised ? 0 : r.level); l++) {
				ep.sending.set(l, c.createdAt);
				ep.sent.set(l, c.createdAt);
			}
			rec.episodes.push(ep);
			continue;
		}
		if (open === null) {
			rec.loose.push(entry);
			continue;
		}
		switch (r.row) {
			case "level":
				if (r.step === "sending") {
					if (!open.sending.has(r.level)) open.sending.set(r.level, c.createdAt);
				} else if (!open.sent.has(r.level)) {
					open.sent.set(r.level, c.createdAt);
					if (r.level === 1 && r.url !== null) open.url ??= r.url;
				}
				break;
			case "updated":
				open.digest = r.digest;
				break;
			case "error":
				open.errors.set(r.channel, { text: r.text, at: c.createdAt, id: c.id });
				break;
			case "merged":
				if (!open.merged.has(r.url)) open.merged.set(r.url, { into: r.into, closedAt: null });
				break;
			case "merged-closed": {
				const m = open.merged.get(r.url);
				if (m === undefined) rec.loose.push(entry);
				else m.closedAt ??= c.createdAt;
				break;
			}
			case "legacy-popup":
				rec.loose.push(entry);
				break;
			case "acked":
				open.acked ??= { why: r.why, at: c.createdAt };
				break;
			case "closed":
				open.closed = { why: r.why, at: c.createdAt };
				break;
		}
	}
	return out;
}

/** The key's open episode (no `closed` yet; an acked one is still open, and silent), or null. */
export function openEpisode(rec: AlertKeyRecord | undefined): AlertEpisode | null {
	const last = rec?.episodes.at(-1);
	return last !== undefined && last.closed === null ? last : null;
}

/** The highest level begun (`sending` or `sent`) on key `key`'s open episode, 0 when none is open: 2 and 3 make the line LOUD (D4). */
export function alertLevel(records: ReadonlyMap<string, AlertKeyRecord>, key: string): number {
	const ep = openEpisode(records.get(key));
	return ep === null ? 0 : Math.max(0, ...ep.sending.keys(), ...ep.sent.keys());
}

/** Whether an error on `channel` with `text` is new for the episode (D1: `error` rows are written again only when the text changes). */
export function errorChanged(ep: AlertEpisode, channel: string, text: string): boolean {
	return ep.errors.get(channel)?.text !== text.replace(/\s+/g, " ").trim();
}

// ---- popup rows ---------------------------------------------------------------------------------

/** One `alert-popup:` row: the key, episode and level it is about, its step and the step's detail. */
export interface AlertPopupRow {
	id: string;
	at: string;
	key: string;
	episode: string;
	level: number;
	step: AlertPopupStep;
	detail: string;
}

const POPUP_RE = /^(\S+) (\S+) ([1-9]) (\S+)(?: ([\s\S]*))?$/;

/** Every valid `alert-popup:` row (ALERT_BY's, `alertPopupBody`'s grammar), oldest first. */
export function alertPopupRows(control: readonly ControlEntry[]): AlertPopupRow[] {
	const out: AlertPopupRow[] = [];
	for (const c of control) {
		const m = c.prefix === "alert-popup" ? POPUP_RE.exec(c.rest) : null;
		if (!m || !(ALERT_POPUP_STEPS as readonly string[]).includes(m[4]!)) continue;
		out.push({ id: c.id, at: c.createdAt, key: m[1]!, episode: m[2]!, level: Number(m[3]), step: m[4] as AlertPopupStep, detail: m[5] ?? "" });
	}
	return out;
}

/** When Jo last answered a popup of key `key` (the newest `ok <button>` row, any episode and level), or null. */
export function alertPopupAnsweredAt(control: readonly ControlEntry[], key: string): string | null {
	return alertPopupRows(control).filter((r) => r.key === key && r.step === "ok").at(-1)?.at ?? null;
}

// ---- Jo's ack word ------------------------------------------------------------------------------

/** Jo's word that acknowledges alerts (D6): `ack <wl-…|alert key>`, recorded as his instruction with that body. */
export const ACK_WORD = "ack";

/** One `ack <target>` of Jo's: a workload id (every open episode of that workload) or one alert key. */
export interface AlertAck {
	target: string;
	/** The instruction's id and time; an ack acknowledges only episodes opened at or before it. */
	id: string;
	at: string;
}

/** Jo's `ack <target>` instructions among `instructions` (author jo), oldest first. */
export function alertAcks(instructions: readonly InstructionRow[]): AlertAck[] {
	const out: AlertAck[] = [];
	for (const i of instructions) {
		const m = i.author === "jo" ? /^ack\s+(\S+)$/i.exec(i.body.trim()) : null;
		if (m) out.push({ target: m[1]!, id: i.id, at: i.created_at });
	}
	return out;
}

// ---- the actions --------------------------------------------------------------------------------

/** What this pass read outside the ledger rows, and Jo's words, as `alertActions` takes them. */
export interface AlertSeen {
	/** Each open episode's issue state as this pass read it (`gh issue view --json state`), by episode id; absent when not read. */
	issueStates: ReadonlyMap<string, "OPEN" | "CLOSED">;
	/** Jo's `ack` words (`alertAcks`). */
	acks: readonly AlertAck[];
	/** Why a key that is no longer a subject cleared, when the caller knows (`Jo answered extend`); the close comment names it. */
	cleared?: ReadonlyMap<string, string>;
}

/**
 * What the pass owes one key now. `raise` writes `raised` (episode id = that row's id); a `send` whose `episode` is null
 * sends on the episode the `raise` before it in the same list opened. `ack` closes the issue (Jo's word) or only records it
 * (Jo closed it), and writes `acked`. `close` closes the issue with `why` (once; an acked episode's issue is already closed)
 * and writes `closed`; an episode whose level 1 was begun with no url recorded has its issue found by its `create` marker.
 */
export type AlertAction =
	| { kind: "raise"; subject: AlertSubject; digest: string }
	| { kind: "send"; subject: AlertSubject; episode: AlertEpisode | null; level: number; step: AlertLadderStep }
	| { kind: "update"; subject: AlertSubject; episode: AlertEpisode; digest: string }
	| { kind: "ack"; subject: AlertSubject; episode: AlertEpisode; by: "issue" | "word"; why: string }
	| { kind: "close"; key: string; episode: AlertEpisode; why: string };

/** The levels to send now on an episode (or a new one, `ep` null) for a subject starting at `start`. */
function sendsOwed(ep: AlertEpisode | null, start: 1 | 2, now: string): number[] {
	const sent = ep?.sent ?? new Map<number, string>();
	const out = ep === null ? [] : [...ep.sending.keys()].filter((l) => !sent.has(l)).sort((a, b) => a - b);
	const top = Math.max(0, ...sent.keys(), ...out);
	const first = sent.get(1);
	for (const step of ALERT_LADDER) {
		if (step.level <= top) continue;
		const due = step.level <= start || (first !== undefined && Date.parse(now) - Date.parse(first) >= step.afterMs);
		if (!due) break;
		out.push(step.level);
	}
	return out;
}

/**
 * The alert actions owed at `now` (D1; it generalizes merge-train.ts's trainAlertActions). Per key:
 * - an active subject with no open episode: `raise`, then level 1's send and, for a subject starting at 2, level 2's in the
 *   same pass (silent channels first, then the popup level);
 * - an open episode whose subject is gone: `close` once (acked or not), then nothing;
 * - an open, acked episode of an active subject: nothing (no second `raised` while an episode is open, and nothing is sent
 *   after `acked`);
 * - Jo closed the issue (`issueStates` CLOSED), or said `ack` on the key or its workload at or after the episode opened: `ack`;
 * - else, once level 1 was sent: `update` when the text's digest differs from the one the issue last carried; then the sends:
 *   every begun and unfinished level first (a crash between `sending` and `sent`), then each next level once due (4 h and
 *   8 h after level 1 was sent, and at once while below the subject's start level), until level 3.
 * A key the caller holds back (a legacy alert not yet adopted, D3) is simply left out of `subjects`. Two subjects with one
 * key are a sources bug and throw.
 */
export function alertActions(subjects: readonly AlertSubject[], records: ReadonlyMap<string, AlertKeyRecord>, seen: AlertSeen, now: string): AlertAction[] {
	const byKey = new Map<string, AlertSubject>();
	for (const s of subjects) {
		if (byKey.has(s.key)) throw new Error(`alertActions: two subjects with key ${s.key} (kinds ${byKey.get(s.key)!.kind} and ${s.kind}); each (event kind, thing) must be one subject`);
		byKey.set(s.key, s);
	}
	const out: AlertAction[] = [];
	for (const s of subjects) {
		const ep = openEpisode(records.get(s.key));
		if (ep === null) {
			out.push({ kind: "raise", subject: s, digest: alertDigest(s) });
			for (const level of sendsOwed(null, s.startLevel, now)) out.push({ kind: "send", subject: s, episode: null, level, step: ALERT_LADDER[level - 1]! });
			continue;
		}
		if (ep.acked !== null) continue;
		if (ep.url !== null && seen.issueStates.get(ep.id) === "CLOSED") {
			out.push({ kind: "ack", subject: s, episode: ep, by: "issue", why: `Jo closed ${ep.url}` });
			continue;
		}
		const ack = seen.acks.find((a) => a.at >= ep.openedAt && (a.target === s.key || (s.workloadId !== null && a.target === s.workloadId)));
		if (ack !== undefined) {
			out.push({ kind: "ack", subject: s, episode: ep, by: "word", why: `Jo said ack ${ack.target} (${ack.id})` });
			continue;
		}
		const digest = alertDigest(s);
		if (ep.sent.has(1) && ep.url !== null && ep.digest !== digest) out.push({ kind: "update", subject: s, episode: ep, digest });
		for (const level of sendsOwed(ep, s.startLevel, now)) out.push({ kind: "send", subject: s, episode: ep, level, step: ALERT_LADDER[level - 1]! });
	}
	for (const [key, rec] of records) {
		const ep = openEpisode(rec);
		if (ep === null || byKey.has(key)) continue;
		out.push({ kind: "close", key, episode: ep, why: seen.cleared?.get(key) ?? `${key} is no longer active` });
	}
	return out;
}

// ---- urgency (D5) -------------------------------------------------------------------------------

/** Jo's words on a workload's urgency (D6): `urgent <wl>` and `asap <wl>` make it urgent, `calm <wl>` clears it; the newest wins. */
export const URGENCY_WORDS = ["urgent", "asap", "calm"] as const;
export type UrgencyWord = (typeof URGENCY_WORDS)[number];

const URGENT_TEXT = /\b(asap|urgent)\b/i;

export interface Urgency {
	urgent: boolean;
	/** What decided it: `<word> <instruction id>`, the cited input's id, `brief quote`, or null when nothing did. */
	from: string | null;
	/** Input ids the brief cites that `inputRow` could not find (or that are not Jo's): the pass logs them. */
	unread: string[];
}

/**
 * Whether workload `w` is urgent (D5): Jo's newest `urgent|asap|calm <wl>` instruction on it decides; with none, the Jo input
 * rows its brief cites (`input in-…`, read through `inputRow`) or the brief's quoted words (`"…"` or `“…”`) matching
 * /\b(asap|urgent)\b/i. Read at pass time, so no backfill is needed.
 */
export function urgencyOf(
	w: { id: string; brief: string }, instructions: readonly InstructionRow[], inputRow: (id: string) => InstructionRow | null,
): Urgency {
	for (let i = instructions.length - 1; i >= 0; i--) {
		const row = instructions[i]!;
		const m = row.author === "jo" ? /^(urgent|asap|calm)\s+(wl-\S+)$/i.exec(row.body.trim()) : null;
		if (!m || m[2] !== w.id) continue;
		const word = m[1]!.toLowerCase();
		return { urgent: word !== "calm", from: `${word} ${row.id}`, unread: [] };
	}
	const unread: string[] = [];
	for (const m of w.brief.matchAll(/\binput (in-[a-z0-9]+)/g)) {
		const row = inputRow(m[1]!);
		if (row === null || row.author !== "jo") unread.push(m[1]!);
		else if (URGENT_TEXT.test(row.body)) return { urgent: true, from: row.id, unread };
	}
	for (const m of w.brief.matchAll(/"([^"]*)"|“([^”]*)”/g)) {
		if (URGENT_TEXT.test(m[1] ?? m[2] ?? "")) return { urgent: true, from: "brief quote", unread };
	}
	return { urgent: false, from: null, unread };
}

/** `s` as an urgent workload's subject (D5): start level 2, and the text says `urgent (from …)` so a wrong inference is visible. */
export function withUrgency(s: AlertSubject, u: Urgency): AlertSubject {
	return u.urgent ? { ...s, startLevel: 2, text: `${s.text}\nurgent (from ${u.from})` } : s;
}

// ---- the incident issue of a land-first stop (D2.4) ---------------------------------------------

/**
 * The jo-issues issue a fix PR for repository `repo`'s open stop episode `ep` is named in (r3 #3, r4 #2): `ep.filed` for a
 * legacy episode; else the url of the `main:<repo>` alert episode open while the stop is open (raised before or after
 * `ep.raised`, neither acked nor closed before it), the newest such with an issue. An episode that ended before the stop
 * was raised is never bound. `entries` are the standing workload's.
 */
export function stopIssueUrl(entries: readonly EntryRow[], repo: string, ep: StopEpisode): string | null {
	if (ep.filed !== null) return ep.filed;
	const since = ep.raised.createdAt;
	const key = `main:${repo}`.toLowerCase();
	let url: string | null = null;
	for (const [k, rec] of alertRecords(controlEntries(entries))) {
		if (k.toLowerCase() !== key) continue;
		for (const e of rec.episodes) {
			const ended = [e.acked?.at, e.closed?.at].some((t) => t !== undefined && t < since);
			if (!ended && e.url !== null) url = e.url;
		}
	}
	return url;
}

// ---- legacy alerts (D3 adoption) ----------------------------------------------------------------

/** The retired train ladder's marker (merge-train.ts part 3): level 1 in the issue body, levels 2 and 3 in comments. */
export function legacyTrainAlertMarker(q: string, level: number): string {
	return `<!-- train-alert ${q} level ${level} -->`;
}
/** The retired land-first stop issue's marker (train-tick landingPass): the repository and the `stop-raised` entry id. */
export function legacyLandFirstMarker(repo: string, raisedEntryId: string): string {
	return `<!-- train-notice land-first ${repo} ${raisedEntryId} -->`;
}
/** The retired main-red issue's marker (train-tick mainRedPass): the notice's source issue url (MainRedNotice.url), not the run. */
export function legacyMainRedMarker(sourceUrl: string): string {
	return `<!-- train-notice main-red ${sourceUrl} -->`;
}

/** A legacy alert's marker found in an issue body or comment. The quota-move ones are quota-move-alert.ts's `issueMarker` / `commentMarker`. */
export type LegacyMarker =
	| { kind: "train-alert"; q: string; level: number }
	| { kind: "quota-move"; eventId: string }
	| { kind: "quota-move-comment"; eventId: string }
	| { kind: "land-first"; repo: string; raised: string }
	| { kind: "main-red"; url: string };

const LEGACY_MARKER_RE =
	/<!-- (?:train-alert (q-[a-z0-9]+) level ([1-9])|as2-quota-move (en-[a-z0-9]+)|as2-quota-move-comment (en-[a-z0-9]+)|train-notice land-first (\S+) (en-[a-z0-9]+)|train-notice main-red (\S+)) -->/g;

/** Every legacy alert marker in `text` (an issue body or a comment), in order. A protection or promote-schema notice is none of them. */
export function legacyMarkers(text: string): LegacyMarker[] {
	const out: LegacyMarker[] = [];
	for (const m of text.matchAll(LEGACY_MARKER_RE)) {
		if (m[1] !== undefined) out.push({ kind: "train-alert", q: m[1], level: Number(m[2]) });
		else if (m[3] !== undefined) out.push({ kind: "quota-move", eventId: m[3] });
		else if (m[4] !== undefined) out.push({ kind: "quota-move-comment", eventId: m[4] });
		else if (m[5] !== undefined) out.push({ kind: "land-first", repo: m[5], raised: m[6]! });
		else out.push({ kind: "main-red", url: m[7]! });
	}
	return out;
}

/** What the retired train ladder's `train-alert:` rows hold about one question's alert: per level, `sending` and `sent`; the issue; its end. */
export interface LegacyTrainAlert {
	q: string;
	sending: Map<number, string>;
	sent: Map<number, string>;
	/** The issue level 1 created or found. */
	url: string | null;
	end: "acked" | "closed" | null;
}

const LEGACY_TRAIN_RE = /^(q-[a-z0-9]+) (?:level ([1-9]) (sending|notified|sent)(?: (\S+))?|(acked|closed)(?: [\s\S]*)?)$/;

/** Every legacy train alert among a train's control entries (`train-alert:`, valid only from MERGE_TRAIN_BY), by question id. */
export function legacyTrainAlerts(control: readonly ControlEntry[]): Map<string, LegacyTrainAlert> {
	const out = new Map<string, LegacyTrainAlert>();
	for (const c of control) {
		const m = c.prefix === "train-alert" ? LEGACY_TRAIN_RE.exec(c.rest) : null;
		if (!m) continue;
		const r = out.get(m[1]!) ?? { q: m[1]!, sending: new Map(), sent: new Map(), url: null, end: null };
		out.set(r.q, r);
		if (m[5] !== undefined) {
			r.end ??= m[5] as "acked" | "closed";
			continue;
		}
		const level = Number(m[2]);
		if (m[3] === "sending") {
			if (!r.sending.has(level)) r.sending.set(level, c.createdAt);
		} else if (m[3] === "sent" && !r.sent.has(level)) {
			r.sent.set(level, c.createdAt);
			if (level === 1 && m[4]) r.url = m[4];
		}
	}
	return out;
}

/**
 * The level a legacy train alert is adopted at (D3): the highest level whose `sent` is recorded, or whose old marker is on
 * the issue found for it (level 1's in its body, 2 and 3 in its comments: a send posted before a crash counts as sent).
 * 0 when nothing was sent and no issue was found, so the new path files it fresh.
 */
export function legacyTrainLevel(a: LegacyTrainAlert | undefined, q: string, issue: { body: string; comments: readonly string[] } | null): number {
	let level = a === undefined ? 0 : Math.max(0, ...a.sent.keys());
	if (issue === null) return level;
	for (const text of [issue.body, ...issue.comments]) {
		for (const m of legacyMarkers(text)) if (m.kind === "train-alert" && m.q === q) level = Math.max(level, m.level);
	}
	return level;
}
