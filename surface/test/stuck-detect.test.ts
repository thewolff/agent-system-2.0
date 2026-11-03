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
import { unreapedTrue } from "./helpers";

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
	const errors: unknown[] = [];
	for (const k of kids) {
		try {
			k.kill("SIGKILL");
		} catch (e) {
			errors.push(e);
		}
	}
	for (const r of roots) {
		try {
			rmSync(r, { recursive: true, force: true });
		} catch (e) {
			errors.push(e);
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, `stuck-detect live cleanup: ${errors.length} kill or rm failure(s)`);
});

/** Lines of a child's stdout, one per call; a stream that ends before a full line is an error naming `what`. */
function lineReader(stdout: ReadableStream<Uint8Array>, what: string): () => Promise<string> {
	const reader = stdout.getReader();
	const dec = new TextDecoder();
	let buf = "";
	return async () => {
		for (;;) {
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				return line;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error(`${what}: stdout ended before a full line (read ${JSON.stringify(buf)})`);
			buf += dec.decode(value, { stream: true });
		}
	};
}

/**
 * Resolves once `pid` has exited (it is a zombie or gone): /usr/bin/caffeinate -w returns when the pid exits, at once for
 * one already exited. The caller then reads the snapshot for the state it expects; a zombie is never inferred from this.
 */
async function exitedOf(pid: number): Promise<void> {
	const w = spawn(["/usr/bin/caffeinate", "-w", String(pid)], { stdout: "ignore", stderr: "pipe" });
	kids.push(w);
	const code = await w.exited;
	if (code !== 0) throw new Error(`/usr/bin/caffeinate -w ${pid} exited ${code}: ${await new Response(w.stderr).text()}`);
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
	const kid = ${unreapedTrue(`{ stdout: "ignore", stderr: "ignore" }`)};
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
	const words = (await lineReader(p.stdout, "the marker holder")()).trim().split(" ");
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
		// Bun.spawn is posix_spawn, which loads the image before it returns (a non-executable path fails the spawn call
		// itself, EACCES): the child is in the table with its exec'd image as soon as spawn returns, so it is read once.
		const c = procOf(p.pid)!;
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
		const child = Number(await lineReader(sh.stdout, "sh")());
		await exitedOf(child);
		const z = procOf(child);
		expect(z).toMatchObject({ pid: child, ppid: sh.pid, zombie: true, comm: "true" });
		expect(procArgv(child)).toBeNull(); // a zombie has no argument area
		sh.kill("SIGKILL");
	});

	/**
	 * Burns CPU until its own rusage (process.cpuUsage, user + system, µs) reaches 50 ms of CPU (a CPU condition, not a
	 * wall one), prints that total, then prints it again on each stdin line.
	 */
	const CPU_CHILD = `
import { writeSync } from "node:fs";
const total = () => { const u = process.cpuUsage(); return u.user + u.system; };
while (total() < 50_000) {}
writeSync(1, total() + "\\n");
process.stdin.on("data", () => writeSync(1, total() + "\\n"));
`;
	/** process.cpuUsage truncates user and system to µs each: the reported total is at most 2 µs below the kernel's; 10 µs of margin. */
	const RUSAGE_ROUNDING_NS = 10_000;

	test("a child's sampled CPU lies between the CPU it reported just before and just after the sample: the mach timebase scaling gives ns", async () => {
		// The CPU read is checked against the child's own rusage, never against wall time: a CPU/wall ratio depends on the
		// share of a core the machine gives the child (tr-0mvswzq5hk2blyw, tr-0mvzkktvgxlltc7). Unscaled mach units
		// (24 MHz ticks on arm64) would read about 42 times too small and fall below the bracket.
		const p = spawn([process.execPath, "-e", CPU_CHILD], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
		kids.push(p);
		try {
			const line = lineReader(p.stdout, "the CPU child");
			const before = Number(await line()) * 1000;
			const sampled = cpuNs(p.pid);
			p.stdin.write("x\n");
			await p.stdin.flush();
			const after = Number(await line()) * 1000;
			expect(before).toBeGreaterThanOrEqual(50_000_000);
			expect(sampled).not.toBeNull();
			expect(sampled!).toBeGreaterThanOrEqual(before);
			expect(sampled!).toBeLessThanOrEqual(after + RUSAGE_ROUNDING_NS);
		} finally {
			p.kill("SIGKILL");
		}
		await p.exited;
		expect(cpuNs(p.pid)).toBeNull(); // reaped: gone
		expect(procArgv(p.pid)).toBeNull();
	}, 30_000); // a failure bound only: one bun start and 50 ms of its CPU at any share of a core

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
	test("a spinning bun holding its marker with an unreaped /usr/bin/true child matches at persistMs; after its SIGKILL the signature clears", async () => {
		const dir = markerDir();
		// `test` in its argv makes the holder a bun test process by argv; it is the part's leader (no --test-worker needed).
		const { p, words } = await holder({ MARKER_DIR: dir, HOLD: "spin" }, ["test"]);
		try {
			const since = Number(words[2]);
			const zombie = Number(words[3]);
			// The snapshot, the markers, argv and the CPU read are live; the classifier's time inputs are fed. "Hot" compares
			// a worker's CPU delta with the tick clock's delta (HOT_SHARE), and a late tick is a gap: on a real clock both
			// follow the scheduler, and under load the spinner got under 80% of a core or this process woke late, so the
			// signature never persisted (tr-0mvs9idg2cc61rm, tr-0mvsdt2r8l27rg0: null after 10 s). Here tick i is at
			// T0 + i * tickMs and the spinner's CPU sample is i * tickMs of CPU (one core), so every tick after the first is
			// hot, at the production tickMs and persistMs; the live CPU read is checked to be the spinner's and nonzero.
			const { tickMs, persistMs } = STUCK_DEFAULTS;
			const det = new StuckDetector({ tickMs, persistMs, bunPath: process.execPath, leaderPid: p.pid });
			const look = () => observe({ uid, markerDir: dir, candidatesOf: (s) => det.candidatesOf(s), argvOf: (s) => det.argvNeeded(s) });
			const tick = (i: number) => {
				const obs = look();
				expect([...obs.cpu.keys()]).toEqual([p.pid]);
				expect(obs.cpu.get(p.pid)!).toBeGreaterThan(0);
				return det.tick({ ...obs, at: T0 + i * tickMs, cpu: new Map([[p.pid, i * tickMs * 1e6]]) });
			};
			expect(activeOf(dir)).toEqual([{ pid: p.pid, since, command: "true" }]);
			await exitedOf(zombie);
			expect(procOf(zombie)).toMatchObject({ ppid: p.pid, zombie: true, comm: "true" });
			const matchedAt: number[] = [];
			let matched: Signature | null = null;
			const last = persistMs / tickMs + 4;
			for (let i = 1; i <= last; i++) {
				const r = tick(i);
				if (r.matched.length) matchedAt.push(i);
				matched = r.matched[0] ?? matched;
			}
			// Tick 1 has no CPU baseline; tick 2 starts the hold; tick 7 is persistMs (5 ticks) after it, and it matches once.
			expect(matchedAt).toEqual([2 + persistMs / tickMs]);
			expect(matched).toMatchObject({ worker: { pid: p.pid }, zombie: { pid: zombie }, since, command: "true" });
			p.kill("SIGKILL");
			await p.exited;
			const obs = look();
			expect(obs.cpu.size).toBe(0); // the leader is gone: no candidate is read
			const r = det.tick({ ...obs, at: T0 + (last + 1) * tickMs });
			expect(r.signatures).toEqual([]);
			expect(r.cleared.map((c) => c.matched)).toEqual([true]);
			expect(r.owned.map((o) => o.pid).sort()).toEqual([p.pid, zombie].sort());
		} finally {
			p.kill("SIGKILL");
		}
	}, 30_000); // a failure bound only: one bun start and ten observations
});
