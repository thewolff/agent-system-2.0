// Offline fixtures for the gate tests: temp dirs, temp git repos with a local bare "origin", and
// temp ledgers through the ledger module (schema v3, with the lane-written entries table).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { tmpDir } from "../../ledger/test/tmp";
import type { ArtifactTree } from "../../surface/src/signals";
import type { ShellStartCheck } from "../src/fence";
import { type EnvironRead, MEASURED_HOST, type ShellStartHost, type ShellStartProcess, shellStart } from "../src/shell-start";
import type { Ctx } from "../src/session";

export const tmp = (tag: string): string => tmpDir(`gates-${tag}-`);

/** A shell-start check that certifies every call (gates/src/shell-start.ts), for the fence's own behaviour after it. */
export const CERTIFIED: ShellStartCheck = async () => ({ certified: true, env: new Map(), reasons: [] });

/** What a shell-start fixture varies; everything else is a state the certificate passes. */
export interface ShellStartOver {
	version?: string;
	/** Registered setting values by id (`bash.autoBackground.enabled`, `bash.direnv`). */
	settings?: Record<string, unknown>;
	/** The raw global layer (where `gates.fence.enabled` lives). */
	raw?: Record<string, unknown>;
	shell?: string;
	prefix?: string;
	shellEnv?: Record<string, string>;
	/** `getShellConfig` itself, replacing the one built from `shell`, `shellEnv` and `prefix`. */
	getShellConfig?: unknown;
	nonInteractive?: Record<string, string>;
	/** E: the environ at the call. */
	environ?: EnvironRead;
	/** E0: the environ at gate load; defaults to E. */
	gateLoad?: EnvironRead | null;
	argv?: string[];
	env?: Record<string, string | undefined>;
	/** The profile config.yml text the clean-shell switch is read from (null: no file); default on for all. */
	cleanShell?: string | null;
	host?: Partial<ShellStartHost>;
}

export const environOf = (entries: Record<string, string>): EnvironRead => ({ ok: true, env: new Map(Object.entries(entries)) });

const agentDirs = new Map<string, string>();

/** A scratch agent dir whose config.yml is `config` (null: none), one per distinct text. */
export function agentDirWith(config: string | null): string {
	const key = config ?? "\0none";
	let dir = agentDirs.get(key);
	if (dir === undefined || !existsSync(dir)) {
		dir = tmp("agent");
		if (config !== null) writeFileSync(join(dir, "config.yml"), config);
		agentDirs.set(key, dir);
	}
	return dir;
}

/**
 * A host and process the shell-start certificate reads (gates/src/shell-start.ts), certifying by
 * default: OMP 18.8.6, the clean-shell switch "all", fence and auto-background on, direnv off,
 * `/bin/sh` with no prefix, no PI_NO_PTY, a plain launch argv, E = E0. The CLI functions are
 * stand-ins (`acp` subcommand, `--mode acp`);
 * gates/test/shell-start.test.ts reads ACP through OMP's own parsers too.
 */
export function shellStartFixture(o: ShellStartOver = {}): { host: ShellStartHost; proc: ShellStartProcess; check: ShellStartCheck } {
	const settings: Record<string, unknown> = { "bash.autoBackground.enabled": true, "bash.direnv": "off", ...o.settings };
	const instance = {
		getGlobalSettings: () => o.raw ?? { gates: { fence: { enabled: true } } },
		getShellConfig: o.getShellConfig ?? (() => ({ shell: o.shell ?? "/bin/sh", args: ["-c"], env: o.shellEnv ?? { PATH: "/bin", HOME: "/h" }, prefix: o.prefix })),
	};
	const host: ShellStartHost = {
		version: o.version ?? MEASURED_HOST,
		Settings: { current: Promise.resolve(instance), loadReadOnly: async () => instance },
		lookup: (id) => (Object.hasOwn(settings, id) ? { get: () => settings[id] } : undefined),
		buildNonInteractiveEnv: () => o.nonInteractive ?? { CI: "1", PAGER: "cat" },
		extractProfileFlags: (argv: string[]) => ({ argv }),
		resolveCliArgv: (argv: string[]) => ({ argv: argv[0] === "acp" ? argv : ["launch", ...argv] }),
		parseArgs: (rest: string[]) => {
			const at = rest.findIndex((a) => a === "--mode" || a.startsWith("--mode="));
			return { mode: at < 0 ? undefined : rest[at] === "--mode" ? rest[at + 1] : rest[at]!.slice("--mode=".length) };
		},
		getAgentDir: () => agentDirWith(o.cleanShell === undefined ? 'gates:\n  cleanShell: "all"\n' : o.cleanShell),
		...o.host,
	};
	const environ = o.environ ?? environOf({ PATH: "/bin", HOME: "/h" });
	const proc: ShellStartProcess = {
		environ: () => environ,
		gateLoad: () => (o.gateLoad === undefined ? environ : o.gateLoad),
		argv: () => o.argv ?? ["--cwd", "/repo"],
		env: () => o.env ?? {},
	};
	return { host, proc, check: (ctx: Ctx, input, cwd) => shellStart(host, ctx, input, cwd, proc) };
}

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "gate test",
	GIT_AUTHOR_EMAIL: "gate@test.invalid",
	GIT_COMMITTER_NAME: "gate test",
	GIT_COMMITTER_EMAIL: "gate@test.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

/** Run git in `cwd`, hooks and signing off; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
		cwd,
		encoding: "utf8",
		env: GIT_ENV,
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
	return r.stdout.trim();
}

export function commit(repo: string, file: string, content: string, msg = `edit ${file}`): void {
	writeFileSync(join(repo, file), content);
	git(repo, "add", file);
	git(repo, "commit", "-q", "-m", msg);
}

/** A bare origin plus a working clone on `main` with one pushed commit and origin/HEAD recorded. */
export function repoWithOrigin(): { root: string; origin: string; work: string } {
	const root = tmp("repo");
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	git(root, "init", "-q", "--bare", "-b", "main", origin);
	mkdirSync(work);
	git(work, "init", "-q", "-b", "main");
	git(work, "remote", "add", "origin", origin);
	commit(work, "a.txt", "a\n");
	git(work, "push", "-q", "origin", "main");
	git(work, "fetch", "-q", "origin");
	git(work, "remote", "set-head", "origin", "main");
	return { root, origin, work };
}

/** A second clone that advances origin/main by one commit. */
export function advanceOriginMain(root: string, origin: string): void {
	const other = join(root, `other-${Date.now()}`);
	git(root, "clone", "-q", origin, other);
	commit(other, `c-${Date.now()}.txt`, "c\n");
	git(other, "push", "-q", "origin", "main");
}

/** The artifact-tree record (surface/src/signals.ts) a passing `bun test` on `work`'s HEAD tree leaves, as row 8 reads it. */
export function testRecord(work: string, over: Partial<ArtifactTree> = {}): ArtifactTree {
	return { sliceId: "sl-test", repo: git(work, "rev-parse", "--show-toplevel"), tree: git(work, "rev-parse", "HEAD^{tree}"), command: "bun test", ...over };
}

export function tempLedger(clock?: () => string): { ledger: Ledger; path: string } {
	const path = join(tmp("ledger"), "ledger.db");
	return { ledger: Ledger.open(path, { create: true, backup: false, backupOnOpen: false, ...(clock ? { clock } : {}) }), path };
}

/** A six-field brief line block. */
export function brief(over: Partial<Record<string, string>> = {}): string {
	const f = { workload: "wl-test1", task: "Add the thing.", "done-condition": "bun test passes", inputs: "gates/", stakes: "normal", "ceiling-share": "10", ...over };
	return Object.entries(f)
		.filter(([, v]) => v !== "")
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
}
