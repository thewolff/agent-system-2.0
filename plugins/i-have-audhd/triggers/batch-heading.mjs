// batch-heading.mjs — do-not-batch-by-label trigger: a trailing section whose heading is a batch label.
//
// WHAT THIS DECIDES (the deterministic half only)
//   Does the message END with a labeled section — a heading like "Uncertainties", "Open
//   questions", "Questions", "Caveats", "Notes" — that contains substance? That is the
//   TRIGGER. Whether that section is a violation is a judgment and belongs to the judge:
//   sweeping detached questions into a terminal dump is the violation; a legitimate terminal
//   summary is not; and the needs-you-first rule REQUIRES a lead section pulling decisions to
//   the top, which is compliant with this rule by design. A deterministic version of the
//   judgment would fight that rule directly.
//
// WHAT COUNTS AS THE TRIGGER
//   - A heading is a #{1,6} line, or a bold pseudo-heading line ("**Notes**") whose normalized
//     text equals a configured batch heading.
//   - The matched heading must be the LAST heading in the text — a "## Questions" buried
//     mid-message under later sections is not the trailing dump this rule is about.
//   - The section after it must contain at least one prose line; an empty labeled section is
//     ceremony, not a dump, and the trigger stays quiet.
//
// Usage:
//   import { findTrailingBatchSection, batchByLabelQuestion, batchJudgeContext } from "./batch-heading.mjs";

import { classifyLines } from "../checks/lines.mjs";

const DEFAULT_HEADINGS = ["Uncertainties", "Open questions", "Questions", "Caveats", "Notes"];

export const batchByLabelQuestion =
  "Rule 'do not batch by label': keep each item with the thing it is about, and order by what " +
  "needs the reader, not by kind. Known tension, adjudicated in this rule's favor when they " +
  "conflict: needs-you-first REQUIRES pulling decisions and open questions into a lead section " +
  "at the TOP of the message — such a lead section is COMPLIANT, never a violation. The " +
  "violation is a TRAILING labeled section (a heading like Uncertainties, Open questions, " +
  "Questions, Caveats, Notes) that sweeps detached questions, caveats, or findings into a " +
  "terminal dump instead of placing each item with its subject. Judge the message below, whose " +
  "trailing section is marked: is that marked section a batched dump by label, or a legitimate " +
  "terminal summary? Answer violation=true only for a detached dump. When unsure, answer " +
  "violation=false.";

export function findTrailingBatchSection(text, options = {}) {
  const headings = (Array.isArray(options.headings) && options.headings.length ? options.headings : DEFAULT_HEADINGS)
    .map((h) => String(h).toLowerCase().replace(/\s*:\s*$/, "").trim())
    .filter(Boolean);
  const wanted = new Set(headings);

  const lines = classifyLines(text);

  // Heading candidates: # headings (normalized), plus bold pseudo-headings whose normalized
  // text IS a batch heading.
  let lastCandidate = null; // { number, heading }
  let lastHashHeading = 0;
  for (const { number, kind, norm, raw } of lines) {
    if (kind === "heading") {
      lastHashHeading = number;
      if (norm && wanted.has(norm.toLowerCase())) lastCandidate = { number, heading: norm };
    } else if (kind === "prose" && norm) {
      // A bolded one-word line reading as a section label, e.g. "**Notes**".
      if (wanted.has(norm.toLowerCase()) && /^\s*\*\*.+\*\*\s*$/.test(raw)) {
        lastCandidate = { number, heading: norm };
      }
    }
  }

  const empty = { applicable: false, heading: null, headingLine: null, sectionText: "", sectionProseChars: 0 };
  if (!lastCandidate) return empty;

  // Trailing means no # heading follows the candidate: a labeled section with whole sections
  // after it is mid-message, and mid-message grouping is not this trigger.
  if (lastHashHeading > lastCandidate.number) return empty;

  let sectionText = "";
  let proseChars = 0;
  for (const { number, kind, norm, raw } of lines) {
    if (number <= lastCandidate.number) continue;
    sectionText += raw + "\n";
    if (kind === "prose") proseChars += norm.length;
  }
  if (proseChars === 0) return empty; // empty labeled section: ceremony, not a dump

  return {
    applicable: true,
    heading: lastCandidate.heading,
    headingLine: lastCandidate.number,
    sectionText: sectionText.trimEnd(),
    sectionProseChars: proseChars,
  };
}

// Everything the judge sees beyond the static question: the whole message, plus the trailing
// section marked out so the judge does not have to find it. Variable data rides in the
// context, never in the question, so the verdict cache key covers all of it.
export function batchJudgeContext(text, section) {
  return (
    `${text}\n\n--- TRAILING SECTION UNDER JUDGMENT (heading "${section.heading}", line ${section.headingLine}) ---\n` +
    `${section.sectionText}\n--- END OF SECTION ---`
  );
}
