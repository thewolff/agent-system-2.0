/**
 * `buildRow` (classifier/src/build-row.ts): a build hand's row is its tier row's entries of the lane's
 * lab, in row order with thinking suffixes kept; no lane model, no lab, or no entry of the lab is an
 * error, never another lab's entries. The spawn wiring is lane-lab.test.ts's.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildRow } from "../src/build-row";
import { LABS, labOf } from "../src/lab";
import { TIERS } from "../src/route";
import { loadTierTable, tierTableFromConfig } from "../src/tier-table";

const ROWS = {
	fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna:low", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5-5", "moonshot/kimi-k2.5", "openai/gpt-6-luna"],
	strong: ["anthropic/claude-opus-5-5:high", "openai-codex/gpt-6-sol:high", "kimi-code/kimi-for-coding", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra:xhigh"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const LANE = { anthropic: "anthropic/claude-opus-5-5", openai: "openai-codex/gpt-6.1-sol", kimi: "moonshot/kimi-k2.7-code" } as const;

describe("buildRow", () => {
	test("every lab, every tier: the row's entries of the lane's lab, in row order, suffixes kept", () => {
		const expected = {
			anthropic: { fast: ["anthropic/claude-haiku-5-5"], standard: ["anthropic/claude-sonnet-5-5"], strong: ["anthropic/claude-opus-5-5:high"], deep: ["anthropic/claude-fable-5-1"] },
			openai: {
				fast: ["openai-codex/gpt-5.6-luna:low"],
				standard: ["openai-codex/gpt-6-luna", "openai/gpt-6-luna"],
				strong: ["openai-codex/gpt-6-sol:high"],
				deep: ["openai-codex/gpt-6-astra:xhigh"],
			},
			kimi: { fast: ["moonshot/kimi-k2.7-code-highspeed"], standard: ["moonshot/kimi-k2.5"], strong: ["kimi-code/kimi-for-coding", "moonshot/kimi-k2.7-code"] },
		} as const;
		for (const lab of LABS) {
			for (const tier of TIERS) {
				const want = (expected[lab] as Partial<Record<string, readonly string[]>>)[tier];
				const got = buildRow(TABLE, tier, LANE[lab]);
				if (want) expect(got).toEqual({ row: [...want], lab });
				else expect(got).toEqual({ error: `the ${tier} row has no ${lab} entry for the lane's model ${LANE[lab]}: a build hand runs only on the lane's lab, never another` });
			}
		}
	});

	test("the lab is the provider's, not the model's: any model of a lab selects that lab's entries", () => {
		expect(buildRow(TABLE, "strong", "openai/some-new-model")).toEqual({ row: ["openai-codex/gpt-6-sol:high"], lab: "openai" });
		expect(buildRow(TABLE, "fast", "kimi-code/kimi-for-coding")).toEqual({ row: ["moonshot/kimi-k2.7-code-highspeed"], lab: "kimi" });
	});

	test("no lane model and a provider with no lab are errors", () => {
		expect(buildRow(TABLE, "fast", undefined)).toEqual({ error: "the lane's current model is unknown, so its lab is unknown: a build hand runs only on the lane's lab" });
		expect(buildRow(TABLE, "fast", "mystery/model-x")).toEqual({
			error: "the lane's model mystery/model-x has no lab (unknown lab for provider mystery; add it to classifier/src/lab.ts): a build hand runs only on the lane's lab",
		});
	});

	test("the table is not changed", () => {
		const before = JSON.stringify(TABLE);
		buildRow(TABLE, "standard", LANE.openai);
		expect(JSON.stringify(TABLE)).toBe(before);
	});

	test("the installed profile's rows: each lab's build row is a lab-only, order-kept part of its tier row", () => {
		const table = loadTierTable(join(import.meta.dir, "..", "..", "profile", "config.yml"));
		for (const lab of LABS) {
			for (const tier of TIERS) {
				const got = buildRow(table, tier, LANE[lab]);
				const own = table[tier].filter(s => labOf(s) === lab);
				expect(got).toEqual(own.length > 0 ? { row: own, lab } : { error: expect.stringContaining(`the ${tier} row has no ${lab} entry`) });
			}
		}
	});
});
