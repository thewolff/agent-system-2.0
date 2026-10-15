#!/usr/bin/env node
// closing-ask-last.mjs — closing-ask-last: one closing ask, and it goes last.
//
// WHAT IT DECIDES
//   Given one message that HAS a closing-ask marker: is there exactly one, and does no
//   substantive prose follow it? That is the whole question — not whether a message should
//   have a closing ask, not whether the ask is the right one.
//
// WHY IT FLAGS OVERTIME AND NEVER ABSENCE
//   Same anti-ceremony argument as needs-you-first, and it is the reason the two checks share
//   a shape. A check that demanded a closing ask in every message would be satisfied by an
//   empty "Closing ask: none." trailer bolted onto messages that needed nothing — ceremony in
//   the position the reader reads LAST, which is the one place ceremony costs the most,
//   because the reader has already acted on the message by then and the trailer teaches them
//   to stop reading at the body. So: no marker means not applicable, and not applicable is
//   not a pass either.
//
// WHY A LENGTH FLOOR
//   Short messages are the false-positive population for every structural check; 200 chars of
//   substantive prose, same default as needs-you-first.
//
// Usage:
//   import { checkClosingAskLast } from "./closing-ask-last.mjs";
//   node closing-ask-last.mjs message.md    # prints one JSON object, exit 0

import { classifyLines } from "./lines.mjs";

const DEFAULTS = {
  markers: ["Closing ask"],
  minProseChars: 200,
  graceChars: 0,
};

export function checkClosingAskLast(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const markers = (Array.isArray(opts.markers) && opts.markers.length ? opts.markers : DEFAULTS.markers)
    .map((m) => String(m).toLowerCase().replace(/\s*:\s*$/, "").trim())
    .filter(Boolean);

  const result = {
    applicable: false,
    flagged: false,
    reason: "no-marker",
    markerLine: null, // first marker, 1-indexed
    markerCount: 0,
    proseAfterChars: 0,
    proseChars: 0,
  };

  let markerCount = 0;
  let firstMarkerLine = null;
  let proseTotal = 0;
  let proseAfter = 0;

  // The ask SECTION is the marker line plus the one paragraph that follows it (blanks
  // skipped). That paragraph is the ask itself, not overtime; substantive prose in any later
  // paragraph, or under any later heading, is what "goes last" forbids. A heading or fence
  // directly after the marker ends the section empty.
  let askOpen = false; // marker seen, its paragraph not yet collected
  let inAsk = false; // inside the ask's paragraph
  let askDone = false; // the ask section is closed; later prose is "after"

  for (const { number, kind, norm } of classifyLines(text)) {
    if (kind === "heading" || kind === "prose") {
      const lower = norm.toLowerCase();
      if (markers.some((m) => lower === m || lower.startsWith(m + " "))) {
        // Every marker counts — "one closing ask" is the rule, so this check does not stop at
        // the first, unlike needs-you-first which judges ordering on the first marker only.
        markerCount += 1;
        if (firstMarkerLine === null) {
          firstMarkerLine = number;
          askOpen = true;
        }
        continue; // a marker line is a section opener, never prose
      }
    }

    if (kind === "prose") {
      proseTotal += norm.length;
      if (askOpen && !askDone) {
        inAsk = true; // this paragraph is the ask's own content
      } else if (askDone) {
        proseAfter += norm.length;
      }
    } else if (kind === "heading" || kind === "fence") {
      if (askOpen) {
        askOpen = false;
        askDone = true; // a new section starts; the ask (empty or complete) is behind us
      }
    } else if (kind === "structural" || kind === "comment") {
      if (inAsk) {
        askOpen = false;
        inAsk = false;
        askDone = true; // paragraph break closes the ask's paragraph
      }
    }
  }

  result.proseChars = proseTotal;
  result.markerCount = markerCount;
  result.markerLine = firstMarkerLine;
  result.proseAfterChars = proseAfter;

  if (proseTotal < opts.minProseChars) {
    result.reason = "below-floor";
    return result;
  }
  if (markerCount === 0) {
    result.reason = "no-marker";
    return result;
  }

  result.applicable = true;
  if (markerCount > 1) {
    result.flagged = true;
    result.reason = "multiple-markers";
  } else if (proseAfter > Math.max(0, Number(opts.graceChars) || 0)) {
    result.flagged = true;
    result.reason = "prose-after-ask";
  } else {
    result.reason = "single-ask-last";
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
  process.stdout.write(JSON.stringify(checkClosingAskLast(text), null, 2) + "\n");
  process.exit(0);
}
