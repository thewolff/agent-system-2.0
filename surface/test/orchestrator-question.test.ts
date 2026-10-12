// The orchestrator's questions to Jo as ledger rows (MIGRATION.md item 105): the standing slice is
// ensured once on any ledger (fresh, or one from before the item with the workload and no slice);
// orchestrator_raise_question writes the row on it, the needs-you render and the wake show it, and
// the invariant report's stuck-question counts it with no change to its SQL; Jo's `<option> q-…`
// at the surface resolves the row and mirrors the decision on the subject workload in one
// transaction (a mirror that cannot be written rolls the answer back); a withdrawal with `cancel`
// never cancels the standing slice, so a second question can always be raised; a restarted
// surface re-renders the open ones at its wake.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { check, type Probe } from "../scripts/invariants";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import { apply, interpret } from "../src/input";
import { answerOrchestratorQuestion, questionSubject, questionSubjectBody } from "../src/orchestrator-question";
import { STANDING_BRIEF, STANDING_SLICE_ID, STANDING_SLICE_TASK, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
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
	const raise = async (params: Record<string, unknown>) => (await f.tool("orchestrator_raise_question").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	const idOf = (text: string): string => {
		const m = /^Raised question (q-\S+)/.exec(text);
		if (!m) throw new Error(`not raised: ${text}`);
		return m[1]!;
	};
	const wake = async (): Promise<string> => {
		await f.emit("session_start", { type: "session_start" }, ctx);
		const started = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: ["base"] }, ctx)) as Started;
		return started.messages[0]?.content ?? "";
	};
	const say = async (prompt: string): Promise<string[]> => {
		notices.length = 0;
		await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx);
		return [...notices];
	};
	return { f, ctx, raise, idOf, wake, say };
}

describe("the standing slice", () => {
	test("a fresh ledger gets the standing workload and its slice together; a ledger from before item 105 (workload, no slice) gets the slice alone; each call after the first adds nothing", () => {
		const fresh = tempLedger().ledger;
		expect(ensureStandingWorkload(fresh)).toBe(STANDING_WORKLOAD_ID);
		expect(fresh.slices(STANDING_WORKLOAD_ID)).toMatchObject([{ id: STANDING_SLICE_ID, task: STANDING_SLICE_TASK, state: "open", created_by: SURFACE_BY }]);
		ensureStandingWorkload(fresh);
		ensureStandingWorkload(fresh);
		expect(fresh.slices(STANDING_WORKLOAD_ID)).toHaveLength(1);
		expect(standingSlice(fresh)?.id).toBe(STANDING_SLICE_ID);

		const old = tempLedger().ledger;
		old.openWorkload({ by: SURFACE_BY, id: STANDING_WORKLOAD_ID, brief: STANDING_BRIEF, stakes: "throwaway", mode: "autonomous" });
		old.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "identity: Ilex (they/them)" });
		expect(standingSlice(old)).toBeNull();
		ensureStandingWorkload(old);
		ensureStandingWorkload(old);
		expect(old.slices(STANDING_WORKLOAD_ID).map((s) => [s.id, s.state])).toEqual([[STANDING_SLICE_ID, "open"]]);
		expect(old.entries(STANDING_WORKLOAD_ID, "assumption")).toHaveLength(1);
	});

	test("a standing slice cancelled by a direct write is replaced by a live one under a fresh id, so a question can still be raised", () => {
		const { ledger } = tempLedger();
		ensureStandingWorkload(ledger);
		ledger.cancelSlice(STANDING_SLICE_ID, { by: "someone" });
		expect(standingSlice(ledger)).toBeNull();
		ensureStandingWorkload(ledger);
		const live = standingSlice(ledger)!;
		expect(live.id).not.toBe(STANDING_SLICE_ID);
		expect(live).toMatchObject({ task: STANDING_SLICE_TASK, state: "open" });
		expect(() => ledger.raiseQuestion({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: live.id, body: "x?", options: ["a", "b"] })).not.toThrow();
	});
});

describe("the question row", () => {
	test("the subject rides in a surface entry keyed by the question id, never in the body (fix round 1, S1); a body starting `about wl-…:` is refused", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const s = surface(path);
		expect(await s.raise({ body: `about ${wl}: Change the plan?`, options: ["yes", "no"] })).toContain("never as an `about wl-…:` prefix");
		expect(await s.raise({ body: "about wl-orchestrator: Change the plan?", options: ["yes", "no"] })).toContain("Nothing was asked");
		expect(ledger.questions(STANDING_WORKLOAD_ID)).toEqual([]);
		const q = s.idOf(await s.raise({ body: "Change the plan?", options: ["yes", "no"], about: wl }));
		expect(ledger.question(q)!.body).toBe("Change the plan?");
		expect(questionSubject(ledger, q)).toBe(wl);
		expect(ledger.entries(STANDING_WORKLOAD_ID, "assumption").map((e) => [e.created_by, e.body])).toEqual([[SURFACE_BY, questionSubjectBody(q, wl)]]);
		const bare = s.idOf(await s.raise({ body: "Rename me?", options: ["yes", "no"] }));
		expect(questionSubject(ledger, bare)).toBeNull();
		// The needs-you line, the recorder and the typed answer all read that one entry: the line names the subject from it.
		const lines = errorLines(ledger).filter((l) => l.kind === "question").map((l) => l.line);
		expect(lines.join("\n")).toContain(`(${q}, about ${wl}): Change the plan?`);
		expect(lines.join("\n")).toContain(`(${bare}): Rename me?`);
	});

	test("orchestrator_raise_question writes the row on the standing slice (pausing it), refuses a bad shape, and the row shows under needs-you, in the wake, and in stuck-question after 30 min", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the wake read", stakes: "normal", mode: "autonomous" });
		const done = ledger.openWorkload({ by: "lane-a", brief: "Done already", stakes: "normal", mode: "autonomous" });
		ledger.closeWorkload(done, { by: "lane-a" });
		const s = surface(path);
		expect(await s.raise({ body: "", options: ["a", "b"] })).toContain("nothing was asked");
		expect(await s.raise({ body: "x?", options: ["a", "A"] })).toContain("at least two distinct options");
		expect(await s.raise({ body: "x?", options: ["a", "two words"] })).toContain("one word");
		expect(await s.raise({ body: "x?", options: ["a", "b"], about: STANDING_WORKLOAD_ID })).toContain("never a question's subject");
		expect(await s.raise({ body: "x?", options: ["a", "b"], about: "nope" })).toContain("not a workload id");
		expect(await s.raise({ body: "x?", options: ["a", "b"], about: "wl-nope" })).toContain("No workload wl-nope");
		expect(await s.raise({ body: "x?", options: ["a", "b"], about: done })).toContain("is closed");
		expect(ledger.questions(STANDING_WORKLOAD_ID)).toEqual([]);
		const text = await s.raise({ body: "Open a production workload for the empty-slice\n  wake-read fix now, or later?", options: ["now", "later"], about: wl });
		const q = s.idOf(text);
		expect(text).toContain(`about ${wl} (now / later); name ${q} in your QUESTION block`);
		expect(ledger.question(q)).toMatchObject({
			workload_id: STANDING_WORKLOAD_ID, slice_id: STANDING_SLICE_ID, state: "open", created_by: SURFACE_BY,
			body: "Open a production workload for the empty-slice wake-read fix now, or later?", options: '["now","later"]',
		});
		expect(questionSubject(ledger, q)).toBe(wl);
		expect(ledger.slice(STANDING_SLICE_ID)!.state).toBe("paused");
		expect(s.f.entries.filter((e) => e.type === "surface-question")).toEqual([{ type: "surface-question", data: { id: q, about: wl } }]);

		// needs-you: the orchestrator's own line, numbered like any question, its subject named.
		const lines = errorLines(ledger).filter((l) => l.kind === "question");
		expect(lines).toMatchObject([{ workloadId: STANDING_WORKLOAD_ID, rowId: q, options: ["now", "later"] }]);
		expect(lines[0]!.line).toBe(`the orchestrator asked you (${q}, about ${wl}): Open a production workload for the empty-slice wake-read fix now, or later? — answer with one word: now / later (or \`withdraw\`)`);
		expect(await s.wake()).toContain(lines[0]!.line);

		// stuck-question, over the same SQL, 30 min on: the finding names the row on the standing workload. (The surface's own
		// connection stamps real time, so as-of is taken from the row.)
		const db = new Database(path, { readonly: true });
		const noProbe: Probe<never> = { skipped: "not run" };
		const at = Date.parse(ledger.question(q)!.created_at);
		const run = (minutes: number) => check({ db, asOf: new Date(at + minutes * 60_000).toISOString(), replay: true, liveLanes: { found: new Set<string>() }, lanesDirOf: () => "/nonexistent", repo: "/nonexistent", git: null, orchestrators: () => noProbe, backups: { dir: "/nonexistent", gapMs: 30 * 60 * 60_000 }, offDisk: noProbe });
		expect(run(20).findings.filter((f) => f.invariant === "stuck-question")).toEqual([]);
		const stuck = run(31).findings.filter((f) => f.invariant === "stuck-question");
		expect(stuck).toMatchObject([{ key: `stuck-question:${q}`, workload: STANDING_WORKLOAD_ID, since: ledger.question(q)!.created_at }]);
		expect(stuck[0]!.text).toContain("has been open 31 min");
		db.close();
	});
});

describe("Jo's answer", () => {
	test("`<option> q-…` resolves the row and writes Jo's instruction on the subject workload in one transaction; the lane on that workload reads it there; the standing slice is open again", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the wake read", stakes: "normal", mode: "autonomous" });
		const s = surface(path);
		const q = s.idOf(await s.raise({ body: "Open the fix workload now, or later?", options: ["now", "later"], about: wl }));
		const cmd = interpret(ledger, `later ${q}`);
		expect(cmd).toEqual({ kind: "answer", workloadId: STANDING_WORKLOAD_ID, questionId: q, answer: "later" });
		const lines = await s.say(`later ${q}`);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(new RegExp(`^answered the orchestrator's ${q} with "later" \\(answer in-\\S+\\); recorded on ${wl} as instruction in-\\S+$`));
		const row = ledger.question(q)!;
		expect(row.state).toBe("answered");
		const answer = ledger.instructions(STANDING_WORKLOAD_ID).find((i) => i.id === row.resolved_by)!;
		expect(answer).toMatchObject({ kind: "answer", question_id: q, author: "jo", channel: "surface", body: "later" });
		expect(ledger.instructions(wl)).toMatchObject([{ kind: "instruction", question_id: null, author: "jo", channel: "surface", body: `Jo: "later" — answers ${q}: Open the fix workload now, or later?` }]);
		expect(ledger.slice(STANDING_SLICE_ID)!.state).toBe("open");
	});

	test("a bare option word fits the orchestrator's question like any other; the numbered batch form answers it too", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const s = surface(path);
		const q = s.idOf(await s.raise({ body: "Now or later?", options: ["now", "later"], about: wl }));
		expect(interpret(ledger, "now")).toEqual({ kind: "answer", workloadId: STANDING_WORKLOAD_ID, questionId: q, answer: "now" });
		await s.wake(); // numbers the needs-you lines
		const lines = await s.say("1 now");
		expect(lines[0]).toContain(`#1 → answered the orchestrator's ${q} with "now"`);
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual([`Jo: "now" — answers ${q}: Now or later?`]);
	});

	test("a subject the file refuses to mirror (closed or gone) leaves the question open and tells Jo why: typed, numbered and recorded answers alike (fix round 1, B4)", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const s = surface(path);
		const q = s.idOf(await s.raise({ body: "Now or later?", options: ["now", "later"], about: wl }));
		ledger.closeWorkload(wl, { by: "lane-a" });
		expect(() => answerOrchestratorQuestion(ledger, { id: q }, { answer: "now", mirrorBody: "x" })).toThrow(new RegExp(`^${q} is about ${wl}, which is closed \\(.+\\): the answer was not recorded and ${q} stays open; \`withdraw ${q}\` withdraws it$`));
		expect(ledger.question(q)!.state).toBe("open");
		expect(ledger.instructions(STANDING_WORKLOAD_ID)).toEqual([]);
		expect(ledger.instructions(wl)).toEqual([]);
		const typed = await s.say(`now ${q}`);
		expect(typed).toHaveLength(1);
		expect(typed[0]).toContain(`could not apply "now ${q}": ${q} is about ${wl}, which is closed`);
		expect(typed[0]).toContain(`${q} stays open`);
		await s.wake();
		const batch = await s.say("1 now");
		expect(batch.join("\n")).toContain(`${q} is about ${wl}, which is closed`);
		expect(ledger.question(q)!.state).toBe("open");
		expect(ledger.instructions(STANDING_WORKLOAD_ID)).toEqual([]);
		// A question with no subject answers alone; one whose subject is gone from the file is refused the same way.
		const bare = s.idOf(await s.raise({ body: "Rename?", options: ["yes", "no"] }));
		expect(answerOrchestratorQuestion(ledger, { id: bare }, { answer: "yes", mirrorBody: "x" })).toMatchObject({ about: null, mirrorId: null });
		expect(ledger.question(bare)!.state).toBe("answered");
		const ghost = ledger.raiseQuestion({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: STANDING_SLICE_ID, body: "x?", options: ["a", "b"] });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: questionSubjectBody(ghost, "wl-gone000000000") });
		expect(() => answerOrchestratorQuestion(ledger, { id: ghost }, { answer: "a", mirrorBody: "x" })).toThrow(`${ghost} is about wl-gone000000000, which is not in the ledger`);
		expect(ledger.question(ghost)!.state).toBe("open");
	});

	test("a withdrawal with `cancel` never cancels the standing slice: it replans, the slice is open, and a second question is raised", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const s = surface(path);
		const q = s.idOf(await s.raise({ body: "Now or later?", options: ["now", "later"], about: wl }));
		expect(interpret(ledger, `withdraw ${q}`)).toEqual({ kind: "withdraw", workloadId: STANDING_WORKLOAD_ID, questionId: q, then: "replan" });
		const receipt = apply(ledger, { kind: "withdraw", workloadId: STANDING_WORKLOAD_ID, questionId: q, then: "cancel" });
		expect(receipt).toMatch(new RegExp(`^withdrew the orchestrator's ${q} \\(withdrawal in-\\S+, then replan\\); the standing slice stays open$`));
		const row = ledger.question(q)!;
		expect(row.state).toBe("withdrawn");
		expect(ledger.instructions(STANDING_WORKLOAD_ID).find((i) => i.id === row.resolved_by)).toMatchObject({ kind: "withdrawal", disposition: "replan" });
		expect(ledger.slice(STANDING_SLICE_ID)!.state).toBe("open");
		expect(ledger.instructions(wl)).toEqual([]);
		const q2 = s.idOf(await s.raise({ body: "Again?", options: ["yes", "no"], about: wl }));
		expect(ledger.question(q2)).toMatchObject({ state: "open", slice_id: STANDING_SLICE_ID });
		expect((await s.say(`withdraw ${q2}`))[0]).toContain("the standing slice stays open");
		expect(ledger.slice(STANDING_SLICE_ID)!.state).toBe("open");
	});
});

describe("Jo's input as the answer's receipt (fix round 1, B1)", () => {
	/** Jo types `text` (OMP's `input`, then the turn's prompt): the notices of that turn. */
	const type = async (s: ReturnType<typeof surface>, text: string, source = "interactive"): Promise<string[]> => {
		await s.f.emit("input", { text, source }, s.ctx);
		return s.say(text);
	};
	const inputIdOf = (lines: string[]): string => {
		const m = /^Jo's words above are input (in-\S+):/.exec(lines.join("\n"));
		if (!m) throw new Error(`no receipt in ${JSON.stringify(lines)}`);
		return m[1]!;
	};
	const record = async (s: ReturnType<typeof surface>, params: Record<string, unknown>) =>
		(await s.f.tool("orchestrator_record_instruction").execute("1", { reading: "use the drafted line", ...params }, undefined, undefined, s.ctx)).content[0]!.text;

	test("prose Jo typed while a question is open is written as an input row first, its id echoed; the recorder answers the row with that input's bytes and keeps the reading apart; without an input, with one not Jo's, or with one already spent it records nothing", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		// Nothing in flight (no question, no workload besides the standing one): prose is not a receipt.
		const idle = surface(tempLedger().path);
		expect(await type(idle, "hello there")).toEqual([]);
		const s = surface(path);
		// An open workload: Jo's prose is a receipt the instruction path spends, body = Jo's bytes; the next prompt is a new one.
		const hello = inputIdOf(await type(s, "hello there, start with the README"));
		expect(ledger.instructions(STANDING_WORKLOAD_ID)).toMatchObject([{ id: hello, body: "hello there, start with the README" }]);
		expect(await record(s, { workloadId: wl })).toBe("Jo's words are the input row the surface named (`Jo's words above are input in-…`): pass inputId, and when none was named there is no receipt; nothing was recorded.");
		expect(await record(s, { workloadId: wl, inputId: "in-forged" })).toBe("in-forged is not an input Jo typed at the surface; nothing was recorded.");
		expect(await record(s, { workloadId: wl, inputId: hello, reading: "start with the README" })).toMatch(new RegExp(`^Recorded instruction in-\\S+ on ${wl} from Jo's input ${hello} \\(author jo, channel surface; reading en-\\S+\\): "hello there, start with the README" — start with the README$`));
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual(['Jo: "hello there, start with the README" — reading: start with the README']);
		expect(await record(s, { workloadId: wl, inputId: hello })).toBe(`${hello} already instructed ${wl}, and one input is recorded once; nothing was recorded.`);
		expect(ledger.instructions(wl)).toHaveLength(1);
		const q = s.idOf(await s.raise({ body: "Keep the draft, or rewrite it?", options: ["keep", "rewrite"], about: wl }));
		const q2 = s.idOf(await s.raise({ body: "Ship tonight?", options: ["yes", "no"], about: wl }));
		await Bun.sleep(2); // the receipt must postdate the question: a tie in the millisecond stamp is refused
		// Not typed by Jo (no `input`, or one from an extension): no row, and the recorder has nothing to bind.
		expect(await s.say("keep it, the draft is fine")).toEqual([]);
		expect(await type(s, "keep it, the draft is fine", "extension")).toEqual([]);
		expect(ledger.instructions(STANDING_WORKLOAD_ID).map((i) => i.id)).toEqual([hello]);
		expect(await record(s, { questionId: q, words: "keep it, the draft is fine" })).toContain("pass inputId, and when none was named there is no receipt; nothing was recorded.");
		expect(await record(s, { questionId: q, inputId: "in-forged", words: "keep" })).toBe("in-forged is not an input Jo typed at the surface; nothing was recorded.");
		expect(ledger.question(q)!.state).toBe("open");
		// Jo typed it: the row exists before the model runs, body = Jo's bytes, and the turn names it.
		const lines = await type(s, "keep it, the draft is fine  ");
		const input = inputIdOf(lines);
		expect(lines).toHaveLength(1); // the two open rows in the ledger's order (same-millisecond stamps sort by id)
		expect(lines[0]).toMatch(new RegExp(`^Jo's words above are input ${input}: if they answer (${q} or ${q2}|${q2} or ${q}), record that with orchestrator_record_instruction naming questionId and inputId ${input}; if they instruct you about an open workload, record that with orchestrator_record_instruction naming workloadId and inputId ${input} \\(Jo's words are read from the row, never from your parameters\\); if they do neither, record nothing$`));
		expect(ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => i.id === input)).toMatchObject([{ kind: "instruction", author: "jo", channel: "surface", created_by: SURFACE_BY, question_id: null, body: "keep it, the draft is fine" }]);
		expect(s.f.entries.filter((e) => e.type === "surface-jo-input")).toEqual([{ type: "surface-jo-input", data: { id: hello } }, { type: "surface-jo-input", data: { id: input } }]);
		// The model's `words` are not Jo's words: the answer is the row's body.
		const r = await record(s, { questionId: q, inputId: input, words: "rewrite everything", reading: "keep the draft as is" });
		expect(r).toMatch(new RegExp(`^Answered ${q} with Jo's input ${input} \\(answer in-\\S+, reading en-\\S+\\); instruction in-\\S+ on ${wl} \\(author jo, channel surface\\): "keep it, the draft is fine" — keep the draft as is$`));
		const row = ledger.question(q)!;
		expect(row.state).toBe("answered");
		expect(ledger.instructions(STANDING_WORKLOAD_ID).find((i) => i.id === row.resolved_by)).toMatchObject({ kind: "answer", question_id: q, author: "jo", channel: "surface", body: "keep it, the draft is fine" });
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual(['Jo: "hello there, start with the README" — reading: start with the README', `Jo: "keep it, the draft is fine" — reading: keep the draft as is (answers ${q})`]);
		expect(ledger.entries(STANDING_WORKLOAD_ID, "assumption").map((e) => e.body)).toContain(`reading: keep the draft as is (input ${input} answers ${q})`);
		// One input answers one question: a second question cannot spend it, and a resolved question takes nothing.
		expect(await record(s, { questionId: q2, inputId: input })).toBe(`${input} already answered ${q}, and one input is recorded once; nothing was recorded.`);
		expect(await record(s, { workloadId: wl, inputId: input })).toBe(`${input} already answered ${q}, and one input is recorded once; nothing was recorded.`);
		expect(await record(s, { questionId: q, inputId: input })).toContain(`${q} is already answered`);
		expect(ledger.question(q2)!.state).toBe("open");
		// An input typed before the question was raised cannot answer it.
		expect(await record(s, { questionId: q2, inputId: input })).not.toContain("Answered");
		const early = ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: "yes", author: "jo", channel: "surface" });
		const q3 = s.idOf(await s.raise({ body: "Really?", options: ["yes", "no"] }));
		expect(await record(s, { questionId: q3, inputId: early })).toBe(`${early} was not typed after ${q3} was raised, so it cannot answer it; nothing was recorded.`);
		// A workload that is not the question's subject is refused; a closed subject leaves the question open (B4).
		expect(await record(s, { questionId: q2, inputId: early, workloadId: "wl-other" })).toBe(`${q2} is about ${wl}, not wl-other; nothing was recorded.`);
		ledger.closeWorkload(wl, { by: "lane-a" });
		const late = inputIdOf(await type(s, "yes, ship it"));
		expect(await record(s, { questionId: q2, inputId: late })).toMatch(new RegExp(`^${q2} is about ${wl}, which is closed \\(.+\\): the answer was not recorded and ${q2} stays open; \`withdraw ${q2}\` withdraws it; nothing was recorded.$`));
		expect(ledger.question(q2)!.state).toBe("open");
		expect(ledger.instructions(wl)).toHaveLength(2);
	});
});

describe("restart", () => {
	test("a surface started over a ledger with open orchestrator questions renders each at its wake, with id and options", async () => {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const first = surface(path);
		const q1 = first.idOf(await first.raise({ body: "Now or later?", options: ["now", "later"], about: wl }));
		const q2 = first.idOf(await first.raise({ body: "Rename me?", options: ["yes", "no"] }));
		ledger.close();
		const again = surface(path);
		const wake = await again.wake();
		expect(wake).toContain(`the orchestrator asked you (${q1}, about ${wl}): Now or later? — answer with one word: now / later (or \`withdraw\`)`);
		expect(wake).toContain(`the orchestrator asked you (${q2}): Rename me? — answer with one word: yes / no (or \`withdraw\`)`);
		const check = Ledger.open(path, { create: false, backup: false, backupOnOpen: false });
		expect(check.slices(STANDING_WORKLOAD_ID).map((s) => [s.id, s.state])).toEqual([[STANDING_SLICE_ID, "paused"]]);
		check.close();
	});
});
