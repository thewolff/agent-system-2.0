// P-11 row 4 (DESIGN-2.0.md:341; C3.7): a 2.0 dispatch names only a tier file — every
// `tasks[].agent` is one of the four tiers; a bundled or role name, or no name, is refused.
import { DISPATCHABLE_TIERS, type Refusal } from "../types";

export interface DispatchItem {
	agent?: unknown;
	task?: unknown;
	/** The slice id (lane.md § dispatch). */
	name?: unknown;
}

/** The spawn items of a `task` call: the batch `tasks[]`, or the flat call itself (omp://tools/task.md, Inputs). */
export function dispatchItems(input: Record<string, unknown>): DispatchItem[] {
	return Array.isArray(input.tasks) ? (input.tasks as DispatchItem[]) : [input as DispatchItem];
}

/**
 * Refuses a `task` call whose item names no agent or an agent outside the four tiers. An omitted
 * agent is refused too: OMP then spawns its default agent (usually `task`), which is no tier file.
 * Reads the lane's original input; M3's classifier rewrites `agent` to a tier only when the original
 * already is one (agent://M3TierClassifier, 2026-09-28).
 */
export function checkTierName(input: Record<string, unknown>): Refusal {
	const bad = dispatchItems(input)
		.map((item, i) => ({ i, agent: item.agent }))
		.filter(({ agent }) => typeof agent !== "string" || !(DISPATCHABLE_TIERS as readonly string[]).includes(agent));
	if (bad.length === 0) return null;
	const list = bad.map(({ i, agent }) => `item ${i}: ${agent === undefined ? "no agent named" : JSON.stringify(agent)}`).join("; ");
	return {
		block: true,
		reason:
			`P-11 row 4 refused this dispatch: a 2.0 dispatch names only a tier file (${DISPATCHABLE_TIERS.join(", ")}). ${list}. ` +
			`Name the tier on every item, e.g. "agent": "standard"; role or bundled agent names (builder, scout, task, …) are not dispatchable.`,
	};
}
