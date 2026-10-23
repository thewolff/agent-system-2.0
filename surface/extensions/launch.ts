// The lane launch trigger and Jo's word to (re)launch (DESIGN-lane-launcher.md decisions 1, 7, 9;
// § 4 rows "Open-time trigger and tick catch-up" and "`orchestrator_launch_lane` tool").
//
// `triggerLaunch` is the one path every launcher takes: the surface runs the pure predicate over
// the rows the ledger reads now and, when it says launch, execs the lane starter
// (`bun surface/scripts/lane.ts launch <wl>`) through the extension API's `exec` — machinery, never
// the bash tool, so P-11 row 15 never sees it. The starter reserves inside its own transaction (the
// run that binds), so a flip or a second starter between the two runs is refused there, and this
// side writes nothing: a failure after the reservation wrote `launch-failed:` and the `lane-died:`
// message in the starter; a refusal wrote nothing. The result is one line for the tool result or
// the log. The open tool, the answer and withdrawal paths, the mode flip and the wake tick all call
// it; the tool below adds Jo's `launch-requested:` cause first, with Jo's `lane-model:` in the same
// transaction when `model` is given (MIGRATION.md item 85), and Jo's pick snapshot (`rank-shown: … by
// pick`, PLAN wl-mv8k039gvogt8g D6) before the request. The pre-check applies Jev ranking's gate
// (`rankGate`, D7) as the starter's reservation does, so in `order` / `parallel` a workload ranked
// below a launchable one is reported queued behind it and no starter runs; in `show` it is `verdictOf`.
import type { Ledger } from "../../ledger/src/index";
import {
	byHandLine, JO_HOLDER, LANE_SCRIPT, laneCap, laneModelBody, type LaunchVerdict, launchRequestedBody, modelProblem, STARTER_EXIT,
} from "../src/launch";
import { RETRY_LIMIT } from "../src/incident";
import { rankGate, readRankConfig, writePickSnapshot } from "../src/rank-launch";
import { relaunchState } from "../src/relaunch";
import { surfaceSession } from "../src/session";
import { DUE_PREFIX, LAUNCH_LANE_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY, type ToolResult } from "../src/types";

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");
/** The open and tick line for a workload the rank gate queues behind a higher-ranked launchable one. */
const queuedLine = (workloadId: string, above: string): string =>
	`${workloadId} queued behind ${above} (Jev rank); it launches once nothing ranked above it is launchable`;

export interface LaunchOutcome {
	/** The predicate said launch and the starter was run. */
	attempted: boolean;
	/** The starter's exit code (0 = a lane is running), or null when the starter was not run. */
	code: number | null;
	/** The one line for the tool result or the log; null when there is nothing to say (a `due:` row, the standing workload). */
	line: string | null;
}

/**
 * Run the predicate for one workload and exec the starter when it says launch. `who` is the
 * `requested-by` the starter records. Never throws: an exec failure is a line.
 */
export async function triggerLaunch(pi: SurfaceAPI, ledger: Ledger, env: Record<string, string | undefined>, workloadId: string, who: string): Promise<LaunchOutcome> {
	const rows = ledger.launchRows(workloadId, laneCap(env));
	if (!rows) return { attempted: false, code: null, line: `no workload ${workloadId}` };
	const verdict = rankGate(ledger, rows, readRankConfig(env));
	if (!verdict.launch) {
		switch (verdict.reason) {
			case "standing":
			case "due":
				return { attempted: false, code: null, line: null };
			case "user-driven":
				return { attempted: false, code: null, line: `${workloadId} is user-driven: no lane launches by itself; run it by hand with \`${byHandLine(workloadId)}\`` };
			case "held":
				return { attempted: false, code: null, line: `${workloadId} is held by ${rows.workload.holder} (lease until ${rows.workload.holder_lease_until ?? "none"}); nothing launched` };
			case "cap": {
				const live = ledger.liveLaneHolders(rows.now).map((l) => `${l.holder} on ${l.workloadId}`);
				return { attempted: false, code: null, line: `${workloadId} queued behind ${live.join(", ")} (cap ${rows.cap}); the tick launches it when a slot frees` };
			}
			case "awaiting-close":
				return { attempted: false, code: null, line: `${workloadId} is finished and awaiting close: its holder wrote done-because:; nothing launched` };
			case "died-not-relaunched":
				return { attempted: false, code: null, line: `${workloadId} has had a lane and no new cause: relaunch on your word with ${LAUNCH_LANE_TOOL}` };
			case "stopped":
				return { attempted: false, code: null, line: `${workloadId}'s lane was stopped by you or the ceiling: nothing relaunches it until your word with ${LAUNCH_LANE_TOOL}` };
			case "relaunch-exhausted":
				return { attempted: false, code: null, line: `${workloadId}'s lanes died ${RETRY_LIMIT} relaunches in a row without progress: nothing relaunches it until your word with ${LAUNCH_LANE_TOOL}, close, or instruct` };
			case "relaunch-backoff": {
				const s = relaunchState(rows);
				const when = s.kind === "waiting" ? `relaunch ${s.n} of ${s.lane} waits until ${s.until}` : "its relaunch waits out the backoff";
				return { attempted: false, code: null, line: `${workloadId}: its lane died; ${when}, then the tick relaunches it` };
			}
			case "closed":
				return { attempted: false, code: null, line: `${workloadId} is closed; nothing launched` };
			default: {
				// Jev ranking's refusals (D7): `ranked: below <wl>` and `parallel: <reason>`.
				const below = /^ranked: below (\S+)$/.exec(verdict.reason);
				if (below) return { attempted: false, code: null, line: queuedLine(workloadId, below[1]!) };
				return { attempted: false, code: null, line: `${workloadId} held by the parallel rule (Jev rank) — ${verdict.reason.replace(/^parallel: /, "")}; it launches when no lane it would run beside holds it` };
			}
		}
	}
	if (!pi.exec) return { attempted: false, code: null, line: `${workloadId}: the host has no exec for extensions, so the starter could not run; launch by hand with \`bun ${LANE_SCRIPT} launch ${workloadId}\`` };
	try {
		const r = await pi.exec("bun", [LANE_SCRIPT, "launch", workloadId, "--requested-by", who], { timeout: 30_000 });
		const out = (r.stdout.trim() || r.stderr.trim()).split("\n").filter(Boolean);
		const last = out[out.length - 1] ?? (r.killed ? "the starter was killed before it printed" : `the starter exited ${r.code} without a line`);
		// The reservation's own gate run binds: a higher-ranked workload that became launchable after the pre-check queues this one.
		const below = r.code === STARTER_EXIT["not-launchable"] ? /not launched: ranked: below (\S+)$/.exec(last) : null;
		if (below) return { attempted: true, code: r.code, line: queuedLine(workloadId, below[1]!) };
		return { attempted: true, code: r.code, line: r.code === 0 ? `${workloadId}: ${last}` : `${workloadId}: launch failed (starter exit ${r.code}): ${last}` };
	} catch (err) {
		return { attempted: true, code: null, line: `${workloadId}: the starter could not be run: ${String(err)}` };
	}
}

/**
 * The verdict alone, for the tick: whether a launch would be attempted now (the rank gate applied,
 * as `triggerLaunch` applies it), or the workload is awaiting close (the tick closes it). The tick
 * execs only on a launch verdict, so a refused workload — a queued one included — costs one read per
 * poll and no process. Null when there is no such workload.
 */
export function launchVerdict(ledger: Ledger, env: Record<string, string | undefined>, workloadId: string): LaunchVerdict | null {
	const rows = ledger.launchRows(workloadId, laneCap(env));
	return rows && rankGate(ledger, rows, readRankConfig(env));
}

export default function launchRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;
	pi.registerTool({
		name: LAUNCH_LANE_TOOL,
		loadMode: "essential",
		label: "Launch Lane",
		description:
			"Jo's word to (re)launch an autonomous lane on an open workload: after a lane died, after a plain stop, or to take a workload Jo holds back from them. " +
			"Records `launch-requested:` on the workload, then runs the launcher and returns its one line (the lane id, a refusal, or the typed failure). " +
			"A user-driven workload is not launched: the by-hand command is returned instead. " +
			"`model` (Jo's word only) names the model this workload's lanes run on, kept across relaunches until changed: an exact `provider/model` (e.g. `openai-codex/gpt-6-sol`) on a provider with a known lab, no `:level` suffix; `default` clears it. " +
			"A different model than the recorded session ran on starts a fresh session; a lane whose OMP does not report that model fails its launch. On a user-driven workload it is recorded for the by-hand lane.",
		parameters: z.object({
			workloadId: z.string().describe("The open workload (wl-…)."),
			reason: z.string().optional().describe("Why, in a few words (e.g. 'relaunch after death'); recorded in the request."),
			model: z.string().optional().describe("Jo's named model: exact provider/model (e.g. openai-codex/gpt-6-sol), no :level; `default` clears it. Omit to keep the one recorded."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const id = String(params.workloadId ?? "").trim();
			const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : null;
			const model = typeof params.model === "string" ? params.model.trim() : null;
			const problem = model === null ? null : modelProblem(model);
			if (problem !== null) return text(`Refused: ${problem}. Nothing was written.`);
			if (id === STANDING_WORKLOAD_ID) return text("The standing orchestrator workload never has a lane; nothing was written.");
			const ledger = s.ledger();
			const w = ledger.workload(id);
			if (!w) return text(`No workload ${id}; nothing was written.`);
			if (w.status === "closed") return text(`${id} is closed (${w.closed_at}); nothing was written.`);
			if (w.brief.startsWith(DUE_PREFIX)) return text(`${id} is a scheduled row: it never has a lane; nothing was written.`);
			if (w.mode === "user-driven") {
				if (model === null) return text(`${id} is user-driven: no lane launches by itself. Run it by hand with \`${byHandLine(id)}\`, or flip it with the word autonomous. Nothing was written.`);
				const modelId = ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: laneModelBody(model, s.now()) });
				return text(`Recorded lane model ${model} (${modelId}) on ${id}. It is user-driven: no lane launches by itself. Run it by hand with \`${byHandLine(id)}\`.`, { id, modelId });
			}
			const now = s.now();
			if (w.holder !== null && w.holder !== JO_HOLDER && (w.holder_lease_until === null || w.holder_lease_until >= now)) {
				return text(`${id} is held by ${w.holder} under a live lease (until ${w.holder_lease_until ?? "none"}); stop it first: \`as2 lane stop ${id}\`. Nothing was written.`);
			}
			// § B5 "X back to you": Jo's hold after a handoff is released with the request, in one transaction. Jo's pick snapshot
			// (D6: the waiting workloads in Jev order, pins ignored) lands in the same transaction, before the request it audits.
			const requestId = ledger.write(() => {
				if (w.holder === JO_HOLDER) {
					const r = ledger.releaseWorkload(id, { by: SURFACE_BY, holder: JO_HOLDER });
					if (!r.released) throw new Error(`Jo's hold on ${id} could not be released: held by ${r.holder ?? "nobody"}`);
				}
				writePickSnapshot(ledger, now);
				if (model !== null) ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: laneModelBody(model, now) });
				return ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: launchRequestedBody("jo", now, reason ?? undefined) });
			});
			const outcome = await triggerLaunch(pi, ledger, env, id, "jo");
			pi.appendEntry("surface-launch", { id, requestId, code: outcome.code });
			return text(`Recorded launch request ${requestId} on ${id}${model !== null ? ` with lane model ${model}` : ""}.${outcome.line ? ` ${outcome.line}` : ""}`, { id, requestId, code: outcome.code, attempted: outcome.attempted });
		},
	});
}
