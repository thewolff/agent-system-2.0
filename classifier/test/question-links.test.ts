/**
 * Links on the review round-limit question (PLAN wl-mv66q5b148uznk revision 6, § Slices sl-links-tests,
 * kind "round limit"): a plan-first workload whose plan-slice review is dispatched with a `plan file:`
 * line, a production fan-out round with one member that answered and one that never spawned (dropped),
 * and a round limit of 1, so that round's settle raises the extend / accept / stop question. Its first
 * lines are `plan: <the plan file>` and one `review: <verdict file>` per member of the final round; each
 * verdict file exists under `<dir of the ledger file>/reviews/<wl>/<token>.md`, the dropped member's
 * holding its diagnostic, and the classifier records `plan-file:`, `review-verdict:` and
 * `question-links:` entries.
 *
 * Driven through the classifier extension's own hooks on a fake OMP host, as crosslab.test.ts does, so on
 * origin/main it fails on an assertion (the question carries no header), not on a load error. The
 * `exec` dependency is the seam the build adds for the round-limit question's PR read (`gh pr list`):
 * same shape as OMP's `pi.exec`; it answers no open PR here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { recordRepo } from "../../surface/src/decision-log";
import { planFirstBody } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { type ClassifierDeps, createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { parseReviewRound, reviewLoopEndBody, reviewRoundsBody, roundsInstructionBody } from "../src/rounds";
import { tierTableFromConfig } from "../src/tier-table";
import { asyncDelivery, dist, fakeRegistry, recordedQuestion } from "./helpers";

const ROWS = {
	fast: ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const [OPUS, SOL] = ROWS.strong as [string, string, string];
const ORIGIN = "https://github.com/acme/widgets.git";

/** Every brief whose task starts `review` is a judge slice at 0.9. */
const JUDGE = {
	judge: async ({ state }: { state: string }) => ({
		answers: { kind: /^task: review/m.test(state) ? { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) } : { choice: "change-large", confidence: 0.9, probabilities: dist({ "change-large": 0.9 }) } },
		provider: "typesafe",
		model: "jev-1.13.0",
	}),
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type Handler = (event: unknown, ctx?: unknown) => unknown;

/** The scratch world one test runs in. */
interface World {
	dir: string;
	ledger: Ledger;
	wl: string;
	repo: string;
	plan: string;
	laneFile: string;
}

/**
 * A production, plan-first workload on a temp ledger: the lane's repository (origin on GitHub, recorded
 * as the workload's `repo:`), its session file, the plan file, and Jo's `rounds 1`.
 */
function world(): World {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "question-links-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-links", brief: "question links test", stakes: "production", mode: "autonomous", by: "orch-test" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	for (const id of ["sl-x", "sl-work"]) ledger.addSlice({ id, workloadId: wl, task: id, doneCondition: "d", inputs: "i", by: "lane-test" });
	ledger.recordEntry({ by: "lane-runner", workloadId: wl, kind: "assumption", body: 'lane-started: lane-test {"pid":1}' });
	const by = ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: roundsInstructionBody(1), author: "jo", channel: "surface" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: reviewRoundsBody(1, "rounds 1", by) });
	const repo = join(dir, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "init");
	git(repo, "remote", "add", "origin", ORIGIN);
	recordRepo(ledger, wl, repo);
	const plan = join(dir, "plans", "PLAN.md");
	mkdirSync(dirname(plan));
	writeFileSync(plan, "# PLAN\n");
	mkdirSync(join(dir, "sessions"));
	const laneFile = join(dir, "sessions", "lane.jsonl");
	writeFileSync(laneFile, "");
	return { dir, ledger, wl, repo, plan, laneFile };
}

/** The classifier on the lane's session and its hands' sessions; `exec` is the PR-read seam (gh answers no open PR). */
function lane(w: World, gh?: () => Promise<ExecResult>) {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const execs: { command: string; args: string[] }[] = [];
	const exec = async (command: string, args: string[]): Promise<ExecResult> => {
		execs.push({ command, args });
		if (command === "gh") return gh ? gh() : { stdout: "[]", stderr: "", code: 0, killed: false };
		if (command === "git" && gh && args.includes("remote.origin.url")) return { stdout: `${ORIGIN}\n`, stderr: "", code: 0, killed: false };
		return { stdout: "", stderr: `${command}: not stubbed`, code: 1, killed: false };
	};
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => w.ledger,
		laneId: "lane-test",
		boundWorkload: () => w.wl,
		ompState: () => "same",
		lastWrite: () => null,
		log: () => {},
		fingerprint: () => "unchanged",
		exec,
	} as ClassifierDeps);
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.repo, modelRegistry: fakeRegistry(ALL), sessionManager: { getSessionFile: () => w.laneFile } };
	const root = w.laneFile.slice(0, -".jsonl".length);
	const assistant = (selector: string) => {
		const [provider, ...model] = selector.split("/");
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
	};
	return {
		execs,
		laneMessage: (selector: string) => handlers.message_end!(assistant(selector), ctx),
		shutdown: () => handlers.session_shutdown!({ type: "session_shutdown" }, ctx) as Promise<void>,
		toolCall: (input: unknown, toolCallId: string) => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>,
		spawn: (agent: string, spawnKey: string) =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>,
		handMessage: (agentId: string, selector: string) => handSession.message_end!(assistant(selector), { ...ctx, sessionManager: { getSessionFile: () => `${root}/${agentId}.jsonl` } }),
		asyncReturned: (toolCallId: string, progress: { index: number; id: string; status?: string }[]) =>
			handlers.tool_result!({ type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [], details: { async: { state: "running", jobId: "j", type: "task" }, progress } }, ctx),
		deliver: (agentIds: string[], output: string) => handlers.context!({ type: "context", messages: [asyncDelivery(agentIds, output)] }, ctx),
	};
}

const bodies = (w: World, prefix: string) => w.ledger.entries(w.wl).map((e) => e.body).filter((b) => b.startsWith(prefix));

/** Until `read` is truthy or 200 macrotask turns have passed: a settle that reads `gh` may raise the question after an await. */
async function eventually<T>(read: () => T): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const v = read();
		if (v) return v;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return read();
}

/** Settle a failed final review round whose second fan-out member never spawned. */
async function settleLimit(w: World, h: {
	laneMessage(selector: string): unknown;
	toolCall(input: unknown, toolCallId: string): Promise<{ block?: boolean; reason?: string } | undefined>;
	asyncReturned(toolCallId: string, progress: { index: number; id: string; status?: string }[]): unknown;
	spawn(agent: string, spawnKey: string): Promise<unknown>;
	handMessage(agentId: string, selector: string): unknown;
	deliver(agentIds: string[], output: string): unknown;
}): Promise<void> {
	h.laneMessage(OPUS);
	const brief = `workload: ${w.wl}\ntask: review the plan\ndone-condition: d\ninputs: i\nstakes: production\nceiling-share: 10\nplan file: ${w.plan}`;
	expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief }, "c1"))?.block).toBeUndefined();
	h.asyncReturned("c1", [
		{ index: 0, id: "sl-x--openai", status: "running" },
		{ index: 1, id: "sl-x--kimi", status: "running" },
	]);
	await h.spawn("deep", "sl-x--openai");
	h.handMessage("sl-x--openai", SOL);
	h.deliver(["sl-x--openai"], `Reviewed.\n\n\`\`\`review-findings\n${JSON.stringify({ findings: [{ severity: "blocking", kind: "correctness", title: "missing migration" }] })}\n\`\`\`\n`);
	h.deliver(["sl-x--kimi"], "the job failed before its hand spawned");
}

describe("round limit (PLAN wl-mv66q5b148uznk § The rule, review; New ledger records 1 and 2)", () => {
	test("round limit: the settle that reaches the limit raises a question whose first lines are `plan:` and one `review:` per member verdict file; the files exist and the dropped member's holds its diagnostic", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const brief = `workload: ${w.wl}\ntask: review the plan\ndone-condition: d\ninputs: i\nstakes: production\nceiling-share: 10\nplan file: ${w.plan}`;
		expect((await h.toolCall({ agent: "strong", name: "sl-x", task: brief }, "c1"))?.block).toBeUndefined();
		h.asyncReturned("c1", [
			{ index: 0, id: "sl-x--openai", status: "running" },
			{ index: 1, id: "sl-x--kimi", status: "running" },
		]);
		await h.spawn("deep", "sl-x--openai"); // the kimi member never spawns
		h.handMessage("sl-x--openai", SOL);
		const findings = { findings: [{ severity: "blocking", kind: "correctness", title: "the plan skips the migration" }] };
		h.deliver(["sl-x--openai"], `Reviewed the plan.\n\n\`\`\`review-findings\n${JSON.stringify(findings)}\n\`\`\`\n`);
		// The kimi member's job ends before its hand spawned: it is dropped, and the round is complete.
		h.deliver(["sl-x--kimi"], "the job failed before its hand spawned");

		const rounds = bodies(w, "review-round:").map((b) => parseReviewRound(b)!);
		expect(rounds.map((r) => [r.round, r.verdict]).sort()).toEqual([[1, "accepted"], [1, "dropped"]]);
		const q = await eventually(() => w.ledger.questions(w.wl).find((x) => JSON.parse(x.options).includes("extend")));
		expect(q).toBeDefined();
		expect(JSON.parse(q!.options)).toEqual(["extend", "accept", "stop"]);

		const reviews = join(dirname(w.ledger.path), "reviews", w.wl);
		const accepted = rounds.find((r) => r.verdict === "accepted")!.token;
		const dropped = rounds.find((r) => r.verdict === "dropped")!.token;
		const fileOf = (token: string) => join(reviews, `${token}.md`);
		const lines = q!.body.split("\n");
		expect(lines[0]).toBe(`plan: ${w.plan}`);
		expect([lines[1], lines[2]].sort()).toEqual([`review: ${fileOf(accepted)}`, `review: ${fileOf(dropped)}`].sort());
		expect(lines[3]?.startsWith("review")).toBe(false);

		expect(existsSync(fileOf(accepted))).toBe(true);
		expect(readFileSync(fileOf(accepted), "utf8")).toContain("the plan skips the migration");
		expect(existsSync(fileOf(dropped))).toBe(true);
		const diagnostic = readFileSync(fileOf(dropped), "utf8");
		expect(diagnostic).toContain(dropped);
		expect(diagnostic).toContain("dropped");

		expect(bodies(w, "plan-file:")).toEqual([`plan-file: ${w.plan}`]);
		expect(bodies(w, "review-verdict:").sort()).toEqual([`review-verdict: ${accepted} ${fileOf(accepted)}`, `review-verdict: ${dropped} ${fileOf(dropped)}`].sort());
		expect(bodies(w, `question-links: ${q!.id} `)).toHaveLength(1);
	});

	test("shutdown awaits the deferred raise; a concurrent redispatch refuses without raising twice", async () => {
		const w = world();
		const gh = Promise.withResolvers<ExecResult>();
		let reads = 0;
		const h = lane(w, () => { reads++; return gh.promise; });
		await settleLimit(w, h);
		await eventually(() => reads > 0);
		expect(w.ledger.questions(w.wl)).toHaveLength(0);
		const brief = `workload: ${w.wl}\ntask: review the plan\ndone-condition: d\ninputs: i\nstakes: production\nceiling-share: 10\nplan file: ${w.plan}`;
		let dispatched = false;
		const pendingDispatch = h.toolCall({ agent: "strong", name: "sl-x", task: brief }, "c2").then((r) => { dispatched = true; return r; });
		let shutdownDone = false;
		const shutdown = h.shutdown().then(() => { shutdownDone = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(dispatched).toBe(false);
		expect(shutdownDone).toBe(false);
		expect(reads).toBe(1);
		gh.resolve({ stdout: "[]", stderr: "", code: 0, killed: false });
		expect((await pendingDispatch)?.reason).toContain("question");
		await shutdown;
		expect(shutdownDone).toBe(true);
		expect(w.ledger.questions(w.wl)).toHaveLength(1);
		expect(bodies(w, "review-limit:")).toHaveLength(1);
		expect(reads).toBe(1);
	});

	test("a failed materialization at settle leaves no question, then redispatch raises it after filesystem recovery", async () => {
		const w = world();
		const blocker = join(w.dir, "reviews");
		writeFileSync(blocker, "not a directory");
		const h = lane(w);
		await settleLimit(w, h);
		await h.shutdown();
		expect(w.ledger.questions(w.wl)).toHaveLength(0);
		expect(bodies(w, "review-limit:")).toHaveLength(0);
		expect(bodies(w, "review-round:")).toHaveLength(2);
		const brief = `workload: ${w.wl}\ntask: review the plan\ndone-condition: d\ninputs: i\nstakes: production\nceiling-share: 10\nplan file: ${w.plan}`;
		const failed = await h.toolCall({ agent: "strong", name: "sl-x", task: brief }, "c2");
		expect(failed?.reason).toContain("round-limit question could not be raised");
		expect(w.ledger.questions(w.wl)).toHaveLength(0);
		expect(bodies(w, "review-verdict:")).toHaveLength(0);
		rmSync(blocker);
		const refused = await h.toolCall({ agent: "strong", name: "sl-x", task: brief }, "c3");
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("question");
		expect(w.ledger.questions(w.wl)).toHaveLength(1);
		expect(bodies(w, "review-limit:")).toHaveLength(1);
		expect(bodies(w, "question-links:")).toHaveLength(1);
	});

	test("a deferred raise does not ask for a loop that ended while its PR links were read", async () => {
		const w = world();
		const gh = Promise.withResolvers<ExecResult>();
		let reads = 0;
		const h = lane(w, () => { reads++; return gh.promise; });
		await settleLimit(w, h);
		expect(await eventually(() => reads > 0)).toBe(true);
		w.ledger.recordEntry({ by: "lane-test", workloadId: w.wl, sliceId: "sl-x", kind: "assumption", body: reviewLoopEndBody("sl-x", "pass") });
		gh.resolve({ stdout: "[]", stderr: "", code: 0, killed: false });
		await h.shutdown();
		expect(w.ledger.questions(w.wl)).toHaveLength(0);
		expect(bodies(w, "review-limit:")).toHaveLength(0);
	});
});
