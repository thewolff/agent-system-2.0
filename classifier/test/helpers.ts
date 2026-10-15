import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { tmpDir } from "../../ledger/test/tmp";
import { createClassifierExtension } from "../extension";
import { type Calibration, type KindQuestion, loadCalibration, loadKindQuestion } from "../src/classify";
import type { TierTable } from "../src/tier-table";

export interface SampleRow {
	id: string;
	hand_label: string;
	text: string;
	/** A review case added to the 2026-09-28 sample, not one of the original thirty. */
	addition?: boolean;
	response: { choice: string; confidence: number; probabilities: Record<string, number> };
	judge_model: string;
}

/**
 * The sample the calibration holds for: 2026-09-28, the thirty 2026-09-23 briefs plus two review
 * additions (research/classifier-sample.md § Re-measurement 2026-09-28; classifier/calibration.json).
 */
export const FIXTURE_PATH = join(import.meta.dir, "fixtures", "classifier-sample-2026-09-28.jsonl");

/**
 * The question that sample was recorded with, kept byte-for-byte so the replay replays what was
 * measured. The classifier asks classifier/kind-question.json, which may differ until a new sample
 * is recorded (calibration.json).
 */
export const RECORDED_QUESTION_PATH = join(import.meta.dir, "fixtures", "kind-question-2026-09-28.json");
export const recordedQuestion = (): KindQuestion => loadKindQuestion(RECORDED_QUESTION_PATH);

/** The superseded 2026-09-23 recording, kept as history: its answers belong to its own question. */
export const FIXTURE_PATH_2026_09_23 = join(import.meta.dir, "fixtures", "classifier-sample-30.jsonl");
export const RECORDED_QUESTION_PATH_2026_09_23 = join(import.meta.dir, "fixtures", "kind-question-2026-09-23.json");

export function loadSample(path: string = FIXTURE_PATH): { questionSha256: string; rows: SampleRow[] } {
	const [meta, ...rows] = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	return { questionSha256: meta.meta.question_sha256, rows };
}

type JudgeReply = { choice: string; confidence: number; probabilities?: Record<string, number> };

/**
 * A judge that answers only from recorded TypeSafe responses, keyed by the exact brief text. An
 * unrecorded brief throws: the default test run can never reach a live judge.
 */
export function recordedJudge(rows: { text: string; response: JudgeReply; judge_model?: string }[]) {
	const byText = new Map(rows.map(row => [row.text, row]));
	const calls: string[] = [];
	return {
		calls,
		async judge({ state }: { state: string }) {
			calls.push(state);
			const row = byText.get(state);
			if (!row) throw new Error(`no recorded classifier response for brief: ${state.slice(0, 60)}`);
			const [provider, ...model] = (row.judge_model ?? "typesafe/jev-1.13.0").split("/");
			return { answers: { kind: row.response }, provider: provider!, model: model.join("/") };
		},
	};
}

/** A full five-kind distribution: `mass` on the named kinds, the remainder spread evenly on the rest. */
export function dist(mass: Record<string, number>): Record<string, number> {
	const kinds = ["locate", "understand", "change-small", "change-large", "judge"];
	const rest = kinds.filter(k => !(k in mass));
	const left = 1 - Object.values(mass).reduce((a, b) => a + b, 0);
	return Object.fromEntries(kinds.map(k => [k, k in mass ? mass[k]! : left / rest.length]));
}

/** A model registry shaped like OMP's: `getAvailable()` lists models, `getApiKey()` resolves credentials. */
export interface FakeRegistry {
	getAvailable(): { provider: string; id: string; name: string }[];
	getApiKey(model: { provider: string; id: string }, sessionId?: string): Promise<string | undefined>;
}

/**
 * `sessionless` models resolve credentials only when no session id is given: OMP's final selection
 * asks `getApiKey(model, <agent id>)` (config/model-resolver.ts resolveModelOverrideWithAuthFallback),
 * and a session-sticky account can answer differently than the session-free call.
 */
export function fakeRegistry(available: string[], credentialed: string[] = available, sessionless: string[] = []): FakeRegistry {
	const models = available.map(selector => {
		const [provider, ...id] = selector.split("/");
		return { provider: provider!, id: id.join("/"), name: selector };
	});
	return {
		getAvailable: () => models,
		getApiKey: async (m: { provider: string; id: string }, sessionId?: string) => {
			const selector = `${m.provider}/${m.id}`;
			if (sessionless.includes(selector)) return sessionId === undefined ? "test-only" : undefined;
			return credentialed.includes(selector) ? "test-only" : undefined;
		},
	};
}

/** A real schema-v5 ledger in a scratch directory with one open workload and the named slices. */
export function scratchLedger(slices: string[] = ["sl-one", "sl-two"], workloadId = "wl-abc123") {
	// tmpDir puts it in a watched run root: under LEDGER_TEST_TMP when that is set, else this run's own.
	const dir = tmpDir("classifier-ledger-");
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	ledger.openWorkload({ id: workloadId, brief: "classifier test", stakes: "normal", mode: "autonomous", by: "orch-test" });
	for (const id of slices) ledger.addSlice({ id, workloadId, task: id, doneCondition: "d", inputs: "i", by: "lane-test" });
	return { ledger, workloadId };
}

/** The lane model a test host's context carries unless the test names another: an Anthropic lane. */
export const DEFAULT_LANE_MODEL = "anthropic/claude-opus-5-5";

/** OMP's `ExtensionContext.model` for a `provider/id` selector: the session's current `Model`, or undefined. */
export function currentModel(selector: string | undefined): { provider: string; id: string } | undefined {
	if (selector === undefined) return undefined;
	const [provider, ...id] = selector.split("/");
	return { provider: provider!, id: id.join("/") };
}

type Handler = (event: unknown, ctx?: unknown) => unknown;
export type SpawnReply = { model?: string[]; note?: string; block?: boolean; reason?: string } | undefined;

/**
 * The classifier extension on a fake OMP host: a real schema-v5 ledger, a fake model registry, and
 * two sessions bound to one extension instance, as OMP binds the lane's prepared factories into
 * each hand's session (task/executor.ts). The lane session gets `tool_call`, `before_subagent_spawn`,
 * `tool_result` and `context`; `handMessage` is an assistant `message_end` in the hand's session,
 * whose session file is `<artifactsDir>/<agentId>.jsonl`. `toolResult` passes `details` through as
 * OMP's task result details.
 */
export function extensionHost(opts: {
	judge: { judge(req: { state: string }): Promise<unknown> };
	table: TierTable;
	registry: FakeRegistry;
	slices?: string[];
	disabledProviders?: string[];
	question?: KindQuestion;
	calibration?: Calibration;
	/** The session's bound `AGENT_SYSTEM_WORKLOAD_ID`, if any. */
	boundWorkload?: string;
	/** An existing ledger and workload, to bind a second extension instance to the same file. */
	shared?: { ledger: Ledger; workloadId: string };
	/** The lane's session file; its hands' sessions are `<file without .jsonl>/<agentId>.jsonl`. */
	laneFile?: string;
	/**
	 * The lane's current model (`ctx.model`), `provider/id`: `DEFAULT_LANE_MODEL` when the key is absent;
	 * an explicit undefined is a lane OMP reports no model for. Build hands run on its lab's entries.
	 */
	laneModel?: string;
	/** The lane's id (`AGENT_SYSTEM_LANE_ID`); `lane-test` when absent. */
	laneId?: string;
}) {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const { ledger, workloadId } = opts.shared ?? scratchLedger(opts.slices);
	const logs: string[] = [];
	const extension = createClassifierExtension({
		judge: async () => opts.judge as never,
		tierTable: () => opts.table,
		disabledProviders: async () => opts.disabledProviders ?? [],
		question: opts.question ?? recordedQuestion(),
		calibration: opts.calibration ?? loadCalibration(),
		ledger: () => ledger,
		laneId: opts.laneId ?? "lane-test",
		boundWorkload: () => opts.boundWorkload,
		// No lost-hand settle here: every recorded omp is alive (snapshot-settle.test.ts T10 drives the rule).
		ompState: () => "same",
		lastWrite: () => null,
		log: line => logs.push(line),
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const laneFile = opts.laneFile ?? "/tmp/lane.jsonl";
	const ctx = {
		cwd: "/tmp",
		modelRegistry: opts.registry,
		model: currentModel("laneModel" in opts ? opts.laneModel : DEFAULT_LANE_MODEL),
		sessionManager: { getSessionFile: () => laneFile },
	};
	/** The lane's per-request context: the messages its model is sent (the input when no handler changes them). */
	const context = (messages: unknown[]) => {
		const result = handlers.context?.({ type: "context", messages: structuredClone(messages) }, ctx) as
			| { messages?: unknown[] }
			| undefined;
		return result?.messages ?? messages;
	};
	return {
		ledger,
		workloadId,
		toolCall: (input: unknown, toolCallId = "call-1") =>
			handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<any>,
		toolResult: (toolCallId: string, isError: boolean, details?: unknown) =>
			handlers.tool_result!(
				{ type: "tool_result", toolName: "task", toolCallId, isError, input: {}, content: [], details },
				ctx,
			) as { isError?: boolean; content?: { type: string; text: string }[] } | undefined,
		/** Another tool's result in the lane session, e.g. `wait` or a `proc://<id>/kill` write, with its `details`. */
		otherToolResult: (toolName: string, details: unknown, toolCallId = "other-1") =>
			handlers.tool_result!({ type: "tool_result", toolName, toolCallId, isError: false, input: {}, content: [], details }, ctx),
		spawn: (agent: string, spawnKey?: string, invocationKind = "task") =>
			handlers.before_subagent_spawn!(
				{ type: "before_subagent_spawn", agent, invocationKind, patterns: [], spawnKey },
				ctx,
			) as Promise<SpawnReply>,
		/** An assistant turn on `provider/model` ends in hand `agentId`'s own session, under this lane's root. */
		handMessage: (agentId: string, provider: string, model: string) =>
			handSession.message_end?.(
				{ type: "message_end", message: { role: "assistant", provider, model, content: [] } },
				{ ...ctx, sessionManager: { getSessionFile: () => `${laneFile.slice(0, -".jsonl".length)}/${agentId}.jsonl` } },
			),
		/** The lane's session starts (`session_start`, awaited before any tool call). */
		sessionStart: () => handlers.session_start?.({ type: "session_start" }, ctx),
		/** The lane's turn ends (session/agent-session.ts forwards `turn_end` to extensions, awaited). */
		turnEnd: () => handlers.turn_end?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx),
		context,
		/** Async jobs `jobIds` deliver their output to the lane: the messages its model is sent. */
		deliver: (jobIds: string[], text?: string) => context([asyncDelivery(jobIds, text)]),
		routings: () => ledger.routings(workloadId),
		logs,
	};
}

/**
 * An `async-result` delivery as session/async-job-delivery.ts builds it: one text part per job. A task
 * job's `label` is its agent id; `agentIds` sets it apart from a collision-suffixed `jobId`.
 */
export function asyncDelivery(jobIds: string[], text = "hand output", agentIds: string[] = jobIds) {
	return {
		role: "custom",
		customType: "async-result",
		content: text,
		display: true,
		details: { jobs: jobIds.map((jobId, i) => ({ jobId, type: "task", label: agentIds[i], durationMs: 1 })) },
		timestamp: Date.now(),
	};
}
