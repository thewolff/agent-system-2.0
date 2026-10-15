#!/usr/bin/env node
// intensity.mjs — how eagerly ask-graham runs, where that setting lives, and the CLI that sets it.
//
// Two levels:
//   ask         the default. The skill runs on /ask-graham or an explicit "should we build this?".
//   every-idea  also runs on any message proposing a new idea. The skill's description cannot do
//               that on its own, so the prompt hook (Claude Code) and the input handler (OMP) read
//               the level on every message and, only at every-idea, add NUDGE to the turn.
//
// Where the level comes from, first match wins:
//   1. the repo file   the nearest .ask-graham in the working directory or any directory above it
//   2. the user file   ${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config
//   3. the default     ask
// The repo file is looked for in every ancestor, not only at the git root, so one file at a
// workspace root covers the repositories nested under it and their linked worktrees (a worktree
// has its own root and would not see an untracked file in the main checkout).
// A missing file falls through to the next one. A file that exists but names no valid level
// resolves to ask at that point and does not fall through: a typo in a file written to turn the
// level down must not turn it back up.
//
// File format, either file: one line, `intensity=ask` or `intensity=every-idea`. Blank lines and
// lines starting with # are ignored.
//
// CLI (the skill's `/ask-graham intensity` runs this):
//   node intensity.mjs                         print the effective level and where it came from
//   node intensity.mjs every-idea|ask          write the user file, then print
//   node intensity.mjs every-idea|ask --here   write the repo file at the git root, then print
//   --cwd <dir>                                resolve from <dir> instead of the working directory

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LEVELS = Object.freeze(["ask", "every-idea"]);
export const DEFAULT_LEVEL = "ask";
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

/** The level a file's text names, or null when it names none or an unknown one. */
export function parseIntensity(text) {
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^intensity\s*=\s*(\S+)$/.exec(line);
    if (!m) continue;
    return LEVELS.includes(m[1]) ? m[1] : null;
  }
  return null;
}

function readLevel(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; } // missing: fall through
  const level = parseIntensity(text);
  return level === null ? { level: DEFAULT_LEVEL, invalid: true } : { level, invalid: false };
}

/**
 * The effective level for a working directory.
 * @returns {{ level: string, source: "repo" | "user" | "default", path: string | null, invalid: boolean }}
 */
export function resolveIntensity({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  let dir = null;
  try { dir = realpathSync.native(cwd); } catch { /* unreadable cwd: only the user file counts */ }
  while (dir) {
    const path = join(dir, REPO_FILE);
    const r = readLevel(path);
    if (r) return { ...r, source: "repo", path };
    const up = dirname(dir);
    dir = up === dir ? null : up;
  }
  const path = userConfigPath(env, home);
  const r = readLevel(path);
  if (r) return { ...r, source: "user", path };
  return { level: DEFAULT_LEVEL, source: "default", path: null, invalid: false };
}

/** Write `intensity=<level>` to the user file, or to the repo file with `here`. Returns the path. */
export function writeIntensity(level, { here = false, cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  if (!LEVELS.includes(level)) throw new Error(`unknown intensity "${level}"; use ${LEVELS.join(" or ")}`);
  let path;
  if (here) {
    const root = findRepoRoot(cwd);
    if (!root) throw new Error(`--here needs a git repository, and ${cwd} is not inside one`);
    path = join(root, REPO_FILE);
  } else {
    path = userConfigPath(env, home);
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, `# ask-graham intensity: ask or every-idea\nintensity=${level}\n`);
  return path;
}

/** One line naming the effective level and where it came from. */
export function describe(r) {
  const from =
    r.source === "default" ? "the default; no repo or user file sets it"
    : `${r.source === "repo" ? "repo file" : "user file"} ${r.path}${r.invalid ? ", which names no valid level, so it counts as ask" : ""}`;
  return `ask-graham intensity: ${r.level} (from ${from})`;
}

export function main(argv, { env = process.env, home = homedir(), out = console.log } = {}) {
  const args = [...argv];
  let cwd = process.cwd();
  const at = args.indexOf("--cwd");
  if (at !== -1) {
    cwd = resolve(args[at + 1] ?? ".");
    args.splice(at, 2);
  }
  const here = args.includes("--here");
  const rest = args.filter((a) => a !== "--here");
  if (rest.length > 1 || (here && rest.length === 0)) {
    throw new Error("usage: intensity.mjs [every-idea|ask] [--here] [--cwd <dir>]");
  }
  if (rest.length === 1) {
    const path = writeIntensity(rest[0], { here, cwd, env, home });
    out(`wrote intensity=${rest[0]} to ${path}`);
  }
  out(describe(resolveIntensity({ cwd, env, home })));
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
