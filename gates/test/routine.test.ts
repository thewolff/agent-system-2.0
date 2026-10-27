// The routine classifier (PLAN wl-mvqwn80onq9hq8 D2, D2a, D2b): R1–R4 and R13. Real temp HOMEs with a
// real scratch root, a scratch repository and a linked worktree on the workload's own branch; each call
// is judged by routineVerdict as the gate's worker runs it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandShell } from "../src/exec";
import { allowListed, type RoutineContext, type RoutineVerdict, routineVerdict } from "../src/routine";
import { SCRATCH_ENV, scratchRootFor } from "../src/scratch";
import { parseShell } from "../src/shell-parse";
import { type Role, WORKLOAD_ENV } from "../src/types";
import { commit, git, tmp } from "./helpers";

const ID = "wl-r0utine1";
const OTHER = "wl-0ther33";
const HOME = realpathSync(tmp("routine"));
const ROOT = scratchRootFor(HOME, ID);
const OTHER_ROOT = scratchRootFor(HOME, OTHER);
mkdirSync(ROOT, { recursive: true });
mkdirSync(join(OTHER_ROOT, "r"), { recursive: true });

// A repository inside the scratch root, with a dirty file.
const REPO = join(ROOT, "r");
mkdirSync(REPO);
git(REPO, "init", "-q", "-b", "main");
commit(REPO, "f", "one\n");
writeFileSync(join(REPO, "f"), "dirty\n");

// The workload's own worktree: a linked worktree of an outside repository on `wl/<id>`.
const MAIN = realpathSync(tmp("routine-main"));
git(MAIN, "init", "-q", "-b", "main");
commit(MAIN, "f", "one\n");
const WT = join(realpathSync(tmp("routine-wt")), "wt");
git(MAIN, "worktree", "add", "-q", WT, "-b", `wl/${ID}`);
writeFileSync(join(WT, "f"), "dirty\n");
mkdirSync(join(WT, "build"));
const NESTED = join(WT, "nested");
mkdirSync(NESTED);
git(NESTED, "init", "-q", "-b", "main");
commit(NESTED, "g", "one\n");
// A second worktree on another branch, for the reset rule.
const WT2 = join(realpathSync(tmp("routine-wt2")), "wt");
git(MAIN, "worktree", "add", "-q", WT2, "-b", "other");

const ENV: Record<string, string | undefined> = { HOME, PATH: process.env.PATH, [WORKLOAD_ENV]: ID, [SCRATCH_ENV]: ROOT };

interface Over {
	role?: Role;
	cwd?: string;
	worktreeRoot?: string | null;
	env?: Record<string, string>;
	toolName?: string;
}

function verdict(command: string, over: Over = {}): RoutineVerdict {
	const ctx: RoutineContext = { role: over.role ?? "lane", cwd: over.cwd ?? HOME, env: ENV, mode: null };
	const tree = over.worktreeRoot === undefined ? WT : over.worktreeRoot;
	if (tree !== null) ctx.worktreeRoot = tree;
	const input: Record<string, unknown> = over.env ? { command, env: over.env } : { command };
	return routineVerdict({ toolName: over.toolName ?? "bash", input }, ctx);
}

/** The rule a call auto-applies under, or `ask`. */
function rule(command: string, over?: Over): string {
	const v = verdict(command, over);
	return "ask" in v ? "ask" : v.rule;
}

const asks = (command: string, over?: Over): string => {
	const v = verdict(command, over);
	expect({ command, ask: "ask" in v }).toEqual({ command, ask: true });
	return "ask" in v ? v.ask : "";
};

/** allowListed over the one command a string expands to. */
function listed(command: string): string | null {
	const x = expandShell(command, HOME, ENV);
	expect(x.commands.length).toBe(1);
	return allowListed(x.commands[0]!);
}

describe("R1: case 1 only when every simple command at every depth is allow-listed", () => {
	test("a gh read loop over unknown numbers is read-only with network", () => {
		const v = verdict("for p in 304 305; do gh pr view $p --json state; done");
		expect(v).toEqual({ rule: "read-only", detail: "read-only: for, gh", network: true, readers: [] });
	});

	test("a plain reader beside gh is named for the exec allow-list", () => {
		const v = verdict('gh pr view $p --json body | jq -r .body | head -n 5');
		expect(v).toEqual({ rule: "read-only", detail: "read-only: gh, jq, head", network: true, readers: ["head", "jq"] });
	});

	test("a redirect to a file asks, on any command or an argv-less one", () => {
		expect(asks("gh pr view $p --json state > out.json")).toContain("redirect");
		expect(asks("gh pr view $p; > f")).toContain("redirect");
		expect(asks("gh pr view $p; >| f")).toContain("redirect");
		expect(asks("gh pr view $p; &> f")).toContain("redirect");
		expect(asks('gh pr view $p > "$AS2_SCRATCH/out"')).toContain("redirect");
		expect(rule("gh pr view $p > /dev/null")).toBe("read-only");
	});

	test("a command inside a substitution, a heredoc or a process substitution is walked too", () => {
		expect(asks("gh pr view $(ls; touch f)")).toContain("touch");
		expect(asks("gh pr view $p; cat <<EOF\n$(mkdir d)\nEOF")).toContain("mkdir");
		expect(asks("gh pr view $p; diff <(ls) <(touch f)")).toContain("not read-only");
		expect(asks("gh pr view $p; cat <(ls)")).toContain("not read-only");
	});

	test("wrappers, keywords other than for and braces, and unknown programs ask", () => {
		expect(asks("gh pr view $p | xargs echo")).toContain("xargs");
		expect(asks("while true; do gh pr view $p; done")).toContain("while");
		expect(asks("if true; then gh pr view $p; fi")).toContain("if");
		expect(asks("gh pr view $p; case x in x) ls;; esac")).toContain("case");
		expect(asks("gh pr view $p; exec ls")).toContain("exec");
		expect(asks("gh pr view $p; X=1 ls")).toContain("assignment");
		expect(asks("gh pr view $p; env ls")).toContain("env");
		expect(asks("gh pr view $p; /bin/ls")).toContain("literal");
		expect(rule("{ gh pr view $p; ls; }")).toBe("read-only");
	});

	test("gh's stderr must reach the result in a network call", () => {
		expect(asks("gh pr view $p 2>/dev/null")).toContain("stderr");
		expect(asks("gh pr view $p 2>&1 | cat")).toContain("stderr");
		expect(asks("{ gh pr view $p; } 2>/dev/null")).toContain("stderr");
		expect(asks("(gh pr view $p) &>/dev/null")).toContain("stderr");
		expect(asks("gh pr view $p |& cat")).toContain("|&");
	});

	test("gh read flags: documented non-writing ones pass, --web and unknown ones ask", () => {
		expect(rule("gh pr checks $p --required --json name,state")).toBe("read-only");
		expect(rule("gh run list $x --workflow ci -L 5 --json status -R o/r")).toBe("read-only");
		expect(asks("gh pr view $p --web")).toContain("--web");
		expect(asks("gh pr view $p -w")).toContain("-w");
		expect(asks("gh pr comment $p --body x")).toContain("pr comment");
		expect(asks("gh pr merge $p")).toContain("pr merge");
	});

	test("allowListed: redirects to /dev/null and fd dups only", () => {
		expect(listed("cat f > /dev/null 2>&1")).toBeNull();
		expect(listed("cat f 2>&-")).toBeNull();
		expect(listed("cat f > out")).toContain("redirect");
		expect(listed("cat f >> /tmp/x")).toContain("redirect");
		expect(listed("cat f >&out")).toContain("redirect");
		expect(listed("cat < f")).toContain("redirect");
		expect(listed("cat <<<hi")).toBeNull();
	});

	test("allowListed: plain readers keep to their option sets", () => {
		for (const ok of ["ls -la src", "head -20 f", "tail -n 5 f", "wc -l f", "sort -rn -k 2 f", "uniq -c f", "cut -d : -f 1 f", "grep -rn --include '*.ts' foo src", "rg -n --glob '*.ts' foo", "jq -r --arg k v .x f", "find . -name '*.ts' -type f -print", "sed -n '1,5p' f", "sed -E -e 's/a/b/g' -e '/x/d' f", "date +%s", "date -u -r 0", "sleep 1", "printf '%s\\n' a", "echo hi", "test -f f", "[ -d d ]", "diff -u a b", "comm -12 a b", "tr a-z A-Z", "basename /a/b .ts", "realpath -q x", "stat -f %z f"]) {
			expect({ ok, why: listed(ok) }).toEqual({ ok, why: null });
		}
		for (const no of ["sort -o out f", "sort --output=out f", "sort -T /tmp f", "uniq in out", "find . -delete", "find . -fprint out", "rg --pre cat x", "rg --pre-glob '*' x", "rg -z x", "rg --hostname-bin sh x", "sed -i s/a/b/ f", "sed 's/a/b/w out' f", "sed 's/a/b/e' f", "sed 'r f' g", "sed 'e ls' f", "sed -n p f -i", "date -s 0101", "date 0101", "printf -v X hi", "file -C", "ls --constructor", "tail -f f", "pwd x", "cd /", "awk 1 f", "tee f", "touch f", "mkdir d", "cp a b", "mv a b"]) {
			expect({ no, why: listed(no) === null }).toEqual({ no, why: false });
		}
		// find -exec runs its command: the expander records it as a command of its own, and -exec asks.
		expect(asks("gh pr view $p; find . -exec cat {} \\;")).toContain("-exec");
	});

	test("allowListed: a word with an unknown part passes only where it cannot be an option", () => {
		expect(listed('cat "src/$x"')).toBeNull();
		expect(listed('cat "$x"')).toContain("option");
		expect(listed("cat src/$x")).toContain("option");
		expect(listed("cat src/*.ts")).toBeNull();
		expect(listed("cat *.ts")).toContain("option");
		expect(listed('grep -e "$x" f')).toBeNull();
		expect(listed("grep -e $x f")).toContain("value");
	});
});

describe("R2: gh api counts only as a GET with one endpoint under a literal REST root", () => {
	test("a GET whose endpoint has a quoted unknown part after a REST root is read-only", () => {
		// The substitution's command runs first, so it is named first.
		expect(verdict('gh api "repos/o/r/commits/$(cat "$AS2_SCRATCH/sha")" --jq .sha')).toEqual({ rule: "read-only", detail: "read-only: cat, gh", network: true, readers: ["cat"] });
		expect(rule('gh api --method GET "repos/o/r/pulls/$(cat n)" -q .state')).toBe("read-only");
		expect(rule('gh api -X GET "search/issues?q=$(cat q)" --paginate --slurp')).toBe("read-only");
		expect(rule('gh api "user/$(cat f)" --silent -i')).toBe("read-only");
		expect(rule('gh api "rate_limit$(cat f)"')).toBe("read-only");
	});

	test("any other method, a field or an input asks", () => {
		asks('gh api -X POST "repos/o/r/statuses/$(cat f)"');
		asks('gh api --method=PATCH "repos/o/r/$(cat f)"');
		asks('gh api -f state=success "repos/o/r/statuses/$(cat f)"');
		expect(asks('gh api -f a=1 "repos/o/r/pulls/$(cat f)"')).toContain("-f");
		expect(asks('gh api -F a=1 "repos/o/r/$(cat f)"')).toContain("-F");
		expect(asks('gh api --field a=1 "repos/o/r/$(cat f)"')).toContain("--field");
		expect(asks('gh api --raw-field a=1 "repos/o/r/$(cat f)"')).toContain("--raw-field");
		expect(asks('gh api --input body.json "repos/o/r/$(cat f)"')).toContain("--input");
	});

	test("options outside the set ask", () => {
		expect(asks('gh api -H "Accept: x" "repos/o/r/$(cat f)"')).toContain("-H");
		expect(asks('gh api --hostname h "repos/o/r/$(cat f)"')).toContain("--hostname");
		expect(asks('gh api --cache 1h "repos/o/r/$(cat f)"')).toContain("--cache");
	});

	test("graphql, a missing or split root, a `..` segment or two endpoints ask", () => {
		asks('gh api graphql -f query="$(cat q)"');
		expect(asks('gh api "graphql$(cat f)"')).toContain("REST roots");
		expect(asks('gh api "$(cat f)/x"')).toContain("endpoint starting ``");
		expect(asks("gh api repos/$(cat f)/x")).toContain("split");
		expect(asks('gh api "orgs/../graphql$(cat f)"')).toContain("REST roots");
		expect(asks('gh api "repos/o/r/$(cat f)" repos/o/r')).toContain("2 endpoint");
		expect(asks('gh api "notifications$(cat f)"')).toContain("REST roots");
	});

	test("git in a network call asks: the sha is spelled literally instead", () => {
		expect(asks('gh api "repos/o/r/commits/$(git rev-parse HEAD)"')).toContain("git");
	});
});

describe("R3: git read forms exclude every write to refs, config, the index or the network", () => {
	test("the read forms pass", () => {
		for (const ok of ["git log --oneline -5", "git -C /x --no-pager log", "git show HEAD:f", "git diff HEAD~1 -- f", "git rev-parse HEAD", "git rev-list --count HEAD", "git ls-files", "git ls-tree HEAD", "git cat-file -p HEAD", "git merge-base a b", "git describe --tags", "git blame f", "git shortlog -s", "git grep -n foo", "git name-rev HEAD", "git for-each-ref refs/heads", "git status --porcelain", "git status -sb", "git symbolic-ref --short HEAD", "git branch --list 'wl/*'", "git branch -a -v", "git tag -l 'v*'", "git tag", "git remote -v", "git remote get-url origin", "git config --get user.name", "git config --list", "git worktree list --porcelain", "git stash list", "git reflog show"]) {
			expect({ ok, why: listed(ok) }).toEqual({ ok, why: null });
		}
	});

	test("writes and network forms ask", () => {
		for (const no of ["git fetch", "git pull", "git push", "git gc", "git commit -m x", "git add f", "git checkout x", "git switch x", "git reset", "git restore f", "git merge x", "git rebase main", "git update-ref refs/heads/x HEAD", "git config user.name x", "git config --unset user.name", "git config --add a.b c", "git branch new", "git branch -d x", "git branch -m a b", "git tag v1", "git tag -d v1", "git remote add o u", "git remote prune origin", "git worktree add x", "git stash", "git stash push", "git reflog expire --all", "git log --output=/tmp/x", "git diff --output x", "git grep -O foo", "git status -uno", "git symbolic-ref HEAD refs/heads/x", "git -c a.b=c log", "git --git-dir=x log", "git ls-remote", "git submodule update", "git notes add"]) {
			expect({ no, why: listed(no) === null }).toEqual({ no, why: false });
		}
	});
});

describe("R4: case 2 only for rm and git discards confined to one own root, never across &", () => {
	test("rm -rf of a relative path in the scratch root, reached by a scratch-spelled cd", () => {
		expect(verdict('cd "$AS2_SCRATCH/r" && rm -rf build out')).toEqual({ rule: "scratch", detail: "scratch: rm", network: false, root: ROOT });
		expect(rule("rm -rf build", { cwd: REPO })).toBe("scratch");
		expect(rule(`cd ${REPO} && rm -rf build`)).toBe("scratch");
		expect(rule('cd "$AS2_SCRATCH/r" && git reset --hard && rm -rf build')).toBe("scratch");
	});

	test("a cd before & does not carry over to what follows it", () => {
		expect(asks('cd "$AS2_SCRATCH/r" & rm -rf build')).toContain("rm -rf");
		expect(asks('cd "$AS2_SCRATCH/r" && true & rm -rf build')).toContain("rm -rf");
		expect(asks('{ cd "$AS2_SCRATCH/r"; } & rm -rf build')).toContain("rm -rf");
		expect(rule('cd "$AS2_SCRATCH/r" && rm -rf build & ls')).toBe("scratch");
	});

	test("a target outside the root, the root itself, `..`, another root or an untrusted hop asks", () => {
		asks("rm -rf build");
		asks('cd "$AS2_SCRATCH" && rm -rf .');
		asks('cd "$AS2_SCRATCH/r" && rm -rf ../../x');
		asks(`cd ${OTHER_ROOT}/r && rm -rf build`);
		asks('cd "$AS2_SCRATCH/r/../.." && rm -rf build');
		asks("cd $D && rm -rf build", { env: { D: REPO } });
		asks('cd "$AS2_SCRATCH/r" && rm -rf $x');
		asks('cd "$AS2_SCRATCH/r" && rm -rf b*');
	});

	test("every other reserved action in the call still refuses", () => {
		asks('cd "$AS2_SCRATCH/r" && rm -rf build && git push --force origin main');
		asks('cd "$AS2_SCRATCH/r" && rm -rf build; rm -rf /opt/x');
	});

	test("the own worktree: rm targets inside it, never its root or .git", () => {
		expect(verdict("rm -rf build", { cwd: WT })).toEqual({ rule: "worktree", detail: "worktree: rm", network: false, root: WT });
		expect(rule(`cd ${WT} && rm -rf build/x f`)).toBe("worktree");
		asks("rm -rf .", { cwd: WT });
		asks("rm -rf .git", { cwd: WT });
		asks("rm -rf build/.git", { cwd: WT });
		asks(`rm -rf ${WT}`);
		asks("rm -rf build", { cwd: WT, worktreeRoot: null });
	});

	test("the own worktree: the work-tree discards lift, reset --hard and ref deletion never", () => {
		expect(verdict("git clean -fdx && rm -rf build", { cwd: WT })).toEqual({ rule: "worktree", detail: "worktree: git: git clean (removes untracked files; force in any position or spelling, or clean.requireForce off), rm", network: false, root: WT });
		expect(rule("git checkout -- f && rm -rf build", { cwd: WT })).toBe("worktree");
		expect(rule("git restore f", { cwd: WT })).toBe("worktree");
		expect(rule("git checkout --force HEAD", { cwd: WT })).toBe("worktree");
		expect(rule("git reset --keep HEAD", { cwd: WT })).toBe("worktree");
		expect(rule(`git switch --discard-changes wl/${ID}`, { cwd: WT })).toBe("worktree");
		expect(rule("git checkout HEAD f", { cwd: WT })).toBe("worktree");
		// A repository nested inside the worktree is not the worktree's own.
		asks("git clean -fdx", { cwd: NESTED });
		expect(rule(`git -C ${WT} restore f`)).toBe("worktree");
		asks("git reset --hard", { cwd: WT });
		asks("git reset --hard --merge", { cwd: WT });
		asks("git branch -D x", { cwd: WT });
		asks("git tag -d v1", { cwd: WT });
		asks("git push --force origin x", { cwd: WT });
		asks("git restore f", { cwd: MAIN });
	});

	test("a worktree reset needs the workload's own attached branch and no switch in the call", () => {
		expect(asks("git reset --merge HEAD", { cwd: WT2, worktreeRoot: WT2 })).toContain("branch other");
		expect(asks("git reset --merge HEAD && git switch main", { cwd: WT })).toContain("switch");
	});

	test("one call never mixes roots", () => {
		// The test HOME is a temp directory, where an absolute rm -rf is not reserved at all: the scratch side is a git discard.
		expect(asks('git -C "$AS2_SCRATCH/r" reset --hard && rm -rf build', { cwd: WT })).toContain("mixes roots");
	});
});

describe("R13: NOW-reserved actions, the orchestrator and § A4 actions outside the own roots never auto-apply", () => {
	test("NOW-reserved actions ask", () => {
		expect(asks('cd "$AS2_SCRATCH/r" && git push --force origin x')).toContain("NOW-reserved");
		expect(asks("gh pr merge --admin 1")).toContain("NOW-reserved");
		expect(asks("terraform destroy")).toContain("NOW-reserved");
		expect(asks("gh workflow run deploy.yml")).toContain("NOW-reserved");
	});

	test("an orchestrator's, or any role but lane or hand, asks", () => {
		expect(asks("for p in 1; do gh pr view $p; done", { role: "orchestrator" })).toContain("orchestrator");
		expect(rule("for p in 1; do gh pr view $p; done", { role: "hand" })).toBe("read-only");
	});

	test("any tool but bash, the bash tool's env, and a call row 6 lets through ask", () => {
		expect(asks("x", { toolName: "eval" })).toContain("eval");
		expect(asks("for p in 1; do gh pr view $p; done", { env: { A: "1" } })).toContain("env");
		expect(asks("ls")).toContain("does not refuse");
	});

	test("a parse failure, an oversized call and an unseen command ask", () => {
		expect(asks("gh pr view $p 'x")).toContain("parse");
		expect(asks(`gh pr view $p; ${"ls; ".repeat(70)}`)).toContain("simple commands");
		expect(asks(`gh pr view $p # ${"x".repeat(5000)}`)).toContain("4096");
		asks("gh pr view $p | sh");
	});

	test("rm -rf and discards outside the own roots ask", () => {
		asks("rm -rf build", { cwd: MAIN });
		asks("git clean -fd", { cwd: MAIN });
		asks(`git -C ${OTHER_ROOT}/r reset --hard`);
	});
});

describe("the parser behind it", () => {
	test("a list ended by & runs in a subshell: the directory after it is the one before it", () => {
		const dirs = (cmd: string) => expandShell(cmd, HOME, ENV).commands.map((e) => [e.argv[0]!.text, e.dir]);
		expect(dirs("cd /a && true & pwd")).toEqual([["cd", HOME], ["true", "/a"], ["pwd", HOME]]);
		expect(dirs("cd /a; cd /b & pwd")).toEqual([["cd", HOME], ["cd", "/a"], ["pwd", "/a"]]);
		expect(dirs("{ cd /a; } & pwd")).toEqual([["cd", HOME], ["pwd", HOME]]);
		expect(dirs("cd /a && pwd")).toEqual([["cd", HOME], ["pwd", "/a"]]);
	});

	test("Word.splits: false only when every unknown part is quoted", () => {
		const word = (cmd: string) => parseShell(cmd, { cwd: HOME, env: {} }).commands.at(-1)!.words[1]!;
		expect(word('echo "repos/$(x)/y"').splits).toBe(false);
		expect(word("echo repos/$(x)/y").splits).toBe(true);
		expect(word('echo "$@"').splits).toBe(true);
		expect(word('echo "${a[@]}"').splits).toBe(true);
		expect(word('echo "$x"y').splits).toBe(false);
		expect(word("echo plain").splits).toBeUndefined();
	});

	test("compounds lists keywords at every depth", () => {
		expect(parseShell("x=$(if a; then b; fi)", { cwd: HOME, env: {} }).compounds).toEqual(["if", "then", "fi"]);
	});
});
