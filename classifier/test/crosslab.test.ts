/**
 * Cross-lab review end to end (PLAN wl-mupu0sx2o046io D1–D6, MIGRATION.md follow-up 23) and the
 * review round limit and stop wiring (D9/D10, follow-up 33): the classifier extension on a fake OMP
 * host with a real temp ledger, a real git repository as the lane's working directory, and a lane
 * session file on disk (so a hand's session is told from the lane's own). Covers the plan's Routing,
 * Read-only reviews, Production fan-out, Park, Review-4 notes, Round limit (D9) wired and Stop
 * (D10) wired test lists.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBriefFields } from "../../gates/src/rows/r05-brief-fields";
import { LANE_RUNNER_BY, Ledger, type Stakes } from "../../ledger/src/index";
import { createClassifierExtension, REVIEW_FINDINGS_PARAGRAPH } from "../extension";
import { loadCalibration } from "../src/classify";
import { reviewStopBody, stopReviewsInstructionBody } from "../src/review-stop";
import { handSpawnBody } from "../src/lab";
import { countRounds, parseReviewRound, reviewRoundsBody, reviewRoundsExtendBody, roundsInstructionBody } from "../src/rounds";
import { tierTableFromConfig, type TierTable } from "../src/tier-table";
import { JO_HOLDER } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { asyncDelivery, currentModel, DEFAULT_LANE_MODEL, dist, fakeRegistry, recordedQuestion } from "./helpers";

const ROWS = {
	fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
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

/**
 * Jo's Kimi-out rule (in-mv5xafhywe3w8w) ends at 2026-11-01T00:00:00-07:00. A lane's clock defaults to that instant, so every
 * test outside "Jo's Kimi-out rule" checks the behaviour without the rule, whatever the wall clock says.
 */
const RULE_END = Date.parse("2026-11-01T00:00:00-07:00");
const IN_WINDOW = Date.parse("2026-10-20T12:00:00-07:00");

/** A hand's assistant turn that ended on a provider error: its HTTP status and message. */
type ErrorTurn = { status: number; message: string };

/**
 * One lane process: the classifier bound to the lane's session and to its hands' sessions. A second `lane(w)` is a restart.
 * `laneModel`: the lane's current model (`ctx.model`), `provider/id`: `DEFAULT_LANE_MODEL` (an Anthropic one) when the key
 * is absent; an explicit undefined is a lane OMP reports no model for. Its build hands run on its lab, and a dispatch it
 * issues records its lab first (PLAN wl-mv5i3lulwwbbi8 D7).
 */
function lane(w: World, opts: { fingerprint?: (cwd: string) => string; now?: () => number; laneModel?: string; disabledProviders?: string[] } = {}) {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const logs: string[] = [];
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => w.table,
		disabledProviders: async () => opts.disabledProviders ?? [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => w.ledger,
		laneId: "lane-test",
		boundWorkload: () => w.wl,
		// No lost-hand settle here: every recorded omp is alive (snapshot-settle.test.ts T10 drives the rule).
		ompState: () => "same",
		lastWrite: () => null,
		log: line => logs.push(line),
		now: opts.now ?? (() => RULE_END),
		...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.repo, modelRegistry: w.registry, model: currentModel("laneModel" in opts ? opts.laneModel : DEFAULT_LANE_MODEL), sessionManager: { getSessionFile: () => w.laneFile } };
	const handCtx = (agentId: string) => ({ ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } });
	const assistant = (selector: string, error?: ErrorTurn) => {
		const [provider, ...model] = selector.split("/");
		const failed = error ? { stopReason: "error", errorStatus: error.status, errorMessage: error.message } : {};
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [], ...failed } };
	};
	const text = (msg: unknown) => (typeof msg === "object" && msg !== null && "content" in msg ? String(msg.content) : "");
	return {
		logs,
		/** The lane switches to `selector` (OMP's model switch): its later build hands run on that lab. */
		setLaneModel: (selector: string) => void (ctx.model = currentModel(selector)),
		toolCall: (input: unknown, toolCallId = "call-1") => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
		spawn: (agent: string, spawnKey: string) =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<Reply>,
		/** An assistant turn of the lane itself: it answers on `selector`, so that is its current model (`ctx.model`) from now on. */
		laneMessage: (selector: string) => {
			ctx.model = currentModel(selector);
			return handlers.message_end!(assistant(selector), ctx);
		},
		/** An assistant turn in hand `agentId`'s own session; `error`: the turn ended on that provider error. */
		handMessage: (agentId: string, selector: string, error?: ErrorTurn) => handSession.message_end!(assistant(selector, error), handCtx(agentId)),
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

	test("a model switch to openai makes builders {anthropic, openai}: the change hand runs on the lane's new lab, and the review goes to kimi only", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		h.setLaneModel(SOL);
		const change = await settled(h, w, "sl-work", "change the loader", SOL, "c1");
		expect(change.spawn?.model).toEqual([SOL]); // a build hand runs on the lane's lab only
		expect(change.result).toBeUndefined();
		expect((await reviewSpawn(h, w))?.model).toEqual([KIMI]);
	});

	test("a change hand that answered on another lab than the lane's is refused out of row, and that lab still counts as a builder", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const change = await settled(h, w, "sl-work", "change the loader", SOL, "c1");
		expect(change.spawn?.model).toEqual([OPUS]);
		expect(change.result?.isError).toBe(true);
		expect(change.result?.content?.[0]?.text).toContain(`sl-work ran on ${SOL}, outside the strong row (${OPUS})`);
		expect(w.ledger.routings(w.wl)).toMatchObject([{ outcome: "refused-out-of-row", ran_models: JSON.stringify([SOL]) }]);
		expect((await reviewSpawn(h, w))?.model).toEqual([KIMI]);
	});

	test("a hand-spawn token with no hand-settled entry counts its whole row (a change lost before settle)", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it") }, "c1"); // issued on opus: D7 records anthropic
		h.setLaneModel(SOL); // switched after the dispatch, before its hand spawned: the lane never issued or answered anything on openai
		expect((await h.spawn(out!.input.agent, "sl-work"))?.model).toEqual([SOL]);
		const restarted = lane(w); // the process died with the change hand in flight
		expect((await reviewSpawn(restarted, w))?.model).toEqual([KIMI]);
		expect(bodies(w, "builder-lab: openai")).toEqual([]); // openai counts by the token's row alone
	});

	test("T1: one slice dispatched twice, the first settled and the second lost before settle: the second still counts", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await settled(h, w, "sl-work", "change it", OPUS, "c1");
		const again = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it again") }, "c2"); // issued on opus
		h.setLaneModel(SOL); // switched after the second dispatch, before its hand spawned
		expect((await h.spawn(again!.input.agent, "sl-work"))?.model).toEqual([SOL]); // the same spawn key as the settled first
		const spawns = bodies(w, "hand-spawn:");
		expect(spawns).toHaveLength(2);
		expect(new Set(spawns.map(b => b.split(" ")[1])).size).toBe(2); // one token per dispatch
		const restarted = lane(w);
		expect((await reviewSpawn(restarted, w))?.model).toEqual([KIMI]); // the lost second dispatch's row counts openai
		expect(bodies(w, "builder-lab: openai")).toEqual([]); // by its token alone: the lane never issued or answered on openai
	});

	test("a settled refused-model-unknown change row counts its whole row", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change it") }, "c1"); // issued on opus
		h.setLaneModel(SOL); // switched after the dispatch, before its hand spawned
		expect((await h.spawn(out!.input.agent, "sl-work"))?.model).toEqual([SOL]);
		expect(h.results("c1", [{ id: "sl-work", agent: "strong", model: SOL }])?.isError).toBe(true); // no turn seen
		expect(w.ledger.routings(w.wl)).toMatchObject([{ outcome: "refused-model-unknown", ran_models: null }]);
		h.setLaneModel(OPUS); // back on opus: the review's own dispatch records anthropic only
		expect((await reviewSpawn(h, w))?.model).toEqual([KIMI]);
		expect(bodies(w, "builder-lab: openai")).toEqual([]); // openai counts by the refused row alone
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

	test("a lane with lane-started: and no builder-lab: parks the review", async () => {
		const w = world();
		const h = lane(w, { laneModel: undefined }); // OMP reports no current model and the lane never answered: D7 records nothing
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.block).toBe(true);
		expect(questions(w)).toHaveLength(1);
		expect(questions(w)[0]!.body).toContain("lane lane-test has a lane-started: entry and no builder-lab: entry");
	});

	test("PLAN wl-mv5i3lulwwbbi8 D7: a review dispatched before any message_end records the issuing model's lab first, and routes off it with no park", async () => {
		const w = world();
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: "lane-ready: lane-test at t" });
		const h = lane(w, { laneModel: OPUS }); // the lane's first turn: no message_end yet
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.block).toBeUndefined();
		expect(spawn?.model).toEqual([SOL, KIMI]);
		expect(bodies(w, "builder-lab:")).toEqual([`builder-lab: anthropic lane lane-test model ${OPUS}`]);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(questions(w)).toEqual([]);
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
		expect((await h.spawn("standard", "sl-y"))?.model).toEqual([ROWS.standard[0]!]); // a build hand: the lane's lab only
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
	test("brief normal on a production workload: effective production, tier deep, one pinned hand per other lab, two rows on the slice; row 5 passes the expanded call; the openai member runs on the strong row's gpt-6-sol (Jo, in-mv5qfm8910ycjk)", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		const input = { agent: "strong", name: "sl-x", task: brief(w, "review the change") };
		const out = await h.toolCall(input, "c1");
		expect(out?.input.tasks.map((t: { name: string; agent: string }) => `${t.name}@${t.agent}`)).toEqual(["sl-x--openai@deep", "sl-x--kimi@deep"]);
		expect(checkBriefFields(out!.input, w.wl)).toBeNull();
		const openai = await h.spawn("deep", "sl-x--openai");
		expect(openai?.model).toEqual([SOL]);
		expect(openai?.note).toContain("openai reviewer from the strong row (Jo, in-mv5qfm8910ycjk)");
		const kimi = await h.spawn("deep", "sl-x--kimi");
		expect(kimi?.model).toEqual([K3]);
		expect(kimi?.note).not.toContain("openai reviewer");
		expect(bodies(w, "hand-spawn:").map(b => / row (\S+)$/.exec(b)![1])).toEqual([SOL, K3]);
		h.handMessage("sl-x--openai", SOL);
		h.handMessage("sl-x--kimi", K3);
		expect(
			h.results("c1", [
				{ id: "sl-x--openai", agent: "deep", model: SOL },
				{ id: "sl-x--kimi", agent: "deep", model: K3 },
			]),
		).toBeUndefined();
		expect(w.ledger.routings(w.wl)).toMatchObject([
			{ slice_id: "sl-x", agent_id: "sl-x--openai", stakes: "production", tier: "deep", models: JSON.stringify([SOL]), ran_models: JSON.stringify([SOL]), outcome: "ran" },
			{ slice_id: "sl-x", agent_id: "sl-x--kimi", stakes: "production", tier: "deep", models: JSON.stringify([K3]), ran_models: JSON.stringify([K3]), outcome: "ran" },
		]);
		expect(JSON.stringify(w.ledger.routings(w.wl))).not.toContain(ASTRA);
		const groups = bodies(w, "hand-spawn:").map(b => / group (\S+) /.exec(b)![1]);
		expect(groups[0]).toBe(groups[1]!); // one round
	});

	test("a production review hand that answers on gpt-6-astra is refused out of row at settle (Jo, in-mv5qfm8910ycjk)", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c1");
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([SOL]);
		expect((await h.spawn("deep", "sl-x--kimi"))?.model).toEqual([K3]);
		h.handMessage("sl-x--openai", ASTRA);
		h.handMessage("sl-x--kimi", K3);
		const out = h.results("c1", [
			{ id: "sl-x--openai", agent: "deep", model: ASTRA },
			{ id: "sl-x--kimi", agent: "deep", model: K3 },
		]);
		expect(out?.isError).toBe(true);
		expect(out!.content!.map(c => c.text).join("\n")).toContain(`sl-x--openai ran on ${ASTRA}, outside the deep row (${SOL})`);
		expect(w.ledger.routings(w.wl).find(r => r.agent_id === "sl-x--openai")).toMatchObject({ outcome: "refused-out-of-row", models: JSON.stringify([SOL]) });
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
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([SOL]);
		expect(bodies(w, "hand-spawn:").map(b => / row (\S+)$/.exec(b)![1])).toEqual([K3, SOL]);
		h.handMessage("sl-x--openai", SOL);
		h.handMessage("sl-x--kimi-1", K3);
		expect(h.deliver(["sl-x--openai", "sl-x--kimi-1"], "FINDINGS")).toBe("FINDINGS");
		expect(w.ledger.routings(w.wl).map(r => r.agent_id)).toEqual(["sl-x--openai", "sl-x--kimi-1"]);
		expect(w.ledger.routings(w.wl).map(r => [r.models, r.ran_models, r.outcome])).toEqual([[JSON.stringify([SOL]), JSON.stringify([SOL]), "ran"], [JSON.stringify([K3]), JSON.stringify([K3]), "ran"]]);
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
		expect(spawn?.model).toEqual([SOL]);
		expect(spawn?.note).toContain(`production review fans out to openai only (${K3} (no credentials))`);
	});

	test("both pinned spawns refused: one park; one member still running: no park", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
		down(w, SOL, K3);
		expect((await h.spawn("deep", "sl-x--openai"))?.block).toBe(true);
		expect(questions(w)).toHaveLength(0); // the kimi member is still pending
		expect((await h.spawn("deep", "sl-x--kimi"))?.block).toBe(true);
		expect(questions(w)).toHaveLength(1);
		expect(bodies(w, "review-park:")).toEqual([`review-park: ${questions(w)[0]!.id} slice sl-x`]);

		const v = world({ stakes: "production" });
		const g = lane(v);
		g.laneMessage(OPUS);
		await g.toolCall({ agent: "strong", name: "sl-x", task: brief(v, "review it") }, "c1");
		down(v, SOL);
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
		down(w, SOL, K3);
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
		g.handMessage("sl-x--openai", SOL);
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
		// This exercises loop accounting; read-only reviews above cover real git fingerprints.
		// Avoid twelve synchronous snapshots (sixty git processes) across the six rounds here.
		const h = lane(w, { fingerprint: () => "unchanged" });
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
		h.handMessage("sl-x--openai", SOL);
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
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([SOL]);
		const stop = stopReviews(w, "sl-x");
		const late = await h.spawn("deep", "sl-x--kimi");
		expect(late?.reason).toContain(`instruction ${stop}`);
		expect(messages(w)).toHaveLength(0); // the openai leg is still running
		h.handMessage("sl-x--openai", SOL);
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
		h.handMessage("sl-x--openai", SOL);
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

	test("#3: a production member still queued at a restart keeps the round open; replaying the settled member completes the round, not passed, with it dropped", async () => {
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
			h.handMessage("sl-x--openai", SOL);
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
				// A dropped member has no block, so the round is unread: not passed, the loop's first unread round free (PLAN wl-mv5i3lulwwbbi8 D9).
				expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [{ complete: true, passed: false, unread: true }], failed: 0, unread: 1, passed: false });
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
		a.handMessage("sl-x--openai", SOL);
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
		expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [{ n: 1, complete: true, passed: false, unread: true }], failed: 0, unread: 1 });

		// B's round runs and is counted as round 2 of the loop.
		b.asyncReturned("c2", [
			{ index: 0, id: "sl-x--openai-1", status: "running" },
			{ index: 1, id: "sl-x--kimi-1", status: "running" },
		]);
		expect((await b.spawn("deep", "sl-x--openai-1"))?.model).toEqual([SOL]);
		expect((await b.spawn("deep", "sl-x--kimi-1"))?.model).toEqual([K3]);
		b.handMessage("sl-x--openai-1", SOL);
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
		expect((await b.spawn("deep", "sl-x--openai-1"))?.model).toEqual([SOL]);
		expect((await b.spawn("deep", "sl-x--kimi-1"))?.model).toEqual([K3]);
		b.handMessage("sl-x--openai-1", SOL);
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
		expect((await a.spawn("deep", "sl-x--openai-2"))?.model).toEqual([SOL]);
		expect((await a.spawn("deep", "sl-x--kimi-2"))?.model).toEqual([K3]);
		a.handMessage("sl-x--openai-2", SOL);
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
		down(w, SOL);
		expect((await a.spawn("deep", "sl-x--openai"))?.block).toBe(true);
		expect(questions(w)).toEqual([]); // the kimi member is still pending
		up(w, SOL);

		// Instance B runs a complete group and it passes: the loop ends.
		const b = lane(w);
		expect((await b.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c2"))?.block).toBeUndefined();
		b.asyncReturned("c2", [
			{ index: 0, id: "sl-x--openai-1", status: "running" },
			{ index: 1, id: "sl-x--kimi-1", status: "running" },
		]);
		expect((await b.spawn("deep", "sl-x--openai-1"))?.model).toEqual([SOL]);
		expect((await b.spawn("deep", "sl-x--kimi-1"))?.model).toEqual([K3]);
		b.handMessage("sl-x--openai-1", SOL);
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
		expect((await a.spawn("deep", "sl-x--openai-2"))?.model).toEqual([SOL]);
		expect((await a.spawn("deep", "sl-x--kimi-2"))?.model).toEqual([K3]);
		a.handMessage("sl-x--openai-2", SOL);
		a.handMessage("sl-x--kimi-2", K3);
		a.deliver(["sl-x--openai-2"], blocking("still wrong"));
		a.deliver(["sl-x--kimi-2"], CLEAN);
		const count = countRounds(w.ledger.entries(w.wl), "sl-x");
		expect(count).toMatchObject({ rounds: [{ n: 1, complete: true, passed: false, blocking: 1 }], failed: 1 });
		expect(count.rounds[0]!.members.map(m => m.token).some(t => tokensA.includes(t))).toBe(false);
	});
});

describe("Jo's OpenAI-reviewer rule (in-mv5qdfvskukmbk, in-mv5qfm8910ycjk)", () => {
	/** A production review of sl-x parked on a dispatch with `downed` uncredentialed, then granted same-lab by Jo with them back up. */
	async function grantedReview(builders: string[], downed: string[]) {
		const w = world({ stakes: "production" });
		const h = lane(w);
		for (const model of builders) h.laneMessage(model);
		down(w, ...downed);
		expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1"))?.block).toBe(true);
		const grant = w.ledger.answerQuestion(questions(w)[0]!.id, { by: "orchestrator-surface", answer: "same-lab", author: "jo", channel: "surface" });
		up(w, ...downed);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c2");
		expect(out?.input).toMatchObject({ name: "sl-x", agent: "deep" });
		const spawn = await h.spawn("deep", "sl-x");
		expect(spawn?.note).toContain(`same-lab grant ${grant} spent`);
		expect(spawn?.note).toContain("openai reviewer from the strong row (Jo, in-mv5qfm8910ycjk)");
		h.handMessage("sl-x", SOL);
		expect(h.results("c2", [{ id: "sl-x", agent: "deep", model: SOL }])).toBeUndefined();
		return { w, spawn };
	}

	test("production same-lab grant, builder openai: the builder's OpenAI entry is gpt-6-sol at spawn and at settle, never astra", async () => {
		const { w, spawn } = await grantedReview([SOL], [FABLE, K3]);
		expect(spawn?.model).toEqual([FABLE, K3, SOL]);
		expect(bodies(w, "hand-spawn:").map(b => / row (\S+)$/.exec(b)![1])).toEqual([[FABLE, K3, SOL].join(",")]);
		expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-x", stakes: "production", tier: "deep", models: JSON.stringify([FABLE, K3, SOL]), ran_models: JSON.stringify([SOL]), outcome: "ran" }]);
		expect(JSON.stringify(w.ledger.entries(w.wl)) + JSON.stringify(w.ledger.routings(w.wl))).not.toContain(ASTRA);
	});

	test("production same-lab grant, builders anthropic and kimi: the other lab's OpenAI entry is gpt-6-sol at spawn and at settle, never astra", async () => {
		const { w, spawn } = await grantedReview([OPUS, KIMI], [SOL]);
		expect(spawn?.model).toEqual([SOL, FABLE, K3]);
		expect(bodies(w, "hand-spawn:").map(b => / row (\S+)$/.exec(b)![1])).toEqual([[SOL, FABLE, K3].join(",")]);
		expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-x", stakes: "production", tier: "deep", models: JSON.stringify([SOL, FABLE, K3]), ran_models: JSON.stringify([SOL]), outcome: "ran" }]);
		expect(JSON.stringify(w.ledger.entries(w.wl)) + JSON.stringify(w.ledger.routings(w.wl))).not.toContain(ASTRA);
	});

	describe("a strong row with no OpenAI entry", () => {
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [OPUS, KIMI] } } });

		test("a production review with another independent lab goes to that lab only; astra is never offered", async () => {
			const w = world({ stakes: "production", table });
			const h = lane(w);
			h.laneMessage(OPUS);
			const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
			expect(out?.input).toMatchObject({ name: "sl-x", agent: "deep" });
			const spawn = await h.spawn("deep", "sl-x");
			expect(spawn?.model).toEqual([K3]);
			expect(spawn?.note).toContain("production review fans out to kimi only");
			expect(spawn?.note).toContain("no openai reviewer: the strong row has no openai entry and a review never falls back to the deep row's (Jo, in-mv5qfm8910ycjk)");
			expect(bodies(w, "hand-spawn:").map(b => / row (\S+)$/.exec(b)![1])).toEqual([K3]);
			h.handMessage("sl-x", K3);
			expect(h.results("c1", [{ id: "sl-x", agent: "deep", model: K3 }])).toBeUndefined();
			expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-x", tier: "deep", models: JSON.stringify([K3]), ran_models: JSON.stringify([K3]), outcome: "ran" }]);
		});

		test("with no independent lab left the production review parks; astra is never offered", async () => {
			const w = world({ stakes: "production", table });
			const h = lane(w);
			h.laneMessage(OPUS);
			h.laneMessage(KIMI);
			const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it") }, "c1");
			expect(out?.block).toBe(true);
			expect(out?.reason).toContain("no lab other than the builder's can review sl-x");
			expect(out?.reason).not.toContain(ASTRA);
			expect(questions(w)).toHaveLength(1);
			expect(questions(w)[0]!.body).not.toContain(ASTRA);
			expect(bodies(w, "hand-spawn:")).toEqual([]);
		});
	});

	test("control: a normal-stakes review stays on the strong row, with no rewrite note", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.model).toEqual([SOL, KIMI]);
		expect(spawn?.note).not.toContain("reviewer from the");
	});
});

/**
 * Jo's Kimi-out rule (input in-mv5xafhywe3w8w, PLAN wl-mv5xay6bjp0268 § 3.1 T1–T11): a review that parks only because Kimi
 * is out runs same-lab with a `review-same-lab-rule:` entry and no question, until 2026-11-01T00:00:00-07:00. These tests use
 * only exports the baseline has and body string literals, so they load before the change and fail there on assertions.
 */
describe("Jo's Kimi-out rule (in-mv5xafhywe3w8w)", () => {
	const RULE = "review-same-lab-rule: in-mv5xafhywe3w8w";
	const QUOTA = { status: 429, message: '429 {"error":{"message":"Your account is suspended due to insufficient balance"}}' };
	const at = (t: number) => () => t;
	const tokenOf = (body: string) => body.split(" ")[1]!;
	/**
	 * Lets a group end's Kimi-out check, which awaits the live review row, finish: its chain is microtasks only (the fake
	 * registry and disabled providers resolve at once, the ledger is synchronous), and they all drain before setImmediate runs.
	 */
	const flush = () => new Promise<void>(resolve => setImmediate(resolve));

	/**
	 * Builders {anthropic (the lane), openai (a change hand only)} on `w`, in a lane on `clock`. The lane issues the change on
	 * opus (D7 records anthropic) and switches to openai before its hand spawns, so the hand runs and settles on openai while the
	 * lane never issues or answers on it: openai's most involved role is `hand`, below the lane's, which the rule's same-lab
	 * order (least involved first) reads. The lane is back on opus for the review.
	 */
	async function built(w: World, clock: () => number = at(IN_WINDOW)) {
		const h = lane(w, { now: clock });
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change the loader") }, "c-work");
		expect(out?.block).toBeUndefined();
		h.setLaneModel(SOL);
		expect((await h.spawn(out!.input.agent, "sl-work"))?.model).toEqual([SOL]);
		h.handMessage("sl-work", SOL);
		expect(h.results("c-work", [{ id: "sl-work", agent: out!.input.agent, model: SOL }])).toBeUndefined();
		h.setLaneModel(OPUS);
		expect(bodies(w, "builder-lab:")).toEqual([`builder-lab: anthropic lane lane-test model ${OPUS}`]);
		return h;
	}

	/** The one rule entry, checked immediately followed by its token's `hand-spawn:`; returns its body and token. */
	function ruleEntry(w: World) {
		const all = bodies(w);
		const rules = all.filter(b => b.startsWith("review-same-lab-rule:"));
		expect(rules).toHaveLength(1);
		const at = all.indexOf(rules[0]!);
		const token = / token (\S+) /.exec(rules[0]!)![1]!;
		expect(all[at + 1]!.startsWith(`hand-spawn: ${token} `)).toBe(true);
		return { body: rules[0]!, token };
	}

	/** The question as today: one open park question, the slice paused, no rule entry. */
	function asksAsToday(w: World) {
		expect(questions(w).filter(q => q.state === "open")).toHaveLength(1);
		expect(bodies(w, "review-park:")).toHaveLength(1);
		expect(bodies(w, "review-same-lab-rule:")).toEqual([]);
	}

	test("T1 production, kimi entry not in the registry: not failed, no question, one rule entry before its hand-spawn:, OpenAI then Anthropic", async () => {
		const w = world({ stakes: "production" });
		w.registry = fakeRegistry(ALL.filter(m => m !== K3), w.creds);
		const h = await built(w);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		expect(out?.block).toBeUndefined();
		expect(out?.input).toMatchObject({ name: "sl-x", agent: "deep" });
		expect(bodies(w, "review-same-lab-rule:")).toEqual([]); // nothing is written at the tool_call
		const spawn = await h.spawn("deep", "sl-x");
		expect(spawn?.model).toEqual([SOL, FABLE]);
		const { body, token } = ruleEntry(w);
		expect(body).toBe(`${RULE} slice sl-x token ${token} labs openai,anthropic kimi ${K3} (not in the model registry)`);
		expect(spawn?.note).toContain(`kimi leg missing: ${K3} (not in the model registry) (Jo's rule in-mv5xafhywe3w8w)`);
		expect(spawn?.note).toContain("Kimi out: same-lab is decided at spawn (Jo's rule in-mv5xafhywe3w8w)");
		expect(questions(w)).toEqual([]);
		expect(w.ledger.slice("sl-x")?.state).not.toBe("paused");
		h.handMessage("sl-x", SOL);
		expect(h.results("rev-1", [{ id: "sl-x", agent: "deep", model: SOL, output: CLEAN }])).toBeUndefined();
	});

	test("T1b production, no kimi entry in the tier row: the rule's rowOmission is the evidence", async () => {
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, deep: [FABLE, ASTRA] } } });
		const w = world({ stakes: "production", table });
		const h = await built(w);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		expect(out?.block).toBeUndefined();
		const spawn = await h.spawn("deep", "sl-x");
		expect(spawn?.model).toEqual([SOL, FABLE]);
		const { body, token } = ruleEntry(w);
		expect(body).toBe(`${RULE} slice sl-x token ${token} labs openai,anthropic kimi no kimi entry in the deep review row (KIMI_OUT_RULE.rowOmission)`);
		expect(questions(w)).toEqual([]);
	});

	test("T2 normal stakes, kimi uncredentialed: the spawn writes the rule entry and runs OpenAI then Anthropic", async () => {
		const w = world();
		const h = await built(w);
		down(w, KIMI);
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.model).toEqual([SOL, OPUS]);
		const { body, token } = ruleEntry(w);
		expect(body).toBe(`${RULE} slice sl-x token ${token} labs openai,anthropic kimi ${KIMI} (no credentials)`);
		expect(questions(w)).toEqual([]);
		expect(bodies(w, "review-same-lab:")).toEqual([]);
		h.handMessage("sl-x", OPUS);
		expect(h.results("rev-1", [{ id: "sl-x", agent: "strong", model: OPUS, output: CLEAN }])).toBeUndefined();
	});

	/** A production fan-out of sl-x by an anthropic lane on `clock`: the openai member changes the work, the kimi member gets `kimi` turns. */
	async function fanOut(w: World, kimi: { selector: string; error?: ErrorTurn }[], clock: () => number = at(IN_WINDOW)) {
		const h = lane(w, { now: clock });
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c1");
		expect(out?.input.tasks.map(t => t.name)).toEqual(["sl-x--openai", "sl-x--kimi"]);
		await h.spawn("deep", "sl-x--openai");
		await h.spawn("deep", "sl-x--kimi");
		writeFileSync(join(w.repo, "a.txt"), "the review edited this\n");
		h.handMessage("sl-x--openai", SOL);
		for (const turn of kimi) h.handMessage("sl-x--kimi", turn.selector, turn.error);
		const [openai, kimiToken] = bodies(w, "hand-spawn:").map(tokenOf) as [string, string];
		return { h, openai, kimiToken };
	}
	const settleFan = (h: Lane) =>
		h.results("c1", [
			{ id: "sl-x--openai", agent: "deep", model: SOL, output: CLEAN },
			{ id: "sl-x--kimi", agent: "deep", model: K3, output: "" },
		]);

	test("T3 fan-out: kimi fails on a quota 429, openai withheld: no question, provider-refused written, a replay writes nothing, the re-dispatch runs same-lab", async () => {
		const w = world({ stakes: "production" });
		const { h, kimiToken } = await fanOut(w, [{ selector: K3, error: QUOTA }]);
		settleFan(h);
		await flush();
		expect(bodies(w, "review-withheld:")).toHaveLength(1);
		expect(bodies(w, "provider-refused:")).toEqual([`provider-refused: moonshot status 429 token ${kimiToken}`]);
		expect(questions(w)).toEqual([]);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(h.logs.some(l => l.includes("Kimi out under Jo's rule in-mv5xafhywe3w8w"))).toBe(true);
		const before = w.ledger.entries(w.wl).length;
		const replay = lane(w, { now: at(IN_WINDOW) });
		replay.deliver(["sl-x--kimi"], "");
		replay.deliver(["sl-x--openai"], CLEAN);
		await flush();
		expect(w.ledger.entries(w.wl).length).toBe(before);
		expect(questions(w)).toEqual([]);

		const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2");
		expect(again?.input).toMatchObject({ name: "sl-x", agent: "deep" });
		const spawn = await h.spawn("deep", "sl-x");
		expect(spawn?.model).toEqual([SOL, FABLE]);
		const { body, token } = ruleEntry(w);
		expect(body).toBe(`${RULE} slice sl-x token ${token} labs openai,anthropic kimi ${K3} (its provider refused on ${kimiToken} (status 429))`);
	});

	// Each "question as today" test also runs its control, the same setup with only the one factor changed, which the rule
	// does take: the test then shows that factor is what keeps the question, and it fails on the baseline on an assertion.
	test("T3b fan-out: kimi member silent (no assistant turn), openai withheld: question as today", async () => {
		for (const kimi of [[], [{ selector: K3, error: QUOTA }]]) {
			const w = world({ stakes: "production" });
			const { h } = await fanOut(w, kimi);
			settleFan(h);
			await flush();
			if (kimi.length > 0) {
				expect(questions(w)).toEqual([]); // control: a quota refusal
				continue;
			}
			expect(bodies(w, "provider-refused:")).toEqual([]);
			asksAsToday(w);
		}
	});

	test("T3c fan-out: kimi member fails on an ordinary 500 or a plain 429, openai withheld: question as today", async () => {
		for (const error of [{ status: 500, message: "500 internal server error" }, { status: 429, message: "429 rate limit reached, retry later" }, QUOTA]) {
			const w = world({ stakes: "production" });
			const { h } = await fanOut(w, [{ selector: K3, error }]);
			settleFan(h);
			await flush();
			if (error === QUOTA) {
				expect(questions(w)).toEqual([]); // control
				continue;
			}
			expect(bodies(w, "provider-refused:")).toEqual([]);
			asksAsToday(w);
		}
	});

	test("T3d fan-out after a restart: a fresh instance replays the group's end; the quota refusal on the kimi token takes the question off, without it the question is raised", async () => {
		for (const error of [QUOTA, { status: 429, message: "429 rate limit reached" }]) {
			const w = world({ stakes: "production" });
			const { h } = await fanOut(w, [{ selector: K3, error }]);
			h.results("c1", [{ id: "sl-x--kimi", agent: "deep", model: K3, output: "" }]); // the openai member is still running
			expect(questions(w)).toEqual([]);
			const restarted = lane(w, { now: at(IN_WINDOW) }); // the openai hand died with the process
			restarted.results("c1", [{ id: "sl-x--openai", agent: "deep", model: SOL, output: CLEAN }]);
			await flush();
			if (error === QUOTA) {
				expect(questions(w)).toEqual([]);
				expect(bodies(w, "review-park:")).toEqual([]);
			} else {
				asksAsToday(w);
			}
		}
	});

	test("T3e fan-out on a row with moonshot and kimi-code: quota 429 from moonshot, ordinary 500 from kimi-code: kimi-code stays usable, question as today", async () => {
		const KC = "kimi-code/kimi-for-coding";
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, deep: [FABLE, ASTRA, K3, KC] } } });
		const w = world({ stakes: "production", table });
		w.creds.push(KC);
		w.registry = fakeRegistry([...ALL, KC], w.creds);
		const { h } = await fanOut(w, [
			{ selector: K3, error: QUOTA },
			{ selector: KC, error: { status: 500, message: "500 internal server error" } },
		]);
		settleFan(h);
		await flush();
		expect(bodies(w, "provider-refused:")).toEqual([expect.stringMatching(/^provider-refused: moonshot status 429 /)]);
		asksAsToday(w);
	});

	/** A production world whose deep row is [FABLE, ASTRA, K3, KC], with kimi-code uncredentialed or not in the registry. */
	function kimiCodeOut(out: "uncredentialed" | "unregistered") {
		const KC = "kimi-code/kimi-for-coding";
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, deep: [FABLE, ASTRA, K3, KC] } } });
		const w = world({ stakes: "production", table });
		if (out === "uncredentialed") w.registry = fakeRegistry([...ALL, KC], w.creds);
		return { w, KC, why: out === "uncredentialed" ? "no credentials" : "not in the model registry" };
	}

	test("T3f fan-out on a row with moonshot and kimi-code, kimi-code out at the spawn: quota 429 from moonshot, openai withheld: no question, the re-dispatch runs same-lab", async () => {
		for (const out of ["uncredentialed", "unregistered"] as const) {
			const { w, KC, why } = kimiCodeOut(out);
			const { h, kimiToken } = await fanOut(w, [{ selector: K3, error: QUOTA }]);
			expect(bodies(w, "hand-spawn:").find(b => b.startsWith(`hand-spawn: ${kimiToken} `))).toEndWith(` row ${K3}`);
			settleFan(h);
			await flush();
			expect(bodies(w, "review-withheld:")).toHaveLength(1);
			expect(bodies(w, "provider-refused:")).toEqual([`provider-refused: moonshot status 429 token ${kimiToken}`]);
			expect(questions(w)).toEqual([]);
			expect(bodies(w, "review-park:")).toEqual([]);
			expect(h.logs.some(l => l.includes("Kimi out under Jo's rule in-mv5xafhywe3w8w"))).toBe(true);

			const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2");
			expect(again?.input).toMatchObject({ name: "sl-x", agent: "deep" });
			const spawn = await h.spawn("deep", "sl-x");
			expect(spawn?.model).toEqual([SOL, FABLE]);
			expect(ruleEntry(w).body).toContain(`kimi ${K3} (its provider refused on ${kimiToken} (status 429)), ${KC} (${why})`);
		}
	});

	test("T3f' the T3f fan-out after a restart: a fresh instance replays the group's end with kimi-code out at the spawn: no question", async () => {
		for (const out of ["uncredentialed", "unregistered"] as const) {
			const { w } = kimiCodeOut(out);
			const { h } = await fanOut(w, [{ selector: K3, error: QUOTA }]);
			h.results("c1", [{ id: "sl-x--kimi", agent: "deep", model: K3, output: "" }]); // the openai member is still running
			expect(questions(w)).toEqual([]);
			const restarted = lane(w, { now: at(IN_WINDOW) }); // the openai hand died with the process
			restarted.results("c1", [{ id: "sl-x--openai", agent: "deep", model: SOL, output: CLEAN }]);
			await flush();
			expect(questions(w)).toEqual([]);
			expect(bodies(w, "review-park:")).toEqual([]);
			expect(restarted.logs.some(l => l.includes("Kimi out under Jo's rule in-mv5xafhywe3w8w"))).toBe(true);
		}
	});

	test("T3g two concurrent fan-outs: group A's moonshot member refuses, then group B's: B's later refusal does not hide A's, no question at A's end", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w, { now: at(IN_WINDOW) });
		h.laneMessage(OPUS);
		const a = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c1");
		expect(a?.input.tasks.map(t => t.name)).toEqual(["sl-x--openai", "sl-x--kimi"]);
		const b = await h.toolCall({ agent: "strong", name: "sl-y", task: brief(w, "review the change") }, "c2");
		expect(b?.input.tasks.map(t => t.name)).toEqual(["sl-y--openai", "sl-y--kimi"]);
		for (const key of ["sl-x--openai", "sl-x--kimi", "sl-y--openai", "sl-y--kimi"]) await h.spawn("deep", key);
		const [, aKimi, , bKimi] = bodies(w, "hand-spawn:").map(tokenOf) as [string, string, string, string];
		writeFileSync(join(w.repo, "a.txt"), "the review edited this\n");
		h.handMessage("sl-x--kimi", K3, QUOTA);
		h.results("c1", [{ id: "sl-x--kimi", agent: "deep", model: K3, output: "" }]); // A's openai member is still running
		h.handMessage("sl-y--kimi", K3, QUOTA);
		h.results("c2", [{ id: "sl-y--kimi", agent: "deep", model: K3, output: "" }]); // B's openai member is still running
		expect(bodies(w, "provider-refused:")).toEqual([`provider-refused: moonshot status 429 token ${aKimi}`, `provider-refused: moonshot status 429 token ${bKimi}`]);
		h.handMessage("sl-x--openai", SOL);
		h.results("c1", [{ id: "sl-x--openai", agent: "deep", model: SOL, output: CLEAN }]); // A's group ends
		await flush();
		expect(bodies(w, "review-withheld:")).toHaveLength(1);
		expect(questions(w)).toEqual([]);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(h.logs.some(l => l.includes(`Kimi out under Jo's rule in-mv5xafhywe3w8w (provider-refused on ${aKimi})`))).toBe(true);
	});

	test("T3h the T3f fan-out, but kimi-code regains credentials before the group's end: question as today", async () => {
		for (const regained of [true, false]) {
			const { w, KC } = kimiCodeOut("uncredentialed");
			const { h, kimiToken } = await fanOut(w, [{ selector: K3, error: QUOTA }]);
			expect(bodies(w, "hand-spawn:").find(b => b.startsWith(`hand-spawn: ${kimiToken} `))).toEndWith(` row ${K3}`); // kimi-code out at the spawn
			h.results("c1", [{ id: "sl-x--kimi", agent: "deep", model: K3, output: "" }]); // the openai member is still running
			if (regained) up(w, KC);
			h.results("c1", [{ id: "sl-x--openai", agent: "deep", model: SOL, output: CLEAN }]);
			await flush();
			expect(bodies(w, "provider-refused:")).toEqual([`provider-refused: moonshot status 429 token ${kimiToken}`]);
			if (!regained) {
				expect(questions(w)).toEqual([]); // control: kimi-code still uncredentialed (T3f)
				continue;
			}
			asksAsToday(w);
		}
	});

	test("T3i the T3e fan-out, its group-end check still awaiting kimi-code's credentials when the next review round of sl-x is dispatched: the late check raises no park question and the slice is not paused (CODE-REVIEW-r3)", async () => {
		// Control: the same setup with no interleaved dispatch still parks once.
		for (const interleaved of [true, false]) {
			const KC = "kimi-code/kimi-for-coding";
			const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, deep: [FABLE, ASTRA, K3, KC] } } });
			const w = world({ stakes: "production", table });
			w.creds.push(KC);
			const base = fakeRegistry([...ALL, KC], w.creds);
			// Armed once the fan-out has spawned: the next session-free lookup of kimi-code's key (the group end's (ii)) waits on it, once.
			let hold: Promise<void> | null = null;
			let release = () => {};
			w.registry = {
				...base,
				getApiKey: async (m, s) => {
					if (hold && s === undefined && `${m.provider}/${m.id}` === KC) {
						const held = hold;
						hold = null;
						await held;
					}
					return base.getApiKey(m, s);
				},
			};
			const { h } = await fanOut(w, [{ selector: K3, error: QUOTA }]);
			hold = new Promise<void>(resolve => (release = resolve));
			settleFan(h);
			await flush();
			expect(hold).toBeNull(); // the group end's check took it and is waiting
			expect(questions(w)).toEqual([]);
			if (interleaved) {
				const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2");
				expect(again?.block).toBeUndefined();
				const items = again!.input!.tasks ?? [again!.input!];
				for (const item of items) expect((await h.spawn(item.agent, item.name))?.block).toBeUndefined();
				expect(bodies(w, "hand-spawn:")).toHaveLength(2 + items.length);
			}
			release();
			await flush();
			if (!interleaved) {
				asksAsToday(w); // control
				expect(w.ledger.slice("sl-x")?.state).toBe("paused");
				continue;
			}
			expect(questions(w)).toEqual([]);
			expect(bodies(w, "review-park:")).toEqual([]);
			expect(w.ledger.slice("sl-x")?.state).not.toBe("paused");
			expect(h.logs.some(l => l.includes("a newer review dispatch of sl-x has begun, so this group raises no park question"))).toBe(true);
		}
	});

	test("T3j the T3i fan-out, but round 2's tool_call is itself still awaiting kimi-code's credentials when the group end's check resumes: no park question, and round 2 is published", async () => {
		const KC = "kimi-code/kimi-for-coding";
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, deep: [FABLE, ASTRA, K3, KC] } } });
		const w = world({ stakes: "production", table });
		w.creds.push(KC);
		const base = fakeRegistry([...ALL, KC], w.creds);
		// Each armed hold takes the next session-free lookup of kimi-code's key, in order.
		const holds: Promise<void>[] = [];
		const hold = () => {
			let release = () => {};
			holds.push(new Promise<void>(resolve => (release = resolve)));
			return release;
		};
		w.registry = {
			...base,
			getApiKey: async (m, s) => {
				if (holds.length > 0 && s === undefined && `${m.provider}/${m.id}` === KC) await holds.shift();
				return base.getApiKey(m, s);
			},
		};
		const { h } = await fanOut(w, [{ selector: K3, error: QUOTA }]);
		const releaseEnd = hold();
		settleFan(h);
		await flush();
		expect(holds).toHaveLength(0); // the group end's (ii) is waiting
		const releaseRound2 = hold();
		const round2 = h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2");
		await flush();
		expect(holds).toHaveLength(0); // round 2's tool_call is waiting in its own usableRow
		releaseEnd();
		await flush();
		expect(questions(w)).toEqual([]);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(h.logs.some(l => l.includes("a newer review dispatch of sl-x has begun, so this group raises no park question"))).toBe(true);
		releaseRound2();
		const again = await round2;
		expect(again?.block).toBeUndefined();
		expect(again?.input).toBeDefined();
		expect(questions(w).filter(q => q.state === "open")).toEqual([]);
		expect(w.ledger.slice("sl-x")?.state).not.toBe("paused");
	});

	/** A normal-stakes review of sl-x whose only hand is kimi (builders anthropic and openai), its turn ending on `error`. */
	async function kimiOnly(w: World, error: ErrorTurn | null, clock: () => number = at(IN_WINDOW)) {
		const h = await built(w, clock);
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.model).toEqual([KIMI]);
		if (error) h.handMessage("sl-x", KIMI, error);
		expect(h.results("rev-1", [{ id: "sl-x", agent: "strong", model: KIMI, output: "" }])?.isError).toBe(true);
		return { h, token: tokenOf(bodies(w, "hand-spawn:").at(-1)!) };
	}

	test("T4a a single kimi hand fails on a quota 429: provider-refused: moonshot status 429; the re-dispatch runs same-lab under the rule", async () => {
		const w = world();
		const { h, token } = await kimiOnly(w, QUOTA);
		expect(bodies(w, "provider-refused:")).toEqual([`provider-refused: moonshot status 429 token ${token}`]);
		expect(questions(w)).toEqual([]);
		const spawn = await reviewSpawn(h, w, "sl-x", "rev-2");
		expect(spawn?.model).toEqual([SOL, OPUS]);
		expect(ruleEntry(w).body).toContain(`kimi ${KIMI} (its provider refused on ${token} (status 429))`);
	});

	test("T4b a plain 429 with no quota text writes no provider-refused:", async () => {
		for (const error of [{ status: 429, message: "429 rate limit reached, retry later" }, QUOTA]) {
			const w = world();
			await kimiOnly(w, error);
			expect(bodies(w, "provider-refused:")).toHaveLength(error === QUOTA ? 1 : 0); // QUOTA: the control
		}
	});

	test("T4d a quota-text 429 on a non-kimi provider (openai-codex) writes no provider-refused:", async () => {
		for (const model of [SOL, KIMI]) {
			const w = world();
			const h = lane(w, { now: at(IN_WINDOW) });
			h.laneMessage(OPUS);
			expect((await reviewSpawn(h, w))?.model).toEqual([SOL, KIMI]);
			h.handMessage("sl-x", model, { status: 429, message: "insufficient balance: exceeded_current_quota" });
			expect(h.results("rev-1", [{ id: "sl-x", agent: "strong", model, output: "" }])?.isError).toBe(true);
			expect(bodies(w, "provider-refused:")).toHaveLength(model === KIMI ? 1 : 0); // KIMI: the control
		}
	});

	test("T4e at the end a quota 429 writes nothing; a 429 refusal from the window is not honoured after it, a 401 still is", async () => {
		const after = world();
		await kimiOnly(after, QUOTA, at(RULE_END));
		expect(bodies(after, "provider-refused:")).toEqual([]);

		const quota = world();
		await kimiOnly(quota, QUOTA);
		expect(bodies(quota, "provider-refused:")).toHaveLength(1);
		expect((await reviewSpawn(lane(quota, { now: at(RULE_END) }), quota, "sl-x", "rev-2"))?.model).toEqual([KIMI]);

		const login = world();
		await kimiOnly(login, { status: 401, message: "401 invalid api key" });
		expect(bodies(login, "provider-refused:")).toEqual([expect.stringMatching(/^provider-refused: moonshot status 401 /)]);
		expect((await reviewSpawn(lane(login, { now: at(RULE_END) }), login, "sl-x", "rev-2"))?.block).toBe(true);
		asksAsToday(login);
	});

	test("T4c a single hand with no assistant turn seen: question as today, no rule entry", async () => {
		const control = world(); // control: the turn ended on a quota 429, so the re-dispatch runs same-lab under the rule
		const { h } = await kimiOnly(control, QUOTA);
		expect(questions(control)).toEqual([]);
		expect((await reviewSpawn(h, control, "sl-x", "rev-2"))?.model).toEqual([SOL, OPUS]);
		ruleEntry(control);
		const w = world();
		await kimiOnly(w, null);
		asksAsToday(w);
	});

	test("T5 the end: at 2026-11-01T00:00:00-07:00 the question as today, a millisecond before it the rule entry; a clock crossing the end between the tool_call and the spawn parks at the spawn", async () => {
		const end = world();
		const h = await built(end, at(RULE_END));
		down(end, KIMI);
		expect((await reviewSpawn(h, end))?.block).toBe(true);
		asksAsToday(end);

		const before = world();
		const g = await built(before, at(Date.parse("2026-10-31T23:59:59.999-07:00")));
		down(before, KIMI);
		expect((await reviewSpawn(g, before))?.model).toEqual([SOL, OPUS]);
		ruleEntry(before);

		const crossing = world({ stakes: "production" });
		let now = IN_WINDOW;
		const c = await built(crossing, () => now);
		down(crossing, K3);
		const out = await c.toolCall({ agent: "strong", name: "sl-x", task: brief(crossing, "review the change") }, "rev-1");
		expect(out?.input).toMatchObject({ name: "sl-x", agent: "deep" });
		now = RULE_END;
		const spawn = await c.spawn("deep", "sl-x");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("parked on question");
		asksAsToday(crossing);
	});

	test("T5b Jo's `end-ruling kimi-out` ends the rule at once: in the window, the park asks as today and no rule entry is written", async () => {
		const control = world();
		await ruleRuns(control, await built(control));
		const w = world();
		const h = await built(w);
		// What the surface writes for Jo's word (surface/src/input.ts `end-ruling`): Jo's instruction on the standing workload.
		w.ledger.openWorkload({ by: SURFACE_BY, id: "wl-orchestrator", brief: "standing", stakes: "normal", mode: "user-driven" });
		w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: "wl-orchestrator", body: "end-ruling kimi-out", author: "jo", channel: "surface" });
		down(w, KIMI);
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		asksAsToday(w);
	});

	/** The control the review-time guards share: builders anthropic and openai, kimi uncredentialed → the rule's same-lab hand. */
	async function ruleRuns(w: World, h: Lane) {
		down(w, KIMI);
		expect((await reviewSpawn(h, w))?.model).toEqual([SOL, OPUS]);
		ruleEntry(w);
		expect(questions(w)).toEqual([]);
	}

	test("T6 Kimi working but a builder (all three labs built): question as today, no rule entry", async () => {
		const control = world();
		await ruleRuns(control, await built(control)); // Kimi not a builder
		const w = world();
		const h = await built(w);
		h.setLaneModel(KIMI);
		await settled(h, w, "sl-y", "change the parser", KIMI, "c-kimi");
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		asksAsToday(w);
	});

	test("T7 unknown provenance (a lane with no builder-lab:): question as today", async () => {
		const control = world();
		await ruleRuns(control, await built(control)); // the lane answered
		const w = world();
		// A dispatch records its issuing lane's lab (D7), so lane-test, building on openai, is known; the workload's unknown
		// provenance is another runner lane that started and has no builder-lab: entry.
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: 'lane-started: lane-b {"pid":2}' });
		const h = lane(w, { now: at(IN_WINDOW), laneModel: SOL });
		await settled(h, w, "sl-work", "change the loader", SOL, "c-work");
		down(w, KIMI);
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		asksAsToday(w);
		expect(questions(w)[0]!.body).toContain("lane lane-b has a lane-started: entry and no builder-lab: entry");
	});

	test("T7b a row entry on a provider with no lab: question as today", async () => {
		const control = world();
		await ruleRuns(control, await built(control)); // the row as configured
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [OPUS, SOL, KIMI, "mystery/model-x"] } } });
		const w = world({ table });
		const h = await built(w);
		down(w, KIMI);
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		asksAsToday(w);
	});

	test("T8 no runnable same-lab model: question as today, no rule entry, at the tool_call and at the spawn", async () => {
		const prodControl = world({ stakes: "production" });
		const p = await built(prodControl);
		down(prodControl, K3); // the builders' deep entries still usable
		expect((await p.toolCall({ agent: "strong", name: "sl-x", task: brief(prodControl, "review the change") }, "rev-1"))?.block).toBeUndefined();
		const prod = world({ stakes: "production" });
		const h = await built(prod);
		down(prod, FABLE, SOL, K3);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(prod, "review the change") }, "rev-1");
		expect(out?.block).toBe(true);
		asksAsToday(prod);

		const control = world();
		await ruleRuns(control, await built(control)); // the builders' strong entries still usable
		const w = world();
		const g = await built(w);
		down(w, OPUS, SOL, KIMI);
		expect((await reviewSpawn(g, w))?.block).toBe(true);
		asksAsToday(w);
	});

	test("T9 round limit: the failed round at the limit raises review-limit:; the next dispatch is refused; after Jo's extend the re-dispatch runs same-lab under the rule", async () => {
		const w = world();
		roundsLimit(w, 1);
		const h = await built(w);
		await reviewRound(h, w, "rev-1", blocking("first"), { model: KIMI });
		const [q] = questions(w);
		expect(bodies(w, "review-limit:")).toEqual([`review-limit: ${q!.id} slice sl-x`]);
		const refused = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-2");
		expect(refused?.block).toBe(true);
		expect(bodies(w, "review-same-lab-rule:")).toEqual([]);
		const extend = w.ledger.answerQuestion(q!.id, { by: SURFACE_BY, answer: "extend", author: JO_HOLDER, channel: "surface" });
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, sliceId: "sl-x", kind: "assumption", body: reviewRoundsExtendBody("sl-x", 1, extend) });
		down(w, KIMI);
		const spawn = await reviewSpawn(h, w, "sl-x", "rev-3");
		expect(spawn?.model).toEqual([SOL, OPUS]);
		ruleEntry(w);
		expect(bodies(w, "review-park:")).toEqual([]);
	});

	test("T10 least-involved first: builders anthropic (the lane) and openai (a withheld review only) run openai then anthropic, under the rule and under Jo's own grant", async () => {
		/** A lane on anthropic whose first review, on openai, changed the work; then kimi is down. */
		async function withheldOpenai(clock: () => number) {
			const w = world();
			const h = lane(w, { now: clock });
			h.laneMessage(OPUS);
			expect((await reviewSpawn(h, w))?.model).toEqual([SOL, KIMI]);
			writeFileSync(join(w.repo, "a.txt"), "the review edited this\n");
			h.handMessage("sl-x", SOL);
			expect(h.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL, output: CLEAN }])?.isError).toBe(true);
			down(w, KIMI);
			return { w, h };
		}
		const ruled = await withheldOpenai(at(IN_WINDOW));
		expect((await reviewSpawn(ruled.h, ruled.w, "sl-x", "rev-2"))?.model).toEqual([SOL, OPUS]);
		expect(ruleEntry(ruled.w).body).toContain(" labs openai,anthropic kimi ");

		const granted = await withheldOpenai(at(RULE_END));
		expect((await reviewSpawn(granted.h, granted.w, "sl-x", "rev-2"))?.block).toBe(true);
		const question = questions(granted.w)[0]!;
		granted.w.ledger.answerQuestion(question.id, { by: SURFACE_BY, answer: "same-lab", author: JO_HOLDER, channel: "surface" });
		expect((await reviewSpawn(granted.h, granted.w, "sl-x", "rev-3"))?.model).toEqual([SOL, OPUS]);
		expect(bodies(granted.w, "review-same-lab:")).toHaveLength(1);
	});

	test("T11 forged evidence: a provider-refused: for a token with no hand-spawn: is not Kimi-out evidence; question as today", async () => {
		const control = world();
		await ruleRuns(control, await built(control)); // kimi genuinely out
		const w = world();
		const h = await built(w);
		w.ledger.recordEntry({ by: "lane-test", workloadId: w.wl, kind: "assumption", body: "provider-refused: moonshot status 401 token dt-fake" });
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		asksAsToday(w);
	});
});

/**
 * Quota headroom at hand spawns (PLAN wl-mv71x5rwdu7eo0 § 3; Jo's inputs in-mv8p5m2t005tts and in-mv8qzqym1ihmv4): an
 * entry whose lab the quota watcher's polls project out is skipped at the spawn, by the extension reading the polls file
 * `AS2_HEADROOM_POLLS` names on the lane's clock (`now`, RULE_END here). The polls are real-shaped lines: `t` in epoch
 * seconds, `resetsAt` in epoch ms.
 */
describe("quota headroom at hand spawns (PLAN wl-mv71x5rwdu7eo0 § 3)", () => {
	const MIN = 60_000;
	const HOUR = 60 * MIN;
	const SONNET = ROWS.standard[0]!;
	type Limit = { windowId: string; used: number; resetsIn: number; tier?: string };
	/** One poll line `ago` minutes before the lane's clock, with anthropic `limits` resetting `resetsIn` ms after it. */
	const poll = (ago: number, limits: Limit[]) =>
		JSON.stringify({
			t: (RULE_END - ago * MIN) / 1000,
			rows: {},
			limits: limits.map(l => ({ provider: "anthropic", windowId: l.windowId, tier: l.tier ?? null, resetsAt: RULE_END + l.resetsIn, usedFraction: l.used })),
		});
	const FIVE_HOUR_085: Limit[] = [
		{ windowId: "5h", used: 0.85, resetsIn: 4.9 * HOUR }, // 6 min gone: before projection warm-up, so only the 80 % rule
		{ windowId: "7d", used: 0.3, resetsIn: 3 * 24 * HOUR },
	];
	const OUT_085 = "anthropic 5h 0.85 used > 0.80";

	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.AS2_HEADROOM_POLLS;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AS2_HEADROOM_POLLS;
		else process.env.AS2_HEADROOM_POLLS = saved;
	});
	/** Point the extension at a temp polls file holding `lines`. */
	const usePolls = (...lines: string[]) => {
		const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "headroom-"));
		dirs.push(dir);
		const path = join(dir, "polls.jsonl");
		writeFileSync(path, `${lines.join("\n")}\n`);
		process.env.AS2_HEADROOM_POLLS = path;
	};

	/** Shared 26-minute endpoints: OpenAI's week is mature and projects to 1.05 at the newest poll. */
	const comparisonPolls = (opts: { claude?: [number, number]; sourceUsed?: number; sourceHard?: boolean } = {}) => {
		const claude = opts.claude ?? [0.04, 0.34];
		const newest = RULE_END - MIN;
		const weekReset = newest + (7 * 24 * 60 - 2016) * MIN;
		return [27, 1].map((ago, index) =>
			JSON.stringify({
				t: (RULE_END - ago * MIN) / 1000,
				rows: {},
				limits: [
					{ provider: "openai-codex", windowId: "7d", tier: null, resetsAt: weekReset, usedFraction: index === 0 ? 0.2 : (opts.sourceUsed ?? 0.21) },
					...(opts.sourceHard ? [{ provider: "openai-codex", windowId: "5h", tier: null, resetsAt: newest + 4 * HOUR, usedFraction: index === 0 ? 0.8 : 0.87 }] : []),
					{ provider: "anthropic", windowId: "5h", tier: null, resetsAt: newest + 4 * HOUR, usedFraction: claude[index] },
				],
			}),
		);
	};

	async function openaiBuild(w: World, opts: Parameters<typeof lane>[1] = {}) {
		const h = lane(w, { ...opts, laneModel: SOL });
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change the loader") }, "c1");
		expect(out?.block).toBeUndefined();
		return { h, spawn: await h.spawn(out!.input.agent, "sl-work") };
	}

	test("a mature-week OpenAI build stays same-lab against hotter, quota-out Claude and explains retention without a source skip", async () => {
		for (const claude of [[0.04, 0.34], [0.73, 0.87]] as [number, number][]) {
			usePolls(...comparisonPolls({ claude }));
			const w = world();
			const { spawn } = await openaiBuild(w);
			expect(spawn?.model).toEqual([SOL]);
			expect(spawn?.note).toContain("openai-codex 7d 0.21 used");
			expect(spawn?.note).toContain(OPUS);
			expect(spawn?.note).toContain("26");
			expect(spawn?.note).toContain("retained");
			expect(spawn?.note).not.toContain(`skipped ${SOL}`);
			expect(bodies(w, "headroom-skip:")).toEqual([]);
			expect(bodies(w, "provider-refused:")).toEqual([]);
			expect(bodies(w, "hand-spawn:")).toEqual([expect.stringContaining(` row ${SOL}`)]);
		}
	});

	test("slower or tied Claude, source exhaustion and a hard source meter still refuse the same-lab build", async () => {
		for (const opts of [
			{ claude: [0.33, 0.33] as [number, number] },
			{ claude: [0.2, 0.21] as [number, number] },
			{ sourceUsed: 1 },
			{ sourceHard: true },
		]) {
			usePolls(...comparisonPolls(opts));
			const w = world();
			const { spawn } = await openaiBuild(w);
			expect(spawn?.block).toBe(true);
			expect(spawn?.reason).toContain("a build hand never runs on another lab");
			expect(bodies(w, "hand-spawn:")).toEqual([]);
			expect(bodies(w, "headroom-skip:")).toEqual([expect.stringContaining(`headroom-skip: ${SOL} token `)]);
		}
	});

	test("unavailable counterfactual budgets cannot retain a build, including session-free and spawn-specific credentials", async () => {
		for (const unavailable of ["missing credentials", "spawn credentials", "disabled", "refused", "unregistered"] as const) {
			usePolls(...comparisonPolls());
			const w = world();
			if (unavailable === "missing credentials") down(w, OPUS);
			if (unavailable === "spawn credentials") w.registry = fakeRegistry(ALL, w.creds, [OPUS]);
			if (unavailable === "unregistered") w.registry = fakeRegistry(ALL.filter(m => m !== OPUS), w.creds);
			if (unavailable === "refused") w.ledger.recordEntry({ by: "lane-test", workloadId: w.wl, kind: "assumption", body: "provider-refused: anthropic status 401 token dt-prior" });
			const { spawn } = await openaiBuild(w, { disabledProviders: unavailable === "disabled" ? ["anthropic"] : [] });
			expect({ unavailable, block: spawn?.block }).toEqual({ unavailable, block: true });
			expect(bodies(w, "hand-spawn:")).toEqual([]);
			expect(bodies(w, "headroom-skip:")).toEqual([expect.stringContaining(`headroom-skip: ${SOL} token `)]);
		}
	});

	test("the first configured budget wins: a slower Kimi comparator does not yield to later hot Claude", async () => {
		const lines = comparisonPolls().map(line => {
			const poll = JSON.parse(line);
			poll.limits.push({ provider: "moonshot", windowId: "7d", tier: null, resetsAt: RULE_END + 4 * 24 * HOUR, usedFraction: 0.1 });
			return JSON.stringify(poll);
		});
		usePolls(...lines);
		const w = world({ table: tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [SOL, KIMI, OPUS] } } }) });
		expect((await openaiBuild(w)).spawn?.block).toBe(true);
		expect(bodies(w, "hand-spawn:")).toEqual([]);
	});

	test("a retained review source still excludes its builder lab; comparison never authorizes hard-out Claude", async () => {
		usePolls(...comparisonPolls());
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.model).toEqual([SOL, KIMI]);
		expect(spawn?.note).toContain("retained");
		expect(spawn?.note).toContain("review routed off the builder lab anthropic");
		expect(bodies(w, "headroom-skip:").some(body => body.startsWith(`headroom-skip: ${SOL} `))).toBe(false);

		const builder = world();
		const b = lane(builder, { laneModel: SOL });
		b.laneMessage(SOL);
		const builderSpawn = await reviewSpawn(b, builder);
		expect(builderSpawn?.model).toEqual([KIMI]);
		expect(builderSpawn?.note).not.toContain("retained");
	});

	test("production planning restores the eligible OpenAI leg but its final spawn remains pinned and rechecks credentials", async () => {
		for (const lostCredentials of [false, true]) {
			usePolls(...comparisonPolls());
			const w = world({ stakes: "production" });
			const h = lane(w);
			h.laneMessage(OPUS);
			const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change", "production") }, "c1");
			expect(out?.block).toBeUndefined();
			expect(out?.input?.tasks.map(item => item.name)).toEqual(["sl-x--openai", "sl-x--kimi"]);
			if (lostCredentials) down(w, SOL);
			const spawn = await h.spawn(out!.input.tasks[0]!.agent, "sl-x--openai");
			if (lostCredentials) {
				expect(spawn?.block).toBe(true);
				expect(spawn?.reason).toContain("no openai model can review");
				expect(bodies(w, "hand-spawn:")).toEqual([]);
			} else {
				expect(spawn?.model).toEqual([SOL]);
				expect(spawn?.note).toContain("retained");
				expect(bodies(w, "headroom-skip:")).toEqual([]);
			}
		}
	});

	test("production review compares its configured review row, not a credentialed Claude from another tier", async () => {
		usePolls(...comparisonPolls());
		const w = world({ stakes: "production" });
		down(w, FABLE); // The deep review's Claude budget is Fable; the still-credentialed Opus cannot stand in.
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change", "production") }, "c1");
		expect(out?.block).toBeUndefined();
		expect(out?.input).toMatchObject({ name: "sl-x", agent: "deep" });
		const spawn = await h.spawn("deep", "sl-x");
		expect(spawn?.model).toEqual([K3]);
		expect(spawn?.note).not.toContain("retained");
		expect(bodies(w, "headroom-skip:").some(body => body.startsWith(`headroom-skip: ${SOL} `))).toBe(true);
	});

	test("panel planning retains its OpenAI leg without substituting another lab at the pinned spawn", async () => {
		for (const lostCredentials of [false, true]) {
			usePolls(...comparisonPolls());
			const w = world();
			const run = join(w.dir, "panel-run");
			mkdirSync(run);
			const files = { "packet.md": "Review the supplied change.", "schema.json": '{"type":"object"}', "synth.md": "Synthesize the findings." };
			const inputs: Record<string, string> = {};
			for (const [file, text] of Object.entries(files)) {
				writeFileSync(join(run, file), text);
				inputs[file] = createHash("sha256").update(text).digest("hex");
			}
			writeFileSync(join(run, "manifest.json"), JSON.stringify({
				version: 1,
				mode: "triad",
				workload: w.wl,
				slice: "sl-x",
				createdAt: new Date(RULE_END).toISOString(),
				repoAccess: false,
				repo: null,
				legSchema: "schema.json",
				synthPrompt: "synth.md",
				synthSchema: "schema.json",
				legTimeoutMin: { default: 60 },
				inputs,
				legInputs: { anthropic: ["packet.md"], openai: ["packet.md"], kimi: ["packet.md"] },
				synthInputs: [],
				withheld: [],
				canary: null,
			}));
			const h = lane(w);
			h.laneMessage(OPUS);
			const out = await h.toolCall({ agent: "strong", name: "sl-x", task: `${brief(w, "review the change")}\npanel: ${run}` }, "c1");
			expect(out?.block).toBeUndefined();
			expect(out?.input?.tasks.map(item => item.name)).toEqual(["sl-x--openai", "sl-x--kimi"]);
			if (lostCredentials) down(w, SOL);
			const spawn = await h.spawn(out!.input.tasks[0]!.agent, "sl-x--openai");
			if (lostCredentials) {
				expect(spawn?.block).toBe(true);
				expect(spawn?.reason).toContain("no other lab is substituted");
				expect(bodies(w, "hand-spawn:")).toEqual([]);
			} else {
				expect(spawn?.model).toEqual([SOL]);
				expect(spawn?.note).toContain("leg pinned to openai");
				expect(spawn?.note).toContain("retained");
				expect(bodies(w, "headroom-skip:")).toEqual([]);
			}
		}
	});

	test("Anthropic weekly overpace below .70 does not withhold Sonnet at dispatch or settlement", async () => {
		for (const windowId of ["7d", "1w"]) {
			usePolls(poll(1, [
				{ windowId: "5h", used: 0.1, resetsIn: 4 * HOUR },
				{ windowId, used: 0.69, resetsIn: 5 * 24 * HOUR },
				{ windowId, tier: "sonnet", used: 0.69, resetsIn: 5 * 24 * HOUR },
			]));
			// Put Sonnet first in this change-large row; admission must preserve both Anthropic entries.
			const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, standard: ROWS.standard.slice(1), strong: [SONNET, OPUS, SOL, KIMI] } } });
			const w = world({ table });
			const h = lane(w, { laneModel: SONNET });
			const build = await settled(h, w, "sl-work", "change the loader", SONNET, "c1");
			expect(build.spawn?.model).toEqual([SONNET, OPUS]);
			expect(build.spawn?.note ?? "").not.toContain("retained");
			expect(build.result).toBeUndefined();
			expect(bodies(w, "headroom-skip:")).toEqual([]);
			expect(bodies(w, "hand-spawn:")).toEqual([expect.stringContaining(` row ${SONNET},${OPUS}`)]);
			expect(questions(w)).toEqual([]);
		}
	});

	test("anthropic 5h at 0.85: a build on an anthropic lane is refused naming 0.85, with one headroom-skip: per anthropic entry", async () => {
		usePolls(poll(1, FIVE_HOUR_085));
		// Two anthropic entries in the strong row (Sonnet moved up from standard: a model sits in one tier).
		const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, standard: ROWS.standard.slice(1), strong: [OPUS, SONNET, SOL, KIMI] } } });
		const w = world({ table });
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change the loader") }, "c1");
		expect(out?.block).toBeUndefined();
		const spawn = await h.spawn(out!.input.agent, "sl-work");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain(`no usable strong model on the lane lab anthropic (${OPUS}): ${OPUS} (projected out: ${OUT_085}), ${SONNET} (projected out: ${OUT_085})`);
		expect(spawn?.reason).toContain("a build hand never runs on another lab");
		const entries = w.ledger.entries(w.wl).filter(e => e.body.startsWith("headroom-skip:"));
		expect(entries.map(e => e.body)).toEqual([
			expect.stringMatching(new RegExp(`^headroom-skip: ${OPUS} token dt-\\S+ ${OUT_085}$`)),
			expect.stringMatching(new RegExp(`^headroom-skip: ${SONNET} token dt-\\S+ ${OUT_085}$`)),
		]);
		expect(entries).toMatchObject([
			{ created_by: "lane-test", kind: "assumption", slice_id: "sl-work" },
			{ created_by: "lane-test", kind: "assumption", slice_id: "sl-work" },
		]);
		expect(new Set(entries.map(e => e.body.split(" ")[3])).size).toBe(1); // both by the refused hand's one token
		expect(bodies(w, "hand-spawn:")).toEqual([]);
		expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-work", outcome: "refused-no-usable-model" }]);
	});

	test("anthropic 5h at 0.85: a review on that workload spawns on a non-anthropic lab, and the spawn logs the skipped anthropic entry by its token", async () => {
		usePolls(poll(1, FIVE_HOUR_085));
		const w = world();
		const h = lane(w, { laneModel: SOL });
		h.laneMessage(SOL); // builders {openai}: anthropic would review but for the headroom
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.model).toEqual([KIMI]);
		expect(spawn?.note).toContain(`skipped ${OPUS} (projected out: ${OUT_085})`);
		const token = bodies(w, "hand-spawn:")[0]!.split(" ")[1]!;
		expect(bodies(w, "headroom-skip:")).toEqual([`headroom-skip: ${OPUS} token ${token} ${OUT_085}`]);
		const order = w.ledger.entries(w.wl).map(e => e.body.split(" ")[0]);
		expect(order.indexOf("headroom-skip:")).toBe(order.indexOf("hand-spawn:") - 1); // written in the spawn's transaction
	});

	test("anthropic 5h at 0.85: a review with no other lab left parks on the existing question, its reasons naming the headroom", async () => {
		usePolls(poll(1, FIVE_HOUR_085));
		const w = world();
		const h = lane(w, { laneModel: SOL });
		h.laneMessage(SOL);
		h.laneMessage(KIMI); // builders {openai, kimi}: only anthropic is left to review
		const spawn = await reviewSpawn(h, w);
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("no lab other than the builder's can review sl-x");
		expect(questions(w)).toHaveLength(1);
		expect(questions(w)[0]!.body).toContain(`${OPUS} (projected out: ${OUT_085})`);
		expect(bodies(w, "review-park:")).toHaveLength(1);
		expect(bodies(w, "headroom-skip:")).toEqual([expect.stringMatching(new RegExp(`^headroom-skip: ${OPUS} token dt-\\S+ ${OUT_085}$`))]);
	});

	test("anthropic 7d fable actually exhausted at 1.00: an Opus build still spawns; only a Fable build is refused", async () => {
		const fable = (used: number): Limit => ({ windowId: "7d", tier: "fable", used, resetsIn: 4 * 24 * HOUR });
		const shared: Limit[] = [
			{ windowId: "5h", used: 0.1, resetsIn: 2 * HOUR },
			{ windowId: "7d", used: 0.3, resetsIn: 4 * 24 * HOUR },
		];
		usePolls(poll(121, [...shared, fable(0.9)]), poll(1, [...shared, fable(1)]));
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const opus = await settled(h, w, "sl-work", "change the loader", OPUS, "c1");
		expect(opus.spawn?.model).toEqual([OPUS]);
		expect(opus.result).toBeUndefined();
		expect(bodies(w, "headroom-skip:")).toEqual([]);

		// The control: the same polls take Fable out (Fable and Opus swap tiers, so the strong build plans on Fable).
		const f = world({ table: tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [FABLE, SOL, KIMI], deep: [OPUS, ASTRA, K3] } } }) });
		const g = lane(f);
		g.laneMessage(FABLE);
		const out = await g.toolCall({ agent: "strong", name: "sl-work", task: brief(f, "change the loader") }, "c1");
		const spawn = await g.spawn(out!.input.agent, "sl-work");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain(`${FABLE} (projected out: anthropic 7d fable 1.00 used, window pace +`);
		expect(bodies(f, "headroom-skip:")).toEqual([expect.stringMatching(new RegExp(`^headroom-skip: ${FABLE} token dt-\\S+ anthropic 7d fable 1\\.00 used`))]);
	});

	test("stale polls (newest 30 min old) with anthropic 5h at 0.85: nothing is skipped", async () => {
		usePolls(poll(30, FIVE_HOUR_085));
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const build = await settled(h, w, "sl-work", "change the loader", OPUS, "c1");
		expect(build.spawn?.model).toEqual([OPUS]);
		const v = world();
		const r = lane(v, { laneModel: SOL });
		r.laneMessage(SOL);
		expect((await reviewSpawn(r, v))?.model).toEqual([OPUS, KIMI]);
		expect([...bodies(w, "headroom-skip:"), ...bodies(v, "headroom-skip:")]).toEqual([]);
	});
});

describe("Anthropic-out reviews on the current OpenAI lane", () => {
	const END = Date.parse("2026-10-31T06:00:00-07:00");
	const ACTIVE = END - 60_000;
	const NON_CODEX = "openai/fixture-review";
	const table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [...ROWS.strong, NON_CODEX] } } });
	const mixed = (w: World) => w.ledger.recordEntry({
		by: "lane-test", workloadId: w.wl, kind: "assumption",
		body: `builder-lab: anthropic hand dt-earlier-review model ${OPUS}`,
	});
	const codexWorld = (stakes: Stakes = "normal") => {
		const w = world({ stakes, table });
		w.creds.push(NON_CODEX);
		w.registry = fakeRegistry([...ALL, NON_CODEX], w.creds);
		return w;
	};
	const dispatch = (h: Lane, w: World, stakes: Stakes, name = "sl-x") =>
		h.toolCall({ agent: "strong", name, task: brief(w, "review the change", stakes) });
	const one = (out: Reply) => {
		expect(out?.block).toBeUndefined();
		const items = out!.input!.tasks ?? [out!.input!];
		expect(items).toHaveLength(1);
		return items[0]!;
	};

	for (const stakes of ["normal", "production"] as const) {
		for (const history of ["openai-only", "mixed", "granted"] as const) {
			test(`${stakes}: ${history} history uses only Codex even with every other provider usable`, async () => {
				const w = codexWorld(stakes);
				if (history !== "openai-only") mixed(w);
				if (history === "granted") {
					const q = w.ledger.raiseQuestion({ by: "lane-test", workloadId: w.wl, sliceId: "sl-x", body: "Review same-lab?", options: ["same-lab", "wait"] });
					w.ledger.recordEntry({ by: "lane-test", workloadId: w.wl, sliceId: "sl-x", kind: "assumption", body: `review-park: ${q} slice sl-x` });
					w.ledger.answerQuestion(q, { by: SURFACE_BY, author: JO_HOLDER, answer: "same-lab", channel: "surface" });
				}
				const h = lane(w, { now: () => ACTIVE, laneModel: SOL });
				const item = one(await dispatch(h, w, stakes));
				const spawn = await h.spawn(item.agent, item.name);
				expect(spawn?.model).toEqual([SOL]);
				expect(spawn?.note).toContain("in-mvtur7tlze7r5o");
				expect(spawn?.note).not.toContain("kimi leg missing");
				const entries = w.ledger.entries(w.wl);
				const at = entries.findIndex(e => e.body.startsWith("review-same-lab-rule: in-mvtur7tlze7r5o"));
				expect(at).toBeGreaterThanOrEqual(0);
				expect(entries[at]!.body).toContain("labs openai anthropic-out until 2026-10-31T06:00:00-07:00");
				expect(entries[at + 1]!.body).toStartWith("hand-spawn:");
				expect(entries[at + 1]!.created_by).toBe(entries[at]!.created_by);
				h.handMessage(item.name, SOL);
				expect(h.results("call-1", [{ id: item.name, agent: item.agent, model: SOL }])?.isError).not.toBe(true);
				expect(w.ledger.routings(w.wl).at(-1)?.models).toBe(JSON.stringify([SOL]));
				expect(questions(w).filter(q => q.state === "open")).toEqual([]);
				expect(bodies(w, "review-same-lab:")).toEqual([]);
			});
		}

		for (const unavailable of ["absent-inventory", "absent-row", "credentials", "disabled", "refused", "quota"] as const) {
			test(`${stakes}: ${unavailable} Codex fails visibly without widening or a cross-lab park`, async () => {
				const w = codexWorld(stakes);
				if (unavailable === "absent-inventory") w.registry = fakeRegistry(ALL.filter(m => !m.startsWith("openai-codex/")), w.creds);
				if (unavailable === "absent-row") w.table = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [OPUS, KIMI, NON_CODEX] } } });
				if (unavailable === "credentials") down(w, SOL);
				if (unavailable === "refused") w.ledger.recordEntry({ by: "lane-test", workloadId: w.wl, kind: "assumption", body: "provider-refused: openai-codex status 401 token dt-login" });
				const saved = process.env.AS2_HEADROOM_POLLS;
				try {
					if (unavailable === "quota") {
						const path = join(w.dir, "polls.jsonl");
						writeFileSync(path, `${JSON.stringify({ t: (ACTIVE - 60_000) / 1000, rows: {}, limits: [{ provider: "openai-codex", windowId: "5h", tier: null, resetsAt: ACTIVE + 4.9 * 3_600_000, usedFraction: 0.85 }] })}\n`);
						process.env.AS2_HEADROOM_POLLS = path;
					}
					const h = lane(w, { now: () => ACTIVE, laneModel: SOL, disabledProviders: unavailable === "disabled" ? ["openai-codex"] : [] });
					const out = await dispatch(h, w, stakes);
					const spawn = out?.block ? out : await h.spawn(one(out).agent, "sl-x");
					expect(spawn?.block).toBe(true);
					expect(spawn?.reason).toContain("Anthropic-out");
					expect(spawn?.reason).toContain("Codex");
					if (unavailable === "credentials") expect(spawn?.reason).toContain("no credentials");
					if (unavailable === "disabled") expect(spawn?.reason).toContain("provider disabled");
					if (unavailable === "refused") expect(spawn?.reason).toContain("status 401");
					if (unavailable === "quota") expect(spawn?.reason).toContain("projected out");
					expect(spawn?.model).toBeUndefined();
					expect(bodies(w, "hand-spawn:")).toEqual([]);
					expect(bodies(w, "review-same-lab-rule:")).toEqual([]);
					expect(bodies(w, "review-park:")).toEqual([]);
					expect(questions(w)).toEqual([]);
				} finally {
					if (saved === undefined) delete process.env.AS2_HEADROOM_POLLS;
					else process.env.AS2_HEADROOM_POLLS = saved;
				}
			});
		}
	}

	test("the settle allowlist rejects Anthropic and non-Codex OpenAI answers", async () => {
		for (const rogue of [OPUS, KIMI, NON_CODEX]) {
			const w = codexWorld();
			const h = lane(w, { now: () => ACTIVE, laneModel: SOL });
			expect((await reviewSpawn(h, w))?.model).toEqual([SOL]);
			h.handMessage("sl-x", rogue);
			expect(h.results("rev-1", [{ id: "sl-x", agent: "strong", model: rogue }])?.isError).toBe(true);
			expect(w.ledger.routings(w.wl).at(-1)).toMatchObject({ outcome: "refused-out-of-row", models: JSON.stringify([SOL]) });
		}
	});

	test("unknown builder provenance remains fail-closed under the dated rule", async () => {
		const w = codexWorld();
		w.ledger.recordEntry({ by: "lane-runner", workloadId: w.wl, kind: "assumption", body: 'lane-started: lane-unknown {"pid":2}' });
		const h = lane(w, { now: () => ACTIVE, laneModel: SOL });
		expect((await reviewSpawn(h, w))?.block).toBe(true);
		expect(bodies(w, "hand-spawn:")).toEqual([]);
		expect(bodies(w, "review-same-lab-rule:")).toEqual([]);
	});

	test("exact expiry restores ordinary Anthropic routing and builds stay lane-lab restricted", async () => {
		// Date-boundary behavior uses the injected now value, never elapsed wall time.
		for (const now of [END - 1, END, END + 1]) {
			const w = codexWorld();
			const h = lane(w, { now: () => now, laneModel: SOL });
			const spawn = await reviewSpawn(h, w);
			expect(spawn?.model).toEqual(now < END ? [SOL] : [OPUS, KIMI]);
		}
		for (const laneModel of [SOL, OPUS]) {
			const w = codexWorld();
			const h = lane(w, { now: () => ACTIVE, laneModel });
			const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change the code") });
			expect((await h.spawn(out!.input!.agent, "sl-work"))?.model).toEqual(laneModel === SOL ? [SOL, NON_CODEX] : [OPUS]);
		}
	});

	test("current lane scope wins over mixed builder history and model switches before spawn", async () => {
		for (const switchToOpenai of [true, false]) {
			const w = codexWorld();
			mixed(w);
			const h = lane(w, { now: () => ACTIVE, laneModel: switchToOpenai ? OPUS : SOL });
			const item = one(await dispatch(h, w, "normal"));
			h.setLaneModel(switchToOpenai ? SOL : OPUS);
			expect((await h.spawn(item.agent, item.name))?.model).toEqual(switchToOpenai ? [SOL] : [KIMI]);
		}
	});

	test("a production fan-out published on Anthropic cannot reuse its Kimi pin after an OpenAI lane switch", async () => {
		const w = codexWorld("production");
		const h = lane(w, { now: () => ACTIVE, laneModel: OPUS });
		const out = await dispatch(h, w, "production");
		expect(out!.input!.tasks.map(t => t.name)).toEqual(["sl-x--openai", "sl-x--kimi"]);
		h.setLaneModel(SOL);
		expect((await h.spawn("deep", "sl-x--kimi"))?.block).toBe(true);
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([SOL]);
		expect(questions(w)).toEqual([]);
	});

	test("production preflight before expiry rechecks ordinary policy at spawn", async () => {
		// Move the injected now value across expiry between preflight and spawn.
		let now = ACTIVE;
		const w = codexWorld("production");
		const h = lane(w, { now: () => now, laneModel: SOL });
		const item = one(await dispatch(h, w, "production"));
		now = END;
		expect((await h.spawn(item.agent, item.name))?.model).toEqual([FABLE, K3]);
		expect(bodies(w, "review-same-lab-rule:")).toEqual([]);
	});

	test("dated same-lab authorization preserves read-only tools and fingerprint withholding", async () => {
		const w = codexWorld();
		const h = lane(w, { now: () => ACTIVE, laneModel: SOL });
		expect((await reviewSpawn(h, w))?.model).toEqual([SOL]);
		for (const tool of ["edit", "write", "ast_edit"]) expect((await h.handTool("sl-x", tool))?.block).toBe(true);
		expect(await h.handTool("sl-x", "read")).toBeUndefined();
		writeFileSync(join(w.repo, "a.txt"), "changed by the review\n");
		h.handMessage("sl-x", SOL);
		const result = h.results("rev-1", [{ id: "sl-x", agent: "strong", model: SOL }]);
		expect(result?.isError).toBe(true);
		expect(result?.content?.[0]?.text).toContain("the review changed the work");
		expect(bodies(w, "review-withheld:")).toHaveLength(1);
	});

	test("dated same-lab authorization cannot bypass the review round limit", async () => {
		const w = codexWorld();
		roundsLimit(w, 1);
		const h = lane(w, { now: () => ACTIVE, laneModel: SOL });
		await reviewRound(h, w, "first", blocking("a blocking correctness finding"));
		expect(questions(w).filter(q => q.options.includes("extend"))).toHaveLength(1);
		expect((await dispatch(h, w, "normal"))?.block).toBe(true);
		expect(bodies(w, "hand-spawn:")).toHaveLength(1);
		expect(bodies(w, "review-same-lab-rule: in-mvtur7tlze7r5o")).toHaveLength(1);
	});

	for (const stakes of ["normal", "production"] as const) {
		for (const boundary of ["credentials-await", "spawn-transaction"] as const) {
			test(`${stakes}: expiry during ${boundary} refuses stale policy, then a fresh post-expiry dispatch admits Anthropic`, async () => {
				// Move the injected now value across expiry at the admission boundary.
				let now = ACTIVE;
				const w = codexWorld(stakes);
				const h = lane(w, { now: () => now, laneModel: SOL });
				const item = one(await dispatch(h, w, stakes));
				if (boundary === "credentials-await") {
					const getApiKey = w.registry.getApiKey.bind(w.registry);
					w.registry.getApiKey = async (m, s) => { now = END; return getApiKey(m, s); };
				} else {
					const write = w.ledger.write.bind(w.ledger);
					w.ledger.write = ((fn: () => unknown) => { now = END; return write(fn); }) as Ledger["write"];
				}
				const spawn = await h.spawn(item.agent, item.name);
				expect(spawn?.block).toBe(true);
				expect(spawn?.reason).toContain("policy changed");
				expect(bodies(w, "review-same-lab-rule:")).toEqual([]);
				expect(bodies(w, "hand-spawn:")).toEqual([]);
				expect(questions(w)).toEqual([]);
				const out = await dispatch(h, w, stakes, "sl-y");
				expect(out?.block).toBeUndefined();
				const fresh = (out!.input!.tasks ?? [out!.input!])[0]!;
				expect((await h.spawn(fresh.agent, fresh.name))?.model).toEqual(stakes === "normal" ? [OPUS, KIMI] : [FABLE]);
			});
		}
	}
});
