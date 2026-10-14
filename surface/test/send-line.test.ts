// The machine needs-Jo list and `send:` line (PLAN wl-mv66ylg1op3wg0 D5), `ok` applying exactly the
// last rendered line (D6), and the batch reply that is machinery's, never the model's (D7). Driven
// through the real extension with the fake host (`input`, `agent_end`, `before_agent_start`) and a
// recorded fake judge, as surface/test/batch-skip.test.ts and surface/test/triage.test.ts do: the
// render's display, entry and binding; `ok`'s exact option-word answers, side effects and
// `send-applied:` link; what `ok` refuses or leaves to the model as prose; the reply held through a
// live stream and shown once after the turn's end; and the batch-turn entry with its hidden trigger.
//
// Red before (PLAN wl-mv66ylg1op3wg0, § Tests): this file imports only modules that exist on
// origin/main, so on main every test loads and fails on its assertions. The send-line row's names
// (surface/extensions/send-line.ts, surface/extensions/surface-input.ts STALE_OK, surface/src/types.ts
// RECOMMEND_TOOL) and the triage judge's shape (surface/src/triage.ts) are written out here as literals.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KindJudge } from "../../classifier/src/classify";
import { SCRATCH_CAP_DEFAULT_MB, SCRATCH_ENTRY, SCRATCH_TOTAL_DEFAULT_MB, SCRATCH_TOTAL_ENV, scratchBase, scratchRootFor } from "../../gates/src/scratch";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { scratchCapCheck } from "../extensions/lane";
import { CEILING_OPTIONS } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { ceilingOf } from "../src/input";
import { doneBody, SCRATCH_SWEEP_BY } from "../src/launch";
import { Numbering } from "../src/numbering";
import { surfaceSession } from "../src/session";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, notified, tempLedger, timeouts, tmp } from "./helpers";

const SEND_LINE_TYPE = "surface-send-line";
const BATCH_TURN_TYPE = "surface-batch-turn";
const BATCH_TRIGGER_TYPE = "surface-batch-trigger";
const RECOMMEND_TOOL = "orchestrator_recommend";
const STALE_OK = "nothing applied: the send line is no longer the last thing shown; answer by number or wait for the next send line";
const TRIAGE_CHOICES = ["routine", "needs-jo-irreversible", "needs-jo-product-call", "needs-jo-cost", "needs-jo-unclear"] as const;

/** What triage asks of a judge (surface/src/triage.ts TriageJudge): one `triage` answer per request, and the model it routes to first. */
interface TriageJudge {
	judge(request: { state: string; questions: unknown }, options?: { signal?: AbortSignal }): Promise<{
		answers: { triage?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } };
		model: string;
		provider: string;
	}>;
	primaryModel?(): { provider: string; id: string } | undefined;
}

const LONG_LEASE = 100 * 3_600_000;

/** The recorded fake judge: every row routine at 0.99 (a whole distribution, the rest spread evenly), calls counted. */
function routineJudge(): TriageJudge & { calls: () => number } {
	let calls = 0;
	const triage = { choice: "routine", confidence: 0.99, probabilities: Object.fromEntries(TRIAGE_CHOICES.map((c) => [c, c === "routine" ? 0.99 : 0.0025])) };
	return {
		calls: () => calls,
		primaryModel: () => ({ provider: "typesafe", id: "jev-1.13.0" }),
		async judge() {
			calls++;
			return { answers: { triage }, provider: "typesafe", model: "jev-1.13.0" };
		},
	};
}

/** A surface over `db` with the fake judge wired as OMP's judge role; the lane starter's exec is recorded, never run. */
function surface(db: string, judge: TriageJudge = routineJudge()) {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: db, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: true });
	orchestratorSurface(f.pi, env, { judge: async () => judge as unknown as KindJudge });
	const ctx = ctxOf();
	const s = () => surfaceSession(ctx, env);
	const input = (text: string, source = "interactive") => f.emit("input", { text, source }, ctx);
	/** A turn's terminal end, then every one-shot timer it registered, awaited (the held reply's flush). */
	const end = async () => {
		const from = timeouts.length;
		await f.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
		for (const t of timeouts.splice(from)) await t.fn();
	};
	const displays = () => f.sent.filter((m) => m.message.customType === SEND_LINE_TYPE);
	const raise = async (params: Record<string, unknown>): Promise<string> => {
		const text = (await f.tool("orchestrator_raise_question").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
		const m = /^Raised question (q-\S+)/.exec(text);
		if (!m) throw new Error(`not raised: ${text}`);
		return m[1]!;
	};
	return { f, ctx, s, input, end, displays, raise };
}

/** An open workload held by `lane` under a lease that outlives the test, with one slice. */
function held(ledger: Ledger, lane: string, brief: string): { wl: string; sl: string } {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody(`${brief} is done`) });
	expect(ledger.claimWorkload(wl, { by: lane, holder: lane, leaseMs: LONG_LEASE }).won).toBe(true);
	const sl = ledger.addSlice({ by: lane, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	return { wl, sl };
}

/** The runner's ceiling question on a workload under a $50 / 6h ceiling (surface/test/ceiling-surface.test.ts's fixture). */
function ceilingQuestion(l: Ledger) {
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	const sl = l.addSlice({ by: LANE_RUNNER_BY, workloadId: wl, id: "sl-ceiling-1", task: "Jo decides the ceiling overrun", doneCondition: "Jo answered", inputs: "spend" });
	const q = l.raiseQuestion({ by: LANE_RUNNER_BY, workloadId: wl, sliceId: sl, body: "80 % of the ceiling", options: [...CEILING_OPTIONS] });
	return { wl, sl, q };
}

/** A lane's question with `keep` marked recommended in its body, a ceiling question Ilex recommends `extend` on, and a lane death. */
async function routineTwo() {
	const { ledger, path } = tempLedger();
	const a = held(ledger, "lane-a", "Fix the feed header");
	const qa = ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Keep the `legacy` alias? `keep` (recommended), or drop it", options: ["drop", "keep"] });
	const c = ceilingQuestion(ledger);
	const d = held(ledger, "lane-d", "Dead lane work");
	ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: d.wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: "lane-died: lane-d: died (signal SIGKILL)" });
	const sur = surface(path);
	expect(sur.f.registered()).toContain(RECOMMEND_TOOL);
	const recorded = await sur.f.tool(RECOMMEND_TOOL).execute("1", { item: c.q, word: "extend", reason: "the usual" }, undefined, undefined, sur.ctx);
	expect(recorded.content[0]!.text).toStartWith("Recorded: ");
	return { ledger, path, a, qa, c, d, ...sur };
}

const numberOf = (ledger: Ledger, id: string): number => new Numbering().assign(errorLines(ledger)).find((l) => l.rowId === id)!.n!;
/** Every answer row in the ledger, oldest first, whatever workload it is on. */
const answerRows = (ledger: Ledger) =>
	ledger.db.query<{ id: string; question_id: string; body: string }, []>("SELECT id, question_id, body FROM instructions WHERE kind = 'answer' ORDER BY created_at, rowid").all();
const joRows = (ledger: Ledger) => ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => i.kind === "instruction" && i.author === "jo");
const standingBodies = (ledger: Ledger, prefix: string) => ledger.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.body.startsWith(prefix)).map((e) => e.body);
/** A message pushed with triggerTurn: a model request the surface asked for. */
const turnsAsked = (sent: { options?: unknown }[]) =>
	sent.filter((m) => typeof m.options === "object" && m.options !== null && "triggerTurn" in m.options && m.options.triggerTurn === true);

describe("the render at agent_end (D5)", () => {
	test("one surface-send-line display: the needs-Jo list with reasons, then the send: line, ledgered, entered and bound", async () => {
		const t = await routineTwo();
		const [na, nc] = [numberOf(t.ledger, t.qa), numberOf(t.ledger, t.c.q)];
		await t.end();
		expect(t.displays()).toHaveLength(1);
		const shown = t.displays()[0]!;
		const lines = shown.message.content.split("\n");
		expect(lines[0]).toBe("needs Jo:");
		expect(lines[1]).toMatch(new RegExp(`^lane died: ${t.d.wl} — .+ \\(no one-word answer\\)$`));
		const pieces = [`${na} keep`, `${nc} extend`].sort((x, y) => Number.parseInt(x) - Number.parseInt(y)).join(", ");
		expect(lines.at(-1)).toBe(`send: ${pieces}`);
		expect(shown.message.display).toBe(true);
		expect(turnsAsked([shown])).toHaveLength(0);
		const [body] = standingBodies(t.ledger, "send-line: ");
		const id = /^send-line: (sr-\S+) /.exec(body!)![1]!;
		expect(body).toBe(`send-line: ${id} ${pieces}`);
		expect(t.f.entries.filter((e) => e.type === SEND_LINE_TYPE).map((e) => e.data)).toEqual([{ id, pieces, seq: t.s().displaySeq }]);
		expect(t.s().sendLine).toEqual({ id, pieces, seq: t.s().displaySeq });
		expect(shown.message.details).toEqual({ seq: t.s().displaySeq, id });
	});

	test("a turn whose only needs-you line is a lane death: the needs-Jo line, no send: line, no binding", async () => {
		const { ledger, path } = tempLedger();
		const d = held(ledger, "lane-d", "Dead lane work");
		ledger.enqueue({ by: LANE_RUNNER_BY, workloadId: d.wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: "lane-died: lane-d: died (signal SIGKILL)" });
		const judge = routineJudge();
		const t = surface(path, judge);
		await t.end();
		expect(t.displays()).toHaveLength(1);
		const lines = t.displays()[0]!.message.content.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("needs Jo:");
		expect(lines[1]).toMatch(new RegExp(`^lane died: ${d.wl} — .+ \\(no one-word answer\\)$`));
		expect(t.s().sendLine).toBeNull();
		expect(t.f.entries.some((e) => e.type === SEND_LINE_TYPE)).toBe(false);
		expect(standingBodies(ledger, "send-line: ")).toEqual([]);
		expect(judge.calls()).toBe(0);
	});

	test("only scratch lines (a holder's turn-end scratch-over-cap:, the sweep's standing scratch-disk:): each shown as `scratch over its cap`, no send: line, no binding, no judge call", async () => {
		const { ledger, path } = tempLedger();
		const a = held(ledger, "lane-a", "Fix the feed header");
		const root = scratchRootFor("/h", a.wl);
		// The lane row's own turn-end cap check (surface/extensions/lane.ts), written as lane-a, the lane holding the workload.
		expect(scratchCapCheck(ledger, { workloadId: a.wl, by: "lane-a", root, capMb: SCRATCH_CAP_DEFAULT_MB, kib: 3000 * 1024 })).toBe(`scratch-over-cap: 3000.0 MiB over the 2048 MiB cap at ${root}`);
		// The daily sweep's entry on the standing workload, as its writer and in its shape (surface/scripts/scratch-sweep.ts).
		ledger.recordEntry({
			by: SCRATCH_SWEEP_BY, workloadId: ensureStandingWorkload(ledger), kind: "assumption",
			body: `${SCRATCH_ENTRY.disk} 12000.5 MiB under ${scratchBase("/h")} passes ${SCRATCH_TOTAL_DEFAULT_MB} MiB (${SCRATCH_TOTAL_ENV}); report /h/sweep.md`,
		});
		const judge = routineJudge();
		const t = surface(path, judge);
		await t.end();
		expect(t.displays()).toHaveLength(1);
		const lines = t.displays()[0]!.message.content.split("\n");
		expect(lines[0]).toBe("needs Jo:");
		expect(lines.slice(1).sort()).toEqual([
			`scratch over its cap: ${a.wl} — ${`scratch of ${a.wl} over its cap: 3000.0 MiB over the 2048 MiB cap at ${root}`.slice(0, 59)}… (no one-word answer)`,
			`scratch over its cap: ${STANDING_WORKLOAD_ID} — scratch disk: 12000.5 MiB under /h/agent-scratch/agent-syst… (no one-word answer)`,
		].sort());
		expect(t.s().sendLine).toBeNull();
		expect(t.f.entries.some((e) => e.type === SEND_LINE_TYPE)).toBe(false);
		expect(standingBodies(ledger, "send-line: ")).toEqual([]);
		expect(judge.calls()).toBe(0);
	});

	test("a scratch line beside a routine row: the scratch line needs Jo with its reason, the send: line holds only the routine row's piece, one judge call", async () => {
		const { ledger, path } = tempLedger();
		const a = held(ledger, "lane-a", "Fix the feed header");
		const qa = ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Keep the `legacy` alias? `keep` (recommended), or drop it", options: ["drop", "keep"] });
		const root = scratchRootFor("/h", a.wl);
		expect(scratchCapCheck(ledger, { workloadId: a.wl, by: "lane-a", root, capMb: SCRATCH_CAP_DEFAULT_MB, kib: 3000 * 1024 })).toBe(`scratch-over-cap: 3000.0 MiB over the 2048 MiB cap at ${root}`);
		const judge = routineJudge();
		const t = surface(path, judge);
		const na = numberOf(ledger, qa);
		await t.end();
		expect(t.displays()).toHaveLength(1);
		expect(t.displays()[0]!.message.content.split("\n")).toEqual([
			"needs Jo:",
			`scratch over its cap: ${a.wl} — ${`scratch of ${a.wl} over its cap: 3000.0 MiB over the 2048 MiB cap at ${root}`.slice(0, 59)}… (no one-word answer)`,
			`send: ${na} keep`,
		]);
		expect(t.s().sendLine).toMatchObject({ pieces: `${na} keep` });
		expect(standingBodies(ledger, "send-line: ")).toEqual([expect.stringMatching(new RegExp(`^send-line: sr-\\S+ ${na} keep$`))]);
		expect(judge.calls()).toBe(1);
	});

	test("nothing on the needs-you view: no display", async () => {
		const { path } = tempLedger();
		const t = surface(path);
		await t.end();
		expect(t.displays()).toHaveLength(0);
		expect(t.s().sendLine).toBeNull();
	});
});

describe("`ok` applies exactly the last rendered line (D6, D7)", () => {
	test("ok: the option-word answers, the ceiling's extend side effects, Jo's ok row and the send-applied link; handled, no turn, one reply", async () => {
		const t = await routineTwo();
		await t.end();
		const bound = t.s().sendLine!;
		const sentBefore = t.f.sent.length;
		expect(await t.input("ok")).toEqual({ handled: true });
		// exact option words as the answer bodies
		expect(t.ledger.question(t.qa)).toMatchObject({ state: "answered" });
		expect(t.ledger.question(t.c.q)).toMatchObject({ state: "answered" });
		const byQ = Object.fromEntries(answerRows(t.ledger).map((i) => [i.question_id, i]));
		expect(byQ[t.qa]!.body).toBe("keep");
		expect(byQ[t.c.q]!.body).toBe("extend");
		// the ceiling answer's side effects, as a typed `extend` has them
		const ext = t.ledger.question(t.c.q)!.resolved_by!;
		expect(ceilingOf(t.ledger, t.c.wl)).toEqual({ usd: 100, wallMin: 720 });
		expect(t.ledger.slice(t.c.sl)).toMatchObject({ state: "done", artifact: `answered extend ${ext}` });
		// Jo's ok row and the link, answers in the line's order
		const ok = joRows(t.ledger);
		expect(ok.map((r) => r.body)).toEqual(["ok"]);
		const order = bound.pieces.split(", ").map((p) => (p.endsWith("keep") ? t.ledger.question(t.qa)!.resolved_by! : ext));
		expect(standingBodies(t.ledger, "send-applied: ")).toEqual([`send-applied: ${bound.id} ${ok[0]!.id} ${order.join(" ")} skipped none`]);
		// nothing for the model: not in the FIFO, no turn asked for; one reply display, the applied lines then the fresh render
		expect(t.s().typed).toEqual([]);
		const after = t.f.sent.slice(sentBefore);
		expect(turnsAsked(after)).toHaveLength(0);
		expect(after.map((m) => m.message.customType)).toEqual([SEND_LINE_TYPE]);
		const reply = after[0]!.message.content.split("\n");
		expect(reply.slice(0, 2).every((l) => /^#\d+ → /.test(l))).toBe(true);
		expect(reply[2]).toBe("");
		expect(reply[3]).toBe("needs Jo:");
		expect(reply.some((l) => l.startsWith("send:"))).toBe(false);
		expect(t.s().sendLine).toBeNull();
		expect(t.f.entries.filter((e) => e.type === "surface-input").map((e) => e.data)).toEqual([{ text: "ok", receipt: expect.any(String) }]);
	});

	test("a question withdrawn after the render: ok applies the rest and names it skipped", async () => {
		const t = await routineTwo();
		await t.end();
		const bound = t.s().sendLine!;
		const na = numberOf(t.ledger, t.qa);
		t.ledger.withdrawQuestion(t.qa, { by: "lane-a", reason: "moot", author: "lane-a", channel: "direct", then: "cancel" });
		expect(await t.input("OK")).toEqual({ handled: true });
		expect(t.ledger.question(t.c.q)).toMatchObject({ state: "answered" });
		expect(answerRows(t.ledger).map((i) => i.question_id)).toEqual([t.c.q]);
		const reply = t.displays().at(-1)!.message.content;
		expect(reply).toContain(`#${na} skipped: ${t.qa} is no longer waiting`);
		const ok = joRows(t.ledger)[0]!;
		expect(standingBodies(t.ledger, "send-applied: ")).toEqual([`send-applied: ${bound.id} ${ok.id} ${t.ledger.question(t.c.q)!.resolved_by!} skipped ${na}`]);
	});

	test("ok with no binding is prose: not handled, into the FIFO, nothing written", async () => {
		const t = await routineTwo();
		expect(t.s().sendLine).toBeNull();
		expect(await t.input("ok")).toBeUndefined();
		expect(t.s().typed.map((e) => e.text)).toEqual(["ok"]);
		expect(answerRows(t.ledger)).toEqual([]);
	});

	test("a second ok with no new send: line is prose", async () => {
		const t = await routineTwo();
		await t.end();
		expect(await t.input("ok")).toEqual({ handled: true });
		expect(answerRows(t.ledger)).toHaveLength(2);
		expect(await t.input("ok")).toBeUndefined();
		expect(answerRows(t.ledger)).toHaveLength(2);
		expect(joRows(t.ledger)).toHaveLength(1);
	});

	test("`ok thanks`, `okay`, `ok 3` are not ok", async () => {
		const t = await routineTwo();
		await t.end();
		for (const text of ["ok thanks", "okay"]) expect(await t.input(text)).toBeUndefined();
		expect(answerRows(t.ledger)).toEqual([]);
		expect(t.s().sendLine).not.toBeNull();
	});

	test("an ok that did not come typed (no interactive or rpc source; a programmatic prompt) is prose", async () => {
		const t = await routineTwo();
		await t.end();
		expect(await t.input("ok", "extension")).toBeUndefined();
		await t.f.emit("before_agent_start", { prompt: "ok", systemPrompt: [] }, t.ctx);
		expect(answerRows(t.ledger)).toEqual([]);
		expect(joRows(t.ledger)).toEqual([]);
		expect(t.s().sendLine).not.toBeNull();
	});

	test("send line, then `pending`, then ok: refused whole as a stale display, 0 rows, the binding kept", async () => {
		const t = await routineTwo();
		await t.end();
		expect(await t.input("pending")).toEqual({ handled: true });
		notified.length = 0;
		expect(await t.input("ok")).toEqual({ handled: true });
		expect(notified).toEqual([{ message: STALE_OK, type: "warning" }]);
		expect(answerRows(t.ledger)).toEqual([]);
		expect(joRows(t.ledger)).toEqual([]);
		expect(standingBodies(t.ledger, "send-applied: ")).toEqual([]);
		expect(t.s().sendLine).not.toBeNull();
	});

	test("ok during a live stream: applied at once, one reply after the turn's end in place of its render, no model request", async () => {
		const t = await routineTwo();
		await t.end();
		t.ctx.host.idle = false;
		const sentBefore = t.f.sent.length;
		expect(await t.input("ok")).toEqual({ handled: true });
		// applied at submit, nothing shown while the turn streams
		expect(answerRows(t.ledger)).toHaveLength(2);
		expect(t.f.sent.length).toBe(sentBefore);
		expect(t.s().heldReply).not.toBeNull();
		t.ctx.host.idle = true;
		await t.end();
		const after = t.f.sent.slice(sentBefore);
		expect(after.map((m) => m.message.customType)).toEqual([SEND_LINE_TYPE]);
		expect(after[0]!.message.content.split("\n").slice(0, 2).every((l) => /^#\d+ → /.test(l))).toBe(true);
		expect(turnsAsked(after)).toHaveLength(0);
		expect(t.s().heldReply).toBeNull();
		expect(t.s().typed).toEqual([]);
	});

	test("ok while a FIFO entry waits leaves the entry untouched", async () => {
		const t = await routineTwo();
		await t.end();
		t.ctx.host.idle = false;
		expect(await t.input("and the footer too")).toBeUndefined();
		const waiting = t.s().typed.map((e) => ({ ...e }));
		expect(waiting.map((e) => e.text)).toEqual(["and the footer too"]);
		expect(await t.input("ok")).toEqual({ handled: true });
		expect(t.s().typed).toEqual(waiting);
		expect(answerRows(t.ledger)).toHaveLength(2);
	});
});

describe("a typed numbered batch is answered at submit (D7)", () => {
	test("`<n> approve, 9 deny` typed: handled at input, the reply carries the applied line and the skipped one", async () => {
		const { ledger, path } = tempLedger();
		const a = held(ledger, "lane-a", "Fix the feed header");
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: a.wl, sliceId: a.sl, body: "Ship it?", options: ["approve", "deny"] });
		const t = surface(path);
		const n = numberOf(ledger, q);
		expect(await t.input(`${n} approve, 9 deny`)).toEqual({ handled: true });
		expect(answerRows(ledger).map((i) => [i.question_id, i.body])).toEqual([[q, "approve"]]);
		expect(t.s().typed).toEqual([]);
		expect(t.displays()).toHaveLength(1);
		const lines = t.displays()[0]!.message.content.split("\n");
		expect(lines[0]).toStartWith(`#${n} → `);
		expect(lines[1]).toBe("#9 skipped: not on the needs-you list");
		expect(turnsAsked(t.f.sent)).toHaveLength(0);
	});

	test("an answer to the orchestrator's own question: the batch-turn entry, then one hidden trigger with the same nonce", async () => {
		const { ledger, path } = tempLedger();
		const t = surface(path);
		const oq = await t.raise({ body: "Now or later?", options: ["now", "later"] });
		const n = numberOf(ledger, oq);
		const sentBefore = t.f.sent.length;
		expect(await t.input(`${n} now`)).toEqual({ handled: true });
		expect(ledger.question(oq)).toMatchObject({ state: "answered" });
		const turns = t.f.entries.filter((e) => e.type === BATCH_TURN_TYPE);
		expect(turns).toHaveLength(1);
		const entry = turns[0]!.data;
		expect(entry).toEqual({ nonce: expect.stringMatching(/^bt-/), appliedIds: [oq], numbers: [n] });
		const nonce = typeof entry === "object" && entry !== null && "nonce" in entry ? entry.nonce : null;
		const after = t.f.sent.slice(sentBefore);
		expect(after.map((m) => m.message.customType)).toEqual([SEND_LINE_TYPE, BATCH_TRIGGER_TYPE]);
		const trigger = after[1]!;
		expect(trigger.message).toMatchObject({ display: false, details: { nonce } });
		expect(trigger.message.content).toStartWith("act on these answers: ");
		expect(trigger.options).toEqual({ triggerTurn: true });
	});
});
