#!/usr/bin/env node
// intensity.mjs — ask-graham's two settings, where they live, and the CLI that sets them.
//
// intensity, how eagerly ask-graham runs:
//   ask         the default. The skill runs on /ask-graham or an explicit "should we build this?".
//   every-idea  also runs on any message proposing a new idea. The skill's description cannot do
//               that on its own, so the prompt hook (Claude Code) and the input handler (OMP) read
//               the level on every message and, only at every-idea, add NUDGE to the turn.
//
// stop-check, whether the Stop check runs:
//   on          the default. A turn that read the skill and ended without a verdict line is
//               blocked once (hooks/ask-graham-stop.mjs, and session_stop in omp/ask-graham-omp.ts).
//   off         neither host checks or blocks.
//
// Where each setting comes from, first match wins, resolved separately for each key:
//   1. the repo file   the nearest .ask-graham in the working directory or any directory above it
//   2. the user file   ${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config
//   3. the default     intensity=ask, stop-check=on
// The repo file is looked for in every ancestor, not only at the git root, so one file at a
// workspace root covers the repositories nested under it and their linked worktrees (a worktree
// has its own root and would not see an untracked file in the main checkout).
// A missing file falls through to the next one. A file with a line for the key decides it there:
// an unknown value counts as the default and does not fall through, so a typo in a file written
// to turn the level down must not turn it back up. A file with a line for the other key but none
// for this one falls through for this key. A file with a line for neither key decides both, as
// defaults marked invalid, as a file without an intensity line always has.
//
// File format, either file: `intensity=ask|every-idea` and `stop-check=on|off`, one per line. Blank
// lines, lines starting with #, and other lines are ignored; the first `key=value` line counts.
//
// CLI (the skill's `/ask-graham intensity` and `/ask-graham stop-check` run this):
//   node intensity.mjs                              print both settings and where each came from
//   node intensity.mjs every-idea|ask [--here]      set intensity, then print
//   node intensity.mjs stop-check [on|off] [--here] set stop-check (or with no value, print)
//   --here                                          write the repo file at the git root, not the user file
//   --cwd <dir>                                     resolve from <dir> instead of the working directory

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SETTINGS = Object.freeze({
  intensity: Object.freeze({ values: Object.freeze(["ask", "every-idea"]), default: "ask" }),
  "stop-check": Object.freeze({ values: Object.freeze(["on", "off"]), default: "on" }),
});
export const LEVELS = SETTINGS.intensity.values;
export const DEFAULT_LEVEL = SETTINGS.intensity.default;
export const REPO_FILE = ".ask-graham";

/** What the hook and the OMP adapter add to a turn at every-idea. Kept to one short instruction. */
export const NUDGE =
  "ask-graham (intensity every-idea): If this message proposes a new idea that doesn't exist yet (not a ticket, bug, or task in an existing project), run the ask-graham check before planning or building. Otherwise ignore this.";

/** The user file's path. XDG_CONFIG_HOME counts only when absolute, as the XDG spec says. */
export function userConfigPath(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "ask-graham", "config");
}

/** The nearest ancestor of `cwd` holding `.git`, or null outside a repository. */
export function findRepoRoot(cwd) {
  let dir;
  try { dir = realpathSync.native(cwd); } catch { return null; }
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function settingOf(key) {
  const s = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : undefined;
  if (!s) throw new Error(`unknown setting "${key}"; use ${Object.keys(SETTINGS).join(" or ")}`);
  return s;
}

const keyLine = (key) => new RegExp(`^${key}\\s*=`);

/**
 * What a file's text says about one key: the value when its first well-formed `key=value` line
 * names a valid one, null when that line names an unknown one, undefined when the file has no
 * well-formed line for the key (a malformed line is ignored, as any other unknown line is).
 */
export function parseSetting(text, key) {
  const { values } = settingOf(key);
  const pattern = new RegExp(`^${key}\\s*=\\s*(\\S+)$`);
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = pattern.exec(line);
    if (!m) continue;
    return values.includes(m[1]) ? m[1] : null;
  }
  return undefined;
}

/** The level a file's text names, or null when it names none or an unknown one. */
export function parseIntensity(text) {
  return parseSetting(text, "intensity") ?? null;
}

// One file's say on one key: undefined to fall through, else the value and whether it was invalid.
function readSetting(path, key) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; } // missing: fall through
  const value = parseSetting(text, key);
  if (typeof value === "string") return { value, invalid: false };
  if (value === undefined && Object.keys(SETTINGS).some((k) => k !== key && parseSetting(text, k) !== undefined)) {
    return undefined; // the file sets only the other key: this one falls through
  }
  return { value: settingOf(key).default, invalid: true };
}

/**
 * The effective value of one setting for a working directory.
 * @returns {{ key: string, value: string, source: "repo" | "user" | "default", path: string | null, invalid: boolean }}
 */
export function resolveSetting(key, { cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const fallback = settingOf(key).default;
  let dir = null;
  try { dir = realpathSync.native(cwd); } catch { /* unreadable cwd: only the user file counts */ }
  while (dir) {
    const path = join(dir, REPO_FILE);
    const r = readSetting(path, key);
    if (r) return { key, ...r, source: "repo", path };
    const up = dirname(dir);
    dir = up === dir ? null : up;
  }
  const path = userConfigPath(env, home);
  const r = readSetting(path, key);
  if (r) return { key, ...r, source: "user", path };
  return { key, value: fallback, source: "default", path: null, invalid: false };
}

/**
 * The effective level for a working directory.
 * @returns {{ level: string, source: "repo" | "user" | "default", path: string | null, invalid: boolean }}
 */
export function resolveIntensity(opts = {}) {
  const { value, source, path, invalid } = resolveSetting("intensity", opts);
  return { level: value, source, path, invalid };
}

/** Whether the Stop check runs for a working directory: false only when stop-check resolves to off. */
export function stopCheckEnabled(opts = {}) {
  return resolveSetting("stop-check", opts).value !== "off";
}

/**
 * Write `<key>=<value>` to the user file, or to the repo file with `here`, replacing the file's
 * line for that key and keeping every other line. Returns the path.
 */
export function writeSetting(key, value, { here = false, cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const { values } = settingOf(key);
  if (!values.includes(value)) throw new Error(`unknown ${key} "${value}"; use ${values.join(" or ")}`);
  let path;
  if (here) {
    const root = findRepoRoot(cwd);
    if (!root) throw new Error(`--here needs a git repository, and ${cwd} is not inside one`);
    path = join(root, REPO_FILE);
  } else {
    path = userConfigPath(env, home);
    mkdirSync(dirname(path), { recursive: true });
  }
  let text = "# ask-graham settings: intensity=ask|every-idea, stop-check=on|off\n";
  try { text = readFileSync(path, "utf8"); } catch { /* new file: start from the header */ }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const at = lines.findIndex((l) => keyLine(key).test(l.trim()));
  if (at === -1) lines.push(`${key}=${value}`);
  else lines[at] = `${key}=${value}`;
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** Write `intensity=<level>` to the user file, or to the repo file with `here`. Returns the path. */
export function writeIntensity(level, opts = {}) {
  return writeSetting("intensity", level, opts);
}

function from(r, value, what) {
  if (r.source === "default") return "the default; no repo or user file sets it";
  const file = `${r.source === "repo" ? "repo file" : "user file"} ${r.path}`;
  return r.invalid ? `${file}, which names no valid ${what}, so it counts as ${value}` : file;
}

/** One line naming the effective level and where it came from. */
export function describe(r) {
  return `ask-graham intensity: ${r.level} (from ${from(r, r.level, "level")})`;
}

/** One line naming the effective stop-check setting and where it came from. */
export function describeStopCheck(r) {
  return `ask-graham stop-check: ${r.value} (from ${from(r, r.value, "stop-check value")})`;
}

const USAGE = "usage: intensity.mjs [every-idea|ask] [--here] [--cwd <dir>] | intensity.mjs stop-check [on|off] [--here] [--cwd <dir>]";

export function main(argv, { env = process.env, home = homedir(), out = console.log } = {}) {
  const args = [...argv];
  let cwd = process.cwd();
  const at = args.indexOf("--cwd");
  if (at !== -1) {
    cwd = resolve(args[at + 1] ?? ".");
    args.splice(at, 2);
  }
  const here = args.includes("--here");
  let rest = args.filter((a) => a !== "--here");
  let key = "intensity";
  if (rest[0] === "stop-check") {
    key = "stop-check";
    rest = rest.slice(1);
  }
  if (rest.length > 1 || (here && rest.length === 0)) throw new Error(USAGE);
  if (rest.length === 1) {
    const path = writeSetting(key, rest[0], { here, cwd, env, home });
    out(`wrote ${key}=${rest[0]} to ${path}`);
  }
  out(describe(resolveIntensity({ cwd, env, home })));
  out(describeStopCheck(resolveSetting("stop-check", { cwd, env, home })));
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`ask-graham: ${e.message}`);
    process.exit(1);
  }
}
