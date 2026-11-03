// gate.mjs — the paired-coding gate core. Pure functions over a plain JSON state.
//
// WHAT IT DECIDES
//   Whether a tool call, a write, a command run or a pairing verb may happen, given the
//   pairing state. Every host adapter (Claude Code hooks, the OMP extension, any other host)
//   calls these functions; none of them re-implements a verdict.
//
// WHAT IT DOES NOT DO
//   No I/O. Hashing files, taking worktree snapshots, resolving symlinks, killing process
//   groups and reading the clock all arrive as injected functions on an `io` object, so the
//   tests drive every verdict with fake events. No host imports and no dependencies, so Node,
//   Bun, OMP's TypeScript extensions and other TypeScript builds can all import this one file.
//
// STATE
//   phase "inactive"  pairing not started: the gate does nothing.
//   phase "closed"    pairing active, no change set open.
//   phase "open"      a change set is open; `changeSet` names its card, boundary and quote.
//   Once a session has been activated, a missing, unreadable or malformed state reads as
//   "closed", never "inactive" (readState). That is the fail-closed rule. A closed state
//   carrying `carried` was activated by a session change (Claude Code /clear, an OMP session
//   switch) rather than by pair_start: only pair_start or a typed stop leaves it.
//
// AGREEMENT
//   The agent judges that agreement was reached and calls pair_begin with a quote of the
//   user's words. The gate binds the quote to the user's own latest turn: that turn came from
//   the host's human-input signal (recordInput, adapter machinery only), it arrived after the
//   card was shown, and it contains the quote verbatim at word boundaries. The boundary files
//   must still hash to their values when the card was proposed.
//
// ENDING
//   Only the user ends pairing, by typing a turn whose whole text is "pair stop" (trimmed,
//   any case). recordInput sees it on the trusted path and ends pairing in any phase. The
//   agent has no stop verb; an untrusted turn with the same words changes nothing.
//
// RESULTS
//   Verbs return { ok, reason?, state, journal, ...extra }. A refusal returns the input state
//   unchanged and one journal entry naming the verb and the reason. Nothing here throws on bad
//   input; an injected function that throws becomes a refusal.

/** @typedef {"inactive" | "closed" | "open"} Phase */
/** @typedef {Record<string, string>} Snapshot worktree-relative path -> fingerprint (type, hash) */
/** @typedef {{ type: string, at?: unknown, [key: string]: unknown }} JournalEntry */
/**
 * @typedef {object} Card
 * @property {string} id
 * @property {string[]} boundary  worktree-relative paths, globs (* ? **), or "dir/" subtrees
 * @property {Record<string, string>} hashes  boundary file fingerprints, and the modes of directories the boundary covers (directoryInBoundary), at proposal time; these include the directory a subtree entry names (`docs` for `docs/`), whose own mode the change set itself may not change (pair_done judges it by boundaryMatches)
 * @property {number} inputSeq  sequence number of the latest trusted input when proposed
 * @property {unknown} [at]
 * @property {string} [whyNow]
 * @property {string} [decision]
 * @property {string} [currentCode]
 * @property {string} [proposedCode]
 * @property {string} [effect]
 * @property {string[]} [checks]
 * @property {string[]} [openPoints]
 * @property {Array<{path: string, change: string}>} [changedSinceReadBack]
 */
/**
 * @typedef {object} ChangeSet
 * @property {string} cardId
 * @property {string[]} boundary
 * @property {string} quote
 * @property {number} inputSeq
 * @property {string[]} runs  every pair_run started under this change set
 * @property {unknown} [openedAt]
 */
/**
 * @typedef {object} State
 * @property {1} v
 * @property {Phase} phase
 * @property {string | null} [sessionId]
 * @property {string | null} [root]      worktree, canonical absolute path
 * @property {string | null} [stateDir]  state and journal directory, canonical absolute path
 * @property {string[]} [tempPaths]      absolute paths pair_run may write while open
 * @property {string[]} [protect]        absolute paths every pair_run profile denies
 * @property {string[]} [exclusions]     worktree-relative directories left out of snapshots
 * @property {number} [inputSeq]
 * @property {{ seq: number, text: string, at?: unknown } | null} [lastInput]
 * @property {Array<{ cardId: string, text: string }>} [midTurn]
 *   turns typed while a tool ran (Claude Code `claude:mid-turn`) since the current card was
 *   proposed, newest last, at most MID_TURN_MAX. Untrusted: used only to word a pair_begin
 *   refusal, never to bind a quote
 * @property {number} [startSeq]
 * @property {number} [cardSeq]
 * @property {Card | null} [card]
 * @property {ChangeSet | null} [changeSet]
 * @property {Array<{ runId: string, cardId: string | null }>} [running]
 * @property {Snapshot | null} [baseline]
 * @property {Array<{path: string, change: string}>} [unreviewed]
 * @property {{ reason: string, at?: unknown } | null} [halt]
 * @property {string | null} [degraded]
 * @property {{ from: string | null, reason: string, at?: unknown } | null} [carried]
 *   set when a session change activated this session closed; pair_start restarts it
 * @property {RoadmapItem[] | null} [roadmap]  the latest roadmap pair_note recorded
 * @property {{ from: string, roadmap: RoadmapItem[] } | null} [roadmapOffer]
 *   an earlier session's roadmap pair_start offered, until pair_note's earlierRoadmap picks it
 *   up or starts fresh, or a new roadmap supersedes it
 */
/**
 * @typedef {object} RoadmapItem
 * @property {string} id
 * @property {string} title
 * @property {"open" | "done" | "skipped" | "dropped" | "not-ready"} status
 * @property {string} [note]  required, one line, for "not-ready"
 */
/**
 * @typedef {object} Io
 * @property {() => unknown} [now]
 * @property {(boundary: string[], root: string) => Record<string, string>} [hashBoundary]
 * @property {() => Snapshot} [snapshot]
 * @property {(absPath: string) => string} [realpath]
 * @property {(runIds: string[]) => void} [reapRuns]
 */
/** @typedef {{ ok: boolean, reason?: string, state: State, journal: JournalEntry[], [key: string]: unknown }} Result */

/** The pairing verbs the adapter registers as model-callable tools. There is no stop verb. */
export const PAIR_TOOLS = Object.freeze([
  "pair_start",
  "pair_note",
  "pair_propose",
  "pair_begin",
  "pair_done",
  "pair_write",
  "pair_edit",
  "pair_run",
]);

/** What the user types, as a whole turn, to end pairing. */
export const STOP_PHRASE = "pair stop";

/** Whether a turn's whole text, trimmed and case-insensitive, is the stop phrase. */
export function isStopPhrase(text) {
  return typeof text === "string" && text.trim().toLowerCase() === STOP_PHRASE;
}

/** Roadmap item statuses. "open" and "not-ready" count as still to do. */
export const ROADMAP_STATUSES = Object.freeze(["open", "done", "skipped", "dropped", "not-ready"]);

/** Read-only host tools, OMP and Claude Code spellings. Allowed while pairing. */
export const READ_ONLY_TOOLS = Object.freeze([
  "read", "grep", "glob", "find", "web_search",
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch",
]);

/** Host tools that write files or run code. Refused while pairing, in closed and open. */
export const HOST_MUTATING_TOOLS = Object.freeze([
  "write", "edit", "ast_edit", "bash", "eval", "python", "notebook",
  "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash",
]);

/** Sub-agent dispatch tools. Refused while pairing in v1: a child session starts inactive. */
export const DISPATCH_TOOLS = Object.freeze(["task", "Task", "Agent"]);

const PAIR_SET = new Set(PAIR_TOOLS);
const READ_SET = new Set(READ_ONLY_TOOLS);
const MUTATING_SET = new Set(HOST_MUTATING_TOOLS);
const DISPATCH_SET = new Set(DISPATCH_TOOLS);
const PHASES = new Set(["inactive", "closed", "open"]);
const STATUS_SET = new Set(ROADMAP_STATUSES);
const CONTROL = /[\u0000-\u001f\u007f]/;
/** How every host text names a session a session change carried over closed. */
export const CARRIED_PHRASE = "pairing is still on and the card is closed";
export const CARRIED_REASON = `${CARRIED_PHRASE} after a session change. Tell your partner pairing carried over closed and wait for their answer: call pair_start only once they say to keep pairing; they end it by typing pair stop`;

// ─── state ──────────────────────────────────────────────────────────────────────────────

/** @returns {State} */
export function inactiveState() {
  return { v: 1, phase: "inactive" };
}

/**
 * Parse a persisted state. Fail closed: a present file that does not parse or validate, or a
 * missing file in a session the adapter knows it activated, reads as "closed" with no card,
 * no trusted input and no change set, marked `degraded`. Only a missing file in a session that
 * was never activated reads as "inactive". In an activated session an inactive state counts
 * only when the adapter's marker says pairing ended (`ended`), which only the gate writes, when
 * it saves the inactive state itself; any other inactive state reads as closed.
 * @param {string | null | undefined} text
 * @param {{ activated?: boolean, ended?: boolean, sessionId?: string, root?: string, stateDir?: string }} [opts]
 * @returns {State}
 */
export function readState(text, opts = {}) {
  if (text === null || text === undefined) {
    return opts.activated ? degradedState("state file missing", opts) : inactiveState();
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return degradedState("state file unreadable", opts);
  }
  if (!isValidState(parsed)) return degradedState("state file malformed", opts);
  if (parsed.phase === "inactive" && opts.activated && !opts.ended) return degradedState("the state reads inactive, but pairing never ended in this session", opts);
  return parsed;
}

/** @param {State} state */
export function serializeState(state) {
  return JSON.stringify(state);
}

function degradedState(reason, opts) {
  const root = typeof opts.root === "string" && opts.root.startsWith("/") ? opts.root : null;
  const stateDir = typeof opts.stateDir === "string" && opts.stateDir.startsWith("/") ? opts.stateDir : null;
  return {
    v: 1,
    phase: "closed",
    sessionId: typeof opts.sessionId === "string" ? opts.sessionId : null,
    root,
    stateDir,
    tempPaths: [],
    protect: [],
    exclusions: [],
    inputSeq: 0,
    lastInput: null,
    midTurn: [],
    startSeq: 0,
    cardSeq: 0,
    card: null,
    changeSet: null,
    running: [],
    baseline: null,
    unreviewed: [],
    halt: null,
    degraded: reason,
  };
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStrArr = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
const isAbs = (x) => typeof x === "string" && x.startsWith("/") && !CONTROL.test(x);
const isSeq = (x) => Number.isInteger(x) && x >= 0;

function isValidState(s) {
  if (!isObj(s) || s.v !== 1 || !PHASES.has(s.phase)) return false;
  if (s.phase === "inactive") return true;
  if (!isAbs(s.root) || !isAbs(s.stateDir)) return false;
  if (!isStrArr(s.tempPaths) || !s.tempPaths.every(isAbs)) return false;
  if (!isStrArr(s.protect) || !s.protect.every(isAbs)) return false;
  if (!isStrArr(s.exclusions)) return false;
  if (!isSeq(s.inputSeq) || !isSeq(s.startSeq) || !isSeq(s.cardSeq)) return false;
  if (s.lastInput !== null && !(isObj(s.lastInput) && isSeq(s.lastInput.seq) && typeof s.lastInput.text === "string")) return false;
  if (s.midTurn !== undefined && !isMidTurn(s.midTurn)) return false;
  if (s.card !== null && !isValidCard(s.card)) return false;
  if (!Array.isArray(s.running) || !s.running.every((r) => isObj(r) && typeof r.runId === "string")) return false;
  if (s.baseline !== null && !isSnapshot(s.baseline)) return false;
  if (!Array.isArray(s.unreviewed)) return false;
  if (s.halt !== null && !(isObj(s.halt) && typeof s.halt.reason === "string")) return false;
  if (s.carried !== undefined && s.carried !== null) {
    if (!isObj(s.carried) || typeof s.carried.reason !== "string" || s.phase !== "closed" || s.card !== null) return false;
  }
  if (s.roadmap !== undefined && s.roadmap !== null && roadmapProblem(s.roadmap) !== null) return false;
  if (s.roadmapOffer !== undefined && s.roadmapOffer !== null && !isRoadmapOffer(s.roadmapOffer)) return false;
  if (s.phase === "open") {
    const c = s.changeSet;
    if (!isObj(c) || typeof c.cardId !== "string" || typeof c.quote !== "string" || !isSeq(c.inputSeq)) return false;
    if (!isStrArr(c.boundary) || c.boundary.length === 0 || boundaryProblem(c.boundary) !== null) return false;
    if (!isStrArr(c.runs)) return false;
  } else if (s.changeSet !== null) {
    return false;
  }
  return true;
}

function isValidCard(c) {
  return (
    isObj(c) &&
    typeof c.id === "string" &&
    isStrArr(c.boundary) &&
    c.boundary.length > 0 &&
    boundaryProblem(c.boundary) === null &&
    isObj(c.hashes) &&
    isSeq(c.inputSeq)
  );
}

function isSnapshot(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}

// ─── results ────────────────────────────────────────────────────────────────────────────

function stamp(io) {
  return io && typeof io.now === "function" ? io.now() : undefined;
}

function entry(type, io, fields = {}) {
  const at = stamp(io);
  return at === undefined ? { type, ...fields } : { type, at, ...fields };
}

/** @returns {Result} */
function refuse(state, verb, reason, io) {
  return { ok: false, reason, state, journal: [entry("refusal", io, { verb, reason })] };
}

const clone = (state) => JSON.parse(JSON.stringify(state));

function callIo(io, name, ...args) {
  if (!io || typeof io[name] !== "function") return { error: `the adapter supplied no ${name}` };
  try {
    return { value: io[name](...args) };
  } catch (err) {
    return { error: `${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── paths and boundaries ───────────────────────────────────────────────────────────────

/**
 * Lexically resolve `p` against `root`: absolute paths stay, relative ones join the root,
 * "." and ".." segments collapse. No filesystem access; symlinks are the adapter's realpath.
 * @param {string} root
 * @param {unknown} p
 * @returns {string | null} absolute path, or null for an unusable input
 */
export function resolvePath(root, p) {
  if (typeof p !== "string" || p.length === 0 || CONTROL.test(p)) return null;
  const joined = p.startsWith("/") ? p : `${root}/${p}`;
  const out = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

function within(dir, abs) {
  return abs === dir || abs.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/** The worktree-relative form of `abs`, or null when `abs` is the root itself or outside it. */
function relativeTo(root, abs) {
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
}

const REGEX_META = /[.^$*+?()[\]{}|\\]/g;

/**
 * Regex source (no anchors) for one boundary entry, in syntax shared by JavaScript and
 * Seatbelt's regex filter: `*` is any run inside one path segment, `?` one character inside a
 * segment, `**` any number of whole segments. Brackets and braces are literal characters.
 * @param {string} entry
 */
export function globToRegexSource(entry) {
  const segs = entry.split("/");
  let out = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      out += last ? ".+" : "([^/]+/)*";
      return;
    }
    out += seg.replace(REGEX_META, (ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : `\\${ch}`));
    if (!last) out += "/";
  });
  return out;
}

/** A trailing "/" means the whole subtree; an entry with * or ? is a glob; else one file. */
function normalizeEntry(entry) {
  return entry.endsWith("/") ? `${entry}**` : entry;
}

function isGlob(entry) {
  return /[*?]/.test(entry);
}

/**
 * Why a boundary is unusable, or null. Entries are worktree-relative, have no "." or ".."
 * segments, no empty segments, no control characters and no double quotes.
 * @param {unknown} boundary
 * @returns {string | null}
 */
export function boundaryProblem(boundary) {
  if (!Array.isArray(boundary) || boundary.length === 0) return "the card names no boundary";
  for (const raw of boundary) {
    if (typeof raw !== "string" || raw.length === 0) return "a boundary entry is empty";
    if (CONTROL.test(raw) || raw.includes('"')) return `boundary entry ${JSON.stringify(raw)} holds a control character or a double quote`;
    if (raw.startsWith("/")) return `boundary entry ${JSON.stringify(raw)} is absolute; boundary entries are worktree-relative`;
    const segs = normalizeEntry(raw).split("/");
    if (segs.some((s) => s === "" || s === "." || s === "..")) return `boundary entry ${JSON.stringify(raw)} has an empty, "." or ".." segment`;
  }
  return null;
}

/** Compiled, anchored regexes for glob entries or segments, so a check over a large tree compiles each once. */
const GLOB_REGEX = new Map();
function globRegex(glob) {
  let re = GLOB_REGEX.get(glob);
  if (!re) GLOB_REGEX.set(glob, (re = new RegExp(`^${globToRegexSource(glob)}$`)));
  return re;
}

/**
 * Whether a worktree-relative path lies inside the boundary. The worktree root itself, which a
 * snapshot names ".", never does: no run may write it and no boundary entry can name it, so a
 * change to its mode is always unapproved, also under `**`.
 * @param {string[]} boundary
 * @param {string} rel
 */
export function boundaryMatches(boundary, rel) {
  if (typeof rel !== "string" || rel === "" || rel === ".") return false;
  return boundary.some((raw) => {
    const e = normalizeEntry(raw);
    return isGlob(e) ? globRegex(e).test(rel) : rel === e;
  });
}

/**
 * Whether a card's hashes hold a directory's mode: the directory matches a glob entry, or an
 * entry names its whole subtree (`docs/`, `docs/**`). A literal entry names one file, so it
 * never holds a directory's mode. Never the root.
 * @param {string[]} boundary
 * @param {string} rel
 */
export function directoryInBoundary(boundary, rel) {
  if (typeof rel !== "string" || rel === "" || rel === ".") return false;
  return boundary.some((raw) => {
    const e = normalizeEntry(raw);
    if (!isGlob(e)) return false;
    return globRegex(e).test(rel) || (e.endsWith("/**") && boundaryMatches([e.slice(0, -3)], rel));
  });
}

/**
 * A regex source that matches its letters in either case, in syntax shared by JavaScript and
 * Seatbelt: every ASCII letter becomes a two-letter class. Worktrees usually sit on a
 * case-insensitive volume, where `.GIT/CONFIG` is `.git/config`. Only for sources whose
 * letters are all literal (no escapes such as \d, no classes).
 */
function anyCase(source) {
  return source.replace(/[A-Za-z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
}

/**
 * The git fence, as worktree-relative regex sources in syntax shared by JavaScript and
 * Seatbelt, any letter case. Under a `.git` directory (the worktree's, a nested repository's,
 * or a submodule's under modules/) a write is allowed only to what `git add` and `git commit`
 * write: GIT_WRITABLE. Everything else there is git's own control data, which git reads or
 * runs outside the sandbox later (config, hooks, the todo list of an interrupted rebase), and
 * snapshots leave .git out, so a write there would never show in a read-back. Every such write
 * is refused, even when an agreed boundary covers `.git/`; GIT_WRITABLE is only ever left
 * undenied, never granted, so the boundary still decides whether it is writable at all.
 *
 * GIT_PATHS: every path at or under a `.git` entry, the entry itself included (so no gitfile
 * or symlink can be planted or swapped).
 * GIT_WRITABLE: objects/, refs/, logs/, index, HEAD, ORIG_HEAD, COMMIT_EDITMSG, packed-refs
 * and AUTO_MERGE, and their lock files, directly in a git directory. `git commit` takes
 * AUTO_MERGE.lock even with no merge in progress (seen with git 2.50), and prints an error
 * without it.
 * GIT_CONTROL: refused even where GIT_WRITABLE matches. A submodule's name may hold a slash,
 * so `.git/modules/a/logs/config` is either a file in submodule a's logs/ or the config of a
 * submodule named a/logs; these paths are refused under every such reading, and every `.git`
 * entry is refused wherever it sits.
 */
export const GIT_PATHS = anyCase(String.raw`(.*/)?\.git(/.*)?`);
export const GIT_WRITABLE = anyCase(
  String.raw`(.*/)?\.git/(modules/.+/)?((objects|refs|logs)(/.*)?|index|index\.lock|HEAD|HEAD\.lock|ORIG_HEAD|COMMIT_EDITMSG|packed-refs|packed-refs\.lock|AUTO_MERGE|AUTO_MERGE\.lock)`,
);
export const GIT_CONTROL = Object.freeze([
  String.raw`(.*/)?\.git`,
  String.raw`(.*/)?\.git/(modules/(.+/)?)?(hooks|info|worktrees|rebase-merge|rebase-apply|sequencer)(/.*)?`,
  String.raw`(.*/)?\.git/(modules/(.+/)?)?(config|config\.worktree|config\.lock|commondir)`,
].map(anyCase));
const GIT_PATHS_RE = new RegExp(`^${GIT_PATHS}$`);
const GIT_WRITABLE_RE = new RegExp(`^${GIT_WRITABLE}$`);
const GIT_CONTROL_RES = GIT_CONTROL.map((source) => new RegExp(`^${source}$`));

/** Whether a worktree-relative path is under `.git` and not something a commit writes. */
export function isGitControl(rel) {
  if (typeof rel !== "string") return false;
  if (GIT_CONTROL_RES.some((re) => re.test(rel))) return true;
  return GIT_PATHS_RE.test(rel) && !GIT_WRITABLE_RE.test(rel);
}

// ─── snapshots ──────────────────────────────────────────────────────────────────────────

/**
 * Paths whose fingerprint differs between two snapshots, sorted. Paths under `exclusions`
 * (worktree-relative directories) are ignored. A directory's entry (`dir:<mode>`) counts only
 * when the directory is in both snapshots and its mode changed: a directory created or removed
 * shows through its files, and an empty one not at all.
 * @param {Snapshot} before
 * @param {Snapshot} after
 * @param {string[]} [exclusions]
 * @returns {Array<{ path: string, change: "added" | "removed" | "modified" }>}
 */
export function diffSnapshots(before, after, exclusions = []) {
  const excluded = (p) => exclusions.some((d) => p === d || p.startsWith(d.endsWith("/") ? d : `${d}/`));
  const isDir = (fp) => fp !== undefined && fp.startsWith("dir:");
  const out = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (excluded(path)) continue;
    let a = Object.hasOwn(before, path) ? before[path] : undefined;
    let b = Object.hasOwn(after, path) ? after[path] : undefined;
    if (isDir(a) !== isDir(b)) {
      if (isDir(a)) a = undefined;
      else b = undefined;
    }
    if (a === b) continue;
    out.push({ path, change: a === undefined ? "added" : b === undefined ? "removed" : "modified" });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/**
 * The part of a snapshot a boundary covers: its files (boundaryMatches), the modes of the
 * directories it covers (directoryInBoundary), and "absent" for a literal entry the snapshot
 * does not hold, so creating it changes the hash. The host's hashBoundary takes a fresh
 * snapshot and reduces it with this; pair_done reduces the snapshot it already took.
 * @param {string[]} boundary
 * @param {Snapshot} snap
 * @returns {Record<string, string>}
 */
export function boundaryHashes(boundary, snap) {
  const out = {};
  for (const [rel, fp] of Object.entries(snap)) {
    if (fp.startsWith("dir:") ? directoryInBoundary(boundary, rel) : boundaryMatches(boundary, rel)) out[rel] = fp;
  }
  for (const e of boundary) {
    const literal = !/[*?]/.test(e) && !e.endsWith("/");
    if (literal && !Object.hasOwn(out, e)) out[e] = "absent";
  }
  return out;
}

function takeSnapshot(io) {
  const r = callIo(io, "snapshot");
  if (r.error) return r;
  if (!isSnapshot(r.value)) return { error: "snapshot returned a malformed snapshot" };
  return r;
}

/**
 * Snapshots before 1.2 recorded only a file's executable bit (`file:x:<hash>`, `file:-:<hash>`)
 * and no directories, so a session whose baseline or card was taken by that plugin cannot show
 * a permission change since: it is refused until the partner types pair stop and pairing starts
 * again. A 1.2 baseline always holds the root's entry "."; card hashes never do, so they are
 * judged by their file entries alone.
 */
const OLD_FILE = /^file:[x-]:[0-9a-f]{64}$/;
const OLDER_PLUGIN = "this session was started by an older paired-coding, whose snapshots do not record permission bits, so its changes cannot be checked; ask your partner to type pair stop, then start pairing again";
const olderSnapshot = (snap) => isObj(snap) && Object.values(snap).some((fp) => typeof fp === "string" && OLD_FILE.test(fp));
const olderBaseline = (snap) => isObj(snap) && (!Object.hasOwn(snap, ".") || olderSnapshot(snap));

/**
 * Whether a card's hashes still hold, on the snapshot comparison's terms: a directory's mode
 * counts only when the directory is there both times, so making or removing one does not
 * make the card stale; its files do.
 */
function sameHashes(a, b) {
  return isObj(a) && isObj(b) && diffSnapshots(a, b).length === 0;
}

// ─── trusted input ──────────────────────────────────────────────────────────────────────

/**
 * Record one human turn. ADAPTER MACHINERY ONLY: call it from the host's human-input signal
 * (OMP `input` event; Claude Code `UserPromptSubmit`, judged from the transcript), never from a
 * model-callable tool. Only `source: "interactive"` enters the trusted store; any other source
 * is journaled as untrusted and changes nothing. A trusted turn whose whole text is the stop
 * phrase ends pairing in any phase, like sessionEnd with verb "typed-stop": every run is
 * reaped, the final snapshot is judged, and the state goes inactive.
 * @param {State} state
 * @param {{ text: unknown, source: unknown }} event
 * @param {Io} [io]
 * @returns {Result}
 */
export function recordInput(state, event, io) {
  if (state.phase === "inactive") return { ok: true, state, journal: [] };
  const text = typeof event?.text === "string" ? event.text : "";
  if (event?.source !== "interactive") {
    const journal = [entry("untrusted-input", io, { source: String(event?.source), text })];
    if (event?.source !== MID_TURN_SOURCE || state.phase !== "closed" || !state.card) return { ok: true, trusted: false, state, journal };
    // Remembered only to tell the agent why a quote of it is refused; it never binds.
    const next = clone(state);
    const kept = (next.midTurn ?? []).filter((m) => m.cardId === state.card.id);
    next.midTurn = [...kept, { cardId: state.card.id, text }].slice(-MID_TURN_MAX);
    return { ok: true, trusted: false, state: next, journal };
  }
  const next = clone(state);
  next.inputSeq += 1;
  next.lastInput = { seq: next.inputSeq, text, at: stamp(io) };
  const recorded = entry("input", io, { seq: next.inputSeq, text });
  if (!isStopPhrase(text)) return { ok: true, trusted: true, state: next, journal: [recorded] };
  const r = endPairing(next, io, "typed-stop");
  return { ...r, trusted: true, stopped: true, journal: [recorded, ...r.journal] };
}

const WORD_START = /^[\p{L}\p{N}]/u;
const WORD_END = /[\p{L}\p{N}]$/u;

/**
 * Whether `quote` occurs in `text` without splitting a word: where the quote begins with a
 * letter or digit, the character before it is not one; where it ends with one, the character
 * after it is not one. Letters and digits are Unicode's (\p{L}, \p{N}).
 * @param {string} text
 * @param {string} quote
 */
export function occursAtWordBoundaries(text, quote) {
  if (typeof text !== "string" || typeof quote !== "string" || quote === "") return false;
  const head = WORD_START.test(quote);
  const tail = WORD_END.test(quote);
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    if (head && WORD_END.test(text.slice(0, i))) continue;
    if (tail && WORD_START.test(text.slice(i + quote.length))) continue;
    return true;
  }
  return false;
}

/** The source Claude Code's adapter gives a turn typed while a tool was running. */
export const MID_TURN_SOURCE = "claude:mid-turn";
const MID_TURN_MAX = 8;

/** The pair_begin refusal when the quote is from a turn typed while a tool ran. */
export const MID_TURN_REASON = "your partner's words arrived while a tool was running, so they don't count as agreement; ask them to say it again";

function isMidTurn(x) {
  return Array.isArray(x) && x.length <= MID_TURN_MAX && x.every((m) => isObj(m) && typeof m.cardId === "string" && typeof m.text === "string");
}

/** Why a quote does not bind to the user's latest turn after `anchorSeq`, or null. */
function quoteProblem(state, anchorSeq, quote) {
  if (typeof quote !== "string" || quote.trim() === "") return "the quote of your partner's words is empty";
  if (!/[\p{L}\p{N}]/u.test(quote)) return "the quote has no letter or digit; quote your partner's words";
  const last = state.lastInput;
  const fresh = last && last.seq > anchorSeq;
  if (fresh && occursAtWordBoundaries(last.text, quote)) return null;
  // The quote is refused either way; a turn typed during a tool call only changes the wording,
  // and only for that source, so no other untrusted text is confirmed back to the agent.
  if ((state.midTurn ?? []).some((m) => m.cardId === state.card?.id && occursAtWordBoundaries(m.text, quote))) return MID_TURN_REASON;
  if (!fresh) return "your partner has not typed a turn since the card was shown";
  return "the quote does not occur verbatim, as whole words, in your partner's latest turn";
}

// ─── verbs ──────────────────────────────────────────────────────────────────────────────

/** The checked, canonical paths of a new closed state, or { error }. */
function sessionPaths(args, io) {
  const canon = (p) => {
    if (!isAbs(p)) return null;
    if (typeof io?.realpath !== "function") return p;
    const r = callIo(io, "realpath", p);
    return r.error || !isAbs(r.value) ? null : r.value;
  };
  const root = canon(args?.root);
  const stateDir = canon(args?.stateDir);
  if (!root) return { error: "the worktree root is not a usable absolute path" };
  if (!stateDir) return { error: "the state directory is not a usable absolute path" };
  if (root === "/" || within(stateDir, root)) return { error: "the worktree lies inside the state directory" };
  const tempPaths = args.tempPaths ?? [];
  const protect = args.protect ?? [];
  const exclusions = args.exclusions ?? [];
  if (!isStrArr(tempPaths) || !tempPaths.every(isAbs)) return { error: "a temp path is not absolute" };
  if (!isStrArr(protect) || !protect.every(isAbs)) return { error: "a protected path is not absolute" };
  if (!isStrArr(exclusions) || exclusions.some((e) => boundaryProblem([e]) !== null)) {
    return { error: "a snapshot exclusion is not a clean worktree-relative path" };
  }
  return { root, stateDir, tempPaths, protect, exclusions };
}

/** A closed state with no card, no input and no change set. */
function closedState(sessionId, paths, baseline) {
  return {
    v: 1,
    phase: "closed",
    sessionId: typeof sessionId === "string" ? sessionId : null,
    ...paths,
    inputSeq: 0,
    lastInput: null,
    midTurn: [],
    startSeq: 0,
    cardSeq: 0,
    card: null,
    changeSet: null,
    running: [],
    baseline,
    unreviewed: [],
    halt: null,
    degraded: null,
    carried: null,
    roadmap: null,
    roadmapOffer: null,
  };
}

/**
 * pair_start: activate pairing (inactive -> closed) and take the first snapshot. Agent-callable
 * with no binding, because it only adds restrictions. The adapter supplies the paths, and the
 * earlier roadmap to offer when it found one. It also restarts a session that a session change
 * left carried and closed.
 * @param {State} state
 * @param {{ sessionId?: string, root: string, stateDir: string, tempPaths?: string[], protect?: string[], exclusions?: string[], roadmapOffer?: { from: string, roadmap: RoadmapItem[] }, cardSeq?: number }} args
 * @param {Io} io
 * @returns {Result}
 */
export function pairStart(state, args, io) {
  const restart = state.phase === "closed" && isObj(state.carried);
  if (state.phase !== "inactive" && !restart) return refuse(state, "pair_start", "pairing is already active", io);
  const paths = sessionPaths(args, io);
  if (paths.error) return refuse(state, "pair_start", paths.error, io);
  const snap = takeSnapshot(io);
  if (snap.error) return refuse(state, "pair_start", `could not snapshot the worktree: ${snap.error}`, io);
  const next = closedState(args.sessionId, paths, snap.value);
  // Card ids stay unique in the session's journal: an OMP /clear or a stop and restart keeps
  // the same journal, so numbering continues from the highest card id it already holds.
  if (isSeq(args.cardSeq)) next.cardSeq = args.cardSeq;
  const fields = { sessionId: next.sessionId, root: next.root, stateDir: next.stateDir, exclusions: next.exclusions };
  if (restart) fields.restartedAfter = state.carried.reason;
  const journal = [entry("start", io, fields)];
  if (isRoadmapOffer(args.roadmapOffer)) {
    next.roadmapOffer = { from: args.roadmapOffer.from, roadmap: args.roadmapOffer.roadmap.map(roadmapItem) };
    journal.push(entry("roadmap-offered", io, next.roadmapOffer));
  }
  return { ok: true, state: next, journal };
}

/**
 * Activate a session closed because pairing was active in the session it replaced (Claude Code
 * /clear; an OMP session switch). ADAPTER MACHINERY ONLY. The new session has no card, no
 * change set, no trusted input and no baseline: host writes are refused until pair_start
 * restarts pairing, and a typed stop ends it. Refused on a session that is already pairing.
 * @param {State} state
 * @param {{ sessionId?: string, root: string, stateDir: string, tempPaths?: string[], protect?: string[], exclusions?: string[], from?: string | null, reason?: string }} args
 * @param {Io} [io]
 * @returns {Result}
 */
export function carryClosed(state, args, io) {
  if (state.phase !== "inactive") return refuse(state, "carry", "this session is already pairing", io);
  const paths = sessionPaths(args, io);
  if (paths.error) return refuse(state, "carry", paths.error, io);
  const next = closedState(args.sessionId, paths, null);
  const reason = typeof args.reason === "string" && args.reason !== "" ? args.reason : "clear";
  const from = typeof args.from === "string" ? args.from : null;
  next.carried = { from, reason, at: stamp(io) };
  return { ok: true, state: next, journal: [entry("carried-after-clear", io, { from, reason, root: next.root })] };
}

/**
 * Session end, ADAPTER MACHINERY ONLY (host shutdown or session change), never a
 * model-callable tool. Reaps every run, takes the final snapshot and judges it, then goes
 * inactive.
 * @param {State} state
 * @param {Io} io
 * @returns {Result}
 */
export function sessionEnd(state, io) {
  if (state.phase === "inactive") return { ok: true, state, journal: [] };
  return endPairing(state, io, "session-end");
}

function endPairing(state, io, verb) {
  const runIds = [...new Set([...(state.changeSet?.runs ?? []), ...state.running.map((r) => r.runId)])];
  const journal = [];
  if (runIds.length > 0) {
    const reaped = callIo(io, "reapRuns", runIds);
    if (reaped.error) journal.push(entry("reap-failed", io, { runIds, reason: reaped.error }));
  }
  const r = finish({ ...state, running: [] }, io, verb, {});
  return { ...r, journal: [...journal, ...r.journal] };
}

function finish(state, io, verb, fields) {
  const journal = [];
  let changedSinceReadBack = [];
  let unapproved = [];
  if (olderBaseline(state.baseline)) {
    // Compared with this plugin's snapshot, every file of an older baseline would show as changed.
    journal.push(entry("snapshot-incomparable", io, { verb, reason: "the baseline was taken by an older paired-coding, so the final snapshot is not compared with it" }));
  } else {
    const snap = takeSnapshot(io);
    if (snap.error) {
      journal.push(entry("snapshot-failed", io, { verb, reason: snap.error }));
    } else if (state.baseline) {
      const diff = diffSnapshots(state.baseline, snap.value, state.exclusions);
      if (state.phase === "open") {
        unapproved = diff.filter((d) => !boundaryMatches(state.changeSet.boundary, d.path));
        changedSinceReadBack = diff.filter((d) => boundaryMatches(state.changeSet.boundary, d.path));
        if (unapproved.length) journal.push(entry("unapproved-write", io, { cardId: state.changeSet.cardId, paths: unapproved }));
      } else {
        changedSinceReadBack = diff;
      }
      if (changedSinceReadBack.length) journal.push(entry("between-change-sets", io, { changes: changedSinceReadBack }));
    }
  }
  journal.push(entry("stop", io, { verb, ...fields }));
  return { ok: true, state: inactiveState(), journal, changedSinceReadBack: [...state.unreviewed, ...changedSinceReadBack], unapproved };
}

/**
 * Why a roadmap is unusable, or null. A roadmap is a list of items { id, title, status, note? }
 * with unique non-empty ids and titles; status is one of ROADMAP_STATUSES; a "not-ready" item
 * carries a one-line note saying what it waits for.
 * @param {unknown} items
 * @returns {string | null}
 */
export function roadmapProblem(items) {
  if (!Array.isArray(items)) return "the roadmap is not a list of items";
  const ids = new Set();
  for (const [i, it] of items.entries()) {
    if (!isObj(it)) return `roadmap item ${i + 1} is not an object`;
    if (typeof it.id !== "string" || it.id.trim() === "") return `roadmap item ${i + 1} has no id`;
    if (ids.has(it.id)) return `roadmap item id ${JSON.stringify(it.id)} appears twice`;
    ids.add(it.id);
    if (typeof it.title !== "string" || it.title.trim() === "") return `roadmap item ${it.id} has no title`;
    if (!STATUS_SET.has(it.status)) return `roadmap item ${it.id} has status ${JSON.stringify(it.status)}; use one of ${ROADMAP_STATUSES.join(", ")}`;
    if (it.note !== undefined && typeof it.note !== "string") return `roadmap item ${it.id} has a note that is not text`;
    if (it.status === "not-ready" && (typeof it.note !== "string" || it.note.trim() === "" || /[\r\n]/.test(it.note))) {
      return `roadmap item ${it.id} is not-ready and needs a one-line note saying what it waits for`;
    }
  }
  return null;
}

/** The items still to do: status "open" or "not-ready". */
export function openRoadmapItems(items) {
  return Array.isArray(items) ? items.filter((it) => it.status === "open" || it.status === "not-ready") : [];
}

/** A checked roadmap item, copied without any extra fields. */
function roadmapItem(it) {
  return { id: it.id, title: it.title, status: it.status, ...(it.note !== undefined ? { note: it.note } : {}) };
}

/** An offer pair_start can record: a valid earlier roadmap with something still to do. */
function isRoadmapOffer(x) {
  return isObj(x) && typeof x.from === "string" && x.from !== "" && roadmapProblem(x.roadmap) === null && openRoadmapItems(x.roadmap).length > 0;
}

/**
 * The newest roadmap decision a journal recorded, or null when it recorded none: `{ roadmap }`
 * for a note carrying a valid roadmap (a picked-up one included), `{ declined: true }` for a
 * partner's start-fresh. The pair_start offer stops at the first earlier journal with either.
 * @param {unknown} entries
 * @returns {{ roadmap: RoadmapItem[] } | { declined: true } | null}
 */
export function roadmapRecord(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!isObj(e)) continue;
    if (e.type === "roadmap-declined") return { declined: true };
    if (e.type === "note" && Array.isArray(e.roadmap) && roadmapProblem(e.roadmap) === null) return { roadmap: e.roadmap };
  }
  return null;
}

/**
 * The highest `card-N` number a journal recorded on a card or an agreement, 0 for none.
 * pair_start continues card numbering from it, so a card id names one card per journal.
 * @param {unknown} entries
 * @returns {number}
 */
export function lastCardSeq(entries) {
  if (!Array.isArray(entries)) return 0;
  let max = 0;
  for (const e of entries) {
    if (!isObj(e)) continue;
    const id = e.type === "card" && isObj(e.card) ? e.card.id : e.type === "agreement" ? e.cardId : null;
    const m = typeof id === "string" ? /^card-(\d+)$/.exec(id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** The receipt's own line on what it records and what it does not claim. */
export const RECEIPT_MEANS =
  "An export of the gate's journal, written by the gate at stop. An accepted record is a gate-recorded typed agreement followed by pair_done, with hashes of the boundary at that moment; unapproved writes are listed and may coexist with acceptance; whether the implementation matches the agreed approach is not established by this file, and nothing here says the code works. The journal and this file are protected only while pairing is active: journal.entries and journal.sha256 are the journal bytes this file was built from, each restart records the journal's hash as a resume entry, and a record marked suspect rests on journal bytes that no longer match a hash the gate recorded, or that lie outside any pairing span. A consumer who needs this file tamper-evident takes a copy at stop time.";

/** Journal entry types the gate writes only while pairing is active (between a start and a stop). */
const ACTIVE_ONLY = new Set(["card", "agreement", "done", "unapproved-write", "run-start", "run-end"]);

/** `lines` (each without its newline) as the bytes appendJournal wrote them. */
const journalBytes = (lines) => lines.map((l) => `${l}\n`).join("");

/**
 * The journal indexes whose records a receipt marks suspect. Two rules. A checkpoint (a
 * `receipt` entry the stop wrote, a `resume` entry a restart wrote) records how many entries
 * preceded it and the hash of their bytes; when the bytes before it no longer hash to that,
 * every entry since the previous checkpoint is suspect. And an entry the gate writes only while
 * pairing is active, found between a stop and the next start, is suspect: the gate never wrote
 * it there. The hash rule needs the raw lines and a hash function; without them only the span
 * rule applies.
 * @param {unknown[]} all
 * @param {string[] | null} lines
 * @param {((text: string) => string) | undefined} sha256
 */
function suspectIndexes(all, lines, sha256) {
  const out = new Set();
  let active = false;
  let verifiedFrom = 0;
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (!isObj(e)) continue;
    if (e.type === "start" || e.type === "carried-after-clear") active = true;
    else if (e.type === "stop") active = false;
    else if (e.type === "receipt" || e.type === "resume") {
      if (!lines) continue;
      const matches = isObj(e.journal) && e.journal.entries === i && e.journal.sha256 === sha256(journalBytes(lines.slice(0, i)));
      if (!matches) for (let j = verifiedFrom; j < i; j++) out.add(j);
      verifiedFrom = i + 1;
    } else if (ACTIVE_ONLY.has(e.type) && !active) out.add(i);
  }
  return out;
}

/**
 * The pair-accepted receipt, built from a session's journal at a stop: one record per change
 * set pair_done closed (`accepted`: its boundary, what each boundary path held at pair_done, the
 * writes outside the boundary found at that pair_done, the card's declared checks and the
 * pair_run commands under it), the change sets pair_begin opened that pairing ended before
 * pair_done (`notAccepted`), and every unapproved write journaled (`unapproved`). It covers
 * the whole journal, so a session that paired, stopped and paired again gets one receipt for
 * all of it. `sessionId` and `root` come from the caller's state when given, else from the
 * journal's start entries. With `lines` (the journal's raw lines, one per entry, without
 * newlines) and `sha256`, `journal` names the bytes the receipt was built from and every record
 * carries `suspect` (suspectIndexes); without them `journal` is null and only the span rule
 * sets `suspect`.
 * @param {unknown} entries
 * @param {{ version: string, sessionId?: string | null, root?: string | null, lines?: string[], sha256?: (text: string) => string }} opts
 */
export function pairAcceptedReceipt(entries, opts) {
  const all = Array.isArray(entries) ? entries : [];
  const lines = Array.isArray(opts.lines) && opts.lines.length === all.length && typeof opts.sha256 === "function" ? opts.lines : null;
  const suspect = suspectIndexes(all, lines, opts.sha256);
  const cards = new Map();
  const agreed = new Map();
  const runs = new Map();
  const done = new Map();
  const doneOutside = new Map();
  const unapproved = [];
  let sessionId = null;
  let root = null;
  let startedAt;
  let stop = null;
  let afterDone = null;
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (!isObj(e)) continue;
    const justDone = afterDone;
    afterDone = null;
    switch (e.type) {
      case "start":
        if (typeof e.sessionId === "string") sessionId = e.sessionId;
        if (typeof e.root === "string") root = e.root;
        if (startedAt === undefined) startedAt = e.at;
        break;
      case "carried-after-clear":
        if (typeof e.root === "string") root = e.root;
        break;
      case "card":
        if (isObj(e.card) && typeof e.card.id === "string") cards.set(e.card.id, e.card);
        break;
      case "agreement":
        if (typeof e.cardId === "string" && !agreed.has(e.cardId)) agreed.set(e.cardId, { e, i });
        break;
      case "run-start":
        if (typeof e.cardId === "string" && typeof e.runId === "string") {
          if (!runs.has(e.cardId)) runs.set(e.cardId, []);
          runs.get(e.cardId).push({ runId: e.runId, command: typeof e.command === "string" ? e.command : null, exitCode: null });
        }
        break;
      case "run-end":
        for (const list of runs.values()) {
          const run = list.find((r) => r.runId === e.runId);
          if (!run) continue;
          run.exitCode = typeof e.exitCode === "number" ? e.exitCode : null;
          if (e.timedOut === true) run.timedOut = true;
          if (e.aborted === true) run.aborted = true;
          if (typeof e.signal === "string") run.signal = e.signal;
        }
        break;
      case "done":
        if (typeof e.cardId === "string") {
          done.set(e.cardId, { e, i });
          afterDone = e.cardId;
        }
        break;
      case "unapproved-write": {
        const paths = Array.isArray(e.paths) ? e.paths : [];
        unapproved.push({ cardId: typeof e.cardId === "string" ? e.cardId : null, at: e.at, paths, suspect: suspect.has(i) });
        // pair_done journals the writes it found outside the boundary right after its done entry.
        if (justDone !== null && e.cardId === justDone) doneOutside.set(justDone, paths);
        break;
      }
      case "stop":
        stop = e;
        break;
      default:
    }
  }
  const accepted = [];
  const notAccepted = [];
  for (const [cardId, a] of agreed) {
    const card = cards.get(cardId);
    const d = done.get(cardId);
    if (!d) {
      notAccepted.push({ cardId, agreedAt: a.e.at, boundary: isStrArr(card?.boundary) ? card.boundary : [], reason: "pairing ended before pair_done", suspect: suspect.has(a.i) });
      continue;
    }
    accepted.push({
      cardId,
      agreedAt: a.e.at,
      quote: typeof a.e.quote === "string" ? a.e.quote : null,
      doneAt: d.e.at,
      boundary: isStrArr(d.e.boundary) ? d.e.boundary : isStrArr(card?.boundary) ? card.boundary : [],
      // A done entry from before 1.3.0 recorded no hashes; null says so rather than guessing.
      hashes: isObj(d.e.hashes) ? d.e.hashes : null,
      outsideBoundaryWrites: doneOutside.get(cardId) ?? [],
      checks: { declared: isStrArr(card?.checks) ? card.checks : [], runs: runs.get(cardId) ?? [] },
      suspect: suspect.has(a.i) || suspect.has(d.i),
    });
  }
  return {
    pairAccepted: 1,
    pairedCoding: opts.version,
    sessionId: opts.sessionId ?? sessionId,
    root: opts.root ?? root,
    startedAt: startedAt ?? null,
    stoppedAt: stop?.at ?? null,
    stoppedBy: typeof stop?.verb === "string" ? stop.verb : null,
    journal: lines ? { entries: all.length, sha256: opts.sha256(journalBytes(lines)) } : null,
    accepted,
    notAccepted,
    unapproved,
    means: RECEIPT_MEANS,
  };
}

/** pair_note's answers to an earlier roadmap pair_start offered. */
export const EARLIER_ROADMAP_CHOICES = Object.freeze(["pick-up", "start-fresh"]);

/**
 * pair_note: append a note to the journal: free text, a structured roadmap, or both. The
 * latest roadmap replaces the one before it (state.roadmap) and pair_done lists its open and
 * not-ready items. `earlierRoadmap` answers the roadmap pair_start offered: "pick-up" records
 * that whole roadmap in this journal, "start-fresh" records the decline, so a later pair_start
 * stops at this journal either way. An empty or null `earlierRoadmap` counts as absent: some
 * clients send "" for an optional field the model left unset. The agent's only way to keep
 * notes while pairing; the state directory is not writable by any agent tool while pairing is
 * active.
 * @param {State} state
 * @param {{ text?: unknown, roadmap?: unknown, earlierRoadmap?: unknown }} args
 * @param {Io} [io]
 * @returns {Result}
 */
export function pairNote(state, args, io) {
  if (state.phase === "inactive") return refuse(state, "pair_note", "pairing is not active", io);
  if (state.carried) return refuse(state, "pair_note", CARRIED_REASON, io);
  const hasText = typeof args?.text === "string" && args.text.trim() !== "";
  if (args?.text !== undefined && typeof args.text !== "string") return refuse(state, "pair_note", "the note text is not a string", io);
  const text = hasText ? { text: args.text } : {};
  const earlierRoadmap = args?.earlierRoadmap === "" || args?.earlierRoadmap === null ? undefined : args?.earlierRoadmap;
  if (earlierRoadmap !== undefined) {
    if (!EARLIER_ROADMAP_CHOICES.includes(earlierRoadmap)) {
      return refuse(state, "pair_note", `earlierRoadmap is ${JSON.stringify(earlierRoadmap)}; use one of ${EARLIER_ROADMAP_CHOICES.join(", ")}`, io);
    }
    if (args.roadmap !== undefined) return refuse(state, "pair_note", "pass earlierRoadmap or roadmap, not both", io);
    const offer = state.roadmapOffer;
    if (!offer) return refuse(state, "pair_note", "no earlier roadmap is on offer in this session", io);
    const next = clone(state);
    next.roadmapOffer = null;
    if (earlierRoadmap === "start-fresh") {
      return { ok: true, state: next, declined: offer.from, journal: [entry("roadmap-declined", io, { from: offer.from, ...text })] };
    }
    next.roadmap = offer.roadmap.map(roadmapItem);
    return { ok: true, state: next, roadmapOpen: openRoadmapItems(next.roadmap), journal: [entry("note", io, { ...text, roadmap: next.roadmap, carriedFrom: offer.from })] };
  }
  if (args?.roadmap === undefined) {
    if (!hasText) return refuse(state, "pair_note", "the note is empty", io);
    return { ok: true, state, journal: [entry("note", io, { text: args.text })] };
  }
  const problem = roadmapProblem(args.roadmap);
  if (problem) return refuse(state, "pair_note", problem, io);
  const roadmap = args.roadmap.map(roadmapItem);
  const next = clone(state);
  next.roadmap = roadmap;
  next.roadmapOffer = null;
  return { ok: true, state: next, roadmapOpen: openRoadmapItems(roadmap), journal: [entry("note", io, { ...text, roadmap })] };
}

/**
 * pair_propose: record the next card. Its boundary is hashed now (io.hashBoundary), and the
 * card remembers the latest trusted-input sequence number, so only a turn typed after this
 * card can agree to it. Changes found between change sets ride on the card for the user.
 * @param {State} state
 * @param {{ boundary: string[], whyNow?: string, decision?: string, currentCode?: string, proposedCode?: string, effect?: string, checks?: string[], openPoints?: string[] }} card
 * @param {Io} io
 * @returns {Result & { card?: Card }}
 */
export function pairPropose(state, card, io) {
  if (state.phase === "inactive") return refuse(state, "pair_propose", "pairing is not active", io);
  if (state.carried) return refuse(state, "pair_propose", CARRIED_REASON, io);
  if (state.halt) return refuse(state, "pair_propose", `the session is stopped: ${state.halt.reason}`, io);
  if (state.phase === "open") return refuse(state, "pair_propose", "a change set is open; finish it with pair_done before the next card", io);
  if (olderBaseline(state.baseline)) return refuse(state, "pair_propose", OLDER_PLUGIN, io);
  if (!state.root) return refuse(state, "pair_propose", "the state lost its worktree root; your partner types pair stop, then start pairing again", io);
  if (!isObj(card)) return refuse(state, "pair_propose", "the card is not an object", io);
  const problem = boundaryProblem(card.boundary);
  if (problem) return refuse(state, "pair_propose", problem, io);
  if (card.openPoints !== undefined && !isStrArr(card.openPoints)) return refuse(state, "pair_propose", "openPoints is not a list of strings", io);
  if (card.checks !== undefined && !isStrArr(card.checks)) return refuse(state, "pair_propose", "checks is not a list of strings", io);
  const hashed = callIo(io, "hashBoundary", [...card.boundary], state.root);
  if (hashed.error) return refuse(state, "pair_propose", `could not hash the boundary: ${hashed.error}`, io);
  if (!isSnapshot(hashed.value)) return refuse(state, "pair_propose", "hashBoundary returned malformed hashes", io);
  const next = clone(state);
  next.cardSeq += 1;
  /** @type {Card} */
  const recorded = {
    id: `card-${next.cardSeq}`,
    whyNow: card.whyNow,
    decision: card.decision,
    currentCode: card.currentCode,
    proposedCode: card.proposedCode,
    effect: card.effect,
    boundary: [...card.boundary],
    checks: card.checks ? [...card.checks] : [],
    openPoints: card.openPoints ? [...card.openPoints] : [],
    hashes: hashed.value,
    inputSeq: next.inputSeq,
    at: stamp(io),
    changedSinceReadBack: next.unreviewed,
  };
  next.card = JSON.parse(JSON.stringify(recorded));
  next.unreviewed = [];
  next.midTurn = [];
  return { ok: true, state: next, card: next.card, journal: [entry("card", io, { card: next.card })] };
}

/**
 * pair_begin: open the change set for the latest card. Succeeds only if (a) cardId is the
 * latest card, (b) a trusted turn arrived after the card, (c) `quote` occurs verbatim in the
 * latest trusted turn, (d) the boundary files hash to their proposal-time values. Also refused
 * while the card lists open points, while a change set is open, and while the session is
 * stopped. On success it snapshots the worktree; changes since the last snapshot are
 * journaled and shown on the next card.
 * @param {State} state
 * @param {{ cardId: unknown, quote: unknown }} args
 * @param {Io} io
 * @returns {Result}
 */
export function pairBegin(state, args, io) {
  if (state.phase === "inactive") return refuse(state, "pair_begin", "pairing is not active", io);
  if (state.halt) return refuse(state, "pair_begin", `the session is stopped: ${state.halt.reason}`, io);
  if (state.phase === "open") return refuse(state, "pair_begin", "a change set is already open", io);
  if (olderBaseline(state.baseline) || olderSnapshot(state.card?.hashes)) return refuse(state, "pair_begin", OLDER_PLUGIN, io);
  const card = state.card;
  if (!card) return refuse(state, "pair_begin", "no card has been proposed", io);
  if (args?.cardId !== card.id) return refuse(state, "pair_begin", "that card is not the latest card; re-propose it", io);
  if (card.openPoints && card.openPoints.length > 0) return refuse(state, "pair_begin", "the card still lists open points; settle them and re-propose", io);
  const problem = quoteProblem(state, card.inputSeq, args.quote);
  if (problem) return refuse(state, "pair_begin", problem, io);
  const hashed = callIo(io, "hashBoundary", [...card.boundary], state.root);
  if (hashed.error) return refuse(state, "pair_begin", `could not hash the boundary: ${hashed.error}`, io);
  if (!sameHashes(hashed.value, card.hashes)) return refuse(state, "pair_begin", "a boundary file or directory changed since the card was shown; the card is stale, re-propose it", io);
  const snap = takeSnapshot(io);
  if (snap.error) return refuse(state, "pair_begin", `could not snapshot the worktree: ${snap.error}`, io);
  const next = clone(state);
  const between = next.baseline ? diffSnapshots(next.baseline, snap.value, next.exclusions) : [];
  next.unreviewed = [...next.unreviewed, ...between];
  next.baseline = snap.value;
  next.phase = "open";
  next.changeSet = {
    cardId: card.id,
    boundary: [...card.boundary],
    quote: args.quote,
    inputSeq: next.lastInput.seq,
    runs: [],
    openedAt: stamp(io),
  };
  const journal = [];
  if (between.length) journal.push(entry("between-change-sets", io, { changes: between }));
  journal.push(entry("agreement", io, { cardId: card.id, quote: args.quote, inputSeq: next.lastInput.seq, cardAt: card.at }));
  return { ok: true, state: next, journal };
}

/**
 * pair_done: close the open change set. Refused while a pair_run under it is running. On
 * success it first reaps every process group of the change set's runs (io.reapRuns), then
 * snapshots, so the read-back is taken after writes have stopped. Every changed path must lie
 * inside the boundary; any that does not is an unapproved write and stops the session. Refused
 * while the session is stopped (a run that made a link: runEnd), so no read-back is shown then.
 * Returns `changed` (inside the boundary, for the read-back diff) and `unapproved`. The `done`
 * journal entry records the boundary and what its paths held at this snapshot (boundaryHashes),
 * which the pair-accepted receipt copies at the stop (pairAcceptedReceipt).
 * @param {State} state
 * @param {{ cardId: unknown }} args
 * @param {Io} io
 * @returns {Result & { changed?: Array<{path: string, change: string}>, unapproved?: Array<{path: string, change: string}> }}
 */
export function pairDone(state, args, io) {
  if (state.phase !== "open") return refuse(state, "pair_done", "no change set is open", io);
  const cs = state.changeSet;
  if (args?.cardId !== cs.cardId) return refuse(state, "pair_done", "that card is not the open change set", io);
  if (state.halt) return refuse(state, "pair_done", `the session is stopped: ${state.halt.reason}; only your partner ends it, by typing pair stop`, io);
  if (state.running.some((r) => r.cardId === cs.cardId)) return refuse(state, "pair_done", "a pair_run under this change set is still running", io);
  if (olderBaseline(state.baseline)) return refuse(state, "pair_done", OLDER_PLUGIN, io);
  if (cs.runs.length > 0) {
    const reaped = callIo(io, "reapRuns", [...cs.runs]);
    if (reaped.error) return refuse(state, "pair_done", `could not reap the change set's process groups: ${reaped.error}`, io);
  }
  const snap = takeSnapshot(io);
  if (snap.error) return refuse(state, "pair_done", `could not snapshot the worktree: ${snap.error}`, io);
  const diff = state.baseline ? diffSnapshots(state.baseline, snap.value, state.exclusions) : [];
  const changed = diff.filter((d) => boundaryMatches(cs.boundary, d.path));
  const unapproved = diff.filter((d) => !boundaryMatches(cs.boundary, d.path));
  const next = clone(state);
  next.phase = "closed";
  next.changeSet = null;
  next.baseline = snap.value;
  const journal = [entry("done", io, { cardId: cs.cardId, boundary: [...cs.boundary], hashes: boundaryHashes(cs.boundary, snap.value), changed })];
  if (unapproved.length) {
    next.halt = { reason: `unapproved write outside change set ${cs.cardId}: ${unapproved.map((d) => d.path).join(", ")}`, at: stamp(io) };
    journal.push(entry("unapproved-write", io, { cardId: cs.cardId, paths: unapproved }));
  }
  return { ok: true, state: next, journal, changed, unapproved, halted: unapproved.length > 0, roadmapOpen: openRoadmapItems(state.roadmap) };
}

// ─── tool verdicts ──────────────────────────────────────────────────────────────────────

/**
 * The pre-call verdict for any host tool call. Inactive: allow everything. While pairing, an
 * allowlist: read-only tools and the pair_* verbs are allowed (pair_write and pair_edit only
 * while open); the host's mutating tools, its code runners and sub-agent dispatch are refused;
 * anything unknown is refused. `opts.allow` adds host lifecycle tools by name, and can never
 * re-allow a mutating, dispatch or pair_* name.
 * @param {State} state
 * @param {{ toolName: unknown }} call
 * @param {{ allow?: string[] }} [opts]
 * @param {Io} [io]
 * @returns {{ allow: boolean, reason?: string, journal: JournalEntry[] }}
 */
export function toolVerdict(state, call, opts = {}, io) {
  if (state.phase === "inactive") return { allow: true, journal: [] };
  const name = typeof call?.toolName === "string" ? call.toolName : "";
  const deny = (reason) => ({ allow: false, reason, journal: [entry("refusal", io, { verb: "tool_call", tool: name, reason })] });
  const pass = () => ({ allow: true, journal: [entry("verdict", io, { tool: name, allow: true })] });
  if (PAIR_SET.has(name)) {
    if ((name === "pair_write" || name === "pair_edit") && state.phase !== "open") return deny("no change set is open; agree a card first");
    return pass();
  }
  if (READ_SET.has(name)) return pass();
  const hostAllowed = !MUTATING_SET.has(name) && !DISPATCH_SET.has(name) && Array.isArray(opts.allow) && opts.allow.includes(name);
  if (hostAllowed) return pass();
  if (state.carried) return deny(`${name || "(unnamed tool)"} is refused: ${CARRIED_REASON}`);
  if (MUTATING_SET.has(name)) return deny(`${name} is the host's own mutating tool; while pairing, write with pair_write or pair_edit and run commands with pair_run`);
  if (DISPATCH_SET.has(name)) return deny("sub-agent dispatch is refused while pairing; do the recon in this session");
  return deny(`${name || "(unnamed tool)"} is not on the pairing allowlist`);
}

/**
 * pair_write / pair_edit, checked INSIDE the tool's execute function against the final
 * arguments it received. Allowed only while open, only inside the worktree and the boundary,
 * never in the state directory. With io.realpath the resolved target is checked the same way,
 * so a symlink cannot carry a write out of the boundary.
 * @param {State} state
 * @param {{ path: unknown, toolName?: string }} args
 * @param {Io} [io]
 * @returns {{ ok: boolean, reason?: string, absPath?: string, journal: JournalEntry[] }}
 */
export function checkWrite(state, args, io) {
  const verb = args?.toolName === "pair_edit" ? "pair_edit" : "pair_write";
  const deny = (reason) => ({ ok: false, reason, journal: [entry("refusal", io, { verb, path: String(args?.path), reason })] });
  if (state.phase === "inactive") return deny("pairing is not active");
  if (state.halt) return deny(`the session is stopped: ${state.halt.reason}`);
  if (state.phase !== "open") return deny("no change set is open; agree a card first");
  const abs = resolvePath(state.root, args?.path);
  const problem = targetProblem(state, abs);
  if (problem) return deny(problem);
  if (io && typeof io.realpath === "function") {
    const real = callIo(io, "realpath", abs);
    if (real.error) return deny(`could not resolve the target: ${real.error}`);
    const realProblem = targetProblem(state, resolvePath(state.root, real.value));
    if (realProblem) return deny(`the target resolves to ${String(real.value)}: ${realProblem}`);
  }
  return { ok: true, absPath: abs, journal: [entry("write", io, { verb, path: relativeTo(state.root, abs), cardId: state.changeSet.cardId })] };
}

function targetProblem(state, abs) {
  if (!abs) return "the path is not usable";
  if (within(state.stateDir, abs)) return "the path is inside the pairing state directory";
  const rel = relativeTo(state.root, abs);
  if (!boundaryMatches(state.changeSet.boundary, rel)) return "outside the agreed boundary; reopen";
  if (isGitControl(rel)) return "the path is git's own control data under .git, which git would read or run outside the sandbox; under .git a change set writes only what a commit writes (objects/, refs/, logs/, index, HEAD, ORIG_HEAD, COMMIT_EDITMSG, packed-refs, AUTO_MERGE)";
  return null;
}

// ─── pair_run ───────────────────────────────────────────────────────────────────────────

/**
 * Admit one pair_run and return the Seatbelt profile it must run under, built from the state
 * at this moment (on Linux the adapter builds bwrapArgsFor from the same returned state). The
 * command itself plays no part in the sandbox: whatever command arrives at execution, after any
 * other extension rewrote it, runs under it. The adapter passes the command it is about to run
 * as `command`, and the run-start entry records it for the pair-accepted receipt. Runs started
 * while open are tied to the change set so pair_done can refuse while they run and reap them
 * afterwards.
 * @param {State} state
 * @param {{ runId: unknown, command?: unknown }} args
 * @param {Io} [io]
 * @returns {Result & { profile?: string }}
 */
export function runStart(state, args, io) {
  if (state.phase === "inactive") return refuse(state, "pair_run", "pairing is not active", io);
  if (state.halt) return refuse(state, "pair_run", `the session is stopped: ${state.halt.reason}`, io);
  if (!state.root || !state.stateDir) return refuse(state, "pair_run", "the state lost its worktree root; your partner types pair stop, then start pairing again", io);
  const runId = args?.runId;
  if (typeof runId !== "string" || runId === "") return refuse(state, "pair_run", "the run has no id", io);
  if (state.running.some((r) => r.runId === runId)) return refuse(state, "pair_run", "a run with this id is already running", io);
  let profile;
  try {
    profile = pairRunProfile(state);
  } catch (err) {
    return refuse(state, "pair_run", `could not build the sandbox profile: ${err instanceof Error ? err.message : String(err)}`, io);
  }
  const next = clone(state);
  const cardId = next.phase === "open" ? next.changeSet.cardId : null;
  next.running.push({ runId, cardId });
  if (cardId) next.changeSet.runs.push(runId);
  const command = typeof args.command === "string" ? { command: args.command } : {};
  return { ok: true, state: next, profile, journal: [entry("run-start", io, { runId, cardId, phase: next.phase, ...command })] };
}

/**
 * Record that a pair_run returned (exited, timed out or was aborted and reaped). `links` are the
 * worktree-relative paths the adapter found the run made since it started: a symlink, a hard
 * link, or a `.git` entry in the paths it could write. Any stops the session: a link inside the
 * boundary would carry a later write, the partner's own editor's included, to wherever it
 * points, and a new `.git` holds hooks and config git runs outside the sandbox.
 * `supervisorKilled` is the signal a Landlock run's supervising helper died of, whoever sent
 * it: the run itself before Landlock ABI 6, someone outside, or the adapter's own SIGKILL when
 * the helper did not end in time after a timeout or abort. Once the helper has forked the
 * command it never dies of a signal by its own choice, so it was killed before it ended the
 * processes that left the run's group, which may still write with its grant. That stops the
 * session the same way, at the cost of a stop after a helper that was only slow. pair_done then
 * refuses until the partner types pair stop. The adapter never reports SIGTERM, SIGINT or
 * SIGHUP here: the helper blocks them before it forks, so dying of one means no command ran.
 * @param {State} state
 * @param {{ runId: unknown, exitCode?: unknown, links?: unknown, supervisorKilled?: unknown }} args
 * @param {Io} [io]
 * @returns {Result}
 */
export function runEnd(state, args, io) {
  if (state.phase === "inactive" || !Array.isArray(state.running)) return { ok: true, state, journal: [] };
  const next = clone(state);
  next.running = next.running.filter((r) => r.runId !== args?.runId);
  const journal = [entry("run-end", io, { runId: args?.runId, exitCode: args?.exitCode })];
  const links = Array.isArray(args?.links) ? args.links.filter((l) => typeof l === "string" && l !== "") : [];
  const reasons = [];
  if (links.length > 0) {
    reasons.push(`pair_run made a link or a .git entry inside the paths it could write: ${links.join(", ")}`);
    journal.push(entry("link-made", io, { runId: args?.runId, paths: links }));
  }
  const killedBy = typeof args?.supervisorKilled === "string" && args.supervisorKilled !== "" ? args.supervisorKilled : null;
  if (killedBy) {
    reasons.push(`pair_run's Landlock supervisor was killed by ${killedBy} before it ended the run's processes, so a process the run started may still be writing`);
    journal.push(entry("supervisor-killed", io, { runId: args?.runId, signal: killedBy }));
  }
  if (reasons.length > 0) next.halt = { reason: reasons.join("; "), at: stamp(io) };
  return { ok: true, state: next, journal };
}

/** A Seatbelt string literal; control characters are refused rather than guessed at. */
function sbplString(path) {
  if (CONTROL.test(path)) throw new Error(`a sandboxed path holds a control character (${JSON.stringify(path)})`);
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sbplRegex(source) {
  if (CONTROL.test(source) || source.includes('"')) throw new Error("a boundary pattern cannot be expressed as a sandbox regex");
  return `#"${source}"`;
}

/**
 * The directories a boundary entry needs to exist, absolute: every ancestor of a file entry,
 * and every directory above the first glob segment of a glob entry. Creating one of them as a
 * directory is part of writing the entry.
 */
function boundaryAncestors(root, boundary) {
  const out = new Set();
  for (const raw of boundary) {
    const segs = normalizeEntry(raw).split("/");
    const fixed = [];
    for (const seg of segs.slice(0, -1)) {
      if (isGlob(seg)) break;
      fixed.push(seg);
      out.add(`${root}/${fixed.join("/")}`);
    }
  }
  return [...out];
}

/**
 * The Seatbelt profile for pair_run in the current phase, and for the kernel-fenced write of
 * pair_write and pair_edit while open. Later Seatbelt rules win, so the order below is the
 * precedence, last one strongest. Both phases deny every write by default:
 *   1. all writes denied;
 *   2. the temp paths and the few /dev files a shell needs allowed;
 *   3. the whole worktree denied again (a worktree that sits under a temp path stays fenced);
 *   4. open only: the boundary allowed, and creating the directories above it as directories;
 *   5. under any `.git`, everything but what a commit writes denied (GIT_PATHS less
 *      GIT_WRITABLE, plus GIT_CONTROL always), then the state directory and the protected
 *      paths denied, even where a boundary or temp path covers them;
 *   6. creating a hard link denied everywhere. Seatbelt rules match paths, so a link inside the
 *      boundary to a file outside it would let a later write to the boundary path land on the
 *      outside file.
 * Every profile also denies connecting to a Unix-domain socket, except mDNSResponder's (DNS
 * lookups go through it). A local daemon reached over a socket (Docker's, for one) writes with
 * its own rights, not the sandbox's, so it could write the state directory for pair_run.
 * TCP is left open, local services included.
 * So in the closed phase pair_run writes nowhere but temp and /dev.
 * @param {State} state
 * @returns {string}
 */
export function pairRunProfile(state) {
  return profileFor(state, []);
}

/** No Unix-domain socket connections from a sandboxed command, except the DNS resolver's. */
const UNIX_SOCKETS = '(deny network-outbound (remote unix-socket))(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))';

function profileFor(state, extraAllow) {
  const outside = [
    ...["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"].map((p) => `(literal ${sbplString(p)})`),
    `(subpath ${sbplString("/dev/fd")})`,
    ...(state.tempPaths ?? []).map((p) => `(subpath ${sbplString(p)})`),
  ];
  const head = `(version 1)(allow default)${UNIX_SOCKETS}(deny file-write*)(allow file-write* ${outside.join(" ")})(deny file-write* (subpath ${sbplString(state.root)}))`;
  const root = state.root.replace(REGEX_META, (ch) => `\\${ch}`);
  const rx = (source) => `(regex ${sbplRegex(`^${root}/${source}$`)})`;
  const git = `${GIT_CONTROL.map((source) => `(deny file-write* ${rx(source)})`).join("")}(deny file-write* (require-all ${rx(GIT_PATHS)} (require-not ${rx(GIT_WRITABLE)})))`;
  const tail = `${git}${[state.stateDir, ...(state.protect ?? [])].map((p) => `(deny file-write* (subpath ${sbplString(p)}))`).join("")}(deny file-link)`;
  if (state.phase !== "open") return `${head}${tail}`;
  const boundary = state.changeSet.boundary.map((raw) => {
    const e = normalizeEntry(raw);
    if (!isGlob(e)) return `(literal ${sbplString(`${state.root}/${e}`)})`;
    return `(regex ${sbplRegex(`^${root}/${globToRegexSource(e)}$`)})`;
  });
  const extra = extraAllow.map((p) => `(literal ${sbplString(p)})`);
  const dirs = boundaryAncestors(state.root, state.changeSet.boundary).map((p) => `(literal ${sbplString(p)})`);
  const mkdirs = dirs.length ? `(allow file-write-create (require-all (vnode-type DIRECTORY) (require-any ${dirs.join(" ")})))` : "";
  return `${head}(allow file-write* ${[...boundary, ...extra].join(" ")})${mkdirs}${tail}`;
}

/** The name pair_write's temp file must have: a dotfile, a 16-hex-digit nonce, ".tmp". */
const WRITE_TEMP = /\/\.pair-write-[0-9a-f]{16}\.tmp$/;

/**
 * The Seatbelt profile pair_write and pair_edit write under: the open profile with no temp
 * paths, so a path that resolves anywhere but the boundary (a temp directory included) is
 * refused by the kernel, plus the one temp file the write is staged in. The write goes to
 * `tempPath` and is renamed over the target, so it never writes through the target's inode:
 * a hard link to a file outside the boundary is replaced, never written. Open phase only.
 * @param {State} state
 * @param {string} tempPath  absolute, in the worktree, named .pair-write-<16 hex>.tmp
 * @returns {string}
 */
export function pairWriteProfile(state, tempPath) {
  checkWriteTemp(state, tempPath);
  return profileFor({ ...state, tempPaths: [] }, [tempPath]);
}

function checkWriteTemp(state, tempPath) {
  if (state.phase !== "open") throw new Error("pair_write needs an open change set");
  if (typeof tempPath !== "string" || !WRITE_TEMP.test(tempPath) || !within(state.root, tempPath) || tempPath.includes("/../")) {
    throw new Error("pair_write needs a staging file in the worktree named .pair-write-<16 hex>.tmp");
  }
}

// ─── the Linux sandbox (bubblewrap) ─────────────────────────────────────────────────────

/** Whether a worktree-relative path has a `.git` segment, in any letter case. */
function inGitDir(rel) {
  return rel.split("/").some((seg) => seg.toLowerCase() === ".git");
}

/**
 * Where an open change set lets a write land in the worktree, absolute: each literal boundary
 * entry itself, and for a glob entry the directory above its first glob segment (the root for
 * an entry that starts with one). Nothing at or under a `.git` segment. Seatbelt fences writes
 * inside these by pattern; bubblewrap can only bind them, and pair_run's link check walks them.
 * @param {State} state
 * @returns {string[]}
 */
export function boundaryRoots(state) {
  if (state.phase !== "open" || !state.changeSet) return [];
  const out = new Set();
  for (const raw of state.changeSet.boundary) {
    const fixed = [];
    for (const seg of normalizeEntry(raw).split("/")) {
      if (isGlob(seg)) break;
      fixed.push(seg);
    }
    const rel = fixed.join("/");
    if (rel !== "" && inGitDir(rel)) continue;
    out.add(rel === "" ? state.root : `${state.root}/${rel}`);
  }
  return [...out];
}

/**
 * The filesystem facts the bubblewrap builders need, injected so the core stays free of I/O.
 * @typedef {object} BwrapIo
 * @property {(abs: string) => "dir" | "file" | "other" | null} kind  what is at `abs`, symlinks
 *   followed; null when nothing is
 * @property {(dir: string, recursive: boolean) => string[]} gitEntries  every entry named `.git`
 *   (any letter case, directory, gitfile or symlink) under `dir`, absolute; recursive or only
 *   `dir`'s own children. A `.git` is not descended into, and symlinked directories are not followed
 */

/**
 * @typedef {object} BwrapPlan
 * @property {string[]} args  bwrap options, without the command; binds are plain `--bind SRC
 *   DEST`, which the adapter pins to open file descriptors before it runs them
 * @property {string[]} writable  the read-write binds in the worktree
 * @property {string[]} temps  the read-write binds of temp paths
 * @property {string[]} readOnly  what is bound read-only back on top of them
 */

/**
 * How a bubblewrap sandbox gets its /proc. lib/bwrap.mjs probes which one this machine allows
 * and hands it to every builder below:
 *   fresh    a new procfs for the sandbox's own PID namespace (--proc /proc);
 *   ro-bind  the host's /proc bound read-only, for a container (Docker without
 *            systempaths=unconfined) that masks parts of /proc, where the kernel refuses a fresh
 *            procfs (--ro-bind /proc /proc).
 * Every namespace is unshared in both; only the /proc options differ. There is no mode without
 * the host's /proc: leaving the option out still carries it in through the recursive
 * `--ro-bind / /`, and an empty /proc breaks /dev/fd (bash's `<(...)`) and /proc/self/exe.
 */
export const BWRAP_PROC_ARGS = Object.freeze({
  fresh: Object.freeze(["--proc", "/proc"]),
  "ro-bind": Object.freeze(["--ro-bind", "/proc", "/proc"]),
});

/**
 * The options every bubblewrap sandbox starts with, the probe's included: the filesystem
 * read-only, a fresh /dev, /proc as `proc` says, a private /tmp, and every namespace unshared.
 * @param {keyof typeof BWRAP_PROC_ARGS} proc
 * @returns {string[]}
 */
export function bwrapBase(proc) {
  if (!Object.hasOwn(BWRAP_PROC_ARGS, proc)) throw new Error(`no bubblewrap /proc mode ${JSON.stringify(proc)}`);
  return ["--ro-bind", "/", "/", "--dev", "/dev", ...BWRAP_PROC_ARGS[proc], "--tmpfs", "/tmp", "--unshare-all", "--die-with-parent", "--new-session"];
}

/**
 * The bubblewrap options pair_run runs under on Linux, built from the same state as the Seatbelt
 * profile (profileFor), so the two backends read one source. bwrap mounts in argument order and
 * a later mount covers an earlier one, so as in the profile the order is the precedence, last
 * one strongest:
 *   1. the whole filesystem read-only, a fresh /dev, /proc as `proc` says (bwrapBase), and a
 *      private, empty /tmp;
 *   2. the temp paths read-write, except /tmp itself, which is the private one;
 *   3. the worktree read-only again where a temp path or the private /tmp covered it;
 *   4. open only: read-write binds for the boundary (boundaryRoots) and `extraAllow`. A path
 *      that does not exist yet is bound through its deepest existing ancestor. Nothing at or
 *      under a `.git` segment, the state directory or a protected path is bound;
 *   5. every `.git` entry under a worktree bind read-only, so all of git's directory is
 *      read-only (Seatbelt leaves what a commit writes writable; per-directory binds cannot);
 *   6. the state directory and the protected paths read-only wherever a bind covers them (a
 *      path that does not exist yet: its deepest existing ancestor).
 * Every namespace is unshared except the network, which the Seatbelt profile also leaves open.
 * The adapter adds the seccomp filter that refuses Unix-domain sockets and checks after each run
 * that no link appeared in the binds (bubblewrap has no per-operation deny for either).
 * @param {State} state
 * @param {string[]} extraAllow  absolute paths also writable
 * @param {BwrapIo} io
 * @param {keyof typeof BWRAP_PROC_ARGS} proc  the /proc mode bubblewrap's probe settled on
 * @returns {BwrapPlan}
 */
export function bwrapArgsFor(state, extraAllow, io, proc) {
  return bwrapPlan(state, [...boundaryRoots(state), ...extraAllow], { temps: state.tempPaths ?? [], network: true, recursiveGit: true, proc }, io);
}

/**
 * The bubblewrap options pair_write and pair_edit write under on Linux: only the staging file's
 * directory (its deepest existing ancestor) is writable, no temp path, no network. A rename over
 * a file that is itself a bind mount fails, so the directory is bound rather than the target;
 * the gate's own write script is the only thing that runs there, and it writes the staging file
 * and renames it over the target checkWrite passed. Open phase only.
 * @param {State} state
 * @param {string} tempPath  absolute, in the worktree, named .pair-write-<16 hex>.tmp
 * @param {BwrapIo} io
 * @param {keyof typeof BWRAP_PROC_ARGS} proc  the /proc mode bubblewrap's probe settled on
 * @returns {BwrapPlan}
 */
export function pairWriteBwrap(state, tempPath, io, proc) {
  checkWriteTemp(state, tempPath);
  return bwrapPlan(state, [tempPath.slice(0, tempPath.lastIndexOf("/"))], { temps: [], network: false, recursiveGit: false, proc }, io);
}

function bwrapPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || CONTROL.test(path)) throw new Error(`a sandboxed path is not usable (${JSON.stringify(path)})`);
  return path;
}

function deepestExisting(path, stop, io) {
  let p = path;
  while (p !== stop && io.kind(p) === null) p = p.slice(0, p.lastIndexOf("/")) || "/";
  return io.kind(p) === null ? null : p;
}

function outermost(paths) {
  const out = [];
  for (const p of [...new Set(paths)].sort((a, b) => a.length - b.length)) {
    if (!out.some((o) => within(o, p))) out.push(p);
  }
  return out;
}

function bwrapPlan(state, wanted, opts, io) {
  const root = bwrapPath(state.root);
  const denied = [state.stateDir, ...(state.protect ?? [])].map(bwrapPath);
  const args = [...bwrapBase(opts.proc), ...(opts.network ? ["--share-net"] : [])];
  const temps = outermost(opts.temps.map(bwrapPath).filter((t) => t !== "/tmp" && io.kind(t) === "dir" && !denied.some((d) => within(d, t))));
  for (const t of temps) args.push("--bind", t, t);
  if (within("/tmp", root) || temps.some((t) => within(t, root))) args.push("--ro-bind", root, root);
  const writable = outermost(wanted.map(bwrapPath).flatMap((want) => {
    if (!within(root, want)) return [];
    const at = deepestExisting(want, root, io);
    if (at === null || inGitDir(relativeTo(root, at) ?? "")) return [];
    return denied.some((d) => within(d, at)) ? [] : [at];
  }));
  for (const w of writable) args.push("--bind", w, w);
  const readOnly = [];
  for (const w of writable) if (io.kind(w) === "dir") readOnly.push(...io.gitEntries(w, opts.recursiveGit).map(bwrapPath));
  for (const d of denied) {
    const cover = [...temps, ...writable].find((b) => within(b, d));
    if (!cover) continue;
    const at = deepestExisting(d, cover, io);
    if (at !== null) readOnly.push(at);
  }
  const ro = [...new Set(readOnly)];
  for (const p of ro) args.push("--ro-bind", p, p);
  return { args, writable, temps, readOnly: ro };
}

// ─── the Linux sandbox (Landlock) ───────────────────────────────────────────────────────

/**
 * The filesystem facts the Landlock builders need, injected so the core stays free of I/O.
 * Neither function follows a symlink.
 * @typedef {object} LandlockIo
 * @property {(abs: string) => { type: "file" | "dir" | "symlink" | "other", nlink: number } | null} lstat
 *   what is at `abs` itself; null when nothing is
 * @property {(dir: string) => Array<{ path: string, type: "file" | "dir" | "symlink" | "other" | "unreadable", nlink: number }>} walk
 *   every entry under `dir` (not `dir` itself), absolute. An entry named `.git` in any letter
 *   case is listed but not descended into, and a symlinked directory is not followed. An
 *   entry that cannot be looked at is listed as "unreadable", and a directory (`dir` itself
 *   included) that cannot be listed gets one "unreadable" entry at `<directory>/`
 * @property {() => string[] | null} mounts
 *   every mount point, absolute (/proc/self/mountinfo); null when they cannot be read
 */

/**
 * @typedef {object} LandlockRules  the pair-landlock ruleset (landlock/README.md), less `command`
 * @property {string[]} files  WRITE_FILE and TRUNCATE on each one file
 * @property {Array<{ path: string, make_dir: boolean, remove: boolean }>} dirs  MAKE_REG,
 *   WRITE_FILE and TRUNCATE under each tree, MAKE_DIR too where make_dir, and REMOVE_FILE and
 *   REFER (delete files, rename them between granted directories) where remove
 * @property {string[]} rw_trees  the temp paths: every right but REFER under each tree
 */

/** The few device files a shell writes to, which Landlock does not grant implicitly. */
export const LANDLOCK_DEVICES = Object.freeze(["/dev/null", "/dev/zero", "/dev/tty"]);

/**
 * The pair-landlock ruleset pair_run runs under on Linux, built from the same state as the
 * Seatbelt profile (profileFor) and the bubblewrap options (bwrapArgsFor). Landlock only
 * grants: a path with no rule cannot be written, and nothing inside a granted tree can be
 * taken back out. So:
 *   1. /dev/null, /dev/zero and /dev/tty, where they exist, as `files`;
 *   2. each temp path that exists as an `rw_trees` entry, except one inside the worktree;
 *   3. open only: each existing literal boundary file as a `files` entry; a literal that does
 *      not exist yet gets nothing of its own, so pair_run can create it only where a glob's
 *      `dirs` grant already covers its parent (pair_write can always create it). For a glob,
 *      each existing matching file under the directory above its first glob segment as a
 *      `files` entry, and a `dirs` grant only on a clean directory the glob could hold a file
 *      under (the outermost such ones): every existing non-directory in its tree is a regular
 *      file inside the boundary with one link, and no mount point is at or under it, so that
 *      no existing file outside the boundary becomes writable or removable. The worktree root never
 *      gets one, since it holds .git: a glob at the root (`*.md`, `**`) has its matching root
 *      files granted one by one and its subdirectories looked at in turn, and cannot create a
 *      file directly in the root. A glob whose fixed directory does not exist yet gets a
 *      `dirs` grant on its deepest existing directory under the same condition, unless that
 *      grant would hold the root, a .git, the state directory or a protected path. `make_dir`
 *      only where the glob allows new directories: one with a `**` segment, or one whose fixed
 *      directory is missing. `uncreatable` names the entries whose new files no grant covers:
 *      a missing literal, a glob whose missing directory got no grant, and a glob that could
 *      hold a file directly in the root;
 *   4. nothing at or under a `.git` segment, the state directory or a protected path.
 * A `dirs` grant lets a command create a file of any name under it; that is the one way new
 * files can be allowed, since a rule needs an existing inode. So new files under a glob are
 * fenced per directory, and every other write per file. Every `dirs` grant here is on a clean
 * directory, so each also carries `remove`: deleting or renaming a file there touches only
 * agreed files, or ones the run made, as Seatbelt's per-path unlink allows. A rename cannot
 * take a file out of the grant, since Landlock wants REFER and MAKE_REG at the destination.
 * Literal files get no `remove`: deleting one needs a right on its whole directory.
 * Returns { notExpressible: reason } when an `rw_trees` path, or a `dirs` path wanted for an
 * existing file, would hold the worktree root, a `.git` entry, the state directory or a
 * protected path, or when a file it would grant has more than one hard link (a rule on an
 * inode reaches every name it has). The adapter then runs the command under bubblewrap.
 * Throws when a path the ruleset would name passes through a symlink inside the worktree,
 * which refuses the run as bubblewrap's pinned binds do.
 * The adapter adds `command`, the socket filter is the helper's own, and the adapter checks
 * after each run that no link appeared where the run could write, as it does for bubblewrap.
 * @param {State} state
 * @param {string[]} extraAllow  absolute paths in the worktree also writable, as literal entries
 * @param {LandlockIo} io
 * @returns {(LandlockRules & { uncreatable?: string[] }) | { notExpressible: string }}
 */
export function landlockRulesFor(state, extraAllow, io) {
  const root = bwrapPath(state.root);
  const denied = [state.stateDir, ...(state.protect ?? [])].map(bwrapPath);
  const files = LANDLOCK_DEVICES.filter((p) => io.lstat(p) !== null);
  const rwTrees = [];
  for (const t of outermost((state.tempPaths ?? []).map(bwrapPath))) {
    if (io.lstat(t)?.type !== "dir" || within(root, t)) continue;
    if (within(t, root)) return { notExpressible: `the temp path ${t} holds the worktree, and Landlock cannot fence the worktree inside it` };
    const held = denied.find((d) => within(t, d));
    if (held) return { notExpressible: `the temp path ${t} holds ${held}, which Landlock cannot fence inside it` };
    rwTrees.push(t);
  }
  if (state.phase !== "open" || !state.changeSet) return { files, dirs: [], rw_trees: rwTrees };
  const boundary = state.changeSet.boundary;
  const grantable = (abs) => {
    const rel = relativeTo(root, abs);
    return rel !== null && !inGitDir(rel) && !denied.some((d) => within(d, abs));
  };
  const matches = (abs) => grantable(abs) && boundaryMatches(boundary, relativeTo(root, abs)) && !isGitControl(relativeTo(root, abs));
  const wantFiles = new Set();
  /** @type {Map<string, boolean>} candidate dirs -> make_dir */
  const wantDirs = new Map();
  // Each walk is indexed by parent directory, so a question about a directory costs its own
  // subtree once, not the whole walk: on a large tree (a node_modules) the cost stays linear.
  // The index holds exactly what io.walk returns; nothing is skipped beyond what it skips.
  const tops = [];
  /** @type {Map<string, ReturnType<LandlockIo["walk"]>>} directory -> its direct entries */
  const kids = new Map();
  const cover = (dir) => {
    if (tops.some((t) => within(t, dir))) return;
    const before = [...tops];
    tops.push(dir);
    for (const e of io.walk(dir)) {
      const parent = e.path.slice(0, e.path.lastIndexOf("/")) || "/";
      // A directory an earlier walk covered already has its entries.
      if (before.some((t) => within(t, parent))) continue;
      const list = kids.get(parent);
      if (list) list.push(e);
      else kids.set(parent, [e]);
    }
  };
  const children = (dir) => {
    cover(dir);
    return kids.get(dir) ?? [];
  };
  const subtree = (dir) => {
    const out = [];
    const stack = [dir];
    while (stack.length) {
      for (const e of children(stack.pop())) {
        out.push(e);
        if (e.type === "dir") stack.push(e.path);
      }
    }
    return out;
  };
  const globs = boundary.map(normalizeEntry).filter(isGlob);
  const fenced = (abs) => inGitDir(relativeTo(root, abs) ?? "") || denied.some((d) => within(d, abs));
  const canHold = (abs) => globs.some((g) => globCanHold(g, relativeTo(root, abs) ?? ""));
  // Mount points below the root. A grant on a directory reaches through a mount under it, to
  // a tree nobody looked at when the ruleset was built; when they cannot be read, every
  // directory counts as holding one.
  const allMounts = io.mounts();
  const mounts = allMounts && allMounts.filter((m) => m !== root && within(root, m));
  const holdsMount = (dir) => mounts === null || mounts.some((m) => within(dir, m));
  // A directory is clean when every existing entry in it that is not a directory is a regular
  // file inside the boundary with one link, a glob entry could hold a file under each of its
  // existing subdirectories, and no mount point is at or under it: a `dirs` grant reaches the
  // whole tree and can delete in it, so there it makes no existing file writable or removable
  // that was not agreed, and lets new files appear only where the boundary could have them. A
  // symlink, FIFO, socket or device, an entry that cannot be looked at, and a directory that
  // cannot be listed all make it dirty. (.git and the denied paths are left to the
  // notExpressible checks below; everything under a fenced path is fenced too, so its subtree
  // needs no look.) The worktree root is never clean: it holds .git, so a glob at the root is
  // granted per file there and per directory below. Computed bottom-up, once per directory.
  /** @type {Map<string, boolean>} */
  const cleanness = new Map([[root, false]]);
  const clean = (dir) => {
    let c = cleanness.get(dir);
    if (c === undefined) {
      c = !holdsMount(dir) && children(dir).every((e) => fenced(e.path)
        || (e.type === "dir" ? canHold(e.path) && clean(e.path) : e.type === "file" && e.nlink === 1 && matches(e.path)));
      cleanness.set(dir, c);
    }
    return c;
  };
  /** Directories wanted for existing files, and ones wanted only so a missing path can be made. */
  const forExisting = new Set();
  const forCreating = new Set();
  const wantDir = (dir, makeDir, creating = false) => {
    if (!clean(dir)) return;
    wantDirs.set(dir, (wantDirs.get(dir) ?? false) || makeDir);
    (creating ? forCreating : forExisting).add(dir);
  };
  /** Boundary entries naming a path that does not exist yet: entry -> that path. */
  const missing = new Map();
  /** Glob entries that could hold a file directly in the root, which no grant can create. */
  const atRoot = new Set();
  const literal = (abs, entry) => {
    if (!grantable(abs)) return;
    checkNoSymlinkAbove(root, abs, io);
    const st = io.lstat(abs);
    if (st?.type === "file") wantFiles.add(abs);
    else if (st === null && entry !== undefined) missing.set(entry, abs);
  };
  for (const raw of boundary) {
    const e = normalizeEntry(raw);
    if (!isGlob(e)) { literal(`${root}/${e}`, raw); continue; }
    const fixed = [];
    for (const seg of e.split("/")) { if (isGlob(seg)) break; fixed.push(seg); }
    const top = fixed.length ? `${root}/${fixed.join("/")}` : root;
    if (top !== root && !grantable(top)) continue;
    if (top === root && e.split("/").slice(0, -1).every((seg) => seg === "**")) atRoot.add(raw);
    const makeDir = e.split("/").includes("**");
    checkNoSymlinkAbove(root, top, io);
    const st = io.lstat(top);
    if (st === null) {
      missing.set(raw, top);
      const at = deepestExistingL(top, root, io);
      if (at !== null && io.lstat(at)?.type === "dir") wantDir(at, true, true);
      continue;
    }
    if (st.type === "symlink") throw new Error(`${top} is a symlink; pair_run grants only paths that are what they name`);
    if (st.type !== "dir") continue;
    for (const f of subtree(top)) if (f.type === "file" && matches(f.path)) wantFiles.add(f.path);
    const descend = (dir) => {
      if (!globCanHold(e, relativeTo(root, dir) ?? "")) return;
      if (clean(dir)) { wantDir(dir, makeDir); return; }
      for (const c of children(dir)) if (c.type === "dir" && grantable(c.path)) descend(c.path);
    };
    descend(top);
  }
  for (const p of extraAllow) literal(bwrapPath(p));
  // A grant wanted only to make a missing path, where it would hold a .git, the state directory
  // or a protected path, is dropped rather than failing the run: the run goes ahead without it,
  // and its note names the paths it cannot make (pair_write can). The root is never wanted.
  for (const d of forCreating) {
    if (forExisting.has(d)) continue;
    const hasGit = subtree(d).some((e) => e.path.split("/").at(-1).toLowerCase() === ".git");
    if (hasGit || denied.some((x) => within(d, x))) wantDirs.delete(d);
  }
  const dirs = outermost([...wantDirs.keys()]);
  for (const d of dirs) {
    if (within(d, root)) return { notExpressible: "a directory grant would hold the whole worktree, and Landlock cannot fence .git or the state inside it" };
    const below = subtree(d);
    const git = below.find((e) => e.path.split("/").at(-1).toLowerCase() === ".git");
    if (git) return { notExpressible: `a directory grant on ${relativeTo(root, d)} would hold ${relativeTo(root, git.path)}, and Landlock cannot fence it inside the grant` };
    const held = denied.find((x) => within(d, x));
    if (held) return { notExpressible: `a directory grant on ${relativeTo(root, d)} would hold ${held}, and Landlock cannot fence it inside the grant` };
  }
  const granted = new Set(dirs);
  const inGrant = (f) => {
    for (let p = f.slice(0, f.lastIndexOf("/")); p; p = p.slice(0, p.lastIndexOf("/"))) if (granted.has(p)) return true;
    return false;
  };
  const outFiles = [...wantFiles].filter((f) => !inGrant(f)).sort();
  for (const f of outFiles) {
    const n = io.lstat(f)?.nlink ?? 1;
    if (n > 1) return { notExpressible: `${relativeTo(root, f)} has ${n} hard links, and a grant on it would reach every one` };
  }
  // A missing path can be made where a grant holds it: in the grant's own directory, or below
  // it where the grant has make_dir.
  const makeable = (abs) => {
    for (let p = abs.slice(0, abs.lastIndexOf("/")); p; p = p.slice(0, p.lastIndexOf("/"))) {
      if (granted.has(p)) return wantDirs.get(p) || abs.lastIndexOf("/") === p.length;
    }
    return false;
  };
  const uncreatable = [...new Set(boundary)].filter((raw) => atRoot.has(raw) || (missing.has(raw) && !makeable(missing.get(raw))));
  return {
    files: [...files, ...outFiles],
    dirs: dirs.sort().map((path) => ({ path, make_dir: wantDirs.get(path), remove: true })),
    rw_trees: rwTrees,
    ...(uncreatable.length ? { uncreatable } : {}),
  };
}

/**
 * Whether a file matching the glob boundary entry `entry` could lie under the
 * worktree-relative directory `dirRel` ("" for the root), at any depth.
 * @param {string} entry  normalized
 * @param {string} dirRel
 */
function globCanHold(entry, dirRel) {
  const g = entry.split("/");
  const d = dirRel === "" ? [] : dirRel.split("/");
  const seg = (s, name) => globRegex(s).test(name);
  const m = (i, j) => {
    if (j === g.length) return false;
    if (g[j] === "**") return i === d.length || m(i, j + 1) || m(i + 1, j);
    if (i === d.length) return true;
    return seg(g[j], d[i]) && m(i + 1, j + 1);
  };
  return m(0, 0);
}

/**
 * The pair-landlock ruleset and command pair_write and pair_edit write under on Linux. Most
 * writes go in place, the content passing through the helper's stdin:
 *   - an existing target: a `files` grant on it alone, and `/bin/cat > target`. The rule is on
 *     the target's inode, and the helper refuses an inode with a second name, so the write can
 *     reach no file but the target;
 *   - a target that does not exist yet: a `dirs` grant on its deepest existing directory
 *     (MAKE_DIR when directories are missing), and a create with noclobber, so a file or a
 *     symlink that appears at the target in the meantime fails the write rather than takes it;
 *   - a target that does not exist yet where that grant would hold the worktree root, a
 *     `.git`, the state directory or a protected path: `create` names the missing directories
 *     and the empty file the caller makes on the host first (lib/host-io.mjs createOnHost,
 *     which follows no link), and the write then goes in place through a `files` grant on it.
 * A target that is a symlink or has a second hard link would be followed by an in-place
 * write, so it gets the staged write instead (`staged`, no `command`: the caller runs its own
 * staging script, the one Seatbelt and bubblewrap run): a `dirs` grant with `remove` on the
 * target's directory, where the content goes to a new temp file that is renamed over the
 * target, replacing the link rather than writing through it. The grant is wide, but the only
 * command under it is that script.
 * A target outside the boundary, or in .git, the state directory or a protected path, gets no
 * grant at all: the kernel refuses the write, as the Seatbelt profile does.
 * Returns { notExpressible: reason } for anything but a regular file or a link, or when the
 * staged write's `dirs` grant would hold the worktree root, a `.git`, the state directory or a
 * protected path.
 * Throws when the target is a directory or a path above it is a symlink inside the worktree.
 * Open phase only.
 * @param {State} state
 * @param {string} target  absolute, checkWrite's absPath
 * @param {LandlockIo} io
 * @returns {(LandlockRules & ({ command: string, create?: { dirs: string[], file: string } } | { staged: true })) | { notExpressible: string }}
 */
export function pairWriteLandlock(state, target, io) {
  if (state.phase !== "open") throw new Error("pair_write needs an open change set");
  const root = bwrapPath(state.root);
  const abs = bwrapPath(target);
  if (!within(root, abs) || abs === root || abs.split("/").some((s) => s === "." || s === "..")) throw new Error("pair_write needs a target inside the worktree");
  const denied = [state.stateDir, ...(state.protect ?? [])].map(bwrapPath);
  const rel = relativeTo(root, abs);
  checkNoSymlinkAbove(root, abs, io);
  const st = io.lstat(abs);
  if (st?.type === "dir") throw new Error("the target is a directory");
  const parent = abs.slice(0, abs.lastIndexOf("/"));
  const inBoundary = !inGitDir(rel) && !denied.some((d) => within(d, abs)) && boundaryMatches(state.changeSet.boundary, rel) && !isGitControl(rel);
  const create = `set -C && /bin/mkdir -p -- ${shQuote(parent)} && /bin/cat > ${shQuote(abs)}`;
  if (!inBoundary) return { files: [], dirs: [], rw_trees: [], command: st === null ? create : `/bin/cat > ${shQuote(abs)}` };
  /** Why a `dirs` grant on `dir` cannot be given, or null. */
  const grantProblem = (dir, what) => {
    if (dir === root) return `${what} needs a grant on the worktree root, which would hold .git`;
    const git = io.walk(dir).find((e) => e.path.split("/").at(-1).toLowerCase() === ".git");
    if (git) return `${what} needs a grant on ${relativeTo(root, dir)}, which would hold ${relativeTo(root, git.path)}`;
    const held = denied.find((d) => within(dir, d));
    return held ? `${what} needs a grant on ${relativeTo(root, dir)}, which would hold ${held}` : null;
  };
  if (st && (st.type === "symlink" || (st.type === "file" && st.nlink > 1))) {
    const what = st.type === "symlink" ? "the target is a symlink, and the staged write that replaces it" : `the target has ${st.nlink} hard links, and the staged write that replaces it`;
    const problem = grantProblem(parent, what);
    return problem ? { notExpressible: problem } : { files: [], dirs: [{ path: parent, make_dir: false, remove: true }], rw_trees: [], staged: true };
  }
  if (st && st.type !== "file") return { notExpressible: "the target is not a regular file" };
  if (st) return { files: [abs], dirs: [], rw_trees: [], command: `/bin/cat > ${shQuote(abs)}` };
  const at = deepestExistingL(abs, root, io);
  if (at === null || io.lstat(at)?.type !== "dir") throw new Error(`no directory to create ${rel} in`);
  if (grantProblem(at, "a new file here")) {
    const dirs = [];
    for (let p = parent; p !== at; p = p.slice(0, p.lastIndexOf("/"))) dirs.unshift(p);
    return { files: [abs], dirs: [], rw_trees: [], command: `/bin/cat > ${shQuote(abs)}`, create: { dirs, file: abs } };
  }
  return { files: [], dirs: [{ path: at, make_dir: at !== parent, remove: false }], rw_trees: [], command: create };
}

/** A POSIX shell single-quoted word. */
export function shQuote(s) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function deepestExistingL(path, stop, io) {
  let p = path;
  while (p !== stop && io.lstat(p) === null) p = p.slice(0, p.lastIndexOf("/")) || "/";
  return io.lstat(p) === null ? null : p;
}

/**
 * Throws when a directory between the worktree root and `abs` is a symlink. pair-landlock
 * takes only paths that are their own realpath, so such a path would fail there anyway; the
 * message here says why.
 */
function checkNoSymlinkAbove(root, abs, io) {
  const rel = relativeTo(root, abs);
  if (rel === null) return;
  let p = root;
  for (const seg of rel.split("/").slice(0, -1)) {
    p = `${p}/${seg}`;
    const st = io.lstat(p);
    if (st === null) return;
    if (st.type === "symlink") throw new Error(`${p} is a symlink; pair_run grants only paths that are what they name`);
  }
}
