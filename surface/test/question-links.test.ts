/**
 * Links on approve / accept / extend questions (PLAN wl-mv66q5b148uznk revision 6, § The rule, § Question
 * kinds, § New ledger records; § Slices sl-links-tests): one test per kind the surface raises, checks or
 * shows. A linked question carries machinery-computed links (plan file, newest review verdict files, open
 * PRs of `wl/<wl>`) as its first lines; model-authored ones are refused unless the header is exact.
 *
 * Every test drives an entrypoint that exists on origin/main (the lane and orchestrator tools, the
 * ceiling raise in surface/scripts/lane.ts, the wake and its tick, the lane's bash hook), so on main it
 * fails on an assertion. `gh` is stubbed through OMP's `pi.exec` (`fakePi(…, { exec: true })`), which
 * passes git through to the real git; the ceiling raise takes the same runner as its `exec` input.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { handSettledBody, handSpawnBody, laneBuilderBody } from "../../classifier/src/lab";
import { reviewGroupBody, reviewLoopEndBody, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { raiseCeilingQuestion } from "../scripts/lane";
import { CEILING_OPTIONS, type Ceiling, type Spend } from "../src/ceiling";
import { recordRepo } from "../src/decision-log";
import { errorLines } from "../src/errors";
import { doneBody, PLAN_OPTIONS, planFirstBody } from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, git, notices, tempRepo, timeouts, timers, tmp, workloadWithSlice } from "./helpers";

const LANE_MODEL = "anthropic/claude-opus-5-5";
const OTHER_LAB = "openai-codex/gpt-6-astra";
const prUrl = (n: number) => `https://github.com/acme/widgets/pull/${n}`;
// PLAN § The rule: the fixed `none` reasons.
const planNone = (wl: string) => `plan: none — ${wl} is not plan-first: it has no plan slice`;
const reviewNone = (wl: string) => `review: none — no review round has completed on ${wl}`;
const NORMAL: Ceiling = { usd: 50, wallMin: 360 };
const SPEND: Spend = { usd: 41, tokens: 120_000, wallMin: 200 };

const PLAN_REQUIREMENTS = [
	"## Requirements",
	"- R1: Plan approval links the recorded plan and every latest-round verdict => code surface/src/question-links.ts#planLinkProblem; test surface/test/question-links.test.ts",
	"",
].join("\n");

// The lane tool opens its own ledger on the real clock, so the plan test orders its rows by moving the
// system clock: `tick()` freezes it 5 ms later; each test ends on real time.
const tick = () => setSystemTime(new Date(Date.now() + 5));
/** Directories made outside `tmp()` (the plan test's short ledger directory), removed after each test. */
const scratch: string[] = [];
afterEach(() => {
	setSystemTime();
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ExecResult { stdout: string; stderr: string; code: number; killed: boolean }
interface Pr { number: number; url: string }
interface GhStub { prs?: Record<string, Pr[]>; fail?: string }

/**
 * OMP's `pi.exec` answer: `gh pr list … --head <branch>` gets the branch's PRs from `prs` (exit 1 with
 * `fail` when given), git runs for real, anything else exits 0 with no output.
 */
function ghAnswer(gh: GhStub): (command: string, args: string[]) => ExecResult {
	return (command, args) => {
		if (command === "git") {
			const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
			return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode, killed: false };
		}
		if (command !== "gh") return { stdout: "", stderr: "", code: 0, killed: false };
		if (gh.fail !== undefined) return { stdout: "", stderr: gh.fail, code: 1, killed: false };
		if (args[0] !== "pr" || args[1] !== "list") return { stdout: "", stderr: `not stubbed: gh ${args.join(" ")}`, code: 1, killed: false };
		const head = args[args.indexOf("--head") + 1] ?? "";
		return { stdout: JSON.stringify(gh.prs?.[head] ?? []), stderr: "", code: 0, killed: false };
	};
}

/** A canonical git repo whose origin is github.com/acme/widgets, recorded as the workload's `repo:`. */
function seedRepo(ledger: Ledger, wl: string): void {
	const repo = tempRepo();
	expect(git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]).code).toBe(0);
	recordRepo(ledger, wl, repo);
}

const reviewsDir = (ledger: Ledger, wl: string) => join(dirname(ledger.path), "reviews", wl);

let handSeq = 0;
interface Hand { token: string; agentId: string; file: string }

/**
 * One settled review hand of `slice`'s round `round`, as the classifier writes it today: `hand-spawn:`
 * (session root `root`), the judge routing row (ran on OTHER_LAB), `hand-settled:` and an accepted
 * `review-round:`. With `verdict`, also what the build's classifier writes at settle: the verdict file
 * `<ledger dir>/reviews/<wl>/<token>.md` and its `review-verdict:` entry; without, a legacy round.
 */
function seedHand(ledger: Ledger, wl: string, slice: string, o: { by: string; round: number; verdict: boolean; blocking?: number; group?: string; root?: string; token?: string; spawn?: boolean; model?: string }): Hand {
	const n = ++handSeq;
	const token = o.token ?? `dt-ql${n}`;
	const agentId = `${slice}-${n}`;
	const root = o.root ?? `/tmp/${o.by}`;
	const group = o.group ?? `dg-ql${n}`;
	const blocking = o.blocking ?? 0;
	const model = o.model ?? OTHER_LAB;
	const entry = (body: string) => ledger.recordEntry({ by: o.by, workloadId: wl, sliceId: slice, kind: "assumption", body });
	if (o.spawn !== false) entry(handSpawnBody({ token, root, spawnKey: slice, review: true, group, row: [model] }));
	const routing = ledger.recordRouting({
		by: o.by, workloadId: wl, sliceId: slice, spawnKey: slice, sessionRoot: root, agentId,
		kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 }, classifiedTier: "strong", tier: "strong",
		models: [model], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: [model],
	});
	entry(handSettledBody(token, routing));
	entry(reviewRoundBody({
		slice, round: o.round, token, group, verdict: "accepted",
		findings: { counts: { blocking: blocking > 0 ? { correctness: blocking } : {}, major: {}, minor: {} }, titles: [] },
	}));
	const file = join(reviewsDir(ledger, wl), `${token}.md`);
	if (o.verdict) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `verdict: ${blocking > 0 ? "revise" : "approve-as-is"}\n`);
		entry(`review-verdict: ${token} ${file}`);
	}
	return { token, agentId, file };
}

/** The `question-links:` entries recorded for question `q`, oldest first, on any workload. */
function linksOf(ledger: Ledger, q: string, workloads: string[]): string[] {
	return workloads.flatMap((wl) => ledger.entries(wl)).filter((e) => e.body.startsWith(`question-links: ${q} `)).map((e) => e.body);
}

/** Polls `read` (each time on a fresh ledger handle) until it returns something or 200 macrotask turns pass: the tick's catch-up runs after awaits. */
async function eventually<T>(read: () => T | null | undefined): Promise<T | null> {
	for (let i = 0; i < 200; i++) {
		const v = read();
		if (v !== null && v !== undefined) return v;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return null;
}

// ---- lane fixture (lane-tools.test.ts's laneFixture, with the gh stub on) --------------------------

function laneFixture(over: { planFirst?: boolean; ledgerPath?: string } = {}) {
	const path = over.ledgerPath ?? join(tmp("ledger"), "ledger.db");
	const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false });
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the header offset lives in one token") });
	if (over.planFirst) {
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: laneBuilderBody("anthropic", "lane-t-1", LANE_MODEL) });
	}
	ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
	seedRepo(ledger, wl);
	const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-t-1", HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: true });
	orchestratorSurface(f.pi, env, {});
	const ctx = ctxOf();
	const call = async (tool: string, params: Record<string, unknown>) => (await f.tool(tool).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	return { ledger, wl, f, call };
}

// ---- orchestrator fixture (plan-paths' start(), PR #112) --------------------------------------------

function env(): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}
const open = (e: Record<string, string>) => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });

/** The surface started on the seeded ledger with `pi.exec` answering `gh`: the session-start wake taken and its read recorded. */
async function start(e: Record<string, string>, gh: GhStub) {
	timers.length = 0;
	timeouts.length = 0;
	notices.length = 0;
	const f = fakePi(undefined, { exec: true });
	f.execs.answer = ghAnswer(gh);
	orchestratorSurface(f.pi, e, {});
	const ctx = ctxOf();
	await f.emit("session_start", { type: "session_start" }, ctx);
	const first = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as { messages: { content: string }[] };
	await f.tool("orchestrator_wake_read").execute("1", { body: "resuming" }, undefined, undefined, ctx);
	const raise = async (params: Record<string, unknown>) => (await f.tool("orchestrator_raise_question").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	return { f, wake: first.messages[0]!.content, raise };
}

describe("question links: lane questions", () => {
	test("plan: line 1 must be the newest `plan-file:` and the review line one of the plan slice's newest-round verdict files; needs-you shows plan, review and the open PR first", async () => {
		// D7 caps a plan-question line at 160 characters, and the review line names a verdict file under the
		// ledger's directory: a short ledger directory, as the real one (~/.agent-system-2) is.
		const short = mkdtempSync("/tmp/ql-");
		scratch.push(short);
		const { ledger, wl, f, call } = laneFixture({ planFirst: true, ledgerPath: join(short, "ledger.db") });
		f.execs.answer = ghAnswer({ prs: { [`wl/${wl}`]: [{ number: 7, url: prUrl(7) }] } });
		expect(await call("lane_add_slice", { task: "plan the token move", doneCondition: "Jo approves the plan", inputs: "the brief", kind: "judge" })).toMatch(/^Added slice/);
		const planId = ledger.slices(wl)[0]!.id;
		const dir = tmp("plan");
		const PLAN_FILE = join(dir, "PLAN.md");
		const OTHER_PLAN = join(dir, "OLD-PLAN.md");
		writeFileSync(PLAN_FILE, `# PLAN\n\n${PLAN_REQUIREMENTS}`);
		writeFileSync(OTHER_PLAN, `# OLD PLAN\n\n${PLAN_REQUIREMENTS}`);
		tick();
		const r1 = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 1, blocking: 2, verdict: true });
		tick();
		const r2 = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 2, verdict: true });
		tick();
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: `plan-file: ${OTHER_PLAN}` });
		const body = (plan: string, verdict: string) => [plan, "- sl-1: slice 1, one line", "- sl-2: slice 2, one line", "prompt-only: none", "tradeoff: tradeoff 1", `review: approve-as-is, ${OTHER_LAB}, ${verdict}`].join("\n");
		const ask = async (b: string) => {
			tick();
			return await call("lane_raise_question", { slice: planId, body: b, options: [...PLAN_OPTIONS] });
		};

		// Line 1 is not the recorded plan file: refused, naming the recorded one.
		const wrongPlan = await ask(body(PLAN_FILE, r2.file));
		expect(wrongPlan).toContain("Nothing was asked");
		expect(wrongPlan).toContain(OTHER_PLAN);
		expect(ledger.questions(wl)).toHaveLength(0);

		// The newest plan-file: wins; a verdict from round 1 is stale: refused, naming round 2's file.
		tick();
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: `plan-file: ${PLAN_FILE}` });
		const stale = await ask(body(PLAN_FILE, r1.file));
		expect(stale).toContain("Nothing was asked");
		expect(stale).toContain(r2.file);
		expect(ledger.questions(wl)).toHaveLength(0);

		// Both right: raised, with its links recorded in the same write.
		expect(await ask(body(PLAN_FILE, r2.file))).toContain("Raised question");
		const q = ledger.questions(wl)[0]!;
		const links = linksOf(ledger, q.id, [wl]);
		expect(links).toHaveLength(1);
		expect(links[0]).toContain(PLAN_FILE);
		expect(links[0]).toContain(r2.file);
		expect(links[0]).toContain(prUrl(7));

		// Needs-you: the plan path beneath the q- id (#112's layout), then review and pr, then body line 2.
		const line = errorLines(ledger).find((l) => l.rowId === q.id)!.line;
		expect(line).toContain(`(${q.id}, slice ${planId}):\n  ${PLAN_FILE}\n  review: ${r2.file}\n  pr: ${prUrl(7)}\n  - sl-1: `);
	});

	test("plan approval waits for every member of the latest round, from zero through one of two, then links the completed round", async () => {
		const short = mkdtempSync("/tmp/ql-");
		scratch.push(short);
		const { ledger, wl, f, call } = laneFixture({ planFirst: true, ledgerPath: join(short, "ledger.db") });
		f.execs.answer = ghAnswer({});
		await call("lane_add_slice", { task: "plan the cut", doneCondition: "Jo approves the plan", inputs: "the brief", kind: "judge" });
		const planId = ledger.slices(wl)[0]!.id;
		const plan = join(short, "PLAN.md");
		writeFileSync(plan, `# PLAN\n\n${PLAN_REQUIREMENTS}`);
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: `plan-file: ${plan}` });
		// A prior third-lab review stays eligible while the newer two-lab fan-out is in flight.
		const older = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 1, verdict: true, model: "moonshot/kimi-k3" });
		const group = "dg-plan-fan";
		const first = "dt-plan-first";
		const second = "dt-plan-second";
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewGroupBody(planId, group, [first, second]) });
		const body = (file: string) => [plan, "- sl-1: build the cut", "prompt-only: none", "tradeoff: one extra review", `review: approve-as-is, ${OTHER_LAB}, ${file}`].join("\n");
		const ask = (file: string) => call("lane_raise_question", { slice: planId, body: body(file), options: [...PLAN_OPTIONS] });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: handSpawnBody({ token: first, root: short, spawnKey: planId, review: true, group, row: [OTHER_LAB] }) });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: handSpawnBody({ token: second, root: short, spawnKey: planId, review: true, group, row: [LANE_MODEL] }) });
		const before = await ask(older.file);
		expect(before).toContain("0 of 2 members settled");
		expect(before).toContain("wait for all members and retry");
		expect(before).toContain("Nothing was asked");
		expect(ledger.questions(wl)).toHaveLength(0);
		const one = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 1, verdict: true, group, token: first, spawn: false });
		const partial = await ask(one.file);
		expect(partial).toContain("1 of 2 members settled");
		expect(partial).toContain("wait for all members and retry");
		expect(partial).toContain("Nothing was asked");
		expect(ledger.questions(wl)).toHaveLength(0);
		const two = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 1, verdict: true, group, token: second, spawn: false, model: LANE_MODEL });
		expect(await ask(one.file)).toContain("Raised question");
		const q = ledger.questions(wl)[0]!;
		expect(linksOf(ledger, q.id, [wl])[0]).toContain(one.file);
		expect(linksOf(ledger, q.id, [wl])[0]).toContain(two.file);
		expect(ledger.entries(wl).filter((e) => e.body.startsWith("plan-question:"))).toHaveLength(1);
	});

	test("an older complete plan round never stands in for a newer partial round", async () => {
		const short = mkdtempSync("/tmp/ql-");
		scratch.push(short);
		const { ledger, wl, f, call } = laneFixture({ planFirst: true, ledgerPath: join(short, "ledger.db") });
		f.execs.answer = ghAnswer({});
		await call("lane_add_slice", { task: "plan the cut", doneCondition: "Jo approves the plan", inputs: "the brief", kind: "judge" });
		const planId = ledger.slices(wl)[0]!.id;
		const plan = join(short, "PLAN.md");
		writeFileSync(plan, `# PLAN\n\n${PLAN_REQUIREMENTS}`);
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: `plan-file: ${plan}` });
		const old = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 1, verdict: true });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewLoopEndBody(planId, "pass") });
		const group = "dg-newer";
		const first = "dt-newer-first";
		const second = "dt-newer-second";
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewGroupBody(planId, group, [first, second]) });
		const body = (file: string) => [plan, "- sl-1: build the cut", "prompt-only: none", "tradeoff: one extra review", `review: approve-as-is, ${OTHER_LAB}, ${file}`].join("\n");
		const ask = (file: string) => call("lane_raise_question", { slice: planId, body: body(file), options: [...PLAN_OPTIONS] });
		const partial = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 2, verdict: true, group, token: first });
		const reply = await ask(old.file);
		expect(reply).toContain("1 of 2 members settled");
		expect(reply).toContain("wait for all members and retry");
		expect(reply).toContain("Nothing was asked");
		expect(ledger.questions(wl)).toHaveLength(0);
		const full = seedHand(ledger, wl, planId, { by: "lane-t-1", round: 2, verdict: true, group, token: second });
		const stale = await ask(old.file);
		expect(stale).toContain(partial.file);
		expect(stale).toContain("Nothing was asked");
		expect(await ask(full.file)).toContain("Raised question");
		expect(ledger.questions(wl)).toHaveLength(1);
	});

	test("other lane linked question: refused without the header (the reply prints it), a wrong `none` refused, accepted with the header; a gh failure is refused with retry", async () => {
		const { ledger, wl, f, call } = laneFixture();
		f.execs.answer = ghAnswer({});
		const addSlice = async (task: string) => {
			await call("lane_add_slice", { task, doneCondition: "d", inputs: "i", kind: "change-small" });
			return ledger.slices(wl).find((s) => s.task === task)!.id;
		};
		const sl = await addSlice("build the token move");
		const ask = (slice: string, body: string) => call("lane_raise_question", { slice, body, options: ["accept", "rework"] });

		// No header: refused; the reply carries the exact header (nothing reviewed, no PR).
		const bare = await ask(sl, "Accept the token move as built?");
		expect(bare).toContain("Nothing was asked");
		expect(bare).toContain(`${planNone(wl)}\n${reviewNone(wl)}`);
		expect(ledger.questions(wl)).toHaveLength(0);

		// The slice now has a complete round: `review: none` is wrong, and the reply names the verdict file.
		const v = seedHand(ledger, wl, sl, { by: "lane-t-1", round: 1, blocking: 1, verdict: true });
		const wrong = await ask(sl, `${planNone(wl)}\n${reviewNone(wl)}\nAccept the token move as built?`);
		expect(wrong).toContain("Nothing was asked");
		expect(wrong).toContain(`review: ${v.file}`);
		expect(ledger.questions(wl)).toHaveLength(0);

		// The exact header, with the open PR: raised, `question-links:` recorded.
		f.execs.answer = ghAnswer({ prs: { [`wl/${wl}`]: [{ number: 7, url: prUrl(7) }] } });
		const ok = await ask(sl, `${planNone(wl)}\nreview: ${v.file}\npr: ${prUrl(7)}\nAccept the token move as built?`);
		expect(ok).toContain("Raised question");
		const q = ledger.questions(wl)[0]!;
		const links = linksOf(ledger, q.id, [wl]);
		expect(links).toHaveLength(1);
		expect(links[0]).toContain(v.file);
		expect(links[0]).toContain(prUrl(7));

		// gh down: a model-authored question fails closed; the reply carries the error and "retry".
		const sl2 = await addSlice("write the token docs");
		f.execs.answer = ghAnswer({ fail: "error connecting to api.github.com" });
		const down = await ask(sl2, `${planNone(wl)}\nreview (${sl}, round 1): ${v.file}\npr: ${prUrl(7)}\nAccept the docs as written?`);
		expect(down).toContain("Nothing was asked");
		expect(down).toContain("retry");
		expect(down).toContain("error connecting to api.github.com");
		expect(ledger.questions(wl)).toHaveLength(1);
	});

	test("lane question refuses a verdict materialization filesystem failure without asking", async () => {
		const { ledger, wl, f, call } = laneFixture();
		f.execs.answer = ghAnswer({});
		expect(await call("lane_add_slice", { task: "build", doneCondition: "d", inputs: "i", kind: "change-small" })).toMatch(/^Added slice/);
		const sl = ledger.slices(wl)[0]!.id;
		seedHand(ledger, wl, sl, { by: "lane-t-1", round: 1, verdict: false });
		writeFileSync(join(dirname(ledger.path), "reviews"), "not a directory");
		const result = await call("lane_raise_question", { slice: sl, body: "Accept the build?", options: ["accept", "rework"] });
		expect(result).toContain("question links could not be prepared");
		expect(result).toContain("retry");
		expect(result).toContain("Nothing was asked");
		expect(ledger.questions(wl)).toHaveLength(0);
	});

	test("PR at creation: an exit-0 `gh pr create` in the lane's bash records `pr-seen:` from the URL its output ends with; a failed one records nothing", async () => {
		const path = join(tmp("ledger"), "ledger.db");
		const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false });
		const { wl } = workloadWithSlice(ledger);
		const f = fakePi(undefined, { exec: true });
		f.execs.answer = ghAnswer({});
		orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a", HOME: "/nonexistent-home" });
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const create = (id: string, url: string, code: number) =>
			f.emit("tool_result", {
				toolName: "bash", toolCallId: id, input: { command: `gh pr create --title "Token move" --body "b" --head wl/${wl}` },
				content: [{ type: "text", text: `Creating pull request for wl/${wl} into main in acme/widgets\n\n${url}\n` }],
				details: code === 0 ? {} : { exitCode: code }, isError: code !== 0,
			}, ctx);
		await create("b1", prUrl(42), 0);
		const seen = () => ledger.entries(wl).filter((e) => e.body.startsWith("pr-seen:"));
		expect(seen().map((e) => e.body)).toEqual([`pr-seen: 42 ${prUrl(42)}`]);
		expect(seen()[0]!.created_by).toBe("lane-a");
		await create("b2", prUrl(43), 1);
		expect(seen()).toHaveLength(1);
	});
});

describe("question links: orchestrator and machinery questions", () => {
	test("orchestrator: a linked relay must name `about` and carry the header (two reviewed slices, each labelled); the header stays as lines, the rest is flattened", async () => {
		const e = env();
		const l = open(e);
		const { wl, sl: sA } = workloadWithSlice(l, { brief: "Ship the token move" });
		const sB = l.addSlice({ by: "lane-a", workloadId: wl, task: "Write the token docs", doneCondition: "d", inputs: "i" });
		expect(l.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
		seedRepo(l, wl);
		const va = seedHand(l, wl, sA, { by: "lane-a", round: 1, verdict: true });
		const vb = seedHand(l, wl, sB, { by: "lane-a", round: 1, verdict: true });
		l.close();
		const x = await start(e, {});
		const options = ["approve", "deny"];

		const noAbout = await x.raise({ body: "Merge the token move tonight?", options });
		expect(noAbout).toContain("Nothing was asked");
		expect(noAbout).toContain("about");

		const bare = await x.raise({ body: "Merge the token move tonight?", options, about: wl });
		expect(bare).toContain("Nothing was asked");
		expect(bare).toContain(planNone(wl));
		expect(bare).toContain(`review (${sA}, round 1): ${va.file}`);
		expect(bare).toContain(`review (${sB}, round 1): ${vb.file}`);

		const header = [planNone(wl), `review (${sA}, round 1): ${va.file}`, `review (${sB}, round 1): ${vb.file}`].join("\n");
		const ok = await x.raise({ body: `${header}\nMerge the token move\n  tonight?`, options, about: wl });
		expect(ok).toMatch(/^Raised question q-/);
		const id = /q-[a-z0-9]+/.exec(ok)![0];
		const l2 = open(e);
		expect(l2.question(id)!.body).toBe(`${header}\nMerge the token move tonight?`);
		expect(linksOf(l2, id, [STANDING_WORKLOAD_ID, wl])).toHaveLength(1);
		l2.close();
	});

	test("orchestrator question refuses a verdict materialization filesystem failure without asking", async () => {
		const e = env();
		const l = open(e);
		const { wl, sl } = workloadWithSlice(l, { brief: "Legacy review" });
		expect(l.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
		seedRepo(l, wl);
		const x = await start(e, {});
		seedHand(l, wl, sl, { by: "lane-a", round: 1, verdict: false });
		writeFileSync(join(dirname(l.path), "reviews"), "not a directory");
		const result = await x.raise({ body: "Approve the build?", options: ["approve", "deny"], about: wl });
		expect(result).toContain("question links could not be prepared");
		expect(result).toContain("retry");
		expect(result).toContain("Nothing was asked");
		expect(l.questions(wl)).toHaveLength(0);
		l.close();
	});

	test("ceiling: the raise carries the header; with gh down it lists the ledger's PR and `pr: unverified`; the tick's re-read heals it", async () => {
		const e = env();
		const l = open(e);
		const { wl } = workloadWithSlice(l, { brief: "Ceiling workload" });
		expect(l.claimWorkload(wl, { by: "lane-c-1", holder: "lane-c-1", leaseMs: null }).won).toBe(true);
		seedRepo(l, wl);
		l.recordEntry({ by: "lane-c-1", workloadId: wl, kind: "assumption", body: `pr-seen: 17 ${prUrl(17)}` });
		const exec = async (command: string, args: string[]) => ghAnswer({ fail: "error connecting to api.github.com" })(command, args);
		// `exec` is the seam the build adds to the raise (same shape as pi.exec); held in a variable so main's type takes it too.
		const input = { workloadId: wl, laneId: "lane-c-1", spend: SPEND, ceiling: NORMAL, stakes: "normal" as const, exec };
		const { questionId } = await raiseCeilingQuestion(l, input);
		const lines = l.question(questionId)!.body.split("\n");
		expect(lines[0]).toBe(planNone(wl));
		expect(lines[1]).toBe(reviewNone(wl));
		const head = lines.slice(0, lines.findIndex((x) => x.startsWith(`${wl} has used $`)));
		expect(head).toContain(`pr: ${prUrl(17)}`);
		expect(head.filter((x) => x.startsWith("pr: unverified — gh pr list failed: "))).toHaveLength(1);
		expect(head.join("\n")).toContain("error connecting to api.github.com");
		expect(linksOf(l, questionId, [wl])).toHaveLength(1);
		l.close();

		// gh answers now: the tick re-reads the unverified question's PRs and records a newer entry.
		await start(e, { prs: { [`wl/${wl}`]: [{ number: 17, url: prUrl(17) }] } });
		timers[0]!.fn();
		const healed = await eventually(() => {
			const r = open(e);
			try {
				const ls = linksOf(r, questionId, [wl]);
				return ls.length > 1 ? ls.at(-1)! : null;
			} finally {
				r.close();
			}
		});
		expect(healed).not.toBeNull();
		// The entry is `question-links: <q> <Links JSON>`: the healed read lists exactly the open PR and is no longer unverified.
		const healedLinks = JSON.parse(healed!.slice(`question-links: ${questionId} `.length)) as { prs: { prs: { number: number; url: string }[]; unverified: string | null } };
		expect(healedLinks.prs.unverified).toBeNull();
		expect(healedLinks.prs.prs).toEqual([{ number: 17, url: prUrl(17) }]);
	});

	test("already open: a ceiling and a plan question raised the old way, no `question-links:` — the wake's needs-you shows their links first, and the tick records the entries", async () => {
		const e = env();
		const l = open(e);
		const c = workloadWithSlice(l, { brief: "Ceiling workload" });
		expect(l.claimWorkload(c.wl, { by: "lane-c-1", holder: "lane-c-1", leaseMs: null }).won).toBe(true);
		seedRepo(l, c.wl);
		const csl = l.addSlice({
			by: LANE_RUNNER_BY, workloadId: c.wl, id: `sl-ceiling-${c.wl.slice(3)}-1`, task: "Jo decides the ceiling overrun",
			doneCondition: "Jo answers stop, extend or split for the ceiling 50/360", inputs: "ceiling",
		});
		// A pre-links question, deliberately recorded without the now-required machinery header.
		const legacyCeilingBody = [
			`${c.wl} has used $41.00 of its $50 ceiling (82 %) and 200 of 360 minutes (55 %), normal stakes; 120000 tokens.`,
			"stop (the default): the lane keeps working and is stopped at the ceiling; nothing relaunches.",
			`extend: the ceiling grows by one more block of this workload's own size and the lane goes on (a stopped lane relaunches); for an exact figure say \`ceiling <usd> [<hours>] ${c.wl}\` instead.`,
			"split: the lane is stopped at the ceiling like stop, and the remaining work is split into a new workload; nothing relaunches here.",
		].join("\n");
		const cq = l.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: c.wl, sliceId: csl, body: legacyCeilingBody, options: [...CEILING_OPTIONS] });

		const p = workloadWithSlice(l, { brief: "Plan workload" });
		l.recordEntry({ by: SURFACE_BY, workloadId: p.wl, kind: "assumption", body: planFirstBody("your word") });
		expect(l.claimWorkload(p.wl, { by: "lane-p-1", holder: "lane-p-1", leaseMs: null }).won).toBe(true);
		seedRepo(l, p.wl);
		const legacy = seedHand(l, p.wl, p.sl, { by: "lane-p-1", round: 1, verdict: false });
		const P = join(tmp("plan"), "PLAN.md");
		writeFileSync(P, `# PLAN\n\n${PLAN_REQUIREMENTS}`);
		const pq = l.write(() => {
			const id = l.raiseQuestion({
				by: "lane-p-1", workloadId: p.wl, sliceId: p.sl, options: [...PLAN_OPTIONS],
				body: [P, "- sl-build: build the change, one line", "prompt-only: none", "tradeoff: one more message on screen", `review: approve-as-is, ${OTHER_LAB}, /tmp/PLAN-REVIEW-r1.md`].join("\n"),
			});
			l.recordEntry({ by: "lane-p-1", workloadId: p.wl, sliceId: p.sl, kind: "assumption", body: `plan-question: ${id}` });
			return id;
		});
		const legacyFile = join(reviewsDir(l, p.wl), `${legacy.token}.md`);
		l.close();

		const x = await start(e, {});
		const needs = x.wake.slice(x.wake.indexOf("## needs you"));
		expect(needs).toContain(`(${cq}, slice ${csl}):\n  ${planNone(c.wl)}\n  ${reviewNone(c.wl)}\n`);
		expect(needs).toContain(`(${pq}, slice ${p.sl}):\n  ${P}\n  review: ${legacyFile}\n`);

		timers[0]!.fn();
		const recorded = await eventually(() => {
			const r = open(e);
			try {
				const ls = [...linksOf(r, cq, [c.wl]).map(() => cq), ...linksOf(r, pq, [p.wl]).map(() => pq)];
				return ls.includes(cq) && ls.includes(pq) ? [...r.entries(c.wl), ...r.entries(p.wl)].filter((x) => x.body.startsWith("question-links: ")) : null;
			} finally {
				r.close();
			}
		});
		expect(recorded).not.toBeNull();
		expect(recorded!.map((x) => x.created_by)).toEqual([SURFACE_BY, SURFACE_BY]);
	});

	test("legacy round: a settled round with no `review-verdict:` and one dropped member gets one verdict file per member when a linked question is raised", async () => {
		const e = env();
		const l = open(e);
		const { wl, sl } = workloadWithSlice(l, { brief: "Legacy round workload" });
		expect(l.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
		seedRepo(l, wl);
		const root = tmp("session");
		const group = "dg-legacy";
		const acc = seedHand(l, wl, sl, { by: "lane-a", round: 1, blocking: 1, verdict: false, group, root });
		writeFileSync(join(root, `${acc.agentId}.md`), "LEGACY REPLY: the cache is never invalidated\n");
		const dropped = "dt-legacy-dropped";
		const entry = (body: string) => l.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body });
		entry(reviewGroupBody(sl, group, [acc.token, dropped]));
		entry(reviewRoundBody({ slice: sl, round: 1, token: dropped, group, verdict: "dropped", findings: UNKNOWN }));
		l.close();

		const x = await start(e, {});
		const reply = await x.raise({ body: "Approve the cache fix?", options: ["approve", "deny"], about: wl });
		expect(reply).toContain("Nothing was asked");
		const dir = join(dirname(open(e).path), "reviews", wl);
		const accFile = join(dir, `${acc.token}.md`);
		const dropFile = join(dir, `${dropped}.md`);
		expect(reply).toContain(`review (${sl}, round 1): ${accFile}`);
		expect(reply).toContain(`review (${sl}, round 1): ${dropFile}`);
		const l2 = open(e);
		expect(l2.entries(wl).filter((x) => x.body.startsWith("review-verdict: ")).map((x) => x.body).sort()).toEqual(
			[`review-verdict: ${acc.token} ${accFile}`, `review-verdict: ${dropped} ${dropFile}`].sort(),
		);
		l2.close();
		expect(existsSync(accFile)).toBe(true);
		expect(existsSync(dropFile)).toBe(true);
		expect(readFileSync(accFile, "utf8")).toContain("LEGACY REPLY: the cache is never invalidated");
		const diag = readFileSync(dropFile, "utf8");
		expect(diag).toContain(dropped);
		expect(diag).toContain("dropped");
	});
});
