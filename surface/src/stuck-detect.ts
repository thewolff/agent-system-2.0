// Stuck-worker detection (workload wl-mvq8x4pkjmx69s, PLAN.md rev 5 D1 and D2): the observation of one test part and
// the pure classifier that decides when a `bun test` worker is positively stuck: hot on every tick, inside one
// `Bun.spawnSync` call (its marker file's flock is held), with the same unreaped (zombie) child of that call's command
// born within 250 ms of the call's start, for `persistMs`. Logs, output timing and other workers are never inputs.
//
// Nothing here spawns a process. Observation is bun:ffi into /usr/lib/libSystem.B.dylib plus node:fs on the marker dir:
//   - sysctl {CTL_KERN, KERN_PROC, KERN_PROC_UID, uid}: every process of a uid, zombies included (xnu walks
//     PROC_ALLPROCLIST | PROC_ZOMBPROCLIST), as an array of struct kinfo_proc;
//   - sysctl {CTL_KERN, KERN_PROCARGS2, pid} (size from KERN_ARGMAX): a process's argv;
//   - proc_pid_rusage(pid, RUSAGE_INFO_V0): user + system CPU in mach absolute time units, scaled by mach_timebase_info;
//   - flock(LOCK_SH | LOCK_NB) on each marker file: EWOULDBLOCK means the worker holds it, i.e. is inside the call.
// Layout (arm64 macOS, as surface/scripts/ps-shim/ps derived it from the SDK): sizeof(struct kinfo_proc) 648;
// p_starttime (struct timeval: tv_sec int64 at 0, tv_usec int32 at 8), p_stat 36 (SZOMB 5), p_pid 40, p_comm 243
// (char[17]), e_ppid 560, e_pgid 564; struct rusage_info_v0: a 16-byte uuid, then ri_user_time and ri_system_time.
// Off darwin, or when the library does not load, every read reports `unavailable` (snapshot) or null/denied, and the
// executor's wall cap remains the only stop.
import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, join } from "node:path";

export type Proc = { pid: number; ppid: number; pgid: number; zombie: boolean; startUs: number; comm: string };
export type Snapshot = { kind: "ok"; procs: Proc[] } | { kind: "denied"; why: string } | { kind: "unavailable"; why: string };
export type Marker = { pid: number; since: number; command: string };
export type Markers = { kind: "ok"; active: Marker[] } | { kind: "denied"; why: string };
export type DetectorOptions = {
	tickMs: number;
	persistMs: number;
	bunPath: string;
	leaderPid: number;
	/** The leader's start time when the caller knows it; otherwise it is learnt from the first snapshot that holds the leader. */
	leaderStartUs?: number;
};
export type Observation = {
	at: number;
	snap: Snapshot;
	markers: Markers;
	cpu: Map<number, number | null>;
	argv: Map<number, string[] | null>;
};
export type Signature = { worker: { pid: number; startUs: number }; zombie: { pid: number; startUs: number }; since: number; command: string };
export type TickResult = {
	/** Signatures holding this tick. */
	signatures: Signature[];
	/** Signatures whose first tick this is. */
	started: Signature[];
	/** Signatures that held on the previous tick and do not now: held ms from their first to their last holding tick. */
	cleared: { sig: Signature; heldMs: number; matched: boolean }[];
	/** Signatures that reached persistMs this tick (once per signature). */
	matched: Signature[];
	/** Every leader/descendant identity seen on any tick so far (pid + startUs; the latest record of each). */
	owned: Proc[];
};

export const STUCK_DEFAULTS = { tickMs: 1000, persistMs: 5000, signatureCaptureMs: 3000, stopGraceMs: 1500, verifyMs: 2000 } as const;
/** A zombie counts only when born no later than this after the marker's since (PLAN D2 condition 3). */
export const BIRTH_WINDOW_MS = 250;
/** Hot: CPU delta at least this share of the wall delta since the previous tick. */
export const HOT_SHARE = 0.8;
/** The one marker format: `<since ms epoch>\t<command>\n`, command = basename of argv[0] cut to 16 (MAXCOMLEN, as p_comm). */
export const MARKER_CONTENT_RE = /^(\d+)\t([^\t\n]{1,16})\n$/;

export function markerContent(since: number, argv0: string): string {
	return `${since}\t${basename(argv0).slice(0, 16)}\n`;
}

// ---- libSystem through bun:ffi ----

const KINFO_SIZE = 648;
const OFF = { startSec: 0, startUsec: 8, stat: 36, pid: 40, comm: 243, commLen: 17, ppid: 560, pgid: 564 } as const;
const SZOMB = 5;
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_UID = 5;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const RUSAGE_INFO_V0 = 0;
const ENOMEM = 12;
const EWOULDBLOCK = 35;
const LOCK_SH = 1;
const LOCK_NB = 4;
const LOCK_UN = 8;
/** darwin's O_CLOEXEC; node:fs constants in bun 1.3.14 do not carry it. */
const O_CLOEXEC = 0x1000000;
/** Records of headroom over the size probe: processes started between the probe and the read. */
const HEADROOM_RECORDS = 32;

type Lib = {
	sysctl: (name: Int32Array, namelen: number, oldp: Uint8Array | null, oldlenp: BigUint64Array, newp: null, newlen: bigint) => number;
	proc_pid_rusage: (pid: number, flavor: number, buffer: BigUint64Array) => number;
	mach_timebase_info: (info: Uint32Array) => number;
	flock: (fd: number, op: number) => number;
	__error: () => number | null;
};

let lib: { ok: true; sym: Lib } | { ok: false; why: string } | undefined;

function libc(): { ok: true; sym: Lib } | { ok: false; why: string } {
	if (lib !== undefined) return lib;
	if (process.platform !== "darwin") return (lib = { ok: false, why: `not darwin (${process.platform})` });
	try {
		const l = dlopen("/usr/lib/libSystem.B.dylib", {
			sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
			proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			__error: { args: [], returns: FFIType.ptr },
		});
		lib = { ok: true, sym: l.symbols as unknown as Lib };
	} catch (e) {
		lib = { ok: false, why: `dlopen /usr/lib/libSystem.B.dylib failed: ${e instanceof Error ? e.message : String(e)}` };
	}
	return lib;
}

function errno(l: Lib): number {
	const p = l.__error();
	return p ? read.i32(p as never, 0) : -1;
}

function sysctl(l: Lib, mib: number[], buf: Uint8Array | null, cap: number): { ok: true; len: number } | { ok: false; errno: number } {
	const len = new BigUint64Array([BigInt(cap)]);
	const rc = l.sysctl(new Int32Array(mib), mib.length, buf, len, null, 0n);
	return rc === 0 ? { ok: true, len: Number(len[0]) } : { ok: false, errno: errno(l) };
}

function parseKinfo(buf: Uint8Array, len: number): Proc[] {
	const dv = new DataView(buf.buffer, buf.byteOffset, len);
	const procs: Proc[] = [];
	for (let o = 0; o + KINFO_SIZE <= len; o += KINFO_SIZE) {
		const comm = buf.subarray(o + OFF.comm, o + OFF.comm + OFF.commLen);
		const nul = comm.indexOf(0);
		procs.push({
			pid: dv.getInt32(o + OFF.pid, true),
			ppid: dv.getInt32(o + OFF.ppid, true),
			pgid: dv.getInt32(o + OFF.pgid, true),
			zombie: dv.getInt8(o + OFF.stat) === SZOMB,
			startUs: Number(dv.getBigInt64(o + OFF.startSec, true)) * 1_000_000 + dv.getInt32(o + OFF.startUsec, true),
			comm: Buffer.from(comm.subarray(0, nul < 0 ? comm.length : nul)).toString("latin1"),
		});
	}
	return procs;
}

/** Spawn-free list of every process of `uid` (sysctl KERN_PROC_UID, zombies included). Never throws. */
export function snapshot(uid: number): Snapshot {
	const l = libc();
	if (!l.ok) return { kind: "unavailable", why: l.why };
	try {
		const mib = [CTL_KERN, KERN_PROC, KERN_PROC_UID, uid];
		for (let attempt = 0; ; attempt++) {
			const probe = sysctl(l.sym, mib, null, 0);
			if (!probe.ok) return { kind: "denied", why: `sysctl(KERN_PROC_UID, ${uid}) size probe: errno ${probe.errno}` };
			const cap = probe.len + KINFO_SIZE * HEADROOM_RECORDS;
			const buf = new Uint8Array(cap);
			const r = sysctl(l.sym, mib, buf, cap);
			if (!r.ok) {
				if (r.errno === ENOMEM && attempt === 0) continue;
				return { kind: "denied", why: `sysctl(KERN_PROC_UID, ${uid}): errno ${r.errno}` };
			}
			if (r.len % KINFO_SIZE !== 0) return { kind: "denied", why: `sysctl(KERN_PROC_UID, ${uid}) returned ${r.len} bytes, not a multiple of the ${KINFO_SIZE}-byte kinfo_proc` };
			return { kind: "ok", procs: parseKinfo(buf, r.len) };
		}
	} catch (e) {
		return { kind: "denied", why: `sysctl(KERN_PROC_UID, ${uid}) threw: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** Live (non-zombie) processes in `s`; for the containment check. */
export function liveProcs(s: Snapshot & { kind: "ok" }): Proc[] {
	return s.procs.filter((p) => !p.zombie);
}

let timebase: { numer: bigint; denom: bigint } | null | undefined;

/** User + system CPU of `pid` in ns; null when it cannot be read (gone, another user's, or unavailable). Never throws. */
export function cpuNs(pid: number): number | null {
	const l = libc();
	if (!l.ok) return null;
	try {
		if (timebase === undefined) {
			const tb = new Uint32Array(2);
			timebase = l.sym.mach_timebase_info(tb) === 0 && tb[0]! > 0 && tb[1]! > 0 ? { numer: BigInt(tb[0]!), denom: BigInt(tb[1]!) } : null;
		}
		if (timebase === null) return null;
		const info = new BigUint64Array(12);
		if (l.sym.proc_pid_rusage(pid, RUSAGE_INFO_V0, info) !== 0) return null;
		return Number(((info[2]! + info[3]!) * timebase.numer) / timebase.denom);
	} catch {
		return null;
	}
}

let argmax: number | null | undefined;

/** The argv of `pid` (KERN_PROCARGS2, parsed as ps-shim does); null when it cannot be read or parsed. Never throws. */
export function procArgv(pid: number): string[] | null {
	const l = libc();
	if (!l.ok) return null;
	try {
		if (argmax === undefined) {
			const b = new Uint8Array(4);
			const r = sysctl(l.sym, [CTL_KERN, KERN_ARGMAX], b, 4);
			argmax = r.ok && r.len === 4 ? new DataView(b.buffer).getInt32(0, true) : null;
		}
		if (argmax === null || argmax <= 0) return null;
		const buf = new Uint8Array(argmax);
		const r = sysctl(l.sym, [CTL_KERN, KERN_PROCARGS2, pid], buf, argmax);
		if (!r.ok || r.len < 4) return null;
		const size = r.len;
		const nargs = new DataView(buf.buffer).getInt32(0, true);
		let cp = 4;
		while (cp < size && buf[cp] !== 0) cp++; // the saved exec_path
		while (cp < size && buf[cp] === 0) cp++; // its trailing NULs
		const argv: string[] = [];
		while (argv.length < nargs && cp < size) {
			let end = cp;
			while (end < size && buf[end] !== 0) end++;
			if (end === size) return null; // an unterminated argument: not the area's shape
			argv.push(Buffer.from(buf.subarray(cp, end)).toString("utf8"));
			cp = end + 1;
		}
		return argv.length === nargs && nargs > 0 ? argv : null;
	} catch {
		return null;
	}
}

/**
 * Active markers (flock held by another open file description) in `dir`; never throws. An entry named `<pid>` that is a
 * regular file (no symlink followed) is opened read-only and probed with flock(LOCK_SH | LOCK_NB): EWOULDBLOCK means
 * active, and its content must be exactly MARKER_CONTENT_RE; a granted lock (inactive, unlocked at once), any other
 * error or any other content leaves the entry out. Only an unreadable dir (or no flock) is `denied`.
 */
export function readMarkers(dir: string): Markers {
	const l = libc();
	if (!l.ok) return { kind: "denied", why: l.why };
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (e) {
		return { kind: "denied", why: `reading ${dir}: ${e instanceof Error ? e.message : String(e)}` };
	}
	const active: Marker[] = [];
	for (const name of names) {
		if (!/^[1-9]\d*$/.test(name)) continue;
		const m = probeMarker(l.sym, join(dir, name));
		if (m) active.push({ pid: Number(name), ...m });
	}
	return { kind: "ok", active };
}

function probeMarker(l: Lib, path: string): { since: number; command: string } | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC);
	} catch {
		return null;
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		if (l.flock(fd, LOCK_SH | LOCK_NB) === 0) {
			l.flock(fd, LOCK_UN);
			return null;
		}
		if (errno(l) !== EWOULDBLOCK) return null;
		const buf = Buffer.alloc(65);
		const n = readSync(fd, buf, 0, buf.length, 0);
		if (n > 64) return null;
		const m = MARKER_CONTENT_RE.exec(buf.subarray(0, n).toString("latin1"));
		return m ? { since: Number(m[1]), command: m[2]! } : null;
	} catch {
		return null;
	} finally {
		try {
			closeSync(fd);
		} catch {}
	}
}

/**
 * One observation (live FFI glue): the uid's snapshot, the marker dir, then CPU and argv of the pids `candidatesOf` names
 * (StuckDetector.candidatesOf). `argvOf` narrows the argv reads (StuckDetector.argvNeeded: once per identity); it
 * defaults to `candidatesOf`. `at` is taken between the snapshot and the CPU reads.
 */
export function observe(o: { uid: number; markerDir: string; candidatesOf: (s: Snapshot) => number[]; argvOf?: (s: Snapshot) => number[] }): Observation {
	const snap = snapshot(o.uid);
	const markers = readMarkers(o.markerDir);
	// Monotonic ms on the epoch scale: tick spacing must not follow wall-clock jumps.
	const at = performance.timeOrigin + performance.now();
	const cpu = new Map<number, number | null>();
	const argv = new Map<number, string[] | null>();
	if (snap.kind === "ok") {
		for (const pid of o.candidatesOf(snap)) cpu.set(pid, cpuNs(pid));
		for (const pid of (o.argvOf ?? o.candidatesOf)(snap)) argv.set(pid, procArgv(pid));
	}
	return { at, snap, markers, cpu, argv };
}

// ---- the classifier (pure) ----

const idOf = (p: { pid: number; startUs: number }): string => `${p.pid}:${p.startUs}`;

/** The processes of `procs` reachable from `roots` by the ppid chain (roots included), each once. */
function tree(procs: Proc[], roots: Proc[]): Proc[] {
	const kids = new Map<number, Proc[]>();
	for (const p of procs) {
		if (p.pid === p.ppid) continue;
		const k = kids.get(p.ppid);
		if (k) k.push(p);
		else kids.set(p.ppid, [p]);
	}
	const seen = new Set<string>();
	const out: Proc[] = [];
	const queue = [...roots];
	while (queue.length > 0) {
		const p = queue.shift()!;
		if (seen.has(idOf(p))) continue;
		seen.add(idOf(p));
		out.push(p);
		// A zombie has no children of its own (the kernel reparents them when it exits).
		if (!p.zombie) queue.push(...(kids.get(p.pid) ?? []));
	}
	return out;
}

/**
 * The live processes of a fresh snapshot that are owned (PLAN D3 teardown): an identity in `owned` (pid and start equal),
 * or a live descendant by the ppid chain of a live owned process.
 */
export function liveOwned(s: Snapshot & { kind: "ok" }, owned: Proc[]): Proc[] {
	const ids = new Set(owned.map(idOf));
	const roots = s.procs.filter((p) => !p.zombie && ids.has(idOf(p)));
	return tree(s.procs, roots).filter((p) => !p.zombie);
}

type Held = { sig: Signature; firstAt: number; lastAt: number; matched: boolean };

export class StuckDetector {
	private readonly o: DetectorOptions;
	private leaderStartUs: number | null;
	private prevAt: number | null = null;
	/** CPU ns on the previous tick, by identity. */
	private prevCpu = new Map<string, number>();
	private readonly argvById = new Map<string, string[]>();
	private readonly ownedById = new Map<string, Proc>();
	private held = new Map<string, Held>();

	constructor(o: DetectorOptions) {
		this.o = o;
		this.leaderStartUs = o.leaderStartUs ?? null;
	}

	/** The leader and its descendants in `s` (the part tree), zombies included; empty when the leader is not in it. */
	private partTree(s: Snapshot): Proc[] {
		if (s.kind !== "ok") return [];
		const leader = s.procs.find((p) => p.pid === this.o.leaderPid && (this.leaderStartUs === null || p.startUs === this.leaderStartUs));
		if (!leader) return [];
		if (this.leaderStartUs === null) this.leaderStartUs = leader.startUs;
		return tree(s.procs, [leader]);
	}

	/** Pids whose CPU an observation reads: the live `bun` processes of the part tree. */
	candidatesOf(s: Snapshot): number[] {
		return this.partTree(s).filter((p) => !p.zombie && p.comm === "bun").map((p) => p.pid);
	}

	/** Of candidatesOf, the pids whose identity has no argv read yet (argv is read once per identity). */
	argvNeeded(s: Snapshot): number[] {
		if (s.kind !== "ok") return [];
		const byPid = new Map(s.procs.map((p) => [p.pid, p]));
		return this.candidatesOf(s).filter((pid) => !this.argvById.has(idOf(byPid.get(pid)!)));
	}

	private isWorker(p: Proc, argv: string[] | undefined): boolean {
		if (p.zombie || p.comm !== "bun" || !argv) return false;
		if (argv[0] !== this.o.bunPath || !argv.includes("test")) return false;
		return p.pid === this.o.leaderPid || argv.includes("--test-worker");
	}

	tick(obs: Observation): TickResult {
		const part = this.partTree(obs.snap);
		for (const p of part) this.ownedById.set(idOf(p), p);
		const dt = this.prevAt === null ? null : obs.at - this.prevAt;
		const gap = dt !== null && dt > 2 * this.o.tickMs;
		const holding: Signature[] = [];
		const cpuNow = new Map<string, number>();
		if (obs.snap.kind === "ok") {
			const snap = obs.snap;
			const active = obs.markers.kind === "ok" ? obs.markers.active : null;
			for (const w of part) {
				const id = idOf(w);
				const fresh = obs.argv.get(w.pid);
				if (fresh && !w.zombie) this.argvById.set(id, fresh);
				if (!this.isWorker(w, this.argvById.get(id))) continue;
				const c = obs.cpu.get(w.pid);
				if (c === null || c === undefined) continue;
				cpuNow.set(id, c);
				const prev = this.prevCpu.get(id);
				const hot = prev !== undefined && dt !== null && dt > 0 && !gap && c - prev >= HOT_SHARE * dt * 1e6;
				if (!hot || active === null) continue;
				for (const m of active) {
					if (m.pid !== w.pid || m.since * 1000 < w.startUs) continue;
					for (const z of snap.procs) {
						if (!z.zombie || z.ppid !== w.pid || z.comm !== m.command) continue;
						if (z.startUs < m.since * 1000 || z.startUs > (m.since + BIRTH_WINDOW_MS) * 1000) continue;
						holding.push({ worker: { pid: w.pid, startUs: w.startUs }, zombie: { pid: z.pid, startUs: z.startUs }, since: m.since, command: m.command });
					}
				}
			}
		}
		this.prevCpu = cpuNow;
		this.prevAt = obs.at;

		const started: Signature[] = [];
		const matched: Signature[] = [];
		const next = new Map<string, Held>();
		for (const sig of holding) {
			const k = `${idOf(sig.worker)}|${idOf(sig.zombie)}|${sig.since}`;
			if (next.has(k)) continue;
			const h = this.held.get(k) ?? { sig, firstAt: obs.at, lastAt: obs.at, matched: false };
			if (!this.held.has(k)) started.push(sig);
			h.lastAt = obs.at;
			if (!h.matched && obs.at - h.firstAt >= this.o.persistMs) {
				h.matched = true;
				matched.push(h.sig);
			}
			next.set(k, h);
		}
		const cleared: TickResult["cleared"] = [];
		for (const [k, h] of this.held) if (!next.has(k)) cleared.push({ sig: h.sig, heldMs: h.lastAt - h.firstAt, matched: h.matched });
		this.held = next;
		return { signatures: [...next.values()].map((h) => h.sig), started, cleared, matched, owned: [...this.ownedById.values()] };
	}
}
