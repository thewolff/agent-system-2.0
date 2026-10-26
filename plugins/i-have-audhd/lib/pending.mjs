// pending.mjs — a warn finding reaches the agent on its next turn.
//
// WHY
//   Until 1.2.0 a warn finding went only to warnings.log, which neither the agent nor the
//   person reading it ever opens: warn mode was a log, not a warning. Now the Stop core
//   writes the warn findings of each checked stop to one per-session file, and the next turn
//   consumes it:
//     Claude Code  hooks/i-have-audhd-prompt.mjs on UserPromptSubmit returns `notice` as
//                  additionalContext (the agent reads it with the next prompt) and `summary`
//                  as systemMessage (shown to the person once, at that prompt).
//     OMP          omp/i-have-audhd-omp.ts spawns the same prompt CLI right after the stop
//                  CLI and queues `notice` with sendMessage deliverAs "nextTurn" (the
//                  receipts-audit delivery), notifying `summary` in the UI.
//   warnings.log keeps every line as before; this file is the delivery, the log is the record.
//
// ONE FILE PER SESSION, LATEST STOP WINS
//   Each stop that reaches the emit stage replaces the file with its warn findings, or removes
//   it when there are none: a notice always describes the agent's latest checked message. A
//   stop that returns early (kill switch, under the floor, loop guard) leaves it alone.
//   Consumption deletes it, so a notice is delivered once.
//
// NEVER THROWS. A file that cannot be written or read loses one notice and leaves one
// errors.log line; the warning is still in warnings.log.

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pendingWarningPath, appendLog } from "./state.mjs";

// One finding's text in the notice. Judge reasons can run long; the notice stays short.
const FINDING_CAP = 600;
const cap = (text) => (text.length > FINDING_CAP ? `${text.slice(0, FINDING_CAP - 1).trimEnd()}…` : text);

// The agent-facing notice: what it is, what to do with it, one line per finding. A warn
// fires after the message was sent, so the fix applies forward; the block-mode instruction
// ("paste the corrected lines") never appears here.
export function renderNotice(findings) {
  return [
    "i-have-audhd check of your last message (warning only; it was sent unchanged). Apply each fix " +
      "from your next message to the user on; do not resend or rewrite the earlier message unless asked.",
    ...findings.map((f) => `- ${cap(f.text)}`),
  ].join("\n");
}

// The person-facing line: which rules fired, and that the agent has the detail.
export function renderSummary(findings) {
  const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
  return `i-have-audhd warned on the agent's last message: ${rules}. The agent gets the fix with this turn.`;
}

// Replace the session's pending notice with these warn findings; none removes it.
export function writePending(sessionId, findings) {
  const path = pendingWarningPath(sessionId);
  try {
    if (!findings.length) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        at: new Date().toISOString(),
        rules: [...new Set(findings.map((f) => f.rule))],
        notice: renderNotice(findings),
        summary: renderSummary(findings),
      }),
    );
  } catch (err) {
    appendLog("errors.log", `could not write pending warning for ${sessionId}: ${err.message}`);
  }
}

// Read and delete the session's pending notice. undefined when there is none or it is unreadable.
export function takePending(sessionId) {
  const path = pendingWarningPath(sessionId);
  if (!existsSync(path)) return undefined;
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
    rmSync(path, { force: true });
  } catch (err) {
    appendLog("errors.log", `could not consume pending warning for ${sessionId}: ${err.message}`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.notice === "string" && parsed.notice && typeof parsed.summary === "string") return parsed;
  } catch {
    /* fall through to the log line */
  }
  appendLog("errors.log", `pending warning for ${sessionId} did not parse; dropped`);
  return undefined;
}
