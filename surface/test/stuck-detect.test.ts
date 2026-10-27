// The stuck-worker detector (surface/src/stuck-detect.ts; workload wl-mvq8x4pkjmx69s, PLAN.md rev 5 D1, D2, slice
// sl-sd-observe). The classifier is pure and is driven here by synthetic observations: one positive shape (a hot
// candidate worker whose marker flock is held, with an unreaped child of the marker's command born within 250 ms of the
// call's start, for persistMs), every reset cause, and the negative controls. The observation half is exercised live
// through bun:ffi against real processes this file spawns (the module itself spawns nothing).
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIRTH_WINDOW_MS, cpuNs, liveOwned, liveProcs, MARKER_CONTENT_RE, markerContent, observe, procArgv, readMarkers, snapshot, STUCK_DEFAULTS, StuckDetector } from "../src/stuck-detect";
import type { Marker, Observation, Proc, Signature, Snapshot, TickResult } from "../src/stuck-detect";

// ---- synthetic observations ----

const BUN = "/opt/bun/bin/bun";
const T0 = 1_800_000_000_000; // ms; tick clock
const SINCE = 1_800_000_100_000; // ms epoch: the marker's call start
const W_START = (SINCE - 60_000) * 1000; // µs: the worker started a minute before the call
const OPTS = { tickMs: 1000, persistMs: 5000, bunPath: BUN, leaderPid: 100 };

const proc = (pid: number, ppid: number, o: Partial<Proc> = {}): Proc => ({ pid, ppid, pgid: o.pgid ?? 100, zombie: false, startUs: W_START - 1_000_000, comm: "bun", ...o });
const LEADER = proc(100, 99, { startUs: W_START - 2_000_000 });
const WORKER = proc(101, 100, { pgid: 101, startUs: W_START });
const ZOMBIE = proc(200, 101, { pgid: 101, zombie: true, startUs: (SINCE + 100) * 1000, comm: "true" });
const MARKER: Marker = { pid: 101, since: SINCE, command: "true" };
const LEADER_ARGV = [BUN, "test", "--parallel=2", "surface/test"];
const WORKER_ARGV = [BUN, "test", "--test-worker", "--isolate", "--preload", "./ledger/test/isolate-preload.ts"];

type World = { procs: Proc[]; markers: Marker[] | "denied"; cpu: Record<number, number | null>; argv: Record<number, string[] | null>; snap?: "denied" | "unavailable" };

/** A healthy worldview: the leader, one worker inside a spawnSync call (marker held) with an unreaped child, both bun. */
function world(o: Partial<World> = {}): World {
	return { procs: [LEADER, WORKER, ZOMBIE], markers: [MARKER], cpu: {}, argv: { 100: LEADER_ARGV, 101: WORKER_ARGV }, ...o };
}

function obsOf(at: number, w: World): Observation {
	const snap: Snapshot = w.snap === "denied" ? { kind: "denied", why: "test" } : w.snap === "unavailable" ? { kind: "unavailable", why: "test" } : { kind: "ok", procs: w.procs };
	return {
		at,
		snap,
		markers: w.markers === "denied" ? { kind: "denied", why: "test" } : { kind: "ok", active: w.markers },
		cpu: new Map(Object.entries(w.cpu).map(([k, v]) => [Number(k), v])),
		argv: new Map(Object.entries(w.argv).map(([k, v]) => [Number(k), v])),
	};
}

/**
 * Drives a detector through ticks 0..n-1 at T0 + k * tickMs (or `atOf(k)`). `cpuOf(k)` gives the worker's CPU ns (hot: one
 * full second per tick); `edit(k, w)` changes the world on tick k. Returns every tick's result.
 */
function run(n: number, edit: (k: number, w: World) => World = (_k, w) => w, o: { atOf?: (k: number) => number; cpuOf?: (k: number) => number; opts?: Partial<typeof OPTS> } = {}): TickResult[] {
	const det = new StuckDetector({ ...OPTS, ...o.opts });
	const cpuOf = o.cpuOf ?? ((k: number) => k * 1e9);
	const out: TickResult[] = [];
	for (let k = 0; k < n; k++) {
		const base = world();
		base.cpu = { 100: k * 1e7, 101: cpuOf(k) };
		out.push(det.tick(obsOf((o.atOf ?? ((i: number) => T0 + i * 1000))(k), edit(k, base))));
	}
	return out;
}

const startedAt = (rs: TickResult[]) => rs.flatMap((r, k) => (r.started.length > 0 ? [k] : []));
const matchedAt = (rs: TickResult[]) => rs.flatMap((r, k) => (r.matched.length > 0 ? [k] : []));
const anySignature = (rs: TickResult[]) => rs.some((r) => r.signatures.length > 0 || r.started.length > 0 || r.matched.length > 0);

describe("classifier: the positive shape", () => {
	test("a signature starts on the first tick with a CPU delta and matches once when it has held persistMs", () => {
		const rs = run(9);
		expect(rs[0]!.signatures).toEqual([]); // no previous tick: no CPU delta, never hot
		expect(startedAt(rs)).toEqual([1]);
		const sig = rs[1]!.started[0]!;
		expect(sig).toEqual({ worker: { pid: 101, startUs: W_START }, zombie: { pid: 200, startUs: ZOMBIE.startUs }, since: SINCE, command: "true" });
		expect(matchedAt(rs)).toEqual([6]); // tick 1 + 5_000 ms; not at 4_000 ms (tick 5)
		expect(rs[6]!.matched).toEqual([sig]);
		for (const r of rs.slice(1)) expect(r.signatures).toEqual([sig]);
		expect(rs.flatMap((r) => r.cleared)).toEqual([]);
	});

	test("persistMs and tickMs are options: 250 ms ticks and 2_000 ms persistence match on the ninth tick of the run", () => {
		const rs = run(12, undefined, { atOf: (k) => T0 + k * 250, cpuOf: (k) => k * 250e6, opts: { tickMs: 250, persistMs: 2000 } });
		expect(startedAt(rs)).toEqual([1]);
		expect(matchedAt(rs)).toEqual([9]);
	});

	test("hot is a CPU delta of at least 0.8 of the wall delta: 0.8 holds, just under breaks", () => {
		expect(matchedAt(run(8, undefined, { cpuOf: (k) => k * 0.8e9 }))).toEqual([6]);
		expect(anySignature(run(8, undefined, { cpuOf: (k) => k * 0.79e9 }))).toBe(false);
	});

	test("the zombie's birth window is [since, since + 250 ms]: both ends hold", () => {
		for (const off of [0, BIRTH_WINDOW_MS]) {
			const z = { ...ZOMBIE, startUs: (SINCE + off) * 1000 };
			expect(matchedAt(run(8, (_k, w) => ({ ...w, procs: [LEADER, WORKER, z] })))).toEqual([6]);
		}
	});

	test("the leader is a candidate in a serial part: bun test with no --test-worker, hot, marker held, zombie child", () => {
		const leaderZ = { ...ZOMBIE, ppid: 100 };
		const rs = run(8, (_k, w) => ({ ...w, procs: [LEADER, leaderZ], markers: [{ ...MARKER, pid: 100 }], cpu: { 100: w.cpu[101]! } }));
		expect(matchedAt(rs)).toEqual([6]);
		expect(rs[6]!.matched[0]!.worker).toEqual({ pid: 100, startUs: LEADER.startUs });
	});

	test("a worker deeper in the tree (a grandchild of the leader by ppid) is a candidate", () => {
		const mid = proc(150, 100, { startUs: W_START - 500_000 });
		const deep = { ...WORKER, ppid: 150 };
		expect(matchedAt(run(8, (_k, w) => ({ ...w, procs: [LEADER, mid, deep, ZOMBIE], argv: { ...w.argv, 150: [BUN, "x"] } })))).toEqual([6]);
	});

	test("other workers active beside the stuck one change nothing: only the stuck worker's signature, matched on time", () => {
		const other = proc(102, 100, { pgid: 102, startUs: W_START + 5 });
		const otherLive = proc(201, 102, { pgid: 102, startUs: (SINCE + 50) * 1000, comm: "sleep" }); // a live child
		const otherZ = proc(202, 102, { pgid: 102, zombie: true, startUs: (SINCE + 10) * 1000, comm: "true" }); // but no marker
		const rs = run(9, (k, w) => ({
			...w,
			procs: [LEADER, WORKER, ZOMBIE, other, otherLive, ...(k % 2 ? [otherZ] : [])],
			// the other worker is hot and inside its own spawnSync call on its own (live) child, its marker renewed each tick
			markers: [MARKER, { pid: 102, since: SINCE + 50 + k, command: "sleep" }],
			cpu: { ...w.cpu, 102: k * 1e9 },
			argv: { ...w.argv, 102: WORKER_ARGV },
		}));
		expect(matchedAt(rs)).toEqual([6]);
		for (const r of rs.slice(1)) expect(r.signatures.map((s) => s.worker.pid)).toEqual([101]);
	});

	test("two zombies of the call's command inside the window are two signatures, each matched once", () => {
		const z2 = proc(203, 101, { pgid: 101, zombie: true, startUs: (SINCE + 200) * 1000, comm: "true" });
		const rs = run(8, (_k, w) => ({ ...w, procs: [...w.procs, z2] }));
		expect(rs[6]!.matched.map((s) => s.zombie.pid).sort()).toEqual([200, 203]);
	});

	test("argv is read once per identity: a tick without an argv entry keeps the identity's argv", () => {
		expect(matchedAt(run(8, (k, w) => (k > 0 ? { ...w, argv: {} } : w)))).toEqual([6]);
		const det = new StuckDetector(OPTS);
		const s0 = obsOf(T0, world()).snap;
		expect(det.argvNeeded(s0)).toEqual([100, 101]);
		det.tick(obsOf(T0, world()));
		expect(det.argvNeeded(s0)).toEqual([]);
		expect(det.candidatesOf(s0)).toEqual([100, 101]); // live bun processes of the part tree; not the zombie
	});
});

describe("classifier: every reset cause", () => {
	/** A break on tick 3: the signature clears there, matched no, and the match clock restarts when it holds again. */
	function breaksAt3(edit: (w: World) => World, o: { restartsAt?: number } = {}) {
		const rs = run(14, (k, w) => (k === 3 ? edit(w) : w));
		expect(rs[3]!.signatures).toEqual([]);
		expect(rs[3]!.cleared).toEqual([{ sig: rs[1]!.started[0]!, heldMs: 1000, matched: false }]);
		expect(matchedAt(rs)).not.toContain(6);
		const restart = o.restartsAt ?? 4;
		expect(startedAt(rs)).toEqual([1, restart]);
		expect(matchedAt(rs)).toEqual([restart + 5]);
		return rs;
	}

	test("a gap of more than 2 x tickMs between ticks clears; exactly 2 x tickMs does not", () => {
		const late = (gap: number) => run(14, undefined, { atOf: (k) => T0 + k * 1000 + (k >= 3 ? gap : 0), cpuOf: (k) => k * 1e9 + (k >= 3 ? gap * 1e6 : 0) });
		const rs = late(1001); // tick 3 comes 2_001 ms after tick 2
		expect(rs[3]!.signatures).toEqual([]);
		expect(rs[3]!.cleared.map((c) => c.matched)).toEqual([false]);
		expect(startedAt(rs)).toEqual([1, 4]);
		expect(matchedAt(late(1000))).toEqual([5]); // unbroken: persistMs is wall time, so the 2_000 ms step counts in full
	});

	test("a denied snapshot clears", () => breaksAt3((w) => ({ ...w, snap: "denied" }), { restartsAt: 5 }));
	test("an unavailable snapshot clears", () => breaksAt3((w) => ({ ...w, snap: "unavailable" }), { restartsAt: 5 }));
	test("a denied CPU read of the worker clears", () => breaksAt3((w) => ({ ...w, cpu: { ...w.cpu, 101: null } }), { restartsAt: 5 }));
	test("a missing CPU read of the worker clears", () => breaksAt3((w) => ({ ...w, cpu: { 100: 0 } }), { restartsAt: 5 }));
	test("a denied marker dir clears", () => breaksAt3((w) => ({ ...w, markers: "denied" })));
	test("the worker idle for one tick clears (1: not hot)", () => {
		const rs = run(14, undefined, { cpuOf: (k) => (k < 3 ? k : k - 1) * 1e9 });
		expect(rs[3]!.cleared).toHaveLength(1);
		expect(startedAt(rs)).toEqual([1, 4]);
	});
	test("the marker's lock released (no active marker) clears (2)", () => breaksAt3((w) => ({ ...w, markers: [] })));
	test("the zombie reaped clears (3)", () => breaksAt3((w) => ({ ...w, procs: [LEADER, WORKER] })));
	test("a new marker since (a new call) is a new signature: the old clears, the new starts from zero", () => {
		const z2 = { ...ZOMBIE, pid: 210, startUs: (SINCE + 9_100) * 1000 };
		const rs = run(12, (k, w) => (k >= 3 ? { ...w, procs: [LEADER, WORKER, z2], markers: [{ ...MARKER, since: SINCE + 9_000 }] } : w));
		expect(rs[3]!.cleared.map((c) => c.sig.since)).toEqual([SINCE]);
		expect(rs[3]!.started.map((s) => s.since)).toEqual([SINCE + 9_000]);
		expect(matchedAt(rs)).toEqual([8]);
	});
	test("PID reuse of the worker clears: the same pid with a later start has no CPU history and no marker since after it", () => {
		const reused = { ...WORKER, startUs: (SINCE + 1) * 1000 };
		const rs = run(14, (k, w) => (k >= 3 ? { ...w, procs: [LEADER, reused, ZOMBIE] } : w));
		expect(rs[3]!.cleared).toHaveLength(1);
		// The reused worker's identity never forms a signature with the old marker: since < its start.
		expect(rs.slice(3).some((r) => r.signatures.length > 0)).toBe(false);
	});
	test("PID reuse of the zombie: the same pid with a new start inside the window is a new signature from zero", () => {
		const z2 = { ...ZOMBIE, startUs: (SINCE + 200) * 1000 };
		const rs = run(12, (k, w) => (k >= 3 ? { ...w, procs: [LEADER, WORKER, z2] } : w));
		expect(rs[3]!.cleared.map((c) => c.sig.zombie.startUs)).toEqual([ZOMBIE.startUs]);
		expect(rs[3]!.started.map((s) => s.zombie.startUs)).toEqual([z2.startUs]);
		expect(matchedAt(rs)).toEqual([8]);
	});
	test("a signature that breaks after its match clears with matched yes and the held time", () => {
		const rs = run(9, (k, w) => (k === 8 ? { ...w, markers: [] } : w));
		expect(rs[8]!.cleared).toEqual([{ sig: rs[1]!.started[0]!, heldMs: 6000, matched: true }]);
	});
	test("the leader gone: nothing is a candidate any more", () => breaksAt3((w) => ({ ...w, procs: [WORKER, ZOMBIE] }), { restartsAt: 5 }));
	test("a leader pid reused by another process is not the leader", () => {
		const rs = run(8, (k, w) => (k >= 3 ? { ...w, procs: [{ ...LEADER, startUs: LEADER.startUs + 1 }, WORKER, ZOMBIE] } : w));
		expect(rs.slice(3).every((r) => r.signatures.length === 0)).toBe(true);
	});
});

describe("classifier: negative controls (never a signature)", () => {
	const never = (edit: (k: number, w: World) => World, n = 17) => expect(anySignature(run(n, edit))).toBe(false);

	test("a long legitimate test: hot, no marker, no zombie, for 3 x persistMs", () => never((_k, w) => ({ ...w, procs: [LEADER, WORKER], markers: [] })));
	test("a long healthy sync computation holding a transient zombie, no marker, for 3 x persistMs", () =>
		never((k, w) => ({ ...w, procs: k % 3 === 0 ? [LEADER, WORKER] : [LEADER, WORKER, ZOMBIE], markers: [] })));
	test("a marker with a live child (spawnSync waiting on it), worker hot", () => never((_k, w) => ({ ...w, procs: [LEADER, WORKER, { ...ZOMBIE, zombie: false }] })));
	test("a marker with a zombie but the worker idle", () => {
		expect(anySignature(run(17, undefined, { cpuOf: () => 5e9 }))).toBe(false);
		expect(anySignature(run(17, undefined, { cpuOf: (k) => k * 1e8 }))).toBe(false); // 10 % of a core
	});
	test("an inactive marker (lock free: not in the active list) with a same-command zombie born 100 ms after its since, worker hot", () =>
		never((_k, w) => ({ ...w, markers: [] })));
	test("a zombie born 300 ms after since; one born 1 ms before it", () => {
		never((_k, w) => ({ ...w, procs: [LEADER, WORKER, { ...ZOMBIE, startUs: (SINCE + 300) * 1000 }] }));
		never((_k, w) => ({ ...w, procs: [LEADER, WORKER, { ...ZOMBIE, startUs: (SINCE + BIRTH_WINDOW_MS) * 1000 + 1 }] }));
		never((_k, w) => ({ ...w, procs: [LEADER, WORKER, { ...ZOMBIE, startUs: SINCE * 1000 - 1 }] }));
	});
	test("a zombie of a different command inside the window", () => never((_k, w) => ({ ...w, procs: [LEADER, WORKER, { ...ZOMBIE, comm: "sleep" }] })));
	test("an unrelated zombie: its parent is not a candidate", () => {
		// a sleeping non-bun descendant with a marker named after it
		const sleeper = proc(300, 101, { comm: "sleep" });
		never((_k, w) => ({ ...w, procs: [LEADER, WORKER, sleeper, { ...ZOMBIE, ppid: 300 }], markers: [{ ...MARKER, pid: 300 }], cpu: { ...w.cpu, 300: w.cpu[101]! } }));
		// a hot bun test worker outside this part's tree (another run's), with its own held marker and zombie
		const foreign = proc(400, 1, { startUs: W_START });
		never((_k, w) => ({ ...w, procs: [LEADER, foreign, { ...ZOMBIE, ppid: 400 }], markers: [{ ...MARKER, pid: 400 }], cpu: { ...w.cpu, 400: w.cpu[101]! }, argv: { ...w.argv, 400: WORKER_ARGV } }));
		// the zombie of a hot candidate whose marker belongs to another pid
		never((_k, w) => ({ ...w, markers: [{ ...MARKER, pid: 999 }] }));
	});
	test("a reused worker pid: the marker's since is before the worker's start", () => never((_k, w) => ({ ...w, procs: [LEADER, { ...WORKER, startUs: SINCE * 1000 + 1 }, ZOMBIE] })));
	test("denied snapshot, CPU and marker reads on every tick", () => {
		never((_k, w) => ({ ...w, snap: "denied" }));
		never((_k, w) => ({ ...w, cpu: { 100: 0, 101: null } }));
		never((_k, w) => ({ ...w, markers: "denied" }));
	});
	test("malformed and empty markers reach the classifier as no active marker (readMarkers drops them)", () => never((_k, w) => ({ ...w, markers: [] })));
	test("not a worker: p_comm not bun, argv[0] another bun, argv without test, a non-leader without --test-worker, argv unreadable", () => {
		never((_k, w) => ({ ...w, procs: [LEADER, { ...WORKER, comm: "node" }, ZOMBIE] }));
		never((_k, w) => ({ ...w, argv: { ...w.argv, 101: ["/usr/local/bin/bun", ...WORKER_ARGV.slice(1)] } }));
		never((_k, w) => ({ ...w, argv: { ...w.argv, 101: [BUN, "run", "--test-worker"] } }));
		never((_k, w) => ({ ...w, argv: { ...w.argv, 101: [BUN, "test", "--isolate"] } }));
		never((_k, w) => ({ ...w, argv: { ...w.argv, 101: null } }));
	});
	test("the clock going backwards is never hot", () => expect(anySignature(run(8, undefined, { atOf: (k) => T0 - k * 1000 }))).toBe(false));
});

describe("classifier: owned identities", () => {
	test("every leader/descendant identity seen on any tick is kept, zombies included, with its latest pgid", () => {
		const grandchild = proc(500, 101, { pgid: 500, comm: "sh", startUs: W_START + 9 });
		const rs = run(4, (k, w) => (k === 1 ? { ...w, procs: [...w.procs, grandchild] } : k === 2 ? { ...w, procs: [LEADER, { ...WORKER, pgid: 777 }] } : w));
		const ids = (ps: Proc[]) => ps.map((p) => `${p.pid}/${p.pgid}`).sort();
		expect(ids(rs[0]!.owned)).toEqual(["100/100", "101/101", "200/101"]);
		expect(ids(rs[3]!.owned)).toEqual(["100/100", "101/101", "200/101", "500/500"]); // 101's pgid moved back on tick 3
		expect(ids(rs[2]!.owned)).toEqual(["100/100", "101/777", "200/101", "500/500"]);
	});

	test("liveOwned: owned identities alive in a fresh snapshot plus their live descendants; not a reused pid, not a zombie", () => {
		const owned = [LEADER, WORKER];
		const newKid = proc(600, 101, { pgid: 600, comm: "sh", startUs: W_START + 50 }); // new during a capture
		const newGrand = proc(601, 600, { pgid: 601, comm: "sleep" });
		const reused = { ...LEADER, startUs: LEADER.startUs + 7 }; // pid 100 reused
		const stranger = proc(700, 1, { comm: "bun" });
		const fresh = { kind: "ok" as const, procs: [reused, WORKER, ZOMBIE, newKid, newGrand, stranger] };
		expect(liveOwned(fresh, owned).map((p) => p.pid).sort()).toEqual([101, 600, 601]);
	});

	test("liveProcs drops zombies", () => {
		expect(liveProcs({ kind: "ok", procs: [LEADER, ZOMBIE, WORKER] }).map((p) => p.pid)).toEqual([100, 101]);
	});
});

describe("marker format", () => {
	test("markerContent: since, a tab, argv[0]'s basename cut to 16 (MAXCOMLEN), a newline; MARKER_CONTENT_RE reads it back", () => {
		expect(markerContent(SINCE, "/usr/bin/true")).toBe(`${SINCE}\ttrue\n`);
		const long = markerContent(1, "/x/abcdefghijklmnopqrstuvwxyz");
		expect(long).toBe("1\tabcdefghijklmnop\n");
		expect(MARKER_CONTENT_RE.exec(long)!.slice(1)).toEqual(["1", "abcdefghijklmnop"]);
		for (const bad of ["", "\n", "1\t\n", "x\ttrue\n", "1\ttrue", "1\ttrue\n\n", "1\ta\tb\n", `1\t${"a".repeat(17)}\n`]) expect(MARKER_CONTENT_RE.test(bad)).toBe(false);
		expect(STUCK_DEFAULTS).toEqual({ tickMs: 1000, persistMs: 5000, signatureCaptureMs: 3000, stopGraceMs: 1500, verifyMs: 2000 });
	});
});

// ---- live observation through bun:ffi ----

const LIVE = process.platform === "darwin";
const uid = process.getuid!();
const roots: string[] = [];
const kids: { kill: (s?: number | NodeJS.Signals) => void }[] = [];
afterAll(() => {
	for (const k of kids) k.kill("SIGKILL");
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Polls `probe`: a kernel process state has no event to await, so this re-reads it every 50 ms (a real delay by nature). */
async function until<T>(what: string, probe: () => T | null | undefined | false, ms = 5_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = probe();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

const procOf = (pid: number): Proc | undefined => {
	const s = snapshot(uid);
	return s.kind === "ok" ? s.procs.find((p) => p.pid === pid) : undefined;
};

function procsOf(s: Snapshot): Proc[] {
	if (s.kind !== "ok") throw new Error(`snapshot ${s.kind}: ${s.why}`);
	return s.procs;
}

function activeOf(dir: string): Marker[] {
	const m = readMarkers(dir);
	if (m.kind !== "ok") throw new Error(`markers denied: ${m.why}`);
	return m.active;
}

/**
 * A marker holder as the preload holds one: opens MARKER_PATH, or MARKER_DIR/<its pid> as the preload names it
 * (O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC), takes flock(LOCK_EX|LOCK_NB), truncates and writes MARKER_CONTENT (default the
 * D1 content for /usr/bin/true), prints `held <rc>`, then sleeps until a stdin line; with HOLD=spin it spawns
 * /usr/bin/true asynchronously at once, prints `held <rc> <since> <child pid>` and spins forever: its event loop never
 * runs again, so the child stays unreaped.
 */
const HOLDER = `
import { dlopen, FFIType } from "bun:ffi";
import { constants, ftruncateSync, openSync, writeSync } from "node:fs";
const { flock } = dlopen("/usr/lib/libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols;
const path = process.env.MARKER_PATH ?? process.env.MARKER_DIR + "/" + process.pid;
const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | 0x1000000, 0o600);
const rc = flock(fd, 2 | 4);
ftruncateSync(fd, 0);
const since = Date.now();
writeSync(fd, process.env.MARKER_CONTENT ?? \`\${since}\\ttrue\\n\`);
if (process.env.HOLD === "spin") {
	const kid = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
	writeSync(1, "held " + rc + " " + since + " " + kid.pid + "\\n");
	for (;;) {}
}
writeSync(1, "held " + rc + "\\n");
process.stdin.on("data", () => process.exit(0));
setTimeout(() => {}, 60_000);
`;

async function holder(env: Record<string, string>, extraArgs: string[] = []) {
	const p = spawn([process.execPath, "-e", HOLDER, ...extraArgs], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	kids.push(p);
	const reader = p.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const words = text.trim().split(" ");
	expect(words.slice(0, 2)).toEqual(["held", "0"]);
	return { p, words };
}

function markerDir(): string {
	const d = mkdtempSync(join(tmpdir(), "surface-stuck-detect-"));
	roots.push(d);
	return d;
}

describe.skipIf(!LIVE)("live: snapshot, argv and CPU through bun:ffi", () => {
	test("own pid, ppid, pgid and start equal the process's values", () => {
		const s = snapshot(uid);
		expect(s.kind).toBe("ok");
		const me = procsOf(s).find((p) => p.pid === process.pid)!;
		const { getpgid } = dlopen("/usr/lib/libSystem.B.dylib", { getpgid: { args: [FFIType.i32], returns: FFIType.i32 } }).symbols;
		expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid, pgid: getpgid(0), zombie: false, comm: "bun" });
		const startMs = Date.now() - process.uptime() * 1000;
		expect(Math.abs(me.startUs / 1000 - startMs)).toBeLessThan(1_500);
	});

	test("a child's start lies between the instants before and after its spawn, to the microsecond field", async () => {
		const before = Date.now();
		const p = spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		kids.push(p);
		const after = Date.now();
		const c = await until("the child in the snapshot", () => procOf(p.pid));
		expect(c).toMatchObject({ ppid: process.pid, zombie: false, comm: "sleep" });
		expect(c.startUs).toBeGreaterThanOrEqual((before - 5) * 1000);
		expect(c.startUs).toBeLessThanOrEqual((after + 5) * 1000);
		expect(c.startUs % 1_000_000).not.toBe(0); // tv_usec is read, not only tv_sec (1 in 10^6 to be 0 by chance)
		expect(procArgv(p.pid)).toEqual(["/bin/sleep", "30"]);
		p.kill("SIGKILL");
	});

	test("an unreaped child of a test subprocess reads zombie with its p_comm, parented by the subprocess", async () => {
		// sh forks /usr/bin/true, prints its pid and execs into sleep, which never waits: true stays a zombie.
		const sh = spawn(["/bin/sh", "-c", "/usr/bin/true & echo $!; exec /bin/sleep 30"], { stdout: "pipe", stderr: "ignore" });
		kids.push(sh);
		const reader = sh.stdout.getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		const child = Number(new TextDecoder().decode(value).trim());
		const z = await until("the child to be a zombie", () => {
			const c = procOf(child);
			return c?.zombie && c;
		});
		expect(z).toMatchObject({ pid: child, ppid: sh.pid, zombie: true, comm: "true" });
		expect(procArgv(child)).toBeNull(); // a zombie has no argument area
		sh.kill("SIGKILL");
	});

	test("a busy child's CPU grows at about one core: the mach timebase scaling gives ns", async () => {
		const p = spawn([process.execPath, "-e", "for(;;){}"], { stdout: "ignore", stderr: "ignore" });
		kids.push(p);
		// Real delays by nature: the kernel's CPU accounting of a spinning process is what is measured against wall time.
		await Bun.sleep(200);
		const c0 = cpuNs(p.pid)!;
		const t0 = performance.now();
		await Bun.sleep(1_000);
		const c1 = cpuNs(p.pid)!;
		const wall = (performance.now() - t0) * 1e6;
		expect(c0).toBeGreaterThan(0);
		expect(c1 - c0).toBeGreaterThan(0.5 * wall);
		expect(c1 - c0).toBeLessThan(1.3 * wall);
		p.kill("SIGKILL");
		await p.exited;
		expect(cpuNs(p.pid)).toBeNull(); // reaped: gone
		expect(procArgv(p.pid)).toBeNull();
	});

	test("another uid's list is readable without a spawn (uid 0: launchd, pid 1)", () => {
		const s = snapshot(0);
		expect(s.kind).toBe("ok");
		const procs = procsOf(s);
		expect(procs.length).toBeGreaterThan(1);
		expect(procs.find((p) => p.pid === 1)).toMatchObject({ ppid: 0, comm: "launchd", zombie: false });
		expect(procs.some((p) => p.pid === process.pid)).toBe(false);
	});
});

describe.skipIf(!LIVE)("live: markers", () => {
	test("a marker locked by a live subprocess reads active; after the holder's exit it reads inactive", async () => {
		const dir = markerDir();
		const { p } = await holder({ MARKER_PATH: join(dir, "4242"), MARKER_CONTENT: `${SINCE}\tsleep\n` });
		expect(readMarkers(dir)).toEqual({ kind: "ok", active: [{ pid: 4242, since: SINCE, command: "sleep" }] });
		expect(readMarkers(dir)).toEqual({ kind: "ok", active: [{ pid: 4242, since: SINCE, command: "sleep" }] }); // the probe's shared lock does not stick
		p.stdin.write("x\n");
		p.stdin.end();
		expect(await p.exited).toBe(0);
		expect(readMarkers(dir)).toEqual({ kind: "ok", active: [] });
	});

	test("a marker locked by a live subprocess reads inactive after its SIGKILL", async () => {
		const dir = markerDir();
		const { p } = await holder({ MARKER_PATH: join(dir, "4243") });
		expect(activeOf(dir).map((m) => m.pid)).toEqual([4243]);
		p.kill("SIGKILL");
		await p.exited;
		expect(readMarkers(dir)).toEqual({ kind: "ok", active: [] });
	});

	test("an unlocked marker file with valid content is inactive", () => {
		const dir = markerDir();
		writeFileSync(join(dir, "4244"), `${SINCE}\ttrue\n`);
		expect(readMarkers(dir)).toEqual({ kind: "ok", active: [] });
	});

	test("malformed and empty markers, even locked, are ignored; so are non-pid names, symlinks and directories", async () => {
		const dir = markerDir();
		for (const [name, content] of [["5001", "abc\n"], ["5002", " "], ["5003", `${SINCE}\ttrue`], ["5004", `${SINCE}\t${"a".repeat(17)}\n`], ["5005", `${SINCE}\ttrue\n${"x".repeat(60)}`], ["5006", ""]] as const) {
			await holder({ MARKER_PATH: join(dir, name), MARKER_CONTENT: content });
		}
		const good = join(markerDir(), "5007");
		await holder({ MARKER_PATH: good, MARKER_CONTENT: `${SINCE}\ttrue\n` });
		symlinkSync(good, join(dir, "5008")); // a symlink to a held, valid marker: O_NOFOLLOW refuses it
		await holder({ MARKER_PATH: join(dir, "notapid"), MARKER_CONTENT: `${SINCE}\ttrue\n` });
		await holder({ MARKER_PATH: join(dir, "05009"), MARKER_CONTENT: `${SINCE}\ttrue\n` });
		mkdirSync(join(dir, "5010"));
		await holder({ MARKER_PATH: join(dir, "5011"), MARKER_CONTENT: `${SINCE}\ttrue\n` }); // the one valid entry
		expect(readMarkers(dir)).toEqual({ kind: "ok", active: [{ pid: 5011, since: SINCE, command: "true" }] });
	});

	test("an unreadable or missing marker dir is denied, never a throw", () => {
		expect(readMarkers(join(markerDir(), "missing")).kind).toBe("denied");
	});
});

describe.skipIf(!LIVE)("live: observe and the classifier end to end", () => {
	test("a spinning bun holding its marker with an unreaped /usr/bin/true child matches; after its SIGKILL the signature clears", async () => {
		const dir = markerDir();
		// `test` in its argv makes the holder a bun test process by argv; it is the part's leader (no --test-worker needed).
		const { p, words } = await holder({ MARKER_DIR: dir, HOLD: "spin" }, ["test"]);
		const since = Number(words[2]);
		const zombie = Number(words[3]);
		const det = new StuckDetector({ tickMs: 250, persistMs: 1_000, bunPath: process.execPath, leaderPid: p.pid });
		const tick = () => det.tick(observe({ uid, markerDir: dir, candidatesOf: (s) => det.candidatesOf(s), argvOf: (s) => det.argvNeeded(s) }));
		expect(activeOf(dir)).toEqual([{ pid: p.pid, since, command: "true" }]);
		const z = await until("the child to be a zombie", () => procOf(zombie)?.zombie);
		expect(z).toBe(true);
		let matched: Signature | null = null;
		const deadline = Date.now() + 10_000;
		while (!matched && Date.now() < deadline) {
			matched = tick().matched[0] ?? null;
			await Bun.sleep(250); // the tick timer under test: CPU deltas need real elapsed time
		}
		expect(matched).toMatchObject({ worker: { pid: p.pid }, zombie: { pid: zombie }, since, command: "true" });
		p.kill("SIGKILL");
		await p.exited;
		const r = tick();
		expect(r.signatures).toEqual([]);
		expect(r.cleared.map((c) => c.matched)).toEqual([true]);
		expect(r.owned.map((o) => o.pid).sort()).toEqual([p.pid, zombie].sort());
	}, 20_000);
});
