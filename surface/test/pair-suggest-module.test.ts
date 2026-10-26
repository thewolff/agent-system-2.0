// new guard: no fail-before
//
// PR 1 of wl-mv67564rdkfvnk (PLAN rev 5 § 2 D2, D3, D5, D6, D8; § 5 `sl-trig-tests`): guards over the new module
// surface/src/pair-suggest.ts, which does not exist before PR 1, so this file fails on its import until the build.
//
// The module's API as these tests pin it (GUESS(design), from the plan's named functions):
//   pairSuggestOn(config: unknown, workloadId: string): boolean
//       `config` is the parsed installed profile config; its `pairSuggest` key is `off` | `all` | a list of workload
//       ids. Missing or malformed reads as off (D2).
//   mechanicalEligibility(ledger: Ledger, workloadId: string, at: string): { eligible: boolean; signals: string[] }
//       Ungated, no jev, no switch: A (from the workload's review rounds) and B (with D2's +1), over the rows written at
//       or before `at` (D8).
//   pairOffer(ledger: Ledger, workloadId: string, ctx: { config: unknown; count?: RoundCount }): { signals: string[] } | null
//       The round-limit raise's offer (the one raise site since PLAN wl-mvfkv7llkp7nk0 § 4). Gated by the switch,
//       throwaway stakes and the autonomous mode; A from `ctx.count` only; E / D1 from classifier-stamped `pair-signal:`
//       entries at 0.70; D5's caps over classifier-stamped `pair-offer:` entries. The offer carries no text since PLAN
//       wl-mvb9mw00ycfjeo D1: the surface renders it from the `pair-offer:` entry.
//   pairSuggestHealth(ledger: Ledger, laneId: string): number
//       D8's `post-signal-failed-rounds`: failed review rounds plus Jo's one-block raises (`extend <wl>`, a `ceiling:`
//       entry with source `extend one block`) on the lane's workload between its `lane-started:` and `lane-exit:`, after
//       the lane's first mechanical eligibility moment; 0 with none.
// Signal ids are lower-case `a`, `b`, `d1`, `d2`, `e`, compared sorted.
import { describe, expect, test } from "bun:test";
import { countRounds, type FindingsOrUnknown, type ReviewVerdict, reviewRoundBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { CLASSIFIER_BY, LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { report } from "../scripts/pair-suggest";
import { apply, interpret } from "../src/input";
import { laneExitBody, laneStartedBody, PLAN_OPTIONS, planFirstBody, planQuestionBody } from "../src/launch";
import { mechanicalEligibility, pairLaneExposure, pairOffer, pairSuggestHealth, pairSuggestOn } from "../src/pair-suggest";
import { SURFACE_BY } from "../src/types";
import { clock, tempLedger, workloadWithSlice } from "./helpers";

const ON = { setupVersion: 2, pairSuggest: "all" };
const LANE = "lane-t-1";

/** Quoted words over 80 characters: a long steer (signal B). */
const LONG = "Use the existing token scale rather than new pixel values, and keep the header aligned with the sidebar grid.";

/** Jo's words as the orchestrator relays them (`Jo: "<words>" — reading: …`), recorded by the surface as Jo. */
function steer(ledger: Ledger, wl: string, words = LONG, over: { author?: string; channel?: "surface" | "direct" } = {}): void {
	ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `Jo: "${words}" — reading: steer the lane`, author: over.author ?? "jo", channel: over.channel ?? "surface" });
}

function entry(ledger: Ledger, wl: string, by: string, body: string, sliceId?: string): void {
	ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body, ...(sliceId ? { sliceId } : {}) });
}

const TASTE = (conf: string, by = CLASSIFIER_BY) => (ledger: Ledger, wl: string) =>
	entry(ledger, wl, by, `pair-signal: taste yes ${conf} ambiguous no 0.85 judge typesafe/jev-1.13.0 cost 0.0001`);

/** One single-hand review round of `sl` with `blocking` blocking findings; withheld (a failed round) when blocking is 0. */
function round(ledger: Ledger, wl: string, sl: string, n: number, blocking: number): void {
	const findings: FindingsOrUnknown = { counts: { blocking: blocking ? { correctness: blocking } : {}, major: {}, minor: {} }, titles: [] };
	const verdict: ReviewVerdict = blocking ? "accepted" : "withheld";
	entry(ledger, wl, LANE, reviewRoundBody({ slice: sl, round: n, token: `dt-${sl}-${n}`, group: `dg-${sl}-${n}`, verdict, findings }), sl);
}

const sorted = (o: { signals: string[] } | null) => (o ? [...o.signals].map((s) => s.toLowerCase()).sort() : null);

describe("pairSuggestOn: the switch's one reader (D2)", () => {
	test("off, all and a list", () => {
		expect(pairSuggestOn({ pairSuggest: "off" }, "wl-a")).toBe(false);
		expect(pairSuggestOn({ pairSuggest: "all" }, "wl-a")).toBe(true);
		expect(pairSuggestOn({ pairSuggest: ["wl-a", "wl-b"] }, "wl-a")).toBe(true);
		expect(pairSuggestOn({ pairSuggest: ["wl-b"] }, "wl-a")).toBe(false);
		expect(pairSuggestOn({ pairSuggest: [] }, "wl-a")).toBe(false);
	});

	test("missing or malformed reads as off", () => {
		for (const config of [undefined, null, "all", 7, {}, { setupVersion: 2 }, { pairSuggest: null }, { pairSuggest: 1 }, { pairSuggest: true }, { pairSuggest: "on" }, { pairSuggest: "ALL" }, { pairSuggest: { all: true } }, { pairSuggest: [1, 2] }]) {
			expect({ config, on: pairSuggestOn(config, "wl-a") }).toEqual({ config, on: false });
		}
	});
});

describe("mechanicalEligibility: ungated A and B (+D2) (D3, D8)", () => {
	test("B: three long steers from Jo at the surface; two are not enough; short quotes, other authors and direct channel never count", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		steer(ledger, wl);
		steer(ledger, wl);
		steer(ledger, wl, "ok go");
		ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `Jo: "short" — reading: ${"a long reading that is not Jo's own words ".repeat(3)}`, author: "jo", channel: "surface" });
		steer(ledger, wl, LONG, { channel: "direct" });
		steer(ledger, wl, LONG, { author: "ilex" });
		expect(mechanicalEligibility(ledger, wl, ledger.now())).toEqual({ eligible: false, signals: [] });
		ledger.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: `please ${LONG}`, author: "jo", channel: "surface" });
		const e = mechanicalEligibility(ledger, wl, ledger.now());
		expect(e.eligible).toBe(true);
		expect(sorted(e)).toContain("b");
	});

	test("D2: two revise answers on the plan question add one to B's count", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		entry(ledger, wl, LANE_STARTER_BY, `launch: ${LANE} cause first requested-by test`);
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
		entry(ledger, wl, SURFACE_BY, planFirstBody("stakes production"));
		steer(ledger, wl);
		steer(ledger, wl);
		for (let i = 1; i <= 2; i++) {
			const plan = ledger.addSlice({ by: LANE, workloadId: wl, task: `plan ${i}`, doneCondition: "Jo approves", inputs: "brief" });
			const q = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: plan, body: `/tmp/PLAN.md\n- sl-a: a\ntradeoff: t\nreview: approve, m, /tmp/R.md`, options: [...PLAN_OPTIONS] });
			entry(ledger, wl, LANE, planQuestionBody(q), plan);
			if (i === 1) expect(mechanicalEligibility(ledger, wl, ledger.now()).eligible).toBe(false);
			ledger.answerQuestion(q, { by: SURFACE_BY, answer: "revise", author: "jo", channel: "surface" });
		}
		const e = mechanicalEligibility(ledger, wl, ledger.now());
		expect(e.eligible).toBe(true);
		expect(sorted(e)).toContain("b");
	});

	test("A: two or more rounds with known blocking counts and the last at least the first; a falling count is not A", () => {
		const { ledger } = tempLedger();
		const stalled = workloadWithSlice(ledger);
		round(ledger, stalled.wl, stalled.sl, 1, 2);
		expect(mechanicalEligibility(ledger, stalled.wl, ledger.now()).eligible).toBe(false);
		round(ledger, stalled.wl, stalled.sl, 2, 2);
		const e = mechanicalEligibility(ledger, stalled.wl, ledger.now());
		expect(e.eligible).toBe(true);
		expect(sorted(e)).toContain("a");

		const falling = workloadWithSlice(ledger);
		round(ledger, falling.wl, falling.sl, 1, 2);
		round(ledger, falling.wl, falling.sl, 2, 1);
		expect(mechanicalEligibility(ledger, falling.wl, ledger.now())).toEqual({ eligible: false, signals: [] });
	});

	test("jev signals never count here", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		TASTE("0.99")(ledger, wl);
		entry(ledger, wl, CLASSIFIER_BY, "pair-signal: taste no 0.99 ambiguous yes 0.99 judge typesafe/jev-1.13.0 cost 0.0001");
		expect(mechanicalEligibility(ledger, wl, ledger.now())).toEqual({ eligible: false, signals: [] });
	});

	test("only rows written at or before `at` count", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		steer(ledger, wl);
		c.plusHours(1);
		steer(ledger, wl);
		c.plusHours(1);
		const before = ledger.now();
		c.plusHours(1);
		steer(ledger, wl);
		expect(mechanicalEligibility(ledger, wl, before).eligible).toBe(false);
		expect(mechanicalEligibility(ledger, wl, ledger.now()).eligible).toBe(true);
	});
});

describe("pairOffer: gates, signals and the D6 line", () => {
	test("gates: switch off or not naming the workload, throwaway stakes, user-driven mode → no offer", () => {
		const { ledger } = tempLedger();
		const mk = (over: { stakes?: "throwaway" | "normal"; mode?: "autonomous" | "user-driven" } = {}) => {
			const { wl } = workloadWithSlice(ledger, over);
			for (let i = 0; i < 3; i++) steer(ledger, wl);
			TASTE("0.95")(ledger, wl);
			return wl;
		};
		const wl = mk();
		expect(pairOffer(ledger, wl, { config: ON })).not.toBeNull();
		expect(pairOffer(ledger, wl, { config: { pairSuggest: "off" } })).toBeNull();
		expect(pairOffer(ledger, wl, { config: { pairSuggest: ["wl-other"] } })).toBeNull();
		expect(pairOffer(ledger, wl, { config: { pairSuggest: [wl] } })).not.toBeNull();
		expect(pairOffer(ledger, wl, { config: null })).toBeNull();
		expect(pairOffer(ledger, mk({ stakes: "throwaway" }), { config: ON })).toBeNull();
		expect(pairOffer(ledger, mk({ mode: "user-driven" }), { config: ON })).toBeNull();
	});

	test("E: taste yes at 0.70 fires and 0.69 does not; taste no, a lane-stamped signal and a failed attempt never fire", () => {
		const { ledger } = tempLedger();
		const at = (f: (l: Ledger, wl: string) => void) => {
			const { wl } = workloadWithSlice(ledger);
			f(ledger, wl);
			return pairOffer(ledger, wl, { config: ON });
		};
		expect(sorted(at(TASTE("0.70")))).toEqual(["e"]);
		expect(at(TASTE("0.69"))).toBeNull();
		expect(at((l, wl) => entry(l, wl, CLASSIFIER_BY, "pair-signal: taste no 0.99 ambiguous no 0.99 judge typesafe/jev-1.13.0 cost 0.0001"))).toBeNull();
		expect(at(TASTE("0.95", LANE))).toBeNull();
		expect(at(TASTE("0.95", SURFACE_BY))).toBeNull();
		expect(at((l, wl) => entry(l, wl, CLASSIFIER_BY, "pair-signal-failed: attempt 1 timeout cost unknown"))).toBeNull();
	});

	test("D1: ambiguous yes at 0.70 or above fires on its own", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		entry(ledger, wl, CLASSIFIER_BY, "pair-signal: taste no 0.90 ambiguous yes 0.85 judge typesafe/jev-1.13.0 cost 0.0001");
		const o = pairOffer(ledger, wl, { config: ON });
		expect(sorted(o)).toEqual(["d1"]);
	});

	test("the offer is its signals alone: E, B, and A from the raise's round count", () => {
		const { ledger } = tempLedger();
		const e = workloadWithSlice(ledger);
		TASTE("0.91")(ledger, e.wl);
		expect(pairOffer(ledger, e.wl, { config: ON })).toEqual({ signals: ["e"] });

		const b = workloadWithSlice(ledger);
		for (let i = 0; i < 4; i++) steer(ledger, b.wl);
		expect(pairOffer(ledger, b.wl, { config: ON })).toEqual({ signals: ["b"] });

		const a = workloadWithSlice(ledger);
		for (let n = 1; n <= 3; n++) round(ledger, a.wl, a.sl, n, 2);
		const count = countRounds(ledger.entries(a.wl), a.sl);
		const o = pairOffer(ledger, a.wl, { config: ON, count });
		expect(o).toEqual({ signals: ["a"] });
	});

	test("A only from the raise's round count and only from a stalled count; a falling count offers nothing", () => {
		const { ledger } = tempLedger();
		const stalled = workloadWithSlice(ledger);
		round(ledger, stalled.wl, stalled.sl, 1, 1);
		round(ledger, stalled.wl, stalled.sl, 2, 1);
		expect(pairOffer(ledger, stalled.wl, { config: ON })).toBeNull();
		expect(pairOffer(ledger, stalled.wl, { config: ON, count: countRounds(ledger.entries(stalled.wl), stalled.sl) })).toEqual({ signals: ["a"] });

		const falling = workloadWithSlice(ledger);
		round(ledger, falling.wl, falling.sl, 1, 3);
		round(ledger, falling.wl, falling.sl, 2, 1);
		expect(pairOffer(ledger, falling.wl, { config: ON, count: countRounds(ledger.entries(falling.wl), falling.sl) })).toBeNull();
	});
});

describe("pairOffer: D5 caps", () => {
	/** A round-limit question raised earlier with the classifier's offer on `signals`, as the round-limit site writes it. */
	function priorOffer(ledger: Ledger, wl: string, sl: string, signals: string[]): string {
		const q = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "Round limit.", options: [...ROUND_LIMIT_OPTIONS, "pair"] });
		entry(ledger, wl, CLASSIFIER_BY, `pair-offer: ${q} site round-limit signals ${signals.join(",")}`);
		return q;
	}

	function bWorkload(ledger: Ledger): { wl: string; sl: string } {
		const w = workloadWithSlice(ledger);
		for (let i = 0; i < 3; i++) steer(ledger, w.wl);
		return w;
	}

	test("at most two offers per workload", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = bWorkload(ledger);
		priorOffer(ledger, wl, sl, ["b"]);
		c.plusHours(2);
		expect(pairOffer(ledger, wl, { config: ON })).not.toBeNull();
		priorOffer(ledger, wl, sl, ["b"]);
		c.plusHours(2);
		TASTE("0.95")(ledger, wl);
		expect(pairOffer(ledger, wl, { config: ON })).toBeNull();
	});

	test("none within 60 minutes of the last offer", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = bWorkload(ledger);
		priorOffer(ledger, wl, sl, ["b"]);
		c.plusHours(0.5);
		expect(pairOffer(ledger, wl, { config: ON })).toBeNull();
		c.plusHours(0.55);
		expect(sorted(pairOffer(ledger, wl, { config: ON }))).toEqual(["b"]);
	});

	test("after Jo answers a non-pair option on an offered question: none, until a signal not in that offer fires", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = bWorkload(ledger);
		const q = priorOffer(ledger, wl, sl, ["b"]);
		ledger.answerQuestion(q, { by: SURFACE_BY, answer: "extend", author: "jo", channel: "surface" });
		c.plusHours(2);
		steer(ledger, wl);
		expect(pairOffer(ledger, wl, { config: ON })).toBeNull();
		TASTE("0.91")(ledger, wl);
		expect(sorted(pairOffer(ledger, wl, { config: ON }))).toContain("e");
	});
});

describe("pairSuggestHealth: D8's per-lane number, in both groups", () => {
	/**
	 * One lane's span on a fresh workload: `lane-started:`, then (when `eligible`) three long steers, then rounds falling
	 * 5 → 3 → 1 → 0-withheld (all failed, never stalled, so A never fires), Jo's `extend <wl>`, `lane-exit:`, and one
	 * more failed round after the exit. Rounds and the extend all land after the eligibility moment, except round 1.
	 */
	function laneSpan(ledger: Ledger, c: { plusHours: (h: number) => void }, opts: { eligible: boolean; switchOn: boolean }): string {
		const { wl, sl } = workloadWithSlice(ledger);
		const lane = `lane-${wl.slice(3)}-1`;
		if (opts.switchOn) TASTE("0.95")(ledger, wl);
		entry(ledger, wl, LANE_RUNNER_BY, laneStartedBody(lane, { pid: 1, start: "x", session: null, argv: [], runnerPid: 2 }));
		c.plusHours(0.1);
		round(ledger, wl, sl, 1, 5);
		c.plusHours(0.1);
		if (opts.eligible) for (let i = 0; i < 3; i++) steer(ledger, wl);
		c.plusHours(0.1);
		round(ledger, wl, sl, 2, 3);
		c.plusHours(0.1);
		round(ledger, wl, sl, 3, 1);
		c.plusHours(0.1);
		apply(ledger, interpret(ledger, `extend ${wl}`)!);
		c.plusHours(0.1);
		entry(ledger, wl, LANE_RUNNER_BY, laneExitBody(lane, { code: 0, signal: null, outcome: "completed" }));
		c.plusHours(0.1);
		round(ledger, wl, sl, 4, 0);
		return lane;
	}

	test("on-lane and off-lane with an eligibility moment: failed rounds after it plus Jo's extend raises, within the lane's span", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		expect(pairSuggestHealth(ledger, laneSpan(ledger, c, { eligible: true, switchOn: true }))).toBe(3);
		expect(pairSuggestHealth(ledger, laneSpan(ledger, c, { eligible: true, switchOn: false }))).toBe(3);
	});

	test("on-lane and off-lane with no eligibility moment score 0; a jev signal alone is no moment", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		expect(pairSuggestHealth(ledger, laneSpan(ledger, c, { eligible: false, switchOn: true }))).toBe(0);
		expect(pairSuggestHealth(ledger, laneSpan(ledger, c, { eligible: false, switchOn: false }))).toBe(0);
	});
});

describe("the report's switch groups: a lane is on by its own pair-exposure: row or a switch row in its span (review fixes 1 and 2)", () => {
	const started = (ledger: Ledger, wl: string, lane: string) =>
		entry(ledger, wl, LANE_RUNNER_BY, laneStartedBody(lane, { pid: 1, start: "x", session: null, argv: [], runnerPid: 2 }));
	const exited = (ledger: Ledger, wl: string, lane: string) => entry(ledger, wl, LANE_RUNNER_BY, laneExitBody(lane, { code: 0, signal: null, outcome: "completed" }));
	/** The report's `lanes` count for one group row, or null when the group has no row. */
	const groupLanes = (text: string, group: string): number | null => {
		const m = new RegExp(`^  ${group} +(\\d+) `, "m").exec(text);
		return m ? Number(m[1]) : null;
	};

	test("same workload, switched on for lane 1 (a signal and an offer in its span) and off before lane 2 (no pair rows): lane 2 is off", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const lane1 = `lane-${wl.slice(3)}-1`;
		const lane2 = `lane-${wl.slice(3)}-2`;
		started(ledger, wl, lane1);
		c.plusHours(0.1);
		entry(ledger, wl, CLASSIFIER_BY, `pair-exposure: ${lane1} on`);
		TASTE("0.95")(ledger, wl);
		c.plusHours(0.1);
		entry(ledger, wl, CLASSIFIER_BY, `pair-offer: q-x site round-limit signals e`);
		c.plusHours(0.1);
		exited(ledger, wl, lane1);
		c.plusHours(1); // the switch is turned off here: lane 2's classifier writes no pair-exposure:
		started(ledger, wl, lane2);
		c.plusHours(0.5);
		exited(ledger, wl, lane2);
		c.plusHours(0.1);
		const text = report(ledger, 30);
		expect(groupLanes(text, "on")).toBe(1);
		expect(groupLanes(text, "off")).toBe(1);
		expect(groupLanes(text, "unknown")).toBeNull();
	});

	test("same workload, switch on throughout: lane 1 (signal and offer) and lane 2 (only its pair-exposure: row) are both on", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const lane1 = `lane-${wl.slice(3)}-1`;
		const lane2 = `lane-${wl.slice(3)}-2`;
		started(ledger, wl, lane1);
		c.plusHours(0.1);
		entry(ledger, wl, CLASSIFIER_BY, `pair-exposure: ${lane1} on`);
		TASTE("0.95")(ledger, wl);
		c.plusHours(0.1);
		entry(ledger, wl, CLASSIFIER_BY, `pair-offer: q-x site round-limit signals e`);
		c.plusHours(0.1);
		exited(ledger, wl, lane1);
		c.plusHours(1);
		started(ledger, wl, lane2);
		c.plusHours(0.1);
		entry(ledger, wl, CLASSIFIER_BY, `pair-exposure: ${lane2} on`);
		c.plusHours(0.5);
		exited(ledger, wl, lane2);
		c.plusHours(0.1);
		const text = report(ledger, 30);
		expect(groupLanes(text, "on")).toBe(2);
		expect(groupLanes(text, "off")).toBe(0);
	});

	test("pairLaneExposure: on by its own classifier pair-exposure: row or a switch row in its span; off otherwise; other lanes' and other stamps never count", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const span = (wl: string, n: number, during: (wl: string, lane: string) => void) => {
			const lane = `lane-${wl.slice(3)}-${n}`;
			started(ledger, wl, lane);
			const start = c.now();
			c.plusHours(0.1);
			during(wl, lane);
			c.plusHours(0.1);
			exited(ledger, wl, lane);
			const end = c.now();
			c.plusHours(0.1);
			return { laneId: lane, start, end };
		};
		const exposure = (wl: string, lane: { laneId: string; start: string; end: string }) => pairLaneExposure(ledger.entries(wl), lane.laneId, lane);

		const onOff = workloadWithSlice(ledger).wl;
		const first = span(onOff, 1, (wl) => entry(ledger, wl, CLASSIFIER_BY, "pair-signal-failed: attempt 1 timeout cost unknown"));
		const second = span(onOff, 2, () => {});
		expect(exposure(onOff, first)).toBe("on");
		expect(exposure(onOff, second)).toBe("off");

		const exposed = workloadWithSlice(ledger).wl;
		const own = span(exposed, 1, (wl, lane) => entry(ledger, wl, CLASSIFIER_BY, `pair-exposure: ${lane} on`));
		const another = span(exposed, 2, (wl) => entry(ledger, wl, CLASSIFIER_BY, `pair-exposure: lane-${wl.slice(3)}-9 on`));
		const forged = span(exposed, 3, (wl, lane) => entry(ledger, wl, LANE, `pair-exposure: ${lane} on`));
		expect(exposure(exposed, own)).toBe("on");
		expect(exposure(exposed, another)).toBe("off");
		expect(exposure(exposed, forged)).toBe("off");

		const never = workloadWithSlice(ledger).wl;
		const offLane = span(never, 1, (wl) => {
			TASTE("0.95", LANE)(ledger, wl);
			entry(ledger, wl, SURFACE_BY, "pair-offer: q-x site round-limit signals b");
		});
		// a switch row after the lane's end is not the lane's
		entry(ledger, never, CLASSIFIER_BY, "pair-offer: q-y site round-limit signals a");
		expect(exposure(never, offLane)).toBe("off");

		const offered = workloadWithSlice(ledger).wl;
		expect(exposure(offered, span(offered, 1, (wl) => entry(ledger, wl, CLASSIFIER_BY, "pair-offer: q-z site round-limit signals a")))).toBe("on");
	});
});

describe("D1: pair is appended per question, never to the option constant", () => {
	test("ROUND_LIMIT_OPTIONS is unchanged", () => {
		expect([...ROUND_LIMIT_OPTIONS]).toEqual(["extend", "accept", "stop"]);
	});
});
