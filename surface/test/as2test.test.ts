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
import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import * as as2test from "../src/as2test";
import {
	bundleInputs, CAPTURE_MS, CREDENTIAL_PATHS, execArgv, execConfigOf, type InstallVerdict, installDecision, installLayout, parseSource, preflightDecision,
	preflightProbes, probeCall, probeDecision, readInstall, renderExecWrapper, type SweepScope, UID_SWEEP, WrapperRenderError,
} from "../src/as2test";
import { STUCK_DEFAULTS } from "../src/stuck-detect";
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

const made: string[] = [];
/**
 * Removes the fixture dirs named in argv: chmod u+rwx every directory beneath (so a dir a test sealed can be emptied),
 * then rm -r. Run by a detached child, never in the hook: unlinking every fixture file took 9.5 s on a loaded machine
 * and timed out the afterAll (run tr-0mvskhqnl998o93), and the hook's job is only to start it.
 */
const REMOVE_FIXTURES = `const { chmodSync, lstatSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
function unseal(p) {
	let st;
	try { st = lstatSync(p); } catch { return; }
	if (!st.isDirectory()) return;
	chmodSync(p, 0o755);
	for (const n of readdirSync(p)) unseal(join(p, n));
}
for (const r of process.argv.slice(1)) {
	try { unseal(r); } catch {}
	rmSync(r, { recursive: true, force: true });
}
`;
const pids: number[] = [];
afterAll(() => {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	if (made.length > 0) Bun.spawn([BUN, "-e", REMOVE_FIXTURES, ...made], { cwd: "/", detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
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

/** The detector's test-only knobs a box's wrapper may carry (PLAN wl-mvq8x4pkjmx69s D3). */
interface DetectKnobs {
	detectTickMs?: number;
	detectPersistMs?: number;
	signatureCaptureMs?: number;
	stopGraceMs?: number;
	detectTrace?: boolean;
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
	const { script, killGraceMs, ...limits } = opts;
	writeFileSync(exec, renderExecWrapper({ root, bun: BUN, script: script ?? SCRIPT, sweepScope: "groups", hooks, killGraceMs: killGraceMs ?? 500, ...limits }), { mode: 0o755 });
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
			["base-prepare", "tr-a1"], ["base-solo", "tr-a1"], ["base-solo", "tr-a1", "./a.test.ts", "./b.test.ts"], ["fast", "tr-a1"]]) {
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
		// bun test sets NODE_ENV for its own tests; the executor adds the part's marker dir (PLAN wl-mvq8x4pkjmx69s D3); everything else is ours.
		expect(Object.keys(env).filter((k) => !(k in expected)).sort()).toEqual(Object.keys(env).filter((k) => k === "NODE_ENV" || k === "AS2TEST_STUCK_MARKERS").sort());
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
		pids.push(pid);
		expect(await until(() => !alive(pid), 3_000)).toBe(true);
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
		pids.push(sibling.pid);
		try {
			const r = call(b, { sub: "full", runId: "tr-dc1" });
			const work = workOf(b, "tr-dc1");
			const { group, child } = JSON.parse(readFileSync(join(work, "detached.json"), "utf8")) as { group: number; child: number };
			pids.push(group, child);
			expect(r.exit).toBe(WRAPPER_EXIT.timeout);
			expect(r.stderr).toContain("timeout: the part passed its cap of 2400 ms");
			// The leader cannot reap this detached group, and neither it nor its child cooperates with TERM.
			expect(readFileSync(join(work, "groups"), "utf8").split("\n").map(Number)).toContain(group);
			expect(readFileSync(join(work, "full.stuck.log"), "utf8")).toContain("capture cut");
			const s = call(b, { sub: "sweep", runId: "tr-dc1" });
			expect(s.stderr).toBe("");
			expect(s.exit).toBe(WRAPPER_EXIT.ok);
			expect(await until(() => !alive(group) && !alive(child), 3_000)).toBe(true);
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
				const completed = await until(() => p.exitCode !== null, 2_400 + 2_000 + 500 + 5_000);
				const { group, child } = JSON.parse(readFileSync(join(work, "detached.json"), "utf8")) as { group: number; child: number };
				const leader = Number(readFileSync(join(work, "leader.pid"), "utf8"));
				pids.push(leader, group, child);
				expect(existsSync(join(work, "groups-swapped"))).toBe(true);
				expect(completed).toBe(true);
				expect(p.exitCode).toBe(WRAPPER_EXIT.failed);
				const stderr = await new Response(p.stderr).text();
				expect(stderr).toContain("timeout: the part passed its cap of 2400 ms; its group was killed");
				expect(stderr).toContain(`timeout cleanup: cannot persist descendant groups to ${join(work, "groups")}`);
				expect(stderr).toContain("open failed:");
				expect(lstatSync(join(work, "groups"))[how === "fifo" ? "isFIFO" : "isSymbolicLink"]()).toBe(true);
				expect(readFileSync(target, "utf8")).toBe("UNCHANGED\n");
				// Do not sweep: its existing pathname read is unsafe for this deliberately hostile groups file.
				expect(await until(() => [leader, group, child].every((pid) => !alive(pid)), 3_000)).toBe(true);
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
		pids.push(...workers, ...children);
		// Every file had started on its own worker before the cap fired.
		expect(workers).toHaveLength(3);
		expect(children).toHaveLength(3);
		const capture = stuckSections(readFileSync(join(work, "full.stuck.log"), "utf8"));
		expect(treePids(capture["1"]!)).toEqual(expect.arrayContaining([...workers, ...children]));
		for (const w of workers) expect(capture["2"]).toContain(`$ /usr/bin/sample ${w} 3 -mayDie -file `);
		const s = call(b, { sub: "sweep", runId: "tr-pc1" });
		expect(s.stderr).toBe("");
		expect(s.exit).toBe(WRAPPER_EXIT.ok);
		expect(await until(() => [...workers, ...children].every((pid) => !alive(pid)), 3_000)).toBe(true);
	}, 90_000);
});

// ---- fast: the Mac fallback of the hosted fast check (PLAN wl-mvq4edbaf13vnk D4, R9) ----------------------------------

describe("fast: only the named ./ test files inside the clone, in one bun test call (PLAN wl-mvq4edbaf13vnk D4, R9)", () => {
	const CAPS = { fullCapMin: 1, soloCapMin: 1, fastCapMin: 1 };
	const FILES = { "a.test.ts": sleeper("a", 10), "dir/b_spec.ts": sleeper("b", 10, false), "c.test.ts": sleeper("c", 10), "dir/d.test.ts": sleeper("d", 10) };
	/** test-exec reached without the wrapper, as a caller that skipped the sh checks would. */
	const direct = (b: Box, args: string[]): Ran => {
		const r = Bun.spawnSync([BUN, SCRIPT, ...args], {
			env: { PATH: SYS_PATH, AS2TEST_EXEC_CONFIG: JSON.stringify(execConfigOf({ root: b.root, bun: BUN, script: SCRIPT, sweepScope: "groups" })) }, stdout: "pipe", stderr: "pipe",
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
		pids.push(pid);
		expect(await until(() => !alive(pid), 3_000)).toBe(true);
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
			expect(await until(() => p.exitCode !== null, 2_400 + 2_000 + 500 + 5_000)).toBe(true);
			expect(existsSync(`${hook}.reached`)).toBe(true);
			expect(existsSync(`${hook}.go`)).toBe(false);
			expect(p.exitCode).toBe(WRAPPER_EXIT.timeout);
			expect(await new Response(p.stderr).text()).toContain(TIMEOUT_LINE);
			const work = workOf(b, "tr-cut1");
			const pid = Number(readFileSync(join(work, "slow.pid"), "utf8"));
			pids.push(pid);
			expect(await until(() => !alive(pid), 3_000)).toBe(true);
			const text = readFileSync(join(work, "full.stuck.log"), "utf8");
			const cutAt = Number(/^capture cut at (\d+) ms$/m.exec(text)?.[1]);
			expect(cutAt).toBeGreaterThanOrEqual(2_000);
			expect(cutAt).toBeLessThan(3_000);
			// The tree was written before the hold; nothing after the cut was.
			expect(Object.keys(stuckSections(text))).toEqual(["1"]);
			expect(captureLeftovers(work)).toEqual([]);
			const tools = capturePids(text);
			expect(await until(() => tools.every((t) => !alive(t)), 2_000)).toBe(true);
		} finally {
			writeFileSync(`${hook}.go`, "");
		}
	}, 60_000);

	test("a cap dir filled by a same-account process with 20,000 entries never delays the kill: the group dies within captureMs + grace + slack of the capture's start, the file says the dir was left for after the kill, and the wrapper removes it before it exits timeout", async () => {
		const captureMs = 2_500;
		const b = box("fill", { captureMs });
		prepared(b, "tr-fill1", { "slow.test.ts": SLOW_TEST }, CAPS);
		const hook = join(b.hooks, "tr-fill1.stuck-capture");
		writeFileSync(`${hook}.pause`, "");
		// Empty directories: cheap to plant and dear to remove recursively (about 2 s for 20,000), so a recursive removal before
		// the kill would push the kill past the bound below. They are planted before the run, so the cap dir is filled by one
		// rename inside the capture window: 20,000 mkdirs there raced the deadline on a loaded host (tr-0mvs6sjezd3t06f).
		const filled = join(dir("fill-planted"), "planted");
		mkdirSync(filled);
		for (let i = 0; i < 20_000; i++) mkdirSync(join(filled, `planted-${i}`));
		const t0 = Date.now();
		const p = spawnCall(b, { sub: "full", runId: "tr-fill1" });
		try {
			expect(await until(() => existsSync(`${hook}.reached`), 2_400 + 5_000)).toBe(true);
			// The capture started before its hook was reached, so its deadline is at or before `at + captureMs`.
			const { at } = JSON.parse(readFileSync(`${hook}.reached`, "utf8")) as { at: number };
			const work = workOf(b, "tr-fill1");
			const pid = Number(readFileSync(join(work, "slow.pid"), "utf8"));
			pids.push(pid);
			const capDirs = readdirSync(work).filter((n) => n.startsWith("full.stuck-"));
			expect(capDirs).toHaveLength(1);
			const capDir = join(work, capDirs[0]!);
			// The planted dir takes the cap dir's place while it is still empty (the 3 s sample writes its report at its end),
			// all before the deadline, so the cut meets every entry.
			renameSync(filled, capDir);
			expect(readdirSync(capDir)).toHaveLength(20_000);
			expect(Date.now()).toBeLessThan(at + captureMs);
			expect(await until(() => !alive(pid), at + captureMs + 500 + 1_000 - Date.now())).toBe(true);
			expect(await until(() => p.exitCode !== null, 2_400 + captureMs + 500 + 8_000 - (Date.now() - t0))).toBe(true);
			expect(p.exitCode).toBe(WRAPPER_EXIT.timeout);
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
			const t0 = Date.now();
			const p = spawnCall(b, { sub: "full", runId });
			expect(await until(() => existsSync(`${hook}.reached`), 2_400 + CAPTURE_MS)).toBe(true);
			const { report } = JSON.parse(readFileSync(`${hook}.reached`, "utf8")) as { report: string };
			rmSync(report, { force: true });
			if (how === "fifo") expect(Bun.spawnSync(["/usr/bin/mkfifo", report]).exitCode).toBe(0);
			else symlinkSync(secret, report);
			writeFileSync(`${hook}.go`, "");
			expect(await until(() => p.exitCode !== null, 2_400 + CAPTURE_MS + 500 + 5_000 - (Date.now() - t0))).toBe(true);
			expect(p.exitCode).toBe(WRAPPER_EXIT.timeout);
			expect(await new Response(p.stderr).text()).toContain(TIMEOUT_LINE);
			const work = workOf(b, runId);
			pids.push(Number(readFileSync(join(work, "slow.pid"), "utf8")));
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
			pids.push(Number(readFileSync(join(work, "slow.pid"), "utf8")));
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
		pids.push(pid);
		const text = readFileSync(join(work, "solo-1.stuck.log"), "utf8");
		expect(Object.keys(stuckSections(text))).toEqual(["1", "2", "3", "4"]);
		expect(treePids(stuckSections(text)["1"]!)).toContain(pid);
		expect(text).toContain(`== 4. last 200 lines of ${join(work, "solo-1.log")} (`);
		expect(existsSync(join(work, "full.stuck.log"))).toBe(false);
		expect(captureLeftovers(work)).toEqual([]);
		expect(await until(() => !alive(pid), 3_000)).toBe(true);
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

/** The lines a positive spin fixture's test file starts with: flock from libSystem, as the preload binds it. */
const SPIN_HEAD = `import { test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "node:child_process";
import { closeSync, constants, ftruncateSync, openSync, writeFileSync, writeSync } from "node:fs";
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
`;
/**
 * A detached helper (its own process group) the spinning worker starts first: once the signature capture's file exists it
 * starts a second detached group (`sleep 300`) and records it in ../late.pid, then stays alive as its parent.
 */
const LATE_HELPER = `const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync("../helper.pid", String(process.pid));
const t = setInterval(() => {
	if (!fs.existsSync("../full.signature.log")) return;
	clearInterval(t);
	const s = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
	fs.writeFileSync("../late.pid", String(s.pid));
}, 25);
`;
/**
 * The positive fixture (PLAN sl-sd-exec): the observable lost-reap state built by hand. The test holds its own marker for
 * `true`, spawns /usr/bin/true asynchronously at once, then spins forever: marker active, the worker hot, the child an
 * unreaped zombie. With `late`, a detached helper group is started first (LATE_HELPER).
 */
const spinTest = (late: boolean) => `${SPIN_HEAD}test("spins", () => {
	writeFileSync("../spin.pid", String(process.pid));
${late ? `\tspawn(process.execPath, ["-e", ${JSON.stringify(LATE_HELPER)}], { detached: true, stdio: "ignore" });\n` : ""}	holdMarker("true");
	const z = ${unreapedTrue()};
	writeFileSync("../zombie.pid", String(z.pid));
	for (;;) {}
}, 600_000);
`;

/** The pid a fixture wrote to `<work>/<name>`, added to the pids afterAll kills. */
function fixturePid(work: string, name: string): number {
	const pid = Number(readFileSync(join(work, name), "utf8"));
	pids.push(pid);
	return pid;
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
 * The real preload's qualification fixture (PLAN sl-sd-exec). Each phase logs its window to ../qual.jsonl and idles 1 s after,
 * so the trace's 250 ms ticks see the marker during the call and its absence after. A phase whose command is "" must run with
 * no marker of this worker active at all: the call's arguments ran test code, so it is unpublished.
 */
const QUAL_TEST = `import { test } from "bun:test";
import * as cp from "node:child_process";
import { appendFileSync } from "node:fs";
const callFields = ${callFields.toString()};
const r3GetterCall = ${r3GetterCall.toString()};
const byteGetterCall = ${byteGetterCall.toString()};
const log = (o) => appendFileSync("../qual.jsonl", JSON.stringify(o) + "\\n");
const idle = (ms = 2_000) => Bun.sleep(ms);
// A real hot computation on the real clock: the detector samples this process's CPU over real 250 ms ticks, so no fake time.
const spin = (ms) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {}
};
async function phase(name, command, f) {
	const start = Date.now();
	const out = f();
	const end = Date.now();
	log({ name, command, start, end, out });
	await idle();
}
test("qualifies", async () => {
	const marker = process.env.AS2TEST_STUCK_MARKERS + "/" + process.pid;
	log({ name: "start", pid: process.pid, preloadGlobal: globalThis.__fixturePreload ?? null, wrapped: Bun.spawnSync[Symbol.for("as2test.stuck-marker")] === true });
	await idle();
	await phase("bun", "sleep", () => Bun.spawnSync(["/bin/sleep", "2"]).exitCode);
	// Plain data in every option (helpers.ts's sh shape, a spread of process.env): published. process.env itself is not plain
	// data in bun (TZ and the proxy variables are accessors), so a call given it runs unpublished.
	await phase("bun-options-no-bytes", "sleep", () => Bun.spawnSync(["/bin/sleep", "2"], { cwd: "/", env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }).exitCode);
	// Review r4: bytes in any option (here a Buffer stdin) run unpublished, since bun looks up a byte container's
	// Symbol.asyncIterator, own or inherited, before it takes the bytes.
	await phase("bun-options", "", () => Bun.spawnSync(["/bin/sleep", "2"], { cwd: "/", env: { ...process.env }, stdin: Buffer.from("x"), stdout: "pipe", stderr: "pipe" }).exitCode);
	await phase("node-spawnSync", "sleep", () => cp.spawnSync("/bin/sleep", ["2"]).status);
	await phase("node-execSync", "sh", () => cp.execSync("/bin/sleep 2; echo slept").toString());
	await phase("node-execFileSync", "sleep", () => cp.execFileSync("/bin/sleep", ["2"]).toString());
	// node's own options object with cwd, env, timeout and no input: published.
	await phase("node-options-no-input", "sleep", () => cp.spawnSync("/bin/sleep", ["2"], { cwd: "/", env: { PATH: "/bin" }, timeout: 30_000, encoding: "utf8" }).status);
	// The same with input (node puts a Buffer in its stdio array): unpublished (review r4).
	await phase("node-options", "", () => cp.spawnSync("/bin/sleep", ["2"], { cwd: "/", env: { PATH: "/bin" }, input: "x", timeout: 30_000, encoding: "utf8" }).status);
	// Review r4: a hot 1.2 s Symbol.asyncIterator getter on a Buffer stdin (own, then inherited from a subclass prototype) and on
	// node's execFileSync input, which bun runs before it takes the bytes, then the 1 s sleep itself: all unpublished.
	await phase("byte-own-getter", "", () => byteGetterCall(cp, "own", ["/bin/sleep", "1"], () => spin(1_200)));
	await phase("byte-inherited-getter", "", () => byteGetterCall(cp, "inherited", ["/bin/sleep", "1"], () => spin(1_200)));
	await phase("byte-node-input-getter", "", () => byteGetterCall(cp, "node-input", ["/bin/sleep", "1"], () => spin(1_200)));
	// Test code the original runs while it reads its arguments: a hot 1.2 s getter, then the 1 s sleep itself, all unpublished.
	await phase("argv-getter", "", () => {
		const argv = ["/bin/sleep"];
		Object.defineProperty(argv, 1, { enumerable: true, get() {
			spin(1_200);
			return "1";
		} });
		return Bun.spawnSync(argv).exitCode;
	});
	await phase("cwd-getter", "", () => Bun.spawnSync(["/bin/sleep", "1"], { get cwd() {
		spin(1_200);
		return "/";
	} }).exitCode);
	await phase("env-getter", "", () => Bun.spawnSync(["/bin/sleep", "1"], { env: { get PATH() {
		spin(1_200);
		return "/bin";
	} } }).exitCode);
	// Review r3: an env array with an enumerable named getter (bun runs it), and an Object.prototype accessor beside a {} options
	// object (bun 1.3.14 stops its option lookups before Object.prototype, so this getter does not run: the call is unpublished
	// because Object.prototype is not clean): both unpublished throughout.
	await phase("env-array-getter", "", () => r3GetterCall("env-array", ["/bin/sleep", "1"], () => spin(1_200)));
	await phase("proto-cwd-getter", "", () => r3GetterCall("proto-cwd", ["/bin/sleep", "2"], () => spin(1_200)));
	await phase("fields", null, () => callFields(cp));
	// A nested call from inside the call's own argv accessor (read by spawnSync itself): neither the outer head nor the nested
	// sh publishes, so both read the same, earlier marker line.
	await phase("nested-accessor", "", () => {
		let inner = null;
		const argv = ["/usr/bin/head", "-c", "200"];
		Object.defineProperty(argv, 3, { enumerable: true, get() {
			inner = Bun.spawnSync(["/bin/sh", "-c", 'cat "$0"; exec /bin/sleep 2', marker]);
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
	await idle();
	try {
		await phase("immutable", null, () => ({ uchg, sleep: Bun.spawnSync(["/bin/sleep", "2"]).exitCode, node: cp.spawnSync("/bin/sleep", ["1"]).status, fields: callFields(cp) }));
	} finally {
		log({ name: "nouchg", out: Bun.spawnSync(["/usr/bin/chflags", "nouchg", marker]).exitCode });
	}
	await idle();
	const start = Date.now();
	const child = Number(Bun.spawnSync(["/bin/sh", "-c", "/bin/sleep 4 >/dev/null 2>&1 & echo $!"]).stdout.toString().trim());
	const end = Date.now();
	await idle(1_500);
	// lsof is itself a published call of this worker; the test's after-window for this phase ends before it starts.
	const lsofAt = Date.now();
	const lsof = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-p", String(child)]);
	let alive = true;
	try {
		process.kill(child, 0);
	} catch {
		alive = false;
	}
	log({ name: "inherit", command: null, start, end, next: lsofAt, out: { child, alive, lsofExit: lsof.exitCode, holdsMarker: lsof.stdout.toString().includes(marker), lsofHasSleep: lsof.stdout.toString().includes("sleep") } });
}, 240_000);
`;

describe("the stuck-worker detector in the executor (PLAN wl-mvq8x4pkjmx69s D3)", () => {
	test("the real preload: a bunfig preload still runs beside it; Bun.spawnSync and node's spawnSync, execSync and execFileSync publish a marker during the call and none after, plain-data options included, return and throw what they would unwrapped, run test-owned accessors and proxy traps exactly as often as unwrapped (a throwing one included), run a call whose argv or options hold a getter (an env array's included) or that meets an Object.prototype accessor unpublished (during the getter and the call), run a call carrying bytes (a Buffer stdin, node's input) unpublished, an own or inherited Symbol.asyncIterator getter on them included, publish no call nested in such a getter, an immutable marker only stops publication, and the marker fd is not inherited", () => {
		const b = box("stuck-qual", DETECT);
		prepared(b, "tr-sq1", {
			"bunfig.toml": `[test]\npreload = ["./setup.ts"]\n`,
			"setup.ts": "(globalThis as Record<string, unknown>).__fixturePreload = 1;\n",
			"qual.test.ts": QUAL_TEST,
			"a.test.ts": OK_TEST,
		}, { fullCapMin: 5, soloCapMin: 5, fullWorkers: 2, stuckStop: "enforce" });
		const r = call(b, { sub: "full", runId: "tr-sq1" });
		const work = workOf(b, "tr-sq1");
		expect(r.stderr).toBe("");
		expect(r.exit).toBe(0);
		// No signature ever forms: the worker blocks in each call (never hot) and no child is left unreaped.
		expect(keywordsOf(r.stdout)).toEqual([]);
		const rows = readFileSync(join(work, "qual.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string; command: string | null; start: number; end: number; next?: number; out: unknown; pid?: number; preloadGlobal?: unknown; wrapped?: boolean });
		const byName = Object.fromEntries(rows.map((x) => [x.name, x]));
		expect(byName.start).toMatchObject({ preloadGlobal: 1, wrapped: true });
		const w = byName.start!.pid!;
		// A worker of --parallel=2, not the leader.
		expect(w).not.toBe(Number(readFileSync(join(work, "groups"), "utf8").split("\n")[0]));
		const trace = traceOf(work);
		expect(trace.every((t) => t.snap === "ok")).toBe(true);
		const mine = (t: TraceRow) => activeAt(t).filter((m) => m.pid === w);
		const ticks = (from: number, to: number) => trace.filter((t) => t.at > from && t.at < to);
		const phases = rows.filter((x) => typeof x.start === "number");
		for (const [i, p] of phases.entries()) {
			// The worker's next spawn call: the next phase's, or the one a phase names itself (inherit's lsof).
			const next = phases[i + 1]?.start ?? p.next ?? p.end + 2_000;
			const during = ticks(p.start + 300, p.end - 300);
			if (p.command !== null) {
				expect({ phase: p.name, during: during.length }).toEqual({ phase: p.name, during: expect.any(Number) });
				expect(during.length).toBeGreaterThanOrEqual(3);
				for (const t of during) {
					expect({ phase: p.name, at: t.at, markers: mine(t).map((m) => m.command) }).toEqual({ phase: p.name, at: t.at, markers: p.command === "" ? [] : [p.command] });
					if (p.command === "") continue;
					expect(mine(t)[0]!.since).toBeGreaterThanOrEqual(p.start);
					expect(mine(t)[0]!.since).toBeLessThanOrEqual(p.end);
				}
			}
			// Each phase idles 2 s after its call, so a loaded machine's late 250 ms ticks still land in this window.
			const after = ticks(p.end + 300, Math.min(p.end + 2_000, next) - 50);
			expect(after.length).toBeGreaterThanOrEqual(1);
			for (const t of after) expect({ phase: p.name, at: t.at, markers: mine(t) }).toEqual({ phase: p.name, at: t.at, markers: [] });
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
		// Immutable marker: chflags worked, every call still returned what it would, and no marker was active in its window.
		const imm = byName.immutable!;
		expect(imm.out).toEqual({ uchg: 0, sleep: 0, node: 0, fields: plain });
		const immTicks = ticks(imm.start + 100, imm.end - 100);
		expect(immTicks.length).toBeGreaterThanOrEqual(3);
		for (const t of immTicks) expect(mine(t)).toEqual([]);
		expect(byName.nouchg!.out).toBe(0);
		// Not inherited: the backgrounded sleep outlived the call, holds no marker fd, and the marker was inactive meanwhile.
		expect(byName.inherit!.out).toMatchObject({ alive: true, lsofExit: 0, holdsMarker: false, lsofHasSleep: true });
		// The part's marker dir and preload are gone; the trace and nothing else of the detector's is left.
		expect(existsSync(join(work, "stuck-markers-full"))).toBe(false);
		expect(existsSync(join(work, "stuck-preload-full.js"))).toBe(false);
	}, 360_000);

	test("enforce: the spin fixture gets a signature line, stuck-stop, a signature capture, a teardown of every owned group (a group created during the capture included) and exit 125 within persist + capture + teardown + slack; capture tools, marker dir and preload are gone", async () => {
		// A capture budget past the default, so the held hook and a loaded machine's slow sample still leave all five sections
		// (the cut at the budget is the stuck-cut test's).
		const knobs = { ...DETECT, signatureCaptureMs: 10_000 };
		const b = box("stuck-enforce", knobs);
		prepared(b, "tr-se1", { "spin.test.ts": spinTest(true), "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
		const work = workOf(b, "tr-se1");
		const hook = join(b.hooks, "tr-se1.signature-capture");
		writeFileSync(`${hook}.pause`, "");
		const p = spawnCall(b, { sub: "full", runId: "tr-se1" });
		try {
			// Hold the capture until the helper has made its second group: that group is new during the capture.
			expect(await until(() => existsSync(`${hook}.reached`), 30_000)).toBe(true);
			expect(await until(() => existsSync(join(work, "late.pid")), 2_000)).toBe(true);
		} finally {
			writeFileSync(`${hook}.go`, "");
		}
		const code = await p.exited;
		const exitedAt = Date.now();
		const stdout = await new Response(p.stdout).text();
		const stderr = await new Response(p.stderr).text();
		const worker = fixturePid(work, "spin.pid");
		const zombie = fixturePid(work, "zombie.pid");
		const helper = fixturePid(work, "helper.pid");
		const late = fixturePid(work, "late.pid");
		const leader = Number(readFileSync(join(work, "groups"), "utf8").split("\n")[0]);
		report({ fixture: "enforce", exit: code, stdout, stderr });
		expect(worker).not.toBe(leader);
		expect(code).toBe(WRAPPER_EXIT.stuck);
		const { first, sig, stop, captured, killed } = enforceLines(stdout, worker, zombie);
		expect(sig.rest).toMatch(new RegExp(`^worker ${worker} zombie ${zombie} since \\d+ mode enforce bun ${Bun.version.replaceAll(".", "\\.")} ${Bun.revision}$`));
		expect(captured.rest).toMatch(/^file full\.signature\.log ms \d+$/);
		const k = /^pgids ([\d,]+) ms (\d+) contained$/.exec(killed.rest);
		expect(k).not.toBeNull();
		const stopSet = k![1]!.split(",").map(Number);
		// The leader's group (the worker's too), the helper's and the one made during the capture.
		expect(stopSet).toEqual(expect.arrayContaining([leader, helper, late]));
		expect(stderr).toMatch(new RegExp(`^stuck: worker ${worker} spun \\d+ ms in Bun\\.spawnSync with unreaped child ${zombie}; ${stopSet.length} process groups killed, containment contained\\n$`));
		const spun = Number(/ spun (\d+) ms /.exec(stderr)![1]);
		expect(spun).toBeGreaterThanOrEqual(DETECT.detectPersistMs);
		expect(Date.parse(stop.iso) - Date.parse(sig.iso)).toBeGreaterThanOrEqual(DETECT.detectPersistMs - 50);
		// The budget runs from the matching signature's first tick (PLAN § Budget).
		const signatureToExit = exitedAt - Date.parse(sig.iso);
		expect(signatureToExit).toBeLessThan(DETECT.detectPersistMs + knobs.signatureCaptureMs + STUCK_DEFAULTS.stopGraceMs + STUCK_DEFAULTS.verifyMs + 3_000);
		report({ fixture: "enforce", signatureToExitMs: signatureToExit, firstSignatureToExitMs: exitedAt - Date.parse(first.iso), stopToExitMs: exitedAt - Date.parse(stop.iso) });
		// Every owned process and group is gone, with no sweep.
		for (const pid of [leader, worker, helper, late]) expect({ pid, alive: alive(pid) }).toEqual({ pid, alive: false });
		for (const g of stopSet) expect({ g, alive: alive(-g) }).toEqual({ g, alive: false });
		const groups = readFileSync(join(work, "groups"), "utf8").split("\n").filter(Boolean).map(Number);
		expect(groups).toEqual(expect.arrayContaining(stopSet));
		// The signature capture: tree, marker, sample, lsof, log tail; its tools are gone and its cap dir cleared.
		const text = readFileSync(join(work, "full.signature.log"), "utf8");
		expect(text).toContain(`signature capture of full: worker ${worker} spun `);
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
		test(`enforce: refuses a ${how} groups file after the stop decision, still kills every owned group and preserves the stuck cause with unconfirmed cleanup`, async () => {
			const signatureCaptureMs = 10_000;
			const b = box(`stuck-groups-${how}`, { ...DETECT, signatureCaptureMs });
			const runId = how === "fifo" ? "tr-sef1" : "tr-ses1";
			prepared(b, runId, { "spin.test.ts": spinTest(true), "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
			const work = workOf(b, runId);
			const hook = join(b.hooks, `${runId}.signature-capture`);
			const target = join(work, "groups-target");
			writeFileSync(target, "UNCHANGED\n");
			writeFileSync(`${hook}.pause`, "");
			const p = spawnCall(b, { sub: "full", runId });
			try {
				// The watch has stopped: only enforce teardown will persist after this replacement.
				expect(await until(() => existsSync(`${hook}.reached`), 30_000)).toBe(true);
				expect(await until(() => existsSync(join(work, "late.pid")), 2_000)).toBe(true);
				const worker = fixturePid(work, "spin.pid");
				const zombie = fixturePid(work, "zombie.pid");
				const helper = fixturePid(work, "helper.pid");
				const late = fixturePid(work, "late.pid");
				const leader = Number(readFileSync(join(work, "groups"), "utf8").split("\n")[0]);
				pids.push(leader);
				rmSync(join(work, "groups"));
				if (how === "fifo") expect(Bun.spawnSync(["/usr/bin/mkfifo", join(work, "groups")], { timeout: 1_000 }).exitCode).toBe(0);
				else symlinkSync(target, join(work, "groups"));
				writeFileSync(`${hook}.go`, "");
				expect(await until(() => p.exitCode !== null, signatureCaptureMs + STUCK_DEFAULTS.stopGraceMs + STUCK_DEFAULTS.verifyMs + 3_000)).toBe(true);
				expect(p.exitCode).toBe(WRAPPER_EXIT.stuck);
				const stdout = await new Response(p.stdout).text();
				const stderr = await new Response(p.stderr).text();
				const { killed } = enforceLines(stdout, worker, zombie);
				const k = /^pgids ([\d,]+) ms \d+ unconfirmed cleanup-failed$/.exec(killed.rest);
				expect(k).not.toBeNull();
				const stopSet = k![1]!.split(",").map(Number);
				expect(stopSet).toEqual(expect.arrayContaining([leader, helper, late]));
				expect(stderr).toContain(`stuck: worker ${worker} spun `);
				expect(stderr).toContain(`in Bun.spawnSync with unreaped child ${zombie};`);
				expect(stderr).toContain("containment unconfirmed:");
				expect(stderr).toContain(`timeout cleanup: cannot persist descendant groups to ${join(work, "groups")}: open failed:`);
				expect(lstatSync(join(work, "groups"))[how === "fifo" ? "isFIFO" : "isSymbolicLink"]()).toBe(true);
				expect(readFileSync(target, "utf8")).toBe("UNCHANGED\n");
				// Do not sweep a hostile groups path; teardown must contain the processes itself.
				expect(await until(() => [leader, worker, helper, late].every((pid) => !alive(pid)) && stopSet.every((g) => !alive(-g)), 3_000)).toBe(true);
			} finally {
				writeFileSync(`${hook}.go`, "");
				if (p.exitCode === null) p.kill("SIGKILL");
				await p.exited;
			}
		}, 60_000);
	}

	test("shadow (caps.json without stuckStop): the spin fixture gets stuck-would-stop and a signature capture, nothing is stopped, and the part runs on to its cap and exits 124 as before", async () => {
		// The enforce tests' capture budget, so a loaded machine's slow sample still leaves all five sections (the cut at the
		// budget is the stuck-cut test's). Started before 7 s, it ends inside the exit bound below.
		const b = box("stuck-shadow", { ...DETECT, signatureCaptureMs: 10_000 });
		prepared(b, "tr-ss1", { "spin.test.ts": spinTest(false), "a.test.ts": OK_TEST }, { fullCapMin: 0.15, soloCapMin: 0.15, fullWorkers: 2 });
		const t0 = Date.now();
		const r = call(b, { sub: "full", runId: "tr-ss1" });
		const work = workOf(b, "tr-ss1");
		const worker = fixturePid(work, "spin.pid");
		const zombie = fixturePid(work, "zombie.pid");
		expect(r.exit).toBe(WRAPPER_EXIT.timeout);
		expect(r.stderr).toBe("as2test: timeout: the part passed its cap of 9000 ms; its group was killed\n");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(9_000);
		expect(Date.now() - t0).toBeLessThan(9_000 + CAPTURE_MS + 500 + 5_000);
		const lines = detectorLines(r.stdout);
		// Only this signature's lines; a flap (a tick under the hot share on a loaded machine) may clear and restart it.
		for (const l of lines) {
			expect(["stuck-signature", "stuck-cleared", "stuck-would-stop", "stuck-captured"]).toContain(l.keyword);
			expect(new Date(l.iso).toISOString()).toBe(l.iso);
			if (l.keyword !== "stuck-captured") expect(l.rest).toStartWith(`worker ${worker} zombie ${zombie}`);
		}
		const would = lines.findIndex((l) => l.keyword === "stuck-would-stop");
		expect(would).toBeGreaterThan(0);
		const sig = lines[would - 1]!;
		expect(sig.keyword).toBe("stuck-signature");
		expect(sig.rest).toMatch(new RegExp(`^worker ${worker} zombie ${zombie} since \\d+ mode shadow bun `));
		expect(lines[would]!.rest).toBe(`worker ${worker} zombie ${zombie}`);
		expect(lines.filter((l) => l.keyword === "stuck-captured").map((l) => l.rest)).toEqual([expect.stringMatching(/^file full\.signature\.log ms \d+$/)]);
		// The would-stop came at the persistence, long before the cap: the part ran on untouched.
		expect(Date.parse(lines[would]!.iso) - Date.parse(sig.iso)).toBeGreaterThanOrEqual(DETECT.detectPersistMs - 50);
		expect(Date.parse(lines[would]!.iso) - t0).toBeLessThan(9_000 - 2_000);
		report({ fixture: "shadow", stdout: r.stdout, stderr: r.stderr });
		expect(Object.keys(signatureSections(readFileSync(join(work, "full.signature.log"), "utf8")))).toEqual(["1", "2", "3", "4", "5"]);
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
		expect(await until(() => !alive(worker), 3_000)).toBe(true);
		expect(existsSync(join(work, "stuck-markers-full"))).toBe(false);
		expect(existsSync(join(work, "stuck-preload-full.js"))).toBe(false);
	}, 90_000);

	test("a signature capture whose tools are still running at its deadline is cut there: every capture group is SIGKILLed, the file says so, and the stop still exits 125 within the bound", async () => {
		const signatureCaptureMs = 600;
		const b = box("stuck-cut", { ...DETECT, signatureCaptureMs });
		prepared(b, "tr-sk1", { "spin.test.ts": spinTest(false), "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
		const work = workOf(b, "tr-sk1");
		// Never released: sample (1 s) cannot finish inside 600 ms either.
		const hook = join(b.hooks, "tr-sk1.signature-capture");
		writeFileSync(`${hook}.pause`, "");
		const p = spawnCall(b, { sub: "full", runId: "tr-sk1" });
		try {
			const code = await p.exited;
			const exitedAt = Date.now();
			const stdout = await new Response(p.stdout).text();
			const worker = fixturePid(work, "spin.pid");
			const zombie = fixturePid(work, "zombie.pid");
			expect(code).toBe(WRAPPER_EXIT.stuck);
			expect(existsSync(`${hook}.reached`)).toBe(true);
			const { sig } = enforceLines(stdout, worker, zombie);
			expect(exitedAt - Date.parse(sig.iso)).toBeLessThan(DETECT.detectPersistMs + signatureCaptureMs + STUCK_DEFAULTS.stopGraceMs + STUCK_DEFAULTS.verifyMs + 3_000);
			const text = readFileSync(join(work, "full.signature.log"), "utf8");
			const cutAt = Number(/^capture cut at (\d+) ms$/m.exec(text)?.[1]);
			expect(cutAt).toBeGreaterThanOrEqual(signatureCaptureMs);
			expect(cutAt).toBeLessThan(signatureCaptureMs + 1_000);
			expect(Object.keys(signatureSections(text))).toEqual(["1", "2"]);
			const killed = /^killed capture groups: (.*)$/m.exec(text)?.[1] ?? "";
			expect(killed).toMatch(/^\d+( \d+)*$/);
			const tools = capturePids(text);
			expect(await until(() => tools.every((t) => !alive(t)), 2_000)).toBe(true);
			expect(readdirSync(work).filter((n) => n.startsWith("full.signature-"))).toEqual([]);
		} finally {
			writeFileSync(`${hook}.go`, "");
		}
	}, 90_000);

	test("a caps.json stuckStop other than shadow or enforce is refused for full and solo", () => {
		for (const bad of ["on", true, null, 1]) {
			const b = box("stuck-bad");
			prepared(b, "tr-sb1", { "a.test.ts": OK_TEST }, { fullCapMin: 1, soloCapMin: 1, stuckStop: bad });
			for (const c of [{ sub: "full", runId: "tr-sb1" }, { sub: "solo", runId: "tr-sb1", file: "./a.test.ts" }] as WrapperCall[]) {
				const r = call(b, c);
				expect(r.exit).toBe(WRAPPER_EXIT.refused);
				expect(r.stderr).toContain("stuckStop");
			}
		}
	});

	describe("negative controls: each part ends normally with no signature and no decision (enforce, --parallel=2)", () => {
		/** One test file per control; `<name>.pid` is the worker's pid. Each runs about 6 s. */
		const LOOP = "const end = Date.now() + 6_000;\n\twhile (Date.now() < end) {}";
		/**
		 * The getter controls' hot computation: as long as LOOP, well past the persistence, so a loaded machine whose late
		 * executor ticks miss part of it still sees the unmarked zombie over MEANINGFUL_SPAN_MS.
		 */
		const GETTER_HOT_MS = 6_000;
		const fixtures: Record<string, Record<string, string>> = {
			"zombie-no-marker": {
				"c.test.ts": `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("c", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\t${unreapedTrue()};\n\t${LOOP}\n}, 60_000);\n`,
			},
			"returned-call-then-zombie": {
				"c.test.ts": `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("c", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tBun.spawnSync(["/usr/bin/true"]);\n\t${unreapedTrue()};\n\t${LOOP}\n}, 60_000);\n`,
			},
			"immutable-marker": {
				"c.test.ts": `import { test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { writeFileSync } from "node:fs";
const { chflags } = dlopen("/usr/lib/libSystem.B.dylib", { chflags: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 } }).symbols;
test("c", () => {
	writeFileSync("../w.pid", String(process.pid));
	const marker = Buffer.from(process.env.AS2TEST_STUCK_MARKERS + "/" + process.pid + "\\0");
	// UF_IMMUTABLE, as chflags uchg; cleared again so the executor can remove the dir.
	if (chflags(marker, 2) !== 0) throw new Error("chflags uchg failed");
	try {
		Bun.spawnSync(["/usr/bin/true"]);
		${unreapedTrue()};
		${LOOP}
	} finally {
		chflags(marker, 0);
	}
}, 60_000);
`,
			},
			"long-async": {
				"c.test.ts": `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("c", async () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tawait Bun.sleep(6_000);\n}, 60_000);\n`,
			},
			"sync-sleep": {
				"c.test.ts": `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("c", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tBun.spawnSync(["/bin/sleep", "3"]);\n}, 60_000);\n`,
			},
			"printer-beside-idle": {
				"c.test.ts": `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("prints", () => {\n\twriteFileSync("../w.pid", String(process.pid));\n\tconst end = Date.now() + 6_000;\n\twhile (Date.now() < end) console.log("x".repeat(100));\n}, 60_000);\n`,
				"d.test.ts": `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("idles", async () => {\n\twriteFileSync("../idle.pid", String(process.pid));\n\tawait Bun.sleep(6_000);\n}, 60_000);\n`,
			},
			// The positive fixture but for the zombie's parent: a sleeping process of the fixture, not the hot marked worker.
			"zombie-of-a-sleeper": {
				"c.test.ts": `${SPIN_HEAD}test("c", () => {
	writeFileSync("../w.pid", String(process.pid));
	const fd = holdMarker("true");
	Bun.spawn(["/bin/sh", "-c", "/usr/bin/true & exec /bin/sleep 8"]);
	${LOOP}
	closeSync(fd);
}, 60_000);
`,
			},
			// Review r2 finding 1: healthy test code inside the call's own argv getter (an async /usr/bin/true born at once, then a
			// hot computation past the persistence) while the original Bun.spawnSync(["/usr/bin/true", …]) reads its arguments.
			"argv-getter": {
				"c.test.ts": `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("c", () => {
	writeFileSync("../w.pid", String(process.pid));
	const argv = ["/usr/bin/true"];
	Object.defineProperty(argv, 1, { enumerable: true, get() {
		${unreapedTrue()};
		const end = Date.now() + ${GETTER_HOT_MS};
		while (Date.now() < end) {}
		return "x";
	} });
	if (Bun.spawnSync(argv).exitCode !== 0) throw new Error("true failed");
}, 60_000);
`,
			},
			// Review r3: the same healthy getter outside the options' own data, run through r3GetterCall with argv ["/usr/bin/true"]:
			// a `cwd` accessor on Object.prototype under a {} options object, and an env array with an enumerable named getter. A
			// real 3 s idle after the call keeps the part alive for the trace's 10 real-clock ticks when the getter does not run (the
			// detector samples the real process over real 250 ms ticks, so fake timers cannot stand in).
			...Object.fromEntries((["proto-cwd", "env-array"] as const).map((shape) => [`${shape}-getter`, {
				"c.test.ts": `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
const r3GetterCall = ${r3GetterCall.toString()};
test("c", async () => {
	writeFileSync("../w.pid", String(process.pid));
	const out = r3GetterCall("${shape}", ["/usr/bin/true"], () => {
		${unreapedTrue()};
		const end = Date.now() + ${GETTER_HOT_MS};
		while (Date.now() < end) {}
	});
	writeFileSync("../out.json", JSON.stringify(out));
	await Bun.sleep(3_000);
}, 60_000);
`,
			}])),
			// Review r4: the same healthy getter as a Symbol.asyncIterator getter on a Buffer stdin, which bun looks up before it
			// takes the bytes, run through byteGetterCall("own") with argv ["/usr/bin/true"]; the same real 3 s idle after (the
			// detector samples the real process over real 250 ms ticks, so fake timers cannot stand in).
			"byte-stdin-getter": {
				"c.test.ts": `import { test } from "bun:test";
import * as cp from "node:child_process";
import { writeFileSync } from "node:fs";
const byteGetterCall = ${byteGetterCall.toString()};
test("c", async () => {
	writeFileSync("../w.pid", String(process.pid));
	const out = byteGetterCall(cp, "own", ["/usr/bin/true"], () => {
		${unreapedTrue()};
		const end = Date.now() + ${GETTER_HOT_MS};
		while (Date.now() < end) {}
	});
	writeFileSync("../out.json", JSON.stringify(out));
	await Bun.sleep(3_000);
}, 60_000);
`,
			},
		};
		type Done = { b: Box; work: string; exit: number | null; stdout: string; stderr: string };
		let all: Promise<Record<string, Done>> | null = null;
		/**
		 * Three controls at a time (each in its own box), started by the first test that needs them: most of them spin a worker
		 * hot for 6 s, and all at once they starved the rest of the full suite of CPU.
		 */
		const CONTROLS_AT_ONCE = 3;
		/** Every test here may be the first to wait for all the controls. */
		const CONTROL_TEST_MS = 240_000;
		const runControl = async ([name, files]: [string, Record<string, string>], i: number): Promise<[string, Done]> => {
			const b = box(`stuck-neg-${name}`, DETECT);
			const runId = `tr-sn${i}`;
			prepared(b, runId, { "a.test.ts": OK_TEST, ...files }, { fullCapMin: 1, soloCapMin: 1, fullWorkers: 2, stuckStop: "enforce" });
			const p = spawnCall(b, { sub: "full", runId });
			const exit = await p.exited;
			return [name, { b, work: workOf(b, runId), exit, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() }];
		};
		const results = (): Promise<Record<string, Done>> =>
			(all ??= (async () => {
				const entries = Object.entries(fixtures);
				const done: [string, Done][] = [];
				let next = 0;
				const worker = async (): Promise<void> => {
					while (next < entries.length) {
						const i = next++;
						done.push(await runControl(entries[i]!, i));
					}
				};
				await Promise.all(Array.from({ length: CONTROLS_AT_ONCE }, worker));
				return Object.fromEntries(done);
			})());
		/** The control ended normally, with no detector line at all; returns its trace and worker pid. */
		async function settled(name: string): Promise<{ trace: TraceRow[]; w: number; work: string }> {
			const d = (await results())[name]!;
			expect({ name, exit: d.exit, stderr: d.stderr, lines: keywordsOf(d.stdout) }).toEqual({ name, exit: 0, stderr: "", lines: [] });
			const trace = traceOf(d.work);
			expect(trace.length).toBeGreaterThanOrEqual(10);
			expect(trace.every((t) => t.snap === "ok" && t.signatures.length === 0)).toBe(true);
			expect(existsSync(join(d.work, "stuck-markers-full"))).toBe(false);
			return { trace, w: fixturePid(d.work, "w.pid"), work: d.work };
		}
		const zombieOf = (trace: TraceRow[], ppid: number) => trace.some((t) => t.zombies.some((z) => z.ppid === ppid && z.comm === "true"));
		/**
		 * Whether the control meant something: ticks saw the worker's `true` zombie over at least a second (four ticks' worth)
		 * without the worker's marker. A span, not a tick count: under a loaded machine the executor's ticks come late and few,
		 * while the zombie still stands through the getter's whole hot computation.
		 */
		const unmarkedZombieSpanMs = (trace: TraceRow[], w: number): number => {
			const at = trace.filter((t) => t.zombies.some((z) => z.ppid === w && z.comm === "true") && !activeAt(t).some((m) => m.pid === w)).map((t) => t.at);
			return at.length < 2 ? 0 : at[at.length - 1]! - at[0]!;
		};
		const MEANINGFUL_SPAN_MS = 4 * DETECT.detectTickMs;

		test("a 6 s sync loop holding a zombie child, with no marker", async () => {
			const { trace, w } = await settled("zombie-no-marker");
			expect(zombieOf(trace, w)).toBe(true);
			expect(trace.every((t) => activeAt(t).length === 0)).toBe(true);
		}, CONTROL_TEST_MS);

		test("a real Bun.spawnSync(['/usr/bin/true']) that returns, then an async /usr/bin/true born at once and a 6 s sync loop: the marker is inactive", async () => {
			const { trace, w } = await settled("returned-call-then-zombie");
			expect(zombieOf(trace, w)).toBe(true);
			expect(trace.filter((t) => t.zombies.length > 0).every((t) => activeAt(t).length === 0)).toBe(true);
		}, CONTROL_TEST_MS);

		test("the same with the marker file made immutable before the first call: no marker ever becomes active", async () => {
			const { trace, w } = await settled("immutable-marker");
			expect(zombieOf(trace, w)).toBe(true);
			expect(trace.every((t) => activeAt(t).length === 0)).toBe(true);
		}, CONTROL_TEST_MS);

		test("Bun.spawnSync(['/usr/bin/true', <getter>]) whose getter starts an async /usr/bin/true and computes past the persistence: the call runs unpublished, so the hot worker's zombie never meets a marker", async () => {
			const { trace, w } = await settled("argv-getter");
			expect(unmarkedZombieSpanMs(trace, w)).toBeGreaterThanOrEqual(MEANINGFUL_SPAN_MS);
		}, CONTROL_TEST_MS);

		for (const shape of ["proto-cwd", "env-array"] as const) {
			const what = shape === "proto-cwd" ? "Bun.spawnSync(['/usr/bin/true'], {}) beside an Object.prototype cwd getter" : "Bun.spawnSync(['/usr/bin/true'], { env: <array with an enumerable named getter> })";
			test(`${what} whose getter starts an async /usr/bin/true and computes past the persistence: the call runs unpublished and does what it does unwrapped, so the hot worker's zombie never meets a marker`, async () => {
				const { trace, w, work } = await settled(`${shape}-getter`);
				const out = JSON.parse(readFileSync(join(work, "out.json"), "utf8")) as { exitCode: number; hits: number };
				expect(out).toEqual(r3GetterCall(shape, ["/usr/bin/true"], () => {}));
				const zombieTicks = trace.filter((t) => t.zombies.some((z) => z.ppid === w && z.comm === "true"));
				expect(zombieTicks.filter((t) => activeAt(t).some((m) => m.pid === w))).toEqual([]);
				// bun 1.3.14 runs the env array's getter; it stops its option lookups before Object.prototype, so the inherited
				// getter runs only if a later bun reads it, and then it must meet no marker either.
				expect(unmarkedZombieSpanMs(trace, w)).toBeGreaterThanOrEqual(out.hits > 0 ? MEANINGFUL_SPAN_MS : 0);
			}, CONTROL_TEST_MS);
		}

		test("Bun.spawnSync(['/usr/bin/true'], { stdin: <Buffer with an own Symbol.asyncIterator getter> }) whose getter starts an async /usr/bin/true and computes past the persistence: the call runs unpublished and does what it does unwrapped, so the hot worker's zombie never meets a marker", async () => {
			const { trace, w, work } = await settled("byte-stdin-getter");
			const native = byteGetterCall(childProcess, "own", ["/usr/bin/true"], () => {});
			expect(native).toEqual({ exitCode: 0, hits: 1 });
			const out: unknown = JSON.parse(readFileSync(join(work, "out.json"), "utf8"));
			expect(out).toEqual(native);
			// bun runs the getter before it takes the bytes, so the zombie is there throughout the hot computation, unmarked.
			const zombieTicks = trace.filter((t) => t.zombies.some((z) => z.ppid === w && z.comm === "true"));
			expect(unmarkedZombieSpanMs(trace, w)).toBeGreaterThanOrEqual(MEANINGFUL_SPAN_MS);
			expect(zombieTicks.filter((t) => activeAt(t).some((m) => m.pid === w))).toEqual([]);
		}, CONTROL_TEST_MS);

		test("a long async test", async () => {
			const { trace, w } = await settled("long-async");
			expect(trace.some((t) => t.tree.some((p) => p.pid === w))).toBe(true);
		}, CONTROL_TEST_MS);

		test("a real Bun.spawnSync(['/bin/sleep', '3']): the marker is active with a live child, and the worker is not hot", async () => {
			const { trace, w } = await settled("sync-sleep");
			expect(trace.some((t) => activeAt(t).some((m) => m.pid === w && m.command === "sleep") && t.tree.some((p) => p.ppid === w && p.comm === "sleep"))).toBe(true);
		}, CONTROL_TEST_MS);

		test("another worker printing continuously beside an idle one", async () => {
			const { trace, w, work } = await settled("printer-beside-idle");
			const idle = fixturePid(work, "idle.pid");
			expect(idle).not.toBe(w);
			expect(trace.some((t) => t.tree.some((p) => p.pid === w) && t.tree.some((p) => p.pid === idle))).toBe(true);
		}, CONTROL_TEST_MS);

		test("a zombie whose parent is a sleeping fixture process, beside a hot worker holding a marker", async () => {
			const { trace, w } = await settled("zombie-of-a-sleeper");
			expect(trace.some((t) => activeAt(t).some((m) => m.pid === w && m.command === "true") && t.zombies.some((z) => z.comm === "true" && z.ppid !== w))).toBe(true);
			expect(zombieOf(trace, w)).toBe(false);
		}, CONTROL_TEST_MS);
	});
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
		const knobs = [{ hooks: "/tmp/h" }, { killGraceMs: 1 }, { sweepLockWaitMs: 1 }, { captureMs: 1 }, { detectTickMs: 1 }, { detectPersistMs: 1 }, { signatureCaptureMs: 1 }, { stopGraceMs: 1 }, { detectTrace: true }, { detectTrace: false }];
		for (const extra of knobs) {
			expect(() => renderExecWrapper({ root: "/r", bun: "/b", script: "/s", sweepScope: "uid", ...extra })).toThrow(WrapperRenderError);
		}
		expect(() => renderExecWrapper({ root: "r", bun: "/b", script: "/s", sweepScope: "uid" })).toThrow(WrapperRenderError);
		expect(() => renderExecWrapper({ root: "/r", bun: "/b", script: "/s", sweepScope: "all" as SweepScope })).toThrow(WrapperRenderError);
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "uid" })).toMatchObject({
			killGraceMs: 10_000, sweepLockWaitMs: 60_000, captureMs: 20_000, hooks: null,
			detectTickMs: STUCK_DEFAULTS.tickMs, detectPersistMs: STUCK_DEFAULTS.persistMs, signatureCaptureMs: STUCK_DEFAULTS.signatureCaptureMs, stopGraceMs: STUCK_DEFAULTS.stopGraceMs, detectTrace: false,
		});
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "groups", captureMs: 1_500 }).captureMs).toBe(1_500);
		expect(execConfigOf({ root: "/r", bun: "/b", script: "/s", sweepScope: "groups", detectTickMs: 50, detectPersistMs: 400, signatureCaptureMs: 900, stopGraceMs: 300, detectTrace: true }))
			.toMatchObject({ detectTickMs: 50, detectPersistMs: 400, signatureCaptureMs: 900, stopGraceMs: 300, detectTrace: true });
		for (const bad of [{ detectTickMs: 0 }, { detectPersistMs: -1 }, { stopGraceMs: 1.5 }, { detectTrace: "yes" as unknown as boolean }]) {
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
		const mainSha = git(r.bare, "rev-parse", `refs/tags/${VERIFIED_TAG}^{commit}`);
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
