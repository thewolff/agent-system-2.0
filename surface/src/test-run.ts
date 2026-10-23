// The outside-the-fence test runner's pure half (MIGRATION.md item 24; the approved plan of
// workload wl-muraerdsgw7gn4, revision 12, § 2 to § 4). Nothing here touches the filesystem, a
// process or the ledger: the starter and the detached run (surface/scripts/test-runner.ts), the lane
// tool (surface/extensions/lane-tools.ts), the close check (surface/extensions/workload.ts), the
// `_as2test` wrapper (surface/src/as2test.ts, surface/scripts/test-exec.ts) and row 8's push record
// read what they need and hand it in, so every decision below is tested over plain values.
//
// What lives here:
// - the bodies of `test-requested:`, `test-run:`, `push-dest:` (control entries, launch.ts WRITERS)
//   and `test-run-failed:` (a pushed signal to the orchestrator), each formatted and parsed exactly;
// - the profile's `testRunner:` block and the origin → `owner/repo` mapping every `gh -R` names;
// - the junit report (Bun's `--reporter=junit`) and the console log beside it, read into a part result;
// - the changed-test-file filter on Bun's discovery names;
// - the verdict and settle decision, ownership, liveness, the starter's reservation, retention;
// - the bound-branch rule for a PR, and the close-freshness decision over compare results;
// - the untrusted child's environment, its git shim and gitconfig, and the wrapper's argv contract.
import { dirname, join } from "node:path";
import { type EntryRow, type SliceRow, type SliceState, TEST_RUNNER_BY } from "../../ledger/src/index";
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
 * `red-main` (PLAN wl-mv8s8srodefytc rev 17.1 D8): every failing test of every part also fails in base's run of the same
 * part (origin/main at the sha the trusted phase fetched), so the PR adds no failure; it settles like `green`.
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
	/** Workers for the PR's full part (`bun test --parallel=<n>` when over 1, written into caps.json); base reruns stay serial. */
	fullWorkers: number;
}
/** The plan's defaults (§ 2.2 step 4, § 2.3 steps 1 and 3), used for a key the block leaves out. */
export const TEST_RUNNER_DEFAULTS: Omit<TestRunnerConfig, "repos"> = { fullCapMin: 20, soloCapMin: 10, reportCapMb: 50, queueMaxMin: 60, fullWorkers: 1 };

/**
 * The `testRunner:` block of a parsed profile config (`Bun.YAML.parse` of profile/config.yml). No
 * block serves no repo. A block that is present but malformed is an error, never a default: the
 * caller refuses rather than run under caps nobody wrote.
 */
export function testRunnerConfig(doc: unknown): { ok: true; config: TestRunnerConfig } | { ok: false; error: string } {
	const block = doc !== null && typeof doc === "object" && "testRunner" in doc ? doc.testRunner : undefined;
	if (block === undefined || block === null) return { ok: true, config: { repos: [], ...TEST_RUNNER_DEFAULTS } };
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
	const out: TestRunnerConfig = { repos, ...TEST_RUNNER_DEFAULTS };
	for (const key of ["fullCapMin", "soloCapMin", "reportCapMb", "queueMaxMin"] as const) {
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

// ---- bodies: test-requested: ---------------------------------------------------------------------

export interface TestRequested {
	runId: string;
	pr: number;
	sha: string;
	slice: string;
	/** The lane that asked (or `plumb-bootstrap`, § 6 S8). */
	by: string;
}

function checkRequested(r: TestRequested): void {
	need(isRunId(r.runId), `${r.runId} is not a run id`);
	need(isPr(r.pr), `${r.pr} is not a PR number`);
	need(isSha(r.sha), `${r.sha} is not a full sha`);
	need(/^sl-\S+$/.test(r.slice), `${r.slice} is not a slice id`);
	need(isToken(r.by), `${r.by} is not a requester id`);
}

/** `test-requested: <run id> pr=<N> sha=<sha> slice=<slice> by=<laneId>` (§ 2.2 step 3). */
export function testRequestedBody(r: TestRequested): string {
	checkRequested(r);
	return `${TEST_REQUESTED_PREFIX} ${r.runId} pr=${r.pr} sha=${r.sha} slice=${r.slice} by=${r.by}`;
}

const REQUESTED_RE = /^test-requested: (tr-[a-z0-9]+) pr=([1-9]\d*) sha=([0-9a-f]{40}) slice=(sl-\S+) by=([^\s-]\S*)$/;

export function parseTestRequested(body: string): TestRequested | null {
	const m = REQUESTED_RE.exec(body.trim());
	if (!m) return null;
	const pr = Number(m[2]);
	if (!isPr(pr)) return null;
	return { runId: m[1]!, pr, sha: m[3]!, slice: m[4]!, by: m[5]! };
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
 * One part compared with base's run of the same part (D8): the part (`full` or the solo `./<path>`), the names failing on the
 * PR, the names failing on base (null when base's part errored, as a solo file base lacks does), and base's error.
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

/** The canonical TestRun built from untrusted fields, or null: the one shape both the formatter and the parser accept. */
function canonicalRun(head: { runId: unknown; verdict: unknown; sha: unknown; pr: unknown }, v: Record<string, unknown>): TestRun | null {
	if (!isRunId(head.runId) || !TEST_VERDICTS.includes(head.verdict as TestVerdict) || !isSha(head.sha) || !isPr(head.pr)) return null;
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
		runId: head.runId, verdict: head.verdict as TestVerdict, sha: head.sha, pr: head.pr, reason: v.reason, headAtEnd: v.headAtEnd,
		base: v.base, mergeBase: v.mergeBase, full, solo: solo as SoloCounts[], failures: failures as Failure[], runDir: v.runDir, preflight: v.preflight,
		...(baseCompare === null ? {} : { baseCompare }),
	};
}

/**
 * `test-run: <run id> <verdict> sha=<sha> pr=<N> {json}` (§ 2.3 step 6). The json repeats sha and pr
 * and carries reason, headAtEnd, base, mergeBase, full, solo, failures (every one), runDir and
 * preflight, plus baseCompare when the run has one (D8), on one line. The same object goes to `result.json`.
 */
export function testRunBody(run: TestRun): string {
	const c = canonicalRun(run, run as unknown as Record<string, unknown>);
	need(c !== null, `test-run ${run.runId} does not have the shape its body carries`);
	const json = JSON.stringify({
		sha: c!.sha, pr: c!.pr, reason: c!.reason, headAtEnd: c!.headAtEnd, base: c!.base, mergeBase: c!.mergeBase, full: c!.full, solo: c!.solo,
		failures: c!.failures, runDir: c!.runDir, preflight: c!.preflight, ...(c!.baseCompare ? { baseCompare: c!.baseCompare } : {}),
	});
	return `${TEST_RUN_PREFIX} ${c!.runId} ${c!.verdict} sha=${c!.sha} pr=${c!.pr} ${json}`;
}

const RUN_RE = /^test-run: (tr-[a-z0-9]+) (green|red-main|red|stale|error|superseded) sha=([0-9a-f]{40}) pr=([1-9]\d*) (\{.*\})$/;

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
		full: null, solo: [], failures: [], runDir, preflight: null,
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

/** A run that has waited for the lock past `queueMaxMin` ends `error queued too long` (§ 2.3 step 1). */
export function queuedTooLong(waitStartMs: number, nowMs: number, config: Pick<TestRunnerConfig, "queueMaxMin">): boolean {
	return nowMs - waitStartMs > config.queueMaxMin * 60_000;
}

/** A waiter's row in runs.db's `queue` table: its run, its workload, and its place, the request's `created_at` in ms. */
export interface QueueRow {
	runId: string;
	workloadId: string;
	requestedAt: number;
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
	const ordered = [...rows].sort((a, b) => a.requestedAt - b.requestedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
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

/** The slice the starter adds for a run requested with no slice (`fullSuiteSlice`): the runner's, not the lane's work. */
export const isRunnerFullSuiteSlice = (s: Pick<SliceRow, "id" | "created_by">): boolean => s.id.startsWith("sl-full-") && s.created_by === TEST_RUNNER_BY;

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
	const walk = (node: XmlNode, file: string | null, describes: string[]): void => {
		for (const c of node.children) {
			if (c.name === "testsuite") {
				if (file === null) walk(c, c.attrs.file ?? c.attrs.name ?? "?", []);
				else walk(c, file, [...describes, c.attrs.name ?? "?"]);
			} else if (c.name === "testcase") {
				cases++;
				const f = c.children.find((x) => x.name === "failure" || x.name === "error");
				if (!f) continue;
				const caseFile = c.attrs.file ?? file ?? "?";
				const name = c.attrs.name ?? "?";
				out.push({
					file: caseFile, describes, name, fullName: [caseFile, ...describes, name].join(" > "),
					message: firstLine(f.attrs.message) ?? firstLine(f.text), type: f.attrs.type ?? null,
				});
			}
		}
	};
	walk(root, null, []);
	const fail = failures + errors;
	const pass = tests - fail - skipped;
	if (pass < 0) return { ok: false, error: `junit counts do not add up: ${tests} tests, ${fail} failing, ${skipped} skipped` };
	if (cases !== tests) return { ok: false, error: `junit lists ${cases} test cases but counts ${tests}` };
	if (out.length !== fail) return { ok: false, error: `junit lists ${out.length} failing cases but counts ${fail}` };
	return { ok: true, tests, pass, fail, skip: skipped, failures: out };
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
	/** The cap fired (`error timeout`). */
	timedOut?: boolean;
	/** The import refused the file (a symlink, not a regular file, unreadable, over the cap). */
	importError?: string | null;
	/** The report cap in bytes (reportCapBytes). */
	maxBytes?: number;
}
export interface PartResult extends PartCounts {
	failures: { name: string; firstError: string }[];
}

/**
 * One part's result (§ 2.3 step 6). A refused import, a timeout, a missing or unparsable junit, or a
 * non-zero exit with no failing test makes the part `error`; failing tests keep their names and the
 * first error line (the report's own message, else the log's line, else the failure type).
 */
export function partResult(p: PartInput): PartResult {
	const base = { exit: p.exit, ms: Math.max(0, Math.round(p.ms)) };
	const errored = (error: string, counts = { pass: 0, fail: 0, skip: 0 }, failures: PartResult["failures"] = []): PartResult => ({ ...counts, ...base, error, failures });
	if (p.importError) return errored(`report import refused: ${p.importError}`);
	if (p.junit === null) return errored(p.timedOut ? "timeout" : "junit report missing");
	const report = parseJunit(p.junit, { maxBytes: p.maxBytes });
	if (!report.ok) return errored(p.timedOut ? `timeout; ${report.error}` : report.error);
	const fromLog = p.log === null ? new Map<string, (string | null)[]>() : logFirstErrors(p.log, [...new Set(report.failures.map((f) => f.file))]);
	const failures = report.failures.map((f) => {
		const queue = fromLog.get(f.fullName);
		const logged = queue && queue.length > 0 ? queue.shift()! : null;
		return { name: f.fullName, firstError: f.message ?? logged ?? `${f.type ?? "failure"} (no message in the report or the log)` };
	});
	const counts = { pass: report.pass, fail: report.fail, skip: report.skip };
	if (p.timedOut) return errored("timeout", counts, failures);
	if (p.exit === null) return errored("killed before it exited", counts, failures);
	if (p.exit !== 0 && report.fail === 0) return errored(`exit ${p.exit} with no failing test`, counts, failures);
	return { ...counts, ...base, error: null, failures };
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
	 * Base's runs of the failing parts (D8), keyed by part (`full` or the solo `./<path>`), at `sha` (origin/main as the trusted
	 * phase fetched it); null when no part was rerun on base (`baseParts` named none, or the run stopped first).
	 */
	baseRuns: { sha: string; parts: Readonly<Record<string, PartResult>> } | null;
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

/**
 * The parts the runner reruns on base (D8), in part order: each part with a failing test, when every part reported cleanly (no
 * part `error`, and every part without a failing test exited 0); else none, since such a run is `red` or `error` whatever base says.
 */
export function baseParts(f: Pick<RunFacts, "full" | "solo">): string[] {
	if (f.full === null) return [];
	const parts: { label: string; p: PartResult }[] = [{ label: "full", p: f.full }, ...f.solo.map((s) => ({ label: s.file, p: s }))];
	if (parts.some(({ p }) => p.error !== null || (p.fail === 0 && p.exit !== 0))) return [];
	return parts.filter(({ p }) => p.fail > 0).map(({ label }) => label);
}

/** Each failing part beside base's run of it (D8), or null when the run has no base runs. A part base never ran counts as base's error. */
export function baseCompareFor(f: Pick<RunFacts, "full" | "solo" | "baseRuns">): BaseCompare | null {
	if (f.baseRuns === null) return null;
	const runs = f.baseRuns.parts;
	const failing: { label: string; p: PartResult }[] = [...(f.full ? [{ label: "full", p: f.full }] : []), ...f.solo.map((s) => ({ label: s.file, p: s }))];
	const parts = failing.filter(({ p }) => p.fail > 0).map(({ label, p }): BasePart => {
		const base = Object.hasOwn(runs, label) ? runs[label]! : null;
		const baseError = base === null ? "not run on base" : base.error;
		return { part: label, failing: p.failures.map((x) => x.name), baseFailing: baseError === null ? base!.failures.map((x) => x.name) : null, baseError };
	});
	return { sha: f.baseRuns.sha, parts };
}

/**
 * Main red (D8): every failing test of every compared part also fails in base's run of that part; a base error is never main red.
 * Failures compare as a multiset: a failure identity (`file > describe > name`, not unique when two cases share a name) that
 * fails more often on the head than on base is a failure base lacks, so the part is `red`.
 */
export function mainRed(c: BaseCompare): boolean {
	const covered = (failing: readonly string[], base: readonly string[]): boolean => {
		const left = new Map<string, number>();
		for (const n of base) left.set(n, (left.get(n) ?? 0) + 1);
		for (const n of failing) {
			const k = left.get(n) ?? 0;
			if (k === 0) return false;
			left.set(n, k - 1);
		}
		return true;
	};
	return c.parts.length > 0 && c.parts.every((p) => p.baseFailing !== null && covered(p.failing, p.baseFailing));
}

/**
 * The verdict (§ 2.3 step 6, § 2.4) and whether to settle (§ 2.2 step 5, § 2.3 step 7), in this order:
 * a fetched head that is not the requested sha is `stale` before any test; a run-level failure is
 * `error`; a head that moved by the end is `stale` whatever the counts; any failing test in any
 * part is `red` (a solo failure with the suite green included), or `red-main` when base's runs of the failing parts
 * (`baseRuns`) fail every one of them too (`mainRed`, D8); a part that errored is `error`;
 * otherwise `green`. A run that does not own its request records `superseded` and settles nothing.
 */
export function decideRun(f: RunFacts): RunDecision {
	const outcome = ((): { outcome: RunDecision["outcome"]; reason: string | null } => {
		if (f.fetchedSha !== null && f.fetchedSha !== f.requestedSha) {
			return { outcome: "stale", reason: `requested ${sha7(f.requestedSha)} but the PR head was ${sha7(f.fetchedSha)}; nothing was tested` };
		}
		if (f.error !== null) return { outcome: "error", reason: f.error };
		if (f.fetchedSha === null) return { outcome: "error", reason: "the PR head was never fetched" };
		if (f.full === null) return { outcome: "error", reason: "the full suite did not run" };
		if (f.headAtEnd === null) return { outcome: "error", reason: "the PR head could not be re-read at the end" };
		if (f.headAtStart !== f.requestedSha || f.headAtEnd !== f.headAtStart) {
			return { outcome: "stale", reason: `the PR head moved to ${sha7(f.headAtEnd)} during the run of ${sha7(f.requestedSha)}` };
		}
		const parts = [f.full, ...f.solo];
		if (parts.some((p) => p.fail > 0)) {
			const compare = baseParts(f).length > 0 ? baseCompareFor(f) : null;
			if (compare !== null && mainRed(compare)) return { outcome: "red-main", reason: `every failing test also fails on base ${sha7(compare.sha)}` };
			return { outcome: "red", reason: null };
		}
		const broken = [{ p: f.full, label: "full" }, ...f.solo.map((s) => ({ p: s, label: s.file }))].find(({ p }) => p.error !== null || p.exit !== 0);
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
		...(baseCompare === null ? {} : { baseCompare }),
	};
}

/** The orchestrator hears a finished run that is neither green, red-main nor superseded when no lane holds the workload under a live lease (§ 2.3 step 8). */
export function notifiesOrchestrator(verdict: TestVerdict, heldLive: boolean): boolean {
	return !SETTLING_VERDICTS.includes(verdict) && verdict !== "superseded" && !heldLive;
}

/** The artifact a settled slice carries (§ 2.3 step 7); a red-main names base's sha and every compared part (D8). */
export function settleArtifact(run: TestRun): string {
	need(SETTLING_VERDICTS.includes(run.verdict) && run.full !== null, `test-run ${run.runId} is not a green or red-main with a full part`);
	const alone = run.solo.length === 0 ? "none" : run.solo.map((s) => `${s.file} ${s.pass}/${s.fail}`).join(", ");
	const main = run.verdict === "red-main" && run.baseCompare
		? `; every failure also fails on base ${run.baseCompare.sha} (${run.baseCompare.parts.map((p) => `${p.part} ${p.failing.length}`).join(", ")})`
		: "";
	return `test-run ${run.runId}: ${run.verdict} at ${run.sha} on PR #${run.pr}; full ${run.full!.pass}/${run.full!.fail}/${run.full!.skip}; alone: ${alone}${main}; ${run.runDir ?? "no run dir"}`;
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
	/** The authoritative result (authoritativeRun(...).result), or null. */
	result: { runId: string; verdict: TestVerdict; sha: string } | null;
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
	 * For a MERGED PR its own results do not pass (`mergedNeedsCover`: no result, a green its merged head does not keep, a red,
	 * error or stale run Jo did not waive at that head, or a red-main off a train or not at its merged head): the newest
	 * test-runner green, on any workload of this repository, whose sha S is on the freshly fetched `origin/<default>` and either is
	 * the merged head (or the head descends from S through decision-log-only commits, `how: "head"`) or contains the merge commit
	 * (`how: "merge"`) (PLAN wl-mvfjen3q5mqi2o D2; surface/src/close-entry.ts `gatherCloseFacts`); else null. S is an integration
	 * snapshot of the main line that contains the merge, not a claim that it still runs every line the PR added.
	 */
	cover: { runId: string; sha: string; workloadId: string; how: "head" | "merge" } | null;
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
 * result; a green its merged head does not keep; a red, error, stale or superseded run Jo's run-based `waive` does not pass at
 * that head; or a red-main off a train or not at its merged head. False for any other state and for a PR Jo skipped on a train.
 * It mirrors `closeFreshness`'s rules for a merged PR, which pass these PRs on `cover` or `waivedByJo` only after their own rules.
 */
export function mergedNeedsCover(pr: Pick<ClosePr, "state" | "result" | "headSha" | "headCompare" | "waivedRun" | "trainSkipped" | "onTrain">): boolean {
	if (pr.state !== "MERGED" || pr.trainSkipped) return false;
	const r = pr.result;
	if (r === null) return true;
	if (r.verdict === "green") return pr.headSha !== r.sha && decisionLogFault(pr.headCompare) !== null;
	if (r.verdict === "red-main") return !pr.onTrain || pr.headSha !== r.sha;
	return pr.waivedRun !== r.runId || pr.headSha !== r.sha;
}

/**
 * The close check (§ 2.4 item 4). Every open or merged PR in the set needs an authoritative green at
 * S, with its head at S or descended from it through commits that each touch only the decision log;
 * its final head, and an open PR never passes on a waiver. A `red-main` result (D8) passes only a merged train PR
 * (`onTrain`) at exactly its merged head, and then counts as that PR's green. A PR Jo skipped on a merge train (`trainSkipped`)
 * is treated like a closed one and named in the why. A MERGED PR its own results do not pass (`mergedNeedsCover`: no result, a
 * green its merged head does not keep, a red, error or stale run not waived at that head, a red-main off a train) passes on a
 * covering test-runner green on the main line (`cover`, PLAN wl-mvfjen3q5mqi2o D2), else on Jo's `waive-pr` (`waivedByJo`,
 * D3); with neither, a PR with no result or an unkept green is refused naming its merge commit and both ways through (D4), and
 * any other keeps its refusal with the same two ways appended. An open PR never passes on either. A candidate with a code
 * delta needs such a green on a PR from the branch that covers C the same way (a waiver or a cover covers nothing). The one
 * exemption is an empty PR set with no code delta. Anything git or gh could not answer refuses.
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
	// D2 then D3, for a MERGED PR its own results do not pass: true when it passes, and named in the why.
	const passesMerged = (pr: ClosePr): boolean => {
		if (pr.state !== "MERGED") return false;
		const c = pr.cover;
		if (c !== null) {
			const holds = c.how === "merge" ? `which contains merge commit ${pr.mergeCommit === null ? "unknown" : sha7(pr.mergeCommit)}` : "at its merged head";
			covers.push(`PR #${pr.number} merged; covered by test-run ${c.runId} green at ${sha7(c.sha)} (${c.workloadId}), ${holds}`);
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
			(p) => p.state !== "CLOSED" && (p.result?.verdict === "green" || mainRedMerged.has(p.number)) && (f.candidate.sha === p.result!.sha || decisionLogOnly(p.candidateCompare)),
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
 * `probeReachable` is `probe`'s answer when a path it was given opens.
 */
export const WRAPPER_EXIT = { ok: 0, probeReachable: 65, failed: 70, sweepLockHeld: 75, refused: 64, fenced: 77, timeout: 124 } as const;

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
 * One wrapper call. `base-prepare`, `base-full` and `base-solo` (PLAN wl-mv8s8srodefytc rev 17.1 D8) are `prepare`, `full` and
 * `solo` on base: a second clone of the same bundle under `runs/<run id>/base`, detached at base's sha (the bundle's
 * `as2-trusted-main`), run with the same argv and env, its reports `base-full.*` and `base-solo-<i>.*` beside the PR's.
 */
export type WrapperCall =
	| { sub: "prepare" | "base-prepare"; runId: string; sha: string }
	| { sub: "full" | "base-full"; runId: string }
	| { sub: "solo" | "base-solo"; runId: string; file: string }
	| { sub: "sweep"; runId: string }
	| { sub: "cleanup"; runId: string; oldRunId: string }
	| { sub: "probe"; runId: string; paths: readonly string[] };

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
		case "base-full":
		case "sweep":
			return head;
		case "solo":
		case "base-solo":
			need(call.file.startsWith("./") && !call.file.slice(2).split("/").some((s) => s === ".." || s === "") && isBunTestFile(call.file), `${call.file} is not a ./<path> test file inside the clone`);
			return [...head, call.file];
		case "cleanup":
			need(isRunId(call.oldRunId) && call.oldRunId !== call.runId, `${call.oldRunId} is not another run's id`);
			return [...head, call.oldRunId];
		case "probe":
			need(call.paths.length > 0 && call.paths.every((p) => p.startsWith("/")), "probe takes one or more absolute paths");
			return [...head, ...call.paths];
	}
}
