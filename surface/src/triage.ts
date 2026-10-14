// Routine or needs-Jo (PLAN wl-mv66ylg1op3wg0 D3, D4; Jo, in-mv67564pwap534 (a)): every needs-you
// line (surface/src/errors.ts errorLines, numbered by surface/src/numbering.ts) lands in exactly one
// of two lists. `routine` items are the only ones a `send:` line may hold and Jo's `ok` may apply;
// every other line is `needsJo`, with a one-line reason, and is never covered by `ok`.
//
// The recommended word of an answerable row, in order: the orchestrator's latest `recommend: <row-id>
// <word> — <reason>` entry, written by the surface on the row's workload (orchestrator_recommend,
// surface/extensions/send-line.ts; a word that is not one of the row's options is never read); else
// the recommendation pending.ts records (`recommended` / `recordedWhere`); else none.
//
// Fixed rules come first and call no judge: a line with no one-word answer (every ErrorLine kind but
// a waiting reserved request and an open question with options) → its kind; a reserved request →
// `reserved action`; the plan question → `plan approval`; a question with any multiword option → its
// own reason; no recommendation → `no recommendation recorded`. Every other row goes to the judge
// (OMP's judge role, TypeSafe jev in production; a recorded fake in tests) as one choice question,
// surface/triage-question.json, the shape of classifier/kind-question.json. It fails closed: a judge
// throw or a malformed answer → `judge unavailable`; `routine` below ROUTINE_MIN_CONFIDENCE → `judge
// unsure`; any needs-jo choice → that choice's criterion text.
//
// A verdict is ledgered as `triage: <row-id> <choice> <confidence> <provider/model> key <sha256>` by the
// surface on the row's workload. The key hashes every judge input (row id, body, options, word,
// reason, stakes), the question file's sha256 and the judge model; an entry whose key matches the
// one computed for the judge's primary model is reused with no call, and any change re-judges. A
// judge that names no primary model is always called.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { type ErrorKind, type ErrorLine, errorLines } from "./errors";
import { isPlanQuestion } from "./input";
import { answerable, type Numbering } from "./numbering";
import { questionSubject } from "./orchestrator-question";
import { type PendingItem, pendingItems } from "./pending";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

export const TRIAGE_QUESTION_PATH = join(import.meta.dir, "..", "triage-question.json");
export const TRIAGE_CHOICES = ["routine", "needs-jo-irreversible", "needs-jo-product-call", "needs-jo-cost", "needs-jo-unclear"] as const;
export type TriageChoice = (typeof TRIAGE_CHOICES)[number];
const isChoice = (v: unknown): v is TriageChoice => typeof v === "string" && (TRIAGE_CHOICES as readonly string[]).includes(v);

/** A `routine` answer below this confidence is not routine (D4). */
export const ROUTINE_MIN_CONFIDENCE = 0.8;

export const RESERVED_REASON = "reserved action";
export const PLAN_REASON = "plan approval";
export const NO_RECOMMENDATION_REASON = "no recommendation recorded";
export const MULTIWORD_REASON = "options are not one word each";
export const JUDGE_UNSURE = "judge unsure";
export const JUDGE_UNAVAILABLE = "judge unavailable";
/** A reserved request's answers (surface/src/errors.ts: `approve <id>` / `deny <id>`). */
export const RESERVED_OPTIONS = ["approve", "deny"] as const;

/**
 * The reason of a needs-you line with no one-word answer, by kind. A `question` line reaches this
 * only with no options: an unresolved prompt wait. A `reserved` line always has an answer and takes
 * RESERVED_REASON; it is listed so the record covers every ErrorKind. Nothing type-checks this
 * record (bun strips types): a kind missing here renders `undefined` as Jo's reason. The scratch
 * reason is pinned as text by render tests from real ledger states (surface/test/triage.test.ts,
 * surface/test/send-line.test.ts): a workload's root over its cap, or every root together over the
 * total cap (surface/src/errors.ts).
 */
export const KIND_REASON: Record<ErrorKind, string> = {
	reserved: RESERVED_REASON,
	held: "held with no live lane",
	artifact: "failed its runtime artifact",
	"test-run": "red test run",
	"lane-died": "lane died",
	idle: "lane ended with work idle",
	question: "prompt wait",
	due: "past-due scheduled row",
	scratch: "scratch over its cap",
};

export interface RoutineItem {
	n: number;
	rowId: string;
	workloadId: string;
	/** The recommended option, as stored on the row. */
	word: string;
	/** The recommendation's reason: the orchestrator's words, or where pending.ts found it. */
	reason: string;
}

export interface NeedsJoItem {
	/** The session number; null for a line with no one-word answer. */
	n: number | null;
	rowId: string;
	workloadId: string;
	kind: ErrorKind;
	subject: string;
	reason: string;
}

export interface Triage {
	routine: RoutineItem[];
	needsJo: NeedsJoItem[];
}

export interface TriageQuestion {
	triage: { type: "choice"; instructions: string; criteria: Record<TriageChoice, string> };
}

export interface LoadedTriageQuestion {
	question: TriageQuestion;
	/** sha256 of the question file's bytes: part of every cache key. */
	sha256: string;
}

const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** The triage question, refused unless it is one choice question `triage` over TRIAGE_CHOICES in order, each with a one-line criterion. */
export function loadTriageQuestion(path: string = TRIAGE_QUESTION_PATH): LoadedTriageQuestion {
	const raw = readFileSync(path, "utf8");
	const question = JSON.parse(raw) as TriageQuestion;
	const criteria = question.triage?.criteria ?? {};
	const labels = Object.keys(criteria);
	if (question.triage?.type !== "choice" || labels.join() !== TRIAGE_CHOICES.join()) {
		throw new Error(`${path}: expected one choice question "triage" over ${TRIAGE_CHOICES.join(", ")}; got ${labels.join(", ")}`);
	}
	for (const c of TRIAGE_CHOICES) {
		const text = criteria[c];
		if (typeof text !== "string" || !text.trim() || text.includes("\n")) throw new Error(`${path}: criterion ${c} is not one line`);
	}
	return { question, sha256: sha256(raw) };
}

/** What triageItems needs from a judge: OMP's `judge` role (ChainJudge) in production, a recorded fake in tests. */
export interface TriageJudge {
	judge(request: { state: string; questions: TriageQuestion }, options?: { signal?: AbortSignal }): Promise<{
		answers: { triage?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } };
		model: string;
		provider: string;
	}>;
	/** The model a judgment routes to first (ChainJudge.primaryModel); the cache is read only when it is known. */
	primaryModel?(): { provider: string; id: string } | undefined;
}

// As classifier/src/classify.ts: five values rounded to 0.01 drift by at most 0.025 in total.
const SUM_TOLERANCE = 0.03;
const inUnitRange = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** The answer counts only as a whole distribution (classify.ts checkedAnswer): a choice, a confidence in [0, 1], and a probability for each of the five choices (no others) summing to 1. */
function checkedAnswer(answer: { choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined): { choice: TriageChoice; confidence: number } {
	if (!answer || !isChoice(answer.choice)) throw new Error(`triage answered outside the five choices: ${JSON.stringify(answer)}`);
	if (!inUnitRange(answer.confidence)) throw new Error(`triage confidence is not a number in [0, 1]: ${String(answer.confidence)}`);
	const raw = answer.probabilities;
	if (typeof raw !== "object" || raw === null) throw new Error("triage returned no probabilities");
	const extra = Object.keys(raw).filter((k) => !isChoice(k));
	if (extra.length > 0) throw new Error(`triage probabilities name unknown choices: ${extra.join(", ")}`);
	let sum = 0;
	for (const c of TRIAGE_CHOICES) {
		const v = (raw as Record<string, unknown>)[c];
		if (!inUnitRange(v)) throw new Error(`triage probabilities: ${c} is not a number in [0, 1]: ${String(v)}`);
		sum += v;
	}
	if (Math.abs(sum - 1) > SUM_TOLERANCE) throw new Error(`triage probabilities sum to ${sum.toFixed(3)}, not 1`);
	return { choice: answer.choice, confidence: answer.confidence };
}

// ---- the orchestrator's recommendation (D3) ---------------------------------------------------

/** The entry body orchestrator_recommend writes: `recommend: <row-id> <word> — <reason>`. */
export const recommendBody = (rowId: string, word: string, reason: string): string => `recommend: ${rowId} ${word} — ${reason}`;
const RECOMMEND = /^recommend: ((?:q|en)-[a-z0-9]+) (\S+) — (.+)$/;

const optionOf = (options: readonly string[], word: string): string | null => options.find((o) => o.toLowerCase() === word.toLowerCase()) ?? null;

/** The orchestrator's latest recommendation for `rowId`: a surface entry on the row's workload naming one of `options`; null with none. */
export function ilexRecommendation(ledger: Ledger, workloadId: string, rowId: string, options: readonly string[]): { word: string; reason: string } | null {
	let found: { word: string; reason: string } | null = null;
	for (const e of ledger.entries(workloadId, "assumption")) {
		if (e.created_by !== SURFACE_BY) continue;
		const m = RECOMMEND.exec(e.body);
		if (!m || m[1] !== rowId) continue;
		const word = optionOf(options, m[2]!);
		if (word) found = { word, reason: m[3]! };
	}
	return found;
}

/** The answers of an answerable line: approve / deny for a reserved request, the question's options. */
const optionsOf = (l: ErrorLine): readonly string[] => (l.kind === "reserved" ? RESERVED_OPTIONS : (l.options ?? []));
const oneWord = (options: readonly string[]): boolean => options.length > 0 && options.every((o) => !/\s/.test(o));

export interface LineOptions {
	now?: string;
	holdHours?: number;
}

/** The needs-you lines right now, numbered (numbers already given are kept; Numbering.assign). */
function numberedLines(ledger: Ledger, numbering: Numbering, opts: LineOptions): ErrorLine[] {
	return numbering.assign(errorLines(ledger, ledger.inFlight(), { ...(opts.now ? { now: opts.now } : {}), ...(opts.holdHours !== undefined ? { holdHours: opts.holdHours } : {}) }));
}

/** The answerable lines with one-word answers that carry no recommendation from the orchestrator: what the stop nudge names. */
export function unrecommended(ledger: Ledger, numbering: Numbering, opts: LineOptions = {}): ErrorLine[] {
	return numberedLines(ledger, numbering, opts).filter((l) => {
		if (!answerable(l)) return false;
		const options = optionsOf(l);
		return oneWord(options) && ilexRecommendation(ledger, l.workloadId, l.rowId, options) === null;
	});
}

export type Recommended = { ok: true; entryId: string; n: number | null; rowId: string; workloadId: string; word: string } | { ok: false; reason: string };

/**
 * orchestrator_recommend's write: `item` is `#n` (the session Numbering), `q-…` or `en-…`; refused
 * unless the row is on the needs-you list now with a one-word answer and `word` is one of its
 * options. One entry, by the surface, on the row's workload, in ledger.write.
 */
export function recordRecommendation(ledger: Ledger, numbering: Numbering, input: { item: string; word: string; reason: string }, opts: LineOptions = {}): Recommended {
	const item = input.item.trim();
	let rowId: string;
	const num = /^#(\d+)$/.exec(item);
	if (num) {
		const t = numbering.target(Number(num[1]));
		if (!t) return { ok: false, reason: `${item} is not a number on the needs-you list; nothing was recorded` };
		rowId = t.rowId;
	} else if (/^(?:q|en)-[a-z0-9]+$/.test(item)) {
		rowId = item;
	} else {
		return { ok: false, reason: `item is \`#n\`, a q-… id or an en-… id, not "${item}"; nothing was recorded` };
	}
	const line = numberedLines(ledger, numbering, opts).find((l) => answerable(l) && l.rowId === rowId);
	if (!line) {
		const known = rowId.startsWith("q-") ? ledger.question(rowId) !== null : num !== null;
		return { ok: false, reason: known ? `${num ? `${item} (${rowId})` : rowId} is no longer waiting on Jo; nothing was recorded` : `no waiting question or reserved request ${rowId}; nothing was recorded` };
	}
	const options = optionsOf(line);
	if (!oneWord(options)) return { ok: false, reason: `${rowId}'s options are not one word each, so it is listed as needs Jo whatever is recommended; nothing was recorded` };
	const word = optionOf(options, input.word.trim());
	if (!word) return { ok: false, reason: `"${input.word.trim()}" is not an answer to ${rowId}; it takes: ${options.join(" / ")}. Nothing was recorded` };
	const reason = input.reason.replace(/\s+/g, " ").trim();
	if (!reason) return { ok: false, reason: "a recommendation carries a one-line reason; nothing was recorded" };
	const entryId = ledger.write(() => ledger.recordEntry({ by: SURFACE_BY, workloadId: line.workloadId, kind: "assumption", body: recommendBody(rowId, word, reason) }));
	return { ok: true, entryId, n: line.n ?? null, rowId, workloadId: line.workloadId, word };
}

// ---- the cache (D4) ---------------------------------------------------------------------------

/** The verdict entry's body: `triage: <row-id> <choice> <confidence> <provider/model> key <sha256>`. */
export const triageBody = (rowId: string, choice: TriageChoice, confidence: number, model: string, key: string): string =>
	`triage: ${rowId} ${choice} ${confidence} ${model} key ${key}`;
const TRIAGE = /^triage: ((?:q|en)-[a-z0-9]+) (\S+) (\S+) (\S+\/\S+) key ([0-9a-f]{64})$/;

export interface JudgeInput {
	rowId: string;
	body: string;
	options: readonly string[];
	word: string;
	reason: string;
	stakes: string;
}

/** sha256 over every judge input, the question file's sha256 and the judge model. */
export function triageKey(input: JudgeInput, questionSha256: string, model: string): string {
	return sha256(JSON.stringify([input.rowId, input.body, [...input.options], input.word, input.reason, input.stakes, questionSha256, model]));
}

/** The newest surface verdict entry for `rowId` whose key is `key`, or null. */
function cached(ledger: Ledger, workloadId: string, rowId: string, key: string): { choice: TriageChoice; confidence: number } | null {
	let found: { choice: TriageChoice; confidence: number } | null = null;
	for (const e of ledger.entries(workloadId, "assumption")) {
		if (e.created_by !== SURFACE_BY) continue;
		const m = TRIAGE.exec(e.body);
		if (!m || m[1] !== rowId || m[5] !== key || !isChoice(m[2])) continue;
		const confidence = Number(m[3]);
		if (inUnitRange(confidence)) found = { choice: m[2], confidence };
	}
	return found;
}

/** The judge's state: the question as Jo would read it, its options, the recommendation and its reason, and the stakes. */
export function triageState(input: JudgeInput): string {
	return [
		`Item ${input.rowId} on a ${input.stakes}-stakes workload.`,
		"Question:",
		input.body,
		`Options: ${input.options.join(" / ")}`,
		`Recommended answer: ${input.word}`,
		`Reason recorded for it: ${input.reason}`,
	].join("\n");
}

// ---- the sort ---------------------------------------------------------------------------------

export interface TriageOptions extends LineOptions {
	/** The question as loaded; default loadTriageQuestion() (a failed load fails every judged row closed). */
	question?: LoadedTriageQuestion;
	signal?: AbortSignal;
}

/** The stakes the judge weighs: the row's workload's; for the orchestrator's own question, its subject workload's when it names one. */
function stakesOf(ledger: Ledger, workloadId: string, rowId: string): string {
	const about = workloadId === STANDING_WORKLOAD_ID ? questionSubject(ledger, rowId) : null;
	return ledger.workload(about ?? workloadId)?.stakes ?? ledger.workload(workloadId)?.stakes ?? "unknown";
}

type Verdict = { routine: true } | { routine: false; reason: string };

/**
 * Where triageItems gets its judge: the judge itself, none, or a resolver called only when a row
 * first reaches the judge (OMP's judge role resolves through the host's modules, so a render whose
 * every row is settled by the fixed rules never loads them). A resolver that throws or yields null
 * fails every judged row closed.
 */
export type JudgeSource = TriageJudge | null | (() => Promise<TriageJudge | null>);

/** Every needs-you line, in needs-you order, sorted into routine (the only items `ok` may apply) and needs-Jo. */
export async function triageItems(ledger: Ledger, numbering: Numbering, source: JudgeSource, opts: TriageOptions = {}): Promise<Triage> {
	const lines = numberedLines(ledger, numbering, opts);
	const pending = new Map<string, PendingItem>(pendingItems(ledger).map((p) => [p.id, p]));
	let loaded: LoadedTriageQuestion | null | undefined = opts.question;
	const question = (): LoadedTriageQuestion | null => {
		if (loaded === undefined) {
			try {
				loaded = loadTriageQuestion();
			} catch {
				loaded = null;
			}
		}
		return loaded;
	};
	/** The judge and the model it routes to first, resolved once on first use. */
	let resolved: { judge: TriageJudge | null; expected: string | null } | undefined;
	const resolve = async (): Promise<{ judge: TriageJudge | null; expected: string | null }> => {
		if (resolved) return resolved;
		let judge: TriageJudge | null;
		try {
			judge = typeof source === "function" ? await source() : source;
		} catch {
			judge = null;
		}
		let expected: string | null = null;
		try {
			const m = judge?.primaryModel?.();
			expected = m ? `${m.provider}/${m.id}` : null;
		} catch {
			expected = null;
		}
		resolved = { judge, expected };
		return resolved;
	};
	const writes: { workloadId: string; body: string }[] = [];

	const judged = async (input: JudgeInput, workloadId: string): Promise<Verdict> => {
		const q = question();
		const { judge, expected } = await resolve();
		if (!q || !judge) return { routine: false, reason: JUDGE_UNAVAILABLE };
		let answer = expected ? cached(ledger, workloadId, input.rowId, triageKey(input, q.sha256, expected)) : null;
		if (!answer) {
			try {
				const result = await judge.judge({ state: triageState(input), questions: q.question }, { signal: opts.signal });
				answer = checkedAnswer(result.answers?.triage);
				const model = `${result.provider}/${result.model}`;
				writes.push({ workloadId, body: triageBody(input.rowId, answer.choice, answer.confidence, model, triageKey(input, q.sha256, model)) });
			} catch {
				return { routine: false, reason: JUDGE_UNAVAILABLE };
			}
		}
		if (answer.choice === "routine") return answer.confidence >= ROUTINE_MIN_CONFIDENCE ? { routine: true } : { routine: false, reason: JUDGE_UNSURE };
		return { routine: false, reason: q.question.triage.criteria[answer.choice] };
	};

	const out: Triage = { routine: [], needsJo: [] };
	for (const l of lines) {
		const item = pending.get(l.rowId);
		const needsJo = (reason: string, n: number | null = l.n ?? null) =>
			out.needsJo.push({ n, rowId: l.rowId, workloadId: l.workloadId, kind: l.kind, subject: item?.subject ?? l.line, reason });
		if (!answerable(l)) {
			needsJo(KIND_REASON[l.kind], null);
			continue;
		}
		if (l.kind === "reserved") {
			needsJo(RESERVED_REASON);
			continue;
		}
		const q = ledger.question(l.rowId);
		if (q && isPlanQuestion(ledger, q)) {
			needsJo(PLAN_REASON);
			continue;
		}
		const options = optionsOf(l);
		if (!oneWord(options)) {
			needsJo(MULTIWORD_REASON);
			continue;
		}
		const rec = ilexRecommendation(ledger, l.workloadId, l.rowId, options)
			?? (item?.recommended ? { word: item.recommended, reason: item.recordedWhere ?? "recorded" } : null);
		if (!rec) {
			needsJo(NO_RECOMMENDATION_REASON);
			continue;
		}
		const input: JudgeInput = { rowId: l.rowId, body: q?.body ?? l.line, options, word: rec.word, reason: rec.reason, stakes: stakesOf(ledger, l.workloadId, l.rowId) };
		const verdict = await judged(input, l.workloadId);
		if (verdict.routine) out.routine.push({ n: l.n!, rowId: l.rowId, workloadId: l.workloadId, word: rec.word, reason: rec.reason });
		else needsJo(verdict.reason);
	}
	if (writes.length > 0) {
		ledger.write(() => {
			for (const w of writes) ledger.recordEntry({ by: SURFACE_BY, workloadId: w.workloadId, kind: "assumption", body: w.body });
		});
	}
	return out;
}

// ---- the machine render (D5) ------------------------------------------------------------------

/** The longest subject a needs-Jo line shows (D5). */
export const SUBJECT_MAX = 60;
const clipSubject = (s: string): string => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > SUBJECT_MAX ? `${one.slice(0, SUBJECT_MAX - 1)}…` : one;
};

/** The heading of the needs-Jo list. */
export const NEEDS_JO_HEADING = "needs Jo:";

/**
 * One needs-Jo line: `#4 q-… (plan approval) — <subject>` for a numbered row; for a line with no
 * one-word answer, `lane died: wl-… — <subject> (no one-word answer)`.
 */
export function needsJoLine(i: NeedsJoItem): string {
	const subject = clipSubject(i.subject);
	return i.n === null ? `${i.reason}: ${i.workloadId} — ${subject} (no one-word answer)` : `#${i.n} ${i.rowId} (${i.reason}) — ${subject}`;
}

/** The routine pieces as one batch, `3 approve, 5 extend`: what the `send:` line shows and `ok` reads back with interpretBatch. */
export const sendPieces = (routine: readonly RoutineItem[]): string => routine.map((r) => `${r.n} ${r.word}`).join(", ");

/** The `send-line:` entry body the surface writes on the standing workload for every `send:` line it renders. */
export const sendLineBody = (id: string, pieces: string): string => `send-line: ${id} ${pieces}`;

/** The `send-applied:` entry linking an `ok` to the line it applied: its Jo input row, the answer rows written, the numbers skipped (`none` for an empty list). */
export const sendAppliedBody = (id: string, okInput: string, answers: readonly string[], skipped: readonly number[]): string =>
	`send-applied: ${id} ${okInput} ${answers.length > 0 ? answers.join(" ") : "none"} skipped ${skipped.length > 0 ? skipped.join(" ") : "none"}`;
