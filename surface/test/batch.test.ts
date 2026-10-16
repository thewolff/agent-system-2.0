// Batched needs-you arrivals and the surface words brb / back (PLAN wl-mv5msri070p0qo D3, D4,
// § 3 sl-surface-wire). The test plays OMP's part: it fires the poll (ctx.setInterval), emits Jo's
// `input` event and his turn's `before_agent_start`, and moves the session clock (`s.now`) and the
// lane connection's clock together, so the fixed window and the quiet stretch are measured on it.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { onFire } from "../src/batch";
import { CEILING_OPTIONS } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { laneExitBody } from "../src/launch";
import { pendingBlock, pendingItems, pendingWaits } from "../src/pending";
import { surfaceSession } from "../src/session";
import { laneDiedShutdownBody } from "../src/signals";
import { testRunFailedBody } from "../src/test-run";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { clock, ctxOf, fakePi, loadTestText, notices, type Sent, tempLedger, timers, tmp, workloadWithSlice } from "./helpers";

const NEEDS = "## needs you (new since your last turn)";
const BACK = "## back: everything waiting on you (complete list; write each up with its content)";
const QUIET = "## quiet stretch: everything waiting on you (complete list, once)";
const count = (n: number) => `open answer lines: ${n} (\`pending\` shows them all)`;
type Turn = { systemPrompt: string[]; messages: Sent["message"][] };

/** An orchestrator surface past its first wake (taken by Jo's first turn, read recorded), a lane connection, and one clock for both. */
async function surface() {
	timers.length = 0;
	notices.length = 0;
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const c = clock("2026-10-12T19:00:00.000Z");
	const lane = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false, clock: c.now });
	const f = fakePi();
	await orchestratorSurface(f.pi, e, { loadText: loadTestText });
	const ctx = ctxOf();
	const s = surfaceSession(ctx, e);
	s.now = c.now;
	await f.emit("session_start", { type: "session_start" }, ctx);
	await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
	await f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx);
	const jo = async (prompt: string): Promise<string> => ((await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as Turn).messages.map((m) => m.content).join("\n");
	return {
		f, ctx, s, c, lane,
		needsYou: (): Sent[] => f.sent.filter((x) => x.message.customType === "surface-needs-you"),
		poll: () => timers[0]!.fn(),
		minutes: (m: number) => c.at(new Date(Date.parse(c.now()) + m * 60_000).toISOString()),
		/** Jo's `input` event for `text` (OMP's interactive source): what the handlers return. */
		type: (text: string) => f.emit("input", { text, source: "interactive" }, ctx),
		/** Jo's turn on `prompt`: its message text. */
		jo,
		/** Jo typing `prompt` and the turn it starts. */
		say: async (prompt: string) => {
			await f.emit("input", { text: prompt, source: "interactive" }, ctx);
			return jo(prompt);
		},
		block: () => pendingBlock(pendingItems(lane), pendingWaits(lane)).text,
	};
}

const ask = (l: Ledger, wl: string, sl: string, body: string) => l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body, options: ["yes", "no"] });

/** The runner's ceiling question at 80 % on a workload of its own (surface/test/ceiling-surface.test.ts withCeilingQuestion). */
function ceilingQuestion(l: Ledger) {
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	const sl = l.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: "sl-ceiling-1", task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
	const q = l.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl, body: "80 % of the ceiling", options: [...CEILING_OPTIONS] });
	return { wl, sl, q };
}

/** A lane that launched, held the workload, released it and exited with `outcome`/`reason`: an idle line. */
function idleExit(l: Ledger, outcome: string, reason: string | null) {
	const { wl } = workloadWithSlice(l);
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-c cause first requested-by surface" });
	expect(l.claimWorkload(wl, { by: "lane-c", holder: "lane-c", leaseMs: 3_600_000 }).won).toBe(true);
	l.releaseWorkload(wl, { by: "lane-c", holder: "lane-c" });
	l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-c", { code: 0, signal: null, outcome, reason }) });
	return wl;
}

/** A held `lane-died:` message to the orchestrator on `wl`. */
const death = (l: Ledger, wl: string, open: number) =>
	l.enqueue({ by: "lane-x", workloadId: wl, sender: "lane-x", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-x", l.now(), open) });

/** A red full-suite run the test runner reported about a workload no lane holds. */
function redRun(l: Ledger) {
	const { wl, sl } = workloadWithSlice(l);
	l.enqueue({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: testRunFailedBody({ workloadId: wl, slice: sl, verdict: "red", sha: "a".repeat(40), failing: 3, first: null }) });
	return wl;
}

describe("onFire: the four kinds that go out on their own poll", () => {
	test("a death with open or paused work, the ceiling question, a ceiling stop's idle exit and a red run are on fire; their quiet twins are not", () => {
		const { ledger: l } = tempLedger();
		const live = workloadWithSlice(l).wl;
		death(l, live, 1);
		const empty = l.openWorkload({ by: "lane-x", brief: "nothing left", stakes: "normal", mode: "autonomous" });
		death(l, empty, 0);
		const { q: ceiling } = ceilingQuestion(l);
		const { wl: other, sl } = workloadWithSlice(l);
		const routine = ask(l, other, sl, "Which?");
		const stopped = idleExit(l, "stop", "ceiling");
		const parked = idleExit(l, "parked", null);
		const red = redRun(l);
		const fire = (kind: string, wl: string, rowId?: string) => {
			const line = errorLines(l).find((x) => x.kind === kind && x.workloadId === wl && (rowId === undefined || x.rowId === rowId));
			expect(line).toBeDefined();
			return onFire(l, line!);
		};
		expect(fire("lane-died", live)).toBe(true);
		expect(fire("lane-died", empty)).toBe(false);
		expect(fire("question", l.question(ceiling)!.workload_id, ceiling)).toBe(true);
		expect(fire("question", other, routine)).toBe(false);
		expect(fire("idle", stopped)).toBe(true);
		expect(fire("idle", parked)).toBe(false);
		expect(fire("test-run", red)).toBe(true);
	});
});

describe("the window: routine lines wait and go out together (D3)", () => {
	test("three routine lines on three polls inside the window: nothing until it ends, then one surface-needs-you carrying all three and the count", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q1 = ask(t.lane, wl, sl, "First?");
		t.poll();
		t.minutes(1);
		const q2 = ask(t.lane, wl, sl, "Second?");
		t.poll();
		t.minutes(1);
		const en = t.lane.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		t.poll();
		t.minutes(2);
		t.poll();
		expect(t.needsYou()).toEqual([]);
		// the window runs from the first line, not the last: 5 minutes after q1
		t.minutes(1);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		const push = t.needsYou()[0]!;
		expect(push.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(push.message.content.startsWith(NEEDS)).toBe(true);
		for (const id of [q1, q2, en]) expect(push.message.content).toContain(id);
		expect(push.message.content.endsWith(`\n\n${count(3)}`)).toBe(true);
		t.minutes(10);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.s.heldNeedsYou.size).toBe(0);
	});

	test("the flush re-checks every held line: a question answered and a due row whose workload closed are not pushed; what still stands is", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q1 = ask(t.lane, wl, sl, "Answered before the flush?");
		const due = t.lane.openWorkload({ by: SURFACE_BY, brief: "due:2026-10-12 renew the certificate", stakes: "normal", mode: "autonomous" });
		t.poll();
		expect(t.s.heldNeedsYou.size).toBe(2);
		t.minutes(1);
		const q3 = ask(t.lane, wl, sl, "Still open?");
		t.poll();
		t.lane.answerQuestion(q1, { by: "surface", answer: "yes", author: "jo", channel: "surface" });
		t.lane.closeWorkload(due, { by: SURFACE_BY });
		t.minutes(4);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		const content = t.needsYou()[0]!.message.content;
		expect(content).toContain(q3);
		expect(content).not.toContain(q1);
		expect(content).not.toContain("scheduled and past due");
		expect(content.endsWith(count(1))).toBe(true);
	});

	test("a held line gone by the flush leaves nothing to push: no message at all", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q = ask(t.lane, wl, sl, "Answered before the flush?");
		t.poll();
		t.lane.answerQuestion(q, { by: "surface", answer: "no", author: "jo", channel: "surface" });
		t.minutes(6);
		t.poll();
		expect(t.needsYou()).toEqual([]);
		expect(t.s.heldNeedsYou.size).toBe(0);
	});

	test("a lane death with no open work waits for the window, and its message moves to delivered only when it is pushed", async () => {
		const t = await surface();
		const wl = t.lane.openWorkload({ by: "lane-x", brief: "nothing left", stakes: "normal", mode: "autonomous" });
		const m = death(t.lane, wl, 0);
		t.poll();
		expect(t.needsYou()).toEqual([]);
		expect(t.lane.message(m)!.state).toBe("held");
		t.minutes(3);
		t.poll();
		expect(t.lane.message(m)!.state).toBe("held");
		t.minutes(2);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.needsYou()[0]!.message.content).toContain(`lane lane-x on ${wl} died`);
		expect(t.lane.message(m)!.state).toBe("delivered");
	});

	test("a wake render clears the hold: the lines it carried are not pushed after it", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q = ask(t.lane, wl, sl, "Before the compaction?");
		t.poll();
		expect(t.s.heldNeedsYou.size).toBe(1);
		await t.f.emit("session_compact", { type: "session_compact" }, t.ctx);
		expect(await t.jo("go on")).toContain(q);
		expect(t.s.heldNeedsYou.size).toBe(0);
		await t.f.tool("orchestrator_wake_read").execute("2", { body: "resuming" }, undefined, undefined, t.ctx);
		t.minutes(6);
		t.poll();
		expect(t.needsYou()).toEqual([]);
	});

	test("Jo's turn takes the re-checked hold into 'needs you (new since your last turn)' with the count; the window then has nothing to push", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q1 = ask(t.lane, wl, sl, "First?");
		t.poll();
		const q2 = ask(t.lane, wl, sl, "Second?");
		const turn = await t.jo("what's new?");
		expect(turn.startsWith(NEEDS)).toBe(true);
		expect(turn).toContain(q1);
		expect(turn).toContain(q2);
		expect(turn.endsWith(`\n\n${count(2)}`)).toBe(true);
		t.minutes(6);
		t.poll();
		expect(t.needsYou()).toEqual([]);
		expect(await t.jo("and now?")).toBe(count(2));
	});

	test("an on-demand ledger read takes what it showed out of the hold: a full read, and a read scoped to another workload (whose render still lists every needs-you line), leave nothing for the window (code review r1, finding 3)", async () => {
		for (const scoped of [false, true]) {
			const t = await surface();
			const { wl, sl } = workloadWithSlice(t.lane);
			const other = workloadWithSlice(t.lane).wl;
			const q = ask(t.lane, wl, sl, "Still open at the window's end?");
			t.poll();
			expect(t.s.heldNeedsYou.size).toBe(1);
			const read = (await t.f.tool("orchestrator_ledger").execute("1", scoped ? { workload: other } : {}, undefined, undefined, t.ctx)).content[0]!.text;
			expect(read.split("\n\n## ")[1]).toContain(q);
			expect(t.s.heldNeedsYou.size).toBe(0);
			expect(t.s.holdSince).toBeNull();
			t.minutes(6);
			t.poll();
			expect(t.needsYou()).toEqual([]);
			expect(t.lane.question(q)!.state).toBe("open");
		}
	});

	test("an on-demand read leaves a line it did not show in the hold, window kept: it still goes out at the window's end", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q1 = ask(t.lane, wl, sl, "Shown by the read?");
		t.poll();
		const since = t.s.holdSince;
		await t.f.tool("orchestrator_ledger").execute("1", {}, undefined, undefined, t.ctx);
		t.minutes(1);
		const q2 = ask(t.lane, wl, sl, "Raised after the read?");
		t.poll();
		expect(t.s.heldNeedsYou.size).toBe(1);
		expect(t.s.holdSince).not.toBe(since);
		t.minutes(6);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.needsYou()[0]!.message.content).toContain(q2);
		expect(t.needsYou()[0]!.message.content).not.toContain(q1);
	});
});

describe("on fire: pushed on its own poll, carrying the hold (D3)", () => {
	const kinds: [string, (l: Ledger) => string][] = [
		["a lane death on a workload with open slices", (l) => {
			const { wl } = workloadWithSlice(l);
			death(l, wl, 1);
			return `lane lane-x on ${wl} died`;
		}],
		["the runner's ceiling question", (l) => ceilingQuestion(l).q],
		["an idle exit that is a ceiling stop (outcome stop reason ceiling)", (l) => `lane lane-c on ${idleExit(l, "stop", "ceiling")} ended (stop)`],
		["a red full-suite run", (l) => `full suite red on ${redRun(l)}`],
	];
	for (const [name, write] of kinds) {
		test(`${name}: one push at once, with the routine line held before it; the hold is empty after`, async () => {
			const t = await surface();
			const { wl, sl } = workloadWithSlice(t.lane);
			const routine = ask(t.lane, wl, sl, "Routine?");
			t.poll();
			expect(t.needsYou()).toEqual([]);
			t.minutes(1);
			const needle = write(t.lane);
			t.poll();
			expect(t.needsYou()).toHaveLength(1);
			const content = t.needsYou()[0]!.message.content;
			expect(content).toContain(needle);
			expect(content).toContain(routine);
			expect(content).toMatch(/\n\nopen answer lines: \d+ \(`pending` shows them all\)$/);
			expect(t.s.heldNeedsYou.size).toBe(0);
			t.minutes(10);
			t.poll();
			expect(t.needsYou()).toHaveLength(1);
		});
	}

	test("the ceiling question at 80 % unanswered is pushed, and pushed again at once when the lane's lane-stop: accepted ceiling lands", async () => {
		const t = await surface();
		const { wl, q } = ceilingQuestion(t.lane);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.needsYou()[0]!.message.content).toContain(q);
		expect(t.needsYou()[0]!.message.content).not.toContain("the lane stopped at the ceiling");
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		t.minutes(1);
		t.lane.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 accepted ceiling" });
		t.poll();
		expect(t.needsYou()).toHaveLength(2);
		expect(t.needsYou()[1]!.message.content).toContain(`(${q}, slice sl-ceiling-1)`);
		expect(t.needsYou()[1]!.message.content).toContain("; the lane stopped at the ceiling");
		t.poll();
		expect(t.needsYou()).toHaveLength(2);
	});
});

describe("brb and back (D4)", () => {
	test("brb is handled with no turn and confirmed once; an on-fire line goes out alone and the hold stays; back carries the hold and the complete block", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const routine = ask(t.lane, wl, sl, "Routine?");
		t.poll();
		expect(await t.type("brb")).toEqual({ handled: true });
		expect(notices).toEqual(["holding needs-you pushes until `back`; on-fire items still come through"]);
		expect(t.s.away).toEqual({ since: t.c.now() });
		t.minutes(1);
		const { q: ceiling } = ceilingQuestion(t.lane);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.needsYou()[0]!.message.content).toContain(ceiling);
		expect(t.needsYou()[0]!.message.content).not.toContain(routine);
		expect(t.needsYou()[0]!.message.content.endsWith(count(2))).toBe(true);
		// away: the window never flushes
		t.minutes(10);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.s.heldNeedsYou.size).toBe(1);
		// back reaches the model as Jo's turn
		expect(await t.type("back")).toBeUndefined();
		const turn = await t.jo("back");
		expect(turn.startsWith(BACK)).toBe(true);
		expect(turn.split("## pending:")[0]).toContain(`is waiting on you (${routine}, slice ${sl})`);
		expect(turn).toContain(`\n\n${t.block()}\n\n${count(2)}`);
		expect(turn.endsWith(count(2))).toBe(true);
		expect(t.s.away).toBeNull();
		expect(t.s.heldNeedsYou.size).toBe(0);
		t.minutes(10);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
	});

	test("brb, a routine line, an ordinary turn, then back: the ordinary turn carries only the count and leaves the hold; back carries it", async () => {
		const t = await surface();
		await t.type("brb");
		const { wl, sl } = workloadWithSlice(t.lane);
		const routine = ask(t.lane, wl, sl, "Routine?");
		t.poll();
		expect(t.needsYou()).toEqual([]);
		const ordinary = await t.jo("how is it going?");
		expect(ordinary).toBe(count(1));
		expect(t.s.heldNeedsYou.size).toBe(1);
		expect(t.s.away).not.toBeNull();
		const back = await t.say("back");
		expect(back.startsWith(BACK)).toBe(true);
		expect(back.split("## pending:")[0]).toContain(routine);
		expect(back).toContain(t.block());
		expect(back.endsWith(count(1))).toBe(true);
		expect(t.s.heldNeedsYou.size).toBe(0);
	});

	test("back while not away is the digest without a hold: the complete block under the back heading", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		ask(t.lane, wl, sl, "Seen already?");
		await t.jo("anything?");
		expect(await t.jo("back")).toBe(`${BACK}\n\n${t.block()}\n\n${count(1)}`);
	});

	test("back with a wake pending: the turn carries the wake render, then the back heading and the complete block (code review r1, finding 2)", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q = ask(t.lane, wl, sl, "Open across the compaction?");
		await t.type("brb");
		await t.f.emit("session_compact", { type: "session_compact" }, t.ctx);
		expect(t.s.pending).toBe("compaction");
		const turn = await t.say("back");
		expect(turn).toMatch(/^# Ledger at .* \(wake: compaction\)/);
		expect(turn.split(BACK)[0]).toContain(q);
		expect(turn).toContain(`\n\n${BACK}\n\n${t.block()}\n\n${count(1)}`);
		expect(turn.endsWith(count(1))).toBe(true);
		expect(t.s.away).toBeNull();
		expect(t.s.pending).toBeNull();
	});
});

describe("the quiet stretch (D4)", () => {
	test("a turn more than 30 minutes after Jo's previous typed input carries the complete block once; the next one does not", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		ask(t.lane, wl, sl, "Open all along?");
		expect(await t.say("hi")).not.toContain(QUIET);
		t.minutes(29);
		expect(await t.say("still there?")).not.toContain(QUIET);
		t.minutes(31);
		const quiet = await t.say("anything new?");
		expect(quiet).toContain(`${QUIET}\n${t.block()}`);
		expect(quiet.endsWith(count(1))).toBe(true);
		t.minutes(1);
		expect(await t.say("ok thanks")).not.toContain(QUIET);
	});

	test("a quiet-stretch turn with a wake pending: the wake render, then the quiet heading and the complete block (code review r1, finding 2)", async () => {
		const t = await surface();
		const { wl, sl } = workloadWithSlice(t.lane);
		const q = ask(t.lane, wl, sl, "Open across the compaction?");
		await t.say("hi");
		t.minutes(31);
		await t.f.emit("session_compact", { type: "session_compact" }, t.ctx);
		const turn = await t.say("anything new?");
		expect(turn).toMatch(/^# Ledger at .* \(wake: compaction\)/);
		expect(turn.split(QUIET)[0]).toContain(q);
		expect(turn).toContain(`\n\n${QUIET}\n${t.block()}\n\n`);
		expect(turn.endsWith(count(1))).toBe(true);
		expect(t.s.pending).toBeNull();
	});

	test("pending and brb move the clock too: a turn right after them is not a quiet stretch", async () => {
		const t = await surface();
		await t.say("hi");
		t.minutes(40);
		expect(await t.type("pending")).toEqual({ handled: true });
		t.minutes(1);
		expect(await t.say("thanks")).not.toContain(QUIET);
	});
});
