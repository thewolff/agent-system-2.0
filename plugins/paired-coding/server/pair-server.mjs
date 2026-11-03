#!/usr/bin/env node
// pair-server.mjs — the Claude Code adapter's tool server: a stdio MCP server bundled with the
// plugin (.mcp.json at the plugin root) that serves every pair_* tool.
//
// Each tools/call is bound to its session through the PreToolUse hook (binding.mjs), then run
// by lib/verbs.mjs, whose checks read the arguments this server received: whatever another
// hook did to the input before the call reached here, these are the final arguments.
// No dependencies: newline-delimited JSON-RPC 2.0 over stdin/stdout, written by hand.

import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { stateBase } from "../lib/host-io.mjs";
import { VERSION, executeVerb, sessionDirFor } from "../lib/verbs.mjs";
import { takeBinding } from "./binding.mjs";

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const str = (description) => ({ type: "string", description });
const strs = (description) => ({ type: "array", items: { type: "string" }, description });

/** Tool definitions. `anthropic/alwaysLoad` keeps them out of Claude Code's deferred-tool search. */
export const TOOLS = [
  {
    name: "pair_start",
    description: "Start paired coding in this session. From then on the host's write, edit, shell and sub-agent tools are refused; files change only through pair_write/pair_edit inside a change set your partner agreed to, and commands run only through pair_run.",
    inputSchema: { type: "object", properties: { exclusions: strs("Worktree-relative directories to leave out of snapshots (large generated directories). .git is always excluded.") } },
  },
  {
    name: "pair_note",
    description: "Append a note to the pairing journal: free text, a roadmap, or both. The latest roadmap replaces the one before; pair_done lists its items still open or not ready, and the next pair_start in this worktree offers them. Answer a roadmap pair_start offered with earlierRoadmap. The only way to keep notes while pairing.",
    inputSchema: {
      type: "object",
      properties: {
        text: str("The note."),
        roadmap: {
          type: "array",
          description: "The whole roadmap, replacing the previous one.",
          items: {
            type: "object",
            properties: {
              id: str("A short id, unique in the roadmap."),
              title: str("What the item is."),
              status: { type: "string", enum: ["open", "done", "skipped", "dropped", "not-ready"] },
              note: str("One line. Required for not-ready: what it waits for."),
            },
            required: ["id", "title", "status"],
          },
        },
        earlierRoadmap: { type: "string", enum: ["pick-up", "start-fresh"], description: "Your partner's answer to the earlier roadmap pair_start offered: pick-up carries it into this session, start-fresh sets it aside for good. Not with roadmap." },
      },
    },
  },
  {
    name: "pair_propose",
    description: "Record the next change card. Its boundary is hashed now; only a turn your partner types after this card can agree to it.",
    inputSchema: {
      type: "object",
      properties: {
        boundary: strs("Worktree-relative files or globs (* ? **, or dir/ for a subtree) this change set may write."),
        whyNow: str("One line tying it to the roadmap."),
        decision: str("The choice inside it your partner might disagree with."),
        currentCode: str("The smallest excerpt of what it touches."),
        proposedCode: str("The planned code: the whole new or changed function, or a diff. Show it on the card before asking for agreement."),
        effect: str("What behaves differently afterward."),
        checks: strs("The checks it will run."),
        openPoints: strs("Anything your partner must settle first. A card with open points cannot be agreed."),
      },
      required: ["boundary"],
    },
  },
  {
    name: "pair_begin",
    description: "Open the change set for the latest card once your partner agreed. Needs the card id and a verbatim quote of your partner's agreement from their latest typed turn after the card.",
    inputSchema: { type: "object", properties: { cardId: str("The latest card's id, e.g. card-1."), quote: str("Your partner's words, copied exactly.") }, required: ["cardId", "quote"] },
  },
  {
    name: "pair_done",
    description: "Close the open change set. Kills anything left from its pair_run calls, snapshots the worktree and returns the machine-produced diff of the boundary since pair_begin for the read-back.",
    inputSchema: { type: "object", properties: { cardId: str("The open change set's card id.") }, required: ["cardId"] },
  },
  {
    name: "pair_write",
    description: "Write a whole file inside the open change set's boundary.",
    inputSchema: { type: "object", properties: { path: str("Worktree-relative or absolute path."), content: str("The full new content.") }, required: ["path", "content"] },
  },
  {
    name: "pair_edit",
    description: "Replace exact text in a file inside the open change set's boundary.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Worktree-relative or absolute path."),
        oldString: str("Exact text to replace; must occur once unless replaceAll is true."),
        newString: str("Replacement text."),
        replaceAll: { type: "boolean", description: "Replace every occurrence." },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  {
    name: "pair_run",
    description: "Run a shell command in the worktree, in the foreground, under a macOS sandbox built from the pairing state: with no change set open it writes nowhere but temp; with one open only its boundary and temp are writable. Times out and kills the whole process group. In Claude Code the timeout stays under the host's automatic-backgrounding threshold (2 minutes unless CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS says otherwise; 0 lifts the cap).",
    inputSchema: { type: "object", properties: { command: str("The /bin/sh command."), timeoutSeconds: { type: "number", description: "Default 600, at most 3600, and capped below Claude Code's automatic-backgrounding threshold." } }, required: ["command"] },
  },
].map((t) => ({ ...t, _meta: { "anthropic/alwaysLoad": true } }));

const NAMES = new Set(TOOLS.map((t) => t.name));

/** Margin kept between pair_run's timeout and Claude Code's automatic-backgrounding threshold. */
const BACKGROUND_MARGIN_MS = 10_000;

/**
 * The longest pair_run that stays in the foreground. Claude Code moves a main-conversation MCP
 * call to a background task after CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS (default 120000; 0 turns
 * it off), and a backgrounded pair_run would let the agent move on while it still runs.
 * @param {Record<string, string | undefined>} env
 * @returns {number | undefined}
 */
export function foregroundCapMs(env) {
  const raw = env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS;
  if (env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === "1" || raw === "0") return undefined;
  const threshold = raw !== undefined && Number(raw) > 0 ? Number(raw) : 120_000;
  return Math.max(1_000, threshold - BACKGROUND_MARGIN_MS);
}

/**
 * Handle one tools/call. Exported for tests.
 * @param {{ name?: unknown, arguments?: unknown, _meta?: Record<string, unknown> }} params
 * @param {{ env?: Record<string, string | undefined>, signal?: AbortSignal }} [opts]
 */
export async function callTool(params, opts = {}) {
  const env = opts.env ?? process.env;
  const name = typeof params?.name === "string" ? params.name : "";
  if (!NAMES.has(name)) return errorResult(`unknown tool ${name}`);
  const toolUseId = params?._meta?.["claudecode/toolUseId"];
  const binding = takeBinding(stateBase(env), toolUseId, name);
  if (!binding) {
    return errorResult(`${name} refused: this call is not bound to a session (the paired-coding PreToolUse hook did not see it), so the gate cannot check it`);
  }
  const sessionDir = sessionDirFor(binding.sessionId, env);
  if (!sessionDir) return errorResult(`${name} refused: unusable session id`);
  const protect = typeof binding.transcriptPath === "string" && binding.transcriptPath.startsWith("/") ? [dirname(binding.transcriptPath)] : [];
  const r = await executeVerb(name, params.arguments ?? {}, {
    sessionId: binding.sessionId,
    sessionDir,
    cwd: binding.cwd,
    signal: opts.signal,
    runId: toolUseId,
    protect,
    maxTimeoutMs: foregroundCapMs(env),
  });
  return { content: [{ type: "text", text: r.text }], isError: !r.ok };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function main() {
  const inflight = new Map();
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg ?? {};
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "paired-coding", version: VERSION },
          instructions: "Paired coding tools. Inert until pair_start. While pairing, write only with pair_write/pair_edit inside an agreed change set and run commands only with pair_run. Only your partner ends pairing, by typing pair stop as a whole message.",
        },
      });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const ac = new AbortController();
      inflight.set(id, ac);
      callTool(params, { signal: ac.signal })
        .catch((err) => errorResult(`adapter error: ${err instanceof Error ? err.message : String(err)}`))
        .then((result) => {
          inflight.delete(id);
          send({ jsonrpc: "2.0", id, result });
        });
    } else if (method === "notifications/cancelled") {
      inflight.get(params?.requestId)?.abort();
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined && id !== null) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  });
  rl.on("close", () => {
    // Claude Code went away: abort every running pair_run (which kills its process group).
    for (const ac of inflight.values()) ac.abort();
    setTimeout(() => process.exit(0), inflight.size ? 4000 : 0).unref();
  });
}

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
