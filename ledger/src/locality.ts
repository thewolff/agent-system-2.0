// Where the ledger file lives, and the refusal to put it on a synced or network folder.
// SPEC-2.0.md § B2 fix 3: v1 ledger state is local, never on a synced or network folder,
// because SQLite WAL does not work over a network filesystem.
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { native, type PasswdResult, type StatfsResult } from "./native";

/** Env var that overrides the ledger path. The M4 raw-write gate matches the same variable. */
export const LEDGER_DB_ENV = "AGENT_SYSTEM_LEDGER_DB";

/** Default ledger file, relative to $HOME. Outside every OMP profile. */
export const DEFAULT_LEDGER_RELATIVE = join(".agent-system-2", "ledger.db");

/**
 * The home every `~/.agent-system-2` path is derived from: `env.HOME`, else this process's HOME.
 * There is no passwd fallback (`os.homedir()`): a process with no HOME fails loudly rather than
 * reaching the developer's own ledger implicitly (PLAN wl-mv4yf3zgf9lm2o § 2 item 3).
 */
export function homeDir(env: Record<string, string | undefined> = process.env): string {
	const home = env.HOME || process.env.HOME;
	if (!home) throw new Error(`HOME is not set: set HOME or ${LEDGER_DB_ENV}`);
	return home;
}

/** $AGENT_SYSTEM_LEDGER_DB if set, else $HOME/.agent-system-2/ledger.db; refused under test when live. */
export function defaultLedgerPath(env: Record<string, string | undefined> = process.env): string {
	const override = env[LEDGER_DB_ENV];
	const path = override && override.trim() !== "" ? resolve(override) : join(homeDir(env), DEFAULT_LEDGER_RELATIVE);
	assertNotLiveLedgerUnderTest(path);
	return path;
}

// ---- tests never reach the live ledger (Guard A) ---------------------------------------------------

/** Set to 1 by ledger/test/isolate-preload.ts once HOME and the ledger path point into a temp home. */
export const TEST_ISOLATED_ENV = "AS2_TEST_ISOLATED";
/** The HOME a preloaded `bun test` started with (empty when unset); its `.agent-system-2` is live. */
export const TEST_REAL_HOME_ENV = "AS2_TEST_REAL_HOME";
/** The AGENT_SYSTEM_LEDGER_DB a preloaded `bun test` started with (empty when unset); its directory is live. */
export const TEST_REAL_LEDGER_DB_ENV = "AS2_TEST_REAL_LEDGER_DB";
/** A `:`-separated list of extra live roots. It only adds roots; it never removes one. */
export const TEST_LIVE_ROOTS_ENV = "AS2_TEST_LIVE_ROOTS";

/** A test process resolved or opened a path inside a live ledger root. */
export class LiveLedgerUnderTestError extends Error {
	override name = "LiveLedgerUnderTestError";
	constructor(readonly path: string, readonly root: string) {
		super(
			`refusing ${path} under test: it is inside ${root}, a live ledger root. ` +
				"Run bun test from the repo root, a module root (classifier/ gates/ ledger/ surface/ tiers/) or a test dir (<module>/test), " +
				"whose bunfig.toml preloads ledger/test/isolate-preload.ts, and pass a temp path.",
		);
	}
}

/**
 * This user's home from the passwd database, through `lookup` (native getpwuid_r in production: no
 * process is started). Not `os.homedir()` or `os.userInfo()`: in Bun both follow the HOME the process
 * started with. A failed lookup throws, so the guard fails closed. Not cached: the in-process lookup
 * costs microseconds, and no remembered answer stands in for a check.
 */
function passwdHome(lookup: LocalityProbe["passwdHome"]): string {
	const uid = process.getuid?.();
	const found: PasswdResult = uid === undefined ? { ok: false, why: "no uid on this platform" } : lookup(uid);
	if (!found.ok) throw new Error(`cannot look up this user's passwd home (${found.why}); refusing to resolve a ledger path under test`);
	return found.home;
}

/** Every live ledger root under test (PLAN wl-mv4yf3zgf9lm2o § 2 item 4), as written. */
function liveRoots(lookup: LocalityProbe["passwdHome"]): string[] {
	const env = process.env;
	const roots = [join(passwdHome(lookup), ".agent-system-2")];
	if (env[TEST_REAL_HOME_ENV]) roots.push(join(env[TEST_REAL_HOME_ENV], ".agent-system-2"));
	if (env[TEST_REAL_LEDGER_DB_ENV]) roots.push(dirname(resolve(env[TEST_REAL_LEDGER_DB_ENV])));
	// Fail closed: a test process no preload isolated still has the developer's HOME and ledger override.
	if (!env[TEST_ISOLATED_ENV]) {
		if (env.HOME) roots.push(join(env.HOME, ".agent-system-2"));
		const override = env[LEDGER_DB_ENV];
		if (override && override.trim() !== "") roots.push(dirname(resolve(override)));
	}
	for (const root of (env[TEST_LIVE_ROOTS_ENV] ?? "").split(":")) if (root.trim() !== "") roots.push(resolve(root));
	return roots;
}

/**
 * The form the guard compares: canonicalPath, or the lexical path when it cannot be resolved (a
 * component this uid cannot read, a symlink loop). A path this uid cannot resolve it cannot open
 * either, and the caller's own resolution reports why; gates/src/rows/r10-raw-ledger.ts does the
 * same for EACCES/EPERM (item 24). APFS is case-insensitive by default, and a not-yet-existing
 * remainder keeps its spelling, so macOS compares case-folded.
 */
function comparablePath(path: string): string {
	let p: string;
	try {
		p = canonicalPath(path);
	} catch (err) {
		const code = err instanceof Error && "code" in err ? err.code : undefined;
		if (!(err instanceof LedgerLocationError) && code !== "EACCES" && code !== "EPERM" && code !== "ELOOP") throw err;
		p = resolve(path);
	}
	return process.platform === "darwin" ? p.toLowerCase() : p;
}

/**
 * Under test, throws LiveLedgerUnderTestError when `path` (canonicalised) is inside a live ledger
 * root (canonicalised). Outside a test process it returns at once: no lookup.
 */
function notLiveUnderTest(probe: LocalityProbe, path: string): void {
	// Active in a `bun test` process (NODE_ENV=test) or one the preload isolated.
	if (process.env.NODE_ENV !== "test" && !process.env[TEST_ISOLATED_ENV]) return;
	const real = comparablePath(path);
	for (const root of liveRoots(probe.passwdHome)) {
		const canon = comparablePath(root);
		if (real === canon || real.startsWith(canon + sep)) throw new LiveLedgerUnderTestError(resolve(path), root);
	}
}

/**
 * Folders, relative to $HOME, that a sync client owns on macOS or commonly owns elsewhere.
 * Desktop and Documents are included because macOS "Desktop & Documents in iCloud" syncs them.
 */
export const SYNCED_HOME_FOLDERS = [
	join("Library", "Mobile Documents"),
	join("Library", "CloudStorage"),
	"Desktop",
	"Documents",
	"Dropbox",
	"Google Drive",
	"OneDrive",
	"Box",
	"Box Sync",
	"iCloud Drive",
	"pCloud Drive",
];

/** Filesystem types refused on Linux (from /proc/self/mountinfo). macOS uses the MNT_LOCAL mount flag instead. */
export const NETWORK_FS_TYPES: Record<string, true> = {
	nfs: true, nfs4: true, cifs: true, smb: true, smb3: true, smbfs: true, afs: true, afpfs: true,
	webdav: true, davfs: true, "fuse.sshfs": true, sshfs: true, "9p": true, ceph: true, glusterfs: true,
	"fuse.rclone": true, "fuse.s3fs": true, lustre: true,
};

export class LedgerLocationError extends Error {}

/**
 * The path the operating system would actually open for `path`, which need not exist yet: the
 * nearest existing ancestor (looked up without following it) resolved through every symlink,
 * plus the not-yet-existing remainder. A dangling symlink is followed to where it points, since
 * opening it would create its target.
 */
export function canonicalPath(path: string, hops = 0): string {
	if (hops > 40) throw new LedgerLocationError(`too many symbolic links resolving ${path}`);
	let head = resolve(path);
	const rest: string[] = [];
	for (;;) {
		let isLink: boolean | null = null;
		try {
			isLink = lstatSync(head).isSymbolicLink();
		} catch {
			// head does not exist; walk up
		}
		if (isLink !== null) {
			if (isLink && !existsSync(head)) return canonicalPath(join(linkTarget(head, hops), ...rest), hops + 1);
			try {
				return join(realpathSync(head), ...rest);
			} catch (err) {
				// Bun's realpathSync (1.3.14, macOS) throws EOPNOTSUPP on a unix socket, or a symlink
				// to one (/var/run/docker.sock, /var/run/mDNSResponder). Resolve it by hand: follow the
				// link the way the dangling case does, else the canonical parent plus the entry's name.
				if (!(err instanceof Error && "code" in err && err.code === "EOPNOTSUPP")) throw err;
				if (isLink) return canonicalPath(join(linkTarget(head, hops), ...rest), hops + 1);
				return join(realpathSync(dirname(head)), basename(head), ...rest);
			}
		}
		const up = dirname(head);
		if (up === head) return join(head, ...rest);
		rest.unshift(basename(head));
		head = up;
	}
}

/**
 * Where the symlink `link` points, resolved as pathname resolution does (POSIX base definitions
 * § 4.16): a relative target starts from the directory that really contains the link, not its
 * spelling, and each `..` is the physical parent of the component resolved before it. Collapsing
 * the target lexically instead names the wrong file when a directory on the way is itself a link
 * (PR #39 review). Every component goes back through canonicalPath, so the hop limit still holds.
 */
function linkTarget(link: string, hops: number): string {
	const target = readlinkSync(link);
	let at = isAbsolute(target) ? sep : realpathSync(dirname(link));
	for (const part of target.split(sep)) {
		if (part === "" || part === ".") continue;
		at = part === ".." ? dirname(at) : canonicalPath(join(at, part), hops + 1);
	}
	return at;
}

/** The nearest existing ancestor of `path` (the file itself may not exist yet). */
function existingAncestor(path: string): string {
	let p = resolve(path);
	while (!existsSync(p)) {
		const up = dirname(p);
		if (up === p) break;
		p = up;
	}
	return p;
}

/** glibc's gnu_dev_major/gnu_dev_minor of a 64-bit dev_t, as `major:minor` the way mountinfo prints it. */
function majorMinor(dev: bigint): string {
	const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
	const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
	return `${major}:${minor}`;
}

/**
 * Linux locality of `path`, whose st_dev is `dev`, from the text of /proc/self/mountinfo (proc(5)):
 * `id parent major:minor root mount-point options [optional fields] - fstype source super-options`.
 * The entries of the path's own device are the candidates: one device is one superblock, so a hidden
 * or bind-mounted entry of it has the same type, and a mount hidden under another one is a different
 * device. A malformed line (an empty field, a relative mount point) refuses (unknown), it is never skipped.
 */
export function linuxLocality(mountinfo: string, dev: bigint, path: string): string {
	const device = majorMinor(dev);
	const candidates: { mountPoint: string; fsType: string }[] = [];
	for (const line of mountinfo.split("\n")) {
		if (line === "") continue;
		const f = line.split(" ");
		const dash = f.indexOf("-", 6);
		if (f.includes("") || !/^\d+$/.test(f[0] ?? "") || !/^\d+$/.test(f[1] ?? "") || !/^\d+:\d+$/.test(f[2] ?? "") || !(f[4] ?? "").startsWith("/") || dash < 0 || f.length !== dash + 4) {
			return `unknown:malformed /proc/self/mountinfo line: ${line}`;
		}
		if (f[2] !== device) continue;
		const mountPoint = (f[4] ?? "").replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
		candidates.push({ mountPoint, fsType: f[dash + 1] ?? "" });
	}
	if (candidates.length === 0) return `unknown:no mountinfo entry for device ${device} (${path})`;
	const network = candidates.find((c) => Object.hasOwn(NETWORK_FS_TYPES, c.fsType));
	return network ? `network:${network.mountPoint} is ${network.fsType}` : "local";
}

/** "local" | "network:<why>" | "unknown:<why>", for the nearest existing ancestor of `path`. */
function locality(probe: LocalityProbe, path: string): string {
	const target = existingAncestor(path);
	if (probe.platform === "darwin") {
		const fs = probe.statfs(target);
		if (!fs.ok) return `unknown:statfs failed: ${fs.why}`;
		return fs.local ? "local" : `network:${fs.mountOn} is mounted without the local flag (${fs.fsType})`;
	}
	if (probe.platform === "linux") {
		const mountinfo = probe.mountinfo();
		if (mountinfo === null) return "unknown:cannot read /proc/self/mountinfo";
		let dev: bigint;
		try {
			dev = statSync(target, { bigint: true }).dev;
		} catch (e) {
			return `unknown:stat ${target}: ${e instanceof Error ? e.message : String(e)}`;
		}
		return linuxLocality(mountinfo, dev, target);
	}
	return "unknown:unsupported platform";
}

/**
 * Throws LedgerLocationError when `path` sits under a sync-client folder of `home` or on a
 * non-local mount; otherwise returns the canonical path (symlinks resolved), which is the path
 * the caller must open. The path and each synced root are compared both as written and after
 * canonicalisation, so a symlink into a synced folder, a synced folder that is itself a symlink,
 * and a symlinked $HOME are all refused. An undeterminable mount is refused too: the rule is
 * "never on a network folder", so an unknown answer is not a pass.
 */
function localPath(probe: LocalityProbe, path: string, home: string): string {
	const abs = resolve(path);
	const real = canonicalPath(abs);
	for (const rel of SYNCED_HOME_FOLDERS) {
		const lexicalRoot = join(resolve(home), rel);
		for (const root of [lexicalRoot, canonicalPath(lexicalRoot)]) {
			for (const candidate of [abs, real]) {
				if (candidate === root || candidate.startsWith(root + sep)) {
					const via = candidate === abs ? "" : ` (${abs} resolves to it)`;
					throw new LedgerLocationError(`ledger path ${candidate}${via} is inside ${root}, a synced folder; set ${LEDGER_DB_ENV} to a local path`);
				}
			}
		}
	}
	const where = locality(probe, real);
	if (where !== "local") {
		throw new LedgerLocationError(`ledger path ${real} is not on a local filesystem (${where}); set ${LEDGER_DB_ENV} to a local path`);
	}
	return real;
}

// ---- the guards, bound to what they ask the system ----------------------------------------------

/** What the locality guards ask the system. Production asks REAL_PROBE; tests build their own guard set. */
export interface LocalityProbe {
	/** Whose mount rules apply: statfs on darwin, mountinfo on linux. */
	platform: NodeJS.Platform;
	statfs(path: string): StatfsResult;
	/** The text of /proc/self/mountinfo, or null when it cannot be read. */
	mountinfo(): string | null;
	passwdHome(uid: number): PasswdResult;
}

export interface LocalityGuards {
	/** "local" | "network:<why>" | "unknown:<why>". */
	mountLocality(path: string): string;
	assertLocalPath(path: string, home?: string): string;
	assertNotLiveLedgerUnderTest(path: string): void;
}

/** The guards asking `probe`. Not re-exported by ./index.ts: only the REAL_PROBE set below reaches Ledger.open. */
export function localityGuards(probe: LocalityProbe): LocalityGuards {
	return {
		mountLocality: (path) => locality(probe, path),
		assertLocalPath: (path, home = process.env.HOME ?? homedir()) => localPath(probe, path, home),
		assertNotLiveLedgerUnderTest: (path) => notLiveUnderTest(probe, path),
	};
}

/** In process, no child: native statfs and getpwuid_r (./native.ts), /proc/self/mountinfo read as a file. */
const REAL_PROBE: LocalityProbe = {
	platform: process.platform,
	statfs: (path) => native.statfsMount(path),
	mountinfo: () => {
		try {
			return readFileSync("/proc/self/mountinfo", "utf8");
		} catch {
			return null;
		}
	},
	passwdHome: (uid) => native.passwdHomeOf(uid),
};

export const { mountLocality, assertLocalPath, assertNotLiveLedgerUnderTest }: LocalityGuards = localityGuards(REAL_PROBE);
