// as2-hosted's file sets. `bun .github/as2-hosted/sets.ts linux|macos` prints one `./<path>` per line:
//   linux: every Bun test file in the tree, minus testRunner.macOnly and testRunner.mainSkip (profile/config.yml);
//   macos: testRunner.macOnly.
// mainSkip's files need Jo's installed OMP and skip every test anywhere else, so they run only in the local runner.
// Fails loudly when either list names a file that is not in the tree, or a file is in both, so a stale list cannot
// silently drop or double-run a file.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const which = process.argv[2];
if (which !== "linux" && which !== "macos") {
	console.error("usage: bun .github/as2-hosted/sets.ts linux|macos");
	process.exit(2);
}

const mapping = (doc: unknown, key: string): string[] => {
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`profile/config.yml: testRunner.${key} is not a mapping of path to reason`);
	return Object.keys(doc);
};
const config = Bun.YAML.parse(readFileSync(join(root, "profile", "config.yml"), "utf8")) as { testRunner?: { macOnly?: unknown; mainSkip?: unknown } };
const macOnly = mapping(config.testRunner?.macOnly ?? {}, "macOnly");
const joOnly = mapping(config.testRunner?.mainSkip ?? {}, "mainSkip");

const tree = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0");
const tests = tree.filter((p) => /[._](test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p.split("/").pop() ?? "")).sort();
const inTree = new Set(tests);

const problems: string[] = [];
for (const f of macOnly) if (!inTree.has(f)) problems.push(`testRunner.macOnly names ${f}, not a test file in the tree`);
for (const f of joOnly) if (!inTree.has(f)) problems.push(`testRunner.mainSkip names ${f}, not a test file in the tree`);
const macSet = new Set(macOnly);
const joSet = new Set(joOnly);
for (const f of joOnly) if (macSet.has(f)) problems.push(`${f} is in both testRunner.macOnly and testRunner.mainSkip`);
if (problems.length > 0) {
	for (const p of problems) console.error(`::error title=as2-hosted sets::${p}`);
	process.exit(1);
}

const out = which === "macos" ? [...macOnly].sort() : tests.filter((f) => !macSet.has(f) && !joSet.has(f));
console.log(out.map((f) => `./${f}`).join("\n"));
