// The system facts the locality guards (./locality.ts) need, read in process through bun:ffi:
// statfs(2) for a path's mount (macOS) and getpwuid_r(3) for a user's passwd home. Nothing here
// starts a process: Bun 1.3.14's spawnSync can lose a child's reap and spin forever
// (oven-sh/bun#46488), and Ledger.open runs these checks on every open (PLAN wl-mvq8x4l6zubxfk D1).
// Nothing is cached but the library handle. A load or symbol failure is kept for the instance and
// returned on every call, and every malformed answer is refused: the caller fails closed.
import { dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";

export type StatfsResult = { ok: true; local: boolean; mountOn: string; fsType: string } | { ok: false; why: string };
export type PasswdResult = { ok: true; home: string } | { ok: false; why: string };

/** Byte offsets in a 64-bit `struct passwd`. */
export interface PasswdLayout {
	size: number;
	uid: number;
	dir: number;
}

/** Darwin from the SDK's pwd.h (arm64 and x86_64 alike), Linux from glibc's pwd.h. */
const PASSWD_LAYOUT: Partial<Record<NodeJS.Platform, PasswdLayout>> = {
	darwin: { size: 72, uid: 16, dir: 48 },
	linux: { size: 48, uid: 16, dir: 32 },
};

// Darwin `struct statfs` (64-bit inodes), the same on arm64 and x86_64.
const STATFS_SIZE = 2168;
const F_FLAGS = 64;
const F_FSTYPENAME = 72;
const MFSTYPENAMELEN = 16;
const F_MNTONNAME = 88;
const MAXPATHLEN = 1024;
const MNT_LOCAL = 0x1000;
/** x86_64 keeps the 32-bit-inode `statfs` for old binaries; the 64-bit-inode one is `statfs$INODE64`. */
const STATFS_SYMBOL: Partial<Record<string, string>> = { arm64: "statfs", x64: "statfs$INODE64" };

const ERANGE = 34;
const PASSWD_BUF = 16 * 1024;
const PASSWD_BUF_RETRY = 64 * 1024;

const DEFAULT_LIB: Partial<Record<NodeJS.Platform, string>> = { darwin: "/usr/lib/libSystem.B.dylib", linux: "libc.so.6" };

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The NUL-terminated string at `start` that ends within `max` bytes; null when unterminated or not UTF-8. */
function cString(bytes: Uint8Array, start: number, max: number): string | null {
	const field = bytes.subarray(start, start + max);
	const end = field.indexOf(0);
	if (end < 0) return null;
	try {
		return UTF8.decode(field.subarray(0, end));
	} catch {
		return null;
	}
}

/** The answer in a filled Darwin `struct statfs`, or why it cannot be trusted. */
export function decodeStatfs(bytes: Uint8Array): StatfsResult {
	if (bytes.length < STATFS_SIZE) return { ok: false, why: `statfs buffer is ${bytes.length} bytes, not ${STATFS_SIZE}` };
	const fsType = cString(bytes, F_FSTYPENAME, MFSTYPENAMELEN);
	if (!fsType || !/^[\x20-\x7e]+$/.test(fsType)) return { ok: false, why: "statfs f_fstypename is not a terminated printable name" };
	const mountOn = cString(bytes, F_MNTONNAME, MAXPATHLEN);
	if (!mountOn?.startsWith("/")) return { ok: false, why: "statfs f_mntonname is not a terminated absolute path" };
	const flags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(F_FLAGS, true);
	return { ok: true, local: (flags & MNT_LOCAL) !== 0, mountOn, fsType };
}

/** One getpwuid_r call as made: the struct and string buffer it filled, and the addresses it was given and returned. */
export interface PasswdCall {
	pwdBytes: Uint8Array;
	pwdAddr: number;
	resultAddr: number;
	bufBytes: Uint8Array;
	bufAddr: number;
	uid: number;
	layout: PasswdLayout;
}

/**
 * The home in a getpwuid_r answer that returned 0, or why it cannot be trusted. `pw_dir` must point
 * into the caller's string buffer, and the home is read from that buffer's own bytes, never through
 * the raw pointer.
 */
export function decodePasswd(c: PasswdCall): PasswdResult {
	if (c.resultAddr === 0) return { ok: false, why: `no passwd entry for uid ${c.uid}` };
	if (c.resultAddr !== c.pwdAddr) return { ok: false, why: "getpwuid_r result is not the passwd struct it was given" };
	if (c.pwdBytes.length < c.layout.size) return { ok: false, why: `passwd struct is ${c.pwdBytes.length} bytes, not ${c.layout.size}` };
	const pwd = new DataView(c.pwdBytes.buffer, c.pwdBytes.byteOffset, c.pwdBytes.byteLength);
	const pwUid = pwd.getUint32(c.layout.uid, true);
	if (pwUid !== c.uid) return { ok: false, why: `passwd entry is for uid ${pwUid}, not ${c.uid}` };
	const offset = pwd.getBigUint64(c.layout.dir, true) - BigInt(c.bufAddr);
	if (offset < 0n || offset >= BigInt(c.bufBytes.length)) return { ok: false, why: "pw_dir points outside the lookup buffer" };
	const home = cString(c.bufBytes, Number(offset), c.bufBytes.length);
	if (home === null) return { ok: false, why: "pw_dir is not a terminated string inside the lookup buffer" };
	if (!home.startsWith("/")) return { ok: false, why: `pw_dir ${home} is not absolute` };
	return { ok: true, home };
}

export interface NativeOptions {
	/** The C library to load. Default: libSystem on macOS, glibc's libc.so.6 on Linux. */
	libPath?: string;
	/** Symbol names to bind. Default: `statfs` (arm64) or `statfs$INODE64` (x86_64), and `getpwuid_r`. */
	symbols?: { statfs?: string; getpwuid_r?: string };
}

export interface Native {
	/** The mount holding `path` (which must exist): whether it carries MNT_LOCAL, where it is mounted, its type. macOS only. */
	statfsMount(path: string): StatfsResult;
	/** `uid`'s home directory from the passwd database. macOS and glibc Linux. */
	passwdHomeOf(uid: number): PasswdResult;
}

type NativeFn = (...args: unknown[]) => unknown;
type Loaded = { ok: true; fns: Record<string, NativeFn> } | { ok: false; why: string };

/** dlopen on first use. The outcome, a failure included, is kept for this binding and never retried. */
function lazyLibrary(libPath: string | undefined, defs: Record<string, { args: FFIType[]; returns: FFIType }>): () => Loaded {
	let loaded: Loaded | undefined;
	return () => (loaded ??= load(libPath, defs));
}

function load(libPath: string | undefined, defs: Record<string, { args: FFIType[]; returns: FFIType }>): Loaded {
	if (!libPath) return { ok: false, why: `no C library known on ${process.platform}` };
	try {
		return { ok: true, fns: dlopen(libPath, defs).symbols as unknown as Record<string, NativeFn> };
	} catch (e) {
		return { ok: false, why: `dlopen ${libPath}: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/**
 * getpwuid_r into fresh ArrayBuffer-backed memory. Each address is taken once from its ArrayBuffer,
 * whose storage Bun does not move (a typed array's may move when its `.buffer` is first made).
 */
function callGetpwuid(fn: NativeFn, uid: number, layout: PasswdLayout, buflen: number): { rc: number; call: PasswdCall } {
	const pwd = new ArrayBuffer(layout.size);
	const buf = new ArrayBuffer(buflen);
	const result = new ArrayBuffer(8);
	const pwdAddr = ptr(pwd);
	const bufAddr = ptr(buf);
	const rc = fn(uid, pwdAddr, bufAddr, buflen, ptr(result)) as number;
	const resultAddr = Number(new DataView(result).getBigUint64(0, true));
	return { rc, call: { pwdBytes: new Uint8Array(pwd), pwdAddr, resultAddr, bufBytes: new Uint8Array(buf), bufAddr, uid, layout } };
}

/** A binding of statfsMount and passwdHomeOf to one library and symbol set; tests use their own to reach real failures. */
export function openNative(opts: NativeOptions = {}): Native {
	const libPath = opts.libPath ?? DEFAULT_LIB[process.platform];
	const statfsName = opts.symbols?.statfs ?? STATFS_SYMBOL[process.arch];
	const pwName = opts.symbols?.getpwuid_r ?? "getpwuid_r";
	const statfsLib = lazyLibrary(libPath, {
		[statfsName ?? "statfs"]: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		__error: { args: [], returns: FFIType.ptr },
	});
	const pwLib = lazyLibrary(libPath, { [pwName]: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 } });

	function statfsMount(path: string): StatfsResult {
		if (process.platform !== "darwin") return { ok: false, why: `statfs is not used on ${process.platform}` };
		if (!statfsName) return { ok: false, why: `no statfs symbol known for ${process.arch}` };
		if (path.includes("\0")) return { ok: false, why: "statfs: the path holds a NUL byte" };
		const lib = statfsLib();
		if (!lib.ok) return lib;
		const out = new ArrayBuffer(STATFS_SIZE);
		const rc = lib.fns[statfsName]!(new TextEncoder().encode(`${path}\0`), ptr(out)) as number;
		if (rc !== 0) return { ok: false, why: `statfs ${path}: errno ${read.i32(lib.fns.__error!() as Pointer)}` };
		return decodeStatfs(new Uint8Array(out));
	}

	function passwdHomeOf(uid: number): PasswdResult {
		const layout = PASSWD_LAYOUT[process.platform];
		if (!layout) return { ok: false, why: `no passwd layout known for ${process.platform}` };
		if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) return { ok: false, why: `${uid} is not a uid` };
		const lib = pwLib();
		if (!lib.ok) return lib;
		const fn = lib.fns[pwName]!;
		let answer = callGetpwuid(fn, uid, layout, PASSWD_BUF);
		if (answer.rc === ERANGE) answer = callGetpwuid(fn, uid, layout, PASSWD_BUF_RETRY);
		if (answer.rc !== 0) return { ok: false, why: `getpwuid_r(${uid}) returned ${answer.rc}` };
		return decodePasswd(answer.call);
	}

	return { statfsMount, passwdHomeOf };
}

/** The binding the production locality guards use. */
export const native: Native = openNative();
