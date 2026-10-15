#!/usr/bin/env node
// name-the-artifact.mjs — name-the-artifact: name the file, the command, or the line.
//
// WHAT IT DECIDES
//   Given one REPORT-SHAPED message — long enough to be a report, and speaking in report verbs
//   ("fixed", "shipped", "ran") — does it name at least one checkable artifact: an absolute or
//   relative path, a file:line token, a fenced block, an inline code span, a URL, or a
//   shell-command-looking line?
//
// WHY THE APPLICABILITY GATE IS TWO-PART
//   A message about nothing on disk — a question, an acknowledgement, a decision reached in
//   conversation — is correct and unnameable, so length alone cannot gate this check. The
//   report-verb gate narrows it to messages that claim to have done work. That gate is weak
//   and is labeled as one: this is a vocabulary check, not a correctness check. It answers
//   "does the message name an artifact", never "is the artifact the right one".
//
// WHY THE DEFAULT MODE IS WARN
//   Because of everything above. The Stop hook ships this rule in warn mode: it is recorded
//   in warnings.log and never blocks unless an operator explicitly upgrades it. A vocabulary
//   check with an unmeasured false-positive rate has no business stopping a turn.
//
// Usage:
//   import { checkNamesArtifact } from "./name-the-artifact.mjs";
//   node name-the-artifact.mjs message.md    # prints one JSON object, exit 0

import { classifyLines } from "./lines.mjs";

const DEFAULTS = {
  minProseChars: 400,
  // Stems matched as whole words, case-insensitively. "ran" does not match "random";
  // "fixed" matches "fixed" and, through case folding, "Fixed".
  reportVerbs: [
    "fixed", "added", "updated", "changed", "removed", "built", "shipped", "ran",
    "verified", "wrote", "refactored", "installed", "committed", "pushed",
  ],
};

// A path with at least two segments, rooted (/a/b), home (~ /a/b), or relative (./a, ../a).
const PATH_TOKEN = /(?:~|\.\.?|(?<![A-Za-z0-9_.-]))(?:\/[A-Za-z0-9_.@+-]+){2,}(?:\/)?/;
// file.ext:NN or file.ext:NN:MM — the receipt form this house uses everywhere.
const FILE_LINE_TOKEN = /[A-Za-z0-9_][A-Za-z0-9_.@+-]*\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?/;
const URL_TOKEN = /https?:\/\/[^\s)>`]+/;
const INLINE_CODE = /`[^`\n]+`/;

// First words of lines that read as commands, with or without a shell prompt prefix.
const COMMON_COMMANDS = new Set([
  "node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "git", "gh", "curl", "wget",
  "docker", "podman", "psql", "mysql", "make", "cargo", "rustc", "go", "python",
  "python3", "pip", "pytest", "jq", "sed", "awk", "grep", "rg", "find", "ls", "cat",
  "echo", "cd", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ssh", "scp", "rsync",
  "kubectl", "helm", "terraform", "aws", "gcloud", "brew", "apt", "dnf", "zsh", "bash",
  "sh", "fish", "swift", "xcodebuild", "gradle", "mvn", "tig", "ffmpeg", "sqlite3",
]);

function commandLookingLine(line) {
  const t = line.trim().replace(/^[$>%❯]\s+/, "");
  if (!t) return false;
  const first = t.split(/\s+/)[0].replace(/^["']/, "");
  return COMMON_COMMANDS.has(first);
}

// Does the text name at least one artifact of any kind?
function namesArtifact(lines, raw) {
  for (const { raw: lineRaw } of lines) {
    if (commandLookingLine(lineRaw)) return true;
  }
  return (
    FILE_LINE_TOKEN.test(raw) ||
    URL_TOKEN.test(raw) ||
    INLINE_CODE.test(raw) ||
    PATH_TOKEN.test(raw) ||
    lines.some(({ kind }) => kind === "fence" || kind === "fenced")
  );
}

export function checkNamesArtifact(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const verbs = (Array.isArray(opts.reportVerbs) && opts.reportVerbs.length
    ? opts.reportVerbs
    : DEFAULTS.reportVerbs
  )
    .map((v) => String(v).toLowerCase().trim())
    .filter(Boolean);

  const raw = String(text ?? "");
  const lines = classifyLines(raw);

  let proseChars = 0;
  for (const { kind, norm } of lines) {
    if (kind === "prose") proseChars += norm.length;
  }

  const result = {
    applicable: false,
    flagged: false,
    reason: "below-floor",
    proseChars,
    matchedVerb: null,
  };

  if (proseChars < opts.minProseChars) return result;

  // Vocabulary applicability: the message speaks in report verbs. Weak, documented as weak.
  const lowered = raw.toLowerCase();
  const verb = verbs.find((v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lowered));
  if (!verb) {
    result.reason = "no-report-verb";
    return result;
  }
  result.matchedVerb = verb;
  result.applicable = true;

  if (!namesArtifact(lines, raw)) {
    result.flagged = true;
    result.reason = "no-artifact-named";
  } else {
    result.reason = "artifact-named";
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
  process.stdout.write(JSON.stringify(checkNamesArtifact(text), null, 2) + "\n");
  process.exit(0);
}
