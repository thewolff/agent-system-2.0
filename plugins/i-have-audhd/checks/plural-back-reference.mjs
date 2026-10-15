#!/usr/bin/env node
// plural-back-reference.mjs — skill rule 6: the closing ask restates its own subject in full.
//
// WHAT IT DECIDES
//   Given one message that HAS a closing-ask marker: does the ask lean on a plural
//   back-reference — "those", "these", "both", "them", "the two", "either one" — whose referent
//   sits outside its own sentence? The ask is the line the reader acts on, often read alone;
//   "Should I merge those?" makes them scroll up to learn what "those" were.
//
// WHERE THE ASK IS
//   Exactly where closing-ask-last.mjs puts it: the FIRST marker line plus the one paragraph
//   that follows it (blanks skipped; a heading or fence right after the marker leaves it empty).
//   Same marker matching, through the shared line classification in lines.mjs.
//
// WHAT ACQUITS A HIT
//   The sentence naming its own referents, in one of three shapes:
//     correlative   both A and B / either one of A or B — where A is not "of", "and" or "or",
//                   so "both of the files named above" stays a hit
//     apposition    the word (and at most one noun), then ":", "(" or a dash and a list joined
//                   by and/or/commas; or a "," followed by two or more named items
//     antecedent    them/those/these/both preceded in the sentence by two or more named items
//   Named items are inline code spans and double-quoted strings. They are masked before the
//   lexicon search, so `git rm these` inside backticks is never a hit. Anything else points
//   outside the sentence and is the finding.
//
// WHY NO LENGTH FLOOR HERE
//   The phrase is wrong at any length. The Stop hook's 200-char master floor still gates when
//   the hook runs it, so short replies are never checked there.
//
// WHY WARN
//   A word-level heuristic with no measured false-positive rate. The Stop hook registers it at
//   warn, like every other rule; findings land in warnings.log.
//
// Usage:
//   import { checkPluralBackReference } from "./plural-back-reference.mjs";
//   node plural-back-reference.mjs message.md    # prints one JSON object, exit 0
//   printf '## Closing ask\nShould I merge those?\n' | node plural-back-reference.mjs

import { classifyLines } from "./lines.mjs";

const DEFAULTS = {
  markers: ["Closing ask"],
  lexicon: ["those", "these", "both", "them", "the two", "either one"],
};

// Inline code and double-quoted strings are named items: masked to one placeholder each
// before sentence splitting and the lexicon search, then counted as named referents.
const NAMED_SPAN = /`[^`\n]+`|"[^"\n]+"/g;
const PLACEHOLDER = "NAMEDITEM";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Sentences end at . ? or ! followed by whitespace. The placeholder carries no punctuation,
// so a path like `a.ts` cannot split a sentence.
function sentencesOf(text) {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const namedItemCount = (fragment) => fragment.split(PLACEHOLDER).length - 1;

// True when the sentence names the referent of the lexicon word found at [start, end).
function referentInSentence(sentence, word, start, end) {
  const before = sentence.slice(0, start);
  const after = sentence.slice(end);

  // Correlative: both A and B; either one of A or B.
  if (word === "both" && /^\s+(?!(?:of|and|or)\b)\S[^.?!]*?\band\s+\S/i.test(after)) return true;
  if (word === "either one" && /^\s+of\s+(?!(?:and|or)\b)\S[^.?!]*?\bor\s+\S/i.test(after)) return true;

  // Apposition, after at most one noun ("the two files: …"). A colon, parenthesis or dash
  // opens a list of plain nouns; a comma opens one only when it names two items, because
  // "those, then deploy and tag" is a clause, not a list.
  const opener = after.match(/^\s*[^\s.?!:(,—–]*\s*(:|\(|—|–|\s-\s|,)/);
  if (opener) {
    const rest = after.slice(opener[0].length);
    if (opener[1] === ",") {
      if (namedItemCount(rest.split(/[.?!]/)[0]) >= 2) return true;
    } else if (/^\s*(?!(?:and|or)\b)[^\s.?!][^.?!]*?(?:\band\b|\bor\b|,)\s*\S/i.test(rest)) {
      return true;
    }
  }

  // Named antecedent earlier in the same sentence.
  if (["them", "those", "these", "both"].includes(word) && namedItemCount(before) >= 2) return true;

  return false;
}

export function checkPluralBackReference(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const markers = (Array.isArray(opts.markers) && opts.markers.length ? opts.markers : DEFAULTS.markers)
    .map((m) => String(m).toLowerCase().replace(/\s*:\s*$/, "").trim())
    .filter(Boolean);
  const lexicon = (Array.isArray(opts.lexicon) && opts.lexicon.length ? opts.lexicon : DEFAULTS.lexicon)
    .map((w) => String(w).toLowerCase().trim())
    .filter(Boolean);

  const result = {
    applicable: false,
    flagged: false,
    reason: "no-marker",
    markerLine: null,
    askText: "",
    hits: [],
  };

  // Collect the ask paragraph, same section semantics as closing-ask-last.mjs.
  const askLines = [];
  let inAsk = false;
  for (const { number, raw, kind, norm } of classifyLines(text)) {
    if (result.markerLine === null) {
      if (kind === "heading" || kind === "prose") {
        const lower = norm.toLowerCase();
        if (markers.some((m) => lower === m || lower.startsWith(m + " "))) {
          result.markerLine = number;
        }
      }
      continue;
    }
    if (kind === "prose") {
      inAsk = true;
      askLines.push({ number, raw });
    } else if (kind === "heading" || kind === "fence") {
      break;
    } else if (inAsk && (kind === "structural" || kind === "comment")) {
      break;
    }
  }

  if (result.markerLine === null) return result;
  result.applicable = true;
  if (!askLines.length) {
    result.reason = "empty-ask";
    return result;
  }
  result.askText = askLines.map((l) => l.raw.trim()).join(" ");

  // One masked text for the whole paragraph, so a sentence wrapped across lines stays whole.
  // A hit's line is the ask line its sentence starts on.
  const masked = askLines.map((l) => l.raw.trim().replace(NAMED_SPAN, PLACEHOLDER)).join("\n");
  const wordRe = new RegExp(`\\b(?:${lexicon.map((w) => escapeRe(w).replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
  let sawWord = false;
  let cursor = 0;
  for (const sentence of sentencesOf(masked)) {
    const start = masked.indexOf(sentence, cursor);
    cursor = start + sentence.length;
    const line = askLines[masked.slice(0, start).split("\n").length - 1].number;
    for (const m of sentence.matchAll(wordRe)) {
      sawWord = true;
      const word = m[0].toLowerCase().replace(/\s+/g, " ");
      if (!referentInSentence(sentence, word, m.index, m.index + m[0].length)) {
        result.hits.push({ word, line, sentence: sentence.replace(/\s+/g, " ") });
      }
    }
  }

  if (result.hits.length) {
    result.flagged = true;
    result.reason = "referent-outside-sentence";
  } else {
    result.reason = sawWord ? "referent-in-sentence" : "no-plural-reference";
  }
  return result;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const { readFileSync } = await import("node:fs");
  const path = process.argv[2];
  let text = "";
  try {
    text = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `could not read ${path || "stdin"}: ${err.message}` }) + "\n");
    process.exit(0); // log-only, including its own failures
  }
  process.stdout.write(JSON.stringify(checkPluralBackReference(text), null, 2) + "\n");
  process.exit(0);
}
