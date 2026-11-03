// A closed lane's folder offsite on Drive (PLAN wl-mw14khl4uf388q, "Archive and records", "Offsite lock", "Restore",
// "Writers that can recreate the folder"): the lane marker, the content manifest, the offsite lock, the log-path helper
// and `as2 lane restore <wl> [--to <dir>] [--deadline <s>]`.
//
// The lane marker is one JSON file `~/.agent-system-2/lanes/<wl>.offsite` (OffsiteMarker), written temp + fsync + rename,
// so every transition is one atomic rename. Its content manifest (ContentEntry[], sorted by path) is read from an extracted
// copy of the lane tar with scratch-archive.ts `readManifest` (hashes on), reduced to path, type, size, mode, sha256 and
// link target, and compared with `contentDiff`.
//
// The offsite lock is `lanes/.offsite.lock`: flock(fd, LOCK_EX | LOCK_NB) through bun:ffi on the C library, the
// descriptor held by the mutating process for its whole run. The kernel drops it on the last close of that descriptor
// (the process's end, or a child's that inherited it), so there is no stale state and no takeover. A holder makes the
// other side refuse at once: restore exits OFFSITE_LOCK_BUSY_EXIT (75).
//
// Restore copies the tar from Drive with `cp -n` (alone, or the envelope then its member extracted) into a private staging
// dir, checks its sha256 against the marker and the receipt (a missing receipt is reported; the marker's sha256 still
// gates; for an envelope the member's sha256, never the envelope's), extracts it and checks every entry against the
// marker's manifest, nothing extra. `--to <dir>` then renames the tree to `<dir>/<wl>`: no lock, nothing under the lanes
// root and no record touched. In place, under the offsite lock, one reconciliation for every marker state:
//   (0) plan the moves: `lanes/<wl>` when present and different from the manifest, each `.removing-<wl>-*`, each
//       `stranded` path, de-duplicated by real path, each to `lanes/.<wl>.restore-leftover-<stamp>-<n>`; written into
//       the marker as `leftovers: [{from, to, done}]` in one rewrite, unless a list is already there (reused as is);
//   (1) each move not done, in order: from present and to absent -> rename, then the marker rewritten with it done;
//       from absent and to present (killed between the two) -> marked done; both or neither present -> a failure naming
//       both, the marker kept. A done move is never looked at again;
//   (2) only then: `lanes/<wl>` absent -> the verified tree renamed into place; present and equal to the manifest ->
//       kept (an earlier run published it); present and different -> a failure, the marker kept;
//   (3) the lane-archive record carrying the marker's tar_sha256 (pending or done) moves to `restored/`;
//   (4) the marker renamed to `<wl>.offsite.restored-<stamp>`, one rename.
// Leftovers are named for a person and never removed. A rerun after a kill at any step replays the same sequence from
// the marker's list. The copy, the envelope extract, the tar extract and the hashing each run through the step runner
// under a deadline (default RESTORE_DEADLINE_S) that kills the step's process group; the copy logs its bytes every
// COPY_PROGRESS_MS; the in-process manifest hashing runs under the same deadline on the injected clock. A staging
// cleanup failure is reported beside the original error.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Subprocess } from "bun";
import { dlopen, FFIType, read } from "bun:ffi";
import { contentDiff, type Manifest, type ManifestEntry, type ProgressCheck, readManifest, removeCopy } from "./scratch-archive";
import { REMOVING_PREFIX } from "./scratch-remove";
import { laneDir } from "./launch";

/** The marker's name beside the lane folder: `lanes/<wl>.offsite`. */
export const OFFSITE_MARKER_SUFFIX = ".offsite";
/** The offsite lock's file name under the lanes root. */
export const OFFSITE_LOCK_NAME = ".offsite.lock";
/** Restore's exit while another retire or restore holds the offsite lock (EX_TEMPFAIL). */
export const OFFSITE_LOCK_BUSY_EXIT = 75;
/** The lane-archive records' directory (`<wl>.json`, `done/`, `restored/`, …); default `laneArchiveStateDir`. */
export const LANE_ARCHIVE_STATE_ENV = "AS2_LANE_ARCHIVE_STATE";
/** Test seam: `<point>[@<n>]` makes a restore SIGKILL itself right after the n-th (default first) time it passes <point>. */
export const RESTORE_KILL_ENV = "AS2_LANE_RESTORE_KILL_AT";
/** The default deadline of each restore step, in seconds (`--deadline <s>`). */
export const RESTORE_DEADLINE_S = 3600;
/** How often the Drive copy logs its bytes copied. */
export const COPY_PROGRESS_MS = 30_000;
/** Where restore's kill hook can fire, in the order a full in-place run passes them. */
export const RESTORE_KILL_POINTS = ["leftovers-planned", "leftover-renamed", "leftover-marked", "published", "record-settled"] as const;
export type RestoreKillPoint = (typeof RESTORE_KILL_POINTS)[number];

const RESTORE_STAGING_PREFIX = ".restore-";
const WL_RE = /^wl-[0-9a-z]+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- paths ------------------------------------------------------------------------------------------

/** `~/.agent-system-2/lanes`: the directory holding every lane folder, marker and the offsite lock. */
export function lanesRoot(home: string): string {
	return dirname(laneDir("wl-x", home));
}

/** `lanes/<wl>.offsite`. */
export function markerPath(wl: string, home: string): string {
	return join(lanesRoot(home), `${wl}${OFFSITE_MARKER_SUFFIX}`);
}

/** Whether `lanes/<wl>.offsite` exists (any state). Throws when its presence cannot be read. */
export function hasMarker(wl: string, home: string): boolean {
	return present(markerPath(wl, home));
}

/** `lanes/.offsite.lock`. */
export function offsiteLockPath(home: string): string {
	return join(lanesRoot(home), OFFSITE_LOCK_NAME);
}

/**
 * Where a post-exit writer puts its `<name>.log`: `lanes/<wl>/<name>.log`, or `lanes/<wl>.<name>.log` when the lane marker
 * exists, so the writer never recreates an offsite lane's folder.
 */
export function logPathFor(wl: string, name: string, home: string): string {
	return hasMarker(wl, home) ? join(lanesRoot(home), `${wl}.${name}.log`) : join(laneDir(wl, home), `${name}.log`);
}

/** The lane-archive records' directory: AS2_LANE_ARCHIVE_STATE, else `lane-archives` in the nightly's state dir. */
export function laneArchiveStateDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
	return env[LANE_ARCHIVE_STATE_ENV]?.trim() || join(home, "agent-scratch", "agent-system-2.0", "drive-backup", "state", "lane-archives");
}

/** Whether something (a link included, never followed) is at `path`; any error but ENOENT is thrown. */
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}

/** `20261103T201500Z`: a UTC stamp for leftover and retired-marker names. */
function stampOf(ms: number): string {
	return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// ---- the content manifest --------------------------------------------------------------------------

/** One entry of a lane tar's content: no inode, device or time fields. `path` is "" for the top directory. */
export interface ContentEntry {
	path: string;
	type: "file" | "dir" | "link";
	size: number;
	mode: number;
	sha256: string | null;
	target: string | null;
}

/** `dir`'s content manifest (scratch-archive.ts `readManifest`, hashes on), sorted by path. `check` is a progress deadline. */
export function contentManifest(dir: string, check: ProgressCheck = () => {}): ContentEntry[] {
	const out: ContentEntry[] = [];
	for (const [path, e] of readManifest(dir, true, check)) out.push({ path, type: e.type, size: e.size, mode: e.mode, sha256: e.sha256, target: e.target });
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A content manifest as a scratch-archive Manifest (identity and time fields zero), for `contentDiff`. */
export function manifestOf(entries: readonly ContentEntry[]): Manifest {
	const m: Manifest = new Map();
	for (const e of entries) {
		const entry: ManifestEntry = { type: e.type, size: e.size, mode: e.mode, sha256: e.sha256, target: e.target, dev: 0n, ino: 0n, mtimeNs: 0n, ctimeNs: 0n };
		m.set(e.path, entry);
	}
	return m;
}

/** What differs between two content manifests (`contentDiff`: entry set, type, size, mode, sha256, target); empty when equal. */
export function compareContent(expected: readonly ContentEntry[], actual: readonly ContentEntry[], expectedName = "the marker's manifest", actualName = "the tree", limit = 3): string[] {
	return contentDiff(manifestOf(expected), manifestOf(actual), expectedName, actualName, limit);
}

// ---- the marker -------------------------------------------------------------------------------------

export type MarkerState = "retiring" | "offsite";

/** One planned move of restore's step (0): `from` to `to`, `done` once the rename is recorded. */
export interface Leftover {
	from: string;
	to: string;
	done: boolean;
}

/**
 * `lanes/<wl>.offsite`. Proof keys: `drive_path` (with `drive_item_id`, `drive_revision`) for a tar uploaded alone, or
 * `envelope_drive_path` + `member` + `member_sha256` for one inside an envelope; `receipt` is the receipt file's path.
 */
export interface OffsiteMarker {
	workload: string;
	state: MarkerState;
	/** The local lane archive the producer wrote (`<archive root>/<date>/<wl>.lane[.<n>].tar.gz`). */
	lane_archive: string;
	tar_sha256: string;
	drive_path?: string;
	drive_item_id?: string;
	drive_revision?: string;
	envelope_drive_path?: string;
	member?: string;
	member_sha256?: string;
	receipt: string | null;
	content: ContentEntry[];
	/** Every leftover path of an interrupted retire (empty when none). */
	stranded: string[];
	leftovers?: Leftover[];
	lane_deleted_at?: string;
	restore?: string;
}

/** The text `as2 lane restore` names. */
export const restoreCommand = (wl: string): string => `as2 lane restore ${wl}`;

/** Parse and check a marker's JSON; throws naming `where` and the first thing wrong. */
export function parseMarker(text: string, where: string): OffsiteMarker {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		throw new Error(`${where} is not JSON (${message(e)})`);
	}
	const bad = (what: string): Error => new Error(`${where}: ${what}`);
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad("not a JSON object");
	const o = v as Record<string, unknown>;
	const str = (k: string): string => {
		if (typeof o[k] !== "string" || o[k] === "") throw bad(`${k} is not a non-empty string`);
		return o[k] as string;
	};
	const optStr = (k: string): string | undefined => (o[k] === undefined ? undefined : str(k));
	const workload = str("workload");
	const state = str("state");
	if (state !== "retiring" && state !== "offsite") throw bad(`state is ${JSON.stringify(state)}, not retiring or offsite`);
	const tar = str("tar_sha256");
	if (!SHA_RE.test(tar)) throw bad("tar_sha256 is not 64 lowercase hex digits");
	if (o.receipt !== null && typeof o.receipt !== "string") throw bad("receipt is neither a path nor null");
	if (!Array.isArray(o.content) || o.content.length === 0) throw bad("content is not a non-empty array");
	const content = o.content.map((c, i): ContentEntry => {
		const e = c as Record<string, unknown>;
		const ok = typeof e === "object" && e !== null && typeof e.path === "string" && (e.type === "file" || e.type === "dir" || e.type === "link")
			&& typeof e.size === "number" && typeof e.mode === "number" && (e.sha256 === null || (typeof e.sha256 === "string" && SHA_RE.test(e.sha256)))
			&& (e.target === null || typeof e.target === "string") && (e.type !== "file" || e.sha256 !== null) && (e.type !== "link" || e.target !== null);
		if (!ok) throw bad(`content[${i}] is not {path, type, size, mode, sha256, target} (a file with a sha256, a link with a target)`);
		return { path: e.path as string, type: e.type as ContentEntry["type"], size: e.size as number, mode: e.mode as number, sha256: e.sha256 as string | null, target: e.target as string | null };
	});
	if (!Array.isArray(o.stranded) || o.stranded.some((s) => typeof s !== "string" || s === "")) throw bad("stranded is not an array of paths");
	let leftovers: Leftover[] | undefined;
	if (o.leftovers !== undefined) {
		if (!Array.isArray(o.leftovers)) throw bad("leftovers is not an array");
		leftovers = o.leftovers.map((l, i): Leftover => {
			const e = l as Record<string, unknown>;
			if (typeof e !== "object" || e === null || typeof e.from !== "string" || typeof e.to !== "string" || typeof e.done !== "boolean") throw bad(`leftovers[${i}] is not {from, to, done}`);
			return { from: e.from, to: e.to, done: e.done };
		});
	}
	const m: OffsiteMarker = {
		workload, state, lane_archive: str("lane_archive"), tar_sha256: tar, receipt: o.receipt as string | null, content, stranded: o.stranded as string[],
	};
	for (const k of ["drive_path", "drive_item_id", "drive_revision", "envelope_drive_path", "member", "member_sha256", "lane_deleted_at", "restore"] as const) {
		const s = optStr(k);
		if (s !== undefined) m[k] = s;
	}
	if (leftovers !== undefined) m.leftovers = leftovers;
	if (m.drive_path === undefined) {
		if (m.envelope_drive_path === undefined || m.member === undefined || m.member_sha256 === undefined) {
			throw bad("no proof keys: neither drive_path nor envelope_drive_path with member and member_sha256");
		}
		if (!SHA_RE.test(m.member_sha256)) throw bad("member_sha256 is not 64 lowercase hex digits");
	}
	return m;
}

/** Read and check the marker at `path`; throws naming it and what is wrong. */
export function readMarker(path: string): OffsiteMarker {
	return parseMarker(readFileSync(path, "utf8"), path);
}

/** fsync a directory, so a rename in it is durable. */
function fsyncDir(dir: string): void {
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write the marker at `path`: a sibling temp file, fsync, rename over `path`, fsync the directory. */
export function writeMarker(path: string, m: OffsiteMarker): void {
	const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(m, null, "\t")}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (e) {
		const also: string[] = [];
		try {
			if (present(tmp)) unlinkSync(tmp);
		} catch (e2) {
			also.push(`; its temp file ${tmp} is left (${message(e2)})`);
		}
		throw new Error(`the marker ${path} could not be written (${message(e)})${also.join("")}`);
	}
	fsyncDir(dirname(path));
}

// ---- the offsite lock -------------------------------------------------------------------------------

const LOCK_EX = 2;
const LOCK_NB = 4;

interface FlockApi {
	flock: (fd: number, op: number) => number;
	errno: () => number;
	wouldBlock: number;
}
let flockApi: FlockApi | null = null;

/** flock(2) and errno through bun:ffi: libSystem on macOS, glibc on Linux; any other platform throws. */
function flockOf(): FlockApi {
	if (flockApi) return flockApi;
	if (process.platform === "darwin") {
		const lib = dlopen("/usr/lib/libSystem.B.dylib", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			__error: { args: [], returns: FFIType.ptr },
		});
		flockApi = { flock: (fd, op) => lib.symbols.flock(fd, op), errno: () => read.i32(lib.symbols.__error()!, 0), wouldBlock: 35 };
	} else if (process.platform === "linux") {
		const lib = dlopen("libc.so.6", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			__errno_location: { args: [], returns: FFIType.ptr },
		});
		flockApi = { flock: (fd, op) => lib.symbols.flock(fd, op), errno: () => read.i32(lib.symbols.__errno_location()!, 0), wouldBlock: 11 };
	} else {
		throw new Error(`the offsite lock needs flock(2) through bun:ffi, which this module binds only on darwin and linux, not ${process.platform}`);
	}
	return flockApi;
}

export type OffsiteLock = { kind: "held"; path: string; release: () => void } | { kind: "busy"; path: string };

/**
 * Take the offsite lock (`lanes/.offsite.lock`, flock LOCK_EX | LOCK_NB): `held` with its release (the descriptor's
 * close), or `busy` when another process holds it (EWOULDBLOCK). Any other failure throws, naming the file and errno.
 */
export function acquireOffsiteLock(home: string): OffsiteLock {
	const path = offsiteLockPath(home);
	const api = flockOf();
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a", 0o600);
	let r: number;
	let errno = 0;
	try {
		r = api.flock(fd, LOCK_EX | LOCK_NB);
		if (r !== 0) errno = api.errno();
	} catch (e) {
		closeSync(fd);
		throw new Error(`flock on ${path} could not be called (${message(e)})`);
	}
	if (r === 0) {
		let open = true;
		return {
			kind: "held", path, release: () => {
				if (!open) return;
				open = false;
				closeSync(fd);
			},
		};
	}
	closeSync(fd);
	if (errno === api.wouldBlock) return { kind: "busy", path };
	throw new Error(`flock(${path}, LOCK_EX | LOCK_NB) failed with errno ${errno}; the offsite lock was not taken`);
}

// ---- the step runner --------------------------------------------------------------------------------

/** One external step: its argv, a deadline that kills its process group, and, for a copy, a progress line. */
export interface Step {
	what: string;
	argv: string[];
	deadlineMs: number;
	/** Called every COPY_PROGRESS_MS while the step runs; its text is logged after `<what>: `. */
	progress?: () => string;
}
export type StepResult = { ok: true; stdout: string } | { ok: false; reason: string };
export type StepRunner = (step: Step) => Promise<StepResult>;
/** The runner's clock seam: run `fn` after `ms`, returning its cancel. */
export interface StepTimers {
	after: (ms: number, fn: () => void) => () => void;
}
export const REAL_TIMERS: StepTimers = {
	after: (ms, fn) => {
		const t = setTimeout(fn, ms);
		return () => clearTimeout(t);
	},
};

/**
 * The runner restore's external steps go through: each step in its own process group (`detached`), SIGKILLed as a group
 * once `deadlineMs` passes on `timers`, with `progress` logged every `progressEveryMs`. A step past its deadline fails
 * naming the deadline; a non-zero exit fails naming the command, its exit and the first line of its stderr.
 */
export function stepRunner(o: { log: (line: string) => void; timers?: StepTimers; progressEveryMs?: number }): StepRunner {
	const timers = o.timers ?? REAL_TIMERS;
	const every = o.progressEveryMs ?? COPY_PROGRESS_MS;
	return async (s) => {
		let child: Subprocess<"ignore", "pipe", "pipe">;
		try {
			const env: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
			// macOS bsdtar would otherwise add AppleDouble `._*` members; none of these steps creates a tar, but cp and tar agree.
			env.COPYFILE_DISABLE = "1";
			child = Bun.spawn(s.argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env });
		} catch (e) {
			return { ok: false, reason: `${s.what}: ${s.argv[0]} could not be started (${message(e)})` };
		}
		const pid = child.pid;
		let timedOut = false;
		const killNotes: string[] = [];
		const cancelDeadline = timers.after(s.deadlineMs, () => {
			timedOut = true;
			try {
				process.kill(-pid, "SIGKILL");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ESRCH") return; // the group already ended on its own
				killNotes.push(`killing its process group ${pid} failed (${message(e)}), so the step's own process was killed`);
				child.kill("SIGKILL");
			}
		});
		let cancelProgress = (): void => {};
		if (s.progress) {
			const tick = (): void => {
				o.log(`${s.what}: ${s.progress!()}`);
				cancelProgress = timers.after(every, tick);
			};
			cancelProgress = timers.after(every, tick);
		}
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		cancelDeadline();
		cancelProgress();
		if (timedOut) {
			return { ok: false, reason: `${s.what} passed its ${Number((s.deadlineMs / 1000).toFixed(3))} s deadline; its process group ${pid} (${s.argv.join(" ")}) was killed${killNotes.length ? `; ${killNotes.join("; ")}` : ""}` };
		}
		if (code !== 0) return { ok: false, reason: `${s.what}: ${s.argv.join(" ")} exited ${code ?? child.signalCode}: ${err.trim().split("\n")[0] || "no message"}` };
		return { ok: true, stdout: out };
	};
}

/** `<what>: n bytes of m copied to <dst>` for a running copy. */
function copyProgress(src: string, dst: string): () => string {
	let total = "an unknown number of";
	try {
		total = String(statSync(src).size);
	} catch (e) {
		total = `an unknown number of (the source cannot be read: ${message(e)})`;
	}
	return () => {
		try {
			return `${statSync(dst).size} bytes of ${total} copied to ${dst}`;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return `0 bytes of ${total} copied to ${dst} (not created yet)`;
			return `the copy ${dst} cannot be read (${message(e)})`;
		}
	};
}

// ---- restore ----------------------------------------------------------------------------------------

/** A restore failure: its exit code and the message naming the step, the path and what differed. */
export class RestoreError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

export interface RestoreOptions {
	wl: string;
	home: string;
	/** The lane-archive records' directory (`laneArchiveStateDir`). */
	stateDir: string;
	/** `--to <dir>`: restore into `<dir>/<wl>`; no lock, nothing under the lanes root or the records touched. */
	to?: string | null;
	/** Each step's deadline (default RESTORE_DEADLINE_S seconds). */
	deadlineMs?: number;
	log: (line: string) => void;
	/** The external steps' runner (default `stepRunner` on real timers). */
	run?: StepRunner;
	/** The clock of the stamps and of the in-process hashing deadline (default Date.now). */
	clock?: () => number;
	/** The kill hook (`restoreKillHook`), called at each RESTORE_KILL_POINTS point. */
	kill?: (point: RestoreKillPoint) => void;
}

/** The kill hook a `<point>[@<n>]` value (RESTORE_KILL_ENV) names, or undefined when unset; a bad value throws. */
export function restoreKillHook(value: string | undefined): ((point: RestoreKillPoint) => void) | undefined {
	if (value === undefined || value === "") return undefined;
	const m = /^([a-z-]+)(?:@([1-9]\d*))?$/.exec(value);
	if (!m || !(RESTORE_KILL_POINTS as readonly string[]).includes(m[1]!)) {
		throw new Error(`${RESTORE_KILL_ENV}=${value} is not <point>[@<n>] with a point among ${RESTORE_KILL_POINTS.join(", ")}`);
	}
	const want = Number(m[2] ?? "1");
	let seen = 0;
	return (point) => {
		if (point !== m[1]) return;
		seen += 1;
		if (seen === want) process.kill(process.pid, "SIGKILL");
	};
}

/** A `key=value` receipt's `sha256`, or what is wrong with it. */
function receiptSha(path: string): { sha: string } | { missing: true } | { error: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
		return { error: `the receipt ${path} cannot be read (${message(e)})` };
	}
	const line = text.split("\n").find((l) => l.startsWith("sha256="));
	if (!line) return { error: `the receipt ${path} has no sha256= line` };
	return { sha: line.slice("sha256=".length).trim() };
}

/** Paths in `root` whose name is `.restore-<wl>-<12 hex>`: staging dirs of earlier restores. */
function stagingDirsOf(root: string, wl: string): string[] {
	if (!present(root)) return [];
	const re = new RegExp(`^${RESTORE_STAGING_PREFIX.replace(".", "\\.")}${wl}-[0-9a-f]{12}$`);
	return readdirSync(root).filter((n) => re.test(n)).map((n) => join(root, n));
}

/** `lanes/.removing-<wl>-<hex>` entries: trees an interrupted retire detached. */
function removingOf(root: string, wl: string): string[] {
	const re = new RegExp(`^${REMOVING_PREFIX.replace(".", "\\.")}${wl}-[0-9a-f]+$`);
	return readdirSync(root).filter((n) => re.test(n)).map((n) => join(root, n));
}

/** The real path of an entry without following the entry itself: its parent's real path and its own name. */
function entryRealPath(path: string): string {
	return join(realpathSync(dirname(path)), basename(path));
}

interface Ctx {
	wl: string;
	/** The marker's path, for messages. */
	mpath: string;
	log: (line: string) => void;
	run: StepRunner;
	deadlineMs: number;
	clock: () => number;
	kill: (point: RestoreKillPoint) => void;
}

/** A progress check failing once `deadlineMs` has passed on the clock since it was made. */
function hashingDeadline(c: Ctx, what: string): ProgressCheck {
	const end = c.clock() + c.deadlineMs;
	return (step) => {
		if (c.clock() > end) throw new Error(`${what} passed its ${Number((c.deadlineMs / 1000).toFixed(3))} s deadline at ${step}`);
	};
}

/** The content manifest of `dir` under the hashing deadline, its diff against the marker's. */
function diffFromMarker(c: Ctx, m: OffsiteMarker, dir: string, name: string): string[] {
	return compareContent(m.content, contentManifest(dir, hashingDeadline(c, `hashing ${dir}`)), "the marker's manifest", name);
}

/**
 * Copy the lane tar from Drive into `staging`, check its sha256 and its content against the marker and the receipt, and
 * extract it: the verified tree's path (`<staging>/tree`). Throws RestoreError naming the step, the path and both values.
 */
async function fetchVerified(c: Ctx, m: OffsiteMarker, staging: string): Promise<string> {
	const fail = (text: string): RestoreError => new RestoreError(1, `restore of ${c.wl}: ${text}`);
	const step = async (s: Omit<Step, "deadlineMs">): Promise<string> => {
		const r = await c.run({ ...s, deadlineMs: c.deadlineMs });
		if (!r.ok) throw fail(r.reason);
		return r.stdout;
	};
	const src = m.drive_path ?? m.envelope_drive_path!;
	try {
		if (!statSync(src).isFile()) throw fail(`the Drive copy ${src} is not a file`);
	} catch (e) {
		if (e instanceof RestoreError) throw e;
		throw fail(`the Drive copy ${src} cannot be read (${message(e)})`);
	}
	let tarPath: string;
	if (m.drive_path !== undefined) {
		tarPath = join(staging, "lane.tar.gz");
		c.log(`restore ${c.wl}: copying ${src} from Drive to ${tarPath}`);
		await step({ what: `copying ${src} from Drive`, argv: ["/bin/cp", "-n", src, tarPath], progress: copyProgress(src, tarPath) });
	} else {
		const envelope = join(staging, "envelope.tar");
		c.log(`restore ${c.wl}: copying the envelope ${src} from Drive to ${envelope}`);
		await step({ what: `copying the envelope ${src} from Drive`, argv: ["/bin/cp", "-n", src, envelope], progress: copyProgress(src, envelope) });
		const memberDir = join(staging, "member");
		mkdirSync(memberDir, { mode: 0o700 });
		await step({ what: `extracting ${m.member} from the envelope ${envelope}`, argv: ["tar", "-xf", envelope, "-C", memberDir, m.member!] });
		tarPath = join(memberDir, m.member!);
	}
	const hashArgv = process.platform === "darwin" ? ["/usr/bin/shasum", "-a", "256", tarPath] : ["sha256sum", tarPath];
	const got = (await step({ what: `hashing ${tarPath}`, argv: hashArgv })).trim().split(/\s+/)[0] ?? "";
	if (!SHA_RE.test(got)) throw fail(`hashing ${tarPath} printed no sha256 (${JSON.stringify(got)})`);
	const from = m.drive_path !== undefined ? src : `member ${m.member} of the envelope ${src}`;
	if (got !== m.tar_sha256) throw fail(`sha256 check: ${tarPath} (from ${from}) has sha256 ${got}, the marker ${c.mpath} says tar_sha256 ${m.tar_sha256}; nothing restored`);
	if (m.member_sha256 !== undefined && got !== m.member_sha256) {
		throw fail(`sha256 check: ${tarPath} (from ${from}) has sha256 ${got}, the marker ${c.mpath} says member_sha256 ${m.member_sha256}; nothing restored`);
	}
	if (m.receipt === null) c.log(`restore ${c.wl}: the marker names no receipt; the marker's sha256 gates the copy`);
	else {
		const r = receiptSha(m.receipt);
		if ("missing" in r) c.log(`restore ${c.wl}: the receipt ${m.receipt} is missing; the marker's sha256 gates the copy`);
		else if ("error" in r) throw fail(`${r.error}; nothing restored`);
		else if (r.sha !== got) throw fail(`sha256 check: ${tarPath} (from ${from}) has sha256 ${got}, the receipt ${m.receipt} says ${r.sha}; nothing restored`);
	}
	c.log(`restore ${c.wl}: sha256 ${got} of ${from} matches the marker${m.receipt !== null && present(m.receipt) ? " and the receipt" : ""}`);
	const tree = join(staging, "tree");
	mkdirSync(tree, { mode: 0o700 });
	await step({ what: `extracting ${tarPath}`, argv: ["tar", "-xzpf", tarPath, "-C", tree] });
	let diff: string[];
	try {
		diff = diffFromMarker(c, m, tree, "the Drive copy");
	} catch (e) {
		throw fail(`reading the extracted copy ${tree}: ${message(e)}`);
	}
	if (diff.length > 0) throw fail(`content check: the Drive copy does not hold the marker's manifest: ${diff.join("; ")}; nothing restored`);
	c.log(`restore ${c.wl}: the Drive copy holds every entry of the marker's manifest (${m.content.length} entries), nothing extra`);
	return tree;
}

/** A fresh private staging dir `<parent>/.restore-<wl>-<12 hex>`. */
function newStaging(parent: string, wl: string): string {
	const dir = join(parent, `${RESTORE_STAGING_PREFIX}${wl}-${randomBytes(6).toString("hex")}`);
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** Remove a staging dir; null when gone, else what was left. */
function dropStaging(dir: string): string | null {
	if (!present(dir)) return null;
	const r = removeCopy(dir);
	return r === null ? null : `the staging dir ${dir} could not be removed (${r})`;
}

/** The original error with a cleanup failure beside it. */
function withCleanup(e: unknown, cleanup: string | null): unknown {
	if (cleanup === null) return e;
	if (e instanceof RestoreError) return new RestoreError(e.code, `${e.message}; also, ${cleanup}`);
	return new Error(`${message(e)}; also, ${cleanup}`);
}

/** A name in `dir` not taken: `<base>`, else `<base>-2`, `<base>-3`, … (`ext` kept last). */
function freeIn(dir: string, base: string, ext = ""): string {
	for (let n = 1; ; n++) {
		const p = join(dir, n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`);
		if (!present(p)) return p;
	}
}

/**
 * Step (3): every lane-archive record of `wl` (in `stateDir` or its `done/`) carrying `sha` moves to `restored/`, under a
 * name not taken there. No record: nothing. A record of `wl` that cannot be read or parsed throws.
 */
function settleRecords(c: Ctx, stateDir: string, sha: string, stamp: string): void {
	let moved = 0;
	for (const dir of [stateDir, join(stateDir, "done")]) {
		if (!present(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!(name === `${c.wl}.json` || (name.startsWith(`${c.wl}.`) && name.endsWith(".json")))) continue;
			const path = join(dir, name);
			let rec: { workload?: unknown; sha256?: unknown };
			try {
				rec = JSON.parse(readFileSync(path, "utf8")) as typeof rec;
			} catch (e) {
				throw new RestoreError(1, `restore of ${c.wl}: the lane-archive record ${path} cannot be read (${message(e)}); the lane is in place, the marker is kept; fix or move the record and run ${restoreCommand(c.wl)} again`);
			}
			if (rec.workload !== c.wl || rec.sha256 !== sha) continue;
			const to = join(stateDir, "restored");
			mkdirSync(to, { recursive: true, mode: 0o700 });
			const dest = present(join(to, name)) ? freeIn(to, `${name.slice(0, -".json".length)}.${stamp}`, ".json") : join(to, name);
			renameSync(path, dest);
			moved += 1;
			c.log(`restore ${c.wl}: the lane-archive record ${path} moved to ${dest}`);
		}
	}
	if (moved === 0) c.log(`restore ${c.wl}: no lane-archive record carries tar_sha256 ${sha} in ${stateDir}; nothing to settle`);
}

/** Steps (0)–(3) of the in-place reconciliation, the marker rewritten at each recorded step. */
function reconcile(c: Ctx, o: RestoreOptions, mpath: string, marker: OffsiteMarker, tree: string): { marker: OffsiteMarker; stamp: string } {
	const root = lanesRoot(o.home);
	const folder = laneDir(c.wl, o.home);
	const stamp = stampOf(c.clock());
	let m = marker;
	const differs = (dir: string): string[] => {
		if (!lstatSync(dir).isDirectory()) return [`${dir} is not a directory`];
		return diffFromMarker(c, m, dir, folder);
	};
	// (0) plan the moves, or reuse a recorded plan as is
	if (m.leftovers === undefined) {
		const candidates: string[] = [];
		if (present(folder)) {
			const d = differs(folder);
			if (d.length > 0) {
				c.log(`restore ${c.wl}: ${folder} differs from the marker's manifest (${d.join("; ")}); it is moved aside`);
				candidates.push(folder);
			}
		}
		candidates.push(...removingOf(root, c.wl));
		for (const s of m.stranded) {
			if (present(s)) candidates.push(s);
			else c.log(`restore ${c.wl}: the stranded path ${s} is absent; nothing to move there`);
		}
		const seen = new Set<string>();
		const leftovers: Leftover[] = [];
		for (const from of candidates) {
			const real = entryRealPath(from);
			if (seen.has(real)) continue;
			seen.add(real);
			let n = leftovers.length + 1;
			let to = join(root, `.${c.wl}.restore-leftover-${stamp}-${n}`);
			while (present(to) || leftovers.some((l) => l.to === to)) to = join(root, `.${c.wl}.restore-leftover-${stamp}-${++n}`);
			leftovers.push({ from, to, done: false });
		}
		m = { ...m, leftovers };
		writeMarker(mpath, m);
		c.log(`restore ${c.wl}: ${leftovers.length} leftover move(s) planned and recorded in ${mpath}`);
		c.kill("leftovers-planned");
	} else {
		c.log(`restore ${c.wl}: reusing the ${m.leftovers.length} leftover move(s) recorded in ${mpath}`);
	}
	// (1) each move not done, in order
	const list = m.leftovers!;
	for (let i = 0; i < list.length; i++) {
		const l = m.leftovers![i]!;
		if (l.done) continue;
		const from = present(l.from);
		const to = present(l.to);
		if (from && !to) {
			try {
				renameSync(l.from, l.to);
			} catch (e) {
				throw new RestoreError(1, `restore of ${c.wl}: the rename of the leftover ${l.from} to ${l.to} failed (${message(e)}); nothing was published and the marker ${mpath} is kept with its moves; fix the cause and run ${restoreCommand(c.wl)} again`);
			}
			c.log(`restore ${c.wl}: moved the leftover ${l.from} to ${l.to}`);
			c.kill("leftover-renamed");
		} else if (!from && to) {
			c.log(`restore ${c.wl}: the leftover ${l.from} is already at ${l.to} (an earlier run stopped before recording the move)`);
		} else {
			throw new RestoreError(1, `restore of ${c.wl}: the leftover move ${l.from} -> ${l.to} cannot be decided: ${from ? "both paths exist" : "neither path exists"}; nothing was published and the marker ${mpath} is kept; a person checks both paths`);
		}
		m = { ...m, leftovers: m.leftovers!.map((x, j) => (j === i ? { ...x, done: true } : x)) };
		writeMarker(mpath, m);
		c.kill("leftover-marked");
	}
	// (2) publish only after every move is done
	if (!present(folder)) {
		try {
			renameSync(tree, folder);
		} catch (e) {
			throw new RestoreError(1, `restore of ${c.wl}: the rename of the verified tree ${tree} to ${folder} failed (${message(e)}); the marker ${mpath} is kept`);
		}
		c.log(`restore ${c.wl}: published the verified tree at ${folder}`);
		c.kill("published");
	} else {
		const d = differs(folder);
		if (d.length > 0) {
			throw new RestoreError(1, `restore of ${c.wl}: ${folder} was written after the leftover moves and differs from the marker's manifest (${d.join("; ")}); nothing was published and the marker ${mpath} is kept; a person checks ${folder}`);
		}
		c.log(`restore ${c.wl}: ${folder} already holds the marker's manifest (published by an earlier run); kept`);
	}
	// (3) the record
	settleRecords(c, o.stateDir, m.tar_sha256, stamp);
	c.kill("record-settled");
	return { marker: m, stamp };
}

/**
 * `as2 lane restore <wl> [--to <dir>]` (the header above). Resolves when the lane is restored or was never offsite with
 * its folder local; throws RestoreError (its code: 1, or OFFSITE_LOCK_BUSY_EXIT) naming what failed.
 */
export async function restoreLane(o: RestoreOptions): Promise<void> {
	const wl = o.wl;
	if (!WL_RE.test(wl)) throw new RestoreError(1, `restore: ${JSON.stringify(wl)} is not a workload id (wl-<lowercase letters and digits>)`);
	const mpath = markerPath(wl, o.home);
	const c: Ctx = {
		wl, mpath, log: o.log, run: o.run ?? stepRunner({ log: o.log }), deadlineMs: o.deadlineMs ?? RESTORE_DEADLINE_S * 1000, clock: o.clock ?? Date.now,
		kill: o.kill ?? (() => {}),
	};
	const folder = laneDir(wl, o.home);
	if (!present(mpath)) {
		if (present(folder)) {
			o.log(`restore ${wl}: nothing to restore: no marker ${mpath}; the lane folder ${folder} is local`);
			return;
		}
		throw new RestoreError(1, `restore of ${wl}: nothing to restore: no marker ${mpath} and no lane folder ${folder}`);
	}
	let marker: OffsiteMarker;
	try {
		marker = readMarker(mpath);
	} catch (e) {
		throw new RestoreError(1, `restore of ${wl}: ${message(e)}; nothing restored`);
	}
	if (marker.workload !== wl) throw new RestoreError(1, `restore of ${wl}: the marker ${mpath} names workload ${marker.workload}; nothing restored`);
	if (o.to !== undefined && o.to !== null) return restoreTo(c, o, marker, o.to);
	const lock = acquireOffsiteLock(o.home);
	if (lock.kind === "busy") throw new RestoreError(OFFSITE_LOCK_BUSY_EXIT, `restore of ${wl}: a retire or restore is running (${lock.path} is locked); run again after it ends`);
	try {
		const problems: string[] = [];
		// Earlier restores' staging dirs hold only copies of what is on Drive; the lock says none is in use.
		for (const old of stagingDirsOf(lanesRoot(o.home), wl)) {
			const r = dropStaging(old);
			if (r) problems.push(r);
			else o.log(`restore ${wl}: removed an earlier restore's staging dir ${old}`);
		}
		const staging = newStaging(lanesRoot(o.home), wl);
		let m: OffsiteMarker;
		let stamp: string;
		try {
			const tree = await fetchVerified(c, marker, staging);
			({ marker: m, stamp } = reconcile(c, o, mpath, marker, tree));
		} catch (e) {
			throw withCleanup(e, dropStaging(staging));
		}
		const left = dropStaging(staging);
		if (left) problems.push(left);
		// (4) the marker retired, one rename
		const retired = freeIn(lanesRoot(o.home), `${wl}${OFFSITE_MARKER_SUFFIX}.restored-${stamp}`);
		renameSync(mpath, retired);
		fsyncDir(lanesRoot(o.home));
		o.log(`restore ${wl}: restored at ${folder}; the marker is retired as ${retired}`);
		const kept = m.leftovers ?? [];
		if (kept.length > 0) o.log(`restore ${wl}: leftovers kept for a person (never removed by as2): ${kept.map((l) => `${l.to} (was ${l.from})`).join("; ")}`);
		if (problems.length > 0) throw new RestoreError(1, `restore of ${wl}: the lane is restored at ${folder}, but ${problems.join("; ")}`);
	} finally {
		lock.release();
	}
}

/** `--to <dir>`: the verified tree to `<dir>/<wl>`; no lock, nothing under the lanes root, no record. */
async function restoreTo(c: Ctx, o: RestoreOptions, m: OffsiteMarker, to: string): Promise<void> {
	const dir = resolve(to);
	const root = resolve(lanesRoot(o.home));
	if (dir === root || dir.startsWith(`${root}${sep}`)) throw new RestoreError(1, `restore of ${c.wl}: --to ${dir} is inside the lanes root ${root}; give a directory outside it, or restore in place without --to`);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, c.wl);
	if (present(target)) throw new RestoreError(1, `restore of ${c.wl}: ${target} already exists; nothing restored`);
	const staging = newStaging(dir, c.wl);
	try {
		const tree = await fetchVerified(c, m, staging);
		renameSync(tree, target);
	} catch (e) {
		throw withCleanup(e, dropStaging(staging));
	}
	const left = dropStaging(staging);
	o.log(`restore ${c.wl}: the verified tree is at ${target}; the lanes root, the marker and the records are unchanged`);
	if (left) throw new RestoreError(1, `restore of ${c.wl}: the tree is at ${target}, but ${left}`);
}
