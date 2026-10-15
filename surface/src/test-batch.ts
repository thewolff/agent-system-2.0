// Jo's batch run on the outside-the-fence test runner (plan wl-mv615mkeaf1yio § 4): the pure half,
// beside surface/src/test-run.ts so that file stays the single-PR runner's. The starter and the
// detached run (surface/scripts/test-runner.ts `start-batch`, `run`), the surface word
// (surface/src/input.ts `test-batch`), the close check (surface/src/close-entry.ts) and the
// needs-you lines (surface/src/errors.ts) read what they need and hand it in.
//
// What lives here:
// - the word's PR list, Jo's instruction `test-batch <wl> <N…>` and the surface's `test-batch: <N…> <instruction id>`;
// - the runner's bodies: `test-batch-requested:`, `test-batch-run:`, `test-batch-attribution:`,
//   `test-batch-credit:` (control entries, launch.ts WRITERS: the runner's alone) and the
//   `test-batch-result:` message to the orchestrator, each formatted and parsed exactly;
// - admission (a full green at each pinned head on the PR's own workload), the batch slice, the
//   verdict, the bisection over full-suite prefixes, and the attribution reader over runs.db;
// - the one impure piece, marked below: the read of runs.db and heartbeat files for that reader,
//   in one SQLite read transaction, and the exec of the starter for the surface word.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryRow, type InstructionRow, type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { controlEntries } from "./launch";
import {
	type Admission, authoritativeRun, type Failure, lockHolderStale, parseHeartbeat, type PartCounts, type PartResult, type PrView, type RunRecord, RUN_ID_RE, runDirOf,
	runLive, runsDbOf, SHA_RE, TestRunShapeError,
} from "./test-run";
import { SURFACE_BY, type SurfaceAPI } from "./types";

/** The fewest and the most PRs one batch takes (plan § 4). */
export const TEST_BATCH_MIN = 2;
export const TEST_BATCH_MAX = 8;

/** Body prefixes: the surface's entry naming Jo's instruction, the runner's control entries, and its message to the orchestrator. */
export const TEST_BATCH_PREFIX = "test-batch:";
export const TEST_BATCH_REQUESTED_PREFIX = "test-batch-requested:";
export const TEST_BATCH_RUN_PREFIX = "test-batch-run:";
export const TEST_BATCH_ATTRIBUTION_PREFIX = "test-batch-attribution:";
export const TEST_BATCH_CREDIT_PREFIX = "test-batch-credit:";
export const TEST_BATCH_RESULT_PREFIX = "test-batch-result:";

/** The installed starter the surface execs (this module lives in the checkout's surface/src, as `LANE_SCRIPT` does). */
export const TEST_RUNNER_SCRIPT = join(import.meta.dir, "..", "scripts", "test-runner.ts");
/** The starter is foreground and returns within this. */
export const START_BATCH_TIMEOUT_MS = 30_000;

const isSha = (s: unknown): s is string => typeof s === "string" && SHA_RE.test(s);
const isRunId = (s: unknown): s is string => typeof s === "string" && RUN_ID_RE.test(s);
const isPr = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const nat = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const sha7 = (s: string) => s.slice(0, 7);
function need(ok: boolean, what: string): void {
	if (!ok) throw new TestRunShapeError(what);
}

/** One PR of a batch, at the head the starter pinned from GitHub. */
export interface BatchPr {
	pr: number;
	sha: string;
}

/** `#12, #15`: PR numbers as Jo reads them. */
export const prList = (prs: readonly number[]): string => prs.map((n) => `#${n}`).join(", ");

// ---- Jo's word ------------------------------------------------------------------------------------

/**
 * The PR numbers of `test-batch <wl-…> <N> <N> …` after the workload, separated by spaces and/or
 * commas: each a positive whole number, TEST_BATCH_MIN to TEST_BATCH_MAX of them, Jo's order kept,
 * none named twice. Anything else is the reason it is refused.
 */
export function batchPrs(tokens: readonly string[]): { ok: true; prs: number[] } | { ok: false; why: string } {
	const usage = "test-batch <wl-…> <N> <N> …";
	const words = tokens.join(" ").split(/[\s,]+/).filter((t) => t.length > 0);
	const bad = words.find((t) => !/^#?[1-9]\d*$/.test(t) || !Number.isSafeInteger(Number(t.replace(/^#/, ""))));
	if (bad !== undefined) return { ok: false, why: `${bad} is not a PR number (a positive whole number): ${usage}` };
	const prs = words.map((t) => Number(t.replace(/^#/, "")));
	const twice = prs.find((n, i) => prs.indexOf(n) !== i);
	if (twice !== undefined) return { ok: false, why: `PR #${twice} is named twice; a batch names each PR once: ${usage}` };
	if (prs.length < TEST_BATCH_MIN || prs.length > TEST_BATCH_MAX) {
		return { ok: false, why: `a batch takes ${TEST_BATCH_MIN} to ${TEST_BATCH_MAX} PRs; ${prs.length} named: ${usage}` };
	}
	return { ok: true, prs };
}

/** Jo's instruction row: `test-batch <wl> <N> <N> …`. */
export function testBatchInstructionBody(workloadId: string, prs: readonly number[]): string {
	need(/^wl-\S+$/.test(workloadId), `${workloadId} is not a workload id`);
	need(prs.length >= TEST_BATCH_MIN && prs.length <= TEST_BATCH_MAX && prs.every(isPr) && new Set(prs).size === prs.length, `${prs.join(" ")} is not a batch's PR list`);
	return `test-batch ${workloadId} ${prs.join(" ")}`;
}

export function parseTestBatchInstruction(body: string): { workloadId: string; prs: number[] } | null {
	const m = /^test-batch (wl-\S+)((?: [1-9]\d*)+)$/.exec(body.trim());
	if (!m) return null;
	const prs = batchPrs(m[2]!.trim().split(" "));
	return prs.ok ? { workloadId: m[1]!, prs: prs.prs } : null;
}

/** The surface's entry, written with the instruction in one transaction: `test-batch: <N> <N> … <instruction id>`. */
export function testBatchBody(prs: readonly number[], instructionId: string): string {
	need(prs.length >= TEST_BATCH_MIN && prs.length <= TEST_BATCH_MAX && prs.every(isPr) && new Set(prs).size === prs.length, `${prs.join(" ")} is not a batch's PR list`);
	need(/^in-[a-z0-9]+$/.test(instructionId), `${instructionId} is not an instruction id`);
	return `${TEST_BATCH_PREFIX} ${prs.join(" ")} ${instructionId}`;
}

export function parseTestBatch(body: string): { prs: number[]; instructionId: string } | null {
	const m = /^test-batch: ((?:[1-9]\d* )+)(in-[a-z0-9]+)$/.exec(body.trim());
	if (!m) return null;
	const prs = batchPrs(m[1]!.trim().split(" "));
	return prs.ok ? { prs: prs.prs, instructionId: m[2]! } : null;
}

/**
 * What the starter accepts (plan § 4): Jo's instruction `instructionId` on `workloadId` (kind
 * `instruction`, author `jo`, written by the surface) whose body parses and names this workload,
 * together with the surface's `test-batch:` entry naming that instruction with the same PR list.
 */
export function batchInstruction(
	workloadId: string, instructionId: string, instructions: readonly InstructionRow[], entries: readonly EntryRow[],
): { ok: true; prs: number[] } | { ok: false; reason: string } {
	const row = instructions.find((i) => i.id === instructionId);
	if (!row || row.workload_id !== workloadId) return { ok: false, reason: `no instruction ${instructionId} on ${workloadId}` };
	if (row.kind !== "instruction" || row.author !== "jo" || row.created_by !== SURFACE_BY) return { ok: false, reason: `${instructionId} is not Jo's word at the surface` };
	const parsed = parseTestBatchInstruction(row.body);
	if (!parsed || parsed.workloadId !== workloadId) return { ok: false, reason: `${instructionId} is not a test-batch instruction for ${workloadId}` };
	const named = controlEntries(entries).some((c) => {
		if (c.prefix !== "test-batch") return false;
		const b = parseTestBatch(c.body);
		return b !== null && b.instructionId === instructionId && b.prs.join(" ") === parsed.prs.join(" ");
	});
	if (!named) return { ok: false, reason: `no surface test-batch: entry names ${instructionId}` };
	// One instruction starts one batch: a request with the same PRs written since the instruction is its batch already.
	const started = batchRequests(entries).find((r) => r.createdAt >= row.created_at && r.prs.map((p) => p.pr).join(" ") === parsed.prs.join(" "));
	if (started) return { ok: false, reason: `${instructionId} already started batch ${started.runId}` };
	return { ok: true, prs: parsed.prs };
}

// ---- admission ----------------------------------------------------------------------------------

/** The workload a PR's head branch `wl/<id>` names, or null for any other branch. */
export function ownWorkloadOf(headRefName: string): string | null {
	return /^wl\/(wl-[^\s/]+)$/.exec(headRefName)?.[1] ?? null;
}

/**
 * The starter's admission (plan § 4), the first PR in Jo's order that fails refusing the whole
 * batch: every PR open, from this repo (no fork), with a full head sha; then green PRs only (review
 * rounds 3 and 4): the authoritative run on the PR's own workload (`authoritativeRun`, the close
 * check's rule) must be a green with mode `full` and a full part, at exactly the pinned head. A
 * doc-merge green does not count. `records` is null when the head branch names no workload the
 * ledger has.
 */
export function batchAdmissible(items: readonly { view: PrView; records: readonly RunRecord[] | null }[]): { ok: true; prs: BatchPr[] } | { ok: false; reason: string } {
	for (const { view } of items) {
		if (view.state !== "OPEN") return { ok: false, reason: `PR #${view.number} is ${view.state.toLowerCase()}, not open` };
		if (view.isCrossRepository !== false) return { ok: false, reason: `PR #${view.number} comes from a fork; a fork head never runs` };
		if (!isSha(view.headRefOid)) return { ok: false, reason: `PR #${view.number} reports no full head sha` };
	}
	for (const { view, records } of items) {
		const no = (why: string) => ({ ok: false as const, reason: `PR #${view.number} has no full green at ${sha7(view.headRefOid)} (${why})` });
		const wl = ownWorkloadOf(view.headRefName);
		if (wl === null || records === null) return no(`its head branch ${view.headRefName} names no wl/<id> workload in the ledger`);
		const rec = authoritativeRun(records, view.number);
		if (rec === null) return no(`no run of it on ${wl}`);
		const r = rec.result;
		if (r === null) return no(`its newest run ${rec.request.runId} on ${wl} has no result`);
		if (r.verdict !== "green") return no(`its newest run ${r.runId} on ${wl} is ${r.verdict}`);
		if (r.mode !== "full" || r.full === null) return no(`its newest run ${r.runId} on ${wl} is a ${r.mode} green without a full suite`);
		if (r.sha !== view.headRefOid) return no(`its newest run ${r.runId} on ${wl} ran at ${sha7(r.sha)}`);
	}
	return { ok: true, prs: items.map(({ view }) => ({ pr: view.number, sha: view.headRefOid })) };
}

/** The slice the starter adds: `sl-batch-<wl without wl->-<n>`, n one past the highest taken (as `fullSuiteSlice`). */
export function batchSlice(workloadId: string, prs: readonly number[], existingSliceIds: readonly string[]): { id: string; task: string; doneCondition: string } {
	need(/^wl-\S+$/.test(workloadId), `${workloadId} is not a workload id`);
	const stem = `sl-batch-${workloadId.slice(3)}-`;
	let n = 0;
	for (const id of existingSliceIds) {
		if (!id.startsWith(stem)) continue;
		const k = Number(id.slice(stem.length));
		if (Number.isSafeInteger(k) && k > n) n = k;
	}
	return { id: `${stem}${n + 1}`, task: `batch run outside the fence of PRs ${prList(prs)} merged onto main in that order`, doneCondition: "a test-batch-run with a final verdict at the pinned heads" };
}

// ---- bodies: test-batch-requested: ----------------------------------------------------------------

export interface TestBatchRequested {
	runId: string;
	prs: BatchPr[];
	slice: string;
	/** Always `jo`: only Jo's word starts a batch. */
	by: "jo";
}

function checkPrs(prs: readonly BatchPr[]): void {
	need(prs.length >= TEST_BATCH_MIN && prs.length <= TEST_BATCH_MAX, `${prs.length} PRs is not a batch`);
	need(prs.every((p) => isPr(p.pr) && isSha(p.sha)), "every batch PR has a number and a full sha");
	need(new Set(prs.map((p) => p.pr)).size === prs.length, "a batch names each PR once");
}

/** `test-batch-requested: <run id> prs=<N@sha,…> slice=<sl> by=jo` (plan § 4). */
export function testBatchRequestedBody(r: TestBatchRequested): string {
	need(isRunId(r.runId), `${r.runId} is not a run id`);
	checkPrs(r.prs);
	need(/^sl-\S+$/.test(r.slice), `${r.slice} is not a slice id`);
	need(r.by === "jo", "only Jo requests a batch");
	return `${TEST_BATCH_REQUESTED_PREFIX} ${r.runId} prs=${r.prs.map((p) => `${p.pr}@${p.sha}`).join(",")} slice=${r.slice} by=jo`;
}

export function parseTestBatchRequested(body: string): TestBatchRequested | null {
	const m = /^test-batch-requested: (tr-[a-z0-9]+) prs=((?:[1-9]\d*@[0-9a-f]{40},)*[1-9]\d*@[0-9a-f]{40}) slice=(sl-\S+) by=jo$/.exec(body.trim());
	if (!m) return null;
	const prs = m[2]!.split(",").map((s) => ({ pr: Number(s.slice(0, s.indexOf("@"))), sha: s.slice(s.indexOf("@") + 1) }));
	if (prs.length < TEST_BATCH_MIN || prs.length > TEST_BATCH_MAX || !prs.every((p) => isPr(p.pr)) || new Set(prs.map((p) => p.pr)).size !== prs.length) return null;
	return { runId: m[1]!, prs, slice: m[3]!, by: "jo" };
}

// ---- bodies: test-batch-run: ------------------------------------------------------------------------

export type BatchVerdict = "green" | "red" | "stale" | "error";
const BATCH_VERDICTS: readonly BatchVerdict[] = ["green", "red", "stale", "error"];

/** One merge step in the stage clone: `refs/heads/as2-batch-<k>`, its commit and tree; step 0 is M0 itself. */
export interface BatchStep {
	commit: string;
	tree: string;
}

export interface TestBatchRun {
	runId: string;
	verdict: BatchVerdict;
	/** M0: origin/main as fetched; null when the run never fetched it. */
	base: string | null;
	prs: BatchPr[];
	/** Steps 0 (M0) to n, or to the step before a conflict; empty when nothing was built. */
	steps: BatchStep[];
	full: PartCounts | null;
	failures: Failure[];
	/** Set exactly on a red after a full suite: the attribution run the batch handed off to. */
	attribution: string | null;
	reason: string | null;
	/** Each PR's `refs/pull/<N>/head` re-read at the end, in Jo's order; null when the run never got that far. */
	headsAtEnd: (string | null)[] | null;
	runDir: string | null;
	preflight: string | null;
}

function partOf(v: unknown): PartCounts | null {
	if (v === null || typeof v !== "object") return null;
	const p = v as Record<string, unknown>;
	if (!nat(p.pass) || !nat(p.fail) || !nat(p.skip) || !nat(p.ms)) return null;
	if (!(p.exit === null || (typeof p.exit === "number" && Number.isSafeInteger(p.exit)))) return null;
	if (!(p.error === null || typeof p.error === "string")) return null;
	return { pass: p.pass, fail: p.fail, skip: p.skip, exit: p.exit as number | null, ms: p.ms, error: p.error as string | null };
}
const strOrNull = (s: unknown): s is string | null => s === null || typeof s === "string";

function canonicalBatchRun(runId: unknown, verdict: unknown, v: Record<string, unknown>): TestBatchRun | null {
	if (!isRunId(runId) || !BATCH_VERDICTS.includes(verdict as BatchVerdict)) return null;
	if (!(v.base === null || isSha(v.base)) || !strOrNull(v.reason) || !strOrNull(v.runDir) || !strOrNull(v.preflight)) return null;
	if (!(v.attribution === null || isRunId(v.attribution))) return null;
	if (!Array.isArray(v.prs) || !Array.isArray(v.steps) || !Array.isArray(v.failures)) return null;
	const prs = v.prs.map((p) => (p !== null && typeof p === "object" && isPr((p as BatchPr).pr) && isSha((p as BatchPr).sha) ? { pr: (p as BatchPr).pr, sha: (p as BatchPr).sha } : null));
	if (prs.some((p) => p === null) || prs.length < TEST_BATCH_MIN || prs.length > TEST_BATCH_MAX || new Set(prs.map((p) => p!.pr)).size !== prs.length) return null;
	const steps = v.steps.map((s) => (s !== null && typeof s === "object" && isSha((s as BatchStep).commit) && isSha((s as BatchStep).tree) ? { commit: (s as BatchStep).commit, tree: (s as BatchStep).tree } : null));
	if (steps.some((s) => s === null) || steps.length > prs.length + 1) return null;
	const full = v.full === null ? null : partOf(v.full);
	if (v.full !== null && full === null) return null;
	const failures = v.failures.map((f) => {
		const x = f as Record<string, unknown> | null;
		return x !== null && typeof x === "object" && typeof x.part === "string" && typeof x.name === "string" && typeof x.firstError === "string" ? { part: x.part, name: x.name, firstError: x.firstError } : null;
	});
	if (failures.some((f) => f === null)) return null;
	let headsAtEnd: (string | null)[] | null = null;
	if (v.headsAtEnd !== null) {
		if (!Array.isArray(v.headsAtEnd) || v.headsAtEnd.length !== prs.length || !v.headsAtEnd.every((h) => h === null || isSha(h))) return null;
		headsAtEnd = [...(v.headsAtEnd as (string | null)[])];
	}
	// A green carries every step; an attribution only rides a red with a full part.
	if (verdict === "green" && (steps.length !== prs.length + 1 || full === null || v.base === null)) return null;
	if (v.attribution !== null && (verdict !== "red" || full === null || steps.length !== prs.length + 1)) return null;
	return {
		runId, verdict: verdict as BatchVerdict, base: v.base as string | null, prs: prs as BatchPr[], steps: steps as BatchStep[], full, failures: failures as Failure[],
		attribution: v.attribution as string | null, reason: v.reason as string | null, headsAtEnd, runDir: v.runDir as string | null, preflight: v.preflight as string | null,
	};
}

/** `test-batch-run: <run id> <verdict> {base, prs, steps, full, failures, attribution, reason, headsAtEnd, runDir, preflight}` on one line (plan § 4). */
export function testBatchRunBody(run: TestBatchRun): string {
	const c = canonicalBatchRun(run.runId, run.verdict, run as unknown as Record<string, unknown>);
	need(c !== null, `test-batch-run ${run.runId} does not have the shape its body carries`);
	const json = JSON.stringify({
		base: c!.base, prs: c!.prs, steps: c!.steps, full: c!.full, failures: c!.failures, attribution: c!.attribution, reason: c!.reason, headsAtEnd: c!.headsAtEnd,
		runDir: c!.runDir, preflight: c!.preflight,
	});
	return `${TEST_BATCH_RUN_PREFIX} ${c!.runId} ${c!.verdict} ${json}`;
}

export function parseTestBatchRun(body: string): TestBatchRun | null {
	const m = /^test-batch-run: (tr-[a-z0-9]+) (green|red|stale|error) (\{.*\})$/.exec(body.trim());
	if (!m) return null;
	let v: unknown;
	try {
		v = JSON.parse(m[3]!);
	} catch {
		return null;
	}
	if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
	return canonicalBatchRun(m[1], m[2], v as Record<string, unknown>);
}

/**
 * A batch's `test-batch-run:` row by run id, on whichever workload Jo named for the batch, written
 * by the runner; null when none parses. The close check reads it for a credit on a PR's own workload.
 */
export function batchRunOf(ledger: Ledger, runId: string): TestBatchRun | null {
	if (!isRunId(runId)) return null;
	const rows = ledger.db.query<{ body: string }, [string, string]>(
		"SELECT body FROM entries WHERE kind = 'assumption' AND created_by = ? AND body LIKE ? ORDER BY created_at, rowid",
	).all(TEST_RUNNER_BY, `${TEST_BATCH_RUN_PREFIX} ${runId} %`);
	return rows.map((r) => parseTestBatchRun(r.body)).filter((r) => r !== null && r.runId === runId).at(-1) ?? null;
}

// ---- the verdict ----------------------------------------------------------------------------------

export interface BatchFacts {
	prs: readonly BatchPr[];
	/** Each `refs/pull/<N>/head` as fetched into the stage clone, in Jo's order; null when the run never got that far. */
	fetched: readonly string[] | null;
	/** A run-level failure (lock, queue, preflight, clone, sweep); null when none. */
	error: string | null;
	/** The 1-based step whose merge conflicted; null when every merge went through. */
	conflict: number | null;
	full: PartResult | null;
	headsAtEnd: readonly (string | null)[] | null;
	/** The lock row still held this run at the write; else why not. */
	lockLost: string | null;
	/** The batch slice's state read in the write transaction; null when it is gone. */
	sliceState: string | null;
}

/** `PR #k does not merge onto main + #1..#k-1` with Jo's PR numbers. */
export function conflictReason(prs: readonly BatchPr[], step: number): string {
	const before = prs.slice(0, step - 1).map((p) => p.pr);
	return `PR #${prs[step - 1]!.pr} does not merge onto main${before.length > 0 ? ` + ${prList(before)}` : ""}; no tests ran`;
}

/**
 * One full suite's verdict on the batch side (plan § 4, review r1 finding 1), read by the batch's own
 * verdict and by every attribution probe: a part with an error (a timeout, a kill, a refused or
 * missing report: `partResult` sets it) never finished, so it is `error` whatever its fail count;
 * then a failing test is `red`; then a non-zero exit is `error`; otherwise `green`. The broken
 * part's reason is decideRun's: its error, else its exit.
 * Unlike decideRun, which counts a failing test as red before an error: naming a PR as the breaker rests only on complete suites.
 */
export function fullSuiteVerdict(full: PartCounts): { verdict: "green" | "red" } | { verdict: "error"; why: string } {
	if (full.error !== null) return { verdict: "error", why: full.error };
	if (full.fail > 0) return { verdict: "red" };
	if (full.exit !== 0) return { verdict: "error", why: `exit ${full.exit}` };
	return { verdict: "green" };
}

/**
 * The batch's verdict (plan § 4), in this order: a fetched head that is not its pin is `stale` before
 * anything is built; a run-level failure is `error`; a lost lock is `error`; a conflict at step k is
 * `red` with no tests; no full suite is `error`; a head that cannot be re-read is `error`; a head
 * that moved by the end is `stale` whatever the counts; then the full suite's `fullSuiteVerdict`: a
 * part that errored is `error` (so no attribution), a failing test is `red`, otherwise `green`. Every
 * verdict settles the batch slice when it is still open.
 */
export function decideBatch(f: BatchFacts): { verdict: BatchVerdict; reason: string | null; settle: boolean } {
	const v = ((): { verdict: BatchVerdict; reason: string | null } => {
		if (f.fetched !== null) {
			const moved = f.prs.findIndex((p, i) => f.fetched![i] !== p.sha);
			if (moved >= 0) return { verdict: "stale", reason: `PR #${f.prs[moved]!.pr} was pinned at ${sha7(f.prs[moved]!.sha)} but its head was ${sha7(f.fetched[moved] ?? "nothing")}; nothing was tested` };
		}
		if (f.error !== null) return { verdict: "error", reason: f.error };
		if (f.lockLost !== null) return { verdict: "error", reason: `the batch lost the lock: ${f.lockLost}` };
		if (f.fetched === null) return { verdict: "error", reason: "the PR heads were never fetched" };
		if (f.conflict !== null) return { verdict: "red", reason: conflictReason(f.prs, f.conflict) };
		if (f.full === null) return { verdict: "error", reason: "the full suite did not run" };
		if (f.headsAtEnd === null || f.headsAtEnd.some((h) => h === null)) return { verdict: "error", reason: "a PR head could not be re-read at the end" };
		const moved = f.prs.findIndex((p, i) => f.headsAtEnd![i] !== p.sha);
		if (moved >= 0) return { verdict: "stale", reason: `PR #${f.prs[moved]!.pr}'s head moved to ${sha7(f.headsAtEnd[moved]!)} during the batch` };
		const full = fullSuiteVerdict(f.full);
		return full.verdict === "error" ? { verdict: "error", reason: `full: ${full.why}` } : { verdict: full.verdict, reason: null };
	})();
	return { ...v, settle: f.sliceState === "open" };
}

/**
 * The artifact a settled batch slice carries, one line: a green names the merge its full suite
 * passed; any other verdict names the pinned PRs, the base, its reason (or the full counts), the
 * attribution it handed off to and the run dir.
 */
export function batchSettleArtifact(run: TestBatchRun): string {
	const prs = run.prs.map((p) => `#${p.pr}@${sha7(p.sha)}`).join(", ");
	if (run.verdict === "green") {
		need(run.full !== null && run.base !== null, `test-batch-run ${run.runId} is a green with no full suite or no base`);
		const n = run.prs.length;
		return `test-batch-run ${run.runId}: green; PRs ${prs} merged onto ${sha7(run.base!)} in that order, final tree ${sha7(run.steps[n]!.tree)}; full ${run.full!.pass}/${run.full!.fail}/${run.full!.skip}; ${run.runDir ?? "no run dir"}`;
	}
	const what = run.reason !== null ? run.reason.replace(/\s+/g, " ").trim() : run.full !== null ? `full ${counts(run.full)}` : "no reason recorded";
	const attribution = run.attribution !== null ? `; attribution ${run.attribution}` : "";
	return `test-batch-run ${run.runId}: ${run.verdict}; PRs ${prs} onto ${run.base !== null ? sha7(run.base) : "unfetched main"}; ${what}${attribution}; ${run.runDir ?? "no run dir"}`;
}

// ---- bodies: test-batch-credit: -------------------------------------------------------------------

export interface TestBatchCredit {
	runId: string;
	pr: number;
	sha: string;
	/** M0. */
	base: string;
	/** This PR's 1-based step, of n. */
	step: number;
	n: number;
	/** Step n's tree: the tree the full suite passed. */
	finalTree: string;
}

/** `test-batch-credit: <run id> pr=<N> sha=<s> base=<M0> step=<k>/<n> final-tree=<t>` (plan § 4), on the PR's own workload. */
export function testBatchCreditBody(c: TestBatchCredit): string {
	need(isRunId(c.runId) && isPr(c.pr) && isSha(c.sha) && isSha(c.base) && isSha(c.finalTree), "a credit names a run, a PR, its sha, the base and the final tree");
	need(Number.isSafeInteger(c.step) && Number.isSafeInteger(c.n) && c.n >= TEST_BATCH_MIN && c.n <= TEST_BATCH_MAX && c.step >= 1 && c.step <= c.n, `${c.step}/${c.n} is not a batch step`);
	return `${TEST_BATCH_CREDIT_PREFIX} ${c.runId} pr=${c.pr} sha=${c.sha} base=${c.base} step=${c.step}/${c.n} final-tree=${c.finalTree}`;
}

export function parseTestBatchCredit(body: string): TestBatchCredit | null {
	const m = /^test-batch-credit: (tr-[a-z0-9]+) pr=([1-9]\d*) sha=([0-9a-f]{40}) base=([0-9a-f]{40}) step=([1-9]\d*)\/([1-9]\d*) final-tree=([0-9a-f]{40})$/.exec(body.trim());
	if (!m) return null;
	const [pr, step, n] = [Number(m[2]), Number(m[5]), Number(m[6])];
	if (!isPr(pr) || step > n || n < TEST_BATCH_MIN || n > TEST_BATCH_MAX) return null;
	return { runId: m[1]!, pr, sha: m[3]!, base: m[4]!, step, n, finalTree: m[7]! };
}

/** The credits the runner wrote on a workload, oldest first (launch.ts WRITERS: `test-runner` only). */
export function batchCredits(entries: readonly EntryRow[]): TestBatchCredit[] {
	return controlEntries(entries).flatMap((c) => {
		if (c.prefix !== "test-batch-credit") return [];
		const x = parseTestBatchCredit(c.body);
		return x ? [x] : [];
	});
}

/** The credits a green batch writes: one per PR whose head branch names a workload, on that workload. */
export function batchCreditsOf(run: TestBatchRun, ownWorkloads: readonly (string | null)[]): { workloadId: string; credit: TestBatchCredit }[] {
	need(run.verdict === "green" && run.base !== null && run.steps.length === run.prs.length + 1, `test-batch-run ${run.runId} is not a green with every step`);
	const n = run.prs.length;
	return run.prs.flatMap((p, i) => {
		const wl = ownWorkloads[i] ?? null;
		return wl === null ? [] : [{ workloadId: wl, credit: { runId: run.runId, pr: p.pr, sha: p.sha, base: run.base!, step: i + 1, n, finalTree: run.steps[n]!.tree } }];
	});
}

// ---- attribution: bisection over full-suite prefixes ----------------------------------------------

/** One probed step: the full suite at step k's commit, its counts. */
export interface Probe {
	step: number;
	verdict: "green" | "red";
	full: PartCounts;
}

export type AttributionOutcome =
	| { kind: "broken"; step: number; pr: number; probes: Probe[] }
	| { kind: "main-red"; probes: Probe[] }
	| { kind: "error"; reason: string; probes: Probe[] };

/**
 * The next step to probe, or the answer (plan § 4): step 0 (main alone) first; red there names no
 * PR. Otherwise binary search between step 0 (green) and step n (red, the batch's own run) for an
 * adjacent green→red pair, the probes taken in the order this function asked for them. A later PR
 * that repairs a break leaves the search on a real green→red step, not always the first.
 */
export function bisectNext(n: number, probes: readonly Pick<Probe, "step" | "verdict">[]): { probe: number } | { done: { kind: "main-red" } | { kind: "broken"; step: number } } {
	need(Number.isSafeInteger(n) && n >= 1, `${n} is not a step count`);
	const first = probes[0];
	if (first === undefined) return { probe: 0 };
	need(first.step === 0, "the first probe is step 0");
	if (first.verdict === "red") return { done: { kind: "main-red" } };
	let lo = 0;
	let hi = n;
	for (const p of probes.slice(1)) {
		need(p.step > lo && p.step < hi, `probe ${p.step} is outside ${lo}..${hi}`);
		if (p.verdict === "green") lo = p.step;
		else hi = p.step;
	}
	if (hi - lo === 1) return { done: { kind: "broken", step: hi } };
	return { probe: Math.floor((lo + hi) / 2) };
}

const counts = (p: PartCounts) => `${p.pass}/${p.fail}/${p.skip}`;

/** The outcome as one line: `broken by PR #k (step k of n; …)`, `main is already red at M0; no PR is named (…)`, `error: <reason>`. */
export function attributionText(o: AttributionOutcome): string {
	const probed = o.probes.length === 0 ? "" : `probed ${o.probes.map((p) => `step ${p.step} ${p.verdict} ${counts(p.full)}`).join(", ")}`;
	if (o.kind === "broken") return `broken by PR #${o.pr} at step ${o.step}: ${probed}`;
	if (o.kind === "main-red") return `main is already red at M0; no PR is named: ${probed}`;
	return `error: ${o.reason}${probed ? `; ${probed}` : ""}`;
}

export interface TestBatchAttribution {
	runId: string;
	batch: string;
	outcome: AttributionOutcome;
}

/** `test-batch-attribution: <new id> batch=<batch id> <outcome> {json}`: the outcome line, then its json (plan § 4). */
export function testBatchAttributionBody(a: TestBatchAttribution): string {
	const c = canonicalAttribution(a.runId, a.batch, a.outcome);
	need(c !== null, `test-batch-attribution ${a.runId} does not have the shape its body carries`);
	return `${TEST_BATCH_ATTRIBUTION_PREFIX} ${c!.runId} batch=${c!.batch} ${attributionText(c!.outcome)} ${JSON.stringify(c!.outcome)}`;
}

function canonicalAttribution(runId: unknown, batch: unknown, v: unknown): TestBatchAttribution | null {
	if (!isRunId(runId) || !isRunId(batch) || runId === batch || v === null || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	if (!Array.isArray(o.probes)) return null;
	const probes = o.probes.map((p) => {
		const x = p as Record<string, unknown> | null;
		const full = x !== null && typeof x === "object" ? partOf(x.full) : null;
		return full && nat(x!.step) && (x!.verdict === "green" || x!.verdict === "red") ? { step: x!.step as number, verdict: x!.verdict as Probe["verdict"], full } : null;
	});
	if (probes.some((p) => p === null)) return null;
	const ps = probes as Probe[];
	if (o.kind === "broken" && isPr(o.pr) && Number.isSafeInteger(o.step) && (o.step as number) >= 1) return { runId, batch, outcome: { kind: "broken", step: o.step as number, pr: o.pr, probes: ps } };
	if (o.kind === "main-red") return { runId, batch, outcome: { kind: "main-red", probes: ps } };
	if (o.kind === "error" && typeof o.reason === "string" && o.reason !== "" && !/[\n\r]/.test(o.reason)) return { runId, batch, outcome: { kind: "error", reason: o.reason, probes: ps } };
	return null;
}

export function parseTestBatchAttribution(body: string): TestBatchAttribution | null {
	const m = /^test-batch-attribution: (tr-[a-z0-9]+) batch=(tr-[a-z0-9]+) (.+?) (\{.*\})$/.exec(body.trim());
	if (!m) return null;
	let v: unknown;
	try {
		v = JSON.parse(m[4]!);
	} catch {
		return null;
	}
	const c = canonicalAttribution(m[1], m[2], v);
	// The line must be the json's own rendering: a hand-made line never reads as an outcome.
	return c !== null && attributionText(c.outcome) === m[3] ? c : null;
}

/** The attribution rows the runner wrote on a workload, oldest first. */
export function batchAttributions(entries: readonly EntryRow[]): TestBatchAttribution[] {
	return controlEntries(entries).flatMap((c) => {
		if (c.prefix !== "test-batch-attribution") return [];
		const x = parseTestBatchAttribution(c.body);
		return x ? [x] : [];
	});
}

/** The batch runs the runner wrote on a workload, oldest first, with each entry's id and time. */
export function batchRuns(entries: readonly EntryRow[]): (TestBatchRun & { entryId: string; createdAt: string })[] {
	return controlEntries(entries).flatMap((c) => {
		if (c.prefix !== "test-batch-run") return [];
		const x = parseTestBatchRun(c.body);
		return x ? [{ ...x, entryId: c.id, createdAt: c.createdAt }] : [];
	});
}

/** The batch requests the runner wrote on a workload, oldest first. */
export function batchRequests(entries: readonly EntryRow[]): (TestBatchRequested & { entryId: string; createdAt: string })[] {
	return controlEntries(entries).flatMap((c) => {
		if (c.prefix !== "test-batch-requested") return [];
		const x = parseTestBatchRequested(c.body);
		return x ? [{ ...x, entryId: c.id, createdAt: c.createdAt }] : [];
	});
}

/** A batch's dead-runner settle (as `runnerDiedRun` for a single run): `error`, reason `runner died`, nothing built or run. */
export function batchRunnerDiedRun(request: TestBatchRequested, runDir: string | null = null): TestBatchRun {
	return {
		runId: request.runId, verdict: "error", base: null, prs: request.prs, steps: [], full: null, failures: [], attribution: null, reason: "runner died",
		headsAtEnd: null, runDir, preflight: null,
	};
}

/**
 * The batches on a workload whose runner died, oldest first (as `reservation`'s settleDead for single
 * runs, § 2.2 step 3): a `test-batch-requested:` with no `test-batch-run:` of its own that `runLive`
 * calls dead, its heartbeat file 60 s old or, before its first heartbeat, its request 120 s old. A
 * batch's heartbeat runs from its start, through its wait in the queue, to its result.
 */
export function deadBatches(
	entries: readonly EntryRow[], heartbeatOf: (runId: string) => number | null, nowMs: number,
): (TestBatchRequested & { entryId: string; createdAt: string })[] {
	const settled = new Set(batchRuns(entries).map((r) => r.runId));
	return batchRequests(entries).filter((r) => !settled.has(r.runId) && !runLive({ settled: false, requestedAtMs: Date.parse(r.createdAt), heartbeatAtMs: heartbeatOf(r.runId) }, nowMs));
}

// ---- the attribution reader (plan § 4, review rounds 5 to 7) ----------------------------------------

/** A queue row with its run's heartbeat file read (null when it has none or it does not parse). */
export type QueueRowLive = Admission & { heartbeatAt: number | null };
export type AttributionState =
	| { state: "running"; id: string; where: "queued" | "holding the lock" }
	| { state: "done"; id: string; outcome: AttributionOutcome }
	| { state: "lost"; id: string };

/**
 * Where a red batch's attribution stands, from one snapshot of runs.db (the queue rows and the lock
 * row, read in one SQLite read transaction) and the workload's attribution rows. The outcome once
 * the attribution row exists; `running` while the new id has a live queue row (`runLive` over its
 * heartbeat file) or holds the lock row with a heartbeat the stale-holder rule still accepts; `lost`
 * otherwise: the batch died before its queue row, the row's runner never came, or the attribution
 * runner died. Null for a result that names no attribution.
 */
export function batchAttribution(
	result: Pick<TestBatchRun, "runId" | "attribution">, queueRows: readonly QueueRowLive[], lock: { runId: string; heartbeatAt: number } | null,
	attributionRows: readonly TestBatchAttribution[], nowMs: number,
): AttributionState | null {
	const id = result.attribution;
	if (id === null) return null;
	const row = attributionRows.find((a) => a.runId === id && a.batch === result.runId);
	if (row) return { state: "done", id, outcome: row.outcome };
	const queued = queueRows.find((q) => q.runId === id);
	if (queued && runLive({ settled: false, requestedAtMs: queued.admittedAt, heartbeatAtMs: queued.heartbeatAt }, nowMs)) return { state: "running", id, where: "queued" };
	if (lock && lock.runId === id && !lockHolderStale(lock.heartbeatAt, nowMs)) return { state: "running", id, where: "holding the lock" };
	return { state: "lost", id };
}

/** The reader's state as Jo reads it: `attribution: running (tr-…, queued)`, `attribution: lost (tr-… never ran)`, `attribution: broken by PR #k …`. */
export function attributionStateText(s: AttributionState): string {
	if (s.state === "running") return `attribution: running (${s.id}, ${s.where})`;
	if (s.state === "lost") return `attribution: lost (${s.id} never ran); run test-batch again for attribution`;
	return `attribution: ${attributionText(s.outcome)}`;
}

// ---- impure: the snapshot of runs.db, and the surface's exec of the starter -----------------------

/** A run's heartbeat file under the runs root, read now; null when it has none or it does not parse. */
export function heartbeatFileOf(root: string, runId: string): number | null {
	try {
		return parseHeartbeat(readFileSync(join(runDirOf(root, runId), "heartbeat"), "utf8"), runId);
	} catch {
		return null;
	}
}

/**
 * The lock row and the queue rows of `<root>/runs.db` in ONE read transaction (plan § 4, review
 * round 7): an acquisition commits the queue-row delete and the holder install together, so this
 * snapshot sees the run queued or holding, never neither. The lock row is read first; `between`
 * (tests only) runs between the two reads, inside the transaction. Each queue row then gets its
 * heartbeat file. A runs root with no runs.db, or one without the tables yet, is an empty snapshot.
 */
export function readRunsSnapshot(root: string, between?: () => void): { queue: QueueRowLive[]; lock: { runId: string; heartbeatAt: number } | null } {
	const path = runsDbOf(root);
	if (!existsSync(path)) return { queue: [], lock: null };
	const db = new Database(path, { readonly: true, strict: true });
	try {
		db.exec("PRAGMA busy_timeout = 2000");
		let read: { lock: { runId: string; heartbeatAt: number } | null; queue: Admission[] };
		try {
			read = db.transaction(() => {
				const lock = db.query<{ runId: string; heartbeatAt: number }, []>("SELECT runId, heartbeatAt FROM lock WHERE id = 1").get();
				between?.();
				const queue = db.query<Admission, []>("SELECT seq, runId, admittedAt FROM queue ORDER BY seq").all();
				return { lock, queue };
			}).deferred();
		} catch (e) {
			if (e instanceof Error && /no such table/.test(e.message)) return { queue: [], lock: null };
			throw e;
		}
		return { lock: read.lock, queue: read.queue.map((q) => ({ ...q, heartbeatAt: heartbeatFileOf(root, q.runId) })) };
	} finally {
		db.close();
	}
}

/** A workload's newest batch result and where its attribution stands. */
export interface NewestBatchAttribution {
	run: TestBatchRun & { entryId: string };
	state: AttributionState;
}

/**
 * The newest batch on a workload with its attribution state read from runs.db now; null when the
 * newest batch result names no attribution. `entriesNow` reads the workload's entries afresh each
 * call: once to see whether runs.db is needed at all, and again after the snapshot.
 */
export function newestBatchAttribution(root: string, entriesNow: () => readonly EntryRow[], nowMs: number, between?: () => void): NewestBatchAttribution | null {
	const pending = (entries: readonly EntryRow[]): { run: TestBatchRun & { entryId: string }; rows: TestBatchAttribution[] } | null => {
		const newest = batchRuns(entries).at(-1);
		if (!newest || newest.attribution === null) return null;
		// A batch requested after this result supersedes it: its own result speaks.
		if (batchRequests(entries).some((r) => r.createdAt > newest.createdAt && r.runId !== newest.runId)) return null;
		return { run: newest, rows: batchAttributions(entries) };
	};
	const first = pending(entriesNow());
	if (first === null) return null;
	if (first.rows.some((a) => a.runId === first.run.attribution)) return { run: first.run, state: batchAttribution(first.run, [], null, first.rows, nowMs)! };
	// runs.db first, then the ledger (review r1 finding 4): the runner commits its attribution row before it removes its lock or
	// queue row, so when this snapshot shows no live run, a ledger read made after it holds the row, or the run is truly lost.
	const snap = readRunsSnapshot(root, between);
	const after = pending(entriesNow());
	if (after === null) return null;
	return { run: after.run, state: batchAttribution(after.run, snap.queue, snap.lock, after.rows, nowMs)! };
}

/**
 * The surface's half of Jo's word (plan § 4): exec `test-runner.ts start-batch <wl> <instruction id>`
 * with a 30 s timeout and return its one line. Nothing else reaches the starter.
 */
export async function startBatch(exec: NonNullable<SurfaceAPI["exec"]> | undefined, workloadId: string, instructionId: string): Promise<string> {
	if (!exec) return `the host has no exec for extensions, so the batch did not start; start it by hand with \`bun ${TEST_RUNNER_SCRIPT} start-batch ${workloadId} ${instructionId}\``;
	try {
		const r = await exec("bun", [TEST_RUNNER_SCRIPT, "start-batch", workloadId, instructionId], { timeout: START_BATCH_TIMEOUT_MS });
		const lastOf = (s: string) => s.trim().split("\n").filter(Boolean).at(-1) ?? null;
		if (r.code === 0 && !r.killed) return lastOf(r.stdout) ?? "the starter exited 0 without a line";
		const line = lastOf(r.stderr) ?? lastOf(r.stdout) ?? (r.killed ? "the starter was killed before it printed" : `the starter exited ${r.code} without a line`);
		const how = r.killed ? `the starter did not return within ${START_BATCH_TIMEOUT_MS / 1000} s and was killed` : `starter exit ${r.code}`;
		return `no batch started (${how}): ${line}`;
	} catch (err) {
		return `no batch started: the starter could not be run: ${String(err)}`;
	}
}

// ---- the message to the orchestrator ----------------------------------------------------------------

export interface TestBatchResult {
	workloadId: string;
	runId: string;
	text: string;
}

/** `test-batch-result: <wl> <run id> <text>`: every batch outcome and every attribution outcome sends the orchestrator one line (plan § 4). */
export function testBatchResultBody(r: TestBatchResult): string {
	need(/^wl-\S+$/.test(r.workloadId) && isRunId(r.runId), "a batch result names its workload and run");
	const text = r.text.replace(/\s+/g, " ").trim();
	need(text !== "", "a batch result says something");
	return `${TEST_BATCH_RESULT_PREFIX} ${r.workloadId} ${r.runId} ${text}`;
}

export function parseTestBatchResult(body: string): TestBatchResult | null {
	const m = /^test-batch-result: (wl-\S+) (tr-[a-z0-9]+) (\S.*)$/.exec(body.trim());
	return m ? { workloadId: m[1]!, runId: m[2]!, text: m[3]! } : null;
}

/**
 * The batch's line: `batch tr-… green: PRs #12, #15 onto <M0>, full p/f/s; credit on …`, or the red/stale/error with its reason.
 * `credited` is null when the PRs' head branches could not be read from gh at the end, so no credit was written.
 */
export function batchResultText(run: TestBatchRun, credited: readonly number[] | null = []): string {
	const what = `batch ${run.runId} of PRs ${prList(run.prs.map((p) => p.pr))}`;
	if (run.verdict === "green") {
		const credit = credited === null
			? "; the PRs' head branches could not be read from gh, so no credit was written"
			: credited.length > 0 ? `; credit written for ${prList(credited)}` : "; no PR's head branch names a workload, so no credit";
		return `${what} green onto ${sha7(run.base!)}: full ${counts(run.full!)}${credit}`;
	}
	if (run.verdict === "red" && run.reason === null) {
		const first = run.failures[0]?.name;
		const attribution = run.attribution ? `; attribution ${run.attribution} queued` : "";
		return `${what} red: full ${counts(run.full!)}${first ? `, first ${first}` : ""}${attribution}`;
	}
	return `${what} ${run.verdict}: ${run.reason ?? "no reason recorded"}`;
}
