// judge-setup.mjs — what the setup tool and the session-start fallback notice share: which
// checks need a judge, and whether the operator has made a judge choice at all.
//
// THE THREE STATES of enforcement.judgeCommand in the profile:
//   unset  the key is absent (or there is no profile): nobody has chosen. The session-start
//          hook shows its one-time notice naming tools/setup.mjs.
//   none   the key is null: the operator chose to run without a judge. No notice.
//   set    any other value. No notice; lib/config.mjs decides whether the value is usable and
//          logs to errors.log when it is not.
// A profile that exists but does not parse reads as "unreadable": no notice, because the
// operator has clearly configured something, and the inject hook already says the profile
// did not parse.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The five Stop-hook checks that run only with a judge (skills/i-have-audhd/reference.md,
// the check table's "judge" instruments). The other four are deterministic and always run.
export const JUDGE_RULES = [
  "do-not-batch-by-label",
  "conclusion-first",
  "restate-resumed-thread",
  "report-what-you-did-not-do",
  "bad-news-first",
];
export const TOTAL_CHECKS = 9;

export const SETUP_SCRIPT = fileURLToPath(new URL("../tools/setup.mjs", import.meta.url));

// Never throws. Returns "unset" | "none" | "set" | "unreadable".
export function judgeChoiceState(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "unset";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
  const e = parsed.enforcement;
  if (!e || typeof e !== "object" || Array.isArray(e) || !("judgeCommand" in e)) return "unset";
  return e.judgeCommand === null ? "none" : "set";
}

// The fallback notice for someone who installed the plugin and never ran the setup tool.
export function judgeNotice() {
  return (
    `i-have-audhd: no judge is configured, so ${JUDGE_RULES.length} of its ${TOTAL_CHECKS} checks are off ` +
    `(${JUDGE_RULES.join(", ")}). To pick a judge, or to choose none and stop this notice, run ` +
    `\`node ${SETUP_SCRIPT}\` in a terminal. This notice shows once.`
  );
}
