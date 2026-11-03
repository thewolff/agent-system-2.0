// The alert path's popup (PLAN wl-mw0vs9uc3xqtka D3 "Popup worker", "Legacy popups at cutover"; R12, R24).
//
// `bun surface/scripts/alert-popup.ts <key> <episode> <level>` is the detached worker the alert pass
// (surface/scripts/alert-tick.ts) spawns after a ladder level with a popup was sent. The pass gives it the environment
// variable AS2_ALERT_POPUP=<episode>:<level>:<attempt>, and every process the worker starts inherits it: the zsh of
// install/drive-backup/quiet-alarm.zsh, its osascript, and after "Read it to me" its afplay and say, wherever they are
// reparented. The worker claims the attempt in one ledger write (`alert-popup: <key> <episode> <level> claim pid=<p> pgid=<g>
// lstart=<s> attempt=<n> until=<iso>`), refused when the level already has an unsettled claim, an `ok`, or
// ALERT_POPUP_ATTEMPTS ended attempts; then writes `showing`, shows the silent stay-up popup through surface/src/notify.ts
// `alarmPopup` (the doctor's helper: no sound unless Jo picks "Read it to me", the 10/28 alarm rule), and writes `ok <button>`
// or `failed <why>`. A `failed` only reports: the attempt stays the pass's to settle until no member of it is left, and the
// pass ends it with `settled` (review r1 #1).
//
// The pure half the pass uses is here too, so the identity rule lives in one file:
// - `parsePs`: one `ps -A [-E] -ww -o pid=,ppid=,pgid=,lstart=,command=` read, a process per line.
// - `popupAttempts` / `settleAttempt`: each attempt's rows, and what the pass owes an unsettled one now. A process belongs to
//   an attempt only by its own identity: the worker by the pid and lstart pair its claim recorded, any other process by
//   carrying this attempt's exact AS2_ALERT_POPUP tag in its launch environment (`ps -E`). No bare pid or pgid ever selects
//   a process, and a signal goes only to a recorded member whose pid and lstart still match. A member still matching
//   POPUP_KILL_GRACE_MS after its SIGKILL is the key's error, and the attempt stays unsettled (R24).
// - `legacyHelperSet` / `settleLegacy`: a quota-move popup of the retired move alert, still on screen at cutover, found by
//   its owner's argv (`lane.ts move-alert <wl> <E>`), its dialog's argv (the legacy POPUP_SCRIPT and this move's title and
//   text), its voice's argv (`say <text>`), and, while the owner is identified in the same read, its process group and
//   children; the set is found again on every pass and a helper first seen late joins it (review r1 #2); settled, once
//   the whole set is gone, before the key is adopted.
import { ALERT_POPUP_ATTEMPTS, type AlertEpisode, alertPopupRows, type AlertPopupRow, alertRecords, openEpisode } from "../src/alert-path";
import { ALERT_BY, alertBody, alertPopupBody, controlEntries } from "../src/launch";
import { type AlarmOutcome, alarmPopup, DOCTOR_GIVE_UP_SECS } from "../src/notify";
import { psAnswer, type PsRun, runPs } from "../src/omp-probe";
import { POPUP_SCRIPT, type QuotaMove, moveText, moveTitle } from "../src/quota-move-alert";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";

/** The environment variable that tags every process of one popup attempt: `<episode>:<level>:<attempt>`. */
export const POPUP_TAG_ENV = "AS2_ALERT_POPUP";
/** A claim's life: quiet-alarm gives up after 12 h; 10 minutes more for the worker to write its result. */
export const POPUP_UNTIL_MS = DOCTOR_GIVE_UP_SECS * 1000 + 10 * 60_000;
/** A `spawning` attempt with no claim this long after it is `unstarted`. */
export const POPUP_CLAIM_MS = 60_000;
/** A member still matching this long after its SIGTERM gets SIGKILL. */
export const POPUP_KILL_AFTER_MS = 30_000;
/** A member (the alert path's or a legacy one) still matching this long after its SIGKILL is the key's error (D3; R24). */
export const POPUP_KILL_GRACE_MS = 5 * 60_000;
/** The worker script, for the pass's spawn. */
export const ALERT_POPUP_SCRIPT = join(import.meta.dir, "alert-popup.ts");

/** The one ps read the pass makes per pass: with `-E` for the alert path's own popups, without it for the legacy helper set (r9 #1). */
export const PS_FIELDS = ["-ww", "-o", "pid=,ppid=,pgid=,lstart=,command="] as const;
export const psArgs = (withEnv: boolean): string[] => ["-A", ...(withEnv ? ["-E"] : []), ...PS_FIELDS];

// ---- ps -----------------------------------------------------------------------------------------

/** One process as ps listed it; `lstart` with its spacing collapsed, `command` its argv (and, under -E, its launch environment) as one line. */
export interface Proc {
	pid: number;
	ppid: number;
	pgid: number;
	lstart: string;
	command: string;
}

/** A process's identity as rows record it: pid and lstart. */
export interface Member {
	pid: number;
	lstart: string;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** `ps -A [-E] -ww -o pid=,ppid=,pgid=,lstart=,command=`'s stdout, one Proc per line. Throws naming a line that is not that shape. */
export function parsePs(out: string): Proc[] {
	const procs: Proc[] = [];
	for (const line of out.split("\n")) {
		if (line.trim() === "") continue;
		const m = PS_LINE.exec(line);
		if (!m) throw new Error(`ps output line is not pid ppid pgid lstart command: ${JSON.stringify(line.slice(0, 200))}`);
		procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), lstart: m[4]!.replace(/\s+/g, " "), command: m[5]! });
	}
	return procs;
}

/** A member as a row token: `<pid>:<lstart with _ for spaces>`. */
export const memberToken = (m: Member): string => `${m.pid}:${m.lstart.replace(/ /g, "_")}`;
/** `members=<tok>,<tok>` parsed back. */
export function parseMembers(field: string): Member[] {
	return field === "" ? [] : field.split(",").map((t) => {
		const at = t.indexOf(":");
		const pid = Number(t.slice(0, at));
		if (at <= 0 || !Number.isInteger(pid) || pid <= 0) throw new Error(`member token ${JSON.stringify(t)} is not <pid>:<lstart>`);
		return { pid, lstart: t.slice(at + 1).replace(/_/g, " ") };
	});
}
const membersField = (ms: readonly Member[]): string => `members=${ms.map(memberToken).join(",")}`;
const sameProc = (p: Member, m: Member): boolean => p.pid === m.pid && p.lstart === m.lstart;
/** The procs in `procs` that are still the recorded `members` (pid and lstart both match). */
export const stillMatching = (procs: readonly Proc[], members: readonly Member[]): Proc[] => procs.filter((p) => members.some((m) => sameProc(p, m)));

/** Whether `p`'s launch environment (as `ps -E` prints it after the argv) carries exactly `<POPUP_TAG_ENV>=<tag>`. */
export function carriesTag(p: Proc, tag: string): boolean {
	return p.command.split(/\s+/).includes(`${POPUP_TAG_ENV}=${tag}`);
}

/** Read one `key=value` field of a row's detail. */
function kv(detail: string, key: string): string | null {
	const m = new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(detail);
	return m ? m[1]! : null;
}

// ---- the alert path's own attempts --------------------------------------------------------------

/** A worker's claim, as its `claim` row records it. */
export interface PopupClaim {
	pid: number;
	pgid: number;
	lstart: string;
	attempt: number;
	until: string;
	at: string;
}

/** One popup attempt of a (key, episode, level): from its `spawning` row to its end. */
export interface PopupAttempt {
	key: string;
	episode: string;
	level: number;
	attempt: number;
	spawningAt: string;
	claim: PopupClaim | null;
	showing: boolean;
	/** Each `terminating` row: why, the members it signalled, and when. */
	terminating: { why: string; members: Member[]; sent: string }[];
	/** The worker's own `failed` report: the attempt stays unsettled until the pass finds no member left. */
	failed: { detail: string; at: string } | null;
	/** `ok`, `unstarted` or `settled` (and `failed` for a legacy answer's attempt 0); null while the attempt is unsettled. */
	end: { step: "ok" | "failed" | "unstarted" | "settled"; detail: string; at: string } | null;
}

export const popupTag = (a: Pick<PopupAttempt, "episode" | "level" | "attempt">): string => `${a.episode}:${a.level}:${a.attempt}`;
export const groupKey = (key: string, episode: string, level: number): string => `${key} ${episode} ${level}`;

/**
 * Every attempt among the `alert-popup:` rows, by `groupKey`, oldest first. `spawning attempt=<n>` opens attempt n; a claim
 * joins the attempt its `attempt=` names; `showing`, `ok`, `failed`, `terminating`, `unstarted` and `settled` join the newest
 * attempt of their (key, episode, level), since the pass starts one attempt at a time. A `failed` is the worker's report and
 * ends nothing. An `ok` or `failed` with no attempt to join (the answer of a legacy popup, recorded at adoption) is an ended
 * attempt 0 of its own; any other such row is ignored.
 */
export function popupAttempts(rows: readonly AlertPopupRow[]): Map<string, PopupAttempt[]> {
	const out = new Map<string, PopupAttempt[]>();
	for (const r of rows) {
		const g = groupKey(r.key, r.episode, r.level);
		const list = out.get(g) ?? [];
		out.set(g, list);
		if (r.step === "spawning") {
			const n = Number(kv(r.detail, "attempt"));
			if (Number.isInteger(n) && n > 0) list.push({ key: r.key, episode: r.episode, level: r.level, attempt: n, spawningAt: r.at, claim: null, showing: false, terminating: [], failed: null, end: null });
			continue;
		}
		if (r.step === "claim") {
			const n = Number(kv(r.detail, "attempt"));
			const a = list.find((x) => x.attempt === n);
			const pid = Number(kv(r.detail, "pid"));
			const pgid = Number(kv(r.detail, "pgid"));
			const lstart = kv(r.detail, "lstart");
			const until = kv(r.detail, "until");
			if (a && a.claim === null && pid > 0 && pgid > 0 && lstart && until) a.claim = { pid, pgid, lstart: lstart.replace(/_/g, " "), attempt: n, until, at: r.at };
			continue;
		}
		const a = list.at(-1);
		if ((a === undefined || a.end !== null) && (r.step === "ok" || r.step === "failed")) {
			list.push({ key: r.key, episode: r.episode, level: r.level, attempt: 0, spawningAt: r.at, claim: null, showing: false, terminating: [], failed: null, end: { step: r.step, detail: r.detail, at: r.at } });
			continue;
		}
		if (a === undefined || a.end !== null) continue;
		if (r.step === "showing") a.showing = true;
		else if (r.step === "failed") a.failed ??= { detail: r.detail, at: r.at };
		else if (r.step === "terminating") {
			const m = /^(.*?) members=(\S*) sent=(\S+)$/.exec(r.detail);
			if (m) a.terminating.push({ why: m[1]!, members: parseMembers(m[2]!), sent: m[3]! });
		} else a.end = { step: r.step as "ok" | "unstarted" | "settled", detail: r.detail, at: r.at };
	}
	return out;
}

/** What a (key, episode, level)'s attempts come to: answered, how many ended without an answer, and the unsettled one. */
export function popupStatus(attempts: readonly PopupAttempt[] | undefined): { ok: boolean; failures: number; unsettled: PopupAttempt | null } {
	const list = attempts ?? [];
	return {
		ok: list.some((a) => a.end?.step === "ok"),
		failures: list.filter((a) => a.end !== null && a.end.step !== "ok").length,
		unsettled: list.find((a) => a.end === null) ?? null,
	};
}

/** What the pass does now for one unsettled attempt. */
export type SettleStep =
	| { do: "terminate"; why: string; members: Proc[] }
	| { do: "kill"; members: Proc[] }
	| { do: "stuck"; detail: string }
	| { do: "end"; step: "unstarted" | "settled"; detail: string };

/**
 * D3's settlement for one unsettled attempt over one `ps -E` read (`procs`) at `now`. `cancel` is why its episode no longer
 * wants it (`acked …`, `closed …`, `superseded by level 3`), else null. Members: the worker (the claim's pid and lstart
 * pair) and every process carrying the attempt's tag. Returns the steps in order; none while the attempt runs as it should.
 * A worker's `failed` report settles nothing by itself: its members are signalled first, and `settled` comes only once none
 * is left (review r1 #1). Members still matching POPUP_KILL_GRACE_MS after their SIGKILL are `stuck`: the key's error (R24).
 */
export function settleAttempt(a: PopupAttempt, procs: readonly Proc[], now: string, cancel: string | null): SettleStep[] {
	const t = Date.parse(now);
	const tag = popupTag(a);
	const tagged = procs.filter((p) => carriesTag(p, tag));
	const worker = a.claim === null ? [] : procs.filter((p) => p.pid === a.claim!.pid && p.lstart === a.claim!.lstart);
	const members = [...new Map([...worker, ...tagged].map((p) => [`${p.pid} ${p.lstart}`, p])).values()];
	const reported = a.failed === null ? null : `worker failed: ${a.failed.detail}`;
	if (a.terminating.length > 0) {
		const recorded = a.terminating.flatMap((x) => x.members);
		const matching = stillMatching(procs, recorded);
		const fresh = members.filter((p) => !recorded.some((m) => sameProc(p, m)));
		const sentTo = (p: Proc) => Math.min(...a.terminating.filter((x) => x.members.some((m) => sameProc(p, m))).map((x) => Date.parse(x.sent)));
		const steps: SettleStep[] = [];
		if (fresh.length > 0) steps.push({ do: "terminate", why: a.terminating[0]!.why, members: fresh });
		const due = matching.filter((p) => t - sentTo(p) >= POPUP_KILL_AFTER_MS);
		if (due.length > 0) steps.push({ do: "kill", members: due });
		const stuck = matching.filter((p) => t - sentTo(p) >= POPUP_KILL_AFTER_MS + POPUP_KILL_GRACE_MS);
		if (stuck.length > 0) {
			steps.push({ do: "stuck", detail: `popup attempt ${a.attempt} members still alive ${POPUP_KILL_GRACE_MS / 60_000} minutes after SIGKILL: ${stuck.map(memberToken).join(", ")}; no replacement starts until they are gone` });
		}
		if (matching.length === 0 && fresh.length === 0) steps.push({ do: "end", step: "settled", detail: reported ?? a.terminating[0]!.why });
		return steps;
	}
	if (a.claim === null) {
		if (reported !== null) return tagged.length > 0 ? [{ do: "terminate", why: reported, members: tagged }] : [{ do: "end", step: "settled", detail: reported }];
		if (t - Date.parse(a.spawningAt) < POPUP_CLAIM_MS && cancel === null) return [];
		const why = cancel === null ? `no claim ${POPUP_CLAIM_MS / 1000} s after spawning` : `cancelled ${cancel} before its claim`;
		return tagged.length > 0 ? [{ do: "terminate", why: `unstarted: ${why}`, members: tagged }] : [{ do: "end", step: "unstarted", detail: why }];
	}
	if (members.length === 0) return [{ do: "end", step: "settled", detail: reported ?? "worker ended without a result" }];
	const why = t >= Date.parse(a.claim.until) ? "expired" : cancel !== null ? `cancelled ${cancel}` : reported ?? (worker.length === 0 ? "worker ended after showing" : null);
	return why === null ? [] : [{ do: "terminate", why, members }];
}

/** The detail of a `terminating` row: why, the members signalled, and when. */
export const terminatingDetail = (why: string, members: readonly Member[], sent: string): string => `${why} ${membersField(members)} sent=${sent}`;

// ---- legacy quota-move popups (cutover) ---------------------------------------------------------

/** The retired move alert's unsettled popup claim: the owner pid it recorded (`claim pid=<p> attempt=<n>`). */
export interface LegacyClaim {
	pid: number;
	attempt: number;
}

/** The helper set of a legacy claim over one `ps -A -ww` read (D3 "Legacy popups at cutover", r9 #1). */
export interface LegacyHelpers {
	members: Proc[];
	/** The claim's pid is alive but its command is not this move's worker: a reused pid, never touched. */
	reused: boolean;
}

const argv0 = (command: string): string => command.split(/\s+/, 1)[0]!.split("/").at(-1)!;
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every process this legacy claim's popup still has, by identity alone: the owner (pid `claim.pid` whose command ends
 * `lane.ts move-alert <wl> <E>`), the dialog (an osascript carrying every legacy POPUP_SCRIPT line and ending with this
 * move's title and text), the voice (`say <moveText>`), and, only while the owner is identified in this read, the other
 * members of its process group and their descendants. The orphaned `afplay /System/Library/Sounds/Glass.aiff` carries
 * nothing of the move and is never in the set.
 */
export function legacyHelperSet(procs: readonly Proc[], claim: LegacyClaim, move: QuotaMove): LegacyHelpers {
	const ownerRe = new RegExp(`(?:^|[\\s/])lane\\.ts move-alert ${escRe(move.workloadId)} ${escRe(move.eventId)}$`);
	const owner = procs.find((p) => p.pid === claim.pid && ownerRe.test(p.command.trim())) ?? null;
	const title = moveTitle(move);
	const text = moveText(move);
	const dialog = procs.filter((p) => argv0(p.command) === "osascript" && POPUP_SCRIPT.every((l) => p.command.includes(l)) && p.command.trimEnd().endsWith(` ${title} ${text}`));
	const voice = procs.filter((p) => argv0(p.command) === "say" && p.command.slice(p.command.indexOf(" ") + 1).trimEnd() === text);
	const set = new Map<number, Proc>();
	for (const p of [...(owner ? [owner] : []), ...dialog, ...voice]) set.set(p.pid, p);
	if (owner !== null) {
		for (const p of procs) if (p.pgid === owner.pid) set.set(p.pid, p);
		for (let grew = true; grew;) {
			grew = false;
			for (const p of procs) {
				if (!set.has(p.pid) && set.has(p.ppid)) {
					set.set(p.pid, p);
					grew = true;
				}
			}
		}
	}
	return { members: [...set.values()], reused: owner === null && procs.some((p) => p.pid === claim.pid) };
}

/**
 * The `legacy-popup` rows of one key, read back: every `terminating`, `killed` (SIGKILL delivered, or the member already
 * gone) and `kill-failed` (SIGKILL threw; review r2 N5) row, oldest first, and the settlement.
 */
export interface LegacyPopupRecord {
	terminating: { members: Member[]; sent: string }[];
	killed: { members: Member[]; at: string }[];
	killFailed: { members: Member[]; at: string; error: string }[];
	settled: string | null;
}

/** The key's `alert: <key> legacy-popup …` texts, oldest first, read back. */
export function legacyPopupRecord(texts: readonly string[]): LegacyPopupRecord {
	const r: LegacyPopupRecord = { terminating: [], killed: [], killFailed: [], settled: null };
	for (const t of texts) {
		let m: RegExpExecArray | null;
		if ((m = /^terminating members=(\S*) sent=(\S+)$/.exec(t))) r.terminating.push({ members: parseMembers(m[1]!), sent: m[2]! });
		else if ((m = /^killed members=(\S*) at=(\S+)$/.exec(t))) r.killed.push({ members: parseMembers(m[1]!), at: m[2]! });
		else if ((m = /^kill-failed members=(\S*) at=(\S+) error=(.*)$/.exec(t))) r.killFailed.push({ members: parseMembers(m[1]!), at: m[2]!, error: m[3]! });
		else if ((m = /^settled (.+)$/.exec(t))) r.settled ??= m[1]!;
	}
	return r;
}

/** SIGKILL attempts per legacy member: after this many failed deliveries it is not tried again, and is the key's error. */
export const LEGACY_KILL_ATTEMPTS = 3;

/** The row of members whose SIGKILL was delivered (or who were already gone) at `at`. */
export const legacyKilledText = (members: readonly Member[], at: string): string => `killed ${membersField(members)} at=${at}`;
/** The row of one member whose SIGKILL threw at `at`, with the error. */
export const legacyKillFailedText = (member: Member, at: string, error: string): string => `kill-failed ${membersField([member])} at=${at} error=${error.replace(/\s+/g, " ").trim()}`;

/**
 * What the pass does now for a legacy claim not yet settled. `terminate` and `settle` carry their row; `kill` carries none:
 * the pass writes `killed` for the members the signal reached and `kill-failed` for each it did not (review r2 N5).
 */
export type LegacyStep =
	| { do: "terminate"; members: Proc[]; text: string }
	| { do: "kill"; members: Proc[] }
	| { do: "settle"; text: string }
	| { do: "error"; text: string };

/**
 * D3's legacy settlement over one `ps -A -ww` read (`procs`) at `now`, in order. The helper set is found again on every
 * pass (`legacyHelperSet`); before any `terminating` row an empty set is `settled …`, and a helper not yet recorded is
 * signalled (`terminating …`) whenever it is first seen, so a voice that starts after the first SIGTERM joins the set
 * (review r1 #2). A recorded member still matching 30 s after its own SIGTERM gets SIGKILL; a SIGKILL that failed is tried
 * again on the next pass, LEGACY_KILL_ATTEMPTS times in all, and then is the key's error (review r2 N5). One still matching
 * 5 minutes after a delivered SIGKILL is the key's error too, the key held back until it goes. `settled cancelled at
 * cutover` only once no recorded member matches and the set has nothing new. Empty while it waits, and once settled.
 */
export function settleLegacy(rec: LegacyPopupRecord, procs: readonly Proc[], claim: LegacyClaim, move: QuotaMove, now: string): LegacyStep[] {
	if (rec.settled !== null) return [];
	const t = Date.parse(now);
	const h = legacyHelperSet(procs, claim, move);
	if (rec.terminating.length === 0) {
		if (h.members.length === 0) return [{ do: "settle", text: `settled ${h.reused ? "claim pid reused" : "worker ended without a result"}` }];
		return [{ do: "terminate", members: h.members, text: `terminating ${membersField(h.members)} sent=${now}` }];
	}
	const recorded = rec.terminating.flatMap((x) => x.members);
	const matching = stillMatching(procs, recorded);
	const fresh = h.members.filter((p) => !recorded.some((m) => sameProc(p, m)));
	if (matching.length === 0 && fresh.length === 0) return [{ do: "settle", text: "settled cancelled at cutover" }];
	const steps: LegacyStep[] = [];
	if (fresh.length > 0) steps.push({ do: "terminate", members: fresh, text: `terminating ${membersField(fresh)} sent=${now}` });
	const termAt = (p: Proc) => Math.min(...rec.terminating.filter((x) => x.members.some((m) => sameProc(p, m))).map((x) => Date.parse(x.sent)));
	const killedAt = (p: Proc) => {
		const at = rec.killed.filter((x) => x.members.some((m) => sameProc(p, m))).map((x) => Date.parse(x.at));
		return at.length === 0 ? null : Math.min(...at);
	};
	const failures = (p: Proc) => rec.killFailed.filter((x) => x.members.some((m) => sameProc(p, m)));
	const unkilled = matching.filter((p) => killedAt(p) === null && t - termAt(p) >= POPUP_KILL_AFTER_MS);
	const due = unkilled.filter((p) => failures(p).length < LEGACY_KILL_ATTEMPTS);
	if (due.length > 0) steps.push({ do: "kill", members: due });
	const exhausted = unkilled.filter((p) => failures(p).length >= LEGACY_KILL_ATTEMPTS);
	if (exhausted.length > 0) {
		const each = exhausted.map((p) => `${memberToken(p)} (last: ${failures(p).at(-1)!.error})`).join(", ");
		steps.push({ do: "error", text: `legacy popup members whose SIGKILL failed ${LEGACY_KILL_ATTEMPTS} times, not tried again: ${each}` });
	}
	const stuck = matching.filter((p) => {
		const k = killedAt(p);
		return k !== null && t - k >= POPUP_KILL_GRACE_MS;
	});
	if (stuck.length > 0) steps.push({ do: "error", text: `legacy popup members still alive ${POPUP_KILL_GRACE_MS / 60_000} minutes after SIGKILL: ${stuck.map(memberToken).join(", ")}` });
	return steps;
}

// ---- the worker ---------------------------------------------------------------------------------

/** The worker's seams: the ledger, its own identity, and the dialog. */
export interface WorkerDeps {
	ledger: Ledger;
	env: Record<string, string | undefined>;
	pid: number;
	/** `ps -p <pid> -o pgid=,lstart=` for this process; throws naming the failure. */
	identity(pid: number): { pgid: number; lstart: string };
	/** The popup: surface/src/notify.ts `alarmPopup` (quiet-alarm.zsh) in production. */
	alarm(title: string, text: string, spoken: string): AlarmOutcome;
	err(line: string): void;
}

/** `ps -p <pid> -o pgid=,lstart=` over `run`. */
export function psIdentity(pid: number, run: PsRun = runPs): { pgid: number; lstart: string } {
	const out = psAnswer(run, pid, "pgid=,lstart=");
	const m = out === null ? null : /^\s*(\d+)\s+(.+)$/.exec(out);
	if (!m) throw new Error(`ps -p ${pid} -o pgid=,lstart= answered ${out === null ? "no such process" : JSON.stringify(out)}`);
	return { pgid: Number(m[1]), lstart: m[2]!.trim().replace(/\s+/g, " ") };
}

/** Why the claim of attempt `n` must be refused now, or null when it may be written. */
function claimRefusal(ep: AlertEpisode | null, attempts: readonly PopupAttempt[] | undefined, n: number): string | null {
	if (ep === null) return "the episode is not open";
	if (ep.acked !== null) return `the episode was acked (${ep.acked.why})`;
	const st = popupStatus(attempts);
	if (st.ok) return "this level's popup was already answered";
	if (st.failures >= ALERT_POPUP_ATTEMPTS) return `this level already ended ${st.failures} attempts`;
	const mine = (attempts ?? []).find((a) => a.attempt === n);
	if (mine === undefined) return `no spawning row for attempt ${n}`;
	if (mine.end !== null) return `attempt ${n} already ended (${mine.end.step})`;
	if (mine.claim !== null) return `attempt ${n} is already claimed by pid ${mine.claim.pid}`;
	const other = (attempts ?? []).find((a) => a.attempt !== n && a.end === null);
	if (other !== undefined) return `attempt ${other.attempt} is still unsettled`;
	return null;
}

/**
 * The worker: claim, show, record. Returns its exit code: 0 after `ok`, 1 after `failed` or a refused claim, 2 on bad
 * arguments (no row; the pass marks the attempt `unstarted` after 60 s).
 */
export function workerRun(argv: string[], d: WorkerDeps): number {
	const [key, episode, levelText] = argv;
	const level = Number(levelText);
	const tag = d.env[POPUP_TAG_ENV] ?? "";
	const tm = /^(\S+):([1-9]):(\d+)$/.exec(tag);
	if (argv.length !== 3 || !key || !episode || !Number.isInteger(level) || !tm || tm[1] !== episode || Number(tm[2]) !== level) {
		d.err(`alert-popup: usage: alert-popup.ts <key> <episode> <level> with ${POPUP_TAG_ENV}=<episode>:<level>:<attempt>; got ${JSON.stringify(argv)} and ${POPUP_TAG_ENV}=${JSON.stringify(tag)}`);
		return 2;
	}
	const attempt = Number(tm[3]);
	const { ledger } = d;
	const row = (step: Parameters<typeof alertPopupBody>[3], detail?: string) =>
		ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertPopupBody(key, episode, level, step, detail) });
	let self: { pgid: number; lstart: string };
	try {
		self = d.identity(d.pid);
	} catch (err) {
		const why = `cannot read its own pid and lstart: ${err instanceof Error ? err.message : String(err)}`;
		row("failed", why);
		d.err(`alert-popup ${key} ${episode} ${level}: ${why}`);
		return 1;
	}
	const claimed = ledger.write((): { refused: string } | { ep: AlertEpisode } => {
		const control = controlEntries(ledger.entries(STANDING_WORKLOAD_ID));
		const ep = openEpisode(alertRecords(control).get(key));
		const own = ep !== null && ep.id === episode ? ep : null;
		const refused = claimRefusal(own, popupAttempts(alertPopupRows(control)).get(groupKey(key, episode, level)), attempt);
		if (refused !== null) {
			row("failed", `claim refused: ${refused}`);
			return { refused };
		}
		const until = new Date(Date.parse(ledger.now()) + POPUP_UNTIL_MS).toISOString();
		row("claim", `pid=${d.pid} pgid=${self.pgid} lstart=${self.lstart.replace(/ /g, "_")} attempt=${attempt} until=${until}`);
		return { ep: own! };
	});
	if ("refused" in claimed) {
		d.err(`alert-popup ${key} ${episode} ${level}: claim refused: ${claimed.refused}`);
		return 1;
	}
	const w = claimed.ep.words;
	const title = `as2: ${w?.title ?? key}`;
	const lines = [w?.line ?? `alert ${key} needs you`, ...(w?.next ? [`Next: ${w.next}`] : []), ...(claimed.ep.url ? [`Issue: ${claimed.ep.url}`] : []), `Close the issue, or say ack ${key}, to stop the re-sends.`];
	row("showing");
	const outcome = d.alarm(title, lines.join("\n"), `${w?.title ?? key}. ${w?.line ?? ""} ${w?.next ?? ""}`.trim());
	if (outcome.state === "answered") {
		row("ok", outcome.detail);
		if (outcome.otherStderr !== "") {
			ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertBody(key, { row: "error", channel: "popup", text: `quiet-alarm reported beside an answered popup: ${outcome.otherStderr}` }) });
			d.err(`alert-popup ${key} ${episode} ${level}: quiet-alarm stderr: ${outcome.otherStderr}`);
			return 1;
		}
		return 0;
	}
	row("failed", outcome.detail);
	d.err(`alert-popup ${key} ${episode} ${level}: ${outcome.detail}`);
	return 1;
}

if (import.meta.main) {
	const env = process.env;
	const ledger = Ledger.open(defaultLedgerPath(env), { backupOnOpen: false });
	let code = 1;
	try {
		code = workerRun(process.argv.slice(2), {
			ledger, env, pid: process.pid, identity: (pid) => psIdentity(pid), err: (l) => process.stderr.write(`${new Date().toISOString()} ${l}\n`),
			alarm: (title, text, spoken) => alarmPopup(title, text, spoken, { repo: join(import.meta.dir, "..", ".."), giveUpSecs: DOCTOR_GIVE_UP_SECS, env, timeoutMs: DOCTOR_GIVE_UP_SECS * 1000 + 5 * 60_000 }),
		});
	} finally {
		ledger.close();
	}
	process.exit(code);
}
