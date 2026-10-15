/**
 * The review defects PLAN wl-muq13bkdghblmo steps 7-9 and 12 fix, end to end (T12, T13, T14, T18): a
 * commit in another worktree no longer withholds a review; a review hand that dies on a provider
 * error is a failed dispatch, not a round; a provider that refused the login is routed around; and
 * a stale `async-result` delivery left in a resumed lane session never settles a new hand that OMP
 * gave the same agent id. The classifier extension on a fake OMP host with a real temp ledger and a
 * real git repository, the crosslab harness.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, Ledger, type Stakes } from "../../ledger/src/index";
import { SURFACE_BY } from "../../surface/src/types";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { countRounds, parseReviewRound, type ReviewRoundEntry } from "../src/rounds";
import { tierTableFromConfig } from "../src/tier-table";
import { currentModel, DEFAULT_LANE_MODEL, dist, type FakeRegistry, fakeRegistry, recordedQuestion } from "./helpers";
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

/** `review…` briefs are judge 0.9; anything else change-large 0.9. */
function answer(brief: string) {
	const task = /^task: (.*)$/m.exec(brief)?.[1] ?? "";
	if (task.startsWith("review")) return { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) };
	return { choice: "change-large", confidence: 0.9, probabilities: dist({ "change-large": 0.9 }) };
}
const JUDGE = { judge: async ({ state }: { state: string }) => ({ answers: { kind: answer(state) }, provider: "typesafe", model: "jev-1.13.0" }) };

const dirs: string[] = [];
afterEach(() => {
	setSystemTime();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

interface World {
	dir: string;
	ledger: Ledger;
	wl: string;
	repo: string;
	laneFile: string;
	root: string;
	/** The credentialed models; edit it to take a lab down. */
	creds: string[];
	registry: FakeRegistry;
}

/** A workload on a temp ledger, the lane's repository, its session file, and a mutable registry. */
function world(opts: { stakes?: Stakes } = {}): World {
	const dir = tmpDir("review-defects-");
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-defects", brief: "review defects test", stakes: opts.stakes ?? "normal", mode: "autonomous", by: "orch-test" });
	ledger.addSlice({ id: "sl-x", workloadId: wl, task: "sl-x", doneCondition: "d", inputs: "i", by: "lane-test" });
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: 'lane-started: lane-test {"pid":1}' });
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
	return { dir, ledger, wl, repo, laneFile, root: laneFile.slice(0, -".jsonl".length), creds, registry: fakeRegistry(ALL, creds) };
}

const brief = (w: World) => `workload: ${w.wl}\ntask: review the change\ndone-condition: d\ninputs: i\nstakes: normal\nceiling-share: 10`;

/** An `async-result` delivery for one task job (session/async-job-delivery.ts), stamped `timestamp`. */
interface Delivery {
	role: "custom";
	customType: "async-result";
	content: string;
	display: boolean;
	details: { jobs: { jobId: string; type: string; label: string; durationMs: number }[] };
	timestamp: number;
}
const delivery = (agentId: string, text: string, timestamp = Date.now()): Delivery => ({
	role: "custom",
	customType: "async-result",
	content: text,
	display: true,
	details: { jobs: [{ jobId: agentId, type: "task", label: agentId, durationMs: 1 }] },
	timestamp,
});

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Reply = { block?: boolean; reason?: string; input?: { agent: string; tasks?: { name: string; agent: string }[] }; model?: string[] } | undefined;
type ToolReply = { isError?: boolean; content?: { text: string }[] } | undefined;
/** How a hand's assistant turn ended: answered, or a provider error with its HTTP status. */
type Turn = { error?: number };

interface Lane {
	toolCall(toolCallId: string): Promise<Reply>;
	spawn(spawnKey: string, agent?: string): Promise<Reply>;
	laneMessage(selector: string): void;
	handMessage(agentId: string, selector: string, turn?: Turn): void;
	asyncReturned(toolCallId: string, id: string): void;
	/** A blocking task call returns with one strong result for `id`. */
	results(toolCallId: string, id: string, model: string, output: string): ToolReply;
	/** A blocking task call returns with these results (a production fan-out's members run on `deep`). */
	resultsOf(toolCallId: string, results: { id: string; agent: string; model: string; output: string }[]): ToolReply;
	/** The lane's context carries these deliveries; returns each one's text as the model is sent it. */
	context(...messages: Delivery[]): string[];
}

/** One lane process: the classifier bound to the lane's session and to its hands' sessions. A second `lane(w)` is a restart. */
function lane(w: World): Lane {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => w.ledger,
		laneId: "lane-test",
		boundWorkload: () => w.wl,
		// No lost-hand settle here: every recorded omp is alive (snapshot-settle.test.ts T10 drives the rule).
		ompState: () => "same",
		lastWrite: () => null,
		log: () => {},
		// After Jo's Kimi-out rule ends (PLAN wl-mv5xay6bjp0268 § 2.5): these tests keep today's park behaviour.
		now: () => Date.parse("2026-11-01T00:00:00-07:00"),
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.repo, modelRegistry: w.registry, model: currentModel(DEFAULT_LANE_MODEL), sessionManager: { getSessionFile: () => w.laneFile } };
	const assistant = (selector: string, turn: Turn = {}) => {
		const [provider, ...model] = selector.split("/");
		const failed = turn.error === undefined ? { stopReason: "stop" } : { stopReason: "error", errorStatus: turn.error, errorMessage: `${turn.error} permission_error` };
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [], ...failed } };
	};
	return {
		toolCall: toolCallId => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input: { agent: "strong", name: "sl-x", task: brief(w) } }, ctx) as Promise<Reply>,
		spawn: (spawnKey, agent = "strong") => handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<Reply>,
		laneMessage: selector => void handlers.message_end!(assistant(selector), ctx),
		handMessage: (agentId, selector, turn) =>
			void handSession.message_end!(assistant(selector, turn), { ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } }),
		asyncReturned: (toolCallId, id) =>
			void handlers.tool_result!(
				{ type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [], details: { async: { state: "running", jobId: "j", type: "task" }, progress: [{ index: 0, id, status: "running" }] } },
				ctx,
			),
		results: (toolCallId, id, model, output) =>
			handlers.tool_result!(
				{ type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [], details: { results: [{ id, agent: "strong", resolvedModelIdentity: model, output }] } },
				ctx,
			) as ToolReply,
		resultsOf: (toolCallId, results) =>
			handlers.tool_result!(
				{
					type: "tool_result",
					toolName: "task",
					toolCallId,
					isError: false,
					input: {},
					content: [],
					details: { results: results.map(r => ({ id: r.id, agent: r.agent, resolvedModelIdentity: r.model, output: r.output })) },
				},
				ctx,
			) as ToolReply,
		context: (...messages) => {
			const result = handlers.context!({ type: "context", messages }, ctx) as { messages?: Delivery[] } | undefined;
			return (result?.messages ?? messages).map(m => String(m.content));
		},
	};
}

const bodies = (w: World, prefix = "") => w.ledger.entries(w.wl).map(e => e.body).filter(b => b.startsWith(prefix));
const rounds = (w: World): ReviewRoundEntry[] => bodies(w, "review-round:").map(b => parseReviewRound(b)!);
const spawnTokens = (w: World) => bodies(w, "hand-spawn:").map(b => b.split(" ")[1]!);

const reply = (...findings: { severity: string; kind: string; title: string }[]) =>
	`Reviewed the change.\n\n\`\`\`review-findings\n${JSON.stringify({ findings })}\n\`\`\`\n`;
const CLEAN = reply();

/** A blocking review of sl-x on call `call` up to its spawn reply, by a lane that built on anthropic. */
async function blockingReview(h: Lane, call: string): Promise<Reply> {
	expect((await h.toolCall(call))?.reason).toBeUndefined();
	return h.spawn("sl-x");
}

describe("defect 1: a commit in another worktree does not withhold a review (T12)", () => {
	test("the round is accepted, with no review-withheld: and no builder mark", async () => {
		const w = world();
		git(w.repo, "worktree", "add", "-q", join(w.dir, "other"), "-b", "other");
		const h = lane(w);
		h.laneMessage(OPUS);
		expect((await blockingReview(h, "rev-1"))?.model).toEqual([SOL, KIMI]);
		writeFileSync(join(w.dir, "other", "b.txt"), "elsewhere\n");
		git(join(w.dir, "other"), "add", "-A");
		git(join(w.dir, "other"), "commit", "-q", "-m", "work in another lane");
		h.handMessage("sl-x", SOL);
		expect(h.results("rev-1", "sl-x", SOL, CLEAN)).toBeUndefined();
		expect(rounds(w).map(r => r.verdict)).toEqual(["accepted"]);
		expect(bodies(w, "review-withheld:")).toEqual([]);
		expect(bodies(w, "builder-lab:").filter(b => b.includes(" hand "))).toEqual([]);
	});
});

describe("defect 2: a review hand that dies on a provider error is a failed dispatch (T13)", () => {
	test("its row records the failure, its verdict is failed-dispatch, no round is counted, and the next dispatch is round 1 again", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await blockingReview(h, "rev-1");
		h.handMessage("sl-x", SOL, { error: 403 });
		const out = h.results("rev-1", "sl-x", SOL, "");
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain("provider error");
		expect(w.ledger.routings(w.wl).map(r => [r.outcome, r.ran_models])).toEqual([["refused-model-unknown", null]]);
		expect(rounds(w).map(r => [r.round, r.verdict])).toEqual([[1, "failed-dispatch"]]);
		const count = countRounds(w.ledger.entries(w.wl), "sl-x");
		expect([count.rounds.length, count.failed, count.next]).toEqual([0, 0, 1]);
		expect(bodies(w, "builder-lab:").filter(b => b.includes(" hand "))).toEqual([]);
		expect(w.ledger.questions(w.wl)).toEqual([]);
		expect((await blockingReview(h, "rev-2"))?.reason).toBeUndefined();
		expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds.map(r => [r.n, r.group])).toEqual([[1, bodies(w, "hand-spawn:")[1]!.split(" group ")[1]!.split(" ")[0]!]]);
	});

	test("control: an error turn and then an answering turn settles as today", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await blockingReview(h, "rev-1");
		h.handMessage("sl-x", SOL, { error: 429 });
		h.handMessage("sl-x", KIMI);
		expect(h.results("rev-1", "sl-x", KIMI, CLEAN)).toBeUndefined();
		expect(w.ledger.routings(w.wl).map(r => [r.outcome, r.ran_models])).toEqual([["ran", JSON.stringify([KIMI])]]);
		expect(rounds(w).map(r => r.verdict)).toEqual(["accepted"]);
		expect(bodies(w, "provider-refused:")).toEqual([]);
	});

	test("review r1 finding 3: a production fan-out whose members all fail to dispatch counts no round and parks nothing; the next dispatch is accepted", async () => {
		const w = world({ stakes: "production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		const fan = async (call: string) => {
			const out = await h.toolCall(call);
			expect(out?.input?.tasks?.map(t => t.name)).toEqual(["sl-x--openai", "sl-x--kimi"]);
			expect((await h.spawn("sl-x--openai", "deep"))?.model).toEqual([SOL]);
			expect((await h.spawn("sl-x--kimi", "deep"))?.model).toEqual([K3]);
		};
		await fan("rev-1");
		h.handMessage("sl-x--openai", SOL, { error: 429 });
		h.handMessage("sl-x--kimi", K3, { error: 429 });
		const out = h.resultsOf("rev-1", [
			{ id: "sl-x--openai", agent: "deep", model: SOL, output: "" },
			{ id: "sl-x--kimi", agent: "deep", model: K3, output: "" },
		]);
		expect(out?.isError).toBe(true);
		expect(rounds(w).map(r => [r.round, r.verdict])).toEqual([
			[1, "failed-dispatch"],
			[1, "failed-dispatch"],
		]);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds).toEqual([]);
		expect(w.ledger.questions(w.wl)).toEqual([]);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(bodies(w, "review-limit:")).toEqual([]);
		await fan("rev-2");
		expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds.map(r => [r.n, r.complete])).toEqual([[1, false]]);
	});
});

describe("defect 3: a provider that refused the login is routed around (T14)", () => {
	/** A review whose only turn got a 403 from openai-codex; `kimiDown` leaves openai the only non-builder lab. */
	async function refused(kimiDown: boolean): Promise<{ w: World; h: Lane }> {
		const w = world();
		if (kimiDown) w.creds.splice(w.creds.indexOf(KIMI), 1);
		const h = lane(w);
		h.laneMessage(OPUS);
		await blockingReview(h, "rev-1");
		h.handMessage("sl-x", SOL, { error: 403 });
		h.results("rev-1", "sl-x", SOL, "");
		expect(bodies(w, "provider-refused:")).toEqual([`provider-refused: openai-codex status 403 token ${spawnTokens(w)[0]}`]);
		return { w, h };
	}

	test("the next review routes to a non-builder lab on another provider", async () => {
		const { h } = await refused(false);
		expect((await blockingReview(h, "rev-2"))?.model).toEqual([KIMI]);
	});

	test("with that provider's lab the only non-builder lab, the review parks, and the question says why", async () => {
		const { w, h } = await refused(true);
		const spawn = await blockingReview(h, "rev-2");
		expect(spawn?.block).toBe(true);
		expect(bodies(w, "review-park:")).toHaveLength(1);
		expect(w.ledger.questions(w.wl).map(q => q.body)).toEqual([expect.stringContaining("refused on")]);
	});

	test("a provider-ok: from the surface re-enables it; the same body from a lane does not", async () => {
		for (const by of [SURFACE_BY, "lane-test"]) {
			const { w, h } = await refused(true);
			w.ledger.recordEntry({ by, workloadId: w.wl, kind: "assumption", body: "provider-ok: openai-codex by in-test" });
			const spawn = await blockingReview(h, "rev-2");
			if (by === SURFACE_BY) expect(spawn?.model).toEqual([SOL]);
			else expect(spawn?.block).toBe(true);
		}
	});
});

describe("defect 5: a stale delivery never settles a new hand with the same agent id (T18)", () => {
	/** Review hand H2 on sl-x, async, that OMP allocates as agent `sl-x-2`. */
	async function spawnH2(h: Lane, call: string): Promise<void> {
		expect((await h.toolCall(call))?.reason).toBeUndefined();
		h.asyncReturned(call, "sl-x-2");
		expect((await h.spawn("sl-x-2"))?.model).toEqual([SOL, KIMI]);
	}

	test("the incident's shape: an earlier job's delivery with no row is withheld as before, and H2 settles once on its own delivery", async () => {
		const w = world();
		const h = lane(w); // the resumed lane session
		h.laneMessage(OPUS);
		const d1 = delivery("sl-x-2", "SECRET-OUTPUT of an earlier job", Date.now() - 60_000);
		const [before] = h.context(d1);
		expect(before).toContain("refused this async task result");
		await spawnH2(h, "c1");
		expect(h.context(d1)).toEqual([before!]);
		expect(w.ledger.routings(w.wl)).toEqual([]);
		expect(bodies(w, "hand-settled:")).toEqual([]);
		expect(rounds(w)).toEqual([]);

		h.handMessage("sl-x-2", SOL);
		const d2 = delivery("sl-x-2", CLEAN);
		expect(h.context(d1, d2)).toEqual([before!, CLEAN]);
		expect(w.ledger.routings(w.wl).map(r => [r.agent_id, r.outcome])).toEqual([["sl-x-2", "ran"]]);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
		expect(rounds(w).map(r => [r.token, r.verdict])).toEqual([[spawnTokens(w)[0]!, "accepted"]]);
		expect(h.context(d1, d2)).toEqual([before!, CLEAN]);
		expect(lane(w).context(d1, d2)).toEqual([before!, CLEAN]); // a restart reads the same from the ledger
		expect(w.ledger.routings(w.wl)).toHaveLength(1);
		expect(rounds(w)).toHaveLength(1);
	});

	test("a settled H1's delivery never settles H2, and H1 keeps its verdict; in a resumed instance and in the same one", async () => {
		for (const resumed of [true, false]) {
			const w = world();
			const first = lane(w);
			first.laneMessage(OPUS);
			expect((await first.toolCall("c1"))?.reason).toBeUndefined();
			first.asyncReturned("c1", "sl-x-2");
			await first.spawn("sl-x-2");
			first.handMessage("sl-x-2", OPUS); // off its row: H1 is withheld
			const d1 = delivery("sl-x-2", "SECRET-OUTPUT of H1");
			const [withheld] = first.context(d1);
			expect(withheld).toContain("refused this async task result");
			setSystemTime(new Date(Date.now() + 1000)); // H2 is dispatched a second after D1 was delivered
			const h = resumed ? lane(w) : first;
			await spawnH2(h, "c2");
			const h2 = spawnTokens(w)[1]!;
			// H1's verdict: from memory in the same instance, from its routing row in a resumed one.
			const [again] = h.context(d1);
			expect(again).toContain("refused this async task result: sl-x-2");
			expect(again).toContain(OPUS);
			expect(again).not.toContain("SECRET-OUTPUT");
			expect(rounds(w).map(r => r.verdict)).toEqual(["withheld"]);
			expect(bodies(w, "hand-settled:").filter(b => b.includes(h2))).toEqual([]);
			expect(rounds(w).filter(r => r.token === h2)).toEqual([]);
			expect(w.ledger.routings(w.wl)).toHaveLength(1);
		}
	});
});
