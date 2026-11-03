/**
 * The shipped profile's tier rows and compaction thresholds, on the real profile/config.yml rather than a fixture
 * table: the strong-row OpenAI entry (Jo, in-mv8qzqym1ihmv4, 2026-10-14; PLAN.md § 5 of wl-mv71x5rwdu7eo0) is
 * openai-codex/gpt-6.1-sol, reached by deep reviews through REVIEW_ROW_FROM; Opus hands run at medium and the fast
 * row's Haiku 5.5 has its own compaction threshold (Jo, in-mv8gcb2bbue4g0; PLAN-p2 rev 4 § 2.3).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { labOf, reviewRow } from "../src/lab";
import { TIERS } from "../src/route";
import { loadTierTable, modelIdentity, tierTableFromConfig } from "../src/tier-table";

const TEMPLATE = join(import.meta.dir, "..", "..", "profile", "config.yml");
const SOL = "openai-codex/gpt-6.1-sol";
const HAIKU = "anthropic/claude-haiku-5-5";
/** Haiku 5.5's context window: `omp models` (OMP 18.8.6, 2026-11-03) prints `claude-haiku-5-5 │ 1M │ 128K`, and
 * https://platform.claude.com/docs/en/about-claude/models/overview.md (fetched 2026-11-03) lists "1M tokens". */
const HAIKU_WINDOW = 1_000_000;
/** OMP compacts before the window minus its 15% reserve (the modelThresholds comment in profile/config.yml). */
const USABLE = HAIKU_WINDOW * 0.85;
/** A lane's ~93K floor after compaction (profile/config.yml modelThresholds comment, 2026-10-12 openai-codex lane). */
const POST_COMPACTION_FLOOR = 93_000;
/** The installed OMP's matcher; absent off this workstation, so its test is skipped and imported by path at run time. */
const COMPACTION_THRESHOLD = "/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/compaction-threshold.ts";
/** profile/config.yml's compaction.modelThresholds, narrowed field by field from the parsed file. */
const THRESHOLDS: Record<string, unknown> = (() => {
	const doc: unknown = Bun.YAML.parse(readFileSync(TEMPLATE, "utf8"));
	const compaction = doc !== null && typeof doc === "object" && "compaction" in doc ? doc.compaction : undefined;
	const map = compaction !== null && typeof compaction === "object" && "modelThresholds" in compaction ? compaction.modelThresholds : undefined;
	if (map === null || typeof map !== "object") throw new Error(`${TEMPLATE}: compaction.modelThresholds is missing or not a map`);
	return Object.fromEntries(Object.entries(map));
})();

describe("profile template: strong-row OpenAI entry is gpt-6.1-sol (in-mv8qzqym1ihmv4)", () => {
	test("the strong row's openai-codex entry is gpt-6.1-sol", () => {
		const table = loadTierTable(TEMPLATE);
		expect(table.strong.filter(entry => entry.startsWith("openai-codex/"))).toEqual([SOL]);
	});

	test("a deep-tier review on the real table gives its OpenAI leg gpt-6.1-sol", () => {
		const table = loadTierTable(TEMPLATE);
		expect(reviewRow(table, "deep").filter(entry => labOf(entry) === "openai")).toEqual([SOL]);
	});

	test("the real table passes the tier-table check, with gpt-6.1-sol in one tier only", () => {
		const table = tierTableFromConfig(Bun.YAML.parse(readFileSync(TEMPLATE, "utf8")));
		expect(TIERS.filter(tier => table[tier].some(entry => modelIdentity(entry) === SOL))).toEqual(["strong"]);
	});
});

describe("profile template: Opus at medium, Haiku 5.5 threshold (in-mv8gcb2bbue4g0)", () => {
	test("strong row 1 is exactly anthropic/claude-opus-5-5:medium; fast row 1 stays anthropic/claude-haiku-5-5", () => {
		const table = loadTierTable(TEMPLATE);
		expect(table.strong[0]).toBe("anthropic/claude-opus-5-5:medium");
		expect(table.fast[0]).toBe(HAIKU);
	});

	test("the exact haiku-5-5 threshold is a token count above the post-compaction floor and below the usable window", () => {
		const n = THRESHOLDS[HAIKU];
		if (typeof n !== "number") throw new Error(`${TEMPLATE}: compaction.modelThresholds["${HAIKU}"] is ${JSON.stringify(n)}, not a token count`);
		expect(n).toBeGreaterThan(POST_COMPACTION_FLOOR);
		expect(n).toBeLessThan(USABLE);
	});

	test.skipIf(!existsSync(COMPACTION_THRESHOLD))("OMP's own matcher gives haiku-5-5 that exact entry as a token threshold", async () => {
		const { matchModelCompactionThreshold } = await import(COMPACTION_THRESHOLD);
		expect(matchModelCompactionThreshold(THRESHOLDS, { provider: "anthropic", id: "claude-haiku-5-5" })).toEqual({
			key: HAIKU,
			threshold: { thresholdPercent: -1, thresholdTokens: THRESHOLDS[HAIKU] },
		});
	});
});
