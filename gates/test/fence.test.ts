// M4b step 3: the OS fence (gates/src/fence.ts). Sandboxed writes to the configured ledger, to a
// repo's .git/hooks and to the .git entry itself are refused by the OS, not by a parser: each case
// runs the command the fence revised a bash call into, for real, under /bin/bash. .git/config is not
// fenced (M4b fix 1): upstream tracking records under the fence, and config writes stay the rows'.
// Also: the ledger module still writes in-process; `sqlite3 -readonly` reads a live WAL ledger from
// inside the sandbox; the wrapper leaves quoting alone; every fail-closed path refuses; internal URLs
// are refused before wrapping; a later handler that drops the wrapper is caught at execution start;
// the flag turns the fence off and says so in the ledger; rows 3 and 8 read the original command;
// the eval subprocess is NOT fenced. M4b fix 2 (review astra-1): the call's cwd resolves as OMP's bash
// tool does (tilde pair, internal-URL and missing cwds refused, parity with the host's resolver); a
// ledger file symlinked elsewhere is fenced where it resolves; a bare repository's hooks are fenced;
// the bypass guard tolerates outer whitespace around the wrapper and still trips on an unwrapped run.
// M4b fix 3 (review astra-2): settings reach the fence only through the reader it is handed, the
// live instance winning over the disk read; with no reader every bash call is refused.
// Item 65, superseded by item 99: a typed copy of the fence's own wrapper is P-11 row 18's refusal
// through the gates (rows/r18-typed-wrapper.ts), naming the bare command; the fence alone refuses
// every sandbox-exec the shell would run, by the parsed word, and no longer strips a copy.
// Item 99, the model's view (R1-R6, PLAN wl-mv4xdju27wwdfk rev 6 § 4): the fence writes a revision
// entry when a call starts as its own wrapper, and its context hook shows the model those calls,
// and their background-job labels, as typed; nothing else is touched. Its session_before_compact hook
// does the same for what compaction archives (PLAN wl-mv5o5xkyebs7i8 § 2-3, `session_before_compact unwrap`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../../ledger/src/index";
import { ALREADY_WRAPPED_REASON, FENCE_OFF_BODY, type FenceSettings, fenceBypassBody, fenceProfile, fenceSettingsFrom, INTERNAL_URL_REASON, registerFence, shellStartReason, wrapCommand } from "../src/fence";
import { type HostModules, VERIFIED_HOST } from "../src/host";
import p11Gates from "../index";
import { gateSession, type GatesAPI } from "../src/session";
import { copiedWrapper } from "../src/exec";
import { copiedWrapperReason } from "../src/rows/r18-typed-wrapper";
import { ORCHESTRATOR_ROLE_REFUSAL } from "../src/rows/r15-orchestrator-role";
import { readCleanShell } from "../src/clean-shell";
import { advanceOriginMain, CERTIFIED, commit, environOf, git, repoWithOrigin, shellStartFixture, tmp } from "./helpers";

type AnyHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Revised = { block?: boolean; reason?: string; input?: Record<string, unknown>; additionalContext?: string } | undefined;

const ON: FenceSettings = { enabled: true, autoBackground: true };

/**
 * A fake OMP extension API chaining handlers the way the runner does (runner.ts emitToolCall): every
 * handler gets the same original event, the first block returns, otherwise the last result wins.
 */
function fakePi() {
	const handlers = new Map<string, AnyHandler[]>();
	const entries: { type: string; data: unknown }[] = [];
	const pi = {
		on: (name: string, h: AnyHandler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		getActiveTools: () => ["bash", "read"],
		getAllTools: () => [{ name: "bash" }, { name: "read" }],
		setActiveTools: async () => {},
		appendEntry: (type: string, data?: unknown) => entries.push({ type, data }),
		registerTool: () => {},
		zod: { object: () => ({}), string: () => ({ describe: () => ({}), optional: () => ({ describe: () => ({}) }) }) },
	};
	const emit = async (name: string, event: Record<string, unknown>, ctx: unknown): Promise<Revised> => {
		let last: Revised;
		for (const h of handlers.get(name) ?? []) {
			const r = (await h(event, ctx)) as Revised;
			if (!r) continue;
			last = r;
			if (r.block) return r;
		}
		return last;
	};
	/** Each handler's own return for `event`, in order (no chaining). */
	const results = async (name: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown[]> => {
		const out: unknown[] = [];
		for (const h of handlers.get(name) ?? []) out.push(await h(event, ctx));
		return out;
	};
	return { pi: pi as unknown as GatesAPI, on: pi.on, emit, results, entries };
}

const notices: string[] = [];
const ctxOf = (cwd: string) => ({
	hasUI: true,
	cwd,
	sessionManager: { getHeader: () => null, getEntries: () => [] },
	ui: { notify: (m: string) => notices.push(m) },
});

let callId = 0;
/** The fence alone (no rows) over one bash call: what OMP would run. */
async function fenced(command: string, cwd: string, env: Record<string, string | undefined>, settings: FenceSettings = ON): Promise<Revised> {
	const f = fakePi();
	registerFence(f.pi, env, async () => settings, CERTIFIED);
	return f.emit("tool_call", { toolName: "bash", toolCallId: `c${++callId}`, input: { command } }, ctxOf(cwd));
}

/** The wrapped command for `command`; fails the test if the fence refused it. */
async function wrapped(command: string, cwd: string, env: Record<string, string | undefined>): Promise<string> {
	const r = await fenced(command, cwd, env);
	if (!r?.input || r.block) throw new Error(`fence refused: ${r?.reason}`);
	return String(r.input.command);
}

const RUN_ENV = {
	PATH: process.env.PATH,
	GIT_AUTHOR_NAME: "fence test",
	GIT_AUTHOR_EMAIL: "fence@test.invalid",
	GIT_COMMITTER_NAME: "fence test",
	GIT_COMMITTER_EMAIL: "fence@test.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_PAGER: "cat",
	PAGER: "cat",
	MANPAGER: "cat",
	LC_ALL: "C",
};

/** Run `command` with /bin/bash -c, the shape OMP's shell hands the wrapper to (and the unwrapped control). */
function sh(command: string, cwd: string, env: Record<string, string | undefined> = RUN_ENV) {
	const r = spawnSync("/bin/bash", ["-c", command], { cwd, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Every file under `dir` with its bytes: proof nothing changed. */
function snapshot(dir: string): string {
	const r = spawnSync("/bin/bash", ["-c", `find . -print | LC_ALL=C sort | while read -r f; do printf '%s ' "$f"; [ -f "$f" ] && shasum "$f" | cut -c1-40 || echo; done`], { cwd: dir, encoding: "utf8" });
	return r.stdout;
}

describe("the fence refuses sandboxed writes into the configured ledger directory", () => {
	// The default layout ($HOME/.agent-system-2/ledger.db) under a temp HOME. tmpdir is under /var,
	// itself a symlink to /private/var on macOS: the profile must carry the canonical path, or
	// Seatbelt fails open silently (research/gate-prior-art.md § 3).
	const home = tmp("fence-home");
	const env = { HOME: home, PATH: process.env.PATH };
	const dir = join(home, ".agent-system-2");
	const db = join(dir, "ledger.db");
	const outside = tmp("fence-outside");
	beforeAll(() => {
		Ledger.open(db, { create: true, backup: false, backupOnOpen: false }).close();
		symlinkSync(db, join(outside, "link.db"));
	});

	const cases: [string, string][] = [
		["a shell redirect", `echo forged >> ${db}`],
		["touch", `touch ${db}`],
		["/usr/bin/touch creating a file", `/usr/bin/touch ${dir}/new.txt`],
		["sqlite3", `sqlite3 ${db} "CREATE TABLE forged (x)"`],
		["a child sh", `sh -c 'echo forged > ${db}-wal'`],
		["a symlink outside the fence", `echo forged >> ${join(outside, "link.db")}`],
		["rm", `rm -f ${db}`],
		["mv of the directory", `mv ${dir} ${dir}.moved`],
	];
	for (const [name, command] of cases) {
		test(`${name}: non-zero, ledger directory unchanged`, async () => {
			const before = snapshot(dir);
			const r = sh(await wrapped(command, outside, env), outside);
			expect(r.code).not.toBe(0);
			expect(snapshot(dir)).toBe(before);
		});
	}

	test("control: the same wrapped write outside the fence succeeds", async () => {
		const r = sh(await wrapped(`echo ok > ${outside}/control.txt && /usr/bin/touch ${outside}/c2`, outside, env), outside);
		expect(r.code).toBe(0);
		expect(readFileSync(join(outside, "control.txt"), "utf8")).toBe("ok\n");
	});

	test("the ledger module (in-process) still writes while the fence is on", async () => {
		await wrapped("true", outside, env); // the fence registered and built for this ledger
		const l = Ledger.open(db, { backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: "fence-test", brief: "b", stakes: "throwaway", mode: "autonomous" });
		expect(l.workload(wl)?.id).toBe(wl);
		l.close();
	});

	test("sqlite3 -readonly reads a live WAL ledger from inside the sandbox", async () => {
		const live = new Database(db);
		live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS probe (x); INSERT INTO probe VALUES (1), (2), (3);");
		try {
			expect(statSync(`${db}-wal`).size).toBeGreaterThan(0); // rows sit in the WAL, uncheckpointed
			const r = sh(await wrapped(`sqlite3 -readonly ${db} 'select count(*) from probe'`, outside, env), outside);
			expect({ code: r.code, out: r.out.trim() }).toEqual({ code: 0, out: "3" });
		} finally {
			live.close();
		}
	});

	test("a setuid binary exits 126 under the fence (known, documented, not worked around)", async () => {
		expect(sh(await wrapped("/bin/ps -p $$", outside, env), outside).code).toBe(126);
	});
});

describe("the fence refuses sandboxed writes to .git/hooks and the .git entry", () => {
	const env = { HOME: tmp("fence-git-home"), PATH: process.env.PATH };
	let work = "";
	let wt = "";
	beforeAll(() => {
		work = repoWithOrigin().work;
		wt = join(tmp("fence-wt"), "wt");
		git(work, "worktree", "add", "-q", "--detach", wt);
	});

	const gitCases: [string, string][] = [
		["hooks/pre-commit by redirect", "echo 'exit 0' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit"],
		["the .git entry renamed aside", "mv .git .git-aside"],
	];
	for (const [name, cmd] of gitCases) {
		test(`${name}: non-zero or unwritten, repository metadata unchanged`, async () => {
			const before = snapshot(join(work, ".git"));
			const r = sh(await wrapped(cmd, work, env), work);
			expect(r.err).toContain("Operation not permitted");
			expect(existsSync(join(work, ".git", "hooks", "pre-commit"))).toBe(false);
			expect(snapshot(join(work, ".git")).split("\n").filter((l) => /hooks|config/.test(l))).toEqual(before.split("\n").filter((l) => /hooks|config/.test(l)));
		});
	}

	test("a worktree whose .git is a file: the common hooks and its .git pointer are fenced", async () => {
		expect(statSync(join(wt, ".git")).isFile()).toBe(true);
		const common = join(work, ".git");
		const r1 = sh(await wrapped(`echo 'exit 0' > "$(git rev-parse --git-common-dir)/hooks/pre-commit"`, wt, env), wt);
		const r2 = sh(await wrapped("echo 'gitdir: /tmp/forged' > .git", wt, env), wt);
		for (const r of [r1, r2]) expect(r.err).toContain("Operation not permitted");
		expect(existsSync(join(common, "hooks", "pre-commit"))).toBe(false);
		expect(readFileSync(join(wt, ".git"), "utf8")).toStartWith("gitdir: ");
	});

	test("control: ordinary git work inside the fence succeeds (commit, branch, fetch)", async () => {
		const r = sh(await wrapped("git switch -q -c fence-ctl && git commit -q --allow-empty -m fenced && git fetch -q origin && git log --oneline -1", work, env), work);
		expect({ code: r.code, out: r.out.trim().endsWith("fenced") }).toEqual({ code: 0, out: true });
	});
});

describe(".git/config is not fenced: upstream tracking records, config writes stay the rows'", () => {
	const env = { HOME: tmp("fence-cfg-home"), PATH: process.env.PATH };
	const cfg = (repo: string, key: string) => spawnSync("git", ["config", "--get", key], { cwd: repo, encoding: "utf8" }).stdout.trim();

	test("git push -u origin <branch> to a local bare remote exits 0 and records the upstream", async () => {
		const { work } = repoWithOrigin();
		git(work, "switch", "-q", "-c", "feat");
		commit(work, "f.txt", "f\n");
		const r = sh(await wrapped("git push -q -u origin feat", work, env), work);
		expect({ code: r.code, err: r.err, remote: cfg(work, "branch.feat.remote"), merge: cfg(work, "branch.feat.merge") }).toEqual({ code: 0, err: "", remote: "origin", merge: "refs/heads/feat" });
	});

	test("git switch -c x origin/main exits 0 and records tracking", async () => {
		const { work } = repoWithOrigin();
		const r = sh(await wrapped("git switch -q -c x origin/main", work, env), work);
		expect({ code: r.code, err: r.err, remote: cfg(work, "branch.x.remote"), merge: cfg(work, "branch.x.merge") }).toEqual({ code: 0, err: "", remote: "origin", merge: "refs/heads/main" });
	});

	test("the rows still refuse config writes before the wrapper: git config and a redirect into .git/config (both row 6)", async () => {
		const { work } = repoWithOrigin();
		const before = readFileSync(join(work, ".git", "config"), "utf8");
		const f = fakePi();
		p11Gates(f.pi, { ...env, AGENT_SYSTEM_LEDGER_DB: join(env.HOME, "ledger.db") }, async () => ON, CERTIFIED);
		const ctx = ctxOf(work);
		const byConfig = await f.emit("tool_call", { toolName: "bash", toolCallId: "cfg-1", input: { command: "git config core.hooksPath /tmp/x" } }, ctx);
		const byRedirect = await f.emit("tool_call", { toolName: "bash", toolCallId: "cfg-2", input: { command: "echo x >> .git/config" } }, ctx);
		expect({ block: byConfig?.block, input: byConfig?.input, row: byConfig?.reason?.slice(0, 18) }).toEqual({ block: true, input: undefined, row: "P-11 row 6 refused" });
		expect({ block: byRedirect?.block, input: byRedirect?.input, why: byRedirect?.reason?.startsWith("P-11 row 6 refused this: writing inside a .git directory") }).toEqual({ block: true, input: undefined, why: true });
		expect(readFileSync(join(work, ".git", "config"), "utf8")).toBe(before);
	});
});

describe("internal URLs are refused before wrapping (OMP does not expand them inside the wrapper's quotes)", () => {
	const d = tmp("fence-urls");
	const env = { HOME: d, PATH: process.env.PATH };
	const refused = [
		"cat skill://tdd/SKILL.md",
		"wc -l artifact://12",
		"cp local://notes.md /tmp/x",
		"cat local:/notes.md",
		"echo agent://Scout/result",
		'git commit -m "see artifact://12"',
		"x=rule://careful; echo $x",
	];
	for (const command of refused) {
		test(`refused: ${command}`, async () => {
			expect(await fenced(command, d, env)).toEqual({ block: true, reason: INTERNAL_URL_REASON });
		});
	}
	const allowed = ["echo https://example.com/skill://x", "echo host.local://x", "echo mylocal:/x", "echo skill:x"];
	for (const command of allowed) {
		test(`not a token at a word start, wrapped: ${command}`, async () => {
			expect(await wrapped(command, d, env)).toContain("sandbox-exec");
		});
	}
	test("with the fence off the command runs unwrapped, and OMP expands the URL itself", async () => {
		expect(await fenced("cat skill://tdd/SKILL.md", d, env, { enabled: false, autoBackground: true })).toBeUndefined();
	});
});

describe("a later extension's tool_call handler that drops the wrapper", () => {
	function setup(later: (event: Record<string, unknown>) => unknown) {
		const home = tmp("fence-bypass");
		const db = join(home, ".agent-system-2", "ledger.db");
		const l = Ledger.open(db, { create: true, backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: "orch", brief: "b", stakes: "normal", mode: "autonomous" });
		const env = { HOME: home, PATH: process.env.PATH, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-bp" };
		const f = fakePi();
		registerFence(f.pi, env, async () => ON, CERTIFIED);
		f.on("tool_call", later);
		return { f, l, wl, ctx: ctxOf(home) };
	}

	test("`return {}` after the gates: the unwrapped start is recorded as an assumption row and every later bash call is refused", async () => {
		const { f, l, wl, ctx } = setup((e) => (e.toolName === "bash" ? {} : undefined));
		const input = { command: "echo hi" };
		const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "b1", input }, ctx);
		expect(r?.input).toBeUndefined();
		await f.emit("tool_execution_start", { toolName: "bash", toolCallId: "b1", args: input }, ctx);
		expect(l.entries(wl, "assumption").map((e) => [e.body, e.created_by])).toEqual([[fenceBypassBody("b1"), "lane-bp"]]);
		const next = await f.emit("tool_call", { toolName: "bash", toolCallId: "b2", input: { command: "true" } }, ctx);
		expect({ block: next?.block, why: next?.reason?.includes("bash call b1 ran without the fence's wrapper") }).toEqual({ block: true, why: true });
		l.close();
	});

	test("control: a later handler returning undefined leaves the wrapper, nothing is recorded, the next call is wrapped", async () => {
		const { f, l, wl, ctx } = setup(() => undefined);
		const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "echo hi" } }, ctx);
		await f.emit("tool_execution_start", { toolName: "bash", toolCallId: "c1", args: r!.input }, ctx);
		expect(l.entries(wl, "assumption")).toEqual([]);
		expect(String((await f.emit("tool_call", { toolName: "bash", toolCallId: "c2", input: { command: "true" } }, ctx))?.input?.command)).toContain("sandbox-exec");
		l.close();
	});
});

describe("every extension profile/config.yml loads returns undefined from tool_call for a bash call", () => {
	const REPO = resolve(import.meta.dir, "..", "..");
	const listed = (Bun.YAML.parse(readFileSync(join(REPO, "profile", "config.yml"), "utf8")) as { extensions?: string[] }).extensions ?? [];
	const paths = listed.map((p) => p.replaceAll("{repo}", REPO));
	// Only the extensions loaded after the gates can replace the fence's wrapper (profile/config.yml
	// lists the surface before the gates and the classifier after them).
	const gatesAt = paths.findIndex((p) => resolve(p) === join(REPO, "gates", "index.ts"));
	const after = paths.slice(gatesAt + 1);
	test("the list is not empty", () => {
		expect(after.length).toBeGreaterThan(0);
	});
	for (const path of after) {
		test(`${path.slice(REPO.length + 1)}: undefined for bash`, async () => {
			const mod = (await import(path)) as { default: (pi: GatesAPI) => void };
			const f = fakePi();
			mod.default(f.pi);
			const results = await f.results("tool_call", { toolName: "bash", toolCallId: "ext-1", input: { command: "echo hi" } }, ctxOf(REPO));
			// No result at all is an extension with no tool_call handler (plugins/index.ts: its adapters
			// register none, plugins/test/loader.test.ts), which cannot drop the wrapper either.
			expect(results).toEqual(results.map(() => undefined));
		});
	}
});

describe("quoting: the wrapped command's output is the unwrapped command's", () => {
	const dir = tmp("fence-quote");
	const env = { HOME: tmp("fence-quote-home"), PATH: process.env.PATH };
	const cmds = [
		`echo 'single quoted' "it's" 'a'\\''b'`,
		`echo $'tab\\there\\nnewline' $'\\x41\\u00e9'`,
		`printf '%s|' 'a\\b' "c\\\\d" e\\\\f 'g\\\\\\h'; echo`,
		"echo one\necho two\n  echo three",
		"cat <<'EOF'\n$HOME 'q' \"dq\" \\n $(not run)\nEOF",
		"X=exp; cat <<EOF\n$X \\$X 'q'\nEOF",
		`echo hi!; echo "!x" '!!' !$; set -H 2>/dev/null; echo "wow!"`,
		`a='x y'; for w in $a "$a"; do echo "[$w]"; done; echo "$((1+2))" \${#a}`,
		`echo "$0" | sed 's/.*bash/bash/'; exit 7`,
	];
	for (const c of cmds) {
		test(JSON.stringify(c).slice(0, 60), async () => {
			const plain = sh(c, dir);
			const fencedRun = sh(await wrapped(c, dir, env), dir);
			expect(fencedRun).toEqual(plain);
		});
	}
});

describe("fail closed", () => {
	test("an unresolvable ledger path (a symlink loop) refuses the call", async () => {
		const d = tmp("fence-loop");
		symlinkSync(join(d, "b"), join(d, "a"));
		symlinkSync(join(d, "a"), join(d, "b"));
		const r = await fenced("echo hi", d, { HOME: d, PATH: process.env.PATH, AGENT_SYSTEM_LEDGER_DB: join(d, "a", "ledger.db") });
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("the ledger directory");
	});
	test("sandbox-exec absent from PATH refuses the call", async () => {
		const d = tmp("fence-nopath");
		const r = await fenced("echo hi", d, { HOME: d, PATH: d });
		expect(r?.reason).toContain("sandbox-exec was not found");
	});
	test("bash.autoBackground.enabled false refuses the call", async () => {
		const d = tmp("fence-noab");
		const r = await fenced("echo hi", d, { HOME: d, PATH: process.env.PATH }, { enabled: true, autoBackground: false });
		expect(r?.reason).toContain("bash.autoBackground.enabled is false");
	});
	test("settings that cannot be read refuse the call", async () => {
		const d = tmp("fence-nosettings");
		const f = fakePi();
		registerFence(f.pi, { HOME: d, PATH: process.env.PATH }, async () => {
			throw new Error("no host");
		});
		const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "x", input: { command: "true" } }, ctxOf(d));
		expect(r?.reason).toContain("could not be read (no host)");
	});
	test("a .git file with no gitdir line refuses the call", async () => {
		const d = tmp("fence-badgit");
		writeFileSync(join(d, ".git"), "not a pointer\n");
		const r = await fenced("git status", d, { HOME: d, PATH: process.env.PATH });
		expect(r?.reason).toContain("without a `gitdir:` line");
	});
});

/** The fence alone over one bash call carrying `input` (cwd, env, …), from session cwd `sessionCwd`. */
async function fencedInput(input: Record<string, unknown>, sessionCwd: string, env: Record<string, string | undefined>): Promise<Revised> {
	const f = fakePi();
	registerFence(f.pi, env, async () => ON, CERTIFIED);
	return f.emit("tool_call", { toolName: "bash", toolCallId: `c${++callId}`, input }, ctxOf(sessionCwd));
}

describe("the call's cwd resolves the way OMP's bash tool does (M4b review B1)", () => {
	// OMP 18.3.0 tools/bash.ts:953-963 → path-utils.ts resolveToCwd: `~` is the home directory
	// (os.homedir(), which the fence reads the same way in the same process).
	const env = { HOME: tmp("fence-cwd-home"), PATH: process.env.PATH };
	const session = tmp("fence-cwd-session"); // in no repository
	let work = "";
	beforeAll(() => {
		work = repoWithOrigin().work;
	});

	test("the live tilde/absolute pair: a hook write is refused from `~/…` and from the absolute spelling", async () => {
		const tilde = `~/${relative(homedir(), work)}`;
		for (const [name, cwd] of [["tilde-write", tilde], ["absolute-write", work]] as const) {
			const r = await fencedInput({ command: `touch .git/hooks/${name}`, cwd }, session, env);
			expect(r?.block).toBeUndefined();
			const ran = sh(String(r?.input?.command), work);
			expect({ name, code: ran.code, denied: ran.err.includes("Operation not permitted"), exists: existsSync(join(work, ".git", "hooks", name)) }).toEqual({ name, code: 1, denied: true, exists: false });
			expect(resolve(String(r?.input?.cwd))).toBe(work);
		}
	});

	for (const cwd of ["skill://tdd", "local://notes", "local:/notes", "artifact://12"]) {
		test(`a cwd holding an internal URL is refused, never wrapped: ${cwd}`, async () => {
			const r = await fencedInput({ command: "true", cwd }, session, env);
			expect({ block: r?.block, input: r?.input, why: r?.reason?.includes("internal URL") }).toEqual({ block: true, input: undefined, why: true });
		});
	}

	test("a nonexistent cwd is refused, never wrapped", async () => {
		const r = await fencedInput({ command: "true", cwd: join(session, "no-such-dir") }, session, env);
		expect({ block: r?.block, input: r?.input, why: r?.reason?.includes("is not an existing directory") }).toEqual({ block: true, input: undefined, why: true });
	});

	// Machine-local: the host's own resolver, where OMP is installed (skipped visibly on a fresh clone,
	// so it is imported dynamically: a static import of this absolute path would fail the whole file there).
	const PATH_UTILS = "/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/tools/path-utils.ts";
	test.skipIf(!existsSync(PATH_UTILS))("parity: every cwd the fence accepts is the directory OMP's resolveToCwd picks", async () => {
		const { resolveToCwd } = (await import(PATH_UTILS)) as { resolveToCwd(p: string, cwd: string): string };
		mkdirSync(join(session, "sub"), { recursive: true });
		const sub = join(session, "sub");
		const spellings = ["sub", "./sub", "sub/", `../${basename(session)}/sub`, sub, `${sub}/`, "//", "/", "~", `~/${relative(homedir(), sub)}`, `~${relative(homedir(), sub)}`];
		const got = await Promise.all(spellings.map(async (cwd) => [cwd, (await fencedInput({ command: "true", cwd }, session, env))?.input?.cwd]));
		expect(got).toEqual(spellings.map((cwd) => [cwd, resolveToCwd(cwd, session)]));
	});
});

describe("a ledger file symlinked out of the configured directory is fenced where it resolves (M4b review B2)", () => {
	const home = tmp("fence-reloc-home");
	const env = { HOME: home, PATH: process.env.PATH };
	const configured = join(home, ".agent-system-2");
	const real = join(home, "relocated-ledger");
	const db = join(real, "ledger.db");
	const link = join(configured, "ledger.db");
	const outside = tmp("fence-reloc-outside");
	let live: Database;
	beforeAll(() => {
		mkdirSync(configured);
		mkdirSync(real);
		live = new Database(db);
		live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe (x); INSERT INTO probe VALUES (1);");
		symlinkSync(db, link);
	});
	afterAll(() => live.close());

	for (const target of [db, `${db}-wal`, `${db}-shm`]) {
		test(`touch ${basename(target)} at its real path: refused`, async () => {
			expect(existsSync(target)).toBe(true);
			const before = statSync(target).mtimeMs;
			const r = sh(await wrapped(`touch ${target}`, outside, env), outside);
			expect({ code: r.code, denied: r.err.includes("Operation not permitted"), mtime: statSync(target).mtimeMs }).toEqual({ code: 1, denied: true, mtime: before });
		});
	}

	test("a sqlite3 insert through the configured symlink is refused and the rows are unchanged", async () => {
		const r = sh(await wrapped(`sqlite3 ${link} 'INSERT INTO probe VALUES (2)'`, outside, env), outside);
		expect(r.code).not.toBe(0);
		expect(live.query("select x from probe order by x").all()).toEqual([{ x: 1 }]);
	});

	test("control: sqlite3 -readonly through the symlink still reads the live WAL database", async () => {
		const r = sh(await wrapped(`sqlite3 -readonly ${link} 'select count(*) from probe'`, outside, env), outside);
		expect({ code: r.code, out: r.out.trim() }).toEqual({ code: 0, out: "1" });
	});
});

describe("a bare repository's hooks are fenced, and only its hooks (M4b review B3)", () => {
	const env = { HOME: tmp("fence-bare-home"), PATH: process.env.PATH };
	let bare = "";
	beforeAll(() => {
		bare = repoWithOrigin().origin; // a bare repository with one pushed commit
	});

	test("a hook write from inside the bare repository is refused", async () => {
		const r = sh(await wrapped("touch hooks/bare-write", bare, env), bare);
		expect({ code: r.code, denied: r.err.includes("Operation not permitted"), exists: existsSync(join(bare, "hooks", "bare-write")) }).toEqual({ code: 1, denied: true, exists: false });
	});

	test("from a directory inside it (refs/heads) the same hooks are fenced", async () => {
		const r = sh(await wrapped("touch ../../hooks/nested-write", join(bare, "refs", "heads"), env), join(bare, "refs", "heads"));
		expect({ code: r.code, exists: existsSync(join(bare, "hooks", "nested-write")) }).toEqual({ code: 1, exists: false });
	});

	test("control: git log in it succeeds, and a write elsewhere in it is not fenced", async () => {
		const log = sh(await wrapped("git log --oneline -1", bare, env), bare);
		expect({ code: log.code, one: log.out.trim().split("\n").length }).toEqual({ code: 0, one: 1 });
		const other = sh(await wrapped("touch not-hooks.txt", bare, env), bare);
		expect({ code: other.code, exists: existsSync(join(bare, "not-hooks.txt")) }).toEqual({ code: 0, exists: true });
	});
});

describe("the bypass guard compares what bash executes, not the bytes around it", () => {
	function bound() {
		const home = tmp("fence-ws");
		const l = Ledger.open(join(home, ".agent-system-2", "ledger.db"), { create: true, backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: "orch", brief: "b", stakes: "normal", mode: "autonomous" });
		const env = { HOME: home, PATH: process.env.PATH, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-ws" };
		const f = fakePi();
		registerFence(f.pi, env, async () => ON, CERTIFIED);
		return { f, l, wl, home, ctx: ctxOf(home) };
	}

	test("outer spaces, tabs and a trailing newline, on the command or around the wrapper, run fenced: no bypass row, no lockout", async () => {
		const { f, l, wl, home, ctx } = bound();
		const pads: [string, (w: string) => string][] = [
			["as returned", (w) => w],
			["padded with spaces", (w) => `  ${w}  `],
			["a trailing newline", (w) => `${w}\n`],
			["leading newline and tab", (w) => `\n\t${w}`],
		];
		let i = 0;
		for (const command of ["  echo ws  ", "\techo ws\n", "echo ws\n"]) {
			for (const [name, pad] of pads) {
				const id = `ws${++i}`;
				const r = await f.emit("tool_call", { toolName: "bash", toolCallId: id, input: { command } }, ctx);
				const executing = pad(String(r?.input?.command));
				await f.emit("tool_execution_start", { toolName: "bash", toolCallId: id, args: { ...r!.input, command: executing } }, ctx);
				const ran = sh(executing, home);
				expect({ name, code: ran.code, out: ran.out, fenced: executing.includes("sandbox-exec") }).toEqual({ name, code: 0, out: "ws\n", fenced: true });
			}
		}
		expect(l.entries(wl, "assumption")).toEqual([]);
		expect(String((await f.emit("tool_call", { toolName: "bash", toolCallId: "ws-next", input: { command: "true" } }, ctx))?.input?.command)).toContain("sandbox-exec");
		l.close();
	});

	test("a genuinely unwrapped execution (the padded original) still trips it", async () => {
		const { f, l, wl, ctx } = bound();
		const input = { command: "  echo ws  " };
		await f.emit("tool_call", { toolName: "bash", toolCallId: "u1", input }, ctx);
		await f.emit("tool_execution_start", { toolName: "bash", toolCallId: "u1", args: input }, ctx);
		expect(l.entries(wl, "assumption").map((e) => e.body)).toEqual([fenceBypassBody("u1")]);
		expect((await f.emit("tool_call", { toolName: "bash", toolCallId: "u2", input: { command: "true" } }, ctx))?.block).toBe(true);
		l.close();
	});
});

describe("the host settings reach the fence only through the reader it is handed", () => {
	/** An 18.4.4-shaped host: the handle registry answers for the one id, the raw global layer carries the flag. */
	const host = (autoBackground: unknown, fence?: unknown) => ({
		getGlobalSettings: () => (fence === undefined ? {} : { gates: { fence: { enabled: fence } } }),
		autoBackground,
	});
	const modules = (Settings: { current?: unknown; loadReadOnly: (o: { cwd: string }) => Promise<unknown> }, version = "18.8.5") =>
		({
			version,
			Settings,
			lookup: (id: string) => (id === "bash.autoBackground.enabled" ? { get: (s: { autoBackground: unknown }) => s.autoBackground } : undefined),
		}) as unknown as HostModules;

	test("the live instance wins over the disk read: live auto-background false refuses even when disk says true", async () => {
		let diskReads = 0;
		const Settings = {
			current: Promise.resolve(host(false)),
			loadReadOnly: async () => {
				diskReads++;
				return host(true);
			},
		};
		const d = tmp("fence-live");
		const f = fakePi();
		registerFence(f.pi, { HOME: d, PATH: process.env.PATH }, (ctx) => fenceSettingsFrom(modules(Settings), ctx));
		const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "live1", input: { command: "true" } }, ctxOf(d));
		expect({ block: r?.block, why: r?.reason?.includes("bash.autoBackground.enabled is false"), diskReads }).toEqual({ block: true, why: true, diskReads: 0 });
	});

	test("with no live instance (18.4.4: Settings.current is null) the disk read decides, from the call's cwd", async () => {
		const cwds: string[] = [];
		const Settings = {
			current: null,
			loadReadOnly: async ({ cwd }: { cwd: string }) => {
				cwds.push(cwd);
				return host(true, false);
			},
		};
		const d = tmp("fence-disk");
		expect({ got: await fenceSettingsFrom(modules(Settings), ctxOf(d)), cwds }).toEqual({ got: { enabled: false, autoBackground: true }, cwds: [d] });
	});

	test("the auto-background value comes from the registered handle, not from a `get` method the host no longer has", async () => {
		const Settings = { current: Promise.resolve({ ...host(false), get: () => true }), loadReadOnly: async () => host(true) };
		expect(await fenceSettingsFrom(modules(Settings), ctxOf(tmp("fence-handle")))).toEqual({ enabled: true, autoBackground: false });
	});

	test("a host whose major.minor is not the verified one refuses every bash call naming both versions", async () => {
		const Settings = { current: Promise.resolve(host(true)), loadReadOnly: async () => host(true) };
		const d = tmp("fence-host-version");
		const f = fakePi();
		registerFence(f.pi, { HOME: d, PATH: process.env.PATH }, (ctx) => fenceSettingsFrom(modules(Settings, "18.5.0"), ctx));
		const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "hv1", input: { command: "true" } }, ctxOf(d));
		expect({ block: r?.block, reason: r?.reason }).toEqual({
			block: true,
			reason: expect.stringContaining(`the running OMP is 18.5.0 and the gates were verified on OMP ${VERIFIED_HOST}`),
		});
		expect(r?.reason).toContain("refused rather than run this bash call outside the fence");
	});

	test("a host with no handle registered for bash.autoBackground.enabled refuses naming the host version and the member", async () => {
		const Settings = { current: Promise.resolve(host(true)), loadReadOnly: async () => host(true) };
		const m = { ...modules(Settings), lookup: () => undefined } as unknown as HostModules;
		const d = tmp("fence-host-member");
		const f = fakePi();
		registerFence(f.pi, { HOME: d, PATH: process.env.PATH }, (ctx) => fenceSettingsFrom(m, ctx));
		const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "hm1", input: { command: "true" } }, ctxOf(d));
		expect(r?.reason).toContain('OMP 18.8.5: lookup("bash.autoBackground.enabled") is missing from @oh-my-pi/pi-coding-agent/config/registry');
	});

	test("registered with no reader, every bash call is refused with the reason named", async () => {
		const f = fakePi();
		registerFence(f.pi, { HOME: tmp("fence-noreader-home"), PATH: process.env.PATH });
		const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "nr1", input: { command: "true" } }, ctxOf(tmp("fence-noreader-cwd")));
		expect({ block: r?.block, why: r?.reason?.includes("no host settings reader was handed to the fence") }).toEqual({ block: true, why: true });
	});
});

describe("a wrapped call must start from the certified shell state (gates/src/shell-start.ts, wl-mv5lrh0drbg0zk)", () => {
	/** The clean-shell switch read as on for every session ("all"). */
	const SWITCH_ON: Parameters<typeof registerFence>[4] = async () => ({ ok: true, value: "all" });
	/** `cleanShell` null registers no switch reader at all. */
	const call = async (check: Parameters<typeof registerFence>[3], input: Record<string, unknown>, settings: FenceSettings = ON, cleanShell: Parameters<typeof registerFence>[4] | null = SWITCH_ON) => {
		const d = tmp("fence-start");
		mkdirSync(join(d, "sub"));
		const f = fakePi();
		registerFence(f.pi, { HOME: d, PATH: process.env.PATH }, async () => settings, check, cleanShell ?? undefined);
		return { d, r: (await f.emit("tool_call", { toolName: "bash", toolCallId: `st${++callId}`, input }, ctxOf(d))) as Revised };
	};
	const isWrapped = (r: Revised) => ({ block: r?.block, wrapped: String(r?.input?.command).includes("sandbox-exec") });

	test("switch off (no reader, \"off\", a list without this session, a read error or throw): named and pty calls are wrapped and the check is never read", async () => {
		let reads = 0;
		const refusing: Parameters<typeof registerFence>[3] = async () => {
			reads++;
			return { certified: false, reasons: ["x"] };
		};
		const before = notices.length;
		const offs: (Parameters<typeof registerFence>[4] | null)[] = [
			null,
			async () => ({ ok: true, value: "off" }),
			async () => ({ ok: true, value: ["wl-other"] }),
			async () => ({ ok: false, error: "gates.cleanShell is 1" }),
			async () => {
				throw new Error("read boom");
			},
		];
		for (const off of offs) {
			for (const input of [{ command: "sleep 1", name: "svc" }, { command: "true", pty: true }]) {
				expect(isWrapped((await call(refusing, input, ON, off)).r)).toEqual({ block: undefined, wrapped: true });
			}
		}
		expect(reads).toBe(0);
		// A failing read is said once per fence instance (call() builds one per call), naming the fix.
		const said = notices.slice(before);
		expect(said.length).toBe(4);
		expect(said.filter((m) => m.includes("(gates.cleanShell is 1)")).length).toBe(2);
		expect(said.filter((m) => m.includes("(read boom)")).length).toBe(2);
		for (const m of said) expect(m).toContain("the clean shell is off for this session and bash runs as before it");
	});

	test("one session follows a flip of the profile file on its next call: on refuses a named call, off wraps it", async () => {
		const d = tmp("fence-flip");
		const agentDir = join(d, "agent");
		mkdirSync(agentDir);
		const file = join(agentDir, "config.yml");
		writeFileSync(file, "gates:\n  cleanShell:\n    - wl-abc\n");
		const f = fakePi();
		const env = { HOME: d, PATH: process.env.PATH, AGENT_SYSTEM_WORKLOAD_ID: "wl-abc" };
		registerFence(f.pi, env, async () => ON, shellStartFixture({ env, host: { getAgentDir: () => agentDir } }).check, async () => readCleanShell(agentDir));
		const named = { command: "sleep 1", name: "svc" };
		const first = await f.emit("tool_call", { toolName: "bash", toolCallId: "flip1", input: named }, ctxOf(d));
		expect({ block: first?.block, named: first?.reason?.includes("named bash call") }).toEqual({ block: true, named: true });
		writeFileSync(file, 'gates:\n  cleanShell: "off"\n');
		expect(isWrapped(await f.emit("tool_call", { toolName: "bash", toolCallId: "flip2", input: named }, ctxOf(d)))).toEqual({ block: undefined, wrapped: true });
		writeFileSync(file, 'gates:\n  cleanShell: "all"\n');
		expect((await f.emit("tool_call", { toolName: "bash", toolCallId: "flip3", input: named }, ctxOf(d)))?.block).toBe(true);
	});

	test("registered with no shell-start check, every bash call is refused with the reason named", async () => {
		const { r } = await call(undefined, { command: "true" });
		expect({ block: r?.block, why: r?.reason?.includes("no shell-start check was handed to the fence") }).toEqual({ block: true, why: true });
	});

	test("the check reads the call as typed and the directory it runs in; an uncertified call is refused with every reason", async () => {
		const seen: unknown[] = [];
		const { d, r } = await call(async (ctx, input, cwd) => {
			seen.push({ ctx: ctx.cwd, input, cwd });
			return { certified: false, reasons: ["one", "two"] };
		}, { command: "true", cwd: "sub" });
		expect(seen).toEqual([{ ctx: d, input: { command: "true", cwd: "sub" }, cwd: join(d, "sub") }]);
		expect(r).toEqual({ block: true, reason: shellStartReason(["one", "two"]) });
		expect(r?.reason).toStartWith("M4b OS fence: ");
	});

	test("a check that throws refuses the call", async () => {
		const { r } = await call(async () => {
			throw new Error("boom");
		}, { command: "true" });
		expect({ block: r?.block, why: r?.reason?.includes("the shell-start certificate could not be read (boom)") }).toEqual({ block: true, why: true });
	});

	test("with the fence off and the switch off the check is not read and the call runs as before: the certificate covers fenced calls only", async () => {
		let reads = 0;
		const check: Parameters<typeof registerFence>[3] = async () => {
			reads++;
			return { certified: false, reasons: ["x"] };
		};
		for (const off of [null, async () => ({ ok: true as const, value: "off" as const })]) {
			const { r } = await call(check, { command: "true" }, { enabled: false, autoBackground: true }, off);
			expect(r).toBeUndefined();
		}
		expect(reads).toBe(0);
	});

	test("with the fence off and the switch on for this session every call is refused, naming both fixes, and the check is not read", async () => {
		let reads = 0;
		const check: Parameters<typeof registerFence>[3] = async () => {
			reads++;
			return { certified: true, reasons: [] };
		};
		const { r } = await call(check, { command: "true" }, { enabled: false, autoBackground: true });
		expect({ block: r?.block, reads }).toEqual({ block: true, reads: 0 });
		expect(r?.reason).toStartWith("M4b OS fence: ");
		expect(r?.reason).toContain("gates.fence.enabled");
		expect(r?.reason).toContain("as2 clean-shell off");
	});

	test("a certified call is wrapped", async () => {
		const { r } = await call(shellStartFixture().check, { command: "true" });
		expect({ block: r?.block, wrapped: String(r?.input?.command).includes("sandbox-exec") }).toEqual({ block: undefined, wrapped: true });
	});

	test("each refusal says what to do: a named call (async), a hook name, a newline value, a changed environ (restart)", async () => {
		const named = (await call(shellStartFixture().check, { command: "sleep 1", name: "svc" })).r?.reason ?? "";
		expect(named).toMatch(/named/);
		expect(named).toMatch(/async: true/);
		const hook = (await call(shellStartFixture({ environ: environOf({ PATH: "/bin", BASH_ENV: "/tmp/x" }) }).check, { command: "true" })).r?.reason ?? "";
		expect(hook).toContain("BASH_ENV");
		expect(hook).toContain("relaunch as2 from a shell that does not export it");
		expect(hook).not.toContain("/tmp/x");
		const newline = (await call(shellStartFixture({ shellEnv: { PATH: "/bin", X: "a\nb" } }).check, { command: "true" })).r?.reason ?? "";
		expect(newline).toMatch(/newline/);
		const moved = (await call(shellStartFixture({ gateLoad: environOf({ PATH: "/bin" }), environ: environOf({ PATH: "/usr/bin" }) }).check, { command: "true" })).r?.reason ?? "";
		expect(moved).toContain("restart the session");
		for (const reason of [named, hook, newline, moved]) expect(reason).toStartWith("M4b OS fence: ");
	});
});

describe("a typed copy of the fence's own wrapper is row 18's refusal through the gates, and the fence alone refuses every sandbox-exec the shell would run (items 65, 99)", () => {
	test("the fence alone refuses a copy of its own wrapper by the parsed head word, and does not strip it", async () => {
		const d = tmp("fence-rewrap");
		const env = { HOME: d, PATH: process.env.PATH };
		const first = await wrapped("printf one", d, env);
		expect(first).toStartWith("'/usr/bin/sandbox-exec' -p '(version 1)(allow default)");
		expect(await fenced(first, d, env)).toEqual({ block: true, reason: ALREADY_WRAPPED_REASON });
	});

	test("a plain command is unchanged: the same wrapper as before, and no note", async () => {
		const d = tmp("fence-rewrap-plain");
		const env = { HOME: d, PATH: process.env.PATH };
		const r = await fenced("printf one", d, env);
		expect(Object.keys(r ?? {})).toEqual(["input"]);
		expect(copiedWrapper(String(r?.input?.command))).toEqual({ profile: fenceProfile([{ kind: "subpath", path: `${realpathSync(d)}/.agent-system-2` }]), command: "printf one" });
	});

	/** The profile the fence writes for a plain command run from `cwd`. */
	async function ownProfile(cwd: string, env: Record<string, string | undefined>): Promise<string> {
		return copiedWrapper(await wrapped("printf one", cwd, env))!.profile;
	}

	// Lane 11 of item 24's workload (wl-muraerdsgw7gn4), 2026-10-09T03:00:09Z, call
	// toolu_01KsVV6tAzk3qkxjnfEnkpLP, as the model wrote it: the fence's wrapper from its `git fetch
	// origin` call one turn earlier, copied around the next command. 35 of the lane's next 37 bash
	// calls were this shape and every one was refused (item 65). The lane ran in a linked worktree,
	// so the profile carries its own `.git` file and the main repository's hooks.
	const LANE_11_COMMAND =
		`'/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath "/Users/jowolff/.agent-system-2"))(deny file-write* (literal "/Users/jowolff/code/agent-system-2.0-lanes/wl-muraerdsgw7gn4/.git"))(deny file-write* (subpath "/Users/jowolff/code/agent-system-2.0/.git/hooks"))' /bin/bash -c 'git rebase origin/main'`;

	test("regression: lane 11's refused command is the fence's own wrapper around `git rebase origin/main`", () => {
		expect(copiedWrapper(LANE_11_COMMAND)).toEqual({
			profile:
				'(version 1)(allow default)(deny file-write* (subpath "/Users/jowolff/.agent-system-2"))(deny file-write* (literal "/Users/jowolff/code/agent-system-2.0-lanes/wl-muraerdsgw7gn4/.git"))(deny file-write* (subpath "/Users/jowolff/code/agent-system-2.0/.git/hooks"))',
			command: "git rebase origin/main",
		});
	});

	test("regression: lane 11's command, replayed from a linked worktree with its three paths, is row 18's refusal naming `git rebase origin/main`; resent bare, the fence wraps it", async () => {
		const r = repoWithOrigin();
		const lane = join(r.root, "lanes", "wl-lane11");
		git(r.work, "worktree", "add", "-q", "-b", "wl/lane11", lane, "main");
		const home = tmp("fence-rewrap-lane11-home");
		const env = { HOME: home, PATH: process.env.PATH, ...RUN_ENV };
		// The lane's profile with this test's paths in place of the lane's: the same three clauses.
		const command = LANE_11_COMMAND.replace("/Users/jowolff/.agent-system-2", `${realpathSync(home)}/.agent-system-2`)
			.replace("/Users/jowolff/code/agent-system-2.0-lanes/wl-muraerdsgw7gn4", realpathSync(lane))
			.replace("/Users/jowolff/code/agent-system-2.0", realpathSync(r.work));
		// Exactly the profile the fence writes there: even the fence's own wrapper, typed, is refused.
		const own = await ownProfile(lane, env);
		expect(copiedWrapper(command)?.profile).toBe(own);
		const f = fakePi();
		p11Gates(f.pi, env, async () => ON, CERTIFIED);
		const ctx = ctxOf(lane);
		const before = notices.length;
		// On b61eabe this was ALREADY_WRAPPED_REASON; from item 77 (PR #28) the fence stripped it and ran the rebase.
		const now = await f.emit("tool_call", { toolName: "bash", toolCallId: "lane11-rebase", input: { command } }, ctx);
		expect(now).toEqual({ block: true, reason: copiedWrapperReason("git rebase origin/main") });
		expect(now?.reason).toEndWith("Resend the bare command: git rebase origin/main");
		const bare = await f.emit("tool_call", { toolName: "bash", toolCallId: "lane11-bare", input: { command: "git rebase origin/main" } }, ctx);
		expect(bare).toEqual({ input: { command: wrapCommand("/usr/bin/sandbox-exec", own, "git rebase origin/main") } });
		expect(notices.slice(before)).toEqual([]);
	});

	test("a typed wrapper around a reserved action is row 18's refusal, ahead of row 6; resent bare it is row 6's, naming the plain command", async () => {
		const r = repoWithOrigin();
		const env = { HOME: tmp("fence-rewrap-rows-home"), PATH: process.env.PATH, ...RUN_ENV };
		const f = fakePi();
		p11Gates(f.pi, env, async () => ON, CERTIFIED);
		const ctx = ctxOf(r.work);
		const plain = "git push origin main";
		const copied = wrapCommand("/usr/bin/sandbox-exec", await ownProfile(r.work, env), plain);
		expect(await f.emit("tool_call", { toolName: "bash", toolCallId: "r65-push", input: { command: copied } }, ctx)).toEqual({ block: true, reason: copiedWrapperReason(plain) });
		const bare = await f.emit("tool_call", { toolName: "bash", toolCallId: "r65-push-bare", input: { command: plain } }, ctx);
		expect(bare?.reason).toContain("push to a protected branch is on the § A4 reserved list");
		expect(bare?.reason).toContain(`Command: ${plain}`);
	});

	test("copiedWrapper takes apart exactly what wrapCommand writes, quoting included, and nothing else", () => {
		const profile = "(version 1)(allow default)(deny file-write* (subpath \"/tmp/it's \\\"here\\\"\"))";
		for (const command of ["printf one", "git commit -m 'it'\"'\"'s done' && echo \"$HOME\"", "cat <<'EOF'\nline\nEOF", "a\n\nb"]) {
			expect(copiedWrapper(wrapCommand("/usr/bin/sandbox-exec", profile, command))).toEqual({ profile, command });
		}
		expect(copiedWrapper("sandbox-exec -p '(version 1)(allow default)' bash -c true")).toEqual({ profile: "(version 1)(allow default)", command: "true" });
		for (const command of [
			"/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/true",
			"cd /tmp && '/usr/bin/sandbox-exec' -p '(version 1)(allow default)' /bin/bash -c 'ls'",
			"'/usr/bin/sandbox-exec' -p '(version 1)(allow default)' /bin/bash -c 'ls' | cat",
			"'/usr/bin/sandbox-exec' -p '(version 1)(allow default)' /bin/bash -c 'ls' > out",
			"'/usr/bin/sandbox-exec' -p \"$P\" /bin/bash -c 'ls'",
			"'/usr/bin/sandbox-exec' -p '(version 1)(allow default)' /bin/zsh -c 'ls'",
			"'/usr/bin/sandbox-exec' -f x.sb /bin/bash -c 'ls'",
			"  sandbox-exec -f x.sb ls | cat",
			"printf one",
		]) {
			expect({ command, parts: copiedWrapper(command) }).toEqual({ command, parts: null });
		}
	});

	test("every sandbox-exec the shell would run is refused by the fence alone; sandbox-exec as data, or inside a longer word, is not", async () => {
		const d = tmp("fence-rewrap-forms");
		const env = { HOME: d, PATH: process.env.PATH };
		for (const command of [
			"/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/true",
			"cd /tmp && '/usr/bin/sandbox-exec' -p '(version 1)(allow default)' /bin/bash -c 'ls'",
			"'/usr/bin/sandbox-exec' -p '(version 1)(allow default)' /bin/bash -c 'ls' | cat",
			"  sandbox-exec -f x.sb ls | cat",
			// A copy around a copy: one level comes off, and the inner command still carries the word.
			wrapCommand("/usr/bin/sandbox-exec", "(version 1)(allow default)", "sandbox-exec -p '(version 1)(allow default)' /bin/bash -c 'ls'"),
			// The word hidden from the text by quoting, which bash still runs (review B1): plain, and under a copy.
			"sand''box-exec -p '(version 1)(allow default)' /bin/sh -c 'ls'",
			"\"sand\"box-exec -p '(version 1)(allow default)' ls",
			"/usr/bin/sandbox-ex\\ec -p '(version 1)(allow default)' ls",
			"nice sand''box-exec -p '(version 1)(allow default)' ls",
			"(sand''box-exec -p '(version 1)(allow default)' ls)",
			"eval \"sand''box-exec -p '(version 1)(allow default)' ls\"",
			wrapCommand("/usr/bin/sandbox-exec", "(version 1)(allow default)", "sand''box-exec -p '(version 1)(allow default)' /bin/bash -c 'ls'"),
		]) {
			expect({ command, r: await fenced(command, d, env) }).toEqual({ command, r: { block: true, reason: ALREADY_WRAPPED_REASON } });
		}
		// A quote-split copy of the whole wrapper is the same six words to bash: refused like any other.
		expect(await fenced("sand''box-exec -p '(version 1)(allow default)' /bin/bash -c 'ls'", d, env)).toEqual({ block: true, reason: ALREADY_WRAPPED_REASON });
		for (const command of [
			"cat sandbox-exec.log",
			"echo my-sandbox-exec",
			"grep sandbox-exec.c src",
			"printf sandbox-executor",
			// Quoted data the word regex refused before item 99: the parsed word is no command here.
			"grep -n 'sandbox-exec' notes.txt",
			"git commit -m 'drop the sandbox-exec strip'",
			"cat <<'EOF'\n'/usr/bin/sandbox-exec' -p '(version 1)(allow default)' /bin/bash -c 'ls'\nEOF",
		]) {
			expect({ command, wrapped: (await fenced(command, d, env))?.input?.command }).toEqual({ command, wrapped: expect.stringContaining("/bin/bash -c") });
		}
	});

	test("regression (review B1): a copied wrapper around a quote-split nested wrapper around `git push origin main` is refused by row 18 when it leads and by row 6 when it does not, and by the fence; origin's main does not move", async () => {
		const r = repoWithOrigin();
		const env = { HOME: tmp("fence-rewrap-nested-home"), PATH: process.env.PATH };
		const head = git(r.origin, "rev-parse", "main");
		commit(r.work, "ahead.txt", "ahead");
		const own = await ownProfile(r.work, env);
		const bare = "sand''box-exec -p '(version 1)(allow default)' git push origin main";
		const shell = "sand''box-exec -p '(version 1)(allow default)' /bin/bash -c 'git push origin main'";
		for (const command of [bare, wrapCommand("/usr/bin/sandbox-exec", own, bare), wrapCommand("/usr/bin/sandbox-exec", own, shell)]) {
			const f = fakePi();
			p11Gates(f.pi, env);
			// Leading, each is a typed wrapper: row 18 answers first. On ef448c1 the outer copy came off
			// and the inner one hid the push from every row (review B1).
			const got = await f.emit("tool_call", { toolName: "bash", toolCallId: `nested-${callId++}`, input: { command } }, ctxOf(r.work));
			expect({ command, block: got?.block, reason: got?.reason }).toEqual({ command, block: true, reason: expect.stringMatching(/^P-11 row 18 refused this/) });
		}
		for (const command of [`cd . && ${bare}`, `cd . && ${shell}`]) {
			const f = fakePi();
			p11Gates(f.pi, env);
			// Not leading, row 6 answers, and with the push itself: the expander follows the quote-split
			// sandbox-exec (and the /bin/bash -c under it) the way it follows nice or env.
			const got = await f.emit("tool_call", { toolName: "bash", toolCallId: `nested-${callId++}`, input: { command } }, ctxOf(r.work));
			expect({ command, block: got?.block, reason: got?.reason }).toEqual({ command, block: true, reason: expect.stringContaining("push to a protected branch is on the § A4 reserved list") });
		}
		// A command that is not reserved, under a sandbox-exec the fence did not write: row 6 names the wrapper.
		const f = fakePi();
		p11Gates(f.pi, env);
		const named = await f.emit("tool_call", { toolName: "bash", toolCallId: "nested-named", input: { command: "cd . && sand''box-exec -p '(version 1)(allow default)' git status" } }, ctxOf(r.work));
		expect(named?.reason).toContain("`sandbox-exec -p` wraps the command in a Seatbelt profile of the model's own");
		expect(named?.reason).toContain("the M4b OS fence adds sandbox-exec itself");
		// The fence alone, without the rows, refuses it too: the word is found by parsing, not by its text.
		expect(await fenced(bare, r.work, env)).toEqual({ block: true, reason: ALREADY_WRAPPED_REASON });
		expect(await fenced(wrapCommand("/usr/bin/sandbox-exec", own, shell), r.work, env)).toEqual({ block: true, reason: ALREADY_WRAPPED_REASON });
		expect(git(r.origin, "rev-parse", "main")).toBe(head);
	});

	test("a carriage return in a copied inner command is kept as written (review S2), so row 18 names it to resend", async () => {
		const d = tmp("fence-rewrap-cr");
		const env = { HOME: d, PATH: process.env.PATH };
		const inner = "printf 'a\rb' | od -c";
		expect(copiedWrapper(wrapCommand("/usr/bin/sandbox-exec", "(version 1)(allow default)", inner))).toEqual({ profile: "(version 1)(allow default)", command: inner });
		expect(copiedWrapper(wrapCommand("/usr/bin/sandbox-exec", "(version 1)(allow default)", "printf '\uE000'"))).toBeNull();
		const own = await wrapped(inner, d, env);
		expect(copiedWrapper(own)?.command).toBe(inner);
		expect(await fenced(own, d, env)).toEqual({ block: true, reason: ALREADY_WRAPPED_REASON });
		const f = fakePi();
		p11Gates(f.pi, env, async () => ON, CERTIFIED);
		expect(await f.emit("tool_call", { toolName: "bash", toolCallId: "cr-copy", input: { command: own } }, ctxOf(d))).toEqual({ block: true, reason: copiedWrapperReason(inner) });
	});

	test("with the fence off a copied wrapper runs as written, nothing is refused", async () => {
		const d = tmp("fence-rewrap-off");
		const r = await fenced("sandbox-exec -p '(version 1)(allow default)' /bin/bash -c 'true'", d, { HOME: d, PATH: process.env.PATH }, { enabled: false, autoBackground: true });
		expect(r).toBeUndefined();
	});
});

describe("the flag: gates.fence.enabled false", () => {
	test("runs bash unwrapped and writes one ledger entry saying so", async () => {
		const home = tmp("fence-off");
		const db = join(home, ".agent-system-2", "ledger.db");
		const l = Ledger.open(db, { create: true, backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: "orch", brief: "b", stakes: "normal", mode: "autonomous" });
		const env = { HOME: home, PATH: process.env.PATH, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-off" };
		const f = fakePi();
		registerFence(f.pi, env, async () => ({ enabled: false, autoBackground: true }));
		const ctx = ctxOf(home);
		for (const command of ["echo one", "echo two"]) {
			expect(await f.emit("tool_call", { toolName: "bash", toolCallId: command, input: { command } }, ctx)).toBeUndefined();
		}
		const rows = l.entries(wl, "assumption");
		expect(rows.map((r) => [r.body, r.created_by])).toEqual([[FENCE_OFF_BODY, "lane-off"]]);
		l.close();
	});
});

describe("row 3 reads the original command, not the wrapper; row 8 refuses a push from a session with no workload", () => {
	test("a wrapped `git fetch && git rebase origin/main` still mints a receipt; a push with no workload is refused before and after it", async () => {
		const r = repoWithOrigin();
		git(r.work, "switch", "-q", "-c", "feat");
		commit(r.work, "f.txt", "f\n");
		advanceOriginMain(r.root, r.origin);
		const env = { HOME: tmp("fence-r8-home"), PATH: process.env.PATH, ...RUN_ENV };
		const f = fakePi();
		p11Gates(f.pi, env, async () => ON, CERTIFIED);
		const ctx = ctxOf(r.work);
		const push = { toolName: "bash", toolCallId: "push-1", input: { command: "git push origin feat" } };
		// Row 8 refuses a workload-less push before it fetches or checks the upstream (REVIEW.md N6).
		expect((await f.emit("tool_call", push, ctx))?.reason).toContain("this session has no workload");

		const original = "git fetch origin && git rebase origin/main";
		const call = await f.emit("tool_call", { toolName: "bash", toolCallId: "rb-1", input: { command: original } }, ctx);
		const revised = String(call?.input?.command);
		expect(revised).toContain("sandbox-exec");
		const ran = sh(revised, r.work, env);
		expect(ran.code).toBe(0);
		await f.emit("tool_result", { toolName: "bash", toolCallId: "rb-1", input: call!.input!, details: {}, isError: false }, ctx);

		const s = gateSession(ctx as never, env);
		expect(s.history.at(-1)).toEqual({ kind: "bash", command: original, exitCode: 0 });
		expect(s.bashOriginals.size).toBe(0);
		// Row 8 reads the push itself: with no workload there is no test record, rebased or not.
		const after = await f.emit("tool_call", { ...push, toolCallId: "push-2" }, ctx);
		expect(after?.block).toBe(true);
		expect(after?.reason).toContain("this session has no workload");
	});
});

describe("known-open door: the eval tool's subprocesses are NOT under the fence", () => {
	test("an eval Bun.$ write into a fenced directory succeeds, and the fence does not touch eval calls", async () => {
		const home = tmp("fence-eval");
		const dir = join(home, ".agent-system-2");
		mkdirSync(dir);
		const env = { HOME: home, PATH: process.env.PATH };
		// The same directory is refused to a fenced bash call …
		expect(sh(await wrapped(`touch ${dir}/from-bash`, home, env), home).code).not.toBe(0);
		// … but an eval call passes through the fence unrevised, and its subprocess writes there.
		const f = fakePi();
		registerFence(f.pi, env, async () => ON);
		const code = `await Bun.$\`touch ${dir}/from-eval\``;
		expect(await f.emit("tool_call", { toolName: "eval", toolCallId: "e1", input: { language: "js", code } }, ctxOf(home))).toBeUndefined();
		await Bun.$`touch ${dir}/from-eval`;
		expect(existsSync(join(dir, "from-eval"))).toBe(true);
		expect(existsSync(join(dir, "from-bash"))).toBe(false);
	});
});

// The 181 real read-only git commands (M4b step 1's list, from Jo's shell history and agent
// transcripts). Machine-local evidence: the test is skipped, visibly, where the list is absent.
const HISTORY = process.env.M4B_HISTORY_LIST ?? "/Users/jowolff/agent-scratch/agent-system-2.0/migration/M4b/step1/scripts/history-all.json";
describe.skipIf(!existsSync(HISTORY))("the 181 real read-only commands", () => {
	let clone = "";
	beforeAll(() => {
		clone = join(tmp("fence-replay"), "repo");
		git(tmp("fence-replay-src"), "clone", "-q", join(import.meta.dir, "..", ".."), clone);
	});
	test("pass every gate row, and run wrapped with the same exit code as unwrapped", async () => {
		const cmds = JSON.parse(readFileSync(HISTORY, "utf8")) as string[];
		expect(cmds.length).toBe(181);
		const env = { ...RUN_ENV, HOME: process.env.HOME };
		const f = fakePi();
		p11Gates(f.pi, env, async () => ON, CERTIFIED);
		const ctx = ctxOf(clone);
		const refused: string[] = [];
		const changed: string[] = [];
		for (const [i, command] of cmds.entries()) {
			const r = await f.emit("tool_call", { toolName: "bash", toolCallId: `h${i}`, input: { command } }, ctx);
			if (!r?.input || r.block) {
				refused.push(`${command}: ${r?.reason}`);
				continue;
			}
			const plain = sh(command, clone, env).code;
			const wrappedCode = sh(String(r.input.command), clone, env).code;
			if (plain !== wrappedCode) changed.push(`${command}: ${plain} → ${wrappedCode}`);
		}
		expect({ refused, changed }).toEqual({ refused: [], changed: [] });
	}, 300_000);
});

// Item 99 (PLAN wl-mv4xdju27wwdfk rev 6 § 4): every case runs through p11Gates in the host's order.
// A bash tool_call goes through the gates; the assistant message records the args OMP would persist
// (the chained revision, or the typed args when a handler blocked); tool_execution_start carries
// those args; the branch holds the messages and the entries the fake appended, in that order; then
// the context event gets a copy of the messages, as OMP's emitContext hands it over.
describe("item 99: the model sees its own bash calls as typed (the fence's context hook)", () => {
	type Msg = Record<string, unknown>;
	type Args = Record<string, unknown>;
	interface Call {
		id: string;
		input: Args;
		tool?: string;
		output?: string;
		isError?: boolean;
		details?: unknown;
		/** What a later extension made of the revision before OMP recorded and started it. */
		recorded?: (args: Args) => Args;
	}
	const REVISION = "p11-fence-revision";
	const SE = "/usr/bin/sandbox-exec";
	const sha = (s: string) => createHash("sha256").update(s).digest("hex");

	function host(env: Record<string, string | undefined>, cwd: string, opts: { settings?: FenceSettings; before?: AnyHandler; after?: AnyHandler } = {}) {
		const f = fakePi();
		if (opts.before) f.on("tool_call", opts.before);
		p11Gates(f.pi, env, async () => opts.settings ?? ON, CERTIFIED);
		if (opts.after) f.on("tool_call", opts.after);
		const branch: Msg[] = [];
		const messages: Msg[] = [];
		let taken = 0;
		let clock = 1_760_000_000_000;
		const add = (entry: Msg) => branch.push({ id: `e${branch.length + 1}`, ...entry });
		const sessionManager = { getHeader: () => null, getEntries: () => branch, getBranch: () => [...branch] };
		const ctx = { hasUI: true, cwd, sessionManager, ui: { notify: (m: string) => notices.push(m) } };
		const take = () => {
			for (const e of f.entries.slice(taken)) add({ type: "custom", customType: e.type, data: e.data });
			taken = f.entries.length;
		};
		const record = (message: Msg) => {
			messages.push(message);
			add({ type: "message", message });
		};
		return {
			f,
			ctx,
			branch,
			messages,
			record,
			/** An entry written straight to the branch, as a session file from elsewhere would hold it. */
			entry: (customType: string, data: unknown) => add({ type: "custom", customType, data }),
			now: () => ++clock,
			/** One assistant turn of `calls`; returns what each call's tool_call came to and the args OMP recorded. */
			async turn(calls: Call[]) {
				const outcomes: Revised[] = [];
				for (const c of calls) outcomes.push(await f.emit("tool_call", { toolName: c.tool ?? "bash", toolCallId: c.id, input: c.input }, ctx));
				const args = calls.map((c, i) => {
					const o = outcomes[i];
					if (o?.block) return c.input;
					const revised = o?.input ?? c.input;
					return c.recorded ? c.recorded(revised) : revised;
				});
				record({ role: "assistant", timestamp: ++clock, content: calls.map((c, i) => ({ type: "toolCall", id: c.id, name: c.tool ?? "bash", arguments: args[i] })) });
				for (const [i, c] of calls.entries()) {
					await f.emit("tool_execution_start", { toolName: c.tool ?? "bash", toolCallId: c.id, args: args[i] }, ctx);
					take();
					const blocked = outcomes[i]?.block === true;
					record({
						role: "toolResult",
						toolCallId: c.id,
						toolName: c.tool ?? "bash",
						content: [{ type: "text", text: blocked ? outcomes[i]!.reason : (c.output ?? "ok") }],
						isError: blocked || c.isError === true,
						...(c.details === undefined ? {} : { details: c.details }),
						timestamp: ++clock,
					});
				}
				return { outcomes, args };
			},
			/** The context event over a copy of the messages: the gates' own return, and whether the copy they were handed changed. */
			async context(over: typeof ctx = ctx) {
				const sent = structuredClone(messages);
				const before = structuredClone(sent);
				const returned = (await f.results("context", { type: "context", messages: sent }, over)).find((r) => r !== undefined) as { messages: Msg[] } | undefined;
				return { sent, returned, mutated: !Bun.deepEquals(sent, before, true) };
			},
			/**
			 * The session_before_compact event over the session's own message objects, as session-maintenance.ts emits it:
			 * [0, summarize) to summarize, the next `prefix` as the turn prefix, the rest kept; the gates' returns, unchained.
			 */
			async compact(summarize: number, prefix = 0) {
				const messagesToSummarize = messages.slice(0, summarize);
				const turnPrefixMessages = messages.slice(summarize, summarize + prefix);
				const recentMessages = messages.slice(summarize + prefix);
				const firstKeptEntryId = String(branch.find((e) => e.message === recentMessages[0])?.id);
				const preparation = { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, recentMessages, isSplitTurn: prefix > 0, tokensBefore: 4321, previousSummary: "an earlier summary" };
				const given = { ...preparation };
				const snapshot = structuredClone(messages);
				const results = await f.results("session_before_compact", { type: "session_before_compact", preparation, branchEntries: [...branch], signal: new AbortController().signal }, ctx);
				return { preparation, given, snapshot, results };
			},
		};
	}
	/** The bash command of block `j` of message `i`. */
	const commandOf = (messages: Msg[] | undefined, i: number, j = 0) => ((messages?.[i]?.content as { arguments: Args }[] | undefined)?.[j]?.arguments.command as string | undefined);

	test("R1 a persisted fenced call renders to the model as typed, with its cwd, timeout and id, and the input is not mutated", async () => {
		const d = tmp("unwrap-r1");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		const { args } = await s.turn([{ id: "r1", input: { command: "git status", cwd: d, timeout: 30 } }]);
		const wrapper = String(args[0]!.command);
		expect(copiedWrapper(wrapper)?.command).toBe("git status");
		expect(s.f.entries.filter((e) => e.type === REVISION)).toEqual([{ type: REVISION, data: { toolCallId: "r1", sha256: sha(wrapper) } }]);
		const { sent, returned, mutated } = await s.context();
		expect(returned?.messages[0]?.content).toEqual([{ type: "toolCall", id: "r1", name: "bash", arguments: { ...args[0], command: "git status" } }]);
		expect((returned?.messages[0]?.content as { arguments: Args }[] | undefined)?.[0]?.arguments).toEqual({ command: "git status", cwd: args[0]!.cwd, timeout: 30 });
		expect(mutated).toBe(false);
		expect(commandOf(sent, 0)).toBe(wrapper);
		// The unchanged result keeps its identity: OMP's shallow-clone fallback hands over the session's own objects.
		expect(returned?.messages[1]).toBe(sent[1]!);
		expect(returned?.messages[0]?.timestamp).toBe(sent[0]!.timestamp);
	});

	test("R1b a fence-approved revision a later extension padded with outer whitespace is unwrapped", async () => {
		const d = tmp("unwrap-r1b");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		const { args } = await s.turn([{ id: "pad", input: { command: "git status" }, recorded: (a) => ({ ...a, command: `\n \t${String(a.command)} \n` }) }]);
		expect(String(args[0]!.command)).toStartWith("\n \t'/usr/bin/sandbox-exec'");
		expect(s.f.entries.map((e) => e.type)).toEqual([REVISION]);
		const { returned } = await s.context();
		expect(commandOf(returned?.messages, 0)).toBe("git status");
	});

	test("R2 a typed copy of the wrapper is kept as typed: refused by row 18, or by row 15 before it", async () => {
		const d = tmp("unwrap-r2");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		const { args } = await s.turn([{ id: "c1", input: { command: "git status" } }]);
		const wrapper = String(args[0]!.command);
		const copy = await s.turn([{ id: "c2", input: { command: wrapper } }]);
		expect(copy.outcomes[0]).toEqual({ block: true, reason: copiedWrapperReason("git status") });
		expect(s.f.entries.filter((e) => e.type === REVISION).map((e) => (e.data as { toolCallId: string }).toolCallId)).toEqual(["c1"]);
		const { returned } = await s.context();
		expect(commandOf(returned?.messages, 0)).toBe("git status");
		expect(commandOf(returned?.messages, 2)).toBe(wrapper);

		const o = host({ HOME: d, PATH: process.env.PATH, AGENT_SYSTEM_ROLE: "orchestrator" }, d);
		const typed = wrapCommand(SE, copiedWrapper(wrapper)!.profile, "touch x");
		const refused = await o.turn([{ id: "o1", input: { command: typed } }]);
		expect(refused.outcomes[0]?.block).toBe(true);
		expect(refused.outcomes[0]?.reason).toContain(ORCHESTRATOR_ROLE_REFUSAL);
		expect(refused.outcomes[0]?.reason).not.toStartWith("P-11 row 18");
		expect(o.f.entries.filter((e) => e.type === REVISION)).toEqual([]);
		expect((await o.context()).returned).toBeUndefined();
	});

	test("R3 a fenced call whose own output starts like row 18's refusal is unwrapped", async () => {
		const d = tmp("unwrap-r3");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		const command = "printf '%s\\n' 'P-11 row 18 refused this: printed'; exit 1";
		await s.turn([{ id: "r3", input: { command }, output: "P-11 row 18 refused this: printed\n\nCommand exited with code 1", isError: true }]);
		const { returned } = await s.context();
		expect(commandOf(returned?.messages, 0)).toBe(command);
	});

	test("R3b no entry when the started args are not the fence's proposal: a later wrapper-shaped replacement, and a post-fence block", async () => {
		const d = tmp("unwrap-r3b");
		const env = { HOME: d, PATH: process.env.PATH };
		const replacing = host(env, d, {
			after: (e) => (e.toolName === "bash" ? { input: { ...(e.input as Args), command: wrapCommand(SE, "(version 1)(allow default)", String((e.input as Args).command)) } } : undefined),
		});
		const replaced = await replacing.turn([{ id: "rp1", input: { command: "git status" } }]);
		expect(replaced.args[0]!.command).toBe(wrapCommand(SE, "(version 1)(allow default)", "git status"));
		expect(replacing.f.entries).toEqual([{ type: "p11-fence-bypassed", data: { body: fenceBypassBody("rp1") } }]);
		expect((await replacing.context()).returned).toBeUndefined();

		const blocking = host(env, d, { after: (e) => (e.toolName === "bash" ? { block: true, reason: "a later extension blocked this" } : undefined) });
		const blocked = await blocking.turn([{ id: "pb1", input: { command: "git status" } }]);
		expect(blocked.outcomes[0]).toEqual({ block: true, reason: "a later extension blocked this" });
		expect(blocked.args[0]).toEqual({ command: "git status" });
		// The pre-existing bypass record, unchanged, and no revision entry.
		expect(blocking.f.entries).toEqual([{ type: "p11-fence-bypassed", data: { body: fenceBypassBody("pb1") } }]);
		expect((await blocking.context()).returned).toBeUndefined();
	});

	test("R3c a later run reuses a fenced call's id with a typed copy: a different wrapper leaves the fenced call unwrapped, a byte-identical one leaves both as recorded", async () => {
		const d = tmp("unwrap-r3c");
		const env = { HOME: d, PATH: process.env.PATH };

		const differs = host(env, d);
		const first = String((await differs.turn([{ id: "x1", input: { command: "git status" } }])).args[0]!.command);
		const other = wrapCommand(SE, "(version 1)(allow default)", "git status");
		expect((await differs.turn([{ id: "x1", input: { command: other } }])).outcomes[0]).toEqual({ block: true, reason: copiedWrapperReason("git status") });
		const a = (await differs.context()).returned?.messages;
		expect([commandOf(a, 0), commandOf(a, 2)]).toEqual(["git status", other]);

		const same = host(env, d);
		expect(String((await same.turn([{ id: "x1", input: { command: "git status" } }])).args[0]!.command)).toBe(first);
		expect((await same.turn([{ id: "x1", input: { command: first } }])).outcomes[0]).toEqual({ block: true, reason: copiedWrapperReason("git status") });
		expect(same.f.entries.filter((e) => e.type === REVISION)).toHaveLength(1);
		expect((await same.context()).returned).toBeUndefined();

		const earlier = host(env, d, { before: (e) => (String((e.input as Args).command).startsWith("'") ? { block: true, reason: "an earlier extension refused this" } : undefined) });
		await earlier.turn([{ id: "x1", input: { command: "git status" } }]);
		expect((await earlier.turn([{ id: "x1", input: { command: first } }])).outcomes[0]).toEqual({ block: true, reason: "an earlier extension refused this" });
		expect(earlier.f.entries.filter((e) => e.type === REVISION)).toHaveLength(1);
		expect((await earlier.context()).returned).toBeUndefined();
	});

	test("R3d an entry on another branch authorizes nothing on the current one", async () => {
		const d = tmp("unwrap-r3d");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		const { args } = await s.turn([{ id: "b1", input: { command: "git status" } }]);
		expect((await s.context()).returned).toBeDefined();
		// The same messages on a branch that forked before the entry: getEntries still holds it.
		const all = [...s.branch];
		const current = all.filter((e) => e.type !== "custom");
		const fork = { ...s.ctx, sessionManager: { getHeader: () => null, getEntries: () => all, getBranch: () => [...current] } };
		const { returned } = await s.context(fork);
		expect(returned).toBeUndefined();
		expect(commandOf(s.messages, 0)).toBe(String(args[0]!.command));
	});

	test("R3e one reused id in two assistant messages with the same timestamp, different wrappers: only the one with a revision entry is unwrapped", async () => {
		const d = tmp("unwrap-r3e");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		const accepted = String((await s.turn([{ id: "x1", input: { command: "echo accepted" } }])).args[0]!.command);
		const refused = wrapCommand(SE, "(version 1)(allow default)", "echo refused");
		expect((await s.turn([{ id: "x1", input: { command: refused } }])).outcomes[0]).toEqual({ block: true, reason: copiedWrapperReason("echo refused") });
		expect(s.f.entries.filter((e) => e.type === REVISION)).toEqual([{ type: REVISION, data: { toolCallId: "x1", sha256: sha(accepted) } }]);
		// Both in one millisecond (OMP's provider adapters stamp Date.now()): the branch holds the same objects.
		s.messages[2]!.timestamp = s.messages[0]!.timestamp;
		const out = (await s.context()).returned?.messages;
		expect([commandOf(out, 0), commandOf(out, 2)]).toEqual(["echo accepted", refused]);
	});

	test("R4 lookalikes pass untouched; a doubly wrapped revision loses one level; a fenced command holding U+E000 stays wrapped", async () => {
		const d = tmp("unwrap-r4");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		const profile = "(version 1)(allow default)";
		const wrapper = wrapCommand(SE, profile, "ls");
		const heredoc = `cat <<'EOF'\n${wrapper}\nEOF`;
		const grep = `grep -F "/bin/bash -c" notes.txt`;
		const refusedForms = [`sandbox-exec -p '${profile}' /bin/bash -c 'ls' extra`, `sandbox-exec -f file /bin/bash -c ls`, `${wrapper} | cat`];
		for (const [i, command] of refusedForms.entries()) expect((await s.turn([{ id: `lk${i}`, input: { command } }])).outcomes[0]?.block).toBe(true);
		const fenced = await s.turn([
			{ id: "hd", input: { command: heredoc } },
			{ id: "gr", input: { command: grep } },
			{ id: "pua", input: { command: "printf '\uE000'" } },
		]);
		expect(fenced.args.map((a) => String(a.command).startsWith(`'${SE}'`))).toEqual([true, true, true]);
		// A non-bash tool whose command holds the wrapper, under the id of a fenced bash call.
		await s.turn([{ id: "hd", tool: "remote_shell", input: { command: fenced.args[0]!.command } }]);
		// Persisted before this landed: wrapper-shaped, ok result, no entry.
		const old = wrapCommand(SE, profile, "git log -1");
		s.record({ role: "assistant", timestamp: s.now(), content: [{ type: "toolCall", id: "old", name: "bash", arguments: { command: old } }] });
		s.record({ role: "toolResult", toolCallId: "old", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: s.now() });
		// A doubly wrapped revision with its entry.
		const double = wrapCommand(SE, profile, wrapper);
		s.record({ role: "assistant", timestamp: s.now(), content: [{ type: "toolCall", id: "dbl", name: "bash", arguments: { command: double } }] });
		s.entry(REVISION, { toolCallId: "dbl", sha256: sha(double) });
		s.record({ role: "toolResult", toolCallId: "dbl", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: s.now() });

		const { sent, returned } = await s.context();
		const out = returned?.messages;
		for (let i = 0; i < refusedForms.length; i++) expect(commandOf(out, i * 2)).toBe(refusedForms[i]);
		const at = refusedForms.length * 2;
		expect([commandOf(out, at, 0), commandOf(out, at, 1), commandOf(out, at, 2)]).toEqual([heredoc, grep, String(fenced.args[2]!.command)]);
		const remote = at + 4;
		expect(out?.[remote]).toBe(sent[remote]!);
		expect(commandOf(out, remote + 2)).toBe(old);
		expect(commandOf(out, remote + 4)).toBe(wrapper);
	});

	// OMP's own rendering, pinned: buildAsyncResultBatchMessage (pi-coding-agent 18.8.6
	// session/async-job-delivery.ts) run in a throwaway script over these jobs, each labelled by OMP's
	// rule for the command it ran (tools/bash.ts:832), the fence's wrapper with the ledger at /l.db and
	// a cwd outside any repository: a one-target profile, so the typed command shows in the label.
	const P = `'/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath "/"))' /bin/bash -c `;
	const META = { source: { type: "report", value: "background job delivery" } };
	/** One entry of an async-result message's `details.jobs`, as OMP writes it. */
	interface Job {
		jobId: string;
		type: "bash";
		label: string;
		durationMs: number;
	}
	const job = (jobId: string, label: string): Job => ({ jobId, type: "bash", label, durationMs: 5 });
	const batch = (content: unknown, jobs: Job[], timestamp: number) => ({ role: "custom", customType: "async-result", content, display: true, attribution: "agent", details: { meta: META, jobs }, timestamp });
	const BATCH_A =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'sleep 1; echo one') ──\none\n── Job bg_2 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo two') ──\ntwo\n</system-notice>";
	const BATCH_B =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_3 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo \"(\n) ──\n\"') ──\nthree\n── Job bg_4 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo \"a\nb\"') ──\nfour\n</system-notice>";
	const BATCH_C =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_5 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo \"\nx\"') ──\nfive\n── Job bg_6 (printf plain) ──\nsix\n</system-notice>";
	const BATCH_D = "<system-notice>\nBackground job bg_7 has completed. Resume your work using the result below.\nseven\n</system-notice>";
	const BATCH_F =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_8 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo xxxxxxxxxx...) ──\neight\n── Job bg_9 (printf nine) ──\nnine\n</system-notice>";
	const BATCH_E1 =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo first') ──\nfirst\n── Job bg_2 (printf other) ──\nother\n</system-notice>";
	const BATCH_E2 =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo second') ──\nsecond\n── Job bg_2 (printf other) ──\nother\n</system-notice>";
	// bg_10's output holds bg_11's exact header, once after `LOG: ` and once as a whole line.
	const BATCH_G =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_10 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'cat build.log') ──\nLOG: ── Job bg_11 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo eleven') ──\n── Job bg_11 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo eleven') ──\nbuilt\n── Job bg_11 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo eleven') ──\neleven\n</system-notice>";
	// bg_12's label is `echo "\n\n\n) ──\nx"`: the format pass collapsed its blank lines, leaving its own `) ──` at a line end.
	const BATCH_H =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_12 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo \"\n) ──\nx\"') ──\ntwelve\n── Job bg_13 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo thirteen') ──\nthirteen\n</system-notice>";
	// bg_14's label holds the table row `| a  |  b |`, which the format pass compacted to `|a|b|`.
	const BATCH_T =
		"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_14 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo \"\n|a|b|\n\"') ──\nfourteen\n── Job bg_15 (printf plain) ──\nfifteen\n</system-notice>";
	/** `label` with each line's end trimmed: jobHeader's second exact form, the one three cases rule out. */
	const trimmedLines = (label: string) => label.split("\n").map((line) => line.trimEnd()).join("\n");
	const LONG = `echo ${"x".repeat(130)}`;
	const started = (jobId: string) => ({ output: `Background job ${jobId} started.`, details: { async: { state: "running", jobId, type: "bash" } } });
	const shortProfile = () => {
		const d = tmp("unwrap-r5");
		return { d, env: { HOME: d, PATH: process.env.PATH, AGENT_SYSTEM_LEDGER_DB: "/l.db" } };
	};
	/** The text of a returned batch: the content string, or its first text part. */
	const textOf = (m: Msg | undefined) => (typeof m?.content === "string" ? m.content : (m?.content as { text: string }[] | undefined)?.[0]?.text);

	test("R5 fence-labelled job headers of a multi-job async-result are re-rendered from the typed command, an unmappable one loses its label, and a single job or a non-fence label is untouched", async () => {
		const { d, env } = shortProfile();
		const s = host(env, d);
		const start = async (id: string, command: string, jobId: string) => String((await s.turn([{ id, input: { command }, ...started(jobId) }])).args[0]!.command);
		// The fence's wrappers are the ones the pinned labels were rendered from.
		expect(await start("j1", "sleep 1; echo one", "bg_1")).toBe(`${P}'sleep 1; echo one'`);
		s.record(batch(BATCH_A, [job("bg_1", `${P}'sleep 1; echo one'`), job("bg_2", `${P}'echo two'`)], s.now()));
		expect(await start("j3", 'echo "(\n) ──\n"', "bg_3")).toBe(`${P}'echo "(\n) ──\n"'`);
		expect(await start("j4", 'echo "a  \nb"', "bg_4")).toBe(`${P}'echo "a  \nb"'`);
		s.record(batch(BATCH_B, [job("bg_3", `${P}'echo "(\n) ──\n"'`), job("bg_4", `${P}'echo "a  \nb"'`)], s.now()));
		await start("j5", 'echo "\n\n\nx"', "bg_5");
		s.record(batch(BATCH_C, [job("bg_5", `${P}'echo "\n\n\nx"'`), job("bg_6", "printf plain")], s.now()));
		await start("j7", "echo seven", "bg_7");
		s.record(batch(BATCH_D, [job("bg_7", `${P}'echo seven'`)], s.now()));
		const long = await start("j8", LONG, "bg_8");
		expect(`${long.slice(0, 117)}...`).toBe(`${P}'echo xxxxxxxxxx...`);
		s.record(batch([{ type: "text", text: BATCH_F }, { type: "image", data: "AAAA", mimeType: "image/png" }], [job("bg_8", `${long.slice(0, 117)}...`), job("bg_9", "printf nine")], s.now()));

		const { sent, returned, mutated } = await s.context();
		const out = returned?.messages;
		expect(textOf(out?.[2])).toBe(
			"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 (sleep 1; echo one) ──\none\n── Job bg_2 ──\ntwo\n</system-notice>",
		);
		// Exact match holds for a typed command holding `) ──` at a line end; the trailing blanks OMP trimmed are found through the trimmed form.
		expect(textOf(out?.[7])).toBe(
			'<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_3 (echo "(\n) ──\n") ──\nthree\n── Job bg_4 (echo "a  \nb") ──\nfour\n</system-notice>',
		);
		// Two blank lines collapsed: neither the label nor its trimmed form is in BATCH_C, so bg_5 is located through the span fallback.
		const label5 = `${P}'echo "\n\n\nx"'`;
		expect([BATCH_C.includes(label5), BATCH_C.includes(trimmedLines(label5))]).toEqual([false, false]);
		expect(textOf(out?.[10])).toBe('<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_5 (echo "\n\n\nx") ──\nfive\n── Job bg_6 (printf plain) ──\nsix\n</system-notice>');
		expect(out?.[13]).toBe(sent[13]!);
		expect(out?.[16]?.content).toEqual([
			{
				type: "text",
				text: `<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_8 (${LONG.slice(0, 117)}...) ──\neight\n── Job bg_9 (printf nine) ──\nnine\n</system-notice>`,
			},
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		expect(out?.[16]?.details).toEqual(sent[16]!.details);
		expect(mutated).toBe(false);
	});

	test("R5 a job id reused after a restart maps each batch to its own start", async () => {
		const { d, env } = shortProfile();
		const s = host(env, d);
		await s.turn([{ id: "k1", input: { command: "echo first" }, ...started("bg_1") }]);
		s.record(batch(BATCH_E1, [job("bg_1", `${P}'echo first'`), job("bg_2", "printf other")], s.now()));
		await s.turn([{ id: "k2", input: { command: "echo second" }, ...started("bg_1") }]);
		s.record(batch(BATCH_E2, [job("bg_1", `${P}'echo second'`), job("bg_2", "printf other")], s.now()));
		const out = (await s.context()).returned?.messages;
		expect([textOf(out?.[2]), textOf(out?.[5])]).toEqual([
			"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 (echo first) ──\nfirst\n── Job bg_2 (printf other) ──\nother\n</system-notice>",
			"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 (echo second) ──\nsecond\n── Job bg_2 (printf other) ──\nother\n</system-notice>",
		]);
	});

	test("R5 a header not located unambiguously is left as recorded: job output holding another job's header stays byte-identical, and a label holding `) ──` the format pass altered leaves no orphan", async () => {
		const { d, env } = shortProfile();
		const s = host(env, d);
		const start = async (id: string, command: string, jobId: string) => String((await s.turn([{ id, input: { command }, ...started(jobId) }])).args[0]!.command);
		expect(await start("j10", "cat build.log", "bg_10")).toBe(`${P}'cat build.log'`);
		expect(await start("j11", "echo eleven", "bg_11")).toBe(`${P}'echo eleven'`);
		s.record(batch(BATCH_G, [job("bg_10", `${P}'cat build.log'`), job("bg_11", `${P}'echo eleven'`)], s.now()));
		const label12 = `${P}'echo "\n\n\n) ──\nx"'`;
		expect(await start("j12", 'echo "\n\n\n) ──\nx"', "bg_12")).toBe(label12);
		expect(await start("j13", "echo thirteen", "bg_13")).toBe(`${P}'echo thirteen'`);
		s.record(batch(BATCH_H, [job("bg_12", label12), job("bg_13", `${P}'echo thirteen'`)], s.now()));
		expect([BATCH_H.includes(label12), BATCH_H.includes(trimmedLines(label12))]).toEqual([false, false]);

		const { sent, returned, mutated } = await s.context();
		const out = returned?.messages;
		// bg_10's header is bg_10's only one; bg_11's text occurs three times, so its header and bg_10's output stay as recorded.
		const output = BATCH_G.slice(BATCH_G.indexOf("\nLOG: "));
		expect(textOf(out?.[4])).toBe(`<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_10 (cat build.log) ──${output}`);
		expect(output.split(`── Job bg_11 (${P}'echo eleven') ──`)).toHaveLength(4);
		// bg_12's header is left whole; bg_13's is re-rendered.
		expect(textOf(out?.[9])).toBe(
			"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_12 ('/usr/bin/sandbox-exec' -p '(version 1)(allow default)(deny file-write* (subpath \"/\"))' /bin/bash -c 'echo \"\n) ──\nx\"') ──\ntwelve\n── Job bg_13 (echo thirteen) ──\nthirteen\n</system-notice>",
		);
		expect(textOf(sent[9])).toBe(BATCH_H);
		expect(mutated).toBe(false);
	});

	test("R5 a label the format pass altered beyond trimEnd (a compacted `|` row) is located through the span fallback", async () => {
		const { d, env } = shortProfile();
		const s = host(env, d);
		const label = `${P}'echo "\n| a  |  b |\n"'`;
		expect(String((await s.turn([{ id: "j14", input: { command: 'echo "\n| a  |  b |\n"' }, ...started("bg_14") }])).args[0]!.command)).toBe(label);
		s.record(batch(BATCH_T, [job("bg_14", label), job("bg_15", "printf plain")], s.now()));
		// Neither exact form is in the text, and the label holds no `) ──`: only the fallback can find the header.
		expect([BATCH_T.includes(label), BATCH_T.includes(trimmedLines(label)), label.includes(") ──")]).toEqual([false, false, false]);
		const out = (await s.context()).returned?.messages;
		expect(textOf(out?.[2])).toBe('<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_14 (echo "\n| a  |  b |\n") ──\nfourteen\n── Job bg_15 (printf plain) ──\nfifteen\n</system-notice>');
	});

	test("R6 a history with nothing to unwrap gets undefined, and so does a host without getBranch", async () => {
		const d = tmp("unwrap-r6");
		const off = host({ HOME: d, PATH: process.env.PATH }, d, { settings: { enabled: false, autoBackground: true } });
		off.record({ role: "user", content: "check the tree", timestamp: off.now() });
		const { args } = await off.turn([{ id: "n1", input: { command: "git status" } }]);
		expect(args[0]).toEqual({ command: "git status" });
		expect((await off.context()).returned).toBeUndefined();

		const on = host({ HOME: d, PATH: process.env.PATH }, d);
		await on.turn([{ id: "n2", input: { command: "git status" } }]);
		const noBranch = { ...on.ctx, sessionManager: { getHeader: () => null, getEntries: () => on.branch } };
		expect((await on.context(noBranch as typeof on.ctx)).returned).toBeUndefined();
	});

	test("R6b an empty branch on first use gets undefined; a second context call on an unchanged branch reuses the decision, and an append is decided anew", async () => {
		const d = tmp("unwrap-r6b");
		const s = host({ HOME: d, PATH: process.env.PATH }, d);
		await s.turn([{ id: "m1", input: { command: "git status" } }]);
		const empty = { ...s.ctx, sessionManager: { getHeader: () => null, getEntries: () => [], getBranch: () => [] } };
		expect((await s.context(empty as typeof s.ctx)).returned).toBeUndefined();

		// A manager of its own (a fresh decision) over the same branch, counting how often the branch is walked.
		let walks = 0;
		const counting = {
			...s.ctx,
			sessionManager: {
				getHeader: () => null,
				getEntries: () => s.branch,
				getBranch: () => {
					const b = [...s.branch];
					return Object.assign(b, {
						[Symbol.iterator]() {
							walks++;
							return Array.prototype[Symbol.iterator].call(b);
						},
					});
				},
			},
		};
		const first = (await s.context(counting)).returned?.messages;
		expect([commandOf(first, 0), walks]).toEqual(["git status", 1]);
		const again = (await s.context(counting)).returned?.messages;
		expect([again, walks]).toEqual([first, 1]);
		await s.turn([{ id: "m2", input: { command: "echo next" } }]);
		const after = (await s.context(counting)).returned?.messages;
		expect([commandOf(after, 0), commandOf(after, 2), walks]).toEqual(["git status", "echo next", 2]);
	});

	// PLAN wl-mv5o5xkyebs7i8 § 2-3: OMP 18.8.6's snapcompact archives `preparation.messagesToSummarize`
	// then `turnPrefixMessages` from the persisted messages without running the `context` hook. The
	// event (host().compact) carries the session's own message objects and the branch being compacted.
	describe("session_before_compact unwrap", () => {
		/** Each message's role and timestamp, in order. */
		const stamps = (messages: Msg[]) => messages.map((m) => [m.role, m.timestamp]);

		test("R1 the archived messagesToSummarize show a fenced call as typed; the message objects keep the wrapper; the other fields, order, count and timestamps are unchanged", async () => {
			const d = tmp("compact-r1");
			const s = host({ HOME: d, PATH: process.env.PATH }, d);
			s.record({ role: "user", content: "check the tree", timestamp: s.now() });
			const { args } = await s.turn([{ id: "k1", input: { command: "git status", cwd: d, timeout: 30 } }]);
			const wrapper = String(args[0]!.command);
			expect(copiedWrapper(wrapper)?.command).toBe("git status");
			s.record({ role: "user", content: "and now?", timestamp: s.now() });
			const { preparation, given, snapshot, results } = await s.compact(3);

			expect(commandOf(preparation.messagesToSummarize, 1)).toBe("git status");
			expect(preparation.messagesToSummarize[1]!.content).toEqual([{ type: "toolCall", id: "k1", name: "bash", arguments: { command: "git status", cwd: args[0]!.cwd, timeout: 30 } }]);
			// The session's own objects are untouched: they still hold the wrapper.
			expect(given.messagesToSummarize[1]).toBe(s.messages[1]!);
			expect(commandOf(s.messages, 1)).toBe(wrapper);
			expect(Bun.deepEquals(s.messages, snapshot, true)).toBe(true);
			// Only the changed message is a new object; order, count and timestamps are kept.
			expect(preparation.messagesToSummarize).toHaveLength(3);
			expect(stamps(preparation.messagesToSummarize)).toEqual(stamps(given.messagesToSummarize));
			expect(preparation.messagesToSummarize[0]).toBe(given.messagesToSummarize[0]!);
			expect(preparation.messagesToSummarize[2]).toBe(given.messagesToSummarize[2]!);
			// Every other preparation field is the one OMP handed over.
			expect({ ...preparation, messagesToSummarize: given.messagesToSummarize }).toEqual(given);
			expect(preparation.recentMessages).toBe(given.recentMessages);
			expect(preparation.turnPrefixMessages).toBe(given.turnPrefixMessages);
			expect([preparation.firstKeptEntryId, preparation.tokensBefore, preparation.previousSummary]).toEqual([String(s.branch.at(-1)!.id), 4321, "an earlier summary"]);
			// No cancel, no compaction of its own.
			expect(results.every((r) => r === undefined)).toBe(true);
		});

		test("R2 chronological: a job started in messagesToSummarize and completed in a multi-job async-result in turnPrefixMessages gets the typed command in its header; each array keeps its length", async () => {
			const { d, env } = shortProfile();
			const s = host(env, d);
			const start = async (id: string, command: string, jobId: string) => String((await s.turn([{ id, input: { command }, ...started(jobId) }])).args[0]!.command);
			expect(await start("a1", "sleep 1; echo one", "bg_1")).toBe(`${P}'sleep 1; echo one'`);
			expect(await start("a2", "echo two", "bg_2")).toBe(`${P}'echo two'`);
			s.record(batch(BATCH_A, [job("bg_1", `${P}'sleep 1; echo one'`), job("bg_2", `${P}'echo two'`)], s.now()));
			s.record({ role: "assistant", timestamp: s.now(), content: [{ type: "text", text: "both done" }] });
			const { preparation, given, snapshot } = await s.compact(4, 1);

			expect([preparation.messagesToSummarize.length, preparation.turnPrefixMessages.length]).toEqual([4, 1]);
			expect(textOf(preparation.turnPrefixMessages[0])).toBe(
				"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 (sleep 1; echo one) ──\none\n── Job bg_2 (echo two) ──\ntwo\n</system-notice>",
			);
			expect([commandOf(preparation.messagesToSummarize, 0), commandOf(preparation.messagesToSummarize, 2)]).toEqual(["sleep 1; echo one", "echo two"]);
			expect(preparation.turnPrefixMessages[0]!.details).toEqual(given.turnPrefixMessages[0]!.details);
			expect(stamps([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages])).toEqual(stamps([...given.messagesToSummarize, ...given.turnPrefixMessages]));
			expect(textOf(s.messages[4])).toBe(BATCH_A);
			expect(Bun.deepEquals(s.messages, snapshot, true)).toBe(true);
			expect(preparation.recentMessages).toBe(given.recentMessages);
		});

		test("R2 a fenced call that sits only in turnPrefixMessages is unwrapped there; messagesToSummarize keeps its identity", async () => {
			const d = tmp("compact-r2b");
			const s = host({ HOME: d, PATH: process.env.PATH }, d);
			s.record({ role: "user", content: "hello", timestamp: s.now() });
			s.record({ role: "assistant", timestamp: s.now(), content: [{ type: "text", text: "hi" }] });
			s.record({ role: "user", content: "show the last commit", timestamp: s.now() });
			const { args } = await s.turn([{ id: "p1", input: { command: "git log -1" } }]);
			s.record({ role: "assistant", timestamp: s.now(), content: [{ type: "text", text: "there it is" }] });
			const { preparation, given, snapshot } = await s.compact(2, 3);

			expect(preparation.messagesToSummarize).toBe(given.messagesToSummarize);
			expect(preparation.turnPrefixMessages).toHaveLength(3);
			expect(commandOf(preparation.turnPrefixMessages, 1)).toBe("git log -1");
			expect(preparation.turnPrefixMessages[0]).toBe(given.turnPrefixMessages[0]!);
			expect(preparation.turnPrefixMessages[2]).toBe(given.turnPrefixMessages[2]!);
			expect(stamps(preparation.turnPrefixMessages)).toEqual(stamps(given.turnPrefixMessages));
			expect(commandOf(s.messages, 3)).toBe(String(args[0]!.command));
			expect(Bun.deepEquals(s.messages, snapshot, true)).toBe(true);
		});

		test("R3 a typed copy of the wrapper (no revision entry) in the archived range stays wrapped", async () => {
			const d = tmp("compact-r3");
			const s = host({ HOME: d, PATH: process.env.PATH }, d);
			const wrapper = String((await s.turn([{ id: "t1", input: { command: "git status" } }])).args[0]!.command);
			const copy = await s.turn([{ id: "t2", input: { command: wrapper } }]);
			expect(copy.outcomes[0]).toEqual({ block: true, reason: copiedWrapperReason("git status") });
			expect(s.f.entries.filter((e) => e.type === REVISION)).toEqual([{ type: REVISION, data: { toolCallId: "t1", sha256: sha(wrapper) } }]);
			s.record({ role: "user", content: "and now?", timestamp: s.now() });
			const { preparation, given } = await s.compact(2, 2);

			expect(commandOf(preparation.turnPrefixMessages, 0)).toBe(wrapper);
			expect(preparation.turnPrefixMessages).toBe(given.turnPrefixMessages);
			expect(commandOf(s.messages, 2)).toBe(wrapper);
		});

		test("R4 with nothing to change both arrays keep their identity: the fence off, and a fenced call only in the kept messages", async () => {
			const d = tmp("compact-r4");
			const off = host({ HOME: d, PATH: process.env.PATH }, d, { settings: { enabled: false, autoBackground: true } });
			off.record({ role: "user", content: "check the tree", timestamp: off.now() });
			await off.turn([{ id: "n1", input: { command: "git status" } }]);
			off.record({ role: "user", content: "and now?", timestamp: off.now() });
			const a = await off.compact(1, 2);
			expect(a.preparation.messagesToSummarize).toBe(a.given.messagesToSummarize);
			expect(a.preparation.turnPrefixMessages).toBe(a.given.turnPrefixMessages);
			expect(a.results.every((r) => r === undefined)).toBe(true);

			const on = host({ HOME: d, PATH: process.env.PATH }, d);
			on.record({ role: "user", content: "hello", timestamp: on.now() });
			on.record({ role: "assistant", timestamp: on.now(), content: [{ type: "text", text: "hi" }] });
			await on.turn([{ id: "n2", input: { command: "git status" } }]);
			expect(on.f.entries.map((e) => e.type)).toEqual([REVISION]);
			const b = await on.compact(1, 1);
			expect(b.preparation.messagesToSummarize).toBe(b.given.messagesToSummarize);
			expect(b.preparation.turnPrefixMessages).toBe(b.given.turnPrefixMessages);
			expect(Bun.deepEquals(on.messages, b.snapshot, true)).toBe(true);
		});
	});
});
