/**
 * SPEC-2.0.md § B4 "Amended 2026-11-03 — normal judge reviews on standard" (PLAN wl-mv71x5rwdu7eo0
 * PLAN-p2-rev4.md § 2.3, § 2.4 item 2): a judge-kind review runs on standard at normal stakes and
 * on fast at throwaway, production keeps deep, and the OpenAI reviewer is the strong row's OpenAI
 * entry at every review tier. Driven through the extension's real dispatch path (the `task`
 * tool_call, the hand's spawn, its settle) on a fake OMP host, as crosslab.test.ts drives it, and
 * through no new export, so the counted cases fail on assertions where the amendment is absent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type Stakes } from "../../ledger/src/index";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { tierTableFromConfig } from "../src/tier-table";
import { currentModel, dist, fakeRegistry, recordedQuestion } from "./helpers";

// The installed rows' shape (profile/config.yml task.agentModelOverrides): one Anthropic and one OpenAI entry per tier.
const ROWS = {
	fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
/** Past the end of Jo's dated Kimi-out and Anthropic-out rules, so neither shapes a row here. */
const NOW = Date.parse("2026-11-03T12:00:00-08:00");

/** Answers by the brief's task text: `review…` judge 0.9; `unsure…` change-large 0.5 with judge second at 0.45. */
function answer(brief: string) {
	const task = /^task: (.*)$/m.exec(brief)?.[1] ?? "";
	if (task.startsWith("review")) return { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) };
	if (task.startsWith("unsure")) return { choice: "change-large", confidence: 0.5, probabilities: dist({ "change-large": 0.5, judge: 0.45 }) };
	throw new Error(`review-tier.test.ts answers only review… and unsure… briefs, not: ${task}`);
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

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Item = { agent: string; name: string; task?: string };
type Reply = { block?: boolean; reason?: string; input?: Item & { tasks?: Item[] }; model?: string[]; note?: string } | undefined;

/**
 * A workload at `stakes` on a temp ledger, its lane's repository and session file, and one lane process on an Anthropic
 * model (the builder lab: the lane's own dispatch records it, PLAN wl-mv5i3lulwwbbi8 D7), as crosslab.test.ts sets them up.
 */
function lane(stakes: Stakes) {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "review-tier-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-tier", brief: "review tier test", stakes, mode: "autonomous", by: "orch-test" });
	ledger.addSlice({ id: "sl-x", workloadId: wl, task: "sl-x", doneCondition: "d", inputs: "i", by: "lane-test" });
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
	const root = laneFile.slice(0, -".jsonl".length);

	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => ledger,
		laneId: "lane-test",
		boundWorkload: () => wl,
		ompState: () => "same",
		lastWrite: () => null,
		log: () => {},
		now: () => NOW,
		spawnMoveAlert: () => null,
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: repo, modelRegistry: fakeRegistry(ALL), model: currentModel(OPUS), sessionManager: { getSessionFile: () => laneFile } };
	const assistant = (selector: string) => {
		const [provider, ...model] = selector.split("/");
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
	};
	const brief = (task: string) =>
		`workload: ${wl}\ntask: ${task}\ndone-condition: d\ninputs: i\nstakes: ${stakes}\nceiling-share: 10\n## How it fails\n- the review hand fails: its failure reaches the ledger; redispatch once`;

	/**
	 * One blocking dispatch of `sl-x` with `task` through the lane's `task` call: every hand it publishes spawns on its
	 * agent, answers on the first entry of its spawn row, and settles. Returns each hand's name@tier and spawn row, and the
	 * routing rows the settle wrote.
	 */
	async function dispatch(task: string) {
		handlers.message_end!(assistant(OPUS), ctx);
		const out = (await handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId: "c1", input: { agent: "strong", name: "sl-x", task: brief(task) } }, ctx)) as Reply;
		expect(out?.block).toBeUndefined();
		const items = out!.input!.tasks ?? [out!.input!];
		const hands: { hand: string; row: string[] }[] = [];
		for (const item of items) {
			const spawn = (await handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent: item.agent, invocationKind: "task", patterns: [], spawnKey: item.name }, ctx)) as Reply;
			expect(spawn?.block).toBeUndefined();
			hands.push({ hand: `${item.name}@${item.agent}`, row: spawn!.model! });
			handSession.message_end!(assistant(spawn!.model![0]!), { ...ctx, sessionManager: { getSessionFile: () => `${root}/${item.name}.jsonl` } });
		}
		const results = items.map((item, i) => ({ id: item.name, agent: item.agent, resolvedModelIdentity: hands[i]!.row[0] }));
		const settled = handlers.tool_result!({ type: "tool_result", toolName: "task", toolCallId: "c1", isError: false, input: {}, content: [], details: { results } }, ctx) as
			| { isError?: boolean; content?: { text: string }[] }
			| undefined;
		expect(settled?.isError).toBeFalsy();
		return { hands, routings: ledger.routings(wl) };
	}
	return { dispatch };
}

describe("judge-kind reviews run on their stakes' review tier, the OpenAI reviewer on the strong row's entry (SPEC-2.0.md § B4, amended 2026-11-03)", () => {
	test("normal judge review, Anthropic builder: runs on standard with openai-codex/gpt-6.1-sol, pull_down_to standard", async () => {
		const { hands, routings } = await lane("normal").dispatch("review the change");
		expect(hands).toEqual([{ hand: "sl-x@standard", row: [SOL] }]);
		expect(routings).toMatchObject([
			{ slice_id: "sl-x", kind: "judge", classified_tier: "deep", stakes: "normal", pull_down_to: "standard", tier: "standard", models: JSON.stringify([SOL]), ran_models: JSON.stringify([SOL]), outcome: "ran" },
		]);
	});

	test("throwaway judge review, Anthropic builder: runs on fast with openai-codex/gpt-6.1-sol, pull_down_to fast", async () => {
		const { hands, routings } = await lane("throwaway").dispatch("review the change");
		expect(hands).toEqual([{ hand: "sl-x@fast", row: [SOL] }]);
		expect(routings).toMatchObject([
			{ slice_id: "sl-x", kind: "judge", classified_tier: "deep", stakes: "throwaway", pull_down_to: "fast", tier: "fast", models: JSON.stringify([SOL]), ran_models: JSON.stringify([SOL]), outcome: "ran" },
		]);
	});

	test("control: production judge review keeps deep, the one other lab's hand on openai-codex/gpt-6.1-sol, no pull-down", async () => {
		const { hands, routings } = await lane("production").dispatch("review the change");
		expect(hands).toEqual([{ hand: "sl-x@deep", row: [SOL] }]);
		expect(routings).toMatchObject([{ slice_id: "sl-x", kind: "judge", stakes: "production", pull_down_to: null, tier: "deep", models: JSON.stringify([SOL]), outcome: "ran" }]);
	});

	test("control: a low-confidence change-large review at normal keeps its A1.3 pull-up and the normal cap: strong", async () => {
		const { hands, routings } = await lane("normal").dispatch("unsure whether this needs a review");
		expect(hands).toEqual([{ hand: "sl-x@strong", row: [SOL] }]);
		expect(routings).toMatchObject([
			{ slice_id: "sl-x", kind: "change-large", classified_tier: "strong", pull_up_to: "deep", stakes: "normal", pull_down_to: "strong", tier: "strong", models: JSON.stringify([SOL]), outcome: "ran" },
		]);
	});
});
