// PR 1 of wl-mv67564rdkfvnk (PLAN rev 5 § 2 D1, D3, D6; § 5 `sl-trig-tests`): the lane runner's ceiling question
// (`raiseCeilingQuestion`, surface/scripts/lane.ts) offers `pair` when the `pair-suggest` switch covers the workload and
// a signal fired: B (three or more long steers from Jo) with C (no done slice) in the main case, E from a
// classifier-stamped `pair-signal:`, and never C alone.
//
// The switch is the installed profile's `pairSuggest` key (D2), read at each raise. The test writes it where the
// existing code already looks for the installed profile: `$HOME/.omp/profiles/<profile>/agent/config.yml` (bin/as2
// `CONFIG`, lane.ts preflight), with `PI_CODING_AGENT_DIR` pointing at the same agent directory. HOME is a per-file
// temp directory, restored afterwards.
//
// Regression: the offering cases fail on 946c016 by assertion (no `pair` option, no `pair:` line, no `pair-offer:`).
// C alone and switch off are guards that pass there too.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_BY, LANE_RUNNER_BY, type Ledger } from "../../ledger/src/index";
import { type Ceiling, CEILING_OPTIONS, ceilingQuestionBody, type Spend } from "../src/ceiling";
import { expectedLinks, linkHeader } from "../src/question-links";
import { SURFACE_BY } from "../src/types";
import { raiseCeilingQuestion } from "../scripts/lane";
import { tempLedger, workloadWithSlice } from "./helpers";

const NORMAL: Ceiling = { usd: 50, wallMin: 360 };
const SPEND: Spend = { usd: 40, tokens: 1000, wallMin: 30 };

// ---- the switch: the installed profile's config.yml under a per-file HOME ---------------------------------------

const PROFILE = process.env.AGENT_SYSTEM_PROFILE || process.env.OMP_PROFILE || "agent-system-2";
const saved = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR };
let agentDir = "";
let home = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "pair-ceiling-home-"));
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
	rmSync(home, { recursive: true, force: true });
});

/** `pairSuggest: <value>` in the installed profile config (a YAML scalar or flow list). */
function pairSuggest(value: string): void {
	writeFileSync(join(agentDir, "config.yml"), `setupVersion: 2\npairSuggest: ${value}\n`);
}

// ---- fixtures -------------------------------------------------------------------------------------------------------

/** Jo's words as the orchestrator relays them (`Jo: "<words>" — reading: …`), recorded by the surface as Jo. */
function steer(ledger: Ledger, wl: string, words: string): void {
	ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `Jo: "${words}" — reading: steer the lane`, author: "jo", channel: "surface" });
}
/** Quoted words over 80 characters: a long steer (signal B). */
const LONG = "Use the existing token scale rather than new pixel values, and keep the header aligned with the sidebar grid.";

async function raise(ledger: Ledger, wl: string): Promise<{ body: string; options: string[]; id: string }> {
	const { questionId } = await raiseCeilingQuestion(ledger, { workloadId: wl, laneId: `lane-${wl.slice(3)}-1`, spend: SPEND, ceiling: NORMAL, stakes: "normal" });
	const q = ledger.question(questionId)!;
	return { id: q.id, body: q.body, options: JSON.parse(q.options) as string[] };
}

const offers = (ledger: Ledger, wl: string) => ledger.entries(wl).filter((e) => e.body.startsWith("pair-offer:"));
/** The `pair-offer: <q> site <site> signals <a,b,…>` entry, parsed; signal ids lower-cased and sorted. */
function parsedOffer(body: string): { q: string; site: string; signals: string[] } | null {
	const m = /^pair-offer: (\S+) site (\S+) signals (\S+)$/.exec(body);
	return m ? { q: m[1]!, site: m[2]!, signals: m[3]!.toLowerCase().split(",").sort() } : null;
}

const BASE = (ledger: Ledger, wl: string) => ceilingQuestionBody(wl, SPEND, NORMAL, "normal",
	expectedLinks(ledger, { workloadId: wl, sliceId: null, prs: { ok: true, prs: [] } }));
const CEILING_TAIL = (wl: string) =>
	`Answering pair is stop plus a switch to user-driven: the autonomous lane stops at the ceiling, and you continue it yourself (as2 lane ${wl}).`;

describe("ceiling raise with pair-suggest on (D1, D3, D6)", () => {
	test("signals B and C (three long steers, no done slice): options end with pair, the body is the linked body plus one last `pair:` line, and one lane-runner pair-offer: names the question", async () => {
		pairSuggest("all");
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		for (let i = 0; i < 3; i++) steer(ledger, wl, LONG);
		const q = await raise(ledger, wl);
		expect(q.options).toEqual([...CEILING_OPTIONS, "pair"]);
		const lines = q.body.split("\n");
		expect(lines.slice(0, -1).join("\n")).toBe(BASE(ledger, wl));
		const header = linkHeader(expectedLinks(ledger, { workloadId: wl, sliceId: null, prs: { ok: true, prs: [] } }));
		expect(lines.slice(0, header.length)).toEqual(header);
		expect(ledger.entries(wl).filter((e) => e.body.startsWith(`question-links: ${q.id} `))).toHaveLength(1);
		const line = lines.at(-1)!;
		expect(line).toStartWith("pair: ");
		expect(line).toContain("3 long steers from you since open");
		expect(line).toEndWith(`. ${CEILING_TAIL(wl)}`);
		const o = offers(ledger, wl);
		expect(o.map((e) => e.created_by)).toEqual([LANE_RUNNER_BY]);
		expect(parsedOffer(o[0]!.body)).toEqual({ q: q.id, site: "ceiling", signals: ["b", "c"] });
	});

	test("B with a done slice: offered on B alone, with B's reason as the whole reason", async () => {
		pairSuggest("all");
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		ledger.completeSlice(sl, { by: "lane-a", artifact: "bun test → exit 0" });
		for (let i = 0; i < 4; i++) steer(ledger, wl, LONG);
		const q = await raise(ledger, wl);
		expect(q.options).toEqual([...CEILING_OPTIONS, "pair"]);
		expect(q.body).toBe(`${BASE(ledger, wl)}\npair: 4 long steers from you since open. ${CEILING_TAIL(wl)}`);
		expect(parsedOffer(offers(ledger, wl)[0]!.body)?.signals).toEqual(["b"]);
	});

	test("E alone (a classifier-stamped `pair-signal: taste yes 0.91`) with a done slice: offered with the jev reason", async () => {
		pairSuggest("all");
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		ledger.completeSlice(sl, { by: "lane-a", artifact: "bun test → exit 0" });
		ledger.recordEntry({ by: CLASSIFIER_BY, workloadId: wl, kind: "assumption", body: "pair-signal: taste yes 0.91 ambiguous no 0.85 judge typesafe/jev-1.13.0 cost 0.0001" });
		const q = await raise(ledger, wl);
		expect(q.options).toEqual([...CEILING_OPTIONS, "pair"]);
		expect(q.body).toBe(`${BASE(ledger, wl)}\npair: jev: UI/taste work (0.91). ${CEILING_TAIL(wl)}`);
		expect(parsedOffer(offers(ledger, wl)[0]!.body)?.signals).toEqual(["e"]);
	});
});

describe("ceiling raise with nothing to offer: byte-identical to the raise without the feature (guards)", () => {
	test("C alone (no done slice, two long steers only): no offer", async () => {
		pairSuggest("all");
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		for (let i = 0; i < 2; i++) steer(ledger, wl, LONG);
		const q = await raise(ledger, wl);
		expect(q.options).toEqual([...CEILING_OPTIONS]);
		expect(q.body).toBe(BASE(ledger, wl));
		expect(offers(ledger, wl)).toEqual([]);
	});

	test("switch off with B and C: body and options exactly the linked raise's, no pair-offer:", async () => {
		pairSuggest("off");
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		for (let i = 0; i < 3; i++) steer(ledger, wl, LONG);
		const q = await raise(ledger, wl);
		expect(q.options).toEqual([...CEILING_OPTIONS]);
		expect(q.body).toBe(BASE(ledger, wl));
		expect(offers(ledger, wl)).toEqual([]);
	});

	test("long words that are not Jo's surface instructions (a direct-channel instruction, a relay of short words) do not count toward B", async () => {
		pairSuggest("all");
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		for (let i = 0; i < 3; i++) {
			ledger.recordInstruction({ by: "lane-a", workloadId: wl, body: LONG, author: "jo", channel: "direct" });
			// the body is long, the quoted words are not: B measures the quoted words of a relay
			ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `Jo: "yes, go on" — reading: ${LONG}`, author: "jo", channel: "surface" });
		}
		const q = await raise(ledger, wl);
		expect(q.options).toEqual([...CEILING_OPTIONS]);
		expect(q.body).toBe(BASE(ledger, wl));
	});

	test("a pair offer that throws while it is computed: the linked question is raised, the throw is logged, and the raise does not fail (review fix 4)", async () => {
		pairSuggest("all");
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		for (let i = 0; i < 3; i++) steer(ledger, wl, LONG);
		// `pairOffer` reads the workload's instructions (signal B); the raise itself never does, so this throw lands in the offer alone.
		const broken = new Proxy(ledger, {
			get(target, key) {
				if (key === "instructions") return () => { throw new Error("injected instructions read failure"); };
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const logged: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;
		let q: { body: string; options: string[]; id: string } | undefined;
		try {
			q = await raise(broken, wl);
		} finally {
			process.stderr.write = write;
		}
		expect(q?.options).toEqual([...CEILING_OPTIONS]);
		expect(q?.body).toBe(BASE(ledger, wl));
		expect(offers(ledger, wl)).toEqual([]);
		expect(logged.join("")).toContain(`the pair offer on ${wl} could not be computed (Error: injected instructions read failure)`);
	});
});
