// The outside-the-fence test runner as the processes it really is (MIGRATION.md item 24; plan of
// wl-muraerdsgw7gn4, § 2.2 to § 2.4 and § 6 row S2): surface/scripts/test-runner.ts `start` and `run`
// on a temp ledger, a temp runs root and a temp as2test root. GitHub is a local bare repo with
// refs/pull/<N>/head (the origin-URL override) plus a fake `gh` that logs its argv; `_as2test` is the
// S4b wrapper rendered with `sweepScope: groups` behind a fake `sudo` that drops `-n -u _as2test` and
// runs it as the current user; the same fake execs `-n <libexec>/refresh` (no other argument), a stand-in
// helper a test arms. The install the preflight checks is a temp copy whose owners are this
// user. A fake sudo cannot deny the current user its own files, so it forwards `probe` to the real
// wrapper and reports every answer closed (the real denial is proved at S8, plan § 8). Boundaries
// are paused through the runner's AGENT_SYSTEM_TEST_HOOKS files and the wrapper's rendered `hooks`.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Ledger, LiveLedgerUnderTestError, TEST_RUNNER_BY } from "../../ledger/src/index";
import { renderExecWrapper } from "../src/as2test";
import { recordRepo } from "../src/decision-log";
import {
	childLayout, heartbeatText, makeRunId, parseHeartbeat, parseTestRun, partResult, pushDestBody, runnerDiedRun, type TestRun, testRequestedBody, testRunBody, testRuns, workDirOf,
	WRAPPER_EXIT, type WrapperCall, wrapperArgv,
} from "../src/test-run";
import { trainBody, trainFullSliceId, trainInstructionBody, trainSliceId } from "../src/merge-train";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { importPart, importReport, lockRow, openLockDb, publishIfOwner, run, START_EXIT } from "../scripts/test-runner";
import { alive, tmp, until } from "./helpers";

setDefaultTimeout(180_000);

const RUNNER = join(import.meta.dir, "..", "scripts", "test-runner.ts");
const TEST_EXEC = join(import.meta.dir, "..", "scripts", "test-exec.ts");
const OWNER_REPO = "thewolff/agent-system-2.0";
const LANE = "lane-runnertest-1";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GIT_ENV: Record<string, string> = {
	PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function g(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}
const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

// ---- the fixture repository: main plus one PR per scenario -------------------------------------------

const PASS = (name: string) => `import { expect, test } from "bun:test";\ntest(${JSON.stringify(name)}, () => { expect(1 + 1).toBe(2); });\n`;
const RED = `import { test } from "bun:test";
for (let i = 1; i <= 25; i++) {
	const n = String(i).padStart(2, "0");
	test(\`case \${n}\`, () => { throw new Error(\`failure \${n}: \${"detail ".repeat(30)}end \${n}\`); });
}
test("passes", () => {});
`;
// Passes in the full suite and fails when run alone by its exact path, through state it leaks into the clone:
// the solo-only failure (plan § 4, PR #16's takeover test). The suite runs it first; its solo run finds the leftover.
const SOLO_ONLY = `import { test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
test("needs a clean clone", () => {
	if (existsSync(".leaked-state")) throw new Error("state leaked by an earlier run is still here");
	writeFileSync(".leaked-state", "1");
});
`;
// The child's env, a descendant that rebuilds its env as {HOME, PATH}, and a child left behind for the sweep.
const ENV_DUMP = `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("dumps its env", () => {
	const d = Bun.spawnSync(["/bin/sh", "-c", "command -v git"], { env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" }, stdout: "pipe" });
	writeFileSync("env-dump.json", JSON.stringify({ env: process.env, descendantGit: d.stdout.toString().trim() }));
	const left = Bun.spawn(["/bin/sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
	left.unref();
	writeFileSync("leftover.pid", String(left.pid));
});
`;
const HANG = `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("hangs", async () => {
	const c = Bun.spawn(["/bin/sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
	writeFileSync("hang.pid", String(c.pid));
	await Bun.sleep(10_000_000);
}, 100_000_000);
`;
const EXITS = `import { test } from "bun:test";
test("exits before the report", () => { process.exit(0); });
`;
// A failing security test (surface/src/test-run.ts SECURITY_TEST_PATHS): a gate test the PR breaks (fix round 1, F4).
const GATE_RED = `import { test } from "bun:test";
test("refuses a forged approve", () => { throw new Error("the gate let it through"); });
`;

const PR = { green: 1, red: 2, solo: 3, env: 4, hang: 5, exit: 6, space: 7, gate: 8 } as const;
type PrName = keyof typeof PR;
const PR_FILES: Record<PrName, Record<string, string>> = {
	green: { "a.test.ts": PASS("a") },
	red: { "red.test.ts": RED },
	solo: { "order_spec.ts": SOLO_ONLY },
	env: { "env.test.ts": ENV_DUMP },
	hang: { "hang.test.ts": HANG },
	exit: { "exits.test.ts": EXITS },
	// git lists ` a.test.ts` first (a space sorts before `a`); trimmed, it would name its sibling.
	space: { " a.test.ts": PASS("space a"), "a.test.ts": PASS("a") },
	gate: { "gates/test/gate.test.ts": GATE_RED },
};

interface Fixture {
	bare: string;
	main: string;
	head: Record<PrName, string>;
}
let fx: Fixture;

beforeAll(() => {
	const root = realpathSync(tmp("trun-fixture"));
	roots.push(root);
	const work = join(root, "work");
	mkdirSync(work);
	g(work, "init", "-q", "-b", "main");
	writeFileSync(join(work, "README.md"), "runner fixture\n");
	// `xa.test.ts` shares a substring with `a.test.ts`: a solo run by `./a.test.ts` must not pick it up.
	writeFileSync(join(work, "xa.test.ts"), PASS("xa"));
	// Every checkout would run the `evil` smudge filter if any config the runner reads defined it.
	writeFileSync(join(work, ".gitattributes"), "*.ts filter=evil\n");
	g(work, "add", "-A");
	g(work, "commit", "-q", "-m", "main");
	const main = g(work, "rev-parse", "HEAD");
	const head = {} as Record<PrName, string>;
	for (const name of Object.keys(PR) as PrName[]) {
		g(work, "checkout", "-q", "--detach", main);
		for (const [f, text] of Object.entries(PR_FILES[name])) {
			mkdirSync(dirname(join(work, f)), { recursive: true });
			writeFileSync(join(work, f), text);
		}
		g(work, "add", "-A");
		g(work, "commit", "-q", "-m", `pr ${name}`);
		head[name] = g(work, "rev-parse", "HEAD");
		g(work, "update-ref", `refs/pull/${PR[name]}/head`, head[name]);
	}
	const bare = join(root, "origin.git");
	g(root, "init", "-q", "--bare", "-b", "main", bare);
	g(work, "push", "-q", bare, "main", "+refs/pull/*:refs/pull/*");
	fx = { bare, main, head };
});

// ---- a world: ledger, runs root, as2test root, install, fake gh and sudo --------------------------------

// `gh api` (the runner's `as2/full-suite` status post) answers `{}`, or fails while `<root>/status-fails` exists.
const GH = `#!/bin/sh
dir="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\\n' "$*" >> "$dir/gh.log"
if [ "$1 $2" = "pr view" ] && [ -f "$dir/prs/$3.json" ]; then cat "$dir/prs/$3.json"; exit 0; fi
if [ "$1" = api ] && [ ! -f "$dir/status-fails" ]; then echo '{}'; exit 0; fi
if [ "$1" = api ]; then echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
echo "no pull requests found" >&2
exit 1
`;
/** The fake gh's `as2/full-suite` status posts, in order: `<state> <sha>`. */
const statusPosts = (w: World): string[] => {
	const log = join(w.root, "gh.log");
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8").trim().split("\n").filter((c) => c.startsWith("api ")).map((c) => {
		const m = /^api -X POST repos\/(\S+)\/statuses\/([0-9a-f]{40}) -f state=(\S+) -f context=as2\/full-suite -f description=/.exec(c);
		if (!m || m[1] !== OWNER_REPO) throw new Error(`unexpected gh api call: ${c}`);
		return `${m[3]} ${m[2]}`;
	});
};
// Every call is logged to sudo.log, one line each: `refresh`, or the wrapper subcommand and its run id.
const SUDO = `#!/bin/sh
log="$(dirname "$0")/../sudo.log"
if [ "$#" = 2 ] && [ "$1" = -n ]; then
	case "$2" in /*/refresh) printf 'refresh\\n' >> "$log"; exec "$2" ;; esac
fi
[ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = _as2test ] || { echo "fake sudo: bad argv" >&2; exit 1; }
shift 3
printf '%s %s\\n' "$2" "$3" >> "$log"
printf '%s %s %s\\n' "$2" "$3" "$(pwd -P)" >> "$(dirname "$0")/../sudo-cwd.log"
if [ "$2" = probe ]; then
	out=$("$@")
	code=$?
	if [ "$code" != 0 ] && [ "$code" != 65 ]; then printf '%s\\n' "$out"; exit "$code"; fi
	printf '%s\\n' "$out" | sed -e 's/"read":true/"read":false/g' -e 's/"write":true/"write":false/g'
	exit 0
fi
exec "$@"
`;
/** The installed refresh helper's stand-in until a test arms one (`setRefresh`): a run that calls it fails loudly. */
const REFRESH_UNARMED = `#!/bin/sh
echo "fake refresh: not armed by this test" >&2
exit 99
`;

/**
 * The install's SOURCE over its four files as they are now, at `to` (the installed SOURCE by default), recording
 * `inputSha` for surface/scripts/test-exec.ts: its hash in this checkout by default, so the install matches.
 */
function writeSource(libexec: string, o: { inputSha?: string; to?: string } = {}): void {
	const uid = process.getuid!();
	const gid = statSync(libexec).gid;
	const to = o.to ?? join(libexec, "SOURCE");
	const source = [
		"version 1", "source /tmp/as2-checkout", `source-sha ${"0".repeat(40)}`, `bun-version ${Bun.version}`, "user _as2test", `uid ${uid}`, `gid ${gid}`, "jo jo", `jo-uid ${uid}`,
		...["exec", "bun", "test-exec.js", "refresh"].map((f) => `file ${f} ${sha256(join(libexec, f))}`),
		`input surface/scripts/test-exec.ts ${o.inputSha ?? sha256(TEST_EXEC)}`,
	];
	writeFileSync(to, `${source.join("\n")}\n`);
	chmodSync(to, 0o755);
}

interface World {
	root: string;
	home: string;
	runs: string;
	as2: string;
	libexec: string;
	exec: string;
	hooks: string;
	origin: string;
	checkout: string;
	env: Record<string, string>;
	ledger: Ledger;
	/** Run `fn` with the ledger clock `ms` in the past. */
	ago: <T>(ms: number, fn: () => T) => T;
}

function world(o: { capMin?: number; queueMaxMin?: number; killGraceMs?: number; sweepLockWaitMs?: number; fullWorkers?: number } = {}): World {
	const root = realpathSync(tmp("trun"));
	roots.push(root);
	const gid = statSync(root).gid;
	const uid = process.getuid!();
	const home = join(root, "home");
	for (const d of [join(home, ".agent-system-2"), join(home, ".config", "git"), join(root, "bin"), join(root, "prs"), join(root, "hooks"), join(root, "runs")]) mkdirSync(d, { recursive: true });
	// Jo's own config defines the filter the fixture's .gitattributes names; the trusted phase must never read it.
	// (No `;` in the value: gitconfig would read it as a comment.)
	const evil = `[filter "evil"]\n\tsmudge = touch ${root}/SMUDGED && cat\n\tclean = cat\n`;
	writeFileSync(join(home, ".gitconfig"), evil);
	writeFileSync(join(home, ".config", "git", "config"), evil);
	const ledgerPath = join(home, ".agent-system-2", "ledger.db");
	let offset = 0;
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: () => new Date(Date.now() - offset).toISOString() });
	const ago = <T>(ms: number, fn: () => T): T => {
		offset = ms;
		try {
			return fn();
		} finally {
			offset = 0;
		}
	};

	const as2 = join(root, "as2");
	mkdirSync(join(as2, "stage"), { recursive: true });
	mkdirSync(join(as2, "runs"));
	mkdirSync(join(as2, "locks"));
	writeFileSync(join(as2, "locks", "sweep.db"), "");
	chmodSync(as2, 0o755);
	chmodSync(join(as2, "stage"), 0o750);
	chmodSync(join(as2, "runs"), 0o755);
	chmodSync(join(as2, "locks"), 0o755);
	chmodSync(join(as2, "locks", "sweep.db"), 0o600);
	const hooks = join(root, "hooks");
	const libexec = join(root, "libexec");
	mkdirSync(libexec);
	chmodSync(libexec, 0o755);
	const exec = join(libexec, "exec");
	writeFileSync(exec, renderExecWrapper({
		root: as2, bun: process.execPath, script: TEST_EXEC, sweepScope: "groups", hooks, killGraceMs: o.killGraceMs ?? 300, sweepLockWaitMs: o.sweepLockWaitMs ?? 30_000,
	}));
	writeFileSync(join(libexec, "bun"), "stand-in for the installed bun\n");
	writeFileSync(join(libexec, "test-exec.js"), "stand-in for the installed bundle\n");
	writeFileSync(join(libexec, "refresh"), REFRESH_UNARMED);
	for (const f of ["exec", "bun", "test-exec.js", "refresh"]) chmodSync(join(libexec, f), 0o755);
	mkdirSync(join(libexec, "refresh.d"), { mode: 0o700 });
	chmodSync(join(libexec, "refresh.d"), 0o700);
	writeSource(libexec);
	const sudoers = join(root, "sudoers");
	writeFileSync(sudoers, "jo ALL=(_as2test) NOPASSWD: exec\n");
	chmodSync(sudoers, 0o440);

	writeFileSync(join(root, "bin", "gh"), GH);
	writeFileSync(join(root, "bin", "sudo"), SUDO);
	chmodSync(join(root, "bin", "gh"), 0o755);
	chmodSync(join(root, "bin", "sudo"), 0o755);

	const origin = join(root, "origin.git");
	g(root, "clone", "-q", "--mirror", fx.bare, origin);
	const checkout = join(root, "checkout");
	mkdirSync(checkout);
	g(checkout, "init", "-q", "-b", "main");
	g(checkout, "remote", "add", "origin", `https://github.com/${OWNER_REPO}.git`);

	const cap = o.capMin ?? 2;
	const config = join(root, "config.yml");
	const workers = o.fullWorkers === undefined ? "" : `  fullWorkers: ${o.fullWorkers}\n`;
	writeFileSync(config, `testRunner:\n  repos:\n    - origin: ${OWNER_REPO}\n      command: bun test\n  fullCapMin: ${cap}\n  soloCapMin: ${cap}\n  reportCapMb: 5\n  queueMaxMin: ${o.queueMaxMin ?? 60}\n${workers}`);

	const env: Record<string, string> = {
		PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", USER: process.env.USER ?? "jo",
		AGENT_SYSTEM_LEDGER_DB: ledgerPath, AGENT_SYSTEM_TEST_RUNS: join(root, "runs"), AGENT_SYSTEM_TEST_RUNNER_CONFIG: config, AGENT_SYSTEM_TEST_RUNNER_ORIGIN: origin,
		AGENT_SYSTEM_TEST_RUNNER_ROOT: as2,
		AGENT_SYSTEM_TEST_RUNNER_INSTALL: JSON.stringify({ libexec, sudoers, ids: { root: uid, wheel: gid, jo: uid }, account: { uid, gid } }),
		AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "500", AGENT_SYSTEM_TEST_RUNNER_POLL_MS: "200", AGENT_SYSTEM_TEST_RUNNER_BUSY_MS: "300", AGENT_SYSTEM_TEST_HOOKS: hooks,
		// Credentials in Jo's env: none may reach the code under test (plan § 3).
		GH_TOKEN: "secret-gh", ANTHROPIC_API_KEY: "secret-anthropic", OPENAI_API_KEY: "secret-openai", MOONSHOT_API_KEY: "secret-moonshot",
		SSH_AUTH_SOCK: "/tmp/secret-agent.sock", OMP_SESSION_TOKEN: "secret-omp", AGENT_SYSTEM_SECRET: "secret-as",
	};
	return { root, home, runs: join(root, "runs"), as2, libexec, exec, hooks, origin, checkout, env, ledger, ago };
}

/** An open autonomous workload on the world's checkout, with one open slice. */
function workload(w: World): { wl: string; slice: string } {
	const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "runner fixture", stakes: "normal", mode: "autonomous" });
	recordRepo(w.ledger, wl, w.checkout);
	const slice = w.ledger.addSlice({ by: LANE, workloadId: wl, task: "full suite", doneCondition: "a green test-run", inputs: "the PR" });
	return { wl, slice };
}

/** What the fake gh answers for `pr view <N>`. */
function setPr(w: World, n: number, o: { sha: string; headRefName: string; state?: string; isCrossRepository?: boolean; baseRefName?: string; body?: string }): void {
	writeFileSync(join(w.root, "prs", `${n}.json`), JSON.stringify({
		number: n, state: o.state ?? "OPEN", headRefOid: o.sha, headRefName: o.headRefName, baseRefName: o.baseRefName ?? "main", isCrossRepository: o.isCrossRepository ?? false, body: o.body ?? "",
	}));
}

function start(w: World, wl: string, pr: number, extra: string[] = []) {
	const r = Bun.spawnSync([process.execPath, RUNNER, "start", wl, String(pr), ...extra, "--requested-by", LANE], { env: w.env, stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

const newRunId = (): string => makeRunId(Date.now(), Math.random().toString(36).slice(2, 8).padEnd(4, "0"));

/** A `test-requested:` written as the starter would, `agoMs` in the past; returns the run id. */
function request(w: World, wl: string, slice: string, pr: number, sha: string, agoMs = 0): string {
	const runId = newRunId();
	w.ago(agoMs, () => w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice, by: LANE }) }));
	return runId;
}

/** `run <run id>` as the starter spawns it, with its log in the run dir. */
function spawnRun(w: World, runId: string, env: Record<string, string> = {}) {
	const dir = join(w.runs, runId);
	mkdirSync(dir, { recursive: true });
	const fd = openSync(join(dir, "runner.log"), "a");
	return Bun.spawn([process.execPath, RUNNER, "run", runId], { cwd: dir, env: { ...w.env, ...env }, stdin: "ignore", stdout: fd, stderr: fd });
}

const runnerLog = (w: World, runId: string): string => {
	try {
		return readFileSync(join(w.runs, runId, "runner.log"), "utf8");
	} catch {
		return "";
	}
};

/** The run's own `test-run:` (the first entry for it), once written. */
async function resultOf(w: World, wl: string, runId: string, timeoutMs = 120_000): Promise<TestRun & { entryId: string }> {
	try {
		return await until(`the test-run: of ${runId}`, () => {
			const rec = testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId);
			return rec?.results[0] ?? null;
		}, timeoutMs);
	} catch (e) {
		throw new Error(`${(e as Error).message}\n--- runner.log ---\n${runnerLog(w, runId)}`);
	}
}

/**
 * Seed result.json as a FIFO. Atomic publication must replace it without blocking; the
 * returned reader observes the regular result file after the ledger entry is visible.
 */
function seedResultFifo(w: World, runId: string): () => Promise<string> {
	const dir = join(w.runs, runId);
	mkdirSync(dir, { recursive: true });
	const fifo = join(dir, "result.json");
	const r = Bun.spawnSync(["mkfifo", fifo], { stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`mkfifo ${fifo}: ${r.stderr.toString()}`);
	return () => new Response(Bun.spawn(["cat", fifo], { stdout: "pipe" }).stdout).text();
}

const hookBase = (w: World, runId: string, point: string) => join(w.hooks, `${runId}.${point}`);
const arm = (w: World, runId: string, point: string) => writeFileSync(`${hookBase(w, runId, point)}.pause`, "");
const go = (w: World, runId: string, point: string) => writeFileSync(`${hookBase(w, runId, point)}.go`, "");
const reached = (w: World, runId: string, point: string) =>
	until(`${runId} at ${point}`, () => existsSync(`${hookBase(w, runId, point)}.reached`) && (JSON.parse(readFileSync(`${hookBase(w, runId, point)}.reached`, "utf8")) as { pid: number; at: number }), 60_000);
function marks(w: World, runId: string, point: string): Record<string, unknown>[] {
	const f = `${hookBase(w, runId, point)}.marks`;
	return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}
const current = (w: World): string => readFileSync(join(w.as2, "stage", "current"), "utf8").trim();
const heldMessages = (w: World, wl: string) =>
	w.ledger.db.query<{ body: string; sender: string; recipient: string; state: string }, [string]>("SELECT body, sender, recipient, state FROM messages WHERE workload_id = ? ORDER BY rowid").all(wl);
/** The world's runs.db, with no busy wait: a write while another connection holds a transaction fails at once. */
const lockDbOf = (w: World): Database => openLockDb(w.runs, 0);
/** The lock row's heartbeat moved two minutes back: its holder is stale to every waiter. */
function staleRow(w: World): void {
	const db = lockDbOf(w);
	try {
		db.query("UPDATE lock SET heartbeatAt = ?").run(Date.now() - 120_000);
	} finally {
		db.close();
	}
}

// ---- the starter -------------------------------------------------------------------------------------

describe("start: which PRs run (§ 2.2 steps 1–2)", () => {
	test("a fork PR and a closed PR are refused; an unbound branch is refused, then accepted once a push-dest: binds it; every gh call names -R", async () => {
		const w = world();
		const { wl } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}`, isCrossRepository: true });
		const fork = start(w, wl, PR.green);
		expect(fork.code).toBe(START_EXIT.refused);
		expect(fork.err).toContain("comes from a fork");

		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}`, state: "CLOSED" });
		const closed = start(w, wl, PR.green);
		expect(closed.code).toBe(START_EXIT.refused);
		expect(closed.err).toContain("is closed, not open");

		setPr(w, PR.green, { sha: fx.head.green, headRefName: "wl/wl-someone-else" });
		const unbound = start(w, wl, PR.green);
		expect(unbound.code).toBe(START_EXIT.refused);
		expect(unbound.err).toContain("wl/wl-someone-else is not one this workload is bound to");
		expect(testRuns(w.ledger.entries(wl))).toEqual([]);

		// The holder lane's row-8 record of a push to that branch binds it.
		w.ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 600_000 });
		w.ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: pushDestBody({ remote: "origin", branch: "wl/wl-someone-else", sha: fx.head.green }) });
		const bound = start(w, wl, PR.green);
		expect(bound.code).toBe(START_EXIT.ok);
		const runId = /^test-run (tr-[a-z0-9]+) /.exec(bound.out)![1]!;
		expect((await resultOf(w, wl, runId)).verdict).toBe("green");

		// The run's own `as2/full-suite` status posts (statusPosts, which checks they name -R's repo too) are the only other gh calls.
		const calls = readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n").filter((c) => !c.startsWith("api "));
		expect(calls).toHaveLength(4);
		for (const c of calls) expect(c).toBe(`pr view ${PR.green} -R ${OWNER_REPO} --json number,state,headRefOid,headRefName,baseRefName,isCrossRepository,body`);
		await until("the green's status", () => statusPosts(w).length === 1);
		expect(statusPosts(w)).toEqual([`success ${fx.head.green}`]);
	});

	test("a repo the profile does not serve is refused before any gh call", () => {
		const w = world();
		const { wl } = workload(w);
		g(w.checkout, "remote", "set-url", "origin", "https://github.com/someone/other.git");
		const r = start(w, wl, PR.green);
		expect(r.code).toBe(START_EXIT.refused);
		expect(r.err).toContain("does not serve https://github.com/someone/other.git");
		expect(existsSync(join(w.root, "gh.log"))).toBe(false);
	});

	// PLAN wl-mv5qdfvv82ivwg § 3: Jo's `test-pr` binding. The rows are literal bodies through the fixture's Ledger (no new helper), so
	// the pre-fail case can be copied alone onto origin/main, where it fails on its assertion; the guards pass on both sides.
	/** Jo's `test-pr <wl> <prs>` as the surface writes it, in literal bodies: the instruction on `on`, then the surface's entry naming it on `entryOn`. */
	function joBinds(w: World, on: string, prs: number[], entryOn: string = on, body = `test-pr ${on} ${prs.join(" ")}`): string {
		const id = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: on, body, author: "jo", channel: "surface" });
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: entryOn, kind: "assumption", body: `test-pr: ${prs.join(" ")} ${id}` });
		return id;
	}

	test("pre-fail: a Jo-bound plumb PR is admitted: test-requested: written, the run goes green, the line names bound-by", async () => {
		const w = world();
		const { wl } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: "plumb/x" });
		const id = joBinds(w, wl, [PR.red, PR.green]);
		const r = start(w, wl, PR.green);
		expect(r.code).toBe(START_EXIT.ok);
		expect(r.out).toMatch(new RegExp(`^test-run tr-[a-z0-9]+ runner \\d+ sha ${fx.head.green} slice sl-full-\\S+-1 log \\S+ bound-by ${id}$`));
		const runs = testRuns(w.ledger.entries(wl));
		expect(runs.map((x) => [x.request.pr, x.request.sha, x.request.by])).toEqual([[PR.green, fx.head.green, LANE]]);
		expect((await resultOf(w, wl, runs[0]!.request.runId)).verdict).toBe("green");
	});

	test("guard: an unbound plumb PR is refused and writes no test-requested:", () => {
		const w = world();
		const { wl } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: "plumb/x" });
		const r = start(w, wl, PR.green);
		expect(r.code).toBe(START_EXIT.refused);
		expect(r.err).toContain("plumb/x is not one this workload is bound to");
		expect(testRuns(w.ledger.entries(wl))).toEqual([]);
	});

	test("guard: PR #M is refused while only #N is bound, and no test-requested: is written", () => {
		const w = world();
		const { wl } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: "plumb/x" });
		joBinds(w, wl, [PR.red]);
		const r = start(w, wl, PR.green);
		expect(r.code).toBe(START_EXIT.refused);
		expect(r.err).toContain("plumb/x is not one this workload is bound to");
		expect(testRuns(w.ledger.entries(wl))).toEqual([]);
	});

	test("guard: a binding on another workload does not admit the PR here", () => {
		const w = world();
		const { wl } = workload(w);
		const other = workload(w).wl;
		setPr(w, PR.green, { sha: fx.head.green, headRefName: "plumb/x" });
		joBinds(w, other, [PR.green]);
		// The other workload's instruction, named by an entry on this one, even with this workload's words.
		joBinds(w, other, [PR.green], wl, `test-pr ${wl} ${PR.green}`);
		const r = start(w, wl, PR.green);
		expect(r.code).toBe(START_EXIT.refused);
		expect(r.err).toContain("plumb/x is not one this workload is bound to");
		expect(testRuns(w.ledger.entries(wl))).toEqual([]);
		expect(testRuns(w.ledger.entries(other))).toEqual([]);
	});

	test("guard: a lane-written test-pr: imitation leaves the PR refused and writes no test-requested:", () => {
		const w = world();
		const { wl } = workload(w);
		w.ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 600_000 });
		setPr(w, PR.green, { sha: fx.head.green, headRefName: "plumb/x" });
		// The lane's own instruction and entry, each with the right words.
		const own = w.ledger.recordInstruction({ by: LANE, workloadId: wl, body: `test-pr ${wl} ${PR.green}`, author: "jo", channel: "direct" });
		w.ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: `test-pr: ${PR.green} ${own}` });
		// The lane's entry naming a real Jo instruction it did not get an entry for.
		const jo = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `test-pr ${wl} ${PR.green}`, author: "jo", channel: "surface" });
		w.ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: `test-pr: ${PR.green} ${jo}` });
		const r = start(w, wl, PR.green);
		expect(r.code).toBe(START_EXIT.refused);
		expect(r.err).toContain("plumb/x is not one this workload is bound to");
		expect(testRuns(w.ledger.entries(wl))).toEqual([]);
	});

	// PLAN wl-mv8s8srodefytc § 1 D4: the merge train's stop hold, evaluated by the starter inside its reservation transaction. The train's rows are
	// written as the surface writes them (Jo's instruction, then the `train:` naming it); questions are the lane's, answers Jo's.
	/** Jo's `train <wl> <prs>` as the surface writes it: the instruction, then the surface's `train:` naming it. */
	function joTrains(w: World, wl: string, prs: number[]): string {
		const id = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: trainInstructionBody(wl, prs), author: "jo", channel: "surface" });
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: trainBody(prs, id) });
		return id;
	}
	/** The lane's question on slice `id` (added when missing). */
	function trainAsk(w: World, wl: string, id: string, options: string[]): string {
		if (!w.ledger.slice(id)) w.ledger.addSlice({ by: LANE, workloadId: wl, id, task: `train slice ${id}`, doneCondition: "Jo answered", inputs: "the PR" });
		return w.ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: id, body: `about ${id}`, options });
	}
	const joAnswers = (w: World, q: string, answer: string) => w.ledger.answerQuestion(q, { by: SURFACE_BY, author: "jo", channel: "surface", answer });
	/** A start the starter must admit; its run is awaited to its `test-run:`, so the reservation is free for the next start. */
	async function admitted(w: World, wl: string, pr: number, extra: string[] = []): Promise<TestRun> {
		const r = start(w, wl, pr, extra);
		expect(r.err).toBe("");
		expect(r.code).toBe(START_EXIT.ok);
		return resultOf(w, wl, /^test-run (tr-[a-z0-9]+) /.exec(r.out)![1]!);
	}
	/** A start the train holds: refused naming why, and no `test-requested:` written. */
	function held(w: World, wl: string, pr: number, why: string): void {
		const before = testRuns(w.ledger.entries(wl)).length;
		const r = start(w, wl, pr);
		expect(r.err).toBe(`test-runner start: ${why}`);
		expect(r.code).toBe(START_EXIT.refused);
		expect(testRuns(w.ledger.entries(wl))).toHaveLength(before);
	}
	// Each admitted run here is asked at a sha the PR's head is not (gh names origin/main), so it ends stale at once.
	const A = PR.green;
	const B = PR.red;
	const C = PR.solo;

	test("train (D4): an open merged/skip/stop or resolve/skip/stop question on #A's slice no longer holds #B; #A is admitted too", async () => {
		const w = world();
		const { wl } = workload(w);
		for (const n of [A, B]) setPr(w, n, { sha: fx.main, headRefName: `plumb/${n}` });
		joTrains(w, wl, [A, B]);
		for (const options of [["merged", "skip", "stop"], ["resolve", "skip", "stop"]]) {
			trainAsk(w, wl, trainSliceId(wl, A), options);
			expect((await admitted(w, wl, B)).verdict).toBe("stale");
			expect((await admitted(w, wl, A)).verdict).toBe("stale");
		}
	});

	test("train: a stop (on either ask, or a red run's rerun/skip/stop) holds every PR until a newer train:, even after a later merged; a -full-2 run after a green -full-1 is admitted", async () => {
		const w = world();
		const { wl } = workload(w);
		for (const n of [A, B]) setPr(w, n, { sha: fx.main, headRefName: `plumb/${n}` });
		joTrains(w, wl, [A, B, C]);
		const asks: [string[], string][] = [
			[["merged", "skip", "stop"], trainSliceId(wl, A)], [["resolve", "skip", "stop"], trainSliceId(wl, A)], [["rerun", "skip", "stop"], trainFullSliceId(wl, A, 1)],
		];
		for (const [k, [options, sl]] of asks.entries()) {
			// Each round's rows are stamped k minutes ahead, a second apart, so its stop is strictly newer than the last round's resume and older than its own.
			const at = (s: number) => -(k * 60_000 + s * 1000);
			const q = w.ago(at(0), () => trainAsk(w, wl, sl, options));
			w.ago(at(1), () => joAnswers(w, q, "stop"));
			const stopped = `merge train stopped by Jo at #${A} (${q}); \`train ${wl} <N…>\` resumes it`;
			held(w, wl, B, stopped);
			held(w, wl, A, stopped);
			const later = w.ago(at(2), () => trainAsk(w, wl, trainSliceId(wl, C), ["merged", "skip", "stop"]));
			w.ago(at(3), () => joAnswers(w, later, "merged"));
			held(w, wl, B, stopped);
			w.ago(at(4), () => joTrains(w, wl, [900 + k]));
			expect((await admitted(w, wl, B)).verdict).toBe("stale");
		}
		// A green on -full-1 completes it; the PR's next run goes on a new -full-2.
		setPr(w, A, { sha: fx.head.green, headRefName: `plumb/${A}` });
		expect((await admitted(w, wl, A, ["--slice", trainFullSliceId(wl, A, 1)])).verdict).toBe("green");
		await until("the settle of -full-1", () => w.ledger.slice(trainFullSliceId(wl, A, 1))?.state === "done");
		w.ledger.addSlice({ by: LANE, workloadId: wl, id: trainFullSliceId(wl, A, 2), task: "suite #A again", doneCondition: "a green", inputs: "the PR" });
		setPr(w, A, { sha: fx.main, headRefName: `plumb/${A}` });
		expect((await admitted(w, wl, A, ["--slice", trainFullSliceId(wl, A, 2)])).verdict).toBe("stale");
	});

	test("train: a workload with no train: entry is never held, whatever its slices are named", async () => {
		const w = world();
		const { wl } = workload(w);
		setPr(w, B, { sha: fx.main, headRefName: `plumb/${B}` });
		joBinds(w, wl, [A, B]);
		const stop = trainAsk(w, wl, trainSliceId(wl, A), ["merged", "skip", "stop"]);
		joAnswers(w, stop, "stop");
		trainAsk(w, wl, trainSliceId(wl, C), ["merged", "skip", "stop"]);
		expect((await admitted(w, wl, B)).verdict).toBe("stale");
	});

	// PLAN wl-mv8s8srodefytc § 1b: on a train, the starter lands dependencies first, on gh, before the reservation.
	test("train: #B whose body says Depends-on: #A is refused naming #A while #A is OPEN, admitted once #A is MERGED; a base other than main is refused; off a train the same PR is admitted", async () => {
		const w = world();
		const { wl } = workload(w);
		const ghCalls = () => readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n");
		const stacked = { sha: fx.main, headRefName: `plumb/${B}`, body: `Stacked on the API.\nDepends-on: #${A}\n` };
		setPr(w, A, { sha: fx.main, headRefName: `plumb/${A}` });
		setPr(w, B, stacked);
		joTrains(w, wl, [B, A]);
		held(w, wl, B, `#${B} depends on #${A} (OPEN): land #${A} first`);
		expect(ghCalls().slice(-2)).toEqual([
			`pr view ${B} -R ${OWNER_REPO} --json number,state,headRefOid,headRefName,baseRefName,isCrossRepository,body`, `pr view ${A} -R ${OWNER_REPO} --json state`,
		]);

		setPr(w, A, { sha: fx.main, headRefName: `plumb/${A}`, state: "MERGED" });
		expect((await admitted(w, wl, B)).verdict).toBe("stale");

		setPr(w, B, { ...stacked, baseRefName: `plumb/${A}` });
		held(w, wl, B, `#${B} targets plumb/${A}; retarget it to main once its dependency has landed`);

		// Off a train: the same PR, its dependency OPEN again and its base still the dependency's head, runs as today, with no dependency lookup.
		setPr(w, A, { sha: fx.main, headRefName: `plumb/${A}` });
		const other = workload(w).wl;
		joBinds(w, other, [B]);
		const before = ghCalls().length;
		expect((await admitted(w, other, B)).verdict).toBe("stale");
		expect(ghCalls().slice(before).filter((c) => c.endsWith("--json state"))).toEqual([]);
	});
});

describe("start: the reservation (§ 2.2 step 3)", () => {
	test("a second request while one is live is refused, before its first heartbeat too (the startup lease)", () => {
		const w = world();
		const { wl, slice } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}` });
		const live = request(w, wl, slice, PR.green, fx.head.green);
		expect(existsSync(join(w.runs, live, "heartbeat"))).toBe(false);
		const r = start(w, wl, PR.green, ["--slice", slice]);
		expect(r.code).toBe(START_EXIT.refused);
		expect(r.err).toBe(`test-runner start: run ${live} (PR #${PR.green}, slice ${slice}) is live on ${wl}; its test-run: settles it`);
		expect(testRuns(w.ledger.entries(wl)).map((x) => x.request.runId)).toEqual([live]);
	});

	test("a dead runner (no heartbeat past the 120 s lease) is settled as error runner died, then the new run proceeds and settles the slice", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}` });
		const dead = request(w, wl, slice, PR.green, fx.head.green, 200_000);
		const r = start(w, wl, PR.green, ["--slice", slice]);
		expect(r.code).toBe(START_EXIT.ok);
		const runs = testRuns(w.ledger.entries(wl));
		expect(runs[0]!.request.runId).toBe(dead);
		expect(runs[0]!.result).toMatchObject({ verdict: "error", reason: "runner died", runDir: join(w.runs, dead) });
		const runId = runs[1]!.request.runId;
		expect((await resultOf(w, wl, runId)).verdict).toBe("green");
		expect(w.ledger.slice(slice)).toMatchObject({ state: "done", changed_by: TEST_RUNNER_BY });
	});

	test("a queued run stays live past 120 s: its heartbeat runs while it waits for the lock, so a second request is refused", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}` });
		const db = lockDbOf(w);
		// Another run holds the lock with a heartbeat ten minutes ahead: fresh for the whole test, with no timer to keep it so.
		db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-otherholder', 1, 1, '/nowhere', ?)").run(Date.now() + 600_000);
		try {
			// The request is 200 s old (past the startup lease); requested sha ≠ the PR head, so once it runs it ends quickly as stale.
			const queued = request(w, wl, slice, PR.green, fx.main, 200_000);
			const child = spawnRun(w, queued);
			await until("two queued polls", () => marks(w, queued, "queued").length >= 2);
			const first = parseHeartbeat(readFileSync(join(w.runs, queued, "heartbeat"), "utf8"), queued)!;
			await until("a later heartbeat", () => (parseHeartbeat(readFileSync(join(w.runs, queued, "heartbeat"), "utf8"), queued) ?? 0) > first);
			const r = start(w, wl, PR.green, ["--slice", slice]);
			expect(r.code).toBe(START_EXIT.refused);
			expect(r.err).toContain(`run ${queued} `);
			expect(testRuns(w.ledger.entries(wl))).toHaveLength(1);
			db.query("DELETE FROM lock").run();
			expect((await resultOf(w, wl, queued)).verdict).toBe("stale");
			await child.exited;
		} finally {
			db.close();
		}
	});

	test("a run that waits past queueMaxMin ends error queued too long, without touching the holder's lock or current", async () => {
		const w = world({ queueMaxMin: 0.01 });
		const { wl, slice } = workload(w);
		const db = lockDbOf(w);
		db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-otherholder', 1, 1, '/nowhere', ?)").run(Date.now() + 600_000);
		try {
			const runId = request(w, wl, slice, PR.green, fx.head.green);
			await spawnRun(w, runId).exited;
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "error", reason: "queued too long", full: null });
			expect(lockRow(db)!.runId).toBe("tr-otherholder");
			expect(existsSync(join(w.as2, "stage", "current"))).toBe(false);
			expect(heldMessages(w, wl).map((m) => m.body)).toEqual([`test-run-failed: ${wl} ${slice} error at ${fx.head.green}: 0 failing`]);
		} finally {
			db.close();
		}
	});
});

// ---- whole runs ------------------------------------------------------------------------------------------

describe("run: verdicts and the settle (§ 2.3 steps 2–8)", () => {
	test("green: start prints its line, the run settles the slice it added; ./ exact path; the bundle clone has history and the trusted-main tag; no smudge filter ran; a sweep after each part; no message", async () => {
		const w = world();
		const { wl } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}` });
		// A tag of the trusted name on GitHub, at the PR head: the runner overwrites it with origin/main's sha.
		g(w.origin, "tag", "as2-trusted-main", fx.head.green);
		const r = start(w, wl, PR.green);
		expect(r.code).toBe(START_EXIT.ok);
		const m = /^test-run (tr-[a-z0-9]+) runner (\d+) sha ([0-9a-f]{40}) slice (sl-full-\S+-1) log (\S+)$/.exec(r.out)!;
		expect(m).not.toBeNull();
		const [, runId, pid, sha, slice, log] = m as unknown as string[];
		expect(sha).toBe(fx.head.green);
		expect(log).toBe(join(w.runs, runId!, "runner.log"));
		expect(JSON.parse(readFileSync(join(w.runs, runId!, "runner.json"), "utf8"))).toEqual({ pid: Number(pid), pgid: Number(pid), runId });
		expect(w.ledger.slice(slice!)).toMatchObject({ state: "open", created_by: TEST_RUNNER_BY, task: `full suite outside the fence at PR #${PR.green}` });

		const run = await resultOf(w, wl, runId!);
		expect(run).toMatchObject({ verdict: "green", sha: fx.head.green, headAtEnd: fx.head.green, base: fx.main, mergeBase: fx.main, runDir: join(w.runs, runId!) });
		expect(run.full).toMatchObject({ pass: 2, fail: 0, exit: 0, error: null });
		// `./a.test.ts` alone runs a.test.ts only: xa.test.ts, which `a.test.ts` as a substring would also match, is not in it.
		expect(run.solo).toEqual([expect.objectContaining({ file: "./a.test.ts", pass: 1, fail: 0, exit: 0, error: null })]);
		expect(run.preflight).toContain("probe:");
		await until("the settle", () => w.ledger.slice(slice!)?.state === "done");
		expect(w.ledger.slice(slice!)!.artifact).toBe(`test-run ${runId}: green at ${fx.head.green} on PR #${PR.green}; full 2/0/0; alone: ./a.test.ts 1/0; ${join(w.runs, runId!)}`);
		expect(JSON.parse(readFileSync(join(w.runs, runId!, "result.json"), "utf8"))).toMatchObject({ runId, verdict: "green", sha: fx.head.green });
		for (const f of ["full.xml", "full.log", "solo-1.xml", "solo-1.log"]) expect(existsSync(join(w.runs, runId!, f))).toBe(true);
		expect(heldMessages(w, wl)).toEqual([]);

		expect(existsSync(join(w.root, "SMUDGED"))).toBe(false);
		expect(marks(w, runId!, "sweep").map((x) => x.after)).toEqual(["publish", "full", "./a.test.ts"]);

		// The handoff: `_as2test`'s clone from the bundle is a real repository.
		const clone = join(workDirOf(runId!, w.as2), "repo");
		expect(g(clone, "rev-parse", "HEAD")).toBe(fx.head.green);
		expect(g(clone, "log", "--format=%H").split("\n")).toEqual([fx.head.green, fx.main]);
		expect(g(clone, "diff", "--name-only", run.mergeBase!)).toBe("a.test.ts");
		expect(g(clone, "remote")).toBe("");
		// The trusted base for `migration-items check`: beside the tested-commit branch, the only ref in the clone, at origin/main.
		expect(g(clone, "for-each-ref", "--format=%(refname) %(objectname)").split("\n")).toEqual([`refs/heads/as2-tested-pr-${PR.green} ${fx.head.green}`, `refs/tags/as2-trusted-main ${fx.main}`]);
		// The lock is released and `current` still names the last run.
		const db = lockDbOf(w);
		expect(lockRow(db)).toBeNull();
		db.close();
		expect(current(w)).toBe(runId!);
		// Control: a plain clone under the same HOME does run the filter, so the fixture was armed for the runner too.
		const control = Bun.spawnSync(["git", "clone", "-q", w.origin, join(w.root, "control")], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: w.home, GIT_CONFIG_NOSYSTEM: "1" }, stderr: "pipe" });
		expect(control.exitCode).toBe(0);
		expect(existsSync(join(w.root, "SMUDGED"))).toBe(true);
	});

	test("every wrapper call starts in the as2test root, never the 0700 run dir _as2test cannot read (item 24, Jo's diagnosis)", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId).exited;
		expect((await resultOf(w, wl, runId)).verdict).toBe("green");
		const calls = readFileSync(join(w.root, "sudo-cwd.log"), "utf8").trim().split("\n").map((l) => l.split(" ")).filter(([, id]) => id === runId);
		expect(calls.map(([sub]) => sub).filter((s, i, all) => all.indexOf(s) === i).sort()).toEqual(["full", "prepare", "probe", "solo", "sweep"]);
		for (const [sub, , cwd] of calls) expect({ sub, cwd }).toEqual({ sub, cwd: w.as2 });
	});

	test("a changed test file whose name begins with a space keeps it: the solo part runs `./ a.test.ts`, not its sibling `./a.test.ts` in its place", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.space, fx.head.space);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.solo).toEqual([
			expect.objectContaining({ file: "./ a.test.ts", pass: 1, fail: 0, error: null }),
			expect.objectContaining({ file: "./a.test.ts", pass: 1, fail: 0, error: null }),
		]);
		expect(run.verdict).toBe("green");
	});

	test("fullWorkers (wl-mvg2kzuvwngdmo): the trusted phase writes it into caps.json, and runner.log carries `full workers <n>` after the lock and before the PR full part; absent, n is 1", async () => {
		for (const [workers, n] of [[3, 3], [undefined, 1]] as const) {
			const w = world({ fullWorkers: workers });
			const { wl, slice } = workload(w);
			const runId = request(w, wl, slice, PR.green, fx.head.green);
			await spawnRun(w, runId).exited;
			const run = await resultOf(w, wl, runId);
			expect(run.verdict).toBe("green");
			expect(run.full).toMatchObject({ pass: 2, fail: 0, exit: 0, error: null });
			expect(JSON.parse(readFileSync(join(w.as2, "stage", runId, "caps.json"), "utf8"))).toEqual({ fullCapMin: 2, soloCapMin: 2, fullWorkers: n });
			const lines = runnerLog(w, runId).split("\n");
			const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
			const workersLine = at(/ full workers \d+$/);
			expect(lines.filter((l) => / full workers /.test(l))).toHaveLength(1);
			expect(lines[workersLine]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z full workers ${n}$`));
			expect(at(/ took the lock$/)).toBeLessThan(workersLine);
			expect(at(new RegExp(` full ${runId} → exit `))).toBeGreaterThan(workersLine);
		}
	}, 120_000);

	test("red keeps the slice open with every failing name and its whole first error line (25 of them), and messages the orchestrator when no lane holds the workload", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.red, fx.head.red);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("red");
		expect(run.full).toMatchObject({ pass: 2, fail: 25, exit: 1, error: null });
		expect(run.solo).toEqual([expect.objectContaining({ file: "./red.test.ts", pass: 1, fail: 25 })]);
		const full = run.failures.filter((f) => f.part === "full");
		expect(full).toHaveLength(25);
		expect(run.failures.filter((f) => f.part === "./red.test.ts")).toHaveLength(25);
		for (const [i, f] of full.entries()) {
			const n = String(i + 1).padStart(2, "0");
			expect(f.name).toBe(`red.test.ts > case ${n}`);
			expect(f.firstError).toContain(`failure ${n}: ${"detail ".repeat(30)}end ${n}`);
		}
		// The entry carries them all, untruncated.
		const entry = w.ledger.entries(wl).find((e) => e.id === run.entryId)!;
		expect(parseTestRun(entry.body)!.failures).toHaveLength(50);
		expect(w.ledger.slice(slice)!.state).toBe("open");
		expect(heldMessages(w, wl)).toEqual([{
			body: `test-run-failed: ${wl} ${slice} red at ${fx.head.red}: 50 failing, first red.test.ts > case 01`, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, state: "held",
		}]);
	});

	test("a red run on a workload a lane holds under a live lease does not message the orchestrator (the lane hears it)", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		w.ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 600_000 });
		const runId = request(w, wl, slice, PR.red, fx.head.red);
		await spawnRun(w, runId).exited;
		expect((await resultOf(w, wl, runId)).verdict).toBe("red");
		expect(heldMessages(w, wl)).toEqual([]);
	});

	test("fix round 1 (F4): a run failing a gates/test/ test while a lane holds the workload under a live lease sends exactly one security-red: and no test-run-failed:", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		w.ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 600_000 });
		expect(w.ledger.liveLaneHolders().some((h) => h.workloadId === wl)).toBe(true);
		const runId = request(w, wl, slice, PR.gate, fx.head.gate);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("red");
		expect(run.failures.map((f) => [f.part, f.name])).toEqual([["full", "gates/test/gate.test.ts > refuses a forged approve"], ["./gates/test/gate.test.ts", "gates/test/gate.test.ts > refuses a forged approve"]]);
		expect(heldMessages(w, wl)).toEqual([{
			body: `security-red: ${wl} ${slice} ${runId} ${fx.head.gate} 2 gates/test/gate.test.ts > refuses a forged approve`, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, state: "held",
		}]);
	});

	// PLAN wl-mv8s8srodefytc rev 17.1 D2: every PR's run, train or not, posts `as2/full-suite` on exactly its sha; branch protection reads it.
	test("the as2/full-suite status: only a terminal state on the sha the fetch confirmed (success, failure, error), none for stale; a failed post is logged and the verdict stands", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const green = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, green).exited;
		expect((await resultOf(w, wl, green)).verdict).toBe("green");
		expect(statusPosts(w)).toEqual([`success ${fx.head.green}`]);
		expect(runnerLog(w, green)).toContain(`status as2/full-suite success on ${fx.head.green} posted`);

		writeFileSync(join(w.root, "status-fails"), "");
		const other = workload(w);
		const red = request(w, other.wl, other.slice, PR.red, fx.head.red);
		await spawnRun(w, red).exited;
		expect((await resultOf(w, other.wl, red)).verdict).toBe("red");
		expect(statusPosts(w).slice(1)).toEqual([`failure ${fx.head.red}`]);
		expect(runnerLog(w, red)).toContain(`status as2/full-suite failure on ${fx.head.red} not posted: gh: Validation Failed (HTTP 422)`);
		expect(w.ledger.slice(other.slice)!.state).toBe("open");

		const third = workload(w);
		const error = request(w, third.wl, third.slice, PR.exit, fx.head.exit);
		await spawnRun(w, error).exited;
		expect((await resultOf(w, third.wl, error)).verdict).toBe("error");
		expect(statusPosts(w).slice(2)).toEqual([`error ${fx.head.exit}`]);

		// A stale run (the PR head is not the requested sha) tested nothing and posts nothing.
		const fourth = workload(w);
		const stale = request(w, fourth.wl, fourth.slice, PR.green, fx.main);
		await spawnRun(w, stale).exited;
		expect((await resultOf(w, fourth.wl, stale)).verdict).toBe("stale");
		expect(statusPosts(w)).toHaveLength(3);
	});

	test("a changed _spec.ts file failing alone with the suite green is red", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.solo, fx.head.solo);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.full).toMatchObject({ pass: 2, fail: 0, exit: 0, error: null });
		expect(run.solo).toEqual([expect.objectContaining({ file: "./order_spec.ts", pass: 0, fail: 1 })]);
		expect(run.verdict).toBe("red");
		expect(run.failures).toEqual([{ part: "./order_spec.ts", name: "order_spec.ts > needs a clean clone", firstError: "error: state leaked by an earlier run is still here" }]);
		expect(w.ledger.slice(slice)!.state).toBe("open");
	});

	test("the head moved mid-run: stale, nothing settled", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		arm(w, runId, "head-recheck");
		const child = spawnRun(w, runId);
		await reached(w, runId, "head-recheck");
		g(w.origin, "update-ref", `refs/pull/${PR.green}/head`, fx.head.red);
		go(w, runId, "head-recheck");
		await child.exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "stale", headAtEnd: fx.head.red });
		expect(run.full).toMatchObject({ pass: 2, fail: 0 });
		expect(run.reason).toContain("moved");
		expect(w.ledger.slice(slice)!.state).toBe("open");
	});

	test("the requested sha is not the fetched head: stale before any test, nothing prepared", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.red);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "stale", full: null, solo: [], failures: [] });
		expect(run.reason).toContain("nothing was tested");
		expect(marks(w, runId, "spawn-prepare")).toEqual([]);
		expect(marks(w, runId, "spawn-full")).toEqual([]);
		expect(existsSync(workDirOf(runId, w.as2))).toBe(false);
		expect(w.ledger.slice(slice)!.state).toBe("open");
	});

	test("a superseded runner's late result settles nothing: its request was settled as dead and a newer one written while it ran", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		arm(w, runId, "result");
		const child = spawnRun(w, runId);
		await reached(w, runId, "result");
		// What a later starter writes for a runner whose heartbeat went stale: `runner died`, then its own request.
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRunBody(runnerDiedRun({ runId, pr: PR.green, sha: fx.head.green, slice, by: LANE })) });
		request(w, wl, slice, PR.green, fx.head.green);
		go(w, runId, "result");
		await child.exited;
		const rec = testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)!;
		expect(rec.results.map((r) => r.verdict)).toEqual(["error", "superseded"]);
		expect(rec.results[1]!.reason).toContain("lost ownership of the request; the run found green");
		expect(rec.results[1]!.full).toMatchObject({ pass: 2, fail: 0 });
		expect(w.ledger.slice(slice)!.state).toBe("open");
		expect(heldMessages(w, wl)).toEqual([]);
	});

	// result.json is published after the test-run transaction. A successor/pause after that
	// entry is visible must find the slice already settled; even a FIFO must not block release.
	test("the settle commits with the test-run: entry: a successor request landing once the entry is visible finds the slice done, and the old green writes nothing after it", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		const release = seedResultFifo(w, runId);
		const child = spawnRun(w, runId);
		const run = await resultOf(w, wl, runId);
		const atEntry = w.ledger.slice(slice)!;
		const successor = request(w, wl, slice, PR.green, fx.head.green);
		expect(JSON.parse(await release())).toMatchObject({ runId, verdict: "green" });
		await child.exited;
		expect(run.verdict).toBe("green");
		expect(atEntry).toMatchObject({ state: "done", changed_by: TEST_RUNNER_BY });
		expect(atEntry.artifact).toStartWith(`test-run ${runId}: green at ${fx.head.green}`);
		expect(w.ledger.slice(slice)).toEqual(atEntry);
		expect(testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === successor)!.results).toEqual([]);
		expect(runnerLog(w, runId)).toContain(`settled ${slice}`);
	});

	test("the settle commits with the test-run: entry: a pause landing once the entry is visible is refused, and the slice keeps the run's own completion", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		const release = seedResultFifo(w, runId);
		const child = spawnRun(w, runId);
		await resultOf(w, wl, runId);
		const atEntry = w.ledger.slice(slice)!;
		let pause = "paused";
		try {
			w.ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: slice, body: "hold on?", options: ["yes", "no"] });
		} catch (e) {
			pause = (e as Error).message;
		}
		await release();
		await child.exited;
		expect(atEntry).toMatchObject({ state: "done", changed_by: TEST_RUNNER_BY });
		expect(atEntry.artifact).toStartWith(`test-run ${runId}: green`);
		expect(pause).toContain("a question needs an open workload and a running or paused slice");
		expect(w.ledger.slice(slice)).toEqual(atEntry);
	});

	test("missing junit gives error, never green", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.exit, fx.head.exit);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("error");
		expect(run.full!.error).toBe("junit report missing");
		expect(w.ledger.slice(slice)!.state).toBe("open");
	});

	test("the child env: no credential variable, HOME under the work dir, GIT_CONFIG_NOSYSTEM=1, and a {HOME, PATH} descendant still finds the git shim; the sweep removes a child the test left", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.env, fx.head.env);
		await spawnRun(w, runId).exited;
		expect((await resultOf(w, wl, runId)).verdict).toBe("green");
		const workDir = workDirOf(runId, w.as2);
		const dump = JSON.parse(readFileSync(join(workDir, "repo", "env-dump.json"), "utf8")) as { env: Record<string, string>; descendantGit: string };
		for (const k of Object.keys(dump.env)) {
			expect(k).not.toMatch(/^(GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_.*|MOONSHOT_.*|SSH_AUTH_SOCK|OMP_.*|AGENT_SYSTEM_TEST_.*)$/);
			if (k.startsWith("AGENT_SYSTEM_")) expect(k).toBe("AGENT_SYSTEM_LEDGER_DB");
		}
		for (const v of Object.values(dump.env)) expect(v).not.toContain("secret-");
		expect(dump.env.HOME).toBe(childLayout(workDir).home);
		expect(dump.env.AGENT_SYSTEM_LEDGER_DB!.startsWith(`${workDir}/`)).toBe(true);
		expect(dump.env.GIT_CONFIG_NOSYSTEM).toBe("1");
		expect(dump.descendantGit).toBe(join(childLayout(workDir).shimDir, "git"));
		const leftover = Number(readFileSync(join(workDir, "repo", "leftover.pid"), "utf8"));
		expect(alive(leftover)).toBe(false);
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full", "./env.test.ts"]);
	});

	test("a part past its cap: the wrapper kills its group and the part is error timeout", async () => {
		const w = world({ capMin: 0.05 });
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.hang, fx.head.hang);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("error");
		expect(run.full).toMatchObject({ exit: WRAPPER_EXIT.timeout, error: "timeout" });
		expect(run.solo).toEqual([expect.objectContaining({ file: "./hang.test.ts", error: "timeout" })]);
		const pid = Number(readFileSync(join(workDirOf(runId, w.as2), "repo", "hang.pid"), "utf8"));
		expect(alive(pid)).toBe(false);
	});

	test("retention: past the newest 10, a run loses its stage dir, its work dir (through the fenced cleanup) and its run dir's scratch files; logs, reports and result.json stay", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const old: string[] = [];
		for (let i = 0; i < 11; i++) {
			const id = makeRunId(Date.now() - (20 - i) * 60_000, `old${i}`);
			old.push(id);
			mkdirSync(join(w.runs, id));
			for (const f of ["runner.log", "full.xml", "full.log", "result.json", "heartbeat", "runner.json", "trusted.gitconfig"]) writeFileSync(join(w.runs, id, f), "x\n");
			mkdirSync(join(w.as2, "stage", id, "repo"), { recursive: true });
			mkdirSync(join(w.as2, "runs", id, "repo"), { recursive: true });
		}
		// The new run asks for a sha the PR does not have, so it ends right after retention, before any test.
		const runId = request(w, wl, slice, PR.green, fx.main);
		await spawnRun(w, runId).exited;
		expect((await resultOf(w, wl, runId)).verdict).toBe("stale");
		// Twelve runs: the two oldest are pruned.
		for (const id of old.slice(0, 2)) {
			expect(existsSync(join(w.as2, "stage", id))).toBe(false);
			expect(existsSync(join(w.as2, "runs", id))).toBe(false);
			expect(readdirSync(join(w.runs, id)).sort()).toEqual(["full.log", "full.xml", "result.json", "runner.log"]);
		}
		for (const id of old.slice(2)) {
			expect(existsSync(join(w.as2, "stage", id))).toBe(true);
			expect(existsSync(join(w.as2, "runs", id))).toBe(true);
			expect(existsSync(join(w.runs, id, "heartbeat"))).toBe(true);
		}
		expect(marks(w, runId, "spawn-cleanup")).toHaveLength(2);
	});
});

// ---- red main: failing parts rerun on base (PLAN wl-mv8s8srodefytc rev 17.1 D8) ---------------------------------

const BROKEN = `import { test } from "bun:test";
test("main is red", () => { throw new Error("broken on main"); });
test("passes", () => {});
`;
// A pair that fails in the suite and passes alone: each records its load in the process, and the one loaded second fails.
const ALONE = `import { test } from "bun:test";
const g = globalThis as { __alone?: number };
g.__alone = (g.__alone ?? 0) + 1;
const me = g.__alone;
test("passes alone", () => { if (me > 1) throw new Error("the other file of the pair ran first in this process"); });
`;
const TOUCHED = "// touched by the PR\n";

/**
 * The world's GitHub with a red main: main gains broken.test.ts (one failing test), the ALONE pair and `mainFiles`, then each PR
 * is one commit on that main at refs/pull/<N>/head, its files written over main's.
 */
function redMain(w: World, prs: Record<number, Record<string, string>>, mainFiles: Record<string, string> = {}): { main: string; head: Record<number, string> } {
	const work = join(w.root, "red-main");
	g(w.root, "clone", "-q", w.origin, work);
	const files: Record<string, string> = { "broken.test.ts": BROKEN, "alone_a.test.ts": ALONE, "alone_b.test.ts": ALONE, ...mainFiles };
	for (const [f, text] of Object.entries(files)) {
		mkdirSync(dirname(join(work, f)), { recursive: true });
		writeFileSync(join(work, f), text);
	}
	g(work, "add", "-A");
	g(work, "commit", "-q", "-m", "main goes red");
	const main = g(work, "rev-parse", "HEAD");
	g(work, "push", "-q", "origin", "HEAD:refs/heads/main");
	const head: Record<number, string> = {};
	for (const [n, over] of Object.entries(prs)) {
		g(work, "checkout", "-q", "--detach", main);
		for (const [f, text] of Object.entries(over)) writeFileSync(join(work, f), text);
		g(work, "add", "-A");
		g(work, "commit", "-q", "-m", `pr ${n}`);
		head[Number(n)] = g(work, "rev-parse", "HEAD");
		g(work, "push", "-q", "origin", `+HEAD:refs/pull/${n}/head`);
	}
	return { main, head };
}
/** The wrapper subcommands one run made, in order (the fake sudo's log). */
const subsOf = (w: World, runId: string): string[] =>
	readFileSync(join(w.root, "sudo.log"), "utf8").trim().split("\n").map((l) => l.split(" ")).filter(([, id]) => id === runId).map(([sub]) => sub!);
const cached = (w: World, sha: string, part: string): boolean => existsSync(join(w.runs, "base-cache", sha, `${encodeURIComponent(part)}.json`));

describe("red main: each failing part rerun on base (PLAN wl-mv8s8srodefytc rev 17.1 D8)", () => {
	test("a full-only failure that passes alone and fails on base's full run is red-main: settled, status success, no message; a second PR on that base reuses base's full result", async () => {
		const w = world();
		const r = redMain(w, { 21: { "alone_a.test.ts": ALONE + TOUCHED, "alone_b.test.ts": ALONE + TOUCHED }, 22: { "broken.test.ts": BROKEN + TOUCHED } });

		const one = workload(w);
		const first = request(w, one.wl, one.slice, 21, r.head[21]!);
		await spawnRun(w, first).exited;
		const run = await resultOf(w, one.wl, first);
		expect(run).toMatchObject({ verdict: "red-main", base: r.main });
		expect(run.full).toMatchObject({ fail: 2, error: null });
		expect(run.solo).toEqual([expect.objectContaining({ file: "./alone_a.test.ts", fail: 0 }), expect.objectContaining({ file: "./alone_b.test.ts", fail: 0 })]);
		// only the full part failed, so only the full argv ran on base, and base failed every one of its failures
		expect(run.baseCompare!.sha).toBe(r.main);
		expect(run.baseCompare!.parts.map((p) => p.part)).toEqual(["full"]);
		const full = run.baseCompare!.parts[0]!;
		expect(full.failing).toContain("broken.test.ts > main is red");
		expect(full.baseFailing).toEqual(expect.arrayContaining(full.failing));
		expect(subsOf(w, first)).toEqual(expect.arrayContaining(["base-prepare", "base-full"]));
		expect(subsOf(w, first)).not.toContain("base-solo");
		expect(cached(w, r.main, "full")).toBe(true);
		await until("the settle", () => w.ledger.slice(one.slice)?.state === "done");
		expect(w.ledger.slice(one.slice)!.artifact).toStartWith(`test-run ${first}: red-main at ${r.head[21]} on PR #21;`);
		expect(w.ledger.slice(one.slice)!.artifact).toContain(r.main);
		expect(statusPosts(w)).toEqual([`success ${r.head[21]}`]);
		expect(heldMessages(w, one.wl)).toEqual([]);

		// PR #22 fails the same test in the suite and alone: each part is compared with base's run of that part; full comes from the cache
		const two = workload(w);
		const second = request(w, two.wl, two.slice, 22, r.head[22]!);
		await spawnRun(w, second).exited;
		const run2 = await resultOf(w, two.wl, second);
		expect(run2.verdict).toBe("red-main");
		expect(run2.baseCompare!.parts.map((p) => [p.part, p.baseError])).toEqual([["full", null], ["./broken.test.ts", null]]);
		expect(run2.baseCompare!.parts[1]).toMatchObject({ failing: ["broken.test.ts > main is red"], baseFailing: ["broken.test.ts > main is red"] });
		expect(runnerLog(w, second)).toContain(`base full at ${r.main}: cached`);
		expect(subsOf(w, second)).toEqual(expect.arrayContaining(["base-prepare", "base-solo"]));
		expect(subsOf(w, second)).not.toContain("base-full");
		expect(cached(w, r.main, "./broken.test.ts")).toBe(true);
		expect(statusPosts(w)).toEqual([`success ${r.head[21]}`, `success ${r.head[22]}`]);
	});

	test("fix round 1 (F4): a gates/test/ test that fails on base too is red-main, and still sends exactly one security-red: (no test-run-failed:)", async () => {
		const w = world();
		const gate = "gates/test/gate.test.ts";
		const r = redMain(w, { 23: { [gate]: GATE_RED + TOUCHED } }, { [gate]: GATE_RED });
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, 23, r.head[23]!);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "red-main", base: r.main });
		const security = run.failures.filter((f) => f.name.startsWith(`${gate} > `));
		expect(security.map((f) => f.part)).toEqual(["full", `./${gate}`]);
		expect(heldMessages(w, wl)).toEqual([{
			body: `security-red: ${wl} ${slice} ${runId} ${r.head[23]} 2 ${gate} > refuses a forged approve`, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, state: "held",
		}]);
	});

	test("one failure base does not have gives red; a base part that errored gives red and is not cached; neither posts success", async () => {
		const w = world();
		const NEW_RED = `import { test } from "bun:test";\ntest("new failure", () => { throw new Error("the PR broke it"); });\n`;
		// The PR's own test plants runs/<id>/base, so base cannot be prepared beside its clone.
		const PLANT = `import { test } from "bun:test";\nimport { mkdirSync } from "node:fs";\ntest("main is red", () => { throw new Error("broken on main"); });\ntest("passes", () => { mkdirSync("../base", { recursive: true }); });\n`;
		const r = redMain(w, { 23: { "new_red.test.ts": NEW_RED }, 24: { "broken.test.ts": PLANT } });

		const one = workload(w);
		const first = request(w, one.wl, one.slice, 23, r.head[23]!);
		await spawnRun(w, first).exited;
		const run = await resultOf(w, one.wl, first);
		expect(run.verdict).toBe("red");
		const full = run.baseCompare!.parts.find((p) => p.part === "full")!;
		expect(full.failing).toContain("new_red.test.ts > new failure");
		expect(full.baseFailing).not.toContain("new_red.test.ts > new failure");
		expect(full.baseFailing).toContain("broken.test.ts > main is red");
		expect(w.ledger.slice(one.slice)!.state).toBe("open");

		const two = workload(w);
		const second = request(w, two.wl, two.slice, 24, r.head[24]!);
		await spawnRun(w, second).exited;
		const run2 = await resultOf(w, two.wl, second);
		expect(run2.verdict).toBe("red");
		// the full part matches base's (cached) full run; the solo part never ran on base
		expect(run2.baseCompare!.parts.map((p) => [p.part, p.baseError === null])).toEqual([["full", true], ["./broken.test.ts", false]]);
		expect(runnerLog(w, second)).toContain("base-prepare failed");
		expect(cached(w, r.main, "./broken.test.ts")).toBe(false);
		expect(w.ledger.slice(two.slice)!.state).toBe("open");
		expect(statusPosts(w)).toEqual([`failure ${r.head[23]}`, `failure ${r.head[24]}`]);
	});

	test("base reruns longer than the finalize deadline still settle red-main: the post-sweep deadline starts after base runs", async () => {
		const w = world();
		const r = redMain(w, { 25: { "alone_a.test.ts": ALONE + TOUCHED, "alone_b.test.ts": ALONE + TOUCHED } });
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, 25, r.head[25]!);
		arm(w, runId, "phase-base-prepare");
		const child = spawnRun(w, runId, { AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS: "2000" });
		try {
			await reached(w, runId, "phase-base-prepare");
			// A real delay: the runner is a spawned process timing its deadline with its own Date.now(), out of reach
			// of fake timers. Holding base-prepare past the 2 s finalize window is what the ordering must survive; 2 s
			// leaves finalization itself (a hook, a local git ls-remote, the result hook) ample room on a loaded machine.
			await Bun.sleep(3000);
			go(w, runId, "phase-base-prepare");
			await child.exited;
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "red-main", base: r.main });
			expect(run.baseCompare!.parts.map((p) => p.part)).toEqual(["full"]);
			await until("the settle", () => w.ledger.slice(slice)?.state === "done");
			expect(statusPosts(w)).toEqual([`success ${r.head[25]}`]);
		} finally {
			go(w, runId, "phase-base-prepare");
			await child.exited;
		}
	});
});

// ---- the bundle refresh (PLAN wl-mv718fxhwwcn40 § 1.3, § 2 T1–T4) -------------------------------------------

describe("the preflight refreshes a drifted bundle before the first sweep (PLAN wl-mv718fxhwwcn40 § 1.3)", () => {
	/** The runner's own checkout, whose test-exec.ts the install check hashes (test-runner.ts REPO_ROOT). */
	const REPO = resolve(import.meta.dir, "..", "..");
	const OLD12 = "0".repeat(12);
	const NEW12 = "1".repeat(12);
	const RERUN = "re-run install/as2test-setup.sh";

	/** Arm `<libexec>/refresh` with a sh body, then rewrite the installed SOURCE so it records the armed helper's hash. */
	function setRefresh(w: World, body: string): void {
		writeFileSync(join(w.libexec, "refresh"), `#!/bin/sh\n${body}\n`);
		chmodSync(join(w.libexec, "refresh"), 0o755);
		writeSource(w.libexec);
	}
	/** The fake sudo's calls in order: `refresh`, or the wrapper subcommand. */
	function sudoCalls(w: World): string[] {
		const log = join(w.root, "sudo.log");
		return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")[0]!) : [];
	}
	/** One run of the green PR, to its `test-run:`. */
	async function runGreen(w: World): Promise<{ wl: string; run: TestRun }> {
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId).exited;
		return { wl, run: await resultOf(w, wl, runId) };
	}

	test("T1: an input drifted in the runner's checkout; the helper is called once and refreshes, the run goes green with `refreshed` in its preflight, and nothing reaches the orchestrator", async () => {
		const w = world();
		const good = join(w.root, "SOURCE.good");
		setRefresh(w, `cp '${good}' '${join(w.libexec, "SOURCE")}' || exit 72\necho "refreshed ${OLD12}..${NEW12}"`);
		writeSource(w.libexec, { to: good });
		writeSource(w.libexec, { inputSha: "f".repeat(64) });
		const { wl, run } = await runGreen(w);
		expect({ verdict: run.verdict, reason: run.reason }).toEqual({ verdict: "green", reason: null });
		expect(run.preflight).toContain(`; refreshed ${OLD12}..${NEW12}; probe: `);
		expect(sudoCalls(w).filter((c) => c === "refresh")).toHaveLength(1);
		expect(sudoCalls(w)[0]).toBe("refresh");
		expect(w.ledger.questions(wl)).toEqual([]);
		expect(heldMessages(w, wl)).toEqual([]);
		expect(w.ledger.entries(wl).filter((e) => e.body.startsWith("test-run-failed"))).toEqual([]);
	});

	test("T2: the helper exits 70; the run is error bundle-refresh-failed with the helper's last stderr line, no re-run-setup advice, one call and no wrapper call", async () => {
		const w = world();
		setRefresh(w, `echo "as2test-refresh: starting" >&2\necho "as2test-refresh: fetching main from https://github.com/${OWNER_REPO}.git failed" >&2\nexit 70`);
		writeSource(w.libexec, { inputSha: "f".repeat(64) });
		const { run } = await runGreen(w);
		expect(run.verdict).toBe("error");
		expect(run.reason).toBe(`preflight: bundle-refresh-failed: the refresh helper fetch (exit 70): as2test-refresh: fetching main from https://github.com/${OWNER_REPO}.git failed`);
		expect(run.reason).not.toContain(RERUN);
		expect(sudoCalls(w)).toEqual(["refresh"]);
	});

	test("T2b: a helper past the runner's cap gets SIGTERM, then SIGKILL; the runner waits for its sudo to exit, and the run is error bundle-refresh-failed naming the cap", async () => {
		const w = world();
		// It ignores TERM, as a root helper's sudo may never pass one on: only the SIGKILL ends it.
		setRefresh(w, `echo "as2test-refresh: building" >&2\ntrap '' TERM\nexec /bin/sleep 60`);
		writeSource(w.libexec, { inputSha: "f".repeat(64) });
		w.env.AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS = "1000";
		w.env.AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS = "500";
		const t0 = Date.now();
		const { run } = await runGreen(w);
		expect(Date.now() - t0).toBeLessThan(30_000);
		expect(run.verdict).toBe("error");
		expect(run.reason).toBe(
			"preflight: bundle-refresh-failed: the refresh helper ended by SIGKILL after the runner's 1 s cap; the helper may still be running, and the next refresh waits on its lock (exit 69, lock, while it holds it): as2test-refresh: building",
		);
		expect(sudoCalls(w)).toEqual(["refresh"]);
	}, 60_000);

	test("T2c: a helper whose sudo the runner cannot signal outlives the reap wait; the run is error bundle-refresh-failed naming the cap and saying the helper may still be running; the next run's refresh waits on the helper's lock and exits 69", async () => {
		const w = world();
		const lock = join(w.root, "helper.lock");
		const pidFile = join(w.root, "helper.pid");
		// It holds its own lock, as the real helper holds refresh.d/lock, and ignores TERM; a second call waits 1 s on the lock and exits 69.
		setRefresh(w, [
			`echo "as2test-refresh: building" >&2`,
			"trap '' TERM",
			`/usr/bin/lockf -s -t 1 '${lock}' /bin/sh -c 'echo $$ > "$1"; exec /bin/sleep 60' as2test-fake '${pidFile}'`,
			`[ "$?" -ne 75 ] || { echo "as2test-refresh: another refresh holds ${lock} (waited 1 s)" >&2; exit 69; }`,
		].join("\n"));
		writeSource(w.libexec, { inputSha: "f".repeat(64) });
		w.env.AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS = "1000";
		w.env.AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS = "500";
		w.env.AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS = "500";
		const { wl, slice } = workload(w);
		const first = request(w, wl, slice, PR.green, fx.head.green);
		// The kernel refuses Jo's signals to a root sudo; this hook file stands in for that refusal.
		writeFileSync(join(w.hooks, `${first}.refresh-signal.refuse`), "");
		try {
			const t0 = Date.now();
			await spawnRun(w, first).exited;
			const run = await resultOf(w, wl, first);
			expect(Date.now() - t0).toBeLessThan(30_000);
			expect(run.verdict).toBe("error");
			expect(run.reason).toBe(
				"preflight: bundle-refresh-failed: the refresh helper still running 0.5 s after its SIGKILL after the runner's 1 s cap; the helper may still be running, and the next refresh waits on its lock (exit 69, lock, while it holds it): as2test-refresh: building",
			);
			const sigOf = (line: string): unknown => {
				const mark: unknown = JSON.parse(line);
				return mark && typeof mark === "object" && "sig" in mark ? mark.sig : null;
			};
			const marks = readFileSync(join(w.hooks, `${first}.refresh-signal.marks`), "utf8").trim().split("\n").map(sigOf);
			expect(marks).toEqual(["SIGTERM", "SIGKILL"]);
			// The helper outlived the run, and the run lock with it.
			const helper = Number(readFileSync(pidFile, "utf8"));
			expect(() => process.kill(helper, 0)).not.toThrow();

			// The next run's refresh: the run lock is free, the helper's lock is not.
			w.env.AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS = "20000";
			const next = await runGreen(w);
			expect(next.run.verdict).toBe("error");
			expect(next.run.reason).toBe(`preflight: bundle-refresh-failed: the refresh helper lock (exit 69): as2test-refresh: another refresh holds ${lock} (waited 1 s)`);
			expect(sudoCalls(w)).toEqual(["refresh", "refresh"]);
		} finally {
			if (existsSync(pidFile)) {
				try {
					process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
				} catch {
					// gone
				}
			}
		}
	}, 60_000);

	test("T3: the helper exits 0 and the input still differs; the run is error checkout-drift, naming the file, the checkout and its HEAD; one call", async () => {
		const w = world();
		setRefresh(w, `echo "current ${NEW12}"`);
		writeSource(w.libexec, { inputSha: "f".repeat(64) });
		const { run } = await runGreen(w);
		expect(run.verdict).toBe("error");
		const head12 = g(REPO, "rev-parse", "HEAD").slice(0, 12);
		expect(run.reason).toBe(
			`preflight: checkout-drift: surface/scripts/test-exec.ts in the runner's checkout ${REPO} (HEAD ${head12}) differs from the bundle, which is built from origin/main ${OLD12}; bring the checkout to origin/main`,
		);
		expect(sudoCalls(w)).toEqual(["refresh"]);
	});

	test("T3b: the helper exits 0 and leaves test-exec.js off its SOURCE hash; the run is error bundle-refresh-failed, does not match SOURCE; one call", async () => {
		const w = world();
		setRefresh(w, `echo "refreshed ${OLD12}..${NEW12}"`);
		writeFileSync(join(w.libexec, "test-exec.js"), "garbage\n");
		const { run } = await runGreen(w);
		expect(run.verdict).toBe("error");
		expect(run.reason).toBe("preflight: bundle-refresh-failed: the helper exited 0 but installed test-exec.js does not match SOURCE");
		expect(sudoCalls(w)).toEqual(["refresh"]);
	});

	for (const [name, drift] of [
		["replaced by bytes off its SOURCE hash", (p: string) => writeFileSync(p, "garbage\n")],
		["deleted", (p: string) => rmSync(p)],
	] as const) {
		test(`T3c: installed test-exec.js ${name} is file-drift; the helper restores it before any wrapper call, and the run goes green`, async () => {
			const w = world();
			const installed = join(w.libexec, "test-exec.js");
			const good = join(w.root, "test-exec.js.good");
			writeFileSync(good, readFileSync(installed));
			setRefresh(w, `cp '${good}' '${installed}' && chmod 0755 '${installed}' || exit 72\necho "refreshed ${OLD12}..${NEW12}"`);
			drift(installed);
			const { run } = await runGreen(w);
			expect({ verdict: run.verdict, reason: run.reason }).toEqual({ verdict: "green", reason: null });
			expect(run.preflight).toContain(`; refreshed ${OLD12}..${NEW12}; `);
			const calls = sudoCalls(w);
			expect(calls.slice(0, 2)).toEqual(["refresh", "sweep"]);
			expect(calls.filter((c) => c === "refresh")).toHaveLength(1);
		});
	}

	test("T4 (pin): a mode failure and an owner failure are install failures; the helper is not called, even over a drift, and the reason is the one setup fixes", async () => {
		const w = world();
		writeSource(w.libexec, { inputSha: "f".repeat(64) });
		chmodSync(join(w.libexec, "bun"), 0o700);
		const mode = await runGreen(w);
		expect(mode.run.verdict).toBe("error");
		expect(mode.run.reason).toBe(`preflight: ${join(w.libexec, "bun")} has mode 700, expected 755; ${RERUN}`);
		expect(sudoCalls(w)).not.toContain("refresh");

		chmodSync(join(w.libexec, "bun"), 0o755);
		const uid = process.getuid!();
		const gid = statSync(w.libexec).gid;
		const install = JSON.parse(w.env.AGENT_SYSTEM_TEST_RUNNER_INSTALL!) as { ids: { root: number } };
		install.ids.root = uid + 1;
		w.env.AGENT_SYSTEM_TEST_RUNNER_INSTALL = JSON.stringify(install);
		const owner = await runGreen(w);
		expect(owner.run.verdict).toBe("error");
		expect(owner.run.reason).toBe(`preflight: ${w.libexec} is owned ${uid}:${gid}, expected ${uid + 1}:${gid}; ${RERUN}`);
		expect(sudoCalls(w)).not.toContain("refresh");
	});
});

// ---- the report import (§ 2.2 step 4) ----------------------------------------------------------------------

describe("the junit and log import", () => {
	function dirs() {
		const root = realpathSync(tmp("trun-import"));
		roots.push(root);
		mkdirSync(join(root, "work"));
		mkdirSync(join(root, "run"));
		return { work: join(root, "work"), run: join(root, "run"), root };
	}
	const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.01">\n  <testsuite name="a.test.ts" file="a.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.01">\n    <testcase name="a" classname="" time="0.01" file="a.test.ts" assertions="1" />\n  </testsuite>\n</testsuites>\n`;

	test("a regular file under the cap is copied into the run dir and parsed", () => {
		const d = dirs();
		writeFileSync(join(d.work, "full.xml"), JUNIT);
		writeFileSync(join(d.work, "full.log"), "a.test.ts:\n(pass) a\n");
		const p = importPart(d.work, d.run, "full", 1_000_000);
		expect(p.importError).toBeNull();
		expect(readFileSync(join(d.run, "full.xml"), "utf8")).toBe(JUNIT);
		expect(partResult({ ...p, exit: 0, ms: 5 })).toMatchObject({ pass: 1, fail: 0, error: null });
	});

	test("a symlinked junit, a FIFO with no writer (the open does not block), an over-cap report or log each make the part error", () => {
		const d = dirs();
		writeFileSync(join(d.root, "elsewhere.xml"), JUNIT);
		symlinkSync(join(d.root, "elsewhere.xml"), join(d.work, "full.xml"));
		expect(importReport(d.work, d.run, "full.xml", 1_000_000)).toEqual({ text: null, error: "full.xml is a symlink" });
		const linked = importPart(d.work, d.run, "full", 1_000_000);
		expect(partResult({ ...linked, exit: 0, ms: 1 })).toMatchObject({ error: "report import refused: full.xml is a symlink", pass: 0, fail: 0 });
		expect(existsSync(join(d.run, "full.xml"))).toBe(false);

		expect(Bun.spawnSync(["/usr/bin/mkfifo", join(d.work, "solo-1.xml")]).exitCode).toBe(0);
		const t0 = Date.now();
		expect(importReport(d.work, d.run, "solo-1.xml", 1_000_000)).toEqual({ text: null, error: "solo-1.xml is not a regular file" });
		expect(Date.now() - t0).toBeLessThan(2_000);

		writeFileSync(join(d.work, "solo-2.xml"), JUNIT);
		expect(importReport(d.work, d.run, "solo-2.xml", 100)).toEqual({ text: null, error: "solo-2.xml is over the 100-byte report cap" });
		writeFileSync(join(d.work, "solo-2.log"), "x".repeat(JUNIT.length + 1));
		const overLog = importPart(d.work, d.run, "solo-2", JUNIT.length);
		expect(partResult({ ...overLog, exit: 0, ms: 1 }).error).toBe(`report import refused: solo-2.log is over the ${JUNIT.length}-byte report cap`);
	});

	test("a missing junit is error, never green", () => {
		const d = dirs();
		const p = importPart(d.work, d.run, "full", 1_000_000);
		expect(p).toEqual({ junit: null, log: null, importError: null });
		expect(partResult({ ...p, exit: 0, ms: 1 })).toMatchObject({ error: "junit report missing" });
	});
});

// ---- the lock, publication and fencing, with paused boundaries (§ 2.3 step 1) ---------------------------------

describe("the runs lock and current", () => {
	test("(a) a clean acquisition publishes current in its own transaction; while it is open the other waiter stays busy, then queues until the holder is done", async () => {
		const w = world();
		const a = workload(w);
		const b = workload(w);
		const A = request(w, a.wl, a.slice, PR.green, fx.head.green);
		// B asks for a sha the PR does not have: once it holds the lock it ends at once as stale.
		const B = request(w, b.wl, b.slice, PR.green, fx.main);
		arm(w, A, "acquire-tx");
		const ca = spawnRun(w, A);
		await reached(w, A, "acquire-tx");
		// Inside A's open transaction: current already names A, the row is not yet visible, and no other writer gets in.
		expect(current(w)).toBe(A);
		const probe = lockDbOf(w);
		expect(lockRow(probe)).toBeNull();
		expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow();
		probe.close();
		const cb = spawnRun(w, B);
		await until("B busy on A's open transaction", () => marks(w, B, "acquire-busy").length >= 1);
		expect(marks(w, B, "acquired")).toEqual([]);
		go(w, A, "acquire-tx");
		await until("B queued behind A", () => marks(w, B, "queued").length >= 1);
		await until("A's acquisition committed", () => marks(w, A, "acquired").length === 1);
		expect(marks(w, A, "acquired")).toEqual([expect.objectContaining({ displaced: null })]);
		await ca.exited;
		expect((await resultOf(w, a.wl, A)).verdict).toBe("green");
		await cb.exited;
		expect((await resultOf(w, b.wl, B)).verdict).toBe("stale");
		const aDone = (marks(w, A, "result")[0]!.at as number);
		expect(marks(w, B, "acquired")).toEqual([expect.objectContaining({ displaced: null })]);
		expect(marks(w, B, "acquired")[0]!.at as number).toBeGreaterThanOrEqual(aDone);
		expect(current(w)).toBe(B);
	});

	test("two waiters on one stale lock row, SQLITE_BUSY retried: exactly one takes it over", async () => {
		const w = world();
		const db = lockDbOf(w);
		db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-staleholder', 1, 1, '/nowhere', ?)").run(Date.now() - 120_000);
		db.close();
		const a = workload(w);
		const b = workload(w);
		const A = request(w, a.wl, a.slice, PR.green, fx.main);
		const B = request(w, b.wl, b.slice, PR.green, fx.main);
		arm(w, A, "acquire-tx");
		const ca = spawnRun(w, A);
		await reached(w, A, "acquire-tx");
		const cb = spawnRun(w, B);
		await until("B busy", () => marks(w, B, "acquire-busy").length >= 1);
		go(w, A, "acquire-tx");
		await Promise.all([ca.exited, cb.exited]);
		expect((await resultOf(w, a.wl, A)).verdict).toBe("stale");
		expect((await resultOf(w, b.wl, B)).verdict).toBe("stale");
		const takeovers = [...marks(w, A, "acquired"), ...marks(w, B, "acquired")].filter((m) => m.displaced === "tr-staleholder");
		expect(takeovers).toHaveLength(1);
		expect(marks(w, A, "acquired")).toEqual([expect.objectContaining({ displaced: "tr-staleholder" })]);
		expect(marks(w, B, "acquired")).toEqual([expect.objectContaining({ displaced: null })]);
	});

	test("(b) a runner replaced after it committed publishes nothing later, and current stays B; (f) every wrapper call it makes is fenced", async () => {
		const w = world();
		const a = workload(w);
		const b = workload(w);
		const A = request(w, a.wl, a.slice, PR.green, fx.head.green);
		const B = request(w, b.wl, b.slice, PR.green, fx.head.green);
		arm(w, A, "phase-preflight");
		// A beats once at acquisition and then not again for the length of the test: its row goes stale only when the test says.
		const ca = spawnRun(w, A, { AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "600000" });
		await reached(w, A, "phase-preflight");
		expect(current(w)).toBe(A);
		staleRow(w);
		const cb = spawnRun(w, B);
		await until("B took over", () => marks(w, B, "acquired").length === 1);
		expect(marks(w, B, "acquired")[0]).toMatchObject({ displaced: A });
		expect(current(w)).toBe(B);
		// The guarded publication itself: A's id no longer holds the row, so nothing is written.
		const db = lockDbOf(w);
		expect(publishIfOwner(db, join(w.as2, "stage"), A)).toBe(false);
		db.close();
		expect(current(w)).toBe(B);
		// (f) Each subcommand for A's run id is refused by the fence while current names B.
		const calls: WrapperCall[] = [
			{ sub: "prepare", runId: A, sha: fx.head.green }, { sub: "full", runId: A }, { sub: "solo", runId: A, file: "./a.test.ts" }, { sub: "sweep", runId: A },
			{ sub: "cleanup", runId: A, oldRunId: B }, { sub: "probe", runId: A, paths: [w.home] },
		];
		for (const call of calls) {
			const r = Bun.spawnSync(wrapperArgv(call, w.exec), { env: w.env, stdout: "pipe", stderr: "pipe" });
			expect([call.sub, r.exitCode]).toEqual([call.sub, WRAPPER_EXIT.fenced]);
		}
		go(w, A, "phase-preflight");
		await ca.exited;
		const ra = await resultOf(w, a.wl, A);
		expect(ra.verdict).toBe("superseded");
		expect(ra.reason).toContain(`the lock row holds ${B}`);
		expect(marks(w, A, "spawn-probe")).toEqual([]);
		expect(marks(w, A, "spawn-prepare")).toEqual([]);
		expect(w.ledger.slice(a.slice)!.state).toBe("open");
		await cb.exited;
		expect((await resultOf(w, b.wl, B)).verdict).toBe("green");
	});

	test("(e) a displaced runner's heartbeat updates no row and cannot keep the successor's lock alive", async () => {
		const w = world();
		const a = workload(w);
		const b = workload(w);
		const A = request(w, a.wl, a.slice, PR.green, fx.head.green);
		const B = request(w, b.wl, b.slice, PR.green, fx.main);
		const ca = spawnRun(w, A);
		await until("A holds the lock", () => marks(w, A, "acquired").length === 1);
		arm(w, A, "heartbeat-update");
		await reached(w, A, "heartbeat-update");
		// A is frozen before its next UPDATE; its row goes stale and B takes it over.
		staleRow(w);
		const cb = spawnRun(w, B);
		await until("B took over", () => marks(w, B, "acquired").length === 1);
		const before = (() => {
			const db = lockDbOf(w);
			try {
				return lockRow(db)!;
			} finally {
				db.close();
			}
		})();
		expect(before.runId).toBe(B);
		const frozenUntil = Date.now();
		go(w, A, "heartbeat-update");
		await until("A's heartbeat after the takeover", () => marks(w, A, "heartbeat").some((m) => (m.at as number) >= frozenUntil));
		expect(marks(w, A, "heartbeat").filter((m) => (m.at as number) >= frozenUntil)).toEqual([expect.objectContaining({ changes: 0 })]);
		await Promise.all([ca.exited, cb.exited]);
		expect((await resultOf(w, a.wl, A)).verdict).toBe("superseded");
		expect((await resultOf(w, b.wl, B)).verdict).toBe("stale");
		expect(marks(w, B, "acquired")[0]).toMatchObject({ displaced: A });
	});
});

// ---- the lock queue: oldest request first (plan of wl-mvfutg9edknu2o) ------------------------------------------

type Child = Subprocess<"ignore", number, number>;
interface Waiter {
	id: string;
	wl: string;
	slice: string;
}

/** A request on its own workload, `agoMs` in the past, for a sha the PR does not have: once the run holds the lock it ends at once as stale. */
function waiter(w: World, agoMs: number): Waiter {
	const { wl, slice } = workload(w);
	const id = request(w, wl, slice, PR.green, fx.main, agoMs);
	// The next run id takes a later clock reading: run ids are strictly ordered by creation.
	Bun.sleepSync(5);
	return { id, wl, slice };
}

/** C, then B, then A, requested 10, 20 and 30 s ago: run-id order (C < B < A) is the opposite of request order (A < B < C). */
function requestsCBA(w: World): { A: Waiter; B: Waiter; C: Waiter } {
	const C = waiter(w, 10_000);
	const B = waiter(w, 20_000);
	const A = waiter(w, 30_000);
	expect([A.id, B.id, C.id].toSorted()).toEqual([C.id, B.id, A.id]);
	return { A, B, C };
}

/** `fn` on the world's runs.db, waiting up to 2 s for a runner's transaction. */
function runsDb<T>(w: World, fn: (db: Database) => T): T {
	const db = openLockDb(w.runs, 2_000);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

/** Another run holds the lock with a heartbeat ten minutes ahead: live for the whole test, until the test changes it. */
const holdLock = (w: World): void => {
	runsDb(w, (db) => db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-otherholder', 1, 1, '/nowhere', ?)").run(Date.now() + 600_000));
};

const queueRows = (w: World) =>
	runsDb(w, (db) => db.query<{ runId: string; workloadId: string; requestedAt: number }, []>("SELECT runId, workloadId, requestedAt FROM queue ORDER BY requestedAt, runId").all());

function heartbeatAt(w: World, runId: string): number | null {
	try {
		return parseHeartbeat(readFileSync(join(w.runs, runId, "heartbeat"), "utf8"), runId);
	} catch {
		return null;
	}
}

function writeHeartbeat(w: World, runId: string, atMs: number): void {
	mkdirSync(join(w.runs, runId), { recursive: true });
	writeFileSync(join(w.runs, runId, "heartbeat"), heartbeatText(runId, atMs));
}

/** The request's own `created_at` in ms: the key its queue row carries. */
const requestedAtOf = (w: World, r: Waiter): number => Date.parse(testRuns(w.ledger.entries(r.wl)).find((x) => x.request.runId === r.id)!.request.createdAt);

/** A queue row the test writes for a waiter that is no process. */
function queueRow(w: World, runId: string, workloadId: string, requestedAt: number): void {
	runsDb(w, (db) => db.query("INSERT INTO queue (runId, workloadId, requestedAt) VALUES (?, ?, ?)").run(runId, workloadId, requestedAt));
}

/** The request settled as a later starter settles a dead runner's: `test-run: … error runner died`. */
function settleDead(w: World, r: Waiter): void {
	w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: r.wl, sliceId: r.slice, kind: "assumption", body: testRunBody(runnerDiedRun({ runId: r.id, pr: PR.green, sha: fx.main, slice: r.slice, by: LANE })) });
}

/**
 * The child is stopped once its heartbeat file has not changed for over two heartbeat periods (the world's 500 ms): a running
 * runner rewrites it every period. (`ps` cannot be spawned in every sandbox this suite runs in.)
 */
async function seenStopped(w: World, runId: string): Promise<void> {
	const quietMs = 2 * Number(w.env.AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS) + 100;
	let seen = heartbeatAt(w, runId);
	let since = Date.now();
	await until(`${runId} stopped (its heartbeat unchanged for ${quietMs} ms)`, () => {
		const now = heartbeatAt(w, runId);
		if (now !== seen) {
			seen = now;
			since = Date.now();
		}
		return Date.now() - since > quietMs;
	}, 20_000);
}

/**
 * Stop `child` outside any runs.db transaction: wait for its heartbeat under 1 s old, SIGSTOP it, and see it stopped; then a
 * probe connection (busy_timeout 300 ms) runs BEGIN IMMEDIATE; COMMIT. A busy probe means the child froze inside its acquiring
 * transaction: SIGCONT, sleep one poll, try again (at most 10 times). Every wait is bounded at 20 s, under the 60 s stale threshold.
 */
async function stopOutsideTx(w: World, child: Child, runId: string): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		await until(`a heartbeat of ${runId} under 1 s old`, () => Date.now() - (heartbeatAt(w, runId) ?? 0) < 1_000, 20_000);
		process.kill(child.pid, "SIGSTOP");
		await seenStopped(w, runId);
		const probe = new Database(join(w.runs, "runs.db"));
		try {
			probe.exec("PRAGMA busy_timeout = 300");
			probe.exec("BEGIN IMMEDIATE");
			probe.exec("COMMIT");
			return;
		} catch (e) {
			if (!(e instanceof Error && "code" in e && String(e.code).startsWith("SQLITE_BUSY"))) throw e;
		} finally {
			probe.close();
		}
		process.kill(child.pid, "SIGCONT");
		// One runner poll (the world's 200 ms) before the next stop, so the child can finish the transaction it froze in.
		await Bun.sleep(200);
	}
	throw new Error(`${runId} froze inside a runs.db transaction on every one of 10 stops`);
}

/** Every child resumed, killed and awaited: a failing assertion leaves no stopped process behind. */
async function reap(children: Child[]): Promise<void> {
	for (const c of children) {
		if (c.exitCode === null && c.signalCode === null) {
			try {
				process.kill(c.pid, "SIGCONT");
			} catch {
				// already gone
			}
			c.kill("SIGKILL");
		}
		await c.exited;
	}
}

const queuedCount = (w: World, r: Waiter): number => marks(w, r.id, "queued").length;
const acquiredAt = (w: World, r: Waiter): number => marks(w, r.id, "acquired")[0]!.at as number;

describe("the lock queue: queued runs take the lock oldest request first", () => {
	test("T1: on a stale-holder takeover, younger waiters B and C wait for the oldest, A, while A is stopped; then A, B, C acquire in request order", async () => {
		const w = world();
		const { A, B, C } = requestsCBA(w);
		holdLock(w);
		const kids: Child[] = [];
		try {
			for (const r of [A, B, C]) kids.push(spawnRun(w, r.id));
			await until("A, B and C queued", () => [A, B, C].every((r) => queuedCount(w, r) >= 1));
			await stopOutsideTx(w, kids[0]!, A.id);
			runsDb(w, (db) => db.query("UPDATE lock SET heartbeatAt = ?").run(Date.now() - 61_000));
			const b0 = queuedCount(w, B);
			const c0 = queuedCount(w, C);
			await until("B and C three more attempts each, or one acquired",
				() => (queuedCount(w, B) >= b0 + 3 && queuedCount(w, C) >= c0 + 3) || marks(w, B.id, "acquired").length + marks(w, C.id, "acquired").length > 0, 20_000);
			expect({ B: marks(w, B.id, "acquired"), C: marks(w, C.id, "acquired") }).toEqual({ B: [], C: [] });
			expect(runsDb(w, (db) => lockRow(db)?.runId)).toBe("tr-otherholder");
			process.kill(kids[0]!.pid, "SIGCONT");
			for (const r of [A, B, C]) expect((await resultOf(w, r.wl, r.id)).verdict).toBe("stale");
			await Promise.all(kids.map((k) => k.exited));
			expect(marks(w, A.id, "acquired")).toEqual([expect.objectContaining({ displaced: "tr-otherholder" })]);
			expect(marks(w, B.id, "acquired")).toEqual([expect.objectContaining({ displaced: null })]);
			expect(marks(w, C.id, "acquired")).toEqual([expect.objectContaining({ displaced: null })]);
			expect(acquiredAt(w, A)).toBeLessThan(acquiredAt(w, B));
			expect(acquiredAt(w, B)).toBeLessThan(acquiredAt(w, C));
		} finally {
			await reap(kids);
		}
	});

	test("T2: dead waiters ahead (stale heartbeat, settled request, no request, no heartbeat past the startup lease) never block and are pruned", async () => {
		const w = world();
		holdLock(w);
		const kids: Child[] = [];
		try {
			// D and E queue for real, older than A, and are killed while queued.
			const D = waiter(w, 60_000);
			const E = waiter(w, 50_000);
			const cd = spawnRun(w, D.id);
			const ce = spawnRun(w, E.id);
			kids.push(cd, ce);
			await until("D and E queued", () => queuedCount(w, D) >= 1 && queuedCount(w, E) >= 1);
			expect(queueRows(w).map((q) => q.runId)).toEqual([D.id, E.id]);
			cd.kill("SIGKILL");
			ce.kill("SIGKILL");
			await Promise.all([cd.exited, ce.exited]);
			writeHeartbeat(w, D.id, Date.now() - 61_000);
			settleDead(w, E);
			// F: a row whose run the ledger has no request for. G: a request 200 s old that never beat.
			const F = newRunId();
			queueRow(w, F, workload(w).wl, Date.now() - 45_000);
			const G = waiter(w, 200_000);
			queueRow(w, G.id, G.wl, requestedAtOf(w, G));
			expect(queueRows(w).map((q) => q.runId)).toEqual([G.id, D.id, E.id, F]);
			const { A, B, C } = requestsCBA(w);
			for (const r of [A, B, C]) kids.push(spawnRun(w, r.id));
			await until("A, B and C queued", () => [A, B, C].every((r) => queuedCount(w, r) >= 1));
			// Pruning happens on every attempt, while another run holds the lock too.
			await until("D, E, F and G pruned", () => queueRows(w).every((q) => [A.id, B.id, C.id].includes(q.runId)), 20_000);
			expect(queueRows(w).map((q) => q.runId)).toEqual([A.id, B.id, C.id]);
			expect(queueRows(w).map((q) => q.requestedAt)).toEqual([A, B, C].map((r) => requestedAtOf(w, r)));
			runsDb(w, (db) => db.query("DELETE FROM lock").run());
			for (const r of [A, B, C]) expect((await resultOf(w, r.wl, r.id)).verdict).toBe("stale");
			await Promise.all(kids.map((k) => k.exited));
			for (const r of [A, B, C]) expect(marks(w, r.id, "acquired")).toEqual([expect.objectContaining({ displaced: null })]);
			expect(acquiredAt(w, A)).toBeLessThan(acquiredAt(w, B));
			expect(acquiredAt(w, B)).toBeLessThan(acquiredAt(w, C));
			expect(queueRows(w)).toEqual([]);
		} finally {
			await reap(kids);
		}
	});

	test("T2b: live waiters that are no process block: a fresh heartbeat on a 10-minute-old request, then no heartbeat inside the startup lease", async () => {
		const w = world();
		const kids: Child[] = [];
		try {
			const I = waiter(w, 600_000);
			writeHeartbeat(w, I.id, Date.now());
			queueRow(w, I.id, I.wl, requestedAtOf(w, I));
			const H = waiter(w, 5_000);
			queueRow(w, H.id, H.wl, requestedAtOf(w, H));
			const B = waiter(w, 2_000);
			const C = waiter(w, 1_000);
			for (const r of [B, C]) kids.push(spawnRun(w, r.id));
			await until("B and C three attempts each", () => queuedCount(w, B) >= 3 && queuedCount(w, C) >= 3, 20_000);
			expect({ B: marks(w, B.id, "acquired"), C: marks(w, C.id, "acquired") }).toEqual({ B: [], C: [] });
			expect(queueRows(w).map((q) => q.runId)).toEqual([I.id, H.id, B.id, C.id]);
			// I's heartbeat goes stale: I is pruned, and H, inside its startup lease, blocks.
			writeHeartbeat(w, I.id, Date.now() - 61_000);
			const b0 = queuedCount(w, B);
			const c0 = queuedCount(w, C);
			await until("I pruned and B and C three more attempts each",
				() => !queueRows(w).some((q) => q.runId === I.id) && queuedCount(w, B) >= b0 + 3 && queuedCount(w, C) >= c0 + 3, 20_000);
			expect({ B: marks(w, B.id, "acquired"), C: marks(w, C.id, "acquired") }).toEqual({ B: [], C: [] });
			expect(queueRows(w).map((q) => q.runId)).toEqual([H.id, B.id, C.id]);
			settleDead(w, H);
			for (const r of [B, C]) expect((await resultOf(w, r.wl, r.id)).verdict).toBe("stale");
			await Promise.all(kids.map((k) => k.exited));
			expect(acquiredAt(w, B)).toBeLessThan(acquiredAt(w, C));
			expect(queueRows(w)).toEqual([]);
		} finally {
			await reap(kids);
		}
	});

	test("T3: a waiter pruned while it was stopped re-joins with its original place when it resumes, and acquires before younger waiters", async () => {
		const w = world();
		const { A, B, C } = requestsCBA(w);
		holdLock(w);
		const kids: Child[] = [];
		try {
			for (const r of [A, B, C]) kids.push(spawnRun(w, r.id));
			await until("A, B and C queued", () => [A, B, C].every((r) => queuedCount(w, r) >= 1));
			const original = queueRows(w).find((q) => q.runId === A.id)!.requestedAt;
			expect(original).toBe(requestedAtOf(w, A));
			await stopOutsideTx(w, kids[0]!, A.id);
			writeHeartbeat(w, A.id, Date.now() - 61_000);
			await until("A's row pruned", () => !queueRows(w).some((q) => q.runId === A.id), 20_000);
			expect(runsDb(w, (db) => lockRow(db)?.runId)).toBe("tr-otherholder");
			process.kill(kids[0]!.pid, "SIGCONT");
			const back = () => queueRows(w).find((q) => q.runId === A.id)?.requestedAt === original && Date.now() - (heartbeatAt(w, A.id) ?? 0) < 5_000;
			await until("A back in the queue at its original place with a fresh heartbeat", back, 20_000);
			// Any attempt of B or C that read A's old heartbeat has ended once each has queued twice more.
			const b0 = queuedCount(w, B);
			const c0 = queuedCount(w, C);
			await until("B and C two more attempts each", () => queuedCount(w, B) >= b0 + 2 && queuedCount(w, C) >= c0 + 2, 20_000);
			expect(back()).toBe(true);
			runsDb(w, (db) => db.query("DELETE FROM lock").run());
			for (const r of [A, B, C]) expect((await resultOf(w, r.wl, r.id)).verdict).toBe("stale");
			await Promise.all(kids.map((k) => k.exited));
			expect(acquiredAt(w, A)).toBeLessThan(acquiredAt(w, B));
			expect(acquiredAt(w, B)).toBeLessThan(acquiredAt(w, C));
		} finally {
			await reap(kids);
		}
	});
});

describe("exclusive sweeps (§ 2.3 step 1, the order of a run)", () => {
	/**
	 * A's sweep holds the sweep lock, paused at `point`; A's row goes stale; B takes over, publishes and
	 * its sweep waits. The test sends `signal` to B's waiting sweep, standing in for A's `uid` sweep,
	 * which a `groups` render cannot reproduce. Then A resumes.
	 */
	async function race(point: "sweep-read1" | "sweep-read2", signal: "SIGTERM" | "SIGKILL") {
		const w = world();
		const a = workload(w);
		const b = workload(w);
		const A = request(w, a.wl, a.slice, PR.green, fx.head.green);
		const B = request(w, b.wl, b.slice, PR.green, fx.head.green);
		arm(w, A, point);
		const ca = spawnRun(w, A, { AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "600000" });
		await reached(w, A, point);
		staleRow(w);
		const cb = spawnRun(w, B);
		await until("B took over", () => marks(w, B, "acquired").length === 1);
		expect(current(w)).toBe(B);
		const first = (await until("B's first sweep", () => marks(w, B, "spawn-sweep")[0]))!.pid as number;
		process.kill(first, signal);
		await until("B's retried sweep", () => marks(w, B, "spawn-sweep").length >= 2);
		const resumedAt = Date.now();
		go(w, A, point);
		await Promise.all([ca.exited, cb.exited]);
		const ra = await resultOf(w, a.wl, A);
		const rb = await resultOf(w, b.wl, B);
		expect(ra.verdict).toBe("superseded");
		expect(w.ledger.slice(a.slice)!.state).toBe("open");
		// B retried its sweep once, got the lock only after A's sweep ended, and its preflight and parts ran unharmed after that.
		expect(marks(w, B, "sweep").map((m) => [m.after, m.attempt])).toEqual([["publish", 0], ["publish", 1], ["full", 0], ["./a.test.ts", 0]]);
		expect(runnerLog(w, B)).toContain(`ended by ${signal}; retry 1 of 3`);
		expect(marks(w, B, "spawn-probe")[0]!.at as number).toBeGreaterThan(resumedAt);
		expect(rb).toMatchObject({ verdict: "green" });
		expect(rb.full).toMatchObject({ pass: 2, fail: 0, error: null });
		return { w, A, B, ra };
	}

	test("(c) SIGTERM: A has read current = A; B publishes, its sweep waits and is signalled; A aborts before SIGKILL; B retries and runs unharmed", async () => {
		const { w, A } = await race("sweep-read1", "SIGTERM");
		// A's sweep read current again after its grace, found B, and aborted fenced before any SIGKILL.
		expect(runnerLog(w, A)).toContain(`sweep ${A} → exit ${WRAPPER_EXIT.fenced}`);
	});

	test("(d) SIGKILL: A paused between its second read and SIGKILL; B's sweep is killed while it waits; B retries and runs unharmed", async () => {
		const { w, A, ra } = await race("sweep-read2", "SIGKILL");
		// A's own sweep finished (its second read still saw A); the runner then found the row held by B.
		expect(runnerLog(w, A)).toContain(`sweep ${A} → exit 0`);
		expect(ra.reason).toContain("the lock row holds");
	});

	test("a sweep killed on every attempt spends its 3 retries and the run ends error", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const A = request(w, wl, slice, PR.green, fx.head.green);
		// The test holds the sweep lock, so every sweep of A waits on it until it is signalled.
		const holder = new Database(join(w.as2, "locks", "sweep.db"));
		holder.exec("PRAGMA journal_mode = MEMORY");
		holder.exec("BEGIN EXCLUSIVE");
		try {
			const ca = spawnRun(w, A);
			for (let i = 0; i < 4; i++) {
				const pid = (await until(`sweep attempt ${i + 1}`, () => marks(w, A, "spawn-sweep")[i]))!.pid as number;
				process.kill(pid, "SIGTERM");
			}
			await ca.exited;
			const run = await resultOf(w, wl, A);
			expect(run.verdict).toBe("error");
			expect(run.reason).toBe("the sweep after publish ended by SIGTERM 4 times; its 3 retries are spent");
			expect(marks(w, A, "spawn-probe")).toEqual([]);
			expect(w.ledger.slice(slice)!.state).toBe("open");
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
	});
});

describe("the runs lock under test (Guard A, MIGRATION.md item 114)", () => {
	test("a runs.db that is a symlink into a live ledger root is refused, and its target is left as it was", () => {
		const live = tmp("runner-live");
		const target = join(live, "ledger.db");
		const db = new Database(target, { create: true });
		db.exec("CREATE TABLE t (x)");
		db.close();
		const bytes = readFileSync(target);
		const root = tmp("runner-runs");
		roots.push(live, root);
		symlinkSync(target, join(root, "runs.db"));
		const was = process.env.AS2_TEST_LIVE_ROOTS;
		process.env.AS2_TEST_LIVE_ROOTS = live;
		try {
			expect(() => openLockDb(root, 0)).toThrow(LiveLedgerUnderTestError);
		} finally {
			if (was === undefined) delete process.env.AS2_TEST_LIVE_ROOTS;
			else process.env.AS2_TEST_LIVE_ROOTS = was;
		}
		expect(readFileSync(target).equals(bytes)).toBe(true);
	});
});

// A subprocess can be gone while its inherited stdout is still open in a descendant.
// The helper exits naturally; no signal or live database is used by this reproduction.
test("command completion does not wait for an exited child's inherited pipes", async () => {
	const root = realpathSync(tmp("runner-pipe"));
	roots.push(root);
	const helper = join(root, "holder.ts");
	writeFileSync(helper, 'await Bun.sleep(1500);');
	const started = Date.now();
	const result = await run([process.execPath, "-e", `Bun.spawn([process.execPath, ${JSON.stringify(helper)}], {stdout: "inherit", stderr: "inherit", stdin: "ignore"}).unref(); console.log("done");`], {
		cwd: root, env: GIT_ENV, timeoutMs: 200,
	});
	expect(result).toMatchObject({ code: 0, out: "done\n", err: "" });
	expect(Date.now() - started).toBeLessThan(1000);
	// Let the finite helper finish before afterAll removes its directory.
	await Bun.sleep(1600);
});

for (const point of ["head-recheck", "result"]) {
	test(`post-sweep guard records error and releases the lock when ${point} never resumes`, async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		arm(w, runId, point);
		const child = spawnRun(w, runId, { AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS: "300" });
		try {
			await reached(w, runId, point);
			const run = await resultOf(w, wl, runId, 2500);
			expect(run.verdict).toBe("error");
			expect(run.reason).toContain("post-sweep deadline exceeded");
			await until("guarded runner exits", () => child.exitCode !== null, 2500);
			expect(child.exitCode).toBe(0);
			expect(JSON.parse(readFileSync(join(w.runs, runId, "result.json"), "utf8"))).toMatchObject({ verdict: "error" });
			expect(w.ledger.slice(slice)!.state).toBe("open");
			const db = lockDbOf(w);
			try { expect(lockRow(db)).toBeNull(); } finally { db.close(); }
			// Resuming an expired hook must never publish a late green result.
			go(w, runId, point);
			expect(testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)!.results).toHaveLength(1);
		} finally {
			go(w, runId, point);
			await child.exited;
		}
	});
}

test("publication contention leaves a local error verdict and releases the run lock", async () => {
	const w = world();
	const { wl, slice } = workload(w);
	const runId = request(w, wl, slice, PR.green, fx.head.green);
	arm(w, runId, "result");
	const child = spawnRun(w, runId, { AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS: "2000" });
	await reached(w, runId, "result");
	const deadline = Date.parse(/post-sweep finalization started; deadline (.+)/.exec(runnerLog(w, runId))![1]!);
	w.ledger.db.exec("BEGIN IMMEDIATE");
	try {
		// The runner is another process, so spend its real clock budget at the hook;
		// publication must inherit the remainder rather than start a fresh timeout.
		await until("most of the shared finalization budget is spent", () => Date.now() >= deadline - 500, 2000);
		const resumedAt = Date.now();
		go(w, runId, "result");
		await until("publication fails within the post-sweep deadline", () => child.exitCode !== null, 3000);
		const exitedAt = Date.now();
		expect(exitedAt).toBeGreaterThanOrEqual(deadline);
		expect(exitedAt).toBeLessThan(deadline + 1000);
		console.info(`publication under held ledger: exited ${exitedAt - resumedAt} ms after resume, ${exitedAt - deadline} ms after the shared deadline`);
		expect(child.exitCode).toBe(START_EXIT.failed);
		const result = JSON.parse(readFileSync(join(w.runs, runId, "result.json"), "utf8"));
		expect(result.verdict).toBe("error");
		expect(result.reason).toContain("result publication failed:");
		expect(result.reason).toContain("post-sweep deadline exceeded during publication");
		const db = lockDbOf(w);
		try { expect(lockRow(db)).toBeNull(); } finally { db.close(); }
	} finally {
		w.ledger.db.exec("ROLLBACK");
		go(w, runId, "result");
		await child.exited;
	}
	expect(testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)!.results).toHaveLength(0);
	expect(w.ledger.slice(slice)!.state).toBe("open");
});

test("publication retries a transient ledger lock within the post-sweep deadline and settles atomically", async () => {
	const w = world();
	const { wl, slice } = workload(w);
	const runId = request(w, wl, slice, PR.green, fx.head.green);
	arm(w, runId, "result");
	const child = spawnRun(w, runId, { AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS: "2000" });
	try {
		await reached(w, runId, "result");
		w.ledger.db.exec("BEGIN IMMEDIATE");
		try {
			go(w, runId, "result");
			await until("publication attempts the held ledger", () => marks(w, runId, "publication-busy").length > 0);
			expect(child.exitCode).toBeNull();
			expect(existsSync(join(w.runs, runId, "result.json"))).toBe(false);
		} finally {
			w.ledger.db.exec("ROLLBACK");
			go(w, runId, "result");
		}
		await until("publication succeeds after the ledger lock clears", () => child.exitCode !== null, 3000);
		expect(child.exitCode).toBe(0);
		const results = testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)!.results;
		expect(results).toHaveLength(1);
		expect(results[0]!.verdict).toBe("green");
		expect(w.ledger.slice(slice)!.state).toBe("done");
		expect(JSON.parse(readFileSync(join(w.runs, runId, "result.json"), "utf8"))).toMatchObject({ verdict: "green" });
		const db = lockDbOf(w);
		try { expect(lockRow(db)).toBeNull(); } finally { db.close(); }
	} finally {
		go(w, runId, "result");
		await child.exited;
	}
});
