// plugins/paired-as2.ts — as2's one seam to the vendored paired-coding OMP adapter
// (plugins/paired-coding/omp/paired-coding-omp.ts, plugins/VENDOR.md). plugins/index.ts binds the
// adapter only through bindPairedCoding, so whatever as2 hands the adapter is decided here and nowhere
// else: the environment it reads its state dir (PAIRED_CODING_STATE_DIR) and conflicting-tool list
// (PAIRED_CODING_CONFLICTING_TOOLS) from, and the P-11 bridge of PLAN-2 wl-mvb9mw00ycfjeo D5, through
// the adapter's two seams (its `pi` and its `execute`), with no vendored file changed:
//
// - The lifecycle allowance (VENDOR.md clash C8). While pairing, the core refuses every tool not on its
//   allowlist unless the host passes it in `allow` (core/gate.mjs toolVerdict), which the adapter's
//   tool_call handler never does. Here that handler is given the exact names in PAIR_LIFECYCLE_TOOLS
//   (gates/src/pair-call.ts): for one of them the core's verdict is asked with that `allow`, and every
//   other name goes to the adapter's handler unchanged. The core never allows a mutating or dispatch
//   name through `allow`, and each allowed tool keeps its own as2 checks.
// - The execution half of the canonical view (VENDOR.md clash C12). pair_write, pair_edit and pair_run
//   execute only with the authorization gates/src/pair-call.ts registerPairCalls gave their tool call
//   once every P-11 row and the fence allowed it, and only with the arguments and worktree root it was
//   judged with. pair_start hands the core the fence's subpath deny targets as `protect`, so pair_run's
//   one Seatbelt profile also denies the ledger and the hooks directory; a pair_run is refused when a
//   fence target of its command would still be writable under that profile, or, where the clean shell
//   is on, when the env its /bin/sh starts with carries a start hook.
// - The run a pair_run made, kept when pairing stops during or after it. runVerb returns a run's `result`
//   (its `runId` and real exit) only when pairing goes on; when its post-run link or supervisor check
//   stops pairing, it returns the stop with no `result`, though the command ran. runStart journaled the
//   run's start before it spawned the command; runEnd journals its end only while pairing is still active,
//   so not when the partner typed pair stop while it ran. The bridge reads the run back from the journal
//   by its runId, among only the entries appended after it called runVerb (a provider may reuse a tool
//   call id across prompts, so an older run under the same id is never this call's), and hands the
//   adapter its result, marked `stopped`: the journaled end's exit, or an unknown exit (null) when only
//   the start is there. The observers (gates/src/pair-call.ts canonicalResult) record that real, failed
//   run; a pair_run refused before its start stays a non-run.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { shellStartReason } from "../gates/src/fence";
import {
	isPairMutation,
	PAIR_LIFECYCLE_TOOLS,
	pairFingerprint,
	pairProtect,
	pairRunStartReasons,
	pairWorktreeRoot,
	takePairAuthorization,
	unprotectedTargets,
} from "../gates/src/pair-call";
import { loadState } from "./paired-coding/lib/host-io.mjs";
import { executeVerb, sessionDirFor, verdict } from "./paired-coding/lib/verbs.mjs";
import pairedCodingOmp, { type OmpContext, type PiLike } from "./paired-coding/omp/paired-coding-omp.ts";

export interface PairedAs2Options {
	/** The environment the adapter reads (plugins/index.ts passes its own, default process.env). */
	env: Record<string, string | undefined>;
}

/** executeVerb's context and result, as plugins/paired-coding/lib/verbs.mjs documents them. */
interface VerbContext {
	sessionId: string;
	sessionDir: string;
	root?: string;
	cwd?: string;
	signal?: AbortSignal;
	runId?: string;
	timeoutMs?: number;
	maxTimeoutMs?: number;
	protect?: string[];
}
interface VerbResult {
	ok: boolean;
	text: string;
	result?: object;
}
type ToolCallHandler = (event: { toolName: string }, ctx: OmpContext) => unknown;

const refused = (name: string, why: string): VerbResult => ({ ok: false, text: `${name} refused: ${why}` });

/** The byte length of the session journal (`journal.jsonl`), 0 while there is none. */
function journalLength(sessionDir: string): number {
	try {
		return statSync(join(sessionDir, "journal.jsonl")).size;
	} catch {
		return 0;
	}
}

/**
 * The result of run `runId` when the adapter started it and then stopped pairing, read from the session
 * journal (`journal.jsonl`, append-only; lib/verbs.mjs runVerb) back from its end, among only the entries
 * appended after byte `mark`, the journal's length before this invocation called runVerb: the `run-end`
 * entry runEnd (plugins/paired-coding/core/gate.mjs) wrote, with the run's exit and the timedOut and
 * aborted runVerb adds; or, when pairing stopped before runEnd and so no end was written, the `run-start`
 * entry runStart wrote before the command was spawned, with the exit unknown (null). Undefined when those
 * entries hold neither, so this invocation's run never started, and when the journal is gone or shorter
 * than `mark`, so what follows it cannot be told apart.
 */
function stoppedRun(sessionDir: string, runId: string, mark: number): object | undefined {
	let journal: Buffer;
	try {
		journal = readFileSync(join(sessionDir, "journal.jsonl"));
	} catch {
		return undefined;
	}
	if (journal.length < mark) return undefined;
	const lines = journal.subarray(mark).toString("utf8").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(lines[i]!) as Record<string, unknown>;
		} catch {
			continue; // a blank or torn line, as upstream's own reader skips it
		}
		if (e?.runId !== runId) continue;
		// Read backwards, a start met before any end is a run whose end was never journaled.
		if (e.type === "run-end") return { exitCode: typeof e.exitCode === "number" ? e.exitCode : null, timedOut: e.timedOut === true, aborted: e.aborted === true, runId, stopped: true };
		if (e.type === "run-start") return { exitCode: null, timedOut: false, aborted: false, runId, stopped: true };
	}
	return undefined;
}

/** The adapter's tool_call handler with the exact as2 lifecycle names allowed while pairing (C8). */
function withLifecycleAllowance(adapterHandler: ToolCallHandler, env: Record<string, string | undefined>): ToolCallHandler {
	return (event, ctx) => {
		if (!PAIR_LIFECYCLE_TOOLS.includes(event.toolName)) return adapterHandler(event, ctx);
		const dir = sessionDirFor(ctx.sessionManager.getSessionId(), env);
		if (!dir) return undefined; // as the adapter's handler: no usable session id, nothing activated under it
		const v = verdict(event.toolName, { sessionDir: dir, allow: [...PAIR_LIFECYCLE_TOOLS] });
		return v.allow ? undefined : { block: true, reason: `paired coding: ${v.reason}` };
	};
}

/** The adapter's `pi`: OMP's own, with its tool_call handler given the lifecycle allowance. */
function adapterHost(pi: PiLike, env: Record<string, string | undefined>): PiLike {
	const on = pi.on.bind(pi) as (event: string, handler: (...args: never[]) => unknown) => void;
	return {
		zod: pi.zod,
		registerTool: (tool) => pi.registerTool(tool),
		getAllTools: () => pi.getAllTools(),
		...(pi.sendMessage ? { sendMessage: (message, options) => pi.sendMessage!(message, options) } : {}),
		on: ((event: string, handler: ToolCallHandler) => on(event, event === "tool_call" ? withLifecycleAllowance(handler, env) : handler)) as PiLike["on"],
	};
}

/** executeVerb behind the P-11 bridge (C12). */
function bridgedExecute(env: Record<string, string | undefined>): typeof executeVerb {
	return async (name: string, args: Record<string, unknown>, ctx: VerbContext): Promise<VerbResult> => {
		if (name === "pair_start") {
			let protect: string[];
			try {
				protect = pairProtect(pairWorktreeRoot(ctx.cwd ?? process.cwd()), env);
			} catch (err) {
				return refused(name, `the M4b fence's deny targets could not be computed (${err instanceof Error ? err.message : String(err)}), and pairing never starts without them`);
			}
			return executeVerb(name, args, { ...ctx, protect: [...(ctx.protect ?? []), ...protect] });
		}
		if (!isPairMutation(name)) return executeVerb(name, args, ctx);
		const auth = ctx.runId ? takePairAuthorization(ctx.runId) : undefined;
		if (!auth) return refused(name, "the P-11 gates did not allow this call (no authorization for its tool call id), so it is not run");
		const state = loadState(ctx.sessionDir);
		// Not pairing: the adapter refuses it itself, and runs nothing.
		if (state.phase === "inactive" || typeof state.root !== "string") return executeVerb(name, args, ctx);
		const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
		if (pairFingerprint(name, input, state.root) !== auth.fingerprint) {
			return refused(name, "its arguments, or the worktree root they resolve against, are not the ones the P-11 gates checked (a later handler rewrote the call, or the pairing root differs from the session's), so it is not run");
		}
		if (name === "pair_run") {
			const open = unprotectedTargets(auth.targets, state);
			if (open.length > 0) {
				return refused(name, `the pairing sandbox would leave the M4b fence's targets ${open.map((t) => t.path).join(", ")} writable to this command; run it with bash, where the fence confines it`);
			}
			if (auth.certify) {
				const reasons = pairRunStartReasons(process.env);
				if (reasons.length > 0) return refused(name, shellStartReason(reasons));
			}
		}
		const mark = journalLength(ctx.sessionDir);
		const r = await executeVerb(name, args, ctx);
		if (name !== "pair_run" || r.result !== undefined) return r;
		const run = stoppedRun(ctx.sessionDir, ctx.runId!, mark);
		return run ? { ...r, result: run } : r;
	};
}

/** Bind the paired adapter onto `pi` with what as2 supplies it. */
export function bindPairedCoding(pi: PiLike, options: PairedAs2Options): void {
	pairedCodingOmp(adapterHost(pi, options.env), { env: options.env, execute: bridgedExecute(options.env) });
}
