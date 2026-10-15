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
// The doc-only main-merge facts (plan wl-mv615mkeaf1yio § 3) are read in process from real merges.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger, LiveLedgerUnderTestError, TEST_RUNNER_BY } from "../../ledger/src/index";
import { renderExecWrapper } from "../src/as2test";
import { recordRepo } from "../src/decision-log";
import {
	childLayout, docMergeDecision, makeRunId, parseHeartbeat, parseTestRun, partResult, pushDestBody, type PrView, runnerDiedRun, type RunRecord, type TestRun, testRequestedBody, testRunBody,
	testRuns, workDirOf, WRAPPER_EXIT, type WrapperCall, wrapperArgv,
} from "../src/test-run";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { admit, buildBatch, type Claimant, gatherMergeFacts, importPart, importReport, lockRow, openLockDb, publishIfOwner, publishSub, queueRows, requestBatch, START_EXIT, tryAcquire, verifyBundleSteps, withdraw } from "../scripts/test-runner";
import { requestTestBatch } from "../src/input";
import {
	batchAdmissible, batchAttribution, batchAttributions, batchCredits, batchRequests, batchRunnerDiedRun, batchRuns, batchSettleArtifact, batchSlice, newestBatchAttribution, readRunsSnapshot,
	type TestBatchAttribution, testBatchAttributionBody, testBatchRequestedBody, type TestBatchRun, testBatchRunBody,
} from "../src/test-batch";
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

const PR = { green: 1, red: 2, solo: 3, env: 4, hang: 5, exit: 6, space: 7, green2: 8 } as const;
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
	// A second green PR for the batch run (plan wl-mv615mkeaf1yio § 4): another file than PR #1's, so the two merge cleanly.
	green2: { "b.test.ts": PASS("b") },
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
		for (const [f, text] of Object.entries(PR_FILES[name])) writeFileSync(join(work, f), text);
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

const GH = `#!/bin/sh
dir="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\\n' "$*" >> "$dir/gh.log"
if [ "$1 $2" = "pr view" ] && [ -f "$dir/prs/$3.json" ]; then cat "$dir/prs/$3.json"; exit 0; fi
echo "no pull requests found" >&2
exit 1
`;
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

function world(o: { capMin?: number; queueMaxMin?: number; killGraceMs?: number; sweepLockWaitMs?: number } = {}): World {
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
	writeFileSync(config, `testRunner:\n  repos:\n    - origin: ${OWNER_REPO}\n      command: bun test\n  fullCapMin: ${cap}\n  soloCapMin: ${cap}\n  reportCapMb: 5\n  queueMaxMin: ${o.queueMaxMin ?? 60}\n`);

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
function setPr(w: World, n: number, o: { sha: string; headRefName: string; state?: string; isCrossRepository?: boolean }): void {
	writeFileSync(join(w.root, "prs", `${n}.json`), JSON.stringify({
		number: n, state: o.state ?? "OPEN", headRefOid: o.sha, headRefName: o.headRefName, baseRefName: "main", isCrossRepository: o.isCrossRepository ?? false,
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
 * `<run dir>/result.json` as a FIFO: the runner's write of it blocks, after its `test-run:`
 * transaction has committed, until the returned function reads it.
 */
function holdResultJson(w: World, runId: string): () => Promise<string> {
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
/** The world's runs.db for the queue tests: reads and writes wait out a runner's short transaction (2 s busy wait). */
const queueDbOf = (w: World): Database => openLockDb(w.runs, 2_000);
/** What the starter does, without its gh call or its spawn: the admission commits, then the `test-requested:`. Returns the run id. */
function admitted(w: World, wl: string, slice: string, pr: number, sha: string, runId = newRunId()): string {
	const db = queueDbOf(w);
	try {
		admit(db, runId);
	} finally {
		db.close();
	}
	w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice, by: LANE }) });
	return runId;
}
/** The run ids admitted to the world's queue, in request order. */
function queued(w: World): string[] {
	const db = queueDbOf(w);
	try {
		return queueRows(db).map((r) => r.runId);
	} finally {
		db.close();
	}
}
/** Another run holds the lock with a heartbeat ten minutes ahead: fresh for the whole test, with no timer to keep it so. */
function holdLock(db: Database): void {
	db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-otherholder', 1, 1, '/nowhere', ?)").run(Date.now() + 600_000);
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

		const calls = readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n");
		expect(calls).toHaveLength(4);
		for (const c of calls) expect(c).toBe(`pr view ${PR.green} -R ${OWNER_REPO} --json number,state,headRefOid,headRefName,baseRefName,isCrossRepository`);
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

	test("a run that waits past queueMaxMin ends at the backstop, without touching the holder's lock or current; with no PR to read, its re-request is refused", async () => {
		const w = world({ queueMaxMin: 0.01 });
		const { wl, slice } = workload(w);
		const db = lockDbOf(w);
		db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-otherholder', 1, 1, '/nowhere', ?)").run(Date.now() + 600_000);
		try {
			const runId = request(w, wl, slice, PR.green, fx.head.green);
			await spawnRun(w, runId).exited;
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "error", full: null });
			expect(run.reason).toStartWith(`queued past the 0.01 min backstop; re-request refused: gh pr view ${PR.green} -R ${OWNER_REPO} failed: no pull requests found`);
			expect(testRuns(w.ledger.entries(wl))).toHaveLength(1);
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

	// result.json is written after the `test-run:` transaction: held there, the run has decided and
	// committed, and whatever lands now is the gap an after-the-fact settle would have raced.
	test("the settle commits with the test-run: entry: a successor request landing once the entry is visible finds the slice done, and the old green writes nothing after it", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		const release = holdResultJson(w, runId);
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
		const release = holdResultJson(w, runId);
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

// ---- the lock in request order (plan wl-mv615mkeaf1yio § 2) ------------------------------------------------

describe("the lock queue in process: admission order decides, never run ids or who polls first", () => {
	/** A runs root and a stage dir of their own; nothing is spawned. */
	function queueDb(): { db: Database; stage: string; runs: string } {
		const root = realpathSync(tmp("trun-queue"));
		roots.push(root);
		const stage = join(root, "stage");
		mkdirSync(stage);
		const runs = join(root, "runs");
		return { db: openLockDb(runs, 0), stage, runs };
	}
	const as = (runId: string): Claimant => ({ runId, pid: 1, runDir: `/nowhere/${runId}` });
	const ids = (db: Database) => queueRows(db).map((r) => r.runId);
	const T0 = Date.now();

	test("runs.db carries the queue, created idempotently; admissions get rising seqs in commit order; withdraw removes only its own row", () => {
		const { db, runs } = queueDb();
		const late = makeRunId(T0, "zzzz");
		const early = makeRunId(T0 - 60_000, "0000");
		const first = admit(db, late, T0);
		const second = admit(db, early, T0 + 1);
		expect(second).toBeGreaterThan(first);
		expect(() => admit(db, late, T0 + 2)).toThrow();
		db.close();
		const again = openLockDb(runs, 0);
		try {
			expect(queueRows(again)).toEqual([{ seq: first, runId: late, admittedAt: T0 }, { seq: second, runId: early, admittedAt: T0 + 1 }]);
			withdraw(again, late);
			withdraw(again, "tr-neveradmitted");
			expect(ids(again)).toEqual([early]);
		} finally {
			again.close();
		}
	});

	test("delayed start: A admitted first whose runner has not beaten yet keeps B off a free lock; A takes it and leaves the queue in the same transaction; then B", () => {
		const { db, stage } = queueDb();
		const A = makeRunId(T0, "aaaa");
		const B = makeRunId(T0, "bbbb");
		admit(db, A, T0);
		admit(db, B, T0 + 1_000);
		const beats = new Map<string, number>([[B, T0 + 1_500]]);
		const hb = (id: string) => beats.get(id) ?? null;
		expect(tryAcquire(db, stage, as(B), hb, T0 + 2_000)).toBeNull();
		expect(lockRow(db)).toBeNull();
		expect(existsSync(join(stage, "current"))).toBe(false);
		expect(ids(db)).toEqual([A, B]);
		beats.set(A, T0 + 3_000);
		expect(tryAcquire(db, stage, as(A), hb, T0 + 3_000)).toEqual({ displaced: null });
		expect(lockRow(db)!.runId).toBe(A);
		expect(readFileSync(join(stage, "current"), "utf8")).toBe(`${A}\n`);
		expect(ids(db)).toEqual([B]);
		expect(tryAcquire(db, stage, as(B), hb, T0 + 4_000)).toBeNull();
		db.query("DELETE FROM lock").run();
		expect(tryAcquire(db, stage, as(B), hb, T0 + 5_000)).toEqual({ displaced: null });
		expect(lockRow(db)!.runId).toBe(B);
		expect(ids(db)).toEqual([]);
	});

	test("ids sorting the other way: three waiters behind a holder are granted in admission order, whoever polls first", () => {
		const { db, stage } = queueDb();
		const X = makeRunId(T0, "zzzz");
		const Y = makeRunId(T0 - 120_000, "0000");
		const Z = makeRunId(T0 - 60_000, "mmmm");
		expect([Y, Z, X]).toEqual([X, Y, Z].sort());
		for (const [i, id] of [X, Y, Z].entries()) admit(db, id, T0 + i);
		holdLock(db);
		const hb = () => T0 + 10_000;
		const order: string[] = [];
		for (let round = 0; round < 3; round++) {
			db.query("DELETE FROM lock").run();
			for (const id of [Z, Y, X]) {
				if (order.includes(id)) continue;
				const took = tryAcquire(db, stage, as(id), hb, T0 + 10_000 + round);
				if (took) order.push(id);
			}
		}
		expect(order).toEqual([X, Y, Z]);
		expect(ids(db)).toEqual([]);
	});

	test("dead admissions ahead (a stale heartbeat, or none past the 120 s lease) are skipped and deleted, also by a waiter that cannot take the lock yet", () => {
		const { db, stage } = queueDb();
		const silent = makeRunId(T0, "dea1");
		const stale = makeRunId(T0, "dea2");
		const W = makeRunId(T0, "wait");
		admit(db, silent, T0 - 200_000);
		admit(db, stale, T0 - 200_000);
		admit(db, W, T0 - 1_000);
		const beats: Record<string, number> = { [stale]: T0 - 61_000 };
		holdLock(db);
		expect(tryAcquire(db, stage, as(W), (id) => beats[id] ?? null, T0)).toBeNull();
		expect(ids(db)).toEqual([W]);
		db.query("DELETE FROM lock").run();
		expect(tryAcquire(db, stage, as(W), (id) => beats[id] ?? null, T0 + 1)).toEqual({ displaced: null });
		expect(ids(db)).toEqual([]);
	});

	test("a stale holder is taken over by the queue head only; the takeover removes the head's admission with the row it installs", () => {
		const { db, stage } = queueDb();
		db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-staleholder', 1, 1, '/nowhere', ?)").run(T0 - 120_000);
		const A = makeRunId(T0, "aaaa");
		const B = makeRunId(T0, "bbbb");
		admit(db, A, T0 - 2_000);
		admit(db, B, T0 - 1_000);
		const hb = () => T0;
		expect(tryAcquire(db, stage, as(B), hb, T0)).toBeNull();
		expect(lockRow(db)!.runId).toBe("tr-staleholder");
		expect(tryAcquire(db, stage, as(A), hb, T0)).toEqual({ displaced: "tr-staleholder" });
		expect(lockRow(db)!.runId).toBe(A);
		expect(ids(db)).toEqual([B]);
		expect(readFileSync(join(stage, "current"), "utf8")).toBe(`${A}\n`);
	});

	test("a waiter with no admission (its starter predates the queue, or its row was deleted as dead) is admitted at its first poll, at the tail", () => {
		const { db, stage } = queueDb();
		const A = makeRunId(T0, "aaaa");
		const N = makeRunId(T0 - 60_000, "0000");
		admit(db, A, T0);
		expect(tryAcquire(db, stage, as(N), () => null, T0 + 1_000)).toBeNull();
		expect(queueRows(db).map((r) => [r.runId, r.admittedAt])).toEqual([[A, T0], [N, T0 + 1_000]]);
		// A's runner never beats: past its 120 s lease it is dead, and N leads.
		expect(tryAcquire(db, stage, as(N), () => null, T0 + 121_000)).toEqual({ displaced: null });
		expect(ids(db)).toEqual([]);
	});
});

describe("the lock queue end to end (plan wl-mv615mkeaf1yio § 2)", () => {
	test("start admits the run before it writes test-requested:; a refused start removes the admission it made", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}` });
		const db = queueDbOf(w);
		holdLock(db);
		try {
			const r = start(w, wl, PR.green, ["--slice", slice]);
			expect(r.code).toBe(START_EXIT.ok);
			const runId = /^test-run (tr-[a-z0-9]+) /.exec(r.out)![1]!;
			const rows = queueRows(db);
			expect(rows.map((x) => x.runId)).toEqual([runId]);
			const requestedAt = Date.parse(testRuns(w.ledger.entries(wl)).find((x) => x.request.runId === runId)!.request.createdAt);
			expect(rows[0]!.admittedAt).toBeLessThanOrEqual(requestedAt);
			// The second start is refused (the first run is live): it was admitted, seq 2, and took its admission back.
			const refused = start(w, wl, PR.green, ["--slice", slice]);
			expect(refused.code).toBe(START_EXIT.refused);
			expect(queueRows(db).map((x) => x.runId)).toEqual([runId]);
			expect(db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'queue'").get()!.seq).toBe(2);
			db.query("DELETE FROM lock").run();
			expect((await resultOf(w, wl, runId)).verdict).toBe("green");
			await until("the run released the lock", () => lockRow(db) === null);
			expect(queued(w)).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("(a) delayed start: A is admitted first but paused before acquire; B, admitted later, never takes the free lock while A is live; A goes first, then B", async () => {
		const w = world();
		const a = workload(w);
		const b = workload(w);
		// Both ask for a sha the PR does not have: once a run holds the lock it ends at once as stale.
		const A = admitted(w, a.wl, a.slice, PR.green, fx.main);
		arm(w, A, "before-acquire");
		const ca = spawnRun(w, A);
		await reached(w, A, "before-acquire");
		const B = admitted(w, b.wl, b.slice, PR.green, fx.main);
		const cb = spawnRun(w, B);
		await until("B polled three times behind A", () => marks(w, B, "queued").length >= 3);
		expect(marks(w, B, "acquired")).toEqual([]);
		const db = queueDbOf(w);
		try {
			expect(lockRow(db)).toBeNull();
		} finally {
			db.close();
		}
		expect(queued(w)).toEqual([A, B]);
		go(w, A, "before-acquire");
		await Promise.all([ca.exited, cb.exited]);
		expect((await resultOf(w, a.wl, A)).verdict).toBe("stale");
		expect((await resultOf(w, b.wl, B)).verdict).toBe("stale");
		expect(marks(w, B, "acquired")[0]!.at as number).toBeGreaterThanOrEqual(marks(w, A, "result")[0]!.at as number);
		expect(queued(w)).toEqual([]);
	});

	test("(b) ids sorting the other way: the earlier admission takes the freed lock although the later one, with the smaller id, polls every 200 ms", async () => {
		const w = world();
		const a = workload(w);
		const b = workload(w);
		const db = queueDbOf(w);
		holdLock(db);
		try {
			const first = admitted(w, a.wl, a.slice, PR.green, fx.main, makeRunId(Date.now(), "zzzz"));
			const second = admitted(w, b.wl, b.slice, PR.green, fx.main, makeRunId(Date.now() - 60_000, "0000"));
			expect(second < first).toBe(true);
			const cf = spawnRun(w, first, { AGENT_SYSTEM_TEST_RUNNER_POLL_MS: "10000" });
			const cs = spawnRun(w, second);
			await until("second queued", () => marks(w, second, "queued").length >= 1);
			// Free the lock just after first's poll: first sleeps 10 s, second polls within 200 ms.
			const n = marks(w, first, "queued").length;
			await until("first's next poll", () => marks(w, first, "queued").length > n, 60_000);
			db.query("DELETE FROM lock").run();
			await Promise.all([cf.exited, cs.exited]);
			expect((await resultOf(w, a.wl, first)).verdict).toBe("stale");
			expect((await resultOf(w, b.wl, second)).verdict).toBe("stale");
			expect(marks(w, second, "acquired")[0]!.at as number).toBeGreaterThanOrEqual(marks(w, first, "result")[0]!.at as number);
			expect(queued(w)).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("(c) three waiters queued behind a holder are granted in admission order, the fastest pollers admitted last", async () => {
		const w = world();
		const ws = [workload(w), workload(w), workload(w)];
		const db = queueDbOf(w);
		holdLock(db);
		try {
			const ids = ws.map((x) => admitted(w, x.wl, x.slice, PR.green, fx.main));
			const polls = ["10000", "1000", "200"];
			const children = ids.map((id, i) => spawnRun(w, id, { AGENT_SYSTEM_TEST_RUNNER_POLL_MS: polls[i]! }));
			await until("all three queued", () => ids.every((id) => marks(w, id, "queued").length >= 1));
			const n = marks(w, ids[0]!, "queued").length;
			await until("the first admission's next poll", () => marks(w, ids[0]!, "queued").length > n, 60_000);
			db.query("DELETE FROM lock").run();
			await Promise.all(children.map((c) => c.exited));
			const at = ids.map((id) => marks(w, id, "acquired")[0]!.at as number);
			expect(at[0]!).toBeLessThan(at[1]!);
			expect(at[1]!).toBeLessThan(at[2]!);
			expect(queued(w)).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("every exit leaves the queue: the backstop, an error before acquisition, no profile to run under", async () => {
		const w = world({ queueMaxMin: 0.01 });
		const db = queueDbOf(w);
		holdLock(db);
		try {
			const q = workload(w);
			// No PR for the fake gh to show: the backstop's re-request is refused, so nothing else joins the queue.
			const tooLong = admitted(w, q.wl, q.slice, PR.green, fx.head.green);
			await spawnRun(w, tooLong).exited;
			const backstopped = await resultOf(w, q.wl, tooLong);
			expect(backstopped.verdict).toBe("error");
			expect(backstopped.reason).toStartWith("queued past the 0.01 min backstop; re-request refused: ");
			expect(queued(w)).toEqual([]);

			// A workload with no repo: entry fails in the body before acquire.
			const bare = w.ledger.openWorkload({ by: SURFACE_BY, brief: "no repo", stakes: "normal", mode: "autonomous" });
			const bareSlice = w.ledger.addSlice({ by: LANE, workloadId: bare, task: "full suite", doneCondition: "a green test-run", inputs: "the PR" });
			const early = admitted(w, bare, bareSlice, PR.green, fx.head.green);
			await spawnRun(w, early).exited;
			expect(await resultOf(w, bare, early)).toMatchObject({ verdict: "error", reason: `${bare} has no repo: entry` });
			expect(queued(w)).toEqual([]);

			// No profile: the run records its error before a Runner exists.
			const c = workload(w);
			const noProfile = admitted(w, c.wl, c.slice, PR.green, fx.head.green);
			await spawnRun(w, noProfile, { AGENT_SYSTEM_TEST_RUNNER_CONFIG: join(w.root, "missing.yml") }).exited;
			expect((await resultOf(w, c.wl, noProfile)).reason).toContain("could not be read");
			expect(queued(w)).toEqual([]);
			expect(lockRow(db)!.runId).toBe("tr-otherholder");
		} finally {
			db.close();
		}
	});

	test("a queued run whose request was superseded withdraws at its next poll: superseded, its admission removed, the holder untouched", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const db = queueDbOf(w);
		holdLock(db);
		const runId = admitted(w, wl, slice, PR.green, fx.head.green);
		const child = spawnRun(w, runId);
		try {
			await until("queued", () => marks(w, runId, "queued").length >= 1);
			// What a later starter writes for a runner whose heartbeat went stale: `runner died`, then its own request.
			w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRunBody(runnerDiedRun({ runId, pr: PR.green, sha: fx.head.green, slice, by: LANE })) });
			request(w, wl, slice, PR.green, fx.head.green);
			const rec = await until("the withdrawal", () => {
				const r = testRuns(w.ledger.entries(wl)).find((x) => x.request.runId === runId);
				return r && r.results.length >= 2 ? r : null;
			}, 60_000);
			expect(rec.results.map((r) => r.verdict)).toEqual(["error", "superseded"]);
			expect(rec.results[1]!.reason).toContain("the request was superseded while the run was queued");
			await child.exited;
			expect(queued(w)).toEqual([]);
			expect(lockRow(db)!.runId).toBe("tr-otherholder");
			expect(marks(w, runId, "acquired")).toEqual([]);
		} finally {
			child.kill();
			db.close();
		}
	});

	// Jo's queue drop rule (in-mv9340e04pgbnk): past the backstop the runner re-requests at once, at the queue tail.
	test("a run past the backstop is re-requested by the runner: its error names the new run, which has the same PR, slice and requester and is admitted at the tail after the result; no message", async () => {
		const w = world({ queueMaxMin: 0.01 });
		const { wl, slice } = workload(w);
		// The PR as gh shows it at the backstop: open, bound, its head at main, so the re-request ends at once as stale once it runs.
		setPr(w, PR.green, { sha: fx.main, headRefName: `wl/${wl}` });
		const db = queueDbOf(w);
		holdLock(db);
		const first = admitted(w, wl, slice, PR.green, fx.head.green);
		// result.json blocks the first run after its result and the re-request commit, before it hands the queue on.
		const release = holdResultJson(w, first);
		const child = spawnRun(w, first);
		try {
			const run = await resultOf(w, wl, first);
			expect(run).toMatchObject({ verdict: "error", full: null });
			const again = /^queued past the 0\.01 min backstop; re-requested as (tr-[a-z0-9]+)$/.exec(run.reason ?? "")?.[1];
			if (!again) throw new Error(`the backstop's reason names no re-request: ${run.reason}`);
			const next = testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === again)!;
			expect(next.request).toMatchObject({ pr: PR.green, sha: fx.main, slice, by: LANE });
			expect(next.results).toEqual([]);
			// Written, not yet handed on: the first run still holds its admission and the new run has none.
			expect(queued(w)).toEqual([first]);
			// The new run waits at the default backstop, so it is still queued when the test looks.
			writeFileSync(join(w.root, "config.yml"), `testRunner:\n  repos:\n    - origin: ${OWNER_REPO}\n      command: bun test\n  fullCapMin: 2\n  soloCapMin: 2\n  reportCapMb: 5\n`);
			expect(JSON.parse(await release())).toMatchObject({ runId: first, verdict: "error", reason: run.reason });
			await child.exited;
			await until("the re-request queued behind the holder", () => marks(w, again, "queued").length >= 1);
			expect(queued(w)).toEqual([again]);
			expect(runnerLog(w, first)).toContain(`re-requested as ${again}: runner `);
			// A re-requested run has nothing for the orchestrator to act on.
			expect(heldMessages(w, wl)).toEqual([]);
			expect(readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n")).toHaveLength(1);
			db.query("DELETE FROM lock").run();
			expect((await resultOf(w, wl, again)).verdict).toBe("stale");
			expect(w.ledger.slice(slice)!.state).toBe("open");
			await until("the queue empty", () => queued(w).length === 0);
		} finally {
			child.kill();
			db.close();
		}
	});

	test("a queued run whose PR reads MERGED ends superseded at its next PR check: nothing settled, no message, not re-requested", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}` });
		const db = queueDbOf(w);
		holdLock(db);
		const runId = admitted(w, wl, slice, PR.green, fx.head.green);
		const child = spawnRun(w, runId, { AGENT_SYSTEM_TEST_RUNNER_PR_CHECK_MS: "300" });
		try {
			await until("an OPEN read while queued", () => marks(w, runId, "pr-state").some((m) => m.state === "OPEN"));
			setPr(w, PR.green, { sha: fx.head.green, headRefName: `wl/${wl}`, state: "MERGED" });
			const run = await resultOf(w, wl, runId);
			expect(run.verdict).toBe("superseded");
			expect(run.reason).toStartWith(`PR #${PR.green} is MERGED`);
			await child.exited;
			expect(testRuns(w.ledger.entries(wl)).map((r) => r.request.runId)).toEqual([runId]);
			expect(w.ledger.slice(slice)!.state).toBe("open");
			expect(heldMessages(w, wl)).toEqual([]);
			expect(queued(w)).toEqual([]);
			expect(lockRow(db)!.runId).toBe("tr-otherholder");
			expect(marks(w, runId, "acquired")).toEqual([]);
		} finally {
			child.kill();
			db.close();
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

// ---- the batch run (plan wl-mv615mkeaf1yio § 4) ----------------------------------------------------------

describe("the batch run end to end (plan wl-mv615mkeaf1yio § 4)", () => {
	/**
	 * PR `pr` on a workload of its own (head branch `wl/<id>`, as the fake gh answers), with the
	 * runner's full green there as the runner writes it, ran at `ranAt` (the pinned head unless
	 * given). The starter's admission reads only these rows. Returns the own workload.
	 */
	function ownGreen(w: World, pr: number, head: string, ranAt = head): string {
		const own = w.ledger.openWorkload({ by: SURFACE_BY, brief: `PR #${pr}'s own work`, stakes: "normal", mode: "autonomous" });
		setPr(w, pr, { sha: head, headRefName: `wl/${own}` });
		const request = { runId: newRunId(), pr, sha: ranAt, slice: "sl-full-own-1", by: LANE };
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: own, kind: "assumption", body: testRequestedBody(request) });
		w.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: own, kind: "assumption",
			body: testRunBody({
				...runnerDiedRun(request, `/runs/${request.runId}`), verdict: "green", reason: null, headAtEnd: ranAt,
				full: { pass: 2, fail: 0, skip: 0, exit: 0, ms: 900, error: null }, preflight: "ok",
			}),
		});
		return own;
	}

	/** Jo's word at the surface (her instruction and the `test-batch:` entry naming it, in one transaction), then the starter as the surface execs it. */
	function startBatch(w: World, wl: string, prs: number[], env: Record<string, string> = {}) {
		const { instructionId } = requestTestBatch(w.ledger, { kind: "test-batch", workloadId: wl, prs });
		const r = Bun.spawnSync([process.execPath, RUNNER, "start-batch", wl, instructionId], { env: { ...w.env, ...env }, stdout: "pipe", stderr: "pipe" });
		const out = r.stdout.toString().trim();
		const m = /^test-batch (tr-[a-z0-9]+) runner (\d+) prs (\S+) slice (sl-batch-\S+) log (\S+)$/.exec(out);
		return {
			instructionId, code: r.exitCode, out, err: r.stderr.toString().trim(),
			runId: m?.[1] ?? null, pid: m ? Number(m[2]) : null, prs: m?.[3] ?? null, slice: m?.[4] ?? null, log: m?.[5] ?? null,
		};
	}

	/** The batch's own `test-batch-run:`, once written. */
	async function batchResultOf(w: World, wl: string, runId: string, timeoutMs = 150_000): Promise<TestBatchRun & { entryId: string }> {
		try {
			return await until(`the test-batch-run: of ${runId}`, () => batchRuns(w.ledger.entries(wl)).find((r) => r.runId === runId), timeoutMs);
		} catch (e) {
			throw new Error(`${(e as Error).message}\n--- runner.log ---\n${runnerLog(w, runId)}`);
		}
	}

	/** The attribution's `test-batch-attribution:`, once written. */
	async function attributionOf(w: World, wl: string, id: string, timeoutMs = 240_000): Promise<TestBatchAttribution> {
		try {
			return await until(`the test-batch-attribution: of ${id}`, () => batchAttributions(w.ledger.entries(wl)).find((a) => a.runId === id), timeoutMs);
		} catch (e) {
			throw new Error(`${(e as Error).message}\n--- runner.log ---\n${runnerLog(w, id)}`);
		}
	}

	/** An earlier batch of PRs #1 and #8 on `wl`: its slice and its `test-batch-requested:`, `agoMs` in the past. */
	function earlierBatch(w: World, wl: string, agoMs: number): { runId: string; slice: string; prs: { pr: number; sha: string }[] } {
		const prs = [{ pr: PR.green, sha: fx.head.green }, { pr: PR.green2, sha: fx.head.green2 }];
		const runId = newRunId();
		const f = batchSlice(wl, prs.map((p) => p.pr), w.ledger.slices(wl).map((s) => s.id));
		const slice = w.ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: wl, id: f.id, task: f.task, doneCondition: f.doneCondition, inputs: "an earlier batch" });
		w.ago(agoMs, () => w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testBatchRequestedBody({ runId, prs, slice, by: "jo" }) }));
		return { runId, slice, prs };
	}

	test("green: start-batch pins two PRs with full greens on their own workloads; their merges onto origin/main test green; test-batch-run: green settles the batch slice, each PR's own workload gets its test-batch-credit:, the orchestrator its line", async () => {
		const w = world();
		const { wl } = workload(w);
		const own1 = ownGreen(w, PR.green, fx.head.green);
		const own8 = ownGreen(w, PR.green2, fx.head.green2);
		const r = startBatch(w, wl, [PR.green, PR.green2]);
		expect([r.code, r.err]).toEqual([START_EXIT.ok, ""]);
		expect(r.runId).not.toBeNull();
		const runId = r.runId!;
		const slice = r.slice!;
		expect(slice).toBe(batchSlice(wl, [PR.green, PR.green2], []).id);
		expect(r.prs).toBe(`#${PR.green}@${fx.head.green.slice(0, 7)},#${PR.green2}@${fx.head.green2.slice(0, 7)}`);
		expect(r.log).toBe(join(w.runs, runId, "runner.log"));
		expect(w.ledger.slice(slice)).toMatchObject({ state: "open", created_by: TEST_RUNNER_BY });

		const run = await batchResultOf(w, wl, runId);
		expect(run).toMatchObject({
			verdict: "green", reason: null, base: fx.main, attribution: null, runDir: join(w.runs, runId), failures: [],
			prs: [{ pr: PR.green, sha: fx.head.green }, { pr: PR.green2, sha: fx.head.green2 }], headsAtEnd: [fx.head.green, fx.head.green2],
		});
		// xa.test.ts (main), a.test.ts (#1) and b.test.ts (#8): one full suite, at the last merge step
		expect(run.full).toMatchObject({ pass: 3, fail: 0, exit: 0, error: null });
		expect(run.steps).toHaveLength(3);
		expect(run.steps[0]!.commit).toBe(fx.main);
		await until("the batch slice settled", () => w.ledger.slice(slice)?.state === "done");
		expect(w.ledger.slice(slice)).toMatchObject({ changed_by: TEST_RUNNER_BY, artifact: batchSettleArtifact(run) });

		const finalTree = run.steps[2]!.tree;
		expect(batchCredits(w.ledger.entries(own1))).toEqual([{ runId, pr: PR.green, sha: fx.head.green, base: fx.main, step: 1, n: 2, finalTree }]);
		expect(batchCredits(w.ledger.entries(own8))).toEqual([{ runId, pr: PR.green2, sha: fx.head.green2, base: fx.main, step: 2, n: 2, finalTree }]);
		expect(batchCredits(w.ledger.entries(wl))).toEqual([]);
		expect(heldMessages(w, wl).map((m) => m.body)).toEqual([
			`test-batch-result: ${wl} ${runId} batch ${runId} of PRs #${PR.green}, #${PR.green2} green onto ${fx.main.slice(0, 7)}: full 3/0/0; credit written for #${PR.green}, #${PR.green2}`,
		]);

		// _as2test's clone is the last merge step; a sweep after publish and after the one full part; the lock released, the queue empty
		expect(g(join(workDirOf(runId, w.as2), "repo"), "rev-parse", "HEAD")).toBe(run.steps[2]!.commit);
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full"]);
		const db = lockDbOf(w);
		expect(lockRow(db)).toBeNull();
		db.close();
		expect(queued(w)).toEqual([]);
		expect(JSON.parse(readFileSync(join(w.runs, runId, "result.json"), "utf8"))).toMatchObject({ runId, verdict: "green" });
	});

	test("red: PR #2 breaks the suite; the red result names its attribution id, whose run waits its turn in the queue, bisects over full-suite prefixes in sub-runs and writes test-batch-attribution: broken by PR #2", async () => {
		const w = world();
		const { wl } = workload(w);
		ownGreen(w, PR.green, fx.head.green);
		// PR #2's own green as the runner writes one: the admission reads the ledger only, and the batch's suite is what finds the break.
		ownGreen(w, PR.red, fx.head.red);
		const r = startBatch(w, wl, [PR.green, PR.red]);
		expect([r.code, r.err]).toEqual([START_EXIT.ok, ""]);
		const runId = r.runId!;

		const run = await batchResultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "red", reason: null, base: fx.main, prs: [{ pr: PR.green, sha: fx.head.green }, { pr: PR.red, sha: fx.head.red }] });
		expect(run.full).toMatchObject({ fail: 25 });
		expect(run.failures[0]!.name).toContain("red.test.ts");
		const attr = run.attribution!;
		expect(attr).toMatch(/^tr-[a-z0-9]+$/);
		expect(attr).not.toBe(runId);
		// a red settles the batch slice on its verdict, and credits nothing
		expect(w.ledger.slice(r.slice!)).toMatchObject({ state: "done", changed_by: TEST_RUNNER_BY });
		expect(w.ledger.slice(r.slice!)!.artifact).toStartWith(`test-batch-run ${runId}: red`);
		expect(w.ledger.slice(r.slice!)!.artifact).toContain(`; attribution ${attr}; `);
		expect(batchCredits(w.ledger.entries(wl))).toEqual([]);

		const a = await attributionOf(w, wl, attr);
		expect(a.batch).toBe(runId);
		expect(a.outcome).toMatchObject({ kind: "broken", step: 2, pr: PR.red });
		// step 0 (main alone) first, then the midpoint of 0..2: both green, so step 2 (PR #2) is the green→red step
		expect(a.outcome.probes.map((p) => [p.step, p.verdict])).toEqual([[0, "green"], [1, "green"]]);
		const row = w.ledger.entries(wl).find((e) => e.body.startsWith(`test-batch-attribution: ${attr} `))!;
		expect(row.body).toStartWith(`test-batch-attribution: ${attr} batch=${runId} broken by PR #${PR.red} at step 2: `);
		expect(newestBatchAttribution(w.runs, () => w.ledger.entries(wl), Date.now())!.state).toEqual({ state: "done", id: attr, outcome: a.outcome });
		expect(heldMessages(w, wl).map((m) => m.body)).toEqual([
			expect.stringMatching(new RegExp(`^test-batch-result: ${wl} ${runId} batch ${runId} of PRs #${PR.green}, #${PR.red} red: full 3/25/0, first .*; attribution ${attr} queued$`)),
			expect.stringMatching(new RegExp(`^test-batch-result: ${wl} ${attr} attribution of batch ${runId}: broken by PR #${PR.red} at step 2: `)),
		]);

		// the attribution took the lock through the queue once, under its own id; each probe was a sub-run with its own run dir and report
		expect(marks(w, attr, "acquired")).toHaveLength(1);
		const probes = [...runnerLog(w, attr).matchAll(/probe of step (\d+) as (tr-[a-z0-9]+)/g)].map((m) => ({ step: Number(m[1]), sub: m[2]! }));
		expect(probes.map((p) => p.step)).toEqual([0, 1]);
		for (const p of probes) {
			expect(p.sub).not.toBe(attr);
			expect(existsSync(join(w.runs, p.sub, "full.xml"))).toBe(true);
		}
		const db = lockDbOf(w);
		expect(lockRow(db)).toBeNull();
		db.close();
		expect(current(w)).toBe(attr);
		expect(queued(w)).toEqual([]);
	}, 300_000);

	for (const point of ["after-result", "after-admit"] as const) {
		test(`a red batch killed ${point} (AGENT_SYSTEM_TEST_RUNNER_CRASH_AT): the red stands, and the reader over the runs.db snapshot reads its attribution lost`, async () => {
			const w = world();
			const { wl } = workload(w);
			ownGreen(w, PR.green, fx.head.green);
			ownGreen(w, PR.red, fx.head.red);
			const r = startBatch(w, wl, [PR.green, PR.red], { AGENT_SYSTEM_TEST_RUNNER_CRASH_AT: point });
			expect([r.code, r.err]).toEqual([START_EXIT.ok, ""]);
			const runId = r.runId!;
			const run = await batchResultOf(w, wl, runId);
			expect(run.verdict).toBe("red");
			const attr = run.attribution!;
			await until(`batch runner ${r.pid} gone`, () => !alive(r.pid!), 60_000);

			// SIGKILL ran no finally: the lock row still names the dead batch; the attribution's runner was never spawned
			const snap = readRunsSnapshot(w.runs);
			expect(snap.lock?.runId).toBe(runId);
			expect(existsSync(join(w.runs, attr, "runner.json"))).toBe(false);
			const rows = batchAttributions(w.ledger.entries(wl));
			expect(rows).toEqual([]);
			if (point === "after-result") {
				// no bundle handed over, no queue row
				expect(existsSync(join(w.as2, "stage", attr))).toBe(false);
				expect(snap.queue).toEqual([]);
				expect(batchAttribution(run, snap.queue, snap.lock, rows, Date.now())).toEqual({ state: "lost", id: attr });
			} else {
				// the bundle handed over and the queue row admitted, with no runner behind it: queued through the startup lease, lost after it
				expect(existsSync(join(w.as2, "stage", attr, "repo.bundle"))).toBe(true);
				expect(snap.queue.map((q) => [q.runId, q.heartbeatAt])).toEqual([[attr, null]]);
				expect(batchAttribution(run, snap.queue, snap.lock, rows, Date.now())).toEqual({ state: "running", id: attr, where: "queued" });
				expect(batchAttribution(run, snap.queue, snap.lock, rows, Date.now() + 121_000)).toEqual({ state: "lost", id: attr });
			}
			expect(newestBatchAttribution(w.runs, () => w.ledger.entries(wl), Date.now() + 121_000)!.state).toEqual({ state: "lost", id: attr });
			// the red line went out with the result, before the kill; no attribution line follows
			expect(heldMessages(w, wl).map((m) => m.body)).toEqual([expect.stringContaining(`; attribution ${attr} queued`)]);
		});
	}

	test("start-batch refuses a PR with no full green at its pinned head on its own workload, or whose head branch names no workload: nothing admitted, no slice, no request", () => {
		const w = world();
		const { wl } = workload(w);
		ownGreen(w, PR.green, fx.head.green);
		// PR #8's newest own run is a green at main, not at the head gh reports
		const own8 = ownGreen(w, PR.green2, fx.head.green2, fx.main);
		const ownRun = testRuns(w.ledger.entries(own8))[0]!.request.runId;
		const moved = startBatch(w, wl, [PR.green, PR.green2]);
		expect(moved.code).toBe(START_EXIT.refused);
		expect(moved.err).toBe(`test-runner start-batch: PR #${PR.green2} has no full green at ${fx.head.green2.slice(0, 7)} (its newest run ${ownRun} on ${own8} ran at ${fx.main.slice(0, 7)})`);

		setPr(w, PR.green2, { sha: fx.head.green2, headRefName: "feature/b" });
		const unowned = startBatch(w, wl, [PR.green, PR.green2]);
		expect(unowned.code).toBe(START_EXIT.refused);
		expect(unowned.err).toBe(`test-runner start-batch: PR #${PR.green2} has no full green at ${fx.head.green2.slice(0, 7)} (its head branch feature/b names no wl/<id> workload in the ledger)`);

		expect(w.ledger.entries(wl).filter((e) => e.body.startsWith("test-batch-requested:"))).toEqual([]);
		expect(w.ledger.slices(wl).filter((s) => s.id.startsWith("sl-batch-"))).toEqual([]);
		expect(queued(w)).toEqual([]);
	});

	test("a batch whose runner died (no heartbeat past the 120 s lease) is settled by the next start-batch on its workload as error runner died, with its line; the new batch then runs", async () => {
		const w = world();
		const { wl } = workload(w);
		ownGreen(w, PR.green, fx.head.green);
		ownGreen(w, PR.green2, fx.head.green2);
		const dead = earlierBatch(w, wl, 200_000);
		const r = startBatch(w, wl, [PR.green, PR.green2]);
		expect([r.code, r.err]).toEqual([START_EXIT.ok, ""]);
		expect(batchRuns(w.ledger.entries(wl)).find((x) => x.runId === dead.runId)).toMatchObject({
			verdict: "error", reason: "runner died", runDir: join(w.runs, dead.runId), full: null, attribution: null, prs: dead.prs,
		});
		expect(heldMessages(w, wl).map((m) => m.body)).toEqual([`test-batch-result: ${wl} ${dead.runId} batch ${dead.runId} of PRs #${PR.green}, #${PR.green2} error: runner died`]);
		expect(r.slice).not.toBe(dead.slice);
		expect((await batchResultOf(w, wl, r.runId!)).verdict).toBe("green");
		expect(w.ledger.slice(r.slice!)!.state).toBe("done");
		// the dead batch's slice settles on its error row, as a red batch's does on its red
		expect(w.ledger.slice(dead.slice)).toMatchObject({ state: "done", changed_by: TEST_RUNNER_BY });
		expect(w.ledger.slice(dead.slice)!.artifact).toStartWith(`test-batch-run ${dead.runId}: error`);
		expect(w.ledger.slice(dead.slice)!.artifact).toContain("; runner died; ");
	});

	test("a batch settled as runner died whose runner comes back writes nothing: it leaves the queue at its first poll, and the settle row stays its only result", async () => {
		const w = world();
		const { wl } = workload(w);
		const late = earlierBatch(w, wl, 0);
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: late.slice, kind: "assumption", body: testBatchRunBody(batchRunnerDiedRun({ runId: late.runId, prs: late.prs, slice: late.slice, by: "jo" }, join(w.runs, late.runId))) });
		const db = queueDbOf(w);
		try {
			admit(db, late.runId);
		} finally {
			db.close();
		}
		expect(await spawnRun(w, late.runId).exited).toBe(0);
		expect(batchRuns(w.ledger.entries(wl)).filter((x) => x.runId === late.runId)).toEqual([expect.objectContaining({ verdict: "error", reason: "runner died" })]);
		expect(runnerLog(w, late.runId)).toContain(`nothing written: ${late.runId} already has its test-batch-run:`);
		expect(marks(w, late.runId, "acquired")).toEqual([]);
		expect(queued(w)).toEqual([]);
		expect(heldMessages(w, wl)).toEqual([]);
		expect(w.ledger.slice(late.slice)!.state).toBe("open");
	});
});

describe("the batch starter's request transaction, in process (review r1 finding 3, review r2 finding 2)", () => {
	/** A throwaway ledger and runs lock for `fn`, both closed after. */
	function inProcess(fn: (ledger: Ledger, db: Database, runs: string) => void): void {
		const root = realpathSync(tmp("trun-reqbatch"));
		const ledgerRoot = realpathSync(tmp("trun-reqbatch-ledger"));
		roots.push(root, ledgerRoot);
		const ledger = Ledger.open(join(ledgerRoot, "ledger.db"), { create: true, backup: false, backupOnOpen: false });
		const db = openLockDb(join(root, "runs"), 0);
		try {
			fn(ledger, db, join(root, "runs"));
		} finally {
			db.close();
			ledger.close();
		}
	}

	/** PR `pr` at `sha` on a workload of its own with the runner's full green there at that head; returns the starter's gh view of it and the own workload. */
	function ownGreenView(ledger: Ledger, pr: number, sha: string): { view: PrView; own: string } {
		const own = ledger.openWorkload({ by: SURFACE_BY, brief: `PR #${pr}'s own work`, stakes: "normal", mode: "autonomous" });
		const request = { runId: newRunId(), pr, sha, slice: "sl-full-own-1", by: LANE };
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: own, kind: "assumption", body: testRequestedBody(request) });
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: own, kind: "assumption",
			body: testRunBody({
				...runnerDiedRun(request, `/runs/${request.runId}`), verdict: "green", reason: null, headAtEnd: sha,
				full: { pass: 2, fail: 0, skip: 0, exit: 0, ms: 900, error: null }, preflight: "ok",
			}),
		});
		return { own, view: { number: pr, state: "OPEN", headRefOid: sha, headRefName: `wl/${own}`, baseRefName: "main", isCrossRepository: false } };
	}

	/** What `f` throws (it must throw). */
	function thrown(f: () => unknown): unknown {
		try {
			f();
		} catch (e) {
			return e;
		}
		throw new Error("expected a throw");
	}

	test("one instruction starts one batch: a second starter that passed the early check is refused inside the request transaction, and its admission is removed", () => {
		inProcess((ledger, db, runs) => {
			const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "batch", stakes: "normal", mode: "autonomous" });
			const { instructionId } = requestTestBatch(ledger, { kind: "test-batch", workloadId: wl, prs: [12, 15] });
			const views = [ownGreenView(ledger, 12, "a".repeat(40)).view, ownGreenView(ledger, 15, "b".repeat(40)).view];
			const first = makeRunId(Date.now(), "first1");
			const second = makeRunId(Date.now() + 1, "second");
			// Both starters passed batchInstruction before either wrote (the race): only the check inside the transaction stands between them.
			const { slice, prs } = requestBatch(ledger, db, runs, wl, instructionId, first, views);
			expect(prs).toEqual([{ pr: 12, sha: "a".repeat(40) }, { pr: 15, sha: "b".repeat(40) }]);
			expect(() => requestBatch(ledger, db, runs, wl, instructionId, second, views)).toThrow(`${instructionId} already started batch ${first}`);
			expect(queueRows(db).map((r) => r.runId)).toEqual([first]);
			expect(batchRequests(ledger.entries(wl)).map((r) => [r.runId, r.slice])).toEqual([[first, slice]]);
			expect(ledger.slices(wl).filter((s) => s.id.startsWith("sl-batch-")).map((s) => s.id)).toEqual([slice]);
		});
	});

	test("a run requested, or a red written, on a PR's own workload after the early check refuses the batch inside the request transaction: no slice, no request, its admission removed", () => {
		inProcess((ledger, db, runs) => {
			const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "batch", stakes: "normal", mode: "autonomous" });
			const { instructionId } = requestTestBatch(ledger, { kind: "test-batch", workloadId: wl, prs: [12, 15] });
			const head = "b".repeat(40);
			const a = ownGreenView(ledger, 12, "a".repeat(40));
			const b = ownGreenView(ledger, 15, head);
			const views = [a.view, b.view];
			// The early check (the starter's, before its admission) passes on these views and rows.
			expect(batchAdmissible([a, b].map(({ view, own }) => ({ view, records: testRuns(ledger.entries(own)) }))).ok).toBe(true);
			// Then, before the request transaction, a lane asks for a new run of PR #15 on its own workload: the full green is no longer its newest run.
			const late = { runId: newRunId(), pr: 15, sha: head, slice: "sl-full-own-2", by: LANE };
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: b.own, kind: "assumption", body: testRequestedBody(late) });
			const pending = thrown(() => requestBatch(ledger, db, runs, wl, instructionId, makeRunId(Date.now(), "pendng"), views));
			expect(pending).toMatchObject({ message: `PR #15 has no full green at ${head.slice(0, 7)} (its newest run ${late.runId} on ${b.own} has no result)`, code: START_EXIT.refused });
			// That run then ends red: still refused.
			ledger.recordEntry({
				by: TEST_RUNNER_BY, workloadId: b.own, kind: "assumption",
				body: testRunBody({
					...runnerDiedRun(late, `/runs/${late.runId}`), verdict: "red", reason: null, headAtEnd: head,
					full: { pass: 1, fail: 1, skip: 0, exit: 1, ms: 900, error: null }, preflight: "ok",
				}),
			});
			const red = thrown(() => requestBatch(ledger, db, runs, wl, instructionId, makeRunId(Date.now() + 1, "redrun"), views));
			expect(red).toMatchObject({ message: `PR #15 has no full green at ${head.slice(0, 7)} (its newest run ${late.runId} on ${b.own} is red)`, code: START_EXIT.refused });
			expect(queueRows(db)).toEqual([]);
			expect(batchRequests(ledger.entries(wl))).toEqual([]);
			expect(ledger.slices(wl).filter((s) => s.id.startsWith("sl-batch-"))).toEqual([]);
		});
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

describe("the doc-only main-merge facts from real merges, in process (plan wl-mv615mkeaf1yio § 3)", () => {
	const MAIN = "refs/remotes/origin/main";
	/** A repo whose base commit B holds two code files and MIGRATION.md; the lane branch `wl` is checked out at B. */
	function repo(): { dir: string; b: string } {
		const dir = realpathSync(tmp("trun-merge"));
		roots.push(dir);
		g(dir, "init", "-q", "-b", "main");
		const b = commit(dir, { "code.ts": "one\ntwo\nthree\n", "main.ts": "m\n", "MIGRATION.md": "# items\n1. first\n" }, "base");
		g(dir, "checkout", "-q", "-b", "wl");
		return { dir, b };
	}
	function commit(dir: string, files: Record<string, string>, msg: string): string {
		for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
		g(dir, "add", "-A");
		g(dir, "commit", "-q", "-m", msg);
		return g(dir, "rev-parse", "HEAD");
	}
	/** On main (from wherever it is), then back on `wl`; origin/main is moved to main's tip as the runner's fetch would. */
	function onMain(dir: string, files: Record<string, string>, msg: string): string {
		g(dir, "checkout", "-q", "main");
		const sha = commit(dir, files, msg);
		g(dir, "update-ref", MAIN, sha);
		g(dir, "checkout", "-q", "wl");
		return sha;
	}
	/** `git merge` on `wl` that may stop on a conflict: its exit code. */
	const merge = (dir: string, ...args: string[]): number | null => Bun.spawnSync(["git", "merge", "--no-edit", ...args], { cwd: dir, env: GIT_ENV, stdout: "pipe", stderr: "pipe" }).exitCode;
	/** The basis: a full green of PR #9 at `sha`, as testRuns gives it. */
	function greenAt(sha: string): RunRecord[] {
		const request = { runId: "tr-0basis", pr: 9, sha, slice: "sl-full-x-1", by: LANE, entryId: "e-1", createdAt: "2026-10-13T00:00:00.000Z" };
		const result = { ...runnerDiedRun(request), verdict: "green" as const, reason: null, full: { pass: 1, fail: 0, skip: 0, exit: 0, ms: 1, error: null }, entryId: "e-2", createdAt: "2026-10-13T00:01:00.000Z" };
		return [{ request, results: [result], result }];
	}
	const head = (dir: string): string => g(dir, "rev-parse", "HEAD");

	test("a MIGRATION.md conflict resolved by hand with code merged from one side each: the five lists, one merge base, P2 on the chain; doc-merge", async () => {
		const { dir, b } = repo();
		const p1 = commit(dir, { "code.ts": "ONE\ntwo\nthree\n", "MIGRATION.md": "# items\n1. first\n2. the lane's item\n" }, "the lane's change");
		const p2 = onMain(dir, { "main.ts": "m2\n", "MIGRATION.md": "# items\n1. first\n2. main's item\n" }, "main moves");
		expect(merge(dir, "main")).toBe(1);
		writeFileSync(join(dir, "MIGRATION.md"), "# items\n1. first\n2. main's item\n3. the lane's item\n");
		g(dir, "add", "MIGRATION.md");
		g(dir, "commit", "-q", "--no-edit");
		const h = head(dir);
		const facts = await gatherMergeFacts(dir, GIT_ENV, h, MAIN);
		expect(facts).toEqual({
			parents: [p1, p2], tip: p2, mainOnChain: true, mergeBases: [b],
			diffs: { baseP1: ["MIGRATION.md", "code.ts"], baseP2: ["MIGRATION.md", "main.ts"], p1p2: ["MIGRATION.md", "code.ts", "main.ts"], p1h: ["MIGRATION.md", "main.ts"], p2h: ["MIGRATION.md", "code.ts"] },
		});
		expect(docMergeDecision(facts, greenAt(p1), 9)).toEqual({ mode: "doc-merge", basis: { runId: "tr-0basis", sha: p1 }, merge: { main: p2, tip: p2, docs: ["MIGRATION.md"] } });
		// main moved on after the merge: P2 is still a main state on the chain, and the tip is recorded as it is
		const tip = onMain(dir, { "late.ts": "l\n" }, "main moves again");
		expect(docMergeDecision(await gatherMergeFacts(dir, GIT_ENV, h, MAIN), greenAt(p1), 9)).toEqual({ mode: "doc-merge", basis: { runId: "tr-0basis", sha: p1 }, merge: { main: p2, tip, docs: ["MIGRATION.md"] } });
	});

	test("a conflicted code file resolved by hand, or with -X ours: both sides changed it; full suite", async () => {
		for (const resolve of ["hand", "ours"] as const) {
			const { dir } = repo();
			const p1 = commit(dir, { "code.ts": "ONE\ntwo\nthree\n" }, "the lane's change");
			onMain(dir, { "code.ts": "uno\ntwo\nthree\n" }, "main's change");
			if (resolve === "hand") {
				expect(merge(dir, "main")).toBe(1);
				writeFileSync(join(dir, "code.ts"), "ONE uno\ntwo\nthree\n");
				g(dir, "add", "code.ts");
				g(dir, "commit", "-q", "--no-edit");
			} else {
				expect(merge(dir, "-X", "ours", "main")).toBe(0);
				expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("ONE\ntwo\nthree\n");
			}
			const facts = await gatherMergeFacts(dir, GIT_ENV, head(dir), MAIN);
			expect([resolve, docMergeDecision(facts, greenAt(p1), 9)]).toEqual([resolve, { mode: "full", reason: "the merge resolution touched code.ts: both sides changed it to different content" }]);
		}
	});

	test("a merge that drops main's one-sided change (-s ours) fails the dropped-side check; an edit no side made fails the neither-version check", async () => {
		const dropped = repo();
		const p1 = commit(dropped.dir, { "code.ts": "ONE\ntwo\nthree\n" }, "the lane's change");
		const p2 = onMain(dropped.dir, { "main.ts": "m2\n" }, "main's change");
		expect(merge(dropped.dir, "-s", "ours", "main")).toBe(0);
		const f1 = await gatherMergeFacts(dropped.dir, GIT_ENV, head(dropped.dir), MAIN);
		expect(f1.parents).toEqual([p1, p2]);
		expect(f1.diffs!.p1h).toEqual([]);
		expect(f1.diffs!.p2h).toEqual(["code.ts", "main.ts"]);
		expect(docMergeDecision(f1, greenAt(p1), 9)).toEqual({ mode: "full", reason: "the merge resolution touched main.ts: the merge dropped main's change, the only side that changed it" });

		const evil = repo();
		const q1 = commit(evil.dir, { "code.ts": "ONE\ntwo\nthree\n" }, "the lane's change");
		onMain(evil.dir, { "MIGRATION.md": "# items\n1. first\n2. main's item\n" }, "main's doc");
		expect(merge(evil.dir, "--no-commit", "main")).toBe(0);
		writeFileSync(join(evil.dir, "main.ts"), "edited in the merge\n");
		g(evil.dir, "add", "main.ts");
		g(evil.dir, "commit", "-q", "--no-edit");
		const f2 = await gatherMergeFacts(evil.dir, GIT_ENV, head(evil.dir), MAIN);
		expect(docMergeDecision(f2, greenAt(q1), 9)).toEqual({ mode: "full", reason: "the merge resolution touched main.ts: the merge holds neither parent's version" });
	});

	test("P2 merged into main by a merge commit is an ancestor of origin/main but not on its first-parent chain: full suite", async () => {
		const { dir, b } = repo();
		const p1 = commit(dir, { "code.ts": "ONE\ntwo\nthree\n" }, "the lane's change");
		g(dir, "checkout", "-q", "-b", "side", b);
		const side = commit(dir, { "main.ts": "from a side branch\n" }, "a side branch commit main never was");
		g(dir, "checkout", "-q", "main");
		expect(merge(dir, "--no-ff", "side")).toBe(0);
		g(dir, "update-ref", MAIN, "main");
		g(dir, "checkout", "-q", "wl");
		expect(merge(dir, "side")).toBe(0);
		const facts = await gatherMergeFacts(dir, GIT_ENV, head(dir), MAIN);
		expect(facts.parents).toEqual([p1, side]);
		expect(g(dir, "merge-base", "--is-ancestor", side, MAIN)).toBe("");
		expect(facts.mainOnChain).toBe(false);
		expect(docMergeDecision(facts, greenAt(p1), 9)).toEqual({ mode: "full", reason: `the second parent ${side.slice(0, 7)} is not on origin/main's first-parent chain` });
	});

	test("a criss-cross merge has two merge bases and no diffs are read; a head with one parent reads nothing past its parents", async () => {
		const { dir, b } = repo();
		const x1 = commit(dir, { "code.ts": "ONE\ntwo\nthree\n" }, "x1");
		g(dir, "checkout", "-q", "main");
		const y1 = commit(dir, { "main.ts": "m2\n" }, "y1");
		expect(merge(dir, x1)).toBe(0);
		g(dir, "update-ref", MAIN, "main");
		g(dir, "checkout", "-q", "wl");
		expect(merge(dir, y1)).toBe(0);
		const x2 = commit(dir, { "code.ts": "ONE\nTWO\nthree\n" }, "x2");
		expect(merge(dir, "main")).toBe(0);
		const facts = await gatherMergeFacts(dir, GIT_ENV, head(dir), MAIN);
		expect(facts.parents[0]).toBe(x2);
		expect([...facts.mergeBases!].sort()).toEqual([x1, y1].sort());
		expect(facts.diffs).toBeNull();
		expect(docMergeDecision(facts, greenAt(x2), 9)).toEqual({ mode: "full", reason: "the parents have 2 merge bases, not 1" });

		const linear = await gatherMergeFacts(dir, GIT_ENV, x1, MAIN);
		expect(linear).toEqual({ parents: [b], tip: g(dir, "rev-parse", MAIN), mainOnChain: null, mergeBases: null, diffs: null });
		expect(docMergeDecision(linear, greenAt(b), 9)).toEqual({ mode: "full", reason: "the head has 1 parent(s), not 2" });
	});
});

describe("the batch's trusted git and the runs.db snapshot, in process (plan wl-mv615mkeaf1yio § 4)", () => {
	/** A repo at M0 with three PR commits off it: p1 and p2 touch different files, p3 conflicts with p1. */
	function batchRepo(): { dir: string; m0: string; p1: string; p2: string; p3: string } {
		const dir = realpathSync(tmp("trun-batch"));
		roots.push(dir);
		g(dir, "init", "-q", "-b", "main");
		const put = (files: Record<string, string>, msg: string): string => {
			for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
			g(dir, "add", "-A");
			g(dir, "commit", "-q", "-m", msg);
			return g(dir, "rev-parse", "HEAD");
		};
		const m0 = put({ "a.txt": "a\n", "b.txt": "b\n" }, "M0");
		const off = (name: string, files: Record<string, string>): string => {
			g(dir, "checkout", "-q", "-b", name, m0);
			const sha = put(files, name);
			g(dir, "checkout", "-q", "main");
			return sha;
		};
		return { dir, m0, p1: off("p1", { "a.txt": "a from p1\n" }), p2: off("p2", { "b.txt": "b from p2\n" }), p3: off("p3", { "a.txt": "a from p3\n" }) };
	}
	const tree = (dir: string, c: string): string => g(dir, "rev-parse", `${c}^{tree}`);

	test("buildBatch: step 0 is M0, each step a --no-ff merge of the next head onto the last, named as2-batch-<k>, by the runner's identity", async () => {
		const { dir, m0, p1, p2 } = batchRepo();
		const r = await buildBatch(dir, GIT_ENV, m0, [p1, p2]);
		expect(r.conflict).toBeNull();
		expect(r.steps).toHaveLength(3);
		expect(r.steps[0]).toEqual({ commit: m0, tree: tree(dir, m0) });
		for (const [k, s] of r.steps.entries()) {
			expect(g(dir, "rev-parse", `refs/heads/as2-batch-${k}`)).toBe(s.commit);
			expect(tree(dir, s.commit)).toBe(s.tree);
		}
		expect(g(dir, "rev-list", "--parents", "-n", "1", r.steps[1]!.commit)).toBe(`${r.steps[1]!.commit} ${m0} ${p1}`);
		expect(g(dir, "rev-list", "--parents", "-n", "1", r.steps[2]!.commit)).toBe(`${r.steps[2]!.commit} ${r.steps[1]!.commit} ${p2}`);
		expect(g(dir, "show", `${r.steps[2]!.commit}:a.txt`)).toBe("a from p1");
		expect(g(dir, "show", `${r.steps[2]!.commit}:b.txt`)).toBe("b from p2");
		expect(g(dir, "log", "-1", "--format=%cn <%ce>", r.steps[2]!.commit)).toBe("agent-system test-runner <test-runner@agent-system.invalid>");
	});

	test("buildBatch: a conflicting merge is aborted and its 1-based step returned with the steps before it", async () => {
		const { dir, m0, p1, p3 } = batchRepo();
		const r = await buildBatch(dir, GIT_ENV, m0, [p1, p3]);
		expect(r.conflict).toBe(2);
		expect(r.steps.map((s) => s.commit)).toEqual([m0, g(dir, "rev-parse", "refs/heads/as2-batch-1")]);
		expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
		expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "refs/heads/as2-batch-2"], { cwd: dir, env: GIT_ENV }).exitCode).not.toBe(0);
	});

	test("verifyBundleSteps: every step in the bundle with its tree is null; a wrong tree, a missing commit and a missing bundle are named; the clone dir is removed", async () => {
		const { dir, m0, p1, p2 } = batchRepo();
		const { steps } = await buildBatch(dir, GIT_ENV, m0, [p1, p2]);
		const bundle = join(dir, "..", `${dir.split("/").at(-1)}.bundle`);
		roots.push(bundle);
		g(dir, "bundle", "create", "-q", bundle, "--all");
		const into = join(dir, "..", `${dir.split("/").at(-1)}-verify`);
		expect(await verifyBundleSteps(bundle, into, GIT_ENV, steps)).toBeNull();
		expect(existsSync(into)).toBe(false);
		const wrongTree = steps.map((s, k) => (k === 1 ? { ...s, tree: steps[0]!.tree } : s));
		expect(await verifyBundleSteps(bundle, into, GIT_ENV, wrongTree)).toBe(`step 1 has tree ${steps[1]!.tree.slice(0, 7)}, not the recorded ${steps[0]!.tree.slice(0, 7)}`);
		const missing = [...steps, { commit: "f".repeat(40), tree: steps[0]!.tree }];
		expect(await verifyBundleSteps(bundle, into, GIT_ENV, missing)).toBe(`step 3 (fffffff) is not in the bundle`);
		expect(await verifyBundleSteps(join(dir, "no.bundle"), into, GIT_ENV, steps)).toStartWith(`git clone of ${join(dir, "no.bundle")} failed: `);
		expect(existsSync(into)).toBe(false);
	});

	/** A runs root and a stage dir of their own; nothing is spawned. */
	function lockDb(): { db: Database; stage: string; runs: string } {
		const root = realpathSync(tmp("trun-batchlock"));
		roots.push(root);
		const stage = join(root, "stage");
		mkdirSync(stage);
		const runs = join(root, "runs");
		return { db: openLockDb(runs, 0), stage, runs };
	}
	const as = (runId: string): Claimant => ({ runId, pid: 1, runDir: `/nowhere/${runId}` });

	test("publishSub: the holder's sub-run is published as current while the lock row keeps the holder; a run that is not the holder publishes nothing", () => {
		const { db, stage } = lockDb();
		const holder = makeRunId(Date.now(), "attr");
		const sub = makeRunId(Date.now(), "sub1");
		try {
			expect(tryAcquire(db, stage, as(holder), () => null)).toEqual({ displaced: null });
			expect(publishSub(db, stage, holder, sub)).toBe(true);
			expect(readFileSync(join(stage, "current"), "utf8")).toBe(`${sub}\n`);
			expect(lockRow(db)?.runId).toBe(holder);
			expect(publishSub(db, stage, makeRunId(Date.now(), "othr"), makeRunId(Date.now(), "sub2"))).toBe(false);
			expect(readFileSync(join(stage, "current"), "utf8")).toBe(`${sub}\n`);
			expect(publishIfOwner(db, stage, holder)).toBe(true);
			expect(readFileSync(join(stage, "current"), "utf8")).toBe(`${holder}\n`);
		} finally {
			db.close();
		}
	});

	/**
	 * The runner's acquisition as it happens in production: another process, runs.db with no busy wait.
	 * (A writer in this process beside the reader's read-only connection gets SQLITE_IOERR_LOCK from its
	 * BEGIN IMMEDIATE, never the cross-process SQLITE_BUSY, so it would not model the runner.)
	 */
	function acquireElsewhere(runs: string, stage: string, runId: string): { code: number | null; out: string } {
		const script = `import { openLockDb, tryAcquire } from ${JSON.stringify(RUNNER)};
const db = openLockDb(${JSON.stringify(runs)}, 0);
try { console.log(JSON.stringify(tryAcquire(db, ${JSON.stringify(stage)}, { runId: ${JSON.stringify(runId)}, pid: 1, runDir: "/nowhere" }, () => null))); }
catch (e) { console.log(String(e)); process.exit(3); }`;
		const r = Bun.spawnSync([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
		return { code: r.exitCode, out: `${r.stdout.toString().trim()}${r.stderr.toString().trim()}` };
	}

	test("the reader's one read transaction: an acquisition cannot commit between its lock read and its queue read, so the attribution is queued, then holding, never neither", () => {
		const { db, stage, runs } = lockDb();
		const batch = makeRunId(Date.now(), "btch");
		const x = makeRunId(Date.now(), "attr");
		admit(db, x);
		db.close();
		let between: { code: number | null; out: string } | null = null;
		const snap = readRunsSnapshot(runs, () => {
			between = acquireElsewhere(runs, stage, x);
		});
		expect(between!).toEqual({ code: 3, out: expect.stringMatching(/database is locked|SQLITE_BUSY/) });
		expect(snap.lock).toBeNull();
		expect(snap.queue.map((q) => q.runId)).toEqual([x]);
		expect(batchAttribution({ runId: batch, attribution: x }, snap.queue, snap.lock, [], Date.now())).toEqual({ state: "running", id: x, where: "queued" });

		expect(acquireElsewhere(runs, stage, x)).toEqual({ code: 0, out: JSON.stringify({ displaced: null }) });
		const after = readRunsSnapshot(runs);
		expect(after.queue).toEqual([]);
		expect(after.lock?.runId).toBe(x);
		expect(batchAttribution({ runId: batch, attribution: x }, after.queue, after.lock, [], Date.now())).toEqual({ state: "running", id: x, where: "holding the lock" });
	});

	test("the attribution reader reads runs.db before the ledger: a result committed and its lock row removed after the first ledger read is done, never lost (review r1 finding 4)", () => {
		const { db, stage, runs } = lockDb();
		const ledgerRoot = realpathSync(tmp("trun-batchlock-ledger"));
		roots.push(ledgerRoot);
		const ledger = Ledger.open(join(ledgerRoot, "ledger.db"), { create: true, backup: false, backupOnOpen: false });
		const batch = makeRunId(Date.now(), "btch");
		const x = makeRunId(Date.now(), "attr");
		try {
			const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "batch", stakes: "normal", mode: "autonomous" });
			const prs = [{ pr: 12, sha: "a".repeat(40) }, { pr: 15, sha: "b".repeat(40) }];
			const steps = ["1", "2", "3"].map((c) => ({ commit: c.repeat(40), tree: c.repeat(40) }));
			const red: TestBatchRun = {
				runId: batch, verdict: "red", base: steps[0]!.commit, prs, steps, full: { pass: 9, fail: 1, skip: 0, exit: 1, ms: 1, error: null },
				failures: [{ part: "full", name: "a.test.ts > breaks", firstError: "boom" }], attribution: x, reason: null, headsAtEnd: prs.map((p) => p.sha), runDir: null, preflight: null,
			};
			ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchRunBody(red) });
			// the attribution holds the lock with a fresh heartbeat
			expect(tryAcquire(db, stage, as(x), () => null)).toEqual({ displaced: null });
			const outcome = { kind: "main-red" as const, probes: [] };
			const reads: string[] = [];
			let finished = false;
			const entriesNow = () => {
				reads.push("ledger");
				const e = ledger.entries(wl);
				if (!finished) {
					// The runner's finish lands right after this read: its attribution row commits, then its lock row goes.
					finished = true;
					ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testBatchAttributionBody({ runId: x, batch, outcome }) });
					db.query("DELETE FROM lock WHERE runId = ?").run(x);
				}
				return e;
			};
			const state = newestBatchAttribution(runs, entriesNow, Date.now(), () => reads.push("runs.db"))!.state;
			expect(state).toEqual({ state: "done", id: x, outcome });
			expect(reads).toEqual(["ledger", "runs.db", "ledger"]);
		} finally {
			db.close();
			ledger.close();
		}
	});
});
