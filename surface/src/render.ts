// The ledger rendered (SPEC-2.0.md § B7): the orchestrator's first context at every session start
// and after every compaction. Never a hand's prose. Shape, fixed across wakes (voice: same shape
// every turn): *needs you* first (the § B3 lines and past-due scheduled rows), then the open
// workloads. A wake gives one line per open workload (id, title, the stakes/mode one-liner, lane,
// slices, its needs-you numbers and open question ids) and names the read that gives one block:
// the full blocks of every workload re-sent at each compaction were most of the orchestrator's
// context floor, so it re-compacted every few hours (2026-10-13, ~300K chars of 352K). One block —
// the stakes/mode one-liner (§ A1.2, § B13.1), slices, open questions with options (rendered
// regardless of the last-N window), pending messages with their P-7c states, the last N ledger
// entries (instructions, answers, assumptions, wake reads, slice completions and cancellations, and
// hand-backs the orchestrator has acted on — § B7 names hand-backs as recent history, Codex S5) —
// is the on-demand read's (LEDGER_TOOL), for one workload or all of them. While an agent channel runs on the ledger
// handle (PLAN wl-mv8vx7wdj5nx1c D3), every render carries the `## from other agents` block after the needs-you lines:
// the channel's notes, which are Ilex's to read and not Jo's to answer (surface/src/channel.ts `fromOtherAgents`).
import type { InFlightWorkload, InstructionRow, Ledger, MessageRow, SliceRow, WorkloadStatusRow } from "../../ledger/src/index";
import { channelInForce, fromOtherAgents } from "./channel";
import { needsYouBullet } from "./delivery";
import { type ErrorLine, errorLines, parseDue, wordsOf } from "./errors";
import { type Identity, identityOf } from "./identity";
import { parseSpend } from "./ceiling";
import { ceilingOf, ceilingText, openPairOffer } from "./input";
import { byHandLine, controlEntries, doneLine, holdersOf, isPlanQuestionIn, planFirst } from "./launch";
import { pairOfferLine, shownOptions } from "./pair-suggest";
import { Numbering } from "./numbering";
import { currentGoals, parseAudit, rankDay, rankOpen } from "./rank";
import { LAST_N, LEDGER_TOOL, STANDING_WORKLOAD_ID } from "./types";

export interface RenderOptions {
	now?: string;
	holdHours?: number;
	lastN?: number;
	/** Why this render happened, for the first line. */
	trigger?: string;
	/** Render this one open workload's block only (the needs-you block stays whole): the on-demand read of one workload. */
	workloadId?: string;
	/**
	 * One line per open workload instead of its block (`workloadLine`). Defaults on for a wake (`trigger`
	 * set, no `workloadId`); the on-demand read renders blocks.
	 */
	compact?: boolean;
	/** The first line's parenthetical instead of `wake: <trigger>` (the on-demand read is not a wake). */
	heading?: string;
	/** The session's numbering (surface/src/session.ts), so a row keeps its `#n` across renders; a fresh one (1..k) when absent. */
	numbering?: Numbering;
	/** The Jev rank mode in force (surface/src/rank-launch.ts readRankConfig), for the rank line's label; show when absent. */
	rankMode?: string;
}

export interface Rendered {
	text: string;
	lines: ErrorLine[];
	identity: Identity | null;
	inFlight: InFlightWorkload[];
}

/**
 * `stakes: normal (default …) · mode: autonomous` — one line, both halves flippable in one word; `plan first: …` when the flag stands (decision 15);
 * the effective ceiling last (DESIGN-workload-ceiling.md § 2 item 5).
 */
export function oneLiner(ledger: Ledger, workload: WorkloadStatusRow): string {
	const p = oneLinerParts(ledger, workload);
	return `${p.state} — flip either with one word: throwaway / normal / production, autonomous / user-driven · ceiling ${p.ceiling}`;
}

/** The one-liner without its flip hint: `stakes: X · mode: Y[ · plan first: …] · ceiling $A / Bh` (a "which one?" candidate, surface/extensions/surface-input.ts). */
export function oneLinerCore(ledger: Ledger, workload: WorkloadStatusRow): string {
	const p = oneLinerParts(ledger, workload);
	return `${p.state} · ceiling ${p.ceiling}`;
}

function oneLinerParts(ledger: Ledger, workload: WorkloadStatusRow): { state: string; ceiling: string } {
	const flips = ledger.instructions(workload.id).filter((i) => i.kind === "mode-flip");
	const lastFlip = flips[flips.length - 1];
	const effective = ledger.entries(workload.id, "mode-effective");
	const lastEffective = effective[effective.length - 1];
	const pending = lastFlip && lastFlip.body === workload.mode && !(lastEffective && lastEffective.body === workload.mode && lastEffective.created_at >= lastFlip.created_at);
	const mode = pending ? `${workload.mode} (flip pending until the lane's tool policy matches)` : workload.mode;
	const plan = planFirst(controlEntries(ledger.entries(workload.id, "assumption")));
	const planPart = plan ? ` · plan first: ${plan.trigger}` : "";
	return { state: `stakes: ${workload.stakes} · mode: ${mode}${planPart}`, ceiling: ceilingText(ceilingOf(ledger, workload.id)) };
}

const when = (iso: string): string => iso.replace(/\.\d{3}Z$/, "Z");

function instructionLine(i: InstructionRow): string {
	const who = `${i.author} via ${i.channel}`;
	switch (i.kind) {
		case "answer": return `${when(i.created_at)} answer to ${i.question_id} (${who}): ${i.body}`;
		case "withdrawal": return `${when(i.created_at)} withdrew ${i.question_id} (${who}, then ${i.disposition}): ${i.body}`;
		case "mode-flip": return `${when(i.created_at)} mode → ${i.body} (${who})`;
		default: return `${when(i.created_at)} instruction (${who})${i.slice_id ? ` on ${i.slice_id}` : ""}: ${i.body}`;
	}
}

/** One workload's block. */
export function renderWorkload(ledger: Ledger, w: InFlightWorkload, lastN: number = LAST_N): string {
	const { workload, slices, openQuestions, pendingMessages } = w;
	const out: string[] = [];
	const due = parseDue(workload.brief);
	out.push(`## ${workload.id}${due ? ` (scheduled, due ${due.due})` : ""}`);
	out.push(`brief: ${workload.brief}`);
	const control = controlEntries(ledger.entries(workload.id, "assumption"));
	const done = doneLine(control);
	if (done !== null) out.push(`done: ${done}`);
	out.push(oneLiner(ledger, workload));
	// The runner's newest `spend:` is the workload's running total (it sums every session file), against the ceiling now in force.
	const spend = control.flatMap((c) => {
		const p = c.prefix === "spend" ? parseSpend(c.rest) : null;
		return p ? [p] : [];
	}).at(-1);
	if (spend) {
		const c = ceilingOf(ledger, workload.id);
		out.push(`spent $${Number(spend.usd.toFixed(2))} of $${Number(c.usd.toFixed(2))} · ${Number(spend.wallMin.toFixed(1))} of ${c.wallMin} min`);
	}
	const lane = workload.holder ? `${workload.holder} (lease until ${workload.holder_lease_until ?? "none"})` : "none";
	out.push(`opened ${when(workload.created_at)} by ${workload.created_by}; last activity ${when(workload.last_activity_at)}; lane: ${lane}`);
	if (workload.mode === "user-driven" && !due && !workload.holder) out.push(`by hand: \`${byHandLine(workload.id)}\``);
	out.push(`slices: ${slices.length === 0 ? "none open" : ""}`);
	for (const s of slices) out.push(`- ${s.id} [${s.state}] ${s.task} — done when: ${s.done_condition}; inputs: ${s.inputs}`);
	if (openQuestions.length > 0) {
		out.push("open questions:");
		// A multi-line body keeps its lines under the bullet, indented as errorLines indents them (PLAN wl-muq22rnjcfrrpc D8);
		// the plan question's body starts on the line beneath its q- id, so its path sits right under the line naming it (PLAN wl-mv61a8dh4aeneo D2).
		// A stored `pair` is not listed; a valid offer is its own line beneath the question (PLAN wl-mvb9mw00ycfjeo D4).
		const entries = ledger.entries(workload.id);
		const valid = controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(workload.id)));
		for (const q of openQuestions) {
			const body = q.body.split("\n").join("\n  ");
			out.push(`- ${q.id} on ${q.slice_id}:${isPlanQuestionIn(valid, q) ? `\n  ${body}` : ` ${body}`} — options: ${shownOptions(q.options).join(" / ")}`);
			const offer = openPairOffer(ledger, q);
			if (offer) out.push(`  ${pairOfferLine(wordsOf(ledger, workload.id, valid), q.id, workload.id, offer.signals)}`);
		}
	}
	if (pendingMessages.length > 0) {
		out.push("messages not yet acted on:");
		for (const m of pendingMessages) out.push(`- ${m.id} [${m.state}] ${m.sender} → ${m.recipient}${m.slice_id ? ` (${m.slice_id})` : ""}: ${m.body}`);
	}
	const recent = [
		...ledger.instructions(workload.id).map((i) => ({ at: i.created_at, line: instructionLine(i) })),
		...ledger.entries(workload.id).map((e) => ({ at: e.created_at, line: `${when(e.created_at)} ${e.kind} by ${e.created_by}${e.slice_id ? ` on ${e.slice_id}` : ""}: ${e.body}` })),
		...ledger.db.query<SliceRow, [string]>("SELECT * FROM slices WHERE workload_id = ? AND state IN ('done', 'cancelled')").all(workload.id)
			.map((s) => ({ at: s.changed_at, line: `${when(s.changed_at)} slice ${s.id} ${s.state} by ${s.changed_by}${s.artifact ? `: ${s.artifact}` : ""}` })),
		...ledger.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE workload_id = ? AND state IN ('consumed', 'acted-on')").all(workload.id)
			.map((m) => ({ at: m.changed_at, line: `${when(m.changed_at)} message ${m.id} ${m.state} (${m.sender} → ${m.recipient}${m.slice_id ? `, ${m.slice_id}` : ""}): ${m.body}` })),
	].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-lastN);
	if (recent.length > 0) {
		out.push(`last ${recent.length} ledger entries:`);
		for (const r of recent) out.push(`- ${r.line}`);
	}
	return out.join("\n");
}

/** The title a workload line carries: the brief's first line, whitespace collapsed, cut at 80 characters with `…`. */
function title(brief: string): string {
	const first = (brief.split("\n").find((l) => l.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
	return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/**
 * One open workload on one line, for the wake: `- <id>: <title> · <one-liner core> · lane: … · slices: …`, then the
 * needs-you lines that are about it (their `#n`, else their kind), its open question ids and its pending message
 * count when there are any. The block is the on-demand read's (`renderWorkload`).
 */
export function workloadLine(ledger: Ledger, w: InFlightWorkload, lines: readonly ErrorLine[]): string {
	const { workload, slices, openQuestions, pendingMessages } = w;
	const due = parseDue(workload.brief);
	const parts = [`- ${workload.id}${due ? ` (scheduled, due ${due.due})` : ""}: ${title(workload.brief)}`, oneLinerCore(ledger, workload), `lane: ${workload.holder ?? "none"}`];
	const states = new Map<string, number>();
	for (const s of slices) states.set(s.state, (states.get(s.state) ?? 0) + 1);
	parts.push(`slices: ${states.size === 0 ? "none open" : [...states].map(([state, n]) => `${n} ${state}`).join(", ")}`);
	// A channel proposal carries its target's number: the target line already lists it.
	const mine = lines.filter((l) => l.workloadId === workload.id && l.kind !== "proposal");
	if (mine.length > 0) parts.push(`needs you: ${mine.map((l) => (l.n === undefined ? l.kind : `#${l.n}`)).join(", ")}`);
	if (openQuestions.length > 0) parts.push(`open questions: ${openQuestions.map((q) => q.id).join(", ")}`);
	if (pendingMessages.length > 0) parts.push(`${pendingMessages.length} message(s) not yet acted on`);
	return parts.join(" · ");
}

/** A rank-audit line is shown while its row is this young (D5: the newest audit, under 7 days old). */
const AUDIT_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Jev rank lines under the needs-you block (PLAN wl-mv8k039gvogt8g D5), from `rankOpen` over stored rows only (no
 * judge, no write): `Rank (Jev, show-only): 1 <wl> <title≤40> · 2 … · 3 …; <n> unscored; goals <set date|stale|none>;
 * as2_rank for the table`, then the newest `rank-audit:` while under 7 days old. Empty with nothing ranked and no audit.
 */
export function rankLines(ledger: Ledger, now: string, mode = "show"): string[] {
	const items = rankOpen(ledger, now);
	const out: string[] = [];
	if (items.length > 0) {
		const top = items.slice(0, 3).map((i, n) => {
			const t = i.title.replace(/\s+/g, " ");
			return `${n + 1} ${i.workloadId} ${t.length > 40 ? `${t.slice(0, 39)}…` : t}${i.pinned ? " (pinned)" : i.score === undefined ? " (unscored)" : ""}`;
		});
		const goals = currentGoals(ledger, now);
		const label = mode === "show" ? "Jev, show-only" : `Jev, launch order ${mode}`;
		out.push(`Rank (${label}): ${top.join(" · ")}; ${items.filter((i) => i.score === undefined).length} unscored; goals ${goals.state === "set" && goals.setAt ? `set ${rankDay(goals.setAt)}` : goals.state}; as2_rank for the table`);
	}
	const audits = controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption")).filter((c) => c.prefix === "rank-audit");
	const newest = audits.at(-1);
	const a = newest ? parseAudit(newest.body) : null;
	if (newest && a && Date.parse(now) - Date.parse(newest.createdAt) < AUDIT_SHOWN_MS) {
		out.push(`Rank audit ${a.from}..${a.to}: ${a.picks} pick(s) of Jo's, ${a.scorable} scorable, Jev's #1 ${a.top1}, top 3 ${a.top3}, mean percentile ${a.meanpct ?? "unknown"}; report ${a.report}`);
	}
	return out;
}

/** The whole wake render. */
export function renderWake(ledger: Ledger, opts: RenderOptions = {}): Rendered {
	const now = opts.now ?? ledger.now();
	const inFlight = ledger.inFlight();
	const lines = (opts.numbering ?? new Numbering()).assign(errorLines(ledger, inFlight, { now, holdHours: opts.holdHours }));
	const identity = identityOf(ledger);
	const out: string[] = [];
	const why = opts.heading ?? (opts.trigger ? `wake: ${opts.trigger}` : "");
	out.push(`# Ledger at ${when(now)}${why ? ` (${why})` : ""}`);
	out.push(identity ? `you are ${identity.name} (${identity.pronouns})` : "you have no identity row yet: right after the wake read below, choose a name and pronouns and record them with orchestrator_identity");
	out.push("");
	out.push("## needs you");
	if (lines.length === 0) out.push("nothing: no reserved action waiting, nothing held past the threshold, no slice failed twice, no lane died, no lane left work idle, no lane waiting on you, nothing scheduled past due");
	for (const l of lines) out.push(needsYouBullet(l));
	if (!opts.workloadId) out.push(...rankLines(ledger, now, opts.rankMode));
	const channel = channelInForce(ledger);
	if (channel) out.push("", ...fromOtherAgents(ledger, channel, now));
	const work = inFlight.filter((w) => w.workload.id !== STANDING_WORKLOAD_ID && (!opts.workloadId || w.workload.id === opts.workloadId));
	const compact = opts.compact ?? (opts.trigger !== undefined && !opts.workloadId);
	out.push("");
	if (work.length === 0) out.push("## open workloads\nnone");
	else if (compact) {
		out.push(`## open workloads (one line each; one workload's slices, questions with options, messages and recent entries: ${LEDGER_TOOL} with workload: <wl-…>)`);
		for (const w of work) out.push(workloadLine(ledger, w, lines));
	} else {
		for (const w of work) {
			out.push(renderWorkload(ledger, w, opts.lastN));
			out.push("");
		}
	}
	return { text: out.join("\n").trimEnd(), lines, identity, inFlight };
}
