// conclusion-first.mjs — conclusion-first trigger: long enough to bury a conclusion.
//
// WHAT THIS DECIDES (the deterministic half only)
//   Is the unit ≥ 400 substantive chars? That is the trigger. Whether the unit's opening 20
//   words state its decision or verdict — versus being setup — is a judgment and belongs to
//   the judge. A keyword version of that judgment fires on every message that opens with
//   context for a good reason, which is most of them. The Stop hook runs this per unit: each
//   block-labeled section of a labeled message, or the whole message when it has no labels
//   (checks/sections.mjs).
//
// WHY 400, AND NO PARAGRAPH MINIMUM
//   The needs-you floor (200) protects short exchanges from structural checks; this rule
//   needs more, because a short answer has little room to put anything before its point.
//   Until 1.1.0 the trigger also required two paragraphs, on the grounds that one paragraph
//   has nowhere to bury a conclusion. That held while "at the start" meant the first
//   sentence; it does not hold now that it means the first 20 words: a single 400-char
//   paragraph can carry its point at word 40.
//
// Usage:
//   import { conclusionFirstApplicable, conclusionFirstQuestion } from "./conclusion-first.mjs";

import { proseCharCount } from "../checks/lines.mjs";
import { OPENING_WORDS } from "../checks/sections.mjs";

const DEFAULTS = { minProseChars: 400 };

export const conclusionFirstQuestion =
  "Rule 'conclusion first': state the conclusion before the evidence. The reader decides " +
  `from a message's first ${OPENING_WORDS} words, so its decision, verdict, or point must appear in ` +
  `those opening ${OPENING_WORDS} words, or be directly pointed at by them, rather than arriving after ` +
  "setup or context that only later earns the answer. A long first sentence that reaches its " +
  `point only after word ${OPENING_WORDS} buries it. Weigh these COMPLIANT shapes honestly: a short ` +
  "answer whose opening words naturally orient the reader; opening words that ARE the summary " +
  "even when they read as narrative; a bad-news message whose opening words name the bad news; " +
  "a message whose substance genuinely is the setup (a question, an acknowledgement). Answer " +
  "violation=true only when the message plainly buries a decision or verdict the reader needs " +
  `past its opening ${OPENING_WORDS} words. When unsure, answer violation=false.`;

export function conclusionFirstApplicable(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const minProseChars = Number(opts.minProseChars) || DEFAULTS.minProseChars;
  const proseChars = proseCharCount(text);
  return { applicable: proseChars >= minProseChars, proseChars };
}
