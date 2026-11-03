// state.mjs — where the enforcement half keeps its inspectable traces.
//
// WHY A STATE DIRECTORY AT ALL
//   Fail-open machinery that leaves no trace is indistinguishable from machinery that was
//   never wired. Every skip, every warning, every swallowed error goes to a file under
//   ~/.claude/.i-have-audhd-state/ so an operator can answer "did it run?" by looking
//   rather than by believing. The loop guard's per-session hash and the judge cache live
//   there too.
//
// WHY LOGGING SWALLOWS ITS OWN FAILURES
//   A read-only home must not turn a fail-open hook into a crashing one. A log line that
//   cannot be written is lost; that is the honest cost of fail-open, and it is paid here
//   deliberately rather than by throwing at the caller.

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir() {
  return join(homedir(), ".claude", ".i-have-audhd-state");
}

// The kill switch is read per invocation with existsSync, never cached, and never read from a
// module-scope environment variable — env is frozen for the life of the host process that
// spawns this hook, so an env switch cannot be thrown without relaunching the host. A flag
// file disables enforcement within one turn. Same precedent as the identifier URL resolver.
export function killSwitchPath() {
  return join(homedir(), ".claude", ".i-have-audhd-off");
}

export function resumeMarkerPath(sessionId) {
  return join(stateDir(), `resume-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}`);
}

// Present once the session-start hook has shown its no-judge notice (hooks/i-have-audhd-inject.mjs).
export function judgeNoticeMarkerPath() {
  return join(stateDir(), "judge-notice-shown");
}

export function lastBlockedPath(sessionId) {
  return join(stateDir(), `last-blocked-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

// The warn findings of the session's latest checked stop, waiting for its next turn
// (lib/pending.mjs writes and consumes it).
export function pendingWarningPath(sessionId) {
  return join(stateDir(), `pending-warn-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function sha256hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

// One timestamped line to <dir>/<file>; dir defaults to the shared state directory and exists
// as a parameter so the judge machinery can be tested against a temp home. Never throws.
export function appendLog(file, text, dir = stateDir()) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${new Date().toISOString()} ${String(text).replace(/\s+/g, " ").trim()}\n`);
  } catch {
    // Lost by design; see the header. A log failure must not become the hook's failure.
  }
}
