// Jo's typed prose is never dropped silently (PLAN wl-mv65nllu5g181s, Tests): every message Jo
// types (OMP's `input`, source interactive or rpc) waits on a FIFO until the turn whose prompt is
// its own words takes it, so two messages sent back to back both get input rows; a joined OMP
// delivery is split into one row per message; a prompt that matches more than one way, an entry no
// turn takes, and the same words arriving after their entry was discarded are each warned about
// and get no row. Driven through the fake host and a real ledger in a temp dir, with an open
// workload besides the standing one in every case, so the prose path writes rows throughout.
import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import orchestratorSurface from "../index";
import { surfaceSession } from "../src/session";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { ctxOf, fakePi, notified, notices, tempLedger, timeouts, tmp } from "./helpers";

type Started = { systemPrompt: string[]; messages: { customType: string; content: string }[] };

const A = "please move the header offset into a token";
const B = "and rerun the feed tests after that";
const C = "then open the pull request for review";

/** A surface over a fresh ledger holding one open workload besides the standing one. */
function surface() {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const f = fakePi();
	orchestratorSurface(f.pi, env);
	const ctx = ctxOf();
	const s = () => surfaceSession(ctx, env);
	/** What reached the model in a turn's context: every turn's surface message so far. */
	const model: string[] = [];
	const input = (text: string, source = "interactive") => f.emit("input", { text, source }, ctx);
	const start = async (prompt: string): Promise<void> => {
		const r = (await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as Started;
		model.push(...r.messages.map((m) => m.content));
	};
	/** OMP's agent_end, then the one-macrotask deferral it schedules. */
	const end = async (): Promise<void> => {
		const n = timeouts.length;
		await f.emit("agent_end", { willContinue: false }, ctx);
		for (const t of timeouts.slice(n)) t.fn();
	};
	/** Everything the model has been or will be given: the turns' surface messages and the notices queued for the next turn. */
	const modelSaw = (): string => [...model, ...s().notices].join("\n");
	const joRows = () => ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => i.kind === "instruction" && i.author === "jo");
	const allJoInstructions = () => [...ledger.instructions(STANDING_WORKLOAD_ID), ...ledger.instructions(wl)].filter((i) => i.author === "jo");
	const raise = async (options: string[]): Promise<string> => {
		const text = (await f.tool("orchestrator_raise_question").execute("1", { body: "Ship the header fix?", options, about: wl }, undefined, undefined, ctx)).content[0]!.text;
		const m = /^Raised question (q-\S+)/.exec(text);
		if (!m) throw new Error(`not raised: ${text}`);
		return m[1]!;
	};
	/** A wake turn: numbers the needs-you lines. */
	const wake = async (): Promise<void> => {
		await f.emit("session_start", { type: "session_start" }, ctx);
		await start("hi");
	};
	const record = async (inputId: string) =>
		(await f.tool("orchestrator_record_instruction").execute("1", { workloadId: wl, inputId, reading: "do it" }, undefined, undefined, ctx)).content[0]!.text;
	return { ledger, wl, f, ctx, s, input, start, end, modelSaw, joRows, allJoInstructions, raise, wake, record };
}

const echoes = (): string[] => notices.filter((n) => n.startsWith("Jo's words above are input "));
const idsOf = (lines: string[]): string[] => lines.map((l) => /^Jo's words above are input (in-\S+):/.exec(l)![1]!);
const warnings = (): string[] => notified.filter((n) => n.type === "warning").map((n) => n.message);
const infos = (): string[] => notified.filter((n) => n.type === "info").map((n) => n.message);
const missed = (words: string): string => `Jo's message "${words}" got no input row (typed input not matched to any prompt): Jo re-sends it, or answers by <option> q-…`;
const LATE = "these words match Jo's message warned about above; they have no input row: Jo re-sends it";
const AMBIGUOUS = "this prompt matches more than one way Jo's typed messages could have been delivered; no input row: re-send it";

beforeEach(() => {
	notices.length = 0;
	notified.length = 0;
});

describe("red before: every typed message is a row or a warning", () => {
	test("T1 back-to-back: two prose messages sent before the first is dequeued both get rows, two distinct echoes, each spent on its own (main: B found the slot empty)", async () => {
		const t = surface();
		await t.input(A);
		await t.input(B);
		await t.start(A);
		await t.start(B);
		expect(t.joRows().map((r) => r.body)).toEqual([A, B]);
		const ids = idsOf(echoes());
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		expect(t.joRows().map((r) => r.id)).toEqual(ids);
		expect(t.f.entries.filter((e) => e.type === "surface-jo-input")).toEqual(ids.map((id) => ({ type: "surface-jo-input", data: { id } })));
		for (const id of ids) expect(await t.record(id)).toMatch(new RegExp(`^Recorded instruction in-\\S+ on ${t.wl} from Jo's input ${id} `));
		expect(t.ledger.instructions(t.wl).map((i) => i.body)).toEqual([`Jo: "${A}" — reading: do it`, `Jo: "${B}" — reading: do it`]);
		expect(warnings()).toEqual([]);
	});

	for (const order of ["command first in the queue", "prose first in the queue (the incident's order)"]) {
		test(`T2 a command turn between, ${order}: the command applies and the prose still gets its row (main: the command turn cleared the slot)`, async () => {
			const t = surface();
			const q = await t.raise(["approve", "revise"]);
			await t.wake();
			notices.length = 0;
			notified.length = 0;
			if (order.startsWith("command")) {
				await t.input(A);
				await t.input("1 approve");
			} else {
				await t.input("1 approve");
				await t.input(A);
			}
			await t.start("1 approve");
			await t.start(A);
			expect(t.ledger.question(q)!.state).toBe("answered");
			expect(notices.some((n) => n.includes(`answered the orchestrator's ${q} with "approve"`))).toBe(true);
			expect(t.joRows().map((r) => r.body)).toEqual([A]);
			expect(echoes()).toHaveLength(1);
			expect(warnings()).toEqual([]);
		});
	}

	test("T3 unmatched: a typed message no prompt matches is warned once to Jo and once to the model at the idle agent_end, and gets no row (main: silence)", async () => {
		const t = surface();
		const long = "please move the header offset into a design token today";
		await t.input(long);
		await t.start(`${long}, edited`);
		expect(warnings()).toEqual([]);
		await t.end();
		const line = missed("please move the header offset into a design…");
		expect(warnings()).toEqual([line]);
		expect(t.s().notices).toEqual([line]);
		expect(t.joRows()).toEqual([]);
		expect(t.s().typed).toEqual([]);
	});

	test("T4 joined: an OMP `all` delivery of two typed messages writes one row, one entry and one singular echo per message, never a merged row; joined with a command line it warns and writes no Jo row (main: no row)", async () => {
		const t = surface();
		await t.input(A);
		await t.input(B);
		await t.start(`${A}\n\n${B}`);
		expect(t.joRows().map((r) => r.body)).toEqual([A, B]);
		expect(t.f.entries.filter((e) => e.type === "surface-jo-input")).toHaveLength(2);
		const lines = echoes();
		expect(lines).toHaveLength(2);
		expect(new Set(idsOf(lines)).size).toBe(2);
		expect(t.joRows().some((r) => r.body.includes("\n"))).toBe(false);
		expect(warnings()).toEqual([]);

		const u = surface();
		const q = await u.raise(["approve", "revise"]);
		await u.wake();
		notices.length = 0;
		notified.length = 0;
		await u.input(A);
		await u.input("1 approve");
		await u.start(`${A}\n\n1 approve`);
		expect(u.ledger.question(q)!.state).toBe("answered");
		expect(warnings()).toContain(
			"2 messages Jo typed arrived joined as one prompt (OMP steeringMode all); none got an input row: re-send the plain-words ones one at a time, or set steeringMode to one-at-a-time",
		);
		expect(u.joRows()).toEqual([]);
		expect(u.f.entries.filter((e) => e.type === "surface-jo-input")).toEqual([]);
		expect(u.s().typed).toEqual([]);
	});

	test("T6 a typed message that started no turn is warned at the take of the next one, which gets its row (main: silence)", async () => {
		const t = surface();
		const refused = "this one never reached a turn at all";
		await t.input(refused);
		await t.input(B);
		await t.start(B);
		expect(warnings()).toEqual([missed(refused)]);
		expect(t.joRows().map((r) => r.body)).toEqual([B]);
		expect(t.s().discarded).toEqual([refused]);
	});

	test("T7 overtaken: a message a newer prose take passed is warned and discarded there; arriving later it gets no row and the late-arrival warning; the idle agent_end adds nothing (main: silence)", async () => {
		const t = surface();
		await t.input(A);
		await t.input(B);
		await t.start(B);
		expect(warnings()).toEqual([missed(A)]);
		await t.start(A);
		expect(warnings()).toEqual([missed(A), LATE]);
		expect(t.joRows().map((r) => r.body)).toEqual([B]);
		await t.end();
		expect(warnings()).toEqual([missed(A), LATE]);
		expect(t.modelSaw()).toContain(LATE);
	});

	test("T9 ambiguity: a prompt that is one typed entry and also a joined run of two others takes nothing, warns, writes no row; the idle sweep warns each of the three (main: silence)", async () => {
		const t = surface();
		await t.input(`${A}\n\n${B}`);
		await t.input(A);
		await t.input(B);
		await t.start(`${A}\n\n${B}`);
		expect(warnings()).toEqual([AMBIGUOUS]);
		expect(t.joRows()).toEqual([]);
		expect(t.s().typed).toHaveLength(3);
		await t.end();
		expect(warnings()).toEqual([AMBIGUOUS, missed("please move the header offset into a token…"), missed(A), missed(B)]);
		expect(t.joRows()).toEqual([]);
		expect(t.s().typed).toEqual([]);
	});

	test("T10 same-run steal: a message passed by a newer prose take cannot be taken by an untyped identical prompt later in the same busy run (main: silence)", async () => {
		const t = surface();
		await t.input(A);
		await t.input(B);
		t.ctx.host.idle = false;
		await t.start(B);
		expect(warnings()).toEqual([missed(A)]);
		await t.start(A); // an extension's steer with Jo's exact words, no `input`
		expect(t.joRows().map((r) => r.body)).toEqual([B]);
		expect(warnings()).toEqual([missed(A), LATE]);
	});

	test("T11 a skipped slash entry gets the softer info line naming only the command; its arguments reach no notify, no model notice and no session entry (main: silence)", async () => {
		const t = surface();
		await t.input("/explain this");
		await t.input(B);
		await t.start(B);
		const soft = `Jo's input "/explain …" got no input row; if OMP ran it as a command that is expected, if it was a message Jo re-sends it`;
		expect(infos()).toContain(soft);
		expect(warnings()).toEqual([]);
		expect(t.modelSaw()).toContain(soft);
		expect(t.joRows().map((r) => r.body)).toEqual([B]);

		await t.input("/login sekrit-code-123");
		await t.input(C);
		await t.start(C);
		expect(infos()).toContain(`Jo's input "/login …" got no input row; if OMP ran it as a command that is expected, if it was a message Jo re-sends it`);
		expect(t.joRows().map((r) => r.body)).toEqual([B, C]);
		await t.start("next turn");
		expect(notified.some((n) => n.message.includes("sekrit-code-123"))).toBe(false);
		expect(t.modelSaw()).not.toContain("sekrit-code-123");
		expect(JSON.stringify(t.f.entries)).not.toContain("sekrit-code-123");
		expect(t.s().discarded).toEqual([]);
	});
});

describe("invariants the FIFO must keep", () => {
	test("T5 an untyped prompt with nothing typed is silent", async () => {
		const t = surface();
		await t.start(A);
		await t.end();
		expect(notified).toEqual([]);
		expect(t.joRows()).toEqual([]);
	});

	test("T5 TUI `!ls` and `$ print(1)` are swept silently; `$HOME is set` is prose and warned; an rpc `!ls` is not run locally and is warned", async () => {
		const t = surface();
		await t.input("!ls");
		await t.input("$ print(1)");
		await t.input("$HOME is set");
		await t.input("!!git status", "rpc");
		await t.start("something else entirely");
		await t.end();
		expect(warnings()).toEqual([missed("$HOME is set"), missed("!!git status")]);
		expect(infos()).toEqual([]);
		expect(t.s().typed).toEqual([]);
	});

	test("T5 agent_end while busy or with messages queued sweeps nothing, and the queued entry gets its row at its later turn", async () => {
		const t = surface();
		await t.input(A);
		await t.start("an earlier queued prompt");
		t.ctx.host.idle = false;
		await t.end();
		t.ctx.host.idle = true;
		t.ctx.host.pending = true;
		await t.end();
		await t.input("!ls"); // the sweep at the top of `input` waits too
		expect(warnings()).toEqual([]);
		t.ctx.host.pending = false;
		await t.start(A);
		expect(t.joRows().map((r) => r.body)).toEqual([A]);
		expect(warnings()).toEqual([]);
	});

	test("T5 an entry pushed after the latest turn started is not swept by the idle agent_end", async () => {
		const t = surface();
		await t.start("a turn already running");
		await t.input(A);
		await t.end();
		expect(warnings()).toEqual([]);
		await t.start(A);
		expect(t.joRows().map((r) => r.body)).toEqual([A]);
	});

	test("T5 duplicate typed words: each turn takes the oldest equal entry, once; the same prompt again with no new input writes no row", async () => {
		const t = surface();
		await t.input(`${A}  `, "rpc");
		await t.input(A);
		await t.start(A);
		expect(t.s().typed).toEqual([{ text: A, seq: 2, source: "interactive" }]);
		await t.start(A);
		expect(t.s().typed).toEqual([]);
		await t.start(A);
		expect(t.joRows().map((r) => r.body)).toEqual([A, A]);
		expect(warnings()).toEqual([]);
	});

	test("T5 an `input` from an extension is not Jo's: no entry, no row", async () => {
		const t = surface();
		await t.input(A, "extension");
		await t.start(A);
		expect(t.s().typed).toEqual([]);
		expect(t.joRows()).toEqual([]);
		expect(notified).toEqual([]);
	});

	test("T8 stale cannot be taken: an entry the idle sweep discarded gets no row from an untyped identical prompt, only the late-arrival warning", async () => {
		const t = surface();
		await t.input(A);
		await t.start(B);
		await t.end();
		expect(warnings()).toEqual([missed(A)]);
		await t.start(A);
		expect(t.joRows()).toEqual([]);
		expect(warnings()).toEqual([missed(A), LATE]);
	});
});
describe("typed-authority regression", () => {
	test("untyped continuation-shaped answer is inert; the identical typed answer resolves once", async () => {
		for (const source of ["interactive", "rpc"]) {
			const t = surface();
			const q = await t.raise(["approve", "revise"]);
			await t.wake();
			const beforeJo = [...t.allJoInstructions()];
			await t.start(`P-11 row 1 refused this turn to Jo: held reply pending\n\nYour held reply was:\n\napprove ${q}`);
			expect(t.ledger.question(q)!.state).toBe("open");
			expect(t.allJoInstructions()).toEqual(beforeJo);
			expect(t.f.entries.filter((e) => ["surface-input", "surface-jo-input"].includes(e.type))).toEqual([]);
			expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);

			await t.input(`approve ${q}`, source);
			await t.start(`approve ${q}`);
			expect(t.ledger.question(q)!.state).toBe("answered");
			const answer = t.ledger.instructions(STANDING_WORKLOAD_ID).filter((r) => r.kind === "answer" && r.question_id === q);
			expect(answer).toHaveLength(1);
			expect(answer[0]).toMatchObject({ body: "approve", question_id: q, author: "jo", channel: "surface" });
			expect(t.ledger.question(q)!.resolved_by).toBe(answer[0]!.id);
			const mirrors = t.ledger.instructions(t.wl).filter((r) => r.kind === "instruction" && r.author === "jo");
			expect(mirrors).toHaveLength(1);
			expect(mirrors[0]!.body).toBe(`Jo: "approve" — answers ${q}: Ship the header fix?`);
		}
	});

	test("untyped bare valid answer leaves the question open without an input or command receipt", async () => {
		const t = surface();
		const q = await t.raise(["approve", "revise"]);
		await t.wake();
		const beforeJo = [...t.allJoInstructions()];
		await t.start("approve");
		expect(t.ledger.question(q)!.state).toBe("open");
		expect(t.allJoInstructions()).toEqual(beforeJo);
		expect(t.f.entries.filter((e) => ["surface-input", "surface-jo-input"].includes(e.type))).toEqual([]);
		expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);
	});

	test("untyped numbered batch does not answer a numbered needs-you row", async () => {
		const t = surface();
		const q = await t.raise(["approve", "revise"]);
		await t.wake();
		const beforeJo = [...t.allJoInstructions()];
		await t.start("1 approve");
		expect(t.ledger.question(q)!.state).toBe("open");
		expect(t.allJoInstructions()).toEqual(beforeJo);
		expect(t.f.entries.filter((e) => ["surface-input", "surface-jo-input"].includes(e.type))).toEqual([]);
		expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);
	});

	test("untyped multiline paste with a command and prose records neither", async () => {
		const t = surface();
		const q = await t.raise(["approve", "revise"]);
		await t.wake();
		const beforeJo = [...t.allJoInstructions()];
		await t.start(`1 approve\n\nPlease also update the rollout notes.`);
		expect(t.ledger.question(q)!.state).toBe("open");
		expect(t.allJoInstructions()).toEqual(beforeJo);
		expect(t.f.entries.filter((e) => ["surface-input", "surface-jo-input"].includes(e.type))).toEqual([]);
		expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);
	});

	test("untyped workload-changing command leaves mode and Jo instruction collections unchanged", async () => {
		const t = surface();
		const beforeMode = t.ledger.workload(t.wl)!.mode;
		const beforeJo = [...t.allJoInstructions()];
		await t.start(`user-driven ${t.wl}`);
		expect(t.ledger.workload(t.wl)!.mode).toBe(beforeMode);
		expect(t.allJoInstructions()).toEqual(beforeJo);
		expect(t.f.entries.filter((e) => ["surface-input", "surface-jo-input"].includes(e.type))).toEqual([]);
		expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);
	});

	test("extension-sourced command text cannot answer a question", async () => {
		const t = surface();
		const q = await t.raise(["approve", "revise"]);
		await t.wake();
		const beforeJo = [...t.allJoInstructions()];
		await t.input(`approve ${q}`, "extension");
		await t.start(`approve ${q}`);
		expect(t.ledger.question(q)!.state).toBe("open");
		expect(t.allJoInstructions()).toEqual(beforeJo);
		expect(t.f.entries.filter((e) => ["surface-input", "surface-jo-input"].includes(e.type))).toEqual([]);
		expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);
	});

	test("unmatched queued typed prose cannot authorize a command-shaped prompt", async () => {
		const t = surface();
		const q = await t.raise(["approve", "revise"]);
		await t.wake();
		const beforeJo = [...t.allJoInstructions()];
		await t.input("please review this later");
		await t.start(`approve ${q}`);
		expect(t.ledger.question(q)!.state).toBe("open");
		expect(t.allJoInstructions()).toEqual(beforeJo);
		expect(t.f.entries.filter((e) => ["surface-input", "surface-jo-input"].includes(e.type))).toEqual([]);
		expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);
	});

	test("ambiguous FIFO take does not apply a valid answer or consume either typed entry", async () => {
		const t = surface();
		const q = await t.raise(["approve", "revise"]);
		await t.wake();
		const beforeJo = [...t.allJoInstructions()];
		await t.input(`approve ${q}`);
		await t.input("");
		await t.start(`approve ${q}`);
		expect(t.ledger.question(q)!.state).toBe("open");
		expect(t.s().typed).toHaveLength(2);
		expect(t.allJoInstructions()).toEqual(beforeJo);
		expect(t.ledger.entries(t.wl).filter((e) => e.body.startsWith("launch-requested:"))).toEqual([]);
	});
});
