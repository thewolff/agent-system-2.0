// The OMP adapter (surface/index.ts) driven by a fake extension API: role detection (only a
// top-level AGENT_SYSTEM_ROLE=orchestrator session is a surface), the wake cycle (render as the
// first message at start and after compaction, voice document in the system prompt, wake-read
// owed and enforced on tool calls and at stop), Jo's one-word input applied and shown next turn,
// `cancel-slice` on a parked lane's question runs the launch trigger (PLAN wl-mv5i3lulwwbbi8 D1),
// and the identity / open / close / schedule tools.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLimitBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines } from "../src/errors";
import { ceilingOf } from "../src/input";
import { planFirstBody } from "../src/launch";
import { pendingBlock, pendingItems, pendingWaits } from "../src/pending";
import { STANDING_WORKLOAD_ID, SURFACE_BY as SURFACE } from "../src/types";
import { clock, ctxOf, fakePi, loadTestText, notices, submitTyped, timers, tmp } from "./helpers";

function env(over: Record<string, string> = {}): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home", ...over };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close(); // the install script's job; the surface never creates one
	return e;
}
const open = (e: Record<string, string>) => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });
type Started = { systemPrompt: string[]; messages: { customType: string; content: string }[] };
/** The count line every Jo turn ends with (PLAN wl-mv5msri070p0qo D3). */
const count = (n: number) => `open answer lines: ${n} (\`pending\` shows them all)`;
/** A turn's message texts. */
const texts = (t: unknown) => (t as Started).messages.map((m) => m.content);

describe("surface extension adapter", () => {
	test("a lane or a hand loading the surface gets inert handlers and inert tools", async () => {
		const f = fakePi();
		const e = env({ AGENT_SYSTEM_ROLE: "lane" });
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const started = (await f.emit("before_agent_start", { prompt: "go", systemPrompt: ["base"] }, ctx)) as Started;
		expect(started.systemPrompt).toEqual(["base"]);
		expect(started.messages).toEqual([]);
		expect(await f.emit("tool_call", { toolName: "bash", input: {} }, ctx)).toBeUndefined();
		const r = await f.tool("orchestrator_identity").execute("1", { name: "X", pronouns: "it" }, undefined, undefined, ctx);
		expect(r.content[0]!.text).toContain("not the orchestrator surface");
		// a hand: top-level role env set but a parent session and no UI
		const hand = ctxOf({ hasUI: false, parent: "/s/lane.jsonl" });
		orchestratorSurface(fakePi().pi, env());
		expect((await f.emit("before_agent_start", { prompt: "go", systemPrompt: ["base"] }, hand) as Started).messages).toEqual([]);
	});

	test("wake at session start: ledger rendered as the first message, voice doc in the system prompt, wake read owed then satisfied", async () => {
		const f = fakePi();
		const e = env();
		const ledger = open(e);
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["left", "right"] });
		ledger.close();
		orchestratorSurface(f.pi, e);
		expect(f.registered().sort()).toEqual([
			"as2_rank", "lane_add_slice", "lane_complete_slice", "lane_full_test", "lane_handoff", "lane_message", "lane_raise_question", "lane_read_facts", "lane_record_entry", "lane_release", "lane_train_return", "lane_withdraw_reserved",
			"orchestrator_channel_done", "orchestrator_close_workload", "orchestrator_identity", "orchestrator_launch_lane", "orchestrator_ledger", "orchestrator_lower_ceiling", "orchestrator_open_workload", "orchestrator_raise_question", "orchestrator_record_instruction", "orchestrator_reply", "orchestrator_schedule", "orchestrator_wake_read", "slice_artifact",
		]);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const started = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: ["base"] }, ctx)) as Started;
		expect(started.systemPrompt[0]).toBe("base");
		expect(started.systemPrompt.join("\n")).toContain("VOICE DOC BODY");
		expect(started.messages).toHaveLength(1);
		const wake = started.messages[0]!;
		expect(wake.customType).toBe("surface-wake");
		expect(wake.content).toMatch(/^# Ledger at .* \(wake: session-start\)/);
		expect(wake.content).toContain("## needs you");
		expect(wake.content).toContain(`${q}, slice ${sl}): Which? — answer with one word: left / right`);
		expect(wake.content).toContain("no identity row yet");
		expect(wake.content).toContain("owes one wake-read entry");
		// owed: other tools refused, stop blocked, the wake-read tool allowed
		const refused = (await f.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx)) as { block: boolean; reason: string };
		expect(refused.block).toBe(true);
		expect(refused.reason).toContain("orchestrator_wake_read");
		expect((await f.emit("session_stop", {}, ctx)) as { decision: string }).toMatchObject({ decision: "block" });
		expect(await f.emit("tool_call", { toolName: "orchestrator_wake_read", input: {} }, ctx)).toBeUndefined();
		const empty = await f.tool("orchestrator_wake_read").execute("1", { body: "  " }, undefined, undefined, ctx);
		expect(empty.content[0]!.text).toContain("nothing was recorded");
		const r = await f.tool("orchestrator_wake_read").execute("1", { body: `resuming ${wl}: one open question ${q}` }, undefined, undefined, ctx);
		expect(r.content[0]!.text).toMatch(/^Recorded wake-read entry en-/);
		expect(await f.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx)).toBeUndefined();
		expect(await f.emit("session_stop", {}, ctx)).toBeUndefined();
		const check = open(e);
		expect(check.entries(STANDING_WORKLOAD_ID, "wake-read").map((x) => x.body)).toEqual([`resuming ${wl}: one open question ${q}`]);
		check.close();
		// a second turn without a trigger: voice doc still injected, no wake message, only the count line
		const second = (await f.emit("before_agent_start", { prompt: "next", systemPrompt: ["base"] }, ctx)) as Started;
		expect(texts(second)).toEqual([count(1)]);
		expect(second.systemPrompt.join("\n")).toContain("VOICE DOC BODY");
	});

	test("compaction re-renders and re-owes the wake read; a resumed session wakes as restart", async () => {
		const f = fakePi();
		const e = env();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf({ resumed: true });
		await f.emit("session_start", { type: "session_start" }, ctx);
		const first = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as Started;
		expect(first.messages[0]!.content).toContain("(wake: restart)");
		await f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx);
		expect(await f.emit("tool_call", { toolName: "bash", input: {} }, ctx)).toBeUndefined();
		await f.emit("session_compact", { type: "session_compact" }, ctx);
		const after = (await f.emit("before_agent_start", { prompt: "go on", systemPrompt: [] }, ctx)) as Started;
		expect(after.messages[0]!.content).toContain("(wake: compaction)");
		expect((await f.emit("tool_call", { toolName: "bash", input: {} }, ctx)) as { block: boolean }).toMatchObject({ block: true });
	});

	test("a missing voice document is named in the system prompt rather than silently skipped", async () => {
		const f = fakePi();
		const e = env({ AGENT_SYSTEM_VOICE: "/nonexistent/VOICE.md" });
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		const started = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as Started;
		expect(started.systemPrompt.join("\n")).toContain("voice document was not found at /nonexistent/VOICE.md");
	});

	test("Jo's one word in the prompt: applied through the ledger, notified, carried into the turn's context; other text passes through", async () => {
		const f = fakePi();
		const e = env();
		const ledger = open(e);
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["left", "right"] });
		ledger.close();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		notices.length = 0;
		const chat = (await f.emit("before_agent_start", { prompt: "how is it going?", systemPrompt: [] }, ctx)) as Started;
		// no wake happened in this session, so the open question is new since the last turn (§ B3 item 1: delivered between wakes, once)
		expect(chat.messages).toHaveLength(1);
		expect(chat.messages[0]!.content).toContain("## needs you (new since your last turn)");
		expect(chat.messages[0]!.content).toContain(`${q}, slice ${sl}): Which?`);
		expect(notices).toEqual([]);
		expect(texts(await f.emit("before_agent_start", { prompt: "still thinking", systemPrompt: [] }, ctx))).toEqual([count(1)]);
		const answered = (await submitTyped(f, { prompt: "right", systemPrompt: [] }, ctx)) as Started;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(`answered ${q} with "right"`);
		expect(notices[0]).toContain(`slice ${sl} is open`);
		expect(answered.messages[0]!.content).toContain("## Applied from the surface since your last turn");
		expect(answered.messages[0]!.content).toContain(`answered ${q} with "right"`);
		const flipped = (await submitTyped(f, { prompt: "production", systemPrompt: [] }, ctx)) as Started;
		expect(flipped.messages[0]!.content).toContain(`stakes on ${wl} → production`);
		expect(f.entries.filter((x) => x.type === "surface-input")).toHaveLength(2);
		// the receipt is shown once: the next turn carries no stale notice
		expect(texts(await f.emit("before_agent_start", { prompt: "thanks", systemPrompt: [] }, ctx))).toEqual([count(0)]);
		const check = open(e);
		expect(check.workload(wl)!.stakes).toBe("production");
		expect(check.slice(sl)!.state).toBe("open");
		check.close();
	});

	test("`pending` is handled with no turn: idle, one surface-pending without triggerTurn; busy, queued and shown fresh at the next idle poll (PLAN wl-mv5msri070p0qo D1)", async () => {
		timers.length = 0;
		const f = fakePi();
		const e = env();
		const l = open(e);
		const wl = l.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = l.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const q = l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which?", options: ["left", "right"] });
		orchestratorSurface(f.pi, e);
		const opts = { idle: true };
		const ctx = { ...ctxOf(), isIdle: () => opts.idle };
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
		await f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx);
		const shown = () => f.sent.filter((x) => x.message.customType === "surface-pending");
		expect(await f.emit("input", { text: "  Pending ", source: "interactive" }, ctx)).toEqual({ handled: true });
		expect(shown()).toHaveLength(1);
		expect(shown()[0]!.options).toEqual({});
		expect(shown()[0]!.message).toEqual({ customType: "surface-pending", content: pendingBlock(pendingItems(l), pendingWaits(l)).text, display: true });
		expect(shown()[0]!.message.content).toContain(`\nleft ${q}  # Which — on Fix · `);
		// busy: nothing is sent while the session streams (a message then would be a steer)
		opts.idle = false;
		expect(await f.emit("input", { text: "pending", source: "interactive" }, ctx)).toEqual({ handled: true });
		const later = l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Raised while busy?", options: ["yes", "no"] });
		timers[0]!.fn();
		expect(shown()).toHaveLength(1);
		opts.idle = true;
		timers[0]!.fn();
		expect(shown()).toHaveLength(2);
		expect(shown()[1]!.options).toEqual({});
		expect(shown()[1]!.message.content).toBe(pendingBlock(pendingItems(l), pendingWaits(l)).text);
		expect(shown()[1]!.message.content).toContain(later);
		timers[0]!.fn();
		expect(shown()).toHaveLength(2);
		// a word that only contains it is not the surface word
		expect(await f.emit("input", { text: "pending q-x", source: "interactive" }, ctx)).toBeUndefined();
		l.close();
	});

	test("the pending block of a reserved request, a plan question, a marked-default question and a free-form question, pasted whole, applies four answers in one transaction (PLAN wl-mv5msri070p0qo § 3)", async () => {
		const f = fakePi();
		const e = env();
		const l = open(e);
		// a free-form question and a reserved request
		const a = l.openWorkload({ by: "lane-a", brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
		const sa = l.addSlice({ by: "lane-a", workloadId: a, task: "t", doneCondition: "d", inputs: "a.ts" });
		const en = l.recordEntry({ by: "lane-a", workloadId: a, sliceId: sa, kind: "reserved-request", body: "git push origin main" });
		const free = l.raiseQuestion({ by: "lane-a", workloadId: a, sliceId: sa, body: "Which header?", options: ["left", "right"] });
		// a plan question whose review verdict is approve
		const p = l.openWorkload({ by: SURFACE, brief: "Plan the pending word", stakes: "normal", mode: "autonomous" });
		const sp = l.addSlice({ by: "lane-p", workloadId: p, task: "plan", doneCondition: "approved", inputs: "brief" });
		l.recordEntry({ by: SURFACE, workloadId: p, kind: "assumption", body: planFirstBody("your word") });
		expect(l.claimWorkload(p, { by: "lane-p", holder: "lane-p", leaseMs: null }).won).toBe(true);
		const planBody = ["/tmp/wl-p/PLAN.md", "- sl-a: the word", "tradeoff: one more word", "review: approve-as-is, openai-codex/gpt-6-sol, /tmp/wl-p/PLAN-REVIEW-r1.md"].join("\n");
		const plan = l.write(() => {
			const id = l.raiseQuestion({ by: "lane-p", workloadId: p, sliceId: sp, body: planBody, options: ["approve", "revise", "cancel"] });
			l.recordEntry({ by: "lane-p", workloadId: p, sliceId: sp, kind: "assumption", body: `plan-question: ${id}` });
			return id;
		});
		// a lane question whose body marks its default
		const c = l.openWorkload({ by: SURFACE, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
		const sc = l.addSlice({ by: "lane-t-1", workloadId: c, task: "t", doneCondition: "d", inputs: "c.ts" });
		const ceiling = l.raiseQuestion({ by: "lane-t-1", workloadId: c, sliceId: sc, body: "Keep going?\nstop (the default): park here.", options: ["extend", "stop", "split"] });
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		notices.length = 0;
		await f.emit("input", { text: "pending", source: "interactive" }, ctx);
		const block = f.sent.find((x) => x.message.customType === "surface-pending")!.message.content;
		expect(block).toBe(pendingBlock(pendingItems(l), pendingWaits(l)).text);
		const fenced = block.split("```text\n")[1]!.split("\n```")[0]!.split("\n");
		// the open plan question's path sits on the line beneath its answer line (every-mention rule, merge-train review of #106)
		expect(fenced[fenced.findIndex((x) => x.startsWith(`approve ${plan}  # `)) + 1]).toBe(`  plan for ${plan}: /tmp/wl-p/PLAN.md`);
		expect(fenced.filter((x) => !x.startsWith("  plan for ")).map((x) => x.split("  # ")[0]).sort()).toEqual([`approve ${en}`, `approve ${plan}`, `left ${free}`, `stop ${ceiling}`].sort());
		// all or nothing: the same block with one line naming a question that does not exist applies none of the four
		const broken = block.replace(`stop ${ceiling}`, "stop q-nope");
		await submitTyped(f, { prompt: broken, systemPrompt: [] }, ctx);
		expect(notices.some((n) => n.startsWith("nothing applied"))).toBe(true);
		expect(pendingItems(l)).toHaveLength(4);
		// Jo pastes it back untouched as his turn: one transaction applies all four
		notices.length = 0;
		await f.emit("input", { text: block, source: "interactive" }, ctx);
		await f.emit("before_agent_start", { prompt: block, systemPrompt: [] }, ctx);
		expect(notices.some((n) => n.startsWith("nothing applied"))).toBe(false);
		expect([free, plan, ceiling].map((id) => [l.question(id)!.state, l.instructions(l.question(id)!.workload_id).find((i) => i.question_id === id)?.body])).toEqual([
			["answered", "left"],
			["answered", "approve"],
			["answered", "stop"],
		]);
		expect(l.instructions(a).some((i) => i.body === `approve ${en}`)).toBe(true);
		expect(l.entries(p, "assumption").some((x) => x.body.startsWith("plan: approved"))).toBe(true);
		expect(pendingItems(l)).toEqual([]);
		expect(errorLines(l).filter((x) => x.kind === "reserved" || x.kind === "question")).toEqual([]);
		// the block's generated wrapper (its heading and fences) forwards nothing: no instruction for the orchestrator (code review r1, finding 4)
		expect(notices.filter((n) => n.includes("an instruction for you"))).toEqual([]);
		l.close();
	});

	test("a numbered batch: each answer its own row and echo line, carried into the turn's context; a bad piece writes nothing; a bare ambiguous word asks which one", async () => {
		const f = fakePi();
		const e = env();
		let ledger = open(e);
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const e1 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		const e2 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy" });
		ledger.close();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		notices.length = 0;
		const batch = (await submitTyped(f, { prompt: "1 approve, 2 deny", systemPrompt: [] }, ctx)) as Started;
		expect(notices).toEqual([`#1 → approved reserved request ${e1}`, `#2 → denied reserved request ${e2}`].map((n) => expect.stringContaining(n)));
		const context = batch.messages[0]!.content;
		expect(context).toContain("## Applied from the surface since your last turn");
		expect(context).toContain(`- #1 → approved reserved request ${e1}`);
		expect(context).toContain(`- #2 → denied reserved request ${e2}`);
		expect(f.entries.filter((x) => x.type === "surface-input")).toHaveLength(1);
		ledger = open(e);
		expect(ledger.instructions(wl).map((i) => [i.body, i.author, i.channel])).toEqual([
			[`approve ${e1}`, "jo", "surface"],
			[`deny ${e2}`, "jo", "surface"],
		]);
		// a reserved request and a question offering approve: #3 and #4 at the next input
		const e3 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "tag the release" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "/tmp/plan.md", options: ["approve", "revise", "cancel"] });
		ledger.close();
		notices.length = 0;
		// one per line is a paste (item 48): the refusal names each line by number and text, then the one to fix
		const refused = (await submitTyped(f, { prompt: "3 approve\n2 deny\n4 revise\n9 deny", systemPrompt: [] }, ctx)) as Started;
		expect(notices).toEqual([
			'line 1 "3 approve": ok, not applied',
			`line 2 "2 deny": #2 (${e2}) is no longer waiting`,
			'line 3 "4 revise": ok, not applied',
			'line 4 "9 deny": #9 is not on the needs-you list',
			"nothing applied: fix line 2 and paste all of it again",
		]);
		expect(refused.messages[0]!.content).toContain(`- line 2 "2 deny": #2 (${e2}) is no longer waiting`);
		// the comma form on one line keeps item 1's per-piece lines
		notices.length = 0;
		await submitTyped(f, { prompt: "3 approve, 9 deny", systemPrompt: [] }, ctx);
		expect(notices).toEqual(["#3 ok, not applied", "#9 is not on the needs-you list"]);
		notices.length = 0;
		const which = (await submitTyped(f, { prompt: "approve", systemPrompt: [] }, ctx)) as Started;
		expect(notices).toEqual([`which one? "approve" fits #3 (reserved ${e3}: tag the release), #4 (${q} on ${sl}) — answer with the number, e.g. "3 approve"`]);
		expect(which.messages[0]!.content).toContain("which one?");
		ledger = open(e);
		expect(ledger.instructions(wl)).toHaveLength(2);
		expect(ledger.question(q)!.state).toBe("open");
		ledger.close();
		// Prose beginning with a number remains Jo's exact input, not a command batch.
		await submitTyped(f, { prompt: "2 things to fix", systemPrompt: [] }, ctx);
		ledger = open(e);
		expect(ledger.instructions(STANDING_WORKLOAD_ID).map((i) => i.body)).toEqual(["2 things to fix"]);
		expect(ledger.question(q)!.state).toBe("open");
		expect(ledger.instructions(wl).map((i) => i.kind)).toEqual(["instruction", "instruction"]);
		ledger.close();
		// the numbers answer them: the question's answer goes through the launch trigger, the echo stays one line per answer
		await submitTyped(f, { prompt: "3 approve, 4 revise", systemPrompt: [] }, ctx);
		ledger = open(e);
		expect(ledger.instructions(wl).map((i) => i.body)).toEqual([
			`approve ${e1}`,
			`deny ${e2}`,
			`approve ${e3}`,
			"revise",
		]);
		expect(ledger.question(q)!.state).toBe("answered");
		const answer = ledger.instructions(wl).find((i) => i.kind === "answer" && i.question_id === q)!;
		expect(ledger.question(q)!.resolved_by).toBe(answer.id);
		ledger.close();
	});

	test("a paste of several lines (item 48): one command per line applied in order, plain-words lines handed on as one instruction; a bad second line applies nothing and names line 2", async () => {
		const f = fakePi();
		const e = env();
		let ledger = open(e);
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const e1 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
		const e2 = ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "deploy" });
		ledger.close();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		// a bad second line: nothing applied, one verdict per command line by number and text, the instruction held
		notices.length = 0;
		const refused = (await submitTyped(f, { prompt: `production ${wl}\n9 deny\nRelaunch the classifier fix now.`, systemPrompt: [] }, ctx)) as Started;
		expect(notices).toEqual([
			`line 1 "production ${wl}": ok, not applied`,
			'line 2 "9 deny": #9 is not on the needs-you list',
			"line 3: an instruction for you, held with the rest; record nothing from this paste",
			"nothing applied: fix line 2 and paste all of it again",
		]);
		expect(refused.messages[0]!.content).toContain('- line 2 "9 deny": #9 is not on the needs-you list');
		ledger = open(e);
		expect(ledger.workload(wl)!.stakes).toBe("normal");
		expect(ledger.instructions(wl)).toEqual([]);
		ledger.close();
		// an ambiguous line gets the "which one?" wording, with its line number and text
		notices.length = 0;
		await submitTyped(f, { prompt: `approve\nproduction ${wl}`, systemPrompt: [] }, ctx);
		expect(notices[0]).toBe(`line 1 "approve": which one? "approve" fits #1 (reserved ${e1}: push main), #2 (reserved ${e2}: deploy) — answer with the number, e.g. "1 approve"`);
		expect(notices.at(-1)).toBe("nothing applied: fix line 1 and paste all of it again");
		// the good paste: a numbered batch line, a stakes word then an exact ceiling on the same workload, and two plain-words paragraphs as one instruction
		notices.length = 0;
		const text = ["1 approve, 2 deny", `production ${wl}`, `ceiling 120 ${wl}`, "Relaunch the classifier fix now.", "", "Use the same plan."].join("\n");
		const applied = (await submitTyped(f, { prompt: text, systemPrompt: [] }, ctx)) as Started;
		expect(notices).toEqual([
			expect.stringContaining(`#1 → approved reserved request ${e1}`),
			expect.stringContaining(`#2 → denied reserved request ${e2}`),
			expect.stringMatching(new RegExp(`^stakes on ${wl} → production \\(instruction \\S+\\); ceiling \\$150 / 12h$`)),
			expect.stringMatching(new RegExp(`^ceiling on ${wl} → \\$120 / 12h \\(instruction \\S+\\)$`)),
			'lines 4–6 → an instruction for you, one row: "Relaunch the classifier fix now. Use the same plan."',
		]);
		expect(applied.messages[0]!.content).toContain("## Applied from the surface since your last turn");
		expect(applied.messages[0]!.content).toContain('- lines 4–6 → an instruction for you, one row: "Relaunch the classifier fix now. Use the same plan."');
		expect(f.entries.filter((x) => x.type === "surface-input")).toHaveLength(3);
		ledger = open(e);
		expect(ledger.instructions(wl).map((i) => [i.body, i.author, i.channel])).toEqual([
			[`approve ${e1}`, "jo", "surface"],
			[`deny ${e2}`, "jo", "surface"],
			["stakes: production", "jo", "surface"],
			["ceiling: 120 12", "jo", "surface"],
		]);
		expect(ledger.workload(wl)!.stakes).toBe("production");
		expect(ceilingOf(ledger, wl)).toEqual({ usd: 120, wallMin: 720 });
		ledger.close();
		// A typed multi-line brief remains exact Jo prose and does not alter command state.
		await submitTyped(f, { prompt: "new workload, normal stakes:\nmove the header offset into a token\nthen drop the old class", systemPrompt: [] }, ctx);
		ledger = open(e);
		expect(ledger.instructions(STANDING_WORKLOAD_ID).map((i) => i.body)).toEqual(["new workload, normal stakes:\nmove the header offset into a token\nthen drop the old class"]);
		expect(ledger.workload(wl)!.stakes).toBe("production");
		expect(ledger.instructions(wl).map((i) => i.kind)).toEqual(["instruction", "instruction", "instruction", "instruction"]);
		ledger.close();
	});

	test("a paste's command naming an id that does not resolve, or a row answered twice, applies nothing and launches nothing; two-word prose stays prose (Codex review of PR #30)", async () => {
		const f = fakePi(undefined, { exec: true });
		const e = env();
		let ledger = open(e);
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Direction?", options: ["left", "right"] });
		ledger.close();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		const unchanged = () => {
			ledger = open(e);
			expect(ledger.workload(wl)).toMatchObject({ stakes: "normal", mode: "autonomous" });
			expect(ledger.question(q)!.state).toBe("open");
			expect(ledger.instructions(wl)).toEqual([]);
			ledger.close();
			expect(f.execs.calls).toEqual([]);
		};
		// Probe A `bad-id`: the stakes line is not applied, the typo is named, nothing is handed on
		notices.length = 0;
		await submitTyped(f, { prompt: `production ${wl}\napprove en-nope`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([`line 1 "production ${wl}": ok, not applied`, 'line 2 "approve en-nope": no entry en-nope on the needs-you list', "nothing applied: fix line 2 and paste all of it again"]);
		unchanged();
		// Probe A `answer-then-invalid`: the answer is not written and no launch runs
		notices.length = 0;
		await submitTyped(f, { prompt: `left ${q}\napprove en-nope`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([`line 1 "left ${q}": ok, not applied`, 'line 2 "approve en-nope": no entry en-nope on the needs-you list', "nothing applied: fix line 2 and paste all of it again"]);
		unchanged();
		// Probe A `unknown-workload`: the named workload must be open; the sole workload in view is not taken instead
		notices.length = 0;
		await submitTyped(f, { prompt: `normal ${wl}\nproduction wl-nope`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([`line 1 "normal ${wl}": ok, not applied`, 'line 2 "production wl-nope": wl-nope is not an open workload', "nothing applied: fix line 2 and paste all of it again"]);
		unchanged();
		// Codex round 2: a bare `wl-` is an id that does not resolve, not the sole workload; a bare `en-` is not prose: the answer is not written and nothing launches
		notices.length = 0;
		await submitTyped(f, { prompt: `left ${q}\nproduction wl-`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([`line 1 "left ${q}": ok, not applied`, 'line 2 "production wl-": wl- is not an open workload', "nothing applied: fix line 2 and paste all of it again"]);
		unchanged();
		notices.length = 0;
		await submitTyped(f, { prompt: `left ${q}\napprove en-`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([`line 1 "left ${q}": ok, not applied`, 'line 2 "approve en-": no entry en- on the needs-you list', "nothing applied: fix line 2 and paste all of it again"]);
		unchanged();
		// S1: the same question answered on two lines, in two forms
		notices.length = 0;
		await submitTyped(f, { prompt: `1 left\nright ${q}`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([`line 1 "1 left": ok, not applied`, `line 2 "right ${q}": ${q} is already answered on line 1 (#1); once per row`, "nothing applied: fix line 2 and paste all of it again"]);
		unchanged();
		notices.length = 0;
		await submitTyped(f, { prompt: `left ${q}\nright ${q}`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([`line 1 "left ${q}": ok, not applied`, `line 2 "right ${q}": ${q} is already answered on line 1; once per row`, "nothing applied: fix line 2 and paste all of it again"]);
		unchanged();
		// N1: a numbered batch one per line names its lines too
		notices.length = 0;
		await submitTyped(f, { prompt: "1 left\n1 right", systemPrompt: [] }, ctx);
		expect(notices).toEqual(['line 1 "1 left": #1 appears more than once in this batch', 'line 2 "1 right": #1 appears more than once in this batch', "nothing applied: fix line 1 and paste all of it again"]);
		unchanged();
		// Ordinary paragraphs containing command words are recorded as Jo's exact prose, not commands.
		await submitTyped(f, { prompt: "The build is\nproduction ready", systemPrompt: [] }, ctx);
		await submitTyped(f, { prompt: "Go on\nautonomous now", systemPrompt: [] }, ctx);
		ledger = open(e);
		expect(ledger.instructions(STANDING_WORKLOAD_ID).map((i) => i.body)).toEqual(["The build is\nproduction ready", "Go on\nautonomous now"]);
		expect(ledger.question(q)!.state).toBe("open");
		expect(ledger.workload(wl)).toMatchObject({ stakes: "normal", mode: "autonomous" });
		expect(ledger.instructions(wl)).toEqual([]);
		ledger.close();
		expect(f.execs.calls).toEqual([]);
		unchanged();
		// Probe B `answer-with-prose`: the answer lands and launches once; the prose is handed on, not recorded by the surface
		notices.length = 0;
		await submitTyped(f, { prompt: `left ${q}\nUse the same plan.\nKeep the existing tests.`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([expect.stringContaining(`answered ${q} with "left"`), 'lines 2–3 → an instruction for you, one row: "Use the same plan. Keep the existing tests."']);
		expect(f.execs.calls).toHaveLength(1);
		ledger = open(e);
		expect(ledger.question(q)!.state).toBe("answered");
		expect(ledger.instructions(wl).map((i) => i.kind)).toEqual(["answer"]);
		ledger.close();
	});

	// Codex round 2, Probe C `runtime-withdrawal`: the one public refusal that passes preflight. `stop-reviews <sl>` withdraws the
	// review-limit question inside the transaction, so `extend <q>` on the next line fails in the ledger: the write rolls back whole.
	test("a paste refused by the ledger inside its transaction rolls back every line, names the failing line, and launches nothing (Codex round 2)", async () => {
		const f = fakePi(undefined, { exec: true });
		const e = env();
		let ledger = open(e);
		const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "a.ts" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Round limit reached", options: [...ROUND_LIMIT_OPTIONS] });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLimitBody(q, sl) });
		const assumptions = ledger.entries(wl, "assumption").length;
		ledger.close();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		notices.length = 0;
		const refused = (await submitTyped(f, { prompt: `stop-reviews ${sl}\nextend ${q}`, systemPrompt: [] }, ctx)) as Started;
		expect(notices).toEqual([
			`line 1 "stop-reviews ${sl}": ok, not applied`,
			expect.stringMatching(new RegExp(`^line 2 "extend ${q}": .*must name an open question`)),
			"nothing applied: fix line 2 and paste all of it again",
		]);
		expect(refused.messages[0]!.content).toContain("nothing applied: fix line 2 and paste all of it again");
		expect(f.execs.calls).toEqual([]);
		ledger = open(e);
		expect(ledger.question(q)!.state).toBe("open");
		expect(ledger.instructions(wl)).toEqual([]);
		expect(ledger.entries(wl, "assumption")).toHaveLength(assumptions);
		ledger.close();
	});

	test("a bare stakes, mode, ceiling, rounds or stop-reviews word with two open workloads asks which one, listing both, and writes nothing; with the id it applies", async () => {
		const f = fakePi();
		const e = env();
		// a opens an hour before b, so the view order (oldest first) and the example's id are fixed
		const c = clock("2026-01-01T10:00:00.000Z");
		let ledger = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false, clock: c.now });
		const a = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
		c.plusHours(1);
		const b = ledger.openWorkload({ by: "lane-a", brief: "Move every legacy route behind the auth preHandler, one route at a time\nthen drop the old guard", stakes: "normal", mode: "autonomous" });
		const ceilings = [ceilingOf(ledger, a), ceilingOf(ledger, b)];
		ledger.close();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		for (const word of ["production", "user-driven", "ceiling 80 4", "rounds 5", "stop-reviews"]) {
			notices.length = 0;
			await submitTyped(f, { prompt: word, systemPrompt: [] }, ctx);
			expect(notices).toHaveLength(1);
			const line = notices[0]!;
			expect(line.startsWith(`which one? "${word}" fits ${a} (`)).toBe(true);
			expect(line).toContain(`${a} (Fix the feed header offset; stakes: normal · mode: autonomous · ceiling `);
			expect(line).toContain(`${b} (Move every legacy route behind the auth preHandler, one rou…; stakes: normal · mode: autonomous · ceiling `);
			expect(line.endsWith(`add the id, e.g. "${word} ${a}"`)).toBe(true);
			ledger = open(e);
			for (const [i, wl] of [a, b].entries()) {
				expect(ledger.instructions(wl)).toEqual([]);
				expect(ledger.workload(wl)).toMatchObject({ stakes: "normal", mode: "autonomous" });
				expect(ceilingOf(ledger, wl)).toEqual(ceilings[i]!);
			}
			ledger.close();
		}
		notices.length = 0;
		await submitTyped(f, { prompt: `production ${a}`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([expect.stringMatching(new RegExp(`^stakes on ${a} → production \\(instruction \\S+\\); ceiling `))]);
		ledger = open(e);
		expect(ledger.workload(a)!.stakes).toBe("production");
		expect(ledger.workload(b)!.stakes).toBe("normal");
		ledger.close();
		// `rounds <n> wl-…` is three words: the hook admits it (never as a batch); `stop-reviews wl-…` names the workload
		notices.length = 0;
		await submitTyped(f, { prompt: `rounds 5 ${b}`, systemPrompt: [] }, ctx);
		await submitTyped(f, { prompt: `stop-reviews ${b}`, systemPrompt: [] }, ctx);
		expect(notices).toEqual([
			expect.stringMatching(new RegExp(`^review round limit on ${b} → 5 failed rounds per review loop \\(instruction \\S+\\)$`)),
			expect.stringMatching(new RegExp(`^stopped every review loop on ${b} \\(instruction \\S+\\); no review loop is open`)),
		]);
		ledger = open(e);
		expect(ledger.instructions(b).map((i) => [i.body, i.author, i.channel])).toEqual([["rounds: 5", "jo", "surface"], [`stop-reviews: ${b}`, "jo", "surface"]]);
		expect(ledger.entries(b, "assumption").map((x) => x.body).filter((x) => x.startsWith("review-"))).toEqual([
			`review-rounds: 5 source your word by ${ledger.instructions(b)[0]!.id}`,
			`review-stop: ${b} by ${ledger.instructions(b)[1]!.id}`,
		]);
		ledger.close();
		// Four words are exact prose, not the three-word command.
		await submitTyped(f, { prompt: `rounds 5 ${b} please`, systemPrompt: [] }, ctx);
		ledger = open(e);
		expect(ledger.instructions(STANDING_WORKLOAD_ID).map((i) => i.body)).toEqual([`rounds 5 ${b} please`]);
		expect(ledger.instructions(a).map((i) => i.body)).toEqual(["stakes: production"]);
		expect(ledger.instructions(b).map((i) => i.body)).toEqual(["rounds: 5", `stop-reviews: ${b}`]);
		expect(ledger.workload(a)!.stakes).toBe("production");
		expect(ledger.workload(b)!.stakes).toBe("normal");
		ledger.close();
	});

	test("identity, open (stakes inferred, decision log carried), schedule, close (decision log rendered)", async () => {
		const f = fakePi();
		const e = env();
		orchestratorSurface(f.pi, e);
		const repo = tmp("repo");
		const logDir = join(repo, ".ai", "decision-log");
		mkdirSync(logDir, { recursive: true });
		const today = new Date().toISOString().slice(0, 10);
		writeFileSync(join(logDir, `${today}--0900--plumb--prior.md`), "---\nstatus: resolved\n---\n\n## Decisions made (and why)\n\n- prior decision\n");
		const ctx = ctxOf({ cwd: repo });
		const who = await f.tool("orchestrator_identity").execute("1", { name: "Sable", pronouns: "they/them" }, undefined, undefined, ctx);
		expect(who.content[0]!.text).toMatch(/^You are now Sable \(they\/them\); entry en-/);
		const opened = await f.tool("orchestrator_open_workload").execute("1", { brief: "hotfix the feed header", done: "the feed header renders at the right offset in production" }, undefined, undefined, ctx);
		const id = (opened.details as { id: string }).id;
		expect(opened.content[0]!.text).toContain(`Opened ${id} on ${repo}`);
		expect(opened.content[0]!.text).toContain("stakes: production · mode: autonomous");
		expect(opened.content[0]!.text).toContain('inferred production: you said "hotfix"');
		expect(opened.content[0]!.text).toContain("prior decision");
		const overridden = await f.tool("orchestrator_open_workload").execute("1", { brief: "hotfix again", done: "the second hotfix is live", stakes: "throwaway", mode: "user-driven" }, undefined, undefined, ctx);
		expect(overridden.content[0]!.text).toContain("stakes overridden to throwaway; mode overridden to user-driven");
		const sched = await f.tool("orchestrator_schedule").execute("1", { due: "2020-01-01", text: "re-measure the threshold; method = routing_review" }, undefined, undefined, ctx);
		const sid = (sched.details as { id: string }).id;
		const bad = await f.tool("orchestrator_schedule").execute("1", { due: "someday", text: "x" }, undefined, undefined, ctx);
		expect(bad.content[0]!.text).toContain("nothing was opened");
		// the due row is under needs-you at the next wake
		await f.emit("session_compact", {}, ctx);
		const wake = (await f.emit("before_agent_start", { prompt: "x", systemPrompt: [] }, ctx)) as Started;
		expect(wake.messages[0]!.content).toContain("scheduled and past due (2020-01-01): re-measure the threshold");
		expect(wake.messages[0]!.content).toContain("you are Sable (they/them)");
		await f.tool("orchestrator_wake_read").execute("1", { body: "resuming" }, undefined, undefined, ctx);
		// close: refused with open slices; the standing workload never closes; a scheduled row closes with a receipt and no log entry
		const ledger = open(e);
		const sl = ledger.addSlice({ by: "lane-a", workloadId: id, task: "t", doneCondition: "d", inputs: "a" });
		ledger.close();
		const refused = await f.tool("orchestrator_close_workload").execute("1", { workloadId: id }, undefined, undefined, ctx);
		expect(refused.content[0]!.text).toContain("cannot close: 1 open slice(s)");
		expect((await f.tool("orchestrator_close_workload").execute("1", { workloadId: STANDING_WORKLOAD_ID }, undefined, undefined, ctx)).content[0]!.text).toContain("never closed");
		const closedSched = await f.tool("orchestrator_close_workload").execute("1", { workloadId: sid, receipt: "measured: threshold stays 0.55" }, undefined, undefined, ctx);
		expect(closedSched.content[0]!.text).toContain("scheduled row: no decision-log entry");
		const l2 = open(e);
		l2.completeSlice(sl, { by: "lane-a", artifact: "done" });
		// Decision 16: close needs the holder's done-because: receipt; lane-a was launched on it (the starter's launch: names it), holds, records, releases.
		l2.recordEntry({ by: "lane-starter", workloadId: id, kind: "assumption", body: "launch: lane-a cause first requested-by test" });
		expect(l2.claimWorkload(id, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 }).won).toBe(true);
		l2.recordEntry({ by: "lane-a", workloadId: id, kind: "assumption", body: "done-because: the feed header renders at the right offset (PR #12 merged)" });
		l2.releaseWorkload(id, { by: "lane-a", holder: "lane-a" });
		expect(l2.instructions(sid).at(-1)!.body).toBe("close receipt: measured: threshold stays 0.55");
		l2.close();
		const closed = await f.tool("orchestrator_close_workload").execute("1", { workloadId: id, receipt: "shipped" }, undefined, undefined, ctx);
		const path = (closed.details as { path: string }).path;
		expect(path.startsWith(logDir)).toBe(true);
		expect(path).toMatch(/--sable--hotfix-the-feed-header\.md$/);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toContain("## What changed");
		const l3 = open(e);
		expect(l3.workload(id)!.status).toBe("closed");
		expect((await f.tool("orchestrator_close_workload").execute("1", { workloadId: id }, undefined, undefined, ctx)).content[0]!.text).toContain("already closed");
		l3.close();
	});

	// M7 fix round 2, finding C: Jo typed `status` at 05:09:47 and the reply repeated a stale state,
	// because the render reached the model only at a wake. The on-demand read is that render.
	test("orchestrator_ledger: a slice done and a message enqueued after the wake show in the read, and the message is delivered by it", async () => {
		const f = fakePi();
		const e = env();
		const seed = open(e);
		const wl = seed.openWorkload({ by: "lane-a", brief: "Add a line to the README", stakes: "normal", mode: "autonomous" });
		const sl = seed.addSlice({ by: "lane-a", workloadId: wl, task: "write the line", doneCondition: "README.md has it", inputs: "README.md" });
		seed.close();
		await orchestratorSurface(f.pi, e, { loadText: loadTestText });
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const wake = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as Started;
		// the wake is one line per workload (surface/src/render.ts workloadLine); the slice rows are the read's
		expect(wake.messages[0]!.content).toContain(`- ${wl}: Add a line to the README · stakes: normal · mode: autonomous`);
		expect(wake.messages[0]!.content).toContain("slices: 1 open");
		expect(wake.messages[0]!.content).not.toContain(`- ${sl} [open]`);
		await f.tool("orchestrator_wake_read").execute("1", { body: `resuming ${wl}` }, undefined, undefined, ctx);
		// after the wake, the lane finishes the slice and reports to the orchestrator
		const lane = open(e);
		lane.completeSlice(sl, { by: "lane-a", artifact: "README.md written" });
		lane.close();
		expect(await f.emit("tool_call", { toolName: "orchestrator_ledger", input: {} }, ctx)).toBeUndefined();
		for (const params of [{}, { workload: wl }]) {
			const l = open(e);
			const msg = l.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `slice done: README line landed (${JSON.stringify(params)})` });
			l.close();
			const read = (await f.tool("orchestrator_ledger").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
			expect(read).toMatch(/^# Ledger at .* \(read on demand/);
			expect(read).toContain(`slice ${sl} done by lane-a: README.md written`);
			expect(read).toContain(`${msg} [held] lane-a → orchestrator (${sl}): slice done: README line landed`);
			const after = open(e);
			expect(after.message(msg)!.state).toBe("delivered");
			after.close();
		}
		expect((await f.tool("orchestrator_ledger").execute("1", { workload: "wl-nope" }, undefined, undefined, ctx)).content[0]!.text).toBe("No workload wl-nope.");
	});

	// M7 fix round 2, finding B: Jo's answer to the orchestrator's QUESTION lands on the workload as an instruction row.
	// Fix round 1 (PR #55 review, B1): the words are the input row the surface wrote for what Jo typed, never the model's parameter.
	test("orchestrator_record_instruction: Jo's input row's bytes plus the reading, author jo, channel surface, kind instruction, the input spent once; refused without a receipt, with a forged or spent one, on the standing, a closed or an unknown workload", async () => {
		const f = fakePi();
		const e = env();
		const seed = open(e);
		const wl = seed.openWorkload({ by: SURFACE, brief: "Add a line to the README", stakes: "normal", mode: "autonomous" });
		const done = seed.openWorkload({ by: SURFACE, brief: "old", stakes: "normal", mode: "autonomous" });
		seed.closeWorkload(done, { by: SURFACE });
		seed.close();
		orchestratorSurface(f.pi, e);
		const ctx = ctxOf();
		const rec = f.tool("orchestrator_record_instruction");
		const record = async (params: Record<string, unknown>) => (await rec.execute("1", { reading: "use the drafted README line", ...params }, undefined, undefined, ctx)).content[0]!.text;
		// Jo types it: the surface writes the input row and names it; the model's `words` is not a parameter.
		await f.emit("input", { text: "use your draft", source: "interactive" }, ctx);
		await f.emit("before_agent_start", { prompt: "use your draft", systemPrompt: [] }, ctx);
		const input = (f.entries.find((x) => x.type === "surface-jo-input") as { data: { id: string } } | undefined)?.data.id;
		expect(input).toStartWith("in-");
		expect(await record({ workloadId: wl, words: "use your draft" })).toContain("pass inputId");
		expect(await record({ workloadId: wl, inputId: "in-forged" })).toBe("in-forged is not an input Jo typed at the surface; nothing was recorded.");
		for (const bad of [{ workloadId: STANDING_WORKLOAD_ID }, { workloadId: done }, { workloadId: "wl-nope" }, { workloadId: wl, reading: " " }]) {
			expect(await record({ inputId: input, ...bad })).toContain("nothing was recorded");
		}
		const r = await record({ workloadId: wl, inputId: input, words: "rewrite it" });
		expect(r).toMatch(new RegExp(`^Recorded instruction in-\\S+ on ${wl} from Jo's input ${input} \\(author jo, channel surface; reading en-\\S+\\): "use your draft" — use the drafted README line$`));
		expect(await record({ workloadId: wl, inputId: input })).toBe(`${input} already instructed ${wl}, and one input is recorded once; nothing was recorded.`);
		const check = open(e);
		const rows = check.instructions(wl);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "instruction", author: "jo", channel: "surface", body: 'Jo: "use your draft" — reading: use the drafted README line' });
		expect(check.entries(STANDING_WORKLOAD_ID, "assumption").map((x) => x.body)).toContain(`reading: use the drafted README line (input ${input} instructs ${wl})`);
		expect(check.instructions(done)).toEqual([]);
		check.close();
	});
});

describe("cancel-slice at the surface (PLAN wl-mv5i3lulwwbbi8 D1)", () => {
	test("a parked lane's question: withdrawn, the slice cancelled, Jo's launch-requested: written, and the trigger execs the starter once", async () => {
		const f = fakePi(undefined, { exec: true });
		const e = env();
		const seed = open(e);
		const wl = seed.openWorkload({ by: SURFACE, brief: "Fix the header", stakes: "normal", mode: "autonomous" });
		seed.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
		const sl = seed.addSlice({ by: "lane-t-1", workloadId: wl, task: "stale review", doneCondition: "d", inputs: "i" });
		const q = seed.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: sl, body: "Wait for the review?", options: ["wait", "skip"] });
		seed.close();
		orchestratorSurface(f.pi, e, {});
		notices.length = 0;
		await submitTyped(f, { prompt: `cancel-slice ${sl}`, systemPrompt: [] }, ctxOf());
		const shown = notices.join("\n");
		expect(shown).toContain(`cancelled slice ${sl} on ${wl}`);
		expect(shown).toContain(`withdrew ${q}`);
		expect(shown).toContain("no lane holds it live, so a relaunch is requested");
		expect(f.execs.calls).toHaveLength(1);
		expect(f.execs.calls[0]!.args.slice(1)).toEqual(["launch", wl, "--requested-by", "jo"]);
		const l = open(e);
		expect(l.question(q)!.state).toBe("withdrawn");
		expect(l.slice(sl)!.state).toBe("cancelled");
		expect(l.instructions(wl).map((i) => [i.kind, i.author, i.channel])).toEqual([["instruction", "jo", "surface"], ["withdrawal", "jo", "surface"]]);
		l.close();
	});
});
