// A by-hand lane (`as2 lane <wl>`) gets its first prompt in the session (PLAN wl-mvb9mw00ycfjeo PLAN-2 D1, D1b, D2, the D4
// marker; R1, R2, R7's env part): the launcher writes prompt.md (`promptFor` with paired spend context plus
// `## Workload state now`, the workload's block from surface/src/render.ts) before the spawn and passes it as OMP's native
// `@<path>` argument, which the fake omp consumes into the session's first user message as OMP does. A resume on the same
// model gets the fresh context once
// more; a session on another model is not resumed and the fresh one gets it too. AGENT_SYSTEM_BY_HAND=1 reaches a by-hand
// lane only: an inherited value never reaches an autonomous lane, whose argv and prompt stay as they were. Every root here
// has spaces in its path, so prompt.md's path does too. These spawn processes: they run in the full suite outside the fence.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { ceilingBody, parseCeilingNotice } from "../src/ceiling";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneDir, laneExit, laneModelBody, laneStarted, worktreePath } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { type FakeRecord, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, until } from "./helpers";

const BY_HAND = "AGENT_SYSTEM_BY_HAND";
const X = "openai-codex/gpt-6-sol";

const roots: LaneRoot[] = [];
/** A root whose path holds spaces: HOME, the lane dir and prompt.md, the repo and the worktree all sit beneath it. */
const makeRoot = (over: Record<string, string> = {}): LaneRoot => {
	const r = laneRoot(over, "by hand root");
	roots.push(r);
	return r;
};
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });

const BRIEF = "Re-seat the header offset token\nsecond brief line: brief-mark-3318 keeps the 4px gap";
const DONE = "done-mark-2240: the header reads its offset from the token";
const TASK = "slice-mark-7731 move the header offset into a token";
const SLICE_DONE = "slice-done-mark-7732 bun test header passes";
const QUESTION = "question-mark-5150 which token file owns the offset?\nsecond question line: tokens.css or theme.ts";
const INSTRUCTION = "instruction-mark-9001 use the v3 token schema\nsecond instruction line: then drop v2";
const ENTRY = "entry-mark-4471 assumption: the offset is 4px on every breakpoint";

/** A user-driven workload on the root's repo, already past a tiny ceiling, with a multiline brief, a done: line, an open slice with an open question on it, Jo's multiline instruction and one assumption entry. */
function seeded(r: LaneRoot): { wl: string; sl: string; q: string; instruction: string } {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: BRIEF, stakes: "normal", mode: "user-driven" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody(DONE) });
		const sl = l.addSlice({ by: SURFACE_BY, workloadId: wl, task: TASK, doneCondition: SLICE_DONE, inputs: "src/header.css" });
		const q = l.raiseQuestion({ by: SURFACE_BY, workloadId: wl, sliceId: sl, body: QUESTION, options: ["tokens", "theme"] });
		const instruction = l.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: INSTRUCTION, author: "jo", channel: "surface" });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ENTRY });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody({ usd: 1, wallMin: 60 }, "test tiny ceiling") });
		// Earlier workload spend, without a recorded session to resume: even the first by-hand launch starts past 100 %.
		const sessions = join(laneDir(wl, r.home), "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "earlier-spend.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 1250, cost: { total: 1.25 } } } })}\n`);
		return { wl, sl, q, instruction };
	} finally {
		l.close();
	}
}

const promptPath = (r: LaneRoot, wl: string) => join(laneDir(wl, r.home), "prompt.md");
/** OMP's `@file` text: `<file name="<path>">\n<content>\n</file>\n` (@oh-my-pi/pi-coding-agent src/cli/file-processor.ts). */
const fileMessage = (path: string, content: string) => `<file name="${path}">\n${content}\n</file>\n`;
/** The user messages a session file holds, in order; with `resumed`, only those after its last `resumed` line (where the fake's resume appends), which must exist. */
function userMessages(session: string, resumed = false): string[] {
	const lines: { type: string; role?: string; text?: string }[] = readFileSync(session, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const from = resumed ? lines.findLastIndex((l) => l.type === "resumed") : -1;
	if (resumed && from < 0) throw new Error(`${session} holds no resumed line`);
	return lines.slice(from + 1).filter((l) => l.type === "message" && l.role === "user").map((l) => l.text ?? "");
}

/**
 * `as2 lane <wl>` as Jo runs it, a pipe standing in for the terminal: waits for omp's start record and its initial
 * prompt, then closes the pipe (Jo leaving the TUI: omp reads EOF and exits 0) and waits for the wrapper's exit.
 */
async function byHand(r: LaneRoot, wl: string, n: number, env: Record<string, string> = {}) {
	const laneId = laneIdOf(wl, n);
	const tui = Bun.spawn(["bun", LANE_SCRIPT, "interactive", wl], { cwd: r.repo, env: { ...r.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const started = await until(`lane-started: of ${laneId}`, () => laneStarted(laneSnapshot(r, wl).control, laneId));
	const rec = await until(`omp ${started.pid}'s start record`, () => fakeRecords(r).find((x) => x.pid === started.pid && x.argv));
	const prompted = await until(`omp ${started.pid}'s initial prompt`, () => fakeRecords(r).find((x) => x.pid === started.pid && x.event === "prompt"));
	// prompt.md as this launch wrote it, before a later launch rewrites it
	const prompt = readFileSync(promptPath(r, wl), "utf8");
	tui.stdin.end();
	const code = await tui.exited;
	const out = await new Response(tui.stdout).text();
	await until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId));
	const snap = laneSnapshot(r, wl);
	expect(laneExit(snap.control, laneId)).toMatchObject({ outcome: "interactive", reason: null });
	expect(snap.control.filter((c) => c.prefix === "lane-stop")).toEqual([]);
	const l = ledgerOf(r);
	try {
		const messages = l.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ?").all(wl);
		expect(messages.flatMap((m) => parseCeilingNotice(m.body) ?? [])).toEqual([]);
	} finally {
		l.close();
	}
	const events = fakeRecords(r).filter((x) => x.pid === started.pid && x.event);
	return { laneId, code, out, rec: rec as FakeRecord & { argv: string[]; session: string; env: Record<string, string> }, prompted, events, prompt };
}

/**
 * What every launch's prompt carries, whatever the window of recent rows: this lane's identity, the done: line and the
 * multiline brief, then the workload block (its header carries `rank #1`, the only ranked workload, PLAN wl-mv8wzytml878b4 D4)
 * with the seeded slice (paused by the open question on it) and that question. Returns the `## Workload state now` section.
 */
function expectContext(prompt: string, s: { wl: string; sl: string; q: string }, laneId: string): string {
	expect(prompt).toStartWith(`You are lane ${laneId} on workload ${s.wl}.\n`);
	expect(prompt).toContain(`\ndone: ${DONE}\n`);
	expect(prompt).toContain(`\nbrief: ${BRIEF}\n`);
	expect(prompt.match(/\nceiling: /g)).toHaveLength(1);
	expect(prompt).toContain("\nstakes: normal · mode: user-driven\nceiling: $1 / 60 min for the workload; spent so far $1.25 / ");
	expect(prompt).toContain(" min (1250 tokens); you are paired with Jo; you are never stopped at the ceiling; the extension tells Jo the spend in the pane at every 25 % of the original ceiling ($1, so every $0.25).\n");
	expect(prompt.match(/\n## Workload state now\n/g)).toHaveLength(1);
	const state = prompt.split("\n## Workload state now\n\n")[1]!;
	expect(state).toStartWith(`## ${s.wl} · rank #1\nbrief: ${BRIEF}\ndone: ${DONE}\n`);
	expect(state).toContain(`\n- ${s.sl} [paused] ${TASK} — done when: ${SLICE_DONE}; inputs: src/header.css\n`);
	expect(state).toContain(`\n- ${s.q} on ${s.sl}: ${QUESTION.split("\n").join("\n  ")} — options: tokens / theme\n`);
	return state;
}

const NEWER_INSTRUCTION = "newer-mark-6060 keep the old token alias\nfor one release";
const NEWER_ENTRY = "newer-entry-mark-6161 the alias ships in 2.4";
/** What changes between two launches: Jo's new multiline instruction and a new entry. Returns the instruction's id. */
function newerRows(r: LaneRoot, wl: string): string {
	const l = ledgerOf(r);
	try {
		const id = l.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: NEWER_INSTRUCTION, author: "jo", channel: "surface" });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: NEWER_ENTRY });
		return id;
	} finally {
		l.close();
	}
}
/** The later launch's context is current: the instruction since the previous lane by id in promptFor's list, and both newer rows whole in the block's recent rows. */
function expectNewer(state: string, prompt: string, instruction: string): void {
	expect(prompt).toContain(`\n- ${instruction} (`);
	expect(state).toContain(`instruction (jo via surface): ${NEWER_INSTRUCTION}\n`);
	expect(state).toContain(`assumption by ${SURFACE_BY}: ${NEWER_ENTRY}\n`);
}

describe("by-hand lane: the first prompt reaches the session (PLAN-2 D1, D1b, D2)", () => {
	test("fresh past the ceiling: paired spend and workload state reach the session as one `@<path>` initial message, without a ceiling stop or notice; AGENT_SYSTEM_BY_HAND=1", async () => {
		const r = makeRoot();
		const s = seeded(r);
		setScript(r, { steps: [] });
		const run = await byHand(r, s.wl, 1);
		expect(run.code).toBe(0);
		const path = promptPath(r, s.wl);
		expect(path).toContain(" ");
		const state = expectContext(run.prompt, s, run.laneId);
		// Jo's instruction: by id in promptFor's list, and whole (both lines) with the seeded entry in the block's recent rows
		expect(run.prompt).toContain(`\n- ${s.instruction} (`);
		expect(state).toContain(`instruction (jo via surface): ${INSTRUCTION}\n`);
		expect(state).toContain(`assumption by ${SURFACE_BY}: ${ENTRY}\n`);
		// the argv: interactive (no --mode rpc), --resume absent on a first launch, and the prompt as the last, single argument
		const dir = laneDir(s.wl, r.home);
		expect(run.rec.argv).toEqual(["--cwd", worktreePath(r.repo, s.wl), "--session-dir", join(dir, "sessions"), "--append-system-prompt", join(dir, "system.md"), `@${path}`]);
		// the session's first user message is the file's whole text, as OMP builds it: one message, from the @file, on the first turn
		expect(run.prompted).toMatchObject({ event: "prompt", initial: true, message: fileMessage(path, run.prompt) });
		expect(userMessages(run.rec.session)).toEqual([fileMessage(path, run.prompt)]);
		expect(run.events.map((e) => e.event)).toEqual(["prompt", "eof"]);
		expect(run.rec.env).toMatchObject({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: s.wl, AGENT_SYSTEM_LANE_ID: run.laneId, [BY_HAND]: "1" });
		expect(run.out).toContain(`first prompt supplied from ${path}`);
		expect(run.out).not.toContain("copied");
		expect(laneSnapshot(r, s.wl).questions.map((q) => q.id)).toEqual([s.q]);
	}, 60_000);

	test("resume past the ceiling on the same model: --resume the earlier session with paired spend and fresh workload state as its one new user message, without a ceiling stop or notice", async () => {
		const r = makeRoot();
		const s = seeded(r);
		setScript(r, { steps: [] });
		const first = await byHand(r, s.wl, 1);
		expect(first.code).toBe(0);
		const session = first.rec.session;
		const newer = newerRows(r, s.wl);
		const l = ledgerOf(r);
		const instructionsBefore = l.instructions(s.wl).length;
		l.close();

		const second = await byHand(r, s.wl, 2);
		expect(second.code).toBe(0);
		const path = promptPath(r, s.wl);
		expect(second.rec.argv.slice(-3)).toEqual(["--resume", session, `@${path}`]);
		expect(second.rec.session).toBe(session);
		expectNewer(expectContext(second.prompt, s, second.laneId), second.prompt, newer);
		// the resumed file: the first launch's one message, then, after the resume, exactly one more: this launch's context
		expect(userMessages(session, true)).toEqual([fileMessage(path, second.prompt)]);
		expect(userMessages(session)).toEqual([fileMessage(path, first.prompt), fileMessage(path, second.prompt)]);
		expect(second.rec.env[BY_HAND]).toBe("1");
		// the context message is not Jo's input: no instruction row came of the launch (OMP sends the @file without an input event)
		const l2 = ledgerOf(r);
		expect(l2.instructions(s.wl)).toHaveLength(instructionsBefore);
		l2.close();
		expect(laneSnapshot(r, s.wl).questions.map((q) => q.id)).toEqual([s.q]);
	}, 90_000);

	test("model mismatch: Jo named another model since, so the earlier session is not resumed; the fresh session's first user message is the context, and the notice says why", async () => {
		const r = makeRoot();
		const s = seeded(r);
		setScript(r, { steps: [] });
		const first = await byHand(r, s.wl, 1);
		expect(first.code).toBe(0);
		const l = ledgerOf(r);
		l.recordEntry({ by: SURFACE_BY, workloadId: s.wl, kind: "assumption", body: laneModelBody(X, l.now()) });
		l.close();
		const newer = newerRows(r, s.wl);

		const second = await byHand(r, s.wl, 2);
		expect(second.code).toBe(0);
		const path = promptPath(r, s.wl);
		expect(second.rec.argv).not.toContain("--resume");
		expect(second.rec.argv.slice(-3)).toEqual(["--model", X, `@${path}`]);
		expect(second.rec.session).not.toBe(first.rec.session);
		expectNewer(expectContext(second.prompt, s, second.laneId), second.prompt, newer);
		expect(userMessages(second.rec.session)).toEqual([fileMessage(path, second.prompt)]);
		expect(userMessages(first.rec.session)).toEqual([fileMessage(path, first.prompt)]);
		expect(second.out).toContain(`a fresh session on ${X}: ${first.rec.session} ran on default`);
		expect(second.rec.env[BY_HAND]).toBe("1");
	}, 90_000);
});

describe("autonomous lane: unchanged, and never by hand (PLAN-2 D1, D4 marker)", () => {
	test("an inherited AGENT_SYSTEM_BY_HAND=1 does not reach the runner's omp; its argv is laneArgv's exactly (no @file) and its prompt is the rpc prompt, with no workload-state section", async () => {
		const r = makeRoot({ [BY_HAND]: "1" });
		const l = ledgerOf(r);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "autonomous by-hand marker probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		l.close();
		setScript(r, { steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] });
		const launch = sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "test"], r.repo, r.env);
		expect(launch.code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		await until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId));
		const [rec] = fakeRecords(r);
		const dir = laneDir(wl, r.home);
		expect(rec!.argv).toEqual(["--mode", "rpc", "--no-ui", "--cwd", worktreePath(r.repo, wl), "--session-dir", join(dir, "sessions"), "--append-system-prompt", join(dir, "system.md"), "--max-time", "370m"]);
		expect(rec!.env).toMatchObject({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: laneId });
		expect(rec!.env![BY_HAND]).toBeUndefined();
		const prompts = fakeRecords(r).filter((x) => x.pid === rec!.pid && x.event === "prompt");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]!.initial).toBeUndefined();
		expect(prompts[0]!.message).toStartWith(`You are lane ${laneId} on workload ${wl}.\n`);
		expect(prompts[0]!.message).not.toContain("## Workload state now");
	}, 60_000);
});
