// The "How it fails" gate's one matcher (Jo, 2026-10-28, issue #334 item 2 as Jo extended it): every
// brief the orchestrator opens a workload with, every plan a lane raises for approval, every brief a lane
// dispatches to a hand, and every change card a paired lane proposes carries a "How it fails" section, or
// is refused back to its writer to fix and resubmit. The entry points are surface/extensions/workload.ts
// (the open tool), surface/src/launch.ts planQuestionProblem (lane_raise_question's plan check, auto-start
// included), and P-11 row 5 in gates/src/rows/r05-brief-fields.ts (`task` dispatches and `pair_propose`
// cards); the classifier re-checks its own fan-out rewrite (classifier/extension.ts). Each reads text
// through checkHowItFails here and nowhere else, so they cannot disagree on what counts. Plumb's own brief
// gate (an OMP extension outside this repository) uses the same rules.
//
// What counts, read line by line outside fenced code blocks (``` or ~~~, at least three, closed by the
// same character at least as long). A fenced line is never a heading, never an n/a line, never content:
// - a heading line, any level 1 to 6, case-insensitive, whose text is "How it fails" (a trailing colon
//   and closing hashes allowed), followed by at least one non-blank, non-heading line outside a fence
//   before the next heading of the same or a shallower level, or the end of the text. A deeper heading
//   inside the section (### Push fails under ## How it fails) neither ends it nor counts as content; or
// - the explicit line `How it fails: n/a, <reason>` (the reason required, the line may itself be a
//   heading), for trivial work. The gate's caller records every pass on this line, so a skipped
//   section is visible afterwards.
// When a call carries several texts (a dispatch's batch context and task, a card's fields), each text
// is matched on its own: one text's lines never fill another text's empty section.
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

/** A heading line whose text is "How it fails"; group 1 is its hashes. */
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+how it fails[ \t]*:?[ \t]*#*[ \t]*$/i;
/** Any markdown heading line; group 1 is its hashes. */
const ANY_HEADING = /^[ \t]{0,3}(#{1,6})(?:[ \t]|$)/;
/** The n/a line, optionally written as a heading; the reason is required. */
const NA = /^[ \t]*(?:#{1,6}[ \t]+)?how it fails:[ \t]*n\/a,[ \t]*(\S.*)$/i;
/** A fence opener: group 1 is its run of backticks or tildes. */
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;
/** A fence closer: only the run (and trailing blanks) on the line. */
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

/** How a text carries the section: a heading with content, or the n/a line and its reason; null when neither. */
export type HowItFailsMatch = { via: "section" } | { via: "n/a"; reason: string };

/** Where a text carries it: the matched lines, `[start, end)`, the section's heading through its last line, or the n/a line. */
type Located = { match: HowItFailsMatch; start: number; end: number };

function locate(text: string): Located | null {
	const lines = text.split(/\r?\n/);
	let fence: { char: string; len: number } | null = null;
	/** The open "How it fails" section: its heading's line, its depth, and whether a content line was seen. */
	let open: { start: number; depth: number; content: boolean } | null = null;
	let na: Located | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (fence !== null) {
			const c = FENCE_CLOSE.exec(line);
			if (c && c[1]![0] === fence.char && c[1]!.length >= fence.len) fence = null;
			continue;
		}
		const f = FENCE_OPEN.exec(line);
		if (f) {
			fence = { char: f[1]![0]!, len: f[1]!.length };
			continue;
		}
		const h = ANY_HEADING.exec(line);
		if (h) {
			const depth = h[1]!.length;
			if (open !== null && depth <= open.depth) {
				// The section ends here: with content it is the answer; empty, it is no section and the scan goes on.
				if (open.content) return { match: { via: "section" }, start: open.start, end: i };
				open = null;
			}
			if (HEADING.test(line)) {
				open = { start: i, depth, content: false };
				continue;
			}
		} else if (line.trim() !== "" && open !== null) {
			open.content = true;
		}
		if (na === null) {
			const m = NA.exec(line);
			if (m) na = { match: { via: "n/a", reason: m[1]!.trim() }, start: i, end: i + 1 };
		}
	}
	if (open?.content) return { match: { via: "section" }, start: open.start, end: lines.length };
	return na;
}

/** The matcher for one text: a section wins over an n/a line in the same text. */
export function matchHowItFails(text: string): HowItFailsMatch | null {
	return locate(text)?.match ?? null;
}

/** The lines that carry it in `text` (the whole section, or the n/a line), for a rewrite that must keep them; null when none. */
export function howItFailsLines(text: string): string | null {
	const at = locate(text);
	return at === null ? null : text.split(/\r?\n/).slice(at.start, at.end).join("\n").trimEnd();
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
 * The gate: `texts` (one text, or several matched each on its own; named `what` in the refusal, e.g. "the brief") pass when
 * `match` finds a section in any of them, else an n/a line in any of them. `match` is the matcher above except in a test of
 * the error path.
 */
export function checkHowItFails(
	texts: string | readonly string[],
	what: string,
	match: (text: string) => HowItFailsMatch | null = matchHowItFails,
): HowItFailsVerdict {
	const parts = typeof texts === "string" ? [texts] : texts;
	let na: { via: "n/a"; reason: string } | null = null;
	try {
		for (const part of parts) {
			const found = match(part);
			if (found?.via === "section") return { ok: true, via: "section" };
			if (found?.via === "n/a" && na === null) na = found;
		}
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		if (parts.some((p) => p.toLowerCase().includes(BYPASS_MARK))) return { ok: true, via: "bypass", error };
		return {
			ok: false,
			reason:
				`the "How it fails" gate itself errored on ${what} (${error}), so it refused rather than pass it unchecked. ` +
				"To pass while the gate is broken, add the line `How it fails: n/a, gate error <what you saw>` and submit again; that pass is recorded with this error",
		};
	}
	return na === null ? { ok: false, reason: howItFailsRefusal(what) } : { ok: true, ...na };
}

/** The ledger note a pass on the n/a line or the bypass leaves, naming where it passed; null for a section. */
export function howItFailsNote(v: HowItFailsVerdict, where: string): string | null {
	if (!v.ok || v.via === "section") return null;
	return v.via === "n/a" ? `how-it-fails: n/a, ${v.reason} (${where})` : `how-it-fails: gate error bypassed (${v.error}) (${where})`;
}
