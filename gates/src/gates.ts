// The tool-call rows of P-11 (DESIGN-2.0.md:334-354) composed in one pass. OMP-free: the extension
// entry files under gates/extensions/ feed each row OMP's `tool_call` events, and the tests feed this
// composition plain objects. First refusal wins; the order puts the cheap, local checks first and
// row 8 (which fetches) last. A paired-coding mutation is judged as its write, edit or bash
// equivalent (src/pair-call.ts canonicalCall).
import { canonicalCall } from "./pair-call";
import { checkQuestionDispatch } from "./rows/question";
import { checkTierName } from "./rows/r04-tier-name";
import { checkBriefFields } from "./rows/r05-brief-fields";
import { checkReserved } from "./rows/r06-reserved";
import type { WakeRead } from "./rows/r07-wake-read";
import { checkPushRebase, type TestRecords } from "./rows/r08-push-rebase";
import { checkProtectedEdit } from "./rows/r09-protected-edit";
import { checkRawLedgerWrite } from "./rows/r10-raw-ledger";
import { checkSpawnRate, type SpawnRateDeps } from "./rows/r17-spawn-rate";
import { checkAsk } from "./rows/r14-ask-policy";
import { checkTypedWrapper } from "./rows/r18-typed-wrapper";
import type { CallContext, GateLedger, Refusal, ToolCall } from "./types";

export interface GateDeps {
	/** The lane's workload and ledger, when the session is bound to one. */
	workload?: { id: string; ledger: () => GateLedger } | null;
	wake?: WakeRead | null;
	/** The workload's artifact-tree records (row 8), read when a push is judged; none = every push refused. */
	testRecords?: TestRecords;
	/** Row 17's lane identity, limits and clock; none = the row does not apply. It counts on `workload`'s ledger. */
	spawnRate?: SpawnRateDeps | null;
}

/** The question row over a `task` call, failing closed when the ledger cannot be read. */
export function checkQuestionRow(input: Record<string, unknown>, workload: GateDeps["workload"]): Refusal {
	if (!workload) return null;
	try {
		return checkQuestionDispatch(input, workload.ledger(), workload.id);
	} catch (err) {
		return { block: true, reason: `P-11 question row could not read the ledger to check this dispatch against open questions (${String(err)}); refusing rather than pass unchecked.` };
	}
}

export function checkToolCall(asCalled: ToolCall, ctx: CallContext, deps: GateDeps = {}): Refusal {
	const call = canonicalCall(asCalled, ctx.cwd);
	const ask = checkAsk(call.toolName, ctx.role, ctx.mode);
	if (ask) return ask;
	const typed = checkTypedWrapper(call);
	if (typed) return typed;
	const wake = deps.wake?.check(call);
	if (wake) return wake;
	if (call.toolName === "task") {
		return (
			checkTierName(call.input) ??
			checkBriefFields(call.input, deps.workload?.id ?? null) ??
			checkQuestionRow(call.input, deps.workload) ??
			(deps.workload && deps.spawnRate ? checkSpawnRate(deps.workload, deps.spawnRate) : null)
		);
	}
	return (
		checkRawLedgerWrite(call, ctx) ??
		checkReserved(call, ctx) ??
		checkProtectedEdit(call, ctx) ??
		checkPushRebase(call, ctx, deps.testRecords ?? null)
	);
}
