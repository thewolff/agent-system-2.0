// Scratch roots are archived before they are removed (incident 2026-10-28: the close of wl-mvs2x210k5ifkz deleted the
// review-cost replay's REPORT.md and its evidence seconds after the lane's done-because, en-mvsodoos0xh1rm, named it).
// One `.tar.gz` per root, under scratchArchiveBase(home)/<UTC YYYY-MM-DD>/, a sibling of the scratch base, so the scratch
// sweeps never see it. The caller first renames the root aside (surface/src/scratch-remove.ts detachChild), so nothing
// that writes by the root's path reaches the tree being archived. `archiveDetached` then:
//   1. reads the tree's manifest: every entry's relative path, type, size, permission bits, inode, mtime and ctime in
//      nanoseconds, a regular file's SHA-256 and a link's target (`readManifest`); a socket, FIFO or device refuses;
//   2. admits the archive only when the destination volume has room for it and for its verification copy, plus
//      ARCHIVE_MARGIN_BYTES;
//   3. writes it as `<final>.partial-<12 hex>` with `tar -C <tree> -czf … .` (members `./…`);
//   4. extracts it into a private `.verify-*` directory beside it and compares that copy's manifest with the tree's,
//      entry by entry (path, type, size, permission bits, content hash, link target); any difference fails;
//   5. hashes the archive and links it to its final name (a link never replaces a name);
//   6. freezes the tree (`freezeTree`): every directory and file loses its write bits, top down, so no process that does
//      not chmod can open a file in it for writing or add, rename or remove an entry, by any path, the detached name
//      and a hard link from outside included (the bits are the inode's; a writable file with another link refuses);
//   7. runs lsof over the tree (`stillOpen`): a descriptor opened before the freeze can still write; a file still
//      open, or a missing, failing or timed-out lsof, fails;
//   8. reads the tree again, with hashes, and compares it with step 1 (entry set, inode, size, link target, mtime, the
//      ctime read just before the freeze's chmod, every file's SHA-256; the mode the freeze set) and with the freeze
//      (every field): any write since step 1 shows, including one in the freeze's own stat-to-chmod step that kept
//      size and mtime, so it fails.
// On a failure after step 5 the archive is dropped, and after step 6 the modes are given back. On success the tree is
// left frozen, and only `purgeArchived` removes it, removing nothing the archive does not hold: each file or symlink is
// renamed into a private staging directory first and checked there (the frozen inode, still without write bits, the
// archived SHA-256 or target) before its unlink, and a directory goes only by rmdir. What stays open is a process that
// chmods the tree back, one running as root, and one that works in the purge's staging directory (`.as2-purge-<16 hex>`,
// made 0700 after the freeze).
// The daily sweep (surface/scripts/scratch-sweep.ts) expires archives older than `scratchArchive.expireDays`, and, when
// `scratchArchive.requireOffsite` is on, only those with an `<archive>.offsite` marker beside them (written by an offsite
// copy job once its copy is confirmed).
import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmdirSync, rmSync, type Stats, statfsSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { installedConfigPath } from "./pair-suggest";
import type { Detached, Removal } from "./scratch-remove";

/** The profile config key of the archive settings (profile/config.yml). */
export const SCRATCH_ARCHIVE_KEY = "scratchArchive";
/** Replaces the installed profile config as the source of the `scratchArchive:` block (tests). */
export const SCRATCH_CONFIG_ENV = "AGENT_SYSTEM_SCRATCH_CONFIG";
/** The marker an offsite copy job writes beside an archive once its copy is confirmed: `<archive>.offsite`. */
export const OFFSITE_SUFFIX = ".offsite";
/** The offsite copy job's other sidecars (a failed-night count, a stuck flag); removed with their archive when it expires. */
export const OFFSITE_SIDECARS = [".attempts", ".stuck"] as const;
export const ARCHIVE_SUFFIX = ".tar.gz";
const PARTIAL_INFIX = ".partial-";
/** Exactly the name `archiveDetached` writes before an archive is verified: `<final>.tar.gz.partial-<12 lowercase hex>`. */
const PARTIAL_RE = /\.tar\.gz\.partial-[0-9a-f]{12}$/;
const VERIFY_PREFIX = ".verify-";
/** Upper bound on one `tar` run (create or extract). */
const TAR_TIMEOUT_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
/** Free space an archive must leave on its volume, beyond the archive and its verification copy. */
export const ARCHIVE_MARGIN_BYTES = GIB;
/** Room counted per entry for tar's headers (a 512-byte header, and a pax header for long names). */
const TAR_ENTRY_BYTES = 1536;

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

/** The archive path for the directory named `name` archived at `now` (before any de-duplicating suffix); a leading `.` is dropped. */
export function archivePathFor(home: string, name: string, now: Date): string {
	return join(scratchArchiveBase(home), utcDate(now), `${name.replace(/^\.+/, "")}${ARCHIVE_SUFFIX}`);
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


const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One entry of a tree: what `readManifest` records about it. */
export interface ManifestEntry {
	type: "file" | "dir" | "link";
	/** Bytes of a regular file; 0 otherwise. */
	size: number;
	/** Permission bits (mode & 0o7777). */
	mode: number;
	/** SHA-256 of a regular file's contents when read with hashes; null otherwise. */
	sha256: string | null;
	/** A symlink's target; null otherwise. */
	target: string | null;
	dev: bigint;
	ino: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

/** A tree's entries by path relative to its top ("" for the top itself, "a/b" below it). */
export type Manifest = Map<string, ManifestEntry>;

/**
 * Every entry under `dir` (itself included; links are recorded, never followed), with regular files hashed when `hash`.
 * Throws when an entry cannot be read, or is a socket, FIFO or device (tar cannot be trusted to round-trip one).
 */
export function readManifest(dir: string, hash: boolean): Manifest {
	const out: Manifest = new Map();
	const stack: string[] = [""];
	while (stack.length > 0) {
		const rel = stack.pop()!;
		const abs = rel === "" ? dir : join(dir, rel);
		const st: BigIntStats = lstatSync(abs, { bigint: true });
		const type = st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : null;
		if (type === null) throw new Error(`${abs} is a socket, FIFO or device; not archivable`);
		out.set(rel, {
			type,
			size: type === "file" ? Number(st.size) : 0,
			mode: Number(st.mode & 0o7777n),
			sha256: type === "file" && hash ? sha256File(abs) : null,
			target: type === "link" ? readlinkSync(abs) : null,
			dev: st.dev,
			ino: st.ino,
			mtimeNs: st.mtimeNs,
			ctimeNs: st.ctimeNs,
		});
		if (type === "dir") for (const name of readdirSync(abs)) stack.push(rel === "" ? name : `${rel}/${name}`);
	}
	return out;
}

const shown = (rel: string): string => (rel === "" ? "the top directory" : `./${rel}`);

/** Entries only one side has, then per-entry field differences picked by `fields`, at most `limit` of them. */
function differences(a: Manifest, b: Manifest, aName: string, bName: string, fields: (x: ManifestEntry, y: ManifestEntry, rel: string) => string | null, limit: number): string[] {
	const out: string[] = [];
	const more = (): boolean => out.length < limit;
	for (const [rel, x] of a) {
		if (!more()) break;
		const y = b.get(rel);
		if (!y) out.push(`${shown(rel)} is in ${aName}, not in ${bName}`);
		else {
			const d = fields(x, y, rel);
			if (d) out.push(`${shown(rel)} ${d}`);
		}
	}
	for (const rel of b.keys()) {
		if (!more()) break;
		if (!a.has(rel)) out.push(`${shown(rel)} is in ${bName}, not in ${aName}`);
	}
	return out;
}

/**
 * What differs in content between two manifests read with hashes: entry set, type, size, permission bits (not of the top
 * directory, whose mode the extraction directory decides), contents and link targets. Empty when they hold the same tree.
 */
export function contentDiff(a: Manifest, b: Manifest, aName = "the tree", bName = "the archive", limit = 3): string[] {
	return differences(a, b, aName, bName, (x, y, rel) => {
		if (x.type !== y.type) return `is a ${x.type} in ${aName}, a ${y.type} in ${bName}`;
		if (x.size !== y.size) return `is ${x.size} bytes in ${aName}, ${y.size} in ${bName}`;
		if (rel !== "" && (x.mode & 0o777) !== (y.mode & 0o777)) return `has mode ${(x.mode & 0o777).toString(8)} in ${aName}, ${(y.mode & 0o777).toString(8)} in ${bName}`;
		if (x.sha256 !== y.sha256) return `has other contents in ${bName}`;
		if (x.target !== y.target) return `points to ${x.target} in ${aName}, ${y.target} in ${bName}`;
		return null;
	}, limit);
}

/**
 * What changed between two reads of the same tree: entry set, type, inode, size, permission bits, mtime and ctime in
 * nanoseconds, link target. Any write, rename, chmod or relink of an entry changes its ctime, which no process can set.
 */
export function identityDiff(before: Manifest, after: Manifest, limit = 3): string[] {
	return differences(before, after, "the tree as archived", "the tree now", (x, y) => {
		if (x.type !== y.type) return `was a ${x.type}, is a ${y.type}`;
		if (x.dev !== y.dev || x.ino !== y.ino) return "is another file (its inode changed)";
		if (x.size !== y.size) return `changed size (${x.size} → ${y.size} bytes)`;
		if (x.target !== y.target) return `was relinked (${x.target} → ${y.target})`;
		if (x.mode !== y.mode) return "changed mode";
		if (x.mtimeNs !== y.mtimeNs || x.ctimeNs !== y.ctimeNs) return "was written or changed (its mtime or ctime moved)";
		return null;
	}, limit);
}

/** A written, verified archive: its final path, size, SHA-256, the tree's manifest as archived, and anything to report. */
export interface Archived {
	kind: "archived";
	path: string;
	bytes: number;
	sha256: string;
	/** Entries archived (the top directory included). */
	entries: number;
	members: Manifest;
	/** The tree as `freezeTree` left it (no write bits): what `purgeArchived` may remove. */
	frozen: Manifest;
	/** Something that went wrong after the archive was verified (a verification copy left behind); reported, not fatal. */
	warnings: string[];
}

export type ArchiveResult = Archived | { kind: "failed"; reason: string };

/** Test and caller seams of `archiveDetached`. */
export interface ArchiveSeams extends PurgeSeams {
	/** Replaces the statfs read of free bytes on the archive volume. */
	freeBytes?: (path: string) => number | null;
	/** Runs after tar wrote the archive, before it is verified. */
	afterTar?: () => void;
	/** Runs after the archive is verified, hashed and linked, before the tree is frozen and read again. */
	beforeFinalCheck?: () => void;
	/** Runs once the tree is frozen, before lsof and the last read: a writer that comes after the freeze. */
	afterFreeze?: (dir: string) => void;
	/** Runs between the freeze's stat of an entry and its chmod: a writer in that step. */
	beforeChmod?: (path: string) => void;
	/** Replaces the lsof read of what is open under a tree (`openFilesUnder`). */
	openFiles?: (dir: string) => OpenFiles;
}

/** What lsof shows open under a directory: nothing, these files, or that it could not be shown. */
export type OpenFiles = { kind: "none" } | { kind: "open"; holders: string[] } | { kind: "unknown"; reason: string };

const LSOF_TIMEOUT_MS = 30_000;

/**
 * Every file any process this user can see has open under `dir` (`lsof -n -P -F pn +D <dir>`, bounded by LSOF_TIMEOUT_MS).
 * macOS lsof exits 1 whether or not it found anything, so the answer is read from its output: `n` lines are open files,
 * no output and no complaint is "none", and anything else (no lsof, a timeout, a signal, an error or warning) is "unknown".
 * Never throws.
 */
export function openFilesUnder(dir: string): OpenFiles {
	let r: ReturnType<typeof Bun.spawnSync>;
	try {
		r = Bun.spawnSync(["lsof", "-n", "-P", "-F", "pn", "+D", dir], { stdout: "pipe", stderr: "pipe", timeout: LSOF_TIMEOUT_MS });
	} catch (e) {
		return { kind: "unknown", reason: `lsof could not be run (${message(e)})` };
	}
	const out = r.stdout?.toString() ?? "";
	const err = (r.stderr?.toString() ?? "").trim();
	const holders: string[] = [];
	let pid = "?";
	for (const line of out.split("\n")) {
		if (line.startsWith("p")) pid = line.slice(1);
		else if (line.startsWith("n")) holders.push(`pid ${pid} has ${line.slice(1)} open`);
	}
	if (holders.length > 0) return { kind: "open", holders };
	if (r.signalCode || r.exitCode === null) return { kind: "unknown", reason: `lsof did not finish (${r.signalCode ?? "no exit code"}; limit ${LSOF_TIMEOUT_MS / 1000} s)` };
	if ((r.exitCode !== 0 && r.exitCode !== 1) || err !== "" || out.trim() !== "") return { kind: "unknown", reason: `lsof exited ${r.exitCode}: ${err.split("\n")[0] || out.trim().split("\n")[0] || "no message"}` };
	return { kind: "none" };
}

/**
 * Why the tree `dir` must not be removed yet: a process still has a file open under it (a write through a descriptor
 * opened before the rename aside would reach the tree after its last check), or that could not be ruled out. Null only
 * when lsof showed nothing open. Never throws.
 */
export function stillOpen(dir: string, seams: ArchiveSeams = {}): string | null {
	const o = (seams.openFiles ?? openFilesUnder)(dir);
	if (o.kind === "none") return null;
	if (o.kind === "open") return `a process still has files open in it (${o.holders.slice(0, 3).join("; ")}${o.holders.length > 3 ? `; ${o.holders.length - 3} more` : ""}), so it could still be written`;
	return `no writer could be ruled out: ${o.reason}`;
}

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

/**
 * `<dir>/<id>.tar.gz`, else `<id>.2.tar.gz`, `<id>.3.tar.gz`, …: the first name that neither an archive nor an offsite
 * sidecar (`.offsite`, `.attempts`, `.stuck`, which can outlive their archive) holds, so a new archive never inherits an
 * old one's offsite marker.
 */
function freeName(dest: string): string {
	const stem = dest.endsWith(ARCHIVE_SUFFIX) ? dest.slice(0, -ARCHIVE_SUFFIX.length) : dest;
	const held = (p: string): boolean => {
		try {
			lstatSync(p);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw e;
		}
	};
	for (let n = 1; ; n++) {
		const p = n === 1 ? dest : `${stem}.${n}${ARCHIVE_SUFFIX}`;
		if (![p, ...[OFFSITE_SUFFIX, ...OFFSITE_SIDECARS].map((s) => `${p}${s}`)].some(held)) return p;
	}
}

const tarEnv = (): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	// macOS bsdtar would add AppleDouble `._*` members for extended attributes; they would not be in the tree's manifest.
	env.COPYFILE_DISABLE = "1";
	return env;
};

function tar(args: string[]): string | null {
	const r = Bun.spawnSync(["tar", ...args], { stdout: "pipe", stderr: "pipe", env: tarEnv(), timeout: TAR_TIMEOUT_MS });
	if (r.exitCode === 0) return null;
	return `tar ${args[0]} exited ${r.exitCode ?? r.signalCode ?? "?"}: ${r.stderr.toString().trim().split("\n")[0] || "no message"}`;
}

/** Remove a verification copy (directories made writable first, so a read-only directory in the tree cannot pin it). */
function removeCopy(dir: string): string | null {
	try {
		const stack = [dir];
		while (stack.length > 0) {
			const at = stack.pop()!;
			const st = lstatSync(at);
			if (!st.isDirectory()) continue;
			chmodSync(at, st.mode | 0o700);
			for (const name of readdirSync(at)) stack.push(join(at, name));
		}
		rmSync(dir, { recursive: true });
		return null;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		return `the verification copy ${dir} could not be removed (${message(e)})`;
	}
}

/**
 * Archive the detached tree `dir` to `dest` (or the first free `.<n>` variant of it), verify it and freeze the tree (steps
 * 1–8 at the top of this file). On success the tree is left frozen for `purgeArchived`. Never throws; on failure the tree's
 * modes are given back and nothing is left under the destination but what was there.
 */
export function archiveDetached(dir: string, dest: string, seams: ArchiveSeams = {}): ArchiveResult {
	let partial: string | null = null;
	let copy: string | null = null;
	let linked: string | null = null;
	let thawed: [string, number][] | null = null;
	const fail = (reason: string): ArchiveResult => {
		const also: string[] = [];
		if (copy) {
			const r = removeCopy(copy);
			if (r) also.push(r);
		}
		for (const [what, p] of [["partial archive", partial], ["archive", linked]] as const) {
			if (!p) continue;
			try {
				unlinkSync(p);
				if (what === "archive") also.push(`the archive ${p} was dropped`);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") also.push(`the ${what} ${p} could not be removed (${message(e)})`);
			}
		}
		if (thawed) {
			const t = thawTree(dir, thawed);
			if (t) also.push(t);
		}
		return { kind: "failed", reason: also.length ? `${reason}; ${also.join("; ")}` : reason };
	};
	try {
		const before = readManifest(dir, true);
		let bytes = 0;
		for (const e of before.values()) bytes += e.size;
		const at = dirname(dest);
		mkdirSync(at, { recursive: true, mode: 0o700 });
		const need = 2 * (bytes + TAR_ENTRY_BYTES * before.size) + ARCHIVE_MARGIN_BYTES;
		const free = (seams.freeBytes ?? freeBytes)(at);
		if (free === null) return fail(`the free space on ${at} cannot be read, so the archive was not started`);
		if (free < need) return fail(`${gib(free)} GiB free on ${at}; the archive and its verification copy need up to ${gib(need)} GiB (${gib(bytes)} GiB in ${before.size} entries, twice, plus a ${gib(ARCHIVE_MARGIN_BYTES)} GiB margin), so the archive was not started`);
		const final = freeName(dest);
		partial = `${final}${PARTIAL_INFIX}${randomBytes(6).toString("hex")}`;
		const made = tar(["-czf", partial, "-C", dir, "."]);
		if (made) return fail(made);
		seams.afterTar?.();
		copy = join(at, `${VERIFY_PREFIX}${randomBytes(8).toString("hex")}`);
		mkdirSync(copy, { mode: 0o700 });
		const out = tar(["-xzpf", partial, "-C", copy]);
		if (out) return fail(`verifying ${partial}: ${out}`);
		const diff = contentDiff(before, readManifest(copy, true));
		if (diff.length > 0) return fail(`the archive does not hold the tree: ${diff.join("; ")}`);
		const warnings: string[] = [];
		const left = removeCopy(copy);
		copy = null;
		if (left) warnings.push(left);
		const size = statSync(partial).size;
		const sha256 = sha256File(partial);
		chmodSync(partial, 0o600);
		linkSync(partial, final);
		linked = final;
		unlinkSync(partial);
		partial = null;
		seams.beforeFinalCheck?.();
		// Freeze, then writers, then contents. Once no directory and no file in the tree has a write bit, a process that does
		// not chmod can neither open a file in it for writing nor make, rename or remove an entry, by any path: the bits are
		// the inode's, so a hard link from outside is held too (a writable one refuses the freeze). lsof then catches a
		// descriptor opened before the freeze. Last, every frozen file is hashed again against what was archived: a write
		// in the freeze's own stat-to-chmod step that kept size and mtime leaves no other trace (the chmod moves ctime).
		const frozen = freezeTree(dir, seams.beforeChmod);
		if (frozen.kind === "failed") return fail(`${dir} could not be frozen: ${frozen.reason}`);
		thawed = frozen.changed;
		seams.afterFreeze?.(dir);
		const open = stillOpen(dir, seams);
		if (open) return fail(`${dir} is not proven quiet: ${open}`);
		const now = readManifest(dir, true);
		const changed = [...frozenDiff(before, frozen.at, frozen.ctimeBefore), ...identityDiff(frozen.at, now), ...hashDiff(before, now)].slice(0, 3);
		if (changed.length > 0) return fail(`${dir} changed while it was archived: ${changed.join("; ")}`);
		return { kind: "archived", path: final, bytes: size, sha256, entries: before.size, members: before, frozen: frozen.at, warnings };
	} catch (e) {
		return fail(message(e));
	}
}

/** The mode `freezeTree` gives an entry: no write bit for anyone; a directory keeps the owner's read and search. */
const frozenMode = (type: ManifestEntry["type"], mode: number): number => (type === "dir" ? (mode & ~0o222) | 0o500 : mode & ~0o222);

/** Every regular file of `now` whose SHA-256 is not the one `archived` recorded (both read with hashes). */
function hashDiff(archived: Manifest, now: Manifest): string[] {
	const out: string[] = [];
	for (const [rel, y] of now) {
		const x = archived.get(rel);
		if (x?.type === "file" && y.type === "file" && x.sha256 !== y.sha256) out.push(`${shown(rel)} has other contents than the archive`);
	}
	return out;
}

/**
 * Take every write bit off the tree `dir`, top down (a directory before its entries, so none can be added behind the walk),
 * and read each entry after: its manifest at the freeze. Symlinks are left as they are. A regular file with another hard
 * link that is writable refuses (its other path may be the one written); one already without write bits (a git object) is
 * left untouched. On a refusal or error, the bits already taken are given back. `changed` is every path whose mode was
 * changed, with its mode before. `beforeChmod` (a test seam) runs between an entry's stat and its chmod. Never throws.
 */
export function freezeTree(dir: string, beforeChmod?: (path: string) => void): { kind: "frozen"; at: Manifest; ctimeBefore: Map<string, bigint>; changed: [string, number][] } | { kind: "failed"; reason: string } {
	const at: Manifest = new Map();
	const ctimeBefore = new Map<string, bigint>();
	const changed: [string, number][] = [];
	const stack: string[] = [""];
	try {
		while (stack.length > 0) {
			const rel = stack.pop()!;
			const abs = rel === "" ? dir : join(dir, rel);
			let st: BigIntStats = lstatSync(abs, { bigint: true });
			const mode = Number(st.mode & 0o7777n);
			ctimeBefore.set(rel, st.ctimeNs);
			if (st.isFile() && st.nlink > 1n && (mode & 0o222) !== 0) throw new Error(`${shown(rel)} has ${st.nlink} hard links and is writable, so a write by its other path cannot be excluded`);
			if (st.isFile() || st.isDirectory()) {
				const want = frozenMode(st.isDirectory() ? "dir" : "file", mode);
				if (mode !== want) {
					beforeChmod?.(abs);
					chmodSync(abs, want);
					changed.push([rel, mode]);
					st = lstatSync(abs, { bigint: true });
				}
			}
			at.set(rel, entryOf(abs, st));
			if (st.isDirectory()) for (const name of readdirSync(abs)) stack.push(rel === "" ? name : `${rel}/${name}`);
		}
	} catch (e) {
		const t = thawTree(dir, changed);
		return { kind: "failed", reason: t ? `${message(e)}; ${t}` : message(e) };
	}
	return { kind: "frozen", at, ctimeBefore, changed };
}

/** Give each changed path its mode back. Null when all were; otherwise what could not be. Never throws. */
export function thawTree(dir: string, changed: [string, number][]): string | null {
	const bad: string[] = [];
	for (const [rel, mode] of changed) {
		try {
			chmodSync(rel === "" ? dir : join(dir, rel), mode);
		} catch (e) {
			bad.push(`${shown(rel)} (${message(e)})`);
		}
	}
	return bad.length ? `the modes of ${bad.length} entries could not be given back: ${bad.slice(0, 3).join("; ")}` : null;
}

function entryOf(abs: string, st: BigIntStats): ManifestEntry {
	const type = st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : null;
	if (type === null) throw new Error(`${abs} is a socket, FIFO or device; not archivable`);
	return { type, size: type === "file" ? Number(st.size) : 0, mode: Number(st.mode & 0o7777n), sha256: null, target: type === "link" ? readlinkSync(abs) : null, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
}

/**
 * What a write made between the first read of the tree and its freeze changed: the entry set, type, inode, size, link
 * target, mtime and the ctime read just before the freeze's chmod (the chmod moves only ctime), and a mode that is not the
 * frozen one.
 */
function frozenDiff(before: Manifest, at: Manifest, ctimeBefore: Map<string, bigint>): string[] {
	return differences(before, at, "the tree as archived", "the tree at its freeze", (x, y, rel) => {
		if (x.type !== y.type) return `was a ${x.type}, is a ${y.type}`;
		if (x.dev !== y.dev || x.ino !== y.ino) return "is another file (its inode changed)";
		if (x.size !== y.size) return `changed size (${x.size} → ${y.size} bytes)`;
		if (x.target !== y.target) return `was relinked (${x.target} → ${y.target})`;
		if (x.mtimeNs !== y.mtimeNs || x.ctimeNs !== ctimeBefore.get(rel)) return "was written or changed (its mtime or ctime moved)";
		if (x.type !== "link" && y.mode !== frozenMode(x.type, x.mode)) return "changed mode";
		return null;
	}, 3);
}

/** Test seams of `purgeArchived`. */
export interface PurgeSeams {
	/** Runs right before the entry at `path` is moved into the purge's staging directory: a writer racing the purge. */
	beforeStage?: (path: string) => void;
}

/** The purge's private staging directory, made inside the tree it removes: `.as2-purge-<16 hex>`. */
const PURGE_STAGING_PREFIX = ".as2-purge-";

/**
 * Remove a tree `archiveDetached` archived and froze, bottom up, and never remove anything the archive does not hold. No
 * pathname check authorizes a removal, because none can be made atomic with it. Instead:
 *  - a file or symlink is first renamed into a private staging directory (`.as2-purge-<16 hex>`, made 0700 inside the
 *    tree). The rename moves whatever is at the path at that instant, and from then on only the staging path reaches it.
 *    The moved entry is then checked: it is unlinked only when it is the inode the freeze recorded, still without write
 *    bits, and (a file) has the archived size and SHA-256 or (a symlink) the archived target;
 *  - a directory is removed only by rmdir, which removes nothing but an empty directory.
 * Anything else stops the purge. An entry the freeze did not record is not touched. A staged entry that fails its check
 * is put back (linked back for a file, which never replaces a name; renamed back only to a free name otherwise; or left
 * in staging, and the result says where). A directory a writer added to is kept. Every recorded entry left then gets its
 * mode from before the archive back, and the result names what was kept. Never throws.
 */
export function purgeArchived(d: Detached, a: Archived, seams: PurgeSeams = {}): Removal {
	const stagingName = `${PURGE_STAGING_PREFIX}${randomBytes(8).toString("hex")}`;
	const staging = join(d.doomed, stagingName);
	let made = false;
	let held = 0;
	let kept: string | null = null;
	/** Move `rel` into staging and unlink it there only when it is what was archived; otherwise put it back. */
	const removeEntry = (rel: string): boolean => {
		const abs = join(d.doomed, rel);
		const at = join(staging, String(held++));
		seams.beforeStage?.(abs);
		renameSync(abs, at);
		const why = stagedMismatch(at, a.members.get(rel)!, a.frozen.get(rel)!);
		if (why === null) {
			unlinkSync(at);
			return true;
		}
		kept = `${shown(rel)} ${why}; ${putBackStaged(at, abs)}`;
		return false;
	};
	/** Empty the directory `rel` (made writable first); false when something was kept. */
	const purge = (rel: string): boolean => {
		const abs = rel === "" ? d.doomed : join(d.doomed, rel);
		chmodSync(abs, 0o700);
		if (rel === "") {
			mkdirSync(staging, { mode: 0o700 });
			made = true;
		}
		for (const name of readdirSync(abs)) {
			if (rel === "" && name === stagingName) continue;
			const crel = rel === "" ? name : `${rel}/${name}`;
			const e = a.frozen.get(crel);
			if (!e) {
				kept = `${shown(crel)} is not in the archive`;
				return false;
			}
			if (e.type !== "dir") {
				if (!removeEntry(crel)) return false;
				continue;
			}
			const st = lstatSync(join(abs, name), { bigint: true });
			if (!st.isDirectory() || st.ino !== e.ino) {
				kept = `${shown(crel)} is not the directory that was archived`;
				return false;
			}
			if (!purge(crel)) return false;
			try {
				rmdirSync(join(abs, name));
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
				kept = `${shown(crel)} was added to after the archive`;
				return false;
			}
		}
		return true;
	};
	let error: string;
	try {
		if (purge("")) {
			rmdirSync(staging);
			rmdirSync(d.doomed);
			return { kind: "removed", path: d.path };
		}
		error = `${kept}; nothing more was removed`;
	} catch (e) {
		error = kept ? `${kept}; ${message(e)}` : message(e);
	}
	if (made) {
		try {
			rmdirSync(staging);
		} catch (e) {
			error += `; the staging directory ${staging} is left (${message(e)})`;
		}
	}
	const unthawed = restoreModes(d.doomed, a);
	return { kind: "failed", path: d.path, error: `removing ${d.doomed}: ${error}${unthawed ? `; ${unthawed}` : "; every archived entry left has its mode back"}` };
}

/** Why the staged entry `at` may not be removed (null when it may): not the frozen inode, writable, or not what was archived. */
function stagedMismatch(at: string, member: ManifestEntry, frozen: ManifestEntry): string | null {
	const st = lstatSync(at, { bigint: true });
	const type = st.isFile() ? "file" : st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "other";
	if (type !== member.type) return `was replaced (by a ${type})`;
	if (st.ino !== frozen.ino) return "was replaced (another inode)";
	if (type === "link") return readlinkSync(at) === member.target ? null : "was relinked";
	if ((Number(st.mode) & 0o222) !== 0) return "was made writable";
	if (Number(st.size) !== member.size || sha256File(at) !== member.sha256) return "has other contents than the archive";
	return null;
}

/** Put the staged entry `at` back at `to` without replacing anything there; says what became of it. Never throws. */
function putBackStaged(at: string, to: string): string {
	try {
		if (lstatSync(at).isFile()) {
			linkSync(at, to);
			unlinkSync(at);
		} else {
			try {
				lstatSync(to);
				return `kept at ${at} (${to} exists again)`;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
			renameSync(at, to);
		}
		return "kept, put back";
	} catch (e) {
		return `kept at ${at} (${message(e)})`;
	}
}

/**
 * After a purge stopped: give each entry still under `dir` that the freeze recorded (same type and inode) its mode from
 * before the archive, top down; entries the freeze did not record are left as they are, and not entered. Null when all
 * were given back; otherwise what could not be. Never throws.
 */
function restoreModes(dir: string, a: Archived): string | null {
	const bad: string[] = [];
	const stack: string[] = [""];
	while (stack.length > 0) {
		const rel = stack.pop()!;
		const abs = rel === "" ? dir : join(dir, rel);
		try {
			const st = lstatSync(abs, { bigint: true });
			const e = a.frozen.get(rel);
			if (!e || e.ino !== st.ino || e.type === "link") continue;
			if ((e.type === "dir") !== st.isDirectory()) continue;
			chmodSync(abs, a.members.get(rel)!.mode);
			if (st.isDirectory()) for (const name of readdirSync(abs)) stack.push(rel === "" ? name : `${rel}/${name}`);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") bad.push(`${shown(rel)} (${message(e)})`);
		}
	}
	return bad.length ? `the modes of ${bad.length} entries could not be given back: ${bad.slice(0, 3).join("; ")}` : null;
}

export type ExpiryAction = "expired" | "would expire" | "kept" | "expire failed";

export interface ExpiryLine {
	path: string;
	bytes: number | null;
	action: ExpiryAction;
	why: string;
}

/**
 * What an archive-directory file name is: a final archive (ends in exactly `.tar.gz`; its `.offsite` gate always applies),
 * a partial `archiveDetached` left (exactly `<…>.tar.gz.partial-<12 hex>`), or anything else (never touched).
 */
export function archiveNameKind(name: string): "final" | "partial" | null {
	if (name.endsWith(ARCHIVE_SUFFIX)) return "final";
	if (PARTIAL_RE.test(name)) return "partial";
	return null;
}

/**
 * The daily sweep's expiry pass over scratchArchiveBase(home): every regular final archive and partial (archiveNameKind)
 * under a date directory whose mtime is more than `expireDays` before `now` is removed, a final archive with its `.offsite`
 * marker and offsite sidecars; with `requireOffsite`, a final archive with no marker is kept. An offsite sidecar whose
 * archive is gone (`<name>.tar.gz.offsite`, `.attempts`, `.stuck`; the offsite job claimed the archive) is removed once
 * it too is older than `expireDays`: until then it holds its name, so no new archive takes it (`freeName`), and a new
 * archive is never written into a date directory that old. Anything else (verification copies, other files, symlinks) is
 * never touched. A date directory left empty is removed (rmdir, never recursive). `dryRun` removes nothing. Never throws.
 */
export function expireArchives(home: string, config: ScratchArchiveConfig, now: Date, dryRun: boolean, seams: { unlink?: (path: string) => void } = {}): { lines: ExpiryLine[]; notes: string[] } {
	const unlink = seams.unlink ?? unlinkSync;
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
			const path = join(dayDir, name);
			if (name.startsWith(VERIFY_PREFIX)) {
				notes.push(`${path} is a verification copy an archive run left behind; not removed (remove it by hand)`);
				continue;
			}
			const sidecar = [OFFSITE_SUFFIX, ...OFFSITE_SIDECARS].find((s) => name.endsWith(`${ARCHIVE_SUFFIX}${s}`));
			if (sidecar) {
				const orphan = expireOrphanSidecar(path, path.slice(0, -sidecar.length), cutoff, now, dryRun, unlink);
				if (orphan) notes.push(orphan);
				continue;
			}
			const kind = archiveNameKind(name);
			if (kind === null) continue;
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
			if (kind === "final") {
				try {
					hasMarker = lstatSync(marker).isFile();
				} catch {
					hasMarker = false;
				}
				if (config.requireOffsite && !hasMarker) {
					lines.push({ path, bytes: st.size, action: "kept", why: `${ageDays.toFixed(1)} days old, but no ${OFFSITE_SUFFIX} marker (requireOffsite)` });
					continue;
				}
			}
			const why = `${ageDays.toFixed(1)} days old, over ${config.expireDays}${kind === "partial" ? " (a partial archive)" : hasMarker ? ", offsite copy confirmed" : ""}`;
			if (dryRun) {
				lines.push({ path, bytes: st.size, action: "would expire", why });
				continue;
			}
			try {
				unlink(path);
			} catch (e) {
				lines.push({ path, bytes: st.size, action: "expire failed", why: `${why}; ${message(e)}` });
				continue;
			}
			// The archive is gone: the expiry stands whatever becomes of its sidecars, each tried on its own.
			const left: string[] = [];
			if (kind === "final") {
				for (const s of [OFFSITE_SUFFIX, ...OFFSITE_SIDECARS]) {
					const side = `${path}${s}`;
					try {
						if (lstatSync(side).isFile()) unlink(side);
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code !== "ENOENT") left.push(`its ${s} could not be removed (${message(e)})`);
					}
				}
			}
			lines.push({ path, bytes: st.size, action: "expired", why: left.length ? `${why}; ${left.join("; ")}` : why });
			for (const l of left) notes.push(`${path} expired, but ${l}`);
		}
		if (!dryRun) {
			try {
				if (readdirSync(dayDir).length === 0) rmdirSync(dayDir);
			} catch (e) {
				notes.push(`${dayDir} is empty but could not be removed (${message(e)})`);
			}
		}
	}
	return { lines, notes };
}

/** Remove the sidecar `path` when its archive `archive` is gone and its mtime is before `cutoff`; what was done, or null. Never throws. */
function expireOrphanSidecar(path: string, archive: string, cutoff: number, now: Date, dryRun: boolean, unlink: (path: string) => void): string | null {
	try {
		lstatSync(archive);
		return null;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
	}
	let st: Stats;
	try {
		st = lstatSync(path);
	} catch {
		return null;
	}
	if (!st.isFile() || st.mtimeMs >= cutoff) return null;
	const age = ((now.getTime() - st.mtimeMs) / DAY_MS).toFixed(1);
	if (dryRun) return `${path} would be removed: its archive is gone and it is ${age} days old`;
	try {
		unlink(path);
		return `${path} removed: its archive is gone and it was ${age} days old`;
	} catch (e) {
		return `${path} could not be removed (${message(e)}); its archive is gone`;
	}
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
