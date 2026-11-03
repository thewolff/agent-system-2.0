/**
 * (d) Provider fallback stays on the same tier: the profile template's table, and the refusals
 * that keep a broken table from routing anywhere.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { labOf } from "../src/lab";
import { TIERS, tierRank } from "../src/route";
import { loadTierTable, TierTableError, tierTableFromConfig } from "../src/tier-table";

const TEMPLATE = join(import.meta.dir, "..", "..", "profile", "config.yml");

const valid = {
	fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna"],
	standard: ["anthropic/claude-sonnet-5-5", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"],
};
const config = (overrides: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	task: { agentModelOverrides: overrides },
	...extra,
});
const problemsOf = (fn: () => unknown): string[] => {
	try {
		fn();
	} catch (error) {
		if (error instanceof TierTableError) return error.problems;
		throw error;
	}
	throw new Error("expected a TierTableError");
};

describe("profile template tier table", () => {
	test("the shipped template parses and every tier has a row led by its ruled pin", () => {
		const table = loadTierTable(TEMPLATE);
		// SPEC-2.0.md § A1.3: today fast=haiku-5-5, standard=sonnet-5-5 (Jo, 2026-09-29), strong=opus-5-5, deep=fable-5-1.
		expect(table.fast[0]).toBe("anthropic/claude-haiku-5-5");
		expect(table.standard[0]).toBe("anthropic/claude-sonnet-5-5");
		expect(table.strong[0]).toBe("anthropic/claude-opus-5-5");
		expect(table.deep[0]).toBe("anthropic/claude-fable-5-1");
		// SPEC-2.0.md § B11: each row spreads across the flat-rate providers. Kimi is off the rows until
		// Jo pays Moonshot (migration/items/kimi-off-tier-rows-until-paid.md restores the three-provider assertion).
		for (const tier of TIERS) {
			expect(new Set(table[tier].map(m => m.split("/")[0]))).toEqual(new Set(["anthropic", "openai-codex"]));
		}
	});

	test("T17: no tier row names a kimi-lab entry (Kimi off the rows until paid)", () => {
		const table = loadTierTable(TEMPLATE);
		// migration/items/kimi-off-tier-rows-until-paid.md restores the original T17: each tier's [2] entry is
		// moonshot (fast kimi-k2.7-code-highspeed, standard kimi-k2.5, strong kimi-k2.7-code, deep kimi-k3, Jo,
		// in-muq3zh77r02g3k), and no row names kimi-code.
		expect(TIERS.flatMap(tier => table[tier]).filter(m => labOf(m) === "kimi")).toEqual([]);
	});

	test("every fallback in the template stays on its tier: no entry reappears in a higher row", () => {
		const table = loadTierTable(TEMPLATE);
		for (const tier of TIERS) {
			const higher = TIERS.filter(t => tierRank(t) > tierRank(tier)).flatMap(t => table[t]);
			for (const fallback of table[tier].slice(1)) expect(higher).not.toContain(fallback);
		}
	});
});

describe("tier table refusals (DESIGN-2.0.md P-11 row 15)", () => {
	test("a valid table is returned row for row", () => {
		expect(tierTableFromConfig(config(valid))).toEqual(valid);
	});

	test("a lower row listing a higher tier's model is a pull-up and is refused", () => {
		const problems = problemsOf(() =>
			tierTableFromConfig(config({ ...valid, strong: ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1:high"] })),
		);
		expect(problems).toEqual([
			"anthropic/claude-fable-5-1:high is in the strong row and in the higher deep row: a fallback to it would pull up a tier",
		]);
	});

	test("a missing tier row is refused rather than inheriting the lane's model", () => {
		const { deep: _deep, ...rest } = valid;
		expect(problemsOf(() => tierTableFromConfig(config(rest)))).toEqual(["task.agentModelOverrides.deep: missing or empty"]);
	});

	test("role aliases are refused: the table names concrete models only", () => {
		expect(problemsOf(() => tierTableFromConfig(config({ ...valid, fast: ["@smol"] })))).toEqual([
			'task.agentModelOverrides.fast: "@smol" is not a concrete provider/model selector',
		]);
	});

	test("a global fallback chain keyed on a tier model or its provider is refused", () => {
		const exact = config(valid, { retry: { fallbackChains: { "anthropic/claude-opus-5-5": ["anthropic/claude-fable-5-1"] } } });
		expect(problemsOf(() => tierTableFromConfig(exact))).toEqual([
			"retry.fallbackChains.anthropic/claude-opus-5-5 can route a tier hand outside its tier row",
		]);
		const wildcard = config(valid, { retry: { fallbackChains: { "moonshot/*": ["zai/*"] } } });
		expect(problemsOf(() => tierTableFromConfig(wildcard))).toHaveLength(1);
		const unrelated = config(valid, { retry: { fallbackChains: { web: ["web/perplexity"] } } });
		expect(tierTableFromConfig(unrelated)).toEqual(valid);
	});
});
