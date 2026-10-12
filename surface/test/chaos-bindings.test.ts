// The nightly chaos run's bindings to the code it drives (PLAN wl-mv5lpzqacbe5ts § 2.4): every fault's trigger
// predicate (surface/src/chaos-triggers.ts) over state the real producers wrote, the in-process stub driven into
// the fault's mode with what the run's monitor reads of it, the expected recovery judged by `judgePoll` and
// `verdict`, the runner seams lane.ts exports, and the stub lane's scripted plan executed through the real lane
// tools on one fake host. A refactor of a producer, a tool schema or a tier file fails here, not at 03:00.
// No omp and no process: the only network is the stub on localhost, and every hold is released at once.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handSettledBody, handSpawnBody } from "../../classifier/src/lab";
import wakeReadRow from "../../gates/extensions/r07-wake-read";
import type { GatesAPI } from "../../gates/src/session";
import { type EntryRow, LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { chaosLanePlan, LANE_TIER_MARK, ORCHESTRATOR_TIER_MARK } from "../scripts/chaos";
import { ompPackagesRoot, parseMessagesRequest, REFUSAL_EXPLANATION, type Stub, type StubRequest, type StubScript, startStub } from "../scripts/chaos-stub";
import { alreadyRunningText, isRunnerCommand, runnerArgv } from "../scripts/lane";
import {
	emptySeen, type Evidence, FAULT_EVIDENCE, FAULTS, type FaultName, firstHolder, judgePoll, type LaneStart, laneStarts, type Poll, SECOND_RUNNER_EVIDENCE, SECOND_RUNNER_REFUSAL, type Seen, verdict,
} from "../src/chaos";
import {
	type ChaosSpawn, chaosSpawns, firstLaneStart, firstSpawnSeen, handKillTarget, type HeldView, laneEnd, orchestratorBootDue, refusalArms, reviewKillTarget,
} from "../src/chaos-triggers";
import { laneDiedExitBody, laneDiedLaunchBody, laneExitBody, laneStartedBody, STARTER_EXIT } from "../src/launch";
import { laneDiedShutdownBody, recordLapsedLeases } from "../src/signals";
import { promptEndedDeathBody } from "../src/turn-end";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "../src/types";
import { clock, ctxOf, fakePi, LANE_SCRIPT, tempLedger, tmp } from "./helpers";

const REPO = join(import.meta.dir, "..", "..");
const T0 = "2026-10-11T10:00:00.000Z";
const at = (s: number): string => new Date(Date.parse(T0) + s * 1000).toISOString();
const TOKEN = "bind1";
const WL = `wl-chaos-${TOKEN}`;
const LANE = `lane-chaos-${TOKEN}-1`;
const PLAN = chaosLanePlan(WL, TOKEN);
/** The scripted dispatches' briefs: what the change hand's and the review hand's first user message carries. */
const dispatched = PLAN.filter((s) => s.tool === "task").map((s) => (s.input.tasks as { task: string }[])[0]!.task);
const HAND_BRIEF = dispatched[0]!;
const REVIEW_BRIEF = dispatched[1]!;
const LANE_TIER = readFileSync(join(REPO, "tiers", "lane.md"), "utf8");
const ORCHESTRATOR_TIER = readFileSync(join(REPO, "tiers", "orchestrator.md"), "utf8");
const noSessions = () => [];

// ---- the throwaway ledger and the real producers ----------------------------------------------------

/** The run's throwaway ledger and workload, with the clock that stamps its writes. */
interface World {
	c: { now: () => string; at: (iso: string) => void };
	ledger: Ledger;
	wl: string;
	entries: () => EntryRow[];
	messages: () => { body: string; created_at: string }[];
}

/** A throwaway ledger holding the run's workload as chaos opens it, its clock `s` seconds from T0; `messages` reads as `Run.messages` does. */
function world(s = -60): World {
	const c = clock(at(s));
	const ledger = Ledger.open(join(tmp("chaos-bind"), "ledger.db"), { create: true, backup: false, backupOnOpen: false, clock: c.now });
	const wl = ledger.openWorkload({ by: "chaos", id: WL, stakes: "normal", mode: "autonomous", brief: `chaos run ${TOKEN}: append one line, have another lab check it, then park on a question.` });
	return {
		c, ledger, wl,
		entries: () => ledger.entries(wl),
		messages: () => ledger.db.query<{ body: string; created_at: string }, [string]>("SELECT body, created_at FROM messages WHERE workload_id = ? ORDER BY created_at").all(wl),
	};
}

const claimed = (w: World, leaseMs = 120_000) => expect(w.ledger.claimWorkload(w.wl, { by: LANE, holder: LANE, leaseMs }).won).toBe(true);
const started = (w: World, laneId = LANE, pid = 101, runnerPid = 201) =>
	w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: laneStartedBody(laneId, { pid, start: "Sun Oct 11 03:00:00 2026", session: null, argv: ["--mode", "rpc"], runnerPid }) });
const slice = (w: World, task: string) => w.ledger.addSlice({ by: LANE, workloadId: w.wl, task, doneCondition: "d", inputs: "i" });
/** The classifier's spawn record for a hand of the lane (classifier/extension.ts writes it as the lane). */
const spawned = (w: World, token: string, review: boolean, sliceId: string) =>
	w.ledger.recordEntry({
		by: LANE, workloadId: w.wl, sliceId, kind: "assumption",
		body: handSpawnBody({ token, root: join(tmp("sessions"), "lane"), spawnKey: token, review, group: review ? "standard" : "fast", row: ["anthropic/claude-haiku-4-5"] }),
	});
const settled = (w: World, token: string) => w.ledger.recordEntry({ by: LANE, workloadId: w.wl, kind: "assumption", body: handSettledBody(token, `rt-${token}`) });
const died = (w: World, by: string, body: string) => w.ledger.enqueue({ by, workloadId: w.wl, sender: by, recipient: ORCHESTRATOR_RECIPIENT, body });
const exited = (w: World, exit: { code: number | null; signal: string | null; outcome: string }) =>
	w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: w.wl, kind: "assumption", body: laneExitBody(LANE, exit) });

/** The lane's normal end (§ 2.2): the hold slice's question raised, the workload released on park, the runner's exit. */
function parked(w: World): string {
	const hold = slice(w, "chaos-hold: wait for Jo");
	const q = w.ledger.raiseQuestion({ by: LANE, workloadId: w.wl, sliceId: hold, body: "close or keep?", options: ["close", "keep"] });
	w.ledger.releaseWorkload(w.wl, { by: LANE, holder: LANE });
	exited(w, { code: 0, signal: null, outcome: "parked" });
	return q;
}

/** The judge as the run polls it, from `s` seconds on: one poll every 5 s until 30 s past the first. */
function judged(w: World, from: number): Poll[] {
	let seen: Seen = emptySeen();
	const polls: Poll[] = [];
	for (let s = from; s <= from + 30; s += 5) {
		w.c.at(at(s));
		const p = judgePoll(w.ledger, w.wl, seen, { sessionModels: noSessions });
		seen = p.seen;
		polls.push(p);
	}
	return polls;
}

/** Every evidence item the fault names, observed at injection; `unobserved` leaves that one with no observation. */
function evidence(fault: FaultName, unobserved?: string): Evidence {
	return {
		fault, injectedAt: T0, nonceMisses: [], egress: [], harness: [],
		items: FAULT_EVIDENCE[fault].map((name) => (name === unobserved ? { name, observed: "never seen", at: null } : { name, observed: "seen", at: T0 })),
	};
}

/** PASS on the recovery, and HARNESS-ERROR with `item` (one the run records with no systemFault) left unobserved. */
function judgesRecovery(w: World, fault: FaultName, item: string, from = 5): void {
	expect(FAULT_EVIDENCE[fault]).toContain(item);
	const polls = judged(w, from);
	const pass = verdict(polls, evidence(fault));
	expect({ verdict: pass.verdict, reason: pass.reason }).toMatchObject({ verdict: "PASS" });
	expect(pass.deciding?.at).toBe(at(from));
	expect(verdict(polls, evidence(fault, item))).toMatchObject({ verdict: "HARNESS-ERROR", deciding: null });
}

// ---- the in-process stub --------------------------------------------------------------------------

/** chaos's session kinds as `Run.scripts` tells them apart: the change hand and the review by their dispatched brief, the lane and the orchestrator by their tier file. */
function scripts(lane: StubScript["match"] = (r) => LANE_TIER_MARK.test(r.system)): StubScript[] {
	return [
		{ kind: "hand", match: (r) => r.firstUser === HAND_BRIEF, steps: [], after: { text: "done" } },
		{ kind: "review", match: (r) => r.firstUser === REVIEW_BRIEF, steps: [], after: { text: "done" } },
		{ kind: "lane", match: lane, steps: [], after: { text: "lane turn" } },
		{ kind: "orchestrator", match: (r) => ORCHESTRATOR_TIER_MARK.test(r.system), steps: [], after: { text: "orchestrator turn" } },
	];
}

/** One `/v1/messages` request, the shape chaos-stub.test.ts posts; `messages` defaults to one user turn. */
function post(stub: Stub, o: { system?: string; firstUser?: string; messages?: unknown[]; signal?: AbortSignal }): Promise<Response | null> {
	const messages = o.messages ?? [{ role: "user", content: o.firstUser ?? "hi" }];
	return fetch(`${stub.baseUrl}/v1/messages`, {
		method: "POST",
		headers: { "x-api-key": "chaos-stub", "content-type": "application/json" },
		body: JSON.stringify({ model: "m-1", system: o.system ?? "", stream: false, messages }),
		...(o.signal ? { signal: o.signal } : {}),
	}).catch(() => null);
}

/**
 * Polls `read` every 5 ms. The stub is a real localhost server answering on its own event loop, so a hold or a drop is
 * awaited as the condition the monitor reads, not a fake clock; the helpers' 100 ms `until` would dominate the file's wall time.
 */
async function soon<T>(what: string, read: () => T | null | undefined | false, ms = 2_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = read();
		if (v) return v as T;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** The change hand's spawn and the lane's start as the trigger reads them, from a ledger the producers wrote. */
function handAndStart(review = false): { spawns: ChaosSpawn[]; starts: LaneStart[] } {
	const w = world();
	claimed(w);
	started(w);
	spawned(w, review ? "rv-1" : "hk-1", review, slice(w, review ? "review the change" : "append one line"));
	return { spawns: chaosSpawns(w.entries()), starts: laneStarts(w.entries()) };
}

/** The lane's conversation after its wake read (the plan's first step), and after its first slice (the second). */
const toolTurn = (id: string, step: number, result: string) => [
	{ role: "assistant", content: [{ type: "tool_use", id, name: PLAN[step]!.tool, input: PLAN[step]!.input }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
];
const AFTER_WAKE = [{ role: "user", content: "chaos: go" }, ...toolTurn("t1", 0, "Recorded wake-read entry")];
const AFTER_SLICE = [...AFTER_WAKE, ...toolTurn("t2", 1, "Added slice")];

// ---- per fault: (a) the trigger, (b) the stub mode, (c) the recovery --------------------------------

interface Binding {
	trigger: () => void | Promise<void>;
	stub: () => void | Promise<void>;
	recovery: () => void;
}

const BINDINGS: Record<FaultName, Binding> = {
	"lane-kill-mid-hand": {
		trigger() {
			const w = world();
			let held: HeldView[] = [];
			const target = () => {
				const e = w.entries();
				return handKillTarget({ spawns: chaosSpawns(e), held, starts: laneStarts(e), laneId: LANE });
			};
			claimed(w);
			started(w);
			expect(target()).toBeNull();
			const sl = slice(w, "append one line");
			spawned(w, "rv-0", true, sl);
			held = [{ id: 1, kind: "review", outcome: "open" }];
			expect(target()).toBeNull(); // a review hand and a review hold are fault 2's
			spawned(w, "hk-1", false, sl);
			expect(target()).toBeNull(); // the hand's request is not held yet
			held = [...held, { id: 2, kind: "hand", outcome: "open" }];
			expect(target()).toMatchObject({ hand: { token: "hk-1", review: false, settled: false }, held: { id: 2 }, start: { laneId: LANE, pid: 101, runnerPid: 201 } });
			started(w, LANE, 102, 202); // a re-recorded start (the runner's resume): the newest is the one to kill
			expect(target()).toMatchObject({ start: { pid: 102, runnerPid: 202 } });
			settled(w, "hk-1");
			expect(target()).toBeNull();
		},
		async stub() {
			const { spawns, starts } = handAndStart();
			const stub = startStub({ nonce: TOKEN, scripts: scripts() });
			try {
				stub.setMode({ mode: "stall", kind: "hand", ms: 600_000 });
				const ac = new AbortController();
				const res = post(stub, { firstUser: HAND_BRIEF, signal: ac.signal });
				const h = await soon("the hand's request held", () => stub.held().find((x) => x.outcome === "open"));
				expect(h).toMatchObject({ kind: "hand", reason: "stall" });
				expect(handKillTarget({ spawns, held: stub.held(), starts, laneId: LANE })).toMatchObject({ held: { id: h.id } });
				// The kill drops the hand's connection: what the monitor reads as "held hand connection dropped".
				ac.abort();
				await res;
				expect(await soon("the hold dropped", () => stub.held().find((x) => x.id === h.id && x.outcome !== "open"))).toMatchObject({ outcome: "dropped" });
				stub.setMode({ mode: "normal" });
			} finally {
				stub.stop();
			}
		},
		recovery() {
			// The runner's record of the killed omp: its death line and its exit, then the release.
			const w = world();
			claimed(w);
			started(w);
			spawned(w, "hk-1", false, slice(w, "append one line"));
			w.c.at(at(2));
			died(w, LANE_RUNNER_BY, laneDiedExitBody(LANE, "died", null, "SIGKILL"));
			exited(w, { code: null, signal: "SIGKILL", outcome: "died" });
			w.ledger.releaseWorkload(w.wl, { by: LANE_RUNNER_BY, holder: LANE });
			expect(laneEnd(w.entries(), w.messages(), LANE)?.body).toBe(laneExitBody(LANE, { code: null, signal: "SIGKILL", outcome: "died" }));
			judgesRecovery(w, "lane-kill-mid-hand", "held hand connection dropped");

			// --kill runner: no exit is written; the lane's own shutdown death, or its lease lapsing, is the line.
			const shut = world();
			claimed(shut);
			started(shut);
			spawned(shut, "hk-1", false, slice(shut, "append one line"));
			shut.c.at(at(2));
			died(shut, LANE, laneDiedShutdownBody(LANE, shut.ledger.now(), 1));
			shut.ledger.releaseWorkload(shut.wl, { by: LANE, holder: LANE });
			expect(laneEnd(shut.entries(), shut.messages(), LANE)?.body).toBe(laneDiedShutdownBody(LANE, at(2), 1));
			judgesRecovery(shut, "lane-kill-mid-hand", "kill returned 0");

			const lapsed = world(-120);
			claimed(lapsed, 60_000);
			started(lapsed);
			spawned(lapsed, "hk-1", false, slice(lapsed, "append one line"));
			lapsed.c.at(at(2));
			expect(recordLapsedLeases(lapsed.ledger, SURFACE_BY)).toHaveLength(1);
			expect(laneEnd(lapsed.entries(), lapsed.messages(), LANE)).not.toBeNull();
			judgesRecovery(lapsed, "lane-kill-mid-hand", "kill returned 0");
		},
	},

	"orchestrator-kill-mid-review": {
		trigger() {
			const w = world();
			claimed(w);
			expect(orchestratorBootDue(w.entries(), LANE)).toBe(false);
			started(w, "lane-other-1");
			expect(orchestratorBootDue(w.entries(), LANE)).toBe(false); // another lane's start
			started(w);
			expect(orchestratorBootDue(w.entries(), LANE)).toBe(true);

			let held: HeldView[] = [{ id: 1, kind: "hand", outcome: "answered" }];
			const target = (orchestratorRunning = true) => reviewKillTarget({ spawns: chaosSpawns(w.entries()), held, orchestratorRunning });
			const change = slice(w, "append one line");
			spawned(w, "hk-1", false, change);
			settled(w, "hk-1");
			expect(target()).toBeNull();
			spawned(w, "rv-1", true, slice(w, "review the change"));
			expect(target()).toBeNull(); // the review's request is not held yet
			held = [...held, { id: 2, kind: "review", outcome: "open" }];
			expect(target(false)).toBeNull(); // no orchestrator to kill yet
			expect(target()).toMatchObject({ review: { token: "rv-1", review: true }, held: { id: 2 } });
			settled(w, "rv-1");
			expect(target()).toBeNull();
		},
		async stub() {
			const { spawns } = handAndStart(true);
			const stub = startStub({ nonce: TOKEN, scripts: scripts() });
			try {
				stub.setMode({ mode: "stall", kind: "review", ms: 600_000 });
				// the change hand is not held: the stall is the review's alone
				expect(await (await post(stub, { firstUser: HAND_BRIEF }))?.json()).toMatchObject({ stop_reason: "end_turn" });
				const res = post(stub, { firstUser: REVIEW_BRIEF });
				const h = await soon("the review's request held", () => stub.held().find((x) => x.outcome === "open"));
				expect(h).toMatchObject({ kind: "review", reason: "stall" });
				expect(reviewKillTarget({ spawns, held: stub.held(), orchestratorRunning: true })).toMatchObject({ review: { token: "rv-1" }, held: { id: h.id } });
				// The review hand survives the orchestrator's kill: its hold is answered when the stall ends.
				stub.setMode({ mode: "normal" });
				expect((await res)?.status).toBe(200);
				expect(stub.held().find((x) => x.id === h.id)?.outcome).toBe("answered");
			} finally {
				stub.stop();
			}
		},
		recovery() {
			const w = world();
			claimed(w);
			started(w);
			const change = slice(w, "append one line");
			spawned(w, "hk-1", false, change);
			settled(w, "hk-1");
			w.ledger.completeSlice(change, { by: LANE, artifact: "bun test chaos/ exit 0" });
			const review = slice(w, "review the change");
			spawned(w, "rv-1", true, review);
			w.c.at(at(2));
			settled(w, "rv-1");
			w.ledger.completeSlice(review, { by: LANE, artifact: "review-findings: no findings" });
			expect(chaosSpawns(w.entries()).find((s) => s.token === "rv-1")?.settled).toBe(true); // "review hand settled"
			parked(w);
			judgesRecovery(w, "orchestrator-kill-mid-review", "review hand settled");
		},
	},

	"network-block-60s": {
		trigger() {
			const w = world();
			claimed(w);
			started(w);
			const sl = slice(w, "append one line");
			expect(firstSpawnSeen({ spawns: chaosSpawns(w.entries()) })).toBe(false);
			spawned(w, "hk-1", false, sl);
			expect(firstSpawnSeen({ spawns: chaosSpawns(w.entries()) })).toBe(true);
		},
		async stub() {
			const stub = startStub({ nonce: TOKEN, scripts: scripts() });
			try {
				stub.setMode({ mode: "blackhole", ms: 60_000 });
				const ac = new AbortController();
				const res = post(stub, { system: LANE_TIER, signal: ac.signal });
				const h = await soon("the lane's request held", () => stub.held().find((x) => x.outcome === "open"));
				expect(h).toMatchObject({ kind: "lane", reason: "blackhole" });
				expect(stub.windows()).toMatchObject([{ held: 1, end: null, ms: 60_000 }]);
				// Released at once: the client gives up first, so ending the window resets nothing (no 1 s socket timeout).
				ac.abort();
				await res;
				await soon("the hold dropped", () => stub.held().find((x) => x.id === h.id && x.outcome === "dropped"));
				stub.setMode({ mode: "normal" });
				const [win] = stub.windows();
				expect(win).toMatchObject({ held: 1, reset: 0 });
				expect(win!.end).not.toBeNull();
			} finally {
				stub.stop();
			}
		},
		recovery() {
			const w = world();
			claimed(w);
			started(w);
			const change = slice(w, "append one line");
			spawned(w, "hk-1", false, change);
			w.c.at(at(2));
			settled(w, "hk-1");
			w.ledger.completeSlice(change, { by: LANE, artifact: "bun test chaos/ exit 0" });
			parked(w);
			judgesRecovery(w, "network-block-60s", "provider connection held in the window");
		},
	},

	"provider-refusal": {
		trigger() {
			// The request as the stub parses it (parseMessagesRequest), from the lane's conversation at each step.
			const request = (messages: unknown[]) => parseMessagesRequest({ model: "m-1", system: LANE_TIER, messages });
			expect(refusalArms(request([{ role: "user", content: "chaos: go" }]), false)).toBe(false);
			expect(refusalArms(request(AFTER_WAKE), false)).toBe(false);
			expect(refusalArms(request(AFTER_SLICE), false)).toBe(true);
			expect(refusalArms(request(AFTER_SLICE), true)).toBe(false); // arms once
		},
		async stub() {
			let armed = false;
			let stub: Stub | null = null;
			// The run's lane matcher: arm on the request itself, so this same request is the refused one.
			const lane = (r: StubRequest) => {
				const isLane = LANE_TIER_MARK.test(r.system);
				if (isLane && refusalArms(r, armed)) {
					armed = true;
					stub!.setMode({ mode: "refuse", kind: "lane" });
				}
				return isLane;
			};
			stub = startStub({ nonce: TOKEN, scripts: scripts(lane) });
			try {
				expect(await (await post(stub, { system: LANE_TIER, messages: AFTER_WAKE }))?.json()).toMatchObject({ stop_reason: "end_turn" });
				expect(stub.counts().refused.lane ?? 0).toBe(0);
				expect(await (await post(stub, { system: LANE_TIER, messages: AFTER_SLICE }))?.json()).toMatchObject({
					stop_reason: "refusal", stop_details: { category: "cyber", explanation: `${REFUSAL_EXPLANATION} [${TOKEN}]` },
				});
				expect(stub.counts().refused).toEqual({ lane: 1 });
			} finally {
				stub.stop();
			}
		},
		recovery() {
			const w = world();
			claimed(w);
			started(w);
			slice(w, "append one line");
			w.c.at(at(2));
			// The lane's turn-end death for the refused prompt, as OMP reports a cyber refusal (anthropic.ts errorMessage).
			const body = promptEndedDeathBody(LANE, "error", { provider: "anthropic", model: "claude-haiku-4-5", message: `Refusal (cyber): ${REFUSAL_EXPLANATION} [${TOKEN}]`, retryable: false });
			// what the run's monitor requires of the death's body
			expect(body).toMatch(/Refusal \(cyber\)/);
			expect(body).toMatch(/retryable false/);
			died(w, LANE, body);
			w.ledger.releaseWorkload(w.wl, { by: LANE, holder: LANE });
			exited(w, { code: 1, signal: null, outcome: "error" });
			judgesRecovery(w, "provider-refusal", "refusal served to a lane request");
		},
	},

	"duplicate-lane-runner": {
		trigger() {
			const w = world();
			claimed(w);
			expect(firstLaneStart(w.entries(), LANE)).toBeNull();
			started(w, "lane-other-1", 99, 199);
			expect(firstLaneStart(w.entries(), LANE)).toBeNull();
			started(w);
			started(w, LANE, 102, 202);
			expect(firstLaneStart(w.entries(), LANE)).toMatchObject({ laneId: LANE, pid: 101, runnerPid: 201 });
		},
		stub() {
			// Fault 5 has no stub mode: its action is a second launch and a second `lane.ts run`, so the binding is the
			// runner seam lane.ts exports: the argv chaos and cmdLaunch start a runner with, and the refusal chaos accepts.
			expect(isRunnerCommand(runnerArgv(LANE_SCRIPT, WL, LANE).join(" "), WL, LANE)).toBe(true);
			expect(isRunnerCommand(runnerArgv("surface/scripts/lane.ts", WL, LANE).join(" "), WL, LANE)).toBe(true);
			expect(isRunnerCommand(runnerArgv(LANE_SCRIPT, WL, `${LANE}0`).join(" "), WL, LANE)).toBe(false);
			for (const text of [alreadyRunningText(LANE, 4242), alreadyRunningText(LANE, "-"), alreadyRunningText(LANE, 4242, "omp")]) {
				expect(text).toMatch(SECOND_RUNNER_REFUSAL.text);
			}
			expect(SECOND_RUNNER_REFUSAL.code).toBe(STARTER_EXIT.held!);
		},
		recovery() {
			const w = world();
			claimed(w);
			started(w);
			w.c.at(T0); // the injection: the second launch and the second runner are refused; the first lane works on
			const change = slice(w, "append one line");
			spawned(w, "hk-1", false, change);
			w.c.at(at(2));
			settled(w, "hk-1");
			w.ledger.completeSlice(change, { by: LANE, artifact: "bun test chaos/ exit 0" });
			parked(w);
			// "first lane held throughout, no second lane held or reserved", as the monitor reads it
			expect(firstHolder({ laneId: LANE, injectedAt: T0, workload: w.ledger.workload(w.wl), entries: w.entries(), questions: w.ledger.questions(w.wl) }).state).toBe("ended");
			expect(FAULT_EVIDENCE["duplicate-lane-runner"]).toContain(SECOND_RUNNER_EVIDENCE);
			judgesRecovery(w, "duplicate-lane-runner", "second launch exited held");
		},
	},
};

test("every fault has a binding", () => {
	expect(Object.keys(BINDINGS)).toEqual([...FAULTS]);
});

for (const fault of FAULTS) {
	describe(fault, () => {
		test("(a) the trigger fires on the producers' records, and not one step earlier", () => BINDINGS[fault].trigger());
		test("(b) the stub in the fault's mode, as the monitor reads it", () => BINDINGS[fault].stub());
		test("(c) the recovery passes the judge; one unobserved evidence item is a harness error", () => BINDINGS[fault].recovery());
	});
}

describe("fault 1's two guards", () => {
	test("a held hand with no lane-started: is the immediate harness error, not a not-ready poll", () => {
		const w = world();
		claimed(w);
		started(w, "lane-other-1");
		spawned(w, "hk-1", false, slice(w, "append one line"));
		const held: HeldView[] = [{ id: 1, kind: "hand", outcome: "open" }];
		const e = w.entries();
		expect(handKillTarget({ spawns: chaosSpawns(e), held, starts: laneStarts(e), laneId: LANE })).toEqual({ error: "no lane-started" });
		expect(handKillTarget({ spawns: chaosSpawns(e), held: [], starts: laneStarts(e), laneId: LANE })).toBeNull();
	});

	test("the lane ended before the trigger: its launch failed, or it exited", () => {
		const w = world();
		claimed(w);
		expect(laneEnd(w.entries(), w.messages(), LANE)).toBeNull();
		died(w, LANE_STARTER_BY, laneDiedLaunchBody("lane-other-1", "spawn", "omp not found"));
		expect(laneEnd(w.entries(), w.messages(), LANE)).toBeNull(); // another lane's death
		const body = laneDiedLaunchBody(LANE, "spawn", "omp not found");
		died(w, LANE_STARTER_BY, body);
		expect(laneEnd(w.entries(), w.messages(), LANE)).toEqual({ body, at: at(-60) });

		const x = world();
		claimed(x);
		started(x);
		exited(x, { code: 0, signal: null, outcome: "done" });
		expect(laneEnd(x.entries(), x.messages(), LANE)?.body).toBe(laneExitBody(LANE, { code: 0, signal: null, outcome: "done" }));
	});
});

// ---- the lane plan through the real lane tools ----------------------------------------------------

/** A lane tool's parameters as the recording zod stand-in declares them. */
interface Desc {
	kind: "object" | "string" | "array" | "enum";
	isOptional: boolean;
	shape?: Record<string, Desc>;
	items?: Desc;
	values?: readonly string[];
	description?: string;
}
type Node = Desc & { optional: () => Node; describe: (text: string) => Node };
const node = (d: Desc): Node => ({ ...d, optional: () => node({ ...d, isOptional: true }), describe: (description: string) => node({ ...d, description }) });
const CONSTRUCTORS = {
	object: (shape: Record<string, Node>) => node({ kind: "object", isOptional: false, shape }),
	string: () => node({ kind: "string", isOptional: false }),
	array: (items: Node) => node({ kind: "array", isOptional: false, items }),
	enum: (values: readonly string[]) => node({ kind: "enum", isOptional: false, values }),
};
/** The host's `zod`, recording each declaration; any constructor the lane tools do not use throws at registration. */
const recordingZod = new Proxy(CONSTRUCTORS, {
	get(target, key) {
		if (typeof key === "string" && !Object.hasOwn(target, key)) throw new Error(`the zod stand-in has no z.${key}: a lane tool declares a schema construct chaos-bindings.test.ts does not model`);
		return Reflect.get(target, key);
	},
});

/** Where `value` breaks `d`: required keys present, the right type, enum membership, no unknown keys. */
function problems(d: Desc, value: unknown, path: string): string[] {
	switch (d.kind) {
		case "string":
			return typeof value === "string" ? [] : [`${path}: not a string`];
		case "enum":
			return typeof value === "string" && d.values!.includes(value) ? [] : [`${path}: ${JSON.stringify(value)} is not one of ${d.values!.join(", ")}`];
		case "array":
			return Array.isArray(value) ? value.flatMap((v, i) => problems(d.items!, v, `${path}[${i}]`)) : [`${path}: not an array`];
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: not an object`];
			const o = value as Record<string, unknown>;
			return [
				...Object.keys(o).filter((k) => !Object.hasOwn(d.shape!, k)).map((k) => `${path}.${k}: not a parameter of the tool`),
				...Object.entries(d.shape!).flatMap(([k, s]) => (o[k] === undefined ? (s.isOptional ? [] : [`${path}.${k}: required, missing`]) : problems(s, o[k], `${path}.${k}`))),
			];
		}
	}
}

/** A registered lane tool as the host holds it: its recorded parameters, its intent mode, its body. */
interface RegisteredTool {
	parameters: Desc;
	intent?: unknown;
	execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { text: string }[] }>;
}

/**
 * The installed OMP's host boundary (pi-agent-core/src/agent-loop.ts): `normalizeTools` injects INTENT_FIELD `i` into
 * every tool's schema unless the schema declares it, per `resolveIntentMode` ("require" by default, "optional",
 * "omit" for an intent function); the tool-call path strips it with `extractIntent` and refuses an intent longer than
 * MAX_INTENT_LENGTH (200) unless the schema owns `i`. What reaches `.execute` is the stripped input.
 */
function hostCall(tool: Pick<RegisteredTool, "parameters" | "intent">, input: Record<string, unknown>): { args: Record<string, unknown>; problems: string[] } {
	const params = tool.parameters;
	if (params.kind === "object" && Object.hasOwn(params.shape!, "i")) return { args: input, problems: problems(params, input, "input") };
	const mode = typeof tool.intent === "function" ? "omit" : tool.intent === "optional" || tool.intent === "omit" ? tool.intent : "require";
	const { i: intent, ...args } = input;
	const out: string[] = [];
	if (mode === "omit") {
		if (intent !== undefined) out.push("input.i: the host injects no intent field for this tool");
	} else if (intent === undefined) {
		if (mode === "require") out.push("input.i: the host's injected intent field is required, missing");
	} else if (typeof intent !== "string") out.push("input.i: not a string");
	else if (intent.trim().replace(/\s*\.+$/, "").trim().length > 200) out.push("input.i: longer than MAX_INTENT_LENGTH (200)");
	return { args, problems: [...out, ...problems(params, args, "input")] };
}

/** The host tools the stub lane calls: `task` in its plan, `wait` and `bash` from `laneTurn` while a hand runs. OMP's BUILTIN_TOOL_NAMES lists each. */
const HOST_TOOLS = ["task", "wait", "bash"];
/** What each ledger tool returns on success (surface/extensions/lane-tools.ts, gates/extensions/r07-wake-read.ts). */
const SUCCESS: Record<string, RegExp> = {
	ledger_wake_read: /^Recorded wake-read entry \S+ on /,
	lane_add_slice: /^Added slice \S+ to /,
	lane_complete_slice: /^Completed slice \S+ on /,
	lane_raise_question: /^Raised question \S+ on /,
};

describe("the stub lane's plan through the real tools", () => {
	test("every ledger step validates against the registered tool and succeeds; the ledger ends with the wake read, three slices and one open question", async () => {
		const { ledger, path } = tempLedger();
		ledger.openWorkload({ by: "chaos", id: WL, stakes: "normal", mode: "autonomous", brief: `chaos run ${TOKEN}: append one line, have another lab check it, then park on a question.` });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: WL, kind: "assumption", body: `launch: ${LANE} cause first requested-by chaos` });
		expect(ledger.claimWorkload(WL, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 60_000 }).won).toBe(true);
		const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: WL, AGENT_SYSTEM_LANE_ID: LANE, HOME: "/nonexistent-home" };
		const f = fakePi([...HOST_TOOLS, "read", "yield"]);
		Object.assign(f.pi, { zod: recordingZod });
		orchestratorSurface(f.pi, env, {});
		// The fake host serves both extension APIs: the gates extension takes the same object as its GatesAPI.
		const gatesHost = f.pi as unknown as GatesAPI;
		wakeReadRow(gatesHost, env);
		const ctx = ctxOf();
		const registered = new Set(f.registered());

		const ran: string[] = [];
		for (const step of PLAN) {
			if (!registered.has(step.tool)) {
				expect(HOST_TOOLS).toContain(step.tool);
				continue;
			}
			// fakePi keeps the whole registered tool object; its FakeTool type names only `execute`.
			const registeredTool = f.tool(step.tool);
			const tool = registeredTool as unknown as RegisteredTool;
			expect(typeof step.input.i).toBe("string"); // every scripted step carries the host's intent
			const call = hostCall(tool, step.input);
			expect({ tool: step.tool, problems: call.problems }).toEqual({ tool: step.tool, problems: [] });
			const text = (await tool.execute(`chaos-${ran.length}`, call.args, undefined, undefined, ctx)).content[0]!.text;
			expect({ tool: step.tool, text }).toMatchObject({ tool: step.tool, text: expect.stringMatching(SUCCESS[step.tool] ?? /^$/) });
			ran.push(step.tool);
		}
		expect(ran).toEqual(["ledger_wake_read", "lane_add_slice", "lane_complete_slice", "lane_add_slice", "lane_complete_slice", "lane_add_slice", "lane_raise_question"]);

		const after = Ledger.open(path, { backup: false, backupOnOpen: false });
		try {
			expect(after.entries(WL, "wake-read").map((e) => e.created_by)).toEqual([LANE]);
			const ids = PLAN.filter((s) => s.tool === "lane_add_slice").map((s) => s.input.id);
			expect(after.slices(WL).map((s) => [s.id, s.state])).toEqual([[ids[0], "done"], [ids[1], "done"], [ids[2], "paused"]]);
			expect(after.questions(WL).map((q) => [q.slice_id, q.state])).toEqual([[ids[2], "open"]]);
		} finally {
			after.close();
		}
	});

	test("a step outside the registered descriptor or without its intent fails the host boundary", () => {
		const params = CONSTRUCTORS.object({ slice: CONSTRUCTORS.string(), kind: CONSTRUCTORS.enum(["a", "b"]).optional() });
		expect(hostCall({ parameters: params }, { slice: "s", i: "Doing it" }).problems).toEqual([]);
		expect(hostCall({ parameters: params }, { slice: "s" }).problems).toEqual(["input.i: the host's injected intent field is required, missing"]);
		expect(hostCall({ parameters: params, intent: "optional" }, { slice: "s" }).problems).toEqual([]);
		expect(hostCall({ parameters: params, intent: "omit" }, { slice: "s", i: "x" }).problems).toEqual(["input.i: the host injects no intent field for this tool"]);
		expect(hostCall({ parameters: params }, { slice: "s", i: "x".repeat(201) }).problems).toEqual(["input.i: longer than MAX_INTENT_LENGTH (200)"]);
		expect(hostCall({ parameters: params }, { i: "x", kind: "c", extra: 1 }).problems).toEqual([
			"input.extra: not a parameter of the tool", "input.slice: required, missing", 'input.kind: "c" is not one of a, b',
		]);
		const zodAsHost: Record<string, () => unknown> = recordingZod as unknown as Record<string, () => unknown>; // as an extension reaches pi.zod
		expect(() => zodAsHost.number!()).toThrow(/no z\.number/);
	});

	test.skipIf(Bun.which("omp") === null)("the host tools it calls are OMP built-ins (the installed builtin-names.ts)", () => {
		const src = readFileSync(join(ompPackagesRoot(), "pi-coding-agent", "src", "tools", "builtin-names.ts"), "utf8");
		const m = /export const BUILTIN_TOOL_NAMES = \[([^\]]*)\]/.exec(src);
		expect(m).not.toBeNull();
		const builtins = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
		for (const name of HOST_TOOLS) expect(builtins).toContain(name);
	});
});

test("the stub's tier markers match the tier files' openings, and only their own", () => {
	expect(LANE_TIER_MARK.test(LANE_TIER)).toBe(true);
	expect(ORCHESTRATOR_TIER_MARK.test(ORCHESTRATOR_TIER)).toBe(true);
	expect(LANE_TIER_MARK.test(ORCHESTRATOR_TIER)).toBe(false);
	expect(ORCHESTRATOR_TIER_MARK.test(LANE_TIER)).toBe(false);
});
