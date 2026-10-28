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
// `wl/<id>` in any state, each PR from a holder's `push-dest:` branch whose head contains a sha the
// workload pushed there (PLAN wl-mvfjen3q5mqi2o D1), and every PR a `test-requested:` names, each through
// `gh pr list -R <owner/repo> --head <branch> --state all`), the authoritative result of each, and the
// local `wl/<id>` tip pinned as the candidate C with its code delta from `merge-base(origin/<default>,
// C)`; a head or candidate that is not a green S must descend from S through commits that each touch
// only `.ai/decision-log/`, read commit by commit with `git rev-list --parents` (never the net diff).
// The decision is surface/src/test-run.ts `closeFreshness`; a merged PR whose authoritative non-green
// run Jo waived (`waivedRunOf`, PLAN wl-mv5i3lulwwbbi8 D3) passes it, and a PR Jo skipped on a merge
// train (`trainSkippedOf`, PLAN wl-mv8s8srodefytc § 1) counts as closed; a `red-main` result passes only
// a merged PR a merge train of the repo lists (`trainPrsOn`, rev 17.1 D8). Any merged PR those rules
// refuse (`mergedNeedsCover`: no result, an unkept green, a fast green, a red, error or stale run not waived
// at its head, a red-main off a train) is covered by a full-suite green of the repo whose commit is on
// `origin/<default>` and is its merged head or contains its merge commit (`coverOf`, PLAN wl-mvfjen3q5mqi2o
// D2: an integration snapshot of the main line, not proof each line it added still runs): a test-runner
// full-scope green of any workload, or a main run's green believable verdict (`runnerGreensOn`, PLAN
// wl-mvq4edbaf13vnk D9); a fast green is never a cover and is covered only by a main run. Else it passes on
// Jo's `waive-pr` (`waivedPrs`, D3). A workload Jo superseded
// (`supersede <A> <B>`, D2) or withdrew (`withdraw <wl>`, PLAN wl-mv8s939084z1ts D5; the `StandIn`) is
// decided by `supersededFreshness` instead: no open PR in the set and no bound branch with a commit
// origin's default lacks, the refusal naming which word stood in. Unlike the rest of this path it fails
// closed: when git or gh cannot answer, the close is refused. A passed check pins the publication:
// the entry commit D must be made, have the single parent C and touch only `.ai/decision-log/`, and
// it is pushed as `D:refs/heads/wl/<id>` by sha, a plain fast-forward.
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { SCRATCH_ENTRY, scratchBase, scratchRootFor } from "../../gates/src/scratch";
import { type EntryRow, homeDir, type InstructionRow, type Ledger, type QuestionRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import { renderClose, repoOf } from "./decision-log";
import { ensureStandingWorkload, identityOf } from "./identity";
import { type Archived, type ArchiveSeams, archiveDetached, archivePathFor, type Manifest } from "./scratch-archive";
import { detachChild, fileIdentity, purgeDetached, restoreDetached } from "./scratch-remove";
import { branchName, controlEntries, holdersOf, waivedPrs } from "./launch";
import { checkoutOwnerRepo, trainPrs, trainSkippedOf } from "./merge-train";
import { REPO_ROOT } from "./session";
import { mainResults, mainVerdicts } from "./main-state";
import {
	authoritativeRun, boundBranches, type CloseDecision, type CloseFacts, type ClosePr, closeFreshness, type CompareResult, DECISION_LOG_DIR, decisionLogFault, isFullSuiteGreen,
	mergedNeedsCover, parsePushDest, parseTestRun, type RangeCommit, type RunRecord, SHA_RE, servedRepo, type TestRunnerConfig, testRunnerConfig, testRuns,
} from "./test-run";
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

/** What became of a closed workload's scratch root (`archiveScratchRoot`). */
export type ScratchClose =
	/** No root: nothing to archive or remove. */
	| { kind: "missing"; root: string }
	/** Refused before archiving (a symlinked root, a root that resolves elsewhere, a rename aside that failed): nothing archived, nothing removed. */
	| { kind: "refused"; root: string; reason: string }
	/** The archive could not be written or verified: the tree is kept, at `keptAt` (its own name when it could be renamed back). */
	| { kind: "archive-failed"; root: string; reason: string; keptAt: string; restore: string }
	/** Archived and verified; `removal` says whether the tree then went (`left` is where a part-removed tree remains). */
	| { kind: "archived"; root: string; physical: string; archive: Archived; removal: { ok: true } | { ok: false; reason: string; left: string } };

/**
 * Archive workload `id`'s scratch root, then remove it, once its close has committed (PLAN wl-mv5oikd5jtquww § 1.5, amended
 * 2026-10-28 after the close of wl-mvs2x210k5ifkz deleted the REPORT.md its done-because named). Exactly `scratchRootFor(home,
 * id)`, refused when that path is a symlink or its realpath is not exactly `<realpath(base)>/<id>`. The root is first renamed
 * aside (./scratch-remove detachChild: same dev/ino as judged, renamed to `.removing-*`, checked again), so nothing writing by
 * its path reaches the tree; the detached tree is archived and verified (./scratch-archive archiveDetached: manifest, capacity,
 * tar, extraction compared entry by entry, hash, the tree read again) to `archivePathFor(home, id, now)`; only then is it
 * removed (purgeDetached). An archive that fails renames the tree back (restoreDetached) and keeps it. A missing root is a
 * no-op. Never throws.
 */
export function archiveScratchRoot(home: string, id: string, now: Date, seams: ArchiveSeams = {}): ScratchClose {
	let root = join(scratchBase(home), id);
	try {
		root = scratchRootFor(home, id);
		try {
			if (lstatSync(root).isSymbolicLink()) return { kind: "refused", root, reason: "the root is a symlink" };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", root };
			throw err;
		}
		const physical = realpathSync.native(root);
		const base = realpathSync.native(scratchBase(home));
		const expected = `${base}/${id}`;
		if (physical !== expected) return { kind: "refused", root, reason: `the root resolves to ${physical}, not ${expected}` };
		const d = detachChild(base, id, fileIdentity(expected));
		if (d.kind !== "detached") return { kind: "refused", root, reason: d.kind === "refused" ? d.reason : d.error };
		const archive = archiveDetached(d.doomed, archivePathFor(home, id, now), seams);
		if (archive.kind === "failed") {
			const back = restoreDetached(d);
			return { kind: "archive-failed", root, reason: archive.reason, keptAt: back.at, restore: back.said };
		}
		const r = purgeDetached(d);
		const removal = r.kind === "removed" ? { ok: true as const } : { ok: false as const, reason: r.kind === "refused" ? r.reason : r.error, left: d.doomed };
		return { kind: "archived", root, physical, archive, removal };
	} catch (err) {
		return { kind: "refused", root, reason: String(err instanceof Error ? err.message : err) };
	}
}

/** Characters that end a path named in prose: whitespace, quotes, brackets and the punctuation that follows a path in a sentence. */
const PATH_END = /[\s"'`<>()[\]{},;]/;

/**
 * Every path `text` names inside the scratch root, spelled as one of `roots` (the HOME form, the physical form, `$AS2_SCRATCH`,
 * `${AS2_SCRATCH}`, `~/…`), each as `[as written, path relative to the root ("" for the root itself)]`, in order, deduplicated.
 * Lexical only: what the path reaches is `archivedAs`'s to say.
 */
export function scratchPathsIn(text: string, roots: readonly string[]): [string, string][] {
	const found: [string, string][] = [];
	for (const form of roots) {
		let from = 0;
		for (;;) {
			const at = text.indexOf(form, from);
			if (at < 0) break;
			from = at + form.length;
			const next = text[from];
			if (next !== undefined && next !== "/" && !PATH_END.test(next) && next !== "." && next !== ":") continue;
			let end = from;
			while (end < text.length && !PATH_END.test(text[end]!)) end++;
			// A sentence's full stop or colon after the path is not part of it.
			while (end > from && /[.:]/.test(text[end - 1]!)) end--;
			const written = text.slice(at, end);
			const rel = text.slice(from, end).replace(/^\/+/, "").replace(/\/+$/, "");
			if (!found.some(([w]) => w === written)) found.push([written, rel]);
		}
	}
	return found;
}

/**
 * What the verified archive holds for the path `rel` (relative to the root) the done-because names, from the archive's own
 * manifest (`members`), never from the path's spelling: a `..` component, an entry the tree did not have, a path reached
 * through a symlink (the archive holds the link, not what it points to), a symlink itself, or the member it is archived as.
 */
export function archivedAs(rel: string, members: Manifest, archive: string): string {
	const parts = rel === "" ? [] : rel.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.includes("..")) return `a path with a \`..\` component: not checked against the archive, and not known to be in it`;
	for (let i = 0; i < parts.length; i++) {
		const prefix = parts.slice(0, i + 1).join("/");
		const e = members.get(prefix);
		if (!e) return `not in the archive ${archive}: the root had no ./${prefix} at close`;
		if (e.type === "link" && i < parts.length - 1) return `reached through the symlink ./${prefix} (→ ${e.target}): the archive ${archive} holds that link, not what it points to`;
	}
	const key = parts.join("/");
	const e = members.get(key)!;
	if (e.type === "link") return `a symlink (→ ${e.target}): the archive ${archive} holds the link as ./${key}, not its target`;
	return `in the archive ${archive} as ${key === "" ? "./ (the whole root)" : `./${key}`}`;
}

/**
 * After the ledger close: archive then remove the workload's scratch root (`archiveScratchRoot`, HOME from `env`) and record the
 * outcome on the standing workload, as the surface (the closed workload takes no entries, ledger/schema.sql
 * `entries_insert_workload`): `scratch-archived: <id> <archive> <bytes> <sha256>` and then `scratch-removed: <id> <root>` or
 * `scratch-remove-failed: <id> <root>: <reason>; what is left is at <path>`; an archive that failed is
 * `scratch-remove-failed: <id> <root>: not archived (<reason>); the root is kept[ at <path>]`, and a root refused before
 * archiving `scratch-remove-failed: <id> <root>: <reason>`. When the closing workload's done-because (`doneBecause`) names a
 * path inside the root, the sentence says what the verified archive holds for it (`archivedAs`), or where the kept tree is.
 * A missing root writes nothing, and so does a HOME that cannot be resolved (ledger/src/locality.ts homeDir): no root can be
 * named, and the sentence says why. Never throws and never fails the close: returns the sentence the close result carries
 * ("" for none).
 */
export function closeScratchRoot(ledger: Ledger, env: Record<string, string | undefined>, id: string, opts: { doneBecause?: string | null; now?: Date; seams?: ArchiveSeams } = {}): string {
	let home: string;
	try {
		home = homeDir(env);
	} catch (err) {
		return `Scratch root of ${id} not removed: ${String(err instanceof Error ? err.message : err)}.`;
	}
	const r = archiveScratchRoot(home, id, opts.now ?? new Date(), opts.seams);
	if (r.kind === "missing") return "";
	const physicalRoot = r.kind === "archived" ? r.physical : null;
	const keptWhere = r.kind === "archive-failed" && r.keptAt !== physicalRoot && !r.restore.startsWith("renamed back") ? ` at ${r.keptAt} (${r.restore})` : "";
	const bodies: string[] = [];
	if (r.kind === "refused") bodies.push(`${SCRATCH_ENTRY.removeFailed} ${id} ${r.root}: ${r.reason}`);
	else if (r.kind === "archive-failed") bodies.push(`${SCRATCH_ENTRY.removeFailed} ${id} ${r.root}: not archived (${r.reason}); the root is kept${keptWhere}`);
	else {
		bodies.push(`${SCRATCH_ENTRY.archived} ${id} ${r.archive.path} ${r.archive.bytes} ${r.archive.sha256}`);
		bodies.push(r.removal.ok ? `${SCRATCH_ENTRY.removed} ${id} ${r.root}` : `${SCRATCH_ENTRY.removeFailed} ${id} ${r.root}: ${r.removal.reason}; what is left is at ${r.removal.left}`);
	}
	let entry: string;
	try {
		entry = ledger.write(() => {
			ensureStandingWorkload(ledger);
			const ids = bodies.map((body) => ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body }));
			return `${ids.length === 1 ? "entry" : "entries"} ${ids.join(", ")} on ${STANDING_WORKLOAD_ID}`;
		});
	} catch (err) {
		entry = `its entry could not be written: ${String(err instanceof Error ? err.message : err)}`;
	}
	let sentence: string;
	if (r.kind === "refused") sentence = `Scratch root ${r.root} not removed: ${r.reason} (${entry}).`;
	else if (r.kind === "archive-failed") sentence = `Scratch root ${r.root} kept${keptWhere}: not archived: ${r.reason} (${entry}).`;
	else {
		const made = `archived to ${r.archive.path} (${r.archive.bytes} bytes, sha256 ${r.archive.sha256})`;
		sentence = r.removal.ok
			? `Scratch root ${r.root} ${made} and removed (${entry}).`
			: `Scratch root ${r.root} ${made} but not removed: ${r.removal.reason}; what is left is at ${r.removal.left}, and the daily sweep archives it again before removing it (${entry}).`;
		for (const w of r.archive.warnings) sentence += ` Warning: ${w}.`;
	}
	if (opts.doneBecause) {
		const forms = [r.root, ...(physicalRoot ? [physicalRoot] : []), `~/${relative(home, r.root)}`, "${AS2_SCRATCH}", "$AS2_SCRATCH"];
		for (const [written, rel] of scratchPathsIn(opts.doneBecause, forms)) {
			if (r.kind === "archived") sentence += ` The done-because names ${written}, inside the scratch root: ${archivedAs(rel, r.archive.members, r.archive.path)}.`;
			else if (r.kind === "archive-failed") sentence += ` The done-because names ${written}, inside the scratch root, which is kept${keptWhere ? keptWhere : ` at ${r.root}`}.`;
			else sentence += ` The done-because names ${written}, inside the scratch root, which was not removed.`;
		}
	}
	return sentence;
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

type PrHead = Pick<ClosePr, "number" | "state" | "headRefName" | "headSha" | "mergeCommit">;

/** The PR fields every `gh pr list`/`gh pr view` of the close check asks for (`mergeCommit` is `{ oid }` when merged, else null). */
const PR_FIELDS = "number,state,headRefOid,mergeCommit";

/** A `gh pr list`/`gh pr view` record, or null when it does not have that shape; a MERGED PR must carry its merge commit. */
function prHeadOf(x: unknown, headRefName: string | null): PrHead | null {
	if (x === null || typeof x !== "object") return null;
	const o = x as Record<string, unknown>;
	const head = headRefName ?? o.headRefName;
	if (!Number.isSafeInteger(o.number) || (o.number as number) < 1 || (o.state !== "OPEN" && o.state !== "MERGED" && o.state !== "CLOSED")) return null;
	if (typeof o.headRefOid !== "string" || !SHA_RE.test(o.headRefOid) || typeof head !== "string" || head === "") return null;
	let mergeCommit: string | null = null;
	if (o.state === "MERGED") {
		const m = o.mergeCommit as { oid?: unknown } | null | undefined;
		if (m === null || typeof m !== "object" || typeof m.oid !== "string" || !SHA_RE.test(m.oid)) return null;
		mergeCommit = m.oid;
	}
	return { number: o.number as number, state: o.state as ClosePr["state"], headRefName: head, headSha: o.headRefOid, mergeCommit };
}

/** Whether the clone has `sha` as a commit; never fetches. */
async function hasCommit(exec: Exec, top: string, sha: string): Promise<boolean> {
	return (await git(exec, top, ["cat-file", "-e", `${sha}^{commit}`])).code === 0;
}

/** Thrown inside the gather when git or gh cannot answer; the check refuses with its message. */
class Unanswered extends Error {}

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
 * `origin/<default>` and the PR heads are current. The PR set: every PR of `wl/<id>` (`gh pr list
 * --state all`); every PR of a holder's other `push-dest:` branch B whose head contains a sha a holder
 * recorded as `push-dest: <any remote> B <sha>` (PLAN wl-mvfjen3q5mqi2o D1, `carriesPush`), so another
 * workload's PRs on a shared branch stay out; then any PR a `test-requested:` names that is not yet in
 * the set (the listed record when B listed it, else `gh pr view`).
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
	const holders = holdersOf(entries, w?.holder ?? null, ledger.holders(id));
	const branches = boundBranches(id, entries, holders);
	// The shas the holders pushed to each push-dest: branch other than wl/<id>; the remote is ignored, as boundBranches ignores it.
	const pushed = new Map<string, string[]>();
	for (const c of controlEntries(entries, holders)) {
		const d = c.prefix === "push-dest" ? parsePushDest(c.body) : null;
		if (d === null || d.branch === branch) continue;
		const shas = pushed.get(d.branch) ?? [];
		if (!shas.includes(d.sha)) shas.push(d.sha);
		pushed.set(d.branch, shas);
	}
	let shallow: boolean | null = null;
	const isShallow = async (): Promise<boolean> => {
		if (shallow === null) {
			const s = await ok("git rev-parse --is-shallow-repository", ["rev-parse", "--is-shallow-repository"]);
			if (s.out !== "true" && s.out !== "false") throw new Unanswered(`git rev-parse --is-shallow-repository printed ${s.out.split("\n")[0] || "nothing"}`);
			shallow = s.out === "true";
		}
		return shallow;
	};
	// D1: the PR's head contains one of `shas`. Only an answered `git merge-base --is-ancestor` decides (0 keeps, 1 drops). A missing
	// sha first fetches refs/pull/<N>/head. Every no (a pushed sha still missing, or exit 1) is an answer only in a clone that is not
	// shallow: a shallow boundary hides history, so a negative there refuses (review sl-closefix-review r1).
	const carriesPush = async (pr: PrHead, shas: readonly string[]): Promise<boolean> => {
		let missing = !(await hasCommit(exec, top, pr.headSha));
		for (const p of shas) if (!missing && !(await hasCommit(exec, top, p))) missing = true;
		if (missing) await ok(`git fetch origin refs/pull/${pr.number}/head`, ["fetch", "--quiet", "origin", `refs/pull/${pr.number}/head`], NETWORK_MS);
		if (!(await hasCommit(exec, top, pr.headSha))) throw new Unanswered(`commit ${sha7(pr.headSha)} of PR #${pr.number} is not in ${top} even after fetching refs/pull/${pr.number}/head`);
		for (const p of shas) {
			if (await hasCommit(exec, top, p)) {
				const r = await git(exec, top, ["merge-base", "--is-ancestor", p, pr.headSha]);
				if (r.code === 0) return true;
				if (r.code !== 1) throw new Unanswered(failed("git merge-base --is-ancestor", r));
			}
			if (await isShallow()) {
				throw new Unanswered(`${top} is a shallow clone, so git cannot say whether PR #${pr.number} on ${pr.headRefName} carries the pushed ${sha7(p)}`);
			}
		}
		return false;
	};
	const records = testRuns(entries);
	const heads = new Map<number, PrHead>();
	// PRs a push-dest: branch listed without this workload's push: out of the set unless a test-requested: names them.
	const foreign = new Map<number, PrHead>();
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
		const list = await gh(`gh pr list --head ${b}`, ["pr", "list", "-R", ownerRepo, "--head", b, "--state", "all", "--json", PR_FIELDS]);
		if (!Array.isArray(list)) throw new Unanswered(`gh pr list --head ${b} printed no PR list`);
		for (const x of list) {
			const pr = prHeadOf(x, b);
			if (pr === null) throw new Unanswered(`gh pr list --head ${b} printed a PR without number, state, head sha, and a merged PR's merge commit: ${JSON.stringify(x).slice(0, 120)}`);
			if (heads.has(pr.number) || foreign.has(pr.number)) continue;
			if (b === branch || (await carriesPush(pr, pushed.get(b) ?? []))) heads.set(pr.number, pr);
			else foreign.set(pr.number, pr);
		}
	}
	for (const n of new Set(records.map((r) => r.request.pr))) {
		if (heads.has(n)) continue;
		const listed = foreign.get(n);
		if (listed !== undefined) {
			heads.set(n, listed);
			continue;
		}
		const pr = prHeadOf(await gh(`gh pr view ${n}`, ["pr", "view", String(n), "-R", ownerRepo, "--json", `${PR_FIELDS},headRefName`]), null);
		if (pr === null || pr.number !== n) throw new Unanswered(`gh pr view ${n} printed no PR with number, state, head branch, head sha, and a merged PR's merge commit`);
		heads.set(n, pr);
	}
	return {
		top, base, baseName: head.out, branch, candidate, branches, records, heads: [...heads.values()].sort((a, b) => a.number - b.number), git: ok, commitOf,
	};
}

/**
 * The facts `closeFreshness` decides on, read through git and gh over the close set: the candidate's
 * code delta from `merge-base(origin/<default>, C)`, each PR's authoritative result and the run Jo
 * waived (`waivedRunOf`), the compares from a green, Jo's `waive-pr` (`waivedPrs`), and, for a MERGED PR
 * its own results do not pass (`mergedNeedsCover`), the covering green (PLAN wl-mvfjen3q5mqi2o D2): the newest test-runner green of
 * this repository (`runnerGreensOn`) whose commit S the clone already has (a foreign run's commit is never
 * fetched), on the freshly fetched `origin/<default>`, and either the merged head (or a commit it descends
 * from through decision-log-only commits) or a descendant of the merge commit. Ancestry is cached for the
 * close by the ordered pair, never by S alone. A PR's own sha the clone lacks is fetched through `refs/pull/<N>/head`.
 */
async function gatherCloseFacts(exec: Exec, ledger: Ledger, id: string, ownerRepo: string, s: CloseSet): Promise<CloseFacts> {
	const { top, base, baseName, branch, candidate, records } = s;
	const namesBetween = async (a: string, b: string): Promise<string[]> =>
		(await s.git("git diff --name-only", ["diff", "--name-only", "--no-renames", "-z", a, b])).raw.split("\0").filter((p) => p !== "");
	const mergeBase = (await s.git(`git merge-base ${baseName} ${sha7(candidate)}`, ["merge-base", base, candidate])).out;
	const changed = await namesBetween(mergeBase, candidate);
	const tip = await s.commitOf(base);
	if (tip === null) throw new Unanswered(`${base} does not resolve in ${top}`);
	const questions = ledger.questions(id);
	const instructions = ledger.instructions(id);
	const entries = ledger.entries(id);
	const onTrain = trainPrsOn(ledger, ownerRepo);
	const waivedByJo = waivedPrs(entries, instructions);

	// Compares from a tested sha S, through git: identical, ahead (S is an ancestor), behind, or diverged; when ahead, every commit of S..to with its own files.
	const present = async (sha: string, pr: number): Promise<void> => {
		if (await hasCommit(exec, top, sha)) return;
		await s.git(`git fetch origin refs/pull/${pr}/head`, ["fetch", "--quiet", "origin", `refs/pull/${pr}/head`], NETWORK_MS);
		if (!(await hasCommit(exec, top, sha))) throw new Unanswered(`commit ${sha7(sha)} of PR #${pr} is not in ${top} even after fetching refs/pull/${pr}/head`);
	};
	// Answered ancestry and compares, cached for this close by the ordered pair (ancestor, descendant).
	const ancestry = new Map<string, boolean>();
	const ancestor = async (a: string, b: string): Promise<boolean> => {
		const known = ancestry.get(`${a} ${b}`);
		if (known !== undefined) return known;
		const r = await git(exec, top, ["merge-base", "--is-ancestor", a, b]);
		if (r.code !== 0 && r.code !== 1) throw new Unanswered(failed("git merge-base --is-ancestor", r));
		ancestry.set(`${a} ${b}`, r.code === 0);
		return r.code === 0;
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
	const compares = new Map<string, CompareResult>();
	const compare = async (from: string, to: string, pr: number): Promise<CompareResult> => {
		if (from === to) return { status: "identical", commits: [] };
		const known = compares.get(`${from} ${to}`);
		if (known !== undefined) return known;
		await present(from, pr);
		await present(to, pr);
		const c: CompareResult = (await ancestor(from, to))
			? { status: "ahead", commits: await commitsBetween(from, to) }
			: { status: (await ancestor(to, from)) ? "behind" : "diverged", commits: [] };
		compares.set(`${from} ${to}`, c);
		return c;
	};
	// D2: read once, and only when a merged PR needs a cover; walked newest first, stopping at the first that qualifies. A fast
	// green's cover is a main run only (`mainOnly`, PLAN wl-mvq4edbaf13vnk D9): a main run on its merge commit or a later main commit.
	let greens: RunnerGreen[] | null = null;
	const coverOf = async (pr: PrHead, mainOnly: boolean): Promise<ClosePr["cover"]> => {
		greens ??= runnerGreensOn(ledger, ownerRepo);
		for (const g of greens) {
			if (mainOnly && !g.main) continue;
			if (!(await hasCommit(exec, top, g.sha)) || !(await ancestor(g.sha, tip))) continue;
			const at = { runId: g.runId, sha: g.sha, workloadId: g.workloadId, main: g.main };
			if (g.sha === pr.headSha) return { ...at, how: "head" };
			if (pr.mergeCommit !== null && (await hasCommit(exec, top, pr.mergeCommit)) && (await ancestor(pr.mergeCommit, g.sha))) return { ...at, how: "merge" };
			if (decisionLogFault(await compare(g.sha, pr.headSha, pr.number)) === null) return { ...at, how: "head" };
		}
		return null;
	};

	const prs: ClosePr[] = [];
	for (const pr of s.heads) {
		const r = authoritativeRun(records, pr.number)?.result ?? null;
		const result = r === null ? null : { runId: r.runId, verdict: r.verdict, sha: r.sha, scope: r.scope };
		const train = onTrain.has(pr.number);
		// Only a green on a PR that is not closed, or a red-main on a merged train PR (D8), is ever compared (closeFreshness reads nothing else).
		const green = pr.state !== "CLOSED" && result?.verdict === "green";
		const mainRed = pr.state === "MERGED" && train && result?.verdict === "red-main" && pr.headSha === result.sha;
		const headCompare = green && pr.headSha !== result.sha ? await compare(result.sha, pr.headSha, pr.number) : null;
		const candidateCompare = (green || mainRed) && pr.headRefName === branch && candidate !== result!.sha ? await compare(result!.sha, candidate, pr.number) : null;
		const trainSkipped = trainSkippedOf(pr.number, entries, questions, instructions);
		const own = { ...pr, result, headCompare, candidateCompare, waivedRun: waivedRunOf(records, pr.number, questions, instructions), trainSkipped, onTrain: train };
		prs.push({
			...own,
			// A cover is sought only for a MERGED PR its own results do not pass (`mergedNeedsCover`, D2); a fast green's only from a main run (D9).
			cover: mergedNeedsCover(own) ? await coverOf(pr, result?.verdict === "green" && result.scope === "fast") : null,
			waivedByJo: waivedByJo.find((x) => x.pr === pr.number)?.instructionId ?? null,
		});
	}
	return { failure: null, branch, defaultBranch: baseName.replace(/^origin\//, ""), candidate: { sha: candidate, changed }, prs };
}

/** A full-suite green as the close check's cover search reads it (PLAN wl-mvfjen3q5mqi2o D2): a PR's, or a main run's (`main`, PLAN wl-mvq4edbaf13vnk D9). */
interface RunnerGreen {
	runId: string;
	sha: string;
	workloadId: string;
	main: boolean;
	createdAt: string;
}

/**
 * The full-suite greens a cover may be, newest first (PLAN wl-mvfjen3q5mqi2o D2, PLAN wl-mvq4edbaf13vnk D9): the test runner's
 * full-scope PR greens (`isFullSuiteGreen`; a fast green never covers) on every workload, open or closed, whose `repo:`
 * checkout's origin is `ownerRepo` (`checkoutOwnerRepo`, compared without case, as `trainPrsOn` does), and every main commit's
 * green believable verdict (`mainVerdicts` over the standing workload's main runs, `mainResults`; a later run of a commit with a
 * verdict never counts). Only rows the runner wrote count (`test-run:`'s one writer), so a lane's imitation is never read. The
 * repo match is a cheap pre-filter that skips other repositories before any git call, not the proof: each green's commit must
 * still be on this clone's `origin/<default>`, which is also what keeps another repository's main run out.
 */
function runnerGreensOn(ledger: Ledger, ownerRepo: string): RunnerGreen[] {
	const want = ownerRepo.toLowerCase();
	const rows = ledger.db.query<EntryRow, [string]>(
		"SELECT * FROM entries WHERE kind = 'assumption' AND created_by = ? AND body LIKE 'test-run: %' ORDER BY created_at DESC, rowid DESC").all(TEST_RUNNER_BY);
	const onRepo = new Map<string, boolean>();
	const out: RunnerGreen[] = [];
	for (const e of rows) {
		const r = parseTestRun(e.body);
		if (r === null || r.main || !isFullSuiteGreen(r)) continue;
		let on = onRepo.get(e.workload_id);
		if (on === undefined) {
			const path = repoOf(ledger, e.workload_id);
			on = path !== null && checkoutOwnerRepo(path)?.toLowerCase() === want;
			onRepo.set(e.workload_id, on);
		}
		if (on) out.push({ runId: r.runId, sha: r.sha, workloadId: e.workload_id, main: false, createdAt: e.created_at });
	}
	for (const v of mainVerdicts(mainResults(ledger.entries(STANDING_WORKLOAD_ID))).values()) {
		if (v.verdict === "green") out.push({ runId: v.runId, sha: v.sha, workloadId: STANDING_WORKLOAD_ID, main: true, createdAt: v.at });
	}
	// Newest first across both kinds; a stable sort keeps the query's order among equal times.
	return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * Every PR on a merge train of GitHub repository `ownerRepo` (PLAN wl-mv8s8srodefytc rev 17.1 D8): every member
 * (`trainMembers`: Jo's own `train` word, or the train tick's `train-board:`, PLAN wl-mvbjiettjrfpxc D2), on any workload, open or
 * closed, whose `repo:` checkout's origin is `ownerRepo` (`checkoutOwnerRepo`, compared without case as GitHub does), whatever
 * checkout or directory the train was opened from. A `red-main` result passes the close check only on such a PR (`closeFreshness`).
 */
export function trainPrsOn(ledger: Ledger, ownerRepo: string): Set<number> {
	const out = new Set<number>();
	const want = ownerRepo.toLowerCase();
	const ids = ledger.db.query<{ workload_id: string }, [string, string]>(
		"SELECT DISTINCT workload_id FROM entries WHERE kind = 'assumption' AND (body LIKE ? OR body LIKE ?) ORDER BY workload_id").all("train: %", "train-board: %");
	for (const { workload_id: wl } of ids) {
		const on = repoOf(ledger, wl);
		if (on === null || checkoutOwnerRepo(on)?.toLowerCase() !== want) continue;
		for (const n of trainPrs(ledger.entries(wl), ledger.instructions(wl))) out.add(n);
	}
	return out;
}

/**
 * Jo's word that stands in for the holder's receipt and swaps the close check for `supersededFreshness`:
 * `supersede <A> <B>` as `supersededBy` reads it (PLAN wl-mv5i3lulwwbbi8 D2) or `withdraw <wl>` as
 * `withdrawnBy` reads it (PLAN wl-mv8s939084z1ts D5), both in surface/src/launch.ts. `label` names it in
 * the check's text (`superseded by wl-B`, `withdrawn`); `instructionId` is Jo's instruction.
 */
export interface StandIn {
	kind: "superseded" | "withdrawn";
	label: string;
	instructionId: string;
}

/** The stand-in for a workload's close, or null: superseded wins over withdrawn when both stand, since it names a successor (PLAN wl-mv8s939084z1ts D4). */
export function standInOf(superseded: { by: string; instructionId: string } | null, withdrawn: { instructionId: string } | null): StandIn | null {
	if (superseded) return { kind: "superseded", label: `superseded by ${superseded.by}`, instructionId: superseded.instructionId };
	if (withdrawn) return { kind: "withdrawn", label: "withdrawn", instructionId: withdrawn.instructionId };
	return null;
}

/** What a superseded or withdrawn close decides on (PLAN wl-mv5i3lulwwbbi8 D2, wl-mv8s939084z1ts D5), or the failure that refuses it. */
export interface SupersededFacts {
	failure: string | null;
	standIn: StandIn;
	/** `origin/<default>`. */
	baseName: string;
	/** The close set's PRs, in any state. */
	prs: readonly PrHead[];
	/** Each bound branch ref (`refs/heads/<b>`, `refs/remotes/origin/<b>`) that carries commits not in origin's default, with those commits, oldest first. */
	unmerged: readonly { ref: string; commits: readonly string[] }[];
}

/**
 * The close check of a workload Jo superseded (PLAN wl-mv5i3lulwwbbi8 D2) or withdrew (PLAN
 * wl-mv8s939084z1ts D5), in place of `closeFreshness`: no PR in the whole close set is open, and no
 * bound branch (`wl/<id>` and every holder's `push-dest:` branch, local and on origin) carries a
 * commit origin's default lacks. Any failure refuses (fails closed). The text names which word stands in.
 */
export function supersededFreshness(f: SupersededFacts): CloseDecision {
	if (f.failure !== null) return { close: false, reason: `the close check could not answer: ${f.failure}` };
	const by = `${f.standIn.label} (Jo, ${f.standIn.instructionId})`;
	const open = f.prs.find((p) => p.state === "OPEN");
	if (open) return { close: false, reason: `${by}, but PR #${open.number} from ${open.headRefName} is open: merge or close it first` };
	const u = f.unmerged[0];
	if (u) {
		return { close: false, reason: `${by}, but ${u.ref} has ${u.commits.length} commit(s) not in ${f.baseName}, first ${sha7(u.commits[0]!)}: merge them, or delete the branch` };
	}
	return { close: true, why: `${by}: no open PR in the set and no unmerged commit on a bound branch` };
}

async function gatherSupersededFacts(s: CloseSet, standIn: StandIn): Promise<SupersededFacts> {
	const unmerged: { ref: string; commits: string[] }[] = [];
	for (const b of s.branches) {
		for (const ref of [`refs/heads/${b}`, `refs/remotes/origin/${b}`]) {
			const tip = await s.commitOf(ref);
			if (tip === null) continue;
			const commits = (await s.git(`git rev-list ${s.baseName}..${ref}`, ["rev-list", "--reverse", `${s.base}..${tip}`])).out.split("\n").filter((l) => l !== "");
			if (commits.length > 0) unmerged.push({ ref, commits });
		}
	}
	return { failure: null, standIn, baseName: s.baseName, prs: s.heads, unmerged };
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
 * over the facts git and gh give — `supersededFreshness` instead for a workload Jo superseded or
 * withdrew (`standIn`, PLAN wl-mv5i3lulwwbbi8 D2, wl-mv8s939084z1ts D5) — and a passed check carries the pin `commitCloseEntry`
 * publishes on. It fails closed: a profile whose block does not parse, a host with no exec in a git
 * checkout, and any git or gh call that cannot answer all refuse.
 */
export async function closeCheck(
	pi: SurfaceAPI, ledger: Ledger, env: Record<string, string | undefined>, id: string, repo: string, standIn: StandIn | null = null,
): Promise<CloseCheck> {
	const branch = branchName(id);
	const unanswered = (failure: string): CloseCheck => ({ served: true, pin: null, decision: closeFreshness({ failure, branch, defaultBranch: "", candidate: { sha: "", changed: [] }, prs: [] }) });
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
		decision = standIn ? supersededFreshness(await gatherSupersededFacts(s, standIn)) : closeFreshness(await gatherCloseFacts(exec, ledger, id, served.origin, s));
	} catch (err) {
		if (!(err instanceof Unanswered)) throw err;
		return unanswered(err.message);
	}
	return { served: true, decision, pin: decision.close ? { sha: candidate, ownerRepo: served.origin } : null };
}
