// lines.mjs — the shared definition of what a line IS, for every check this plugin ships.
//
// WHY THIS MODULE EXISTS
//   needs-you-first, closing-ask-last, name-the-artifact and the judge-rule triggers all ask
//   the same first question: which lines of this message are substantive prose? Three private
//   copies of that answer would drift, and drift between copies is invisible until two checks
//   disagree about the same message. So the classification lives once, here.
//
//   It was extracted VERBATIM from needs-you-first.mjs — the fence toggling, the multi-line
//   HTML-comment state machine, the structural-line skip — and that check's 13-test suite is
//   the regression proof the extraction changed nothing.
//
// THE CLASSIFICATION
//   fence      a ``` or ~~~ delimiter line (toggles fenced state) — outside an HTML comment only
//   fenced     inside a code block — an example of text, never the author's text
//   comment    inside an HTML comment, including the delimiters
//   structural blank, horizontal rule, bare bullet, blockquote, table separator — carries
//              nothing substantive
//   heading    # navigation; counts as neither prose nor a marker blocker, but CAN be a
//              marker line ("## Needs you" is the common spelling)
//   prose      the author's assertion; the only kind that counts toward prose chars
//
//   The comment state is checked before the fence test, so a ``` inside a multi-line comment
//   is comment text and never opens a code block that swallows the rest of the message. A
//   comment opens wherever `<!--` stands with no `-->` after it, mid-line too
//   ("Intro <!-- hidden"): that line is classified by the text before the `<!--`, and the
//   comment runs from the next line to the `-->`. A `<!--` inside an inline code span is text.
//
// Marker matching (needs-you-first, closing-ask-last) runs over heading and prose lines' `norm` — the line stripped of
// heading hashes, list bullets, emphasis characters and a trailing colon, so "**Needs you**",
// "## Needs you" and "Needs you:" are one marker rather than three. A marker is line-anchored:
// the line equals the marker or begins with marker + space. Content on the SAME line after a
// colon ("Closing ask: approve it") is deliberately NOT a marker — the marker is the section
// opener, not a sentence prefix.

export function normalizeLine(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s*:\s*$/, "")
    .trim();
}

export function isHeading(line) {
  return /^\s{0,3}#{1,6}\s+\S/.test(line);
}

export function isStructural(line) {
  const t = line.trim();
  if (t === "") return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
  if (/^[-*+]$/.test(t)) return true;
  if (t.startsWith(">")) return true;
  if (t.startsWith("<!--") || t.endsWith("-->")) return true;
  if (/^\|[\s|:-]*\|$/.test(t)) return true; // table separator row
  return false;
}

export function isFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

// The line with every inline code span blanked out, so a `<!--` inside one is never markup. A
// span opens with a run of N backticks and closes at the next run of exactly N (CommonMark);
// a run with no matching closer is literal text and stays.
function maskCodeSpans(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }
    let j = i;
    while (line[j] === "`") j++;
    const run = j - i;
    let close = -1;
    for (let k = j; k < line.length; ) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      let m = k;
      while (line[m] === "`") m++;
      if (m - k === run) {
        close = m;
        break;
      }
      k = m;
    }
    if (close === -1) {
      out += line.slice(i, j);
      i = j;
    } else {
      out += " ".repeat(close - i);
      i = close;
    }
  }
  return out;
}

// Where an HTML comment that this line leaves open starts, or -1: the last `<!--` outside an
// inline code span with no `-->` after it.
function commentOpenAt(line) {
  const masked = maskCodeSpans(line);
  const at = masked.lastIndexOf("<!--");
  if (at === -1 || masked.indexOf("-->", at + 4) !== -1) return -1;
  return at;
}

// Classify every line of a message. Never throws; null-ish input classifies as no lines.
// Each entry: { number, raw, kind, norm } — number is 1-indexed, norm is set for the
// heading/prose kinds only.
export function classifyLines(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  let inFence = false;
  let inComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const number = i + 1;

    // Multi-line HTML comments (the output-types envelope is one) count as neither. Checked
    // first: a fence delimiter inside a comment is comment text.
    if (inComment) {
      const close = raw.indexOf("-->");
      if (close !== -1) inComment = commentOpenAt(raw.slice(close + 3)) !== -1;
      out.push({ number, raw, kind: "comment", norm: null });
      continue;
    }
    if (isFence(raw)) {
      inFence = !inFence;
      out.push({ number, raw, kind: "fence", norm: null });
      continue;
    }
    if (inFence) {
      out.push({ number, raw, kind: "fenced", norm: null });
      continue;
    }
    // A comment opening on this line: the line is what stands before the `<!--`.
    const open = commentOpenAt(raw);
    const own = open === -1 ? raw : raw.slice(0, open);
    if (open !== -1) {
      inComment = true;
      if (own.trim() === "") {
        out.push({ number, raw, kind: "comment", norm: null });
        continue;
      }
    }
    if (isStructural(own) || normalizeLine(own) === "") {
      out.push({ number, raw, kind: "structural", norm: null });
      continue;
    }
    if (isHeading(own)) {
      out.push({ number, raw, kind: "heading", norm: normalizeLine(own) });
      continue;
    }
    out.push({ number, raw, kind: "prose", norm: normalizeLine(own) });
  }
  return out;
}

// Substantive characters: the sum of normalized prose-line lengths. One shared floor metric
// for the master floor and every check's applicability gate.
export function proseCharCount(text) {
  let total = 0;
  for (const { kind, norm } of classifyLines(text)) {
    if (kind === "prose") total += norm.length;
  }
  return total;
}
