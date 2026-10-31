// The OMP host surface this repo's extensions read settings through, pinned to the host version it
// was verified on. OMP 18.4.4 removed `Settings.get(key)`: a setting is read
// through its registered handle (`config/registry.ts lookup(id)` → `Setting.get(settings)`, the
// host's own runner does `cfgExtensionHandlersToolCallTimeoutMs.get(this.settings)` at
// extensibility/extensions/runner.ts:1787), and an unknown key such as `gates.fence.enabled` stays in
// the raw global layer (`getGlobalSettings()`, config/settings.ts:1481-1484: the parsed config.yml
// after migration, nothing stripped; settings.ts:1896-1916). The fence called `s.get(...)` and every
// bash call in a freshly launched `as2` was refused fail-closed, with nothing saying the host had
// moved (Jo ran `omp update` mid-session). So: every host member the extensions depend on is listed
// once here (HOST_MEMBERS, checked by gates/test/host.test.ts against the installed host), the
// reads go through this module only, and a host whose major.minor is not VERIFIED_HOST is refused
// with a line naming both versions before any member is touched.
//
// No OMP import here: the entry files (gates/index.ts, classifier/extension.ts) do the bare
// `@oh-my-pi/*` imports, because OMP's legacy-pi-compat serves the host's in-process module only
// to modules reached from the extension entry by relative imports (M4b classifier-host probe), and
// hand the modules in as a HostModules value.

/** The OMP major.minor the members below were verified on. Bump it after re-running gates/test/host.test.ts on the new host. */
export const VERIFIED_HOST = "18.12";

/** A host member that is missing, differently shaped, or on an unverified host version. */
export class HostError extends Error {}

/** A registered setting's handle (config/registry.ts `Setting`): `get(settings)` is the effective value, default included. */
export interface HostSettingHandle {
	get(settings: HostSettingsInstance): unknown;
}

/** An OMP `Settings` instance: the raw global layer is the only thing read directly (unknown keys live there). */
export interface HostSettingsInstance {
	getGlobalSettings(): Record<string, unknown>;
}

/** OMP's `Settings` class (config/settings.ts): the two statics the extensions use. */
export interface HostSettingsClass {
	/** The running session's live instance (18.4.4: a static getter, `Promise<Settings> | null`). */
	readonly current?: Promise<HostSettingsInstance> | HostSettingsInstance | null;
	/** The disk read, for a host that has not initialised the live instance. */
	loadReadOnly(o: { cwd: string }): Promise<HostSettingsInstance>;
}

/** The host modules an entry file imports and hands in. */
export interface HostModules {
	/** `@oh-my-pi/pi-utils/dirs` VERSION: the running host's package version. */
	version: unknown;
	/** `@oh-my-pi/pi-coding-agent/config/settings` Settings. */
	Settings: HostSettingsClass;
	/** `@oh-my-pi/pi-coding-agent/config/registry` lookup: the handle registered for a setting id. */
	lookup(id: string): HostSettingHandle | undefined;
}

/**
 * Every host member the gates and the classifier depend on, by module and dotted member (`Class.static`,
 * `Class#method` for an instance member, `fn(id).member` for a returned value's member,
 * `Class#method().member` for a member of what a bare instance's method returns). The pin test
 * checks each against the installed host, so the next `omp update` that moves one fails there, in one
 * place, before it fails at the first bash call.
 */
export const HOST_MEMBERS: readonly { module: string; member: string; kind: "string" | "function" | "static-getter" }[] = [
	{ module: "@oh-my-pi/pi-utils/dirs", member: "VERSION", kind: "string" },
	{ module: "@oh-my-pi/pi-utils", member: "getAgentDir", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/config/settings", member: "Settings.current", kind: "static-getter" },
	{ module: "@oh-my-pi/pi-coding-agent/config/settings", member: "Settings.loadReadOnly", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/config/settings", member: "Settings#getGlobalSettings", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/config/registry", member: "lookup", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/config/registry", member: "lookup(id).get", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/judgment/index", member: "resolveJudge", kind: "function" },
	// The extension context's lifecycle members the surface's rows call (surface/src/types.ts Ctx; Codex review S6):
	// `ctx.shutdown` ends the session from lane_release / lane_handoff, `ctx.setInterval` / `ctx.clearTimer` run the lease renewal
	// and the orchestrator's poll, `ctx.setTimeout` pushes a pending wake after session_start / session_compact (MIGRATION.md item 37).
	{ module: "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner", member: "ExtensionRunner#createContext().shutdown", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner", member: "ExtensionRunner#createContext().setInterval", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner", member: "ExtensionRunner#createContext().setTimeout", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner", member: "ExtensionRunner#createContext().clearTimer", kind: "function" },
	// The certified shell start (gates/src/shell-start.ts, workload wl-mv5lrh0drbg0zk): the bash tool's shell config, the
	// per-command env OMP's executor adds, and the CLI's own argv reading (whether the process runs over ACP).
	{ module: "@oh-my-pi/pi-coding-agent/config/settings", member: "Settings#getShellConfig", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/exec/non-interactive-env", member: "buildNonInteractiveEnv", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/cli/args", member: "parseArgs", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/cli-commands", member: "resolveCliArgv", kind: "function" },
	{ module: "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap", member: "extractProfileFlags", kind: "function" },
	// `ctx.getSystemPrompt` tells the surface at session_start that bin/as2 put the voice and the contract in the base prompt (surface/extensions/wake.ts).
	{ module: "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner", member: "ExtensionRunner#createContext().getSystemPrompt", kind: "function" },
];

/** The setting ids the extensions read through handles; each must be registered by the host. */
export const HOST_SETTING_IDS = ["bash.autoBackground.enabled", "disabledProviders", "bash.direnv"] as const;

const majorMinor = (version: string): string | null => {
	const m = /^(\d+)\.(\d+)\.\d+/.exec(version);
	return m ? `${m[1]}.${m[2]}` : null;
};

/** Throws unless `version` is a string whose major.minor is VERIFIED_HOST. */
export function checkHostVersion(version: unknown): string {
	if (typeof version !== "string" || majorMinor(version) === null) {
		throw new HostError(`the running OMP's version could not be read (@oh-my-pi/pi-utils/dirs VERSION is ${JSON.stringify(version)}); the gates were verified on OMP ${VERIFIED_HOST}`);
	}
	if (majorMinor(version) !== VERIFIED_HOST) {
		throw new HostError(
			`the running OMP is ${version} and the gates were verified on OMP ${VERIFIED_HOST} (gates/src/host.ts VERIFIED_HOST); re-run gates/test/host.test.ts against this host and bump the pin before trusting its settings reads`,
		);
	}
	return version;
}

const missing = (version: string, module: string, member: string, found: unknown): HostError =>
	new HostError(`OMP ${version}: ${member} is missing from ${module} (found ${found === null ? "null" : typeof found}); the gates were verified on OMP ${VERIFIED_HOST} with it present`);

/**
 * The host's settings instance for a session: the live one when the host has initialised it, else the
 * disk read from `cwd`. Checks the version and every member on the way, so a moved host names what moved.
 */
export async function hostSettings(host: HostModules, cwd: string): Promise<HostSettingsInstance> {
	const version = checkHostVersion(host.version);
	const { Settings } = host;
	if (!Settings || typeof Settings !== "function" && typeof Settings !== "object") throw missing(version, "@oh-my-pi/pi-coding-agent/config/settings", "Settings", Settings);
	if (!("current" in Settings)) throw missing(version, "@oh-my-pi/pi-coding-agent/config/settings", "Settings.current", undefined);
	if (typeof Settings.loadReadOnly !== "function") throw missing(version, "@oh-my-pi/pi-coding-agent/config/settings", "Settings.loadReadOnly", Settings.loadReadOnly);
	if (typeof host.lookup !== "function") throw missing(version, "@oh-my-pi/pi-coding-agent/config/registry", "lookup", host.lookup);
	const instance = await (Settings.current ?? Settings.loadReadOnly({ cwd }));
	if (!instance || typeof instance.getGlobalSettings !== "function") {
		throw missing(version, "@oh-my-pi/pi-coding-agent/config/settings", "Settings#getGlobalSettings", instance ? instance.getGlobalSettings : instance);
	}
	return instance;
}

/** The effective value of the registered setting `id` in `instance`, the way the host reads its own. */
export function readSetting(host: HostModules, instance: HostSettingsInstance, id: string): unknown {
	const version = typeof host.version === "string" ? host.version : String(host.version);
	const handle = host.lookup(id);
	if (!handle) throw missing(version, "@oh-my-pi/pi-coding-agent/config/registry", `lookup(${JSON.stringify(id)})`, handle);
	if (typeof handle.get !== "function") throw missing(version, "@oh-my-pi/pi-coding-agent/config/registry", `lookup(${JSON.stringify(id)}).get`, handle.get);
	return handle.get(instance);
}

/** The value at `path` in the raw global layer: where a key OMP has no registration for (`gates.fence.enabled`) is kept as written. */
export function unknownSetting(instance: HostSettingsInstance, path: readonly string[]): unknown {
	let cur: unknown = instance.getGlobalSettings();
	for (const seg of path) {
		if (!cur || typeof cur !== "object" || !(seg in cur)) return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}
