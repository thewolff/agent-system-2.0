// S5b: the outside-the-fence test runner end to end, from the lane's side (MIGRATION.md item 24; plan of
// wl-muraerdsgw7gn4, § 2.1, § 4, § 6 row S5b). The surface mounts the lane row (the aside) and the lane
// tools on a fake pi whose `exec` runs the REAL starter from this checkout (`bun surface/scripts/test-runner.ts
// start ...`, a real child process that detaches the real runner), on a temp ledger, a temp runs root and a
// temp as2test root. GitHub is a local bare repo with refs/pull/<N>/head and a fake `gh`; `_as2test` is the S4b
// wrapper rendered with `sweepScope: groups` behind a fake `sudo` (the same fixture as test-runner.test.ts).
// The lane holds its workload under a live lease. Green: `lane_full_test` returns the starter's line, the run
// settles the slice it added, and one aside names the verdict and counts. Red: the slice stays open, the aside
// names the failing test with its first error line, and `lane_complete_slice` is refused with the runner message.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { renderExecWrapper } from "../src/as2test";
import { recordRepo } from "../src/decision-log";
import { partResult, type TestRun, testRuns, WRAPPER_EXIT } from "../src/test-run";
import { INSTRUCTION_POLL_MS, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, timers, tmp, until } from "./helpers";

setDefaultTimeout(90_000);

const RUNNER = join(import.meta.dir, "..", "scripts", "test-runner.ts");
const TEST_EXEC = join(import.meta.dir, "..", "scripts", "test-exec.ts");
const OWNER_REPO = "thewolff/agent-system-2.0";
const LANE = "lane-smoke-1";

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

// ---- the fixture repository: main plus a green PR and a red PR ---------------------------------------

const PR = { green: 1, red: 2 } as const;
type PrName = keyof typeof PR;
const PASS = (name: string) => `import { expect, test } from "bun:test";\ntest(${JSON.stringify(name)}, () => { expect(1 + 1).toBe(2); });\n`;
const RED = `import { test } from "bun:test";
test("the broken thing", () => { throw new Error("kaboom: the broken thing broke"); });
test("the fine thing", () => {});
`;
const PR_FILES: Record<PrName, Record<string, string>> = { green: { "a.test.ts": PASS("a") }, red: { "red.test.ts": RED } };

let fx: { bare: string; head: Record<PrName, string> };

beforeAll(() => {
	const root = realpathSync(tmp("smoke-fixture"));
	roots.push(root);
	const work = join(root, "work");
	mkdirSync(work);
	g(work, "init", "-q", "-b", "main");
	writeFileSync(join(work, "README.md"), "runner fixture\n");
	writeFileSync(join(work, "xa.test.ts"), PASS("xa"));
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
	fx = { bare, head };
});

// ---- a world: ledger, runs root, as2test root, install, fake gh and sudo -----------------------------------

const GH = `#!/bin/sh
dir="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$1 $2" = "pr view" ] && [ -f "$dir/prs/$3.json" ]; then cat "$dir/prs/$3.json"; exit 0; fi
echo "no pull requests found" >&2
exit 1
`;
// `_as2test` is the current user here, so a fake sudo cannot deny it anything: `probe` is forwarded to the real
// wrapper with every answer reported closed (the real denial is proved at S8, plan § 8). `-n <libexec>/refresh`
// with no other argument is exec'd as test-runner.test.ts's fake does; every call is logged to sudo.log.
const SUDO = `#!/bin/sh
log="$(dirname "$0")/../sudo.log"
if [ "$#" = 2 ] && [ "$1" = -n ]; then
	case "$2" in /*/refresh) printf 'refresh\\n' >> "$log"; exec "$2" ;; esac
fi
[ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = _as2test ] || { echo "fake sudo: bad argv" >&2; exit 1; }
shift 3
printf '%s %s\\n' "$2" "$3" >> "$log"
if [ "$2" = probe ]; then
	out=$("$@")
	code=$?
	if [ "$code" != 0 ] && [ "$code" != 65 ]; then printf '%s\\n' "$out"; exit "$code"; fi
	printf '%s\\n' "$out" | sed -e 's/"read":true/"read":false/g' -e 's/"write":true/"write":false/g'
	exit 0
fi
exec "$@"
`;

interface World {
	root: string;
	checkout: string;
	runs: string;
	env: Record<string, string>;
	ledger: Ledger;
}

function world(): World {
	const root = realpathSync(tmp("smoke"));
	roots.push(root);
	const gid = statSync(root).gid;
	const uid = process.getuid!();
	const home = join(root, "home");
	for (const d of [join(home, ".agent-system-2"), join(root, "bin"), join(root, "prs"), join(root, "hooks"), join(root, "runs")]) mkdirSync(d, { recursive: true });
	const ledgerPath = join(home, ".agent-system-2", "ledger.db");
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false });

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
	const libexec = join(root, "libexec");
	mkdirSync(libexec);
	chmodSync(libexec, 0o755);
	writeFileSync(join(libexec, "exec"), renderExecWrapper({
		root: as2, bun: process.execPath, script: TEST_EXEC, sweepScope: "groups", hooks: join(root, "hooks"), killGraceMs: 300, sweepLockWaitMs: 30_000,
	}));
	writeFileSync(join(libexec, "bun"), "stand-in for the installed bun\n");
	writeFileSync(join(libexec, "test-exec.js"), "stand-in for the installed bundle\n");
	// The refresh helper's stand-in: the install matches, so no run here calls it.
	writeFileSync(join(libexec, "refresh"), "#!/bin/sh\necho 'fake refresh: not expected in the smoke' >&2\nexit 99\n");
	mkdirSync(join(libexec, "refresh.d"), { mode: 0o700 });
	chmodSync(join(libexec, "refresh.d"), 0o700);
	const source = [
		"version 1", "source /tmp/as2-checkout", `source-sha ${"0".repeat(40)}`, `bun-version ${Bun.version}`, "user _as2test", `uid ${uid}`, `gid ${gid}`, "jo jo", `jo-uid ${uid}`,
		...["exec", "bun", "test-exec.js", "refresh"].map((f) => `file ${f} ${sha256(join(libexec, f))}`),
		`input surface/scripts/test-exec.ts ${sha256(TEST_EXEC)}`,
	];
	writeFileSync(join(libexec, "SOURCE"), `${source.join("\n")}\n`);
	for (const f of ["exec", "bun", "test-exec.js", "refresh", "SOURCE"]) chmodSync(join(libexec, f), 0o755);
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

	const config = join(root, "config.yml");
	writeFileSync(config, `testRunner:\n  repos:\n    - origin: ${OWNER_REPO}\n      command: bun test\n  fullCapMin: 2\n  soloCapMin: 2\n  reportCapMb: 5\n  queueMaxMin: 60\n`);

	const env: Record<string, string> = {
		PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", USER: process.env.USER ?? "jo",
		AGENT_SYSTEM_LEDGER_DB: ledgerPath, AGENT_SYSTEM_TEST_RUNS: join(root, "runs"), AGENT_SYSTEM_TEST_RUNNER_CONFIG: config, AGENT_SYSTEM_TEST_RUNNER_ORIGIN: origin,
		AGENT_SYSTEM_TEST_RUNNER_ROOT: as2,
		AGENT_SYSTEM_TEST_RUNNER_INSTALL: JSON.stringify({ libexec, sudoers, ids: { root: uid, wheel: gid, jo: uid }, account: { uid, gid } }),
		AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "500", AGENT_SYSTEM_TEST_RUNNER_POLL_MS: "200", AGENT_SYSTEM_TEST_RUNNER_BUSY_MS: "300",
	};
	return { root, checkout, runs: join(root, "runs"), env, ledger };
}

/** What the fake gh answers for `pr view <N>`. */
function setPr(w: World, n: number, sha: string, headRefName: string): void {
	writeFileSync(join(w.root, "prs", `${n}.json`), JSON.stringify({ number: n, state: "OPEN", headRefOid: sha, headRefName, baseRefName: "main", isCrossRepository: false }));
}

/**
 * A lane session on a fresh world: an open autonomous workload on the world's checkout (no slice yet: the
 * runner adds the full-suite slice), held by the lane under a live lease, with the lane row and the lane tools
 * mounted on a fake pi whose exec runs the real starter as a child process.
 */
async function lane() {
	const w = world();
	const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "runner smoke", stakes: "normal", mode: "autonomous" });
	recordRepo(w.ledger, wl, w.checkout);
	w.ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
	expect(w.ledger.claimWorkload(wl, { by: "lane-starter", holder: LANE, leaseMs: 600_000 }).won).toBe(true);

	const env = { ...w.env, AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: LANE };
	const f = fakePi(undefined, { exec: true });
	// The host's exec for the one command the tool names: `bun <starter> start ...` as a real process in this checkout's env.
	Object.assign(f.pi, {
		exec: async (command: string, args: string[]) => {
			f.execs.calls.push({ command, args, options: undefined });
			const p = Bun.spawn([command === "bun" ? process.execPath : command, ...args], { env: w.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
			return { stdout, stderr, code, killed: false };
		},
	});
	timers.length = 0;
	orchestratorSurface(f.pi, env);
	const ctx = ctxOf();
	await f.emit("session_start", { type: "session_start" }, ctx);
	await f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, ctx);
	const poll = () => timers.find((t) => t.ms === INSTRUCTION_POLL_MS)!.fn();
	const asides = () => f.sent.filter((s) => s.message.customType === "lane-test-run");
	const call = async (tool: string, params: Record<string, unknown>) => (await f.tool(tool).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	const toolResult = (id: string) => f.emit("tool_result", { toolName: "read", toolCallId: id, input: {}, isError: false }, ctx);
	return { w, wl, f, call, poll, asides, toolResult };
}

const LINE = /^test-run (tr-[a-z0-9]+) runner (\d+) sha ([0-9a-f]{40}) slice (sl-full-\S+-1) log (\S+)$/;

/** The run's own `test-run:` (the runner's first entry for it), once written. */
const resultOf = (w: World, wl: string, runId: string): Promise<TestRun & { entryId: string }> =>
	until(`the test-run: of ${runId}`, () => testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)?.results[0] ?? null, 75_000);

describe("S5b: lane_full_test to the lane's aside, through the real starter and runner", () => {
	test("green PR: the line, the request and the full-suite slice; the run settles the slice; exactly one aside names the verdict and counts", async () => {
		const l = await lane();
		setPr(l.w, PR.green, fx.head.green, `wl/${l.wl}`);

		// (1) the tool returns the starter's line at once; the request entry and the full-suite slice exist
		const out = await l.call("lane_full_test", { pr: String(PR.green) });
		const first = out.split("\n")[0]!;
		const m = LINE.exec(first);
		expect(m).not.toBeNull();
		const [, runId, pid, sha, slice, log] = m as unknown as string[];
		expect(sha).toBe(fx.head.green);
		expect(log).toBe(join(l.w.runs, runId!, "runner.log"));
		expect(Number(pid)).toBeGreaterThan(1);
		expect(l.f.execs.calls.map((c) => [c.command, c.args.slice(1)])).toEqual([["bun", ["start", l.wl, String(PR.green), "--requested-by", LANE]]]);
		const requested = l.w.ledger.entries(l.wl).filter((e) => e.created_by === TEST_RUNNER_BY && e.body.startsWith("test-requested:"));
		expect(requested).toHaveLength(1);
		expect(requested[0]!.body).toContain(`${runId}`);
		expect(requested[0]!.body).toContain(`sha=${fx.head.green}`);
		expect(l.w.ledger.slice(slice!)).toMatchObject({ workload_id: l.wl, created_by: TEST_RUNNER_BY, task: `full suite outside the fence at PR #${PR.green}` });

		// (2) the detached run finishes: its test-run: entry lands on the ledger (bounded poll)
		const run = await resultOf(l.w, l.wl, runId!);

		// (3) green, by the test runner, and the slice is done with the settle artifact
		expect(run).toMatchObject({ verdict: "green", sha: fx.head.green, pr: PR.green });
		const entry = l.w.ledger.entries(l.wl).find((e) => e.id === run.entryId)!;
		expect(entry.created_by).toBe(TEST_RUNNER_BY);
		expect(entry.body.startsWith(`test-run: ${runId} green sha=${fx.head.green}`)).toBe(true);
		expect(run.full).toMatchObject({ pass: 2, fail: 0, exit: 0 });
		await until("the settle", () => l.w.ledger.slice(slice!)?.state === "done", 30_000);
		expect(l.w.ledger.slice(slice!)).toMatchObject({ state: "done", changed_by: TEST_RUNNER_BY });
		// PLAN wl-mvq4edh02r5z40 D1: the full part ran the changed a.test.ts, so nothing runs alone.
		expect(l.w.ledger.slice(slice!)!.artifact).toBe(`test-run ${runId}: green at ${fx.head.green} on PR #${PR.green}; full 2/0/0; alone: none; ${join(l.w.runs, runId!)}`);

		// (4) the lane row delivers exactly one aside, on the timer and on a tool result, never again
		expect(l.asides()).toEqual([]);
		l.poll();
		await l.toolResult("r1");
		l.poll();
		expect(l.asides()).toHaveLength(1);
		const a = l.asides()[0]!;
		expect(a.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(a.message.content).toStartWith(`Test run ${runId} on ${l.wl}: green at ${fx.head.green} (PR #${PR.green}, slice ${slice}, ledger entry ${run.entryId}).`);
		expect(a.message.content).toContain("Full suite: 2 passed, 0 failed, 0 skipped.");
		expect(a.message.content).toContain("Test files alone: none.");
		expect(a.message.content).toContain(`The runner completed ${slice} on this green`);
	});

	test("red PR: the slice stays open; the aside lists the failing test with its first error line; lane_complete_slice is refused with the runner's message", async () => {
		const l = await lane();
		setPr(l.w, PR.red, fx.head.red, `wl/${l.wl}`);

		const out = await l.call("lane_full_test", { pr: String(PR.red) });
		const m = LINE.exec(out.split("\n")[0]!);
		expect(m).not.toBeNull();
		const [, runId, , sha, slice] = m as unknown as string[];
		expect(sha).toBe(fx.head.red);

		const run = await resultOf(l.w, l.wl, runId!);
		expect(run).toMatchObject({ verdict: "red", sha: fx.head.red, pr: PR.red });
		expect(run.full).toMatchObject({ pass: 2, fail: 1 });
		// the same test fails in the full suite and again when its changed file runs alone
		expect(run.failures.map((x) => x.part)).toEqual(["full", "./red.test.ts"]);
		const failure = run.failures[0]!;
		expect(failure.name).toContain("the broken thing");
		expect(failure.firstError).toContain("kaboom: the broken thing broke");
		expect(l.w.ledger.entries(l.wl).find((e) => e.id === run.entryId)!.body.startsWith(`test-run: ${runId} red sha=${fx.head.red}`)).toBe(true);
		// the runner holds the slice open on a red
		expect(l.w.ledger.slice(slice!)).toMatchObject({ state: "open", created_by: TEST_RUNNER_BY });

		l.poll();
		await l.toolResult("r1");
		l.poll();
		expect(l.asides()).toHaveLength(1);
		const c = l.asides()[0]!.message.content;
		expect(c).toStartWith(`Test run ${runId} on ${l.wl}: red at ${fx.head.red} (PR #${PR.red}, slice ${slice}, ledger entry ${run.entryId}).`);
		expect(c).toContain("Full suite: 2 passed, 1 failed, 0 skipped.");
		expect(c).toContain("Test files alone: ./red.test.ts 1 passed, 1 failed, 0 skipped.");
		expect(c).toContain(`Failing (2 of 2):\n- [full] ${failure.name}: ${failure.firstError}\n- [./red.test.ts] ${run.failures[1]!.name}: ${run.failures[1]!.firstError}`);
		expect(c).toContain("kaboom: the broken thing broke");
		expect(c).toContain(`${slice} stays open: fix, push, then call lane_full_test with pr ${PR.red} and slice ${slice} again.`);

		// the lane cannot complete the slice itself: the runner settles it
		expect(await l.call("lane_complete_slice", { slice: slice!, artifact: "bun test passed" })).toBe(`the test runner settles ${slice}; call lane_full_test. Nothing was completed.`);
		expect(l.w.ledger.slice(slice!)!.state).toBe("open");
	});
});

// PLAN wl-mvq4edbaf13vnk D4 (R9): the Mac fallback of the hosted fast check, through the same rendered wrapper and fake sudo
// the runner spawns, on the red PR's bundle: `fast` runs only the ./ test files it names, inside the clone, in one bun call.
describe("fast through the installed-form wrapper: only the named ./ test files, in one bun test call", () => {
	test("fast on the red PR's clone runs red.test.ts alone (never xa.test.ts), records one process group, and refuses an operand outside the clone or an option", () => {
		const w = world();
		const as2 = join(w.root, "as2");
		const exec = join(w.root, "libexec", "exec");
		const runId = "tr-fastsmoke1";
		const stage = join(as2, "stage", runId);
		mkdirSync(stage);
		g(fx.bare, "bundle", "create", "-q", join(stage, "repo.bundle"), "--all");
		writeFileSync(join(stage, "caps.json"), JSON.stringify({ fullCapMin: 2, soloCapMin: 2, fastCapMin: 2 }));
		writeFileSync(join(as2, "stage", "current"), `${runId}\n`);
		const wrap = (...args: string[]) => {
			const r = Bun.spawnSync(["sudo", "-n", "-u", "_as2test", exec, ...args], { env: w.env, stdout: "pipe", stderr: "pipe" });
			return { exit: r.exitCode, stderr: r.stderr.toString() };
		};
		expect(wrap("prepare", runId, fx.head.red)).toEqual({ exit: WRAPPER_EXIT.ok, stderr: "" });
		const work = join(as2, "runs", runId);

		for (const op of ["../xa.test.ts", "./../red.test.ts", "--bail", "xa.test.ts", "./README.md", "/etc/red.test.ts", "./missing.test.ts"]) {
			const r = wrap("fast", runId, "./red.test.ts", op);
			expect({ op, exit: r.exit }).toEqual({ op, exit: WRAPPER_EXIT.refused });
		}
		expect(readdirSync(work).filter((n) => n.startsWith("fast."))).toEqual([]);

		const r = wrap("fast", runId, "./red.test.ts");
		expect(r).toEqual({ exit: 1, stderr: "" });
		expect(readFileSync(join(w.root, "sudo.log"), "utf8").trim().split("\n").at(-1)).toBe(`fast ${runId}`);
		expect(readFileSync(join(work, "groups"), "utf8").split("\n").filter((l) => l !== "")).toHaveLength(1);
		const junit = readFileSync(join(work, "fast.xml"), "utf8");
		const result = partResult({ junit, log: readFileSync(join(work, "fast.log"), "utf8"), exit: r.exit, ms: 0 });
		expect(result).toMatchObject({ pass: 1, fail: 1, skip: 0, exit: 1, error: null });
		expect(result.failures.map((f) => f.name)).toEqual(["red.test.ts > the broken thing"]);
		expect(junit).not.toContain("xa.test.ts");
	});
});
