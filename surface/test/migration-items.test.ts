// Migration items one file each, numbered at merge (workload wl-mv5mvvs64ahq0w, PLAN § 7 slice 1,
// tests (a) to (i), and (d2), (f2), (i2) from code review round 1). Regression tests that import
// nothing from the change: each builds temp git repos (a bare origin, a developer clone that merges
// item branches `--no-ff` and pushes main, and a bot clone that runs the tool; (i) and (i2) add the
// full-suite runner's bundle clone) around a MIGRATION.md fixture, spawns
// `bun <repo root>/surface/scripts/migration-items.ts` by path, and asserts exit codes, files, origin
// refs and commit subjects. The first number a file gets is the legacy ceiling + 1; the tests read the
// ceiling off `check`'s output (`legacy ceiling N`) rather than hardcoding it. The fixture's legacy
// items run to 114 (54 twice), below any ceiling the tool may carry.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../ledger/test/tmp";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "surface", "scripts", "migration-items.ts");
const BOT_EMAIL = "as2-numbering@users.noreply.github.com";
const ITEMS = "migration/items";
const LEGACY_MAX = 114;
const T = 60_000;

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fixtureMigration(): string {
	const legacy: string[] = [];
	for (let n = 1; n <= LEGACY_MAX; n++) {
		if (n >= 60 && n <= 64) continue;
		legacy.push(`${n}. **Legacy item ${n}.** Prose of item ${n}.`);
		if (n === 54) legacy.push("54. **Legacy item 54, the second one.** The old form already doubled it.");
	}
	return [
		"# MIGRATION fixture",
		"",
		"## Steps",
		"",
		"1. **A step, not an item.** Outside the M7 section.",
		"",
		"## Migration items, one file each",
		"",
		"New items are files under migration/items/, numbered by the migration-number action.",
		"",
		"<!-- migration-items:index:start -->",
		"| # | item |",
		"|---|---|",
		"<!-- migration-items:index:end -->",
		"",
		"## M7 follow-ups — found by running 2.0 on itself (opened 2026-09-30)",
		"",
		...legacy,
		"",
		"## What is deliberately not a step",
		"",
		"999. **Not an item either.** Outside the M7 section.",
		"",
	].join("\n");
}

function itemText(slug: string, extra = ""): string {
	return `---\ntitle: Item ${slug}\nstatus: open\nworkload: none\npr: none\n${extra}---\nBody of ${slug}.\n`;
}

interface World {
	root: string;
	origin: string;
	dev: string;
	bot: string;
	env: Record<string, string>;
	first: number;
	ceiling: number;
}

interface Run {
	code: number;
	out: string;
	err: string;
}

function spawn(w: World, cmd: string[], cwd: string, env?: Record<string, string>): Run {
	const r = Bun.spawnSync(cmd, { cwd, env: { ...w.env, ...env }, stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** git that must succeed; its stdout. */
function g(w: World, cwd: string, ...args: string[]): string {
	const r = spawn(w, ["git", ...args], cwd);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${r.code}: ${r.err}`);
	return r.out;
}

function cli(w: World, cwd: string, args: string[], env?: Record<string, string>): Run {
	return spawn(w, ["bun", CLI, ...args], cwd, env);
}

/** A bare origin whose main holds the fixture, a developer clone and a bot clone. */
function world(): World {
	const root = tmpDir("surface-migration-items-");
	roots.push(root);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
	writeFileSync(join(root, "gitconfig"), "[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n");
	Object.assign(env, {
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "dev",
		GIT_AUTHOR_EMAIL: "dev@example.invalid",
		GIT_COMMITTER_NAME: "dev",
		GIT_COMMITTER_EMAIL: "dev@example.invalid",
	});
	const w: World = { root, origin: join(root, "origin.git"), dev: join(root, "dev"), bot: join(root, "bot"), env, first: 0, ceiling: 0 };
	g(w, root, "init", "-q", "--bare", "-b", "main", w.origin);
	g(w, root, "clone", "-q", w.origin, w.dev);
	writeFileSync(join(w.dev, "MIGRATION.md"), fixtureMigration());
	writeFileSync(join(w.dev, "README.md"), "fixture\n");
	g(w, w.dev, "add", "-A");
	g(w, w.dev, "commit", "-q", "-m", "base");
	g(w, w.dev, "push", "-q", "origin", "main");
	g(w, root, "clone", "-q", w.origin, w.bot);
	const c = cli(w, w.bot, ["check"]);
	expect(c.code).toBe(0);
	const m = /legacy ceiling (\d+)/.exec(c.out);
	expect(m).not.toBeNull();
	w.ceiling = Number(m![1]);
	expect(w.ceiling).toBeGreaterThanOrEqual(LEGACY_MAX);
	w.first = w.ceiling + 1;
	return w;
}

/** A dev branch `item-<slug>` off `from` adding one item file. */
function itemBranch(w: World, slug: string, from = "main", text = itemText(slug), branch = `item-${slug}`): string {
	g(w, w.dev, "checkout", "-q", "-b", branch, from);
	mkdirSync(join(w.dev, ITEMS), { recursive: true });
	writeFileSync(join(w.dev, ITEMS, `${slug}.md`), text);
	g(w, w.dev, "add", "-A");
	g(w, w.dev, "commit", "-q", "-m", `add ${slug}`);
	g(w, w.dev, "checkout", "-q", "main");
	return branch;
}

/** Bring dev's main up to origin's, merge the branch `--no-ff`, push main; the merge's sha. */
function mergeAndPush(w: World, branch: string): string {
	g(w, w.dev, "checkout", "-q", "main");
	g(w, w.dev, "pull", "-q", "--ff-only", "origin", "main");
	g(w, w.dev, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch);
	g(w, w.dev, "push", "-q", "origin", "main");
	return g(w, w.dev, "rev-parse", "HEAD").trim();
}

const originMain = (w: World): string => g(w, w.origin, "rev-parse", "main").trim();
const originFile = (w: World, path: string): string => g(w, w.origin, "show", `main:${path}`);

function originNumber(w: World, slug: string): number | null {
	const m = /^number: (\d+)$/m.exec(originFile(w, `${ITEMS}/${slug}.md`));
	return m ? Number(m[1]) : null;
}

/** The index rows on origin main, as `<N> <slug>`. */
function originIndex(w: World): string[] {
	const text = originFile(w, "MIGRATION.md");
	const block = text.slice(text.indexOf("<!-- migration-items:index:start -->"), text.indexOf("<!-- migration-items:index:end -->"));
	return [...block.matchAll(/^\| (\d+) \| \[[^\]]*\]\(migration\/items\/([a-z0-9-]+)\.md\) \|$/gm)].map((m) => `${m[1]} ${m[2]}`);
}

const subjects = (w: World): string[] => g(w, w.origin, "log", "--first-parent", "--format=%s", "main").trim().split("\n");

function expectOk(r: Run): void {
	if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}`);
}

/** On dev's checked-out branch: number the item by hand, add its index row, commit as as2-numbering with a numbering subject. */
function forgeNumbering(w: World, slug: string, n: number): void {
	writeFileSync(join(w.dev, ITEMS, `${slug}.md`), itemText(slug, `number: ${n}\n`));
	const mig = readFileSync(join(w.dev, "MIGRATION.md"), "utf8");
	writeFileSync(join(w.dev, "MIGRATION.md"), mig.replace("<!-- migration-items:index:end -->", `| ${n} | [Item ${slug}](migration/items/${slug}.md) |\n<!-- migration-items:index:end -->`));
	g(w, w.dev, "add", "-A");
	spawn(w, ["git", "commit", "-q", "-m", `migration: number ${n} ${slug}`], w.dev, { GIT_AUTHOR_NAME: "as2-numbering", GIT_AUTHOR_EMAIL: BOT_EMAIL });
	expect(g(w, w.dev, "log", "-1", "--format=%ae|%s").trim()).toBe(`${BOT_EMAIL}|migration: number ${n} ${slug}`);
}

/**
 * The full-suite runner's checkout of `sha`, built the way it builds one (surface/scripts/test-runner.ts
 * trusted()): the PR head pushed to origin as refs/pull/1/head, a trusted clone of origin that fetches
 * it and main, detaches at the sha, removes origin, writes the tested-commit branch and (when
 * `trustedMain` is given) the tag as2-trusted-main by update-ref, and bundles `--all`; then
 * test-exec.ts prepare()'s clone of the bundle, detached at the sha, origin removed.
 */
function runnerClone(w: World, name: string, sha: string, trustedMain: string | null): string {
	g(w, w.dev, "push", "-q", "origin", `+${sha}:refs/pull/1/head`);
	const stage = join(w.root, `${name}-stage`);
	g(w, w.root, "clone", "-q", "--no-checkout", w.origin, stage);
	g(w, stage, "fetch", "-q", "origin", "+refs/pull/1/head:refs/remotes/origin/pr/1", "+refs/heads/main:refs/remotes/origin/main");
	g(w, stage, "checkout", "-q", "--detach", sha);
	g(w, stage, "remote", "remove", "origin");
	g(w, stage, "update-ref", "refs/heads/as2-tested-pr-1", sha);
	if (trustedMain) g(w, stage, "update-ref", "refs/tags/as2-trusted-main", trustedMain);
	const bundle = join(w.root, `${name}.bundle`);
	g(w, stage, "bundle", "create", "-q", bundle, "--all");
	const runner = join(w.root, name);
	g(w, w.root, "clone", "-q", "--no-checkout", bundle, runner);
	g(w, runner, "checkout", "-q", "--detach", sha);
	g(w, runner, "remote", "remove", "origin");
	expect(g(w, runner, "rev-parse", "HEAD").trim()).toBe(sha);
	// No main ref survives: the tested-commit branch and, when written, the tag are all there is.
	const refs = [`refs/heads/as2-tested-pr-1 ${sha}`, ...(trustedMain ? [`refs/tags/as2-trusted-main ${trustedMain}`] : [])];
	expect(g(w, runner, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n")).toEqual(refs);
	return runner;
}

/** A PR branch `item-q` cut before item a merged, a numbered on origin main, then origin/main merged into the PR; the PR head's sha. */
function prOverNumberedMain(w: World): string {
	const pr = itemBranch(w, "q");
	mergeAndPush(w, itemBranch(w, "a"));
	expectOk(cli(w, w.bot, ["publish"]));
	g(w, w.dev, "fetch", "-q", "origin");
	g(w, w.dev, "checkout", "-q", pr);
	g(w, w.dev, "merge", "-q", "--no-ff", "-m", "Merge origin/main into the PR", "origin/main");
	return g(w, w.dev, "rev-parse", "HEAD").trim();
}

/** On dev: bring main up to origin's, revert an item's `--no-ff` merge (deleting the numbered file), push main. */
function revertItemMerge(w: World, merge: string, slug: string): void {
	g(w, w.dev, "checkout", "-q", "main");
	g(w, w.dev, "pull", "-q", "--ff-only", "origin", "main");
	spawn(w, ["git", "revert", "--no-commit", "-m", "1", merge], w.dev); // modify/delete conflict on the item file
	g(w, w.dev, "rm", "-q", "-f", `${ITEMS}/${slug}.md`);
	g(w, w.dev, "commit", "-q", "-m", `Revert item ${slug}`);
	g(w, w.dev, "push", "-q", "origin", "main");
}

describe("migration-items numbering", () => {
	test.each([["a", "b"], ["b", "a"]])("(a) two item branches merged --no-ff in order %s then %s get consecutive numbers in merge order", (x, y) => {
		const w = world();
		const bx = itemBranch(w, x);
		const by = itemBranch(w, y);
		mergeAndPush(w, bx);
		expectOk(cli(w, w.bot, ["publish"]));
		expect(originNumber(w, x)).toBe(w.first);
		mergeAndPush(w, by); // merges onto main that now holds the numbering commit: no conflict
		expectOk(cli(w, w.bot, ["publish"]));
		expect(originNumber(w, x)).toBe(w.first);
		expect(originNumber(w, y)).toBe(w.first + 1);
		expect(subjects(w).slice(0, 4)).toEqual([`migration: number ${w.first + 1} ${y}`, `Merge ${by}`, `migration: number ${w.first} ${x}`, `Merge ${bx}`]);
		expect(g(w, w.origin, "log", "-1", "--format=%an <%ae>|%cn <%ce>", "main").trim()).toBe(`as2-numbering <${BOT_EMAIL}>|as2-numbering <${BOT_EMAIL}>`);
		expect(originIndex(w)).toEqual([`${w.first} ${x}`, `${w.first + 1} ${y}`]);
		expect(originFile(w, "MIGRATION.md")).toContain(`| ${w.first} | [Item ${x}](migration/items/${x}.md) |`);
		expectOk(cli(w, w.bot, ["check", "--merged"]));
	}, T);

	test("(b) race: a push refused because main moved is retried from the fresh main, numbers stay distinct", () => {
		const w = world();
		const ba = itemBranch(w, "a");
		const bb = itemBranch(w, "b");
		mergeAndPush(w, ba);
		// Merge B is ready in the dev clone but not pushed; the bot's pre-push hook pushes it the first time it fires.
		g(w, w.dev, "checkout", "-q", "-b", "pending-b", "main");
		g(w, w.dev, "merge", "-q", "--no-ff", "-m", `Merge ${bb}`, bb);
		g(w, w.dev, "checkout", "-q", "main");
		const hooks = join(w.root, "hooks");
		mkdirSync(hooks);
		const marker = join(hooks, "fired");
		writeFileSync(
			join(hooks, "pre-push"),
			[
				"#!/bin/sh",
				`if [ ! -e "${marker}" ]; then`,
				`  : > "${marker}"`,
				`  env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C "${w.dev}" push -q origin pending-b:main >> "${hooks}/hook.log" 2>&1 || exit 1`,
				"fi",
				"cat > /dev/null",
				"exit 0",
				"",
			].join("\n"),
		);
		chmodSync(join(hooks, "pre-push"), 0o755);
		const r = cli(w, w.bot, ["publish"], { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks });
		expectOk(r);
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(join(hooks, "hook.log"), "utf8")).toBe("");
		const log = `${r.out}${r.err}`;
		expect(log.match(/^publish: push refused/gm)?.length).toBe(1);
		expect(log).toMatch(/^publish: retrying/m);
		const na = originNumber(w, "a");
		const nb = originNumber(w, "b");
		expect(na).not.toBeNull();
		expect(nb).not.toBeNull();
		expect(na).not.toBe(nb);
		expect([na, nb].sort()).toEqual([w.first, w.first + 1]);
		expect(originIndex(w)).toEqual([`${na} a`, `${nb} b`].sort());
		expect(subjects(w)[0]).toBe(`migration: number ${w.first} a, ${w.first + 1} b`);
		expectOk(cli(w, w.bot, ["check", "--merged"]));
	}, T);

	test("(c) a branch adding an item file leaves MIGRATION.md byte-identical and passes check", () => {
		const w = world();
		const b = itemBranch(w, "c");
		g(w, w.dev, "checkout", "-q", b);
		expect(g(w, w.dev, "show", "HEAD:MIGRATION.md")).toBe(g(w, w.dev, "show", "origin/main:MIGRATION.md"));
		// From a subdirectory with no --repo: the repo is the git toplevel of the cwd.
		expectOk(cli(w, join(w.dev, ITEMS), ["check"]));
	}, T);

	test("(d) check fails on a hand-written number, a shared number, a legacy item above the ceiling, an index row with no file", () => {
		const w = world();
		mergeAndPush(w, itemBranch(w, "a"));
		expectOk(cli(w, w.bot, ["publish"]));
		g(w, w.dev, "pull", "-q", "--ff-only", "origin", "main");
		expectOk(cli(w, w.dev, ["check"]));

		const hand = itemBranch(w, "h", "main", itemText("h", `number: ${w.first + 5}\n`));
		g(w, w.dev, "checkout", "-q", hand);
		let r = cli(w, w.dev, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`${ITEMS}/h.md: number ${w.first + 5} was never published on main`);
		g(w, w.dev, "checkout", "-q", "main");

		// A numbering commit for b under a's number, on a main-like ref given as --base.
		g(w, w.dev, "checkout", "-q", "-b", "forged-main", "main");
		writeFileSync(join(w.dev, ITEMS, "b.md"), itemText("b", `number: ${w.first}\n`));
		const mig = readFileSync(join(w.dev, "MIGRATION.md"), "utf8");
		writeFileSync(join(w.dev, "MIGRATION.md"), mig.replace("<!-- migration-items:index:end -->", `| ${w.first} | [Item b](migration/items/b.md) |\n<!-- migration-items:index:end -->`));
		g(w, w.dev, "add", "-A");
		spawn(w, ["git", "commit", "-q", "-m", `migration: number ${w.first} b`], w.dev, { GIT_AUTHOR_NAME: "as2-numbering", GIT_AUTHOR_EMAIL: BOT_EMAIL });
		r = cli(w, w.dev, ["check", "--base", "forged-main"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`number ${w.first} is held by more than one thing: item a, item b`);
		g(w, w.dev, "checkout", "-q", "main");

		g(w, w.dev, "checkout", "-q", "-b", "legacy-late", "main");
		const text = readFileSync(join(w.dev, "MIGRATION.md"), "utf8");
		writeFileSync(join(w.dev, "MIGRATION.md"), text.replace(`${LEGACY_MAX}. **Legacy item ${LEGACY_MAX}.** Prose of item ${LEGACY_MAX}.`, `$&\n${w.ceiling + 1}. **Too late.** Old form after the cut-over.`));
		r = cli(w, w.dev, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`legacy item ${w.ceiling + 1} is above LEGACY_CEILING ${w.ceiling}`);
		g(w, w.dev, "checkout", "-q", "--", "MIGRATION.md");
		g(w, w.dev, "checkout", "-q", "main");

		g(w, w.dev, "checkout", "-q", "-b", "ghost-row", "main");
		writeFileSync(join(w.dev, "MIGRATION.md"), text.replace("<!-- migration-items:index:end -->", `| ${w.first + 9} | [Ghost](migration/items/ghost.md) |\n<!-- migration-items:index:end -->`));
		r = cli(w, w.dev, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`row ${w.first + 9} ghost has no numbered file`);
		g(w, w.dev, "checkout", "-q", "--", "MIGRATION.md");
		g(w, w.dev, "checkout", "-q", "main");
		expectOk(cli(w, w.dev, ["check"]));
	}, T);

	test("(d2) check fails when a valid index row appears twice, whatever the second row's title", () => {
		const w = world();
		mergeAndPush(w, itemBranch(w, "a"));
		expectOk(cli(w, w.bot, ["publish"]));
		g(w, w.dev, "pull", "-q", "--ff-only", "origin", "main");
		g(w, w.dev, "checkout", "-q", "-b", "dup-row", "main");
		const text = readFileSync(join(w.dev, "MIGRATION.md"), "utf8");
		const row = `| ${w.first} | [Item a](migration/items/a.md) |`;
		expect(text).toContain(row);
		writeFileSync(join(w.dev, "MIGRATION.md"), text.replace(row, `${row}\n| ${w.first} | [Another title](migration/items/a.md) |`));
		const r = cli(w, w.dev, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`MIGRATION.md index: row ${w.first} a appears 2 times`);
		expect(r.err).toContain("check: 1 problem");
	}, T);

	test("(h) a PR branch carrying its own as2-numbering commit and a matching number fails check", () => {
		const w = world();
		g(w, w.dev, "checkout", "-q", itemBranch(w, "p"));
		forgeNumbering(w, "p", w.first);
		const r = cli(w, w.dev, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`${ITEMS}/p.md: number ${w.first} was never published on main`);
		expect(r.err).not.toContain("HEAD history");
	}, T);

	test("(i) the runner's clone with only the as2-trusted-main tag: an item numbered on main passes, a forged numbering commit on the PR branch fails", () => {
		const w = world();
		const head = prOverNumberedMain(w);
		const main = originMain(w);
		let runner = runnerClone(w, "runner-ok", head, main);
		expect(g(w, runner, "show", `HEAD:${ITEMS}/a.md`)).toContain(`number: ${w.first}\n`);
		let r = cli(w, runner, ["check"]);
		expectOk(r);
		expect(r.out).toContain("base refs/tags/as2-trusted-main");
		expect(r.err).not.toContain("HEAD history");

		forgeNumbering(w, "q", w.first + 1);
		runner = runnerClone(w, "runner-forged", g(w, w.dev, "rev-parse", "HEAD").trim(), main);
		r = cli(w, runner, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`${ITEMS}/q.md: number ${w.first + 1} was never published on main`);
	}, T);

	test("(i2) with no base at all: an unnumbered-only tree passes; a numbered file or an index row exits 1 naming the refs", () => {
		const w = world();
		const head = prOverNumberedMain(w);
		const noBase = "check: no base: none of refs/remotes/origin/main, refs/heads/main, refs/tags/as2-trusted-main resolves";
		const needsTag = "the full-suite runner must tag as2-trusted-main";

		// The PR's own commit, before origin/main was merged in: only the unnumbered q.md, an empty index.
		const plain = runnerClone(w, "runner-plain", g(w, w.dev, "rev-parse", `${head}^1`).trim(), null);
		expect(g(w, plain, "ls-tree", "--name-only", "HEAD", `${ITEMS}/`).trim()).toBe(`${ITEMS}/q.md`);
		let r = cli(w, plain, ["check"]);
		expectOk(r);
		expect(r.out).toContain("base none:");

		// The same tree with an index row and no numbered file.
		const mig = readFileSync(join(plain, "MIGRATION.md"), "utf8");
		writeFileSync(join(plain, "MIGRATION.md"), mig.replace("<!-- migration-items:index:end -->", `| ${w.first} | [Item q](migration/items/q.md) |\n<!-- migration-items:index:end -->`));
		r = cli(w, plain, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(noBase);
		expect(r.err).toContain("the tree holds 0 numbered item files and 1 index row");
		expect(r.err).toContain(needsTag);
		expect(r.out).not.toContain("check: ok");
		g(w, plain, "checkout", "-q", "--", "MIGRATION.md");

		// The same tree plus a.md, numbered by a genuine numbering commit on main, and its index row.
		const numbered = runnerClone(w, "runner-numbered", head, null);
		expect(g(w, numbered, "show", `HEAD:${ITEMS}/a.md`)).toContain(`number: ${w.first}\n`);
		expect(g(w, numbered, "log", "--format=%ae|%s", "HEAD")).toContain(`${BOT_EMAIL}|migration: number ${w.first} a`);
		r = cli(w, numbered, ["check"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(noBase);
		expect(r.err).toContain("the tree holds 1 numbered item file and 1 index row");
		expect(r.err).toContain(needsTag);
		expect(r.out).not.toContain("check: ok");

		r = cli(w, plain, ["check", "--merged"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("check --merged: no base: none of refs/remotes/origin/main, refs/heads/main, refs/tags/as2-trusted-main resolves");
		expect(cli(w, plain, ["number"]).code).toBe(1);

		expect(g(w, plain, "status", "--porcelain")).toBe("");
		expect(g(w, numbered, "status", "--porcelain")).toBe("");
	}, T);

	test("(e) a malformed header makes number exit 1 and write nothing; publish pushes nothing", () => {
		const w = world();
		mergeAndPush(w, itemBranch(w, "bad", "main", itemText("bad").replace("status: open", "status: maybe")));
		const before = originMain(w);
		g(w, w.bot, "fetch", "-q", "origin");
		g(w, w.bot, "checkout", "-q", "--detach", "origin/main");
		const head = g(w, w.bot, "rev-parse", "HEAD").trim();
		const r = cli(w, w.bot, ["number"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`${ITEMS}/bad.md: status \`maybe\``);
		expect(g(w, w.bot, "rev-parse", "HEAD").trim()).toBe(head);
		expect(g(w, w.bot, "status", "--porcelain")).toBe("");
		expect(cli(w, w.bot, ["publish"]).code).toBe(1);
		expect(originMain(w)).toBe(before);
	}, T);

	test("(e2) a second publish with nothing new is a no-op", () => {
		const w = world();
		mergeAndPush(w, itemBranch(w, "a"));
		expectOk(cli(w, w.bot, ["publish"]));
		const after = originMain(w);
		const r = cli(w, w.bot, ["publish"]);
		expectOk(r);
		expect(r.out).toContain("publish: nothing to push");
		expect(originMain(w)).toBe(after);
	}, T);

	test("(f, g) a reverted item's number is never reused, and re-adding its slug restores it", () => {
		const w = world();
		const mergeA = mergeAndPush(w, itemBranch(w, "a"));
		expectOk(cli(w, w.bot, ["publish"]));
		expect(originNumber(w, "a")).toBe(w.first);

		// (f) revert A's merge on main (the numbered file is deleted), then merge C.
		revertItemMerge(w, mergeA, "a");
		mergeAndPush(w, itemBranch(w, "c"));
		expectOk(cli(w, w.bot, ["publish"]));
		expect(originNumber(w, "c")).toBe(w.first + 1);
		expect(originIndex(w)).toEqual([`${w.first + 1} c`]);

		// (g) re-add a with its original, unnumbered text.
		g(w, w.dev, "pull", "-q", "--ff-only", "origin", "main");
		mergeAndPush(w, itemBranch(w, "a", "main", itemText("a"), "readd-a"));
		expectOk(cli(w, w.bot, ["publish"]));
		expect(originNumber(w, "a")).toBe(w.first);
		expect(originNumber(w, "c")).toBe(w.first + 1);
		expect(subjects(w)[0]).toBe(`migration: number ${w.first} a`);
		expect(originIndex(w)).toEqual([`${w.first} a`, `${w.first + 1} c`]);
		expectOk(cli(w, w.bot, ["check", "--merged"]));
	}, T);

	test("(f2) publish right after a revert commits `migration: index` alone; the reverted number is not released", () => {
		const w = world();
		const mergeA = mergeAndPush(w, itemBranch(w, "a"));
		expectOk(cli(w, w.bot, ["publish"]));
		expect(originIndex(w)).toEqual([`${w.first} a`]);

		revertItemMerge(w, mergeA, "a");
		const reverted = originMain(w);
		expectOk(cli(w, w.bot, ["publish"]));
		expect(subjects(w)[0]).toBe("migration: index");
		expect(g(w, w.origin, "rev-parse", "main^").trim()).toBe(reverted);
		expect(g(w, w.origin, "diff", "--name-only", reverted, "main").trim()).toBe("MIGRATION.md");
		expect(originIndex(w)).toEqual([]);
		expectOk(cli(w, w.bot, ["check", "--merged"]));

		g(w, w.dev, "pull", "-q", "--ff-only", "origin", "main");
		mergeAndPush(w, itemBranch(w, "c"));
		expectOk(cli(w, w.bot, ["publish"]));
		expect(originNumber(w, "c")).toBe(w.first + 1);
		expect(subjects(w)[0]).toBe(`migration: number ${w.first + 1} c`);
		expect(originIndex(w)).toEqual([`${w.first + 1} c`]);
	}, T);
});
