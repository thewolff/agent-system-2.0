#!/usr/bin/env node
// i-have-audhd-prompt.mjs — the next turn hears what the Stop hook warned about.
//
// WHAT THIS IS
//   A UserPromptSubmit hook. The Stop core (hooks/i-have-audhd-stop.mjs) leaves the warn
//   findings of the session's latest checked message in a pending file (lib/pending.mjs).
//   This hook consumes that file when the next prompt arrives and hands it over:
//     additionalContext  the notice, for the agent: which rule, what to move or add, and that
//                        the fix applies from the next message on (the earlier one is sent);
//     systemMessage      one line for the person, naming the rules that fired.
//   Nothing pending → nothing on stdout. The OMP adapter (omp/i-have-audhd-omp.ts) spawns this
//   same file after each stop and delivers the same two fields its own way.
//
// CONTRACT
//   stdin:  the UserPromptSubmit payload; only session_id is read.
//   stdout: {"systemMessage":"…","hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
//           "additionalContext":"…"}} when a notice was pending, and NOTHING otherwise.
//   Exit 0 on every path; failures leave one errors.log line.
//
// KILL SWITCH: the Stop core's flag file ($HOME/.claude/.i-have-audhd-off) silences this hook
// too, per invocation. A pending notice is left in place and delivered once the switch is lifted.

import { existsSync, readFileSync } from "node:fs";
import { killSwitchPath, appendLog } from "../lib/state.mjs";
import { takePending } from "../lib/pending.mjs";

function main() {
  if (existsSync(killSwitchPath())) return;
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch (err) {
    appendLog("errors.log", `prompt payload did not parse: ${err.message}`);
    return;
  }
  const sessionId = typeof payload?.session_id === "string" && payload.session_id ? payload.session_id : "no-session";
  const pending = takePending(sessionId);
  if (!pending) return;
  process.stdout.write(
    JSON.stringify({
      // No line for the person when every finding is a judge-unavailable one (lib/pending.mjs).
      ...(pending.summary ? { systemMessage: pending.summary } : {}),
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: pending.notice },
    }),
  );
}

try {
  main();
} catch (err) {
  appendLog("errors.log", `prompt hook failed open: ${err?.stack || String(err)}`);
}
