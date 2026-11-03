/**
 * Regressions for the M3 astra review, round 1
 * (/Users/jowolff/agent-scratch/agent-system-2.0/migration/M3/review-astra/REVIEW.md). Each
 * describe block is one finding; each test is that finding's probe, reproduced offline against a
 * fake OMP host, a fake model registry, and a real schema-v4 ledger in a scratch directory.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, loadCalibration, loadKindQuestion, questionSha256 } from "../src/classify";
import { KINDS, route, STAKES, TIERS, type Kind, type Tier } from "../src/route";
import { tierTableFromConfig } from "../src/tier-table";
import { dist, extensionHost, type FakeRegistry, fakeRegistry, loadSample, recordedJudge, recordedQuestion } from "./helpers";

const REPO = join(import.meta.dir, "..", "..");
const FAST = ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna"];
const TABLE = tierTableFromConfig({
	task: {
		agentModelOverrides: {
			fast: FAST,
			standard: ["anthropic/claude-sonnet-5-5"],
			strong: ["anthropic/claude-opus-5-5"],
			deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"],
		},
	},
});
const ALL_MODELS = [...new Set(Object.values(TABLE).flat())];
const OK = { choice: "locate", confidence: 0.9, probabilities: dist({ locate: 0.9 }) };
const LOCATE_JUDGE = { judge: async () => ({ answers: { kind: OK }, provider: "typesafe", model: "jev-1.13.0" }) };
const brief = (workloadId: string, text: string) => `workload: ${workloadId}\ntask: ${text}\nstakes: normal`;

type Judge = { judge(req: { state: string }): Promise<unknown> };

function host(opts: { judge: Judge; registry?: FakeRegistry; slices?: string[]; table?: typeof TABLE; laneModel?: string }) {
	return extensionHost({ ...opts, table: opts.table ?? TABLE, registry: opts.registry ?? fakeRegistry(ALL_MODELS) });
}

const tick = async (n = 5) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("B1: the returned row is the final-selection allowlist", () => {
	const RESOLVER = "/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-resolver.ts";

	test.skipIf(!existsSync(RESOLVER))(
		"an OpenAI lane's fast row is its OpenAI entry, which OMP's own resolver picks, not the parent; an Anthropic lane refuses instead of falling back to it",
		async () => {
			// Appendix A probe: Haiku listed but uncredentialed, Luna and Astra credentialed, parent (the lane) is deep's Astra.
			const registry = fakeRegistry([...FAST, "openai-codex/gpt-6-astra"], ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra"]);
			const h = host({ judge: recordedJudge([]), registry, laneModel: "openai-codex/gpt-6-astra" });
			const spawn = await h.spawn("fast", undefined, "eval");
			expect(spawn?.model).toEqual(["openai-codex/gpt-5.6-luna"]);

			// Dynamic: the resolver lives in this machine's global OMP install, absent on a fresh clone.
			const { resolveModelOverrideWithAuthFallback } = await import(RESOLVER);
			const out = await resolveModelOverrideWithAuthFallback(spawn!.model, "openai-codex/gpt-6-astra", registry);
			expect(out.model.id).toBe("gpt-5.6-luna");
			expect(out.authFallbackUsed).toBe(false);

			const anthropic = await host({ judge: recordedJudge([]), registry }).spawn("fast", undefined, "eval");
			expect(anthropic?.block).toBe(true);
			expect(anthropic?.reason).toContain("anthropic/claude-haiku-5-5 (no credentials)");
			expect(anthropic?.reason).not.toContain("openai-codex/gpt-5.6-luna");
		},
	);

	test("no usable row candidate refuses the spawn instead of letting OMP fall back to the parent", async () => {
		const h = host({ judge: recordedJudge([]), registry: fakeRegistry(ALL_MODELS, ["openai-codex/gpt-6-astra"]) });
		const spawn = await h.spawn("fast", undefined, "eval");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("no usable fast model");
		expect(spawn?.reason).toContain("anthropic/claude-haiku-5-5 (no credentials)");
		const openai = await host({ judge: recordedJudge([]), registry: fakeRegistry(ALL_MODELS, ["openai-codex/gpt-6-astra"]), laneModel: "openai-codex/gpt-6-astra" }).spawn("fast", undefined, "eval");
		expect(openai?.block).toBe(true);
		expect(openai?.reason).toContain("openai-codex/gpt-5.6-luna (no credentials)");
	});

	test("a one-model row with an out-of-tier retry.fallbackChains.default is refused (Appendix B)", () => {
		const config = {
			task: { agentModelOverrides: { fast: "p/fast", standard: "p/standard", strong: "p/strong", deep: "p/deep" } },
			retry: { fallbackChains: { default: ["p/deep"] } },
		};
		expect(() => tierTableFromConfig(config)).toThrow("retry.fallbackChains.default");
	});
});

describe("B2: a spawn's routing is found by its spawn key and tier, never by arrival order", () => {
	test("out-of-order judges and parent-prefixed spawn keys keep each record on its own slice (Appendix C)", async () => {
		let release!: () => void;
		const held = new Promise<void>(r => (release = r));
		const judge = {
			async judge({ state }: { state: string }) {
				if (state.includes("workload one")) await held;
				return { answers: { kind: OK }, provider: "typesafe", model: "jev-1.13.0" };
			},
		};
		const h = host({ judge });
		const input = {
			context: "shared",
			tasks: [
				{ agent: "fast", name: "sl-one", task: brief(h.workloadId, "workload one") },
				{ agent: "fast", name: "sl-two", task: brief(h.workloadId, "workload two") },
			],
		};
		const routed = h.toolCall(input, "batch");
		await tick();
		release();
		await routed;
		await h.spawn("fast", "Lane.sl-one");
		await h.spawn("fast", "Lane.sl-two");
		h.handMessage("Lane.sl-two", "anthropic", "claude-haiku-5-5");
		h.handMessage("Lane.sl-one", "anthropic", "claude-haiku-5-5");
		h.deliver(["Lane.sl-one"]);
		h.deliver(["Lane.sl-two"]);
		expect(h.routings().map(r => [r.slice_id, r.spawn_key])).toEqual([
			["sl-one", "Lane.sl-one"],
			["sl-two", "Lane.sl-two"],
		]);
	});

	test("a failed batch publishes nothing, a late answer cannot leak, and an unmatched task spawn is refused", async () => {
		let releaseLate!: () => void;
		const late = new Promise<void>(r => (releaseLate = r));
		const judge = {
			async judge({ state }: { state: string }) {
				if (state.includes("fail")) throw new Error("unavailable");
				await late;
				return { answers: { kind: OK }, provider: "typesafe", model: "jev-1.13.0" };
			},
		};
		const h = host({ judge });
		const blocked = await h.toolCall(
			{
				context: "shared",
				tasks: [
					{ agent: "fast", name: "sl-one", task: brief(h.workloadId, "fail") },
					{ agent: "fast", name: "sl-two", task: brief(h.workloadId, "late") },
				],
			},
			"failed",
		);
		expect(blocked).toEqual({ block: true, reason: "agent-system-2 classifier could not route this dispatch: unavailable" });
		h.toolResult("failed", true);
		releaseLate();
		await tick();
		for (const key of ["Unrelated", "sl-two"]) {
			const spawn = await h.spawn("fast", key);
			expect(spawn?.block).toBe(true);
			expect(spawn?.reason).toContain("no classification");
		}
		expect(h.routings()).toHaveLength(0);
	});

	test("a collision-suffixed spawn key matches its item; a deferred spawn after the call returned still matches", async () => {
		const h = host({ judge: LOCATE_JUDGE });
		await h.toolCall({ agent: "standard", name: "sl-one", task: brief(h.workloadId, "find it") }, "c1");
		// async task: the call returns before its job spawns; `details.async` is OMP's job object (task/index.ts:905-908)
		h.toolResult("c1", false, { results: [], async: { state: "running", jobId: "Lane.sl-one-2", type: "task" } });
		const spawn = await h.spawn("fast", "Lane.sl-one-2");
		expect(spawn?.block).toBeUndefined();
		h.handMessage("Lane.sl-one-2", "anthropic", "claude-haiku-5-5");
		h.deliver(["Lane.sl-one-2"]);
		expect(h.routings().map(r => [r.slice_id, r.spawn_key, r.tier])).toEqual([["sl-one", "Lane.sl-one-2", "fast"]]);
	});

	test("concurrent same-tier calls never cross-attribute; a spawn whose tier differs from its classification is refused", async () => {
		const h = host({ judge: LOCATE_JUDGE });
		await Promise.all([
			h.toolCall({ agent: "fast", name: "sl-one", task: brief(h.workloadId, "a") }, "c1"),
			h.toolCall({ agent: "fast", name: "sl-two", task: brief(h.workloadId, "b") }, "c2"),
		]);
		const wrongTier = await h.spawn("deep", "sl-two");
		expect(wrongTier?.block).toBe(true);
		expect(wrongTier?.reason).toContain("classified fast");
		await h.spawn("fast", "sl-two");
		await h.spawn("fast", "sl-one");
		const ran = (id: string) => ({ results: [{ id, agent: "fast", resolvedModelIdentity: "anthropic/claude-haiku-5-5" }] });
		h.toolResult("c2", false, ran("sl-two"));
		h.toolResult("c1", false, ran("sl-one"));
		expect(h.routings().map(r => r.slice_id)).toEqual(["sl-two", "sl-one"]);
	});

	test("a tier item whose name is not a slice of its brief's workload is refused before any judge call", async () => {
		const judge = recordedJudge([]);
		const h = host({ judge });
		const result = await h.toolCall({
			context: "shared",
			tasks: [
				{ agent: "fast", task: brief(h.workloadId, "no name") },
				{ agent: "fast", name: "sl-missing", task: brief(h.workloadId, "unknown slice") },
				{ agent: "fast", name: "sl-one", task: "task: no workload line" },
			],
		});
		expect(result.block).toBe(true);
		expect(result.reason).toContain("task 1: no `name`");
		expect(result.reason).toContain("task 2: `sl-missing` is not a slice of workload");
		expect(result.reason).toContain("task 3: the brief has no `workload:` field");
		expect(judge.calls).toHaveLength(0);
	});
});

describe("B3: every kind that can land on a tier gets guidance in that tier's prompt", () => {
	/** Every (kind, confidence band, top-two partner, stakes) the router can produce, and where it lands. */
	function reachable(): Record<Tier, Set<Kind>> {
		const out = Object.fromEntries(TIERS.map(t => [t, new Set<Kind>()])) as Record<Tier, Set<Kind>>;
		for (const kind of KINDS)
			for (const partner of KINDS)
				for (const confidence of [0.4, 0.9])
					for (const stakes of [null, ...STAKES]) {
						const probabilities = partner === kind ? dist({ [kind]: 0.9 }) : dist({ [kind]: 0.5, [partner]: 0.45 });
						out[route({ choice: kind, confidence, probabilities }, stakes).tier].add(kind);
					}
		return out;
	}

	test("the review's two routes exist: a capped judge lands on fast, an uncertain change on deep", () => {
		expect(route({ choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) }, "throwaway").tier).toBe("fast");
		expect(
			route({ choice: "change-small", confidence: 0.45, probabilities: dist({ "change-small": 0.5, judge: 0.45 }) }, null).tier,
		).toBe("deep");
	});

	test.each([...TIERS])("%s.md carries kind guidance for every kind the router can send it", tier => {
		const text = readFileSync(join(REPO, "tiers", `${tier}.md`), "utf8");
		const section = /^## Kind guidance\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text);
		expect(section).not.toBeNull();
		const guided = [...section![1]!.matchAll(/^- \*\*([a-z-]+)\*\*/gm)].map(m => m[1]);
		expect(guided.sort()).toEqual([...reachable()[tier]].sort());
	});
});

describe("S1: the replay replays what was measured; an uncalibrated question refuses dispatch", () => {
	test("the calibration record names the question and judge the sample was recorded with", () => {
		const sample = loadSample();
		expect(loadCalibration().questionSha256).toBe(sample.questionSha256);
		expect(sample.judgeModel).toBe(loadCalibration().judgeModel);
	});

	test("the live question is the re-measured one, so the calibration gate lets it route", async () => {
		expect(questionSha256(loadKindQuestion())).toBe(loadCalibration().questionSha256);
		const briefs: string[] = [];
		const judge = {
			judge: async ({ state }: { state: string }) => {
				briefs.push(state);
				return { answers: { kind: OK }, provider: "typesafe", model: "jev-1.13.0" };
			},
		};
		const h = extensionHost({ judge, table: TABLE, registry: fakeRegistry(ALL_MODELS), question: loadKindQuestion() });
		const workloadId = h.workloadId;
		const result = (await h.toolCall({ agent: "fast", name: "sl-one", task: brief(workloadId, "x") }, "c")) as {
			block?: boolean;
			input?: { agent?: string };
		};
		expect(result.block).toBeUndefined();
		expect(briefs).toEqual([brief(workloadId, "x")]);
		expect(result.input?.agent).toBe("fast"); // routed: the answer was locate at 0.9
	});

	test("a question whose hash is not the calibrated one blocks every tier dispatch", async () => {
		const judge = recordedJudge([]);
		const h = extensionHost({
			judge,
			table: TABLE,
			registry: fakeRegistry(ALL_MODELS),
			question: loadKindQuestion(),
			calibration: { ...loadCalibration(), questionSha256: "0".repeat(64) },
		});
		const result = (await h.toolCall({ agent: "fast", name: "sl-one", task: brief(h.workloadId, "x") }, "c")) as {
			block: boolean;
			reason: string;
		};
		expect(result.block).toBe(true);
		expect(result.reason).toContain("not the question the 0.55 threshold was measured with");
		expect(judge.calls).toHaveLength(0);
	});
});

describe("S2: a malformed judge answer is refused, never routed", () => {
	const question = recordedQuestion();
	const answer = (kind: object) => ({ judge: async () => ({ answers: { kind }, provider: "typesafe", model: "jev-1.13.0" }) });

	test.each([
		["missing probabilities (Appendix B)", { choice: "locate", confidence: 0.4 }, "probabilities"],
		["confidence above 1 (Appendix B)", { choice: "locate", confidence: 2, probabilities: dist({ locate: 0.9 }) }, "confidence"],
		["negative confidence", { choice: "locate", confidence: -0.1, probabilities: dist({ locate: 0.9 }) }, "confidence"],
		["NaN confidence", { choice: "locate", confidence: Number.NaN, probabilities: dist({ locate: 0.9 }) }, "confidence"],
		["infinite probability", { choice: "locate", confidence: 0.9, probabilities: { ...dist({ locate: 0.9 }), judge: Infinity } }, "probabilities"],
		["a kind missing from the distribution", { choice: "locate", confidence: 0.9, probabilities: { locate: 0.9, understand: 0.1 } }, "probabilities"],
		["an unknown kind in the distribution", { choice: "locate", confidence: 0.9, probabilities: { ...dist({ locate: 0.9 }), build: 0 } }, "probabilities"],
		["an all-zero distribution", { choice: "locate", confidence: 0.4, probabilities: dist({ locate: 0, understand: 0, "change-small": 0, "change-large": 0, judge: 0 }) }, "probabilities"],
		["a distribution summing far from 1", { choice: "locate", confidence: 0.4, probabilities: dist({ locate: 0.9, judge: 0.9 }) }, "probabilities"],
	])("%s", async (_, kind, word) => {
		await expect(classify("x", answer(kind) as never, question)).rejects.toThrow(word);
	});
});

describe("S3: the ledger row carries the spawn-time selection, not the row's first preference", () => {
	test("with the first candidate unavailable, models and model name the candidate OMP will actually pick", async () => {
		// An OpenAI lane whose fast row has two OpenAI entries: the first is not in the registry.
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...TABLE, fast: [...FAST, "openai/gpt-5.6-luna"] } } });
		const registry = fakeRegistry(["openai/gpt-5.6-luna", ...ALL_MODELS.filter(m => !FAST.includes(m))]);
		const h = host({ judge: LOCATE_JUDGE, registry, table, laneModel: "openai-codex/gpt-6-astra" });
		await h.toolCall({ agent: "fast", name: "sl-one", task: brief(h.workloadId, "find it") });
		const spawn = await h.spawn("fast", "sl-one");
		expect(spawn?.model).toEqual(["openai/gpt-5.6-luna"]);
		expect(spawn?.note).toContain("skipped openai-codex/gpt-5.6-luna (not in the model registry)");
		h.toolResult("call-1", false, { results: [{ id: "sl-one", agent: "fast", resolvedModelIdentity: "openai/gpt-5.6-luna" }] });
		const [row] = h.routings();
		expect(JSON.parse(row!.models)).toEqual(["openai/gpt-5.6-luna"]);
		expect(row!.model).toBe("openai/gpt-5.6-luna");
	});
});

describe("S4: only the pinned judge's answers route", () => {
	test("an answer from any other judge (the session-model fallback when TypeSafe is uncredentialed) refuses the dispatch", async () => {
		const h = host({ judge: { judge: async () => ({ answers: { kind: OK }, provider: "anthropic", model: "claude-opus-5-5" }) } });
		const result = await h.toolCall({ agent: "fast", name: "sl-one", task: brief(h.workloadId, "x") });
		expect(result.block).toBe(true);
		expect(result.reason).toContain("requested typesafe/jev-1.13.0, reported anthropic/claude-opus-5-5");
	});

	test("the profile template pins modelRoles.judge to the calibrated judge", () => {
		const profile = Bun.YAML.parse(readFileSync(join(REPO, "profile", "config.yml"), "utf8")) as {
			modelRoles?: { judge?: string };
		};
		expect(profile.modelRoles?.judge).toBe(loadCalibration().judgeModel);
	});
});
