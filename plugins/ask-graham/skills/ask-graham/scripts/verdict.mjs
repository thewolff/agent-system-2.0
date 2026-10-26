// verdict.mjs — the four verdicts an ask-graham answer ends in, in the order SKILL.md step 5 lists
// them, and the Stop check built on them. vocabulary.test.mjs checks SKILL.md's table and Output
// template against VERDICTS. The Claude Code Stop hook (hooks/ask-graham-stop.mjs) and the OMP
// session_stop handler (omp/ask-graham-omp.ts) both call checkStop; every function here is pure
// (no I/O), so the two harnesses differ only in how they read the transcript and keep the
// once-per-turn record.
//
// THE CHECK. A main-session turn that read the ask-graham skill must end in a line
// `**Verdict:** <one of VERDICTS>`, unless it ends by asking the comparables question and waiting.
// A turn that did not read the skill, or whose only uses of it were settings invocations (`/ask-graham intensity`, `/ask-graham stop-check`), is not checked.
// The adapters skip the check entirely when the stop-check setting is off. The check blocks at most once per
// turn: the caller keeps the opener id of the turn it last blocked and passes it back as
// `blockedOpener`.
//
// TRANSCRIPTS. Both harnesses write a JSONL tree. Claude Code links entries by uuid/parentUuid,
// OMP by id/parentId. The active turn is read by walking the parent chain back from the leaf (the
// last entry with an id), so an abandoned branch or a rewound turn is never read.

export const VERDICTS = Object.freeze(["do it now", "start now", "later", "don't build"]);

// "don't" matches a straight or a curly apostrophe.
const VERDICT_ALT = VERDICTS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("'", "['’]")).join("|");

// A line whose label is Verdict: optional list marker or heading, optional bold with the colon
// inside or outside it, optional emphasis around the verdict, then end, space or punctuation.
const VERDICT_LINE = new RegExp(
  String.raw`^[ \t]*(?:[-*+>][ \t]+|#{1,6}[ \t]+)?(?:\*\*|__)?Verdict(?::(?:\*\*|__)?|(?:\*\*|__)?:)[ \t]*(?:\*\*|__|\*|_)?(` +
    VERDICT_ALT +
    String.raw`)(?=$|\s|\p{P})`,
  "imu",
);

/** The verdict a text gives on a `Verdict:` line, as written in VERDICTS, or null. */
export function findVerdict(text) {
  if (typeof text !== "string") return null;
  const m = VERDICT_LINE.exec(text);
  if (!m) return null;
  const said = m[1].toLowerCase().replace("’", "'");
  return VERDICTS.find((v) => v === said) ?? null;
}

const isObject = (v) => v !== null && typeof v === "object";

/** Parse JSONL text into entries; a line that is not a JSON object is skipped. */
export function parseJsonl(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") entries.push(e);
    } catch {
      // a torn line in a transcript being written is not a reason to fail
    }
  }
  return entries;
}

// Claude Code entries carry uuid/parentUuid; OMP entries carry id/parentId.
const idOf = (e) => (typeof e.uuid === "string" ? e.uuid : typeof e.id === "string" ? e.id : null);
const parentOf = (e) => {
  const p = "parentUuid" in e ? e.parentUuid : e.parentId;
  return typeof p === "string" ? p : null;
};

// The text of a content value: a string, or the text blocks of an array joined by newlines.
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// OMP: a `/skill:<name>` the user typed, leading or mid-prompt, which OMP stores as a
// user-attributed custom message (customType "skill-prompt"). Agent or autoload injections of the
// same type carry another attribution and are neither openers nor invocations.
const isUserSkillPrompt = (e) => e.type === "custom_message" && e.customType === "skill-prompt" && e.attribution === "user";

// Whether an entry opens a turn: a prompt the person sent.
//  - Claude Code: a `user` entry with string or text content. Not isMeta (a slash command's
//    expanded skill body), not a compact summary, not a tool_result. Hook output is written as
//    `attachment` or `system` entries, so it never opens a turn.
//  - OMP: a `message` with role user, or a user-invoked skill prompt. A session_stop
//    continuation is a custom message attributed to the agent, so it does not open a turn.
function isOpener(e) {
  if (e.type === "user") {
    if (e.isMeta || e.isCompactSummary || e.isSidechain) return false;
    const content = e.message?.content;
    if (typeof content === "string") return true;
    if (!Array.isArray(content)) return false;
    if (content.some((b) => isObject(b) && b.type === "tool_result")) return false;
    return content.some((b) => isObject(b) && (b.type === "text" || b.type === "image"));
  }
  if (e.type === "message") return e.message?.role === "user";
  return isUserSkillPrompt(e);
}

// Claude Code writes each block of one model response as its own entry, all with the same
// message.id. Parallel tool calls are such blocks, and their results are chained so that only
// one of them sits on the parent chain from the leaf (seen in real transcripts). The id of the
// response an assistant entry belongs to, for collecting those siblings back into the turn.
const responseId = (e) => (e.type === "assistant" && typeof e.message?.id === "string" ? e.message.id : null);

/**
 * The active turn of one parsed JSONL transcript, either harness: the turn opener's id and, in
 * file order, the opener plus every entry after it on the parent chain from the leaf (plus, on
 * Claude Code, the parallel blocks of a response on that chain). When the chain ends without an
 * opener, the turn is the whole chain and its id is the chain's root. Null when no entry has an id.
 */
export function currentTurn(entries) {
  if (!Array.isArray(entries)) return null;
  const byId = new Map();
  let leaf = null;
  for (const e of entries) {
    if (!isObject(e)) continue;
    const id = idOf(e);
    if (id === null) continue;
    byId.set(id, e);
    if (!e.isSidechain) leaf = e;
  }
  if (!leaf) return null;
  const chain = new Set();
  let opener = null;
  let root = leaf;
  for (let e = leaf; e && !chain.has(e); e = byId.get(parentOf(e))) {
    chain.add(e);
    root = e;
    if (isOpener(e)) {
      opener = e;
      break;
    }
  }
  const responses = new Set([...chain].map(responseId).filter(Boolean));
  const inTurn = (e) => chain.has(e) || (responses.has(responseId(e)) && !e.isSidechain);
  return { id: idOf(opener ?? root), entries: entries.filter((e) => isObject(e) && inTurn(e)) };
}

// `ask-graham` or `<plugin>:ask-graham` (Claude Code), `ask-graham` or `<ns>/ask-graham` (OMP).
const isSkillName = (name) => typeof name === "string" && /^(?:[^\s:/]+[:/])?ask-graham$/.test(name);

// A read of the skill file: OMP `skill://ask-graham`, `skill://<ns>/ask-graham` (optionally
// `/SKILL.md`), or any path ending `/ask-graham/SKILL.md`. An OMP `:<lines>` selector is ignored.
function isSkillPath(path) {
  if (typeof path !== "string") return false;
  const p = path.replace(/:[^/]*$/, "");
  return /^skill:\/\/(?:[^/]+\/)?ask-graham(?:\/SKILL\.md)?$/.test(p) || /(?:^|\/)ask-graham\/SKILL\.md$/.test(p);
}

// The `User: <args>` line OMP's user-invocation template ends a skill prompt with.
function userLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith("User: "));
  return lines.length ? lines[lines.length - 1].slice("User: ".length) : null;
}

// Invocation args that ask for a settings subcommand: `intensity` or `stop-check`, optionally
// followed by more.
const isSettings = (args) => typeof args === "string" && /^(?:intensity|stop-check)(?:\s|$)/i.test(args.trim());

/**
 * Whether a turn read the ask-graham skill, and whether every such use was a settings
 * invocation. Reading counts as: a Claude Code Skill tool call or `/ask-graham` slash command, an
 * OMP user-invoked `/skill:ask-graham`, or a file read (Claude Code Read, OMP read) of the skill.
 * A skill body pasted into an ordinary prompt does not count. Returns `{ read, settingsOnly }`;
 * settingsOnly is true iff read is, and every use was an invocation whose args start with
 * `intensity` or `stop-check`. A file read, or an invocation with no args or other args, makes it false.
 */
export function skillUse(turn) {
  let read = false;
  let settingsOnly = true;
  const invoked = (a) => {
    read = true;
    if (!isSettings(a)) settingsOnly = false;
  };
  const fileRead = () => {
    read = true;
    settingsOnly = false;
  };
  for (const e of turn?.entries ?? []) {
    if (e.type === "user" && isOpener(e)) {
      const text = contentText(e.message?.content);
      const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text);
      if (name && isSkillName(name[1].trim())) {
        const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
        invoked(a ? a[1] : null);
      }
    } else if (isUserSkillPrompt(e)) {
      const d = isObject(e.details) ? e.details : {};
      if (isSkillName(d.name)) invoked(typeof d.args === "string" ? d.args : userLine(contentText(e.content)));
    } else if (e.type === "assistant" || (e.type === "message" && e.message?.role === "assistant")) {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!isObject(b)) continue;
        if (b.type === "tool_use" && b.name === "Skill" && isSkillName(b.input?.skill)) invoked(b.input?.args);
        else if (b.type === "tool_use" && b.name === "Read" && isSkillPath(b.input?.file_path)) fileRead();
        else if (b.type === "toolCall" && b.name === "read" && isSkillPath(b.arguments?.path)) fileRead();
      }
    }
  }
  return { read, settingsOnly: read && settingsOnly };
}

/**
 * The last assistant text on a turn. On Claude Code one response can span several entries with
 * the same message.id; their text is joined. Null when the turn has no assistant text.
 */
export function lastAssistantText(turn) {
  const list = turn?.entries ?? [];
  const textOf = (e) =>
    e.type === "assistant" || (e.type === "message" && e.message?.role === "assistant") ? contentText(e.message?.content) : "";
  for (let i = list.length - 1; i >= 0; i--) {
    if (!textOf(list[i]).trim()) continue;
    const rid = responseId(list[i]);
    if (!rid) return textOf(list[i]);
    return list
      .filter((e) => responseId(e) === rid)
      .map(textOf)
      .filter((t) => t.trim())
      .join("\n");
  }
  return null;
}

/** The reason a block gives the agent: what is missing, and the line to add. */
export const BLOCK_REASON =
  "ask-graham: this turn read the ask-graham skill, but the reply has no verdict line. Add one line " +
  `\`**Verdict:** <verdict>\` naming exactly one of: ${VERDICTS.join(", ")} (SKILL.md step 5). ` +
  "Reply with the verdict line and anything it changes only; do not resend the whole answer.";

/**
 * The Stop check for one stop. `entries` is the parsed transcript, `text` the final assistant
 * text (when absent, the last assistant text on the turn), `blockedOpener` the turn opener id
 * this caller last blocked in this session (or null).
 *
 * Returns `{ block: <reason>, opener }` when the stop must be blocked, which the caller records
 * as its new blockedOpener, or `{ pass: <why>, opener }` otherwise, `why` being one of
 * "no-turn", "no-skill-read", "settings" (every skill use was a settings invocation),
 * "verdict", "comparables-question", "already-blocked". `opener` is the turn opener's id, or null with "no-turn".
 */
export function checkStop({ entries, text, blockedOpener = null } = {}) {
  const turn = currentTurn(entries);
  if (!turn) return { pass: "no-turn", opener: null };
  const opener = turn.id;
  const use = skillUse(turn);
  if (!use.read) return { pass: "no-skill-read", opener };
  if (use.settingsOnly) return { pass: "settings", opener };
  const finalText = typeof text === "string" && text.trim() ? text : lastAssistantText(turn);
  if (findVerdict(finalText)) return { pass: "verdict", opener };
  // Only the exact question on the final line signals a wait, not a quotation or a report
  // mentioning it. Use the same final text as the verdict check in both harnesses.
  if (typeof finalText === "string" &&
      /(?:^|\n)[ \t]*Do you want me to research and see if something comparable exists\?[ \t]*$/.test(finalText.trimEnd())) {
    return { pass: "comparables-question", opener };
  }
  if (blockedOpener !== null && blockedOpener === opener) return { pass: "already-blocked", opener };
  return { block: BLOCK_REASON, opener };
}
