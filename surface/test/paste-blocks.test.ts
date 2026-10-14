// A paste that mixes command lines and prose (PLAN wl-mv66ylg1op3wg0 D1): when Jo typed the whole
// paste and something is open for it, each plain-words run is its own Jo input row on the standing
// workload, written in the paste's transaction with the commands, its id appended as a
// `surface-jo-input` entry and echoed by its line span only after the commit; a paste the ledger
// refuses inside its transaction writes no row and names no id; a paste Jo did not type applies its
// commands and writes no row. Driven through the real extension with the fake host, as
// surface/test/orchestrator-question.test.ts does (`input`, then `before_agent_start`).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLimitBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import type { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { STANDING_SLICE_ID, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, notices, tempLedger, tmp } from "./helpers";

type Started = { systemPrompt: string[]; messages: { customType: string; content: string }[] };

/** A surface over `db`, as a fresh process would load it. */
function surface(db: string) {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: db, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const f = fakePi();
	orchestratorSurface(f.pi, env);
	const ctx = ctxOf();
	/** The turn's prompt, after OMP's `input` when Jo typed it: the turn's notices and context messages. */
	const turn = async (prompt: string, typed: boolean): Promise<{ lines: string[]; started: Started }> => {
		if (typed) await f.emit("input", { text: prompt, source: "interactive" }, ctx);
		notices.length = 0;
		const started = (await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as Started;
		return { lines: [...notices], started };
	};
	const record = async (params: Record<string, unknown>) =>
		(await f.tool("orchestrator_record_instruction").execute("1", { reading: "as Jo said", ...params }, undefined, undefined, ctx)).content[0]!.text;
	const raise = async (params: Record<string, unknown>) => (await f.tool("orchestrator_raise_question").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	/** The `surface-jo-input` entries' data, in append order. */
	const joInputs = () => f.entries.filter((e) => e.type === "surface-jo-input").map((e) => e.data);
	return { f, ctx, turn, record, raise, joInputs };
}

/** Jo's input rows on the standing workload (the instruction rows the surface wrote as Jo). */
const joRows = (ledger: Ledger) => ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => i.kind === "instruction" && i.author === "jo");

/** A workload with three plan-style questions open on three slices, numbered 1–3 on the needs-you list. */
function threeQuestions() {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	const qs = [1, 2, 3].map((n) => {
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: `plan ${n}`, doneCondition: "d", inputs: "a.ts" });
		return ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: `Plan ${n}: approve?`, options: ["approve", "revise", "cancel"] });
	});
	return { ledger, path, wl, qs };
}

// Jo's 04:37Z shape: prose, a numbered answer, prose, an answer, prose, an answer, prose.
const PROSE = [
	"Here are my answers to the three plans, in order.",
	"The first plan reads right to me, ship it as written.",
	"For the second one keep the existing tests exactly as they are.",
	"Tell me when the third has a PR open and its review is back.",
];
const PASTE = [PROSE[0], "1 approve", PROSE[1], "2 approve", PROSE[2], "3 approve", PROSE[3]].join("\n");
const TAIL = (id: string) =>
	`if they instruct you about an open workload, record that with orchestrator_record_instruction naming workloadId and inputId ${id} (Jo's words are read from the row, never from your parameters); if they do neither, record nothing`;

describe("a paste's prose runs as Jo input rows (D1)", () => {
	test("Jo's 04:37Z paste: three answers and four Jo input rows, bodies = the prose lines, four distinct ids each echoed and appended after the commit; the recorder spends one", async () => {
		const { ledger, path, wl, qs } = threeQuestions();
		const s = surface(path);
		const { lines, started } = await s.turn(PASTE, true);
		for (const q of qs) expect(ledger.question(q)).toMatchObject({ state: "answered" });
		expect(ledger.instructions(wl).filter((i) => i.kind === "answer").map((i) => i.body)).toEqual(["approve", "approve", "approve"]);
		const rows = joRows(ledger);
		expect(rows.map((r) => r.body)).toEqual(PROSE);
		expect(rows.map((r) => [r.channel, r.created_by, r.slice_id, r.question_id])).toEqual(PROSE.map(() => ["surface", SURFACE_BY, STANDING_SLICE_ID, null]));
		const ids = rows.map((r) => r.id);
		expect(new Set(ids).size).toBe(4);
		for (const id of ids) expect(id).toStartWith("in-");
		expect(s.joInputs()).toEqual(ids.map((id) => ({ id })));
		// one echo line per item in paste order: each run names its line and its row's id (no standing question is open, so no questionId clause)
		expect(lines).toHaveLength(7);
		for (const [k, at] of [1, 3, 5, 7].entries()) {
			expect(lines[at - 1]).toBe(`line ${at} is Jo's input ${ids[k]}: "${PROSE[k]}" — ${TAIL(ids[k]!)}`);
		}
		for (const at of [2, 4, 6]) expect(lines[at - 1]).toMatch(new RegExp(`^#${at / 2} → answered q-\\S+ with "approve"`));
		expect(started.messages[0]!.content).toContain(`- line 7 is Jo's input ${ids[3]}: "${PROSE[3]}"`);
		// each id is a receipt the recorder accepts, once
		expect(await s.record({ workloadId: wl, inputId: ids[3] })).toMatch(new RegExp(`^Recorded instruction in-\\S+ on ${wl} from Jo's input ${ids[3]} `));
		expect(ledger.instructions(wl).filter((i) => i.kind === "instruction").map((i) => i.body)).toEqual([`Jo: "${PROSE[3]}" — reading: as Jo said`]);
	});

	test("a multi-line prose run between commands is one row, body = its lines joined; an open orchestrator question is named for questionId", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Direction?", options: ["left", "right"] });
		const s = surface(path);
		const raised = /^Raised question (q-\S+)/.exec(await s.raise({ body: "Keep the draft, or rewrite it?", options: ["keep", "rewrite"], about: wl }));
		const oq = raised![1]!;
		const run = ["Keep the draft as it is.", "Then rerun the review on the new head.", "", "And tell me when it is back."];
		const { lines } = await s.turn([`left ${q}`, ...run, `production ${wl}`].join("\n"), true);
		expect(ledger.question(q)!.state).toBe("answered");
		expect(ledger.workload(wl)!.stakes).toBe("production");
		const rows = joRows(ledger);
		expect(rows.map((r) => r.body)).toEqual([run.join("\n")]);
		const id = rows[0]!.id;
		expect(s.joInputs()).toEqual([{ id }]);
		expect(lines).toEqual([
			expect.stringContaining(`answered ${q} with "left"`),
			`lines 2–5 are Jo's input ${id}: "Keep the draft as it is. Then rerun the review on the new head. And tell me when it is back." — if they answer ${oq}, record that with orchestrator_record_instruction naming questionId and inputId ${id}; ${TAIL(id)}`,
			expect.stringMatching(new RegExp(`^stakes on ${wl} → production `)),
		]);
		expect(ledger.question(oq)!.state).toBe("open");
	});

	test("a paste whose last command fails inside the transaction writes no Jo row and names no id", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Round limit reached", options: [...ROUND_LIMIT_OPTIONS] });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
		const s = surface(path);
		// `stop-reviews` withdraws the round-limit question inside the transaction, so `extend` on the last line fails in the ledger
		const { lines } = await s.turn(["Stop the review loop on that slice now.", `stop-reviews ${sl}`, "Then give it one more round after all.", `extend ${q}`].join("\n"), true);
		expect(lines).toEqual([
			"line 1: an instruction for you, held with the rest; record nothing from this paste",
			`line 2 "stop-reviews ${sl}": ok, not applied`,
			"line 3: an instruction for you, held with the rest; record nothing from this paste",
			expect.stringMatching(new RegExp(`^line 4 "extend ${q}": .*must name an open question`)),
			"nothing applied: fix line 4 and paste all of it again",
		]);
		expect(lines.join("\n")).not.toMatch(/\bin-[a-z0-9]/);
		expect(joRows(ledger)).toEqual([]);
		expect(s.joInputs()).toEqual([]);
		expect(ledger.question(q)!.state).toBe("open");
	});

	test("the same paste untyped (no `input`, or an `input` that is not the paste): the commands apply as today, no Jo row, each run named with no row written", async () => {
		for (const typed of [null, "1 approve", PASTE.replace("ship it", "send it")] as const) {
			const { ledger, path, qs } = threeQuestions();
			const s = surface(path);
			if (typed !== null) await s.f.emit("input", { text: typed, source: "interactive" }, s.ctx);
			const { lines } = await s.turn(PASTE, false);
			for (const q of qs) expect(ledger.question(q)!.state).toBe("answered");
			expect(joRows(ledger)).toEqual([]);
			expect(s.joInputs()).toEqual([]);
			expect(lines.filter((_, i) => i % 2 === 0)).toEqual(PROSE.map((p, k) => `line ${2 * k + 1} → an instruction for you, no input row written (this paste was not typed by Jo): "${p}"`));
		}
	});
});
