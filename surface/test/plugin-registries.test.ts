// The plugin-registry disagreement check (PLAN wl-mv8k0fby51uakg D7, jo-issues#51): surface/src/plugin-registries.ts
// `findDisagreements` on fixture homes, OMP's precedence from pi-coding-agent@18.8.6 src/discovery/helpers.ts
// `listClaudePluginRoots`, and the CLI surface/scripts/plugin-registries.ts that bin/as2 runs before every start.
// Every fixture home is a temp directory holding a project `proj` with a `.git` directory, the cwd of each check; the
// env is the test's own map, never this process's (OMP_PROFILE is set in a lane).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { main } from "../scripts/plugin-registries";
import { type Disagreement, findDisagreements } from "../src/plugin-registries";
import { tmp } from "./helpers";

const REPO = resolve(import.meta.dir, "..", "..");
const ID = "tool@market";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fixture home, its project (the cwd of each check) and its registry paths. */
interface Fixture {
	home: string;
	proj: string;
	claude: string;
	omp: string;
	profile: (name: string) => string;
	project: string;
}

function fixture(tag: string): Fixture {
	const home = realpathSync(tmp(`plugins-${tag}`));
	roots.push(home);
	const proj = join(home, "proj");
	mkdirSync(join(proj, ".git"), { recursive: true });
	return {
		home,
		proj,
		claude: join(home, ".claude", "plugins", "installed_plugins.json"),
		omp: join(home, ".omp", "plugins", "installed_plugins.json"),
		profile: (name: string) => join(home, ".omp", "profiles", name, "plugins", "installed_plugins.json"),
		project: join(proj, ".omp", "plugins", "installed_plugins.json"),
	};
}

function put(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

/** A registry file's content: one id with the given entries. */
const registry = (entries: Record<string, unknown>[], id = ID) => ({ version: 2, plugins: { [id]: entries } });
/** One registry entry at `version`; user scope unless `extra` says otherwise. */
const at = (version: string, extra: Record<string, unknown> = {}) => ({ scope: "user", installPath: `/cache/${ID}/${version}`, version, ...extra });

const check = (f: Fixture, env: Record<string, string> = {}) => findDisagreements({ home: f.home, env, cwd: f.proj });

describe("findDisagreements: OMP's precedence for the cwd", () => {
	test("agreement: the same version in Claude's and OMP's user registries → []", () => {
		const f = fixture("agree");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("1.0.0")]));
		expect(check(f)).toEqual([]);
	});

	test("absent registries → []", () => {
		expect(check(fixture("absent"))).toEqual([]);
	});

	test("a user-scope version mismatch → one disagreement naming both versions and both registries", () => {
		const f = fixture("mismatch");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")]));
		expect(check(f)).toEqual([{ id: ID, ompVersion: "2.0.0", ompPath: f.omp, claudeVersion: "1.0.0", claudePath: f.claude } satisfies Disagreement]);
	});

	test("an id only in Claude's registry → []", () => {
		const f = fixture("claude-only");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")], "other@market"));
		expect(check(f)).toEqual([]);
	});

	test("a Claude entry with enabled: false is not active → []", () => {
		const f = fixture("entry-off");
		put(f.claude, registry([at("1.0.0", { enabled: false })]));
		put(f.omp, registry([at("2.0.0")]));
		expect(check(f)).toEqual([]);
	});

	test("a Claude entry switched off by enabledPlugins false, in Claude's settings or the project's → []", () => {
		const f = fixture("settings-off");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")]));
		put(join(f.home, ".claude", "settings.json"), { enabledPlugins: { [ID]: false } });
		expect(check(f)).toEqual([]);

		const g = fixture("project-settings-off");
		put(g.claude, registry([at("1.0.0")]));
		put(g.omp, registry([at("2.0.0")]));
		put(join(g.home, ".claude", "settings.json"), { enabledPlugins: { [ID]: true } });
		put(join(g.proj, ".claude", "settings.local.json"), { enabledPlugins: { [ID]: false } });
		expect(check(g)).toEqual([]);
	});

	test("a project-scope Claude entry recorded for another project → []", () => {
		const f = fixture("other-project");
		const other = join(f.home, "other");
		mkdirSync(other);
		put(f.claude, registry([at("1.0.0", { scope: "project", projectPath: other }), at("1.5.0", { scope: "local", projectPath: other })]));
		put(f.omp, registry([at("2.0.0")]));
		expect(check(f)).toEqual([]);
	});

	test("a project-scope Claude entry for this project with a mismatch → one; enabledPlugins true opts another project's entry in", () => {
		const f = fixture("this-project");
		put(f.claude, registry([at("1.0.0", { scope: "project", projectPath: f.proj })]));
		put(f.omp, registry([at("2.0.0")]));
		expect(check(f)).toEqual([{ id: ID, ompVersion: "2.0.0", ompPath: f.omp, claudeVersion: "1.0.0", claudePath: f.claude }]);

		const g = fixture("opted-in");
		const other = join(g.home, "other");
		mkdirSync(other);
		put(g.claude, registry([at("1.0.0", { scope: "local", projectPath: other })]));
		put(g.omp, registry([at("2.0.0")]));
		put(join(g.proj, ".claude", "settings.json"), { enabledPlugins: { [ID]: true } });
		expect(check(g)).toEqual([{ id: ID, ompVersion: "2.0.0", ompPath: g.omp, claudeVersion: "1.0.0", claudePath: g.claude }]);
	});

	test("the project OMP registry overrides the user OMP registry: the project's entry is the one compared", () => {
		const f = fixture("project-over-user");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("1.0.0")]));
		put(f.project, registry([at("3.0.0", { scope: "project" })]));
		expect(check(f)).toEqual([{ id: ID, ompVersion: "3.0.0", ompPath: f.project, claudeVersion: "1.0.0", claudePath: f.claude }]);

		// And the other way: a user registry that disagrees is shadowed by a project one that agrees.
		const g = fixture("project-agrees");
		put(g.claude, registry([at("1.0.0")]));
		put(g.omp, registry([at("2.0.0")]));
		put(g.project, registry([at("1.0.0", { scope: "project" })]));
		expect(check(g)).toEqual([]);
	});

	test("a disabled plugin counts as absent: OMP's disable (every entry enabled: false) in the user or the project registry → []", () => {
		// `omp plugin disable` writes enabled: false on every entry of the id (pi-coding-agent@18.8.6
		// src/extensibility/plugins/marketplace/manager.ts `setPluginEnabled`); OMP then drops Claude's entries for the id
		// and loads none. Claude's side (enabledPlugins false, or enabled: false on its entry) is the tests above.
		const f = fixture("omp-disabled");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0", { enabled: false })]));
		expect(check(f)).toEqual([]);

		const g = fixture("project-disabled");
		put(g.claude, registry([at("1.0.0")]));
		put(g.omp, registry([at("1.0.0")]));
		put(g.project, registry([at("3.0.0", { scope: "project", enabled: false })]));
		expect(check(g)).toEqual([]);
	});

	test("the active profile's registry is checked beside the default's; CLAUDE_CONFIG_DIR moves Claude's registry", () => {
		const f = fixture("profile");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("1.0.0")]));
		put(f.profile("as2"), registry([at("2.0.0")]));
		expect(check(f)).toEqual([]);
		expect(check(f, { OMP_PROFILE: "as2" })).toEqual([{ id: ID, ompVersion: "2.0.0", ompPath: f.profile("as2"), claudeVersion: "1.0.0", claudePath: f.claude }]);
		expect(check(f, { OMP_PROFILE: "missing" })).toEqual([]);

		const claudeDir = join(f.home, "elsewhere");
		put(join(claudeDir, "plugins", "installed_plugins.json"), registry([at("0.9.0")]));
		expect(check(f, { CLAUDE_CONFIG_DIR: claudeDir })).toEqual([
			{ id: ID, ompVersion: "1.0.0", ompPath: f.omp, claudeVersion: "0.9.0", claudePath: join(claudeDir, "plugins", "installed_plugins.json") },
		]);
	});
});

describe("OMP's XDG data root (pi-utils@18.8.6 src/dirs.ts DirResolver, getPluginsDir)", () => {
	/** `$XDG_DATA_HOME/omp[/profiles/<name>]/plugins/installed_plugins.json`, with XDG_DATA_HOME `<home>/xdg`. */
	const xdgRegistry = (f: Fixture, profile?: string) => join(f.home, "xdg", "omp", ...(profile ? ["profiles", profile] : []), "plugins", "installed_plugins.json");
	const xdg = (f: Fixture) => ({ XDG_DATA_HOME: join(f.home, "xdg") });

	test("default profile: an existing $XDG_DATA_HOME/omp holds the registry OMP reads, not ~/.omp's", () => {
		const f = fixture("xdg-default");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("1.0.0")]));
		put(xdgRegistry(f), registry([at("2.0.0")]));
		expect(check(f, xdg(f))).toEqual([{ id: ID, ompVersion: "2.0.0", ompPath: xdgRegistry(f), claudeVersion: "1.0.0", claudePath: f.claude }]);
	});

	test("named profile: an existing $XDG_DATA_HOME/omp/profiles/<name> holds that profile's registry", () => {
		const f = fixture("xdg-profile");
		put(f.claude, registry([at("1.0.0")]));
		put(xdgRegistry(f, "as2"), registry([at("2.0.0")]));
		expect(check(f, { ...xdg(f), OMP_PROFILE: "as2" })).toEqual([{ id: ID, ompVersion: "2.0.0", ompPath: xdgRegistry(f, "as2"), claudeVersion: "1.0.0", claudePath: f.claude }]);
		expect(check(f, xdg(f))).toEqual([]);
	});

	test("the legacy paths where OMP falls back: no XDG app root, no XDG profile dir, or an agent dir not the profile's own", () => {
		const f = fixture("xdg-fallback");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")]));
		const legacy = [{ id: ID, ompVersion: "2.0.0", ompPath: f.omp, claudeVersion: "1.0.0", claudePath: f.claude }];
		expect(check(f, xdg(f))).toEqual(legacy);

		// The base XDG root exists: the default profile moves to it (no registry there), a named profile without its
		// own XDG dir stays on ~/.omp/profiles/<name>.
		mkdirSync(join(f.home, "xdg", "omp"), { recursive: true });
		put(f.profile("as2"), registry([at("3.0.0")]));
		expect(check(f, { ...xdg(f), OMP_PROFILE: "as2" })).toEqual([{ id: ID, ompVersion: "3.0.0", ompPath: f.profile("as2"), claudeVersion: "1.0.0", claudePath: f.claude }]);

		// PI_CODING_AGENT_DIR away from ~/.omp/agent keeps the default profile off XDG.
		expect(check(f, { ...xdg(f), PI_CODING_AGENT_DIR: join(f.home, "agent-elsewhere") })).toEqual(legacy);
		// One the parent's profile derived (PI_PROFILE's own agent dir) does not.
		expect(check(f, { ...xdg(f), PI_PROFILE: "as2", OMP_PROFILE: "default", PI_CODING_AGENT_DIR: join(f.home, ".omp", "profiles", "as2", "agent") })).toEqual([]);
	});

	test("XDG_DATA_HOME from a dotenv file OMP loads (~/.env) moves the registry too; the env's own value wins", () => {
		const f = fixture("xdg-dotenv");
		put(f.claude, registry([at("1.0.0")]));
		put(xdgRegistry(f), registry([at("2.0.0")]));
		put(join(f.home, ".env"), `XDG_DATA_HOME=${join(f.home, "xdg")}\n`);
		expect(check(f)).toEqual([{ id: ID, ompVersion: "2.0.0", ompPath: xdgRegistry(f), claudeVersion: "1.0.0", claudePath: f.claude }]);
		expect(check(f, { XDG_DATA_HOME: join(f.home, "no-xdg") })).toEqual([]);
	});

	test("PI_CODING_AGENT_DIR from a dotenv file OMP loads keeps the default profile off XDG: refreshDirsFromEnv recomputes the override", () => {
		// pi-utils@18.8.6 src/env.ts fills the env, then `refreshDirsFromEnv` takes the agent-dir override from the
		// filled PI_CODING_AGENT_DIR; an agent dir not the profile's own leaves the data root at the legacy config root.
		const f = fixture("xdg-dotenv-agent-dir");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")]));
		put(xdgRegistry(f), registry([at("3.0.0")]));
		expect(check(f, xdg(f))).toEqual([{ id: ID, ompVersion: "3.0.0", ompPath: xdgRegistry(f), claudeVersion: "1.0.0", claudePath: f.claude }]);

		const legacy = [{ id: ID, ompVersion: "2.0.0", ompPath: f.omp, claudeVersion: "1.0.0", claudePath: f.claude }];
		const line = `PI_CODING_AGENT_DIR=${join(f.home, "agent-elsewhere")}\n`;
		for (const dotenv of [join(f.home, ".omp", "agent", ".env"), join(f.home, ".omp", ".env"), join(f.home, ".env"), join(f.proj, ".env")]) {
			put(dotenv, line);
			expect({ dotenv, found: check(f, xdg(f)) }).toEqual({ dotenv, found: legacy });
			rmSync(dotenv);
		}
		// The default agent dir named in a dotenv file is the profile's own: XDG stays.
		put(join(f.home, ".env"), `PI_CODING_AGENT_DIR=${join(f.home, ".omp", "agent")}\n`);
		expect(check(f, xdg(f))).toEqual([{ id: ID, ompVersion: "3.0.0", ompPath: xdgRegistry(f), claudeVersion: "1.0.0", claudePath: f.claude }]);
	});

	test("competing dotenv values: the first of project, agent dir, config root, home holding the key wins, as in OMP", () => {
		// pi-utils@18.8.6 src/env.ts: `for (const file of [projectEnv, agentEnv, piEnv, homeEnv])`, each filling unset keys.
		const f = fixture("xdg-dotenv-order");
		put(f.claude, registry([at("1.0.0")]));
		const files = [
			["project", join(f.proj, ".env")],
			["agent", join(f.home, ".omp", "agent", ".env")],
			["root", join(f.home, ".omp", ".env")],
			["home", join(f.home, ".env")],
		] as const;
		const registryOf = (name: string) => join(f.home, `xdg-${name}`, "omp", "plugins", "installed_plugins.json");
		files.forEach(([name, file], i) => {
			put(file, `XDG_DATA_HOME=${join(f.home, `xdg-${name}`)}\n`);
			put(registryOf(name), registry([at(`${i + 2}.0.0`)]));
		});
		for (const [i, [name, file]] of files.entries()) {
			expect({ name, found: check(f) }).toEqual({ name, found: [{ id: ID, ompVersion: `${i + 2}.0.0`, ompPath: registryOf(name), claudeVersion: "1.0.0", claudePath: f.claude }] });
			rmSync(file);
		}
	});
});

describe("the CLI: check [--cwd <dir>]", () => {
	const run = (f: Fixture, env: Record<string, string> = {}) => {
		let err = "";
		const code = main(["check", "--cwd", f.proj], { HOME: f.home, ...env }, (s) => {
			err += s;
		});
		return { code, err };
	};

	test("agreement: exit 0 and nothing printed", () => {
		const f = fixture("cli-agree");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("1.0.0")]));
		expect(run(f)).toEqual({ code: 0, err: "" });
	});

	test("a disagreement: exit 1, one line with both versions and paths, then the match and disable commands", () => {
		const f = fixture("cli-mismatch");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")]));
		const r = run(f);
		expect(r.code).toBe(1);
		const lines = r.err.trimEnd().split("\n");
		expect(lines[1]).toBe(`  ${ID}: OMP 2.0.0 (${f.omp}) vs Claude 1.0.0 (${f.claude})`);
		expect(lines).toContain(`  match Claude:      OMP_PROFILE=default omp plugin install --force ${ID}`);
		expect(lines).toContain(`  match OMP:         claude plugin update ${ID}`);
		expect(lines).toContain(`  disable in OMP:    OMP_PROFILE=default omp plugin disable --scope user ${ID}`);
		expect(lines).toContain(`  disable in Claude: claude plugin disable ${ID}`);
		expect(r.err).toContain("Claude's, once it succeeds, leaves the plugin no active Claude entry to disagree with");

		put(f.project, registry([at("3.0.0", { scope: "project" })]));
		const p = run(f).err.split("\n");
		expect(p).toContain(`  match Claude:      (cd ${f.proj} && omp plugin install --force --scope project ${ID})`);
		expect(p).toContain(`  disable in OMP:    (cd ${f.proj} && omp plugin disable --scope project ${ID})`);
	});

	test("an OMP disable can expose a lower OMP entry that disagrees too: Claude 1, OMP user 2, OMP project 3", () => {
		// The project's entry shadows the user's (pi-coding-agent@18.8.6 src/discovery/helpers.ts); once `omp plugin
		// disable --scope project` writes enabled: false on it, the user registry's entry counts and disagrees on its own.
		const f = fixture("cli-expose-lower");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")]));
		put(f.project, registry([at("3.0.0", { scope: "project" })]));
		const first = run(f);
		expect(first.code).toBe(1);
		expect(first.err.split("\n")[1]).toBe(`  ${ID}: OMP 3.0.0 (${f.project}) vs Claude 1.0.0 (${f.claude})`);
		expect(first.err).toContain("a lower OMP entry for the same plugin (the user registry's, under a project one) then counts, and can disagree with Claude in its own right");

		put(f.project, registry([at("3.0.0", { scope: "project", enabled: false })]));
		const second = run(f);
		expect(second.code).toBe(1);
		const lines = second.err.split("\n");
		expect(lines[1]).toBe(`  ${ID}: OMP 2.0.0 (${f.omp}) vs Claude 1.0.0 (${f.claude})`);
		expect(lines).toContain(`  disable in OMP:    OMP_PROFILE=default omp plugin disable --scope user ${ID}`);
	});

	test("an XDG profile registry's commands name that profile", () => {
		const f = fixture("cli-xdg");
		put(f.claude, registry([at("1.0.0")]));
		put(join(f.home, "xdg", "omp", "profiles", "as2", "plugins", "installed_plugins.json"), registry([at("2.0.0")]));
		const r = run(f, { XDG_DATA_HOME: join(f.home, "xdg"), OMP_PROFILE: "as2" });
		expect(r.code).toBe(1);
		expect(r.err.split("\n")).toContain(`  disable in OMP:    OMP_PROFILE=as2 omp plugin disable --scope user ${ID}`);
	});

	test("every command is shell-quoted: a project path with a space and an apostrophe, an id with shell syntax, each round-trips through sh", () => {
		const home = realpathSync(tmp("plugins-quote"));
		roots.push(home);
		const proj = join(home, "Jo's proj");
		mkdirSync(join(proj, ".git"), { recursive: true });
		const id = "it's $HOME `x`@market";
		put(join(home, ".claude", "plugins", "installed_plugins.json"), registry([at("1.0.0")], id));
		put(join(home, ".omp", "plugins", "installed_plugins.json"), registry([at("2.0.0")], id));
		const projectRegistry = join(proj, ".omp", "plugins", "installed_plugins.json");
		put(projectRegistry, registry([at("3.0.0", { scope: "project" })], id));

		/** The printed commands by label, each run by sh with omp and claude as functions printing $PWD, the name, OMP_PROFILE (omp) and argv. */
		const runCommands = () => {
			let err = "";
			expect(main(["check", "--cwd", proj], { HOME: home }, (s) => (err += s))).toBe(1);
			const out: Record<string, string[]> = {};
			for (const line of err.split("\n")) {
				const m = /^ {2}(match Claude|match OMP|disable in OMP|disable in Claude): +(.*)$/.exec(line);
				if (!m) continue;
				const shim = `omp() { printf '%s\\n' "$PWD" omp "\${OMP_PROFILE-}" "$@"; }; claude() { printf '%s\\n' "$PWD" claude "$@"; }; `;
				const r = Bun.spawnSync(["sh", "-c", shim + m[2]!], { cwd: home, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
				expect({ command: m[2], code: r.exitCode, err: r.stderr.toString() }).toEqual({ command: m[2], code: 0, err: "" });
				out[m[1]!] = r.stdout.toString().replace(/\n$/, "").split("\n");
			}
			return out;
		};

		expect(runCommands()).toEqual({
			"match Claude": [proj, "omp", "", "plugin", "install", "--force", "--scope", "project", id],
			"match OMP": [proj, "claude", "plugin", "update", id],
			"disable in OMP": [proj, "omp", "", "plugin", "disable", "--scope", "project", id],
			"disable in Claude": [proj, "claude", "plugin", "disable", id],
		});

		rmSync(projectRegistry);
		expect(runCommands()).toEqual({
			"match Claude": [home, "omp", "default", "plugin", "install", "--force", id],
			"match OMP": [home, "claude", "plugin", "update", id],
			"disable in OMP": [home, "omp", "default", "plugin", "disable", "--scope", "user", id],
			"disable in Claude": [home, "claude", "plugin", "disable", id],
		});
	});

	test("malformed JSON: exit 2 naming the file", () => {
		const f = fixture("cli-malformed");
		put(f.omp, "{ not json");
		const r = run(f);
		expect(r.code).toBe(2);
		expect(r.err).toContain(f.omp);
		// The real process exits 2 too.
		const p = Bun.spawnSync(["bun", join(REPO, "surface", "scripts", "plugin-registries.ts"), "check", "--cwd", f.proj], { env: { PATH: process.env.PATH ?? "", HOME: f.home }, stdout: "pipe", stderr: "pipe" });
		expect(p.exitCode).toBe(2);
		expect(p.stderr.toString()).toContain(f.omp);
	});
});

describe("bin/as2 runs the check before an orchestrator start", () => {
	/** bin/as2 under sh with HOME at the fixture and nothing else inherited; `--print` and `plugins` never start omp. */
	const as2 = (f: Fixture, ...args: string[]) => {
		const r = Bun.spawnSync(["sh", join(REPO, "bin", "as2"), ...args], { cwd: REPO, env: { PATH: process.env.PATH ?? "", HOME: f.home }, stdout: "pipe", stderr: "pipe" });
		return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
	};
	const prompt = (f: Fixture) => join(f.home, ".agent-system-2", "orchestrator", "system.md");

	test("a disagreement: --print and plugins exit 1 with the plugin line, print no command line and render no prompt", () => {
		const f = fixture("as2-disagree");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("2.0.0")]));
		const line = `  ${ID}: OMP 2.0.0 (${f.omp}) vs Claude 1.0.0 (${f.claude})`;
		for (const args of [["--print"], ["plugins"]]) {
			const r = as2(f, ...args);
			expect({ args, code: r.code, out: r.out }).toEqual({ args, code: 1, out: "" });
			expect(r.err.split("\n")).toContain(line);
		}
		expect(existsSync(prompt(f))).toBe(false);
	});

	test("agreeing or absent registries: --print prints the omp line; plugins exits 0 silently", () => {
		const f = fixture("as2-agree");
		put(f.claude, registry([at("1.0.0")]));
		put(f.omp, registry([at("1.0.0")]));
		for (const g of [f, fixture("as2-absent")]) {
			const r = as2(g, "--print");
			expect(r.code).toBe(0);
			expect(r.out).toContain(` omp --cwd ${REPO} --append-system-prompt ${prompt(g)}`);
			expect(as2(g, "plugins")).toEqual({ code: 0, out: "", err: "" });
		}
	});
});
