// Authored display metadata for pending rows (PLAN wl-mv7gidggnlkem8 § Settled core contract): a
// workload's plain work name and a question's plain ask, each stored as one `assumption` control entry,
// with no schema change. `work-name: {"name","sourceHash"}` sits on the workload it names;
// `question-pending: {"questionId","ask"[,"name"],"sourceHash"}` sits on the question's workload, on its
// slice. Both prefixes are reserved (surface/src/launch.ts CONTROL_PREFIXES, WRITERS []): no lane tool
// can write them, `controlEntries` never returns them, and `doneBecause` and the decision log skip them.
// This module is their only reader and their only writer.
//
// Trust: an entry counts only when it is an `assumption`, its author is the source row's creator or the
// surface (SURFACE_BY, the missing-only importer), its body is the exact serialization below, it names
// the source it describes, its `sourceHash` is the SHA-256 of that source as it stands now, and its value
// passes the same validation as a new one. The first such entry wins; a later one never relabels. There
// is no origin flag to forge: creation writes metadata in the source's own transaction, and the import
// only fills gaps.
//
// Binding: a question bound to a workload (its own, or the standing question's `question-about:`
// subject) inherits that workload's name and carries none; only an unbound orchestrator question on the
// standing workload carries a name. The standing workload's name is fixed here, never written.
import { createHash } from "node:crypto";
import type { Ledger, QuestionRow, WorkloadRow } from "../../ledger/src/index";
import { questionSubject } from "./orchestrator-question";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

export const WORK_NAME_PREFIX = "work-name:";
export const QUESTION_PENDING_PREFIX = "question-pending:";
/** The standing workload's fixed, machine-authored display name: read for its id, never stored. */
export const STANDING_WORK_NAME = "Orchestrator decisions";
export const NAME_MAX = 80;
export const ASK_MAX = 320;

/** A workload's name. `sourceHash` and `entryId` are null only for the standing workload's fixed name. */
export interface WorkDetails {
	name: string;
	sourceHash: string | null;
	entryId: string | null;
}
/** A question's authored ask; `name` only on an unbound orchestrator question. */
export interface QuestionDetails {
	ask: string;
	name?: string;
	sourceHash: string;
	entryId: string;
}

// ---- validation ---------------------------------------------------------------------------------

/** Unicode Cc (controls, newlines included), Cf (bidi and zero-width formats), Zl and Zp: nothing that hides, reorders or breaks a line. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A whole value that is only a ledger id (`wl-…`, `q-…`, `en-…` and the other row kinds). */
const OPAQUE_ID = /^(?:wl|sl|msg|q|in|rt|en)-[a-z0-9-]+$/i;

function lineProblem(what: string, value: string, max: number): string | null {
	const n = [...value].length;
	if (n < 1 || n > max) return `${what} is 1 to ${max} characters (Unicode code points); this one has ${n}.`;
	if (value !== value.trim()) return `${what} has no leading or trailing space.`;
	const hidden = HIDDEN.exec(value);
	if (hidden) {
		const cp = hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
		return `${what} is one plain line: it carries U+${cp}, a control, format or line/paragraph separator character.`;
	}
	if (value.includes("```") || value.includes("~~~")) return `${what} carries no code fence (\`\`\` or ~~~).`;
	return null;
}

/** Why `name` is not a valid work name (1–80 code points, one plain line, no fence, not an opaque id), or null. */
export function nameProblem(name: string): string | null {
	const p = lineProblem("A work name", name, NAME_MAX);
	if (p !== null) return p;
	return OPAQUE_ID.test(name) ? `A work name is plain words, not an opaque id like ${name}.` : null;
}

/** Why `ask` is not a valid ask (1–320 code points, one plain line ending with ?, no fence), or null. */
export function askProblem(ask: string): string | null {
	const p = lineProblem("An ask", ask, ASK_MAX);
	if (p !== null) return p;
	return ask.endsWith("?") ? null : "An ask is one plain question ending with ?.";
}

/**
 * Why a question's own authored fields are not valid, or null: the ask, and the name rule — a name is
 * required for an `unbound` orchestrator question (about no workload) and refused on a bound one, which
 * inherits its workload's name. Pure: a creator validates with it before its transaction.
 */
export function questionFieldsProblem(input: { ask: string; name?: string; unbound: boolean }): string | null {
	const p = askProblem(input.ask);
	if (p !== null) return p;
	if (input.unbound) return input.name === undefined ? "An orchestrator question about no workload needs a name for the work it decides." : nameProblem(input.name);
	return input.name === undefined ? null : "A question bound to a workload takes that workload's name; a name is only for an orchestrator question about no workload.";
}

// ---- source hashes ------------------------------------------------------------------------------

/** SHA-256 hex of the workload's canonical source fields `[id, brief]`. */
export function workSourceHash(w: Pick<WorkloadRow, "id" | "brief">): string {
	return createHash("sha256").update(JSON.stringify([w.id, w.brief])).digest("hex");
}

/** SHA-256 hex of the question's canonical source fields `[id, workload_id, slice_id, body, options, questionSubject]`, options parsed from their stored JSON array. */
export function questionSourceHash(q: Pick<QuestionRow, "id" | "workload_id" | "slice_id" | "body" | "options">, subject: string | null): string {
	const fields = [q.id, q.workload_id, q.slice_id, q.body, JSON.parse(q.options) as unknown, subject];
	return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** The workload whose name a question inherits: its own, or a standing question's subject; null for an unbound orchestrator question. */
export function boundWorkload(ledger: Ledger, q: Pick<QuestionRow, "id" | "workload_id">): string | null {
	return q.workload_id === STANDING_WORKLOAD_ID ? questionSubject(ledger, q.id) : q.workload_id;
}

// ---- bodies -------------------------------------------------------------------------------------

/** `work-name: {"name":…,"sourceHash":…}`: the exact body of a work-name entry. */
export function workNameBody(v: { name: string; sourceHash: string }): string {
	return `${WORK_NAME_PREFIX} ${JSON.stringify({ name: v.name, sourceHash: v.sourceHash })}`;
}

/** `question-pending: {"questionId":…,"ask":…[,"name":…],"sourceHash":…}`: the exact body of a question-details entry. */
export function questionDetailsBody(v: { questionId: string; ask: string; name?: string; sourceHash: string }): string {
	const value = v.name === undefined
		? { questionId: v.questionId, ask: v.ask, sourceHash: v.sourceHash }
		: { questionId: v.questionId, ask: v.ask, name: v.name, sourceHash: v.sourceHash };
	return `${QUESTION_PENDING_PREFIX} ${JSON.stringify(value)}`;
}

function jsonAfter(prefix: string, body: string): Record<string, unknown> | null {
	if (!body.startsWith(`${prefix} `)) return null;
	try {
		const v: unknown = JSON.parse(body.slice(prefix.length + 1));
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The value of a work-name body, only when the body is exactly its own serialization. */
function parseWorkName(body: string): { name: string; sourceHash: string } | null {
	const v = jsonAfter(WORK_NAME_PREFIX, body);
	if (!v || typeof v.name !== "string" || typeof v.sourceHash !== "string") return null;
	const out = { name: v.name, sourceHash: v.sourceHash };
	return workNameBody(out) === body ? out : null;
}

/** The value of a question-details body, only when the body is exactly its own serialization. */
function parseQuestionDetails(body: string): { questionId: string; ask: string; name?: string; sourceHash: string } | null {
	const v = jsonAfter(QUESTION_PENDING_PREFIX, body);
	if (!v || typeof v.questionId !== "string" || typeof v.ask !== "string" || typeof v.sourceHash !== "string") return null;
	if (v.name !== undefined && typeof v.name !== "string") return null;
	const out = v.name === undefined
		? { questionId: v.questionId, ask: v.ask, sourceHash: v.sourceHash }
		: { questionId: v.questionId, ask: v.ask, name: v.name as string, sourceHash: v.sourceHash };
	return questionDetailsBody(out) === body ? out : null;
}

// ---- readers ------------------------------------------------------------------------------------

/**
 * The workload's name: the standing workload's fixed name, else its first trusted, current-hash,
 * valid `work-name:` entry, else null. Reads only; a read-only ledger serves.
 */
export function workName(ledger: Ledger, workloadId: string): WorkDetails | null {
	if (workloadId === STANDING_WORKLOAD_ID) return { name: STANDING_WORK_NAME, sourceHash: null, entryId: null };
	const w = ledger.workload(workloadId);
	if (!w) return null;
	const hash = workSourceHash(w);
	for (const e of ledger.entries(workloadId, "assumption")) {
		if (e.created_by !== w.created_by && e.created_by !== SURFACE_BY) continue;
		const v = parseWorkName(e.body);
		if (v && v.sourceHash === hash && nameProblem(v.name) === null) return { name: v.name, sourceHash: hash, entryId: e.id };
	}
	return null;
}

/**
 * The question's authored details: its first trusted, current-hash, valid `question-pending:` entry
 * naming it, with the name present exactly when the question is unbound; else null. Reads only.
 */
export function questionDetails(ledger: Ledger, questionId: string): QuestionDetails | null {
	const q = ledger.question(questionId);
	if (!q) return null;
	const subject = questionSubject(ledger, q.id);
	const unbound = q.workload_id === STANDING_WORKLOAD_ID && subject === null;
	const hash = questionSourceHash(q, subject);
	for (const e of ledger.entries(q.workload_id, "assumption")) {
		if (e.created_by !== q.created_by && e.created_by !== SURFACE_BY) continue;
		const v = parseQuestionDetails(e.body);
		if (!v || v.questionId !== q.id || v.sourceHash !== hash) continue;
		if (questionFieldsProblem({ ask: v.ask, name: v.name, unbound }) !== null) continue;
		return v.name === undefined ? { ask: v.ask, sourceHash: hash, entryId: e.id } : { ask: v.ask, name: v.name, sourceHash: hash, entryId: e.id };
	}
	return null;
}

/**
 * Every live target still lacking valid authored metadata, in the ledger's in-flight order:
 * each open nonstanding workload with no work name, then each open question on it with no details.
 * This is the core import contract, not the display gaps in `pendingCoverage`: a machine
 * question can have no authored ask yet still show a fixed ask from its offered options.
 */
export function missingDescriptions(ledger: Ledger): string[] {
	const out: string[] = [];
	for (const f of ledger.inFlight()) {
		if (f.workload.id !== STANDING_WORKLOAD_ID && workName(ledger, f.workload.id) === null) out.push(f.workload.id);
		for (const q of f.openQuestions) if (questionDetails(ledger, q.id) === null) out.push(q.id);
	}
	return out;
}

// ---- creator writers ----------------------------------------------------------------------------

/**
 * The workload's name, written by its creator (`by` is the workload row's `created_by`) — in the
 * creator's own transaction when called inside one. Validates first; writes only when no valid
 * current metadata stands; the same name again is a no-op; a different one is refused. The standing
 * workload's name is fixed and never written. Throws on every refusal, writing nothing.
 */
export function recordWorkName(ledger: Ledger, input: { workloadId: string; by: string; name: string }): void {
	const problem = nameProblem(input.name);
	if (problem !== null) throw new Error(problem);
	if (input.workloadId === STANDING_WORKLOAD_ID) throw new Error(`${STANDING_WORKLOAD_ID} has the fixed name "${STANDING_WORK_NAME}"; nothing was written.`);
	ledger.write(() => {
		const w = ledger.workload(input.workloadId);
		if (!w || w.status !== "open") throw new Error(`no open workload ${input.workloadId}; nothing was written.`);
		if (input.by !== w.created_by) throw new Error(`only ${w.created_by}, which opened ${w.id}, names it; nothing was written.`);
		const existing = workName(ledger, w.id);
		if (existing !== null) {
			if (existing.name === input.name) return;
			throw new Error(`${w.id} is already named "${existing.name}" (${existing.entryId}); a name is never replaced.`);
		}
		ledger.recordEntry({ by: input.by, workloadId: w.id, kind: "assumption", body: workNameBody({ name: input.name, sourceHash: workSourceHash(w) }) });
	});
}

/**
 * The question's authored ask (and, unbound only, its name), written by its creator (`by` is the
 * question row's `created_by`) on the question's workload and slice — in the creator's own
 * transaction when called inside one, after any `question-about:` subject entry, which the hash
 * covers. A missing name on the bound workload is no obstacle. Writes only when no valid current
 * metadata stands; identical details again are a no-op; different ones are refused. Throws on every
 * refusal, writing nothing.
 */
export function recordQuestionDetails(ledger: Ledger, input: { questionId: string; by: string; ask: string; name?: string }): void {
	const own = askProblem(input.ask) ?? (input.name === undefined ? null : nameProblem(input.name));
	if (own !== null) throw new Error(own);
	ledger.write(() => {
		const q = ledger.question(input.questionId);
		if (!q || q.state !== "open") throw new Error(`no open question ${input.questionId}; nothing was written.`);
		if (input.by !== q.created_by) throw new Error(`only ${q.created_by}, which raised ${q.id}, describes it; nothing was written.`);
		const subject = questionSubject(ledger, q.id);
		const binding = questionFieldsProblem({ ask: input.ask, name: input.name, unbound: q.workload_id === STANDING_WORKLOAD_ID && subject === null });
		if (binding !== null) throw new Error(binding);
		const existing = questionDetails(ledger, q.id);
		if (existing !== null) {
			if (existing.ask === input.ask && existing.name === input.name) return;
			throw new Error(`${q.id} already has its ask (${existing.entryId}); details are never replaced.`);
		}
		const body = questionDetailsBody({ questionId: q.id, ask: input.ask, name: input.name, sourceHash: questionSourceHash(q, subject) });
		ledger.recordEntry({ by: input.by, workloadId: q.workload_id, sliceId: q.slice_id, kind: "assumption", body });
	});
}

// ---- missing-only import ------------------------------------------------------------------------

export interface PendingImport {
	by: string;
	workloads: { id: string; sourceHash: string; name: string }[];
	questions: { id: string; sourceHash: string; ask: string; name?: string }[];
}
/** `filled`: written now; `skipped`: submitted but closed, gone or already described (never relabelled); `missing`: raw authored-metadata absence after import (`missingDescriptions`), not pendingCoverage's rendered display gaps. */
export interface PendingImportResult {
	filled: string[];
	skipped: string[];
	missing: string[];
}

const HASH = /^[0-9a-f]{64}$/;

/** Shape and value problems of the submitted entries, before any ledger read (the manifest is JSON from a file, so its types are checked too). */
function submissionProblems(input: PendingImport): string[] {
	if (!Array.isArray(input.workloads) || !Array.isArray(input.questions)) return ["workloads and questions are both arrays"];
	const problems: string[] = [];
	const seen = new Set<string>();
	const str = (v: unknown): v is string => typeof v === "string";
	const id = (v: unknown, what: string): string | null => {
		if (!str(v) || v === "") {
			problems.push(`a submitted ${what} has no id`);
			return null;
		}
		if (seen.has(v)) problems.push(`${v} is submitted twice`);
		seen.add(v);
		return v;
	};
	for (const w of input.workloads) {
		const at = id(w?.id, "workload");
		if (at === null) continue;
		if (at === STANDING_WORKLOAD_ID) problems.push(`${at} has the fixed name "${STANDING_WORK_NAME}" and takes no import`);
		if (!str(w.sourceHash) || !HASH.test(w.sourceHash)) problems.push(`${at}: sourceHash is not a SHA-256 hex digest`);
		const p = str(w.name) ? nameProblem(w.name) : "A work name is a string.";
		if (p !== null) problems.push(`${at}: ${p}`);
	}
	for (const q of input.questions) {
		const at = id(q?.id, "question");
		if (at === null) continue;
		if (!str(q.sourceHash) || !HASH.test(q.sourceHash)) problems.push(`${at}: sourceHash is not a SHA-256 hex digest`);
		const p = (str(q.ask) ? askProblem(q.ask) : "An ask is a string.") ?? (q.name === undefined ? null : str(q.name) ? nameProblem(q.name) : "A work name is a string.");
		if (p !== null) problems.push(`${at}: ${p}`);
	}
	return problems;
}

/**
 * Fill missing metadata from a reviewed manifest, as the surface only. Every submitted value and
 * live target is checked before the first write, in one transaction: a live submitted target whose
 * source hash differs, an invalid value or a name against the binding rule refuses the whole
 * submitted set, writing nothing. A closed or gone target, and one already described (identically or
 * not), is skipped: metadata is never replaced. Live targets nobody submitted are reported in
 * `missing` and refuse nothing.
 */
export function importPendingDescriptions(ledger: Ledger, input: PendingImport): PendingImportResult {
	if (input.by !== SURFACE_BY) throw new Error(`only the orchestrator surface (${SURFACE_BY}) imports pending descriptions; nothing was written.`);
	const shape = submissionProblems(input);
	if (shape.length > 0) throw new Error(`pending descriptions refused, nothing was written: ${shape.join("; ")}`);
	return ledger.write(() => {
		const problems: string[] = [];
		const skipped: string[] = [];
		const writes: { id: string; workloadId: string; sliceId: string | null; body: string }[] = [];
		for (const s of input.workloads) {
			const w = ledger.workload(s.id);
			if (!w || w.status !== "open") {
				skipped.push(s.id);
				continue;
			}
			const hash = workSourceHash(w);
			if (hash !== s.sourceHash) problems.push(`${s.id}: its source changed since the manifest (hash ${hash})`);
			else if (workName(ledger, s.id) !== null) skipped.push(s.id);
			else writes.push({ id: s.id, workloadId: s.id, sliceId: null, body: workNameBody({ name: s.name, sourceHash: hash }) });
		}
		for (const s of input.questions) {
			const q = ledger.question(s.id);
			if (!q || q.state !== "open") {
				skipped.push(s.id);
				continue;
			}
			const subject = questionSubject(ledger, q.id);
			const hash = questionSourceHash(q, subject);
			const binding = questionFieldsProblem({ ask: s.ask, name: s.name, unbound: q.workload_id === STANDING_WORKLOAD_ID && subject === null });
			if (hash !== s.sourceHash) problems.push(`${s.id}: its source changed since the manifest (hash ${hash})`);
			else if (binding !== null) problems.push(`${s.id}: ${binding}`);
			else if (questionDetails(ledger, s.id) !== null) skipped.push(s.id);
			else writes.push({ id: s.id, workloadId: q.workload_id, sliceId: q.slice_id, body: questionDetailsBody({ questionId: q.id, ask: s.ask, name: s.name, sourceHash: hash }) });
		}
		if (problems.length > 0) throw new Error(`pending descriptions refused, nothing was written: ${problems.join("; ")}`);
		for (const x of writes) ledger.recordEntry({ by: SURFACE_BY, workloadId: x.workloadId, sliceId: x.sliceId, kind: "assumption", body: x.body });
		return { filled: writes.map((x) => x.id), skipped, missing: missingDescriptions(ledger) };
	});
}
