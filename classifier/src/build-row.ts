/**
 * The row a build hand plans on (PLAN wl-mv7hiabx2ozy80, Jo's inputs in-mv7hm58386f2o0 and
 * in-mv7hmuk0u600e8): a non-review spawn runs only on its tier row's entries of the lane's own lab,
 * tier for tier. The lab is the lane's current model's (`labOf`); the entries keep the row's order
 * and thinking suffixes. No lane model, a model on a provider with no lab, a lab that takes reviews
 * only (`REVIEW_ONLY_LABS`, PLAN wl-mw148irbq33zt5 D3), or a tier row with no entry of that lab is an
 * error: the spawn is refused, never widened to another lab. Reviews plan on
 * `reviewRow` (classifier/src/lab.ts) instead. No OMP import and no I/O.
 */
import { type Lab, labOf, providerOf, REVIEW_ONLY_LABS, unknownLabReason } from "./lab";
import type { Tier } from "./route";
import type { TierTable } from "./tier-table";

export type BuildRow = { row: string[]; lab: Lab } | { error: string };

/** `laneModel`: the lane's current model as `provider/id`; undefined when OMP reports none. */
export function buildRow(table: TierTable, tier: Tier, laneModel: string | undefined): BuildRow {
	if (laneModel === undefined) {
		return { error: "the lane's current model is unknown, so its lab is unknown: a build hand runs only on the lane's lab" };
	}
	const lab = labOf(laneModel);
	if (lab === null) {
		return { error: `the lane's model ${laneModel} has no lab (${unknownLabReason(providerOf(laneModel))}): a build hand runs only on the lane's lab` };
	}
	if (REVIEW_ONLY_LABS.has(lab)) {
		return { error: `the lane's model ${laneModel} is on lab ${lab}, which takes reviews only (REVIEW_ONLY_LABS in classifier/src/lab.ts): a build hand never runs on it` };
	}
	const row = table[tier].filter(selector => labOf(selector) === lab);
	if (row.length === 0) {
		return { error: `the ${tier} row has no ${lab} entry for the lane's model ${laneModel}: a build hand runs only on the lane's lab, never another` };
	}
	return { row, lab };
}
