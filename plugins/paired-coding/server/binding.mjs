// binding.mjs — how the Claude Code adapter ties a call of its MCP tools to a session.
//
// A plugin's stdio MCP server is one long-lived process per Claude Code process. It is not told
// the session id, and it outlives a session (/clear starts a new one). The PreToolUse hook is
// told the session id and the call's tool_use_id; Claude Code then sends the same id to the
// server as `_meta["claudecode/toolUseId"]` on tools/call. So the hook writes a one-shot
// binding file named by the tool_use_id, and the server reads and deletes it before it acts.
// A call the hook never saw has no binding, and the server refuses it.

import { readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PAIR_TOOLS } from "../core/gate.mjs";

export const PLUGIN = "paired-coding";
export const SERVER = "pair";
/** Claude Code's callable name prefix for this plugin's server (mcp__plugin_<plugin>_<server>__). */
export const TOOL_PREFIX = `mcp__plugin_${PLUGIN}_${SERVER}__`;
/** The scoped server name Claude Code reports in a PreToolUse event's `mcp_server.name`. */
export const SERVER_NAME = `plugin:${PLUGIN}:${SERVER}`;
/** Claude Code tools that pairing must not break and that cannot write or run code. */
export const HOST_ALLOW = Object.freeze(["ToolSearch", "TodoWrite", "AskUserQuestion"]);
/** This plugin's own skill, as Claude Code's Skill tool names a plugin-qualified skill. */
export const OWN_SKILL = `${PLUGIN}:paired-coding`;

/**
 * The host tools to allow for this call: HOST_ALLOW, plus `Skill` when the call loads this
 * plugin's own skill (`tool_input.skill`, trimmed, one leading slash dropped, as Claude Code's
 * Skill tool reads it). Any other skill stays refused while pairing.
 * @param {{ tool_name?: unknown, tool_input?: { skill?: unknown } }} input
 */
export function hostAllowFor(input) {
  const skill = input?.tool_name === "Skill" ? input.tool_input?.skill : undefined;
  if (typeof skill !== "string") return HOST_ALLOW;
  const name = skill.trim();
  return (name.startsWith("/") ? name.slice(1) : name) === OWN_SKILL ? [...HOST_ALLOW, "Skill"] : HOST_ALLOW;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The bare tool name the gate judges. This plugin's own tools become `pair_*` only when Claude
 * Code reports them as coming from this plugin's server (`mcp_server.source === "plugin"`);
 * a look-alike name from any other server keeps its full name and is refused while pairing.
 * @param {{ tool_name?: unknown, mcp_server?: { name?: unknown, source?: unknown } }} input
 */
export function bareToolName(input) {
  const name = typeof input?.tool_name === "string" ? input.tool_name : "";
  if (!name.startsWith(TOOL_PREFIX)) return name;
  const own = input.mcp_server?.source === "plugin" && input.mcp_server?.name === SERVER_NAME;
  const bare = name.slice(TOOL_PREFIX.length);
  return own && PAIR_TOOLS.includes(bare) ? bare : name;
}

function bindingsDir(base) {
  return join(base, "bindings");
}

/** Hook side: record that this tool_use_id belongs to this session. */
export function writeBinding(base, toolUseId, binding) {
  if (typeof toolUseId !== "string" || !SAFE_ID.test(toolUseId)) throw new Error("unusable tool_use_id");
  const dir = bindingsDir(base);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${toolUseId}.json`);
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...binding, at: Date.now() }), { mode: 0o600 });
  renameSync(tmp, path);
  prune(dir);
}

/**
 * Server side: read and delete the binding for this call. Null when there is none, when it is
 * stale, or when it was written for a different tool.
 */
export function takeBinding(base, toolUseId, tool) {
  if (typeof toolUseId !== "string" || !SAFE_ID.test(toolUseId)) return null;
  const path = join(bindingsDir(base), `${toolUseId}.json`);
  let b;
  try {
    b = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  if (!b || typeof b !== "object" || b.tool !== tool || typeof b.sessionId !== "string") return null;
  if (!(Date.now() - b.at < MAX_AGE_MS)) return null;
  return b;
}

function prune(dir) {
  const cutoff = Date.now() - MAX_AGE_MS;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* raced */ }
    }
  } catch { /* nothing to prune */ }
}
