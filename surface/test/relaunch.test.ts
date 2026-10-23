// The dead-lane relaunch's predicate (PLAN wl-mvfqvd5hy8zv28 § 1.1–1.4a, § 1.8; sl-rl-predicate): how the newest lane
// ended (`laneEnd`), the relaunch state and its counter (`relaunchState`, `nextRetry`, `progressAfter`), and the launch
// predicate's order over them (`verdictOf`). The matrix runs over plain rows with an injected clock; the backoff across a
// re-created surface and the rank gate run on a temp ledger, the rows `Ledger.launchRows` reads.
import { describe, expect, test } from "bun:test";
import {
	type EntryRow, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, type QuestionRow, type ReserveRows, type SliceRow, TEST_RUNNER_BY, type WorkloadRow,
} from "../../ledger/src/index";
import { INCIDENT_DETAIL_MAX, incidentBody, nextRetry, parseIncident, progressAfter, recordIncidentOnce, RELAUNCH_BACKOFF_MS, RETRY_LIMIT } from "../src/incident";
import {
	causeText, consumedIds, attempts, controlEntries, decideLaunch, holdersOf, laneDiedExitBody, laneExitBody, laneStartedBody, launchFailedBody, launchRequestedBody,
	laneStopAcceptedBody, laneStopRequestBody, prBindingInstructionBody, trainBoardBody, verdictOf,
} from "../src/launch";
import { briefHash, formatSignal, goalsHash, rankDay, type SignalAnswers } from "../src/rank";
import { pendingRequest, type RankConfig, rankGate } from "../src/rank-launch";
import { laneEnd, relaunchRead, relaunchState } from "../src/relaunch";
import type { PsRun } from "../src/omp-probe";
import { type ProbeFor, psProbe, runnerProbe } from "../src/runner-probe";
import { errorLines } from "../src/errors";
import { laneDeaths, recordLapsedLeases } from "../src/signals";
import { fullSuiteSlice, makeRunId, testRequestedBody } from "../src/test-run";
import { MERGE_TRAIN_BY, ORCHESTRATOR_RECIPIENT, RANK_BY, SURFACE_BY } from "../src/types";
import { triggerLaunch } from "../extensions/launch";
import { fakePi, tempLedger } from "./helpers";

const MIN = 60_000;
const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const WL = "wl-r";
const lane = (n: number) => `lane-r-${n}`;
/** The start time a `lane-started:` records for its omp (`started`). */
const OMP_START = "Mon Oct 19 09:59:00 2026";
/** The command line `lane.ts launch` starts lane `laneId`'s runner with on workload `wl`. */
const runnerCommand = (wl: string, laneId: string) => `bun /repo/surface/scripts/lane.ts run ${wl} ${laneId}`;

/** One process as `ps -p <pid> -o <fields>` reports it. */
interface FakeProc {
	stat?: string;
	lstart?: string;
	command?: string;
}
/**
 * A ps over a table of processes by pid (`procs()` is read at each call, so a test can change it): a listed pid answers its
 * fields in the order asked, any other pid is ps's clean "no such process" (exit 1, nothing printed); `"fail"` is a ps that
 * cannot be spawned (a throw, as `runPs` throws).
 */
function fakePs(procs: () => Record<number, FakeProc> | "fail"): PsRun {
	return (args) => {
		const table = procs();
		if (table === "fail") throw new Error("EPERM: posix_spawn '/bin/ps'");
		const p = table[Number(args[args.indexOf("-p") + 1])];
		if (p === undefined) return { exitCode: 1, stdout: "", stderr: "" };
		const fields = args[args.indexOf("-o") + 1]!.split(",").map((f) => f.replace(/=$/, ""));
		const value = (f: string) => (f === "stat" ? p.stat ?? "S" : f === "lstart" ? p.lstart ?? "" : p.command ?? "");
		return { exitCode: 0, stdout: `${fields.map(value).join(" ")}\n`, stderr: "" };
	};
}
/** The relaunch's probe (`runnerProbe`, the run guard's) over `fakePs(procs)`. */
const probeOver = (procs: () => Record<number, FakeProc> | "fail"): ProbeFor => (wl, laneId) => runnerProbe(wl, laneId, fakePs(procs));

/**
 * One workload's rows built in ledger order under a clock that moves one second per write unless told otherwise: the
 * rows `Ledger.launchRows` would read, with the holder, lease and `lane-died:` times the writers would leave.
 */
function world(over: Partial<WorkloadRow> = {}) {
	let t = T0;
	let seq = 0;
	const w = {
		id: WL, brief: "fix the thing", stakes: "normal", mode: "autonomous", status: "open", holder: null, holder_lease_until: null, closed_at: null,
		created_by: SURFACE_BY, created_at: iso(T0), changed_by: SURFACE_BY, changed_at: iso(T0), rev: 0, ...over,
	} as WorkloadRow;
	const entries: EntryRow[] = [];
	const slices: SliceRow[] = [];
	const questions: QuestionRow[] = [];
	const instructions: InstructionRow[] = [];
	const deaths: { laneId: string; createdAt: string }[] = [];
	const step = () => iso((t += 1000));
	const entry = (by: string, body: string, sliceId: string | null = null): EntryRow => {
		const e = { id: `en-${++seq}`, workload_id: WL, slice_id: sliceId, kind: "assumption", body, created_by: by, created_at: step() } as EntryRow;
		entries.push(e);
		return e;
	};
	const rows = (liveLanes = 0, cap = 3): ReserveRows => ({
		workload: { ...w }, entries: [...entries], questions: [...questions], instructions: [...instructions], slices: [...slices], holders: [],
		deaths: [...deaths], liveLanes, cap, now: iso(t),
	});
	const api = {
		w, entries, slices, deaths,
		now: () => iso(t),
		at: (ms: number) => {
			t = ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
		entry,
		/** `reserveLane`'s write: the attempt, and the pre-claim for its lane. */
		launch: (n: number, cause: string) => {
			const e = entry(LANE_STARTER_BY, `launch: ${lane(n)} cause ${cause} requested-by test`);
			w.holder = lane(n);
			w.holder_lease_until = iso(t + 3 * MIN);
			return e;
		},
		/** The holder's lease runs out with no exit: time moves past it, the holder stays. */
		lapse: () => {
			t = Math.max(t, Date.parse(w.holder_lease_until!) + 1000);
		},
		release: () => {
			w.holder = null;
			w.holder_lease_until = null;
		},
		/** The runner's end: release, then `lane-exit:`. */
		exit: (n: number, outcome: string, reason: string | null = null) => {
			api.release();
			return entry(LANE_RUNNER_BY, laneExitBody(lane(n), { code: 1, signal: null, outcome, reason }));
		},
		/** The `lane-died:` message naming the lane, at the clock's next second. */
		died: (n: number) => {
			deaths.push({ laneId: lane(n), createdAt: step() });
		},
		/** Lane n ends by an error exit, its `lane-died:` is written, and the backoff gap passes. */
		kill: (n: number) => {
			api.exit(n, "error");
			api.died(n);
			t += RELAUNCH_BACKOFF_MS;
		},
		/** A valid `artifact-tree:` by `by` on the first slice. */
		tree: (by: string, sha: string) => entry(by, `artifact-tree: ${JSON.stringify({ repo: "/r", tree: sha, command: "bun test x" })}`, slices[0]!.id),
		slice: (state: SliceRow["state"] = "open", over: Partial<SliceRow> = {}): SliceRow => {
			const at = step();
			const s = { id: `sl-${++seq}`, workload_id: WL, task: "t", done_condition: "d", inputs: "i", state, artifact: null, created_by: lane(1), created_at: at, changed_by: lane(1), changed_at: at, rev: 0, ...over } as SliceRow;
			slices.push(s);
			return s;
		},
		question: (by: string, sliceId: string, state: QuestionRow["state"] = "open", resolvedBy: string | null = null): QuestionRow => {
			const at = step();
			const q = { id: `q-${++seq}`, workload_id: WL, slice_id: sliceId, body: "which?", options: "[]", state, resolved_by: resolvedBy, created_by: by, created_at: at, changed_by: by, changed_at: at, rev: 0 } as QuestionRow;
			questions.push(q);
			return q;
		},
		instruction: (kind: InstructionRow["kind"], body: string, questionId: string | null = null): InstructionRow => {
			const i = { id: `in-${++seq}`, workload_id: WL, slice_id: null, kind, question_id: questionId, disposition: null, channel: "surface", author: "jo", body, created_by: SURFACE_BY, created_at: step() } as InstructionRow;
			instructions.push(i);
			return i;
		},
		/** Jo's `launch-requested:` (the surface's), or the train's (`MERGE_TRAIN_BY`). */
		request: (who: "jo" | "train" = "jo") =>
			who === "jo" ? entry(SURFACE_BY, launchRequestedBody("jo", iso(t))) : entry(MERGE_TRAIN_BY, launchRequestedBody(MERGE_TRAIN_BY, iso(t), "train task tt-1 owner")),
		/** `as2 lane stop`'s request (the starter writes it), and an acceptance naming `ref`. */
		stop: (n: number) => entry(LANE_STARTER_BY, laneStopRequestBody(lane(n), "as2-lane-stop", "jo")),
		accept: (n: number, ref: string) => entry(LANE_RUNNER_BY, laneStopAcceptedBody(lane(n), ref)),
		/** The runner's `lane-started:` for lane n, naming its own pid `runnerPid` and its omp `runnerPid + 1` started at `OMP_START`. */
		started: (n: number, runnerPid: number) => entry(LANE_RUNNER_BY, laneStartedBody(lane(n), { pid: runnerPid + 1, start: OMP_START, session: null, argv: [], runnerPid })),
		rows,
		verdict: (liveLanes = 0, cap = 3, probeFor: ProbeFor = psProbe) => verdictOf(rows(liveLanes, cap), probeFor),
		state: (probeFor: ProbeFor = psProbe) => relaunchState(rows(), probeFor),
		end: (n: number, probeFor: ProbeFor = psProbe) => {
			const r = rows();
			return laneEnd(r.workload, controlEntries(r.entries, holdersOf(r.entries, r.workload.holder)), lane(n), r.now, probeFor);
		},
	};
	return api;
}

/** The common start: one open slice cut before the first launch, lane 1 launched; the caller ends it. */
function launched(over: Partial<WorkloadRow> = {}) {
	const x = world(over);
	x.slice("open");
	x.launch(1, "first");
	return x;
}
/** Lane 1 died by an error exit with its `lane-died:` recorded. */
function deadOnce() {
	const x = launched();
	x.exit(1, "error");
	x.died(1);
	return x;
}

// ---- § 1.1 laneEnd -------------------------------------------------------------------------------------------------

describe("laneEnd (§ 1.1): every class, in its order", () => {
	test("live while any holder's lease is live, whatever else was written", () => {
		const x = launched();
		x.exit(1, "error");
		x.w.holder = "jo";
		expect(x.end(1)).toEqual({ kind: "live" });
		const y = launched();
		expect(y.end(1)).toEqual({ kind: "live" });
	});

	test("died: launch-failed, each unintended lane-exit outcome, a signal stop, an accepted signal, a lapsed holder, an unheld workload", () => {
		for (const outcome of ["deadline", "aborted", "error", "open-work", "died", "never-ready"]) {
			const x = launched();
			x.exit(1, outcome);
			expect([outcome, x.end(1)]).toEqual([outcome, { kind: "died" }]);
		}
		const failed = launched();
		failed.entry(LANE_STARTER_BY, launchFailedBody(lane(1), "preflight", "no omp"));
		failed.release();
		expect(failed.end(1)).toEqual({ kind: "died" });
		const signal = launched();
		signal.accept(1, "signal");
		signal.exit(1, "stop", "signal");
		expect(signal.end(1)).toEqual({ kind: "died" });
		// a restart stop whose runner never wrote its exit: dead once the lease is not live, live before
		const restart = launched();
		restart.accept(1, "signal");
		expect(restart.end(1)).toEqual({ kind: "live" });
		restart.lapse();
		expect(restart.end(1)).toEqual({ kind: "died" });
		const lapsed = launched();
		lapsed.lapse();
		expect(lapsed.end(1)).toEqual({ kind: "died" });
		const unheld = launched();
		unheld.release();
		expect(unheld.end(1)).toEqual({ kind: "died" });
	});

	test("intended: a park, an intended decision, a stop accepted against a request that is not Jo's, each intended exit outcome", () => {
		const parked = launched();
		parked.entry(LANE_RUNNER_BY, `lane-parked: ${lane(1)} questions q-1 session /s`);
		parked.release();
		expect(parked.end(1)).toEqual({ kind: "intended" });
		const decided = launched();
		decided.entry(LANE_RUNNER_BY, `lane-decided: ${lane(1)} completed`);
		decided.lapse();
		expect(decided.end(1)).toEqual({ kind: "intended" });
		const byHand = launched();
		const req = byHand.entry(LANE_STARTER_BY, laneStopRequestBody(lane(1), "by-hand", "orchestrator"));
		byHand.accept(1, req.id);
		byHand.release();
		expect(byHand.end(1)).toEqual({ kind: "intended" });
		for (const [outcome, reason] of [["completed", null], ["parked", null], ["resume-pending", null], ["released", null], ["stop", "by-hand"], ["interactive", null]] as const) {
			const x = launched();
			x.exit(1, outcome, reason);
			expect([outcome, x.end(1)]).toEqual([outcome, { kind: "intended" }]);
		}
	});

	test("stopped (the veto) wins over every death: Jo's request accepted or not, before or after the exit, and the ceiling's acceptance", () => {
		const before = launched();
		const req = before.stop(1);
		before.exit(1, "error");
		expect(before.end(1)).toEqual({ kind: "stopped", entryId: req.id, createdAt: req.created_at });
		const after = deadOnce();
		const late = after.stop(1);
		expect(after.end(1)).toEqual({ kind: "stopped", entryId: late.id, createdAt: late.created_at });
		const ceiling = launched();
		const acc = ceiling.accept(1, "ceiling");
		ceiling.exit(1, "stop", "ceiling");
		expect(ceiling.end(1)).toEqual({ kind: "stopped", entryId: acc.id, createdAt: acc.created_at });
	});
});

// ---- § 1.3, § 1.4 relaunchState and the predicate ------------------------------------------------------------------

describe("relaunch due (§ 1.3): a died lane with an open slice, no open question, its death recorded", () => {
	test("relaunch 1 at once, naming the dead lane; its launch: entry round-trips and is the counter as written", () => {
		const x = deadOnce();
		expect(x.state()).toEqual({ kind: "due", lane: lane(1), n: 1 });
		const v = x.verdict();
		expect(v).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(1), n: 1 } });
		expect(decideLaunch(x.rows())).toEqual({ launch: true, cause: `relaunch ${lane(1)} 1` });
		x.launch(2, `relaunch ${lane(1)} 1`);
		const c = controlEntries(x.entries, holdersOf(x.entries, null));
		expect(attempts(c).at(-1)!.cause).toEqual({ kind: "relaunch", lane: lane(1), n: 1 });
		// the relaunched lane holds the workload now
		expect(x.verdict()).toEqual({ launch: false, reason: "held" });
	});

	test("not relaunched: paused-only slices, an open question, a receipt, user-driven, closed", () => {
		const paused = world();
		paused.slice("paused");
		paused.launch(1, "first");
		paused.exit(1, "error");
		paused.died(1);
		expect(paused.state()).toEqual({ kind: "none" });
		expect(paused.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });

		const asked = launched();
		asked.question(lane(1), asked.slices[0]!.id, "open");
		asked.exit(1, "error");
		asked.died(1);
		expect(asked.state()).toEqual({ kind: "none" });
		expect(asked.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });

		const done = launched();
		done.entry(lane(1), "done-because: the work is done");
		done.exit(1, "error");
		done.died(1);
		expect(done.state()).toEqual({ kind: "none" });
		expect(done.verdict()).toEqual({ launch: false, reason: "awaiting-close" });

		const byHand = deadOnce();
		byHand.w.mode = "user-driven";
		expect(byHand.state()).toEqual({ kind: "none" });
		expect(byHand.verdict()).toEqual({ launch: false, reason: "user-driven" });
		byHand.w.mode = "autonomous";
		byHand.w.status = "closed";
		expect(byHand.verdict()).toEqual({ launch: false, reason: "closed" });
	});

	test("parked and finished lanes are not relaunched", () => {
		const parked = launched();
		parked.entry(LANE_RUNNER_BY, `lane-parked: ${lane(1)} questions q-1 session /s`);
		parked.exit(1, "parked");
		expect(parked.state()).toEqual({ kind: "none" });
		expect(parked.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		const released = launched();
		released.exit(1, "released");
		expect(released.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
	});

	test("unrecorded (§ 1.4a): a lapse no lane-died: names is never relaunched, by the tick, a drain or a train request; Jo's word still launches", () => {
		const x = launched();
		x.lapse();
		expect(x.state()).toEqual({ kind: "unrecorded", lane: lane(1), n: 1 });
		expect(x.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		x.request("train");
		expect(x.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		x.died(1);
		const train = x.entries.find((e) => e.created_by === MERGE_TRAIN_BY)!;
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(1), n: 1, request: train.id } });
		const jo = launched();
		jo.lapse();
		const req = jo.request("jo");
		expect(jo.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});

	test("the cap refuses a due relaunch; a full cap never hides exhaustion (review r1 F4)", () => {
		const x = deadOnce();
		expect(x.verdict(3, 3)).toEqual({ launch: false, reason: "cap" });
	});
});

describe("a lapsed lease whose lane is still running is not a death (review r1 M2, r2 R2-3, R2-4)", () => {
	const RUNNER = 4242;
	const OMP = RUNNER + 1;
	const runnerAlive = probeOver(() => ({ [RUNNER]: { command: runnerCommand(WL, lane(1)) } }));
	const runnerGone = probeOver(() => ({}));
	/** Lane 1 with its runner's lane-started:, its lease lapsed and the surface's lane-died: for the lapse recorded. */
	function lapsed() {
		const x = launched();
		x.started(1, RUNNER);
		x.lapse();
		x.died(1);
		return x;
	}

	test("the runner alive: live, state none, no relaunch and no train request launches (held); Jo's word still does", () => {
		const x = lapsed();
		expect(x.end(1, runnerAlive)).toEqual({ kind: "live" });
		expect(x.state(runnerAlive)).toEqual({ kind: "none" });
		expect(x.verdict(0, 3, runnerAlive)).toEqual({ launch: false, reason: "held" });
		x.request("train");
		expect(x.verdict(0, 3, runnerAlive)).toEqual({ launch: false, reason: "held" });
		const req = x.request("jo");
		expect(x.verdict(0, 3, runnerAlive)).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});

	test("the runner gone: the lapse is a death and relaunches as before", () => {
		const x = lapsed();
		expect(x.end(1, runnerGone)).toEqual({ kind: "died" });
		expect(x.verdict(0, 3, runnerGone)).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(1), n: 1 } });
	});

	test("R2-4: the recorded pids are identified, not merely alive: another user's process (EPERM), a reused pid or a zombie is not this lane's runner", () => {
		const dead = { kind: "died" } as const;
		const relaunch = { launch: true, cause: { kind: "relaunch", lane: lane(1), n: 1 } } as const;
		const cases: Record<string, Record<number, FakeProc>> = {
			// process.kill(pid, 0) answers EPERM for a process of another user; ps still names it, and it is not `lane.ts run`
			"another user's process": { [RUNNER]: { command: "/sbin/launchd" } },
			// both pids now name other processes: the runner's another command, the omp's another start time
			"a reused pid": { [RUNNER]: { command: runnerCommand("wl-other", "lane-other-1") }, [OMP]: { lstart: "Mon Oct 19 11:30:00 2026", command: "omp" } },
			"a zombie": { [RUNNER]: { stat: "Z", command: "<defunct>" }, [OMP]: { stat: "Z", lstart: OMP_START, command: "<defunct>" } },
		};
		for (const [name, table] of Object.entries(cases)) {
			const x = lapsed();
			const probe = probeOver(() => table);
			expect({ name, end: x.end(1, probe) }).toEqual({ name, end: dead });
			expect({ name, verdict: x.verdict(0, 3, probe) }).toEqual({ name, verdict: relaunch });
		}
	});

	test("R2-4: the omp alive at its recorded start time is the lane running, the runner gone or not; a ps that cannot answer is never permission to relaunch", () => {
		for (const table of [{ [OMP]: { lstart: OMP_START, command: "omp" } }, "fail" as const]) {
			const x = lapsed();
			const probe = probeOver(() => table);
			expect(x.end(1, probe)).toEqual({ kind: "live" });
			expect(x.verdict(0, 3, probe)).toEqual({ launch: false, reason: "held" });
		}
	});

	test("reserveLane on a real ledger: no successor is reserved over a live runner, one is once it is gone", () => {
		let t = T0;
		const { ledger: l } = tempLedger(() => iso(t));
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "fix it", stakes: "normal", mode: "autonomous" });
		let procs: Record<number, FakeProc> = {};
		const probe = probeOver(() => procs);
		const reserve = () => l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 3 * MIN, requestedBy: "tick", decide: (r) => decideLaunch(r, probe) });
		const first = reserve();
		if (!first.ok) throw new Error(first.reason);
		procs = { [RUNNER]: { command: runnerCommand(wl, first.laneId) } };
		t += 1000;
		l.addSlice({ by: first.laneId, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(first.laneId, { pid: OMP, start: OMP_START, session: null, argv: [], runnerPid: RUNNER }) });
		l.enqueue({ by: SURFACE_BY, workloadId: wl, sender: SURFACE_BY, recipient: ORCHESTRATOR_RECIPIENT, body: `lane-died: ${first.laneId}: lease lapsed` });
		t += 10 * MIN;
		expect(reserve()).toEqual({ ok: false, reason: "held" });
		expect(l.workload(wl)!.holder).toBe(first.laneId);
		procs = {};
		expect(reserve()).toMatchObject({ ok: true, cause: `relaunch ${first.laneId} 1` });
		l.close();
	});

	test("R2-3: a lapse whose runner is running writes no lane-died: and shows no death line; once the runner is gone, the message and the line as before", () => {
		let t = T0;
		const { ledger: l } = tempLedger(() => iso(t));
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "fix it", stakes: "normal", mode: "autonomous" });
		let procs: Record<number, FakeProc> = {};
		const probe = probeOver(() => procs);
		const first = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 3 * MIN, requestedBy: "tick", decide: (r) => decideLaunch(r, probe) });
		if (!first.ok) throw new Error(first.reason);
		procs = { [RUNNER]: { command: runnerCommand(wl, first.laneId) } };
		t += 1000;
		l.addSlice({ by: first.laneId, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(first.laneId, { pid: OMP, start: OMP_START, session: null, argv: [], runnerPid: RUNNER }) });
		t += 20 * MIN;
		const now = iso(t);
		const deathLines = () => errorLines(l, l.inFlight(), { now, probeFor: probe }).filter((x) => x.kind === "lane-died" && x.workloadId === wl).map((x) => x.line);
		expect(deathLines()).toEqual([]);
		expect(recordLapsedLeases(l, SURFACE_BY, now, probe)).toEqual([]);
		expect(laneDeaths(l, wl)).toEqual([]);
		procs = {};
		const lapsedAt = l.workload(wl)!.holder_lease_until;
		expect(deathLines()).toEqual([`lane ${first.laneId} on ${wl} died: lease lapsed ${lapsedAt}, 1 open slice(s)`]);
		expect(recordLapsedLeases(l, SURFACE_BY, now, probe)).toHaveLength(1);
		expect(laneDeaths(l, wl).map((d) => d.body)).toEqual([`lane-died: ${first.laneId}: lease lapsed ${lapsedAt}`]);
		l.close();
	});
});

describe("Jo's stop vetoes every cause until Jo's word newer than the stop (review r1 F1, r2 F1)", () => {
	test("r1 F1: Jo's stop after a death, before the tick", () => {
		const x = deadOnce();
		x.stop(1);
		expect(x.verdict()).toEqual({ launch: false, reason: "stopped" });
	});
	test("r1 F1: a pending Jo stop, then a death", () => {
		const x = launched();
		x.stop(1);
		x.exit(1, "error");
		x.died(1);
		expect(x.verdict()).toEqual({ launch: false, reason: "stopped" });
	});
	test("r1 F1: an accepted Jo stop after a decided error, and after a launch failure", () => {
		const decided = deadOnce();
		const req = decided.stop(1);
		decided.accept(1, req.id);
		expect(decided.verdict()).toEqual({ launch: false, reason: "stopped" });
		const failed = launched();
		failed.entry(LANE_STARTER_BY, launchFailedBody(lane(1), "preflight", "no omp"));
		failed.release();
		failed.died(1);
		const r2 = failed.stop(1);
		failed.accept(1, r2.id);
		expect(failed.verdict()).toEqual({ launch: false, reason: "stopped" });
	});
	test("r2 F1: a stop with a pending train request; a Jo request older than the stop; an answer older than the stop", () => {
		const train = deadOnce();
		train.request("train");
		train.stop(1);
		expect(train.verdict()).toEqual({ launch: false, reason: "stopped" });
		train.request("train");
		expect(train.verdict()).toEqual({ launch: false, reason: "stopped" });

		const older = deadOnce();
		older.request("jo");
		older.stop(1);
		expect(older.verdict()).toEqual({ launch: false, reason: "stopped" });

		const answered = launched();
		const q = answered.question(lane(1), answered.slices[0]!.id, "answered");
		const ans = answered.instruction("answer", "yes", q.id);
		q.resolved_by = ans.id;
		answered.exit(1, "error");
		answered.died(1);
		answered.stop(1);
		expect(answered.verdict()).toEqual({ launch: false, reason: "stopped" });
		// an answer created after the stop resumes
		const q2 = answered.question(lane(1), answered.slices[0]!.id, "answered");
		const ans2 = answered.instruction("answer", "go", q2.id);
		q2.resolved_by = ans2.id;
		expect(answered.verdict()).toEqual({ launch: true, cause: { kind: "resume", ids: [ans2.id] } });
	});
	test("r2 F1, r1 m1: a Jo request newer than the stop launches as Jo's request; the older one is answered by the stop; the ceiling's stop and Jo's extend alike", () => {
		const x = deadOnce();
		const older = x.request("jo");
		x.stop(1);
		const newer = x.request("jo");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: newer.id } });
		// the review's probe: the newer request's lane dies, then its relaunch's lane dies; the older request never launches
		x.launch(2, `request ${newer.id}`);
		x.exit(2, "error");
		x.died(2);
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(2), n: 1 } });
		x.launch(3, `relaunch ${lane(2)} 1`);
		x.exit(3, "error");
		x.died(3);
		expect(x.verdict()).toEqual({ launch: false, reason: "relaunch-backoff" });
		x.advance(RELAUNCH_BACKOFF_MS);
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(3), n: 2 } });
		expect(consumedIds(attempts(controlEntries(x.entries, holdersOf(x.entries, null)))).has(older.id)).toBe(false);
		const ceiling = launched();
		ceiling.request("jo");
		ceiling.accept(1, "ceiling");
		ceiling.exit(1, "stop", "ceiling");
		expect(ceiling.verdict()).toEqual({ launch: false, reason: "stopped" });
		const extend = ceiling.entry(SURFACE_BY, launchRequestedBody("jo", ceiling.now(), "ceiling extend"));
		expect(ceiling.verdict()).toEqual({ launch: true, cause: { kind: "request", id: extend.id } });
		ceiling.launch(2, `request ${extend.id}`);
		ceiling.exit(2, "error");
		ceiling.died(2);
		expect(ceiling.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(2), n: 1 } });
	});
	test("r1 m1: an old Jo request behind a stop does not keep a finished workload from awaiting close", () => {
		const x = deadOnce();
		x.request("jo");
		x.stop(1);
		const newer = x.request("jo");
		x.launch(2, `request ${newer.id}`);
		x.entry(lane(2), "done-because: the work is done");
		x.exit(2, "completed");
		expect(x.verdict()).toEqual({ launch: false, reason: "awaiting-close" });
	});
	test("r2 R2-1: a Jo request voided by a stop is pending nowhere: the rank gate's pending request skips it, and the train's own request launches", () => {
		// the review's probe: a Jo request, Jo's stop of lane 1, a newer Jo request, lane 2 launched on it, lane 2 parks
		const x = launched();
		const older = x.request("jo");
		const req = x.stop(1);
		x.accept(1, req.id);
		x.exit(1, "stop");
		const newer = x.request("jo");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: newer.id } });
		x.launch(2, `request ${newer.id}`);
		x.exit(2, "parked");
		const control = controlEntries(x.entries, holdersOf(x.entries, null));
		expect(consumedIds(attempts(control)).has(older.id)).toBe(false);
		expect(pendingRequest(x.rows())).toBeNull();
		expect(x.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		// the train, seeing nothing pending, writes its own request: it is the pending one, and it launches as a request
		const train = x.request("train");
		expect(pendingRequest(x.rows())).toBe(train.id);
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: train.id } });
	});
	test("r2 R2-2: an answer older than a stop on an older lane is answered by that stop, as a Jo request is: the later lane's death relaunches it", () => {
		// the review's probe: lane 1's question answered, lane 1 dies, Jo stops lane 1, a newer Jo request launches lane 2, lane 2 dies
		const x = launched();
		const q = x.question(lane(1), x.slices[0]!.id, "answered");
		const ans = x.instruction("answer", "yes", q.id);
		q.resolved_by = ans.id;
		x.exit(1, "error");
		x.died(1);
		x.stop(1);
		const newer = x.request("jo");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: newer.id } });
		x.launch(2, `request ${newer.id}`);
		x.exit(2, "error");
		x.died(2);
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(2), n: 1 } });
		expect(decideLaunch(x.rows())).toEqual({ launch: true, cause: `relaunch ${lane(2)} 1` });
	});
});

// ---- § 1.4 the counter ---------------------------------------------------------------------------------------------

describe("the counter (§ 1.4): each relaunch carries its own n; exhausted past RETRY_LIMIT", () => {
	test("r2 F2: three successive reservations whose lanes each die only by lease lapse reach exhausted at the fourth death, whatever the cap", () => {
		const x = launched();
		x.lapse();
		x.died(1);
		expect(x.state()).toEqual({ kind: "due", lane: lane(1), n: 1 });
		for (let n = 1; n <= RETRY_LIMIT; n++) {
			const v = x.verdict();
			expect(v).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(n), n } });
			x.launch(n + 1, `relaunch ${lane(n)} ${n}`);
			// the relaunched lane dies by lapse too, still the holder
			x.lapse();
			x.died(n + 1);
			expect(x.w.holder).toBe(lane(n + 1));
			x.advance(RELAUNCH_BACKOFF_MS);
		}
		expect(x.state()).toEqual({ kind: "exhausted", lane: lane(RETRY_LIMIT + 1), n: RETRY_LIMIT + 1 });
		expect(x.verdict()).toEqual({ launch: false, reason: "relaunch-exhausted" });
		expect(x.verdict(3, 3)).toEqual({ launch: false, reason: "relaunch-exhausted" });
		// Jo's word starts a new episode: it launches, and the next death counts from 1
		const req = x.request("jo");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
		x.launch(RETRY_LIMIT + 2, `request ${req.id}`);
		x.exit(RETRY_LIMIT + 2, "error");
		x.died(RETRY_LIMIT + 2);
		expect(x.state()).toEqual({ kind: "due", lane: lane(RETRY_LIMIT + 2), n: 1 });
	});

	test("a train request on a dead lane is folded into the relaunch and consumed by it, inside the budget; past it, refused relaunch-exhausted", () => {
		const x = deadOnce();
		const train = x.request("train");
		const v = x.verdict();
		expect(v).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(1), n: 1, request: train.id } });
		if (!v.launch) throw new Error(v.reason);
		expect(causeText(v.cause)).toBe(`relaunch ${lane(1)} 1 ${train.id}`);
		x.launch(2, `relaunch ${lane(1)} 1 ${train.id}`);
		expect(consumedIds(attempts(controlEntries(x.entries, holdersOf(x.entries, null)))).has(train.id)).toBe(true);
		x.exit(2, "error");
		x.died(2);
		x.advance(RELAUNCH_BACKOFF_MS);
		// the train's request did not reset the count: this is relaunch 2
		expect(x.state()).toEqual({ kind: "due", lane: lane(2), n: 2 });
		x.launch(3, `relaunch ${lane(2)} 2`);
		x.exit(3, "error");
		x.died(3);
		x.advance(RELAUNCH_BACKOFF_MS);
		x.launch(4, `relaunch ${lane(3)} 3`);
		x.exit(4, "error");
		x.died(4);
		x.request("train");
		expect(x.state()).toMatchObject({ kind: "exhausted", n: 4 });
		expect(x.verdict()).toEqual({ launch: false, reason: "relaunch-exhausted" });
	});
});

describe("progress resets the counter (§ 1.4, review r1 F2, F6)", () => {
	/** Lane 2 is relaunch 1 of lane 1 and died with no progress yet: the next relaunch would be n 2. */
	function second() {
		const x = deadOnce();
		const a = x.launch(2, `relaunch ${lane(1)} 1`);
		return { x, a };
	}

	test("no progress: n 2", () => {
		const { x } = second();
		x.kill(2);
		expect(x.state()).toMatchObject({ kind: "due", n: 2 });
	});
	test("the same tree twice is not progress; a tree no earlier artifact-tree: names is", () => {
		const fresh = second();
		fresh.x.tree(lane(2), "a".repeat(40));
		fresh.x.kill(2);
		expect(fresh.x.state()).toMatchObject({ kind: "due", n: 1 });
		// "a" seen before lane 2's attempt, then "a" again after it: not progress
		const same = deadOnce();
		same.tree(lane(1), "a".repeat(40));
		same.launch(2, `relaunch ${lane(1)} 1`);
		same.tree(lane(2), "a".repeat(40));
		same.kill(2);
		expect(same.state()).toMatchObject({ kind: "due", n: 2 });
		same.tree(lane(2), "b".repeat(40));
		expect(same.state()).toMatchObject({ kind: "due", n: 1 });
	});
	test("an artifact-tree: by a non-holder, a test request (the runner's full-suite slice and its test-requested:) and a train request are not progress", () => {
		const { x } = second();
		x.tree("hand-x", "c".repeat(40));
		// `lane_full_test` with no slice, as test-runner.ts's start writes it: the runner adds fullSuiteSlice's slice, then test-requested: on it
		const sha = "d".repeat(40);
		const f = fullSuiteSlice(WL, 7, x.slices.map((s) => s.id));
		const full = x.slice("open", { id: f.id, task: f.task, done_condition: f.doneCondition, inputs: `PR #7 at ${sha}`, created_by: TEST_RUNNER_BY, changed_by: TEST_RUNNER_BY });
		x.entry(TEST_RUNNER_BY, testRequestedBody({ runId: makeRunId(Date.parse(x.now()), "abcd"), pr: 7, sha, slice: full.id, by: lane(2) }), full.id);
		x.request("train");
		x.kill(2);
		expect(x.state()).toMatchObject({ kind: "due", n: 2 });
		// the runner completing it on a green is not the lane's progress either
		full.state = "done";
		full.changed_at = x.now();
		expect(x.state()).toMatchObject({ kind: "due", n: 2 });
		// a slice of the same id shape that the lane itself added is
		const own = second();
		own.x.slice("open", { id: fullSuiteSlice(WL, 7, own.x.slices.map((s) => s.id)).id });
		own.x.kill(2);
		expect(own.x.state()).toMatchObject({ kind: "due", n: 1 });
	});
	test("a slice created at the attempt's own millisecond is before it; one millisecond later is progress", () => {
		const { x, a } = second();
		x.slice("open", { created_at: a.created_at, changed_at: a.created_at });
		x.kill(2);
		expect(x.state()).toMatchObject({ kind: "due", n: 2 });
		const later = second();
		const t = iso(Date.parse(later.a.created_at) + 1);
		later.x.slice("open", { created_at: t, changed_at: t });
		later.x.kill(2);
		expect(later.x.state()).toMatchObject({ kind: "due", n: 1 });
	});
	test("a slice done after the attempt, and a question created after it, are progress", () => {
		const { x } = second();
		x.slices[0]!.state = "done";
		x.slices[0]!.changed_at = iso(Date.parse(x.now()) + 1);
		x.slice("open", { created_at: x.slices[0]!.created_at, changed_at: x.slices[0]!.created_at });
		x.kill(2);
		expect(x.state()).toMatchObject({ kind: "due", n: 1 });
		const asked = second();
		asked.x.question(lane(2), asked.x.slices[0]!.id, "withdrawn");
		asked.x.kill(2);
		expect(asked.x.state()).toMatchObject({ kind: "due", n: 1 });
	});
	test("progressAfter: a holder's done-because: after the attempt is progress, one before it or by a non-holder is not", () => {
		const x = deadOnce();
		x.entry(lane(1), "done-because: early");
		const a = x.launch(2, `relaunch ${lane(1)} 1`);
		x.entry("hand-y", "done-because: forged");
		const read = () => {
			const holders = holdersOf(x.entries, null);
			return { entries: x.entries, control: controlEntries(x.entries, holders), holders, slices: x.slices, questions: [] };
		};
		expect(progressAfter(read(), { entryId: a.id, createdAt: a.created_at })).toBe(false);
		x.entry(lane(2), "done-because: now");
		expect(progressAfter(read(), { entryId: a.id, createdAt: a.created_at })).toBe(true);
	});
	test("nextRetry is generic: no attempt or no own n is 1; progress is 1; otherwise own n + 1", () => {
		expect(nextRetry(null, () => 5, () => false)).toBe(1);
		expect(nextRetry({ n: null }, (a) => a.n, () => false)).toBe(1);
		expect(nextRetry({ n: 2 }, (a) => a.n, () => true)).toBe(1);
		expect(nextRetry({ n: 2 }, (a) => a.n, () => false)).toBe(3);
	});
});

// ---- § 1.4a backoff ------------------------------------------------------------------------------------------------

describe("backoff (§ 1.4a): relaunch 1 at once, 2 and 3 wait RELAUNCH_BACKOFF_MS after the replaced lane's lane-died: time", () => {
	test("pure rows: a second death 3 min after the first relaunch waits until 10 min after its lane-died:, then is due; Jo's word inside the gap launches at once", () => {
		const x = deadOnce();
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(1), n: 1 } });
		x.launch(2, `relaunch ${lane(1)} 1`);
		x.advance(3 * MIN);
		x.exit(2, "error");
		x.died(2);
		const deathAt = Date.parse(x.deaths.at(-1)!.createdAt);
		const until = iso(deathAt + RELAUNCH_BACKOFF_MS);
		expect(x.state()).toEqual({ kind: "waiting", lane: lane(2), n: 2, until });
		expect(x.verdict()).toEqual({ launch: false, reason: "relaunch-backoff" });
		x.at(deathAt + RELAUNCH_BACKOFF_MS - 1);
		expect(x.verdict()).toEqual({ launch: false, reason: "relaunch-backoff" });
		// a train request waits with it
		const train = x.request("train");
		x.at(deathAt + RELAUNCH_BACKOFF_MS - 1);
		expect(x.verdict()).toEqual({ launch: false, reason: "relaunch-backoff" });
		x.at(deathAt + RELAUNCH_BACKOFF_MS);
		expect(x.state()).toEqual({ kind: "due", lane: lane(2), n: 2 });
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(2), n: 2, request: train.id } });
		// Jo's word is never held by the backoff
		x.at(deathAt + MIN);
		const req = x.request("jo");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});

	test("a real ledger, the surface re-created between reads: the gap runs from the lane-died: row, not from any process's memory", async () => {
		let t = T0;
		const clock = () => iso(t);
		const { ledger, path } = tempLedger(clock);
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "fix it", stakes: "normal", mode: "autonomous" });
		const reserve = (l: Ledger) => l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 3 * MIN, requestedBy: "tick", decide: decideLaunch });
		const die = (l: Ledger, laneId: string) => {
			l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody(laneId, { code: 1, signal: null, outcome: "error" }) });
			l.enqueue({ by: LANE_RUNNER_BY, workloadId: wl, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedExitBody(laneId, "error", 1, null) });
			l.releaseWorkload(wl, { by: LANE_RUNNER_BY, holder: laneId });
		};
		const first = reserve(ledger);
		if (!first.ok) throw new Error(first.reason);
		t += 1000;
		ledger.addSlice({ by: first.laneId, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		t += 1000;
		die(ledger, first.laneId);
		t += 1000;
		const second = reserve(ledger);
		expect(second).toMatchObject({ ok: true, cause: `relaunch ${first.laneId} 1` });
		if (!second.ok) throw new Error(second.reason);
		t += 3 * MIN;
		die(ledger, second.laneId);
		const deathAt = t;
		ledger.close();
		// a new surface process: a fresh handle, a clock that starts later; the death time is the row's
		t = deathAt + 5 * MIN;
		const again = Ledger.open(path, { backup: false, backupOnOpen: false, clock });
		expect(verdictOf(again.launchRows(wl, 3)!)).toEqual({ launch: false, reason: "relaunch-backoff" });
		expect(reserve(again)).toEqual({ ok: false, reason: "relaunch-backoff" });
		// the open and tick line: no starter run, the wait named
		const f = fakePi(undefined, { exec: true });
		expect(await triggerLaunch(f.pi, again, { HOME: "/nonexistent-home" }, wl, "tick")).toEqual({
			attempted: false, code: null, line: `${wl}: its lane died; relaunch 2 of ${second.laneId} waits until ${iso(deathAt + RELAUNCH_BACKOFF_MS)}, then the tick relaunches it`,
		});
		expect(f.execs.calls).toEqual([]);
		again.close();
		t = deathAt + RELAUNCH_BACKOFF_MS;
		const later = Ledger.open(path, { backup: false, backupOnOpen: false, clock });
		expect(reserve(later)).toMatchObject({ ok: true, cause: `relaunch ${second.laneId} 2` });
		later.close();
	});
});

// ---- the rank gate ---------------------------------------------------------------------------------------------------

describe("the rank gate (§ 1.3): a waiting workload holds no place in the order", () => {
	const ORDER: RankConfig = { mode: "order", parallelBudgetUsd: 0 };
	const answers = (unblocks: number): SignalAnswers => ({
		unblocks_jo: { type: "bool", bool: unblocks }, cuts_spend: { type: "bool", bool: 0.1 }, fixes_breakage: { type: "bool", bool: 0.1 },
		states_deadline: { type: "bool", bool: 0.05 }, irreversible: { type: "bool", bool: 0.05 }, deadline_when: { type: "choice", choice: "none", confidence: 0.9 },
		builds_enforcer: { type: "bool", bool: 0.1 },
	});
	test("a higher-ranked workload in its backoff gap does not block a lower-ranked launchable one", () => {
		let t = T0;
		const { ledger: l } = tempLedger(() => iso(t));
		const open = (brief: string, unblocks: number) => {
			const wl = l.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
			l.recordEntry({
				by: RANK_BY, workloadId: wl, kind: "assumption",
				body: formatSignal({ brief: briefHash(brief), goals: goalsHash([]), askedOn: rankDay(l.now()), judge: "typesafe/jev-1.13.0", tokens: 1, cost: 0, answers: answers(unblocks) }),
			});
			return wl;
		};
		const hi = open("hi: dead, in its gap", 0.9);
		const lo = open("lo: never launched", 0.1);
		const reserve = (wl: string) => l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 3 * MIN, requestedBy: "tick", decide: decideLaunch });
		const die = (laneId: string) => {
			l.recordEntry({ by: LANE_RUNNER_BY, workloadId: hi, kind: "assumption", body: laneExitBody(laneId, { code: 1, signal: null, outcome: "error" }) });
			l.enqueue({ by: LANE_RUNNER_BY, workloadId: hi, sender: LANE_RUNNER_BY, recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedExitBody(laneId, "error", 1, null) });
			l.releaseWorkload(hi, { by: LANE_RUNNER_BY, holder: laneId });
		};
		const a = reserve(hi);
		if (!a.ok) throw new Error(a.reason);
		t += 1000;
		l.addSlice({ by: a.laneId, workloadId: hi, task: "t", doneCondition: "d", inputs: "i" });
		t += 1000;
		die(a.laneId);
		t += 1000;
		// while hi's relaunch 1 is due, lo is ranked below it
		expect(rankGate(l, l.launchRows(lo, 3)!, ORDER)).toEqual({ launch: false, reason: `ranked: below ${hi}` });
		const b = reserve(hi);
		if (!b.ok) throw new Error(b.reason);
		t += 3 * MIN;
		die(b.laneId);
		t += MIN;
		expect(verdictOf(l.launchRows(hi, 3)!)).toEqual({ launch: false, reason: "relaunch-backoff" });
		expect(rankGate(l, l.launchRows(lo, 3)!, ORDER)).toEqual({ launch: true, cause: { kind: "first" } });
		l.close();
	});
});

// ---- § 1.8 the merge train ---------------------------------------------------------------------------------------------

describe("the merge-train workload is outside the relaunch (§ 1.8)", () => {
	test("a train lane that released open-work gets no relaunch cause, and a train request on it stays a request", () => {
		const x = world();
		const ins = x.instruction("instruction", prBindingInstructionBody("train", WL, [12, 13]));
		x.entry(SURFACE_BY, `train: 12 13 ${ins.id}`);
		x.slice("open");
		x.launch(1, "first");
		x.entry(lane(1), "released-open: " + lane(1) + " slices 1");
		x.exit(1, "open-work");
		x.died(1);
		expect(x.end(1)).toEqual({ kind: "died" });
		expect(x.state()).toEqual({ kind: "none" });
		expect(x.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		const req = x.request("train");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});
	test("a board-only train also stays outside automatic dead-lane retries", () => {
		const x = world();
		x.entry(MERGE_TRAIN_BY, trainBoardBody({ pr: 12, workload: "wl-owner", head: "a".repeat(40), run: null, review: null }));
		x.slice("open");
		x.launch(1, "first");
		x.exit(1, "open-work");
		x.died(1);
		expect(x.state()).toEqual({ kind: "none" });
		expect(x.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		const req = x.request("train");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});
	test("a machinery request for a lane that ended as intended launches as a request, as before", () => {
		const x = launched();
		x.exit(1, "released");
		const req = x.request("train");
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});
	test("r1 M1: a machinery request for a dead lane the relaunch does not take on launches as a request, as on 251e354: an open question", () => {
		const x = launched();
		x.question(lane(1), x.slices[0]!.id, "open");
		x.exit(1, "error");
		x.died(1);
		expect(x.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		const req = x.request("train");
		expect(x.state()).toEqual({ kind: "none" });
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});
	test("r1 M1 (a): a done-because:, then a restart's signal stop: the train request launches as a request", () => {
		const x = launched();
		x.entry(lane(1), "done-because: the work is done");
		x.accept(1, "signal");
		x.exit(1, "stop", "signal");
		x.died(1);
		expect(x.end(1)).toEqual({ kind: "died" });
		expect(x.verdict()).toEqual({ launch: false, reason: "awaiting-close" });
		const req = x.request("train");
		expect(x.state()).toEqual({ kind: "none" });
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});
	test("r1 M1 (b): an error exit with no open slice: the train request launches as a request", () => {
		const x = world();
		x.slice("done");
		x.launch(1, "first");
		x.exit(1, "error");
		x.died(1);
		expect(x.end(1)).toEqual({ kind: "died" });
		expect(x.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		const req = x.request("train");
		expect(x.state()).toEqual({ kind: "none" });
		expect(x.verdict()).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
	});
	test("r1 M1: due still folds a train request; the unrecorded lapse and Jo's stop still refuse it (waiting and exhausted: the backoff and counter tests)", () => {
		const due = deadOnce();
		const t1 = due.request("train");
		expect(due.verdict()).toEqual({ launch: true, cause: { kind: "relaunch", lane: lane(1), n: 1, request: t1.id } });
		const lapse = launched();
		lapse.lapse();
		lapse.request("train");
		expect(lapse.verdict()).toEqual({ launch: false, reason: "died-not-relaunched" });
		const stopped = deadOnce();
		stopped.stop(1);
		stopped.request("train");
		expect(stopped.verdict()).toEqual({ launch: false, reason: "stopped" });
	});
});

// ---- § 1.5 the incident ------------------------------------------------------------------------------------------------

describe("the incident (§ 1.5)", () => {
	test("incidentBody: one line, the detail folded and cut to INCIDENT_DETAIL_MAX characters", () => {
		const body = incidentBody({ kind: "relaunch", workloadId: WL, key: lane(4), count: 3, limit: 3, detail: `lane-died: ${lane(4)}:\n  prompt ended error ${"x".repeat(300)}` });
		expect(body).toStartWith(`incident: relaunch ${WL} key ${lane(4)} after 3/3 retries without progress: lane-died: ${lane(4)}: prompt ended error x`);
		expect(body).not.toContain("\n");
		expect(body.length).toBe(`incident: relaunch ${WL} key ${lane(4)} after 3/3 retries without progress: `.length + INCIDENT_DETAIL_MAX);
	});
	test("r1 m5: parseIncident reads incidentBody back; anything else is not an incident", () => {
		const i = { kind: "relaunch", workloadId: WL, key: lane(4), count: 3, limit: RETRY_LIMIT, detail: "lane-died: lane-r-4: error (exit 1); train #101 held" };
		expect(parseIncident(incidentBody(i))).toEqual(i);
		expect(parseIncident(`incident: relaunch ${WL} key ${lane(4)} after three retries`)).toBeNull();
		expect(parseIncident("lane-died: lane-r-4: error")).toBeNull();
	});
	test("recordIncidentOnce: written once per kind, workload and key; stillDue is re-checked inside; a forged lane note does not count", () => {
		const { ledger: l } = tempLedger();
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "x", stakes: "normal", mode: "autonomous" });
		const input = { by: SURFACE_BY, kind: "relaunch", workloadId: wl, key: lane(4), count: 3, limit: RETRY_LIMIT, detail: "lane-died: lane-r-4: error (exit 1)" };
		l.enqueue({ by: lane(4), workloadId: wl, sender: lane(4), recipient: ORCHESTRATOR_RECIPIENT, body: incidentBody(input) });
		expect(recordIncidentOnce(l, input, () => false)).toBeNull();
		const id = recordIncidentOnce(l, input, () => true);
		expect(id).toStartWith("msg");
		expect(l.message(id!)).toMatchObject({ state: "held", recipient: ORCHESTRATOR_RECIPIENT, created_by: SURFACE_BY, body: incidentBody(input) });
		expect(recordIncidentOnce(l, { ...input, count: 4, detail: "later" }, () => true)).toBeNull();
		// another key, another kind: their own incidents
		expect(recordIncidentOnce(l, { ...input, key: lane(40) }, () => true)).not.toBeNull();
		expect(recordIncidentOnce(l, { ...input, kind: "transient" }, () => true)).not.toBeNull();
		l.close();
	});
});

describe("relaunchRead exposes the newest lane for the surface", () => {
	test("no attempt: nothing; an attempt: its lane and end", () => {
		const x = world();
		expect(relaunchRead(x.rows())).toEqual({ lane: null, end: null, train: false, state: { kind: "none" } });
		const y = deadOnce();
		expect(relaunchRead(y.rows())).toEqual({ lane: lane(1), end: { kind: "died" }, train: false, state: { kind: "due", lane: lane(1), n: 1 } });
	});
});
