// The fast check's test set and its exceptions (PLAN wl-mvq4edbaf13vnk § 2 "The fast check", D2; R1, R2): pure rules over
// an in-memory tree, plus the one check over this repository: every tracked dependency manifest or lockfile is covered by
// the profile's testRunner.fullBeforeMerge.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FastConfig, FastSetError, fastSet, fullExceptions, KNOWN_MANIFESTS, parseCheck, resolveRelative, testReach, uncoveredManifests } from "../src/fast-set";
import { FULL_BEFORE_MERGE_DEFAULT, testRunnerConfig } from "../src/test-run";

const REPO = join(import.meta.dir, "..", "..");

/** A tree at X: path → source. `read` answers null for a path the tree does not hold. */
function treeOf(files: Record<string, string>): { tree: string[]; read: (p: string) => string | null } {
	return { tree: Object.keys(files), read: (p) => (Object.hasOwn(files, p) ? files[p]! : null) };
}
const CFG: FastConfig = { fastSmoke: [], macOnly: {}, fullBeforeMerge: [...FULL_BEFORE_MERGE_DEFAULT] };
const SCHEMA_INDEX_SRC = (v: number, tail = "") => `import { join } from "node:path";\nexport const SCHEMA_VERSION = ${v};\nexport const X = 1;${tail}\n`;

/** A small repository: a chain of importers, a test that spawns a script by path, one that reads a fixture by basename, unrelated tests. */
const BASE: Record<string, string> = {
	"src/a.ts": "export const a = 1;\n",
	"src/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
	"src/c.ts": 'export { b } from "./b.js";\n',
	"src/index.ts": 'export * from "./c";\n',
	"lib/use.ts": 'import { b } from "../src";\nexport const u = b;\n',
	"src/b.test.ts": 'import { b } from "./b";\n',
	"test/c.test.ts": 'import { b } from "../src/c.ts";\n',
	"test/lib.test.ts": 'import { u } from "../lib/use";\n',
	"test/spawn.test.ts": 'Bun.spawnSync(["bun", "scripts/run.ts"]);\n',
	"test/fixture.test.ts": 'const t = await Bun.file(join(dir, "data.json")).text();\n',
	"test/names-importer.test.ts": 'const p = "lib/use.ts";\n',
	"test/other.test.ts": 'import { o } from "../other/o";\n',
	"other/o.ts": "export const o = 0;\n",
	"scripts/run.ts": 'console.log("run");\n',
	"fixtures/data.json": "{}\n",
	"ledger/src/index.ts": SCHEMA_INDEX_SRC(5),
	"ledger/schema.sql": "CREATE TABLE t (x);\n",
	"README.md": "# r\n",
};
const at = (over: Record<string, string | null> = {}) => {
	const files = { ...BASE };
	for (const [k, v] of Object.entries(over)) {
		if (v === null) delete files[k];
		else files[k] = v;
	}
	return treeOf(files);
};
const base = treeOf(BASE);

describe("the fast set (R1)", () => {
	test("tests in C, importing C, or importing a transitive importer of C; nothing unrelated", () => {
		const x = at();
		const plan = fastSet(["src/a.ts"], x.tree, x.read, base.read, CFG);
		// a → b (src/b.test.ts imports it) → c (test/c.test.ts) → index → lib/use (test/lib.test.ts), and a test naming lib/use.ts
		expect(plan).toEqual({ kind: "fast", files: ["src/b.test.ts", "test/c.test.ts", "test/lib.test.ts", "test/names-importer.test.ts"], macOnly: [], parse: ["src/a.ts"] });
		// a change to a test file itself holds that test
		expect(fastSet(["test/other.test.ts"], x.tree, x.read, base.read, CFG)).toMatchObject({ files: ["test/other.test.ts"] });
		// a change nothing reaches holds no test
		expect(fastSet(["README.md"], x.tree, x.read, base.read, CFG)).toEqual({ kind: "fast", files: [], macOnly: [], parse: [] });
	});

	test("a test that names a changed file by repo-relative path or by basename is held (spawned scripts, fixtures)", () => {
		const x = at();
		expect(testReach(x.tree, x.read)(["scripts/run.ts"])).toEqual(["test/spawn.test.ts"]);
		expect(testReach(x.tree, x.read)(["fixtures/data.json"])).toEqual(["test/fixture.test.ts"]);
		// a deleted file stays in C, so a test that still names it is held
		const gone = at({ "scripts/run.ts": null });
		expect(testReach(gone.tree, gone.read)(["scripts/run.ts"])).toEqual(["test/spawn.test.ts"]);
	});

	test("an import that resolves to no file of the tree widens to every test file of the importer's directory", () => {
		const x = at({ "other/o.ts": 'import { g } from "./gen/missing";\nexport const o = g;\n', "other/o.test.ts": "test('o', () => {});\n", "other/p_spec.js": "" });
		// nothing in C touches other/, yet its tests are held, since what other/o.ts imports cannot be known
		expect(testReach(x.tree, x.read)(["README.md"])).toEqual(["other/o.test.ts", "other/p_spec.js"]);
		// an import leaving the tree is unresolved too
		const out = at({ "src/a.ts": 'import x from "../../outside";\n' });
		expect(testReach(out.tree, out.read)(["README.md"])).toEqual(["src/b.test.ts"]);
		// packages and builtins are not tree files and never widen
		const pkg = at({ "src/a.ts": 'import { z } from "zod";\nimport { join } from "node:path";\nimport { test } from "bun:test";\n' });
		expect(testReach(pkg.tree, pkg.read)(["README.md"])).toEqual([]);
	});

	test("a module that does not scan is widened like an unresolved import, and a changed one fails its parse check", () => {
		const x = at({ "src/a.ts": "export const = ;\n" });
		const plan = fastSet(["src/a.ts"], x.tree, x.read, base.read, CFG);
		expect(plan.kind === "fast" && plan.files).toContain("src/b.test.ts");
		expect(plan.kind === "fast" && plan.parse).toEqual(["src/a.ts"]);
		const errors = parseCheck(["src/a.ts", "src/b.ts"], x.read);
		expect(errors.map((e) => e.path)).toEqual(["src/a.ts"]);
		expect(errors[0]!.error).toMatch(/^1:\d+: /);
	});

	test("parse targets: changed .ts, .tsx and .js files present at X; deleted and other files are not parsed", () => {
		const x = at({ "ui/v.tsx": "export const V = () => <div/>;\n", "ui/w.js": "export const w = 1;\n", "ui/m.mjs": "export {}\n", "src/b.ts": null });
		const plan = fastSet(["ui/v.tsx", "ui/w.js", "ui/m.mjs", "src/b.ts", "README.md"], x.tree, x.read, base.read, CFG);
		expect(plan.kind === "fast" && plan.parse).toEqual(["ui/v.tsx", "ui/w.js"]);
		// a .tsx file is read as TSX, so JSX transpiles
		expect(parseCheck(["ui/v.tsx", "ui/w.js"], x.read)).toEqual([]);
		expect(parseCheck(["ui/gone.ts"], x.read)).toEqual([{ path: "ui/gone.ts", error: "not in the tree at the head" }]);
	});

	test("smoke files are always held; macOnly files leave the Linux set for main runs, reached or smoke", () => {
		const x = at();
		const cfg: FastConfig = { ...CFG, fastSmoke: ["test/other.test.ts", "test/c.test.ts"], macOnly: { "test/lib.test.ts": "sandbox-exec is macOS only", "test/other.test.ts": "launchd" } };
		expect(fastSet(["src/a.ts"], x.tree, x.read, base.read, cfg)).toEqual({
			kind: "fast", files: ["src/b.test.ts", "test/c.test.ts", "test/names-importer.test.ts"], macOnly: ["test/lib.test.ts", "test/other.test.ts"], parse: ["src/a.ts"],
		});
		// a smoke file the tree does not hold is a config error, never dropped
		expect(() => fastSet(["src/a.ts"], x.tree, x.read, base.read, { ...CFG, fastSmoke: ["test/gone.test.ts"] })).toThrow(FastSetError);
		expect(() => fastSet(["src/a.ts"], x.tree, x.read, base.read, { ...CFG, fastSmoke: ["test/gone.test.ts"] })).toThrow("test/gone.test.ts");
	});

	test("relative specifiers resolve as Bun does: exact, by extension, a .js specifier to its .ts file, a directory's index", () => {
		const files = new Set(["s/a.ts", "s/b.tsx", "s/c.mts", "s/d/index.ts", "s/e.js", "s/f.json"]);
		const has = (p: string) => files.has(p);
		expect(resolveRelative("s/x.ts", "./a", has)).toBe("s/a.ts");
		expect(resolveRelative("s/x.ts", "./a.js", has)).toBe("s/a.ts");
		expect(resolveRelative("s/x.ts", "./b.js", has)).toBe("s/b.tsx");
		expect(resolveRelative("s/x.ts", "./c.mjs", has)).toBe("s/c.mts");
		expect(resolveRelative("s/x.ts", "./d", has)).toBe("s/d/index.ts");
		expect(resolveRelative("s/x.ts", "./e.js", has)).toBe("s/e.js");
		expect(resolveRelative("s/x.ts", "./f.json", has)).toBe("s/f.json");
		expect(resolveRelative("s/q/x.ts", "../a?raw", has)).toBe("s/a.ts");
		expect(resolveRelative("s/x.ts", "./nope", has)).toBeNull();
		expect(resolveRelative("s/x.ts", "../../a", has)).toBeNull();
		expect(resolveRelative("x.ts", "./s/a", has)).toBe("s/a.ts");
	});
});

describe("exceptions: the full suite before merge (R2)", () => {
	test("a schema migration or a fullBeforeMerge basename anywhere in the tree takes the full suite, naming every reason", () => {
		const x = at({ "ledger/src/index.ts": SCHEMA_INDEX_SRC(6) });
		expect(fastSet(["ledger/schema.sql"], x.tree, x.read, base.read, CFG)).toEqual({ kind: "full", reasons: ["schema migration: ledger/schema.sql changed"] });
		expect(fastSet(["ledger/src/index.ts"], x.tree, x.read, base.read, CFG)).toEqual({ kind: "full", reasons: ["schema migration: the SCHEMA_VERSION line of ledger/src/index.ts changed"] });
		expect(fastSet(["surface/package.json"], x.tree, x.read, base.read, CFG)).toEqual({ kind: "full", reasons: ["dependencies or toolchain: surface/package.json changed (testRunner.fullBeforeMerge)"] });
		expect(fullExceptions(["ledger/schema.sql", "ledger/src/index.ts", "Cargo.lock", "build.sh"], x.read, base.read, CFG)).toEqual([
			"schema migration: ledger/schema.sql changed",
			"schema migration: the SCHEMA_VERSION line of ledger/src/index.ts changed",
			"dependencies or toolchain: Cargo.lock, build.sh changed (testRunner.fullBeforeMerge)",
		]);
	});

	test("no other path takes the full suite: another line of the schema index, runner or merge code, a name that only resembles a manifest", () => {
		const x = at({ "ledger/src/index.ts": SCHEMA_INDEX_SRC(5, "\nexport const Y = 2;") });
		for (const changed of [["ledger/src/index.ts"], ["surface/scripts/test-runner.ts"], ["surface/src/merge-train.ts"], ["docs/package.json.md"], ["ledger/schema.sql.bak"], ["src/a.ts"]]) {
			expect(fastSet(changed, x.tree, x.read, base.read, CFG).kind).toBe("fast");
		}
		// the basename list is the config's, not a fixed one
		expect(fastSet(["go.mod"], x.tree, x.read, base.read, CFG).kind).toBe("fast");
		expect(fastSet(["go.mod"], x.tree, x.read, base.read, { ...CFG, fullBeforeMerge: ["go.mod"] }).kind).toBe("full");
		// a schema index added or removed changes its SCHEMA_VERSION line
		const gone = at({ "ledger/src/index.ts": null });
		expect(fullExceptions(["ledger/src/index.ts"], gone.read, base.read, CFG)).toEqual(["schema migration: the SCHEMA_VERSION line of ledger/src/index.ts changed"]);
	});

	test("manifest coverage: a tracked manifest or lockfile whose basename fullBeforeMerge leaves out is named", () => {
		expect(KNOWN_MANIFESTS).toContain("go.mod");
		expect(uncoveredManifests(["a/package.json", "go.mod", "x/go.sum", "src/a.ts", "README.md"], ["package.json"])).toEqual(["go.mod", "x/go.sum"]);
		expect(uncoveredManifests(["a/package.json", "go.mod"], ["package.json", "go.mod"])).toEqual([]);
	});

	test("this repository: every tracked dependency manifest or lockfile is covered by the profile's testRunner.fullBeforeMerge", () => {
		const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO });
		if (ls.exitCode !== 0) throw new Error(`git ls-files in ${REPO} exited ${ls.exitCode}: ${ls.stderr.toString()}`);
		const tracked = ls.stdout.toString().split("\0").filter((p) => p !== "");
		expect(tracked.length).toBeGreaterThan(0);
		const c = testRunnerConfig(Bun.YAML.parse(readFileSync(join(REPO, "profile", "config.yml"), "utf8")));
		if (!c.ok) throw new Error(`profile/config.yml testRunner: ${c.error}`);
		expect(uncoveredManifests(tracked, c.config.fullBeforeMerge)).toEqual([]);
	});
});
