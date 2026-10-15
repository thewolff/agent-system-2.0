// Ilex speaks first (PLAN wl-mv8igegljun18g, § Tests S1–S16): the status clock, the graded batch, the told set and
// its floor, the delta cap, confirmation, retirement and takeover, the quiet line, brb / back, and the durable
// cursor. Integration tests run the real surface on the fake host the wake tests use, over a scratch ledger written
// through the ledger module; the test plays OMP's part (the poll, `message_end`, Jo's turn) and moves the session
// clock and the lane connection's clock together, so the 15-minute interval is measured on it.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { laneExitBody, planFirstBody } from "../src/launch";
import { surfaceSession } from "../src/session";
import { laneDiedShutdownBody } from "../src/signals";
import { DELTA_CHARS, type Grade, selectDelta, StatusCore, type StatusItem } from "../src/status";
import { gradeOf, type IlexKind, messageKind } from "../src/status-ilex";
import { testRunFailedBody } from "../src/test-run";
import { ARTIFACT_PASSED_PREFIX, ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { clock, ctxOf, fakePi, notices, notified, type Sent, timeouts, timers, tmp, workloadWithSlice } from "./helpers";

const START = "2026-10-12T19:00:00.000Z";
const count = (n: number) => `open answer lines: ${n} (\`pending\` shows them all)`;
type Turn = { systemPrompt: string[]; messages: Sent["message"][] };

function env(): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	return { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
}

/**
 * An orchestrator surface past its first wake (taken by Jo's first turn at START, read recorded), a lane connection on
 * the same clock, and `before` run on that connection before the session starts (the clock is back at START after it).
 */
async function surface(o: { e?: Record<string, string>; before?: (l: Ledger, c: ReturnType<typeof clock>) => void } = {}) {
	timers.length = 0;
	timeouts.length = 0;
	notices.length = 0;
	notified.length = 0;
	const e = o.e ?? env();
	const c = clock(START);
	const lane = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false, clock: c.now });
	o.before?.(lane, c);
	c.at(START);
	const f = fakePi(undefined, { exec: true });
	orchestratorSurface(f.pi, e, {});
	const opts = { idle: true };
	const ctx = ctxOf(opts);
	const s = surfaceSession(ctx, e);
	s.now = c.now;
	await f.emit("session_start", { type: "session_start" }, ctx);
	const first = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as Turn;
	await f.tool("orchestrator_wake_read").execute("1", { body: "resuming" }, undefined, undefined, ctx);
	const status = (): Sent[] => f.sent.filter((x) => x.message.customType === "surface-status");
	const t = {
		f, e, ctx, s, c, lane, opts,
		first: first.messages.map((m) => m.content).join("\n"),
		status,
		/** Status batches that start a turn. */
		batches: (): Sent[] => status().filter((x) => JSON.stringify(x.options) === JSON.stringify({ deliverAs: "aside", triggerTurn: true })),
		/** Quiet lines: the same custom type, sent with no options (no turn). */
		quiet: (): Sent[] => status().filter((x) => JSON.stringify(x.options) === "{}"),
		needsYou: (): Sent[] => f.sent.filter((x) => x.message.customType === "surface-needs-you"),
		wakes: (): Sent[] => f.sent.filter((x) => x.message.customType === "surface-wake"),
		admit: (m: Sent) => f.admit(m, ctx),
		poll: () => timers[0]!.fn(),
		minutes: (m: number) => c.at(new Date(Date.parse(c.now()) + m * 60_000).toISOString()),
		/** `minutes` (default fifteen) on and one poll: the status batch (or quiet line) it sent, confirmed unless `admit` is false; or undefined. */
		due: async (o2: { admit?: boolean; minutes?: number } = {}): Promise<Sent | undefined> => {
			t.minutes(o2.minutes ?? 15);
			const before = f.sent.length;
			timers[0]!.fn();
			const sent = f.sent.slice(before).find((x) => x.message.customType === "surface-status");
			if (sent && o2.admit !== false) await f.admit(sent, ctx);
			return sent;
		},
		jo: async (prompt = "ok"): Promise<string> => ((await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as Turn).messages.map((m) => m.content).join("\n"),
		type: (text: string) => f.emit("input", { text, source: "interactive" }, ctx),
		read: async (params: Record<string, unknown> = {}): Promise<string> => (await f.tool("orchestrator_ledger").execute("1", params, undefined, undefined, ctx)).content[0]!.text,
		compact: () => f.emit("session_compact", { type: "session_compact" }, ctx),
	};
	return t;
}

const keyOf = (m: { details?: unknown }): string | undefined => {
	const d = m.details;
	return typeof d === "object" && d !== null && "surfaceKey" in d && typeof d.surfaceKey === "string" ? d.surfaceKey : undefined;
};
const asContext = (m: { customType: string; content: string; display: boolean; details?: unknown }) => ({ role: "custom", ...m, timestamp: 0 });
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
/** A batch's `## <name>` section, or null. */
const sectionOf = (content: string, name: string): string | null => (content.includes(`\n\n## ${name}\n`) ? content.split(`\n\n## ${name}\n`)[1]!.split("\n\n")[0]! : null);
const say = (l: Ledger, wl: string, body: string, sliceId?: string) => l.enqueue({ by: "lane-a", workloadId: wl, sliceId: sliceId ?? null, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body });
const ask = (l: Ledger, wl: string, sl: string, body: string) => l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body, options: ["yes", "no"] });
const answer = (l: Ledger, q: string) => l.answerQuestion(q, { by: "surface", answer: "yes", author: "jo", channel: "surface" });
/** A lane that launched, started (`lane-started:` by the runner), held the workload, released it and exited `outcome`. */
function laneRun(l: Ledger, wl: string, laneId: string, outcome: string, between?: () => void) {
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${laneId} cause first requested-by surface` });
	l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `lane-started: ${laneId} {"pid":7}` });
	expect(l.claimWorkload(wl, { by: laneId, holder: laneId, leaseMs: 3_600_000 }).won).toBe(true);
	between?.();
	l.releaseWorkload(wl, { by: laneId, holder: laneId });
	l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: 0, signal: null, outcome }) });
}
/** A workload with no slices, closed. */
function closedWorkload(l: Ledger, brief: string, message?: string): { wl: string; m: string | null } {
	const wl = l.openWorkload({ by: "lane-a", brief, stakes: "normal", mode: "autonomous" });
	const m = message === undefined ? null : say(l, wl, message);
	l.closeWorkload(wl, { by: SURFACE_BY });
	return { wl, m };
}
/** A plan-first workload held by `holder` whose slice raised the plan question (`path` its body's first line), with the holder's `plan-question:` entry in the same write. */
function seedPlan(l: Ledger, path: string, holder = "lane-a"): { wl: string; sl: string; q: string } {
	const { wl, sl } = workloadWithSlice(l, { brief: `Plan held by ${holder}` });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	expect(l.claimWorkload(wl, { by: holder, holder, leaseMs: null }).won).toBe(true);
	const q = l.write(() => {
		const id = l.raiseQuestion({ by: holder, workloadId: wl, sliceId: sl, body: [path, "- sl-build: build it"].join("\n"), options: ["approve", "revise", "cancel"] });
		l.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${id}` });
		return id;
	});
	return { wl, sl, q };
}

describe("S1 grading", () => {
	test("S1 each item kind has its fixed grade; a prefixed message is noise; unchanged workloads collapse to one count on the quiet line", async () => {
		const expected: Record<IlexKind, string> = {
			"on-fire-line": "on fire",
			line: "worth knowing", "workload-opened": "worth knowing", "workload-closed": "worth knowing", "lane-started": "worth knowing", "lane-ended": "worth knowing",
			"slice-changed": "worth knowing", tick: "worth knowing", "lane-message": "worth knowing",
			"slice-cut": "noise", "signal-message": "noise", unchanged: "noise",
		};
		for (const [kind, grade] of Object.entries(expected)) expect(gradeOf(kind as IlexKind)).toBe(grade as ReturnType<typeof gradeOf>);
		expect(messageKind(`${ARTIFACT_PASSED_PREFIX} bun test exit 0`)).toBe("signal-message");
		expect(messageKind("launch: lane-x cause first requested-by surface")).toBe("signal-message");
		expect(messageKind("the header offset lives in tokens.css now")).toBe("lane-message");
		const t = await surface({ before: (l) => {
			workloadWithSlice(l);
			workloadWithSlice(l);
		} });
		await t.due();
		expect(t.batches()).toEqual([]);
		expect(t.quiet()).toHaveLength(1);
		expect(t.quiet()[0]!.message.content).toBe(`status 19:15Z: no change since 19:00Z · 2 workloads in flight · open answer lines: 0\n- [noise] 2 other workloads in flight, no change`);
	});
});

describe("S2 in flight from the ledger", () => {
	test("S2 done, cancelled, paused→open, cut-and-done, opened-and-closed, lane started / ended: each listed once; a re-pause after a read lists again; a batch with no writes lists none", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			const { wl, sl } = workloadWithSlice(l);
			ids.wl = wl;
			ids.a = sl;
			ids.b = l.addSlice({ by: "lane-a", workloadId: wl, task: "b task", doneCondition: "d", inputs: "i" });
			ids.c = l.addSlice({ by: "lane-a", workloadId: wl, task: "c task", doneCondition: "d", inputs: "i" });
			ids.d = l.addSlice({ by: "lane-a", workloadId: wl, task: "d task", doneCondition: "d", inputs: "i" });
			const w3 = workloadWithSlice(l, { brief: "Third workload" });
			ids.w3 = w3.wl;
			ids.s3 = w3.sl;
		} });
		const { wl, a, b, c, d, w3, s3 } = ids as Record<string, string>;
		t.minutes(1);
		t.lane.completeSlice(a!, { by: "lane-a", artifact: "bun test exit 0" });
		t.lane.cancelSlice(b!, { by: "lane-a" });
		answer(t.lane, ask(t.lane, wl!, c!, "pause c?"));
		const e = t.lane.addSlice({ by: "lane-a", workloadId: wl!, task: "e task", doneCondition: "d", inputs: "i" });
		t.lane.completeSlice(e, { by: "lane-a", artifact: "done" });
		const w2 = closedWorkload(t.lane, "Opened and closed inside one interval").wl;
		laneRun(t.lane, w3!, "lane-s", "completed", () => t.lane.completeSlice(s3!, { by: "lane-s", artifact: "ok" }));
		const batch = (await t.due())!;
		const inFlight = sectionOf(batch.message.content, "in flight")!;
		for (const line of [
			`slice ${a} on ${wl} done: Move the header offset into a token`,
			`slice ${b} on ${wl} cancelled: b task`,
			`slice ${c} on ${wl} reopened: c task (changed 2 times)`,
			`slice ${e} on ${wl} cut and done: e task`,
			`${w2} opened: Opened and closed inside one interval`,
			`${w2} closed: Opened and closed inside one interval`,
			`lane lane-s started on ${w3}`,
			`lane lane-s ended on ${w3} (completed)`,
			`slice ${s3} on ${w3} done: Move the header offset into a token`,
		]) expect(occurrences(inFlight, `] ${line}`)).toBe(1);
		// d paused, told by a confirmed read; re-opened and paused again: a new identity, listed again once
		t.minutes(1);
		const q2 = ask(t.lane, wl!, d!, "pause d?");
		expect(await t.read()).toContain(`- ${d} [paused] d task`);
		answer(t.lane, q2);
		ask(t.lane, wl!, d!, "pause d again?");
		const second = (await t.due())!;
		expect(occurrences(sectionOf(second.message.content, "in flight")!, `slice ${d} on ${wl}`)).toBe(1);
		expect(sectionOf(second.message.content, "in flight")).toContain(`slice ${d} on ${wl} paused: d task (changed 2 times)`);
		// no writes since: nothing in flight is listed again
		const third = (await t.due())!;
		expect(third.message.content).not.toContain(`slice ${d}`);
		expect(third.message.content).not.toContain(`slice ${a}`);
		expect(third.message.content).not.toContain(w2);
	});
});

describe("S3 the status clock", () => {
	test("S3 none before the interval; one at the first idle poll after; none while busy, while a wake is pending or in flight, while a batch is in flight or fell back; a wake render resets it", async () => {
		const t = await surface({ before: (l) => void workloadWithSlice(l) });
		t.minutes(14);
		t.poll();
		expect(t.status()).toEqual([]);
		t.minutes(1);
		t.opts.idle = false;
		t.poll();
		expect(t.status()).toEqual([]);
		// a wake pending (busy: it cannot be pushed), then in flight: no batch
		await t.compact();
		t.poll();
		expect(t.status()).toEqual([]);
		t.opts.idle = true;
		t.poll();
		expect(t.wakes()).toHaveLength(1);
		t.poll();
		expect(t.status()).toEqual([]);
		await t.admit(t.wakes()[0]!);
		// the wake render restarted the interval
		t.poll();
		expect(t.status()).toEqual([]);
		t.minutes(14);
		t.poll();
		expect(t.status()).toEqual([]);
		t.minutes(1);
		t.poll();
		expect(t.status()).toHaveLength(1);
		// in flight: resent (same key), never a new batch; fallen back: nothing over two more intervals
		t.poll();
		t.poll();
		t.poll();
		t.minutes(15);
		t.poll();
		t.minutes(15);
		t.poll();
		expect(t.status()).toHaveLength(3);
		expect(new Set(t.status().map((x) => keyOf(x.message))).size).toBe(1);
	});
});

describe("S4 push shape", () => {
	test("S4 one surface-status aside that starts a turn, keyed status:<id>, headed with the time and W, needs you first, the count last", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		const q = ask(t.lane, ids.wl!, ids.sl!, "Which token name?");
		t.poll();
		const batch = (await t.due({ admit: false }))!;
		expect(t.status()).toHaveLength(1);
		expect(t.needsYou()).toEqual([]);
		expect(batch.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(keyOf(batch.message)).toMatch(/^status:/);
		expect(batch.message.display).toBe(true);
		const content = batch.message.content;
		expect(content.startsWith("status 19:15Z (since 19:00Z)\n\n## needs you\n- [worth knowing] #1 ")).toBe(true);
		expect(sectionOf(content, "needs you")).toContain(q);
		expect(content.indexOf("## needs you")).toBeLessThan(content.indexOf("## in flight"));
		expect(content.endsWith(`\n\n${count(1)}`)).toBe(true);
	});
});

describe("S5 confirmation", () => {
	test("S5 identities and messages move only at the batch's message_end; unconfirmed it is resent, PUSH_TRIES sends, then nothing; Jo's turn retires it and carries one fresh delta with the same content and a later change", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		const { wl, sl } = ids as { wl: string; sl: string };
		t.minutes(1);
		const m = say(t.lane, wl, "the token is called --header-offset");
		t.lane.completeSlice(sl, { by: "lane-a", artifact: "ok" });
		const core = t.s.status!;
		const batch = (await t.due({ admit: false }))!;
		expect(batch.message.content).toContain(`${m} from lane-a on ${wl}: the token is called --header-offset`);
		expect(t.lane.message(m)!.state).toBe("held");
		const doneIdentity = `slice:${sl}:r${t.lane.slice(sl)!.rev}`;
		expect(core.eligible(doneIdentity, t.lane.slice(sl)!.changed_at)).toBe(true);
		expect(core.since).toBe(START);
		// a second batch is pushed and confirmed in another test (S6); here: unconfirmed, resent twice, then fallen back
		t.poll();
		t.poll();
		t.poll();
		t.minutes(15);
		t.poll();
		t.minutes(15);
		t.poll();
		expect(t.status()).toHaveLength(3);
		expect(new Set(t.status().map((x) => x.message.content)).size).toBe(1);
		expect(t.lane.message(m)!.state).toBe("held");
		// a change after the push
		const later = t.lane.addSlice({ by: "lane-a", workloadId: wl, task: "later task", doneCondition: "d", inputs: "i" });
		const turn = await t.jo();
		expect(t.s.retiredKeys.has(keyOf(batch.message)!)).toBe(true);
		const delta = turn.split("## since 19:00Z\n")[1]!;
		expect(delta).toContain(`${m} from lane-a on ${wl}: the token is called --header-offset`);
		expect(delta).toContain(`slice ${sl} on ${wl} done`);
		expect(delta).toContain(later);
		expect(occurrences(turn, "## since ")).toBe(1);
		// the turn confirmed it: the message is delivered, the identity no longer offered (told, or below the floor and pruned), W at the turn's read
		expect(t.lane.message(m)!.state).toBe("delivered");
		expect(core.eligible(doneIdentity, t.lane.slice(sl)!.changed_at)).toBe(false);
		expect(core.since).toBe(t.c.now());
		// a late message_end for the retired key changes nothing
		const since = core.since;
		await t.admit(batch);
		expect(core.since).toBe(since);
	});

	test("S5 confirmed: exactly the batch's identities and messages move, W moves to its read time", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		const { wl, sl } = ids as { wl: string; sl: string };
		t.minutes(14);
		const m = say(t.lane, wl, "first message");
		// inside the 60 s below the batch's read: the identity stays in the told set after the floor moves
		t.lane.completeSlice(sl, { by: "lane-a", artifact: "ok" });
		const batch = (await t.due({ admit: false, minutes: 1 }))!;
		const readAt = t.c.now();
		const m2 = say(t.lane, wl, "written after the read");
		await t.admit(batch);
		expect(t.lane.message(m)!.state).toBe("delivered");
		expect(t.lane.message(m2)!.state).toBe("held");
		expect(t.s.status!.told.has(`slice:${sl}:r${t.lane.slice(sl)!.rev}`)).toBe(true);
		expect(t.s.status!.since).toBe(readAt);
		const next = (await t.due())!;
		expect(next.message.content).toContain(m2);
		expect(next.message.content).not.toContain(`${m} from`);
	});
});

describe("S6 no change, no turn", () => {
	test("S6 only noise: a display-only line carrying a noise message's body whole; the message stays held until that line's message_end; W and the clock move", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		const body = `${ARTIFACT_PASSED_PREFIX} ${"bun test exit 0 ".repeat(50)}`;
		expect(body.length).toBeGreaterThan(600);
		const m = say(t.lane, ids.wl!, body, ids.sl);
		const line = (await t.due({ admit: false }))!;
		expect(t.batches()).toEqual([]);
		expect(line.options).toEqual({});
		expect(line.message.content.startsWith("status 19:15Z: no change since 19:00Z · 1 workloads in flight · open answer lines: 0\n")).toBe(true);
		expect(line.message.content).toContain(`- [noise] ${m} from lane-a on ${ids.wl} (${ids.sl}): ${body}`);
		expect(t.lane.message(m)!.state).toBe("held");
		await t.admit(line);
		expect(t.lane.message(m)!.state).toBe("delivered");
		expect(t.s.status!.since).toBe("2026-10-12T19:15:00.000Z");
		t.minutes(14);
		t.poll();
		expect(t.status()).toHaveLength(1);
	});
});

describe("S7 no duplicate", () => {
	test("S7 an on-fire line pushed alone is absent from the next batch; one found on a due poll rides the batch, one aside", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		t.minutes(5);
		t.lane.enqueue({ by: "lane-x", workloadId: ids.wl!, sender: "lane-x", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-x", t.lane.now(), 1) });
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		const first = (await t.due())!;
		expect(first.message.content).not.toContain("lane-x");
		// a red run found on a due poll: one aside, the batch, with it on fire under needs you
		const other = workloadWithSlice(t.lane);
		t.minutes(14);
		t.lane.enqueue({ by: TEST_RUNNER_BY, workloadId: other.wl, sliceId: other.sl, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: testRunFailedBody({ workloadId: other.wl, slice: other.sl, verdict: "red", sha: "a".repeat(40), failing: 3, first: null }) });
		const sent = t.f.sent.length;
		t.minutes(1);
		t.poll();
		expect(t.f.sent.slice(sent)).toHaveLength(1);
		expect(t.f.sent[sent]!.message.customType).toBe("surface-status");
		expect(sectionOf(t.f.sent[sent]!.message.content, "needs you")).toMatch(/^- \[on fire\] /);
	});

	test("S7 one aside per poll: an on-fire line found while a batch is unconfirmed goes out alone; the resend waits for the next poll and counts only real sends", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		t.minutes(1);
		say(t.lane, ids.wl!, "the header offset is a token now");
		const batch = (await t.due({ admit: false }))!;
		t.lane.enqueue({ by: "lane-x", workloadId: ids.wl!, sender: "lane-x", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-x", t.lane.now(), 1) });
		const sent = t.f.sent.length;
		t.poll();
		expect(t.f.sent.slice(sent).map((x) => x.message.customType)).toEqual(["surface-needs-you"]);
		t.poll();
		expect(t.f.sent.slice(sent).map((x) => x.message.customType)).toEqual(["surface-needs-you", "surface-status"]);
		expect(keyOf(t.f.sent.at(-1)!.message)).toBe(keyOf(batch.message));
		for (let i = 0; i < 4; i++) t.poll();
		// PUSH_TRIES sends in all: the poll that pushed the on-fire line spent none of them
		expect(t.status()).toHaveLength(3);
		expect(t.needsYou()).toHaveLength(1);
	});

	test("S7 a full read hides the changes it rendered, never an unrelated later change, a closed workload or a done slice outside its last-N window", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			Object.assign(ids, workloadWithSlice(l));
			ids.b = l.addSlice({ by: "lane-a", workloadId: ids.wl!, task: "b task", doneCondition: "d", inputs: "i" });
			ids.old = l.addSlice({ by: "lane-a", workloadId: ids.wl!, task: "old task", doneCondition: "d", inputs: "i" });
		} });
		const { wl, sl, b, old } = ids as Record<string, string>;
		t.minutes(1);
		t.lane.completeSlice(old!, { by: "lane-a", artifact: "ok" });
		// eight later entries, a second apart, push the done slice out of the read's last-8 window
		for (let i = 0; i < 8; i++) {
			t.minutes(1 / 60);
			t.lane.recordEntry({ by: "lane-a", workloadId: wl!, kind: "assumption", body: `note ${i}` });
		}
		const closed = closedWorkload(t.lane, "Closed before the read").wl;
		t.minutes(1 / 60);
		t.lane.completeSlice(sl!, { by: "lane-a", artifact: "ok" });
		const read = await t.read();
		expect(read).toContain(`slice ${sl} done`);
		expect(read).not.toContain(`slice ${old} done`);
		t.minutes(1);
		t.lane.completeSlice(b!, { by: "lane-a", artifact: "ok" });
		const batch = (await t.due())!.message.content;
		expect(batch).not.toContain(`slice ${sl} `);
		expect(batch).toContain(`slice ${b} on ${wl} done`);
		expect(batch).toContain(`slice ${old} on ${wl} done`);
		expect(batch).toContain(`${closed} closed`);
	});

	test("S7 a one-workload read hides only that workload's rendered events", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			const a = workloadWithSlice(l);
			const b = workloadWithSlice(l);
			Object.assign(ids, { wa: a.wl, sa: a.sl, wb: b.wl, sb: b.sl });
		} });
		t.minutes(1);
		t.lane.completeSlice(ids.sa!, { by: "lane-a", artifact: "ok" });
		t.lane.completeSlice(ids.sb!, { by: "lane-a", artifact: "ok" });
		await t.read({ workload: ids.wa });
		const batch = (await t.due())!.message.content;
		expect(batch).not.toContain(`slice ${ids.sa}`);
		expect(batch).toContain(`slice ${ids.sb} on ${ids.wb} done`);
	});

	test("S7 a lane-exit an idle line or a lane-died line already said is not listed again", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			const a = workloadWithSlice(l);
			const b = workloadWithSlice(l);
			Object.assign(ids, { wa: a.wl, wb: b.wl });
		} });
		t.minutes(1);
		laneRun(t.lane, ids.wa!, "lane-i", "parked");
		laneRun(t.lane, ids.wb!, "lane-d", "crashed");
		t.lane.enqueue({ by: "lane-d", workloadId: ids.wb!, sender: "lane-d", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-d", t.lane.now(), 0) });
		const batch = (await t.due())!.message.content;
		expect(sectionOf(batch, "needs you")).toContain(`lane lane-i on ${ids.wa} ended (parked)`);
		expect(sectionOf(batch, "needs you")).toContain("lane-d");
		expect(batch).not.toContain(`lane lane-i ended on`);
		expect(batch).not.toContain(`lane lane-d ended on`);
		expect(batch).toContain(`lane lane-i started on ${ids.wa}`);
	});
});

describe("S8 retirement", () => {
	test("S8 a compaction wake before the batch's message_end retires its key: the guard drops its copy, the wake's delta carries its close, done slice and message, the next batch none, and a late message_end changes nothing", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		t.minutes(1);
		const closed = closedWorkload(t.lane, "Closed in the interval");
		t.lane.completeSlice(ids.sl!, { by: "lane-a", artifact: "ok" });
		const m = say(t.lane, ids.wl!, "a lane message in the batch");
		const batch = (await t.due({ admit: false }))!;
		expect(batch.message.content).toContain(`${closed.wl} closed`);
		await t.compact();
		t.poll();
		const wake = t.wakes()[0]!;
		expect(t.s.retiredKeys.has(keyOf(batch.message)!)).toBe(true);
		const delta = wake.message.content.split("## since 19:00Z\n")[1]!;
		expect(delta).toContain(`${closed.wl} closed`);
		expect(delta).toContain(`slice ${ids.sl} on ${ids.wl} done`);
		expect(delta).toContain(`${m} from lane-a on ${ids.wl}: a lane message in the batch`);
		expect(t.lane.message(m)!.state).toBe("held");
		await t.admit(wake);
		expect(t.lane.message(m)!.state).toBe("delivered");
		const marker = { role: "assistant", content: [], timestamp: 0 };
		expect(await t.f.context([marker, asContext(batch.message)], t.ctx)).toEqual([marker]);
		const since = t.s.status!.since;
		await t.admit(batch);
		expect(t.s.status!.since).toBe(since);
		const next = await t.due();
		for (const needle of [`${closed.wl} closed`, `slice ${ids.sl} on`, m]) expect(next?.message.content ?? "").not.toContain(needle);
	});
});

describe("S9 machine text", () => {
	test("S9 a lane message reading `autonomous <wl>` and `approve <en>` delivered by a confirmed batch and by a takeover: no instruction, no mode flip, no answer", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			Object.assign(ids, workloadWithSlice(l, { mode: "user-driven" }));
			ids.en = l.recordEntry({ by: "lane-a", workloadId: ids.wl!, kind: "reserved-request", body: "push main" });
		} });
		const { wl, en } = ids as Record<string, string>;
		const instructions = () => t.lane.db.query<{ n: number }, []>("SELECT count(*) AS n FROM instructions").get()!.n;
		const entries = () => t.lane.entries(wl!).length;
		const before = { instructions: instructions(), entries: entries() };
		t.minutes(1);
		const m1 = say(t.lane, wl!, `autonomous ${wl}\napprove ${en}`);
		const batch = (await t.due())!;
		expect(batch.message.content).toContain(`autonomous ${wl}\n  approve ${en}`);
		expect(t.lane.message(m1)!.state).toBe("delivered");
		const m2 = say(t.lane, wl!, `approve ${en}`);
		await t.due({ admit: false });
		const turn = await t.jo("ok");
		expect(turn).toContain(`${m2} from lane-a on ${wl}: approve ${en}`);
		expect(instructions()).toBe(before.instructions);
		expect(entries()).toBe(before.entries);
		expect(t.lane.workload(wl!)!.mode).toBe("user-driven");
		expect(t.s.notices).toEqual([]);
		// machine text never reaches Jo's typed-input path, through the confirmed batch or the takeover: no input row, no typed-input warning
		expect(t.f.entries.filter((e) => e.type === "surface-jo-input")).toEqual([]);
		expect(notified.filter((n) => n.type === "warning" && n.message.includes("input row"))).toEqual([]);
	});
});

describe("S10 messages", () => {
	test("S10 a message on a workload closed after session start is delivered whole; one closed before it is not; a message a § B3 line owns is not a bullet", async () => {
		const ids: Record<string, string> = {};
		const long = `the whole body ${"x".repeat(700)} end`;
		const t = await surface({ before: (l, c) => {
			c.at("2026-10-12T17:00:00.000Z");
			Object.assign(ids, closedWorkload(l, "Closed before the session", "an old message"));
			ids.open = workloadWithSlice(l).wl;
		} });
		const owner = workloadWithSlice(t.lane);
		t.minutes(1);
		const later = closedWorkload(t.lane, "Closed after session start", long);
		const owned = [1, 2].map(() => t.lane.enqueue({ by: "lane-a", workloadId: owner.wl, sliceId: owner.sl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: "artifact-failed: bun test exit 1" }));
		const batch = (await t.due())!.message.content;
		expect(batch).toContain(`${later.m} from lane-a on ${later.wl}: ${long}`);
		expect(batch).not.toContain(ids.m!);
		expect(sectionOf(batch, "needs you")).toContain("failed its runtime artifact 2 times");
		for (const id of owned) expect(batch).not.toContain(`${id} from`);
	});

	test("S10 a message an on-demand read delivered before the batch's confirmation is skipped at it; the wake render shows held bodies before consuming them", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		t.minutes(1);
		const m = say(t.lane, ids.wl!, "read before the confirmation");
		const batch = (await t.due({ admit: false }))!;
		expect(batch.message.content).toContain(m);
		await t.read();
		expect(t.lane.message(m)!.state).toBe("delivered");
		await t.admit(batch);
		expect(t.lane.message(m)!.state).toBe("delivered");
		// a held body in the wake render
		const m2 = say(t.lane, ids.wl!, "shown by the wake");
		await t.compact();
		t.poll();
		const wake = t.wakes()[0]!;
		expect(wake.message.content).toContain(`${m2} from lane-a on ${ids.wl}: shown by the wake`);
		expect(t.lane.message(m2)!.state).toBe("held");
		await t.admit(wake);
		expect(t.lane.message(m2)!.state).toBe("delivered");
	});
});

describe("S11 ticks and brb", () => {
	test("S11 a tick line queued after a status poll waits for the next batch; brb holds resends, batches, quiet lines and tick pushes; an on-fire line pushes alone; back retires the batch and carries one fresh delta and the ticks, once", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l, { mode: "user-driven" })) });
		t.minutes(1);
		t.lane.completeSlice(ids.sl!, { by: "lane-a", artifact: "ok" });
		const first = (await t.due({ admit: false }))!;
		t.s.tickNotices.push(`tick: ${ids.wl} is finished but cannot close`);
		expect(t.status()).toHaveLength(1);
		expect(await t.type("brb")).toEqual({ handled: true });
		t.poll();
		t.poll();
		expect(t.status()).toHaveLength(1);
		t.minutes(1);
		const later = workloadWithSlice(t.lane, { brief: "Opened while away", mode: "user-driven" });
		t.minutes(15);
		t.poll();
		t.minutes(15);
		t.poll();
		expect(t.status()).toHaveLength(1);
		expect(t.quiet()).toEqual([]);
		// an on-fire line still goes out, alone
		t.lane.enqueue({ by: "lane-x", workloadId: later.wl, sender: "lane-x", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-x", t.lane.now(), 1) });
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.status()).toHaveLength(1);
		const turn = await t.jo("back");
		expect(t.s.retiredKeys.has(keyOf(first.message)!)).toBe(true);
		expect(occurrences(turn, "## since 19:00Z")).toBe(1);
		const delta = turn.split("## since 19:00Z\n")[1]!;
		expect(occurrences(delta, `slice ${ids.sl} on ${ids.wl} done`)).toBe(1);
		expect(occurrences(delta, `${later.wl} opened: Opened while away`)).toBe(1);
		expect(occurrences(turn, `- tick: ${ids.wl} is finished but cannot close`)).toBe(1);
		expect(t.s.away).toBeNull();
		expect(t.s.tickNotices).toEqual([]);
	});

	test("S11 a non-back turn while away neither takes over the batch in flight nor drains the queued tick (Jo's echoes still render); back then carries both, once", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l, { mode: "user-driven" })) });
		t.minutes(1);
		t.lane.completeSlice(ids.sl!, { by: "lane-a", artifact: "ok" });
		const first = (await t.due({ admit: false }))!;
		const key = keyOf(first.message)!;
		const tickLine = `tick: ${ids.wl} is finished but cannot close`;
		t.s.tickNotices.push(tickLine);
		expect(await t.type("brb")).toEqual({ handled: true });
		t.s.notices.push("Jo's echo while away");
		const away = await t.jo("how is it going");
		expect(away).toContain("- Jo's echo while away");
		expect(away).not.toContain(tickLine);
		expect(away).not.toContain("## since ");
		expect(t.s.retiredKeys.has(key)).toBe(false);
		expect(t.s.status!.inFlight?.key).toBe(key);
		expect(t.s.tickNotices).toEqual([tickLine]);
		expect(t.s.notices).toEqual([]);
		expect(t.s.away).not.toBeNull();
		const back = await t.jo("back");
		expect(t.s.retiredKeys.has(key)).toBe(true);
		expect(occurrences(back, "## since 19:00Z")).toBe(1);
		expect(occurrences(back, `slice ${ids.sl} on ${ids.wl} done`)).toBe(1);
		expect(occurrences(back, `- ${tickLine}`)).toBe(1);
		expect(back).not.toContain("Jo's echo while away");
		expect(t.s.tickNotices).toEqual([]);
		expect(t.s.away).toBeNull();
	});
});

describe("S12 boundary", () => {
	test("S12 an event stamped exactly at a confirmed batch's read time, and one stamped 1 ms before it but written after the read, are each listed once", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			Object.assign(ids, workloadWithSlice(l));
			ids.y = l.addSlice({ by: "lane-a", workloadId: ids.wl!, task: "y task", doneCondition: "d", inputs: "i" });
		} });
		await t.due();
		const readAt = t.c.now();
		t.lane.completeSlice(ids.sl!, { by: "lane-a", artifact: "at the read" });
		t.c.at(new Date(Date.parse(readAt) - 1).toISOString());
		t.lane.completeSlice(ids.y!, { by: "lane-a", artifact: "a ms before" });
		expect(t.lane.slice(ids.y!)!.changed_at).toBe("2026-10-12T19:14:59.999Z");
		t.c.at(readAt);
		const next = (await t.due())!.message.content;
		expect(occurrences(next, `slice ${ids.sl} on`)).toBe(1);
		expect(occurrences(next, `slice ${ids.y} on`)).toBe(1);
		const after = (await t.due())?.message.content ?? "";
		expect(after).not.toContain(`slice ${ids.sl} on`);
		expect(after).not.toContain(`slice ${ids.y} on`);
	});
});

describe("S13 restart", () => {
	test("S13 an unconfirmed batch's close, done slice and message are in the next session's wake delta from the cursor; a confirmed batch's items are not", async () => {
		const ids: Record<string, string> = {};
		const e = env();
		const t = await surface({ e, before: (l) => {
			Object.assign(ids, workloadWithSlice(l));
			ids.s2 = l.addSlice({ by: "lane-a", workloadId: ids.wl!, task: "confirmed task", doneCondition: "d", inputs: "i" });
		} });
		t.minutes(1);
		t.lane.completeSlice(ids.s2!, { by: "lane-a", artifact: "ok" });
		await t.due();
		const cursor = join(dirname(e.AGENT_SYSTEM_LEDGER_DB!), "orchestrator", "status-cursor.json");
		expect(existsSync(cursor)).toBe(true);
		expect(JSON.parse(readFileSync(cursor, "utf8"))).toMatchObject({ since: "2026-10-12T19:16:00.000Z" });
		t.minutes(1);
		const closed = closedWorkload(t.lane, "Closed, never confirmed", "on the closed workload");
		t.lane.completeSlice(ids.sl!, { by: "lane-a", artifact: "ok" });
		const unconfirmed = (await t.due({ admit: false }))!;
		expect(unconfirmed.message.content).toContain(`${closed.wl} closed`);
		// the session ends; a new one on the same home and ledger
		timers.length = 0;
		timeouts.length = 0;
		const f2 = fakePi(undefined, { exec: true });
		orchestratorSurface(f2.pi, e, {});
		const ctx2 = ctxOf();
		surfaceSession(ctx2, e).now = t.c.now;
		await f2.emit("session_start", { type: "session_start" }, ctx2);
		const turn = ((await f2.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx2)) as Turn).messages.map((m) => m.content).join("\n");
		const delta = turn.split("## since 19:16Z\n")[1]!;
		expect(delta).toContain(`${closed.wl} closed`);
		expect(delta).toContain(`slice ${ids.sl} on ${ids.wl} done`);
		expect(delta).toContain(`${closed.m} from lane-a on ${closed.wl}: on the closed workload`);
		expect(delta).not.toContain(`slice ${ids.s2}`);
	});
});

describe("S14 size", () => {
	test("S14 200 held messages of 2 000 chars: the wake's delta stays within the cap and ends with the held count, consumes only what it rendered; batches drain the rest, each delivered once", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		t.minutes(1);
		const all = Array.from({ length: 200 }, (_, i) => say(t.lane, ids.wl!, `${String(i).padStart(3, "0")} ${"m".repeat(1996)}`));
		await t.compact();
		t.poll();
		const wake = t.wakes()[0]!;
		const delta = wake.message.content.split("\n\n## since ")[1]!.split("\n\nThis turn owes")[0]!;
		expect(delta.length).toBeLessThanOrEqual(DELTA_CHARS);
		expect(delta).toMatch(/\n\d+ more items \(\d+ lane messages\) held for the next batch$/);
		const shown = (text: string) => all.filter((m) => text.includes(`${m} from`));
		const inWake = shown(wake.message.content);
		expect(inWake.length).toBeGreaterThan(0);
		expect(inWake.length).toBeLessThan(200);
		await t.admit(wake);
		const delivered = () => all.filter((m) => t.lane.message(m)!.state !== "held");
		expect(delivered()).toEqual(inWake);
		const seen = [...inWake];
		for (let i = 0; i < 40 && delivered().length < 200; i++) {
			const batch = await t.due();
			if (batch) seen.push(...shown(batch.message.content));
		}
		expect(delivered()).toHaveLength(200);
		expect(seen.sort()).toEqual([...all].sort());
	});
});

describe("S15 needs-you takeover", () => {
	test("S15 a batch carrying a red run and a lane death retired by a compaction wake: their messages stay held and the wake shows both lines; a mixed batch renders an artifact-passed body and consumes it only at confirmation", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			const a = workloadWithSlice(l);
			const b = l.openWorkload({ by: "lane-x", brief: "nothing left", stakes: "normal", mode: "autonomous" });
			Object.assign(ids, { wa: a.wl, sa: a.sl, wb: b });
		} });
		t.minutes(14);
		const red = t.lane.enqueue({ by: TEST_RUNNER_BY, workloadId: ids.wa!, sliceId: ids.sa!, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: testRunFailedBody({ workloadId: ids.wa!, slice: ids.sa!, verdict: "red", sha: "b".repeat(40), failing: 2, first: null }) });
		const died = t.lane.enqueue({ by: "lane-x", workloadId: ids.wb!, sender: "lane-x", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-x", t.lane.now(), 0) });
		t.minutes(1);
		t.poll();
		const batch = t.status()[0]!;
		expect(t.needsYou()).toEqual([]);
		const needs = sectionOf(batch.message.content, "needs you")!;
		expect(needs).toContain(ids.wa!);
		expect(needs).toContain("lane-x");
		await t.compact();
		t.poll();
		expect(t.lane.message(red)!.state).toBe("held");
		expect(t.lane.message(died)!.state).toBe("held");
		const wake = t.wakes()[0]!;
		expect(wake.message.content).toContain("lane-x");
		expect(wake.message.content).toContain(`red`);
		await t.admit(wake);
		expect(t.lane.message(red)!.state).toBe("delivered");
		expect(t.lane.message(died)!.state).toBe("delivered");
		// a mixed batch: a worth-knowing item and an artifact-passed message
		t.minutes(1);
		const passed = say(t.lane, ids.wa!, `${ARTIFACT_PASSED_PREFIX} bun test exit 0`, ids.sa);
		say(t.lane, ids.wa!, "a plain message");
		const mixed = (await t.due({ admit: false }))!;
		expect(mixed.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(mixed.message.content).toContain(`- [noise] ${passed} from lane-a on ${ids.wa} (${ids.sa}): ${ARTIFACT_PASSED_PREFIX} bun test exit 0`);
		expect(t.lane.message(passed)!.state).toBe("held");
		await t.admit(mixed);
		expect(t.lane.message(passed)!.state).toBe("delivered");
	});
});

describe("S16 round 4", () => {
	test("S16 [R4-1] a capped batch confirmed with a closed workload's message and an older slice change left over: both are in the next batch", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => {
			Object.assign(ids, workloadWithSlice(l));
			ids.wc = l.openWorkload({ by: "lane-a", brief: "Closed with a message", stakes: "normal", mode: "autonomous" });
			ids.wd = workloadWithSlice(l, { brief: "Slice changed early" }).sl;
		} });
		t.minutes(1);
		for (let i = 0; i < 15; i++) say(t.lane, ids.wl!, `${i} ${"p".repeat(1995)}`);
		t.minutes(1);
		t.lane.completeSlice(ids.wd!, { by: "lane-a", artifact: "ok" });
		const cm = say(t.lane, ids.wc!, "the closed workload's message");
		t.lane.closeWorkload(ids.wc!, { by: SURFACE_BY });
		const first = (await t.due())!.message.content;
		expect(first).toMatch(/\d+ more items \(\d+ lane messages\) held for the next batch/);
		expect(first).not.toContain(`slice ${ids.wd} on`);
		expect(first).not.toContain(cm);
		expect(t.s.status!.since).toBe("2026-10-12T19:02:00.000Z");
		const next = (await t.due())!.message.content;
		expect(next).toContain(`slice ${ids.wd} on`);
		expect(next).toContain(`${cm} from lane-a on ${ids.wc}: the closed workload's message`);
	});

	test("S16 [R4-2] one 30 000-char lane message is delivered whole and alone; the next item follows", async () => {
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, workloadWithSlice(l)) });
		t.minutes(1);
		const big = `${"b".repeat(29_999)}!`;
		const m1 = say(t.lane, ids.wl!, big);
		t.minutes(1);
		const m2 = say(t.lane, ids.wl!, "the next one");
		const first = (await t.due())!.message.content;
		expect(first).toContain(`${m1} from lane-a on ${ids.wl}: ${big}`);
		expect(first).not.toContain(m2);
		expect(first).toMatch(/\n\d+ more items \(1 lane messages\) held for the next batch\n/);
		expect(t.lane.message(m1)!.state).toBe("delivered");
		const next = (await t.due())!.message.content;
		expect(next).toContain(`${m2} from lane-a on ${ids.wl}: the next one`);
		expect(next).not.toContain(m1);
	});

	test("S16 [R3-5] the cap counts plan-path decoration: two messages that fit undecorated but not with their plan paths go one per batch", async () => {
		const path = `/plans/${"p".repeat(3_000)}/PLAN.md`;
		const ids: Record<string, string> = {};
		const t = await surface({ before: (l) => Object.assign(ids, seedPlan(l, path)) });
		const { wl, q } = ids as { wl: string; q: string };
		t.minutes(1);
		const a = say(t.lane, wl, `see ${q} ${"a".repeat(10_000)}`);
		t.minutes(1);
		const b = say(t.lane, wl, `see ${q} ${"b".repeat(10_000)}`);
		// undecorated, both bullets and the section's overhead fit the cap; each plan line adds the path
		expect(2 * (`- [worth knowing] ${a} from lane-a on ${wl}: see ${q} `.length + 10_001) + 1_000).toBeLessThan(DELTA_CHARS);
		const first = (await t.due())!.message.content;
		expect(first).toContain(`${a} from lane-a on ${wl}: see ${q} ${"a".repeat(10_000)}\n  plan for ${q}: ${path}`);
		expect(first).not.toContain(`${b} from`);
		expect(first).toMatch(/\n\d+ more items \(1 lane messages\) held for the next batch\n/);
		expect(first.length).toBeLessThanOrEqual(DELTA_CHARS);
		expect(t.lane.message(b)!.state).toBe("held");
		const next = (await t.due())!.message.content;
		expect(next).toContain(`${b} from lane-a on ${wl}: see ${q} ${"b".repeat(10_000)}\n  plan for ${q}: ${path}`);
		expect(next).not.toContain(`${a} from`);
	});

	test("S16 [R5-1][R6-1] a full read shows the message, the in-window done slice and the opening once, none in the next batch; the out-of-window slice is", async () => {
		const t = await surface();
		t.minutes(1);
		const { wl, sl } = workloadWithSlice(t.lane);
		const out = t.lane.addSlice({ by: "lane-a", workloadId: wl, task: "out of window", doneCondition: "d", inputs: "i" });
		t.lane.completeSlice(out, { by: "lane-a", artifact: "ok" });
		for (let i = 0; i < 8; i++) {
			t.minutes(1 / 60);
			t.lane.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: `note ${i}` });
		}
		t.minutes(1 / 60);
		t.lane.completeSlice(sl, { by: "lane-a", artifact: "ok" });
		const m = say(t.lane, wl, "the held message");
		const read = await t.read();
		expect(occurrences(read, "the held message")).toBe(1);
		expect(occurrences(read, `slice ${sl} done`)).toBe(1);
		expect(read).not.toContain(`slice ${out} done`);
		expect(t.lane.message(m)!.state).toBe("delivered");
		const next = (await t.due())!.message.content;
		expect(next).not.toContain(m);
		expect(next).not.toContain(`slice ${sl} on`);
		expect(next).not.toContain(`${wl} opened`);
		expect(next).toContain(`slice ${out} on ${wl} cut and done: out of window`);
	});
});

describe("the core alone (a fake seat named plumb: no Ledger, no wake.ts, nothing from status-ilex.ts)", () => {
	/** One graded thing the plumb seat knows: an identity, a stamp, a grade, text and the message ids behind it. */
	interface PlumbItem {
		id: string;
		ts: string;
		grade: Grade;
		text: string;
		messageIds?: string[];
	}
	const at = (minutes: number, ms = 0) => new Date(Date.parse(START) + minutes * 60_000 + ms).toISOString();
	/** A seat over an in-memory item list; its callbacks record every call; `delivered` is the seat's own message state. */
	function plumb(o: { root?: string | null; scope?: string; now?: string } = {}) {
		let now = o.now ?? START;
		const calls = { push: [] as { content: string; key: string }[], show: [] as { content: string; key: string }[], delivered: [] as string[][] };
		const delivered = new Set<string>();
		const core = new StatusCore({
			seat: "plumb", root: o.root ?? null, scope: o.scope, now: () => now, intervalMs: 15 * 60_000, tries: 3, warn: () => {},
			push: (content, key) => calls.push.push({ content, key }),
			show: (content, key) => calls.show.push({ content, key }),
			markDelivered: (ids) => {
				calls.delivered.push([...ids]);
				for (const id of ids) delivered.add(id);
			},
		});
		core.load();
		const items: PlumbItem[] = [];
		/** What the seat offers: eligible items, each with its still-undelivered messages. */
		const offer = (): StatusItem[] =>
			items.filter((i) => core.eligible(i.id, i.ts)).map((i) => ({
				section: "plumbing", grade: i.grade, text: `${i.id}: ${i.text}`, at: i.ts, ts: i.ts, told: [{ identity: i.id, ts: i.ts }],
				messageIds: (i.messageIds ?? []).filter((m) => !delivered.has(m)),
			}));
		const compose = () => {
			const d = core.delta(offer());
			return { d, ...core.compose(d, { sections: ["plumbing"], footer: "end of plumbing", summary: ["plumb summary"] }) };
		};
		return {
			core, calls, items, delivered, compose,
			/** Compose and send whatever is due now (a batch, or the quiet line). */
			send: () => {
				const c = compose();
				return core.send(c.d, c.content, c.quiet);
			},
			listed: () => compose().d.shown.map((i) => i.text.split(":")[0]!),
			to: (iso: string) => {
				now = iso;
			},
			due: () => core.due({ idle: true, blocked: false }),
		};
	}

	test("(a) clock: not due before the interval, due after, not while busy or blocked; a send resets it", () => {
		const p = plumb();
		p.to(at(14, 59_999));
		expect(p.due()).toBe(false);
		p.to(at(15));
		expect(p.due()).toBe(true);
		expect(p.core.due({ idle: false, blocked: false })).toBe(false);
		expect(p.core.due({ idle: true, blocked: true })).toBe(false);
		const b = p.send();
		p.core.confirm(b.key);
		expect(p.due()).toBe(false);
		p.to(at(29, 59_999));
		expect(p.due()).toBe(false);
		p.to(at(30));
		expect(p.due()).toBe(true);
	});

	test("(b) a pushed batch moves nothing until confirm; confirm tells its identities and delivers exactly its message ids; the next compose lists none of them", () => {
		const p = plumb();
		p.items.push({ id: "a", ts: at(14, 30_000), grade: "worth knowing", text: "pipe fitted", messageIds: ["m1"] }, { id: "b", ts: at(14, 40_000), grade: "worth knowing", text: "valve shut" });
		p.to(at(15));
		const b = p.send();
		expect(p.calls.push).toEqual([{ content: b.content, key: b.key }]);
		expect(b.content).toBe("status 19:15Z (since 19:00Z)\n\n## plumbing\n- [worth knowing] a: pipe fitted\n- [worth knowing] b: valve shut\n\nend of plumbing");
		expect(p.core.told.size).toBe(0);
		expect(p.calls.delivered).toEqual([]);
		expect(p.core.since).toBe(START);
		expect(p.listed()).toEqual(["a", "b"]);
		expect(p.core.confirm(b.key)).not.toBeNull();
		expect([...p.core.told.keys()].sort()).toEqual(["a", "b"]);
		expect(p.calls.delivered).toEqual([["m1"]]);
		expect(p.core.since).toBe(at(15));
		expect(p.listed()).toEqual([]);
	});

	test("(c) an unconfirmed batch is resent up to the tries, then falls back; no new batch while one is in flight or fallen back", () => {
		const p = plumb();
		p.items.push({ id: "a", ts: at(1), grade: "worth knowing", text: "leak" });
		p.to(at(15));
		const b = p.send();
		expect(p.core.resend()).toBe("resent");
		expect(p.due()).toBe(false);
		expect(p.core.resend()).toBe("resent");
		expect(p.core.resend()).toBe("exhausted");
		expect(p.core.resend()).toBe("none");
		expect(p.calls.push).toHaveLength(3);
		expect(new Set(p.calls.push.map((c) => c.key))).toEqual(new Set([b.key]));
		expect(p.core.exhausted).toBe(true);
		p.to(at(45));
		expect(p.due()).toBe(false);
		expect(p.calls.delivered).toEqual([]);
	});

	test("(d) a takeover retires the batch: a late confirm of its key changes nothing, and the next compose holds its items plus a newer one", () => {
		const p = plumb();
		p.items.push({ id: "a", ts: at(1), grade: "worth knowing", text: "leak", messageIds: ["m1"] });
		p.to(at(15));
		const b = p.send();
		const taken = p.core.takeover();
		expect(taken?.key).toBe(b.key);
		expect(p.core.inFlight).toBeNull();
		expect(p.core.confirm(b.key)).toBeNull();
		expect(p.core.since).toBe(START);
		expect(p.calls.delivered).toEqual([]);
		p.items.push({ id: "c", ts: at(16), grade: "worth knowing", text: "newer" });
		p.to(at(17));
		expect(p.listed()).toEqual(["a", "c"]);
	});

	test("(e) only noise eligible: a quiet line, shown with no turn, confirmed like a batch", () => {
		const p = plumb();
		p.items.push({ id: "n", ts: at(2), grade: "noise", text: "drip counter ticked", messageIds: ["m2"] });
		p.to(at(15));
		const b = p.send();
		expect(b.quiet).toBe(true);
		expect(p.calls.push).toEqual([]);
		expect(p.calls.show).toEqual([{ content: "status 19:15Z: no change since 19:00Z · plumb summary\n- [noise] n: drip counter ticked", key: b.key }]);
		expect(p.calls.delivered).toEqual([]);
		p.core.confirm(b.key);
		expect(p.calls.delivered).toEqual([["m2"]]);
		expect(p.core.since).toBe(at(15));
		expect(p.listed()).toEqual([]);
	});

	test("(f) cursor: saved as <root>/plumb/status-cursor.json; a new core loading it skips confirmed items and lists unconfirmed ones; a cursor for another scope is ignored", () => {
		const root = tmp("plumb");
		const p = plumb({ root, scope: "ledger-a" });
		p.items.push({ id: "a", ts: at(14, 30_000), grade: "worth knowing", text: "confirmed" });
		p.to(at(15));
		p.core.confirm(p.send().key);
		const path = join(root, "plumb", "status-cursor.json");
		expect(p.core.cursorPath).toBe(path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ scope: "ledger-a", since: at(15), told: [["a", at(14, 30_000)]] });
		p.items.push({ id: "b", ts: at(16), grade: "worth knowing", text: "never confirmed" });
		p.to(at(30));
		p.send();
		// a new session on the same root
		const q = plumb({ root, scope: "ledger-a", now: at(45) });
		q.items.push(...p.items);
		expect(q.core.since).toBe(at(15));
		expect(q.listed()).toEqual(["b"]);
		// another scope: the cursor is ignored, W starts now
		const r = plumb({ root, scope: "ledger-b", now: at(45) });
		expect(r.core.since).toBe(at(45));
		expect(r.core.told.size).toBe(0);
	});

	test("(g) boundary: an item stamped exactly at W and one at W - 1 ms arriving after the confirmation are each listed once", () => {
		const p = plumb();
		p.to(at(15));
		p.core.confirm(p.send().key);
		expect(p.core.since).toBe(at(15));
		p.items.push({ id: "x", ts: at(15), grade: "worth knowing", text: "at W" }, { id: "y", ts: at(15, -1), grade: "worth knowing", text: "a ms before W" });
		p.to(at(30));
		const b = p.send();
		expect(occurrences(b.content, "] x: ")).toBe(1);
		expect(occurrences(b.content, "] y: ")).toBe(1);
		p.core.confirm(b.key);
		p.to(at(45));
		expect(p.listed()).toEqual([]);
	});

	test("selectDelta: grade order then oldest first; the first capped item renders whole past the cap; uncapped items always render; silent items never", () => {
		const item = (over: Partial<StatusItem>): StatusItem => ({ section: "in flight", grade: "worth knowing", text: "x", at: "2026-10-12T19:00:00.000Z", ts: null, ...over });
		const d = selectDelta(
			[
				item({ text: "noise", grade: "noise", at: "2026-10-12T18:00:00.000Z" }),
				item({ text: "w".repeat(500), at: "2026-10-12T19:01:00.000Z" }),
				item({ text: "older", at: "2026-10-12T18:59:00.000Z" }),
				item({ text: "needs", uncapped: true, section: "needs you", grade: "on fire" }),
				item({ text: "silent", silent: true }),
			],
			{ cap: 100, readAt: "2026-10-12T19:15:00.000Z", since: START },
		);
		expect(d.shown.map((i) => i.text.slice(0, 5))).toEqual(["needs", "older"]);
		expect(d.left.map((i) => i.text.slice(0, 5))).toEqual(["wwwww", "noise"]);
		expect(d.silent.map((i) => i.text)).toEqual(["silent"]);
	});
});
