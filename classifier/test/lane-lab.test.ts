/**
 * Build hands follow the lane's lab (PLAN wl-mv7hiabx2ozy80 rev 2, sl-handlab-build): a non-review spawn
 * runs only on the classified/capped tier's entries of the lab of the lane's current model
 * (`ctx.model`), tier for tier, never another lab's; a review keeps the cross-lab routing. The host
 * here builds its own OMP context, carrying the lane model the way OMP's `ExtensionContext.model`
 * does, and imports only modules that predate the rule, so this file also runs on the baseline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type Stakes } from "../../ledger/src/index";
import { laneModelBody } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { tierTableFromConfig, type TierTable } from "../src/tier-table";
import { asyncDelivery, dist, fakeRegistry, recordedQuestion } from "./helpers";
import { tmpDir } from "../../ledger/test/tmp";

const ROWS = {
	fast: ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const [OPUS, SOL, KIMI] = ROWS.strong as [string, string, string];
const [, , K3] = ROWS.deep as [string, string, string];
/** The lane models: each lab's lane, one of them a model no tier row names (tier for tier, not the exact model). */
const LANE = { anthropic: OPUS, openai: "openai-codex/gpt-6.1-sol", kimi: KIMI } as const;
const LAB_PREFIX = { anthropic: "anthropic/", openai: "openai-codex/", kimi: "moonshot/" } as const;
type LabName = keyof typeof LANE;
const LAB_NAMES = Object.keys(LANE) as LabName[];
const ofLab = (row: readonly string[], lab: LabName) => row.filter(s => s.startsWith(LAB_PREFIX[lab]));

/** By task text: `find` locate (fast), `explain` understand (standard), `review` judge, `edge` understand 0.55 with judge second, else change-large (strong). */
function answer(brief: string) {
	const task = /^task: (.*)$/m.exec(brief)?.[1] ?? "";
	if (task.startsWith("find")) return { choice: "locate", confidence: 0.9, probabilities: dist({ locate: 0.9 }) };
	if (task.startsWith("explain")) return { choice: "understand", confidence: 0.9, probabilities: dist({ understand: 0.9 }) };
	if (task.startsWith("review")) return { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) };
	if (task.startsWith("edge")) return { choice: "understand", confidence: 0.55, probabilities: dist({ understand: 0.55, judge: 0.4 }) };
	return { choice: "change-large", confidence: 0.9, probabilities: dist({ "change-large": 0.9 }) };
}
const JUDGE = { judge: async ({ state }: { state: string }) => ({ answers: { kind: answer(state) }, provider: "typesafe", model: "jev-1.13.0" }) };
const RULE_END = Date.parse("2026-11-01T00:00:00-07:00");

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workload on a temp ledger, the lane's session file on disk, and a registry whose credentialed list (`creds`) the test edits. */
function world(opts: { stakes?: Stakes; table?: TierTable; available?: string[]; sessionless?: string[] } = {}) {
	const dir = tmpDir("lane-lab-");
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-lanelab", brief: "lane lab test", stakes: opts.stakes ?? "normal", mode: "autonomous", by: "orch-test" });
	for (const id of ["sl-a", "sl-b", "sl-c", "sl-x", "sl-y"]) ledger.addSlice({ id, workloadId: wl, task: id, doneCondition: "d", inputs: "i", by: "lane-test" });
	mkdirSync(join(dir, "sessions"));
	const laneFile = join(dir, "sessions", "lane.jsonl");
	writeFileSync(laneFile, "");
	const creds = [...(opts.available ?? ALL)];
	return { ledger, wl, laneFile, root: laneFile.slice(0, -".jsonl".length), creds, registry: fakeRegistry(opts.available ?? ALL, creds, opts.sessionless), table: opts.table ?? TABLE };
}
type World = ReturnType<typeof world>;

const down = (w: World, ...models: string[]) => {
	for (const m of models) w.creds.splice(w.creds.indexOf(m), 1);
};
const brief = (w: World, task: string, stakes: Stakes = "normal") => `workload: ${w.wl}\ntask: ${task}\ndone-condition: d\ninputs: i\nstakes: ${stakes}\nceiling-share: 10`;
/** OMP's `ExtensionContext.model`: the session's current `Model`, `{ provider, id, … }`, or undefined. */
type CurrentModel = { provider: string; id: string; name: string } | undefined;
const modelOf = (selector: string | undefined): CurrentModel => {
	if (selector === undefined) return undefined;
	const [provider, ...id] = selector.split("/");
	return { provider: provider!, id: id.join("/"), name: selector };
};

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Item = { agent: string; name: string };
type Reply = { block?: boolean; reason?: string; input?: Item & { tasks: Item[] }; model?: string[]; note?: string } | undefined;

/** One lane process on `laneModel` (explicitly undefined: OMP reported no current model). A second `lane(w)` is a restart or relaunch. */
function lane(w: World, opts: { laneModel: string | undefined; disabled?: string[] }) {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => w.table,
		disabledProviders: async () => opts.disabled ?? [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => w.ledger,
		laneId: "lane-test",
		boundWorkload: () => w.wl,
		ompState: () => "same",
		lastWrite: () => null,
		log: () => {},
		now: () => RULE_END,
		fingerprint: () => "unchanged",
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx: { cwd: string; modelRegistry: unknown; model: CurrentModel; sessionManager: { getSessionFile(): string } } = {
		cwd: w.root,
		modelRegistry: w.registry,
		model: modelOf(opts.laneModel),
		sessionManager: { getSessionFile: () => w.laneFile },
	};
	const assistant = (selector: string) => {
		const [provider, ...model] = selector.split("/");
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
	};
	return {
		/** The lane switches models at runtime (OMP's model switch): later spawns read the new one. */
		setModel: (selector: string | undefined) => void (ctx.model = modelOf(selector)),
		toolCall: (input: unknown, toolCallId: string) => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
		spawn: (agent: string, spawnKey?: string, invocationKind = "task") =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind, patterns: [], spawnKey }, ctx) as Promise<Reply>,
		laneMessage: (selector: string) => handlers.message_end!(assistant(selector), ctx),
		handMessage: (agentId: string, selector: string) =>
			handSession.message_end!(assistant(selector), { ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } }),
		results: (toolCallId: string, results: { id: string; agent: string; model: string }[]) =>
			handlers.tool_result!(
				{
					type: "tool_result",
					toolName: "task",
					toolCallId,
					isError: false,
					input: {},
					content: [],
					details: { results: results.map(r => ({ id: r.id, agent: r.agent, resolvedModelIdentity: r.model })) },
				},
				ctx,
			) as { isError?: boolean; content?: { text: string }[] } | undefined,
		deliver: (agentIds: string[], output = "hand output") => {
			const result = handlers.context!({ type: "context", messages: [asyncDelivery(agentIds, output)] }, ctx) as { messages?: { content?: unknown }[] } | undefined;
			return String(result?.messages?.[0]?.content ?? output);
		},
	};
}
type Lane = ReturnType<typeof lane>;

const spawnRows = (w: World) =>
	w.ledger
		.entries(w.wl)
		.map(e => e.body)
		.filter(b => b.startsWith("hand-spawn:"))
		.map(b => / row (\S*)$/.exec(b)![1]!);

/** Classify `task` for `sliceId` and spawn it on the tier the classifier chose. */
async function dispatch(h: Lane, w: World, sliceId: string, task: string, call: string) {
	const out = await h.toolCall({ agent: "strong", name: sliceId, task: brief(w, task) }, call);
	expect(out?.block).toBeUndefined();
	const tier = out!.input!.agent;
	return { tier, spawn: await h.spawn(tier, sliceId) };
}

describe("a build hand runs on the lane's lab, tier for tier", () => {
	const tiers = [
		["find the loader", "fast"],
		["explain the loader", "standard"],
		["change the loader", "strong"],
	] as const;
	for (const lab of LAB_NAMES) {
		for (const [task, tier] of tiers) {
			test(`${lab} lane, ${tier}: the returned candidates and the hand-spawn: row are the ${tier} row's ${lab} entries only`, async () => {
				const w = world();
				const h = lane(w, { laneModel: LANE[lab] });
				const { tier: routed, spawn } = await dispatch(h, w, "sl-a", task, "c1");
				expect(routed).toBe(tier);
				const expected = ofLab(ROWS[tier], lab);
				expect(expected.length).toBeGreaterThan(0);
				expect(spawn?.model).toEqual(expected);
				expect(spawnRows(w)).toEqual([expected.join(",")]);
			});
		}
		test(`${lab} lane, deep: an unclassified eval agent() spawn gets the deep row's ${lab} entries only`, async () => {
			const w = world();
			const h = lane(w, { laneModel: LANE[lab] });
			const spawn = await h.spawn("deep", undefined, "eval");
			expect(spawn?.model).toEqual(ofLab(ROWS.deep, lab));
			expect(spawn?.note).toContain("tier deep (unclassified)");
		});
	}

	test("a hand that answered on another lab's entry of the native tier row is withheld out of row", async () => {
		const w = world();
		const h = lane(w, { laneModel: OPUS });
		const { spawn } = await dispatch(h, w, "sl-a", "change the loader", "c1");
		expect(spawn?.model).toEqual([OPUS]);
		h.handMessage("sl-a", SOL);
		const out = h.results("c1", [{ id: "sl-a", agent: "strong", model: SOL }]);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain(`sl-a ran on ${SOL}, outside the strong row (${OPUS})`);
		expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-a", outcome: "refused-out-of-row", models: JSON.stringify([OPUS]), ran_models: JSON.stringify([SOL]) }]);
	});

	test("a same-lab hand on its lab's entry passes", async () => {
		const w = world();
		const h = lane(w, { laneModel: LANE.openai });
		const { spawn } = await dispatch(h, w, "sl-a", "change the loader", "c1");
		expect(spawn?.model).toEqual([SOL]);
		h.handMessage("sl-a", SOL);
		expect(h.results("c1", [{ id: "sl-a", agent: "strong", model: SOL }])).toBeUndefined();
		expect(w.ledger.routings(w.wl)).toMatchObject([{ outcome: "ran", models: JSON.stringify([SOL]), ran_models: JSON.stringify([SOL]) }]);
	});

	test("a same-lab, same-tier entry is the fallback when the first is unusable; never another lab", async () => {
		const OAI = "openai/gpt-6-sol";
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [OPUS, SOL, OAI, KIMI] } } });
		const w = world({ table, available: [...ALL, OAI] });
		const h = lane(w, { laneModel: LANE.openai });
		down(w, SOL);
		const { spawn } = await dispatch(h, w, "sl-a", "change the loader", "c1");
		expect(spawn?.model).toEqual([OAI]);
		expect(spawn?.note).toContain(`${SOL} (no credentials)`);
		h.handMessage("sl-a", OAI);
		expect(h.results("c1", [{ id: "sl-a", agent: "strong", model: OAI }])).toBeUndefined();
	});
});

describe("no same-lab candidate refuses; another credentialed lab never runs instead", () => {
	const cases: [string, (w: World) => World, string, { disabled?: string[] }?][] = [
		["no credentials", w => (down(w, SOL), w), `${SOL} (no credentials)`],
		["provider disabled", w => w, `${SOL} (provider disabled)`, { disabled: ["openai-codex"] }],
		["not in the model registry", () => world({ available: ALL.filter(m => m !== SOL) }), `${SOL} (not in the model registry)`],
		["no credentials for the spawn's session", () => world({ sessionless: [SOL] }), `${SOL} (no credentials for spawn sl-a)`],
		[
			"its provider refused on the workload",
			w => (w.ledger.recordEntry({ by: "lane-test", workloadId: w.wl, kind: "assumption", body: "provider-refused: openai-codex status 401 token dt-old" }), w),
			`${SOL} (its provider refused on dt-old (status 401))`,
		],
	];
	for (const [what, setUp, reason, opts] of cases) {
		test(`openai lane, strong, ${what}: refused with a routing row and no hand-spawn:`, async () => {
			const w = setUp(world());
			const h = lane(w, { laneModel: LANE.openai, ...opts });
			const { spawn } = await dispatch(h, w, "sl-a", "change the loader", "c1");
			expect(spawn?.model).toBeUndefined();
			expect(spawn?.block).toBe(true);
			expect(spawn?.reason).toContain("no usable strong model");
			expect(spawn?.reason).toContain(reason);
			expect(spawn?.reason).not.toContain(OPUS);
			expect(spawnRows(w)).toEqual([]);
			expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-a", outcome: "refused-no-usable-model", models: "[]", ran_models: null }]);
		});
	}

	test("a lane with no current model refuses every build spawn, classified or not", async () => {
		const w = world();
		const h = lane(w, { laneModel: undefined });
		const { spawn } = await dispatch(h, w, "sl-a", "change the loader", "c1");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("the lane's current model is unknown");
		expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-a", outcome: "refused-no-usable-model", models: "[]" }]);
		const unclassified = await h.spawn("fast", undefined, "eval");
		expect(unclassified?.block).toBe(true);
		expect(unclassified?.reason).toContain("the lane's current model is unknown");
		expect(spawnRows(w)).toEqual([]);
	});

	test("a lane model on a provider with no lab refuses", async () => {
		const w = world();
		const h = lane(w, { laneModel: "mystery/model-x" });
		const { spawn } = await dispatch(h, w, "sl-a", "change the loader", "c1");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("unknown lab for provider mystery");
		expect(spawnRows(w)).toEqual([]);
	});

	test("a tier row with no entry of the lane's lab refuses; the other labs' entries are not offered", async () => {
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, standard: ROWS.standard.slice(0, 2) } } });
		const w = world({ table });
		const h = lane(w, { laneModel: LANE.kimi });
		const { tier, spawn } = await dispatch(h, w, "sl-a", "explain the loader", "c1");
		expect(tier).toBe("standard");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("the standard row has no kimi entry");
		expect(w.ledger.routings(w.wl)).toMatchObject([{ outcome: "refused-no-usable-model", models: "[]" }]);
		expect(spawnRows(w)).toEqual([]);
	});
});

describe("the lane model at each spawn; the row a hand was spawned on holds", () => {
	test("a model switch changes later spawns only: the earlier hand is checked against its own row", async () => {
		const w = world();
		const h = lane(w, { laneModel: OPUS });
		expect((await dispatch(h, w, "sl-a", "change the loader", "c1")).spawn?.model).toEqual([OPUS]);
		h.setModel(LANE.openai);
		expect((await dispatch(h, w, "sl-b", "change the parser", "c2")).spawn?.model).toEqual([SOL]);
		expect(spawnRows(w)).toEqual([OPUS, SOL]);
		h.handMessage("sl-a", OPUS);
		expect(h.results("c1", [{ id: "sl-a", agent: "strong", model: OPUS }])).toBeUndefined();
		h.handMessage("sl-b", OPUS);
		expect(h.results("c2", [{ id: "sl-b", agent: "strong", model: OPUS }])?.isError).toBe(true);
		expect(w.ledger.routings(w.wl).map(r => [r.slice_id, r.models, r.outcome])).toEqual([
			["sl-a", JSON.stringify([OPUS]), "ran"],
			["sl-b", JSON.stringify([SOL]), "refused-out-of-row"],
		]);
	});

	test("an async hand spawned before a switch settles against its own row after it", async () => {
		const w = world();
		const h = lane(w, { laneModel: LANE.openai });
		const out = await h.toolCall({ agent: "strong", name: "sl-a", task: brief(w, "change the loader") }, "c1");
		expect((await h.spawn(out!.input!.agent, "Lane.sl-a"))?.model).toEqual([SOL]);
		h.setModel(OPUS);
		h.handMessage("Lane.sl-a", SOL);
		expect(h.deliver(["Lane.sl-a"], "DONE")).toBe("DONE");
		expect(w.ledger.routings(w.wl)).toMatchObject([{ agent_id: "Lane.sl-a", models: JSON.stringify([SOL]), outcome: "ran" }]);
	});

	test("a result recovered after a restart on another lane model keeps its verdict on the row it was spawned on", async () => {
		const w = world();
		const a = lane(w, { laneModel: OPUS });
		await dispatch(a, w, "sl-a", "change the loader", "c1");
		a.handMessage("sl-a", OPUS);
		expect(a.results("c1", [{ id: "sl-a", agent: "strong", model: OPUS }])).toBeUndefined();
		await dispatch(a, w, "sl-b", "change the parser", "c2");
		a.handMessage("sl-b", SOL);
		expect(a.results("c2", [{ id: "sl-b", agent: "strong", model: SOL }])?.isError).toBe(true);

		const b = lane(w, { laneModel: LANE.openai }); // relaunched on an OpenAI model
		expect(b.results("c1", [{ id: "sl-a", agent: "strong", model: OPUS }])).toBeUndefined();
		const replay = b.results("c2", [{ id: "sl-b", agent: "strong", model: SOL }]);
		expect(replay?.isError).toBe(true);
		expect(replay?.content?.[0]?.text).toContain("refused-out-of-row");
	});

	test("an in-flight build hand counts only its recorded lab row toward the builders after a restart; a relaunch on another lab adds that lab", async () => {
		const w = world();
		const a = lane(w, { laneModel: OPUS });
		a.laneMessage(OPUS);
		expect((await dispatch(a, w, "sl-a", "change the loader", "c1")).spawn?.model).toEqual([OPUS]);
		// The process dies with the hand in flight; the restarted lane reviews.
		const b = lane(w, { laneModel: OPUS });
		const review = await dispatch(b, w, "sl-x", "review the change", "r1");
		expect(review.spawn?.model).toEqual([SOL, KIMI]);

		// A relaunch on an OpenAI model: its turns and its build hands are openai; the next review goes to kimi.
		const v = world();
		const first = lane(v, { laneModel: OPUS });
		first.laneMessage(OPUS);
		const relaunched = lane(v, { laneModel: LANE.openai });
		relaunched.laneMessage(LANE.openai);
		const built = await dispatch(relaunched, v, "sl-a", "change the loader", "c1");
		expect(built.spawn?.model).toEqual([SOL]);
		relaunched.handMessage("sl-a", SOL);
		expect(relaunched.results("c1", [{ id: "sl-a", agent: "strong", model: SOL }])).toBeUndefined();
		expect((await dispatch(relaunched, v, "sl-x", "review the change", "r1")).spawn?.model).toEqual([KIMI]);
	});
});

describe("named and default lanes follow the actual current model", () => {
	test("a named lane (lane-model: openai-codex/gpt-6.1-sol) on that model builds on OpenAI entries; a newer instruction does not reroute the running lane", async () => {
		const w = world();
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: laneModelBody(LANE.openai, "2026-10-14T00:00:00.000Z") });
		const h = lane(w, { laneModel: LANE.openai });
		expect((await dispatch(h, w, "sl-a", "change the loader", "c1")).spawn?.model).toEqual([SOL]);
		expect((await dispatch(h, w, "sl-b", "find the loader", "c2")).spawn?.model).toEqual(ofLab(ROWS.fast, "openai"));
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: laneModelBody(OPUS, "2026-10-14T01:00:00.000Z") });
		expect((await dispatch(h, w, "sl-c", "explain the loader", "c3")).spawn?.model).toEqual(ofLab(ROWS.standard, "openai"));
	});

	test("a default lane (no lane-model:) builds on its current model's lab", async () => {
		const w = world();
		const h = lane(w, { laneModel: OPUS });
		const { spawn } = await dispatch(h, w, "sl-a", "change the loader", "c1");
		expect(spawn?.model).toEqual([OPUS]);
		expect(spawn?.note).toContain("lane lab anthropic");
	});
});

describe("reviews keep the cross-lab routing, whatever the lane's lab", () => {
	test("a normal judge review routes off the builder lab, not onto the lane's", async () => {
		for (const laneModel of [OPUS, undefined]) {
			const w = world();
			const h = lane(w, { laneModel });
			h.laneMessage(OPUS);
			const { tier, spawn } = await dispatch(h, w, "sl-x", "review the change", "r1");
			expect(tier).toBe("strong");
			expect(spawn?.model).toEqual([SOL, KIMI]);
			expect(spawnRows(w)).toEqual([[SOL, KIMI].join(",")]);
			h.handMessage("sl-x", SOL);
			expect(h.results("r1", [{ id: "sl-x", agent: "strong", model: SOL }])).toBeUndefined();
		}
	});

	test("a low-confidence dispatch with judge in its top two is a review even when requested on a lower tier", async () => {
		const w = world();
		const h = lane(w, { laneModel: OPUS });
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "fast", name: "sl-x", task: brief(w, "edge: look at the loader") }, "r1");
		expect(out?.input?.agent).toBe("strong");
		expect((await h.spawn("strong", "sl-x"))?.model).toEqual([SOL, KIMI]);
	});

	test("a production review still fans out to one hand per other lab", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w, { laneModel: OPUS });
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "r1");
		expect(out?.input?.tasks.map(t => `${t.name}@${t.agent}`)).toEqual(["sl-x--openai@deep", "sl-x--kimi@deep"]);
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([SOL]);
		expect((await h.spawn("deep", "sl-x--kimi"))?.model).toEqual([K3]);
	});
});
