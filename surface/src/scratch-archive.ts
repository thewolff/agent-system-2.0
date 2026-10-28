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
//   6. runs lsof over the tree (`stillOpen`): a write through a descriptor opened before the rename aside changes no
//      path, so it could land after any check; a file still open, or a missing, failing or timed-out lsof, fails;
//   7. reads the tree's manifest again and compares identities (inode, size, mtime and ctime in nanoseconds, link
//      target): a write anywhere in the tree since step 1 changes the ctime of the entry written, so it fails. On a
//      failure in 6 or 7 the archive is dropped.
// Only then may the caller remove the tree: nothing had a file open in it at step 6, so a later write needs a new open
// by a path that no longer exists. Any failure leaves the tree as it is and says why.
// The daily sweep (surface/scripts/scratch-sweep.ts) expires archives older than `scratchArchive.expireDays`, and, when
// `scratchArchive.requireOffsite` is on, only those with an `<archive>.offsite` marker beside them (written by an offsite
// copy job once its copy is confirmed).
import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmdirSync, rmSync, type Stats, statfsSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { installedConfigPath } from "./pair-suggest";

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
	/** Something that went wrong after the archive was verified (a verification copy left behind); reported, not fatal. */
	warnings: string[];
}

export type ArchiveResult = Archived | { kind: "failed"; reason: string };

/** Test and caller seams of `archiveDetached`. */
export interface ArchiveSeams {
	/** Replaces the statfs read of free bytes on the archive volume. */
	freeBytes?: (path: string) => number | null;
	/** Runs after tar wrote the archive, before it is verified. */
	afterTar?: () => void;
	/** Runs after the archive is verified, hashed and linked, before the tree is read again. */
	beforeFinalCheck?: () => void;
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
 * Archive the detached tree `dir` to `dest` (or the first free `.<n>` variant of it) and verify it (steps 1–6 at the top of
 * this file). Changes nothing in `dir`. Never throws; on failure nothing is left under the destination but what was there.
 */
export function archiveDetached(dir: string, dest: string, seams: ArchiveSeams = {}): ArchiveResult {
	let partial: string | null = null;
	let copy: string | null = null;
	const fail = (reason: string): ArchiveResult => {
		const also: string[] = [];
		if (copy) {
			const r = removeCopy(copy);
			if (r) also.push(r);
		}
		if (partial) {
			try {
				unlinkSync(partial);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") also.push(`the partial archive ${partial} could not be removed (${message(e)})`);
			}
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
		unlinkSync(partial);
		partial = null;
		seams.beforeFinalCheck?.();
		const drop = (): string => {
			try {
				unlinkSync(final);
				return `the archive ${final} was dropped`;
			} catch (e) {
				return `the archive ${final} could not be dropped (${message(e)})`;
			}
		};
		// Writers first, then identities: once lsof shows nothing open, a later write needs a new open by a path that no
		// longer exists, and any write before it shows in the identities read after it.
		const open = stillOpen(dir, seams);
		if (open) return fail(`${dir} is not proven quiet: ${open}; ${drop()}`);
		const changed = identityDiff(before, readManifest(dir, false));
		if (changed.length > 0) return fail(`${dir} changed while it was archived: ${changed.join("; ")}; ${drop()}`);
		return { kind: "archived", path: final, bytes: size, sha256, entries: before.size, members: before, warnings };
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
 * marker; with `requireOffsite`, a final archive with no marker is kept. Anything else (markers alone, verification copies,
 * other files, symlinks) is never touched. A date directory left empty is removed (rmdir, never recursive). `dryRun` removes
 * nothing. Never throws.
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
