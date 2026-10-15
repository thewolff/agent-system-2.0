#!/usr/bin/env node
// upgrade-from-communication-rules.mjs — the one-shot, opt-in carry-over from the retired
// `communication-rules` 0.2.x names to the `i-have-audhd` 1.0.0 names: kill switch first, then
// the profile. `[--apply | --undo]`; no flag previews and writes nothing. Operator-facing
// behaviour is in the README, "Upgrading from communication-rules"; the invariants:
//
// - An original is never modified, moved or deleted. A copy is staged beside the target,
//   created exclusively at 0600, checked (mode, bytes, and for the profile the enforcement the
//   hook's own loader derives from it), then hard-linked into place, which fails rather than
//   replaces. An existing target, even a byte-identical one, is never overwritten or claimed.
// - Only a file --apply created gets a receipt, created exclusively at 0600 beside it, holding
//   its device, inode, change time, mode, size and SHA-256, never its contents. --undo removes a
//   target only when that receipt exists and every field still matches; anything else is kept.
// - Nothing private is printed: no profile contents, parse errors (they can quote the input),
//   judge command or environment value. The loader runs in a child with a throwaway $HOME, so
//   the errors.log lines it writes (which quote ignored values) never reach the real state dir.
// - Exit 0 every item done, already done, or nothing to do; 1 an item refused or failed; 2 usage.

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultProfilePath } from "../lib/config.mjs";
import { killSwitchPath } from "../lib/state.mjs";

const CONFIG_URL = new URL("../lib/config.mjs", import.meta.url).href;

// The rule ids the Stop hook passes to effectiveMode (hooks/i-have-audhd-stop.mjs). Used only
// to print each rule's effective mode; an override for any other id is counted, not named.
const RULES = [
  "needs-you-first",
  "closing-ask-last",
  "do-not-batch-by-label",
  "conclusion-first",
  "plural-back-reference",
  "restate-resumed-thread",
  "name-the-artifact",
  "report-what-you-did-not-do",
  "bad-news-first",
];

// Old variable → what replaces it. The old names are read here only to report them.
const ENV_CUTOVER = [
  ["COMMUNICATION_RULES_PROFILE", "set I_HAVE_AUDHD_PROFILE to the same path, or unset it to use ~/.claude/i-have-audhd.json"],
  ["COMMUNICATION_RULES_INJECT", "set I_HAVE_AUDHD_INJECT to the same value"],
  ["COMMUNICATION_RULES_ENFORCE", "set I_HAVE_AUDHD_ENFORCE to the same value"],
  ["COMMUNICATION_RULES_PLUGIN_ROOT", "it points at the retired plugin; unset it, or set I_HAVE_AUDHD_PLUGIN_ROOT to the i-have-audhd plugin directory"],
  ["COMMUNICATION_RULES_HARNESS", "the OMP adapter sets its own tag on the hook; unset it"],
];

const USAGE =
  "usage: node upgrade-from-communication-rules.mjs [--apply | --undo]\n" +
  "  no flag  preview: report what --apply would do; writes nothing\n" +
  "  --apply  carry the kill switch and profile to the i-have-audhd names\n" +
  "  --undo   remove only the files --apply created and that are unchanged since\n";

const claudeDir = () => join(homedir(), ".claude");
const errCode = (err) => (err && err.code) || "error";
const receiptPath = (target) => join(dirname(target), `.${basename(target).replace(/^\./, "")}.upgrade-receipt`);
const FINGERPRINT_KEYS = ["dev", "ino", "ctimeNs", "mode", "size", "sha256"];

function oldProfilePath() {
  const explicit = process.env.COMMUNICATION_RULES_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(claudeDir(), "communication-rules.json");
}

// lstat that answers "is anything at this name", dangling symlinks included.
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function readBytes(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { error: "not a regular file" };
    return { bytes: readFileSync(path) };
  } catch (err) {
    return { error: errCode(err) };
  }
}

// Creates `path` with `bytes` at exactly 0600, whatever the umask. Throws EEXIST rather than
// replace anything; removes the file again if writing it fails after it was created.
function writeExclusive(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  let written = false;
  try {
    fchmodSync(fd, 0o600);
    for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    written = true;
  } finally {
    closeSync(fd);
    if (!written) rmSync(path, { force: true });
  }
}

// Which regular file is at `path` (device, inode, change time) and what it holds (mode, size,
// SHA-256); null when it is not a regular file. The change time moves on any write, chmod or
// relink, so an edited file, or a new file that reuses the inode number, does not match.
function fingerprint(path) {
  try {
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile()) return null;
    return {
      dev: String(st.dev),
      ino: String(st.ino),
      ctimeNs: String(st.ctimeNs),
      mode: (st.mode & 0o777n).toString(8),
      size: String(st.size),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  } catch {
    return null;
  }
}

// The receipt at `path` if it is a regular file recording `target`, else null.
function readReceipt(path, target) {
  try {
    if (!lstatSync(path).isFile()) return null;
    const r = JSON.parse(readFileSync(path, "utf8"));
    return r && r.target === target && FINGERPRINT_KEYS.every((k) => typeof r[k] === "string") ? r : null;
  } catch {
    return null;
  }
}

// The profile's JSON must parse to an object before the loader sees it: the loader would
// fall back to defaults silently (and log a message quoting the file).
function profileShapeError(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return "does not parse as JSON (contents and parser message not shown)";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "is not a JSON object";
  return null;
}

// What the new loader derives from each path, computed in a child with a throwaway $HOME.
// Returns { effective: [...per path], ignored: [...per path] } or { error }.
function deriveEnforcement(paths) {
  const home = mkdtempSync(join(tmpdir(), "i-have-audhd-upgrade-"));
  const code = `
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const { loadEnforcement, effectiveMode, harnessCapsBlocks } = await import(process.env.AUDHD_UPGRADE_CONFIG);
    const rules = JSON.parse(process.env.AUDHD_UPGRADE_RULES);
    const log = join(process.env.HOME, ".claude", ".i-have-audhd-state", "errors.log");
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0);
    const out = { effective: [], ignored: [] };
    for (const path of JSON.parse(process.env.AUDHD_UPGRADE_PATHS)) {
      const before = lines();
      // The omp load reports every ignored value, armOmp included; the untagged load repeats
      // all but armOmp, so it runs after the count.
      const omp = loadEnforcement("omp", path);
      out.ignored.push(lines() - before);
      const claude = loadEnforcement(undefined, path);
      const ompCapped = harnessCapsBlocks(omp, "omp", false);
      out.effective.push({
        claude: Object.fromEntries(rules.map((r) => [r, effectiveMode(claude, r)])),
        omp: Object.fromEntries(rules.map((r) => [r, effectiveMode(omp, r) === "block" && ompCapped ? "warn" : effectiveMode(omp, r)])),
        globalMode: claude.mode,
        judge: claude.judgeCommand !== null,
        armOmp: omp.armOmp,
        otherOverrides: Object.keys(claude.rules).filter((r) => !rules.includes(r)).length,
      });
    }
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AUDHD_UPGRADE_CONFIG: CONFIG_URL,
        AUDHD_UPGRADE_RULES: JSON.stringify(RULES),
        AUDHD_UPGRADE_PATHS: JSON.stringify(paths),
      },
      timeout: 30_000,
    });
    if (run.status !== 0) return { error: `loader check exited ${run.status ?? run.signal}` };
    return JSON.parse(run.stdout);
  } catch (err) {
    return { error: `loader check failed (${errCode(err)})` };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function describeEnforcement(e, ignored) {
  const modes = (m) => RULES.map((r) => `${r}=${m[r]}`).join(" ");
  const lines = [
    `    enforcement.mode: ${e.globalMode ?? "unset (every rule warns unless overridden)"}`,
    `    Claude Code: ${modes(e.claude)}`,
    `    OMP:         ${modes(e.omp)}${e.armOmp ? " (armOmp: true)" : " (blocks capped to warn: armOmp is not true)"}`,
    `    judge command: ${e.judge ? "configured (not shown)" : "not configured; the judge-gated rules stay inactive"}`,
  ];
  if (e.otherOverrides) lines.push(`    overrides for ids the Stop hook does not check: ${e.otherOverrides}`);
  if (ignored) lines.push(`    invalid enforcement values the loader ignores: ${ignored} (the hook logs each to errors.log on every stop)`);
  return lines;
}

// The checks on the staging file, then the link. Returns { ok, lines, ino, dev }.
function checkAndLink(staged, target, bytes, verify) {
  const st = lstatSync(staged, { bigint: true });
  if (!st.isFile() || (st.mode & 0o777n) !== 0o600n) {
    return { ok: false, lines: [`refused: staged copy has mode ${(st.mode & 0o777n).toString(8)}, not 600`] };
  }
  if (!readFileSync(staged).equals(bytes)) return { ok: false, lines: ["refused: staged copy's bytes differ from the original"] };
  const checked = verify ? verify(staged) : { ok: true, lines: [] };
  if (!checked.ok) return checked;
  try {
    linkSync(staged, target);
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, lines: [`refused: ${target} appeared while staging; not overwritten`] };
    return { ok: false, lines: [`failed: could not place ${target} (${errCode(err)})`] };
  }
  return { ok: true, lines: checked.lines, ino: String(st.ino), dev: String(st.dev) };
}

// Stage → check → link → receipt. Returns { ok, lines }.
function place(source, target, bytes, verify) {
  const dir = dirname(target);
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, lines: [`refused: ${dir} is not a directory`] };
  } catch (err) {
    return { ok: false, lines: [`refused: target directory ${dir} is missing (${errCode(err)}); this tool creates no directories`] };
  }
  const staged = join(dir, `.${basename(target)}.upgrade-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeExclusive(staged, bytes);
  } catch (err) {
    return { ok: false, lines: [`failed: staging beside ${target} (${errCode(err)})`] };
  }
  let linked;
  try {
    linked = checkAndLink(staged, target, bytes, verify);
  } catch (err) {
    linked = { ok: false, lines: [`failed: checking the staged copy of ${target} (${errCode(err)})`] };
  } finally {
    // writeExclusive created this name, so it is ours. After a link the target keeps the
    // inode; removing the name first also settles the target's change time for the receipt.
    rmSync(staged, { force: true });
  }
  if (!linked.ok) return linked;

  const copied = `copied ${source} -> ${target} (${bytes.length} bytes, mode 600, contents not shown)`;
  const receipt = receiptPath(target);
  const fp = fingerprint(target);
  if (!fp || fp.ino !== linked.ino || fp.dev !== linked.dev) {
    return { ok: false, lines: [copied, `failed: ${target} changed while it was placed; no receipt written, so --undo will keep it`, ...linked.lines] };
  }
  const body = Buffer.from(JSON.stringify({ target, ...fp }, null, 2) + "\n");
  try {
    try {
      writeExclusive(receipt, body);
    } catch (err) {
      // A receipt for this target can only be left from an earlier --apply whose file has
      // since gone: the link above succeeded, so the target was absent. Anything else there
      // is not ours and is never replaced.
      if (err.code !== "EEXIST" || !readReceipt(receipt, target)) throw err;
      unlinkSync(receipt);
      writeExclusive(receipt, body);
    }
  } catch (err) {
    return { ok: false, lines: [copied, `failed: could not create the receipt ${receipt} (${errCode(err)}); --undo will keep ${target}`, ...linked.lines] };
  }
  return { ok: true, lines: [copied, `receipt: ${receipt} (0600; records which file --apply created, not its contents)`, ...linked.lines] };
}

// One carried file. `profile` adds the JSON shape check and the loader comparison.
function carry({ label, source, target, profile }, mode) {
  const out = (ok, lines) => ({ ok, lines: [`${label}:`, ...lines.map((l) => `  ${l}`)] });

  if (!present(source)) {
    return out(true, [
      `${source}: absent, nothing to carry`,
      ...(present(target) ? [`${target} already exists and is left as it is`] : []),
    ]);
  }
  if (samePath(source, target)) {
    return out(true, [`${target} is the original file itself (the new name resolves to it); nothing to copy`]);
  }
  const src = readBytes(source);
  if (src.error) return out(false, [`refused: cannot read ${source} (${src.error})`]);

  if (present(target)) {
    const tgt = readBytes(target);
    if (!tgt.error && tgt.bytes.equals(src.bytes)) {
      return out(true, [`${target} already holds the same bytes; nothing to do (no receipt written: --apply did not create it)`]);
    }
    return out(false, [`refused: ${target} already exists with different contents; not overwritten. Compare the two by hand.`]);
  }

  if (profile) {
    const shape = profileShapeError(src.bytes);
    if (shape) return out(false, [`refused: ${source} ${shape}; fix it first, then rerun`]);
  }

  if (mode === "preview") {
    const lines = [`would copy ${source} -> ${target} (${src.bytes.length} bytes, mode 600, contents not shown) and record a receipt beside it`];
    if (profile) {
      const d = deriveEnforcement([source]);
      if (d.error) return out(false, [...lines, `refused: ${d.error}`]);
      lines.push("  effective enforcement after the copy, as the i-have-audhd loader reads it:", ...describeEnforcement(d.effective[0], d.ignored[0]));
    }
    return out(true, lines);
  }

  const verify = profile
    ? (staged) => {
        const d = deriveEnforcement([source, staged]);
        if (d.error) return { ok: false, lines: [`refused: ${d.error}`] };
        if (JSON.stringify(d.effective[0]) !== JSON.stringify(d.effective[1])) {
          return { ok: false, lines: ["refused: the loader derives different enforcement from the copy than from the original"] };
        }
        return {
          ok: true,
          lines: ["  effective enforcement, verified on the copy before it was placed:", ...describeEnforcement(d.effective[1], d.ignored[1])],
        };
      }
    : null;
  const placed = place(source, target, src.bytes, verify);
  return out(placed.ok, placed.lines);
}

// Removes the target only when its receipt says --apply created it and it is unchanged since.
function undo({ label, target }) {
  const out = (ok, lines) => ({ ok, lines: [`${label}:`, ...lines.map((l) => `  ${l}`)] });
  const receipt = receiptPath(target);
  const rec = readReceipt(receipt, target);
  if (!present(target)) {
    if (rec) rmSync(receipt, { force: true });
    return out(true, [`${target}: absent, nothing to undo${rec ? `; removed its stale receipt ${receipt}` : ""}`]);
  }
  if (!rec) return out(true, [`${target} kept: no receipt at ${receipt}, so --apply did not create it`]);
  const now = fingerprint(target);
  if (!now || FINGERPRINT_KEYS.some((k) => now[k] !== rec[k])) {
    return out(true, [`${target} kept: edited or replaced since --apply created it (receipt ${receipt} left in place)`]);
  }
  try {
    unlinkSync(target);
  } catch (err) {
    return out(false, [`failed: could not remove ${target} (${errCode(err)})`]);
  }
  try {
    unlinkSync(receipt);
  } catch (err) {
    return out(false, [`removed ${target}, but not its receipt ${receipt} (${errCode(err)})`]);
  }
  return out(true, [`removed ${target} (created by --apply, unchanged since) and its receipt`]);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--apply", "--undo"].includes(args[0]))) {
    process.stderr.write(USAGE);
    return 2;
  }
  const mode = args[0] === "--apply" ? "apply" : args[0] === "--undo" ? "undo" : "preview";

  const items = [
    { label: "kill switch", source: join(claudeDir(), ".communication-rules-off"), target: killSwitchPath(), profile: false },
    { label: "profile", source: oldProfilePath(), target: defaultProfilePath(), profile: true },
  ];

  const lines = [
    {
      preview: "i-have-audhd upgrade from communication-rules: PREVIEW, nothing written (rerun with --apply to carry over)",
      apply: "i-have-audhd upgrade from communication-rules: APPLY",
      undo: "i-have-audhd upgrade from communication-rules: UNDO",
    }[mode],
  ];
  let ok = true;
  const results = mode === "undo" ? items.slice().reverse().map(undo) : items.map((item) => carry(item, mode));
  for (const r of results) {
    ok &&= r.ok;
    lines.push(...r.lines);
  }

  if (mode !== "undo") {
    const oldState = join(claudeDir(), ".communication-rules-state");
    lines.push(
      "state directory:",
      present(oldState)
        ? `  ${oldState} is kept as an archive; its logs stay readable there and its resume markers are not carried`
        : `  ${oldState}: absent`,
    );
    const set = ENV_CUTOVER.filter(([name]) => process.env[name] !== undefined);
    lines.push("environment:");
    if (!set.length) lines.push("  no COMMUNICATION_RULES_* variable is set here; nothing to change");
    for (const [name, advice] of set) lines.push(`  ${name} is set (value not shown): ${advice}`);
    if (set.length) {
      lines.push(
        "  This tool cannot change your shell's or host's environment. Edit wherever these are set",
        "  (shell profile, launcher, host settings), then relaunch the host: hooks see the env it started with.",
      );
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
  return ok ? 0 : 1;
}

process.exitCode = main();
