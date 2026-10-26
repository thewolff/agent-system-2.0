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
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import * as as2test from "../src/as2test";
import {
	bundleInputs, CREDENTIAL_PATHS, execArgv, execConfigOf, type InstallVerdict, installDecision, installLayout, parseSource, preflightDecision, preflightProbes,
	probeCall, probeDecision, readInstall, renderExecWrapper, type SweepScope, UID_SWEEP, WrapperRenderError,
} from "../src/as2test";
import { AS2TEST_USER, CHILD_ENV_ALLOWLIST, childEnv, partResult, WRAPPER_EXIT, type WrapperCall } from "../src/test-run";
import { tmp } from "./helpers";

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

const made: string[] = [];
/** chmod u+rwx every directory beneath, so rmSync can delete what a test sealed. */
function unseal(p: string): void {
	let st;
	try {
		st = lstatSync(p);
	} catch {
		return;
	}
	if (!st.isDirectory()) return;
	chmodSync(p, 0o755);
	for (const n of readdirSync(p)) unseal(join(p, n));
}
const pids: number[] = [];
afterAll(() => {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const r of made) {
		unseal(r);
		rmSync(r, { recursive: true, force: true });
	}
});
const dir = (tag: string): string => {
	const d = realpathSync(tmp(`as2test-${tag}`));
	made.push(d);
	return d;
};

const FAKE_SUDO = `#!/bin/sh
# fake sudo for the fence: the runner's argv is exactly sudo -n -u _as2test <exec> ...; run <exec> as the current user.
[ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = ${AS2TEST_USER} ] || { echo "fake sudo: unexpected argv: $*" >&2; exit 1; }
shift 3
exec "$@"
`;

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
// These tests drive real processes, signals and file locks, so they poll the condition they await;
// fake timers cannot move another process's clock.
async function until(cond: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await Bun.sleep(25);
	}
	return cond();
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

/** A tmp as2test root with a groups-scope wrapper and a fake sudo on PATH (§ 6 S4b). */
function box(tag: string, opts: { killGraceMs?: number; sweepLockWaitMs?: number; script?: string } = {}): Box {
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
	writeFileSync(exec, renderExecWrapper({ root, bun: BUN, script: opts.script ?? SCRIPT, sweepScope: "groups", hooks, killGraceMs: opts.killGraceMs ?? 500, sweepLockWaitMs: opts.sweepLockWaitMs }), { mode: 0o755 });
	return { root, exec, bin, hooks };
}

/** A second wrapper over the same root with other test limits. */
function wrapperFor(b: Box, name: string, opts: { sweepLockWaitMs?: number }): string {
	const exec = join(b.root, "..", name);
	writeFileSync(exec, renderExecWrapper({ root: b.root, bun: BUN, script: SCRIPT, sweepScope: "groups", hooks: b.hooks, killGraceMs: 500, ...opts }), { mode: 0o755 });
	return exec;
}

/** The caller's env carries credentials; the wrapper's `env -i` must drop them. */
const callerEnv = (b: Box) => ({
	PATH: `${b.bin}:${SYS_PATH}`, HOME: "/nonexistent-home", GH_TOKEN: "ghp_secret", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai", MOONSHOT_API_KEY: "ms",
	SSH_AUTH_SOCK: "/tmp/agent.sock", OMP_TOKEN: "omp", AGENT_SYSTEM_TEST_RUNS: "/tmp/runs", AGENT_SYSTEM_LEDGER_DB: "/tmp/ledger.db", LANG: "C",
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
	const p = Bun.spawn(execArgv(c, exec), { env: callerEnv(b), stdout: "pipe", stderr: "pipe" });
	pids.push(p.pid);
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

// ---- the wrapper's argv checks ---------------------------------------------------------------------------

describe("the wrapper refuses bad argv", () => {
	const b = box("argv");
	setCurrent(b, "tr-a1");

	test("a run id outside ^tr-[a-z0-9]+$ is refused, by the sh wrapper and by test-exec itself", () => {
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
		for (const args of [["full"], ["full", "tr-a1", "x"], ["sweep", "tr-a1", "x"], ["prepare", "tr-a1"], ["prepare", "tr-a1", "a".repeat(40), "x"], ["solo", "tr-a1"],
			["solo", "tr-a1", "./a.test.ts", "./b.test.ts"], ["cleanup", "tr-a1"], ["cleanup", "tr-a1", "tr-b", "tr-c"], ["probe", "tr-a1"], ["bogus", "tr-a1"],
			["base-prepare", "tr-a1"], ["base-full", "tr-a1", "x"], ["base-solo", "tr-a1"], ["base-solo", "tr-a1", "./a.test.ts", "./b.test.ts"]]) {
			const r = raw(b, args);
			expect({ args, exit: r.exit }).toEqual({ args, exit: WRAPPER_EXIT.refused });
		}
	});

	test("prepare refuses a sha that is not 40 hex", () => {
		const r = raw(b, ["prepare", "tr-a1", "abc123"]);
		expect(r.exit).toBe(WRAPPER_EXIT.refused);
		expect(r.stderr).toContain("not a full sha");
	});

	test("without the wrapper's config test-exec refuses", () => {
		const r = Bun.spawnSync([BUN, SCRIPT, "full", "tr-a1"], { env: { PATH: SYS_PATH }, stderr: "pipe" });
		expect(r.exitCode).toBe(WRAPPER_EXIT.refused);
	});
});

describe("fencing on <stage>/current", () => {
	test("every subcommand is refused when current names another run", () => {
		const b = box("fence");
		const sha = prepared(b, "tr-mine", { "a.test.ts": OK_TEST });
		setCurrent(b, "tr-other");
		const calls: WrapperCall[] = [
			{ sub: "prepare", runId: "tr-mine", sha }, { sub: "full", runId: "tr-mine" }, { sub: "solo", runId: "tr-mine", file: "./a.test.ts" },
			{ sub: "base-prepare", runId: "tr-mine", sha }, { sub: "base-full", runId: "tr-mine" }, { sub: "base-solo", runId: "tr-mine", file: "./a.test.ts" },
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

	test("PLAN wl-mv8s8srodefytc rev 17.1 D8: base-prepare clones the same bundle into runs/<id>/base once; base-full and base-solo run there and report beside the PR's", () => {
		const b = box("base");
		const sha = prepared(b, "tr-b1", { "a.test.ts": OK_TEST, "b_spec.ts": `import { expect, test } from "bun:test";\ntest("bad", () => { expect(1).toBe(2); });\n` });
		const work = workOf(b, "tr-b1");
		// nothing runs on base before base-prepare
		expect(call(b, { sub: "base-full", runId: "tr-b1" }).exit).toBe(WRAPPER_EXIT.refused);
		expect(call(b, { sub: "base-prepare", runId: "tr-b1", sha }).exit).toBe(WRAPPER_EXIT.ok);
		expect(git(join(work, "base", "repo"), "rev-parse", "HEAD")).toBe(sha);
		expect(git(join(work, "base", "repo"), "remote")).toBe("");
		// a second base-prepare, or one over a base dir the PR's tests planted, is refused
		expect(call(b, { sub: "base-prepare", runId: "tr-b1", sha }).exit).toBe(WRAPPER_EXIT.refused);
		expect(call(b, { sub: "base-full", runId: "tr-b1" }).exit).toBe(1);
		expect(readFileSync(join(work, "base-full.xml"), "utf8")).toContain('name="bad"');
		expect(existsSync(join(work, "full.xml"))).toBe(false);
		const s = call(b, { sub: "base-solo", runId: "tr-b1", file: "./b_spec.ts" });
		expect(s.exit).toBe(1);
		expect(s.stdout).toStartWith("part base-solo-1\n");
		expect(readFileSync(join(work, "base-solo-1.xml"), "utf8")).toContain('name="bad"');
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
		// bun test sets NODE_ENV for its own tests; everything else is ours.
		expect(Object.keys(env).filter((k) => !(k in expected)).sort()).toEqual(Object.keys(env).filter((k) => k === "NODE_ENV"));
		for (const k of ["GH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "SSH_AUTH_SOCK", "OMP_TOKEN", "AGENT_SYSTEM_TEST_RUNS"]) expect(env[k]).toBeUndefined();
		for (const k of CHILD_ENV_ALLOWLIST) expect(env[k]).toBe(expected[k]!);
		expect(env.PATH).toBe(expected.PATH);
		expect(env.HOME).toBe(join(work, "home"));
		expect(env.AGENT_SYSTEM_LEDGER_DB).toBe(join(work, "home", ".agent-system-2", "ledger.db"));
		expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
	});

	test("the cap kills the part's whole group and exits timeout", async () => {
		const b = box("cap");
		prepared(b, "tr-c1", { "slow.test.ts": SLOW_TEST }, { fullCapMin: 0.04, soloCapMin: 0.04 });
		const t0 = Date.now();
		const r = call(b, { sub: "full", runId: "tr-c1" });
		expect(r.exit).toBe(WRAPPER_EXIT.timeout);
		expect(r.stderr).toContain("timeout");
		expect(Date.now() - t0).toBeLessThan(15_000);
		const pid = Number(readFileSync(join(workOf(b, "tr-c1"), "slow.pid"), "utf8"));
		pids.push(pid);
		expect(await until(() => !alive(pid), 3_000)).toBe(true);
	}, 30_000);

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

	test("with fullWorkers 3 the PR full part uses several workers and base-full one; no key, or 1, runs on one; a malformed value is refused", () => {
		const b = box("ser");
		const files = { "q1.test.ts": sleeper("1", 300), "q2.test.ts": sleeper("2", 300), "q3.test.ts": sleeper("3", 300) };
		const sha = prepared(b, "tr-ser1", files, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 3 });
		const work = workOf(b, "tr-ser1");
		expect(call(b, { sub: "full", runId: "tr-ser1" }).exit).toBe(0);
		expect(runners(work).size).toBeGreaterThan(1);
		expect(call(b, { sub: "base-prepare", runId: "tr-ser1", sha }).exit).toBe(WRAPPER_EXIT.ok);
		expect(call(b, { sub: "base-full", runId: "tr-ser1" }).exit).toBe(0);
		expect(runners(join(work, "base")).size).toBe(1);
		expect(readFileSync(join(work, "base-full.xml"), "utf8")).toContain('name="sleeps 3"');

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

	test("a parallel full part past its cap exits timeout, and after the sweep no worker and no worker's child is alive", async () => {
		const b = box("parcap");
		const hang = (name: string) =>
			`import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("hangs ${name}", async () => {\n\twriteFileSync("../pid-${name}", String(process.pid));\n\tconst c = Bun.spawn(["/bin/sleep", "300"]);\n\twriteFileSync("../child-${name}", String(c.pid));\n\tawait new Promise(() => {});\n}, 600_000);\n`;
		prepared(b, "tr-pc1", { "h1.test.ts": hang("1"), "h2.test.ts": hang("2"), "h3.test.ts": hang("3") }, { fullCapMin: 0.08, soloCapMin: 0.08, fullWorkers: 3 });
		const r = call(b, { sub: "full", runId: "tr-pc1" });
		expect(r.exit).toBe(WRAPPER_EXIT.timeout);
		expect(r.stderr).toContain("timeout");
		const work = workOf(b, "tr-pc1");
		const workers = [...runners(work)];
		const children = readdirSync(work).filter((n) => n.startsWith("child-")).map((n) => Number(readFileSync(join(work, n), "utf8")));
		pids.push(...workers, ...children);
		// Every file had started on its own worker before the cap fired.
		expect(workers).toHaveLength(3);
		expect(children).toHaveLength(3);
		const s = call(b, { sub: "sweep", runId: "tr-pc1" });
		expect(s.stderr).toBe("");
		expect(s.exit).toBe(WRAPPER_EXIT.ok);
		expect(await until(() => [...workers, ...children].every((pid) => !alive(pid)), 3_000)).toBe(true);
	}, 60_000);
});

// ---- sweep --------------------------------------------------------------------------------------------------

describe("sweep", () => {
	test("a groups sweep kills a detached grandchild of its own part and leaves a sibling fixture's process alive", async () => {
		const b = box("sweep");
		prepared(b, "tr-w1", { "orphan.test.ts": ORPHAN_TEST });
		expect(call(b, { sub: "full", runId: "tr-w1" }).exit).toBe(0);
		const orphan = Number(readFileSync(join(workOf(b, "tr-w1"), "orphan.pid"), "utf8"));
		pids.push(orphan);
		expect(alive(orphan)).toBe(true);
		const sibling = Bun.spawn(["/bin/sleep", "300"]);
		pids.push(sibling.pid);
		const r = call(b, { sub: "sweep", runId: "tr-w1" });
		expect(r.stderr).toBe("");
		expect(r.exit).toBe(WRAPPER_EXIT.ok);
		expect(await until(() => !alive(orphan), 3_000)).toBe(true);
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
		writeFileSync(join(b.hooks, "tr-l1.sweep-read1.pause"), "");
		const first = spawnCall(b, { sub: "sweep", runId: "tr-l1" });
		expect(await until(() => existsSync(join(b.hooks, "tr-l1.sweep-read1.reached")), 10_000)).toBe(true);
		rmSync(join(b.hooks, "tr-l1.sweep-read1.pause"));
		const second = spawnCall(b, { sub: "sweep", runId: "tr-l1" });
		// A real delay: the claim is that the second sweep is still blocked on the lock after it.
		await Bun.sleep(1_500);
		expect(second.exitCode).toBeNull();
		first.kill("SIGKILL");
		expect(await first.exited).not.toBe(0);
		const t0 = Date.now();
		expect(await second.exited).toBe(WRAPPER_EXIT.ok);
		expect(Date.now() - t0).toBeLessThan(3_000);
		expect(readdirSync(join(b.root, "locks"))).toEqual(["sweep.db"]);
	}, 30_000);

	test("a sweep that waits past its limit ends `error sweep lock held`", async () => {
		const b = box("held");
		const quick = wrapperFor(b, "exec-quick", { sweepLockWaitMs: 1_000 });
		setCurrent(b, "tr-h1");
		writeFileSync(join(b.hooks, "tr-h1.sweep-read1.pause"), "");
		const holder = spawnCall(b, { sub: "sweep", runId: "tr-h1" });
		expect(await until(() => existsSync(join(b.hooks, "tr-h1.sweep-read1.reached")), 10_000)).toBe(true);
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
		pids.push(orphan);
		writeFileSync(join(b.hooks, "tr-g1.sweep-read1.pause"), "");
		const sweep = spawnCall(b, { sub: "sweep", runId: "tr-g1" });
		expect(await until(() => existsSync(join(b.hooks, "tr-g1.sweep-read1.reached")), 10_000)).toBe(true);
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
		for (const extra of [{ hooks: "/tmp/h" }, { killGraceMs: 1 }, { sweepLockWaitMs: 1 }]) {
			expect(() => renderExecWrapper({ root: "/r", bun: "/b", script: "/s", sweepScope: "uid", ...extra })).toThrow(WrapperRenderError);
		}
		expect(() => renderExecWrapper({ root: "r", bun: "/b", script: "/s", sweepScope: "uid" })).toThrow(WrapperRenderError);
		expect(() => renderExecWrapper({ root: "/r", bun: "/b", script: "/s", sweepScope: "all" as SweepScope })).toThrow(WrapperRenderError);
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "uid" })).toMatchObject({ killGraceMs: 10_000, sweepLockWaitMs: 60_000, hooks: null });
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
		const read = (account: { uid: number; gid: number } | null = me) => readInstall({ checkout: REPO, libexec, root, sudoers, dscl: dscl(account) });
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
		/** The local bare origin the helper fetches main from. */
		bare: string;
		/** Commit these files on top of main and force-push them as main; returns the new sha. */
		commit: (files: Record<string, string>, message: string) => string;
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
		const bare = join(base, "origin.git");
		git(base, "clone", "-q", "--bare", work, bare);
		git(work, "remote", "add", "origin", bare);
		const commit = (files: Record<string, string>, message: string): string => {
			for (const [rel, text] of Object.entries(files)) writeFileSync(join(work, rel), text);
			git(work, "add", "-A");
			git(work, "commit", "-q", "-m", message);
			git(work, "push", "-q", "-f", "origin", "HEAD:refs/heads/main");
			return git(work, "rev-parse", "HEAD");
		};
		return { work, bare, commit };
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
	const buildDirs = () => readdirSync("/private/tmp").filter((n) => n.startsWith("as2test-refresh."));

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
	/** A tmp install as setup leaves it before the helper's first run: bun, refresh, refresh.d and the root; no exec, test-exec.js or SOURCE. */
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
			pids.push(p.pid);
			const [exit, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
			return { exit, stdout, stderr };
		};
		const decide = (checkout: string) => installDecision(readInstall({ checkout, libexec, root, sudoers, dscl: fakeDscl }), ids);
		return { base, libexec, root, state, facts, options, place, run, spawn, decide };
	}
	const sourceOf = (libexec: string) => {
		const s = parseSource(readFileSync(join(libexec, "SOURCE"), "utf8"));
		if (!s.ok) throw new Error(s.error);
		return s.source;
	};
	const sha12 = (sha: string) => sha.slice(0, 12);

	test("T5: it builds origin/main, never the caller's checkout, branch, env or git, and installDecision accepts the result", () => {
		const o = fixtureOrigin("t5");
		const mainSha = git(o.work, "rev-parse", "HEAD");
		// feature differs from main in a test-exec input; a bare repo whose main is feature is where a redirect would lead.
		expect(fixtureSources().has(INPUT)).toBe(true);
		git(o.work, "checkout", "-q", "-b", "feature");
		writeFileSync(join(o.work, INPUT), `${fixtureSources().get(INPUT)}// feature only\n`);
		git(o.work, "commit", "-q", "-am", "feature");
		git(o.work, "push", "-q", "origin", "feature");
		const featureBare = join(o.work, "..", "feature.git");
		git(o.work, "clone", "-q", "--bare", o.bare, featureBare);
		git(featureBare, "update-ref", "refs/heads/main", "refs/heads/feature");

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
		const before = buildDirs();
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
		const installed = Object.fromEntries(["exec", "bun", "test-exec.js", "refresh"].map((f) => [f, sha256(readFileSync(join(r.libexec, f)))]));
		expect(src.files).toEqual(installed);
		expect(readFileSync(join(r.libexec, "exec"), "utf8")).toBe(
			renderExecWrapper({ root: r.root, bun: join(r.libexec, "bun"), script: join(r.libexec, "test-exec.js"), sweepScope: "uid" }),
		);
		expect(statSync(join(r.libexec, "test-exec.js")).size).toBeGreaterThan(0);
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		expect(buildDirs().filter((d) => !before.includes(d))).toEqual([]);

		// The runner's checkout at main passes; the same checkout on feature is input drift on the file feature changed.
		git(o.work, "checkout", "-q", "main");
		expect(r.decide(o.work)).toMatchObject({ ok: true });
		git(o.work, "checkout", "-q", "feature");
		expect(r.decide(o.work)).toEqual({ ok: false, kind: "input-drift", reason: `${INPUT} in this checkout differs from the installed test-exec bundle` });
	}, 120_000);

	test("T5b: a legacy install (today's setup SOURCE: three file lines, a path in source) at main's sha is rebuilt, and the new installDecision accepts it", () => {
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
		expect(src.inputs).toEqual(built.inputs);
		expect(r.decide(o.work)).toMatchObject({ ok: true });
		expect(r.run()).toMatchObject({ exit: 0, stdout: `current ${sha12(mainSha)}\n` });
	}, 120_000);

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
		pids.push(holder.pid);
		expect(await until(() => existsSync(held), 10_000)).toBe(true);
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
			'import { writeFileSync as __wf } from "node:fs";',
			'if (process.argv[2] === "bundle-inputs") {',
			'\tprocess.on("SIGTERM", () => {});',
			`\t__wf(${JSON.stringify(started)}, String(process.pid));`,
			"\tBun.sleepSync(120_000);",
			"}",
			"",
		].join("\n");
		o.commit({ [AS2]: hang + fixtureSources().get(AS2)! }, "a bundle-inputs that hangs");
		const children: number[] = [];

		// A TERM to the helper: Jo's own signal to its own process, as a test render runs.
		const installed = tree(r.libexec, ["refresh.d"]);
		const before = buildDirs();
		const p = Bun.spawn([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		pids.push(p.pid);
		expect(await until(() => existsSync(started) && readFileSync(started, "utf8") !== "", 90_000)).toBe(true);
		children.push(Number(readFileSync(started, "utf8")));
		pids.push(children[0]!);
		const t0 = Date.now();
		process.kill(p.pid, "SIGTERM");
		const [exit, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
		expect({ exit, stdout }).toEqual({ exit: 71, stdout: "" });
		expect(stderr).toContain("as2test-refresh: ended by a signal; nothing was installed");
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		expect(buildDirs().filter((d) => !before.includes(d))).toEqual([]);
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
		expect(buildDirs().filter((d) => !before.includes(d))).toEqual([]);
		expect(tree(r.libexec, ["refresh.d"])).toEqual(placed);

		// The TERM-proof bundle-inputs of each run is gone.
		const alive = () =>
			children.filter((pid) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			});
		expect(await until(() => alive().length === 0, 5_000)).toBe(true);
	}, 240_000);

	test("T6: a TERM during a stalled staging install, a step that once ran in the foreground, exits 71 within seconds with no .new file, no build dir and the install unchanged; a second helper meanwhile waits on the lock and exits 69", async () => {
		const o = fixtureOrigin("t6-stall");
		const r = helperRig("t6-stall", o);
		expect(r.run()).toMatchObject({ exit: 0 });
		o.commit({ [INPUT]: `${fixtureSources().get(INPUT)}// main moved\n` }, "main moves");
		// Each staging install sleeps 30 s once its .new copy is written; a second helper waits 1 s for the lock.
		r.place({ stallS: 30, lockWaitS: 1 });
		const installed = tree(r.libexec, ["refresh.d"]);
		const before = buildDirs();
		const p = Bun.spawn([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		pids.push(p.pid);
		const stdout = new Response(p.stdout).text();
		const stderr = new Response(p.stderr).text();
		expect(await until(() => existsSync(join(r.libexec, ".exec.new")), 90_000)).toBe(true);
		expect(buildDirs().filter((d) => !before.includes(d))).toHaveLength(1);

		// While it holds refresh.d/lock, another refresh (the next run's, after the runner gave up on this one) gets 69 and touches nothing.
		const second = r.run();
		expect({ exit: second.exit, stdout: second.stdout }).toEqual({ exit: 69, stdout: "" });
		expect(second.stderr).toContain("another refresh holds");
		expect(existsSync(join(r.libexec, ".exec.new"))).toBe(true);
		expect(buildDirs().filter((d) => !before.includes(d))).toHaveLength(1);

		const t0 = Date.now();
		process.kill(p.pid, "SIGTERM");
		const exit = await p.exited;
		expect({ exit, stdout: await stdout }).toEqual({ exit: 71, stdout: "" });
		expect(await stderr).toContain("as2test-refresh: ended by a signal; nothing was installed");
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(readdirSync(r.libexec).filter((n) => n.endsWith(".new"))).toEqual([]);
		expect(buildDirs().filter((d) => !before.includes(d))).toEqual([]);
		expect(tree(r.libexec, ["refresh.d"])).toEqual(installed);
	}, 120_000);

	test("T6: a stalled cleanup removal is killed at the cleanup bound: the helper exits within it, names the build dir it left and frees the lock, and the next run removes that dir", async () => {
		const o = fixtureOrigin("t6-cleanup");
		const r = helperRig("t6-cleanup", o);
		const original = fixtureSources().get(TEST_EXEC)!;
		o.commit({ [TEST_EXEC]: "export const broken = ;\n" }, "does not compile");
		// The build user's removal of the build dir's src and out sleeps 30 s first; the cleanup bound is 2 s.
		r.place({ cleanupStallS: 30, cleanupS: 2 });
		const before = buildDirs();
		const p = Bun.spawn([join(r.libexec, "refresh")], { env: { PATH: SYS_PATH }, cwd: r.base, stdout: "pipe", stderr: "pipe" });
		pids.push(p.pid);
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
		// The dir it left is the one this run made: named on stderr, new since the run began, still there.
		const named = /as2test-refresh: left the build dir \/private\/tmp\/(as2test-refresh\.[A-Za-z0-9]{6}): its removal did not end within the 2 s cleanup bound\n/.exec(stderr);
		expect(named?.[1]).toBeString();
		const left = named![1]!;
		expect(before).not.toContain(left);
		expect(buildDirs()).toContain(left);

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
		for (const pid of [pg, child, escSh, esc, stranger]) pids.push(pid);
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
			expect(await until(() => ![pg, child, escSh, esc].some(alive), 5_000)).toBe(true);
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
		return { base, prefix, work, bare, libexec, root, sudoers, run, tree, sudoCalls, owners, account };
	}
	const sudoersLines = (libexec: string) => [`${JO} ALL=(_as2test) NOPASSWD: ${join(libexec, "exec")}`, `${JO} ALL=(root) NOPASSWD: ${join(libexec, "refresh")} ""`];

	test("--dry-run prints the dscl and sudoers plan with a free id >= 600, the helper's text and sha, and changes nothing (T8: no sudo call)", () => {
		const r = rig("setup-dry");
		const before = r.tree();
		const out = r.run(["--dry-run"]);
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
		expect(out.stdout).toContain(`fetches main from ${r.bare}`);
		expect(out.stdout).toMatch(new RegExp(`the refresh helper ${r.libexec}/refresh, sha-256 [0-9a-f]{64}, in full:\\n----- begin ${r.libexec}/refresh -----\\n#!/bin/sh\\n`));
		expect(out.stdout).toContain(`sudo -n ${r.libexec}/refresh`);
		expect(out.stdout).toContain("dry run: nothing changed");
		expect(r.tree()).toEqual(before);
		expect(r.sudoCalls()).toBe("");
	}, 60_000);

	test("T8: setup installs bun, the helper and both sudoers lines; its last sudo step runs the helper, which builds an install installDecision accepts; undo removes it all", () => {
		const r = rig("setup-t8");
		const mainSha = git(r.bare, "rev-parse", "refs/heads/main");
		const out = r.run([], "y\n");
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
		const facts = readInstall({ checkout: r.work, libexec: r.libexec, root: r.root, sudoers: r.sudoers, dscl: () => 602 });
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
		const out = r.run([], "y\n", env);
		expect(out.exit).toBe(1);
		expect(out.stderr).toContain(`fetching main from ${gone} failed`);
		expect(out.stderr).toContain("the refresh helper failed (its message is above); everything before it is in place, and the provisional SOURCE records it.");
		expect(out.stderr).toContain("The runner's next preflight finds exec and test-exec.js unbuilt (file-drift) and runs the helper again");
		expect(r.sudoCalls().trim().split("\n").at(-1)).toBe(`-n ${join(r.libexec, "refresh")}`);
		r.account(602, 602);
		return { r, gone, env };
	}
	/** installDecision over a setup rig's install, with the owners setup asked install for (the fence cannot chown). */
	function rigVerdict(r: { work: string; libexec: string; root: string; sudoers: string; owners: () => Map<string, [number, number]> }): InstallVerdict {
		const own = r.owners();
		const facts = readInstall({ checkout: r.work, libexec: r.libexec, root: r.root, sudoers: r.sudoers, dscl: () => 602 });
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

		// (b) A re-run takes the account it recorded and gets as far as the helper again.
		const again = r.run([], "y\n", env);
		expect(again.stderr).not.toContain("did not record");
		expect(again.stdout).toContain("group _as2test gid 602: exists (recorded)");
		expect(again.stdout).toContain("user _as2test uid 602: exists (recorded)");
		expect(again.exit).toBe(1);
		expect(again.stderr).toContain(`fetching main from ${gone} failed`);
		const reparsed = parseSource(readFileSync(join(r.libexec, "SOURCE"), "utf8"));
		expect(reparsed).toMatchObject({ ok: true, source: { sourceSha: "provisional", created: ["user", "group", r.root, r.libexec, r.sudoers] } });

		// (d) The cause fixed (the origin exists), the helper run again installs main over the provisional SOURCE.
		git(r.base, "clone", "-q", "--bare", r.bare, gone);
		const mainSha = git(gone, "rev-parse", "refs/heads/main");
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
			const ok = r.run(["--dry-run"], "", real);
			expect(ok.stderr).toBe("");
			expect(ok.exit).toBe(0);
			// The real render: the fixed https origin, built as nobody, root only.
			expect(ok.stdout).toContain("fetches main from https://github.com/thewolff/agent-system-2.0.git and builds it as nobody, run as root");
			expect(ok.stdout).toContain("/usr/bin/sudo -n -u 'nobody' ");
			expect(ok.stdout).toContain("must run as root");
		}
		expect(r.sudoCalls()).toBe("");
		git(r.work, "remote", "set-url", "origin", r.bare);

		// An untracked file is not a dirty checkout; a change to a tracked file is.
		writeFileSync(join(r.work, "untracked.txt"), "x\n");
		expect(r.run(["--dry-run"]).exit).toBe(0);
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
		const out = r.run([], "y\n");
		expect(out.exit).toBe(1);
		expect(out.stderr).toContain("visudo -cf rejects the drop-in; nothing changed");
		expect(r.tree()).toEqual(before);
		// The only privileged calls were the checks; no dscl, install or mv ran.
		expect(r.sudoCalls().trim().split("\n").map((l) => l.split(" ")[0])).toEqual(["visudo", "grep", "visudo"]);
	}, 30_000);

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
