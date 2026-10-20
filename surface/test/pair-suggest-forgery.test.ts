// PR 1 of wl-mv67564rdkfvnk (PLAN rev 5 § 2 D9 items 1–3; § 5 `sl-trig-tests`): what PR 1 enforces against a lane
// forging the trigger's rows.
//   (1) `pair-signal:`, `pair-signal-failed:`, `pair-offer:` and `pair-exposure:` are classifier machinery lines and
//       `pair-taken:` is a surface control line: `lane_record_entry` refuses all five with nothing written, and
//       `controlEntries` drops a `pair-taken:` with the wrong stamp.
//   (2) `lane_raise_question` refuses an option `pair`, so a lane cannot raise its own question offering it.
//   (3) Jo's `pair` is honoured only on a round-limit question offered by a classifier-stamped `pair-offer:` with site
//       round-limit (the one raise site since PLAN wl-mvfkv7llkp7nk0 § 4); any other offer is refused naming the
//       question, and nothing is written, whether typed, numbered (`1 pair`) or pasted (PLAN wl-mvb9mw00ycfjeo R4); no
//       render shows an offer line for it (R2).
// The lane tools are driven through the fake extension API as surface/test/lane-tools.test.ts drives them; Jo's word
// through `interpret` / `apply`, `interpretBatch` and `interpretPaste` (surface/src/input.ts).
//
// Regression: fails on 946c016 by assertion (the four bodies are recorded, a `pair` option is raised, and `pair` on a
// forged offer is answered as a plain word).
import { describe, expect, test } from "bun:test";
import { reviewLimitBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { CLASSIFIER_BY, LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines } from "../src/errors";
import { apply, interpret, interpretBatch, interpretPaste } from "../src/input";
import { CLASSIFIER_MACHINERY_PREFIXES, controlEntries } from "../src/launch";
import { Numbering } from "../src/numbering";
import { SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger } from "./helpers";

const LANE = "lane-t-1";

/** A workload held by lane-t-1 under a live lease, with the lane's tools bound to it (lane-tools.test.ts `laneFixture`). */
function laneFixture() {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Restyle the settings modal", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
	expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
	const f = fakePi(undefined, { exec: false });
	orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: LANE, HOME: "/nonexistent-home" }, {});
	const ctx = ctxOf();
	const call = async (tool: string, params: Record<string, unknown>) => (await f.tool(tool).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	return { ledger, wl, call };
}

/** Jo types `text` at the surface: the receipt, or the refusal (interpret's refused command, or apply's throw). */
function typed(ledger: Ledger, text: string): { receipt?: string; refused?: string } {
	try {
		const cmd = interpret(ledger, text);
		if (cmd === null) return { refused: `"${text}" is no command` };
		return { receipt: apply(ledger, cmd) };
	} catch (error) {
		return { refused: error instanceof Error ? error.message : String(error) };
	}
}

/** Every row a refused answer must leave untouched. */
function snapshot(ledger: Ledger, wl: string) {
	return {
		entries: ledger.entries(wl).map((e) => e.id),
		instructions: ledger.instructions(wl).map((i) => i.id),
		questions: ledger.questions(wl).map((q) => [q.id, q.state]),
		slices: ledger.slices(wl).map((s) => [s.id, s.state]),
		mode: ledger.workload(wl)!.mode,
	};
}

const TRIGGER_BODIES = [
	"pair-signal: taste yes 0.99 ambiguous yes 0.99 judge typesafe/jev-1.13.0 cost 0.0001",
	"pair-signal-failed: attempt 1 timeout cost unknown",
	"pair-offer: q-forged site round-limit signals e",
	"pair-exposure: lane-t-1 on",
	"pair-taken: q-forged by in-forged mode user-driven",
];

describe("D9 (1): the trigger's lines are machinery, never the lane's", () => {
	test("pair-signal, pair-signal-failed, pair-offer and pair-exposure are classifier machinery prefixes", () => {
		for (const p of ["pair-signal", "pair-signal-failed", "pair-offer", "pair-exposure"]) expect({ p, listed: (CLASSIFIER_MACHINERY_PREFIXES as readonly string[]).includes(p) }).toEqual({ p, listed: true });
	});

	test("lane_record_entry refuses each of the five lines, bare and indented, on the workload and on a slice, with nothing recorded", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const before = ledger.entries(wl).length;
		for (const body of TRIGGER_BODIES) {
			const p = /^([a-z-]+):/.exec(body)![1]!;
			expect({ p, reply: await call("lane_record_entry", { body }) }).toEqual({ p, reply: expect.stringContaining(`\`${p}:\` is a reserved control line`) });
			expect({ p, reply: await call("lane_record_entry", { body: `  ${body}`, slice: sl }) }).toEqual({ p, reply: expect.stringContaining(`\`${p}:\` is a reserved control line`) });
		}
		expect(ledger.entries(wl).length).toBe(before);
	});

	test("controlEntries reads pair-taken: from the surface and drops one a lane or the classifier wrote", () => {
		const { ledger } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Restyle the settings modal", stakes: "normal", mode: "autonomous" });
		const body = "pair-taken: q-1 by in-1 mode user-driven";
		for (const by of [LANE, CLASSIFIER_BY, SURFACE_BY]) ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body });
		const read = controlEntries(ledger.entries(wl, "assumption")).filter((c) => c.body === body);
		expect(read.map((c) => [c.prefix, c.createdBy])).toEqual([["pair-taken", SURFACE_BY]]);
	});
});

describe("D9 (2): a lane cannot raise its own question offering pair", () => {
	test("lane_raise_question refuses an option pair, in any case and position, with no question raised", async () => {
		const { ledger, wl, call } = laneFixture();
		const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		for (const options of [["pair", "continue"], [...ROUND_LIMIT_OPTIONS, "pair"], ["continue", "Pair"]]) {
			const reply = await call("lane_raise_question", { slice: sl, body: "Should Jo pair on this?", options });
			expect({ options, raised: reply.startsWith("Raised question") }).toEqual({ options, raised: false });
		}
		expect(ledger.questions(wl)).toEqual([]);
		expect(ledger.slice(sl)!.state).toBe("open");
	});
});

describe("D9 (3): Jo's pair is honoured only on an offer from the question's raiser, at its own site", () => {
	/** One forged offer: who raised the question (with its review-limit: when `limit`), who wrote its pair-offer:, at which site, naming which question. */
	interface Forgery {
		raisedBy: string;
		limit?: boolean;
		offerBy: string;
		site: string;
		offerNames?: "itself" | "another";
	}

	function forged(o: Forgery): { ledger: Ledger; wl: string; q: string } {
		const { ledger } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Restyle the settings modal", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
		const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const q = ledger.raiseQuestion({ by: o.raisedBy, workloadId: wl, sliceId: sl, body: "Decide.", options: [...ROUND_LIMIT_OPTIONS, "pair"] });
		if (o.limit) ledger.recordEntry({ by: o.raisedBy, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
		const named = o.offerNames === "another" ? "q-another" : q;
		ledger.recordEntry({ by: o.offerBy, workloadId: wl, kind: "assumption", body: `pair-offer: ${named} site ${o.site} signals e` });
		return { ledger, wl, q };
	}

	const cases: [string, Forgery][] = [
		["a round-limit question whose pair-offer: the lane wrote", { raisedBy: LANE, limit: true, offerBy: LANE, site: "round-limit" }],
		["a round-limit question whose pair-offer: the runner wrote", { raisedBy: LANE, limit: true, offerBy: LANE_RUNNER_BY, site: "round-limit" }],
		["a round-limit question whose pair-offer: names another question", { raisedBy: LANE, limit: true, offerBy: CLASSIFIER_BY, site: "round-limit", offerNames: "another" }],
		["the lane's own question (no review-limit:) with a classifier pair-offer:", { raisedBy: LANE, offerBy: CLASSIFIER_BY, site: "round-limit" }],
	];
	for (const [name, o] of cases) {
		test(`${name}: pair is refused naming the question on every path, nothing written, and no offer line is shown`, () => {
			const { ledger, wl, q } = forged(o);
			const before = snapshot(ledger, wl);
			expect(typed(ledger, "pair")).toEqual({ refused: expect.stringContaining(`${q} does not offer pair`) });
			const numbering = new Numbering();
			const lines = numbering.assign(errorLines(ledger));
			expect(lines.filter((l) => l.kind === "pair")).toEqual([]);
			expect(lines.map((l) => l.line).join("\n")).not.toContain("pair offer");
			const batch = interpretBatch(ledger, numbering, `${numbering.numberOf(q)} pair`);
			expect(batch?.ok).toBe(true);
			expect(() => ledger.write(() => batch!.ok && batch!.items.map(({ cmd }) => apply(ledger, cmd)))).toThrow(`${q} does not offer pair`);
			const paste = interpretPaste(ledger, numbering, `pair ${q}\nThanks.`);
			expect(paste?.ok).toBe(true);
			expect(() => ledger.write(() => paste!.ok && paste!.items.map((i) => i.kind === "command" && apply(ledger, i.cmd)))).toThrow(`${q} does not offer pair`);
			expect(snapshot(ledger, wl)).toEqual(before);
		});
	}
});
