#!/usr/bin/env node
// i-have-audhd-inject.mjs — SessionStart injection of the i-have-audhd first-turn core, plus
// any reader traits the operator declared locally.
//
// WHY THIS HOOK EXISTS
//   The rules govern the shape of a message, and the first message of a session is often the
//   first turn. A skill fires in response to something; that is one beat too late for a contract
//   about the very first thing said. This closes that window. The skill carries the fuller
//   contract and the reference for when it loads.
//
// WHY IT READS THE SKILL INSTEAD OF CARRYING TEXT
//   Two copies of one contract drift and nothing detects it. The injected text lives inside
//   skills/i-have-audhd/SKILL.md between `<!-- inject:start -->` and `<!-- inject:end -->`,
//   and this file emits exactly that span. Editing the skill IS editing what sessions receive.
//
// WHY THE READER TRAITS ARE NOT IN THIS REPOSITORY
//   A trait sentence is information about a real person. It is attributable to whoever owns the
//   repository it sits in, and a pushed commit survives in forks and caches after any later
//   deletion — so genericising the wording does not anonymise the author. This plugin therefore
//   ships the MECHANISM and no traits: it reads a profile the operator writes on their own
//   machine and emits it verbatim. example.i-have-audhd.json is a generic illustration and
//   describes nobody.
//
// FAIL-OPEN, BUT NOT FAIL-SILENT
//   Every path exits 0 — a broken hook must never break a session. But a hook that fails silently
//   is indistinguishable from one that is working, so a missing span or an unparseable profile
//   emits one short line saying so. A profile that simply does not exist is normal, not a
//   failure, and says so in one clause rather than a warning.
//
// WHY THE INTRO LINE IS ANONYMOUS
//   The skill is published; the person reading this session's messages is whoever installed it.
//   The hook-owned line names neither an author nor a diagnosis: it says the person in this
//   session installed these rules and that they apply to every message to that person.
//
// Contract: read JSON on stdin (SessionStart payload; `source` and `session_id` arm the resume
// marker below). Emit hookSpecificOutput.additionalContext, exit 0. The OMP adapter
// (omp/i-have-audhd-omp.ts) spawns this same file and forwards additionalContext.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, resumeMarkerPath, appendLog } from "../lib/state.mjs";

const SKILL_PATH = fileURLToPath(
  new URL("../skills/i-have-audhd/SKILL.md", import.meta.url),
);

// Line-anchored: the skill's own prose names the markers, and must not match.
const START = "\n<!-- inject:start -->\n";
const END = "\n<!-- inject:end -->";

const INTRO =
  "The person you are talking to installed the i-have-audhd rules below so that agents write " +
  "to them this way. Apply them to every message you write to that person.\n\n";

const POINTER =
  "\nThe Stop hook's checks, the operator-profile schema, and every check's contract are in the " +
  "`i-have-audhd` skill's reference.md. The Stop hook warns by default; a flag file at " +
  "~/.claude/.i-have-audhd-off disables it within one turn.";

function emit(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }),
  );
  process.exit(0);
}

function profilePath() {
  const explicit = process.env.I_HAVE_AUDHD_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), ".claude", "i-have-audhd.json");
}

// Returns { text, note } — text is emitted verbatim, note reports a failure worth one line.
function readProfile() {
  const path = profilePath();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { text: "", note: "No reader profile is configured, so these rules name no addressee." };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { text: "", note: `The reader profile at ${path} did not parse (${err.message}), so no traits were applied.` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text: "", note: `The reader profile at ${path} is not a JSON object, so no traits were applied.` };
  }

  const reader = typeof parsed.reader === "string" ? parsed.reader.trim() : "";
  const traits = Array.isArray(parsed.traits)
    ? parsed.traits.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
    : [];

  if (!reader && !traits.length) {
    return { text: "", note: `The reader profile at ${path} declares no reader and no traits.` };
  }

  const lines = [];
  lines.push(
    reader
      ? `\n**These messages are being written for ${reader}.**`
      : "\n**The operator has declared how this reader reads.**",
  );
  if (traits.length) {
    lines.push("");
    for (const t of traits) lines.push(`- ${t.replace(/\s+$/, "")}`);
    lines.push("");
    lines.push(
      "Those are traits of the reader, not of the subject matter. Where one of them conflicts " +
        "with a rule above, the trait wins and you say which rule you set aside.",
    );
  }
  return { text: lines.join("\n"), note: "" };
}

// One-shot marker for the Stop hook: this session's next substantive message is the one the
// restate-the-resumed-thread rule judges. Fail-open (errors.log), never session-visible.
function writeResumeMarker(rawStdin) {
  let payload = {};
  try {
    payload = JSON.parse(rawStdin || "{}");
  } catch {
    return; // an unparseable payload is not this hook's failure; no marker, no judgment
  }
  const source = typeof payload.source === "string" ? payload.source.toLowerCase() : "";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  const resumeish =
    source === "resume" || source === "compact" || (source === "clear" && /compact/i.test(reason));
  if (!resumeish || !sessionId) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(resumeMarkerPath(sessionId), `${new Date().toISOString()}\n`);
  } catch (err) {
    appendLog("errors.log", `could not write resume marker for ${sessionId}: ${err.message}`);
  }
}
try {
  let rawStdin = "";
  try {
    rawStdin = readFileSync(0, "utf8"); // the payload IS needed now — see writeResumeMarker
  } catch {
    /* no stdin is fine */
  }

  // Rule 8 trigger, session-start half: a resume or compact means the NEXT assistant message is
  // the one the restate-the-thread rule judges. Leave a one-shot marker for the Stop hook to
  // consume. Assumption documented: Claude Code SessionStart sources are startup | resume |
  // clear | compact; where a host reports "clear" with a reason mentioning compact, that is
  // treated as a compact. Unverifiable payload shapes fail open (no marker), and the Stop
  // hook simply has nothing to consume.
  writeResumeMarker(rawStdin);

  if (String(process.env.I_HAVE_AUDHD_INJECT || "").toLowerCase() === "off") process.exit(0);

  const md = readFileSync(SKILL_PATH, "utf8");
  const start = md.indexOf(START);
  const end = start === -1 ? -1 : md.indexOf(END, start + START.length);
  if (start === -1 || end === -1) {
    emit("The i-have-audhd core could not load: its markers are missing from the skill file.");
  }

  const core = md.slice(start + START.length, end).trim();
  const { text, note } = readProfile();
  emit(INTRO + core + text + POINTER + (note ? `\n${note}` : ""));
} catch {
  // Fail open, and say so — a silent failure reads exactly like success.
  try {
    emit("The i-have-audhd core could not load this session.");
  } catch {
    process.exit(0);
  }
}
