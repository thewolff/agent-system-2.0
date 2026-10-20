// The plugin-registry disagreement check (PLAN wl-mv8k0fby51uakg D7, jo-issues#51): which plugin ids an OMP session
// started in `cwd` takes from an OMP registry while Claude Code's registry holds an active entry for the same id at a
// different version. `as2` start refuses on any (bin/as2 `check_plugins`, surface/scripts/plugin-registries.ts).
//
// The precedence is OMP's own, copied from pi-coding-agent@18.8.6 src/discovery/helpers.ts `listClaudePluginRoots`
// (with `resolveActiveProjectRegistryPath`, `readClaudeEnabledPlugins` and `parseClaudePluginsRegistry` beside it):
//   1. Claude's `<claudeDir>/plugins/installed_plugins.json`: an entry without a string installPath, or with
//      `enabled: false`, is skipped; a `false` in the merged `enabledPlugins` settings skips it; a project or local
//      entry counts only when its canonical projectPath is the active project's, or an `enabledPlugins` `true` opts
//      it in; a user entry counts otherwise.
//   2. An OMP user registry entry list for an id replaces every Claude entry for that id (any scope).
//   3. The project OMP registry found by OMP's walk from the cwd replaces both for the ids it lists.
// Each OMP session checked is resolved as OMP 18.8.6 resolves its own (`ompSession`): the default profile's, and the
// active profile's when one is set, each with its user registry at `getPluginsDir()` (pi-utils@18.8.6 src/dirs.ts):
// `<data root>/plugins/installed_plugins.json`, where the data root is `$XDG_DATA_HOME/omp` (default profile) or
// `$XDG_DATA_HOME/omp/profiles/<name>` (named profile) when that directory exists on Linux or macOS and the agent dir
// is the profile's own (`DirResolver`), else the legacy `<home>/<configDir>[/profiles/<name>]`. That resolver is the one
// OMP rebuilds after its dotenv load, in OMP's order (`ompSession`): cli.ts `runCli` calls `setProfile` before
// importing pi-utils@18.8.6 src/env.ts; env.ts fills unset keys from the dotenv files that resolver's agent dir and
// config root name, then `refreshDirsFromEnv` recomputes the agent-dir override, config root and XDG root from the
// filled env. The session's cwd stands for OMP's process cwd. Bun's own autoload of `.env.local` / `.env.<NODE_ENV>`
// is not followed.
//
// HOME, env and cwd are parameters, so tests run on fixture homes; the module reads files and writes nothing.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export interface RegistryInputs {
	home: string;
	env: Record<string, string | undefined>;
	cwd: string;
}

export interface Disagreement {
	id: string;
	ompVersion: string;
	ompPath: string;
	claudeVersion: string;
	claudePath: string;
}

/** A registry file that holds text but not a registry OMP would read (bad JSON, or no numeric version / plugins map). */
export class MalformedRegistryError extends Error {
	constructor(readonly path: string) {
		super(`malformed plugin registry: ${path}`);
		this.name = "MalformedRegistryError";
	}
}

interface Entry {
	scope?: unknown;
	installPath?: unknown;
	version?: unknown;
	enabled?: unknown;
	projectPath?: unknown;
}

interface Root {
	id: string;
	version: string;
	installPath: string;
	/** The registry file the entry came from. */
	registry: string;
	origin: "claude" | "omp";
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Claude's config dir: `CLAUDE_CONFIG_DIR` (trimmed, resolved) or `<home>/.claude` (src/config/claude-paths.ts `resolveClaudePaths`). */
export function claudeConfigDir(home: string, env: RegistryInputs["env"]): string {
	const override = env.CLAUDE_CONFIG_DIR?.trim();
	return override ? resolve(override) : join(home, ".claude");
}

/** A profile name, or undefined for the default (pi-utils@18.8.6 src/dirs.ts `normalizeProfileName`); an invalid name counts as none. */
function profileName(value: string | undefined): string | undefined {
	const name = value?.trim();
	if (!name || name === "default" || name.endsWith(".") || !PROFILE_NAME_RE.test(name) || WINDOWS_RESERVED_BASENAME_RE.test(name)) return undefined;
	return name;
}

/** The active OMP profile, or undefined for the default (pi-utils@18.8.6 src/dirs.ts `resolveProfileEnv`). */
export function activeProfile(env: RegistryInputs["env"]): string | undefined {
	return profileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
}

/** `<home>/<configDir>[/profiles/<profile>]`, configDir `PI_CONFIG_DIR` or `.omp` (pi-utils@18.8.6 src/dirs.ts `getProfileConfigRoot`). */
function profileRoot(home: string, env: RegistryInputs["env"], profile: string | undefined): string {
	const root = join(home, env.PI_CONFIG_DIR || ".omp");
	return profile ? join(root, "profiles", profile) : root;
}

/** pi-utils@18.8.6 src/env.ts `parseEnvFile`: shell-identifier keys with NUL-free values, `OMP_X` copied to `PI_X`; {} when unreadable. */
function parseEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
			if (value !== undefined && ENV_NAME_RE.test(key) && !value.includes("\0")) out[key] = value;
		}
	} catch {
		// missing or unreadable: no keys
	}
	for (const key of Object.keys(out)) if (key.startsWith("OMP_")) out[`PI_${key.slice(4)}`] = out[key]!;
	return out;
}

/** One OMP session the check models: its profile, the env its directory resolver reads, and its user registry. */
export interface OmpSession {
	profile: string | undefined;
	env: RegistryInputs["env"];
	registry: string;
}

/**
 * The agent-dir override a default-profile resolver takes from `env` (pi-utils@18.8.6 src/dirs.ts
 * `resolvePreProfileAgentDir` with `isProfileDerivedAgentDir`): `PI_CODING_AGENT_DIR`, unless it is the agent dir
 * `PI_PROFILE`'s profile derives under env's config dir.
 */
function agentDirOverride(home: string, env: RegistryInputs["env"]): string | undefined {
	const piProfile = profileName(env.PI_PROFILE);
	const value = env.PI_CODING_AGENT_DIR;
	return piProfile !== undefined && value === join(profileRoot(home, env, piProfile), "agent") ? undefined : value;
}

/** The paths a pi-utils@18.8.6 src/dirs.ts `DirResolver` holds that the check reads. */
interface Dirs {
	configRoot: string;
	agentDir: string;
	/** The agent dir is the profile's own `<config root>/agent`: only then does the resolver consult XDG. */
	isOwnAgentDir: boolean;
}

/** pi-utils@18.8.6 src/dirs.ts `DirResolver` under `env`; a named profile takes no override. */
function dirResolver(inputs: RegistryInputs, env: RegistryInputs["env"], profile: string | undefined, override: string | undefined): Dirs {
	const configRoot = profileRoot(inputs.home, env, profile);
	const ownAgentDir = join(configRoot, "agent");
	const agentOverride = profile ? undefined : override;
	const agentDir = agentOverride ? resolve(inputs.cwd, agentOverride) : ownAgentDir;
	return { configRoot, agentDir, isOwnAgentDir: agentDir === ownAgentDir };
}

/**
 * The OMP session `OMP_PROFILE=<profile or default> omp` started in `cwd` would be, as pi-coding-agent@18.8.6 cli.ts
 * `runCli`, pi-utils@18.8.6 src/dirs.ts and src/env.ts build it, in this order:
 *   1. `setProfile` runs before env.ts is imported. A named profile sets `OMP_PROFILE`, `PI_PROFILE` and
 *      `PI_CODING_AGENT_DIR` to its own, and its resolver takes no override. The default profile deletes
 *      `OMP_PROFILE` and `PI_PROFILE`, and keeps `PI_CODING_AGENT_DIR` only when it is not the agent dir `PI_PROFILE`'s
 *      profile derives (the module-load snapshot), its resolver taking that value as its override.
 *   2. env.ts fills each unset key from `<cwd>/.env`, `<agent dir>/.env`, `<config root>/.env`, `<home>/.env`, in
 *      that order, the agent dir and config root being step 1's.
 *   3. `refreshDirsFromEnv` rebuilds the resolver from the filled env: the default profile's override recomputed from
 *      the filled `PI_CODING_AGENT_DIR` and `PI_PROFILE`, the config root from `PI_CONFIG_DIR`, the XDG data root
 *      from `XDG_DATA_HOME`, consulted only when the agent dir is the profile's own.
 * `getPluginsDir()` is then `<data root>/plugins`.
 */
export function ompSession(inputs: RegistryInputs, profile: string | undefined): OmpSession {
	const { home, cwd } = inputs;
	const launch: RegistryInputs["env"] = { ...inputs.env, OMP_PROFILE: profile ?? "default" };

	const env: RegistryInputs["env"] = { ...launch };
	const preProfile = profile ? undefined : agentDirOverride(home, launch);
	const load = dirResolver(inputs, launch, profile, preProfile);
	if (profile) {
		Object.assign(env, { OMP_PROFILE: profile, PI_PROFILE: profile, PI_CODING_AGENT_DIR: load.agentDir });
	} else {
		delete env.OMP_PROFILE;
		delete env.PI_PROFILE;
		if (preProfile === undefined) delete env.PI_CODING_AGENT_DIR;
		else env.PI_CODING_AGENT_DIR = preProfile;
	}

	for (const file of [join(cwd, ".env"), join(load.agentDir, ".env"), join(load.configRoot, ".env"), join(home, ".env")]) {
		for (const [key, value] of Object.entries(parseEnvFile(file))) if (!env[key]) env[key] = value;
	}

	const dirs = dirResolver(inputs, env, profile, profile ? undefined : agentDirOverride(home, env));
	let dataRoot = dirs.configRoot;
	if ((process.platform === "linux" || process.platform === "darwin") && dirs.isOwnAgentDir && env.XDG_DATA_HOME) {
		const appRoot = join(env.XDG_DATA_HOME, "omp");
		const xdgRoot = profile ? join(appRoot, "profiles", profile) : appRoot;
		if (exists(xdgRoot)) dataRoot = xdgRoot;
	}
	return { profile, env, registry: join(dataRoot, "plugins", "installed_plugins.json") };
}

/** The OMP sessions to check: the default profile's, then the active profile's when one is set. */
export function ompSessions(inputs: RegistryInputs): OmpSession[] {
	const profile = activeProfile(inputs.env);
	return profile ? [ompSession(inputs, undefined), ompSession(inputs, profile)] : [ompSession(inputs, undefined)];
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/** pi-utils@18.8.6 src/dirs.ts `normalizePathForComparison` on a POSIX host: the real path, else the resolved one. */
function normalize(path: string): string {
	const resolved = resolve(path);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/** src/discovery/helpers.ts `canonicalClaudeProjectPath`: the real path, or null when it does not exist. */
function canonical(path: string): string | null {
	try {
		return realpathSync(resolve(path));
	} catch {
		return null;
	}
}

/** src/capability/fs.ts `readFile`: a regular file's text, or null for anything missing, unreadable or not a file. */
function readText(path: string): string | null {
	try {
		if (!statSync(path).isFile()) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * A registry's plugins map, as `parseClaudePluginsRegistry` accepts it: null for no entries (missing, unreadable or
 * empty file); a file with text OMP would reject throws MalformedRegistryError.
 */
function readRegistry(path: string): Record<string, unknown> | null {
	const content = readText(path);
	if (!content) return null;
	let data: unknown;
	try {
		data = JSON.parse(content);
	} catch {
		throw new MalformedRegistryError(path);
	}
	if (!data || typeof data !== "object" || !("version" in data) || !("plugins" in data)) throw new MalformedRegistryError(path);
	const { version, plugins } = data;
	if (typeof version !== "number" || !plugins || typeof plugins !== "object" || Array.isArray(plugins)) throw new MalformedRegistryError(path);
	return Object.fromEntries(Object.entries(plugins));
}

/**
 * src/discovery/helpers.ts `resolveActiveProjectRegistryPath`, with HOME a parameter: the nearest ancestor of cwd
 * (stopping before home) holding a `<configDir>` directory, else the nearest holding `.git`, as
 * `<dir>/<configDir>/plugins/installed_plugins.json`; null when neither is found. `isUserConfigRoot` excludes home's
 * config root and `userRoot`, the session's user registry root (`dirname(getPluginsDir())`).
 */
export function projectRegistryPath(cwd: string, home: string, env: RegistryInputs["env"], userRoot: string): string | null {
	const name = env.PI_CONFIG_DIR || ".omp";
	const homeDir = normalize(home);
	const excluded = new Set([normalize(join(home, name)), normalize(userRoot)]);
	const isUserConfigRoot = (dir: string) => excluded.has(normalize(join(dir, name)));
	for (const marker of [name, ".git"]) {
		let dir = resolve(cwd);
		while (normalize(dir) !== homeDir) {
			const found = marker === name ? isDir(join(dir, marker)) : exists(join(dir, marker));
			if (found && !isUserConfigRoot(dir)) return join(dir, name, "plugins", "installed_plugins.json");
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

/** src/discovery/helpers.ts `readClaudeEnabledPlugins`: `enabledPlugins` booleans merged, later files winning; bad files skipped. */
function readEnabledPlugins(claudeDir: string, projectDirs: readonly string[]): Map<string, boolean> {
	const enabled = new Map<string, boolean>();
	const files = [join(claudeDir, "settings.json")];
	for (const dir of projectDirs) files.push(join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json"));
	for (const file of files) {
		const content = readText(file);
		if (!content) continue;
		let data: unknown;
		try {
			data = JSON.parse(content);
		} catch {
			continue;
		}
		if (!data || typeof data !== "object" || !("enabledPlugins" in data)) continue;
		const map = data.enabledPlugins;
		if (!map || typeof map !== "object" || Array.isArray(map)) continue;
		for (const [id, value] of Object.entries(map)) if (typeof value === "boolean") enabled.set(id, value);
	}
	return enabled;
}

/** The usable entries of one registry id: an array with at least one entry, under an id holding `@`; else null. */
function entriesOf(id: string, value: unknown): Entry[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	if (id.lastIndexOf("@") === -1) return null;
	return value.filter((e): e is Entry => !!e && typeof e === "object");
}

const versionOf = (entry: Entry): string => (typeof entry.version === "string" && entry.version ? entry.version : "unknown");

/** The disagreements an OMP session in `cwd` would carry, for every OMP session checked (`ompSessions`). Throws MalformedRegistryError. */
export function findDisagreements(inputs: RegistryInputs): Disagreement[] {
	const { home, cwd } = inputs;
	const out: Disagreement[] = [];
	const seen = new Set<string>();
	for (const session of ompSessions(inputs)) {
		const claudeDir = claudeConfigDir(home, session.env);
		const claudePath = join(claudeDir, "plugins", "installed_plugins.json");
		const claudePlugins = readRegistry(claudePath);
		const projectFound = projectRegistryPath(cwd, home, session.env, dirname(dirname(session.registry)));
		const projectPath = projectFound && normalize(projectFound) !== normalize(session.registry) ? projectFound : null;
		const projectRoot = projectPath ? dirname(dirname(dirname(projectPath))) : cwd;
		const activeProject = canonical(projectRoot);
		const canonicalCwd = canonical(cwd);
		const settingsDirs = [...new Set([activeProject, canonicalCwd].filter((d): d is string => !!d))];
		const overrides = readEnabledPlugins(claudeDir, settingsDirs);

		// 1. Claude's active entries.
		const claude: Root[] = [];
		for (const [id, value] of Object.entries(claudePlugins ?? {})) {
			const entries = entriesOf(id, value);
			if (!entries) continue;
			for (const entry of entries) {
				if (typeof entry.installPath !== "string" || !entry.installPath) continue;
				if (entry.enabled === false) continue;
				const override = overrides.get(id);
				if (override === false) continue;
				if ((entry.scope === "local" || entry.scope === "project") && override !== true) {
					if (typeof entry.projectPath !== "string" || !entry.projectPath || !activeProject) continue;
					if (canonical(entry.projectPath) !== activeProject) continue;
				}
				claude.push({ id, version: versionOf(entry), installPath: entry.installPath, registry: claudePath, origin: "claude" });
			}
		}

		// 2. The OMP user registry replaces Claude's entries for every id it lists.
		let roots: Root[] = [...claude];
		for (const [id, value] of Object.entries(readRegistry(session.registry) ?? {})) {
			const entries = entriesOf(id, value);
			if (!entries) continue;
			roots = roots.filter((r) => r.id !== id);
			for (const entry of entries) {
				if (typeof entry.installPath !== "string" || !entry.installPath) continue;
				if (entry.enabled === false) continue;
				if (roots.some((r) => r.id === id && r.installPath === entry.installPath)) continue;
				roots.push({ id, version: versionOf(entry), installPath: entry.installPath, registry: session.registry, origin: "omp" });
			}
		}

		// 3. The project OMP registry shadows both for the ids it supplies.
		if (projectPath) {
			const project: Root[] = [];
			for (const [id, value] of Object.entries(readRegistry(projectPath) ?? {})) {
				const entries = entriesOf(id, value);
				if (!entries) continue;
				for (const entry of entries) {
					if (typeof entry.installPath !== "string" || !entry.installPath) continue;
					if (entry.enabled === false) continue;
					project.push({ id, version: versionOf(entry), installPath: entry.installPath, registry: projectPath, origin: "omp" });
				}
			}
			if (project.length > 0) {
				const ids = new Set(project.map((r) => r.id));
				roots = [...project, ...roots.filter((r) => !ids.has(r.id))];
			}
		}

		for (const omp of roots) {
			if (omp.origin !== "omp") continue;
			for (const c of claude) {
				if (c.id !== omp.id || c.version === omp.version) continue;
				const key = JSON.stringify([omp.id, omp.version, omp.registry, c.version, claudePath]);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ id: omp.id, ompVersion: omp.version, ompPath: omp.registry, claudeVersion: c.version, claudePath });
			}
		}
	}
	return out;
}

/** One shell word for `arg`: as is when it holds only characters no POSIX shell treats specially, else single-quoted, each `'` written `'\''`. */
function shellQuote(arg: string): string {
	return /^[A-Za-z0-9@%+=:,./_-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * The commands that settle one disagreement, every argument shell-quoted. The match commands reinstall one side from
 * its marketplace, which takes no version: OMP's `name@marketplace` installs the catalog's current version, and
 * `--force` is needed over an existing install (pi-coding-agent@18.8.6 src/cli/classify-install-target.ts
 * `classifyInstallTarget` reads a trailing `@<version>` as an npm spec; src/extensibility/plugins/marketplace/manager.ts
 * `#validateInstall` refuses an installed id without force), so either can land on a version other than the one shown.
 * The disable commands are deterministic: `omp plugin disable --scope <scope>` writes `enabled: false` on every entry
 * of the id in that scope's registry (src/cli/plugin-cli.ts `handleSetEnabled`, manager.ts `setPluginEnabled`), and
 * `claude plugin disable` writes `enabledPlugins: { <id>: false }` to Claude's settings for the scope it detects (seen
 * on Claude Code 2026-10-20; it refuses with "already disabled" when no setting enables the id). `findDisagreements`,
 * like OMP, skips a disabled entry, so Claude's, once it succeeds, leaves the id no Claude entry to compare. OMP's
 * removes only that registry's entry: a lower-precedence OMP entry for the id (the user registry's, under a project
 * one) then counts, as in src/discovery/helpers.ts, and can disagree in its own right. The profile is named so the
 * command writes the registry that disagrees; `default` selects the default profile (pi-utils@18.8.6 src/dirs.ts
 * `normalizeProfileName`).
 */
export function fixCommands(d: Disagreement, inputs: RegistryInputs): { omp: string; claude: string; ompDisable: string; claudeDisable: string } {
	const id = shellQuote(d.id);
	const session = ompSessions(inputs).find((s) => s.registry === d.ompPath);
	if (session) {
		const omp = `OMP_PROFILE=${shellQuote(session.profile ?? "default")} omp plugin`;
		return { omp: `${omp} install --force ${id}`, claude: `claude plugin update ${id}`, ompDisable: `${omp} disable --scope user ${id}`, claudeDisable: `claude plugin disable ${id}` };
	}
	const cd = `cd ${shellQuote(dirname(dirname(dirname(d.ompPath))))} &&`;
	return {
		omp: `(${cd} omp plugin install --force --scope project ${id})`,
		claude: `(${cd} claude plugin update ${id})`,
		ompDisable: `(${cd} omp plugin disable --scope project ${id})`,
		claudeDisable: `(${cd} claude plugin disable ${id})`,
	};
}
