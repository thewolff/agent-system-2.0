/**
 * One jev call over a map of choice questions (PLAN wl-mv67564rdkfvnk D4): the pair-suggest trigger asks
 * classifier/pair-signal-question.json's `taste` and `ambiguous` together on the workload brief. The answer is evidence
 * only when every question comes back whole: a choice among its labels, a confidence in [0, 1], and a probability in
 * [0, 1] for exactly its labels summing to 1. A judge that throws, answers outside that shape, or has not answered by
 * `timeoutMs` is a failed attempt, never a partial answer; the timeout aborts the signal the judge was given and does
 * not wait for the judge to honour it.
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

const SUM_TOLERANCE = 1e-6;

const inUnitRange = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** The reply's input tokens and dollars: tokens × the jev price when tokens are reported, else a positive reported cost, else unknown. */
function spendOf(usage: ChoiceReply["usage"]): { tokens?: number; cost: number | null } {
	const input = usage?.input;
	if (typeof input === "number" && Number.isFinite(input) && input >= 0) return { tokens: input, cost: input * JEV_USD_PER_INPUT_TOKEN };
	const total = usage?.cost?.total;
	return { cost: typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null };
}

/** One question's answer, whole, or the reason it is not. */
function checked(name: string, q: ChoiceQuestion, raw: unknown): ChoiceAnswer | string {
	if (typeof raw !== "object" || raw === null) return `${name}: no answer`;
	const answer = raw as { choice?: unknown; confidence?: unknown; probabilities?: unknown };
	const labels = Object.keys(q.criteria);
	if (typeof answer.choice !== "string" || !labels.includes(answer.choice)) return `${name}: choice ${JSON.stringify(answer.choice)} is not one of ${labels.join(", ")}`;
	if (!inUnitRange(answer.confidence)) return `${name}: confidence ${String(answer.confidence)} is not a number in [0, 1]`;
	if (typeof answer.probabilities !== "object" || answer.probabilities === null) return `${name}: no probabilities`;
	const p = answer.probabilities as Record<string, unknown>;
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
	if (Math.abs(sum - 1) > SUM_TOLERANCE) return `${name}: probabilities sum to ${sum}, not 1`;
	return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

/** The judge's reply, validated against every question asked; a fake or a broken judge may hand back anything. */
function validated(reply: ChoiceReply | null | undefined, questions: ChoiceQuestions): AskResult {
	const reported = spendOf(reply?.usage);
	const malformed = (why: string): AskResult => ({ ok: false, failure: "malformed", reason: `malformed: ${why}`, ...reported });
	if (!reply) return malformed("no reply");
	if (typeof reply.answers !== "object" || reply.answers === null) return malformed("no answers");
	const given = reply.answers as Record<string, unknown>;
	const answers: Record<string, ChoiceAnswer> = {};
	for (const [name, q] of Object.entries(questions)) {
		const a = checked(name, q, given[name]);
		if (typeof a === "string") return malformed(a);
		answers[name] = a;
	}
	return { ok: true, answers, model: String(reply.model), provider: String(reply.provider), ...reported };
}

// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
/**
 * Ask every question in `questions` about `state` in one judge call. Resolves, never rejects: a failure is
 * `{ ok: false }` with `failure` and a `reason` naming it (`timeout …`, `error: …`, `malformed: …`); a malformed reply
 * keeps the spend the judge reported. The judge gets a signal aborted at `timeoutMs` or when `opts.signal` aborts.
 */
export async function askChoices(
	judge: ChoiceJudge,
	state: string,
	questions: ChoiceQuestions,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<AskResult> {
	const controller = new AbortController();
	const forward = () => controller.abort(opts.signal?.reason);
	if (opts.signal?.aborted) forward();
	else opts.signal?.addEventListener("abort", forward, { once: true });
	let timer: Timer | undefined;
	const timedOut = new Promise<AskResult>((resolve) => {
		timer = setTimeout(() => {
			resolve({ ok: false, failure: "timeout", reason: `timeout after ${opts.timeoutMs} ms`, cost: null });
			controller.abort(new Error(`timeout after ${opts.timeoutMs} ms`));
		}, opts.timeoutMs);
	});
	const answered = (async (): Promise<AskResult> => {
		let reply: ChoiceReply | null | undefined;
		try {
			reply = await judge.judge({ state, questions }, { signal: controller.signal });
		} catch (error) {
			return { ok: false, failure: "error", reason: `error: ${error instanceof Error ? error.message : String(error)}`, cost: null };
		}
		return validated(reply, questions);
	})();
	try {
		return await Promise.race([answered, timedOut]);
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", forward);
	}
}
