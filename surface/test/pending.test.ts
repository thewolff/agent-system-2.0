// `pending` (PLAN wl-mv5msri070p0qo D1; PLAN wl-mv7gidggnlkem8 readable rows): the items and the
// block, from ledger state alone. Every counted entry names its work, asks its question in the
// author's (or the machine's fixed) words, states its default and why, and ends on its exact
// command; a reserved request shows its exact request; a gap in the descriptions is named on its
// own row and loses nothing; nothing a caller wrote can hide or reorder text; prompt waits are
// uncounted entries with no command; the count, the order and the plan path lines are unchanged.
import { describe, expect, test } from "bun:test";
import { reviewParkBody } from "../../classifier/src/lab";
import { reviewLimitBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, type Ledger } from "../../ledger/src/index";
import { CEILING_OPTIONS } from "../src/ceiling";
import { ensureStandingWorkload } from "../src/identity";
import { doneBody, planFirstBody } from "../src/launch";
import { raiseOrchestratorQuestion } from "../src/orchestrator-question";
import { PENDING_EMPTY, pendingBlock, pendingItems, pendingShaped, pendingWaits } from "../src/pending";
import { pairOfferBody, pairOfferStamp } from "../src/pair-suggest";
import { openPromptWaits, promptWaitBody } from "../src/signals";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { askQuestion, clock, nameWork, raiseAsked, tempLedger } from "./helpers";

const planBody = (verdict: string) => ["/tmp/plan.md", "- sl-1: the one slice", "tradeoff: one line", `review: ${verdict}, openai-codex/gpt-6-sol, /tmp/PLAN-REVIEW-r1.md`].join("\n");
const metadata = (field: "name" | "ask", id: string) => `# Metadata: missing ${field} for ${id}; pending descriptions need initialization`;

/** An open workload opened by the surface, held by `lane`, and one slice of it; named when `name` is given. */
function held(ledger: Ledger, lane: string, brief: string, name: string | null): { wl: string; sl: string } {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
	if (name !== null) nameWork(ledger, wl, SURFACE_BY, name);
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the work is done") });
	expect(ledger.claimWorkload(wl, { by: lane, holder: lane, leaseMs: 3_600_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: lane, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	return { wl, sl };
}

/** A plan-first workload whose plan slice raised the plan question as lane_raise_question writes it, with `ask` stored when given. */
function planQuestion(ledger: Ledger, body: string, o: { name?: string; options?: string[]; ask?: string } = {}): { wl: string; q: string } {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Plan the pending word", stakes: "normal", mode: "autonomous" });
	if (o.name !== undefined) nameWork(ledger, wl, SURFACE_BY, o.name);
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	expect(ledger.claimWorkload(wl, { by: "lane-p", holder: "lane-p", leaseMs: 3_600_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: "lane-p", workloadId: wl, task: "plan", doneCondition: "plan approved", inputs: "brief" });
	const q = ledger.write(() => {
		const id = ledger.raiseQuestion({ by: "lane-p", workloadId: wl, sliceId: sl, body, options: o.options ?? ["approve", "revise", "cancel"] });
		ledger.recordEntry({ by: "lane-p", workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${id}` });
		if (o.ask !== undefined) askQuestion(ledger, id, "lane-p", o.ask);
		return id;
	});
	return { wl, q };
}

/** The runner's ceiling question: its own `sl-ceiling-<n>` slice, raised by the lane runner. */
function ceilingQuestion(ledger: Ledger, wl: string, body: string): string {
	const sl = ledger.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: `sl-ceiling-${wl.slice(3)}-1`, task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
	return ledger.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl, body, options: [...CEILING_OPTIONS] });
}

/** A fixed, fully described ledger: a reserved request, two lane questions, the ceiling question, the plan question, and an orchestrator question about the first workload. */
function fixture() {
	const c = clock();
	const { ledger } = tempLedger(c.now);
	const a = held(ledger, "lane-a", "Fix the feed header offset\nin newdle-web", "Feed header offset");
	c.plusHours(0.1);
	const en = ledger.recordEntry({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, kind: "reserved-request", body: "push: git push origin main (P-11 row 6 refused tool call c1)" });
	c.plusHours(0.1);
	const qPlain = raiseAsked(ledger, { by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Which token name?\nleft keeps the old one", options: ["left", "right"], ask: "Which token name should replace the header offset?" });
	c.plusHours(0.1);
	const qMarked = raiseAsked(ledger, { by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Keep the `legacy` alias? `keep` (recommended), or drop it", options: ["drop", "keep"], ask: "Should the legacy alias stay?" });
	c.plusHours(0.1);
	const qCeiling = ceilingQuestion(ledger, a.wl, "Spend reached 80 % of the ceiling.\nstop (the default): the lane is stopped at the ceiling.");
	c.plusHours(1);
	const p = planQuestion(ledger, planBody("approve-with-changes"), { name: "Pending row display" });
	c.plusHours(1);
	ensureStandingWorkload(ledger);
	const qOrch = raiseOrchestratorQuestion(ledger, { body: "Merge #12 now or wait for the smoke run?", options: ["merge", "wait"], about: a.wl, ask: "Should #12 merge now or wait for the smoke run?" });
	return { c, ledger, a, en, qPlain, qMarked, qCeiling, p, qOrch };
}

/** The block's lines between its ```text fence and the fence's close. */
const fence = (text: string): string[] => {
	const lines = text.split("\n");
	const open = lines.indexOf("```text");
	return open < 0 ? [] : lines.slice(open + 1, lines.indexOf("```", open + 1));
};
/** The block's entries: its fence split on the blank lines between them. */
const entries = (text: string): string[][] => fence(text).join("\n").split("\n\n").map((e) => e.split("\n"));
/** The entry whose command (or any line) names `id`. */
const entryOf = (text: string, id: string): string[] => entries(text).find((e) => e.some((l) => l.split(" ").includes(id)))!;
/** What each line of an entry is, in order: its `# <Field>` name, `plan` for a plan path line, else `command`. Pins the order of an entry's parts, not their wording. */
const shape = (entry: string[]): string[] => entry.map((l) => /^# (\w+): /.exec(l)?.[1] ?? (l.startsWith("  plan for q-") ? "plan" : "command"));
/** The value of the entry's `# <name>:` line, or undefined. */
const field = (entry: string[], name: string): string | undefined => entry.find((l) => l.startsWith(`# ${name}: `))?.slice(name.length + 4);
/** The entry's `# Default:` line read back: the default option, why (its parenthesis), and the other options in order. */
function defaults(entry: string[]): { option: string; why: string; alternatives: string[] } {
	const m = /^(.+?) \(([^)]*)\)(?:; alternatives: ([^;]*))?/.exec(field(entry, "Default")!);
	if (!m) throw new Error(`no default option in ${JSON.stringify(entry)}`);
	return { option: m[1]!, why: m[2]!, alternatives: m[3] === undefined ? [] : m[3].split(" / ") };
}

describe("pending: the block (PLAN wl-mv7gidggnlkem8)", () => {
	test("the empty case, with or without the standing workload", () => {
		const { ledger } = tempLedger();
		expect(pendingBlock(pendingItems(ledger))).toEqual({ text: PENDING_EMPTY, count: 0 });
		ensureStandingWorkload(ledger);
		expect(pendingBlock(pendingItems(ledger), pendingWaits(ledger))).toEqual({ text: PENDING_EMPTY, count: 0 });
	});

	test("one fenced entry per row, in the rows' order: its work, its question, its default and why, then its exact command", () => {
		const { ledger, en, qPlain, qMarked, qCeiling, p, qOrch } = fixture();
		const { text, count } = pendingBlock(pendingItems(ledger), pendingWaits(ledger));
		expect(count).toBe(6);
		const lines = text.split("\n");
		// the heading carries the count and names /copy; one ```text fence holds every entry
		expect(lines[0]).toStartWith("## pending: 6 things wait on you (");
		expect(lines[0]).toContain("/copy");
		expect([lines[1], lines.at(-1)]).toEqual(["```text", "```"]);
		const all = entries(text);
		// each entry ends on its exact command, the plan question's path line the one line after it
		expect(all.map(shape)).toEqual([
			["Work", "Question", "Request", "Default", "command"],
			["Work", "Question", "Default", "command"],
			["Work", "Question", "Default", "command"],
			["Work", "Question", "Context", "Default", "command"],
			["Work", "Question", "Default", "command", "plan"],
			["Work", "Question", "Default", "command"],
		]);
		expect(all.map((e) => e.filter((l) => !l.startsWith("  plan for ")).at(-1))).toEqual([`approve ${en}`, `left ${qPlain}`, `keep ${qMarked}`, `stop ${qCeiling}`, `approve ${p.q}`, `merge ${qOrch}`]);
		expect(all[4]!.at(-1)).toBe(`  plan for ${p.q}: /tmp/plan.md`);
		// the work is the authored name (an orchestrator question's, its subject's); an authored ask is shown as written
		expect(all.map((e) => field(e, "Work"))).toEqual(["Feed header offset", "Feed header offset", "Feed header offset", "Feed header offset", "Pending row display", "Feed header offset"]);
		expect([all[1], all[2], all[5]].map((e) => field(e!, "Question"))).toEqual([
			"Which token name should replace the header offset?",
			"Should the legacy alias stay?",
			"Should #12 merge now or wait for the smoke run?",
		]);
		expect(field(all[0]!, "Request")).toBe("push: git push origin main (P-11 row 6 refused tool call c1)");
		// the default is the recorded recommendation, else the first option, and says which; the other options follow in order
		expect(all.map((e) => [defaults(e).option, defaults(e).alternatives])).toEqual([
			["approve", ["deny"]],
			["left", ["right", "withdraw"]],
			["keep", ["drop", "withdraw"]],
			["stop", ["extend", "split", "withdraw"]],
			["approve", ["revise", "cancel", "withdraw"]],
			["merge", ["wait", "withdraw"]],
		]);
		const why = all.map((e) => defaults(e).why);
		expect([why[0], why[1], why[5]].map((w) => w!.startsWith("first option"))).toEqual([true, true, true]);
		expect(why[0]).toContain("NOT a recommendation");
		expect([why[2], why[3], why[4]].map((w) => w!.startsWith("recommended"))).toEqual([true, true, true]);
		expect(why[4]).toContain("approve-with-changes");
		// no question body leaks in as an ask: the plain question's body text is nowhere in the block
		expect(text).not.toContain("left keeps the old one");
	});

	test("count and order are the rows': reserved requests first, then questions; answering one drops exactly its entry", () => {
		const { ledger, en, qPlain, qMarked, qCeiling, p, qOrch } = fixture();
		const items = pendingItems(ledger);
		expect(items.map((i) => i.id)).toEqual([en, qPlain, qMarked, qCeiling, p.q, qOrch]);
		expect(items[0]).toMatchObject({ kind: "reserved", options: ["approve", "deny"], defaultOption: "approve", answer: "approve", recommended: null, missing: [] });
		ledger.answerQuestion(qPlain, { by: SURFACE_BY, answer: "left", author: "jo", channel: "surface" });
		const after = pendingBlock(pendingItems(ledger));
		expect(after.count).toBe(5);
		expect(entryOf(after.text, qPlain)).toBeUndefined();
	});
	test("closing a workload hides its stray request and settled question while other work remains pending", () => {
		const { ledger } = tempLedger();
		const closed = ledger.openWorkload({ by: SURFACE_BY, brief: "Closed feed change", stakes: "normal", mode: "autonomous" });
		nameWork(ledger, closed, SURFACE_BY, "Closed feed change");
		const sl = ledger.addSlice({ by: "lane-a", workloadId: closed, task: "feed", doneCondition: "done", inputs: "header" });
		const stray = ledger.recordEntry({ by: "lane-a", workloadId: closed, kind: "reserved-request", body: "push main" });
		const settled = raiseAsked(ledger, { by: "lane-a", workloadId: closed, sliceId: sl, body: "Which header?", options: ["old", "new"], ask: "Which header should remain?" });
		const active = held(ledger, "lane-b", "Active feed change", "Active feed change");
		const waiting = raiseAsked(ledger, { by: "lane-b", workloadId: active.wl, sliceId: active.sl, body: "Which font?", options: ["plain", "bold"], ask: "Which font should the feed use?" });
		expect(pendingItems(ledger).map((item) => item.id)).toEqual([stray, settled, waiting]);
		ledger.answerQuestion(settled, { by: SURFACE_BY, answer: "old", author: "jo", channel: "surface" });
		ledger.completeSlice(sl, { by: "lane-a", artifact: "done" });
		ledger.closeWorkload(closed, { by: SURFACE_BY });
		const items = pendingItems(ledger);
		expect(items.map((item) => item.id)).toEqual([waiting]);
		const { text, count } = pendingBlock(items, pendingWaits(ledger));
		expect(count).toBe(1);
		expect(entryOf(text, waiting).at(-1)).toBe(`plain ${waiting}`);
		expect(text).not.toContain(stray);
		expect(text).not.toContain(settled);
		expect(text).not.toContain("Closed feed change");
	});

});

describe("pending: the reserved request is shown exactly, nothing hidden", () => {
	test("a hostile request (bidi override, zero-width, line breaks) is one visible line with every such character escaped, the command intact", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Deploy the site", "Site deploy");
		const body = "deploy \u202Egnp.exe\u202C now\nrm -rf /\u200B\r\n\u2028done\u0007";
		const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body });
		const text = pendingBlock(pendingItems(ledger)).text;
		const entry = entryOf(text, en);
		expect(shape(entry)).toEqual(["Work", "Question", "Request", "Default", "command"]);
		// the fixed reserved ask, the exact request with every hiding or line-breaking character escaped, and the command intact
		expect(field(entry, "Question")).toBe("Should this reserved action be approved or denied?");
		expect(field(entry, "Request")).toBe("deploy \\u{202E}gnp.exe\\u{202C} now\\u{000A}rm -rf /\\u{200B}\\u{000D}\\u{000A}\\u{2028}done\\u{0007}");
		expect(entry.at(-1)).toBe(`approve ${en}`);
		// the approve default is first-listed, never a recommendation, and the Default warns that an untouched paste approves it
		expect(defaults(entry)).toEqual({ option: "approve", why: expect.stringContaining("NOT a recommendation"), alternatives: ["deny"] });
		expect(field(entry, "Default")).toContain("untouched");
		// none of the raw characters reaches the block
		expect(/[\u202E\u202C\u200B\u2028\u0007\r]/.test(text)).toBe(false);
		// the request is never clipped
		const long = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: `deploy ${"--flag ".repeat(80)}end` });
		expect(field(entryOf(pendingBlock(pendingItems(ledger)).text, long), "Request")).toBe(`deploy ${"--flag ".repeat(80)}end`);
	});

	test("an unbound reserved request on the standing workload is the orchestrator's decisions", () => {
		const { ledger } = tempLedger();
		ensureStandingWorkload(ledger);
		const en = ledger.recordEntry({ by: "lane-4242", workloadId: STANDING_WORKLOAD_ID, kind: "reserved-request", body: "deploy: fly deploy" });
		expect(field(entryOf(pendingBlock(pendingItems(ledger)).text, en), "Work")).toBe("Orchestrator decisions");
	});
});

describe("pending: machine questions ask in fixed words for the options they offer", () => {
	test("the round-limit question asks from its phrases and shows its count line at raise", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-r", "Review loop", "Review loop");
		const q = ledger.write(() => {
			const id = ledger.raiseQuestion({ by: "lane-r", workloadId: wl, sliceId: sl, body: "3 of 3 review rounds failed; 1 blocking finding left.\nextend: three more", options: [...ROUND_LIMIT_OPTIONS] });
			ledger.recordEntry({ by: "lane-r", workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(id, sl) });
			return id;
		});
		const entry = entryOf(pendingBlock(pendingItems(ledger)).text, q);
		expect(shape(entry)).toEqual(["Work", "Question", "Context", "Default", "command"]);
		expect(field(entry, "Question")).toBe("Should we add review rounds, accept current findings, or stop without passing?");
		expect(field(entry, "Context")).toBe("at raise: 3 of 3 review rounds failed; 1 blocking finding left.");
		expect(defaults(entry)).toEqual({ option: "extend", why: expect.stringMatching(/^first option/), alternatives: ["accept", "stop", "withdraw"] });
		expect(entry.at(-1)).toBe(`extend ${q}`);
	});

	test("a stamped round-limit pair offer gives an ask for its options without changing its default", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-r", "Review loop", "Review loop");
		const q = ledger.write(() => {
			const id = ledger.raiseQuestion({
				by: "lane-r", workloadId: wl, sliceId: sl,
				body: "3 of 3 review rounds failed; 1 blocking finding left.\npair: stalled review loop.",
				options: [...ROUND_LIMIT_OPTIONS, "pair"],
			});
			ledger.recordEntry({ by: "lane-r", workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(id, sl) });
			ledger.recordEntry({ by: pairOfferStamp("round-limit"), workloadId: wl, kind: "assumption", body: pairOfferBody(id, "round-limit", ["a"]) });
			return id;
		});
		const entry = entryOf(pendingBlock(pendingItems(ledger)).text, q);
		const ask = field(entry, "Question");
		expect(ask).toMatch(/^Should we .+\?$/);
		expect(entry).not.toContain(metadata("ask", q));
		expect(defaults(entry)).toEqual({ option: "extend", why: expect.stringMatching(/^first option/), alternatives: ["accept", "stop", "pair", "withdraw"] });
		expect(entry.at(-1)).toBe(`extend ${q}`);
	});

	test("a stamped ceiling pair offer gives an ask for its options while stop remains the default", () => {
		const { ledger } = tempLedger();
		const { wl } = held(ledger, "lane-r", "Ceiling", "Ceiling work");
		const sl = ledger.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: `sl-ceiling-${wl.slice(3)}-1`, task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
		const q = ledger.write(() => {
			const id = ledger.raiseQuestion({
				by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl,
				body: "Spend reached 80 % of the ceiling.\npair: long steers.",
				options: [...CEILING_OPTIONS, "pair"],
			});
			ledger.recordEntry({ by: pairOfferStamp("ceiling"), workloadId: wl, kind: "assumption", body: pairOfferBody(id, "ceiling", ["b"]) });
			return id;
		});
		const entry = entryOf(pendingBlock(pendingItems(ledger)).text, q);
		const ask = field(entry, "Question");
		expect(ask).toMatch(/^Should we .+\?$/);
		expect(entry).not.toContain(metadata("ask", q));
		expect(defaults(entry)).toEqual({ option: "stop", why: "recommended; recorded as the default", alternatives: ["extend", "split", "pair", "withdraw"] });
		expect(entry.at(-1)).toBe(`stop ${q}`);
	});

	test("the park question asks from its phrases; the same options with no park entry are an ordinary question needing its ask", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-r", "Review loop", "Review loop");
		const park = ledger.write(() => {
			const id = ledger.raiseQuestion({ by: "lane-r", workloadId: wl, sliceId: sl, body: "No other lab can review", options: ["same-lab", "wait"] });
			ledger.recordEntry({ by: "lane-r", workloadId: wl, sliceId: sl, kind: "assumption", body: reviewParkBody(id, sl) });
			return id;
		});
		const lookalike = ledger.raiseQuestion({ by: "lane-r", workloadId: wl, sliceId: sl, body: "No other lab can review", options: ["same-lab", "wait"] });
		const text = pendingBlock(pendingItems(ledger)).text;
		expect(field(entryOf(text, park), "Question")).toBe("Should we use the builder's lab once or wait for another lab?");
		const entry = entryOf(text, lookalike);
		expect(shape(entry)).toEqual(["Work", "Metadata", "Default", "command"]);
		expect(entry[1]).toBe(metadata("ask", lookalike));
		expect(entry.at(-1)).toBe(`same-lab ${lookalike}`);
	});

	test("a ceiling-shaped question a lane raised takes neither the ceiling's phrases nor its default", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-b", "Other", "Other work");
		const own = ledger.raiseQuestion({ by: "lane-b", workloadId: wl, sliceId: sl, body: "80 % of the ceiling", options: ["extend", "stop", "split"] });
		const entry = entryOf(pendingBlock(pendingItems(ledger)).text, own);
		expect(shape(entry)).toEqual(["Work", "Metadata", "Default", "command"]);
		expect(entry[1]).toBe(metadata("ask", own));
		expect(defaults(entry)).toEqual({ option: "extend", why: expect.stringMatching(/^first option/), alternatives: ["stop", "split", "withdraw"] });
		expect(entry.at(-1)).toBe(`extend ${own}`);
	});

	test("the plan question: its stored ask wins; with none, the fixed sentence covers only the options offered; an unknown option needs an authored ask", () => {
		const { ledger } = tempLedger();
		const asked = planQuestion(ledger, planBody("approve"), { name: "Asked plan", ask: "Should the pending rows plan go ahead as written?" });
		const two = planQuestion(ledger, planBody("approve"), { name: "Two-option plan", options: ["approve", "cancel"] });
		const extra = planQuestion(ledger, planBody("approve"), { name: "Extra-option plan", options: ["approve", "revise", "cancel", "split"] });
		const text = pendingBlock(pendingItems(ledger)).text;
		expect(field(entryOf(text, asked.q), "Question")).toBe("Should the pending rows plan go ahead as written?");
		expect(field(entryOf(text, two.q), "Question")).toBe("Should we approve the plan or cancel it?");
		const entry = entryOf(text, extra.q);
		// consumer invariant: every line that names the open plan question (the Metadata gap line included) has its plan path line right beneath it
		const named = entry.flatMap((l, i) => (l.split(/[\s;]+/).includes(extra.q) && !l.startsWith("  plan for ") ? [i] : []));
		expect(named.length).toBeGreaterThanOrEqual(2);
		for (const i of named) expect(entry[i + 1]).toBe(`  plan for ${extra.q}: /tmp/plan.md`);
		expect(entry.filter((l) => l.startsWith("  plan for ")).length).toBe(named.length);
		expect(entry).toContain(metadata("ask", extra.q));
		expect(field(entry, "Work")).toBe("Extra-option plan");
		expect(field(entry, "Question")).toBeUndefined();
		expect(defaults(entry)).toEqual({ option: "approve", why: expect.stringMatching(/^recommended.*review: approve/), alternatives: ["revise", "cancel", "split", "withdraw"] });
		expect(entry.find((l) => l === `approve ${extra.q}`)).toBeDefined();
	});

	test("the ceiling Context is escaped and collapsed to one line", () => {
		const { ledger } = tempLedger();
		const { wl } = held(ledger, "lane-a", "Brief", "Ceiling work");
		const q = ceilingQuestion(ledger, wl, "Spend \u202Ereached\u202C  80 %\tof the ceiling.\nstop (the default): stopped.");
		expect(field(entryOf(pendingBlock(pendingItems(ledger)).text, q), "Context")).toBe("at raise: Spend \\u{202E}reached\\u{202C} 80 % of the ceiling.");
	});
});

describe("pending: defaults, in recommendation precedence", () => {
	test("a plan verdict that does not approve is shown, and the default says it is only the first option", () => {
		const { ledger } = tempLedger();
		const revise = planQuestion(ledger, planBody("revise-and-resubmit"), { name: "Revised plan" });
		expect(pendingItems(ledger)[0]).toMatchObject({ recommended: null, verdict: "revise-and-resubmit", defaultOption: "approve" });
		expect(defaults(entryOf(pendingBlock(pendingItems(ledger)).text, revise.q))).toEqual({
			option: "approve",
			why: expect.stringMatching(/^first option; NOT a recommendation.*revise-and-resubmit/),
			alternatives: ["revise", "cancel", "withdraw"],
		});
	});

	test("a (recommended), (the default) or (default) mark names an option; a mark naming no option records none", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Brief", "Marked work");
		const raise = (body: string, options: string[]) => raiseAsked(ledger, { by: "lane-a", workloadId: wl, sliceId: sl, body, options, ask: "Which one should we use?" });
		const rec = raise("Which? `Right` (Recommended), or left", ["left", "right"]);
		const def = raise("Which? wait (default), go (recommended)", ["go", "wait"]);
		const none = raise("Which? maybe (recommended)", ["left", "right"]);
		const text = pendingBlock(pendingItems(ledger)).text;
		expect([rec, def, none].map((id) => defaults(entryOf(text, id)))).toEqual([
			{ option: "right", why: expect.stringMatching(/^recommended/), alternatives: ["left", "withdraw"] },
			{ option: "wait", why: expect.stringMatching(/^recommended/), alternatives: ["go", "withdraw"] },
			{ option: "left", why: expect.stringMatching(/^first option/), alternatives: ["right", "withdraw"] },
		]);
	});

	test("options that are not one plain word, or none at all: the entry is counted, shows its default, and is answered in words", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Brief", "Wordy work");
		const words = raiseAsked(ledger, { by: "lane-a", workloadId: wl, sliceId: sl, body: "How far?", options: ["go on", "stop here"], ask: "How far should the cleanup go?" });
		// The ledger requires at least two options, so the no-option entry is a pure renderer input: a legal PendingItem with none.
		const [wordsItem] = pendingItems(ledger);
		const empty = { ...wordsItem!, id: "q-noopts", options: [], defaultOption: null, answer: null, recommended: null, recordedWhere: null, verdict: null, ask: "Is there anything else to change?" };
		const { text, count } = pendingBlock([wordsItem!, empty]);
		expect(count).toBe(2);
		expect(entryOf(text, words)).toBeUndefined(); // no line names it: its entry has no command
		const [wordy, none] = entries(text);
		// both entries are whole, each ending on the no-command Answer line in place of a command
		expect([shape(wordy!), shape(none!)]).toEqual([
			["Work", "Question", "Default", "Answer"],
			["Work", "Question", "Default", "Answer"],
		]);
		expect([wordy!.at(-1), none!.at(-1)]).toEqual(["# Answer: in words; no pasteable command", "# Answer: in words; no pasteable command"]);
		expect(field(wordy!, "Question")).toBe("How far should the cleanup go?");
		expect(field(none!, "Question")).toBe("Is there anything else to change?");
		expect(defaults(wordy!)).toEqual({ option: "go on", why: expect.stringMatching(/^first option/), alternatives: ["stop here", "withdraw"] });
		expect(field(wordy!, "Default")).toContain("in words");
		expect(field(none!, "Default")).toBe("none — no options recorded");
		expect(pendingItems(ledger).map((i) => [i.id, i.answer, i.defaultOption])).toEqual([[words, null, "go on"]]);
		// An empty-options card is a legal renderer shape even though the ledger requires two options;
		// structural recognition routes it to the ledger, which will refuse it unless currently shown.
		expect(pendingShaped(none!.join("\n"))).toBe(true);
		expect(pendingShaped(none!.slice(0, -1).join("\n"))).toBe(false);
		expect(pendingShaped(none!.slice(1).join("\n"))).toBe(false); // missing Work and its diagnostic
	});
});

describe("pending: a missing description is named on its own row, nothing else lost", () => {
	test("a workload with no name and a question with no ask: Metadata lines name each gap; default and command stay", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Legacy work brief", null);
		const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Left or right?\nleft keeps it", options: ["left", "right"] });
		const items = pendingItems(ledger);
		expect(items.map((i) => i.missing)).toEqual([[{ field: "name", id: wl }], [{ field: "name", id: wl }, { field: "ask", id: q }]]);
		const text = pendingBlock(items).text;
		const reserved = entryOf(text, en);
		expect(shape(reserved)).toEqual(["Question", "Request", "Metadata", "Default", "command"]);
		expect(reserved[2]).toBe(metadata("name", wl));
		expect(reserved.at(-1)).toBe(`approve ${en}`);
		const question = entryOf(text, q);
		expect(shape(question)).toEqual(["Metadata", "Metadata", "Default", "command"]);
		expect(question.slice(0, 2)).toEqual([metadata("name", wl), metadata("ask", q)]);
		expect(defaults(question).option).toBe("left");
		expect(question.at(-1)).toBe(`left ${q}`);
		expect(text).not.toContain("Left or right?");
		expect(text).not.toContain("Legacy work brief");
	});

	test("orchestrator questions: one about a workload inherits its name (or names its gap); one about none carries its own", () => {
		const { ledger } = tempLedger();
		ensureStandingWorkload(ledger);
		const unnamed = held(ledger, "lane-a", "No name yet", null);
		const about = raiseOrchestratorQuestion(ledger, { body: "Merge now?", options: ["merge", "wait"], about: unnamed.wl, ask: "Should the header fix merge now?" });
		const bare = raiseOrchestratorQuestion(ledger, { body: "Ship it?", options: ["ship", "hold"], about: null, ask: "Should we ship the release today?", name: "Release train" });
		const text = pendingBlock(pendingItems(ledger)).text;
		const aboutEntry = entryOf(text, about);
		expect(aboutEntry).toContain(metadata("name", unnamed.wl));
		expect(aboutEntry).toContain("# Question: Should the header fix merge now?");
		expect(field(aboutEntry, "Work")).toBeUndefined();
		expect(defaults(aboutEntry).option).toBe("merge");
		expect(aboutEntry.at(-1)).toBe(`merge ${about}`);
		expect(entryOf(text, bare).slice(0, 2)).toEqual(["# Work: Release train", "# Question: Should we ship the release today?"]);
		nameWork(ledger, unnamed.wl, SURFACE_BY, "Header fix");
		expect(entryOf(pendingBlock(pendingItems(ledger)).text, about)[0]).toBe("# Work: Header fix");
	});
});

describe("pending: prompt waits", () => {
	test("each unresolved prompt wait is an uncounted entry after the counted ones, offering the real choice and no command", () => {
		const { ledger, a, qOrch } = fixture();
		const reason = "ask: which `branch`?\n\u202Edrop it";
		ledger.enqueue({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("ask", "c7", "s1", reason) });
		const waits = pendingWaits(ledger);
		expect(waits).toHaveLength(1);
		const { text, count } = pendingBlock(pendingItems(ledger), waits);
		expect(count).toBe(6);
		const all = entries(text);
		expect(all.at(-2)!.at(-1)).toBe(`merge ${qOrch}`);
		const wait = all.at(-1)!;
		expect(shape(wait)).toEqual(["Work", "Question", "Context", "Default", "Session", "Since", "Answer"]);
		expect(field(wait, "Work")).toBe("Feed header offset");
		expect(field(wait, "Question")).toBe("Will you answer the ask prompt in lane-a's session, or end that session?");
		expect(field(wait, "Context")).toBe("ask: which `branch`? \\u{202E}drop it");
		expect(field(wait, "Default")).toBe("none — pending cannot answer a human prompt");
		expect(field(wait, "Session")).toContain("lane-a");
		expect(field(wait, "Session")).toContain("s1");
		expect(field(wait, "Since")).toBe(openPromptWaits(ledger, a.wl)[0]!.created_at);
		expect(field(wait, "Answer")).toContain("lane-a");
	});

	test("a wait on an unnamed workload names the gap; with nothing counted the block still shows it", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = held(ledger, "lane-a", "Unnamed", null);
		ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("bash", "c1", "s9", "approve rm") });
		const { text, count } = pendingBlock(pendingItems(ledger), pendingWaits(ledger));
		expect(count).toBe(0);
		expect(text.split("\n")[0]).toStartWith("## pending: 0 things wait on you (");
		expect(entries(text)[0]!.slice(0, 3)).toEqual(["# Question: Will you answer the bash prompt in lane-a's session, or end that session?", "# Context: approve rm", metadata("name", wl)]);
	});
});
