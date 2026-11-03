// P-11 row 6 as its own extension (astra review S4): the § A4 reserved actions, refused from any agent.
// Each refusal naming a reserved action is recorded as a `reserved-request` entry on the session's
// workload, which the orchestrator surface shows as § B3 item 1 until Jo approves or denies it
// (surface/src/errors.ts waitingReserved). A session with no workload — the orchestrator itself —
// records it on the orchestrator's standing workload (surface/src/identity.ts, opened on first use),
// the one open workload the surface reads that belongs to no lane; a session entry alone never
// reached the surface (M5 fix round 1, Codex S1 / fable F1a). The session entry is kept as the
// transcript's own copy. A pair_write, pair_edit or pair_run is judged, and its request recorded, as its
// write, edit or bash equivalent (src/pair-call.ts canonicalCall).
//
// The auto-apply gate (PLAN wl-mvqwn80onq9hq8 D3, D5). Before a reserved refusal of a lane's or a hand's
// bash call is recorded, the gate may let the call through instead, when all of these hold:
//   1. the fence is on (fenceEnabled) and this process holds no local trip;
//   2. the routine classifier (src/routine.ts, run in a worker under a 2 s deadline: src/routine-worker.ts)
//      rules it read-only, scratch-confined or worktree-confined;
//   3. inside one `ledger.write` that reads `routineOn` (src/routine-switch.ts), ESCALATION_BY's
//      `auto-applied:` row and a notice to Jo commit.
// Only then is the call marked for the fence's narrower profile (session.ts markReadOnly / markConfined)
// and let through. Any other outcome records the reserved-request as before, its body naming why it was
// not auto-applied, and refuses. There is no path that lets the call through without the committed row.
// After the call, `tool_result` (or, for a call a later row refused, `tool_execution_end`) writes
// `auto-applied-result:`, and a trip signal (a gh request that may write, unseen gh traffic, a fence
// denial) writes `auto-apply-tripped:` on the standing workload plus a notice. If that write fails, the
// alarm file, a rewritten isError tool result and a process-local trip flag each carry it.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../../surface/src/identity";
import { controlEntries } from "../../surface/src/launch";
import { sendNotice } from "../../surface/src/notice";
import { ESCALATION_BY } from "../../surface/src/types";
import { bashCommand } from "../src/exec";
import { fenceEnabled } from "../src/fence";
import { canonicalCall } from "../src/pair-call";
import type { RoutineContext, RoutineVerdict } from "../src/routine";
import { alarmFilePath, routineOn, routineState } from "../src/routine-switch";
import { classifyUnderDeadline } from "../src/routine-worker";
import { checkReserved, reservedAction, reservedRequestBody } from "../src/rows/r06-reserved";
import { type Ctx, type GatesAPI, type GateSession, gateSession, markConfined, markReadOnly } from "../src/session";
import type { ToolCall } from "../src/types";

/** The longest command a notice carries (D3). */
export const NOTICE_COMMAND_MAX = 120;
/** The longest evidence line a trip row or alarm carries. */
export const EVIDENCE_MAX = 200;

/** What the gate reads beyond the session; tests hand in their own. */
export interface AutoApplyOptions {
	/** The classifier under its deadline; default classifyUnderDeadline. */
	classify?: (call: ToolCall, ctx: RoutineContext) => Promise<RoutineVerdict>;
	/** Whether the fence is on; default fenceEnabled (the fence's own settings reader). */
	fenceOn?: (ctx: Ctx) => Promise<boolean>;
	/** The alarm file; default alarmFilePath(env). */
	alarmFile?: string;
}

/** An auto-applied call awaiting its result. */
interface Pending {
	toolCallId: string;
	workloadId: string;
	sliceId: string | null;
	rule: "read-only" | "scratch" | "worktree";
	network: boolean;
	command: string;
}

/** A trip signal (D5): which, and the output line that shows it. */
export interface Trip {
	signal: "gh-write" | "fence-denial" | "gh-traffic-unseen" | "output-unreadable";
	evidence: string;
}

/** What the result row records as the exit (D5). */
export type Exit = number | "unknown" | "refused";

/** The gate's decision on one call (D3). */
type Outcome = { through: true } | { why: string; recorded?: true; failed?: boolean };

/** An ask that is the classifier or its worker failing (routine.ts `classifier error:`, routine-worker.ts), not a ruling. */
const CLASSIFIER_FAILURE = /^(?:classifier |the classifier worker )/;

const clip = (s: string, n: number): string => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `auto-applied: <rule> <toolCallId> by <lane or hand id> cwd <cwd> net <yes|no>: <command>` (D3). */
export function autoAppliedBody(p: Pending & { by: string; cwd: string }): string {
	return `auto-applied: ${p.rule} ${p.toolCallId} by ${p.by} cwd ${p.cwd} net ${p.network ? "yes" : "no"}: ${p.command}`;
}

/** The notice of an auto-apply (D3). */
export function autoAppliedNotice(rule: string, workloadId: string, command: string): string {
	return `auto-applied (${rule}) on ${workloadId}: ${clip(command, NOTICE_COMMAND_MAX)}`;
}

/** The notice of a trip (D5). */
export function trippedNotice(workloadId: string, signal: string, rule: string): string {
	return `AUTO-APPLY TRIPPED by ${workloadId}: ${signal} in a call ruled ${rule}; auto-apply is off for every lane until your auto-routine`;
}

/** The workload's own worktree: its newest `worktree:` control entry (LANE_STARTER_BY's), or undefined. */
export function ownWorktree(ledger: Pick<Ledger, "entries">, workloadId: string): string | undefined {
	return controlEntries(ledger.entries(workloadId, "assumption")).findLast((c) => c.prefix === "worktree")?.rest || undefined;
}

// ---- the detector (D5) --------------------------------------------------------------------------

const SEATBELT_DENIAL = /Operation not permitted|deny\(1\) file-write|deny\(1\) process-exec/;
const GH_REQUEST = /^> ([A-Z]+) (\S+)/;

/**
 * The trip signal in an auto-applied call's full output, or null. `network`: the call ran gh with GH_DEBUG=api.
 * (a) a gh request line (`> METHOD path`) that may write: any method but GET, except `POST /graphql` whose following
 * `GraphQL query:` block opens with the keyword `query`; (b) a Seatbelt denial; (c) for a network call, an exit 0 with
 * no request line (gh's traffic was not seen).
 */
export function detectTrip(output: string, network: boolean, exit: Exit): Trip | null {
	const lines = output.split("\n");
	let requests = 0;
	if (network) {
		for (let i = 0; i < lines.length; i++) {
			const m = GH_REQUEST.exec(lines[i]!);
			if (!m) continue;
			requests++;
			const [, method, path] = m;
			if (method === "GET") continue;
			if (method === "POST" && path === "/graphql") {
				if (graphqlOpensWithQuery(lines, i + 1)) continue;
				return { signal: "gh-write", evidence: clip(`${lines[i]} (its GraphQL block does not open with query)`, EVIDENCE_MAX) };
			}
			return { signal: "gh-write", evidence: clip(lines[i]!, EVIDENCE_MAX) };
		}
	}
	const denial = lines.find((l) => SEATBELT_DENIAL.test(l));
	if (denial !== undefined) return { signal: "fence-denial", evidence: clip(denial, EVIDENCE_MAX) };
	if (network && requests === 0 && exit === 0) return { signal: "gh-traffic-unseen", evidence: "the call exited 0 and printed no gh request line (GH_DEBUG=api)" };
	return null;
}

/** Whether the `GraphQL query:` block after line `from` (before the next request line) opens with the operation keyword `query`. */
function graphqlOpensWithQuery(lines: readonly string[], from: number): boolean {
	for (let i = from; i < lines.length; i++) {
		if (GH_REQUEST.test(lines[i]!)) return false;
		if (lines[i]!.trim() !== "GraphQL query:") continue;
		for (let j = i + 1; j < lines.length; j++) {
			const t = lines[j]!.trim();
			if (t !== "") return /^query\b/.test(t);
		}
		return false;
	}
	return false;
}

// ---- the result (D5) ----------------------------------------------------------------------------

/** Field `key` of `v` when `v` is an object holding it, else undefined (OMP's tool details are untyped at this boundary). */
const field = (v: unknown, key: string): unknown => (v !== null && typeof v === "object" && key in v ? Reflect.get(v, key) : undefined);

/** The exit the bash tool reported: its `exitCode` on a failed exit, 0 on success, unknown for a background start, a timeout or a thrown error. */
export function exitOf(details: unknown, isError: boolean): Exit {
	if (field(details, "async") !== undefined) return "unknown";
	const code = field(details, "exitCode");
	if (typeof code === "number") return code;
	if (field(details, "timedOut") === true) return "unknown";
	return isError ? "unknown" : 0;
}

/** The text parts of a tool result's content. */
export function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map((p) => (field(p, "type") === "text" && typeof field(p, "text") === "string" ? String(field(p, "text")) : "")).join("\n");
}

/**
 * The call's whole output: the visible text, or, when OMP truncated it (`details.meta.truncation`), the spilled artifact
 * read through the session manager. `{ unreadable }` names why the whole output cannot be had (no artifact, a capped
 * artifact, no reader, a failed read).
 */
export async function fullOutput(content: unknown, details: unknown, ctx: Ctx): Promise<{ text: string } | { unreadable: string }> {
	if (field(details, "async") !== undefined) return { unreadable: "the call went to the background, so its output is not in this result" };
	const meta = field(details, "meta");
	const truncation = field(meta, "truncation");
	if (truncation === undefined) return { text: textOf(content) };
	const artifactError = field(meta, "artifactError");
	if (artifactError !== undefined) return { unreadable: `the output was truncated and its artifact failed (${String(artifactError)})` };
	const id = field(truncation, "artifactId");
	if (typeof id !== "string" || id === "") return { unreadable: "the output was truncated and no artifact holds the rest" };
	if (field(truncation, "artifactElidedBytes")) return { unreadable: `the output's artifact ${id} is itself capped` };
	const getPath = ctx.sessionManager.getArtifactPath;
	if (!getPath) return { unreadable: `the output was truncated and this host cannot resolve artifact ${id}` };
	try {
		const path = await getPath.call(ctx.sessionManager, id);
		if (!path) return { unreadable: `artifact ${id} has no path` };
		return { text: readFileSync(path, "utf8") };
	} catch (err) {
		return { unreadable: `artifact ${id} cannot be read (${message(err)})` };
	}
}

// ---- the row ------------------------------------------------------------------------------------

export default function reservedRow(pi: GatesAPI, env: Record<string, string | undefined> = process.env, opts: AutoApplyOptions = {}): void {
	const classify = opts.classify ?? ((call, ctx) => classifyUnderDeadline(call, ctx));
	const fenceOn = opts.fenceOn ?? fenceEnabled;
	const alarmFile = (): string => opts.alarmFile ?? alarmFilePath(env);
	const pending = new Map<string, Pending>();
	/** The process-local trip flag (D5 layer 3): set when a result or trip write failed, cleared by a newer auto-routine. */
	let localTrip: string | null = null;

	/** The reserved-request entry as row 6 has always written it, on the session's workload or the standing one. */
	const recordRequest = (s: GateSession, body: string): void => {
		const ledger = s.ledger();
		const workloadId = s.workloadId ?? ensureStandingWorkload(ledger);
		ledger.recordEntry({ workloadId, sliceId: s.workloadId ? s.currentSlice() : null, kind: "reserved-request", body, by: s.laneId });
		if (!s.workloadId) pi.appendEntry("p11-reserved-request", { body, workloadId });
	};

	/** Why this process's local trip still stands, or null once Jo's auto-routine is newer (a failed read keeps it). */
	const tripStands = (s: GateSession): string | null => {
		if (localTrip === null) return null;
		try {
			const st = routineState(s.ledger(), Date.now(), { alarmFile: alarmFile() });
			if (st.autoRoutine && Date.parse(st.autoRoutine.at) > Date.parse(localTrip)) {
				localTrip = null;
				return null;
			}
		} catch (err) {
			return `this process holds an auto-apply trip from ${localTrip}, and Jo's auto-routine could not be read (${message(err)})`;
		}
		return `this process holds an auto-apply trip from ${localTrip} until Jo's auto-routine`;
	};

	/**
	 * D3: let the call through or say why not. Lets it through only after the `auto-applied:` row and notice commit.
	 * `recorded`: the off-switch write already recorded the request. `failed`: the gate itself failed (a read, the
	 * classifier, its worker, a local trip), which the request body names; any other why leaves today's body unchanged.
	 */
	const autoApply = async (typed: ToolCall & { toolCallId?: string }, callCtx: RoutineContext, s: GateSession, ctx: Ctx, body: string): Promise<Outcome> => {
		if (typed.toolName !== "bash") return { why: `the ${typed.toolName} tool; only bash calls auto-apply` };
		const toolCallId = typed.toolCallId;
		if (typeof toolCallId !== "string" || toolCallId === "") return { why: "the call has no tool call id to mark" };
		if (!s.workloadId || (s.role !== "lane" && s.role !== "hand")) return { why: `the call is from ${s.workloadId ? `a ${s.role}` : "a session with no workload"}` };
		try {
			if (!(await fenceOn(ctx))) return { why: "the fence is off" };
		} catch (err) {
			return { why: `the fence's state cannot be read (${message(err)})`, failed: true };
		}
		const tripped = tripStands(s);
		if (tripped) return { why: tripped, failed: true };
		let verdict: RoutineVerdict;
		try {
			verdict = await classify({ toolName: typed.toolName, input: typed.input }, callCtx);
		} catch (err) {
			return { why: `classifier error: ${message(err)}`, failed: true };
		}
		if ("ask" in verdict) return { why: verdict.ask, failed: CLASSIFIER_FAILURE.test(verdict.ask) };
		const command = bashCommand(typed.input);
		const cwd = typeof typed.input.cwd === "string" ? resolve(ctx.cwd, typed.input.cwd) : ctx.cwd;
		const workloadId = s.workloadId;
		const ledger = s.ledger();
		const p: Pending = { toolCallId, workloadId, sliceId: null, rule: verdict.rule, network: verdict.network, command };
		const decided = ledger.write(() => {
			if (!routineOn(ledger, Date.parse(ledger.now()), { alarmFile: alarmFile() })) {
				recordRequest(s, body);
				return "off" as const;
			}
			p.sliceId = s.currentSlice();
			ledger.recordEntry({ workloadId, sliceId: p.sliceId, kind: "assumption", body: autoAppliedBody({ ...p, by: s.laneId, cwd }), by: ESCALATION_BY });
			sendNotice(ledger, { by: ESCALATION_BY, workloadId, body: autoAppliedNotice(verdict.rule, workloadId, command) });
			return "applied" as const;
		});
		if (decided === "off") return { why: "auto-apply is off", recorded: true };
		// Committed: only now is the call marked for the fence's profile, and awaited for its result.
		if (verdict.rule === "read-only") markReadOnly(typed, verdict.network, verdict.readers);
		else markConfined(typed, verdict.root, verdict.rule === "worktree" ? "worktree" : "scratch");
		pending.set(toolCallId, p);
		return { through: true };
	};

	pi.on("tool_call", async (typed, ctx) => {
		const event = canonicalCall(typed, ctx.cwd);
		const s = gateSession(ctx, env);
		// The own worktree (D2b): a bound lane's `worktree:` entry. A failed read leaves it out, so the call is judged as
		// for a workload without one, and says so.
		let worktreeRoot: string | undefined;
		if (typed.toolName === "bash" && s.bound) {
			try {
				worktreeRoot = ownWorktree(s.ledger(), s.workloadId!);
			} catch (err) {
				ctx.ui.notify(`P-11 row 6 could not read the workload's worktree: entry, so this call is judged as if it had none: ${message(err)}`, "warning");
			}
		}
		const callCtx: RoutineContext = { role: s.role, cwd: ctx.cwd, env, mode: s.mode?.mode, ...(worktreeRoot ? { worktreeRoot } : {}) };
		const refusal = checkReserved(event, callCtx);
		const action = reservedAction(refusal);
		if (!action) return refusal ?? undefined;
		const body = reservedRequestBody(event, action, event.toolCallId);
		let outcome: Outcome;
		try {
			outcome = await autoApply(typed, callCtx, s, ctx, body);
		} catch (err) {
			// The deciding write (or a read before it) threw: nothing is marked, and the call takes today's refusal.
			outcome = { why: `auto-apply failed: ${message(err)}`, failed: true };
		}
		if ("through" in outcome) return undefined;
		if (!outcome.recorded) {
			// Today's body, word for word (D3: any other outcome asks Jo as before); a failure of the gate itself is named in it.
			try {
				recordRequest(s, outcome.failed ? `${body} (not auto-applied: ${outcome.why})` : body);
			} catch (err) {
				ctx.ui.notify(`P-11 row 6 refused a reserved action and the reserved-request entry could not be written: ${String(err)}${outcome.failed ? `; before that, ${outcome.why}` : ""}`, "warning");
			}
		}
		return refusal ?? undefined;
	});

	/**
	 * D5: the result row, and with a trip signal the trip row and notice, in one write. If it throws: the process-local
	 * trip flag, the alarm-file line, and (when `content` can be rewritten) an isError result naming it.
	 */
	const settle = (p: Pending, exit: Exit, trip: Trip | null, ctx: Ctx, content: unknown[] | null): { content: unknown[]; isError: true } | undefined => {
		const s = gateSession(ctx, env);
		const resultBody = `auto-applied-result: ${p.toolCallId} exit ${exit}`;
		try {
			const ledger = s.ledger();
			ledger.write(() => {
				ledger.recordEntry({ workloadId: p.workloadId, sliceId: p.sliceId, kind: "assumption", body: resultBody, by: ESCALATION_BY });
				if (trip) {
					const standing = ensureStandingWorkload(ledger);
					ledger.recordEntry({ workloadId: standing, kind: "assumption", body: `auto-apply-tripped: ${p.toolCallId} ${trip.signal} ${trip.evidence}`, by: ESCALATION_BY });
					sendNotice(ledger, { by: ESCALATION_BY, workloadId: p.workloadId, body: trippedNotice(p.workloadId, trip.signal, p.rule) });
				}
			});
			return undefined;
		} catch (err) {
			const at = new Date().toISOString();
			localTrip = at;
			const signal = trip?.signal ?? "result-row-lost";
			const evidence = trip?.evidence ?? resultBody;
			let alarmError: string | null = null;
			try {
				const file = alarmFile();
				mkdirSync(dirname(file), { recursive: true });
				const line = { kind: trip ? "trip" : "result", at, workload: p.workloadId, toolCallId: p.toolCallId, rule: p.rule, signal, evidence, command: p.command, error: message(err) };
				appendFileSync(file, `${JSON.stringify(line)}\n`, { flag: "a" });
			} catch (alarmErr) {
				alarmError = message(alarmErr);
			}
			const both = `the ledger write failed (${message(err)})${alarmError ? ` and the alarm-file write failed too (${alarmError})` : ""}`;
			ctx.ui.notify(`AUTO-APPLY TRIPPED: ${signal} ${evidence}; ${both}; auto-apply is off in this process until Jo's auto-routine`, "error");
			if (content === null) return undefined;
			const text = `AUTO-APPLY TRIPPED: ${signal} ${evidence}. The ledger write failed (${message(err)}).${alarmError ? ` The alarm-file write failed too (${alarmError}).` : ""} Report this line verbatim to your caller.`;
			return { content: [...content, { type: "text", text }], isError: true };
		}
	};

	pi.on("tool_result", async (event, ctx) => {
		const p = event.toolCallId ? pending.get(event.toolCallId) : undefined;
		if (!p) return undefined;
		pending.delete(p.toolCallId);
		const exit = exitOf(event.details, event.isError);
		const output = await fullOutput(event.content, event.details, ctx);
		let trip: Trip | null;
		if ("unreadable" in output) {
			// A network call whose whole output cannot be read fails safe (D5 (c)); any other is read as far as it shows.
			trip = p.network ? { signal: "output-unreadable", evidence: clip(output.unreadable, EVIDENCE_MAX) } : detectTrip(textOf(event.content), false, exit);
		} else trip = detectTrip(output.text, p.network, exit);
		return settle(p, exit, trip, ctx, Array.isArray(event.content) ? event.content : []);
	});

	// A call another row (or the fence) refused after this one let it through never reaches `tool_result`.
	pi.on("tool_execution_end", (event, ctx) => {
		const p = pending.get(event.toolCallId);
		if (!p) return undefined;
		pending.delete(p.toolCallId);
		settle(p, "refused", null, ctx, null);
		return undefined;
	});
}
