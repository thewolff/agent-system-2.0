// alerts.mjs — when a failure the person must hear about is said out loud.
//
// WHY
//   A broken check that only writes a log line looks exactly like a working one. A broken check
//   that interrupts the person on every turn gets ignored. So: loud once per error key, then
//   again only after an hour while it keeps failing (saying since when), or at once after it
//   healed and broke again. Every failure is still logged every time; this decides only when
//   the person is told.
//
// WHERE THE STATE LIVES
//   The Stop hook is a fresh process per stop, so the cadence is kept on disk:
//   <state dir>/alerts.json, { "<key>": { "first": ISO, "last": ISO } } for each raised key.
//   `last` is the last time the person was told. Written whole through a temp file and a
//   rename, so a reader never sees half a file.
//
// FAILURE ERRS LOUD. An unreadable or unparseable alerts.json reads as empty (every key is
//   new, so the person hears it again) and leaves one errors.log line. A write that fails
//   leaves one errors.log line, and the alert still goes out. Never throws.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir, appendLog } from "./state.mjs";

export const REALERT_MS = 3_600_000;

export function alertsPath() {
  return join(stateDir(), "alerts.json");
}

function load(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    appendLog("errors.log", `alerts: ${path} is not a JSON object; every alert counts as new`);
  } catch (err) {
    appendLog("errors.log", `alerts: ${path} could not be read (${err.message}); every alert counts as new`);
  }
  return {};
}

function save(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch (err) {
    appendLog("errors.log", `alerts: could not record alert state at ${path} (${err.message}); the next failure alerts again`);
  }
}

// The keys of `keys` the person should hear about now, each as { key, since }: since is null
// for a new key and the ISO time it first failed for an hourly re-alert. Records them as told.
export function dueAlerts(keys, { now = Date.now(), realertMs = REALERT_MS, path = alertsPath() } = {}) {
  const state = load(path);
  const due = [];
  const at = new Date(now).toISOString();
  for (const key of new Set(keys)) {
    const seen = state[key];
    const last = seen && Date.parse(seen.last);
    if (!seen || !Number.isFinite(last)) {
      state[key] = { first: at, last: at };
      due.push({ key, since: null });
    } else if (now - last >= realertMs) {
      seen.last = at;
      due.push({ key, since: seen.first });
    }
  }
  if (due.length) save(path, state);
  return due;
}

// Forget every key starting with `prefix` except those in `keep`: those things healed, so their
// next failure is news. A key still failing (in `keep`) holds its cadence.
export function clearAlerts(prefix, { keep = [], path = alertsPath() } = {}) {
  if (!existsSync(path)) return;
  const state = load(path);
  const still = new Set(keep);
  const keys = Object.keys(state).filter((k) => k.startsWith(prefix) && !still.has(k));
  if (!keys.length) return;
  for (const k of keys) delete state[k];
  save(path, state);
}
