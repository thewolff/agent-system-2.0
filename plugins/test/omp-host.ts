// The installed OMP's own extension loader and runner around plugins/index.ts, for loader.test.ts and
// paired-coding.test.ts. A parent session loads plugins/index.ts the way a session does
// (extensibility/extensions/loader.ts loadExtensions: import, then bind the factory to a real
// ExtensionAPI); a child session re-binds the parent's prepared factories (bindPreparedExtensions), as
// OMP's task executor does for a hand, with the parent's environment still set. Events go through a real
// ExtensionRunner (extensibility/extensions/runner.ts), whose agent identity is what OMP gives a
// subagent (`kind: "sub"`, sdk.ts) or the top-level default.
//
// Imported by absolute path: this machine's global OMP install is absent on a fresh clone, where the
// tests that need it skip with that reason in their names (gates/test/host.test.ts does the same).

import { mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import jowolffPlugins, { ADAPTERS, type PluginAdapter } from "../index.ts";

export const OMP = "/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent";
export const HAS_OMP = existsSync(`${OMP}/src/extensibility/extensions/loader.ts`);
export const OMP_SKIP = HAS_OMP ? "" : " [skipped: no installed OMP at " + OMP + "]";
export const INDEX = join(import.meta.dir, "..", "index.ts");
export const PAIR_TOOLS = ["pair_start", "pair_note", "pair_propose", "pair_begin", "pair_write", "pair_edit", "pair_run", "pair_done"] as const;

type Env = Record<string, string | undefined>;
// biome-ignore lint/suspicious/noExplicitAny: the installed OMP's types are not on this repo's import path.
type Any = any;
export interface Prepared {
	path: string;
	resolvedPath: string;
	factory: ((pi: Any) => void | Promise<void>) | null;
	error: string | null;
}
export interface Loaded {
	extensions: Any[];
	errors: { path: string; error: string }[];
	runtime: Any;
	preparedExtensions: Prepared[];
}

const loader = async () => (await import(`${OMP}/src/extensibility/extensions/loader.ts`)) as {
	loadExtensions(paths: string[], cwd: string): Promise<Loaded>;
	bindPreparedExtensions(prepared: readonly Prepared[], cwd: string): Promise<Loaded>;
};

type OnHandler = (event: unknown, ctx: unknown) => unknown;

/** The real adapters, each `on` handler counted ("<adapter> <event>") when OMP actually calls it. */
function counted(calls: string[]): PluginAdapter[] {
	return ADAPTERS.map((adapter) => ({
		...adapter,
		bind: (pi, deps) =>
			adapter.bind(
				new Proxy(pi as object, {
					get(target, prop) {
						const value: unknown = Reflect.get(target, prop);
						if (prop === "on") {
							return (event: string, handler: OnHandler) =>
								(value as (event: string, handler: OnHandler) => void)(event, (e, c) => {
									calls.push(`${adapter.name} ${event}`);
									return handler(e, c);
								});
						}
						return typeof value === "function" ? value.bind(target) : value;
					},
				}) as never,
				deps,
			),
	}));
}

/** plugins/index.ts as a prepared factory whose adapters' handlers are counted into `calls`; its env is process.env, as in a session. */
export const countedPrepared = (calls: string[]): Prepared => ({ path: INDEX, resolvedPath: INDEX, factory: (pi) => jowolffPlugins(pi, { adapters: counted(calls) }), error: null });

/**
 * The home Bun's os.homedir() gives this process: the HOME it started with (Bun ignores a later
 * process.env.HOME, as ledger/test/isolate-preload.ts notes), so the developer's own home under
 * `bun test`. Nothing here writes under it.
 */
export const REAL_HOME = os.homedir();
let worldHome: string | undefined;
// The adapters run in this process too (i-have-audhd's fail-open errors.log, its stop state, ask-graham's
// default user dirs all derive from os.homedir()). While a world is open, homedir() answers its HOME, as
// Node's would after process.env.HOME changed; with none open it answers REAL_HOME, unchanged.
const homedir = () => worldHome ?? REAL_HOME;
mock.module("node:os", () => ({ ...os, homedir, default: { ...os, homedir } }));

/**
 * The variables these tests own in process.env, which plugins/index.ts and the adapters read live:
 * the role switches, HOME, every switch the vendored i-have-audhd adapter and hooks read
 * (omp/i-have-audhd-omp.ts, hooks/*.mjs, lib/*.mjs, judge/ask.mjs), ask-graham's XDG dirs
 * (skills/ask-graham/scripts/intensity.mjs, hooks/ask-graham-stop.mjs) and paired-coding's state dir.
 */
const OWNED = [
	"AGENT_SYSTEM_ROLE",
	"AGENT_SYSTEM_BY_HAND",
	"HOME",
	"I_HAVE_AUDHD_INJECT",
	"I_HAVE_AUDHD_PROFILE",
	"I_HAVE_AUDHD_ENFORCE",
	"I_HAVE_AUDHD_HARNESS",
	"I_HAVE_AUDHD_PLUGIN_ROOT",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"PAIRED_CODING_STATE_DIR",
] as const;

/**
 * A scratch world: a cwd, an empty HOME, an ask-graham user config at every-idea under
 * XDG_CONFIG_HOME, an XDG_STATE_HOME and a paired-coding state dir. Every owned variable is set
 * or cleared, so nothing inherited from the developer's env changes what the adapters do: no
 * i-have-audhd switch is set, and its hooks (spawned with process.env) and in-process paths both
 * see the world's HOME. `env` overrides any owned variable (the role variables are the parent's
 * env a hand inherits); `dispose` restores every owned variable and homedir(), and removes the dirs.
 */
export function world(env: Env) {
	const root = mkdtempSync(join(os.tmpdir(), "plugins-omp-"));
	const before = Object.fromEntries(OWNED.map((k) => [k, process.env[k]]));
	const cwd = join(root, "cwd");
	const home = join(root, "home");
	const xdg = join(root, "xdg");
	for (const dir of [cwd, home, join(xdg, "ask-graham"), join(root, "xdg-state"), join(root, "pair-state"), join(root, "sessions")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(xdg, "ask-graham", "config"), "intensity=every-idea\n");
	const set: Env = {
		AGENT_SYSTEM_ROLE: undefined,
		AGENT_SYSTEM_BY_HAND: undefined,
		HOME: home,
		I_HAVE_AUDHD_INJECT: undefined,
		I_HAVE_AUDHD_PROFILE: undefined,
		I_HAVE_AUDHD_ENFORCE: undefined,
		I_HAVE_AUDHD_HARNESS: undefined,
		I_HAVE_AUDHD_PLUGIN_ROOT: undefined,
		XDG_CONFIG_HOME: xdg,
		XDG_STATE_HOME: join(root, "xdg-state"),
		PAIRED_CODING_STATE_DIR: join(root, "pair-state"),
		...env,
	};
	for (const k of OWNED) {
		if (set[k] === undefined) delete process.env[k];
		else process.env[k] = set[k];
	}
	worldHome = set.HOME;
	return {
		root,
		cwd,
		home,
		dispose() {
			worldHome = undefined;
			for (const k of OWNED) {
				if (before[k] === undefined) delete process.env[k];
				else process.env[k] = before[k];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Whether `path` exists, and its mtime when it does: read with stat only, never written. */
export function stamp(path: string): { exists: false } | { exists: true; mtimeMs: number } {
	if (!existsSync(path)) return { exists: false };
	return { exists: true, mtimeMs: statSync(path).mtimeMs };
}

/** The parent session's load: OMP imports plugins/index.ts and binds its default export. */
export async function loadIndex(cwd: string): Promise<Loaded> {
	const loaded = await (await loader()).loadExtensions([INDEX], cwd);
	if (loaded.errors.length > 0) throw new Error(`OMP could not load plugins/index.ts: ${JSON.stringify(loaded.errors)}`);
	return loaded;
}

/** Bind prepared factories into a fresh runtime, as OMP does for a subagent session. */
export async function bindPrepared(prepared: readonly Prepared[], cwd: string): Promise<Loaded> {
	const loaded = await (await loader()).bindPreparedExtensions(prepared, cwd);
	if (loaded.errors.length > 0) throw new Error(`OMP could not bind plugins/index.ts: ${JSON.stringify(loaded.errors)}`);
	return loaded;
}

export type SessionKind = "main" | "persisted-child" | "headerless-child";

/**
 * A real ExtensionRunner over `loaded`. "main" is a top-level session; "persisted-child" is a session
 * file whose header names a parent session, run as a subagent; "headerless-child" is an in-memory
 * subagent session with no parent in any header.
 */
export async function session(loaded: Loaded, cwd: string, kind: SessionKind, root: string) {
	const { ExtensionRunner } = await import(`${OMP}/src/extensibility/extensions/runner.ts`);
	const { SessionManager } = await import(`${OMP}/src/session/session-manager.ts`);
	const sessionManager =
		kind === "persisted-child"
			? await SessionManager.open(join(root, "sessions", "child.jsonl"), undefined, undefined, { initialCwd: cwd, parentSession: join(root, "sessions", "parent.jsonl") })
			: SessionManager.inMemory(cwd);
	const agent = kind === "main" ? undefined : Object.freeze({ kind: "sub", id: "0-Hand", name: "task", depth: 1, parentId: "0-Main" });
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, {} as never, undefined, undefined, undefined, undefined, agent);
	const registrations: string[] = [];
	runner.onToolRegistered((tool: { definition: { name: string } }) => {
		registrations.push(tool.definition.name);
	});
	return {
		runner,
		sessionManager,
		/** Every tool name the session's extensions hold now. */
		tools: (): string[] => runner.getAllRegisteredTools().map((t: { definition: { name: string } }) => t.definition.name),
		/** Each registerTool OMP saw after the session was built, in order. */
		registrations,
		start: () => runner.emit({ type: "session_start" }),
		/** The hidden messages extensions return for a prompt (ask-graham's nudge, i-have-audhd's core). */
		beforeAgentStart: async (prompt: string): Promise<{ customType: string; content: string; display: boolean }[]> =>
			(await runner.emitBeforeAgentStart(prompt, undefined, []))?.messages ?? [],
	};
}

/** The pair_* names among `names`. */
export const pairTools = (names: string[]) => names.filter((n) => n.startsWith("pair_"));

/** profile/config.yml's disabledExtensions, as the installer renders it ({repo} never appears there). */
export function disabledExtensions(): string[] {
	const doc = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "..", "profile", "config.yml"), "utf8")) as { disabledExtensions: string[] };
	return doc.disabledExtensions;
}

/**
 * OMP's own session discovery (discoverAndLoadExtensions with ambient discovery on) in a separate
 * process under a fresh HOME, from an anchor dir whose project plugin root (<anchor>/.omp/plugins,
 * extensibility/plugins/loader.ts) holds an installed copy of each of `seeded`: the configured path is
 * plugins/index.ts and the disabled list is profile/config.yml's. Returns each loaded path and error.
 */
export function discoverWithSeededPlugins(root: string, seeded: string[]): { loaded: string[]; errors: string[] } {
	const anchor = join(root, "anchor");
	const home = join(root, "home");
	const lock: Record<string, { version: string; enabled: boolean }> = {};
	for (const p of seeded) {
		const dir = join(anchor, ".omp", "plugins", "node_modules", p);
		mkdirSync(join(dir, "omp"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: p, version: "0.0.1", omp: { extensions: [`omp/${p}-omp.ts`] } }));
		writeFileSync(join(dir, "omp", `${p}-omp.ts`), "export default function () {}\n");
		lock[p] = { version: "0.0.1", enabled: true };
	}
	mkdirSync(home, { recursive: true });
	writeFileSync(join(anchor, ".omp", "plugins", "omp-plugins.lock.json"), JSON.stringify({ plugins: lock }));
	const script = `
		const m = await import(${JSON.stringify(`${OMP}/src/index.ts`)});
		const r = await m.discoverAndLoadExtensions([${JSON.stringify(INDEX)}], process.cwd(), undefined, ${JSON.stringify(disabledExtensions())});
		for (const e of r.extensions) console.log("loaded\\t" + e.path);
		for (const e of r.errors) console.log("error\\t" + e.path + "\\t" + e.error);
		process.exit(0);
	`;
	const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: anchor, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } });
	if (run.exitCode !== 0) throw new Error(`OMP discovery exited ${run.exitCode}: ${run.stderr.toString()}`);
	const lines = run.stdout.toString().split("\n").filter(Boolean);
	return {
		loaded: lines.filter((l) => l.startsWith("loaded\t")).map((l) => l.slice("loaded\t".length)),
		errors: lines.filter((l) => l.startsWith("error\t")),
	};
}
