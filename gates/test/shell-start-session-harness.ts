// The harness of the shell-start session regression (sl-regress-session, workload wl-mv5lrh0drbg0zk,
// PLAN.md revision 7 § 5.1 and § 2.3). Not a test file: the shell-start-session-*.test.ts files use it.
//
// Each session is a real `omp --mode rpc` (the omp on PATH) against a scripted local
// OpenAI-compatible stub model (surface/test/tool-mount.test.ts's wire format), loading this
// checkout's gates extension, with:
// - a scratch HOME whose agent-system-2 profile config.yml carries the keys of this checkout's
//   profile/config.yml, read when the session starts (so a later profile key, such as `bash.direnv`,
//   reaches every session), minus the keys that load code or route models (PROFILE_KEYS_NOT_COPIED),
//   with the clean-shell switch `gates.cleanShell` set as the file asks (makeHome: "all" unless
//   said otherwise; the gates read it at every call); the tier files are linked into the profile's
//   agents dir as install.sh does;
// - the env the launchers build: surface/src/launch.ts `laneEnv` for a lane, the `bin/as2 --print`
//   line for the orchestrator, each over a scratch starter env that holds no secret;
// - exactly that env as the process's C environ: omp is started through `/usr/bin/env -i`, so names
//   a JS object cannot carry (`BASH_FUNC_f%%`, `__proto__`) reach it as a launcher's would.
//
// The recorder extension (shell-start-session-recorder.ts), loaded before the gates, writes what
// each bash call starts from as OMP holds it at that call: the C environ, `shell.env` and the
// non-interactive env. The exactness assertion (§ 2.3) compares the typed command's exported env
// with the merge of those three.
//
// Inside a lane's fence a nested sandbox-exec runs only when its profile denies exactly what the
// outer one denies (measured: the same targets exit 0, one target more or less exits 71
// `sandbox_apply: Operation not permitted`; gates/test/r18-typed-wrapper-exec.test.ts). A session's
// own fence denies its scratch ledger directory, so there the session gets a stand-in
// `sandbox-exec` first on its PATH: a compiled exec-only program that replaces the profile argument
// with this process's own fence profile (fence.ts fenceProfile(fenceTargets(...)) over this
// process's env and the checkout, which equals the outer one) and execs the real
// /usr/bin/sandbox-exec with the rest of its argv and its environ untouched. The wrapper's shape,
// the real sandbox-exec and the /bin/bash -c it starts are unchanged; only the deny list differs.
// Where no omp is on PATH the files skip, naming it; that is the only skip. With omp there, a fence
// that cannot be set up (no stand-in can be built, say) fails the file at load.
//
// Every omp a session starts runs under a hard kill after SESSION_KILL_MS and a footprint cap of
// SESSION_RSS_CAP (PLAN.md revision 8 "Proofs"; rss-watchdog.ts); a session killed by either fails
// with the figure, and fixture().close throws for a kept-alive one that was.
import type { Server } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { laneEnv } from "../../surface/src/launch";
import { STANDING_WORKLOAD_ID } from "../../surface/src/types";
import { type FenceTarget, fenceProfile, fenceTargets } from "../src/fence";
import { type CleanShellValue, readCleanShell } from "../src/clean-shell";
import { startRssWatchdog } from "./rss-watchdog";

export const REPO = resolve(import.meta.dir, "..", "..");
export const OMP = Bun.which("omp");
const PROFILE = "agent-system-2";
const RECORDER = join(import.meta.dir, "shell-start-session-recorder.ts");
/** Keys of profile/config.yml the scratch profile does not copy: the harness loads the gates itself and routes every model to the stub. */
const PROFILE_KEYS_NOT_COPIED = ["extensions", "skills", "modelRoles", "retry", "task", "testRunner"];
/** A session's omp is SIGKILLed this long after it starts, whatever its script does. */
const SESSION_KILL_MS = 90_000;
/** A session's omp is SIGKILLed when its physical footprint passes this. */
const SESSION_RSS_CAP = 2 * 1024 ** 3;
/** Kills by the caps not yet reported by a failing runSession (a kept-alive session's). */
const capKills: string[] = [];
const TIERS = ["fast", "standard", "strong", "deep"];

/** The rc function, the variable it references, and the files every probe reports on. */
export const RC_FN = "as2probe_fn";
export const RC_VAR = "as2probe_var";
/**
 * Names bash or brush may set or withhold on its own (C4, C4b): never required to be exported.
 * SHELL: brush withholds it from the wrapper's child (measured in this harness on 857bca0: the
 * child's env lacks it while `shell.env` and the C environ carry it), and bash then sets it itself.
 */
export const RESERVED = new Set([
	"BASH", "BASHOPTS", "BASHPID", "BASH_ALIASES", "BASH_ARGC", "BASH_ARGV", "BASH_ARGV0", "BASH_CMDS", "BASH_COMMAND", "BASH_ENV",
	"BASH_EXECUTION_STRING", "BASH_LINENO", "BASH_REMATCH", "BASH_SOURCE", "BASH_SUBSHELL", "BASH_VERSINFO", "BASH_VERSION", "COLUMNS",
	"DIRSTACK", "EUID", "FUNCNAME", "GROUPS", "HISTCMD", "HOSTNAME", "HOSTTYPE", "IFS", "LINENO", "LINES", "MACHTYPE", "OLDPWD", "OPTARG",
	"OPTERR", "OPTIND", "OSTYPE", "PIPESTATUS", "PPID", "PS1", "PS2", "PS3", "PS4", "PWD", "RANDOM", "SECONDS", "SHELL", "SHELLOPTS", "SHLVL",
	"UID", "_",
]);
/** Names bash sets in the child itself (C4): exempt from the subset assertion. */
export const BASH_SET = new Set(["PWD", "SHLVL", "_"]);
/**
 * Ordinary names brush withholds from the wrapper's child although `cert.env` carries them (C4 is a
 * subset contract: such a name may be absent from the child, never present with another value).
 * GIT_ALTERNATE_OBJECT_DIRECTORIES: measured in this harness with the certificate in place
 * (sl-build-cert, lane decision en-mv61762rcejn5s): in `cert.env` from the C environ, absent from the
 * lane's and hand's exported env and unset in the orchestrator's printout, on every embedded route;
 * brush alone drops it from a C environ that carries it (gates/test/shell-start-bash.test.ts).
 * Unlike RESERVED, the orchestrator still prints it, so a value other than `cert.env`'s is caught.
 */
export const WITHHELD = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES"]);

// ───────────────────────────── the nested-fence stand-in ─────────────────────────────

const REAL_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Exit code of the real sandbox-exec nested under this process with `profile`. */
function nestedExit(profile: string): number | null {
	return Bun.spawnSync([REAL_SANDBOX_EXEC, "-p", profile, "/usr/bin/true"], { stdout: "ignore", stderr: "ignore" }).exitCode;
}

export interface FenceSetup {
	/** A directory to put first on every session's PATH (the stand-in's), or null when the real sandbox-exec nests. */
	standInDir: string | null;
}

/** A fence that cannot be set up with omp on PATH: the file fails, never skips (review r1 finding 4). */
const setupFailed = (why: string): Error => new Error(`the shell-start session suite cannot run although omp is on PATH: ${why}`);

/**
 * Decides how the sessions' fence runs here: the real sandbox-exec when a profile like a session's
 * (a scratch ledger directory) nests under this process, else the stand-in, compiled into `dir`.
 * Throws when neither can run.
 */
export function fenceSetup(dir: string): FenceSetup {
	if (!existsSync(REAL_SANDBOX_EXEC)) throw setupFailed(`${REAL_SANDBOX_EXEC} is missing`);
	const probeHome = join(dir, "fence-probe-home");
	mkdirSync(join(probeHome, ".agent-system-2"), { recursive: true });
	const sessionLike = fenceProfile(fenceTargets("true", REPO, { HOME: probeHome, AGENT_SYSTEM_LEDGER_DB: join(probeHome, ".agent-system-2", "ledger.db") }));
	const code = nestedExit(sessionLike);
	if (code === 0) return { standInDir: null };
	if (code !== 71) throw setupFailed(`sandbox-exec under this process exits ${code}`);
	// Nested under a fence. This process's own fence profile, over the checkout (r18's measurement). The
	// test preload (ledger/test/isolate-preload.ts) moved HOME and the ledger path to a temp home, and
	// Guard A refuses `defaultLedgerPath` on the live root under test, so fenceTargets cannot be asked
	// for the outer fence's ledger entries. They are rebuilt here from the recorded real values, the way
	// fenceTargets builds them (the configured parent, and the resolved file's parent when it differs):
	// only as deny paths, nothing opens the ledger. The repository entries come from fenceTargets.
	const own = fenceProfile(process.env.AS2_TEST_ISOLATED === "1" ? [...realLedgerTargets(), ...fenceTargets("true", REPO, process.env).slice(1)] : fenceTargets("true", REPO, process.env));
	if (nestedExit(own) !== 0) throw setupFailed("nested sandbox-exec exits 71 and this process's own fence profile does not nest either");
	const cc = Bun.which("cc");
	if (!cc) throw setupFailed("nested sandbox-exec exits 71 inside a fence and no cc builds the stand-in");
	const standIn = join(dir, "stand-in");
	mkdirSync(standIn, { recursive: true });
	// JSON string syntax is C string-literal syntax for this text: SBPL strings hold no control
	// character (fence.ts sbplString refuses one), so only `"` and `\` are escaped.
	const source = `#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
	if (argc < 4 || strcmp(argv[1], "-p") != 0) return 64;
	argv[0] = "${REAL_SANDBOX_EXEC}";
	argv[2] = ${JSON.stringify(own)};
	execv("${REAL_SANDBOX_EXEC}", argv);
	return 127;
}
`;
	writeFileSync(join(standIn, "stand-in.c"), source);
	const built = Bun.spawnSync([cc, "-O1", "-o", join(standIn, "sandbox-exec"), join(standIn, "stand-in.c")], { stdout: "pipe", stderr: "pipe" });
	if (built.exitCode !== 0) throw setupFailed(`nested sandbox-exec exits 71 inside a fence and the stand-in did not build (${built.stderr.toString().slice(0, 200)})`);
	return { standInDir: standIn };
}

/** The outer fence's ledger targets, from the HOME and ledger path the test preload recorded. */
function realLedgerTargets(): FenceTarget[] {
	const home = process.env.AS2_TEST_REAL_HOME;
	const file = process.env.AS2_TEST_REAL_LEDGER_DB || (home ? join(home, ".agent-system-2", "ledger.db") : "");
	if (!file) throw new Error("the test preload recorded neither a real HOME nor a real ledger path");
	const dir = realpathSync(dirname(file));
	const out: FenceTarget[] = [{ kind: "subpath", path: dir }];
	const fileDir = existsSync(file) ? dirname(realpathSync(file)) : dir;
	if (fileDir !== dir) out.push({ kind: "subpath", path: fileDir });
	return out;
}

// ───────────────────────────── the stub model ─────────────────────────────

/**
 * One model turn. A tool step's `first` runs in this process when the stub serves the step, after
 * the session returned the previous call's result and before it makes this call (the switch flip).
 */
export type Step = { tool: string; args: Record<string, unknown>; first?: () => void } | { text: string };

export interface StubCall {
	id: string;
	tool: string;
	args: Record<string, unknown>;
}

interface WireMessage {
	role: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
}

const textOf = (c: unknown): string =>
	typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("") : "";
const chunk = (delta: unknown, finish: string | null) => ({
	id: "stub",
	object: "chat.completion.chunk",
	created: 0,
	model: "stub",
	choices: [{ index: 0, delta, finish_reason: finish }],
	...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } } : {}),
});
const sse = (chunks: unknown[]) =>
	new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

/** The tag a conversation belongs to: the first `as2tag:<tag>` in its first user message. */
const TAG = /as2tag:([a-z0-9-]+)/;

export class Stub {
	readonly server: Server<undefined>;
	readonly #scripts = new Map<string, Step[]>();
	readonly #cursor = new Map<string, number>();
	/** Every tool call the stub issued, by tag. */
	readonly calls = new Map<string, StubCall[]>();
	/** Every tool result text a request carried, by tool call id (the last seen wins; results do not change). */
	readonly results = new Map<string, string>();
	/** The text of every message but the assistant's of each tag's latest request: tool results and the follow-ups OMP injects (background completions). */
	readonly transcript = new Map<string, string>();
	/** The tool names each tag's requests offered. */
	readonly tools = new Map<string, string[]>();
	/** Requests no script claimed (no tag): a harness defect, reported by the files. */
	readonly untagged: string[] = [];

	constructor() {
		this.server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
				const body = (await req.json()) as { messages: WireMessage[]; tools?: { function?: { name: string } }[] };
				// A request with no tools is OMP summarising or titling out of band; it takes no script step.
				if (!body.tools?.length) return sse([chunk({ role: "assistant", content: "summary" }, null), chunk({}, "stop")]);
				for (const m of body.messages) if (m.role === "tool" && m.tool_call_id) this.results.set(m.tool_call_id, textOf(m.content));
				const firstUser = body.messages.find((m) => m.role === "user");
				const tag = firstUser ? TAG.exec(textOf(firstUser.content))?.[1] : undefined;
				if (!tag || !this.#scripts.has(tag)) {
					this.untagged.push(firstUser ? textOf(firstUser.content).slice(0, 200) : "(no user message)");
					return sse([chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")]);
				}
				this.tools.set(tag, body.tools.map((t) => t.function?.name ?? "?"));
				this.transcript.set(
					tag,
					body.messages
						.filter((m) => m.role !== "assistant")
						.map((m) => textOf(m.content))
						.join("\n"),
				);
				const k = this.#cursor.get(tag) ?? 0;
				this.#cursor.set(tag, k + 1);
				const step = this.#scripts.get(tag)![k] ?? { text: "done" };
				if ("text" in step) return sse([chunk({ role: "assistant", content: step.text }, null), chunk({}, "stop")]);
				step.first?.();
				const id = `call_${tag.replaceAll("-", "_")}_${k}`;
				let list = this.calls.get(tag);
				if (!list) this.calls.set(tag, (list = []));
				list.push({ id, tool: step.tool, args: step.args });
				return sse([
					chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null),
					chunk({}, "tool_calls"),
				]);
			},
		});
	}

	get port(): number {
		return this.server.port!;
	}

	script(tag: string, steps: Step[]): void {
		this.#scripts.set(tag, steps);
		this.#cursor.set(tag, 0);
	}

	/** Every step of `tag`'s script has been served. */
	exhausted(tag: string): boolean {
		return (this.#cursor.get(tag) ?? 0) >= (this.#scripts.get(tag)?.length ?? 0);
	}

	stop(): void {
		this.server.stop(true);
	}
}

// ───────────────────────────── scratch homes and envs ─────────────────────────────

export interface Home {
	root: string;
	home: string;
	agentDir: string;
	ledgerPath: string;
	/** Where probes write their reports. */
	out: string;
	/** The file BASH_ENV scripts append their `$$` to. */
	marks: string;
	/** A script that appends `$$` to `marks`: the BASH_ENV value of the hook cases. */
	bashEnvScript: string;
}

/** The profile/config.yml keys this checkout carries now, minus PROFILE_KEYS_NOT_COPIED. */
export function profileKeys(): Record<string, unknown> {
	const parsed = Bun.YAML.parse(readFileSync(join(REPO, "profile", "config.yml"), "utf8")) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(parsed)) if (!PROFILE_KEYS_NOT_COPIED.includes(k)) out[k] = v;
	return out;
}

/**
 * The profile config.yml text of `keys`: one top-level key per line with its value in JSON flow
 * style (YAML is a superset of JSON), except `gates:`, written as a block mapping with a block list
 * for a listed `cleanShell`, the shape profile/config.yml and `as2 clean-shell` (bin/as2) write.
 */
function profileText(keys: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [k, v] of Object.entries(keys)) {
		if (k !== "gates" || !v || typeof v !== "object") {
			lines.push(`${k}: ${JSON.stringify(v)}`);
			continue;
		}
		lines.push("gates:");
		for (const [gk, gv] of Object.entries(v)) {
			if (gk === "cleanShell" && Array.isArray(gv) && gv.length > 0) lines.push("  cleanShell:", ...gv.map((id) => `    - ${id}`));
			else lines.push(`  ${gk}: ${JSON.stringify(gv)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Sets the clean-shell switch in `h`'s profile config.yml (null: the key absent), keeping every
 * other key. The gates read it at their next call.
 */
export function setCleanShell(h: Home, value: CleanShellValue | null): void {
	const file = join(h.agentDir, "config.yml");
	const keys = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
	const gates = { ...keys.gates };
	if (value === null) delete gates.cleanShell;
	else gates.cleanShell = value;
	writeFileSync(file, profileText({ ...keys, gates }));
}

/** A scratch HOME under `root` with the agent-system-2 profile routed to `stub`, the clean shell set to `cleanShell`. */
export function makeHome(root: string, name: string, stub: Stub, cleanShell: CleanShellValue | null = "all"): Home {
	const base = join(root, name);
	const home = join(base, "h");
	const agentDir = join(home, ".omp", "profiles", PROFILE, "agent");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(home, ".agent-system-2"), { recursive: true });
	const out = join(base, "out");
	mkdirSync(out, { recursive: true });
	writeFileSync(join(agentDir, "config.yml"), profileText(profileKeys()));
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  stub:\n    baseUrl: http://127.0.0.1:${stub.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: stub\n        name: Stub\n        reasoning: false\n        input: [text]\n        contextWindow: 200000\n        maxTokens: 4096\n`,
	);
	for (const t of TIERS) symlinkSync(join(REPO, "tiers", `${t}.md`), join(agentDir, "agents", `${t}.md`));
	const marks = join(base, "bashenv.marks");
	const bashEnvScript = join(base, "bashenv.sh");
	writeFileSync(bashEnvScript, `printf '%s\\n' "$$" >> ${marks}\n`);
	const h: Home = { root: base, home, agentDir, ledgerPath: join(home, ".agent-system-2", "ledger.db"), out, marks, bashEnvScript };
	setCleanShell(h, cleanShell);
	return h;
}

/** A workload with a lane reserved for it in `h`'s scratch ledger: the binding laneEnv writes. */
export function reserveLane(h: Home): { workloadId: string; laneId: string } {
	const l = Ledger.open(h.ledgerPath, { create: true, backup: false, backupOnOpen: false });
	try {
		const workloadId = l.openWorkload({ by: "orchestrator-surface", brief: "shell-start session probe", stakes: "normal", mode: "autonomous" });
		const res = l.reserveLane(workloadId, { by: LANE_STARTER_BY, cap: 3, leaseMs: 600_000, requestedBy: "test", receiptWorkload: STANDING_WORKLOAD_ID, decide: () => ({ launch: true, cause: "first" }) });
		if (!res.ok) throw new Error(res.reason);
		return { workloadId, laneId: res.laneId };
	} finally {
		l.close();
	}
}

/** The starter's env: a scratch env holding no secret, as a terminal starting as2 would hand it on. */
export function starterEnv(h: Home, fence: FenceSetup, extra: Record<string, string> = {}): Record<string, string> {
	const path = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
	const user = userInfo().username;
	return {
		PATH: fence.standInDir ? `${fence.standInDir}:${path}` : path,
		HOME: h.home,
		TMPDIR: `${h.root}/`,
		USER: user,
		LOGNAME: user,
		LANG: "en_US.UTF-8",
		TERM: "xterm-256color",
		// Jo's login shell (PLAN.md § 1.3); a case sets its own.
		SHELL: "/bin/zsh",
		OMP_PROFILE: PROFILE,
		AGENT_SYSTEM_LEDGER_DB: h.ledgerPath,
		...extra,
	};
}

export { laneEnv };

/** POSIX sh words of one line: plain and single-quoted runs only (as2's `quote`); anything else throws. */
function shWords(line: string): string[] {
	const words: string[] = [];
	let cur: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (c === " ") {
			if (cur !== null) words.push(cur);
			cur = null;
		} else if (c === "'") {
			const end = line.indexOf("'", i + 1);
			if (end < 0) throw new Error(`unterminated quote in: ${line}`);
			cur = (cur ?? "") + line.slice(i + 1, end);
			i = end;
		} else if (c === "\\" && line[i + 1] === "'") {
			cur = (cur ?? "") + "'";
			i++;
		} else if (/["$`\\]/.test(c)) {
			throw new Error(`bin/as2 --print used ${c}, which this reader does not model: ${line}`);
		} else cur = (cur ?? "") + c;
	}
	if (cur !== null) words.push(cur);
	return words;
}

/**
 * The orchestrator's launch from `bin/as2 --print` run with `base`: the env it builds over `base`
 * (`env` assignments, `-u` removals, `-i`) and the omp argv after `omp`.
 */
export function as2Launch(base: Record<string, string>): { env: Record<string, string>; args: string[] } {
	const r = Bun.spawnSync(["/bin/sh", join(REPO, "bin", "as2"), "--print"], { env: base, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`bin/as2 --print exited ${r.exitCode}: ${r.stderr.toString()}`);
	const line = r.stdout.toString().trim();
	const words = shWords(line);
	if (words[0] !== "env") throw new Error(`bin/as2 --print does not start with env: ${line}`);
	let env: Record<string, string> = { ...base };
	let i = 1;
	for (; i < words.length; i++) {
		const w = words[i]!;
		if (w === "-i" || w === "-") env = {};
		else if (w === "-u") delete env[words[++i]!];
		else if (w.startsWith("-u")) delete env[w.slice(2)];
		else if (w.startsWith("-")) throw new Error(`bin/as2 --print used env ${w}, which this reader does not model`);
		else if (w.includes("=")) env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
		else break;
	}
	if (words[i] !== "omp") throw new Error(`bin/as2 --print runs ${words[i]}, not omp: ${line}`);
	return { env, args: words.slice(i + 1) };
}

// ───────────────────────────── sessions ─────────────────────────────

export interface SessionSpec {
	tag: string;
	home: Home;
	/** The launch env: exactly the omp process's C environ. Ordered entries, so names a JS object cannot hold (`__proto__`) survive. */
	env: [string, string][];
	/** omp args from the launcher (the orchestrator's `--cwd <repo>`); the harness adds the rpc and stub args. */
	launcherArgs: string[];
	/**
	 * Lane sessions run headless (`--no-ui`, laneArgv); the orchestrator keeps rpc's UI (as2 runs the
	 * TUI). rpc's UI offers no terminal, so a `pty: true` call takes the fallback there too (measured:
	 * "pty requested but unavailable in this environment"); the TUI's PTY backend is not reached.
	 */
	headless: boolean;
	/** Load the gates (every as2 session); false only for a non-as2 session that shares the profile (the broker case). */
	gates?: boolean;
	/** Keep the process running after the script ends (the broker case); the caller ends it with `end()`. */
	keepAlive?: boolean;
}

export interface Session {
	stderr: () => string;
	events: Record<string, unknown>[];
	end: () => Promise<void>;
}

const sessionsLive = new Set<Session>();

/** The env as `[name, value]` pairs, from a record. */
export const pairs = (env: Record<string, string>): [string, string][] => Object.entries(env);

/**
 * Starts `spec` and resolves once the stub has served every step of the tag's script and an
 * `agent_end` followed it (or the deadline passes: a hung session fails with its stderr, not the
 * runner's bare timeout).
 */
export async function runSession(stub: Stub, spec: SessionSpec, deadlineMs = 45_000): Promise<Session> {
	if (!OMP) throw new Error("no omp on PATH");
	const sessionDir = join(spec.home.root, "sessions", spec.tag);
	mkdirSync(sessionDir, { recursive: true });
	const args = [
		"--mode", "rpc", ...(spec.headless ? ["--no-ui"] : []), "--model", "stub/stub", "--session-dir", sessionDir, "--no-title",
		"--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--thinking", "off",
		...(spec.launcherArgs.includes("--cwd") ? [] : ["--cwd", REPO]),
		...spec.launcherArgs,
		// The recorder first: it sees every call, refused ones included, and never blocks.
		"-e", RECORDER,
		...(spec.gates === false ? [] : ["-e", join(REPO, "gates", "index.ts")]),
	];
	for (const [k] of spec.env) if (k.includes("=")) throw new Error(`env name holds '=': ${k}`);
	const proc = Bun.spawn(["/usr/bin/env", "-i", ...spec.env.map(([k, v]) => `${k}=${v}`), OMP, ...args], {
		cwd: REPO,
		env: {},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		timeout: SESSION_KILL_MS,
		killSignal: "SIGKILL",
	});
	// `env -i` execs omp in place: the pid is omp's.
	let capKill = null as string | null;
	const capped = (why: string) => {
		capKill = `session ${spec.tag}: ${why}, so it was killed`;
		capKills.push(capKill);
	};
	const stopWatch = startRssWatchdog({
		pid: proc.pid,
		capBytes: SESSION_RSS_CAP,
		onExceed: (bytes) => {
			capped(`omp's physical footprint reached ${(bytes / 1024 ** 3).toFixed(2)} GiB, over the ${SESSION_RSS_CAP / 1024 ** 3} GiB cap`);
			proc.kill("SIGKILL");
		},
	});
	let endedByUs = false;
	void proc.exited.then(() => {
		stopWatch();
		if (!endedByUs && capKill === null && proc.signalCode === "SIGKILL") capped(`omp ran past the ${SESSION_KILL_MS / 1000} s hard limit`);
	});
	let stderr = "";
	const errText = new Response(proc.stderr).text().then((t) => {
		stderr = t;
	});
	const events: Record<string, unknown>[] = [];
	let resolveEnd: (ok: boolean) => void = () => {};
	const ended = new Promise<boolean>((r) => {
		resolveEnd = r;
	});
	void (async () => {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return resolveEnd(false);
			buf += decoder.decode(value, { stream: true });
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (!event || typeof event !== "object" || Array.isArray(event)) continue;
				events.push(Object.fromEntries(Object.entries(event)));
				if ("type" in event && event.type === "agent_end" && stub.exhausted(spec.tag)) resolveEnd(true);
			}
		}
	})();
	proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: `as2tag:${spec.tag} run the script` })}\n`);
	const timer = setTimeout(() => resolveEnd(false), deadlineMs);
	const finished = await ended;
	clearTimeout(timer);
	const session: Session = {
		stderr: () => stderr,
		events,
		end: async () => {
			endedByUs = true;
			sessionsLive.delete(session);
			proc.stdin.end();
			proc.kill();
			await proc.exited;
			await errText;
		},
	};
	sessionsLive.add(session);
	if (!finished) {
		await session.end();
		const why = capKill === null ? "" : ` (${capKills.splice(capKills.indexOf(capKill), 1)[0]})`;
		throw new Error(`session ${spec.tag} did not finish its script${why}; stderr: ${stderr.slice(0, 3000)}`);
	}
	if (!spec.keepAlive) await session.end();
	return session;
}

export async function endAll(): Promise<void> {
	for (const s of [...sessionsLive]) await s.end();
}

/**
 * Resolves once `path` exists, or after `ms`. Polled: the file is written by a process this one does
 * not own (a background job or a broker's service), and its appearance is the signal; the deadline
 * only bounds a call that never ran.
 */
export async function appears(path: string, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (!existsSync(path)) {
		if (Date.now() > end) return false;
		await Bun.sleep(25);
	}
	return true;
}

// ───────────────────────────── probes ─────────────────────────────

export type Route = "foreground" | "async" | "autobg" | "pty" | "named";
export const ROUTES: Route[] = ["foreground", "async", "autobg", "pty", "named"];
const ROUTE_ID: Record<Route, string> = { foreground: "fg", async: "as", autobg: "ab", pty: "pt", named: "nm" };
export type Role = "lane" | "hand" | "orchestrator";
const ROLE_ID: Record<Role, string> = { lane: "l", hand: "h", orchestrator: "o" };
export const UNSET = "__unset__";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** OMP's `wait`: where a call's result arrives later (async, auto-background, a service), the script waits for it. */
export const WAIT: Step = { tool: "wait", args: {} };

/** Probe ids: `<case>-<role>-<route>`, plus a suffix when a session probes one route twice. */
export function probeId(name: string, role: Role, route: Route, suffix = ""): string {
	return `${name}-${ROLE_ID[role]}-${ROUTE_ID[route]}${suffix}`;
}

/**
 * A lane's or a hand's probe: writes `$-`, `$$`, `type -t` of the rc function and the rc variable to
 * `<out>/<id>.txt`, the exported env (`env -0`) to `<id>.env`, then `<id>.done`.
 */
export function fileProbe(h: Home, id: string, prefix = ""): string {
	const o = join(h.out, id);
	return (
		`${prefix}printf 'flags=%s\\npid=%s\\ntype=%s\\nvar=%s\\n' "$-" "$$" "$(type -t ${RC_FN})" "\${${RC_VAR}-${UNSET}}" > ${o}.txt; ` +
		`/usr/bin/env -0 > ${o}.env; : > ${o}.done`
	);
}

/**
 * The orchestrator's probe. Row 15 lets the orchestrator run only read-only commands with no write
 * destination and no assignment: `printf` with expansions passes, `type`, `env` and `printenv` are
 * refused (gates/src/rows/r15-orchestrator-role.ts). So it prints `$-`, `$$`, the rc variable and
 * the value of each name in `names` (or UNSET) between markers to stdout, which reaches the model as
 * the call's result, a `wait` result or a `read proc://` result.
 */
export function stdoutProbe(id: string, names: readonly string[]): string {
	const lines = [`as2probe-begin:${id}`, "flags=$-", "pid=$$", `var=\${${RC_VAR}-${UNSET}}`, ...names.map((n) => `v:${n}=\${${n}-${UNSET}}`), `as2probe-end:${id}`];
	return `printf '%s\\n' ${lines.map((l) => `"${l}"`).join(" ")}`;
}

/** The bash call of `route` running `command`, probe `id`'s. */
export function probeStep(command: string, id: string, route: Route): Step {
	switch (route) {
		case "foreground":
			return { tool: "bash", args: { command } };
		case "async":
			return { tool: "bash", args: { command, async: true } };
		case "autobg":
			// timeout 2 s: OMP waits min(threshold, timeout − 1 s) = 1 s in the foreground, then
			// backgrounds the still-running call (tools/bash.ts resolveAutoBackgroundWaitMs); `tail -f
			// /dev/null` (read-only, so row 15 lets the orchestrator run it too) keeps it running past
			// that wait, and the timeout ends it.
			return { tool: "bash", args: { command: `${command}; tail -f /dev/null`, timeout: 2 } };
		case "pty":
			// No terminal in an rpc session: OMP runs it on the session's persistent Shell and says
			// "pty requested but unavailable" (the `pty: true` fallback, PLAN.md § 1.2 item 5).
			return { tool: "bash", args: { command, pty: true } };
		case "named":
			return { tool: "bash", args: { command, name: `p-${id}` } };
	}
}

/** `role`'s steps probing each of `routes` (ids from `name`), each followed by what brings its result back. */
export function probeSteps(role: Role, h: Home, name: string, routes: readonly Route[], opts: { prefix?: string; names?: readonly string[]; suffix?: string } = {}): Step[] {
	const steps: Step[] = [];
	for (const route of routes) {
		const id = probeId(name, role, route, opts.suffix);
		steps.push(probeStep(role === "orchestrator" ? stdoutProbe(id, opts.names ?? []) : fileProbe(h, id, opts.prefix), id, route));
		if (route === "async" || route === "autobg" || route === "named") steps.push(WAIT);
		// A service's output is not delivered with its completion: the orchestrator reads it back.
		if (route === "named" && role === "orchestrator") steps.push({ tool: "read", args: { path: `proc://p-${id}` } });
	}
	return steps;
}

/** A hand's six-field brief (SPEC-2.0.md § B9) carrying the hand's script tag. */
export function handBrief(tag: string, workloadId: string): string {
	return [
		`workload: ${workloadId}`,
		`task: as2tag:${tag} run the shell-start probe calls`,
		"done-condition: every probe call made",
		"inputs: none",
		"stakes: normal",
		"ceiling-share: 1",
	].join("\n");
}

/** The lane's dispatch of a `fast` hand on `brief`, then the wait for its result. */
export function dispatchSteps(brief: string): Step[] {
	return [{ tool: "task", args: { context: "shell-start session probe", tasks: [{ agent: "fast", task: brief, solutionSpace: "one fix: run the given calls" }] } }, WAIT];
}

export interface Recorded {
	environ: [string, string][];
	shellEnv: Record<string, string>;
	nonInteractive: Record<string, string>;
	shell: string;
	error?: string;
}

/** What the recorder wrote for the call whose command holds `marker`, or null. */
export function recorded(h: Home, marker: string): Recorded | null {
	const dir = join(h.home, "as2probe-recorder");
	if (!existsSync(dir)) return null;
	for (const f of new Bun.Glob("*.json").scanSync(dir)) {
		const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Recorded & { command: string };
		if (r.command.includes(marker)) return r;
	}
	return null;
}

/** `cert.env` as § 2.3 defines it for an embedded call: C environ ⊕ `shell.env` ⊕ the non-interactive env. */
export function certEnv(rec: Recorded): Map<string, string> {
	const merge = new Map<string, string>(rec.environ);
	for (const [k, v] of Object.entries(rec.shellEnv)) merge.set(k, v);
	for (const [k, v] of Object.entries(rec.nonInteractive)) merge.set(k, v);
	return merge;
}

export interface Probe {
	role: Role;
	route: Route;
	id: string;
	/** The call's tool result text (a refusal's reason), or undefined when none reached the model. */
	text: string | undefined;
	/** The probe's command ran: its report exists. */
	ran: boolean;
	flags: string;
	pid: string;
	/** `type -t` of the rc function; null on the orchestrator, which row 15 does not let run `type`. */
	type: string | null;
	var: string;
	/** BASH_ENV's script ran in this probe's shell. */
	bashEnvRan: boolean;
	/** Lane and hand: the exported env. Orchestrator: the value (or UNSET) of each name its probe printed. */
	env: Map<string, string>;
	/** `env` is the exported env (lane, hand), not printed shell values (orchestrator). */
	exported: boolean;
	rec: Recorded | null;
}

function marksOf(h: Home): string[] {
	return existsSync(h.marks) ? readFileSync(h.marks, "utf8").split("\n") : [];
}

/** The probe `id` of `tag`'s session, as the stub, the probe's output and the recorder saw it. */
export async function collect(stub: Stub, tag: string, h: Home, role: Role, route: Route, id: string): Promise<Probe> {
	const marker = role === "orchestrator" ? `as2probe-begin:${id}"` : `/${id}.txt`;
	const call = stub.calls.get(tag)?.find((c) => typeof c.args.command === "string" && c.args.command.includes(marker));
	const text = call ? stub.results.get(call.id) : undefined;
	const rec = recorded(h, marker);
	const base = { role, route, id, text, rec };
	if (role === "orchestrator") {
		const m = new RegExp(`as2probe-begin:${id}\\n([\\s\\S]*?)\\nas2probe-end:${id}`).exec(stub.transcript.get(tag) ?? "");
		const fields = new Map<string, string>();
		const env = new Map<string, string>();
		for (const line of m?.[1]?.split("\n") ?? []) {
			const eq = line.indexOf("=");
			if (eq < 0) continue;
			if (line.startsWith("v:")) env.set(line.slice(2, eq), line.slice(eq + 1));
			else fields.set(line.slice(0, eq), line.slice(eq + 1));
		}
		const pid = fields.get("pid") ?? "";
		return { ...base, ran: m !== null, flags: fields.get("flags") ?? "", pid, type: null, var: fields.get("var") ?? "", bashEnvRan: m !== null && marksOf(h).includes(pid), env, exported: false };
	}
	const o = join(h.out, id);
	// A started service writes its report from the broker; the script's `wait` returned once it
	// finished, so this bound only covers a broker slower to flush than to report completion.
	const ran = await appears(`${o}.done`, text?.includes("running") ? 3000 : 300);
	if (!ran) return { ...base, ran, flags: "", pid: "", type: "", var: "", bashEnvRan: false, env: new Map(), exported: true };
	const fields = new Map<string, string>();
	for (const line of readFileSync(`${o}.txt`, "utf8").split("\n")) if (line.includes("=")) fields.set(line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1));
	const env = new Map<string, string>();
	for (const e of readFileSync(`${o}.env`, "utf8").split("\0")) if (e !== "") env.set(e.includes("=") ? e.slice(0, e.indexOf("=")) : e, e.includes("=") ? e.slice(e.indexOf("=") + 1) : "");
	const pid = fields.get("pid") ?? "";
	return { ...base, ran, flags: fields.get("flags") ?? "", pid, type: fields.get("type") ?? "", var: fields.get("var") ?? "", bashEnvRan: marksOf(h).includes(pid), env, exported: true };
}

/**
 * § 2.3 for one probe that ran, against the recorder's `cert.env` of its call. Lane and hand: every
 * exported name but PWD, SHLVL and _ is in `cert.env` with its value, and every ordinary
 * (identifier, not RESERVED) `cert.env` name is exported. Orchestrator: each printed name is set
 * with its `cert.env` value when in it and unset when not (row 15 leaves no way to list exports;
 * the tool output shortens a long line with `…`, so a shortened value is compared by prefix).
 */
export function exactness(p: Probe): string[] {
	if (!p.rec || p.rec.error) return [`no recorder entry for the call (${p.rec?.error ?? "none written"})`];
	const cert = certEnv(p.rec);
	const out: string[] = [];
	if (p.exported) {
		for (const [k, v] of p.env) {
			if (BASH_SET.has(k)) continue;
			if (!cert.has(k)) out.push(`exports ${k}, which is not in cert.env`);
			else if (cert.get(k) !== v) out.push(`exports ${k} with a value other than cert.env's`);
		}
		for (const k of cert.keys()) if (!RESERVED.has(k) && !WITHHELD.has(k) && IDENT.test(k) && !p.env.has(k)) out.push(`does not export cert.env's ${k}`);
		return out;
	}
	for (const [k, v] of p.env) {
		if (RESERVED.has(k) || BASH_SET.has(k)) continue;
		const want = cert.get(k);
		if (want === undefined) {
			if (v !== UNSET) out.push(`has ${k} set, which is not in cert.env`);
		} else if (v !== want && !(v === UNSET && WITHHELD.has(k)) && !(v.endsWith("…") && want.startsWith(v.slice(0, -1)))) out.push(`has ${k} ${v === UNSET ? "unset" : "with a value other than cert.env's"}`);
	}
	return out;
}

const clip = (t: string | undefined): string => (t === undefined ? "no result" : JSON.stringify(t.slice(0, 160)));

/**
 * What the change must make true of probe `p` (PLAN.md § 5.1, with the clean shell on), as violation
 * lines (empty = holds). `hook` set: every call is refused with a reason containing that text (an
 * env hook's name, or the bash-named shell). Otherwise a named call is refused with item 4's reason
 * (it names `named` calls and `async`), a `pty: true` call is refused (no launcher sets PI_NO_PTY=1;
 * revision 8), and an embedded call runs from a clean start: `$-` = hBc, no rc function or
 * variable, no BASH_ENV script, and § 2.3's env. A call that ran anyway is checked for leaks too,
 * which is the leak list.
 */
export function violations(p: Probe, hook: string | null = null): string[] {
	const at = `${p.role} ${p.route}`;
	const out: string[] = [];
	if (hook !== null) {
		if (p.ran || !p.text?.includes(hook)) out.push(`${at}: not refused naming ${hook}: ${p.ran ? "it ran" : clip(p.text)}`);
	} else if (p.route === "named") {
		if (p.ran || !p.text || !/named/.test(p.text) || !/async/.test(p.text)) out.push(`${at}: not refused as a named call: ${p.ran ? "it ran" : clip(p.text)}`);
	} else if (p.route === "pty") {
		if (p.ran || !p.text?.includes("rerun the call without `pty`")) out.push(`${at}: not refused as a pty call: ${p.ran ? "it ran" : clip(p.text)}`);
	} else if (!p.ran) out.push(`${at}: did not run: ${clip(p.text)}`);
	if (!p.ran) return out;
	if (p.flags !== "hBc") out.push(`${at}: $- is ${p.flags}, not hBc`);
	if (p.type) out.push(`${at}: type -t ${RC_FN} is ${p.type}`);
	if (p.var !== UNSET) out.push(`${at}: ${RC_VAR} is set`);
	if (p.bashEnvRan) out.push(`${at}: the BASH_ENV script ran`);
	if (p.route !== "named") for (const m of exactness(p)) out.push(`${at}: ${m}`);
	return out;
}

// ───────────────────────────── cases ─────────────────────────────

export interface CaseSpec {
	/** Short, `[a-z0-9]`: tags and probe ids derive from it. */
	name: string;
	/** Writes the case's files into each scratch home (rc files, `~/.env`). */
	prepare?: (h: Home) => void;
	/** Starter env entries over starterEnv's (a case's SHELL). */
	starter?: Record<string, string>;
	/** Launch env entries added after the launcher built its env, so its name filter never saw them. */
	launchExtra?: [string, string][];
	/** Steps each session runs before its probes. */
	before?: Step[];
	/** Text the lane's and the hand's probe commands start with. */
	prefix?: string;
	/** Extra names the orchestrator's probe prints. */
	names?: readonly string[];
	/** Homes to use instead of fresh ones (the broker case reuses a home an earlier session started a broker in). */
	homes?: { lane: Home; orchestrator: Home };
}

export interface CaseRun {
	probes: Probe[];
	homes: { lane: Home; orchestrator: Home };
	/** Requests no script claimed, and the sessions' stderr: shown when a case fails for a harness reason. */
	untagged: string[];
	stderr: string;
}

/** The lane's launch env over `h`: laneEnv over the starter env with `h`'s switch, as lane.ts reads it at a spawn, plus the case's extra entries. */
export function laneLaunch(h: Home, fence: FenceSetup, spec: CaseSpec): { env: [string, string][]; workloadId: string } {
	const binding = reserveLane(h);
	return { env: [...pairs(laneEnv(starterEnv(h, fence, spec.starter), binding, readCleanShell(h.agentDir))), ...(spec.launchExtra ?? [])], workloadId: binding.workloadId };
}

/** The orchestrator's launch over `h`: `bin/as2 --print`'s env and args, plus the case's extra entries. */
export function orchestratorLaunch(h: Home, fence: FenceSetup, spec: CaseSpec): { env: [string, string][]; args: string[] } {
	const l = as2Launch(starterEnv(h, fence, spec.starter));
	return { env: [...pairs(l.env), ...(spec.launchExtra ?? [])], args: l.args };
}

/**
 * Runs case `spec`: a lane session probing every route and dispatching a hand that probes every
 * route, then an orchestrator session probing every route. The orchestrator prints the names the
 * lane's calls had in `cert.env`, its own launch env's names and `spec.names`.
 */
export async function runCase(stub: Stub, root: string, fence: FenceSetup, spec: CaseSpec): Promise<CaseRun> {
	const homes = spec.homes ?? { lane: makeHome(root, `${spec.name}l`, stub), orchestrator: makeHome(root, `${spec.name}o`, stub) };
	if (!spec.homes) for (const h of [homes.lane, homes.orchestrator]) spec.prepare?.(h);
	const lane = laneLaunch(homes.lane, fence, spec);
	const laneTag = `${spec.name}-lane`;
	const handTag = `${spec.name}-hand`;
	const orchTag = `${spec.name}-orch`;
	stub.script(handTag, [...probeSteps("hand", homes.lane, spec.name, ROUTES, { prefix: spec.prefix }), { tool: "yield", args: { data: { done: true } } }, { text: "done" }]);
	stub.script(laneTag, [...(spec.before ?? []), ...probeSteps("lane", homes.lane, spec.name, ROUTES, { prefix: spec.prefix }), ...dispatchSteps(handBrief(handTag, lane.workloadId)), { text: "done" }]);
	const laneSession = await runSession(stub, { tag: laneTag, home: homes.lane, env: lane.env, launcherArgs: [], headless: true });
	const probes: Probe[] = [];
	for (const role of ["lane", "hand"] as const)
		for (const route of ROUTES) probes.push(await collect(stub, role === "lane" ? laneTag : handTag, homes.lane, role, route, probeId(spec.name, role, route)));

	const orch = orchestratorLaunch(homes.orchestrator, fence, spec);
	const names = new Set<string>([...orch.env.map(([k]) => k), ...(spec.names ?? [])]);
	for (const p of probes) if (p.rec?.environ) for (const k of certEnv(p.rec).keys()) names.add(k);
	// Not AGENT_SYSTEM_LEDGER_DB: its expansion is the ledger file, which row 10 refuses any command to name.
	const printable = [...names].filter((n) => IDENT.test(n) && !RESERVED.has(n) && !BASH_SET.has(n) && n !== RC_VAR && n !== "AGENT_SYSTEM_LEDGER_DB").sort();
	stub.script(orchTag, [...(spec.before ?? []), ...probeSteps("orchestrator", homes.orchestrator, spec.name, ROUTES, { names: printable }), { text: "done" }]);
	const orchSession = await runSession(stub, { tag: orchTag, home: homes.orchestrator, env: orch.env, launcherArgs: orch.args, headless: false });
	for (const route of ROUTES) probes.push(await collect(stub, orchTag, homes.orchestrator, "orchestrator", route, probeId(spec.name, "orchestrator", route)));
	return { probes, homes, untagged: [...stub.untagged], stderr: `${laneSession.stderr()}\n${orchSession.stderr()}`.trim() };
}

/** The violations of `run`'s probes of `role` (every route), each probe checked as `violations` does. */
export function roleViolations(run: CaseRun, role: Role, hook: string | null = null): string[] {
	const out = run.probes.filter((p) => p.role === role).flatMap((p) => violations(p, hook));
	if (run.untagged.length) out.push(`harness: requests no script claimed: ${run.untagged.join(" | ").slice(0, 300)}`);
	return out;
}

export const ROLES: Role[] = ["lane", "hand", "orchestrator"];

export interface Fixture {
	root: string;
	fence: FenceSetup;
	/** "no omp on PATH" (the outside-the-fence test runner, lane decision en-mv61762rcejn5s), or null: the only skip. */
	skip: string | null;
	/** `skip` as a test-name suffix (tool-mount.test.ts's SKIP_REASON pattern), or "". */
	reason: string;
	stub: Stub | null;
	/** Ends every session left running, stops the stub and removes the scratch root; throws for a session the caps killed and nothing reported. */
	close: () => Promise<void>;
}

/**
 * One test file's scratch root (short: a broker's socket path lives under it), fence setup and stub.
 * The only skip is no omp on PATH. With omp there, a fence that cannot be set up throws here, so the
 * file fails at load instead of passing with every session skipped (review r1 finding 4).
 */
export function fixture(): Fixture {
	const root = mkdtempSync("/tmp/ss-");
	let fence: FenceSetup = { standInDir: null };
	if (OMP) {
		try {
			fence = fenceSetup(root);
		} catch (err) {
			rmSync(root, { recursive: true, force: true });
			throw err;
		}
	}
	const skip = OMP ? null : "no omp on PATH";
	const stub = skip ? null : new Stub();
	return {
		root,
		fence,
		skip,
		reason: skip ? ` [skipped: ${skip}]` : "",
		stub,
		close: async () => {
			await endAll();
			stub?.stop();
			rmSync(root, { recursive: true, force: true });
			const kills = capKills.splice(0);
			if (kills.length > 0) throw new Error(kills.join("\n"));
		},
	};
}

