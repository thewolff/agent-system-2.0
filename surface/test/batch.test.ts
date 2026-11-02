// Batched needs-you arrivals and the surface words brb / back (PLAN wl-mv5msri070p0qo D3, D4,
// § 3 sl-surface-wire). The test plays OMP's part: it fires the poll (ctx.setInterval), emits Jo's
// `input` event and his turn's `before_agent_start`, and moves the session clock (`s.now`) and the
// lane connection's clock together, so the fixed window and the quiet stretch are measured on it.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { consumeLines } from "../src/delivery";
import { applyTrain, interpret } from "../src/input";
import { recordTrainTask } from "../src/merge-train";
import orchestratorSurface from "../index";
import { onFire } from "../src/batch";
import { ceilingNoticeBody } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { laneExitBody, SCRATCH_SWEEP_BY } from "../src/launch";
import { sendNotice } from "../src/notice";
import { pendingBlock, pendingItems, pendingWaits } from "../src/pending";
import { surfaceSession } from "../src/session";
import { laneDiedShutdownBody } from "../src/signals";
import {
	type Failure, makeRunId, notifiesOrchestrator, securityRedBody, securityRedOf, testRequestedBody, type TestRun, testRunBody, testRunFailedBody, testRunFailedOf,
} from "../src/test-run";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { SCRATCH_ENTRY } from "../../gates/src/scratch";
import { askJo, nowBody } from "../../gates/src/rulings";
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

/** The runner's ceiling notice at `level` on a workload of its own: what the lane runner's meter sends (surface/scripts/lane.ts sendCeilingNotice). */
function ceilingNotice(l: Ledger, level: 80 | 100 = 80, by = LANE_RUNNER_BY) {
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	const body = ceilingNoticeBody(level, wl, { usd: level === 80 ? 40 : 50, tokens: 1000, wallMin: 10 }, { usd: 50, wallMin: 360 }, "normal");
	const m = sendNotice(l, { by, workloadId: wl, body });
	return { wl, m, needle: `ceiling ${level} % at usd 50 wall 360 on ${wl}` };
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

describe("onFire: the kinds that go out on their own poll", () => {
	test("a death with open or paused work, the runner's ceiling notice, a ceiling stop's idle exit and a red run are on fire; their quiet twins are not", () => {
		const { ledger: l } = tempLedger();
		const live = workloadWithSlice(l).wl;
		death(l, live, 1);
		const empty = l.openWorkload({ by: "lane-x", brief: "nothing left", stakes: "normal", mode: "autonomous" });
		death(l, empty, 0);
		const ceiling = ceilingNotice(l);
		const stop = ceilingNotice(l, 100);
		const forged = ceilingNotice(l, 80, "lane-x");
		const plain = workloadWithSlice(l).wl;
		const note = sendNotice(l, { by: "lane-x", workloadId: plain, body: "the train holds" });
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
		expect(fire("notice", ceiling.wl, ceiling.m)).toBe(true);
		expect(fire("notice", stop.wl, stop.m)).toBe(true);
		expect(fire("notice", forged.wl, forged.m)).toBe(false);
		expect(fire("notice", plain, note)).toBe(false);
		expect(fire("question", other, routine)).toBe(false);
		expect(fire("idle", stopped)).toBe(true);
		expect(fire("idle", parked)).toBe(false);
		expect(fire("test-run", red)).toBe(true);
	});
});

describe("NOW (PLAN wl-mvg1vs0rhnu3gg § 1.0–1.3): a marked question, a NOW_RESERVED request and the scratch disk are on fire", () => {
	/** The `errorLines` line of `kind` about `rowId`, which must exist. */
	const lineOf = (l: Ledger, kind: string, rowId: string) => {
		const line = errorLines(l).find((x) => x.kind === kind && x.rowId === rowId);
		expect(line).toBeDefined();
		return line!;
	};
	/** Row 6's `reserved-request` body for an action and the call it refused (gates/src/rows/r06-reserved.ts reservedRequestBody). */
	const request = (l: Ledger, wl: string, sl: string, action: string, call: string) =>
		l.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: `${action}: ${call} (P-11 row 6 refused tool call c1)` });

	test("a lane question askJo raised with now is tagged NOW (<category>) with state now and on fire; a plain question is neither", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl } = workloadWithSlice(l);
		const hot = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "The token leaks into logs: rotate now?", options: ["rotate", "hold"], now: "security" }, { asker: "lane" });
		const cold = ask(l, wl, sl, "Which header token?");
		if (!("raised" in hot)) throw new Error("not raised");
		const now = lineOf(l, "question", hot.raised);
		expect(now.state).toBe("now");
		expect(now.line.startsWith(`NOW (security): lane on ${wl} is waiting on you (${hot.raised}, slice ${sl}): The token leaks into logs: rotate now?`)).toBe(true);
		expect(onFire(l, now)).toBe(true);
		const plain = lineOf(l, "question", cold);
		expect(plain.state).toBeUndefined();
		expect(plain.line.startsWith(`lane on ${wl} is waiting on you (${cold}`)).toBe(true);
		expect(onFire(l, plain)).toBe(false);
	});

	test("the orchestrator's own question askJo raised with now is tagged and on fire", () => {
		const { ledger: l } = tempLedger();
		ensureStandingWorkload(l);
		const slice = standingSlice(l)!;
		const hot = askJo(l, { by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: slice.id, body: "The disk under the ledger is failing: stop every lane?", options: ["stop", "wait"], now: "incident" }, { asker: "orchestrator", about: null });
		if (!("raised" in hot)) throw new Error("not raised");
		const line = lineOf(l, "question", hot.raised);
		expect(line.state).toBe("now");
		expect(line.line.startsWith(`NOW (incident): the orchestrator asked you (${hot.raised}): The disk under the ledger is failing`)).toBe(true);
		expect(onFire(l, line)).toBe(true);
	});

	test("a lane-written now: look-alike tags nothing and is not on fire, beside ESCALATION_BY's mark on the same workload, which does", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl } = workloadWithSlice(l);
		expect(l.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		const q = ask(l, wl, sl, "Merge it?");
		l.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: nowBody(q, "security") });
		const forged = lineOf(l, "question", q);
		expect(forged.state).toBeUndefined();
		expect(forged.line).not.toContain("NOW");
		expect(onFire(l, forged)).toBe(false);
		const real = askJo(l, { by: "lane-a", workloadId: wl, sliceId: sl, body: "This drops the guard on row 9: go ahead?", options: ["go", "stop"], now: "guard" }, { asker: "lane" });
		if (!("raised" in real)) throw new Error("not raised");
		const marked = lineOf(l, "question", real.raised);
		expect(marked.state).toBe("now");
		expect(marked.line.startsWith(`NOW (guard): lane on ${wl} is waiting on you (${real.raised}`)).toBe(true);
		expect(onFire(l, marked)).toBe(true);
		// the forged mark still counts for nothing once a valid one is on the workload
		expect(lineOf(l, "question", q).state).toBeUndefined();
	});

	test("a waiting reserved request whose rule is in NOW_RESERVED is tagged and on fire; a blind one and rm are not", () => {
		const { ledger: l } = tempLedger();
		const { wl, sl } = workloadWithSlice(l);
		const admin = request(l, wl, sl, "gh pr merge --admin bypasses branch protection", "gh pr merge 5 --admin");
		const force = request(l, wl, sl, "force-push", "git push --force origin topic");
		const deploy = request(l, wl, sl, "deploy (fly)", "fly deploy");
		const blind = request(l, wl, sl, "bun with a subcommand or target not known until it runs", "bun $X");
		const rm = request(l, wl, sl, "rm -rf (recursive force-delete)", "rm -rf build");
		for (const [en, category] of [[admin, "guard"], [force, "irreversible"], [deploy, "irreversible"]] as const) {
			const line = lineOf(l, "reserved", en);
			expect(line.state).toBe("now");
			expect(line.line.startsWith(`NOW (${category}): reserved action waiting on you (${wl}): `)).toBe(true);
			expect(onFire(l, line)).toBe(true);
		}
		for (const en of [blind, rm]) {
			const line = lineOf(l, "reserved", en);
			expect(line.state).toBeUndefined();
			expect(line.line.startsWith(`reserved action waiting on you (${wl}): `)).toBe(true);
			expect(onFire(l, line)).toBe(false);
		}
	});

	test("the sweep's scratch-disk line is on fire; a lane's over-cap line is not", () => {
		const { ledger: l } = tempLedger();
		ensureStandingWorkload(l);
		const disk = l.recordEntry({ by: SCRATCH_SWEEP_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `${SCRATCH_ENTRY.disk} 12000.5 MiB under /h passes 10240 MiB (AGENT_SYSTEM_SCRATCH_TOTAL_MB); report /r.md` });
		expect(onFire(l, lineOf(l, "scratch", disk))).toBe(true);
		const { wl } = workloadWithSlice(l);
		expect(l.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		const over = l.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: `${SCRATCH_ENTRY.overCap} 3000.0 MiB over the 2048 MiB cap at /h/s/${wl}` });
		expect(onFire(l, lineOf(l, "scratch", over))).toBe(false);
	});
});

describe("security-red (PLAN wl-mvg1vs0rhnu3gg § 3.3): a failing gate test is on fire whatever holds the workload or routes its run", () => {
	const SHA = "b".repeat(40);
	const SEC: Failure = { part: "full", name: "gates/test/rows.test.ts > row 3 > refuses", firstError: "error: expected a refusal" };
	const PLAIN: Failure = { part: "full", name: "surface/test/x.test.ts > broken", firstError: "error: nope" };
	let seq = 0;
	/**
	 * The runner's finish (surface/scripts/test-runner.ts): the request and its red `test-run:` on `wl`, then the messages it
	 * enqueues to the orchestrator, decided as it decides them. Returns the two message ids (null for one not sent).
	 */
	function finish(l: Ledger, wl: string, sl: string, pr: number, failures: Failure[]) {
		const runId = makeRunId(Date.parse(l.now()) + ++seq, "abcd");
		l.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr, sha: SHA, slice: sl, by: "lane-a" }) });
		const run: TestRun = {
			runId, verdict: "red", sha: SHA, pr, reason: null, headAtEnd: SHA, base: null, mergeBase: null,
			full: { pass: 1, fail: failures.length, skip: 0, exit: 1, ms: 10, error: null }, solo: [], failures, runDir: `/runs/${runId}`, preflight: null,
		};
		l.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRunBody(run) });
		const heldLive = l.liveLaneHolders().some((h) => h.workloadId === wl);
		const failed = notifiesOrchestrator(run.verdict, heldLive) ? testRunFailedOf(wl, sl, run) : null;
		const security = securityRedOf(wl, sl, run);
		const [ordinary = null, secure = null] = [failed && testRunFailedBody(failed), security && securityRedBody(security)]
			.map((body) => (body ? l.enqueue({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, sender: TEST_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body }) : null));
		return { runId, ordinary, security: secure };
	}

	test("while a lane holds the workload live: the security red is shown and on fire, an ordinary red shows nothing", () => {
		const c = clock();
		const { ledger: l } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(l);
		const lines = () => errorLines(l, undefined, { now: c.now() }).filter((x) => x.workloadId === wl);
		// with no lane, the ordinary red is the test-run line
		const before = finish(l, wl, sl, 17, [PLAIN]);
		expect(before.security).toBeNull();
		expect(lines().map((x) => [x.kind, x.rowId])).toEqual([["test-run", before.ordinary]]);
		c.plusHours(0.1);
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-a-1", leaseMs: 3_600_000 }).won).toBe(true);
		expect(l.liveLaneHolders().some((h) => h.workloadId === wl)).toBe(true);
		// the lane is live: the ordinary red already sent and a new one both show nothing
		c.plusHours(0.1);
		expect(finish(l, wl, sl, 17, [PLAIN])).toMatchObject({ ordinary: null, security: null });
		expect(lines()).toEqual([]);
		// a run failing a gate test: the runner sends the security red alone, and it is shown and on fire
		c.plusHours(0.1);
		const sec = finish(l, wl, sl, 17, [PLAIN, SEC]);
		expect(sec.ordinary).toBeNull();
		expect(sec.security).not.toBeNull();
		const shown = lines();
		expect(shown).toEqual([{
			kind: "security-red", next: "a lane asks you before it changes such a test", workloadId: wl, rowId: sec.security!, messageIds: [sec.security!],
			line: `security tests red on ${wl}: run ${sec.runId} at bbbbbbb (slice ${sl}) has 1 failing under gates/test/, first ${SEC.name} — a lane asks you before it changes such a test`,
		}]);
		expect(onFire(l, shown[0]!)).toBe(true);
		// delivery consumes it
		expect(consumeLines(l, shown)).toBe(1);
		expect(lines()).toEqual([]);
	});

	test("while the run is routed to a train task: the security red is shown and on fire, an ordinary red shows nothing", () => {
		const c = clock();
		const { ledger: l } = tempLedger(c.now);
		const url = "https://github.com/thewolff/product.git";
		const checkout = () => {
			const dir = tmp("security-red-repo");
			for (const args of [["init", "-q"], ["config", "remote.origin.url", url]]) expect(Bun.spawnSync(["git", "-C", dir, ...args]).exitCode).toBe(0);
			return dir;
		};
		const cmd = interpret(l, "train 101");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const train = applyTrain(l, cmd, checkout()).workloadId;
		expect(l.claimWorkload(train, { by: LANE_STARTER_BY, holder: "lane-train-1", leaseMs: 600_000 }).won).toBe(true);
		const owner = l.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
		recordRepo(l, owner, checkout());
		const view = { number: 101, headRefName: `wl/${owner}`, headRefOid: SHA, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" } };
		const task = recordTrainTask(l, { train, by: "lane-train-1", pr: 101, kind: "red", detail: `run tr-x red at ${SHA}\nsrc/x.test.ts > case 1: boom`, view, trainRepo: "thewolff/product" });
		expect(task.ok).toBe(true);
		c.plusHours(0.1);
		const sl = l.addSlice({ by: "lane-owner-1", workloadId: owner, task: "suite #101", doneCondition: "green", inputs: "#101" });
		const lines = () => errorLines(l, undefined, { now: c.now() }).filter((x) => x.workloadId === owner);
		// no lane holds the owner, so the runner sends the ordinary red; the task routes it off needs-you
		const plain = finish(l, owner, sl, 101, [PLAIN]);
		expect(plain.ordinary).not.toBeNull();
		expect(plain.security).toBeNull();
		expect(lines()).toEqual([]);
		// a run failing a gate test: its ordinary red is routed too, its security red is shown and on fire
		c.plusHours(0.1);
		const sec = finish(l, owner, sl, 101, [SEC]);
		expect(sec.ordinary).not.toBeNull();
		const shown = lines();
		expect(shown).toEqual([{
			kind: "security-red", next: "a lane asks you before it changes such a test", workloadId: owner, rowId: sec.security!, messageIds: [sec.security!],
			line: `security tests red on ${owner}: run ${sec.runId} at bbbbbbb (slice ${sl}) has 1 failing under gates/test/, first ${SEC.name} — a lane asks you before it changes such a test`,
		}]);
		expect(onFire(l, shown[0]!)).toBe(true);
	});

	test("fix round 1 (F3): a security red whose workload closes before delivery still shows, on fire, and delivery consumes it exactly once", () => {
		const c = clock();
		const { ledger: l } = tempLedger(c.now);
		const { wl, sl } = workloadWithSlice(l);
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-a-1", leaseMs: 3_600_000 }).won).toBe(true);
		const sec = finish(l, wl, sl, 17, [SEC]);
		expect(sec.security).not.toBeNull();
		// The lane fixes it, completes its slice and lets go; the workload closes with the alert still held.
		c.plusHours(0.1);
		l.completeSlice(sl, { by: "lane-a-1", artifact: "fixed" });
		l.releaseWorkload(wl, { by: "lane-a-1", holder: "lane-a-1" });
		l.closeWorkload(wl, { by: SURFACE_BY });
		expect(l.workload(wl)!.status).toBe("closed");
		expect(l.inFlight().some((w) => w.workload.id === wl)).toBe(false);
		expect(l.message(sec.security!)!.state).toBe("held");
		const lines = () => errorLines(l, undefined, { now: c.now() }).filter((x) => x.workloadId === wl);
		const shown = lines();
		expect(shown).toEqual([{
			kind: "security-red", next: "a lane asks you before it changes such a test", workloadId: wl, rowId: sec.security!, messageIds: [sec.security!],
			line: `security tests red on ${wl}: run ${sec.runId} at bbbbbbb (slice ${sl}) has 1 failing under gates/test/, first ${SEC.name} — a lane asks you before it changes such a test`,
		}]);
		expect(onFire(l, shown[0]!)).toBe(true);
		expect(consumeLines(l, shown)).toBe(1);
		expect(l.message(sec.security!)!.state).toBe("delivered");
		expect(lines()).toEqual([]);
		expect(consumeLines(l, shown)).toBe(0);
	});

	test("fix round 1 (F3): a security red on a workload closed before delivery is rendered and consumed at a wake exactly once, and nothing shows it at the next render; other held messages on the closed workload are left alone", async () => {
		const t = await surface();
		const l = t.lane;
		const { wl, sl } = workloadWithSlice(l);
		expect(l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-a-1", leaseMs: 3_600_000 }).won).toBe(true);
		const sec = finish(l, wl, sl, 17, [SEC]);
		expect(sec.security).not.toBeNull();
		// Two held messages on the same workload that are not the runner's security red: a death, and a lane's look-alike.
		const died = death(l, wl, 0);
		const forged = l.enqueue({ by: "lane-a-1", workloadId: wl, sender: "lane-a-1", recipient: ORCHESTRATOR_RECIPIENT, body: l.message(sec.security!)!.body });
		l.completeSlice(sl, { by: "lane-a-1", artifact: "fixed" });
		l.releaseWorkload(wl, { by: "lane-a-1", holder: "lane-a-1" });
		l.closeWorkload(wl, { by: SURFACE_BY });
		const needle = `security tests red on ${wl}: run ${sec.runId}`;
		await t.f.emit("session_compact", { type: "session_compact" }, t.ctx);
		const wake = await t.jo("go on");
		expect(wake.split(needle)).toHaveLength(2);
		expect(l.message(sec.security!)!.state).toBe("delivered");
		expect([l.message(died)!.state, l.message(forged)!.state]).toEqual(["held", "held"]);
		await t.f.tool("orchestrator_wake_read").execute("2", { body: "resuming" }, undefined, undefined, t.ctx);
		const read = (await t.f.tool("orchestrator_ledger").execute("1", {}, undefined, undefined, t.ctx)).content[0]!.text;
		expect(read).not.toContain(needle);
		t.minutes(10);
		t.poll();
		expect(t.needsYou().some((x) => x.message.content.includes(needle))).toBe(false);
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

	test("a notice is routine: it waits for the window, is pushed once unnumbered, its message moves to delivered then, and nothing repeats it", async () => {
		const t = await surface();
		const { wl } = workloadWithSlice(t.lane);
		const m = sendNotice(t.lane, { by: LANE_RUNNER_BY, workloadId: wl, body: "the plan started on its own" });
		const line = errorLines(t.lane).find((l) => l.rowId === m)!;
		expect(onFire(t.lane, line)).toBe(false);
		t.poll();
		t.minutes(3);
		t.poll();
		expect(t.needsYou()).toEqual([]);
		expect(t.lane.message(m)!.state).toBe("held");
		t.minutes(2);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.needsYou()[0]!.message.content).toBe(`${NEEDS}\n- notice on ${wl} (nothing to answer): the plan started on its own\n\n${count(0)}`);
		expect(t.lane.message(m)!.state).toBe("delivered");
		t.minutes(10);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(await t.jo("ok")).toBe(count(0));
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
		["the runner's ceiling notice", (l) => ceilingNotice(l).needle],
		["the runner's stop notice at 100 %", (l) => ceilingNotice(l, 100).needle],
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
		const { needle } = ceilingNotice(t.lane, 100);
		t.poll();
		expect(t.needsYou()).toHaveLength(1);
		expect(t.needsYou()[0]!.message.content).toContain(needle);
		expect(t.needsYou()[0]!.message.content).not.toContain(routine);
		expect(t.needsYou()[0]!.message.content.endsWith(count(1))).toBe(true);
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
		expect(turn).toContain(`\n\n${t.block()}\n\n${count(1)}`);
		expect(turn.endsWith(count(1))).toBe(true);
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
