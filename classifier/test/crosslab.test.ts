/**
 * Cross-lab review end to end (PLAN wl-mupu0sx2o046io D1–D6, MIGRATION.md follow-up 23) and the
 * review round limit and stop wiring (D9/D10, follow-up 33): the classifier extension on a fake OMP
 * host with a real temp ledger, a real git repository as the lane's working directory, and a lane
 * session file on disk (so a hand's session is told from the lane's own). Covers the plan's Routing,
 * Read-only reviews, Production fan-out, Park, Review-4 notes, Round limit (D9) wired and Stop
 * (D10) wired test lists.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBriefFields } from "../../gates/src/rows/r05-brief-fields";
import { LANE_RUNNER_BY, Ledger, type Stakes } from "../../ledger/src/index";
import { createClassifierExtension, REVIEW_FINDINGS_PARAGRAPH } from "../extension";
import { loadCalibration } from "../src/classify";
import { reviewStopBody, stopReviewsInstructionBody } from "../src/review-stop";
import { handSpawnBody } from "../src/lab";
import { countRounds, parseReviewRound, reviewRoundsBody, roundsInstructionBody } from "../src/rounds";
import { tierTableFromConfig, type TierTable } from "../src/tier-table";
import { JO_HOLDER } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { asyncDelivery, dist, fakeRegistry, recordedQuestion } from "./helpers";

const ROWS = {
	fast: ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const [OPUS, SOL, KIMI] = ROWS.strong as [string, string, string];
const [FABLE, ASTRA, K3] = ROWS.deep as [string, string, string];

/** Answers by the brief's task text: `review…` judge 0.9; `edge…` understand at exactly 0.55 with judge second; `near…` the same at 0.56; anything else change-large 0.9. */
function answer(brief: string) {
	const task = /^task: (.*)$/m.exec(brief)?.[1] ?? "";
	if (task.startsWith("review")) return { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) };
	if (task.startsWith("edge")) return { choice: "understand", confidence: 0.55, probabilities: dist({ understand: 0.55, judge: 0.4 }) };
	if (task.startsWith("near")) return { choice: "understand", confidence: 0.56, probabilities: dist({ understand: 0.56, judge: 0.4 }) };
	return { choice: "change-large", confidence: 0.9, probabilities: dist({ "change-large": 0.9 }) };
}
const JUDGE = { judge: async ({ state }: { state: string }) => ({ answers: { kind: answer(state) }, provider: "typesafe", model: "jev-1.13.0" }) };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/**
 * A workload on a temp ledger, the lane's repository, its session file, and a mutable registry:
 * `creds` lists the credentialed models (edit it to take a lab down or bring it back).
 */
function world(opts: { stakes?: Stakes; slices?: string[]; table?: TierTable; laneStarted?: boolean } = {}) {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "crosslab-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-cross", brief: "crosslab test", stakes: opts.stakes ?? "normal", mode: "autonomous", by: "orch-test" });
	for (const id of opts.slices ?? ["sl-x", "sl-y", "sl-work"]) ledger.addSlice({ id, workloadId: wl, task: id, doneCondition: "d", inputs: "i", by: "lane-test" });
	if (opts.laneStarted !== false) ledger.recordEntry({ by: "lane-runner", workloadId: wl, kind: "assumption", body: 'lane-started: lane-test {"pid":1}' });
	const repo = join(dir, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "init");
	mkdirSync(join(dir, "sessions"));
	const laneFile = join(dir, "sessions", "lane.jsonl");
	writeFileSync(laneFile, "");
	const creds = [...ALL];
	return { dir, ledger, wl, repo, laneFile, root: laneFile.slice(0, -".jsonl".length), creds, registry: fakeRegistry(ALL, creds), table: opts.table ?? TABLE };
}
type World = ReturnType<typeof world>;

const down = (w: World, ...models: string[]) => {
	for (const m of models) w.creds.splice(w.creds.indexOf(m), 1);
};
const up = (w: World, ...models: string[]) => w.creds.push(...models);

const brief = (w: World, task: string, stakes: Stakes = "normal") =>
	`workload: ${w.wl}\ntask: ${task}\ndone-condition: d\ninputs: i\nstakes: ${stakes}\nceiling-share: 10`;

type Handler = (event: unknown, ctx?: unknown) => unknown;
/** A rewritten task item, as the tests read it back. */
type Item = { agent: string; name: string; task?: string };
/** What a `tool_call` or `before_subagent_spawn` handler returns: a refusal, the rewritten call (flat or batch), or a model row. */
type Reply = { block?: boolean; reason?: string; input?: Item & { tasks: Item[]; context?: string }; model?: string[]; note?: string } | undefined;

/** One lane process: the classifier bound to the lane's session and to its hands' sessions. A second `lane(w)` is a restart. */
function lane(w: World, opts: { fingerprint?: (cwd: string) => string } = {}) {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const logs: string[] = [];
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => w.table,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => w.ledger,
		laneId: "lane-test",
		boundWorkload: () => w.wl,
		log: line => logs.push(line),
		...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.repo, modelRegistry: w.registry, sessionManager: { getSessionFile: () => w.laneFile } };
	const handCtx = (agentId: string) => ({ ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } });
	const assistant = (selector: string) => {
		const [provider, ...model] = selector.split("/");
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
	};
	const text = (msg: unknown) => (typeof msg === "object" && msg !== null && "content" in msg ? String(msg.content) : "");
	return {
		logs,
		toolCall: (input: unknown, toolCallId = "call-1") => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
		spawn: (agent: string, spawnKey: string) =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<Reply>,
		/** An assistant turn of the lane itself. */
		laneMessage: (selector: string) => handlers.message_end!(assistant(selector), ctx),
		/** An assistant turn in hand `agentId`'s own session. */
		handMessage: (agentId: string, selector: string) => handSession.message_end!(assistant(selector), handCtx(agentId)),
		/** Hand `agentId` calls `toolName` in its own session. */
		handTool: (agentId: string, toolName: string) => handSession.tool_call!({ type: "tool_call", toolName, toolCallId: "t-1", input: {} }, handCtx(agentId)) as Promise<Reply>,
		/** A blocking task call returns with these tier results (`output`: the hand's reply, `results[].output`). */
		results: (toolCallId: string, results: { id: string; agent: string; model?: string; output?: string }[]) =>
			handlers.tool_result!(
				{
					type: "tool_result",
					toolName: "task",
					toolCallId,
					isError: false,
					input: {},
					content: [],
					details: { results: results.map(r => ({ id: r.id, agent: r.agent, resolvedModelIdentity: r.model, ...(r.output === undefined ? {} : { output: r.output }) })) },
				},
				ctx,
			) as { isError?: boolean; content?: { text: string }[] } | undefined,
		/** An async task call returns with its members scheduled. */
		asyncReturned: (toolCallId: string, progress: { index: number; id: string; status?: string }[]) =>
			handlers.tool_result!(
				{ type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [], details: { async: { state: "running", jobId: "j", type: "task" }, progress } },
				ctx,
			),
		/** Async jobs deliver their output: the text the lane's model is sent for it. */
		deliver: (agentIds: string[], output = "hand output") => {
			const result = handlers.context!({ type: "context", messages: [asyncDelivery(agentIds, output)] }, ctx) as { messages?: unknown[] } | undefined;
			return text(result?.messages?.[0] ?? asyncDelivery(agentIds, output));
		},
	};
}
type Lane = ReturnType<typeof lane>;

const bodies = (w: World, prefix = "") => w.ledger.entries(w.wl).map(e => e.body).filter(b => b.startsWith(prefix));
const questions = (w: World) => w.ledger.questions(w.wl);

/** A blocking tier dispatch of `sliceId` that spawns, answers on `model`, and settles. */
async function settled(h: Lane, w: World, sliceId: string, task: string, model: string, call: string) {
	const out = await h.toolCall({ agent: "strong", name: sliceId, task: brief(w, task) }, call);
	expect(out?.block).toBeUndefined();
	const spawn = await h.spawn(out!.input.agent, sliceId);
	h.handMessage(sliceId, model);
	return { spawn, result: h.results(call, [{ id: sliceId, agent: out!.input.agent, model }]) };
}

/** A blocking review of `sliceId` up to its spawn reply. */
async function reviewSpawn(h: Lane, w: World, sliceId = "sl-x", call = "rev-1") {
	const out = await h.toolCall({ agent: "strong", name: sliceId, task: brief(w, "review the change") }, call);
	expect(out?.block).toBeUndefined();
	return h.spawn(out!.input.agent, sliceId);
}

describe("Routing", () => {
	test("builders {anthropic}: the review's spawn row has no anthropic entry, and a review that answered on anthropic is withheld", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.model).toEqual([SOL, KIMI]);
		expect(spawn?.note).toContain("review routed off the builder lab anthropic");
		h.handMessage("sl-x", OPUS);
		const out = h.results("rev-1", [{ id: "sl-x", agent: "strong", model: OPUS }]);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain(`sl-x ran on ${OPUS}, outside the strong row (${SOL}, ${KIMI})`);
		expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-x", outcome: "refused-out-of-row", models: JSON.stringify([SOL, KIMI]) }]);
	});

	test("a change hand that fell back to openai makes builders {anthropic, openai}: the review goes to kimi only; the change itself was unaffected", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const change = await settled(h, w, "sl-work", "change the loader", SOL, "c1");
		expect(change.spawn?.model).toEqual([OPUS, SOL, KIMI]); // a change dispatch keeps its whole row
		expect(change.result).toBeUndefined();
		expect((await reviewSpawn(h, w))?.model).toEqual([KIMI]);
	});

	test("a hand-spawn token with no hand-settled entry counts its whole row (a change lost before settle)", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		down(w, KIMI);
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it") }, "c1");
		expect((await h.spawn(out!.input.agent, "sl-work"))?.model).toEqual([OPUS, SOL]);
		up(w, KIMI);
		const restarted = lane(w); // the process died with the change hand in flight
		expect((await reviewSpawn(restarted, w))?.model).toEqual([KIMI]);
	});

	test("T1: one slice dispatched twice, the first settled and the second lost before settle: the second still counts", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await settled(h, w, "sl-work", "change it", OPUS, "c1");
		const again = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it again") }, "c2");
		await h.spawn(again!.input.agent, "sl-work"); // the same spawn key as the settled first
		const spawns = bodies(w, "hand-spawn:");
		expect(spawns).toHaveLength(2);
		expect(new Set(spawns.map(b => b.split(" ")[1])).size).toBe(2); // one token per dispatch
		const restarted = lane(w);
		const review = await reviewSpawn(restarted, w);
		expect(review?.block).toBe(true); // the lost second dispatch's whole row counts: no lab is left
		expect(review?.reason).toContain("parked on question");
	});

	test("a settled refused-model-unknown change row counts its whole row", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		down(w, KIMI);
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it") }, "c1");
		await h.spawn(out!.input.agent, "sl-work");
		expect(h.results("c1", [{ id: "sl-work", agent: "strong", model: OPUS }])?.isError).toBe(true); // no turn seen
		expect(w.ledger.routings(w.wl)).toMatchObject([{ outcome: "refused-model-unknown", ran_models: null }]);
		up(w, KIMI);
		expect((await reviewSpawn(h, w))?.model).toEqual([KIMI]);
	});

	test("a review while a change hand of the workload is in flight is refused; so is a mixed review+change batch", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const mixed = await h.toolCall({
			context: "shared",
			tasks: [
				{ agent: "strong", name: "sl-x", task: brief(w, "review the change") },
				{ agent: "strong", name: "sl-work", task: brief(w, "change it") },
			],
		});
		expect(mixed?.block).toBe(true);
		expect(mixed?.reason).toContain("task 1 (sl-x) is a review and task 2 (sl-work) is not, in one call on workload wl-cross");
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it") }, "c1");
		await h.spawn(out!.input.agent, "sl-work");
		const review = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2");
		expect(review?.block).toBe(true);
		expect(review?.reason).toContain("non-review work of workload wl-cross is still in flight (sl-work)");
	});

	test("item 109: a lane with lane-started: and no builder-lab: is routed off the lab its lane-started: record names, not parked", async () => {
		const w = world({ laneStarted: false });
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: `lane-started: lane-test {"pid":1,"session":null,"model":null,"ranModel":"${OPUS}"}` });
		const h = lane(w); // the lane has not answered yet: no builder-lab entry
		expect((await reviewSpawn(h, w))?.model).toEqual([SOL, KIMI]);
		expect(questions(w)).toHaveLength(0);
		expect(bodies(w, "builder-lab-gap:")).toEqual([]);
	});

	test("item 109: a lane whose lane-started: record names no model is a recorded gap: the review parks naming it, and the gap is recorded once", async () => {
		const w = world();
		const h = lane(w); // the lane never answered: no builder-lab entry, and its record has no model
		const gapText = "lane lane-test has a lane-started: entry, no builder-lab: entry and no model in its lane-started: record, so the lab it ran on is unknown";
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		expect(questions(w)).toHaveLength(1);
		expect(questions(w)[0]!.body).toContain(`(every lab: ${gapText})`);
		expect(bodies(w, "builder-lab-gap:")).toEqual([`builder-lab-gap: ${gapText}`]);
		await reviewSpawn(h, w, "sl-y", "rev-2");
		expect(bodies(w, "builder-lab-gap:")).toEqual([`builder-lab-gap: ${gapText}`]); // recorded once
	});

	test("an unknown provider parks: in the builder history, and as the only other entry of the row", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage("mystery/model-x");
		expect(bodies(w, "builder-lab:")).toEqual(["builder-lab: unknown lane lane-test model mystery/model-x"]);
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		expect(questions(w)[0]!.body).toContain("unknown lab for provider mystery");

		const rows = { ...ROWS, strong: [OPUS, "mystery/model-x"] };
		const v = world({ table: tierTableFromConfig({ task: { agentModelOverrides: rows } }) });
		up(v, "mystery/model-x");
		const registry = fakeRegistry([...ALL, "mystery/model-x"], v.creds);
		const u = lane({ ...v, registry });
		u.laneMessage(OPUS);
		expect((await reviewSpawn(u, { ...v, registry }))?.block).toBe(true);
		expect(questions(v)[0]!.body).toContain("mystery/model-x (unknown lab for provider mystery; add it to classifier/src/lab.ts)");
	});

	test("builder-lab: is written once per lab per lane, across a restart", () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		h.laneMessage(OPUS);
		h.laneMessage(SOL);
		lane(w).laneMessage(OPUS);
		expect(bodies(w, "builder-lab:")).toEqual([`builder-lab: anthropic lane lane-test model ${OPUS}`, `builder-lab: openai lane lane-test model ${SOL}`]);
	});

	test("review detection at exactly 0.55 with judge in the top two; at 0.56 it is no review", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const edge = await h.toolCall({ agent: "fast", name: "sl-x", task: brief(w, "edge: look at the design") }, "c1");
		expect(edge?.input.agent).toBe("strong"); // pulled up to deep, capped at strong
		expect((await h.spawn("strong", "sl-x"))?.model).toEqual([SOL, KIMI]);
		const near = await h.toolCall({ agent: "fast", name: "sl-y", task: brief(w, "near: look at the design") }, "c2");
		expect(near?.input.agent).toBe("standard");
		expect((await h.spawn("standard", "sl-y"))?.model).toEqual(ROWS.standard);
	});
});

describe("Read-only reviews", () => {
	test("a review hand's editing tools are refused in its own session; a change hand's are not", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await reviewSpawn(h, w);
		for (const tool of ["edit", "write", "ast_edit"]) {
			expect((await h.handTool("sl-x", tool))?.reason).toContain("a review hand does not change the work; the lane dispatches the fix as a change slice");
		}
		expect(await h.handTool("sl-x", "read")).toBeUndefined();
		// Work dispatched while a review runs is not held back; its hand edits freely.
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it") }, "c2");
		await h.spawn(out!.input.agent, "sl-work");
		expect(await h.handTool("sl-work", "edit")).toBeUndefined();
	});

	const mutations: [string, (repo: string) => void][] = [
		["changed a worktree file", repo => writeFileSync(join(repo, "a.txt"), "changed by the review\n")],
		[
			"staged a change only in the index (T3)",
			repo => {
				writeFileSync(join(repo, "a.txt"), "staged\n");
				git(repo, "add", "a.txt");
				writeFileSync(join(repo, "a.txt"), "one\n");
			},
		],
	];
	for (const [what, mutate] of mutations) {
		test(`a review whose bash ${what}: output withheld, its lab a builder, still withheld by recover() after a restart`, async () => {
			const w = world();
			const h = lane(w);
			h.laneMessage(OPUS);
			expect((await reviewSpawn(h, w))?.model).toEqual([SOL, KIMI]);
			mutate(w.repo);
			h.handMessage("sl-x", SOL);
			const out = h.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL }]);
			expect(out?.isError).toBe(true);
			expect(out?.content?.[0]?.text).toContain("the review changed the work");
			const token = bodies(w, "hand-spawn:")[0]!.split(" ")[1]!;
			expect(bodies(w, "review-withheld:")).toEqual([`review-withheld: ${token}`]);
			expect(bodies(w, "builder-lab: openai hand")).toEqual([`builder-lab: openai hand ${token} model ${SOL}`]);
			expect(w.ledger.routings(w.wl)).toMatchObject([{ outcome: "ran" }]); // the row records what ran; the entry withholds

			const restarted = lane(w);
			const replay = restarted.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL }]);
			expect(replay?.content?.[0]?.text).toContain("is a review that changed the work (review-withheld:");
			// The next review is routed off openai too.
			git(w.repo, "checkout", "-q", "--", ".");
			expect((await reviewSpawn(restarted, w, "sl-y", "rev-2"))?.model).toEqual([KIMI]);
		});
	}

	// PLAN wl-muq13bkdghblmo step 7: the fingerprint sees only the lane's own work, so a new ref is no change.
	test("a review whose bash only moved a ref: output accepted, its lab not a builder", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		expect((await reviewSpawn(h, w))?.model).toEqual([SOL, KIMI]);
		git(w.repo, "branch", "side");
		h.handMessage("sl-x", SOL);
		expect(h.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL }])).toBeUndefined();
		expect(bodies(w, "review-withheld:")).toEqual([]);
		expect(bodies(w, "builder-lab: openai hand")).toEqual([]);
		expect((await reviewSpawn(lane(w), w, "sl-y", "rev-2"))?.model).toEqual([SOL, KIMI]);
	});

	test("T2: an OpenAI review hand that wrote and was lost before settle: the next review excludes OpenAI", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		down(w, KIMI);
		expect((await reviewSpawn(h, w))?.model).toEqual([SOL]);
		writeFileSync(join(w.repo, "a.txt"), "written by the lost review\n");
		up(w, KIMI);
		expect((await reviewSpawn(lane(w), w, "sl-y", "rev-2"))?.model).toEqual([KIMI]);
	});
});

describe("Production fan-out", () => {
	test("brief normal on a production workload: effective production, tier deep, one pinned hand per other lab, two rows on the slice; row 5 passes the expanded call", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		const input = { agent: "strong", name: "sl-x", task: brief(w, "review the change") };
		const out = await h.toolCall(input, "c1");
		expect(out?.input.tasks.map((t: { name: string; agent: string }) => `${t.name}@${t.agent}`)).toEqual(["sl-x--openai@deep", "sl-x--kimi@deep"]);
		expect(checkBriefFields(out!.input, w.wl)).toBeNull();
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([ASTRA]);
		expect((await h.spawn("deep", "sl-x--kimi"))?.model).toEqual([K3]);
		h.handMessage("sl-x--openai", ASTRA);
		h.handMessage("sl-x--kimi", K3);
		expect(
			h.results("c1", [
				{ id: "sl-x--openai", agent: "deep", model: ASTRA },
				{ id: "sl-x--kimi", agent: "deep", model: K3 },
			]),
		).toBeUndefined();
		expect(w.ledger.routings(w.wl)).toMatchObject([
			{ slice_id: "sl-x", agent_id: "sl-x--openai", stakes: "production", tier: "deep", models: JSON.stringify([ASTRA]), outcome: "ran" },
			{ slice_id: "sl-x", agent_id: "sl-x--kimi", stakes: "production", tier: "deep", models: JSON.stringify([K3]), outcome: "ran" },
		]);
		const groups = bodies(w, "hand-spawn:").map(b => / group (\S+) /.exec(b)![1]);
		expect(groups[0]).toBe(groups[1]!); // one round
	});

	test("a mixed batch keeps indices straight; async members correlate; recover() of sl-x--kimi-1 after a restart", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall(
			{ context: "shared", tasks: [{ agent: "task", name: "helper", task: "unrelated" }, { agent: "strong", name: "sl-x", task: brief(w, "review it") }] },
			"c1",
		);
		expect(out?.input.tasks.map((t: { name: string }) => t.name)).toEqual(["helper", "sl-x--openai", "sl-x--kimi"]);
		h.asyncReturned("c1", [
			{ index: 1, id: "sl-x--openai", status: "running" },
			{ index: 2, id: "sl-x--kimi-1", status: "running" }, // OMP's -N collision suffix
		]);
		expect((await h.spawn("deep", "sl-x--kimi-1"))?.model).toEqual([K3]);
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([ASTRA]);
		h.handMessage("sl-x--openai", ASTRA);
		h.handMessage("sl-x--kimi-1", K3);
		expect(h.deliver(["sl-x--openai", "sl-x--kimi-1"], "FINDINGS")).toBe("FINDINGS");
		expect(w.ledger.routings(w.wl).map(r => r.agent_id)).toEqual(["sl-x--openai", "sl-x--kimi-1"]);
		expect(lane(w).deliver(["sl-x--kimi-1"], "FINDINGS")).toBe("FINDINGS");
	});

	test("one lab down: one hand and a short-fan-out note", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		down(w, K3);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		expect(out?.input).toMatchObject({ name: "sl-x", agent: "deep" });
		const spawn = await h.spawn("deep", "sl-x");
		expect(spawn?.model).toEqual([ASTRA]);
		expect(spawn?.note).toContain(`production review fans out to openai only (${K3} (no credentials))`);
	});

	test("both pinned spawns refused: one park; one member still running: no park", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		down(w, ASTRA, K3);
		expect((await h.spawn("deep", "sl-x--openai"))?.block).toBe(true);
		expect(questions(w)).toHaveLength(0); // the kimi member is still pending
		expect((await h.spawn("deep", "sl-x--kimi"))?.block).toBe(true);
		expect(questions(w)).toHaveLength(1);
		expect(bodies(w, "review-park:")).toEqual([`review-park: ${questions(w)[0]!.id} slice sl-x`]);

		const v = world({ stakes: "production" });
		const g = lane(v);
		g.laneMessage(OPUS);
		await g.toolCall({ agent: "strong", name: "sl-x", task: brief(v, "review it") }, "c1");
		down(v, ASTRA);
		expect((await g.spawn("deep", "sl-x--openai"))?.block).toBe(true);
		expect((await g.spawn("deep", "sl-x--kimi"))?.model).toEqual([K3]);
		expect(questions(v)).toHaveLength(0); // running
		g.handMessage("sl-x--kimi", K3);
		expect(g.results("c1", [{ id: "sl-x--kimi", agent: "deep", model: K3 }])).toBeUndefined();
		expect(questions(v)).toHaveLength(0); // one accepted review: no park
	});

	test("a slice id too long for <slice>--<lab> in 48 characters is refused", async () => {
		const long = `sl-${"a".repeat(40)}`;
		const w = world({ stakes: "production", slices: [long] });
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: long, task: brief(w, "review it") }, "c1");
		expect(out?.block).toBe(true);
		expect(out?.reason).toContain(`is too long for its production review fan-out name \`${long}--openai\``);
	});
});

describe("Park", () => {
	/** A normal-stakes workload whose only usable strong model is the builder's: the review parks. */
	async function parked() {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		down(w, SOL, KIMI);
		const spawn = await reviewSpawn(h, w);
		return { w, h, spawn, question: questions(w)[0]! };
	}

	test("no other lab: refused, one same-lab/wait question, slice paused, a review-park entry, no row on a builder-lab model", async () => {
		const { w, spawn, question } = await parked();
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain(`parked on question ${question.id}`);
		expect(questions(w)).toHaveLength(1);
		expect(JSON.parse(question.options)).toEqual(["same-lab", "wait"]);
		expect(question.body).toContain(`No lab other than the builder's (anthropic) can review sl-x: ${OPUS} (builder lab anthropic), ${SOL} (no credentials), ${KIMI} (no credentials).`);
		expect(w.ledger.slice("sl-x")?.state).toBe("paused");
		expect(bodies(w, "review-park:")).toEqual([`review-park: ${question.id} slice sl-x`]);
		expect(w.ledger.routings(w.wl).filter(r => r.model?.startsWith("anthropic/"))).toEqual([]);
	});

	test("a re-dispatch while the question is open raises no second question", async () => {
		const { w, h, question } = await parked();
		const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-2");
		expect(again?.block).toBe(true);
		expect(again?.reason).toContain(`parked on question ${question.id}`);
		expect(questions(w)).toHaveLength(1);
	});

	test("same-lab: the next dispatch runs on the builder's lab with a review-same-lab: entry; the dispatch after that asks again", async () => {
		const { w, h, question } = await parked();
		const grant = w.ledger.answerQuestion(question.id, { by: "orchestrator-surface", answer: "same-lab", author: "jo", channel: "surface" });
		const spawn = await reviewSpawn(h, w, "sl-x", "rev-2");
		expect(spawn?.model).toEqual([OPUS]);
		expect(spawn?.note).toContain(`same-lab grant ${grant} spent`);
		const token = bodies(w, "hand-spawn:").at(-1)!.split(" ")[1];
		expect(bodies(w, "review-same-lab:")).toEqual([`review-same-lab: ${grant} token ${token}`]);
		h.handMessage("sl-x", OPUS);
		expect(h.results("rev-2", [{ id: "sl-x", agent: "strong", model: OPUS }])).toBeUndefined(); // the granted row allows it
		const third = await reviewSpawn(h, w, "sl-x", "rev-3");
		expect(third?.block).toBe(true);
		expect(questions(w).filter(q => q.state === "open")).toHaveLength(1);
		expect(questions(w)).toHaveLength(2);
	});

	test("same-lab with another lab back: the row is the other labs, then the builder's", async () => {
		const { w, h, question } = await parked();
		w.ledger.answerQuestion(question.id, { by: "orchestrator-surface", answer: "same-lab", author: "jo", channel: "surface" });
		up(w, SOL);
		expect((await reviewSpawn(h, w, "sl-x", "rev-2"))?.model).toEqual([SOL, OPUS]);
	});

	test("a second dispatch racing for the same grant gets the normal rule", async () => {
		const { w, question } = await parked();
		w.ledger.answerQuestion(question.id, { by: "orchestrator-surface", answer: "same-lab", author: "jo", channel: "surface" });
		const a = lane(w);
		const b = lane(w);
		const outA = await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "a-1");
		const outB = await b.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "b-1");
		expect((await a.spawn(outA!.input.agent, "sl-x"))?.model).toEqual([OPUS]);
		const late = await b.spawn(outB!.input.agent, "sl-x");
		expect(late?.block).toBe(true); // no grant left, no other lab: it parks again
		expect(bodies(w, "review-same-lab:")).toHaveLength(1);
	});

	test("wait and a withdrawal grant nothing", async () => {
		for (const resolve of ["wait", "withdraw"] as const) {
			const { w, h, question } = await parked();
			if (resolve === "wait") w.ledger.answerQuestion(question.id, { by: "orchestrator-surface", answer: "wait", author: "jo", channel: "surface" });
			else w.ledger.withdrawQuestion(question.id, { by: "orchestrator-surface", reason: "not now", author: "jo", channel: "surface", then: "replan" });
			const again = await reviewSpawn(h, w, "sl-x", "rev-2");
			expect(again?.block).toBe(true);
			expect(bodies(w, "review-same-lab:")).toEqual([]);
			expect(questions(w)).toHaveLength(2);
		}
	});

	test("a single review hand with no answering model parks at settle", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		expect((await reviewSpawn(h, w))?.model).toEqual([SOL, KIMI]);
		const out = h.results("rev-1", [{ id: "sl-x", agent: "strong" }]);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain("parked on question");
		expect(questions(w)).toHaveLength(1);
		expect(questions(w)[0]!.body).toContain("the review hand sl-x ended with no model answering");
	});
});

describe("Review-4 notes", () => {
	const inject = (w: World, prefix: string) =>
		w.ledger.db.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON entries WHEN NEW.body LIKE '${prefix}%' BEGIN SELECT RAISE(ABORT, 'injected ${prefix} failure'); END;`);

	for (const [fault, changes] of [
		["hand-settled:", false],
		["review-withheld:", true],
	] as const) {
		test(`the routing row, review-withheld:/builder attribution and hand-settled: land together: a fault at ${fault} never lets recover() pass the review`, async () => {
			const w = world();
			const h = lane(w);
			h.laneMessage(OPUS);
			await reviewSpawn(h, w);
			if (changes) writeFileSync(join(w.repo, "a.txt"), "changed\n");
			inject(w, fault);
			h.handMessage("sl-x", SOL);
			const out = h.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL }]);
			expect(out?.content?.[0]?.text).toContain(`injected ${fault} failure`);
			expect(w.ledger.routings(w.wl)).toEqual([]);
			expect(bodies(w, "hand-settled:")).toEqual([]);
			expect(bodies(w, "builder-lab: openai")).toEqual([]);
			const replay = lane(w).results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL }]);
			expect(replay?.isError).toBe(true);
			expect(replay?.content?.[0]?.text).toContain("no settled routing row");
		});
	}

	test("a fan-out group's terminal accounting and single park survive a restart", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		h.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		await h.spawn("deep", "sl-x--openai");
		await h.spawn("deep", "sl-x--kimi");
		h.handMessage("sl-x--openai", FABLE); // off its pinned row
		expect(h.deliver(["sl-x--openai"], "OFF ROW")).not.toContain("OFF ROW");
		expect(questions(w)).toHaveLength(0); // the kimi member is running

		const restarted = lane(w); // the kimi hand died with the process
		expect(restarted.deliver(["sl-x--kimi"], "LOST")).not.toContain("LOST");
		expect(questions(w)).toHaveLength(1);
		restarted.deliver(["sl-x--kimi"], "LOST");
		lane(w).deliver(["sl-x--kimi"], "LOST");
		expect(questions(w)).toHaveLength(1);
		expect(bodies(w, "review-park:")).toHaveLength(1);
	});

	test("a production same-lab grant with zero other labs reaches the single-hand path instead of parking again", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		down(w, ASTRA, K3);
		const first = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		expect(first?.block).toBe(true);
		const question = questions(w)[0]!;
		const grant = w.ledger.answerQuestion(question.id, { by: "orchestrator-surface", answer: "same-lab", author: "jo", channel: "surface" });
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c2");
		expect(out?.input).toMatchObject({ name: "sl-x", agent: "deep" });
		expect((await h.spawn("deep", "sl-x"))?.model).toEqual([FABLE]);
		expect(bodies(w, "review-same-lab:")).toEqual([expect.stringContaining(`review-same-lab: ${grant} token dt-`)]);
		expect(questions(w)).toHaveLength(1);
	});

	test("a fingerprint that cannot be computed fails closed: the output is withheld", async () => {
		const w = world();
		const h = lane(w, {
			fingerprint: () => {
				throw new Error("git is gone");
			},
		});
		h.laneMessage(OPUS);
		await reviewSpawn(h, w);
		h.handMessage("sl-x", SOL);
		const out = h.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL }]);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain("its spawn-time repository fingerprint could not be taken (git is gone)");
		expect(bodies(w, "review-withheld:")).toHaveLength(1);
	});
});

/** A review reply ending in a `review-findings` block. */
const reply = (...findings: { severity: string; kind: string; title: string }[]) =>
	`Reviewed the change.\n\n\`\`\`review-findings\n${JSON.stringify({ findings })}\n\`\`\`\n`;
const CLEAN = reply();
const blocking = (title: string) => reply({ severity: "blocking", kind: "correctness", title });

/**
 * One blocking review round of `slice` on its own call: dispatch, spawn, answer on `model`, settle
 * with `output`. The agent id is the one OMP allocates under one lane root: `sl-x`, then `sl-x-1`, ….
 */
async function reviewRound(h: Lane, w: World, call: string, output: string, opts: { slice?: string; model?: string } = {}) {
	const slice = opts.slice ?? "sl-x";
	const model = opts.model ?? SOL;
	const n = w.ledger.routings(w.wl).filter(r => r.slice_id === slice).length;
	const id = n === 0 ? slice : `${slice}-${n}`;
	const out = await h.toolCall({ agent: "strong", name: slice, task: brief(w, "review the change") }, call);
	expect(out?.block).toBeUndefined();
	expect((await h.spawn(out!.input.agent, slice))?.reason).toBeUndefined();
	h.handMessage(id, model);
	return h.results(call, [{ id, agent: out!.input.agent, model, output }]);
}

/** Jo's `rounds <n>`, as the surface writes it: the instruction and the `review-rounds:` entry naming it. */
function roundsLimit(w: World, n: number): void {
	const by = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: roundsInstructionBody(n), author: JO_HOLDER, channel: "surface" });
	w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: reviewRoundsBody(n, `rounds ${n}`, by) });
}

/** Jo's `stop-reviews <target>`, as the surface writes it; returns the instruction id. */
function stopReviews(w: World, target: string): string {
	const by = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: stopReviewsInstructionBody(target), author: JO_HOLDER, channel: "surface" });
	w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: reviewStopBody(target, by) });
	return by;
}

const rounds = (w: World) => bodies(w, "review-round:").map(b => parseReviewRound(b)!);
const messages = (w: World) => w.ledger.db.query<{ recipient: string; body: string }, [string]>("SELECT recipient, body FROM messages WHERE workload_id = ? ORDER BY created_at, rowid").all(w.wl);

describe("Round limit (D9), wired", () => {
	test("every review item's brief gains the findings paragraph, each fan-out member's too, and a change item's does not", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const review = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c1");
		expect(review?.input.task).toBe(`${brief(w, "review the change")}${REVIEW_FINDINGS_PARAGRAPH}`);
		expect(checkBriefFields(review!.input, w.wl)).toBeNull();
		const change = await lane(w).toolCall({ agent: "strong", name: "sl-work", task: brief(w, "build it") }, "c2");
		expect(change?.input.task).toBe(brief(w, "build it"));

		const p = world({ stakes: "production" });
		const g = lane(p);
		g.laneMessage(OPUS);
		const fan = await g.toolCall({ agent: "strong", name: "sl-x", task: brief(p, "review it") }, "c1");
		expect(fan?.input.tasks.map(t => t.task)).toEqual([`${brief(p, "review it")}${REVIEW_FINDINGS_PARAGRAPH}`, `${brief(p, "review it")}${REVIEW_FINDINGS_PARAGRAPH}`]);
		expect(checkBriefFields(fan!.input, p.wl)).toBeNull();
	});

	test("a blocking task result: settle writes review-round: with the parsed counts and the hand's verdict", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await reviewRound(h, w, "rev-1", reply({ severity: "blocking", kind: "tests", title: "no test for the park" }, { severity: "minor", kind: "docs", title: "typo" }));
		expect(out).toBeUndefined();
		const [r] = rounds(w);
		expect(r).toMatchObject({ slice: "sl-x", round: 1, verdict: "accepted", findings: { counts: { blocking: { tests: 1 }, major: {}, minor: { docs: 1 } } } });
		expect(r!.token).toBe(bodies(w, "hand-spawn:")[0]!.split(" ")[1]!);
		expect(bodies(w, "review-round:")[0]).toContain(" blocking 1 counts ");
		expect(bodies(w, "review-loop-end:")).toEqual([]); // a blocking finding: no pass
	});

	test("an async delivery: findings are read per job, a two-job delivery split at its job headers", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c1");
		h.asyncReturned("c1", [{ index: 0, id: "sl-x", status: "running" }]);
		await h.spawn("strong", "sl-x");
		h.handMessage("sl-x", SOL);
		expect(h.deliver(["sl-x"], blocking("races the grant"))).toContain("races the grant");
		expect(rounds(w)).toMatchObject([{ round: 1, verdict: "accepted", findings: { counts: { blocking: { correctness: 1 } }, titles: [{ title: "races the grant" }] } }]);

		const p = world({ stakes: "production" });
		const g = lane(p);
		g.laneMessage(OPUS);
		await g.toolCall({ agent: "strong", name: "sl-x", task: brief(p, "review it") }, "c1");
		g.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		await g.spawn("deep", "sl-x--openai");
		await g.spawn("deep", "sl-x--kimi");
		g.handMessage("sl-x--openai", ASTRA);
		g.handMessage("sl-x--kimi", K3);
		const text = `2 background jobs have completed. Resume your work using the results below.\n\n── Job sl-x--openai (sl-x--openai) ──\n${blocking("openai finding")}\n── Job sl-x--kimi (sl-x--kimi) ──\n${CLEAN}`;
		expect(g.deliver(["sl-x--openai", "sl-x--kimi"], text)).toBe(text);
		const byToken = new Map(rounds(p).map(r => [r.token, r]));
		const tokens = bodies(p, "hand-spawn:").map(b => b.split(" ")[1]!);
		expect(byToken.get(tokens[0]!)?.findings).toMatchObject({ counts: { blocking: { correctness: 1 } } });
		expect(byToken.get(tokens[1]!)?.findings).toMatchObject({ counts: { blocking: {} }, titles: [] });
	});

	test("the round that reaches the limit raises one extend/accept/stop question at its settle; dispatches after it are refused with no second question", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await reviewRound(h, w, "rev-1", blocking("first"));
		await reviewRound(h, w, "rev-2", blocking("second"));
		expect(questions(w)).toHaveLength(0);
		await reviewRound(h, w, "rev-3", reply({ severity: "blocking", kind: "correctness", title: "the grant races" }, { severity: "major", kind: "design", title: "two sources of truth" }));
		const [q] = questions(w);
		expect(questions(w)).toHaveLength(1);
		expect(JSON.parse(q!.options)).toEqual(["extend", "accept", "stop"]);
		expect(bodies(w, "review-limit:")).toEqual([`review-limit: ${q!.id} slice sl-x`]);
		expect(q!.body).toContain("3 failed rounds of 3 allowed (normal stakes)");
		expect(q!.body).toContain("Blocking per round: round 1: 1 · round 2: 1 · round 3: 1");
		expect(q!.body).toContain("- blocking correctness: the grant races");
		expect(q!.body).toContain("- major design: two sources of truth");
		expect(w.ledger.slice("sl-x")?.state).toBe("paused");
		for (const call of ["rev-4", "rev-5"]) {
			const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, call);
			expect(again?.block).toBe(true);
			expect(again?.reason).toContain(`question ${q!.id} (review-limit:; options extend / accept / stop) is open`);
		}
		expect(questions(w)).toHaveLength(1);

		// Withdrawn without an answer: the loop is still at its limit, and no second question is raised.
		w.ledger.withdrawQuestion(q!.id, { by: SURFACE_BY, reason: "later", author: JO_HOLDER, channel: "surface", then: "replan" });
		const held = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-6");
		expect(held?.reason).toContain("is at its round limit (3 failed rounds of 3 allowed)");
		expect(questions(w)).toHaveLength(1);
	});

	test("the limit survives a restart: rounds are counted from the ledger", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await reviewRound(h, w, "rev-1", blocking("a"));
		await reviewRound(h, w, "rev-2", blocking("b"));
		const restarted = lane(w);
		await reviewRound(restarted, w, "rev-3", blocking("c"));
		expect(questions(w)).toHaveLength(1);
		const third = lane(w);
		expect((await third.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-4"))?.block).toBe(true);
		expect(questions(w)).toHaveLength(1);
	});

	test("a passing round ends the loop with no question, and the next review starts a fresh loop with the full allowance", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await reviewRound(h, w, "rev-1", blocking("a"));
		await reviewRound(h, w, "rev-2", blocking("b"));
		await reviewRound(h, w, "rev-3", CLEAN);
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason pass"]);
		expect(questions(w)).toHaveLength(0);
		await reviewRound(h, w, "rev-4", blocking("c"));
		await reviewRound(h, w, "rev-5", blocking("d"));
		expect(questions(w)).toHaveLength(0);
		expect(rounds(w).map(r => r.round)).toEqual([1, 2, 3, 1, 2]);
		await reviewRound(h, w, "rev-6", blocking("e"));
		expect(questions(w)).toHaveLength(1);
		expect(questions(w)[0]!.body).toContain("Blocking per round: round 1: 1 · round 2: 1 · round 3: 1");
	});

	test("a hand with a clean zero-blocking block whose output was withheld fails the round: out of row, or it changed the work", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const off = await reviewRound(h, w, "rev-1", CLEAN, { model: OPUS }); // the builder's lab, outside the review row
		expect(off?.isError).toBe(true);
		expect(rounds(w)).toMatchObject([{ verdict: "withheld", findings: { titles: [] } }]);
		expect(bodies(w, "review-loop-end:")).toEqual([]);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ failed: 1, passed: false });

		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-2");
		await h.spawn(out!.input.agent, "sl-x");
		writeFileSync(join(w.repo, "a.txt"), "changed by the review\n");
		h.handMessage("sl-x-1", SOL);
		expect(h.results("rev-2", [{ id: "sl-x-1", agent: out!.input.agent, model: SOL, output: CLEAN }])?.isError).toBe(true);
		expect(bodies(w, "review-withheld:")).toHaveLength(1); // withheld for changing the work, not for its routing row
		expect(rounds(w).map(r => r.verdict)).toEqual(["withheld", "withheld"]);
		expect(bodies(w, "review-loop-end:")).toEqual([]);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ failed: 2, passed: false });
	});

	test("a production fan-out's two legs are one round; one accepted clean leg and one withheld leg fail it; the limit question waits for the last leg", async () => {
		const w = world({ stakes: "production" });
		roundsLimit(w, 1);
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		h.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		await h.spawn("deep", "sl-x--openai");
		await h.spawn("deep", "sl-x--kimi");
		h.handMessage("sl-x--openai", ASTRA);
		expect(h.deliver(["sl-x--openai"], CLEAN)).toBe(CLEAN);
		expect(questions(w)).toHaveLength(0); // the kimi leg is still running
		h.handMessage("sl-x--kimi", FABLE); // off its pinned row: withheld
		expect(h.deliver(["sl-x--kimi"], CLEAN)).not.toBe(CLEAN);
		const all = rounds(w);
		expect(all.map(r => [r.round, r.verdict])).toEqual([
			[1, "accepted"],
			[1, "withheld"],
		]);
		expect(all[0]!.group).toBe(all[1]!.group);
		expect(questions(w)).toHaveLength(1); // the limit question; the accepted leg means no park
		expect(bodies(w, "review-limit:")).toHaveLength(1);
		expect(questions(w)[0]!.body).toContain("1 failed round of 1 allowed (production stakes)");
		expect(questions(w)[0]!.body).toContain(`Output not accepted: ${all[1]!.token} (withheld)`);
		expect(bodies(w, "review-loop-end:")).toEqual([]);
	});
});

describe("Stop (D10), wired", () => {
	test("after review-stop: on the workload, a new review dispatch on any slice is refused naming the instruction", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const stop = stopReviews(w, w.wl);
		for (const slice of ["sl-x", "sl-y"]) {
			const out = await h.toolCall({ agent: "strong", name: slice, task: brief(w, "review the change") }, `c-${slice}`);
			expect(out?.block).toBe(true);
			expect(out?.reason).toContain(`reviews of ${slice} are stopped by Jo's stop-reviews (instruction ${stop}, review-stop:)`);
		}
		expect((await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "build it") }, "c-work"))?.block).toBeUndefined(); // not a review
	});

	test("a stop on sl-x only: sl-x is refused, sl-y still reviews", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const stop = stopReviews(w, "sl-x");
		expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c1"))?.reason).toContain(`instruction ${stop}`);
		expect(await reviewRound(h, w, "c2", CLEAN, { slice: "sl-y" })).toBeUndefined();
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-y reason pass"]);
	});

	test("a review already running settles normally, ends the loop, and its findings reach the orchestrator once", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await reviewSpawn(h, w);
		const stop = stopReviews(w, "sl-x");
		h.handMessage("sl-x", SOL);
		const output = blocking("the grant races");
		expect(h.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL, output }])).toBeUndefined(); // settles as usual
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason stop-reviews"]);
		expect(messages(w)).toHaveLength(1);
		expect(messages(w)[0]!.recipient).toBe("orchestrator");
		expect(messages(w)[0]!.body).toContain(`Review round 1 of sl-x settled after stop-reviews (${stop})`);
		expect(messages(w)[0]!.body).toContain("Remaining findings: blocking 1 (correctness 1) · major 0 · minor 0; blocking 1.");
		expect(messages(w)[0]!.body).toContain("- blocking correctness: the grant races");
		lane(w).results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL, output }]); // a replay after a restart
		expect(messages(w)).toHaveLength(1);
		expect(questions(w)).toHaveLength(0);
		expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-2"))?.reason).toContain(`instruction ${stop}`); // still stopped
	});

	test("a stop recorded between classification and spawn refuses the spawn, and no round is counted", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		expect(out?.block).toBeUndefined();
		const stop = stopReviews(w, w.wl);
		const spawn = await h.spawn(out!.input.agent, "sl-x");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain(`instruction ${stop}`);
		expect(bodies(w, "hand-spawn:")).toEqual([]);
		expect(bodies(w, "review-round:")).toEqual([]);
		expect(questions(w)).toHaveLength(0);
	});

	test("a production member classified before the stop and not yet spawned is refused; the round counts only the member that spawned", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		h.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([ASTRA]);
		const stop = stopReviews(w, "sl-x");
		const late = await h.spawn("deep", "sl-x--kimi");
		expect(late?.reason).toContain(`instruction ${stop}`);
		expect(messages(w)).toHaveLength(0); // the openai leg is still running
		h.handMessage("sl-x--openai", ASTRA);
		h.deliver(["sl-x--openai"], CLEAN);
		// The refused member is terminal on the ledger (`stopped`, so the durable group can complete) and not counted.
		expect(rounds(w).map(r => r.verdict)).toEqual(["stopped", "accepted"]);
		expect(messages(w)).toHaveLength(1);
		expect(messages(w)[0]!.body).toContain("The round passed.");
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason stop-reviews"]);
		expect(questions(w)).toHaveLength(0);
	});

	test("a production round stopped with two staggered legs, restarted in between, gets one aggregate message", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		h.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		await h.spawn("deep", "sl-x--openai");
		await h.spawn("deep", "sl-x--kimi");
		const stop = stopReviews(w, w.wl);
		h.handMessage("sl-x--openai", ASTRA);
		h.deliver(["sl-x--openai"], blocking("openai finding"));
		expect(messages(w)).toHaveLength(0); // the kimi leg is still running

		const restarted = lane(w); // the kimi hand died with the process
		restarted.deliver(["sl-x--kimi"], "LOST");
		expect(messages(w)).toHaveLength(1);
		const body = messages(w)[0]!.body;
		expect(body).toContain(`Review round 1 of sl-x settled after stop-reviews (${stop})`);
		expect(body).toContain("Remaining findings: blocking 1 (correctness 1) · major 0 · minor 0 · unknown: 1 hand");
		expect(body).toContain("- blocking correctness: openai finding");
		lane(w).deliver(["sl-x--kimi"], "LOST");
		expect(messages(w)).toHaveLength(1);
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason stop-reviews"]);
		expect(questions(w)).toHaveLength(0);
	});
});

describe("REVIEW-r1 regressions", () => {
	test("#1: a review round still running refuses a second round of the slice, in this process and after a restart, until it resolves", async () => {
		const w = world();
		roundsLimit(w, 1);
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		h.asyncReturned("rev-1", [{ index: 0, id: "sl-x", status: "running" }]);
		expect((await h.spawn("strong", "sl-x"))?.model).toEqual([SOL, KIMI]);
		for (const [who, l] of [["this process", h], ["a restart", lane(w)]] as const) {
			const again = await l.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, `rev-2-${who}`);
			expect({ who, block: again?.block }).toEqual({ who, block: true });
			expect(again?.reason).toContain("review round 1 of sl-x is still running");
		}
		expect(bodies(w, "hand-spawn:")).toHaveLength(1);
		h.handMessage("sl-x", SOL);
		h.deliver(["sl-x"], blocking("first"));
		expect(questions(w)).toHaveLength(1); // the one round reached the limit of 1
		const after = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-3");
		expect(after?.reason).toContain(`question ${questions(w)[0]!.id} (review-limit:; options extend / accept / stop) is open`);
	});

	test("#2: a stop or an open limit question recorded while the spawn awaits credentials refuses it, with no hand-spawn: entry", async () => {
		for (const what of ["stop-reviews", "limit question"] as const) {
			const w = world();
			const held = Promise.withResolvers<void>();
			let gate: Promise<void> | null = null; // open until the spawn: tool_call's own lookups pass
			const registry = { ...w.registry, getApiKey: async (m: { provider: string; id: string }, s?: string) => (await gate, w.registry.getApiKey(m, s)) };
			const h = lane({ ...w, registry });
			h.laneMessage(OPUS);
			const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
			expect(out?.block).toBeUndefined();
			gate = held.promise;
			const spawn = h.spawn(out!.input.agent, "sl-x");
			let expected: string;
			if (what === "stop-reviews") {
				expected = `instruction ${stopReviews(w, "sl-x")}`;
			} else {
				const q = w.ledger.raiseQuestion({ by: "lane-test", workloadId: w.wl, sliceId: "sl-x", body: "limit", options: ["extend", "accept", "stop"] });
				w.ledger.recordEntry({ by: "lane-test", workloadId: w.wl, sliceId: "sl-x", kind: "assumption", body: `review-limit: ${q} slice sl-x` });
				expected = `question ${q} (review-limit:; options extend / accept / stop) is open`;
			}
			held.resolve();
			const reply = await spawn;
			expect({ what, block: reply?.block }).toEqual({ what, block: true });
			expect(reply?.reason).toContain(expected);
			expect({ what, spawns: bodies(w, "hand-spawn:") }).toEqual({ what, spawns: [] });
			expect(bodies(w, "review-round:")).toEqual([]);
		}
	});

	test("#3: a production member still queued at a restart keeps the round open; replaying the settled member fails the round with it dropped", async () => {
		for (const stopped of [false, true]) {
			const w = world({ stakes: "production" });
			const h = lane(w);
			h.laneMessage(OPUS);
			await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
			h.asyncReturned("c1", [
				{ index: 0, id: "sl-x--openai", status: "running" },
				{ index: 1, id: "sl-x--kimi", status: "running" },
			]);
			await h.spawn("deep", "sl-x--openai"); // the kimi member stays queued
			h.handMessage("sl-x--openai", ASTRA);
			expect(h.deliver(["sl-x--openai"], CLEAN)).toBe(CLEAN);
			expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds).toMatchObject([{ complete: false }]);
			const stop = stopped ? stopReviews(w, "sl-x") : null;

			const restarted = lane(w); // the queued kimi member died with the process
			restarted.deliver(["sl-x--openai"], CLEAN); // the settled member's delivery replays
			expect(rounds(w).map(r => r.verdict)).toEqual(["accepted", "dropped"]);
			const kimi = rounds(w)[1]!.token;
			expect(bodies(w, "review-group:")).toEqual([`review-group: sl-x group ${rounds(w)[0]!.group} members ${rounds(w)[0]!.token},${kimi}`]);
			if (stopped) {
				expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason stop-reviews"]);
				expect(messages(w)).toHaveLength(1);
				expect(messages(w)[0]!.body).toContain(`settled after stop-reviews (${stop})`);
				expect(messages(w)[0]!.body).toContain("The round did not pass.");
				expect(messages(w)[0]!.body).toContain(`Output not accepted: ${kimi} (dropped)`);
			} else {
				expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [{ complete: true, passed: false }], failed: 1, passed: false });
				expect(bodies(w, "review-loop-end:")).toEqual([]); // not a pass
			}
		}
	});
});

describe("REVIEW-r2 regressions", () => {
	test("residual #1: a second review of the slice dispatched while the first spawn awaits credentials: at most one round spawns, the other is refused with no hand-spawn:", async () => {
		for (const where of ["this process", "another instance"] as const) {
			const w = world();
			const held = Promise.withResolvers<void>();
			let gate: Promise<void> | null = null; // open until the first spawn's credential lookup
			const registry = { ...w.registry, getApiKey: async (m: { provider: string; id: string }, s?: string) => (await gate, w.registry.getApiKey(m, s)) };
			const a = lane({ ...w, registry });
			a.laneMessage(OPUS);
			const out = await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
			expect(out?.block).toBeUndefined();
			gate = held.promise;
			const first = a.spawn(out!.input.agent, "sl-x");
			const other = where === "this process" ? a : lane(w);
			const again = await other.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-2");
			// Whichever dispatch got through, its spawn races the first one.
			const second = again?.block ? null : other.spawn(again!.input.agent, "sl-x");
			if (where === "another instance") await second; // B's credentials are not held: it records first
			held.resolve();
			const replies = [await first, await second].filter(r => r !== null);
			expect({ where, spawned: replies.filter(r => r?.model !== undefined).length }).toEqual({ where, spawned: 1 });
			expect({ where, spawns: bodies(w, "hand-spawn:").length }).toEqual({ where, spawns: 1 });
			// In this process the second dispatch is refused (the first spawn still holds the slice); from
			// another instance it gets through, records first, and the first spawn is refused at its record.
			const refusal = where === "this process" ? again : await first;
			expect({ where, block: refusal?.block }).toEqual({ where, block: true });
			expect(refusal?.reason).toContain(where === "this process" ? "slice sl-x already has a classified dispatch waiting to spawn (call rev-1)" : "review round 1 of sl-x is still running");
			expect({ where, questions: questions(w) }).toEqual({ where, questions: [] }); // the hold never parks
			expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds).toHaveLength(1);
		}
	});

	test("residual #1, durable half: another instance's round recorded just before the spawn's own write transaction refuses the spawn, with no hand-spawn: of its own", async () => {
		const w = world();
		let inject: (() => void) | null = null;
		// The spawn's first ledger write runs the competing record first: what another instance could
		// write after this spawn's last read and before its transaction.
		const ledger = new Proxy(w.ledger, {
			get: (target, key) => {
				if (key === "write") {
					return <T>(fn: () => T): T => {
						const run = inject;
						inject = null;
						run?.();
						return target.write(fn);
					};
				}
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const a = lane({ ...w, ledger });
		a.laneMessage(OPUS);
		const out = await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		expect(out?.block).toBeUndefined();
		const other = handSpawnBody({ token: "dt-other", root: w.root, spawnKey: "sl-x", review: true, group: "dg-other", row: [KIMI] });
		inject = () => w.ledger.recordEntry({ by: "lane-other", workloadId: w.wl, sliceId: "sl-x", kind: "assumption", body: other });
		const reply = await a.spawn(out!.input.agent, "sl-x");
		expect(reply?.block).toBe(true);
		expect(reply?.reason).toContain("review round 1 of sl-x is still running (dt-other not settled)");
		expect(bodies(w, "hand-spawn:")).toEqual([other]);
		expect(questions(w)).toEqual([]);
	});

	test("new: a queued fan-out member another instance recorded dropped is refused at its late spawn with no hand-spawn:; the next round counts as round 2", async () => {
		const w = world({ stakes: "production" });
		const a = lane(w);
		a.laneMessage(OPUS);
		await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		a.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		await a.spawn("deep", "sl-x--openai"); // the kimi member stays queued in A
		a.handMessage("sl-x--openai", ASTRA);
		expect(a.deliver(["sl-x--openai"], CLEAN)).toBe(CLEAN);

		// Instance B (A still alive) redispatches; its sweep records A's queued kimi member dropped.
		const b = lane(w);
		const out = await b.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c2");
		expect(out?.block).toBeUndefined();
		expect(rounds(w).map(r => [r.round, r.verdict])).toEqual([
			[1, "accepted"],
			[1, "dropped"],
		]);
		const kimi = rounds(w)[1]!.token;

		// A's late spawn of the kimi member is refused; nothing is written for it.
		const late = await a.spawn("deep", "sl-x--kimi");
		expect(late?.block).toBe(true);
		expect(late?.reason).toContain(kimi);
		expect(bodies(w, "hand-spawn:").filter(b => b.startsWith(`hand-spawn: ${kimi} `))).toEqual([]);
		expect(rounds(w).map(r => [r.round, r.verdict])).toEqual([
			[1, "accepted"],
			[1, "dropped"],
		]);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [{ n: 1, complete: true, passed: false }], failed: 1 });

		// B's round runs and is counted as round 2 of the loop.
		b.asyncReturned("c2", [
			{ index: 0, id: "sl-x--openai-1", status: "running" },
			{ index: 1, id: "sl-x--kimi-1", status: "running" },
		]);
		expect((await b.spawn("deep", "sl-x--openai-1"))?.model).toEqual([ASTRA]);
		expect((await b.spawn("deep", "sl-x--kimi-1"))?.model).toEqual([K3]);
		b.handMessage("sl-x--openai-1", ASTRA);
		b.handMessage("sl-x--kimi-1", K3);
		expect(b.deliver(["sl-x--openai-1"], CLEAN)).toBe(CLEAN);
		expect(b.deliver(["sl-x--kimi-1"], CLEAN)).toBe(CLEAN);
		expect(rounds(w).map(r => [r.round, r.verdict])).toEqual([
			[1, "accepted"],
			[1, "dropped"],
			[2, "accepted"],
			[2, "accepted"],
		]);
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason pass"]);
		expect(questions(w)).toHaveLength(0);
	});
});

describe("REVIEW-r3 regressions", () => {
	test("blocking: a fan-out published before another instance's round passed is refused at its late spawn with no hand-spawn:, its members stopped; the redispatch counts as round 1 of the new loop", async () => {
		const w = world({ stakes: "production" });
		// Instance A publishes group A; neither member has spawned yet.
		const a = lane(w);
		a.laneMessage(OPUS);
		expect((await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1"))?.block).toBeUndefined();
		a.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		const groupA = bodies(w, "review-group:")[0]!;
		const tokensA = groupA.split(" members ")[1]!.split(",");

		// Instance B publishes group B, spawns it, and it passes: the loop ends.
		const b = lane(w);
		expect((await b.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c2"))?.block).toBeUndefined();
		b.asyncReturned("c2", [
			{ index: 0, id: "sl-x--openai-1", status: "running" },
			{ index: 1, id: "sl-x--kimi-1", status: "running" },
		]);
		expect((await b.spawn("deep", "sl-x--openai-1"))?.model).toEqual([ASTRA]);
		expect((await b.spawn("deep", "sl-x--kimi-1"))?.model).toEqual([K3]);
		b.handMessage("sl-x--openai-1", ASTRA);
		b.handMessage("sl-x--kimi-1", K3);
		expect(b.deliver(["sl-x--openai-1"], CLEAN)).toBe(CLEAN);
		expect(b.deliver(["sl-x--kimi-1"], CLEAN)).toBe(CLEAN);
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason pass"]);

		// A's late spawns land in the ended loop: refused, nothing spawned, each member stopped.
		for (const id of ["sl-x--openai", "sl-x--kimi"]) {
			const late = await a.spawn("deep", id);
			expect({ id, block: late?.block }).toEqual({ id, block: true });
			expect(late?.reason).toContain("review loop of sl-x it was dispatched in has ended");
		}
		expect(bodies(w, "hand-spawn:").filter(s => tokensA.some(t => s.startsWith(`hand-spawn: ${t} `)))).toEqual([]);
		expect(rounds(w).filter(r => tokensA.includes(r.token)).map(r => r.verdict)).toEqual(["stopped", "stopped"]);
		expect(questions(w)).toEqual([]); // a refused old group never parks
		expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [], failed: 0, next: 1 });

		// A's redispatch is round 1 of the new loop, and its blocking finding counts.
		expect((await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c3"))?.block).toBeUndefined();
		a.asyncReturned("c3", [
			{ index: 0, id: "sl-x--openai-2", status: "running" },
			{ index: 1, id: "sl-x--kimi-2", status: "running" },
		]);
		expect((await a.spawn("deep", "sl-x--openai-2"))?.model).toEqual([ASTRA]);
		expect((await a.spawn("deep", "sl-x--kimi-2"))?.model).toEqual([K3]);
		a.handMessage("sl-x--openai-2", ASTRA);
		a.handMessage("sl-x--kimi-2", K3);
		a.deliver(["sl-x--openai-2"], blocking("still wrong"));
		a.deliver(["sl-x--kimi-2"], CLEAN);
		const count = countRounds(w.ledger.entries(w.wl), "sl-x");
		expect(count).toMatchObject({ rounds: [{ n: 1, complete: true, passed: false, blocking: 1 }], failed: 1 });
		expect(count.rounds[0]!.members.map(m => m.token).some(t => tokensA.includes(t))).toBe(false);
		expect(rounds(w).filter(r => !tokensA.includes(r.token)).map(r => [r.round, r.verdict])).toEqual([
			[1, "accepted"],
			[1, "accepted"],
			[1, "accepted"],
			[1, "accepted"],
		]);
	});

	test("blocking, one hand: a review classified before another instance's round passed is refused at its late spawn with no hand-spawn:; the redispatch counts as round 1 of the new loop", async () => {
		const w = world();
		const a = lane(w);
		a.laneMessage(OPUS);
		const queued = await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		expect(queued?.block).toBeUndefined();

		const b = lane(w);
		await reviewRound(b, w, "rev-2", CLEAN);
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason pass"]);
		const spawns = bodies(w, "hand-spawn:");

		const late = await a.spawn(queued!.input.agent, "sl-x");
		expect(late?.block).toBe(true);
		expect(late?.reason).toContain("review loop of sl-x it was dispatched in has ended");
		expect(bodies(w, "hand-spawn:")).toEqual(spawns);

		await reviewRound(a, w, "rev-3", blocking("still wrong"));
		expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [{ n: 1, complete: true, passed: false }], failed: 1 });
		expect(rounds(w).map(r => [r.round, r.verdict])).toEqual([
			[1, "accepted"],
			[1, "accepted"],
		]);
		expect(questions(w)).toEqual([]);
	});

	test("blocking, durable half: a loop end another instance records just before the spawn's own write transaction refuses the spawn, with no hand-spawn:", async () => {
		const w = world();
		let inject: (() => void) | null = null;
		// The spawn's first ledger write runs the competing record first: after this spawn's last read.
		const ledger = new Proxy(w.ledger, {
			get: (target, key) => {
				if (key === "write") {
					return <T>(fn: () => T): T => {
						const run = inject;
						inject = null;
						run?.();
						return target.write(fn);
					};
				}
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const a = lane({ ...w, ledger });
		a.laneMessage(OPUS);
		const out = await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		expect(out?.block).toBeUndefined();
		inject = () => w.ledger.recordEntry({ by: "lane-other", workloadId: w.wl, sliceId: "sl-x", kind: "assumption", body: "review-loop-end: sl-x reason pass" });
		const reply = await a.spawn(out!.input.agent, "sl-x");
		expect(reply?.block).toBe(true);
		expect(reply?.reason).toContain("review loop of sl-x it was dispatched in has ended");
		expect(bodies(w, "hand-spawn:")).toEqual([]);
	});
});

describe("REVIEW-r4 regressions", () => {
	test("blocking: a stale fan-out with a member already refused for credentials closes out at its late spawn with no park question; the redispatch is round 1 of the new loop", async () => {
		const w = world({ stakes: "production" });
		// Instance A publishes group A; its openai member is refused for missing credentials, kimi stays pending.
		const a = lane(w);
		a.laneMessage(OPUS);
		expect((await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1"))?.block).toBeUndefined();
		a.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		const tokensA = bodies(w, "review-group:")[0]!.split(" members ")[1]!.split(",");
		down(w, ASTRA);
		expect((await a.spawn("deep", "sl-x--openai"))?.block).toBe(true);
		expect(questions(w)).toEqual([]); // the kimi member is still pending
		up(w, ASTRA);

		// Instance B runs a complete group and it passes: the loop ends.
		const b = lane(w);
		expect((await b.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c2"))?.block).toBeUndefined();
		b.asyncReturned("c2", [
			{ index: 0, id: "sl-x--openai-1", status: "running" },
			{ index: 1, id: "sl-x--kimi-1", status: "running" },
		]);
		expect((await b.spawn("deep", "sl-x--openai-1"))?.model).toEqual([ASTRA]);
		expect((await b.spawn("deep", "sl-x--kimi-1"))?.model).toEqual([K3]);
		b.handMessage("sl-x--openai-1", ASTRA);
		b.handMessage("sl-x--kimi-1", K3);
		expect(b.deliver(["sl-x--openai-1"], CLEAN)).toBe(CLEAN);
		expect(b.deliver(["sl-x--kimi-1"], CLEAN)).toBe(CLEAN);
		expect(bodies(w, "review-loop-end:")).toEqual(["review-loop-end: sl-x reason pass"]);
		const before = questions(w);

		// A's late kimi spawn lands in the ended loop: refused, nothing spawned, and no park question.
		const late = await a.spawn("deep", "sl-x--kimi");
		expect(late?.block).toBe(true);
		expect(late?.reason).toContain("review loop of sl-x it was dispatched in has ended");
		expect(bodies(w, "hand-spawn:").filter(s => tokensA.some(t => s.startsWith(`hand-spawn: ${t} `)))).toEqual([]);
		expect(questions(w)).toEqual(before);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(w.ledger.slice("sl-x")?.state).not.toBe("paused");
		expect(rounds(w).filter(r => tokensA.includes(r.token)).map(r => r.verdict)).toEqual(["refused", "stopped"]);

		// A fresh dispatch is admitted and counts as round 1 of the new loop.
		expect((await a.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c3"))?.block).toBeUndefined();
		a.asyncReturned("c3", [
			{ index: 0, id: "sl-x--openai-2", status: "running" },
			{ index: 1, id: "sl-x--kimi-2", status: "running" },
		]);
		expect((await a.spawn("deep", "sl-x--openai-2"))?.model).toEqual([ASTRA]);
		expect((await a.spawn("deep", "sl-x--kimi-2"))?.model).toEqual([K3]);
		a.handMessage("sl-x--openai-2", ASTRA);
		a.handMessage("sl-x--kimi-2", K3);
		a.deliver(["sl-x--openai-2"], blocking("still wrong"));
		a.deliver(["sl-x--kimi-2"], CLEAN);
		const count = countRounds(w.ledger.entries(w.wl), "sl-x");
		expect(count).toMatchObject({ rounds: [{ n: 1, complete: true, passed: false, blocking: 1 }], failed: 1 });
		expect(count.rounds[0]!.members.map(m => m.token).some(t => tokensA.includes(t))).toBe(false);
	});
});
