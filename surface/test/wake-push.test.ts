// Ilex speaks first (MIGRATION.md item 37; PLAN.md rev 8 of wl-muq0ex1024xtkw, § Tests W1–W9, N1–N6; W10 from review round 1):
// a pending wake (launch, restart, compaction) is pushed as an aside when the session is idle and
// confirmed by its `message_end`, or rides Jo's turn; the tick's notices are pushed the same way from
// their own queue. The test plays OMP's part: it fires the one-shot (ctx.setTimeout) and the poll
// (ctx.setInterval), emits `message_end` for a pushed message the way OMP admits it, keeps unconfirmed
// sends as OMP's ACP branch would, and runs the `context` hook over what would reach the model.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_MARKER } from "../../gates/src/rows/r02-contract";
import { Ledger } from "../../ledger/src/index";
import { launchVerdict } from "../extensions/launch";
import orchestratorSurface from "../index";
import { doneBody, planFirstBody } from "../src/launch";
import { surfaceSession } from "../src/session";
import { SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, type Sent, timeouts, timers, tmp } from "./helpers";

const APPLIED = "## Applied from the surface since your last turn";
type Turn = { systemPrompt: string[]; messages: Sent["message"][] };
type Key = { surfaceKey: string; renderSeq: number };

function env(over: Record<string, string> = {}): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const contract = join(tmp("contract"), "output-types.md");
	writeFileSync(contract, "CONTRACT DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, AGENT_SYSTEM_CONTRACT: contract, HOME: "/nonexistent-home", ...over };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}

/** An orchestrator surface on a fake host: `opts.idle` is read at every isIdle() call, so a test flips it between ticks. */
function surface(o: { resumed?: boolean; idle?: boolean; env?: Record<string, string> } = {}) {
	timers.length = 0;
	timeouts.length = 0;
	const f = fakePi(undefined, { exec: true });
	const e = env(o.env);
	orchestratorSurface(f.pi, e, {});
	const opts = { resumed: o.resumed, idle: o.idle ?? true };
	const ctx = ctxOf(opts);
	return {
		f,
		e,
		ctx,
		opts,
		of: (customType: string): Sent[] => f.sent.filter((x) => x.message.customType === customType),
		start: () => f.emit("session_start", { type: "session_start" }, ctx),
		compact: () => f.emit("session_compact", { type: "session_compact" }, ctx),
		/** One tick of the poll interval: the poll, then the launch catch-up (synchronous on the stuck path). */
		tick: () => timers[0]!.fn(),
		/** Fire every one-shot registered so far. */
		fire: () => {
			for (const t of timeouts.splice(0)) t.fn();
		},
		jo: async (prompt = "hi") => (await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as Turn,
		bashBlocked: async () => ((await f.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx)) as { block?: boolean } | undefined)?.block === true,
		read: () => f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx),
		admit: (m: Sent) => f.admit(m, ctx),
		s: () => surfaceSession(ctx, e),
	};
}

/** The by-hand shape of L1 (lane-smoke.test.ts `byHand`, no git): released, its holder's done-because: standing, one slice still open. */
function stuck(e: Record<string, string>) {
	const l = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Add a verify line to the README", stakes: "normal", mode: "autonomous" });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("README.md carries a verify line") });
	const hand = "lane-plumb-by-hand";
	expect(l.claimWorkload(wl, { by: hand, holder: hand, leaseMs: 60_000 }).won).toBe(true);
	l.addSlice({ by: hand, workloadId: wl, task: "add the line", doneCondition: "README has the line", inputs: "README.md" });
	l.recordEntry({ by: hand, workloadId: wl, kind: "assumption", body: "done-because: README.md carries a verify line\nchecked by reading it" });
	l.releaseWorkload(wl, { by: hand, holder: hand });
	expect(launchVerdict(l, e, wl)).toEqual({ launch: false, reason: "awaiting-close" });
	l.close();
	return {
		wl,
		line: (open: number) => `tick: ${wl} is finished but cannot close: ${open} open slice(s), 0 paused, 0 open question(s) — resolve them or close by hand`,
		/** Another open slice: the counts change, so the next tick tells it again. */
		addSlice: () => {
			const l2 = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
			l2.addSlice({ by: SURFACE_BY, workloadId: wl, task: "one more", doneCondition: "d", inputs: "i" });
			l2.close();
		},
	};
}

/** The lines under the turn's "Applied" heading, up to the blank line before its count line, or [] when the turn has none. */
const appliedOf = (turn: Turn): string[] => {
	const text = turn.messages.map((m) => m.content).join("\n");
	return text.includes(APPLIED) ? text.split(APPLIED)[1]!.trim().split("\n\n")[0]!.split("\n") : [];
};
/** A pushed or turn message as it sits in the model's context (a custom-role AgentMessage). */
const asContext = (m: { customType: string; content: string; display: boolean; details?: unknown }) => ({ role: "custom", ...m, timestamp: 0 });
const keyOf = (m: { details?: unknown }) => (m.details as Key | undefined)?.surfaceKey;
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("Fix 1: a pending wake is pushed as an aside, and confirmed", () => {
	test("T4: space-bearing ledger paths link synchronously without changing wake retries or notice confirmation", async () => {
		const t = surface();
		const path = join(tmp("linked-wake"), "PLAN with spaces.md");
		writeFileSync(path, "# Plan\n");
		const target = new URL(`file://${path}`).href;
		const linked = `[${path}](${target})`;
		const l = Ledger.open(t.e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "Review plan", stakes: "normal", mode: "user-driven" });
		const sl = l.addSlice({ by: "lane-a", workloadId: wl, task: "plan", doneCondition: "reviewed", inputs: path });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
		expect(l.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
		l.write(() => {
			const q = l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: path, options: ["approve", "revise"] });
			l.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${q}` });
		});
		l.close();
		await t.start();
		t.fire();
		const first = t.of("surface-wake")[0]!;
		expect(first.message.content).toContain(linked);
		const key = `wake:${t.s().wakeInFlight!.wakeId}`;
		expect(keyOf(first.message)).toBe(key);
		expect(t.s().wakeInFlight!.tries).toBe(1);
		t.s().tickNotices.push(`tick: reviewed ${path}`);
		t.tick();
		expect(t.s().wakeInFlight!.tries).toBe(2);
		t.tick();
		expect(t.s().wakeInFlight!.tries).toBe(3);
		expect(t.of("surface-wake").map((m) => keyOf(m.message))).toEqual([key, key, key]);
		expect(t.of("surface-notices")).toHaveLength(0);
		await t.admit(first);
		expect(t.s().wakeInFlight).toBeNull();
		t.tick();
		const notice = t.of("surface-notices");
		expect(notice).toHaveLength(1);
		expect(notice[0]!.message.content).toContain(`tick: reviewed ${linked}`);
	});

	test("W1 launch: the one-shot pushes the wake with the voice and contract inlined; bash is owed; message_end confirms; Jo's next turn carries no wake; the read clears the block", async () => {
		const t = surface();
		await t.start();
		expect(timeouts.map((x) => x.ms)).toEqual([1000]);
		t.fire();
		const wakes = t.of("surface-wake");
		expect(wakes).toHaveLength(1);
		const content = wakes[0]!.message.content;
		expect(content).toContain("(wake: session-start)");
		expect(content).toContain(`[${t.e.AGENT_SYSTEM_VOICE}](${new URL(`file://${t.e.AGENT_SYSTEM_VOICE}`).href})`);
		expect(content).toContain("VOICE DOC BODY");
		expect(content).toContain(`${CONTRACT_MARKER}\nCONTRACT DOC BODY`);
		expect(content.indexOf("VOICE DOC BODY")).toBeLessThan(content.indexOf("(wake: session-start)"));
		expect(content.indexOf("CONTRACT DOC BODY")).toBeLessThan(content.indexOf("(wake: session-start)"));
		expect(content).toContain("This turn owes one wake-read entry");
		expect(wakes[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(keyOf(wakes[0]!.message)).toMatch(/^wake:/);
		expect(await t.bashBlocked()).toBe(true);
		await t.admit(wakes[0]!);
		const turn = await t.jo();
		expect(turn.messages.map((m) => m.content).join("\n")).not.toContain("(wake:");
		expect(await t.bashBlocked()).toBe(true);
		await t.read();
		expect(await t.bashBlocked()).toBe(false);
		t.tick();
		expect(t.of("surface-wake")).toHaveLength(1);
	});

	test("W2 restart: a resumed session's wake goes out from the poll interval, voice inlined", async () => {
		const t = surface({ resumed: true });
		await t.start();
		t.tick();
		const wakes = t.of("surface-wake");
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.message.content).toContain("(wake: restart)");
		expect(wakes[0]!.message.content).toContain("VOICE DOC BODY");
		expect(await t.bashBlocked()).toBe(true);
	});

	test("W3 compaction: after a Jo-typed wake and its read, the compaction's one-shot pushes one aside without the voice (the prompt is primed); owed again", async () => {
		const t = surface({ env: { AGENT_SYSTEM_SURFACE_WAKE_PUSH_MS: "250" } });
		await t.start();
		expect((await t.jo()).messages[0]!.content).toContain("(wake: session-start)");
		await t.read();
		expect(await t.bashBlocked()).toBe(false);
		await t.compact();
		expect(timeouts.map((x) => x.ms)).toEqual([250, 250]);
		t.fire();
		const wakes = t.of("surface-wake");
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.message.content).toContain("(wake: compaction)");
		expect(wakes[0]!.message.content).not.toContain("VOICE DOC BODY");
		expect(wakes[0]!.message.content).not.toContain("CONTRACT DOC BODY");
		expect(await t.bashBlocked()).toBe(true);
	});

	test("W4 Jo first: Jo's turn renders the wake; the one-shot and two polls push nothing", async () => {
		const t = surface();
		await t.start();
		expect((await t.jo()).messages[0]!.content).toContain("(wake: session-start)");
		t.fire();
		t.tick();
		t.tick();
		expect(t.f.sent).toEqual([]);
	});

	test("W5 busy: nothing is pushed while the session is busy; the wake stays pending for Jo's turn", async () => {
		const t = surface({ idle: false });
		await t.start();
		t.fire();
		t.tick();
		t.tick();
		expect(t.f.sent).toEqual([]);
		expect((await t.jo()).messages[0]!.content).toContain("(wake: session-start)");
	});

	test("W6 not admitted: the same content is sent 3 times in all, then nothing; the wake is pending again, bash is free, and Jo's turn renders it once", async () => {
		const t = surface();
		await t.start();
		t.tick();
		t.tick();
		t.tick();
		const wakes = t.of("surface-wake");
		expect(wakes).toHaveLength(3);
		expect(new Set(wakes.map((w) => w.message.content)).size).toBe(1);
		expect(new Set(wakes.map((w) => keyOf(w.message))).size).toBe(1);
		t.tick();
		t.tick();
		expect(t.of("surface-wake")).toHaveLength(3);
		expect(t.s().pending).toBe("session-start");
		expect(await t.bashBlocked()).toBe(false);
		const turn = await t.jo();
		expect(occurrences(turn.messages.map((m) => m.content).join("\n"), "(wake: session-start)")).toBe(1);
		expect(await t.bashBlocked()).toBe(true);
		t.tick();
		expect(t.of("surface-wake")).toHaveLength(3);
	});

	test("W7 Jo types while the push is in flight: his turn renders the wake; the next poll sends nothing", async () => {
		const t = surface();
		await t.start();
		t.fire();
		expect(t.of("surface-wake")).toHaveLength(1);
		const turn = await t.jo();
		expect(turn.messages[0]!.content).toContain("(wake: session-start)");
		expect(keyOf(turn.messages[0]!)).toBe(keyOf(t.of("surface-wake")[0]!.message));
		t.tick();
		t.tick();
		expect(t.f.sent).toHaveLength(1);
		expect(await t.bashBlocked()).toBe(true);
	});

	test("W8 duplicate guard: after the last assistant message, one message per surfaceKey survives, the newest by renderSeq; other keys, unkeyed messages and earlier history are kept", async () => {
		const t = surface();
		const keyed = (customType: string, surfaceKey: string, renderSeq: number, content: string) => ({ role: "custom", customType, content, display: true, details: { surfaceKey, renderSeq }, timestamp: 0 });
		const earlier = [{ role: "user", content: "hi", timestamp: 0 }, keyed("surface-wake", "wake:0", 1, "old wake a"), keyed("surface-wake", "wake:0", 2, "old wake b"), { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 }];
		const tail = [
			keyed("surface-wake", "wake:1", 1, "wake copy 1"),
			keyed("surface-notices", "notices:1", 3, "notice copy 1"),
			keyed("surface-wake", "wake:1", 2, "wake copy 2"),
			{ role: "custom", customType: "surface-needs-you", content: "unkeyed", display: true, timestamp: 0 },
			keyed("surface-notices", "notices:1", 4, "notice copy 2"),
		];
		const out = await t.f.context([...earlier, ...tail], t.ctx);
		expect(out).toEqual([...earlier, tail[2], tail[3], tail[4]]);
	});

	test("W9 fallback under ACP defer: the 3 deferred copies and Jo's render share one key; only Jo's render survives the guard", async () => {
		const t = surface();
		await t.start();
		t.tick();
		t.tick();
		t.tick();
		t.tick();
		const deferred = t.of("surface-wake").map((w) => asContext(w.message));
		expect(deferred).toHaveLength(3);
		const turn = await t.jo();
		const render = asContext(turn.messages[0]!);
		const out = (await t.f.context([{ role: "user", content: "hi", timestamp: 0 }, ...deferred, render], t.ctx)) as { customType?: string }[];
		const wakes = out.filter((m) => m.customType === "surface-wake");
		expect(wakes).toEqual([render]);
		expect(render.content).toContain("(wake: session-start)");
	});

	test("W10 a new trigger retires the old wake's deferred copies: a compaction before Jo types leaves only the new wake in his prompt", async () => {
		const t = surface();
		await t.start();
		t.fire();
		const old = t.of("surface-wake").map((w) => asContext(w.message));
		expect(old).toHaveLength(1);
		await t.compact();
		const turn = await t.jo();
		const render = asContext(turn.messages[0]!);
		expect(render.content).toContain("(wake: compaction)");
		expect(keyOf(render)).not.toBe(keyOf(old[0]!));
		const out = (await t.f.context([{ role: "user", content: "hi", timestamp: 0 }, ...old, render], t.ctx)) as { customType?: string }[];
		const wakes = out.filter((m) => m.customType === "surface-wake");
		expect(wakes).toEqual([render]);
	});

	test("W11 the count line (PLAN wl-mv5msri070p0qo D3): Jo's turn that renders the wake ends with it, under its key, and so does a turn with nothing else to carry", async () => {
		const t = surface();
		const l = Ledger.open(t.e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "Count me", stakes: "normal", mode: "autonomous" });
		const sl = l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["a", "b"] });
		l.close();
		await t.start();
		const turn = await t.jo();
		expect(turn.messages).toHaveLength(1);
		expect(turn.messages[0]!.content).toContain("(wake: session-start)");
		expect(turn.messages[0]!.content.endsWith("\n\nopen answer lines: 1 (`pending` shows them all)")).toBe(true);
		expect(keyOf(turn.messages[0]!)).toMatch(/^wake:/);
		await t.read();
		expect((await t.jo("next")).messages.map((m) => m.content)).toEqual(["open answer lines: 1 (`pending` shows them all)"]);
	});
});

describe("Fix 2: the tick's notices are pushed from their own queue, and confirmed", () => {
	/** A surface whose wake Jo already took and read. */
	async function awake(o: { idle?: boolean } = {}) {
		const t = surface(o);
		await t.start();
		await t.jo();
		await t.read();
		return t;
	}

	test("N1 a tick notice is pushed as an aside; once confirmed, Jo's next turn carries no Applied block and the same state sends nothing", async () => {
		const t = await awake();
		const w = stuck(t.e);
		t.tick();
		const pushed = t.of("surface-notices");
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.message.content).toBe(`${APPLIED}\n- ${w.line(1)}`);
		expect(pushed[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(keyOf(pushed[0]!.message)).toMatch(/^notices:/);
		await t.admit(pushed[0]!);
		expect(appliedOf(await t.jo())).toEqual([]);
		t.tick();
		expect(t.of("surface-notices")).toHaveLength(1);
	});

	/** N2's shared start: a tick line queued while the wake is pending rides the wake aside; a second line queued after it goes out alone. */
	async function ridesTheWake() {
		const t = surface({ idle: false });
		const w = stuck(t.e);
		await t.start();
		t.tick(); // busy: the wake stays pending, the tick's line waits for it
		expect(t.f.sent).toEqual([]);
		t.opts.idle = true;
		t.tick();
		const wakes = t.of("surface-wake");
		expect(wakes).toHaveLength(1);
		expect(occurrences(wakes[0]!.message.content, `- ${w.line(1)}`)).toBe(1);
		expect(t.of("surface-notices")).toEqual([]);
		w.addSlice();
		t.opts.idle = false;
		t.tick(); // busy: the second line is queued after the render
		expect(t.f.sent).toHaveLength(1);
		await t.admit(wakes[0]!);
		t.opts.idle = true;
		t.tick();
		const pushed = t.of("surface-notices");
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.message.content).toBe(`${APPLIED}\n- ${w.line(2)}`);
		return { t, w, pushed: pushed[0]! };
	}

	test("N2 rides the wake: the line queued while the wake was pending goes out once inside it; the later line goes out alone; confirmed, Jo's turn carries neither", async () => {
		const { t, pushed } = await ridesTheWake();
		await t.admit(pushed);
		expect(appliedOf(await t.jo())).toEqual([]);
	});

	test("N2 variant: the later batch left unconfirmed reaches Jo's turn alone, never the line the wake carried", async () => {
		const { t, w } = await ridesTheWake();
		expect(appliedOf(await t.jo())).toEqual([`- ${w.line(2)}`]);
		t.tick();
		expect(t.of("surface-notices")).toHaveLength(1);
	});

	test("N3 echoes stay with Jo's turn: only the tick notice is pushed; the word echo arrives in that turn's message", async () => {
		const t = await awake();
		const w = stuck(t.e);
		t.s().notices.push(`stakes on ${w.wl} → production`);
		t.tick();
		const pushed = t.of("surface-notices");
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.message.content).toBe(`${APPLIED}\n- ${w.line(1)}`);
		await t.admit(pushed[0]!);
		expect(appliedOf(await t.jo())).toEqual([`- stakes on ${w.wl} → production`]);
	});

	test("N4 a dropped batch is resent at the next two polls, then nothing, even with a new line queued; Jo's turn carries the old and the new line once each", async () => {
		const t = await awake();
		const w = stuck(t.e);
		t.tick();
		t.tick();
		t.tick();
		const pushed = t.of("surface-notices");
		expect(pushed).toHaveLength(3);
		expect(new Set(pushed.map((p) => p.message.content))).toEqual(new Set([`${APPLIED}\n- ${w.line(1)}`]));
		expect(new Set(pushed.map((p) => keyOf(p.message))).size).toBe(1);
		t.tick();
		w.addSlice();
		t.tick();
		expect(t.of("surface-notices")).toHaveLength(3);
		expect(appliedOf(await t.jo())).toEqual([`- ${w.line(1)}`, `- ${w.line(2)}`]);
		t.tick();
		expect(t.of("surface-notices")).toHaveLength(3);
	});

	test("N5 distinct batches survive the guard: two batches confirmed by fold-style message_end leave the queue empty, both reach the model, and Jo's turn renders neither again", async () => {
		const t = await awake();
		const w = stuck(t.e);
		t.tick();
		await t.admit(t.of("surface-notices")[0]!);
		w.addSlice();
		t.tick();
		const pushed = t.of("surface-notices");
		expect(pushed).toHaveLength(2);
		await t.admit(pushed[1]!);
		expect(keyOf(pushed[0]!.message)).not.toBe(keyOf(pushed[1]!.message));
		expect(t.s().tickNotices).toEqual([]);
		const tail = pushed.map((p) => asContext(p.message));
		expect(await t.f.context([{ role: "assistant", content: [], timestamp: 0 }, ...tail], t.ctx)).toEqual([{ role: "assistant", content: [], timestamp: 0 }, ...tail]);
		expect(appliedOf(await t.jo())).toEqual([]);
	});

	test("N6 notice fallback under ACP defer: the 3 deferred copies give way to Jo's render, which carries the old and the newer line", async () => {
		const t = await awake();
		const w = stuck(t.e);
		t.tick();
		t.tick();
		t.tick();
		t.tick();
		w.addSlice();
		t.tick();
		const deferred = t.of("surface-notices").map((p) => asContext(p.message));
		expect(deferred).toHaveLength(3);
		const turn = await t.jo();
		const render = asContext(turn.messages[0]!);
		expect(keyOf(render)).toBe(keyOf(deferred[0]!));
		const out = (await t.f.context([...deferred, render], t.ctx)) as { content?: string }[];
		const carrying = out.filter((m) => typeof m.content === "string" && m.content.includes(w.line(1)));
		expect(carrying).toEqual([render]);
		expect(appliedOf(turn)).toEqual([`- ${w.line(1)}`, `- ${w.line(2)}`]);
	});
});
