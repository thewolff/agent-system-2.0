// P-11 row 5 (DESIGN-2.0.md:342; C3.12; SPEC-2.0.md:533-547 § B9): a dispatch carries all six
// brief fields — workload id, task, done-condition, inputs, stakes, ceiling share — refused otherwise.
// Jo, 2026-10-28 (issue #334 item 2): every brief also carries a "How it fails" section (../how-it-fails.ts),
// and so does every change card a paired lane proposes (`pair_propose`, a paired lane's plan).
import { checkHowItFails, type HowItFailsVerdict } from "../how-it-fails";
import type { Refusal } from "../types";
import { dispatchItems } from "./r04-tier-name";

export const BRIEF_FIELDS = ["workload", "task", "done-condition", "inputs", "stakes", "ceiling-share"] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];

/**
 * One field line: optional list marker, optional bold around the name, a colon, a value. Shared
 * with M3's classifier, which reads `stakes` with the same syntax and the same task-then-context
 * lookup (agreed agent://M3TierClassifier, 2026-09-28).
 */
export const FIELD_LINE =
	/^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(workload|task|done-condition|inputs|stakes|ceiling-share)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(\S.*?)[ \t]*$/gim;

const VALUE_CHECK: Partial<Record<BriefField, { re: RegExp; want: string }>> = {
	workload: { re: /^wl-\S+$/, want: "a ledger workload id (wl-…)" },
	stakes: { re: /^(throwaway|normal|production)$/i, want: "throwaway | normal | production" },
	"ceiling-share": { re: /^\d+(?:\.\d+)?%?$/, want: "a number" },
};

/** Field values in `text`, first occurrence of each field wins. */
export function briefFields(text: string): Partial<Record<BriefField, string>> {
	const out: Partial<Record<BriefField, string>> = {};
	for (const m of text.matchAll(FIELD_LINE)) {
		const name = m[1]!.toLowerCase() as BriefField;
		out[name] ??= m[2]!;
	}
	return out;
}

/**
 * The texts a dispatch item's brief is read from for its "How it fails" section: the batch context and the item's task, each
 * matched on its own (an empty section at the end of the context is not filled by the task's first line). Row 5 and its n/a
 * note read the same texts, and so does the classifier's check of its own rewrite.
 */
export function briefTexts(context: string, task: string): string[] {
	return [context, task];
}

/**
 * Refuses a `task` call any of whose items lacks a field (looked up in the item's task, then the
 * batch context). When the session is bound to a workload (AGENT_SYSTEM_WORKLOAD_ID), a brief whose
 * `workload:` names another one is refused too (M4 fix round 4, S6; triad #7/#12). Each item carries
 * a "How it fails" section or the n/a line in its task or the batch context (issue #334 item 2).
 */
export function checkBriefFields(input: Record<string, unknown>, boundWorkload: string | null = null): Refusal {
	const context = typeof input.context === "string" ? input.context : "";
	const shared = briefFields(context);
	const problems: string[] = [];
	dispatchItems(input).forEach((item, i) => {
		const task = typeof item.task === "string" ? item.task : "";
		const fields = { ...shared, ...briefFields(task) };
		for (const f of BRIEF_FIELDS) {
			const v = fields[f];
			if (v === undefined) problems.push(`item ${i}: missing "${f}:"`);
			else if (VALUE_CHECK[f] && !VALUE_CHECK[f]!.re.test(v)) problems.push(`item ${i}: "${f}: ${v}" is not ${VALUE_CHECK[f]!.want}`);
			else if (f === "workload" && boundWorkload && v !== boundWorkload) problems.push(`item ${i}: "workload: ${v}" is not this session's workload ${boundWorkload}`);
		}
		const fails = checkHowItFails(briefTexts(context, task), `item ${i}'s brief`);
		if (!fails.ok) problems.push(`item ${i}: ${fails.reason}`);
	});
	if (problems.length === 0) return null;
	return {
		block: true,
		reason:
			`P-11 row 5 refused this dispatch: a slice brief carries all six § B9 fields, one per line, and a "How it fails" section, in the item's task or the batch context. ` +
			`${problems.join("; ")}. Shape:\nworkload: ${boundWorkload ?? "wl-…"}${boundWorkload ? " (this session's workload)" : ""}\ntask: <one paragraph>\ndone-condition: <the runtime artifact that closes the slice>\n` +
			`inputs: <paths and branch the hand may touch>\nstakes: throwaway | normal | production\nceiling-share: <number>\n` +
			"## How it fails\n<the errors the work can hit, where each surfaces, the recovery step, the retry bound; or instead the one line `How it fails: n/a, <reason>`>\n" +
			`and the item's \`name\` is the slice id: [A-Za-z0-9_-]{1,48}, an existing slice of the workload. Fix the brief and dispatch again.`,
	};
}

/** The text fields of a `pair_propose` change card (plugins/paired-coding/omp/paired-coding-omp.ts), in the order the card shows them. */
const CARD_FIELDS = ["whyNow", "decision", "currentCode", "proposedCode", "effect", "checks", "openPoints"] as const;

/** A change card's texts, one per field (a list field's items one per line within it), each matched on its own for "How it fails". */
export function cardTexts(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const f of CARD_FIELDS) {
		const v = input[f];
		if (typeof v === "string") out.push(v);
		else if (Array.isArray(v)) out.push(v.filter((x): x is string => typeof x === "string").join("\n"));
	}
	return out;
}

/**
 * Issue #334 item 2 for a paired lane: a `pair_propose` card is that lane's plan, so its text carries a "How it fails"
 * section (a heading inside a field, e.g. at the end of `effect`) or the n/a line. Returns the refusal (null when it
 * passes) and the verdict, so the caller can record an n/a or bypass pass.
 */
export function checkCard(input: Record<string, unknown>): { refusal: Refusal; verdict: HowItFailsVerdict } {
	const verdict = checkHowItFails(cardTexts(input), "this change card");
	if (verdict.ok) return { refusal: null, verdict };
	return {
		refusal: {
			block: true,
			reason:
				`P-11 row 5 refused this pair_propose: ${verdict.reason}. Put the section in one of the card's text fields, e.g. end \`effect\` with a "## How it fails" line and the lines under it. ` +
				"No card was recorded; propose it again.",
		},
		verdict,
	};
}
