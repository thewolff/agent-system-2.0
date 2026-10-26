// The lane-side writers behind § B3 lines 3, 4 and 5 (M5 fix round 1). The surface renders these
// lines; the events they are about happen in the lane's session, so the rows that write them live
// here, in the surface's own extension, and are inert on the orchestrator. Every write goes through
// the ledger module as the lane (P-11 row 10). Session identity comes from the gates' session
// (gates/src/session.ts: role, workload id, lane id, the original bash command under the M4b fence).
//
// - Claim and lease (§ B3 item 4; SPEC-2.0.md:411-412): a lane bound to a workload claims it at
//   session_start with a lease of LEASE_MS and renews at a third of that on the session context's
//   timer and at every turn end. A lapsed lease of a previous holder is recorded as a `lane-died:`
//   row *before* the claim replaces it (surface/src/signals.ts recordLapsedLease), so a takeover
//   never erases the death. Where OMP exposes the session's end — `session_shutdown`, fired on
//   process exit (pi-coding-agent/src/extensibility/shared-events.ts:92-95, "Fired on process exit
//   (SIGINT/SIGTERM)") — the lane records its own death if work is still open and releases the
//   workload; a process killed outright never reaches that handler, and its lease lapsing is the
//   fallback signal the surface reads. A won claim re-creates the workload's scratch root when it is missing
//   (the daily sweep removes an unheld root, serialized with claims under the ledger's write lock).
// - Leaked prompt (§ B3 item 5, first trigger; SPEC-2.0.md:424-449): `tool_approval_requested` /
//   `tool_approval_resolved` (extensibility/extensions/types.ts:924-940, emitted at
//   extensions/wrapper.ts:284-303 with sessionId, toolCallId, toolName, reason) and an `ask`
//   execution (`tool_execution_start` / `tool_execution_end` with toolName "ask", types.ts:807-831)
//   become `prompt-wait:` / `prompt-resolved:` rows keyed by lane and tool-call id; a wait still
//   open at session_shutdown is resolved as ended.
// - Runtime artifact (§ B3 item 3; SPEC-2.0.md:409-410): the lane declares each slice's artifact
//   command with the `slice_artifact` tool (an `assumption` entry, `artifact-command: …`); every
//   bash result whose command is a declared one writes that slice's `artifact-failed:` or
//   `artifact-passed:` outcome. A refused push is P-11 row 8's own writer, unchanged. A pair_run that
//   ran is read as its bash equivalent (gates/src/pair-call.ts canonicalResult; PLAN-2
//   wl-mvb9mw00ycfjeo D5), so a declared artifact run through the pairing tools records the same outcomes.
// - Artifact tree (wl-muptjioqjtvthc PLAN.md § 1): a declared artifact that exits 0 with the same
//   working tree (surface/src/wtree.ts) at its tool_call and its tool_result writes `artifact-tree:`.
//   The declarations of open, paused and done slices count (surface/src/signals.ts
//   recordableArtifactCommands; wl-mupzpidbb3ksg0 PLAN.md § 2): a done slice's tests re-run after a
//   rebase record the new tree on that slice. The outcome messages stay with live slices: a done
//   slice's run, passing or failing, writes no `artifact-failed:` / `artifact-passed:`.
// - Jo's instructions (MIGRATION.md § M7 follow-ups item 14): the lane is owed every instruction
//   row Jo wrote since the previous lane started (surface/src/launch.ts joInstructionsFor). The
//   lane script builds them into the first prompt; at before_agent_start the rows that prompt does
//   not name (written while the lane was starting) come back as a message, and from then on a
//   poll timer and every tool result push the rows not yet handed over as an aside, once each.
// - Test runner results (MIGRATION.md item 24; PLAN wl-muraerdsgw7gn4 § 4 items 2 and 6): on the
//   same poll and tool-result path, one aside per `test-run:` entry on the workload this lane has
//   not been handed (verdict, counts, the first failures, the result.json path), and one aside per
//   unsettled request whose runner went quiet past the 120 s mark, naming the call that settles it.
// - Scratch cap (PLAN wl-mv5oikd5jtquww § 1.5): at a turn end, at most once per SCRATCH_MEASURE_MS, the
//   lane measures its workload's scratch root (`du -sk`, bounded to SCRATCH_DU_MS). Crossing the cap
//   (AGENT_SYSTEM_SCRATCH_CAP_MB) writes one `scratch-over-cap:` entry, which surface/src/errors.ts renders
//   under needs-you, and the lane is told at the start of its next turn; a later measurement within the
//   cap writes `scratch-under-cap:`. Advisory: nothing is refused for size.
// - Merge-train tasks (PLAN wl-mv8s8srodefytc rev 17.1 D7): every unsettled `train-task:` this lane's workload owns
//   (surface/src/merge-train.ts `ownerTasks`) is handed over once per session: the lane script builds the open ones into
//   the first prompt, before_agent_start counts those the prompt names as handed over, and the poll and each tool result
//   push the rest as an aside. By-hand sessions included: a user-driven owner hears of its task only here.
// - Paired spend (PLAN wl-mvfkv7llkp7nk0 § 4.1, Jo's ruling in-mvfo7nphl9xn28): a by-hand lane (`launch:` cause
//   `interactive`) is never metered or stopped at the ceiling. At every turn start it gets its spend against the ceiling
//   in force as a context message, and at turn start and each final turn end Jo gets one pane line (ctx.ui.notify) per
//   further 25 % of the original ceiling (surface/src/ceiling.ts pairedSpendStep), past 100 % too. The session-file
//   offsets live in this session's state, so each measure reads only what OMP wrote since the last one.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homeDir, type InstructionRow, type Ledger, type SliceRow } from "../../ledger/src/index";
import { canonicalCall, canonicalResult } from "../../gates/src/pair-call";
import { SCRATCH_ENTRY, scratchRootFor } from "../../gates/src/scratch";
import { gateSession } from "../../gates/src/session";
import { effectiveCeiling, isByHandLane, originalCeiling, type PairedState, pairedSpendMessage, pairedSpendStep, scanSpend, type Spend, wallMinutes } from "../src/ceiling";
import { openScratchEntry } from "../src/errors";
import { ensureScratchRoot } from "../src/scratch-root";
import { controlEntries, exitClass, heldLive, holdersOf, instructionLine, joInstructionsFor, laneDir, scratchCapMb, trainTaskLines } from "../src/launch";
import { ownerTasks } from "../src/merge-train";
import {
	artifactCommandBody, artifactCommands, artifactFailedBody, artifactFailures, artifactPassedBody, artifactTreeBody, laneDeaths, laneDiedShutdownBody,
	promptResolvedBody, promptWaitBody, recordableArtifactCommands, recordLapsedLease,
} from "../src/signals";
import { parseHeartbeat, type ResultRecord, type RunRecord, runDirOf, runsRoot, STARTUP_LEASE_MS, testRuns } from "../src/test-run";
import {
	ARTIFACT_TOOL, type Ctx, INSTRUCTION_POLL_MS, INSTRUCTION_POLL_MS_ENV, LANE_FULL_TEST_TOOL, LEASE_MS, LEASE_MS_ENV, ORCHESTRATOR_RECIPIENT, type SurfaceAPI,
	type ToolResult,
} from "../src/types";
import { workingTree } from "../src/wtree";

interface LaneState {
	/** Open leaked-prompt waits this session observed, by tool-call id. */
	readonly waits: Map<string, { toolName: string; sessionId: string }>;
	renewing: boolean;
	/** Set by lane_release / lane_handoff: the lane no longer claims, renews, or reports its own death. */
	released: boolean;
	/** The renewal timer's handle from ctx.setInterval, for clearTimer on release. */
	timer: unknown;
	/** Instruction rows this session has been handed (in its prompt, at before_agent_start, or pushed). */
	readonly delivered: Set<string>;
	/** The first prompt has started (before_agent_start): pushes may follow, never precede it. */
	primed: boolean;
	/** The instruction poll's handle from ctx.setInterval, for clearTimer on release. */
	pollTimer: unknown;
	/** The working tree at a declared artifact's tool_call, by tool-call id, until its tool_result. */
	readonly trees: Map<string, { command: string; dir: string; repo: string; tree: string }>;
	/** `test-run:` entry ids this session has been handed as asides. */
	readonly testRuns: Set<string>;
	/** Train task ids this session has been handed (in its first prompt or as an aside). */
	readonly trainTasks: Set<string>;
	/** Run ids whose dead runner this session has been told about. */
	readonly deadRuns: Set<string>;
	/** When this session last measured its scratch root (ledger clock, ms), or null before the first measure. */
	scratchMeasuredAt: number | null;
	/** The scratch notice the lane gets at the start of its next turn, once. */
	scratchNotice: string | null;
	/** The paired spend meter: null until the first measure reads the lane's `launch:` entry, false for a lane not started by hand. */
	paired: { offsets: Map<string, number>; tally: Spend; pane: PairedState } | false | null;
}
const STORE = Symbol.for("agent-system-2.0/surface/lane-state");
type Store = WeakMap<object, LaneState>;
function laneState(ctx: Ctx): LaneState {
	const g = globalThis as unknown as Record<symbol, Store | undefined>;
	const store = (g[STORE] ??= new WeakMap());
	let st = store.get(ctx.sessionManager);
	if (!st) {
		st = {
			waits: new Map(), renewing: false, released: false, timer: null, delivered: new Set(), primed: false, pollTimer: null, trees: new Map(), testRuns: new Set(), deadRuns: new Set(),
			trainTasks: new Set(),
			scratchMeasuredAt: null, scratchNotice: null, paired: null,
		};
		store.set(ctx.sessionManager, st);
	}
	return st;
}

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
/** The customType of every message carrying Jo's instruction rows to a lane. */
const INSTRUCTIONS_TYPE = "lane-instructions";
/** The customType of the test runner's result and dead-runner asides. */
const TEST_RUN_TYPE = "lane-test-run";
/** The customType of a merge-train task's aside (D7). */
const TRAIN_TASK_TYPE = "lane-train-task";
/** How many failing tests an aside names; the rest are in result.json and the ledger entry (§ 4 item 2). */
const ASIDE_FAILURES = 10;
/** § 4 item 6: a request whose runner has given no sign of life past the 120 s mark is dead (the startup lease's length). */
const DEAD_RUNNER_MS = STARTUP_LEASE_MS;
/** The customType of the scratch-cap notice a lane gets at the start of its next turn. */
const SCRATCH_TYPE = "lane-scratch";
/** The customType of a by-hand lane's turn-start spend message (PLAN wl-mvfkv7llkp7nk0 § 4.1). */
const SPEND_TYPE = "lane-spend";
/** A lane measures its scratch root at most this often (PLAN wl-mv5oikd5jtquww § 1.5). */
export const SCRATCH_MEASURE_MS = 5 * 60_000;
/** The bound on one `du -sk`; past it du is killed and nothing is written. */
export const SCRATCH_DU_MS = 5_000;

/** `du -sk <root>` in KiB, bounded to `timeoutMs`; null when du cannot run, is killed, or prints no size (a missing root). */
export function scratchKib(root: string, timeoutMs = SCRATCH_DU_MS): number | null {
	const r = spawnSync("du", ["-sk", root], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
	if (r.error || r.signal) return null;
	// A subdirectory du cannot read makes it exit 1 with the total of the rest: still a size, and the cap is advisory.
	const m = /^(\d+)\s/.exec(r.stdout ?? "");
	return m ? Number(m[1]) : null;
}

/**
 * One cap check of a measured root (PLAN wl-mv5oikd5jtquww § 1.5), written as `o.by`, the lane holding the workload: over
 * the cap with no open `scratch-over-cap:` writes one, within it while one is open writes `scratch-under-cap:`; otherwise
 * nothing. "Open" reads the valid control entries (surface/src/launch.ts WRITERS: a holder's), as needs-you does.
 * Returns the body written, or null.
 */
export function scratchCapCheck(
	ledger: Pick<Ledger, "entries" | "holders" | "recordEntry">, o: { workloadId: string; by: string; root: string; capMb: number; kib: number },
): string | null {
	const over = o.kib > o.capMb * 1024;
	const entries = ledger.entries(o.workloadId, "assumption");
	const control = controlEntries(entries, holdersOf(entries, o.by, ledger.holders(o.workloadId)));
	const open = openScratchEntry(control, "scratch-over-cap", "scratch-under-cap") !== null;
	if (over === open) return null;
	const size = `${(o.kib / 1024).toFixed(1)} MiB`;
	const body = over
		? `${SCRATCH_ENTRY.overCap} ${size} over the ${o.capMb} MiB cap at ${o.root}`
		: `${SCRATCH_ENTRY.underCap} ${size} within the ${o.capMb} MiB cap at ${o.root}`;
	ledger.recordEntry({ by: o.by, workloadId: o.workloadId, kind: "assumption", body });
	return body;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** What the green line of an aside reads from the slice row, as the aside is built. */
export type AsideSlice = Pick<SliceRow, "state" | "artifact"> | null;

/** The green line: the runner completed the slice only when it is done with this run's own artifact (surface/src/test-run.ts settleArtifact); a red-main settles the same way (D8). */
function greenLine(slice: string, runId: string, row: AsideSlice, verdict: "green" | "red-main"): string {
	const what = verdict === "green" ? "this green" : "this red-main (every failure also fails on main's base, so the PR adds none)";
	if (row?.state === "done" && row.artifact?.startsWith(`test-run ${runId}: `)) return `The runner completed ${slice} on ${what}; a push after it needs a new run.`;
	const why = row === null ? "it is not in the ledger"
		: row.state === "done" ? "it was already done, with another artifact"
		: row.state === "paused" ? "it is paused on an open question"
		: `it is ${row.state}`;
	return `${verdict === "green" ? "Green" : "Red-main"}, but not settled: the runner did not complete ${slice} (${why}); it completes only a slice still open when it writes its result.`;
}

/** The aside for one `test-run:` entry: verdict, counts, the first failures with their first error lines, where the rest are, and what the lane does next (for a green, from `sliceRow`). */
export function testRunAside(workloadId: string, rec: RunRecord, res: ResultRecord, sliceRow: AsideSlice): string {
	const { slice } = rec.request;
	const part = (p: { pass: number; fail: number; skip: number; error: string | null }) => `${p.pass} passed, ${p.fail} failed, ${p.skip} skipped${p.error ? ` (error: ${oneLine(p.error)})` : ""}`;
	const lines = [`Test run ${res.runId} on ${workloadId}: ${res.verdict} at ${res.sha} (PR #${res.pr}, slice ${slice}, ledger entry ${res.entryId}).`];
	if (res.reason) lines.push(`Reason: ${oneLine(res.reason)}`);
	lines.push(`Full suite: ${res.full ? part(res.full) : "not run"}.`);
	lines.push(`Changed test files alone: ${res.solo.length === 0 ? "none" : res.solo.map((s) => `${s.file} ${part(s)}`).join("; ")}.`);
	const where = res.runDir ? join(res.runDir, "result.json") : `ledger entry ${res.entryId} (this run wrote no run dir)`;
	if (res.failures.length > 0) {
		const shown = res.failures.slice(0, ASIDE_FAILURES);
		lines.push(`Failing (${shown.length} of ${res.failures.length}${res.failures.length > shown.length ? `; the rest are in ${where}` : ""}):`);
		for (const f of shown) lines.push(`- [${f.part}] ${oneLine(f.name)}: ${oneLine(f.firstError)}`);
	}
	lines.push(`Result: ${where}`);
	if (res.verdict === "green" || res.verdict === "red-main") lines.push(greenLine(slice, res.runId, sliceRow, res.verdict));
	else if (res.verdict === "superseded") lines.push(`For the record only: a later request on ${slice} owns it, and this run settled nothing.`);
	else lines.push(`${slice} stays open: fix, push, then call ${LANE_FULL_TEST_TOOL} with pr ${res.pr} and slice ${slice} again.`);
	return lines.join("\n");
}

/** The run's heartbeat file time in ms, or null when there is none or it is not this run's (surface/src/test-run.ts parseHeartbeat). */
function heartbeatAt(root: string, runId: string): number | null {
	try {
		return parseHeartbeat(readFileSync(join(runDirOf(root, runId), "heartbeat"), "utf8"), runId);
	} catch {
		return null;
	}
}

/**
 * The lane gave the workload up on purpose (lane_release / lane_handoff, DESIGN-lane-launcher.md
 * decision 10): no further claim or renewal, the renewal timer stops (ctx.clearTimer is host
 * contract, gates/src/host.ts HOST_MEMBERS), and session_shutdown writes no lane-died:.
 */
export function markReleased(ctx: Ctx): void {
	const st = laneState(ctx);
	st.released = true;
	if (st.timer !== null) {
		ctx.clearTimer(st.timer);
		st.timer = null;
	}
	if (st.pollTimer !== null) {
		ctx.clearTimer(st.pollTimer);
		st.pollTimer = null;
	}
}

/** Has this session released (lane_release / lane_handoff)? Every lane tool refuses afterwards. */
export function isReleased(ctx: Ctx): boolean {
	return laneState(ctx).released;
}

export default function laneRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const positive = (name: string, fallback: number): number => {
		const n = Number(env[name]);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	};
	const leaseMs = (): number => positive(LEASE_MS_ENV, LEASE_MS);
	const instructionPollMs = (): number => positive(INSTRUCTION_POLL_MS_ENV, INSTRUCTION_POLL_MS);
	/** A bound lane or a hand of one: its workload's signal rows are written as this session. */
	const laneSide = (ctx: Ctx) => {
		const s = gateSession(ctx, env);
		return s.workloadId !== null && s.role !== "orchestrator" ? s : null;
	};
	const warn = (ctx: Ctx, what: string, err: unknown) => ctx.ui.notify(`${what} could not be written to the ledger: ${String(err)}`, "warning");

	/**
	 * After a won claim, the workload's scratch root when it is missing (surface/src/scratch-root.ts ensureScratchRoot). The daily
	 * sweep removes an unheld root under the ledger's write lock, serialized with every claim (surface/scripts/scratch-sweep.ts),
	 * so a claim that wins after a lapse (a preclaim that ran out before session start, a renewal after the lease lapsed)
	 * can find it gone; the launcher's prepare re-creates it for a new launch, this for a lane that took the workload back.
	 */
	const keepScratchRoot = (ctx: Ctx, what: string, workloadId: string): void => {
		try {
			const home = homeDir(env);
			try {
				lstatSync(scratchRootFor(home, workloadId));
				return;
			} catch {}
			ensureScratchRoot(home, workloadId);
		} catch (err) {
			ctx.ui.notify(`${what}: the scratch root of ${workloadId} is missing and could not be re-created: ${String(err)}`, "warning");
		}
	};

	/** Claim (or renew) the workload for this lane; a previous holder's lapsed lease is persisted first. */
	const claim = (ctx: Ctx, what: string): void => {
		const s = gateSession(ctx, env);
		if (!s.bound || laneState(ctx).released) return;
		try {
			const ledger = s.ledger();
			const w = ledger.workload(s.workloadId!);
			if (!w || w.status !== "open") return;
			if (w.holder && w.holder !== s.laneId) recordLapsedLease(ledger, w, s.laneId);
			const r = ledger.claimWorkload(w.id, { by: s.laneId, holder: s.laneId, leaseMs: leaseMs() });
			if (!r.won) ctx.ui.notify(`${what}: workload ${w.id} is held by ${r.holder ?? "nobody"} under a live lease; this lane (${s.laneId}) does not hold it.`, "warning");
			else keepScratchRoot(ctx, what, w.id);
		} catch (err) {
			warn(ctx, `${what}: the workload claim`, err);
		}
	};

	/** Jo's instruction rows a bound, unreleased lane is owed and has not been handed yet, oldest first. */
	const undelivered = (ctx: Ctx): { wl: string; rows: InstructionRow[] } | null => {
		const s = gateSession(ctx, env);
		const st = laneState(ctx);
		if (!s.bound || st.released) return null;
		const ledger = s.ledger();
		const entries = ledger.entries(s.workloadId!);
		const w = ledger.workload(s.workloadId!);
		const control = controlEntries(entries, holdersOf(entries, w?.holder ?? null));
		const rows = joInstructionsFor(control, ledger.instructions(s.workloadId!), s.laneId).filter((i) => !st.delivered.has(i.id));
		return { wl: s.workloadId!, rows };
	};

	/** Push the rows Jo wrote since the lane last looked, once each, as an aside (a turn starts if the lane is idle). */
	const pushInstructions = (ctx: Ctx, what: string): void => {
		const st = laneState(ctx);
		if (!st.primed || st.released || !pi.sendMessage) return;
		try {
			const due = undelivered(ctx);
			if (!due || due.rows.length === 0) return;
			for (const i of due.rows) st.delivered.add(i.id);
			const content = [`New instruction(s) from Jo on ${due.wl} since your last turn (the newest that applies wins):`, ...due.rows.map(instructionLine)].join("\n");
			pi.sendMessage({ customType: INSTRUCTIONS_TYPE, content, display: true }, { deliverAs: "aside", triggerTurn: true });
		} catch (err) {
			warn(ctx, `${what}: Jo's instructions`, err);
		}
	};

	/**
	 * The test runner's news for this lane (PLAN wl-muraerdsgw7gn4 § 4 items 2 and 6), once each: an
	 * aside per `test-run:` entry not yet handed over, and one per unsettled request whose heartbeat
	 * (or, before the first one, the request itself) is older than the 120 s mark.
	 */
	const pushTestRuns = (ctx: Ctx, what: string): void => {
		const st = laneState(ctx);
		if (!st.primed || st.released || !pi.sendMessage) return;
		const s = gateSession(ctx, env);
		if (!s.bound) return;
		try {
			const ledger = s.ledger();
			const records = testRuns(ledger.entries(s.workloadId!));
			for (const rec of records) {
				for (const res of rec.results) {
					if (st.testRuns.has(res.entryId)) continue;
					st.testRuns.add(res.entryId);
					pi.sendMessage({ customType: TEST_RUN_TYPE, content: testRunAside(s.workloadId!, rec, res, ledger.slice(rec.request.slice)), display: true }, { deliverAs: "aside", triggerTurn: true });
				}
			}
			const pending = records.filter((r) => r.results.length === 0 && !st.deadRuns.has(r.request.runId));
			if (pending.length === 0) return;
			const nowMs = Date.parse(ledger.now());
			const root = runsRoot(env);
			for (const rec of pending) {
				const { runId, pr, slice } = rec.request;
				const lastSign = heartbeatAt(root, runId) ?? Date.parse(rec.request.createdAt);
				if (nowMs - lastSign <= DEAD_RUNNER_MS) continue;
				st.deadRuns.add(runId);
				const content = `runner for ${runId} died; call ${LANE_FULL_TEST_TOOL} again (PR #${pr}, slice ${slice}): no heartbeat for ${Math.round((nowMs - lastSign) / 1000)} s, and that call settles it as \`error runner died\` and starts a new run.`;
				pi.sendMessage({ customType: TEST_RUN_TYPE, content, display: true }, { deliverAs: "aside", triggerTurn: true });
			}
		} catch (err) {
			ctx.ui.notify(`${what}: the test runner's results could not be read: ${String(err)}`, "warning");
		}
	};

	/** Each unsettled train task this lane's workload owns (D7), once per session, as an aside that starts a turn. */
	const pushTrainTasks = (ctx: Ctx, what: string): void => {
		const st = laneState(ctx);
		if (!st.primed || st.released || !pi.sendMessage) return;
		const s = gateSession(ctx, env);
		if (!s.bound) return;
		try {
			for (const t of ownerTasks(s.ledger(), s.workloadId!)) {
				if (st.trainTasks.has(t.id)) continue;
				st.trainTasks.add(t.id);
				const content = [`A merge train returned a PR to ${s.workloadId}; fix it before other work:`, ...trainTaskLines(t)].join("\n");
				pi.sendMessage({ customType: TRAIN_TASK_TYPE, content, display: true }, { deliverAs: "aside", triggerTurn: true });
			}
		} catch (err) {
			warn(ctx, `${what}: merge-train tasks`, err);
		}
	};

	/** Everything the poll and each tool result hand the lane between turns. */
	const pushAsides = (ctx: Ctx, what: string): void => {
		pushInstructions(ctx, what);
		pushTestRuns(ctx, what);
		pushTrainTasks(ctx, what);
	};

	const z = pi.zod;
	pi.registerTool({
		name: ARTIFACT_TOOL,
		loadMode: "essential",
		label: "Declare Slice Artifact",
		description:
			"Declare the runtime-artifact command of a slice of this lane's workload (the command that proves its done-condition, e.g. `bun test x.test.ts`). " +
			"From then on every bash result running exactly that command records the slice's artifact outcome; two failures since the last pass surface to Jo (§ B3 item 3).",
		parameters: z.object({
			slice: z.string().describe("The slice id (sl-…) on this lane's workload."),
			command: z.string().describe("The exact bash command line that is the slice's runtime artifact."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = gateSession(ctx, env);
			if (!s.bound) return text("This session is not a lane bound to a workload; nothing was declared.");
			// The same gate as the lane tools (lane-tools.ts `owned`, Codex review S4): released, or not the live holder, writes nothing.
			if (laneState(ctx).released) return text(`This lane released ${s.workloadId} (or handed it to Jo); its work is over and nothing was declared.`);
			const slice = String(params.slice ?? "").trim();
			const command = String(params.command ?? "").trim();
			if (!slice || !command) return text("A declaration names a slice id and a command; nothing was declared.");
			const ledger = s.ledger();
			const w = ledger.workload(s.workloadId!);
			if (!w || w.status !== "open") return text(`Workload ${s.workloadId} is ${w?.status ?? "missing"}; nothing was declared.`);
			if (w.holder !== s.laneId || !heldLive(w, ledger.now())) {
				const who = w.holder === null ? "nobody" : w.holder === s.laneId ? `${s.laneId} under a lapsed lease` : w.holder;
				return text(`Workload ${w.id} is held by ${who}, not by this lane (${s.laneId}) under a live lease; nothing was declared.`);
			}
			const row = ledger.slice(slice);
			if (!row || row.workload_id !== s.workloadId) return text(`Slice ${slice} is not on workload ${s.workloadId}; nothing was declared.`);
			if (row.state === "done" || row.state === "cancelled") return text(`Slice ${slice} is ${row.state}; nothing was declared.`);
			const id = ledger.recordEntry({ by: s.laneId, workloadId: s.workloadId!, sliceId: slice, kind: "assumption", body: artifactCommandBody(command) });
			return text(`Declared the runtime artifact of ${slice}: \`${command}\` (entry ${id}). Its bash results now record the slice's artifact outcomes.`, { id });
		},
	});

	pi.on("session_start", (_e, ctx) => {
		const s = gateSession(ctx, env);
		if (!s.bound) return undefined;
		claim(ctx, "lane start");
		const st = laneState(ctx);
		if (!st.renewing) {
			st.renewing = true;
			st.timer = ctx.setInterval(() => claim(ctx, "lease renewal"), Math.max(1, Math.floor(leaseMs() / 3)));
		}
		return undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		const st = laneState(ctx);
		const s = gateSession(ctx, env);
		if (!s.bound || st.released) return undefined;
		let message: { customType: string; content: string; display: boolean } | undefined;
		try {
			const due = undelivered(ctx);
			if (due) {
				// Rows the prompt names were built into it (surface/scripts/lane.ts); the rest arrived while the lane was starting.
				const missing = due.rows.filter((i) => !event.prompt.includes(i.id));
				for (const i of due.rows) st.delivered.add(i.id);
				if (missing.length > 0) {
					const content = [`Jo's instructions on ${due.wl} not in your prompt (oldest first; the newest that applies wins):`, ...missing.map(instructionLine)].join("\n");
					message = { customType: INSTRUCTIONS_TYPE, content, display: true };
				}
			}
		} catch (err) {
			warn(ctx, "agent start: Jo's instructions", err);
		}
		try {
			// The tasks the lane script built into the first prompt are handed over; one recorded since comes as an aside.
			for (const t of ownerTasks(s.ledger(), s.workloadId!)) if (event.prompt.includes(t.id)) st.trainTasks.add(t.id);
		} catch (err) {
			warn(ctx, "agent start: merge-train tasks", err);
		}
		st.primed = true;
		if (st.pollTimer === null) st.pollTimer = ctx.setInterval(() => pushAsides(ctx, "instruction poll"), instructionPollMs());
		return message ? { message } : undefined;
	});

	/** The turn-end scratch measure (PLAN wl-mv5oikd5jtquww § 1.5): a bound, unreleased lane, at most once per SCRATCH_MEASURE_MS. */
	const measureScratch = (ctx: Ctx): void => {
		const s = gateSession(ctx, env);
		const st = laneState(ctx);
		if (!s.bound || st.released) return;
		try {
			const ledger = s.ledger();
			const now = Date.parse(ledger.now());
			if (st.scratchMeasuredAt !== null && now - st.scratchMeasuredAt < SCRATCH_MEASURE_MS) return;
			st.scratchMeasuredAt = now;
			const root = scratchRootFor(homeDir(env), s.workloadId!);
			const kib = scratchKib(root);
			if (kib === null) return;
			const body = scratchCapCheck(ledger, { workloadId: s.workloadId!, by: s.laneId, root, capMb: scratchCapMb(env), kib });
			if (body?.startsWith(SCRATCH_ENTRY.overCap)) {
				st.scratchNotice = `Your scratch root is over its cap: ${body.slice(SCRATCH_ENTRY.overCap.length).trim()}. Jo sees it under needs-you. Delete what you no longer need under "$AS2_SCRATCH"; nothing is refused for size.`;
			}
		} catch (err) {
			warn(ctx, "turn end: the scratch measure", err);
		}
	};

	/**
	 * One paired measure (PLAN wl-mvfkv7llkp7nk0 § 4.1) of a bound, unreleased by-hand lane: the workload's spend (every
	 * session file under its lane dir, read from this session's offsets, and the lane run time, as the runner's meter counts
	 * them), Jo's pane lines for the further 25 % marks of the original ceiling, and the turn-start message against the
	 * ceiling in force, returned. Null for any other lane, which the first measure caches.
	 */
	const measurePaired = (ctx: Ctx, what: string): string | null => {
		const s = gateSession(ctx, env);
		const st = laneState(ctx);
		if (!s.bound || st.released || st.paired === false) return null;
		try {
			const ledger = s.ledger();
			const w = ledger.workload(s.workloadId!);
			if (!w) return null;
			const entries = ledger.entries(w.id);
			const control = controlEntries(entries, holdersOf(entries, w.holder));
			if (st.paired === null) {
				if (!isByHandLane(control, s.laneId)) {
					st.paired = false;
					return null;
				}
				st.paired = { offsets: new Map(), tally: { usd: 0, tokens: 0, wallMin: 0 }, pane: { shown: null } };
			}
			const m = st.paired;
			m.tally = scanSpend(join(laneDir(w.id, homeDir(env)), "sessions"), m.offsets, m.tally);
			// The run in progress is this lane's since its first lane-started:, until its lane-exit: is written (wallMinutes).
			const started = control.find((c) => c.prefix === "lane-started" && c.laneId === s.laneId);
			const running = started !== undefined && !control.some((c) => c.prefix === "lane-exit" && c.laneId === s.laneId);
			const spend: Spend = { ...m.tally, wallMin: wallMinutes(control, Date.parse(ledger.now()), running ? Date.parse(started.createdAt) : null) };
			const instructions = ledger.instructions(w.id);
			const step = pairedSpendStep(m.pane, w.id, spend, originalCeiling(control, instructions, w.stakes));
			m.pane = step.state;
			for (const line of step.lines) ctx.ui.notify(line, "info");
			return pairedSpendMessage(spend, effectiveCeiling(control, instructions, w.stakes));
		} catch (err) {
			ctx.ui.notify(`${what}: the paired spend could not be read: ${String(err)}`, "warning");
			return null;
		}
	};

	pi.on("agent_end", (event, ctx) => {
		if (!event.willContinue) {
			claim(ctx, "turn end");
			measureScratch(ctx);
			measurePaired(ctx, "turn end");
		}
		return undefined;
	});

	// A by-hand lane's spend at every turn start (§ 4.1 (a)), for the lane: Jo's figure is the pane line.
	pi.on("before_agent_start", (_event, ctx) => {
		const content = measurePaired(ctx, "agent start");
		return content === null ? undefined : { message: { customType: SPEND_TYPE, content, display: false } };
	});

	// The scratch-cap notice, once, at the start of the lane's next turn.
	pi.on("before_agent_start", (_event, ctx) => {
		const st = laneState(ctx);
		if (st.scratchNotice === null || st.released) return undefined;
		const content = st.scratchNotice;
		st.scratchNotice = null;
		return { message: { customType: SCRATCH_TYPE, content, display: true } };
	});

	pi.on("session_shutdown", (_e, ctx) => {
		const s = laneSide(ctx);
		if (!s) return undefined;
		const st = laneState(ctx);
		try {
			const ledger = s.ledger();
			for (const [callId, w] of st.waits) {
				ledger.enqueue({ by: s.laneId, workloadId: s.workloadId!, sliceId: s.currentSlice(), sender: s.laneId, recipient: ORCHESTRATOR_RECIPIENT, body: promptResolvedBody(w.toolName, callId, w.sessionId, "ended: the session shut down") });
			}
			st.waits.clear();
			if (!s.bound || st.released) return undefined;
			const w = ledger.workload(s.workloadId!);
			if (!w || w.status !== "open" || w.holder !== s.laneId) return undefined;
			const inFlight = w.open_slices + w.paused_slices;
			// One shared exit classification (DESIGN-lane-launcher.md decision 14): an accepted stop, a park, or the runner's
			// recorded intended decision (`lane-decided:`, written before EOF) is intended and writes no lane-died:; a release
			// the lane made itself returned before this point. Anything else with work open is the death signal, a receipt or
			// not, Jo's own terminal (`as2 lane <wl>`) included: quitting with a slice open is a death the wake render names, not
			// a silent end. One death per lane (MIGRATION.md item 40, D5): the runner enqueues its own before EOF, and
			// `finish()` keeps the same guard.
			const entries = ledger.entries(w.id);
			const intended = exitClass(controlEntries(entries, holdersOf(entries, w.holder)), s.laneId) === "intended";
			if (inFlight > 0 && !intended && !laneDeaths(ledger, w.id).some((d) => d.holder === s.laneId)) {
				ledger.enqueue({ by: s.laneId, workloadId: w.id, sender: s.laneId, recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody(s.laneId, ledger.now(), inFlight) });
			}
			ledger.releaseWorkload(w.id, { by: s.laneId, holder: s.laneId });
		} catch (err) {
			warn(ctx, "session shutdown: the lane's release", err);
		}
		return undefined;
	});

	const waitBegan = (ctx: Ctx, toolName: string, toolCallId: string, sessionId: string, reason: string): void => {
		const s = laneSide(ctx);
		if (!s) return;
		try {
			laneState(ctx).waits.set(toolCallId, { toolName, sessionId });
			s.ledger().enqueue({ by: s.laneId, workloadId: s.workloadId!, sliceId: s.currentSlice(), sender: s.laneId, recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody(toolName, toolCallId, sessionId, reason) });
		} catch (err) {
			warn(ctx, `the prompt-wait row for ${toolName} (${toolCallId})`, err);
		}
	};
	const waitEnded = (ctx: Ctx, toolName: string, toolCallId: string, sessionId: string, outcome: string): void => {
		const s = laneSide(ctx);
		if (!s) return;
		const st = laneState(ctx);
		if (!st.waits.delete(toolCallId)) return;
		try {
			s.ledger().enqueue({ by: s.laneId, workloadId: s.workloadId!, sliceId: s.currentSlice(), sender: s.laneId, recipient: ORCHESTRATOR_RECIPIENT, body: promptResolvedBody(toolName, toolCallId, sessionId, outcome) });
		} catch (err) {
			warn(ctx, `the prompt-resolved row for ${toolName} (${toolCallId})`, err);
		}
	};

	pi.on("tool_approval_requested", (event, ctx) => {
		waitBegan(ctx, event.toolName, event.toolCallId, event.sessionId, event.reason ?? "tool approval requested");
		return undefined;
	});
	pi.on("tool_approval_resolved", (event, ctx) => {
		waitEnded(ctx, event.toolName, event.toolCallId, event.sessionId, `${event.approved ? "approved" : "denied"}${event.reason ? `: ${event.reason}` : ""}`);
		return undefined;
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName !== "ask") return undefined;
		const args = (event.args && typeof event.args === "object" ? event.args : {}) as Record<string, unknown>;
		const asked = typeof args.question === "string" ? args.question : typeof args.prompt === "string" ? args.prompt : JSON.stringify(args);
		waitBegan(ctx, "ask", event.toolCallId, "", `ask: ${asked}`);
		return undefined;
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "ask") waitEnded(ctx, "ask", event.toolCallId, "", event.isError ? "ended with an error" : "answered");
		return undefined;
	});

	// The tree a declared artifact runs on, taken before it runs. Surface loads before the gates, so the
	// command here is still the model's; originalInput also covers a fence that ran first.
	pi.on("tool_call", (typed, ctx) => {
		const event = canonicalCall(typed, ctx.cwd);
		if (event.toolName !== "bash" || !event.toolCallId) return undefined;
		const s = laneSide(ctx);
		if (!s) return undefined;
		try {
			const input = s.originalInput(event);
			const command = String(input.command ?? "").trim();
			if (!command || ![...recordableArtifactCommands(s.ledger(), s.workloadId!).values()].includes(command)) return undefined;
			const dir = typeof input.cwd === "string" && input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
			const before = workingTree(dir);
			if (before) laneState(ctx).trees.set(event.toolCallId, { command, dir, ...before });
		} catch (err) {
			warn(ctx, "the artifact's working tree", err);
		}
		return undefined;
	});

	pi.on("tool_result", (result, ctx) => {
		pushAsides(ctx, "tool result");
		const event = canonicalResult(result, ctx.cwd);
		if (event.toolName !== "bash") return undefined;
		const st = laneState(ctx);
		const before = event.toolCallId ? st.trees.get(event.toolCallId) : undefined;
		if (event.toolCallId) st.trees.delete(event.toolCallId);
		const s = laneSide(ctx);
		if (!s) return undefined;
		const d = (event.details && typeof event.details === "object" ? event.details : {}) as Record<string, unknown>;
		if ("async" in d && d.async !== undefined && d.async !== null) return undefined; // backgrounded: no outcome yet
		try {
			const ledger = s.ledger();
			const command = String(s.originalInput(event).command ?? "").trim();
			if (!command) return undefined;
			// BashToolDetails.exitCode is set only for a completed non-zero exit (pi-tui src/tools/bash.ts:38-39), as row 3 reads it.
			const code = typeof d.exitCode === "number" ? d.exitCode : event.isError ? 1 : 0;
			// The tree it ran on, only when it passed and nothing changed the tree during the run: on every
			// open, paused or done slice that declared this command.
			if (code === 0 && before?.command === command) {
				const after = workingTree(before.dir);
				if (after && after.repo === before.repo && after.tree === before.tree) {
					for (const [sliceId, artifact] of recordableArtifactCommands(ledger, s.workloadId!)) {
						if (artifact !== command) continue;
						ledger.recordEntry({ by: s.laneId, workloadId: s.workloadId!, sliceId, kind: "assumption", body: artifactTreeBody({ repo: after.repo, tree: after.tree, command }) });
					}
				}
			}
			// The outcome messages, on live slices only.
			const slices = [...artifactCommands(ledger, s.workloadId!)].filter(([, artifact]) => artifact === command).map(([sliceId]) => sliceId);
			if (slices.length === 0) return undefined;
			const call = event.toolCallId ?? "unknown";
			for (const sliceId of slices) {
				if (code !== 0) {
					ledger.enqueue({ by: s.laneId, workloadId: s.workloadId!, sliceId, sender: s.laneId, recipient: ORCHESTRATOR_RECIPIENT, body: artifactFailedBody(`\`${command}\` exited ${code} (tool call ${call})`) });
				} else if ((artifactFailures(ledger, s.workloadId!).get(sliceId)?.n ?? 0) > 0) {
					ledger.enqueue({ by: s.laneId, workloadId: s.workloadId!, sliceId, sender: s.laneId, recipient: ORCHESTRATOR_RECIPIENT, body: artifactPassedBody(`\`${command}\` exited 0 (tool call ${call})`) });
				}
			}
		} catch (err) {
			warn(ctx, "the slice's artifact outcome", err);
		}
		return undefined;
	});
}
