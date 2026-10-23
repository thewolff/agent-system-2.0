/**
 * Scaled window-pace admission and common-interval budget comparison (approved headroom plan, policies A/B).
 * Tests exercise decisions, including hard guards, tier isolation, old polls and fail-open behavior.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headroom } from "../src/headroom";
import type { Headroom } from "../src/headroom";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;
const WEEK_MIN = 7 * 24 * 60;
const OPUS = "anthropic/claude-opus-5-5";
const FABLE = "anthropic/claude-fable-5-1";
const SOL = "openai-codex/gpt-6.1-sol";
const KIMI = "moonshot/kimi-k2.7-code";

interface Lim {
	provider: string;
	windowId: string;
	tier: string | null;
	resetsAt: number | null;
	usedFraction: number;
}
/** `resetsAt` is epoch ms; resetInMin is relative to NOW, not the poll timestamp. */
const lim = (provider: string, windowId: string, usedFraction: number, resetInMin: number, tier: string | null = null): Lim => ({
	provider,
	windowId,
	tier,
	resetsAt: NOW + resetInMin * MIN,
	usedFraction,
});
const poll = (minAgo: number, limits: Lim[]) => JSON.stringify({ t: (NOW - minAgo * MIN) / 1000, rows: {}, limits });
const oldPoll = (minAgo: number, rows: Record<string, number>) => JSON.stringify({ t: (NOW - minAgo * MIN) / 1000, rows });
const at = (lines: string[], now = NOW) => headroom({ lines, now });
const week = (used: number, provider = "openai-codex", windowId = "7d") => lim(provider, windowId, used, WEEK_MIN - 2016);
const claude = (used: number) => lim("anthropic", "5h", used, 200);
const comparison = (older: Lim[], newer: Lim[], span = 26, newestAgo = 0) => at([poll(newestAgo + span, older), poll(newestAgo, newer)]);
const mature = (before = 0.04, after = 0.18) => comparison([week(0.20), claude(before)], [week(0.21), claude(after)]);
const expectRefused = (room: Headroom, comparators: readonly string[] = [OPUS], selector = SOL) => {
	const base = room.decisionFor(selector);
	expect(base.out).not.toBeNull();
	expect(base.retained).toBeNull();
	expect(room.decisionFor(selector, comparators)).toEqual(base);
};

describe("projected at reset, by the window's pace", () => {
	test("half a 7d window gone at .50 projects exactly 1.00; below is in and above is out", () => {
		expect(at([poll(0, [lim("anthropic", "7d", 0.5, WEEK_MIN / 2)])]).decisionFor(OPUS).out).toBe(
			"anthropic 7d 0.50 used, window pace +0.6 pts/h, projected 1.00 at reset 2026-10-18T00:00Z",
		);
		expect(at([poll(0, [lim("anthropic", "7d", 0.4995, WEEK_MIN / 2)])]).decisionFor(OPUS)).toEqual({ out: null, retained: null });
		expect(at([poll(0, [lim("anthropic", "7d", 0.5005, WEEK_MIN / 2)])]).decisionFor(OPUS).out).not.toBeNull();
	});

	test("a steep recent rise under the window's pace stays in without an exceptional diagnostic", () => {
		const h = at([poll(60, [lim("anthropic", "7d", 0.4, 60.7 * 60)]), poll(0, [lim("anthropic", "7d", 0.43, 60.7 * 60)])]);
		expect(h.decisionFor(OPUS, [SOL])).toEqual({ out: null, retained: null });
	});

	test("live figures: anthropic .43 with 60.7h left is in; openai .56 with 124.7h left is out", () => {
		const h = at([poll(0, [lim("anthropic", "7d", 0.43, 60.7 * 60), lim("openai-codex", "7d", 0.56, 124.7 * 60)])]);
		expect(h.decisionFor(OPUS).out).toBeNull();
		expect(h.decisionFor(SOL).out).toMatch(/^openai-codex 7d 0\.56 used, window pace \+1\.3 pts\/h, projected 2\.17 at reset /);
	});

	for (const elapsed of [60, 61]) {
		test(`early-week .06 at ${elapsed}min does not project`, () => {
			expect(at([poll(0, [lim("openai-codex", "7d", 0.06, WEEK_MIN - elapsed)])]).decisionFor(SOL)).toEqual({ out: null, retained: null });
		});
	}

	for (const windowId of ["7d", "1w"]) {
		test(`${windowId} warm-up is inclusive at 2016min, not 2015min`, () => {
			expect(at([poll(0, [lim("openai-codex", windowId, 0.21, WEEK_MIN - 2015)])]).decisionFor(SOL).out).toBeNull();
			for (const elapsed of [2016, 2017]) {
				expect(at([poll(0, [lim("openai-codex", windowId, 0.21, WEEK_MIN - elapsed)])]).decisionFor(SOL).out).toContain("projected 1.05");
			}
		});
	}

	for (const windowId of ["7d", "1w"]) {
		for (const elapsed of [59, 60, 2015, 2016]) {
			for (const used of [1, 1.01]) {
				test(`${windowId} actual exhaustion at ${used} refuses at ${elapsed}min without a comparison exception`, () => {
					const source = lim("openai-codex", windowId, used, WEEK_MIN - elapsed);
					const h = comparison([{ ...source, usedFraction: 0.99 }, claude(0.04)], [source, claude(0.87)]);
					expectRefused(h);
					expect(h.decisionFor(SOL).out).toContain(`openai-codex ${windowId}`);
					if (elapsed === 2016) expect(h.decisionFor(SOL).out).toContain("projected");
				});
			}
		}
		for (const elapsed of [59, 60, 2015]) {
			test(`${windowId} .999 remains ordinarily admitted before warm-up at ${elapsed}min`, () => {
				const source = lim("openai-codex", windowId, 0.999, WEEK_MIN - elapsed);
				const h = comparison([{ ...source, usedFraction: 0.99 }, claude(0.04)], [source, claude(0.87)]);
				expect(h.decisionFor(SOL)).toEqual({ out: null, retained: null });
				expect(h.decisionFor(SOL, [OPUS])).toEqual({ out: null, retained: null });
			});
		}
	}

	test("actual week exhaustion preserves the first existing ordinary refusal regardless of limit order", () => {
		const exhausted = lim("openai-codex", "7d", 1, WEEK_MIN - 59);
		const hard = lim("openai-codex", "5h", 0.87, 290);
		const paced = lim("openai-codex", "2d", 0.6, 1440);
		const ordinary = at([poll(0, [hard, paced])]).decisionFor(SOL);
		for (const limits of [[exhausted, hard, paced], [hard, exhausted, paced], [hard, paced, exhausted]]) {
			const h = comparison([claude(0.04)], [...limits, claude(0.87)]);
			expect(h.decisionFor(SOL)).toEqual(ordinary);
			expectRefused(h);
		}
		const h = comparison([week(0.20), claude(0.04)], [exhausted, week(0.21), claude(0.87)]);
		expect(h.decisionFor(SOL)).toEqual(at([poll(0, [week(0.21)])]).decisionFor(SOL));
		expectRefused(h);
	});

	test("exhaustion leaves unknown, no-reset, expired and old-format week compatibility paths unchanged", () => {
		for (const used of [1, 1.01]) {
			const limits = [
				lim("openai-codex", "monthly", used, 60),
				lim("openai-codex", "2d", used, 2880 - 59),
				...["7d", "1w"].flatMap(windowId => [null, NOW, NOW - 1].map(resetsAt => ({
					...lim("openai-codex", windowId, used, 60), resetsAt,
				}))),
			];
			const h = comparison([claude(0.04)], [...limits, claude(0.87)]);
			expect(h.decisionFor(SOL)).toEqual({ out: null, retained: null });
			expect(h.decisionFor(SOL, [OPUS])).toEqual({ out: null, retained: null });
			expect(at([oldPoll(0, { "openai-codex/7d/chat": used, "openai-codex/1w/chat": used })]).decisionFor(SOL)).toEqual({ out: null, retained: null });
		}
	});

	test("5h warm-up remains inclusive at 60min, not 59min", () => {
		expect(at([poll(0, [lim("anthropic", "5h", 0.21, 241)])]).decisionFor(OPUS).out).toBeNull();
		for (const resetIn of [240, 239]) {
			expect(at([poll(0, [lim("anthropic", "5h", 0.21, resetIn)])]).decisionFor(OPUS).out).not.toBeNull();
		}
	});

	test("other window lengths scale too: 10h starts projecting at 120min", () => {
		expect(at([poll(0, [lim("anthropic", "10h", 0.21, 481)])]).decisionFor(OPUS).out).toBeNull();
		expect(at([poll(0, [lim("anthropic", "10h", 0.21, 480)])]).decisionFor(OPUS).out).toContain("projected 1.05");
	});

	test("unknown length and passed reset retain their fail-open semantics", () => {
		expect(at([poll(0, [lim("anthropic", "monthly", 0.99, 60)])]).decisionFor(OPUS).out).toBeNull();
		for (const resetIn of [-1, 0]) {
			expect(at([poll(0, [lim("anthropic", "7d", 1, resetIn)])]).decisionFor(OPUS).out).toBeNull();
		}
	});
});

describe("the 5h 80% rule (strict)", () => {
	test(".80 is in and .81 is out even before warm-up", () => {
		expect(at([poll(0, [lim("anthropic", "5h", 0.8, 290)])]).decisionFor(OPUS).out).toBeNull();
		expect(at([poll(0, [lim("anthropic", "5h", 0.81, 290)])]).decisionFor(OPUS).out).toBe("anthropic 5h 0.81 used > 0.80");
	});

	test("it applies to every provider, not to a week at .85 near reset", () => {
		expect(at([poll(0, [lim("openai-codex", "5h", 0.85, 290)])]).decisionFor(SOL).out).toBe("openai-codex 5h 0.85 used > 0.80");
		expect(at([poll(0, [lim("openai-codex", "7d", 0.85, 60)])]).decisionFor(SOL).out).toBeNull();
	});
});

describe("mature week-only comparison", () => {
	test(".20 to .21 over 26min at elapsed 2016min retains against .04 to .18, with measured explanation", () => {
		const h = mature();
		expect(h.decisionFor(SOL).out).toContain("projected 1.05");
		const decision = h.decisionFor(SOL, [OPUS]);
		expect(decision.out).toBeNull();
		expect(decision.retained).toContain("retained");
		expect(decision.retained).toContain(h.decisionFor(SOL).out!);
		expect(decision.retained).toContain(OPUS);
		expect(decision.retained).toContain("2.31 pts/h");
		expect(decision.retained).toContain("32.31 pts/h");
		expect(decision.retained).toContain("26 min");
		expect(h.decisionFor(SOL, [])).toEqual(h.decisionFor(SOL));
	});

	test("equivalent 1w pace refusals are eligible", () => {
		const h = comparison([week(0.20, "openai-codex", "1w"), claude(0.04)], [week(0.21, "openai-codex", "1w"), claude(0.18)]);
		expect(h.decisionFor(SOL, [OPUS]).retained).toContain("openai-codex 1w");
	});

	for (const after of [0.34, 0.87, 1]) {
		test(`a quota-out comparator at ${after} still protects only the soft-week source`, () => {
			const h = mature(0.04, after);
			expect(h.decisionFor(OPUS).out).not.toBeNull();
			expect(h.decisionFor(SOL, [OPUS]).retained).not.toBeNull();
			expectRefused(h, [SOL], OPUS);
		});
	}

	for (const [before, after] of [[0.04, 0.045], [0.04, 0.05], [0.17, 0.18], [0.04, 0.04]]) {
		test(`slower/tied comparator ${before} to ${after} cannot relax`, () => expectRefused(mature(before, after)));
	}

	test("strictly faster, even by less than a rounding unit, is not treated as a tie", () => {
		expect(mature(0.04, 0.05000000000001).decisionFor(SOL, [OPUS]).retained).not.toBeNull();
	});

	test("a real zero source delta is known; absent source evidence is not invented zero", () => {
		const flat = comparison([week(0.21), claude(0.04)], [week(0.21), claude(0.18)]);
		expect(flat.decisionFor(SOL, [OPUS]).retained).toContain("0.00 pts/h");
		expectRefused(comparison([claude(0.04)], [week(0.21), claude(0.18)]));
	});

	test("zero versus zero stays refused, while scientific-notation positive evidence is strictly faster", () => {
		const source = [week(0.21)];
		expectRefused(comparison([...source, claude(0)], [...source, claude(0)]));
		expect(comparison([...source, claude(1e-7)], [...source, claude(2e-7)]).decisionFor(SOL, [OPUS]).retained).not.toBeNull();
	});

	test("unknown source lab cannot receive the exception", () => {
		const h = comparison([week(0.20, "zai"), claude(0.04)], [week(0.21, "zai"), claude(0.18)]);
		expectRefused(h, [OPUS], "zai/glm-5");
	});

	test("only configured comparators count, not fast providers that appear solely in polls", () => {
		expectRefused(mature(), []);
		expectRefused(mature(), [KIMI]);
	});

	test("unknown identities and source-lab aliases are skipped, preserving configured order", () => {
		expect(mature().decisionFor(SOL, ["unknown/model", "openai/gpt-6", `${SOL}:high`, OPUS]).retained).toContain(OPUS);
		expectRefused(mature(), ["unknown/model", "openai/gpt-6"]);
	});

	test("first other lab's unknown or slower pressure blocks choosing a later faster lab", () => {
		const h = comparison([week(0.20), claude(0.04), lim("moonshot", "5h", 0.1, 200)], [week(0.21), claude(0.18), lim("moonshot", "5h", 0.1, 200)]);
		expectRefused(h, [KIMI, OPUS]);
		expect(h.decisionFor(SOL, [OPUS, KIMI]).retained).toContain(OPUS);
		expectRefused(h, ["kimi-code/kimi-k2.7", KIMI, OPUS]);
	});

	test("first configured occurrence of a lab wins even if its alias has no meter", () => {
		const h = comparison([week(0.20), claude(0.04), lim("moonshot", "5h", 0.04, 200)], [week(0.21), claude(0.18), lim("moonshot", "5h", 0.18, 200)]);
		expectRefused(h, ["kimi-code/kimi-k2.7", KIMI, OPUS]);
		expect(h.decisionFor(SOL, [KIMI, "kimi-code/kimi-k2.7", OPUS]).retained).toContain(KIMI);
	});
});

describe("all source limits and binding-meter pressure", () => {
	for (const hardFirst of [true, false]) {
		for (const hard of [lim("openai-codex", "5h", 0.87, 290), lim("openai-codex", "5h", 0.34, 200), lim("openai-codex", "2d", 0.6, 1440)]) {
			test(`mixed ${hard.windowId} refusal ${hardFirst ? "before" : "after"} week refusal stays hard`, () => {
				const newer = hardFirst ? [hard, week(0.21), claude(0.87)] : [week(0.21), hard, claude(0.87)];
				expectRefused(comparison([week(0.20), claude(0.04)], newer));
			});
		}
	}

	test("actual week exhaustion cannot be waived", () => {
		expectRefused(comparison([week(0.99), claude(0.04)], [week(1), claude(0.87)]));
	});

	test("all refusing week meters must be unexhausted", () => {
		const h = comparison([week(0.20), claude(0.04)], [week(0.21), { ...week(1), tier: "sol" }, claude(0.87)]);
		expectRefused(h);
	});

	for (const after of [0.24, 0.25]) {
		test(`non-refusing source 5h .10 to ${after} is included in maximum pressure`, () => {
			const h = comparison([week(0.20), lim("openai-codex", "5h", 0.10, 20), claude(0.04)], [week(0.21), lim("openai-codex", "5h", after, 20), claude(0.18)]);
			expect(h.decisionFor(SOL).out).toContain("7d");
			expectRefused(h);
		});
	}

	test("maximum comparator pressure includes shared 5h surge, not only week", () => {
		const h = comparison([week(0.20), claude(0.04), week(0.4, "anthropic")], [week(0.21), claude(0.18), week(0.4, "anthropic")]);
		expect(h.decisionFor(SOL, [OPUS]).retained).toContain("32.31 pts/h");
	});

	test("Fable-only surge cannot stand in for Opus pressure", () => {
		const h = comparison([week(0.20), claude(0.04), { ...claude(0.04), tier: "fable" }], [week(0.21), claude(0.04), { ...claude(0.87), tier: "fable" }]);
		expectRefused(h, [OPUS, FABLE]);
		expect(h.decisionFor(SOL, [FABLE]).retained).toContain(FABLE);
	});

	test("source's unrelated tier surge does not inflate its pressure", () => {
		const h = comparison([week(0.20), { ...lim("openai-codex", "5h", 0.04, 200), tier: "other" }, claude(0.04)], [week(0.21), { ...lim("openai-codex", "5h", 0.87, 200), tier: "other" }, claude(0.18)]);
		expect(h.decisionFor(SOL, [OPUS]).retained).not.toBeNull();
	});

	test("a missing week rate may use a known binding 5h rate, but never invent missing-meter pressure", () => {
		const h = comparison([lim("openai-codex", "5h", 0.1, 20), claude(0.04)], [week(0.21), lim("openai-codex", "5h", 0.1, 20), claude(0.18)]);
		expect(h.decisionFor(SOL, [OPUS]).retained).toContain("0.00 pts/h");
	});
});

describe("common sample interval and rate evidence", () => {
	for (const span of [15, 60]) {
		test(`inclusive ${span}min sample is accepted`, () => {
			expect(comparison([week(0.20), claude(0.04)], [week(0.21), claude(0.18)], span).decisionFor(SOL, [OPUS]).retained).toContain(`${span} min`);
		});
	}
	for (const span of [14.99, 60.01]) {
		test(`${span}min sample is outside the allowed horizon`, () => expectRefused(comparison([week(0.20), claude(0.04)], [week(0.21), claude(0.18)], span)));
	}

	test("oldest qualifying endpoint wins regardless of line order; newer favorable intervals are not substituted", () => {
		const h = at([poll(26, [week(0.20), claude(0.04)]), poll(0, [week(0.21), claude(0.18)]), poll(60, [week(0.20), claude(0.18)]), poll(61, [week(0.20), claude(0)])]);
		expectRefused(h);
	});

	test("both budgets use the same pair even when a newer comparator reading is available", () => {
		const h = at([poll(60, [week(0.20)]), poll(26, [week(0.20), claude(0.04)]), poll(0, [week(0.21), claude(0.18)])]);
		expectRefused(h);
	});

	test("horizon is anchored to newest poll, not wall-clock age", () => {
		const h = comparison([week(0.20), claude(0.04)], [week(0.21), claude(0.18)], 60, 15);
		expect(h.decisionFor(SOL, [OPUS]).retained).toContain("60 min");
	});

	test("future newest poll keeps base refusal but cannot supply comparison evidence", () => {
		expectRefused(comparison([week(0.20), claude(0.04)], [week(0.21), claude(0.18)], 26, -1));
	});

	test("stale polls fail open without claiming an exceptional retention", () => {
		const h = comparison([week(0.20), claude(0.04)], [week(0.21), claude(0.18)], 26, 16);
		expect(h.decisionFor(SOL, [OPUS])).toEqual({ out: null, retained: null });
		expect(h.note).toContain("stale");
	});

	for (const jitter of [-60_000, -0.5, 0.5, 60_000]) {
		test(`reset jitter ${jitter}ms is accepted`, () => {
			const previous = { ...claude(0.04), resetsAt: claude(0.04).resetsAt! + jitter };
			expect(comparison([week(0.20), previous], [week(0.21), claude(0.18)]).decisionFor(SOL, [OPUS]).retained).not.toBeNull();
		});
	}
	for (const jitter of [-60_001, 60_001]) {
		test(`reset jump ${jitter}ms is not a rate`, () => {
			expectRefused(comparison([week(0.20), { ...claude(0.04), resetsAt: claude(0.04).resetsAt! + jitter }], [week(0.21), claude(0.18)]));
		});
	}

	for (const endpoint of ["older", "newer"]) {
		for (const resetsAt of [null, NOW, NOW - 1, Number.NaN, Number.POSITIVE_INFINITY]) {
			test(`${endpoint} missing/expired/nonfinite reset ${resetsAt} gives no comparator rate`, () => {
				const older = endpoint === "older" ? { ...claude(0.04), resetsAt } : claude(0.04);
				const newer = endpoint === "newer" ? { ...claude(0.18), resetsAt } : claude(0.18);
				expectRefused(comparison([week(0.20), older], [week(0.21), newer]));
			});
		}
	}

	test("either expired reset invalidates a pair even when the other is future and within tolerance", () => {
		for (const [olderReset, newerReset] of [[NOW, NOW + 30_000], [NOW + 30_000, NOW]]) {
			expectRefused(comparison([week(0.20), { ...claude(0.04), resetsAt: olderReset! }], [week(0.21), { ...claude(0.18), resetsAt: newerReset! }]));
		}
	});

	for (const [before, after] of [[0.19, 0.18], [-0.1, 0.18], [0.04, 1.1], [Number.NaN, 0.18], [0.04, Number.POSITIVE_INFINITY]]) {
		test(`decreasing/invalid usage ${before} to ${after} is unknown, not zero`, () => expectRefused(mature(before, after)));
	}

	test("source decrease, reset jump, invalid or missing earlier usage cannot establish its pressure", () => {
		for (const older of [week(0.22), { ...week(0.20), resetsAt: week(0.20).resetsAt! + 60_001 }, { ...week(0.20), resetsAt: null }, week(-0.1), week(Number.NaN)]) {
			expectRefused(comparison([older, claude(0.04)], [week(0.21), claude(0.18)]));
		}
	});

	test("a mismatched meter identity is not paired across provider/window/tier", () => {
		for (const older of [lim("anthropic", "7d", 0.04, 200), { ...claude(0.04), tier: "fable" }, lim("moonshot", "5h", 0.04, 200)]) {
			expectRefused(comparison([week(0.20), older], [week(0.21), claude(0.18)]));
		}
	});

	test("single polls and old-format rows cannot invent a comparison", () => {
		expectRefused(at([poll(0, [week(0.21), claude(0.18)])]));
		expectRefused(at([oldPoll(26, { "openai-codex/7d/chat": 0.20, "anthropic/5h": 0.04 }), poll(0, [week(0.21), claude(0.18)])]));
	});
});

describe("tier binding and selector syntax", () => {
	const lines = [poll(0, [lim("anthropic", "5h", 0.19, 120), lim("anthropic", "7d", 0.41, 3 * 24 * 60), lim("anthropic", "7d", 0.99, 3 * 24 * 60, "fable")])];
	test("Fable's meter takes Fable out, not Opus; :level and whitespace do not change binding", () => {
		const h = at(lines);
		expect(h.decisionFor(FABLE).out).toMatch(/^anthropic 7d fable 0\.99 used, window pace \+1\.0 pts\/h, projected 1\.73 at reset /);
		expect(h.decisionFor(` ${FABLE}:high `)).toEqual(h.decisionFor(FABLE));
		expect(h.decisionFor(`${OPUS}:xhigh`)).toEqual({ out: null, retained: null });
		expect(h.decisionFor("anthropic")).toEqual({ out: null, retained: null });
	});
	test("a provider with no limits is in", () => {
		expect(at(lines).decisionFor(`${KIMI}:high`)).toEqual({ out: null, retained: null });
	});
});

describe("old poll lines (no limits)", () => {
	test("rows have no reset, so only 5h ceiling applies; chat is shared and other segments are tiers", () => {
		const h = at([oldPoll(0, { "anthropic/5h": 0.85, "anthropic/7d/fable": 0.99, "openai-codex/7d/chat": 0.99 })]);
		expect(h.note).toBeNull();
		expect(h.decisionFor(OPUS).out).toBe("anthropic 5h 0.85 used > 0.80 (no reset time)");
		expect(h.decisionFor(SOL).out).toBeNull();
		expect(at([oldPoll(0, { "openai-codex/5h/chat": 0.9 })]).decisionFor(SOL).out).toBe("openai-codex 5h 0.90 used > 0.80 (no reset time)");
		const tier = at([oldPoll(0, { "anthropic/5h/fable": 0.9 })]);
		expect(tier.decisionFor(FABLE).out).toBe("anthropic 5h fable 0.90 used > 0.80 (no reset time)");
		expect(tier.decisionFor(OPUS).out).toBeNull();
	});
	test("only newest limits determine base refusal", () => {
		const h = at([oldPoll(60, { "openai-codex/5h/chat": 0.99 }), poll(0, [lim("openai-codex", "7d", 0.5, 60)])]);
		expect(h.decisionFor(SOL)).toEqual({ out: null, retained: null });
	});
});

describe("a real-shaped poll: t in seconds, resetsAt in ms", () => {
	test("all limits under their window pace are in", () => {
		const t = 1792021768.179596;
		const line = (tSec: number, a5: number, a7: number, fable: number, oc: number) => JSON.stringify({
			t: tSec,
			rows: { "openai-codex/7d/chat": oc, "anthropic/5h": a5, "anthropic/7d": a7, "anthropic/7d/fable": fable },
			limits: [
				{ provider: "anthropic", windowId: "5h", tier: null, resetsAt: 1792030800000, usedFraction: a5 },
				{ provider: "anthropic", windowId: "7d", tier: null, resetsAt: 1792303200000, usedFraction: a7 },
				{ provider: "anthropic", windowId: "7d", tier: "fable", resetsAt: 1792303200000, usedFraction: fable },
				{ provider: "openai-codex", windowId: "7d", tier: null, resetsAt: 1792389600000, usedFraction: oc },
			],
		});
		const h = headroom({ lines: [line(t - 3600.4, 0.17, 0.405, 0.03, 0.298), line(t, 0.19, 0.41, 0.03, 0.3)], now: Math.round(t * 1000) + 2 * MIN });
		expect(h.note).toBeNull();
		for (const selector of [OPUS, FABLE, SOL, "zai/glm-5", KIMI]) expect(h.decisionFor(selector).out).toBeNull();
	});
});

describe("fail-open and file read", () => {
	const dir = mkdtempSync(join(tmpdir(), "as2-headroom-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	test("stale is strictly older than 15min", () => {
		const h = at([poll(16, [lim("anthropic", "5h", 0.99, 120)])]);
		expect(h.decisionFor(OPUS)).toEqual({ out: null, retained: null });
		expect(h.note).toBe("headroom polls stale: newest 16 min old in inline lines");
		expect(at([poll(15, [lim("anthropic", "5h", 0.99, 120)])]).note).toBeNull();
	});
	test("malformed lines are skipped; no good line reads as empty", () => {
		const junk = ["not json", "{}", '{"t":"x","rows":{}}', "[1,2]", '{"t":1}', ""];
		expect(at(junk).note).toBe("headroom polls empty: inline lines");
		expect(at([...junk, poll(0, [lim("anthropic", "5h", 0.85, 290)])]).decisionFor(OPUS).out).toBe("anthropic 5h 0.85 used > 0.80");
	});
	test("missing file through env override is fail-open, with path in note", () => {
		const missing = join(dir, "missing.jsonl");
		const prev = process.env.AS2_HEADROOM_POLLS;
		process.env.AS2_HEADROOM_POLLS = missing;
		try {
			const h = headroom({ now: NOW });
			expect(h.decisionFor(OPUS)).toEqual({ out: null, retained: null });
			expect(h.note).toBe(`headroom polls unreadable: ${missing} (ENOENT)`);
		} finally {
			if (prev === undefined) delete process.env.AS2_HEADROOM_POLLS;
			else process.env.AS2_HEADROOM_POLLS = prev;
		}
	});
	test("opts.path is read once per call", () => {
		const path = join(dir, "polls.jsonl");
		writeFileSync(path, `${poll(0, [lim("anthropic", "5h", 0.85, 290)])}\n`);
		const h = headroom({ path, now: NOW });
		writeFileSync(path, `${poll(0, [lim("anthropic", "5h", 0.1, 290)])}\n`);
		expect(h.decisionFor(OPUS).out).toBe("anthropic 5h 0.85 used > 0.80");
		expect(headroom({ path, now: NOW }).decisionFor(OPUS).out).toBeNull();
	});
});
