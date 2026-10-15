// Refused and allowed cases for the tool-call rows: 4 tier name, 5 brief fields, 6 reserved
// actions, 8 push needs the upstream and a test record, 9 protected-branch edit, 10 raw ledger write, 14 no `ask`.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { canonicalPath } from "../../ledger/src/locality";
import { fenceTargets } from "../src/fence";
import { checkToolCall } from "../src/gates";
import { checkTierName } from "../src/rows/r04-tier-name";
import { checkBriefFields } from "../src/rows/r05-brief-fields";
import { checkReserved } from "../src/rows/r06-reserved";
import { checkPushRebase } from "../src/rows/r08-push-rebase";
import { checkProtectedEdit } from "../src/rows/r09-protected-edit";
import { checkRawLedgerWrite } from "../src/rows/r10-raw-ledger";
import { checkAsk } from "../src/rows/r14-ask-policy";
import type { CallContext } from "../src/types";
import { advanceOriginMain, brief, commit, git, repoWithOrigin, testRecord, tmp } from "./helpers";

const lane = (cwd = tmp("cwd"), env: Record<string, string | undefined> = { HOME: "/nonexistent-home" }): CallContext => ({ role: "lane", cwd, env });

describe("row 4: a dispatch names only a tier file", () => {
	test("refuses a role name, a bundled name, and an omitted agent", () => {
		expect(checkTierName({ tasks: [{ agent: "builder", task: "x" }] })?.reason).toContain('item 0: "builder"');
		expect(checkTierName({ tasks: [{ agent: "standard", task: "x" }, { agent: "task", task: "y" }] })?.reason).toContain('item 1: "task"');
		expect(checkTierName({ tasks: [{ task: "x" }] })?.reason).toContain("no agent named");
		expect(checkTierName({ agent: "scout", task: "flat shape" })?.block).toBe(true);
	});
	test("allows each of the four tiers, batch and flat", () => {
		for (const t of ["fast", "standard", "strong", "deep"]) expect(checkTierName({ tasks: [{ agent: t, task: "x" }] })).toBeNull();
		expect(checkTierName({ agent: "deep", task: "flat" })).toBeNull();
	});
	test("orchestrator and lane are tier files but not dispatchable", () => {
		expect(checkTierName({ tasks: [{ agent: "lane", task: "x" }] })?.block).toBe(true);
		expect(checkTierName({ tasks: [{ agent: "orchestrator", task: "x" }] })?.block).toBe(true);
	});
});

describe("row 5: all six brief fields", () => {
	test("refuses a missing field and a malformed value", () => {
		const missing = checkBriefFields({ tasks: [{ agent: "fast", task: brief({ stakes: "" }) }] });
		expect(missing?.reason).toContain('missing "stakes:"');
		const bad = checkBriefFields({ tasks: [{ agent: "fast", task: brief({ stakes: "yolo", workload: "42" }) }] });
		expect(bad?.reason).toContain('"stakes: yolo" is not');
		expect(bad?.reason).toContain('"workload: 42" is not');
	});
	test("refuses per item: one complete item does not cover another", () => {
		const r = checkBriefFields({ tasks: [{ agent: "fast", task: brief() }, { agent: "fast", task: "just do it" }] });
		expect(r?.reason).toContain("item 1");
		expect(r?.reason).not.toContain("item 0");
	});
	test("allows fields in the item, in the shared context, bolded and bulleted", () => {
		expect(checkBriefFields({ tasks: [{ agent: "fast", task: brief() }] })).toBeNull();
		const shared = "workload: wl-abc\ninputs: gates/\nstakes: production\nceiling-share: 12.5%";
		expect(checkBriefFields({ context: shared, tasks: [{ agent: "fast", task: "- **task:** fix it\n- **done-condition:** tests green" }] })).toBeNull();
	});
});

describe("row 6: § A4 reserved actions", () => {
	const refused = [
		"git push --force origin feat",
		"git push -f origin feat",
		"git push --force-with-lease",
		"git push origin +feat",
		"git reset --hard HEAD~1",
		"git branch -D old",
		"git tag -d v1",
		"git push origin --delete old",
		"git push origin :old",
		"rm -rf build",
		"rm -r -f build",
		"rm --recursive --force /not-real/x",
		'psql "$DB" -c "DROP TABLE users"',
		"echo 'TRUNCATE TABLE events;' | psql",
		"psql postgres://prod-db.internal/app -c 'update t set x=1'",
		"kubectl delete pod web-1",
		"terraform destroy -auto-approve",
		"doctl compute droplet delete web",
		"gh secret set API_KEY < key.txt",
		"vault kv put secret/app key=1",
		"git push origin main",
		"git push origin feat:main",
		"fly deploy",
		"vercel --prod",
		"npm publish",
		"gh workflow run deploy.yml",
		"cd x && git -C y push --force",
	];
	for (const cmd of refused) {
		test(`refuses: ${cmd}`, () => {
			const r = checkReserved({ toolName: "bash", input: { command: cmd } }, lane());
			expect(r?.block).toBe(true);
			expect(r?.reason).toContain("§ A4 reserved list");
		});
	}
	// M8 ctx wiring: ctx is not a § A4 reserved action, so a lane runs its reads and its writes alike.
	const allowed = ["git push origin feat", "git push -u origin feat", "git status", "rm -r build", "rm -f a.txt", "git branch feat", "gh pr create --fill", "git fetch origin --prune", "echo drop tables later", "git push origin main-fix", "ctx search wl-munn32rmt6ajnk --since 2d", "ctx show session 01a0f0ca", "ctx import --all", "ctx sources add --provider pi --root /tmp/s as2"];
	for (const cmd of allowed) {
		test(`allows: ${cmd}`, () => expect(checkReserved({ toolName: "bash", input: { command: cmd } }, lane())).toBeNull());
	}
	test("refuses a reserved action inside a script the command runs", () => {
		const dir = tmp("script");
		writeFileSync(join(dir, "ship.sh"), "#!/bin/zsh\nset -e\nbun test\nfly deploy\n");
		expect(checkReserved({ toolName: "bash", input: { command: "zsh ship.sh" } }, lane(dir))?.reason).toContain("ship.sh");
		writeFileSync(join(dir, "ok.sh"), "#!/bin/zsh\nbun test\n");
		expect(checkReserved({ toolName: "bash", input: { command: "zsh ok.sh" } }, lane(dir))).toBeNull();
	});
	test("refuses shell reached through eval, allows harmless eval", () => {
		expect(checkReserved({ toolName: "eval", input: { language: "js", code: "await Bun.$`git push --force origin x`" } }, lane())?.block).toBe(true);
		expect(checkReserved({ toolName: "eval", input: { language: "py", code: "import subprocess\nsubprocess.run(['terraform','destroy'])" } }, lane())?.block).toBe(true);
		expect(checkReserved({ toolName: "eval", input: { language: "py", code: "print(1+1)" } }, lane())).toBeNull();
	});
	test("refuses browser writes, allows browser reads", () => {
		expect(checkReserved({ toolName: "eval", input: { language: "js", code: "const tab = await browser.open(u); await tab.click('#buy')" } }, lane())?.block).toBe(true);
		expect(checkReserved({ toolName: "mcp__chrome_devtools_click", input: { uid: "1" } }, lane())?.block).toBe(true);
		expect(checkReserved({ toolName: "mcp__chrome_devtools_take_screenshot", input: {} }, lane())).toBeNull();
		expect(checkReserved({ toolName: "eval", input: { language: "js", code: "const tab = await browser.open(u); await tab.screenshot()" } }, lane())).toBeNull();
	});
	test("refuses a bare push from a checkout on a protected branch", () => {
		const { work } = repoWithOrigin();
		expect(checkReserved({ toolName: "bash", input: { command: "git push" } }, lane(work))?.reason).toContain("current branch main");
		git(work, "switch", "-q", "-c", "feat");
		expect(checkReserved({ toolName: "bash", input: { command: "git push" } }, lane(work))).toBeNull();
	});
	test("refuses every write inside .git (fix-5: config and hooks git runs later, not only protected refs)", () => {
		expect(checkReserved({ toolName: "write", input: { path: "/r/.git/refs/heads/main", content: "abc" } }, lane())?.block).toBe(true);
		expect(checkReserved({ toolName: "write", input: { path: "/r/.git/hooks/pre-commit", content: "abc" } }, lane())?.block).toBe(true);
		expect(checkReserved({ toolName: "write", input: { path: "/r/.gitignore", content: "abc" } }, lane())).toBeNull();
	});
	describe("switching the GitHub identity gh acts as (PLAN wl-mv66ylim0gahog § 6.3)", () => {
		const identity = [
			"gh auth switch -u thewolff",
			"gh auth token -u thewolff",
			"gh auth login --with-token < t.txt",
			"gh auth logout -u thewolff-engineer",
			"gh auth refresh -s repo",
			"gh auth setup-git",
			"gh --hostname github.com auth switch",
			"GH_TOKEN=abc gh issue create --title x --body y",
			"GITHUB_TOKEN=abc gh issue list",
			"export GH_TOKEN=abc; gh issue list",
			"env GITHUB_TOKEN=abc gh issue list",
			'GH_TOKEN="$(cat t.txt)" gh issue list',
			"GH_TOKEN=$(gh auth token -u thewolff) gh issue list",
			"security find-generic-password -s gh:github.com -w",
			"security find-internet-password -s github.com -w",
			"sh -c 'gh auth switch'",
			"gh auth status --show-token",
			"gh auth status -a -t",
		];
		for (const cmd of identity) {
			test(`refuses: ${cmd}`, () => {
				const r = checkReserved({ toolName: "bash", input: { command: cmd } }, lane());
				expect(r?.block).toBe(true);
				expect(r?.reason).toContain("§ A4 reserved list");
			});
		}
		test("refuses GH_TOKEN set through the bash tool's env", () => {
			expect(checkReserved({ toolName: "bash", input: { command: "gh issue list", env: { GH_TOKEN: "abc" } } }, lane())?.reason).toContain("setting GH_TOKEN");
		});
		const free = ["gh auth status", "gh auth status -a", "gh auth status -h github.com", "gh issue list --label as2", "gh api graphql -f query='{viewer{login}}'", "export GH_TOKEN", "security list-keychains", "echo GH_TOKEN_IS_UNSET"];
		for (const cmd of free) {
			test(`allows: ${cmd}`, () => expect(checkReserved({ toolName: "bash", input: { command: cmd } }, lane())).toBeNull());
		}
	});
});

describe("row 8: a push needs the target's upstream and a test record for its tree", () => {
	/** A feature branch one commit ahead of a main that origin has since advanced. */
	function behind() {
		const r = repoWithOrigin();
		git(r.work, "switch", "-q", "-c", "feat");
		commit(r.work, "f.txt", "f\n");
		advanceOriginMain(r.root, r.origin);
		return r;
	}
	/** `behind()` with origin/main fetched and rebased onto. */
	function rebased() {
		const r = behind();
		git(r.work, "fetch", "-q", "origin");
		git(r.work, "rebase", "-q", "origin/main");
		return r;
	}
	const push = (command: string) => ({ toolName: "bash", input: { command } });

	test("refuses a push whose branch does not contain the fetched mainline", () => {
		const { work } = behind();
		expect(checkPushRebase(push("git push -u origin feat"), lane(work), () => [testRecord(work)])?.reason).toContain("does not contain origin/main");
	});
	test("allows the push after a rebase onto origin/main with a test record on the rebased tree", () => {
		const { work } = rebased();
		expect(checkPushRebase(push("git push -u origin feat"), lane(work), () => [testRecord(work)])).toBeNull();
	});
	test("a fetch-and-rebase chained into the push command has not run when the gate decides (astra review B4)", () => {
		const { work } = behind();
		const cmd = "git fetch origin --prune && git rebase origin/main && git push -u origin feat";
		expect(checkPushRebase(push(cmd), lane(work), () => [testRecord(work)])?.block).toBe(true);
	});
	test("a commit after the test record refuses the push again", () => {
		const { work } = rebased();
		const record = testRecord(work);
		commit(work, "later.txt", "later\n");
		expect(checkPushRebase(push("git push origin feat"), lane(work), () => [record])?.block).toBe(true);
	});
	test("follows cd into the repo", () => {
		const { root, work } = behind();
		expect(checkPushRebase(push(`cd ${work} && git push origin feat`), lane(root), () => [testRecord(work)])?.reason).toContain("does not contain origin/main");
	});
});

describe("row 9: no edit on a protected branch", () => {
	test("refuses write and edit into a checkout on main", () => {
		const { work } = repoWithOrigin();
		expect(checkProtectedEdit({ toolName: "write", input: { path: join(work, "new/dir/file.ts"), content: "x" } }, lane(work))?.reason).toContain('protected branch "main"');
		expect(checkProtectedEdit({ toolName: "edit", input: { path: "a.txt", paths: ["a.txt"], input: "..." } }, lane(work))?.block).toBe(true);
	});
	test("allows the same edit on a feature branch and outside any checkout", () => {
		const { work } = repoWithOrigin();
		git(work, "switch", "-q", "-c", "feat");
		expect(checkProtectedEdit({ toolName: "write", input: { path: join(work, "b.txt"), content: "x" } }, lane(work))).toBeNull();
		const loose = tmp("loose");
		expect(checkProtectedEdit({ toolName: "write", input: { path: join(loose, "c.txt"), content: "x" } }, lane(loose))).toBeNull();
	});
});

describe("row 10: raw ledger writes refused", () => {
	const setup = () => {
		const home = tmp("home");
		const dir = join(home, ".agent-system-2");
		mkdirSync(dir);
		const db = join(dir, "ledger.db");
		return { home, dir, db, ctx: lane(home, { HOME: home }) };
	};
	test("refuses sqlite3 writes by every spelling of the path", () => {
		const { home, db, dir, ctx } = setup();
		for (const cmd of [
			`sqlite3 ${db} "INSERT INTO workloads VALUES (1)"`,
			`sqlite3 ~/.agent-system-2/ledger.db "DELETE FROM slices"`,
			`sqlite3 $HOME/.agent-system-2/ledger.db .dump`,
			`cd ${dir} && sqlite3 ledger.db "UPDATE questions SET state='answered'"`,
			`cp /tmp/other.db ${db}`,
			`echo x > ${db}-wal`,
			`rm ${db}-shm`,
		]) {
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: cmd } }, ctx)?.reason).toContain("P-11 row 10");
		}
		expect(home).toBeTruthy();
	});
	test("refuses the env override path and the variable spelled in the command", () => {
		const alt = join(tmp("alt"), "l.db");
		const ctx = lane(tmp("cwd"), { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: alt });
		expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `sqlite3 ${alt} 'DROP TABLE x'` } }, ctx)?.block).toBe(true);
		expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `sqlite3 "$AGENT_SYSTEM_LEDGER_DB" 'VACUUM'` } }, ctx)?.block).toBe(true);
	});
	test("refuses file-tool writes to the file and its WAL/SHM siblings", () => {
		const { db, ctx } = setup();
		for (const p of [db, `${db}-wal`, `${db}-shm`]) expect(checkRawLedgerWrite({ toolName: "write", input: { path: p, content: "" } }, ctx)?.block).toBe(true);
	});
	test("refuses eval code that opens the ledger without the module", () => {
		const { db, ctx } = setup();
		expect(checkRawLedgerWrite({ toolName: "eval", input: { code: `import { Database } from "bun:sqlite"; new Database("${db}").run("DELETE FROM slices")` } }, ctx)?.block).toBe(true);
	});
	test("allows read-only inspection, the module's scripts, and other databases", () => {
		const { db, ctx } = setup();
		expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `sqlite3 -readonly ${db} "SELECT count(*) FROM workloads"` } }, ctx)).toBeNull();
		expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `ls -la ${db}*` } }, ctx)).toBeNull();
		// The exemption is the real module's script by where it resolves, not a path that reads like one (astra review B2).
		expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `bun ${join(import.meta.dir, "../../ledger/scripts/backup.ts")} ${db}` } }, ctx)).toBeNull();
		expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `bun ledger/scripts/backup.ts ${db}` } }, ctx)?.block).toBe(true);
		expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `sqlite3 /tmp/scratch.db "CREATE TABLE t(x)"` } }, ctx)).toBeNull();
		expect(checkRawLedgerWrite({ toolName: "write", input: { path: `${db}.notes.md`, content: "" } }, ctx)).toBeNull();
	});
	test("a path under a directory this uid cannot read neither throws nor loosens the row (item 24, run tr-0mv0ks648wy8d2q)", () => {
		// The as2test runner's uid cannot read Jo's home; realpath on such a directory throws EACCES.
		const locked = join(tmp("locked"), "locked");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		try {
			const db = join(locked, "sub", "ledger.db");
			const configured = lane(tmp("cwd"), { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: db });
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `sqlite3 ${db} 'DROP TABLE x'` } }, configured)?.block).toBe(true);
			expect(checkRawLedgerWrite({ toolName: "write", input: { path: `${db}-wal`, content: "" } }, configured)?.block).toBe(true);
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: "ls" } }, configured)).toBeNull();
			const ordinary = lane(tmp("cwd"), { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" });
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `echo x > ${join(locked, "sub", "x.txt")}` } }, ordinary)).toBeNull();
			expect(checkToolCall({ toolName: "bash", input: { command: `cat ${join(locked, "sub", "x")}` } }, ordinary)).toBeNull();
		} finally {
			chmodSync(locked, 0o700);
		}
	});
	test("a unix-socket path, or a symlink to one, is judged rather than thrown on (Bun realpathSync EOPNOTSUPP)", async () => {
		// /var/run/docker.sock is a symlink to a socket and /var/run/mDNSResponder is a socket: Bun
		// 1.3.14's realpathSync throws EOPNOTSUPP on both, which made the row throw instead of judging.
		const dir = tmp("sock");
		const sock = join(dir, "s.sock");
		const link = join(dir, "link.sock");
		const server = createServer();
		await new Promise<void>((done) => server.listen(sock, done));
		try {
			symlinkSync(sock, link);
			const canonical = join(realpathSync(dir), "s.sock");
			expect(canonicalPath(sock)).toBe(canonical);
			expect(canonicalPath(link)).toBe(canonical);
			expect(canonicalPath(join(sock, "below"))).toBe(join(canonical, "below"));
			const ordinary = lane(tmp("cwd"), { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" });
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `ls -l ${sock} ${link}` } }, ordinary)).toBeNull();
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `echo x > ${link}` } }, ordinary)).toBeNull();
			// Resolved, not just survived: a ledger configured through the link is the socket's path.
			const bound = lane(tmp("cwd"), { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: link });
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `echo x > ${sock}` } }, bound)?.block).toBe(true);
		} finally {
			server.close();
		}
	});
	test("a relative link to a socket, reached through a directory alias, resolves from the link's real directory (PR #39 review)", async () => {
		// spelling/alias -> actual/deep; actual/deep/link -> ../s.sock names actual/s.sock, not
		// spelling/s.sock. actual/deep/hop -> other/x, so hop/../s2.sock names other/s2.sock: each `..`
		// is the physical parent of the component before it, not a lexical collapse.
		const dir = tmp("alias");
		const real = realpathSync(dir);
		mkdirSync(join(dir, "actual", "deep"), { recursive: true });
		mkdirSync(join(dir, "other", "x"), { recursive: true });
		mkdirSync(join(dir, "spelling"));
		const servers = [createServer(), createServer()];
		await new Promise<void>((done) => servers[0]!.listen(join(dir, "actual", "s.sock"), done));
		await new Promise<void>((done) => servers[1]!.listen(join(dir, "other", "s2.sock"), done));
		try {
			symlinkSync(join(dir, "actual", "deep"), join(dir, "spelling", "alias"));
			symlinkSync("../s.sock", join(dir, "actual", "deep", "link"));
			symlinkSync(join(dir, "other", "x"), join(dir, "actual", "deep", "hop"));
			symlinkSync("hop/../s2.sock", join(dir, "actual", "deep", "link2"));
			const configured = join(dir, "spelling", "alias", "link");
			expect(canonicalPath(configured)).toBe(join(real, "actual", "s.sock"));
			expect(canonicalPath(join(dir, "spelling", "alias", "link2"))).toBe(join(real, "other", "s2.sock"));
			const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: configured };
			const bound = lane(tmp("cwd"), env);
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `echo x > ${join(real, "actual", "s.sock")}` } }, bound)?.block).toBe(true);
			expect(checkRawLedgerWrite({ toolName: "bash", input: { command: `echo x > ${join(real, "spelling", "s.sock")}` } }, bound)).toBeNull();
			expect(fenceTargets("true", bound.cwd, env)).toContainEqual({ kind: "subpath", path: join(real, "actual") });
		} finally {
			for (const s of servers) s.close();
		}
	});
});

describe("row 14: `ask` unavailable to hands and autonomous lanes", () => {
	test("refuses ask from a hand, an autonomous lane, and a lane with no known mode", () => {
		expect(checkAsk("ask", "hand", null)?.reason).toContain("a hand");
		expect(checkAsk("ask", "lane", "autonomous")?.reason).toContain("autonomous mode");
		expect(checkAsk("ask", "lane", null)?.block).toBe(true);
	});
	test("allows ask from a user-driven lane and the orchestrator; other tools untouched", () => {
		expect(checkAsk("ask", "lane", "user-driven")).toBeNull();
		expect(checkAsk("ask", "orchestrator", null)).toBeNull();
		expect(checkAsk("read", "hand", null)).toBeNull();
	});
});

describe("composition: checkToolCall", () => {
	test("a clean dispatch and a clean command pass every row", () => {
		const ctx = lane();
		expect(checkToolCall({ toolName: "task", input: { tasks: [{ agent: "standard", task: brief() }] } }, ctx)).toBeNull();
		expect(checkToolCall({ toolName: "bash", input: { command: "ls" } }, ctx)).toBeNull();
	});
	test("the first refusing row wins", () => {
		expect(checkToolCall({ toolName: "task", input: { tasks: [{ agent: "builder", task: "x" }] } }, lane())?.reason).toContain("row 4");
		expect(checkToolCall({ toolName: "ask", input: {} }, { ...lane(), role: "hand" })?.reason).toContain("row 14");
	});
});
