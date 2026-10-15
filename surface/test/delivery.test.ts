// Delivery of the § B3 lines between wakes (M5 fix round 1, items 1, 2 and 7): the once-per-state
// tracker, a line written by another ledger connection after the wake reaching the next turn's
// context once, the idle poll pushing it through pi.sendMessage, and the consumer half moving the
// orchestrator-bound rows behind a delivered line to `delivered`.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { CEILING_OPTIONS } from "../src/ceiling";
import { Delivered, consumeAllToOrchestrator, consumeLines, needsYouBlock } from "../src/delivery";
import { type ErrorLine, errorLines } from "../src/errors";
import { laneExitBody, planFirstBody } from "../src/launch";
import { surfaceSession } from "../src/session";
import { laneDiedShutdownBody } from "../src/signals";
import { ARTIFACT_FAILED_PREFIX, ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { clock, ctxOf, fakePi, tempLedger, timers, tmp, workloadWithSlice } from "./helpers";

const line = (kind: ErrorLine["kind"], rowId: string, state?: string): ErrorLine => ({ kind, workloadId: "wl-1", rowId, line: `${kind} ${rowId} ${state ?? ""}`, state });

function env(over: Record<string, string> = {}): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home", ...over };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}
const open = (e: Record<string, string>) => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });
type Started = { systemPrompt: string[]; messages: { customType: string; content: string }[] };
/** The count line every needs-you push and every Jo turn ends with (PLAN wl-mv5msri070p0qo D3). */
const count = (n: number) => `open answer lines: ${n} (\`pending\` shows them all)`;
/** A turn's message texts. */
const texts = (t: unknown) => (t as Started).messages.map((m) => m.content);
/** A status batch's needs-you bullets (PLAN wl-mv8igegljun18g D2), or null when it has none. */
const needsOf = (content: string): string | null => content.includes("\n\n## needs you\n") ? content.split("\n\n## needs you\n")[1]!.split("\n\n")[0]! : null;

/**
 * A surface past its first wake on a settable clock with a one-minute status interval: `batch()` moves the clock a
 * minute, polls, and confirms whatever status message the poll sent (its `message_end`); `needs()` lists the batches
 * carrying a needs-you section.
 */
async function clocked(start: string) {
	timers.length = 0;
	const f = fakePi();
	const e = env({ AGENT_SYSTEM_SURFACE_STATUS_MS: "60000" });
	orchestratorSurface(f.pi, e);
	const ctx = ctxOf();
	const c = clock(start);
	surfaceSession(ctx, e).now = c.now;
	await f.emit("session_start", { type: "session_start" }, ctx);
	await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
	await f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx);
	const status = () => f.sent.filter((x) => x.message.customType === "surface-status");
	return {
		f, e, ctx, c,
		batch: async () => {
			c.at(new Date(Date.parse(c.now()) + 60_000).toISOString());
			const before = f.sent.length;
			timers[0]!.fn();
			for (const x of f.sent.slice(before)) if (x.message.customType === "surface-status") await f.admit(x, ctx);
		},
		needs: () => status().filter((x) => needsOf(x.message.content) !== null),
	};
}

describe("Delivered: a line reaches the orchestrator once per state", () => {
	test("new lines are taken once; a changed state token is taken again; a vanished line is forgotten so its return is new", () => {
		const d = new Delivered();
		expect(d.take([line("question", "q-1"), line("artifact", "sl-1", "2")]).map((l) => l.rowId)).toEqual(["q-1", "sl-1"]);
		expect(d.take([line("question", "q-1"), line("artifact", "sl-1", "2")])).toEqual([]);
		expect(d.take([line("question", "q-1"), line("artifact", "sl-1", "3")]).map((l) => l.rowId)).toEqual(["sl-1"]);
		expect(d.take([line("artifact", "sl-1", "3")])).toEqual([]);
		expect(d.size).toBe(1);
		expect(d.take([line("question", "q-1"), line("artifact", "sl-1", "3")]).map((l) => l.rowId)).toEqual(["q-1"]);
	});

	test("an idle line's identity is kept while it is masked: its return after a question is not new; a newer exit entry is (MIGRATION.md item 68, Codex review of PR #27)", () => {
		const d = new Delivered();
		expect(d.take([line("idle", "en-exit-1")]).map((l) => l.rowId)).toEqual(["en-exit-1"]);
		expect(d.take([line("question", "q-1")]).map((l) => l.rowId)).toEqual(["q-1"]);
		expect(d.take([line("idle", "en-exit-1")])).toEqual([]);
		expect(d.take([line("idle", "en-exit-2")]).map((l) => l.rowId)).toEqual(["en-exit-2"]);
		expect(d.size).toBe(2);
	});

	test("needsYouBlock renders one bullet per line under the heading", () => {
		expect(needsYouBlock([line("question", "q-1")], "needs you (new since your last turn)")).toBe("## needs you (new since your last turn)\n- question q-1 ");
	});

	test("needsYouBlock prints a literal #n on a numbered line and no # on an unnumbered one", () => {
		const numbered = { ...line("reserved", "en-1"), n: 3 };
		expect(needsYouBlock([numbered, line("held", "m-1")], "needs you")).toBe("## needs you\n- #3 reserved en-1 \n- held m-1 ");
	});
});

describe("consumption: held orchestrator-bound rows behind a delivered line move to delivered", () => {
	test("consumeLines advances only the messages a line names; consumeAllToOrchestrator advances every held orchestrator-bound row on an open workload", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const a = ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: `${ARTIFACT_FAILED_PREFIX} 1` });
		const b = ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: `${ARTIFACT_FAILED_PREFIX} 2` });
		const toLane = ledger.enqueue({ by: "surface", workloadId: wl, sliceId: sl, sender: "jo", recipient: "lane-a", body: "use the token" });
		const dead = ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-a", ledger.now(), 1) });
		const lines = errorLines(ledger);
		expect(lines.map((l) => l.kind)).toEqual(["artifact", "lane-died"]);
		expect(consumeLines(ledger, lines.filter((l) => l.kind === "artifact"))).toBe(2);
		expect([a, b, dead, toLane].map((id) => ledger.message(id)!.state)).toEqual(["delivered", "delivered", "held", "held"]);
		// the artifact count still reads delivered rows: the line stays until the slice passes or closes
		expect(errorLines(ledger).map((l) => l.kind)).toEqual(["artifact", "lane-died"]);
		expect(consumeAllToOrchestrator(ledger)).toBe(1);
		expect(ledger.message(dead)!.state).toBe("delivered");
		expect(ledger.message(toLane)!.state).toBe("held");
		// the death was surfaced once: it is not a line any more
		expect(errorLines(ledger).map((l) => l.kind)).toEqual(["artifact"]);
	});
});

describe("the ceiling question's stop at 100 % is a new state of its line (PLAN wl-mv5msri070p0qo D3)", () => {
	test("state `stopped` and the stop text once the newest lane-stop: is accepted ceiling, written at or after the question; Delivered takes it again", () => {
		const c = clock("2026-10-12T19:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
		// an earlier lane's accepted ceiling, before the question: not this question's stop
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-0 accepted ceiling" });
		c.plusHours(1);
		const sl = ledger.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: "sl-ceiling-1", task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
		const q = ledger.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl, body: "80 % of the ceiling", options: [...CEILING_OPTIONS] });
		const d = new Delivered();
		const at80 = errorLines(ledger).find((l) => l.rowId === q)!;
		expect(at80.state).toBeUndefined();
		expect(at80.line).not.toContain("stopped at the ceiling");
		expect(d.take([at80])).toHaveLength(1);
		// a stop for another reason changes nothing
		c.plusHours(1);
		const req = ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 requested mode-flip by jo" });
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `lane-stop: lane-t-1 accepted ${req}` });
		expect(errorLines(ledger).find((l) => l.rowId === q)!.state).toBeUndefined();
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 accepted ceiling" });
		const at100 = errorLines(ledger).find((l) => l.rowId === q)!;
		expect(at100.state).toBe("stopped");
		expect(at100.line.endsWith("(or `withdraw`); the lane stopped at the ceiling")).toBe(true);
		expect(d.take([at100])).toEqual([at100]);
		expect(d.take([at100])).toEqual([]);
		// any other question on the workload keeps its state
		const other = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: sl, body: "Unrelated?", options: ["yes", "no"] });
		expect(errorLines(ledger).find((l) => l.rowId === other)!.state).toBeUndefined();
	});
});

describe("between wakes: a line written by another connection after the wake reaches the running surface once", () => {
	test("next turn's context carries it under 'needs you (new since your last turn)'; the turn after does not; a wake re-renders everything and reseeds", async () => {
		const f = fakePi();
		const e = env();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const wake = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as Started;
		expect(wake.messages[0]!.content).toContain("(wake: session-start)");
		await f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx);
		expect(texts(await f.emit("before_agent_start", { prompt: "ok", systemPrompt: [] }, ctx))).toEqual([count(0)]);
		// a second real connection (a lane) writes after the wake
		const lane = open(e);
		const wl = lane.openWorkload({ by: "lane-b", brief: "Written after the wake", stakes: "normal", mode: "autonomous" });
		const sl = lane.addSlice({ by: "lane-b", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const q = lane.raiseQuestion({ by: "lane-b", workloadId: wl, sliceId: sl, body: "Raised after the wake", options: ["p", "q"] });
		lane.close();
		const next = (await f.emit("before_agent_start", { prompt: "and?", systemPrompt: [] }, ctx)) as Started;
		expect(next.messages).toHaveLength(1);
		expect(next.messages[0]!.content).toMatch(/^## needs you \(new since your last turn\)\n- #1 lane on wl-.* is waiting on you \(q-/);
		expect(next.messages[0]!.content).toContain("Raised after the wake");
		expect(next.messages[0]!.content.endsWith(`\n\n${count(1)}`)).toBe(true);
		expect(texts(await f.emit("before_agent_start", { prompt: "thinking", systemPrompt: [] }, ctx))).toEqual([count(1)]);
		const lane2 = open(e);
		lane2.recordEntry({ by: "lane-b", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy it" });
		lane2.close();
		// compaction: the wake carries the whole queue again and reseeds the tracker
		await f.emit("session_compact", { type: "session_compact" }, ctx);
		const after = (await f.emit("before_agent_start", { prompt: "go on", systemPrompt: [] }, ctx)) as Started;
		expect(after.messages[0]!.content).toContain("(wake: compaction)");
		expect(after.messages[0]!.content).toContain(q);
		// the session's numbers survive the compaction's re-render: q keeps #1, the reserved request written since gets #2 though it sorts first
		expect(after.messages[0]!.content).toMatch(/\n- #2 reserved action waiting on you \(wl-.*\): deploy it[^\n]*\n- #1 lane on wl-.* is waiting on you \(q-/);
		await f.tool("orchestrator_wake_read").execute("2", { body: `resuming ${wl}` }, undefined, undefined, ctx);
		expect(texts(await f.emit("before_agent_start", { prompt: "still", systemPrompt: [] }, ctx))).toEqual([count(2)]);
	});

	test("a fresh routine line rides the next status batch as a turn-triggering aside, once; nothing while a wake is pending on a busy session; nothing before the interval (PLAN wl-mv8igegljun18g D1)", async () => {
		timers.length = 0;
		const f = fakePi();
		const e = env({ AGENT_SYSTEM_SURFACE_POLL_MS: "1234", AGENT_SYSTEM_SURFACE_STATUS_MS: "60000" });
		orchestratorSurface(f.pi, e);
		// busy: the poll cannot push the pending wake (an idle one would; surface/test/wake-push.test.ts), and pushes nothing else while it is pending
		const opts = { idle: false };
		const ctx = ctxOf(opts);
		const c = clock("2026-09-01T10:00:00.000Z");
		surfaceSession(ctx, e).now = c.now;
		const minute = () => c.at(new Date(Date.parse(c.now()) + 60_000).toISOString());
		await f.emit("session_start", { type: "session_start" }, ctx);
		expect(timers).toHaveLength(1);
		expect(timers[0]!.ms).toBe(1234);
		const poll = timers[0]!.fn;
		// wake pending on a busy session: the poll stays quiet (the wake carries everything)
		const lane = open(e);
		const { wl, sl } = workloadWithSlice(lane);
		const q = lane.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Before the wake", options: ["a", "b"] });
		minute();
		poll();
		expect(f.sent).toEqual([]);
		await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
		await f.tool("orchestrator_wake_read").execute("1", { body: `resuming ${wl}` }, undefined, undefined, ctx);
		opts.idle = true;
		poll();
		expect(f.sent).toEqual([]); // the wake delivered q already, and the interval restarted at its render
		lane.answerQuestion(q, { by: "surface", answer: "a", author: "jo", channel: "surface" });
		lane.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: `${ARTIFACT_FAILED_PREFIX} bun test exit 1` });
		lane.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: `${ARTIFACT_FAILED_PREFIX} bun test exit 1` });
		poll();
		expect(f.sent).toEqual([]); // routine: held for the batch
		minute();
		poll();
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]!.message.customType).toBe("surface-status");
		expect(needsOf(f.sent[0]!.message.content)).toContain(`slice ${sl} (${wl}) failed its runtime artifact 2 times`);
		expect(f.sent[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		await f.admit(f.sent[0]!, ctx);
		poll();
		expect(f.sent).toHaveLength(1);
		// the next turn does not repeat what the batch carried
		expect(texts(await f.emit("before_agent_start", { prompt: "ok", systemPrompt: [] }, ctx))).toEqual([count(0)]);
		// a third failure is a new state: in the next batch again
		lane.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: `${ARTIFACT_FAILED_PREFIX} bun test exit 1` });
		minute();
		poll();
		expect(f.sent).toHaveLength(2);
		expect(needsOf(f.sent[1]!.message.content)).toContain("failed its runtime artifact 3 times");
		lane.close();
	});

	test("a lease that lapses between wakes is written as a lane-died row by the surface's read and delivered once", async () => {
		timers.length = 0;
		const f = fakePi();
		// a day-long status interval: the death goes out on its own on-fire push, not inside a batch
		const e = env({ AGENT_SYSTEM_SURFACE_STATUS_MS: "86400000" });
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		const c = clock("2026-09-01T10:00:00.000Z");
		surfaceSession(ctx, e).now = c.now;
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
		await f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx);
		const lane = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: false, backup: false, backupOnOpen: false, clock: c.now });
		const { wl } = workloadWithSlice(lane);
		expect(lane.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 15 * 60_000 }).won).toBe(true);
		c.plusHours(1);
		timers[0]!.fn();
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]!.message.content).toMatch(/lane lane-a on wl-.* died: lease lapsed 2026-09-01T10:15:00\.000Z, 1 open slice\(s\)/);
		const deaths = lane.db.query<{ state: string; body: string }, [string]>("SELECT state, body FROM messages WHERE workload_id = ? AND body LIKE 'lane-died:%'").all(wl);
		expect(deaths).toEqual([{ state: "delivered", body: expect.stringContaining("lease lapsed 2026-09-01T10:15:00.000Z") }]);
		timers[0]!.fn();
		expect(f.sent).toHaveLength(1);
		expect(texts(await f.emit("before_agent_start", { prompt: "ok", systemPrompt: [] }, ctx))).toEqual([count(0)]);
		lane.close();
	});

	test("a lane that ended on purpose with open slices and no question rides a status batch once per exit entry, not every batch (MIGRATION.md item 68)", async () => {
		const { f, e, ctx, batch, needs } = await clocked("2026-09-01T10:00:00.000Z");
		// the lane's connection: launched, two slices, parked by hand with an intended exit and nobody holding it
		const lane = open(e);
		const { wl, sl } = workloadWithSlice(lane);
		lane.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		lane.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by surface" });
		expect(lane.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		await batch();
		expect(needs()).toEqual([]);
		lane.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		lane.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-a", { code: 0, signal: null, outcome: "completed" }) });
		await batch();
		expect(needs()).toHaveLength(1);
		expect(needsOf(needs()[0]!.message.content)).toBe(`- [worth knowing] lane lane-a on ${wl} ended (completed) with 2 open slice(s) and no question; relaunch, close, or instruct`);
		// the idle line said the exit: no second `lane ended` bullet for it
		expect(needs()[0]!.message.content).not.toContain(`lane lane-a ended on ${wl}`);
		expect(needs()[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		await batch();
		await batch();
		expect(needs()).toHaveLength(1);
		expect(texts(await f.emit("before_agent_start", { prompt: "ok", systemPrompt: [] }, ctx))).toEqual([count(0)]);
		// a relaunch that ends the same way is a new exit entry: in a batch again, once
		lane.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-b cause first requested-by surface" });
		expect(lane.claimWorkload(wl, { by: "lane-b", holder: "lane-b", leaseMs: 3_600_000 }).won).toBe(true);
		await batch();
		expect(needs()).toHaveLength(1);
		lane.releaseWorkload(wl, { by: "lane-b", holder: "lane-b" });
		lane.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-b", { code: 0, signal: null, outcome: "parked" }) });
		await batch();
		await batch();
		expect(needs()).toHaveLength(2);
		expect(needs()[1]!.message.content).toContain(`lane lane-b on ${wl} ended (parked) with 2 open slice(s)`);
		// a question raised on it replaces the idle line; the slice pauses so one slice stays open
		const q = lane.raiseQuestion({ by: "lane-b", workloadId: wl, sliceId: sl, body: "which?", options: ["x", "y"] });
		await batch();
		expect(needs()).toHaveLength(3);
		expect(needsOf(needs()[2]!.message.content)).toContain("is waiting on you");
		expect(needsOf(needs()[2]!.message.content)).not.toContain("ended (parked)");
		// answered: the same exit entry is back on the line, and it was already delivered (Codex review of PR #27)
		lane.answerQuestion(q, { by: "surface", answer: "x", author: "jo", channel: "surface" });
		await batch();
		await batch();
		expect(needs()).toHaveLength(3);
		expect(texts(await f.emit("before_agent_start", { prompt: "ok", systemPrompt: [] }, ctx))).toEqual([count(0)]);
		// a third lane that ends again is a newer exit entry: in a batch once
		lane.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-c cause first requested-by surface" });
		expect(lane.claimWorkload(wl, { by: "lane-c", holder: "lane-c", leaseMs: 3_600_000 }).won).toBe(true);
		lane.releaseWorkload(wl, { by: "lane-c", holder: "lane-c" });
		lane.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-c", { code: 0, signal: null, outcome: "completed" }) });
		await batch();
		await batch();
		expect(needs()).toHaveLength(4);
		expect(needs()[3]!.message.content).toContain(`lane lane-c on ${wl} ended (completed) with 2 open slice(s)`);
		lane.close();
	});

	test("a plan question offering approve rides the status batch whole: the path on the line beneath the q- id, each other line indented under it (PLAN wl-muq22rnjcfrrpc D8, PLAN wl-mv61a8dh4aeneo D2)", async () => {
		const { e, batch, needs } = await clocked("2026-09-01T10:00:00.000Z");
		const plan = [
			"/Users/jo/agent-scratch/wl-x/PLAN.md",
			"- sl-flip: plan-first by default unless the judge says change-small at 0.9 or Jo says no plan",
			"- sl-inline: the plan question carries the plan, one line per slice, checked by lane_raise_question",
			"- sl-docs: SPEC § B6, the lane tier file and MIGRATION.md item 42",
			"- sl-review: a cross-lab review of the whole diff",
			"tradeoff: more plans on small work, fewer large changes without one",
			"tradeoff: the lane writes the summary; nothing is extracted from PLAN.md",
			"review: approve-as-is, openai-codex/gpt-6-sol, /Users/jo/agent-scratch/wl-x/PLAN-REVIEW-r9.md",
		];
		// the lane's connection: a plan-first workload it holds, its plan question and the plan-question: entry in one transaction
		const lane = open(e);
		const { wl, sl } = workloadWithSlice(lane);
		lane.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
		expect(lane.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
		const q = lane.write(() => {
			const id = lane.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: plan.join("\n"), options: ["approve", "revise", "cancel"] });
			lane.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${id}` });
			return id;
		});
		lane.close();
		await batch();
		expect(needs()).toHaveLength(1);
		expect(needsOf(needs()[0]!.message.content)).toBe(
			`- [worth knowing] #1 lane on ${wl} is waiting on you (${q}, slice ${sl}):\n  ${plan.join("\n  ")} — answer with one word: approve / revise / cancel (or \`withdraw\`)`,
		);
		expect(needs()[0]!.message.content.endsWith(`\n\n${count(1)}`)).toBe(true);
	});
});
