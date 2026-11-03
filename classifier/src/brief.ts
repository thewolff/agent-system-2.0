/**
 * Reads § B9 brief fields off a dispatch. The line syntax is shared with M4's six-field gate
 * (agreed with the M4 hand 2026-09-28) so the two never read a different value for one field:
 * a line `field: value`, optionally bulleted (`-`/`*`) and/or bold (`**field**:`), looked up in
 * the item's `task` text first, then the batch `context`; the first match wins.
 */
import { isStakes, type Stakes } from "./route";

// SPEC-2.0.md § B9: the six brief fields a slice brief carries.
export type BriefField = "workload" | "task" | "done-condition" | "inputs" | "stakes" | "ceiling-share";

export const FIELD_LINE =
	/^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(workload|task|done-condition|inputs|stakes|ceiling-share)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(\S.*?)[ \t]*$/gim;

/**
 * A `slice:` line, the conditional § B9 field (8) M4's question gate reads (gates/src/rows/question.ts
 * DECLARED): same line syntax as FIELD_LINE, looked up in the task first, then the context.
 */
const SLICE_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?slice(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(\S.*?)[ \t]*$/gim;

/** The first `slice:` value in `task`, else in `context`; `null` when neither carries one. */
export function briefSlice(task: string | undefined, context: string | undefined): string | null {
	for (const text of [task, context]) {
		const match = text ? [...text.matchAll(SLICE_LINE)][0] : undefined;
		if (match) return match[1]!;
	}
	return null;
}

/** The first value of `field` in `task`, else in `context`; `null` when neither carries it. */
export function briefField(field: BriefField, task: string | undefined, context: string | undefined): string | null {
	for (const text of [task, context]) {
		if (!text) continue;
		for (const match of text.matchAll(FIELD_LINE)) {
			if (match[1]!.toLowerCase() === field) return match[2]!;
		}
	}
	return null;
}

/**
 * SPEC-2.0.md § B9 field (5): stakes, inherited from the workload. An absent or unreadable value
 * is `null`: no cap is applied and the record says so (the refusal is M4's six-field gate).
 */
export function briefStakes(task: string | undefined, context: string | undefined): Stakes | null {
	const value = briefField("stakes", task, context)?.toLowerCase() ?? null;
	return isStakes(value) ? value : null;
}

/**
 * A three-lab panel's brief field (PLAN wl-mv5m7qvgkxhpj4 § 3.2; classifier/src/panel.ts): `panel:
 * <staging run path>` dispatches one member per lab, `panel-synth: <staging run path>` the synthesis
 * hand. Same line syntax as FIELD_LINE; the first such line in `task`, else in `context`, wins.
 */
const PANEL_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(panel|panel-synth)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(\S.*?)[ \t]*$/gim;

export type PanelField = { field: "panel" | "panel-synth"; run: string };

export function briefPanel(task: string | undefined, context: string | undefined): PanelField | null {
	for (const text of [task, context]) {
		const match = text ? [...text.matchAll(PANEL_LINE)][0] : undefined;
		if (match) return { field: match[1]!.toLowerCase() as PanelField["field"], run: match[2]! };
	}
	return null;
}

/** `text` without its panel brief lines: a member's task does not name the staging run it never reads. */
export function withoutPanelLines(text: string): string {
	return text.replace(PANEL_LINE, "").replace(/\n{3,}/g, "\n\n");
}
