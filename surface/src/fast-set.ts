/**
 * The fast check's test set and the exceptions that take the full suite before merge (PLAN wl-mvq4edbaf13vnk § 2 "The fast
 * check", D2; requirements R1, R2). Pure over an injected file reader: the runner reads the tree at the head X, and the tick's
 * attribution (surface/src/main-state.ts `attribute`) reads the tree at the failing main commit.
 */
import { posix } from "node:path";
import { isBunTestFile, type TestRunnerConfig } from "./test-run";

/** The schema-migration paths (§ 2 Exceptions): the schema file, and the file whose `SCHEMA_VERSION` line is the version. */
export const SCHEMA_SQL = "ledger/schema.sql";
export const SCHEMA_INDEX = "ledger/src/index.ts";

/**
 * Dependency manifests and lockfiles across ecosystems, by basename (§ 2 Exceptions): every tracked file with one of these
 * names must be covered by `testRunner.fullBeforeMerge` (`uncoveredManifests`), so a new manifest without an entry fails the suite.
 */
export const KNOWN_MANIFESTS: readonly string[] = Object.freeze([
	"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "bun.lockb",
	"bunfig.toml", "deno.json", "deno.jsonc", "deno.lock", "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "go.mod", "go.sum",
	"go.work", "requirements.txt", "Pipfile", "Pipfile.lock", "pyproject.toml", "poetry.lock", "uv.lock", "setup.py", "setup.cfg", "Gemfile",
	"Gemfile.lock", "composer.json", "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
	"gradle.lockfile", "mix.exs", "mix.lock", "Package.swift", "Package.resolved", "Podfile", "Podfile.lock", "pubspec.yaml", "pubspec.lock",
	"flake.nix", "flake.lock",
]);

/** The module extensions the import scan reads and an extensionless specifier may resolve to, in resolution order. */
const MODULE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const;
/** The changed files that must transpile (§ 2: `.ts`, `.tsx` and `.js`). */
const PARSE_EXTS = [".ts", ".tsx", ".js"] as const;

/** A file of the tree, null when the tree has no such file. */
export type ReadFile = (path: string) => string | null;
export type FastConfig = Pick<TestRunnerConfig, "fastSmoke" | "macOnly" | "fullBeforeMerge">;

/** The fast check's plan for one head: the Linux files to run, the mac-only files left for main runs, and the parse targets. */
export interface FastRun {
	kind: "fast";
	/** Repo-relative Bun test files the hosted Linux run executes, sorted. */
	files: string[];
	/** Fast-set test files in `testRunner.macOnly`: they run only in main runs, sorted. */
	macOnly: string[];
	/** Changed `.ts`, `.tsx` and `.js` files present at X, which must transpile (`parseCheck`), sorted. */
	parse: string[];
}
/** The full suite before merge, with every exception that requires it (§ 2 Exceptions). */
export interface FullRun {
	kind: "full";
	reasons: string[];
}

/** A config or input the fast set cannot be computed from: it names what is wrong and where; the caller refuses the request. */
export class FastSetError extends Error {
	constructor(what: string) {
		super(`fast set: ${what}`);
		this.name = "FastSetError";
	}
}

const extOf = (path: string): string => {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot);
};
const dirOf = (path: string): string => {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
};
const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const isModule = (path: string): boolean => (MODULE_EXTS as readonly string[]).includes(extOf(path));

const transpilers = new Map<string, Bun.Transpiler>();
function transpilerFor(path: string): Bun.Transpiler {
	const ext = extOf(path);
	const loader = ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : ext === ".js" || ext === ".mjs" || ext === ".cjs" ? "js" : "ts";
	let t = transpilers.get(loader);
	if (!t) {
		t = new Bun.Transpiler({ loader });
		transpilers.set(loader, t);
	}
	return t;
}

/**
 * The tree file a relative specifier of `importer` names, or null when it resolves to no file of the tree (or leaves it).
 * Tries the path itself, then each module extension, then a `.js`-family specifier's TypeScript sibling, then `<path>/index.<ext>`.
 */
export function resolveRelative(importer: string, spec: string, inTree: (path: string) => boolean): string | null {
	const bare = spec.replace(/[?#].*$/, "");
	const joined = posix.normalize(posix.join(dirOf(importer) || ".", bare));
	if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return null;
	const candidates = [joined, ...MODULE_EXTS.map((e) => joined + e)];
	const ts = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }[extOf(joined)];
	if (ts) for (const e of ts) candidates.push(joined.slice(0, -extOf(joined).length) + e);
	for (const e of MODULE_EXTS) candidates.push(`${joined}/index${e}`);
	return candidates.find(inTree) ?? null;
}

/** One module's relative imports: resolved tree files, and whether any did not resolve (or the file did not scan). */
interface ModuleImports {
	resolved: string[];
	unresolved: boolean;
}

/** Every module's relative imports over the tree (Bun's `scanImports`; packages and `node:`/`bun:` builtins are not tree files). */
function importGraph(tree: readonly string[], read: ReadFile): Map<string, ModuleImports> {
	const inTree = new Set(tree);
	const has = (p: string) => inTree.has(p);
	const out = new Map<string, ModuleImports>();
	for (const path of tree) {
		if (!isModule(path)) continue;
		const src = read(path);
		if (src === null) throw new FastSetError(`${path} is in the tree but the reader returned nothing for it`);
		let specs: string[];
		try {
			specs = transpilerFor(path).scanImports(src).map((i) => i.path);
		} catch {
			// A module that does not scan cannot say what it imports: its directory's tests are widened in, like an unresolved import.
			// A changed one also fails its parse check (`parseCheck`), which names the error.
			out.set(path, { resolved: [], unresolved: true });
			continue;
		}
		const resolved: string[] = [];
		let unresolved = false;
		for (const spec of specs) {
			if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
			const target = resolveRelative(path, spec, has);
			if (target === null) unresolved = true;
			else resolved.push(target);
		}
		out.set(path, { resolved, unresolved });
	}
	return out;
}

/**
 * R(C) (§ 2 The fast check): the changed files plus every tree module that imports one of them, transitively. A deleted file
 * of C stays in R(C), so a test that names it is still found.
 */
function reachOver(changed: readonly string[], graph: Map<string, ModuleImports>): Set<string> {
	const importers = new Map<string, string[]>();
	for (const [from, m] of graph) {
		for (const to of m.resolved) {
			const list = importers.get(to);
			if (list) list.push(from);
			else importers.set(to, [from]);
		}
	}
	const out = new Set(changed);
	const queue = [...changed];
	while (queue.length > 0) {
		for (const from of importers.get(queue.pop()!) ?? []) {
			if (out.has(from)) continue;
			out.add(from);
			queue.push(from);
		}
	}
	return out;
}

/**
 * A tree's test reach (§ 2 The fast check), its import graph scanned once: for a change C, the tree's Bun test files that
 * are in R(C), import a file of R(C) (so are in R(C) themselves), or name a file of R(C) by repo-relative path or basename
 * in their source; plus every test file of the directory of any module with an import that does not resolve inside the
 * tree. Sorted; smoke and macOnly are not applied. Attribution calls it once per suspect over one tree.
 */
export function testReach(tree: readonly string[], read: ReadFile): (changed: readonly string[]) => string[] {
	const graph = importGraph(tree, read);
	const tests = tree.filter(isBunTestFile);
	const widened = new Set<string>();
	for (const [path, m] of graph) if (m.unresolved) widened.add(dirOf(path));
	return (changed) => {
		const r = reachOver(changed, graph);
		const names = new Set<string>();
		for (const p of r) {
			names.add(p);
			names.add(baseOf(p));
		}
		const out: string[] = [];
		for (const t of tests) {
			if (r.has(t) || widened.has(dirOf(t))) {
				out.push(t);
				continue;
			}
			const src = read(t);
			if (src === null) throw new FastSetError(`${t} is in the tree but the reader returned nothing for it`);
			for (const n of names) {
				if (src.includes(n)) {
					out.push(t);
					break;
				}
			}
		}
		return out.sort();
	};
}

/** The `SCHEMA_VERSION` line of the ledger's index source, or null when the source has none. */
const schemaVersionLine = (src: string | null): string | null => (src === null ? null : (/^.*\bSCHEMA_VERSION\s*=.*$/m.exec(src)?.[0].trim() ?? null));

/**
 * Every exception that takes the full suite before merge (§ 2 Exceptions), in this order: a schema migration (a change to
 * `ledger/schema.sql`, or to the `SCHEMA_VERSION` line of `ledger/src/index.ts` between the merge-base and X), a change to a
 * file whose basename is in `fullBeforeMerge`. Empty when the fast check applies.
 */
export function fullExceptions(
	changed: readonly string[], read: ReadFile, readBase: ReadFile, cfg: Pick<FastConfig, "fullBeforeMerge">,
): string[] {
	const reasons: string[] = [];
	if (changed.includes(SCHEMA_SQL)) reasons.push(`schema migration: ${SCHEMA_SQL} changed`);
	if (changed.includes(SCHEMA_INDEX) && schemaVersionLine(read(SCHEMA_INDEX)) !== schemaVersionLine(readBase(SCHEMA_INDEX))) {
		reasons.push(`schema migration: the SCHEMA_VERSION line of ${SCHEMA_INDEX} changed`);
	}
	const deps = changed.filter((p) => cfg.fullBeforeMerge.includes(baseOf(p)));
	if (deps.length > 0) reasons.push(`dependencies or toolchain: ${deps.join(", ")} changed (testRunner.fullBeforeMerge)`);
	return reasons;
}

/**
 * The fast check's plan for head X (D2): `full` with every exception when one applies, else the fast set. `changed` is C
 * (`git diff --name-only <merge-base> X`), `tree` the tracked files at X, `read` a file at X, `readBase` a file at the
 * merge-base. The Linux files are the reached tests plus `fastSmoke`, minus `macOnly`. A smoke file not in the tree is a
 * config error, never dropped.
 */
export function fastSet(
	changed: readonly string[], tree: readonly string[], read: ReadFile, readBase: ReadFile, cfg: FastConfig,
): FastRun | FullRun {
	const reasons = fullExceptions(changed, read, readBase, cfg);
	if (reasons.length > 0) return { kind: "full", reasons };
	const inTree = new Set(tree);
	const missing = cfg.fastSmoke.filter((s) => !inTree.has(s));
	if (missing.length > 0) throw new FastSetError(`testRunner.fastSmoke names ${missing.join(", ")}, not in the tree at the head; fix profile/config.yml`);
	const set = new Set([...testReach(tree, read)(changed), ...cfg.fastSmoke]);
	const files: string[] = [];
	const macOnly: string[] = [];
	for (const f of [...set].sort()) (Object.hasOwn(cfg.macOnly, f) ? macOnly : files).push(f);
	const parse = changed.filter((p) => inTree.has(p) && (PARSE_EXTS as readonly string[]).includes(extOf(p))).sort();
	return { kind: "fast", files, macOnly, parse };
}

/** Each parse target that does not transpile (`Bun.Transpiler`, no execution), with Bun's first message; empty when all do. */
export function parseCheck(targets: readonly string[], read: ReadFile): { path: string; error: string }[] {
	const out: { path: string; error: string }[] = [];
	for (const path of targets) {
		const src = read(path);
		if (src === null) {
			out.push({ path, error: "not in the tree at the head" });
			continue;
		}
		try {
			transpilerFor(path).transformSync(src);
		} catch (e) {
			const first = e instanceof AggregateError && e.errors.length > 0 ? e.errors[0] : e;
			const pos = (first as { position?: { line?: number; column?: number } } | null)?.position;
			const msg = first instanceof Error ? first.message : String(first);
			out.push({ path, error: pos?.line !== undefined ? `${pos.line}:${pos.column ?? 0}: ${msg}` : msg });
		}
	}
	return out;
}

/** Tracked dependency manifests and lockfiles (`KNOWN_MANIFESTS`, by basename) whose basename `fullBeforeMerge` leaves out, sorted. */
export function uncoveredManifests(tracked: readonly string[], fullBeforeMerge: readonly string[]): string[] {
	return tracked.filter((p) => KNOWN_MANIFESTS.includes(baseOf(p)) && !fullBeforeMerge.includes(baseOf(p))).sort();
}
