/**
 * One jev call over a map of typed questions. `askChoices` (PLAN wl-mv67564rdkfvnk D4) asks choice questions only: the
 * pair-suggest trigger asks classifier/pair-signal-question.json's `taste` and `ambiguous` together on the workload brief.
 * `askJudgment` (PLAN wl-mv8k039gvogt8g D2) asks `choice`, `bool` and `score` questions in one call: Jev ranking's
 * per-workload signal. The answer is evidence only when every question comes back whole: a choice among its labels, a
 * `bool` probability in [0, 1], a score level in range; a confidence in [0, 1] and a probability in [0, 1] for exactly
 * its labels (or levels) summing to 1. A judge that throws, answers outside that shape, or has not answered by
 * `timeoutMs` is a failed attempt, never a partial answer; the timeout aborts the signal the judge was given and does
 * not wait for the judge to honour it.
 *
 * The judge is OMP's library judge (`resolveJudge`, pi-ai judgment/types.ts): its yes/no question is `noul` on the wire
 * and answers `{ noul }`; askJudgment names it `bool` to its callers, as OMP's eval bridge does, and translates both ways.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PAIR_SIGNAL_QUESTION_PATH = join(import.meta.dir, "..", "pair-signal-question.json");

/**
 * Jev's price: $0.042 per million input tokens, output free (research/typesafe-ai.md, "The price is $0.042 per million
 * input tokens", citing https://docs.typesafe.ai/models.md). The direct TypeSafe path reports `usage.cost.total` 0, so
 * an attempt's dollars are derived from its input tokens with this figure.
 */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}
export type ChoiceQuestions = Record<string, ChoiceQuestion>;

export interface ChoiceAnswer {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

/** The judge's reply as askChoices reads it; `answers` is checked here, never trusted. */
export interface ChoiceReply {
	answers: unknown;
	model: string;
	provider: string;
	/** OMP's judgment usage: input tokens, and a cost whose total the direct TypeSafe path reports as 0. */
	usage?: { input?: unknown; cost?: { total?: unknown } | null } | null;
}

/** What askChoices needs from a judge: OMP's `judge` role in production, a fake in tests. */
export interface ChoiceJudge {
	judge(request: { state: string; questions: ChoiceQuestions }, options?: { signal?: AbortSignal }): Promise<ChoiceReply>;
}

export type AskFailure = "timeout" | "error" | "malformed";

export type AskResult =
	| { ok: true; answers: Record<string, ChoiceAnswer>; model: string; provider: string; tokens?: number; cost: number | null }
	| { ok: false; failure: AskFailure; reason: string; tokens?: number; cost: number | null };

/** A yes/no question: the judge answers the probability of yes. `noul` on OMP's wire (pi-ai judgment/types.ts NoulQuestion). */
export interface BoolQuestion {
	type: "bool";
	instructions: string;
	criteria?: { true?: string; false?: string };
}
/** A position on ordered levels, lowest first: the judge answers a level index in [0, levels − 1] (probability-weighted, so it may land between levels). */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: readonly [string, string, ...string[]];
}
export type JudgmentQuestion = ChoiceQuestion | BoolQuestion | ScoreQuestion;
export type JudgmentQuestions = Record<string, JudgmentQuestion>;

export type JudgmentAnswer =
	| { type: "bool"; bool: number }
	| { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
	| ({ type: "choice" } & ChoiceAnswer);

/** What the judge is asked about: plain text or a named-field object (pi-ai judgment/types.ts JudgmentState). */
export type JudgmentState = string | { readonly [key: string]: unknown };
/** A question as OMP's judge takes it: `bool` goes out as `noul`. */
export type WireQuestion = ChoiceQuestion | ScoreQuestion | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

/** What askJudgment needs from a judge: OMP's `judge` role in production, a fake in tests. */
export interface JudgmentJudge {
	judge(request: { state: JudgmentState; questions: Record<string, WireQuestion> }, options?: { signal?: AbortSignal }): Promise<ChoiceReply>;
}

export type JudgmentAskResult =
	| { ok: true; answers: Record<string, JudgmentAnswer>; model: string; provider: string; tokens?: number; cost: number | null }
	| { ok: false; failure: AskFailure; reason: string; tokens?: number; cost: number | null };

type AskFailed = Extract<AskResult, { ok: false }>;

/** The question file, checked: every entry a choice question with instructions and at least two labels. */
export function loadChoiceQuestions(path: string = PAIR_SIGNAL_QUESTION_PATH): ChoiceQuestions {
	const raw = JSON.parse(readFileSync(path, "utf8")) as ChoiceQuestions;
	for (const [name, q] of Object.entries(raw)) {
		if (q?.type !== "choice" || typeof q.instructions !== "string" || Object.keys(q.criteria ?? {}).length < 2) {
			throw new Error(`${path}: ${name} is not a choice question with instructions and two or more labels`);
		}
	}
	return raw;
}

/** Jev rounds each probability to two decimals, so a sum may miss 1 by up to half a hundredth per label (0.99 seen live, wl-mv8k039gvogt8g smoke). */
const sumTolerance = (labels: number): number => 0.005 * labels + 1e-9;

const inUnitRange = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** The reply's input tokens and dollars: tokens × the jev price when tokens are reported, else a positive reported cost, else unknown. */
function spendOf(usage: ChoiceReply["usage"]): { tokens?: number; cost: number | null } {
	const input = usage?.input;
	if (typeof input === "number" && Number.isFinite(input) && input >= 0) return { tokens: input, cost: input * JEV_USD_PER_INPUT_TOKEN };
	const total = usage?.cost?.total;
	return { cost: typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null };
}

/** A distribution over exactly `labels`, each in [0, 1], summing to 1; or the reason it is not one. */
function distribution(name: string, raw: unknown, labels: readonly string[]): Record<string, number> | string {
	if (typeof raw !== "object" || raw === null) return `${name}: no probabilities`;
	const p = raw as Record<string, unknown>;
	const keys = Object.keys(p);
	if (keys.length !== labels.length || !labels.every((l) => keys.includes(l))) return `${name}: probabilities over ${keys.join(", ")}, not ${labels.join(", ")}`;
	const probabilities: Record<string, number> = {};
	let sum = 0;
	for (const l of labels) {
		const value = p[l];
		if (!inUnitRange(value)) return `${name}: probability of ${l} ${String(value)} is not a number in [0, 1]`;
		probabilities[l] = value;
		sum += value;
	}
	if (Math.abs(sum - 1) > sumTolerance(labels.length)) return `${name}: probabilities sum to ${sum}, not 1`;
	return probabilities;
}

/** One choice question's answer, whole, or the reason it is not. */
function checked(name: string, q: ChoiceQuestion, raw: unknown): ChoiceAnswer | string {
	if (typeof raw !== "object" || raw === null) return `${name}: no answer`;
	const answer = raw as { choice?: unknown; confidence?: unknown; probabilities?: unknown };
	const labels = Object.keys(q.criteria);
	if (typeof answer.choice !== "string" || !labels.includes(answer.choice)) return `${name}: choice ${JSON.stringify(answer.choice)} is not one of ${labels.join(", ")}`;
	if (!inUnitRange(answer.confidence)) return `${name}: confidence ${String(answer.confidence)} is not a number in [0, 1]`;
	const probabilities = distribution(name, answer.probabilities, labels);
	if (typeof probabilities === "string") return probabilities;
	return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

/** One typed question's answer, whole, or the reason it is not. A `bool` reads the wire's `noul`; a score's probabilities are keyed by level index. */
function checkedTyped(name: string, q: JudgmentQuestion, raw: unknown): JudgmentAnswer | string {
	if (q.type === "choice") {
		const a = checked(name, q, raw);
		return typeof a === "string" ? a : { type: "choice", ...a };
	}
	if (typeof raw !== "object" || raw === null) return `${name}: no answer`;
	if (q.type === "bool") {
		const noul: unknown = Reflect.get(raw, "noul");
		return inUnitRange(noul) ? { type: "bool", bool: noul } : `${name}: noul ${String(noul)} is not a number in [0, 1]`;
	}
	const score: unknown = Reflect.get(raw, "score");
	const confidence: unknown = Reflect.get(raw, "confidence");
	const top = q.criteria.length - 1;
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) return `${name}: score ${String(score)} is not a level in [0, ${top}]`;
	if (!inUnitRange(confidence)) return `${name}: confidence ${String(confidence)} is not a number in [0, 1]`;
	const probabilities = distribution(name, Reflect.get(raw, "probabilities"), q.criteria.map((_, i) => String(i)));
	if (typeof probabilities === "string") return probabilities;
	return { type: "score", score, confidence, probabilities };
}

/** The judge's reply, validated against every question asked; a fake or a broken judge may hand back anything. */
function validated<A, Q>(
	reply: ChoiceReply | null | undefined, questions: Record<string, Q>, check: (name: string, q: Q, raw: unknown) => A | string,
): { ok: true; answers: Record<string, A>; model: string; provider: string; tokens?: number; cost: number | null } | AskFailed {
	const reported = spendOf(reply?.usage);
	const malformed = (why: string): AskFailed => ({ ok: false, failure: "malformed", reason: `malformed: ${why}`, ...reported });
	if (!reply) return malformed("no reply");
	if (typeof reply.answers !== "object" || reply.answers === null) return malformed("no answers");
	const given = reply.answers as Record<string, unknown>;
	const answers: Record<string, A> = {};
	for (const [name, q] of Object.entries(questions)) {
		const a = check(name, q, given[name]);
		if (typeof a === "string") return malformed(a);
		answers[name] = a;
	}
	return { ok: true, answers, model: String(reply.model), provider: String(reply.provider), ...reported };
}

/**
 * One judge call raced against `timeoutMs`, resolving never rejecting: a throw is `error: …` with the cost unknown, the
 * timer `timeout …`, and a reply whatever `validate` makes of it. The call's signal aborts at `timeoutMs` or when
 * `opts.signal` aborts.
 */
async function raced<R>(
	call: (signal: AbortSignal) => Promise<ChoiceReply | null | undefined>,
	validate: (reply: ChoiceReply | null | undefined) => R,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<R | AskFailed> {
	const controller = new AbortController();
	const forward = () => controller.abort(opts.signal?.reason);
	if (opts.signal?.aborted) forward();
	else opts.signal?.addEventListener("abort", forward, { once: true });
	let timer: Timer | undefined;
	const timedOut = new Promise<AskFailed>((resolve) => {
		timer = setTimeout(() => {
			resolve({ ok: false, failure: "timeout", reason: `timeout after ${opts.timeoutMs} ms`, cost: null });
			controller.abort(new Error(`timeout after ${opts.timeoutMs} ms`));
		}, opts.timeoutMs);
	});
	const answered = (async (): Promise<R | AskFailed> => {
		let reply: ChoiceReply | null | undefined;
		try {
			reply = await call(controller.signal);
		} catch (error) {
			return { ok: false, failure: "error", reason: `error: ${error instanceof Error ? error.message : String(error)}`, cost: null };
		}
		return validate(reply);
	})();
	try {
		return await Promise.race([answered, timedOut]);
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", forward);
	}
}

/**
 * Ask every question in `questions` about `state` in one judge call. Resolves, never rejects: a failure is
 * `{ ok: false }` with `failure` and a `reason` naming it (`timeout …`, `error: …`, `malformed: …`); a malformed reply
 * keeps the spend the judge reported. The judge gets a signal aborted at `timeoutMs` or when `opts.signal` aborts.
 */
export function askChoices(
	judge: ChoiceJudge,
	state: string,
	questions: ChoiceQuestions,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<AskResult> {
	return raced((signal) => judge.judge({ state, questions }, { signal }), (reply) => validated(reply, questions, checked), opts);
}

/** `bool` questions as OMP's judge takes them: `noul`, criteria kept. */
function onWire(questions: JudgmentQuestions): Record<string, WireQuestion> {
	const out: Record<string, WireQuestion> = {};
	for (const [name, q] of Object.entries(questions)) {
		out[name] = q.type === "bool" ? { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) } : q;
	}
	return out;
}

/**
 * `askChoices` for `choice`, `bool` and `score` questions together (PLAN wl-mv8k039gvogt8g D2), with the same contract:
 * one judge call, resolves never rejects, a failure names `timeout` / `error` / `malformed`, and a malformed reply keeps
 * the spend the judge reported. `bool` goes out as `noul` and comes back as `{ type: "bool", bool }`.
 */
export function askJudgment(
	judge: JudgmentJudge,
	state: JudgmentState,
	questions: JudgmentQuestions,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<JudgmentAskResult> {
	const wire = onWire(questions);
	return raced((signal) => judge.judge({ state, questions: wire }, { signal }), (reply) => validated(reply, questions, checkedTyped), opts);
}
