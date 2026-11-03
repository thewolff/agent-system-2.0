// The merge train's resolver (workload wl-mv8s8srodefytc, PLAN § 3 and § 4 sl-mt-resolve). Each test
// builds a temp git repo whose main holds a MIGRATION.md fixture in the real shape (an M7 section with
// indented multi-line item blocks, numbered lines outside it), an install manifest and one item file;
// a branch `pr` (the PR head) and main then diverge, `git merge --no-ff main` runs on `pr`, and the
// real script `bun <repo root>/surface/scripts/merge-train.ts` is spawned in the repo. Assertions are
// on exit codes, the files and the index; "untouched" compares status, the index stages and every file
// the resolver could write, before and after.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEGACY_CEILING, parseItem } from "../src/migration-items";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "surface", "scripts", "merge-train.ts");
const T = 60_000;

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const STATUS_118 = "     **Status:** open.";
const STATUS_117 = "     **Status (2026-10-01):** building.";
const BASE_MIGRATION = [
	"# MIGRATION fixture",
	"",
	"## Steps",
	"",
	"1. **A step, not an item.** Outside the M7 section.",
	"Status: steps open.",
	"",
	"## M7 follow-ups — found by running 2.0 on itself (opened 2026-09-30)",
	"",
	"Intro line.",
	"",
	"116. **Item one sixteen.** Prose of 116.",
	"117. **Item one seventeen.** Prose of 117.",
	STATUS_117,
	"     - sub bullet",
	"       - nested bullet",
	"118. **Item one eighteen.** Prose of 118.",
	STATUS_118,
	"",
	"## What is deliberately not a step",
	"",
	"999. **Not an item.** Outside the M7 section.",
	"",
].join("\n");
const BASE_MANIFEST = "# manifest fixture\nREADME.md\tdoc\t-\nsurface/src/a.ts\tmodule\t-\n";
const EXISTING_ITEM = "---\ntitle: Existing item\nstatus: open\nworkload: none\npr: none\n---\nBody.\n";
const MAIN_ITEM = ["119. **Main's new item.** Main prose, PR #50."];
const PR_ITEM = ["119. **PR item title.** PR pending text."];
const PR_ITEM_FILE = "migration/items/pr-item-title.md";
/** A real-shape multi-line item: a status line, nested bullets and a paragraph after a blank line. */
const MULTI_BLOCK = [
	"119. **Multi-line PR item.** First line, PR pending.",
	"     **Status (2026-10-14):** building on branch `wl/wl-abc123`, PR pending.",
	"     - bullet one",
	"       - nested bullet",
	"",
	"     Paragraph after a blank line.",
];
const MULTI_FILE = "migration/items/multi-line-pr-item.md";
const MULTI_TEXT = [
	"---",
	"title: Multi-line PR item",
	"status: building",
	"workload: wl-abc123",
	"pr: 12",
	"---",
	"First line, PR #12.",
	"**Status (2026-10-14):** building on branch `wl/wl-abc123`, PR #12.",
	"- bullet one",
	"  - nested bullet",
	"",
	"Paragraph after a blank line.",
	"",
].join("\n");

/** `text` with `lines` inserted after the line equal to `anchor`. */
function insertAfter(text: string, anchor: string, lines: string[]): string {
	const all = text.split("\n");
	const i = all.indexOf(anchor);
	if (i === -1) throw new Error(`fixture: no line ${anchor}`);
	all.splice(i + 1, 0, ...lines);
	return all.join("\n");
}

function replaceLine(text: string, from: string, to: string): string {
	if (!text.split("\n").includes(from)) throw new Error(`fixture: no line ${from}`);
	return text
		.split("\n")
		.map((l) => (l === from ? to : l))
		.join("\n");
}

interface World {
	repo: string;
	env: Record<string, string>;
}

interface Run {
	code: number;
	out: string;
	err: string;
}

function spawn(w: World, cmd: string[]): Run {
	const r = Bun.spawnSync(cmd, { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** git that must succeed; its stdout. */
function g(w: World, ...args: string[]): string {
	const r = spawn(w, ["git", ...args]);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} exited ${r.code}: ${r.err}`);
	return r.out;
}

function cli(w: World, ...args: string[]): Run {
	return spawn(w, ["bun", CLI, ...args]);
}

function read(w: World, path: string): string {
	return readFileSync(join(w.repo, path), "utf8");
}

function writeFiles(w: World, files: Record<string, string>): void {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(w.repo, path)), { recursive: true });
		writeFileSync(join(w.repo, path), text);
	}
}

/** A repo whose main holds the fixtures, `migration` replacing BASE_MIGRATION when given. */
function world(migration = BASE_MIGRATION): World {
	const root = mkdtempSync(join(tmpdir(), "surface-merge-train-resolve-"));
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
	const w: World = { repo: join(root, "repo"), env };
	mkdirSync(w.repo);
	g(w, "init", "-q", "-b", "main");
	writeFiles(w, {
		"MIGRATION.md": migration,
		"install/manifest.tsv": BASE_MANIFEST,
		"migration/items/existing-item.md": EXISTING_ITEM,
		"src.txt": "base\n",
		"README.md": "fixture\n",
	});
	g(w, "add", "-A");
	g(w, "commit", "-q", "-m", "base");
	return w;
}

/** Branch `pr` off main with `pr`'s files, main with `main`'s; then `git merge --no-ff main` on `pr`. Its exit code. */
function diverge(w: World, pr: Record<string, string>, main: Record<string, string>): number {
	g(w, "checkout", "-q", "-b", "pr");
	writeFiles(w, pr);
	g(w, "add", "-A");
	g(w, "commit", "-q", "-m", "pr side");
	g(w, "checkout", "-q", "main");
	writeFiles(w, main);
	g(w, "add", "-A");
	g(w, "commit", "-q", "-m", "main side");
	g(w, "checkout", "-q", "pr");
	return spawn(w, ["git", "merge", "--no-ff", "-q", "-m", "merge main", "main"]).code;
}

function unmerged(w: World): string[] {
	return [...new Set(g(w, "ls-files", "-u").split("\n").filter(Boolean).map((l) => l.split("\t")[1]!))].sort();
}

/** Everything the resolver could change: status, index stages, the files it may write. */
function snapshot(w: World): Record<string, string> {
	const out: Record<string, string> = {
		status: g(w, "status", "--porcelain=v1", "-uall"),
		index: g(w, "ls-files", "-s"),
		items: readdirSync(join(w.repo, "migration/items")).sort().join(","),
	};
	for (const path of ["MIGRATION.md", "install/manifest.tsv", "src.txt"]) out[path] = read(w, path);
	return out;
}

function itemText(title: string, workload: string, pr: number, body: string): string {
	return `---\ntitle: ${title}\nstatus: building\nworkload: ${workload}\npr: ${pr}\n---\n${body}\n`;
}

describe("merge-train resolve", () => {
	test(
		"an item-only MIGRATION.md conflict gives an item file, keeps main's lines and exits 0",
		() => {
			const w = world();
			const main = insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM);
			expect(diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM) }, { "MIGRATION.md": main })).not.toBe(0);
			expect(unmerged(w)).toEqual(["MIGRATION.md"]);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
			expect(r.out.split("\n").filter(Boolean)).toEqual(["MIGRATION.md", PR_ITEM_FILE]);
			expect(read(w, "MIGRATION.md")).toBe(main);
			const item = read(w, PR_ITEM_FILE);
			expect(item).toBe(itemText("PR item title", "wl-abc123", 7, "PR #7 text."));
			expect(parseItem(item).header).toEqual({ title: "PR item title", status: "building", workload: "wl-abc123", pr: "7", number: null });
			expect(unmerged(w)).toEqual([]);
			expect(g(w, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort()).toEqual(["MIGRATION.md", PR_ITEM_FILE]);
			g(w, "commit", "-q", "--no-edit");
			expect(g(w, "status", "--porcelain")).toBe("");
			const c = cli(w, "check", "--base", "main");
			expect(c.code).toBe(0);
			expect(c.out).toContain("check: ok");
		},
		T,
	);

	test(
		"a PR that adds an item and edits a non-conflicting status line keeps both",
		() => {
			const w = world();
			const edit = (t: string) => replaceLine(replaceLine(t, STATUS_117, "     **Status (2026-10-14):** done by the PR."), "Status: steps open.", "Status: steps closed by the PR.");
			const main = insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM);
			expect(diverge(w, { "MIGRATION.md": edit(insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM)) }, { "MIGRATION.md": main })).not.toBe(0);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
			expect(read(w, "MIGRATION.md")).toBe(edit(main));
			expect(read(w, PR_ITEM_FILE)).toBe(itemText("PR item title", "wl-abc123", 7, "PR #7 text."));
		},
		T,
	);

	test(
		"a PR status edit on the line next to main's new item (indented multi-line block) is kept or exits 4, never dropped",
		() => {
			const w = world();
			const prEdit = "     **Status:** done (PR edit).";
			const main = insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM);
			const pr = insertAfter(replaceLine(BASE_MIGRATION, STATUS_118, prEdit), prEdit, PR_ITEM);
			expect(diverge(w, { "MIGRATION.md": pr }, { "MIGRATION.md": main })).not.toBe(0);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect([0, 4]).toContain(r.code);
			if (r.code === 0) {
				expect(read(w, "MIGRATION.md")).toBe(insertAfter(replaceLine(BASE_MIGRATION, STATUS_118, prEdit), prEdit, MAIN_ITEM));
			} else {
				expect(r.err).toContain("MIGRATION.md: both sides changed");
				expect(r.err).toContain("done (PR edit)");
				expect(snapshot(w)).toEqual(before);
			}
		},
		T,
	);

	test(
		"a PR status edit colliding with main's exits 4 with the tree untouched",
		() => {
			const w = world();
			const pr = replaceLine(insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM), STATUS_117, "     **Status:** done by the PR.");
			const main = replaceLine(insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM), STATUS_117, "     **Status:** superseded on main.");
			expect(diverge(w, { "MIGRATION.md": pr }, { "MIGRATION.md": main })).not.toBe(0);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(4);
			expect(r.out).toBe("");
			expect(r.err).toContain("nothing written");
			expect(r.err).toContain("MIGRATION.md: both sides changed");
			expect(r.err).toContain("done by the PR");
			expect(r.err).toContain("superseded on main");
			expect(snapshot(w)).toEqual(before);
			expect(existsSync(join(w.repo, PR_ITEM_FILE))).toBe(false);
		},
		T,
	);

	test(
		"a conflict in another file exits 3 with the tree untouched",
		() => {
			const w = world();
			const pr = { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM), "src.txt": "pr\n" };
			const main = { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM), "src.txt": "main\n" };
			expect(diverge(w, pr, main)).not.toBe(0);
			expect(unmerged(w)).toEqual(["MIGRATION.md", "src.txt"]);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(3);
			expect(r.out).toBe("");
			expect(r.err).toContain("  src.txt");
			expect(r.err).not.toContain("  MIGRATION.md");
			expect(snapshot(w)).toEqual(before);
		},
		T,
	);

	test(
		"a multi-line item block is converted whole",
		() => {
			const w = world();
			const main = insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM);
			expect(diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, MULTI_BLOCK) }, { "MIGRATION.md": main })).not.toBe(0);
			const r = cli(w, "resolve", "--pr", "12", "--workload", "wl-abc123");
			expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
			expect(r.out.split("\n").filter(Boolean)).toEqual(["MIGRATION.md", MULTI_FILE]);
			expect(read(w, "MIGRATION.md")).toBe(main);
			expect(read(w, MULTI_FILE)).toBe(MULTI_TEXT);
		},
		T,
	);

	test(
		"install/manifest.tsv add/add takes main's rows, then the PR's rows not already present",
		() => {
			const w = world();
			const shared = "surface/src/shared.ts\tmodule\t-";
			const prRow = "surface/src/pr.ts\tmodule\t-";
			const mainRow = "surface/src/main.ts\tmodule\t-";
			const pr = { "install/manifest.tsv": `${BASE_MANIFEST}${shared}\n${prRow}\n`, "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM) };
			const main = { "install/manifest.tsv": `${BASE_MANIFEST}${mainRow}\n${shared}\n`, "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM) };
			expect(diverge(w, pr, main)).not.toBe(0);
			expect(unmerged(w)).toEqual(["MIGRATION.md", "install/manifest.tsv"]);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
			expect(r.out.split("\n").filter(Boolean)).toEqual(["MIGRATION.md", PR_ITEM_FILE, "install/manifest.tsv"]);
			expect(read(w, "install/manifest.tsv")).toBe(`${BASE_MANIFEST}${mainRow}\n${shared}\n${prRow}\n`);
			expect(unmerged(w)).toEqual([]);
		},
		T,
	);

	test(
		"install/manifest.tsv edited on both sides exits 4 with the tree untouched",
		() => {
			const w = world();
			const pr = { "install/manifest.tsv": BASE_MANIFEST.replace("README.md\tdoc\t-", "README.md\tdoc\tpr") };
			const main = { "install/manifest.tsv": BASE_MANIFEST.replace("README.md\tdoc\t-", "README.md\tdoc\tmain") };
			expect(diverge(w, pr, main)).not.toBe(0);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(4);
			expect(r.err).toContain("install/manifest.tsv: both sides changed");
			expect(snapshot(w)).toEqual(before);
		},
		T,
	);

	test(
		"migration/items add/add with different text exits 4",
		() => {
			const w = world();
			const path = "migration/items/twice.md";
			expect(diverge(w, { [path]: EXISTING_ITEM.replace("Body.", "PR body.") }, { [path]: EXISTING_ITEM.replace("Body.", "Main body.") })).not.toBe(0);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(4);
			expect(r.err).toContain(`${path}: added on both sides with different text`);
			expect(snapshot(w)).toEqual(before);
		},
		T,
	);

	test(
		"a slug that exists on main exits 4 with the tree untouched",
		() => {
			const w = world();
			const main = { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM), [PR_ITEM_FILE]: EXISTING_ITEM };
			expect(diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM) }, main)).not.toBe(0);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(4);
			expect(r.err).toContain(`${PR_ITEM_FILE}: item 119's slug already exists on MERGE_HEAD`);
			expect(snapshot(w)).toEqual(before);
		},
		T,
	);

	test(
		"two new blocks giving one slug exit 4 with the tree untouched",
		() => {
			const w = world();
			const pr = insertAfter(BASE_MIGRATION, STATUS_118, ["119. **Same title.** One.", "120. **Same title!** Two."]);
			expect(diverge(w, { "MIGRATION.md": pr }, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM) })).not.toBe(0);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(4);
			expect(r.err).toContain("migration/items/same-title.md: items 119 and 120 give the same slug");
			expect(snapshot(w)).toEqual(before);
		},
		T,
	);

	test(
		"--workload none writes `workload: none`, which parseItem accepts",
		() => {
			const w = world();
			expect(
				diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM) }, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM) }),
			).not.toBe(0);
			const r = cli(w, "resolve", "--pr", "88", "--workload", "none");
			expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
			const item = read(w, PR_ITEM_FILE);
			expect(item).toBe(itemText("PR item title", "none", 88, "PR #88 text."));
			expect(parseItem(item).header?.workload).toBe("none");
		},
		T,
	);

	test(
		"a git merge-file process failure is reported apart from conflicts (exit 2), tree untouched",
		() => {
			// A NUL byte makes git treat MIGRATION.md as binary: `git merge` leaves the stages, and
			// `git merge-file` refuses binary input with its error status, not a conflict count.
			const binary = replaceLine(BASE_MIGRATION, "Intro line.", "Intro line.\u0000");
			const w = world(binary);
			expect(diverge(w, { "MIGRATION.md": insertAfter(binary, STATUS_118, PR_ITEM) }, { "MIGRATION.md": insertAfter(binary, STATUS_118, MAIN_ITEM) })).not.toBe(0);
			expect(unmerged(w)).toEqual(["MIGRATION.md"]);
			const before = snapshot(w);
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(2);
			expect(r.err).toContain("MIGRATION.md: git merge-file failed (exit 255), a process failure, not a conflict count");
			expect(r.err).not.toContain("both sides changed");
			expect(snapshot(w)).toEqual(before);
		},
		T,
	);

	test(
		"a failed git add (index.lock held) exits 2 with tree and index untouched; a retry after the lock goes resolves",
		() => {
			const w = world();
			const main = insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM);
			expect(diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM) }, { "MIGRATION.md": main })).not.toBe(0);
			const state = () => ({
				status: g(w, "status", "--porcelain=v2", "-uall"),
				unmerged: g(w, "ls-files", "-u"),
				bytes: ["MIGRATION.md", "install/manifest.tsv", "src.txt"].map((p) => readFileSync(join(w.repo, p))),
				items: readdirSync(join(w.repo, "migration/items")).sort(),
			});
			const before = state();
			expect(before.unmerged).not.toBe("");
			const lock = join(w.repo, ".git", "index.lock");
			writeFileSync(lock, "");
			const r = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect(r.code).toBe(2);
			expect(r.err).toContain("git add -- MIGRATION.md migration/items/pr-item-title.md failed");
			expect(state()).toEqual(before);
			expect(existsSync(join(w.repo, PR_ITEM_FILE))).toBe(false);
			rmSync(lock);
			const again = cli(w, "resolve", "--pr", "7", "--workload", "wl-abc123");
			expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: "" });
			expect(read(w, "MIGRATION.md")).toBe(main);
			expect(read(w, PR_ITEM_FILE)).toBe(itemText("PR item title", "wl-abc123", 7, "PR #7 text."));
			expect(unmerged(w)).toEqual([]);
		},
		T,
	);
});

describe("merge-train convert and check", () => {
	test(
		"convert with no merge in progress moves a new item to its file; check fails before and passes after",
		() => {
			const w = world();
			const block = ["119. **Converted item.** PR pending.", "     **Status:** building.", "     - one bullet"];
			// main moves on elsewhere, so the base is the merge base rather than main's tip.
			expect(diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, block) }, { "README.md": "fixture, moved on\n" })).toBe(0);
			let c = cli(w, "check", "--base", "main");
			expect(c.code).toBe(4);
			expect(c.err).toContain("MIGRATION.md:19: item 119");
			const r = cli(w, "convert", "--pr", "9", "--workload", "wl-abc123", "--base", "main");
			expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
			expect(r.out.split("\n").filter(Boolean)).toEqual(["MIGRATION.md", "migration/items/converted-item.md"]);
			expect(read(w, "MIGRATION.md")).toBe(BASE_MIGRATION);
			expect(read(w, "migration/items/converted-item.md")).toBe(itemText("Converted item", "wl-abc123", 9, "PR #9.\n**Status:** building.\n- one bullet"));
			g(w, "add", "-A");
			g(w, "commit", "-q", "-m", "migration: #9's item to migration/items/converted-item.md");
			c = cli(w, "check", "--base", "main");
			expect(c.code).toBe(0);
			expect(c.out).toContain("check: ok");
			const again = cli(w, "convert", "--pr", "9", "--workload", "wl-abc123", "--base", "main");
			expect(again).toEqual({ code: 0, out: "", err: "convert: nothing to do\n" });
			expect(g(w, "status", "--porcelain")).toBe("");
		},
		T,
	);

	test(
		"a PR item git merged cleanly beside main's item of the same number: check catches it, convert moves it whole",
		() => {
			const w = world();
			const main = insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM);
			// A blank line before the PR's block lets git place the two insertions apart: no conflict.
			expect(diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, ["", ...MULTI_BLOCK]) }, { "MIGRATION.md": main })).toBe(0);
			const c = cli(w, "check", "--base", "main");
			expect(c.code).toBe(4);
			expect(c.err).toContain("item 119");
			const r = cli(w, "convert", "--pr", "12", "--workload", "wl-abc123", "--base", "main");
			expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
			expect(r.out.split("\n").filter(Boolean)).toEqual(["MIGRATION.md", MULTI_FILE]);
			expect(read(w, "MIGRATION.md")).toBe(main);
			expect(read(w, MULTI_FILE)).toBe(MULTI_TEXT);
			g(w, "add", "-A");
			g(w, "commit", "-q", "-m", "migration: #12's item to migration/items/multi-line-pr-item.md");
			expect(cli(w, "check", "--base", "main").code).toBe(0);
		},
		T,
	);

	test(
		"convert refuses while a merge is in progress",
		() => {
			const w = world();
			expect(
				diverge(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, PR_ITEM) }, { "MIGRATION.md": insertAfter(BASE_MIGRATION, STATUS_118, MAIN_ITEM) }),
			).not.toBe(0);
			const before = snapshot(w);
			const r = cli(w, "convert", "--pr", "7", "--workload", "wl-abc123", "--base", "main");
			expect(r.code).toBe(2);
			expect(r.err).toContain("a merge is in progress");
			expect(snapshot(w)).toEqual(before);
		},
		T,
	);

	test(
		"check catches a new number at or below the legacy ceiling; a numbered line outside M7 is not an item",
		() => {
			const w = world();
			expect(115).toBeLessThanOrEqual(LEGACY_CEILING);
			const pr = insertAfter(insertAfter(BASE_MIGRATION, "Intro line.", ["", "115. **A gap number.** Below the ceiling."]), "Status: steps open.", ["2. **Another step.** Not an item."]);
			expect(diverge(w, { "MIGRATION.md": pr }, { "README.md": "moved\n" })).toBe(0);
			const c = cli(w, "check", "--base", "main");
			expect(c.code).toBe(4);
			expect(c.err).toContain("item 115");
			expect(c.err).not.toContain("item 2");
			g(w, "checkout", "-q", "-b", "steps-only", "main");
			writeFiles(w, { "MIGRATION.md": insertAfter(BASE_MIGRATION, "Status: steps open.", ["2. **Another step.** Not an item."]) });
			g(w, "commit", "-q", "-am", "a numbered step");
			expect(cli(w, "check", "--base", "main").code).toBe(0);
		},
		T,
	);
});

describe("merge-train usage", () => {
	test(
		"usage errors and resolve with no merge in progress exit 2",
		() => {
			const w = world();
			for (const args of [
				[],
				["bogus"],
				["resolve", "--workload", "wl-abc123"],
				["resolve", "--pr", "x", "--workload", "wl-abc123"],
				["resolve", "--pr", "7", "--workload", "Plumb"],
				["convert", "--pr", "7", "--workload", "none"],
				["check", "--base"],
				["check", "--base", "no-such-ref"],
				["resolve", "--pr", "7", "--workload", "none"],
			]) {
				const r = cli(w, ...args);
				expect({ args, code: r.code }).toEqual({ args, code: 2 });
			}
			expect(cli(w, "resolve", "--pr", "7", "--workload", "none").err).toContain("no merge in progress");
		},
		T,
	);
});
