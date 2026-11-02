/**
 * (e) The extension end to end against a fake OMP host: a lane `task` call is rewritten to the
 * classified tier, the spawn gets the tier's usable model row, and once the hand's result settles
 * the routing lands on the slice's row in a real schema-v4 ledger (ledger/src/index.ts `routings`)
 * plus the spawn note. The review and fix-round regressions are in review-round{1,2}.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_BY, Ledger, type Stakes } from "../../ledger/src/index";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { autoExtendNoticeBody, countRounds, effectiveRoundLimit, ROUND_LIMIT_OPTIONS } from "../src/rounds";
import { tierTableFromConfig } from "../src/tier-table";
import { currentModel, DEFAULT_LANE_MODEL, dist, fakeRegistry, recordedJudge, recordedQuestion, scratchLedger } from "./helpers";

const TABLE = tierTableFromConfig({
	task: {
		agentModelOverrides: {
			fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna"],
			standard: ["anthropic/claude-sonnet-5-5", "moonshot/kimi-k2.5"],
			strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
			deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"],
		},
	},
});

const REVIEW_BRIEF = "workload: wl-abc123\ntask: review the ledger design and rule on it\nstakes: normal";
const CHANGE_BRIEF = "workload: wl-abc123\ntask: rewrite the loader across its three modules";
const FIND_BRIEF = "workload: wl-abc123\ntask: find where the loader registers hooks";
const judge = recordedJudge([
	{ text: REVIEW_BRIEF, response: { choice: "understand", confidence: 0.42, probabilities: dist({ understand: 0.54, judge: 0.46 }) } },
	{ text: CHANGE_BRIEF, response: { choice: "change-large", confidence: 0.9, probabilities: dist({ "change-large": 0.9 }) } },
	{ text: FIND_BRIEF, response: { choice: "locate", confidence: 0.93, probabilities: dist({ locate: 0.94, understand: 0.06 }) } },
]);

type Handler = (event: unknown, ctx?: unknown) => unknown;
/** What the tests read off a `tool_call` result: the revised task input, or a refusal. */
interface ToolCallResult {
	input: { tasks: { agent: string; name?: string }[]; context?: string } & Record<string, unknown>;
	block?: boolean;
	reason?: string;
}
/** What the tests read off a `before_subagent_spawn` result. */
interface SpawnResult {
	model?: string[];
	note?: string;
	block?: boolean;
	reason?: string;
}
function host(overrides: Partial<Parameters<typeof createClassifierExtension>[0]> = {}) {
	const handlers: Record<string, Handler> = {};
	const { ledger, workloadId } = scratchLedger(["sl-review", "sl-change", "sl-find"]);
	createClassifierExtension({
		judge: async () => judge,
		tierTable: () => TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => ledger,
		laneId: "lane-test",
		boundWorkload: () => undefined,
		// No lost-hand settle here: every recorded omp is alive (snapshot-settle.test.ts T10 drives the rule).
		ompState: () => "same",
		lastWrite: () => null,
		// The lane's cwd here is no repository; a review hand's read-only check is crosslab.test.ts's.
		fingerprint: () => "unchanged",
		...overrides,
	})({ on: (event: string, handler: Handler) => (handlers[event] = handler) } as never);
	const ctx = {
		cwd: "/tmp",
		modelRegistry: fakeRegistry(Object.values(TABLE).flat()),
		model: currentModel(DEFAULT_LANE_MODEL),
		sessionManager: { getSessionFile: () => "/tmp/lane.jsonl" },
	};
	return {
		routings: () => ledger.routings(workloadId),
		toolCall: async (input: unknown, toolCallId = "call-1") =>
			(await handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx)) as ToolCallResult,
		spawn: async (agent: string, spawnKey?: string, invocationKind = "task") =>
			(await handlers.before_subagent_spawn!(
				{ type: "before_subagent_spawn", agent, invocationKind, patterns: [], spawnKey },
				ctx,
			)) as SpawnResult | undefined,
		/** A blocking tier hand answers in its own session on the model it reports, then its task call returns. */
		settle: (toolCallId: string, id: string, agent: string, resolvedModelIdentity: string) => {
			const [provider, ...model] = resolvedModelIdentity.split("/");
			handlers.message_end!(
				{ type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } },
				{ ...ctx, sessionManager: { getSessionFile: () => `/tmp/lane/${id}.jsonl` } },
			);
			return handlers.tool_result!(
				{ type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [], details: { results: [{ id, agent, resolvedModelIdentity }] } },
				ctx,
			);
		},
	};
}

describe("classifier extension on a lane task call", () => {
	test("rewrites each tier item to its computed tier and leaves non-tier names for M4", async () => {
		const h = host();
		const result = await h.toolCall({
			context: "shared",
			tasks: [
				{ agent: "fast", name: "sl-change", task: CHANGE_BRIEF },
				{ agent: "deep", name: "sl-find", task: FIND_BRIEF },
				{ agent: "reviewer", task: "anything" },
			],
		});
		expect(result.input.tasks.map(t => t.agent)).toEqual(["strong", "fast", "reviewer"]);
		expect(result.input.context).toBe("shared");
		expect(result.input.tasks[0]!.name).toBe("sl-change");
		// The bundled/role name was never classified.
		expect(judge.calls.filter(c => c === "anything")).toHaveLength(0);
	});

	test("the spawn gets the tier's row in provider order and the routing lands on the slice's ledger row", async () => {
		const h = host();
		await h.toolCall({ tasks: [{ agent: "fast", name: "sl-review", task: REVIEW_BRIEF }], context: "shared" }, "call-7");
		const spawn = await h.spawn("strong", "sl-review");

		expect(spawn?.model).toEqual(["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"]);
		expect(spawn?.note).toBe(
			"understand 0.42 → standard; pulled up to deep (below 0.55; top two understand/judge); capped to strong (stakes normal); anthropic/claude-opus-5-5 (+2 same-tier fallback)",
		);
		expect(h.routings()).toHaveLength(0); // written at the verdict, not at the spawn
		expect(h.settle("call-7", "sl-review", "strong", "anthropic/claude-opus-5-5")).toBeUndefined();
		const rows = h.routings();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			workload_id: "wl-abc123",
			slice_id: "sl-review",
			spawn_key: "sl-review",
			kind: "understand",
			confidence: 0.42,
			classified_tier: "standard",
			pull_up_to: "deep",
			stakes: "normal",
			pull_down_to: "strong",
			tier: "strong",
			model: "anthropic/claude-opus-5-5",
			outcome: "ran",
			ran_models: '["anthropic/claude-opus-5-5"]',
			judge_model: "typesafe/jev-1.13.0",
			created_by: "lane-test",
		});
	});

	test("the flat call form is rewritten and routed too", async () => {
		const h = host();
		const result = await h.toolCall({ agent: "standard", name: "sl-find", task: FIND_BRIEF }, "call-9");
		expect(result.input).toEqual({ agent: "fast", name: "sl-find", task: FIND_BRIEF });
		await h.spawn("fast", "sl-find");
		h.settle("call-9", "sl-find", "fast", "anthropic/claude-haiku-5-5");
		expect(h.routings()).toMatchObject([{ slice_id: "sl-find", tier: "fast", model: "anthropic/claude-haiku-5-5", outcome: "ran" }]);
	});

	test("an eval agent() spawn routes on its tier row's entries of the lane's lab and writes no routing row", async () => {
		const h = host();
		const spawn = await h.spawn("deep", undefined, "eval");
		expect(spawn?.model).toEqual(["anthropic/claude-fable-5-1"]);
		expect(spawn?.note).toContain("tier deep (unclassified)");
		expect(spawn?.note).toContain(`lane lab anthropic (${DEFAULT_LANE_MODEL})`);
		expect(h.routings()).toHaveLength(0);
	});

	test("a non-tier spawn and a non-tier task call are none of the classifier's business", async () => {
		const h = host();
		expect(await h.spawn("reviewer")).toBeUndefined();
		expect(await h.toolCall({ tasks: [{ agent: "task", task: "x" }] })).toBeUndefined();
		expect(h.routings()).toHaveLength(0);
	});
});

describe("fail closed", () => {
	test("a judge failure refuses the dispatch instead of routing on a guess", async () => {
		const h = host({
			judge: async () => ({
				judge: async () => {
					throw new Error("typesafe 503");
				},
			}),
		});
		const result = await h.toolCall({ tasks: [{ agent: "fast", name: "sl-find", task: FIND_BRIEF }], context: "shared" });
		expect(result).toEqual({ block: true, reason: "agent-system-2 classifier could not route this dispatch: typesafe 503" });
	});

	test("an invalid profile table refuses the spawn", async () => {
		const h = host({
			tierTable: () => tierTableFromConfig({ task: { agentModelOverrides: { fast: ["anthropic/claude-haiku-5-5"] } } }),
		});
		const spawn = await h.spawn("standard", undefined, "eval");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("task.agentModelOverrides.standard: missing or empty");
		expect(h.routings()).toHaveLength(0);
	});
});

// ---- PLAN wl-mvqwn80onq9hq8 D10 (R23, R24): the round-limit raise asks through ruling review-auto-extend ----------------

describe("round limit: a falling review extends once by itself (D10, R23, R24)", () => {
	const ROWS = {
		fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
		standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
		strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
		deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
	};
	const ROUND_TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
	const [OPUS, SOL] = ROWS.strong as [string, string, string];
	const SL = "sl-x";
	/** Every task here is a review (judge 0.9); a pair-signal request gets `no` twice. */
	const JUDGE = {
		judge: async (req: { questions?: Record<string, unknown> }) => {
			if (req.questions && "taste" in req.questions) {
				const no = { choice: "no", confidence: 0.9, probabilities: { yes: 0.1, no: 0.9 } };
				return { answers: { taste: no, ambiguous: no }, provider: "typesafe", model: "jev-1.13.0", usage: { cost: { total: 0.0001 } } };
			}
			return { answers: { kind: { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) } }, provider: "typesafe", model: "jev-1.13.0" };
		},
	};
	let seq = 0;

	interface World {
		ledger: Ledger;
		wl: string;
		dir: string;
		laneFile: string;
		stakes: Stakes;
		logs: string[];
	}

	function world(stakes: Stakes = "normal"): World {
		const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "auto-extend-"));
		const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
		const wl = ledger.openWorkload({ id: `wl-autoext${++seq}`, brief: "Restyle the settings modal", stakes, mode: "autonomous", by: "orch-test" });
		ledger.addSlice({ id: SL, workloadId: wl, task: SL, doneCondition: "d", inputs: "i", by: "lane-test" });
		ledger.recordEntry({ by: "lane-runner", workloadId: wl, kind: "assumption", body: 'lane-started: lane-test {"pid":1}' });
		mkdirSync(join(dir, "sessions"));
		const laneFile = join(dir, "sessions", "lane.jsonl");
		writeFileSync(laneFile, "");
		return { ledger, wl, dir, laneFile, stakes, logs: [] };
	}

	/** The classifier bound to the lane's session and its hands' sessions; `enqueue` replaces the ledger's (a failing write). */
	function lane(w: World, enqueue?: (input: Parameters<Ledger["enqueue"]>[0]) => string) {
		const handlers: Record<string, Handler> = {};
		const handSession: Record<string, Handler> = {};
		const ledger =
			enqueue === undefined
				? w.ledger
				: (new Proxy(w.ledger, {
						get(target, key) {
							if (key === "enqueue") return enqueue;
							const v = Reflect.get(target, key, target);
							return typeof v === "function" ? v.bind(target) : v;
						},
					}) as Ledger);
		const extension = createClassifierExtension({
			judge: async () => JUDGE as never,
			tierTable: () => ROUND_TABLE,
			disabledProviders: async () => [],
			question: recordedQuestion(),
			calibration: loadCalibration(),
			ledger: () => ledger,
			laneId: "lane-test",
			boundWorkload: () => w.wl,
			ompState: () => "same",
			lastWrite: () => null,
			fingerprint: () => "unchanged",
			log: (line) => w.logs.push(line),
		});
		extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
		extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
		const ctx = { cwd: w.dir, modelRegistry: fakeRegistry(Object.values(ROWS).flat()), sessionManager: { getSessionFile: () => w.laneFile } };
		const assistant = (selector: string) => {
			const [provider, ...model] = selector.split("/");
			return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
		};
		const root = w.laneFile.slice(0, -".jsonl".length);
		handlers.message_end!(assistant(OPUS), ctx);
		let calls = 0;
		return {
			/** One review round of sl-x with `blocking` blocking findings (null: no findings block, an unknown count): dispatch, spawn, answer on sol, settle. */
			async round(blocking: number | null): Promise<void> {
				const call = `rev-${++calls}`;
				const n = w.ledger.routings(w.wl).filter((r) => r.slice_id === SL).length;
				const id = n === 0 ? SL : `${SL}-${n}`;
				const task = `workload: ${w.wl}\ntask: review the change\ndone-condition: d\ninputs: i\nstakes: ${w.stakes}\nceiling-share: 10`;
				const out = (await handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId: call, input: { agent: "strong", name: SL, task } }, ctx)) as
					| { block?: boolean; reason?: string; input?: { agent: string } }
					| undefined;
				expect(out?.block).toBeUndefined();
				const spawned = (await handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent: out!.input!.agent, invocationKind: "task", patterns: [], spawnKey: SL }, ctx)) as
					| { reason?: string }
					| undefined;
				expect(spawned?.reason).toBeUndefined();
				handSession.message_end!(assistant(SOL), { ...ctx, sessionManager: { getSessionFile: () => `${root}/${id}.jsonl` } });
				const findings = Array.from({ length: blocking ?? 0 }, (_, i) => ({ severity: "blocking", kind: "correctness", title: `finding ${call} ${i}` }));
				const output = blocking === null ? "Reviewed the change; it looks mostly fine." : `Reviewed the change.\n\n\`\`\`review-findings\n${JSON.stringify({ findings })}\n\`\`\`\n`;
				handlers.tool_result!(
					{
						type: "tool_result", toolName: "task", toolCallId: call, isError: false, input: {}, content: [],
						details: { results: [{ id, agent: out!.input!.agent, resolvedModelIdentity: SOL, output }] },
					},
					ctx,
				);
			},
		};
	}

	const bodies = (w: World, prefix: string) => w.ledger.entries(w.wl).filter((e) => e.body.startsWith(prefix));
	const notices = (w: World) =>
		w.ledger.db.query<{ body: string; created_by: string; recipient: string }, [string]>("SELECT body, created_by, recipient FROM messages WHERE workload_id = ?1 AND body LIKE 'notice:%'").all(w.wl);
	const limitOf = (w: World) => effectiveRoundLimit(w.ledger.entries(w.wl), w.ledger.instructions(w.wl), w.stakes, SL);

	/** Jo's word on the standing workload, as the surface writes it. */
	function joSays(w: World, body: string): void {
		if (!w.ledger.workload(STANDING_WORKLOAD_ID)) w.ledger.openWorkload({ by: SURFACE_BY, id: STANDING_WORKLOAD_ID, brief: "standing", stakes: "normal", mode: "user-driven" });
		w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body, author: "jo", channel: "surface" });
	}

	test("R23: blocking 3→2→1 at normal stakes: no question; the ruling-applied entry, CLASSIFIER_BY's extend naming it and the notice; the next limit asks", async () => {
		const w = world();
		const h = lane(w);
		for (const b of [3, 2, 1]) await h.round(b);
		expect(w.ledger.questions(w.wl)).toEqual([]);
		const applied = bodies(w, "ruling-applied:");
		expect(applied.map((e) => [e.body, e.created_by, e.slice_id])).toEqual([[`ruling-applied: review-auto-extend kind round-limit slice ${SL} answer extend`, "lane-test", SL]]);
		const extend = bodies(w, "review-rounds-extend:");
		expect(extend.map((e) => [e.body, e.created_by])).toEqual([[`review-rounds-extend: ${SL} +3 by ${applied[0]!.id}`, CLASSIFIER_BY]]);
		const count = countRounds(w.ledger.entries(w.wl), SL);
		expect(notices(w)).toEqual([{ body: `notice: ${autoExtendNoticeBody(SL, w.wl, count)}`, created_by: CLASSIFIER_BY, recipient: "orchestrator" }]);
		expect(notices(w)[0]!.body).toContain("blocking 3→2→1");
		expect(limitOf(w)).toEqual({ workload: 3, extend: 3, total: 6 });
		expect(w.ledger.slice(SL)!.state).toBe("open");
		expect(w.logs.some((l) => l.includes(`extended it by 3 rounds (review-rounds-extend: by ${applied[0]!.id})`))).toBe(true);

		// Still falling, but the loop has its extend: the second limit asks Jo.
		for (const b of [3, 2, 1]) await h.round(b);
		const qs = w.ledger.questions(w.wl);
		expect(qs.map((q) => JSON.parse(q.options))).toEqual([[...ROUND_LIMIT_OPTIONS]]);
		expect(bodies(w, `review-limit: ${qs[0]!.id} slice ${SL}`)).toHaveLength(1);
		expect(bodies(w, "ruling-applied:")).toHaveLength(1);
		expect(bodies(w, "review-rounds-extend:")).toHaveLength(1);
		expect(limitOf(w).total).toBe(6);
	});

	for (const [name, counts] of [["flat", [2, 2, 2]], ["rising", [1, 2, 3]], ["falling then flat", [3, 2, 2]]] as const) {
		test(`R24: a ${name} blocking count raises the round-limit question to Jo as before`, async () => {
			const w = world();
			const h = lane(w);
			for (const b of counts) await h.round(b);
			const qs = w.ledger.questions(w.wl);
			expect(qs.map((q) => JSON.parse(q.options))).toEqual([[...ROUND_LIMIT_OPTIONS]]);
			expect(qs[0]!.body).not.toContain("auto-extend failed");
			expect([bodies(w, "ruling-applied:"), bodies(w, "review-rounds-extend:"), notices(w)]).toEqual([[], [], []]);
		});
	}

	test("R24: an unknown blocking count in any round raises the question", async () => {
		const w = world();
		const h = lane(w);
		// 3, unknown (the loop's first unread round, free), 2, 1: the third failed round is the limit, and one count is unknown.
		for (const b of [3, null, 2, 1]) await h.round(b);
		const count = countRounds(w.ledger.entries(w.wl), SL);
		expect(count.rounds.map((r) => r.blocking)).toEqual([3, null, 2, 1]);
		expect(count.failed).toBe(3);
		expect(w.ledger.questions(w.wl).map((q) => JSON.parse(q.options))).toEqual([[...ROUND_LIMIT_OPTIONS]]);
		expect([bodies(w, "ruling-applied:"), bodies(w, "review-rounds-extend:"), notices(w)]).toEqual([[], [], []]);
	});

	test("R24: Jo's ask-all turns auto-apply off: the falling loop asks", async () => {
		const w = world();
		joSays(w, "ask-all");
		const h = lane(w);
		for (const b of [3, 2, 1]) await h.round(b);
		expect(w.ledger.questions(w.wl).map((q) => JSON.parse(q.options))).toEqual([[...ROUND_LIMIT_OPTIONS]]);
		expect([bodies(w, "ruling-applied:"), bodies(w, "review-rounds-extend:"), notices(w)]).toEqual([[], [], []]);
	});

	test("R24: throwaway stakes asks; so does Jo's end-ruling review-auto-extend", async () => {
		const t = world("throwaway");
		const ht = lane(t);
		for (const b of [3, 2, 1]) await ht.round(b);
		expect(t.ledger.questions(t.wl)).toHaveLength(1);
		const e = world();
		joSays(e, "end-ruling review-auto-extend");
		const he = lane(e);
		for (const b of [3, 2, 1]) await he.round(b);
		expect(e.ledger.questions(e.wl)).toHaveLength(1);
		expect(bodies(e, "review-rounds-extend:")).toEqual([]);
	});

	test("R24: the notice write fails: ruling-applied, extend and notice roll back; the question is raised with the failure named", async () => {
		const w = world();
		const h = lane(w, (input) => {
			if (input.body.startsWith("notice: review of")) throw new Error("disk I/O error");
			return w.ledger.enqueue(input);
		});
		for (const b of [3, 2, 1]) await h.round(b);
		const qs = w.ledger.questions(w.wl);
		expect(qs).toHaveLength(1);
		expect(JSON.parse(qs[0]!.options)).toEqual([...ROUND_LIMIT_OPTIONS]);
		expect(qs[0]!.body).toEndWith("\n\nauto-extend failed: disk I/O error");
		expect(bodies(w, `review-limit: ${qs[0]!.id} slice ${SL}`)).toHaveLength(1);
		expect([bodies(w, "ruling-applied:"), bodies(w, "review-rounds-extend:"), notices(w)]).toEqual([[], [], []]);
		expect(limitOf(w).total).toBe(3);
		expect(w.logs.some((l) => l.includes(`because ruling review-auto-extend's extend could not be written (disk I/O error)`))).toBe(true);
	});

	test("R24: the ruling's own ruling-applied write fails: nothing of the extend is written; the question is raised with the failure named", async () => {
		const w = world();
		const real = w.ledger.recordEntry.bind(w.ledger);
		w.ledger.recordEntry = (input) => {
			if (input.body.startsWith(`ruling-applied: review-auto-extend`)) throw new Error("disk I/O error");
			return real(input);
		};
		const h = lane(w);
		for (const b of [3, 2, 1]) await h.round(b);
		w.ledger.recordEntry = real;
		const qs = w.ledger.questions(w.wl);
		expect(qs).toHaveLength(1);
		expect(qs[0]!.body).toEndWith("\n\nauto-extend failed: asking through ruling review-auto-extend: disk I/O error");
		expect(bodies(w, `review-limit: ${qs[0]!.id} slice ${SL}`)).toHaveLength(1);
		expect([bodies(w, "ruling-applied:"), bodies(w, "review-rounds-extend:"), notices(w)]).toEqual([[], [], []]);
		expect(limitOf(w).total).toBe(3);
	});

	test("R24: the notice write fails and the raise fails too: the round is not closed and the log names both errors", async () => {
		const w = world();
		const real = w.ledger.raiseQuestion.bind(w.ledger);
		const h = lane(w, (input) => {
			if (input.body.startsWith("notice: review of")) {
				w.ledger.raiseQuestion = () => {
					throw new Error("questions table locked");
				};
				throw new Error("disk I/O error");
			}
			return w.ledger.enqueue(input);
		});
		for (const b of [3, 2, 1]) await h.round(b);
		w.ledger.raiseQuestion = real;
		expect(w.ledger.questions(w.wl)).toEqual([]);
		expect(bodies(w, "review-rounds-extend:")).toEqual([]);
		const closed = w.logs.find((l) => l.includes("could not be closed"));
		expect(closed).toContain("disk I/O error");
		expect(closed).toContain("questions table locked");
	});
});
