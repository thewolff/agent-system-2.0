// Issue #334 item 2 (Jo, 2026-10-28): the "How it fails" matcher and the row-5 entry points it gates, a hand's dispatch brief
// and a paired lane's change card. The open tool and the plan question are tested in surface/test/how-it-fails-entry.test.ts.
import { describe, expect, test } from "bun:test";
import briefFieldsRow from "../extensions/r05-brief-fields";
import { checkToolCall } from "../src/gates";
import { checkHowItFails, HOW_IT_FAILS_HEADING, HOW_IT_FAILS_NA_LINE, howItFailsLines, howItFailsNote, matchHowItFails } from "../src/how-it-fails";
import { cardTexts, checkBriefFields, checkCard } from "../src/rows/r05-brief-fields";
import { LANE_ENV, WORKLOAD_ENV } from "../src/types";
import { brief as fixtureBrief, HOW_IT_FAILS_FIXTURE, tempLedger } from "./helpers";

const SECTION = "## How it fails\n- the push is refused: surfaces as a non-zero exit; fix and push again, once";

describe("matchHowItFails: one matcher for every entry point", () => {
	test("a heading at any level, any case, with a trailing colon or closing hashes, followed by a non-blank line, is a section", () => {
		for (const h of ["# How it fails", "## how it fails", "###### HOW IT FAILS:", "   ## How it fails ##", "### How It Fails :"]) {
			expect({ h, m: matchHowItFails(`# Plan\n${h}\n\n- errors: x surfaces at y; retry once\n## Next`) }).toEqual({ h, m: { via: "section" } });
		}
	});

	test("no heading, a heading with nothing under it before the next heading, or other heading text, is not a section", () => {
		for (const text of [
			"# Plan\nnothing here",
			"## How it fails\n\n   \n## Slices\n- a",
			"## How it fails",
			"How it fails\n- not a heading",
			"## How it fails, mostly\n- a",
			"#### ####\n## Failures\n- a",
			"    ## How it fails\n- indented four spaces is code, not a heading",
		]) expect({ text, m: matchHowItFails(text) }).toEqual({ text, m: null });
	});

	test("the n/a line counts with its reason, as plain text or as a heading; with no reason it does not", () => {
		expect(matchHowItFails("task: fix a typo\nHow it fails: n/a, one-word docs change")).toEqual({ via: "n/a", reason: "one-word docs change" });
		expect(matchHowItFails("## How it fails: N/A, docs only")).toEqual({ via: "n/a", reason: "docs only" });
		expect(matchHowItFails("How it fails: n/a,")).toBeNull();
		expect(matchHowItFails("How it fails: n/a")).toBeNull();
	});

	test("a real section wins over an n/a line in the same text", () => {
		expect(matchHowItFails(`How it fails: n/a, later\n${SECTION}`)).toEqual({ via: "section" });
	});
});

describe("review of #405: fenced code is never the section, and a section may have child headings", () => {
	test("a heading or n/a line inside a ``` or ~~~ fence is an example, not the section (blocking 2)", () => {
		for (const text of [
			"```md\n## How it fails\n```",
			"~~~\n## How it fails\n- push fails: retry once\n~~~",
			"````md\n## How it fails\n```\n- still inside the four-tick fence\n````",
			"```\nHow it fails: n/a, quoted example\n```",
			"> How it fails: n/a, quoted in a blockquote",
		]) expect({ text, m: matchHowItFails(text) }).toEqual({ text, m: null });
	});

	test("fence delimiters and fenced lines are not a section's content: an empty section followed only by a fenced block is refused (blocking 2)", () => {
		expect(matchHowItFails("## How it fails\n```\n```")).toBeNull();
		expect(matchHowItFails("## How it fails\n```sh\nexit 1\n```\n## Next\n- a")).toBeNull();
		expect(matchHowItFails("## How it fails\n~~~\n~~~")).toBeNull();
	});

	test("a real section may still contain code beside its prose", () => {
		expect(matchHowItFails("## How it fails\n- the push is refused; retry once:\n```sh\ngit push\n```")).toEqual({ via: "section" });
	});

	test("a deeper heading inside the section neither ends it nor counts as content (should-fix 4)", () => {
		expect(matchHowItFails("## How it fails\n### Push fails\nReport stderr; retry once")).toEqual({ via: "section" });
		expect(matchHowItFails("## How it fails\n### Push fails\n### Tests fail\n## Slices\n- a")).toBeNull();
		expect(matchHowItFails("## How it fails\n### Push fails\n# Next part\n- a")).toBeNull();
	});

	test("howItFailsLines returns the whole section, child headings and code included, or the n/a line", () => {
		expect(howItFailsLines("# Plan\n## How it fails\n### Push\n- retry once\n## Slices\n- a")).toBe("## How it fails\n### Push\n- retry once");
		expect(howItFailsLines("task: x\nHow it fails: n/a, docs only\nmore")).toBe("How it fails: n/a, docs only");
		expect(howItFailsLines("no section")).toBeNull();
	});
});

describe("checkHowItFails: the refusal names the section, and a gate error fails closed", () => {
	test("a text without the section is refused, naming the missing section, the expected heading and the n/a line, and saying to resubmit", () => {
		const v = checkHowItFails("# Plan\n- do it", "the brief");
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toContain('the brief has no "How it fails" section');
		expect(v.reason).toContain(HOW_IT_FAILS_HEADING);
		expect(v.reason).toContain(HOW_IT_FAILS_NA_LINE);
		expect(v.reason).toContain("submit again");
	});

	test("a section passes with no note; an n/a pass leaves a note naming its reason and where it passed", () => {
		const s = checkHowItFails(SECTION, "the brief");
		expect(s).toEqual({ ok: true, via: "section" });
		expect(howItFailsNote(s, "brief at open")).toBeNull();
		const na = checkHowItFails("How it fails: n/a, rename only", "the brief");
		expect(howItFailsNote(na, "brief at open")).toBe("how-it-fails: n/a, rename only (brief at open)");
	});

	test("the matcher throwing refuses, naming the error and the bypass line; the bypass line then passes and its note names the error", () => {
		const boom = () => {
			throw new Error("regex exploded");
		};
		const refused = checkHowItFails(SECTION, "the plan file", boom);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.reason).toContain("regex exploded");
		expect(refused.reason).toContain("How it fails: n/a, gate error");
		const bypass = checkHowItFails("How it fails: n/a, gate error regex exploded", "the plan file", boom);
		expect(bypass).toEqual({ ok: true, via: "bypass", error: "regex exploded" });
		expect(howItFailsNote(bypass, "plan file")).toBe("how-it-fails: gate error bypassed (regex exploded) (plan file)");
	});
});

const brief = (extra: string) => `workload: wl-test1\ntask: fix it\ndone-condition: tests green\ninputs: gates/\nstakes: normal\nceiling-share: 10\n${extra}`;

describe("row 5: a hand's dispatch brief carries the section", () => {
	test("a brief with all six fields and no section is refused, naming the item and the section; with it, or with the n/a line, it passes", () => {
		const r = checkBriefFields({ tasks: [{ agent: "fast", name: "sl-a", task: brief("") }] }, "wl-test1");
		expect(r?.reason).toContain(`item 0: item 0's brief has no "How it fails" section`);
		expect(r?.reason).toContain("Fix the brief and dispatch again");
		expect(checkBriefFields({ tasks: [{ agent: "fast", name: "sl-a", task: brief(SECTION) }] }, "wl-test1")).toBeNull();
		expect(checkBriefFields({ tasks: [{ agent: "fast", name: "sl-a", task: brief("How it fails: n/a, read-only look") }] }, "wl-test1")).toBeNull();
	});

	test("the section in the batch context covers every item", () => {
		expect(checkBriefFields({ context: SECTION, tasks: [{ agent: "fast", name: "sl-a", task: brief("") }, { agent: "fast", name: "sl-b", task: brief("") }] }, "wl-test1")).toBeNull();
	});

	test("an empty section at the end of the batch context is not filled by the task's first lines (blocking 1)", () => {
		const r = checkBriefFields({ context: "## How it fails\n\n", tasks: [{ agent: "fast", name: "sl-a", task: brief("") }] }, "wl-test1");
		expect(r?.reason).toContain(`item 0's brief has no "How it fails" section`);
		const flat = checkBriefFields({ agent: "fast", name: "sl-a", context: "## How it fails\n", task: brief("") }, "wl-test1");
		expect(flat?.reason).toContain('"How it fails"');
	});

	test("the composed gate refuses the same dispatch", () => {
		const r = checkToolCall({ toolName: "task", input: { agent: "fast", name: "sl-a", task: brief("") } }, { cwd: "/tmp", role: "lane" } as never);
		expect(r?.reason).toContain('"How it fails"');
	});
});

describe("row 5: a paired lane's change card carries the section", () => {
	const card = (effect: string) => ({ boundary: ["a.ts"], decision: "rename x", effect, checks: ["bun test a.test.ts"] });

	test("the card's texts are its fields in order, one text per field, a list field's items one per line within it", () => {
		expect(cardTexts({ whyNow: "w", checks: ["c1", "c2"], effect: "e", boundary: ["ignored"] })).toEqual(["w", "e", "c1\nc2"]);
	});

	test("an empty section at the end of one field is not filled by the next field (blocking 1)", () => {
		const r = checkCard({ boundary: ["a.ts"], effect: "new\n## How it fails\n\n", checks: ["bun test"] });
		expect(r.refusal?.reason).toContain('this change card has no "How it fails" section');
		expect(checkCard({ boundary: ["a.ts"], effect: "new", checks: ["## How it fails", "- the test fails: rerun once"] }).refusal).toBeNull();
	});

	test("a card with no section is refused with the heading and where to put it; one with it in `effect`, or the n/a line, passes", () => {
		const r = checkCard(card("x is renamed"));
		expect(r.refusal?.reason).toContain('this change card has no "How it fails" section');
		expect(r.refusal?.reason).toContain("end `effect`");
		expect(checkCard(card(`x is renamed\n${SECTION}`)).refusal).toBeNull();
		expect(checkCard(card("x is renamed\nHow it fails: n/a, pure rename")).verdict).toEqual({ ok: true, via: "n/a", reason: "pure rename" });
	});

	test("the composed gate refuses a card only in a session bound to a workload", () => {
		const call = { toolName: "pair_propose", input: card("x is renamed") };
		expect(checkToolCall(call, { cwd: "/tmp", role: "lane" } as never, { workload: { id: "wl-test1", ledger: () => ({}) as never } })?.reason).toContain("pair_propose");
		expect(checkToolCall(call, { cwd: "/tmp", role: "lane" } as never, {})).toBeNull();
	});
});

describe("row 5's extension records an n/a pass on the workload", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	/** Row 5's extension on a lane bound to a fresh workload in a temp ledger; `call` emits one `tool_call` to it. */
	const boundRow = () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "orch", brief: "b", stakes: "normal", mode: "user-driven" });
		let handler: Handler | null = null;
		briefFieldsRow({ on: (name: string, h: Handler) => (name === "tool_call" ? (handler = h) : undefined) } as never, {
			AGENT_SYSTEM_LEDGER_DB: path, [WORKLOAD_ENV]: wl, [LANE_ENV]: "lane-1", HOME: "/nonexistent-home",
		});
		const ctx = { hasUI: true, cwd: "/tmp", sessionManager: { getHeader: () => ({}), getEntries: () => [] } };
		const call = (toolName: string, input: Record<string, unknown>) => handler!({ toolName, input }, ctx) as { block: boolean; reason: string } | undefined;
		const notes = () => ledger.entries(wl, "assumption").map((e) => e.body).filter((b) => b.startsWith("how-it-fails:"));
		return { call, notes, wl };
	};

	test("a paired card on the n/a line passes and its note is recorded; a card with no section is refused and nothing is recorded", () => {
		const { call, notes } = boundRow();
		expect(call("pair_propose", { boundary: ["a"], effect: "rename\nHow it fails: n/a, pure rename" })).toBeUndefined();
		expect(notes()).toEqual(["how-it-fails: n/a, pure rename (pair_propose card)"]);
		expect(call("pair_propose", { boundary: ["a"], effect: "rename" })?.block).toBe(true);
		expect(call("pair_propose", { boundary: ["a"], effect: `rename\n${SECTION}` })).toBeUndefined();
		expect(notes()).toHaveLength(1);
	});

	test("a dispatch on the n/a line passes and each item's note names its slice", () => {
		const { call, notes, wl } = boundRow();
		const task = fixtureBrief({ workload: wl }).replace(HOW_IT_FAILS_FIXTURE, "How it fails: n/a, read-only look");
		expect(call("task", { agent: "fast", name: "sl-look", task })).toBeUndefined();
		expect(notes()).toEqual(["how-it-fails: n/a, read-only look (dispatch brief sl-look)"]);
	});
});
