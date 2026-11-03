/**
 * Main state and the merge gate (PLAN wl-mvq4edbaf13vnk § 2 "Main state", "Attempts", "The merge gate"; D2; requirements
 * R3 to R6). Pure rules over ledger rows and a chain of main commits; `ghMainChain` is the one GitHub read, and it decides
 * nothing.
 */
import type { EntryRow } from "../../ledger/src/index";
import { testReach, type ReadFile } from "./fast-set";
import { controlEntries } from "./launch";
import { type ExecCounts, parseTestRun, type ResultRecord, type TestHost, type TestRun, type TestScope, type TestVerdict } from "./test-run";

/** A main run is believable with an executed test in at least this share of the tree's Bun test files (§ 2 Main state). */
export const BELIEVE_FILES = 0.95;
/** …and an executed-test count at least this share of the last green main run's (§ 2 Main state). */
export const BELIEVE_TESTS = 0.8;
/** The oldest suspect may have landed at most this long ago before main is unknown (§ 2 Main state). */
export const SUSPECT_MAX_MS = 40 * 60_000;
/** Landing is open with at most this many suspects (k ≤ 2, § 2 Main state). */
export const OPEN_MAX_SUSPECTS = 2;
/** Inconclusive attempts per block (§ 2 Attempts). */
export const ATTEMPTS_PER_BLOCK = 3;
/** `ghMainChain` reads at most this many first-parent commits (D2). */
export const CHAIN_MAX = 10;

/** A commit's verdict: its first conclusive main run (§ 2 Main state). It never changes. */
export type MainVerdictKind = "green" | "red" | "implausible";
export interface MainVerdict {
	sha: string;
	verdict: MainVerdictKind;
	runId: string;
	/** The run's executed tests, the next believability check's baseline when this verdict is green; null without exec counts. */
	tests: number | null;
	/** The settle's ledger time. */
	at: string;
}

/** One first-parent main commit as `ghMainChain` reads it. */
export interface ChainCommit {
	sha: string;
	tree: string;
	/** The commit's committer date (when it landed on main), ISO. */
	date: string;
	/** The PRs GitHub associates with the commit (`commits/<sha>/pulls`), ascending. */
	prs: number[];
}

/**
 * Believable (§ 2 Main state): executed tests in at least 95 % of the tree's Bun test files, and an executed-test count at
 * least 80 % of the last green main run's (no baseline before the first green). The tree's files leave out
 * `testRunner.mainSkip` (countedTestFiles), the files `_as2test` can never run. No exec counts, or a tree with no test
 * files, is never believable.
 */
export function believable(exec: ExecCounts | null, lastGreenTests: number | null): boolean {
	if (exec === null || exec.treeFiles === 0) return false;
	if (exec.files < BELIEVE_FILES * exec.treeFiles) return false;
	return lastGreenTests === null || exec.tests >= BELIEVE_TESTS * lastGreenTests;
}

/** A main run's verdict kind: green (believable or implausible), red (a red or red-main), or null when it is inconclusive. */
function conclusive(run: TestRun, lastGreenTests: number | null): MainVerdictKind | null {
	if (run.verdict === "green") return believable(run.exec, lastGreenTests) ? "green" : "implausible";
	if (run.verdict === "red" || run.verdict === "red-main") return "red";
	return null;
}

/** The inconclusive verdicts of a main run (§ 2: error, stale, runner died, which settles as error). */
export const INCONCLUSIVE: readonly TestVerdict[] = ["error", "stale", "superseded"];

/**
 * Every main commit's verdict from the runner's main-run results, oldest first in ledger order (`main` runs only; others are
 * skipped): each commit's first conclusive run, judged for believability against the newest green verdict before it. A later
 * run of a commit that has a verdict changes nothing, so nothing launders a red.
 */
export function mainVerdicts(results: readonly ResultRecord[]): Map<string, MainVerdict> {
	const out = new Map<string, MainVerdict>();
	let lastGreenTests: number | null = null;
	for (const r of results) {
		if (!r.main || out.has(r.sha)) continue;
		const verdict = conclusive(r, lastGreenTests);
		if (verdict === null) continue;
		const tests = r.exec?.tests ?? null;
		out.set(r.sha, { sha: r.sha, verdict, runId: r.runId, tests, at: r.createdAt });
		if (verdict === "green") lastGreenTests = tests;
	}
	return out;
}

/** A commit's attempt block (§ 2 Attempts): the inconclusive attempts in its current block and whether the block is exhausted. */
export interface AttemptBlock {
	/** 1 for the first block; each `main-retry:` newer than an exhausted block's last attempt opens the next. */
	block: number;
	attempts: number;
	exhausted: boolean;
}

/**
 * The runner's main-run results among a workload's entries, oldest first: each `test-run:` the runner wrote (`controlEntries`
 * drops any other writer) whose body parses and is a main run. A main run names no PR, so no request is matched here.
 */
export function mainResults(entries: readonly EntryRow[]): ResultRecord[] {
	const out: ResultRecord[] = [];
	for (const c of controlEntries(entries)) {
		if (c.prefix !== "test-run") continue;
		const r = parseTestRun(c.body);
		if (r !== null && r.main) out.push({ ...r, entryId: c.id, createdAt: c.createdAt });
	}
	return out;
}

/** The runner's preflight record (D5): ok, or refused with a reason; its bundle's `SOURCE` commit and its own repository root. */
export interface RunnerPreflight {
	ok: boolean;
	/** Why it refused; null when ok. */
	reason: string | null;
	source: string;
	root: string;
}
/** `runner-preflight: ok source <sha> root <path>` or `runner-preflight: refused <reason> source <sha> root <path>`, the runner's alone (TEST_RUNNER_BY). */
export function runnerPreflightBody(p: RunnerPreflight): string {
	if (!isSha(p.source)) throw new Error(`runner-preflight: ${p.source} is not a full sha`);
	if (!p.root.startsWith("/") || /[\n\r]/.test(p.root)) throw new Error(`runner-preflight: ${p.root} is not an absolute path on one line`);
	const reason = p.ok ? null : (p.reason ?? "").replace(/\s+/g, " ").trim();
	if (reason === "") throw new Error("runner-preflight: a refused preflight names its reason");
	return `runner-preflight: ${p.ok ? "ok" : `refused ${reason}`} source ${p.source} root ${p.root}`;
}
const PREFLIGHT_RE = /^runner-preflight: (?:ok|refused (\S.*?)) source ([0-9a-f]{40}) root (\/.*)$/;
export function parseRunnerPreflight(body: string): RunnerPreflight | null {
	const m = PREFLIGHT_RE.exec(body.trim());
	if (!m) return null;
	return { ok: m[1] === undefined, reason: m[1] ?? null, source: m[2]!, root: m[3]! };
}

/** A verified control root: a release directory under `~/.agent-system-2/verified/` (`current` or `<G 12>`), § 2 Protect the verifier. */
const VERIFIED_ROOT_RE = /\/\.agent-system-2\/verified\/[^/]+\/?$/;

/**
 * Why § 2's bootstrap does not hold yet, read from the standing workload's entries: every reason, empty when it holds. It
 * holds when a G exists (a green believable main verdict), and the runner's newest `runner-preflight:` says ok, with its
 * bundle's `SOURCE` a verified commit (so the tag and `current` name one and the helper fetched the tag) and its root a
 * verified control root. `land-first <repo> on` is refused while any reason stands.
 */
export function bootstrapRefusal(entries: readonly EntryRow[]): string[] {
	const verdicts = mainVerdicts(mainResults(entries));
	const reasons: string[] = [];
	if (![...verdicts.values()].some((v) => v.verdict === "green")) reasons.push("no verified commit yet: no main run has a green, believable verdict (shadow mode yields the first)");
	const rows = controlEntries(entries).filter((c) => c.prefix === "runner-preflight");
	const newest = rows.at(-1);
	const pre = newest === undefined ? null : parseRunnerPreflight(newest.body);
	if (newest === undefined) reasons.push("the runner has written no runner-preflight row yet");
	else if (pre === null) reasons.push(`the runner's newest runner-preflight row ${newest.id} does not parse`);
	else {
		if (!pre.ok) reasons.push(`the runner's newest preflight ${newest.id} refused: ${pre.reason}`);
		if (verdicts.get(pre.source)?.verdict !== "green") reasons.push(`the runner's bundle SOURCE ${sha7(pre.source)} (preflight ${newest.id}) is not a verified commit`);
		if (!VERIFIED_ROOT_RE.test(pre.root)) reasons.push(`the runner's root ${pre.root} (preflight ${newest.id}) is not a verified control root under ~/.agent-system-2/verified/`);
	}
	return reasons;
}
/**
 * The current attempt block of main commit `sha` (§ 2 Attempts): its inconclusive main runs count in blocks of 3, and an
 * exhausted block stays exhausted until a `main-retry:` entry for the repository strictly newer than its last attempt.
 * `retries` are those entries' ledger times; a retry while the block is not exhausted opens nothing.
 */
export function attemptBlock(sha: string, results: readonly ResultRecord[], retries: readonly string[]): AttemptBlock {
	const attempts = results.filter((r) => r.main && r.sha === sha && INCONCLUSIVE.includes(r.verdict)).map((r) => Date.parse(r.createdAt));
	const opens = retries.map((at) => Date.parse(at));
	// Merged in time order; at a tie the retry goes first, so it is not newer than that attempt.
	const events = [...opens.map((at) => ({ at, retry: true })), ...attempts.map((at) => ({ at, retry: false }))].sort((a, b) => a.at - b.at || Number(b.retry) - Number(a.retry));
	let block = 1;
	let count = 0;
	for (const e of events) {
		if (!e.retry) count++;
		else if (count >= ATTEMPTS_PER_BLOCK) {
			block++;
			count = 0;
		}
	}
	return { block, attempts: count, exhausted: count >= ATTEMPTS_PER_BLOCK };
}

export interface Suspect extends ChainCommit {
	verdict: MainVerdict | null;
	/** The newest main run of this commit, whatever its verdict; null when it has none. */
	lastRun: ResultRecord | null;
}
/** Why landing is stopped: a regression (red), infrastructure (unknown), or only too many suspects. */
export type StopKind = "regression" | "infrastructure" | "depth";
export interface MainState {
	tip: string;
	/** The verified commit: the newest first-parent commit whose verdict is green and believable; null when the chain holds none. */
	g: string | null;
	/** The first-parent commits after G up to the tip, oldest first. */
	suspects: Suspect[];
	k: number;
	red: boolean;
	unknown: boolean;
	open: boolean;
	stop: StopKind | null;
	/** Every reason landing is stopped, red ones first; empty when open. */
	reasons: string[];
	/** When the oldest suspect landed, ms; null with no suspects. */
	oldestMs: number | null;
}

const sha7 = (s: string) => s.slice(0, 7);

/**
 * Main state at the tip (§ 2 Main state). `chain` is `ghMainChain`'s answer, newest first (the tip first, back to G or
 * `CHAIN_MAX` commits); `results` the runner's results, oldest first. Red when a suspect's verdict is red or implausible;
 * unknown when not red and a suspect has an inconclusive main run with no verdict, the oldest suspect landed over 40 minutes
 * before `nowMs`, or the chain holds no G; open when neither and k ≤ 2. Every reason is named.
 */
export function mainState(chain: readonly ChainCommit[], results: readonly ResultRecord[], nowMs: number): MainState {
	if (chain.length === 0) throw new Error("mainState: the chain of main commits is empty; ghMainChain returns at least the tip");
	const verdicts = mainVerdicts(results);
	const gAt = chain.findIndex((c) => verdicts.get(c.sha)?.verdict === "green");
	const g = gAt < 0 ? null : chain[gAt]!.sha;
	const suspects: Suspect[] = chain.slice(0, gAt < 0 ? chain.length : gAt).reverse().map((c) => ({
		...c, verdict: verdicts.get(c.sha) ?? null, lastRun: results.filter((r) => r.main && r.sha === c.sha).at(-1) ?? null,
	}));
	const redReasons: string[] = [];
	const unknownReasons: string[] = [];
	for (const s of suspects) {
		if (s.verdict !== null && s.verdict.verdict !== "green") redReasons.push(`${sha7(s.sha)} is ${s.verdict.verdict} (run ${s.verdict.runId})`);
		if (s.verdict === null && s.lastRun !== null && INCONCLUSIVE.includes(s.lastRun.verdict)) {
			unknownReasons.push(`${sha7(s.sha)} has an inconclusive main run ${s.lastRun.runId} (${s.lastRun.verdict}${s.lastRun.reason ? `: ${s.lastRun.reason}` : ""}) and no verdict`);
		}
	}
	const oldestMs = suspects.length === 0 ? null : Date.parse(suspects[0]!.date);
	if (oldestMs !== null && !Number.isFinite(oldestMs)) throw new Error(`mainState: suspect ${suspects[0]!.sha} has no readable date (${suspects[0]!.date})`);
	if (oldestMs !== null && nowMs - oldestMs > SUSPECT_MAX_MS) {
		unknownReasons.push(`oldest suspect ${sha7(suspects[0]!.sha)} landed ${Math.floor((nowMs - oldestMs) / 60_000)} minutes ago, over ${SUSPECT_MAX_MS / 60_000}`);
	}
	if (g === null) unknownReasons.push(`no verified commit in the ${chain.length} newest first-parent commits`);
	const red = redReasons.length > 0;
	const unknown = !red && unknownReasons.length > 0;
	const k = suspects.length;
	const deep = k > OPEN_MAX_SUSPECTS;
	const reasons = [...redReasons, ...unknownReasons, ...(deep ? [`${k} suspects, over ${OPEN_MAX_SUSPECTS}`] : [])];
	const open = !red && !unknown && !deep;
	const stop: StopKind | null = red ? "regression" : unknown ? "infrastructure" : deep ? "depth" : null;
	return { tip: chain[0]!.sha, g, suspects, k, red, unknown, open, stop, reasons, oldestMs };
}

/** The check a head passed or failed: the newest result at the head, what the change requires, and the repair it is. */
export interface GateFacts {
	head: string;
	/** X contains the tip T (the PR has current main merged in). */
	containsTip: boolean;
	state: MainState;
	/** What X must pass while landing is open: the fast check, or the full suite (an exception or production stakes). */
	need: "fast" | "full";
	/** The newest result at X, null when none. */
	result: (Pick<TestRun, "verdict" | "sha"> & { scope: TestScope; host: TestHost }) | null;
	/** X is the incident's designated revert or named fix; null otherwise. A non-tree revert needs a full Mac green. */
	repair: "revert" | "fix" | null;
	/** A designated revert's tree equals G's tree (a distinct carry, no run); false for a partial revert. */
	treeEqualsG: boolean;
}
export type GateDecision = { state: "success"; description: string } | { state: "failure"; reasons: string[] };

/** X's result is a full-suite green on the Mac at X. */
const fullGreenAt = (f: GateFacts): boolean => f.result !== null && f.result.sha === f.head && f.result.verdict === "green" && f.result.scope === "full" && f.result.host === "mac";

/**
 * The merge gate (§ 2 The merge gate): success on X only when X contains T and either landing is open and X passed its check
 * (a fast or full green at X for `fast`, a full Mac green for `full`), or landing is stopped and X is the incident's one
 * repair (a revert whose tree equals G's, or a partial revert or named fix with a full Mac green). Anything else is failure naming every reason;
 * a red-main is a failure.
 */
export function mergeGate(f: GateFacts): GateDecision {
	const reasons: string[] = [];
	if (!f.containsTip) reasons.push(`head ${sha7(f.head)} does not contain main's tip ${sha7(f.state.tip)}; merge main in`);
	const r = f.result !== null && f.result.sha === f.head ? f.result : null;
	if (f.state.open) {
		if (r === null) reasons.push(`no ${f.need} check result at ${sha7(f.head)}`);
		else if (r.verdict === "red-main") reasons.push(`${sha7(f.head)} is red-main: its failures also fail on main`);
		else if (r.verdict !== "green") reasons.push(`${sha7(f.head)}'s ${r.scope} check is ${r.verdict}`);
		else if (f.need === "full" && !fullGreenAt(f)) reasons.push(`${sha7(f.head)} needs the full suite on the Mac before merge; its green is ${r.scope} on ${r.host}`);
		if (reasons.length > 0) return { state: "failure", reasons };
		return { state: "success", description: f.need === "full" || r!.scope === "full" ? "full suite green" : "fast check green" };
	}
	reasons.push(`landing stopped (${f.state.stop}): ${f.state.reasons.join("; ")}`);
	if (f.repair === "revert" && !f.treeEqualsG && !fullGreenAt(f)) reasons.push(`the partial revert ${sha7(f.head)} has no full-suite green on the Mac at its head`);
	if (f.repair === "fix" && !fullGreenAt(f)) reasons.push(`the fix ${sha7(f.head)} has no full-suite green on the Mac at its head`);
	if (f.repair === null) reasons.push(`${sha7(f.head)} is not the incident's repair`);
	const repaired = (f.repair === "revert" && (f.treeEqualsG || fullGreenAt(f))) || (f.repair === "fix" && fullGreenAt(f));
	if (f.containsTip && repaired) return {
		state: "success", description: f.repair === "fix" ? "repair: fix, full suite green"
			: f.treeEqualsG ? "repair: revert to G's tree" : "repair: partial revert, full suite green",
	};
	return { state: "failure", reasons };
}

/**
 * Attribution (§ 2, D2): each suspect whose change reaches a failing test file, with those files; a suspect reaching none is
 * left out. `diffs` holds each suspect's changed files; `tree` is the failing commit's tracked files and reader. Failing files
 * may carry `./`.
 */
export function attribute(
	suspects: readonly string[], failingFiles: readonly string[], diffs: ReadonlyMap<string, readonly string[]>, tree: { files: readonly string[]; read: ReadFile },
): { sha: string; files: string[] }[] {
	const failing = new Set(failingFiles.map((p) => p.replace(/^\.\//, "")));
	const reachOf = testReach(tree.files, tree.read);
	const out: { sha: string; files: string[] }[] = [];
	for (const sha of suspects) {
		const changed = diffs.get(sha);
		if (changed === undefined) throw new Error(`attribute: no diff for suspect ${sha}; read every suspect's changed files first`);
		const files = reachOf(changed).filter((t) => failing.has(t));
		if (files.length > 0) out.push({ sha, files });
	}
	return out;
}

const field = (v: unknown, k: string): unknown => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined);
const isSha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);

/**
 * The first-parent chain from `tip` (D2), newest first: each commit's tree sha, committer date and associated PRs, ending at
 * the first commit in `stopAt` (G's candidates: the shas with a green verdict, inclusive), at a root commit, or after
 * `CHAIN_MAX` commits. It decides nothing; a failed call (ghJson throws) or a misshapen answer throws naming the call.
 */
export function ghMainChain(repo: string, tip: string, ghJson: (args: string[]) => unknown, stopAt: ReadonlySet<string>): ChainCommit[] {
	const out: ChainCommit[] = [];
	let sha: string | null = tip;
	while (sha !== null && out.length < CHAIN_MAX) {
		const path = `repos/${repo}/git/commits/${sha}`;
		const c = ghJson(["api", path]);
		const tree = field(field(c, "tree"), "sha");
		const date = field(field(c, "committer"), "date");
		const parents = field(c, "parents");
		if (field(c, "sha") !== sha || !isSha(tree) || typeof date !== "string" || !Number.isFinite(Date.parse(date)) || !Array.isArray(parents)) {
			throw new Error(`gh api ${path} returned an unexpected shape`);
		}
		const pullsPath = `repos/${repo}/commits/${sha}/pulls`;
		const pulls = ghJson(["api", pullsPath]);
		if (!Array.isArray(pulls)) throw new Error(`gh api ${pullsPath} returned an unexpected shape`);
		const prs = pulls.map((p) => field(p, "number"));
		if (!prs.every((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0)) throw new Error(`gh api ${pullsPath} returned a pull with no number`);
		out.push({ sha, tree, date, prs: [...prs].sort((a, b) => a - b) });
		if (stopAt.has(sha)) break;
		const first = parents.length === 0 ? null : field(parents[0], "sha");
		if (first !== null && !isSha(first)) throw new Error(`gh api ${path} returned a parent with no sha`);
		sha = first;
	}
	return out;
}
