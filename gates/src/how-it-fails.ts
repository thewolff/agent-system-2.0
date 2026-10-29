// The "How it fails" gate's one matcher (Jo, 2026-10-28, issue #334 item 2 as Jo extended it): every
// brief the orchestrator opens a workload with, every plan a lane raises for approval, and every change
// card a paired lane proposes carries a "How it fails" section, or is refused back to its writer to fix
// and resubmit. The entry points are surface/extensions/workload.ts (the open tool),
// surface/src/launch.ts planQuestionProblem (lane_raise_question's plan check, auto-start included) and
// gates/src/pair-card.ts (pair_propose). Each reads the text through checkHowItFails here and nowhere else,
// so the three cannot disagree on what counts. Plumb's own brief gate (an OMP extension outside this
// repository) uses the same three patterns, agreed 2026-10-28.
//
// What counts:
// - a heading line, any level 1 to 6, case-insensitive, whose text is "How it fails" (a trailing colon
//   and closing hashes allowed), followed by at least one non-blank line before the next heading line
//   or the end of the text; or
// - the explicit line `How it fails: n/a, <reason>` (the reason required, the line may itself be a
//   heading), for trivial work. The gate's caller records every pass on this line, so a skipped
//   section is visible afterwards.
//
// How it fails, for the gate itself: the matcher is pure and has no I/O. If it throws anyway, the
// check fails closed: the refusal names the error and the bypass line (`How it fails: n/a, gate error
// <what you saw>`), found with plain string search, which cannot throw. A resubmission carrying it passes
// and the caller records the bypass with the error. A refusal never retries anything itself: the writer
// gets it once per submission.

/** The heading a writer is told to add. */
export const HOW_IT_FAILS_HEADING = "## How it fails";
/** The one-line form for trivial work. */
export const HOW_IT_FAILS_NA_LINE = "How it fails: n/a, <reason>";
/** What the bypass line starts with, lower-cased (it is an n/a line whose reason starts `gate error`). */
const BYPASS_MARK = "how it fails: n/a, gate error";

/** A heading line whose text is "How it fails". */
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+how it fails[ \t]*:?[ \t]*#*[ \t]*$/i;
/** Any markdown heading line: it ends a section. */
const ANY_HEADING = /^[ \t]{0,3}#{1,6}[ \t]/;
/** The n/a line, optionally written as a heading; the reason is required. */
const NA = /^[ \t]*(?:#{1,6}[ \t]+)?how it fails:[ \t]*n\/a,[ \t]*(\S.*)$/i;

/** How a text carries the section: a heading with content, or the n/a line and its reason; null when neither. */
export type HowItFailsMatch = { via: "section" } | { via: "n/a"; reason: string };

/** The matcher: a section wins over an n/a line in the same text. */
export function matchHowItFails(text: string): HowItFailsMatch | null {
	const lines = text.split(/\r?\n/);
	let na: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (HEADING.test(line)) {
			for (let j = i + 1; j < lines.length && !ANY_HEADING.test(lines[j]!); j++) {
				if (lines[j]!.trim() !== "") return { via: "section" };
			}
			continue;
		}
		if (na === null) {
			const m = NA.exec(line);
			if (m) na = m[1]!.trim();
		}
	}
	return na === null ? null : { via: "n/a", reason: na };
}

export type HowItFailsVerdict =
	| { ok: true; via: "section" }
	| { ok: true; via: "n/a"; reason: string }
	/** The matcher threw and the text carries the bypass line: it passes, and the caller records the error. */
	| { ok: true; via: "bypass"; error: string }
	| { ok: false; reason: string };

/** Why `what` is refused: the missing section, the expected heading, the n/a form, and that it is resubmittable. */
export function howItFailsRefusal(what: string): string {
	return (
		`${what} has no "How it fails" section. Add a heading \`${HOW_IT_FAILS_HEADING}\` (any level) with at least one line under it naming ` +
		"what errors the work can hit, where each one surfaces, the recovery step and the retry bound; for trivial work, one line " +
		`\`${HOW_IT_FAILS_NA_LINE}\` instead (its use is recorded). Fix it and submit again`
	);
}

/**
 * The gate: `text` (named `what` in the refusal, e.g. "the brief") passes when `match` finds a section or an n/a line.
 * `match` is the matcher above except in a test of the error path.
 */
export function checkHowItFails(text: string, what: string, match: (text: string) => HowItFailsMatch | null = matchHowItFails): HowItFailsVerdict {
	let found: HowItFailsMatch | null;
	try {
		found = match(text);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		if (text.toLowerCase().includes(BYPASS_MARK)) return { ok: true, via: "bypass", error };
		return {
			ok: false,
			reason:
				`the "How it fails" gate itself errored on ${what} (${error}), so it refused rather than pass it unchecked. ` +
				"To pass while the gate is broken, add the line `How it fails: n/a, gate error <what you saw>` and submit again; that pass is recorded with this error",
		};
	}
	if (found === null) return { ok: false, reason: howItFailsRefusal(what) };
	return found.via === "section" ? { ok: true, via: "section" } : { ok: true, via: "n/a", reason: found.reason };
}

/** The ledger note a pass on the n/a line or the bypass leaves, naming where it passed; null for a section. */
export function howItFailsNote(v: HowItFailsVerdict, where: string): string | null {
	if (!v.ok || v.via === "section") return null;
	return v.via === "n/a" ? `how-it-fails: n/a, ${v.reason} (${where})` : `how-it-fails: gate error bypassed (${v.error}) (${where})`;
}
