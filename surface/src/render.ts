// The ledger rendered (SPEC-2.0.md § B7): the orchestrator's first context at every session start
// and after every compaction. Never a hand's prose. Shape, fixed across wakes (voice: same shape
// every turn): *needs you* first (the § B3 lines and past-due scheduled rows), then one block per
// open workload — the stakes/mode one-liner (§ A1.2, § B13.1), slices, open questions with options
// (rendered regardless of the last-N window), pending messages with their P-7c states, the last N
// ledger entries (instructions, answers, assumptions, wake reads, slice completions and
// cancellations, and hand-backs the orchestrator has acted on — § B7 names hand-backs as recent
// history, Codex S5).
import type { InFlightWorkload, InstructionRow, Ledger, MessageRow, SliceRow, WorkloadStatusRow } from "../../ledger/src/index";
import { needsYouBullet } from "./delivery";
import { type ErrorLine, errorLines, parseDue } from "./errors";
import { type Identity, identityOf } from "./identity";
import { parseSpend } from "./ceiling";
import { ceilingOf, ceilingText } from "./input";
import { byHandLine, controlEntries, doneLine, planFirst } from "./launch";
import { Numbering } from "./numbering";
import { LAST_N, STANDING_WORKLOAD_ID } from "./types";

export interface RenderOptions {
	now?: string;
	holdHours?: number;
	lastN?: number;
	/** Why this render happened, for the first line. */
	trigger?: string;
	/** Render this one open workload's block only (the needs-you block stays whole): the on-demand read of one workload. */
	workloadId?: string;
	/** The first line's parenthetical instead of `wake: <trigger>` (the on-demand read is not a wake). */
	heading?: string;
	/** The session's numbering (surface/src/session.ts), so a row keeps its `#n` across renders; a fresh one (1..k) when absent. */
	numbering?: Numbering;
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

// Every event line names its row id (en-/in-/sl-/msg-), so a CLAIM about it can cite the row, not the render time.
function instructionLine(i: InstructionRow): string {
	const who = `${i.author} via ${i.channel}`;
	switch (i.kind) {
		case "answer": return `${when(i.created_at)} answer ${i.id} to ${i.question_id} (${who}): ${i.body}`;
		case "withdrawal": return `${when(i.created_at)} withdrawal ${i.id} of ${i.question_id} (${who}, then ${i.disposition}): ${i.body}`;
		case "mode-flip": return `${when(i.created_at)} mode-flip ${i.id} → ${i.body} (${who})`;
		default: return `${when(i.created_at)} instruction ${i.id} (${who})${i.slice_id ? ` on ${i.slice_id}` : ""}: ${i.body}`;
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
		// A multi-line body (the plan question, PLAN wl-muq22rnjcfrrpc D8) keeps its lines under the bullet, indented as errorLines indents them.
		for (const q of openQuestions) out.push(`- ${q.id} on ${q.slice_id}: ${q.body.split("\n").join("\n  ")} — options: ${q.options.join(" / ")}`);
	}
	if (pendingMessages.length > 0) {
		out.push("messages not yet acted on:");
		for (const m of pendingMessages) out.push(`- ${m.id} [${m.state}] ${m.sender} → ${m.recipient}${m.slice_id ? ` (${m.slice_id})` : ""}: ${m.body}`);
	}
	const recent = [
		...ledger.instructions(workload.id).map((i) => ({ at: i.created_at, line: instructionLine(i) })),
		...ledger.entries(workload.id).map((e) => ({ at: e.created_at, line: `${when(e.created_at)} ${e.kind} ${e.id} by ${e.created_by}${e.slice_id ? ` on ${e.slice_id}` : ""}: ${e.body}` })),
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
	const work = inFlight.filter((w) => w.workload.id !== STANDING_WORKLOAD_ID && (!opts.workloadId || w.workload.id === opts.workloadId));
	out.push("");
	if (work.length === 0) out.push("## open workloads\nnone");
	for (const w of work) {
		out.push(renderWorkload(ledger, w, opts.lastN));
		out.push("");
	}
	return { text: out.join("\n").trimEnd(), lines, identity, inFlight };
}
