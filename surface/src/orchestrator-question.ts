// The orchestrator's questions to Jo as ledger rows (MIGRATION.md item 105). Every question the
// orchestrator puts to Jo is first a `questions` row on the standing slice (surface/src/identity.ts
// `standingSlice`), raised by `orchestrator_raise_question` (surface/extensions/question.ts), so the
// row exists before Jo sees the ask, the needs-you render (surface/src/errors.ts) and the invariant
// report's `stuck-question` (surface/scripts/invariants.ts) see it, and a restart re-renders it.
// P-11 row 15 (gates/src/rows/r15-orchestrator-role.ts) refuses the reply that publishes a closing ask
// naming no open row on the standing slice, and the orchestrator's next working call while a named
// row is still open.
//
// An ask is usually *about* another workload, whose lanes read decisions from their own workload.
// The `questions` table has no spare column (ledger/schema.sql) and the body is Jo's reading matter,
// never metadata (Codex review of PR #55, S1: a body starting `about wl-…:` used to be read as a
// subject), so the subject is its own row: an `assumption` entry by the surface on the standing
// workload, `question-about: <q-…> <wl-…>`, written in the raise's transaction (`raiseOrchestratorQuestion`)
// and the one place creation, rendering and answering read it from (`questionSubject`). A body
// starting with the old prefix is refused at creation. Jo's answer resolves the row and, in the
// same transaction, writes a plain `instruction` row by Jo on the subject workload
// (`Ledger.answerQuestionMirrored`), which is what the subject's lanes and row 15's answer-first
// reading see. A subject that cannot take the mirror (closed, gone) refuses the answer and leaves
// the question open (review B4): only a question with no subject answers standalone. Both answer
// paths — Jo's `<option> q-…` word at the surface (surface/src/input.ts `apply`) and the recorder
// for an answer in prose (`orchestrator_record_instruction` naming the question and Jo's input row)
// — go through `answerOrchestratorQuestion`. A withdrawal on the standing slice always replans
// (`apply`): a `cancel` would cancel the slice (schema.sql questions_resolution_settles_slice) and
// no orchestrator question could be raised again.
//
// The raise goes through Jo's standing rulings (gates/src/rulings.ts `askJo`, PLAN wl-mvfkv7llkp7nk0 § 1): a question a
// ruling decides writes no row and no subject entry, only the surface's `ruling-applied:` on the standing slice. An ask
// with `now` (PLAN wl-mvg1vs0rhnu3gg § 1.0) skips the rulings; an ask repeating an open one returns its id as reused and
// writes no second subject entry (§ 3.5). The tool refuses a relay, a body naming another workload's open question
// (`relayedQuestion`): that question is already on Jo's needs-you list.
import { type AskResult, askJo, type ModelSubject, type NowCategory } from "../../gates/src/rulings";
import type { InstructionRow, Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload, standingSlice } from "./identity";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

/** The old in-body subject form, reserved: a body starting so is refused, never stored. */
const RESERVED_PREFIX = /^about wl-[a-z0-9]+:/i;

/** Does `body` start with the reserved `about <wl-…>:` prefix? */
export const reservedQuestionBody = (body: string): boolean => RESERVED_PREFIX.test(body);

/** The subject entry's body: `question-about: <q-…> <wl-…>`. */
export const questionSubjectBody = (questionId: string, about: string): string => `question-about: ${questionId} ${about}`;
const SUBJECT = /^question-about: (q-[a-z0-9]+) (wl-[a-z0-9]+)$/;

/** An id of an open question on a workload other than the standing one that `body` names, or null (PLAN wl-mvg1vs0rhnu3gg § 3.5). */
export function relayedQuestion(ledger: Ledger, body: string): string | null {
	for (const [id] of body.matchAll(/\bq-[a-z0-9]+\b/g)) {
		const q = ledger.question(id);
		if (q !== null && q.state === "open" && q.workload_id !== STANDING_WORKLOAD_ID) return id;
	}
	return null;
}

/** The tool's refusal of a relay; nothing is written. */
export const relayRefusal = (questionId: string): string => `${questionId} is already on Jo's needs-you list; do not relay it. Nothing was asked.`;

/**
 * Raise the orchestrator's question on the standing slice through the standing rulings: the row, and when it is about
 * a workload, the subject entry naming it, in one transaction; or a ruling's decision with neither; or, for an ask
 * repeating an open question about the same workload, that id as reused with no second subject entry. Validation is
 * the tool's; `reviewModel` reads the review row's OpenAI model for a review-model question.
 */
export function raiseOrchestratorQuestion(
	ledger: Ledger,
	input: { body: string; options: string[]; about: string | null; subject?: ModelSubject | null; now?: NowCategory | null },
	reviewModel?: () => string | null,
): AskResult {
	return ledger.write(() => {
		ensureStandingWorkload(ledger);
		const slice = standingSlice(ledger)!;
		const asked = askJo(
			ledger,
			{ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: slice.id, body: input.body, options: input.options, subject: input.subject ?? null, now: input.now ?? null },
			{ asker: "orchestrator", about: input.about, reviewModel },
		);
		if ("raised" in asked && !("reused" in asked) && input.about) {
			ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: slice.id, kind: "assumption", body: questionSubjectBody(asked.raised, input.about) });
		}
		return asked;
	});
}

/** The subject workload of an orchestrator question, from its surface-written subject entry; null when the ask named none. */
export function questionSubject(ledger: Ledger, questionId: string): string | null {
	for (const e of ledger.entries(STANDING_WORKLOAD_ID, "assumption")) {
		if (e.created_by !== SURFACE_BY) continue;
		const m = SUBJECT.exec(e.body);
		if (m && m[1] === questionId) return m[2]!;
	}
	return null;
}

/** A Jo-input row on the standing workload (surface/extensions/surface-input.ts): by the surface, Jo's words, a plain instruction naming no question. */
export const isJoInput = (i: InstructionRow): boolean =>
	i.workload_id === STANDING_WORKLOAD_ID && i.kind === "instruction" && i.author === "jo" && i.channel === "surface" && i.created_by === SURFACE_BY && i.question_id === null;

/** The Jo-input row `inputId` on the standing workload, or null. */
export const joInput = (ledger: Ledger, inputId: string): InstructionRow | null => ledger.instructions(STANDING_WORKLOAD_ID).find((i) => i.id === inputId && isJoInput(i)) ?? null;

/**
 * The reading entry's body: the model's one-line reading of Jo's input, kept apart from Jo's words,
 * naming the input and what it was spent on (`answers q-…` for a question, `instructs wl-…` for a
 * plain instruction on a workload).
 */
export const readingBody = (reading: string, inputId: string, target: string): string =>
	`reading: ${reading} (input ${inputId} ${target.startsWith("q-") ? "answers" : "instructs"} ${target})`;
const READING = /\(input (in-[a-z0-9]+) (?:answers|instructs) ((?:q|wl)-[a-z0-9]+)\)$/;

/** The question or workload `inputId` was already spent on (its reading entry names it), or null while the input is unused. */
export function inputSpent(ledger: Ledger, inputId: string): string | null {
	for (const e of ledger.entries(STANDING_WORKLOAD_ID, "assumption")) {
		if (e.created_by !== SURFACE_BY || !e.body.startsWith("reading: ")) continue;
		const m = READING.exec(e.body);
		if (m && m[1] === inputId) return m[2]!;
	}
	return null;
}

export interface OrchestratorAnswer {
	/** The `answer` instruction resolving the row, on the standing workload. */
	answerId: string;
	/** The subject workload the mirror instruction went on, or null for an ask with no subject. */
	about: string | null;
	/** The mirror `instruction` row by Jo on the subject workload, or null for an ask with no subject. */
	mirrorId: string | null;
}

/**
 * Jo's answer on an orchestrator question: the row resolved by an answer instruction (author jo,
 * channel surface) and, when the ask names a subject workload, the mirror instruction `mirrorBody`
 * on it, both in one transaction. A subject that is closed or gone refuses the whole answer (the
 * thrown Error names it and what Jo can do); the question stays open. No subject: the answer alone.
 */
export function answerOrchestratorQuestion(ledger: Ledger, q: { id: string }, input: { answer: string; mirrorBody: string }): OrchestratorAnswer {
	const stamp = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	return ledger.write(() => {
		const subject = questionSubject(ledger, q.id);
		if (subject === null) return { answerId: ledger.answerQuestion(q.id, { ...stamp, answer: input.answer }), about: null, mirrorId: null };
		const w = ledger.workload(subject);
		if (!w || w.status !== "open") {
			throw new Error(`${q.id} is about ${subject}, which is ${w ? `closed (${w.closed_at})` : "not in the ledger"}: the answer was not recorded and ${q.id} stays open; \`withdraw ${q.id}\` withdraws it`);
		}
		const r = ledger.answerQuestionMirrored(q.id, { ...stamp, answer: input.answer, mirror: { workloadId: subject, body: input.mirrorBody } });
		return { answerId: r.answerId, about: subject, mirrorId: r.mirrorId };
	});
}
