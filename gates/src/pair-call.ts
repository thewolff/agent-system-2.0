// The P-11 view of the paired-coding adapter's mutating tools (PLAN-2 wl-mvb9mw00ycfjeo D5; plugins/VENDOR.md
// clash C12). pair_write, pair_edit and pair_run write and run inside their own tools
// (plugins/paired-coding/omp/paired-coding-omp.ts registerTool → executeVerb), so the rows keyed on write,
// edit and bash would never see them. This module is the one canonical view both sides use:
//
// - pair_write is a `write` of its path resolved against the pairing worktree root, pair_edit an `edit`,
//   pair_run a `bash` of its command with that root as cwd: the path, command and directory execution uses
//   (the adapter resolves paths against, and runs in, `state.root`, the realpath of the nearest directory
//   holding `.git` above the session cwd: plugins/paired-coding/lib/host-io.mjs findRoot).
// - The rows that judge or observe write, edit and bash read every event through canonicalCall /
//   canonicalResult (rows 3, 6, 8, 9, 10 and 18 in gates/extensions/, the composition in src/gates.ts, the
//   artifact observers in surface/extensions/lane.ts), so a pair call gets the same refusal, the same
//   reserved-request and push bookkeeping and the same receipts and artifact outcomes as its equivalent.
// - registerPairCalls is the M4b fence's half. It registers after the fence (gates/index.ts), so it runs only
//   for a call every row allowed (OMP stops at the first block), and authorizes that call by tool call id
//   with a fingerprint of its arguments and the root it was judged at. The adapter's tool runs only through
//   plugins/paired-as2.ts, which takes the authorization at execute and refuses a call whose final arguments
//   (OMP hands execute the last tool_call revision) or root differ: a later handler's rewrite is refused,
//   never run unchecked, and a call no gate saw is refused too.
// - pair_run has no fence wrapper: the adapter runs `/bin/sh -c` under its own Seatbelt profile, which denies
//   every write outside the temp paths and the agreed boundary, plus `.git` control files and the paths in
//   `state.protect`. The bridge hands pair_start the fence's subpath deny targets (pairProtect: the ledger
//   directories and the hooks directory) as `protect`, so one profile carries both denies; a nested
//   sandbox-exec would exit 71 (fence.ts ALREADY_WRAPPED_REASON). At execute, every fence target of the
//   command that the pairing profile would still let it write (unprotectedTargets) refuses the run.
// - A scratch-root exemption (row 6 or 8 marked the call confined) holds only for a run confined to the
//   scratch root with no network, which the pairing profile is not, so pair_run refuses it.
// - Where the clean shell is on (src/clean-shell.ts), pair_run must start hook-free: the env the adapter
//   spawns `/bin/sh` with is this process's (host-io.mjs runSandboxed `opts.env ?? process.env`, and
//   runVerb passes none), so that env is certified at execute, right before the spawn (pairRunStartReasons),
//   not a hypothetical bash tool shell. The bash tool's other conditions (named service, PTY, OMP's shell and
//   its rc snapshot, prefix, direnv) are about OMP's executor, which pair_run does not use.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ARTIFACT_TOOL, LANE_TOOLS } from "../../surface/src/types";
import type { CleanShellCheck } from "./clean-shell";
import { nestedSandboxExec } from "./exec";
import { ALREADY_WRAPPED_REASON, CLEAN_SHELL_NEEDS_FENCE, cleanShellSwitch, FenceError, type FenceSettings, type FenceTarget, fenceBypassRefusal, fenceTargets, shellStartReason } from "./fence";
import { WAKE_READ_TOOL } from "./rows/r07-wake-read";
import { type Ctx, type GatesAPI, isConfined, releaseConfined } from "./session";
import { envHookReasons } from "./shell-start";
import type { ToolCall } from "./types";

/** The adapter's mutating tools and the host tool each is judged as. */
export const PAIR_VIEW = { pair_write: "write", pair_edit: "edit", pair_run: "bash" } as const;
export type PairMutation = keyof typeof PAIR_VIEW;

export const isPairMutation = (name: string): name is PairMutation => Object.hasOwn(PAIR_VIEW, name);

/**
 * The as2 tools the pairing gate allows while pairing, by exact name (the core's `opts.allow`,
 * plugins/paired-coding/core/gate.mjs toolVerdict, which never allows a mutating or dispatch name through it):
 * the lane's ledger lifecycle tools, slice_artifact and the wake read. Each keeps its own checks.
 */
export const PAIR_LIFECYCLE_TOOLS: readonly string[] = [...LANE_TOOLS, ARTIFACT_TOOL, WAKE_READ_TOOL];

/** The pairing worktree root for `cwd`, as the adapter computes it (host-io.mjs findRoot); `cwd` resolved when it cannot be read. */
export function pairWorktreeRoot(cwd: string): string {
	let start: string;
	try {
		start = realpathSync.native(cwd);
	} catch {
		return resolve(cwd);
	}
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return start;
	}
}

/** The host call a pair mutation is judged as, at `root`. */
export function pairView(toolName: PairMutation, input: Record<string, unknown>, root: string): ToolCall {
	const path = typeof input.path === "string" ? resolve(root, input.path) : input.path;
	if (toolName === "pair_write") return { toolName: "write", input: { path, content: input.content } };
	if (toolName === "pair_edit") return { toolName: "edit", input: { path } };
	return { toolName: "bash", input: { command: input.command, cwd: root } };
}

/** `call` as the rows judge it: a pair mutation becomes its host equivalent at the session's pairing root (tool call id kept); anything else is returned as is. */
export function canonicalCall<T extends ToolCall>(call: T, cwd: string): T {
	if (!isPairMutation(call.toolName)) return call;
	return { ...call, ...pairView(call.toolName, call.input, pairWorktreeRoot(cwd)) };
}

interface ResultEvent extends ToolCall {
	details?: unknown;
	isError: boolean;
}

/**
 * A `tool_result` as the observers read it. A pair_write or pair_edit that succeeded is its write or edit.
 * A pair_run is a bash result only when it ran (the adapter's result carries its `runId`; for a run during
 * or after which the adapter stopped pairing, plugins/paired-as2.ts supplies that result from the run's
 * journaled end, or from its journaled start with the exit unknown): its exit is the real one, and any run
 * the adapter did not call ok (timed out, aborted, an error, pairing stopped during or after it) is
 * non-zero, so no wrapper success becomes a pass. A refused pair call ran nothing and stays as it is,
 * which no observer reads.
 */
export function canonicalResult<T extends ResultEvent>(event: T, cwd: string): T {
	if (!isPairMutation(event.toolName)) return event;
	if (event.toolName !== "pair_run") return event.isError ? event : canonicalCall(event, cwd);
	const d = (event.details && typeof event.details === "object" ? event.details : {}) as Record<string, unknown>;
	if (typeof d.runId !== "string") return event;
	const code = !event.isError ? 0 : typeof d.exitCode === "number" && d.exitCode !== 0 ? d.exitCode : 1;
	return { ...canonicalCall(event, cwd), details: code === 0 ? {} : { exitCode: code }, isError: code !== 0 };
}

/** What an authorization binds: the call as judged and every argument execution will read. */
export function pairFingerprint(toolName: PairMutation, input: Record<string, unknown>, root: string): string {
	return JSON.stringify({ view: pairView(toolName, input, root), input });
}

/** A pair call every gate allowed, until it executes. `targets`: pair_run's fence targets; `certify`: the clean shell is on. */
export interface PairAuthorization {
	fingerprint: string;
	targets: FenceTarget[];
	certify: boolean;
}

const AUTHORIZED = Symbol.for("agent-system-2.0/p11-gates/pair-authorized");

/** Authorizations by tool call id; ids are unique per call, so like the confined set this hangs off globalThis keyed by id alone. */
function authorized(): Map<string, PairAuthorization> {
	const g = globalThis as { [AUTHORIZED]?: Map<string, PairAuthorization> };
	return (g[AUTHORIZED] ??= new Map());
}

/** The authorization of call `toolCallId`, consumed: one execution per authorization. */
export function takePairAuthorization(toolCallId: string): PairAuthorization | undefined {
	const a = authorized().get(toolCallId);
	authorized().delete(toolCallId);
	return a;
}

/** The fence's paths pair_start hands the adapter as `protect`: every subpath it denies for a run at `root` (the ledger directories, the hooks directory). */
export function pairProtect(root: string, env: Record<string, string | undefined>): string[] {
	return fenceTargets("true", root, env)
		.filter((t) => t.kind === "subpath")
		.map((t) => t.path);
}

/** The pairing sandbox a run gets, as far as unprotectedTargets reads it (the adapter's state). */
export interface PairRunSandbox {
	root: string;
	stateDir?: string;
	tempPaths?: string[];
	protect?: string[];
}

const within = (path: string, base: string): boolean => path === base || path.startsWith(base.endsWith("/") ? base : `${base}/`);

/**
 * The fence targets the pairing profile would let a run write (plugins/paired-coding/core/gate.mjs
 * pairRunProfile): not under the state directory or a protected path, and either in a temp path (or above
 * one), or in the worktree outside its `.git` control paths, which the profile always denies. Anywhere else
 * the profile denies every write already.
 */
export function unprotectedTargets(targets: readonly FenceTarget[], sandbox: PairRunSandbox): FenceTarget[] {
	const denied = [sandbox.stateDir, ...(sandbox.protect ?? [])].filter((p): p is string => typeof p === "string");
	return targets.filter((t) => {
		if (denied.some((p) => within(t.path, p))) return false;
		if (within(t.path, sandbox.root)) return !relative(sandbox.root, t.path).split("/").some((seg) => seg.toLowerCase() === ".git");
		return (sandbox.tempPaths ?? []).some((tp) => within(t.path, tp) || within(tp, t.path));
	});
}

/** The start-hook refusals of the env pair_run's `/bin/sh` is spawned with. */
export function pairRunStartReasons(env: Record<string, string | undefined>): string[] {
	const entries = Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string");
	return envHookReasons(entries, () => "relaunch as2 from a shell that does not export it (pair_run's /bin/sh starts with this process's env)");
}

/** Why pair_run refuses a scratch-root exemption. */
export const PAIR_RUN_CONFINED_REASON =
	"M4b OS fence: a scratch-root rule let this command through, and that rule holds only for a run confined to the own scratch root with no network; pair_run runs under the pairing sandbox, which is not that confinement, so it is refused. Run it with bash, where the fence confines it.";

/** Why pair_run refuses a call it could not judge (`why`). */
const refuse = (why: string) => ({ block: true as const, reason: `M4b OS fence: ${why}; this pair_run is refused rather than run outside the fence's checks.` });

/**
 * Register the fence's half for pair calls (see the header). Call it after registerFence: it judges only
 * what every row before it allowed, and authorizes it for plugins/paired-as2.ts.
 */
export function registerPairCalls(pi: GatesAPI, env: Record<string, string | undefined>, loadSettings?: (ctx: Ctx) => Promise<FenceSettings>, cleanShell?: CleanShellCheck): void {
	const cleanShellOnHere = cleanShellSwitch(env, cleanShell);

	pi.on("tool_call", async (event, ctx) => {
		if (!isPairMutation(event.toolName)) return undefined;
		const id = event.toolCallId;
		if (!id) return { block: true, reason: `P-11 gates: this ${event.toolName} call has no tool call id, so what it executes cannot be bound to what the gates checked; refused.` };
		const root = pairWorktreeRoot(ctx.cwd);
		let targets: FenceTarget[] = [];
		let certify = false;
		if (event.toolName === "pair_run") {
			const bypassed = fenceBypassRefusal(ctx);
			if (bypassed) return bypassed;
			if (isConfined(id)) {
				// The call ends at this refusal, so its mark goes with it.
				releaseConfined(id);
				return { block: true, reason: PAIR_RUN_CONFINED_REASON };
			}
			const command = event.input.command;
			if (typeof command !== "string") return refuse("the call has no command text");
			try {
				if (nestedSandboxExec(command, root, env)) return { block: true, reason: ALREADY_WRAPPED_REASON };
				targets = fenceTargets(command, root, env);
			} catch (err) {
				return refuse(err instanceof FenceError ? err.message : `the fenced paths could not be computed (${String(err)})`);
			}
			if (await cleanShellOnHere(ctx)) {
				let settings: FenceSettings;
				try {
					if (!loadSettings) throw new FenceError("no host settings reader was handed to the gates");
					settings = await loadSettings(ctx);
				} catch (err) {
					return refuse(`the settings that switch the fence could not be read (${err instanceof Error ? err.message : String(err)})`);
				}
				if (!settings.enabled) return { block: true, reason: shellStartReason([CLEAN_SHELL_NEEDS_FENCE]) };
				certify = true;
			}
		}
		authorized().set(id, { fingerprint: pairFingerprint(event.toolName, event.input, root), targets, certify });
		return undefined;
	});

	pi.on("tool_result", (event) => {
		if (!isPairMutation(event.toolName) || !event.toolCallId) return undefined;
		authorized().delete(event.toolCallId);
		releaseConfined(event.toolCallId);
		return undefined;
	});
}
