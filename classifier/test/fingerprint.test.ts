/**
 * The read-only repository fingerprint a review hand is checked against (PLAN wl-mupu0sx2o046io D2
 * check 2): every change a `bash` write can make to the work moves it, and taking it writes nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { repoFingerprint } from "../src/fingerprint";
import { tmpDir } from "../../ledger/test/tmp";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		chmodTree(join(dir, ".git"), 0o700, 0o600);
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * `init.defaultBranch=main` is pinned: T11 clones a bare remote whose HEAD names the default branch,
 * and without it the clone comes up on an unborn `master` whose root commit cannot fast-forward
 * `main`. Apple's system gitconfig sets main; the as2test runner (GIT_CONFIG_NOSYSTEM=1) does not
 * read it (item 24, run tr-0mv0ks648wy8d2q).
 */
function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString();
}

/** A repository with one commit: a.txt, a script, a symlink, and an ignored file. */
function scratchRepo(): string {
	const dir = tmpDir("fingerprint-");
	dirs.push(dir);
	git(dir, "init", "-q");
	writeFileSync(join(dir, "a.txt"), "one\n");
	writeFileSync(join(dir, "run.sh"), "echo hi\n");
	writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
	symlinkSync("a.txt", join(dir, "link"));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	writeFileSync(join(dir, "ignored.log"), "noise\n");
	return dir;
}

function chmodTree(path: string, dirMode: number, fileMode: number): void {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return;
	}
	if (stat.isDirectory()) {
		chmodSync(path, dirMode);
		for (const name of readdirSync(path)) chmodTree(join(path, name), dirMode, fileMode);
	} else chmodSync(path, fileMode);
}

describe("repoFingerprint", () => {
	test("is stable while nothing changes, and an ignored file does not move it", () => {
		const repo = scratchRepo();
		const before = repoFingerprint(repo);
		expect(repoFingerprint(repo)).toBe(before);
		writeFileSync(join(repo, "ignored.log"), "more noise\n");
		expect(repoFingerprint(repo)).toBe(before);
	});

	test("a worktree edit, a new untracked file and a deleted tracked file each move it", () => {
		const repo = scratchRepo();
		const before = repoFingerprint(repo);
		writeFileSync(join(repo, "a.txt"), "two\n");
		const edited = repoFingerprint(repo);
		expect(edited).not.toBe(before);
		writeFileSync(join(repo, "new.txt"), "x\n");
		const added = repoFingerprint(repo);
		expect(added).not.toBe(edited);
		unlinkSync(join(repo, "run.sh"));
		expect(repoFingerprint(repo)).not.toBe(added);
	});

	test("a change staged only in the index moves it, though the worktree is back as it was (T3)", () => {
		const repo = scratchRepo();
		const before = repoFingerprint(repo);
		writeFileSync(join(repo, "a.txt"), "staged\n");
		git(repo, "add", "a.txt");
		writeFileSync(join(repo, "a.txt"), "one\n");
		expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("a.txt");
		expect(repoFingerprint(repo)).not.toBe(before);
	});

	test("a commit on the lane's branch and a stash of a change made before the snapshot move it; a new branch does not", () => {
		const repo = scratchRepo();
		const start = repoFingerprint(repo);
		git(repo, "branch", "side");
		expect(repoFingerprint(repo)).toBe(start); // refs are out: another lane's branches share this repository
		writeFileSync(join(repo, "a.txt"), "dirty\n");
		const dirty = repoFingerprint(repo);
		git(repo, "stash", "-q");
		const stashed = repoFingerprint(repo);
		expect(stashed).not.toBe(dirty); // the worktree change it held is gone
		git(repo, "commit", "-q", "--allow-empty", "-m", "empty");
		expect(repoFingerprint(repo)).not.toBe(stashed);
	});

	test("T11: only the lane's own work moves it; another worktree's commit, a fetch and an index refresh do not", () => {
		const repo = scratchRepo();
		const remote = join(repo, "..", `${basename(repo)}-remote.git`);
		const other = join(repo, "..", `${basename(repo)}-other`);
		const clone = join(repo, "..", `${basename(repo)}-clone`);
		dirs.push(remote, other, clone);
		git(repo, "init", "-q", "--bare", remote);
		git(repo, "remote", "add", "origin", remote);
		git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
		git(repo, "fetch", "-q", "origin");
		git(repo, "worktree", "add", "-q", other, "-b", "other-lane");
		const start = repoFingerprint(repo);

		writeFileSync(join(other, "b.txt"), "another lane\n");
		git(other, "add", "-A");
		git(other, "commit", "-q", "-m", "another lane's commit");
		expect(repoFingerprint(repo)).toBe(start);

		git(repo, "clone", "-q", remote, clone);
		git(clone, "commit", "-q", "--allow-empty", "-m", "upstream");
		git(clone, "push", "-q", "origin", "HEAD:refs/heads/main");
		git(repo, "fetch", "-q", "origin");
		expect(git(repo, "rev-parse", "origin/main").trim()).toBe(git(clone, "rev-parse", "HEAD").trim());
		expect(repoFingerprint(repo)).toBe(start);

		const later = new Date(Date.now() + 120_000);
		for (const path of git(repo, "ls-files", "-z").split("\0").filter(Boolean)) {
			if (!lstatSync(join(repo, path)).isSymbolicLink()) utimesSync(join(repo, path), later, later);
		}
		git(repo, "status", "--porcelain");
		git(repo, "update-index", "-q", "--refresh");
		expect(repoFingerprint(repo)).toBe(start);

		const seen = [start];
		const moves = (what: string, change: () => void) => {
			change();
			const now = repoFingerprint(repo);
			expect({ what, moved: !seen.includes(now) }).toEqual({ what, moved: true });
			seen.push(now);
		};
		moves("a file edit", () => writeFileSync(join(repo, "a.txt"), "edited\n"));
		moves("an untracked file", () => writeFileSync(join(repo, "new.txt"), "x\n"));
		moves("git add", () => git(repo, "add", "new.txt"));
		moves("a commit on the lane's branch", () => git(repo, "commit", "-q", "-am", "lane commit"));
		moves("a branch switch", () => git(repo, "checkout", "-q", "-b", "elsewhere", "HEAD~1"));
	});

	test("an executable-bit change and a retargeted symlink each move it (review 4 note 4)", () => {
		const repo = scratchRepo();
		const before = repoFingerprint(repo);
		chmodSync(join(repo, "run.sh"), 0o755);
		const executable = repoFingerprint(repo);
		expect(executable).not.toBe(before);
		unlinkSync(join(repo, "link"));
		symlinkSync("run.sh", join(repo, "link"));
		expect(repoFingerprint(repo)).not.toBe(executable);
	});

	test("it runs no git write: it is taken unchanged from a repository whose .git is read-only", () => {
		const repo = scratchRepo();
		writeFileSync(join(repo, "a.txt"), "dirty\n"); // a dirty worktree is what an index refresh would write for
		const before = repoFingerprint(repo);
		chmodTree(join(repo, ".git"), 0o500, 0o400);
		expect(repoFingerprint(repo)).toBe(before);
		expect(readdirSync(join(repo, ".git")).filter(name => name.endsWith(".lock"))).toEqual([]);
	});

	test("a directory that is no repository throws, so a caller fails closed", () => {
		const dir = tmpDir("fingerprint-none-");
		dirs.push(dir);
		expect(() => repoFingerprint(dir)).toThrow(/rev-parse --show-toplevel/);
	});
});
