// M4 fix round 6 regression tests (fix-6/BRIEF.md): astra-6 (review-astra-6/REVIEW.md) B1–B9 and
// S1–S3. Every probe string from review-astra-6/PROBES.md is here verbatim with its verdict after this
// round; the probes the review found wrong carry the finding they close. Class variants follow per
// finding. Every probe is inert: the gate only reads the strings; targets sit under /not-real, which
// nothing creates. The push remedy runs real git inside a test-owned temp repo.
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolCall } from "../src/gates";
import { checkTurnShape } from "../src/rows/r01-turn-shape";
import { checkReserved } from "../src/rows/r06-reserved";
import { checkPushRebase } from "../src/rows/r08-push-rebase";
import { checkRawLedgerWrite } from "../src/rows/r10-raw-ledger";
import type { CallContext, Refusal } from "../src/types";
import { advanceOriginMain, commit, git, repoWithOrigin, testRecord, tmp } from "./helpers";

/** An inert repository: two commits on `topic` (so a push of the current branch is not a push to main), a `gates` directory, no origin. */
const repo = realpathSync(tmp("round6-repo"));
git(repo, "init", "-q", "-b", "main");
git(repo, "commit", "-q", "--allow-empty", "-m", "one");
git(repo, "commit", "-q", "--allow-empty", "-m", "two");
git(repo, "switch", "-q", "-c", "topic");
writeFileSync(join(repo, "file.txt"), "x\n");
mkdirSync(join(repo, "gates"));

const ctx: CallContext = { role: "lane", cwd: repo, env: { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" } };
const call = (toolName: string, input: Record<string, unknown>) => ({ toolName, input });
const verdict = (r: Refusal): "ALLOW" | "REFUSE" => (r === null ? "ALLOW" : "REFUSE");
/** Rows 6 and 10, as the review's probes ran them: the repo is on `main` with no origin, so rows 8 and 9 would refuse a push or an edit for their own reasons. */
const bash = (command: string) => {
	const c = call("bash", { command });
	return verdict(checkReserved(c, ctx) ?? checkRawLedgerWrite(c, ctx));
};
const reason = (command: string) => {
	const c = call("bash", { command });
	return (checkReserved(c, ctx) ?? checkRawLedgerWrite(c, ctx))?.reason ?? "";
};
const evalCode = (language: "py" | "js", code: string) => verdict(checkToolCall(call("eval", { language, code }), ctx));
const turn = (text: string) => verdict(checkTurnShape(text, "lane", { batch: null }));
const RM = "r" + "m";

type V = "ALLOW" | "REFUSE";
/** [probe section, the finding it closes or "" for an unchanged control, command, verdict now]. */
const COMMANDS: [string, string, string, V][] = [
	["P01", "rejected candidate", "git push --repo=origin HEAD:main", "ALLOW"],
	["P01", "rejected candidate", "git push --repo origin +HEAD:topic", "ALLOW"],
	["P01", "B2", "git config --file get core.hooksPath /not-real/hooks", "REFUSE"],
	["P01", "B1", "git worktree add -Bmain /not-real/tree", "REFUSE"],
	["P01", "B1", "git symbolic-ref --del HEAD", "REFUSE"],
	["P01", "B1", "git symbolic-ref -qd HEAD", "REFUSE"],
	["P01", "B1", "git submodule update --for", "REFUSE"],
	["P01", "B1", "git submodule update -fq", "REFUSE"],
	["P01", "B1", "git stash frobnicate", "REFUSE"],
	["P01", "B1", "git reflog --frobnicate", "REFUSE"],
	["P01", "B1", "git remote show --frobnicate", "REFUSE"],
	["P01", "B1", "git bisect --frobnicate", "REFUSE"],
	["P01", "B3", "git restore --staged --no-staged file", "REFUSE"],
	["P01", "B4", "git merge -s ort -s custom topic", "REFUSE"],
	["P01", "B5", "git diff --ext-diff", "REFUSE"],
	["P01", "B5", "git log --textconv -p", "REFUSE"],
	["P01", "B5", "git cat-file --filters HEAD:file", "REFUSE"],
	// Outside .git and not the ledger: an ordinary scratch file (B5 is the .git and ledger targets).
	["P01", "", "git apply --build-fake-ancestor=/not-real/index patch", "ALLOW"],
	["P01", "B5", "git help --web status", "REFUSE"],
	["P01", "S1", "git grep -eFOO", "ALLOW"],
	// Accepted malformed candidate: git exits 128 (`--max-count` needs a number) and writes nothing.
	["P01", "", "git log --max-count -- --output=/not-real/file", "ALLOW"],
	["P01", "", "git status --porcelain=invalid", "ALLOW"],
	["P01", "", "env -i git status", "REFUSE"],
	["P01", "", "env -- git status", "REFUSE"],
	["P01", "", "env PATH=/not-real git status", "REFUSE"],
	["P01", "", "env GIT_DIR=/not-real git status", "REFUSE"],
	["P01", "", "env GIT_SSH_COMMAND=oops git fetch origin", "REFUSE"],
	["P01", "", `${RM} -r /tmp/../not-real`, "ALLOW"],
	["P01", "", `${RM} --recursiv /not-real`, "ALLOW"],
	["P01", "", 'psql -h prod* -c "SELECT 1"', "REFUSE"],
	["P01", "B6", "xxd /dev/null /not-real/ledger.db", "REFUSE"],
	["P01", "B6", "xxd -g1 /not-real/ledger.db /not-real/ledger.db", "REFUSE"],
	["P03", "", "git lfs ls-files", "REFUSE"],
	["P03", "", "git lfs status", "REFUSE"],
	["P03", "", "git lfs env", "REFUSE"],
	["P03", "", "git lfs version", "REFUSE"],
	["P03", "", "git lfs locks", "REFUSE"],
	["P03", "", "git absorb --help", "REFUSE"],
	["P03", "", "git absorb --dry-run", "REFUSE"],
	["P03", "", "git town status", "REFUSE"],
	["P03", "", "git town config", "REFUSE"],
	["P03", "", "git town version", "REFUSE"],
	["P03", "", "git status --porcelain=v2", "ALLOW"],
	["P03", "", "git diff --name-only --diff-filter=ACM", "ALLOW"],
	["P03", "", "git log --format=%H -3", "ALLOW"],
	["P03", "", "git rev-parse --show-prefix", "ALLOW"],
	["P03", "", 'git -C "" status --short', "ALLOW"],
	["P03", "", "git -C ./gates/.. status --short", "ALLOW"],
	// PROBES.md spelled Jo's checkout (/Users/jowolff/code/agent-system-2.0/.); the probe is an absolute
	// `-C` ending in `/.`, so it names this test's own repository and holds for any uid (item 24, run tr-0mv0ks648wy8d2q).
	["P03", "", `git -C ${repo}/. log -1`, "ALLOW"],
	["P03", "", "git -c color.ui=never diff --stat", "ALLOW"],
	["P03", "", "git -c core.quotepath=false ls-files", "ALLOW"],
	["P03", "", "git -c user.email=review@example.invalid status", "ALLOW"],
	["P03", "", "git ls-tree HEAD gates", "ALLOW"],
	["P03", "", "git check-ignore --no-index gates/src/index.ts", "ALLOW"],
	["P03", "", "git config --list --show-origin", "ALLOW"],
	["P03", "", "git version --build-options", "ALLOW"],
	["P03", "", "git maintenance -h", "ALLOW"],
	["P03", "", "git reflog show -3", "ALLOW"],
	["P03", "", "git stash show --stat", "ALLOW"],
	["P03", "", "git range-diff HEAD~2..HEAD~1 HEAD~1..HEAD", "ALLOW"],
	["P03", "", "git diff --word-diff=porcelain", "ALLOW"],
	["P03", "", "git grep -n literal -- gates", "ALLOW"],
	["P03", "", "bun pm ls", "ALLOW"],
	["P03", "", "bun outdated", "ALLOW"],
	["P03", "", "npm ls --depth=0", "ALLOW"],
	["P03", "", "pnpm exec vitest --help", "ALLOW"],
	["P03", "", "docker compose config --services", "ALLOW"],
	["P03", "", "gh repo view --json nameWithOwner", "ALLOW"],
	["P03", "", 'sqlite3 -readonly /not-real/ledger.db ".schema"', "ALLOW"],
	["P03", "", 'sqlite3 -readonly /not-real/ledger.db "PRAGMA user_version"', "ALLOW"],
	["P03", "", 'sqlite3 -readonly /not-real/ledger.db "SELECT count(*) FROM entries"', "ALLOW"],
	["P03", "", 'git -C "$PWD/gates" status', "REFUSE"],
	["P09", "", "git apply --build-fake-ancestor=/not-real/ledger.db patch", "REFUSE"],
	["P09", "B7", "GIT_TRACE=/not-real/ledger.db git status", "REFUSE"],
	["P09", "", `${RM} -rf /tmp/../not-real`, "REFUSE"],
	["P09", "", `${RM} --recu --forc /tmp/not-real`, "ALLOW"],
	["P09", "", `${RM} --recu --forc /not-real`, "REFUSE"],
	["P09", "", `${RM} -rf /tmp/not-real/../cache`, "REFUSE"],
	["P09", "", "git reset --h", "REFUSE"],
	["P09", "", "git reset --har", "REFUSE"],
	["P09", "", "git reset --unknown", "REFUSE"],
	["P09", "", "git -C gates/src/exec.ts/.. status", "REFUSE"],
	["P09", "", `sqlite3 -readonly /not-real/ledger.db 'SELECT "writefile"('"'"'/not-real/ledger.db'"'"','"'"'x'"'"')'`, "REFUSE"],
	["P09", "", `sqlite3 -readonly /not-real/ledger.db 'SELECT [writefile]('"'"'/not-real/ledger.db'"'"','"'"'x'"'"')'`, "REFUSE"],
	["P09", "", `sqlite3 -readonly /not-real/ledger.db 'SELECT \`writefile\`('"'"'/not-real/ledger.db'"'"','"'"'x'"'"')'`, "REFUSE"],
	["P09", "", "sqlite3 -readonly /not-real/ledger.db 'PRAGMA user_version(123)'", "REFUSE"],
	["P09", "", `sqlite3 -readonly /not-real/ledger.db 'SELECT "abs"(-2)'`, "ALLOW"],
	["P13", "B5", "git apply --build-fake-ancestor=.git/index /not-real/patch", "REFUSE"],
	["P13", "B5", "git apply --build-fake-ancestor=.git/objects/info/alternates /not-real/patch", "REFUSE"],
	["P13", "B5", "git show --ext-diff HEAD", "REFUSE"],
	["P13", "", "git rev-list --exec=printf HEAD", "REFUSE"],
	["P13", "", "git blame --output=/not-real/file HEAD -- file", "REFUSE"],
	["P13", "", "git diff -- --output=/not-real/file", "ALLOW"],
	["P13", "", "git reset --no-hard", "REFUSE"],
	["P13", "B1", "git worktree add --frobnicate /not-real/tree", "REFUSE"],
	["P13", "B1", "git submodule update --frobnicate", "REFUSE"],
	["P13", "", "git push --repo origin origin HEAD:main", "REFUSE"],
	["P13", "", "PATH=/not-real git status", "REFUSE"],
	["P13", "", "GIT_DIR=/not-real git status", "REFUSE"],
	["P13", "", "GIT_SSH_COMMAND=printf git status", "REFUSE"],
	["P13", "", `${RM} --recu --forc /tmp/../not-real/file`, "REFUSE"],
	["P13", "", 'sqlite3 -readonly "$DB" "SELECT 1"', "REFUSE"],
];

const CODE: [string, string, "py" | "js", string, V][] = [
	["P01", "B8", "js", 'const f=Bun.file("/not-real/ledger.db");f["writer"]()["write"]("x")', "REFUSE"],
	["P01", "B9", "js", 'import {Database as D} from "bun:sqlite";new D(process.env.DB)', "REFUSE"],
	["P01", "", "js", 'import {Database} from "bun:sqlite";new Database(process.env.DB)', "REFUSE"],
	["P01", "", "js", 'const f=Bun.file("/not-real/ledger.db");f.writer().write("x")', "REFUSE"],
	["P06", "", "py", 'open("/not-real/ledger.db", "r", encoding="utf8")', "ALLOW"],
	["P06", "", "js", 'const fs=require("node:fs");fs.openSync("/not-real/ledger.db","r")', "ALLOW"],
	["P06", "", "js", 'const fs=require("node:fs");fs.open("/not-real/ledger.db","r",()=>{})', "ALLOW"],
	["P09", "", "py", 'import os;os.open("/not-real/ledger.db",flags=os.O_RDONLY)', "ALLOW"],
	["P09", "", "py", 'import os;os.open("/not-real/ledger.db",flags=os.O_RDWR)', "REFUSE"],
];

const TURNS: [string, string, string, string, V][] = [
	["P04", "", "quoted prior", "**CLAIM**\nThe prompt says “Ready?”\n**QUESTION**\nMain or feature?", "ALLOW"],
	["P04", "", "inline prior", "**CLAIM**\nThe marker `**QUESTION**` is text.\n**QUESTION**\nMain or feature?", "ALLOW"],
	["P04", "", "and prior", "**QUESTION**\nMain or feature and today or tomorrow?", "REFUSE"],
	["P04", "", "comma prior", "**QUESTION**\nMain or feature, today or tomorrow?", "REFUSE"],
	["P04", "", "trailing spaces", "**QUESTION**  \nMain or feature?", "ALLOW"],
	["P04", "", "unicode label", "**ＱＵＥＳＴＩＯＮ**\nMain or feature?", "REFUSE"],
	["P04", "", "bullet asks", "**QUESTION**\nWhich changes?\n- Main or feature?\n- Today or tomorrow?", "REFUSE"],
	["P04", "", "legit options", "**QUESTION**\nWhich branch?\n- main\n- feature", "ALLOW"],
	["P04", "", "split fence", "**QUESTION**\nMain or feature?\n```ts\nconst x=1;\n```\nToday or tomorrow?", "REFUSE"],
	["P04", "", "indented label", "**CLAIM**\nExample:\n    **QUESTION**\n    Which branch?", "ALLOW"],
	["P04", "", "indented label and real", "**CLAIM**\nExample:\n    **QUESTION**\n    Which branch?\n**QUESTION**\nMain or feature?", "ALLOW"],
	["P04", "", "tilde shell", "**ACTION**\n~~~bash\ngit push origin main\n~~~", "REFUSE"],
	["P04", "", "four tick shell", "**ACTION**\n````bash\ngit push origin main\n````", "REFUSE"],
	["P04", "", "fenced labels", "**CLAIM**\n```md\n**QUESTION**\nWhat?\n```\n**QUESTION**\nMain or feature?", "ALLOW"],
	["P04", "S3", "quote after question", "**QUESTION**\nMain or feature?\n“Example text?”", "ALLOW"],
];

describe("astra-6 PROBES.md, every probe verbatim", () => {
	for (const [section, finding, command, want] of COMMANDS) {
		test(`${section}${finding ? ` ${finding}` : ""}: ${command} → ${want}`, () => expect(bash(command)).toBe(want));
	}
	for (const [section, finding, language, code, want] of CODE) {
		test(`${section}${finding ? ` ${finding}` : ""}: eval ${language} ${code} → ${want}`, () => expect(evalCode(language, code)).toBe(want));
	}
	for (const [section, finding, name, text, want] of TURNS) {
		test(`${section}${finding ? ` ${finding}` : ""}: turn "${name}" → ${want}`, () => expect(turn(text)).toBe(want));
	}
});

const each = (commands: string[], want: V) => {
	for (const command of commands) test(`${command} → ${want}`, () => expect(bash(command)).toBe(want));
};

describe("B1: every special-case handler parses its options first", () => {
	each(
		[
			"git worktree add -fBmain /not-real/tree",
			"git worktree add -B main /not-real/tree",
			"git worktree frobnicate",
			"git worktree remove /not-real/tree",
			"git worktree prune",
			"git stash list --frobnicate",
			"git stash show --frobnicate",
			"git stash drop",
			"git stash clear",
			"git reflog expire --all",
			"git reflog delete HEAD@{1}",
			"git remote --frobnicate",
			"git remote prune origin",
			"git remote remove origin",
			"git submodule --frobnicate",
			"git submodule foreach ls",
			"git submodule update --frob",
			"git bisect run make",
			"git symbolic-ref --delete HEAD",
			"git symbolic-ref HEAD refs/heads/other",
		],
		"REFUSE",
	);
	each(["git worktree list", "git worktree list --porcelain", "git stash list", "git stash show -p", "git reflog", "git reflog show HEAD", "git remote -v", "git remote show origin", "git symbolic-ref HEAD", "git symbolic-ref --short HEAD", "git submodule status", "git bisect log"], "ALLOW");
	test("the refusal names the unmodeled action", () => expect(reason("git stash frobnicate")).toContain("frobnicate"));
});

describe("B2: option values are never read as the config action", () => {
	each(["git config -f get core.hooksPath /not-real/hooks", "git config --file=get core.hooksPath /not-real/hooks", "git config --blob=list core.hooksPath x", "git config -l list", "git config core.hooksPath /not-real/hooks", "git config --unset user.name", "git config set core.hooksPath x"], "REFUSE");
	each(["git config --get user.name", "git config get user.name", "git config user.name", "git config list", "git config -l", "git config --get-regexp ^user"], "ALLOW");
});

describe("B3: a negated option sets the effective mode, last one wins", () => {
	each(["git restore --staged --no-staged file", "git restore --staged --worktree file", "git restore file", `git clean -n --no-dry-run`, "git clean --dry-run --no-dry-run -d"], "REFUSE");
	each(["git restore --no-staged --staged file", "git restore --staged file", "git clean -n", "git clean --no-dry-run --dry-run"], "ALLOW");
});

describe("B4: every merge-strategy value is checked", () => {
	each(["git merge -sort -scustom topic", "git merge --strategy=ort --strategy custom topic", "git merge -s custom topic", "git pull -s ort -s custom origin main"], "REFUSE");
	each(["git merge -s ort topic", "git merge -s ort -s recursive topic"], "ALLOW");
});

describe("B5: per-option effects from the generated OPEN table", () => {
	each(
		[
			"git diff --ext-dif",
			"git diff --textconv",
			"git log --show-signature",
			"git show --show-signature HEAD",
			"git stash show --ext-diff",
			"git reflog --ext-diff",
			"git grep -O foo",
			"git grep -Ovim foo",
			"git grep --open-files-in-pager=vim foo",
			"git help -w status",
			"git help -m status",
			"git fsck --lost-found",
			"git format-patch -o .git/hooks HEAD~1",
			"git gc --expire-to=.git/hooks",
			"git apply --build-fake-ancestor=sub/../.GIT/index patch",
			"git apply --unsafe-paths patch",
			"git archive -o /not-real/out.tar HEAD",
			"git diff --output=/not-real/file",
		],
		"REFUSE",
	);
	each(["git diff --no-ext-diff", "git log --no-textconv -p", "git format-patch -o /tmp/out HEAD~1", "git log -n 5", "git log --author foo", "git show HEAD --stat"], "ALLOW");
});

describe("S1: a short bundle stops at the option that takes the rest of the word", () => {
	each(["git grep -eFOO", "git grep -ieOpen", "git grep -e Open -- gates", "git log -SOpen"], "ALLOW");
	each(["git grep -iO foo", "git grep -nO foo"], "REFUSE");
});

describe("B6: a reader's output operands are write targets", () => {
	each(
		[
			"xxd -r hex /not-real/ledger.db",
			"xxd -cols 8 in /not-real/ledger.db",
			"xxd -c8 in /not-real/ledger.db",
			"xxd -z /not-real/ledger.db",
			"xxd /dev/null .git/config",
			"sort -o /not-real/ledger.db x",
			"sort --output=/not-real/ledger.db x",
			"sort -o.git/config x",
			"tee /not-real/ledger.db",
		],
		"REFUSE",
	);
	each(["xxd /not-real/ledger.db", "xxd -c 8 /not-real/ledger.db", "xxd -s -16 /not-real/ledger.db", "xxd .git/config", "sort /not-real/x", "cat /not-real/ledger.db"], "ALLOW");
});

describe("B7: path-valued git environment is target-checked, prefix and env alike", () => {
	each(
		[
			"env GIT_TRACE=/not-real/ledger.db git status",
			"GIT_TRACE2_EVENT=/not-real/ledger.db git status",
			"GIT_TRACE=.git/hooks/pre-commit git status",
			`GIT_TRACE=${repo}/.git/hooks/pre-commit git status`,
			"GIT_TRACE=af_unix:/tmp/s git status",
			"GIT_TRACE=trace.log git status",
			"GIT_TRACE=$NOT_SET/x git status",
			"GIT_TRACE_FOO=1 git status",
			"GIT_INDEX_FILE=/not-real/ledger.db git status",
			"GIT_WORK_TREE=/not-real git status",
			"GIT_OBJECT_DIRECTORY=/not-real git status",
			"GIT_CONFIG_GLOBAL=/not-real git status",
			"GIT_EXEC_PATH=/not-real git status",
			"GIT_PAGER=vim git log",
			"GIT_EDITOR=vim git commit",
		],
		"REFUSE",
	);
	each(["GIT_TRACE=1 git status", "GIT_TRACE=true git status", "GIT_TRACE=/tmp/trace.log git status", "GIT_PAGER=cat git log", "GIT_TERMINAL_PROMPT=0 git status"], "ALLOW");
});

describe("B8: bracket access is read as the member it names", () => {
	const B8: [string, V][] = [
		["const f=Bun.file('/not-real/ledger.db');f['writer']()['write']('x')", "REFUSE"],
		['const f=Bun.file("/not-real/ledger.db");f[`writer`]().write("x")', "REFUSE"],
		['const f=Bun.file("/not-real/ledger.db");f [ "writer" ]().write("x")', "REFUSE"],
		['const f=Bun.file("/not-real/ledger.db");const k=["wri","ter"].join("");f[k]()', "REFUSE"],
		['const f=Bun.file("/not-real/ledger.db");const w=f[process.env.M];w()', "REFUSE"],
		['require("fs")["writeFileSync"]("/not-real/ledger.db","x")', "REFUSE"],
		['const r=["a","b"];for (const x of r) console.log(x)', "ALLOW"],
		['const b=await Bun.file("/not-real/ledger.db").bytes();console.log(b[0], b.length)', "ALLOW"],
	];
	for (const [code, want] of B8) test(`eval js ${code} → ${want}`, () => expect(evalCode("js", code)).toBe(want));
	test('eval py data[0:16] of a read-only open → ALLOW', () => expect(evalCode("py", 'data=open("/not-real/ledger.db","rb").read();print(data[0:16], data[-4:])')).toBe("ALLOW"));
});

describe("B9: an import's bound name is the constructor it binds", () => {
	const B9: ["py" | "js", string, V][] = [
		["js", 'import * as S from "bun:sqlite";new S.Database(process.env.DB)', "REFUSE"],
		["js", 'const {Database: D} = require("bun:sqlite");new D(process.env.DB)', "REFUSE"],
		["js", 'const {Database: D} = await import("bun:sqlite");new D(process.env.DB)', "REFUSE"],
		["js", 'import D from "better-sqlite3";D(process.env.DB)', "REFUSE"],
		["js", 'import {Database} from "bun:sqlite";const X=Database;new X(process.env.DB)', "REFUSE"],
		["js", 'import * as S from "bun:sqlite";const k="Data"+process.env.X;new S[k](":memory:")', "REFUSE"],
		["js", 'import {Database as D} from "bun:sqlite";const db=globalThis.open?.(D)', "REFUSE"],
		["py", 'from sqlite3 import connect as c;c(os.environ["DB"])', "REFUSE"],
		["py", 'import sqlite3 as s;s.connect(os.environ["DB"])', "REFUSE"],
		["py", 'import sqlite3;c=sqlite3.connect;c(os.environ["DB"])', "REFUSE"],
		["py", "import sqlite3", "REFUSE"],
		["js", 'import {Database as D} from "bun:sqlite";new D(":memory:").query("select 1").all()', "ALLOW"],
		["js", 'import {Database} from "bun:sqlite";const db=new Database(":memory:");db.query("select 1").all()', "ALLOW"],
		["py", 'from sqlite3 import (connect as c);c(":memory:")', "ALLOW"],
		["py", 'import sqlite3;sqlite3.connect(":memory:").execute("select 1")', "ALLOW"],
	];
	for (const [language, code, want] of B9) test(`eval ${language} ${code} → ${want}`, () => expect(evalCode(language, code)).toBe(want));
});

describe("S2: the push refusal's advertised remedy is a form the gate then accepts", () => {
	test("run the remedy from the refusal, record a passing test on the tree, and the push is allowed", () => {
		const r = repoWithOrigin();
		git(r.work, "switch", "-q", "-c", "feature");
		commit(r.work, "f.txt", "f\n");
		advanceOriginMain(r.root, r.origin);
		const here = { ...ctx, cwd: r.work };
		const push = call("bash", { command: "git push origin feature" });
		const refusal = checkPushRebase(push, here, () => []);
		const remedy = /\(`([^`]+)`, or a rebase/.exec(refusal?.reason ?? "")?.[1];
		expect(remedy).toBe("git fetch origin && git merge origin/main");
		for (const part of remedy!.split(" && ")) git(r.work, ...part.split(" ").slice(1));
		expect(checkPushRebase(push, here, () => [])?.reason).toContain("0 test records");
		expect(checkPushRebase(push, here, () => [testRecord(r.work)])).toBeNull();
	});
});

describe("S3: a wholly quoted line is the ask only when the block has none yet", () => {
	const S3: [string, V][] = [
		["**QUESTION**\nMain or feature?\n“Example text?”", "ALLOW"],
		['**QUESTION**\nMain or feature?\n"Example text?"', "ALLOW"],
		['**QUESTION**\n"Should I proceed?"', "ALLOW"],
		["**QUESTION**\n“Should I proceed?”", "ALLOW"],
		["**QUESTION**\nMain or feature?\nToday or tomorrow?", "REFUSE"],
		['**QUESTION**\nMain or feature?\n"Example text?" Today or tomorrow?', "REFUSE"],
	];
	for (const [text, want] of S3) test(`${JSON.stringify(text)} → ${want}`, () => expect(turn(text)).toBe(want));
});
