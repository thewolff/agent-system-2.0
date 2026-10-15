// Test temp dirs are removed however a test process ends (PLAN wl-mv8mof9kktbh1c § 3, T1-T14).
//
// Each case runs a fixture (ledger/test/fixtures/tmp-cleanup/) as its own `bun test` process with the real
// preload and TMPDIR = D, a fresh dir of this test, and checks D (and E, a LEDGER_TEST_TMP outside D)
// afterwards. Fixtures report through files in C, a control dir outside D. The top level imports only
// built-ins, so the file also runs on a tree without ledger/test/tmp.ts (the fails-before run); the cases
// that need that module (T8b, T11-T14, and T8's pre-ack and acked stages) are skipped there. No fixed
// sleeps: every wait polls a condition of a real subprocess or the file system (there is no event to await
// for "a dir is gone").
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const PRELOAD = join(import.meta.dir, "isolate-preload.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "tmp-cleanup");
const TMP_MODULE = join(import.meta.dir, "tmp.ts");
/** The tree carries the watched-root module; T8b, T11-T14 and two T8 stages need it. */
const NEW_TREE = existsSync(TMP_MODULE);
const TICK_MS = 20;
const SETTLE_MS = 10_000;
const READY_MS = 30_000;

/** A fixture `bun test` process; its stdin is a pipe that a blocking fixture reads to EOF. */
type Fixture = Subprocess<"pipe", "pipe", "pipe">;
interface Report {
	/** The fixture's tmpdir(): its run root on the new tree, D itself on the old one. */
	tmpdir: string;
	made?: string;
	/** swap.fixture.ts (T13): where the run renamed its own root. */
	moved?: string;
	/** swap.fixture.ts (T13): the run's temp HOME, a dir in its run root. */
	home?: string;
}

const owned: string[] = [];
const live: Fixture[] = [];
/** Each fixture's stdout and stderr, read from its start so a full pipe never stalls it. */
const outputs = new WeakMap<Fixture, Promise<string>>();

afterEach(() => {
	for (const proc of live.splice(0)) {
		if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
	}
	for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh dir of this test, removed after the case. */
function fresh(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `tmp-cleanup-${tag}-`));
	owned.push(dir);
	return dir;
}

/** `bun test <fixture>` with the real preload and TMPDIR = d. */
function start(fixture: string, d: string, env: Record<string, string> = {}): Fixture {
	const proc = Bun.spawn([process.execPath, "test", "--preload", PRELOAD, join(FIXTURES, fixture)], {
		cwd: FIXTURES,
		env: { ...process.env, TMPDIR: d, ...env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	outputs.set(proc, Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([o, e]) => o + e));
	live.push(proc);
	return proc;
}

const output = (proc: Fixture): Promise<string> => outputs.get(proc) ?? Promise.resolve("");

/** Ends a blocking fixture's wait: closes the stdin pipe it reads to EOF. */
function release(proc: Fixture): void {
	proc.stdin.end();
}

/** Polls `holds` every 20 ms up to the deadline; fails with `left()` when it never holds. */
async function until(holds: () => boolean, what: string, left: () => unknown = () => "", ms = SETTLE_MS): Promise<void> {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(TICK_MS)) {
		if (holds()) return;
	}
	if (holds()) return;
	throw new Error(`not within ${ms} ms: ${what}; left: ${JSON.stringify(left())}`);
}

/** Every path under `dir`, recursively, sorted; a symlink is listed, never followed. */
function tree(dir: string, prefix = ""): string[] {
	let names: string[];
	try {
		names = readdirSync(join(dir, prefix));
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const name of names) {
		const rel = prefix ? join(prefix, name) : name;
		out.push(rel);
		if (lstatSync(join(dir, rel), { throwIfNoEntry: false })?.isDirectory()) out.push(...tree(dir, rel));
	}
	return out.sort();
}

async function empty(dir: string): Promise<void> {
	await until(() => tree(dir).length === 0, `${dir} empty`, () => tree(dir));
}

/** Waits for the fixture's ready file (it must not exit first) and returns its report. */
async function ready(proc: Fixture, file: string): Promise<Report> {
	await until(() => existsSync(file) || proc.exitCode !== null, `ready file ${file}`, () => proc.exitCode, READY_MS);
	if (!existsSync(file)) throw new Error(`fixture exited ${proc.exitCode} before it was ready:\n${await output(proc)}`);
	return JSON.parse(readFileSync(file, "utf8")) as Report;
}

/** After a run: its own run root gone. The old tree has none (tmpdir() was D), so there is nothing to wait for. */
async function settled(report: Report, d: string): Promise<void> {
	if (report.tmpdir !== d) await until(() => !existsSync(report.tmpdir), `run root ${report.tmpdir} gone`, () => tree(report.tmpdir));
}

/** Kind, link target and file contents of every path under `dir`, for "unchanged" checks. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rel of tree(dir)) {
		const path = join(dir, rel);
		const st = lstatSync(path);
		out[rel] = st.isSymbolicLink() ? `link:${readlinkSync(path)}` : st.isDirectory() ? "dir" : `file:${readFileSync(path, "utf8")}`;
	}
	return out;
}

/**
 * The watchdog script W from ledger/test/tmp.ts. Imported at run time, not statically: the module is absent
 * on the old tree this file must also load on, and only the new-tree cases call this.
 */
async function watchdogScript(): Promise<string> {
	const mod: Record<string, unknown> = await import(TMP_MODULE);
	if (typeof mod.W !== "string") throw new Error(`${TMP_MODULE} exports no watchdog script W`);
	return mod.W;
}

describe("a test run leaves nothing in its TMPDIR", () => {
	test("T1 a passing run with an inline mkdtemp dir leaves D empty", async () => {
		const d = fresh("d");
		const proc = start("inline.fixture.ts", d);
		expect({ code: await proc.exited, out: await output(proc) }).toMatchObject({ code: 0 });
		await empty(d);
	}, 30_000);

	test("T2 a failing run leaves D empty and exits 1", async () => {
		const d = fresh("d");
		const proc = start("inline.fixture.ts", d, { FIX_FAIL: "1" });
		expect(await proc.exited).toBe(1);
		await empty(d);
	}, 30_000);

	for (const [signal, code] of [
		["SIGTERM", 143],
		["SIGINT", 130],
		["SIGHUP", 129],
	] as const) {
		test(`T3 ${signal} during a test leaves D empty and exits ${code}`, async () => {
			const [d, c] = [fresh("d"), fresh("c")];
			const proc = start("inline.fixture.ts", d, { FIX_BLOCK: "1", FIX_READY: join(c, "ready") });
			await ready(proc, join(c, "ready"));
			proc.kill(signal);
			expect(await proc.exited).toBe(code);
			await empty(d);
		}, 30_000);
	}

	test("T4 SIGKILL during a test leaves D empty", async () => {
		const [d, c] = [fresh("d"), fresh("c")];
		const proc = start("inline.fixture.ts", d, { FIX_BLOCK: "1", FIX_READY: join(c, "ready") });
		await ready(proc, join(c, "ready"));
		proc.kill("SIGKILL");
		await proc.exited;
		await empty(d);
	}, 30_000);
});

describe("nothing but a run's own paths is removed", () => {
	test("T5 entries already in D (a root-like dir, a symlink out of D, a plain dir) survive a passing and a SIGKILLed run", async () => {
		const [d, c, outside] = [fresh("d"), fresh("c"), fresh("outside")];
		mkdirSync(join(d, "as2-test-run-abc123", "sub"), { recursive: true });
		writeFileSync(join(d, "as2-test-run-abc123", "a.txt"), "a\n");
		writeFileSync(join(d, "as2-test-run-abc123", "sub", "b.txt"), "b\n");
		writeFileSync(join(outside, "o.txt"), "outside\n");
		symlinkSync(outside, join(d, "link"));
		mkdirSync(join(d, "plain"));
		writeFileSync(join(d, "plain", "p.txt"), "p\n");
		const [inD, out] = [snapshot(d), snapshot(outside)];
		expect(Object.keys(inD)).toEqual(["as2-test-run-abc123", "as2-test-run-abc123/a.txt", "as2-test-run-abc123/sub", "as2-test-run-abc123/sub/b.txt", "link", "plain", "plain/p.txt"]);

		const passing = start("inline.fixture.ts", d, { FIX_READY: join(c, "ready-1") });
		expect(await passing.exited).toBe(0);
		await settled(await ready(passing, join(c, "ready-1")), d);
		for (const name of Object.keys(inD)) expect(snapshot(d)[name]).toBe(inD[name]);
		expect(snapshot(outside)).toEqual(out);

		const killed = start("inline.fixture.ts", d, { FIX_BLOCK: "1", FIX_READY: join(c, "ready-2") });
		const report = await ready(killed, join(c, "ready-2"));
		killed.kill("SIGKILL");
		await killed.exited;
		await settled(report, d);
		for (const name of Object.keys(inD)) expect(snapshot(d)[name]).toBe(inD[name]);
		expect(snapshot(outside)).toEqual(out);
	}, 30_000);

	test("T9 no late second deletion: a dir made at a finished run's old root path survives later runs", async () => {
		const [d, c] = [fresh("d"), fresh("c")];
		const first = start("inline.fixture.ts", d, { FIX_READY: join(c, "ready-1") });
		expect(await first.exited).toBe(0);
		const old = await ready(first, join(c, "ready-1"));
		await settled(old, d);
		// The old tree has no run root (its tmpdir() was D): X then takes a root-shaped name no run used.
		const x = old.tmpdir !== d ? old.tmpdir : join(d, `as2-test-run-${randomBytes(8).toString("hex")}`);
		mkdirSync(x);
		writeFileSync(join(x, "x.txt"), "X\n");

		const normal = start("inline.fixture.ts", d, { FIX_READY: join(c, "ready-2") });
		expect(await normal.exited).toBe(0);
		await settled(await ready(normal, join(c, "ready-2")), d);
		expect(snapshot(x)).toEqual({ "x.txt": "file:X\n" });

		const killed = start("inline.fixture.ts", d, { FIX_BLOCK: "1", FIX_READY: join(c, "ready-3") });
		const report = await ready(killed, join(c, "ready-3"));
		killed.kill("SIGKILL");
		await killed.exited;
		await settled(report, d);
		expect(snapshot(x)).toEqual({ "x.txt": "file:X\n" });
	}, 30_000);

	for (const [swap, end] of [
		["link", "normal"],
		["link", "SIGKILL"],
		["dir", "normal"],
		["dir", "SIGKILL"],
	] as const) {
		const what = swap === "link" ? "a symlink to an outside dir C" : "a foreign dir F";
		test.skipIf(!NEW_TREE)(`T13 a live run root renamed away and replaced by ${what}: C's and F's files survive (${end} end)`, async () => {
			const [d, c, outside] = [fresh("d"), fresh("c"), fresh("outside")];
			writeFileSync(join(outside, "c.txt"), "outside\n");
			const proc = start("swap.fixture.ts", d, {
				FIX_SWAP: swap,
				FIX_OUTSIDE: outside,
				FIX_READY: join(c, "ready"),
				...(end === "SIGKILL" ? { FIX_BLOCK: "1" } : {}),
			});
			let report: Report | undefined;
			try {
				report = await ready(proc, join(c, "ready"));
				if (end === "SIGKILL") proc.kill("SIGKILL");
				const code = await proc.exited;
				if (end === "normal") expect({ code, out: await output(proc) }).toMatchObject({ code: 0 });
				// The watchdog has had its turn once it exited: wait for that, not for a dir that must stay.
				const pid = Number(readFileSync(join(report.moved!, ".as2-watchdog"), "utf8"));
				expect(pid).toBeGreaterThan(0);
				const gone = (): boolean => {
					try {
						process.kill(pid, 0);
						return false;
					} catch (e) {
						return e instanceof Error && "code" in e && e.code === "ESRCH";
					}
				};
				await until(gone, `watchdog ${pid} exited`);

				const name = basename(report.made!);
				const home = basename(report.home!);
				const kept = {
					[name]: "dir",
					[`${name}/keep.txt`]: `file:${swap}\n`,
					[home]: "dir",
					[`${home}/keep.txt`]: `file:${swap}\n`,
				};
				if (swap === "link") {
					expect(snapshot(outside)).toMatchObject({ "c.txt": "file:outside\n", ...kept });
					// Nor is the symlink itself removed: it is not the root the watchdog made.
					expect(lstatSync(report.tmpdir, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
				} else {
					expect(snapshot(report.tmpdir)).toMatchObject({ "f.txt": "file:foreign\n", ...kept });
				}
				// The real root, under its new name, is left alone too: the run no longer knows it.
				expect(readFileSync(join(report.moved!, name, "data.txt"), "utf8")).toBe("fixture data\n");
			} finally {
				// This case removes what the run left: the renamed real root, the replacement at the root path, C.
				if (report?.moved) rmSync(report.moved, { recursive: true, force: true });
				if (report && lstatSync(report.tmpdir, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(report.tmpdir);
				else if (report) rmSync(report.tmpdir, { recursive: true, force: true });
				rmSync(outside, { recursive: true, force: true });
			}
		}, 30_000);
	}
});

describe("LEDGER_TEST_TMP", () => {
	test("T6 scratchLedger() under LEDGER_TEST_TMP = E outside D leaves E empty, on a normal end and on SIGKILL", async () => {
		const [d, e, c] = [fresh("d"), fresh("e"), fresh("c")];
		const normal = start("scratch-ledger.fixture.ts", d, { LEDGER_TEST_TMP: e });
		expect({ code: await normal.exited, out: await output(normal) }).toMatchObject({ code: 0 });
		await empty(e);

		const killed = start("scratch-ledger.fixture.ts", d, { LEDGER_TEST_TMP: e, FIX_BLOCK: "1", FIX_READY: join(c, "ready") });
		await ready(killed, join(c, "ready"));
		expect(tree(e).length).toBeGreaterThan(0);
		killed.kill("SIGKILL");
		await killed.exited;
		await empty(e);
	}, 30_000);
});

describe("concurrent and nested runs", () => {
	test("T7 two live runs in one D: the second's root and files outlive the first run's end", async () => {
		const [d, c] = [fresh("d"), fresh("c")];
		const a = start("inline.fixture.ts", d, { FIX_BLOCK: "1", FIX_READY: join(c, "ready-a") });
		const b = start("inline.fixture.ts", d, { FIX_BLOCK: "1", FIX_READY: join(c, "ready-b") });
		const [ra, rb] = [await ready(a, join(c, "ready-a")), await ready(b, join(c, "ready-b"))];
		release(a);
		expect(await a.exited).toBe(0);
		await settled(ra, d);
		expect(existsSync(rb.tmpdir)).toBe(true);
		expect(readFileSync(join(rb.made!, "data.txt"), "utf8")).toBe("fixture data\n");
		release(b);
		expect(await b.exited).toBe(0);
		await empty(d);
	}, 30_000);

	for (const shape of ["full", "curated"] as const) {
		test(`T10${shape === "curated" ? "b" : ""} a nested run (${shape} env) keeps its root while its SIGKILLed parent's goes`, async () => {
			const [d, c] = [fresh("d"), fresh("c")];
			const releaseNested = join(c, "release-nested");
			const parent = start("nested.fixture.ts", d, {
				FIX_READY: join(c, "ready-parent"),
				FIX_NESTED_READY: join(c, "ready-nested"),
				FIX_NESTED_RELEASE: releaseNested,
				FIX_NESTED_ENV: shape,
			});
			try {
				const outer = await ready(parent, join(c, "ready-parent"));
				const nested = JSON.parse(readFileSync(join(c, "ready-nested"), "utf8")) as Report;
				if (NEW_TREE) {
					// Beside the parent's root, never inside it.
					expect(nested.tmpdir).not.toBe(outer.tmpdir);
					expect(dirname(nested.tmpdir)).toBe(d);
					expect(basename(nested.tmpdir)).toMatch(/^as2-test-run-[0-9a-f]{16}$/);
				}
				parent.kill("SIGKILL");
				await parent.exited;
				await settled(outer, d);
				expect(existsSync(nested.tmpdir)).toBe(true);
				expect(readFileSync(join(nested.made!, "data.txt"), "utf8")).toBe("fixture data\n");
			} finally {
				// Releases the nested run, which outlives its parent; on a failure too, so it never lingers.
				writeFileSync(releaseNested, "");
			}
			await empty(d);
		}, 30_000);
	}
});

describe("init", () => {
	// The kill lands at a different stage each time, each found by polling D, never by a fixed sleep, and each
	// asserted reached (with the run still alive) before its kill. The pre-ack stage is held, not raced: its
	// watchdog (W through the AS2_TEST_TMP_WATCHDOG_SCRIPT seam) writes `.paused` after its mkdir and waits
	// for `.go`, which the case writes once the run is dead. That stage and the acked one exist only on the
	// new tree (the old tree has no watchdog); the old tree runs the other three.
	interface Stage {
		stage: string;
		reached: (d: string) => boolean;
		newTree?: true;
		/** Extra fixture env; a function because W is imported at run time. */
		env?: () => Promise<Record<string, string>>;
	}
	const roots = (d: string): string[] => readdirSync(d).map((n) => join(d, n));
	const stages: Stage[] = [
		{ stage: "at spawn", reached: () => true },
		{ stage: "at spawn, again", reached: () => true },
		{
			stage: "after the watchdog's mkdir, before its ack",
			reached: (d) => roots(d).some((r) => existsSync(join(r, ".paused")) && !existsSync(join(r, ".as2-watchdog"))),
			newTree: true,
			env: async () => {
				const W = await watchdogScript();
				const anchor = 'i=$(ls -di -- "$1"); ';
				const paused = W.replace(anchor, `${anchor}: > "$1/.paused"; while [ ! -e "$1/.go" ]; do sleep 0.01; done; `);
				if (!W.includes(anchor) || paused === W) throw new Error(`W has no ${anchor}: ${W}`);
				return { AS2_TEST_TMP_WATCHDOG_SCRIPT: paused };
			},
		},
		{ stage: "once the watchdog acked", reached: (d) => roots(d).some((r) => existsSync(join(r, ".as2-watchdog"))), newTree: true },
		{ stage: "once the temp HOME exists", reached: (d) => tree(d).some((p) => basename(p).startsWith("as2-test-home-")) },
	];
	test(`T8 a run SIGKILLed during init (${NEW_TREE ? 5 : 3} times, at different stages) leaves D empty every time`, async () => {
		for (const { stage, reached, newTree, env } of stages) {
			if (newTree && !NEW_TREE) continue;
			const d = fresh("d");
			const proc = start("inline.fixture.ts", d, { FIX_BLOCK: "1", ...(env ? await env() : {}) });
			for (const deadline = Date.now() + READY_MS; !reached(d) && proc.exitCode === null && Date.now() < deadline; ) await Bun.sleep(1);
			const hit = proc.exitCode === null && reached(d);
			const exitBefore = proc.exitCode;
			proc.kill("SIGKILL");
			await proc.exited;
			// Releases a paused watchdog (its run is dead now); on a failure too, so it never lingers.
			for (const r of roots(d)) if (existsSync(join(r, ".paused"))) writeFileSync(join(r, ".go"), "");
			if (!hit) throw new Error(`stage not reached before the kill: ${stage} (exit before kill: ${exitBefore}); D: ${JSON.stringify(tree(d))}`);
			try {
				await empty(d);
			} catch (e) {
				throw new Error(`killed ${stage}: ${(e as Error).message}`);
			}
		}
	}, 45_000);

	test.skipIf(!NEW_TREE)("T8b the watchdog removes only a root its own mkdir created: a competitor dir at its path survives", async () => {
		const W = await watchdogScript();
		const d = fresh("d");
		const competitor = join(d, `as2-test-run-${randomBytes(8).toString("hex")}`);
		mkdirSync(competitor);
		writeFileSync(join(competitor, "competitor.txt"), "mine\n");
		const dog = Bun.spawn(["/bin/sh", "-c", W, "as2-test-tmp-watchdog", competitor], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
		dog.stdin.end();
		expect(await dog.exited).toBe(0);
		expect(snapshot(competitor)).toEqual({ "competitor.txt": "file:mine\n" });

		// Control: on a free path it creates, acks with its pid, and removes the root once its stdin closes.
		const own = join(d, `as2-test-run-${randomBytes(8).toString("hex")}`);
		const owner = Bun.spawn(["/bin/sh", "-c", W, "as2-test-tmp-watchdog", own], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
		await until(() => existsSync(join(own, ".as2-watchdog")) && readFileSync(join(own, ".as2-watchdog"), "utf8") === `${owner.pid}\n`, "ack");
		owner.stdin.end();
		expect(await owner.exited).toBe(0);
		expect(existsSync(own)).toBe(false);
	}, 30_000);

	test.skipIf(!NEW_TREE)("T11 a watchdog that cannot be spawned aborts the run before any test, leaving D empty", async () => {
		const [d, c] = [fresh("d"), fresh("c")];
		const proc = start("inline.fixture.ts", d, { AS2_TEST_TMP_SH: "/nonexistent/sh", FIX_MARKER: join(c, "ran") });
		const code = await proc.exited;
		const out = await output(proc);
		expect(code).not.toBe(0);
		expect(out).toContain("no watched run root");
		expect(existsSync(join(c, "ran"))).toBe(false);
		await empty(d);
	}, 30_000);

	test.skipIf(!NEW_TREE)("T12 a watchdog that never acks aborts the run after 3 tries, each root removed by its own watchdog", async () => {
		const W = await watchdogScript();
		const silent = W.replace(/ printf [^;]*;/, "");
		expect(silent).not.toContain("printf");
		const [d, c] = [fresh("d"), fresh("c")];
		const proc = start("inline.fixture.ts", d, { AS2_TEST_TMP_WATCHDOG_SCRIPT: silent, AS2_TEST_TMP_ACK_MS: "200", FIX_MARKER: join(c, "ran") });
		const code = await proc.exited;
		const out = await output(proc);
		expect(code).not.toBe(0);
		expect(out).toContain("no watched run root");
		expect(out).toContain("no ack in 200 ms");
		expect(existsSync(join(c, "ran"))).toBe(false);
		await empty(d);
	}, 30_000);

	test.skipIf(!NEW_TREE)("T14 a process that only imports the module keeps its own SIGTERM handling and TMPDIR, and makes no root", async () => {
		const d = fresh("d");
		const proc = Bun.spawn([process.execPath, join(FIXTURES, "import-only.ts")], { cwd: FIXTURES, env: { ...process.env, TMPDIR: d }, stdout: "pipe", stderr: "pipe" });
		const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect({ code, out: out.trim(), err }).toEqual({ code: 0, out: JSON.stringify({ handled: true, tmpdir: d }), err: "" });
		expect(tree(d)).toEqual([]);
	}, 30_000);
});
