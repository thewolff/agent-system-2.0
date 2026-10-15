// bad-news-lexicon.mjs — bad-news-first trigger: a negative-lexicon gate over a substantive message.
//
// WHAT THIS DECIDES (the deterministic half only)
//   Does the message have ≥ 200 substantive chars AND contain a word from the negative
//   lexicon (failed, failure, error, broke, broken, blocker, regression, cannot, can't,
//   rejected, lost, missed, wrong — configurable)? That is the TRIGGER. Lexicon words match
//   at word START, case-insensitively, so "errors" matches "error" and "terror" does not.
//
// WHY THE GATE IS DELIBERATELY OVER-INCLUSIVE
//   "Fixed the error" and "tests failed yesterday, now green" both trip this gate while
//   carrying no bad news at all. That is fine, because the gate decides APPLICABILITY, not
//   guilt: whether a message contains GENUINELY bad news — and whether the first substantive
//   sentence states it — is the whole judgment, and it belongs to the judge. A deterministic
//   version of that judgment would flag every message that mentions an error on its way to
//   reporting success.
//
// Usage:
//   import { badNewsGate, badNewsQuestion } from "./bad-news-lexicon.mjs";

import { classifyLines, proseCharCount } from "../checks/lines.mjs";

const DEFAULTS = {
  minProseChars: 200,
  lexicon: [
    "failed", "failure", "error", "broke", "broken", "blocker", "regression",
    "cannot", "can't", "rejected", "lost", "missed", "wrong",
  ],
};

export const badNewsQuestion =
  "Rule 'bad news first': when a message carries genuinely bad news — a failure, a blocker, a " +
  "loss, a rejection — the FIRST substantive sentence states it or directly points to it. Not " +
  "after the context that explains it; the explanation is welcome and goes second. Weigh this " +
  "honestly: technical prose that merely CONTAINS the words error, failed, or broken while " +
  "reporting success ('fixed the error', 'tests failed yesterday, now green') is NOT bad " +
  "news — bad news is a present, unresolved cost to the reader. Answer violation=true only " +
  "when the message contains genuinely bad news AND the first substantive sentence neither " +
  "states it nor directs the reader to it. When unsure, or when there is no genuinely bad " +
  "news, answer violation=false.";

export function badNewsGate(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const lexicon = (Array.isArray(opts.lexicon) && opts.lexicon.length ? opts.lexicon : DEFAULTS.lexicon)
    .map((w) => String(w).toLowerCase().trim())
    .filter(Boolean);
  const minProseChars = Number(opts.minProseChars) || DEFAULTS.minProseChars;

  // The gate scans SUBSTANTIVE lines only (prose and headings): a lexicon word inside a code
  // fence is an example of the word, not news, and quoted material is not the author's
  // assertion — same line semantics as every other check in this plugin.
  const lines = classifyLines(String(text ?? ""));
  let proseChars = 0;
  let substantive = "";
  for (const { kind, norm } of lines) {
    if (kind === "prose") proseChars += norm.length;
    if ((kind === "prose" || kind === "heading") && norm) substantive += norm.toLowerCase() + "\n";
  }

  const result = { applicable: false, proseChars, hits: [] };
  if (proseChars < minProseChars) return result;

  const hits = lexicon.filter((word) =>
    new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")}`).test(substantive),
  );
  result.hits = hits;
  result.applicable = hits.length > 0;
  return result;
}
