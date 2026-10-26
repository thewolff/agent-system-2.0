// ask.mjs — the judge dispatch: one external command, one verdict, one bill per unique prompt.
//
// WHY A JUDGE IS MACHINERY
//   Five of the Stop hook's nine checks are not decidable by string matching — "is this trailing
//   section a batched dump or a legitimate summary" requires reading for meaning. The governing
//   reframe (2026-09-21): a model-graded check that runs AUTOMATICALLY inside a hook is still
//   machinery. It fires on a deterministic trigger, it returns pass or fail, and every failure
//   mode of the DISPATCH is deterministic: timeout, non-zero exit, unparseable output. The
//   judgment is the model's; the enforcement is this code's.
//
// THE COMMAND
//   config.enforcement.judgeCommand, a string. Two forms:
//     - contains the literal {prompt}: the placeholder is replaced by the shell-escaped
//       prompt (all occurrences);
//     - no placeholder: the command is run as-is and the prompt is piped to its stdin.
//   null or absent means judge rules are inactive — the Stop hook logs that to skipped.log.
//
//   Example: "codex exec --skip-git-repo-check -" — the trailing `-` makes codex read the
//   prompt from stdin. Any command works that prints the verdict object below on stdout and
//   exits 0 within the timeout; confirm the one you configure with a single manual run first.
//
// OUTPUT PARSING
//   STDOUT ONLY is captured — judge CLIs commonly print session headers and errors on stderr,
//   and merging the streams puts banner noise in front of the JSON. The LAST JSON object on
//   stdout is the verdict: banner lines before the JSON are expected. A
//   {"type":"result","result":"…"} envelope (the shape `claude -p --output-format json` emits)
//   is unwrapped by scanning the envelope's `result` string for the verdict object. The
//   verdict itself must be strictly {"violation": <boolean>, "reason": <string>}; anything
//   else is a failure.
//
// FAILURE IS OPEN AND LOUD
//   Timeout, non-zero exit, or unparseable output each return {violation: false, error: …} —
//   the hook never blocks on a judge that could not speak — and append one line to
//   judge-failures.log naming the rule and the error.
//
// THE TIMEOUT follows the harness tag the stop core already runs under; there is no setting.
//   Untagged (Claude Code): 30s. I_HAVE_AUDHD_HARNESS=omp (set only by the OMP adapter on the
//   core it spawns): 20s, because OMP abandons a session_stop handler at 30s and the adapter
//   kills the core at 25s (omp/i-have-audhd-omp.ts, TIMEOUT); a 20s judge leaves the core
//   room to log the failure and emit its deterministic findings first. options.timeoutMs
//   overrides both, for tests.
//
// CLEANUP: the judge's /bin/sh leads a fresh process group (detached), the convention the OMP
//   adapter uses for the hook CLIs. When the dispatch settles, one negative-pid SIGKILL reaps
//   whatever of that group is still alive — a pipeline stage, a wrapper's own children — and
//   the pipes are released, so a descendant that left the group cannot hold this process
//   open either.
//
// THE CACHE
//   sha256(promptText) → cache/<hash>.json, written only on a SUCCESSFUL verdict — a timeout
//   is never cached, because the judge might come back. Same prompt, same verdict, one judge
//   bill. The key is the whole prompt (rule, question, message): since 1.1.0 the question
//   varies per call (conclusion-first and bad-news-first append the unit's opening window and,
//   for a labeled section, a framing sentence), and an unlabeled message can equal one
//   section's text, so rule + contextText no longer determines what the judge sees. Cache
//   files keyed the old way simply stop matching: one re-bill per message, no migration.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256hex, appendLog, stateDir } from "../lib/state.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const OMP_TIMEOUT_MS = 20_000; // see the header's THE TIMEOUT

// Read at call time: the tag is the core's process env, set by the OMP adapter on its child.
function harnessTimeoutMs() {
  return process.env.I_HAVE_AUDHD_HARNESS === "omp" ? OMP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function shellEscape(text) {
  return "'" + String(text).replace(/'/g, `'\\''`) + "'";
}

function buildPrompt(rule, question, contextText) {
  return [
    "You are judging one message against one communication rule. Reply with ONE JSON object and nothing else, exactly this shape:",
    '{"violation": true, "reason": "one short sentence"}',
    "",
    `Rule: ${rule}`,
    `Question: ${question}`,
    "",
    "Message under judgment, verbatim, between the markers:",
    "<<<MSG",
    contextText,
    "MSG",
  ].join("\n");
}

// Every top-level {...} span in the text, string-aware so braces inside JSON strings do not
// confuse the depth count. Returns the spans in order.
export function topLevelJsonSpans(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) spans.push(text.slice(start, i + 1));
      }
    }
  }
  return spans;
}

function asVerdict(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (typeof obj.violation !== "boolean") return null;
  if (typeof obj.reason !== "string") return null;
  return { violation: obj.violation, reason: obj.reason };
}

// The LAST verdict-shaped JSON object on stdout, unwrapping one level of
// {"…","result":"<json string>"} envelope on the way. null when none qualifies.
export function parseVerdict(stdout) {
  const spans = topLevelJsonSpans(String(stdout ?? ""));
  for (let i = spans.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(spans[i]);
    } catch {
      continue;
    }
    const direct = asVerdict(parsed);
    if (direct) return direct;
    if (parsed && typeof parsed.result === "string") {
      const inner = parseVerdict(parsed.result);
      if (inner) return inner;
    }
  }
  return null;
}

function runCommand(cmdLine, promptText, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/bin/sh", ["-c", cmdLine], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      resolve({ ok: false, error: `judge-spawn-${err.code || err.message}` });
      return;
    }
    let stdout = "";
    let settled = false;
    // Every exit path, once: stop the timer, reap the judge's process group, release the pipes
    // (see the header's CLEANUP).
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH: nothing of the group is left, the usual case after a clean exit
      }
      child.stdin.destroy();
      child.stdout.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, error: "judge-timeout" }), timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => settle({ ok: false, error: `judge-spawn-${err.code || err.message}` }));
    child.on("close", (code) => settle({ ok: code === 0, code, stdout }));
    // The no-placeholder form receives the prompt on stdin; the placeholder form ignores it.
    child.stdin.on("error", () => {});
    child.stdin.end(cmdLine.includes("{prompt}") ? undefined : promptText);
  });
}

// askJudge(rule, question, contextText, config, options?)
//   options: { timeoutMs, stateDir } — for tests; production takes the harness timeout and
//   the shared state dir.
//   Never throws.
export async function askJudge(rule, question, contextText, config, options = {}) {
  const dir = options.stateDir ?? null;
  const log = (file, text) => appendLog(file, text, dir ?? undefined);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || harnessTimeoutMs());
  const command = config && typeof config.judgeCommand === "string" ? config.judgeCommand : "";
  if (!command.trim()) return { violation: false, error: "no-judge-command" };

  const promptText = buildPrompt(rule, question, contextText);

  // Cache lookup — same prompt, same verdict, no second bill.
  const key = sha256hex(promptText);
  const cacheDir = dir ? join(dir, "cache") : join(stateDir(), "cache");
  const cachePath = join(cacheDir, `${key}.json`);
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    const v = asVerdict(cached);
    if (v) return { ...v, cached: true };
  } catch {
    /* cache miss */
  }

  const cmdLine = command.includes("{prompt}")
    ? command.split("{prompt}").join(shellEscape(promptText))
    : command;
  const run = await runCommand(cmdLine, promptText, timeoutMs);

  if (!run.ok) {
    const error = run.error ?? `judge-exit-${run.code}`;
    log("judge-failures.log", `rule=${rule} error=${error}`);
    return { violation: false, error };
  }

  const verdict = parseVerdict(run.stdout);
  if (!verdict) {
    log("judge-failures.log", `rule=${rule} error=judge-unparseable`);
    return { violation: false, error: "judge-unparseable" };
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(verdict));
  } catch (err) {
    log("judge-failures.log", `rule=${rule} error=cache-write-failed (${err.message})`);
  }
  return { ...verdict, cached: false };
}
