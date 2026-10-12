/**
 * A hand whose result reaches the lane through a `wait` / `proc` job snapshot settles exactly once,
 * like an auto-delivered one (PLAN wl-muq13bkdghblmo steps 1-5, T1a-T10). The classifier extension
 * on a fake OMP host with a real temp ledger and a real git repository, the crosslab harness.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_RUNNER_BY, Ledger, type Stakes } from "../../ledger/src/index";
import { JO_HOLDER, laneExitBody } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { countRounds, parseReviewRound, reviewLoopEndBody, reviewRoundsBody, roundsInstructionBody } from "../src/rounds";
import { tierTableFromConfig } from "../src/tier-table";
import { dist, type FakeRegistry, fakeRegistry, recordedQuestion } from "./helpers";

const ROWS = {
	fast: ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const [OPUS, SOL, KIMI] = ROWS.strong as [string, string, string];
const FABLE = ROWS.deep[0]!;

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

/** A workload on a temp ledger, the lane's repository, its session file, and a mutable registry. */
interface World {
	dir: string;
	ledger: Ledger;
	wl: string;
	repo: string;
	laneFile: string;
	/** The lane's session root: its session file without `.jsonl`, where its hands' sessions live. */
	root: string;
	/** The selectors holding credentials; remove one to take its credential away. */
	creds: string[];
	registry: FakeRegistry;
}
function world(opts: { stakes?: Stakes } = {}): World {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "snapshot-settle-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-snap", brief: "snapshot settle test", stakes: opts.stakes ?? "normal", mode: "autonomous", by: "orch-test" });
	for (const id of ["sl-x", "sl-y"]) ledger.addSlice({ id, workloadId: wl, task: id, doneCondition: "d", inputs: "i", by: "lane-test" });
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

const brief = (w: World, task: string) => `workload: ${w.wl}\ntask: ${task}\ndone-condition: d\ninputs: i\nstakes: normal\nceiling-share: 10`;

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Item = { agent: string; name: string; task?: string };
type Reply = { block?: boolean; reason?: string; input?: Item & { tasks: Item[] }; model?: string[]; note?: string } | undefined;
type ToolReply = { isError?: boolean; content?: { text: string }[] } | undefined;

/** An `async-result` delivery (session/async-job-delivery.ts buildAsyncResultBatchMessage), stamped `timestamp`. */
interface Delivery {
	role: "custom";
	customType: "async-result";
	content: string;
	display: boolean;
	details: { jobs: { jobId: string; type: string; label: string; durationMs: number }[] };
	timestamp: number;
}
const delivery = (agentIds: string[], text: string, timestamp = Date.now()): Delivery => ({
	role: "custom",
	customType: "async-result",
	content: text,
	display: true,
	details: { jobs: agentIds.map(id => ({ jobId: id, type: "task", label: id, durationMs: 1 })) },
	timestamp,
});

/** One lane process: the classifier bound to the lane's session and to its hands' sessions. A second `lane(w)` is a restart. */
interface Lane {
	logs: string[];
	toolCall(input: unknown, toolCallId: string): Promise<Reply>;
	spawn(agent: string, spawnKey: string): Promise<Reply>;
	laneMessage(selector: string): unknown;
	handMessage(agentId: string, selector: string): unknown;
	asyncReturned(toolCallId: string, progress: { index: number; id: string; status?: string }[]): unknown;
	/** Another tool's result carrying `details` (a `wait`, a `proc://` read or write), shown as `text`; `session: null`: the lane has no session file. */
	snapshot(toolName: string, details: unknown, text?: string, opts?: { session?: null }): ToolReply;
	/** The lane's context carries these messages; returns each one's text as the model is sent it. */
	context(...messages: Delivery[]): string[];
	/** The same classifier instance serving another session file `laneFile`: a second lane root in this process, as a nested session is. */
	under(laneFile: string): Lane;
}
function lane(w: World, opts: { laneId?: string } = {}): Lane {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const logs: string[] = [];
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => w.ledger,
		laneId: opts.laneId ?? "lane-test",
		boundWorkload: () => w.wl,
		log: line => logs.push(line),
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const bind = (laneFile: string): Lane => {
		const ctx = { cwd: w.repo, modelRegistry: w.registry, sessionManager: { getSessionFile: () => laneFile } };
		const root = laneFile.slice(0, -".jsonl".length);
		const handCtx = (agentId: string) => ({ ...ctx, sessionManager: { getSessionFile: () => `${root}/${agentId}.jsonl` } });
		const assistant = (selector: string) => {
			const [provider, ...model] = selector.split("/");
			return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [], stopReason: "stop" } };
		};
		return {
			logs,
			toolCall: (input: unknown, toolCallId: string) => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
			spawn: (agent: string, spawnKey: string) =>
				handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<Reply>,
			laneMessage: (selector: string) => handlers.message_end!(assistant(selector), ctx),
			handMessage: (agentId: string, selector: string) => handSession.message_end!(assistant(selector), handCtx(agentId)),
			asyncReturned: (toolCallId: string, progress: { index: number; id: string; status?: string }[]) =>
				handlers.tool_result!(
					{ type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [], details: { async: { state: "running", jobId: "j", type: "task" }, progress } },
					ctx,
				),
			snapshot: (toolName, details, text = "snapshot text", opts = {}) =>
				handlers.tool_result!(
					{ type: "tool_result", toolName, toolCallId: `t-${toolName}`, isError: false, input: {}, content: [{ type: "text", text }], details },
					opts.session === null ? { ...ctx, sessionManager: { getSessionFile: () => undefined } } : ctx,
				) as ToolReply,
			context: (...messages) => {
				const result = handlers.context!({ type: "context", messages }, ctx) as { messages?: { content: unknown }[] } | undefined;
				return (result?.messages ?? messages).map(m => String(m.content));
			},
			under: bind,
		};
	};
	return bind(w.laneFile);
}

const bodies = (w: World, prefix = "") => w.ledger.entries(w.wl).map(e => e.body).filter(b => b.startsWith(prefix));
const rounds = (w: World) => bodies(w, "review-round:").map(b => parseReviewRound(b)!);
const routings = (w: World) => w.ledger.routings(w.wl);
const spawnTokens = (w: World) => bodies(w, "hand-spawn:").map(b => b.split(" ")[1]!);

const reply = (...findings: { severity: string; kind: string; title: string }[]) =>
	`Reviewed the change.\n\n\`\`\`review-findings\n${JSON.stringify({ findings })}\n\`\`\`\n`;
const CLEAN = reply();
const BLOCKING = reply({ severity: "blocking", kind: "correctness", title: "the snapshot is not settled" });
const SECRET = `SECRET-OUTPUT ${CLEAN}`;

/** A task job as a job-control snapshot lists it (async/job-control.ts snapshotJobs). */
const job = (label: string, status: string, extra: { resultText?: string; errorText?: string } = {}) => ({ id: label, type: "task", status, label, durationMs: 5, ...extra });

/** An async dispatch of `slice` (`task` text) that OMP schedules as agent `id` and spawns. */
async function asyncSpawn(h: Lane, w: World, call: string, slice: string, id: string, task = "review the change") {
	const out = await h.toolCall({ agent: "strong", name: slice, task: brief(w, task) }, call);
	expect(out?.reason).toBeUndefined();
	h.asyncReturned(call, [{ index: 0, id, status: "running" }]);
	return h.spawn(out!.input!.agent, id);
}

/** A lane that built on anthropic, with one async review of sl-x spawned as agent `sl-x`. */
async function reviewing() {
	const w = world();
	const h = lane(w);
	h.laneMessage(OPUS);
	const spawn = await asyncSpawn(h, w, "c1", "sl-x", "sl-x");
	expect(spawn?.model).toEqual([SOL, KIMI]);
	return { w, h };
}

/** One settle of a passing review: one `ran` row, one `hand-settled:`, one accepted round, and the loop ended. */
function settledOnce(w: World) {
	expect(routings(w).map(r => r.outcome)).toEqual(["ran"]);
	expect(bodies(w, "hand-settled:")).toHaveLength(1);
	expect(rounds(w).map(r => [r.round, r.verdict])).toEqual([[1, "accepted"]]);
	expect(bodies(w, "review-loop-end:")).toEqual([reviewLoopEndBody("sl-x", "pass")]);
}

describe("a review collected by a job snapshot settles once", () => {
	test("T1a: a `wait` snapshot of a passing review settles it and ends the loop", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", SOL);
		expect(h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: CLEAN })] })).toBeUndefined();
		settledOnce(w);
	});

	test("T1b: a `wait` snapshot of a failing review closes round 1, and the next review is accepted as round 2", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", SOL);
		h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: BLOCKING })] });
		expect(rounds(w).map(r => [r.round, r.verdict, r.findings === "unknown" ? null : 1])).toEqual([[1, "accepted", 1]]);
		const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2");
		expect(again?.reason).toBeUndefined();
		h.asyncReturned("c2", [{ index: 0, id: "sl-x-1", status: "running" }]);
		expect((await h.spawn("strong", "sl-x-1"))?.reason).toBeUndefined();
		const count = countRounds(w.ledger.entries(w.wl), "sl-x");
		expect(count.rounds.map(r => [r.n, r.complete])).toEqual([
			[1, true],
			[2, false],
		]);
		expect(count.failed).toBe(1);
	});

	test("T2: the same job's auto-delivery after the snapshot writes nothing more and passes untouched", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", SOL);
		h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: CLEAN })] });
		expect(h.context(delivery(["sl-x"], CLEAN))).toEqual([CLEAN]);
		settledOnce(w);
	});

	test("T3: an auto-delivery and then the snapshot settle once", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", SOL);
		expect(h.context(delivery(["sl-x"], CLEAN))).toEqual([CLEAN]);
		expect(h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: CLEAN })] })).toBeUndefined();
		settledOnce(w);
	});

	test("T4: after a restart the same snapshot is checked against the routing row and writes nothing", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", SOL);
		h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: CLEAN })] });
		const count = w.ledger.entries(w.wl).length;
		expect(lane(w).snapshot("read", { proc: { job: job("sl-x", "completed"), log: CLEAN } })).toBeUndefined();
		expect(w.ledger.entries(w.wl)).toHaveLength(count);
		settledOnce(w);
	});

	test("T5: a review that answered off its row and is collected by `wait` is withheld, and its round fails", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", OPUS);
		const out = h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: SECRET })] }, `### sl-x [task] — completed\n${SECRET}`);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain("refused this job snapshot");
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w).map(r => r.outcome)).toEqual(["refused-out-of-row"]);
		expect(rounds(w).map(r => r.verdict)).toEqual(["withheld"]);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x").failed).toBe(1);
	});

	test("T6: a `proc://<id>/kill` write on a finished job, and a `read proc://<id>`, each settle like `wait`", async () => {
		const killed = await reviewing();
		killed.h.handMessage("sl-x", SOL);
		const cancel = { proc: { op: "cancel", jobs: [job("sl-x", "completed", { resultText: CLEAN })], cancelled: [{ id: "sl-x", status: "completed" }] } };
		expect(killed.h.snapshot("write", cancel)).toBeUndefined();
		settledOnce(killed.w);

		const read = await reviewing();
		read.h.handMessage("sl-x", SOL);
		expect(read.h.snapshot("read", { proc: { job: job("sl-x", "completed", { resultText: CLEAN }), log: CLEAN } })).toBeUndefined();
		settledOnce(read.w);
	});

	test("T6b (item 109): a cancelled hand with no text settles at once with verdict cancelled, no park; its text shown later is withheld and writes nothing more", async () => {
		// The live shape: dt-mv4pqu7z8f3ee994, a kimi review member of wl-mv4osi70ng2e4g, was killed by
		// `proc://<id>/kill` before any model answered; held open, it refused every re-dispatch.
		const { w, h } = await reviewing();
		expect(h.snapshot("write", { proc: { op: "cancel", jobs: [job("sl-x", "cancelled")], cancelled: [{ id: "sl-x", status: "cancelled" }] } })).toBeUndefined();
		expect(routings(w).map(r => r.outcome)).toEqual(["refused-model-unknown"]);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
		expect(rounds(w).map(r => r.verdict)).toEqual(["cancelled"]);
		expect(w.ledger.questions(w.wl)).toEqual([]); // no park: nothing was outside the row, the lane cancelled it
		expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [], next: 1 }); // no round burnt
		const out = h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "cancelled", { resultText: SECRET })] }, SECRET);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w)).toHaveLength(1);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
		expect(rounds(w)).toHaveLength(1);
	});

	test("T6b-2 (item 109): a cancelled hand that had answered off its row settles cancelled with its row recorded; the kill's own result is not refused", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", OPUS);
		expect(h.snapshot("write", { proc: { op: "cancel", jobs: [job("sl-x", "cancelled")], cancelled: [{ id: "sl-x", status: "cancelled" }] } })).toBeUndefined();
		expect(routings(w).map(r => r.outcome)).toEqual(["refused-out-of-row"]);
		expect(rounds(w).map(r => r.verdict)).toEqual(["cancelled"]);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
	});

	describe("PR #76 B2: a cancelled hand that answered on its row stays withheld after a restart", () => {
		/** Cancel the job of `agentId` with nothing shown, then show its text to a fresh classifier, by snapshot and by async delivery. */
		function cancelThenRestart(w: World, h: Lane, agentId: string) {
			expect(h.snapshot("write", { proc: { op: "cancel", jobs: [job(agentId, "cancelled")], cancelled: [{ id: agentId, status: "cancelled" }] } })).toBeUndefined();
			// The row records what answered (on its row), and the cancellation is persisted beside it.
			expect(routings(w).map(r => r.outcome)).toEqual(["ran"]);
			expect(bodies(w, "hand-cancelled:")).toEqual([`hand-cancelled: ${spawnTokens(w)[0]}`]);
			const count = w.ledger.entries(w.wl).length;
			const snap = lane(w).snapshot("wait", { op: "wait", jobs: [job(agentId, "cancelled", { resultText: SECRET })] }, SECRET);
			expect(snap?.isError).toBe(true);
			expect(snap?.content?.[0]?.text).toContain("its job was cancelled before its result was shown (hand-cancelled:");
			expect(snap?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
			const delivered = lane(w).context(delivery([agentId], SECRET));
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("hand-cancelled:");
			expect(delivered[0]).not.toContain("SECRET-OUTPUT");
			// Neither path settles or writes a round again.
			expect(w.ledger.entries(w.wl)).toHaveLength(count);
			expect(routings(w)).toHaveLength(1);
			expect(bodies(w, "hand-settled:")).toHaveLength(1);
		}

		test("a review hand: its round stays cancelled and uncounted", async () => {
			const { w, h } = await reviewing();
			h.handMessage("sl-x", SOL);
			cancelThenRestart(w, h, "sl-x");
			expect(rounds(w).map(r => r.verdict)).toEqual(["cancelled"]);
			expect(countRounds(w.ledger.entries(w.wl), "sl-x")).toMatchObject({ rounds: [], next: 1 });
		});

		test("a non-review hand, which has no round entry", async () => {
			const w = world();
			const h = lane(w);
			h.laneMessage(OPUS);
			expect((await asyncSpawn(h, w, "c1", "sl-y", "sl-y", "build it"))?.model).toEqual([OPUS, SOL, KIMI]);
			h.handMessage("sl-y", OPUS);
			cancelThenRestart(w, h, "sl-y");
			expect(rounds(w)).toEqual([]);
		});
	});

	test("T6c: a `read proc://<id>` after the result was consumed shows the raw output: it stays withheld, with nothing written twice", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", OPUS);
		expect(h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: SECRET })] }, SECRET)?.isError).toBe(true);
		const replay = h.snapshot("read", { proc: { job: job("sl-x", "completed"), log: SECRET } }, `sl-x [task] — completed — sl-x\n${SECRET}`);
		expect(replay?.isError).toBe(true);
		expect(replay?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w)).toHaveLength(1);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
		expect(rounds(w)).toHaveLength(1);
	});

	test("T7: a task job that is no tier hand passes a snapshot untouched", async () => {
		const { w, h } = await reviewing();
		expect(h.snapshot("wait", { op: "wait", jobs: [job("helper-1", "completed", { resultText: "plain output" })] })).toBeUndefined();
		expect(routings(w)).toEqual([]);
	});

	test("T8: status-only listings never settle; the `wait` after them settles once", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", SOL);
		expect(h.snapshot("read", { proc: { jobs: [job("sl-x", "completed", { resultText: CLEAN })], agents: [], daemons: [] } })).toBeUndefined();
		expect(h.snapshot("wait", { op: "jobs", jobs: [job("sl-x", "completed")] })).toBeUndefined();
		expect(routings(w)).toEqual([]);
		expect(bodies(w, "hand-settled:")).toEqual([]);
		expect(rounds(w)).toEqual([]);
		expect(h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: CLEAN })] })).toBeUndefined();
		settledOnce(w);
	});

	test("review r1 finding 2: with no session file, a snapshot's shown output is withheld, as a delivery's is", async () => {
		const { w, h } = await reviewing();
		h.handMessage("sl-x", OPUS); // off its row
		const out = h.snapshot("wait", { op: "wait", jobs: [job("sl-x", "completed", { resultText: SECRET })] }, SECRET, { session: null });
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain("the lane has no session file");
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w)).toEqual([]);
	});
});

describe("review r1 finding 1: an earlier job's snapshot never settles or releases a newer hand with the same agent id", () => {
	/**
	 * In one lane process, review H1 of sl-x (agent `sl-x-2`) settles on its delivery with a blocking
	 * finding; then H2, a review of sl-x that OMP gives the same agent id, is published and not yet spawned.
	 */
	async function h2Pending() {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await asyncSpawn(h, w, "c1", "sl-x", "sl-x-2");
		h.handMessage("sl-x-2", SOL);
		expect(h.context(delivery(["sl-x-2"], BLOCKING))).toEqual([BLOCKING]);
		expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2"))?.reason).toBeUndefined();
		h.asyncReturned("c2", [{ index: 0, id: "sl-x-2", status: "running" }]);
		return { w, h };
	}

	test("a status-only listing of H1's finished job does not release pending H2: H2 still spawns", async () => {
		const { w, h } = await h2Pending();
		expect(h.snapshot("wait", { op: "jobs", jobs: [job("sl-x-2", "completed")] })).toBeUndefined();
		expect(h.snapshot("read", { proc: { jobs: [job("sl-x-2", "completed")], agents: [], daemons: [] } })).toBeUndefined();
		expect((await h.spawn("strong", "sl-x-2"))?.model).toEqual([SOL, KIMI]);
		expect(spawnTokens(w)).toHaveLength(2);
	});

	test("H1's `read proc://<id>` does not release pending H2, and its text is withheld", async () => {
		const { w, h } = await h2Pending();
		const out = h.snapshot("read", { proc: { job: job("sl-x-2", "completed"), log: SECRET } }, SECRET);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect((await h.spawn("strong", "sl-x-2"))?.model).toEqual([SOL, KIMI]);
		expect(spawnTokens(w)).toHaveLength(2);
	});

	test("H1's `read proc://<id>` does not settle held H2, and its text is withheld", async () => {
		const { w, h } = await h2Pending();
		expect((await h.spawn("strong", "sl-x-2"))?.model).toEqual([SOL, KIMI]);
		const h2 = spawnTokens(w)[1]!;
		h.handMessage("sl-x-2", SOL);
		const out = h.snapshot("read", { proc: { job: job("sl-x-2", "completed"), log: SECRET } }, SECRET);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w)).toHaveLength(1);
		expect(bodies(w, "hand-settled:").filter(b => b.includes(h2))).toEqual([]);
		expect(rounds(w).filter(r => r.token === h2)).toEqual([]);
		// H2 is still held: the next review of sl-x waits for it.
		expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c3"))?.reason).toContain("review round 2 of sl-x is still running");
	});

	test("control: an earlier job's output that no hand of this process owned does not block H2's own `wait`", async () => {
		const w = world();
		const h = lane(w); // a resumed lane session: D1 is an earlier process's job, with no routing row
		h.laneMessage(OPUS);
		const d1 = delivery(["sl-x-2"], "SECRET-OUTPUT of an earlier job", Date.now() - 60_000);
		expect(h.context(d1)[0]).toContain("refused this async task result");
		expect((await asyncSpawn(h, w, "c1", "sl-x", "sl-x-2"))?.model).toEqual([SOL, KIMI]);
		h.handMessage("sl-x-2", SOL);
		expect(h.snapshot("wait", { op: "wait", jobs: [job("sl-x-2", "completed", { resultText: CLEAN })] })).toBeUndefined();
		settledOnce(w);
	});
});

describe("review r2: a job snapshot in one lane root never settles or releases a hand with the same agent id in another root of the process", () => {
	/**
	 * One process, one job manager, two lane roots: lane A (`w.laneFile`) and a nested session B under
	 * it. Each dispatches a builder of sl-y that OMP names agent `sl-y`, A first; `bSpawned: false`
	 * leaves B's published and not yet spawned.
	 */
	async function twoRoots(opts: { aOffRow?: boolean; bSpawned?: boolean } = {}) {
		const w = world();
		const a = lane(w);
		a.laneMessage(OPUS);
		expect((await asyncSpawn(a, w, "c1", "sl-y", "sl-y", "build it"))?.model).toEqual([OPUS, SOL, KIMI]);
		if (opts.aOffRow) {
			// A answers off its row and settles on its own delivery, withheld: a verdict settled here under root A.
			a.handMessage("sl-y", FABLE);
			expect(a.context(delivery(["sl-y"], SECRET))[0]).not.toContain("SECRET-OUTPUT");
			expect(routings(w).map(r => r.outcome)).toEqual(["refused-out-of-row"]);
		}
		const b = a.under(join(w.root, "nested.jsonl"));
		const out = await b.toolCall({ agent: "strong", name: "sl-y", task: brief(w, "build it") }, "c2");
		expect(out?.reason).toBeUndefined();
		b.asyncReturned("c2", [{ index: 0, id: "sl-y", status: "running" }]);
		if (opts.bSpawned !== false) {
			expect((await b.spawn(out!.input!.agent, "sl-y"))?.model).toEqual([OPUS, SOL, KIMI]);
			b.handMessage("sl-y", OPUS); // B's hand answers on its row
		}
		return { w, a, b, before: routings(w).length };
	}
	/** A's job, with A's unchecked text, shown by a `wait` in root B. */
	const aJobInB = (b: Lane) => b.snapshot("wait", { op: "wait", jobs: [job("sl-y", "completed", { resultText: SECRET })] }, SECRET);

	test("A's held hand: B's `wait` showing A's job settles neither hand, and A's text is withheld", async () => {
		const { w, b, before } = await twoRoots();
		const out = aJobInB(b);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).toContain("cannot be tied to one hand");
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w)).toHaveLength(before);
		expect(bodies(w, "hand-settled:")).toEqual([]);
	});

	test("A settled here off its row: B's `wait` showing A's job does not settle B, and A's text is withheld", async () => {
		const { w, b, before } = await twoRoots({ aOffRow: true });
		const out = aJobInB(b);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w)).toHaveLength(before);
		expect(bodies(w, "hand-settled:")).toHaveLength(1); // A's own, from its delivery
	});

	test("A's held hand: a status-only listing of A's finished job in root B does not release pending B: B still spawns", async () => {
		const { w, b } = await twoRoots({ bSpawned: false });
		expect(b.snapshot("wait", { op: "jobs", jobs: [job("sl-y", "completed")] })).toBeUndefined();
		expect((await b.spawn("strong", "sl-y"))?.model).toEqual([OPUS, SOL, KIMI]);
		expect(spawnTokens(w)).toHaveLength(2);
	});
});

describe("a builder hand collected by a job snapshot (T9)", () => {
	test("on its row: one `ran` row and one `hand-settled:`, the content untouched, no round", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		expect((await asyncSpawn(h, w, "c1", "sl-y", "sl-y", "build it"))?.model).toEqual([OPUS, SOL, KIMI]);
		h.handMessage("sl-y", OPUS);
		expect(h.snapshot("wait", { op: "wait", jobs: [job("sl-y", "completed", { resultText: "built it" })] })).toBeUndefined();
		expect(routings(w).map(r => [r.slice_id, r.outcome])).toEqual([["sl-y", "ran"]]);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
		expect(rounds(w)).toEqual([]);
	});

	test("off its row: `refused-out-of-row`, and the text is withheld", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await asyncSpawn(h, w, "c1", "sl-y", "sl-y", "build it");
		h.handMessage("sl-y", FABLE);
		const out = h.snapshot("wait", { op: "wait", jobs: [job("sl-y", "completed", { resultText: SECRET })] }, SECRET);
		expect(out?.isError).toBe(true);
		expect(out?.content?.[0]?.text).not.toContain("SECRET-OUTPUT");
		expect(routings(w).map(r => r.outcome)).toEqual(["refused-out-of-row"]);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
	});
});

describe("U2: a spawned review member whose lane exited (T10)", () => {
	/** Every entry in one millisecond, so only ledger order (created_at, then rowid) says which came first. */
	const freeze = () => setSystemTime(new Date());
	const exit = (w: World, by = LANE_RUNNER_BY) =>
		w.ledger.recordEntry({ by, workloadId: w.wl, kind: "assumption", body: laneExitBody("lane-test", { code: 0, signal: null, outcome: "exited" }) });

	/** Lane A (lane-test) spawns review round 1 of sl-x and its result never arrives; `exit` places A's `lane-exit:`. */
	async function lostRound(opts: { exit: "after" | "before" | "none" | "from-a-lane"; limit?: number }) {
		freeze();
		const w = world();
		if (opts.limit !== undefined) {
			const by = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: roundsInstructionBody(opts.limit), author: JO_HOLDER, channel: "surface" });
			w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: reviewRoundsBody(opts.limit, `rounds ${opts.limit}`, by) });
		}
		const a = lane(w);
		a.laneMessage(OPUS);
		if (opts.exit === "before") exit(w);
		expect((await asyncSpawn(a, w, "c1", "sl-x", "sl-x"))?.model).toEqual([SOL, KIMI]);
		a.handMessage("sl-x", SOL);
		if (opts.exit === "after") exit(w);
		if (opts.exit === "from-a-lane") exit(w, "lane-test");
		expect(new Set(w.ledger.entries(w.wl).map(e => e.created_at)).size).toBe(1);
		const b = lane(w, { laneId: "lane-b" });
		return { w, b, token: spawnTokens(w)[0]!, next: await b.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "c2") };
	}

	test("the next dispatch settles the lost member withheld with unknown findings, and round 2 routes off the builder lab only", async () => {
		const { w, b, token, next } = await lostRound({ exit: "after" });
		expect(next?.reason).toBeUndefined();
		expect(bodies(w, "review-round:")).toEqual([expect.stringContaining(`round 1 token ${token} `)]);
		expect(bodies(w, "review-round:")[0]).toEndWith(" verdict withheld blocking unknown counts unknown");
		const [row] = routings(w);
		expect(routings(w).map(r => [r.agent_id, r.outcome, r.models, r.created_by])).toEqual([["sl-x", "refused-model-unknown", JSON.stringify([SOL, KIMI]), "lane-b"]]);
		expect(bodies(w, "hand-settled:")).toEqual([`hand-settled: ${token} routing ${row!.id}`]);
		const count = countRounds(w.ledger.entries(w.wl), "sl-x");
		expect([count.rounds.map(r => [r.n, r.complete]), count.failed, count.next]).toEqual([[[1, true]], 1, 2]);
		// Settled, the lost hand's row is no builder: anthropic (lane A's own lab) is the only one.
		const spawn = await b.spawn("strong", "sl-x");
		expect(spawn?.reason).toBeUndefined();
		expect(spawn?.model).toEqual([SOL, KIMI]);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds.map(r => r.n)).toEqual([1, 2]);
	});

	test("with no lane-exit:, one written before the spawn, or one a lane wrote, the round still holds", async () => {
		for (const exit of ["none", "before", "from-a-lane"] as const) {
			const { w, next } = await lostRound({ exit });
			expect({ exit, reason: next?.reason }).toEqual({ exit, reason: expect.stringContaining("review round 1 of sl-x is still running") });
			expect(rounds(w)).toEqual([]);
		}
	});

	test("at a limit of 1 the same sweep raises the extend / accept / stop question instead", async () => {
		const { w, next } = await lostRound({ exit: "after", limit: 1 });
		const [q] = w.ledger.questions(w.wl);
		expect(q?.state).toBe("open");
		expect(bodies(w, "review-limit:")).toEqual([`review-limit: ${q!.id} slice sl-x`]);
		expect(next?.reason).toContain(q!.id);
	});
});
