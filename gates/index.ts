// The P-11 gates (DESIGN-2.0.md:334-354; MIGRATION.md:49, M4), every row loaded as one OMP
// extension. Each row is also its own extension file under extensions/ (astra review S4), so a
// profile lists either this file (all rows) or the row files it wants, never both: a row loaded
// twice registers its handlers twice. Rows that share state find it through src/session.ts.
// Children re-bind extensions (task/executor.ts:503-505), so one registration covers the
// orchestrator, lanes and hands; each row reads the role per session.
//
// Registration order is behaviour, because OMP runs handlers in order and stops at the first
// refusal (runner.ts emitToolCall; emit() for session_stop):
// - tool_call mirrors checkToolCall in src/gates.ts: ask, row 18, wake, the dispatch rows, then the
//   raw ledger, reserved, protected-edit and push rows (row 8 fetches, so it is last). Row 3's hand
//   yield flagging registers earlier; it only revises input, and any later refusal still wins. Row 15
//   (the orchestrator does no lane work) registers right after ask, before any row that reads the
//   ledger, so a lane's tool on the orchestrator gets the role refusal, not a lane row's. Row 18 (a
//   typed copy of the fence's wrapper) registers right after row 15 and before row 7: it reads no
//   ledger, and it reads `input.command` as typed, which every handler before the fence sees.
// - session_stop runs row 3's receipt flags before row 7 or row 1 can block the stop.
// - before_agent_start sets the mode before row 7 renders its wake message.
// - The M4b OS fence (src/fence.ts) registers last: every handler gets the original event and the
//   last non-block result is what runs (runner.ts emitToolCall), so it wraps only a bash call every
//   row allowed, its revision never reaches a row (row 18 reads the typed command), and its
//   tool_result cleanup runs after rows 3 and 8 read the original command.
// - The fence's half for the paired-coding adapter's pair_write, pair_edit and pair_run (src/pair-call.ts,
//   PLAN-2 wl-mvb9mw00ycfjeo D5) registers after the fence: the rows judge those calls as their write,
//   edit and bash equivalents, and only a call every row allowed is authorized for plugins/paired-as2.ts
//   to execute, bound to the arguments it was judged with.
import openLinks from "./extensions/open-links";
import { linkedApi } from "./src/links";
import { selfRepairOn } from "./src/self-repair";
import askPolicyRow from "./extensions/r14-ask-policy";
import briefFieldsRow from "./extensions/r05-brief-fields";
import contractRow from "./extensions/r02-contract";
import joInstructionRow from "./extensions/r11-jo-instruction";
import orchestratorRoleRow from "./extensions/r15-orchestrator-role";
import selfRepairRow from "./extensions/self-repair";
import protectedEditRow from "./extensions/r09-protected-edit";
import pushRebaseRow from "./extensions/r08-push-rebase";
import questionRow from "./extensions/question";
import rawLedgerRow from "./extensions/r10-raw-ledger";
import receiptsRow from "./extensions/r03-receipts";
import reservedRow from "./extensions/r06-reserved";
import spawnRateRow from "./extensions/r17-spawn-rate";
import tierNameRow from "./extensions/r04-tier-name";
import turnShapeRow from "./extensions/r01-turn-shape";
import typedWrapperRow from "./extensions/r18-typed-wrapper";
import wakeReadRow from "./extensions/r07-wake-read";
import { type CleanShellCheck, type CleanShellRead, cleanShellFromHost } from "./src/clean-shell";
import { type FenceSettings, fenceSettingsFrom, registerFence, type ShellStartCheck } from "./src/fence";
import { checkHostVersion, type HostModules } from "./src/host";
import { registerPairCalls } from "./src/pair-call";
import type { Ctx, GatesAPI } from "./src/session";
import { captureGateLoadEnviron, type ShellStart, type ShellStartHost, shellStart } from "./src/shell-start";

// E0 (PLAN.md § 2.2 item 5, wl-mv5lrh0drbg0zk): this process's C environ when the gates are first
// evaluated, before any bash call can build a Shell. A call whose environ differs is refused.
captureGateLoadEnviron();

export type { GatesAPI } from "./src/session";

/**
 * The host modules the fence reads settings through (src/host.ts): the running OMP's own `Settings`
 * class, so `Settings.current` (the live session's instance) is what the fence reads; its settings
 * registry, so `bash.autoBackground.enabled` is read through the handle OMP registered (18.4.4 has
 * no `Settings.get`); and its version, checked against the pin before any read. Dynamic, not
 * static, because this checkout carries no OMP install: a static import would fail loading this file
 * under `bun test` and outside OMP. The specifiers stay bare and the imports stay in this entry
 * file: OMP's legacy-pi-compat (extensibility/plugins/legacy-pi-compat.ts) hands a bare
 * `@oh-my-pi/*` import the host's in-process module only in modules it reaches from the extension
 * entry through relative imports; an absolute-path-reached module resolves it through bun instead
 * (its auto-install cache: a second copy with `current` unset, or a failed load). Measured live in
 * `omp -e`: entry, `./x` and `../dir/x` got `Settings.current` set, the absolute-path twin did not
 * (M4b classifier-host probe, agent-scratch …/M4b/classifier-host/probe/out.jsonl:1). Resolving the
 * installed `src/config/settings.ts` by path instead read a second copy and ignored a live
 * `bash.autoBackground.enabled` false (M4b review astra 2). Same rule as classifier/extension.ts
 * productionExtension.
 */
async function hostModules(): Promise<HostModules> {
	const [{ VERSION }, { Settings }, { lookup }] = await Promise.all([
		import("@oh-my-pi/pi-utils/dirs"),
		import("@oh-my-pi/pi-coding-agent/config/settings"),
		import("@oh-my-pi/pi-coding-agent/config/registry"),
	]);
	return { version: VERSION, Settings, lookup };
}

async function hostFenceSettings(ctx: Ctx): Promise<FenceSettings> {
	return fenceSettingsFrom(await hostModules(), ctx);
}

/**
 * The host modules the shell-start certificate reads beyond the settings ones (src/shell-start.ts):
 * the agent dir the clean-shell switch is read under, the per-command env OMP's executor adds, and
 * the CLI's own argv reading. Imported here for the reason hostModules gives.
 */
async function shellStartHost(): Promise<ShellStartHost> {
	const [base, { getAgentDir }, { buildNonInteractiveEnv }, { parseArgs }, { resolveCliArgv }, { extractProfileFlags }] = await Promise.all([
		hostModules(),
		import("@oh-my-pi/pi-utils"),
		import("@oh-my-pi/pi-coding-agent/exec/non-interactive-env"),
		import("@oh-my-pi/pi-coding-agent/cli/args"),
		import("@oh-my-pi/pi-coding-agent/cli-commands"),
		import("@oh-my-pi/pi-coding-agent/cli/profile-bootstrap"),
	]);
	return { ...base, getAgentDir, buildNonInteractiveEnv, parseArgs, resolveCliArgv, extractProfileFlags };
}

async function hostShellStart(ctx: Ctx, input: Record<string, unknown>, cwd: string): Promise<ShellStart> {
	return shellStart(await shellStartHost(), ctx, input, cwd);
}

/** The clean-shell switch in the running OMP's profile config (src/clean-shell.ts), read per call; imported dynamically for the reason hostModules gives. */
async function hostCleanShell(): Promise<CleanShellRead> {
	return cleanShellFromHost((await import("@oh-my-pi/pi-utils")).getAgentDir);
}

/**
 * Said once at session start, not only at the first refused bash call: a host whose version is not
 * the pinned one (Jo ran `omp update` mid-session on 2026-09-30 and every bash call was refused with
 * nothing naming the cause). The fence still refuses each call on its own read; this is the notice.
 */
function hostVersionNotice(pi: GatesAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			checkHostVersion((await import("@oh-my-pi/pi-utils/dirs")).VERSION);
		} catch (err) {
			ctx.ui.notify(`M4b gates: ${err instanceof Error ? err.message : String(err)}; every bash call in this session is refused until the pin is re-verified.`, "error");
		}
	});
}

/**
 * `cleanShell` defaults to the host's switch only beside the host's settings reader: a test handing in
 * its own settings has no host profile to read, and gets the switch off unless it hands one in.
 */
export default function p11Gates(
	pi: GatesAPI,
	env: Record<string, string | undefined> = process.env,
	fenceSettings: (ctx: Ctx) => Promise<FenceSettings> = hostFenceSettings,
	startCheck: ShellStartCheck = hostShellStart,
	cleanShell: CleanShellCheck | undefined = fenceSettings === hostFenceSettings ? hostCleanShell : undefined,
): void {
	openLinks(pi);
	const ledgerPi = linkedApi(pi, undefined, undefined, "ledger");
	pi = linkedApi(pi);
	contractRow(pi, env);
	receiptsRow(pi, env);
	const repairing = selfRepairOn(env);
	const repairFenceSettings = (): Promise<FenceSettings> => Promise.resolve({ enabled: true, autoBackground: true });
	orchestratorRoleRow(pi, env);
	selfRepairRow(pi, env);
	typedWrapperRow(pi);
	wakeReadRow(ledgerPi, env);
	tierNameRow(pi, env);
	briefFieldsRow(pi, env);
	questionRow(pi, env);
	spawnRateRow(pi, env);
	rawLedgerRow(pi, env);
	reservedRow(pi, env);
	protectedEditRow(pi, env);
	pushRebaseRow(pi, env);
	turnShapeRow(pi, env);
	joInstructionRow(pi, env);
	registerFence(pi, env, repairing ? repairFenceSettings : fenceSettings, startCheck, repairing ? undefined : cleanShell);
	registerPairCalls(pi, env, repairing ? repairFenceSettings : fenceSettings, repairing ? undefined : cleanShell);
	// The notice reads the host; a test handing in its own reader has no host to read. Repair mode's
	// exact package version was checked by install and does not import the broken host to report it.
	if (!repairing && fenceSettings === hostFenceSettings) hostVersionNotice(pi);
}
