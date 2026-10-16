// An open plan question's plan file path under every mention (PLAN wl-mv61a8dh4aeneo, § Tests 1–9):
// the orchestrator's own messages get a display-only `surface-plan-path` message once the session is
// idle (D3), and every surface text route — Jo's echoes and "which one?", tick notices, the wake render,
// the needs-you block, `orchestrator_ledger` — carries the path beneath the line naming the question
// (D2), read from the question row (D1). Driven through the extension entry points on the fake host
// (surface/test/helpers.ts), so the regression tests (1, 6, 7a, 7b, 8, 8b, 9) fail on an assertion before
// the change; 3, 4 and 5 are guards that hold before and after; 2 and 2b are the new row's own behaviour.
// Nothing here imports the new modules statically: test 9 loads surface/src/plan-paths.ts only after
// its route assertions.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { launchVerdict } from "../extensions/launch";
import orchestratorSurface from "../index";
import { planFirstBody } from "../src/launch";
import { raiseOrchestratorQuestion } from "../src/orchestrator-question";
// Type-only: erased at load, so origin/main (no plan-paths.ts) still loads this file.
import type { withPlanPaths as WithPlanPaths } from "../src/plan-paths";
import { surfaceSession } from "../src/session";
import { SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, loadTestText, notices, type Sent, timeouts, timers, tmp, workloadWithSlice } from "./helpers";

const PLAN_PATH = "surface-plan-path";
const APPLIED = "## Applied from the surface since your last turn";
type Turn = { systemPrompt: string[]; messages: Sent["message"][] };

function env(): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	// AGENT_SYSTEM_SURFACE_BATCH_MS 0: a held needs-you line goes out at the poll that finds it (PLAN wl-mv5msri070p0qo D3), as these tests read it.
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home", AGENT_SYSTEM_SURFACE_BATCH_MS: "0" };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}
const open = (e: Record<string, string>) => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });

/** A plan body in the lane tool's shape, `path` its first line. */
const planBody = (path: string) => [path, "- sl-build: build the change, one line", "tradeoff: one more message on screen", "review: approve-as-is, openai-codex/gpt-6-sol, /tmp/PLAN-REVIEW-r1.md"].join("\n");

/**
 * A plan-first workload held by `holder` whose slice raised the plan question (`path` first), with the
 * holder's `plan-question:` entry in the same write, as lane_raise_question writes them.
 */
function seedPlan(l: Ledger, path: string, holder = "lane-a"): { wl: string; sl: string; q: string } {
	const { wl, sl } = workloadWithSlice(l, { brief: `Plan held by ${holder}` });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	expect(l.claimWorkload(wl, { by: holder, holder, leaseMs: null }).won).toBe(true);
	const q = l.write(() => {
		const id = l.raiseQuestion({ by: holder, workloadId: wl, sliceId: sl, body: planBody(path), options: ["approve", "revise", "cancel"] });
		l.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: `plan-question: ${id}` });
		return id;
	});
	return { wl, sl, q };
}

/** A user-driven workload (the tick never launches it) with one reserved request waiting on Jo. */
function seedReserved(l: Ledger): string {
	const { wl, sl } = workloadWithSlice(l, { brief: "Push the release", mode: "user-driven" });
	return l.recordEntry({ by: "lane-r", workloadId: wl, sliceId: sl, kind: "reserved-request", body: "push main" });
}

/** The surface started on the seeded ledger: the session-start wake taken by Jo's first turn and its read recorded. */
async function start(e: Record<string, string>, o: { exec?: boolean } = {}) {
	timers.length = 0;
	timeouts.length = 0;
	notices.length = 0;
	const f = fakePi(undefined, { exec: o.exec ?? false });
	await orchestratorSurface(f.pi, e, { loadText: loadTestText });
	let idle = true;
	const ctx = Object.assign(ctxOf(), { isIdle: () => idle });
	await f.emit("session_start", { type: "session_start" }, ctx);
	const first = (await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx)) as Turn;
	await f.tool("orchestrator_wake_read").execute("1", { body: "resuming" }, undefined, undefined, ctx);
	const s = surfaceSession(ctx, e);
	/** OMP finishing an orchestrator turn: each message's `message_end`, then `agent_end`; returns the one-shots it armed. */
	const turn = async (messages: unknown[]) => {
		for (const message of messages) await f.emit("message_end", { type: "message_end", message }, ctx);
		const from = timeouts.length;
		await f.emit("agent_end", {}, ctx);
		return timeouts.slice(from);
	};
	/** Fire one-shots armed from index `from` on, and the re-arms they register, until none is left. */
	const fireFrom = (from: number) => {
		while (timeouts.length > from) timeouts.splice(from, 1)[0]!.fn();
	};
	return {
		f,
		ctx,
		s,
		wake: first.messages[0]!.content,
		setIdle: (v: boolean) => {
			idle = v;
		},
		n: (rowId: string) => s.numbering.numberOf(rowId)!,
		/** The messages sent as one customType. */
		of: (customType: string) => f.sent.filter((x) => x.message.customType === customType),
		jo: async (prompt: string) => (await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as Turn,
		ledgerTool: async () => (await f.tool("orchestrator_ledger").execute("1", {}, undefined, undefined, ctx)).content[0]!.text,
		turn,
		fireFrom,
		/** OMP's turn ending idle: the flush one-shot fires. */
		idleTurn: async (messages: unknown[]) => {
			const from = timeouts.length;
			await turn(messages);
			fireFrom(from);
		},
	};
}

/** An assistant message as OMP finalizes it: text, then a tool call when `tool` is set (a mid-turn message). */
const assistant = (text: string, tool = false) => ({
	role: "assistant",
	content: [{ type: "text", text }, ...(tool ? [{ type: "toolCall", id: "call-1", name: "orchestrator_ledger", arguments: {} }] : [])],
});

const count = (text: string, part: string): number => text.split(part).length - 1;

/** A 300-character plan path (tests 8 and 8b). */
const LONG_PATH = `/Users/jo/agent-scratch/${"long-segment-0123456789/".repeat(11)}PLAN-`.padEnd(297, "x").concat(".md");

/**
 * pi-tui's Markdown in the OMP install the `omp` on PATH runs: that binary's realpath, up to its
 * `@oh-my-pi` directory, then `pi-tui/src/components/markdown.ts`. Null when there is no such file.
 */
function piTuiMarkdown(): string | null {
	const omp = Bun.which("omp");
	if (!omp) return null;
	let dir = dirname(realpathSync(omp));
	while (basename(dir) !== "@oh-my-pi") {
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
	const file = join(dir, "pi-tui", "src", "components", "markdown.ts");
	return existsSync(file) ? file : null;
}
const MARKDOWN = piTuiMarkdown();

/** Let the tick's async catch-up finish. */
async function settle(s: { launching: boolean }): Promise<void> {
	for (let i = 0; i < 20 || s.launching; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

describe("the orchestrator's own message (D3)", () => {
	test("T4: preloaded renderer paints restored results before a fresh ledger execution", async () => {
		const f = fakePi();
		const P = join(tmp("restored-ledger"), "PLAN with spaces.md");
		writeFileSync(P, "# Plan\n");
		await orchestratorSurface(f.pi, env(), { loadText: loadTestText });
		const tool = f.tool("orchestrator_ledger");
		const renderer = (tool as typeof tool & {
			renderResult?: (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown) => { render(width: number): readonly string[] };
		}).renderResult;
		expect(typeof renderer).toBe("function");
		const target = new URL(`file://${P}`).href;
		const rendered = renderer!({ content: [{ type: "text", text: `[${P}](${target})` }] }, { expanded: true, isPartial: false }, {}).render(500).join("\n");
		expect(rendered).toContain(`\x1b]8;;${target}\x07${P}\x1b]8;;\x07`);
	});

	test("T4: existing entry links a space-bearing plan path in wake, Applied and relayed messages, and renders ledger OSC8", async () => {
		const e = env();
		const l = open(e);
		const P = join(tmp("linked-plan"), "PLAN with spaces.md");
		writeFileSync(P, "# Plan\n");
		const target = new URL(`file://${P}`).href;
		const linked = `[${P}](${target})`;
		const { wl, sl, q } = seedPlan(l, P);
		l.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `Reviewed ${P}` });
		l.close();
		const x = await start(e);
		expect(x.wake).toContain(linked);
		x.s.notices.push(`Applied ${P}`);
		const applied = (await x.jo("next")).messages.map((m) => m.content).join("\n");
		expect(applied).toContain(`${APPLIED}\n- Applied ${linked}`);
		await x.idleTurn([assistant(`Review ${q}.`)]);
		expect(x.of(PLAN_PATH).at(-1)!.message.content).toBe(`plan for ${q}: ${linked}`);
		const l2 = open(e);
		l2.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `Relay ${P}` });
		l2.close();
		const tool = x.f.tool("orchestrator_ledger");
		const result = await tool.execute("1", {}, undefined, undefined, x.ctx);
		expect(result.content.map((c) => c.text).join("\n")).toContain(`Relay ${linked}`);
		const renderer = (tool as typeof tool & {
			renderResult?: (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown) => { render(width: number): readonly string[] };
		}).renderResult;
		expect(typeof renderer).toBe("function");
		const painted = renderer!(result, { expanded: true, isPartial: false }, {}).render(500).join("\n");
		expect(painted).toContain(`\x1b]8;;${target}\x07${P}\x1b]8;;\x07`);
		expect(painted).toContain(`\x1b]8;;${target}\x07${target}\x1b]8;;\x07`);
	});

	test("1: a message naming the plan question by #N or q- id, without the path, gets a surface-plan-path message after idle, uncut, in message order; the assistant message is unchanged", async () => {
		const e = env();
		const l = open(e);
		const P = "/Users/jo/agent-scratch/agent-system-2.0/wl-x/PLAN.md";
		const { q } = seedPlan(l, P);
		l.close();
		const x = await start(e);
		const n = x.n(q);
		expect(n).toBe(1);

		const byNumber = assistant(`The plan for the cut is #${n}; say approve, revise or cancel.`);
		const snapshot = structuredClone(byNumber);
		await x.idleTurn([byNumber]);
		expect(x.of(PLAN_PATH).map((m) => [m.message, m.options])).toEqual([[{ customType: PLAN_PATH, content: `plan for #${n}: ${P}`, display: true }, undefined]]);
		expect(byNumber).toEqual(snapshot);

		await x.idleTurn([assistant(`Waiting on ${q}.`)]);
		expect(x.of(PLAN_PATH).at(-1)!.message.content).toBe(`plan for ${q}: ${P}`);

		// two mentions, one mid-turn (text before a tool call): one message after the turn, two lines in message order
		const mid = assistant(`Reading the ledger for ${q} first.`, true);
		const final = assistant(`#${n} still waits on you.`);
		const before = [structuredClone(mid), structuredClone(final)];
		await x.idleTurn([mid, final]);
		expect(x.of(PLAN_PATH)).toHaveLength(3);
		expect(x.of(PLAN_PATH).at(-1)!.message.content).toBe(`plan for ${q}: ${P}\nplan for #${n}: ${P}`);
		expect([mid, final]).toEqual(before);
	});

	test("2: the context hook drops surface-plan-path, compaction loses it from all three arrays with recentEntryIds in lockstep, and nothing is sent while busy", async () => {
		const e = env();
		const l = open(e);
		const P = "/tmp/plan-two/PLAN.md";
		const { q } = seedPlan(l, P);
		l.close();
		const x = await start(e);

		const pp = { role: "custom", customType: PLAN_PATH, content: `plan for ${q}: ${P}`, display: true };
		const user = { role: "user", content: "hi" };
		const reply = { role: "assistant", content: [{ type: "text", text: `see ${q}` }] };
		const other = { role: "custom", customType: "surface-notices", content: "x", display: true };
		expect(await x.f.context([user, reply, pp, other], x.ctx)).toEqual([user, reply, other]);

		const a = { role: "user", content: "a" };
		const b = { role: "assistant", content: [] };
		const c = { role: "user", content: "c" };
		const preparation = { messagesToSummarize: [a, pp, b], turnPrefixMessages: [pp, c], recentMessages: [c, pp, b, pp], recentEntryIds: ["e1", "e2", "e3", "e4"], firstKeptEntryId: "e1" };
		await x.f.emit("session_before_compact", { type: "session_before_compact", preparation, branchEntries: [] }, x.ctx);
		expect(preparation.messagesToSummarize).toEqual([a, b]);
		expect(preparation.turnPrefixMessages).toEqual([c]);
		expect(preparation.recentMessages).toEqual([c, b]);
		expect(preparation.recentEntryIds).toEqual(["e1", "e3"]);

		// busy: the flush re-arms and gives up after its tries; nothing is sent
		const armed = await x.turn([assistant(`About ${q}.`)]);
		expect(armed).toHaveLength(1);
		x.setIdle(false);
		x.fireFrom(timeouts.length - 1);
		expect(x.of(PLAN_PATH)).toEqual([]);
		// idle again: the next agent_end sends the queue
		x.setIdle(true);
		await x.idleTurn([]);
		expect(x.of(PLAN_PATH).map((m) => m.message.content)).toEqual([`plan for ${q}: ${P}`]);
	});

	test("2b: a surface-plan-path send that throws does not throw out of the flush: one stderr line, the lines stay queued, and the next idle turn sends the old and new lines as one message, in order", async () => {
		const e = env();
		const l = open(e);
		const P = "/tmp/plan-two-b/PLAN.md";
		const { q } = seedPlan(l, P);
		l.close();
		const x = await start(e);
		const n = x.n(q);
		let failures = 1;
		const send = x.f.pi.sendMessage!;
		Object.assign(x.f.pi, {
			sendMessage: (...a: Parameters<typeof send>) => {
				if (a[0].customType === PLAN_PATH && failures > 0) {
					failures--;
					throw new Error("send failed");
				}
				return send(...a);
			},
		});

		const stderr: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
			if (String(chunk).startsWith("surface: ")) {
				stderr.push(String(chunk));
				return true;
			}
			return (write as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
		}) as typeof process.stderr.write;
		try {
			const armed = await x.turn([assistant(`About ${q}.`)]);
			expect(armed).toHaveLength(1);
			expect(() => x.fireFrom(timeouts.length - armed.length)).not.toThrow();
		} finally {
			process.stderr.write = write;
		}
		expect(failures).toBe(0);
		expect(stderr).toEqual(["surface: the plan-path send failed: Error: send failed\n"]);
		expect(x.of(PLAN_PATH)).toEqual([]);

		// the next idle turn re-arms and sends the kept line and the new one together
		await x.idleTurn([assistant(`#${n} still waits.`)]);
		expect(x.of(PLAN_PATH).map((m) => m.message.content)).toEqual([`plan for ${q}: ${P}\nplan for #${n}: ${P}`]);
	});
});

describe("nothing for what is not an open plan question (guards)", () => {
	test("3: an answered plan question and a withdrawn one: nothing anywhere", async () => {
		const e = env();
		const l = open(e);
		const a = seedPlan(l, "/tmp/plan-answered/PLAN.md", "lane-a");
		const w = seedPlan(l, "/tmp/plan-withdrawn/PLAN.md", "lane-b");
		l.close();
		const x = await start(e);
		const [na, nw] = [x.n(a.q), x.n(w.q)];
		const l2 = open(e);
		l2.answerQuestion(a.q, { by: SURFACE_BY, answer: "revise", author: "jo", channel: "surface" });
		l2.withdrawQuestion(w.q, { by: SURFACE_BY, reason: "replanning", author: "jo", channel: "surface", then: "replan" });
		l2.close();

		const armed = await x.turn([assistant(`#${na} (${a.q}) and #${nw} (${w.q}) are settled.`)]);
		expect(armed).toEqual([]);
		expect(x.of(PLAN_PATH)).toEqual([]);
		const read = await x.ledgerTool();
		expect(read).toContain(`answer to ${a.q}`);
		expect(read).not.toContain("plan for");
		x.f.sent.length = 0;
		timers[0]!.fn();
		expect(x.f.sent.map((m) => m.message.content).join("\n")).not.toContain("plan for");
		const turn = await x.jo(`revise ${a.q}`);
		expect(notices.join("\n")).not.toContain("plan for");
		expect(turn.messages.map((m) => m.content).join("\n")).not.toContain("plan for");
	});

	test("4: a review-park same-lab / wait question, an orchestrator question and a reserved request: nothing", async () => {
		const e = env();
		const l = open(e);
		// plan-first, its body even starts with a path, but no holder wrote plan-question: for it
		const { wl, sl } = workloadWithSlice(l, { brief: "Review parked" });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
		expect(l.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: null }).won).toBe(true);
		const park = l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "/tmp/plan-park/PLAN.md\nreview-park: the reviewer's lab is down; same-lab or wait?", options: ["same-lab", "wait"] });
		const orch = raiseOrchestratorQuestion(l, { body: "/tmp/plan-orch/PLAN.md is the one to keep?", options: ["yes", "no"], about: null });
		const reserved = seedReserved(l);
		l.close();
		const x = await start(e);
		const [np, no, nr] = [x.n(park), x.n(orch), x.n(reserved)];
		expect([np, no, nr].every((n) => typeof n === "number")).toBe(true);

		expect(x.wake).not.toContain("plan for");
		const armed = await x.turn([assistant(`#${np} (${park}), #${no} (${orch}) and #${nr} wait on you.`)]);
		expect(armed).toEqual([]);
		expect(x.of(PLAN_PATH)).toEqual([]);
		expect(await x.ledgerTool()).not.toContain("plan for");
		const which = await x.jo("yes");
		expect([...notices, ...which.messages.map((m) => m.content)].join("\n")).not.toContain("plan for");
	});

	test("5: `PR #N`, and #N after pull request / issue / item, a word character or `/`, where N is the plan question's number: nothing", async () => {
		const e = env();
		const l = open(e);
		const { q } = seedPlan(l, "/tmp/plan-five/PLAN.md");
		l.close();
		const x = await start(e);
		const n = x.n(q);
		const armed = await x.turn([assistant(`Merged PR #${n} and PR#${n}; pull request #${n}, issue #${n}, item #${n}, owner/repo#${n}, x#${n}, /#${n}.`)]);
		expect(armed).toEqual([]);
		expect(x.of(PLAN_PATH)).toEqual([]);
		const l2 = open(e);
		raiseOrchestratorQuestion(l2, { body: `Is PR #${n} the one to merge?`, options: ["yes", "no"], about: null });
		l2.close();
		x.f.sent.length = 0;
		timers[0]!.fn();
		const pushed = x.f.sent.map((m) => m.message.content).join("\n");
		expect(pushed).toContain(`Is PR #${n} the one to merge?`);
		expect(pushed).not.toContain("plan for");
	});
});

describe("surface lines (D2)", () => {
	test("6: \"which one?\" with two plan candidates and one reserved: one path line per plan candidate in the same notify string, none for the reserved one", async () => {
		const e = env();
		const l = open(e);
		const one = seedPlan(l, "/tmp/plan-one/PLAN.md", "lane-a");
		const two = seedPlan(l, "/tmp/plan-two/PLAN.md", "lane-b");
		const reserved = seedReserved(l);
		l.close();
		const x = await start(e);
		const paths: Record<string, string> = { [one.q]: "/tmp/plan-one/PLAN.md", [two.q]: "/tmp/plan-two/PLAN.md" };
		notices.length = 0;
		await x.jo("approve");
		expect(notices).toHaveLength(1);
		const [line, ...rest] = notices[0]!.split("\n");
		expect(line).toStartWith(`which one? "approve" fits `);
		expect(line).toContain(`#${x.n(reserved)} (reserved ${reserved}: push main)`);
		const order = [...line!.matchAll(/#(\d+) \((q-[0-9a-z]+) on /g)].map((m) => ({ n: m[1]!, q: m[2]! }));
		expect(order.map((c) => c.q).sort()).toEqual([one.q, two.q].sort());
		expect(rest).toEqual(order.map((c) => `  plan for #${c.n}: ${paths[c.q]}`));
		expect(notices[0]).not.toContain(`plan for #${x.n(reserved)}`);
	});

	test("7a: needs-you: the plan question's own line has its path directly beneath the q- id, once; an orchestrator question naming the plan q- id gets the path beneath its line", async () => {
		const e = env();
		const l = open(e);
		const P = "/tmp/plan-seven/PLAN.md";
		const { q, sl } = seedPlan(l, P);
		l.close();
		const x = await start(e);
		const needs = x.wake.slice(x.wake.indexOf("## needs you"), x.wake.indexOf("\n## ", x.wake.indexOf("## needs you") + 1));
		expect(needs).toContain(`(${q}, slice ${sl}):\n  ${P}\n  - sl-build: `);
		expect(count(needs, P)).toBe(1);
		expect(needs).not.toContain("plan for");

		const l2 = open(e);
		const oq = raiseOrchestratorQuestion(l2, { body: `Is ${q} the plan to approve tonight?`, options: ["yes", "no"], about: null });
		l2.close();
		x.f.sent.length = 0;
		timers[0]!.fn();
		const aside = x.of("surface-needs-you").map((m) => m.message.content);
		expect(aside).toHaveLength(1);
		expect(aside[0]).toContain(`the orchestrator asked you (${oq}): Is ${q} the plan to approve tonight? — answer with one word: yes / no (or \`withdraw\`)\n  plan for ${q}: ${P}`);
		expect(count(aside[0]!, P)).toBe(1);
	});

	test("7b: orchestrator_ledger: a pending lane message naming the plan q- id gets the path beneath it; Jo's turn wake has the workload's line with the path beneath", async () => {
		const e = env();
		const l = open(e);
		const P = "/tmp/plan-seven-b/PLAN.md";
		const { wl, sl, q } = seedPlan(l, P);
		const m = l.enqueue({ by: SURFACE_BY, workloadId: wl, sliceId: sl, sender: "orchestrator", recipient: "lane-a", body: `Hold the build until Jo answers ${q}` });
		l.close();
		const x = await start(e);
		const line = `- ${m} [held] orchestrator → lane-a (${sl}): Hold the build until Jo answers ${q}\n  plan for ${q}: ${P}`;
		// the wake is one line per workload (surface/src/render.ts workloadLine): the message is the block's, read on demand
		expect(x.wake).not.toContain(m);
		const n = x.n(q);
		expect(x.wake).toContain(`· needs you: #${n} · open questions: ${q} · 1 message(s) not yet acted on\n  plan for #${n}: ${P}`);
		expect(await x.ledgerTool()).toContain(line);
	});

	test("8: a 300-character path appears verbatim in every route's text", async () => {
		const e = env();
		const l = open(e);
		const P = LONG_PATH;
		expect(P).toHaveLength(300);
		const { q } = seedPlan(l, P);
		seedReserved(l);
		l.close();
		const x = await start(e, { exec: true });
		x.f.execs.answer = (command) => ({ stdout: command === "bun" ? `lane-t launched; it reads ${q} first` : "", stderr: "", code: 0, killed: false });
		const n = x.n(q);
		const routes: Record<string, string> = {};
		routes.wake = x.wake;
		routes.ledger = await x.ledgerTool();

		notices.length = 0;
		await x.jo("approve");
		routes.echo = notices.join("\n");

		const l2 = open(e);
		raiseOrchestratorQuestion(l2, { body: `Keep ${q} as written?`, options: ["yes", "no"], about: null });
		const launchable = l2.openWorkload({ by: SURFACE_BY, brief: "Add a verify line", stakes: "normal", mode: "autonomous" });
		expect(launchVerdict(l2, e, launchable).launch).toBe(true);
		l2.close();
		x.f.sent.length = 0;
		timers[0]!.fn();
		await settle(x.s);
		routes.needsYou = x.of("surface-needs-you").map((m) => m.message.content).join("\n");
		routes.tick = x.of("surface-notices").map((m) => m.message.content).join("\n");

		await x.idleTurn([assistant(`#${n} waits.`)]);
		routes.planPath = x.of(PLAN_PATH).map((m) => m.message.content).join("\n");

		for (const [route, text] of Object.entries(routes)) expect({ route, verbatim: text.includes(P) }).toEqual({ route, verbatim: true });
		expect(routes.planPath).toBe(`plan for #${n}: ${P}`);
	});

	// Skipped, visibly, when no OMP install with pi-tui is found from the `omp` on PATH (see MARKDOWN above).
	test.skipIf(MARKDOWN === null)("8b: OMP's Markdown (pi-tui, found from the omp on PATH) at width 40 keeps every path character in order, Markdown-special ones included", async () => {
		const e = env();
		const l = open(e);
		const long = seedPlan(l, LONG_PATH);
		// A real path with Markdown-special characters: the shared linkifier escapes its visible label.
		const P2 = join(tmp("special-plan"), "_x_", "*y*", "tick`mark", "[z]", "PLAN.md");
		mkdirSync(dirname(P2), { recursive: true });
		writeFileSync(P2, "# Special plan\n");
		const special = seedPlan(l, P2, "lane-b");
		l.close();
		const x = await start(e);

		// Dynamic: the path is found at run time (MARKDOWN), in the OMP install rather than this repo, so no static import can name it.
		const { Markdown } = (await import(MARKDOWN!)) as { Markdown: new (text: string, px: number, py: number, theme: Record<string, (t: string) => string>) => { render(width: number): readonly string[] } };
		const id = (t: string) => t;
		const theme = Object.fromEntries(["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map((k) => [k, id]));
		/** The text as OMP paints it at width 40, styling and whitespace dropped; every row fits the width. */
		const shown = (text: string): string => {
			const rendered = new Markdown(text, 0, 0, theme).render(40);
			expect(rendered.every((r) => Bun.stringWidth(r) <= 40)).toBe(true);
			return rendered.join("\n").replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\s+/g, "");
		};

		await x.idleTurn([assistant(`#${x.n(long.q)} waits.`)]);
		expect(shown(x.of(PLAN_PATH).at(-1)!.message.content)).toContain(LONG_PATH);
		await x.idleTurn([assistant(`${special.q} waits too.`)]);
		expect(shown(x.of(PLAN_PATH).at(-1)!.message.content)).toContain(P2);
	});

	test("9: replay — a which-one echo through the Applied block and a tick notice through its aside each show a path once; two plan questions sharing one file both get their line; withPlanPaths twice equals once", async () => {
		const e = env();
		const l = open(e);
		const one = seedPlan(l, "/tmp/plan-nine-one/PLAN.md", "lane-a");
		const two = seedPlan(l, "/tmp/plan-nine-two/PLAN.md", "lane-b");
		l.close();
		const x = await start(e, { exec: true });
		x.f.execs.answer = (command) => ({ stdout: command === "bun" ? `lane-t launched; it waits on ${one.q}` : "", stderr: "", code: 0, killed: false });
		const paths: Record<string, string> = { [one.q]: "/tmp/plan-nine-one/PLAN.md", [two.q]: "/tmp/plan-nine-two/PLAN.md" };

		// the echo, carried into the turn's context through the Applied block exactly as stored
		const turn = await x.jo("approve");
		const applied = turn.messages[0]!.content;
		expect(applied).toContain(`${APPLIED}\n- which one? "approve" fits `);
		const order = [...applied.matchAll(/#(\d+) \((q-[0-9a-z]+) on /g)].map((m) => m[2]!);
		expect([...order].sort()).toEqual([one.q, two.q].sort());
		for (const q of order) expect(count(applied, paths[q]!)).toBe(1);
		expect(applied.indexOf(paths[order[0]!]!)).toBeLessThan(applied.indexOf(paths[order[1]!]!));

		// a tick notice naming a plan q- id: its path once in the surface-notices aside
		const l2 = open(e);
		const launchable = l2.openWorkload({ by: SURFACE_BY, brief: "Add a verify line", stakes: "normal", mode: "autonomous" });
		expect(launchVerdict(l2, e, launchable).launch).toBe(true);
		l2.close();
		x.f.sent.length = 0;
		timers[0]!.fn();
		await settle(x.s);
		const notices9 = x.of("surface-notices").map((m) => m.message.content);
		expect(notices9).toHaveLength(1);
		expect(notices9[0]).toContain(`- tick: ${launchable}: lane-t launched; it waits on ${one.q}\n  plan for ${one.q}: ${paths[one.q]}`);
		expect(count(notices9[0]!, paths[one.q]!)).toBe(1);

		// two open plan questions sharing one plan file: each header keeps its own path, a line naming both gets two lines
		const e2 = env();
		const l3 = open(e2);
		const shared = "/tmp/plan-shared/PLAN.md";
		const a = seedPlan(l3, shared, "lane-a");
		const b = seedPlan(l3, shared, "lane-b");
		l3.close();
		const y = await start(e2);
		for (const p of [a, b]) expect(y.wake).toContain(`(${p.q}, slice ${p.sl}):\n  ${shared}\n  - sl-build: `);
		await y.idleTurn([assistant(`${a.q} and ${b.q} share one plan.`)]);
		expect(y.of(PLAN_PATH).map((m) => m.message.content)).toEqual([`plan for ${a.q}: ${shared}\nplan for ${b.q}: ${shared}`]);

		// Dynamic: a static import would fail this whole file at load on origin/main, before tests 1, 6, 7 and 8 could fail on their assertions.
		const { withPlanPaths } = (await import("../src/plan-paths")) as { withPlanPaths: typeof WithPlanPaths };
		const l4 = open(e2);
		const both = withPlanPaths(l4, y.s.numbering, `${a.q} and ${b.q} share one plan.`);
		expect(both).toBe(`${a.q} and ${b.q} share one plan.\n  plan for ${a.q}: ${shared}\n  plan for ${b.q}: ${shared}`);
		for (const text of [both, y.wake, `#${y.n(b.q)} (${b.q} on x), #${y.n(a.q)} (${a.q} on y)`, `${b.q} first\n  plan for ${a.q}: ${shared}`]) {
			const once = withPlanPaths(l4, y.s.numbering, text);
			expect(withPlanPaths(l4, y.s.numbering, once)).toBe(once);
		}
		l4.close();
	});
});
