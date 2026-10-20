// Jo's words on a forgery hit (PLAN wl-mvfxw3c4zqfzls D5), interpreted by surface/src/input.ts like `approve en-…`:
//
// - `confirm <row id>`: the row was Jo's. Jo's instruction `confirm <row id>`, then the surface's `forgery-confirmed: <row id> by
//   <in-…>` naming it, on the flagged row's workload while it is open, else on the standing workload (`forgeryPlacement`). The
//   check never flags the row again, and the hold lifts once no hit on the workload is unanswered. When that was the last one,
//   the workload is open and the hold stopped an autonomous lane that has not come back (a `forgery-hold` stop request with no
//   `launch:` attempt after it), Jo's `launch-requested:` too, so the lane comes back as Jo's `go` brings it (N8).
// - `reverse <row id>`: the row was not Jo's. Jo's instruction `reverse <row id>`, then `forgery-reversed: <row id> by <in-…>`
//   (ledger/src/jo-channel.ts) in the same placement, then what D5's table undoes. A control entry and a `repo:` entry need no
//   write: `controlEntries` and `repoOf` skip a reversed id. An instruction of any kind leaves every decision read
//   (`Ledger.instructions`); a reversed answer or withdrawal also voids its companions, the surface's entries that name it
//   (`plan: approved <answer>`, `pair-taken: … by <answer>`, `ceiling: … by <answer>`, `review-rounds-extend: … by <answer>`),
//   each by its own `forgery-reversed:`, so every reader skips it as `controlEntries` does. A reversed answer or `replan`
//   withdrawal is no resolution (`resolutions` reads the filtered rows), so its question is re-asked on the same slice, same
//   body and options, stamped as the original asker, while the slice is open or paused; every role entry naming the old
//   question (`QUESTION_ROLES`) is written again naming the new one, by the same writer, so the re-asked question keeps its
//   role (the plan question stays the plan question). A reversed mode-flip gets Jo's compensating flip to the mode the
//   workload has without it (the newest kept flip, later ones included), only when that differs from the mode now. What
//   cannot be undone is named in the receipt: a `cancel` withdrawal (a cancelled slice is terminal; a deferred one still
//   fires, ledger/schema.sql `questions_resolution_settles_slice`), the launches and boardings the row led to
//   (`consequences`: the lane's commits, pushes and spend, the merge), and anything on a closed workload.
// A row id no recorded hit names, or a hit Jo already answered, is refused, never applied and never prose.
import { forgeryReversedBody, joForgeryAnswer, reversedRowIds, surfaceMarks } from "../../ledger/src/jo-channel";
import type { InstructionRow, Ledger, Mode } from "../../ledger/src/index";
import { consequences, deferredCancels, forgeryPlacement, hitWorkloads, holdStops, type RecordedHit, recordedHits, unansweredHits } from "./forgery-hold";
import { modeFlipControl } from "./input";
import { attempts, type ControlEntry, controlEntries, forgeryConfirmedBody, holdersOf, launchRequestedBody } from "./launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

/** The two words, first word of the line. */
export const FORGERY_WORDS = ["confirm", "reverse"] as const;
export type ForgeryWord = (typeof FORGERY_WORDS)[number];

/**
 * Jo's word on the recorded hit of `rowId`: `workloadId` is the flagged row's workload, `on` where the answer is written
 * (`workloadId` while it is open, else the standing workload).
 */
export type ForgeryWordCommand =
	| { kind: "forgery-confirm"; workloadId: string; on: string; rowId: string }
	| { kind: "forgery-reverse"; workloadId: string; on: string; rowId: string };

/** A row id the check can flag: an instruction or an entry. */
const ROW_ID = /^(in|en)-\S+$/i;

/** The recorded hit naming `rowId`, on whichever workload holds it, or null. */
export function hitFor(ledger: Ledger, rowId: string): RecordedHit | null {
	for (const wl of hitWorkloads(ledger)) {
		const h = recordedHits(ledger, wl).find((x) => x.rowId === rowId);
		if (h) return h;
	}
	return null;
}

/** Why `word <rowId>` cannot apply, or null: a recorded hit names the row and Jo has not answered it. `apply` checks it again. */
function refusalOf(word: ForgeryWord, rowId: string, hit: RecordedHit | null): string | null {
	if (hit === null) return `no recorded forgery hit names ${rowId}: \`${word} <row id>\` answers a flagged row on the needs-you list`;
	if (hit.answer !== null) return `${rowId} is already ${hit.answer.kind} (entry ${hit.answer.entryId}); a hit takes one answer`;
	return null;
}

/**
 * `confirm <row id>` / `reverse <row id>` after the word: the command, or `refused` with the reason; null when the line is not this
 * command (the word alone, or with an id that is no instruction or entry: `confirm q-…` still answers a question offering it).
 */
export function forgeryWordCommand(ledger: Ledger, word: string, rest: readonly string[]): ForgeryWordCommand | { kind: "refused"; why: string } | null {
	if (word !== "confirm" && word !== "reverse") return null;
	if (rest.length === 0 || !ROW_ID.test(rest[0]!)) return null;
	if (rest.length > 1) return { kind: "refused", why: `${word} names one flagged row: ${word} <row id>` };
	const rowId = rest[0]!;
	const hit = hitFor(ledger, rowId);
	const why = refusalOf(word, rowId, hit);
	if (why !== null) return { kind: "refused", why };
	const on = forgeryPlacement(ledger, hit!.workloadId);
	return { kind: word === "confirm" ? "forgery-confirm" : "forgery-reverse", workloadId: hit!.workloadId, on, rowId };
}

/** A workload's valid control entries, every holder counted. */
function controlOf(ledger: Ledger, wl: string): ControlEntry[] {
	const entries = ledger.entries(wl);
	return controlEntries(entries, holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl)));
}

/**
 * Apply Jo's `confirm` or `reverse` in one transaction: the hit and its answer checked again (a refusal throws, writing nothing),
 * Jo's instruction and the surface's answer entry naming it, then the confirm's relaunch or the reversal's compensations.
 * Returns the receipt.
 */
export function applyForgeryWord(ledger: Ledger, cmd: ForgeryWordCommand): string {
	const word: ForgeryWord = cmd.kind === "forgery-confirm" ? "confirm" : "reverse";
	return ledger.write(() => {
		const hit = hitFor(ledger, cmd.rowId);
		const why = refusalOf(word, cmd.rowId, hit);
		if (why !== null) throw new Error(why);
		const on = forgeryPlacement(ledger, hit!.workloadId);
		const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
		const inId = ledger.recordInstruction({ ...stamp, workloadId: on, body: `${word} ${cmd.rowId}` });
		return word === "confirm" ? confirm(ledger, hit!, on, inId) : reverse(ledger, hit!, on, inId);
	});
}

/** The confirm's writes after Jo's instruction `inId`; returns the receipt. */
function confirm(ledger: Ledger, hit: RecordedHit, on: string, inId: string): string {
	const wl = hit.workloadId;
	const entryId = ledger.recordEntry({ by: SURFACE_BY, workloadId: on, kind: "assumption", body: forgeryConfirmedBody(hit.rowId, inId) });
	const head = `confirmed ${hit.rowId} on ${wl} as yours (instruction ${inId}, forgery-confirmed ${entryId})`;
	const left = unansweredHits(ledger, wl);
	if (left.length > 0) return `${head}; ${wl} stays held: ${left.length} flagged ${left.length === 1 ? "row" : "rows"} unanswered (${left.map((h) => h.rowId).join(", ")})`;
	if (on !== wl) return `${head}; ${wl} is closed: nothing held it but the boarding refusal, now lifted`;
	const control = controlOf(ledger, wl);
	const tried = attempts(control);
	const stopped = holdStops(control).filter((s) => !tried.some((a) => a.createdAt > s.createdAt));
	if (stopped.length === 0) return `${head}; the hold on ${wl} is lifted`;
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), "forgery confirmed") });
	const lanes = [...new Set(stopped.map((s) => s.laneId).filter((l) => l !== null))].join(", ");
	return `${head}; the hold on ${wl} is lifted, and it had stopped ${lanes}, so a relaunch is requested`;
}

/**
 * The surface's compensating mode-flip of reversed flip `reversed`: its entry `mode-compensation: <flip id> reverses <row id>`,
 * a jo-only prefix (ledger/src/authority.ts), so the surface's connection marks it, F1 flags an unmarked one and F5 one from
 * another writer. It is written beside the flip (the flip's body stays the bare mode every reader of `mode-flip` instructions reads).
 */
function modeCompensationBody(flipId: string, reversed: string): string {
	return `mode-compensation: ${flipId} reverses ${reversed}`;
}

const MODE_COMPENSATION = /^mode-compensation:\s+(in-\S+)\s+reverses\s+(\S+)$/;

/**
 * The mode `wl` has with every reversed mode-flip and every compensating flip left out: the newest flip Jo made and kept, else
 * the mode it opened with. A flip is a compensation only when all three hold: the `mode-compensation:` entry naming it is
 * surface-stamped and surface-marked; the flip is a surface-marked mode-flip instruction; and Jo's `forgery-reversed:`
 * (`joForgeryAnswer`) names the row the entry says it reverses. Anything less is no compensation, so the flip stays Jo's choice.
 */
function effectiveMode(ledger: Ledger, wl: string): Mode | null {
	const provenance = ledger.provenance(wl);
	const markedEntries = surfaceMarks(provenance, "entries");
	const markedFlips = surfaceMarks(provenance, "instructions");
	const entries = ledger.entries(wl, "assumption");
	const reversedByJo = new Set<string>();
	for (const e of entries) {
		const a = joForgeryAnswer(e, markedEntries);
		if (a?.word === "reversed") reversedByJo.add(a.rowId);
	}
	const instructions = ledger.instructions(wl, { withReversed: true });
	const compensations = new Set<string>();
	for (const e of entries) {
		const m = e.created_by === SURFACE_BY && markedEntries.has(e.id) ? MODE_COMPENSATION.exec(e.body.trim()) : null;
		if (!m || !markedFlips.has(m[1]!) || !reversedByJo.has(m[2]!)) continue;
		if (instructions.some((i) => i.id === m[1] && i.kind === "mode-flip" && i.created_by === SURFACE_BY)) compensations.add(m[1]!);
	}
	const last = ledger.instructions(wl).findLast((i) => i.kind === "mode-flip" && !compensations.has(i.id));
	if (last) return last.body as Mode;
	const opened = provenance.find((p) => p.tbl === "workloads" && p.action === "insert");
	const m = opened ? / mode=(autonomous|user-driven)\b/.exec(opened.detail ?? "") : null;
	return m ? (m[1] as Mode) : null;
}

/**
 * The role entries keyed by a question id, the first token after the prefix: the plan question (`plan-question:`, a holder's,
 * surface/src/launch.ts isPlanQuestionIn), the round-limit and park questions (`review-limit:`, `review-park:`, the
 * classifier's), the pair offer (`pair-offer:`, its site's raiser) and the orchestrator question's subject (`question-about:`,
 * the surface's). Each reader matches the question by that id and checks the entry's writer, so a copy by the same writer
 * holds the role for the new id exactly when the original held it for the old one.
 */
const QUESTION_ROLES = /^(plan-question|review-limit|review-park|pair-offer|question-about):\s+(q-\S+)(.*)$/;

/** Write every unreversed role entry of `wl` naming question `from` again naming `to`, by its own writer; returns their prefixes. */
function copyRoles(ledger: Ledger, wl: string, from: string, to: string): string[] {
	const entries = ledger.entries(wl, "assumption");
	const reversed = reversedRowIds(entries);
	const out: string[] = [];
	for (const e of entries) {
		const m = reversed.has(e.id) ? null : QUESTION_ROLES.exec(e.body.trim());
		if (!m || m[2] !== from) continue;
		ledger.recordEntry({ by: e.created_by, workloadId: wl, sliceId: e.slice_id, kind: "assumption", body: `${m[1]}: ${to}${m[3]}` });
		out.push(`${m[1]}:`);
	}
	return out;
}

/**
 * The reference field of a companion the answer's transaction writes (input.ts apply, applyPair; surface/src/ceiling.ts,
 * pair-suggest.ts, launch.ts and classifier/src/rounds.ts bodies): the answer id `plan: approved <answer>`,
 * `pair-taken: <q> by <answer> …`, `ceiling: … by <answer>` and `review-rounds-extend: <sl> +<n> by <answer>` name, or null.
 */
function companionAnswerId(body: string): string | null {
	const m =
		/^plan:\s+approved\s+(\S+)$/.exec(body) ??
		/^pair-taken:\s+\S+\s+by\s+(\S+)(?:\s.*)?$/.exec(body) ??
		/^ceiling:\s.*\sby\s+(\S+)$/.exec(body) ??
		/^review-rounds-extend:\s+\S+\s+\+\d+\s+by\s+(\S+)$/.exec(body);
	return m ? m[1]! : null;
}

/**
 * Void the companions of the reversed answer or withdrawal `insId`: each unreversed surface entry of `wl` of a known companion
 * form naming `insId` at its reference field, Jo's forgery answers aside, gets its own
 * `forgery-reversed: <entry> by <inId>`, which `controlEntries` and every reader of reversed ids skip. Returns `<prefix>: <id>`.
 */
function voidCompanions(ledger: Ledger, wl: string, insId: string, inId: string): string[] {
	const entries = ledger.entries(wl, "assumption");
	const reversed = reversedRowIds(entries);
	const out: string[] = [];
	for (const e of entries) {
		const body = e.body.trim();
		if (e.created_by !== SURFACE_BY || reversed.has(e.id) || companionAnswerId(body) !== insId) continue;
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: forgeryReversedBody(e.id, inId) });
		out.push(`${/^([a-z-]+):/.exec(body)?.[1] ?? "entry"}: ${e.id}`);
	}
	return out;
}

/**
 * What reversing the instruction `ins` of open workload `wl` by Jo's instruction `inId` does beyond voiding it, as receipt
 * parts; `undone` gathers what cannot be.
 */
function reverseInstruction(ledger: Ledger, wl: string, ins: InstructionRow, inId: string, undone: string[]): string[] {
	if (ins.kind === "mode-flip") {
		// The reversal entry is already written, so `effectiveMode` leaves `ins` out and keeps every later flip.
		const mode = effectiveMode(ledger, wl);
		const now = ledger.workload(wl)!.mode;
		if (mode === null || mode === now) return [`mode-flip ${ins.id} voided; ${wl} is ${now} without it, so no flip back`];
		const flip = ledger.flipMode(wl, { by: SURFACE_BY, author: "jo", channel: "surface", mode });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: modeCompensationBody(flip, ins.id) });
		return [`mode on ${wl} flipped back ${now} → ${mode} (mode-flip ${flip})${modeFlipControl(ledger, wl, mode)}`];
	}
	if (ins.kind === "instruction") return [`instruction ${ins.id} voided for every decision reader`];
	const companions = voidCompanions(ledger, wl, ins.id, inId);
	const voided = companions.length > 0 ? `; its companion ${companions.join(", ")} voided for every reader` : "";
	const q = ins.question_id ? ledger.question(ins.question_id) : null;
	const slice = q ? ledger.slice(q.slice_id) : null;
	if (!q || !slice) return [`${ins.kind} ${ins.id} voided for every decision reader${voided}`];
	if (ins.kind === "withdrawal" && ins.disposition === "cancel") {
		const deferred = deferredCancels(ledger, wl).find((d) => d.rowId === ins.id);
		if (deferred) {
			undone.push(`the cancel of ${slice.id} is deferred and still fires: resolving ${deferred.questionIds.join(" or ")} cancels ${slice.id} (ledger/schema.sql questions_resolution_settles_slice); re-cut the slice to keep its work`);
		} else {
			undone.push(`withdrawal ${ins.id} cancelled ${slice.id}, and a cancelled slice stays cancelled; re-cut the slice to keep its work`);
		}
		return [`withdrawal ${ins.id} voided for every decision reader${voided}`];
	}
	if (slice.state !== "open" && slice.state !== "paused") {
		undone.push(`${q.id} cannot be re-asked: ${slice.id} is ${slice.state}`);
		return [`${ins.kind} ${ins.id} voided for every decision reader${voided}`];
	}
	const asked = ledger.raiseQuestion({ by: q.created_by, workloadId: wl, sliceId: slice.id, body: q.body, options: JSON.parse(q.options) as string[] });
	const roles = copyRoles(ledger, wl, q.id, asked);
	const role = roles.length > 0 ? `, its role (${roles.join(", ")}) carried to it` : "";
	return [`${ins.kind} ${ins.id} to ${q.id} voided${voided}; re-asked as ${asked} on ${slice.id}, as ${q.created_by} asked it${role}`];
}

/** The reversal's writes after Jo's instruction `inId`; returns the receipt. */
function reverse(ledger: Ledger, hit: RecordedHit, on: string, inId: string): string {
	const wl = hit.workloadId;
	const ins = ledger.instructions(wl, { withReversed: true }).find((i) => i.id === hit.rowId) ?? null;
	const entryId = ledger.recordEntry({ by: SURFACE_BY, workloadId: on, kind: "assumption", body: forgeryReversedBody(hit.rowId, inId) });
	const parts = [`reversed ${hit.rowId} on ${wl} as not yours (instruction ${inId}, forgery-reversed ${entryId})`];
	const undone: string[] = [];
	if (on !== wl) {
		parts.push(`${wl} is closed: the reversal is recorded on ${STANDING_WORKLOAD_ID} and nothing in the ledger is undone; boarding stays refused`);
		undone.push(`the close of ${wl}`);
	} else if (ins !== null) {
		parts.push(...reverseInstruction(ledger, wl, ins, inId, undone));
	} else {
		const e = ledger.entry(hit.rowId);
		const prefix = e ? /^([a-z-]+):/.exec(e.body.trim())?.[1] : undefined;
		parts.push(`${prefix ? `${prefix}: ` : ""}entry ${hit.rowId} voided for every control reader${prefix === "repo" ? " and the decision log's repo read" : ""}`);
	}
	for (const c of consequences(ledger, hit)) {
		undone.push(c.startsWith("launched ") ? `${c}: that lane's commits, pushes and spend stay` : `${c}: its merge stays`);
	}
	const left = on === wl ? unansweredHits(ledger, wl) : [];
	const hold = left.length > 0 ? `; ${wl} stays held: ${left.length} flagged ${left.length === 1 ? "row" : "rows"} unanswered (${left.map((h) => h.rowId).join(", ")})` : "";
	return `${parts.join("; ")}${undone.length > 0 ? `; cannot be undone: ${undone.join("; ")}` : ""}${hold}`;
}
