/**
 * Z.ai balance empty (PLAN wl-mw148irbq33zt5 D4, R7–R9, R14): a zai review turn that ends on HTTP 429 with Z.ai's code
 * 1113 ("Insufficient balance or no resource package. Please recharge.") in either shape OMP was observed to carry
 * (PLAN § 1: the anthropic route's JSON body, the openai route's `(type=1113)` suffix). The classifier extension on a
 * fake OMP host with a real temp ledger and a real git repository, as classifier/test/crosslab.test.ts drives it.
 * Bodies the change adds are literals, and `isZaiBalanceEmpty` is read off the module namespace, so this file loads on
 * the tree before the change and fails there on assertions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type Stakes } from "../../ledger/src/index";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import * as lab from "../src/lab";
import { parseReviewRound } from "../src/rounds";
import { tierTableFromConfig } from "../src/tier-table";
import { currentModel, DEFAULT_LANE_MODEL, dist, fakeRegistry, recordedQuestion } from "./helpers";

const OPUS = "anthropic/claude-opus-5-5";
const GLM = "zai/glm-5.3";
const SOL = "openai-codex/gpt-6.1-sol";
const FABLE = "anthropic/claude-fable-5-1";
// The profile's shape (PLAN D2): zai second in fast, standard and strong, before openai-codex; deep has no zai entry.
const ROWS = {
	fast: ["anthropic/claude-haiku-5-5", "zai/glm-5.3-flash", "openai-codex/gpt-5.6-luna"],
	standard: ["anthropic/claude-sonnet-5-5", "zai/glm-5.3-flashx", "openai-codex/gpt-6-luna"],
	strong: [OPUS, GLM, SOL],
	deep: [FABLE, "openai-codex/gpt-6-astra"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();

// Z.ai's documented 429 codes (https://docs.z.ai/api-reference/api-code.md) in the two shapes the probe saw (PLAN § 1).
const BALANCE = "Insufficient balance or no resource package. Please recharge.";
const RATE = "Rate limit reached for requests";
const shapeA = (code: string, text: string) => `429 {"error":{"code":"${code}","message":"${text}"}}`;
const shapeB = (code: string, text: string) => `429 ${text}\n${text} (type=${code})`;
const SHAPES = { "A (anthropic route)": shapeA("1113", BALANCE), "B (openai route)": shapeB("1113", BALANCE) };
const BALANCE_REASON = "Z.ai balance empty: HTTP 429 code 1113";
const BILLING = "https://z.ai/manage-apikey/billing";

const JUDGE = {
	judge: async () => ({ answers: { kind: { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) } }, provider: "typesafe", model: "jev-1.13.0" }),
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A workload on a temp ledger, the lane's repository and its session file; every model offered and credentialed. */
function world(stakes: Stakes = "normal") {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "zai-balance-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-zai", brief: "zai balance test", stakes, mode: "autonomous", by: "orch-test" });
	for (const id of ["sl-x", "sl-y"]) ledger.addSlice({ id, workloadId: wl, task: id, doneCondition: "d", inputs: "i", by: "lane-test" });
	ledger.recordEntry({ by: "lane-runner", workloadId: wl, kind: "assumption", body: 'lane-started: lane-test {"pid":1}' });
	const repo = join(dir, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "init");
	mkdirSync(join(dir, "sessions"));
	const laneFile = join(dir, "sessions", "lane.jsonl");
	writeFileSync(laneFile, "");
	return { ledger, wl, repo, laneFile, root: laneFile.slice(0, -".jsonl".length), registry: fakeRegistry(ALL, ALL) };
}
type World = ReturnType<typeof world>;

const brief = (w: World, task: string, stakes: Stakes = "normal") =>
	`workload: ${w.wl}\ntask: ${task}\ndone-condition: d\ninputs: i\nstakes: ${stakes}\nceiling-share: 10\n## How it fails\n- the review hand fails: its failure reaches the ledger; redispatch once`;

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Item = { agent: string; name: string; task?: string };
type Reply = { block?: boolean; reason?: string; input?: Item & { tasks: Item[] }; model?: string[]; note?: string } | undefined;
type Result = { isError?: boolean; content?: { text: string }[] } | undefined;
type ErrorTurn = { status: number; message: string };

/** Jo's Kimi-out rule ended at this instant; the lane's clock sits there, as crosslab.test.ts's default does. */
const RULE_END = Date.parse("2026-11-01T00:00:00-07:00");

/** One lane process: the classifier bound to the lane's session and its hands' sessions. `ledger`: what the extension writes through. */
function lane(w: World, ledger: () => Ledger = () => w.ledger) {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const logs: string[] = [];
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger,
		laneId: "lane-test",
		boundWorkload: () => w.wl,
		ompState: () => "same",
		lastWrite: () => null,
		log: line => logs.push(line),
		now: () => RULE_END,
		spawnMoveAlert: () => null,
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.repo, modelRegistry: w.registry, model: currentModel(DEFAULT_LANE_MODEL), sessionManager: { getSessionFile: () => w.laneFile } };
	const handCtx = (agentId: string) => ({ ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } });
	const assistant = (selector: string, error?: ErrorTurn) => {
		const [provider, ...model] = selector.split("/");
		const failed = error ? { stopReason: "error", errorStatus: error.status, errorMessage: error.message } : { stopReason: "stop" };
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [], ...failed } };
	};
	return {
		logs,
		laneMessage: (selector: string) => handlers.message_end!(assistant(selector), ctx),
		toolCall: (input: unknown, toolCallId: string) => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
		spawn: (agent: string, spawnKey: string) =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<Reply>,
		/** An assistant turn in hand `agentId`'s own session; `error`: the turn ended on that provider error. */
		handMessage: (agentId: string, selector: string, error?: ErrorTurn) => handSession.message_end!(assistant(selector, error), handCtx(agentId)),
		results: (toolCallId: string, results: { id: string; agent: string; model: string; output: string }[]) =>
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
			) as Result,
	};
}
type Lane = ReturnType<typeof lane>;

const CLEAN = 'Reviewed the change.\n\n```review-findings\n{"findings":[]}\n```\n';
const bodies = (w: World, prefix: string) => w.ledger.entries(w.wl).map(e => e.body).filter(b => b.startsWith(prefix));
const rounds = (w: World) => bodies(w, "review-round:").map(b => parseReviewRound(b)!);
const tokens = (w: World) => bodies(w, "hand-spawn:").map(b => b.split(" ")[1]!);
const openQuestions = (w: World) => w.ledger.questions(w.wl).filter(q => q.state === "open");
const messages = (w: World) =>
	w.ledger.db.query<{ recipient: string; sender: string; body: string }, [string]>("SELECT recipient, sender, body FROM messages WHERE workload_id = ? ORDER BY created_at, rowid").all(w.wl);
const text = (r: Result) => r?.content?.map(c => c.text).join("\n") ?? "";

/** A normal-stakes review of `slice` by an Anthropic lane, up to its spawn; its spawn row is GLM first, OpenAI after. */
async function reviewSpawn(h: Lane, w: World, slice: string, call: string) {
	const out = await h.toolCall({ agent: "strong", name: slice, task: brief(w, "review the change") }, call);
	expect(out?.block).toBeUndefined();
	const spawn = await h.spawn(out!.input!.agent, slice);
	expect(spawn?.model).toEqual([GLM, SOL]);
	return out!.input!.agent;
}

describe("isZaiBalanceEmpty (D4): code 1113 on a zai 429 in either shape; the status alone never decides", () => {
	const isZaiBalanceEmpty = (lab as Record<string, unknown>).isZaiBalanceEmpty as ((provider: string, status: number | null, message: string | null) => boolean) | undefined;

	test("true for zai, 429 and 1113 in shape A or B", () => {
		expect(typeof isZaiBalanceEmpty).toBe("function");
		for (const message of Object.values(SHAPES)) expect(isZaiBalanceEmpty!("zai", 429, message)).toBe(true);
	});

	test("false for 1302, a bare 429, another status, another provider, or no message", () => {
		expect(typeof isZaiBalanceEmpty).toBe("function");
		for (const message of [shapeA("1302", RATE), shapeB("1302", RATE), "429 Too Many Requests", shapeA("11130", BALANCE)]) expect(isZaiBalanceEmpty!("zai", 429, message)).toBe(false);
		expect(isZaiBalanceEmpty!("zai", 500, shapeA("1113", BALANCE))).toBe(false);
		expect(isZaiBalanceEmpty!("zai", null, shapeA("1113", BALANCE))).toBe(false);
		expect(isZaiBalanceEmpty!("openai-codex", 429, shapeA("1113", BALANCE))).toBe(false);
		expect(isZaiBalanceEmpty!("moonshot", 429, shapeB("1113", BALANCE))).toBe(false);
		expect(isZaiBalanceEmpty!("zai", 429, null)).toBe(false);
	});
});

describe("R7: a single review hand whose every turn ends on a zai 1113 parks with one balance-empty question", () => {
	for (const [shape, message] of Object.entries(SHAPES)) {
		test(`shape ${shape}: one zai-balance entry, one review-park question naming the balance and the billing page, failed-dispatch, no re-dispatch`, async () => {
			const w = world();
			const h = lane(w);
			h.laneMessage(OPUS);
			const agent = await reviewSpawn(h, w, "sl-x", "rev-1");
			h.handMessage("sl-x", GLM, { status: 429, message });
			const out = h.results("rev-1", [{ id: "sl-x", agent, model: GLM, output: "" }]);
			const [token] = tokens(w);

			expect(bodies(w, "zai-balance:")).toEqual([`zai-balance: token ${token} model ${GLM}`]);
			const zai = w.ledger.entries(w.wl).find(e => e.body.startsWith("zai-balance:"))!;
			expect([zai.kind, zai.slice_id]).toEqual(["assumption", "sl-x"]);
			// Written in the settle's own transaction, immediately before its hand-settled:.
			const all = w.ledger.entries(w.wl).map(e => e.body);
			expect(all[all.indexOf(zai.body) + 1]).toStartWith(`hand-settled: ${token} `);

			const open = openQuestions(w);
			expect(open).toHaveLength(1);
			expect(open[0]!.body).toContain(`${GLM} (${BALANCE_REASON}; top up at ${BILLING})`);
			expect(bodies(w, "review-park:")).toEqual([`review-park: ${open[0]!.id} slice sl-x`]);
			expect(rounds(w).map(r => r.verdict)).toEqual(["failed-dispatch"]);
			expect(bodies(w, "provider-refused:")).toEqual([]);

			expect(out?.isError).toBe(true);
			expect(text(out)).toContain(`is parked on question ${open[0]!.id}`);
			expect(text(out)).toContain("do not re-dispatch the review until then");

			const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-2");
			expect(again?.block).toBe(true);
			expect(again?.reason).toContain(`parked on question ${open[0]!.id}`);
			expect(openQuestions(w)).toHaveLength(1);
		});
	}
});

describe("R8: a plain 429 keeps today's failed-dispatch path", () => {
	const cases: Record<string, { model: string; message: string }> = {
		"zai 1302, shape A": { model: GLM, message: shapeA("1302", RATE) },
		"zai 1302, shape B": { model: GLM, message: shapeB("1302", RATE) },
		"zai bare 429": { model: GLM, message: "429 Too Many Requests" },
		"a 1113 body from a provider that is not zai": { model: SOL, message: shapeA("1113", BALANCE) },
	};
	for (const [name, turn] of Object.entries(cases)) {
		test(`${name}: no zai-balance entry, no park, failed-dispatch, and the next dispatch goes ahead`, async () => {
			const w = world();
			const h = lane(w);
			h.laneMessage(OPUS);
			const agent = await reviewSpawn(h, w, "sl-x", "rev-1");
			h.handMessage("sl-x", turn.model, { status: 429, message: turn.message });
			const out = h.results("rev-1", [{ id: "sl-x", agent, model: turn.model, output: "" }]);
			expect(out?.isError).toBe(true);
			expect(text(out)).toContain("a failed dispatch");
			expect(text(out)).not.toContain("parked");
			expect(bodies(w, "zai-balance:")).toEqual([]);
			expect(w.ledger.questions(w.wl)).toEqual([]);
			expect(bodies(w, "review-park:")).toEqual([]);
			expect(rounds(w).map(r => r.verdict)).toEqual(["failed-dispatch"]);
			expect(messages(w)).toEqual([]);
			expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-2"))?.block).toBeUndefined();
		});
	}
});

describe("R9: a 1113 answered in the same hand by another model keeps the review and sends one notice per workload", () => {
	const notice = (slice: string) => `notice: Z.ai balance empty (HTTP 429 code 1113) on wl-zai: ${slice}'s review fell back to ${SOL}; top up at ${BILLING}`;

	/** A review of `slice` whose zai turn ends on 1113 and whose OpenAI turn answers clean. */
	async function fellBack(h: Lane, w: World, slice: string, call: string) {
		const agent = await reviewSpawn(h, w, slice, call);
		h.handMessage(slice, GLM, { status: 429, message: SHAPES["A (anthropic route)"] });
		h.handMessage(slice, SOL);
		return h.results(call, [{ id: slice, agent, model: SOL, output: CLEAN }]);
	}

	test("the review stands cross-lab, one zai-balance entry, one notice; a second such hand on the workload sends no second notice", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		expect(await fellBack(h, w, "sl-x", "rev-1")).toBeUndefined();
		expect(w.ledger.routings(w.wl).map(r => [r.slice_id, r.outcome, r.ran_models])).toEqual([["sl-x", "ran", JSON.stringify([SOL])]]);
		expect(rounds(w).map(r => [r.slice, r.verdict])).toEqual([["sl-x", "accepted"]]);
		expect(bodies(w, "zai-balance:")).toEqual([`zai-balance: token ${tokens(w)[0]} model ${GLM}`]);
		expect(w.ledger.questions(w.wl)).toEqual([]);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(messages(w)).toEqual([{ recipient: "orchestrator", sender: "classifier", body: notice("sl-x") }]);
		expect(w.ledger.workload(w.wl)!.held_messages).toBe(1);

		expect(await fellBack(h, w, "sl-y", "rev-2")).toBeUndefined();
		expect(rounds(w).map(r => [r.slice, r.verdict])).toEqual([
			["sl-x", "accepted"],
			["sl-y", "accepted"],
		]);
		expect(bodies(w, "zai-balance:")).toEqual(tokens(w).map(t => `zai-balance: token ${t} model ${GLM}`));
		expect(messages(w)).toHaveLength(1);
	});

	test("a notice that cannot be written is logged and never withholds the review", async () => {
		const w = world();
		const failing = new Proxy(w.ledger, {
			get(target, prop) {
				if (prop === "enqueue") return () => {
					throw new Error("the messages table is gone");
				};
				const value = Reflect.get(target, prop, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const h = lane(w, () => failing);
		h.laneMessage(OPUS);
		expect(await fellBack(h, w, "sl-x", "rev-1")).toBeUndefined();
		expect(w.ledger.routings(w.wl).map(r => r.outcome)).toEqual(["ran"]);
		expect(rounds(w).map(r => r.verdict)).toEqual(["accepted"]);
		expect(bodies(w, "zai-balance:")).toHaveLength(1);
		expect(messages(w)).toEqual([]);
		expect(h.logs.filter(l => l.includes("Z.ai balance") && l.includes("the messages table is gone"))).toHaveLength(1);
	});
});

describe("R14: a production fan-out whose every member failed to dispatch", () => {
	/** A production fan-out of sl-x by an Anthropic lane: each member's one turn ends on its error. */
	async function fanOut(w: World, errors: Record<"zai" | "openai", ErrorTurn>) {
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change", "production") }, "c1");
		expect(out?.block).toBeUndefined();
		const names = out!.input!.tasks.map(t => t.name);
		expect([...names].sort()).toEqual(["sl-x--openai", "sl-x--zai"]);
		const models = { zai: GLM, openai: SOL } as const;
		for (const name of names) expect((await h.spawn("deep", name))?.model).toEqual([models[name.endsWith("--zai") ? "zai" : "openai"]]);
		for (const which of ["zai", "openai"] as const) h.handMessage(`sl-x--${which}`, models[which], errors[which]);
		const result = h.results(
			"c1",
			names.map(id => ({ id, agent: "deep", model: id.endsWith("--zai") ? GLM : SOL, output: "" })),
		);
		return { h, result };
	}
	const OPENAI_DOWN = { status: 500, message: "500 internal server error" };

	test("with a zai member on 1113, it parks with the balance reason instead of asking for a re-dispatch", async () => {
		const w = world("production");
		const { h } = await fanOut(w, { zai: { status: 429, message: SHAPES["B (openai route)"] }, openai: OPENAI_DOWN });
		expect(rounds(w).map(r => r.verdict)).toEqual(["failed-dispatch", "failed-dispatch"]);
		expect(bodies(w, "zai-balance:")).toHaveLength(1);
		const open = openQuestions(w);
		expect(open).toHaveLength(1);
		expect(open[0]!.body).toContain(`${GLM} (${BALANCE_REASON}; top up at ${BILLING})`);
		expect(bodies(w, "review-park:")).toEqual([`review-park: ${open[0]!.id} slice sl-x`]);
		expect(h.logs.some(l => l.includes("the review is dispatched again"))).toBe(false);
		const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change", "production") }, "c2");
		expect(again?.block).toBe(true);
		expect(again?.reason).toContain(`parked on question ${open[0]!.id}`);
	});

	test("with no 1113 (a zai 1302), it keeps today's behaviour: no park, the review is dispatched again", async () => {
		const w = world("production");
		const { h } = await fanOut(w, { zai: { status: 429, message: SHAPES["B (openai route)"].replaceAll("1113", "1302").replaceAll(BALANCE, RATE) }, openai: OPENAI_DOWN });
		expect(rounds(w).map(r => r.verdict)).toEqual(["failed-dispatch", "failed-dispatch"]);
		expect(bodies(w, "zai-balance:")).toEqual([]);
		expect(w.ledger.questions(w.wl)).toEqual([]);
		expect(bodies(w, "review-park:")).toEqual([]);
		expect(h.logs.some(l => l.includes("every spawned member failed to dispatch") && l.includes("the review is dispatched again"))).toBe(true);
	});
});
