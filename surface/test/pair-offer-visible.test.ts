// PLAN wl-mvb9mw00ycfjeo (Jo's issue 53): every pair offer is its own line, never an option hidden inside a review-limit
// question, and a taken pair hands Jo `as2 lane <workload-id>` on a line of its own.
//   R2  an offered question lists no `pair` among its shown options, and the offer is its own line in needs-you, the
//       pending block (under its answer line, and under its overflow sentence), the ledger render, and the `#n takes:`
//       and `(q-… takes:)` refusals.
//   R3  a pending block pasted back unchanged never applies, refuses or forwards as Jo's words its offer line.
//   R5  a pair answer's echo, through the surface-input extension's single, numbered and paste paths, carries a line that
//       is exactly `as2 lane <wl>`, with no launch-trigger text appended.
//   R6  after the commit the echo carries one more line saying whether the command was copied; a copy failure never
//       undoes the answer. Every copier here is injected: the real pbcopy is never run.
//   R7  a taken pair with no lane holding the workload shows the taken line, the command on its own line, whatever else
//       is open, and no relaunch idle line; the stopped lane's own late `lane-started:` does not hide it.
//   R12 the idle line on a user-driven workload offers `as2 lane <wl>` and never says relaunch.
//   R13 a taken pair line is on fire; an offer line waits for the window as its round-limit question does.
//   R14 the receipt's wait-for-the-lane prefix shows only when a lane stop was requested.
//   R15 chaos counts a taken line as covering the workload's unheld open slices and ignores offer lines in its one-line check.
import { describe, expect, test } from "bun:test";
import { reviewLimitBody, reviewRoundBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { CLASSIFIER_BY, LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import surfaceInputRow, { type Copier, pbcopyCopier } from "../extensions/surface-input";
import { onFire, pendingText } from "../src/batch";
import { emptySeen, judgePoll } from "../src/chaos";
import { errorLines } from "../src/errors";
import { apply, interpret, interpretBatch, interpretPaste } from "../src/input";
import { laneExitBody } from "../src/launch";
import { Numbering } from "../src/numbering";
import { PENDING_WRAPPER_ONLY, pendingBlock, pendingItems } from "../src/pending";
import { renderWake, renderWorkload } from "../src/render";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, notices, tempLedger, workloadWithSlice } from "./helpers";

const LANE = "lane-t-1";
const BRIEF = "Restyle the settings modal";

/** An autonomous normal workload; with `held`, lane-t-1 holds it under a live lease. */
function workload(ledger: Ledger, held: boolean): string {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: BRIEF, stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
	if (held) expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
	return wl;
}

/** The classifier's round-limit question as the raise writes it (body without any pair text), offered on signal E. */
function roundLimitQuestion(ledger: Ledger, o: { held: boolean }): { wl: string; sl: string; q: string } {
	const wl = workload(ledger, o.held);
	const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "Restyle the modal", doneCondition: "review passes", inputs: "src/modal.css" });
	const findings = { counts: { blocking: { correctness: 1 }, major: {}, minor: {} }, titles: [] };
	ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewRoundBody({ slice: sl, round: 1, token: "dt-r1", group: "dg-r1", verdict: "accepted", findings }) });
	const q = ledger.raiseQuestion({
		by: LANE, workloadId: wl, sliceId: sl,
		body: `The review of ${sl} reached its round limit: 1 failed round of 1 allowed (normal stakes).`,
		options: [...ROUND_LIMIT_OPTIONS, "pair"],
	});
	ledger.recordEntry({ by: LANE, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
	ledger.recordEntry({ by: CLASSIFIER_BY, workloadId: wl, kind: "assumption", body: `pair-offer: ${q} site round-limit signals e` });
	return { wl, sl, q };
}

/** The needs-you offer line Jo reads for each fixture. */
const roundLimitOffer = (wl: string, q: string) =>
	`pair offer on ${BRIEF} (${q}): it reads as UI or taste work. Answer pair ${q} to stop the lane and drive it yourself (as2 lane ${wl}).`;
/** The pending block's offer line for the round-limit fixture. */
const pendingOffer = (wl: string, q: string) =>
	`  ↳ pair offer: it reads as UI or taste work. Answer pair ${q} instead to stop the lane and drive it yourself (as2 lane ${wl}).`;

/** The words of `options` as a list Jo reads, with `pair` never among them. */
const listed = (options: readonly string[]) => options.join(" / ");

/** Jo answers `pair q` typed at the surface: the receipt. */
const pairTyped = (ledger: Ledger, q: string): string => apply(ledger, interpret(ledger, `pair ${q}`)! as Parameters<typeof apply>[1]);

/** The lane that held the workload ends on its own after the stop: released, its runner's intended exit recorded. */
function laneEnds(ledger: Ledger, wl: string): void {
	ledger.releaseWorkload(wl, { by: LANE, holder: LANE });
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(LANE, { code: 0, signal: null, outcome: "completed" }) });
}

/** The taken line Jo reads after a pair on the fixture's question. */
const takenLine = (wl: string, q: string) => `you took pair on ${BRIEF} (${q}); its lane has ended. Continue it in another terminal:\nas2 lane ${wl}`;

describe("R2: the offer is its own line, and pair is never a shown option", () => {
	test("needs-you: the unnumbered offer line sits right before its question's line, which lists the options less pair", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = roundLimitQuestion(ledger, { held: true });
		const lines = new Numbering().assign(errorLines(ledger)).filter((l) => l.workloadId === wl);
		expect(lines.map((l) => [l.kind, l.state ?? null, l.n ?? null])).toEqual([["pair", "offer", null], ["question", null, 1]]);
		expect(lines[0]!.line).toBe(roundLimitOffer(wl, q));
		expect(lines[1]!.line).toBe(`lane on ${wl} is waiting on you (${q}, slice ${sl}): The review of ${sl} reached its round limit: 1 failed round of 1 allowed (normal stakes). — answer with one word: ${listed(ROUND_LIMIT_OPTIONS)} (or \`withdraw\`)`);
	});

	test("the wake render's needs-you list carries the offer line before the question, whose options leave pair out", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		const text = renderWake(ledger).text;
		const offerAt = text.indexOf(roundLimitOffer(wl, q));
		expect(offerAt).toBeGreaterThan(-1);
		expect(text.indexOf(`waiting on you (${q},`)).toBeGreaterThan(offerAt);
		expect(text).toContain(`answer with one word: ${listed(ROUND_LIMIT_OPTIONS)} (or \`withdraw\`)`);
		expect(text).not.toContain("extend / accept / stop / pair");
	});

	test("the pending block: the offer line is right under its question's answer line, whose `also:` list leaves pair out", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		const lines = pendingText(ledger).split("\n");
		const at = lines.findIndex((l) => l.startsWith(`extend ${q}  # `));
		expect(at).toBeGreaterThan(-1);
		expect(lines[at]).toEndWith("also: accept / stop / withdraw");
		expect(lines[at + 1]).toBe(pendingOffer(wl, q));
		expect(lines.filter((l) => l.includes("pair offer"))).toHaveLength(1);
	});

	test("the pending block's overflow sentence: its options leave pair out and the offer line is right under it", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		const lines = pendingBlock(pendingItems(ledger).map((i) => ({ ...i, answer: null }))).text.split("\n");
		const at = lines.findIndex((l) => l.startsWith(`${q} on ${BRIEF} asks:`));
		expect(lines[at]).toContain(`its options (${listed(ROUND_LIMIT_OPTIONS)}) are not one word each`);
		expect(lines[at + 1]).toBe(pendingOffer(wl, q));
	});

	test("the ledger render: the question lists its options less pair, the offer line beneath it", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = roundLimitQuestion(ledger, { held: true });
		const lines = renderWorkload(ledger, ledger.inFlight().find((w) => w.workload.id === wl)!).split("\n");
		const at = lines.findIndex((l) => l.startsWith(`- ${q} on ${sl}:`));
		expect(lines[at]).toEndWith(`— options: ${listed(ROUND_LIMIT_OPTIONS)}`);
		expect(lines[at + 1]).toBe(`  ${roundLimitOffer(wl, q)}`);
	});

	test("`#n takes:` and `(q-… takes:)` list the options less pair, then the offer line on its own line", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		const numbering = new Numbering();
		numbering.assign(errorLines(ledger));
		expect(interpretBatch(ledger, numbering, "1 maybe")).toEqual({ ok: false, lines: [`#1 takes: ${listed(ROUND_LIMIT_OPTIONS)} / withdraw\n${roundLimitOffer(wl, q)}`] });
		const paste = interpretPaste(ledger, numbering, `approve ${q}\nThanks.`);
		expect(paste?.ok).toBe(false);
		expect(paste!.ok ? null : paste!.refused[0]!.why).toEqual([`"approve ${q}" is not a command the surface knows (${q} takes: ${listed(ROUND_LIMIT_OPTIONS)} / withdraw)\n${roundLimitOffer(wl, q)}`]);
	});

	test("a question with no valid offer shows no offer line anywhere, and still never lists pair", () => {
		const { ledger } = tempLedger();
		const wl = workload(ledger, true);
		const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "Which?", options: ["left", "right"] });
		expect(errorLines(ledger).map((l) => l.kind)).toEqual(["question"]);
		expect(pendingText(ledger)).not.toContain("pair offer");
	});
});

/** The surface-input row on a fresh orchestrator session over `path`, copying through `copier`. */
function surface(path: string, copier: Copier) {
	const f = fakePi();
	surfaceInputRow(f.pi, { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" }, copier);
	const ctx = ctxOf();
	/** Jo's prompt as a turn: the notices it raised, each split into its lines. */
	const prompt = async (text: string): Promise<string[][]> => {
		notices.length = 0;
		await f.emit("before_agent_start", { prompt: text, systemPrompt: [] }, ctx);
		return notices.map((n) => n.split("\n"));
	};
	/** Jo typing `text` (OMP's interactive `input` event) and, unless a handler took it, the turn it starts: its notices. */
	const say = async (text: string): Promise<string[][]> => {
		notices.length = 0;
		const r = (await f.emit("input", { text, source: "interactive" }, ctx)) as { handled?: boolean } | undefined;
		if (r?.handled) return notices.map((n) => n.split("\n"));
		return prompt(text);
	};
	return { prompt, say, f };
}
/** A copier that records what it was handed and answers `why` (null: copied), or throws it. */
function copierOf(why: string | null | Error): { copier: Copier; copied: string[] } {
	const copied: string[] = [];
	return {
		copied,
		copier: async (text) => {
			copied.push(text);
			if (why instanceof Error) throw why;
			return why;
		},
	};
}

describe("R3: a pending block pasted back unchanged", () => {
	test("applies its answer line alone: the offer line is never applied, refused or held as Jo's words", () => {
		const { ledger } = tempLedger();
		const { q } = roundLimitQuestion(ledger, { held: true });
		const numbering = new Numbering();
		numbering.assign(errorLines(ledger));
		const block = pendingText(ledger);
		expect(block).toContain("↳ pair offer");
		const r = interpretPaste(ledger, numbering, block);
		expect(r?.ok).toBe(true);
		const items = r!.ok ? r!.items : [];
		expect(items.map((i) => i.kind)).toEqual(["command"]);
		expect(items[0]!.kind === "command" ? items[0]!.cmd : null).toMatchObject({ kind: "answer", questionId: q, answer: "extend" });
	});

	test("its answer line and offer line pasted without the fence: the offer line is still the block's own", () => {
		const { ledger } = tempLedger();
		const { q } = roundLimitQuestion(ledger, { held: true });
		const numbering = new Numbering();
		numbering.assign(errorLines(ledger));
		const lines = pendingText(ledger).split("\n");
		const at = lines.findIndex((l) => l.startsWith(`extend ${q}  # `));
		const r = interpretPaste(ledger, numbering, `${lines[at]}\n${lines[at + 1]}`);
		expect(r?.ok).toBe(true);
		expect(r!.ok ? r!.items.map((i) => i.kind) : null).toEqual(["command"]);
	});

	test("through the surface-input extension, a block of overflow sentences and offer lines alone: no offer text forwarded as Jo's words, nothing applied or refused", async () => {
		const { ledger, path: db } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		const block = pendingBlock(pendingItems(ledger).map((i) => ({ ...i, answer: null }))).text;
		expect(block).toContain(pendingOffer(wl, q));
		const s = surface(db, copierOf(null).copier);
		const said = (await s.say(block)).flat();
		const offerText = pendingOffer(wl, q).trim();
		const rows = [STANDING_WORKLOAD_ID, wl].flatMap((id) => ledger.instructions(id));
		expect(rows.filter((r) => r.body.includes(offerText) || r.body.includes("pair offer"))).toEqual([]);
		expect(said.filter((l) => l.includes(offerText))).toEqual([]);
		expect(s.f.entries.filter((e) => e.type === "surface-jo-input")).toEqual([]);
		expect(ledger.question(q)!.state).toBe("open");
		expect(said.filter((l) => l.startsWith("nothing applied") || l.includes("is not a command") || l.startsWith("could not"))).toEqual([]);
		expect(said).toEqual([PENDING_WRAPPER_ONLY]);
	});

	test("through the extension, the same block with words of Jo's under it: the input row carries Jo's words, never the offer line", async () => {
		const { ledger, path: db } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		const block = pendingBlock(pendingItems(ledger).map((i) => ({ ...i, answer: null }))).text;
		const s = surface(db, copierOf(null).copier);
		await s.say(`${block}\nLet me look at the modal first.`);
		const rows = ledger.instructions(STANDING_WORKLOAD_ID);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.body).toEndWith("Let me look at the modal first.");
		expect(rows[0]!.body).not.toContain("pair offer");
		expect(rows[0]!.body).toBe(block.split("\n").filter((l) => l !== pendingOffer(wl, q)).concat("Let me look at the modal first.").join("\n"));
		expect(ledger.question(q)!.state).toBe("open");
	});
});

describe("R5, R6: the pair echo through the surface-input extension, with an injected copier", () => {
	const paths = [
		["single", (q: string) => `pair ${q}`],
		["numbered", (_q: string) => "1 pair"],
		["paste", (q: string) => `pair ${q}\nKeep the token scale.`],
	] as const;

	for (const [path, words] of paths) {
		test(`${path}: the echo ends on exactly \`as2 lane <wl>\` then the copied line; no launch-trigger text; the copier got the command`, async () => {
			const { ledger, path: db } = tempLedger();
			const { wl, q } = roundLimitQuestion(ledger, { held: false });
			const c = copierOf(null);
			const echoes = await surface(db, c.copier).prompt(words(q));
			const last = echoes.at(-1)!;
			expect(last[0]).toContain(`answered ${q} with "pair"`);
			expect(last.slice(-3)).toEqual(["in another terminal:", `as2 lane ${wl}`, "(copied to the clipboard)"]);
			expect(echoes.flat().join("\n")).not.toContain("no lane launches by itself");
			expect(c.copied).toEqual([`as2 lane ${wl}`]);
			expect(ledger.workload(wl)!.mode).toBe("user-driven");
		});
	}

	test("a copier that says why not: `(not copied: <why>)` on its own line, and the answer stands", async () => {
		const { ledger, path: db } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: false });
		const echoes = await surface(db, copierOf("pbcopy exited 1").copier).prompt(`pair ${q}`);
		expect(echoes.at(-1)!.slice(-2)).toEqual([`as2 lane ${wl}`, "(not copied: pbcopy exited 1)"]);
		expect(ledger.question(q)!.state).toBe("answered");
		expect(ledger.workload(wl)!.mode).toBe("user-driven");
	});

	test("a copier that throws: `(not copied: <message>)`, and the answer stands", async () => {
		const { ledger, path: db } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: false });
		const echoes = await surface(db, copierOf(new Error("clipboard locked")).copier).prompt("1 pair");
		expect(echoes.at(-1)!.slice(-2)).toEqual([`as2 lane ${wl}`, "(not copied: clipboard locked)"]);
		expect(ledger.question(q)!.state).toBe("answered");
		expect(ledger.workload(wl)!.mode).toBe("user-driven");
	});

	/** The session number Jo reads for question `q`: the extension's own numbering assigns the same, the needs-you lines being the same. */
	const numberOf = (ledger: Ledger, q: string): number => new Numbering().assign(errorLines(ledger)).find((l) => l.kind === "question" && l.rowId === q)!.n!;

	test("numbered batch: a pair answer then a later ordinary answer — the pair receipt is the echo's last line", async () => {
		const { ledger, path: db } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: false });
		const other = workload(ledger, true);
		const sl = ledger.addSlice({ by: LANE, workloadId: other, task: "t", doneCondition: "d", inputs: "i" });
		const plain = ledger.raiseQuestion({ by: LANE, workloadId: other, sliceId: sl, body: "Which?", options: ["left", "right"] });
		const [np, nq] = [numberOf(ledger, plain), numberOf(ledger, q)];
		const c = copierOf(null);
		const echoes = await surface(db, c.copier).prompt(`${nq} pair, ${np} left`);
		expect(echoes.map((e) => e[0]!.split(" → ")[0])).toEqual([`#${np}`, `#${nq}`]);
		expect(echoes[0]![0]).toContain(`answered ${plain} with "left"`);
		expect(echoes.at(-1)![0]).toContain(`answered ${q} with "pair"`);
		expect(echoes.at(-1)!.slice(-2)).toEqual([`as2 lane ${wl}`, "(copied to the clipboard)"]);
		expect(c.copied).toEqual([`as2 lane ${wl}`]);
	});

	const twoPairs = [
		["numbered batch", (ledger: Ledger, q1: string, q2: string) => `${numberOf(ledger, q1)} pair, ${numberOf(ledger, q2)} pair`],
		["paste", (_ledger: Ledger, q1: string, q2: string) => `pair ${q1}\npair ${q2}`],
	] as const;
	for (const [path, words] of twoPairs) {
		test(`${path} with two pair answers on two offered questions: the copier is called once, with the last pair answer's command`, async () => {
			const { ledger, path: db } = tempLedger();
			const first = roundLimitQuestion(ledger, { held: false });
			const last = roundLimitQuestion(ledger, { held: false });
			const c = copierOf(null);
			const echoes = await surface(db, c.copier).prompt(words(ledger, first.q, last.q));
			expect(c.copied).toEqual([`as2 lane ${last.wl}`]);
			expect(echoes.at(-1)![0]).toContain(`answered ${last.q} with "pair"`);
			expect(echoes.at(-1)!.slice(-2)).toEqual([`as2 lane ${last.wl}`, "(copied to the clipboard)"]);
			const earlier = echoes.find((e) => e[0]!.includes(`answered ${first.q} with "pair"`))!;
			expect(earlier.at(-1)).toBe(`as2 lane ${first.wl}`);
			expect(echoes.flat().filter((l) => l.includes("copied"))).toEqual(["(copied to the clipboard)"]);
			expect([first.wl, last.wl].map((wl) => ledger.workload(wl)!.mode)).toEqual(["user-driven", "user-driven"]);
		});
	}

	test("an answer that is not pair copies nothing and adds no copied line", async () => {
		const { ledger, path: db } = tempLedger();
		const { q } = roundLimitQuestion(ledger, { held: false });
		const c = copierOf(null);
		const echoes = await surface(db, c.copier).prompt(`accept ${q}`);
		expect(echoes.flat().some((l) => l.includes("copied"))).toBe(false);
		expect(c.copied).toEqual([]);
	});

	test("the default copier copies through the host's exec only on macOS with a UI and outside SSH", async () => {
		const f = fakePi(undefined, { exec: true });
		const ui = ctxOf();
		expect(await pbcopyCopier(f.pi, {}, "linux")("as2 lane wl-x", ui)).toBe("no clipboard on this system");
		expect(await pbcopyCopier(f.pi, {}, "darwin")("as2 lane wl-x", ctxOf({ hasUI: false }))).toBe("no terminal to copy for");
		expect(await pbcopyCopier(f.pi, { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, "darwin")("as2 lane wl-x", ui)).toBe("this is an SSH session");
		expect(f.execs.calls).toEqual([]);
		expect(await pbcopyCopier(f.pi, {}, "darwin")("as2 lane wl-x", ui)).toBeNull();
		expect(f.execs.calls.map((c) => [c.command, c.args.at(-1)])).toEqual([["sh", "as2 lane wl-x"]]);
		f.execs.answer = () => ({ stdout: "", stderr: "", code: 1, killed: false });
		expect(await pbcopyCopier(f.pi, {}, "darwin")("as2 lane wl-x", ui)).toBe("pbcopy exited 1");
		expect(await pbcopyCopier(fakePi().pi, {}, "darwin")("as2 lane wl-x", ui)).toBe("the host has no exec for extensions");
	});
});

describe("R7: the taken line", () => {
	test("after the lane that held it ends: the taken line with the command on its own line, and no relaunch idle line", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		pairTyped(ledger, q);
		expect(errorLines(ledger).filter((l) => l.kind === "pair")).toEqual([]); // the lane still holds it under a live lease
		laneEnds(ledger, wl);
		const lines = errorLines(ledger).filter((l) => l.workloadId === wl);
		expect(lines).toEqual([{ kind: "pair", workloadId: wl, rowId: q, state: "taken", line: takenLine(wl, q) }]);
		expect(lines[0]!.line.split("\n").at(-1)).toBe(`as2 lane ${wl}`);
		expect(lines.some((l) => l.line.includes("relaunch"))).toBe(false);
	});

	test("whatever else is open: another question on the workload does not hide it", () => {
		const { ledger } = tempLedger();
		const { wl, sl, q } = roundLimitQuestion(ledger, { held: false });
		pairTyped(ledger, q);
		const other = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "Which token?", options: ["left", "right"] });
		expect(errorLines(ledger).filter((l) => l.workloadId === wl).map((l) => [l.kind, l.rowId])).toEqual([["pair", q], ["question", other]]);
	});

	test("the stopped lane's own late lane-started: does not hide it; another lane's lane-started: does", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		pairTyped(ledger, q);
		laneEnds(ledger, wl);
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `lane-started: ${LANE} {"pid":1,"start":"x","argv":[]}` });
		expect(errorLines(ledger).filter((l) => l.kind === "pair").map((l) => l.line)).toEqual([takenLine(wl, q)]);
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `lane-started: lane-t-2 {"pid":2,"start":"y","argv":[]}` });
		expect(errorLines(ledger).filter((l) => l.kind === "pair")).toEqual([]);
	});

	test("a workload flipped back to autonomous shows no taken line", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: false });
		pairTyped(ledger, q);
		ledger.flipMode(wl, { by: SURFACE_BY, author: "jo", channel: "surface", mode: "autonomous" });
		expect(errorLines(ledger).filter((l) => l.kind === "pair")).toEqual([]);
	});
});

describe("R12: the idle line on a user-driven workload", () => {
	function endedLane(ledger: Ledger, mode: "autonomous" | "user-driven") {
		const { wl } = workloadWithSlice(ledger, { mode });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by surface" });
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-a", { code: 0, signal: null, outcome: "completed" }) });
		return wl;
	}

	test("offers `as2 lane <wl>` and never says relaunch; an autonomous workload's line is unchanged", () => {
		const { ledger } = tempLedger();
		const by = endedLane(ledger, "user-driven");
		const auto = endedLane(ledger, "autonomous");
		const idle = Object.fromEntries(errorLines(ledger).filter((l) => l.kind === "idle").map((l) => [l.workloadId, l.line]));
		expect(idle[by]).toBe(`lane lane-a on ${by} ended (completed) with 1 open slice(s) and no question; continue it with as2 lane ${by}, close, or instruct`);
		expect(idle[auto]).toBe(`lane lane-a on ${auto} ended (completed) with 1 open slice(s) and no question; relaunch, close, or instruct`);
	});
});

describe("R13: on fire", () => {
	test("an offer line waits for the window, as its round-limit question does; a taken line is on fire", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: false });
		const lines = errorLines(ledger);
		const fire = (kind: string) => onFire(ledger, lines.find((l) => l.workloadId === wl && l.kind === kind)!);
		expect([fire("pair"), fire("question")]).toEqual([false, false]);
		pairTyped(ledger, q);
		const taken = errorLines(ledger).find((l) => l.kind === "pair" && l.state === "taken")!;
		expect(taken.workloadId).toBe(wl);
		expect(onFire(ledger, taken)).toBe(true);
	});
});

describe("R14: the receipt's wait-for-the-lane prefix", () => {
	test("shown when a lane holding the workload live was asked to stop, absent when none was", () => {
		const { ledger } = tempLedger();
		const held = roundLimitQuestion(ledger, { held: true });
		expect(pairTyped(ledger, held.q).split("\n").slice(-2)).toEqual(["when the lane has stopped (a few seconds), in another terminal:", `as2 lane ${held.wl}`]);
		const free = roundLimitQuestion(ledger, { held: false });
		const receipt = pairTyped(ledger, free.q);
		expect(receipt.split("\n").slice(-2)).toEqual(["in another terminal:", `as2 lane ${free.wl}`]);
		expect(receipt).not.toContain("when the lane has stopped");
	});
});

describe("R15: chaos", () => {
	test("an offer line adds no line to the one-line check", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		const poll = judgePoll(ledger, wl, emptySeen());
		expect(poll.lines.map((l) => [l.kind, l.rowId])).toEqual([["question", q]]);
		expect(poll.a.ok).toBe(true);
	});

	test("a taken line covers the workload's open slices nobody holds", () => {
		const { ledger } = tempLedger();
		const { wl, q } = roundLimitQuestion(ledger, { held: true });
		ledger.addSlice({ by: LANE, workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		pairTyped(ledger, q);
		laneEnds(ledger, wl);
		const poll = judgePoll(ledger, wl, emptySeen());
		expect(poll.lines.map((l) => [l.kind, l.rowId])).toEqual([["pair", q]]);
		expect(poll.a.ok).toBe(true);
		expect(poll.b.openSlices.length).toBeGreaterThan(0);
		expect(poll.b).toMatchObject({ ok: true, liveHolder: false, orphans: [] });
	});
});
