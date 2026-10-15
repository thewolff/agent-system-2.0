// Stakes inference (SPEC-2.0.md § A1.2): throwaway / normal / production from what Jo said plus the
// target repository, branch and whether a reserved target is named. Default normal. Shown as an
// inference in the one-liner, never asked. Mode (§ B13.1) is who steers: handed over and left is
// autonomous; "with me" / "plan it" / opening the lane's session is user-driven.
import { LOW_CONFIDENCE_THRESHOLD } from "../../classifier/src/route";
import { PROTECTED_BRANCH } from "../../gates/src/types";
import type { Mode, Stakes } from "../../ledger/src/index";

export interface StakesInput {
	/** What Jo said when handing the work over. */
	said: string;
	/** The target repository path or name, when known. */
	repo?: string | null;
	/** The target branch, when known. */
	branch?: string | null;
	/** A reserved target is named (§ A4: protected branch push, deploy, spend, …). */
	reservedTarget?: boolean;
}

export interface Inferred<T> {
	value: T;
	/** One line saying what the inference rests on, for the one-liner. */
	reason: string;
}

const PRODUCTION_WORDS = /\b(production|prod|deploy|deployment|release|hotfix|customer-facing|customers?|live|outage|incident)\b/i;
const THROWAWAY_WORDS = /\b(throwaway|throw-away|scratch|experiment|experimental|prototype|spike|poc|proof of concept|try(?:ing)? out|play(?:ing)? with|just (?:try|see|check))\b/i;
const SCRATCH_REPO = /(?:^|\/)(?:agent-scratch|scratch|tmp|temp|sandbox|playground)(?:\/|$)/i;
// "plan it" is not steering (DESIGN-lane-launcher.md decision 15: planning is not steering); it sets plan-first, see `saidPlanIt`.
const USER_DRIVEN_WORDS = /\b(with me|step by step|walk me through|check with me|ask me|together|pair(?:ing)?|interactive(?:ly)?|user[- ]driven)\b/i;
const PLAN_IT_WORDS = /\b(plan it|plan first|plan-first|plan this)\b/i;
const NO_PLAN_WORDS = /\bno[- ]plan\b/gi;
/** Opening → closing quote pairs: the phrase wrapped in one of these on its own is a mention, not the word (PLAN.md D4). */
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "\u201c": "\u201d", "\u2018": "\u2019", "`": "`" };

// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
/** At normal stakes the open-time judge skips the plan only on change-small at this confidence or higher (MIGRATION.md item 42, PLAN.md D1). */
export const PLAN_SKIP_CONFIDENCE = 0.9;

/** Stakes from what Jo said and where the work lands. Production wins over throwaway when both match. */
export function inferStakes(input: StakesInput): Inferred<Stakes> {
	const said = input.said ?? "";
	if (input.reservedTarget) return { value: "production", reason: "a reserved target is named" };
	if (input.branch && PROTECTED_BRANCH.test(input.branch)) return { value: "production", reason: `target branch ${input.branch} is protected` };
	const prod = PRODUCTION_WORDS.exec(said);
	if (prod) return { value: "production", reason: `you said "${prod[0]}"` };
	const scratch = input.repo ? SCRATCH_REPO.exec(input.repo) : null;
	if (scratch) return { value: "throwaway", reason: `target repository is under ${scratch[0].replace(/\//g, "")}` };
	const away = THROWAWAY_WORDS.exec(said);
	if (away) return { value: "throwaway", reason: `you said "${away[0]}"` };
	return { value: "normal", reason: "default: nothing said points at production or scratch" };
}

/** Mode from what Jo said: user-driven only when they asked to steer. */
export function inferMode(said: string): Inferred<Mode> {
	const m = USER_DRIVEN_WORDS.exec(said ?? "");
	if (m) return { value: "user-driven", reason: `you said "${m[0]}"` };
	return { value: "autonomous", reason: "handed over and left" };
}

/** Jo asked for a plan first (decision 15): the plan-first trigger "your word". Mode is unaffected. */
export function saidPlanIt(said: string): boolean {
	return PLAN_IT_WORDS.test(said ?? "");
}

/**
 * Jo said "no plan" (PLAN.md D4): `no plan` / `no-plan`, any case, anywhere in the brief. An
 * occurrence quoted on its own (`"no plan"`, `'no plan'`, curly quotes, backticks) is a mention, as
 * in `or I say "no plan"`, and does not count; inside a longer quoted span it counts, because the
 * orchestrator quotes Jo's whole message (`Jo: "… no plan, just fix it"`).
 */
export function saidNoPlan(said: string): boolean {
	const s = said ?? "";
	for (const m of s.matchAll(NO_PLAN_WORDS)) {
		const open = s[m.index - 1];
		const close = s[m.index + m[0].length];
		const mention = open !== undefined && QUOTE_PAIRS[open] !== undefined && close === QUOTE_PAIRS[open];
		if (!mention) return true;
	}
	return false;
}

/** The open-time judge's answer over the brief; null when no judge is wired, it failed, or it answered malformed. */
export interface JudgedSize {
	choice: string;
	confidence: number;
}

// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
/** The judge found a large change: change-large above the low-confidence threshold. The ceiling's ×3 follows exactly this (PLAN.md D5). */
export function judgedLarge(judged: JudgedSize | null): boolean {
	return judged !== null && judged.choice === "change-large" && judged.confidence > LOW_CONFIDENCE_THRESHOLD;
}

/**
 * Where a plan skip came from (PLAN.md D4): Jo's unquoted "no plan" in the brief (`brief`), or the
 * orchestrator's `plan: "none"` argument with no such phrase in the brief (`argument`).
 */
export type NoPlanSource = "brief" | "argument";

/**
 * The plan-first trigger at open (decision 15, amended by MIGRATION.md item 42; PLAN.md D1–D3), or
 * null for no plan, with one line saying why for the open tool's result. Precedence: production
 * always; then Jo's plan words (`your word`, even beside "no plan"); then "no plan"; then the judge.
 * Normal stakes are plan-first unless the judge answered change-small at PLAN_SKIP_CONFIDENCE or
 * higher, so a missing or failed judgment fails toward a plan; throwaway is plan-first only on a
 * judged large change. `noPlan` names the skip's source, so the note says who asked for it.
 */
export function planFirstTrigger(input: { stakes: Stakes; saidPlan: boolean; noPlan: NoPlanSource | null; judged: JudgedSize | null }): { trigger: string | null; note: string } {
	const { stakes, saidPlan, noPlan, judged } = input;
	const skip = noPlan === "argument" ? 'plan: "none"' : '"no plan"';
	if (stakes === "production") {
		return { trigger: "production", note: `plan first: production stakes${noPlan ? `; ${skip} does not lift it at production stakes` : ""}.` };
	}
	if (saidPlan) return { trigger: "your word", note: `plan first: your word${noPlan ? `, which wins over ${skip}` : ""}.` };
	if (noPlan === "brief") return { trigger: null, note: 'no plan first: you said "no plan".' };
	if (noPlan === "argument") return { trigger: null, note: 'no plan first: the orchestrator passed plan: "none".' };
	const answered = judged ? `the brief was judged ${judged.choice} ${judged.confidence.toFixed(2)}` : "the brief was not sized";
	if (judgedLarge(judged)) return { trigger: "large change", note: `plan first: large change (${answered}).` };
	if (stakes === "throwaway") return { trigger: null, note: `no plan first at throwaway stakes: ${answered}, not a large change.` };
	if (judged !== null && judged.choice === "change-small" && judged.confidence >= PLAN_SKIP_CONFIDENCE) {
		return { trigger: null, note: `no plan first: ${answered}, at or above ${PLAN_SKIP_CONFIDENCE.toFixed(2)}.` };
	}
	return { trigger: "default", note: `plan first by default: ${answered}; only change-small at ${PLAN_SKIP_CONFIDENCE.toFixed(2)} or higher, or "no plan", skips it.` };
}
