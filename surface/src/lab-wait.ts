// Normal autonomous unnamed lanes wait for their own lab (PLAN wl-mvh249u2w238jk D0–D5).
// A decision pass shares one quota snapshot, comparison row and default-model prediction across every candidate.
import { headroom, type Headroom } from "../../classifier/src/headroom";
import { labOf } from "../../classifier/src/lab";
import { loadTierTable, modelIdentity } from "../../classifier/src/tier-table";
import { type EntryRow, type InstructionRow, LANE_RUNNER_BY, type Ledger, type ReserveRows, type WorkloadRow } from "../../ledger/src/index";
import { type ControlEntry, controlEntries, laneModel, laneStarted, type LaunchVerdict, modelProblem } from "./launch";
import { isTrainOrFix } from "./merge-train";
import { installedConfigPath } from "./pair-suggest";
import { SURFACE_BY } from "./types";

export interface LabWaitContext {
	room: Headroom;
	strongRow: readonly string[];
	prediction: string | null;
}

export interface LabWait {
	entryId: string;
	model: string;
	reason: string;
}

/** Fresh rows matter: Jo's pin, stakes/mode change or train designation takes effect at the next decision. */
export function waits(w: Pick<WorkloadRow, "stakes" | "mode">, control: readonly ControlEntry[], entries: readonly EntryRow[], instructions: readonly InstructionRow[]): boolean {
	return w.stakes === "normal" && w.mode === "autonomous" && laneModel(control) === null && !isTrainOrFix(entries, instructions);
}

function parseWait(c: ControlEntry): (LabWait & { clear: boolean }) | null {
	if (c.prefix !== "lab-wait") return null;
	const m = /^(\S+)\s+(clear\s+)?\(([\s\S]+)\)$/.exec(c.rest);
	if (!m || m[1] === "default" || modelProblem(m[1]!) !== null) return null;
	return { entryId: c.id, model: m[1]!, reason: m[3]!, clear: m[2] !== undefined };
}

/** An episode ends at a valid launch attempt or a clear, never at a refusal for another reason. */
export function standingWait(control: readonly ControlEntry[]): LabWait | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix === "launch" && /^cause\s+.+?\s+requested-by\s+\S+$/.test(c.rest)) return null;
		const wait = parseWait(c);
		if (wait) return wait.clear ? null : { entryId: wait.entryId, model: wait.model, reason: wait.reason };
	}
	return null;
}

/** Newest recorded lane home; legacy moves keep their source, not the substituted model. A clear preserves a waited home. */
export function homeModel(control: readonly ControlEntry[]): string | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "lane-started" || c.laneId === null) continue;
		const started = laneStarted([c]);
		if (!started) continue;
		if (started.homeModel) return started.homeModel;
		const moved = control.findLast(e => e.prefix === "lane-headroom" && e.laneId === c.laneId && /^(\S+) -> \S+ \(/.test(e.rest));
		if (moved) return /^(\S+) ->/.exec(moved.rest)![1]!;
		if (started.ranModel) return started.ranModel;
	}
	for (let i = control.length - 1; i >= 0; i--) {
		const wait = parseWait(control[i]!);
		if (wait) return wait.model;
	}
	return null;
}

/** The newest fresh unnamed lane's OMP start model among in-flight workloads, never its moved model. */
export function predictionOf(ledger: Ledger): string | null {
	const entries = ledger.db.query<EntryRow, []>(
		"SELECT e.* FROM entries e JOIN workloads w ON w.id = e.workload_id WHERE w.status = 'open' AND e.kind = 'assumption' AND e.body LIKE 'lane-started:%' ORDER BY e.created_at, e.rowid",
	).all();
	const control = controlEntries(entries);
	for (let i = control.length - 1; i >= 0; i--) {
		const started = laneStarted([control[i]!]);
		if (!started?.startModel || started.model !== null || started.argv.some(a => a === "--resume" || a.startsWith("--resume="))) continue;
		return started.startModel;
	}
	return null;
}

export function readLabWaitContext(ledger: Ledger, env: Record<string, string | undefined> = process.env): LabWaitContext {
	const room = headroom({ path: env.AS2_HEADROOM_POLLS });
	let strongRow: string[] = [];
	try {
		strongRow = loadTierTable(installedConfigPath(env)).strong.map(modelIdentity);
	} catch {
		// Comparison unavailable: evaluate the eligible source on its own (r5 m2). Excluded runners keep their existing errors.
	}
	return { room, strongRow, prediction: predictionOf(ledger) };
}

/** Only called after the ordinary predicate admits. A refusal spends no cause and reserves no slot. */
export function labGate(rows: ReserveRows, wait: LabWaitContext): Extract<LaunchVerdict, { launch: false }> | null {
	const control = controlEntries(rows.entries);
	if (!waits(rows.workload, control, rows.entries, rows.instructions)) return null;
	const model = homeModel(control) ?? wait.prediction;
	if (model === null) return null;
	const out = wait.room.decisionFor(model, wait.strongRow).out;
	return out === null ? null : { launch: false, reason: `lab-out: ${model} (${out})` };
}

export function labOut(reason: string): { model: string; reason: string } | null {
	const m = /^lab-out: (\S+) \(([\s\S]+)\)$/.exec(reason);
	return m ? { model: m[1]!, reason: m[2]! } : null;
}

/** Both the surface and the runner deduplicate under the ledger's write lock, including across processes. */
export function recordLabWait(ledger: Ledger, workloadId: string, model: string, reason: string, by: typeof SURFACE_BY | typeof LANE_RUNNER_BY = SURFACE_BY): LabWait | null {
	return ledger.write(() => {
		const w = ledger.workload(workloadId);
		if (!w || w.status !== "open") return null;
		const standing = standingWait(controlEntries(ledger.entries(workloadId, "assumption")));
		if (standing) return standing;
		const clean = reason.replace(/\s+/g, " ").trim();
		const entryId = ledger.recordEntry({ by, workloadId, kind: "assumption", body: `lab-wait: ${model} (${clean})` });
		return { entryId, model, reason: clean };
	});
}

/** Clear solely from the standing wait's condition, even when cap, held or rank refuses a launch. */
export function reconcileLabWait(ledger: Ledger, workloadId: string, wait: LabWaitContext): LabWait | null {
	return ledger.write(() => {
		const w = ledger.workload(workloadId);
		if (!w) return null;
		const entries = ledger.entries(workloadId, "assumption");
		const control = controlEntries(entries);
		const standing = standingWait(control);
		if (!standing) return null;
		const eligible = waits(w, control, entries, ledger.instructions(workloadId));
		if (eligible && wait.room.decisionFor(standing.model, wait.strongRow).out !== null) return standing;
		ledger.recordEntry({ by: SURFACE_BY, workloadId, kind: "assumption", body: `lab-wait: ${standing.model} clear (${eligible ? "guard admits its lab" : "no longer waiting-eligible"})` });
		return null;
	});
}

/** Same line for a direct launch response and a tick notice (which prepends `tick: `). */
export function waitLine(workloadId: string, wait: LabWait): string {
	return `${workloadId} waits for ${labOf(wait.model) ?? wait.model}: ${wait.reason}; it launches on ${wait.model} when the guard admits it`;
}

/** Render stored state without reading the polls: eligibility is fresh, clearing belongs to the tick. */
export function waitingLane(w: Pick<WorkloadRow, "stakes" | "mode">, entries: readonly EntryRow[], instructions: readonly InstructionRow[]): string | null {
	const control = controlEntries(entries);
	const standing = standingWait(control);
	return standing && waits(w, control, entries, instructions) ? `waiting for ${labOf(standing.model) ?? standing.model} (${standing.reason})` : null;
}
