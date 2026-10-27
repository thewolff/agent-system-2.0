// Where the ledger file lives, and the refusal to put it on a synced or network folder.
// SPEC-2.0.md § B2 fix 3: v1 ledger state is local, never on a synced or network folder,
// because SQLite WAL does not work over a network filesystem.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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

let passwdHomeCache: string | undefined;

/**
 * This user's home from the passwd database, looked up once per process. Not `os.homedir()` or
 * `os.userInfo()`: in Bun both follow the HOME the process started with. Only absolute-path tools
 * are run, with an empty env. A failed lookup throws, so the guard fails closed.
 */
function passwdHome(): string {
	if (passwdHomeCache !== undefined) return passwdHomeCache;
	const uid = process.getuid?.();
	const fail = (why: string): never => {
		throw new Error(`cannot look up this user's passwd home (${why}); refusing to resolve a ledger path under test`);
	};
	if (uid === undefined) return fail("no uid on this platform");
	const getent = ["/usr/bin/getent", "/bin/getent"].find((p) => existsSync(p));
	const [cmd, field]: [string[], number] = process.platform === "darwin"
		? [["/usr/bin/id", "-P", String(uid)], 8]
		: getent ? [[getent, "passwd", String(uid)], 5] : fail("no getent");
	let line: string | undefined;
	let why: string;
	try {
		const out = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: {} });
		line = out.exitCode === 0 ? out.stdout.toString().trim().split("\n")[0] : undefined;
		why = `${cmd.join(" ")} exited ${out.exitCode}: ${out.stderr.toString().trim()}`;
	} catch (e) {
		return fail(`${cmd[0]}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const home = line?.split(":")[field];
	if (!home || !isAbsolute(home)) return fail(why);
	passwdHomeCache = home;
	return home;
}

/** Every live ledger root (PLAN wl-mv4yf3zgf9lm2o § 2 item 4), as written: the test guard's, and the Jo-only boundary's outside test too (PLAN wl-mv654hoqwpfhmo § 6.3 item 1). */
function liveRoots(): string[] {
	const env = process.env;
	const roots = [join(passwdHome(), ".agent-system-2")];
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

/** The live root `path` (canonicalised) is inside (each root canonicalised), or null. Throws when the passwd home cannot be looked up. */
function liveRootOf(path: string): string | null {
	const real = comparablePath(path);
	for (const root of liveRoots()) {
		const canon = comparablePath(root);
		if (real === canon || real.startsWith(canon + sep)) return root;
	}
	return null;
}

/**
 * Under test, throws LiveLedgerUnderTestError when `path` (canonicalised) is inside a live ledger
 * root (canonicalised). Outside a test process it returns at once: no lookup, no spawn.
 */
export function assertNotLiveLedgerUnderTest(path: string): void {
	// Active in a `bun test` process (NODE_ENV=test) or one the preload isolated.
	if (process.env.NODE_ENV !== "test" && !process.env[TEST_ISOLATED_ENV]) return;
	const root = liveRootOf(path);
	if (root !== null) throw new LiveLedgerUnderTestError(resolve(path), root);
}

/**
 * Is `path` inside a live ledger root, in a test process or not? The Jo-only boundary
 * (ledger/src/authority.ts) puts its triggers on an agent's connection to such a file. In a test process the
 * preload's isolation applies (its temp HOME and ledger are not live); elsewhere HOME's and
 * AGENT_SYSTEM_LEDGER_DB's roots are. Throws when the passwd home cannot be looked up.
 */
export function inLiveRoot(path: string): boolean {
	return liveRootOf(path) !== null;
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

/** Filesystem types refused on Linux (from /proc/mounts). macOS uses the "local" mount flag instead. */
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

type DfResult = { mp: string } | { why: string };

function mountPointOf(path: string): DfResult {
	const out = Bun.spawnSync(["df", "-P", path], { stdout: "pipe", stderr: "pipe" });
	if (out.exitCode !== 0) {
		const ended = out.exitCode ?? out.signalCode ?? "an unknown status";
		const first = out.stderr.toString().trim().split("\n")[0] ?? "";
		return { why: `unknown:df exited ${ended}: ${first}` };
	}
	const lines = out.stdout.toString().trim().split("\n");
	const last = lines[lines.length - 1]?.trim().split(/\s+/);
	// POSIX df -P: Filesystem, blocks, used, available, capacity, mounted-on (may contain spaces).
	return last && last.length >= 6 ? { mp: last.slice(5).join(" ") } : { why: "unknown:df printed no mount point" };
}

// ---- arm64 macOS: statfs(2) through bun:ffi, no child process ---------------------------------------
//
// struct statfs layout (arm64, 64-bit inode statfs), read with
// `clang -arch arm64 -S` of `offsetof(struct statfs, …)` against <sys/mount.h>:
//   f_flags      offset 64
//   f_fstypename offset 72   (char[16], MFSTYPENAMELEN)
//   f_mntonname  offset 88   (char[1024], MAXPATHLEN)
//   sizeof(struct statfs) = 2168, MNT_LOCAL = 0x1000
// ledger/test/ledger.test.ts checks the answers against /sbin/mount, so a layout change fails there.
const STATFS_SIZE = 2168;
const STATFS_F_FLAGS = 64;
const STATFS_F_FSTYPENAME = 72;
const STATFS_F_MNTONNAME = 88;
const MNT_LOCAL = 0x1000;

type Libc = { statfs: (path: Uint8Array, buf: Uint8Array) => number; errnoPtr: () => number };
let libc: Libc | undefined;

function loadLibc(): Libc {
	if (libc) return libc;
	const lib = dlopen("/usr/lib/libSystem.B.dylib", {
		statfs: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		__error: { args: [], returns: FFIType.ptr },
	});
	libc = {
		statfs: (path, buf) => lib.symbols.statfs(ptr(path), ptr(buf)),
		errnoPtr: () => {
			const at = lib.symbols.__error();
			return at === null ? -1 : read.i32(at);
		},
	};
	return libc;
}

function cString(buf: Uint8Array, at: number, max: number): string {
	let end = at;
	while (end < at + max && buf[end] !== 0) end++;
	return Buffer.from(buf.subarray(at, end)).toString("utf8");
}

function statfsLocality(target: string): string {
	const c = loadLibc();
	const buf = new Uint8Array(STATFS_SIZE);
	if (c.statfs(Buffer.from(`${target}\0`), buf) !== 0) return `unknown:statfs failed (errno ${c.errnoPtr()})`;
	const flags = new DataView(buf.buffer).getUint32(STATFS_F_FLAGS, true);
	if ((flags & MNT_LOCAL) !== 0) return "local";
	return `network:${cString(buf, STATFS_F_MNTONNAME, 1024)} is mounted without the local flag (${cString(buf, STATFS_F_FSTYPENAME, 16)})`;
}

/** "local" | "network:<why>" | "unknown:<why>". */
export function mountLocality(path: string): string {
	const target = existingAncestor(path);
	if (process.platform === "darwin" && process.arch === "arm64") return statfsLocality(target);
	const found = mountPointOf(target);
	if ("why" in found) return found.why;
	const mp = found.mp;
	if (process.platform === "darwin") {
		const out = Bun.spawnSync(["/sbin/mount"], { stdout: "pipe", stderr: "pipe" });
		const line = out.stdout.toString().split("\n").find((l) => l.includes(` on ${mp} (`));
		if (!line) return `unknown:no mount entry for ${mp}`;
		const flags = line.slice(line.lastIndexOf("(") + 1, line.lastIndexOf(")")).split(",").map((s) => s.trim());
		return flags.includes("local") ? "local" : `network:${mp} is mounted without the local flag (${flags[0]})`;
	}
	if (existsSync("/proc/mounts")) {
		const entry = readFileSync("/proc/mounts", "utf8").split("\n").map((l) => l.split(" "))
			.find((f) => f[1]?.replace(/\\040/g, " ") === mp);
		if (!entry) return `unknown:no /proc/mounts entry for ${mp}`;
		return Object.hasOwn(NETWORK_FS_TYPES, entry[2] ?? "") ? `network:${mp} is ${entry[2]}` : "local";
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
export function assertLocalPath(path: string, home: string = process.env.HOME ?? homedir()): string {
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
	const where = mountLocality(real);
	if (where !== "local") {
		throw new LedgerLocationError(`ledger path ${real} is not on a local filesystem (${where}); set ${LEDGER_DB_ENV} to a local path`);
	}
	return real;
}
