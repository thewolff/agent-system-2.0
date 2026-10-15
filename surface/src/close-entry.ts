// The close tool's git path (decision 13; MIGRATION.md § "M7 follow-ups" items 11 and 12): the
// decision-log entry a close renders is committed on the workload's lane branch `wl/<id>`, never
// on the checkout's current branch, so local main moves only through Jo's merges. The branch is
// reached through the lane worktree that has it checked out, through a temporary worktree when no
// worktree has it, or cut from `origin/<default>` (local `<default>` only when the repo has no
// origin) when no local branch exists, so local unpushed commits never ride along. After the
// ledger close the branch is pushed (plain, no force) and an open PR is made sure of through `gh`.
// Every git and gh call goes through the extension API's exec with a timeout, never the bash tool;
// a failure is named in the result and never blocks the close.
//
// For a repository the test runner serves (the profile's `testRunner.repos`; MIGRATION.md item 24,
// PLAN § 2.4 item 4) the close first runs the close check, `closeCheck`: the PR set (every PR from
// `wl/<id>`, from a `push-dest:` branch, or named by a `test-requested:`, in any state, each through
// `gh pr list -R <owner/repo> --head <branch> --state all`), the authoritative result of each, and the
// local `wl/<id>` tip pinned as the candidate C with its code delta from `merge-base(origin/<default>,
// C)`; a head or candidate that is not a green S must descend from S through commits that each touch
// only `.ai/decision-log/`, read commit by commit with `git rev-list --parents` (never the net diff).
// A doc-merge green (plan wl-mv615mkeaf1yio § 3) is re-checked: the green sha's parents and origin's
// first-parent chain are re-read, and its basis must resolve in the workload's own runner records.
// A merged PR's batch credits (plan wl-mv615mkeaf1yio § 4) are read with their batch rows and
// origin's first-parent chain after each base.
// The decision is surface/src/test-run.ts `closeFreshness`; a merged PR whose authoritative non-green
// run Jo waived (`waivedRunOf`, PLAN wl-mv5i3lulwwbbi8 D3) passes it. A workload Jo superseded
// (`supersede <A> <B>`, D2) is decided by `supersededFreshness` instead: no open PR in the set and no
// bound branch with a commit origin's default lacks. Unlike the rest of this path it fails
// closed: when git or gh cannot answer, the close is refused. A passed check pins the publication:
// the entry commit D must be made, have the single parent C and touch only `.ai/decision-log/`, and
// it is pushed as `D:refs/heads/wl/<id>` by sha, a plain fast-forward.
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SCRATCH_ENTRY, scratchBase, scratchRootFor } from "../../gates/src/scratch";
import { homeDir, type InstructionRow, type Ledger, type QuestionRow } from "../../ledger/src/index";
import { renderClose } from "./decision-log";
import { ensureStandingWorkload, identityOf } from "./identity";
import { fileIdentity, removeChild } from "./scratch-remove";
import { branchName, holdersOf } from "./launch";
import { REPO_ROOT } from "./session";
import {
	authoritativeRun, boundBranches, type CloseCredit, type CloseDecision, type CloseFacts, type ClosePr, closeFreshness, type CompareResult, DECISION_LOG_DIR, type RangeCommit,
	type RunRecord, SHA_RE, servedRepo, type TestRunnerConfig, testRunnerConfig, testRuns,
} from "./test-run";
import { batchCredits, batchRunOf } from "./test-batch";
import { DECISION_LOG_ENV, STANDING_WORKLOAD_ID, SURFACE_BY, type SurfaceAPI } from "./types";

const LOCAL_MS = 15_000;
const COMMIT_MS = 30_000;
const NETWORK_MS = 60_000;

/**
 * The directory decision-log entries are read from for `repo` (the open tool's context) and the
 * close renders into when no lane branch can take the entry. `AGENT_SYSTEM_DECISION_LOG` overrides
 * it; an entry committed on the lane branch always lives under that worktree's `.ai/decision-log/`.
 */
export const logDirOf = (env: Record<string, string | undefined>, repo: string) => env[DECISION_LOG_ENV] || join(repo, ".ai", "decision-log");

type Exec = NonNullable<SurfaceAPI["exec"]>;
interface Run {
	code: number;
	out: string;
	err: string;
	killed: boolean;
	/** stdout untrimmed: `-z` path lists, where a path may begin or end with a space. */
	raw: string;
}

async function run(exec: Exec, command: string, args: string[], timeout: number, cwd?: string): Promise<Run> {
	try {
		const r = await exec(command, args, cwd === undefined ? { timeout } : { timeout, cwd });
		return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim(), killed: r.killed, raw: r.stdout };
	} catch (err) {
		return { code: -1, out: "", err: String(err instanceof Error ? err.message : err), killed: false, raw: "" };
	}
}
const git = (exec: Exec, dir: string, args: string[], timeout = LOCAL_MS) => run(exec, "git", ["-C", dir, ...args], timeout);
/** One line naming a failed command: `git push exited 1: <first line of its output>`. */
const failed = (what: string, r: Run) => `${what} ${r.killed ? "timed out" : `exited ${r.code}`}: ${(r.err || r.out || "no output").split("\n")[0]}`;
const sha7 = (s: string) => s.slice(0, 7);
const canonical = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

/** Where the entry is committed: the repo top, the lane branch, the worktree that has it checked out. */
interface Target {
	top: string;
	branch: string;
	worktree: string;
	/** The temporary worktree's parent directory, removed with it; null for the lane worktree. */
	tempDir: string | null;
	/** `refs/remotes/origin/HEAD`'s branch, else the checkout's current branch; null when neither resolves. */
	defaultBranch: string | null;
	origin: boolean;
	/** A failed `git fetch origin` before the branch was cut (recorded, not fatal). */
	fetch: string | null;
}

/** The worktree that has `refs/heads/<branch>` checked out, from `git worktree list --porcelain`. */
function worktreeOf(porcelain: string, branch: string): string | null {
	let path: string | null = null;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${branch}`) return path;
		else if (line === "") path = null;
	}
	return null;
}

/** Find, or create, the lane branch and a worktree on it; the reason when neither can be had. */
async function prepare(exec: Exec, repo: string, id: string): Promise<Target | string> {
	const topR = await git(exec, repo, ["rev-parse", "--show-toplevel"]);
	if (topR.code !== 0 || !topR.out) return `${repo} is not a git checkout (${failed("git rev-parse", topR)})`;
	const top = topR.out;
	const branch = branchName(id);
	const origin = (await git(exec, top, ["remote", "get-url", "origin"])).code === 0;
	const head = await git(exec, top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	let defaultBranch: string | null = head.code === 0 && head.out ? head.out.replace(/^origin\//, "") : null;
	if (defaultBranch === null) {
		const cur = await git(exec, top, ["rev-parse", "--abbrev-ref", "HEAD"]);
		defaultBranch = cur.code === 0 && cur.out && cur.out !== "HEAD" ? cur.out : null;
	}
	const target = { top, branch, defaultBranch, origin, fetch: null as string | null };
	const has = (await git(exec, top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
	if (has) {
		const list = await git(exec, top, ["worktree", "list", "--porcelain"]);
		if (list.code !== 0) return failed("git worktree list", list);
		const wt = worktreeOf(list.out, branch);
		if (wt !== null) {
			if (canonical(wt) === canonical(top)) return `${branch} is checked out in the checkout ${top} itself, and the close never commits in the checkout`;
			return { ...target, worktree: wt, tempDir: null };
		}
	} else {
		if (origin) {
			const f = await git(exec, top, ["fetch", "--quiet", "origin"], NETWORK_MS);
			if (f.code !== 0) target.fetch = failed("git fetch origin", f);
		}
		const commit = async (ref: string): Promise<string | null> => {
			const r = await git(exec, top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
			return r.code === 0 && r.out ? r.out : null;
		};
		let sha = origin ? await commit(`refs/remotes/origin/${branch}`) : null;
		if (sha === null) {
			if (defaultBranch === null) return `cannot cut ${branch}: the default branch of ${top} cannot be resolved`;
			// The remote default, never local main: Jo's local unpushed commits stay out of the lane branch.
			const base = origin ? `refs/remotes/origin/${defaultBranch}` : `refs/heads/${defaultBranch}`;
			sha = await commit(base);
			if (sha === null) return `cannot cut ${branch}: ${base} does not resolve${target.fetch ? ` (${target.fetch})` : ""}`;
		}
		// The sha, not the ref: no upstream is set from origin/<default>.
		const cut = await git(exec, top, ["branch", branch, sha]);
		if (cut.code !== 0) return failed(`git branch ${branch}`, cut);
	}
	const tempDir = mkdtempSync(join(tmpdir(), "as2-close-"));
	const worktree = join(tempDir, "wt");
	const add = await git(exec, top, ["worktree", "add", "--quiet", worktree, branch]);
	if (add.code !== 0) {
		rmSync(tempDir, { recursive: true, force: true });
		return failed("git worktree add", add);
	}
	return { ...target, worktree, tempDir };
}

/** Remove the temporary worktree; null when gone, else what was left. */
async function removeTemp(exec: Exec, t: Target): Promise<string | null> {
	if (t.tempDir === null) return null;
	const r = await git(exec, t.top, ["worktree", "remove", "--force", t.worktree]);
	rmSync(t.tempDir, { recursive: true, force: true });
	if (r.code === 0) return null;
	const prune = await git(exec, t.top, ["worktree", "prune"]);
	return prune.code === 0 ? null : `the temporary worktree ${t.worktree} was not removed (${failed("git worktree remove", r)})`;
}

/** Commit exactly `path` in the worktree; an entry identical to the branch's (a re-close) is not committed twice. */
async function commitPath(exec: Exec, wt: string, path: string, id: string): Promise<{ error: string | null; already: boolean }> {
	const slug = basename(path).replace(/\.md$/, "");
	const add = await git(exec, wt, ["add", "--", path]);
	if (add.code !== 0) return { error: failed("git add", add), already: false };
	const diff = await git(exec, wt, ["diff", "--cached", "--quiet", "HEAD", "--", path]);
	if (diff.code === 0) return { error: null, already: true };
	if (diff.code !== 1) return { error: failed("git diff --cached", diff), already: false };
	const commit = await git(exec, wt, ["commit", "-q", "-m", `docs: decision-log entry ${slug} (workload ${id})`, "--", path], COMMIT_MS);
	return { error: commit.code === 0 ? null : failed("git commit", commit), already: false };
}

export interface EntryCommit {
	/** Where the entry is: an absolute path when the file is on disk, else `<branch>:.ai/decision-log/<file>`; empty when `refused`. */
	path: string;
	/** The workload's lane branch `wl/<id>`: where the entry is committed, or is to be committed by hand when `commit` names a reason. */
	branch: string;
	/** Null when the entry is committed on `branch` (now or already); else why it was not (the file is untracked). */
	commit: string | null;
	/** The identical entry was already committed on the branch (a re-close after `stays open`). */
	already: boolean;
	/** Recorded failures that did not stop the commit: a failed fetch, a temporary worktree left behind. */
	notes: string[];
	/**
	 * For `publishEntry`: the repo top, its default branch, whether it has an origin; null when nothing was committed.
	 * Under a pin, `sha` is the commit to push by sha and `ownerRepo` the repo every `gh` call names with `-R`.
	 */
	publish: { top: string; defaultBranch: string | null; origin: boolean; sha: string | null; ownerRepo: string | null } | null;
	/** Under a pin: why the close must not go ahead (the branch moved after the close check, or the commit is not D on C); else null. */
	refused: string | null;
}

/** The close check's pin: the candidate C the commit must sit on, and the served repo's `owner/repo`. */
export interface ClosePin {
	sha: string;
	ownerRepo: string;
}

/** Under a pin, the entry commit D: its single parent is C, it touches only `.ai/decision-log/`, and the branch tip is D. Null when it holds. */
async function pinnedCommitFault(exec: Exec, top: string, branch: string, pin: string, d: string): Promise<string | null> {
	const parents = await git(exec, top, ["rev-list", "--parents", "-n", "1", d]);
	if (parents.code !== 0) return failed("git rev-list --parents", parents);
	const [, ...ps] = parents.out.split(/\s+/);
	if (ps.length !== 1 || ps[0] !== pin) return `the entry commit ${sha7(d)} has parent(s) ${ps.map(sha7).join(" ") || "none"}, not the checked ${sha7(pin)}: ${branch} moved during the commit`;
	const files = await git(exec, top, ["diff-tree", "-r", "--no-commit-id", "--name-only", "--no-renames", "-z", pin, d]);
	if (files.code !== 0) return failed("git diff-tree", files);
	const code = files.raw.split("\0").find((p) => p !== "" && !p.startsWith(DECISION_LOG_DIR));
	if (code !== undefined) return `the entry commit ${sha7(d)} touches ${code}, outside ${DECISION_LOG_DIR}`;
	const tip = await git(exec, top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
	if (tip.out !== d) return `${branch} is at ${sha7(tip.out) || "nothing"}, not the entry commit ${sha7(d)}: it moved during the commit`;
	return null;
}

/** Record the close receipt as the orchestrator's instruction row; the close does so in the transaction that closes the row, so a refused close leaves none. */
export function recordCloseReceipt(ledger: Ledger, id: string, receipt: string): string {
	return ledger.recordInstruction({ by: SURFACE_BY, workloadId: id, body: `close receipt: ${receipt}`, author: "orchestrator", channel: "surface" });
}

/** What became of a closed workload's scratch root (`removeScratchRoot`). */
export type ScratchRemoval = { kind: "removed" | "missing"; root: string } | { kind: "failed"; root: string; reason: string };

/**
 * Remove workload `id`'s scratch root once its close has committed (PLAN wl-mv5oikd5jtquww § 1.5): in-process, exactly
 * `scratchRootFor(home, id)`, refused when that path is a symlink or its realpath is not exactly `<realpath(base)>/<id>`;
 * the removal itself is `removeChild` (./scratch-remove: rename to `.removing-*`, identity re-checked, then removed), so an
 * ancestor swapped meanwhile never redirects it. A leftover `.removing-*` is never touched here (the sweep removes it).
 * A missing root is a no-op. Never throws.
 */
export function removeScratchRoot(home: string, id: string): ScratchRemoval {
	let root = join(scratchBase(home), id);
	try {
		root = scratchRootFor(home, id);
		try {
			if (lstatSync(root).isSymbolicLink()) return { kind: "failed", root, reason: "the root is a symlink" };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", root };
			throw err;
		}
		const physical = realpathSync.native(root);
		const base = realpathSync.native(scratchBase(home));
		const expected = `${base}/${id}`;
		if (physical !== expected) return { kind: "failed", root, reason: `the root resolves to ${physical}, not ${expected}` };
		const r = removeChild(base, id, fileIdentity(expected));
		if (r.kind === "removed") return { kind: "removed", root };
		return { kind: "failed", root, reason: r.kind === "refused" ? r.reason : r.error };
	} catch (err) {
		return { kind: "failed", root, reason: String(err instanceof Error ? err.message : err) };
	}
}

/**
 * After the ledger close: remove the workload's scratch root (`removeScratchRoot`, HOME from `env`) and record the outcome as
 * `scratch-removed: <id> <root>` or `scratch-remove-failed: <id> <root>: <reason>`. The closed workload takes no entries
 * (ledger/schema.sql `entries_insert_workload`), so the entry goes on the standing workload, as the surface. A missing root
 * writes nothing, and so does a HOME that cannot be resolved (ledger/src/locality.ts homeDir): no root can be named, and the
 * sentence says why. Never throws and never fails the close: returns the sentence the close result carries ("" for none).
 */
export function closeScratchRoot(ledger: Ledger, env: Record<string, string | undefined>, id: string): string {
	let home: string;
	try {
		home = homeDir(env);
	} catch (err) {
		return `Scratch root of ${id} not removed: ${String(err instanceof Error ? err.message : err)}.`;
	}
	const r = removeScratchRoot(home, id);
	if (r.kind === "missing") return "";
	const body = r.kind === "removed" ? `${SCRATCH_ENTRY.removed} ${id} ${r.root}` : `${SCRATCH_ENTRY.removeFailed} ${id} ${r.root}: ${r.reason}`;
	let entry: string;
	try {
		entry = ledger.write(() => {
			ensureStandingWorkload(ledger);
			return `entry ${ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body })} on ${STANDING_WORKLOAD_ID}`;
		});
	} catch (err) {
		entry = `its entry could not be written: ${String(err instanceof Error ? err.message : err)}`;
	}
	return r.kind === "removed" ? `Scratch root ${r.root} removed (${entry}).` : `Scratch root ${r.root} not removed: ${r.reason} (${entry}).`;
}

/** Carries a render out of the transaction it rolls back. */
class Rendered extends Error {
	constructor(readonly path: string) {
		super("rendered");
	}
}

/**
 * Render the workload's entry into `dir` as the ledger will read once the close records `receipt`.
 * The receipt row is written inside a transaction that the render then rolls back, so the entry
 * carries it while the ledger holds it only when the close goes through (`recordCloseReceipt`).
 */
function renderEntry(ledger: Ledger, id: string, dir: string, receipt: string | null): string {
	if (receipt === null) return renderClose(ledger, id, dir, identityOf(ledger)).path;
	try {
		ledger.write(() => {
			recordCloseReceipt(ledger, id, receipt);
			throw new Rendered(renderClose(ledger, id, dir, identityOf(ledger)).path);
		});
	} catch (err) {
		if (err instanceof Rendered) return err.path;
		throw err;
	}
	throw new Error("the receipt render returned without rolling back");
}

/**
 * Render the workload's decision-log entry and commit it on `wl/<id>`: in the lane worktree, in a
 * temporary worktree (removed on every path), or on a branch cut from origin's default. When no
 * branch or worktree can be had, or the commit fails in a temporary worktree, the entry is rendered
 * untracked into `logDirOf(env, repo)` with the reason; `git commit` never runs in the checkout.
 * Under a `pin` (a passed close check, PLAN § 2.4 item 4) the branch tip and the worktree's HEAD
 * must still be C before anything is rendered, and the commit must be D with parent C touching only
 * `.ai/decision-log/`; otherwise, a failed commit included, `refused` says why and nothing is
 * published. `receipt` is rendered into the entry and never recorded here (`renderEntry`).
 */
export async function commitCloseEntry(
	pi: SurfaceAPI, ledger: Ledger, env: Record<string, string | undefined>, id: string, repo: string, pin: ClosePin | null = null, receipt: string | null = null,
): Promise<EntryCommit> {
	const branch = branchName(id);
	const untracked = (reason: string, notes: string[] = []): EntryCommit => ({
		path: renderEntry(ledger, id, logDirOf(env, repo), receipt), branch, commit: reason, already: false, notes, publish: null, refused: null,
	});
	const refuse = (reason: string, notes: string[]): EntryCommit => ({ path: "", branch, commit: reason, already: false, notes, publish: null, refused: reason });
	if (!pi.exec) return pin ? refuse("the host has no exec for extensions", []) : untracked("the host has no exec for extensions");
	const exec = pi.exec.bind(pi);
	const t = await prepare(exec, repo, id);
	if (typeof t === "string") return pin ? refuse(t, []) : untracked(t);
	const notes = t.fetch ? [t.fetch] : [];
	let rendered = "";
	let c: { error: string | null; already: boolean };
	let head = "";
	let moved: string | null = null;
	try {
		if (pin) {
			const tip = await git(exec, t.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
			const wt = await git(exec, t.worktree, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
			if (tip.out !== pin.sha || wt.out !== pin.sha) {
				moved = `${branch} moved after the close check: it is at ${sha7(tip.out) || "nothing"}${wt.out !== tip.out ? ` (its worktree at ${sha7(wt.out) || "nothing"})` : ""}, not the checked ${sha7(pin.sha)}; close again to re-check`;
			}
		}
		if (moved === null) {
			rendered = renderEntry(ledger, id, join(t.worktree, ".ai", "decision-log"), receipt);
			c = await commitPath(exec, t.worktree, rendered, id);
			if (pin && c.error === null) head = (await git(exec, t.worktree, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).out;
		} else c = { error: moved, already: false };
	} catch (err) {
		rendered = "";
		c = { error: String(err instanceof Error ? err.message : err), already: false };
	} finally {
		const left = await removeTemp(exec, t);
		if (left) notes.push(left);
	}
	if (moved !== null) return refuse(moved, notes);
	if (c.error !== null) {
		// Under a pin a failed commit refuses: an unpinned, untracked entry would close a served repo with nothing published (review r1, kimi note 2).
		if (pin) return refuse(`the entry commit on ${branch} failed: ${c.error}${t.tempDir === null && rendered ? `; the rendered entry is left at ${rendered}` : ""}`, notes);
		// The lane worktree keeps the file; a temporary worktree took it with it, so render it where it can be committed by hand.
		if (t.tempDir === null && rendered) return { path: rendered, branch, commit: c.error, already: false, notes, publish: null, refused: null };
		return untracked(c.error, notes);
	}
	let sha: string | null = null;
	if (pin) {
		if (!SHA_RE.test(head)) return refuse(`the entry commit on ${branch} cannot be read back`, notes);
		const fault = c.already ? (head === pin.sha ? null : `${branch} is at ${sha7(head)}, not the checked ${sha7(pin.sha)}`) : await pinnedCommitFault(exec, t.top, branch, pin.sha, head);
		if (fault !== null) return refuse(fault, notes);
		sha = head;
	}
	const path = t.tempDir === null ? rendered : `${branch}:.ai/decision-log/${basename(rendered)}`;
	return {
		path, branch, commit: null, already: c.already, notes, refused: null,
		publish: { top: t.top, defaultBranch: t.defaultBranch, origin: t.origin, sha, ownerRepo: pin?.ownerRepo ?? null },
	};
}

export interface EntryPublish {
	/** Null when the push succeeded (`git push -u origin wl/<id>`, or under a pin `git push origin <D>:refs/heads/wl/<id>`); else why it was not pushed. */
	push: string | null;
	/** The open PR's url, or null. */
	pr: string | null;
	/** True when this close opened the PR. */
	prCreated: boolean;
	/** Why there is no PR url, ending in what to do by hand; null when `pr` is set. */
	prReason: string | null;
}

/**
 * Push the lane branch (plain, no force) and make sure an open PR exists from it: `gh pr list`
 * finds one, else `gh pr create` opens one against the default branch. That covers a lane PR
 * merged before the close and a workload that never had one. Failures are named, never thrown.
 * A pinned commit is pushed by sha, `<D>:refs/heads/wl/<id>`, never by branch name: a plain
 * fast-forward a remote that moved refuses; its `gh` calls name the repo with `-R`.
 */
export async function publishEntry(pi: SurfaceAPI, e: EntryCommit, id: string): Promise<EntryPublish> {
	const byHand = `open one from ${e.branch}`;
	if (e.publish === null) return { push: "nothing was committed", pr: null, prCreated: false, prReason: `nothing was committed; ${byHand}` };
	if (!pi.exec) return { push: "the host has no exec for extensions", pr: null, prCreated: false, prReason: `the host has no exec; ${byHand}` };
	const exec = pi.exec.bind(pi);
	const { top, defaultBranch, origin, sha, ownerRepo } = e.publish;
	if (!origin) return { push: `${top} has no origin remote`, pr: null, prCreated: false, prReason: `no origin remote; push ${e.branch} and ${byHand}` };
	const p = sha === null
		? await git(exec, top, ["push", "--quiet", "-u", "origin", e.branch], NETWORK_MS)
		: await git(exec, top, ["push", "--quiet", "origin", `${sha}:refs/heads/${e.branch}`], NETWORK_MS);
	const push = p.code === 0 ? null : failed("git push", p);
	const repoArgs = ownerRepo === null ? [] : ["-R", ownerRepo];
	const list = await run(exec, "gh", ["pr", "list", ...repoArgs, "--head", e.branch, "--state", "open", "--json", "url"], NETWORK_MS, top);
	if (list.code !== 0) return { push, pr: null, prCreated: false, prReason: `${failed("gh pr list", list)}; ${byHand}` };
	let open: { url?: string }[];
	try {
		open = JSON.parse(list.out || "[]") as { url?: string }[];
	} catch {
		return { push, pr: null, prCreated: false, prReason: `gh pr list printed no JSON (${list.out.split("\n")[0]}); ${byHand}` };
	}
	const url = Array.isArray(open) ? open.find((x) => typeof x?.url === "string")?.url : undefined;
	if (url) return { push, pr: url, prCreated: false, prReason: null };
	if (push !== null) return { push, pr: null, prCreated: false, prReason: `not pushed; ${byHand}` };
	if (defaultBranch === null) return { push, pr: null, prCreated: false, prReason: `the default branch of ${top} cannot be resolved; ${byHand}` };
	const title = `docs: decision-log entry ${basename(e.path).replace(/\.md$/, "")} (workload ${id})`;
	const body = `The decision-log entry rendered when workload ${id} closed, committed on its lane branch ${e.branch} by the orchestrator surface's close.`;
	const create = await run(exec, "gh", ["pr", "create", ...repoArgs, "--head", e.branch, "--base", defaultBranch, "--title", title, "--body", body], NETWORK_MS, top);
	if (create.code !== 0) return { push, pr: null, prCreated: false, prReason: `${failed("gh pr create", create)}; ${byHand}` };
	const created = create.out.split("\n").filter(Boolean).at(-1) ?? "";
	return created ? { push, pr: created, prCreated: true, prReason: null } : { push, pr: null, prCreated: false, prReason: `gh pr create printed no url; ${byHand}` };
}

// ---- the close check (PLAN § 2.4 item 4) ------------------------------------------------------------

/** Replaces the checkout's profile/config.yml as the source of the `testRunner:` block (tests; the starter honours the same variable). */
export const TEST_RUNNER_CONFIG_ENV = "AGENT_SYSTEM_TEST_RUNNER_CONFIG";

/** The `testRunner:` block from the checkout's profile/config.yml (or `$AGENT_SYSTEM_TEST_RUNNER_CONFIG`), as the starter reads it. */
export function loadTestRunnerConfig(env: Record<string, string | undefined>): { ok: true; config: TestRunnerConfig } | { ok: false; error: string } {
	const path = env[TEST_RUNNER_CONFIG_ENV]?.trim() || join(REPO_ROOT, "profile", "config.yml");
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { ok: false, error: `${path}: ${String(err instanceof Error ? err.message : err).split("\n")[0]}` };
	}
	const c = testRunnerConfig(doc);
	return c.ok ? c : { ok: false, error: `${path}: ${c.error}` };
}

export type CloseCheck =
	/** The repo is not one the runner serves (no origin, or an origin not in `testRunner.repos`): no check, no pin. */
	| { served: false }
	/** `pin` is set exactly when the decision closes. */
	| { served: true; decision: CloseDecision; pin: ClosePin | null };

type PrHead = Pick<ClosePr, "number" | "state" | "headRefName" | "headSha">;

/** A `gh pr list`/`gh pr view` record, or null when it does not have that shape. */
function prHeadOf(x: unknown, headRefName: string | null): PrHead | null {
	if (x === null || typeof x !== "object") return null;
	const o = x as Record<string, unknown>;
	const head = headRefName ?? o.headRefName;
	if (!Number.isSafeInteger(o.number) || (o.number as number) < 1 || (o.state !== "OPEN" && o.state !== "MERGED" && o.state !== "CLOSED")) return null;
	if (typeof o.headRefOid !== "string" || !SHA_RE.test(o.headRefOid) || typeof head !== "string" || head === "") return null;
	return { number: o.number as number, state: o.state as ClosePr["state"], headRefName: head, headSha: o.headRefOid };
}

/** Thrown inside the gather when git or gh cannot answer; the check refuses with its message. */
class Unanswered extends Error {}

/**
 * Up to `n` commits directly after `base` on `mainRef`'s first-parent chain, oldest first, each with
 * its tree and parents (`git log --first-parent --reverse <base>..<mainRef>`): what a batch credit's
 * landing is judged on (plan wl-mv615mkeaf1yio § 4). A base the clone does not have is no landing
 * (an empty chain); a git call that fails throws `Unanswered`, so the close refuses.
 */
export async function landedChain(exec: Exec, top: string, base: string, mainRef: string, n: number): Promise<CloseCredit["landed"]> {
	if ((await git(exec, top, ["cat-file", "-e", `${base}^{commit}`])).code !== 0) return [];
	const what = `git log --first-parent ${sha7(base)}..${mainRef}`;
	const r = await git(exec, top, ["log", "--first-parent", "--reverse", "--format=%H %T %P", `${base}..${mainRef}`]);
	if (r.code !== 0) throw new Unanswered(failed(what, r));
	return r.out.split("\n").filter((l) => l !== "").slice(0, n).map((line) => {
		const [sha = "", tree = "", ...parents] = line.split(" ");
		if (!SHA_RE.test(sha) || !SHA_RE.test(tree) || !parents.every((p) => SHA_RE.test(p))) throw new Unanswered(`${what} printed an unexpected line: ${line.slice(0, 120)}`);
		return { sha, tree, parents };
	});
}

/**
 * The run Jo waived for PR `pr` (PLAN wl-mv5i3lulwwbbi8 D3), or null. The run R is the PR's
 * authoritative run (its newest request, so no later request for the PR exists) with a non-green
 * result. A waiver is an instruction that is (a) an answer by author `jo` written by the surface,
 * (b) with the body `waive`, (c) answering — the question's resolver — a question on R's slice whose
 * options include `waive`, raised after R's result while R's request was the newest on that slice (any
 * PR), and (d) written after R's result. A lane cannot write as the surface, and a question binds only
 * the last run asked for on its slice, so a waiver never reaches another PR's run or a later one.
 */
export function waivedRunOf(records: readonly RunRecord[], pr: number, questions: readonly QuestionRow[], instructions: readonly InstructionRow[]): string | null {
	const run = authoritativeRun(records, pr);
	const result = run?.result ?? null;
	if (run === null || result === null || result.verdict === "green") return null;
	const slice = run.request.slice;
	const offersWaive = (q: QuestionRow): boolean => {
		try {
			const o: unknown = JSON.parse(q.options);
			return Array.isArray(o) && o.includes("waive");
		} catch {
			return false;
		}
	};
	for (const ins of instructions) {
		if (ins.kind !== "answer" || ins.author !== "jo" || ins.created_by !== SURFACE_BY || ins.body.trim().toLowerCase() !== "waive") continue;
		if (ins.created_at <= result.createdAt) continue;
		const q = questions.find((x) => x.id === ins.question_id);
		if (!q || q.slice_id !== slice || q.resolved_by !== ins.id || !offersWaive(q) || q.created_at <= result.createdAt) continue;
		// A request in the question's own millisecond counts as before it: the tie never binds an older run.
		if (records.filter((r) => r.request.slice === slice && r.request.createdAt <= q.created_at).at(-1) !== run) continue;
		return run.request.runId;
	}
	return null;
}

/** What both close checks read first: the repo, origin's default, the pinned candidate C, the bound branches, the runs, and the PR set's heads. */
interface CloseSet {
	top: string;
	/** `refs/remotes/origin/<default>`, and its short name `origin/<default>`. */
	base: string;
	baseName: string;
	branch: string;
	candidate: string;
	branches: string[];
	records: RunRecord[];
	heads: PrHead[];
	git: (what: string, args: string[], timeout?: number) => Promise<Run>;
	commitOf: (ref: string) => Promise<string | null>;
}

/**
 * The candidate is the local `wl/<id>` tip, read once; with no local branch, the ref the close would
 * cut it from (`origin/wl/<id>`, else `origin/<default>`). The repo is fetched first so
 * `origin/<default>` and the PR heads are current. The PR set: every bound branch's PRs (`gh pr list
 * --state all`), then any PR a `test-requested:` names that none of them listed (`gh pr view`).
 */
async function gatherCloseSet(exec: Exec, ledger: Ledger, id: string, repo: string, ownerRepo: string): Promise<CloseSet> {
	const branch = branchName(id);
	const topR = await git(exec, repo, ["rev-parse", "--show-toplevel"]);
	if (topR.code !== 0 || !topR.out) throw new Unanswered(`${repo} is not a git checkout (${failed("git rev-parse", topR)})`);
	const top = topR.out;
	const ok = async (what: string, args: string[], timeout = LOCAL_MS): Promise<Run> => {
		const r = await git(exec, top, args, timeout);
		if (r.code !== 0) throw new Unanswered(failed(what, r));
		return r;
	};
	await ok("git fetch origin", ["fetch", "--quiet", "origin"], NETWORK_MS);
	const head = await git(exec, top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (head.code !== 0 || !head.out) throw new Unanswered(`origin's default branch is unknown in ${top} (refs/remotes/origin/HEAD); run \`git remote set-head origin --auto\``);
	const base = `refs/remotes/${head.out}`;
	const commitOf = async (ref: string): Promise<string | null> => {
		const r = await git(exec, top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		return r.code === 0 && SHA_RE.test(r.out) ? r.out : null;
	};
	const candidate = (await commitOf(`refs/heads/${branch}`)) ?? (await commitOf(`refs/remotes/origin/${branch}`)) ?? (await commitOf(base));
	if (candidate === null) throw new Unanswered(`${base} does not resolve in ${top}`);

	const entries = ledger.entries(id, "assumption");
	const w = ledger.workload(id);
	const branches = boundBranches(id, entries, holdersOf(entries, w?.holder ?? null, ledger.holders(id)));
	const records = testRuns(entries);
	const heads = new Map<number, PrHead>();
	const gh = async (what: string, args: string[]): Promise<unknown> => {
		const r = await run(exec, "gh", args, NETWORK_MS, top);
		if (r.code !== 0) throw new Unanswered(failed(what, r));
		try {
			return JSON.parse(r.out);
		} catch {
			throw new Unanswered(`${what} printed no JSON (${r.out.split("\n")[0] || "no output"})`);
		}
	};
	for (const b of branches) {
		const list = await gh(`gh pr list --head ${b}`, ["pr", "list", "-R", ownerRepo, "--head", b, "--state", "all", "--json", "number,state,headRefOid"]);
		if (!Array.isArray(list)) throw new Unanswered(`gh pr list --head ${b} printed no PR list`);
		for (const x of list) {
			const pr = prHeadOf(x, b);
			if (pr === null) throw new Unanswered(`gh pr list --head ${b} printed a PR without number, state and head sha: ${JSON.stringify(x).slice(0, 120)}`);
			if (!heads.has(pr.number)) heads.set(pr.number, pr);
		}
	}
	for (const n of new Set(records.map((r) => r.request.pr))) {
		if (heads.has(n)) continue;
		const pr = prHeadOf(await gh(`gh pr view ${n}`, ["pr", "view", String(n), "-R", ownerRepo, "--json", "number,state,headRefOid,headRefName"]), null);
		if (pr === null || pr.number !== n) throw new Unanswered(`gh pr view ${n} printed no PR with number, state, head branch and head sha`);
		heads.set(n, pr);
	}
	return {
		top, base, baseName: head.out, branch, candidate, branches, records, heads: [...heads.values()].sort((a, b) => a.number - b.number), git: ok, commitOf,
	};
}

/**
 * The facts `closeFreshness` decides on, read through git and gh over the close set: the candidate's
 * code delta from `merge-base(origin/<default>, C)`, each PR's authoritative result and the run Jo
 * waived (`waivedRunOf`), and the compares from a green. A sha the clone lacks is fetched through
 * `refs/pull/<N>/head`.
 */
async function gatherCloseFacts(exec: Exec, ledger: Ledger, id: string, s: CloseSet): Promise<CloseFacts> {
	const { top, base, baseName, branch, candidate, records } = s;
	const namesBetween = async (a: string, b: string): Promise<string[]> =>
		(await s.git("git diff --name-only", ["diff", "--name-only", "--no-renames", "-z", a, b])).raw.split("\0").filter((p) => p !== "");
	const mergeBase = (await s.git(`git merge-base ${baseName} ${sha7(candidate)}`, ["merge-base", base, candidate])).out;
	const changed = await namesBetween(mergeBase, candidate);
	const questions = ledger.questions(id);
	const instructions = ledger.instructions(id);

	// Compares from a tested sha S, through git: identical, ahead (S is an ancestor), behind, or diverged; when ahead, every commit of S..to with its own files.
	const present = async (sha: string, pr: number): Promise<void> => {
		if ((await git(exec, top, ["cat-file", "-e", `${sha}^{commit}`])).code === 0) return;
		await s.git(`git fetch origin refs/pull/${pr}/head`, ["fetch", "--quiet", "origin", `refs/pull/${pr}/head`], NETWORK_MS);
		if ((await git(exec, top, ["cat-file", "-e", `${sha}^{commit}`])).code !== 0) throw new Unanswered(`commit ${sha7(sha)} of PR #${pr} is not in ${top} even after fetching refs/pull/${pr}/head`);
	};
	const ancestor = async (a: string, b: string): Promise<boolean> => {
		const r = await git(exec, top, ["merge-base", "--is-ancestor", a, b]);
		if (r.code === 0 || r.code === 1) return r.code === 0;
		throw new Unanswered(failed("git merge-base --is-ancestor", r));
	};
	// Each commit against its one parent, never the net diff: a code commit and its revert both show (review r1 B3). A merge's files are not read; it refuses.
	const commitsBetween = async (from: string, to: string): Promise<RangeCommit[]> => {
		const lines = (await s.git(`git rev-list --parents ${sha7(from)}..${sha7(to)}`, ["rev-list", "--parents", `${from}..${to}`])).out.split("\n").filter((l) => l !== "");
		const commits: RangeCommit[] = [];
		for (const line of lines) {
			const [sha = "", ...parents] = line.split(" ");
			if (!SHA_RE.test(sha) || !parents.every((p) => SHA_RE.test(p))) throw new Unanswered(`git rev-list --parents printed an unexpected line: ${line.slice(0, 120)}`);
			commits.push({ sha, parents: parents.length, files: parents.length === 1 ? await namesBetween(parents[0]!, sha) : [] });
		}
		return commits;
	};
	const compare = async (from: string, to: string, pr: number): Promise<CompareResult> => {
		if (from === to) return { status: "identical", commits: [] };
		await present(from, pr);
		await present(to, pr);
		if (await ancestor(from, to)) return { status: "ahead", commits: await commitsBetween(from, to) };
		return { status: (await ancestor(to, from)) ? "behind" : "diverged", commits: [] };
	};
	// A doc-merge green's merge, re-read (plan wl-mv615mkeaf1yio § 3): the green sha's parents, and whether the merged main is on origin's first-parent chain (read once).
	let mainChain: Set<string> | null = null;
	const docMergeOf = async (sha: string, main: string, pr: number): Promise<ClosePr["docMerge"]> => {
		await present(sha, pr);
		const line = (await s.git(`git rev-list --parents -n 1 ${sha7(sha)}`, ["rev-list", "--parents", "-n", "1", sha])).out;
		const [self = "", ...parents] = line.split(" ");
		if (self !== sha || !parents.every((p) => SHA_RE.test(p))) throw new Unanswered(`git rev-list --parents -n 1 ${sha7(sha)} printed an unexpected line: ${line.slice(0, 120)}`);
		mainChain ??= new Set((await s.git(`git rev-list --first-parent ${baseName}`, ["rev-list", "--first-parent", base])).out.split("\n").filter((l) => l !== ""));
		return { parents, mainOnChain: mainChain.has(main) };
	};

	// A merged PR's batch credits at its merged head, oldest first (plan wl-mv615mkeaf1yio § 4; review r1 finding 2: closeFreshness reads every one): each batch's own row, wherever Jo ran it, and origin's chain after its base.
	const credits = batchCredits(ledger.entries(id, "assumption"));
	const creditsOf = async (pr: PrHead): Promise<CloseCredit[]> => {
		const mine = pr.state === "MERGED" ? credits.filter((x) => x.pr === pr.number && x.sha === pr.headSha) : [];
		if (mine.length === 0) return [];
		// Every credit here is at the merged head, so one compare to the candidate serves them all.
		const candidateCompare = pr.headRefName === branch && candidate !== pr.headSha ? await compare(pr.headSha, candidate, pr.number) : null;
		const out: CloseCredit[] = [];
		for (const c of mine) {
			const run = batchRunOf(ledger, c.runId);
			out.push({
				...c,
				batch: run === null ? null : { verdict: run.verdict, prs: run.prs, finalTree: run.steps[run.prs.length]?.tree ?? null },
				landed: await landedChain(exec, top, c.base, base, c.n),
				candidateCompare,
			});
		}
		return out;
	};

	const prs: ClosePr[] = [];
	for (const pr of s.heads) {
		const r = authoritativeRun(records, pr.number)?.result ?? null;
		const result = r === null ? null : { runId: r.runId, verdict: r.verdict, sha: r.sha, mode: r.mode, basis: r.basis, merge: r.merge };
		// Only a green on a PR that is not closed is ever compared (closeFreshness reads nothing else).
		const live = pr.state !== "CLOSED" && result?.verdict === "green";
		const headCompare = live && pr.headSha !== result.sha ? await compare(result.sha, pr.headSha, pr.number) : null;
		const candidateCompare = live && pr.headRefName === branch && candidate !== result.sha ? await compare(result.sha, candidate, pr.number) : null;
		const docMerge = live && result.mode === "doc-merge" && result.merge !== null ? await docMergeOf(result.sha, result.merge.main, pr.number) : null;
		prs.push({ ...pr, result, docMerge, headCompare, candidateCompare, waivedRun: waivedRunOf(records, pr.number, questions, instructions), credits: await creditsOf(pr) });
	}
	return { failure: null, branch, candidate: { sha: candidate, changed }, prs, runs: records };
}

/** Jo's `supersede <A> <B>` as `supersededBy` (surface/src/launch.ts) reads it: the successor and Jo's instruction. */
export interface Superseded {
	by: string;
	instructionId: string;
}

/** What a superseded close decides on (PLAN wl-mv5i3lulwwbbi8 D2), or the failure that refuses it. */
export interface SupersededFacts {
	failure: string | null;
	superseded: Superseded;
	/** `origin/<default>`. */
	baseName: string;
	/** The close set's PRs, in any state. */
	prs: readonly PrHead[];
	/** Each bound branch ref (`refs/heads/<b>`, `refs/remotes/origin/<b>`) that carries commits not in origin's default, with those commits, oldest first. */
	unmerged: readonly { ref: string; commits: readonly string[] }[];
}

/**
 * The close check of a workload Jo superseded (PLAN wl-mv5i3lulwwbbi8 D2), in place of
 * `closeFreshness`: no PR in the whole close set is open, and no bound branch (`wl/<id>` and every
 * holder's `push-dest:` branch, local and on origin) carries a commit origin's default lacks. Any
 * failure refuses (fails closed).
 */
export function supersededFreshness(f: SupersededFacts): CloseDecision {
	if (f.failure !== null) return { close: false, reason: `the close check could not answer: ${f.failure}` };
	const by = `superseded by ${f.superseded.by} (Jo, ${f.superseded.instructionId})`;
	const open = f.prs.find((p) => p.state === "OPEN");
	if (open) return { close: false, reason: `${by}, but PR #${open.number} from ${open.headRefName} is open: merge or close it first` };
	const u = f.unmerged[0];
	if (u) {
		return { close: false, reason: `${by}, but ${u.ref} has ${u.commits.length} commit(s) not in ${f.baseName}, first ${sha7(u.commits[0]!)}: merge them, or delete the branch` };
	}
	return { close: true, why: `${by}: no open PR in the set and no unmerged commit on a bound branch` };
}

async function gatherSupersededFacts(s: CloseSet, superseded: Superseded): Promise<SupersededFacts> {
	const unmerged: { ref: string; commits: string[] }[] = [];
	for (const b of s.branches) {
		for (const ref of [`refs/heads/${b}`, `refs/remotes/origin/${b}`]) {
			const tip = await s.commitOf(ref);
			if (tip === null) continue;
			const commits = (await s.git(`git rev-list ${s.baseName}..${ref}`, ["rev-list", "--reverse", `${s.base}..${tip}`])).out.split("\n").filter((l) => l !== "");
			if (commits.length > 0) unmerged.push({ ref, commits });
		}
	}
	return { failure: null, superseded, baseName: s.baseName, prs: s.heads, unmerged };
}

/** A directory inside a git work tree or repository, judged without exec: some `.git` at or above it. */
function insideGit(dir: string): boolean {
	for (let d = resolve(dir); ; d = dirname(d)) {
		if (existsSync(join(d, ".git"))) return true;
		if (dirname(d) === d) return false;
	}
}

/**
 * The close check (PLAN § 2.4 item 4) for the workload's repo. A repo whose `origin` is not in the
 * profile's `testRunner.repos` is not checked. For one that is, the decision is `closeFreshness`
 * over the facts git and gh give — `supersededFreshness` instead for a workload Jo superseded
 * (`superseded`, PLAN wl-mv5i3lulwwbbi8 D2) — and a passed check carries the pin `commitCloseEntry`
 * publishes on. It fails closed: a profile whose block does not parse, a host with no exec in a git
 * checkout, and any git or gh call that cannot answer all refuse.
 */
export async function closeCheck(
	pi: SurfaceAPI, ledger: Ledger, env: Record<string, string | undefined>, id: string, repo: string, superseded: Superseded | null = null,
): Promise<CloseCheck> {
	const branch = branchName(id);
	const unanswered = (failure: string): CloseCheck => ({ served: true, pin: null, decision: closeFreshness({ failure, branch, candidate: { sha: "", changed: [] }, prs: [], runs: [] }) });
	const cfg = loadTestRunnerConfig(env);
	if (!cfg.ok) return unanswered(`the profile's testRunner block: ${cfg.error}`);
	if (cfg.config.repos.length === 0) return { served: false };
	if (!pi.exec) return insideGit(repo) ? unanswered(`the host has no exec for extensions, so git cannot say whether ${repo} is a repo the test runner serves`) : { served: false };
	const exec = pi.exec.bind(pi);
	const url = await git(exec, repo, ["config", "--get", "remote.origin.url"]);
	if (url.code === 1) return { served: false };
	if (url.code !== 0) return unanswered(failed("git config --get remote.origin.url", url));
	const served = servedRepo(cfg.config, url.out);
	if (served === null) return { served: false };
	let decision: CloseDecision;
	let candidate: string;
	try {
		const s = await gatherCloseSet(exec, ledger, id, repo, served.origin);
		candidate = s.candidate;
		decision = superseded ? supersededFreshness(await gatherSupersededFacts(s, superseded)) : closeFreshness(await gatherCloseFacts(exec, ledger, id, s));
	} catch (err) {
		if (!(err instanceof Unanswered)) throw err;
		return unanswered(err.message);
	}
	return { served: true, decision, pin: decision.close ? { sha: candidate, ownerRepo: served.origin } : null };
}
