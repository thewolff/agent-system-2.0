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
//    request repeats it (MIGRATION.md item 31). A repeat names the earliest call it repeats.
// 2. held past § A3: the oldest `held` message per open workload that is addressed to a lane (a
//    message to the orchestrator is consumed by the surface at read, so it is never "held with no
//    live lane"), older than HOLD_HOURS; or an open workload — sliced or not (§ A3: "the workload
//    itself open with no lane and no activity"; the standing workload excepted) — with no holder and
//    no activity for HOLD_HOURS, compared unrounded (Codex S2).
// 3. a slice that failed its runtime artifact twice: ARTIFACT_FAILURES_SURFACED `artifact-failed:`
//    messages on one slice since its last `artifact-passed:` (surface/src/signals.ts; writers: the
//    lane's artifact observer in surface/extensions/lane.ts and P-11 row 8 for a refused push).
// 4. a lane died: a `lane-died:` message still `held` (not yet surfaced once), or a lapsed lease no
//    such row records yet (the surface records it before rendering). Hidden while the death is the machinery's (PLAN
//    wl-mvfqvd5hy8zv28 § 1.6, `machineryDeath` in surface/src/relaunch-surface.ts): its relaunch is due or waiting out the
//    backoff, a later attempt names the lane in a `relaunch` cause, or, for good, an incident keyed to the lane exists. An
//    item-68 idle line (6.) is hidden by the same rule. The death rows stay; hiding never reads a message's delivery state.
//    Incident (§ 1.5): each held `incident:` message the surface wrote (the pre-read step, surface/extensions/wake.ts) is
//    one line, unnumbered, naming Jo's choices; delivery consumes it, so it shows once.
// 5. a lane waiting on a human: every open `question`, with its options (a stored `pair` left out, PLAN
//    wl-mvb9mw00ycfjeo D2); and every unresolved
//    `prompt-wait:` (a leaked blocking prompt, § B3 item 5 first trigger). A question is cut at 120
//    characters, except the plan question (`isPlanQuestionIn`, PLAN wl-muq22rnjcfrrpc D8): it shows
//    whole, its body starting on the line beneath the q- id (the plan path directly beneath the line
//    naming the question, PLAN wl-mv61a8dh4aeneo D2) and every body line indented two spaces. The
//    runner's ceiling question takes the state `stopped` once the workload's newest `lane-stop:` is
//    `accepted ceiling`, written at or after it (PLAN wl-mv5msri070p0qo D3), so the stop at 100 %
//    reaches the surface again though the question surfaced at 80 %.
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
// Due: an open workload whose brief starts `due:<date> ` with date <= now by instant (Codex S4).
// Scratch (PLAN wl-mv5oikd5jtquww § 1.5, § 1.6): an open workload whose newest valid `scratch-over-cap:` /
// `scratch-under-cap:` control entry (a holder's: the lane extension's turn-end measure, surface/extensions/lane.ts)
// is an over-cap one, and the standing workload whose newest `scratch-disk:` / `scratch-disk-ok:` by the daily sweep
// (surface/scripts/scratch-sweep.ts) is a `scratch-disk:`. Advisory: nothing is refused for size; keyed by the entry,
// so delivered once per crossing, and gone when the clearing entry is written.
// Train-aware routing (PLAN wl-mv8s8srodefytc rev 17.1 D9 F16): on a workload that owns a train task (surface/src/merge-train.ts
// `trainTaskWindows`), the first lane death inside a task's window (from the `train-task:` to its settle, or still open) and an
// intended exit inside one are not shown: the task counts them (D8) and the train tick relaunches the owner (`trainRouted`). The
// test runner's no-live-lane `test-run-failed:` is not shown only when it is a run of the task's own PR while the task is
// unsettled, or the red run its settle counted (`trainRoutedRun`); any other failure is shown. Jo hears of the PR only through D9's two alerts. An alert question whose send ladder
// the tick has taken to level 2 or 3 (`train-alert:`, surface/scripts/train-tick.ts) shows as a LOUD line, a new state each level.
// Answerable lines (a waiting reserved request, an open question with options) carry a
// session-stable number Jo answers with, set by surface/src/numbering.ts, never here. An idle line
// has no one-word answer, so it is never numbered.
import { type EntryRow, type InFlightWorkload, type Ledger, type MessageRow, TEST_RUNNER_BY, type WorkloadStatusRow } from "../../ledger/src/index";
import { SCRATCH_ENTRY } from "../../gates/src/scratch";
import { INCIDENT_PREFIX } from "./incident";
import { isCeilingQuestion, openPairOffer } from "./input";
import { byHandLine, type ControlEntry, type ControlPrefix, controlEntries, doneLine, holdersOf, isIntendedOutcome, isPlanQuestionIn, laneExit } from "./launch";
import { type TaskWindow, TRAIN_ALERT_LADDER, trainAlertLevel, trainTaskWindows } from "./merge-train";
import { questionSubject } from "./orchestrator-question";
import { pairOfferLine, pairTakenLine, pairTakenQuestion, shownOptions } from "./pair-suggest";
import { machineryDeath, parseIncident, type RelaunchView, relaunchView } from "./relaunch-surface";
import { artifactFailures, laneDeaths, openPromptWaits, unrecordedLapse } from "./signals";
import { parseTestRunFailed, testRuns } from "./test-run";
import {
	ARTIFACT_FAILURES_SURFACED, DUE_PREFIX, HOLD_HOURS, LAUNCH_LANE_TOOL, MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY,
	TEST_RUN_FAILED_PREFIX,
} from "./types";

export type ErrorKind = "reserved" | "held" | "artifact" | "test-run" | "lane-died" | "incident" | "question" | "due" | "idle" | "scratch" | "pair";

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
	/** For a question: the options Jo answers with one word. */
	options?: string[];
	/**
	 * What makes this line's state: it is delivered again only when this changes (the artifact
	 * count, the prompt wait's id). Ages and clocks are not state.
	 */
	state?: string;
	/** Held orchestrator-bound messages behind the line; a delivery consumes them (P-7c). */
	messageIds?: string[];
	/** The session-stable number Jo answers with (`#<n>`); set by Numbering (surface/src/numbering.ts), never by errorLines. */
	n?: number;
}

export interface ErrorOptions {
	now?: string;
	holdHours?: number;
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
		if (c.laneId === null || c.prefix === "spend" || c.prefix === "ctx-index") continue;
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
		kind: "test-run", workloadId: wl, rowId: newest.m.id, messageIds: failed.map(({ m }) => m.id),
		line: `full suite ${verdict} on ${wl} at ${sha.slice(0, 7)}: ${failing} failing${first ? `, first ${first}` : ""} — relaunch to fix (${runDir ?? "no run dir"})`,
	};
}

/** Every line owed right now, in § B3 order (1–3), the test-run lines, § B3 order (4–5) with the idle lines after the deaths, then the due rows, then the scratch lines. */
export function errorLines(ledger: Ledger, inFlight: InFlightWorkload[] = ledger.inFlight(), opts: ErrorOptions = {}): ErrorLine[] {
	const now = opts.now ?? ledger.now();
	const holdHours = opts.holdHours ?? HOLD_HOURS;
	const reserved: ErrorLine[] = [];
	const held: ErrorLine[] = [];
	const artifact: ErrorLine[] = [];
	const testRun: ErrorLine[] = [];
	const died: ErrorLine[] = [];
	const idle: ErrorLine[] = [];
	const questions: ErrorLine[] = [];
	const due: ErrorLine[] = [];
	const scratch: ErrorLine[] = [];
	const taskWindows = trainTaskWindows(ledger);
	for (const { workload, slices, openQuestions, pendingMessages } of inFlight) {
		const windows = taskWindows.get(workload.id) ?? [];
		const wl = workload.id;
		const label = wl === STANDING_WORKLOAD_ID ? "orchestrator" : wl;
		const scheduled = parseDue(workload.brief);
		const requests = reservedStates(ledger, wl);
		for (const r of requests) {
			if (r.state.kind !== "waiting") continue;
			reserved.push({ kind: "reserved", workloadId: wl, rowId: r.id, line: `reserved action waiting on you (${label}): ${short(r.body)}${repeatNote(r, requests)} — \`approve ${r.id}\` or \`deny ${r.id}\`` });
		}
		const oldest = pendingMessages.find((m) => m.state === "held" && m.recipient !== ORCHESTRATOR_RECIPIENT);
		if (oldest && hoursElapsed(oldest.created_at, now) >= holdHours) {
			held.push({ kind: "held", workloadId: wl, rowId: oldest.id, line: `held ${hoursBetween(oldest.created_at, now)}h on ${label}: message ${oldest.id} (${oldest.sender} → ${oldest.recipient}) has had no live lane since ${oldest.created_at}` });
		} else if (wl !== STANDING_WORKLOAD_ID && !scheduled && !workload.holder && hoursElapsed(workload.last_activity_at, now) >= holdHours) {
			// Fable F2d: an open workload with no slices yet and no lane is held too. The standing workload and a
			// scheduled row (M11 `due:` brief) are not a lane's work: neither ever has a lane, both are excluded.
			held.push({ kind: "held", workloadId: wl, rowId: wl, line: `held ${hoursBetween(workload.last_activity_at, now)}h on ${label}: ${workload.open_slices} open slice(s), no lane, no activity since ${workload.last_activity_at}` });
		}
		for (const [sliceId, { n, heldIds }] of artifactFailures(ledger, wl)) {
			if (n < ARTIFACT_FAILURES_SURFACED) continue;
			const slice = slices.find((s) => s.id === sliceId) ?? ledger.slice(sliceId);
			if (!slice || slice.state === "done" || slice.state === "cancelled") continue;
			artifact.push({ kind: "artifact", workloadId: wl, rowId: sliceId, state: String(n), messageIds: heldIds, line: `slice ${sliceId} (${label}) failed its runtime artifact ${n} times: ${short(slice.task, 70)}` });
		}
		const run = testRunLine(ledger, workload, pendingMessages, now, windows);
		if (run) testRun.push(run);
		// § 1.6: read once per workload, only when a death or an idle line could be shown.
		let view: RelaunchView | null = null;
		const machinery = (lane: string): boolean => wl !== STANDING_WORKLOAD_ID && machineryDeath((view ??= relaunchView(ledger, wl, now)), lane);
		const deaths = laneDeaths(ledger, wl);
		const deathTimes = deaths.map((d) => d.created_at);
		for (const d of deaths) {
			if (d.state !== "held" || trainRouted(windows, d.created_at, deathTimes) || machinery(d.holder)) continue;
			died.push({ kind: "lane-died", workloadId: wl, rowId: d.id, messageIds: [d.id], line: `lane ${d.holder} on ${label} died: ${d.body.slice(d.body.indexOf(":", 11) + 1).trim()}, ${workload.open_slices} open slice(s)${workload.holder && workload.holder !== d.holder ? `; ${workload.holder} holds it now` : ""}` });
		}
		if (unrecordedLapse(ledger, workload, now) && !trainRouted(windows, workload.holder_lease_until!, deathTimes) && !machinery(workload.holder!)) {
			died.push({ kind: "lane-died", workloadId: wl, rowId: wl, state: `${workload.holder}@${workload.holder_lease_until}`, line: `lane ${workload.holder} on ${label} died: lease lapsed ${workload.holder_lease_until}, ${workload.open_slices} open slice(s)` });
		}
		for (const m of pendingMessages) {
			if (m.state !== "held" || m.recipient !== ORCHESTRATOR_RECIPIENT || m.created_by !== SURFACE_BY || !m.body.startsWith(INCIDENT_PREFIX)) continue;
			const i = parseIncident(m.body);
			if (i === null || i.workloadId !== wl) continue;
			died.push({
				kind: "incident", workloadId: wl, rowId: m.id, messageIds: [m.id],
				line: `incident on ${label}: ${i.kind} of ${i.key} stopped after ${i.count}/${i.limit} retries without progress: ${i.detail} — relaunch with \`${LAUNCH_LANE_TOOL}\`, close, or instruct`,
			});
		}
		// D5: a taken pair, whatever else is open, while the workload is user-driven and no lane holds it under a live lease.
		const laneLive = workload.holder?.startsWith("lane-") === true && (workload.holder_lease_until === null || workload.holder_lease_until >= now);
		const taken = wl !== STANDING_WORKLOAD_ID && workload.mode === "user-driven" && !laneLive ? takenPair(ledger.entries(wl, "assumption")) : null;
		if (taken) idle.push({ kind: "pair", workloadId: wl, rowId: taken.questionId, state: "taken", line: pairTakenLine(wordsOf(ledger, wl), taken.questionId, wl) });
		let control: ControlEntry[] = [];
		if (openQuestions.length > 0) {
			const entries = ledger.entries(wl);
			control = controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(wl)));
		} else if (!taken && wl !== STANDING_WORKLOAD_ID && workload.open_slices > 0 && !workload.holder && !requests.some((r) => r.state.kind === "waiting")) {
			// Item 68: no holder, no question, no reserved request — only an intended lane-exit: as the newest
			// lifecycle entry says the lane ended on purpose and left the work to nobody. A lapsed holder is
			// still the holder and is the lane-died line's; `lane-exit:` needs no holder list to validate.
			// A user-driven workload has no relaunch: the line names the by-hand command (PLAN wl-mvb9mw00ycfjeo D5).
			const ended = idleExit(controlEntries(ledger.entries(wl)));
			const next = workload.mode === "user-driven" ? `continue it with ${byHandLine(wl)}, close, or instruct` : "relaunch, close, or instruct";
			if (ended && !trainRouted(windows, ended.createdAt) && !machinery(ended.laneId)) idle.push({ kind: "idle", workloadId: wl, rowId: ended.id, line: `lane ${ended.laneId} on ${label} ended (${ended.outcome}) with ${workload.open_slices} open slice(s) and no question; ${next}` });
		}
		for (const q of openQuestions) {
			if (wl === STANDING_WORKLOAD_ID) {
				// The orchestrator's own ask to Jo (MIGRATION.md item 105), its subject workload from the surface's subject entry.
				const about = questionSubject(ledger, q.id);
				questions.push({ kind: "question", workloadId: wl, rowId: q.id, options: q.options, line: `the orchestrator asked you (${q.id}${about ? `, about ${about}` : ""}): ${short(q.body, 120)} — answer with one word: ${q.options.join(" / ")} (or \`withdraw\`)` });
				continue;
			}
			// D4: a valid pair offer is its own line, right before its question's; the question lists its options less `pair` (D2).
			const offer = openPairOffer(ledger, q);
			if (offer) questions.push({ kind: "pair", workloadId: wl, rowId: q.id, state: "offer", line: pairOfferLine(wordsOf(ledger, wl, control), q.id, wl, offer.signals) });
			const body = isPlanQuestionIn(control, q) ? `\n  ${q.body.split("\n").join("\n  ")}` : ` ${short(q.body, 120)}`;
			// The stop at 100 % (PLAN wl-mv5msri070p0qo D3): the workload's newest lane-stop: accepted the ceiling at or after the question; a new state, so it is delivered again.
			const stop = control.filter((c) => c.prefix === "lane-stop").at(-1);
			const stopped = stop !== undefined && /^accepted ceiling\b/.test(stop.rest) && stop.createdAt >= q.created_at && isCeilingQuestion(q, slices.find((s) => s.id === q.slice_id) ?? ledger.slice(q.slice_id));
			// D9's re-send: level 2 or 3 of the train tick's ladder makes the line LOUD, each level a new state.
			const loud = trainAlertLevel(control, q.id);
			const step = loud >= 2 ? TRAIN_ALERT_LADDER.find((s) => s.level === loud) : undefined;
			const tag = step ? `LOUD${step.labels.includes("critical") ? ", critical" : ""} (unacknowledged ${step.afterMs / 3_600_000} h): ` : "";
			const asker = q.created_by === MERGE_TRAIN_BY ? `merge train ${label} needs you` : `lane on ${label} is waiting on you`;
			const state = stopped ? "stopped" : step ? `loud-${loud}` : null;
			questions.push({
				kind: "question", workloadId: wl, rowId: q.id, options: q.options, ...(state ? { state } : {}),
				line: `${tag}${asker} (${q.id}, slice ${q.slice_id}):${body} — answer with one word: ${shownOptions(q.options).join(" / ")} (or \`withdraw\`)${stopped ? "; the lane stopped at the ceiling" : ""}`,
			});
		}
		for (const w of openPromptWaits(ledger, wl)) {
			questions.push({ kind: "question", workloadId: wl, rowId: w.id, messageIds: [w.id], line: `lane ${w.lane} on ${label} is blocked on a human prompt it should never open (${w.toolName}, tool call ${w.toolCallId}, since ${w.created_at}): ${short(w.reason, 100)} — answer it in that session or end the session` });
		}
		if (scheduled && Date.parse(scheduled.due) <= Date.parse(now)) {
			due.push({ kind: "due", workloadId: wl, rowId: wl, line: `scheduled and past due (${scheduled.due}): ${short(scheduled.text, 120)} — close ${wl} with a receipt when done` });
		}
		if (wl === STANDING_WORKLOAD_ID) {
			const disk = openScratchEntry(controlEntries(ledger.entries(wl, "assumption")), "scratch-disk", "scratch-disk-ok");
			if (disk) scratch.push({ kind: "scratch", workloadId: wl, rowId: disk.id, line: `scratch disk: ${disk.rest} — the daily sweep clears this line once the total is back under` });
		} else {
			const entries = ledger.entries(wl, "assumption");
			// The holders are read only when there is an over-cap line to validate.
			const over = entries.some((e) => e.body.startsWith(SCRATCH_ENTRY.overCap))
				? openScratchEntry(controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(wl))), "scratch-over-cap", "scratch-under-cap")
				: null;
			if (over) scratch.push({ kind: "scratch", workloadId: wl, rowId: over.id, line: `scratch of ${label} over its cap: ${over.rest} (advisory: nothing is refused; ${over.createdBy} was told)` });
		}
	}
	return [...reserved, ...held, ...artifact, ...testRun, ...died, ...idle, ...questions, ...due, ...scratch];
}
