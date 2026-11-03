// Small hand-built transcripts in the two JSONL shapes the Stop check reads, for the tests.
//
// Shapes are taken from real transcripts on the author's machine (2026-10-14):
//  - Claude Code (~/.claude/projects/**): entries linked by uuid/parentUuid; a Skill tool call is
//    an assistant `tool_use` block {name:"Skill", input:{skill:"ask-graham:ask-graham", args}},
//    answered by a user `tool_result` ("Launching skill: …") and an isMeta user entry holding the
//    skill body; a slash command is a user entry with string content
//    "<command-message>…</command-message>\n<command-name>/…</command-name>\n<command-args>…</command-args>"
//    followed by the same isMeta body; each block of one response is its own entry sharing
//    message.id, and of two parallel tool calls only the first sits on the leaf's parent chain.
//  - OMP (~/.omp/agent/sessions/**): a title slot and a `session` header, then entries linked by
//    id/parentId; messages are {type:"message", message:{role, content}} with tool calls as
//    {type:"toolCall", name:"read", arguments:{path:"skill://…"}} and results as role
//    "toolResult". A typed `/skill:<name>` is a custom_message with customType "skill-prompt",
//    attribution "user", details {name, path, args?, prompt?, lineCount}, and content rendered from
//    OMP's src/prompts/skills/user-invocation.md. A session_stop block continues the turn with a
//    custom_message "session-stop-continuation" attributed to the agent.
//
// Each builder appends to one chain and returns the new entry's id; `at(id)` moves the append
// point, which is how a test makes a branch.

export const SKILL_BODY = "# Ask Graham\n\nGraham is a frontend engineer and a friend of Jo Wolff.";

function chain(idKey, parentKey, prefix) {
  const entries = [];
  let last = null;
  let n = 0;
  const add = (fields) => {
    const id = `${prefix}${String(++n).padStart(4, "0")}`;
    entries.push({ [parentKey]: last, [idKey]: id, ...fields });
    last = id;
    return id;
  };
  return {
    entries,
    add,
    at(id) {
      last = id;
    },
    get last() {
      return last;
    },
    jsonl() {
      return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    },
  };
}

/** A Claude Code transcript builder. */
export function claudeCode() {
  const c = chain("uuid", "parentUuid", "cc-");
  let msg = 0;
  let tool = 0;
  const base = { isSidechain: false, sessionId: "cc-session", timestamp: "2026-10-14T12:00:00.000Z" };
  const user = (content, extra = {}) => c.add({ ...base, type: "user", message: { role: "user", content }, ...extra });
  const assistant = (blocks, id = `msg_${++msg}`) =>
    blocks.map((b) => c.add({ ...base, type: "assistant", message: { id, role: "assistant", content: [b] } }));
  const toolCall = (name, input) => {
    const id = `toolu_${++tool}`;
    assistant([{ type: "tool_use", id, name, input }]);
    return id;
  };
  const result = (id, text) => user([{ type: "tool_result", tool_use_id: id, content: text }]);
  const skillBody = () => user([{ type: "text", text: `Base directory for this skill: /plugins/ask-graham/skills/ask-graham\n\n${SKILL_BODY}` }], { isMeta: true });
  return {
    ...c,
    prompt: (text) => user(text),
    attachment: () => c.add({ ...base, type: "attachment", attachment: { type: "date", date: "2026-10-14" } }),
    slash(name, args = "") {
      const id = user(`<command-message>${name.replace(/^\//, "")}</command-message>\n<command-name>/${name.replace(/^\//, "")}</command-name>\n<command-args>${args}</command-args>`);
      skillBody();
      return id;
    },
    skill(skill = "ask-graham:ask-graham", args) {
      const id = toolCall("Skill", args === undefined ? { skill } : { skill, args });
      result(id, `Launching skill: ${skill}`);
      skillBody();
    },
    read(path) {
      result(toolCall("Read", { file_path: path }), SKILL_BODY);
    },
    bash(command) {
      result(toolCall("Bash", { command }), "");
    },
    // Two tool calls in one response, chained the way Claude Code chains them: the second call is
    // a child of the first, its result a child of the second, and the first call's result a child
    // of the first call, so the leaf's parent chain runs through the first call only.
    parallel(first, second) {
      const id = `msg_${++msg}`;
      const a = c.add({ ...base, type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: "toolu_a", ...first }] } });
      const b = c.add({ ...base, type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: "toolu_b", ...second }] } });
      result("toolu_b", "");
      c.at(a);
      result("toolu_a", "");
      return b;
    },
    say(text) {
      return assistant([{ type: "text", text }])[0];
    },
    // One response written as a thinking entry then a text entry, as Claude Code writes it.
    sayInParts(...texts) {
      return assistant([{ type: "thinking", thinking: "", signature: "x" }, ...texts.map((text) => ({ type: "text", text }))]).at(-1);
    },
    stopSummary: () => c.add({ ...base, type: "system", subtype: "stop_hook_summary", hookCount: 1, preventedContinuation: false }),
  };
}

/** An OMP session file builder. */
export function omp() {
  const c = chain("id", "parentId", "om");
  c.entries.push({ type: "title", v: 1, title: "t", source: "auto" });
  c.entries.push({ type: "session", version: 3, id: "omp-session", cwd: "/repo" });
  c.add({ type: "model_change", model: "anthropic/claude", resolvedModelIsFallback: false });
  let tool = 0;
  const message = (role, content) => c.add({ type: "message", message: { role, content } });
  const toolCall = (name, args) => {
    const id = `call_${++tool}`;
    message("assistant", [{ type: "toolCall", id, name, arguments: args }]);
    c.add({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: SKILL_BODY }] } });
  };
  return {
    ...c,
    prompt: (text) => message("user", [{ type: "text", text }]),
    // `/skill:<name> <args>`, or with `prompt` the mid-prompt form (OMP folds the prose around the
    // token into args and keeps the draft in details.prompt).
    skillPrompt(name, args = "", prompt) {
      const content =
        `[IMPORTANT: User invoked the "${name}" skill; follow its instructions. Full skill below.]\n\n${SKILL_BODY}\n\n---\n\n` +
        `[Skill directory: /plugins/ask-graham/skills/${name}]\nResolve relative paths in this skill against this absolute directory.\n` +
        (args ? `User: ${args}\n` : "");
      const details = { name, path: `/plugins/ask-graham/skills/${name}/SKILL.md`, lineCount: 3, ...(args ? { args } : {}), ...(prompt ? { prompt } : {}) };
      return c.add({ type: "custom_message", customType: "skill-prompt", content, display: true, details, attribution: "user" });
    },
    // The same message as an agent or autoload injection: neither an opener nor an invocation.
    agentSkillPrompt(name) {
      return c.add({ type: "custom_message", customType: "skill-prompt", content: SKILL_BODY, display: true, details: { name, path: "/x", lineCount: 1 }, attribution: "agent" });
    },
    read: (path) => toolCall("read", { path }),
    bash: (command) => toolCall("bash", { command }),
    say: (text) => message("assistant", [{ type: "text", text }]),
    continuation: (reason) => c.add({ type: "custom_message", customType: "session-stop-continuation", content: reason, display: false, attribution: "agent" }),
  };
}
