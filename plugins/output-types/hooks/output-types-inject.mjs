#!/usr/bin/env node
// output-types-inject.mjs — SessionStart injection of the output-types operative core.
//
// WHY THIS HOOK EXISTS
//   The contract governs every assertion, and a skill fires in response to one — which is one
//   beat too late. A skill's text does stay in context for the rest of a session once it loads,
//   so the gap is not leakage; it is the window before the load, and the first assertion of a
//   session is usually in the first turn. This hook closes that window. The skill points at
//   the full contract for when it fires; this carries the part that must be in force before
//   the first tool call.
//
// WHY IT READS THE CONTRACT INSTEAD OF CARRYING TEXT
//   Two copies of one contract drift, and nothing detects it. So the injected text lives inside
//   skills/output-types/reference.md (the whole contract, stated once) between
//   `<!-- inject:start -->` and `<!-- inject:end -->`, and this file emits exactly that span.
//   Editing the contract IS editing what sessions receive. The only text this hook owns is the
//   single pointer line appended at the end, which cannot live in the span because it reads
//   differently inside the contract than it does injected.
//
// NO SCOPE GATE, DELIBERATELY
//   A plugin somebody chose to install is the opt-in. A gate here would reproduce the defect
//   this plugin was extracted away from: machinery that is present, believed live, and silent.
//   The off-switch is OUTPUT_TYPES_INJECT=off, so a person can silence it without uninstalling.
//
// FAIL-OPEN, BUT NOT FAIL-SILENT
//   Every error path exits 0 — a broken hook must never break somebody's session. But a hook
//   that fails silently is indistinguishable from a hook that is working, which is the exact
//   confusion this contract exists to prevent. So a failure emits one short line saying the core
//   did not load. It costs nothing when things work.
//
// Contract: read JSON on stdin (SessionStart payload; unused, but consumed so the pipe closes).
// Emit hookSpecificOutput.additionalContext, exit 0.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved from this file, never from a working directory or an assumed layout.
const CONTRACT_PATH = fileURLToPath(new URL("../skills/output-types/reference.md", import.meta.url));

// Line-anchored: the contract's own prose names the markers, and must not match.
const START = "\n<!-- inject:start -->\n";
const END = "\n<!-- inject:end -->";

// The only text this file owns.
const POINTER =
  "\nThe rest of the contract (receipts, the seven rules, what unlabeled prose still owes, degraded " +
  "reports, commands handed to a person) is in the `output-types` skill. Load it before writing " +
  "anything someone will act on.";

function emit(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }),
  );
  process.exit(0);
}

try {
  try {
    readFileSync(0, "utf8"); // drain stdin; the payload is not needed
  } catch {
    /* no stdin is fine */
  }

  if (String(process.env.OUTPUT_TYPES_INJECT || "").toLowerCase() === "off") process.exit(0);

  const md = readFileSync(CONTRACT_PATH, "utf8");
  const start = md.indexOf(START);
  const end = start === -1 ? -1 : md.indexOf(END, start + START.length);
  if (start === -1 || end === -1) {
    emit("The output-types core could not load: its markers are missing from the contract file.");
  }
  emit(md.slice(start + START.length, end).trim() + POINTER);
} catch {
  // Fail open, and say so — a silent failure reads exactly like success.
  try {
    emit("The output-types core could not load this session.");
  } catch {
    process.exit(0);
  }
}
