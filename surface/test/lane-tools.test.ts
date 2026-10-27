// The lane's ledger tools and the plan-first / outcome machinery (DESIGN-lane-launcher.md § 8:
// lifecycle transition and plan-first tests), driven through the fake extension API: ownership
// refusals, reserved and pushed prefixes refused with nothing written, plan-first enforcement
// through Jo's answer at the surface, the plan question held until another lab reviewed the plan
// (PLAN wl-mupu0sx2o046io D8, and its D9 round-limit exception), and the terminal pair ending the
// lane without a death.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	handSettledBody, handSpawnBody, laneBuilderBody, PARK_OPTIONS, reviewParkBody, reviewSameLabBody, reviewWithheldBody,
} from "../../classifier/src/lab";
import {
	countRounds, effectiveRoundLimit, ROUND_LIMIT_OPTIONS, reviewLimitBody, reviewLoopEndBody, reviewRoundBody, reviewRoundsExtendBody, roundLimitQuestionBody, UNKNOWN,
	type LoopEndReason,
} from "../../classifier/src/rounds";
import { gateSession } from "../../gates/src/session";
import { Ledger, type RoutingOutcome, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines, reservedStates, waitingReserved } from "../src/errors";
import { renderWake } from "../src/render";
import { planAutoStartRound, planReviewRefusal, TEST_RUNNER_SCRIPT } from "../extensions/lane-tools";
import { apply, interpret } from "../src/input";
import {
	CLASSIFIER_MACHINERY_PREFIXES, controlEntries, holdersOf, PLAN_FILE_MAX_BYTES, PLAN_OPTIONS, PLAN_REQUIREMENTS_SHAPE, planApprovedBody, planFirst, planFirstBody, doneBody,
} from "../src/launch";
import { testRequestedBody } from "../src/test-run";
import { releasedOpen } from "../src/turn-end";
import { recordRepo, renderClose } from "../src/decision-log";
import { openPlanPath } from "../src/plan-paths";
import { ESCALATION_BY, LANE_FULL_TEST_TOOL, LANE_RAISE_QUESTION_TOOL, LANE_READ_FACTS_TOOL, LANE_TOOLS, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, notices, tempLedger, tmp } from "./helpers";

const LANE_MODEL = "anthropic/claude-opus-5-5";
const OTHER_LAB = "openai-codex/gpt-6-astra";

// PLAN wl-muq22rnjcfrrpc D7: the plan file and the review verdict a plan question names are real files.
// PLAN wl-mv8vwb04cy18n4 D1: the plan file carries a `## Requirements` section; this one marks no requirement prompt-only.
const PLAN_DIR = tmp("plan");
const PLAN_FILE = join(PLAN_DIR, "PLAN.md");
const VERDICT_FILE = join(PLAN_DIR, "r.md");
writeFileSync(PLAN_FILE, [
	"# PLAN", "", "## Design", "", "The header offset moves into one token.", "",
	"## Requirements", "",
	"- R1: the header offset lives in one token => test surface/test/tokens.test.ts; code src/tokens.ts headerOffset",
	"- R2: the old constant is gone => test surface/test/tokens.test.ts the constant case",
	"", "## Slices", "", "| Slice | Kind |", "|---|---|",
].join("\n"));
writeFileSync(VERDICT_FILE, "verdict: approve-as-is\n");
const REVIEW_LINE = `review: approve-as-is, ${OTHER_LAB}, ${VERDICT_FILE}`;
const NONE_LINE = "prompt-only: none";
/** A plan-question body in D7's shape: the plan path, `slices` slice lines, `prompt-only: none` (PLAN wl-mv8vwb04cy18n4 D2), `tradeoffs` tradeoff lines, the review line. */
const planBody = (slices = 2, tradeoffs = 1) => [
	PLAN_FILE,
	...Array.from({ length: slices }, (_, i) => `- sl-${i + 1}: slice ${i + 1}, one line`),
	NONE_LINE,
	...Array.from({ length: tradeoffs }, (_, i) => `tradeoff: tradeoff ${i + 1}`),
	REVIEW_LINE,
].join("\n");
const PLAN_BODY = planBody();
/** Writes a plan file `name` under PLAN_DIR from `lines` (joined with `eol`) and returns its absolute path. */
const planFile = (name: string, lines: string[], eol = "\n") => {
	const path = join(PLAN_DIR, name);
	writeFileSync(path, lines.join(eol));
	return path;
};
/** A plan file whose Requirements section marks R2 and R3 prompt-only (PLAN wl-mv8vwb04cy18n4 D1, D2). */
const PROMPT_ONLY_FILE = planFile("PLAN-prompt-only.md", [
	"# PLAN", "", "## Requirements", "",
	"- R1: the refusal names the grammar => test surface/test/lane-tools.test.ts",
	"- R2: the SPEC amendment states the rule => prompt-only: human-read prose no code can judge",
	"- R3: the change reaches main only by Jo's merge => prompt-only: no gate refuses a lane's merge here",
]);
const PROMPT_ONLY_LINES = [
	"prompt-only: R2: the SPEC amendment states the rule; prose no code can judge",
	"prompt-only: R3: the change reaches main only by Jo's merge; no gate refuses it",
];
/** A plan-question body on `path`: one slice line, `promptOnly` lines, one tradeoff, the review line. */
const bodyOn = (path: string, promptOnly: string[]) => [path, "- sl-1: slice 1, one line", ...promptOnly, "tradeoff: tradeoff 1", REVIEW_LINE].join("\n");
/**
 * The holder's `plan-question:` entry for `id` as lane_raise_question writes it (fix round 1, F1): the sha256 of the plan file
 * and of the verdict file it was checked on. Hashed here with node:crypto, so this file loads on the baseline.
 */
const boundPlanQuestion = (id: string, plan = PLAN_FILE, verdict = VERDICT_FILE) => {
	const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
	return `plan-question: ${id} plan-sha256 ${sha(plan)} verdict-sha256 ${sha(verdict)}`;
};

function laneFixture(over: { planFirst?: boolean; mode?: "autonomous" | "user-driven"; exec?: boolean; stakes?: "normal" | "production" } = {}) {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: over.stakes ?? "normal", mode: over.mode ?? "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the header offset lives in one token") });
	if (over.planFirst) {
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
		// The classifier's record of the lab the planning lane answered on (D3 item 1): the plan's builder.
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: laneBuilderBody("anthropic", "lane-t-1", LANE_MODEL) });
	}
	ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: `launch: lane-t-1 cause first requested-by test` });
	expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
	const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-t-1", HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: over.exec ?? false });
	orchestratorSurface(f.pi, env, {});
	const ctx = ctxOf();
	const call = async (tool: string, params: Record<string, unknown>) => (await f.tool(tool).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	return { ledger, path, wl, env, f, ctx, call };
}

// The tool opens its own ledger on the real clock (gates/src/session.ts), so the D8 tests order
// their rows by moving the system clock: `tick()` freezes it 5 ms later; each test ends on real time.
const tick = () => setSystemTime(new Date(Date.now() + 5));
afterEach(() => setSystemTime());

let handSeq = 0;

/**
 * One settled review hand on `slice`, written as the classifier writes it (PLAN D2–D6, D9): an
 * optional spent `review-same-lab:` grant or Jo's Kimi-out `review-same-lab-rule:` line naming
 * `rule` as its slice (PLAN wl-mv5xay6bjp0268 § 2.2, a string literal so it loads on the baseline),
 * `hand-spawn:` (by `spawnBy`, the lane by default, after a `gap` entry and then the `between`
 * entries when given), the judge routing row, `review-withheld:` when asked, `hand-settled:`, and a
 * `review-round:` when `round` is given. Ticks the clock on both sides so its rows sort strictly
 * between the questions before and after it.
 */
function seedReview(
	ledger: Ledger, wl: string, slice: string,
	over: {
		ran?: string[]; outcome?: RoutingOutcome; withheld?: boolean; grant?: string; rule?: string; gap?: string; spawnBy?: string; group?: string; round?: number;
		blocking?: number; between?: (token: string) => { body: string; by?: string }[];
	} = {},
): { token: string; routing: string } {
	tick();
	const n = ++handSeq;
	const token = `dt-t${n}`;
	const group = over.group ?? `dg-t${n}`;
	const ran = over.ran ?? [OTHER_LAB];
	const outcome = over.outcome ?? "ran";
	const entry = (body: string, by = "lane-t-1") => ledger.recordEntry({ by, workloadId: wl, sliceId: slice, kind: "assumption", body });
	if (over.grant) entry(reviewSameLabBody(over.grant, token));
	if (over.rule) entry(`review-same-lab-rule: in-mv5xafhywe3w8w slice ${over.rule} token ${token} labs anthropic kimi no kimi entry in the deep review row (KIMI_OUT_RULE.rowOmission)`);
	if (over.gap) entry(over.gap);
	for (const b of over.between?.(token) ?? []) entry(b.body, b.by);
	entry(handSpawnBody({ token, root: "/tmp/lane-t-1", spawnKey: slice, review: true, group, row: ran }), over.spawnBy);
	const routing = ledger.recordRouting({
		by: "lane-t-1", workloadId: wl, sliceId: slice, spawnKey: slice, sessionRoot: "/tmp/lane-t-1", agentId: `${slice}-${n}`,
		kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 }, classifiedTier: "strong", tier: "strong",
		models: ran, judgeModel: "typesafe/jev-1.13.0", outcome, ranModels: outcome === "refused-model-unknown" ? null : ran,
	});
	if (over.withheld) entry(reviewWithheldBody(token));
	entry(handSettledBody(token, routing));
	if (over.round !== undefined) {
		const blocking = over.blocking ?? 0;
		entry(reviewRoundBody({
			slice, round: over.round, token, group, verdict: over.withheld || outcome !== "ran" ? "withheld" : "accepted",
			findings: { counts: { blocking: blocking > 0 ? { correctness: blocking } : {}, major: {}, minor: {} }, titles: [] },
		}));
	}
	tick();
	return { token, routing };
}

/** Jo's answer at the surface, through the ledger module, a tick after what came before. */
function jo(ledger: Ledger, questionId: string, answer: string): string {
	tick();
	return ledger.answerQuestion(questionId, { by: SURFACE_BY, answer, author: "jo", channel: "surface" });
}

describe("T4: lane-written handles stay raw on disk", () => {
	test("entry, message and plan question expand caller-local paths before storage and preserve openPlanPath and decision logs", async () => {
		const x = laneFixture({ planFirst: true });
		Object.assign(x.ctx.sessionManager, { getSessionFile: () => join(PLAN_DIR, "lane.jsonl"), getSessionId: () => "lane-local" });
		Object.assign(x.ctx, { localProtocolOptions: { getArtifactsDir: () => PLAN_DIR } });
		// Optional on the baseline: absence of the new machinery must fail a stored-body assertion, not module loading.
		const linksPath = join(import.meta.dir, "..", "..", "gates", "src", "links.ts");
		const links = await import(linksPath).catch((error: Error & { code?: string }) => {
			if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") return undefined;
			throw error;
		});
		links?.setLinkRouter({
			async locate(handle: string, rc: { localProtocolOptions?: { getArtifactsDir?(): string }; sessionId?: string; rules: unknown[] }) {
				expect(rc.sessionId).toBe("lane-local");
				expect(rc.rules).toEqual([]);
				return handle === "local://PLAN.md" ? join(rc.localProtocolOptions!.getArtifactsDir!(), "PLAN.md") : null;
			},
			locateSync() { return undefined; },
		});
		try {
			expect(await x.call("lane_record_entry", { body: "Read local://PLAN.md" })).toContain("Recorded entry");
			expect(x.ledger.entries(x.wl).at(-1)!.body).toBe(`Read ${PLAN_FILE}`);
			expect(await x.call("lane_message", { body: "Review local://PLAN.md and artifact://missing" })).toContain("Sent message");
			expect(x.ledger.inFlight().find((w) => w.workload.id === x.wl)!.pendingMessages.at(-1)!.body).toBe(`Review ${PLAN_FILE} and artifact://missing`);
			await x.call("lane_add_slice", { task: "plan", doneCondition: "approved", inputs: "brief", kind: "judge", id: "sl-local-plan" });
			seedReview(x.ledger, x.wl, "sl-local-plan");
			const body = PLAN_BODY.replace(PLAN_FILE, "local://PLAN.md");
			expect(await x.call("lane_raise_question", { slice: "sl-local-plan", body, options: ["approve", "revise", "cancel"] })).toContain("Raised question");
			const q = x.ledger.questions(x.wl).at(-1)!;
			expect(q.body).toBe(PLAN_BODY);
			expect(openPlanPath(x.ledger, q.id)).toBe(PLAN_FILE);
			const log = renderClose(x.ledger, x.wl, PLAN_DIR, null, { write: false });
			expect(log.text).toContain(PLAN_FILE);
			expect(log.text).not.toContain("local://PLAN.md");
			expect(log.text).not.toContain("file://");
			expect(q.body).not.toContain("](");
		} finally {
			links?.setLinkRouter(undefined);
		}
	});
});

describe("lane tools: ownership", () => {
	test("all ten register; an orchestrator session and an unbound lane are refused with nothing written", async () => {
		const { ledger, path, wl } = laneFixture();
		const orch = fakePi();
		orchestratorSurface(orch.pi, { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" }, {});
		for (const t of LANE_TOOLS) expect(orch.registered()).toContain(t);
		const before = ledger.entries(wl).length;
		const r = await orch.tool("lane_record_entry").execute("1", { body: "hello" }, undefined, undefined, ctxOf());
		expect(r.content[0]!.text).toContain("not a lane bound to a workload");
		expect(ledger.entries(wl).length).toBe(before);
	});

	test("a lane that is not the holder under a live lease is refused, naming the holder", async () => {
		const { ledger, wl, call } = laneFixture();
		ledger.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
		expect(ledger.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 }).won).toBe(true);
		expect(await call("lane_record_entry", { body: "mine" })).toContain("held by lane-x, not by this lane (lane-t-1)");
		expect(ledger.entries(wl).some((e) => e.body === "mine")).toBe(false);
	});
});

describe("lane tools: reserved and pushed prefixes are refused and write nothing", () => {
	test("each control prefix through record_entry (except done-because:), message and raise_question", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const before = { entries: ledger.entries(wl).length, held: ledger.workload(wl)!.held_messages, questions: ledger.questions(wl).length };
		// The scratch lines (PLAN wl-mv5oikd5jtquww § 1.5) are machinery's too: a lane cannot hide its over-cap line with a forged scratch-under-cap:.
		const scratch = ["scratch-over-cap", "scratch-under-cap", "scratch-disk", "scratch-disk-ok", "scratch-removed", "scratch-remove-failed"];
		for (const p of ["launch", "launch-failed", "launch-requested", "lane-started", "lane-ready", "lane-exit", "lane-parked", "lane-stop", "lane-decided", "worktree", "branch", "plan", "done", "artifact-tree", "reserved-withdrawn", "released-open", "plan-question", "test-requested", "test-run", "push-dest", "superseded", "test-pr", "lane-headroom", "queued", "withdrawn", ...scratch]) {
			expect(await call("lane_record_entry", { body: `${p}: forged` })).toContain(`\`${p}:\` is a reserved control line`);
			expect(await call("lane_message", { body: `${p}: forged` })).toContain("reserved control line");
			expect(await call("lane_raise_question", { slice: sl, body: `${p}: forged`, options: ["a", "b"] })).toContain("reserved control line");
		}
		expect(await call("lane_message", { body: "done-because: forged" })).toContain("reserved control line");
		for (const p of ["lane-died:", "prompt-wait:", "prompt-resolved:", "artifact-failed:", "artifact-passed:", "test-run-failed:"]) {
			expect(await call("lane_message", { body: `${p} x` })).toContain("signal the machinery pushes");
		}

		expect(ledger.entries(wl).length).toBe(before.entries);
		expect(ledger.workload(wl)!.held_messages).toBe(before.held);
		expect(ledger.questions(wl).length).toBe(before.questions);
		// The one allowed control line: the holder's done-because: receipt.
		expect(await call("lane_record_entry", { body: "done-because: the token exists and the header reads it" })).toContain("completion receipt");
		expect(await call("lane_raise_question", { slice: sl, body: "which?", options: ["a", "A"] })).toContain("at least two distinct options");
		// D1 (PLAN wl-mv5msri070p0qo): an option is one word, as orchestrator_raise_question already requires.
		expect(await call("lane_raise_question", { slice: sl, body: "which?", options: ["go on", "stop"] })).toBe("Each option is one word (Jo answers with it alone or as `<option> q-…`); nothing was asked.");
		expect(ledger.questions(wl).length).toBe(before.questions);
	});

	test("every classifier machinery line is refused by lane_record_entry with nothing recorded, so a forged failed-dispatch leaves the round running (PLAN wl-mv64rsqw2fcs1s D5)", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "review", doneCondition: "d", inputs: "i" });
		// A dead lane's review hand, spawned and never settled: round 1 of the slice is running.
		const token = "dt-lost";
		ledger.recordEntry({
			by: "lane-t-0", workloadId: wl, sliceId: sl, kind: "assumption",
			body: handSpawnBody({ token, root: "/tmp/lane-t-0", spawnKey: sl, review: true, group: "dg-lost", row: [OTHER_LAB] }),
		});
		const running = () => countRounds(ledger.entries(wl), sl).rounds.map((r) => [r.n, r.complete]);
		expect(running()).toEqual([[1, false]]);
		const before = ledger.entries(wl).length;
		const forged: Record<string, string> = {
			"review-round": reviewRoundBody({ slice: sl, round: 1, token, group: "dg-lost", verdict: "failed-dispatch", findings: UNKNOWN }),
			"review-loop-end": reviewLoopEndBody(sl, "pass"),
			"hand-settled": handSettledBody(token, "rt-forged"),
		};
		for (const p of CLASSIFIER_MACHINERY_PREFIXES) {
			const body = forged[p] ?? `${p}: forged ${token}`;
			expect({ p, reply: await call("lane_record_entry", { body }) }).toEqual({ p, reply: expect.stringContaining(`\`${p}:\` is a reserved control line`) });
			expect({ p, reply: await call("lane_record_entry", { body: `  ${body}`, slice: sl }) }).toEqual({ p, reply: expect.stringContaining(`\`${p}:\` is a reserved control line`) });
		}
		expect(ledger.entries(wl).length).toBe(before);
		expect(running()).toEqual([[1, false]]);
		// A note that only opens with the word, not the `word:` line, is still the lane's own.
		expect(await call("lane_record_entry", { body: "review-round 1 looked slow to the lane" })).toContain("Recorded entry");
	});

	test("PLAN wl-mv71x5rwdu7eo0 §§ 3-4: the quota guard's lines, the classifier's headroom-skip: and the runner's lane-headroom:, are refused by lane_record_entry with nothing recorded", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const before = ledger.entries(wl).length;
		const bodies = [
			"headroom-skip: anthropic/claude-opus-5-5 token dt-a anthropic 5h 0.85 used > 0.80",
			"lane-headroom: lane-t-1 anthropic/claude-opus-5-5 -> openai-codex/gpt-6.1-sol (anthropic 5h 0.85 used > 0.80)",
		];
		for (const body of bodies) {
			const p = body.slice(0, body.indexOf(":"));
			expect({ p, reply: await call("lane_record_entry", { body }) }).toEqual({ p, reply: expect.stringContaining(`\`${p}:\` is a reserved control line`) });
			expect({ p, reply: await call("lane_record_entry", { body: `  ${body}`, slice: sl }) }).toEqual({ p, reply: expect.stringContaining(`\`${p}:\` is a reserved control line`) });
		}
		expect(ledger.entries(wl).length).toBe(before);
	});
});

describe("lane_raise_question through Jo's standing rulings (PLAN wl-mvfkv7llkp7nk0 § 1, R1–R3)", () => {
	// Inside the Kimi-out window, on the clock askJo reads.
	const IN_WINDOW = new Date("2026-10-20T12:00:00-07:00");
	const applied = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("ruling-applied:")).map((e) => [e.body, e.created_by]);

	test("a question a ruling decides writes no question row, keeps the slice open, records the lane's ruling-applied entry and returns the decided text", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const reply = await call("lane_raise_question", { slice: sl, body: "Open the docs workload now or later?", options: ["open", "later"] });
		expect(reply).toStartWith("decided by Jo's ruling flow-repair: queue it and tell Jo `queued, position N`");
		expect(reply).toContain("no question was raised; do not publish a QUESTION block");
		expect(ledger.questions(wl)).toEqual([]);
		expect(ledger.slice(sl)!.state).toBe("open");
		expect(applied(ledger, wl)).toEqual([[`ruling-applied: flow-repair kind open-workload slice ${sl} answer later`, "lane-t-1"]]);
	});

	test("merges: a normal-stakes lane's merge question is decided; a production lane's is raised", async () => {
		const normal = laneFixture();
		const sl = normal.ledger.addSlice({ by: "lane-t-1", workloadId: normal.wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(await normal.call("lane_raise_question", { slice: sl, body: "PR #4 is green; merge it?", options: ["merge", "wait"] })).toContain("decided by Jo's ruling merges");
		expect(normal.ledger.questions(normal.wl)).toEqual([]);

		const prod = laneFixture();
		prod.ledger.setStakes(prod.wl, { by: SURFACE_BY, stakes: "production" });
		const sp = prod.ledger.addSlice({ by: "lane-t-1", workloadId: prod.wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(await prod.call("lane_raise_question", { slice: sp, body: "PR #4 is green; merge it?", options: ["merge", "wait"] })).toContain("Raised question");
		expect(applied(prod.ledger, prod.wl)).toEqual([]);
	});

	test("kimi-out: a same-lab question is decided in the window when the builders are known and exclude Kimi; with a Kimi builder it is raised", async () => {
		setSystemTime(IN_WINDOW);
		const ok = laneFixture();
		ok.ledger.recordEntry({ by: "lane-t-1", workloadId: ok.wl, kind: "assumption", body: laneBuilderBody("anthropic", "lane-t-1", LANE_MODEL) });
		const sl = ok.ledger.addSlice({ by: "lane-t-1", workloadId: ok.wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(await ok.call("lane_raise_question", { slice: sl, body: "Kimi is out; review same-lab?", options: [...PARK_OPTIONS] })).toContain("decided by Jo's ruling kimi-out: re-dispatch the review");
		expect(ok.ledger.questions(ok.wl)).toEqual([]);

		const kimi = laneFixture();
		kimi.ledger.recordEntry({ by: "lane-t-1", workloadId: kimi.wl, kind: "assumption", body: laneBuilderBody("kimi", "lane-t-1", "moonshot/kimi-k3") });
		const sk = kimi.ledger.addSlice({ by: "lane-t-1", workloadId: kimi.wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(await kimi.call("lane_raise_question", { slice: sk, body: "Kimi is out; review same-lab?", options: [...PARK_OPTIONS] })).toContain("Raised question");
	});

	test("a model question declares its subject: refused without one, decided as a lane-model question with it", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const options = [LANE_MODEL, "openai-codex/gpt-6.1-sol"];
		expect(await call("lane_raise_question", { slice: sl, body: "Which model should this lane run on?", options })).toContain("declare `subject`");
		expect(await call("lane_raise_question", { slice: sl, body: "Ship?", options: ["ship", "hold"], subject: "lane-model" })).toContain("only when every option");
		expect(ledger.questions(wl)).toEqual([]);
		expect(await call("lane_raise_question", { slice: sl, body: "Which model should this lane run on?", options, subject: "lane-model" })).toContain(
			`decided by Jo's ruling models: run the lane on ${LANE_MODEL}`,
		);
		expect(ledger.questions(wl)).toEqual([]);
	});

	test("a lane cannot forge ruling-applied: through lane_record_entry", async () => {
		const { ledger, wl, call } = laneFixture();
		const before = ledger.entries(wl).length;
		expect(await call("lane_record_entry", { body: "ruling-applied: merges kind merge slice sl-x answer train" })).toContain("`ruling-applied:` is written only when a standing ruling decides");
		expect(ledger.entries(wl).length).toBe(before);
	});
});

describe("lane_full_test (PLAN wl-muraerdsgw7gn4 § 2.1, § 4)", () => {
	const REPO = join(import.meta.dir, "..", "..");
	const LINE = "test-run tr-0abc1234wxyz runner 4242 sha " + "a".repeat(40) + " slice sl-full-x-1 log /runs/tr-0abc1234wxyz/runner.log";

	test("execs the installed starter from the main checkout with only the PR, the slice and this lane, and returns its line", async () => {
		const { ledger, wl, f, call } = laneFixture({ exec: true });
		expect(TEST_RUNNER_SCRIPT).toBe(join(REPO, "surface", "scripts", "test-runner.ts"));
		f.execs.answer = () => ({ stdout: `starting\n${LINE}\n`, stderr: "", code: 0, killed: false });
		const r = await call(LANE_FULL_TEST_TOOL, { pr: "17" });
		expect(r).toStartWith(LINE);
		expect(r).toContain("arrives as an aside");
		expect(f.execs.calls).toEqual([{ command: "bun", args: [TEST_RUNNER_SCRIPT, "start", wl, "17", "--requested-by", "lane-t-1"], options: { timeout: 30_000 } }]);
		// with an open slice on this workload; a numeric or `#`-prefixed PR is the same PR; extra keys never reach the starter
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "full suite", doneCondition: "green", inputs: "PR" });
		await call(LANE_FULL_TEST_TOOL, { pr: 17, slice: sl, command: "rm -rf /", repo: "evil/repo", sha: "b".repeat(40), env: { PATH: "/tmp" }, path: "/tmp/x.ts" });
		await call(LANE_FULL_TEST_TOOL, { pr: "#17", slice: ` ${sl} ` });
		const expected = [TEST_RUNNER_SCRIPT, "start", wl, "17", "--slice", sl, "--requested-by", "lane-t-1"];
		expect(f.execs.calls.slice(1).map((c) => c.args)).toEqual([expected, expected]);
		// the tool writes nothing itself: the starter is the writer
		expect(ledger.entries(wl).some((e) => e.body.startsWith("test-requested:"))).toBe(false);
	});

	test("a starter refusal, a killed starter and a host without exec return what happened, and say no run started", async () => {
		const { f, call } = laneFixture({ exec: true });
		f.execs.answer = () => ({ stdout: "", stderr: "test-runner: PR #17 is closed, not open\n", code: 1, killed: false });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toBe("No test run started (starter exit 1): test-runner: PR #17 is closed, not open");
		f.execs.answer = () => ({ stdout: "", stderr: "", code: 143, killed: true });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toBe("No test run started (the starter did not return within 30 s and was killed): the starter was killed before it printed");
		f.execs.answer = () => {
			throw new Error("spawn bun ENOENT");
		};
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toContain("the starter could not be run: Error: spawn bun ENOENT");
		const bare = laneFixture();
		expect(await bare.call(LANE_FULL_TEST_TOOL, { pr: "17" })).toContain("host has no exec");
	});

	test("a foreign, closed, paused or malformed slice, a bad PR and a lane that does not hold the workload are refused before any exec", async () => {
		const { ledger, wl, f, call } = laneFixture({ exec: true });
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "another workload", stakes: "normal", mode: "autonomous" });
		const foreign = ledger.addSlice({ by: SURFACE_BY, workloadId: other, task: "t", doneCondition: "d", inputs: "i" });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: foreign })).toBe(`Slice ${foreign} is not on workload ${wl}; nothing was requested.`);
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: "sl-nope" })).toContain("is not on workload");
		const flag = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i", id: "sl-x --requested-by jo" });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: flag })).toContain("is not a slice id the test runner records");
		const done = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		ledger.completeSlice(done, { by: "lane-t-1", artifact: "a" });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: done })).toBe(`Slice ${done} is done, not open; nothing was requested.`);
		const paused = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: paused, body: "green or red?", options: ["green", "red"] });
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17", slice: paused })).toContain(`Slice ${paused} is paused, not open (a question on it waits on Jo`);
		for (const pr of ["", "abc", "0", "-1", "17; rm", "1.5", "99999999999999999999"]) {
			expect(await call(LANE_FULL_TEST_TOOL, { pr })).toContain("names its PR by number");
		}
		ledger.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
		expect(ledger.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 }).won).toBe(true);
		expect(await call(LANE_FULL_TEST_TOOL, { pr: "17" })).toContain("held by lane-x, not by this lane (lane-t-1)");
		expect(f.execs.calls).toEqual([]);
	});

	test("lane_complete_slice refuses a slice the runner was asked to settle; a request the lane forged does not count", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "full suite", doneCondition: "green", inputs: "PR" });
		const forgedOn = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "other", doneCondition: "d", inputs: "i" });
		const sha = "a".repeat(40);
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId: "tr-0abc1234aaaa", pr: 17, sha, slice: sl, by: "lane-t-1" }) });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: forgedOn, kind: "assumption", body: testRequestedBody({ runId: "tr-0abc1234bbbb", pr: 17, sha, slice: forgedOn, by: "lane-t-1" }) });
		expect(await call("lane_complete_slice", { slice: sl, artifact: "bun test passed" })).toBe(`the test runner settles ${sl}; call lane_full_test. Nothing was completed.`);
		expect(ledger.slice(sl)!.state).toBe("open");
		expect(await call("lane_complete_slice", { slice: forgedOn, artifact: "done" })).toContain(`Completed slice ${forgedOn}`);
	});

	test("`test-run-failed:` is refused as a body by record_entry, raise_question and message, with nothing written", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const before = { entries: ledger.entries(wl).length, held: ledger.workload(wl)!.held_messages, questions: ledger.questions(wl).length };
		const body = `test-run-failed: ${wl} ${sl} red at ${"a".repeat(40)}: 1 failing`;
		expect(await call("lane_record_entry", { body })).toContain("the test runner's signal");
		expect(await call("lane_raise_question", { slice: sl, body, options: ["a", "b"] })).toContain("the test runner's signal");
		expect(await call("lane_message", { body })).toContain("signal the machinery pushes");
		expect(ledger.entries(wl).length).toBe(before.entries);
		expect(ledger.workload(wl)!.held_messages).toBe(before.held);
		expect(ledger.questions(wl).length).toBe(before.questions);
	});
});

describe("lane_withdraw_reserved (MIGRATION.md item 31)", () => {
	const request = (ledger: Ledger, wl: string, body = "git push --force: git push --force origin main (P-11 row 6 refused tool call c1)") =>
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "reserved-request", body });

	test("withdraws a waiting request as the lane: one reserved-withdrawn: entry, the request stops waiting, the reason reaches the decision log's state", async () => {
		const { ledger, wl, call } = laneFixture();
		const en = request(ledger, wl);
		expect(waitingReserved(ledger, wl).map((r) => r.id)).toEqual([en]);
		expect(await call("lane_withdraw_reserved", { id: en, reason: "went\n another way" })).toContain(`Withdrew reserved request ${en}`);
		const written = ledger.entries(wl).at(-1)!;
		expect([written.kind, written.created_by, written.body]).toEqual(["assumption", "lane-t-1", `reserved-withdrawn: ${en} went another way`]);
		expect(waitingReserved(ledger, wl)).toEqual([]);
		expect(reservedStates(ledger, wl)[0]!.state).toMatchObject({ kind: "withdrawn", by: "lane-t-1", reason: "went another way" });
	});

	test("refuses with nothing written: another workload's request, an unknown id, a decided request, a second withdraw", async () => {
		const { ledger, wl, call } = laneFixture();
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "another", stakes: "normal", mode: "autonomous" });
		const foreign = request(ledger, other);
		const decided = request(ledger, wl, "deploy: fly deploy (P-11 row 6 refused tool call c2)");
		ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `deny ${decided}`, author: "jo", channel: "surface" });
		const en = request(ledger, wl);
		expect(await call("lane_withdraw_reserved", { id: en })).toContain("Withdrew");
		const before = ledger.entries(wl).length;
		expect(await call("lane_withdraw_reserved", { id: foreign })).toContain(`${foreign} is not a reserved request on workload ${wl}`);
		expect(await call("lane_withdraw_reserved", { id: "en-nope" })).toContain("is not a reserved request");
		expect(await call("lane_withdraw_reserved", { id: decided })).toContain("not waiting on Jo (it is denied)");
		expect(await call("lane_withdraw_reserved", { id: en })).toContain("not waiting on Jo (it is withdrawn)");
		expect(ledger.entries(wl).length).toBe(before);
		expect(ledger.entries(other).filter((e) => e.kind === "assumption")).toEqual([]);
	});
});

describe("lane_read_facts (MIGRATION.md item 106, PLAN wl-mv4r19j1q885xc § 2.4)", () => {
	const WEB = "/fixture/web";
	const API = "/fixture/api";
	/** Synthetic M8 facts in the live row shape, on their own workload (the reader reads facts on any workload). */
	const seed = (ledger: Ledger, facts: { n: number; repo: string; src: string; text: string; tag?: string }[]) => {
		const m8 = ledger.openWorkload({ by: SURFACE_BY, brief: "m8 facts", stakes: "normal", mode: "autonomous" });
		for (const f of facts) {
			const body = `m8-fact #${String(f.n).padStart(2, "0")} [${f.tag ?? "m8-sedge-wl-x"}] repo=${f.repo} src=${f.src} :: ${f.text}`;
			ledger.recordEntry({ by: "m8-sedge", workloadId: m8, kind: "assumption", body });
		}
	};
	const webFacts = [
		{ n: 1, repo: WEB, src: `${WEB}/docs/build.md:1-4`, text: "the build uses Bun" },
		{ n: 2, repo: WEB, src: `${WEB}/README.md:10-12`, text: "deploys go through Fly" },
		{ n: 3, repo: WEB, src: `${WEB}/docs/test.md:2-3`, text: "tests run with bun test" },
		{ n: 1, repo: API, src: `${API}/docs/db.md:5-9`, text: "the api keeps its schema in sqlite" },
	];

	test("reads the workload's repo (its repo: entry) by default, and another repo when named", async () => {
		const { ledger, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		const before = ledger.entries(wl).length;
		expect(await call(LANE_READ_FACTS_TOOL, {})).toBe([
			`3 facts for ${WEB}`,
			`- the build uses Bun (${ledger.facts(WEB)[0]!.id}; build.md:1-4)`,
			`- deploys go through Fly (${ledger.facts(WEB)[1]!.id}; README.md:10-12)`,
			`- tests run with bun test (${ledger.facts(WEB)[2]!.id}; test.md:2-3)`,
		].join("\n"));
		expect(await call(LANE_READ_FACTS_TOOL, { repo: "  " })).toStartWith(`3 facts for ${WEB}\n`);
		const api = await call(LANE_READ_FACTS_TOOL, { repo: API });
		expect(api).toBe(`1 facts for ${API}\n- the api keeps its schema in sqlite (${ledger.facts(API)[0]!.id}; db.md:5-9)`);
		expect(ledger.entries(wl).length).toBe(before);
	});

	test("with no repo: entry and no repo named, asks for repo", async () => {
		const { ledger, call } = laneFixture();
		seed(ledger, webFacts);
		const r = await call(LANE_READ_FACTS_TOOL, {});
		expect(r).toContain("has no `repo:` entry");
		expect(r).toContain("name `repo`");
		expect(await call(LANE_READ_FACTS_TOOL, { repo: WEB })).toStartWith(`3 facts for ${WEB}\n`);
	});

	test("a failing default-repo lookup returns the tool's error text, not a rejected call", async () => {
		const { ledger, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		expect(await call(LANE_READ_FACTS_TOOL, {})).toStartWith(`3 facts for ${WEB}\n`);
		// The `repo:` lookup reads entries; the ownership gate reads only the workload row.
		ledger.db.exec("ALTER TABLE entries RENAME TO entries_gone");
		const r = await call(LANE_READ_FACTS_TOOL, {});
		expect(r).toStartWith(`could not read facts for workload ${wl}'s repo (`);
		expect(r).toContain("entries");
	});

	test("match is a case-insensitive substring of text or src, with the N of M match line", async () => {
		const { ledger, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		const bun = (await call(LANE_READ_FACTS_TOOL, { match: "BUN" })).split("\n");
		expect(bun[0]).toBe(`2 of 3 match "BUN" for ${WEB}`);
		expect(bun.slice(1).map((l) => l.split(" (")[0])).toEqual(["- the build uses Bun", "- tests run with bun test"]);
		const readme = (await call(LANE_READ_FACTS_TOOL, { match: "readme" })).split("\n");
		expect(readme[0]).toBe(`1 of 3 match "readme" for ${WEB}`);
		expect(readme[1]).toStartWith("- deploys go through Fly (");
		expect(await call(LANE_READ_FACTS_TOOL, { match: "nothing like it" })).toBe(`0 of 3 match "nothing like it" for ${WEB}`);
		expect(await call(LANE_READ_FACTS_TOOL, { match: "" })).toStartWith(`3 facts for ${WEB}\n`);
	});

	test("has no budget: facts totalling more than 8,000 bytes all come back", async () => {
		const { ledger, wl, call } = laneFixture();
		const many = Array.from({ length: 60 }, (_, i) => ({ n: i + 1, repo: WEB, src: `${WEB}/docs/f${i + 1}.md:1-2`, text: `fact ${i + 1} ${"x".repeat(180)}` }));
		seed(ledger, many);
		recordRepo(ledger, wl, WEB);
		const r = await call(LANE_READ_FACTS_TOOL, {});
		const lines = r.split("\n");
		expect(lines[0]).toBe(`60 facts for ${WEB}`);
		expect(lines.length).toBe(61);
		expect(lines.slice(1).map((l) => l.split(" ")[2])).toEqual(many.map((f) => String(f.n)));
		expect(Buffer.byteLength(r)).toBeGreaterThan(8000);
	});

	test("refused when the caller is not the holder or the session is not a lane", async () => {
		const { ledger, path, wl, call } = laneFixture();
		seed(ledger, webFacts);
		recordRepo(ledger, wl, WEB);
		const orch = fakePi();
		orchestratorSurface(orch.pi, { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" }, {});
		const o = (await orch.tool(LANE_READ_FACTS_TOOL).execute("1", { repo: WEB }, undefined, undefined, ctxOf())).content[0]!.text;
		expect(o).toContain("not a lane bound to a workload; nothing was read");
		expect(o).not.toContain("build uses Bun");
		ledger.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
		expect(ledger.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 }).won).toBe(true);
		const r = await call(LANE_READ_FACTS_TOOL, { repo: WEB });
		expect(r).toContain("held by lane-x, not by this lane (lane-t-1) under a live lease; nothing was read");
		expect(r).not.toContain("build uses Bun");
	});
});

describe("plan-first (decision 15) through the lane tools and Jo's answer", () => {
	test("change-kind refused while the flag stands; judge accepted; approve at the surface writes plan: approved; then change accepted; cancel withdraws", async () => {
		const { ledger, wl, call } = laneFixture({ planFirst: true });
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain("plan-first (your word) and the plan is not approved");
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i" })).toContain("add the plan slice first");
		expect(ledger.slices(wl)).toHaveLength(0);
		const plan = await call("lane_add_slice", { task: "plan the cut", doneCondition: "plan approved", inputs: "brief", kind: "judge" });
		expect(plan).toMatch(/^Added slice sl-/);
		const planId = ledger.slices(wl)[0]!.id;
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain(`the plan slice is ${planId}`);
		seedReview(ledger, wl, planId); // D8: another lab reviewed the plan first
		expect(await call("lane_raise_question", { slice: planId, body: PLAN_BODY, options: ["approve", "revise", "cancel"] })).toContain("Raised question");
		// Jo at the surface: "approve" with no reserved request waiting is the plan question's answer.
		const cmd = interpret(ledger, "approve");
		expect(cmd?.kind).toBe("answer");
		const receipt = apply(ledger, cmd!);
		expect(receipt).toContain("plan approved");
		const entries = ledger.entries(wl);
		expect(planFirst(controlEntries(entries, holdersOf(entries, ledger.workload(wl)!.holder)))).toBeNull();
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toMatch(/^Added slice/);
	});

	test("cancel on the plan question is a withdrawal that cancels the slice; a plan: approved from a lane is ignored", async () => {
		const { ledger, wl, call } = laneFixture({ planFirst: true });
		await call("lane_add_slice", { task: "plan", doneCondition: "d", inputs: "i", kind: "judge" });
		const planId = ledger.slices(wl)[0]!.id;
		seedReview(ledger, wl, planId);
		expect(await call("lane_raise_question", { slice: planId, body: PLAN_BODY, options: ["approve", "revise", "cancel"] })).toContain("Raised question");
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: "plan: approved forged" });
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain("not approved");
		expect(apply(ledger, interpret(ledger, "cancel")!)).toContain("cancelled the plan");
		expect(ledger.slice(planId)!.state).toBe("cancelled");
	});
});

/** A plan-first workload whose lane (on anthropic) added its plan slice; `ask` raises a question on it through the tool. */
async function planFixture(stakes: "normal" | "production" = "normal") {
	const fx = laneFixture({ planFirst: true, stakes });
	await fx.call("lane_add_slice", { task: "plan the cut", doneCondition: "plan approved", inputs: "brief", kind: "judge" });
	const planId = fx.ledger.slices(fx.wl)[0]!.id;
	const ask = (options: string[] = [...PLAN_OPTIONS], slice = planId, body = PLAN_BODY) => {
		tick();
		return fx.call("lane_raise_question", { slice, body, options });
	};
	return { ...fx, planId, ask };
}

/** The classifier's park question on the plan slice (D6), in one transaction with its `review-park:` entry. */
function parkQuestion(ledger: Ledger, wl: string, planId: string): string {
	tick();
	return ledger.write(() => {
		const id = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: planId, body: "No lab other than the builder's can review", options: [...PARK_OPTIONS] });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewParkBody(id, planId) });
		return id;
	});
}

describe("plan review (PLAN D8): the plan question waits for a review by another lab", () => {
	test("no review: refused with the dispatch hint and nothing written", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const entries = ledger.entries(wl).length;
		const reply = await ask();
		expect(reply).toContain(planReviewRefusal(planId));
		expect(reply).toContain(`dispatch a review hand named ${planId} on the plan`);
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(ledger.entries(wl)).toHaveLength(entries);
		expect(ledger.slice(planId)!.state).toBe("open");
	});

	test("a review that answered on the lane's own lab is refused, as is one where any answering model is; another lab's is raised", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL] });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId, { ran: [OTHER_LAB, LANE_MODEL] });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
	});

	test("a review withheld (review-withheld:) does not clear the plan", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId, { withheld: true });
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl)).toHaveLength(0);
	});

	test("a review older than the previous plan question does not clear the next one", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		jo(ledger, ledger.questions(wl)[0]!.id, "revise");
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl)).toHaveLength(1);
	});

	test("a review that ran while the previous question was open, before Jo's revise resolved it, is refused; one after the revise clears", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		const first = ledger.questions(wl)[0]!.id;
		seedReview(ledger, wl, planId);
		// The previous question is still open: the same plan question asked again is that open question, reused (PLAN wl-mvg1vs0rhnu3gg § 1.0).
		expect(await ask()).toBe(`Question ${first} on ${planId} is already open with this body and options; nothing new was raised. The slice stays paused until Jo answers ${first}.`);
		expect(ledger.questions(wl)).toHaveLength(1);
		// A changed plan question while the first is open is refused: it keeps every plan check.
		expect(await ask(undefined, planId, planBody(3))).toContain(planReviewRefusal(planId));
		jo(ledger, first, "revise");
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		expect(ledger.questions(wl)).toHaveLength(2);
	});

	test("a same-lab review whose token spent Jo's same-lab grant clears the plan", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const grant = jo(ledger, parkQuestion(ledger, wl, planId), "same-lab");
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant });
		expect(await ask()).toContain("Raised question");
	});

	test("the grant does not clear a withheld or unsuccessful review, and a `wait` answer is no grant", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const grant = jo(ledger, parkQuestion(ledger, wl, planId), "same-lab");
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant, withheld: true });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant, outcome: "refused-model-unknown" });
		expect(await ask()).toContain(planReviewRefusal(planId));
		const wait = jo(ledger, parkQuestion(ledger, wl, planId), "wait");
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant: wait });
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl).filter((q) => q.options.includes("approve"))).toHaveLength(0);
	});

	test("Jo's Kimi-out rule (PLAN wl-mv5xay6bjp0268 § 2.6): a review-same-lab-rule: line naming another slice clears nothing; one naming the plan slice, followed by its hand-spawn:, clears it", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], rule: "sl-other" });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], rule: planId, gap: "an unrelated note" });
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl)).toHaveLength(0);
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], rule: planId });
		expect(await ask()).toContain("Raised question");
	});

	/** classifier/extension.ts headroomSkipBody, as entry 19408 (wl-mvaqnihc2r85c0) wrote it, a literal so it loads on the baseline. */
	const skip = (token: string, by?: string) => ({ body: `headroom-skip: openai-codex/gpt-6.1-sol token ${token} openai-codex 7d 0.27 used, window pace +1.0 pts/h, projected 1.65 at reset 2026-10-22T06:17Z`, by });

	test("#228: Jo's Kimi-out rule still counts across an unbroken run of the token's headroom-skip: rows before its hand-spawn: (entries 19407-19409, wl-mvaqnihc2r85c0)", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		// A skip that breaks the run clears nothing: another token's, another writer's, or one followed by an unrelated note.
		const broken: ((t: string) => { body: string; by?: string }[])[] = [() => [skip("dt-other")], (t) => [skip(t, "lane-x")], (t) => [skip(t), { body: "an unrelated note" }]];
		for (const between of broken) {
			seedReview(ledger, wl, planId, { ran: [LANE_MODEL], rule: planId, between });
			expect(await ask()).toContain(planReviewRefusal(planId));
		}
		expect(ledger.questions(wl)).toHaveLength(0);
		// 19407 rule, 19408 headroom-skip, 19409 hand-spawn: the plan question goes through.
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], rule: planId, between: (t) => [skip(t)] });
		expect(await ask()).toContain("Raised question");
	});

	test("#228: a run of two headroom-skip: rows still counts the rule, and a spent same-lab grant counts across one the same way", async () => {
		const two = await planFixture();
		seedReview(two.ledger, two.wl, two.planId, { ran: [LANE_MODEL], rule: two.planId, between: (t) => [skip(t), skip(t)] });
		expect(await two.ask()).toContain("Raised question");
		const granted = await planFixture();
		const grant = jo(granted.ledger, parkQuestion(granted.ledger, granted.wl, granted.planId), "same-lab");
		seedReview(granted.ledger, granted.wl, granted.planId, { ran: [LANE_MODEL], grant, between: (t) => [skip(t)] });
		expect(await granted.ask()).toContain("Raised question");
	});

	test("a forged spend (PLAN wl-mv5xay6bjp0268 § 2.6 [r2-M1]): Jo's genuine same-lab grant clears nothing unless its spend is immediately followed by the token's hand-spawn: from the same writer", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const grant = jo(ledger, parkQuestion(ledger, wl, planId), "same-lab");
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant, gap: "an unrelated note" });
		expect(await ask()).toContain(planReviewRefusal(planId));
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant, spawnBy: "lane-x" });
		expect(await ask()).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl).filter((q) => q.options.includes("approve"))).toHaveLength(0);
		// The same fixture with the spend and its spawn adjacent, by one writer, clears.
		seedReview(ledger, wl, planId, { ran: [LANE_MODEL], grant: jo(ledger, parkQuestion(ledger, wl, planId), "same-lab") });
		expect(await ask()).toContain("Raised question");
	});

	test("`Approve` in mixed case is checked like approve", async () => {
		const { planId, ask } = await planFixture();
		expect(await ask(["Approve", "Revise", "Cancel"])).toContain(planReviewRefusal(planId));
		expect(await ask(["APPROVE", "no"])).toContain(planReviewRefusal(planId));
	});

	test("unaffected: a question without approve on another slice, a plan-slice question without approve, and any question once the plan is approved", async () => {
		const { ledger, wl, planId, call, ask } = await planFixture();
		tick(); // the plan slice is the oldest (surface/src/launch.ts planSlice): no tie on the stamp
		await call("lane_add_slice", { task: "second judge slice", doneCondition: "d", inputs: "i", kind: "judge" });
		const other = ledger.slices(wl).find((s) => s.id !== planId)!.id;
		// Approve on it is refused outright while the plan stands unapproved (PLAN wl-mv5i3lulwwbbi8 D4, the D4 tests below).
		expect(await ask(["left", "right"], other, "Which header?")).toContain("Raised question");
		expect(await ask(["yes", "no"])).toContain("Raised question");
		const approved = await planFixture();
		approved.ledger.recordEntry({ by: SURFACE_BY, workloadId: approved.wl, kind: "assumption", body: planApprovedBody("in-test") });
		expect(await approved.ask()).toContain("Raised question");
	});
});

describe("the plan question's shape (PLAN wl-muq22rnjcfrrpc D7)", () => {
	const slice = "- sl-1: slice 1, one line";
	const trade = "tradeoff: tradeoff 1";
	const shape = "review: <verdict>, <model>, <absolute path to the verdict file>";

	test("refused with the shape in the message and nothing written: every body that breaks a rule", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		const bad: [string, string[]][] = [
			["a bare path", [PLAN_FILE]],
			["no slice line", [PLAN_FILE, NONE_LINE, trade, REVIEW_LINE]],
			["a slice line with an id and no task", [PLAN_FILE, "- sl-1", NONE_LINE, trade, REVIEW_LINE]],
			["a slice line with an id, a colon and no task", [PLAN_FILE, "- sl-1:", NONE_LINE, trade, REVIEW_LINE]],
			["no tradeoff line", [PLAN_FILE, slice, NONE_LINE, REVIEW_LINE]],
			["4 tradeoff lines", planBody(2, 4).split("\n")],
			["no review line", [PLAN_FILE, slice, NONE_LINE, trade]],
			["two review lines", [PLAN_FILE, slice, NONE_LINE, trade, REVIEW_LINE, REVIEW_LINE]],
			["a review line with no path", [PLAN_FILE, slice, NONE_LINE, trade, `review: approve-as-is, ${OTHER_LAB}`]],
			["a review line with four fields", [PLAN_FILE, slice, NONE_LINE, trade, `review: approve-as-is, ${OTHER_LAB}, extra, ${VERDICT_FILE}`]],
			["a review line with a relative path", [PLAN_FILE, slice, NONE_LINE, trade, `review: approve-as-is, ${OTHER_LAB}, PLAN-REVIEW-r1.md`]],
			["a review line naming a missing file", [PLAN_FILE, slice, NONE_LINE, trade, `review: approve-as-is, ${OTHER_LAB}, ${join(PLAN_DIR, "missing.md")}`]],
			["a relative plan path", ["PLAN.md", slice, NONE_LINE, trade, REVIEW_LINE]],
			["a missing plan file", [join(PLAN_DIR, "missing.md"), slice, NONE_LINE, trade, REVIEW_LINE]],
			["a plan path that is a directory", [PLAN_DIR, slice, NONE_LINE, trade, REVIEW_LINE]],
			["a 161-character line", [PLAN_FILE, `- sl-1: ${"x".repeat(153)}`, NONE_LINE, trade, REVIEW_LINE]],
			["an unknown line kind", [PLAN_FILE, slice, NONE_LINE, "note: also this", trade, REVIEW_LINE]],
			["a blank line", [PLAN_FILE, slice, NONE_LINE, "", trade, REVIEW_LINE]],
			["a tradeoff before the slices", [PLAN_FILE, trade, slice, NONE_LINE, REVIEW_LINE]],
			["a line after the review", [PLAN_FILE, slice, NONE_LINE, trade, REVIEW_LINE, trade]],
			// PLAN wl-mv8vwb04cy18n4 D2: the prompt-only line kind, between the slice lines and the tradeoff lines.
			["a prompt-only line before the slices", [PLAN_FILE, NONE_LINE, slice, trade, REVIEW_LINE]],
			["a prompt-only line after a tradeoff", [PLAN_FILE, slice, trade, NONE_LINE, REVIEW_LINE]],
			["a prompt-only line with no R id", [PLAN_FILE, slice, "prompt-only: the SPEC amendment", trade, REVIEW_LINE]],
			["a prompt-only line with an R id and no text", [PLAN_FILE, slice, "prompt-only: R2:", trade, REVIEW_LINE]],
			["prompt-only:none without its space", [PLAN_FILE, slice, "prompt-only:none", trade, REVIEW_LINE]],
			["a 161-character prompt-only line", [PROMPT_ONLY_FILE, slice, `prompt-only: R2: ${"x".repeat(144)}`, PROMPT_ONLY_LINES[1]!, trade, REVIEW_LINE]],
		];
		const entries = ledger.entries(wl).length;
		const accepted: string[] = [];
		for (const [why, lines] of bad) {
			const reply = await ask([...PLAN_OPTIONS], planId, lines.join("\n"));
			if (!reply.includes("Nothing was asked") || !reply.includes(shape)) accepted.push(`${why}: ${reply}`);
		}
		expect(accepted).toEqual([]);
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(ledger.entries(wl)).toHaveLength(entries);
	});

	test("the review gate still runs first: an unreviewed plan in a bad shape gets the review refusal", async () => {
		const { planId, ask } = await planFixture();
		expect(await ask([...PLAN_OPTIONS], planId, PLAN_FILE)).toContain(planReviewRefusal(planId));
	});

	test("a ten-slice plan, 16 lines with one at exactly 160 characters, is raised with the holder's plan-question: entry in the same write", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		const body = planBody(10, 3).replace(slice, `- sl-1: ${"x".repeat(152)}`);
		expect(body.split("\n")).toHaveLength(16);
		expect(Math.max(...body.split("\n").map((l) => l.length))).toBe(160);
		expect(await ask([...PLAN_OPTIONS], planId, body)).toContain("Raised question");
		const q = ledger.questions(wl)[0]!;
		expect(q.body).toBe(body);
		const marker = ledger.entries(wl).at(-1)!;
		expect([marker.kind, marker.created_by, marker.slice_id, marker.body, marker.created_at]).toEqual(["assumption", "lane-t-1", planId, boundPlanQuestion(q.id), q.created_at]);
	});

	test("control: a plan-slice question without approve is not shape-checked, gets no plan-question: entry, and is cut at 120 on the needs-you line", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		const body = `Which of the two cuts? ${"x".repeat(150)}`;
		expect(await ask(["left", "right"], planId, body)).toContain("Raised question");
		expect(ledger.entries(wl).some((e) => e.body.startsWith("plan-question:"))).toBe(false);
		expect(errorLines(ledger).find((l) => l.kind === "question")!.line).toContain(`: ${body.slice(0, 119)}… — answer with one word: left / right`);
	});
});

describe("plan requirements name their enforcer (PLAN wl-mv8vwb04cy18n4 D1-D5)", () => {
	/** Asks the reviewed plan slice `body` and returns the reply, the questions and entries before and after. */
	async function refused(body: string) {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		const entries = ledger.entries(wl).length;
		const reply = await ask([...PLAN_OPTIONS], planId, body);
		expect(reply).toContain("Nothing was asked.");
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(ledger.entries(wl)).toHaveLength(entries);
		return reply;
	}
	/** The `R<n>` ids a reply names, unique and sorted (the shapes it carries hold none): what the lane acts on, not the sentence. */
	const idsIn = (reply: string) => [...new Set(reply.match(/\bR\d+\b/g) ?? [])].sort();

	test("R1, R6: a plan file with no `## Requirements` line, or a section with no requirement line, is refused with the requirements grammar in the refusal and nothing written", async () => {
		const none = planFile("PLAN-no-section.md", ["# PLAN", "", "## Design", "", "- R1: a requirement in the wrong section => test x"]);
		const reply = await refused(bodyOn(none, [NONE_LINE]));
		expect(reply).toContain(PLAN_REQUIREMENTS_SHAPE);
		expect(idsIn(reply)).toEqual([]);
		const empty = planFile("PLAN-empty-section.md", ["# PLAN", "", "## Requirements", "", "", "## Slices", "- R1: after the section => test x"]);
		const second = await refused(bodyOn(empty, [NONE_LINE]));
		expect(second).toContain(PLAN_REQUIREMENTS_SHAPE);
		expect(idsIn(second)).toEqual([]);
	});

	test("R2: a section with several defects is refused naming every offender, a bad separator included; a well-formed line beside them is not named", async () => {
		const path = planFile("PLAN-defects.md", [
			"# PLAN", "## Requirements",
			"- R1: a => b, arrows in the text => test surface/test/a.test.ts",
			"- R2: no enforcer at all",
			"- R3: an unknown kind => tests surface/test/a.test.ts",
			"- R4: an empty locator => code",
			"- R5: a short reason => prompt-only: because",
			"prose inside the section",
			"- R3: the same id again => gate row 6",
			"- R6: two spaces after the kind => test  surface/test/a.test.ts",
			"- R7: no space after the colon => prompt-only:no code reaches it",
		]);
		const reply = await refused(bodyOn(path, [NONE_LINE]));
		expect(idsIn(reply)).toEqual(["R2", "R3", "R4", "R5", "R6", "R7"]);
		expect(reply).toMatch(/\bline 8\b/);
	});

	test("R3: the body's prompt-only ids must equal the plan file's: none for items, a missing id, an extra id, a duplicate, none missing, none mixed with ids", async () => {
		const [r2, r3] = PROMPT_ONLY_LINES as [string, string];
		expect(idsIn(await refused(bodyOn(PROMPT_ONLY_FILE, [NONE_LINE])))).toEqual(["R2", "R3"]);
		expect(idsIn(await refused(bodyOn(PROMPT_ONLY_FILE, [r2])))).toEqual(["R3"]);
		expect(idsIn(await refused(bodyOn(PROMPT_ONLY_FILE, [r2, r3, "prompt-only: R1: the refusal names the grammar"])))).toEqual(["R1"]);
		expect(idsIn(await refused(bodyOn(PROMPT_ONLY_FILE, [r2, r3, r3])))).toEqual(["R3"]);
		expect(idsIn(await refused(bodyOn(PLAN_FILE, [])))).toEqual([]);
		const mixed = await refused(bodyOn(PROMPT_ONLY_FILE, [r2, r3, NONE_LINE]));
		expect(idsIn(mixed)).toEqual([]);
		expect(mixed).toContain(PLAN_REQUIREMENTS_SHAPE);
	});

	test("a plan file over PLAN_FILE_MAX_BYTES, a sparse 64 MiB one included, is refused for its size with nothing written; one of exactly PLAN_FILE_MAX_BYTES is raised", async () => {
		const head = ["# PLAN", "", "## Requirements", "", "- R1: the plan file is read bounded => test surface/test/lane-tools.test.ts", "", "## Slices", ""].join("\n");
		const exact = planFile("PLAN-max.md", [head + "x".repeat(PLAN_FILE_MAX_BYTES - Buffer.byteLength(head))]);
		const over = planFile("PLAN-over.md", [head + "x".repeat(PLAN_FILE_MAX_BYTES + 1 - Buffer.byteLength(head))]);
		const sparse = planFile("PLAN-sparse.md", [head]);
		truncateSync(sparse, 64 * 1024 * 1024);
		for (const path of [over, sparse]) {
			const reply = await refused(bodyOn(path, [NONE_LINE]));
			expect(reply).toContain(`${PLAN_FILE_MAX_BYTES} bytes`);
			expect(idsIn(reply)).toEqual([]);
		}
		rmSync(sparse);
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		expect(await ask([...PLAN_OPTIONS], planId, bodyOn(exact, [NONE_LINE]))).toContain("Raised question");
		expect(ledger.questions(wl)).toHaveLength(1);
	});

	test("R4: a well-formed plan with prompt-only items, one line at exactly 160 characters, is raised through the tool; the needs-you line and the workload block show every prompt-only line whole", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		const long = `${PROMPT_ONLY_LINES[0]} ${"y".repeat(160 - PROMPT_ONLY_LINES[0]!.length - 1)}`;
		expect(long).toHaveLength(160);
		const body = bodyOn(PROMPT_ONLY_FILE, [long, PROMPT_ONLY_LINES[1]!]);
		expect(await ask([...PLAN_OPTIONS], planId, body)).toContain("Raised question");
		const q = ledger.questions(wl)[0]!;
		expect(q.body).toBe(body);
		const lines = body.split("\n");
		const r = renderWake(ledger);
		expect(r.text).toContain(`(${q.id}, slice ${planId}):\n  ${lines.join("\n  ")} — answer with one word: approve / revise / cancel`);
		expect(r.text).toContain(`\n- ${q.id} on ${planId}:\n  ${lines.join("\n  ")} — options: approve / revise / cancel\n`);
		const needsYou = errorLines(ledger).find((l) => l.rowId === q.id)!.line;
		for (const l of [long, PROMPT_ONLY_LINES[1]!]) expect(needsYou).toContain(`\n  ${l}\n`);
	});

	test("R5 (pin): a plan question raised before the change, in the old shape on a plan file with no section, is never re-checked: Jo's approve still approves the plan", async () => {
		const { ledger, wl, planId } = await planFixture();
		const old = planFile("PLAN-old.md", ["# PLAN", "", "Written before plans named their enforcers."]);
		const body = [old, "- sl-1: slice 1, one line", "tradeoff: tradeoff 1", REVIEW_LINE].join("\n");
		tick();
		// As lane_raise_question wrote it before the change: the question and the holder's plan-question: entry in one write.
		ledger.write(() => {
			const q = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: planId, body, options: [...PLAN_OPTIONS] });
			ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: `plan-question: ${q}` });
		});
		expect(apply(ledger, interpret(ledger, "approve")!)).toContain("plan approved");
		const entries = ledger.entries(wl);
		expect(planFirst(controlEntries(entries, holdersOf(entries, ledger.workload(wl)!.holder)))).toBeNull();
	});

	test("R6: lane_raise_question's description carries the requirements grammar and the prompt-only line kind", () => {
		const { f } = laneFixture();
		const tool = f.tool(LANE_RAISE_QUESTION_TOOL);
		const description = "description" in tool && typeof tool.description === "string" ? tool.description : "";
		expect(description).toContain(PLAN_REQUIREMENTS_SHAPE);
		expect(description).toContain("`prompt-only: <R id>: ");
		expect(description).toContain("`prompt-only: none`");
	});
});

describe("the plan slice moves past a closed one (PLAN wl-muq22rnjcfrrpc D9)", () => {
	const change = { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" };
	const stamped = (ledger: Ledger, wl: string) => ledger.entries(wl).some((e) => e.body.startsWith("plan: approved"));
	/** Jo's one word at the surface, as the surface applies it. */
	const say = (ledger: Ledger, word: string) => apply(ledger, interpret(ledger, word)!);

	/** The plan slice reviewed and completed by the lane, then a second judge slice added: the plan role's handoff. */
	async function handedOn() {
		const fx = await planFixture();
		seedReview(fx.ledger, fx.wl, fx.planId);
		expect(await fx.call("lane_complete_slice", { slice: fx.planId, artifact: PLAN_FILE })).toContain("Completed");
		tick();
		await fx.call("lane_add_slice", { task: "the plan, revised", doneCondition: "plan approved", inputs: "brief", kind: "judge" });
		const second = fx.ledger.slices(fx.wl).find((s) => s.id !== fx.planId)!.id;
		return { ...fx, second };
	}

	test("the plan slice done: the next judge slice is named in the refusal, and Jo's approve on its reviewed question writes plan: approved", async () => {
		const { ledger, wl, second, call, ask } = await handedOn();
		expect(await call("lane_add_slice", change)).toContain(`the plan slice is ${second} (open)`);
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "approve")).toContain("plan approved");
		expect(await call("lane_add_slice", change)).toMatch(/^Added slice/);
	});

	test("on the next plan slice, revise writes no stamp and cancel cancels it", async () => {
		const { ledger, wl, second, ask } = await handedOn();
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "revise")).not.toContain("plan approved");
		expect(stamped(ledger, wl)).toBe(false);
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "cancel")).toContain("cancelled the plan");
		expect(ledger.slice(second)!.state).toBe("cancelled");
		expect(stamped(ledger, wl)).toBe(false);
	});

	test("the next plan slice's approve question waits for a review named after it: the closed slice's review does not count", async () => {
		const { ledger, wl, second, ask } = await handedOn();
		expect(await ask([...PLAN_OPTIONS], second)).toContain(planReviewRefusal(second));
		expect(ledger.questions(wl)).toHaveLength(0);
	});

	test("D4: while the plan slice is open, a second slice's approve question is refused naming the plan slice and the ways out; after the handoff it asks and stamps", async () => {
		const { ledger, wl, planId, call, ask } = await planFixture();
		tick();
		await call("lane_add_slice", { task: "second judge slice", doneCondition: "d", inputs: "i", kind: "judge" });
		const second = ledger.slices(wl).find((s) => s.id !== planId)!.id;
		const entries = ledger.entries(wl).length;
		const refused = await ask([...PLAN_OPTIONS], second);
		expect(refused).toContain(`only the plan slice ${planId} (open) may offer approve`);
		expect(refused).toContain("lane_complete_slice");
		expect(refused).toContain(`cancel-slice ${planId}`);
		expect(refused).toContain("Nothing was asked.");
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(ledger.entries(wl)).toHaveLength(entries);
		expect(ledger.slice(second)!.state).toBe("open");
		tick();
		expect(await call("lane_complete_slice", { slice: planId, artifact: PLAN_FILE })).toContain("Completed");
		expect(await call("lane_add_slice", change)).toContain(`the plan slice is ${second}`);
		seedReview(ledger, wl, second);
		expect(await ask([...PLAN_OPTIONS], second)).toContain("Raised question");
		expect(say(ledger, "approve")).toContain("plan approved");
	});

	test("D4 control: the plan slice's own approve question still writes plan-question:, and another slice may ask without approve", async () => {
		const { ledger, wl, planId, call, ask } = await planFixture();
		tick();
		await call("lane_add_slice", { task: "second judge slice", doneCondition: "d", inputs: "i", kind: "judge" });
		const second = ledger.slices(wl).find((s) => s.id !== planId)!.id;
		expect(await ask(["left", "right"], second, "Which header?")).toContain("Raised question");
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		const planQ = ledger.questions(wl).find((q) => q.slice_id === planId)!;
		expect(ledger.entries(wl).filter((e) => e.body.startsWith("plan-question:")).map((e) => e.body)).toEqual([boundPlanQuestion(planQ.id)]);
	});

	test("D4 control: once the plan is approved, an approve question on another slice is ordinary: raised, no plan-question:, no plan receipt", async () => {
		const { ledger, wl, planId, call, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		expect(say(ledger, "approve")).toContain("plan approved");
		tick();
		await call("lane_add_slice", change);
		const other = ledger.slices(wl).find((s) => s.id !== planId)!.id;
		expect(await ask(["approve", "deny"], other, "Ship it?")).toContain("Raised question");
		expect(ledger.entries(wl).filter((e) => e.body.startsWith("plan-question:"))).toHaveLength(1);
		const receipt = say(ledger, "approve");
		expect(receipt).not.toContain("plan approved");
		expect(receipt).not.toContain("not the plan question");
	});

	test("a plan-question: entry written by anyone but a holder of the workload is ignored", async () => {
		const { ledger, wl, planId } = await planFixture();
		tick();
		const q = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: planId, body: PLAN_BODY, options: [...PLAN_OPTIONS] });
		for (const by of ["lane-x", SURFACE_BY]) ledger.recordEntry({ by, workloadId: wl, sliceId: planId, kind: "assumption", body: `plan-question: ${q}` });
		expect(say(ledger, "approve")).not.toContain("plan approved");
		expect(stamped(ledger, wl)).toBe(false);
	});

	test("round 8's tie: two judge slices added in one millisecond take the plan role in insertion order, not by id", async () => {
		const { ledger, wl, call } = laneFixture({ planFirst: true });
		tick(); // frozen: both slices land in one millisecond
		for (const id of ["sl-z-first", "sl-a-second"]) await call("lane_add_slice", { task: id, doneCondition: "d", inputs: "i", kind: "judge", id });
		expect(ledger.slice("sl-a-second")!.created_at).toBe(ledger.slice("sl-z-first")!.created_at);
		expect(await call("lane_add_slice", change)).toContain("the plan slice is sl-z-first");
		const refused = await call("lane_raise_question", { slice: "sl-a-second", body: PLAN_BODY, options: [...PLAN_OPTIONS] });
		expect(refused).toContain("only the plan slice sl-z-first (open) may offer approve");
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(ledger.entries(wl).some((e) => e.body.startsWith("plan-question:"))).toBe(false);
		expect(await call("lane_raise_question", { slice: "sl-z-first", body: PLAN_BODY, options: [...PLAN_OPTIONS] })).toContain(planReviewRefusal("sl-z-first"));
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(stamped(ledger, wl)).toBe(false);
	});

	test("round 6's case: the plan slice completed and the next slice's question raised in one millisecond still stamps", async () => {
		const { ledger, wl, planId, call } = await planFixture();
		tick();
		await call("lane_add_slice", { task: "the plan, revised", doneCondition: "plan approved", inputs: "brief", kind: "judge", id: "sl-next" });
		seedReview(ledger, wl, "sl-next");
		tick(); // frozen from here: the completion, the question and its plan-question: entry share one millisecond
		expect(await call("lane_complete_slice", { slice: planId, artifact: PLAN_FILE })).toContain("Completed");
		expect(await call("lane_raise_question", { slice: "sl-next", body: PLAN_BODY, options: [...PLAN_OPTIONS] })).toContain("Raised question");
		expect(ledger.questions(wl)[0]!.created_at).toBe(ledger.slice(planId)!.changed_at);
		expect(say(ledger, "approve")).toContain("plan approved");
	});
});

/**
 * D8 × D9: three failed cross-lab rounds on the plan slice. The lane raised the plan after round 2
 * (with `staggered`, after round 3's first leg) and Jo answered revise; round 3 (its second leg)
 * then settled and the classifier raised the round-limit question with its `review-limit:` entry.
 * With `unasked`, the lane never raised the plan: no question on the plan slice precedes the limit.
 */
async function limitLoop(over: { lastWithheld?: boolean; staggered?: boolean; unasked?: boolean } = {}) {
	const fx = await planFixture();
	const { ledger, wl, planId } = fx;
	seedReview(ledger, wl, planId, { round: 1, blocking: 3 });
	seedReview(ledger, wl, planId, { round: 2, blocking: 2 });
	if (over.staggered) seedReview(ledger, wl, planId, { round: 3, blocking: 1, group: "dg-round3" });
	if (!over.unasked) {
		expect(await fx.ask()).toContain("Raised question");
		jo(ledger, ledger.questions(wl).at(-1)!.id, "revise");
	}
	seedReview(ledger, wl, planId, { round: 3, blocking: 1, group: "dg-round3", withheld: over.lastWithheld || over.staggered });
	tick();
	const limit = ledger.write(() => {
		const entries = ledger.entries(wl);
		const body = roundLimitQuestionBody(planId, countRounds(entries, planId), effectiveRoundLimit(entries, ledger.instructions(wl), "normal", planId), "normal");
		const id = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: planId, body, options: [...ROUND_LIMIT_OPTIONS] });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewLimitBody(id, planId) });
		return id;
	});
	/** Jo's answer to the limit question and the surface's entry for it. */
	const answer = (word: "extend" | "accept" | "stop") => {
		const id = jo(ledger, limit, word);
		const body = word === "extend" ? reviewRoundsExtendBody(planId, 3, id) : reviewLoopEndBody(planId, word);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, sliceId: planId, kind: "assumption", body });
	};
	return { ...fx, answer };
}

describe("plan review × round limit (PLAN D8 × D9)", () => {
	test("Jo accepts the review at its limit: the approve-question is raised with no further review", async () => {
		const { ledger, wl, answer, ask } = await limitLoop();
		answer("accept");
		expect(await ask()).toContain("Raised question");
		expect(ledger.routings(wl)).toHaveLength(3);
	});

	for (const word of ["extend", "stop"] as const) {
		test(`Jo answers ${word} at the limit: the approve-question is still refused`, async () => {
			const { planId, answer, ask } = await limitLoop();
			answer(word);
			expect(await ask()).toContain(planReviewRefusal(planId));
		});
	}

	test("accept does not clear a plan whose limit-reaching round was withheld", async () => {
		const { planId, answer, ask } = await limitLoop({ lastWithheld: true });
		answer("accept");
		expect(await ask()).toContain(planReviewRefusal(planId));
	});

	test("with no plan question before the limit, accept clears only on the limit-reaching round: rounds 1–2 do not stand in for a withheld round 3", async () => {
		const withheld = await limitLoop({ unasked: true, lastWithheld: true });
		withheld.answer("accept");
		expect(await withheld.ask()).toContain(planReviewRefusal(withheld.planId));
		expect(withheld.ledger.questions(withheld.wl).filter((q) => q.options.includes("approve"))).toHaveLength(0);
		const kept = await limitLoop({ unasked: true });
		kept.answer("accept");
		expect(await kept.ask()).toContain("Raised question");
	});

	test("accept counts every leg of the limit-reaching round, one that settled before Jo's revise included", async () => {
		const { planId, answer, ask } = await limitLoop({ staggered: true });
		expect(await ask()).toContain(planReviewRefusal(planId)); // the limit question is open
		answer("accept");
		expect(await ask()).toContain("Raised question");
	});
});

describe("lane_release and lane_handoff end the lane on purpose (decision 10)", () => {
	test("release: holder-checked, ctx.shutdown called, later tools refuse, the renewal claim and shutdown write nothing", async () => {
		const { ledger, wl, f, ctx, call } = laneFixture();
		await f.emit("session_start", { type: "session_start" }, ctx);
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		expect(await call("lane_release", {})).toContain("Released");
		expect(ctx.shutdowns).toHaveLength(1);
		expect(ledger.workload(wl)!.holder).toBeNull();
		expect(await call("lane_record_entry", { body: "after" })).toContain("released");
		await f.emit("agent_end", { willContinue: false }, ctx);
		expect(ledger.workload(wl)!.holder).toBeNull();
		notices.length = 0;
		await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		expect(ledger.workload(wl)!.held_messages).toBe(0);
	});

	test("handoff: Jo holds with no lease; a second handoff refuses", async () => {
		const { ledger, wl, call } = laneFixture();
		expect(await call("lane_handoff", {})).toContain("Handed");
		const w = ledger.workload(wl)!;
		expect(w.holder).toBe("jo");
		expect(w.holder_lease_until).toBeNull();
		expect(await call("lane_handoff", {})).toContain("released");
	});
});

describe("item 40: lane_release with work open, and the terminal pair while a hand is unsettled (PLAN wl-muq1v31q5ly7ls D4, D6)", () => {
	const markers = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("released-open:")).map((e) => [e.created_by, e.body]);
	const spawn = (ledger: Ledger, wl: string, token: string, by = "lane-t-1") =>
		ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body: handSpawnBody({ token, root: "/tmp/lane", spawnKey: "sl-job", review: true, group: `dg-${token}`, row: [OTHER_LAB] }) });
	/** The classifier's settle: the hand's routings row, then `hand-settled:` naming it. */
	const settle = (ledger: Ledger, wl: string, slice: string, token: string) => {
		tick();
		const routing = ledger.recordRouting({
			by: "lane-t-1", workloadId: wl, sliceId: slice, spawnKey: slice, sessionRoot: "/tmp/lane", agentId: `${token}-agent`, kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 },
			classifiedTier: "strong", tier: "strong", models: [OTHER_LAB], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: [OTHER_LAB],
		});
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: handSettledBody(token, routing) });
	};

	test("D4: a release with open slices and no receipt writes released-open: as the lane, with the release; another lane's unparked question does not mask it (T6m)", async () => {
		const { ledger, wl, ctx, call } = laneFixture();
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "open", doneCondition: "d", inputs: "i" });
		const paused = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "asked earlier", doneCondition: "d", inputs: "i" });
		ledger.raiseQuestion({ by: "lane-t-0", workloadId: wl, sliceId: paused, body: "an older lane's question, never parked", options: ["a", "b"] });
		expect(await call("lane_release", {})).toContain("Released");
		expect(ctx.shutdowns).toHaveLength(1);
		expect(ledger.workload(wl)!.holder).toBeNull();
		expect(markers(ledger, wl)).toEqual([["lane-t-1", "released-open: lane-t-1 slices 2"]]);
		const entries = ledger.entries(wl);
		expect(releasedOpen(controlEntries(entries, holdersOf(entries, null)), "lane-t-1")).toBe(2);
	});

	test("D4: no marker when a holder's receipt stands or nothing is open (done and cancelled slices)", async () => {
		const withReceipt = laneFixture();
		withReceipt.ledger.addSlice({ by: "lane-t-1", workloadId: withReceipt.wl, task: "open", doneCondition: "d", inputs: "i" });
		await withReceipt.call("lane_record_entry", { body: "done-because: the header offset lives in one token" });
		expect(await withReceipt.call("lane_release", {})).toContain("Released");
		expect(markers(withReceipt.ledger, withReceipt.wl)).toEqual([]);

		const closed = laneFixture();
		const done = closed.ledger.addSlice({ by: "lane-t-1", workloadId: closed.wl, task: "done", doneCondition: "d", inputs: "i" });
		const cancelled = closed.ledger.addSlice({ by: "lane-t-1", workloadId: closed.wl, task: "dropped", doneCondition: "d", inputs: "i" });
		closed.ledger.completeSlice(done, { by: "lane-t-1", artifact: "bun test → 0" });
		closed.ledger.cancelSlice(cancelled, { by: "lane-t-1" });
		expect(await closed.call("lane_release", {})).toContain("Released");
		expect(markers(closed.ledger, closed.wl)).toEqual([]);
	});

	test("D4 atomicity: a marker insert that fails rolls the release back — the lane still holds, no ctx.shutdown, its tools still work", async () => {
		const { ledger, wl, ctx, call } = laneFixture();
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "open", doneCondition: "d", inputs: "i" });
		ledger.db.exec("CREATE TRIGGER inject_marker_failure BEFORE INSERT ON entries WHEN NEW.body LIKE 'released-open:%' BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END;");
		const reply = await call("lane_release", {});
		expect(reply).toContain("could not be released: injected marker failure");
		expect(ledger.workload(wl)!.holder).toBe("lane-t-1");
		expect(ctx.shutdowns).toHaveLength(0);
		expect(markers(ledger, wl)).toEqual([]);
		expect(await call("lane_record_entry", { body: "still working" })).toContain("Recorded entry");
	});

	test("T14: the holder changes between the tool's ownership read and its transaction — the refusal, no marker, no ctx.shutdown", async () => {
		const { ledger, wl, env, ctx, call } = laneFixture();
		ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "open", doneCondition: "d", inputs: "i" });
		// the tool's own ledger handle (gates/src/session.ts keys it on the session): its first write flips the holder first
		const tool = gateSession(ctx, env).ledger();
		const write = tool.write.bind(tool);
		let flipped = false;
		tool.write = (<T>(fn: () => T): T => {
			if (!flipped) {
				flipped = true;
				write(() => {
					tool.releaseWorkload(wl, { by: "lane-t-1", holder: "lane-t-1" });
					tool.claimWorkload(wl, { by: "lane-x", holder: "lane-x", leaseMs: 60_000 });
				});
			}
			return write(fn);
		}) as typeof tool.write;
		expect(await call("lane_release", {})).toContain(`Workload ${wl} is held by lane-x, not by this lane; nothing was released.`);
		expect(flipped).toBe(true);
		expect(ledger.workload(wl)!.holder).toBe("lane-x");
		expect(markers(ledger, wl)).toEqual([]);
		expect(ctx.shutdowns).toHaveLength(0);
	});

	for (const tool of ["lane_release", "lane_handoff"] as const) {
		test(`D6: ${tool} refuses while this lane's hand is unsettled (a forged settle included), and goes through once it settles; another lane's hand does not block`, async () => {
			const { ledger, wl, ctx, call } = laneFixture();
			const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "review", doneCondition: "d", inputs: "i" });
			spawn(ledger, wl, "dt-other", "lane-t-0");
			spawn(ledger, wl, "dt-mine");
			const refused = "hand(s) dt-mine you spawned are still unsettled; keep your turn alive until each result is delivered, then release.";
			expect(await call(tool, {})).toContain(refused);
			// the lane cannot settle it itself, and a settle naming no routings row written straight to the ledger settles nothing
			expect(await call("lane_record_entry", { body: handSettledBody("dt-mine", "rt-bogus") })).toContain("reserved control line");
			ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: handSettledBody("dt-mine", "rt-bogus") });
			expect(await call(tool, {})).toContain(refused);
			expect(ledger.workload(wl)!.holder).toBe("lane-t-1");
			expect(ctx.shutdowns).toHaveLength(0);
			settle(ledger, wl, sl, "dt-mine");
			expect(await call(tool, {})).toContain(tool === "lane_release" ? "Released" : "Handed");
			expect(ctx.shutdowns).toHaveLength(1);
		});
	}
});

describe("mode flip at the surface", () => {
	test("to user-driven while a lane holds writes the lane-stop: request the runner accepts", async () => {
		const { ledger, path, wl } = laneFixture();
		const f = fakePi();
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" };
		orchestratorSurface(f.pi, env, {});
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "user-driven", systemPrompt: [] }, ctx);
		const stop = ledger.entries(wl).find((e) => e.body.startsWith("lane-stop:"));
		expect(stop?.body).toBe("lane-stop: lane-t-1 requested mode-flip by jo");
		expect(stop?.created_by).toBe(SURFACE_BY);
		expect(ledger.workload(wl)!.mode).toBe("user-driven");
		ledger.close();
		Ledger.open(path).close();
	});
});

describe("plan auto-start (PLAN wl-mvfkv7llkp7nk0 § 3, R7, R8)", () => {
	/** Jo ends the flow-repair ruling at the surface, as `end-ruling flow-repair` does: auto-start is off while it stands. */
	const endFlowRepair = (ledger: Ledger) => expect(apply(ledger, interpret(ledger, "end-ruling flow-repair")!)).toContain("flow-repair");
	/** One review round on the plan slice, settled cross-lab with no blocking finding, then the classifier's `review-loop-end:`. */
	const passedRound = (ledger: Ledger, wl: string, planId: string, over: { reason?: LoopEndReason; rule?: string } = {}) => {
		seedReview(ledger, wl, planId, { round: 1, group: "dg-pass", rule: over.rule });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewLoopEndBody(planId, over.reason ?? "pass") });
		tick();
	};
	const autoEntries = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("plan: approved auto"));
	const noticesOf = (ledger: Ledger, wl: string) =>
		ledger.db.query<{ body: string; created_by: string }, [string]>("SELECT body, created_by FROM messages WHERE workload_id = ?1 AND body LIKE 'notice:%'").all(wl);

	test("a normal plan whose latest round passed cross-lab starts with no question: ESCALATION_BY's approval, Jo's notice, change slices accepted", async () => {
		const { ledger, wl, planId, ask, call } = await planFixture();
		endFlowRepair(ledger);
		passedRound(ledger, wl, planId);
		const reply = await ask();
		expect(reply).toContain("The plan is approved");
		expect(reply).toContain("add your change slices");
		expect(ledger.questions(wl)).toHaveLength(0);
		expect(autoEntries(ledger, wl).map((e) => [e.body, e.created_by])).toEqual([["plan: approved auto dg-pass", ESCALATION_BY]]);
		const sent = noticesOf(ledger, wl);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.created_by).toBe(ESCALATION_BY);
		expect(sent[0]!.body).toContain(`plan started without your approve on ${wl}`);
		expect(sent[0]!.body).toContain(`\`halt ${wl}\` stops it`);
		expect(sent[0]!.body).toContain(PLAN_FILE);
		const entries = ledger.entries(wl);
		expect(planFirst(controlEntries(entries, holdersOf(entries, ledger.workload(wl)!.holder)))).toBeNull();
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toMatch(/^Added slice/);
	});

	const toJo: [string, (ledger: Ledger, wl: string, planId: string) => void][] = [
		["flow repair is up (the ruling not ended)", (ledger, wl, planId) => passedRound(ledger, wl, planId)],
		["the loop ended on Jo's accept at the round limit, not a pass", (ledger, wl, planId) => {
			endFlowRepair(ledger);
			passedRound(ledger, wl, planId, { reason: "accept" });
		}],
		["a review was dispatched after the passing loop-end", (ledger, wl, planId) => {
			endFlowRepair(ledger);
			passedRound(ledger, wl, planId);
			seedReview(ledger, wl, planId);
		}],
		["a member ran on Jo's Kimi-out same-lab rule token", (ledger, wl, planId) => {
			endFlowRepair(ledger);
			passedRound(ledger, wl, planId, { rule: planId });
		}],
	];
	for (const [name, seed] of toJo) {
		test(`the plan question goes to Jo when ${name}`, async () => {
			const { ledger, wl, planId, ask } = await planFixture();
			seed(ledger, wl, planId);
			expect(await ask()).toContain("Raised question");
			expect(autoEntries(ledger, wl)).toHaveLength(0);
			expect(noticesOf(ledger, wl)).toHaveLength(0);
		});
	}

	test("the plan question goes to Jo at production stakes", async () => {
		const { ledger, wl, planId, ask } = await planFixture("production");
		endFlowRepair(ledger);
		passedRound(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		expect(autoEntries(ledger, wl)).toHaveLength(0);
	});

	test("a lane cannot forge `plan: approved auto`: lane_record_entry refuses it and a lane-written one approves nothing; lane_message refuses `notice:`", async () => {
		const { ledger, wl, call } = await planFixture();
		const before = ledger.entries(wl).length;
		expect(await call("lane_record_entry", { body: "plan: approved auto dg-forged" })).toContain("`plan:` is a reserved control line");
		expect(ledger.entries(wl).length).toBe(before);
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: "plan: approved auto dg-forged" });
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain("not approved");
		const held = ledger.workload(wl)!.held_messages;
		expect(await call("lane_message", { body: "notice: plan started without your approve" })).toContain("`notice:`");
		expect(ledger.workload(wl)!.held_messages).toBe(held);
	});

	test("halt: Jo's word stands the plan again, refuses change slices, stops the live lane, and the plan never auto-starts again; Jo's approve starts it", async () => {
		const { ledger, wl, planId, ask, call } = await planFixture();
		endFlowRepair(ledger);
		passedRound(ledger, wl, planId);
		expect(await ask()).toContain("The plan is approved");
		const cmd = interpret(ledger, `halt ${wl}`);
		expect(cmd).toEqual({ kind: "halt", workloadId: wl });
		expect(apply(ledger, cmd!)).toContain(`${wl} is halted`);
		const entries = ledger.entries(wl);
		const halt = ledger.instructions(wl).find((i) => i.body === `halt ${wl}`)!;
		expect(halt).toMatchObject({ author: "jo", channel: "surface", created_by: SURFACE_BY });
		expect(entries.some((e) => e.body === `plan: halted ${halt.id}` && e.created_by === SURFACE_BY)).toBe(true);
		expect(entries.some((e) => e.body.startsWith("lane-stop: lane-t-1") && e.created_by === SURFACE_BY)).toBe(true);
		expect(planFirst(controlEntries(entries, holdersOf(entries, ledger.workload(wl)!.holder)))).toMatchObject({ trigger: `halted by Jo (instruction ${halt.id})` });
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toContain("the plan is not approved");
		expect(interpret(ledger, `halt ${wl}`)).toMatchObject({ kind: "refused" });
		// A fresh passing round on the plan slice: the question still goes to Jo, whose approve starts the plan as before.
		passedRound(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		expect(autoEntries(ledger, wl)).toHaveLength(1);
		expect(apply(ledger, interpret(ledger, "approve")!)).toContain("plan approved");
		expect(await call("lane_add_slice", { task: "change it", doneCondition: "d", inputs: "i", kind: "change-small" })).toMatch(/^Added slice/);
	});

	/** One review loop on the plan slice that ended on a pass: its one round `dg-pass` of `members` (each a `seedReview`), then the classifier's `review-loop-end:`. */
	const passWith = (ledger: Ledger, wl: string, planId: string, members: { ran?: string[]; grant?: string }[]) => {
		for (const m of members) seedReview(ledger, wl, planId, { round: 1, group: "dg-pass", ...m });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption", body: reviewLoopEndBody(planId, "pass") });
		tick();
	};
	// Each seed writes an otherwise-eligible round; `veto` adds the one thing a single guard of planAutoStartRound refuses.
	const vetoes: [string, (ledger: Ledger, wl: string, planId: string, veto: boolean) => void][] = [
		["a review hand-spawn on the plan slice after the passing loop-end, with no routing", (ledger, wl, planId, veto) => {
			passWith(ledger, wl, planId, [{}]);
			if (veto) {
				// Its row is on the builder's own lab: an unsettled hand counts its row as builders (builderLabs item 3), and this adds none.
				ledger.recordEntry({
					by: "lane-t-1", workloadId: wl, sliceId: planId, kind: "assumption",
					body: handSpawnBody({ token: "dt-late", root: "/tmp/lane-t-1", spawnKey: planId, review: true, group: "dg-late", row: [LANE_MODEL] }),
				});
			}
		}],
		["a review routing on the plan slice after the passing loop-end, with no hand-spawn", (ledger, wl, planId, veto) => {
			passWith(ledger, wl, planId, [{}]);
			if (veto) {
				ledger.recordRouting({
					by: "lane-t-1", workloadId: wl, sliceId: planId, spawnKey: planId, sessionRoot: "/tmp/lane-t-1", agentId: `${planId}-late`,
					kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 }, classifiedTier: "strong", tier: "strong",
					models: [OTHER_LAB], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: [OTHER_LAB],
				});
			}
		}],
		["a member spawned on Jo's same-lab grant (his `same-lab` answer to the park question), though it answered on another lab", (ledger, wl, planId, veto) => {
			const grant = jo(ledger, parkQuestion(ledger, wl, planId), "same-lab");
			passWith(ledger, wl, planId, [veto ? { grant } : {}]);
		}],
		["a genuine same-lab passing round: its one member answered on the builder's lab", (ledger, wl, planId, veto) => {
			passWith(ledger, wl, planId, [{ ran: [veto ? LANE_MODEL : OTHER_LAB] }]);
		}],
		["a mixed-member passing round: one member on another lab, the other on the builder's lab", (ledger, wl, planId, veto) => {
			passWith(ledger, wl, planId, [{ ran: [OTHER_LAB] }, { ran: [veto ? LANE_MODEL : OTHER_LAB] }]);
		}],
	];
	for (const [name, seed] of vetoes) {
		test(`R8: ${name} vetoes auto-start on its own; the same round without it starts`, async () => {
			for (const veto of [false, true]) {
				const { ledger, wl, planId } = await planFixture();
				endFlowRepair(ledger);
				seed(ledger, wl, planId, veto);
				expect({ veto, round: planAutoStartRound(ledger, wl, planId, Date.now()) }).toEqual({ veto, round: veto ? null : "dg-pass" });
			}
		});
	}

	test("PLAN wl-mvg1vs0rhnu3gg § 1.0 (R1): an auto-start-eligible plan asked with now: guard goes to Jo tagged NOW and writes no plan: approved auto; the same plan without now starts", async () => {
		for (const now of ["guard", null]) {
			const { ledger, wl, planId, call } = await planFixture();
			endFlowRepair(ledger);
			passedRound(ledger, wl, planId);
			tick();
			const reply = await call("lane_raise_question", { slice: planId, body: PLAN_BODY, options: [...PLAN_OPTIONS], ...(now === null ? {} : { now }) });
			if (now === null) {
				expect(reply).toContain("The plan is approved");
				expect(autoEntries(ledger, wl)).toHaveLength(1);
				expect(ledger.questions(wl)).toHaveLength(0);
				continue;
			}
			const questions = ledger.questions(wl);
			expect(questions).toHaveLength(1);
			const id = questions[0]!.id;
			expect(reply).toBe(`Raised question ${id} on ${planId} (approve / revise / cancel); the slice is paused until Jo answers. It reaches Jo at once, marked NOW (guard).`);
			expect(nowEntries(ledger, wl)).toEqual([[`now: ${id} guard`, ESCALATION_BY]]);
			expect(planQuestions(ledger, wl)).toEqual([boundPlanQuestion(id)]);
			expect(autoEntries(ledger, wl)).toHaveLength(0);
			expect(noticesOf(ledger, wl)).toHaveLength(0);
		}
	});
});

/** The `now:` marks on `wl` as [body, writer]; a literal prefix, so this file loads on the baseline. */
const nowEntries = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("now: ")).map((e) => [e.body, e.created_by]);
/** The holder's `plan-question:` entries on `wl`. */
const planQuestions = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("plan-question: ")).map((e) => e.body);
/** The reply to an ask that repeats the open question `id` on `slice`. */
const reusedReply = (id: string, slice: string, now?: string) =>
	`Question ${id} on ${slice} is already open with this body and options; nothing new was raised.${now ? ` It reaches Jo at once, marked NOW (${now}).` : ""} The slice stays paused until Jo answers ${id}.`;

describe("escalation phase 2 through the lane tools (PLAN wl-mvg1vs0rhnu3gg § 1.0, § 3.3, § 3.5; R1, R7)", () => {
	test("an unknown now word is refused and nothing is written", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const before = ledger.entries(wl).length;
		expect(await call("lane_raise_question", { slice: sl, body: "Which header keeps the offset?", options: ["left", "right"], now: "urgent" })).toBe(
			"`now` is one of integrity, security, incident, guard, boundary, irreversible, money, not urgent; nothing was asked.",
		);
		expect(ledger.questions(wl)).toEqual([]);
		expect(ledger.entries(wl)).toHaveLength(before);
		expect(ledger.slice(sl)!.state).toBe("open");
	});

	test("now: security raises a normal-stakes merge question past the merges ruling, with ESCALATION_BY's now: mark and no ruling-applied", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const reply = await call("lane_raise_question", { slice: sl, body: "PR #4 is green; merge it?", options: ["merge", "wait"], now: "security" });
		const questions = ledger.questions(wl);
		expect(questions).toHaveLength(1);
		const id = questions[0]!.id;
		expect(reply).toBe(`Raised question ${id} on ${sl} (merge / wait); the slice is paused until Jo answers. It reaches Jo at once, marked NOW (security).`);
		expect(nowEntries(ledger, wl)).toEqual([[`now: ${id} security`, ESCALATION_BY]]);
		expect(ledger.entries(wl).some((e) => e.body.startsWith("ruling-applied:"))).toBe(false);
		expect(ledger.slice(sl)!.state).toBe("paused");
	});

	test("a plan question with now still needs its review: unreviewed, it is refused with nothing written", async () => {
		const { ledger, wl, planId, call } = await planFixture();
		const before = ledger.entries(wl).length;
		expect(await call("lane_raise_question", { slice: planId, body: PLAN_BODY, options: [...PLAN_OPTIONS], now: "guard" })).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl)).toEqual([]);
		expect(ledger.entries(wl)).toHaveLength(before);
	});

	test("an unchanged plan question asked twice is the open one, reused: no second question row and no second plan-question:", async () => {
		const { ledger, wl, planId, ask } = await planFixture();
		seedReview(ledger, wl, planId);
		expect(await ask()).toContain("Raised question");
		const id = ledger.questions(wl)[0]!.id;
		expect(await ask()).toBe(reusedReply(id, planId));
		expect(ledger.questions(wl).map((q) => q.id)).toEqual([id]);
		expect(planQuestions(ledger, wl)).toEqual([boundPlanQuestion(id)]);
	});

	test("a reviewed production plan: repeated unchanged with no new review it is the same id; repeated with now: guard it gains one trusted now: mark; a changed plan with no fresh review is refused", async () => {
		const { ledger, wl, planId, ask, call } = await planFixture("production");
		seedReview(ledger, wl, planId);
		const raised = await ask();
		const id = ledger.questions(wl)[0]!.id;
		expect(raised).toBe(`Raised question ${id} on ${planId} (approve / revise / cancel); the slice is paused until Jo answers.`);
		expect(await ask()).toBe(reusedReply(id, planId));
		expect(nowEntries(ledger, wl)).toEqual([]);
		for (let i = 0; i < 2; i++) {
			tick();
			expect(await call("lane_raise_question", { slice: planId, body: PLAN_BODY, options: [...PLAN_OPTIONS], now: "guard" })).toBe(reusedReply(id, planId, "guard"));
		}
		expect(ledger.questions(wl).map((q) => q.id)).toEqual([id]);
		expect(nowEntries(ledger, wl)).toEqual([[`now: ${id} guard`, ESCALATION_BY]]);
		expect(planQuestions(ledger, wl)).toEqual([boundPlanQuestion(id)]);
		expect(ledger.entries(wl).some((e) => e.body.startsWith("plan: approved auto"))).toBe(false);
		// Changed: one more slice line. No review ran since the open question, so it keeps every check.
		expect(await ask(undefined, planId, planBody(3))).toContain(planReviewRefusal(planId));
		expect(await call("lane_raise_question", { slice: planId, body: planBody(3), options: [...PLAN_OPTIONS], now: "guard" })).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl).map((q) => q.id)).toEqual([id]);
		expect(nowEntries(ledger, wl)).toHaveLength(1);
	});

	test("fix round 1 (F1): a reviewed plan whose PLAN.md is edited after the raise (R2 made prompt-only), its question bytes unchanged, is refused on repeat with and without now: guard; no now: mark, no new row", async () => {
		const { ledger, wl, planId, ask, call } = await planFixture("production");
		const lines = ["# PLAN", "", "## Requirements", "", "- R1: the header offset lives in one token => test surface/test/tokens.test.ts", "- R2: the old constant is gone => test surface/test/tokens.test.ts"];
		const path = planFile("PLAN-edited.md", lines);
		const body = bodyOn(path, [NONE_LINE]);
		seedReview(ledger, wl, planId);
		expect(await ask(undefined, planId, body)).toContain("Raised question");
		const id = ledger.questions(wl)[0]!.id;
		// Unchanged: the repeat is the open question.
		expect(await ask(undefined, planId, body)).toBe(reusedReply(id, planId));
		const entries = ledger.entries(wl).length;
		// The plan file changes under the same path: R2 is now prompt-only, which the body's `prompt-only: none` no longer matches.
		planFile("PLAN-edited.md", [...lines.slice(0, -1), "- R2: the old constant is gone => prompt-only: no test can see a deleted name"]);
		expect(await ask(undefined, planId, body)).toContain(planReviewRefusal(planId));
		tick();
		expect(await call("lane_raise_question", { slice: planId, body, options: [...PLAN_OPTIONS], now: "guard" })).toContain(planReviewRefusal(planId));
		expect(ledger.questions(wl).map((q) => q.id)).toEqual([id]);
		expect(nowEntries(ledger, wl)).toEqual([]);
		expect(ledger.entries(wl)).toHaveLength(entries);
		// The verdict file changing alone is refused the same way, once the plan file is back as it was.
		planFile("PLAN-edited.md", lines);
		expect(await ask(undefined, planId, body)).toBe(reusedReply(id, planId));
		writeFileSync(VERDICT_FILE, "verdict: revise\n");
		try {
			tick();
			expect(await call("lane_raise_question", { slice: planId, body, options: [...PLAN_OPTIONS], now: "guard" })).toContain(planReviewRefusal(planId));
		} finally {
			writeFileSync(VERDICT_FILE, "verdict: approve-as-is\n");
		}
		expect(nowEntries(ledger, wl)).toEqual([]);
		expect(ledger.entries(wl)).toHaveLength(entries);
		// The question's holder entry carries the two hashes the raise checked (the plan file is back as it was then).
		expect(planQuestions(ledger, wl)).toEqual([boundPlanQuestion(id, path)]);
	});

	test("a lane message opening with security-red: (the test runner's signal) is refused and nothing is sent", async () => {
		const { ledger, wl, call } = laneFixture();
		const held = ledger.workload(wl)!.held_messages;
		expect(await call("lane_message", { body: `security-red: ${wl} sl-x tr-0abc1234wxyz ${"a".repeat(40)} 1 gates/test/r06-reserved.test.ts > refuses a deploy` })).toBe(
			"A message opening with `security-red:` is a signal the machinery pushes to Jo; a lane's words must not read as one. Nothing was sent.",
		);
		expect(ledger.workload(wl)!.held_messages).toBe(held);
	});
});
