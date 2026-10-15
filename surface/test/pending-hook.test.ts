// A `pending` block pasted back at the surface (PLAN wl-mv7gidggnlkem8; surface/extensions/surface-input.ts):
// on both input sources OMP emits (interactive and rpc), a paste holding nothing to apply — the block's
// own text alone, the block with Jo's words and no command, an older layout's block, or a copy gone
// stale — is consumed in the `input` row (handled, no turn, nothing applied, no Jo-input row, Jo's
// words reported back); a paste with commands applies them and hands on only Jo's own words; plain
// prose, metadata-looking lines included, still becomes Jo's input row when typed equals the prompt.
// A host that sends no `input` gets the same verdicts from before_agent_start, with no Jo-input row.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { pendingBlock, pendingItems, pendingWaits } from "../src/pending";
import { promptWaitBody } from "../src/signals";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, nameWork, notices, raiseAsked, tmp } from "./helpers";

function env(): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}
const open = (e: Record<string, string>) => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });

/**
 * A surface over a ledger with one described workload: an asked question offering `options`, and a
 * reserved request when `reserved`. `copy` is the block as /copy takes it from the shown message.
 */
function surface(options: string[], reserved = false) {
	const e = env();
	const l = open(e);
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	nameWork(l, wl, SURFACE_BY, "Feed header offset");
	const sl = l.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	const en = reserved ? l.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" }) : null;
	const q = raiseAsked(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options, ask: "Which token name should replace the header offset?" });
	const copy = pendingBlock(pendingItems(l), pendingWaits(l)).text;
	l.close();
	const f = fakePi();
	orchestratorSurface(f.pi, e);
	const ctx = ctxOf();
	notices.length = 0;
	/** What the ledger holds now: the question's state, the reserved request's decision count, Jo's instructions, and the standing workload's input rows. */
	const state = () => {
		const c = open(e);
		try {
			return {
				question: c.question(q)!.state,
				instructions: c.instructions(wl).map((i) => i.body),
				inputs: c.inFlight().some((w) => w.workload.id === STANDING_WORKLOAD_ID) ? c.instructions(STANDING_WORKLOAD_ID).map((i) => i.body) : [],
			};
		} finally {
			c.close();
		}
	};
	const joInputs = () => f.entries.filter((x) => x.type === "surface-jo-input");
	return { e, f, ctx, wl, sl, en, q, copy, state, joInputs };
}

const SOURCES = ["interactive", "rpc"] as const;
/** One complete question entry without the block heading or fence. */
const cardOf = (copy: string): string => copy.split("```text\n")[1]!.split("\n```")[0]!.split("\n\n")[0]!;
/** Add a real prompt wait and return its current, headerless card. */
function waitCard(s: { e: Record<string, string>; wl: string; sl: string }): string {
	const l = open(s.e);
	try {
		l.enqueue({ by: "lane-a", workloadId: s.wl, sliceId: s.sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("ask", "c7", "s1", "which branch?") });
		return pendingWaits(l)[0]!;
	} finally {
		l.close();
	}
}

describe("a pasted-back pending block consumed in the input row, on both sources", () => {
	for (const source of SOURCES) {
		test(`${source}: the block's own text alone is consumed: handled, nothing applied, no Jo-input row`, async () => {
			const s = surface(["go on", "stop here"]);
			expect(s.copy).not.toMatch(/^\S+ q-/m); // no pasteable command in it
			const before = s.state();
			expect(await s.f.emit("input", { text: s.copy, source }, s.ctx)).toEqual({ handled: true });
			// one verdict, shown and recorded once; nothing applied, nothing handed on as Jo's words
			expect(notices).toHaveLength(1);
			expect(s.f.entries.filter((x) => x.type === "surface-input")).toHaveLength(1);
			expect(s.state()).toEqual(before);
			expect(s.joInputs()).toEqual([]);
		});
		test(`${source}: complete headerless question and wait cards are consumed with no Jo input`, async () => {
			for (const kind of ["question", "wait"] as const) {
				const s = surface(["go on", "stop here"]);
				const card = kind === "question" ? cardOf(s.copy) : waitCard(s);
				const before = s.state();
				expect(await s.f.emit("input", { text: card, source }, s.ctx)).toEqual({ handled: true });
				expect(s.state()).toEqual(before);
				expect(s.joInputs()).toEqual([]);
				expect(s.f.entries.filter((x) => x.type === "surface-input")).toHaveLength(1);
				expect(notices).toHaveLength(1);
			}
		});

		test(`${source}: mixed or stale headerless cards refuse before a turn or Jo receipt`, async () => {
			const mixed = surface(["go on", "stop here"]);
			const card = cardOf(mixed.copy);
			const before = mixed.state();
			expect(await mixed.f.emit("input", { text: `${card}\nplease check the footer`, source }, mixed.ctx)).toEqual({ handled: true });
			expect(notices.some((n) => n.includes("no answer line"))).toBe(true);
			expect(mixed.state()).toEqual(before);
			expect(mixed.joInputs()).toEqual([]);

			const stale = surface(["go on", "stop here"]);
			const old = cardOf(stale.copy);
			const l = open(stale.e);
			l.answerQuestion(stale.q, { by: SURFACE_BY, answer: "go on", author: "jo", channel: "surface" });
			l.close();
			const was = stale.state();
			expect(await stale.f.emit("input", { text: old, source }, stale.ctx)).toEqual({ handled: true });
			expect(notices.some((n) => n.includes("no longer match what pending shows"))).toBe(true);
			expect(stale.state()).toEqual(was);
			expect(stale.joInputs()).toEqual([]);
		});

		test(`${source}: the block with Jo's words and no command is refused, the words reported back and not passed on`, async () => {
			const s = surface(["go on", "stop here"]);
			const n = s.copy.split("\n").length + 1;
			const before = s.state();
			expect(await s.f.emit("input", { text: `${s.copy}\nplease check the footer too`, source }, s.ctx)).toEqual({ handled: true });
			expect(notices).toHaveLength(2);
			expect(notices[0]).toContain("no answer line");
			// Jo's held words are reported back on their own line, naming where they were
			expect(notices[1]).toStartWith(`line ${n} `);
			expect(notices[1]).toContain('"please check the footer too"');
			expect(s.state()).toEqual(before);
			expect(s.joInputs()).toEqual([]);
		});

		test(`${source}: an older layout's block is refused whole: its commands not applied, nothing passed on`, async () => {
			const s = surface(["left", "right"], true);
			const old = [
				"## pending: 2 things wait on you (paste the block back as is, or any of its lines; change a line's first word to pick another option)",
				"```text",
				`approve ${s.en}  # reserved action: push main — on fix the feed header offset · no recommendation recorded · also: deny`,
				`left ${s.q}  # Which — on fix the feed header offset · no recommendation recorded · also: right / withdraw`,
				"```",
			].join("\n");
			const before = s.state();
			expect(await s.f.emit("input", { text: old, source }, s.ctx)).toEqual({ handled: true });
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("line 1 heads a pending block");
			expect(s.state()).toEqual(before);
			expect(s.joInputs()).toEqual([]);
		});

		test(`${source}: a copy gone stale (its row answered since) is refused whole, the other row's command not applied`, async () => {
			const s = surface(["left", "right"], true);
			const l = open(s.e);
			l.answerQuestion(s.q, { by: SURFACE_BY, answer: "right", author: "jo", channel: "surface" });
			l.close();
			const before = s.state();
			expect(await s.f.emit("input", { text: s.copy, source }, s.ctx)).toEqual({ handled: true });
			expect(notices[0]).toContain("no longer match what pending shows");
			// the reserved request's approve was not applied either: no instruction for it
			expect(s.state()).toEqual(before);
			expect(s.joInputs()).toEqual([]);
		});

		test(`${source}: the block with commands and Jo's words goes on to the turn: the commands apply, only Jo's words are an instruction`, async () => {
			const s = surface(["left", "right"]);
			const text = `${s.copy}\nthen ship it`;
			expect(await s.f.emit("input", { text, source }, s.ctx)).toBeUndefined();
			await s.f.emit("before_agent_start", { prompt: text, systemPrompt: [] }, s.ctx);
			expect(s.state().question).toBe("answered");
			expect(s.state().instructions).toEqual(["left"]);
			const handedOn = notices.filter((m) => m.includes("an instruction for you"));
			expect(handedOn).toHaveLength(1);
			expect(handedOn[0]).toEndWith('"then ship it"');
			expect(s.joInputs()).toEqual([]);
		});

		test(`${source}: plain prose, and metadata-looking lines with no command or heading, are Jo's input row when typed equals the prompt`, async () => {
			const copy = surface(["left", "right"]).copy;
			const fragment = copy.split("\n").filter((l) => l.startsWith("# Work:") || l.startsWith("# Question:")).join("\n");
			expect(fragment.split("\n")).toHaveLength(2);
			for (const text of ["please look at the footer\nand the header too", fragment]) {
				const s = surface(["left", "right"]);
				expect(await s.f.emit("input", { text, source }, s.ctx)).toBeUndefined();
				await s.f.emit("before_agent_start", { prompt: text, systemPrompt: [] }, s.ctx);
				expect(s.joInputs()).toHaveLength(1);
				expect(s.state().inputs).toEqual([text]);
				expect(s.state().question).toBe("open");
			}
		});
	}

	test("the empty block alone, typed, is consumed too", async () => {
		const e = env();
		open(e).close();
		const f = fakePi();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		notices.length = 0;
		expect(await f.emit("input", { text: "## pending: nothing is waiting on you", source: "interactive" }, ctx)).toEqual({ handled: true });
		expect(notices).toHaveLength(1);
	});
});

describe("a host that sends no input event: before_agent_start gives the same verdicts, with no Jo-input row", () => {
	test("the block's own text alone, the block with Jo's words, and a stale copy: each echoed, nothing applied, no input row", async () => {
		const only = surface(["go on", "stop here"]);
		const before = only.state();
		await only.f.emit("before_agent_start", { prompt: only.copy, systemPrompt: [] }, only.ctx);
		expect(notices.some((m) => m.includes("nothing to apply"))).toBe(true);
		expect(only.state()).toEqual(before);
		expect(only.joInputs()).toEqual([]);

		const mixed = surface(["go on", "stop here"]);
		await mixed.f.emit("before_agent_start", { prompt: `${mixed.copy}\nplease check the footer too`, systemPrompt: [] }, mixed.ctx);
		expect(notices.some((m) => m.includes("no answer line"))).toBe(true);
		expect(notices.some((m) => m.includes('"please check the footer too"'))).toBe(true);
		expect(mixed.state().inputs).toEqual([]);
		expect(mixed.joInputs()).toEqual([]);

		const stale = surface(["left", "right"], true);
		const l = open(stale.e);
		l.answerQuestion(stale.q, { by: SURFACE_BY, answer: "right", author: "jo", channel: "surface" });
		l.close();
		const was = stale.state();
		await stale.f.emit("before_agent_start", { prompt: stale.copy, systemPrompt: [] }, stale.ctx);
		expect(notices.some((m) => m.includes("no longer match what pending shows"))).toBe(true);
		expect(stale.state()).toEqual(was);
		expect(stale.joInputs()).toEqual([]);
	});

	test("headerless question and wait cards take the fallback verdict without a Jo receipt", async () => {
		for (const kind of ["question", "wait"] as const) {
			const s = surface(["go on", "stop here"]);
			const card = kind === "question" ? cardOf(s.copy) : waitCard(s);
			const before = s.state();
			await s.f.emit("before_agent_start", { prompt: card, systemPrompt: [] }, s.ctx);
			expect(notices.some((n) => n.includes("nothing to apply"))).toBe(true);
			expect(s.state()).toEqual(before);
			expect(s.joInputs()).toEqual([]);
		}
	});
});
