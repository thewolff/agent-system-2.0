// conclusion-first.mjs — conclusion-first trigger: long enough, and structured in paragraphs.
//
// WHAT THIS DECIDES (the deterministic half only)
//   Is the message ≥ 400 substantive chars AND ≥ 2 substantive paragraphs? That is the
//   trigger. Whether the FIRST substantive sentence states the message's decision or verdict
//   — versus being setup — is a judgment and belongs to the judge. A keyword version of that
//   judgment fires on every message that opens with context for a good reason, which is most
//   of them.
//
// WHY 400 AND 2
//   The needs-you floor (200) protects short exchanges from structural checks; this rule
//   needs more, because "conclusion first" is trivially satisfied by any one-paragraph
//   answer — there is nowhere else for the point to be. Two paragraphs is the minimum shape
//   in which a conclusion CAN be buried.
//
// WHAT A PARAGRAPH IS
//   A run of prose lines broken by a blank line, a heading, or a fence. List items are prose
//   (the bullet is stripped); an HTML-comment envelope does not break a paragraph.
//
// Usage:
//   import { conclusionFirstApplicable, conclusionFirstQuestion } from "./conclusion-first.mjs";

import { classifyLines } from "../checks/lines.mjs";

const DEFAULTS = { minProseChars: 400, minParagraphs: 2 };

export const conclusionFirstQuestion =
  "Rule 'conclusion first': state the conclusion before the evidence. The FIRST substantive " +
  "sentence of the message should carry its decision, verdict, or point, or point directly at " +
  "it, rather than being setup or context that only later earns the answer. Weigh these " +
  "COMPLIANT shapes honestly: a short answer whose first sentence naturally orients the " +
  "reader; a first sentence that IS the summary even when it reads as narrative; a bad-news " +
  "message that opens by naming the bad news; a message whose substance genuinely is the " +
  "setup (a question, an acknowledgement). Answer violation=true only when the message " +
  "plainly buries a decision or verdict the reader needs below opening context. When unsure, " +
  "answer violation=false.";

export function conclusionFirstApplicable(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const minProseChars = Number(opts.minProseChars) || DEFAULTS.minProseChars;
  const minParagraphs = Number(opts.minParagraphs) || DEFAULTS.minParagraphs;

  let proseChars = 0;
  let paragraphs = 0;
  let inParagraph = false;

  for (const { kind, norm } of classifyLines(text)) {
    if (kind === "prose") {
      proseChars += norm.length;
      if (!inParagraph) {
        paragraphs += 1;
        inParagraph = true;
      }
    } else if (kind === "structural" || kind === "heading" || kind === "fence") {
      inParagraph = false; // blank line, heading, or a code block ends the run
    }
    // fenced/comment lines carry no text and do not break a paragraph run
  }

  return {
    applicable: proseChars >= minProseChars && paragraphs >= minParagraphs,
    proseChars,
    paragraphs,
  };
}
