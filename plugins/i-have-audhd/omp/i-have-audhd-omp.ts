// i-have-audhd-omp.ts — OMP adapter for the i-have-audhd plugin.
//
// WHY: OMP does not run a plugin's hooks/hooks.json; it loads TS extension modules. This file
// bridges the plugin's two Claude Code hooks to OMP events without copying their policy:
// both hooks are stdin-JSON CLIs, spawned here, never imported.
//
//   hooks/i-have-audhd-inject.mjs   session_start / session_switch / session_compact →
//                                   additionalContext, offered through before_agent_start as
//                                   a hidden custom message until a context event carries it
//   hooks/i-have-audhd-stop.mjs     session_stop → the CLI's verdict as a session_stop block
//
// REGISTRATION: package.json `omp.extensions` declares this file, so `omp plugin install
// i-have-audhd@jo-wolff-plugins` loads it. REGISTRATION.md beside this file carries the
// manual-symlink fallback and the isolated live probe.
//
// MAIN SESSION ONLY. OMP's session_stop never fires for subagent sessions, and OMP has no
// blocking SubagentStop equivalent. OMP rebinds extension factories to every subagent
// session, so session_start does fire there; the injection skips any ctx.agent.kind "sub",
// because subagents write to the main agent, not to the person the rules are for.
//
// SESSION-START SOURCES, mapped to the Claude Code SessionStart `source` the inject hook reads:
//   session_start                startup, or resume when the loaded session already holds
//                                messages (omp --resume / --continue)
//   session_switch reason new    clear (a fresh session: core again, no resume marker)
//   session_switch resume|fork   resume
//   session_compact              compact
// The hook writes the rule 8 resume marker for resume and compact, keyed by the session id it
// is sent. ONE SESSION ID: both hooks and this file's own-block record use
// ctx.sessionManager.getSessionId(), not the session_stop payload's session_id. That payload
// carries the provider id, which an in-place fresh-session or context reset rotates
// (pi-coding-agent session/agent-session.ts, #activeProviderSessionId) while the session
// manager's id stays put. The payload id is used only when the manager id is unreadable.
//
// DELIVERY, once per crossing: each crossing's context waits as `pending`, tagged with a fresh
// delivery id in the custom message's details. before_agent_start returns it every time it
// runs, because OMP may re-run the whole before_agent_start chain for one submission and
// publishes only the accepted attempt's messages (omp extensions.md, "Handlers must tolerate
// re-entry"). It is cleared only by a `context` event whose messages hold a custom message of
// this type with the current delivery id: the accepted attempt reached a provider request.
// Other context events, and an earlier crossing's message still in history, leave it pending.
// The one gap errs toward a repeat, never a loss: a turn aborted after OMP accepted the
// message but before any provider request offers it again on the next prompt.
//
// LOOP GUARD, keyed on this plugin's own block: OMP sets stop_hook_active after ANY
// session_stop continuation, another extension's `continue: true` included
// (pi-coding-agent session/agent-session.ts, #sessionStopContinuationContext and
// #emitSessionStop). So the CLI is sent stop_hook_active: true only when the host flag is
// true AND this handler's previous result for the same session (the manager id above) was a
// block; see blockedLastStop below. Every stop is checked, a revision that follows a block
// included. The CLI then (a) lets an identical repeat through on its text-hash guard, and
// (b) under the omp harness tag never blocks a stop sent with stop_hook_active: a changed
// revision is re-checked but can only warn. That bounds the loop OMP itself does not bound
// (it exempts decision:"block" from its session_stop continuation cap): this plugin blocks at
// most once per continuation chain, and another extension's continuation does not spend that
// block.
//
// WARN UNLESS ARMED, in the core: the child's env carries I_HAVE_AUDHD_HARNESS=omp,
// and the core turns every block into a warn unless the profile sets
// enforcement.armOmp: true (lib/config.mjs, harnessCapsBlocks). A capped block takes the
// core's own warn path, so warnings.log carries the real rule id and no block hash is
// recorded for a block that was never delivered. This file returns the CLI's verdict as is;
// it holds no mode of its own.
//
// KILL SWITCH: the CLI's own — `touch $HOME/.claude/.i-have-audhd-off`, checked
// inside the CLI per invocation and effective within one turn. This adapter has none of its
// own; one switch, one place.
//
// FAIL-OPEN CONTRACT. A dead adapter must be visible, never fatal: every failure path (CLI
// crash, non-zero exit, unparseable stdout, timeout, any thrown error anywhere) returns
// undefined and leaves one `omp-adapter fail-open: …` line in errors.log. That line is the
// tally: `grep -c 'omp-adapter fail-open' errors.log`.
//
// TIMEOUT: three budgets, nested so each settles inside the next.
//   - OMP abandons a session_stop handler at 30s (EXTENSION_HANDLER_TIMEOUT_MS,
//     pi-coding-agent extensibility/extensions/runner.ts) and drops its result.
//   - This adapter gives the stop CLI 25s, owned by spawnHook, which SIGKILLs the CLI's whole
//     process group when it fires: a backstop for a core that is stuck, and it still leaves
//     the fail-open line room to land before the host gives up.
//   - The core runs its judge calls in parallel (i-have-audhd-stop.mjs, Promise.all over
//     askJudge). Under the I_HAVE_AUDHD_HARNESS=omp tag this adapter puts on the child, each
//     judge gets 20s (judge/ask.mjs, THE TIMEOUT), then its process group is reaped. A hung
//     judge therefore ends as one judge-failures.log line, and the core still emits its
//     deterministic findings and exits, about 20s after the stop began: inside the adapter's
//     25s, so the verdict or warning is the core's own, not a kill.
//   Untagged Claude Code runs keep the judge's 30s. No profile field or env var changes any
//   of these values.
// The inject CLI reads two files and judges nothing; it gets 10s.
//
// SYNTAX: erasable-types TypeScript only, so node v24.13 strips the types and imports this
// module without Bun. The spawn is node:child_process, which Bun implements, so the default
// path runs under both node --test and the omp host. `pi` is typed structurally — zero
// imports from @oh-my-pi.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The plugin root is this module's parent directory (omp/..), so the adapter finds its core
// wherever the plugin is checked out. I_HAVE_AUDHD_PLUGIN_ROOT still overrides it.
const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_TIMEOUT_MS = 25_000;
const INJECT_TIMEOUT_MS = 10_000;
const CONTEXT_MESSAGE_TYPE = "i-have-audhd-session-start";

type StopEvent = {
  session_id?: unknown;
  session_file?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
};

// What either hook CLI prints: the stop core's verdict, or the inject hook's SessionStart output.
type CliOutput = { decision?: unknown; reason?: unknown; hookSpecificOutput?: unknown };

type RunCli = (payload: string, cwd: string, timeoutMs: number) => Promise<CliOutput | undefined>;

type HandlerDeps = {
  runCli?: RunCli;
  stateDir?: string;
  timeoutMs?: number;
};

// The Claude Code SessionStart sources the inject hook understands.
export type StartSource = "startup" | "resume" | "clear" | "compact";

// The slice of OMP's extension context this adapter reads, typed structurally.
type Ctx = {
  cwd: string;
  agent?: { kind?: unknown };
  sessionManager?: { getSessionId?: () => unknown; getEntries?: () => unknown };
};

// Stable session ids (see managerSessionId) whose most recent result from this handler was a
// block. One per loaded module, so one per omp process. Bounded without eviction: an id is
// added only on a block and removed on that session's next call through this handler, whatever
// its result, so the set holds at most the sessions whose latest stop this plugin blocked and
// that have not stopped since. A session with no readable id shares the key "", which keeps the
// cap rather than dropping it.
const blockedLastStop = new Set<string>();

// The session manager's id: stable across the provider-id rotations a fresh-session or context
// reset makes, and the id both hooks are keyed on. Undefined when unreadable or empty.
function managerSessionId(ctx: Ctx): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

// Structural stand-in for the host's extension API: the events this adapter registers.
// Deliberately local — importing @oh-my-pi would couple the plugin to one host build.
type PiLike = {
  on(name: "session_stop", handler: (event: StopEvent, ctx: Ctx) => unknown): void;
  on(name: "session_start" | "session_compact", handler: (event: unknown, ctx: Ctx) => unknown): void;
  on(name: "session_switch", handler: (event: { reason?: unknown }, ctx: Ctx) => unknown): void;
  on(name: "before_agent_start", handler: (event: unknown, ctx: Ctx) => unknown): void;
  on(name: "context", handler: (event: { messages?: unknown }, ctx: Ctx) => unknown): void;
};

// Whitespace collapsed, trimmed, capped — the shape every log line shares (appendLog
// collapses again; that pass is idempotent).
const collapse = (text: string, max = 300): string => text.replace(/\s+/g, " ").trim().slice(0, max);

// The finished message's text: string content, or text-block content joined by newlines.
// Semantics verbatim from the live adapter's reducer — empty string
// and missing content are both undefined, so the payload fallback "" applies downstream.
export function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { content?: unknown };
  if (typeof candidate.content === "string") return candidate.content || undefined;
  if (!Array.isArray(candidate.content)) return undefined;
  const text = candidate.content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === "object"))
    .filter((part): part is { type?: unknown; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

// The CLI's stdin contract, exactly (i-have-audhd-stop.mjs:12-17): the Claude Code Stop
// shape plus last_assistant_message, which OMP payloads carry and Claude Code ones do not.
// transcript_path falls back to "" — the CLI reads it only when the message text is absent.
export function buildStopPayload(event: StopEvent, cwd: string): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: event.session_id,
    cwd,
    transcript_path: event.session_file ?? "",
    stop_hook_active: !!event.stop_hook_active,
    last_assistant_message: assistantText(event.last_assistant_message) ?? "",
  });
}

// One line in the plugin's shared state dir, appendLog-compatible (lib/state.mjs:46-53):
// ISO timestamp, whitespace collapsed, trailing newline, mkdir -p, never throws — a read-only
// home must not turn a fail-open adapter into a crashing one. Same file names as the CLI, so
// operator tooling sees one plugin, not two.
function appendLog(dir: string, file: string, text: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${new Date().toISOString()} ${text.replace(/\s+/g, " ").trim()}\n`);
  } catch {
    // lost by design; see the header's fail-open contract
  }
}

// The spawn, one shape for both hooks: sh -lc, node, payload on stdin, stdout parsed as JSON.
// A non-zero exit or unparseable stdout REJECTS instead of dissolving into undefined, because
// this adapter logs every fail-open rather than silently passing. The timeout lives here,
// next to the child it has to kill. detached puts sh and node in one fresh process group, so
// one negative-pid SIGKILL reaps them without touching the host's own group; each judge the
// core spawns leads a group of its own, which the core reaps itself (judge/ask.mjs, CLEANUP).
// The harness tag rides both children; only the stop core reads it.
function spawnHook(hook: string, payload: string, cwd: string, timeoutMs: number): Promise<CliOutput | undefined> {
  const root = process.env.I_HAVE_AUDHD_PLUGIN_ROOT ?? DEFAULT_PLUGIN_ROOT;
  const { promise, resolve, reject } = Promise.withResolvers<CliOutput | undefined>();
  const child = spawn("sh", ["-lc", `node "${root}/hooks/${hook}"`], {
    cwd,
    detached: true,
    env: { ...process.env, I_HAVE_AUDHD_HARNESS: "omp" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  let settled = false;
  const settle = (finish: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish();
  };
  const timer = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // the group already exited between the last event and this timer
    }
    settle(() => reject(new Error(`omp-adapter: CLI timed out after ${timeoutMs}ms`)));
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.on("error", (err) => settle(() => reject(err)));
  child.on("close", (code, signal) =>
    settle(() => {
      if (code !== 0) {
        const detail = stdout.trim() ? `: ${collapse(stdout)}` : " with no output";
        reject(new Error(`omp-adapter: CLI exited ${code ?? signal}${detail}`));
      } else if (!stdout.trim()) {
        resolve(undefined); // the CLI's documented quiet path: no verdict, exit 0
      } else {
        try {
          resolve(JSON.parse(stdout) as CliOutput);
        } catch (err) {
          reject(err);
        }
      }
    }),
  );
  child.stdin.on("error", () => {}); // a CLI that exits before reading stdin is not a crash
  child.stdin.end(payload);
  return promise;
}

// The whole gate. deps exists so node --test can inject a fake runCli, a temp stateDir, and a
// tight timeoutMs; the default spawn runs under node too, so the real path is tested as well.
// The session id the core and the own-block record see is the manager's (see the header's
// ONE SESSION ID); the payload's provider id stands in only when the manager id is unreadable.
export async function sessionStopHandler(
  event: StopEvent,
  ctx: Ctx,
  deps?: HandlerDeps,
): Promise<{ decision: "block"; reason: string } | undefined> {
  const stateDir = deps?.stateDir ?? join(homedir(), ".claude", ".i-have-audhd-state"); // HOME at call time, like lib/state.mjs
  const sessionId = managerSessionId(ctx) ?? event.session_id;
  const key = typeof sessionId === "string" ? sessionId : "";
  const followsOwnBlock = !!event.stop_hook_active && blockedLastStop.has(key);
  blockedLastStop.delete(key); // re-added below only if this call blocks
  try {
    const runCli: RunCli = deps?.runCli ?? ((p, cwd, ms) => spawnHook("i-have-audhd-stop.mjs", p, cwd, ms));
    const payload = buildStopPayload({ ...event, session_id: sessionId, stop_hook_active: followsOwnBlock }, ctx.cwd);
    const verdict = await runCli(payload, ctx.cwd, deps?.timeoutMs ?? CLI_TIMEOUT_MS);
    if (verdict?.decision === "block" && typeof verdict.reason === "string" && verdict.reason) {
      blockedLastStop.add(key);
      return { decision: "block", reason: verdict.reason };
    }
    return undefined; // quiet or non-block verdict: nothing to gate, nothing to log
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendLog(stateDir, "errors.log", `omp-adapter fail-open: ${detail}`);
    return undefined;
  }
}

// session_start's source: resume when OMP loaded an existing session that already holds
// messages (omp --resume / --continue), startup otherwise. Unreadable entries read as startup.
export function startSource(ctx: Ctx): StartSource {
  try {
    const entries = ctx.sessionManager?.getEntries?.();
    if (Array.isArray(entries) && entries.some((e) => e && typeof e === "object" && "type" in e && e.type === "message")) {
      return "resume";
    }
  } catch {
    // fall through: a fresh-session reading only costs the rule 8 marker
  }
  return "startup";
}

// The inject CLI's stdin contract: the Claude Code SessionStart shape, keyed by the manager id.
export function buildStartPayload(source: StartSource, ctx: Ctx): string {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: managerSessionId(ctx) ?? "",
    cwd: ctx.cwd,
    source,
  });
}

// One session-start crossing: spawn the inject hook and return its additionalContext, or
// undefined when it emitted none (I_HAVE_AUDHD_INJECT=off) or failed (one errors.log line).
// Subagent sessions are skipped before any spawn: no context, no resume marker.
export async function sessionStartHandler(
  source: StartSource,
  ctx: Ctx,
  deps?: HandlerDeps,
): Promise<string | undefined> {
  if (ctx.agent?.kind === "sub") return undefined;
  const stateDir = deps?.stateDir ?? join(homedir(), ".claude", ".i-have-audhd-state");
  try {
    const runCli: RunCli = deps?.runCli ?? ((p, cwd, ms) => spawnHook("i-have-audhd-inject.mjs", p, cwd, ms));
    const out = await runCli(buildStartPayload(source, ctx), ctx.cwd, deps?.timeoutMs ?? INJECT_TIMEOUT_MS);
    if (out === undefined) return undefined; // I_HAVE_AUDHD_INJECT=off: the CLI's quiet path
    const hso = out.hookSpecificOutput;
    const context = hso && typeof hso === "object" && "additionalContext" in hso ? hso.additionalContext : undefined;
    if (typeof context !== "string") throw new Error("omp-adapter: inject CLI output carries no additionalContext");
    return context || undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendLog(stateDir, "errors.log", `omp-adapter fail-open: ${detail}`);
    return undefined;
  }
}

// Registration entry point; package.json `omp.extensions` names this file. OMP calls it once
// per session (subagents included), so `pending` is per session. Each crossing replaces it
// with that crossing's context and a fresh delivery id (undefined when skipped, switched off,
// or failed). before_agent_start offers it as a hidden custom message — the delivery
// newdle-hooks.ts uses for its SessionStart output — on every run, re-entry included, and a
// context event carrying that delivery id clears it (see the header's DELIVERY).
export default function iHaveAudhdOmp(pi: PiLike): void {
  let pending: { content: string; delivery: string } | undefined;
  const cross = async (source: StartSource, ctx: Ctx): Promise<void> => {
    const content = await sessionStartHandler(source, ctx);
    pending = content ? { content, delivery: randomUUID() } : undefined;
  };
  pi.on("session_start", (_event, ctx) => cross(startSource(ctx), ctx));
  // A new session is a clear; resume and fork carry an existing conversation forward.
  pi.on("session_switch", (event, ctx) => cross(event?.reason === "new" ? "clear" : "resume", ctx));
  pi.on("session_compact", (_event, ctx) => cross("compact", ctx));
  pi.on("before_agent_start", () => {
    if (!pending) return undefined;
    const { content, delivery } = pending;
    return { message: { customType: CONTEXT_MESSAGE_TYPE, content, display: false, details: { delivery } } };
  });
  // Observes only: returns nothing, so the messages OMP sends are never rewritten.
  pi.on("context", (event) => {
    const messages = event?.messages;
    if (!pending || !Array.isArray(messages)) return undefined;
    const delivery = pending.delivery;
    const carried = messages.some(
      (m) =>
        !!m &&
        typeof m === "object" &&
        "customType" in m &&
        m.customType === CONTEXT_MESSAGE_TYPE &&
        "details" in m &&
        !!m.details &&
        typeof m.details === "object" &&
        "delivery" in m.details &&
        m.details.delivery === delivery,
    );
    if (carried) pending = undefined;
    return undefined;
  });
  pi.on("session_stop", (event, ctx) => sessionStopHandler(event, ctx));
}
