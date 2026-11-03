/**
 * PR 1 of wl-mv67564rdkfvnk (PLAN rev 5 § 2 D1–D3, D6; § 5 `sl-trig-tests`): the round-limit question raised in
 * `roundSettled` offers `pair` when the `pair-suggest` switch covers the workload and a signal fired. Driven through
 * the classifier extension on a fake OMP host with a real temp ledger and a real git repository, as crosslab.test.ts
 * drives the round limit: a review dispatched, spawned, answered and settled, round after round.
 *
 * The switch is the installed profile's `pairSuggest` key (D2), read at each raise. The test writes it where the
 * existing code already looks for the installed profile: `$HOME/.omp/profiles/<profile>/agent/config.yml` (bin/as2
 * `CONFIG`, surface/scripts/lane.ts preflight), with `PI_CODING_AGENT_DIR` pointing at the same agent directory. HOME
 * is a per-file temp directory, restored afterwards.
 *
 * Regression: these fail on 946c016 by assertion (no `pair` option, no `pair-offer:` entry). The switch-off,
 * missing-config, throwaway, user-driven and forged-signal cases are guards that pass there too. Since PLAN
 * wl-mvb9mw00ycfjeo D1 (R1) an offered question's body is byte-identical to the no-offer raise.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_BY, Ledger, type Mode, type Stakes } from "../../ledger/src/index";
import { JO_HOLDER } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import {
	countRounds, effectiveRoundLimit, ROUND_LIMIT_OPTIONS, roundLimitQuestionBody, reviewRoundsBody, roundsInstructionBody,
} from "../src/rounds";
import { tierTableFromConfig } from "../src/tier-table";
import { dist, fakeRegistry, recordedQuestion } from "./helpers";

const ROWS = {
	fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const [OPUS, SOL] = ROWS.strong as [string, string, string];
const SL = "sl-x";

/** The kind judge (every task here is a review: judge 0.9) and, for a pair-signal request, `taste` and `ambiguous` both `no`. */
const JUDGE = {
	judge: async (req: { state: string; questions?: Record<string, unknown> }) => {
		if (req.questions && "taste" in req.questions) {
			const no = { choice: "no", confidence: 0.9, probabilities: { yes: 0.1, no: 0.9 } };
			return { answers: { taste: no, ambiguous: no }, provider: "typesafe", model: "jev-1.13.0", usage: { cost: { total: 0.0001 } } };
		}
		return { answers: { kind: { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) } }, provider: "typesafe", model: "jev-1.13.0" };
	},
};

// ---- the switch: the installed profile's config.yml under a per-file HOME ---------------------------------------

const PROFILE = process.env.AGENT_SYSTEM_PROFILE || process.env.OMP_PROFILE || "agent-system-2";
const saved = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR };
let agentDir = "";
const dirs: string[] = [];

beforeAll(() => {
	const home = mkdtempSync(join(tmpdir(), "pair-raise-home-"));
	dirs.push(home);
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
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `pairSuggest: <value>` in the installed profile config (a YAML scalar or flow list), or no config file at all. */
function pairSuggest(value: string | null): void {
	if (value === null) rmSync(join(agentDir, "config.yml"), { force: true });
	else writeFileSync(join(agentDir, "config.yml"), `setupVersion: 2\npairSuggest: ${value}\n`);
}

// ---- the world and the lane (crosslab.test.ts's shape) ---------------------------------------------------------

let seq = 0;

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A workload on a temp ledger with slice sl-x, the lane's repository and its session file. */
interface World {
	ledger: Ledger;
	wl: string;
	repo: string;
	laneFile: string;
	root: string;
	stakes: Stakes;
}

function world(opts: { stakes?: Stakes; mode?: Mode } = {}): World {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "pair-raise-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: `wl-pairraise${++seq}`, brief: "Restyle the settings modal", stakes: opts.stakes ?? "normal", mode: opts.mode ?? "autonomous", by: "orch-test" });
	ledger.addSlice({ id: SL, workloadId: wl, task: SL, doneCondition: "d", inputs: "i", by: "lane-test" });
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
	return { ledger, wl, repo, laneFile, root: laneFile.slice(0, -".jsonl".length), stakes: opts.stakes ?? "normal" };
}

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Reply = { block?: boolean; reason?: string; input?: { agent: string } } | undefined;

/** One lane process: the classifier bound to the lane's session and to its hands' sessions. */
interface Lane {
	laneMessage(selector: string): unknown;
	toolCall(input: unknown, toolCallId: string): Promise<Reply>;
	spawn(agent: string, spawnKey: string): Promise<Reply>;
	handMessage(agentId: string, selector: string): unknown;
	results(toolCallId: string, results: { id: string; agent: string; model: string; output: string }[]): unknown;
}

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
		ompState: () => "same",
		lastWrite: () => null,
		log: () => {},
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.repo, modelRegistry: fakeRegistry(ALL), sessionManager: { getSessionFile: () => w.laneFile } };
	const assistant = (selector: string) => {
		const [provider, ...model] = selector.split("/");
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
	};
	return {
		laneMessage: (selector: string) => handlers.message_end!(assistant(selector), ctx),
		toolCall: (input: unknown, toolCallId: string) => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
		spawn: (agent: string, spawnKey: string) =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<Reply>,
		handMessage: (agentId: string, selector: string) =>
			handSession.message_end!(assistant(selector), { ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } }),
		results: (toolCallId: string, results: { id: string; agent: string; model: string; output: string }[]) =>
			handlers.tool_result!(
				{
					type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [],
					details: { results: results.map((r) => ({ id: r.id, agent: r.agent, resolvedModelIdentity: r.model, output: r.output })) },
				},
				ctx,
			),
	};
}

/** One blocking review round of sl-x on its own call: dispatch, spawn, answer on sol, settle (crosslab.test.ts `reviewRound`). */
async function reviewRound(h: Lane, w: World, call: string, title: string): Promise<void> {
	const n = w.ledger.routings(w.wl).filter((r) => r.slice_id === SL).length;
	const id = n === 0 ? SL : `${SL}-${n}`;
	const task = `workload: ${w.wl}\ntask: review the change\ndone-condition: d\ninputs: i\nstakes: ${w.stakes}\nceiling-share: 10`;
	const out = await h.toolCall({ agent: "strong", name: SL, task }, call);
	expect(out?.block).toBeUndefined();
	expect((await h.spawn(out!.input!.agent, SL))?.reason).toBeUndefined();
	h.handMessage(id, SOL);
	const output = `Reviewed the change.\n\n\`\`\`review-findings\n${JSON.stringify({ findings: [{ severity: "blocking", kind: "correctness", title }] })}\n\`\`\`\n`;
	h.results(call, [{ id, agent: out!.input!.agent, model: SOL, output }]);
}

/** Jo's `rounds <n>`, as the surface writes it. */
function roundsLimit(w: World, n: number): void {
	const by = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: roundsInstructionBody(n), author: JO_HOLDER, channel: "surface" });
	w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: reviewRoundsBody(n, `rounds ${n}`, by) });
}

/** The classifier's jev answer (D4's success form), stamped as the classifier writes it unless `by` says otherwise. */
function pairSignal(w: World, body: string, by = CLASSIFIER_BY): void {
	w.ledger.recordEntry({ by, workloadId: w.wl, kind: "assumption", body });
}
const TASTE_YES = "pair-signal: taste yes 0.91 ambiguous no 0.85 judge typesafe/jev-1.13.0 cost 0.0001";

/** Settle `rounds` blocking rounds of sl-x and return the one round-limit question. */
async function toTheLimit(w: World, rounds: number): Promise<{ id: string; body: string; options: string[] }> {
	const h = lane(w);
	h.laneMessage(OPUS);
	for (let i = 1; i <= rounds; i++) await reviewRound(h, w, `rev-${i}`, `finding ${i}`);
	const qs = w.ledger.questions(w.wl);
	expect(qs).toHaveLength(1);
	return { id: qs[0]!.id, body: qs[0]!.body, options: JSON.parse(qs[0]!.options) as string[] };
}

/** The body the unchanged raise writes: `roundLimitQuestionBody` over the rows the raise read. */
function baseBody(w: World): string {
	const entries = w.ledger.entries(w.wl).filter((e) => !/^(review-limit|pair-offer):/.test(e.body));
	return roundLimitQuestionBody(SL, countRounds(entries, SL), effectiveRoundLimit(entries, w.ledger.instructions(w.wl), w.stakes, SL), w.stakes);
}

const offers = (w: World) => w.ledger.entries(w.wl).filter((e) => e.body.startsWith("pair-offer:"));
/** The `pair-offer: <q> site <site> signals <a,b,…>` entry, parsed; signal ids lower-cased. */
function parsedOffer(body: string): { q: string; site: string; signals: string[] } | null {
	const m = /^pair-offer: (\S+) site (\S+) signals (\S+)$/.exec(body);
	return m ? { q: m[1]!, site: m[2]!, signals: m[3]!.toLowerCase().split(",") } : null;
}

describe("round-limit raise with pair-suggest on (D1, D3, D6; PLAN wl-mvb9mw00ycfjeo D1, R1)", () => {
	test("switch all and a classifier-stamped `pair-signal: taste yes 0.91`: options end with pair, the body is byte-identical to the no-offer raise, and one classifier-stamped pair-offer: names the question", async () => {
		pairSuggest("all");
		const w = world();
		roundsLimit(w, 1);
		pairSignal(w, TASTE_YES);
		const q = await toTheLimit(w, 1);
		expect(q.options).toEqual([...ROUND_LIMIT_OPTIONS, "pair"]);
		expect(q.body).toBe(baseBody(w));
		expect(q.body).not.toContain("pair");
		const o = offers(w);
		expect(o.map((e) => e.created_by)).toEqual([CLASSIFIER_BY]);
		expect(parsedOffer(o[0]!.body)).toEqual({ q: q.id, site: "round-limit", signals: ["e"] });
		// the round-limit question is still the classifier's: its review-limit: entry is written as before
		expect(w.ledger.entries(w.wl).filter((e) => e.body === `review-limit: ${q.id} slice ${SL}`)).toHaveLength(1);
	});

	test("signal A alone (blocking 1 → 1 → 1 at the default limit of 3): pair is offered with the stalled-review reason", async () => {
		pairSuggest("all");
		const w = world();
		const q = await toTheLimit(w, 3);
		expect(q.options).toEqual([...ROUND_LIMIT_OPTIONS, "pair"]);
		expect(q.body).toBe(baseBody(w));
		expect(q.body).not.toContain("pair");
		expect(parsedOffer(offers(w)[0]!.body)).toEqual({ q: q.id, site: "round-limit", signals: ["a"] });
	});

	test("a list naming the workload turns it on; a list naming only another workload leaves it off", async () => {
		const on = world();
		pairSuggest(`[wl-elsewhere, ${on.wl}]`);
		roundsLimit(on, 1);
		pairSignal(on, TASTE_YES);
		expect((await toTheLimit(on, 1)).options).toEqual([...ROUND_LIMIT_OPTIONS, "pair"]);

		const off = world();
		pairSuggest("[wl-elsewhere]");
		roundsLimit(off, 1);
		pairSignal(off, TASTE_YES);
		const q = await toTheLimit(off, 1);
		expect(q.options).toEqual([...ROUND_LIMIT_OPTIONS]);
		expect(q.body).toBe(baseBody(off));
		expect(offers(off)).toEqual([]);
	});
});

describe("round-limit raise with nothing to offer: byte-identical to the raise without the feature (guards)", () => {
	for (const [name, value] of [["switch off", "off"], ["no profile config", null], ["malformed value", "{ nope: 1 }"]] as const) {
		test(`${name}, with the same taste signal: body and options are exactly the unchanged raise's, no pair-offer:`, async () => {
			pairSuggest(value);
			const w = world();
			roundsLimit(w, 1);
			pairSignal(w, TASTE_YES);
			const q = await toTheLimit(w, 1);
			expect(q.options).toEqual([...ROUND_LIMIT_OPTIONS]);
			expect(q.body).toBe(baseBody(w));
			expect(offers(w)).toEqual([]);
		});
	}

	test("switch all at throwaway stakes, and on a user-driven workload: no offer", async () => {
		pairSuggest("all");
		for (const opts of [{ stakes: "throwaway" as const }, { mode: "user-driven" as const }]) {
			const w = world(opts);
			roundsLimit(w, 1);
			pairSignal(w, TASTE_YES);
			const q = await toTheLimit(w, 1);
			expect({ opts, options: q.options, body: q.body === baseBody(w), offers: offers(w).length }).toEqual({ opts, options: [...ROUND_LIMIT_OPTIONS], body: true, offers: 0 });
		}
	});

	test("switch all and a taste signal stamped by the lane, not the classifier: no offer", async () => {
		pairSuggest("all");
		const w = world();
		roundsLimit(w, 1);
		pairSignal(w, TASTE_YES, "lane-test");
		const q = await toTheLimit(w, 1);
		expect(q.options).toEqual([...ROUND_LIMIT_OPTIONS]);
		expect(q.body).toBe(baseBody(w));
		expect(offers(w)).toEqual([]);
	});
});
