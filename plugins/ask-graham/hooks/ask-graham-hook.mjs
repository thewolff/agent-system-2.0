#!/usr/bin/env node
// ask-graham-hook.mjs — Claude Code UserPromptSubmit: at intensity every-idea, add one line to the
// turn telling the agent to run ask-graham if the message proposes a new idea.
//
// The skill's description fires only on an explicit "should we build this?" (intensity ask).
// every-idea needs something that sees every message, so this hook resolves the level from the
// prompt's working directory (scripts/intensity.mjs: repo file, then user file, then ask) and,
// only at every-idea, emits NUDGE as additionalContext. At ask it prints nothing.
//
// Whether a message is a new idea is left to the agent: the nudge says what does not count
// (a ticket, a bug, a task in an existing project) and to ignore it otherwise.
//
// FAIL-OPEN, BUT NOT FAIL-SILENT. Every path exits 0, so a broken hook never blocks a prompt. An
// unexpected error says so in one line, because a silent failure reads exactly like level ask.
//
// Contract: JSON on stdin (UserPromptSubmit payload; `cwd` is read). JSON on stdout or nothing.
// OMP does not run this file; omp/ask-graham-omp.ts does the same job there.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NUDGE, resolveIntensity } from "../skills/ask-graham/scripts/intensity.mjs";

const context = (text) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });

/** The hook's output for one payload: the JSON to print, or null for none. */
export function handle(input, opts = {}) {
  const cwd = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const r = resolveIntensity({ cwd, env: opts.env ?? process.env, home: opts.home });
  return r.level === "every-idea" ? context(NUDGE) : null;
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
  let out;
  try {
    out = handle(input);
  } catch {
    out = context("ask-graham: the intensity setting could not be read this turn, so it was treated as ask.");
  }
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
