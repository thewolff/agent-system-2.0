// new guard: no fail-before
//
// PR 1 of wl-mv67564rdkfvnk (PLAN rev 5 § 2 D4; § 5 `sl-trig-tests`): guards over the new jev choice call
// classifier/src/judge-ask.ts, its question file classifier/pair-signal-question.json, and the lane classifier's
// background `pair-signal:` attempt. The module does not exist before PR 1, so this file fails on its import until the
// build.
//
// API as these tests pin it (GUESS(design), from D4's named shapes):
//   askChoices(judge: ChoiceJudge, state: string, questions: ChoiceQuestions, opts: { timeoutMs: number; signal?: AbortSignal })
//     → { ok: true; answers: Record<name, { choice; confidence; probabilities }>; model; provider; cost: number | null }
//     | { ok: false; reason: string /* contains malformed | timeout | error */; cost: number | null }
//   judge.judge({ state, questions }, { signal }) → { answers, model, provider, usage?: { cost?: { total? } } }
// The extension half is driven through classifier/test/helpers.ts `extensionHost` (turn_end, tool_result). The switch is
// the installed profile's `pairSuggest` key, read where the existing code looks for the installed profile:
// `$HOME/.omp/profiles/<profile>/agent/config.yml` with `PI_CODING_AGENT_DIR` at the same directory (as
// pair-suggest-raise.test.ts).
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_BY, Ledger } from "../../ledger/src/index";
import { pairOffer, readPairSuggestConfig } from "../../surface/src/pair-suggest";
import { askChoices, askJudgment, JEV_USD_PER_INPUT_TOKEN, type JudgmentQuestions } from "../src/judge-ask";
import { tierTableFromConfig } from "../src/tier-table";
import { extensionHost, fakeRegistry } from "./helpers";

const QUESTIONS = JSON.parse(readFileSync(join(import.meta.dir, "..", "pair-signal-question.json"), "utf8"));

// ---- the switch: the installed profile's config.yml under a per-file HOME ---------------------------------------

const PROFILE = process.env.AGENT_SYSTEM_PROFILE || process.env.OMP_PROFILE || "agent-system-2";
const saved = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR };
let agentDir = "";
let home = "";
const dirs: string[] = [];

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "judge-ask-home-"));
	agentDir = join(home, ".omp", "profiles", PROFILE, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => rmSync(join(agentDir, "config.yml"), { force: true }));
afterAll(() => {
	for (const [k, v] of [["HOME", saved.home], ["PI_CODING_AGENT_DIR", saved.agentDir]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const d of [home, ...dirs]) rmSync(d, { recursive: true, force: true });
});

function pairSuggest(value: string): void {
	writeFileSync(join(agentDir, "config.yml"), `setupVersion: 2\npairSuggest: ${value}\n`);
}

// ---- askChoices -----------------------------------------------------------------------------------------------------

interface Reply {
	answers: unknown;
	model: string;
	provider: string;
	usage?: { cost?: { total?: number } };
}

/** What a test reads off askChoices' result, whichever branch it took. */
interface Outcome {
	ok: boolean;
	reason?: string;
	cost: number | null;
}

/**
 * Lets the event loop run every pending continuation: the background attempt is started with `void`, so the test has no
 * promise to await. Macrotask turns (setImmediate), never wall-clock time, so fake timers stay in control.
 */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

const GOOD = {
	taste: { choice: "yes", confidence: 0.91, probabilities: { yes: 0.91, no: 0.09 } },
	ambiguous: { choice: "no", confidence: 0.85, probabilities: { yes: 0.15, no: 0.85 } },
};
const reply = (answers: unknown, cost?: number): Reply => ({ answers, model: "jev-1.13.0", provider: "typesafe", ...(cost === undefined ? {} : { usage: { cost: { total: cost } } }) });
const judgeOf = (r: unknown) => ({ judge: async () => r as never });
const ask = (r: unknown) => askChoices(judgeOf(r) as never, "Restyle the settings modal", QUESTIONS, { timeoutMs: 5_000 });

describe("pair-signal-question.json: two yes/no choice questions", () => {
	test("taste and ambiguous, each a choice question over exactly yes and no, with instructions", () => {
		expect(Object.keys(QUESTIONS).sort()).toEqual(["ambiguous", "taste"]);
		for (const name of ["taste", "ambiguous"]) {
			expect(QUESTIONS[name].type).toBe("choice");
			expect(typeof QUESTIONS[name].instructions).toBe("string");
			expect(Object.keys(QUESTIONS[name].criteria)).toEqual(["yes", "no"]);
		}
	});
});

describe("askChoices: validation (D4)", () => {
	test("a valid reply: ok with every answer, the judge's provider and model, and its cost", async () => {
		expect(await ask(reply(GOOD, 0.0001))).toEqual({ ok: true, answers: GOOD, model: "jev-1.13.0", provider: "typesafe", cost: 0.0001 });
		expect(await ask(reply(GOOD))).toMatchObject({ ok: true, cost: null });
	});

	test("probabilities rounded to two decimals pass: a sum off by up to 0.005 per label", async () => {
		const answers = { ...GOOD, taste: { choice: "yes", confidence: 0.5, probabilities: { yes: 0.5 + 1e-7, no: 0.5 } } };
		expect(await ask(reply(answers))).toMatchObject({ ok: true });
		const rounded = { ...GOOD, taste: { choice: "yes", confidence: 0.66, probabilities: { yes: 0.66, no: 0.33 } } };
		expect(await ask(reply(rounded))).toMatchObject({ ok: true });
		const past = { ...GOOD, taste: { choice: "yes", confidence: 0.66, probabilities: { yes: 0.66, no: 0.32 } } };
		expect(await ask(reply(past))).toMatchObject({ ok: false, failure: "malformed" });
	});

	test("a four-level score whose rounded probabilities sum to 0.99 passes (live Jev reply shape)", async () => {
		const goal = { type: "score", score: 2.4, confidence: 0.7, probabilities: { 0: 0.05, 1: 0.05, 2: 0.3, 3: 0.59 } };
		expect(await askTyped(typedReply({ ...WIRE, goal }))).toMatchObject({ ok: true });
	});

	const bad: [string, unknown][] = [
		["a null reply", null],
		["no answers", reply(undefined)],
		["an empty answer map", reply({})],
		["a missing question", reply({ taste: GOOD.taste })],
		["a null answer", reply({ ...GOOD, ambiguous: null })],
		["a choice not among the labels", reply({ ...GOOD, taste: { ...GOOD.taste, choice: "maybe" } })],
		["confidence above 1", reply({ ...GOOD, taste: { ...GOOD.taste, confidence: 1.2 } })],
		["confidence below 0", reply({ ...GOOD, taste: { ...GOOD.taste, confidence: -0.1 } })],
		["confidence NaN", reply({ ...GOOD, taste: { ...GOOD.taste, confidence: Number.NaN } })],
		["confidence not a number", reply({ ...GOOD, taste: { ...GOOD.taste, confidence: "0.9" } })],
		["probabilities missing", reply({ ...GOOD, taste: { choice: "yes", confidence: 0.9 } })],
		["an extra label", reply({ ...GOOD, taste: { ...GOOD.taste, probabilities: { yes: 0.9, no: 0.05, maybe: 0.05 } } })],
		["a missing label", reply({ ...GOOD, taste: { ...GOOD.taste, probabilities: { yes: 1 } } })],
		["a probability out of range", reply({ ...GOOD, taste: { ...GOOD.taste, probabilities: { yes: 1.5, no: -0.5 } } })],
		["probabilities not summing to 1", reply({ ...GOOD, taste: { ...GOOD.taste, probabilities: { yes: 0.6, no: 0.5 } } })],
	];
	for (const [name, r] of bad) {
		test(`${name}: not ok, reason malformed`, async () => {
			const got = await ask(r);
			expect(got).toMatchObject({ ok: false });
			expect((got as Outcome).reason).toContain("malformed");
		});
	}

	test("a malformed reply keeps the cost the judge reported", async () => {
		expect(await ask(reply({ taste: GOOD.taste }, 0.00003))).toMatchObject({ ok: false, cost: 0.00003 });
	});

	test("a thrown error: not ok, reason error, cost unknown", async () => {
		const got = await askChoices({ judge: async () => { throw new Error("503 from typesafe"); } } as never, "s", QUESTIONS, { timeoutMs: 5_000 });
		expect(got).toMatchObject({ ok: false, cost: null });
		expect((got as Outcome).reason).toContain("error");
	});

	test("a judge that never answers and ignores its signal: not ok, reason timeout, at timeoutMs and not before; the signal it got is aborted", async () => {
		vi.useFakeTimers();
		try {
			let seen: AbortSignal | undefined;
			const hanging = { judge: (_req: unknown, o?: { signal?: AbortSignal }) => { seen = o?.signal; return Promise.withResolvers<never>().promise; } };
			let got: Outcome | undefined;
			void askChoices(hanging as never, "s", QUESTIONS, { timeoutMs: 50 }).then((r) => (got = r as Outcome));
			await flush();
			vi.advanceTimersByTime(49);
			await flush();
			expect(got).toBeUndefined();
			vi.advanceTimersByTime(1);
			await flush();
			expect(got).toMatchObject({ ok: false, cost: null });
			expect(got?.reason).toContain("timeout");
			expect(seen?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the request carries the state and the question map, with a signal", async () => {
		const calls: { req: { state: string; questions: unknown }; signal?: AbortSignal }[] = [];
		const recording = { judge: async (req: { state: string; questions: unknown }, o?: { signal?: AbortSignal }) => { calls.push({ req, signal: o?.signal }); return reply(GOOD); } };
		await askChoices(recording as never, "Restyle the settings modal", QUESTIONS, { timeoutMs: 5_000 });
		expect(calls.length).toBe(1);
		expect(calls[0]!.req).toEqual({ state: "Restyle the settings modal", questions: QUESTIONS });
		expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
	});
});

// ---- askJudgment (wl-mv8k039gvogt8g PLAN rev 5 § 2 D2, § 3 T5): choice, bool and score in one call ------------------
// new guard: no fail-before (askJudgment does not exist before sl-rank-core).

const TYPED: JudgmentQuestions = {
	when: { type: "choice", instructions: "When is it due?", criteria: { none: "No date.", today: "Today." } },
	unblocks: { type: "bool", instructions: "Does it unblock Jo?", criteria: { true: "Yes.", false: "No." } },
	spend: { type: "bool", instructions: "Does it cut spend?" },
	goal: { type: "score", instructions: "How far does it advance the goal?", criteria: ["Unrelated.", "Touches it.", "Partly.", "Delivers it."] },
};
/** OMP's library judge answers a `noul` question with `{ type: "noul", noul }` (pi-ai judgment/types.ts NoulAnswer). */
const WIRE = {
	when: { type: "choice", choice: "today", confidence: 0.8, probabilities: { none: 0.2, today: 0.8 } },
	unblocks: { type: "noul", noul: 0.91 },
	spend: { type: "noul", noul: 0 },
	goal: { type: "score", score: 2.4, confidence: 0.7, probabilities: { 0: 0.05, 1: 0.05, 2: 0.3, 3: 0.6 } },
};
const typedReply = (answers: unknown, input?: number) => ({ answers, model: "jev-1.13.0", provider: "typesafe", ...(input === undefined ? {} : { usage: { input } }) });
const askTyped = (r: unknown) => askJudgment({ judge: async () => r as never }, { item: "Restyle the settings modal" }, TYPED, { timeoutMs: 5_000 });

describe("askJudgment: choice, bool and score in one call (wl-mv8k039gvogt8g D2)", () => {
	test("valid answers of all three types pass: bool read from the wire's noul, a score between levels kept, spend from input tokens", async () => {
		expect(await askTyped(typedReply(WIRE, 2_000))).toEqual({
			ok: true,
			answers: {
				when: { type: "choice", choice: "today", confidence: 0.8, probabilities: { none: 0.2, today: 0.8 } },
				unblocks: { type: "bool", bool: 0.91 },
				spend: { type: "bool", bool: 0 },
				goal: { type: "score", score: 2.4, confidence: 0.7, probabilities: { 0: 0.05, 1: 0.05, 2: 0.3, 3: 0.6 } },
			},
			model: "jev-1.13.0", provider: "typesafe", tokens: 2_000, cost: 2_000 * JEV_USD_PER_INPUT_TOKEN,
		});
	});

	test("the request carries the state object and the questions with bool as noul, criteria kept, and a signal", async () => {
		const calls: { req: unknown; signal?: AbortSignal }[] = [];
		const recording = { judge: async (req: unknown, o?: { signal?: AbortSignal }) => { calls.push({ req, signal: o?.signal }); return typedReply(WIRE); } };
		const state = { goals: ["ship as2"], item: "Restyle\n\nRestyle the settings modal", today: "2026-10-14 (Wednesday)" };
		await askJudgment(recording as never, state, TYPED, { timeoutMs: 5_000 });
		expect(calls.length).toBe(1);
		expect(calls[0]!.req).toEqual({
			state,
			questions: {
				when: TYPED.when,
				unblocks: { type: "noul", instructions: "Does it unblock Jo?", criteria: { true: "Yes.", false: "No." } },
				spend: { type: "noul", instructions: "Does it cut spend?" },
				goal: TYPED.goal,
			},
		});
		expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
	});

	const bad: [string, unknown][] = [
		["a missing question", { ...WIRE, spend: undefined }],
		["a bool above 1", { ...WIRE, unblocks: { type: "noul", noul: 1.2 } }],
		["a bool below 0", { ...WIRE, unblocks: { type: "noul", noul: -0.1 } }],
		["a bool as a string", { ...WIRE, unblocks: { type: "noul", noul: "0.9" } }],
		["a bool answered as a choice", { ...WIRE, unblocks: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } } }],
		["a score above the top level", { ...WIRE, goal: { ...WIRE.goal, score: 3.5 } }],
		["a score below 0", { ...WIRE, goal: { ...WIRE.goal, score: -1 } }],
		["a score as a string", { ...WIRE, goal: { ...WIRE.goal, score: "2" } }],
		["a score confidence above 1", { ...WIRE, goal: { ...WIRE.goal, confidence: 1.5 } }],
		["score probabilities over labels, not level indices", { ...WIRE, goal: { ...WIRE.goal, probabilities: { low: 0.4, high: 0.6 } } }],
		["score probabilities missing a level", { ...WIRE, goal: { ...WIRE.goal, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } } }],
		["score probabilities not summing to 1", { ...WIRE, goal: { ...WIRE.goal, probabilities: { 0: 0.5, 1: 0.5, 2: 0.5, 3: 0.5 } } }],
		["a choice not among the labels", { ...WIRE, when: { ...WIRE.when, choice: "tomorrow" } }],
		["a choice with no probabilities", { ...WIRE, when: { type: "choice", choice: "today", confidence: 0.8 } }],
	];
	for (const [name, answers] of bad) {
		test(`${name}: not ok, reason malformed, the reported spend kept`, async () => {
			const got = await askTyped(typedReply(answers, 1_500));
			expect(got).toMatchObject({ ok: false, failure: "malformed", tokens: 1_500, cost: 1_500 * JEV_USD_PER_INPUT_TOKEN });
			expect(got.ok ? "" : got.reason).toStartWith("malformed: ");
		});
	}

	test("a thrown judge: not ok, reason error, cost unknown", async () => {
		const got = await askJudgment({ judge: async () => { throw new Error("503 from typesafe"); } }, "s", TYPED, { timeoutMs: 5_000 });
		expect(got).toEqual({ ok: false, failure: "error", reason: "error: 503 from typesafe", cost: null });
	});

	test("a judge that never answers: not ok, reason timeout, at timeoutMs and not before; the signal it got is aborted", async () => {
		vi.useFakeTimers();
		try {
			let seen: AbortSignal | undefined;
			const hanging = { judge: (_req: unknown, o?: { signal?: AbortSignal }) => { seen = o?.signal; return Promise.withResolvers<never>().promise; } };
			let got: Outcome | undefined;
			void askJudgment(hanging, "s", TYPED, { timeoutMs: 30_000 }).then((r) => (got = r));
			await flush();
			vi.advanceTimersByTime(29_999);
			await flush();
			expect(got).toBeUndefined();
			vi.advanceTimersByTime(1);
			await flush();
			expect(got).toMatchObject({ ok: false, cost: null, reason: "timeout after 30000 ms" });
			expect(seen?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---- the lane classifier's background attempt (D4 scheduling, entries, the guarantee) ------------------------------

const TABLE = tierTableFromConfig({
	task: {
		agentModelOverrides: {
			fast: ["anthropic/claude-haiku-5-5"],
			standard: ["anthropic/claude-sonnet-5-5"],
			strong: ["anthropic/claude-opus-5-5"],
			deep: ["anthropic/claude-fable-5-1"],
		},
	},
});
const BRIEF = "Restyle the settings modal: match the new token scale and spacing";
const SUCCESS = "pair-signal: taste yes 0.91 ambiguous no 0.85 judge typesafe/jev-1.13.0 tokens unknown cost 0.0001";
let seq = 0;

/** A fresh ledger with one autonomous normal-stakes workload (a unique id: the attempt map is per workload). */
function workload(): { ledger: Ledger; wl: string } {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "judge-ask-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = `wl-jask${++seq}${Date.now().toString(36)}`;
	ledger.openWorkload({ id: wl, brief: BRIEF, stakes: "normal", mode: "autonomous", by: "orch-test" });
	return { ledger, wl };
}

/** A judge whose pair-signal calls the test controls; kind-question calls (none expected here) are refused. */
function pairJudge(answer: (req: { state: string; questions: Record<string, unknown> }, signal?: AbortSignal) => Promise<unknown>) {
	const calls: { state: string; signal?: AbortSignal }[] = [];
	return {
		calls,
		judge: {
			judge: (req: { state: string; questions?: Record<string, unknown> }, o?: { signal?: AbortSignal }) => {
				if (!req.questions || !("taste" in req.questions)) return Promise.reject(new Error("unexpected kind call"));
				calls.push({ state: req.state, signal: o?.signal });
				return answer(req as { state: string; questions: Record<string, unknown> }, o?.signal);
			},
		},
	};
}

function host(ledger: Ledger, wl: string, judge: { judge(req: { state: string }): Promise<unknown> }) {
	return extensionHost({ judge, table: TABLE, registry: fakeRegistry(Object.values(TABLE).flat()), shared: { ledger, workloadId: wl }, boundWorkload: wl });
}

const pairEntries = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => /^pair-signal(-failed)?:/.test(e.body)).map((e) => [e.created_by, e.body]);

/** The pair offer the round-limit raise would make now (classifier/extension.ts reads it the same way), with no stalled count: the signals, or null. */
const raiseOffer = (ledger: Ledger, wl: string) => pairOffer(ledger, wl, { config: readPairSuggestConfig() });

describe("the background pair-signal attempt (D4)", () => {
	test("switch off: no judge call on any event", async () => {
		pairSuggest("off");
		const { ledger, wl } = workload();
		const j = pairJudge(async () => reply(GOOD, 0.0001));
		const h = host(ledger, wl, j.judge);
		await h.turnEnd();
		h.otherToolResult("read", {});
		await flush();
		expect(j.calls.length).toBe(0);
		expect(pairEntries(ledger, wl)).toEqual([]);
	});

	test("success: one classifier-stamped pair-signal: with the judge, cost and both answers; the brief is the state; no further calls", async () => {
		pairSuggest("all");
		const { ledger, wl } = workload();
		const j = pairJudge(async () => reply(GOOD, 0.0001));
		const h = host(ledger, wl, j.judge);
		await h.turnEnd();
		await flush();
		expect(pairEntries(ledger, wl)).toEqual([[CLASSIFIER_BY, SUCCESS]]);
		expect(j.calls.length).toBe(1);
		expect(j.calls[0]!.state).toContain(BRIEF);
		await h.turnEnd();
		h.otherToolResult("read", {});
		await flush();
		expect(j.calls.length).toBe(1);
	});

	test("single-flight: many events while the attempt is pending make one call and one entry", async () => {
		pairSuggest("all");
		const { ledger, wl } = workload();
		const d = Promise.withResolvers<unknown>();
		const j = pairJudge(() => d.promise);
		const h = host(ledger, wl, j.judge);
		await h.turnEnd();
		for (let i = 0; i < 5; i++) h.otherToolResult("read", {}, `other-${i}`);
		await h.turnEnd();
		await flush();
		expect(j.calls.length).toBe(1);
		d.resolve(reply(GOOD, 0.0001));
		await flush();
		expect(pairEntries(ledger, wl)).toEqual([[CLASSIFIER_BY, SUCCESS]]);
		expect(j.calls.length).toBe(1);
	});

	test("three attempts at most: a failing judge writes attempt 1, 2 and 3 with cost unknown, then is not called again", async () => {
		pairSuggest("all");
		const { ledger, wl } = workload();
		const j = pairJudge(async () => { throw new Error("503 from typesafe"); });
		const h = host(ledger, wl, j.judge);
		for (let i = 0; i < 6; i++) {
			await h.turnEnd();
			await flush();
		}
		expect(j.calls.length).toBe(3);
		expect(pairEntries(ledger, wl)).toEqual([1, 2, 3].map((n) => [CLASSIFIER_BY, `pair-signal-failed: attempt ${n} error tokens unknown cost unknown`]));
	});

	test("a malformed answer is a failed attempt carrying the judge's cost", async () => {
		pairSuggest("all");
		const { ledger, wl } = workload();
		const j = pairJudge(async () => reply({ taste: GOOD.taste }, 0.00003));
		const h = host(ledger, wl, j.judge);
		await h.turnEnd();
		await flush();
		expect(pairEntries(ledger, wl)).toEqual([[CLASSIFIER_BY, "pair-signal-failed: attempt 1 malformed tokens unknown cost 0.00003"]]);
	});

	test("the 10 s limit ends an attempt whose judge ignores its signal: attempt 1 timeout at 10 s and not before, and the signal is aborted", async () => {
		vi.useFakeTimers();
		try {
			pairSuggest("all");
			const { ledger, wl } = workload();
			const j = pairJudge(() => Promise.withResolvers<never>().promise);
			const h = host(ledger, wl, j.judge);
			await h.turnEnd();
			await flush();
			expect(j.calls.length).toBe(1);
			vi.advanceTimersByTime(9_999);
			await flush();
			expect(pairEntries(ledger, wl)).toEqual([]);
			vi.advanceTimersByTime(1);
			await flush();
			expect(pairEntries(ledger, wl)).toEqual([[CLASSIFIER_BY, "pair-signal-failed: attempt 1 timeout tokens unknown cost unknown"]]);
			expect(j.calls[0]!.signal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("switched on mid-session: the next tool result writes pair-signal:, and the next round-limit raise offers pair on E alone", async () => {
		pairSuggest("off");
		const { ledger, wl } = workload();
		const j = pairJudge(async () => reply(GOOD, 0.0001));
		const h = host(ledger, wl, j.judge);
		await h.turnEnd();
		await flush();
		expect(j.calls.length).toBe(0);
		pairSuggest("all");
		h.otherToolResult("read", {});
		await flush();
		expect(pairEntries(ledger, wl)).toEqual([[CLASSIFIER_BY, SUCCESS]]);
		expect(raiseOffer(ledger, wl)).toEqual({ signals: ["e"] });
	});

	test("a raise while the attempt is pending offers nothing, and the later raise offers on E", async () => {
		pairSuggest("all");
		const { ledger, wl } = workload();
		const d = Promise.withResolvers<unknown>();
		const j = pairJudge(() => d.promise);
		const h = host(ledger, wl, j.judge);
		await h.turnEnd();
		await flush();
		expect(j.calls.length).toBe(1);
		expect(raiseOffer(ledger, wl)).toBeNull();
		d.resolve(reply(GOOD, 0.0001));
		await flush();
		expect(pairEntries(ledger, wl)).toEqual([[CLASSIFIER_BY, SUCCESS]]);
		expect(raiseOffer(ledger, wl)).toEqual({ signals: ["e"] });
	});

	test("the 0.70 cut is on the judge's own confidence: taste yes 0.69996 is written unrounded and offers nothing; 0.70 offers pair on E", async () => {
		pairSuggest("all");
		const run = async (confidence: number) => {
			const { ledger, wl } = workload();
			const answers = { ...GOOD, taste: { choice: "yes", confidence, probabilities: { yes: confidence, no: 1 - confidence } } };
			const h = host(ledger, wl, pairJudge(async () => reply(answers, 0.0001)).judge);
			await h.turnEnd();
			await flush();
			return { signal: pairEntries(ledger, wl).map(([, body]) => body), raised: raiseOffer(ledger, wl) };
		};
		const below = await run(0.69996);
		expect(below.raised).toBeNull();
		expect(below.signal).toEqual(["pair-signal: taste yes 0.69996 ambiguous no 0.85 judge typesafe/jev-1.13.0 tokens unknown cost 0.0001"]);
		const at = await run(0.7);
		expect(at.signal).toEqual(["pair-signal: taste yes 0.7 ambiguous no 0.85 judge typesafe/jev-1.13.0 tokens unknown cost 0.0001"]);
		expect(at.raised).toEqual({ signals: ["e"] });
		const whole = await run(1);
		expect(whole.signal).toEqual(["pair-signal: taste yes 1 ambiguous no 0.85 judge typesafe/jev-1.13.0 tokens unknown cost 0.0001"]);
		expect(whole.raised).toEqual({ signals: ["e"] });
	});

	// Review round 2: a lane's own record that the switch covered it, independent of the per-workload jev attempt.
	const exposureRows = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("pair-exposure:")).map((e) => [e.created_by, e.body]);

	test("switch on: exactly one classifier pair-exposure: row per lane session across many events, pending, settled or not", async () => {
		pairSuggest("all");
		const { ledger, wl } = workload();
		const d = Promise.withResolvers<unknown>();
		const j = pairJudge(() => d.promise);
		const lane1 = extensionHost({ judge: j.judge, table: TABLE, registry: fakeRegistry(Object.values(TABLE).flat()), shared: { ledger, workloadId: wl }, boundWorkload: wl, laneId: "lane-jask-1" });
		await lane1.sessionStart();
		for (let i = 0; i < 3; i++) {
			await lane1.turnEnd();
			lane1.otherToolResult("read", {}, `pending-${i}`);
		}
		await flush();
		expect(exposureRows(ledger, wl)).toEqual([[CLASSIFIER_BY, "pair-exposure: lane-jask-1 on"]]);
		d.resolve(reply(GOOD, 0.0001));
		await flush();
		await lane1.turnEnd();
		lane1.otherToolResult("read", {}, "settled");
		await flush();
		expect(pairEntries(ledger, wl)).toEqual([[CLASSIFIER_BY, SUCCESS]]);

		// a later lane on the same workload: the jev attempt is over for the workload, its own row is still written once
		const lane2 = extensionHost({ judge: j.judge, table: TABLE, registry: fakeRegistry(Object.values(TABLE).flat()), shared: { ledger, workloadId: wl }, boundWorkload: wl, laneId: "lane-jask-2" });
		await lane2.sessionStart();
		for (let i = 0; i < 3; i++) {
			await lane2.turnEnd();
			lane2.otherToolResult("read", {}, `later-${i}`);
		}
		await flush();
		expect(exposureRows(ledger, wl)).toEqual([[CLASSIFIER_BY, "pair-exposure: lane-jask-1 on"], [CLASSIFIER_BY, "pair-exposure: lane-jask-2 on"]]);
		expect(j.calls.length).toBe(1);
	});

	test("switch off: no pair-exposure: row and no pair row of any kind, on any event", async () => {
		pairSuggest("off");
		const { ledger, wl } = workload();
		const h = host(ledger, wl, pairJudge(async () => reply(GOOD, 0.0001)).judge);
		await h.sessionStart();
		for (let i = 0; i < 3; i++) {
			await h.turnEnd();
			h.otherToolResult("read", {}, `off-${i}`);
		}
		await flush();
		expect(ledger.entries(wl).filter((e) => e.body.startsWith("pair-"))).toEqual([]);
	});
});
