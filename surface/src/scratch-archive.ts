// Scratch roots are archived before they are removed (incident 2026-10-28: the close of wl-mvs2x210k5ifkz deleted the
// review-cost replay's REPORT.md and its evidence seconds after the lane's done-because, en-mvsodoos0xh1rm, named it).
// One `.tar.gz` per root, under scratchArchiveBase(home)/<UTC YYYY-MM-DD>/, a sibling of the scratch base, so the scratch
// sweeps never see it. `archiveDir` writes the archive to a `.partial-*` name, lists it back with `tar -tzf` and checks
// the entry count against an lstat walk of the tree, checks the tree did not change while it was archived (same entry
// count, byte total and newest mtime before and after), hashes it, and only then links it to its final name. Any
// failure removes the partial file and says why; the caller keeps the root. The daily sweep (surface/scripts/scratch-sweep.ts)
// expires archives older than `scratchArchive.expireDays`, and, when `scratchArchive.requireOffsite` is on, only those
// with an `<archive>.offsite` marker beside them (written by an offsite copy job once its copy is confirmed).
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, type Stats, statfsSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { installedConfigPath } from "./pair-suggest";

/** The profile config key of the archive settings (profile/config.yml). */
export const SCRATCH_ARCHIVE_KEY = "scratchArchive";
/** Replaces the installed profile config as the source of the `scratchArchive:` block (tests). */
export const SCRATCH_CONFIG_ENV = "AGENT_SYSTEM_SCRATCH_CONFIG";
/** The marker an offsite copy job writes beside an archive once its copy is confirmed: `<archive>.offsite`. */
export const OFFSITE_SUFFIX = ".offsite";
export const ARCHIVE_SUFFIX = ".tar.gz";
const PARTIAL_INFIX = ".partial-";
/** Upper bound on one `tar` run (create or list). */
const TAR_TIMEOUT_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;

export interface ScratchArchiveConfig {
	/** Archives whose mtime is older than this many days are expired by the daily sweep. */
	expireDays: number;
	/** When true, an archive expires only once `<archive>.offsite` exists. */
	requireOffsite: boolean;
	/** The daily sweep's `scratch-disk:` line opens when free space on the scratch volume is under this many GiB. */
	minFreeGib: number;
}

export const DEFAULT_SCRATCH_ARCHIVE: ScratchArchiveConfig = { expireDays: 14, requireOffsite: false, minFreeGib: 20 };

/** Where archives live: beside the scratch base (gates/src/scratch.ts scratchBase), never under it. */
export function scratchArchiveBase(home: string): string {
	return join(home, "agent-scratch", "agent-system-2.0", "scratch-archive");
}

/** `2026-10-28` in UTC. */
export function utcDate(t: Date): string {
	return t.toISOString().slice(0, 10);
}

/** The archive path for workload `id` closed at `now` (before any de-duplicating suffix `archiveDir` adds). */
export function archivePathFor(home: string, id: string, now: Date): string {
	return join(scratchArchiveBase(home), utcDate(now), `${id}${ARCHIVE_SUFFIX}`);
}

const isNonNegative = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** The `scratchArchive:` block of a parsed config: each key its value when well-formed, else its default with a note. */
export function parseScratchArchiveConfig(doc: unknown): { config: ScratchArchiveConfig; notes: string[] } {
	const config = { ...DEFAULT_SCRATCH_ARCHIVE };
	const notes: string[] = [];
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { config, notes };
	const block: unknown = Reflect.get(doc, SCRATCH_ARCHIVE_KEY);
	if (block === undefined || block === null) return { config, notes };
	if (typeof block !== "object" || Array.isArray(block)) return { config, notes: [`${SCRATCH_ARCHIVE_KEY} is not a mapping; defaults used`] };
	const expire: unknown = Reflect.get(block, "expireDays");
	if (expire !== undefined) {
		if (isNonNegative(expire)) config.expireDays = expire;
		else notes.push(`${SCRATCH_ARCHIVE_KEY}.expireDays ${JSON.stringify(expire)} is not a non-negative number; ${config.expireDays} used`);
	}
	const offsite: unknown = Reflect.get(block, "requireOffsite");
	if (offsite !== undefined) {
		if (typeof offsite === "boolean") config.requireOffsite = offsite;
		else notes.push(`${SCRATCH_ARCHIVE_KEY}.requireOffsite ${JSON.stringify(offsite)} is not true or false; ${config.requireOffsite} used`);
	}
	const free: unknown = Reflect.get(block, "minFreeGib");
	if (free !== undefined) {
		if (isNonNegative(free)) config.minFreeGib = free;
		else notes.push(`${SCRATCH_ARCHIVE_KEY}.minFreeGib ${JSON.stringify(free)} is not a non-negative number; ${config.minFreeGib} used`);
	}
	return { config, notes };
}

/**
 * The settings from `$AGENT_SYSTEM_SCRATCH_CONFIG`, else the installed profile config under `home` (pair-suggest.ts
 * installedConfigPath). A missing file is the defaults with no note; an unreadable or unparseable one, the defaults with one.
 */
export function readScratchArchiveConfig(env: Readonly<Record<string, string | undefined>>, home: string): { config: ScratchArchiveConfig; path: string; notes: string[] } {
	const path = env[SCRATCH_CONFIG_ENV]?.trim() || installedConfigPath({ ...env, HOME: home });
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: { ...DEFAULT_SCRATCH_ARCHIVE }, path, notes: [] };
		return { config: { ...DEFAULT_SCRATCH_ARCHIVE }, path, notes: [`${path} could not be read (${message(e)}); archive defaults used`] };
	}
	try {
		return { path, ...parseScratchArchiveConfig(Bun.YAML.parse(text)) };
	} catch (e) {
		return { config: { ...DEFAULT_SCRATCH_ARCHIVE }, path, notes: [`${path} could not be parsed (${message(e).split("\n")[0]}); archive defaults used`] };
	}
}

/** What a tree is, for "did it change while it was archived": entries (itself included), regular-file bytes, newest lstat mtime. */
export interface TreeStamp {
	entries: number;
	bytes: number;
	newestMs: number;
}

/** An lstat walk of `dir` (links are not followed). Throws when any entry cannot be read. */
export function treeStamp(dir: string): TreeStamp {
	const stamp: TreeStamp = { entries: 0, bytes: 0, newestMs: 0 };
	const stack = [dir];
	while (stack.length > 0) {
		const at = stack.pop()!;
		const st = lstatSync(at);
		stamp.entries++;
		stamp.newestMs = Math.max(stamp.newestMs, st.mtimeMs);
		if (st.isFile()) stamp.bytes += st.size;
		if (st.isDirectory()) for (const name of readdirSync(at)) stack.push(join(at, name));
	}
	return stamp;
}

/** A written, verified archive: its final path, size, SHA-256, member count, and the tree as it was archived. */
export interface Archived {
	kind: "archived";
	path: string;
	bytes: number;
	sha256: string;
	entries: number;
	stamp: TreeStamp;
}

export type ArchiveResult = Archived | { kind: "failed"; reason: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** SHA-256 of the file at `path`, read in 1 MiB chunks. */
function sha256File(path: string): string {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n === 0) break;
			hash.update(buf.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** `<dir>/<id>.tar.gz`, else `<id>.2.tar.gz`, `<id>.3.tar.gz`, …: the first name nothing holds yet. */
function freeName(dest: string): string {
	const stem = dest.endsWith(ARCHIVE_SUFFIX) ? dest.slice(0, -ARCHIVE_SUFFIX.length) : dest;
	for (let n = 1; ; n++) {
		const p = n === 1 ? dest : `${stem}.${n}${ARCHIVE_SUFFIX}`;
		try {
			lstatSync(p);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return p;
			throw e;
		}
	}
}

const tarEnv = (): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	// macOS bsdtar would add AppleDouble `._*` members for extended attributes; they would break the entry count.
	env.COPYFILE_DISABLE = "1";
	return env;
};

/**
 * Archive the directory `name` under `parent` to `dest` (or the first free `.<n>` variant of it) and verify it: tar
 * exits 0, `tar -tzf` lists exactly as many members as the lstat walk found, the tree is unchanged after the archive
 * was written, and the file is not empty. The archive is written as `<final>.partial-<hex>` and linked to its final
 * name only once verified (a link never replaces an existing name). Nothing under `parent` is changed. Never throws.
 */
export function archiveDir(parent: string, name: string, dest: string): ArchiveResult {
	const dir = join(parent, name);
	let partial: string | null = null;
	const fail = (reason: string): ArchiveResult => {
		if (partial) {
			try {
				unlinkSync(partial);
			} catch {}
		}
		return { kind: "failed", reason };
	};
	try {
		const before = treeStamp(dir);
		mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
		const final = freeName(dest);
		partial = `${final}${PARTIAL_INFIX}${randomBytes(6).toString("hex")}`;
		const made = Bun.spawnSync(["tar", "-C", parent, "-czf", partial, "--", name], { stdout: "pipe", stderr: "pipe", env: tarEnv(), timeout: TAR_TIMEOUT_MS });
		if (made.exitCode !== 0) return fail(`tar -czf exited ${made.exitCode ?? made.signalCode ?? "?"}: ${made.stderr.toString().trim().split("\n")[0] || "no message"}`);
		const listed = Bun.spawnSync(["tar", "-tzf", partial], { stdout: "pipe", stderr: "pipe", env: tarEnv(), timeout: TAR_TIMEOUT_MS });
		if (listed.exitCode !== 0) return fail(`tar -tzf of ${partial} exited ${listed.exitCode ?? listed.signalCode ?? "?"}: ${listed.stderr.toString().trim().split("\n")[0] || "no message"}`);
		const members = listed.stdout.toString().split("\n").filter((l) => l !== "").length;
		if (members !== before.entries) return fail(`the archive lists ${members} members, the tree has ${before.entries} entries`);
		const after = treeStamp(dir);
		if (before.entries !== after.entries || before.bytes !== after.bytes || before.newestMs !== after.newestMs) {
			return fail(`${dir} changed while it was archived (${before.entries} → ${after.entries} entries, ${before.bytes} → ${after.bytes} bytes)`);
		}
		const bytes = statSync(partial).size;
		if (bytes === 0) return fail(`${partial} is empty`);
		const sha256 = sha256File(partial);
		chmodSync(partial, 0o600);
		linkSync(partial, final);
		unlinkSync(partial);
		partial = null;
		return { kind: "archived", path: final, bytes, sha256, entries: members, stamp: before };
	} catch (e) {
		return fail(message(e));
	}
}

export type ExpiryAction = "expired" | "would expire" | "kept" | "expire failed";

export interface ExpiryLine {
	path: string;
	bytes: number | null;
	action: ExpiryAction;
	why: string;
}

/**
 * The daily sweep's expiry pass over scratchArchiveBase(home): every regular `*.tar.gz` (and every `*.partial-*` a
 * crashed archive left) under a date directory whose mtime is more than `expireDays` before `now` is removed, with its
 * `.offsite` marker; with `requireOffsite`, an archive with no marker is kept. Symlinks and other entries are never
 * touched. Date directories left empty are removed. `dryRun` removes nothing. Never throws.
 */
export function expireArchives(home: string, config: ScratchArchiveConfig, now: Date, dryRun: boolean): { lines: ExpiryLine[]; notes: string[] } {
	const base = scratchArchiveBase(home);
	const lines: ExpiryLine[] = [];
	const notes: string[] = [];
	const cutoff = now.getTime() - config.expireDays * DAY_MS;
	let days: string[];
	try {
		if (!lstatSync(base).isDirectory()) return { lines, notes: [`${base} is not a directory; no archive expired`] };
		days = readdirSync(base).sort();
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") notes.push(`${base} could not be listed (${message(e)}); no archive expired`);
		return { lines, notes };
	}
	for (const day of days) {
		const dayDir = join(base, day);
		let names: string[];
		try {
			if (!lstatSync(dayDir).isDirectory()) continue;
			names = readdirSync(dayDir).sort();
		} catch (e) {
			notes.push(`${dayDir} could not be listed (${message(e)})`);
			continue;
		}
		for (const name of names) {
			const partial = name.includes(`${ARCHIVE_SUFFIX}${PARTIAL_INFIX}`);
			if (!partial && !name.endsWith(ARCHIVE_SUFFIX)) continue;
			const path = join(dayDir, name);
			let st: Stats;
			try {
				st = lstatSync(path);
			} catch (e) {
				lines.push({ path, bytes: null, action: "kept", why: `cannot be read (${message(e)})` });
				continue;
			}
			if (!st.isFile()) continue;
			const ageDays = (now.getTime() - st.mtimeMs) / DAY_MS;
			if (st.mtimeMs >= cutoff) {
				lines.push({ path, bytes: st.size, action: "kept", why: `${ageDays.toFixed(1)} days old, under ${config.expireDays}` });
				continue;
			}
			const marker = `${path}${OFFSITE_SUFFIX}`;
			let hasMarker = false;
			try {
				hasMarker = lstatSync(marker).isFile();
			} catch {}
			if (!partial && config.requireOffsite && !hasMarker) {
				lines.push({ path, bytes: st.size, action: "kept", why: `${ageDays.toFixed(1)} days old, but no ${OFFSITE_SUFFIX} marker (requireOffsite)` });
				continue;
			}
			const why = `${ageDays.toFixed(1)} days old, over ${config.expireDays}${partial ? " (a partial archive)" : hasMarker ? ", offsite copy confirmed" : ""}`;
			if (dryRun) {
				lines.push({ path, bytes: st.size, action: "would expire", why });
				continue;
			}
			try {
				unlinkSync(path);
				if (hasMarker) unlinkSync(marker);
				lines.push({ path, bytes: st.size, action: "expired", why });
			} catch (e) {
				lines.push({ path, bytes: st.size, action: "expire failed", why: `${why}; ${message(e)}` });
			}
		}
		if (!dryRun) {
			try {
				if (readdirSync(dayDir).length === 0) {
					// rmdir, never recursive: anything that appeared meanwhile keeps the directory.
					rmdirSync(dayDir);
				}
			} catch {}
		}
	}
	return { lines, notes };
}

/** Free bytes for an unprivileged writer on the volume holding `path` (statfs bavail × bsize); null when it cannot be read. */
export function freeBytes(path: string): number | null {
	try {
		const s = statfsSync(path);
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return null;
	}
}

export const gib = (bytes: number): string => (bytes / GIB).toFixed(1);
export { GIB };
