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
//    such row records yet (the surface records it before rendering).
// 5. a lane waiting on a human: every open `question`, with its options; and every unresolved
//    `prompt-wait:` (a leaked blocking prompt, § B3 item 5 first trigger). A question is cut at 120
//    characters, except the plan question (`isPlanQuestionIn`, PLAN wl-muq22rnjcfrrpc D8): it shows
//    whole, its first line on the bullet and every other line indented two spaces under it.
// 6. a lane that ended leaving work idle (MIGRATION.md item 68): an open workload (the standing one
//    excepted) with open slices, no holder, no open question and no waiting reserved request, whose
//    newest lane lifecycle entry is a `lane-exit:` with an intended outcome (`isIntendedOutcome`): the
//    lane ended on purpose — parked, completed, released — and nothing holds the work or asks for a
//    word. No `lane-died:` row exists for it (an intended end writes none), so nothing else says so.
//    Keyed by the exit entry, so it is delivered once per ending, not once per poll.
// Test run: the newest held `test-run-failed:` the test runner sent about a workload no lane holds
// under a live lease (MIGRATION.md item 24, PLAN § 2.5), shown once: delivery consumes it, a lane
// taking the workload hides it, a `test-run:` green written after it clears it.
// Chaos: each held `chaos-failed:` message the surface itself wrote (`SURFACE_BY`) to the
// orchestrator on the standing workload, one line per night (surface/src/chaos-alert.ts
// `recordChaosAlerts` writes them before every read; PLAN wl-mv5lpzqacbe5ts § 2.2), shown once:
// delivery consumes it, and the delivered message stays the night's dedup record. A body by any
// other writer, on another workload or to another recipient, or that does not parse, is no line.
// Due: an open workload whose brief starts `due:<date> ` with date <= now by instant (Codex S4).
// Answerable lines (a waiting reserved request, an open question with options) carry a
// session-stable number Jo answers with, set by surface/src/numbering.ts, never here. An idle line
// has no one-word answer, so it is never numbered.
import { type InFlightWorkload, type Ledger, type MessageRow, TEST_RUNNER_BY, type WorkloadStatusRow } from "../../ledger/src/index";
import { type ControlEntry, controlEntries, holdersOf, isIntendedOutcome, isPlanQuestionIn, laneExit } from "./launch";
import { parseChaosFailed } from "./chaos-alert";
import { questionSubject } from "./orchestrator-question";
import { artifactFailures, laneDeaths, openPromptWaits, unrecordedLapse } from "./signals";
import { parseTestRunFailed, testRuns } from "./test-run";
import {
	ARTIFACT_FAILURES_SURFACED, CHAOS_FAILED_PREFIX, DUE_PREFIX, HOLD_HOURS, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY, TEST_RUN_FAILED_PREFIX,
} from "./types";

export type ErrorKind = "reserved" | "held" | "artifact" | "test-run" | "chaos" | "lane-died" | "question" | "due" | "idle";

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
function idleExit(control: readonly ControlEntry[]): { id: string; laneId: string; outcome: string } | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.laneId === null || c.prefix === "spend" || c.prefix === "ctx-index") continue;
		if (c.prefix !== "lane-exit") return null;
		const exit = laneExit(control, c.laneId);
		return exit && isIntendedOutcome(exit.outcome) ? { id: c.id, laneId: c.laneId, outcome: exit.outcome } : null;
	}
	return null;
}

/**
 * The § 2.5 line for a workload: its newest held `test-run-failed:` from the test runner, unless a
 * lane holds the workload under a live lease or a green `test-run:` was written after it. The run
 * dir is the newest `test-run:` entry's on the message's slice. A delivery consumes every held one.
 */
function testRunLine(ledger: Ledger, workload: WorkloadStatusRow, pending: readonly MessageRow[], now: string): ErrorLine | null {
	const wl = workload.id;
	const failed = pending.flatMap((m) => {
		if (m.state !== "held" || m.recipient !== ORCHESTRATOR_RECIPIENT || m.created_by !== TEST_RUNNER_BY || !m.body.startsWith(TEST_RUN_FAILED_PREFIX)) return [];
		const f = parseTestRunFailed(m.body);
		return f && f.workloadId === wl ? [{ m, f }] : [];
	});
	const newest = failed.at(-1);
	if (!newest) return null;
	if (workload.holder && (workload.holder_lease_until === null || workload.holder_lease_until >= now)) return null;
	const records = testRuns(ledger.entries(wl, "assumption"));
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

/** Every line owed right now, in § B3 order (1–3), the test-run lines, the chaos lines, § B3 order (4–5) with the idle lines after the deaths, then the due rows. */
export function errorLines(ledger: Ledger, inFlight: InFlightWorkload[] = ledger.inFlight(), opts: ErrorOptions = {}): ErrorLine[] {
	const now = opts.now ?? ledger.now();
	const holdHours = opts.holdHours ?? HOLD_HOURS;
	const reserved: ErrorLine[] = [];
	const held: ErrorLine[] = [];
	const artifact: ErrorLine[] = [];
	const testRun: ErrorLine[] = [];
	const chaos: ErrorLine[] = [];
	const died: ErrorLine[] = [];
	const idle: ErrorLine[] = [];
	const questions: ErrorLine[] = [];
	const due: ErrorLine[] = [];
	for (const { workload, slices, openQuestions, pendingMessages } of inFlight) {
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
		const run = testRunLine(ledger, workload, pendingMessages, now);
		if (run) testRun.push(run);
		if (wl === STANDING_WORKLOAD_ID) {
			// One line per night, oldest night first (one reconcile writes several in the same millisecond, so ledger order is not night order).
			const nights = pendingMessages.flatMap((m) => {
				if (m.state !== "held" || m.created_by !== SURFACE_BY || m.recipient !== ORCHESTRATOR_RECIPIENT || !m.body.startsWith(CHAOS_FAILED_PREFIX)) return [];
				const a = parseChaosFailed(m.body);
				return a ? [{ m, a }] : [];
			});
			for (const { m, a } of nights.sort((x, y) => x.a.day.localeCompare(y.a.day))) {
				chaos.push({ kind: "chaos", workloadId: wl, rowId: m.id, messageIds: [m.id], line: `nightly chaos run ${a.day} (${a.fault ?? "-"}): ${a.verdict} — ${short(a.reason, 120)} — report ${a.report ?? "-"}` });
			}
		}
		for (const d of laneDeaths(ledger, wl)) {
			if (d.state !== "held") continue;
			died.push({ kind: "lane-died", workloadId: wl, rowId: d.id, messageIds: [d.id], line: `lane ${d.holder} on ${label} died: ${d.body.slice(d.body.indexOf(":", 11) + 1).trim()}, ${workload.open_slices} open slice(s)${workload.holder && workload.holder !== d.holder ? `; ${workload.holder} holds it now` : ""}` });
		}
		if (unrecordedLapse(ledger, workload, now)) {
			died.push({ kind: "lane-died", workloadId: wl, rowId: wl, state: `${workload.holder}@${workload.holder_lease_until}`, line: `lane ${workload.holder} on ${label} died: lease lapsed ${workload.holder_lease_until}, ${workload.open_slices} open slice(s)` });
		}
		let control: ControlEntry[] = [];
		if (openQuestions.length > 0) {
			const entries = ledger.entries(wl);
			control = controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(wl)));
		} else if (wl !== STANDING_WORKLOAD_ID && workload.open_slices > 0 && !workload.holder && !requests.some((r) => r.state.kind === "waiting")) {
			// Item 68: no holder, no question, no reserved request — only an intended lane-exit: as the newest
			// lifecycle entry says the lane ended on purpose and left the work to nobody. A lapsed holder is
			// still the holder and is the lane-died line's; `lane-exit:` needs no holder list to validate.
			const ended = idleExit(controlEntries(ledger.entries(wl)));
			if (ended) idle.push({ kind: "idle", workloadId: wl, rowId: ended.id, line: `lane ${ended.laneId} on ${label} ended (${ended.outcome}) with ${workload.open_slices} open slice(s) and no question; relaunch, close, or instruct` });
		}
		for (const q of openQuestions) {
			if (wl === STANDING_WORKLOAD_ID) {
				// The orchestrator's own ask to Jo (MIGRATION.md item 105), its subject workload from the surface's subject entry.
				const about = questionSubject(ledger, q.id);
				questions.push({ kind: "question", workloadId: wl, rowId: q.id, options: q.options, line: `the orchestrator asked you (${q.id}${about ? `, about ${about}` : ""}): ${short(q.body, 120)} — answer with one word: ${q.options.join(" / ")} (or \`withdraw\`)` });
				continue;
			}
			const body = isPlanQuestionIn(control, q) ? q.body.split("\n").join("\n  ") : short(q.body, 120);
			questions.push({ kind: "question", workloadId: wl, rowId: q.id, options: q.options, line: `lane on ${label} is waiting on you (${q.id}, slice ${q.slice_id}): ${body} — answer with one word: ${q.options.join(" / ")} (or \`withdraw\`)` });
		}
		for (const w of openPromptWaits(ledger, wl)) {
			questions.push({ kind: "question", workloadId: wl, rowId: w.id, messageIds: [w.id], line: `lane ${w.lane} on ${label} is blocked on a human prompt it should never open (${w.toolName}, tool call ${w.toolCallId}, since ${w.created_at}): ${short(w.reason, 100)} — answer it in that session or end the session` });
		}
		if (scheduled && Date.parse(scheduled.due) <= Date.parse(now)) {
			due.push({ kind: "due", workloadId: wl, rowId: wl, line: `scheduled and past due (${scheduled.due}): ${short(scheduled.text, 120)} — close ${wl} with a receipt when done` });
		}
	}
	return [...reserved, ...held, ...artifact, ...testRun, ...chaos, ...died, ...idle, ...questions, ...due];
}
