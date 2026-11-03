// The `_as2test` wrapper, test-exec, the preflight, the refresh helper and the setup script
// (MIGRATION.md item 24; the approved plan of workload wl-muraerdsgw7gn4, revision 12, § 2.3 steps 1
// and 3, § 3.1, § 6 S4b; the refresh helper: workload wl-mv718fxhwwcn40, PLAN revision 6, § 1.1,
// § 1.2 and § 2 T5-T7).
//
// Everything runs in the fence as the current user: a fake `sudo` on PATH strips `-n -u _as2test`
// and execs a wrapper rendered into a tmp root with `sweepScope: groups`, so a sweep reaches only
// the process groups that wrapper started. The refresh helper is rendered as a test render
// (`buildUser: null`, `asRoot: false`, a local bare origin) into a tmp libexec. The setup script
// runs with fake dscl, sudo and visudo under AS2TEST_SETUP_TEST_PREFIX; real sudo is never called.
import { Database } from "bun:sqlite";
import { afterAll, test as bunTest, describe, expect } from "bun:test";
import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, watch, writeFileSync, writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import * as as2test from "../src/as2test";
import {
	bundleInputs, CAPTURE_MS, CREDENTIAL_PATHS, execArgv, execConfigOf, type InstallVerdict, installDecision, installLayout, parseSource, preflightDecision,
	preflightProbes, probeCall, probeDecision, readInstall, renderExecWrapper, type SweepScope, UID_SWEEP, WrapperRenderError,
} from "../src/as2test";
import { snapshot, STUCK_DEFAULTS } from "../src/stuck-detect";
import { AS2TEST_USER, CHILD_ENV_ALLOWLIST, childEnv, partResult, WRAPPER_EXIT, type WrapperCall } from "../src/test-run";
import { tmp, unreapedTrue } from "./helpers";

/**
 * This change's new exports (PLAN wl-mv718fxhwwcn40 § 2), reached loosely so the file still loads
 * where they do not exist: there each test fails on `expect(typeof …).toBe("function")`.
 */
const loose = as2test as unknown as Record<string, unknown>;
/** The named export, once `typeof` says it is a function; the cast names the shape the test calls. */
function newExport<T>(name: string): T {
	const v = loose[name];
	expect(typeof v).toBe("function");
	return v as T;
}
type RenderRefresh = (o: Record<string, unknown>) => string;

const REPO = realpathSync(join(import.meta.dir, "..", ".."));
const SCRIPT = join(REPO, "surface", "scripts", "test-exec.ts");
const SETUP = join(REPO, "install", "as2test-setup.sh");
const BUN = process.execPath;
const SYS_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** The tag the refresh helper fetches (PLAN wl-mvq4edbaf13vnk § 2 "The bundle"), spelled out: a rename must break these tests. */
const VERIFIED_TAG = "as2-verified";

/** chmod u+rwx every directory beneath, so rmSync can delete what a test sealed. A path already gone is nothing to unseal. */
function unseal(p: string): void {
	let st;
	try {
		st = lstatSync(p);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!st.isDirectory()) return;
	chmodSync(p, 0o755);
	for (const n of readdirSync(p)) unseal(join(p, n));
}

/**
 * What one case made: its tmp directories, the subprocesses it spawned, and the other processes it took (each pid with the
 * start time `ps` gave when the case took it, its identity: a pid already gone then is never signalled, and a pid that names
 * another process by release is left alone). The case's own wrapper (`test` below) releases them inside the case's own time.
 */
interface Owned {
	name: string;
	dirs: string[];
	subprocs: { pid: number; exitCode: number | null; signalCode: string | null; exited: Promise<number>; kill(signal?: NodeJS.Signals): void }[];
	procs: { pid: number; started: number }[];
}
let owner: Owned | null = null;
function owning(what: string): Owned {
	if (owner === null) throw new Error(`as2test.test.ts: ${what} was made outside a case; only a case can own it`);
	return owner;
}

/**
 * `pid → start time (µs)` for those of `list` that exist now (a zombie exists), from the detector's own spawn-free process
 * list (`snapshot`, sysctl KERN_PROC_UID): no ps, which a sandboxed run may not spawn.
 */
function startTimes(list: number[]): Map<number, number> {
	const out = new Map<number, number>();
	if (list.length === 0) return out;
	const s = snapshot(process.getuid!());
	if (s.kind !== "ok") throw new Error(`the process list for pids ${list.join(", ")} is ${s.kind}: ${s.why}`);
	for (const p of s.procs) if (list.includes(p.pid)) out.set(p.pid, p.startUs);
	return out;
}

/** The current case owns these processes (fixture pids, process group leaders): it SIGKILLs and reaps them at its end. */
function own(...list: number[]): void {
	const o = owning(`a process (${list.join(", ")})`);
	for (const [pid, started] of startTimes(list)) o.procs.push({ pid, started });
}

/**
 * Release what `o` owns: SIGKILL each subprocess still running and each taken process that is still the one taken, await
 * every exit (a subprocess's `exited`, any other process's kernel exit event through `exitOf`), then unseal and remove its
 * directories. Every failure is returned, none stops the rest.
 */
async function release(o: Owned): Promise<Error[]> {
	const errors: Error[] = [];
	const failed = (what: string, error: unknown) => errors.push(new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
	for (const p of o.subprocs) {
		if (p.exitCode !== null || p.signalCode !== null) continue;
		try {
			p.kill("SIGKILL");
		} catch (error) {
			failed(`SIGKILL subprocess ${p.pid}`, error);
		}
	}
	const killed: number[] = [];
	let now = new Map<number, number>();
	try {
		now = startTimes([...new Set(o.procs.map((p) => p.pid))]);
	} catch (error) {
		failed("reading the start times of the owned processes", error);
	}
	for (const { pid, started } of o.procs) {
		if (now.get(pid) !== started || killed.includes(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
			killed.push(pid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") failed(`SIGKILL ${pid}`, error);
		}
	}
	const exits = await Promise.allSettled([...o.subprocs.map((p) => p.exited), ...killed.map((pid) => exitOf(pid))]);
	for (const e of exits) if (e.status === "rejected") failed("awaiting an owned process's exit", e.reason);
	for (const d of o.dirs) {
		try {
			unseal(d);
			rmSync(d, { recursive: true, force: true });
		} catch (error) {
			failed(`removing ${d}`, error);
		}
	}
	return errors;
}

/** A case whose `finally` bun test never ran (it timed out): its leftovers are released by the next case, or after the file. */
async function releaseAbandoned(): Promise<void> {
	const left = owner;
	if (left === null) return;
	owner = null;
	const errors = await release(left);
	if (errors.length > 0) throw new AggregateError(errors, `releasing what the abandoned case "${left.name}" owned failed: ${errors.map((e) => e.message).join("; ")}`);
}
afterAll(releaseAbandoned);

/**
 * bun test's `test`, with the case owning what it makes: its body runs, then everything it owns is released and awaited
 * inside its own timeout. A body failure is rethrown as is; a release failure fails the case too, joined with the body's.
 */
function test(name: string, body: () => unknown, timeout?: number): void {
	bunTest(name, async () => {
		await releaseAbandoned();
		const o: Owned = { name, dirs: [], subprocs: [], procs: [] };
		owner = o;
		let failure: { error: unknown } | null = null;
		try {
			await body();
		} catch (error) {
			failure = { error };
		}
		owner = null;
		const errors = await release(o);
		if (failure && errors.length > 0) throw new AggregateError([failure.error, ...errors], `${name}: the case failed, and releasing what it owned failed too: ${errors.map((e) => e.message).join("; ")}`);
		if (failure) throw failure.error;
		if (errors.length > 0) throw new AggregateError(errors, `${name}: releasing what the case owned failed: ${errors.map((e) => e.message).join("; ")}`);
	}, timeout);
}

const dir = (tag: string): string => {
	const o = owning(`the tmp dir ${tag}`);
	const d = realpathSync(tmp(`as2test-${tag}`));
	o.dirs.push(d);
	return d;
};

const FAKE_SUDO = `#!/bin/sh
# fake sudo for the fence: the runner's argv is exactly sudo -n -u _as2test <exec> ...; run <exec> as the current user.
[ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = ${AS2TEST_USER} ] || { echo "fake sudo: unexpected argv: $*" >&2; exit 1; }
shift 3
exec "$@"
`;
/** Explicit synthetic resource costs for fixture behavior: never a host measurement or a policy to install for real. */
const SYNTHETIC_POLICY = JSON.stringify({ workerCpu: 1, workerMemoryBytes: 1, reserveCpu: 0, reserveMemoryBytes: 0, calibration: "synthetic test fixture only; not host calibration" });

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** Every pid in `list` has exited: each one's kernel exit event (`exitOf`); a pid already gone counts. */
async function exited(...list: number[]): Promise<void> {
	await Promise.all(list.map(exitOf));
}

/** `path` exists, awaited on its directory's events (`when`); `p` exiting first is an error. */
function appeared(path: string, what: string, p?: Wrapper): Promise<true> {
	return when(dirname(path), () => (existsSync(path) ? true : undefined), what, p);
}

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd, env: { PATH: SYS_PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

interface Box {
	root: string;
	exec: string;
	bin: string;
	hooks: string;
}

/** The detector's test-only knobs a box's wrapper may carry (PLAN wl-mvq8x4pkjmx69s D3). */
interface DetectKnobs {
	detectTickMs?: number;
	detectPersistMs?: number;
	signatureCaptureMs?: number;
	stopGraceMs?: number;
	detectTrace?: boolean;
	detectFeed?: boolean;
}

/** A tmp as2test root with a groups-scope wrapper and a fake sudo on PATH (§ 6 S4b). */
function box(tag: string, opts: { killGraceMs?: number; sweepLockWaitMs?: number; captureMs?: number; script?: string } & DetectKnobs = {}): Box {
	const base = dir(tag);
	const root = join(base, "root");
	for (const d of ["stage", "runs", "locks"]) mkdirSync(join(root, d), { recursive: true });
	writeFileSync(join(root, "locks", "sweep.db"), "", { mode: 0o600 });
	const hooks = join(base, "hooks");
	mkdirSync(hooks);
	const bin = join(base, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "sudo"), FAKE_SUDO, { mode: 0o755 });
	const exec = join(base, "exec");
	const resourcesPath = join(root, "resources.json");
	writeFileSync(resourcesPath, SYNTHETIC_POLICY);
	const { script, killGraceMs, ...limits } = opts;
	writeFileSync(exec, renderExecWrapper({ root, bun: BUN, script: script ?? SCRIPT, sweepScope: "groups", resourcesPath, hooks, killGraceMs: killGraceMs ?? 500, ...limits }), { mode: 0o755 });
	return { root, exec, bin, hooks };
}

/** A second wrapper over the same root with other test limits. */
function wrapperFor(b: Box, name: string, opts: { sweepLockWaitMs?: number }): string {
	const exec = join(b.root, "..", name);
	writeFileSync(exec, renderExecWrapper({ root: b.root, bun: BUN, script: SCRIPT, sweepScope: "groups", resourcesPath: join(b.root, "resources.json"), hooks: b.hooks, killGraceMs: 500, ...opts }), { mode: 0o755 });
	return exec;
}

/** The caller's env carries credentials; the wrapper's `env -i` must drop them. */
const callerEnv = (b: Box) => ({
	PATH: `${b.bin}:${SYS_PATH}`, HOME: "/nonexistent-home", GH_TOKEN: "ghp_secret", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai", MOONSHOT_API_KEY: "ms",
	SSH_AUTH_SOCK: "/tmp/agent.sock", OMP_TOKEN: "omp", AGENT_SYSTEM_TEST_RUNS: "/tmp/runs", AGENT_SYSTEM_LEDGER_DB: "/tmp/ledger.db", TMPDIR: "/nonexistent-caller-tmp", LANG: "C",
});

interface Ran {
	exit: number | null;
	stdout: string;
	stderr: string;
}
function raw(b: Box, args: string[], exec = b.exec): Ran {
	const r = Bun.spawnSync(["sudo", "-n", "-u", AS2TEST_USER, exec, ...args], { env: callerEnv(b), stdout: "pipe", stderr: "pipe" });
	return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
function call(b: Box, c: WrapperCall): Ran {
	const r = Bun.spawnSync(execArgv(c, b.exec), { env: callerEnv(b), stdout: "pipe", stderr: "pipe" });
	return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
function spawnCall(b: Box, c: WrapperCall, exec = b.exec) {
	const o = owning("a wrapper call");
	const p = Bun.spawn(execArgv(c, exec), { env: callerEnv(b), stdout: "pipe", stderr: "pipe" });
	o.subprocs.push(p);
	return p;
}

const setCurrent = (b: Box, runId: string) => writeFileSync(join(b.root, "stage", "current"), `${runId}\n`);
const workOf = (b: Box, runId: string) => join(b.root, "runs", runId);

/** A fixture repo bundled into `<stage>/<run id>/repo.bundle`, with caps; returns the head sha. */
function stageRepo(b: Box, runId: string, files: Record<string, string>, caps: Record<string, unknown> = { fullCapMin: 1, soloCapMin: 1 }): string {
	const src = join(b.root, "..", `src-${runId}`);
	mkdirSync(src, { recursive: true });
	git(src, "init", "-q", "-b", "main");
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(join(src, p, ".."), { recursive: true });
		writeFileSync(join(src, p), text);
	}
	git(src, "add", "-A");
	git(src, "commit", "-q", "-m", "fixture");
	const sha = git(src, "rev-parse", "HEAD");
	const stage = join(b.root, "stage", runId);
	mkdirSync(stage, { recursive: true });
	git(src, "bundle", "create", "-q", join(stage, "repo.bundle"), "--all");
	writeFileSync(join(stage, "caps.json"), JSON.stringify(caps));
	return sha;
}

const OK_TEST = `import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n`;
const ENV_TEST = `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("env", () => { writeFileSync("../env.json", JSON.stringify(process.env)); });\n`;
const SLOW_TEST = `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("slow", async () => {\n\tconst c = Bun.spawn(["/bin/sleep", "300"]);\n\twriteFileSync("../slow.pid", String(c.pid));\n\tawait new Promise(() => {});\n}, 600_000);\n`;
const ORPHAN_TEST = `import { test } from "bun:test";\ntest("orphan", () => {\n\tBun.spawnSync(["/bin/sh", "-c", "/bin/sleep 300 >/dev/null 2>&1 & echo $! > ../orphan.pid"]);\n});\n`;
/** The same, but the grandchild ignores SIGTERM: only a SIGKILL ends it. */
const STUBBORN_TEST = `import { test } from "bun:test";\ntest("stubborn", () => {\n\tBun.spawnSync(["/bin/sh", "-c", "(trap '' TERM; exec /bin/sleep 300) >/dev/null 2>&1 & echo $! > ../orphan.pid"]);\n});\n`;

/** prepare a fresh run: stage the repo, publish current, clone. */
function prepared(b: Box, runId: string, files: Record<string, string>, caps?: Record<string, unknown>): string {
	const sha = stageRepo(b, runId, files, caps);
	setCurrent(b, runId);
	const r = call(b, { sub: "prepare", runId, sha });
	expect(r.stderr).toBe("");
	expect(r.exit).toBe(WRAPPER_EXIT.ok);
	return sha;
}

describe("executor resource and proof boundary", () => {
	test("full launch records admitted capacity and bounds both file workers and concurrent cases", () => {
		const b = box("resources-full");
		prepared(b, "tr-resfull", {
			"ok.test.ts": OK_TEST,
			"nested.test.ts": `import { expect, test } from "bun:test";\nlet active = 0;\ntest.concurrent.each(["first", "second"])("%s", async () => {\n active++;\n await Promise.resolve();\n expect(active).toBe(1);\n active--;\n});\n`,
		}, { fullCapMin: 1, fullWorkers: 2 });
		const r = call(b, { sub: "full", runId: "tr-resfull" });
		expect(r.exit).toBe(0);
		const receipt = JSON.parse(readFileSync(join(b.root, "runs/tr-resfull/full.resources.json"), "utf8"));
		expect(receipt.status).toBe("admitted");
		expect(receipt.configuredWorkers).toBe(2);
		expect(receipt.selectedWorkers).toBeGreaterThan(0);
		expect(receipt.selectedWorkers).toBeLessThanOrEqual(2);
		expect(receipt.nestedConcurrency).toBe(1);
		expect(receipt.bun.controls).toContain("--max-concurrency=1");
		expect(receipt.costs.calibration).toContain("synthetic");
		expect(receipt.inputs.availableMemoryBytes).toBeLessThanOrEqual(receipt.inputs.totalMemoryBytes);
	});
	test("missing calibration fails before child launch and retains an error receipt", () => {
		const b = box("resources-missing");
		prepared(b, "tr-resmissing", { "ok.test.ts": OK_TEST });
		rmSync(join(b.root, "resources.json"));
		const r = call(b, { sub: "full", runId: "tr-resmissing" });
		expect(r.exit).toBe(WRAPPER_EXIT.failed);
		expect(r.stderr).toContain("resource calibration");
		const work = join(b.root, "runs/tr-resmissing");
		expect(existsSync(join(work, "full.xml"))).toBe(false);
		expect(JSON.parse(readFileSync(join(work, "full.resources.json"), "utf8"))).toMatchObject({ status: "error", selectedWorkers: null });
	});
	test("proof budget flag reaches only admitted proof children without caller credentials", () => {
		for (const enabled of [false, true]) {
			const b = box(`proof-env-${enabled}`);
			const runId = enabled ? "tr-proofyes" : "tr-proofno";
			prepared(b, runId, { "env.test.ts": ENV_TEST }, { fullCapMin: 1, timingProof: { productionBudget: enabled, installedOmp: false } });
			const r = call(b, { sub: "full", runId });
			expect(r.exit).toBe(0);
			const env = JSON.parse(readFileSync(join(b.root, "runs", runId, "env.json"), "utf8"));
			expect(env.AS2_STUCK_BUDGET_PROOF).toBe(enabled ? "1" : undefined);
			expect(env.GH_TOKEN).toBeUndefined();
			expect(env.PATH).not.toContain(b.bin);
			expect(env.HOME).toBe(join(b.root, "runs", runId, "home"));
		}
	});
	test("extra proof fields and operator-user installed OMP are failures, not skipped tests", () => {
		for (const timingProof of [{ productionBudget: true, installedOmp: false, env: { GH_TOKEN: "bad" } }, { productionBudget: false, installedOmp: true }]) {
			const b = box("proof-refuse");
			prepared(b, "tr-proofrefuse", { "ok.test.ts": OK_TEST }, { fullCapMin: 1, timingProof });
			const r = call(b, { sub: "full", runId: "tr-proofrefuse" });
			expect(r.exit).toBe(WRAPPER_EXIT.failed);
			expect(r.stderr).toContain("admission failed");
			expect(existsSync(join(b.root, "runs/tr-proofrefuse/full.xml"))).toBe(false);
		}
	});
});

// ---- the stuck capture's file (PLAN wl-mvq4edh02r5z40 D5) ----------------------------------------------------

/** `<part>.stuck.log` split at its `== <n>. … ==` headings: section number → body. */
function stuckSections(text: string): Record<string, string> {
	const parts = text.split(/^== (\d)\. .* ==$/m);
	const out: Record<string, string> = {};
	for (let i = 1; i < parts.length; i += 2) out[parts[i]!] = parts[i + 1]!;
	return out;
}
/** The pids section 1 lists: the first column of each row, from ps or from its pgrep fallback. */
const treePids = (section: string): number[] => section.split("\n").flatMap((l) => /^(\d+)\s/.exec(l)?.slice(1).map(Number) ?? []);
/** Every capture tool the file names: the `[pid <n>,` of each tool block, and the groups a cut killed. */
function capturePids(text: string): number[] {
	const killed = /^killed capture groups(?: still running)?: (.*)$/m.exec(text)?.[1] ?? "";
	return [...[...text.matchAll(/\[pid (\d+),/g)].map((m) => Number(m[1])), ...killed.split(" ").filter((s) => /^\d+$/.test(s)).map(Number)];
}
/** What a capture may leave in the work dir besides its file: its cap dir or a sample report. */
const captureLeftovers = (work: string): string[] => readdirSync(work).filter((n) => n.includes(".stuck-") || n.startsWith("sample-"));

// ---- the wrapper's argv checks ---------------------------------------------------------------------------

describe("the wrapper refuses bad argv", () => {
	/** The case's own box, current run tr-a1. */
	const argvBox = (): Box => {
		const b = box("argv");
		setCurrent(b, "tr-a1");
		return b;
	};

	test("a run id outside ^tr-[a-z0-9]+$ is refused, by the sh wrapper and by test-exec itself", () => {
		const b = argvBox();
		for (const id of ["tr-", "tr-A1", "tr-a_1", "x-a1", "tr-a1/../b", "tr-a1 ", "../tr-a1"]) {
			const r = raw(b, ["full", id]);
			expect(r.exit).toBe(WRAPPER_EXIT.refused);
			expect(r.stderr).toContain("run id");
		}
		const direct = Bun.spawnSync([BUN, SCRIPT, "full", "tr-A1"], {
			env: { PATH: SYS_PATH, AS2TEST_EXEC_CONFIG: JSON.stringify(execConfigOf({ root: b.root, bun: BUN, script: SCRIPT, sweepScope: "groups" })) }, stderr: "pipe",
		});
		expect(direct.exitCode).toBe(WRAPPER_EXIT.refused);
		expect(() => execArgv({ sub: "full", runId: "tr-A1" })).toThrow();
	});

	test("wrong arity is refused for every subcommand", () => {
		const b = argvBox();
		for (const args of [["full"], ["full", "tr-a1", "x"], ["sweep", "tr-a1", "x"], ["prepare", "tr-a1"], ["prepare", "tr-a1", "a".repeat(40), "x"], ["solo", "tr-a1"],
			["solo", "tr-a1", "./a.test.ts", "./b.test.ts"], ["cleanup", "tr-a1"], ["cleanup", "tr-a1", "tr-b", "tr-c"], ["probe", "tr-a1"], ["bogus", "tr-a1"],
			["base-prepare", "tr-a1"], ["base-solo", "tr-a1"], ["base-solo", "tr-a1", "./a.test.ts", "./b.test.ts"], ["fast", "tr-a1"]]) {
			const r = raw(b, args);
			expect({ args, exit: r.exit }).toEqual({ args, exit: WRAPPER_EXIT.refused });
		}
	});

	test("prepare refuses a sha that is not 40 hex", () => {
		const b = argvBox();
		const r = raw(b, ["prepare", "tr-a1", "abc123"]);
		expect(r.exit).toBe(WRAPPER_EXIT.refused);
		expect(r.stderr).toContain("not a full sha");
	});

	test("without the wrapper's config test-exec refuses", () => {
		const r = Bun.spawnSync([BUN, SCRIPT, "full", "tr-a1"], { env: { PATH: SYS_PATH }, stderr: "pipe" });
		expect(r.exitCode).toBe(WRAPPER_EXIT.refused);
	});

	test("base-full is gone (PLAN wl-mvq4edh02r5z40 D3): the wrapper and test-exec both refuse it as an unknown subcommand", () => {
		const nb = box("no-base-full");
		const sha = prepared(nb, "tr-nb1", { "a.test.ts": OK_TEST });
		expect(call(nb, { sub: "base-prepare", runId: "tr-nb1", sha }).exit).toBe(WRAPPER_EXIT.ok);
		const wrapped = raw(nb, ["base-full", "tr-nb1"]);
		expect(wrapped.exit).toBe(WRAPPER_EXIT.refused);
		expect(wrapped.stderr).toContain("unknown subcommand");
		const direct = Bun.spawnSync([BUN, SCRIPT, "base-full", "tr-nb1"], {
			env: { PATH: SYS_PATH, AS2TEST_EXEC_CONFIG: JSON.stringify(execConfigOf({ root: nb.root, bun: BUN, script: SCRIPT, sweepScope: "groups" })) }, stderr: "pipe",
		});
		expect(direct.exitCode).toBe(WRAPPER_EXIT.refused);
		expect(direct.stderr.toString()).toContain("unknown subcommand base-full");
		expect(readdirSync(workOf(nb, "tr-nb1")).filter((n) => n.startsWith("base-full"))).toEqual([]);
	});
});

describe("fencing on <stage>/current", () => {
	test("every subcommand is refused when current names another run", () => {
		const b = box("fence");
		const sha = prepared(b, "tr-mine", { "a.test.ts": OK_TEST });
		setCurrent(b, "tr-other");
		const calls: WrapperCall[] = [
			{ sub: "prepare", runId: "tr-mine", sha }, { sub: "full", runId: "tr-mine" }, { sub: "solo", runId: "tr-mine", file: "./a.test.ts" },
			{ sub: "base-prepare", runId: "tr-mine", sha }, { sub: "base-solo", runId: "tr-mine", file: "./a.test.ts" },
			{ sub: "sweep", runId: "tr-mine" }, { sub: "cleanup", runId: "tr-mine", oldRunId: "tr-old" }, { sub: "probe", runId: "tr-mine", paths: ["/tmp"] },
		];
		for (const c of calls) {
			const r = call(b, c);
			expect({ sub: c.sub, exit: r.exit }).toEqual({ sub: c.sub, exit: WRAPPER_EXIT.fenced });
			expect(r.stderr).toContain("fenced");
		}
		rmSync(join(b.root, "stage", "current"));
		expect(call(b, { sub: "full", runId: "tr-mine" }).exit).toBe(WRAPPER_EXIT.fenced);
	});
});

describe("wrapper startup TMPDIR", () => {
	test("the rendered env-i command supplies an existing private per-run temp before starting Bun, and cleanup removes only the old run", () => {
		// The stand-in inspects TMPDIR at executable entry, before any Bun or JS initialization.
		const b = box("startup-tmp");
		const fakeBun = join(b.root, "..", "bun-at-entry");
		writeFileSync(fakeBun, "#!/bin/sh\n[ -d \"$TMPDIR\" ] && [ ! -L \"$TMPDIR\" ] || exit 90\n[ -z \"$GH_TOKEN\" ] && [ -z \"$HOME\" ] || exit 91\n: > \"$TMPDIR/native-at-startup\"\nprintf '%s\\n' \"$TMPDIR\"\n", { mode: 0o755 });
		const exec = join(b.root, "..", "exec-at-entry");
		writeFileSync(exec, renderExecWrapper({ root: b.root, bun: fakeBun, script: SCRIPT, sweepScope: "groups" }), { mode: 0o755 });
		for (const id of ["tr-first", "tr-second"]) {
			setCurrent(b, id);
			const r = raw(b, ["sweep", id], exec);
			expect(r.exit).toBe(0);
			const temp = join(workOf(b, id), ".wrapper-tmp");
			expect(r.stdout.trim()).toBe(temp);
			expect(realpathSync(temp)).toBe(temp);
			expect(statSync(temp).mode & 0o777).toBe(0o700);
			expect(readFileSync(join(temp, "native-at-startup"), "utf8")).toBe("");
		}
		// A startup-only run from pre-prepare sweep remains preparable, exactly once.
		expect(call(b, { sub: "sweep", runId: "tr-second" }).exit).toBe(WRAPPER_EXIT.ok);
		const sha = stageRepo(b, "tr-second", { "a.test.ts": OK_TEST });
		expect(call(b, { sub: "prepare", runId: "tr-second", sha }).exit).toBe(WRAPPER_EXIT.ok);
		expect(statSync(join(workOf(b, "tr-second"), ".wrapper-tmp")).mode & 0o777).toBe(0o700);
		expect(call(b, { sub: "prepare", runId: "tr-second", sha }).exit).toBe(WRAPPER_EXIT.refused);
		expect(call(b, { sub: "full", runId: "tr-second" }).exit).toBe(0);
		expect(call(b, { sub: "cleanup", runId: "tr-second", oldRunId: "tr-first" }).exit).toBe(0);
		expect(existsSync(workOf(b, "tr-first"))).toBe(false);
		expect(existsSync(join(workOf(b, "tr-second"), ".wrapper-tmp", "native-at-startup"))).toBe(true);
	});

	test("a real Bun process reached through the rendered wrapper sees only its run's startup TMPDIR", () => {
		const source = join(dir("startup-source"), "entry.ts");
		writeFileSync(source, `import { statSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nconst tmp = process.env.TMPDIR!;\nwriteFileSync(tmp + "/loaded-by-bun", "yes");\nconsole.log(JSON.stringify({ tmp, osTmp: tmpdir(), mode: statSync(tmp).mode & 0o777, token: process.env.GH_TOKEN ?? null }));\n`);
		const b = box("startup-real-bun", { script: source });
		for (const id of ["tr-reala", "tr-realb"]) {
			setCurrent(b, id);
			const r = call(b, { sub: "sweep", runId: id });
			expect(r.exit).toBe(0);
			const tmp = join(workOf(b, id), ".wrapper-tmp");
			expect(JSON.parse(r.stdout)).toEqual({ tmp, osTmp: tmp, mode: 0o700, token: null });
			expect(readFileSync(join(tmp, "loaded-by-bun"), "utf8")).toBe("yes");
		}
	});

	test("invalid and fenced bootstrap calls create no run directory", () => {
		const b = box("bootstrap-fenced");
		setCurrent(b, "tr-current");
		for (const args of [["full", "tr-BAD"], ["prepare", "tr-current", "bad"], ["cleanup", "tr-current", "../bad"], ["solo", "tr-current", "../bad.test.ts"], ["probe", "tr-current", "relative"]]) {
			expect(raw(b, args).exit).toBe(WRAPPER_EXIT.refused);
			expect(readdirSync(join(b.root, "runs"))).toEqual([]);
		}
		for (const sub of ["sweep", "full"]) expect(raw(b, [sub, "tr-other"]).exit).toBe(WRAPPER_EXIT.fenced);
		rmSync(join(b.root, "stage", "current"));
		expect(raw(b, ["sweep", "tr-current"]).exit).toBe(WRAPPER_EXIT.fenced);
		expect(readdirSync(join(b.root, "runs"))).toEqual([]);
		setCurrent(b, "tr-current");
		expect(raw(b, ["prepare", "tr-current", "a".repeat(40)]).exit).toBe(WRAPPER_EXIT.failed);
		expect(readdirSync(join(b.root, "runs"))).toEqual([]);
	});

	test("bootstrap refuses run, temp and area symlinks without touching their targets, including dangling links", () => {
		for (const target of ["run", "temp", "runs", "stage", "locks", "dangling"]) {
			const b = box(`bootstrap-link-${target}`);
			const outside = dir(`bootstrap-outside-${target}`);
			setCurrent(b, "tr-link");
			if (target === "run" || target === "dangling") symlinkSync(target === "run" ? outside : join(outside, "absent"), workOf(b, "tr-link"));
			else if (target === "temp") {
				mkdirSync(workOf(b, "tr-link"));
				symlinkSync(outside, join(workOf(b, "tr-link"), ".wrapper-tmp"));
			} else {
				rmSync(join(b.root, target), { recursive: true });
				symlinkSync(outside, join(b.root, target));
			}
			expect(call(b, { sub: "sweep", runId: "tr-link" }).exit).toBe(WRAPPER_EXIT.refused);
			expect(readdirSync(outside)).toEqual([]);
		}
	});

	test("bootstrap refuses a non-private existing temp instead of repairing or using it", () => {
		const b = box("bootstrap-permissions");
		setCurrent(b, "tr-public");
		const tmp = join(workOf(b, "tr-public"), ".wrapper-tmp");
		mkdirSync(tmp, { recursive: true, mode: 0o755 });
		chmodSync(tmp, 0o755);
		expect(call(b, { sub: "sweep", runId: "tr-public" }).exit).toBe(WRAPPER_EXIT.refused);
		expect(statSync(tmp).mode & 0o777).toBe(0o755);
		expect(readdirSync(tmp)).toEqual([]);
	});

	test("prepare refuses an existing non-bootstrap run without adding files, and direct prepare retains exclusive creation", () => {
		const b = box("bootstrap-existing");
		const sha = stageRepo(b, "tr-existing", { "a.test.ts": OK_TEST });
		setCurrent(b, "tr-existing");
		mkdirSync(workOf(b, "tr-existing"));
		writeFileSync(join(workOf(b, "tr-existing"), "keep"), "untouched");
		expect(call(b, { sub: "prepare", runId: "tr-existing", sha }).exit).toBe(WRAPPER_EXIT.refused);
		expect(readdirSync(workOf(b, "tr-existing"))).toEqual(["keep"]);
		const emptySha = stageRepo(b, "tr-empty", { "a.test.ts": OK_TEST });
		setCurrent(b, "tr-empty");
		mkdirSync(workOf(b, "tr-empty"));
		expect(call(b, { sub: "prepare", runId: "tr-empty", sha: emptySha }).exit).toBe(WRAPPER_EXIT.refused);
		expect(readdirSync(workOf(b, "tr-empty"))).toEqual([]);
		const directSha = stageRepo(b, "tr-direct", { "a.test.ts": OK_TEST });
		setCurrent(b, "tr-direct");
		const args = [BUN, SCRIPT, "prepare", "tr-direct", directSha];
		const env = { PATH: SYS_PATH, TMPDIR: dir("direct-runtime"), AS2TEST_EXEC_CONFIG: JSON.stringify(execConfigOf({ root: b.root, bun: BUN, script: SCRIPT, sweepScope: "groups" })) };
		expect(Bun.spawnSync(args, { env, stderr: "pipe" }).exitCode).toBe(WRAPPER_EXIT.ok);
		expect(Bun.spawnSync(args, { env, stderr: "pipe" }).exitCode).toBe(WRAPPER_EXIT.refused);
	});
});

// ---- prepare, full, solo -------------------------------------------------------------------------------------

describe("prepare, full and solo", () => {
	test("prepare clones the bundle detached at the sha, removes origin, and leaves everything readable", () => {
		const b = box("prepare");
		const sha = prepared(b, "tr-p1", { "a.test.ts": OK_TEST, "dir/b.ts": "export const b = 1;\n" });
		const repo = join(workOf(b, "tr-p1"), "repo");
		expect(git(repo, "rev-parse", "HEAD")).toBe(sha);
		expect(git(repo, "remote")).toBe("");
		expect(lstatSync(join(repo, "dir", "b.ts")).mode & 0o777).toBe(0o644);
		expect(lstatSync(join(repo, "dir")).mode & 0o777).toBe(0o755);
		expect(readFileSync(join(workOf(b, "tr-p1"), "shim", "git"), "utf8")).toContain("credential.helper=");
		// A second prepare of the same run is refused: the work dir is fresh or nothing.
		expect(call(b, { sub: "prepare", runId: "tr-p1", sha }).exit).toBe(WRAPPER_EXIT.refused);
	});

	test("full writes full.xml and full.log and passes bun's exit through; solo claims solo-1, then solo-2", () => {
		const b = box("full");
		prepared(b, "tr-f1", { "a.test.ts": OK_TEST, "b_spec.ts": `import { expect, test } from "bun:test";\ntest("bad", () => { expect(1).toBe(2); });\n` });
		const full = call(b, { sub: "full", runId: "tr-f1" });
		expect(full.exit).toBe(1);
		const work = workOf(b, "tr-f1");
		expect(readFileSync(join(work, "full.xml"), "utf8")).toContain("<testsuites");
		expect(readFileSync(join(work, "full.log"), "utf8")).toContain("bad");
		const s1 = call(b, { sub: "solo", runId: "tr-f1", file: "./a.test.ts" });
		expect(s1.exit).toBe(0);
		expect(s1.stdout).toStartWith("part solo-1\n");
		const s2 = call(b, { sub: "solo", runId: "tr-f1", file: "./b_spec.ts" });
		expect(s2.exit).toBe(1);
		expect(s2.stdout).toStartWith("part solo-2\n");
		expect(readFileSync(join(work, "solo-1.xml"), "utf8")).toContain('name="ok"');
		expect(readFileSync(join(work, "solo-2.xml"), "utf8")).toContain('name="bad"');
	});

	test("PLAN wl-mv8s8srodefytc rev 17.1 D8: base-prepare clones the same bundle into runs/<id>/base once; base-solo runs there and reports beside the PR's", () => {
		const b = box("base");
		const sha = prepared(b, "tr-b1", { "a.test.ts": OK_TEST, "b_spec.ts": `import { expect, test } from "bun:test";\ntest("bad", () => { expect(1).toBe(2); });\n` });
		const work = workOf(b, "tr-b1");
		// nothing runs on base before base-prepare
		expect(call(b, { sub: "base-solo", runId: "tr-b1", file: "./b_spec.ts" }).exit).toBe(WRAPPER_EXIT.refused);
		expect(call(b, { sub: "base-prepare", runId: "tr-b1", sha }).exit).toBe(WRAPPER_EXIT.ok);
		expect(git(join(work, "base", "repo"), "rev-parse", "HEAD")).toBe(sha);
		expect(git(join(work, "base", "repo"), "remote")).toBe("");
		// a second base-prepare, or one over a base dir the PR's tests planted, is refused
		expect(call(b, { sub: "base-prepare", runId: "tr-b1", sha }).exit).toBe(WRAPPER_EXIT.refused);
		const s = call(b, { sub: "base-solo", runId: "tr-b1", file: "./b_spec.ts" });
		expect(s.exit).toBe(1);
		expect(s.stdout).toStartWith("part base-solo-1\n");
		expect(readFileSync(join(work, "base-solo-1.xml"), "utf8")).toContain('name="bad"');
		expect(existsSync(join(work, "solo-1.xml"))).toBe(false);
		// a file base lacks is refused, never run
		expect(call(b, { sub: "base-solo", runId: "tr-b1", file: "./c.test.ts" }).exit).toBe(WRAPPER_EXIT.refused);
	});

	test("solo ../x and a path outside runs/<id>, including through a symlink, are refused", () => {
		const b = box("paths");
		const outside = dir("outside");
		writeFileSync(join(outside, "evil.test.ts"), OK_TEST);
		prepared(b, "tr-s1", { "a.test.ts": OK_TEST });
		const repo = join(workOf(b, "tr-s1"), "repo");
		symlinkSync(join(outside, "evil.test.ts"), join(repo, "link.test.ts"));
		symlinkSync(outside, join(repo, "out"));
		for (const file of ["../x.test.ts", "./../x.test.ts", "./a/../../x.test.ts", "/etc/x.test.ts", "a.test.ts", "./link.test.ts", "./out/evil.test.ts", "./a.ts"]) {
			const r = raw(b, ["solo", "tr-s1", file]);
			expect({ file, exit: r.exit }).toEqual({ file, exit: WRAPPER_EXIT.refused });
		}
		expect(existsSync(join(workOf(b, "tr-s1"), "solo-1.log"))).toBe(false);

		// runs/<id> itself swapped for a symlink to elsewhere: every part is refused.
		const b2 = box("paths2");
		const sha = stageRepo(b2, "tr-s2", { "a.test.ts": OK_TEST });
		setCurrent(b2, "tr-s2");
		mkdirSync(join(outside, "w"));
		symlinkSync(join(outside, "w"), workOf(b2, "tr-s2"));
		expect(call(b2, { sub: "prepare", runId: "tr-s2", sha }).exit).toBe(WRAPPER_EXIT.refused);
		expect(call(b2, { sub: "full", runId: "tr-s2" }).exit).toBe(WRAPPER_EXIT.refused);
		expect(call(b2, { sub: "solo", runId: "tr-s2", file: "./a.test.ts" }).exit).toBe(WRAPPER_EXIT.refused);
		expect(readdirSync(join(outside, "w"))).toEqual([]);
	});

	test("the child env holds only the allowlist and the throwaway home", () => {
		const b = box("env");
		prepared(b, "tr-e1", { "env.test.ts": ENV_TEST });
		expect(call(b, { sub: "full", runId: "tr-e1" }).exit).toBe(0);
		const work = workOf(b, "tr-e1");
		const env = JSON.parse(readFileSync(join(work, "env.json"), "utf8")) as Record<string, string>;
		// The wrapper fixes PATH, LANG, TERM and SHELL, and takes USER and LOGNAME from `id -un`, never from the caller.
		const me = userInfo().username;
		const expected = childEnv({ PATH: SYS_PATH, LANG: "en_US.UTF-8", USER: me, LOGNAME: me, SHELL: "/bin/sh", TERM: "dumb" }, work);
		// bun test sets NODE_ENV for its own tests, and JEST_WORKER_ID and BUN_TEST_WORKER_ID in each worker the part's explicit
		// `--parallel=<n>` starts; the executor adds the part's marker dir (PLAN wl-mvq8x4pkjmx69s D3); everything else is ours.
		const bunSet = ["NODE_ENV", "JEST_WORKER_ID", "BUN_TEST_WORKER_ID", "AS2TEST_STUCK_MARKERS"];
		expect(Object.keys(env).filter((k) => !(k in expected)).sort()).toEqual(Object.keys(env).filter((k) => bunSet.includes(k)).sort());
		expect(env.AS2TEST_STUCK_MARKERS).toBe(join(work, "stuck-markers-full"));
		for (const k of ["GH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "SSH_AUTH_SOCK", "OMP_TOKEN", "AGENT_SYSTEM_TEST_RUNS"]) expect(env[k]).toBeUndefined();
		for (const k of CHILD_ENV_ALLOWLIST) expect(env[k]).toBe(expected[k]!);
		expect(env.PATH).toBe(expected.PATH);
		expect(env.HOME).toBe(join(work, "home"));
		expect(env.AGENT_SYSTEM_LEDGER_DB).toBe(join(work, "home", ".agent-system-2", "ledger.db"));
		expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
	});

	test("PLAN wl-mvq4edh02r5z40 D5: at the cap full.stuck.log gets all four sections with the stuck process in the tree, then the whole group is killed and the part exits timeout naming the cap", async () => {
		const b = box("cap");
		prepared(b, "tr-c1", { "slow.test.ts": SLOW_TEST }, { fullCapMin: 0.04, soloCapMin: 0.04 });
		const t0 = Date.now();
		const r = call(b, { sub: "full", runId: "tr-c1" });
		expect(r.exit).toBe(WRAPPER_EXIT.timeout);
		expect(r.stderr).toContain("timeout: the part passed its cap of 2400 ms; its group was killed");
		expect(Date.now() - t0).toBeLessThan(2_400 + CAPTURE_MS + 500 + 5_000);
		const work = workOf(b, "tr-c1");
		const pid = Number(readFileSync(join(work, "slow.pid"), "utf8"));
		own(pid);
		await exited(pid);
		const leader = Number(readFileSync(join(work, "groups"), "utf8").trim());
		const text = readFileSync(join(work, "full.stuck.log"), "utf8");
		const s = stuckSections(text);
		expect(Object.keys(s)).toEqual(["1", "2", "3", "4"]);
		// The bun test process (the group's leader) and the sleep it started.
		expect(treePids(s["1"]!)).toEqual(expect.arrayContaining([leader, pid]));
		// sample ran for the bun process: its report, or (where sample is refused) its exit and stderr.
		expect(s["2"]).toContain(`$ /usr/bin/sample ${leader} 3 -mayDie -file `);
		expect(s["2"]).toMatch(/report \(first \d+ bytes at most\):\n|\[pid \w+, (exit [1-9]\d*|signal \w+|not run: \w+), \d+ ms\]/);
		for (const p of [leader, pid]) expect(s["3"]).toContain(`$ /usr/sbin/lsof -nP -p ${p} `);
		expect(s["4"]).toContain("slow.test.ts");
		expect(text).not.toContain("capture cut");
		expect(captureLeftovers(work)).toEqual([]);
		const tools = capturePids(text);
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.filter(alive)).toEqual([]);
	}, 60_000);

	test("full and solo refuse without the runner's caps file", () => {
		const b = box("caps");
		prepared(b, "tr-k1", { "a.test.ts": OK_TEST });
		rmSync(join(b.root, "stage", "tr-k1", "caps.json"));
		expect(call(b, { sub: "full", runId: "tr-k1" }).exit).toBe(WRAPPER_EXIT.refused);
		expect(call(b, { sub: "solo", runId: "tr-k1", file: "./a.test.ts" }).exit).toBe(WRAPPER_EXIT.refused);
	});
});

// ---- parallel files: caps.json fullWorkers (workload wl-mvg2kzuvwngdmo) -------------------------------------------

/**
 * A test file that records the pid of the bun process running it as `../pid-<name>`, sleeps `ms`, then passes or fails.
 * The sleep is real on purpose: the fixture runs in a separate bun process, and the claim under test is wall time across
 * worker processes, which no fake clock in this process can stand in for.
 */
const sleeper = (name: string, ms: number, pass = true) =>
	`import { expect, test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("sleeps ${name}", async () => {\n\twriteFileSync("../pid-${name}", String(process.pid));\n\tawait Bun.sleep(${ms});\n\texpect(${pass}).toBe(true);\n}, 60_000);\n`;
/** The distinct bun processes that ran a side's sleeper files: one when serial, one per worker under `--parallel`. */
const runners = (sideDir: string): Set<number> =>
	new Set(readdirSync(sideDir).filter((n) => n.startsWith("pid-")).map((n) => Number(readFileSync(join(sideDir, n), "utf8"))));

describe("fullWorkers: the PR full part runs its files at once; base and a keyless caps.json stay serial", () => {
	test("fullWorkers 4 over four 1.5 s files: wall below the serial sum, and the merged junit reads through partResult to the failing test", () => {
		const b = box("par");
		const SLEEP = 1_500;
		const files = { "s1.test.ts": sleeper("1", SLEEP), "s2.test.ts": sleeper("2", SLEEP), "s3.test.ts": sleeper("3", SLEEP, false), "s4.test.ts": sleeper("4", SLEEP) };
		prepared(b, "tr-par1", files, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 4 });
		const t0 = Date.now();
		const r = call(b, { sub: "full", runId: "tr-par1" });
		const wall = Date.now() - t0;
		expect(r.exit).toBe(1);
		expect(wall).toBeLessThan(4 * SLEEP);
		const work = workOf(b, "tr-par1");
		expect(runners(work).size).toBeGreaterThan(1);
		const result = partResult({ junit: readFileSync(join(work, "full.xml"), "utf8"), log: readFileSync(join(work, "full.log"), "utf8"), exit: r.exit, ms: wall });
		expect(result).toMatchObject({ pass: 3, fail: 1, skip: 0, exit: 1, error: null });
		expect(result.failures.map((f) => f.name)).toEqual(["s3.test.ts > sleeps 3"]);
	}, 60_000);

	test("with fullWorkers 3 the PR full part uses several workers; no key, or 1, runs on one; a malformed value is refused", () => {
		const b = box("ser");
		const files = { "q1.test.ts": sleeper("1", 300), "q2.test.ts": sleeper("2", 300), "q3.test.ts": sleeper("3", 300) };
		prepared(b, "tr-ser1", files, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 3 });
		const work = workOf(b, "tr-ser1");
		expect(call(b, { sub: "full", runId: "tr-ser1" }).exit).toBe(0);
		expect(runners(work).size).toBeGreaterThan(1);

		for (const [runId, caps] of [["tr-ser2", undefined], ["tr-ser3", { fullCapMin: 1, soloCapMin: 1, fullWorkers: 1 }]] as const) {
			prepared(b, runId, files, caps);
			expect(call(b, { sub: "full", runId }).exit).toBe(0);
			expect({ runId, runners: runners(workOf(b, runId)).size }).toEqual({ runId, runners: 1 });
		}

		for (const [i, bad] of [0, 2.5, "3", -2, null].entries()) {
			const runId = `tr-bad${i}`;
			prepared(b, runId, files, { fullCapMin: 1, soloCapMin: 1, fullWorkers: bad });
			const r = call(b, { sub: "full", runId });
			expect({ bad, exit: r.exit }).toEqual({ bad, exit: WRAPPER_EXIT.refused });
			expect(r.stderr).toContain("fullWorkers");
		}
	}, 120_000);

	test("timeout cleanup kills a TERM-resistant detached descendant group even when the stuck capture is cut, without killing a sibling", async () => {
		const b = box("detached-cap", { captureMs: 0 });
		const detached = `
			const { writeFileSync } = require("node:fs");
			process.on("SIGTERM", () => {});
			const child = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; exec /bin/sleep 300"]);
			writeFileSync("../detached.json", JSON.stringify({ group: process.pid, child: child.pid }));
			await child.exited;
		`;
		const fixture = `import { test } from "bun:test";
			test("detached group", async () => {
				Bun.spawn([process.execPath, "-e", ${JSON.stringify(detached)}], { detached: true, stdout: "ignore", stderr: "ignore" });
				await Promise.withResolvers().promise;
			}, 600_000);
		`;
		prepared(b, "tr-dc1", { "detached.test.ts": fixture }, { fullCapMin: 0.04, soloCapMin: 0.04 });
		const sibling = Bun.spawn(["/bin/sleep", "300"]);
		own(sibling.pid);
		try {
			const r = call(b, { sub: "full", runId: "tr-dc1" });
			const work = workOf(b, "tr-dc1");
			const { group, child } = JSON.parse(readFileSync(join(work, "detached.json"), "utf8")) as { group: number; child: number };
			own(group, child);
			expect(r.exit).toBe(WRAPPER_EXIT.timeout);
			expect(r.stderr).toContain("timeout: the part passed its cap of 2400 ms");
			// The leader cannot reap this detached group, and neither it nor its child cooperates with TERM.
			expect(readFileSync(join(work, "groups"), "utf8").split("\n").map(Number)).toContain(group);
			expect(readFileSync(join(work, "full.stuck.log"), "utf8")).toContain("capture cut");
			const s = call(b, { sub: "sweep", runId: "tr-dc1" });
			expect(s.stderr).toBe("");
			expect(s.exit).toBe(WRAPPER_EXIT.ok);
			await exited(group, child);
			expect(alive(sibling.pid)).toBe(true);
		} finally {
			sibling.kill("SIGKILL");
			await sibling.exited;
		}
	}, 30_000);

	for (const how of ["fifo", "symlink"] as const) {
		// Real processes and the wrapper's platform-clock cap are under test; fake timers cannot drive either.
		test(`timeout cleanup refuses a ${how} groups file without blocking or redirecting writes, and still kills every known detached descendant`, async () => {
			const b = box(`groups-${how}`, { captureMs: 0 });
			const runId = how === "fifo" ? "tr-gf1" : "tr-gs1";
			const detached = `
				const { writeFileSync } = require("node:fs");
				process.on("SIGTERM", () => {});
				const child = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; exec /bin/sleep 300"]);
				writeFileSync("../detached.json", JSON.stringify({ group: process.pid, child: child.pid }));
				await child.exited;
			`;
			const swap = how === "fifo"
				? `const r = Bun.spawnSync(["/usr/bin/mkfifo", "../groups"], { timeout: 1_000 }); if (r.exitCode !== 0) throw new Error("mkfifo groups: " + r.stderr.toString());`
				: `symlinkSync("groups-target", "../groups");`;
			const fixture = `import { test } from "bun:test";
				import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
				test("hostile groups persistence", async () => {
					Bun.spawn([process.execPath, "-e", ${JSON.stringify(detached)}], { detached: true, stdout: "ignore", stderr: "ignore" });
					const deadline = Date.now() + 1_500;
					while (!existsSync("../detached.json") && Date.now() < deadline) await Bun.sleep(10);
					if (!existsSync("../detached.json")) throw new Error("detached descendant did not become ready");
					if (!readFileSync("../groups", "utf8").split("\\n").includes(String(process.pid))) throw new Error("part leader not recorded");
					writeFileSync("../leader.pid", String(process.pid));
					unlinkSync("../groups");
					${swap}
					writeFileSync("../groups-swapped", "");
					await Promise.withResolvers().promise;
				}, 600_000);
			`;
			prepared(b, runId, { "hostile.test.ts": fixture }, { fullCapMin: 0.04, soloCapMin: 0.04 });
			const work = workOf(b, runId);
			const target = join(work, "groups-target");
			writeFileSync(target, "UNCHANGED\n");
			const p = spawnCall(b, { sub: "full", runId });
			try {
				// Not blocked on the hostile file: the wrapper exits (a block would hold it past the case's own timeout).
				const code = await p.exited;
				const { group, child } = JSON.parse(readFileSync(join(work, "detached.json"), "utf8")) as { group: number; child: number };
				const leader = Number(readFileSync(join(work, "leader.pid"), "utf8"));
				own(leader, group, child);
				expect(existsSync(join(work, "groups-swapped"))).toBe(true);
				expect(code).toBe(WRAPPER_EXIT.failed);
				const stderr = await new Response(p.stderr).text();
				expect(stderr).toContain("timeout: the part passed its cap of 2400 ms; its group was killed");
				expect(stderr).toContain(`timeout cleanup: cannot persist descendant groups to ${join(work, "groups")}`);
				expect(stderr).toContain("open failed:");
				expect(lstatSync(join(work, "groups"))[how === "fifo" ? "isFIFO" : "isSymbolicLink"]()).toBe(true);
				expect(readFileSync(target, "utf8")).toBe("UNCHANGED\n");
				// Do not sweep: its existing pathname read is unsafe for this deliberately hostile groups file.
				await exited(leader, group, child);
			} finally {
				if (p.exitCode === null) p.kill("SIGKILL");
				await p.exited;
			}
		}, 30_000);
	}

	test("a parallel full part past its cap exits timeout with every worker in its stuck capture's tree, and after the sweep no worker and no worker's child is alive", async () => {
		const b = box("parcap");
		const hang = (name: string) =>
			`import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("hangs ${name}", async () => {\n\twriteFileSync("../pid-${name}", String(process.pid));\n\tconst c = Bun.spawn(["/bin/sleep", "300"]);\n\twriteFileSync("../child-${name}", String(c.pid));\n\tawait new Promise(() => {});\n}, 600_000);\n`;
		prepared(b, "tr-pc1", { "h1.test.ts": hang("1"), "h2.test.ts": hang("2"), "h3.test.ts": hang("3") }, { fullCapMin: 0.08, soloCapMin: 0.08, fullWorkers: 3 });
		const r = call(b, { sub: "full", runId: "tr-pc1" });
		expect(r.exit).toBe(WRAPPER_EXIT.timeout);
		expect(r.stderr).toContain("timeout: the part passed its cap of 4800 ms");
		const work = workOf(b, "tr-pc1");
		const workers = [...runners(work)];
		const children = readdirSync(work).filter((n) => n.startsWith("child-")).map((n) => Number(readFileSync(join(work, n), "utf8")));
		own(...workers, ...children);
		// Every file had started on its own worker before the cap fired.
		expect(workers).toHaveLength(3);
		expect(children).toHaveLength(3);
		const capture = stuckSections(readFileSync(join(work, "full.stuck.log"), "utf8"));
		expect(treePids(capture["1"]!)).toEqual(expect.arrayContaining([...workers, ...children]));
		for (const w of workers) expect(capture["2"]).toContain(`$ /usr/bin/sample ${w} 3 -mayDie -file `);
		const s = call(b, { sub: "sweep", runId: "tr-pc1" });
		expect(s.stderr).toBe("");
		expect(s.exit).toBe(WRAPPER_EXIT.ok);
		await exited(...workers, ...children);
	}, 90_000);
});

// ---- fast: the Mac fallback of the hosted fast check (PLAN wl-mvq4edbaf13vnk D4, R9) ----------------------------------

describe("fast: only the named ./ test files inside the clone, in one bun test call (PLAN wl-mvq4edbaf13vnk D4, R9)", () => {
	const CAPS = { fullCapMin: 1, soloCapMin: 1, fastCapMin: 1 };
	const FILES = { "a.test.ts": sleeper("a", 10), "dir/b_spec.ts": sleeper("b", 10, false), "c.test.ts": sleeper("c", 10), "dir/d.test.ts": sleeper("d", 10) };
	/** test-exec reached without the wrapper, as a caller that skipped the sh checks would. */
	const direct = (b: Box, args: string[]): Ran => {
		const r = Bun.spawnSync([BUN, SCRIPT, ...args], {
			env: { PATH: SYS_PATH, AS2TEST_EXEC_CONFIG: JSON.stringify(execConfigOf({ root: b.root, bun: BUN, script: SCRIPT, sweepScope: "groups", resourcesPath: join(b.root, "resources.json") })) }, stdout: "pipe", stderr: "pipe",
		});
		return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
	};
	const groupsOf = (work: string): string[] => (existsSync(join(work, "groups")) ? readFileSync(join(work, "groups"), "utf8").split("\n").filter((l) => l !== "") : []);
	const ranFiles = (work: string): string[] => readdirSync(work).filter((n) => n.startsWith("pid-")).sort();

	test("runs exactly the named files in one bun call (one process group, one process when serial): junit to fast.xml, console to fast.log, bun's exit passed through", () => {
		const b = box("fast");
		prepared(b, "tr-fa1", FILES, CAPS);
		const r = raw(b, ["fast", "tr-fa1", "./a.test.ts", "./dir/b_spec.ts", "./dir/d.test.ts"]);
		expect({ exit: r.exit, stderr: r.stderr }).toEqual({ exit: 1, stderr: "" });
		const work = workOf(b, "tr-fa1");
		expect(groupsOf(work)).toHaveLength(1);
		expect(ranFiles(work)).toEqual(["pid-a", "pid-b", "pid-d"]);
		expect(runners(work).size).toBe(1);
		const junit = readFileSync(join(work, "fast.xml"), "utf8");
		const result = partResult({ junit, log: readFileSync(join(work, "fast.log"), "utf8"), exit: r.exit, ms: 0 });
		expect(result).toMatchObject({ pass: 2, fail: 1, skip: 0, exit: 1, error: null });
		expect(result.failures.map((f) => f.name)).toEqual(["dir/b_spec.ts > sleeps b"]);
		expect(junit).not.toContain("sleeps c");
		for (const n of ["full.xml", "full.log", "solo-1.log"]) expect(existsSync(join(work, n))).toBe(false);

		// A second fast call replaces the reports rather than failing on them, and still runs only what it names.
		const again = raw(b, ["fast", "tr-fa1", "./c.test.ts"]);
		expect({ exit: again.exit, stderr: again.stderr }).toEqual({ exit: 0, stderr: "" });
		expect(partResult({ junit: readFileSync(join(work, "fast.xml"), "utf8"), log: readFileSync(join(work, "fast.log"), "utf8"), exit: 0, ms: 0 })).toMatchObject({ pass: 1, fail: 0 });
		expect(groupsOf(work)).toHaveLength(2);
	}, 60_000);

	test("with caps.json fullWorkers 2 the one call spreads its files over workers, still one process group", () => {
		const b = box("fast-par");
		prepared(b, "tr-fw1", { "p1.test.ts": sleeper("1", 300), "p2.test.ts": sleeper("2", 300), "p3.test.ts": sleeper("3", 300) }, { ...CAPS, fullWorkers: 2 });
		const r = raw(b, ["fast", "tr-fw1", "./p1.test.ts", "./p2.test.ts", "./p3.test.ts"]);
		expect({ exit: r.exit, stderr: r.stderr }).toEqual({ exit: 0, stderr: "" });
		const work = workOf(b, "tr-fw1");
		expect(groupsOf(work)).toHaveLength(1);
		expect(runners(work).size).toBeGreaterThan(1);
	}, 60_000);

	test("an operand that is not a ./ Bun test file inside the clone, or one named twice, refuses the whole call before bun starts, at the wrapper and at test-exec", () => {
		const b = box("fast-paths");
		const outside = dir("fast-outside");
		writeFileSync(join(outside, "evil.test.ts"), sleeper("evil", 1));
		prepared(b, "tr-fp1", FILES, CAPS);
		const work = workOf(b, "tr-fp1");
		symlinkSync(join(outside, "evil.test.ts"), join(work, "repo", "link.test.ts"));
		symlinkSync(outside, join(work, "repo", "out"));
		const bad = [
			"--preload=./a.test.ts", "-t", "--", "../x.test.ts", "./../x.test.ts", "./dir/../../x.test.ts", "./dir//d.test.ts", "./dir/./d.test.ts", "/etc/x.test.ts",
			"a.test.ts", "./a.ts", "./dir", "./", "./link.test.ts", "./out/evil.test.ts", "./missing.test.ts",
		];
		for (const op of bad) {
			// The bad operand last, after a good one: one bad operand refuses the call, never a partial run.
			const r = raw(b, ["fast", "tr-fp1", "./a.test.ts", op]);
			expect({ op, exit: r.exit }).toEqual({ op, exit: WRAPPER_EXIT.refused });
			expect(r.stderr).toStartWith("as2test: refused: ");
		}
		// test-exec checks every operand itself when the sh wrapper is skipped.
		for (const op of ["--preload=./a.test.ts", "-t", "../x.test.ts", "./dir//d.test.ts", "./a.ts", "./link.test.ts", "./out/evil.test.ts"]) {
			const r = direct(b, ["fast", "tr-fp1", "./a.test.ts", op]);
			expect({ op, exit: r.exit }).toEqual({ op, exit: WRAPPER_EXIT.refused });
		}
		const twice = raw(b, ["fast", "tr-fp1", "./a.test.ts", "./dir/d.test.ts", "./a.test.ts"]);
		expect(twice.exit).toBe(WRAPPER_EXIT.refused);
		expect(twice.stderr).toContain("./a.test.ts is named more than once");
		expect(direct(b, ["fast", "tr-fp1"]).exit).toBe(WRAPPER_EXIT.refused);
		// Nothing ran: no bun group, no report, no test file's mark.
		expect(groupsOf(work)).toEqual([]);
		expect(ranFiles(work)).toEqual([]);
		for (const n of ["fast.xml", "fast.log"]) expect(existsSync(join(work, n))).toBe(false);
	}, 60_000);

	test("fast is fenced on current, refused before prepare, and refused without caps.json fastCapMin", () => {
		const b = box("fast-fence");
		prepared(b, "tr-ff1", FILES, CAPS);
		setCurrent(b, "tr-other");
		const fenced = raw(b, ["fast", "tr-ff1", "./a.test.ts"]);
		expect(fenced.exit).toBe(WRAPPER_EXIT.fenced);
		expect(fenced.stderr).toContain("fenced");

		setCurrent(b, "tr-ff2");
		expect(raw(b, ["fast", "tr-ff2", "./a.test.ts"]).exit).toBe(WRAPPER_EXIT.refused);
		expect(existsSync(workOf(b, "tr-ff2"))).toBe(false);

		prepared(b, "tr-ff3", FILES, { fullCapMin: 1, soloCapMin: 1 });
		const noCap = raw(b, ["fast", "tr-ff3", "./a.test.ts"]);
		expect(noCap.exit).toBe(WRAPPER_EXIT.refused);
		expect(noCap.stderr).toContain("has no positive fastCapMin");
		expect(groupsOf(workOf(b, "tr-ff3"))).toEqual([]);
	}, 60_000);

	test("at caps.json fastCapMin the call's group is captured to fast.stuck.log, killed, and the part exits timeout naming the cap", async () => {
		const b = box("fast-cap", { captureMs: 2_000 });
		prepared(b, "tr-fc1", { "slow.test.ts": SLOW_TEST, "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fastCapMin: 0.04 });
		const r = raw(b, ["fast", "tr-fc1", "./slow.test.ts"]);
		expect(r.exit).toBe(WRAPPER_EXIT.timeout);
		expect(r.stderr).toContain("timeout: the part passed its cap of 2400 ms; its group was killed");
		const work = workOf(b, "tr-fc1");
		const pid = Number(readFileSync(join(work, "slow.pid"), "utf8"));
		own(pid);
		await exited(pid);
		// The capture ran before the kill (cut at its 2 s deadline here): its file names the stuck process in the group's tree.
		expect(treePids(stuckSections(readFileSync(join(work, "fast.stuck.log"), "utf8"))["1"]!)).toContain(pid);
	}, 60_000);
});

// ---- the stuck capture at the cap (PLAN wl-mvq4edh02r5z40 revision 3, D5) ---------------------------------------

describe("the stuck capture at the cap: bounded, safe reads, never blocks the kill", () => {
	const CAPS = { fullCapMin: 0.04, soloCapMin: 0.04 };
	const TIMEOUT_LINE = "timeout: the part passed its cap of 2400 ms; its group was killed";
	/** A test file that runs `body`, records its pid in ../slow.pid, then hangs past any cap. */
	const hangAfter = (body: string) =>
		`import { test } from "bun:test";\nimport { symlinkSync, unlinkSync, writeFileSync } from "node:fs";\ntest("hangs", async () => {\n\t${body}\n\twriteFileSync("../slow.pid", String(process.pid));\n\tawait new Promise(() => {});\n}, 600_000);\n`;

	test("a capture held on the stuck-capture hook is cut at captureMs: the wrapper exits timeout before the hook is released, within cap + captureMs + grace + slack, leaving no capture child, cap dir or sample report", async () => {
		const b = box("cut", { captureMs: 2_000 });
		prepared(b, "tr-cut1", { "slow.test.ts": SLOW_TEST }, CAPS);
		const hook = join(b.hooks, "tr-cut1.stuck-capture");
		writeFileSync(`${hook}.pause`, "");
		const p = spawnCall(b, { sub: "full", runId: "tr-cut1" });
		try {
			// The wrapper exits while the capture is still held at its hook: the cut ended it.
			const code = await p.exited;
			expect(existsSync(`${hook}.reached`)).toBe(true);
			expect(existsSync(`${hook}.go`)).toBe(false);
			expect(code).toBe(WRAPPER_EXIT.timeout);
			expect(await new Response(p.stderr).text()).toContain(TIMEOUT_LINE);
			const work = workOf(b, "tr-cut1");
			const pid = Number(readFileSync(join(work, "slow.pid"), "utf8"));
			own(pid);
			await exited(pid);
			const text = readFileSync(join(work, "full.stuck.log"), "utf8");
			const cutAt = Number(/^capture cut at (\d+) ms$/m.exec(text)?.[1]);
			expect(cutAt).toBeGreaterThanOrEqual(2_000);
			expect(cutAt).toBeLessThan(3_000);
			// The tree was written before the hold; nothing after the cut was.
			expect(Object.keys(stuckSections(text))).toEqual(["1"]);
			expect(captureLeftovers(work)).toEqual([]);
			const tools = capturePids(text);
			await exited(...tools);
		} finally {
			writeFileSync(`${hook}.go`, "");
		}
	}, 60_000);

	test("a cap dir filled by a same-account process with 20,000 entries never delays the kill: the capture leaves the dir for after the kill, the part's worker is dead before that removal ends, and the wrapper removes it before it exits timeout", async () => {
		const b = box("fill", { captureMs: 2_500 });
		prepared(b, "tr-fill1", { "slow.test.ts": SLOW_TEST }, CAPS);
		const hook = join(b.hooks, "tr-fill1.stuck-capture");
		writeFileSync(`${hook}.pause`, "");
		// Empty directories: cheap to plant and dear to remove recursively (seconds for 20,000). They are planted before the
		// run, so the cap dir is filled by one rename inside the capture window: 20,000 mkdirs there raced the deadline on a
		// loaded host (tr-0mvs6sjezd3t06f).
		const filled = join(dir("fill-planted"), "planted");
		mkdirSync(filled);
		for (let i = 0; i < 20_000; i++) mkdirSync(join(filled, `planted-${i}`));
		const p = spawnCall(b, { sub: "full", runId: "tr-fill1" });
		try {
			await when(b.hooks, () => (existsSync(`${hook}.reached`) ? true : undefined), "the stuck-capture hook", p);
			const work = workOf(b, "tr-fill1");
			const pid = Number(readFileSync(join(work, "slow.pid"), "utf8"));
			own(pid);
			const capDirs = readdirSync(work).filter((n) => n.startsWith("full.stuck-"));
			expect(capDirs).toHaveLength(1);
			const capDir = join(work, capDirs[0]!);
			// The planted dir takes the cap dir's place while the capture is held at its hook (the cap dir is still empty: the
			// 3 s sample writes its report at its end), so the cut meets every entry; the log line below says it did.
			renameSync(filled, capDir);
			expect(readdirSync(capDir)).toHaveLength(20_000);
			// The order is the subject, not a bound: the executor removes the dir only after it killed the group, so when the
			// dir is gone the worker has exited (a zombie or reaped). A removal before the kill, recursive and seconds long,
			// would end with the worker still running its hang.
			const worker = await when(work, () => {
				if (existsSync(capDir)) return undefined;
				const s = snapshot(process.getuid!());
				if (s.kind !== "ok") throw new Error(`the process list at the cap dir's removal is ${s.kind}: ${s.why}`);
				const w = s.procs.find((x) => x.pid === pid);
				return w === undefined ? "gone" : w.zombie ? "zombie" : "running";
			}, "the cap dir's removal", p);
			expect(worker).not.toBe("running");
			expect(await p.exited).toBe(WRAPPER_EXIT.timeout);
			expect(await new Response(p.stderr).text()).toContain(TIMEOUT_LINE);
			const text = readFileSync(join(work, "full.stuck.log"), "utf8");
			expect(text).toMatch(/^capture cut at \d+ ms$/m);
			expect(text).toContain("cap dir not empty: left for after the kill\n");
			expect(text).not.toContain("not removed after the kill");
			expect(existsSync(capDir)).toBe(false);
			expect(captureLeftovers(work)).toEqual([]);
		} finally {
			writeFileSync(`${hook}.go`, "");
		}
	}, 60_000);

	test("a sample report or the part log replaced by a FIFO or a symlink is refused, never followed or blocked on, and the wrapper still exits timeout within the bound", async () => {
		const b = box("swap");
		const secret = join(dir("swap-outside"), "secret.txt");
		writeFileSync(secret, "SECRET-CONTENT\n");
		for (const how of ["fifo", "symlink"] as const) {
			const runId = how === "fifo" ? "tr-sw1" : "tr-sw2";
			const swap = how === "fifo" ? `Bun.spawnSync(["/usr/bin/mkfifo", "../full.log"]);` : `symlinkSync(${JSON.stringify(secret)}, "../full.log");`;
			prepared(b, runId, { "swap.test.ts": hangAfter(`unlinkSync("../full.log");\n\t${swap}`) }, CAPS);
			const hook = join(b.hooks, `${runId}.stuck-sample-read`);
			writeFileSync(`${hook}.pause`, "");
			const p = spawnCall(b, { sub: "full", runId });
			await appeared(`${hook}.reached`, "the stuck-sample-read hook", p);
			const { report } = JSON.parse(readFileSync(`${hook}.reached`, "utf8")) as { report: string };
			rmSync(report, { force: true });
			if (how === "fifo") expect(Bun.spawnSync(["/usr/bin/mkfifo", report]).exitCode).toBe(0);
			else symlinkSync(secret, report);
			writeFileSync(`${hook}.go`, "");
			expect(await p.exited).toBe(WRAPPER_EXIT.timeout);
			expect(await new Response(p.stderr).text()).toContain(TIMEOUT_LINE);
			const work = workOf(b, runId);
			own(Number(readFileSync(join(work, "slow.pid"), "utf8")));
			const text = readFileSync(join(work, "full.stuck.log"), "utf8");
			expect(text).not.toContain("capture cut");
			expect(text).not.toContain("SECRET-CONTENT");
			const s = stuckSections(text);
			const refusal = how === "fifo" ? "is a FIFO, not a regular file" : "open failed: ELOOP";
			expect(s["2"]).toContain(`report refused: ${report}`);
			expect(s["2"]).toContain(refusal);
			expect(s["4"]).toContain(`refused: ${join(work, "full.log")}`);
			expect(s["4"]).toContain(refusal);
			expect(captureLeftovers(work)).toEqual([]);
		}
	}, 120_000);

	test("a full.stuck.log already there (a file or a symlink) skips the capture with one stderr line, writes through neither, and the part still exits timeout naming the cap", () => {
		const b = box("planted");
		const target = join(dir("planted-outside"), "target.txt");
		writeFileSync(target, "untouched\n");
		for (const how of ["file", "symlink"] as const) {
			const runId = how === "file" ? "tr-pl1" : "tr-pl2";
			const plant = how === "file" ? `writeFileSync("../full.stuck.log", "planted\\n");` : `symlinkSync(${JSON.stringify(target)}, "../full.stuck.log");`;
			prepared(b, runId, { "plant.test.ts": hangAfter(plant) }, CAPS);
			const r = call(b, { sub: "full", runId });
			expect(r.exit).toBe(WRAPPER_EXIT.timeout);
			expect(r.stderr).toContain(TIMEOUT_LINE);
			expect(r.stderr).toContain(`stuck capture skipped: cannot create ${join(workOf(b, runId), "full.stuck.log")}`);
			const work = workOf(b, runId);
			own(Number(readFileSync(join(work, "slow.pid"), "utf8")));
			if (how === "file") expect(readFileSync(join(work, "full.stuck.log"), "utf8")).toBe("planted\n");
			else expect(lstatSync(join(work, "full.stuck.log")).isSymbolicLink()).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("untouched\n");
			expect(captureLeftovers(work)).toEqual([]);
		}
	}, 60_000);

	test("a solo part at its cap writes solo-1.stuck.log beside solo-1.log", async () => {
		const b = box("solocap");
		prepared(b, "tr-sc1", { "slow.test.ts": SLOW_TEST }, CAPS);
		const r = call(b, { sub: "solo", runId: "tr-sc1", file: "./slow.test.ts" });
		expect(r.exit).toBe(WRAPPER_EXIT.timeout);
		expect(r.stdout).toStartWith("part solo-1\n");
		expect(r.stderr).toContain(TIMEOUT_LINE);
		const work = workOf(b, "tr-sc1");
		const pid = Number(readFileSync(join(work, "slow.pid"), "utf8"));
		own(pid);
		const text = readFileSync(join(work, "solo-1.stuck.log"), "utf8");
		expect(Object.keys(stuckSections(text))).toEqual(["1", "2", "3", "4"]);
		expect(treePids(stuckSections(text)["1"]!)).toContain(pid);
		expect(text).toContain(`== 4. last 200 lines of ${join(work, "solo-1.log")} (`);
		expect(existsSync(join(work, "full.stuck.log"))).toBe(false);
		expect(captureLeftovers(work)).toEqual([]);
		await exited(pid);
	}, 60_000);
});

// ---- the stuck-worker detector in the executor (PLAN wl-mvq8x4pkjmx69s D3) ---------------------------------------

/** The test knobs the plan names for these fixtures (sl-sd-exec): 250 ms ticks, a 2 s persistence, the trace on. */
const DETECT = { detectTickMs: 250, detectPersistMs: 2_000, detectTrace: true } as const;

type TraceMarker = { pid: number; since: number; command: string };
/** One `<part>.stuck-trace.jsonl` row: what one tick observed. */
interface TraceRow {
	at: number;
	snap: string;
	markers: TraceMarker[] | { denied: string };
	candidates: { pid: number; cpuNs: number | null }[];
	tree: { pid: number; ppid: number; pgid: number; comm: string }[];
	zombies: { pid: number; ppid: number; startUs: number; comm: string }[];
	signatures: { worker: number; zombie: number; since: number; command: string }[];
}
const traceOf = (work: string, stem = "full"): TraceRow[] =>
	readFileSync(join(work, `${stem}.stuck-trace.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceRow);
/** The markers a tick saw active (a denied marker dir counts as none). */
const activeAt = (row: TraceRow): TraceMarker[] => (Array.isArray(row.markers) ? row.markers : []);

/** The detector's stdout lines (CONTRACT.md), each split into keyword, ISO time, part and the rest. */
function detectorLines(stdout: string): { keyword: string; iso: string; part: string; rest: string; line: string }[] {
	return [...stdout.matchAll(/^(stuck-[a-z-]+) (\S+) part (\S+) (.*)$/gm)].map((m) => ({ keyword: m[1]!, iso: m[2]!, part: m[3]!, rest: m[4]!, line: m[0] }));
}
const keywordsOf = (stdout: string): string[] => detectorLines(stdout).map((l) => l.keyword);
type DetectorLine = ReturnType<typeof detectorLines>[number];
/**
 * An enforce stop's stdout: the last four lines are stuck-signature, stuck-stop, stuck-captured and stuck-killed for this worker
 * and zombie. Before them only flaps of the same signature may come (a stuck-signature then a `stuck-cleared … matched no`, a
 * tick on which the spinning worker fell under the hot share on a loaded machine); every line is the contract's shape.
 */
function enforceLines(stdout: string, worker: number, zombie: number): { first: DetectorLine; sig: DetectorLine; stop: DetectorLine; captured: DetectorLine; killed: DetectorLine } {
	const lines = detectorLines(stdout);
	expect(lines.length).toBeGreaterThanOrEqual(4);
	for (const l of lines) {
		expect(new Date(l.iso).toISOString()).toBe(l.iso);
		expect(l.part).toBe("full");
	}
	const flaps = lines.slice(0, -4);
	expect(flaps.length % 2).toBe(0);
	for (let i = 0; i < flaps.length; i += 2) {
		expect(flaps[i]!.keyword).toBe("stuck-signature");
		expect(flaps[i]!.rest).toStartWith(`worker ${worker} zombie ${zombie} since `);
		expect(flaps[i + 1]!.rest).toMatch(new RegExp(`^worker ${worker} zombie ${zombie} held \\d+ matched no$`));
		expect(flaps[i + 1]!.keyword).toBe("stuck-cleared");
	}
	const [sig, stop, captured, killed] = lines.slice(-4) as [DetectorLine, DetectorLine, DetectorLine, DetectorLine];
	expect([sig.keyword, stop.keyword, captured.keyword, killed.keyword]).toEqual(["stuck-signature", "stuck-stop", "stuck-captured", "stuck-killed"]);
	expect(sig.rest).toStartWith(`worker ${worker} zombie ${zombie} since `);
	expect(stop.rest).toBe(`worker ${worker} zombie ${zombie}`);
	return { first: lines[0]!, sig, stop, captured, killed };
}
/** `<part>.signature.log` split at its `== <n>. … ==` headings, as the stuck capture's. */
const signatureSections = stuckSections;

/**
 * When AS2TEST_STUCK_REPORT names a file, a fixture's measured figures are appended there as one JSON line (the lane's
 * acceptance report reads them); unset, nothing is written.
 */
function report(row: Record<string, unknown>): void {
	const to = process.env.AS2TEST_STUCK_REPORT;
	if (to) writeFileSync(to, `${JSON.stringify(row)}\n`, { flag: "a" });
}

/**
 * The lines a positive spin fixture's test file starts with: flock from libSystem, as the preload binds it, and `publish`,
 * which puts `<work>/<dir>/pid` in place whole, by a rename from a temporary file outside `<dir>`: the test made `<dir>` empty,
 * so that rename is the only event there (`when`).
 */
const SPIN_HEAD = `import { test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "node:child_process";
import { closeSync, constants, ftruncateSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
const flock = dlopen("/usr/lib/libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
/** Hold this process's marker exactly as the preload does: O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, LOCK_EX|LOCK_NB, then the D1 content. */
function holdMarker(command) {
	const fd = openSync(process.env.AS2TEST_STUCK_MARKERS + "/" + process.pid, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | 0x1000000, 0o600);
	if (flock(fd, 2 | 4) !== 0) throw new Error("the marker's flock was not granted");
	ftruncateSync(fd, 0);
	const since = Date.now();
	writeSync(fd, since + "\\t" + command + "\\n", 0);
	return fd;
}
function publish(dir, body) {
	writeFileSync("../" + dir + ".tmp", body);
	renameSync("../" + dir + ".tmp", "../" + dir + "/pid");
}
`;
/**
 * A detached helper (its own process group) the spinning worker starts first: once the signature capture's file exists it
 * starts a second detached group (`sleep 300`) and publishes its pid as ../ready-late/pid, then stays alive as its parent.
 * It polls in its own process: the work dir it would watch is busy, so a watched event there can be dropped (`when`).
 */
const LATE_HELPER = `const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync("../helper.pid", String(process.pid));
const t = setInterval(() => {
	if (!fs.existsSync("../full.signature.log")) return;
	clearInterval(t);
	const s = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
	fs.writeFileSync("../ready-late.tmp", String(s.pid));
	fs.renameSync("../ready-late.tmp", "../ready-late/pid");
}, 25);
`;
/**
 * The positive fixture (PLAN sl-sd-exec): the observable lost-reap state built by hand. The test holds its own marker for
 * `true`, spawns /usr/bin/true asynchronously at once, publishes ../ready-spin/pid (`Ready`: worker, zombie and its own
 * clock's ready time), then spins forever: marker active, the worker hot, the child an unreaped zombie. With `late`, a
 * detached helper group is started first (LATE_HELPER).
 */
const spinTest = (late: boolean) => `${SPIN_HEAD}test("spins", () => {
${late ? `\tspawn(process.execPath, ["-e", ${JSON.stringify(LATE_HELPER)}], { detached: true, stdio: "ignore" });\n` : ""}	holdMarker("true");
	const z = ${unreapedTrue()};
	publish("ready-spin", JSON.stringify({ worker: process.pid, zombie: z.pid, at: Date.now() }));
	for (;;) {}
}, 600_000);
`;

/** What the waits read of a wrapper call running in the background (`spawnCall`). */
interface Wrapper {
	pid: number;
	exitCode: number | null;
	exited: Promise<number>;
	stderr: ReadableStream<Uint8Array>;
}

/** The spin fixture's ready-to-spin publication: its marker is held and its /usr/bin/true spawned; `at` is its own clock's time. */
interface Ready {
	worker: number;
	zombie: number;
	at: number;
}

/**
 * `probe()`'s first defined answer, read before the first wait and again after every event in `dir`. `dir` must be one where
 * the awaited publication is the only event: Bun 1.3.14's fs.watch drops an event that repeats the type or the name of the
 * last one it emitted within about a millisecond. `p` exiting first is an error naming its exit and stderr. No timer: the
 * test's own timeout is the hang guard.
 */
async function when<T>(dir: string, probe: () => T | undefined, what: string, p?: Wrapper): Promise<T> {
	let events = 0;
	let failure = null as Error | null;
	let wake = Promise.withResolvers<void>();
	const w = watch(dir, () => {
		events++;
		wake.resolve();
	});
	w.on("error", (e: Error) => {
		failure = new Error(`${what}: watching ${dir}: ${e.message}`);
		wake.resolve();
	});
	try {
		for (;;) {
			const seen = events;
			const v = probe();
			if (v !== undefined) return v;
			if (failure) throw failure;
			if (events !== seen) continue;
			wake = Promise.withResolvers<void>();
			const exited = await Promise.race([wake.promise.then(() => false), p ? p.exited.then(() => true) : new Promise<boolean>(() => {})]);
			if (exited) {
				const last = probe();
				if (last !== undefined) return last;
				throw new Error(`${what}: the wrapper (pid ${p!.pid}) exited ${p!.exitCode} first; stderr: ${await new Response(p!.stderr).text()}`);
			}
		}
	} finally {
		w.close();
	}
}

/** Resolves once `pid` has exited (a zombie has; a gone pid at once): `caffeinate -w`, the kernel's exit event, no polling. */
async function exitOf(pid: number): Promise<void> {
	const c = Bun.spawn(["/usr/bin/caffeinate", "-w", String(pid)], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	const code = await c.exited;
	if (code !== 0) throw new Error(`/usr/bin/caffeinate -w ${pid} exited ${code}: ${await new Response(c.stderr).text()}`);
}

/** Make the empty directories `<work>/<name>` a fixture publishes into (`publish`), before the part starts. */
const readyDirs = (work: string, ...names: string[]) => {
	for (const n of names) mkdirSync(join(work, n));
};

/** `<work>/<name>/pid` once published (`when`), or undefined. */
function published(work: string, name: string): string | undefined {
	const path = join(work, name, "pid");
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The spin fixture's `Ready` (the case owns its worker); the wrapper exiting first is an error. */
async function readySpin(work: string, p: Wrapper): Promise<Ready> {
	const r = JSON.parse(await when(join(work, "ready-spin"), () => published(work, "ready-spin"), "the spin fixture's ready-spin", p)) as Ready;
	own(r.worker);
	return r;
}

type Pair = { worker: number; zombie: number };
/** A `detectFeed` tick's answer (test-exec `StuckWatch.feed`). */
interface Ack {
	n: number;
	at?: number;
	signatures?: Pair[];
	started?: Pair[];
	matched?: Pair[];
	cleared?: (Pair & { matched: boolean })[];
	ended?: true;
	error?: string;
}

/**
 * The feed driver of a `detectFeed` part: each call is the next tick n. It makes `<hooks>/<run>.<part>.detect-ack.<n>`, publishes
 * `.detect-feed.<n>` whole (`{ at, cpu }`), and returns the detector's ack; the wrapper exiting first is an error.
 */
function feeder(b: Box, runId: string, p: Wrapper, stem = "full"): (at: number, cpu: Record<number, number>) => Promise<Ack> {
	const base = join(b.hooks, `${runId}.${stem}`);
	let n = 0;
	return async (at, cpu) => {
		n++;
		const ackDir = `${base}.detect-ack.${n}`;
		mkdirSync(ackDir);
		writeFileSync(`${base}.detect-feed.${n}.tmp`, JSON.stringify({ at, cpu }));
		renameSync(`${base}.detect-feed.${n}.tmp`, `${base}.detect-feed.${n}`);
		const ack = join(ackDir, "ack");
		return JSON.parse(await when(ackDir, () => (existsSync(ack) ? readFileSync(ack, "utf8") : undefined), `ack ${n} of ${base}`, p)) as Ack;
	};
}

/**
 * Fed ticks at STUCK_DEFAULTS for a ready spin fixture whose /usr/bin/true has exited (a zombie): tick k at (k - 1) × tickMs,
 * the worker's CPU exactly the elapsed time (hot from tick 2), every other candidate unsampled. The signature starts on tick
 * 2 and matches persistMs later, on tick 2 + persistMs / tickMs; nothing else starts, matches or clears.
 */
async function feedToMatch(tick: (at: number, cpu: Record<number, number>) => Promise<Ack>, r: Ready): Promise<Ack[]> {
	const { tickMs, persistMs } = STUCK_DEFAULTS;
	const last = 2 + persistMs / tickMs;
	const acks: Ack[] = [];
	for (let k = 1; k <= last; k++) acks.push(await tick((k - 1) * tickMs, { [r.worker]: (k - 1) * tickMs * 1e6 }));
	const pair = { worker: r.worker, zombie: r.zombie };
	const shape = (a: Ack) => ({ n: a.n, ended: a.ended, error: a.error, started: a.started, matched: a.matched, cleared: a.cleared });
	expect(acks.map(shape)).toEqual(acks.map((_, i) => ({ n: i + 1, ended: undefined, error: undefined, started: i === 1 ? [pair] : [], matched: i === last - 1 ? [pair] : [], cleared: [] })));
	return acks;
}

/** The test knobs of a fed detector: STUCK_DEFAULTS tick and persistence on fed time, the trace on. */
const FED = { detectFeed: true, detectTrace: true } as const;

/** The pid a fixture wrote to `<work>/<name>`, owned by the case. */
function fixturePid(work: string, name: string): number {
	const pid = Number(readFileSync(join(work, name), "utf8"));
	own(pid);
	return pid;
}

/**
 * A fed-tick fixture's gates: `gate(g)` opens `<work>/<g>.go` (a FIFO the test made, `makeGates`) read-write, so the open never
 * waits for a writer, publishes `<work>/<g>/pid` whole by a rename from outside `<g>`, then blocks reading the FIFO until the
 * test's line (`pass`). SLEEP is `<work>/bin/sleep`, a call's child named sleep that does the same for the gate its argument
 * names. A tick fed at a gate sees the fixture exactly there: no clock decides what a tick observes.
 */
const GATE_HEAD = `const __fs = require("node:fs");
const W = require("node:path").resolve("..");
const SLEEP = W + "/bin/sleep";
/** Publish <W>/<g>/pid whole (this process's pid), without waiting. */
function announce(g) {
	__fs.writeFileSync(W + "/" + g + ".tmp", String(process.pid));
	__fs.renameSync(W + "/" + g + ".tmp", W + "/" + g + "/pid");
}
function gate(g) {
	const fd = __fs.openSync(W + "/" + g + ".go", "r+");
	try {
		announce(g);
		if (__fs.readSync(fd, Buffer.alloc(1)) !== 1) throw new Error("gate " + g + ": its FIFO gave no line");
	} finally {
		__fs.closeSync(fd);
	}
}
/** gate(), with the event loop free while it waits. */
async function gateAsync(g) {
	const fh = await __fs.promises.open(W + "/" + g + ".go", "r+");
	try {
		announce(g);
		if ((await fh.read(Buffer.alloc(1), 0, 1)).bytesRead !== 1) throw new Error("gate " + g + ": its FIFO gave no line");
	} finally {
		await fh.close();
	}
}
`;

/** Make the gates `names` in `work` (each an empty publication dir and a FIFO) and `<work>/bin/sleep`, GATE_HEAD's SLEEP. */
function makeGates(work: string, names: string[]): void {
	readyDirs(work, ...names);
	const r = Bun.spawnSync(["/usr/bin/mkfifo", ...names.map((g) => join(work, `${g}.go`))], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`/usr/bin/mkfifo in ${work} exited ${r.exitCode}: ${r.stderr.toString()}`);
	mkdirSync(join(work, "bin"));
	const at = (suffix: string) => `'${work}/'"$1"'${suffix}'`;
	writeFileSync(join(work, "bin", "sleep"), [
		"#!/bin/sh",
		"# GATE_HEAD's gate() for the gate named by $1: open its FIFO read-write, publish $$ whole, block until the test's line.",
		`exec 3<>${at(".go")} || exit 3`,
		`printf '%s' "$$" > ${at(".tmp")} && /bin/mv ${at(".tmp")} ${at("/pid")} || exit 3`,
		"IFS= read -r _ <&3 || exit 3",
		"exit 0",
		"",
	].join("\n"), { mode: 0o755 });
}

/** Await gate `g`'s publication (`announce`); returns the pid it published. */
async function reached(work: string, g: string, p: Wrapper): Promise<number> {
	return Number(await when(join(work, g), () => published(work, g), `the gate ${g}`, p));
}

/** Let the fixture through gate `g`: one line on its FIFO, written non-blocking (the fixture holds it open, so a missing reader is an error, never a wait). */
function letThrough(work: string, g: string): void {
	const fd = openSync(join(work, `${g}.go`), constants.O_WRONLY | constants.O_NONBLOCK);
	try {
		writeSync(fd, "\n");
	} finally {
		closeSync(fd);
	}
}

/** Await gate `g`, feed the tick there (`tick`), then let the fixture through; returns that tick's ack. */
async function pass(work: string, g: string, p: Wrapper, tick: () => Promise<Ack>): Promise<Ack> {
	await reached(work, g, p);
	const ack = await tick();
	letThrough(work, g);
	return ack;
}

/**
 * Every Bun.spawnSync and node sync child_process call shape the qualification compares: run once inside the wrapped fixture
 * and once here (no preload), the two results must be equal. Its source is copied into the fixture, so it names no import.
 * The accessor, proxy and nested shapes count how often test-owned code runs: the wrapper must run none of it itself.
 */
function callFields(cp: typeof childProcess) {
	const bunFields = (r: ReturnType<typeof Bun.spawnSync>) => ({
		exitCode: r.exitCode, success: r.success, signalCode: r.signalCode ?? null, stdout: r.stdout?.toString() ?? null, stderr: r.stderr?.toString() ?? null,
	});
	const errorFields = (e: unknown) => {
		const x = e as NodeJS.ErrnoException & { status?: number };
		return { threw: true, name: x?.name ?? null, code: x?.code ?? null, errno: x?.errno ?? null, syscall: x?.syscall ?? null, path: x?.path ?? null, status: x?.status ?? null, message: String(x?.message) };
	};
	const thrown = (f: () => unknown) => {
		try {
			f();
			return { threw: false };
		} catch (e) {
			return errorFields(e);
		}
	};
	const node = (r: ReturnType<typeof cp.spawnSync>) => ({ status: r.status, signal: r.signal, stdout: r.stdout?.toString() ?? null, stderr: r.stderr?.toString() ?? null, error: (r.error as NodeJS.ErrnoException | undefined)?.code ?? null });
	// f's result or error, and how many times test-owned code (each hit()) ran during it.
	const counted = (f: (hit: () => void) => unknown) => {
		let hits = 0;
		const hit = () => {
			hits++;
		};
		try {
			return { out: f(hit), hits };
		} catch (e) {
			return { out: errorFields(e), hits };
		}
	};
	const withGetter = (base: string[], i: number, get: () => unknown) => {
		const a = [...base];
		Object.defineProperty(a, i, { get, enumerable: true, configurable: true });
		return a;
	};
	// A getter that throws on its first read only: a wrapper that read and swallowed it would change what the call does.
	const once = (hit: () => void, value: unknown) => {
		let first = true;
		return () => {
			hit();
			if (first) {
				first = false;
				throw new Error("as2test one-shot getter");
			}
			return value;
		};
	};
	const counting = <T extends object>(target: T, hit: () => void) =>
		new Proxy(target, {
			get: (t, k, r) => (hit(), Reflect.get(t, k, r)),
			has: (t, k) => (hit(), Reflect.has(t, k)),
			ownKeys: (t) => (hit(), Reflect.ownKeys(t)),
			getOwnPropertyDescriptor: (t, k) => (hit(), Reflect.getOwnPropertyDescriptor(t, k)),
			getPrototypeOf: (t) => (hit(), Reflect.getPrototypeOf(t)),
		});
	return {
		echo: bunFields(Bun.spawnSync(["/bin/echo", "hi"])),
		exit3: bunFields(Bun.spawnSync(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"])),
		object: bunFields(Bun.spawnSync({ cmd: ["/bin/echo", "obj"] })),
		nodeSpawnSync: node(cp.spawnSync("/bin/sh", ["-c", "echo a; echo b >&2; exit 2"])),
		execSync: cp.execSync("echo x").toString(),
		execFileSync: cp.execFileSync("/bin/echo", ["y"]).toString(),
		execSyncFails: thrown(() => cp.execSync("exit 4", { stdio: "pipe" })),
		missingBun: thrown(() => Bun.spawnSync(["/nonexistent/as2test-missing-binary"])),
		missingNodeSpawnSync: node(cp.spawnSync("/nonexistent/as2test-missing-binary")),
		missingExecFileSync: thrown(() => cp.execFileSync("/nonexistent/as2test-missing-binary")),
		argv0Getter: counted((hit) => bunFields(Bun.spawnSync(withGetter(["/bin/echo", "a0"], 0, () => (hit(), "/bin/echo"))))),
		cmdGetter: counted((hit) => bunFields(Bun.spawnSync({ get cmd() {
			hit();
			return ["/bin/echo", "cmd"];
		} }))),
		argv0Throws: counted((hit) => bunFields(Bun.spawnSync(withGetter(["/bin/echo", "t0"], 0, once(hit, "/bin/echo"))))),
		cmdThrows: counted((hit) => {
			const o = {};
			Object.defineProperty(o, "cmd", { get: once(hit, ["/bin/echo", "tc"]), enumerable: true });
			return bunFields(Bun.spawnSync(o as { cmd: string[] }));
		}),
		argv0NotString: counted((hit) => bunFields(Bun.spawnSync([{ toString: () => (hit(), "/bin/echo") } as unknown as string, "ns"]))),
		proxyArgv: counted((hit) => bunFields(Bun.spawnSync(counting(["/bin/echo", "pa"], hit)))),
		proxyOptions: counted((hit) => bunFields(Bun.spawnSync(counting({ cmd: ["/bin/echo", "po"] }, hit)))),
		nestedBun: counted((hit) =>
			bunFields(Bun.spawnSync(withGetter(["/bin/echo", "outer"], 0, () => (hit(), Bun.spawnSync(["/bin/echo", "/bin/echo"]).stdout.toString().trim())))),
		),
		nestedNode: counted((hit) => cp.execFileSync("/bin/echo", withGetter(["n0", "n1"], 1, () => (hit(), Bun.spawnSync(["/bin/echo", "deep"]).stdout.toString().trim()))).toString()),
		// Test code the original itself runs: a later argv element, an option and an env value as getters, a holey argv
		// (its hole is read through Array.prototype), and a function option.
		laterArgvGetter: counted((hit) => bunFields(Bun.spawnSync(withGetter(["/bin/echo", "l0", "l1"], 2, () => (hit(), "l2"))))),
		cwdGetter: counted((hit) => bunFields(Bun.spawnSync(["/bin/pwd"], { get cwd() {
			hit();
			return "/";
		} }))),
		envGetter: counted((hit) => bunFields(Bun.spawnSync(["/usr/bin/env"], { env: { get AS2TEST_E() {
			hit();
			return "e";
		} } }))),
		holeyArgv: counted(() => {
			const a = ["/bin/echo", "h0"];
			a.length = 3;
			return bunFields(Bun.spawnSync(a));
		}),
		functionOption: counted((hit) => bunFields(Bun.spawnSync(["/bin/echo", "f"], { onExit: () => hit() }))),
		// Review r3: an accessor on Object.prototype under a {} options object, and an env array with an enumerable named getter
		// (bun enumerates an env object's own keys and gets each value, so this one runs).
		protoCwdGetter: counted((hit) => {
			Object.defineProperty(Object.prototype, "cwd", { configurable: true, get: () => (hit(), "/") });
			try {
				return bunFields(Bun.spawnSync(["/usr/bin/true"], {}));
			} finally {
				delete (Object.prototype as Record<string, unknown>).cwd;
			}
		}),
		envArrayGetter: counted((hit) => {
			const env: string[] = [];
			Object.defineProperty(env, "AS2TEST_E", { enumerable: true, get: () => (hit(), "e") });
			return bunFields(Bun.spawnSync(["/usr/bin/env"], { env: env as unknown as Record<string, string> }));
		}),
		plainOptions: bunFields(Bun.spawnSync(["/bin/cat"], { cwd: "/", env: { PATH: "/bin" }, stdin: Buffer.from("in"), stdout: "pipe", stderr: "pipe" })),
	};
}

/**
 * Review r3's two getter shapes outside the options' own data, each running onGet inside its getter: "proto-cwd" defines a `cwd`
 * accessor on Object.prototype (removed before this returns) and calls Bun.spawnSync(argv, {}); "env-array" passes an env that is
 * an array with an enumerable named getter. Returns the call's exit and how often the getter ran. Its source is copied into
 * fixtures, so it names no import.
 */
function r3GetterCall(shape: "proto-cwd" | "env-array", argv: string[], onGet: () => void) {
	let hits = 0;
	const get = () => {
		hits++;
		onGet();
		return shape === "proto-cwd" ? "/" : "e";
	};
	if (shape === "env-array") {
		const env: string[] = [];
		Object.defineProperty(env, "AS2TEST_E", { enumerable: true, get });
		const r = Bun.spawnSync(argv, { env: env as unknown as Record<string, string> });
		return { exitCode: r.exitCode, hits };
	}
	Object.defineProperty(Object.prototype, "cwd", { configurable: true, get });
	try {
		const r = Bun.spawnSync(argv, {});
		return { exitCode: r.exitCode, hits };
	} finally {
		delete (Object.prototype as Record<string, unknown>).cwd;
	}
}

/**
 * Review r4's byte containers: a Buffer whose Symbol.asyncIterator getter runs onGet and returns undefined, which bun 1.3.14's
 * stdio extract looks up (ReadableStream.fromJS) before it takes the bytes. "own" defines the getter on the Buffer itself and
 * passes it as Bun.spawnSync's stdin; "inherited" defines it on a Buffer subclass's prototype and passes an instance as stdin;
 * "node-input" passes an "own" Buffer as cp.execFileSync's input (node puts it in the stdio array). Returns the call's exit and
 * how often the getter ran. Its source is copied into fixtures, so it names no import.
 */
function byteGetterCall(cp: typeof childProcess, shape: "own" | "inherited" | "node-input", argv: string[], onGet: () => void) {
	let hits = 0;
	const hook = { configurable: true, get: () => {
		hits++;
		onGet();
		return undefined;
	} };
	let bytes: Uint8Array = Buffer.from("x");
	if (shape === "inherited") {
		class SubBuffer extends Uint8Array {}
		Object.setPrototypeOf(SubBuffer.prototype, Buffer.prototype);
		Object.defineProperty(SubBuffer.prototype, Symbol.asyncIterator, hook);
		bytes = new SubBuffer([120]);
	} else Object.defineProperty(bytes, Symbol.asyncIterator, hook);
	if (shape === "node-input") {
		cp.execFileSync(argv[0]!, argv.slice(1), { input: bytes });
		return { exitCode: 0, hits };
	}
	return { exitCode: Bun.spawnSync(argv, { stdin: bytes }).exitCode, hits };
}

/**
 * The real preload's qualification fixture (PLAN sl-sd-exec), on gates (GATE_HEAD): each phase's call blocks at its gates
 * (`in-<phase>` in the call's child, `get-<phase>` in a getter test code runs for it), then the phase logs its window to
 * ../qual.jsonl and stops at `after-<phase>`, so a fed tick sees the marker during the call and its absence after. A phase
 * whose command is "" must run with no marker of this worker active at all: the call's arguments ran test code, so it is
 * unpublished. QUAL_PHASES lists the gates in the order this file reaches them.
 */
const QUAL_TEST = `import { test } from "bun:test";
import * as cp from "node:child_process";
import { appendFileSync } from "node:fs";
${GATE_HEAD}
const callFields = ${callFields.toString()};
const r3GetterCall = ${r3GetterCall.toString()};
const byteGetterCall = ${byteGetterCall.toString()};
const log = (o) => appendFileSync("../qual.jsonl", JSON.stringify(o) + "\\n");
async function phase(name, command, f) {
	const start = Date.now();
	const out = f();
	const end = Date.now();
	log({ name, command, start, end, out });
	gate("after-" + name);
}
test("qualifies", async () => {
	const marker = process.env.AS2TEST_STUCK_MARKERS + "/" + process.pid;
	log({ name: "start", pid: process.pid, preloadGlobal: globalThis.__fixturePreload ?? null, wrapped: Bun.spawnSync[Symbol.for("as2test.stuck-marker")] === true });
	gate("start");
	await phase("bun", "sleep", () => Bun.spawnSync([SLEEP, "in-bun"]).exitCode);
	// Plain data in every option (helpers.ts's sh shape, a spread of process.env): published. process.env itself is not plain
	// data in bun (TZ and the proxy variables are accessors), so a call given it runs unpublished.
	await phase("bun-options-no-bytes", "sleep", () => Bun.spawnSync([SLEEP, "in-bun-options-no-bytes"], { cwd: "/", env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }).exitCode);
	// Review r4: bytes in any option (here a Buffer stdin) run unpublished, since bun looks up a byte container's
	// Symbol.asyncIterator, own or inherited, before it takes the bytes.
	await phase("bun-options", "", () => Bun.spawnSync([SLEEP, "in-bun-options"], { cwd: "/", env: { ...process.env }, stdin: Buffer.from("x"), stdout: "pipe", stderr: "pipe" }).exitCode);
	await phase("node-spawnSync", "sleep", () => cp.spawnSync(SLEEP, ["in-node-spawnSync"]).status);
	await phase("node-execSync", "sh", () => cp.execSync('"' + SLEEP + '" in-node-execSync; echo slept').toString());
	await phase("node-execFileSync", "sleep", () => cp.execFileSync(SLEEP, ["in-node-execFileSync"]).toString());
	// node's own options object with cwd, env, timeout and no input: published.
	await phase("node-options-no-input", "sleep", () => cp.spawnSync(SLEEP, ["in-node-options-no-input"], { cwd: "/", env: { PATH: "/bin" }, timeout: 30_000, encoding: "utf8" }).status);
	// The same with input (node puts a Buffer in its stdio array): unpublished (review r4).
	await phase("node-options", "", () => cp.spawnSync(SLEEP, ["in-node-options"], { cwd: "/", env: { PATH: "/bin" }, input: "x", timeout: 30_000, encoding: "utf8" }).status);
	// Review r4: a Symbol.asyncIterator getter on a Buffer stdin (own, then inherited from a subclass prototype) and on node's
	// execFileSync input, which bun runs before it takes the bytes, then the call itself: all unpublished.
	for (const shape of ["own", "inherited", "node-input"]) {
		const name = "byte-" + shape + "-getter";
		await phase(name, "", () => byteGetterCall(cp, shape, [SLEEP, "in-" + name], () => gate("get-" + name)));
	}
	// Test code the original runs while it reads its arguments: the getter, then the call itself, all unpublished.
	await phase("argv-getter", "", () => {
		const argv = [SLEEP];
		Object.defineProperty(argv, 1, { enumerable: true, get() {
			gate("get-argv-getter");
			return "in-argv-getter";
		} });
		return Bun.spawnSync(argv).exitCode;
	});
	await phase("cwd-getter", "", () => Bun.spawnSync([SLEEP, "in-cwd-getter"], { get cwd() {
		gate("get-cwd-getter");
		return "/";
	} }).exitCode);
	await phase("env-getter", "", () => Bun.spawnSync([SLEEP, "in-env-getter"], { env: { get PATH() {
		gate("get-env-getter");
		return "/bin";
	} } }).exitCode);
	// Review r3: an env array with an enumerable named getter (bun runs it), and an Object.prototype accessor beside a {} options
	// object (bun 1.3.14 stops its option lookups before Object.prototype, so this getter does not run: the call is unpublished
	// because Object.prototype is not clean): both unpublished throughout.
	await phase("env-array-getter", "", () => r3GetterCall("env-array", [SLEEP, "in-env-array-getter"], () => gate("get-env-array-getter")));
	await phase("proto-cwd-getter", "", () => r3GetterCall("proto-cwd", [SLEEP, "in-proto-cwd-getter"], () => gate("get-proto-cwd-getter")));
	await phase("fields", null, () => callFields(cp));
	// A nested call from inside the call's own argv accessor (read by spawnSync itself): neither the outer head nor the nested
	// sh publishes, so both read the same, earlier marker line.
	await phase("nested-accessor", "", () => {
		let inner = null;
		const argv = ["/usr/bin/head", "-c", "200"];
		Object.defineProperty(argv, 3, { enumerable: true, get() {
			inner = Bun.spawnSync(["/bin/sh", "-c", 'cat "$0"; exec "$1" in-nested-accessor', marker, SLEEP]);
			return marker;
		} });
		const r = Bun.spawnSync(argv);
		return { outer: r.stdout.toString(), outerExit: r.exitCode, inner: inner.stdout.toString(), innerExit: inner.exitCode };
	});
	// The node path reads its args before it reaches Bun.spawnSync, so a call from that accessor is the outermost one then.
	await phase("nested-node", null, () => {
		let inner = null;
		const args = ["-c", "200"];
		Object.defineProperty(args, 2, { enumerable: true, get() {
			inner = Bun.spawnSync(["/bin/cat", marker]).stdout.toString();
			return marker;
		} });
		return { outer: cp.execFileSync("/usr/bin/head", args).toString(), inner };
	});
	const uchg = Bun.spawnSync(["/usr/bin/chflags", "uchg", marker]).exitCode;
	try {
		await phase("immutable", "", () => ({ uchg, sleep: Bun.spawnSync([SLEEP, "in-immutable-bun"]).exitCode, node: cp.spawnSync(SLEEP, ["in-immutable-node"]).status, fields: callFields(cp) }));
	} finally {
		log({ name: "nouchg", out: Bun.spawnSync(["/usr/bin/chflags", "nouchg", marker]).exitCode });
	}
	// A sleep the call backgrounds outlives it (../inherit.pid: the test owns and kills it) and must hold no marker fd.
	const start = Date.now();
	const child = Number(Bun.spawnSync(["/bin/sh", "-c", "/bin/sleep 300 >/dev/null 2>&1 & echo $!"]).stdout.toString().trim());
	const end = Date.now();
	appendFileSync("../inherit.pid", String(child));
	gate("after-inherit");
	// lsof is itself a published call of this worker, made after the after-inherit gate's tick.
	const lsof = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-p", String(child)]);
	let alive = true;
	try {
		process.kill(child, 0);
	} catch {
		alive = false;
	}
	log({ name: "inherit", command: null, start, end, out: { child, alive, lsofExit: lsof.exitCode, holdsMarker: lsof.stdout.toString().includes(marker), lsofHasSleep: lsof.stdout.toString().includes("sleep") } });
}, 240_000);
`;

/** QUAL_TEST's phases in order, each with the gates its call passes before its `after-<phase>` gate. */
const QUAL_PHASES: [string, string[]][] = [
	...["bun", "bun-options-no-bytes", "bun-options", "node-spawnSync", "node-execSync", "node-execFileSync", "node-options-no-input", "node-options"].map((n): [string, string[]] => [n, [`in-${n}`]]),
	...["byte-own-getter", "byte-inherited-getter", "byte-node-input-getter", "argv-getter", "cwd-getter", "env-getter", "env-array-getter", "proto-cwd-getter"].map((n): [string, string[]] => [n, [`get-${n}`, `in-${n}`]]),
	["fields", []],
	["nested-accessor", ["in-nested-accessor"]],
	["nested-node", []],
	["immutable", ["in-immutable-bun", "in-immutable-node"]],
	["inherit", []],
];

describe("the stuck-worker detector in the executor (PLAN wl-mvq8x4pkjmx69s D3)", () => {
	test("the real preload: a bunfig preload still runs beside it; Bun.spawnSync and node's spawnSync, execSync and execFileSync publish a marker during the call and none after, plain-data options included, return and throw what they would unwrapped, run test-owned accessors and proxy traps exactly as often as unwrapped (a throwing one included), run a call whose argv or options hold a getter (an env array's included) or that meets an Object.prototype accessor unpublished (during the getter and the call), run a call carrying bytes (a Buffer stdin, node's input) unpublished, an own or inherited Symbol.asyncIterator getter on them included, publish no call nested in such a getter, an immutable marker only stops publication, and the marker fd is not inherited", async () => {
		const b = box("stuck-qual", FED);
		prepared(b, "tr-sq1", {
			"bunfig.toml": `[test]\npreload = ["./setup.ts"]\n`,
			"setup.ts": "(globalThis as Record<string, unknown>).__fixturePreload = 1;\n",
			"qual.test.ts": QUAL_TEST,
			"a.test.ts": OK_TEST,
		}, { fullCapMin: 5, soloCapMin: 5, fullWorkers: 2, stuckStop: "enforce" });
		const work = workOf(b, "tr-sq1");
		// bun 1.3.14 runs no Object.prototype accessor beside a {} options object: that phase then passes no getter gate.
		const getterRuns: Record<string, boolean> = {
			"env-array-getter": r3GetterCall("env-array", ["/usr/bin/true"], () => {}).hits > 0,
			"proto-cwd-getter": r3GetterCall("proto-cwd", ["/usr/bin/true"], () => {}).hits > 0,
		};
		const order = ["start", ...QUAL_PHASES.flatMap(([name, during]) => [...during.filter((g) => !g.startsWith("get-") || getterRuns[name] !== false), `after-${name}`])];
		makeGates(work, order);
		type QualRow = { name: string; command: string | null; start: number; end: number; out: unknown; pid?: number; preloadGlobal?: unknown; wrapped?: boolean };
		const rowsOf = () => readFileSync(join(work, "qual.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as QualRow);
		const p = spawnCall(b, { sub: "full", runId: "tr-sq1" });
		const tick = feeder(b, "tr-sq1", p);
		// One fed tick at each gate, STUCK_DEFAULTS.tickMs apart on fed time. The worker's CPU is fed flat (sampled, never hot):
		// it blocks in each call, so no signature may form.
		let w = 0;
		const atGate: Record<string, number> = {};
		for (const [k, g] of order.entries()) {
			const ack = await pass(work, g, p, () => {
				if (g === "start") w = rowsOf()[0]!.pid!;
				return tick(k * STUCK_DEFAULTS.tickMs, { [w]: 0 });
			});
			expect({ g, n: ack.n, error: ack.error, ended: ack.ended, signatures: ack.signatures, started: ack.started }).toEqual({ g, n: k + 1, error: undefined, ended: undefined, signatures: [], started: [] });
			atGate[g] = ack.at!;
		}
		own(Number(readFileSync(join(work, "inherit.pid"), "utf8")));
		const [exit, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
		expect(stderr).toBe("");
		expect(exit).toBe(0);
		// No signature ever forms: the worker blocks in each call (never hot) and no child is left unreaped.
		expect(keywordsOf(stdout)).toEqual([]);
		const byName = Object.fromEntries(rowsOf().map((x) => [x.name, x]));
		expect(byName.start).toMatchObject({ preloadGlobal: 1, wrapped: true });
		expect(byName.start!.pid).toBe(w);
		// A worker of --parallel=2, not the leader.
		expect(w).not.toBe(Number(readFileSync(join(work, "groups"), "utf8").split("\n")[0]));
		const trace = traceOf(work);
		expect(trace.every((t) => t.snap === "ok")).toBe(true);
		expect(trace.map((t) => t.at)).toEqual(order.map((g) => atGate[g]));
		const mine = (t: TraceRow) => activeAt(t).filter((m) => m.pid === w);
		const seenAt = (g: string) => trace.find((t) => t.at === atGate[g])!;
		for (const [name, during] of QUAL_PHASES) {
			const ph = byName[name]!;
			// During the call (and any getter it runs): the call's command, or no marker when the call is unpublished.
			for (const g of during.filter((d) => d in atGate)) {
				const t = seenAt(g);
				expect({ phase: name, gate: g, markers: mine(t).map((m) => m.command) }).toEqual({ phase: name, gate: g, markers: ph.command === "" ? [] : [ph.command] });
				if (ph.command === "") continue;
				expect(mine(t)[0]!.since).toBeGreaterThanOrEqual(ph.start);
				expect(mine(t)[0]!.since).toBeLessThanOrEqual(ph.end);
			}
			// After the call returned, before the worker's next call: no marker.
			expect({ phase: name, markers: mine(seenAt(`after-${name}`)) }).toEqual({ phase: name, markers: [] });
		}
		expect(byName.bun!.out).toBe(0);
		expect([byName["bun-options-no-bytes"]!.out, byName["bun-options"]!.out]).toEqual([0, 0]);
		expect([byName["node-options-no-input"]!.out, byName["node-options"]!.out]).toEqual([0, 0]);
		// Review r4: each byte getter ran once, as unwrapped, and the call did what it does unwrapped.
		const byteShapes = ["own", "inherited", "node-input"] as const;
		const nativeBytes = byteShapes.map((s) => byteGetterCall(childProcess, s, ["/usr/bin/true"], () => {}));
		expect(nativeBytes.map((n) => n.hits)).toEqual([1, 1, 1]);
		expect(byteShapes.map((s) => byName[`byte-${s}-getter`]!.out)).toEqual(nativeBytes);
		expect([byName["argv-getter"]!.out, byName["cwd-getter"]!.out, byName["env-getter"]!.out]).toEqual([0, 0, 0]);
		// The same exit and getter count as the unwrapped shapes here (bun runs the env array's getter once, never the inherited one).
		expect([byName["proto-cwd-getter"]!.out, byName["env-array-getter"]!.out]).toEqual([r3GetterCall("proto-cwd", ["/usr/bin/true"], () => {}), r3GetterCall("env-array", ["/usr/bin/true"], () => {})]);
		expect(byName["node-spawnSync"]!.out).toBe(0);
		expect(byName["node-execSync"]!.out).toBe("slept\n");
		expect(byName["node-execFileSync"]!.out).toBe("");
		// The same fields, and the same thrown errors (a missing binary included), as the unwrapped calls in this process.
		const plain = JSON.parse(JSON.stringify(callFields(childProcess)));
		expect(byName.fields!.out).toEqual(plain);
		expect(plain.missingBun.threw).toBe(true);
		expect(plain.missingExecFileSync.threw).toBe(true);
		// The accessor, proxy and nested shapes really ran test code (once per getter, a one-shot throw surfacing), so equality
		// above means the wrapper invoked none of it itself and swallowed none of its errors.
		expect([plain.argv0Getter.hits, plain.cmdGetter.hits, plain.argv0Throws.hits, plain.cmdThrows.hits, plain.nestedBun.hits, plain.nestedNode.hits]).toEqual([1, 1, 1, 1, 1, 1]);
		expect([plain.laterArgvGetter.hits, plain.cwdGetter.hits, plain.envGetter.hits, plain.envArrayGetter.hits]).toEqual([1, 1, 1, 1]);
		expect([plain.envArrayGetter.out.stdout, plain.protoCwdGetter.out.exitCode]).toEqual(["AS2TEST_E=e\n", 0]);
		expect([plain.laterArgvGetter.out.stdout, plain.cwdGetter.out.stdout, plain.envGetter.out.stdout, plain.plainOptions.stdout]).toEqual(["l0 l2\n", "/\n", "AS2TEST_E=e\n", "in"]);
		expect([plain.argv0Throws.out.message, plain.cmdThrows.out.message]).toEqual(["as2test one-shot getter", "as2test one-shot getter"]);
		expect(plain.proxyOptions.hits).toBeGreaterThan(0);
		expect(plain.nestedNode.out).toBe("n0 deep\n");
		// Nested inside a call's own argv accessor: neither the outer head nor the nested sh published (the generic window check
		// above saw no marker), so both read the same marker line, written before the phase began.
		const nested = byName["nested-accessor"]!;
		const nestedOut = nested.out as { outer: string; outerExit: number; inner: string; innerExit: number };
		expect(nestedOut).toMatchObject({ outerExit: 0, innerExit: 0 });
		expect(nestedOut.outer).toMatch(/^\d+\t[^\t\n]+\n$/);
		expect(nestedOut.inner).toBe(nestedOut.outer);
		expect(Number(nestedOut.outer.split("\t")[0])).toBeLessThan(nested.start);
		// From the node path's accessor, before node reaches Bun.spawnSync: the cat was the outermost call then and published
		// itself, and the head after it published its own, later line.
		const viaNode = byName["nested-node"]!.out as { outer: string; inner: string };
		expect(viaNode.inner).toMatch(/^\d+\tcat\n$/);
		expect(viaNode.outer).toMatch(/^\d+\thead\n$/);
		expect(Number(viaNode.outer.split("\t")[0])).toBeGreaterThanOrEqual(Number(viaNode.inner.split("\t")[0]));
		// Immutable marker: chflags worked, every call still returned what it would, and no marker was active at its gates (above).
		const imm = byName.immutable!;
		expect(imm.out).toEqual({ uchg: 0, sleep: 0, node: 0, fields: plain });
		expect(byName.nouchg!.out).toBe(0);
		// Not inherited: the backgrounded sleep outlived the call, holds no marker fd, and the marker was inactive meanwhile.
		expect(byName.inherit!.out).toMatchObject({ alive: true, lsofExit: 0, holdsMarker: false, lsofHasSleep: true });
		// The part's marker dir and preload are gone; the trace and nothing else of the detector's is left.
		expect(existsSync(join(work, "stuck-markers-full"))).toBe(false);
		expect(existsSync(join(work, "stuck-preload-full.js"))).toBe(false);
	}, 360_000);

	// The cases below run the detector on fed ticks (detectFeed): time and the worker's CPU are the test's explicit samples on
	// a real snapshot, markers and argv, and the signature capture's deadline is fed too (cut only where the test publishes
	// it). Each waits on real events: the fixture's ready-spin publication, the zombie's exit (`exitOf`), each tick's ack and
	// the wrapper's exit. The real clock at STUCK_DEFAULTS is the production integration's, after them.
	test("enforce, fed ticks: the spin fixture's signature starts on tick 2 and stops persistMs later with stuck-stop, a signature capture, a teardown of every owned group (a group created during the capture included) and exit 125; capture tools, marker dir and preload are gone", async () => {
		const b = box("stuck-enforce", FED);
		prepared(b, "tr-se1", { "spin.test.ts": spinTest(true), "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
		const work = workOf(b, "tr-se1");
		readyDirs(work, "ready-spin", "ready-late");
		const hook = join(b.hooks, "tr-se1.signature-capture");
		writeFileSync(`${hook}.pause`, "");
		const p = spawnCall(b, { sub: "full", runId: "tr-se1" });
		let ready: Ready;
		let late: number;
		try {
			ready = await readySpin(work, p);
			await exitOf(ready.zombie);
			await feedToMatch(feeder(b, "tr-se1", p), ready);
			// The capture holds at its hook until the helper has made its second group: that group is new during the capture.
			late = Number(await when(join(work, "ready-late"), () => published(work, "ready-late"), "the late helper's ready-late", p));
			own(late);
		} finally {
			writeFileSync(`${hook}.go`, "");
		}
		const code = await p.exited;
		const stdout = await new Response(p.stdout).text();
		const stderr = await new Response(p.stderr).text();
		const { worker, zombie } = ready;
		const helper = fixturePid(work, "helper.pid");
		const leader = Number(readFileSync(join(work, "groups"), "utf8").split("\n")[0]);
		report({ fixture: "enforce", exit: code, stdout, stderr });
		expect(worker).not.toBe(leader);
		expect(code).toBe(WRAPPER_EXIT.stuck);
		// Fed ticks leave no flap: one signature, its stop, the capture and the teardown.
		expect(keywordsOf(stdout)).toEqual(["stuck-signature", "stuck-stop", "stuck-captured", "stuck-killed"]);
		const { sig, captured, killed } = enforceLines(stdout, worker, zombie);
		expect(sig.rest).toMatch(new RegExp(`^worker ${worker} zombie ${zombie} since \\d+ mode enforce bun ${Bun.version.replaceAll(".", "\\.")} ${Bun.revision}$`));
		expect(captured.rest).toMatch(/^file full\.signature\.log ms \d+$/);
		const k = /^pgids ([\d,]+) ms (\d+) contained$/.exec(killed.rest);
		expect(k).not.toBeNull();
		const stopSet = k![1]!.split(",").map(Number);
		// The leader's group (the worker's too), the helper's and the one made during the capture.
		expect(stopSet).toEqual(expect.arrayContaining([leader, helper, late]));
		// spun is fed time: the signature's first tick (1 × tickMs) to the match (persistMs later).
		expect(stderr).toBe(`stuck: worker ${worker} spun ${STUCK_DEFAULTS.persistMs} ms in Bun.spawnSync with unreaped child ${zombie}; ${stopSet.length} process groups killed, containment contained\n`);
		// Every owned process and group is gone, with no sweep.
		for (const pid of [leader, worker, helper, late]) expect({ pid, alive: alive(pid) }).toEqual({ pid, alive: false });
		for (const g of stopSet) expect({ g, alive: alive(-g) }).toEqual({ g, alive: false });
		const groups = readFileSync(join(work, "groups"), "utf8").split("\n").filter(Boolean).map(Number);
		expect(groups).toEqual(expect.arrayContaining(stopSet));
		// The signature capture: tree, marker, sample, lsof, log tail, run to its end (no cut was fed); its tools are gone and
		// its cap dir cleared.
		const text = readFileSync(join(work, "full.signature.log"), "utf8");
		expect(text).toContain(`signature capture of full: worker ${worker} spun ${STUCK_DEFAULTS.persistMs} ms `);
		expect(text).toContain(`deadline fed (${join(b.hooks, "tr-se1.full.detect-cut")})`);
		const s = signatureSections(text);
		expect(Object.keys(s)).toEqual(["1", "2", "3", "4", "5"]);
		expect(s["1"]).toContain(`${worker} `);
		expect(s["1"]).toContain("<- worker");
		expect(s["1"]).toContain("<- unreaped child");
		expect(s["2"]).toMatch(/observed: since \d+ \(.+\) command true\n/);
		expect(s["3"]).toContain(`$ /usr/bin/sample ${worker} 1 -mayDie -file `);
		expect(s["4"]).toContain(`$ /usr/sbin/lsof -nP -p ${worker} `);
		expect(s["5"]).toContain("bun test v");
		expect(text).not.toContain("capture cut");
		const tools = capturePids(text);
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.filter(alive)).toEqual([]);
		expect(readdirSync(work).filter((n) => n.startsWith("full.signature-"))).toEqual([]);
		expect(existsSync(join(work, "stuck-markers-full"))).toBe(false);
		expect(existsSync(join(work, "stuck-preload-full.js"))).toBe(false);
	}, 90_000);

	for (const how of ["fifo", "symlink"] as const) {
		test(`enforce, fed ticks: refuses a ${how} groups file after the stop decision, still kills every owned group and preserves the stuck cause with unconfirmed cleanup`, async () => {
			const b = box(`stuck-groups-${how}`, FED);
			const runId = how === "fifo" ? "tr-sef1" : "tr-ses1";
			prepared(b, runId, { "spin.test.ts": spinTest(true), "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
			const work = workOf(b, runId);
			readyDirs(work, "ready-spin", "ready-late");
			const hook = join(b.hooks, `${runId}.signature-capture`);
			const target = join(work, "groups-target");
			writeFileSync(target, "UNCHANGED\n");
			writeFileSync(`${hook}.pause`, "");
			const p = spawnCall(b, { sub: "full", runId });
			try {
				const { worker, zombie, ...ready } = await readySpin(work, p);
				await exitOf(zombie);
				// The stop is decided on the last fed tick and no tick follows it: only the enforce teardown persists groups now,
				// and it waits behind the capture, held at its hook.
				await feedToMatch(feeder(b, runId, p), { worker, zombie, ...ready });
				const late = Number(await when(join(work, "ready-late"), () => published(work, "ready-late"), "the late helper's ready-late", p));
				const helper = fixturePid(work, "helper.pid");
				const leader = Number(readFileSync(join(work, "groups"), "utf8").split("\n")[0]);
				own(leader, late);
				rmSync(join(work, "groups"));
				if (how === "fifo") expect(Bun.spawnSync(["/usr/bin/mkfifo", join(work, "groups")], { timeout: 1_000 }).exitCode).toBe(0);
				else symlinkSync(target, join(work, "groups"));
				writeFileSync(`${hook}.go`, "");
				expect(await p.exited).toBe(WRAPPER_EXIT.stuck);
				const stdout = await new Response(p.stdout).text();
				const stderr = await new Response(p.stderr).text();
				expect(keywordsOf(stdout)).toEqual(["stuck-signature", "stuck-stop", "stuck-captured", "stuck-killed"]);
				const { killed } = enforceLines(stdout, worker, zombie);
				const k = /^pgids ([\d,]+) ms \d+ unconfirmed cleanup-failed$/.exec(killed.rest);
				expect(k).not.toBeNull();
				const stopSet = k![1]!.split(",").map(Number);
				expect(stopSet).toEqual(expect.arrayContaining([leader, helper, late]));
				expect(stderr).toContain(`stuck: worker ${worker} spun ${STUCK_DEFAULTS.persistMs} ms in Bun.spawnSync with unreaped child ${zombie};`);
				expect(stderr).toContain("containment unconfirmed:");
				expect(stderr).toContain(`timeout cleanup: cannot persist descendant groups to ${join(work, "groups")}: open failed:`);
				expect(lstatSync(join(work, "groups"))[how === "fifo" ? "isFIFO" : "isSymbolicLink"]()).toBe(true);
				expect(readFileSync(target, "utf8")).toBe("UNCHANGED\n");
				// Do not sweep a hostile groups path; teardown must contain the processes itself: each one exits.
				for (const pid of [leader, worker, helper, late]) await exitOf(pid);
				expect(stopSet.filter((g) => alive(-g))).toEqual([]);
			} finally {
				writeFileSync(`${hook}.go`, "");
				if (p.exitCode === null) p.kill("SIGKILL");
				await p.exited;
			}
		}, 60_000);
	}

	test("shadow (caps.json without stuckStop), fed ticks: the spin fixture gets stuck-would-stop persistMs after its signature and a signature capture, nothing is stopped, and the part runs on to its cap and exits 124 as before", async () => {
		const b = box("stuck-shadow", FED);
		prepared(b, "tr-ss1", { "spin.test.ts": spinTest(false), "a.test.ts": OK_TEST }, { fullCapMin: 0.15, soloCapMin: 0.15, fullWorkers: 2 });
		const work = workOf(b, "tr-ss1");
		readyDirs(work, "ready-spin");
		const p = spawnCall(b, { sub: "full", runId: "tr-ss1" });
		const { worker, zombie, ...ready } = await readySpin(work, p);
		await exitOf(zombie);
		// The match is acked on the last fed tick, so it came before the cap: a tick after the cap is acked `ended`.
		await feedToMatch(feeder(b, "tr-ss1", p), { worker, zombie, ...ready });
		const code = await p.exited;
		const stdout = await new Response(p.stdout).text();
		const stderr = await new Response(p.stderr).text();
		report({ fixture: "shadow", exit: code, stdout, stderr });
		expect(code).toBe(WRAPPER_EXIT.timeout);
		expect(stderr).toBe("as2test: timeout: the part passed its cap of 9000 ms; its group was killed\n");
		const lines = detectorLines(stdout);
		expect(lines.map((l) => l.keyword)).toEqual(["stuck-signature", "stuck-would-stop", "stuck-captured"]);
		for (const l of lines) expect(new Date(l.iso).toISOString()).toBe(l.iso);
		expect(lines[0]!.rest).toMatch(new RegExp(`^worker ${worker} zombie ${zombie} since \\d+ mode shadow bun `));
		expect(lines[1]!.rest).toBe(`worker ${worker} zombie ${zombie}`);
		expect(lines[2]!.rest).toMatch(/^file full\.signature\.log ms \d+$/);
		const text = readFileSync(join(work, "full.signature.log"), "utf8");
		expect(text).toContain(`signature capture of full: worker ${worker} spun ${STUCK_DEFAULTS.persistMs} ms `);
		expect(Object.keys(signatureSections(text))).toEqual(["1", "2", "3", "4", "5"]);
		// D5's cap path is unchanged: its stuck capture, then the group's kill.
		expect(Object.keys(stuckSections(readFileSync(join(work, "full.stuck.log"), "utf8")))).toEqual(["1", "2", "3", "4"]);
		// The cap kills the leader's group as before. A --parallel worker has its own group, which a groups sweep does not
		// know; a spinning one usually outlives its leader, so the test ends it here. It may already have gone (observed under
		// a concurrent load): whether it survives the leader is bun's, not the detector's, so ESRCH is fine here.
		try {
			process.kill(worker, "SIGKILL");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		}
		await exitOf(worker);
		expect(existsSync(join(work, "stuck-markers-full"))).toBe(false);
		expect(existsSync(join(work, "stuck-preload-full.js"))).toBe(false);
	}, 90_000);

	test("a signature capture whose tools are still running at its deadline is cut there: every capture group is SIGKILLed, the file says so, and the stop still exits 125", async () => {
		const b = box("stuck-cut", FED);
		prepared(b, "tr-sk1", { "spin.test.ts": spinTest(false), "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
		const work = workOf(b, "tr-sk1");
		readyDirs(work, "ready-spin");
		// The fed deadline has passed before the capture starts: the capture is cut at its first look, once its sample and lsof
		// are started, and the hook it holds at is never released.
		const cut = join(b.hooks, "tr-sk1.full.detect-cut");
		writeFileSync(cut, "");
		const hook = join(b.hooks, "tr-sk1.signature-capture");
		writeFileSync(`${hook}.pause`, "");
		const p = spawnCall(b, { sub: "full", runId: "tr-sk1" });
		try {
			const { worker, zombie, ...ready } = await readySpin(work, p);
			await exitOf(zombie);
			await feedToMatch(feeder(b, "tr-sk1", p), { worker, zombie, ...ready });
			expect(await p.exited).toBe(WRAPPER_EXIT.stuck);
			const stdout = await new Response(p.stdout).text();
			expect(existsSync(`${hook}.reached`)).toBe(true);
			expect(keywordsOf(stdout)).toEqual(["stuck-signature", "stuck-stop", "stuck-captured", "stuck-killed"]);
			enforceLines(stdout, worker, zombie);
			const text = readFileSync(join(work, "full.signature.log"), "utf8");
			expect(text).toContain(`deadline fed (${cut})`);
			expect(text).toMatch(/^capture cut at \d+ ms$/m);
			expect(Object.keys(signatureSections(text))).toEqual(["1", "2"]);
			const killed = /^killed capture groups: (.*)$/m.exec(text)?.[1] ?? "";
			expect(killed).toMatch(/^\d+( \d+)*$/);
			const tools = capturePids(text);
			expect(tools.length).toBeGreaterThan(0);
			for (const t of tools) await exitOf(t);
			expect(readdirSync(work).filter((n) => n.startsWith("full.signature-"))).toEqual([]);
		} finally {
			writeFileSync(`${hook}.go`, "");
		}
	}, 90_000);

	test("fed ticks: a malformed feed turns the detector off loudly (its ack names the field, a stuck-detector-off line) and the part runs on to its cap", async () => {
		const b = box("stuck-feed-bad", FED);
		prepared(b, "tr-sfb1", { "spin.test.ts": spinTest(false), "a.test.ts": OK_TEST }, { fullCapMin: 0.15, soloCapMin: 0.15, fullWorkers: 2 });
		const work = workOf(b, "tr-sfb1");
		readyDirs(work, "ready-spin");
		const p = spawnCall(b, { sub: "full", runId: "tr-sfb1" });
		const { worker } = await readySpin(work, p);
		const base = join(b.hooks, "tr-sfb1.full");
		mkdirSync(`${base}.detect-ack.1`);
		writeFileSync(`${base}.detect-feed.1.tmp`, JSON.stringify({ at: "soon", cpu: {} }));
		renameSync(`${base}.detect-feed.1.tmp`, `${base}.detect-feed.1`);
		const ack = join(`${base}.detect-ack.1`, "ack");
		const answer = JSON.parse(await when(`${base}.detect-ack.1`, () => (existsSync(ack) ? readFileSync(ack, "utf8") : undefined), "ack 1", p)) as Ack;
		const why = `detector feed ${base}.detect-feed.1: at is not a finite number: "soon"`;
		expect(answer).toEqual({ n: 1, error: why });
		expect(await p.exited).toBe(WRAPPER_EXIT.timeout);
		const lines = detectorLines(await new Response(p.stdout).text());
		expect(lines.map((l) => `${l.keyword} ${l.rest}`)).toEqual([`stuck-detector-off reason ${why}`]);
		try {
			process.kill(worker, "SIGKILL");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		}
		await exitOf(worker);
	}, 90_000);

	test("production integration, real ticks at STUCK_DEFAULTS (enforce): the spin fixture is stopped and exits 125; ready→signature, signature→stop, stop→exit and the total are recorded from the fixture's own ready time", async () => {
		const b = box("stuck-real");
		prepared(b, "tr-sr1", { "spin.test.ts": spinTest(false), "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
		const work = workOf(b, "tr-sr1");
		readyDirs(work, "ready-spin");
		const p = spawnCall(b, { sub: "full", runId: "tr-sr1" });
		const ready = await readySpin(work, p);
		const code = await p.exited;
		const exitedAt = Date.now();
		const stdout = await new Response(p.stdout).text();
		const stderr = await new Response(p.stderr).text();
		report({ fixture: "production", exit: code, stdout, stderr });
		expect(code).toBe(WRAPPER_EXIT.stuck);
		const { first, sig, stop } = enforceLines(stdout, ready.worker, ready.zombie);
		// A real tick matches only once the signature has held persistMs (stuck-detect.ts StuckDetector.tick).
		expect(Number(/ spun (\d+) ms /.exec(stderr)?.[1])).toBeGreaterThanOrEqual(STUCK_DEFAULTS.persistMs);
		// The durations are measurements of the real clock on whatever load the run meets: recorded, never asserted.
		const figures = {
			fixture: "production", readyToSignatureMs: Date.parse(sig.iso) - ready.at, readyToFirstSignatureMs: Date.parse(first.iso) - ready.at,
			signatureToStopMs: Date.parse(stop.iso) - Date.parse(sig.iso), stopToExitMs: exitedAt - Date.parse(stop.iso), totalMs: exitedAt - ready.at,
		};
		report(figures);
		console.log(`as2test production detector timing: ${JSON.stringify(figures)}`);
		await exitOf(ready.worker);
		expect(existsSync(join(work, "stuck-markers-full"))).toBe(false);
		expect(existsSync(join(work, "stuck-preload-full.js"))).toBe(false);
	}, 90_000);

	test("a caps.json stuckStop other than shadow or enforce is refused for full and solo", async () => {
		// One prepared run; each bad value is written over its caps.json, which full and solo read before anything else.
		const b = box("stuck-bad");
		prepared(b, "tr-sb1", { "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1 });
		const caps = join(b.root, "stage", "tr-sb1", "caps.json");
		for (const bad of ["on", true, null, 1]) {
			writeFileSync(caps, JSON.stringify({ fullCapMin: 1, soloCapMin: 1, stuckStop: bad }));
			const runs = ([{ sub: "full", runId: "tr-sb1" }, { sub: "solo", runId: "tr-sb1", file: "./a.test.ts" }] as WrapperCall[]).map((c) => spawnCall(b, c));
			for (const [i, p] of runs.entries()) {
				const [exit, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
				expect({ bad, part: i, exit, refusal: stderr.includes("stuckStop") }).toEqual({ bad, part: i, exit: WRAPPER_EXIT.refused, refusal: true });
			}
		}
	});

	// Each control holds its worker at a gate (GATE_HEAD) in the state under test while the test feeds as many ticks as a
	// hot signature needs to start and match (HOLD); the worker's CPU is fed (hot where the control's worker is a hot one),
	// so what the controls test is the structure a tick sees, never how a loaded machine schedules.
	describe("negative controls, fed ticks: each part ends normally with no signature and no decision (enforce, --parallel=2)", () => {
		const HOLD = 2 + STUCK_DEFAULTS.persistMs / STUCK_DEFAULTS.tickMs;
		const head = (body: string) => `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\n${GATE_HEAD}${body}`;
		/** The worker publishes ../w.pid, runs `before`, makes an unreaped /usr/bin/true (../z.pid), and holds at `hold`. */
		const zombieHeld = (before = "") =>
			head(`test("c", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n${before}\twriteFileSync("../z.pid", String(${unreapedTrue()}.pid));\n\tgate("hold");\n}, 60_000);\n`);
		/** A getter's body: the unreaped /usr/bin/true (../z.pid), then the hold gate. */
		const GETTER_HOLD = `writeFileSync("../z.pid", String(${unreapedTrue()}.pid));\n\t\tgate("hold");`;
		const hot = (pid: number) => (at: number) => ({ [pid]: at * 1e6 });
		const flat = (pid: number) => (_at: number) => ({ [pid]: 0 });

		interface Control {
			work: string;
			p: Wrapper & { stdout: ReadableStream<Uint8Array> };
			/** Feed `n` ticks (HOLD by default), STUCK_DEFAULTS.tickMs apart on fed time from the last; none may start, match or clear. */
			feed: (cpu: (at: number) => Record<number, number>, n?: number) => Promise<void>;
			/** How many ticks were fed. */
			fed: () => number;
		}
		function control(name: string, files: Record<string, string>, gates: string[]): Control {
			const b = box(`stuck-neg-${name}`, FED);
			prepared(b, "tr-sn1", files, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
			const work = workOf(b, "tr-sn1");
			makeGates(work, gates);
			const p = spawnCall(b, { sub: "full", runId: "tr-sn1" });
			const tick = feeder(b, "tr-sn1", p);
			let k = 0;
			const feed = async (cpu: (at: number) => Record<number, number>, n = HOLD) => {
				for (let i = 0; i < n; i++, k++) {
					const at = k * STUCK_DEFAULTS.tickMs;
					const a = await tick(at, cpu(at));
					expect({ name, n: a.n, error: a.error, ended: a.ended, signatures: a.signatures, started: a.started, matched: a.matched, cleared: a.cleared })
						.toEqual({ name, n: k + 1, error: undefined, ended: undefined, signatures: [], started: [], matched: [], cleared: [] });
				}
			};
			return { work, p, feed, fed: () => k };
		}
		/** The control ended normally with no detector line at all; returns its trace, one row per fed tick. */
		async function ended(c: Control): Promise<TraceRow[]> {
			const [exit, stdout, stderr] = await Promise.all([c.p.exited, new Response(c.p.stdout).text(), new Response(c.p.stderr).text()]);
			expect({ exit, stderr, lines: keywordsOf(stdout) }).toEqual({ exit: 0, stderr: "", lines: [] });
			const trace = traceOf(c.work);
			expect(trace).toHaveLength(c.fed());
			expect(trace.every((t) => t.snap === "ok" && t.signatures.length === 0)).toBe(true);
			expect(existsSync(join(c.work, "stuck-markers-full"))).toBe(false);
			return trace;
		}
		const zombieOf = (t: TraceRow, ppid: number) => t.zombies.some((z) => z.ppid === ppid && z.comm === "true");
		const markedBy = (t: TraceRow, w: number) => activeAt(t).filter((m) => m.pid === w).map((m) => m.command);

		/** Hold a zombie-making control, feed HOLD hot ticks once its /usr/bin/true has exited, then let it end. */
		async function heldZombie(name: string, file: string): Promise<{ trace: TraceRow[]; w: number }> {
			const c = control(name, { "a.test.ts": OK_TEST, "c.test.ts": file }, ["hold"]);
			const w = await reached(c.work, "hold", c.p);
			expect(fixturePid(c.work, "w.pid")).toBe(w);
			await exitOf(fixturePid(c.work, "z.pid"));
			await c.feed(hot(w));
			letThrough(c.work, "hold");
			return { trace: await ended(c), w };
		}

		test("a hot worker holding a zombie child, with no marker", async () => {
			const { trace, w } = await heldZombie("zombie-no-marker", zombieHeld());
			expect(trace.map((t) => ({ zombie: zombieOf(t, w), markers: activeAt(t) }))).toEqual(trace.map(() => ({ zombie: true, markers: [] })));
		}, 60_000);

		test("a real Bun.spawnSync(['/usr/bin/true']) that returns, then an async /usr/bin/true born at once, held hot: the marker is inactive", async () => {
			const { trace, w } = await heldZombie("returned-call-then-zombie", zombieHeld(`\tBun.spawnSync(["/usr/bin/true"]);\n`));
			expect(trace.map((t) => ({ zombie: zombieOf(t, w), markers: activeAt(t) }))).toEqual(trace.map(() => ({ zombie: true, markers: [] })));
		}, 60_000);

		test("the same with the marker file made immutable before the first call: no marker ever becomes active", async () => {
			const file = `import { dlopen, FFIType } from "bun:ffi";
${head(`const { chflags } = dlopen("/usr/lib/libSystem.B.dylib", { chflags: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 } }).symbols;
test("c", () => {
	writeFileSync("../w.pid", String(process.pid));
	const marker = Buffer.from(process.env.AS2TEST_STUCK_MARKERS + "/" + process.pid + "\\0");
	// UF_IMMUTABLE, as chflags uchg; cleared again so the executor can remove the dir.
	if (chflags(marker, 2) !== 0) throw new Error("chflags uchg failed");
	try {
		Bun.spawnSync(["/usr/bin/true"]);
		writeFileSync("../z.pid", String(${unreapedTrue()}.pid));
		gate("hold");
	} finally {
		chflags(marker, 0);
	}
}, 60_000);
`)}`;
			const { trace, w } = await heldZombie("immutable-marker", file);
			expect(trace.map((t) => ({ zombie: zombieOf(t, w), markers: activeAt(t) }))).toEqual(trace.map(() => ({ zombie: true, markers: [] })));
		}, 60_000);

		/**
		 * A getter control: `call` (test code) runs GETTER_HOLD in a getter the call reads, then the fixture writes ../out.json
		 * and stops at `after`. `runs`: whether this bun runs that getter at all (the unwrapped shape says); when it does, HOLD
		 * hot ticks see the worker's zombie with no marker of the worker; then one more tick at `after`.
		 */
		async function getterControl(name: string, imports: string, call: string, runs: boolean): Promise<unknown> {
			const file = `${imports}${head(`test("c", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tconst out = ${call};\n\twriteFileSync("../out.json", JSON.stringify(out));\n\tgate("after");\n}, 60_000);\n`)}`;
			const c = control(name, { "a.test.ts": OK_TEST, "c.test.ts": file }, ["hold", "after"]);
			if (runs) {
				const held = await reached(c.work, "hold", c.p);
				await exitOf(fixturePid(c.work, "z.pid"));
				await c.feed(hot(held));
				letThrough(c.work, "hold");
			}
			const w = await reached(c.work, "after", c.p);
			await c.feed(hot(w), 1);
			letThrough(c.work, "after");
			const trace = await ended(c);
			const held = trace.slice(0, runs ? HOLD : 0);
			expect(held.map((t) => ({ zombie: zombieOf(t, w), marked: markedBy(t, w) }))).toEqual(held.map(() => ({ zombie: true, marked: [] })));
			return JSON.parse(readFileSync(join(c.work, "out.json"), "utf8"));
		}

		test("Bun.spawnSync(['/usr/bin/true', <getter>]) whose getter starts an async /usr/bin/true and holds hot: the call runs unpublished, so the hot worker's zombie never meets a marker", async () => {
			const call = `(() => {\n\t\tconst argv = ["/usr/bin/true"];\n\t\tObject.defineProperty(argv, 1, { enumerable: true, get() {\n\t\t${GETTER_HOLD}\n\t\treturn "x";\n\t\t} });\n\t\treturn { exitCode: Bun.spawnSync(argv).exitCode };\n\t})()`;
			expect(await getterControl("argv-getter", "", call, true)).toEqual({ exitCode: 0 });
		}, 60_000);

		for (const shape of ["proto-cwd", "env-array"] as const) {
			const what = shape === "proto-cwd" ? "Bun.spawnSync(['/usr/bin/true'], {}) beside an Object.prototype cwd getter" : "Bun.spawnSync(['/usr/bin/true'], { env: <array with an enumerable named getter> })";
			test(`${what} whose getter starts an async /usr/bin/true and holds hot: the call runs unpublished and does what it does unwrapped, so the hot worker's zombie never meets a marker`, async () => {
				// bun 1.3.14 runs the env array's getter; it stops its option lookups before Object.prototype, so the inherited
				// getter runs only if a later bun reads it, and then it must meet no marker either.
				const native = r3GetterCall(shape, ["/usr/bin/true"], () => {});
				const call = `r3GetterCall("${shape}", ["/usr/bin/true"], () => {\n\t\t${GETTER_HOLD}\n\t})`;
				expect(await getterControl(`${shape}-getter`, `const r3GetterCall = ${r3GetterCall.toString()};\n`, call, native.hits > 0)).toEqual(native);
			}, 60_000);
		}

		test("Bun.spawnSync(['/usr/bin/true'], { stdin: <Buffer with an own Symbol.asyncIterator getter> }) whose getter starts an async /usr/bin/true and holds hot: the call runs unpublished and does what it does unwrapped, so the hot worker's zombie never meets a marker", async () => {
			const native = byteGetterCall(childProcess, "own", ["/usr/bin/true"], () => {});
			expect(native).toEqual({ exitCode: 0, hits: 1 });
			const call = `byteGetterCall(cp, "own", ["/usr/bin/true"], () => {\n\t\t${GETTER_HOLD}\n\t})`;
			expect(await getterControl("byte-stdin-getter", `import * as cp from "node:child_process";\nconst byteGetterCall = ${byteGetterCall.toString()};\n`, call, true)).toEqual(native);
		}, 60_000);

		test("a long async test", async () => {
			const c = control("long-async", { "a.test.ts": OK_TEST, "c.test.ts": head(`test("c", async () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tawait gateAsync("hold");\n}, 60_000);\n`) }, ["hold"]);
			const w = await reached(c.work, "hold", c.p);
			await c.feed(flat(w));
			letThrough(c.work, "hold");
			const trace = await ended(c);
			expect(trace.map((t) => t.tree.some((p) => p.pid === w))).toEqual(trace.map(() => true));
		}, 60_000);

		test("a real Bun.spawnSync of a child that waits: the marker is active with a live child, and the worker is not hot", async () => {
			const file = head(`test("c", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tconst r = Bun.spawnSync([SLEEP, "hold"]);\n\tif (r.exitCode !== 0) throw new Error("the hold gate's sleep exited " + r.exitCode);\n}, 60_000);\n`);
			const c = control("sync-sleep", { "a.test.ts": OK_TEST, "c.test.ts": file }, ["hold"]);
			const child = await reached(c.work, "hold", c.p);
			const w = fixturePid(c.work, "w.pid");
			await c.feed(flat(w));
			letThrough(c.work, "hold");
			const trace = await ended(c);
			expect(trace.map((t) => ({ marked: markedBy(t, w), child: t.tree.some((p) => p.pid === child && p.ppid === w) }))).toEqual(trace.map(() => ({ marked: ["sleep"], child: true })));
		}, 60_000);

		test("another worker printing continuously beside an idle one", async () => {
			const printer = head(`test("prints", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tannounce("printing");\n\twhile (!__fs.existsSync(W + "/printed")) console.log("x".repeat(100));\n}, 60_000);\n`);
			const idler = head(`test("idles", async () => {\n\twriteFileSync("../idle.pid", String(process.pid));\n\tawait gateAsync("hold");\n}, 60_000);\n`);
			// Two files on --parallel=2: each has a worker of its own, so the printer prints while the idle one waits.
			const c = control("printer-beside-idle", { "c.test.ts": printer, "d.test.ts": idler }, ["printing", "hold"]);
			const w = await reached(c.work, "printing", c.p);
			const idle = await reached(c.work, "hold", c.p);
			expect([fixturePid(c.work, "w.pid"), fixturePid(c.work, "idle.pid")]).toEqual([w, idle]);
			expect(idle).not.toBe(w);
			await c.feed((at) => ({ ...hot(w)(at), ...flat(idle)(at) }));
			letThrough(c.work, "hold");
			writeFileSync(join(c.work, "printed"), "");
			const trace = await ended(c);
			expect(trace.map((t) => [w, idle].every((pid) => t.tree.some((p) => p.pid === pid)))).toEqual(trace.map(() => true));
		}, 60_000);

		test("a zombie whose parent is a sleeping fixture process, beside a hot worker holding a marker", async () => {
			// The sleeper: a bun child of the worker that makes the unreaped /usr/bin/true, then blocks at its gate.
			const sleeper = `${GATE_HEAD}__fs.writeFileSync("../z.pid", String(${unreapedTrue()}.pid));\ngate("sleeper");\n`;
			const file = `${SPIN_HEAD}${GATE_HEAD}test("c", () => {
	writeFileSync("../w.pid", String(process.pid));
	const fd = holdMarker("true");
	Bun.spawn([process.execPath, "-e", ${JSON.stringify(sleeper)}]);
	gate("hold");
	closeSync(fd);
}, 60_000);
`;
			const c = control("zombie-of-a-sleeper", { "a.test.ts": OK_TEST, "c.test.ts": file }, ["sleeper", "hold"]);
			const s = await reached(c.work, "sleeper", c.p);
			const w = await reached(c.work, "hold", c.p);
			await exitOf(fixturePid(c.work, "z.pid"));
			await c.feed(hot(w));
			letThrough(c.work, "sleeper");
			letThrough(c.work, "hold");
			const trace = await ended(c);
			expect(trace.map((t) => ({ marked: markedBy(t, w), sleeperZombie: zombieOf(t, s), workerZombie: zombieOf(t, w) })))
				.toEqual(trace.map(() => ({ marked: ["true"], sleeperZombie: true, workerZombie: false })));
		}, 60_000);
	});
});

// ---- sweep --------------------------------------------------------------------------------------------------

describe("sweep", () => {
	test("a groups sweep kills a detached grandchild of its own part and leaves a sibling fixture's process alive", async () => {
		const b = box("sweep");
		prepared(b, "tr-w1", { "orphan.test.ts": ORPHAN_TEST });
		expect(call(b, { sub: "full", runId: "tr-w1" }).exit).toBe(0);
		const orphan = Number(readFileSync(join(workOf(b, "tr-w1"), "orphan.pid"), "utf8"));
		own(orphan);
		expect(alive(orphan)).toBe(true);
		const sibling = Bun.spawn(["/bin/sleep", "300"]);
		own(sibling.pid);
		const r = call(b, { sub: "sweep", runId: "tr-w1" });
		expect(r.stderr).toBe("");
		expect(r.exit).toBe(WRAPPER_EXIT.ok);
		await exited(orphan);
		expect(alive(sibling.pid)).toBe(true);
		sibling.kill("SIGKILL");
	}, 30_000);

	test("a sweep before prepare (no work dir yet) is a no-op", () => {
		const b = box("sweep0");
		setCurrent(b, "tr-z1");
		expect(call(b, { sub: "sweep", runId: "tr-z1" }).exit).toBe(WRAPPER_EXIT.ok);
	});

	test("a second sweep waits on sweep.db while the first holds it, with locks/ read-only, and gets it once the first is SIGKILLed", async () => {
		const b = box("lock");
		setCurrent(b, "tr-l1");
		chmodSync(join(b.root, "locks"), 0o555);
		const hook = join(b.hooks, "tr-l1.sweep-read1");
		writeFileSync(`${hook}.pause`, "");
		const reachedBy = (): number => {
			const v: unknown = JSON.parse(readFileSync(`${hook}.reached`, "utf8"));
			if (typeof v === "object" && v !== null && "pid" in v && typeof v.pid === "number") return v.pid;
			throw new Error(`${hook}.reached names no pid: ${JSON.stringify(v)}`);
		};
		const first = spawnCall(b, { sub: "sweep", runId: "tr-l1" });
		await appeared(`${hook}.reached`, "the first sweep at sweep-read1", first);
		const holder = reachedBy();
		// The hook stays paused: the first sweep holds sweep.db's exclusive lock at it for as long as it lives, and every
		// sweep takes that lock before it reaches sweep-read1, so the second one cannot reach the hook while the first lives.
		const second = spawnCall(b, { sub: "sweep", runId: "tr-l1" });
		expect(second.exitCode).toBeNull();
		expect(reachedBy()).toBe(holder);
		first.kill("SIGKILL");
		expect(await first.exited).not.toBe(0);
		// Once the first is gone the second gets the lock and reaches the hook itself (each hook visit renames a fresh .reached).
		const next = await when(b.hooks, () => {
			const by = reachedBy();
			return by === holder ? undefined : by;
		}, "the second sweep at sweep-read1", second);
		expect(next).not.toBe(holder);
		writeFileSync(`${hook}.go`, "");
		expect(await second.exited).toBe(WRAPPER_EXIT.ok);
		expect(readdirSync(join(b.root, "locks"))).toEqual(["sweep.db"]);
	}, 30_000);

	test("a sweep that waits past its limit ends `error sweep lock held`", async () => {
		const b = box("held");
		const quick = wrapperFor(b, "exec-quick", { sweepLockWaitMs: 1_000 });
		setCurrent(b, "tr-h1");
		writeFileSync(join(b.hooks, "tr-h1.sweep-read1.pause"), "");
		const holder = spawnCall(b, { sub: "sweep", runId: "tr-h1" });
		await appeared(join(b.hooks, "tr-h1.sweep-read1.reached"), "the holder at sweep-read1", holder);
		rmSync(join(b.hooks, "tr-h1.sweep-read1.pause"));
		const t0 = Date.now();
		const waiter = spawnCall(b, { sub: "sweep", runId: "tr-h1" }, quick);
		expect(await waiter.exited).toBe(WRAPPER_EXIT.sweepLockHeld);
		expect(await new Response(waiter.stderr).text()).toContain("error sweep lock held");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
		holder.kill("SIGKILL");
		await holder.exited;
	}, 30_000);

	test("a sweep whose current changed during the grace aborts before SIGKILL", async () => {
		const b = box("abort");
		prepared(b, "tr-g1", { "stubborn.test.ts": STUBBORN_TEST });
		expect(call(b, { sub: "full", runId: "tr-g1" }).exit).toBe(0);
		const orphan = Number(readFileSync(join(workOf(b, "tr-g1"), "orphan.pid"), "utf8"));
		own(orphan);
		writeFileSync(join(b.hooks, "tr-g1.sweep-read1.pause"), "");
		const sweep = spawnCall(b, { sub: "sweep", runId: "tr-g1" });
		await appeared(join(b.hooks, "tr-g1.sweep-read1.reached"), "the sweep at sweep-read1", sweep);
		setCurrent(b, "tr-g2");
		writeFileSync(join(b.hooks, "tr-g1.sweep-read1.go"), "");
		expect(await sweep.exited).toBe(WRAPPER_EXIT.fenced);
		expect(await new Response(sweep.stderr).text()).toContain("aborted before SIGKILL");
		expect(alive(orphan)).toBe(true);
		process.kill(orphan, "SIGKILL");
	}, 30_000);

	test("the rendered uid wrapper names pkill -U _as2test and no argv-supplied target; test-only options are refused for it", () => {
		const text = renderExecWrapper({ root: "/Users/Shared/as2test", bun: "/usr/local/libexec/as2test/bun", script: "/usr/local/libexec/as2test/test-exec.js", sweepScope: "uid" });
		expect(UID_SWEEP).toBe("/usr/bin/pkill -U _as2test");
		expect(text).toContain("pkill -U _as2test");
		expect(text).not.toContain('"sweep":"groups"');
		// argv reaches only the final exec, after the fixed bun and script; nothing else expands $1..$9 into a command.
		const execLine = text.split("\n").findIndex((l) => l.startsWith("exec /usr/bin/env -i"));
		const argvUses = text.split("\n").flatMap((l, i) => (/"\$@"/.test(l) ? [i] : []));
		expect(argvUses).toEqual([execLine + 2]);
		expect(text).toContain(`'/usr/local/libexec/as2test/bun' '/usr/local/libexec/as2test/test-exec.js' "$@"`);
		const knobs = [{ hooks: "/tmp/h" }, { killGraceMs: 1 }, { sweepLockWaitMs: 1 }, { captureMs: 1 }, { detectTickMs: 1 }, { detectPersistMs: 1 }, { signatureCaptureMs: 1 }, { stopGraceMs: 1 }, { detectTrace: true }, { detectTrace: false }, { detectFeed: true }, { detectFeed: false }];
		for (const extra of knobs) {
			expect(() => renderExecWrapper({ root: "/r", bun: "/b", script: "/s", sweepScope: "uid", ...extra })).toThrow(WrapperRenderError);
		}
		expect(() => renderExecWrapper({ root: "r", bun: "/b", script: "/s", sweepScope: "uid" })).toThrow(WrapperRenderError);
		expect(() => renderExecWrapper({ root: "/r", bun: "/b", script: "/s", sweepScope: "all" as SweepScope })).toThrow(WrapperRenderError);
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "uid" })).toMatchObject({
			killGraceMs: 10_000, sweepLockWaitMs: 60_000, captureMs: 20_000, hooks: null,
			detectTickMs: STUCK_DEFAULTS.tickMs, detectPersistMs: STUCK_DEFAULTS.persistMs, signatureCaptureMs: STUCK_DEFAULTS.signatureCaptureMs, stopGraceMs: STUCK_DEFAULTS.stopGraceMs, detectTrace: false, detectFeed: false,
		});
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "groups", captureMs: 1_500 }).captureMs).toBe(1_500);
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "groups", detectTickMs: 50, detectPersistMs: 400, signatureCaptureMs: 900, stopGraceMs: 300, detectTrace: true }))
			.toMatchObject({ detectTickMs: 50, detectPersistMs: 400, signatureCaptureMs: 900, stopGraceMs: 300, detectTrace: true });
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "groups", hooks: "/h", detectFeed: true }).detectFeed).toBe(true);
		for (const bad of [{ detectTickMs: 0 }, { detectPersistMs: -1 }, { stopGraceMs: 1.5 }, { detectTrace: "yes" as unknown as boolean }, { detectFeed: "yes" as unknown as boolean }, { detectFeed: true }]) {
			expect(() => execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "groups", ...bad })).toThrow(WrapperRenderError);
		}
	});
});

// ---- cleanup -------------------------------------------------------------------------------------------------

describe("cleanup", () => {
	test("refuses its own run id, a malformed old id and a symlinked old run dir, and deletes nothing else", () => {
		const b = box("cleanup");
		setCurrent(b, "tr-n1");
		const runs = join(b.root, "runs");
		const outside = dir("cleanup-outside");
		writeFileSync(join(outside, "keep"), "x");
		mkdirSync(join(runs, "tr-n1"));
		mkdirSync(join(runs, "tr-sib"));
		writeFileSync(join(runs, "tr-sib", "keep"), "x");
		symlinkSync(outside, join(runs, "tr-link"));
		expect(call(b, { sub: "cleanup", runId: "tr-n1", oldRunId: "tr-other" }).exit).toBe(WRAPPER_EXIT.ok);
		expect(raw(b, ["cleanup", "tr-n1", "tr-n1"]).exit).toBe(WRAPPER_EXIT.refused);
		for (const bad of ["../tr-sib", "tr-SIB", "x", "tr-sib/keep"]) expect(raw(b, ["cleanup", "tr-n1", bad]).exit).toBe(WRAPPER_EXIT.refused);
		expect(raw(b, ["cleanup", "tr-n1", "tr-link"]).exit).toBe(WRAPPER_EXIT.refused);
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("x");

		// A real old run dir goes, read-only subdirs and a symlink inside it included; its target and siblings stay.
		mkdirSync(join(runs, "tr-old", "repo", "ro"), { recursive: true });
		writeFileSync(join(runs, "tr-old", "repo", "ro", "f"), "x");
		symlinkSync(outside, join(runs, "tr-old", "repo", "out"));
		chmodSync(join(runs, "tr-old", "repo", "ro"), 0o555);
		const r = call(b, { sub: "cleanup", runId: "tr-n1", oldRunId: "tr-old" });
		expect(r.exit).toBe(WRAPPER_EXIT.ok);
		expect(readdirSync(runs).sort()).toEqual(["tr-link", "tr-n1", "tr-sib"]);
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("x");
		expect(readFileSync(join(runs, "tr-sib", "keep"), "utf8")).toBe("x");
	});

	test("cleanup unlinks a swapped old startup TMPDIR but preserves its target and the current run's temp", () => {
		const b = box("cleanup-startup-link");
		prepared(b, "tr-oldtmp", { "a.test.ts": OK_TEST });
		const outside = dir("cleanup-startup-target");
		writeFileSync(join(outside, "keep"), "private");
		const oldTmp = join(workOf(b, "tr-oldtmp"), ".wrapper-tmp");
		rmSync(oldTmp, { recursive: true });
		symlinkSync(outside, oldTmp);
		prepared(b, "tr-newtmp", { "a.test.ts": OK_TEST });
		const newTmp = join(workOf(b, "tr-newtmp"), ".wrapper-tmp");
		writeFileSync(join(newTmp, "keep"), "current");
		expect(call(b, { sub: "cleanup", runId: "tr-newtmp", oldRunId: "tr-oldtmp" }).exit).toBe(WRAPPER_EXIT.ok);
		expect(existsSync(workOf(b, "tr-oldtmp"))).toBe(false);
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("private");
		expect(readFileSync(join(newTmp, "keep"), "utf8")).toBe("current");
	});
});

// ---- the preflight --------------------------------------------------------------------------------------------

describe("preflight: the probe", () => {
	/** A home, ledger, runs root, checkout and lanes root this user cannot reach, then one thing opened up. */
	function sealed(tag: string) {
		const b = box(tag);
		setCurrent(b, "tr-q1");
		const base = dir(`${tag}-paths`);
		const home = join(base, "home");
		const ledgerDir = join(base, "ledger");
		const runsRoot = join(base, "runs");
		const main = join(base, "main");
		const lanes = join(base, "lanes");
		for (const d of [home, ledgerDir, runsRoot, main, lanes]) mkdirSync(d);
		const env = { HOME: home, AGENT_SYSTEM_LEDGER_DB: join(ledgerDir, "ledger.db") };
		chmodSync(join(b.root, "stage", "current"), 0o444);
		const seal = () => {
			for (const d of [home, main, lanes]) chmodSync(d, 0o555);
			for (const d of [ledgerDir, runsRoot]) chmodSync(d, 0o000);
		};
		const run = () => {
			const items = preflightProbes({ env, runsRoot, mainCheckout: main, lanesRoot: lanes, root: b.root });
			const r = call(b, probeCall("tr-q1", items));
			return probeDecision(items, r.exit, r.stdout);
		};
		return { b, home, ledgerDir, runsRoot, seal, run };
	}

	test("passes when nothing is reachable, and lists every credential path", () => {
		const s = sealed("probe-ok");
		s.seal();
		const v = s.run();
		expect(v).toMatchObject({ ok: true });
		const items = preflightProbes({ env: { HOME: "/h" }, runsRoot: "/r", mainCheckout: "/m", lanesRoot: "/l" });
		for (const p of CREDENTIAL_PATHS) expect(items).toContainEqual({ path: join("/h", p), forbid: "any", why: "credential" });
		expect(items.find((i) => i.path === "/h/.agent-system-2")).toMatchObject({ forbid: "any" });
		expect(items.map((i) => i.path)).toEqual(expect.arrayContaining(["/h/.agent-system-2/ledger.db-wal", "/h/.agent-system-2/ledger.db-shm", "/r", "/r/runs.db", "/Users/Shared/as2test/stage/current", "/h", "/m", "/l"]));
	});

	test("refuses a readable .ssh", () => {
		const s = sealed("probe-ssh");
		mkdirSync(join(s.home, ".ssh"));
		s.seal();
		const v = s.run();
		expect(v.ok).toBe(false);
		expect(!v.ok && v.reason).toContain(`can read ${join(s.home, ".ssh")}`);
	});

	test("refuses a readable .codex/auth.json", () => {
		const s = sealed("probe-codex");
		mkdirSync(join(s.home, ".codex"));
		writeFileSync(join(s.home, ".codex", "auth.json"), "{}");
		s.seal();
		const v = s.run();
		expect(!v.ok && v.reason).toContain(`can read ${join(s.home, ".codex", "auth.json")}`);
	});

	test("refuses a writable ledger dir at an overridden AGENT_SYSTEM_LEDGER_DB", () => {
		const s = sealed("probe-ledger");
		s.seal();
		chmodSync(s.ledgerDir, 0o755);
		const v = s.run();
		expect(!v.ok && v.reason).toContain(`can write ${s.ledgerDir} (ledger directory)`);
	});

	test("refuses a writable runs root", () => {
		const s = sealed("probe-runs");
		s.seal();
		chmodSync(s.runsRoot, 0o755);
		const v = s.run();
		expect(!v.ok && v.reason).toContain(`can write ${s.runsRoot} (runs root)`);
	});

	test("refuses a probe that did not answer, or answered for too few paths", () => {
		const items = preflightProbes({ env: { HOME: "/h" }, runsRoot: "/r", mainCheckout: "/m", lanesRoot: "/l" });
		expect(probeDecision(items, WRAPPER_EXIT.fenced, "")).toMatchObject({ ok: false });
		expect(probeDecision(items, 0, '{"path":"/h","read":false,"write":false}\n')).toMatchObject({ ok: false });
		expect(probeDecision(items, 0, "garbage\n")).toMatchObject({ ok: false });
	});
});

describe("preflight: the install", () => {
	const me = { uid: process.getuid!(), gid: process.getgid!() };
	const ids = { root: me.uid, wheel: me.gid, jo: me.uid };
	const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

	/** A tmp install laid out as setup and the refresh helper leave it, every owner the current user. */
	function install(tag: string) {
		const base = dir(tag);
		const libexec = join(base, "libexec");
		const root = join(base, "root");
		const sudoers = join(base, "sudoers.d", "as2test");
		mkdirSync(libexec);
		mkdirSync(join(libexec, "refresh.d"));
		mkdirSync(join(base, "sudoers.d"));
		for (const d of ["stage", "runs", "locks"]) mkdirSync(join(root, d), { recursive: true });
		const files = { exec: "#!/bin/sh\n", bun: "bun", "test-exec.js": "js", refresh: "#!/bin/sh\n# refresh\n" };
		for (const [f, t] of Object.entries(files)) writeFileSync(join(libexec, f), t);
		writeFileSync(join(root, "locks", "sweep.db"), "");
		writeFileSync(sudoers, "x");
		const input = readFileSync(SCRIPT, "utf8");
		writeFileSync(join(libexec, "SOURCE"), [
			"# test", "version 1", `source ${REPO}`, `source-sha ${"a".repeat(40)}`, "bun-version 1.3.14", `user ${AS2TEST_USER}`, `uid ${me.uid}`, `gid ${me.gid}`, "jo me",
			`jo-uid ${me.uid}`, "created user", "created group", ...Object.entries(files).map(([f, t]) => `file ${f} ${sha(t)}`), `input surface/scripts/test-exec.ts ${sha(input)}`, "",
		].join("\n"));
		for (const l of installLayout({ libexec, root, sudoers })) chmodSync(l.path, l.mode);
		const dscl = (account: { uid: number; gid: number } | null) => (record: string, key: string) =>
			account === null ? null : record.startsWith("/Users/") ? (key === "UniqueID" ? account.uid : account.gid) : account.gid;
		const read = (account: { uid: number; gid: number } | null = me) => readInstall({ checkout: REPO, libexec, root, sudoers, dscl: dscl(account), trustedOwners: [0, me.uid] });
		return { libexec, root, sudoers, read };
	}

	test("passes on an install as setup left it", () => {
		const i = install("inst-ok");
		const v = installDecision(i.read(), ids);
		expect(v).toMatchObject({ ok: true });
		expect(preflightDecision(v, { ok: true, summary: "probe" })).toMatchObject({ ok: true });
	});

	test("refuses a missing account", () => {
		const i = install("inst-acct");
		const v = installDecision(i.read(null), ids);
		expect(!v.ok && v.reason).toContain("account is missing");
		expect(preflightDecision(v, { ok: true, summary: "probe" })).toMatchObject({ ok: false });
	});

	test("refuses a hash mismatch, of an installed file or of a bundle input in the checkout", () => {
		const i = install("inst-hash");
		chmodSync(join(i.libexec, "test-exec.js"), 0o644);
		writeFileSync(join(i.libexec, "test-exec.js"), "tampered");
		chmodSync(join(i.libexec, "test-exec.js"), 0o755);
		const v = installDecision(i.read(), ids);
		expect(!v.ok && v.reason).toContain("installed test-exec.js does not match its sha-256 in SOURCE");

		const j = install("inst-input");
		const src = readFileSync(join(j.libexec, "SOURCE"), "utf8").replace(/^input (\S+) [0-9a-f]+$/m, `input $1 ${"0".repeat(64)}`);
		writeFileSync(join(j.libexec, "SOURCE"), src);
		const w = installDecision(j.read(), ids);
		expect(!w.ok && w.reason).toContain("surface/scripts/test-exec.ts in this checkout differs from the installed test-exec bundle");
	});

	test("refuses a mode mismatch, and an owner mismatch", () => {
		const i = install("inst-mode");
		chmodSync(join(i.root, "locks", "sweep.db"), 0o644);
		const v = installDecision(i.read(), ids);
		expect(!v.ok && v.reason).toContain("has mode 644, expected 600");
		const j = install("inst-mode2");
		chmodSync(join(j.libexec, "exec"), 0o775);
		expect(installDecision(j.read(), ids)).toMatchObject({ ok: false });
		const k = install("inst-owner");
		expect(installDecision(k.read(), { ...ids, root: 0 })).toMatchObject({ ok: false });
	});

	test("T7: installDecision's kinds run install first, then file-drift, then input-drift (PLAN wl-mv718fxhwwcn40 § 1.2)", () => {
		const RERUN = "re-run install/as2test-setup.sh";
		/** The verdict's kind and reason; `ok` when it passed. */
		const decided = (v: { ok: boolean; reason?: string; kind?: unknown }) => (v.ok ? { kind: "ok", reason: "" } : { kind: v.kind, reason: v.reason ?? "" });
		const put = (path: string, text: string) => {
			writeFileSync(path, text);
			chmodSync(path, 0o755);
		};
		const zeroInput = (src: string) => src.replace(/^input (\S+) [0-9a-f]+$/m, `input $1 ${"0".repeat(64)}`);

		// input-drift: a SOURCE input differs in the runner's checkout. The reason no longer says to re-run setup.
		const a = install("t7-input");
		writeFileSync(join(a.libexec, "SOURCE"), zeroInput(readFileSync(join(a.libexec, "SOURCE"), "utf8")));
		const av = decided(installDecision(a.read(), ids));
		expect(av.kind).toBe("input-drift");
		expect(av.reason).toContain("surface/scripts/test-exec.ts in this checkout differs from the installed test-exec bundle");
		expect(av.reason).not.toContain(RERUN);

		// file-drift: test-exec.js off its hash (and that outranks an input drift), exec missing, a symlink, a directory.
		const b = install("t7-tampered");
		put(join(b.libexec, "test-exec.js"), "tampered");
		writeFileSync(join(b.libexec, "SOURCE"), zeroInput(readFileSync(join(b.libexec, "SOURCE"), "utf8")));
		const bv = decided(installDecision(b.read(), ids));
		expect(bv).toEqual({ kind: "file-drift", reason: "installed test-exec.js does not match its sha-256 in SOURCE" });
		const c = install("t7-missing");
		rmSync(join(c.libexec, "exec"));
		expect(decided(installDecision(c.read(), ids))).toEqual({ kind: "file-drift", reason: "installed exec is missing" });
		const d = install("t7-symlink");
		const copy = join(d.libexec, "..", "test-exec.js.copy");
		writeFileSync(copy, "js");
		rmSync(join(d.libexec, "test-exec.js"));
		symlinkSync(copy, join(d.libexec, "test-exec.js"));
		expect(decided(installDecision(d.read(), ids))).toEqual({ kind: "file-drift", reason: "installed test-exec.js is a symlink, not a regular file" });
		const e = install("t7-dir");
		rmSync(join(e.libexec, "exec"));
		mkdirSync(join(e.libexec, "exec"));
		expect(decided(installDecision(e.read(), ids))).toEqual({ kind: "file-drift", reason: "installed exec is a dir, not a regular file" });

		// install: only setup can fix these, so each keeps "re-run install/as2test-setup.sh".
		const installCases: [string, (libexec: string) => void, string][] = [
			["existing exec, wrong mode", (l) => chmodSync(join(l, "exec"), 0o775), "exec has mode 775, expected 755"],
			["bun off its hash", (l) => put(join(l, "bun"), "other bun"), "installed bun does not match its sha-256 in SOURCE"],
			["refresh off its hash", (l) => put(join(l, "refresh"), "#!/bin/sh\n# other\n"), "installed refresh does not match its sha-256 in SOURCE"],
			["refresh missing", (l) => rmSync(join(l, "refresh")), "refresh is missing, expected a file"],
			["refresh.d open to others", (l) => chmodSync(join(l, "refresh.d"), 0o755), "refresh.d has mode 755, expected 700"],
			["legacy SOURCE without file refresh", (l) => writeFileSync(join(l, "SOURCE"), readFileSync(join(l, "SOURCE"), "utf8").replace(/^file refresh .*\n/m, "")), "SOURCE has no file refresh"],
			["SOURCE ids off the account's", (l) => writeFileSync(join(l, "SOURCE"), readFileSync(join(l, "SOURCE"), "utf8").replace(/^uid .*$/m, "uid 4242")), "SOURCE records _as2test 4242"],
			// install outranks file drift: exec missing and bun tampered at once is install.
			["exec missing and bun off its hash", (l) => {
				rmSync(join(l, "exec"));
				put(join(l, "bun"), "other bun");
			}, "installed bun does not match its sha-256 in SOURCE"],
		];
		for (const [name, breakIt, says] of installCases) {
			const i = install(`t7-${name.replace(/[^a-z]+/g, "-")}`);
			breakIt(i.libexec);
			const v = decided(installDecision(i.read(), ids));
			expect({ name, kind: v.kind }).toEqual({ name, kind: "install" });
			expect(v.reason).toContain(says);
			expect(v.reason).toEndWith(`; ${RERUN}`);
		}
		const noAccount = decided(installDecision(install("t7-account").read(null), ids));
		expect(noAccount.kind).toBe("install");
		expect(noAccount.reason).toContain("account is missing");

		// An existing test-exec.js owned by someone else is install, never file-drift.
		const f = install("t7-owner");
		const facts = f.read();
		const at = facts.layout.findIndex((l) => l.path === join(f.libexec, "test-exec.js"));
		expect(at).toBeGreaterThan(0);
		facts.stats[at] = { ...facts.stats[at]!, uid: me.uid + 1 };
		const fv = decided(installDecision(facts, ids));
		expect(fv.kind).toBe("install");
		expect(fv.reason).toContain(`test-exec.js is owned ${me.uid + 1}:${me.gid}, expected ${me.uid}:${me.gid}`);
	});

	test("the layout holds the refresh helper (root, 0755) and refresh.d (root, 0700); SOURCE records four files", () => {
		expect([...as2test.INSTALLED_FILES]).toEqual(["exec", "bun", "test-exec.js", "refresh"]);
		const layout = installLayout({ libexec: "/l", root: "/r", sudoers: "/s" });
		expect(layout).toContainEqual(expect.objectContaining({ path: "/l/refresh", kind: "file", owner: "root", mode: 0o755 }));
		expect(layout).toContainEqual(expect.objectContaining({ path: "/l/refresh.d", kind: "dir", owner: "root", mode: 0o700 }));
	});

	test("F2: a SOURCE that records resources.json holds it as an install item (root, 0644, a regular file of measured costs, its SOURCE hash); otherwise it is install, never file-drift", () => {
		const withPolicy = (tag: string) => {
			const i = install(tag);
			const policy = join(i.libexec, "resources.json");
			writeFileSync(policy, SYNTHETIC_POLICY);
			chmodSync(policy, 0o644);
			writeFileSync(join(i.libexec, "SOURCE"), readFileSync(join(i.libexec, "SOURCE"), "utf8").replace(/^(input .*)$/m, `file resources.json ${sha(SYNTHETIC_POLICY)}\n$1`));
			return { ...i, policy };
		};
		expect(installDecision(withPolicy("f2-ok").read(), ids)).toMatchObject({ ok: true });
		const cases: [string, (policy: string) => void, string][] = [
			["missing", (p) => rmSync(p), "resources.json is missing, expected a file"],
			["group-writable", (p) => chmodSync(p, 0o664), "resources.json has mode 664, expected 644"],
			["a symlink", (p) => { rmSync(p); symlinkSync(join(p, "..", "bun"), p); }, "resources.json is symlink, expected a file"],
			["not measured costs", (p) => writeFileSync(p, "{}"), "is not a measured resource policy"],
			["off its SOURCE hash", (p) => writeFileSync(p, SYNTHETIC_POLICY.replace('"workerCpu":1', '"workerCpu":2')), "installed resources.json does not match its sha-256 in SOURCE"],
			["an ancestor others can write", (p) => chmodSync(join(p, "..", ".."), 0o777), `must be owned by uid 0 or ${me.uid}, physical and not group/world writable`],
		];
		for (const [name, breakIt, says] of cases) {
			const i = withPolicy(`f2-${name.replace(/[^a-z]+/g, "-")}`);
			breakIt(i.policy);
			const v = installDecision(i.read(), ids);
			expect({ name, ok: v.ok, kind: !v.ok && v.kind }).toEqual({ name, ok: false, kind: "install" });
			expect(!v.ok && v.reason).toContain(says);
		}
	});

	test("F2: render-exec, which every refresh helper builds the executor with, refuses an absent or unusable policy and renders nothing", () => {
		const base = dir("f2-render");
		const libexec = join(base, "libexec");
		mkdirSync(libexec);
		const policy = join(libexec, "resources.json");
		const render = () => {
			const r = Bun.spawnSync([BUN, "surface/src/as2test.ts", "render-exec", "--root", join(base, "root"), "--bun", join(libexec, "bun"), "--script", join(libexec, "test-exec.js"), "--sweep-scope", "uid"], {
				cwd: REPO, stdout: "pipe", stderr: "pipe",
			});
			return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
		};
		const refused = "render-exec: refusing to render an executor that cannot admit a test part";
		const cases: [string, () => void, string][] = [
			["missing", () => {}, `${policy} is missing`],
			["a symlink", () => { writeFileSync(join(base, "elsewhere.json"), SYNTHETIC_POLICY); symlinkSync(join(base, "elsewhere.json"), policy); }, `${policy} is a symlink`],
			["group-writable", () => { writeFileSync(policy, SYNTHETIC_POLICY); chmodSync(policy, 0o664); }, `${policy} is group- or world-writable (mode 664)`],
			["not JSON", () => { writeFileSync(policy, "not json"); chmodSync(policy, 0o644); }, `${policy} is not a measured resource policy`],
			["no calibration receipt", () => { writeFileSync(policy, JSON.stringify({ workerCpu: 1, workerMemoryBytes: 1, reserveCpu: 0, reserveMemoryBytes: 0, calibration: "" })); chmodSync(policy, 0o644); }, "needs a measurement receipt"],
		];
		for (const [name, make, says] of cases) {
			rmSync(policy, { force: true });
			make();
			const out = render();
			expect({ name, exit: out.exit, stdout: out.stdout }).toEqual({ name, exit: 1, stdout: "" });
			expect(out.stderr).toContain(refused);
			expect(out.stderr).toContain(says);
		}
		rmSync(policy, { force: true });
		writeFileSync(policy, SYNTHETIC_POLICY);
		chmodSync(policy, 0o644);
		const ok = render();
		expect({ exit: ok.exit, stderr: ok.stderr }).toEqual({ exit: 0, stderr: "" });
		expect(ok.stdout).toBe(renderExecWrapper({ root: join(base, "root"), bun: join(libexec, "bun"), script: join(libexec, "test-exec.js"), sweepScope: "uid" }));
	});

	test("SOURCE parses strictly", () => {
		expect(parseSource("version 1\n")).toMatchObject({ ok: false });
		expect(parseSource("version 2\n")).toMatchObject({ ok: false });
		expect(parseSource("version 1\nbogus x\n")).toMatchObject({ ok: false });
		expect(parseSource("version 1\ncreated relative/path\n")).toMatchObject({ ok: false });
	});
});

// ---- the bundle ----------------------------------------------------------------------------------------------

describe("the installed form", () => {
	test("test-exec bundles into one file with bun build --target=bun, and the bundle runs behind the wrapper", () => {
		const out = dir("bundle");
		const r = Bun.spawnSync([BUN, "build", "--target=bun", `--outfile=${join(out, "test-exec.js")}`, `--metafile=${join(out, "meta.json")}`, "surface/scripts/test-exec.ts"], {
			cwd: REPO, stdout: "pipe", stderr: "pipe",
		});
		expect(r.exitCode).toBe(0);
		const inputs = Bun.spawnSync([BUN, "surface/src/as2test.ts", "bundle-inputs", join(out, "meta.json"), REPO], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		expect(inputs.exitCode).toBe(0);
		const list = inputs.stdout.toString().trim().split("\n");
		expect(list).toContain("surface/scripts/test-exec.ts");
		expect(list).toContain("surface/src/test-run.ts");
		const b = box("bundled", { script: join(out, "test-exec.js") });
		setCurrent(b, "tr-b1");
		const p = call(b, { sub: "probe", runId: "tr-b1", paths: [join(out, "nope")] });
		expect(p.exit).toBe(WRAPPER_EXIT.probeReachable);
		expect(JSON.parse(p.stdout.trim())).toEqual({ path: join(out, "nope"), read: false, write: true });
	});
});

// ---- the refresh helper (PLAN wl-mv718fxhwwcn40 § 1.1; § 2 T5, T5b, T6) --------------------------------------

describe("the refresh helper", () => {
	const me = { uid: process.getuid!(), gid: process.getgid!() };
	const ids = { root: me.uid, wheel: me.gid, jo: me.uid };
	const sha256 = (b: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
	const fakeDscl = (record: string, key: string) => (record.startsWith("/Users/") && key === "UniqueID" ? me.uid : me.gid);
	const AS2 = "surface/src/as2test.ts";
	const TEST_EXEC = "surface/scripts/test-exec.ts";
	/** A test-exec input the fixture branches change. */
	const INPUT = "surface/src/test-run.ts";

	/** What a fixture origin holds: every file test-exec.ts and as2test.ts import, from this checkout's working tree. */
	let sources: Map<string, string> | null = null;
	function fixtureSources(): Map<string, string> {
		if (sources) return sources;
		const out = dir("refresh-meta");
		const rels = new Set<string>();
		for (const entry of [TEST_EXEC, AS2]) {
			const meta = join(out, `${basename(entry)}.meta.json`);
			const r = Bun.spawnSync([BUN, "build", "--target=bun", `--outfile=${join(out, `${basename(entry)}.js`)}`, `--metafile=${meta}`, entry], {
				cwd: REPO, stdout: "pipe", stderr: "pipe",
			});
			if (r.exitCode !== 0) throw new Error(`bun build ${entry}: ${r.stderr.toString()}`);
			for (const rel of bundleInputs(readFileSync(meta, "utf8"), REPO, REPO)) rels.add(rel);
		}
		sources = new Map([...rels].sort().map((rel) => [rel, readFileSync(join(REPO, rel), "utf8")]));
		return sources;
	}

	interface FixtureOrigin {
		/** A working clone on main, its remote `origin` the bare repo. */
		work: string;
		/** The local bare origin the helper fetches the as2-verified tag from; its main and the tag start at one commit. */
		bare: string;
		/**
		 * Commit these files on top of main and force-push them as main; unless `verify` is false, also force-push the
		 * as2-verified tag there, as the runner does after a green believable main run. Returns the new sha.
		 */
		commit: (files: Record<string, string>, message: string, verify?: boolean) => string;
		/** Force-push the as2-verified tag at `sha`, lightweight or annotated. */
		verify: (sha: string, o?: { annotated?: boolean }) => void;
	}
	function fixtureOrigin(tag: string): FixtureOrigin {
		const base = dir(`${tag}-origin`);
		const work = join(base, "work");
		for (const [rel, text] of fixtureSources()) {
			mkdirSync(dirname(join(work, rel)), { recursive: true });
			writeFileSync(join(work, rel), text);
		}
		git(work, "init", "-q", "-b", "main");
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", "main");
		git(work, "tag", VERIFIED_TAG);
		const bare = join(base, "origin.git");
		git(base, "clone", "-q", "--bare", work, bare);
		git(work, "remote", "add", "origin", bare);
		const verify = (sha: string, o: { annotated?: boolean } = {}): void => {
			git(work, "tag", "-f", ...(o.annotated ? ["-a", "-m", "verified"] : []), VERIFIED_TAG, sha);
			git(work, "push", "-q", "-f", "origin", `refs/tags/${VERIFIED_TAG}`);
		};
		const commit = (files: Record<string, string>, message: string, verified = true): string => {
			for (const [rel, text] of Object.entries(files)) writeFileSync(join(work, rel), text);
			git(work, "add", "-A");
			git(work, "commit", "-q", "-m", message);
			git(work, "push", "-q", "-f", "origin", "HEAD:refs/heads/main");
			const sha = git(work, "rev-parse", "HEAD");
			if (verified) verify(sha);
			return sha;
		};
		return { work, bare, commit, verify };
	}

	/** The bytes of `<sha>:<rel>` in a repo. */
	function blobAt(repo: string, sha: string, rel: string): Uint8Array {
		const r = Bun.spawnSync(["git", "--git-dir", repo, "cat-file", "blob", `${sha}:${rel}`], {
			env: { PATH: SYS_PATH, HOME: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe",
		});
		if (r.exitCode !== 0) throw new Error(`git cat-file ${sha}:${rel}: ${r.stderr.toString()}`);
		return r.stdout;
	}

	/** Every path under `root` but `skip`: a dir, or a regular file's mtime and sha-256, or `other`. */
	function tree(root: string, skip: string[] = []): Record<string, string> {
		const out: Record<string, string> = {};
		const walk = (p: string) => {
			for (const n of readdirSync(p).sort()) {
				const abs = join(p, n);
				const rel = abs.slice(root.length + 1);
				if (skip.includes(rel)) continue;
				const st = lstatSync(abs);
				if (st.isDirectory()) {
					out[rel] = "dir";
					walk(abs);
				} else out[rel] = st.isFile() ? `${st.mtimeMs} ${sha256(readFileSync(abs))}` : "other";
			}
		};
		walk(root);
		return out;
	}
	/**
	 * The build dir the rig's last run left: the one that run named in refresh.d/stage/build (its $MADE, mktemp's output),
	 * when that dir is still there. Every helper on the host makes its dirs in the shared /private/tmp, so a scan of
	 * as2test-refresh.* there also sees other runs' dirs (tr-0mvs4as6e1nc6g0's T5 saw as2test-refresh.91mYTX).
	 */
	const leftBuilds = (r: { state: string }): string[] => {
		const made = join(r.state, "stage", "build");
		if (!existsSync(made)) return [];
		const d = readFileSync(made, "utf8").trim();
		return d !== "" && existsSync(d) ? [d] : [];
	};

	interface HelperRig {
		base: string;
		libexec: string;
		root: string;
		state: string;
		facts: Record<string, unknown>;
		/** The test render's options, with overrides. */
		options: (o?: Record<string, unknown>) => Record<string, unknown>;
		/** Render with these overrides into `<libexec>/refresh`. */
		place: (o?: Record<string, unknown>) => void;
		run: (args?: string[], o?: { env?: Record<string, string>; cwd?: string }) => Ran;
		spawn: () => Promise<Ran>;
		/** installDecision over this install, with the test ids, for the runner's checkout `checkout`. */
		decide: (checkout: string) => InstallVerdict;
	}
	/**
	 * A tmp install as setup leaves it before the helper's first run: bun, refresh, refresh.d, the measured resources.json
	 * (synthetic costs, 0644) and the root; no exec, test-exec.js or SOURCE.
	 */
	function helperRig(tag: string, from: FixtureOrigin | null): HelperRig {
		const render = newExport<RenderRefresh>("renderRefreshHelper");
		const base = dir(tag);
		const libexec = join(base, "libexec");
		const root = join(base, "root");
		const sudoers = join(base, "sudoers.d", "as2test");
		const state = join(libexec, "refresh.d");
		mkdirSync(state, { recursive: true });
		mkdirSync(dirname(sudoers));
		for (const d of ["stage", "runs", "locks"]) mkdirSync(join(root, d), { recursive: true });
		writeFileSync(join(root, "locks", "sweep.db"), "");
		writeFileSync(sudoers, "x");
		writeFileSync(join(libexec, "bun"), "stand-in for the installed bun\n");
		writeFileSync(join(libexec, "resources.json"), SYNTHETIC_POLICY);
		chmodSync(join(libexec, "resources.json"), 0o644);
		const facts = { bunVersion: Bun.version, user: AS2TEST_USER, uid: me.uid, gid: me.gid, jo: userInfo().username, joUid: me.uid, created: ["user", "group", libexec, root, sudoers] };
		const options = (o: Record<string, unknown> = {}) => ({
			origin: from?.bare ?? join(base, "no-origin.git"), libexec, root, bun: BUN, facts, buildUser: null, asRoot: false, allowFileProtocol: true, ...o,
		});
		const place = (o: Record<string, unknown> = {}) => {
			writeFileSync(join(libexec, "refresh"), render(options(o)));
			chmodSync(join(libexec, "refresh"), 0o755);
		};
		place();
		for (const l of installLayout({ libexec, root, sudoers })) if (existsSync(l.path)) chmodSync(l.path, l.mode);
		const run = (args: string[] = [], o: { env?: Record<string, string>; cwd?: string } = {}): Ran => {
			const r = Bun.spawnSync([join(libexec, "refresh"), ...args], { env: o.env ?? { PATH: SYS_PATH }, cwd: o.cwd ?? base, stdout: "pipe", stderr: "pipe" });
			return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
		};
		const spawn = async (): Promise<Ran> => {
			const p = Bun.spawn([join(libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: base, stdout: "pipe", stderr: "pipe" });
			own(p.pid);
			const [exit, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
			return { exit, stdout, stderr };
		};
		const decide = (checkout: string) => installDecision(readInstall({ checkout, libexec, root, sudoers, dscl: fakeDscl, trustedOwners: [0, me.uid] }), ids);
		return { base, libexec, root, state, facts, options, place, run, spawn, decide };
	}
	const sourceOf = (libexec: string) => {
		const s = parseSource(readFileSync(join(libexec, "SOURCE"), "utf8"));
		if (!s.ok) throw new Error(s.error);
		return s.source;
	};
	const sha12 = (sha: string) => sha.slice(0, 12);

	test("T5: it builds the as2-verified tag's commit, never the caller's checkout, branch, env or git, and installDecision accepts the result", () => {
		const o = fixtureOrigin("t5");
		const mainSha = git(o.work, "rev-parse", "HEAD");
		// feature differs from main in a test-exec input; a bare repo whose main and as2-verified are feature is where a redirect would lead.
		expect(fixtureSources().has(INPUT)).toBe(true);
		git(o.work, "checkout", "-q", "-b", "feature");
		writeFileSync(join(o.work, INPUT), `${fixtureSources().get(INPUT)}// feature only\n`);
		git(o.work, "commit", "-q", "-am", "feature");
		git(o.work, "push", "-q", "origin", "feature");
		const featureBare = join(o.work, "..", "feature.git");
		git(o.work, "clone", "-q", "--bare", o.bare, featureBare);
		git(featureBare, "update-ref", "refs/heads/main", "refs/heads/feature");
		git(featureBare, "update-ref", `refs/tags/${VERIFIED_TAG}`, "refs/heads/feature");

		const r = helperRig("t5", o);
		const hostileBin = join(r.base, "hostile-bin");
		const hostileHome = join(r.base, "hostile-home");
		const marker = join(r.base, "hostile-called");
		mkdirSync(hostileBin);
		mkdirSync(hostileHome);
		for (const tool of ["git", "bun", "shasum", "tar", "sudo", "install", "mv", "cat", "awk"]) {
			writeFileSync(join(hostileBin, tool), `#!/bin/sh\necho "${tool} $*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
		}
		writeFileSync(join(hostileHome, ".gitconfig"), `[url "${featureBare}"]\n\tinsteadOf = ${o.bare}\n`);
		// git's own exec path, with a git-fetch, git-upload-pack and git-remote-* that would mark the run and serve nothing.
		const hostileExec = join(r.base, "hostile-exec");
		mkdirSync(hostileExec);
		for (const tool of ["git-fetch", "git-upload-pack", "git-remote-file", "git-remote-https", "git-remote-http", "git-index-pack", "git-archive", "git-cat-file", "git-rev-parse"]) {
			writeFileSync(join(hostileExec, tool), `#!/bin/sh\necho "${tool} $*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
		}
		const out = r.run([], {
			cwd: o.work,
			env: {
				PATH: `${hostileBin}:${SYS_PATH}`, HOME: hostileHome, PWD: o.work, GIT_DIR: join(o.work, ".git"), GIT_WORK_TREE: o.work, GIT_CONFIG_GLOBAL: join(hostileHome, ".gitconfig"),
				GIT_CONFIG_PARAMETERS: `'url.${featureBare}.insteadof'='${o.bare}'`, TMPDIR: hostileHome,
				// The old re-exec guard's own marker, git's exec path, and a shell function the helper's sh would import
				// and run in place of the printf builtin: none may survive the scrub.
				AS2TEST_REFRESH_ENV: "clean", GIT_EXEC_PATH: hostileExec,
				"BASH_FUNC_printf%%": `() { echo "printf $*" >> '${marker}'; builtin printf "$@"; }`,
			},
		});
		expect({ exit: out.exit, stdout: out.stdout, stderr: out.exit === 0 ? "" : out.stderr }).toEqual({ exit: 0, stdout: `refreshed none..${sha12(mainSha)}\n`, stderr: "" });
		expect(existsSync(marker)).toBe(false);

		const src = sourceOf(r.libexec);
		expect(src.sourceSha).toBe(mainSha);
		expect(src.source).toBe(o.bare);
		expect(Object.keys(src.inputs)).toContain(INPUT);
		expect(Object.keys(src.inputs)).toContain(TEST_EXEC);
		for (const [rel, h] of Object.entries(src.inputs)) expect({ rel, h }).toEqual({ rel, h: sha256(blobAt(o.bare, mainSha, rel)) });
		const installed = Object.fromEntries(["exec", "bun", "test-exec.js", "refresh", "resources.json"].map((f) => [f, sha256(readFileSync(join(r.libexec, f)))]));
		expect(src.files).toEqual(installed);
		expect(readFileSync(join(r.libexec, "exec"), "utf8")).toBe(
			renderExecWrapper({ root: r.root, bun: join(r.libexec, "bun"), script: join(r.libexec, "test-exec.js"), sweepScope: "uid" }),
		);
		expect(statSync(join(r.libexec, "test-exec.js")).size).toBeGreaterThan(0);
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		expect(leftBuilds(r)).toEqual([]);

		// The runner's checkout at main passes; the same checkout on feature is input drift on the file feature changed.
		git(o.work, "checkout", "-q", "main");
		expect(r.decide(o.work)).toMatchObject({ ok: true });
		git(o.work, "checkout", "-q", "feature");
		expect(r.decide(o.work)).toEqual({ ok: false, kind: "input-drift", reason: `${INPUT} in this checkout differs from the installed test-exec bundle` });
	}, 120_000);

	test("T5b: a legacy install (today's setup SOURCE: three file lines, a path in source) at main's sha, with the measured policy in place, is rebuilt, and the new installDecision accepts it", () => {
		const o = fixtureOrigin("t5b");
		const mainSha = git(o.work, "rev-parse", "HEAD");
		const r = helperRig("t5b", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		const built = sourceOf(r.libexec);
		const h = (f: string) => sha256(readFileSync(join(r.libexec, f)));
		// The SOURCE install/as2test-setup.sh writes today, at main's sha, over matching exec and test-exec.js.
		const legacy = [
			"# as2test SOURCE: written by install/as2test-setup.sh, read by the runner's preflight (surface/src/as2test.ts parseSource) and by --undo",
			"version 1", `source ${o.work}`, `source-sha ${mainSha}`, `bun-version ${Bun.version}`, `user ${AS2TEST_USER}`, `uid ${me.uid}`, `gid ${me.gid}`,
			`jo ${userInfo().username}`, `jo-uid ${me.uid}`, ...(r.facts.created as string[]).map((c) => `created ${c}`),
			...["exec", "bun", "test-exec.js"].map((f) => `file ${f} ${h(f)}`), ...Object.entries(built.inputs).map(([rel, s]) => `input ${rel} ${s}`), "",
		].join("\n");
		writeFileSync(join(r.libexec, "SOURCE"), legacy);
		expect(r.decide(o.work)).toMatchObject({ ok: false, kind: "install", reason: "SOURCE has no file refresh; re-run install/as2test-setup.sh" });

		const out = r.run();
		expect({ exit: out.exit, stdout: out.stdout }).toEqual({ exit: 0, stdout: `refreshed ${sha12(mainSha)}..${sha12(mainSha)}\n` });
		const src = sourceOf(r.libexec);
		expect(src.sourceSha).toBe(mainSha);
		expect(src.source).toBe(o.bare);
		expect(src.files.refresh).toBe(h("refresh"));
		expect(src.files["resources.json"]).toBe(h("resources.json"));
		expect(src.inputs).toEqual(built.inputs);
		expect(r.decide(o.work)).toMatchObject({ ok: true });
		expect(r.run()).toMatchObject({ exit: 0, stdout: `current ${sha12(mainSha)}\n` });
	}, 120_000);

	test("F2: a legacy install refresh without a usable measured policy (missing, invalid, group-writable, a symlink) exits 71 naming it and leaves the install byte for byte unchanged, under this helper and under one rendered before the check", () => {
		const o = fixtureOrigin("f2-legacy");
		const mainSha = git(o.work, "rev-parse", "HEAD");
		const r = helperRig("f2-legacy", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		const built = sourceOf(r.libexec);
		const h = (f: string) => sha256(readFileSync(join(r.libexec, f)));
		// The legacy SOURCE (setup's, before the helper and the policy existed) over a working exec and test-exec.js.
		writeFileSync(join(r.libexec, "SOURCE"), [
			"version 1", `source ${o.work}`, `source-sha ${mainSha}`, `bun-version ${Bun.version}`, `user ${AS2TEST_USER}`, `uid ${me.uid}`, `gid ${me.gid}`,
			`jo ${userInfo().username}`, `jo-uid ${me.uid}`, ...(r.facts.created as string[]).map((c) => `created ${c}`),
			...["exec", "bun", "test-exec.js"].map((f) => `file ${f} ${h(f)}`), ...Object.entries(built.inputs).map(([rel, s]) => `input ${rel} ${s}`), "",
		].join("\n"));
		const policy = join(r.libexec, "resources.json");
		const valid = join(r.base, "valid-policy.json");
		writeFileSync(valid, SYNTHETIC_POLICY);
		const cases: [string, () => void, string][] = [
			["missing", () => {}, "resources.json, the measured resource policy the executor requires, is missing"],
			["group-writable", () => { writeFileSync(policy, SYNTHETIC_POLICY); chmodSync(policy, 0o664); }, "or group- or world-writable; nothing was fetched or installed"],
			["a symlink", () => symlinkSync(valid, policy), "not a regular file owned by"],
			["not measured costs", () => { writeFileSync(policy, "{}"); chmodSync(policy, 0o644); }, "render-exec: refusing to render an executor that cannot admit a test part"],
		];
		const checkRefusal = (helper: string) => {
			for (const [name, make, why] of cases) {
				rmSync(policy, { force: true });
				make();
				const before = tree(r.libexec, ["refresh.d"]);
				const out = r.run();
				expect({ helper, name, exit: out.exit, stdout: out.stdout }).toEqual({ helper, name, exit: 71, stdout: "" });
				expect(out.stderr).toContain(why);
				// The runner keeps only the helper's last stderr line, so that line must name the refusal (review r2 R3).
				if (name === "not measured costs") expect(out.stderr.trim().split("\n").at(-1)).toMatch(/render-exec at [0-9a-f]+ failed \(exit \d+\): .*is not a measured resource policy/);
				expect(tree(r.libexec, ["refresh.d"])).toEqual(before);
				expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
				expect(leftBuilds(r)).toEqual([]);
			}
		};
		checkRefusal("this helper");
		// A helper rendered before the check (its text without the policy gate) builds the fetched commit's render-exec, which refuses.
		const gated = readFileSync(join(r.libexec, "refresh"), "utf8");
		const old = gated.split("\n").filter((l) => !l.includes("$STAGE/policy")).join("\n");
		expect(old).not.toBe(gated);
		writeFileSync(join(r.libexec, "refresh"), old);
		cases.splice(0, cases.length, ...cases.map(([n, m]): [string, () => void, string] => [n, m, "render-exec: refusing to render an executor that cannot admit a test part"]));
		checkRefusal("a pre-F2 helper");
		// Provisioned, the same legacy install is rebuilt.
		rmSync(policy, { force: true });
		writeFileSync(policy, SYNTHETIC_POLICY);
		chmodSync(policy, 0o644);
		expect(r.run()).toMatchObject({ exit: 0, stdout: `refreshed ${sha12(mainSha)}..${sha12(mainSha)}\n` });
		expect(sourceOf(r.libexec).files["resources.json"]).toBe(h("resources.json"));
	}, 240_000);

	test("R10 (PLAN wl-mvq4edbaf13vnk § 2 The bundle): it builds the as2-verified tag's commit, never main: main moving alone is current, a re-pointed tag (annotated or back to an older commit) rebuilds at its commit, and a tag gone from the origin exits 70 naming it, install unchanged", () => {
		expect(loose.AS2_VERIFIED_TAG).toBe(VERIFIED_TAG);
		const o = fixtureOrigin("r10");
		const verified = git(o.work, "rev-parse", "HEAD");
		const r = helperRig("r10", o);
		expect(r.run()).toMatchObject({ exit: 0, stdout: `refreshed none..${sha12(verified)}\n` });

		// main lands a change the runner has not verified: the helper still answers for the tag's commit.
		const ahead = o.commit({ [INPUT]: `${fixtureSources().get(INPUT)}// landed, not yet verified\n` }, "main moves past the tag", false);
		expect(git(o.bare, "rev-parse", "refs/heads/main")).toBe(ahead);
		expect(r.run()).toMatchObject({ exit: 0, stdout: `current ${sha12(verified)}\n` });
		expect(sourceOf(r.libexec).sourceSha).toBe(verified);
		expect(sourceOf(r.libexec).inputs[INPUT]).toBe(sha256(blobAt(o.bare, verified, INPUT)));

		// The runner verifies main and points an annotated tag at it: the helper builds the commit the tag peels to.
		o.verify(ahead, { annotated: true });
		expect(git(o.bare, "rev-parse", `refs/tags/${VERIFIED_TAG}`)).not.toBe(ahead);
		expect(r.run()).toMatchObject({ exit: 0, stdout: `refreshed ${sha12(verified)}..${sha12(ahead)}\n` });
		expect(sourceOf(r.libexec).sourceSha).toBe(ahead);
		expect(sourceOf(r.libexec).inputs[INPUT]).toBe(sha256(blobAt(o.bare, ahead, INPUT)));
		expect(r.decide(o.work)).toMatchObject({ ok: true });

		// A rollback re-points the tag at the older commit: the forced fetch follows it back.
		o.verify(verified);
		expect(r.run()).toMatchObject({ exit: 0, stdout: `refreshed ${sha12(ahead)}..${sha12(verified)}\n` });
		expect(sourceOf(r.libexec).sourceSha).toBe(verified);

		// The tag deleted at the origin: the fetch fails loudly (exit 70, naming the tag and origin); the mirror's old copy is never used.
		git(o.work, "push", "-q", "origin", `:refs/tags/${VERIFIED_TAG}`);
		const before = tree(r.libexec, ["refresh.d"]);
		const gone = r.run();
		expect(gone.exit).toBe(70);
		expect(gone.stdout).toBe("");
		expect(gone.stderr).toContain(`as2test-refresh: fetching the ${VERIFIED_TAG} tag from ${o.bare} failed`);
		expect(tree(r.libexec, ["refresh.d"])).toEqual(before);
	}, 180_000);

	test("T6: an argument gets 64 and an asRoot render run as non-root gets 77, and neither changes anything", () => {
		const r = helperRig("t6-refuse", null);
		const before = tree(r.libexec);
		for (const args of [["x"], ["--help"], [""], ["a", "b"]]) {
			const out = r.run(args);
			expect({ args, exit: out.exit, stdout: out.stdout }).toEqual({ args, exit: 64, stdout: "" });
			expect(out.stderr).toContain("it takes no arguments");
		}
		expect(tree(r.libexec)).toEqual(before);

		const origin = loose.AS2TEST_ORIGIN;
		expect(origin).toBe("https://github.com/thewolff/agent-system-2.0.git");
		r.place({ origin, asRoot: true, buildUser: "nobody", allowFileProtocol: false });
		const asRoot = tree(r.libexec);
		const out = r.run();
		expect({ exit: out.exit, stdout: out.stdout }).toEqual({ exit: 77, stdout: "" });
		expect(out.stderr).toContain("must run as root");
		expect(tree(r.libexec)).toEqual(asRoot);
	});

	test("T6: a held lock gets 69 with lockWaitS 1, before any fetch", async () => {
		const r = helperRig("t6-lock", null);
		r.place({ lockWaitS: 1 });
		const held = join(r.base, "held");
		const holder = Bun.spawn(["/usr/bin/lockf", "-k", join(r.state, "lock"), "/bin/sh", "-c", `: > '${held}'; exec /bin/sleep 20`], { stdout: "ignore", stderr: "ignore" });
		own(holder.pid);
		await appeared(held, "the lock holder's held file", holder);
		const t0 = Date.now();
		const out = r.run();
		expect({ exit: out.exit, stdout: out.stdout }).toEqual({ exit: 69, stdout: "" });
		expect(out.stderr).toContain("another refresh holds");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
		expect(existsSync(join(r.state, "mirror.git"))).toBe(false);
		holder.kill("SIGKILL");
		await holder.exited;
	}, 30_000);

	test("T6: a second run is current and rebuilds nothing; a moved main rebuilds; two concurrent runs serialise", async () => {
		const o = fixtureOrigin("t6-runs");
		const r = helperRig("t6-runs", o);
		const first = git(o.work, "rev-parse", "HEAD");
		expect(r.run()).toMatchObject({ exit: 0, stdout: `refreshed none..${sha12(first)}\n` });
		const installed = tree(r.libexec, ["refresh.d"]);
		expect(r.run()).toMatchObject({ exit: 0, stdout: `current ${sha12(first)}\n` });
		expect(tree(r.libexec, ["refresh.d"])).toEqual(installed);

		const second = o.commit({ [INPUT]: `${fixtureSources().get(INPUT)}// main moved\n` }, "main moves");
		expect(r.run()).toMatchObject({ exit: 0, stdout: `refreshed ${sha12(first)}..${sha12(second)}\n` });
		expect(sourceOf(r.libexec).sourceSha).toBe(second);
		expect(sourceOf(r.libexec).inputs[INPUT]).toBe(sha256(blobAt(o.bare, second, INPUT)));
		expect(r.decide(o.work)).toMatchObject({ ok: true });

		const third = o.commit({ [INPUT]: `${fixtureSources().get(INPUT)}// main moved again\n` }, "main moves again");
		const both = await Promise.all([r.spawn(), r.spawn()]);
		expect(both.map((b) => b.exit)).toEqual([0, 0]);
		expect(both.map((b) => b.stdout).sort()).toEqual([`current ${sha12(third)}\n`, `refreshed ${sha12(second)}..${sha12(third)}\n`]);
		expect(sourceOf(r.libexec).sourceSha).toBe(third);
		expect(r.decide(o.work)).toMatchObject({ ok: true });
	}, 180_000);

	test("T6: a main that does not compile, a symlinked output, and bad bundle-inputs paths get 71, with the install unchanged", () => {
		const o = fixtureOrigin("t6-bad");
		const r = helperRig("t6-bad", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		const installed = tree(r.libexec, ["refresh.d"]);
		const original = fixtureSources();
		const refused = (says: string) => {
			const out = r.run();
			expect({ says, exit: out.exit, stdout: out.stdout }).toEqual({ says, exit: 71, stdout: "" });
			expect(out.stderr).toContain(says);
			expect(tree(r.libexec, ["refresh.d"])).toEqual(installed);
		};

		o.commit({ [TEST_EXEC]: "export const broken = ;\n" }, "does not compile");
		refused("bun build of surface/scripts/test-exec.ts");

		// bundle-inputs (run as the build user) swaps the built test-exec.js for a symlink to a file the build user cannot read.
		const secretText = `SECRET-${randomUUID()}`;
		const secret = join(r.base, "secret");
		writeFileSync(secret, secretText);
		chmodSync(secret, 0o000);
		const swap = [
			'import { rmSync as __rm, symlinkSync as __ln } from "node:fs";',
			'if (process.argv[2] === "bundle-inputs") {',
			'\tconst out = process.argv[3]!.slice(0, process.argv[3]!.lastIndexOf("/"));',
			'\t__rm(out + "/test-exec.js");',
			`\t__ln(${JSON.stringify(secret)}, out + "/test-exec.js");`,
			"}",
			"",
		].join("\n");
		o.commit({ [TEST_EXEC]: original.get(TEST_EXEC)!, [AS2]: swap + original.get(AS2)! }, "swap the output");
		refused("cannot read the built test-exec.js");
		const everything = (p: string): string[] =>
			readdirSync(p).flatMap((n) => {
				const abs = join(p, n);
				const st = lstatSync(abs);
				return st.isDirectory() ? everything(abs) : st.isFile() ? [readFileSync(abs, "latin1")] : [];
			});
		expect(everything(r.libexec).filter((t) => t.includes(secretText))).toEqual([]);

		// bundle-inputs lists a path outside the checkout, an absolute path, a missing path, and a tree.
		const listing = (lines: string) => `import { writeSync as __w } from "node:fs";\nif (process.argv[2] === "bundle-inputs") { __w(1, ${JSON.stringify(lines)}); process.exit(0); }\n`;
		for (const [lines, says] of [
			["../x\n", "not a plain relative path"],
			[`${TEST_EXEC}\n../x\n`, "not a plain relative path"],
			["/etc/passwd\n", "not a plain relative path"],
			["surface/nope.ts\n", "surface/nope.ts, which is not a file at"],
			["surface\n", "surface, which is not a file at"],
		] as const) {
			o.commit({ [AS2]: listing(lines) + original.get(AS2)! }, `bundle-inputs lists ${lines}`);
			refused(says);
		}
	}, 240_000);

	test("T6: a TERM mid-build, and the helper's own cap, end the build step's process tree and exit 71 within seconds, with no .new file, no build dir and the install unchanged", async () => {
		const o = fixtureOrigin("t6-signal");
		const r = helperRig("t6-signal", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		// main's bundle-inputs (run by the helper as the build user) records its pid, then sleeps with TERM ignored: only a KILL ends it.
		const started = join(r.base, "bundle-inputs.pid");
		const hang = [
			'import { renameSync as __rn, writeFileSync as __wf } from "node:fs";',
			'if (process.argv[2] === "bundle-inputs") {',
			'\tprocess.on("SIGTERM", () => {});',
			`\t__wf(${JSON.stringify(`${started}.tmp`)}, String(process.pid));`,
			`\t__rn(${JSON.stringify(`${started}.tmp`)}, ${JSON.stringify(started)});`,
			"\tBun.sleepSync(120_000);",
			"}",
			"",
		].join("\n");
		o.commit({ [AS2]: hang + fixtureSources().get(AS2)! }, "a bundle-inputs that hangs");
		const children: number[] = [];

		// A TERM to the helper: Jo's own signal to its own process, as a test render runs.
		const installed = tree(r.libexec, ["refresh.d"]);
		const p = Bun.spawn([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		own(p.pid);
		// The pid file is renamed in whole, so it exists only with its pid in it.
		await appeared(started, "bundle-inputs' pid file", p);
		children.push(Number(readFileSync(started, "utf8")));
		own(children[0]!);
		const t0 = Date.now();
		process.kill(p.pid, "SIGTERM");
		const [exit, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
		expect({ exit, stdout }).toEqual({ exit: 71, stdout: "" });
		expect(stderr).toContain("as2test-refresh: ended by a signal; nothing was installed");
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		expect(leftBuilds(r)).toEqual([]);
		expect(tree(r.libexec, ["refresh.d"])).toEqual(installed);

		// The helper's own cap, with no signal from outside.
		rmSync(started, { force: true });
		r.place({ capS: 2 });
		const placed = tree(r.libexec, ["refresh.d"]);
		const t1 = Date.now();
		const capped = r.run();
		expect({ exit: capped.exit, stdout: capped.stdout }).toEqual({ exit: 71, stdout: "" });
		expect(capped.stderr).toContain("as2test-refresh: stopped at its own 2 s cap; nothing was installed");
		expect(Date.now() - t1).toBeLessThan(15_000);
		if (existsSync(started)) children.push(Number(readFileSync(started, "utf8")));
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		expect(leftBuilds(r)).toEqual([]);
		expect(tree(r.libexec, ["refresh.d"])).toEqual(placed);

		// The TERM-proof bundle-inputs of each run is gone.
		await exited(...children);
	}, 240_000);

	// TOOLS-REVIEW r3 minor 2: render-exec's stderr is streamed, not only captured, so a stop mid-render-exec loses none of it.
	test("F2: render-exec's stderr reaches the refresh helper's stderr as it is written, and a TERM or the cap's ALRM mid-render-exec loses none of it", async () => {
		const o = fixtureOrigin("f2-live");
		const r = helperRig("f2-live", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		const started = join(r.base, "render-exec.pid");
		const said = "render-exec probe: written before render-exec stalls";
		// main's render-exec writes one stderr line, records its pid, then blocks on a wait nothing ends: only the helper's stop ends it.
		const stall = [
			'import { renameSync as __rn, writeFileSync as __wf } from "node:fs";',
			'if (process.argv[2] === "render-exec") {',
			`\tprocess.stderr.write(${JSON.stringify(`${said}\n`)});`,
			`\t__wf(${JSON.stringify(`${started}.tmp`)}, String(process.pid));`,
			`\t__rn(${JSON.stringify(`${started}.tmp`)}, ${JSON.stringify(started)});`,
			"\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
			"}",
			"",
		].join("\n");
		o.commit({ [AS2]: stall + fixtureSources().get(AS2)! }, "a render-exec that stalls after one stderr line");
		const installed = tree(r.libexec, ["refresh.d"]);
		const children: number[] = [];
		// SIGALRM is what the helper's cap watchdog sends it: sending it here takes the cap's path without waiting out a cap.
		for (const [signal, says] of [["SIGTERM", "as2test-refresh: ended by a signal; nothing was installed"], ["SIGALRM", " s cap; nothing was installed"]] as const) {
			rmSync(started, { force: true });
			const p = Bun.spawn([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
			own(p.pid);
			let stderr = "";
			const decoder = new TextDecoder();
			const saw = Promise.withResolvers<void>();
			const drained = (async () => {
				for await (const chunk of p.stderr) {
					stderr += decoder.decode(chunk, { stream: true });
					if (stderr.includes(said)) saw.resolve();
				}
				saw.reject(new Error(`the refresh helper's stderr ended without "${said}": ${stderr}`));
			})();
			// Live: the line is on the helper's stderr while render-exec still runs, before any stop.
			await saw.promise;
			await appeared(started, "render-exec's pid file", p);
			children.push(Number(readFileSync(started, "utf8")));
			own(children.at(-1)!);
			process.kill(p.pid, signal);
			const [exit, stdout] = await Promise.all([p.exited, new Response(p.stdout).text(), drained]);
			expect({ signal, exit, stdout }).toEqual({ signal, exit: 71, stdout: "" });
			const lines = stderr.trim().split("\n");
			expect(lines.filter((l) => l === said)).toHaveLength(1);
			const stop = lines.findIndex((l) => l.includes(says));
			expect(stop).toBeGreaterThan(lines.indexOf(said));
			expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
			expect(leftBuilds(r)).toEqual([]);
			expect(tree(r.libexec, ["refresh.d"])).toEqual(installed);
		}
		await exited(...children);
	}, 240_000);

	// TOOLS-REVIEW r3 minor 3: an uncaught error ends with Bun's version line, which names no cause.
	test("F2: render-exec dying uncaught gives the refresh helper's die line its error, never Bun's version line or a stack frame", () => {
		const o = fixtureOrigin("f2-uncaught");
		const r = helperRig("f2-uncaught", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		const installed = tree(r.libexec, ["refresh.d"]);
		const cause = "render-exec probe: an uncaught failure names its cause";
		const sha = o.commit({ [AS2]: `if (process.argv[2] === "render-exec") throw new Error(${JSON.stringify(cause)});\n${fixtureSources().get(AS2)!}` }, "a render-exec that dies uncaught");
		const out = r.run();
		expect({ exit: out.exit, stdout: out.stdout }).toEqual({ exit: 71, stdout: "" });
		const lines = out.stderr.trim().split("\n");
		// Bun's version line and the stack frame streamed above the die line, which skips both.
		expect(lines.filter((l) => /^Bun v\d/.test(l))).toHaveLength(1);
		expect(lines.some((l) => /^\s+at /.test(l))).toBe(true);
		expect(lines.at(-1)).toBe(`as2test-refresh: as2test.ts render-exec at ${sha} failed (exit 1): error: ${cause}`);
		expect(tree(r.libexec, ["refresh.d"])).toEqual(installed);
	}, 180_000);

	test("T6: a TERM during a stalled staging install, a step that once ran in the foreground, exits 71 within seconds with no .new file, no build dir and the install unchanged; a second helper meanwhile waits on the lock and exits 69", async () => {
		const o = fixtureOrigin("t6-stall");
		const r = helperRig("t6-stall", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		o.commit({ [INPUT]: `${fixtureSources().get(INPUT)}// main moved\n` }, "main moves");
		// Each staging install sleeps 30 s once its .new copy is written; a second helper waits 1 s for the lock.
		r.place({ stallS: 30, lockWaitS: 1 });
		const installed = tree(r.libexec, ["refresh.d"]);
		const p = Bun.spawn([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		own(p.pid);
		const stdout = new Response(p.stdout).text();
		const stderr = new Response(p.stderr).text();
		await appeared(join(r.libexec, ".exec.new"), "the staging install's .exec.new", p);
		expect(leftBuilds(r)).toHaveLength(1);

		// While it holds refresh.d/lock, another refresh (the next run's, after the runner gave up on this one) gets 69 and touches nothing.
		const second = r.run();
		expect({ exit: second.exit, stdout: second.stdout }).toEqual({ exit: 69, stdout: "" });
		expect(second.stderr).toContain("another refresh holds");
		expect(existsSync(join(r.libexec, ".exec.new"))).toBe(true);
		expect(leftBuilds(r)).toHaveLength(1);

		const t0 = Date.now();
		process.kill(p.pid, "SIGTERM");
		const exit = await p.exited;
		expect({ exit, stdout: await stdout }).toEqual({ exit: 71, stdout: "" });
		expect(await stderr).toContain("as2test-refresh: ended by a signal; nothing was installed");
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		expect(leftBuilds(r)).toEqual([]);
		expect(tree(r.libexec, ["refresh.d"])).toEqual(installed);
	}, 120_000);

	test("T6: a stalled cleanup removal is killed at the cleanup bound: the helper exits within it, names the build dir it left and frees the lock, and the next run removes that dir", async () => {
		const o = fixtureOrigin("t6-cleanup");
		const r = helperRig("t6-cleanup", o);
		const original = fixtureSources().get(TEST_EXEC)!;
		o.commit({ [TEST_EXEC]: "export const broken = ;\n" }, "does not compile");
		// The build user's removal of the build dir's src and out sleeps 30 s first; the cleanup bound is 2 s.
		r.place({ cleanupStallS: 30, cleanupS: 2 });
		const p = Bun.spawn([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		own(p.pid);
		const stdout = new Response(p.stdout).text();
		// When the build fails the helper says so and exits; its EXIT cleanup starts from there.
		let stderr = "";
		let failedAt = 0;
		const reading = (async () => {
			const text = new TextDecoder();
			for await (const chunk of p.stderr) {
				stderr += text.decode(chunk, { stream: true });
				if (failedAt === 0 && stderr.includes("as2test-refresh: bun build of surface/scripts/test-exec.ts")) failedAt = Date.now();
			}
		})();
		const exit = await p.exited;
		const exitedAt = Date.now();
		await reading;
		expect({ exit, stdout: await stdout }).toEqual({ exit: 71, stdout: "" });
		expect(failedAt).toBeGreaterThan(0);
		expect(exitedAt - failedAt).toBeLessThan(2_000 + 3_000);
		// The dir it left is the one this run made: named on stderr and in its $MADE, still there.
		const named = /as2test-refresh: left the build dir \/private\/tmp\/(as2test-refresh\.[A-Za-z0-9]{6}): its removal did not end within the 2 s cleanup bound\n/.exec(stderr);
		expect(named?.[1]).toBeString();
		const left = named![1]!;
		expect(leftBuilds(r)).toEqual([join("/private/tmp", left)]);

		// The lock is free: the next run takes it at once (lockWaitS 1, else 69), removes the dir left, and builds main.
		const fixed = o.commit({ [TEST_EXEC]: original }, "compiles again");
		r.place({ lockWaitS: 1 });
		const next = r.run();
		expect({ exit: next.exit, stdout: next.stdout, stderr: next.exit === 0 ? "" : next.stderr }).toEqual({ exit: 0, stdout: `refreshed none..${sha12(fixed)}\n`, stderr: "" });
		expect(existsSync(join("/private/tmp", left))).toBe(false);
	}, 120_000);

	test("T6: a left build dir whose removal fails at once (a file in it made immutable) stops the next run with 71, keeping the dir and its name in the stage; once the file is freed the run after removes it and builds", async () => {
		const o = fixtureOrigin("t6-uchg");
		const r = helperRig("t6-uchg", o);
		const original = fixtureSources().get(TEST_EXEC)!;
		o.commit({ [TEST_EXEC]: "export const broken = ;\n" }, "does not compile");
		// As in the stalled-cleanup test: the build fails and its cleanup is killed at the 2 s bound, leaving the build dir.
		r.place({ cleanupStallS: 30, cleanupS: 2 });
		const first = await r.spawn();
		expect({ exit: first.exit, stdout: first.stdout }).toEqual({ exit: 71, stdout: "" });
		const named = /as2test-refresh: left the build dir \/private\/tmp\/(as2test-refresh\.[A-Za-z0-9]{6}): its removal did not end within the 2 s cleanup bound\n/.exec(first.stderr);
		expect(named?.[1]).toBeString();
		const left = join("/private/tmp", named![1]!);
		const stageBuild = join(r.state, "stage", "build");
		expect(readFileSync(stageBuild, "utf8")).toBe(`${left}\n`);
		const locked = join(left, "src", TEST_EXEC);
		const chflags = (...args: string[]) => Bun.spawnSync(["/usr/bin/chflags", ...args], { env: { PATH: SYS_PATH }, stdout: "pipe", stderr: "pipe" });
		try {
			// The build user marks a file in the dir it left immutable: removing it now fails at once, not at the bound.
			expect(chflags("uchg", locked).exitCode).toBe(0);
			const fixed = o.commit({ [TEST_EXEC]: original }, "compiles again");
			r.place({ lockWaitS: 1 });
			const stopped = r.run();
			expect({ exit: stopped.exit, stdout: stopped.stdout }).toEqual({ exit: 71, stdout: "" });
			expect(stopped.stderr).toContain(`as2test-refresh: left the build dir ${left}: its removal failed\n`);
			expect(stopped.stderr).toContain(`as2test-refresh: cannot remove ${left}, the build dir an earlier run left`);
			expect(existsSync(left)).toBe(true);
			expect(readFileSync(stageBuild, "utf8")).toBe(`${left}\n`);

			// Freed, the next run removes the dir and builds main.
			expect(chflags("nouchg", locked).exitCode).toBe(0);
			const next = r.run();
			expect({ exit: next.exit, stdout: next.stdout, stderr: next.exit === 0 ? "" : next.stderr }).toEqual({ exit: 0, stdout: `refreshed none..${sha12(fixed)}\n`, stderr: "" });
			expect(existsSync(left)).toBe(false);
		} finally {
			if (existsSync(left)) {
				chflags("-R", "nouchg", left);
				rmSync(left, { recursive: true, force: true });
			}
		}
	}, 120_000);

	test("T6: the escalation's identity check: KILL reaches only pids still in the step's process group or under a live member, never a listed pid that is now another process", async () => {
		const steps = loose.REFRESH_STEP_SH;
		expect(typeof steps).toBe("string");
		const d = dir("t6-identity");
		// A step as run forks it (its own process group, every process TERM-proof): its leader, a child, and a
		// shell under the leader that starts a process group of its own (left the step's group, still under a member).
		// The stranger stands in for a listed pid the kernel has since given to another process.
		const script = [
			String(steps),
			'D=$1',
			"set -m",
			`( trap '' TERM; /bin/sleep 60 </dev/null & echo $! > "$D/child"; /bin/sh -c 'set -m; /bin/sleep 60 </dev/null & echo $! > "$1"; set +m; wait' as2test-esc "$D/escapee" </dev/null & echo $! > "$D/esc-sh"; exec /bin/sleep 60 ) </dev/null &`,
			"pg=$!",
			"/bin/sh -c \"trap '' TERM; exec /bin/sleep 60\" </dev/null &",
			"stranger=$!",
			"set +m",
			'echo "$pg" > "$D/pg"; echo "$stranger" > "$D/stranger"',
			'while [ ! -s "$D/child" ] || [ ! -s "$D/esc-sh" ] || [ ! -s "$D/escapee" ]; do /bin/sleep 0.05; done',
			'IFS= read -r child < "$D/child"; IFS= read -r esc_sh < "$D/esc-sh"; IFS= read -r esc < "$D/escapee"',
			'listed="$pg $child $esc_sh $esc $stranger"',
			'echo "step $(step_pids "$pg" | /usr/bin/tr "\\n" " ")"',
			'echo "still $(still_ours "$pg" $listed | /usr/bin/tr "\\n" " ")"',
			"# The leader exits; its child and the shell stay in the group, the escapee under the shell.",
			'/bin/kill -KILL "$pg"; wait "$pg" 2>/dev/null',
			'echo "after $(still_ours "$pg" $listed | /usr/bin/tr "\\n" " ")"',
			'kill_ours KILL "$pg" $listed',
			"/bin/sleep 0.3",
		].join("\n");
		const ran = Bun.spawnSync(["/bin/sh", "-c", script, "as2test-identity", d], { env: { PATH: SYS_PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [pg, child, escSh, esc, stranger] = ["pg", "child", "esc-sh", "escapee", "stranger"].map((f) => Number(readFileSync(join(d, f), "utf8"))) as [number, number, number, number, number];
		for (const pid of [pg, child, escSh, esc, stranger]) own(pid);
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		try {
			expect(ran.exitCode).toBe(0);
			const lines = ran.stdout.toString().split("\n").filter(Boolean);
			expect(lines).toEqual([
				`step ${[pg, child, escSh, esc].map(String).sort().join(" ")} `,
				`still ${[pg, child, escSh, esc].join(" ")} `,
				`after ${[child, escSh, esc].join(" ")} `,
			]);
			await exited(pg, child, escSh, esc);
			expect(alive(stranger)).toBe(true);
		} finally {
			try {
				process.kill(stranger, "SIGKILL");
			} catch {
				// gone
			}
		}
	}, 30_000);

	test("render-refresh on the CLI prints what renderRefreshHelper renders; a render refuses what an installed helper must not carry", () => {
		const render = newExport<RenderRefresh>("renderRefreshHelper");
		expect(loose.REFRESH_FAILED).toBe("bundle-refresh-failed");
		expect(loose.CHECKOUT_DRIFT).toBe("checkout-drift");
		const origin = loose.AS2TEST_ORIGIN;
		const facts = { bunVersion: "1.3.14", user: AS2TEST_USER, uid: 602, gid: 602, jo: "jo", joUid: 501, created: ["user", "group", "/l"] };
		const real = { origin, libexec: "/l", root: "/r", bun: "/l/bun", facts, buildUser: "nobody", asRoot: true };
		const args = [
			"--libexec", "/l", "--root", "/r", "--bun", "/l/bun", "--user", AS2TEST_USER, "--uid", "602", "--gid", "602", "--jo", "jo", "--jo-uid", "501", "--bun-version", "1.3.14",
			"--created", "user", "--created", "group", "--created", "/l", "--build-user", "nobody", "--as-root",
		];
		const cli = (a: string[]) => Bun.spawnSync([BUN, AS2, "render-refresh", ...a], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		const ok = cli(args);
		expect(ok.stderr.toString()).toBe("");
		expect(ok.exitCode).toBe(0);
		const text = render(real);
		expect(ok.stdout.toString()).toBe(text);
		const bad = cli([...args, "--bogus"]);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr.toString()).toContain("unknown flag");

		// render-provisional-source: the same flags plus bun's and refresh's sha; it parses, and only its PROVISIONAL source-sha lets it list no input.
		const [bunSha, refreshSha] = ["a".repeat(64), "b".repeat(64)];
		const provisional = Bun.spawnSync([BUN, AS2, "render-provisional-source", ...args, "--bun-sha", bunSha, "--refresh-sha", refreshSha], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		expect({ exit: provisional.exitCode, stderr: provisional.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
		const ptext = provisional.stdout.toString();
		expect(ptext).toBe(newExport<(o: Record<string, unknown>, h: Record<string, string>) => string>("renderProvisionalSource")(real, { bun: bunSha, refresh: refreshSha }));
		expect(parseSource(ptext)).toEqual({
			ok: true,
			source: {
				source: "provisional", sourceSha: "provisional", bunVersion: "1.3.14", user: AS2TEST_USER, uid: 602, gid: 602, jo: "jo", joUid: 501,
				files: { exec: "0".repeat(64), bun: bunSha, "test-exec.js": "0".repeat(64), refresh: refreshSha }, inputs: {}, created: ["user", "group", "/l"],
			},
		});
		expect(parseSource(ptext.replace("source-sha provisional", `source-sha ${"1".repeat(40)}`))).toEqual({ ok: false, error: "SOURCE lists no bundle input" });
		const noSha = Bun.spawnSync([BUN, AS2, "render-provisional-source", ...args, "--bun-sha", bunSha], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		expect({ exit: noSha.exitCode, stdout: noSha.stdout.toString() }).toEqual({ exit: 1, stdout: "" });
		expect(noSha.stderr.toString()).toContain("render-provisional-source needs --refresh-sha");

		// The installed render: the fixed origin over https only, the lock on fd 9, the build as nobody, root:wheel installs.
		expect(text).toContain(`ORIGIN='${origin}'`);
		expect(text).toContain("-c protocol.allow=never -c protocol.https.allow=always");
		expect(text).not.toContain("protocol.file.allow");
		expect(text).toContain(`exec 9>>"$STATE/lock"`);
		expect(text).toContain("/usr/bin/lockf -s -t 600 9 ||");
		expect(text).toContain(`/usr/bin/sudo -n -u 'nobody' /usr/bin/env -i PATH=${SYS_PATH} HOME="$BUILD"`);
		expect(text).toContain(`/usr/bin/sudo -n -u 'nobody' /bin/cat -- "$BUILD/out/$1" > "$STAGE/$1"`);
		expect(text).toContain(`/usr/sbin/chown -R 'nobody' "$BUILD"`);
		expect(text).toContain("OWN_U=root");
		expect(text).toContain("OWN_G=wheel");
		// The scrub: an exact-environment check, an env -i re-exec with only the fixed values, and the loader and git variables unset.
		expect(text).toContain(`'HOME=/var/empty\nPATH=${SYS_PATH}') ;;`);
		expect(text).toContain(`exec /usr/bin/env -i PATH=${SYS_PATH} HOME=/var/empty /bin/sh '/l/refresh' '--as2test-refresh-clean-env' "$@" ;;`);
		expect(text).not.toContain("AS2TEST_REFRESH_ENV");
		expect(text).toMatch(/\nunset GIT_DIR .*\bGIT_EXEC_PATH\b.*\bDYLD_INSERT_LIBRARIES\b/);
		// Signals and the cap: trapped before the lock, ignored only for the renames.
		expect(text).toContain(`trap 'stop "ended by a signal"' HUP INT TERM`);
		expect(text).toContain(`trap 'stop "stopped at its own ${14 * 60} s cap"' ALRM`);
		expect(text.indexOf("trap '' HUP INT TERM ALRM\nfor f in exec test-exec.js SOURCE; do\n\t/bin/mv")).toBeGreaterThan(text.indexOf("exec 9>>"));
		expect(text.indexOf('/bin/mv -f "$LIBEXEC/.$f.new" "$LIBEXEC/$f"')).toBeGreaterThan(0);
		expect(text).toContain("for f in exec test-exec.js SOURCE; do");
		// The cleanup bound: each removal of what a run leaves runs without the lock's fd, within REFRESH_CLEANUP_S.
		expect(loose.REFRESH_CLEANUP_S).toBe(30);
		expect(text).toContain(`set -m; "$@" </dev/null 9>&- & _b=$!; set +m`);
		expect(text).toContain("its removal did not end within the 30 s cleanup bound");

		for (const wrong of [
			{ origin: "https://example.com/other.git" },
			{ buildUser: null },
			{ allowFileProtocol: true },
			{ origin: "/tmp/origin.git", asRoot: false, buildUser: null },
			{ lockWaitS: -1 },
			{ capS: 0 },
			{ capS: 60 },
			{ stallS: 5 },
			{ cleanupS: 5 },
			{ cleanupStallS: 5 },
			{ libexec: "relative" },
			{ facts: { ...facts, created: ["relative"] } },
			{ facts: { ...facts, jo: "jo smith" } },
		]) {
			expect(() => render({ ...real, ...wrong })).toThrow(WrapperRenderError);
		}
	});
});

// ---- setup -----------------------------------------------------------------------------------------------------

describe("install/as2test-setup.sh", () => {
	const me = { uid: process.getuid!(), gid: process.getgid!() };
	const JO = userInfo().username;
	const SETUP_REL = "install/as2test-setup.sh";

	/** What a setup checkout holds: the setup script, and every file test-exec.ts and as2test.ts import, from this checkout's working tree. */
	let files: string[] | null = null;
	function checkoutFiles(): string[] {
		if (files) return files;
		const out = dir("setup-meta");
		const rels = new Set<string>([SETUP_REL]);
		for (const entry of ["surface/scripts/test-exec.ts", "surface/src/as2test.ts"]) {
			const meta = join(out, `${basename(entry)}.meta.json`);
			const r = Bun.spawnSync([BUN, "build", "--target=bun", `--outfile=${join(out, `${basename(entry)}.js`)}`, `--metafile=${meta}`, entry], {
				cwd: REPO, stdout: "pipe", stderr: "pipe",
			});
			if (r.exitCode !== 0) throw new Error(`bun build ${entry}: ${r.stderr.toString()}`);
			for (const rel of bundleInputs(readFileSync(meta, "utf8"), REPO, REPO)) rels.add(rel);
		}
		files = [...rels].sort();
		return files;
	}

	/**
	 * A committed checkout of those files whose `origin` is a local bare repo holding the same main,
	 * a prefix, fake dscl/visudo/sudo on PATH, and a log of every fake sudo call. Setup runs from the
	 * checkout with AS2TEST_SETUP_TEST_ORIGIN set to the bare repo (pass it as "" to drop it). The
	 * fake sudo drops a leading `-n`, accepts a bare `-k`, and runs `install` without `-o`/`-g` (the
	 * fence cannot chown): `owners` replays the owners setup asked for from the log.
	 */
	function rig(tag: string, o: { userUid?: number; groupGid?: number; visudoCf?: number } = {}) {
		const base = dir(tag);
		const prefix = join(base, "prefix");
		const bin = join(base, "bin");
		const work = join(base, "checkout");
		mkdirSync(prefix);
		mkdirSync(bin);
		for (const rel of checkoutFiles()) {
			mkdirSync(dirname(join(work, rel)), { recursive: true });
			writeFileSync(join(work, rel), readFileSync(join(REPO, rel)));
		}
		git(work, "init", "-q", "-b", "main");
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", "main");
		// The verified tag the helper fetches (PLAN wl-mvq4edbaf13vnk § 2), at main as the runner points it once main is verified.
		git(work, "tag", VERIFIED_TAG);
		const bare = join(base, "origin.git");
		git(base, "clone", "-q", "--bare", work, bare);
		git(work, "remote", "add", "origin", bare);
		git(work, "fetch", "-q", "origin");
		const log = join(base, "sudo.log");
		writeFileSync(join(bin, "sudo"), `#!/bin/sh
echo "$*" >> '${log}'
if [ "$#" -eq 1 ] && [ "$1" = -k ]; then exit 0; fi
if [ "$1" = -n ]; then shift; fi
if [ "$1" = install ]; then
	shift
	n=$#
	while [ "$n" -gt 0 ]; do
		a=$1; shift; n=$((n - 1))
		case "$a" in -o | -g) shift; n=$((n - 1)) ;; *) set -- "$@" "$a" ;; esac
	done
	exec install "$@"
fi
exec "$@"
`, { mode: 0o755 });
		/** The fake dscl, with an _as2test user and group at these ids or none. */
		const account = (userUid?: number, groupGid?: number) =>
			writeFileSync(join(bin, "dscl"), `#!/bin/sh
case "$*" in
". -read /Users/_as2test UniqueID") ${userUid ? `echo "UniqueID: ${userUid}"` : "exit 56"} ;;
". -read /Groups/_as2test PrimaryGroupID") ${groupGid ? `echo "PrimaryGroupID: ${groupGid}"` : "exit 56"} ;;
". -list /Users UniqueID") printf 'root 0\\n_www 70\\n_taken 600\\njo 501\\n' ;;
". -list /Groups PrimaryGroupID") printf 'wheel 0\\nstaff 20\\n_gtaken 601\\n' ;;
". -create /Groups/_as2test "* | ". -create /Users/_as2test "* | ". -delete /Users/_as2test" | ". -delete /Groups/_as2test") ;;
*) echo "fake dscl: unexpected $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
		account(o.userUid, o.groupGid);
		writeFileSync(join(bin, "visudo"), `#!/bin/sh\ncase "$1" in -c) echo "/etc/sudoers: parsed OK" ;; -cf) exit ${o.visudoCf ?? 0} ;; esac\n`, { mode: 0o755 });
		mkdirSync(join(prefix, "etc", "sudoers.d"), { recursive: true });
		writeFileSync(join(prefix, "etc", "sudoers"), "root ALL = (ALL) ALL\n#includedir /private/etc/sudoers.d\n");
		const run = (args: string[], stdin = "", env: Record<string, string> = {}) => {
			const r = Bun.spawnSync(["bash", join(work, SETUP_REL), ...args], {
				env: { PATH: `${bin}:${join(BUN, "..")}:${SYS_PATH}`, HOME: base, TMPDIR: base, AS2TEST_SETUP_TEST_PREFIX: prefix, AS2TEST_SETUP_TEST_ORIGIN: bare, ...env },
				stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe",
			});
			return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
		};
		const tree = (): string[] => {
			const out: string[] = [];
			const walk = (p: string) => {
				for (const n of readdirSync(p)) {
					out.push(join(p, n));
					if (lstatSync(join(p, n)).isDirectory()) walk(join(p, n));
				}
			};
			walk(prefix);
			return out.sort();
		};
		const sudoCalls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
		/** The owner each path would have, from the `install -o -g`, `mv -f` and `rm -f` calls in the log; root → this uid, wheel → this gid, Jo → this uid. */
		const owners = (): Map<string, [number, number]> => {
			const id = (v: string): number => (v === "root" || v === JO ? me.uid : v === "wheel" ? me.gid : Number(v));
			const m = new Map<string, [number, number]>();
			for (const call of sudoCalls().trim().split("\n")) {
				const a = call.split(" ");
				if (a[0] === "install") {
					let u: string | undefined;
					let g: string | undefined;
					let isDir = false;
					const ops: string[] = [];
					for (let i = 1; i < a.length; i++) {
						if (a[i] === "-o") u = a[++i];
						else if (a[i] === "-g") g = a[++i];
						else if (a[i] === "-m") i++;
						else if (a[i] === "-d") isDir = true;
						else ops.push(a[i]!);
					}
					if (u === undefined || g === undefined) throw new Error(`install without -o and -g: ${call}`);
					for (const p of isDir ? ops : ops.slice(-1)) m.set(p, [id(u), id(g)]);
				} else if (a[0] === "mv" && a[1] === "-f") {
					const v = m.get(a[2]!);
					m.delete(a[2]!);
					if (v) m.set(a[3]!, v);
				} else if (a[0] === "rm" && a[1] === "-f") m.delete(a[2]!);
			}
			return m;
		};
		const libexec = join(prefix, "usr", "local", "libexec", "as2test");
		const root = join(prefix, "Users", "Shared", "as2test");
		const sudoers = join(prefix, "etc", "sudoers.d", "as2test");
		/** The operator's measured policy, as `--resources` names it: synthetic costs, never a host measurement. */
		const measured = join(base, "measured-policy.json");
		writeFileSync(measured, SYNTHETIC_POLICY);
		const resources = `--resources=${measured}`;
		/** Every path under the prefix with its type, mode and, for a file, its sha-256 (a symlink, its target): the install byte for byte. */
		const bytes = (): Record<string, string> =>
			Object.fromEntries(tree().map((p) => {
				const s = lstatSync(p);
				const kind = s.isSymbolicLink() ? `link ${readlinkSync(p)}` : s.isFile() ? `file ${new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex")}` : s.isDirectory() ? "dir" : "other";
				return [p, `${(s.mode & 0o7777).toString(8)} ${kind}`];
			}));
		return { base, prefix, work, bare, libexec, root, sudoers, run, tree, bytes, sudoCalls, owners, account, measured, resources };
	}
	const sudoersLines = (libexec: string) => [`${JO} ALL=(_as2test) NOPASSWD: ${join(libexec, "exec")}`, `${JO} ALL=(root) NOPASSWD: ${join(libexec, "refresh")} ""`];

	test("--dry-run prints the dscl and sudoers plan with a free id >= 600, the helper's text and sha, and changes nothing (T8: no sudo call)", () => {
		const r = rig("setup-dry");
		const resources = join(r.base, "measured-fixture.json");
		writeFileSync(resources, JSON.stringify({ workerCpu: 1, workerMemoryBytes: 1, reserveCpu: 0, reserveMemoryBytes: 0, calibration: "synthetic setup fixture only" }));
		const artifact = join(r.base, "verified-fixture");
		mkdirSync(join(artifact, "bin"), { recursive: true });
		for (const exe of ["omp", "bun"]) writeFileSync(join(artifact, "bin", exe), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const before = r.tree();
		const out = r.run(["--dry-run", `--resources=${resources}`, `--omp-artifact=${artifact}`, "--omp-version=synthetic-fixture"]);
		expect(out.stderr).toBe("");
		expect(out.exit).toBe(0);
		// 600 is a taken uid and 601 a taken gid: the first id free as both is 602.
		expect(out.stdout).toContain("sudo dscl . -create /Groups/_as2test PrimaryGroupID 602");
		expect(out.stdout).toContain("sudo dscl . -create /Users/_as2test UniqueID 602");
		expect(out.stdout).toContain("sudo dscl . -create /Users/_as2test UserShell /usr/bin/false");
		expect(out.stdout).toContain("sudo dscl . -create /Users/_as2test NFSHomeDirectory /var/empty");
		expect(out.stdout).toContain("sudo dscl . -create /Users/_as2test IsHidden 1");
		const [execLine, refreshLine] = sudoersLines(r.libexec);
		expect(out.stdout).toContain(`  sudoers ${r.sudoers} (root:wheel 0440), two lines:\n    ${execLine}\n    ${refreshLine}\n`);
		expect(out.stdout).toContain(`checkout ${r.work} at HEAD ${git(r.work, "rev-parse", "HEAD")}; HEAD is on origin/main`);
		expect(out.stdout).toContain(`fetches the ${VERIFIED_TAG} tag (refs/tags/${VERIFIED_TAG}) from ${r.bare}`);
		expect(out.stdout).toMatch(new RegExp(`the refresh helper ${r.libexec}/refresh, sha-256 [0-9a-f]{64}, in full:\\n----- begin ${r.libexec}/refresh -----\\n#!/bin/sh\\n`));
		expect(out.stdout).toContain(`sudo -n ${r.libexec}/refresh`);
		expect(out.stdout).toContain("dry run: nothing changed");
		expect(out.stdout).toContain("synthetic setup fixture only");
		expect(out.stdout).toContain('"version":"synthetic-fixture"');
		expect(out.stdout).toContain("installed-omp.json");
		expect(r.tree()).toEqual(before);
		expect(r.sudoCalls()).toBe("");
	}, 60_000);

	test("T8: setup installs the measured policy, bun, the helper and both sudoers lines; its last sudo step runs the helper, which builds an install installDecision accepts; undo removes it all", () => {
		const r = rig("setup-t8");
		const mainSha = git(r.bare, "rev-parse", `refs/tags/${VERIFIED_TAG}^{commit}`);
		const out = r.run([r.resources], "y\n");
		expect(out.stderr).not.toContain("as2test-setup:");
		expect(out.exit).toBe(0);

		// The plan: both sudoers lines (the second ending ` ""`), the helper's full text and its sha, every sudo step.
		expect(existsSync(join(r.libexec, "refresh"))).toBe(true);
		const helper = readFileSync(join(r.libexec, "refresh"), "utf8");
		const [execLine, refreshLine] = sudoersLines(r.libexec) as [string, string];
		expect(refreshLine.endsWith(' ""')).toBe(true);
		expect(out.stdout).toContain(`    ${execLine}\n    ${refreshLine}\n`);
		const helperSha = new Bun.CryptoHasher("sha256").update(helper).digest("hex");
		expect(out.stdout).toContain(`the refresh helper ${r.libexec}/refresh, sha-256 ${helperSha}, in full:\n----- begin ${r.libexec}/refresh -----\n${helper}----- end ${r.libexec}/refresh -----\n`);
		expect(helper).toContain(`ORIGIN='${r.bare}'`);
		expect(readFileSync(r.sudoers, "utf8").split("\n").slice(1)).toEqual([execLine, refreshLine, ""]);

		// Every sudo call, in order; the last is the helper through the new rule.
		const calls = r.sudoCalls().trim().split("\n").map((c) => c.replace(new RegExp(`${r.base}/as2test-setup\\.[A-Za-z0-9]+`, "g"), "<tmp>").replaceAll(r.prefix, "<p>"));
		const [L, R, S] = ["<p>/usr/local/libexec/as2test", "<p>/Users/Shared/as2test", "<p>/etc/sudoers.d"];
		expect(calls).toEqual([
			"visudo -c",
			"grep -Eq ^[#@]includedir[[:space:]]+(/private)?/etc/sudoers\\.d[[:space:]]*$ <p>/etc/sudoers",
			"visudo -cf <tmp>/sudoers",
			"dscl . -create /Groups/_as2test PrimaryGroupID 602",
			"dscl . -create /Groups/_as2test RealName as2 test runner",
			"dscl . -create /Groups/_as2test Password *",
			"dscl . -create /Users/_as2test UniqueID 602",
			"dscl . -create /Users/_as2test PrimaryGroupID 602",
			"dscl . -create /Users/_as2test UserShell /usr/bin/false",
			"dscl . -create /Users/_as2test NFSHomeDirectory /var/empty",
			"dscl . -create /Users/_as2test IsHidden 1",
			"dscl . -create /Users/_as2test RealName as2 test runner",
			"dscl . -create /Users/_as2test Password *",
			`install -d -o root -g wheel -m 0755 ${R} ${R}/locks`,
			`install -d -o ${JO} -g 602 -m 0750 ${R}/stage`,
			`install -d -o 602 -g 602 -m 0755 ${R}/runs`,
			`rm -f ${R}/locks/sweep.db`,
			`install -o 602 -g 602 -m 0600 /dev/null ${R}/locks/sweep.db`,
			`install -d -o root -g wheel -m 0755 ${L}`,
			`install -d -o root -g wheel -m 0700 ${L}/refresh.d`,
			`install -o root -g wheel -m 0644 <tmp>/resources.json ${L}/.resources.json.new`,
			`mv -f ${L}/.resources.json.new ${L}/resources.json`,
			`install -o root -g wheel -m 0755 <tmp>/bun ${L}/bun`,
			`install -o root -g wheel -m 0755 <tmp>/refresh ${L}/refresh`,
			`install -o root -g wheel -m 0755 <tmp>/SOURCE ${L}/.SOURCE.new`,
			`mv -f ${L}/.SOURCE.new ${L}/SOURCE`,
			`install -o root -g wheel -m 0440 <tmp>/sudoers ${S}/.as2test.new`,
			`visudo -cf ${S}/.as2test.new`,
			"visudo -c",
			`mv -f ${S}/.as2test.new ${S}/as2test`,
			"-k",
			`-n ${L}/refresh`,
		]);
		expect(out.stdout).toContain(`refreshed none..${mainSha.slice(0, 12)}`);
		expect(out.stdout.trimEnd().split("\n").at(-1)).toBe("undo: bash install/as2test-setup.sh --undo");

		// The helper wrote SOURCE: main's sha, setup's facts and created list.
		const parsed = parseSource(readFileSync(join(r.libexec, "SOURCE"), "utf8"));
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.source.source).toBe(r.bare);
		expect(parsed.source.sourceSha).toBe(mainSha);
		expect([parsed.source.uid, parsed.source.gid, parsed.source.jo, parsed.source.joUid]).toEqual([602, 602, JO, me.uid]);
		expect(parsed.source.created).toEqual(["user", "group", r.root, r.libexec, r.sudoers]);

		// installDecision over the result, with the owners setup asked install for (the fence cannot chown).
		const own = r.owners();
		const layout = installLayout({ libexec: r.libexec, root: r.root, sudoers: r.sudoers });
		const helperBuilt = ["exec", "test-exec.js"].map((f) => join(r.libexec, f));
		expect(layout.map((l) => l.path).filter((p) => !own.has(p))).toEqual(helperBuilt);
		const facts = readInstall({ checkout: r.work, libexec: r.libexec, root: r.root, sudoers: r.sudoers, dscl: () => 602, trustedOwners: [0, me.uid] });
		const owned = { ...facts, stats: facts.stats.map((s) => (own.has(s.path) ? { ...s, uid: own.get(s.path)![0], gid: own.get(s.path)![1] } : s)) };
		const verdict = installDecision(owned, { root: me.uid, wheel: me.gid, jo: me.uid });
		expect(verdict).toEqual({ ok: true, summary: expect.stringContaining(`source ${r.bare} at ${mainSha.slice(0, 12)}`) });

		// --undo removes libexec whole (refresh and refresh.d with it), the root, the drop-in and the account.
		const undone = r.run(["--undo"], "y\n");
		expect(undone.stderr).toBe("");
		expect(undone.exit).toBe(0);
		for (const p of [r.libexec, r.root, r.sudoers]) expect(existsSync(p)).toBe(false);
		expect(r.sudoCalls().trim().split("\n").slice(-5).map((c) => c.replaceAll(r.prefix, "<p>"))).toEqual([
			"rm -f <p>/etc/sudoers.d/as2test", `rm -rf ${L}`, `rm -rf ${R}`, "dscl . -delete /Users/_as2test", "dscl . -delete /Groups/_as2test",
		]);
	}, 180_000);

	/**
	 * A first install whose final `sudo -n refresh` fails: the checkout's origin and the test origin are a
	 * path that does not exist yet, so the helper's fetch exits 70 after every other step is in place.
	 * The fake dscl then shows the account setup created, as the real one would.
	 */
	function failedFirst(tag: string) {
		const r = rig(tag);
		const gone = join(r.base, "gone.git");
		git(r.work, "remote", "set-url", "origin", gone);
		const env = { AS2TEST_SETUP_TEST_ORIGIN: gone };
		const out = r.run([r.resources], "y\n", env);
		expect(out.exit).toBe(1);
		expect(out.stderr).toContain(`fetching the ${VERIFIED_TAG} tag from ${gone} failed`);
		expect(out.stderr).toContain("the refresh helper failed (its message is above); everything before it is in place, and the provisional SOURCE records it.");
		expect(out.stderr).toContain("The runner's next preflight finds exec and test-exec.js unbuilt (file-drift) and runs the helper again");
		expect(r.sudoCalls().trim().split("\n").at(-1)).toBe(`-n ${join(r.libexec, "refresh")}`);
		r.account(602, 602);
		return { r, gone, env };
	}
	/** installDecision over a setup rig's install, with the owners setup asked install for (the fence cannot chown). */
	function rigVerdict(r: { work: string; libexec: string; root: string; sudoers: string; owners: () => Map<string, [number, number]> }): InstallVerdict {
		const own = r.owners();
		const facts = readInstall({ checkout: r.work, libexec: r.libexec, root: r.root, sudoers: r.sudoers, dscl: () => 602, trustedOwners: [0, me.uid] });
		const owned = { ...facts, stats: facts.stats.map((s) => (own.has(s.path) ? { ...s, uid: own.get(s.path)![0], gid: own.get(s.path)![1] } : s)) };
		return installDecision(owned, { root: me.uid, wheel: me.gid, jo: me.uid });
	}

	test("a failed first refresh: --undo removes everything the provisional SOURCE records", () => {
		const { r } = failedFirst("setup-fail-undo");
		const undone = r.run(["--undo"], "y\n");
		expect(undone.stderr).toBe("");
		expect(undone.exit).toBe(0);
		for (const p of [r.libexec, r.root, r.sudoers]) expect(existsSync(p)).toBe(false);
		expect(r.sudoCalls().trim().split("\n").slice(-5).map((c) => c.replaceAll(r.prefix, "<p>"))).toEqual([
			"rm -f <p>/etc/sudoers.d/as2test", "rm -rf <p>/usr/local/libexec/as2test", "rm -rf <p>/Users/Shared/as2test", "dscl . -delete /Users/_as2test", "dscl . -delete /Groups/_as2test",
		]);
	}, 120_000);

	test("a failed first refresh: the provisional SOURCE is file-drift, a re-run takes its own account, and the helper with a good origin installs what installDecision accepts", () => {
		const { r, gone, env } = failedFirst("setup-fail-rerun");
		// The provisional SOURCE: setup's facts, created list and files, nothing the helper builds.
		const parsed = parseSource(readFileSync(join(r.libexec, "SOURCE"), "utf8"));
		if (!parsed.ok) throw new Error(parsed.error);
		const setupFiles = Object.fromEntries(["bun", "refresh"].map((f) => [f, new Bun.CryptoHasher("sha256").update(readFileSync(join(r.libexec, f))).digest("hex")]));
		expect(parsed.source).toEqual({
			source: "provisional", sourceSha: "provisional", bunVersion: Bun.version, user: AS2TEST_USER, uid: 602, gid: 602, jo: JO, joUid: me.uid,
			files: { exec: "0".repeat(64), "test-exec.js": "0".repeat(64), ...setupFiles }, inputs: {},
			created: ["user", "group", r.root, r.libexec, r.sudoers],
		});
		expect(r.owners().get(join(r.libexec, "SOURCE"))).toEqual([me.uid, me.gid]);
		expect(statSync(join(r.libexec, "SOURCE")).mode & 0o7777).toBe(0o755);
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		// (c) installDecision sends the runner's preflight to the helper, not back to setup.
		expect(rigVerdict(r)).toEqual({ ok: false, kind: "file-drift", reason: "installed exec is missing" });

		// (b) A re-run takes the account it recorded, keeps the measured policy the first run installed, and gets as far as the helper again.
		const again = r.run([], "y\n", env);
		expect(again.stdout).toContain(`${join(r.libexec, "resources.json")}: kept (the measured resource policy`);
		expect(again.stderr).not.toContain("did not record");
		expect(again.stdout).toContain("group _as2test gid 602: exists (recorded)");
		expect(again.stdout).toContain("user _as2test uid 602: exists (recorded)");
		expect(again.exit).toBe(1);
		expect(again.stderr).toContain(`fetching the ${VERIFIED_TAG} tag from ${gone} failed`);
		const reparsed = parseSource(readFileSync(join(r.libexec, "SOURCE"), "utf8"));
		expect(reparsed).toMatchObject({ ok: true, source: { sourceSha: "provisional", created: ["user", "group", r.root, r.libexec, r.sudoers] } });

		// (d) The cause fixed (the origin exists), the helper run again installs the verified commit over the provisional SOURCE.
		git(r.base, "clone", "-q", "--bare", r.bare, gone);
		const mainSha = git(gone, "rev-parse", `refs/tags/${VERIFIED_TAG}^{commit}`);
		const helper = Bun.spawnSync([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		expect({ exit: helper.exitCode, stdout: helper.stdout.toString() }).toEqual({ exit: 0, stdout: `refreshed none..${mainSha.slice(0, 12)}\n` });
		const built = parseSource(readFileSync(join(r.libexec, "SOURCE"), "utf8"));
		expect(built).toMatchObject({ ok: true, source: { source: gone, sourceSha: mainSha, created: ["user", "group", r.root, r.libexec, r.sudoers] } });
		expect(rigVerdict(r)).toEqual({ ok: true, summary: expect.stringContaining(`source ${gone} at ${mainSha.slice(0, 12)}`) });
		const current = Bun.spawnSync([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		expect({ exit: current.exitCode, stdout: current.stdout.toString() }).toEqual({ exit: 0, stdout: `current ${mainSha.slice(0, 12)}\n` });
	}, 240_000);

	test("T8: a foreign origin, a dirty checkout and a stray test origin are refused before the plan, with no sudo call; the real check takes only thewolff/agent-system-2.0", () => {
		const r = rig("setup-refuse");
		const refused = (out: { exit: number; stdout: string; stderr: string }, why: string) => {
			expect(out.stderr).toContain(why);
			expect(out.exit).toBe(1);
			expect(out.stdout).toBe("");
			expect(r.sudoCalls()).toBe("");
		};
		const before = r.tree();
		// With the test origin, the checkout's origin must be it.
		git(r.work, "remote", "set-url", "origin", "https://github.com/thewolff/agent-system-2.0.git");
		refused(r.run([], "y\n"), `has origin 'https://github.com/thewolff/agent-system-2.0.git', not the test origin ${r.bare}`);
		// Without it, the real check: the two thewolff/agent-system-2.0 forms, with or without .git, and nothing else.
		const real = { AS2TEST_SETUP_TEST_ORIGIN: "" };
		for (const url of [
			"https://github.com/someone/agent-system-2.0.git", "git@github.com:someone/agent-system-2.0.git", "git@github.com:thewolff/agent-system-2.0.git.evil",
			"https://github.com/thewolff/agent-system-2.0x", "git@github.com:thewolff/agent-system-2.0/", "http://github.com/thewolff/agent-system-2.0.git", r.bare,
		]) {
			git(r.work, "remote", "set-url", "origin", url);
			refused(r.run([], "y\n", real), `has origin '${url}', not thewolff/agent-system-2.0`);
		}
		git(r.work, "remote", "remove", "origin");
		refused(r.run([], "y\n", real), "has origin '', not thewolff/agent-system-2.0");
		git(r.work, "remote", "add", "origin", r.bare);
		for (const url of ["git@github.com:thewolff/agent-system-2.0", "git@github.com:thewolff/agent-system-2.0.git", "https://github.com/thewolff/agent-system-2.0", "https://github.com/thewolff/agent-system-2.0.git"]) {
			git(r.work, "remote", "set-url", "origin", url);
			const ok = r.run(["--dry-run", r.resources], "", real);
			expect(ok.stderr).toBe("");
			expect(ok.exit).toBe(0);
			// The real render: the fixed https origin, built as nobody, root only.
			expect(ok.stdout).toContain(`fetches the ${VERIFIED_TAG} tag (refs/tags/${VERIFIED_TAG}) from https://github.com/thewolff/agent-system-2.0.git and builds that commit as nobody, run as root`);
			expect(ok.stdout).toContain("/usr/bin/sudo -n -u 'nobody' ");
			expect(ok.stdout).toContain("must run as root");
		}
		expect(r.sudoCalls()).toBe("");
		git(r.work, "remote", "set-url", "origin", r.bare);

		// An untracked file is not a dirty checkout; a change to a tracked file is.
		writeFileSync(join(r.work, "untracked.txt"), "x\n");
		expect(r.run(["--dry-run", r.resources]).exit).toBe(0);
		writeFileSync(join(r.work, SETUP_REL), `${readFileSync(join(r.work, SETUP_REL), "utf8")}# local edit\n`);
		refused(r.run([], "y\n"), `the checkout ${r.work} has uncommitted changes to tracked files`);
		git(r.work, "checkout", "--", SETUP_REL);

		// The test origin is honoured only with the test prefix.
		refused(r.run(["--dry-run"], "", { AS2TEST_SETUP_TEST_PREFIX: "" }), "AS2TEST_SETUP_TEST_ORIGIN is honoured only with AS2TEST_SETUP_TEST_PREFIX");
		expect(r.tree()).toEqual(before);
	}, 120_000);

	test("refuses an existing _as2test user or group that SOURCE does not record", () => {
		const u = rig("setup-user", { userUid: 777 });
		const out = u.run(["--dry-run"]);
		expect(out.exit).toBe(1);
		expect(out.stderr).toContain("a user _as2test (uid 777) exists that setup did not record");
		const g = rig("setup-group", { groupGid: 778 });
		expect(g.run([]).stderr).toContain("a group _as2test (gid 778) exists that setup did not record");
		expect(g.sudoCalls()).toBe("");
	}, 30_000);

	test("a visudo check failure aborts before anything is created or moved", () => {
		const r = rig("setup-visudo", { visudoCf: 1 });
		const before = r.tree();
		const out = r.run([r.resources], "y\n");
		expect(out.exit).toBe(1);
		expect(out.stderr).toContain("visudo -cf rejects the drop-in; nothing changed");
		expect(r.tree()).toEqual(before);
		// The only privileged calls were the checks; no dscl, install or mv ran.
		expect(r.sudoCalls().trim().split("\n").map((l) => l.split(" ")[0])).toEqual(["visudo", "grep", "visudo"]);
	}, 30_000);

	test("F2: over a legacy install, setup with no usable measured policy refuses before the plan, with no sudo call, and leaves the install byte for byte unchanged", () => {
		const r = rig("setup-legacy-policy", { userUid: 602, groupGid: 602 });
		// The install setup left before the refresh helper and the measured policy: legacy SOURCE, a working exec, bun and test-exec.js.
		mkdirSync(r.libexec, { recursive: true });
		for (const d of ["stage", "runs", "locks"]) mkdirSync(join(r.root, d), { recursive: true });
		writeFileSync(r.sudoers, `${sudoersLines(r.libexec)[0]}\n`);
		const files = { exec: "#!/bin/sh\n# the legacy wrapper\n", bun: "legacy bun\n", "test-exec.js": "// the legacy bundle\n" };
		for (const [f, t] of Object.entries(files)) writeFileSync(join(r.libexec, f), t, { mode: 0o755 });
		writeFileSync(join(r.libexec, "SOURCE"), [
			"# as2test SOURCE: written by install/as2test-setup.sh", "version 1", `source ${r.work}`, `source-sha ${git(r.work, "rev-parse", "HEAD")}`, `bun-version ${Bun.version}`,
			`user ${AS2TEST_USER}`, "uid 602", "gid 602", `jo ${JO}`, `jo-uid ${me.uid}`, "created user", "created group", `created ${r.root}`, `created ${r.libexec}`, `created ${r.sudoers}`,
			...Object.entries(files).map(([f, t]) => `file ${f} ${new Bun.CryptoHasher("sha256").update(t).digest("hex")}`), `input surface/scripts/test-exec.ts ${"a".repeat(64)}`, "",
		].join("\n"), { mode: 0o755 });
		const policy = join(r.libexec, "resources.json");
		const badArg = join(r.base, "bad-policy.json");
		const cases: [string, string[], () => void, string][] = [
			["no policy and no --resources", [], () => {}, "no measured resource policy:"],
			["an installed policy that is not measured costs", [], () => { writeFileSync(policy, "{}"); chmodSync(policy, 0o644); }, `the installed ${policy} is not a valid measured resource policy`],
			["an installed policy others can write", [], () => { writeFileSync(policy, SYNTHETIC_POLICY); chmodSync(policy, 0o666); }, `${policy} is group- or world-writable (mode 666)`],
			["an installed policy that is a symlink", [], () => symlinkSync(r.measured, policy), `${policy} is not a regular file`],
			["a --resources file that is not measured costs", [`--resources=${badArg}`], () => writeFileSync(badArg, JSON.stringify({ workerCpu: 1 })), "invalid resource calibration"],
		];
		for (const [name, args, make, says] of cases) {
			rmSync(policy, { force: true });
			make();
			const before = r.bytes();
			const out = r.run(args, "y\n");
			expect({ name, exit: out.exit, stdout: out.stdout }).toEqual({ name, exit: 1, stdout: "" });
			expect(out.stderr).toContain(says);
			expect(out.stderr).toContain("Nothing changed");
			expect(r.sudoCalls()).toBe("");
			expect(r.bytes()).toEqual(before);
		}
	}, 120_000);

	test("--undo refuses while a run holds the runs lock, and plans only what SOURCE recorded once it is free", () => {
		const r = rig("setup-undo");
		const libexec = join(r.prefix, "usr", "local", "libexec", "as2test");
		mkdirSync(libexec, { recursive: true });
		writeFileSync(join(libexec, "SOURCE"), `version 1\nuid 602\ngid 602\ncreated user\ncreated ${libexec}\n`);
		const runs = join(r.prefix, "..", "runs");
		mkdirSync(runs);
		const db = new Database(join(runs, "runs.db"));
		db.run("CREATE TABLE lock (id INTEGER PRIMARY KEY CHECK (id = 1), runId TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, runDir TEXT NOT NULL, heartbeatAt INTEGER NOT NULL)");
		db.query("INSERT INTO lock VALUES (1, 'tr-live', 1, 1, '/x', ?)").run(Date.now());
		const env = { AGENT_SYSTEM_TEST_RUNS: runs };
		const held = r.run(["--undo"], "y\n", env);
		expect(held.exit).toBe(1);
		expect(held.stderr).toContain("run tr-live holds the runs lock");
		expect(r.sudoCalls()).toBe("");
		expect(existsSync(libexec)).toBe(true);

		db.query("UPDATE lock SET heartbeatAt = ?").run(Date.now() - 120_000);
		db.close();
		const free = r.run(["--undo", "--dry-run"], "", env);
		expect(free.exit).toBe(0);
		expect(free.stdout).toContain(`sudo rm -rf ${libexec}`);
		expect(free.stdout).toContain("sudo dscl . -delete /Users/_as2test");
		expect(free.stdout).not.toContain("/Groups/_as2test");
		expect(free.stdout).not.toContain("sudoers.d");
		expect(r.sudoCalls()).toBe("");
	}, 30_000);

	test("--help says a corrupt sweep.db is repaired by re-running setup", () => {
		const r = rig("setup-help");
		const out = r.run(["--help"]);
		expect(out.exit).toBe(0);
		expect(out.stdout).toContain("repairs a corrupt or missing locks/sweep.db");
	}, 30_000);
});
