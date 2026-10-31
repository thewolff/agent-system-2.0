// The five things that surface unsolicited (SPEC-2.0.md § B3), the four-hour hold (§ A3) and the
// scheduled rows M11 lists under *needs you*, computed from ledger state. Pure: reads only; the
// writers are named per line, and the delivery that carries a line to a running surface once until
// its state changes is surface/src/delivery.ts.
//
// Sources, one per line:
// 1. reserved action waiting: a `reserved-request` entry (P-11 row 6 writes it; an unbound session's
//    lands on the standing workload) that `reservedStates` finds still waiting: no later `instruction`
//    on its workload whose body is exactly `approve <id>` / `deny <id>` — Jo's word at the surface
//    (surface-input.ts; a clarification that merely mentions the id is not a decision, Codex S1) —
//    no `reserved-withdrawn:` by a holder, its raising lane still holds the workload, and no later
//    request repeats it (MIGRATION.md item 31). A repeat names the earliest call it repeats. One whose
//    action is a NOW_RESERVED rule (gates/src/rows/r06-reserved.ts `nowReserved`, PLAN wl-mvg1vs0rhnu3gg
//    § 1.2, § 1.3) is tagged `NOW (guard): ` or `NOW (irreversible): ` and has state `now`.
// 2. held past § A3: the oldest `held` message per open workload that is addressed to a lane (a
//    message to the orchestrator is consumed by the surface at read, so it is never "held with no
//    live lane"), older than HOLD_HOURS; or an open workload — sliced or not (§ A3: "the workload
//    itself open with no lane and no activity"; the standing workload excepted) — with no holder and
//    no activity for HOLD_HOURS, compared unrounded (Codex S2), unless it is in the intake queue
//    (`queuedOf`, PLAN wl-mvbcjadqgblr7k D8: it waits for a slot by design; its held messages still surface).
// 3. a slice that failed its runtime artifact twice: ARTIFACT_FAILURES_SURFACED `artifact-failed:`
//    messages on one slice since its last `artifact-passed:` (surface/src/signals.ts; writers: the
//    lane's artifact observer in surface/extensions/lane.ts and P-11 row 8 for a refused push).
// 4. a lane died: a `lane-died:` message still `held` (not yet surfaced once), or a lapsed lease no
//    such row records yet (the surface records it before rendering).
// 5. a lane waiting on a human: every open `question`, with its options (a stored `pair` left out, PLAN
//    wl-mvb9mw00ycfjeo D2); and every unresolved
//    `prompt-wait:` (a leaked blocking prompt, § B3 item 5 first trigger). A question is cut at 120
//    characters, except the plan question (`isPlanQuestionIn`, PLAN wl-muq22rnjcfrrpc D8): it shows
//    whole, its body starting on the line beneath the q- id (the plan path directly beneath the line
//    naming the question, PLAN wl-mv61a8dh4aeneo D2) and every body line indented two spaces. A question
//    a valid `now: <q-…> <category>` control entry names (gates/src/rulings.ts `nowMarks`: ESCALATION_BY's
//    alone, so a look-alike by a lane tags nothing; PLAN wl-mvg1vs0rhnu3gg § 1.0) is tagged
//    `NOW (<category>): ` and has state `now`, on the orchestrator's own asks too.
// 6. a lane that ended leaving work idle (MIGRATION.md item 68): an open workload (the standing one
//    excepted) with open slices, no holder, no open question and no waiting reserved request, whose
//    newest lane lifecycle entry is a `lane-exit:` with an intended outcome (`isIntendedOutcome`): the
//    lane ended on purpose — parked, completed, released — and nothing holds the work or asks for a
//    word. No `lane-died:` row exists for it (an intended end writes none), so nothing else says so.
//    Keyed by the exit entry, so it is delivered once per ending, not once per poll. On a user-driven
//    workload it offers the by-hand command (`continue it with as2 lane wl-…`), never a relaunch.
// Pair (PLAN wl-mvb9mw00ycfjeo D4, D5): an open question whose `pair` offer is valid (`openPairOffer`,
// surface/src/input.ts) has its offer line (state `offer`, unnumbered, row id the question's) right
// before its own line. A taken pair (`takenPair`) shows `you took pair on …` with `as2 lane wl-…` on a
// line of its own (state `taken`, row id the question's) where the workload's idle line would be, and
// the idle line is not emitted for it then.
// Test run: the newest held `test-run-failed:` the test runner sent about a workload no lane holds
// under a live lease (MIGRATION.md item 24, PLAN § 2.5), shown once: delivery consumes it, a lane
// taking the workload hides it, a `test-run:` green written after it clears it.
// Security red (PLAN wl-mvg1vs0rhnu3gg § 3.3): every held `security-red:` the test runner sent about a workload, one line
// each in the order written, before the test-run lines. A live lane holder, a train task's routing and a later green hide
// none of them: a failing security test reaches Jo whatever is fixing it. They are read from the messages table, not from
// the open workloads, so closing the workload before delivery drops none (fix round 1, F3). Delivery consumes each.
// Due: an open workload whose brief starts `due:<date> ` with date <= now by instant (Codex S4).
// Scratch (PLAN wl-mv5oikd5jtquww § 1.5, § 1.6): an open workload whose newest valid `scratch-over-cap:` /
// `scratch-under-cap:` control entry (a holder's: the lane extension's turn-end measure, surface/extensions/lane.ts)
// is an over-cap one, and the standing workload whose newest `scratch-disk:` / `scratch-disk-ok:` by the daily sweep
// (surface/scripts/scratch-sweep.ts) is a `scratch-disk:`. Advisory: nothing is refused for size; keyed by the entry,
// so delivered once per crossing, and gone when the clearing entry is written.
// Report (PLAN wl-mvbcjageg7o2yo § 2.6): on the standing workload, the newest valid `daily-report:` entry (writer DAILY_REPORT_BY,
// surface/scripts/daily-report.ts) as one line while it is under REPORT_FRESH_HOURS old, keyed by its entry id, so the next day's
// replaces it; from REPORT_FRESH_HOURS to REPORT_MISSED_DAYS old a `missed` line (a new state, delivered again), only while the job's
// plist is installed (`reportJobInstalled`); past that, or with no entry at all, nothing. Older entries never render.
// Drive backup (PLAN wl-mvwkt821jx4d6e slice 3, R5; kind `report`): on the standing workload, the `drive-backup:` entries (writer
// DRIVE_BACKUP_BY, surface/scripts/drive-backup-notice.ts, called by install/drive-backup/lib.zsh for the nightly job and the 9 AM
// check). The newest `<job> failed` entry with no `check ok` entry after it is one line naming the job, its date, its text and its
// state file; the next `check ok` clears it. A `missed` line while the check job's plist is installed (`driveBackupCheckPlist`)
// and no check entry (ok or failed) is newer than DRIVE_BACKUP_MISSED_HOURS; with no check entry ever, the plist file's mtime
// (install.sh writes it) is the baseline, so a job that never ran shows too. No expiry while the plist is installed; the next
// check entry clears it.
// Train-aware routing (PLAN wl-mv8s8srodefytc rev 17.1 D9 F16): on a workload that owns a train task (surface/src/merge-train.ts
// `trainTaskWindows`), the first lane death inside a task's window (from the `train-task:` to its settle, or still open) and an
// intended exit inside one are not shown: the task counts them (D8) and the train tick relaunches the owner (`trainRouted`). The
// test runner's no-live-lane `test-run-failed:` is not shown only when it is a run of the task's own PR while the task is
// unsettled, or the red run its settle counted (`trainRoutedRun`); any other failure is shown. Jo hears of the PR only through D9's two alerts. An alert question whose send ladder
// the tick has taken to level 2 or 3 (`train-alert:`, surface/scripts/train-tick.ts) shows as a LOUD line, a new state each level.
// Notice (PLAN wl-mvfkv7llkp7nk0 § 2, surface/src/notice.ts): every held orchestrator-bound `notice:` message, one line
// each, in the order written. Not answerable, so never numbered, and routine for batching (surface/src/batch.ts onFire);
// a delivery consumes it, after which it no longer shows. A `notice:` written by a lane that holds or held the workload
// (lane_message refuses the prefix; a lane's message written another way still opens with it) is a lane's own words, not a
// notice: it shows only as that lane's message. While a live by-hand lane holds the workload (paired, PLAN § 4.1), the
// runner's ceiling notices on it are not shown; they stay held.
// Merge trains (PLAN wl-mvbjiettjrfpxc D6, D7, D10): a train workload (`trainMembers`) shows no idle line and no § A3 held line (its
// Jo-facing outputs are its questions and the notices; a train lane's death still shows). Train lines, on the standing workload,
// from the train tick's `train-notice:` rows: an open protection episode (keyed by its `raised` row, so delivered once, showing
// its newest text) and an uncleared red main (keyed by its `raised` row). Land-first (PLAN wl-mvq4edbaf13vnk D8): main red, landing
// stopped, a stale train tick, exhausted main runs, failed revocations and the verifier lines, from the tick's and runner's rows
// on the standing workload alone (`landFirstLines`).
// Answerable lines (a waiting reserved request, an open question with options) carry a
// session-stable number Jo answers with, set by surface/src/numbering.ts, never here. An idle line
// has no one-word answer, so it is never numbered.
// Channel (PLAN wl-mv8vx7wdj5nx1c D2, D5; only while a channel session runs on this ledger handle, surface/src/channel.ts
// `channelInForce`): each live `channel-propose:` of a configured sender is its own line, kind `proposal`, placed directly
// after the answerable line of the target it names and carrying that target's number (numbering.ts's second pass), never
// one of its own; a proposal whose target no longer waits has no target line, so it is not shown. Each recent
// `channel-refused:` is one unnumbered line after the scratch lines (it takes no word).
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type EntryRow, type InFlightWorkload, type Ledger, type MessageRow, TEST_RUNNER_BY, type WorkloadStatusRow } from "../../ledger/src/index";
import { CHANNEL_REFUSED_SHOWN_HOURS, channelInForce, channelProposals, channelRefusals } from "./channel";
import { SCRATCH_ENTRY } from "../../gates/src/scratch";
import { type NowCategory, nowMarks } from "../../gates/src/rulings";
import { nowReserved } from "../../gates/src/rows/r06-reserved";
import { openPairOffer } from "./input";
import { byHandLine, type ControlEntry, type ControlPrefix, controlEntries, doneLine, holdersOf, isIntendedOutcome, isPlanQuestionIn, landFirstOffPending, laneExit, mainRetries, queuedOf, sameRepo } from "./launch";
import {
	landFirstRepos, landFirstRows, type LandFirstRow, latestTrainReconciled, mainRedNotices, protectionEpisodes, RECONCILED_STALE_MS, stopEpisode, type TaskWindow, TRAIN_ALERT_LADDER,
	trainAlertLevel, trainMembers, trainTaskWindows,
} from "./merge-train";
import { attemptBlock, mainResults, mainVerdicts, parseRunnerPreflight } from "./main-state";
import { questionSubject } from "./orchestrator-question";
import { answerable } from "./numbering";
import { pairOfferLine, pairTakenLine, pairTakenQuestion, shownOptions } from "./pair-suggest";
import { artifactFailures, laneDeaths, openPromptWaits, unrecordedLapse } from "./signals";
import { parseSecurityRed, parseTestRunFailed, SECURITY_RED_PREFIX, SECURITY_TEST_PATHS, testRuns } from "./test-run";
import { NOTICE_PREFIX } from "./notice";
import { isPaired, parseCeilingNotice } from "./ceiling";
import { ARTIFACT_FAILURES_SURFACED, DUE_PREFIX, HOLD_HOURS, MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, TEST_RUN_FAILED_PREFIX } from "./types";

/** The daily report's launchd label (install/com.agent-system-2.daily-report.plist). */
export const DAILY_REPORT_LABEL = "com.agent-system-2.daily-report";
/** A report entry younger than this renders as the report line: two 07:00 runs across a DST change are 25 h apart, plus the run. */
export const REPORT_FRESH_HOURS = 30;
/** A report entry older than REPORT_FRESH_HOURS and younger than this renders as the missed line; older, nothing. */
export const REPORT_MISSED_DAYS = 7;

/** Whether the daily report's job is installed: its plist under `<home>/Library/LaunchAgents`. */
export function reportPlistInstalled(home: string = homedir()): boolean {
	return existsSync(join(home, "Library", "LaunchAgents", `${DAILY_REPORT_LABEL}.plist`));
}

/** The Drive backup check job's launchd label (install/com.agent-system-2.drive-backup-check.plist). */
export const DRIVE_BACKUP_CHECK_LABEL = "com.agent-system-2.drive-backup-check";
/** With no check entry newer than this, while the check plist is installed, the missed line shows: a 09:00 job across a DST change and a late wake. */
export const DRIVE_BACKUP_MISSED_HOURS = 30;

/**
 * The Drive backup check job's plist under `<home>/Library/LaunchAgents`: its mtime in ms, or null when it is not installed.
 * The default home is $HOME (Bun's os.homedir() ignores it), so a test process, whose preload points HOME at a temp dir,
 * never reads the developer's own LaunchAgents. A plist that exists but cannot be stat'ed throws: never read as absent.
 */
export function driveBackupCheckPlist(home: string = process.env.HOME || homedir()): { mtimeMs: number } | null {
	const path = join(home, "Library", "LaunchAgents", `${DRIVE_BACKUP_CHECK_LABEL}.plist`);
	const st = statSync(path, { throwIfNoEntry: false });
	return st ? { mtimeMs: st.mtimeMs } : null;
}

/** A `drive-backup:` entry's rest: `<job> <result> <local date> — <text> — <state path>` (the last ` — ` ends the text). */
const DRIVE_BACKUP_REST = /^(nightly|check) (failed|ok) (\d{4}-\d{2}-\d{2}) — (.+) — (\/.*)$/;

export interface DriveBackupEntry {
	id: string;
	createdAt: string;
	job: "nightly" | "check";
	result: "failed" | "ok";
	date: string;
	text: string;
	state: string;
}

/** The valid `drive-backup:` entries (writer DRIVE_BACKUP_BY, parsable body) among `control`, oldest first. */
export function driveBackupEntries(control: readonly ControlEntry[]): DriveBackupEntry[] {
	const out: DriveBackupEntry[] = [];
	for (const c of control) {
		const m = c.prefix === "drive-backup" ? DRIVE_BACKUP_REST.exec(c.rest) : null;
		if (m) out.push({ id: c.id, createdAt: c.createdAt, job: m[1] as "nightly" | "check", result: m[2] as "failed" | "ok", date: m[3]!, text: m[4]!, state: m[5]! });
	}
	return out;
}

/** The Drive backup lines (R5): the open failure, then the missed line. `plist` is read only when no check entry is fresh. */
export function driveBackupLines(control: readonly ControlEntry[], now: string, plist: () => { mtimeMs: number } | null): ErrorLine[] {
	const entries = driveBackupEntries(control);
	const out: ErrorLine[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.job === "check" && e.result === "ok") break;
		if (e.result !== "failed") continue;
		out.push({ kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: e.id, next: `see ${e.state}`, line: `Drive backup ${e.job} failed ${e.date}: ${e.text} — ${e.state}` });
		break;
	}
	const check = entries.findLast((e) => e.job === "check");
	if (check && hoursElapsed(check.createdAt, now) < DRIVE_BACKUP_MISSED_HOURS) return out;
	let installed: { mtimeMs: number } | null;
	try {
		installed = plist();
	} catch (e) {
		// Never read as absent, and never fatal to the render: the other needs-you lines still show.
		const look = `check ~/Library/LaunchAgents/${DRIVE_BACKUP_CHECK_LABEL}.plist`;
		out.push({ kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: DRIVE_BACKUP_CHECK_LABEL, state: "plist-unreadable", next: look, line: `Drive backup check: its plist could not be read to tell whether the job is installed (${e instanceof Error ? e.message : String(e)}); ${look}` });
		return out;
	}
	if (!installed) return out;
	const since = check ? check.createdAt : new Date(installed.mtimeMs).toISOString();
	if (hoursElapsed(since, now) < DRIVE_BACKUP_MISSED_HOURS) return out;
	const reload = `run \`launchctl print gui/$(id -u)/${DRIVE_BACKUP_CHECK_LABEL}\`, then reload it with \`bash install/install.sh --drive-backup\``;
	const what = check ? `the newest check entry is ${check.date} ${check.result} (${hoursBetween(check.createdAt, now)} h ago)` : `no check entry since the job was installed ${since} (${hoursBetween(since, now)} h ago)`;
	out.push({
		kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: DRIVE_BACKUP_CHECK_LABEL, state: `missed ${check ? check.id : since}`, next: reload,
		line: `Drive backup check missed: ${what}; ${reload}`,
	});
	return out;
}

/** Every needs-you line kind; ErrorKind is read from this list, so the issue #334 item 3 test covers each kind there is. */
export const NEEDS_YOU_KINDS = ["reserved", "held", "artifact", "security-red", "test-run", "lane-died", "question", "due", "idle", "scratch", "train", "pair", "notice", "proposal", "channel-refused", "report"] as const;
export type ErrorKind = (typeof NEEDS_YOU_KINDS)[number];

/** A line's `next` when no next step is known: said explicitly rather than left out (issue #334 item 3). */
export const NO_NEXT_STEP = "no next step known";

/**
 * The open one of a pair of scratch control entries (PLAN wl-mv5oikd5jtquww § 1.5, § 1.6): the newest of `control`
 * (valid writers only, `controlEntries`) with prefix `open` or `clear`, when it is an `open` one; null otherwise.
 */
export function openScratchEntry(control: readonly ControlEntry[], open: ControlPrefix, clear: ControlPrefix): ControlEntry | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix === open) return c;
		if (c.prefix === clear) return null;
	}
	return null;
}

export interface ErrorLine {
	kind: ErrorKind;
	workloadId: string;
	/** The row the line is about: entry id, message id, slice id, workload id, question id. */
	rowId: string;
	line: string;
	/**
	 * Issue #334 item 3 (principle 2: every failure names its next step): what Jo, or the system, does next about this line,
	 * or exactly NO_NEXT_STEP when none is known. Every kind sets it (NEEDS_YOU_KINDS, the test in surface/test/next-step.test.ts).
	 * When `line` already says it, `next` is that same text; otherwise needsYouBullet shows it after the line.
	 */
	next: string;
	/** For a question: the options Jo answers with one word. */
	options?: string[];
	/**
	 * What makes this line's state: it is delivered again only when this changes (the artifact
	 * count, the prompt wait's id). Ages and clocks are not state.
	 */
	state?: string;
	/** Held orchestrator-bound messages behind the line; a delivery consumes them (P-7c). */
	messageIds?: string[];
	/** A channel proposal line (kind `proposal`): the row id of the needs-you line it proposes a word for; its `n` is that line's. */
	proposes?: string;
	/** The session-stable number Jo answers with (`#<n>`); set by Numbering (surface/src/numbering.ts), never by errorLines. */
	n?: number;
}

export interface ErrorOptions {
	now?: string;
	holdHours?: number;
	/** Whether the daily report's job is installed (the missed line needs it); default `reportPlistInstalled()`. Called only when an entry is missed. */
	reportJobInstalled?: () => boolean;
	/** The Drive backup check job's plist (the missed line needs it); default `driveBackupCheckPlist()`. Called only when no check entry is fresh. */
	driveBackupCheckPlist?: () => { mtimeMs: number } | null;
}

const short = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The longest workload words a line carries (`wordsOf`). */
const WORDS_MAX = 60;

/** One line of plain text: no backticks, whitespace collapsed, no trailing punctuation. */
export function plain(s: string): string {
	return s.replace(/`/g, "").replace(/\s+/g, " ").trim().replace(/[\s.,;:!?]+$/, "");
}

/** `s` cut to `n` characters at most, `…` marking the cut. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…` : s);

/** A workload's control entries as the plan-question and done readers want them (holders included). */
export function controlOf(ledger: Ledger, workloadId: string, holder: string | null): ControlEntry[] {
	const entries = ledger.entries(workloadId);
	return controlEntries(entries, holdersOf(entries, holder, ledger.holders(workloadId)));
}

/** A workload as Jo reads it in a line: the newest `done:` line, else the brief's first line, else the id; plain and clipped. */
export function wordsOf(ledger: Ledger, workloadId: string, control: readonly ControlEntry[] | null = null): string {
	const w = ledger.workload(workloadId);
	if (!w) return workloadId;
	const done = doneLine(control ?? controlOf(ledger, workloadId, w.holder));
	return clip(plain(done ?? w.brief.split("\n")[0] ?? "") || workloadId, WORDS_MAX);
}

/**
 * D5 (PLAN wl-mvb9mw00ycfjeo): the pair Jo took on a workload, from its assumption entries oldest first, or null. The
 * newest surface-stamped `pair-taken:` (`controlEntries`) names the question; the lane it stopped is the one named by the
 * `lane-stop: <lane> requested mode-flip by jo` written right after it in the same transaction (none when no lane held a
 * live lease: a later `lane-stop:` is never taken for it). Null when a `lane-started:` of any other lane came after it:
 * that lane continues the work (the stopped lane's own late write does not count). The caller checks the mode and the lease.
 */
function takenPair(entries: readonly EntryRow[]): { questionId: string } | null {
	const control = controlEntries(entries);
	const i = control.findLastIndex((c) => c.prefix === "pair-taken");
	const questionId = i < 0 ? null : pairTakenQuestion(control[i]!.rest);
	if (questionId === null) return null;
	const next = entries[entries.findIndex((e) => e.id === control[i]!.id) + 1];
	const stop = next === undefined ? undefined : control.find((c) => c.id === next.id);
	const stopped = stop?.prefix === "lane-stop" && stop.rest === "requested mode-flip by jo" ? stop.laneId : null;
	return control.slice(i + 1).some((c) => c.prefix === "lane-started" && c.laneId !== stopped) ? null : { questionId };
}

/** Hours between two ISO timestamps, unrounded. */
export function hoursElapsed(from: string, to: string): number {
	return (Date.parse(to) - Date.parse(from)) / 3_600_000;
}

/** Hours between two ISO timestamps, one decimal, for display only. */
export function hoursBetween(from: string, to: string): number {
	return Math.round(hoursElapsed(from, to) * 10) / 10;
}

/** Parse `due:<date> <text>`; null when the brief is not a scheduled row. */
export function parseDue(brief: string): { due: string; text: string } | null {
	if (!brief.startsWith(DUE_PREFIX)) return null;
	const rest = brief.slice(DUE_PREFIX.length);
	const m = /^(\S+)\s+(.+)$/s.exec(rest);
	if (!m || Number.isNaN(Date.parse(m[1]!))) return null;
	return { due: m[1]!, text: m[2]!.trim() };
}

/** `approve <id>` / `deny <id>`, the whole instruction; null for anything else (a clarification mentioning the id decides nothing). */
export function reservedDecision(body: string): { verdict: "approve" | "deny"; entryId: string } | null {
	const m = /^\s*(approve|deny)\s+(\S+)\s*$/i.exec(body);
	return m ? { verdict: m[1]!.toLowerCase() as "approve" | "deny", entryId: m[2]! } : null;
}

/** Where a reserved request stands (MIGRATION.md item 31). Only `waiting` shows under needs-you. */
export type ReservedState =
	| { kind: "waiting" }
	/** Jo's `approve <id>` / `deny <id>`: the first such instruction at or after the request. */
	| { kind: "approved" | "denied"; at: string; instructionId: string }
	/** A `reserved-withdrawn: <id>[ <reason>]` entry by a holder of the workload (`lane_withdraw_reserved`). */
	| { kind: "withdrawn"; by: string; at: string; reason: string | null; entryId: string }
	/** The lane that raised it held the workload and no longer does: released, handed off, died, relaunched. */
	| { kind: "lane-stopped"; lane: string }
	/** Otherwise waiting, but a later request on the workload repeats it; `by` is the next repeat. */
	| { kind: "superseded"; by: string };

export interface ReservedRequest {
	id: string;
	body: string;
	created_at: string;
	created_by: string;
	state: ReservedState;
	/** The earliest earlier request this one repeats (same workload, same `sameCall` body), or null. */
	repeats: string | null;
}

/** A request body without row 6's trailing `(P-11 row 6 refused tool call …)`: two calls are the same when these match. */
export function sameCall(body: string): string {
	return body.replace(/\s*\(P-11 row 6 refused tool call [^()]*\)\s*$/, "").trim();
}

/** `reserved-withdrawn: <id>[ <reason>]`, the rest after the prefix; null when it names no id. */
function parseWithdrawn(rest: string): { entryId: string; reason: string | null } | null {
	const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest.trim());
	return m ? { entryId: m[1]!, reason: m[2]?.trim() || null } : null;
}

/** The ledger reads `reservedStates` makes; `Ledger` satisfies it, as does a read-only view over the same file (surface/scripts/invariants.ts). */
export type ReservedLedgerView = Pick<Ledger, "entries" | "instructions" | "workload" | "holders">;

/**
 * Every reserved-request on a workload, oldest first, with its state. Precedence: Jo's decision, then
 * a withdrawal, then the raising lane having stopped holding, then a later repeat. Lane-stopped
 * applies only when `created_by` is one of the workload's holders (`holdersOf`): row 6 stamps the
 * session's lane id, which for a hand is its lane's (the env is inherited) and for an unbound
 * session is a `lane-<pid>` that never held anything, so a standing-workload request stays waiting.
 */
export function reservedStates(ledger: ReservedLedgerView, workloadId: string): ReservedRequest[] {
	const requests = ledger.entries(workloadId, "reserved-request");
	if (requests.length === 0) return [];
	const decisions: { verdict: "approve" | "deny"; entryId: string; at: string; id: string }[] = [];
	for (const i of ledger.instructions(workloadId)) {
		const d = i.kind === "instruction" ? reservedDecision(i.body) : null;
		if (d) decisions.push({ ...d, at: i.created_at, id: i.id });
	}
	const entries = ledger.entries(workloadId);
	const current = ledger.workload(workloadId)?.holder ?? null;
	const holders = holdersOf(entries, current, ledger.holders(workloadId));
	const withdrawals = controlEntries(entries, holders).flatMap((c) => {
		const w = c.prefix === "reserved-withdrawn" ? parseWithdrawn(c.rest) : null;
		return w ? [{ ...w, by: c.createdBy, at: c.createdAt, id: c.id }] : [];
	});
	const calls = requests.map((r) => sameCall(r.body));
	return requests.map((r, n) => {
		const decided = decisions.find((d) => d.entryId === r.id && d.at >= r.created_at);
		const withdrawn = withdrawals.find((w) => w.entryId === r.id && w.at >= r.created_at);
		const next = requests.findIndex((_, k) => k > n && calls[k] === calls[n]);
		const first = calls.findIndex((c) => c === calls[n]);
		let state: ReservedState;
		if (decided) state = { kind: decided.verdict === "approve" ? "approved" : "denied", at: decided.at, instructionId: decided.id };
		else if (withdrawn) state = { kind: "withdrawn", by: withdrawn.by, at: withdrawn.at, reason: withdrawn.reason, entryId: withdrawn.id };
		else if (holders.includes(r.created_by) && r.created_by !== current) state = { kind: "lane-stopped", lane: r.created_by };
		else if (next >= 0) state = { kind: "superseded", by: requests[next]!.id };
		else state = { kind: "waiting" };
		return { id: r.id, body: r.body, created_at: r.created_at, created_by: r.created_by, state, repeats: first < n ? requests[first]!.id : null };
	});
}

/** The reserved-request entries on a workload still waiting on Jo (`reservedStates`). */
export function waitingReserved(ledger: Ledger, workloadId: string): { id: string; body: string; created_at: string }[] {
	return reservedStates(ledger, workloadId).filter((r) => r.state.kind === "waiting").map(({ id, body, created_at }) => ({ id, body, created_at }));
}

/** `lane-stopped (lane lane-x stopped 2026-…)`, `denied 2026-…`, `withdrawn by lane-x 2026-…: why`, `superseded by en-…`: a closed request's state for a refusal. */
function closedStateText(ledger: Ledger, workloadId: string, r: ReservedRequest): string {
	const s = r.state;
	switch (s.kind) {
		case "waiting":
			return "waiting";
		case "approved":
		case "denied":
			return `${s.kind} ${s.at}`;
		case "withdrawn":
			return `withdrawn by ${s.by} ${s.at}${s.reason ? `: ${s.reason}` : ""}`;
		case "lane-stopped": {
			// When the raising lane stopped holding: the first holder change away from it after the request.
			const stop = ledger.holderChanges(workloadId).find((c) => c.from === s.lane && c.at >= r.created_at);
			return `lane-stopped (lane ${s.lane} stopped${stop ? ` ${stop.at}` : ""})`;
		}
		case "superseded":
			return `superseded by ${s.by}`;
	}
}

/**
 * Jo's `approve <id>` / `deny <id>` naming a reserved request that is no longer waiting, looked up by
 * id on any workload, open or closed: `en-… is not waiting: <state>; nothing to deny`, with
 * ` (workload closed <at>)` when its workload closed after the request (alone, as `workload closed
 * <at>`, when the request was otherwise still waiting). Null when `entryId` is no reserved request
 * or it still waits on an open workload. Only the refusal reads closed workloads: what can be
 * answered stays the workloads in view.
 */
export function closedReservedRefusal(ledger: Ledger, entryId: string, verdict: "approve" | "deny"): string | null {
	const e = ledger.entry(entryId);
	if (!e || e.kind !== "reserved-request") return null;
	const r = reservedStates(ledger, e.workload_id).find((x) => x.id === entryId);
	if (!r) return null;
	const w = ledger.workload(e.workload_id);
	const closedAt = w?.status === "closed" && w.closed_at !== null && w.closed_at >= r.created_at ? w.closed_at : null;
	if (r.state.kind === "waiting" && closedAt === null) return null;
	const state = r.state.kind === "waiting" ? `workload closed ${closedAt}`
		: `${closedStateText(ledger, e.workload_id, r)}${closedAt === null ? "" : ` (workload closed ${closedAt})`}`;
	return `${entryId} is not waiting: ${state}; nothing to ${verdict}`;
}

/** ` — same call as <id>, <its state>` for a waiting request that repeats an earlier one; empty otherwise. */
function repeatNote(r: ReservedRequest, all: readonly ReservedRequest[]): string {
	const earlier = r.repeats === null ? null : all.find((x) => x.id === r.repeats);
	if (!earlier) return "";
	const s = earlier.state;
	// UTC HH:MM from the ledger's ISO stamp of the decision or withdrawal.
	const how = s.kind === "approved" || s.kind === "denied" || s.kind === "withdrawn" ? `, ${s.kind} ${new Date(s.at).toISOString().slice(11, 16)}`
		: s.kind === "lane-stopped" ? `, closed (${s.lane} stopped holding)`
		: s.kind === "superseded" ? " (superseded)"
		: "";
	return ` — same call as ${earlier.id}${how}`;
}

/**
 * The `lane-exit:` a workload's lanes ended on, when the newest lifecycle entry about any lane is an
 * exit with an intended outcome; null otherwise. `spend:` and `ctx-index:` land after an exit and say
 * nothing about intent, so they are skipped (as `exitClass` skips them); a `launch:` or
 * `lane-started:` after the exit means a lane is on its way and the work is not idle.
 */
function idleExit(control: readonly ControlEntry[]): { id: string; laneId: string; outcome: string; createdAt: string } | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.laneId === null || c.prefix === "spend" || c.prefix === "ctx-index" || c.prefix === "lane-metrics") continue;
		if (c.prefix !== "lane-exit") return null;
		const exit = laneExit(control, c.laneId);
		return exit && isIntendedOutcome(exit.outcome) ? { id: c.id, laneId: c.laneId, outcome: exit.outcome, createdAt: c.createdAt } : null;
	}
	return null;
}

/**
 * D9 F16's predicate: the train task window of `windows` (one workload's, `trainTaskWindows`) that a generic surface at time `at`
 * falls in, so it is routed into that task instead of needs-you; null when it falls in none and is shown as usual. `before` is
 * the times of the same kind of event already seen on the workload: when one of them falls in the same window, `at` is not the
 * first and is shown (a lane death is routed once per task; a later one in the same window reaches Jo).
 */
export function trainRouted(windows: readonly TaskWindow[], at: string, before: readonly string[] = []): TaskWindow | null {
	const inside = (w: TaskWindow, t: string) => t >= w.from && (w.to === null || t <= w.to);
	const w = windows.find((x) => inside(x, at));
	return w && !before.some((t) => t < at && inside(w, t)) ? w : null;
}

/**
 * D9 F16 for the runner's failure notice: the task window of `windows` that handles a failed run of PR `pr` at time `at`
 * (`runId` the run it reports, null when unknown), or null when the notice is shown. Only a task on that PR handles it: one
 * still unsettled that began by `at` (it counts a red; an error or stale is rerun by the owner the tick relaunches), or a
 * settled one whose settle counted exactly that run. A run of another PR, and a failure the settled task did not count, are shown.
 */
export function trainRoutedRun(windows: readonly TaskWindow[], pr: number, runId: string | null, at: string): TaskWindow | null {
	return windows.find((w) => w.pr === pr && at >= w.from && (w.to === null || (runId !== null && w.counted === runId))) ?? null;
}

/**
 * The § 2.5 line for a workload: its newest held `test-run-failed:` from the test runner that no train task handles
 * (`trainRoutedRun`, D9 F16: the message's run, found by its slice, verdict and sha, names the PR), unless a lane holds the
 * workload under a live lease or a green `test-run:` was written after it. The run dir is the newest `test-run:` entry's on
 * the message's slice. A delivery consumes every held one.
 */
function testRunLine(ledger: Ledger, workload: WorkloadStatusRow, pending: readonly MessageRow[], now: string, windows: readonly TaskWindow[]): ErrorLine | null {
	const wl = workload.id;
	const failed = pending.flatMap((m) => {
		if (m.state !== "held" || m.recipient !== ORCHESTRATOR_RECIPIENT || m.created_by !== TEST_RUNNER_BY || !m.body.startsWith(TEST_RUN_FAILED_PREFIX)) return [];
		const f = parseTestRunFailed(m.body);
		return f && f.workloadId === wl ? [{ m, f }] : [];
	});
	if (failed.length === 0) return null;
	if (workload.holder && (workload.holder_lease_until === null || workload.holder_lease_until >= now)) return null;
	const records = testRuns(ledger.entries(wl, "assumption"));
	const routed = ({ m, f }: (typeof failed)[number]): boolean => {
		const onSlice = records.filter((r) => r.request.slice === f.slice);
		const run = onSlice.flatMap((r) => r.results.filter((x) => x.verdict === f.verdict && x.sha === f.sha && x.createdAt <= m.created_at).map((x) => ({ pr: r.request.pr, x })))
			.sort((a, b) => a.x.createdAt.localeCompare(b.x.createdAt)).at(-1);
		const pr = run?.pr ?? onSlice.at(-1)?.request.pr ?? null;
		return pr !== null && trainRoutedRun(windows, pr, run?.x.runId ?? null, m.created_at) !== null;
	};
	const newest = failed.findLast((x) => !routed(x));
	if (!newest) return null;
	if (records.some((r) => r.results.some((x) => x.verdict === "green" && x.createdAt > newest.m.created_at))) return null;
	// Records run in request order, so the slice's results are put in time order (stable on ties) to find its newest test-run: entry.
	const newestOnSlice = records.filter((r) => r.request.slice === newest.f.slice).flatMap((r) => r.results).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
	const runDir = newestOnSlice?.runDir ?? null;
	const { verdict, sha, failing, first } = newest.f;
	return {
		kind: "test-run", workloadId: wl, rowId: newest.m.id, messageIds: failed.map(({ m }) => m.id), next: "relaunch to fix",
		line: `full suite ${verdict} on ${wl} at ${sha.slice(0, 7)}: ${failing} failing${first ? `, first ${first}` : ""} — relaunch to fix (${runDir ?? "no run dir"})`,
	};
}

/**
 * Land-first's render lines (PLAN wl-mvq4edbaf13vnk D8, R19), from the standing workload's rows alone (no GitHub), per repository
 * land-first is on for (`landFirstRepos`): the open stop episode the tick recorded (`stopEpisode`), as `main red at …` for a
 * regression with its repair state, else `landing stopped at …` with the reasons of the newest `train-reconciled:` and main's run
 * at the tip; `train tick has not reconciled main since …` when the repository's newest `train-reconciled:` is missing or over
 * RECONCILED_STALE_MS old; `main runs exhausted at …` while the exhausted block the tick recorded is still the commit's current
 * one and it has no verdict; `revocation failed on #<n>` until the tick records that head is no longer the PR's open head. And,
 * land-first on or not, the `verifier` lines: the runner's newest preflight refused, the tick's self-check refusing (until a
 * `train-reconciled:` after it), a promotion given up or waiting on Jo for a schema change (until a later `promote-ok`).
 */
function landFirstLines(ledger: Ledger, now: string): ErrorLine[] {
	const wl = STANDING_WORKLOAD_ID;
	const entries = ledger.entries(wl);
	const instructions = ledger.instructions(wl);
	const rows = landFirstRows(entries);
	const results = mainResults(entries);
	const verdicts = mainVerdicts(results);
	const out: ErrorLine[] = [];
	const push = (rowId: string, line: string, next: string, state?: string) => out.push({ kind: "train", workloadId: wl, rowId, line, next, ...(state === undefined ? {} : { state }) });
	const sha7 = (s: string) => s.slice(0, 7);
	const prsOf = (suspects: readonly number[]) => (suspects.length === 0 ? "none named" : suspects.map((n) => `#${n}`).join(", "));
	for (const repo of landFirstRepos(entries, instructions, true)) {
		const pending = landFirstOffPending(entries, instructions, repo);
		if (pending.length > 0) {
			const marker = controlEntries(entries).find((c) => c.prefix === "land-first-off-pending" && pending.includes(c.rest.split(" ")[1]!) && sameRepo(c.rest.split(" ")[0]!, repo))!;
			const order = new Map(entries.map((e, i) => [e.id, i]));
			const since = order.get(marker.id)!;
			const headFailure = rows.findLast((r) => r.event === "revoke-failed" && sameRepo(r.repo, repo) && r.error.startsWith("off reconciliation pending:") && order.get(r.entryId)! > since);
			const passFailure = entries.findLast((e) => {
				const named = /^train-error: off reconciliation pending for (\S+):/.exec(e.body);
				return e.created_by === MERGE_TRAIN_BY && e.kind === "assumption" && named !== null
					&& sameRepo(named[1]!, repo) && order.get(e.id)! > since;
			});
			const latest = passFailure !== undefined && (headFailure === undefined || order.get(passFailure.id)! > order.get(headFailure.entryId)!)
				? { id: passFailure.id, detail: passFailure.body }
				: headFailure?.event === "revoke-failed" ? { id: headFailure.entryId, detail: `#${headFailure.pr} head ${headFailure.head}: ${headFailure.error}` } : null;
			const offNext = "the tick retries remaining fast/tree revocations; check com.agent-system-2.train-tick and its log if no progress";
			push(marker.id, `land-first off requested for ${repo} (instructions ${pending.join(", ")}): reconciliation pending; normal merges held${latest ? `; latest failure ${latest.id}: ${latest.detail}` : ""} — next: ${offNext}`,
				offNext, `off-pending ${pending.join(" ")} failure ${latest?.id ?? "none"}`);
			continue;
		}
		const mine = rows.filter((r) => r.repo === repo);
		const reconciled = latestTrainReconciled(entries, repo);
		const ep = stopEpisode(mine);
		if (ep !== null) {
			const s = ep.state;
			if (s.kind === "regression") {
				const repair = ep.failed !== null
					? `failed: woken ${ep.failed.woken} and not landed in 30 minutes`
					: reconciled?.r.repair
						? `${sha7(reconciled.r.repair)} admitted`
						: ep.woken !== null ? `woken ${ep.woken.createdAt} on ${ep.woken.train ?? "no open train"}` : "not woken yet";
				push(ep.raised.entryId, `main red at ${sha7(s.tip)} since ${ep.raised.createdAt} on ${repo}: ${s.failing ?? "?"} failing; suspects ${prsOf(s.suspects)}; repair ${repair}${ep.filed ? ` — ${ep.filed}` : ""}`, NO_NEXT_STEP, `${s.entryId} ${repair}`);
			} else {
				const reasons = reconciled !== null && !reconciled.r.open && reconciled.r.tip === s.tip ? reconciled.r.reasons : `${s.kind} stop`;
				const run = results.findLast((r) => r.sha === s.tip);
				const phase = run === undefined ? "requested, no result yet" : `${run.runId} ${run.verdict}${run.reason ? ` (${run.reason})` : ""}`;
				push(ep.raised.entryId, `landing stopped at ${sha7(s.tip)} on ${repo}: ${reasons}; suspects ${prsOf(s.suspects)}; main run ${phase}${ep.filed ? ` — ${ep.filed}` : ""}`, NO_NEXT_STEP, `${s.entryId} ${phase}`);
			}
		}
		if (reconciled === null || Date.parse(now) - Date.parse(reconciled.createdAt) > RECONCILED_STALE_MS) {
			const tickNext = "check the tick's job (com.agent-system-2.train-tick) and its log";
			push(reconciled?.entryId ?? `land-first ${repo}`, `train tick has not reconciled main since ${reconciled?.createdAt ?? "land-first went on"} on ${repo} — lane merges are held; ${tickNext}`, tickNext);
		}
		const retries = mainRetries(entries, instructions, repo);
		const exhausted = new Map<string, Extract<LandFirstRow, { event: "exhausted" }>>();
		for (const r of mine) if (r.event === "exhausted") exhausted.set(r.sha, r);
		for (const r of exhausted.values()) {
			const b = attemptBlock(r.sha, results, retries);
			if (!verdicts.has(r.sha) && b.exhausted && b.block === r.block) push(r.entryId, `main runs exhausted at ${sha7(r.sha)}: fix the runner, then say main-retry ${repo}`, `fix the runner, then say main-retry ${repo}`);
		}
		const revocations = new Map<string, Extract<LandFirstRow, { event: "revoke-gave-up" }>>();
		for (const r of mine) {
			if (r.event === "revoke-gave-up") revocations.set(`${r.pr} ${r.head}`, r);
			else if (r.event === "revoke-cleared") revocations.delete(`${r.pr} ${r.head}`);
		}
		for (const r of revocations.values()) {
			push(r.entryId, `revocation failed on #${r.pr} (${repo}, head ${sha7(r.head)}): ${short(r.error, 120)} — that head still shows success; it can be merged by hand on GitHub until its head changes`, NO_NEXT_STEP);
		}
	}
	const preflight = controlEntries(entries).findLast((c) => c.prefix === "runner-preflight");
	const pre = preflight === undefined ? null : parseRunnerPreflight(preflight.body);
	if (preflight !== undefined && pre !== null && !pre.ok) push(preflight.id, `verifier: the runner's preflight refused: ${short(pre.reason ?? "", 160)} (root ${pre.root})`, NO_NEXT_STEP);
	const refused = rows.findLast((r) => r.event === "tick-refused");
	const newestReconciled = controlEntries(entries).findLast((c) => c.prefix === "train-reconciled");
	if (refused?.event === "tick-refused" && (newestReconciled === undefined || newestReconciled.createdAt < refused.createdAt)) {
		const reinstall = "reinstall it from verified/current (install/install.sh --control-root=verified)";
		push(refused.entryId, `verifier: the train tick refuses to run: ${short(refused.reason, 160)} — ${reinstall}`, reinstall);
	}
	const promotions = new Map<string, LandFirstRow>();
	for (const r of rows) {
		if (r.event === "promote-gave-up" || r.event === "promote-schema") promotions.set(r.repo, r);
		else if (r.event === "promote-ok") promotions.delete(r.repo);
	}
	for (const r of promotions.values()) {
		if (r.event === "promote-gave-up") push(r.entryId, `verifier: promotion of ${sha7(r.g)} on ${r.repo} failed 3 times: ${short(r.error, 120)} — the control plane keeps running from the older verified root`, NO_NEXT_STEP);
		else if (r.event === "promote-schema") {
			const recovery = r.g === null
				? "verified target missing from the retained notice — rerun the train tick to reconcile it before migration or promotion"
				: `verified target ${r.g} — stop the tick, migrate the live ledger through ${r.g}, run bun surface/scripts/promote-verified.ts ${r.g}, restart`;
			push(r.entryId, `verifier: promotion waits on Jo: ${sha7(r.sha)} on ${r.repo} changes the ledger schema; ${recovery}${r.issue ? ` (${r.issue})` : ""}`, recovery);
		}
	}
	return out;
}

/**
 * The § 3.3 lines: each held `security-red:` the test runner sent, in the order written, whatever holds its workload, routes its
 * runs, or whether the workload is open or closed (fix round 1, F3). A body naming another workload than its message row is ignored.
 */
function securityRedLines(ledger: Ledger): ErrorLine[] {
	const held = ledger.db.query<MessageRow, [string, string, string]>(
		"SELECT * FROM messages WHERE state = 'held' AND recipient = ?1 AND created_by = ?2 AND instr(body, ?3) = 1 ORDER BY created_at, id",
	).all(ORCHESTRATOR_RECIPIENT, TEST_RUNNER_BY, SECURITY_RED_PREFIX);
	return held.flatMap((m) => {
		const s = parseSecurityRed(m.body);
		if (!s || s.workloadId !== m.workload_id) return [];
		return [{
			kind: "security-red" as const, workloadId: s.workloadId, rowId: m.id, messageIds: [m.id], next: "a lane asks you before it changes such a test",
			line: `security tests red on ${s.workloadId}: run ${s.runId} at ${s.sha.slice(0, 7)} (slice ${s.slice}) has ${s.failing} failing under ${SECURITY_TEST_PATHS.join(", ")}, first ${s.first} — a lane asks you before it changes such a test`,
		}];
	});
}

/** Every line owed right now, in § B3 order (1–3), the security-red lines, the test-run lines, § B3 order (4–5) with the idle lines after the deaths, then the train notices, the due rows, then the scratch lines, the daily report, the notices, then the channel refusals; each channel proposal directly after its target. */
export function errorLines(ledger: Ledger, inFlight: InFlightWorkload[] = ledger.inFlight(), opts: ErrorOptions = {}): ErrorLine[] {
	const now = opts.now ?? ledger.now();
	const holdHours = opts.holdHours ?? HOLD_HOURS;
	const reserved: ErrorLine[] = [];
	const held: ErrorLine[] = [];
	const artifact: ErrorLine[] = [];
	const securityRed = securityRedLines(ledger);
	const testRun: ErrorLine[] = [];
	const died: ErrorLine[] = [];
	const idle: ErrorLine[] = [];
	const questions: ErrorLine[] = [];
	const due: ErrorLine[] = [];
	const scratch: ErrorLine[] = [];
	const report: ErrorLine[] = [];
	const notice: ErrorLine[] = [];
	const train: ErrorLine[] = [];
	const taskWindows = trainTaskWindows(ledger);
	for (const { workload, slices, openQuestions, pendingMessages } of inFlight) {
		const windows = taskWindows.get(workload.id) ?? [];
		const wl = workload.id;
		const label = wl === STANDING_WORKLOAD_ID ? "orchestrator" : wl;
		/** D10: a merge train shows no idle and no held line; read only when such a line is owed. */
		let trainWorkload: boolean | undefined;
		const isTrain = () => (trainWorkload ??= trainMembers(ledger.entries(wl), ledger.instructions(wl)).length > 0);
		const scheduled = parseDue(workload.brief);
		const requests = reservedStates(ledger, wl);
		// Issue #334 item 3: what Jo does about a workload whose lane is gone (held, died, idle). A user-driven one has no relaunch.
		const resume = workload.mode === "user-driven" ? `continue it with ${byHandLine(wl)}, close, or instruct` : "relaunch, close, or instruct";
		for (const r of requests) {
			if (r.state.kind !== "waiting") continue;
			// § 1.2, § 1.3: a guard bypass or an irreversible or shared-state rule (gates/src/rows/r06-reserved.ts NOW_RESERVED) is NOW.
			const hot = nowReserved(r.body);
			reserved.push({
				kind: "reserved", workloadId: wl, rowId: r.id, ...(hot ? { state: "now" } : {}), next: `\`approve ${r.id}\` or \`deny ${r.id}\``,
				line: `${hot ? `NOW (${hot.category}): ` : ""}reserved action waiting on you (${label}): ${short(r.body)}${repeatNote(r, requests)} — \`approve ${r.id}\` or \`deny ${r.id}\``,
			});
		}
		const oldest = pendingMessages.find((m) => m.state === "held" && m.recipient !== ORCHESTRATOR_RECIPIENT);
		if (oldest && hoursElapsed(oldest.created_at, now) >= holdHours) {
			if (!isTrain()) held.push({ kind: "held", workloadId: wl, rowId: oldest.id, next: resume, line: `held ${hoursBetween(oldest.created_at, now)}h on ${label}: message ${oldest.id} (${oldest.sender} → ${oldest.recipient}) has had no live lane since ${oldest.created_at}` });
		} else if (wl !== STANDING_WORKLOAD_ID && !scheduled && !workload.holder && hoursElapsed(workload.last_activity_at, now) >= holdHours && !isTrain()
			// PLAN wl-mvbcjadqgblr7k D8: a queued workload waits for a slot by design; a held message on it still surfaces above.
			&& queuedOf(controlEntries(ledger.entries(wl, "assumption"))) === null) {
			// Fable F2d: an open workload with no slices yet and no lane is held too. The standing workload and a
			// scheduled row (M11 `due:` brief) are not a lane's work: neither ever has a lane, both are excluded.
			held.push({ kind: "held", workloadId: wl, rowId: wl, next: resume, line: `held ${hoursBetween(workload.last_activity_at, now)}h on ${label}: ${workload.open_slices} open slice(s), no lane, no activity since ${workload.last_activity_at}` });
		}
		for (const [sliceId, { n, heldIds }] of artifactFailures(ledger, wl)) {
			if (n < ARTIFACT_FAILURES_SURFACED) continue;
			const slice = slices.find((s) => s.id === sliceId) ?? ledger.slice(sliceId);
			if (!slice || slice.state === "done" || slice.state === "cancelled") continue;
			artifact.push({ kind: "artifact", workloadId: wl, rowId: sliceId, state: String(n), messageIds: heldIds, next: `instruct the lane, or \`cancel-slice ${sliceId}\``, line: `slice ${sliceId} (${label}) failed its runtime artifact ${n} times: ${short(slice.task, 70)}` });
		}
		const run = testRunLine(ledger, workload, pendingMessages, now, windows);
		if (run) testRun.push(run);
		const deaths = laneDeaths(ledger, wl);
		const deathTimes = deaths.map((d) => d.created_at);
		for (const d of deaths) {
			if (d.state !== "held" || trainRouted(windows, d.created_at, deathTimes)) continue;
			died.push({ kind: "lane-died", workloadId: wl, rowId: d.id, messageIds: [d.id], next: resume, line: `lane ${d.holder} on ${label} died: ${d.body.slice(d.body.indexOf(":", 11) + 1).trim()}, ${workload.open_slices} open slice(s)${workload.holder && workload.holder !== d.holder ? `; ${workload.holder} holds it now` : ""}` });
		}
		if (unrecordedLapse(ledger, workload, now) && !trainRouted(windows, workload.holder_lease_until!, deathTimes)) {
			died.push({ kind: "lane-died", workloadId: wl, rowId: wl, state: `${workload.holder}@${workload.holder_lease_until}`, next: resume, line: `lane ${workload.holder} on ${label} died: lease lapsed ${workload.holder_lease_until}, ${workload.open_slices} open slice(s)` });
		}
		// D5: a taken pair, whatever else is open, while the workload is user-driven and no lane holds it under a live lease.
		const laneLive = workload.holder?.startsWith("lane-") === true && (workload.holder_lease_until === null || workload.holder_lease_until >= now);
		const taken = wl !== STANDING_WORKLOAD_ID && workload.mode === "user-driven" && !laneLive ? takenPair(ledger.entries(wl, "assumption")) : null;
		if (taken) idle.push({ kind: "pair", workloadId: wl, rowId: taken.questionId, state: "taken", next: byHandLine(wl), line: pairTakenLine(wordsOf(ledger, wl), taken.questionId, wl) });
		let control: ControlEntry[] = [];
		/** § 1.0: the NOW category of each open question a valid `now:` control entry (ESCALATION_BY's alone) names. */
		let marks = new Map<string, NowCategory>();
		if (openQuestions.length > 0) {
			const entries = ledger.entries(wl);
			control = controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(wl)));
			marks = nowMarks(entries);
		} else if (!taken && wl !== STANDING_WORKLOAD_ID && workload.open_slices > 0 && !workload.holder && !requests.some((r) => r.state.kind === "waiting")) {
			// Item 68: no holder, no question, no reserved request — only an intended lane-exit: as the newest
			// lifecycle entry says the lane ended on purpose and left the work to nobody. A lapsed holder is
			// still the holder and is the lane-died line's; `lane-exit:` needs no holder list to validate.
			// A user-driven workload has no relaunch: the line names the by-hand command (PLAN wl-mvb9mw00ycfjeo D5).
			const ended = idleExit(controlEntries(ledger.entries(wl)));
			if (ended && !trainRouted(windows, ended.createdAt) && !isTrain()) idle.push({ kind: "idle", workloadId: wl, rowId: ended.id, next: resume, line: `lane ${ended.laneId} on ${label} ended (${ended.outcome}) with ${workload.open_slices} open slice(s) and no question; ${resume}` });
		}
		for (const q of openQuestions) {
			const hot = marks.get(q.id);
			const nowTag = hot ? `NOW (${hot}): ` : "";
			if (wl === STANDING_WORKLOAD_ID) {
				// The orchestrator's own ask to Jo (MIGRATION.md item 105), its subject workload from the surface's subject entry.
				const about = questionSubject(ledger, q.id);
				const answer = `answer with one word: ${q.options.join(" / ")} (or \`withdraw\`)`;
				questions.push({ kind: "question", workloadId: wl, rowId: q.id, options: q.options, ...(hot ? { state: "now" } : {}), next: answer, line: `${nowTag}the orchestrator asked you (${q.id}${about ? `, about ${about}` : ""}): ${short(q.body, 120)} — ${answer}` });
				continue;
			}
			// D4: a valid pair offer is its own line, right before its question's; the question lists its options less `pair` (D2).
			const offer = openPairOffer(ledger, q);
			if (offer) questions.push({ kind: "pair", workloadId: wl, rowId: q.id, state: "offer", next: `Answer pair ${q.id}`, line: pairOfferLine(wordsOf(ledger, wl, control), q.id, wl, offer.signals) });
			const body = isPlanQuestionIn(control, q) ? `\n  ${q.body.split("\n").join("\n  ")}` : ` ${short(q.body, 120)}`;
			// D9's re-send: level 2 or 3 of the train tick's ladder makes the line LOUD, each level a new state.
			const loud = trainAlertLevel(control, q.id);
			const step = loud >= 2 ? TRAIN_ALERT_LADDER.find((s) => s.level === loud) : undefined;
			const tag = `${nowTag}${step ? `LOUD${step.labels.includes("critical") ? ", critical" : ""} (unacknowledged ${step.afterMs / 3_600_000} h): ` : ""}`;
			const asker = q.created_by === MERGE_TRAIN_BY ? `merge train ${label} needs you` : `lane on ${label} is waiting on you`;
			// A NOW question is on fire from its first poll (batch.ts onFire), so its state stays `now` whatever the ladder's level.
			const state = hot ? "now" : step ? `loud-${loud}` : null;
			const answer = `answer with one word: ${shownOptions(q.options).join(" / ")} (or \`withdraw\`)`;
			questions.push({
				kind: "question", workloadId: wl, rowId: q.id, options: q.options, ...(state ? { state } : {}), next: answer,
				line: `${tag}${asker} (${q.id}, slice ${q.slice_id}):${body} — ${answer}`,
			});
		}
		for (const w of openPromptWaits(ledger, wl)) {
			questions.push({ kind: "question", workloadId: wl, rowId: w.id, messageIds: [w.id], next: "answer it in that session or end the session", line: `lane ${w.lane} on ${label} is blocked on a human prompt it should never open (${w.toolName}, tool call ${w.toolCallId}, since ${w.created_at}): ${short(w.reason, 100)} — answer it in that session or end the session` });
		}
		if (scheduled && Date.parse(scheduled.due) <= Date.parse(now)) {
			due.push({ kind: "due", workloadId: wl, rowId: wl, next: `close ${wl} with a receipt when done`, line: `scheduled and past due (${scheduled.due}): ${short(scheduled.text, 120)} — close ${wl} with a receipt when done` });
		}
		if (wl === STANDING_WORKLOAD_ID) {
			const control = controlEntries(ledger.entries(wl, "assumption"));
			const disk = openScratchEntry(control, "scratch-disk", "scratch-disk-ok");
			if (disk) scratch.push({ kind: "scratch", workloadId: wl, rowId: disk.id, next: "the daily sweep clears this line once the total is back under", line: `scratch disk: ${disk.rest} — the daily sweep clears this line once the total is back under` });
			const newest = control.findLast((c) => c.prefix === "daily-report" && /^\d{4}-\d{2}-\d{2}\s/.test(c.rest));
			const age = newest ? hoursElapsed(newest.createdAt, now) : Number.POSITIVE_INFINITY;
			if (newest && age < REPORT_FRESH_HOURS) {
				report.push({ kind: "report", workloadId: wl, rowId: newest.id, next: NO_NEXT_STEP, line: `daily self-heal report ${newest.rest}` });
			} else if (newest && age < REPORT_MISSED_DAYS * 24 && (opts.reportJobInstalled ?? reportPlistInstalled)()) {
				report.push({
					kind: "report", workloadId: wl, rowId: newest.id, state: "missed", next: `check ${DAILY_REPORT_LABEL}`,
					line: `daily self-heal report missed: the newest is ${newest.rest.slice(0, 10)} (${hoursBetween(newest.createdAt, now)} h); check ${DAILY_REPORT_LABEL}`,
				});
			}
			report.push(...driveBackupLines(control, now, opts.driveBackupCheckPlist ?? (() => driveBackupCheckPlist())));
			for (const ep of protectionEpisodes(ledger).values()) {
				if (ep.raised) train.push({ kind: "train", workloadId: wl, rowId: ep.raised.id, next: NO_NEXT_STEP, line: `merge train: main's protection on ${ep.repo} is unverified: ${short(ep.text, 160)} — its normal PRs wait (no merge, no question) until it verifies; the line clears itself then` });
			}
			for (const n of mainRedNotices(ledger).values()) {
				if (!n.cleared) train.push({ kind: "train", workloadId: wl, rowId: n.raised.id, next: NO_NEXT_STEP, line: `merge train: main is red: ${n.url} (run ${n.run}) — PRs that add no failure still merge; the line clears when that issue closes` });
			}
			train.push(...landFirstLines(ledger, now));
		} else {
			const entries = ledger.entries(wl, "assumption");
			// The holders are read only when there is an over-cap line to validate.
			const over = entries.some((e) => e.body.startsWith(SCRATCH_ENTRY.overCap))
				? openScratchEntry(controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(wl))), "scratch-over-cap", "scratch-under-cap")
				: null;
			if (over) scratch.push({ kind: "scratch", workloadId: wl, rowId: over.id, next: "advisory: nothing is refused", line: `scratch of ${label} over its cap: ${over.rest} (advisory: nothing is refused; ${over.createdBy} was told)` });
		}
		const notes = pendingMessages.filter((m) => m.state === "held" && m.recipient === ORCHESTRATOR_RECIPIENT && m.body.startsWith(NOTICE_PREFIX));
		// The holders are read only when there is a notice to check.
		const lanes = notes.length > 0 ? ledger.holders(wl) : [];
		// PLAN wl-mvfkv7llkp7nk0 § 4.1 (review r5 minor): while a live by-hand lane holds the workload, Jo is paired and gets the
		// spend in the pane, so a ceiling notice the runner queued before the pairing is not shown. It stays held: it shows
		// again once no by-hand lane holds the workload live.
		const paired = notes.some((m) => parseCeilingNotice(m.body) !== null) && isPaired(workload, controlEntries(ledger.entries(wl, "assumption")), now);
		for (const m of notes) {
			if (lanes.includes(m.created_by) || (paired && parseCeilingNotice(m.body) !== null)) continue;
			const text = m.body.slice(NOTICE_PREFIX.length).trim().split("\n").join("\n  ");
			notice.push({ kind: "notice", workloadId: wl, rowId: m.id, messageIds: [m.id], next: "nothing to answer", line: `notice on ${label} (nothing to answer): ${text}` });
		}
	}
	const all = [...reserved, ...held, ...artifact, ...securityRed, ...testRun, ...died, ...idle, ...questions, ...train, ...due, ...scratch, ...report, ...notice];
	const channel = channelInForce(ledger);
	if (!channel) return all;
	const proposals = channelProposals(ledger, channel);
	const out: ErrorLine[] = [];
	for (const l of all) {
		out.push(l);
		if (!answerable(l)) continue;
		for (const p of proposals) {
			if (p.target !== l.rowId) continue;
			out.push({ kind: "proposal", workloadId: l.workloadId, rowId: p.entryId, proposes: l.rowId, state: p.msgId, next: `${p.word} ${p.target}`, line: `${p.senderId} proposes ${p.word} ${p.target} (${p.msgId})` });
		}
	}
	for (const r of channelRefusals(ledger, now)) {
		// A late collision can refuse a message that had already reached Ilex (code review r1 #3), or whose row the
		// `## from other agents` block may have shown without an aside (r2 #3): "nothing reached the model" only when no row exists.
		const fate = r.reached === "confirmed"
			? `${r.msgId}'s aside had already reached Ilex; it is withdrawn from later renders`
			: r.reached === "handled-before-aside"
				? `Ilex had already read and acted on ${r.msgId}; it is withdrawn from later renders`
				: r.reached === "unconfirmed"
					? `no aside of ${r.msgId} was confirmed (it may have been read in the ledger); it is withdrawn from later renders`
					: "nothing reached the model";
		out.push({ kind: "channel-refused", workloadId: STANDING_WORKLOAD_ID, rowId: r.id, next: "takes no word", line: `agent channel refused an envelope: ${r.rest} — quarantined in inbox/ilex as .invalid, ${fate} (shown ${CHANNEL_REFUSED_SHOWN_HOURS}h; takes no word)` });
	}
	return out;
}
