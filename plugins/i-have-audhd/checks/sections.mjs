// sections.mjs — the units the conclusion-first and bad-news-first judgments read, and each
// unit's opening window.
//
// WHY A MESSAGE IS SPLIT
//   A message written under the output-types contract is a run of block-labeled sections
//   (**PMDW**, **CLAIM**, **CITE**, **GUESS**, **ACTION**, **QUESTION**), and the reader reads
//   each labeled section as its own message: the first words under each label are where that
//   section's point or bad news has to be. Judging the whole message as one unit acquits a
//   section that buries its verdict whenever some other section opens well, and convicts on
//   bad news that does lead its own section but not the message. So those two judgments run
//   per section.
//
// WHAT A LABEL LINE IS
//   A prose line (checks/lines.mjs classifyLines: fences, HTML comments and blockquotes are
//   never prose) whose trimmed text is exactly one bold label — optionally with a basis in
//   parentheses inside the bold (**GUESS(inference)**) and a trailing colon (**CLAIM**:).
//   A label mid-sentence or in a bullet (`- **GUESS** the cache…`) is inline, not a section
//   opener: the output-types contract's "block-leading label" rule. The label set is a module
//   constant, not a profile setting; an operator with other block labels gets whole-message
//   judging.
//
// THE UNITS
//   No label line → one unit, the whole text unchanged (label null), so unlabeled messages are
//   judged exactly as before. Label lines present → the text before the first label is a
//   preamble unit (label null, dropped when it holds nothing), and each label line opens a unit
//   that runs to the next label line. The label line itself is dropped from the unit's text:
//   "PMDW" is never a section's opening word. A run of heading, blank and rule lines directly
//   above a label line belongs to the section that label opens, so a `## Errors` header above a
//   section never feeds the previous section's gates; any other heading stays where it falls.
//
// THE OPENING WINDOW
//   "At the start" is the unit's first 20 words, computed here rather than left to a judge's
//   reading of "first sentence": bad news at the end of a 40-word first sentence is buried.
//   The words are those of the unit's heading and prose lines in order, normalized the way
//   classifyLines normalizes them (hashes, bullets, emphasis stripped), so fenced, comment and
//   quoted lines never count. The window crosses line, sentence and paragraph boundaries.
//
// Usage:
//   import { splitLabeledSections, openingWords, OPENING_WORDS } from "./sections.mjs";

import { classifyLines } from "./lines.mjs";

export const SECTION_LABELS = ["PMDW", "CLAIM", "CITE", "GUESS", "ACTION", "QUESTION"];

// The opening window's size, in words. A module constant, not a profile setting.
export const OPENING_WORDS = 20;

// `**LABEL**`, `**LABEL(basis)**`, a trailing colon inside or after the bold.
const LABEL_LINE = new RegExp(
  `^\\*\\*((?:${SECTION_LABELS.join("|")})(?:\\s*\\([^()*]*\\))?)(?::\\*\\*|\\*\\*:?)$`,
);

// The label a line opens, or null. Only prose lines qualify; see the header.
function labelOf(entry) {
  if (entry.kind !== "prose") return null;
  const m = LABEL_LINE.exec(entry.raw.trim());
  return m ? m[1] : null;
}

// Heading, blank and rule lines are the run that travels with the label below it. Blockquotes,
// bare bullets and table rows are structural too, but they are content, so they stay put.
const travelsWithLabel = ({ kind, raw }) =>
  kind === "heading" || (kind === "structural" && /^(|-{3,}|\*{3,}|_{3,})$/.test(raw.trim()));

// The unit's lines as text, blank lines at either edge dropped.
function joinUnit(entries) {
  let start = 0;
  let end = entries.length;
  while (start < end && entries[start].raw.trim() === "") start++;
  while (end > start && entries[end - 1].raw.trim() === "") end--;
  return entries.slice(start, end).map((e) => e.raw).join("\n");
}

// splitLabeledSections(text) → [{ label, line, text }]
//   label: the label as written inside the bold ("CLAIM", "GUESS(inference)"), null for the
//   whole unlabeled message or the preamble. line: the 1-indexed label line (1 for a null-label
//   unit). Never throws.
export function splitLabeledSections(text) {
  const src = String(text ?? "");
  const lines = classifyLines(src);
  const labelAt = lines.map(labelOf);
  if (!labelAt.some(Boolean)) return [{ label: null, line: 1, text: src }];

  // Each section starts at its label line (`at`), moved up over the heading/blank/rule run
  // directly above it; the run never reaches back past the previous label line.
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!labelAt[i]) continue;
    let start = i;
    const floor = starts.length ? starts[starts.length - 1].at + 1 : 0;
    while (start > floor && travelsWithLabel(lines[start - 1])) start--;
    starts.push({ start, at: i });
  }

  const units = [];
  const preamble = joinUnit(lines.slice(0, starts[0].start));
  if (preamble.trim()) units.push({ label: null, line: 1, text: preamble });
  for (let k = 0; k < starts.length; k++) {
    const { start, at } = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1].start : lines.length;
    const body = lines.slice(start, end).filter((_, j) => start + j !== at);
    units.push({ label: labelAt[at], line: lines[at].number, text: joinUnit(body) });
  }
  return units;
}

// openingWords(text, n = OPENING_WORDS) → the first n words of the text's heading and prose
// lines, joined by single spaces; all of them when there are fewer. Never throws.
export function openingWords(text, n = OPENING_WORDS) {
  const words = [];
  for (const { kind, norm } of classifyLines(text)) {
    if (kind !== "heading" && kind !== "prose") continue;
    for (const word of norm.split(/\s+/)) {
      if (!word) continue;
      words.push(word);
      if (words.length >= n) return words.join(" ");
    }
  }
  return words.join(" ");
}
