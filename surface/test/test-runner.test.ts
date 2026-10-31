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
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Ledger, LiveLedgerUnderTestError, TEST_RUNNER_BY } from "../../ledger/src/index";
import { KILL_GRACE_MS, renderExecWrapper, SWEEP_LOCK_WAIT_MS } from "../src/as2test";
import { recordRepo } from "../src/decision-log";
import { landFirstBody, landFirstInstructionBody, landFirstOffBody, trainFixBody } from "../src/launch";
import {
	childLayout, fastPlanBody, fastPlanOf, heartbeatText, makeRunId, parseHeartbeat, parseTestRun, partResult, pushDestBody, runnerDiedRun, type TestRun, testRequestedBody, testRunBody, testRuns, workDirOf,
	withFullSuitePublication, WRAPPER_EXIT, type WrapperCall, wrapperArgv,
} from "../src/test-run";
import { FULL_SUITE_STATUS, landFirstNoticeBody, trainBody, trainFullSliceId, trainInstructionBody, trainSliceId } from "../src/merge-train";
import { MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { admitMain, citedRuns, importPart, importReport, lockRow, openLockDb, postGate, postStatus, promoteMain, publishIfOwner, reap as reapRequests, retentionPrune, revokeOpen, run, START_EXIT, verifiedPreflight, type Gh } from "../scripts/test-runner";
import { bootstrapRefusal, mainResults, mainVerdicts, parseRunnerPreflight, SUSPECT_MAX_MS } from "../src/main-state";
import { type Proc, snapshot, STUCK_DEFAULTS } from "../src/stuck-detect";
import { admitProof, inspectProof, type LoadReceipt, parseProofManifest, type ProofManifest } from "../src/timing-proof";
import { alive, tmp, unreapedTrue, until } from "./helpers";
import { carry305, landFirst, mainRun } from "./train-world";

setDefaultTimeout(180_000);

const RUNNER = join(import.meta.dir, "..", "scripts", "test-runner.ts");
/** The timing-proof controller: submit, inspect and the detached series `run` (TOOLS-REVIEW-r1 F5). */
const PROOF_CLI = join(import.meta.dir, "..", "..", "scripts", "timing-proof.ts");
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
/** A file whose only case is skipped: the full part runs no test of it, so it runs alone (PLAN wl-mvq4edh02r5z40 D1). */
const SKIPPED = (name: string) => `import { test } from "bun:test";\ntest.skip(${JSON.stringify(name)}, () => {});\n`;
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
// HANG after 6 MiB of output: the part's log passes the world's 5 MB report cap, so its import is refused. The sleep is the
// hang the part's cap must end; it runs in the code under test, not in this file's own tests.
const HANG_LOUD = `import { test } from "bun:test";
test("hangs loudly", async () => {
	for (let i = 0; i < 6; i++) process.stdout.write(\`\${"x".repeat(1 << 20)}\\n\`);
	await Bun.sleep(10_000_000);
}, 100_000_000);
`;
// A failing security test (surface/src/test-run.ts SECURITY_TEST_PATHS): a gate test the PR breaks (fix round 1, F4).
const GATE_RED = `import { test } from "bun:test";
test("refuses a forged approve", () => { throw new Error("the gate let it through"); });
`;
// The positive spin fixture of surface/test/as2test.test.ts (`SPIN_HEAD` and `spinTest(false)`, PLAN wl-mvq8x4pkjmx69s sl-sd-exec),
// its text reused: the lost-reap state built by hand. The test holds its own marker for `true` exactly as the preload does (flock
// LOCK_EX|LOCK_NB, the D1 content `<since ms>\t<command>\n` on `$AS2TEST_STUCK_MARKERS/<pid>`), spawns /usr/bin/true asynchronously
// at once, then spins forever: marker active, the worker hot, the child an unreaped zombie.
const SPIN = `import { test } from "bun:test";
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
test("spins", () => {
	writeFileSync("../spin.pid", String(process.pid));
	holdMarker("true");
	const z = ${unreapedTrue()};
	writeFileSync("../zombie.pid", String(z.pid));
	for (;;) {}
}, 600_000);
`;

const PR = { green: 1, red: 2, solo: 3, env: 4, hang: 5, exit: 6, space: 7, gate: 8, skipped: 9, loud: 10, parse: 11, belief95: 12, belief90: 13, belief80: 14, spin: 15, proofenv: 16 } as const;
type PrName = keyof typeof PR;
const PR_FILES: Record<PrName, Record<string, string>> = {
	green: { "a.test.ts": PASS("a") },
	red: { "red.test.ts": RED },
	solo: { "order_spec.ts": SOLO_ONLY },
	env: { "env.test.ts": ENV_DUMP },
	hang: { "hang.test.ts": HANG },
	exit: { "exits.test.ts": EXITS },
	// git lists ` a.test.ts` first (a space sorts before `a`); trimmed, it would name its sibling. Only the skipped one runs alone.
	space: { " a.test.ts": SKIPPED("space a"), "a.test.ts": PASS("a") },
	gate: { "gates/test/gate.test.ts": GATE_RED },
	skipped: { "a.test.ts": SKIPPED("a skipped") },
	loud: { "loud.test.ts": HANG_LOUD },
	// PLAN wl-mvq4edbaf13vnk D4: a changed .ts that does not transpile beside a passing test, for the fast run's parse check.
	parse: { "a.test.ts": PASS("a"), "lib.ts": "export const x = ;\n" },
	// xa.test.ts plus nineteen files: exactly 95% or 90% execute a case.
	belief95: Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`belief-${i}.test.ts`, i === 0 ? SKIPPED("skipped") : PASS(`belief ${i}`)])),
	belief90: Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`belief-${i}.test.ts`, i < 2 ? SKIPPED("skipped") : PASS(`belief ${i}`)])),
	belief80: { "a.test.ts": PASS("one") + '\ntest("two", () => {});\ntest("three", () => {});\n' },
	spin: { "spin.test.ts": SPIN },
	proofenv: { "proof-env.test.ts": `import { beforeAll, afterAll, expect, test } from "bun:test";
beforeAll(() => console.log("timing-proof setup proof-env.test.ts ready"));
afterAll(() => console.log("timing-proof cleanup proof-env.test.ts reaped"));
test("proof environment", () => {
	expect(process.env.AS2_STUCK_BUDGET_PROOF).toBe("1");
	expect(process.env.GH_TOKEN).toBeUndefined();
	expect(process.env.OPENAI_API_KEY).toBeUndefined();
	const child = Bun.spawnSync([process.execPath, "-e", "console.log(JSON.stringify({budget:process.env.AS2_STUCK_BUDGET_PROOF,secret:process.env.GH_TOKEN}))"], {env:process.env,stdout:"pipe",stderr:"pipe"});
	expect(child.exitCode).toBe(0);
	expect(JSON.parse(child.stdout.toString())).toEqual({budget:"1"});
});
` },
};

interface Fixture {
	bare: string;
	main: string;
	control: string;
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
	mkdirSync(join(work, "surface", "scripts"), { recursive: true });
	writeFileSync(join(work, "surface", "scripts", "test-exec.ts"), readFileSync(TEST_EXEC));
	// Every checkout would run the `evil` smudge filter if any config the runner reads defined it.
	writeFileSync(join(work, ".gitattributes"), "*.ts filter=evil\n");
	g(work, "add", "-A");
	g(work, "commit", "-q", "-m", "main");
	const control = g(work, "rev-parse", "HEAD");
	g(work, "update-ref", "refs/heads/control", control);
	writeFileSync(join(work, "README.md"), "main after verified control fixture\n");
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
	g(work, "push", "-q", bare, "main", "control", "+refs/pull/*:refs/pull/*");
	fx = { bare, main, control, head };
});

// ---- a world: ledger, runs root, as2test root, install, fake gh and sudo --------------------------------

// `gh api <path>` answers `<root>/api/<path, / as _>` when a test saved one (`saveApi`: the starter's compare and commit reads);
// any other `gh api` (the runner's `as2/full-suite` status post) answers `{}`, or fails while `<root>/status-fails` exists.
// Land-first (PLAN wl-mvq4edbaf13vnk D4): `gh api -X POST <path>` answers `<root>/post/<key>` (or fails with `<key>.fail`'s text);
// a status post of state S fails while `<root>/status-fails-S` exists, and each status post that succeeds is logged to status-ok.log.
// `gh run download … -n as2-fast-<run> -D <dir>` copies `<root>/artifact/` into <dir>, `@REQ@` in fast.summary replaced by the run.
const GH = `#!/bin/sh
dir="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\\n' "$*" >> "$dir/gh.log"
if [ "$1 $2" = "pr view" ] && [ -f "$dir/prs/$3.json" ]; then cat "$dir/prs/$3.json"; exit 0; fi
if [ "$1 $2" = "issue view" ] && [ -f "$dir/incident.json" ]; then cat "$dir/incident.json"; exit 0; fi
if [ "$1" = api ] && [ "$2" = -X ]; then
	case "$4" in
	*/git/refs|*/git/refs/tags/as2-verified)
		if [ -f "$dir/tag-fails" ]; then echo 'tag write failed (HTTP 502)' >&2; exit 1; fi
		for a in "$@"; do case "$a" in sha=*) printf '%s' "\${a#sha=}" > "$dir/verified-tag" ;; esac; done
		echo '{}'; exit 0 ;;
	esac
fi
if [ "$1" = api ]; then
	case "$2" in */git/ref/tags/as2-verified)
		if [ -f "$dir/verified-tag" ]; then printf '{"object":{"type":"commit","sha":"%s"}}' "$(cat "$dir/verified-tag")"; exit 0; fi
		if [ ! -f "$dir/api/$(printf '%s' "$2" | tr / _)" ]; then echo 'HTTP 404 Not Found' >&2; exit 1; fi ;;
	esac
fi
if [ "$1 $2" = "pr list" ] && [ -f "$dir/open-prs.json" ]; then cat "$dir/open-prs.json"; exit 0; fi
if [ "$1" = api ] && [ "$2" = -X ]; then
	st=""
	for a in "$@"; do case "$a" in state=*) st="\${a#state=}" ;; esac; done
	if [ -n "$st" ] && [ -f "$dir/status-fails-$st" ]; then echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
	key=$(printf '%s' "$4" | tr / _)
	if [ -f "$dir/post/$key.fail" ]; then cat "$dir/post/$key.fail" >&2; exit 1; fi
	if [ -f "$dir/post/$key" ]; then cat "$dir/post/$key"; exit 0; fi
	if [ -n "$st" ] && [ ! -f "$dir/status-fails" ]; then printf '%s %s\\n' "$st" "$4" >> "$dir/status-ok.log"; fi
fi
if [ "$1" = api ] && [ -f "$dir/api/$(printf '%s' "$2" | tr / _)" ]; then cat "$dir/api/$(printf '%s' "$2" | tr / _)"; exit 0; fi
if [ "$1" = api ] && [ ! -f "$dir/status-fails" ]; then echo '{}'; exit 0; fi
if [ "$1" = api ]; then echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
if [ "$1 $2" = "run download" ]; then
	d=""; n=""; prev=""
	for a in "$@"; do [ "$prev" = -D ] && d="$a"; [ "$prev" = -n ] && n="$a"; prev="$a"; done
	if [ -d "$dir/artifact" ] && [ -n "$d" ]; then
		mkdir -p "$d" && cp "$dir/artifact/"* "$d/" || exit 1
		if [ -f "$dir/artifact/fast.summary" ]; then sed "s/@REQ@/\${n#as2-fast-}/" "$dir/artifact/fast.summary" > "$d/fast.summary"; fi
		exit 0
	fi
	echo "no valid artifacts found to download" >&2
	exit 1
fi
echo "no pull requests found" >&2
exit 1
`;
/** The fake gh's `as2/full-suite` status posts, in order: `<state> <sha>`. */
const statusPosts = (w: World): string[] => {
	const log = join(w.root, "gh.log");
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8").trim().split("\n").filter((c) => c.startsWith("api -X ") && c.includes("/statuses/")).map((c) => {
		const m = /^api -X POST repos\/(\S+)\/statuses\/([0-9a-f]{40}) -f state=(\S+) -f context=as2\/full-suite -f description=/.exec(c);
		if (!m || m[1] !== OWNER_REPO) throw new Error(`unexpected gh api call: ${c}`);
		return `${m[3]} ${m[2]}`;
	});
};
// Every call is logged to sudo.log, one line each: `refresh`, or the wrapper subcommand and its run id. A part call (`full`,
// `solo`, `base-solo`) goes to `<root>/part-standin` instead when a test wrote one (`standIn`): the exec stand-in of the
// stuck-worker tests (PLAN wl-mvq8x4pkjmx69s D4), given the wrapper's argv (`<exec> <sub> <run id> [file]`).
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
standin="$(dirname "$0")/../part-standin"
case "$2" in full|solo|base-solo) [ -x "$standin" ] && exec "$standin" "$@" ;; esac
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
function writeSource(libexec: string, o: { inputSha?: string; to?: string; sha?: string } = {}): void {
	const uid = process.getuid!();
	const gid = statSync(libexec).gid;
	const to = o.to ?? join(libexec, "SOURCE");
	const source = [
		"version 1", "source /tmp/as2-checkout", `source-sha ${o.sha ?? "0".repeat(40)}`, `bun-version ${Bun.version}`, "user _as2test", `uid ${uid}`, `gid ${gid}`, "jo jo", `jo-uid ${uid}`,
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
	/** Run `fn` with the ledger clock stopped at `iso`: every row it writes has that created_at. */
	pin: <T>(iso: string, fn: () => T) => T;
}

/** The executor's test-only detector knobs (PLAN wl-mvq8x4pkjmx69s D3): a groups render carries them into the wrapper's config. */
interface DetectKnobs { detectTickMs?: number; detectPersistMs?: number; signatureCaptureMs?: number; stopGraceMs?: number }

/**
 * `bare` is the origin the world mirrors (the fixture's by default); `runs` the runs root (a fresh `<root>/runs` by default): the
 * field soak's worlds share one that outlives them.
 */
function world(o: { capMin?: number; queueMaxMin?: number; killGraceMs?: number; sweepLockWaitMs?: number; fullWorkers?: number; stuckStop?: "shadow" | "enforce"; detect?: DetectKnobs; bare?: string; runs?: string } = {}): World {
	const root = realpathSync(tmp("trun"));
	roots.push(root);
	const gid = statSync(root).gid;
	const uid = process.getuid!();
	const home = join(root, "home");
	const runs = o.runs ?? join(root, "runs");
	for (const d of [join(home, ".agent-system-2"), join(home, ".config", "git"), join(root, "bin"), join(root, "prs"), join(root, "hooks"), runs]) mkdirSync(d, { recursive: true });
	// Jo's own config defines the filter the fixture's .gitattributes names; the trusted phase must never read it.
	// (No `;` in the value: gitconfig would read it as a comment.)
	const evil = `[filter "evil"]\n\tsmudge = touch ${root}/SMUDGED && cat\n\tclean = cat\n`;
	writeFileSync(join(home, ".gitconfig"), evil);
	writeFileSync(join(home, ".config", "git", "config"), evil);
	const ledgerPath = join(home, ".agent-system-2", "ledger.db");
	let offset = 0;
	let pinned: string | null = null;
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: () => pinned ?? new Date(Date.now() - offset).toISOString() });
	const ago = <T>(ms: number, fn: () => T): T => {
		offset = ms;
		try {
			return fn();
		} finally {
			offset = 0;
		}
	};
	const pin = <T>(iso: string, fn: () => T): T => {
		pinned = iso;
		try {
			return fn();
		} finally {
			pinned = null;
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
	const resourcesPath = join(root, "resources.json");
	writeFileSync(resourcesPath, JSON.stringify({ workerCpu: 1, workerMemoryBytes: 1, reserveCpu: 0, reserveMemoryBytes: 0, calibration: "synthetic test fixture only; not host calibration" }));
	writeFileSync(exec, renderExecWrapper({
		root: as2, bun: process.execPath, script: TEST_EXEC, sweepScope: "groups", hooks, resourcesPath, killGraceMs: o.killGraceMs ?? 300, sweepLockWaitMs: o.sweepLockWaitMs ?? 30_000, ...o.detect,
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
	g(root, "clone", "-q", "--mirror", o.bare ?? fx.bare, origin);
	const checkout = join(root, "checkout");
	mkdirSync(checkout);
	g(checkout, "init", "-q", "-b", "main");
	g(checkout, "remote", "add", "origin", `https://github.com/${OWNER_REPO}.git`);

	const cap = o.capMin ?? 2;
	const config = join(root, "config.yml");
	const workers = o.fullWorkers === undefined ? "" : `  fullWorkers: ${o.fullWorkers}\n`;
	const stuck = o.stuckStop === undefined ? "" : `  stuckStop: ${o.stuckStop}\n`;
	writeFileSync(config, `testRunner:\n  repos:\n    - origin: ${OWNER_REPO}\n      command: bun test\n  fullCapMin: ${cap}\n  soloCapMin: ${cap}\n  reportCapMb: 5\n  queueMaxMin: ${o.queueMaxMin ?? 60}\n${workers}${stuck}`);

	const env: Record<string, string> = {
		PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", USER: process.env.USER ?? "jo",
		AGENT_SYSTEM_LEDGER_DB: ledgerPath, AGENT_SYSTEM_TEST_RUNS: runs, AGENT_SYSTEM_TEST_RUNNER_CONFIG: config, AGENT_SYSTEM_TEST_RUNNER_ORIGIN: origin,
		AGENT_SYSTEM_TEST_RUNNER_ROOT: as2,
		AGENT_SYSTEM_TEST_RUNNER_VERIFIED: join(home, ".agent-system-2", "verified"),
		AGENT_SYSTEM_TEST_RUNNER_INSTALL: JSON.stringify({ libexec, sudoers, ids: { root: uid, wheel: gid, jo: uid }, account: { uid, gid } }),
		AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "500", AGENT_SYSTEM_TEST_RUNNER_POLL_MS: "200", AGENT_SYSTEM_TEST_RUNNER_BUSY_MS: "300", AGENT_SYSTEM_TEST_HOOKS: hooks,
		// Credentials in Jo's env: none may reach the code under test (plan § 3).
		GH_TOKEN: "secret-gh", ANTHROPIC_API_KEY: "secret-anthropic", OPENAI_API_KEY: "secret-openai", MOONSHOT_API_KEY: "secret-moonshot",
		SSH_AUTH_SOCK: "/tmp/secret-agent.sock", OMP_SESSION_TOKEN: "secret-omp", AGENT_SYSTEM_SECRET: "secret-as",
	};
	return { root, home, runs, as2, libexec, exec, hooks, origin, checkout, env, ledger, ago, pin };
}

/** Real detached control root and actual tag/helper/SOURCE facts; no fixture-only ok row. */
function verifiedWorld(w: World, sha = fx.control): string {
	const dir = w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!;
	mkdirSync(dir, { recursive: true });
	const clone = join(dir, "repo");
	g(w.root, "clone", "-q", "--no-checkout", w.origin, clone);
	const release = join(dir, sha.slice(0, 12));
	g(clone, "worktree", "add", "-q", "--detach", release, sha);
	g(clone, "remote", "set-url", "origin", `https://github.com/${OWNER_REPO}.git`);
	symlinkSync(release, join(dir, "current"));
	w.env.AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT = release;
	mainRun(w.ledger, "tr-controlseed", sha, "green", { exec: { files: 1, tests: 1, treeFiles: 1 } });
	writeFileSync(join(w.root, "verified-tag"), sha);
	writeFileSync(join(w.libexec, "refresh"), `#!/bin/sh
# refs/tags/as2-verified:refs/tags/as2-verified
set -eu
sha=$(cat '${join(w.root, "verified-tag")}')
sed "s/^source-sha .*/source-sha $sha/" '${join(w.libexec, "SOURCE")}' > '${join(w.libexec, "SOURCE.new")}'
chmod 755 '${join(w.libexec, "SOURCE.new")}'
mv '${join(w.libexec, "SOURCE.new")}' '${join(w.libexec, "SOURCE")}'
echo refreshed
`);
	writeSource(w.libexec, { sha });
	return release;
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

/** Jo's `train <wl> <prs>` as the surface writes it: the instruction, then the surface's `train:` naming it; returns that entry's id. */
function joTrains(w: World, wl: string, prs: number[]): string {
	const id = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: trainInstructionBody(wl, prs), author: "jo", channel: "surface" });
	return w.ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: trainBody(prs, id) });
}

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

	// jo-issues #213: a merge train's run never ends on the lock-wait cap; a dead holder is caught by lockHolderStale, not by the cap.
	test("train: a merge train's run waits past queueMaxMin behind a live holder without ending queued too long, then takes the lock once it is free and settles", async () => {
		const w = world({ queueMaxMin: 0.01 });
		const { wl, slice } = workload(w);
		setPr(w, A, { sha: fx.head.green, headRefName: `plumb/${A}` });
		joTrains(w, wl, [A]);
		const capMs = 0.01 * 60_000;
		const db = lockDbOf(w);
		db.query("INSERT INTO lock (id, runId, pid, pgid, runDir, heartbeatAt) VALUES (1, 'tr-otherholder', 1, 1, '/nowhere', ?)").run(Date.now() + 600_000);
		const kids: Child[] = [];
		try {
			// Requested at a sha the PR head is not, so once it holds the lock it ends stale quickly.
			const runId = request(w, wl, slice, A, fx.main);
			const child = spawnRun(w, runId);
			kids.push(child);
			const first = (await until("the first queued poll", () => marks(w, runId, "queued")[0]))!.at as number;
			// The run's wait began before its first queued mark, so a mark past first + the cap is past the cap; three caps is well past it.
			await until("three queued polls past three caps", () => {
				const s = testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)?.results[0];
				if (s) throw new Error(`the train run settled while the holder was live: ${s.verdict} ${s.reason ?? ""}\n--- runner.log ---\n${runnerLog(w, runId)}`);
				return marks(w, runId, "queued").filter((m) => (m.at as number) > first + 3 * capMs).length >= 3;
			});
			expect(testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)!.results).toEqual([]);
			expect(queueRows(w).map((q) => q.runId)).toEqual([runId]);
			expect(lockRow(db)!.runId).toBe("tr-otherholder");
			db.query("DELETE FROM lock").run();
			const run = await resultOf(w, wl, runId);
			expect(run.reason).not.toBe("queued too long");
			expect(run.verdict).toBe("stale");
			expect(marks(w, runId, "acquired")).toHaveLength(1);
			await child.exited;
		} finally {
			await reap(kids);
			db.close();
		}
	});
});

// PLAN wl-mvpwkpqobyp20w D4-D5: a merge train's request at a head that descends from the PR's last green only by decision-log
// commits is green at once, with no run. Requests and results are seeded as the runner writes them; GitHub's compare and
// get-a-commit answers are saved for the fake gh (`saveApi`). Every head that falls through is fx.main, which the PR's ref is
// not, so its run ends stale at once.
describe("start: the carried green (PLAN wl-mvpwkpqobyp20w D4)", () => {
	const P = PR.green;
	const S = "5".repeat(40);
	const LOG = ".ai/decision-log/2026-10-26--1200--jev--a-close.md";
	const saveApi = (w: World, path: string, json: unknown) => {
		mkdirSync(join(w.root, "api"), { recursive: true });
		writeFileSync(join(w.root, "api", path.replaceAll("/", "_")), JSON.stringify(json));
	};
	/** GitHub's compare of `from`...`to` on OWNER_REPO, each commit with its own files (a merge with two parents lists none read). */
	function compare(w: World, from: string, to: string, commits: { sha: string; parents?: number; files?: string[] }[]): void {
		saveApi(w, `repos/${OWNER_REPO}/compare/${from}...${to}`, {
			status: "ahead", total_commits: commits.length,
			commits: commits.map((c) => ({ sha: c.sha, parents: Array.from({ length: c.parents ?? 1 }, (_, i) => ({ sha: String(i).repeat(40) })) })),
		});
		for (const c of commits) saveApi(w, `repos/${OWNER_REPO}/commits/${c.sha}`, [{ sha: c.sha, files: (c.files ?? []).map((filename) => ({ filename, status: "added" })) }]);
	}
	type Seeded = "green" | "red" | "error" | "pending";
	/** A request for PR P at `sha` on `wl`, and its result as the runner writes it (full 7/0/0, or 6/1/0 for a red), unless pending. */
	function seed(w: World, wl: string, sha: string, verdict: Seeded, agoMs = 0): string {
		const slice = w.ledger.slices(wl)[0]!.id;
		const runId = request(w, wl, slice, P, sha, agoMs);
		if (verdict !== "pending") finish(w, wl, runId, sha, verdict, Math.max(agoMs - 1000, 0));
		return runId;
	}
	function finish(w: World, wl: string, runId: string, sha: string, verdict: Exclude<Seeded, "pending">, agoMs = 0, execution: Pick<TestRun, "scope" | "host"> = {}): void {
		const red = verdict === "red";
		const run: TestRun = {
			runId, verdict, sha, pr: P, reason: verdict === "green" || red ? null : `seeded ${verdict}`, headAtEnd: sha, base: fx.main, mergeBase: fx.main,
			full: verdict === "error" ? null : { pass: red ? 6 : 7, fail: red ? 1 : 0, skip: 0, exit: red ? 1 : 0, ms: 5, error: null }, solo: [],
			failures: red ? [{ part: "full", name: "t > x", firstError: "error: x" }] : [], runDir: `/runs/${runId}`, preflight: "ok",
			...execution,
		};
		const slice = testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === runId)!.request.slice;
		w.ago(agoMs, () => w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRunBody(run) }));
	}
	/** A train on P whose PR head is `head` on branch `wl/<owner>` (an owner workload on the same checkout), with no request yet. */
	function trainWorld(head: string) {
		const w = world();
		const { wl: train } = workload(w);
		const { wl: owner } = workload(w);
		const entry = joTrains(w, train, [P]);
		setPr(w, P, { sha: head, headRefName: `wl/${owner}` });
		return { w, train, owner, entry };
	}
	/** A fix workload bound to P on `train` through its `train:` entry, as the tick opens one. */
	function fixOf(w: World, train: string, entry: string): string {
		const { wl } = workload(w);
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainFixBody({ repo: OWNER_REPO, pr: P, train, trainEntry: entry }) });
		return wl;
	}
	const runIdOf = (out: string): string => /^test-run (tr-[a-z0-9]+) /.exec(out)![1]!;
	/** A start that carries R: exit 0, no runner, the line ending ` carried <R>`, a green at the head with R's counts, its slice done on it. */
	function carried(w: World, train: string, from: string, fromSha: string, head: string, extra: string[] = []): TestRun & { entryId: string } {
		const r = start(w, train, P, extra);
		expect(r.code).toBe(START_EXIT.ok);
		expect(r.out).toMatch(new RegExp(`^test-run tr-[a-z0-9]+ runner none sha ${head} slice sl-\\S+ log none bound-by in-[a-z0-9]+ carried ${from}$`));
		const id = runIdOf(r.out);
		const rec = testRuns(w.ledger.entries(train)).find((x) => x.request.runId === id)!;
		// testRuns parsed the green's body: a carried green is a shape parseTestRun accepts.
		const res = rec.result!;
		expect(res).toMatchObject({ verdict: "green", sha: head, reason: `carried from ${from} at ${fromSha} (decision-log only)`, headAtEnd: null, full: { pass: 7, fail: 0, skip: 0 } });
		const slice = w.ledger.slice(rec.request.slice)!;
		expect(slice.state).toBe("done");
		expect(slice.artifact).toContain(`test-run ${id}: green at ${head} on PR #${P}`);
		expect(slice.artifact).toEndWith(`; carried from ${from} at ${fromSha} (decision-log only)`);
		expect(existsSync(join(w.runs, id))).toBe(false);
		return res;
	}
	/** A start that falls through to a run: a runner is spawned, and its run ends stale (the head is not the PR's ref). */
	async function ran(w: World, train: string, extra: string[] = []): Promise<void> {
		const r = start(w, train, P, extra);
		expect(r.err).toBe("");
		expect(r.code).toBe(START_EXIT.ok);
		expect(r.out).toMatch(/^test-run tr-[a-z0-9]+ runner \d+ sha [0-9a-f]{40} slice sl-\S+ log \/\S+( bound-by in-[a-z0-9]+)?$/);
		expect((await resultOf(w, train, runIdOf(r.out))).verdict).toBe("stale");
	}

	test("a green at S and one decision-log commit to H: a green at H, success posted on H, no runner; again at H carries from that green (identical, no compare)", () => {
		const H = fx.main;
		const { w, train } = trainWorld(H);
		const R = seed(w, train, S, "green", 5000);
		compare(w, S, H, [{ sha: "6".repeat(40), files: [LOG] }]);
		const c = carried(w, train, R, S, H);
		expect(statusPosts(w)).toEqual([`success ${H}`]);
		expect(readFileSync(join(w.root, "gh.log"), "utf8")).toContain(`-f description=carried from run ${R} at ${S.slice(0, 7)} (decision-log only)`);
		const calls = readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n").length;
		carried(w, train, c.runId, H, H);
		const after = readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n").slice(calls);
		expect(after.filter((l) => l.includes("/compare/"))).toEqual([]);
		expect(statusPosts(w)).toEqual([`success ${H}`, `success ${H}`]);
	});

	for (const source of ["full", "fast", "fast copied", "tree", "tree decision-log"] as const) {
		test(`off-mode decision-log carry accepts only genuine full Mac authority, not ${source} copied counts`, async () => {
			const { w, train } = trainWorld(fx.main);
			const id = seed(w, train, S, "pending", 5000);
			finish(w, train, id, S, "green", 4000, { scope: source === "fast" ? "fast" : "full", host: "mac" });
			const rec = testRuns(w.ledger.entries(train)).find((r) => r.request.runId === id)!;
			w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: train, kind: "assumption", body: fastPlanBody(id,
				source.startsWith("tree") ? { ref: `wl/${train}`, scope: "tree", g: S, run: "tr-mainseed" }
					: source.startsWith("fast") ? { ref: `wl/${train}`, scope: "fast", files: [], parse: [], macOnly: [] }
						: { ref: `wl/${train}`, scope: "full", reasons: ["production"] }) });
			if (source === "tree decision-log") {
				const next = request(w, train, rec.request.slice, P, S, 1000);
				w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: train, sliceId: rec.request.slice, kind: "assumption", body: testRunBody({
					...rec.result!, runId: next, scope: "full", host: "mac", reason: `carried from ${id} at ${S} (decision-log only)`,
				}) });
			}
			compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
			if (source === "full") {
				carried(w, train, id, S, fx.main);
				expect(statusPosts(w)).toEqual([`success ${fx.main}`]);
				expect(readFileSync(join(w.root, "gh.log"), "utf8")).toContain(`description=carried from run ${id}`);
			} else {
				await ran(w, train);
				expect(statusPosts(w)).toEqual([]);
			}
		});
	}

	test("an off-admitted decision-log carry rechecks activation under publication after an off/on transition", async () => {
		const { w, train } = trainWorld(fx.main);
		seed(w, train, S, "green", 5000);
		compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
		arm(w, train, "gate-publication");
		const child = Bun.spawn([process.execPath, RUNNER, "start", train, String(P), "--requested-by", LANE], { env: w.env, stdout: "pipe", stderr: "pipe" });
		try {
			await reached(w, train, "gate-publication");
			landFirst(w.ledger, OWNER_REPO, true);
			// Main cannot be read in this world: on-mode publication must fail closed, never post the off-mode carry success.
		} finally { go(w, train, "gate-publication"); }
		expect(await child.exited).toBe(START_EXIT.ok);
		expect(statusPosts(w)).toEqual([`failure ${fx.main}`]);
	});

	test("a commit touching another path, and a merge commit touching only .ai/decision-log/, each fall through to a run", async () => {
		for (const commits of [[{ sha: "6".repeat(40), files: [LOG] }, { sha: "7".repeat(40), files: [LOG, "surface/src/x.ts"] }], [{ sha: "8".repeat(40), parents: 2, files: [LOG] }]]) {
			const { w, train } = trainWorld(fx.main);
			seed(w, train, S, "green", 5000);
			compare(w, S, fx.main, commits);
			await ran(w, train);
			expect(statusPosts(w)).toEqual([]);
		}
	});

	test("the #305 fixture: a green at aebe37a4 and GitHub's saved answers for cde03460 carry", () => {
		const c305 = carry305(OWNER_REPO);
		const { w, train } = trainWorld(c305.head);
		const R = seed(w, train, c305.green, "green", 5000);
		for (const [path, json] of Object.entries(c305.answers)) saveApi(w, path, json);
		carried(w, train, R, c305.green, c305.head);
		expect(statusPosts(w)).toEqual([`success ${c305.head}`]);
	});

	test("a newer red, a newer error, and a still-pending request after the green each block the carry", async () => {
		for (const newer of ["red", "error", "pending"] as const) {
			const { w, train, owner } = trainWorld(fx.main);
			seed(w, train, S, "green", 10_000);
			compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
			// on the owner, so a pending request does not hold the train's reservation
			seed(w, owner, S, newer, 5000);
			await ran(w, train);
		}
	});

	test("reversed completion: an older request finishing green after a newer one finished red does not carry", async () => {
		const { w, train, owner } = trainWorld(fx.main);
		compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
		const older = seed(w, train, S, "pending", 20_000);
		seed(w, owner, S, "red", 15_000);
		finish(w, train, older, S, "green", 5000);
		await ran(w, train);
	});

	test("a green on a closed fix workload carries while the closed owner's older result is red", () => {
		const { w, train, owner, entry } = trainWorld(fx.main);
		seed(w, owner, S, "red", 20_000);
		const fix = fixOf(w, train, entry);
		const R = seed(w, fix, S, "green", 10_000);
		compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
		for (const wl of [owner, fix]) {
			for (const s of w.ledger.slices(wl)) w.ledger.cancelSlice(s.id, { by: LANE });
			w.ledger.closeWorkload(wl, { by: SURFACE_BY });
		}
		carried(w, train, R, S, fx.main);
	});

	test("equal created_at stamps pick the later-inserted request, within one workload and across the train, owner and fix workloads", async () => {
		const at = new Date(Date.now() - 60_000).toISOString();
		const pinned = (w: World, wl: string, verdict: "green" | "red") => w.pin(at, () => seed(w, wl, S, verdict));
		for (const [first, second] of [["train", "train"], ["owner", "fix"], ["fix", "train"], ["train", "owner"]] as const) {
			for (const order of [["red", "green"], ["green", "red"]] as const) {
				const t = trainWorld(fx.main);
				const wls = { train: t.train, owner: t.owner, fix: fixOf(t.w, t.train, t.entry) };
				compare(t.w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
				pinned(t.w, wls[first], order[0]);
				const later = pinned(t.w, wls[second], order[1]);
				if (order[1] === "green") carried(t.w, t.train, later, S, fx.main);
				else await ran(t.w, t.train);
			}
		}
	});

	test("a source change between D4b and D4c falls through to the run", async () => {
		const { w, train, entry } = trainWorld(fx.main);
		seed(w, train, S, "green", 10_000);
		compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
		const fix = fixOf(w, train, entry);
		arm(w, train, "carry-evidence");
		const p = Bun.spawn([process.execPath, RUNNER, "start", train, String(P), "--requested-by", LANE], { env: w.env, stdout: "pipe", stderr: "pipe" });
		await reached(w, train, "carry-evidence");
		// a newer green at another sha on a fix workload: a different authority than the one compared
		seed(w, fix, "9".repeat(40), "green");
		go(w, train, "carry-evidence");
		const [code, out] = [await p.exited, (await new Response(p.stdout).text()).trim()];
		expect(code).toBe(START_EXIT.ok);
		expect(out).toMatch(/ runner \d+ /);
		expect(out).not.toContain(" carried ");
		expect(marks(w, train, "carry-open")).toHaveLength(1);
		expect(marks(w, train, "carry-written")).toEqual([]);
		expect((await resultOf(w, train, runIdOf(out))).verdict).toBe("stale");
	});

	test("the fake gh records no call while the carry transaction is open", async () => {
		const { w, train } = trainWorld(fx.main);
		const R = seed(w, train, S, "green", 5000);
		compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
		const calls = () => readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n").length;
		arm(w, train, "carry-open");
		arm(w, train, "carry-written");
		const p = Bun.spawn([process.execPath, RUNNER, "start", train, String(P), "--requested-by", LANE], { env: w.env, stdout: "pipe", stderr: "pipe" });
		await reached(w, train, "carry-open");
		const open = calls();
		go(w, train, "carry-open");
		await reached(w, train, "carry-written");
		expect(calls()).toBe(open);
		go(w, train, "carry-written");
		expect(await p.exited).toBe(START_EXIT.ok);
		expect((await new Response(p.stdout).text()).trim()).toEndWith(` carried ${R}`);
		expect(calls()).toBe(open + 1);
		expect(statusPosts(w)).toEqual([`success ${fx.main}`]);
	});

	test("a failed status post keeps the carried green; a second request at the same H on a new slice posts again with no run", () => {
		const { w, train } = trainWorld(fx.main);
		const R = seed(w, train, S, "green", 5000);
		compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
		writeFileSync(join(w.root, "status-fails"), "");
		const r = start(w, train, P);
		expect(r.code).toBe(START_EXIT.ok);
		expect(r.out).toEndWith(` carried ${R}`);
		expect(r.err).toContain(`status as2/full-suite success on ${fx.main} not posted: gh: Validation Failed (HTTP 422)`);
		const first = testRuns(w.ledger.entries(train)).find((x) => x.request.runId === runIdOf(r.out))!.result!;
		expect(first).toMatchObject({ verdict: "green", sha: fx.main });
		rmSync(join(w.root, "status-fails"));
		w.ledger.addSlice({ by: LANE, workloadId: train, id: "sl-repost", task: "the suite again", doneCondition: "a green", inputs: "the PR" });
		carried(w, train, first.runId, fx.main, fx.main, ["--slice", "sl-repost"]);
		expect(statusPosts(w)).toEqual([`success ${fx.main}`, `success ${fx.main}`]);
	});

	test("a non-train request at such a head still spawns a run", async () => {
		const w = world();
		const { wl } = workload(w);
		setPr(w, P, { sha: fx.main, headRefName: `wl/${wl}` });
		seed(w, wl, S, "green", 5000);
		compare(w, S, fx.main, [{ sha: "6".repeat(40), files: [LOG] }]);
		await ran(w, wl);
		expect(readFileSync(join(w.root, "gh.log"), "utf8")).not.toContain("/compare/");
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
	test("green: start prints its line, the run settles the slice it added; the changed file the full part ran gets no solo part; the bundle clone has history and the trusted-main tag; no smudge filter ran; a sweep after each part; no message", async () => {
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
		// PLAN wl-mvq4edh02r5z40 D1: the full part ran a test of the changed a.test.ts, so it does not run alone.
		expect(run.solo).toEqual([]);
		expect(subsOf(w, runId!)).not.toContain("solo");
		expect(runnerLog(w, runId!)).toContain("solo parts: none");
		expect(run.preflight).toContain("probe:");
		await until("the settle", () => w.ledger.slice(slice!)?.state === "done");
		expect(w.ledger.slice(slice!)!.artifact).toBe(`test-run ${runId}: green at ${fx.head.green} on PR #${PR.green}; full 2/0/0; alone: none; ${join(w.runs, runId!)}`);
		// The ledger settles before result.json is published and the run lock is released.
		await until(`runner ${pid} gone`, () => !alive(Number(pid)));
		expect(JSON.parse(readFileSync(join(w.runs, runId!, "result.json"), "utf8"))).toMatchObject({ runId, verdict: "green", sha: fx.head.green });
		for (const f of ["full.xml", "full.log"]) expect(existsSync(join(w.runs, runId!, f))).toBe(true);
		expect(heldMessages(w, wl)).toEqual([]);

		expect(existsSync(join(w.root, "SMUDGED"))).toBe(false);
		expect(marks(w, runId!, "sweep").map((x) => x.after)).toEqual(["publish", "full"]);

		// The handoff: `_as2test`'s clone from the bundle is a real repository.
		const clone = join(workDirOf(runId!, w.as2), "repo");
		expect(g(clone, "rev-parse", "HEAD")).toBe(fx.head.green);
		expect(g(clone, "log", "--format=%H").split("\n")).toEqual([fx.head.green, fx.main, fx.control]);
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
		// A red PR, so a solo part and base's parts run too.
		const runId = request(w, wl, slice, PR.red, fx.head.red);
		await spawnRun(w, runId).exited;
		expect((await resultOf(w, wl, runId)).verdict).toBe("red");
		const calls = readFileSync(join(w.root, "sudo-cwd.log"), "utf8").trim().split("\n").map((l) => l.split(" ")).filter(([, id]) => id === runId);
		expect(calls.map(([sub]) => sub).filter((s, i, all) => all.indexOf(s) === i).sort()).toEqual(["base-prepare", "base-solo", "full", "prepare", "probe", "solo", "sweep"]);
		for (const [sub, , cwd] of calls) expect({ sub, cwd }).toEqual({ sub, cwd: w.as2 });
	});

	test("a changed test file whose name begins with a space keeps it: the solo part runs `./ a.test.ts`, not its sibling `./a.test.ts` in its place", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.space, fx.head.space);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		// ` a.test.ts` only skips, so it alone runs alone: its one skipped case, never its passing sibling's case.
		expect(run.solo).toEqual([expect.objectContaining({ file: "./ a.test.ts", pass: 0, fail: 0, skip: 1, error: null })]);
		expect(run.verdict).toBe("green");
	});

	test("PLAN wl-mvq4edh02r5z40 D1: all-pass with a changed file whose cases all skip runs that file alone, by its exact ./ path", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.skipped, fx.head.skipped);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.full).toMatchObject({ pass: 1, fail: 0, skip: 1, exit: 0, error: null });
		// `./a.test.ts` alone runs a.test.ts only: xa.test.ts, which `a.test.ts` as a substring would also match, is not in it.
		expect(run.solo).toEqual([expect.objectContaining({ file: "./a.test.ts", pass: 0, fail: 0, skip: 1, exit: 0, error: null })]);
		expect(subsOf(w, runId).filter((s) => s === "solo")).toHaveLength(1);
		expect(run.verdict).toBe("green");
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full", "./a.test.ts"]);
	});

	test("fullWorkers (wl-mvg2kzuvwngdmo): runner.log carries `full workers <n>` after the lock and before the PR full part; absent, n is 1", async () => {
		for (const [workers, n] of [[3, 3], [undefined, 1]] as const) {
			const w = world({ fullWorkers: workers });
			const { wl, slice } = workload(w);
			const runId = request(w, wl, slice, PR.green, fx.head.green);
			await spawnRun(w, runId).exited;
			const run = await resultOf(w, wl, runId);
			expect(run.verdict).toBe("green");
			expect(run.full).toMatchObject({ pass: 2, fail: 0, exit: 0, error: null });
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

	test("fix round 1 (F4), PLAN wl-mvq4edh02r5z40 D1: a run failing a gates/test/ test is red with no rerun of it, and while a lane holds the workload under a live lease sends exactly one security-red: and no test-run-failed:", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		w.ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 600_000 });
		expect(w.ledger.liveLaneHolders().some((h) => h.workloadId === wl)).toBe(true);
		const runId = request(w, wl, slice, PR.gate, fx.head.gate);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("red");
		// a security failure is never rerun, on the PR or on base
		expect(run.failures.map((f) => [f.part, f.name])).toEqual([["full", "gates/test/gate.test.ts > refuses a forged approve"]]);
		expect(run.solo).toEqual([]);
		expect(subsOf(w, runId).filter((s) => s === "solo" || s.startsWith("base-"))).toEqual([]);
		expect(heldMessages(w, wl)).toEqual([{
			body: `security-red: ${wl} ${slice} ${runId} ${fx.head.gate} 1 gates/test/gate.test.ts > refuses a forged approve`, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, state: "held",
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

	// PLAN wl-mvq4edh02r5z40 tradeoff 1 (Jo's (2)): coverage only guarantees the file ran, so a failure only alone goes unseen.
	test("PLAN wl-mvq4edh02r5z40 D1: an all-pass full part that ran the changed _spec.ts file runs no solo part, so a failure only alone is not run", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.solo, fx.head.solo);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.full).toMatchObject({ pass: 2, fail: 0, exit: 0, error: null });
		expect(run.solo).toEqual([]);
		expect(subsOf(w, runId)).not.toContain("solo");
		expect(run.verdict).toBe("green");
		expect(run.failures).toEqual([]);
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
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full"]);
	});

	/** The wrapper calls of a run that are a solo part or anything on base. */
	const soloOrBase = (w: World, runId: string) => subsOf(w, runId).filter((s) => s === "solo" || s.startsWith("base-"));

	test("PLAN wl-mvq4edh02r5z40 D0/D1: a full part past its cap ends the run: no solo or base part, its sweep and the head re-check still run, error naming the timeout, the stuck capture imported", async () => {
		const w = world({ capMin: 0.05 });
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.hang, fx.head.hang);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "error", reason: "full: timeout", headAtEnd: fx.head.hang });
		expect(run.full).toMatchObject({ exit: WRAPPER_EXIT.timeout, error: "timeout" });
		expect(run.solo).toEqual([]);
		expect(soloOrBase(w, runId)).toEqual([]);
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full"]);
		const log = runnerLog(w, runId);
		expect(log).toContain("full part timed out: no solo or base parts");
		expect(log).toContain("full.stuck.log imported");
		expect(readFileSync(join(w.runs, runId, "full.stuck.log"), "utf8").length).toBeGreaterThan(0);
		const pid = Number(readFileSync(join(workDirOf(runId, w.as2), "repo", "hang.pid"), "utf8"));
		expect(alive(pid)).toBe(false);
		expect(w.ledger.slice(slice)!.state).toBe("open");
	}, 120_000);

	test("PLAN wl-mvq4edh02r5z40 D0: a full part past its cap whose log import is refused (over the report cap) is still a timeout: no solo or base part", async () => {
		const w = world({ capMin: 0.05 });
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.loud, fx.head.loud);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("error");
		expect(run.reason).toStartWith("full: timeout; report import refused: full.log is over the");
		expect(run.full!.error).toStartWith("timeout; report import refused: full.log is over the");
		expect(run.solo).toEqual([]);
		expect(soloOrBase(w, runId)).toEqual([]);
		expect(runnerLog(w, runId)).toContain("full part timed out: no solo or base parts");
	}, 120_000);

	test("PLAN wl-mvq4edh02r5z40 D0: the outlive sweep firing on the full part's call is a timeout whatever the wrapper's later exit: no solo or base part, error naming the timeout", async () => {
		const w = world({ capMin: 0.05 });
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.hang, fx.head.hang);
		// The test knob: the runner sweeps 1 ms past the cap, before the wrapper's own cap path has ended the part.
		await spawnRun(w, runId, { AGENT_SYSTEM_TEST_RUNNER_OUTLIVE_MS: "1" }).exited;
		const run = await resultOf(w, wl, runId);
		const log = runnerLog(w, runId);
		expect(log).toContain("full outlived its cap by 0.001 s; sweeping");
		expect(log).toMatch(/ full tr-[a-z0-9]+ → (exit \d+|SIG[A-Z]+) \(after the outlive sweep\)/);
		expect(log).toContain("full part timed out: no solo or base parts");
		expect(run.verdict).toBe("error");
		expect(run.reason).toStartWith("full: timeout");
		expect(run.solo).toEqual([]);
		expect(soloOrBase(w, runId)).toEqual([]);
	}, 120_000);

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

// ---- red main: failing files rerun alone on base (PLAN wl-mv8s8srodefytc rev 17.1 D8, PLAN wl-mvq4edh02r5z40 D3) ---------

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
 * The world's GitHub with a red main: main gains `mainFiles` (broken.test.ts, one failing test, by default), then each PR is one
 * commit on that main at refs/pull/<N>/head, its files written over main's.
 */
function redMain(w: World, prs: Record<number, Record<string, string>>, mainFiles: Record<string, string> = { "broken.test.ts": BROKEN }): { main: string; head: Record<number, string> } {
	const work = join(w.root, "red-main");
	g(w.root, "clone", "-q", w.origin, work);
	for (const [f, text] of Object.entries(mainFiles)) {
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
const cachePath = (w: World, sha: string, part: string): string => join(w.runs, "base-cache", sha, `${encodeURIComponent(part)}.json`);
const cached = (w: World, sha: string, part: string): boolean => existsSync(cachePath(w, sha, part));

describe("red main: each failing file rerun alone on base (PLAN wl-mv8s8srodefytc rev 17.1 D8, PLAN wl-mvq4edh02r5z40 D3)", () => {
	test("red: only the failing file runs alone; base runs that file alone (never the full suite) and fails the same: red-main, settled, status success, no message; base's result is cached and a second PR reuses it; a `full` cache entry is never read", async () => {
		const w = world();
		const r = redMain(w, { 22: { "broken.test.ts": BROKEN + TOUCHED, "ok.test.ts": PASS("ok") }, 23: { "broken.test.ts": `${BROKEN}// again\n` } });
		// What an older runner cached for base's full suite: never read again.
		const seeded = JSON.stringify({ pass: 0, fail: 0, skip: 0, exit: 0, ms: 1, error: null, failures: [] });
		mkdirSync(dirname(cachePath(w, r.main, "full")), { recursive: true });
		writeFileSync(cachePath(w, r.main, "full"), seeded);

		const one = workload(w);
		const first = request(w, one.wl, one.slice, 22, r.head[22]!);
		await spawnRun(w, first).exited;
		const run = await resultOf(w, one.wl, first);
		expect(run).toMatchObject({ verdict: "red-main", base: r.main });
		expect(run.full).toMatchObject({ fail: 1, error: null });
		// the changed ok.test.ts passed in the full part: it does not run alone
		expect(run.solo).toEqual([expect.objectContaining({ file: "./broken.test.ts", fail: 1, error: null })]);
		expect(subsOf(w, first).filter((s) => s === "solo")).toHaveLength(1);
		expect(subsOf(w, first)).toEqual(expect.arrayContaining(["base-prepare", "base-solo"]));
		expect(subsOf(w, first)).not.toContain("base-full");
		expect(run.baseCompare).toEqual({ sha: r.main, parts: [{ part: "./broken.test.ts", failing: ["broken.test.ts > main is red"], baseFailing: ["broken.test.ts > main is red"], baseError: null }] });
		expect(cached(w, r.main, "./broken.test.ts")).toBe(true);
		expect(readFileSync(cachePath(w, r.main, "full"), "utf8")).toBe(seeded);
		expect(runnerLog(w, first)).not.toContain("base full");
		await until("the settle", () => w.ledger.slice(one.slice)?.state === "done");
		expect(w.ledger.slice(one.slice)!.artifact).toStartWith(`test-run ${first}: red-main at ${r.head[22]} on PR #22;`);
		expect(w.ledger.slice(one.slice)!.artifact).toContain(r.main);
		expect(statusPosts(w)).toEqual([`success ${r.head[22]}`]);
		expect(heldMessages(w, one.wl)).toEqual([]);

		// PR #23 fails the same test: base's solo result of that file comes from the cache, so nothing runs on base
		const two = workload(w);
		const second = request(w, two.wl, two.slice, 23, r.head[23]!);
		await spawnRun(w, second).exited;
		const run2 = await resultOf(w, two.wl, second);
		expect(run2.verdict).toBe("red-main");
		expect(run2.baseCompare!.parts).toEqual([{ part: "./broken.test.ts", failing: ["broken.test.ts > main is red"], baseFailing: ["broken.test.ts > main is red"], baseError: null }]);
		expect(runnerLog(w, second)).toContain(`base ./broken.test.ts at ${r.main}: cached`);
		expect(subsOf(w, second).filter((s) => s.startsWith("base-"))).toEqual([]);
		expect(statusPosts(w)).toEqual([`success ${r.head[22]}`, `success ${r.head[23]}`]);
	});

	test("red when the failing file passes alone: the full failure stays in the entry, the reason names the file, and nothing runs on base", async () => {
		const w = world();
		const r = redMain(w, { 25: { "alone_a.test.ts": ALONE + TOUCHED, "alone_b.test.ts": ALONE + TOUCHED } }, { "alone_a.test.ts": ALONE, "alone_b.test.ts": ALONE });
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, 25, r.head[25]!);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("red");
		expect(run.full).toMatchObject({ fail: 1, error: null });
		const failing = run.failures.filter((f) => f.part === "full");
		expect(failing).toHaveLength(1);
		const file = failing[0]!.name.split(" > ")[0]!;
		expect(failing[0]!.name).toBe(`${file} > passes alone`);
		// only the failing file of the pair runs alone, and passes
		expect(run.solo).toEqual([expect.objectContaining({ file: `./${file}`, pass: 1, fail: 0, error: null })]);
		expect(run.failures).toEqual(failing);
		expect(run.reason).toBe(`failing in the full part; passed alone: ./${file}`);
		expect(subsOf(w, runId).filter((s) => s === "solo")).toHaveLength(1);
		expect(subsOf(w, runId).filter((s) => s.startsWith("base-"))).toEqual([]);
		expect(run.baseCompare ?? null).toBeNull();
		expect(w.ledger.slice(slice)!.state).toBe("open");
		expect(statusPosts(w)).toEqual([`failure ${r.head[25]}`]);
	});

	test("fix round 1 (F4), PLAN wl-mvq4edh02r5z40 D3: a gates/test/ test that fails on base too is red, never red-main: not rerun on the PR or on base, and exactly one security-red: (no test-run-failed:)", async () => {
		const w = world();
		const gate = "gates/test/gate.test.ts";
		const r = redMain(w, { 23: { [gate]: GATE_RED + TOUCHED } }, { [gate]: GATE_RED });
		const { wl, slice } = workload(w);
		w.ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 600_000 });
		const runId = request(w, wl, slice, 23, r.head[23]!);
		await spawnRun(w, runId).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "red", base: r.main });
		expect(run.failures.map((f) => [f.part, f.name])).toEqual([["full", `${gate} > refuses a forged approve`]]);
		expect(subsOf(w, runId).filter((s) => s === "solo" || s.startsWith("base-"))).toEqual([]);
		expect(heldMessages(w, wl)).toEqual([{
			body: `security-red: ${wl} ${slice} ${runId} ${r.head[23]} 1 ${gate} > refuses a forged approve`, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, state: "held",
		}]);
	});

	test("a base-prepare that fails gives red and caches nothing; a failure base's solo run lacks gives red; neither posts success", async () => {
		const w = world();
		// The PR's own test plants runs/<id>/base, so base cannot be prepared beside its clone.
		const PLANT = `import { test } from "bun:test";\nimport { mkdirSync } from "node:fs";\ntest("main is red", () => { throw new Error("broken on main"); });\ntest("passes", () => { mkdirSync("../base", { recursive: true }); });\n`;
		const NEW_RED = `${BROKEN}test("new failure", () => { throw new Error("the PR broke it"); });\n`;
		const r = redMain(w, { 23: { "broken.test.ts": NEW_RED }, 24: { "broken.test.ts": PLANT } });

		const one = workload(w);
		const first = request(w, one.wl, one.slice, 24, r.head[24]!);
		await spawnRun(w, first).exited;
		const run = await resultOf(w, one.wl, first);
		expect(run.verdict).toBe("red");
		expect(runnerLog(w, first)).toContain("base-prepare failed");
		expect(run.baseCompare!.parts).toEqual([{ part: "./broken.test.ts", failing: ["broken.test.ts > main is red"], baseFailing: null, baseError: "not run on base" }]);
		expect(cached(w, r.main, "./broken.test.ts")).toBe(false);
		expect(w.ledger.slice(one.slice)!.state).toBe("open");

		const two = workload(w);
		const second = request(w, two.wl, two.slice, 23, r.head[23]!);
		await spawnRun(w, second).exited;
		const run2 = await resultOf(w, two.wl, second);
		expect(run2.verdict).toBe("red");
		const part = run2.baseCompare!.parts[0]!;
		expect(part).toMatchObject({ part: "./broken.test.ts", baseError: null });
		expect(part.failing).toEqual(["broken.test.ts > main is red", "broken.test.ts > new failure"]);
		expect(part.baseFailing).toEqual(["broken.test.ts > main is red"]);
		expect(cached(w, r.main, "./broken.test.ts")).toBe(true);
		expect(w.ledger.slice(two.slice)!.state).toBe("open");
		expect(statusPosts(w)).toEqual([`failure ${r.head[24]}`, `failure ${r.head[23]}`]);
	});

	test("base reruns longer than the finalize deadline still settle red-main: the post-sweep deadline starts after base runs", async () => {
		const w = world();
		const r = redMain(w, { 25: { "broken.test.ts": BROKEN + TOUCHED } });
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
			expect(run.baseCompare!.parts.map((p) => p.part)).toEqual(["./broken.test.ts"]);
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

	test("T2a: the helper exits 71; the reason names exit 71's causes, the resource policy first, with the helper's last stderr line", async () => {
		const w = world();
		setRefresh(w, `echo "as2test-refresh: ${join(w.libexec, "resources.json")}, the measured resource policy the executor requires, is missing" >&2\nexit 71`);
		writeSource(w.libexec, { inputSha: "f".repeat(64) });
		const { run } = await runGreen(w);
		expect(run.verdict).toBe("error");
		expect(run.reason).toBe(
			`preflight: bundle-refresh-failed: the refresh helper build (exit 71: ${join(w.libexec, "resources.json")} missing or unusable, or the build, a check of its output, a signal or the helper's cap stopped it): as2test-refresh: ${join(w.libexec, "resources.json")}, the measured resource policy the executor requires, is missing`,
		);
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
			`preflight: checkout-drift: surface/scripts/test-exec.ts in the runner's checkout ${REPO} (HEAD ${head12}) differs from the bundle, which is built from the commit refs/tags/as2-verified names, ${OLD12}; bring the checkout to that commit`,
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
		// B retried its sweep once, got the lock only after A's sweep ended, and its preflight and full part ran unharmed after that
		// (green, so no solo part: PLAN wl-mvq4edh02r5z40 D1).
		expect(marks(w, B, "sweep").map((m) => [m.after, m.attempt])).toEqual([["publish", 0], ["publish", 1], ["full", 0]]);
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

// D4 coverage: admission and actual hosted/Mac transitions use the existing process world;
// retention and reaping exercise exported state policies without launching another runner.
describe("land-first runner D4 (R11, R12, R15, R16, R37)", () => {
	const api = (w: World, path: string, value: unknown, post = false) => {
		const dir = join(w.root, post ? "post" : "api");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `repos_${OWNER_REPO.replaceAll("/", "_")}_${path.replaceAll("/", "_")}`), JSON.stringify(value));
	};
	function landWorld(o: Parameters<typeof world>[0] = {}): World {
		const w = world(o);
		landFirst(w.ledger, OWNER_REPO, true);
		mainRun(w.ledger, "tr-mainseed", fx.main, "green");
		verifiedWorld(w, fx.main);
		api(w, "git/ref/heads/main", { object: { sha: fx.main } });
		api(w, `git/commits/${fx.main}`, {
			sha: fx.main, tree: { sha: g(w.origin, "rev-parse", `${fx.main}^{tree}`) },
			committer: { date: new Date().toISOString() }, parents: [],
		});
		api(w, `commits/${fx.main}/pulls`, []);
		api(w, "git/ref/tags/as2-verified", { object: { type: "commit", sha: fx.main } });
		api(w, "actions/workflows/as2-fast.yml/dispatches", { workflow_run_id: 71 }, true);
		api(w, "actions/runs/71", { head_sha: fx.main, status: "completed" });
		w.env.AGENT_SYSTEM_TEST_RUNNER_FAST_WAIT_MS = "50";
		w.env.AGENT_SYSTEM_TEST_RUNNER_FAST_POLL_MS = "10";
		return w;
	}
	function bind(w: World, pr: number, sha: string) {
		const owner = workload(w);
		setPr(w, pr, { sha, headRefName: `wl/${owner.wl}` });
		api(w, `compare/${fx.main}...${sha}`, { status: "ahead" });
		return owner;
	}
	function suspectMain(w: World, date = new Date().toISOString()): void {
		api(w, "git/ref/heads/main", { object: { sha: fx.head.red } });
		api(w, `git/commits/${fx.head.red}`, {
			sha: fx.head.red, tree: { sha: g(w.origin, "rev-parse", `${fx.head.red}^{tree}`) },
			committer: { date }, parents: [{ sha: fx.main }],
		});
		api(w, `commits/${fx.head.red}/pulls`, [{ number: PR.red }]);
		api(w, `compare/${fx.head.red}...${fx.head.green}`, { status: "ahead" });
	}
	function artifact(w: World, sha: string, mode: "green" | "red" | "missing"): void {
		const dir = join(w.root, "artifact");
		mkdirSync(dir);
		const child = mode === "red" ? '<failure message="hosted failure">hosted failure</failure>' : mode === "missing" ? "<skipped/>" : "";
		writeFileSync(join(dir, "fast.xml"), `<testsuites tests="1" failures="${mode === "red" ? 1 : 0}" skipped="${mode === "missing" ? 1 : 0}"><testsuite name="a.test.ts"><testcase classname="a.test.ts" name="hosted" time="0.01">${child}</testcase></testsuite></testsuites>`);
		writeFileSync(join(dir, "fast.log"), "hosted fixture output\n");
		writeFileSync(join(dir, "fast.summary"), `request @REQ@ sha ${sha} files 1 exit ${mode === "red" ? 1 : 0} wall 1 s\n`);
	}
	const calls = (w: World) => readFileSync(join(w.root, "gh.log"), "utf8").trim().split("\n");
	const dispatches = (w: World) => calls(w).filter((s) => s.includes("/dispatches"));
	const preflights = (w: World) => w.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("runner-preflight:"));
	const runIdOf = (s: { code: number; out: string; err: string }) => {
		expect(s).toMatchObject({ code: START_EXIT.ok });
		const id = /^test-run (tr-[a-z0-9]+) /.exec(s.out)?.[1];
		if (!id) throw new Error(`start did not return a run id: ${JSON.stringify(s)}`);
		return id;
	};
	async function finalized(w: World, wl: string, id: string): Promise<TestRun> {
		const r = await resultOf(w, wl, id);
		await until("the final gate post", () => calls(w).some((s) => s.includes(`/statuses/${r.sha}`) && /state=(success|failure)/.test(s)));
		return r;
	}

	// Review F3: incident designation drives both admission and publication, not an arbitrary revert-shaped branch.
	for (const repair of ["partial revert", "named fix", "tree revert", "unrelated revert"] as const) {
		test(`${repair}: stopped-main admission and publication preserve the repair's required scope`, async () => {
			const w = landWorld();
			mainRun(w.ledger, "tr-regression", fx.head.red, "red");
			g(w.origin, "update-ref", "refs/heads/main", fx.head.red);
			api(w, "git/ref/heads/main", { object: { sha: fx.head.red } });
			api(w, `git/commits/${fx.head.red}`, {
				sha: fx.head.red, tree: { sha: g(w.origin, "rev-parse", `${fx.head.red}^{tree}`) },
				committer: { date: new Date().toISOString() }, parents: [{ sha: fx.main }],
			});
			api(w, `commits/${fx.head.red}/pulls`, [{ number: PR.red }]);
			for (const event of [
				{ event: "stop-raised" as const, kind: "regression" as const, tip: fx.head.red, g: fx.main, suspects: [PR.red], failing: 1 },
				{ event: "stop-filed" as const, url: `https://github.com/${OWNER_REPO}/issues/91` },
			]) w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstNoticeBody(OWNER_REPO, event) });
			writeFileSync(join(w.root, "incident.json"), JSON.stringify({ body: repair === "named fix" ? "fix #1" : "repair incident", comments: [] }));
			const tree = g(w.origin, "rev-parse", `${repair === "tree revert" ? fx.main : fx.head.green}^{tree}`);
			const head = g(w.origin, "commit-tree", tree, "-p", fx.head.red, "-m", repair);
			g(w.origin, "update-ref", `refs/pull/${PR.green}/head`, head);
			const { wl, slice } = bind(w, PR.green, head);
			const ref = repair === "named fix" ? `wl/${wl}` : `train/revert-${(repair === "unrelated revert" ? fx.main : fx.head.red).slice(0, 7)}`;
			setPr(w, PR.green, { sha: head, headRefName: ref });
			w.ledger.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 600_000 });
			w.ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: pushDestBody({ remote: "origin", branch: ref, sha: head }) });
			api(w, `compare/${fx.head.red}...${head}`, { status: "ahead" });
			api(w, `git/commits/${head}`, { tree: { sha: tree } });
			if (repair === "unrelated revert") artifact(w, head, "green");
			if (repair === "named fix") {
				// A previously fast-green head on a train must actually run the newly required full repair scope.
				joTrains(w, wl, [PR.green]);
				const prior = request(w, wl, slice, PR.green, head, 1000);
				const q = testRuns(w.ledger.entries(wl)).find((r) => r.request.runId === prior)!.request;
				w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRunBody({
					...runnerDiedRun(q, null), verdict: "green", reason: null, headAtEnd: head, scope: "fast", host: "linux",
					full: { pass: 1, fail: 0, skip: 0, exit: 0, ms: 1, error: null },
				}) });
			}
			const id = runIdOf(start(w, wl, PR.green, ["--slice", slice]));
			const result = await finalized(w, wl, id);
			expect(result.verdict).toBe("green");
			if (repair === "tree revert") {
				expect(fastPlanOf(w.ledger.entries(wl), id)?.scope).toBe("tree");
				expect(marks(w, id, "acquired")).toEqual([]);
				expect(statusPosts(w).at(-1)).toBe(`success ${head}`);
				expect(calls(w).at(-1)).toContain("description=repair: revert to G's tree");
			} else if (repair === "unrelated revert") {
				expect(result.scope).toBe("fast");
				expect(statusPosts(w).at(-1)).toBe(`failure ${head}`);
				expect(calls(w).at(-1)).toContain("not the incident's repair");
			} else {
				expect(fastPlanOf(w.ledger.entries(wl), id)?.scope).toBe("full");
				expect(result).toMatchObject({ scope: "full", host: "mac", full: { pass: 2, fail: 0 } });
				expect(subsOf(w, id)).toContain("full");
				expect(dispatches(w)).toEqual([]);
				expect(statusPosts(w).at(-1)).toBe(`success ${head}`);
				expect(calls(w).at(-1)).toContain(`description=repair: ${repair === "named fix" ? "fix" : "partial revert"}, full suite green`);
			}
		});
	}

	for (const stop of ["stopped", "behind"] as const) {
		test(`a full PR admitted before activation takes the live ${stop} gate at publication`, async () => {
			const w = landWorld();
			landFirst(w.ledger, OWNER_REPO, false);
			const { wl, slice } = bind(w, PR.green, fx.head.green);
			const id = request(w, wl, slice, PR.green, fx.head.green);
			arm(w, id, "result");
			const p = spawnRun(w, id);
			try {
				await reached(w, id, "result");
				expect(fastPlanOf(w.ledger.entries(wl), id)).toBeNull();
				landFirst(w.ledger, OWNER_REPO, true);
				if (stop === "stopped") mainRun(w.ledger, "tr-redtransition", fx.head.red, "red");
				api(w, "git/ref/heads/main", { object: { sha: fx.head.red } });
				api(w, `git/commits/${fx.head.red}`, {
					sha: fx.head.red, tree: { sha: g(w.origin, "rev-parse", `${fx.head.red}^{tree}`) },
					committer: { date: new Date().toISOString() }, parents: [{ sha: fx.main }],
				});
				api(w, `commits/${fx.head.red}/pulls`, []);
				api(w, `compare/${fx.head.red}...${fx.head.green}`, { status: stop === "behind" ? "diverged" : "ahead" });
			} finally { go(w, id, "result"); }
			expect(await p.exited).toBe(0);
			expect(await resultOf(w, wl, id)).toMatchObject({ verdict: "green", scope: "full", host: "mac" });
			expect(statusPosts(w)).toEqual([`failure ${fx.head.green}`]);
			expect(calls(w).at(-1)).toContain(stop === "stopped" ? "landing stopped" : "does not contain main's tip");
		});
	}

	for (const mode of ["hosted", "fallback", "tree carry", "full"] as const) {
		test(`${mode}: admission on then publication off requires a full-suite green, not a fast/tree plan`, async () => {
			const w = landWorld();
			const head = mode === "tree carry"
				? g(w.origin, "commit-tree", g(w.origin, "rev-parse", `${fx.main}^{tree}`), "-p", fx.main, "-m", "off transition tree")
				: fx.head.green;
			if (mode === "tree carry") g(w.origin, "update-ref", `refs/pull/${PR.green}/head`, head);
			const { wl, slice } = bind(w, PR.green, head);
			if (mode === "full") {
				const config = w.env.AGENT_SYSTEM_TEST_RUNNER_CONFIG!;
				writeFileSync(config, `${readFileSync(config, "utf8")}  fullBeforeMerge:\n    - a.test.ts\n`);
			}
			if (mode === "hosted") artifact(w, head, "green");
			if (mode === "fallback") writeFileSync(join(w.root, "post", `repos_${OWNER_REPO.replaceAll("/", "_")}_actions_workflows_as2-fast.yml_dispatches.fail`), "dispatch denied\n");
			// This boundary is outside the carry transaction and shared by normal publication.
			arm(w, wl, "gate-publication");
			const starter = Bun.spawn([process.execPath, RUNNER, "start", wl, String(PR.green), "--slice", slice, "--requested-by", LANE], { env: w.env, stdout: "pipe", stderr: "pipe" });
			let id = "";
			try {
				await reached(w, wl, "gate-publication");
				id = testRuns(w.ledger.entries(wl)).at(-1)!.request.runId;
				expect(fastPlanOf(w.ledger.entries(wl), id)?.scope).toBe(mode === "tree carry" ? "tree" : mode === "full" ? "full" : "fast");
				expect((await resultOf(w, wl, id)).verdict).toBe("green");
				expect(statusPosts(w)).toEqual([`pending ${head}`]);
				landFirst(w.ledger, OWNER_REPO, false);
			} finally { go(w, wl, "gate-publication"); }
			expect(await starter.exited).toBe(START_EXIT.ok);
			const result = await finalized(w, wl, id);
			expect(result.scope).toBe(mode === "full" || mode === "tree carry" ? "full" : "fast");
			expect(statusPosts(w)).toEqual([`pending ${head}`, `${mode === "full" ? "success" : "failure"} ${head}`]);
			if (mode === "tree carry") {
				expect((await new Response(starter.stdout).text())).toContain("runner none");
				expect(dispatches(w)).toEqual([]);
			} else {
				expect(result.host).toBe(mode === "hosted" ? "linux" : "mac");
			}
		});
	}

	test("publication off preserves full-suite verdict states only for full Mac results at this head", () => {
		const w = landWorld();
		landFirst(w.ledger, OWNER_REPO, false);
		const { wl } = bind(w, PR.green, fx.head.green);
		for (const variant of ["green", "red-main", "red", "error", "fast", "fast plan", "tree plan", "linux", "wrong head"] as const) {
			const posts: string[][] = [];
			const gh: Gh = (args) => {
				if (args[0] !== "api" || args[1] !== "-X" || !args[3]?.includes("/statuses/")) throw new Error(`off publication unexpectedly read GitHub: ${args.join(" ")}`);
				posts.push(args);
				return { code: 0, stdout: "{}", stderr: "" };
			};
			const result = postGate({
				gh, ledger: w.ledger, root: w.runs, repo: OWNER_REPO, head: fx.head.green, ref: `wl/${wl}`, pr: PR.green, need: variant === "fast plan" || variant === "tree plan" ? "fast" : "full",
				result: {
					verdict: variant === "red-main" || variant === "red" || variant === "error" ? variant : "green",
					sha: variant === "wrong head" ? fx.main : fx.head.green,
					scope: variant === "fast" ? "fast" : "full", host: variant === "linux" ? "linux" : "mac",
				},
				wl, runId: "tr-offpolicy", log: () => {},
			});
			const state = variant === "green" || variant === "red-main" ? "success" : variant === "error" ? "error" : "failure";
			expect(result).toMatchObject({ state, error: null });
			expect(posts).toHaveLength(1);
			expect(posts[0]).toContain(`state=${state}`);
		}
	});

	test("pending refusal admits nothing and does not compute a plan or dispatch", () => {
		const w = landWorld();
		const { wl, slice } = bind(w, PR.green, fx.head.green);
		writeFileSync(join(w.root, "status-fails-pending"), "");
		const before = w.ledger.entries(wl);
		const s = start(w, wl, PR.green, ["--slice", slice]);
		expect(s.code).toBe(START_EXIT.refused);
		expect(s.err).toContain("nothing was requested");
		expect(w.ledger.entries(wl)).toEqual(before);
		expect(dispatches(w)).toEqual([]);
		expect(statusPosts(w)).toEqual([`pending ${fx.head.green}`]);
		expect(existsSync(join(w.root, "status-ok.log"))).toBe(false);
		expect(existsSync(join(w.runs, "mirrors"))).toBe(false);
	});

	for (const production of ["requesting workload", "PR owner"] as const) {
		test(`production ${production}: runner admission still selects and executes the fast plan`, async () => {
			const w = landWorld();
			const owner = bind(w, PR.green, fx.head.green);
			const requester = workload(w);
			joTrains(w, requester.wl, [PR.green]);
			w.ledger.setStakes(production === "requesting workload" ? requester.wl : owner.wl, { by: SURFACE_BY, stakes: "production" });
			artifact(w, fx.head.green, "green");
			const id = runIdOf(start(w, requester.wl, PR.green, ["--slice", requester.slice]));
			const result = await finalized(w, requester.wl, id);
			expect(fastPlanOf(w.ledger.entries(requester.wl), id)).toEqual({
				ref: `wl/${owner.wl}`, scope: "fast", files: ["a.test.ts"], parse: ["a.test.ts"], macOnly: [],
			});
			expect(result).toMatchObject({ verdict: "green", scope: "fast", host: "linux", exec: { files: 1, tests: 1, treeFiles: 1 } });
			expect(dispatches(w)).toHaveLength(1);
			expect(marks(w, id, "acquired")).toEqual([]);
			expect(statusPosts(w)).toEqual([`pending ${fx.head.green}`, `success ${fx.head.green}`]);
		});
	}

	for (const mode of ["green", "red", "missing"] as const) {
		test(`hosted ${mode}: pending first, recorded plan, tagged dispatch, executed counts and gate verdict without a Mac slot`, async () => {
			const w = landWorld();
			const { wl, slice } = bind(w, PR.green, fx.head.green);
			artifact(w, fx.head.green, mode);
			const id = runIdOf(start(w, wl, PR.green, ["--slice", slice]));
			const result = await finalized(w, wl, id);
			expect(fastPlanOf(w.ledger.entries(wl), id)).toEqual({ ref: `wl/${wl}`, scope: "fast", files: ["a.test.ts"], parse: ["a.test.ts"], macOnly: [] });
			expect(result).toMatchObject({
				verdict: mode === "green" ? "green" : "red", scope: "fast", host: "linux",
				exec: { files: mode === "missing" ? 0 : 1, tests: mode === "missing" ? 0 : 1, treeFiles: 1 },
			});
			if (mode === "red") expect(result.full).toMatchObject({ fail: 1 });
			if (mode === "missing") expect(result.reason).toContain("no executed test in the fast set's a.test.ts");
			expect(w.ledger.slice(slice)!.state).toBe(mode === "green" ? "done" : "open");
			expect(statusPosts(w)).toEqual([`pending ${fx.head.green}`, `${mode === "green" ? "success" : "failure"} ${fx.head.green}`]);
			expect(dispatches(w)).toHaveLength(1);
			expect(dispatches(w)[0]).toContain(`ref=as2-verified -f inputs[sha]=${fx.head.green} -f inputs[files]=./a.test.ts -f inputs[request]=${id}`);
			expect(calls(w).findIndex((s) => s.includes("state=pending"))).toBeLessThan(calls(w).findIndex((s) => s.includes("git/ref/heads/main")));
			expect(marks(w, id, "acquired")).toEqual([]);
			expect(existsSync(join(w.root, "sudo.log"))).toBe(false);
			expect(w.ledger.entries(wl).filter((e) => e.body.startsWith("fast-fallback:"))).toEqual([]);
			expect(preflights(w)).toHaveLength(1);
			expect(preflights(w)[0]!.created_by).toBe(TEST_RUNNER_BY);
			expect(parseRunnerPreflight(preflights(w)[0]!.body)).toEqual({ ok: true, reason: null, source: fx.main, root: w.env.AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT! });
		});
	}

	for (const reason of ["dispatch", "wrong head", "timeout"] as const) {
		test(`${reason} falls back once: same planned set executes on the Mac, no hosted retry`, async () => {
			const w = landWorld({ stuckStop: "enforce" });
			const { wl, slice } = bind(w, PR.green, fx.head.green);
			if (reason === "dispatch") writeFileSync(join(w.root, "post", `repos_${OWNER_REPO.replaceAll("/", "_")}_actions_workflows_as2-fast.yml_dispatches.fail`), "dispatch denied\n");
			if (reason === "wrong head") api(w, "actions/runs/71", { head_sha: fx.head.red, status: "completed" });
			if (reason === "timeout") api(w, "actions/runs/71", { head_sha: fx.main, status: "in_progress" });
			const id = runIdOf(start(w, wl, PR.green, ["--slice", slice]));
			const result = await finalized(w, wl, id);
			expect(result).toMatchObject({ verdict: "green", scope: "fast", host: "mac", full: { pass: 1, fail: 0 }, exec: { files: 1, tests: 1, treeFiles: 1 } });
			expect(dispatches(w)).toHaveLength(1);
			const rows = w.ledger.entries(wl).filter((e) => e.body.startsWith("fast-fallback:"));
			expect(rows).toHaveLength(1);
			expect(rows[0]!.body).toContain(reason === "dispatch" ? "dispatch failed: dispatch denied" : reason === "wrong head" ? "not as2-verified" : "no result in");
			expect(subsOf(w, id).filter((s) => s === "fast")).toEqual(["fast"]);
			expect(subsOf(w, id)).not.toContain("full");
			expect(marks(w, id, "acquired")).toHaveLength(1);
			expect(statusPosts(w)).toEqual([`pending ${fx.head.green}`, `success ${fx.head.green}`]);
			expect(preflights(w)).toHaveLength(1);
		});
	}

	for (const failure of ["install", "lock", "receipt"] as const) {
		test(`fast preflight ${failure} failure leaves a refused activation receipt or both errors locally`, async () => {
			const w = landWorld();
			const { wl, slice } = bind(w, PR.green, fx.head.green);
			const id = request(w, wl, slice, PR.green, fx.head.green);
			w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: fastPlanBody(id, {
				ref: `wl/${wl}`, scope: "fast", files: ["a.test.ts"], parse: ["a.test.ts"], macOnly: [],
			}) });
			const publisher = failure === "lock" ? new Database(join(w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!, "promotion.db")) : null;
			publisher?.exec("BEGIN IMMEDIATE");
			if (failure !== "lock") chmodSync(join(w.libexec, "bun"), 0o700);
			if (failure === "receipt") w.ledger.db.exec(`CREATE TRIGGER refuse_preflight BEFORE INSERT ON entries WHEN NEW.body LIKE 'runner-preflight:%' BEGIN SELECT RAISE(FAIL, 'preflight receipt refused by fixture'); END`);
			const child = spawnRun(w, id, {
				AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "25",
				AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS: "25", AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS: "25", AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS: "25",
				AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS: "1500",
			});
			try {
				await until("fast preflight failure finishes", () => child.exitCode !== null, 10_000);
				expect(await child.exited).toBe(0);
				const result = await resultOf(w, wl, id);
				expect(result).toMatchObject({ verdict: "error", scope: "fast", full: null });
				expect(w.ledger.slice(slice)!.state).toBe("open");
				expect(dispatches(w)).toEqual([]);
				expect(marks(w, id, "acquired")).toEqual([]);
				if (failure === "receipt") {
					const receiptFailure = runnerLog(w, id).split("\n").find((line) => line.includes("preflight receipt refused by fixture"));
					expect(receiptFailure).toBeDefined();
					expect(receiptFailure).toContain(result.reason!);
				} else {
					const receipt = parseRunnerPreflight(preflights(w).at(-1)!.body)!;
					expect(receipt.ok).toBe(false);
					expect(receipt.reason).toContain(result.reason!);
					expect(bootstrapRefusal(w.ledger.entries(STANDING_WORKLOAD_ID)).some((r) => r.includes(receipt.reason!))).toBe(true);
				}
			} finally {
				publisher?.close();
				await child.exited;
			}
		});
	}

	test("a fast preflight superseded at install decides no activation receipt and dispatches nothing", async () => {
		const w = landWorld();
		const { wl, slice } = bind(w, PR.green, fx.head.green);
		const id = request(w, wl, slice, PR.green, fx.head.green);
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: fastPlanBody(id, {
			ref: `wl/${wl}`, scope: "fast", files: ["a.test.ts"], parse: ["a.test.ts"], macOnly: [],
		}) });
		writeFileSync(join(w.root, "gh.log"), "");
		arm(w, id, "phase-install");
		const child = spawnRun(w, id);
		try {
			await reached(w, id, "phase-install");
			request(w, wl, slice, PR.green, fx.head.green);
		} finally { go(w, id, "phase-install"); }
		expect(await child.exited).toBe(0);
		expect(await resultOf(w, wl, id)).toMatchObject({ verdict: "superseded", full: null });
		expect(preflights(w)).toEqual([]);
		expect(dispatches(w)).toEqual([]);
		expect(w.ledger.slice(slice)!.state).toBe("open");
	});

	for (const publisher of ["hosted", "tree carry"] as const) test(`${publisher}: publication mutex acquisition failure keeps a genuine green pending with a durable status failure`, async () => {
		const w = landWorld();
		const head = publisher === "tree carry"
			? g(w.origin, "commit-tree", g(w.origin, "rev-parse", `${fx.main}^{tree}`), "-p", fx.main, "-m", "publication unavailable")
			: fx.head.green;
		if (publisher === "tree carry") g(w.origin, "update-ref", `refs/pull/${PR.green}/head`, head);
		const { wl, slice } = bind(w, PR.green, head);
		if (publisher === "hosted") artifact(w, head, "green");
		arm(w, wl, "gate-publication");
		const starter = Bun.spawn([process.execPath, RUNNER, "start", wl, String(PR.green), "--slice", slice, "--requested-by", LANE], { env: w.env, stdout: "pipe", stderr: "pipe" });
		let id = "";
		try {
			await reached(w, wl, "gate-publication");
			id = testRuns(w.ledger.entries(wl)).at(-1)!.request.runId;
			withFullSuitePublication(w.runs, OWNER_REPO, () => {});
			const mutex = readdirSync(w.runs).find((f) => f.startsWith("runs.db.publication-") && f.endsWith(".db"))!;
			writeFileSync(join(w.runs, mutex), "not a sqlite database");
		} finally { go(w, wl, "gate-publication"); }
		expect(await starter.exited).toBe(START_EXIT.ok);
		await until("failed publication persisted", () => w.ledger.entries(wl).some((e) => e.body.startsWith(`status-failed: ${id} `)));
		expect(await resultOf(w, wl, id)).toMatchObject({ verdict: "green" });
		expect(statusPosts(w)).toEqual([`pending ${head}`]);
		expect(w.ledger.entries(wl).find((e) => e.body.startsWith(`status-failed: ${id} `))!.body).toContain("publication mutex");
	});

	test("publication contention past the former 60-second waiter cap preserves a green and starts a fresh holder budget", async () => {
		const w = landWorld();
		landFirst(w.ledger, OWNER_REPO, false);
		const { wl } = bind(w, PR.green, fx.head.green);
		const events = join(w.root, "publisher.events");
		const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
		const worker = new Worker(new URL("./fixtures/full-suite-publication-worker.ts", import.meta.url).href);
		const holderError = new Promise<string>((resolve, reject) => {
			worker.onmessage = (event) => {
				if (typeof event.data === "object" && event.data.error) resolve(event.data.error);
			};
			worker.onerror = reject;
		});
		try {
			// An intentionally broken old publisher outlives the old waiter cap. The new holder must reject its own overrun,
			// while the queued publisher gets a fresh 30 s section after waiting through multiple bounded busy windows.
			worker.postMessage({ root: w.runs, repo: OWNER_REPO, signal, events, holdMs: 61_000 });
			await until("the overlong publisher holds the mutex", () => existsSync(events), 10_000);
			const posts: string[][] = [];
			const result = postGate({
				gh: (args, timeoutMs) => { posts.push(args); expect(timeoutMs).toBe(15_000); return { code: 0, stdout: "{}", stderr: "" }; },
				ledger: w.ledger, root: w.runs, repo: OWNER_REPO, head: fx.head.green, ref: `wl/${wl}`, pr: PR.green,
				need: "full", result: { verdict: "green", sha: fx.head.green, scope: "full", host: "mac" }, wl, runId: "tr-contention", log: () => {},
			});
			expect(result).toMatchObject({ state: "success", error: null });
			expect(posts).toHaveLength(1);
			expect(posts[0]).toContain("state=success");
			expect(await holderError).toContain("holder deadline");
			expect(w.ledger.entries(wl).filter((e) => e.body.startsWith("status-failed:"))).toEqual([]);
		} finally { Atomics.notify(new Int32Array(signal), 0); worker.terminate(); }
	});

	for (const initial of ["pending", "success"] as const) test(`cached gate success cannot resurrect after main stop and completed ${initial} revocation`, () => {
		const w = landWorld();
		const { wl } = bind(w, PR.green, fx.head.green);
		suspectMain(w);
		const events: string[] = [];
		let status: string = initial;
		let compareReads = 0;
		const gh: Gh = (args, timeoutMs) => {
			if (args[1] === "-X") {
				expect(timeoutMs).toBeGreaterThan(0);
				expect(timeoutMs).toBeLessThanOrEqual(15_000);
				status = args.find((a) => a.startsWith("state="))!.slice(6);
				events.push(`post ${status}`);
				return { code: 0, stdout: "{}", stderr: "" };
			}
			if (args[0] === "pr") return { code: 0, stdout: JSON.stringify([{ number: PR.green, headRefOid: fx.head.green }]), stderr: "" };
			if (args[1]!.endsWith("/statuses")) return { code: 0, stdout: JSON.stringify([{ context: FULL_SUITE_STATUS, state: status, description: "fast check green" }]), stderr: "" };
			if (args[1]!.includes("/compare/")) {
				compareReads++;
				// readMain has snapshotted an open state. Commit the stop, then finish the real revocation scan before publication.
				mainRun(w.ledger, "tr-laterstop", fx.head.red, "red");
				events.push("main stop");
				const revoked = revokeOpen(gh, OWNER_REPO, "main red", () => {}, (head) => withFullSuitePublication(w.runs, OWNER_REPO, () => postStatus(gh, OWNER_REPO, "failure", head, "landing stopped: main red", () => {})));
				expect(revoked).toEqual({ revoked: initial === "success" ? [PR.green] : [], failed: [] });
				events.push("revocation complete");
			}
			return { code: 0, stdout: readFileSync(join(w.root, "api", args[1]!.replaceAll("/", "_")), "utf8"), stderr: "" };
		};
		const result = postGate({
			gh, ledger: w.ledger, root: w.runs, repo: OWNER_REPO, head: fx.head.green, ref: `wl/${wl}`, pr: PR.green,
			need: "fast", result: { verdict: "green", sha: fx.head.green, scope: "fast", host: "linux" }, wl, runId: "tr-stalestop", log: () => {},
		});
		expect(result).toMatchObject({ state: "failure", error: null, description: expect.stringContaining("authority changed") });
		expect(status).toBe("failure");
		expect(events).toEqual(initial === "success"
			? ["main stop", "post failure", "revocation complete", "post failure"]
			: ["main stop", "revocation complete", "post failure"]);
		expect(compareReads).toBe(1);
	});

	for (const change of ["off/on", "incident", "unrelated"] as const) test(`gate authority at publication tracks ${change} without whole-ledger invalidation`, () => {
		const w = landWorld();
		const { wl } = bind(w, PR.green, fx.head.green);
		const posts: string[][] = [];
		let compareReads = 0;
		const gh: Gh = (args) => {
			if (args[1] === "-X") { posts.push(args); return { code: 0, stdout: "{}", stderr: "" }; }
			if (args[1]!.includes("/compare/")) {
				compareReads++;
				if (change === "off/on") {
					landFirst(w.ledger, OWNER_REPO, false);
					landFirst(w.ledger, OWNER_REPO, true);
				} else {
					if (change === "unrelated") {
						w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "unrelated standing audit" });
						landFirst(w.ledger, "other/product", true);
					}
					w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstNoticeBody(change === "incident" ? OWNER_REPO : "other/product", {
						event: "stop-raised", kind: "regression", tip: fx.head.red, g: fx.main, suspects: [PR.red], failing: 1,
					}) });
				}
			}
			return { code: 0, stdout: readFileSync(join(w.root, "api", args[1]!.replaceAll("/", "_")), "utf8"), stderr: "" };
		};
		const state = change === "unrelated" ? "success" : "failure";
		expect(postGate({
			gh, ledger: w.ledger, root: w.runs, repo: OWNER_REPO, head: fx.head.green, ref: `wl/${wl}`, pr: PR.green,
			need: "fast", result: { verdict: "green", sha: fx.head.green, scope: "fast", host: "linux" }, wl, runId: "tr-generation", log: () => {},
		})).toMatchObject({ state, error: null });
		expect(posts).toHaveLength(1);
		expect(posts[0]).toContain(`state=${state}`);
		expect(compareReads).toBe(1);
	});

	for (const advance of [0, 1]) test(`gate authority revalidates the exact main age boundary plus ${advance}ms before POST`, () => {
		const w = landWorld();
		const { wl } = bind(w, PR.green, fx.head.green);
		const originalNow = Date.now;
		let now = originalNow();
		suspectMain(w, new Date(now - SUSPECT_MAX_MS).toISOString());
		const posts: string[][] = [];
		const gh: Gh = (args) => {
			if (args[1] === "-X") { posts.push(args); return { code: 0, stdout: "{}", stderr: "" }; }
			if (args[1]!.includes("/compare/")) now += advance;
			return { code: 0, stdout: readFileSync(join(w.root, "api", args[1]!.replaceAll("/", "_")), "utf8"), stderr: "" };
		};
		try {
			Date.now = () => now;
			const state = advance === 0 ? "success" : "failure";
			expect(postGate({
				gh, ledger: w.ledger, root: w.runs, repo: OWNER_REPO, head: fx.head.green, ref: `wl/${wl}`, pr: PR.green,
				need: "fast", result: { verdict: "green", sha: fx.head.green, scope: "fast", host: "linux" }, wl, runId: "tr-ageboundary", log: () => {},
			})).toMatchObject({ state, error: null });
			expect(posts).toHaveLength(1);
			expect(posts[0]).toContain(`state=${state}`);
		} finally { Date.now = originalNow; }
	});

	test("gate computation does not spend the short publication holder budget and its final post is clipped", () => {
		const w = landWorld();
		const { wl } = bind(w, PR.green, fx.head.green);
		const originalNow = Date.now;
		let now = originalNow();
		const timeouts: number[] = [];
		const gh: Gh = (args, timeoutMs) => {
			if (args[1] === "-X") {
				timeouts.push(timeoutMs!);
				return { code: 0, stdout: "{}", stderr: "" };
			}
			now += 31_000;
			const path = args[1]!;
			const fixture = join(w.root, "api", path.replaceAll("/", "_"));
			return { code: 0, stdout: readFileSync(fixture, "utf8"), stderr: "" };
		};
		try {
			Date.now = () => now;
			expect(postGate({
				gh, ledger: w.ledger, root: w.runs, repo: OWNER_REPO, head: fx.head.green, ref: `wl/${wl}`, pr: PR.green,
				need: "full", result: { verdict: "green", sha: fx.head.green, scope: "full", host: "mac" }, wl, runId: "tr-budget", log: () => {},
			})).toMatchObject({ state: "success", error: null });
			expect(timeouts).toEqual([15_000]);
			expect(() => withFullSuitePublication(w.runs, OWNER_REPO, (remainingMs) => {
				expect(remainingMs()).toBe(30_000);
				now += 29_500;
				expect(remainingMs()).toBe(500);
				now += 500;
				expect(() => remainingMs()).toThrow("holder deadline");
			})).toThrow("holder deadline");
		} finally { Date.now = originalNow; }
	});

	test("a final post uses the aggregate holder remainder and preserves both publication and audit failures", () => {
		const w = landWorld();
		landFirst(w.ledger, OWNER_REPO, false);
		const { wl } = bind(w, PR.green, fx.head.green);
		const originalNow = Date.now;
		const originalEntries = w.ledger.entries;
		let now = originalNow();
		let activationReads = 0;
		try {
			Date.now = () => now;
			w.ledger.entries = (...args) => {
				// The second read is live activation inside the holder; precomputation is outside it.
				if (++activationReads === 2) now += 29_500;
				return originalEntries.apply(w.ledger, args);
			};
			w.ledger.db.exec(`CREATE TRIGGER refuse_status_failure BEFORE INSERT ON entries WHEN NEW.body LIKE 'status-failed:%' BEGIN SELECT RAISE(FAIL, 'publication audit denied'); END`);
			let failure: unknown;
			try {
				postGate({
					gh: (_args, timeoutMs) => { expect(timeoutMs).toBe(500); return { code: 1, stdout: "", stderr: "final post denied" }; },
					ledger: w.ledger, root: w.runs, repo: OWNER_REPO, head: fx.head.green, ref: `wl/${wl}`, pr: PR.green,
					need: "full", result: { verdict: "green", sha: fx.head.green, scope: "full", host: "mac" }, wl, runId: "tr-audit", log: () => {},
				});
			} catch (e) { failure = e; }
			expect(failure).toBeInstanceOf(AggregateError);
			expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual(["final post denied", expect.stringContaining("publication audit denied")]);
		} finally { Date.now = originalNow; w.ledger.entries = originalEntries; }
	});

	test("tree carry settles from G without a runner and a refused final gate post leaves pending with a durable failure row", async () => {
		const w = landWorld();
		// A distinct commit with exactly G's tree, not an identical-S carry.
		const head = g(w.origin, "commit-tree", g(w.origin, "rev-parse", `${fx.main}^{tree}`), "-p", fx.main, "-m", "same tree");
		g(w.origin, "update-ref", "refs/pull/12/head", head);
		const { wl, slice } = bind(w, 12, head);
		writeFileSync(join(w.root, "status-fails-success"), "");
		const s = start(w, wl, 12, ["--slice", slice]);
		const id = runIdOf(s);
		expect(s.out).toContain("runner none");
		expect(s.out).toEndWith("carried tr-mainseed");
		expect(fastPlanOf(w.ledger.entries(wl), id)).toEqual({ ref: `wl/${wl}`, scope: "tree", g: fx.main, run: "tr-mainseed" });
		expect(await resultOf(w, wl, id)).toMatchObject({ verdict: "green", sha: head, full: { pass: 400 }, runDir: "/runs/tr-mainseed", scope: "full", host: "mac" });
		expect(w.ledger.slice(slice)!.state).toBe("done");
		expect(w.ledger.entries(wl).filter((e) => e.body.startsWith("status-failed:")).map((e) => e.body)).toEqual([`status-failed: ${id} success on ${head}: gh: Validation Failed (HTTP 422)`]);
		expect(readFileSync(join(w.root, "status-ok.log"), "utf8").trim()).toBe(`pending repos/${OWNER_REPO}/statuses/${head}`);
		expect(dispatches(w)).toEqual([]);
		expect(existsSync(join(w.runs, id))).toBe(false);
	});

	test("refused install preflight records the outcome once and never executes a test", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		chmodSync(join(w.libexec, "bun"), 0o700);
		const id = request(w, wl, slice, PR.green, fx.head.green);
		expect(await spawnRun(w, id).exited).toBe(0);
		expect(await resultOf(w, wl, id)).toMatchObject({ verdict: "error" });
		expect(preflights(w)).toHaveLength(1);
		expect(parseRunnerPreflight(preflights(w)[0]!.body)).toMatchObject({ ok: false, reason: expect.stringContaining("mode 700"), source: "0".repeat(40), root: resolve(import.meta.dir, "..", "..") });
		expect(preflights(w)[0]!.created_by).toBe(TEST_RUNNER_BY);
		expect(marks(w, id, "spawn-full")).toEqual([]);
	});

	test("reap settles dead PR and main requests, keeps live requests, admits nothing, and repeats as a no-op", () => {
		const w = landWorld();
		const a = workload(w);
		const b = workload(w);
		const dead = request(w, a.wl, a.slice, PR.green, fx.head.green, 600_000);
		const stale = request(w, b.wl, b.slice, PR.green, fx.head.green, 600_000);
		writeHeartbeat(w, stale, Date.now() - 120_000);
		const liveOwner = workload(w);
		const live = request(w, liveOwner.wl, liveOwner.slice, PR.green, fx.head.green, 600_000);
		writeHeartbeat(w, live, Date.now());
		const startup = workload(w);
		request(w, startup.wl, startup.slice, PR.green, fx.head.green);
		const main = "tr-deadmain";
		w.ago(600_000, () => w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: testRequestedBody({ runId: main, pr: 0, sha: fx.main, slice: "sl-main-dead", by: MERGE_TRAIN_BY, main: { repo: OWNER_REPO } }) }));
		const before = w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM entries WHERE body LIKE 'test-requested: %'").get()!.n;
		const reaped = reapRequests(w.ledger, w.runs);
		expect(reaped.failed).toEqual([]);
		expect(reaped.settled.sort()).toEqual([main, dead, stale].sort());
		for (const [wl, id] of [[a.wl, dead], [b.wl, stale], [STANDING_WORKLOAD_ID, main]]) {
			expect(testRuns(w.ledger.entries(wl!)).find((r) => r.request.runId === id)!.results).toEqual([expect.objectContaining({ verdict: "error", reason: "runner died", main: id === main })]);
		}
		expect(testRuns(w.ledger.entries(liveOwner.wl))[0]!.results).toEqual([]);
		expect(testRuns(w.ledger.entries(startup.wl))[0]!.results).toEqual([]);
		expect(w.ledger.slice(a.slice)!.state).toBe("open");
		const entries = w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM entries").get()!.n;
		expect(reapRequests(w.ledger, w.runs)).toEqual({ settled: [], failed: [] });
		expect(w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM entries").get()!.n).toBe(entries);
		expect(w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM entries WHERE body LIKE 'test-requested: %'").get()!.n).toBe(before);
		expect(existsSync(join(w.root, "gh.log"))).toBe(false);
	});

	test("retention keeps main and main-red citations for 30 days beyond KEEP_RUNS, and an open incident keeps older evidence until cleared", () => {
		const w = landWorld();
		const now = Date.now();
		const day = 86_400_000;
		const entry = (body: string, age: number, by = TEST_RUNNER_BY) => w.pin(new Date(now - age).toISOString(), () => w.ledger.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body }));
		const main = (id: string, age: number) => entry(testRequestedBody({ runId: id, pr: 0, sha: fx.main, slice: `sl-${id}`, by: MERGE_TRAIN_BY, main: { repo: OWNER_REPO } }), age);
		main("tr-boundary", 30 * day);
		main("tr-expired", 30 * day + 1);
		entry("main-red: run tr-recentred", 29 * day);
		entry("main-red: run tr-oldred", 31 * day);
		entry("main-red: run tr-forged", day, LANE);
		const cited = citedRuns(w.ledger.entries(STANDING_WORKLOAD_ID), now);
		expect([...cited].sort()).toEqual(["tr-boundary", "tr-recentred"]);
		const runs = ["tr-boundary", "tr-recentred", "tr-expired", ...Array.from({ length: 10 }, (_, i) => `tr-new${i}`)].map((id, i) => ({ id, at: i }));
		expect(retentionPrune(runs, cited, "tr-new9")).toEqual(["tr-expired"]);
		entry(landFirstNoticeBody(OWNER_REPO, { event: "stop-raised", kind: "regression", tip: fx.main, g: fx.main, suspects: [], failing: 1 }), 40 * day, MERGE_TRAIN_BY);
		expect([...citedRuns(w.ledger.entries(STANDING_WORKLOAD_ID), now)].sort()).toEqual(["tr-boundary", "tr-expired", "tr-oldred", "tr-recentred"]);
		entry(landFirstNoticeBody(OWNER_REPO, { event: "stop-cleared", why: "fixed" }), 0, MERGE_TRAIN_BY);
		expect([...citedRuns(w.ledger.entries(STANDING_WORKLOAD_ID), now)].sort()).toEqual(["tr-boundary", "tr-recentred"]);
	});
});

describe("land-first main D5 (R13, R14)", () => {
	function mainWorld() {
		const w = world();
		landFirst(w.ledger, OWNER_REPO, true);
		verifiedWorld(w);
		return w;
	}
	function admit(w: World, sha: string) {
		const db = lockDbOf(w);
		try {
			return admitMain(w.ledger, db, w.runs, OWNER_REPO, sha, MERGE_TRAIN_BY);
		} finally {
			db.close();
		}
	}
	function mainRequest(w: World, sha: string): string {
		const a = admit(w, sha);
		if (a.action !== "admitted") throw new Error(a.line);
		return a.runId;
	}
	function api(w: World, path: string, value: unknown) {
		mkdirSync(join(w.root, "api"), { recursive: true });
		writeFileSync(join(w.root, "api", path.replaceAll("/", "_")), JSON.stringify(value));
	}
	const calls = (w: World) => existsSync(join(w.root, "gh.log")) ? readFileSync(join(w.root, "gh.log"), "utf8") : "";
	function openSuccess(w: World) {
		api(w, `repos/${OWNER_REPO}/commits/${fx.head.green}/statuses`, [{ context: "as2/full-suite", state: "success", description: "fast check green" }]);
		writeFileSync(join(w.root, "open-prs.json"), JSON.stringify([{ number: 1, headRefOid: fx.head.green }]));
	}
	test("green main executes its requested commit, publishes believable verdict before GitHub, and never completes a slice", async () => {
		const w = mainWorld();
		const id = mainRequest(w, fx.head.green);
		arm(w, id, "main-published");
		const p = spawnRun(w, id);
		try {
			await reached(w, id, "main-published");
			const result = await resultOf(w, STANDING_WORKLOAD_ID, id);
			expect(result).toMatchObject({ main: true, scope: "full", host: "mac", verdict: "green", exec: { files: 2, tests: 2, treeFiles: 2 }, base: null, mergeBase: null });
			expect(mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).get(result.sha)?.verdict).toBe("green");
			expect(w.ledger.slice(testRuns(w.ledger.entries(STANDING_WORKLOAD_ID)).find((r) => r.request.runId === id)!.request.slice)).toBeNull();
			expect(calls(w)).not.toContain("context=as2/main-full");
			expect(readFileSync(join(w.root, "verified-tag"), "utf8")).toBe(fx.control);
			// A later main tip and missing PR ref do not make an immutable main target stale.
			g(w.root, "--git-dir", w.origin, "update-ref", "refs/heads/main", fx.head.red);
		} finally {
			go(w, id, "main-published");
		}
		expect(await p.exited).toBe(0);
		expect(calls(w)).toContain("context=as2/main-full");
		expect(calls(w)).not.toContain("context=as2/full-suite");
		expect(calls(w)).not.toContain("pr view 0");
		expect(w.ledger.entries(STANDING_WORKLOAD_ID).some((e) => e.body.startsWith("verifier-stalled:"))).toBe(false);
		expect(g(realpathSync(join(w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!, "current")), "rev-parse", "HEAD")).toBe(fx.head.green);
		expect(admit(w, fx.head.green).action).toBe("verdict");
	});
	test("main bulk revocation leaves the mutex free and rechecks off separately for each final head post", async () => {
		const w = mainWorld();
		openSuccess(w);
		const id = mainRequest(w, fx.head.red);
		const key = OWNER_REPO.replaceAll("/", "_");
		arm(w, key, "main-revocation-head");
		const child = spawnRun(w, id);
		try {
			await reached(w, key, "main-revocation-head");
			expect(calls(w)).toContain("pr list");
			// Bulk discovery has finished but owns no publication mutex. Off can complete before this per-head post.
			withFullSuitePublication(w.runs, OWNER_REPO, () => landFirst(w.ledger, OWNER_REPO, false));
		} finally { go(w, key, "main-revocation-head"); }
		expect(await child.exited).toBe(0);
		expect(calls(w)).not.toContain("context=as2/full-suite");
		expect(calls(w)).toContain(`statuses/${fx.head.red} -f state=failure -f context=as2/main-full`);
		expect(await resultOf(w, STANDING_WORKLOAD_ID, id)).toMatchObject({ main: true, verdict: "red" });
	});

	for (const path of ["settle", "startup", "publication error"] as const) {
		test(`main ${path} waiting behind an off publisher reads completed off before revoking, retaining its informational status`, async () => {
			const w = mainWorld();
			openSuccess(w);
			const sha = path === "startup" ? fx.main : fx.head.red;
			const id = mainRequest(w, sha);
			if (path === "publication error") w.ledger.db.exec(`CREATE TRIGGER refuse_main_result BEFORE INSERT ON entries
				WHEN NEW.body LIKE 'test-run:%' BEGIN SELECT RAISE(FAIL, 'main result publication refused by fixture'); END`);
			let runnerExit: Promise<number> | undefined;
			try {
				withFullSuitePublication(w.runs, OWNER_REPO, () => {
					const child = spawnRun(w, id, path === "startup" ? { AGENT_SYSTEM_TEST_RUNNER_CONFIG: join(w.root, "missing.yml") } : {});
					runnerExit = child.exited;
					// A real child blocks in SQLite while this synchronous callback owns the mutex; fake timers cannot drive its clock.
					const deadline = Date.now() + 60_000;
					while (marks(w, OWNER_REPO.replaceAll("/", "_"), "main-revocation-acquiring").length === 0) {
						if (child.exitCode !== null) throw new Error(`main exited before acquiring publication mutex: ${child.exitCode}\n${runnerLog(w, id)}`);
						if (Date.now() >= deadline) throw new Error(`main did not reach publication mutex before fixture deadline\n${runnerLog(w, id)}`);
						Bun.sleepSync(25);
					}
					expect(calls(w)).not.toContain("context=as2/full-suite");
					expect(calls(w)).not.toContain("context=as2/main-full");
					// Stand in for the off reconciler completing under the same mutex, before the waiting main can read activation.
					w.ledger.write(() => {
						const off = w.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(OWNER_REPO, false) });
						w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(OWNER_REPO, false, off) });
						w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody(OWNER_REPO, "pending", off) });
						w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody(OWNER_REPO, "complete", off) });
					});
				});
				expect(await runnerExit).toBe(path === "publication error" ? START_EXIT.failed : 0);
				expect(calls(w)).not.toContain("context=as2/full-suite");
				expect(calls(w)).not.toContain("pr list");
				expect(calls(w)).toContain(`statuses/${sha} -f state=${path === "settle" ? "failure" : "error"} -f context=as2/main-full`);
				const result = path === "publication error"
					? JSON.parse(readFileSync(join(w.runs, id, "result.json"), "utf8"))
					: await resultOf(w, STANDING_WORKLOAD_ID, id);
				expect(result).toMatchObject({ main: true, verdict: path === "settle" ? "red" : "error" });
			} finally {
				await runnerExit;
			}
		});
	}
	for (const on of [true, false]) for (const scenario of ["red", "skipped", "exit"] as const) {
		test(`${scenario} main persists verdict/facts before publication with land-first ${on ? "on" : "off"}`, async () => {
			const w = mainWorld();
			if (!on) landFirst(w.ledger, OWNER_REPO, false);
			openSuccess(w);
			const id = mainRequest(w, fx.head[scenario]);
			arm(w, id, "main-published");
			const p = spawnRun(w, id);
			try {
				await reached(w, id, "main-published");
				const result = await resultOf(w, STANDING_WORKLOAD_ID, id);
				expect(result.main).toBe(true);
				const verdict = mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).get(result.sha);
				expect(verdict?.verdict ?? null).toBe(scenario === "exit" ? null : scenario === "skipped" ? "implausible" : "red");
				expect(w.ledger.entries(STANDING_WORKLOAD_ID).some((e) => e.body.startsWith("main-red:"))).toBe(scenario !== "exit");
				if (scenario !== "exit") {
					const body = w.ledger.entries(STANDING_WORKLOAD_ID).find((e) => e.body.startsWith("main-red:"))!.body;
					const facts = JSON.parse(body.slice(`main-red: ${OWNER_REPO} `.length));
					expect(facts).toMatchObject({ repo: OWNER_REPO, sha: result.sha, runId: id, verdict: scenario === "red" ? "red" : "implausible" });
					expect(facts.suspects).toContain(result.sha);
					if (scenario === "red") {
						expect(facts.failing).toEqual(["red.test.ts"]);
						expect(facts.attribution).toContainEqual({ sha: result.sha, files: ["red.test.ts"] });
					}
				}
				if (scenario === "red") {
					expect(result.solo.map((s) => s.file)).toEqual(["./red.test.ts"]);
					expect(subsOf(w, id)).not.toContain("base-prepare");
				}
				expect(calls(w)).not.toContain("state=failure");
			} finally {
				go(w, id, "main-published");
			}
			expect(await p.exited).toBe(0);
			expect(calls(w).includes(`statuses/${fx.head.green} -f state=failure -f context=as2/full-suite`)).toBe(on);
			if (!on) expect(calls(w)).not.toContain("context=as2/full-suite");
			expect(calls(w)).toContain("context=as2/main-full");
		});
	}
	test("a real two-parent main merge attributes its failing files to the first-parent delta", async () => {
		const w = mainWorld();
		mainRun(w.ledger, "tr-parentgreen", fx.main, "green", { exec: { files: 1, tests: 1, treeFiles: 1 } });
		g(w.checkout, "fetch", "-q", w.origin, fx.head.red);
		g(w.checkout, "checkout", "-q", "-B", "main", fx.main);
		g(w.checkout, "merge", "-q", "--no-ff", "--no-edit", fx.head.red);
		const merged = g(w.checkout, "rev-parse", "HEAD");
		expect(g(w.checkout, "rev-list", "--parents", "-n", "1", merged).split(" ")).toEqual([merged, fx.main, fx.head.red]);
		g(w.checkout, "push", "-q", w.origin, "main");
		const id = mainRequest(w, merged);
		expect(await spawnRun(w, id).exited).toBe(0);
		expect(await resultOf(w, STANDING_WORKLOAD_ID, id)).toMatchObject({ main: true, verdict: "red", sha: merged });
		const body = w.ledger.entries(STANDING_WORKLOAD_ID).find((e) => e.body.startsWith("main-red:"))!.body;
		expect(JSON.parse(body.slice(`main-red: ${OWNER_REPO} `.length))).toMatchObject({
			suspects: [merged], failing: ["red.test.ts"], attribution: [{ sha: merged, files: ["red.test.ts"] }],
		});
	});

	test("audit failure after result commit never aborts remaining revocations or the informational status; every failure stays local", async () => {
		const w = mainWorld();
		openSuccess(w);
		api(w, `repos/${OWNER_REPO}/commits/${fx.head.env}/statuses`, [{ context: "as2/full-suite", state: "success", description: "fast check green" }]);
		writeFileSync(join(w.root, "open-prs.json"), JSON.stringify([{ number: PR.green, headRefOid: fx.head.green }, { number: PR.env, headRefOid: fx.head.env }]));
		mkdirSync(join(w.root, "post"));
		writeFileSync(join(w.root, "post", `repos_${OWNER_REPO.replaceAll("/", "_")}_statuses_${fx.head.green}.fail`), "first head post denied (HTTP 502)\n");
		const id = mainRequest(w, fx.head.red);
		arm(w, id, "main-published");
		const p = spawnRun(w, id);
		try {
			await reached(w, id, "main-published");
			expect((await resultOf(w, STANDING_WORKLOAD_ID, id)).verdict).toBe("red");
			w.ledger.db.exec(`CREATE TRIGGER reject_main_audit BEFORE INSERT ON entries
				WHEN NEW.body LIKE 'main-publication:%' BEGIN SELECT RAISE(ABORT, 'main audit disk failure'); END`);
		} finally { go(w, id, "main-published"); }
		expect(await p.exited).toBe(0);
		for (const head of [fx.head.green, fx.head.env]) expect(calls(w)).toContain(`statuses/${head} -f state=failure -f context=as2/full-suite`);
		expect(calls(w)).toContain(`statuses/${fx.head.red} -f state=failure -f context=as2/main-full`);
		expect(readFileSync(join(w.root, "status-ok.log"), "utf8")).toContain(`failure repos/${OWNER_REPO}/statuses/${fx.head.env}`);
		const log = runnerLog(w, id);
		expect(log).toContain("first head post denied (HTTP 502)");
		expect(log.match(/main-publication audit .* not recorded: .*main audit disk failure/g)).toHaveLength(3);
		expect(log).toContain(`status as2/full-suite failure on ${fx.head.env} posted`);
		expect(log).toContain(`status as2/main-full failure on ${fx.head.red} posted`);
		expect(mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).get(fx.head.red)?.verdict).toBe("red");
	});
	test("main preflight refusal stays inconclusive and revokes; GitHub failures are durable without erasing the result", async () => {
		const w = mainWorld();
		openSuccess(w);
		chmodSync(w.libexec, 0o700);
		writeFileSync(join(w.root, "status-fails"), "");
		const id = mainRequest(w, fx.main);
		expect(await spawnRun(w, id).exited).toBe(0);
		const result = await resultOf(w, STANDING_WORKLOAD_ID, id);
		expect(result).toMatchObject({ main: true, verdict: "error", full: null });
		expect(mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).has(fx.main)).toBe(false);
		expect(marks(w, id, "spawn-full")).toEqual([]);
		expect(calls(w)).toContain("state=failure -f context=as2/full-suite");
		expect(calls(w)).toContain("state=error -f context=as2/main-full");
		expect(w.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("main-publication:")).some((e) => e.body.includes("not posted") && e.body.includes("HTTP 422"))).toBe(true);
	});
	for (const [scenario, expected] of [["belief95", "green"], ["belief90", "implausible"], ["belief80", "green"]] as const) {
		test(`belief threshold ${scenario} executes the actual main path`, async () => {
			const w = mainWorld();
			if (scenario === "belief80") mainRun(w.ledger, "tr-baseline", fx.main, "green", { exec: { files: 1, tests: 5, treeFiles: 1 } });
			const id = mainRequest(w, fx.head[scenario]);
			expect(await spawnRun(w, id).exited).toBe(0);
			const result = await resultOf(w, STANDING_WORKLOAD_ID, id);
			expect(mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).get(result.sha)?.verdict).toBe(expected);
			expect(result.exec).toEqual(scenario === "belief80" ? { files: 2, tests: 4, treeFiles: 2 } : { files: scenario === "belief95" ? 19 : 18, tests: scenario === "belief95" ? 19 : 18, treeFiles: 20 });
		});
	}
	for (const on of [true, false]) test(`missing profile settles main as error with land-first ${on ? "on" : "off"}`, async () => {
		const w = mainWorld();
		if (!on) landFirst(w.ledger, OWNER_REPO, false);
		openSuccess(w);
		const id = mainRequest(w, fx.main);
		w.ledger.db.exec(`CREATE TRIGGER reject_startup_audit BEFORE INSERT ON entries
			WHEN NEW.body LIKE 'main-publication:%' BEGIN SELECT RAISE(ABORT, 'startup audit disk failure'); END`);
		expect(await spawnRun(w, id, { AGENT_SYSTEM_TEST_RUNNER_CONFIG: join(w.root, "missing.yml") }).exited).toBe(0);
		expect(await resultOf(w, STANDING_WORKLOAD_ID, id)).toMatchObject({ main: true, verdict: "error", reason: expect.stringContaining("missing.yml") });
		expect(calls(w).includes("state=failure -f context=as2/full-suite")).toBe(on);
		if (!on) expect(calls(w)).not.toContain("context=as2/full-suite");
		expect(calls(w)).toContain("state=error -f context=as2/main-full");
		expect(runnerLog(w, id)).toContain("startup audit disk failure");
		expect(readFileSync(join(w.runs, id, "publication.log"), "utf8")).toContain(`status as2/main-full error on ${fx.main} posted`);
	});
	for (const on of [true, false]) test(`main publication failure preserves local error with land-first ${on ? "on" : "off"}`, async () => {
		const w = mainWorld();
		if (!on) landFirst(w.ledger, OWNER_REPO, false);
		openSuccess(w);
		const id = mainRequest(w, fx.main);
		arm(w, id, "result");
		const p = spawnRun(w, id, { AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS: "1200" });
		const held = new Database(w.ledger.db.filename);
		try {
			await reached(w, id, "result");
			held.exec("BEGIN IMMEDIATE");
			go(w, id, "result");
			expect(await p.exited).toBe(START_EXIT.failed);
			expect(JSON.parse(readFileSync(join(w.runs, id, "result.json"), "utf8"))).toMatchObject({ main: true, verdict: "error", reason: expect.stringContaining("result publication failed") });
			expect(calls(w).includes("state=failure -f context=as2/full-suite")).toBe(on);
			if (!on) expect(calls(w)).not.toContain("context=as2/full-suite");
			expect(calls(w)).toContain("state=error -f context=as2/main-full");
			expect(runnerLog(w, id)).toContain("result publication failed");
		} finally {
			if (held.inTransaction) held.exec("ROLLBACK");
			held.close();
			go(w, id, "result");
			await p.exited;
		}
		expect(mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).has(fx.main)).toBe(false);
	});
	test("the prior green test count is an independent belief boundary", async () => {
		const w = mainWorld();
		mainRun(w.ledger, "tr-baseline", fx.main, "green", { exec: { files: 1, treeFiles: 1, tests: 3 } });
		const id = mainRequest(w, fx.head.green);
		expect(await spawnRun(w, id).exited).toBe(0);
		expect(mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).get(fx.head.green)?.verdict).toBe("implausible");
	});
	test("main takes the Mac before waiting PRs; queued older verified workers continue after promotion and coalesce pending targets", async () => {
		const w = mainWorld();
		const owner = workload(w);
		const prId = request(w, owner.wl, owner.slice, PR.green, fx.head.green, 1000);
		const db = lockDbOf(w);
		db.query("INSERT INTO queue (runId, workloadId, requestedAt) VALUES (?, ?, ?)").run(prId, owner.wl, Date.now() - 1000);
		db.close();
		const id = mainRequest(w, fx.main);
		arm(w, id, "phase-full");
		const active = spawnRun(w, id);
		await reached(w, id, "phase-full");
		expect(admit(w, fx.head.red).action).toBe("pending");
		expect(admit(w, fx.head.green).action).toBe("pending");
		expect(admit(w, fx.head.green).action).toBe("pending-same");
		expect(admit(w, fx.main).action).toBe("active");
		const pr = spawnRun(w, prId);
		arm(w, id, "main-published");
		go(w, id, "phase-full");
		await reached(w, id, "main-published");
		expect(marks(w, prId, "acquired")).toEqual([]);
		go(w, id, "main-published");
		expect(await active.exited).toBe(0);
		const next = await until("pending main admission", () => testRuns(w.ledger.entries(STANDING_WORKLOAD_ID)).find((r) => r.request.sha === fx.head.green) ?? null);
		const pendingResult = await resultOf(w, STANDING_WORKLOAD_ID, next.request.runId);
		expect({ verdict: pendingResult.verdict, reason: pendingResult.reason }).toEqual({ verdict: "green", reason: null });
		expect(testRuns(w.ledger.entries(STANDING_WORKLOAD_ID)).some((r) => r.request.sha === fx.head.red)).toBe(false);
		expect(await pr.exited).toBe(0);
		expect((await resultOf(w, owner.wl, prId)).verdict).toBe("green");
		expect(w.ledger.slice(owner.slice)?.state).toBe("done");
		expect(g(w.env.AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT!, "rev-parse", "HEAD")).toBe(fx.control);
		expect(g(realpathSync(join(w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!, "current")), "rev-parse", "HEAD")).toBe(fx.head.green);
		expect(w.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("runner-preflight:")).map((e) => parseRunnerPreflight(e.body)?.ok)).toEqual([true, true, true]);
	});
	test("three inconclusive attempts refuse another admission", () => {
		const w = mainWorld();
		for (let i = 0; i < 3; i++) {
			const id = mainRequest(w, fx.head.exit);
			const q = testRuns(w.ledger.entries(STANDING_WORKLOAD_ID)).find((r) => r.request.runId === id)!.request;
			w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: testRunBody({ ...runnerDiedRun(q, null), main: true }) });
		}
		expect(() => admit(w, fx.head.exit)).toThrow("spent attempt block");
	});
});

describe("verified control promotion and bootstrap (R14/R15/R34)", () => {
	function promoter(w: World) {
		let tag: string | null = null;
		let fail = false;
		let writes = 0;
		const directory = w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!;
		const gh: Gh = (args) => {
			if (args[1] !== "-X") return tag === null
				? { code: 1, stdout: "", stderr: "HTTP 404 Not Found" }
				: { code: 0, stdout: JSON.stringify({ object: { type: "commit", sha: tag } }), stderr: "" };
			const sha = args.find((s) => s.startsWith("sha="))!.slice(4);
			expect(g(realpathSync(join(directory, "current")), "rev-parse", "HEAD")).toBe(sha);
			writes++;
			if (fail) return { code: 1, stdout: "", stderr: "injected tag failure HTTP 502" };
			tag = sha;
			return { code: 0, stdout: "{}", stderr: "" };
		};
		const logs: string[] = [];
		return {
			gh, logs, directory, get tag() { return tag; }, get writes() { return writes; },
			setFail(value: boolean) { fail = value; },
			promote(sha: string, manual = false) { return promoteMain(w.ledger, OWNER_REPO, sha, (s) => logs.push(s), { directory, origin: w.origin, gh, manual }); },
		};
	}
	function next(w: World, parent: string, changes: Record<string, string>): string {
		const work = join(w.root, "commits");
		if (!existsSync(work)) g(w.root, "clone", "-q", w.origin, work);
		g(work, "checkout", "-q", "--detach", parent);
		for (const [path, text] of Object.entries(changes)) {
			mkdirSync(dirname(join(work, path)), { recursive: true });
			writeFileSync(join(work, path), text);
		}
		g(work, "add", "-A");
		g(work, "commit", "-q", "-m", "next verified fixture");
		const sha = g(work, "rev-parse", "HEAD");
		g(work, "push", "-q", w.origin, `${sha}:refs/heads/verified-fixture`);
		return sha;
	}
	test("verified real git promotion publishes root before tag, is idempotent, retains newest three and active current", () => {
		const w = world();
		const p = promoter(w);
		let sha = fx.main;
		const shas: string[] = [];
		for (let i = 0; i < 5; i++) {
			if (i > 0) sha = next(w, sha, { "README.md": `release ${i}\n` });
			mainRun(w.ledger, `tr-release${i}`, sha, "green");
			expect(p.promote(sha)).toEqual({ ok: true, sha, schema: null });
			shas.push(sha);
		}
		expect(p.promote(sha)).toEqual({ ok: true, sha, schema: null });
		expect(p.writes).toBe(5);
		expect(p.tag).toBe(sha);
		expect(readdirSync(p.directory).filter((n) => /^[0-9a-f]{12}$/.test(n)).sort()).toEqual(shas.slice(-3).map((s) => s.slice(0, 12)).sort());
		expect(g(realpathSync(join(p.directory, "current")), "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
		expect(g(join(p.directory, "repo"), "worktree", "list", "--porcelain")).not.toContain(`worktree ${join(p.directory, shas[0]!.slice(0, 12))}\n`);
	});
	test("verified retry after tag failure preserves prior release and repairs without a new verdict", () => {
		const w = world();
		const p = promoter(w);
		mainRun(w.ledger, "tr-oldverified", fx.main, "green");
		expect(p.promote(fx.main).ok).toBe(true);
		mainRun(w.ledger, "tr-newverified", fx.head.green, "green");
		p.setFail(true);
		expect(p.promote(fx.head.green)).toMatchObject({ ok: false, reason: expect.stringContaining("tag failure") });
		expect(p.tag).toBe(fx.main);
		expect(existsSync(join(p.directory, fx.main.slice(0, 12)))).toBe(true);
		expect(g(realpathSync(join(p.directory, "current")), "rev-parse", "HEAD")).toBe(fx.head.green);
		expect(w.ledger.entries(STANDING_WORKLOAD_ID).at(-1)!.body).toContain("verifier-stalled:");
		p.setFail(false);
		expect(p.promote(fx.head.green).ok).toBe(true);
		expect(p.tag).toBe(fx.head.green);
	});
	test("verified rejects missing, red-laundered and implausible verdicts before any filesystem publish", () => {
		const w = world();
		const p = promoter(w);
		mainRun(w.ledger, "tr-redfirst", fx.main, "red");
		mainRun(w.ledger, "tr-laundered", fx.main, "green");
		mainRun(w.ledger, "tr-implausible", fx.head.green, "green", { exec: { files: 1, treeFiles: 10, tests: 1 } });
		for (const sha of [fx.main, fx.head.green, fx.head.red]) expect(p.promote(sha)).toMatchObject({ ok: false, reason: expect.stringContaining("no green believable") });
		expect(existsSync(p.directory)).toBe(false);
		expect(p.writes).toBe(0);
	});
	for (const change of ["schema", "version"] as const) {
		test(`verified automatic ${change} crossing stops at first barrier; manual still requires a verdict`, () => {
			const w = world();
			const p = promoter(w);
			mainRun(w.ledger, "tr-firstverified", fx.main, "green");
			expect(p.promote(fx.main).ok).toBe(true);
			const schema = next(w, fx.main, change === "schema" ? { "ledger/schema.sql": "CREATE TABLE example (id TEXT);\n" } : { "ledger/src/index.ts": "export const SCHEMA_VERSION = 42;\n" });
			const tip = next(w, schema, { "README.md": "past schema\n" });
			mainRun(w.ledger, "tr-postschema", tip, "green");
			expect(p.promote(tip)).toEqual({ ok: true, sha: fx.main, schema });
			expect(p.tag).toBe(fx.main);
			expect(p.promote(schema, true).ok).toBe(false);
			expect(p.promote(tip, true)).toEqual({ ok: true, sha: tip, schema: null });
			expect(p.tag).toBe(tip);
		});
	}
	test("verified guards wrong, dirty, unverified roots, actual helper and bundle SOURCE", () => {
		const w = world();
		const release = verifiedWorld(w);
		const dir = w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!;
		const helper = join(w.libexec, "refresh");
		const gh: Gh = () => ({ code: 0, stdout: JSON.stringify({ object: { type: "commit", sha: fx.control } }), stderr: "" });
		const check = (source = fx.control, root = release) => verifiedPreflight(w.ledger, OWNER_REPO, source, helper, gh, root, dir);
		expect(check()).toEqual([]);
		expect(check(fx.main).join(" ")).toContain("bundle SOURCE");
		expect(check(fx.control, join(dir, "repo")).join(" ")).toContain("not verified/current");
		writeFileSync(join(release, "README.md"), "dirty\n");
		expect(check().join(" ")).toContain("tracked files modified");
		g(release, "checkout", "--", "README.md");
		g(release, "checkout", "-q", "--detach", fx.main);
		expect(check().join(" ")).toContain("no green believable main verdict");
		g(release, "checkout", "-q", "--detach", fx.control);
		writeFileSync(helper, "#!/bin/sh\n# old origin/main helper\n");
		expect(check().join(" ")).toContain("does not fetch refs/tags/as2-verified");
	});
	test("verified older immutable sibling continues after current advances; dirty older code still refuses", () => {
		const w = world();
		const old = verifiedWorld(w);
		const p = promoter(w);
		mainRun(w.ledger, "tr-advancedverified", fx.main, "green");
		expect(p.promote(fx.main).ok).toBe(true);
		expect(verifiedPreflight(w.ledger, OWNER_REPO, fx.main, join(w.libexec, "refresh"), p.gh, old, p.directory)).toEqual([]);
		writeFileSync(join(old, "README.md"), "older but dirty\n");
		expect(verifiedPreflight(w.ledger, OWNER_REPO, fx.main, join(w.libexec, "refresh"), p.gh, old, p.directory).join(" ")).toContain("tracked files modified");
	});
	test("verified runner promotion and manual CLIs smoke real filesystem with injected GitHub, never unverified manual", () => {
		const w = world();
		g(w.checkout, "fetch", "-q", w.origin, fx.control);
		g(w.checkout, "checkout", "-q", "--detach", fx.control);
		w.env.AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT = w.checkout;
		mainRun(w.ledger, "tr-cliverified", fx.main, "green");
		const cli = (script: string, args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { env: w.env, stdout: "pipe", stderr: "pipe" });
		const first = cli(RUNNER, ["promote", "--sha", fx.main]);
		expect({ code: first.exitCode, err: first.stderr.toString() }).toMatchObject({ code: 0 });
		expect(first.stdout.toString().trim()).toBe(`promoted ${fx.main}`);
		expect(cli(RUNNER, ["promote", "--sha", fx.main]).exitCode).toBe(0);
		const manual = join(import.meta.dir, "..", "scripts", "promote-verified.ts");
		expect(cli(manual, [fx.head.red]).exitCode).toBe(START_EXIT.failed);
		expect(cli(manual, [fx.main]).exitCode).toBe(0);
		expect(g(realpathSync(join(w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!, "current")), "rev-parse", "HEAD")).toBe(fx.main);
	});
	test("verified shadow bootstrap earns first G with a refused, never fake ok, preflight", async () => {
		const w = world();
		g(w.checkout, "fetch", "-q", w.origin, fx.control);
		g(w.checkout, "checkout", "-q", "--detach", fx.control);
		w.env.AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT = w.checkout;
		landFirst(w.ledger, OWNER_REPO, false);
		const db = lockDbOf(w);
		let id: string;
		try {
			const a = admitMain(w.ledger, db, w.runs, OWNER_REPO, fx.main, MERGE_TRAIN_BY);
			if (a.action !== "admitted") throw new Error(a.line);
			id = a.runId;
		} finally { db.close(); }
		expect(await spawnRun(w, id!).exited).toBe(0);
		expect(mainVerdicts(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).get(fx.main)?.verdict).toBe("green");
		expect(w.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("runner-preflight:")).map((e) => parseRunnerPreflight(e.body)?.ok)).toEqual([false]);
		expect(g(realpathSync(join(w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!, "current")), "rev-parse", "HEAD")).toBe(fx.main);
	});
	test("verified reconciliation and promotion each wait through healthy work held longer than five seconds and retain final coherence", async () => {
		const w = world();
		const old = verifiedWorld(w);
		landFirst(w.ledger, OWNER_REPO, true);
		mainRun(w.ledger, "tr-racenext", fx.main, "green");
		mainRun(w.ledger, "tr-raceafter", fx.head.green, "green");
		const directory = w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!;
		const next = join(directory, fx.main.slice(0, 12));
		g(join(directory, "repo"), "worktree", "add", "-q", "--detach", next, fx.main);
		const refreshReached = join(w.root, "refresh.reached");
		const refreshGo = join(w.root, "refresh.go");
		const helper = join(w.libexec, "refresh");
		const refresh = readFileSync(helper, "utf8");
		writeFileSync(helper, refresh.replace("set -eu", `set -eu
touch '${refreshReached}'
n=0
while [ ! -f '${refreshGo}' ]; do
	n=$((n+1))
	[ "$n" -lt 1200 ] || { echo 'race fixture refresh release timed out' >&2; exit 72; }
	sleep 0.025
done`));
		// SOURCE must describe the installed barrier helper; only its commit is stale before reconciliation.
		writeSource(w.libexec, { sha: fx.control });
		// Stand in for a publisher holding the same transaction before its atomic current/tag move.
		const publisher = new Database(join(directory, "promotion.db"));
		publisher.exec("BEGIN IMMEDIATE");
		let locked = true;
		const owner = workload(w);
		const id = request(w, owner.wl, owner.slice, PR.green, fx.head.green);
		const runner = spawnRun(w, id, { AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "25" });
		let promotion: Subprocess | null = null;
		try {
			await until("preflight waiting for promotion", () => marks(w, id, "promotion-busy").length > 0);
			const firstBeat = parseHeartbeat(readFileSync(join(w.runs, id, "heartbeat"), "utf8"), id)!;
			await until("heartbeat while promotion is contended", () => parseHeartbeat(readFileSync(join(w.runs, id, "heartbeat"), "utf8"), id)! > firstBeat);
			// Real SQLite contention crosses child processes using Date.now(); fake timers cannot exercise the former five-second timeout.
			await Bun.sleep(5500);
			expect(realpathSync(join(directory, "current"))).toBe(old);
			expect(existsSync(join(w.root, "sudo.log"))).toBe(false);
			symlinkSync(next, join(directory, "next"));
			renameSync(join(directory, "next"), join(directory, "current"));
			writeFileSync(join(w.root, "verified-tag"), fx.main);
			publisher.exec("ROLLBACK");
			locked = false;
			await until("refresh holding reconciliation transaction", () => existsSync(refreshReached));
			// A real publisher must wait while the bundle is still old, not just while tag/current move.
			promotion = Bun.spawn([process.execPath, RUNNER, "promote", "--sha", fx.head.green], { env: w.env, stdout: "pipe", stderr: "pipe" });
			await until("promotion acquiring reconciliation lock", () => marks(w, fx.head.green, "promotion-acquiring").length > 0);
			expect(() => publisher.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
			expect(realpathSync(join(directory, "current"))).toBe(next);
			expect(readFileSync(join(w.root, "verified-tag"), "utf8")).toBe(fx.main);
			// The separate synchronous publisher must also survive a real >5 s refresh holder; child clocks cannot be advanced here.
			await Bun.sleep(5500);
			writeFileSync(refreshGo, "");
			expect(await runner.exited).toBe(0);
			expect(await promotion.exited).toBe(0);
			expect(await resultOf(w, owner.wl, id)).toMatchObject({ verdict: "green", reason: null });
			expect(readFileSync(join(w.libexec, "SOURCE"), "utf8")).toContain(`source-sha ${fx.main}`);
			expect(w.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("runner-preflight:")).map((e) => parseRunnerPreflight(e.body))).toEqual([
				{ ok: true, reason: null, source: fx.main, root: old },
			]);
			expect(readFileSync(join(w.root, "sudo.log"), "utf8").split("\n").filter((s) => s === "refresh")).toHaveLength(1);
			expect(realpathSync(join(directory, "current"))).toBe(join(directory, fx.head.green.slice(0, 12)));
			expect(readFileSync(join(w.root, "verified-tag"), "utf8")).toBe(fx.head.green);
		} finally {
			if (locked) publisher.exec("ROLLBACK");
			publisher.close();
			writeFileSync(refreshGo, "");
			await runner.exited;
			if (promotion !== null) await promotion.exited;
		}
	});

	test("verified reconciliation lock contention is bounded, keeps heartbeats alive, and never refreshes or repoints", async () => {
		const w = world();
		verifiedWorld(w);
		landFirst(w.ledger, OWNER_REPO, true);
		const publisher = new Database(join(w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!, "promotion.db"));
		publisher.exec("BEGIN IMMEDIATE");
		const owner = workload(w);
		const id = request(w, owner.wl, owner.slice, PR.green, fx.head.green);
		const runner = spawnRun(w, id, {
			AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "25",
			AGENT_SYSTEM_TEST_RUNNER_REFRESH_CAP_MS: "25", AGENT_SYSTEM_TEST_RUNNER_REFRESH_GRACE_MS: "25", AGENT_SYSTEM_TEST_RUNNER_REFRESH_REAP_MS: "25",
			AGENT_SYSTEM_TEST_RUNNER_FINALIZE_MS: "1500",
		});
		try {
			await until("bounded reconciliation finishes without releasing the publisher", () => runner.exitCode !== null, 10_000);
			expect(await runner.exited).toBe(0);
			expect(await resultOf(w, owner.wl, id)).toMatchObject({
				verdict: "error", reason: expect.stringContaining("verified reconciliation could not acquire"),
			});
			expect(marks(w, id, "heartbeat").length).toBeGreaterThan(1);
			expect(readFileSync(join(w.root, "verified-tag"), "utf8")).toBe(fx.control);
			expect(existsSync(join(w.root, "sudo.log"))).toBe(false);
			expect(marks(w, id, "spawn-full")).toEqual([]);
		} finally {
			publisher.exec("ROLLBACK");
			publisher.close();
			await runner.exited;
		}
	});

	for (const mode of ["wrong", "dirty", "unverified", "bundle", "repair"] as const) {
		test(`verified runner preflight ${mode} uses real facts and at most one bundle refresh`, async () => {
			const w = world();
			const release = verifiedWorld(w);
			landFirst(w.ledger, OWNER_REPO, true);
			if (mode === "wrong") w.env.AGENT_SYSTEM_TEST_RUNNER_CONTROL_ROOT = resolve(import.meta.dir, "..", "..");
			if (mode === "dirty") writeFileSync(join(release, "README.md"), "dirty\n");
			if (mode === "unverified") g(release, "checkout", "-q", "--detach", fx.main);
			if (mode === "bundle" || mode === "repair") {
				const good = join(w.root, "good-source");
				writeFileSync(join(w.libexec, "refresh"), `#!/bin/sh\n# refs/tags/as2-verified:refs/tags/as2-verified\n${mode === "repair" ? `cp '${good}' '${join(w.libexec, "SOURCE")}'` : ":"}\necho refreshed\n`);
				writeSource(w.libexec, { sha: fx.control, to: good });
				writeSource(w.libexec, { sha: fx.main });
				writeFileSync(join(w.root, "verified-tag"), fx.main);
			}
			const owner = workload(w);
			const id = request(w, owner.wl, owner.slice, PR.green, fx.head.green);
			expect(await spawnRun(w, id).exited).toBe(0);
			const result = await resultOf(w, owner.wl, id);
			expect(result.verdict).toBe(mode === "repair" ? "green" : "error");
			const pre = w.ledger.entries(STANDING_WORKLOAD_ID).find((e) => e.body.startsWith("runner-preflight:"))!;
			expect(parseRunnerPreflight(pre.body)?.ok).toBe(mode === "repair");
			const refreshes = existsSync(join(w.root, "sudo.log")) ? readFileSync(join(w.root, "sudo.log"), "utf8").split("\n").filter((l) => l === "refresh") : [];
			expect(refreshes).toHaveLength(mode === "bundle" || mode === "repair" ? 1 : 0);
			if (mode !== "repair") expect(marks(w, id, "spawn-full")).toEqual([]);
		});
	}
});

test("verified retention preserves an older active rollback as well as the newest three releases", () => {
	const w = world();
	const directory = w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!;
	let tag: string | null = null;
	let failTag = false;
	const gh: Gh = (args) => {
		if (args[1] !== "-X") return tag === null ? { code: 1, stdout: "", stderr: "HTTP 404" } : { code: 0, stdout: JSON.stringify({ object: { type: "commit", sha: tag } }), stderr: "" };
		if (failTag) return { code: 1, stdout: "", stderr: "injected tag outage" };
		tag = args.find((s) => s.startsWith("sha="))!.slice(4);
		return { code: 0, stdout: "{}", stderr: "" };
	};
	const promote = (sha: string, manual = false) => promoteMain(w.ledger, OWNER_REPO, sha, () => {}, { directory, origin: w.origin, gh, manual });
	mainRun(w.ledger, "tr-rollbackbase", fx.main, "green");
	expect(promote(fx.main).ok).toBe(true);
	const work = join(w.root, "rollback-commits");
	g(w.root, "clone", "-q", w.origin, work);
	failTag = true;
	for (let i = 0; i < 3; i++) {
		writeFileSync(join(work, "README.md"), `rollback release ${i}\n`);
		g(work, "add", "-A");
		g(work, "commit", "-q", "-m", `rollback ${i}`);
		const sha = g(work, "rev-parse", "HEAD");
		g(work, "push", "-q", w.origin, `${sha}:refs/heads/rollback-fixture`);
		mainRun(w.ledger, `tr-rollback${i}`, sha, "green");
		expect(promote(sha).ok).toBe(false);
	}
	failTag = false;
	expect(promote(fx.main, true).ok).toBe(true);
	expect(readdirSync(directory).filter((n) => /^[0-9a-f]{12}$/.test(n))).toHaveLength(4);
	expect(realpathSync(join(directory, "current"))).toBe(join(directory, fx.main.slice(0, 12)));
});

test("verified promotion never publishes another served repository's shadow green as control code", async () => {
	const w = world();
	const product = "thewolff/product";
	writeFileSync(w.env.AGENT_SYSTEM_TEST_RUNNER_CONFIG!, readFileSync(w.env.AGENT_SYSTEM_TEST_RUNNER_CONFIG!, "utf8").replace(OWNER_REPO, product));
	landFirst(w.ledger, product, false);
	const db = lockDbOf(w);
	let id: string;
	try {
		const a = admitMain(w.ledger, db, w.runs, product, fx.main, MERGE_TRAIN_BY);
		if (a.action !== "admitted") throw new Error(a.line);
		id = a.runId;
	} finally { db.close(); }
	expect(await spawnRun(w, id!).exited).toBe(0);
	expect((await resultOf(w, STANDING_WORKLOAD_ID, id!)).verdict).toBe("green");
	expect(existsSync(w.env.AGENT_SYSTEM_TEST_RUNNER_VERIFIED!)).toBe(false);
	expect(runnerLog(w, id!)).toContain(`verified promotion skipped for served repository ${product}`);
});

// Review r1 finding 4: release() used to clear `held` before its delete, so a failed delete left the row held and the finally's
// release returned at once. Review r2 finding 2: release then gave up after a 2 s deadline. Either way the next run waited for the
// row's heartbeat to go stale. Both tests run the production release settings (no knob): the release retries until the row would
// be stale for a waiter.
test("runs.db held for 4 s from the first lock-row delete (past the old 2 s deadline): the row goes within 200 ms of the hold's end, and the queued next run takes it within its 2 s poll, not as a stale takeover", async () => {
	const w = world();
	const { wl, slice } = workload(w);
	const runId = request(w, wl, slice, PR.green, fx.head.green);
	const db = lockDbOf(w);
	// the test's own BEGIN IMMEDIATE may meet the waiter's short acquire transaction
	db.exec("PRAGMA busy_timeout = 5000");
	arm(w, runId, "release");
	const kids: Child[] = [spawnRun(w, runId)];
	let holding = false;
	try {
		await reached(w, runId, "release");
		const next = waiter(w, 0);
		kids.push(spawnRun(w, next.id));
		await until("the next run is queued behind the holder", () => marks(w, next.id, "queued").length > 0, 60_000);
		db.exec("BEGIN IMMEDIATE");
		holding = true;
		go(w, runId, "release");
		const first = await until("the first delete fails", () => marks(w, runId, "release-failed")[0], 10_000);
		// A genuine 4 s hold: the subject is the runner process's own clock against a real SQLite lock, which fake timers in this
		// process cannot move; the hold ends 4 s after the runner's first failed delete (its own mark time), not a guessed delay.
		await Bun.sleep(Number(first.at) + 4_000 - Date.now());
		const failedInHold = marks(w, runId, "release-failed").length;
		db.exec("ROLLBACK");
		const heldEnd = Date.now();
		holding = false;
		await kids[0]!.exited;
		expect(kids[0]!.exitCode).toBe(0);
		const log = runnerLog(w, runId);
		expect(log).toMatch(/ the lock release failed: .+; retrying until \S+\n/);
		expect(log).toContain(" lock released\n");
		expect(log).not.toContain("the lock was not released");
		// retried every 50 ms through the whole hold, past where the 2 s deadline gave up
		expect(failedInHold).toBeGreaterThan(40);
		const releasedAt = logAt(log, / lock released$/);
		console.info(`release after a 4 s hold: the row went ${releasedAt - heldEnd} ms after the hold ended`);
		// The 50 ms retry frees the row soon after the hold; the bound only has to tell that apart from the 60 s stale horizon,
		// with room for a loaded machine (a review run beside the full suite saw 600 ms).
		expect(releasedAt - heldEnd).toBeLessThan(2_000);
		expect((await resultOf(w, wl, runId)).verdict).toBe("green");
		await kids[1]!.exited;
		// displaced null: the row was gone when it took the lock, never waited out as a stale holder's
		const took = marks(w, next.id, "acquired");
		expect(took).toEqual([expect.objectContaining({ displaced: null })]);
		expect(Number(took[0]!.at) - releasedAt).toBeLessThan(2_000 + 1_000);
		expect((await resultOf(w, next.wl, next.id)).verdict).toBe("stale");
		expect(lockRow(db)).toBeNull();
	} finally {
		if (holding) db.exec("ROLLBACK");
		go(w, runId, "release");
		await reap(kids);
		db.close();
	}
});

test("the release horizon reached while runs.db stays held (the row's heartbeatAt written 59 s back at the release hook): `the lock was not released` at the horizon, the run exits START_EXIT.failed with its status posted, and the queued run then takes the stale row", async () => {
	const w = world();
	const { wl, slice } = workload(w);
	const runId = request(w, wl, slice, PR.green, fx.head.green);
	const db = lockDbOf(w);
	db.exec("PRAGMA busy_timeout = 5000");
	arm(w, runId, "release");
	const kids: Child[] = [spawnRun(w, runId)];
	let holding = false;
	try {
		await reached(w, runId, "release");
		const next = waiter(w, 0);
		kids.push(spawnRun(w, next.id));
		await until("the next run is queued behind the holder", () => marks(w, next.id, "queued").length > 0, 60_000);
		// From the release hook on, the run's heartbeat leaves the row alone, so this heartbeatAt is the one release reads.
		// 59 s back: still live to the waiter until the hold is in place.
		const beatAt = Date.now() - 59_000;
		expect(db.query("UPDATE lock SET heartbeatAt = ? WHERE runId = ?").run(beatAt, runId).changes).toBe(1);
		db.exec("BEGIN IMMEDIATE");
		holding = true;
		go(w, runId, "release");
		await kids[0]!.exited;
		expect(kids[0]!.exitCode).toBe(START_EXIT.failed);
		const log = runnerLog(w, runId);
		const horizon = beatAt + 60_000;
		expect(log).toContain(` the lock release failed: `);
		expect(log).toContain(`; retrying until ${new Date(horizon).toISOString()}\n`);
		expect(log).toMatch(/ the lock was not released: .+ \(\d+ attempts; the row's heartbeatAt \S+ is stale for a waiter since \S+\); the row holds this run until a waiter takes it\n/);
		expect(log).not.toContain(" lock released\n");
		const gaveUp = logAt(log, / the lock was not released: /);
		// never before a waiter could take the row, and not long after
		expect(gaveUp).toBeGreaterThan(horizon);
		expect(gaveUp - horizon).toBeLessThan(500);
		expect((await resultOf(w, wl, runId)).verdict).toBe("green");
		expect(statusPosts(w)).toEqual([`success ${fx.head.green}`]);
		expect(lockRow(db)).toMatchObject({ runId, heartbeatAt: beatAt });
		db.exec("ROLLBACK");
		holding = false;
		await kids[1]!.exited;
		expect(marks(w, next.id, "acquired")).toEqual([expect.objectContaining({ displaced: runId })]);
		expect(runnerLog(w, next.id)).toContain(` took the lock from the stale holder ${runId}\n`);
		expect((await resultOf(w, next.wl, next.id)).verdict).toBe("stale");
		expect(lockRow(db)).toBeNull();
	} finally {
		if (holding) db.exec("ROLLBACK");
		go(w, runId, "release");
		await reap(kids);
		db.close();
	}
});

// ---- the stuck-worker detector's runner side (PLAN wl-mvq8x4pkjmx69s D4) -----------------------------------

/**
 * The exec stand-in: the fake sudo hands a part call (`full`, `solo`, `base-solo`) to this /bin/sh script instead of the wrapper,
 * with the wrapper's argv (`$1` exec, `$2` sub, `$3` run id, `$4` file); `exec "$@"` runs the real part. Helpers: `sig`, `clr`, `stp`
 * print the exec's `stuck-signature`, `stuck-cleared` and `stuck-stop` lines for a worker and zombie, stamped now (whole seconds,
 * as `date` gives); `survivor` leaves a `/bin/sleep` in its own process group listed in the run's groups file (the groups render's
 * containment) and records its pid in `<root>/survivor.pid`; `holdSweep` pauses every later sweep of the run at `sweep-read1`.
 */
function standIn(w: World, body: string): void {
	const p = join(w.root, "part-standin");
	writeFileSync(p, `#!/bin/sh
here="$(dirname "$0")"
work="$AGENT_SYSTEM_TEST_RUNNER_ROOT/runs/$3"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sig() { echo "stuck-signature $(now) part full worker $1 zombie $2 since 5000 mode enforce bun 1.3.14 abc"; }
clr() { echo "stuck-cleared $(now) part full worker $1 zombie $2 held 800 matched no"; }
stp() { echo "stuck-stop $(now) part full worker $1 zombie $2"; }
survivor() {
	/usr/bin/perl -e 'setpgrp(0, 0); exec @ARGV' /bin/sleep 300 </dev/null >/dev/null 2>&1 &
	echo $! >> "$work/groups"
	echo $! > "$here/survivor.pid"
}
holdSweep() { : > "$AGENT_SYSTEM_TEST_HOOKS/$3.sweep-read1.pause"; }
echo "$$" > "$here/standin.pid"
${body}
`);
	chmodSync(p, 0o755);
}

/** The stuck tests' timer knobs: a 2 s backstop read every 100 ms, a 3 s sweep deadline, containment retried every 300 ms for 20 s. */
const STUCK_KNOBS: Record<string, string> = {
	AGENT_SYSTEM_TEST_RUNNER_STUCK_BACKSTOP_MS: "2000", AGENT_SYSTEM_TEST_RUNNER_STUCK_POLL_MS: "100", AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS: "3000",
	AGENT_SYSTEM_TEST_RUNNER_CONTAIN_RETRY_MS: "300", AGENT_SYSTEM_TEST_RUNNER_STUCK_CONTAIN_MS: "20000",
};
const STOP_REASON = "stuck: worker 4242 spun in Bun.spawnSync with unreaped child 4243";
const pidIn = (w: World, name: string): number => Number(readFileSync(join(w.root, name), "utf8").trim());
/** A `/bin/sleep` in its own process group, as a survivor of an earlier run whose groups file lists it (the groups render). */
function earlierSurvivor(w: World): number {
	const p = Bun.spawn(["/usr/bin/perl", "-e", "setpgrp(0, 0); exec @ARGV", "/bin/sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
	p.unref();
	const earlier = join(w.as2, "runs", makeRunId(Date.now() - 60_000, "surv"));
	mkdirSync(earlier, { recursive: true });
	writeFileSync(join(earlier, "groups"), `${p.pid}\n`);
	return p.pid;
}
const kill = (pid: number): void => {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
};
/** runner.log's time of the first line matching `re`. */
const logAt = (log: string, re: RegExp): number => {
	const line = log.split("\n").find((l) => re.test(l));
	if (!line) throw new Error(`no runner.log line matches ${re}\n--- runner.log ---\n${log}`);
	return Date.parse(line.slice(0, line.indexOf(" ")));
};

describe("the stuck-worker detector's runner side (PLAN wl-mvq8x4pkjmx69s D4)", () => {
	const partsOf = (w: World, runId: string) => subsOf(w, runId).filter((s) => s !== "sweep");

	test("enforce: exit 125 with its stop lines: error with the exec's stuck reason, the junit's failures (a gates/test one) kept and security-red sent, the signature log imported, no solo or base part, the lock released before the status post", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `"$@"
sig 4242 4243
stp 4242 4243
printf 'the signature capture\\n' > "$work/full.signature.log"
echo "stuck-captured $(now) part full file full.signature.log ms 120"
echo "stuck: worker 4242 spun 5200 ms in Bun.spawnSync with unreaped child 4243; 1 process groups killed, containment contained" >&2
exit 125`);
		const runId = request(w, wl, slice, PR.gate, fx.head.gate);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		const reason = "full: stuck: worker 4242 spun 5200 ms in Bun.spawnSync with unreaped child 4243; 1 process groups killed, containment contained";
		expect(run).toMatchObject({ verdict: "error", reason });
		expect(run.full).toMatchObject({ exit: WRAPPER_EXIT.stuck, error: reason.slice("full: ".length) });
		expect(run.failures.map((f) => [f.part, f.name])).toEqual([["full", "gates/test/gate.test.ts > refuses a forged approve"]]);
		expect(heldMessages(w, wl).filter((m) => m.body.startsWith("security-red: ")).map((m) => m.body)).toEqual([
			`security-red: ${wl} ${slice} ${runId} ${fx.head.gate} 1 gates/test/gate.test.ts > refuses a forged approve`,
		]);
		expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full"]);
		expect(readFileSync(join(w.runs, runId, "full.signature.log"), "utf8")).toBe("the signature capture\n");
		const log = runnerLog(w, runId);
		expect(log).toContain("full.signature.log imported");
		expect(log).toContain("stuck detector enforce");
		expect(log).toContain("full part stopped the run: no solo or base parts");
		expect(log).toMatch(/ full tr-[a-z0-9]+ → exit 125\n/);
		// the halt's one sweep, in place of the part's own, then the containment check
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full"]);
		expect(log).toContain("contained after full: no live _as2test process");
		// the lock goes before the status post, and the post says error
		expect(logAt(log, / lock released$/)).toBeLessThanOrEqual(logAt(log, /status as2\/full-suite error on /));
		expect(log.indexOf(" lock released\n")).toBeLessThan(log.indexOf("status as2/full-suite error on "));
		expect(statusPosts(w)).toEqual([`error ${fx.head.gate}`]);
		const db = lockDbOf(w);
		try { expect(lockRow(db)).toBeNull(); } finally { db.close(); }
		expect(w.ledger.slice(slice)!.state).toBe("open");
	});

	test("enforce: a stuck-signature then a stalled exec: the backstop abandons the call at its deadline, SIGKILLs it, one sweep, error `executor stalled during stuck detection`, never a stuck reason", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `sig 4242 4243
exec /bin/sleep 300`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "error", reason: "full: executor stalled during stuck detection; worker 4242 was a candidate, not confirmed" });
		expect(run.reason).not.toContain("stuck:");
		expect(run.full).toMatchObject({ exit: null, error: "executor stalled during stuck detection; worker 4242 was a candidate, not confirmed" });
		const log = runnerLog(w, runId);
		expect(log).toContain("executor-stalled part full worker 4242");
		expect(log).toMatch(/ full tr-[a-z0-9]+ → exit null \(abandoned by the stuck backstop\)\n/);
		// abandoned at the 2 s backstop after the line's (whole-second) time, never left to the 2 min cap
		expect(run.full!.ms).toBeLessThan(6_000);
		expect(alive(pidIn(w, "standin.pid"))).toBe(false);
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full"]);
		expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full"]);
		expect(log).toContain(" lock released\n");
	});

	for (const [what, script] of [
		["a stuck-stop then a stalled exec", "sig 4242 4243\nstp 4242 4243\nexec /bin/sleep 300"],
		["a stop line then stuck-cleared then a stalled exec: the deadline is terminal", "sig 4242 4243\nstp 4242 4243\nclr 4242 4243\nexec /bin/sleep 300"],
	] as const) {
		test(`enforce: ${what}: the backstop fires at its first deadline; stuck, the executor did not finish the stop`, async () => {
			const w = world({ stuckStop: "enforce" });
			const { wl, slice } = workload(w);
			standIn(w, script);
			const runId = request(w, wl, slice, PR.green, fx.head.green);
			await spawnRun(w, runId, STUCK_KNOBS).exited;
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "error", reason: `full: ${STOP_REASON}; executor did not finish the stop` });
			const log = runnerLog(w, runId);
			expect(log).toMatch(/ full tr-[a-z0-9]+ → exit null \(abandoned by the stuck backstop\)\n/);
			expect(log).not.toContain("executor-stalled part");
			expect(run.full!.ms).toBeLessThan(6_000);
			expect(alive(pidIn(w, "standin.pid"))).toBe(false);
			expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full"]);
		});
	}

	test("enforce: overlapping signatures A and B, A cleared, then a stalled exec: B's deadline still fires", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		// One pipe write establishes overlap and clearing A before the watchdog can run.
		// A sleep here can legitimately exhaust A's whole-second 2 s deadline under load.
		standIn(w, `stamp="$(now)"
printf 'stuck-signature %s part full worker 11 zombie 12 since 5000 mode enforce bun 1.3.14 abc\\nstuck-signature %s part full worker 21 zombie 22 since 5000 mode enforce bun 1.3.14 abc\\nstuck-cleared %s part full worker 11 zombie 12 held 800 matched no\\n' "$stamp" "$stamp" "$stamp"
exec /bin/sleep 300`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "error", reason: "full: executor stalled during stuck detection; worker 21 was a candidate, not confirmed" });
		expect(runnerLog(w, runId)).toContain("executor-stalled part full worker 21");
	});

	test("enforce: a signature then stuck-cleared disarms the backstop: the part runs on past the deadline, green", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `sig 4242 4243
clr 4242 4243
sleep 4
exec "$@"`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("green");
		expect(run.full!.ms).toBeGreaterThanOrEqual(4_000);
		const log = runnerLog(w, runId);
		expect(log).not.toContain("abandoned by the stuck backstop");
		expect(log).toContain(" lock released\n");
	});

	test("shadow, the default: the backstop is never armed, a signature with no clear runs on past its deadline, green", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		standIn(w, `sig 4242 4243
sleep 4
exec "$@"`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("green");
		const log = runnerLog(w, runId);
		expect(log).toContain("stuck detector shadow");
		expect(log).not.toContain("abandoned by the stuck backstop");
	});

	test("a stop line then a signal exit is still stuck", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `stp 4242 4243
kill -KILL $$`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "error", reason: `full: ${STOP_REASON}` });
		expect(run.full!.exit).toBeNull();
		expect(runnerLog(w, runId)).toMatch(/ full tr-[a-z0-9]+ → SIGKILL\n/);
		expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full"]);
	});

	test("a stuck solo part ends the run: no base part; the full part's failures stay", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `[ "$2" = solo ] || exec "$@"
stp 7 8
exit 125`);
		const runId = request(w, wl, slice, PR.red, fx.head.red);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "error", reason: "./red.test.ts: stuck: worker 7 spun in Bun.spawnSync with unreaped child 8" });
		expect(run.failures.filter((f) => f.part === "full")).toHaveLength(25);
		expect(run.solo).toEqual([expect.objectContaining({ file: "./red.test.ts", exit: 125, error: "stuck: worker 7 spun in Bun.spawnSync with unreaped child 8" })]);
		expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full", "solo"]);
		expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish", "full", "solo-1"]);
	});

	test("a stuck base-solo part ends the run with its stuck reason; its result is not cached", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `[ "$2" = base-solo ] || exec "$@"
stp 7 8
exit 125`);
		const runId = request(w, wl, slice, PR.red, fx.head.red);
		await spawnRun(w, runId, STUCK_KNOBS).exited;
		const run = await resultOf(w, wl, runId);
		expect(run).toMatchObject({ verdict: "error", reason: "base ./red.test.ts: stuck: worker 7 spun in Bun.spawnSync with unreaped child 8" });
		expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full", "solo", "base-prepare", "base-solo"]);
		expect(cached(w, fx.main, "./red.test.ts")).toBe(false);
	});

	test("a held sweep and a held head re-check stop at their shared deadlines (the stuck sweep deadline, STUCK_FINALIZE_MS); the paused sweep is abandoned and killed", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `holdSweep "$@"
stp 4242 4243
exit 125`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		arm(w, runId, "head-recheck");
		await spawnRun(w, runId, { ...STUCK_KNOBS, AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS: "1500", AGENT_SYSTEM_TEST_RUNNER_STUCK_FINALIZE_MS: "1500" }).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("error");
		expect(run.reason).toStartWith(`full: ${STOP_REASON}; `);
		expect(run.reason).toContain("post-sweep deadline exceeded");
		const log = runnerLog(w, runId);
		expect(log).toContain("the sweep after full was abandoned at its deadline");
		const paused = JSON.parse(readFileSync(`${hookBase(w, runId, "sweep-read1")}.reached`, "utf8")) as { pid: number };
		expect(alive(paused.pid)).toBe(false);
		const stuckAt = logAt(log, / full tr-[a-z0-9]+ → exit 125$/);
		const started = logAt(log, /post-sweep finalization started/);
		const deadline = Date.parse(/post-sweep finalization started; deadline (\S+)/.exec(log)![1]!);
		expect(started - stuckAt).toBeLessThan(1500 + 1000);
		expect(deadline - started).toBeLessThanOrEqual(1500);
		expect(logAt(log, / lock released$/) - stuckAt).toBeLessThan(1500 + 1500 + 2000);
	});

	// Review r1 finding 2: the post-stuck sweep's ownership checkpoint used to wait out publishIfOwner's busyLoop (12 busy_timeouts,
	// about 60 s at the production 5 s) before the shared sweep deadline was even read.
	test("runs.db held from the stuck part's end through its sweep's ownership checkpoint: the checkpoint gives up at the sweep deadline, and the lock is released within the sweep deadline + STUCK_FINALIZE_MS + slack", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `while [ ! -f "$here/held" ]; do sleep 0.05; done
stp 4242 4243
exit 125`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		const sweepMs = 1500;
		const finalizeMs = 1500;
		const db = lockDbOf(w);
		// The production busy_timeout, so a checkpoint that waits on runs.db synchronously waits far past every deadline here.
		const child = spawnRun(w, runId, {
			...STUCK_KNOBS, AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS: String(sweepMs), AGENT_SYSTEM_TEST_RUNNER_STUCK_FINALIZE_MS: String(finalizeMs), AGENT_SYSTEM_TEST_RUNNER_BUSY_MS: "5000",
		});
		const gaveUp = / the sweep after full: runs\.db stayed busy through \d+ ownership checkpoint attempts until the deadline \S+; going on without it$/m;
		let holding = false;
		try {
			await until("the stand-in started", () => existsSync(join(w.root, "standin.pid")), 60_000);
			db.exec("BEGIN IMMEDIATE");
			holding = true;
			writeFileSync(join(w.root, "held"), "");
			await until("the runner saw the stuck exit", () => / full tr-[a-z0-9]+ → exit 125$/m.test(runnerLog(w, runId)), 60_000);
			// Held until the checkpoint gives up, or for the whole bound when it never does.
			const heldUntil = Date.now() + sweepMs + finalizeMs + 2000;
			await until("the checkpoint gives up or the bound passes", () => gaveUp.test(runnerLog(w, runId)) || Date.now() >= heldUntil, 60_000);
			db.exec("ROLLBACK");
			holding = false;
			await child.exited;
			const run = await resultOf(w, wl, runId);
			expect(run.verdict).toBe("error");
			expect(run.reason).toStartWith(`full: ${STOP_REASON}`);
			const log = runnerLog(w, runId);
			const stuckAt = logAt(log, / full tr-[a-z0-9]+ → exit 125$/);
			expect(logAt(log, / lock released$/) - stuckAt).toBeLessThan(sweepMs + finalizeMs + 2000);
			expect(log).toMatch(gaveUp);
			expect(logAt(log, gaveUp) - stuckAt).toBeLessThan(sweepMs + 1000);
			expect(marks(w, runId, "checkpoint-busy").length).toBeGreaterThan(0);
			// no sweep ran after the stuck part: its deadline passed in the checkpoint; the containment check judged what was left
			expect(marks(w, runId, "sweep").map((x) => x.after)).toEqual(["publish"]);
			expect(log).toContain("contained after full: no live _as2test process");
			expect(lockRow(db)).toBeNull();
		} finally {
			if (holding) db.exec("ROLLBACK");
			writeFileSync(join(w.root, "held"), "");
			await child.exited;
			db.close();
		}
	});

	// Review r1 finding 3 (R5, whatever the wrapper's ending): a stuck call the wrapper then ended 70 or 64 used to import nothing.
	for (const code of [WRAPPER_EXIT.failed, WRAPPER_EXIT.refused]) {
		test(`a stop line then exit ${code}: the partial junit's gates/test failure is kept and security-red sent; error with the stuck reason`, async () => {
			const w = world({ stuckStop: "enforce" });
			const { wl, slice } = workload(w);
			standIn(w, `"$@"
stp 4242 4243
exit ${code}`);
			const runId = request(w, wl, slice, PR.gate, fx.head.gate);
			await spawnRun(w, runId, STUCK_KNOBS).exited;
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "error", reason: `full: ${STOP_REASON}` });
			expect(run.full).toMatchObject({ exit: code, error: STOP_REASON });
			expect(run.failures.map((f) => [f.part, f.name])).toEqual([["full", "gates/test/gate.test.ts > refuses a forged approve"]]);
			expect(heldMessages(w, wl).filter((m) => m.body.startsWith("security-red: ")).map((m) => m.body)).toEqual([
				`security-red: ${wl} ${slice} ${runId} ${fx.head.gate} 1 gates/test/gate.test.ts > refuses a forged approve`,
			]);
			expect(readFileSync(join(w.runs, runId, "full.xml"), "utf8")).toContain("refuses a forged approve");
			expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full"]);
			expect(runnerLog(w, runId)).toMatch(new RegExp(` full tr-[a-z0-9]+ → exit ${code}\\n`));
		});
	}

	test("containment (groups render): a survivor left by the stand-in is found by the check, killed by the retry after the stalled sweep was abandoned, then contained", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `holdSweep "$@"
survivor
stp 4242 4243
exit 125`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		const child = spawnRun(w, runId, { ...STUCK_KNOBS, AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS: "1500" });
		try {
			await until("the check finds the survivor", () => /not contained after full: live _as2test processes \d+/.test(runnerLog(w, runId)), 60_000);
			const survivor = pidIn(w, "survivor.pid");
			expect(runnerLog(w, runId)).toContain(`not contained after full: live _as2test processes ${survivor}`);
			expect(alive(survivor)).toBe(true);
			// The sweep that stalled was abandoned at its deadline; let the retries through.
			go(w, runId, "sweep-read1");
			await child.exited;
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "error", reason: `full: ${STOP_REASON}` });
			expect(alive(survivor)).toBe(false);
			const log = runnerLog(w, runId);
			expect(log).toContain("the sweep after full was abandoned at its deadline");
			expect(log).toContain("contained after full: no live _as2test process");
			expect(log).not.toContain("stuck-containment-failed");
			expect(marks(w, runId, "sweep").filter((x) => x.after === "full").length).toBeGreaterThanOrEqual(2);
		} finally {
			go(w, runId, "sweep-read1");
			if (existsSync(join(w.root, "survivor.pid"))) kill(pidIn(w, "survivor.pid"));
			await child.exited;
		}
	});

	test("containment: a survivor that outlives STUCK_CONTAIN_MS: `containment failed` in the reason and the status, stuck-containment-failed logged, the lock released", async () => {
		const w = world({ stuckStop: "enforce" });
		const { wl, slice } = workload(w);
		standIn(w, `holdSweep "$@"
survivor
stp 4242 4243
exit 125`);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		try {
			await spawnRun(w, runId, { ...STUCK_KNOBS, AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS: "800", AGENT_SYSTEM_TEST_RUNNER_STUCK_CONTAIN_MS: "2500" }).exited;
			const survivor = pidIn(w, "survivor.pid");
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "error", reason: `full: ${STOP_REASON}; containment failed: ${survivor}` });
			const log = runnerLog(w, runId);
			expect(log).toContain(`stuck-containment-failed part full pids ${survivor}\n`);
			expect(log).toContain(" lock released\n");
			const db = lockDbOf(w);
			try { expect(lockRow(db)).toBeNull(); } finally { db.close(); }
			expect(statusPosts(w)).toEqual([`error ${fx.head.green}`]);
			expect(readFileSync(join(w.root, "gh.log"), "utf8")).toContain(`description=full suite error, run ${runId}, containment failed`);
			expect(alive(survivor)).toBe(true);
		} finally {
			if (existsSync(join(w.root, "survivor.pid"))) kill(pidIn(w, "survivor.pid"));
		}
	});

	test("the admission gate: a live survivor of an earlier run before the first part: retried, then `admission refused` with no part run", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const survivor = earlierSurvivor(w);
		try {
			const runId = request(w, wl, slice, PR.green, fx.head.green);
			await spawnRun(w, runId, { ...STUCK_KNOBS, AGENT_SYSTEM_TEST_RUNNER_ADMIT_MS: "1500" }).exited;
			const run = await resultOf(w, wl, runId);
			expect(run).toMatchObject({ verdict: "error", reason: `admission refused: live _as2test processes ${survivor}`, full: null });
			// no exec part call, nor anything after the gate: sweeps only
			expect(new Set(subsOf(w, runId))).toEqual(new Set(["sweep"]));
			expect(subsOf(w, runId).length).toBeGreaterThanOrEqual(2);
			const log = runnerLog(w, runId);
			expect(log).toContain(`admission: live _as2test processes ${survivor}; sweeping and checking again`);
			expect(log).toContain(` admission refused: live _as2test processes ${survivor}\n`);
			expect(log).toContain(" lock released\n");
			expect(alive(survivor)).toBe(true);
		} finally {
			kill(survivor);
		}
	});

	test("the admission gate: a survivor gone after one retry: the run is admitted and runs normally", async () => {
		const w = world();
		const { wl, slice } = workload(w);
		const survivor = earlierSurvivor(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		const child = spawnRun(w, runId, STUCK_KNOBS);
		try {
			await until("the gate finds the survivor", () => runnerLog(w, runId).includes(`admission: live _as2test processes ${survivor}; sweeping and checking again`), 60_000);
			kill(survivor);
			await child.exited;
			const run = await resultOf(w, wl, runId);
			expect(run.verdict).toBe("green");
			expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full"]);
			expect(runnerLog(w, runId)).not.toContain("admission refused");
		} finally {
			kill(survivor);
			await child.exited;
		}
	});

	test("the admission gate (uid render): a live process of the uid is found by the spawn-free check", async () => {
		// The test install's _as2test account is this user, so its own processes (this test's among them) are live ones of the uid.
		const w = world();
		const { wl, slice } = workload(w);
		const runId = request(w, wl, slice, PR.green, fx.head.green);
		await spawnRun(w, runId, { ...STUCK_KNOBS, AGENT_SYSTEM_TEST_RUNNER_CONTAIN_SCOPE: "uid", AGENT_SYSTEM_TEST_RUNNER_ADMIT_MS: "600" }).exited;
		const run = await resultOf(w, wl, runId);
		expect(run.verdict).toBe("error");
		expect(run.reason).toStartWith("admission refused: live _as2test processes ");
		expect(run.reason!.slice("admission refused: live _as2test processes ".length).split(",")).toContain(String(process.pid));
		expect(partsOf(w, runId)).toEqual([]);
	});

	test("end to end (real exec, enforce): the spin fixture's full part is stopped by the executor: error with the stuck reason, no solo or base call, the signature log imported, contained, the lock released, and the queued run takes the lock within the knobs' bound", async () => {
		// The executor's knobs (groups render) and the runner's stuck timers, each enforcing one stage of PLAN § Budget.
		const detect = { detectTickMs: 250, detectPersistMs: 2_000, signatureCaptureMs: 3_000, stopGraceMs: 1_000 };
		const sweepMs = 5_000;
		const finalizeMs = 5_000;
		const queuePollMs = 2_000;
		const exitSeenMs = 1_000;
		const slackMs = 5_000;
		const knobs: Record<string, string> = {
			...STUCK_KNOBS,
			// production's formula over these knobs: the backstop stays behind an executor that is alive and ticking
			AGENT_SYSTEM_TEST_RUNNER_STUCK_BACKSTOP_MS: String(detect.detectPersistMs + detect.signatureCaptureMs + detect.stopGraceMs + STUCK_DEFAULTS.verifyMs + 5_000),
			AGENT_SYSTEM_TEST_RUNNER_STUCK_POLL_MS: "250",
			AGENT_SYSTEM_TEST_RUNNER_STUCK_SWEEP_MS: String(sweepMs), AGENT_SYSTEM_TEST_RUNNER_STUCK_FINALIZE_MS: String(finalizeMs),
			AGENT_SYSTEM_TEST_RUNNER_POLL_MS: String(queuePollMs),
		};
		const boundMs = detect.detectTickMs + detect.detectPersistMs + detect.signatureCaptureMs + detect.stopGraceMs + STUCK_DEFAULTS.verifyMs + exitSeenMs
			+ sweepMs + finalizeMs + queuePollMs + slackMs;
		const w = world({ stuckStop: "enforce", fullWorkers: 2, capMin: 1, detect });
		const first = workload(w);
		const second = workload(w);
		const runId = request(w, first.wl, first.slice, PR.spin, fx.head.spin, 1_000);
		Bun.sleepSync(5);
		const nextId = request(w, second.wl, second.slice, PR.green, fx.head.green);
		const kids: Child[] = [];
		let pgids: number[] = [];
		try {
			kids.push(spawnRun(w, runId, knobs));
			await until(`${runId} took the lock`, () => / took the lock\n/.test(runnerLog(w, runId)), 60_000);
			kids.push(spawnRun(w, nextId, knobs));
			await until(`${nextId} queued behind ${runId}`, () => marks(w, nextId, "queued").length >= 1, 60_000);
			await kids[0]!.exited;
			const run = await resultOf(w, first.wl, runId);
			const log = runnerLog(w, runId);
			// The executor's own lines, echoed into runner.log after the call: the first signature, the stop, the capture and the kill.
			const sig = /^stuck-signature (\S+) part full worker (\d+) zombie (\d+) /m.exec(log);
			expect(sig).not.toBeNull();
			const [, sigIso, worker, zombie] = sig!;
			expect(log).toMatch(new RegExp(`^stuck-stop \\S+ part full worker ${worker} zombie ${zombie}`, "m"));
			expect(log).toMatch(/^stuck-captured \S+ part full file full\.signature\.log ms \d+$/m);
			const killed = /^stuck-killed \S+ part full pgids ([\d,]+) ms \d+ contained$/m.exec(log);
			expect(killed).not.toBeNull();
			pgids = killed![1]!.split(",").map(Number);
			// error with the exec's stuck reason, never a timeout
			expect(run.verdict).toBe("error");
			expect(run.reason).toMatch(new RegExp(`^full: stuck: worker ${worker} spun \\d+ ms in Bun\\.spawnSync with unreaped child ${zombie}; ${pgids.length} process groups killed, containment contained$`));
			expect(run.reason).not.toContain("timeout");
			expect(run.full).toMatchObject({ exit: WRAPPER_EXIT.stuck });
			// no solo or base-solo call
			expect(partsOf(w, runId)).toEqual(["probe", "prepare", "full"]);
			expect(log).toContain("full part stopped the run: no solo or base parts");
			// the signature log imported into the run dir
			expect(log).toContain("full.signature.log imported");
			expect(readFileSync(join(w.runs, runId, "full.signature.log"), "utf8")).toContain(`signature capture of full: worker ${worker} spun `);
			// containment passed: the runner's check, and no process or group of the part is alive
			expect(log).toContain("contained after full: no live _as2test process");
			expect(log).not.toContain("stuck-containment-failed");
			for (const pid of [Number(worker), Number(zombie)]) expect({ pid, alive: alive(pid) }).toEqual({ pid, alive: false });
			for (const g of pgids) expect({ g, alive: alive(-g) }).toEqual({ g, alive: false });
			expect(log).toContain(" lock released\n");
			// the queued run takes the lock within the bound, measured from the first signature
			await kids[1]!.exited;
			const next = await resultOf(w, second.wl, nextId);
			const tookAt = logAt(runnerLog(w, nextId), / took the lock$/);
			const intervalMs = tookAt - Date.parse(sigIso!);
			console.log(`e2e stuck: first stuck-signature ${sigIso} → next run took the lock ${new Date(tookAt).toISOString()}: ${intervalMs} ms (bound ${boundMs} ms)`);
			expect(intervalMs).toBeGreaterThan(0);
			expect(intervalMs).toBeLessThanOrEqual(boundMs);
			expect(tookAt).toBeGreaterThanOrEqual(logAt(log, / lock released$/));
			expect(next.verdict).toBe("green");
		} finally {
			await reap(kids);
			for (const g of pgids) kill(-g);
		}
	}, 240_000);
});

// ---- the budget proof (PLAN wl-mvq8x4pkjmx69s § Budget, R7, R8; sl-sd-proof) ---------------------------------------

/**
 * The runner's production stuck timers (test-runner.ts defaults, which these tests never override): one deadline over the stuck
 * sweep's attempts, the stuck run's post-sweep deadline, and the backstop after an enforce signature's line (persist + capture +
 * grace + verify + STUCK_SLACK_MS 5 s, from STUCK_DEFAULTS). The bounds are PLAN § Budget's: 45 s on the contained path (R8) and
 * on the slow-cleanup path, and the stalled path's 42.5 s plus 2 s of measurement slack.
 */
const PROOF = {
	sweepMs: 12_000,
	finalizeMs: 12_000,
	backstopMs: STUCK_DEFAULTS.persistMs + STUCK_DEFAULTS.signatureCaptureMs + STUCK_DEFAULTS.stopGraceMs + STUCK_DEFAULTS.verifyMs + 5_000,
	boundMs: 45_000,
	stalledBoundMs: 42_500 + 2_000,
} as const;
/** The executor's first signature line, in the part's stdout and in runner.log's echo of it. */
const SIG_LINE = /^stuck-signature (\S+) part full worker (\d+) zombie (\d+) /;

/**
 * The end-to-end world with nothing set but what it needs to run: no detector knob in the wrapper's config (tick 1 s, persist 5 s,
 * capture 3 s, grace 1.5 s, verify 2 s: STUCK_DEFAULTS) and no runner timer override. Set: enforce (the path under proof);
 * `fullWorkers: 2` (the spin fixture's worker under --parallel, as the end-to-end test); the sweep's production SIGTERM grace and
 * sweep-lock wait (as2test.ts KILL_GRACE_MS 10 s, SWEEP_LOCK_WAIT_MS 60 s) in place of world()'s 300 ms and 30 s; world()'s runner
 * heartbeat, lock-wait poll and busy timeout removed, so the runner runs its defaults (15 s, 2 s, 5 s); and a runner TMPDIR inside
 * the world, so the test reads the full part's stdout file (run()'s `as2-runner-command-*` dir) while the call runs.
 */
function proofWorld(): World {
	return productionTimers(world({ stuckStop: "enforce", fullWorkers: 2, killGraceMs: KILL_GRACE_MS, sweepLockWaitMs: SWEEP_LOCK_WAIT_MS }));
}

/** world()'s runner heartbeat, lock-wait poll and busy timeout removed (the runner's defaults run) and a runner TMPDIR inside the world. */
function productionTimers(w: World): World {
	for (const k of ["AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS", "AGENT_SYSTEM_TEST_RUNNER_POLL_MS", "AGENT_SYSTEM_TEST_RUNNER_BUSY_MS"]) delete w.env[k];
	w.env.TMPDIR = join(w.root, "runner-tmp");
	mkdirSync(w.env.TMPDIR);
	return w;
}

/** The first line matching `re` (the first `stuck-signature` by default) in a running call's stdout file under the world's runner TMPDIR, once one shows. */
function signatureInStdout(w: World, re: RegExp = SIG_LINE): RegExpExecArray | null {
	const dir = w.env.TMPDIR!;
	for (const name of readdirSync(dir)) {
		if (!name.startsWith("as2-runner-command-")) continue;
		let text: string;
		try {
			text = readFileSync(join(dir, name, "stdout"), "utf8");
		} catch (e) {
			// run() removes its dir when the call returns
			if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw e;
		}
		const m = new RegExp(re.source, "m").exec(text);
		if (m) return m;
	}
	return null;
}

/** Every process of this uid now; the spawn-free sysctl list the runner's containment check reads. */
function uidProcs(): Proc[] {
	const uid = process.getuid!();
	const s = snapshot(uid);
	if (s.kind !== "ok") throw new Error(`budget proof: the process list of uid ${uid} is ${s.kind}: ${s.why}`);
	return s.procs;
}
/** The executor and every process descended from it now, by (pid, start). */
function execTree(execPid: number): Proc[] {
	const procs = uidProcs();
	const tree = procs.filter((p) => p.pid === execPid);
	if (tree.length === 0) throw new Error(`budget proof: the executor ${execPid} is not among this uid's processes`);
	for (let i = 0; i < tree.length; i++) for (const p of procs) if (p.ppid === tree[i]!.pid && !tree.includes(p)) tree.push(p);
	return tree;
}
/** The members of `tree` still alive (same pid and start time, not a zombie). */
const survivorsOf = (tree: Proc[]): Proc[] => uidProcs().filter((p) => !p.zombie && tree.some((t) => t.pid === p.pid && t.startUs === p.startUs));

/** A line's time: an executor line carries its ISO time after the keyword, a runner.log line leads with it. */
function timeOf(line: string): number {
	const [a, b] = line.split(" ");
	const t = Date.parse(/^\d/.test(a!) ? a! : b!);
	if (Number.isNaN(t)) throw new Error(`budget proof: no time in the line ${JSON.stringify(line)}`);
	return t;
}
/** The first line matching `re` at or after line `from`, with its time and match. */
function lineAt(lines: string[], re: RegExp, from = 0): { at: number; i: number; m: RegExpExecArray } {
	for (let i = from; i < lines.length; i++) {
		const m = re.exec(lines[i]!);
		if (m) return { at: timeOf(lines[i]!), i, m };
	}
	throw new Error(`budget proof: no line after line ${from} matches ${re}\n--- runner.log ---\n${lines.join("\n")}`);
}
/** Prints each stage (`budget-proof <path> stage …`) and the total (`budget-proof <path> total <ms> ms bound <ms> ms`); returns the total. */
function printStages(path: string, stages: [name: string, at: number][], boundMs: number): number {
	const t0 = stages[0]![1];
	let prev = t0;
	for (const [name, at] of stages) {
		console.log(`budget-proof ${path} stage ${name.padEnd(36)} ${new Date(at).toISOString()} +${String(at - t0).padStart(5)} ms (step ${at - prev} ms)`);
		prev = at;
	}
	const total = stages.at(-1)![1] - t0;
	console.log(`budget-proof ${path} total ${total} ms bound ${boundMs} ms ${total <= boundMs ? "within" : "OVER"}`);
	return total;
}

interface Proof {
	w: World;
	first: { wl: string; slice: string };
	second: { wl: string; slice: string };
	runId: string;
	nextId: string;
	kids: Child[];
	/** The full call's spawned pid: the executor itself (the fake sudo, the wrapper and `env -i` each exec in place). */
	execPid: number;
	/** When the test SIGSTOPped the executor (the stalled path), else null. */
	stoppedAt: number | null;
}

/**
 * The end-to-end shape on the proof world: the spin PR's run takes the lock, a green run queues behind it, the full part's executor
 * is found by the runner's `spawn-full` hook mark, and once its stdout shows the first `stuck-signature` the executor's process tree
 * is recorded (and with `stallExec` the executor is SIGSTOPped, so no stop line follows). `holdCleanup` arms the runner's
 * `head-recheck` hook before the run and the wrapper's `sweep-read1` once the full part has started (after the publish sweep), so
 * the stuck sweep and the head re-check each run to their deadline. Afterwards, pass or fail: every child resumed and killed, and
 * every member of the executor's tree still alive printed and SIGKILLed (a groups-mode sweep never reaches a --parallel worker's
 * group; production's uid sweep does), then checked gone; a check failure and a cleanup failure are both thrown.
 */
async function withProof(path: string, o: { stallExec?: boolean; holdCleanup?: boolean }, check: (p: Proof) => Promise<void>): Promise<void> {
	const w = proofWorld();
	const first = workload(w);
	const second = workload(w);
	const runId = request(w, first.wl, first.slice, PR.spin, fx.head.spin, 1_000);
	Bun.sleepSync(5);
	const nextId = request(w, second.wl, second.slice, PR.green, fx.head.green);
	const kids: Child[] = [];
	let execPid: number | null = null;
	let tree: Proc[] = [];
	const errors: unknown[] = [];
	try {
		if (o.holdCleanup) arm(w, runId, "head-recheck");
		kids.push(spawnRun(w, runId));
		await until(`${runId} took the lock`, () => / took the lock\n/.test(runnerLog(w, runId)), 60_000);
		kids.push(spawnRun(w, nextId));
		await until(`${nextId} queued behind ${runId}`, () => marks(w, nextId, "queued").length >= 1, 60_000);
		execPid = (await until(`${runId}'s full call`, () => marks(w, runId, "spawn-full")[0], 120_000)).pid as number;
		if (o.holdCleanup) arm(w, runId, "sweep-read1");
		await until(`the first stuck-signature in ${runId}'s full stdout`, () => signatureInStdout(w), 120_000);
		tree = execTree(execPid);
		let stoppedAt: number | null = null;
		if (o.stallExec) {
			process.kill(execPid, "SIGSTOP");
			stoppedAt = Date.now();
		}
		await check({ w, first, second, runId, nextId, kids, execPid, stoppedAt });
	} catch (e) {
		errors.push(e);
	}
	try {
		if (o.holdCleanup) go(w, runId, "sweep-read1");
		if (tree.length === 0 && execPid !== null && alive(execPid)) tree = execTree(execPid);
		await reap(kids);
		const left = survivorsOf(tree);
		if (left.length > 0) console.log(`budget-proof ${path} left alive after the run: ${left.map((p) => `${p.pid} (${p.comm}, pgid ${p.pgid})`).join(", ")}; killing`);
		for (const p of left) {
			try {
				process.kill(p.pid, "SIGCONT");
				process.kill(p.pid, "SIGKILL");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
			}
		}
		await until(`no process of ${runId}'s executor tree alive`, () => survivorsOf(tree).length === 0, 10_000);
	} catch (e) {
		errors.push(e);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, `budget proof ${path}: the check and its cleanup both failed`);
}

describe.if(process.env.AS2_STUCK_BUDGET_PROOF === "1")("budget proof with production defaults (budget-proof.sh)", () => {
	const partsOf = (w: World, runId: string) => subsOf(w, runId).filter((s) => s !== "sweep");
	/** The queued run's end: green, and the time it took the lock. */
	async function nextTook(p: Proof): Promise<number> {
		await p.kids[1]!.exited;
		const next = await resultOf(p.w, p.second.wl, p.nextId);
		expect(next.verdict).toBe("green");
		return lineAt(runnerLog(p.w, p.nextId).split("\n"), / took the lock$/).at;
	}

	test("contained path: the executor stops the spin worker; first stuck-signature → the next run took the lock within 45 s", async () => {
		await withProof("contained", {}, async (p) => {
			await p.kids[0]!.exited;
			const run = await resultOf(p.w, p.first.wl, p.runId);
			const lines = runnerLog(p.w, p.runId).split("\n");
			const sig = lineAt(lines, SIG_LINE);
			const [, , worker, zombie] = sig.m;
			const stop = lineAt(lines, new RegExp(`^stuck-stop \\S+ part full worker ${worker} zombie ${zombie}`));
			const captured = lineAt(lines, /^stuck-captured \S+ part full file full\.signature\.log ms \d+$/);
			const killed = lineAt(lines, /^stuck-killed \S+ part full pgids ([\d,]+) ms \d+ contained$/);
			const exit = lineAt(lines, / full tr-[a-z0-9]+ → exit 125$/);
			const swept = lineAt(lines, / sweep tr-[a-z0-9]+ → |the sweep after full (was abandoned|did not finish|failed)/, exit.i);
			const contained = lineAt(lines, / contained after full: no live _as2test process$/, exit.i);
			const released = lineAt(lines, / lock released$/, exit.i);
			const took = await nextTook(p);
			const total = printStages("contained", [
				["first stuck-signature", sig.at], ["stuck-stop", stop.at], ["stuck-captured", captured.at], ["stuck-killed", killed.at],
				["exec exit seen (125)", exit.at], ["sweep done", swept.at], ["contained", contained.at], ["lock released", released.at],
				["next run took the lock", took],
			], PROOF.boundMs);
			expect(run.verdict).toBe("error");
			expect(run.reason).toMatch(new RegExp(`^full: stuck: worker ${worker} spun \\d+ ms in Bun\\.spawnSync with unreaped child ${zombie}; \\d+ process groups killed, containment contained$`));
			expect(run.full).toMatchObject({ exit: WRAPPER_EXIT.stuck });
			expect(partsOf(p.w, p.runId)).toEqual(["probe", "prepare", "full"]);
			expect(lines[swept.i]).toMatch(/ sweep tr-[a-z0-9]+ → exit 0$/);
			expect(lines.join("\n")).not.toContain("stuck-containment-failed");
			expect(took).toBeGreaterThanOrEqual(released.at);
			expect(total).toBeLessThanOrEqual(PROOF.boundMs);
		});
	}, 240_000);

	test("stalled-executor path: the executor SIGSTOPped after its first stuck-signature: the backstop abandons the call, error `executor stalled during stuck detection`, the next run took the lock within 42.5 s + 2 s", async () => {
		await withProof("stalled", { stallExec: true }, async (p) => {
			await p.kids[0]!.exited;
			const run = await resultOf(p.w, p.first.wl, p.runId);
			const log = runnerLog(p.w, p.runId);
			const lines = log.split("\n");
			const sig = lineAt(lines, SIG_LINE);
			const worker = sig.m[2]!;
			const abandoned = lineAt(lines, / full tr-[a-z0-9]+ → exit null \(abandoned by the stuck backstop\)$/);
			const swept = lineAt(lines, / sweep tr-[a-z0-9]+ → |the sweep after full (was abandoned|did not finish|failed)/, abandoned.i);
			const contained = lineAt(lines, / contained after full: no live _as2test process$/, abandoned.i);
			const released = lineAt(lines, / lock released$/, abandoned.i);
			const took = await nextTook(p);
			const total = printStages("stalled", [
				["first stuck-signature", sig.at], ["executor SIGSTOPped (test)", p.stoppedAt!], ["backstop abandoned the call", abandoned.at],
				["sweep done", swept.at], ["contained", contained.at], ["lock released", released.at], ["next run took the lock", took],
			], PROOF.stalledBoundMs);
			expect(run.verdict).toBe("error");
			expect(run.reason).toBe(`full: executor stalled during stuck detection; worker ${worker} was a candidate, not confirmed`);
			expect(run.reason).not.toContain("stuck:");
			expect(run.full).toMatchObject({ exit: null });
			// no stop line followed the stall, and the backstop fired at its deadline after the signature's line
			expect(log).not.toMatch(/^stuck-stop /m);
			expect(log).toContain(`executor-stalled part full worker ${worker}\n`);
			expect(abandoned.at - sig.at).toBeGreaterThanOrEqual(PROOF.backstopMs);
			expect(abandoned.at - sig.at).toBeLessThan(PROOF.backstopMs + 1_000);
			expect(alive(p.execPid)).toBe(false);
			expect(partsOf(p.w, p.runId)).toEqual(["probe", "prepare", "full"]);
			expect(took).toBeGreaterThanOrEqual(released.at);
			expect(total).toBeLessThanOrEqual(PROOF.stalledBoundMs);
		});
	}, 240_000);

	test("slow-cleanup path: the stuck sweep and the head re-check held by the hooks to their deadlines: the next run took the lock within 45 s", async () => {
		await withProof("slow-cleanup", { holdCleanup: true }, async (p) => {
			await p.kids[0]!.exited;
			const run = await resultOf(p.w, p.first.wl, p.runId);
			const lines = runnerLog(p.w, p.runId).split("\n");
			const sig = lineAt(lines, SIG_LINE);
			const [, , worker, zombie] = sig.m;
			const stop = lineAt(lines, new RegExp(`^stuck-stop \\S+ part full worker ${worker} zombie ${zombie}`));
			const captured = lineAt(lines, /^stuck-captured \S+ part full file full\.signature\.log ms \d+$/);
			const killed = lineAt(lines, /^stuck-killed \S+ part full pgids ([\d,]+) ms \d+ contained$/);
			const exit = lineAt(lines, / full tr-[a-z0-9]+ → exit 125$/);
			const swept = lineAt(lines, / the sweep after full was abandoned at its deadline/, exit.i);
			const contained = lineAt(lines, / contained after full: no live _as2test process$/, exit.i);
			const finalize = lineAt(lines, / post-sweep finalization started; deadline (\S+)$/, exit.i);
			const released = lineAt(lines, / lock released$/, exit.i);
			const took = await nextTook(p);
			const total = printStages("slow-cleanup", [
				["first stuck-signature", sig.at], ["stuck-stop", stop.at], ["stuck-captured", captured.at], ["stuck-killed", killed.at],
				["exec exit seen (125)", exit.at], ["sweep abandoned at its deadline", swept.at], ["contained", contained.at],
				["finalization started", finalize.at], ["lock released", released.at], ["next run took the lock", took],
			], PROOF.boundMs);
			expect(run.verdict).toBe("error");
			expect(run.reason).toStartWith(`full: stuck: worker ${worker} spun `);
			expect(run.reason).toContain("post-sweep deadline exceeded");
			// each held to its own deadline: the sweep's one 12 s deadline, then the head re-check to STUCK_FINALIZE_MS
			expect(swept.at - exit.at).toBeGreaterThanOrEqual(PROOF.sweepMs);
			const deadline = Date.parse(finalize.m[1]!);
			expect(deadline - finalize.at).toBeLessThanOrEqual(PROOF.finalizeMs);
			expect(released.at).toBeGreaterThanOrEqual(deadline);
			const paused = JSON.parse(readFileSync(`${hookBase(p.w, p.runId, "sweep-read1")}.reached`, "utf8")) as { pid: number };
			expect(alive(paused.pid)).toBe(false);
			expect(took).toBeGreaterThanOrEqual(released.at);
			expect(total).toBeLessThanOrEqual(PROOF.boundMs);
		});
	}, 240_000);
});

// ---- the field soak (PLAN wl-mvq8x4pkjmx69s § Field evidence before the workload closes, R10; sl-sd-field) --------------

/** The historically affected test files (PLAN § Field evidence): the only test files the soak's origin keeps. */
const FIELD_FILES: readonly string[] = ["surface/test/channel.test.ts", "surface/test/batch.test.ts", "surface/test/train-signoff.test.ts", "ledger/test/ledger.test.ts"];
/** A file `bun test` runs as a test file (`.test`, `_test`, `.spec`, `_spec`; js and ts variants). */
const BUN_TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
/** The soak origin's pull requests: the four files as committed, and the same plus the spin fixture at the repo root. */
const FIELD_PR = { soak: 1, spin: 2 } as const;
/** profile/config.yml `testRunner.fullWorkers`. */
const FIELD_WORKERS = 6;
/** The soak's runs: AS2_STUCK_FIELD_N, 8 when unset. */
const FIELD_N = Number(process.env.AS2_STUCK_FIELD_N ?? "8");
/**
 * The shadow injection's full cap in minutes. The config parser takes any positive number (test-run.ts `testRunnerConfig`) and
 * the executor rounds it to ms (test-exec.ts `capMs`), so the world sets no floor of its own; the floor that still lets the
 * detector decide before the cap is its own path from the spin worker's start: the first signature (tick 1 s), persistence (5 s)
 * and the signature capture (3 s). 0.5 min leaves about 20 s of margin for bun's start beside the four files.
 */
const FIELD_SHADOW_CAP_MIN = 0.5;
/** world()'s default cap (2 min, full and solo), used by the soak and the enforce injection. */
const FIELD_CAP_MIN = 2;
/** The runner.log line that ends the sweep after a part (or says why it did not finish), as the budget proof reads it. */
const SWEPT_LINE = / sweep tr-[a-z0-9]+ → |the sweep after full (was abandoned|did not finish|failed)/;

interface FieldOrigin {
	/** The worktree's HEAD the origin was cut from. */
	commit: string;
	bare: string;
	main: string;
	head: Record<keyof typeof FIELD_PR, string>;
}

/**
 * The soak's origin: this worktree's HEAD, history included (ledger.test.ts builds old ledgers from `git show <rev>:…`), with a
 * commit on it removing every test file but FIELD_FILES (every other file kept: bunfig.toml, its preload and whatever the four
 * import) as main; PR 1 an empty commit on main (the four files), PR 2 main plus the end-to-end spin fixture as `spin.test.ts`.
 */
function fieldOrigin(): FieldOrigin {
	const top = g(import.meta.dir, "rev-parse", "--show-toplevel");
	const commit = g(top, "rev-parse", "HEAD");
	const root = realpathSync(tmp("trun-field"));
	roots.push(root);
	const work = join(root, "work");
	g(root, "clone", "-q", "--no-checkout", top, work);
	g(work, "checkout", "-q", "-B", "main", commit);
	const tests = g(work, "ls-tree", "-r", "-z", "--name-only", commit).split("\0").filter((f) => BUN_TEST_FILE.test(f));
	const missing = FIELD_FILES.filter((f) => !tests.includes(f));
	if (missing.length > 0) throw new Error(`field soak: ${missing.join(", ")} not among the test files of ${commit}`);
	g(work, "rm", "-q", "--", ...tests.filter((f) => !FIELD_FILES.includes(f)));
	g(work, "commit", "-q", "-m", `field soak: ${commit} with only the test files ${FIELD_FILES.join(" ")}`);
	const main = g(work, "rev-parse", "HEAD");
	g(work, "commit", "-q", "--allow-empty", "-m", "field soak: the four files");
	const soak = g(work, "rev-parse", "HEAD");
	g(work, "update-ref", `refs/pull/${FIELD_PR.soak}/head`, soak);
	g(work, "checkout", "-q", "--detach", main);
	writeFileSync(join(work, "spin.test.ts"), SPIN);
	g(work, "add", "spin.test.ts");
	g(work, "commit", "-q", "-m", "field soak: the spin fixture beside the four files");
	const spin = g(work, "rev-parse", "HEAD");
	g(work, "update-ref", `refs/pull/${FIELD_PR.spin}/head`, spin);
	const bare = join(root, "origin.git");
	g(root, "init", "-q", "--bare", "-b", "main", bare);
	g(work, "push", "-q", bare, "main", "+refs/pull/*:refs/pull/*");
	return { commit, bare, main, head: { soak, spin } };
}

/** A soak world: the shared runs root, the soak origin, production's workers, no detector knob, production runner timers. */
function fieldWorld(o: FieldOrigin, runs: string, stuckStop: "shadow" | "enforce", capMin: number): World {
	return productionTimers(world({ bare: o.bare, runs, stuckStop, capMin, fullWorkers: FIELD_WORKERS, killGraceMs: KILL_GRACE_MS, sweepLockWaitMs: SWEEP_LOCK_WAIT_MS }));
}

/** The processes under `rootPids` in `procs` (the roots included). */
function descendants(procs: Proc[], rootPids: number[]): Proc[] {
	const tree = procs.filter((p) => rootPids.includes(p.pid));
	for (let i = 0; i < tree.length; i++) for (const p of procs) if (p.ppid === tree[i]!.pid && !tree.includes(p)) tree.push(p);
	return tree;
}

/**
 * Every 250 ms, the process tree under each live runner child is added to `seen` (by pid and start); returns the stop. A real
 * interval on purpose: the processes are real and short-lived, and no event announces them, so only sampling the live process
 * table records them (a fake clock would sample nothing).
 */
function watchTrees(kids: Child[], seen: Map<string, Proc>): () => void {
	const t = setInterval(() => {
		const live = kids.filter((k) => k.exitCode === null && k.signalCode === null).map((k) => k.pid);
		if (live.length === 0) return;
		for (const p of descendants(uidProcs(), live)) seen.set(`${p.pid}:${p.startUs}`, p);
	}, 250);
	return () => clearInterval(t);
}

/** The members of `tree` still alive: printed, SIGKILLed and checked gone; returns them as `<pid> (<comm>, pgid <pgid>)`. */
async function killLeft(what: string, tree: Proc[]): Promise<string[]> {
	const left = survivorsOf(tree);
	const named = left.map((p) => `${p.pid} (${p.comm}, pgid ${p.pgid})`);
	if (left.length > 0) console.log(`field-soak ${what}: alive: ${named.join(", ")}; killing`);
	for (const p of left) {
		try {
			process.kill(p.pid, "SIGCONT");
			process.kill(p.pid, "SIGKILL");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		}
	}
	await until(`no process of ${what} alive`, () => survivorsOf(tree).length === 0, 10_000);
	return named;
}

interface FieldRun {
	role: "soak" | "queued" | "injected";
	mode: "shadow" | "enforce";
	runId: string;
	pr: number;
	sha: string;
	capMin: number;
	verdict: string | null;
	reason: string | null;
	/** The runner process's wall time, spawn to exit. */
	runnerMs: number | null;
	/** An injected run's spin worker (the fixture's `spin.pid`): its decisions are injected, every other one is on the real files. */
	spinWorker: number | null;
	/** What the test killed after the injected run's full part and its sweep (the spin worker a groups-mode sweep leaves). */
	killedAfterFull: string[];
}

interface FieldManifest {
	commit: string;
	originMain: string;
	bun: string;
	files: readonly string[];
	n: number;
	fullWorkers: number;
	spinFixture: string;
	startedAt: string;
	endedAt: string | null;
	runs: FieldRun[];
	/** Anything of a world found alive at a phase's end (killed, and the phase failed). */
	survivors: string[];
	errors: string[];
}

describe.if(process.env.AS2_STUCK_FIELD_SOAK === "1")("field soak (field-soak.sh)", () => {
	let origin: FieldOrigin;
	let runs: string;
	let manifest: FieldManifest;
	const save = () => writeFileSync(join(runs, "field-soak.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	beforeAll(() => {
		const named = process.env.AS2_STUCK_FIELD_RUNS;
		if (!named) throw new Error("field soak: AS2_STUCK_FIELD_RUNS is not set; it names the runs root the field report reads (field-soak.sh sets it)");
		if (!Number.isSafeInteger(FIELD_N) || FIELD_N < 1) throw new Error(`field soak: AS2_STUCK_FIELD_N=${process.env.AS2_STUCK_FIELD_N} is not an integer of 1 or more`);
		runs = resolve(named);
		mkdirSync(runs, { recursive: true });
		const there = readdirSync(runs);
		if (there.length > 0) throw new Error(`field soak: ${runs} already holds ${there.length} entries (an earlier soak's runs); move it aside, the soak deletes nothing`);
		origin = fieldOrigin();
		manifest = {
			commit: origin.commit, originMain: origin.main, bun: Bun.version, files: FIELD_FILES, n: FIELD_N, fullWorkers: FIELD_WORKERS,
			spinFixture: "spin.test.ts at the repo root: the end-to-end test's SPIN (holds its marker for `true`, leaves /usr/bin/true unreaped, spins forever)",
			startedAt: new Date().toISOString(), endedAt: null, runs: [], survivors: [], errors: [],
		};
		save();
	});
	afterAll(() => {
		if (manifest === undefined) return;
		manifest.endedAt = new Date().toISOString();
		save();
	});

	/** The run's entry in the manifest, written at once so a run that never settles is still named. */
	function entry(role: FieldRun["role"], mode: FieldRun["mode"], runId: string, pr: number, sha: string, capMin: number): FieldRun {
		const r: FieldRun = { role, mode, runId, pr, sha, capMin, verdict: null, reason: null, runnerMs: null, spinWorker: null, killedAfterFull: [] };
		manifest.runs.push(r);
		save();
		return r;
	}
	/** The run's own `test-run:` and result.json: settled. */
	async function settled(w: World, wl: string, r: FieldRun, kid: Child, spawnedAt: number): Promise<void> {
		await kid.exited;
		r.runnerMs = Date.now() - spawnedAt;
		const run = await resultOf(w, wl, r.runId);
		r.verdict = run.verdict;
		r.reason = run.reason ?? null;
		save();
		console.log(`field-soak ${r.role} ${r.mode} ${r.runId} ${run.verdict} runner ${r.runnerMs} ms${run.reason ? `: ${run.reason}` : ""}`);
		expect(existsSync(join(runs, r.runId, "result.json"))).toBe(true);
	}
	/** The phase's end, pass or fail: every runner child reaped, every sampled process of the world checked gone (killed if not). */
	async function close(what: string, kids: Child[], seen: Map<string, Proc>, stop: () => void, errors: unknown[]): Promise<void> {
		try {
			stop();
			await reap(kids);
			const left = await killLeft(what, [...seen.values()]);
			manifest.survivors.push(...left.map((l) => `${what}: ${l}`));
			console.log(`field-soak ${what}: ${seen.size} processes sampled, ${left.length} alive at the end`);
			if (left.length > 0) errors.push(new Error(`field soak ${what}: left alive: ${left.join(", ")}`));
		} catch (e) {
			errors.push(e);
		}
		manifest.errors.push(...errors.map((e) => `${what}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`));
		save();
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, `field soak ${what}: more than one failure`);
	}

	test(`${FIELD_N} shadow runs of the four files back to back: every run settled, nothing of the world left alive`, async () => {
		const w = fieldWorld(origin, runs, "shadow", FIELD_CAP_MIN);
		const kids: Child[] = [];
		const seen = new Map<string, Proc>();
		const stop = watchTrees(kids, seen);
		const errors: unknown[] = [];
		try {
			for (let i = 1; i <= FIELD_N; i++) {
				const { wl, slice } = workload(w);
				const runId = request(w, wl, slice, FIELD_PR.soak, origin.head.soak);
				const r = entry("soak", "shadow", runId, FIELD_PR.soak, origin.head.soak, FIELD_CAP_MIN);
				const at = Date.now();
				const kid = spawnRun(w, runId);
				kids.push(kid);
				await settled(w, wl, r, kid, at);
			}
		} catch (e) {
			errors.push(e);
		}
		await close("soak", kids, seen, stop, errors);
	}, FIELD_N * 10 * 60_000 + 5 * 60_000);

	for (const mode of ["shadow", "enforce"] as const) {
		test(`injected (${mode}): the spin fixture beside the four files, a run of the four queued behind it: both settled, the spin worker gone, nothing of the world left alive`, async () => {
			const capMin = mode === "shadow" ? FIELD_SHADOW_CAP_MIN : FIELD_CAP_MIN;
			const w = fieldWorld(origin, runs, mode, capMin);
			const first = workload(w);
			const second = workload(w);
			const runId = request(w, first.wl, first.slice, FIELD_PR.spin, origin.head.spin, 1_000);
			Bun.sleepSync(5);
			const nextId = request(w, second.wl, second.slice, FIELD_PR.soak, origin.head.soak);
			const injected = entry("injected", mode, runId, FIELD_PR.spin, origin.head.spin, capMin);
			const queued = entry("queued", mode, nextId, FIELD_PR.soak, origin.head.soak, capMin);
			const kids: Child[] = [];
			const seen = new Map<string, Proc>();
			const stop = watchTrees(kids, seen);
			const errors: unknown[] = [];
			try {
				const at = Date.now();
				kids.push(spawnRun(w, runId));
				await until(`${runId} took the lock`, () => / took the lock\n/.test(runnerLog(w, runId)), 120_000);
				const nextAt = Date.now();
				kids.push(spawnRun(w, nextId));
				await until(`${nextId} queued behind ${runId}`, () => marks(w, nextId, "queued").length >= 1, 60_000);
				const execPid = (await until(`${runId}'s full call`, () => marks(w, runId, "spawn-full")[0], 300_000)).pid as number;
				const spinPid = join(w.as2, "runs", runId, "spin.pid");
				const worker = await until(`the spin worker's pid in ${spinPid}`, () => existsSync(spinPid) && Number(readFileSync(spinPid, "utf8").trim()), 120_000);
				injected.spinWorker = worker;
				save();
				await until(`the spin worker ${worker}'s first stuck-signature in ${runId}'s full stdout`, () => signatureInStdout(w, new RegExp(`^stuck-signature \\S+ part full worker ${worker} zombie \\d+ `)), 120_000);
				const tree = execTree(execPid);
				// The full call's end and the sweep after it: what the groups-mode sweep left of the part is killed here, before the queued run's parts.
				await until(`${runId}'s full call and the sweep after it`, () => {
					const lines = runnerLog(w, runId).split("\n");
					const end = lines.findIndex((l) => / full tr-[a-z0-9]+ → /.test(l));
					return end >= 0 && lines.slice(end + 1).some((l) => SWEPT_LINE.test(l));
				}, capMin * 60_000 + 5 * 60_000);
				injected.killedAfterFull = await killLeft(`${runId}'s full part (${mode})`, tree);
				save();
				await settled(w, first.wl, injected, kids[0]!, at);
				await settled(w, second.wl, queued, kids[1]!, nextAt);
			} catch (e) {
				errors.push(e);
			}
			await close(`injected ${mode}`, kids, seen, stop, errors);
		}, 20 * 60_000);
	}
});

// Proofs use these real world fixtures and the same rendered wrapper as ordinary runs, never a substitute execution loop.
describe("finite timing proofs on the exclusive runner", () => {
	/** Preserve new proof worlds on any failure; the file's ordinary afterAll must not erase their receipts. */
	function proofTest(name: string, body: () => unknown | Promise<unknown>): void {
		test(name, async () => {
			const firstRoot = roots.length;
			try { await body(); }
			catch (error) {
				const retained = roots.splice(firstRoot);
				throw new Error(`timing proof failed; fixture evidence retained at ${retained.join(", ")}`, { cause: error });
			}
		});
	}
	function proofEach<T extends string>(values: readonly T[], name: string, body: (value: T) => unknown | Promise<unknown>): void {
		for (const value of values) proofTest(name.replace("%s", value), () => body(value));
	}
	// Use the production connection's existing contention policy, not lockDbOf's intentional zero-wait fault-injection policy.
	const proofDbOf = (w: World): Database => openLockDb(w.runs);
	function manifest(wl: string, slice: string, sha: string, file = "a.test.ts", names = ["a"]): ProofManifest {
		return parseProofManifest({
			version: 1, kind: "smoke", workload: wl, slice, repo: OWNER_REPO, baseSha: sha, candidateSha: sha,
			mode: "isolated", productionBudget: false, load: "none", runs: { base: 0, candidate: 2 },
			files: [{ path: file, cases: names.map((name) => ({ base: [name], candidate: [name], budgetMs: 5000, timingUnderTest: false })),
				hooks: { base: { setup: [], cleanup: [] }, candidate: { setup: [], cleanup: [] } }, skipped: { base: [], candidate: [] } }],
		});
	}
	/**
	 * The installed runtime files submission hashes into a proof's identity (installedRuntimeHashes), provisioned as synthetic
	 * fixtures: `<libexec>/resources.json` is a copy of the synthetic policy the world's wrapper runs under, and an installed-OMP
	 * proof gets a synthetic `<libexec>/installed-omp.json` pin. The world's wrapper reads its OMP pin beside the real Bun, never
	 * this one, so the installed-OMP proof still fails closed on its executor. Rewriting the same bytes keeps the identity stable.
	 */
	function installProofRuntime(w: World, mode: ProofManifest["mode"]): void {
		writeFileSync(join(w.libexec, "resources.json"), readFileSync(join(w.root, "resources.json")));
		if (mode === "installed-OMP") {
			writeFileSync(join(w.libexec, "installed-omp.json"), JSON.stringify({ root: join(w.root, "synthetic-omp"), treeSha256: "0".repeat(64), version: "synthetic test fixture only; no OMP installed" }));
		}
	}
	/** The production submit path: the controller CLI, as a lane runs it, over the synthetic installed runtime. */
	function submitRaw(w: World, m: ProofManifest) {
		installProofRuntime(w, m.mode);
		const path = join(w.root, "proof-manifest.json");
		writeFileSync(path, JSON.stringify(m));
		return Bun.spawnSync([process.execPath, PROOF_CLI, "submit", "--manifest", path], { env: w.env, stdout: "pipe", stderr: "pipe" });
	}
	function submit(w: World, m: ProofManifest) {
		const r = submitRaw(w, m);
		if (r.exitCode !== 0) throw new Error(`proof submit exit ${r.exitCode}: ${r.stderr.toString()}`);
		const id = /^timing-proof (tp-[a-z0-9]+) admitted/m.exec(r.stdout.toString())?.[1];
		if (!id) throw new Error(`proof submit returned no series: ${r.stdout.toString()}`);
		return id;
	}
	/** A direct admission for a test that drives the series `run` itself; its executable inputs are distinct per candidate SHA. */
	function admitDirect(db: Database, id: string, m: ProofManifest) {
		const tree = (sha: string) => ({ sha, tree: sha.padEnd(64, "0") });
		admitProof(db, id, m, { base: tree(m.baseSha), candidate: tree(m.candidateSha), runtime: { mode: m.mode, executor: { exec: "3".repeat(64) }, identity: "3".repeat(64) } }, Date.now());
	}
	async function terminal(w: World, id: string) {
		const db = proofDbOf(w);
		try {
			return await until(`proof ${id} terminal`, () => {
				const p = inspectProof(db, id);
				return p.state === "failed" || p.state === "complete" ? p : null;
			}, 120_000);
		} finally { db.close(); }
	}
	proofTest("ordinary queue preserves a live proof waiter and gets its turn between finite iterations", async () => {
		const w = world(), first = workload(w), proof = workload(w), other = workload(w);
		const firstId = request(w, first.wl, first.slice, PR.green, fx.head.green);
		arm(w, firstId, "phase-full");
		const firstChild = spawnRun(w, firstId);
		let otherChild: Subprocess | null = null;
		let proofRunId = "", otherId = "", id = "";
		try {
			await reached(w, firstId, "phase-full");
			id = submit(w, manifest(proof.wl, proof.slice, fx.head.green));
			const db = proofDbOf(w);
			let queuedAt = 0;
			try {
				const row = await until("proof registered in ordinary exclusive queue", () => db.query<{ runId: string; requestedAt: number }, [string]>("SELECT runId, requestedAt FROM queue WHERE workloadId = ?").get(proof.wl), 60_000);
				proofRunId = row.runId; queuedAt = row.requestedAt;
			} finally { db.close(); }
			arm(w, proofRunId, "phase-solo");
			otherId = w.pin(new Date(queuedAt + 1).toISOString(), () => request(w, other.wl, other.slice, PR.green, fx.head.green));
			arm(w, otherId, "phase-full"); otherChild = spawnRun(w, otherId);
			go(w, firstId, "phase-full");
			await reached(w, proofRunId, "phase-solo");
			const ordering = proofDbOf(w);
			try {
				await until("ordinary waiter registered before proof release", () => ordering.query("SELECT runId FROM queue WHERE runId = ?").get(otherId), 60_000);
				// Inject the queue's logical sort input, rather than depending on how many wall milliseconds the tiny part takes.
				ordering.query("UPDATE queue SET requestedAt = ? WHERE runId = ?").run(queuedAt - 1, otherId);
			} finally { ordering.close(); }
			go(w, proofRunId, "phase-solo");
			await reached(w, otherId, "phase-full");
			const check = proofDbOf(w);
			try {
				const p = await until("next proof iteration queued behind ordinary owner", () => {
					const p = inspectProof(check, id);
					return p.iterations.length === 2 && p.iterations[1]!.state === "running" ? p : null;
				}, 60_000);
				expect(lockRow(check)?.runId).toBe(otherId);
				expect(p.iterations[0]!.state).toBe("complete");
			} finally { check.close(); }
			go(w, otherId, "phase-full");
			expect((await terminal(w, id)).state).toBe("complete");
			expect((await resultOf(w, other.wl, otherId)).verdict).toBe("green");
		} finally {
			go(w, firstId, "phase-full");
			if (proofRunId) go(w, proofRunId, "phase-solo");
			if (otherId) go(w, otherId, "phase-full");
			await firstChild.exited;
			if (otherChild) await otherChild.exited;
		}
	});
	proofTest("productionBudget reaches real child/descendant without credentials; actual setup and cleanup markers are required", async () => {
		const w = world(), { wl, slice } = workload(w);
		const m = manifest(wl, slice, fx.head.proofenv, "proof-env.test.ts", ["proof environment"]);
		m.productionBudget = true;
		for (const phase of ["base", "candidate"] as const) m.files[0]!.hooks[phase] = { setup: ["ready"], cleanup: ["reaped"] };
		const p = await terminal(w, submit(w, m));
		expect(p.error).toBeNull(); expect(p.state).toBe("complete");
		for (const i of p.iterations) {
			const receipt = JSON.parse(readFileSync(join(w.runs, i.runId, "proof.json"), "utf8"));
			expect(receipt.execution.markers).toEqual(["timing-proof setup proof-env.test.ts ready", "timing-proof cleanup proof-env.test.ts reaped"]);
			expect(receipt.resources.executionArgv).toContain("./proof-env.test.ts");
		}
	});
	proofTest("installed-OMP mode cannot fall back to the groups/operator executor or publish a green", async () => {
		const w = world(), { wl, slice } = workload(w);
		const m = manifest(wl, slice, fx.head.green); m.mode = "installed-OMP";
		const p = await terminal(w, submit(w, m));
		expect(p.state).toBe("failed"); expect(p.iterations).toHaveLength(1);
		const receipt = JSON.parse(readFileSync(join(w.runs, p.iterations[0]!.runId, "solo-1.resources.json"), "utf8"));
		expect(receipt.status).toBe("error");
		expect(receipt.error).toContain("actual _as2test");
		expect(receipt.executionArgv).toBeNull();
		expect(w.ledger.slice(slice)?.state).toBe("open");
		expect(testRuns(w.ledger.entries(wl))).toHaveLength(0);
		expect(existsSync(join(w.root, "status-ok.log"))).toBe(false);
	});
	proofTest("submit/inspect queues two actual solos, preserves JUnit/resources/cleanup, and settles no slice or status", async () => {
		const w = world(), { wl, slice } = workload(w);
		const id = submit(w, manifest(wl, slice, fx.head.green));
		const p = await terminal(w, id);
		expect(p.error).toBeNull();
		expect(p.state).toBe("complete");
		expect(p.iterations).toHaveLength(2);
		expect(new Set(p.iterations.map((i) => i.runId)).size).toBe(2);
		for (const i of p.iterations) {
			const dir = join(w.runs, i.runId);
			const receipt = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
			expect(receipt.execution.cases.map((c: { name: string }) => c.name)).toEqual(["a"]);
			expect(receipt.resources.status).toBe("admitted");
			expect(receipt.cleanup.state).toBe("verified");
			expect(existsSync(workDirOf(i.runId, w.as2))).toBe(false);
			expect(readFileSync(join(dir, "solo-1.xml"), "utf8")).toContain('name="a"');
			expect(readFileSync(join(dir, "wrapper.jsonl"), "utf8")).toContain(`./a.test.ts`);
		}
		const inspected = Bun.spawnSync([process.execPath, PROOF_CLI, "inspect", "--series", id], { env: w.env, stdout: "pipe", stderr: "pipe" });
		expect(inspected.exitCode).toBe(0);
		expect(JSON.parse(inspected.stdout.toString()).completionProof).toBe(false);
		expect(w.ledger.slice(slice)?.state).toBe("open");
		expect(testRuns(w.ledger.entries(wl))).toHaveLength(0);
		expect(existsSync(join(w.root, "status-ok.log"))).toBe(false);
	});
	proofTest("five fresh full executions ignore an existing main green and leave it unchanged", async () => {
		const w = world(), { wl, slice } = workload(w);
		mainRun(w.ledger, "tr-existingproofgreen", fx.head.green, "green", { exec: { files: 2, tests: 2, treeFiles: 2 } });
		const before = mainResults(w.ledger.entries(STANDING_WORKLOAD_ID));
		const m = manifest(wl, slice, fx.head.green);
		m.kind = "full-series"; m.runs = { base: 0, candidate: 5 };
		m.files.push({ ...m.files[0]!, path: "xa.test.ts", cases: [{ base: ["xa"], candidate: ["xa"], budgetMs: 5000, timingUnderTest: false }] });
		const p = await terminal(w, submit(w, m));
		expect(p.error).toBeNull(); expect(p.state).toBe("complete"); expect(p.iterations).toHaveLength(5);
		expect(new Set(p.iterations.map((i) => i.runId)).size).toBe(5);
		for (const i of p.iterations) {
			const receipt = JSON.parse(readFileSync(join(w.runs, i.runId, "proof.json"), "utf8"));
			expect(receipt.part.stem).toBe("full"); expect(receipt.execution.cases).toHaveLength(2); expect(receipt.cleanup.state).toBe("verified");
		}
		expect(mainResults(w.ledger.entries(STANDING_WORKLOAD_ID))).toEqual(before);
		expect(testRuns(w.ledger.entries(wl))).toHaveLength(0);
	});
	proofEach(["red", "skipped", "missing"] as const, "%s stops at the first candidate and cannot replay on restart", async (kind) => {
		const w = world(), { wl, slice } = workload(w);
		const m = kind === "red" ? manifest(wl, slice, fx.head.red, "red.test.ts", [...Array.from({ length: 25 }, (_, i) => `case ${String(i + 1).padStart(2, "0")}`), "passes"])
			: manifest(wl, slice, kind === "skipped" ? fx.head.skipped : fx.head.green, "a.test.ts", [kind === "skipped" ? "a skipped" : "missing"]);
		const id = submit(w, m), p = await terminal(w, id);
		expect(p.state).toBe("failed"); expect(p.iterations).toHaveLength(1);
		expect(existsSync(join(w.runs, p.iterations[0]!.runId, "solo-1.xml"))).toBe(true);
		const restart = Bun.spawnSync([process.execPath, PROOF_CLI, "run", id], { env: w.env, stdout: "pipe", stderr: "pipe" });
		expect(restart.exitCode).toBe(3);
		expect(existsSync(workDirOf(p.iterations[0]!.runId, w.as2))).toBe(true);
		expect(existsSync(join(w.runs, p.iterations[0]!.runId, "proof-retained-world.json"))).toBe(true);
		const db = proofDbOf(w);
		try { expect(inspectProof(db, id).iterations).toHaveLength(1); } finally { db.close(); }
		expect(w.ledger.slice(slice)?.state).toBe("open");
	});
	proofTest("admission rejects a SHA not fetched from served origin and an arbitrary environment", () => {
		const w = world(), { wl, slice } = workload(w);
		for (const bad of [{ ...manifest(wl, slice, fx.head.green), candidateSha: "f".repeat(40) }, { ...manifest(wl, slice, fx.head.green), env: { GH_TOKEN: "smuggled" } }]) {
			const r = submitRaw(w, bad as ProofManifest);
			expect(r.exitCode).not.toBe(0);
			const db = proofDbOf(w);
			try { expect(db.query("SELECT id FROM timing_proofs").all()).toHaveLength(0); } finally { db.close(); }
		}
	});
	proofEach(["proof-cleanup-published", "proof-cleanup-transferred"], "crash at %s retains interrupted attempt; next ordinary owner republishes and reaps its world", async (boundary) => {
		const w = world(), { wl, slice } = workload(w);
		const db = proofDbOf(w), id = "tp-crashproof";
		try { admitDirect(db, id, manifest(wl, slice, fx.head.green)); } finally { db.close(); }
		arm(w, id, "proof-iteration");
		const child = Bun.spawn([process.execPath, PROOF_CLI, "run", id], { env: w.env, stdout: "ignore", stderr: "ignore" });
		let runId = "";
		try {
			await reached(w, id, "proof-iteration");
			runId = JSON.parse(readFileSync(`${hookBase(w, id, "proof-iteration")}.reached`, "utf8")).runId;
			arm(w, runId, boundary); go(w, id, "proof-iteration");
			await reached(w, runId, boundary);
		} finally { child.kill("SIGKILL"); await child.exited; }
		const originalRoot = workDirOf(runId, w.as2);
		expect(existsSync(originalRoot)).toBe(true);
		expect(existsSync(join(w.runs, runId, "proof-cleanup.json"))).toBe(true);
		// Model the dead holder's lease expiry directly; the behavior is crash recovery, not a wall-clock race.
		writeFileSync(join(w.runs, runId, "heartbeat"), heartbeatText(runId, Date.now() - 120_000));
		staleRow(w);
		const ordinary = request(w, wl, slice, PR.green, fx.head.green);
		const next = spawnRun(w, ordinary);
		try {
			const result = await resultOf(w, wl, ordinary);
			expect(result.verdict).toBe("green");
			await next.exited;
		} finally { if (next.exitCode === null) { next.kill("SIGKILL"); await next.exited; } }
		const check = proofDbOf(w);
		try {
			const p = inspectProof(check, id);
			expect(p.state).toBe("failed"); expect(p.iterations).toHaveLength(1); expect(p.iterations[0]!.state).toBe("interrupted");
			expect(lockRow(check)).toBeNull();
		} finally { check.close(); }
		expect(existsSync(originalRoot)).toBe(false);
		expect(readFileSync(join(w.runs, runId, "proof-recovery.jsonl"), "utf8")).toContain("originalError");
	});

	// ---- TOOLS-REVIEW-r1 F1: the historic load outlives no owner ----------------------------------------------------------
	const liveOf = (pids: number[]): number[] => {
		const s = snapshot(process.getuid!());
		if (s.kind !== "ok") throw new Error(`process list of this uid unavailable: ${s.why}`);
		return pids.filter((pid) => s.procs.some((p) => p.pid === pid && !p.zombie));
	};
	proofEach(["SIGKILL", "SIGSTOP"] as const, "a controller lost to %s after its historic load is ready leaks no load; the next owner recovers it before any part", async (signal) => {
		const w = world(), { wl, slice } = workload(w);
		const m = manifest(wl, slice, fx.head.green);
		m.kind = "full-series"; m.runs = { base: 0, candidate: 5 }; m.load = "historic";
		m.files.push({ ...m.files[0]!, path: "xa.test.ts", cases: [{ base: ["xa"], candidate: ["xa"], budgetMs: 5000, timingUnderTest: false }] });
		const id = signal === "SIGKILL" ? "tp-loadkilled" : "tp-loadstopped";
		const db = proofDbOf(w);
		try { admitDirect(db, id, m); } finally { db.close(); }
		arm(w, id, "proof-iteration");
		// No run heartbeat after the first: the lost holder's staleness below is then the only one (as the supersede tests do).
		const child = Bun.spawn([process.execPath, PROOF_CLI, "run", id], { env: { ...w.env, AGENT_SYSTEM_TEST_RUNNER_HEARTBEAT_MS: "600000" }, stdout: "ignore", stderr: "ignore" });
		let pids: number[] = [];
		try {
			await reached(w, id, "proof-iteration");
			const runId: string = JSON.parse(readFileSync(`${hookBase(w, id, "proof-iteration")}.reached`, "utf8")).runId;
			arm(w, runId, "phase-full"); go(w, id, "proof-iteration");
			// The load is started, and every process has announced readiness, before the part's hook.
			await reached(w, runId, "phase-full");
			const loadPath = join(w.runs, runId, "load.json");
			const launched: LoadReceipt = JSON.parse(readFileSync(loadPath, "utf8"));
			pids = launched.processes.map((p) => p.pid);
			expect(pids).toHaveLength(14);
			expect(liveOf(pids)).toEqual(pids);
			child.kill(signal);
			if (signal === "SIGKILL") {
				await child.exited;
				await until("every load process ended with its killed owner", () => liveOf(pids).length === 0, 30_000);
			}
			// Model the lost holder's lease expiry directly; the behavior is recovery, not a wall-clock race.
			writeFileSync(join(w.runs, runId, "heartbeat"), heartbeatText(runId, Date.now() - 120_000));
			staleRow(w);
			const ordinary = request(w, wl, slice, PR.green, fx.head.green);
			const next = spawnRun(w, ordinary);
			try {
				expect((await resultOf(w, wl, ordinary)).verdict).toBe("green");
				await next.exited;
			} finally { if (next.exitCode === null) { next.kill("SIGKILL"); await next.exited; } }
			expect(liveOf(pids)).toEqual([]);
			const recovered: LoadReceipt = JSON.parse(readFileSync(loadPath, "utf8"));
			expect(recovered.state).toBe("recovered");
			const recovery = readFileSync(join(w.runs, runId, "load-recovery.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { by: string; outcomes: { outcome: string }[] });
			expect(recovery.map((r) => r.by)).toEqual([ordinary]);
			const outcomes = recovery[0]!.outcomes.map((o) => o.outcome);
			expect(outcomes).toHaveLength(14);
			// A stopped owner's load is still running; a killed owner's load ended at its stdin EOF, or is killed if still exiting.
			for (const o of outcomes) expect(signal === "SIGSTOP" ? ["killed"] : ["gone", "killed"]).toContain(o);
			const check = proofDbOf(w);
			try {
				const p = inspectProof(check, id);
				expect(p.state).toBe("failed"); expect(p.iterations[0]!.state).toBe("interrupted");
			} finally { check.close(); }
		} finally {
			if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
			for (const pid of liveOf(pids)) {
				try { process.kill(-pid, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
			}
		}
	});

	// ---- TOOLS-REVIEW-r1 F4: production submit keys a failure to its executable inputs ------------------------------------
	proofTest("production submit refuses an equivalent failed tree: an empty commit, decision-log churn, a new diagnosis or workload", async () => {
		const w = world(), { wl, slice } = workload(w), other = workload(w);
		const names = [...Array.from({ length: 25 }, (_, i) => `case ${String(i + 1).padStart(2, "0")}`), "passes"];
		const first = await terminal(w, submit(w, manifest(wl, slice, fx.head.red, "red.test.ts", names)));
		expect(first.state).toBe("failed");
		const redTree = g(w.origin, "rev-parse", `${fx.head.red}^{tree}`);
		const empty = g(w.origin, "commit-tree", redTree, "-p", fx.head.red, "-m", "retry without change");
		// Decision-log churn: the red tree plus one new .ai/decision-log entry, built in a scratch index.
		const index = { ...GIT_ENV, GIT_INDEX_FILE: join(w.root, "churn.index") };
		const gi = (...args: string[]): string => {
			const r = Bun.spawnSync(["git", ...args], { cwd: w.origin, env: index, stdout: "pipe", stderr: "pipe" });
			if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
			return r.stdout.toString().trim();
		};
		gi("read-tree", redTree);
		gi("update-index", "--add", "--cacheinfo", `100644,${g(w.origin, "rev-parse", `${fx.head.red}:red.test.ts`)},.ai/decision-log/2026-10-31--0000--lane--retry.md`);
		const churn = g(w.origin, "commit-tree", gi("write-tree"), "-p", empty, "-m", "decision log only");
		g(w.origin, "update-ref", "refs/heads/proof-empty", empty);
		g(w.origin, "update-ref", "refs/heads/proof-churn", churn);
		const refused: { sha: string; wl: string; slice: string; diagnosis: string; why: string }[] = [
			{ sha: empty, wl, slice, diagnosis: "an empty commit after the red", why: "executes the same inputs as failed" },
			{ sha: churn, wl: other.wl, slice: other.slice, diagnosis: "infrastructure only: the host was busy", why: "executes the same inputs as failed" },
			{ sha: fx.head.red, wl: other.wl, slice: other.slice, diagnosis: "budgets raised under another workload", why: "already observed" },
		];
		for (const r of refused) {
			const m = { ...manifest(r.wl, r.slice, r.sha, "red.test.ts", names), diagnosis: r.diagnosis };
			m.files[0]!.cases[0]!.budgetMs = 10_000;
			const out = submitRaw(w, m);
			expect(out.exitCode).not.toBe(0);
			expect(out.stderr.toString()).toContain(r.why);
		}
		const db = proofDbOf(w);
		try { expect(db.query("SELECT id FROM timing_proofs").all()).toEqual([{ id: first.id }]); } finally { db.close(); }
		expect(w.ledger.slice(slice)?.state).toBe("open");
	});
});
