#!/usr/bin/env node
// i-have-audhd-stop.mjs — the enforcement half of i-have-audhd.
//
// WHAT THIS IS
//   A Stop hook. When the assistant finishes a turn, this hook reads the final message and
//   enforces the delivered rules against it. A model-graded check that runs automatically
//   inside a hook is still machinery: it fires on a trigger, it decides pass or fail, and it
//   fails open — it is a different instrument with a different error profile, not a
//   non-enforcement. The requirement, 2026-09-21: "I want the rules either enforceable by
//   machinery or an explicit it-can't-be-done." This file is the machinery answer for most of them.
//
// CONTRACT
//   stdin:  one Stop-payload JSON object — session_id, transcript_path, stop_hook_active
//           (Claude Code shape); OMP seat payloads additionally carry last_assistant_message.
//   stdout: one JSON object {"decision":"block","reason":"…"} when a block-mode rule fired,
//           and NOTHING otherwise. Exit 0 on every path — a broken hook must not break a
//           session, but it must not be invisible either (errors.log).
//
// ORDER OF OPERATIONS (each early return is exit 0, zero stdout)
//   1. Kill switch — the flag file $HOME/.claude/.i-have-audhd-off, checked with
//      existsSync PER INVOCATION. Never a module-scope env read: env is frozen for the life
//      of the host process that spawns hooks, so an env switch cannot be thrown without
//      relaunching the host. The file works within one turn. Chosen silence: documented
//      here, not announced to the model. $I_HAVE_AUDHD_ENFORCE=off is a secondary
//      switch with exactly that frozen caveat — it costs a host relaunch to change.
//   2. Parse the payload. Unparseable stdin → errors.log, exit 0.
//   3. Extract the final assistant text: last_assistant_message when it is a non-empty
//      string, else the transcript JSONL scanned backwards for the last type:"assistant"
//      entry with text content (tool-call-only entries are skipped; the message is the text).
//   4. Loop guard — stop_hook_active says this stop follows a continuation: under Claude Code
//      it is the host's flag (any Stop hook's continuation); under OMP the adapter sends true
//      only after its OWN block in this session, because OMP's flag is set by any extension.
//      If the sha256 of this text equals the hash recorded at this plugin's last block, exit
//      0: never block the same message twice, or a model that ignores the reason loops forever.
//   5. Master floor — under 200 substantive chars nothing runs. Short messages are the
//      false-positive population for every structural check this plugin ships.
//   6. Deterministic checks run per their configured modes; findings collect.
//   7. Judge-gated checks run only where their deterministic trigger fired and a judge
//      command is configured; a skipped one leaves a line in skipped.log naming the rule —
//      a skipped check must be inspectable, never silently dead. conclusion-first and
//      bad-news-first run per unit (checks/sections.mjs): each block-labeled section of a
//      labeled message, or the whole message when it has none. One judge job per qualifying
//      unit, one finding per rule naming every violating section; a judge error fails open
//      for its own section only.
//   8. Harness cap — only when I_HAVE_AUDHD_HARNESS=omp (set by the OMP adapter on its
//      child, never by Claude Code): harnessCapsBlocks in lib/config.mjs turns every
//      block-mode finding into a warn one when the profile does not set enforcement.armOmp,
//      or when it does and stop_hook_active is true, which on OMP means this stop revises
//      this plugin's own block (a revision is re-checked, never blocked twice). Applied here,
//      to the one findings list every check feeds, so it covers every rule; a capped finding
//      takes the ordinary warn path in (9).
//   9. One block-mode finding is enough: emit the block, record the text hash for (4).
//      Warn-mode findings go to warnings.log AND replace the session's pending notice
//      (lib/pending.mjs), which the next turn delivers to the agent: on Claude Code through
//      hooks/i-have-audhd-prompt.mjs (UserPromptSubmit), on OMP through the adapter. A stop
//      reaching this step with no warn finding removes the notice. Block reasons follow the
//      house ruling of 2026-09-18 (identifier resolver): name the rule, say exactly what to
//      move or add, and NEVER demand a resend of the whole message — "paste the corrected
//      opening lines only" style, terse. That paste instruction is block-only: a warn arrives
//      after the message went out, so its notice asks for the fix going forward instead.
//
// FAIL-OPEN EVERYWHERE
//   Any thrown error → exit 0, nothing on stdout, one line in errors.log. Carried from the
//   session-start hook's contract: fail-open, but not fail-silent.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { checkClosingAskLast } from "../checks/closing-ask-last.mjs";
import { checkNeedsYouFirst } from "../checks/needs-you-first.mjs";
import { checkNamesArtifact } from "../checks/name-the-artifact.mjs";
import { checkPluralBackReference } from "../checks/plural-back-reference.mjs";
import { splitLabeledSections, openingWords, OPENING_WORDS } from "../checks/sections.mjs";
import { loadEnforcement, effectiveMode, harnessCapsBlocks } from "../lib/config.mjs";
import { stateDir, killSwitchPath, lastBlockedPath, resumeMarkerPath, sha256hex, appendLog } from "../lib/state.mjs";
import { writePending } from "../lib/pending.mjs";
import { findTrailingBatchSection, batchByLabelQuestion, batchJudgeContext } from "../triggers/batch-heading.mjs";
import { conclusionFirstApplicable, conclusionFirstQuestion } from "../triggers/conclusion-first.mjs";
import { lastIncompleteTodos, reportQuestion, todoJudgeContext } from "../triggers/todo-unfinished.mjs";
import { badNewsGate, badNewsQuestion } from "../triggers/bad-news-lexicon.mjs";
import { askJudge } from "../judge/ask.mjs";

// restate-resumed-thread's judge question. Static per rule — variable data rides in the context
// (the verdict cache keys on the whole prompt either way).
const restateQuestion =
  "Rule 'restate the resumed thread': when a session resumes an earlier thread, the first " +
  "message restates the thread's subject and what is pending before continuing it — naming " +
  "the thread is not restating it. This IS the first assistant message after a resume. " +
  "violation=true when the message continues the thread without restating subject and pending " +
  "work. A message that itself summarizes or hands off (naming subject and status) is " +
  "compliant. When unsure, answer violation=false.";

// The skill rule each check enforces (skills/i-have-audhd/SKILL.md headings). Every warn and
// block reason names it, so a finding points at text the model has or can load.
const RULE_REFS = {
  "needs-you-first": "i-have-audhd rule 1, Skeleton",
  "closing-ask-last": "i-have-audhd rule 1, Skeleton",
  "do-not-batch-by-label": "i-have-audhd rule 1, Skeleton",
  "conclusion-first": "i-have-audhd rule 1, Skeleton",
  "plural-back-reference": "i-have-audhd rule 6, References survive without scrolling",
  "restate-resumed-thread": "i-have-audhd rule 8, Resume by restating content",
  "name-the-artifact": "i-have-audhd rule 11, Machinery anchors",
  "report-what-you-did-not-do": "i-have-audhd rule 11, Machinery anchors",
  "bad-news-first": "i-have-audhd rule 11, Machinery anchors",
};

// "<Check name> (<skill rule>)" — the head of every reason this hook emits.
const cite = (name, rule) => (RULE_REFS[rule] ? `${name} (${RULE_REFS[rule]})` : name);

const MASTER_FLOOR = 200;

// The block-only half of a reason. A block holds the turn open, so it asks for the corrected
// lines; a warn arrives after the message was sent (lib/pending.mjs), so it never carries this.
const paste = (what) => `Paste the corrected ${what} only; never resend the whole message.`;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// The final assistant text: OMP seats put it in the payload; Claude Code requires reading the
// transcript. Returns "" whenever anything is missing or unparseable — no text, no opinion.
export function extractText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;

  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcriptPath) return "";
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn line in a JSONL transcript is not this hook's failure
    }
    if (!entry || typeof entry !== "object" || entry.type !== "assistant") continue;
    const content = entry.message?.content ?? entry.content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text.trim()) return text;
    // An assistant entry with only tool calls is not the message; keep scanning backwards.
  }
  return "";
}

// The deterministic checks, wired one by one. Each returns findings for the emit stage.
function runDeterministicChecks(text, config) {
  const findings = [];

  // needs-you-first — needs you first. Calls the EXISTING check; not a fork, not a copy.
  if (effectiveMode(config, "needs-you-first") !== "off") {
    const r = checkNeedsYouFirst(text);
    if (r.flagged) {
      findings.push({
        rule: "needs-you-first",
        mode: effectiveMode(config, "needs-you-first"),
        text:
          `${cite("Needs you first", "needs-you-first")} — ${r.prosePrecedingChars} chars of substantive prose precede the Needs-you marker ` +
          `(line ${r.markerLine}). Move what needs the reader above the body.`,
        paste: paste("opening lines"),
      });
    }
  }

  // closing-ask-last — one closing ask, and it goes last.
  if (effectiveMode(config, "closing-ask-last") !== "off") {
    const r = checkClosingAskLast(text);
    if (r.flagged) {
      const detail =
        r.reason === "multiple-markers"
          ? `${r.markerCount} closing-ask markers (first at line ${r.markerLine}). Keep exactly one and fold the others into it.`
          : `${r.proseAfterChars} chars of substantive prose follow the closing-ask marker (line ${r.markerLine}). ` +
            `Move that prose above the ask so the ask is the last substantive thing.`;
      findings.push({
        rule: "closing-ask-last",
        mode: effectiveMode(config, "closing-ask-last"),
        text: `${cite("One closing ask", "closing-ask-last")} — ${detail}`,
        paste: paste("ending lines"),
      });
    }
  }

  // name-the-artifact — name the artifact. WARN by default (a vocabulary check, labeled as one); the
  // built-in default lives in lib/config.mjs, overridable per-rule or globally.
  if (effectiveMode(config, "name-the-artifact") !== "off") {
    const r = checkNamesArtifact(text);
    if (r.flagged) {
      findings.push({
        rule: "name-the-artifact",
        mode: effectiveMode(config, "name-the-artifact"),
        text:
          `${cite("Name the artifact", "name-the-artifact")} — this report-shaped message (${r.proseChars} chars, "${r.matchedVerb}" language) ` +
          `names no file, path, command, or URL. Add the artifact for the work described so the claim can be ` +
          `checked and resumed. (Vocabulary check; warn mode by default.)`,
      });
    }
  }

  // Plural back-reference in the closing ask — warn by default like every rule; the check is
  // applicable only when a closing-ask marker exists.
  if (effectiveMode(config, "plural-back-reference") !== "off") {
    const r = checkPluralBackReference(text);
    if (r.flagged) {
      const words = [...new Set(r.hits.map((h) => `"${h.word}"`))].join(", ");
      findings.push({
        rule: "plural-back-reference",
        mode: effectiveMode(config, "plural-back-reference"),
        text:
          `${cite("Plural back-reference", "plural-back-reference")} — the closing ask (line ${r.markerLine}) uses ` +
          `${words} with no referent in the same sentence. Restore the nouns so the ask reads alone.`,
        paste: paste("ask"),
      });
    }
  }

  return findings;
}

// A unit of a labeled message tells the judge what it is looking at: one section, judged alone.
function unitFraming(unit) {
  return unit.label
    ? `The message below is one labeled section (**${unit.label}**, line ${unit.line}) of a longer ` +
        "message; the reader reads each labeled section as its own message, so judge it alone."
    : "The message below is the unlabeled opening of a longer message, the text before its first " +
        "labeled section; the reader reads each section as its own message, so judge it alone.";
}

// The per-unit question for conclusion-first and bad-news-first: the rule's question, the
// framing when the message is labeled, then the unit's opening window — all outside the judged
// message, so the judge reads the unit verbatim and does not have to count words.
function unitQuestion(question, unit, sectioned) {
  const window = openingWords(unit.text);
  const count = window ? window.split(" ").length : 0;
  return [
    question,
    ...(sectioned ? [unitFraming(unit)] : []),
    `The reader's first ${count} words here are: "${window}".`,
  ].join(" ");
}

// One judge job per unit of `text` that passes `gate`. Unlabeled: one unit, the whole text.
function unitJobs(rule, question, units, gate) {
  const sectioned = units.some((u) => u.label);
  return units
    .filter((unit) => gate(unit.text).applicable)
    .map((unit) => ({
      rule,
      question: unitQuestion(question, unit, sectioned),
      contextText: unit.text,
      unit: sectioned ? unit : null,
    }));
}

// "**CLAIM** at line 12" — how a finding names a section of a labeled message.
const sectionName = (unit) =>
  unit.label ? `**${unit.label}** at line ${unit.line}` : "the opening before the first label, at line 1";

// House reason format for judge findings: rule named, what to move or add, judge's one-liner
// carried; the block-only paste instruction rides separately (see `paste`). `hits` is every
// violating job of ONE rule with its verdict, in job order (line order for sections); one
// builder per rule id. Only conclusion-first and bad-news-first can carry more than one hit:
// one per labeled section. Returns { text, paste }.
function judgeReason(hits) {
  const [{ job, verdict }] = hits;
  if (job.unit) {
    const where = hits.map((h) => `${sectionName(h.job.unit)} — judge: ${h.verdict.reason}`).join("; ");
    const count = hits.length === 1 ? "one section" : `${hits.length} sections`;
    if (job.rule === "conclusion-first") {
      return {
        text:
          `${cite("Conclusion first", job.rule)} — judged per labeled section, the point arrives after the opening ` +
          `${OPENING_WORDS} words in ${count}: ${where}. Move each named section's point into its opening ` +
          `${OPENING_WORDS} words and let the rest earn it.`,
        paste: paste("opening lines of each named section"),
      };
    }
    return {
      text:
        `${cite("Bad news first", job.rule)} — judged per labeled section, bad news arrives after the opening ` +
        `${OPENING_WORDS} words in ${count}: ${where}. Move the bad news into the opening ${OPENING_WORDS} words ` +
        `of each named section; the explanation goes second.`,
      paste: paste("opening lines of each named section"),
    };
  }
  switch (job.rule) {
    case "do-not-batch-by-label":
      return {
        text:
          `${cite("Do not batch by label", job.rule)} — the trailing "${job.heading}" section is judged a batched dump ` +
          `(judge: ${verdict.reason}). Move each item next to the thing it is about; a lead needs-you ` +
          `section pulling decisions to the top stays compliant.`,
        paste: paste("sections"),
      };
    case "conclusion-first":
      return {
        text:
          `${cite("Conclusion first", job.rule)} — the opening ${OPENING_WORDS} words are judged setup while the verdict arrives ` +
          `later (judge: ${verdict.reason}). Move the decision into the opening ${OPENING_WORDS} words and let the rest earn it.`,
        paste: paste("opening lines"),
      };
    case "restate-resumed-thread":
      return {
        text:
          `${cite("Restate the resumed thread", job.rule)} — this is the first message after a resume and it is judged to ` +
          `continue without restating the thread's subject and pending work (judge: ${verdict.reason}). ` +
          `Add a short restatement of subject and pending work at the top.`,
        paste: paste("opening lines"),
      };
    case "report-what-you-did-not-do":
      return {
        text:
          `${cite("Report what you did not do", job.rule)} — the last todo list had unfinished item(s) whose status this ` +
          `message is judged not to report (judge: ${verdict.reason}). Add one line per unfinished item: ` +
          `done, or not done with why.`,
        paste: "Paste the added lines only; never resend the whole message.",
      };
    case "bad-news-first":
      return {
        text:
          `${cite("Bad news first", job.rule)} — the message is judged to carry bad news that its opening ` +
          `${OPENING_WORDS} words neither state nor point to (judge: ${verdict.reason}). Move the bad news into the ` +
          `opening ${OPENING_WORDS} words; the explanation goes second.`,
        paste: paste("opening lines"),
      };
    default:
      return { text: `${cite(job.rule, job.rule)} — judge: ${verdict.reason}.`, paste: paste("lines") };
  }
}
function recordBlock(sessionId, textHash, rules) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(lastBlockedPath(sessionId), JSON.stringify({ sha256: textHash, rules, at: new Date().toISOString() }));
  } catch (err) {
    appendLog("errors.log", `could not record loop-guard hash for ${sessionId}: ${err.message}`);
  }
}

async function main() {
  const raw = readStdin();

  // 1. Kill switch — per invocation, from the file. Zero output is the documented behavior.
  if (existsSync(killSwitchPath())) return;
  // Secondary env switch. Caveat, documented: env is frozen per host process, so changing
  // this one means relaunching the host — the flag file above is the fast control.
  if (String(process.env.I_HAVE_AUDHD_ENFORCE || "").toLowerCase() === "off") return;

  // 2. Payload.
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch (err) {
    appendLog("errors.log", `stop payload did not parse: ${err.message}`);
    return;
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "no-session";

  // 3. Text.
  const text = extractText(payload);
  if (!text.trim()) return;

  // 4. Loop guard.
  const textHash = sha256hex(text);
  if (payload.stop_hook_active === true) {
    try {
      const prev = JSON.parse(readFileSync(lastBlockedPath(sessionId), "utf8"));
      if (prev && prev.sha256 === textHash) return; // same message, second pass: let it through
    } catch {
      /* no recorded hash = nothing to compare */
    }
  }

  // 5. Master floor. proseChars comes from the needs-you-first check's own accounting — one shared
  // definition of "substantive", not a second one that can drift.
  const r1 = checkNeedsYouFirst(text);
  if (r1.proseChars < MASTER_FLOOR) return;

  // 6–7. Checks per configured modes.
  const harness = process.env.I_HAVE_AUDHD_HARNESS;
  const config = loadEnforcement(harness);
  const findings = [...runDeterministicChecks(text, config)];

  // Judge-gated rules: deterministic trigger first; the judge runs only where a trigger fired
  // AND a judge command is configured. A skipped judge rule leaves a line in skipped.log —
  // inspectable, never silently dead. Judge jobs run in parallel so slow verdicts share
  // the harness-specific deadline rather than adding their waits together.
  const judgeJobs = [];

  // restate-resumed-thread — restate the resumed thread. The injector left a one-shot marker at session start
  // when the session came from resume/compact; THIS stop is the first substantive message
  // after it. Consuming the marker before dispatch means the judgment is one-shot even when
  // no judge is configured (the skip is logged) — a marker that survives a fired trigger
  // would re-judge every message in the session.
  if (effectiveMode(config, "restate-resumed-thread") !== "off" && existsSync(resumeMarkerPath(sessionId))) {
    try {
      rmSync(resumeMarkerPath(sessionId), { force: true });
      judgeJobs.push({ rule: "restate-resumed-thread", question: restateQuestion, contextText: text });
    } catch (err) {
      appendLog("errors.log", `could not consume resume marker for ${sessionId}: ${err.message}`);
    }
  }

  if (effectiveMode(config, "do-not-batch-by-label") !== "off") {
    const t = findTrailingBatchSection(text);
    if (t.applicable) {
      judgeJobs.push({
        rule: "do-not-batch-by-label",
        question: batchByLabelQuestion,
        contextText: batchJudgeContext(text, t),
        heading: t.heading,
      });
    }
  }

  // conclusion-first and bad-news-first judge each unit: every block-labeled section of a
  // labeled message on its own, or the whole message when it has no labels.
  const units = splitLabeledSections(text);

  // conclusion-first — conclusion first: 400 prose chars per unit; below that the judge would
  // only be guessing at "setup".
  if (effectiveMode(config, "conclusion-first") !== "off") {
    judgeJobs.push(...unitJobs("conclusion-first", conclusionFirstQuestion, units, conclusionFirstApplicable));
  }

  // report-what-you-did-not-do — report what you did not do. Needs the transcript: the trigger reads the session's
  // LAST todo list (Claude Code's TodoWrite call, or OMP's todo tool result; the OMP adapter passes
  // its session file as transcript_path). A payload with no transcript has no todo data, and the
  // boundary is documented: with no tracked plan the violation is silence.
  if (effectiveMode(config, "report-what-you-did-not-do") !== "off" && typeof payload.transcript_path === "string") {
    let transcriptRaw = "";
    try {
      transcriptRaw = readFileSync(payload.transcript_path, "utf8");
    } catch {
      transcriptRaw = ""; // unreadable transcript: not applicable, same as none
    }
    const todos = lastIncompleteTodos(transcriptRaw);
    if (todos.applicable) {
      judgeJobs.push({
        rule: "report-what-you-did-not-do",
        question: reportQuestion,
        contextText: todoJudgeContext(text, todos),
      });
    }
  }

  // bad-news-first — bad news first: the lexicon gate decides applicability only, per unit.
  // "Fixed the error" trips the gate and is exactly the message the judge must acquit.
  if (effectiveMode(config, "bad-news-first") !== "off") {
    judgeJobs.push(...unitJobs("bad-news-first", badNewsQuestion, units, badNewsGate));
  }
  if (judgeJobs.length) {
    if (!config.judgeCommand) {
      for (const job of judgeJobs) {
        appendLog("skipped.log", `rule=${job.rule} reason=no-judge-command`);
      }
    } else {
      const verdicts = await Promise.all(
        judgeJobs.map((job) => askJudge(job.rule, job.question, job.contextText, config)),
      );
      // One finding per rule: a rule judged per section collects every violating section.
      const hitsByRule = new Map();
      for (let i = 0; i < judgeJobs.length; i++) {
        const v = verdicts[i];
        if (v.error) continue; // already in judge-failures.log; fail open for this job only
        if (v.violation) {
          const rule = judgeJobs[i].rule;
          if (!hitsByRule.has(rule)) hitsByRule.set(rule, []);
          hitsByRule.get(rule).push({ job: judgeJobs[i], verdict: v });
        }
      }
      for (const [rule, hits] of hitsByRule) {
        findings.push({ rule, mode: effectiveMode(config, rule), ...judgeReason(hits) });
      }
    }
  }

  // 8. Harness cap. Every finding, deterministic or judge-gated, is in `findings` by now, so
  // this one pass covers every rule. Without the omp tag harnessCapsBlocks is false and
  // nothing here runs.
  if (harnessCapsBlocks(config, harness, payload.stop_hook_active)) {
    for (const f of findings) {
      if (f.mode === "block") f.mode = "warn";
    }
  }

  // 9. Emit. Warn findings go to warnings.log (the record) and to the session's pending notice
  // (the delivery: the agent reads it on its next turn, lib/pending.mjs); a stop with none
  // clears an older notice, so the next turn hears about this message only.
  const warns = findings.filter((f) => f.mode === "warn");
  for (const f of warns) appendLog("warnings.log", `rule=${f.rule} ${f.text}`);
  writePending(sessionId, warns);
  const blocks = findings.filter((f) => f.mode === "block");
  if (blocks.length) {
    recordBlock(sessionId, textHash, blocks.map((b) => b.rule).join(","));
    process.stdout.write(
      JSON.stringify({ decision: "block", reason: blocks.map((b) => `${b.text} ${b.paste ?? ""}`.trim()).join("\n\n") }),
    );
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err) => {
    // Fail open, and say so in the one place failures go.
    appendLog("errors.log", `stop hook failed open: ${err?.stack || String(err)}`);
    process.exit(0);
  });
}
