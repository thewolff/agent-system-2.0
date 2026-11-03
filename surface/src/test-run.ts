// The outside-the-fence test runner's shared half (MIGRATION.md item 24).
// Decisions below consume plain values. The publication mutex alone opens a separate SQLite file,
// never the ledger: runner status publication and off reconciliation share its critical section.
//
// What lives here:
// - the bodies of `test-requested:`, `test-run:`, `push-dest:` (control entries, launch.ts WRITERS)
//   and `test-run-failed:` and `security-red:` (pushed signals to the orchestrator), each formatted and parsed exactly;
// - the profile's `testRunner:` block and the origin → `owner/repo` mapping every `gh -R` names;
// - the junit report (Bun's `--reporter=junit`) and the console log beside it, read into a part result;
// - the changed-test-file filter on Bun's discovery names;
// - the verdict and settle decision, ownership, liveness, the starter's reservation, retention;
// - the bound-branch rule for a PR, and the close-freshness decision over compare results;
// - the untrusted child's environment, its git shim and gitconfig, and the wrapper's argv contract.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNotLiveLedgerUnderTest, type EntryRow, type SliceState, TEST_RUNNER_BY } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";
import { branchName, controlEntries } from "./launch";
import { PUSH_DEST_PREFIX, TEST_REQUESTED_PREFIX, TEST_RUN_FAILED_PREFIX, TEST_RUN_PREFIX } from "./types";

// ---- identities, shapes, timings ---------------------------------------------------------------

export { TEST_RUNNER_BY };

/** A run id: `tr-` plus lowercase base-36. The wrapper validates the same pattern (§ 2.3 step 3). */
export const RUN_ID_RE = /^tr-[a-z0-9]+$/;
/** A full commit sha as git and GitHub print it. */
export const SHA_RE = /^[0-9a-f]{40}$/;
/** The runner rewrites its heartbeat file and the lock row's `heartbeatAt` this often (§ 2.2 step 4). */
export const HEARTBEAT_EVERY_MS = 15_000;
/** A heartbeat older than this is stale: the run is not live, and a lock holder may be replaced (§ 2.2 step 3, § 2.3 step 1). */
export const HEARTBEAT_STALE_MS = 60_000;
/** A request with no heartbeat yet stays live this long (the startup lease, § 2.2 step 3). */
export const STARTUP_LEASE_MS = 120_000;
/** Retention keeps this many runs whole (§ 2.3 step 9). */
export const KEEP_RUNS = 10;
/** A commit that touches only this directory keeps a green valid (§ 2.4 item 4, the decision-log exception). */
export const DECISION_LOG_DIR = ".ai/decision-log/";
/** Overrides the runs root (§ 2.3 step 1); tests set it to a tmp dir. Never in the untrusted child's env. */
export const RUNS_ROOT_ENV = "AGENT_SYSTEM_TEST_RUNS";

/**
 * `red-main` (PLAN wl-mv8s8srodefytc rev 17.1 D8; PLAN wl-mvq4edh02r5z40 D3): every PR part reported cleanly, no failure is in a
 * security test, every failure of the full part fails again in that file's solo part, and every failure of every failing solo part
 * also fails in base's solo run of the same file (origin/main at the sha the trusted phase fetched), so the PR adds no failure; it
 * settles like `green`.
 */
export type TestVerdict = "green" | "red-main" | "red" | "stale" | "error" | "superseded";
export const TEST_VERDICTS: readonly TestVerdict[] = ["green", "red-main", "red", "stale", "error", "superseded"];
/** The verdicts that complete the full-suite slice and post `as2/full-suite` success: a green, and a red-main (D8). */
export const SETTLING_VERDICTS: readonly TestVerdict[] = ["green", "red-main"];
/** The verdicts a `test-run-failed:` message carries: never green, red-main or superseded (a superseded run settles nothing). */
export type FailedVerdict = "red" | "stale" | "error";

/** Thrown by a formatter or builder handed a value its body cannot carry; a caller bug, never a run outcome. */
export class TestRunShapeError extends Error {}

const isSha = (s: unknown): s is string => typeof s === "string" && SHA_RE.test(s);
const isRunId = (s: unknown): s is string => typeof s === "string" && RUN_ID_RE.test(s);
const isPr = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const isToken = (s: unknown): s is string => typeof s === "string" && /^[^\s-]\S*$/.test(s);
const sha7 = (s: string) => s.slice(0, 7);
function need(ok: boolean, what: string): void {
	if (!ok) throw new TestRunShapeError(what);
}

/** A new run id from the clock and some lowercase base-36 entropy; ids sort by start time for 2.6 thousand years. */
export function makeRunId(nowMs: number, entropy: string): string {
	need(Number.isSafeInteger(nowMs) && nowMs >= 0, `run id clock ${nowMs} is not a non-negative integer`);
	need(/^[a-z0-9]{4,}$/.test(entropy), "run id entropy must be at least 4 lowercase base-36 characters");
	return `tr-${nowMs.toString(36).padStart(9, "0")}${entropy}`;
}

// ---- profile: testRunner ------------------------------------------------------------------------

export interface TestRunnerRepo {
	/** GitHub `owner/repo`, the value every `gh -R` names. */
	origin: string;
	command: string;
}
export interface TestRunnerConfig {
	repos: TestRunnerRepo[];
	fullCapMin: number;
	soloCapMin: number;
	reportCapMb: number;
	queueMaxMin: number;
	/** Workers for the PR's full part (`bun test --parallel=<n>` when over 1, written into caps.json); base runs are single files. */
	fullWorkers: number;
	/**
	 * The fast check's smoke files (PLAN wl-mvq4edbaf13vnk § 2 "The fast check"): repo-relative Bun test files every fast set
	 * holds, whatever changed (surface/src/fast-set.ts).
	 */
	fastSmoke: string[];
	/** Test files that run only in main runs on the Mac, never in the hosted Linux fast check: repo-relative path → why (§ 2, Jo's in-mvqqucfcxuevb4). */
	macOnly: Record<string, string>;
	/**
	 * Test files a main run's believability leaves out (§ 2 Main state; jo-issues #243): repo-relative path → why.
	 * They need Jo's own machine (an installed OMP) and skip every test under the `_as2test` user, so they can never count.
	 */
	mainSkip: Record<string, string>;
	/** Basenames whose change takes the full suite before merge (§ 2 Exceptions: dependencies and toolchain). */
	fullBeforeMerge: string[];
	/** Wall minutes the hosted fast run's one `bun test` call may take (D3). */
	fastCapMin: number;
	/** Minutes the runner waits on the hosted fast run before its one Mac fallback (D4). */
	fastWaitMin: number;
	/** Stuck-worker detector: shadow logs only; enforce stops the part and arms the runner backstop. */
	stuckStop: StuckStop;
}
/** The detector's modes (`testRunner.stuckStop`). */
export type StuckStop = "shadow" | "enforce";
/** `fullBeforeMerge`'s default (§ 2 Exceptions): the dependency manifests, lockfiles and build files the repository tracks today. */
export const FULL_BEFORE_MERGE_DEFAULT: readonly string[] = Object.freeze(["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "Cargo.toml", "Cargo.lock", "build.sh"]);
/** The plan's defaults (§ 2.2 step 4, § 2.3 steps 1 and 3; PLAN wl-mvq4edbaf13vnk D1), used for a key the block leaves out. */
export const TEST_RUNNER_DEFAULTS: Readonly<Omit<TestRunnerConfig, "repos">> = Object.freeze({
	fullCapMin: 20, soloCapMin: 10, reportCapMb: 50, queueMaxMin: 1440, fullWorkers: 1, stuckStop: "shadow",
	fastSmoke: Object.freeze([]) as unknown as string[], macOnly: Object.freeze({}) as Record<string, string>, mainSkip: Object.freeze({}) as Record<string, string>,
	fullBeforeMerge: FULL_BEFORE_MERGE_DEFAULT as string[],
	fastCapMin: 10, fastWaitMin: 15,
});

/** A repo-relative path a config may name: no leading `/` or `./`, no empty, `.` or `..` segment, no whitespace. */
const isRepoRelPath = (s: unknown): s is string => typeof s === "string" && s !== "" && !/\s/.test(s) && s.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

/**
 * The `testRunner:` block of a parsed profile config (`Bun.YAML.parse` of profile/config.yml). No
 * block serves no repo. A block that is present but malformed is an error, never a default: the
 * caller refuses rather than run under caps nobody wrote.
 */
export function testRunnerConfig(doc: unknown): { ok: true; config: TestRunnerConfig } | { ok: false; error: string } {
	const fresh = (repos: TestRunnerRepo[]): TestRunnerConfig => ({
		repos, ...TEST_RUNNER_DEFAULTS, fastSmoke: [...TEST_RUNNER_DEFAULTS.fastSmoke], macOnly: { ...TEST_RUNNER_DEFAULTS.macOnly }, mainSkip: { ...TEST_RUNNER_DEFAULTS.mainSkip },
		fullBeforeMerge: [...TEST_RUNNER_DEFAULTS.fullBeforeMerge],
	});
	const block = doc !== null && typeof doc === "object" && "testRunner" in doc ? doc.testRunner : undefined;
	if (block === undefined || block === null) return { ok: true, config: fresh([]) };
	if (typeof block !== "object" || Array.isArray(block)) return { ok: false, error: "testRunner is not a mapping" };
	const b = block as Record<string, unknown>;
	const repos: TestRunnerRepo[] = [];
	if (b.repos !== undefined) {
		if (!Array.isArray(b.repos)) return { ok: false, error: "testRunner.repos is not a list" };
		for (const [i, r] of b.repos.entries()) {
			const row = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : {};
			const origin = typeof row.origin === "string" ? ownerRepoOf(row.origin) : null;
			if (origin === null) return { ok: false, error: `testRunner.repos[${i}].origin is not a GitHub owner/repo` };
			if (typeof row.command !== "string" || row.command.trim() === "") return { ok: false, error: `testRunner.repos[${i}].command is missing` };
			repos.push({ origin, command: row.command.trim() });
		}
	}
	const out = fresh(repos);
	for (const key of ["fullCapMin", "soloCapMin", "reportCapMb", "queueMaxMin", "fastCapMin", "fastWaitMin"] as const) {
		const v = b[key];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return { ok: false, error: `testRunner.${key} is not a positive number` };
		out[key] = v;
	}
	if (b.fullWorkers !== undefined) {
		const v = b.fullWorkers;
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return { ok: false, error: "testRunner.fullWorkers is not an integer of 1 or more" };
		out.fullWorkers = v;
	}
	if (b.fastSmoke !== undefined) {
		const v = b.fastSmoke;
		if (!Array.isArray(v)) return { ok: false, error: "testRunner.fastSmoke is not a list" };
		const bad = v.find((p) => !isRepoRelPath(p) || !isBunTestFile(p));
		if (bad !== undefined) return { ok: false, error: `testRunner.fastSmoke names ${JSON.stringify(bad)}, which is not a repo-relative Bun test file path` };
		out.fastSmoke = [...new Set(v as string[])];
	}
	for (const key of ["macOnly", "mainSkip"] as const) {
		const v = b[key];
		if (v === undefined) continue;
		if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: `testRunner.${key} is not a mapping of path to reason` };
		for (const [path, why] of Object.entries(v)) {
			if (!isRepoRelPath(path)) return { ok: false, error: `testRunner.${key} key ${JSON.stringify(path)} is not a repo-relative path` };
			if (typeof why !== "string" || why.trim() === "") return { ok: false, error: `testRunner.${key}.${path} has no reason` };
			out[key][path] = why.trim();
		}
	}
	if (b.fullBeforeMerge !== undefined) {
		const v = b.fullBeforeMerge;
		if (!Array.isArray(v)) return { ok: false, error: "testRunner.fullBeforeMerge is not a list" };
		const bad = v.find((n) => typeof n !== "string" || n.trim() === "" || n.includes("/") || /\s/.test(n));
		if (bad !== undefined) return { ok: false, error: `testRunner.fullBeforeMerge names ${JSON.stringify(bad)}, which is not a file basename` };
		out.fullBeforeMerge = [...new Set(v as string[])];
	}
	if (b.stuckStop !== undefined) {
		if (b.stuckStop !== "shadow" && b.stuckStop !== "enforce") return { ok: false, error: "testRunner.stuckStop is not shadow or enforce" };
		out.stuckStop = b.stuckStop;
	}
	return { ok: true, config: out };
}

/** The report cap in bytes: the junit and log import reads at most this much (§ 2.2 step 4). */
export function reportCapBytes(config: Pick<TestRunnerConfig, "reportCapMb">): number {
	return Math.floor(config.reportCapMb * 1024 * 1024);
}

/**
 * GitHub `owner/repo` from a bare `owner/repo` or a github.com remote URL (https, `git@github.com:`,
 * `ssh://git@github.com/`), with any `.git` suffix dropped; null for anything else, a local path included.
 */
export function ownerRepoOf(url: string): string | null {
	const s = url.trim();
	const m =
		/^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(s) ??
		/^https:\/\/(?:[^@/\s]+@)?github\.com\/([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s) ??
		/^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
	if (!m || m[2] === "." || m[2] === "..") return null;
	return `${m[1]}/${m[2]}`;
}

/** The configured repo a workload's origin names (GitHub compares owner/repo without case), or null: the runner does not serve it. */
export function servedRepo(config: TestRunnerConfig, originUrl: string): TestRunnerRepo | null {
	const want = ownerRepoOf(originUrl)?.toLowerCase();
	if (!want) return null;
	return config.repos.find((r) => r.origin.toLowerCase() === want) ?? null;
}

// ---- where runs live ----------------------------------------------------------------------------

/** The runs root: `$AGENT_SYSTEM_TEST_RUNS`, or `test-runs` beside the resolved ledger (§ 2.3 step 1). `env` must carry HOME. */
export function runsRoot(env: Record<string, string | undefined>): string {
	const override = env[RUNS_ROOT_ENV]?.trim();
	if (override) return override;
	return join(dirname(defaultLedgerPath(env)), "test-runs");
}
/** The Jo-owned run dir under the runs root (runner.json, heartbeat, logs, junit copies, result.json). */
export function runDirOf(root: string, runId: string): string {
	need(isRunId(runId), `${runId} is not a run id`);
	return join(root, runId);
}
/** The lock database under the runs root (§ 2.3 step 1). */
export const runsDbOf = (root: string): string => join(root, "runs.db");

/**
 * Serialize the activation read and required-status publication with off revocation/completion.
 * A separate SQLite file per repository avoids holding the ledger or runs.db across network I/O.
 * Acquisition allows four bounded 30 s holders ahead; closing the connection (including process death) releases it.
 * The holder gets one aggregate 30 s deadline after acquisition. Clip every network call to remainingMs().
 * Bodies are synchronous; never return a Promise.
 */
export function withFullSuitePublication<T>(root: string, repo: string, body: (remainingMs: () => number) => T): T {
	const ownerRepo = ownerRepoOf(repo);
	if (ownerRepo === null) throw new Error(`publication mutex: ${repo} is not owner/repo`);
	const key = createHash("sha256").update(ownerRepo.toLowerCase()).digest("hex");
	const path = `${runsDbOf(root)}.publication-${key}.db`;
	assertNotLiveLedgerUnderTest(root);
	assertNotLiveLedgerUnderTest(path);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new Database(path, { create: true, strict: true });
	let failed = false;
	let failure: unknown;
	let value!: T;
	try {
		const acquireBy = Date.now() + 120_000;
		for (let attempt = 0; ; attempt++) {
			db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(30_000, acquireBy - Date.now()))}`);
			try {
				db.exec("BEGIN IMMEDIATE");
				break;
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string"
					|| !error.code.startsWith("SQLITE_BUSY") || attempt >= 3 || Date.now() >= acquireBy) throw error;
			}
		}
		const holderBy = Date.now() + 30_000;
		const remainingMs = (): number => {
			const remaining = holderBy - Date.now();
			if (remaining <= 0) throw new Error(`publication holder deadline exhausted at ${path}; retry the bounded final publication`);
			return remaining;
		};
		value = body(remainingMs);
		remainingMs();
		if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value) {
			throw new Error(`publication mutex ${path}: body returned an asynchronous value; use synchronous publication`);
		}
	} catch (error) {
		failed = true;
		failure = new Error(`publication mutex ${path} for ${ownerRepo}: ${error instanceof Error ? error.message : String(error)}; retry publication or off reconciliation`, { cause: error });
	} finally {
		try {
			db.close();
		} catch (error) {
			const cleanup = new Error(`publication mutex ${path}: close failed; inspect the publisher before retrying`, { cause: error });
			failure = failed ? new AggregateError([failure, cleanup], `publication and mutex close failed for ${ownerRepo}`) : cleanup;
			failed = true;
		}
	}
	if (failed) throw failure;
	return value;
}

/** The runner's admission plan; tree carries are not full-suite execution even when their result has full scope. */
export type FastPlan = { ref: string } & (
	| { scope: "fast"; files: string[]; parse: string[]; macOnly: string[] }
	| { scope: "full"; reasons: string[] }
	| { scope: "tree"; g: string; run: string }
);
export type FastSetPlan = Extract<FastPlan, { scope: "fast" }>;
export const FAST_PLAN_PREFIX = "fast-plan:";
export function fastPlanBody(runId: string, plan: FastPlan): string {
	if (!RUN_ID_RE.test(runId)) throw new Error(`fast-plan: ${runId} is not a run id`);
	return `${FAST_PLAN_PREFIX} ${runId} ${JSON.stringify(plan)}`;
}
const planStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
export function parseFastPlan(body: string): { runId: string; plan: FastPlan } | null {
	const m = /^fast-plan: (tr-[a-z0-9]+) (\{.*\})$/.exec(body.trim());
	if (!m) return null;
	let v: unknown;
	try {
		v = JSON.parse(m[2]!);
	} catch {
		return null;
	}
	const p = v as Record<string, unknown>;
	if (v === null || typeof v !== "object" || typeof p.ref !== "string") return null;
	const ref = p.ref;
	if (p.scope === "fast" && planStrings(p.files) && planStrings(p.parse) && planStrings(p.macOnly)) return { runId: m[1]!, plan: { ref, scope: "fast", files: p.files, parse: p.parse, macOnly: p.macOnly } };
	if (p.scope === "full" && planStrings(p.reasons)) return { runId: m[1]!, plan: { ref, scope: "full", reasons: p.reasons } };
	if (p.scope === "tree" && isSha(p.g) && isRunId(p.run)) return { runId: m[1]!, plan: { ref, scope: "tree", g: p.g, run: p.run } };
	return null;
}
/** Only plans written by the runner count; first plan per run is the admission's decision. */
export function fastPlans(entries: readonly EntryRow[]): Map<string, FastPlan> {
	const out = new Map<string, FastPlan>();
	for (const c of controlEntries(entries)) {
		if (c.prefix !== "fast-plan") continue;
		const p = parseFastPlan(c.body);
		if (p !== null && !out.has(p.runId)) out.set(p.runId, p.plan);
	}
	return out;
}
export function fastPlanOf(entries: readonly EntryRow[], runId: string): FastPlan | null {
	return fastPlans(entries).get(runId) ?? null;
}

// ---- bodies: test-requested: ---------------------------------------------------------------------

export interface TestRequested {
	runId: string;
	/** The PR; 0 for a main run, which names none. */
	pr: number;
	sha: string;
	slice: string;
	/** The lane that asked (or `plumb-bootstrap`, § 6 S8). */
	by: string;
	/**
	 * A main run (PLAN wl-mvq4edbaf13vnk D5): the full suite on the Mac of main commit `sha` of the served `repo` (`owner/repo`),
	 * requested by the tick on the standing workload; its slice is `sl-main-<run id>`, a name no slice row holds, so it settles none.
	 */
	main?: { repo: string };
}

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function checkRequested(r: TestRequested): void {
	need(isRunId(r.runId), `${r.runId} is not a run id`);
	if (r.main === undefined) need(isPr(r.pr), `${r.pr} is not a PR number`);
	else {
		need(r.pr === 0, `a main request names no PR (pr=0), not ${r.pr}`);
		need(OWNER_REPO_RE.test(r.main.repo), `${r.main.repo} is not an owner/repo`);
	}
	need(isSha(r.sha), `${r.sha} is not a full sha`);
	need(/^sl-\S+$/.test(r.slice), `${r.slice} is not a slice id`);
	need(isToken(r.by), `${r.by} is not a requester id`);
}

/** `test-requested: <run id> pr=<N> sha=<sha> slice=<slice> by=<laneId>` (§ 2.2 step 3); a main request is `pr=0 … main=1 repo=<owner/repo>`. */
export function testRequestedBody(r: TestRequested): string {
	checkRequested(r);
	return `${TEST_REQUESTED_PREFIX} ${r.runId} pr=${r.pr} sha=${r.sha} slice=${r.slice} by=${r.by}${r.main === undefined ? "" : ` main=1 repo=${r.main.repo}`}`;
}

const REQUESTED_RE = /^test-requested: (tr-[a-z0-9]+) pr=(0|[1-9]\d*) sha=([0-9a-f]{40}) slice=(sl-\S+) by=([^\s-]\S*?)(?: main=1 repo=(\S+))?$/;

export function parseTestRequested(body: string): TestRequested | null {
	const m = REQUESTED_RE.exec(body.trim());
	if (!m) return null;
	const pr = Number(m[2]);
	const repo = m[6];
	if (repo === undefined) return isPr(pr) ? { runId: m[1]!, pr, sha: m[3]!, slice: m[4]!, by: m[5]! } : null;
	if (pr !== 0 || !OWNER_REPO_RE.test(repo)) return null;
	return { runId: m[1]!, pr, sha: m[3]!, slice: m[4]!, by: m[5]!, main: { repo } };
}

// ---- bodies: test-run: ---------------------------------------------------------------------------

/** One part's counts: the full suite, or one changed test file alone. `error` names why the part is `error`, else null. */
export interface PartCounts {
	pass: number;
	fail: number;
	skip: number;
	/** The part's exit code; null when it was killed or never exited. */
	exit: number | null;
	ms: number;
	error: string | null;
}
export interface SoloCounts extends PartCounts {
	/** The exact `./<path>` the part ran. */
	file: string;
}
export interface Failure {
	/** `full`, or the solo part's `./<path>`. */
	part: string;
	/** `file > describe > name`. */
	name: string;
	/** The whole first non-empty line of its error. */
	firstError: string;
}
/**
 * One file compared with base's run of the same file alone (D8): the part (the solo `./<path>`; a record written before
 * PLAN wl-mvq4edh02r5z40 may name `full`), the names failing on the PR, the names failing on base (null when base's part
 * errored, as a solo file base lacks does), and base's error.
 */
export interface BasePart {
	part: string;
	failing: string[];
	baseFailing: string[] | null;
	baseError: string | null;
}
/** The base comparison of a run whose parts failed (D8): base's sha and each failing part, in part order. */
export interface BaseCompare {
	sha: string;
	parts: BasePart[];
}
export interface TestRun {
	runId: string;
	verdict: TestVerdict;
	sha: string;
	pr: number;
	/** Why the verdict is what it is when the counts alone do not say (error, stale, superseded); null for a plain green or red. */
	reason: string | null;
	headAtEnd: string | null;
	/** `origin/main` at the run, and the merge-base with the tested sha. */
	base: string | null;
	mergeBase: string | null;
	full: PartCounts | null;
	solo: SoloCounts[];
	/** Every failing test of every part, untruncated (§ 2.3 step 6). */
	failures: Failure[];
	runDir: string | null;
	/** The preflight's summary (§ 3.1), null when it never ran. */
	preflight: string | null;
	/** The base comparison (D8), present only on a run whose failing parts were rerun on base. */
	baseCompare?: BaseCompare;
	/**
	 * PLAN wl-mvq4edbaf13vnk D1: what ran. `full` is the whole suite; `fast` the fast set before merge (surface/src/fast-set.ts),
	 * which never counts as a full-suite result (`isFullSuiteGreen`). A row written before the field reads as `full`.
	 */
	scope: TestScope;
	/** A main run: the full suite on the Mac of one main commit (§ 2 Main state). A row written before the field reads as false. */
	main: boolean;
	/** Where the tests ran: the Mac runner, or the hosted Linux fast check (D3). A row written before the field reads as `mac`. */
	host: TestHost;
	/** The run's executed counts from its JUnit (`execOf`), or null when it has none; a row written before the field reads as null. */
	exec: ExecCounts | null;
}
export type TestScope = "full" | "fast";
export type TestHost = "mac" | "linux";
/**
 * From a run's JUnit (PLAN wl-mvq4edbaf13vnk D1): `files`, the tree's Bun test files with an executed (not skipped) test;
 * `tests`, the executed tests; `treeFiles`, the Bun test files in the tested commit's tree. Believability reads them
 * (surface/src/main-state.ts `believable`).
 */
export interface ExecCounts {
	files: number;
	tests: number;
	treeFiles: number;
}
/** The fields a run written before PLAN wl-mvq4edbaf13vnk D1 lacks; a body built without them carries their old-row values. */
type LandFirstFields = "scope" | "main" | "host" | "exec";
/** A run as a caller may hand it to `testRunBody`: the D1 fields optional, read as a full, non-main Mac run with no exec counts. */
export type TestRunInput = Omit<TestRun, LandFirstFields> & Partial<Pick<TestRun, LandFirstFields>>;
/** How a row written before PLAN wl-mvq4edbaf13vnk D1 reads, and what a full PR run on the Mac carries until its runner sets exec. */
export const OLD_ROW_FIELDS: Readonly<Pick<TestRun, LandFirstFields>> = Object.freeze({ scope: "full", main: false, host: "mac", exec: null });

/** A green that counts as a full-suite result: a fast green never does (PLAN wl-mvq4edbaf13vnk D1). */
export function isFullSuiteGreen(run: Pick<TestRun, "verdict" | "scope">): boolean {
	return run.verdict === "green" && run.scope === "full";
}

const nat = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const strOrNull = (s: unknown): s is string | null => s === null || typeof s === "string";
const shaOrNull = (s: unknown): s is string | null => s === null || isSha(s);

function partOf(v: unknown): PartCounts | null {
	if (v === null || typeof v !== "object") return null;
	const p = v as Record<string, unknown>;
	if (!nat(p.pass) || !nat(p.fail) || !nat(p.skip) || !nat(p.ms)) return null;
	if (!(p.exit === null || (typeof p.exit === "number" && Number.isSafeInteger(p.exit)))) return null;
	if (!strOrNull(p.error)) return null;
	return { pass: p.pass, fail: p.fail, skip: p.skip, exit: p.exit as number | null, ms: p.ms, error: p.error };
}
function soloOf(v: unknown): SoloCounts | null {
	const part = partOf(v);
	const file = v !== null && typeof v === "object" && "file" in v ? v.file : undefined;
	if (!part || typeof file !== "string" || !file.startsWith("./")) return null;
	return { file, ...part };
}
function failureOf(v: unknown): Failure | null {
	if (v === null || typeof v !== "object") return null;
	const f = v as Record<string, unknown>;
	if (typeof f.part !== "string" || typeof f.name !== "string" || typeof f.firstError !== "string") return null;
	return { part: f.part, name: f.name, firstError: f.firstError };
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
function baseCompareOf(v: unknown): BaseCompare | null {
	if (v === null || typeof v !== "object") return null;
	const b = v as Record<string, unknown>;
	if (!isSha(b.sha) || !Array.isArray(b.parts)) return null;
	const parts: BasePart[] = [];
	for (const p of b.parts as unknown[]) {
		if (p === null || typeof p !== "object") return null;
		const x = p as Record<string, unknown>;
		if (typeof x.part !== "string" || !strings(x.failing) || !(x.baseFailing === null || strings(x.baseFailing)) || !strOrNull(x.baseError)) return null;
		parts.push({ part: x.part, failing: [...x.failing], baseFailing: x.baseFailing === null ? null : [...x.baseFailing], baseError: x.baseError });
	}
	return { sha: b.sha, parts };
}
function execCountsOf(v: unknown): ExecCounts | null {
	if (v === null || typeof v !== "object") return null;
	const e = v as Record<string, unknown>;
	if (!nat(e.files) || !nat(e.tests) || !nat(e.treeFiles) || e.files > e.treeFiles) return null;
	return { files: e.files, tests: e.tests, treeFiles: e.treeFiles };
}

/** The canonical TestRun built from untrusted fields, or null: the one shape both the formatter and the parser accept. */
function canonicalRun(head: { runId: unknown; verdict: unknown; sha: unknown; pr: unknown }, v: Record<string, unknown>): TestRun | null {
	if (!isRunId(head.runId) || !TEST_VERDICTS.includes(head.verdict as TestVerdict) || !isSha(head.sha)) return null;
	// D1's fields, each absent on a row written before them: full scope, not main, the Mac, no exec counts.
	const scope = v.scope === undefined ? "full" : v.scope;
	const main = v.main === undefined ? false : v.main;
	const host = v.host === undefined ? "mac" : v.host;
	const exec = v.exec === undefined || v.exec === null ? null : execCountsOf(v.exec);
	if ((scope !== "full" && scope !== "fast") || typeof main !== "boolean" || (host !== "mac" && host !== "linux")) return null;
	if (v.exec !== undefined && v.exec !== null && exec === null) return null;
	// A main run is the full suite on the Mac of one main commit (§ 2 Main state); it names no PR, so it alone carries pr 0.
	if (main && (scope !== "full" || host !== "mac")) return null;
	if (!(isPr(head.pr) || (main && head.pr === 0))) return null;
	if (v.sha !== head.sha || v.pr !== head.pr) return null;
	if (!strOrNull(v.reason) || !shaOrNull(v.headAtEnd) || !shaOrNull(v.base) || !shaOrNull(v.mergeBase)) return null;
	if (!strOrNull(v.runDir) || !strOrNull(v.preflight)) return null;
	const full = v.full === null ? null : partOf(v.full);
	if (v.full !== null && full === null) return null;
	if (!Array.isArray(v.solo) || !Array.isArray(v.failures)) return null;
	const solo = v.solo.map(soloOf);
	const failures = v.failures.map(failureOf);
	if (solo.some((s) => s === null) || failures.some((f) => f === null)) return null;
	// A red-main always carries the comparison it rests on; any other verdict may carry one (a red that was compared).
	const baseCompare = v.baseCompare === undefined || v.baseCompare === null ? null : baseCompareOf(v.baseCompare);
	if (v.baseCompare !== undefined && v.baseCompare !== null && baseCompare === null) return null;
	if (head.verdict === "red-main" && baseCompare === null) return null;
	return {
		runId: head.runId, verdict: head.verdict as TestVerdict, sha: head.sha, pr: head.pr as number, reason: v.reason, headAtEnd: v.headAtEnd,
		base: v.base, mergeBase: v.mergeBase, full, solo: solo as SoloCounts[], failures: failures as Failure[], runDir: v.runDir, preflight: v.preflight,
		...(baseCompare === null ? {} : { baseCompare }), scope, main, host, exec,
	};
}

/**
 * `test-run: <run id> <verdict> sha=<sha> pr=<N> {json}` (§ 2.3 step 6). The json repeats sha and pr
 * and carries reason, headAtEnd, base, mergeBase, full, solo, failures (every one), runDir and
 * preflight, plus baseCompare when the run has one (D8), on one line. The same object goes to `result.json`.
 * D1's fields ride only when they differ from an old row's reading (scope fast, main, host linux, exec counts),
 * so a full Mac PR run's body is the one it was before them. A main run carries pr=0.
 */
export function testRunBody(run: TestRunInput): string {
	const c = canonicalRun(run, run as unknown as Record<string, unknown>);
	need(c !== null, `test-run ${run.runId} does not have the shape its body carries`);
	const json = JSON.stringify({
		sha: c!.sha, pr: c!.pr, reason: c!.reason, headAtEnd: c!.headAtEnd, base: c!.base, mergeBase: c!.mergeBase, full: c!.full, solo: c!.solo,
		failures: c!.failures, runDir: c!.runDir, preflight: c!.preflight, ...(c!.baseCompare ? { baseCompare: c!.baseCompare } : {}),
		...(c!.scope === "full" ? {} : { scope: c!.scope }), ...(c!.main ? { main: true } : {}), ...(c!.host === "mac" ? {} : { host: c!.host }),
		...(c!.exec === null ? {} : { exec: c!.exec }),
	});
	return `${TEST_RUN_PREFIX} ${c!.runId} ${c!.verdict} sha=${c!.sha} pr=${c!.pr} ${json}`;
}

const RUN_RE = /^test-run: (tr-[a-z0-9]+) (green|red-main|red|stale|error|superseded) sha=([0-9a-f]{40}) pr=(0|[1-9]\d*) (\{.*\})$/;

export function parseTestRun(body: string): TestRun | null {
	const m = RUN_RE.exec(body.trim());
	if (!m) return null;
	let v: unknown;
	try {
		v = JSON.parse(m[5]!);
	} catch {
		return null;
	}
	if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
	return canonicalRun({ runId: m[1], verdict: m[2], sha: m[3], pr: Number(m[4]) }, v as Record<string, unknown>);
}

/** The json `result.json` holds: the entry's own object, header fields included. */
export function resultJson(run: TestRun): string {
	const body = testRunBody(run);
	return `${JSON.stringify({ runId: run.runId, verdict: run.verdict, ...JSON.parse(body.slice(body.indexOf("{"))) }, null, 2)}\n`;
}

/** The dead-runner settle (§ 2.2 step 3): `error`, reason `runner died`, no counts. */
export function runnerDiedRun(request: TestRequested, runDir: string | null = null): TestRun {
	return {
		runId: request.runId, verdict: "error", sha: request.sha, pr: request.pr, reason: "runner died", headAtEnd: null, base: null, mergeBase: null,
		full: null, solo: [], failures: [], runDir, preflight: null, ...OLD_ROW_FIELDS,
	};
}

// ---- bodies: test-run-failed: (a pushed signal) ----------------------------------------------------

export interface TestRunFailed {
	workloadId: string;
	slice: string;
	verdict: FailedVerdict;
	sha: string;
	failing: number;
	/** The first failing test's name, null when none is known (an error or stale run). */
	first: string | null;
}

/** `test-run-failed: <wl> <slice> <verdict> at <sha>: <n> failing[, first <name>]` (§ 2.3 step 8); the name is folded to one line. */
export function testRunFailedBody(f: TestRunFailed): string {
	need(/^wl-\S+$/.test(f.workloadId), `${f.workloadId} is not a workload id`);
	need(/^sl-\S+$/.test(f.slice), `${f.slice} is not a slice id`);
	need(f.verdict === "red" || f.verdict === "stale" || f.verdict === "error", `${f.verdict} is not a failed verdict`);
	need(isSha(f.sha), `${f.sha} is not a full sha`);
	need(nat(f.failing), `${f.failing} is not a count`);
	const first = f.first === null ? "" : f.first.replace(/\s+/g, " ").trim();
	return `${TEST_RUN_FAILED_PREFIX} ${f.workloadId} ${f.slice} ${f.verdict} at ${f.sha}: ${f.failing} failing${first ? `, first ${first}` : ""}`;
}

const FAILED_RE = /^test-run-failed: (wl-\S+) (sl-\S+) (red|stale|error) at ([0-9a-f]{40}): (0|[1-9]\d*) failing(?:, first (\S.*))?$/;

export function parseTestRunFailed(body: string): TestRunFailed | null {
	const m = FAILED_RE.exec(body.trim());
	if (!m) return null;
	const failing = Number(m[5]);
	if (!nat(failing)) return null;
	return { workloadId: m[1]!, slice: m[2]!, verdict: m[3] as FailedVerdict, sha: m[4]!, failing, first: m[6] ?? null };
}

/** The signal for a finished run that is not green, or null for green, red-main and superseded. */
export function testRunFailedOf(workloadId: string, slice: string, run: TestRun): TestRunFailed | null {
	if (run.verdict === "green" || run.verdict === "red-main" || run.verdict === "superseded") return null;
	const counted = (run.full?.fail ?? 0) + run.solo.reduce((n, s) => n + s.fail, 0);
	return { workloadId, slice, verdict: run.verdict, sha: run.sha, failing: Math.max(counted, run.failures.length), first: run.failures[0]?.name ?? null };
}

// ---- bodies: security-red: (a pushed signal, PLAN wl-mvg1vs0rhnu3gg § 3.3) ---------------------------

/** The security tests: as2 has no auth, so its security tests are the gate tests (P-11 rows, fence, reserved actions). */
export const SECURITY_TEST_PATHS: readonly string[] = ["gates/test/"];
/** Body prefix of the runner's message to the orchestrator for a run with a failing security test. */
export const SECURITY_RED_PREFIX = "security-red:";

export interface SecurityRed {
	workloadId: string;
	slice: string;
	runId: string;
	sha: string;
	/** The run's failures under a security path, a test failing in two parts counted in each. */
	failing: number;
	/** The first such failure's name, folded to one line. */
	first: string;
}

/** A path repo-relative: a leading `./` (a solo part's argument) dropped, so it compares with Bun's junit `file` attribute. */
const repoRel = (path: string): string => path.replace(/^\.\//, "");
/** The file part of a failure's `file > describe > name` (Bun 1.3.14's junit `file` attribute: repo-relative, no `./`). */
const fileOfName = (name: string): string => name.split(" > ")[0]!;

/** A security test's path (PLAN wl-mvq4edh02r5z40 D0): the path, repo-relative with any `./` dropped, starts with an entry of SECURITY_TEST_PATHS. */
export function isSecurityPath(path: string): boolean {
	const rel = repoRel(path);
	return SECURITY_TEST_PATHS.some((p) => rel.startsWith(p));
}

/** A failure is in a security test when its part (a solo `./<path>`) or the file part of its name is a security path (`isSecurityPath`). */
const isSecurityFailure = (f: { part: string; name: string }): boolean => isSecurityPath(f.part) || isSecurityPath(fileOfName(f.name));

/**
 * The run's failures in a security test (`isSecurityPath` over the part or the name's file part), in run order. Every verdict
 * but `superseded` counts, `red-main` included: main failing the same test does not make a broken gate safe.
 */
export function securityFailuresOf(run: TestRun): Failure[] {
	if (run.verdict === "superseded") return [];
	return run.failures.filter(isSecurityFailure);
}

/** `security-red: <wl> <slice> <run id> <sha> <n> <first name>`; the name is folded to one line. */
export function securityRedBody(s: SecurityRed): string {
	need(/^wl-\S+$/.test(s.workloadId), `${s.workloadId} is not a workload id`);
	need(/^sl-\S+$/.test(s.slice), `${s.slice} is not a slice id`);
	need(isRunId(s.runId), `${s.runId} is not a run id`);
	need(isSha(s.sha), `${s.sha} is not a full sha`);
	need(nat(s.failing) && s.failing > 0, `${s.failing} is not a positive count`);
	const first = s.first.replace(/\s+/g, " ").trim();
	need(first !== "", "the first failure has no name");
	return `${SECURITY_RED_PREFIX} ${s.workloadId} ${s.slice} ${s.runId} ${s.sha} ${s.failing} ${first}`;
}

const SECURITY_RED_RE = /^security-red: (wl-\S+) (sl-\S+) (tr-[a-z0-9]+) ([0-9a-f]{40}) ([1-9]\d*) (\S.*)$/;

export function parseSecurityRed(body: string): SecurityRed | null {
	const m = SECURITY_RED_RE.exec(body.trim());
	if (!m) return null;
	const failing = Number(m[5]);
	if (!nat(failing)) return null;
	return { workloadId: m[1]!, slice: m[2]!, runId: m[3]!, sha: m[4]!, failing, first: m[6]! };
}

/** The signal for a finished run with a failing security test (`securityFailuresOf`), or null when it has none. */
export function securityRedOf(workloadId: string, slice: string, run: TestRun): SecurityRed | null {
	const failures = securityFailuresOf(run);
	if (failures.length === 0) return null;
	return { workloadId, slice, runId: run.runId, sha: run.sha, failing: failures.length, first: failures[0]!.name };
}

// ---- bodies: push-dest: --------------------------------------------------------------------------

export interface PushDest {
	remote: string;
	/** The short branch name the push targets (row 8 strips `refs/heads/`). */
	branch: string;
	sha: string;
}

/** `push-dest: <remote> <branch> <sha>` (§ 2.2 step 2), written by row 8 as the holder lane. */
export function pushDestBody(d: PushDest): string {
	need(isToken(d.remote), `${d.remote} is not a remote name`);
	need(isToken(d.branch) && !d.branch.startsWith("refs/"), `${d.branch} is not a short branch name`);
	need(isSha(d.sha), `${d.sha} is not a full sha`);
	return `${PUSH_DEST_PREFIX} ${d.remote} ${d.branch} ${d.sha}`;
}

const PUSH_DEST_RE = /^push-dest: ([^\s-]\S*) ([^\s-]\S*) ([0-9a-f]{40})$/;

export function parsePushDest(body: string): PushDest | null {
	const m = PUSH_DEST_RE.exec(body.trim());
	if (!m || m[2]!.startsWith("refs/")) return null;
	return { remote: m[1]!, branch: m[2]!, sha: m[3]! };
}

// ---- the runner's records on a workload ----------------------------------------------------------

export interface RequestRecord extends TestRequested {
	entryId: string;
	createdAt: string;
}
export interface ResultRecord extends TestRun {
	entryId: string;
	createdAt: string;
}
export interface RunRecord {
	request: RequestRecord;
	/** Every `test-run:` for this run id, oldest first. */
	results: ResultRecord[];
	/** The first result that is not `superseded`: the run's own verdict. A later write is diagnostic only. */
	result: ResultRecord | null;
}

/**
 * The runner's requests and their results among a workload's entries, oldest first (pass entries in
 * ledger order). Only entries the runner wrote and whose body parses count (launch.ts WRITERS); a
 * result naming no request is dropped.
 */
export function testRuns(entries: readonly EntryRow[]): RunRecord[] {
	const out: RunRecord[] = [];
	const byRun = new Map<string, RunRecord>();
	for (const c of controlEntries(entries)) {
		if (c.prefix === "test-requested") {
			const r = parseTestRequested(c.body);
			if (!r || byRun.has(r.runId)) continue;
			const rec: RunRecord = { request: { ...r, entryId: c.id, createdAt: c.createdAt }, results: [], result: null };
			byRun.set(r.runId, rec);
			out.push(rec);
		} else if (c.prefix === "test-run") {
			const r = parseTestRun(c.body);
			const rec = r ? byRun.get(r.runId) : undefined;
			if (!r || !rec || r.sha !== rec.request.sha || r.pr !== rec.request.pr) continue;
			const res: ResultRecord = { ...r, entryId: c.id, createdAt: c.createdAt };
			rec.results.push(res);
			if (rec.result === null && r.verdict !== "superseded") rec.result = res;
		}
	}
	return out;
}

/**
 * Ownership (§ 2.2 step 5): the run's request is the newest on its slice and no `test-run:` for its
 * run id exists yet. Only an owner writes its verdict and settles; it is checked in the transaction
 * that writes.
 */
export function ownsRequest(records: readonly RunRecord[], runId: string): boolean {
	const mine = records.find((r) => r.request.runId === runId);
	if (!mine || mine.results.length > 0) return false;
	const newest = records.filter((r) => r.request.slice === mine.request.slice).at(-1);
	return newest === mine;
}

// ---- liveness, heartbeat, reservation -----------------------------------------------------------

/**
 * A run is live iff it has no `test-run:` and either its heartbeat is under 60 s old, or it has no
 * heartbeat yet and its request is under 120 s old (§ 2.2 step 3). The heartbeat here is the file
 * `<run dir>/heartbeat` (parseHeartbeat), not the lock row's `heartbeatAt` (lockHolderStale).
 */
export function runLive(r: { settled: boolean; requestedAtMs: number; heartbeatAtMs: number | null }, nowMs: number): boolean {
	if (r.settled) return false;
	if (r.heartbeatAtMs !== null) return nowMs - r.heartbeatAtMs < HEARTBEAT_STALE_MS;
	return nowMs - r.requestedAtMs < STARTUP_LEASE_MS;
}

/** The lock row's holder may be replaced when its `heartbeatAt` is over 60 s old (§ 2.3 step 1). */
export function lockHolderStale(heartbeatAtMs: number, nowMs: number): boolean {
	return nowMs - heartbeatAtMs > HEARTBEAT_STALE_MS;
}

/** The heartbeat file's text: `<run id> <ISO time>`. */
export function heartbeatText(runId: string, nowMs: number): string {
	need(isRunId(runId), `${runId} is not a run id`);
	return `${runId} ${new Date(nowMs).toISOString()}\n`;
}
/** The heartbeat time in ms, or null when the text is not this run's heartbeat. */
export function parseHeartbeat(text: string, runId: string): number | null {
	const m = /^(tr-[a-z0-9]+) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/.exec(text.trim());
	if (!m || m[1] !== runId) return null;
	const ms = Date.parse(m[2]!);
	return Number.isFinite(ms) ? ms : null;
}

/** A record's liveness, its heartbeat read by the caller (null when there is none or it does not parse). */
export function recordLive(rec: RunRecord, heartbeatAtMs: number | null, nowMs: number): boolean {
	return runLive({ settled: rec.results.length > 0, requestedAtMs: Date.parse(rec.request.createdAt), heartbeatAtMs }, nowMs);
}

/**
 * The starter's reservation decision (§ 2.2 step 3), made in its transaction over the workload's
 * records: refused while any run is live; otherwise every unsettled request that is not live is
 * settled first as `runner died`, then the new request is written.
 */
export function reservation(
	records: readonly RunRecord[], heartbeatOf: (runId: string) => number | null, nowMs: number,
): { ok: false; live: RunRecord } | { ok: true; settleDead: RunRecord[] } {
	const settleDead: RunRecord[] = [];
	for (const rec of records) {
		if (rec.results.length > 0) continue;
		if (recordLive(rec, heartbeatOf(rec.request.runId), nowMs)) return { ok: false, live: rec };
		settleDead.push(rec);
	}
	return { ok: true, settleDead };
}

/**
 * A run that has waited for the lock past `queueMaxMin` ends `error queued too long` (§ 2.3 step 1); a merge train's run
 * (`train`: its workload has train membership, `trainPrs` non-empty) never does (jo-issues #213). The cap is not what keeps
 * the queue moving past dead runs: a dead lock holder is replaced through `lockHolderStale` and a dead waiter ahead is pruned
 * through `queueWaiterLive`, so a train's run only ever waits behind live work, and expiring it would send it to the back.
 */
export function queuedTooLong(waitStartMs: number, nowMs: number, config: Pick<TestRunnerConfig, "queueMaxMin">, train: boolean): boolean {
	if (train) return false;
	return nowMs - waitStartMs > config.queueMaxMin * 60_000;
}

/** A waiter's row in runs.db's `queue` table: its run, its workload, and its place, the request's `created_at` in ms. */
export interface QueueRow {
	runId: string;
	workloadId: string;
	requestedAt: number;
	/** Main requests take the Mac before waiting PRs; absent on old queue rows. */
	main?: boolean;
}

/**
 * A queued waiter blocks the runs behind it while its run is live (`recordLive`: not settled, and a heartbeat under 60 s old,
 * or none yet inside the startup lease). A row whose request the ledger does not hold is dead.
 */
export function queueWaiterLive(rec: RunRecord | undefined, heartbeatAtMs: number | null, nowMs: number): boolean {
	return rec !== undefined && recordLive(rec, heartbeatAtMs, nowMs);
}

/**
 * The waiters ahead of `selfId`, oldest request first (requestedAt, then run id): every dead one before the first live one is
 * reported for pruning, and that first live one is the blocker. Rows behind `selfId` are never judged. `selfId` must be among
 * the rows (the runner registers in the same transaction).
 */
export function queueAhead(rows: readonly QueueRow[], selfId: string, live: (row: QueueRow) => boolean): { blocker: string | null; dead: string[] } {
	need(rows.some((r) => r.runId === selfId), `${selfId} is not in the queue`);
	const ordered = [...rows].sort((a, b) => Number(b.main ?? false) - Number(a.main ?? false) || a.requestedAt - b.requestedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
	const dead: string[] = [];
	for (const row of ordered) {
		if (row.runId === selfId) break;
		if (live(row)) return { blocker: row.runId, dead };
		dead.push(row.runId);
	}
	return { blocker: null, dead };
}

// ---- the full-suite slice ------------------------------------------------------------------------

/** The slice the starter adds (§ 2.1): `sl-full-<wl without wl->-<n>`, n one past the highest taken. */
export function fullSuiteSlice(workloadId: string, pr: number, existingSliceIds: readonly string[]): { id: string; task: string; doneCondition: string } {
	need(/^wl-\S+$/.test(workloadId), `${workloadId} is not a workload id`);
	need(isPr(pr), `${pr} is not a PR number`);
	const stem = `sl-full-${workloadId.slice(3)}-`;
	let n = 0;
	for (const id of existingSliceIds) {
		if (!id.startsWith(stem)) continue;
		const k = Number(id.slice(stem.length));
		if (Number.isSafeInteger(k) && k > n) n = k;
	}
	return { id: `${stem}${n + 1}`, task: `full suite outside the fence at PR #${pr}`, doneCondition: "a green test-run at the PR head" };
}

// ---- the bound branch -----------------------------------------------------------------------------

/** `gh pr view <N> -R <owner/repo> --json number,state,headRefOid,headRefName,baseRefName,isCrossRepository`. */
export interface PrView {
	number: number;
	state: string;
	headRefOid: string;
	headRefName: string;
	baseRefName: string;
	isCrossRepository: boolean;
}

/**
 * The branches a workload is bound to (§ 2.2 step 2): `wl/<wl>` plus every `push-dest:` a holder of it wrote.
 * A PR on any other branch runs only when Jo bound its number to the workload (`boundPrs`, surface/src/launch.ts).
 */
export function boundBranches(workloadId: string, entries: readonly EntryRow[], holders: readonly string[]): string[] {
	const out = [branchName(workloadId)];
	for (const c of controlEntries(entries, holders)) {
		if (c.prefix !== "push-dest") continue;
		const d = parsePushDest(c.body);
		if (d && !out.includes(d.branch)) out.push(d.branch);
	}
	return out;
}

/**
 * Whether the starter may test this PR (§ 2.2 step 2; PLAN wl-mv5qdfvv82ivwg § 2.2): open and same
 * repository, always and first; then a head branch the workload is bound to (`bound`) or a number
 * Jo bound to it with `test-pr` (`prs`, from `boundPrs`); then a full head sha. A bound number
 * never admits a closed, merged or fork PR.
 */
export function prAdmissible(pr: PrView, bound: readonly string[], prs: readonly number[] = []): { ok: true } | { ok: false; reason: string } {
	if (pr.state !== "OPEN") return { ok: false, reason: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };
	if (pr.isCrossRepository !== false) return { ok: false, reason: `PR #${pr.number} comes from a fork; a fork head never runs` };
	if (!bound.includes(pr.headRefName) && !prs.includes(pr.number)) {
		const wl = bound[0]?.startsWith("wl/") ? bound[0].slice(3) : "<wl-…>";
		return {
			ok: false,
			reason: `PR #${pr.number}'s head branch ${pr.headRefName} is not one this workload is bound to (${bound.join(", ")}) and Jo has not bound PR #${pr.number} to it (\`test-pr ${wl} ${pr.number}\`)`,
		};
	}
	if (!isSha(pr.headRefOid)) return { ok: false, reason: `PR #${pr.number} reports no full head sha` };
	return { ok: true };
}

// ---- changed test files ---------------------------------------------------------------------------

/** Bun's discovery names: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` over these extensions. */
export const BUN_TEST_FILE_RE = /[._](?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

export function isBunTestFile(path: string): boolean {
	const base = path.slice(path.lastIndexOf("/") + 1);
	return BUN_TEST_FILE_RE.test(base);
}

/** git's C-style quoting of a path (`core.quotePath`), undone; null when the quoting is malformed. */
function unquoteGitPath(q: string): string | null {
	if (!q.startsWith('"')) return q;
	if (q.length < 2 || !q.endsWith('"')) return null;
	const bytes: number[] = [];
	const enc = new TextEncoder();
	const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
	for (let i = 1; i < q.length - 1; i++) {
		const ch = q[i]!;
		if (ch !== "\\") {
			bytes.push(...enc.encode(ch));
			continue;
		}
		const nx = q[++i];
		if (nx === undefined) return null;
		if (/[0-7]/.test(nx)) {
			const oct = q.slice(i, i + 3);
			if (!/^[0-7]{3}$/.test(oct)) return null;
			bytes.push(Number.parseInt(oct, 8));
			i += 2;
		} else if (nx in simple) bytes.push(simple[nx]!);
		else return null;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

/**
 * The changed test files to run alone (§ 2.3 step 2), from `git diff --name-only --diff-filter=AMR
 * <merge-base> <sha>` output (newline-separated, git's quoting undone; or NUL-separated with `-z`):
 * Bun's discovery names only, each as the exact `./<path>` argument, in git's order, without repeats.
 * An absolute path or one with a `..` segment is dropped: it cannot name a file inside the clone.
 */
export function changedTestFiles(gitOutput: string): string[] {
	const raw = gitOutput.includes("\0") ? gitOutput.split("\0") : gitOutput.split("\n").map((l) => unquoteGitPath(l.replace(/\r$/, "")));
	const out: string[] = [];
	for (const p of raw) {
		if (p === null || p === "" || p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "")) continue;
		if (!isBunTestFile(p)) continue;
		const arg = `./${p}`;
		if (!out.includes(arg)) out.push(arg);
	}
	return out;
}

// ---- junit, the log, a part's result -------------------------------------------------------------

interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	text: string;
}
class XmlError extends Error {}

const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(s: string): string {
	if (/&(?!(?:#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);)/.test(s)) throw new XmlError("a bare & or an unknown entity");
	return s.replace(ENTITY, (_m, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
		if (named) return NAMED[named]!;
		const cp = Number.parseInt((hex ?? dec)!, hex ? 16 : 10);
		if (!(cp > 0 && cp <= 0x10ffff)) throw new XmlError("a character reference out of range");
		return String.fromCodePoint(cp);
	});
}

/** A strict reader for the XML Bun's junit reporter writes: elements, attributes, text, CDATA, comments, the declaration. Anything else throws. */
function parseXml(src: string): XmlNode {
	let i = 0;
	const stack: XmlNode[] = [];
	let root: XmlNode | null = null;
	const fail = (why: string): never => {
		throw new XmlError(`${why} at offset ${i}`);
	};
	const readName = (): string => {
		const m = /[A-Za-z_][\w:.-]*/y;
		m.lastIndex = i;
		const r = m.exec(src);
		if (!r) fail("a name was expected");
		i += r![0].length;
		return r![0];
	};
	const skipWs = () => {
		while (i < src.length && /\s/.test(src[i]!)) i++;
	};
	const text = (s: string) => {
		const top = stack.at(-1);
		if (!top) {
			if (s.trim() !== "") fail("text outside the root element");
			return;
		}
		top.text += decodeXml(s);
	};
	while (i < src.length) {
		const lt = src.indexOf("<", i);
		if (lt === -1) {
			text(src.slice(i));
			break;
		}
		if (lt > i) text(src.slice(i, lt));
		i = lt;
		if (src.startsWith("<!--", i)) {
			const end = src.indexOf("-->", i + 4);
			if (end < 0) fail("an unterminated comment");
			i = end + 3;
		} else if (src.startsWith("<![CDATA[", i)) {
			const end = src.indexOf("]]>", i + 9);
			if (end < 0) fail("an unterminated CDATA section");
			if (stack.length === 0) fail("CDATA outside the root element");
			stack.at(-1)!.text += src.slice(i + 9, end);
			i = end + 3;
		} else if (src.startsWith("<?", i)) {
			if (root !== null) fail("a processing instruction after the root element opened");
			const end = src.indexOf("?>", i + 2);
			if (end < 0) fail("an unterminated declaration");
			i = end + 2;
		} else if (src.startsWith("<!", i)) {
			fail("a DOCTYPE or markup declaration");
		} else if (src.startsWith("</", i)) {
			i += 2;
			const name = readName();
			skipWs();
			if (src[i] !== ">") fail(`an unterminated </${name}>`);
			i++;
			const open = stack.pop();
			if (!open || open.name !== name) fail(`</${name}> closes ${open ? `<${open.name}>` : "nothing"}`);
		} else {
			i++;
			const node: XmlNode = { name: readName(), attrs: {}, children: [], text: "" };
			if (stack.length === 0) {
				if (root !== null) fail("a second root element");
				root = node;
			} else stack.at(-1)!.children.push(node);
			for (;;) {
				const before = i;
				skipWs();
				if (src.startsWith("/>", i)) {
					i += 2;
					break;
				}
				if (src[i] === ">") {
					i++;
					stack.push(node);
					break;
				}
				if (i === before) fail(`a malformed <${node.name}> tag`);
				const an = readName();
				skipWs();
				if (src[i] !== "=") fail(`attribute ${an} has no value`);
				i++;
				skipWs();
				const q = src[i];
				if (q !== '"' && q !== "'") fail(`attribute ${an} is not quoted`);
				const end = src.indexOf(q!, i + 1);
				if (end < 0) fail(`attribute ${an} is unterminated`);
				const raw = src.slice(i + 1, end);
				if (raw.includes("<")) fail(`attribute ${an} holds a <`);
				if (an in node.attrs) fail(`attribute ${an} appears twice`);
				node.attrs[an] = decodeXml(raw);
				i = end + 1;
			}
		}
	}
	if (stack.length > 0) fail(`<${stack.at(-1)!.name}> is never closed`);
	if (root === null) fail("no root element");
	return root!;
}

export interface JunitFailure {
	file: string;
	/** The describe blocks, outermost first. */
	describes: string[];
	name: string;
	/** `file > describe > name`. */
	fullName: string;
	/** The first non-empty line of the report's own failure message, null when it has none (Bun 1.3 writes none). */
	message: string | null;
	type: string | null;
}
export type JunitReport =
	| { ok: true; tests: number; pass: number; fail: number; skip: number; failures: JunitFailure[] }
	| { ok: false; error: string };

const firstLine = (s: string | undefined): string | null => {
	if (s === undefined) return null;
	const l = s.split(/\r?\n/).map((x) => x.trim()).find((x) => x !== "");
	return l ?? null;
};
const countAttr = (n: XmlNode, a: string, required: boolean): number | null => {
	const v = n.attrs[a];
	if (v === undefined) return required ? null : 0;
	return /^\d+$/.test(v) ? Number(v) : null;
};

/**
 * Each `<testcase>` under the report root, in report order, with its file (the case's own `file` attribute, else the outer
 * `<testsuite>`'s `file` or `name`) and its describes (each nested `<testsuite>`'s name, outermost first).
 */
function eachCase(root: XmlNode, visit: (testcase: XmlNode, file: string, describes: string[]) => void): void {
	const walk = (node: XmlNode, file: string | null, describes: string[]): void => {
		for (const c of node.children) {
			if (c.name === "testsuite") {
				if (file === null) walk(c, c.attrs.file ?? c.attrs.name ?? "?", []);
				else walk(c, file, [...describes, c.attrs.name ?? "?"]);
			} else if (c.name === "testcase") visit(c, c.attrs.file ?? file ?? "?", describes);
		}
	};
	walk(root, null, []);
}

/**
 * Bun's junit report (`bun test --reporter=junit --reporter-outfile=<file>`, measured on 1.3.14)
 * read into counts and failing tests. The counts are the `<testsuites>` attributes: tests, failures
 * (plus errors when present) and skipped (todo included); pass is what is left. A failing test is a
 * `<testcase>` holding `<failure>` or `<error>`; its path comes from the nested `<testsuite>`
 * elements (the file, then each describe). A report over `maxBytes`, empty, malformed or with
 * inconsistent counts is `ok: false`: never green.
 */
export function parseJunit(xml: string, opts: { maxBytes?: number } = {}): JunitReport {
	if (opts.maxBytes !== undefined && Buffer.byteLength(xml, "utf8") > opts.maxBytes) return { ok: false, error: `junit report is over the ${opts.maxBytes}-byte cap` };
	if (xml.trim() === "") return { ok: false, error: "junit report is empty" };
	let root: XmlNode;
	try {
		root = parseXml(xml);
	} catch (e) {
		return { ok: false, error: `junit report does not parse: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (root.name !== "testsuites") return { ok: false, error: `junit root is <${root.name}>, not <testsuites>` };
	const tests = countAttr(root, "tests", true);
	const failures = countAttr(root, "failures", true);
	const errors = countAttr(root, "errors", false);
	const skipped = countAttr(root, "skipped", false);
	if (tests === null || failures === null || errors === null || skipped === null) return { ok: false, error: "junit <testsuites> counts are missing or not whole numbers" };
	const out: JunitFailure[] = [];
	let cases = 0;
	eachCase(root, (c, file, describes) => {
		cases++;
		const f = c.children.find((x) => x.name === "failure" || x.name === "error");
		if (!f) return;
		const name = c.attrs.name ?? "?";
		out.push({
			file, describes, name, fullName: [file, ...describes, name].join(" > "),
			message: firstLine(f.attrs.message) ?? firstLine(f.text), type: f.attrs.type ?? null,
		});
	});
	const fail = failures + errors;
	const pass = tests - fail - skipped;
	if (pass < 0) return { ok: false, error: `junit counts do not add up: ${tests} tests, ${fail} failing, ${skipped} skipped` };
	if (cases !== tests) return { ok: false, error: `junit lists ${cases} test cases but counts ${tests}` };
	if (out.length !== fail) return { ok: false, error: `junit lists ${out.length} failing cases but counts ${fail}` };
	return { ok: true, tests, pass, fail, skip: skipped, failures: out };
}

/** Strict per-case evidence for finite timing proofs; shares the normal runner's XML reader. */
export function junitCases(xml: string): { file: string; name: string; status: "pass" | "fail" | "skip"; ms: number }[] {
	const report = parseJunit(xml);
	if (!report.ok) throw new Error(report.error);
	const out: { file: string; name: string; status: "pass" | "fail" | "skip"; ms: number }[] = [];
	eachCase(parseXml(xml), (c, file, describes) => {
		const skipped = c.children.some((n) => n.name === "skipped");
		const seconds = c.attrs.time ?? (skipped ? "0" : undefined);
		if (seconds === undefined || !/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(seconds) || !Number.isFinite(Number(seconds))) {
			throw new Error(`junit case ${file} > ${c.attrs.name ?? "?"} has no finite duration`);
		}
		if (!c.attrs.name) throw new Error(`junit case in ${file} has no name`);
		out.push({
			file: repoRel(file), name: [...describes, c.attrs.name].join(" > "),
			status: skipped ? "skip" : c.children.some((n) => n.name === "failure" || n.name === "error") ? "fail" : "pass",
			ms: Number(seconds) * 1000,
		});
	});
	if (out.filter((c) => c.status === "skip").length !== report.skip) throw new Error("junit skipped case count disagrees with report");
	return out;
}

/**
 * The files a junit report ran at least one test of (PLAN wl-mvq4edh02r5z40 D1, the required coverage): each file, repo-relative
 * with any `./` dropped, one of whose `<testcase>` elements has no `<skipped>` child (Bun 1.3.14 writes `<skipped />` for a skip
 * and `<skipped message="TODO" />` for a todo), in report order without repeats. Read with parseJunit's walk; a report that does
 * not parse ran nothing.
 */
export function executedFiles(xml: string): string[] {
	let root: XmlNode;
	try {
		root = parseXml(xml);
	} catch {
		return [];
	}
	if (root.name !== "testsuites") return [];
	const out = new Set<string>();
	eachCase(root, (c, file) => {
		if (!c.children.some((x) => x.name === "skipped")) out.add(repoRel(file));
	});
	return [...out];
}

/**
 * A run's executed counts (PLAN wl-mvq4edbaf13vnk D1) from its junit report and the Bun test files of the tested commit's tree:
 * `perFile`, each tree test file's executed (not skipped) tests, files with none left out; `exec.files`, how many tree test
 * files are in `perFile`; `exec.tests`, every executed test of the report; `exec.treeFiles`, the tree's test files. A report
 * that does not parse is an error, never zero counts.
 */
export function execOf(xml: string, treeTestFiles: readonly string[]): { ok: true; exec: ExecCounts; perFile: Map<string, number> } | { ok: false; error: string } {
	let root: XmlNode;
	try {
		root = parseXml(xml);
	} catch (e) {
		return { ok: false, error: `junit report does not parse: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (root.name !== "testsuites") return { ok: false, error: `junit root is <${root.name}>, not <testsuites>` };
	const tree = new Set(treeTestFiles.map(repoRel));
	const perFile = new Map<string, number>();
	let tests = 0;
	eachCase(root, (c, file) => {
		if (c.children.some((x) => x.name === "skipped")) return;
		tests++;
		const rel = repoRel(file);
		if (tree.has(rel)) perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
	});
	return { ok: true, exec: { files: perFile.size, tests, treeFiles: tree.size }, perFile };
}

/**
 * The tree test files a main run's believability counts (§ 2 Main state): the Bun test files of `treeFiles` minus
 * `testRunner.mainSkip`. Those files skip every test under `_as2test`, so counting them would hold every main run under 95 %.
 */
export function countedTestFiles(treeFiles: readonly string[], mainSkip: Readonly<Record<string, string>>): string[] {
	return treeFiles.filter((f) => isBunTestFile(f) && !Object.hasOwn(mainSkip, repoRel(f)));
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * The first error line of each failing test in a Bun console log (stdout and stderr of `bun test`,
 * measured on 1.3.14): a `<file>:` header opens each file, `(fail) <describe > name> [<time>]`
 * closes a failing test's block, and the error is the first non-empty line after the source
 * excerpt's caret. A timeout prints `^ this test timed out …` on the line after the `(fail)` line.
 * Keyed by `file > describe > name`, a queue per key in log order; null where no line was found.
 */
export function logFirstErrors(log: string, files: readonly string[]): Map<string, (string | null)[]> {
	const known = new Set(files);
	const out = new Map<string, (string | null)[]>();
	const lines = log.replace(ANSI, "").split(/\r?\n/);
	let file: string | null = null;
	let block: string[] = [];
	for (let k = 0; k < lines.length; k++) {
		const line = lines[k]!;
		const header = /^(\S.*):$/.exec(line);
		if (header && known.has(header[1]!)) {
			file = header[1]!;
			block = [];
			continue;
		}
		const marker = /^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
		if (!marker) {
			block.push(line);
			continue;
		}
		if (marker[1] === "fail" && file !== null) {
			let err = errorLineOf(block);
			if (err === null) err = /^\s*\^ (\S.*)$/.exec(lines[k + 1] ?? "")?.[1]?.trim() ?? null;
			const key = `${file} > ${marker[2]}`;
			out.set(key, [...(out.get(key) ?? []), err]);
		}
		block = [];
	}
	return out;
}
function errorLineOf(block: readonly string[]): string | null {
	for (let j = 1; j < block.length; j++) {
		if (!/^\s*\^\s*$/.test(block[j]!) || !/^\s*\d+ \| /.test(block[j - 1]!)) continue;
		for (let k = j + 1; k < block.length; k++) if (block[k]!.trim() !== "") return block[k]!.trim();
		return null;
	}
	return null;
}

/** What a part produced, as the runner imported it (§ 2.2 step 4). */
export interface PartInput {
	/** The imported junit copy, or null when it was missing. */
	junit: string | null;
	/** The imported console log, or null when it was missing. */
	log: string | null;
	exit: number | null;
	ms: number;
	/** The cap fired: the wrapper exited 124, or the runner's outlive sweep fired on the call (`callTimedOut`). */
	timedOut?: boolean;
	/** The import refused a file (a symlink, not a regular file, unreadable, over the cap); a refused junit is also null here. */
	importError?: string | null;
	/** The report cap in bytes (reportCapBytes). */
	maxBytes?: number;
}
export interface PartResult extends PartCounts {
	failures: { name: string; firstError: string }[];
}

/**
 * One part's result (§ 2.3 step 6). A timeout, a refused import, a missing or unparsable junit, or a non-zero exit with no failing
 * test makes the part `error`. A timeout comes first (PLAN wl-mvq4edh02r5z40 D0): its error is `timeout`, or `timeout; <the import
 * refusal or the report's error>`. A junit that was imported and parses keeps its counts and failing tests whatever else went wrong
 * (the log refused, a timeout); each failing test keeps its name and the first error line (the report's own message, else the
 * log's line, else the failure type).
 */
export function partResult(p: PartInput): PartResult {
	const base = { exit: p.exit, ms: Math.max(0, Math.round(p.ms)) };
	const errors = [...(p.timedOut ? ["timeout"] : []), ...(p.importError ? [`report import refused: ${p.importError}`] : [])];
	const errored = (error: string, counts = { pass: 0, fail: 0, skip: 0 }, failures: PartResult["failures"] = []): PartResult => ({ ...counts, ...base, error, failures });
	if (p.junit === null) return errored(errors.length > 0 ? errors.join("; ") : "junit report missing");
	const report = parseJunit(p.junit, { maxBytes: p.maxBytes });
	if (!report.ok) return errored([...errors, report.error].join("; "));
	const fromLog = p.log === null ? new Map<string, (string | null)[]>() : logFirstErrors(p.log, [...new Set(report.failures.map((f) => f.file))]);
	const failures = report.failures.map((f) => {
		const queue = fromLog.get(f.fullName);
		const logged = queue && queue.length > 0 ? queue.shift()! : null;
		return { name: f.fullName, firstError: f.message ?? logged ?? `${f.type ?? "failure"} (no message in the report or the log)` };
	});
	const counts = { pass: report.pass, fail: report.fail, skip: report.skip };
	if (errors.length > 0) return errored(errors.join("; "), counts, failures);
	if (p.exit === null) return errored("killed before it exited", counts, failures);
	if (p.exit !== 0 && report.fail === 0) return errored(`exit ${p.exit} with no failing test`, counts, failures);
	return { ...counts, ...base, error: null, failures };
}

/** A wrapper call timed out (PLAN wl-mvq4edh02r5z40 D0): it exited 124, or the runner's outlive sweep fired on it, whatever its later exit. */
export function callTimedOut(r: { code: number | null; outlived: boolean }): boolean {
	return r.code === WRAPPER_EXIT.timeout || r.outlived;
}

// ---- the stuck-worker detector's facts (PLAN wl-mvq8x4pkjmx69s D4) ---------------------------------------

/** One detector line of a part's stdout (the executor's `stuck-signature`, `stuck-cleared` and `stuck-stop`), keyed by worker and zombie. */
const STUCK_LINE_RE = /^(stuck-signature|stuck-cleared|stuck-stop) (\S+) part \S+ worker (\d+) zombie (\d+)(?: |$)/;
const STUCK_STOP_RE = /^stuck-stop \S+ part \S+ worker (\d+) zombie (\d+)(?: |$)/m;

/**
 * The stuck fact of a wrapper call (PLAN wl-mvq8x4pkjmx69s D4): it exited WRAPPER_EXIT.stuck, or its stdout has a `stuck-stop`
 * line, however the call ended (a signal, another exit, the backstop's abandonment, an early refusal), as `callTimedOut`.
 */
export function callStuck(r: { code: number | null; out: string }): boolean {
	return r.code === WRAPPER_EXIT.stuck || STUCK_STOP_RE.test(r.out);
}

/**
 * A stuck part's error, always starting `stuck:`: the executor's own `stuck: …` stderr line when it wrote one, else one built from
 * its stop line. A call the runner's backstop abandoned after the stop line adds `executor did not finish the stop`.
 */
export function stuckReason(r: { code: number | null; out: string; err: string; abandoned: boolean }): string {
	const own = [...r.err.matchAll(/^stuck: .+$/gm)].at(-1)?.[0] ?? null;
	const stop = STUCK_STOP_RE.exec(r.out);
	const base = own ?? (stop ? `stuck: worker ${stop[1]} spun in Bun.spawnSync with unreaped child ${stop[2]}` : `stuck: the executor exited ${r.code} with no stop line`);
	return r.abandoned ? `${base}; executor did not finish the stop` : base;
}

/** The executor-stalled reason (D4): the backstop fired on a signature with no `stuck-stop` line, so the worker was a candidate only. */
export function executorStalledReason(worker: number): string {
	return `executor stalled during stuck detection; worker ${worker} was a candidate, not confirmed`;
}

/** An open enforce signature: its worker, zombie and the time the backstop abandons the call over it. */
export interface BackstopSignature {
	worker: number;
	zombie: number;
	deadline: number;
}

/**
 * The runner's backstop over one enforce part's stdout (D4). Each `stuck-signature` line, keyed by worker and zombie, opens a
 * deadline at the line's own time plus `backstopMs`; a `stuck-cleared` line closes only its own key's deadline, and only while no
 * `stuck-stop` line has been seen; from the first `stuck-stop` line on the deadline is terminal (never disarmed or extended), and a
 * stop line whose key is not open opens it at its own time. The call's deadline is the earliest open one. A line whose time does
 * not parse counts from when it was read. Pure: the caller reads the file and the clock.
 */
export class StuckWatch {
	private consumed = 0;
	private readonly open = new Map<string, BackstopSignature>();
	/** A `stuck-stop` line was read: the part is stuck, and the deadline is terminal. */
	stopSeen = false;

	constructor(readonly backstopMs: number) {}

	/** Read `text`, the whole stdout so far: each complete line not read before, in order. */
	feed(text: string, nowMs: number): void {
		const end = text.lastIndexOf("\n") + 1;
		if (end <= this.consumed) return;
		for (const line of text.slice(this.consumed, end).split("\n")) {
			const m = STUCK_LINE_RE.exec(line);
			if (!m) continue;
			const [, kind, iso, worker, zombie] = m as unknown as [string, string, string, string, string];
			const key = `${worker} ${zombie}`;
			if (kind === "stuck-cleared") {
				if (!this.stopSeen) this.open.delete(key);
				continue;
			}
			if (kind === "stuck-stop") this.stopSeen = true;
			const at = Date.parse(iso);
			if (!this.open.has(key)) this.open.set(key, { worker: Number(worker), zombie: Number(zombie), deadline: (Number.isNaN(at) ? nowMs : at) + this.backstopMs });
		}
		this.consumed = end;
	}

	/** The open signature with the earliest deadline, or null when none is open (the backstop is disarmed). */
	first(): BackstopSignature | null {
		let best: BackstopSignature | null = null;
		for (const s of this.open.values()) if (best === null || s.deadline < best.deadline) best = s;
		return best;
	}
}

// ---- verdict and settle ----------------------------------------------------------------------------

export interface RunFacts {
	/** The sha the request carries (read from GitHub at request time). */
	requestedSha: string;
	/** `refs/pull/<N>/head` as fetched into the clone; null when the run never got that far. */
	fetchedSha: string | null;
	/** A run-level failure: clone, lock, queue, preflight, sweep; null when none. */
	error: string | null;
	full: PartResult | null;
	/**
	 * The full part's wrapper call timed out (PLAN wl-mvq4edh02r5z40 D0, `callTimedOut`): it exited 124 or the outlive sweep
	 * fired on it, whatever its later exit, its early return or its report import. Read by soloPlan and decideRun, never an error string.
	 */
	fullTimedOut: boolean;
	solo: (PartResult & { file: string })[];
	/** The sha checked out and tested. */
	headAtStart: string;
	/** `refs/pull/<N>/head` re-read after the last part; null when the re-read failed. */
	headAtEnd: string | null;
	/** ownsRequest at the write, and the lock row still holds this run. */
	owner: boolean;
	/** The slice's state read in the write transaction; null when it is gone. */
	sliceState: SliceState | null;
	/**
	 * Base's solo runs of the failing files (D8, PLAN wl-mvq4edh02r5z40 D3), keyed by the solo `./<path>`, at `sha` (origin/main as
	 * the trusted phase fetched it); null when no file was rerun on base (`baseParts` named none, or the run stopped first).
	 */
	baseRuns: { sha: string; parts: Readonly<Record<string, PartResult>> } | null;
	/**
	 * A part of this run was stuck (PLAN wl-mvq8x4pkjmx69s D4, `callStuck`): `<part>: <its stuck: reason>`, with `; containment
	 * failed: …` when the runner could not confirm its processes gone; null when no part was. It ends the run.
	 */
	stuck: string | null;
	/**
	 * The runner's backstop abandoned a part's call on a signature with no stop line (D4): `<part>: executor stalled during stuck
	 * detection; worker <pid> was a candidate, not confirmed`, an infrastructure error of the executor, never a stuck verdict; null
	 * when it did not happen. It ends the run.
	 */
	executorStalled: string | null;
}
export interface RunDecision {
	/** What the entry records: `superseded` for a run that lost ownership. */
	verdict: TestVerdict;
	/** What the run found, ownership aside. */
	outcome: Exclude<TestVerdict, "superseded">;
	reason: string | null;
	/** Complete the slice: an owned green or red-main on a slice still open. */
	settle: boolean;
}

/** The files of the full part's failing tests (the file part of each name), in report order without repeats. */
function fullFailingFiles(full: PartResult): string[] {
	return [...new Set(full.failures.map((x) => fileOfName(x.name)))];
}

/** A failing file's solo argument `./<path>`, or null when it cannot run alone: `?`, not a Bun test file name, or not a plain relative path. */
function soloArgOf(file: string): string | null {
	const rel = repoRel(file);
	if (rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..") || !isBunTestFile(rel)) return null;
	return `./${rel}`;
}

/** What follows the full part (PLAN wl-mvq4edh02r5z40 D1): nothing (`stop`), or these files alone, each as its `./<path>` argument, in order. */
export type SoloPlan = { stop: true } | { stop: false; files: string[] };

/**
 * The solo policy (PLAN wl-mvq4edh02r5z40 D1), from the full part, whether its call timed out (`RunFacts.fullTimedOut`), whether it
 * was stuck or its executor stalled (`halted`, PLAN wl-mvq8x4pkjmx69s D4), the changed test files (`./<path>`, changedTestFiles)
 * and the files its junit ran a test of (executedFiles):
 * - a timed-out, stuck or stalled full part stops the run: no solo and no base part;
 * - an all-pass full part (no error, exit 0, no failing test) runs alone only the changed files it ran no test of;
 * - a full part that reported failing tests cleanly (no error) runs alone each failing file that can run alone and is not a
 *   security path, in report order (a rerun is diagnostic only and never touches a security failure);
 * - any other full part (an error that is not a timeout) runs every changed file alone, but never a security-path file that
 *   failed in the full part.
 */
export function soloPlan(p: { full: PartResult; timedOut: boolean; halted?: boolean; changed: readonly string[]; executed: readonly string[] }): SoloPlan {
	if (p.timedOut || p.halted) return { stop: true };
	const { full } = p;
	if (full.error === null && full.exit === 0 && full.fail === 0) {
		const ran = new Set(p.executed.map(repoRel));
		return { stop: false, files: p.changed.filter((c) => !ran.has(repoRel(c))) };
	}
	if (full.error === null && full.fail > 0) {
		const files = fullFailingFiles(full).filter((f) => !isSecurityPath(f)).map(soloArgOf);
		return { stop: false, files: files.filter((a): a is string => a !== null) };
	}
	const failingSecurity = fullFailingFiles(full).filter(isSecurityPath).map(repoRel);
	return { stop: false, files: p.changed.filter((c) => !failingSecurity.includes(repoRel(c))) };
}

/** Every PR part reported cleanly (D3's guard): the full part ran, and every part has no error and exited 0 unless a test failed in it. */
function cleanParts(f: Pick<RunFacts, "full" | "solo">): boolean {
	if (f.full === null) return false;
	return [f.full, ...f.solo].every((p) => p.error === null && (p.fail > 0 || p.exit === 0));
}

/**
 * The files the runner reruns on base (D8, PLAN wl-mvq4edh02r5z40 D3), each its solo `./<path>`, in part order: every failing solo
 * part that is not a security path, when every PR part reported cleanly (`cleanParts`); else none, since such a run is `red` or
 * `error` whatever base says. The full part is never rerun on base.
 */
export function baseParts(f: Pick<RunFacts, "full" | "solo">): string[] {
	if (!cleanParts(f)) return [];
	return f.solo.filter((s) => s.fail > 0 && !isSecurityPath(s.file)).map((s) => s.file);
}

/**
 * Each failing solo part that is not a security path beside base's solo run of the same file (D8), or null when the run has no base
 * runs. A file base never ran counts as base's error.
 */
export function baseCompareFor(f: Pick<RunFacts, "full" | "solo" | "baseRuns">): BaseCompare | null {
	if (f.baseRuns === null) return null;
	const runs = f.baseRuns.parts;
	const parts = f.solo.filter((s) => s.fail > 0 && !isSecurityPath(s.file)).map((s): BasePart => {
		const base = Object.hasOwn(runs, s.file) ? runs[s.file]! : null;
		const baseError = base === null ? "not run on base" : base.error;
		return { part: s.file, failing: s.failures.map((x) => x.name), baseFailing: baseError === null ? base!.failures.map((x) => x.name) : null, baseError };
	});
	return { sha: f.baseRuns.sha, parts };
}

/**
 * Every name of `failing` is in `against` as often (a multiset cover): a failure identity (`file > describe > name`, not unique when
 * two cases share a name) that fails more often in `failing` is one `against` lacks.
 */
function multisetCovered(failing: readonly string[], against: readonly string[]): boolean {
	const left = new Map<string, number>();
	for (const n of against) left.set(n, (left.get(n) ?? 0) + 1);
	for (const n of failing) {
		const k = left.get(n) ?? 0;
		if (k === 0) return false;
		left.set(n, k - 1);
	}
	return true;
}

/** Main red (D8): every failing test of every compared file also fails in base's run of that file (`multisetCovered`); a base error is never main red. */
export function mainRed(c: BaseCompare): boolean {
	return c.parts.length > 0 && c.parts.every((p) => p.baseFailing !== null && multisetCovered(p.failing, p.baseFailing));
}

/**
 * The verdict (§ 2.3 step 6, § 2.4) and whether to settle (§ 2.2 step 5, § 2.3 step 7), in this order:
 * a fetched head that is not the requested sha is `stale` before any test; a run-level failure is
 * `error`; a stuck part or a stalled executor (PLAN wl-mvq8x4pkjmx69s D4: `stuck`, `executorStalled`) is `error` with its reason,
 * which leads a run-level failure's reason when both hold, and gives way only to a head that moved by the end; a head that moved
 * by the end is `stale` whatever the counts; a timed-out full part (`fullTimedOut`) is `error`
 * naming the timeout, whatever failures its partial junit kept (PLAN wl-mvq4edh02r5z40 D2); any failing test in any part is
 * `red`, or `red-main` (D3) when every PR part reported cleanly, no failure is in a security test, each full-part failure of a
 * file fails again in that file's solo part (a multiset cover) and base's solo runs fail every failure of every failing solo
 * part too (`mainRed`); a part that errored is `error`; otherwise `green`. A failing file that passed alone never moves the
 * verdict: a `red` names it in its reason (`failing in the full part; passed alone: <files>`). A run that does not own its
 * request records `superseded` and settles nothing. A stuck run's failures stay in its record; it is never green or red-main.
 */
export function decideRun(f: RunFacts): RunDecision {
	const outcome = ((): { outcome: RunDecision["outcome"]; reason: string | null } => {
		if (f.fetchedSha !== null && f.fetchedSha !== f.requestedSha) {
			return { outcome: "stale", reason: `requested ${sha7(f.requestedSha)} but the PR head was ${sha7(f.fetchedSha)}; nothing was tested` };
		}
		const halted = f.stuck ?? f.executorStalled;
		if (f.error !== null) return { outcome: "error", reason: halted === null ? f.error : `${halted}; ${f.error}` };
		if (halted !== null) {
			if (f.headAtEnd !== null && (f.headAtStart !== f.requestedSha || f.headAtEnd !== f.headAtStart)) {
				return { outcome: "stale", reason: `the PR head moved to ${sha7(f.headAtEnd)} during the run of ${sha7(f.requestedSha)}` };
			}
			return { outcome: "error", reason: halted };
		}
		if (f.fetchedSha === null) return { outcome: "error", reason: "the PR head was never fetched" };
		if (f.full === null) return { outcome: "error", reason: "the full suite did not run" };
		if (f.headAtEnd === null) return { outcome: "error", reason: "the PR head could not be re-read at the end" };
		if (f.headAtStart !== f.requestedSha || f.headAtEnd !== f.headAtStart) {
			return { outcome: "stale", reason: `the PR head moved to ${sha7(f.headAtEnd)} during the run of ${sha7(f.requestedSha)}` };
		}
		const full = f.full;
		if (f.fullTimedOut) {
			const e = full.error;
			return { outcome: "error", reason: `full: ${e !== null && e.startsWith("timeout") ? e : ["timeout", ...(e === null ? [] : [e])].join("; ")}` };
		}
		const soloOf = (file: string) => f.solo.find((s) => repoRel(s.file) === repoRel(file));
		if ([full, ...f.solo].some((p) => p.fail > 0)) {
			const compare = baseParts(f).length > 0 ? baseCompareFor(f) : null;
			const reproduced = fullFailingFiles(full).every((file) => {
				const alone = soloOf(file);
				return alone !== undefined && multisetCovered(full.failures.filter((x) => fileOfName(x.name) === file).map((x) => x.name), alone.failures.map((x) => x.name));
			});
			if (compare !== null && mainRed(compare) && reproduced && !failuresOf(full, f.solo).some(isSecurityFailure)) {
				return { outcome: "red-main", reason: `every failing test also fails on base ${sha7(compare.sha)}` };
			}
			const passed = fullFailingFiles(full).map(soloOf).filter((s) => s !== undefined && s.error === null && s.exit === 0 && s.fail === 0);
			return { outcome: "red", reason: passed.length > 0 ? `failing in the full part; passed alone: ${passed.map((s) => s!.file).join(", ")}` : null };
		}
		const broken = [{ p: full, label: "full" }, ...f.solo.map((s) => ({ p: s, label: s.file }))].find(({ p }) => p.error !== null || p.exit !== 0);
		if (broken) return { outcome: "error", reason: `${broken.label}: ${broken.p.error ?? `exit ${broken.p.exit}`}` };
		return { outcome: "green", reason: null };
	})();
	if (!f.owner) {
		return { verdict: "superseded", outcome: outcome.outcome, reason: `lost ownership of the request; the run found ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ""}`, settle: false };
	}
	return { verdict: outcome.outcome, outcome: outcome.outcome, reason: outcome.reason, settle: SETTLING_VERDICTS.includes(outcome.outcome) && f.sliceState === "open" };
}

/** Every failing test across the parts, untruncated, in part order. */
export function failuresOf(full: PartResult | null, solo: readonly (PartResult & { file: string })[]): Failure[] {
	const out: Failure[] = [];
	for (const f of full?.failures ?? []) out.push({ part: "full", ...f });
	for (const s of solo) for (const f of s.failures) out.push({ part: s.file, ...f });
	return out;
}

/** The `test-run:` record of a finished run, from its request, its facts and the decision on them. */
export function buildTestRun(
	request: TestRequested, facts: RunFacts, decision: RunDecision,
	extra: { base: string | null; mergeBase: string | null; runDir: string | null; preflight: string | null },
): TestRun {
	const baseCompare = baseCompareFor(facts);
	return {
		runId: request.runId, verdict: decision.verdict, sha: request.sha, pr: request.pr, reason: decision.reason, headAtEnd: facts.headAtEnd,
		base: extra.base, mergeBase: extra.mergeBase,
		full: facts.full ? { pass: facts.full.pass, fail: facts.full.fail, skip: facts.full.skip, exit: facts.full.exit, ms: facts.full.ms, error: facts.full.error } : null,
		solo: facts.solo.map((s) => ({ file: s.file, pass: s.pass, fail: s.fail, skip: s.skip, exit: s.exit, ms: s.ms, error: s.error })),
		failures: failuresOf(facts.full, facts.solo), runDir: extra.runDir, preflight: extra.preflight,
		...(baseCompare === null ? {} : { baseCompare }), ...OLD_ROW_FIELDS,
	};
}

/** The orchestrator hears a finished run that is neither green, red-main nor superseded when no lane holds the workload under a live lease (§ 2.3 step 8). */
export function notifiesOrchestrator(verdict: TestVerdict, heldLive: boolean): boolean {
	return !SETTLING_VERDICTS.includes(verdict) && verdict !== "superseded" && !heldLive;
}

/**
 * The artifact a settled slice carries (§ 2.3 step 7); a red-main names base's sha and every compared part (D8); a green's reason, which
 * only a carried green has (`carriedRun`), is appended, so the slice keeps where its green came from.
 */
export function settleArtifact(run: TestRun): string {
	need(SETTLING_VERDICTS.includes(run.verdict) && run.full !== null, `test-run ${run.runId} is not a green or red-main with a full part`);
	const alone = run.solo.length === 0 ? "none" : run.solo.map((s) => `${s.file} ${s.pass}/${s.fail}`).join(", ");
	const main = run.verdict === "red-main" && run.baseCompare
		? `; every failure also fails on base ${run.baseCompare.sha} (${run.baseCompare.parts.map((p) => `${p.part} ${p.failing.length}`).join(", ")})`
		: "";
	const why = run.verdict === "green" && run.reason !== null ? `; ${run.reason}` : "";
	return `test-run ${run.runId}: ${run.verdict} at ${run.sha} on PR #${run.pr}; full ${run.full!.pass}/${run.full!.fail}/${run.full!.skip}; alone: ${alone}${main}; ${run.runDir ?? "no run dir"}${why}`;
}

/**
 * A merge train's carried green (PLAN wl-mvpwkpqobyp20w D4c): `request`, at a head H that descends from `from`'s sha S only by
 * decision-log commits (or is S), is green with no run, reason `carried from <R> at <S> (decision-log only)`, and `from`'s counts and
 * run dir, the reports the verdict rests on. Nothing re-read the head, so headAtEnd is null.
 */
export function carriedRun(request: TestRequested, from: TestRun): TestRun {
	need(from.verdict === "green" && from.pr === request.pr, `test-run ${from.runId} is no green on PR #${request.pr} to carry`);
	return {
		runId: request.runId, verdict: "green", sha: request.sha, pr: request.pr, reason: `carried from ${from.runId} at ${from.sha} (decision-log only)`, headAtEnd: null,
		base: from.base, mergeBase: from.mergeBase, full: from.full, solo: from.solo, failures: [], runDir: from.runDir, preflight: null,
		// What was carried is what ran: a carried fast green stays fast, never a full-suite result.
		scope: from.scope, main: false, host: from.host, exec: null,
	};
}

// ---- retention -------------------------------------------------------------------------------------

/** The runs to prune (§ 2.3 step 9): all but the newest `keep`, oldest first; order by start time, then id. */
export function pruneRuns(runs: readonly { id: string; at: number }[], keep: number = KEEP_RUNS): string[] {
	const sorted = [...runs].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return sorted.slice(0, Math.max(0, sorted.length - Math.max(0, keep))).map((r) => r.id);
}

// ---- close freshness (§ 2.4 item 4) ----------------------------------------------------------------

/** One commit of the range S..head: its sha, its parent count, and the files it changes against its one parent (none read for a merge). */
export interface RangeCommit {
	sha: string;
	parents: number;
	files: readonly string[];
}

/** A compare from a tested sha S to a later head, through git's ancestry: its status and, when `ahead`, every commit of S..head with its own files. */
export interface CompareResult {
	status: "identical" | "ahead" | "behind" | "diverged";
	/** Every commit reachable from the head and not from S, when `ahead`; empty otherwise. */
	commits: readonly RangeCommit[];
}

/**
 * Why the head does not keep S's green (§ 2.4 item 4: it descends from S through commits that each
 * touch only `.ai/decision-log/`), or null when it does. A net diff is never read: a code commit and
 * its revert are two commits that touch code. A merge in the range is not linear descent. An empty
 * commit (one parent, no file changed) touches nothing outside the decision log and is allowed. A
 * missing compare covers nothing.
 */
export function decisionLogFault(c: CompareResult | null): string | null {
	if (c === null) return "it was not compared";
	if (c.status === "identical") return null;
	if (c.status !== "ahead") return c.status === "behind" ? "it is behind the green" : "it has diverged from the green";
	if (c.commits.length === 0) return "no commit lies between them";
	for (const k of c.commits) {
		if (k.parents !== 1) return `commit ${sha7(k.sha)} is a merge`;
		const code = k.files.find((f) => !f.startsWith(DECISION_LOG_DIR));
		if (code !== undefined) return `commit ${sha7(k.sha)} changes ${code}`;
	}
	return null;
}

/** The head equals S or descends from it through decision-log-only commits (`decisionLogFault` is null). */
export const decisionLogOnly = (c: CompareResult | null): boolean => decisionLogFault(c) === null;

/** The authoritative run for a PR: its newest request, with that request's own result (null while it has none). */
export function authoritativeRun(records: readonly RunRecord[], pr: number): RunRecord | null {
	return records.filter((r) => r.request.pr === pr).at(-1) ?? null;
}

export interface ClosePr {
	number: number;
	state: "OPEN" | "MERGED" | "CLOSED";
	headRefName: string;
	/** The PR's head; a merged PR's final head. */
	headSha: string;
	/**
	 * The authoritative result (authoritativeRun(...).result), or null. `scope` is what ran (PLAN wl-mvq4edbaf13vnk D1): a `fast`
	 * green is the fast check before merge, never a full-suite result (`isFullSuiteGreen`); it passes close only on a merged PR
	 * whose `cover` is a green believable main run holding its merge commit (D9, R23).
	 */
	result: { runId: string; verdict: TestVerdict; sha: string; scope: TestScope } | null;
	/** Compare from result.sha to headSha; null when there is no result or the two are equal. */
	headCompare: CompareResult | null;
	/** For a PR from the workload's branch: compare from result.sha to the candidate; null otherwise. */
	candidateCompare: CompareResult | null;
	/**
	 * The authoritative run Jo waived (PLAN wl-mv5i3lulwwbbi8 D3; surface/src/close-entry.ts `waivedRunOf`): its run id when
	 * Jo's `waive`, written by the surface, answers a question offering `waive` on the run's slice, asked and answered after
	 * its non-green result while it was the newest request on that slice; else null. Only a merged PR at that run's sha passes on it.
	 */
	waivedRun: string | null;
	/**
	 * The question Jo answered `skip` on for this PR on a merge train (PLAN wl-mv8s8srodefytc § 1; surface/src/merge-train.ts
	 * `trainSkippedOf`): its id when the workload carries a valid `train:` entry and Jo's `skip`, written by the surface,
	 * answers a question on one of the train's slices of this PR; else null. Such a PR is treated like a closed one.
	 */
	trainSkipped: string | null;
	/**
	 * The PR is on a merge train (PLAN wl-mv8s8srodefytc rev 17.1 D8; surface/src/close-entry.ts `trainPrsOn`): a valid `train:`
	 * entry on a workload of this repository, open or closed, lists it. A `red-main` result passes close only on such a PR, merged, at its merged head.
	 */
	onTrain: boolean;
	/** A MERGED PR's merge commit (gh `mergeCommit.oid`, read in the same call as its head); null for any other state. */
	mergeCommit: string | null;
	/**
	 * For a MERGED PR its own results do not pass (`mergedNeedsCover`: no result, a green its merged head does not keep, a fast
	 * green, a red, error or stale run Jo did not waive at that head, or a red-main off a train or not at its merged head): the
	 * newest test-runner green, on any workload of this repository, whose sha S is on the freshly fetched `origin/<default>` and
	 * either is the merged head (or the head descends from S through decision-log-only commits, `how: "head"`) or contains the
	 * merge commit (`how: "merge"`) (PLAN wl-mvfjen3q5mqi2o D2; surface/src/close-entry.ts `gatherCloseFacts`); else null. S is a
	 * full-suite green: a PR's full-scope green, or a main run's green believable verdict (`main`, PLAN wl-mvq4edbaf13vnk D9); a
	 * fast green never covers, and a fast green is covered only by a main run. S is an integration snapshot of the main line that
	 * contains the merge, not a claim that it still runs every line the PR added.
	 */
	cover: { runId: string; sha: string; workloadId: string; how: "head" | "merge"; main: boolean } | null;
	/** Jo's `waive-pr` instruction naming this PR (PLAN wl-mvfjen3q5mqi2o D3; surface/src/launch.ts `waivedPrs`), or null. It passes only a MERGED PR nothing covers. */
	waivedByJo: string | null;
}
export interface CloseFacts {
	/** Why git or gh could not answer, or null. Any failure refuses (fails closed). */
	failure: string | null;
	/** `wl/<wl>`. */
	branch: string;
	/** Origin's default branch, short (`main`): the main line a covering green must be on. */
	defaultBranch: string;
	/** The local branch tip close will publish, pinned as C, and every file changed between merge-base(origin/main, C) and C. */
	candidate: { sha: string; changed: readonly string[] };
	/**
	 * The PR set: every PR from the branch in any state; every PR from a holder's `push-dest:` branch whose head contains a sha
	 * the workload pushed there (PLAN wl-mvfjen3q5mqi2o D1); and every PR a `test-requested:` names.
	 */
	prs: readonly ClosePr[];
}
export type CloseDecision = { close: true; why: string } | { close: false; reason: string };

/**
 * Whether a MERGED PR's own results fail the close check, so it needs D2's cover or D3's waiver (PLAN wl-mvfjen3q5mqi2o): no
 * result; a green its merged head does not keep; a fast green, which is never a full-suite result (PLAN wl-mvq4edbaf13vnk D9);
 * a red, error, stale or superseded run Jo's run-based `waive` does not pass at that head; or a red-main off a train or not at
 * its merged head. False for any other state and for a PR Jo skipped on a train. It mirrors `closeFreshness`'s rules for a
 * merged PR, which pass these PRs on `cover` or `waivedByJo` only after their own rules.
 */
export function mergedNeedsCover(pr: Pick<ClosePr, "state" | "result" | "headSha" | "headCompare" | "waivedRun" | "trainSkipped" | "onTrain">): boolean {
	if (pr.state !== "MERGED" || pr.trainSkipped) return false;
	const r = pr.result;
	if (r === null) return true;
	if (r.verdict === "green") return r.scope === "fast" || (pr.headSha !== r.sha && decisionLogFault(pr.headCompare) !== null);
	if (r.verdict === "red-main") return !pr.onTrain || pr.headSha !== r.sha;
	return pr.waivedRun !== r.runId || pr.headSha !== r.sha;
}

/**
 * The close check (§ 2.4 item 4). Every open or merged PR in the set needs an authoritative green at
 * S, with its head at S or descended from it through commits that each touch only the decision log;
 * its final head, and an open PR never passes on a waiver. A `red-main` result (D8) passes only a merged train PR
 * (`onTrain`) at exactly its merged head, and then counts as that PR's green. A PR Jo skipped on a merge train (`trainSkipped`)
 * is treated like a closed one and named in the why. A MERGED PR its own results do not pass (`mergedNeedsCover`: no result, a
 * green its merged head does not keep, a fast green, a red, error or stale run not waived at that head, a red-main off a train)
 * passes on a covering test-runner green on the main line (`cover`, PLAN wl-mvfjen3q5mqi2o D2), else on Jo's `waive-pr`
 * (`waivedByJo`, D3); with neither, a PR with no result or an unkept green is refused naming its merge commit and both ways
 * through (D4), and any other keeps its refusal with the same two ways appended. A fast green (PLAN wl-mvq4edbaf13vnk D9) is
 * never a full-suite result: an open PR with one is refused, and a merged one passes only on a cover that is a main run's green
 * believable verdict on its merge commit or a later main commit (then it counts as that PR's green), or on Jo's `waive-pr`.
 * An open PR never passes on either. A candidate with a code delta needs such a green on a PR from the branch that covers C the
 * same way (a waiver or any other cover covers nothing). The one exemption is an empty PR set with no code delta. Anything git
 * or gh could not answer refuses.
 */
export function closeFreshness(f: CloseFacts): CloseDecision {
	if (f.failure !== null) return { close: false, reason: `the close check could not answer: ${f.failure}` };
	const delta = f.candidate.changed.filter((p) => !p.startsWith(DECISION_LOG_DIR));
	if (f.prs.length === 0) {
		return delta.length === 0
			? { close: true, why: "no PR and no code delta" }
			: { close: false, reason: `${f.branch} changes ${delta[0]} but has no PR: push and open the PR, then lane_full_test` };
	}
	const waived: string[] = [];
	const skipped: string[] = [];
	const covers: string[] = [];
	const waivedByJo: string[] = [];
	const mainRedMerged = new Set<number>();
	// Merged PRs whose fast green a main run covers (D9): each counts as that PR's green for the candidate.
	const fastCovered = new Set<number>();
	// D2 then D3, for a MERGED PR its own results do not pass: true when it passes, and named in the why. A fast green takes only a main run's cover (D9).
	const passesMerged = (pr: ClosePr, mainOnly = false): boolean => {
		if (pr.state !== "MERGED") return false;
		const c = pr.cover;
		if (c !== null && (c.main || !mainOnly)) {
			const holds = c.how === "merge" ? `which contains merge commit ${pr.mergeCommit === null ? "unknown" : sha7(pr.mergeCommit)}` : "at its merged head";
			const run = c.main ? `main run ${c.runId} green and believable` : `test-run ${c.runId} green`;
			covers.push(`PR #${pr.number} merged; covered by ${run} at ${sha7(c.sha)} (${c.workloadId}), ${holds}`);
			if (mainOnly) fastCovered.add(pr.number);
			return true;
		}
		if (pr.waivedByJo !== null) {
			waivedByJo.push(`#${pr.number} (${pr.waivedByJo})`);
			return true;
		}
		return false;
	};
	// D4: the two ways through for a merged PR nothing covers, a covering green on <default> that contains its merge commit or Jo's waive-pr.
	const waysThrough = (pr: ClosePr): string => {
		const m = pr.mergeCommit === null ? "unknown" : sha7(pr.mergeCommit);
		const d = f.defaultBranch;
		return `once a green run's commit that contains ${m} is on ${d} (for example, the next green PR that merges ${d} in, once it has merged), or on Jo's \`waive-pr ${f.branch.replace(/^wl\//, "")} ${pr.number}\``;
	};
	const uncovered = (pr: ClosePr): CloseDecision => ({
		close: false,
		reason: `PR #${pr.number} merged at ${sha7(pr.headSha)} (merge commit ${pr.mergeCommit === null ? "unknown" : sha7(pr.mergeCommit)}) and no test-runner green on ${f.defaultBranch} holds it: it passes ${waysThrough(pr)}`,
	});
	// A merged PR's refusal from its own run, kept, with D4's two ways appended.
	const refusedMerged = (pr: ClosePr, reason: string): CloseDecision => ({ close: false, reason: `${reason}; it also passes ${waysThrough(pr)}` });
	for (const pr of f.prs) {
		if (pr.state === "CLOSED") continue;
		if (pr.trainSkipped) {
			skipped.push(`#${pr.number} (${pr.trainSkipped})`);
			continue;
		}
		const r = pr.result;
		if (r === null) {
			if (passesMerged(pr)) continue;
			if (pr.state === "MERGED") return uncovered(pr);
			return { close: false, reason: `PR #${pr.number} has no test-run result: call lane_full_test` };
		}
		if (r.verdict === "red-main") {
			const newest = `PR #${pr.number}'s newest test-run ${r.runId} is red-main`;
			const refused = pr.state !== "MERGED" || !pr.onTrain
				? `${newest}: it passes only a train PR the train merged at that head`
				: pr.headSha !== r.sha ? `${newest} at ${sha7(r.sha)}, not the merged head ${sha7(pr.headSha)}` : null;
			if (refused === null) {
				mainRedMerged.add(pr.number);
				continue;
			}
			if (pr.state !== "MERGED") return { close: false, reason: refused };
			if (passesMerged(pr)) continue;
			return refusedMerged(pr, refused);
		}
		if (r.verdict !== "green") {
			const newest = `PR #${pr.number}'s newest test-run ${r.runId} is ${r.verdict}`;
			if (pr.state === "OPEN") return { close: false, reason: `${newest}: fix it and call lane_full_test (a waiver passes only a merged PR)` };
			const refused = pr.waivedRun !== r.runId
				? `${newest}: a merged PR passes only on Jo's \`waive\` answering a question that offers waive on the run's slice, asked after the result`
				: pr.headSha !== r.sha ? `${newest} and waived, but at ${sha7(r.sha)}, not the merged head ${sha7(pr.headSha)}` : null;
			if (refused === null) {
				waived.push(`#${pr.number} (${r.runId})`);
				continue;
			}
			if (passesMerged(pr)) continue;
			return refusedMerged(pr, refused);
		}
		if (r.scope === "fast") {
			const m = pr.mergeCommit === null ? "unknown" : sha7(pr.mergeCommit);
			const fast = `test-run ${r.runId}, a fast green at ${sha7(r.sha)}`;
			if (pr.state === "OPEN") {
				return {
					close: false,
					reason: `PR #${pr.number}'s newest result is ${fast}: the fast check before merge is not a full-suite result, so it passes close only once the PR has merged and a green, believable main run on ${f.defaultBranch} holds its merge commit`,
				};
			}
			if (passesMerged(pr, true)) continue;
			return {
				close: false,
				reason: `PR #${pr.number} merged at ${sha7(pr.headSha)} (merge commit ${m}) with only ${fast}, and no green, believable main run on ${f.defaultBranch} holds it yet: it passes once the main run of ${m} or of a later ${f.defaultBranch} commit is green and believable, or on Jo's \`waive-pr ${f.branch.replace(/^wl\//, "")} ${pr.number}\``,
			};
		}
		const fault = pr.headSha === r.sha ? null : decisionLogFault(pr.headCompare);
		if (fault !== null) {
			if (passesMerged(pr)) continue;
			if (pr.state === "MERGED") return uncovered(pr);
			return { close: false, reason: `PR #${pr.number}'s head ${sha7(pr.headSha)} is not the green ${sha7(r.sha)}: ${fault}; call lane_full_test` };
		}
	}
	if (delta.length > 0) {
		const own = f.prs.filter((p) => p.headRefName === f.branch);
		if (own.length === 0) return { close: false, reason: `${f.branch} changes ${delta[0]} but has no PR: push and open the PR, then lane_full_test` };
		const covered = own.some(
			(p) =>
				p.state !== "CLOSED" && ((p.result?.verdict === "green" && p.result.scope !== "fast") || mainRedMerged.has(p.number) || fastCovered.has(p.number)) &&
				(f.candidate.sha === p.result!.sha || decisionLogOnly(p.candidateCompare)),
		);
		if (!covered) {
			if (own.every((p) => p.state === "CLOSED")) return { close: false, reason: `PR #${own.at(-1)!.number} is closed; reopen it, or reset the branch` };
			return { close: false, reason: `local ${f.branch} has untested commit ${sha7(f.candidate.sha)}` };
		}
	}
	const every = covers.length + waivedByJo.length === 0 ? "every PR" : "every other PR";
	const head = waived.length === 0 ? `${every} in the set is green at its head` : `${every} in the set is green at its head or merged with a waived run (${waived.join(", ")})`;
	const cover = covers.length === 0 ? "" : `; ${covers.join("; ")}`;
	const jo = waivedByJo.length === 0 ? "" : `; waived by Jo: ${waivedByJo.join(", ")}`;
	const mainRed = mainRedMerged.size === 0 ? "" : `; merged by the train on main red: ${[...mainRedMerged].map((n) => `#${n}`).join(", ")}`;
	const skip = skipped.length === 0 ? "" : `; skipped by Jo on the train: ${skipped.join(", ")}`;
	return { close: true, why: `${head}${delta.length > 0 ? ` and covers ${sha7(f.candidate.sha)}` : ""}${cover}${jo}${mainRed}${skip}` };
}

// ---- the untrusted child: env, git shim, gitconfig (§ 3) -------------------------------------------

/** The variables copied from the parent env; every other variable, credentials included, is dropped. */
export const CHILD_ENV_ALLOWLIST = ["PATH", "LANG", "USER", "LOGNAME", "SHELL", "TERM"] as const;
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface ChildLayout {
	home: string;
	tmp: string;
	xdgConfig: string;
	xdgCache: string;
	xdgData: string;
	bunCache: string;
	/** `AGENT_SYSTEM_LEDGER_DB` for the tests: a ledger under the throwaway home. */
	ledger: string;
	gitconfig: string;
	/** The directory holding the `git` shim, first on PATH. */
	shimDir: string;
}

/** Where the child's files go under `<work dir>`; the wrapper creates these directories. */
export function childLayout(workDir: string): ChildLayout {
	need(workDir.startsWith("/") && !workDir.includes(":") && !/[\n\0]/.test(workDir), `${workDir} is not an absolute path PATH can carry`);
	const home = join(workDir, "home");
	return {
		home, tmp: join(home, "tmp"), xdgConfig: join(home, ".config"), xdgCache: join(home, ".cache"), xdgData: join(home, ".local", "share"),
		bunCache: join(home, ".bun", "install", "cache"), ledger: join(home, ".agent-system-2", "ledger.db"), gitconfig: join(home, ".gitconfig"),
		shimDir: join(workDir, "shim"),
	};
}

/**
 * The untrusted child's environment (§ 3): empty, plus the allowlist from `parent`, plus the
 * throwaway home and the git settings. PATH puts the shim first. No credential variable survives:
 * GH_TOKEN, ANTHROPIC_API_KEY, OPENAI_*, MOONSHOT_*, SSH_AUTH_SOCK, OMP_*, AGENT_SYSTEM_* other than
 * the ledger path set here, and AGENT_SYSTEM_TEST_RUNS among them.
 */
export function childEnv(parent: Record<string, string | undefined>, workDir: string): Record<string, string> {
	const l = childLayout(workDir);
	const env: Record<string, string> = {};
	for (const k of CHILD_ENV_ALLOWLIST) {
		const v = parent[k];
		if (v !== undefined) env[k] = v;
	}
	env.PATH = `${l.shimDir}:${parent.PATH?.trim() ? parent.PATH : FALLBACK_PATH}`;
	Object.assign(env, {
		HOME: l.home, TMPDIR: l.tmp, XDG_CONFIG_HOME: l.xdgConfig, XDG_CACHE_HOME: l.xdgCache, XDG_DATA_HOME: l.xdgData, BUN_INSTALL_CACHE_DIR: l.bunCache,
		AGENT_SYSTEM_LEDGER_DB: l.ledger, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: l.gitconfig, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false",
	});
	return env;
}

/**
 * The `git` shim (§ 3, "descendants that rebuild their env"): a sh script first on PATH that
 * re-asserts the no-system-config, no-prompt, no-askpass settings and empties the credential
 * helper list, then execs the real git. A descendant that rebuilds its env as `{HOME, PATH}` keeps
 * PATH, so its `git` still resolves here; its own HOME, and so its own global config, is left alone.
 */
export function gitShimText(realGit: string): string {
	need(realGit.startsWith("/") && !/[\n\0]/.test(realGit), `${realGit} is not an absolute path`);
	return [
		"#!/bin/sh",
		"# agent-system 2.0 test runner: git for code under test (MIGRATION.md item 24). No system config,",
		"# no credential helper, no prompt, no askpass; everything else is the caller's.",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=/usr/bin/false",
		"export GIT_CONFIG_NOSYSTEM GIT_TERMINAL_PROMPT GIT_ASKPASS",
		`exec '${realGit.replace(/'/g, `'\\''`)}' -c credential.helper= "$@"`,
		"",
	].join("\n");
}

/** The throwaway global gitconfig: user.name and user.email only (§ 3). */
export function childGitconfigText(): string {
	return "[user]\n\tname = as2 test runner\n\temail = as2-test-runner@localhost\n";
}

// ---- the `_as2test` wrapper's argv contract (§ 2.3 step 3, § 3.1) ----------------------------------

export const AS2TEST_USER = "_as2test";
export const AS2TEST_ROOT = "/Users/Shared/as2test";
/** The root-owned wrapper, the one command the sudoers line allows. */
export const AS2TEST_EXEC = "/usr/local/libexec/as2test/exec";
/**
 * The wrapper's exit codes. For `full` and `solo` any other code is bun's own exit, passed through.
 * `probeReachable` is `probe`'s answer when a path it was given opens. `stuck` is a part the detector stopped in enforce mode
 * (PLAN wl-mvq8x4pkjmx69s D3, D4).
 */
export const WRAPPER_EXIT = { ok: 0, probeReachable: 65, failed: 70, sweepLockHeld: 75, refused: 64, fenced: 77, timeout: 124, stuck: 125 } as const;

/** `<root>/runs/<run id>`, where `_as2test` clones and runs the tests. */
export function workDirOf(runId: string, root: string = AS2TEST_ROOT): string {
	need(isRunId(runId), `${runId} is not a run id`);
	return join(root, "runs", runId);
}
/** `<root>/stage/<run id>`, the Jo-owned trusted clone and the bundle `_as2test` clones from. */
export function stageDirOf(runId: string, root: string = AS2TEST_ROOT): string {
	need(isRunId(runId), `${runId} is not a run id`);
	return join(root, "stage", runId);
}

/**
 * One wrapper call. `base-prepare` and `base-solo` (PLAN wl-mv8s8srodefytc rev 17.1 D8) are `prepare` and `solo` on base: a
 * second clone of the same bundle under `runs/<run id>/base`, detached at base's sha (the bundle's `as2-trusted-main`), run with
 * the same argv and env, its reports `base-solo-<i>.*` beside the PR's. Base never runs the full suite (PLAN wl-mvq4edh02r5z40 D3).
 */
export type WrapperCall =
	| { sub: "prepare" | "base-prepare"; runId: string; sha: string }
	| { sub: "full"; runId: string }
	| { sub: "solo" | "base-solo"; runId: string; file: string }
	| { sub: "sweep"; runId: string }
	| { sub: "cleanup"; runId: string; oldRunId: string }
	| { sub: "probe"; runId: string; paths: readonly string[] }
	/** PLAN wl-mvq4edbaf13vnk D4: the Mac fallback of the hosted fast check, the fast set's files (`./<path>`, each once) in one `bun test` call. */
	| { sub: "fast"; runId: string; files: readonly string[] };

/** The exact argv: `sudo -n -u _as2test <exec> <subcommand> <run id> …`. A call the wrapper would refuse throws here first. */
export function wrapperArgv(call: WrapperCall, exec: string = AS2TEST_EXEC): string[] {
	need(isRunId(call.runId), `${call.runId} is not a run id`);
	const head = ["sudo", "-n", "-u", AS2TEST_USER, exec, call.sub, call.runId];
	switch (call.sub) {
		case "prepare":
		case "base-prepare":
			need(isSha(call.sha), `${call.sha} is not a full sha`);
			return [...head, call.sha];
		case "full":
		case "sweep":
			return head;
		case "solo":
		case "base-solo":
			need(isCloneTestFile(call.file), `${call.file} is not a ./<path> test file inside the clone`);
			return [...head, call.file];
		case "fast":
			need(call.files.length > 0, "fast takes one or more ./<test file>");
			for (const f of call.files) need(isCloneTestFile(f), `${f} is not a ./<path> test file inside the clone`);
			need(new Set(call.files).size === call.files.length, "fast names a test file more than once");
			return [...head, ...call.files];
		case "cleanup":
			need(isRunId(call.oldRunId) && call.oldRunId !== call.runId, `${call.oldRunId} is not another run's id`);
			return [...head, call.oldRunId];
		case "probe":
			need(call.paths.length > 0 && call.paths.every((p) => p.startsWith("/")), "probe takes one or more absolute paths");
			return [...head, ...call.paths];
	}
	// A subcommand outside WrapperCall (`base-full`, gone with PLAN wl-mvq4edh02r5z40 D3, among them) is a caller bug the wrapper refuses too.
	throw new TestRunShapeError(`${head[5]} is not a wrapper subcommand`);
}

/** A wrapper test operand: `./<path>` to a Bun test file name, no `..` or empty segment. */
function isCloneTestFile(file: string): boolean {
	return file.startsWith("./") && !file.slice(2).split("/").some((s) => s === ".." || s === "") && isBunTestFile(file);
}
