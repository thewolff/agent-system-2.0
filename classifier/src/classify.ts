/**
 * Routing step 1: the brief goes to the judge as one choice question over the five kinds and comes
 * back as kind + confidence + probabilities. The question text is classifier/kind-question.json;
 * classifier/calibration.json names the question and judge the 0.55 threshold was measured with
 * (research/classifier-sample.md), and the extension refuses to route on any other pair.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isKind, KINDS, type Kind, type KindAnswer } from "./route";

export const QUESTION_PATH = join(import.meta.dir, "..", "kind-question.json");
export const CALIBRATION_PATH = join(import.meta.dir, "..", "calibration.json");

export interface KindQuestion {
	kind: { type: "choice"; instructions: string; criteria: Record<string, string> };
}

export function loadKindQuestion(path: string = QUESTION_PATH): KindQuestion {
	const question = JSON.parse(readFileSync(path, "utf8")) as KindQuestion;
	// SPEC-2.0.md § A1.3 step 1: one choice question over the five kinds, nothing else.
	const labels = Object.keys(question.kind?.criteria ?? {});
	if (question.kind?.type !== "choice" || labels.join() !== KINDS.join()) {
		throw new Error(`${path}: expected one choice question "kind" over ${KINDS.join(", ")}; got ${labels.join(", ")}`);
	}
	return question;
}

/** sha256 of the question's canonical JSON: the identity a measurement is recorded against. */
export function questionSha256(question: KindQuestion): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(question)).digest("hex");
}

/** The question and judge a threshold measurement holds for. A change to either needs a new sample. */
export interface Calibration {
	questionSha256: string;
	/** `provider/model` of the judge the sample was answered by. */
	judgeModel: string;
}

// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
export function loadCalibration(path: string = CALIBRATION_PATH): Calibration {
	const raw = JSON.parse(readFileSync(path, "utf8")) as { question_sha256?: unknown; judge_model?: unknown };
	if (typeof raw.question_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.question_sha256)) {
		throw new Error(`${path}: question_sha256 is not a sha256 hex digest`);
	}
	if (typeof raw.judge_model !== "string" || !raw.judge_model.includes("/")) {
		throw new Error(`${path}: judge_model is not a provider/model selector`);
	}
	return { questionSha256: raw.question_sha256, judgeModel: raw.judge_model };
}

/** What classify() needs from a judge: OMP's `judge` role in production, a recorded fixture in tests. */
export interface KindJudge {
	judge(request: { state: string; questions: KindQuestion }, options?: { signal?: AbortSignal }): Promise<{
		answers: { kind: { choice: string; confidence: number; probabilities: Record<string, number> } };
		model: string;
		provider: string;
		usage?: { cost?: { total?: number } };
	}>;
}

export interface Classification extends KindAnswer {
	/** `provider/model` that answered, e.g. `typesafe/jev-1.13.0`. */
	judgeModel: string;
	/** Dollar cost the judge reported for this call, when it reports one. */
	cost: number | null;
}

// The recorded sample's distributions sum to 1.000 over all five kinds (two-decimal rounding);
// five values rounded to 0.01 can drift by at most 0.025 in total.
const SUM_TOLERANCE = 0.03;

const inUnitRange = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * The answer is routing evidence only when it is a whole distribution: a confidence in [0, 1] and a
 * probability in [0, 1] for each of the five kinds (no others) summing to 1. Anything else is
 * refused — filling gaps with zeroes would let the tie-break invent the top two (SPEC-2.0.md § A1.3).
 */
function checkedAnswer(answer: { choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined): KindAnswer {
	if (!answer || !isKind(answer.choice)) {
		throw new Error(`classifier answered outside the five kinds: ${JSON.stringify(answer)}`);
	}
	if (!inUnitRange(answer.confidence)) {
		throw new Error(`classifier confidence is not a number in [0, 1]: ${String(answer.confidence)}`);
	}
	const raw = answer.probabilities;
	if (typeof raw !== "object" || raw === null) throw new Error("classifier returned no probabilities");
	const extra = Object.keys(raw).filter(key => !isKind(key));
	if (extra.length > 0) throw new Error(`classifier probabilities name unknown kinds: ${extra.join(", ")}`);
	const probabilities = {} as Record<Kind, number>;
	for (const kind of KINDS) {
		const value = (raw as Record<string, unknown>)[kind];
		if (!inUnitRange(value)) throw new Error(`classifier probabilities: ${kind} is not a number in [0, 1]: ${String(value)}`);
		probabilities[kind] = value;
	}
	const sum = KINDS.reduce((total, kind) => total + probabilities[kind], 0);
	if (Math.abs(sum - 1) > SUM_TOLERANCE) throw new Error(`classifier probabilities sum to ${sum.toFixed(3)}, not 1`);
	return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

/** SPEC-2.0.md § A1.3 step 1: classify one brief. It names the kind of work only; never a model. */
export async function classify(
	brief: string,
	judge: KindJudge,
	question: KindQuestion,
	signal?: AbortSignal,
): Promise<Classification> {
	// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
	const result = await judge.judge({ state: brief, questions: question }, { signal });
	return {
		...checkedAnswer(result.answers?.kind),
		judgeModel: `${result.provider}/${result.model}`,
		cost: result.usage?.cost?.total ?? null,
	};
}
