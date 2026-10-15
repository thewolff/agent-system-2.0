#!/usr/bin/env node
// needs-you-first.mjs — the one predicate this plugin ships.
//
// WHAT IT DECIDES
//   Given one message: if a needs-you section exists, does any substantive prose come before it?
//   That is the whole question. Not whether the message is good, not whether it should have had
//   such a section, not whether the section contains the right things.
//
// WHY IT FLAGS MISORDERING AND NEVER ABSENCE
//   The dominant false positive for "needs-you first" is a message with nothing needing the
//   reader. A check that demands the section flags every routine answer — and the cheapest way to
//   satisfy such a check is an empty "Needs you: nothing." header, which puts ceremony in the
//   position the reader reads first. That is worse than no check. So absence is never a finding
//   here: no marker means not applicable, and not applicable is not a pass either.
//
// WHY THERE IS A LENGTH FLOOR
//   Short messages are the false-positive population for every structural check: an
//   acknowledgement, a one-line answer, a question. The default floor is 200 characters of
//   substantive prose. That number is a starting point, not a measurement of your corpus —
//   calibrate it before trusting the rate (skills/i-have-audhd/reference.md, the scoreboard).
//
// WHY IT ONLY RETURNS A RESULT
//   It cannot block a turn or rewrite one, and the CLI exits 0 whether it flags or not. The
//   Stop hook decides what a finding does, and every rule there warns by default: a structural
//   check whose false-positive rate is unmeasured on your corpus must not be able to stop
//   anything by default, because the cheapest way to satisfy a guard that fires wrongly is to
//   stop writing the thing it misreads.
//
// Usage:
//   import { checkNeedsYouFirst } from "./needs-you-first.mjs";
//   node needs-you-first.mjs message.md      # prints one JSON object, exit 0

const DEFAULTS = {
  markers: ["Needs you"],
  minProseChars: 200,
  graceChars: 0,
};

// Line classification (fences, HTML-comment envelopes, structural lines, headings, prose)
// and the marker normalization below moved to lines.mjs in 0.2.0, when closing-ask-last
// needed the identical semantics. This check consumes them from there; its 13-test suite is
// the regression proof the move changed nothing. The comments that explained each rule now
// live with the code they explain.
import { classifyLines } from "./lines.mjs";

export function checkNeedsYouFirst(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const markers = (Array.isArray(opts.markers) && opts.markers.length ? opts.markers : DEFAULTS.markers)
    .map((m) => String(m).toLowerCase().replace(/\s*:\s*$/, "").trim())
    .filter(Boolean);

  const result = {
    applicable: false,
    flagged: false,
    reason: "no-marker",
    markerLine: null,
    prosePrecedingChars: 0,
    proseChars: 0,
  };

  let markerLine = null;
  let proseBefore = 0;
  let proseTotal = 0;

  for (const { number, kind, norm } of classifyLines(text)) {
    // Headings and prose lines are the marker candidates; a marker line is a section opener
    // and never counts as prose, whichever kind it arrived as.
    if (markerLine === null && (kind === "heading" || kind === "prose")) {
      const lower = norm.toLowerCase();
      if (markers.some((m) => lower === m || lower.startsWith(m + " "))) {
        markerLine = number;
        continue;
      }
    }
    if (kind === "prose") {
      proseTotal += norm.length;
      if (markerLine === null) proseBefore += norm.length;
    }
  }

  result.proseChars = proseTotal;
  result.markerLine = markerLine;
  result.prosePrecedingChars = proseBefore;

  if (proseTotal < opts.minProseChars) {
    result.reason = "below-floor";
    return result;
  }
  if (markerLine === null) {
    result.reason = "no-marker";
    return result;
  }

  result.applicable = true;
  if (proseBefore > Math.max(0, Number(opts.graceChars) || 0)) {
    result.flagged = true;
    result.reason = "prose-precedes-marker";
  } else {
    result.reason = "marker-first";
  }
  return result;
}

// Profile loading lives with the hook; the exported function takes plain options so it stays
// testable with no filesystem at all; the CLI block below reads one.
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
  process.stdout.write(JSON.stringify(checkNeedsYouFirst(text), null, 2) + "\n");
  process.exit(0);
}
