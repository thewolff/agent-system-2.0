// The certified initial shell state of a gated bash call (workload wl-mv5lrh0drbg0zk, PLAN.md
// revision 7 § 2.2 as revision 8 changes it, contract C1-C6 in § 3). `shellStart` says, per call and
// never cached, whether the call's typed command starts from a state this module can name: the
// embedded brush Shell of this process (no named service, no PTY, no ACP bridge) running only the
// fence's wrapper, with a shell whose basename is not bash-named (no bash snapshot), no command
// prefix, direnv off, and an env that is exactly `cert.env` = the C environ ⊕ OMP's `shell.env` ⊕
// `buildNonInteractiveEnv()` and carries no shell start hook. It certifies only sessions the
// clean-shell switch (src/clean-shell.ts, `gates.cleanShell`) is on for; off, it returns
// `certified: false` naming the switch. The fence (fence.ts registerFence) refuses every call this
// does not certify in a session the switch is on for; item 100's rows read `certified` before
// relaxing anything.
//
// Why each condition (PLAN.md § 1):
// - A named call runs in the project's daemon broker, a separate process whose env the gates can
//   neither read nor bind to the call (§ 1.2 item 1), so it is refused; the reason says what to use.
// - The brush Shell hands the wrapper's child the process's C environ, overlaid with `sessionEnv`
//   (`shell.env`) and the run env (§ 1.7, measured). `Bun.env` edits never reach the C environ, so it
//   is read here through bun:ffi `_NSGetEnviron`, into a Map (no prototype key lost: a `__proto__`
//   entry is kept), failing on an entry without `=`. Brush reads it when a Shell is constructed, and
//   the session's persistent Shell may be older than this call: the environ is captured once when
//   the gates are first evaluated (E0, gates/index.ts), and a call whose environ differs from E0 is
//   refused, so any Shell built since the gates loaded saw E0.
// - OMP reuses the persistent Shell whose key (`shell.env` sorted, `key=value` joined by `\n`)
//   matches; with a `\n` in a value two different `shell.env`s can share a key (OpenAI r5 B1), so a
//   newline value is refused and a reused Shell was built from the current `shell.env`.
// - `/bin/bash` and `/bin/sh` take hooks from the env at start (§ 1.4, pinned by
//   gates/test/shell-start-bash.test.ts): SHELL_START_HOOK_NAMES, `BASH_FUNC_<f>%%` functions, and a
//   name whose value starts `() {`. A name that is not a shell identifier is refused too: bash may
//   read one as a function, and no rule can reason about a name the shell cannot spell.
// - OMP loads a snapshot of the user's rc only for a shell whose basename contains `bash` (§ 1.3,
//   exec/bash-executor.ts isBashShell); `/bin/sh` and `/bin/zsh` load none. The profile sets no
//   `shellPath` (revision 8: no global change), so a bash-named shell is refused, naming the remedy.
// - A `pty: true` call runs a PTY login shell when the process has a UI and PI_NO_PTY is not 1
//   (tools/bash-pty-selection.ts); the launchers no longer set PI_NO_PTY (revision 8), so such a call
//   is refused unless the process carries PI_NO_PTY=1.
//
// Host members (OMP's Settings, settings registry, `getAgentDir`, `buildNonInteractiveEnv`,
// `parseArgs`, the CLI's argv resolution) are handed in by gates/index.ts (src/host.ts explains why
// this module never imports OMP itself) and listed in HOST_MEMBERS, so host.test.ts checks them
// against the installed OMP. The one file read is the switch's (the profile config, src/clean-shell.ts);
// nothing here starts a process, and `shellStart` never throws.
import { CString, dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { cleanShellFromHost, cleanShellOffReason, cleanShellOn } from "./clean-shell";
import { FENCE_FLAG } from "./fence";
import { HostError, type HostModules, type HostSettingsInstance, hostSettings, readSetting, unknownSetting } from "./host";
import type { Ctx } from "./session";
import { WORKLOAD_ENV } from "./types";

/**
 * The exact OMP version the facts in PLAN.md § 1 were measured on. The runtime check stays at
 * major.minor (host.ts VERIFIED_HOST); gates/test/host.test.ts fails when the installed OMP differs
 * from this, so a patch bump is re-measured (gates/test/shell-start-bash.test.ts) before it is trusted.
 */
export const MEASURED_HOST = "18.8.6";

/**
 * Names `/bin/bash` or `/bin/sh` read at start (PLAN.md § 1.4): a file to source, options, posix mode,
 * `cd`'s search path, the trace prefix. The launchers drop them from the env they hand omp (bin/as2,
 * surface/src/launch.ts laneEnv; gates/test/shell-start.test.ts pins both lists to this one), and a
 * call whose `cert.env` still carries one is refused.
 */
export const SHELL_START_HOOK_NAMES = ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "POSIXLY_CORRECT", "CDPATH", "PS4"] as const;

/** The refusal of a named call (PLAN.md § 2.2 item 4): what to run instead. */
export const NAMED_CALL_REASON =
	"a named bash call (`name`) runs as a service in OMP's daemon broker, a separate process whose environment the gates cannot certify, so named calls are refused: run long jobs with `async: true` (and `timeout: 0` for no deadline) and poll readiness with a command";

/** A C environ read: every entry by name, or why the read is not a complete snapshot. */
export type EnvironRead = { ok: true; env: ReadonlyMap<string, string> } | { ok: false; error: string };

/** What `shellStart` returns (contract C1): `env` is `cert.env`, present only when certified. */
export interface ShellStart {
	certified: boolean;
	env?: ReadonlyMap<string, string>;
	reasons: string[];
}

/** An OMP `Settings` instance as this module reads it: the raw layer, and the bash tool's shell config. */
export interface ShellStartSettingsInstance extends HostSettingsInstance {
	getShellConfig?(): unknown;
}

/** The host members `shellStart` reads beyond the settings ones (gates/index.ts shellStartHost). */
export interface ShellStartHost extends HostModules {
	/** `@oh-my-pi/pi-utils` getAgentDir: where the profile config holding the clean-shell switch is. */
	getAgentDir: unknown;
	/** `@oh-my-pi/pi-coding-agent/exec/non-interactive-env` buildNonInteractiveEnv: the per-command env OMP's bash executor adds. */
	buildNonInteractiveEnv: unknown;
	/** `@oh-my-pi/pi-coding-agent/cli/args` parseArgs: the launch command's parser. */
	parseArgs: unknown;
	/** `@oh-my-pi/pi-coding-agent/cli-commands` resolveCliArgv: which command OMP's CLI runs for an argv. */
	resolveCliArgv: unknown;
	/** `@oh-my-pi/pi-coding-agent/cli/profile-bootstrap` extractProfileFlags: what the CLI strips before resolving. */
	extractProfileFlags: unknown;
}

/** This process as `shellStart` reads it. Tests hand in their own; production reads the live one. */
export interface ShellStartProcess {
	/** The C environ now (E). */
	environ(): EnvironRead;
	/** The C environ when the gates were first evaluated (E0), or null when it was never captured. */
	gateLoad(): EnvironRead | null;
	/** The CLI arguments OMP's entry resolved (its `process.argv.slice(2)`). */
	argv(): readonly string[];
	/** The process env: OMP's bash tool reads `PI_NO_PTY` from it, and the switch reads the session's workload id. */
	env(): Readonly<Record<string, string | undefined>>;
}

/** A shell identifier: the only names bash exports as variables and the only names a rule can spell. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The bash 3.2 exported-function encoding (`BASH_FUNC_<name>%%`), matched by prefix. */
const FUNC_PREFIX = "BASH_FUNC_";
/** A value bash may read as a function definition. */
const FUNC_VALUE = "() {";
/** Where OMP fills `Bun.env` from, after the launch env (pi-utils env.ts; PLAN.md § 1.6). */
const DOTENV_FILES = "`~/.env`, `<configRoot>/.env` or `<agentDir>/.env`";
/** No real environ is this long; a walk that gets here has lost the terminating null. */
const MAX_ENTRIES = 1 << 16;

/** The entries of a C environ, by name; fails on an entry without `=` or a name that appears twice. */
export function parseEnviron(entries: Iterable<string>): EnvironRead {
	const env = new Map<string, string>();
	let i = 0;
	for (const entry of entries) {
		const eq = entry.indexOf("=");
		// The entry itself is not quoted: without `=` there is no telling a name from a value.
		if (eq < 0) return { ok: false, error: `environ entry ${i} has no '='` };
		const name = entry.slice(0, eq);
		if (env.has(name)) return { ok: false, error: `the name ${JSON.stringify(name)} appears twice` };
		env.set(name, entry.slice(eq + 1));
		i++;
	}
	return { ok: true, env };
}

type LibSystem = { symbols: { _NSGetEnviron(): Pointer | null } };
let libSystem: LibSystem | null = null;

/** This process's C environ, read through `_NSGetEnviron` (libSystem): an in-process memory read, no process started. */
export function readCEnviron(): EnvironRead {
	try {
		if (process.platform !== "darwin") return { ok: false, error: `_NSGetEnviron is macOS's and this is ${process.platform}` };
		libSystem ??= dlopen("/usr/lib/libSystem.B.dylib", { _NSGetEnviron: { args: [], returns: FFIType.ptr } }) as unknown as LibSystem;
		const environPtr = libSystem.symbols._NSGetEnviron();
		if (!environPtr) return { ok: false, error: "_NSGetEnviron returned null" };
		const envp = read.ptr(environPtr, 0) as Pointer;
		if (!envp) return { ok: false, error: "environ is null" };
		const entries: string[] = [];
		for (let i = 0; ; i++) {
			if (i >= MAX_ENTRIES) return { ok: false, error: `no terminating null within ${MAX_ENTRIES} environ entries` };
			const p = read.ptr(envp, i * 8) as Pointer;
			if (!p) break;
			entries.push(new CString(p).toString());
		}
		return parseEnviron(entries);
	} catch (err) {
		return { ok: false, error: `the read failed (${err instanceof Error ? err.message : String(err)})` };
	}
}

let gateLoadEnviron: EnvironRead | null = null;

/** E0: called once when the gates module is evaluated (gates/index.ts); a later call keeps the first read. */
export function captureGateLoadEnviron(): EnvironRead {
	gateLoadEnviron ??= readCEnviron();
	return gateLoadEnviron;
}

const LIVE: ShellStartProcess = {
	environ: readCEnviron,
	gateLoad: () => gateLoadEnviron,
	argv: () => process.argv.slice(2),
	env: () => process.env,
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const hostMissing = (host: HostModules, module: string, member: string, found: unknown): string =>
	`OMP ${String(host.version)}: ${member} is missing from ${module} (found ${found === null ? "null" : typeof found}); the gates were verified with it present`;

/** Up to five names, quoted, then a count of the rest. */
function nameList(names: readonly string[]): string {
	const shown = names.slice(0, 5).map((n) => JSON.stringify(n));
	return names.length > 5 ? `${shown.join(", ")} and ${names.length - 5} more` : shown.join(", ");
}

/** The names whose presence or value differs between `a` and `b`. */
function environDiff(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): string[] {
	const out: string[] = [];
	for (const [k, v] of a) if (b.get(k) !== v || !b.has(k)) out.push(k);
	for (const k of b.keys()) if (!a.has(k)) out.push(k);
	return out.sort();
}

/**
 * Why the process runs OMP over ACP (where a bridge backend runs bash in the client's process with the
 * client's env), or null. ACP is entered by `omp acp` or the launch flag `--mode acp`/`--mode=acp`;
 * read the way OMP's CLI reads its argv (cli.ts runCli: extractProfileFlags, then resolveCliArgv, then
 * the launch command's parseArgs), so a subcommand behind leading flags counts too. A process that is
 * not running the launch command, or an argv OMP's own code cannot parse, is not certified.
 */
function acpReason(host: ShellStartHost, argv: readonly string[]): string | null {
	const fns = [
		["@oh-my-pi/pi-coding-agent/cli/profile-bootstrap", "extractProfileFlags", host.extractProfileFlags],
		["@oh-my-pi/pi-coding-agent/cli-commands", "resolveCliArgv", host.resolveCliArgv],
		["@oh-my-pi/pi-coding-agent/cli/args", "parseArgs", host.parseArgs],
	] as const;
	for (const [module, member, fn] of fns) if (typeof fn !== "function") return hostMissing(host, module, member, fn);
	try {
		const extracted = (host.extractProfileFlags as (a: readonly string[]) => { argv: string[] })([...argv]);
		const resolved = (host.resolveCliArgv as (a: string[]) => { argv: string[] } | { error: string })([...extracted.argv]);
		if ("error" in resolved) return `OMP's CLI refuses this process's arguments (${resolved.error}), so whether it runs over ACP cannot be read`;
		const [command, ...rest] = resolved.argv;
		if (command === "acp") return "this process runs `omp acp`, OMP's ACP server, where bash may run in the client's process with the client's env: as2 never runs over ACP";
		if (command !== "launch") return `this process runs OMP's ${JSON.stringify(command)} command, not launch, so whether it runs over ACP cannot be read`;
		const parsed = (host.parseArgs as (a: string[]) => { mode?: unknown })(rest);
		if (parsed.mode === "acp") return "this process was started with `--mode acp`, where bash may run in the ACP client's process with the client's env: as2 never runs over ACP";
		return null;
	} catch (err) {
		return `this process's arguments could not be parsed the way OMP's CLI parses them (${message(err)}), so whether it runs over ACP cannot be read`;
	}
}

/** `shell.env` and the shell, from the settings instance's `getShellConfig()`, or why not. */
function shellConfig(host: ShellStartHost, settings: ShellStartSettingsInstance): { shell: string; env: Record<string, string>; prefix: string | undefined } | string {
	if (typeof settings.getShellConfig !== "function") return hostMissing(host, "@oh-my-pi/pi-coding-agent/config/settings", "Settings#getShellConfig", settings.getShellConfig);
	const config = settings.getShellConfig() as { shell?: unknown; env?: unknown; prefix?: unknown } | null;
	if (!config || typeof config.shell !== "string" || !config.env || typeof config.env !== "object" || (config.prefix !== undefined && typeof config.prefix !== "string")) {
		return `OMP ${String(host.version)}: Settings#getShellConfig() returned no { shell, env, prefix } of the verified shape`;
	}
	// No prototype: a `__proto__` name is kept as an entry, as in the environ Map.
	const env: Record<string, string> = Object.create(null);
	for (const [k, v] of Object.entries(config.env)) {
		if (typeof v !== "string") return `OMP's shell.env holds ${JSON.stringify(k)} with a ${typeof v} value, not a string`;
		env[k] = v;
	}
	return { shell: config.shell, env, prefix: config.prefix as string | undefined };
}

/** Where a `cert.env` name came from, as the fix the refusal names. */
function hookFix(name: string, environ: ReadonlyMap<string, string>, shellEnv: Record<string, string>): string {
	if (environ.has(name)) return "relaunch as2 from a shell that does not export it";
	if (Object.hasOwn(shellEnv, name)) return `remove it from ${DOTENV_FILES}`;
	return "remove it from where OMP's non-interactive env takes it";
}

/**
 * The start-hook refusals of an env a `/bin/bash` or `/bin/sh` starts with (PLAN.md § 2.2 item 5), naming
 * each name, never a value; `fix` says where a name came from. The bash tool's certificate reads `cert.env`
 * through it, and pair_run (src/pair-call.ts) the env its own `/bin/sh` is spawned with.
 */
export function envHookReasons(env: Iterable<readonly [string, string]>, fix: (name: string) => string): string[] {
	const out: string[] = [];
	// An array lookup, not an object one: env names include `__proto__` and `constructor`.
	const hooks: readonly string[] = SHELL_START_HOOK_NAMES;
	for (const [name, value] of env) {
		if (hooks.includes(name)) out.push(`the env carries ${name}, which /bin/bash or /bin/sh reads at start: ${fix(name)}`);
		else if (name.startsWith(FUNC_PREFIX)) out.push(`the env carries ${JSON.stringify(name)}, a ${FUNC_PREFIX} exported function /bin/bash imports at start: ${fix(name)}`);
		else if (!IDENT.test(name)) out.push(`the env carries the name ${JSON.stringify(name)}, which is not a shell identifier: ${fix(name)}`);
		else if (value.startsWith(FUNC_VALUE)) out.push(`the env's ${name} holds a value starting \`${FUNC_VALUE}\`, which bash may import as a function: ${fix(name)}`);
	}
	return out;
}

/**
 * Whether this bash call starts from the certified state (PLAN.md § 2.2, conditions 1-5, as revision 8
 * changes them), read live from this process at the call. `host` is OMP's modules (gates/index.ts
 * shellStartHost), `ctx` the session (its `cwd` is where a host without a live Settings instance is
 * read from), `input` the call as typed, `cwd` the directory it runs in (fence.ts hostCommandCwd; the
 * certificate does not depend on it in 18.8.6, where the one per-directory input, direnv, must be
 * off). With the clean-shell switch off for the session the one reason is the switch's. Otherwise
 * every failing condition adds a reason; `certified` is true only with none.
 */
export async function shellStart(host: ShellStartHost, ctx: Ctx, input: Record<string, unknown>, _cwd: string, proc: ShellStartProcess = LIVE): Promise<ShellStart> {
	// 0. The switch (src/clean-shell.ts): off means uncertified, whatever else holds.
	const workloadId = proc.env()[WORKLOAD_ENV];
	const sw = cleanShellFromHost(host.getAgentDir);
	if (!cleanShellOn(sw, workloadId)) return { certified: false, reasons: [cleanShellOffReason(sw, workloadId)] };

	const reasons: string[] = [];

	// 4. No service.
	if (input.name !== undefined) reasons.push(NAMED_CALL_REASON);

	// 2 (call half). No PTY backend: the same truthiness OMP's canUseInteractiveBashPty reads `pty` with.
	if (input.pty && proc.env().PI_NO_PTY !== "1") reasons.push("a `pty: true` call may run in a PTY login shell (PI_NO_PTY is not 1 in this process), so it is refused: rerun the call without `pty`");

	// 3. Not ACP.
	const acp = acpReason(host, proc.argv());
	if (acp !== null) reasons.push(acp);

	// 1 and 2 (settings half): host version, fence on, auto-background on, shell, prefix, direnv.
	let shellEnv: Record<string, string> | null = null;
	try {
		const settings = (await hostSettings(host, ctx.cwd)) as ShellStartSettingsInstance;
		const flag = unknownSetting(settings, FENCE_FLAG.split("."));
		if (flag !== undefined && flag !== true) reasons.push(`${FENCE_FLAG} is ${JSON.stringify(flag)}, and the certificate covers fenced calls only`);
		if (readSetting(host, settings, "bash.autoBackground.enabled") !== true) reasons.push("bash.autoBackground.enabled is false for this profile: leave it unset (default true)");
		const direnv = readSetting(host, settings, "bash.direnv");
		if (direnv !== "off") reasons.push(`bash.direnv is ${JSON.stringify(direnv)}, not "off", so OMP may merge a repository's .envrc into the call's env: set bash.direnv: "off" in the profile's config.yml (profile/config.yml carries it; re-run as2 install)`);
		const config = shellConfig(host, settings);
		if (typeof config === "string") reasons.push(config);
		else {
			if (/bash/.test(config.shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "")) {
				reasons.push(`OMP resolves the bash tool's shell to ${JSON.stringify(config.shell)}, whose name contains "bash", so OMP loads a snapshot of rc functions and options before every call: set shellPath: /bin/sh in the installed profile's config.yml (without it OMP takes $SHELL when it is bash or zsh, else bash on PATH), or start as2 from a terminal whose SHELL is /bin/zsh`);
			}
			if (config.prefix !== undefined) reasons.push("PI_SHELL_PREFIX or CLAUDE_CODE_SHELL_PREFIX sets a command prefix OMP runs every call through: relaunch as2 without it");
			shellEnv = config.env;
		}
	} catch (err) {
		reasons.push(err instanceof HostError ? err.message : `the settings could not be read (${message(err)})`);
	}

	// 5. The env is bound and hook-free.
	const e0 = proc.gateLoad();
	const e = proc.environ();
	if (e0 === null) reasons.push("the C environ was not captured when the gates loaded, so a Shell built before this call cannot be bound to it: restart the session");
	else if (!e0.ok) reasons.push(`the C environ could not be read when the gates loaded (${e0.error}): restart the session`);
	if (!e.ok) reasons.push(`the C environ could not be read at this call (${e.error}): restart the session`);
	if (e0?.ok && e.ok) {
		const changed = environDiff(e0.env, e.env);
		if (changed.length > 0) reasons.push(`the C environ changed since the gates loaded (${nameList(changed)}), so an existing Shell may hold the old one: restart the session`);
	}
	if (shellEnv !== null) {
		const multiline = Object.entries(shellEnv).filter(([, v]) => v.includes("\n")).map(([k]) => k);
		if (multiline.length > 0) {
			reasons.push(`OMP's shell.env holds a newline in the value of ${nameList(multiline)}, so OMP's Shell key could match a Shell built from another shell.env: remove the newline from where it is set (the launch env, or ${DOTENV_FILES})`);
		}
	}
	let nonInteractive: Record<string, string> | null = null;
	if (typeof host.buildNonInteractiveEnv !== "function") {
		reasons.push(hostMissing(host, "@oh-my-pi/pi-coding-agent/exec/non-interactive-env", "buildNonInteractiveEnv", host.buildNonInteractiveEnv));
	} else {
		try {
			nonInteractive = (host.buildNonInteractiveEnv as () => Record<string, string>)();
		} catch (err) {
			reasons.push(`OMP's non-interactive env could not be built (${message(err)})`);
		}
	}
	let cert: Map<string, string> | null = null;
	if (e.ok && shellEnv !== null && nonInteractive !== null) {
		cert = new Map(e.env);
		for (const [k, v] of Object.entries(shellEnv)) cert.set(k, v);
		for (const [k, v] of Object.entries(nonInteractive)) cert.set(k, String(v));
		const [environ, shell] = [e.env, shellEnv];
		reasons.push(...envHookReasons(cert, (name) => hookFix(name, environ, shell)));
	}

	if (reasons.length > 0 || cert === null) return { certified: false, reasons };
	return { certified: true, env: cert, reasons: [] };
}
