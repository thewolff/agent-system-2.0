// PLAN wl-mvidsu83epvpj4 (jo-issues#184, agent-system-2.0#283): a lane that released itself, or whose holder's
// done-because: stands, is ended by its runner at once — stdin EOF, SIGTERM after the shutdown grace, SIGKILL after the end
// grace — and `lane-exit:` follows; the next launch proceeds, and the process that spawns the next omp ends a self-released
// lane's stale omp first. Through the real `lane.ts launch`, runner and `lane.ts interactive`, against the fake omp in
// omp 18.8.6's shape (`deferShutdown`: the lane's ctx.shutdown() only requests it; `{ pending: true }`: background work that
// never settles; `ignoreEof`). AGENT_SYSTEM_LANE_SETTLE_IDLE_MS stays at its 15-minute default (cases 2c and 2d alone shorten
// it, to reach the idle check as their event), so a runner that waits for the settle (the pre-change tree) never writes
// `lane-exit:` inside these windows.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { applyTrain, interpret } from "../src/input";
import { doneBody, laneExit, laneExitBody, laneStarted, laneStopAcceptedBody, laneStopRequestBody, launchRequestedBody, STARTER_EXIT } from "../src/launch";
import { isTrain } from "../src/merge-train";
import { ompPidState, psAnswer, runPs } from "../src/omp-probe";
import { IDLE_CHECK } from "../src/turn-end";
import { SURFACE_BY } from "../src/types";
// A namespace import: a name lane.ts does not export fails only the test that calls it.
import * as laneScript from "../scripts/lane";
import { alive, type FakeScript, type FakeStep, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, setScript, settleDrains, sh, until } from "./helpers";

const roots: LaneRoot[] = [];
/**
 * Stale omps a case leaves alive on purpose, each with the ps start time its lane-started: recorded: SIGKILLed after the file,
 * whatever the case's outcome, but only while a fresh probe still shows that process (review r1 finding 1).
 */
const leftovers: { pid: number; start: string }[] = [];
/** The ps gates (`psGate`) the cases made: each opened after the file, so a failed case never leaves a runner held at one. */
const psGates: string[] = [];
/** Lanes whose runner a case SIGKILLed: their lane-exit: is written for them after the file, as `lane.ts stop`'s no-runner fallback writes it (by the starter), so settleDrains finds every runner's lane ended. */
const killedLanes: { r: LaneRoot; wl: string; laneId: string }[] = [];
/** Short polls and graces; the settle-idle window stays at its default (see the header). */
const makeRoot = (over: Record<string, string> = {}): LaneRoot => {
	const r = laneRoot({ AGENT_SYSTEM_LANE_STOP_POLL_MS: "200", ...over });
	roots.push(r);
	return r;
};
/**
 * PLAN wl-mw0ytmzi89d683 F8: every cleanup failure is reported, never swallowed. A ps gate is opened first. A leftover is
 * re-probed strictly before its signal (`ompPidState`, the probe production's endStale uses): only `same`, the recorded omp
 * still running, is SIGKILLed; `gone` and `other` (its pid now names another process) are left alone; an identity ps could
 * not verify (`failed`, or `unknown` with no start time) is a cleanup failure and is never signalled. ESRCH on the kill
 * after a `same` is taken as done (it exited between the probe and the signal). A root whose drains did not settle is
 * kept, its path printed, for the evidence in it; the drain failures and every cleanup failure are thrown together.
 */
afterAll(async () => {
	const failures: unknown[] = [];
	for (const gate of psGates) {
		try {
			writeFileSync(gate, "open\n");
		} catch (err) {
			failures.push(new Error(`afterAll: the ps gate ${gate} could not be opened: ${String(err)}`, { cause: err }));
		}
	}
	for (const o of leftovers) {
		let why = "";
		const st = ompPidState(o.pid, o.start, runPs, (reason) => {
			why = reason;
		});
		if (st === "gone" || st === "other") continue;
		if (st !== "same") {
			failures.push(
				new Error(
					`afterAll: leftover omp pid ${o.pid} (recorded start "${o.start}") not signalled: its identity could not be verified (${st}${why ? `: ${why}` : ""}); check it with \`ps -p ${o.pid} -o stat=,lstart=\` and end it by hand if it is that omp`,
				),
			);
			continue;
		}
		try {
			process.kill(o.pid, "SIGKILL");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ESRCH") failures.push(new Error(`afterAll: SIGKILL of leftover omp pid ${o.pid} failed (${code ?? "no errno"}): ${String(err)}`, { cause: err }));
		}
	}
	for (const k of killedLanes) {
		try {
			if (laneExit(laneSnapshot(k.r, k.wl).control, k.laneId) !== null) continue;
			const l = ledgerOf(k.r);
			try {
				l.recordEntry({ by: LANE_STARTER_BY, workloadId: k.wl, kind: "assumption", body: laneExitBody(k.laneId, { code: null, signal: "SIGKILL", outcome: "died" }) });
			} finally {
				l.close();
			}
		} catch (err) {
			failures.push(new Error(`afterAll: the stand-in lane-exit: of ${k.laneId} in ${k.r.root} could not be written: ${String(err)}`, { cause: err }));
		}
	}
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	settled.forEach((s, i) => {
		const r = roots[i]!;
		if (s.status === "rejected") {
			failures.push(s.reason);
			process.stderr.write(`lane-release-exit afterAll: kept ${r.root} (its drains did not settle; runner logs and the ledger are in it)\n`);
			return;
		}
		try {
			rmSync(r.root, { recursive: true, force: true });
		} catch (err) {
			failures.push(new Error(`afterAll: removing ${r.root} failed: ${String(err)}`, { cause: err }));
		}
	});
	if (failures.length > 0) throw new AggregateError(failures, `lane-release-exit afterAll: ${failures.length} failure(s) in the drains or the cleanup`);
}, 120_000);

const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
function openWorkload(r: LaneRoot): string {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "release exit probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		return wl;
	} finally {
		l.close();
	}
}
const lane = (r: LaneRoot, args: string[], over: Record<string, string> = {}) => sh(["bun", LANE_SCRIPT, ...args], r.repo, { ...r.env, ...over });
/** `lane.ts launch`, exit 0, and the runner pid it printed. */
const launch = (r: LaneRoot, wl: string, over: Record<string, string> = {}): number => {
	const out = lane(r, ["launch", wl, "--requested-by", "test"], over);
	expect(out.err).not.toContain("still running");
	expect(out.code).toBe(STARTER_EXIT.ok);
	return Number(/^lane \S+ runner (\d+)$/.exec(out.out)![1]);
};
const request = (r: LaneRoot, wl: string) => {
	const l = ledgerOf(r);
	try {
		return l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("test", l.now()) });
	} finally {
		l.close();
	}
};
const eventsOf = (r: LaneRoot, pid: number) => fakeRecords(r).filter((x) => x.pid === pid && x.event).map((x) => x.event!);
/** The shutdown events in the order the fake recorded them. */
const shutdownEvents = (r: LaneRoot, pid: number) => eventsOf(r, pid).filter((e) => ["shutdown-requested", "eof", "sigterm"].includes(e));
const spawnedPids = (r: LaneRoot) => [...new Set(fakeRecords(r).filter((x) => x.argv !== undefined).map((x) => x.pid))];
const exitOf = (r: LaneRoot, wl: string, laneId: string, ms = 30_000) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId), ms);
const startedOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-started: of ${laneId}`, () => laneStarted(laneSnapshot(r, wl).control, laneId));
const promptsOf = (r: LaneRoot) => fakeRecords(r).filter((x) => x.event === "prompt");
/** `gone()` could not ask ps: the pid is neither shown gone nor alive. */
class PsProbeFailed extends Error {
	override name = "PsProbeFailed";
}
/** Gone to ps: no row, or a zombie awaiting its reaper (the stale omp is an orphan). A failed ps throws `PsProbeFailed`, never reads as gone. */
const gone = (pid: number): boolean => {
	let stat: string | null;
	try {
		stat = psAnswer(runPs, pid, "stat=");
	} catch (err) {
		throw new PsProbeFailed(`gone(${pid}): ps failed, so pid ${pid} cannot be shown gone or alive: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}
	return stat === null || stat.startsWith("Z");
};
const holderChanges = (r: LaneRoot, wl: string) => {
	const l = ledgerOf(r);
	try {
		return l.holderChanges(wl);
	} finally {
		l.close();
	}
};

/**
 * Review r1 finding 2 (PLAN wl-mw0ytmzi89d683): the order of the new runner's cleanup and a case's own step is set by an
 * event, not by the end grace. A ps wrapper put ahead of the real ps on the PATH of the launch it is passed to (the starter
 * and the runner it starts) passes every call through to the ps the root's PATH finds, except the `at`-th
 * `ps -p <pid> -o stat=,lstart=` of `pid`: that one writes `waiting` (`waiting()` resolves on it) and is held until the test
 * writes the gate (`open()`). That call is endStale's probe of the stale omp: probe 1 comes before its SIGTERM, probe 2
 * after it, and nothing before endStale probes that pid with those fields (the starter skips a self-released lane's pids,
 * `liveLaneOf`). The launch's ps bound (AGENT_SYSTEM_LANE_PS_TIMEOUT_MS) is raised past the wrapper's own 60 s cap, so a
 * held probe never times out into an ungated one; past that cap the wrapper exits 2 with a stderr line, a failed probe
 * that endStale logs and never signals on. Production code has no hook for this: the gate is the ps it already runs.
 */
function psGate(r: LaneRoot, pid: number, at: number) {
	const dir = join(r.root, `ps-gate-${pid}-${at}`);
	const calls = join(dir, "calls");
	const waiting = join(dir, "waiting");
	const gate = join(dir, "open");
	const real = Bun.which("ps", { PATH: r.env.PATH! });
	if (real === null) throw new Error(`psGate: no ps on the root's PATH (${r.env.PATH}); the gate has nothing to pass calls to`);
	for (const p of [dir, real]) if (p.includes("'")) throw new Error(`psGate: ${p} holds a single quote, which the wrapper's quoting cannot carry`);
	mkdirSync(dir);
	writeFileSync(
		join(dir, "ps"),
		[
			"#!/bin/sh",
			"# lane-release-exit.test.ts psGate: hold one endStale probe until the test opens the gate.",
			`if [ "$#" -eq 4 ] && [ "$1" = "-p" ] && [ "$2" = "${pid}" ] && [ "$3" = "-o" ] && [ "$4" = "stat=,lstart=" ]; then`,
			`\techo probe >> '${calls}'`,
			`\tn=$(wc -l < '${calls}' | tr -d ' ')`,
			`\tif [ "$n" -eq ${at} ]; then`,
			`\t\techo "$$" > '${waiting}'`,
			"\t\ti=0",
			`\t\twhile [ ! -e '${gate}' ]; do`,
			"\t\t\ti=$((i + 1))",
			`\t\t\tif [ "$i" -gt 1200 ]; then echo "ps gate: '${gate}' not opened within 60 s (probe $n of pid ${pid}); exiting 2" >&2; exit 2; fi`,
			"\t\t\tsleep 0.05",
			"\t\tdone",
			"\tfi",
			"fi",
			`exec '${real}' "$@"`,
			"",
		].join("\n"),
	);
	chmodSync(join(dir, "ps"), 0o755);
	psGates.push(gate);
	return {
		env: { PATH: `${dir}:${r.env.PATH}`, AGENT_SYSTEM_LANE_PS_TIMEOUT_MS: "90000" },
		waiting: () => until(`ps probe ${at} of pid ${pid} held at the gate ${gate}`, () => existsSync(waiting)),
		open: () => writeFileSync(gate, "open\n"),
	};
}

/** The one merge train, opened by Jo's `train 101` word on the root's repo, as lane-live-lane's `openTrainOn` opens it. */
function openTrain(r: LaneRoot): string {
	const l = ledgerOf(r);
	try {
		const cmd = interpret(l, "train 101");
		if (cmd?.kind !== "train") throw new Error(`\`train 101\` did not interpret as the train word: ${JSON.stringify(cmd)}`);
		const wl = applyTrain(l, cmd, r.repo).workloadId;
		expect(isTrain(l, wl)).toBe(true);
		return wl;
	} finally {
		l.close();
	}
}

const DONE: FakeStep = { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } };
const ADD: FakeStep = { tool: "lane_add_slice", args: { task: "probe", doneCondition: "probed", inputs: "README.md", kind: "change-small" } };
const COMPLETE: FakeStep = { tool: "lane_complete_slice", args: { slice: "$slice", artifact: "probed" } };
const RELEASE: FakeStep = { tool: "lane_release", args: {} };
const PENDING: FakeStep = { pending: true };
/** omp 18.8.6 as in the incidents: the release only requests the shutdown, and EOF does not end it. */
const deferred = (s: Omit<FakeScript, "deferShutdown" | "ignoreEof">): FakeScript => ({ deferShutdown: true, ignoreEof: true, ...s });

describe("a released lane's omp ends and lane-exit: follows (R1, R3, R8)", () => {
	test("1: release in the owned turn with background pending → shutdown-requested, EOF, SIGTERM; lane-exit: completed within 10 s; the next launch reserves and starts its lane", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, COMPLETE, DONE, PENDING, RELEASE] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		// The done line's 10 s bound as a failure-only hang guard (PLAN wl-mw0ytmzi89d683 "The 10 s bound"): the wait ends on
		// the lane-exit: entry; nothing is measured. The path is the stop poll (200 ms), the shutdown grace and EOF (1.5 s),
		// then SIGTERM; the pre-change tree's settle wait (15 min) never lands inside it.
		expect(await exitOf(r, wl, lane1, 10_000)).toMatchObject({ outcome: "completed" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
		expect(laneSnapshot(r, wl).deaths).toEqual([]);
		// the next launch on the same workload: reserved, its runner starts the next lane
		request(r, wl);
		setScript(r, { steps: [RELEASE] });
		launch(r, wl);
		const lane2 = laneIdOf(wl, 2);
		expect((await startedOf(r, wl, lane2))!.pid).not.toBe(started.pid);
		await exitOf(r, wl, lane2);
	}, 60_000);

	test("2: release with a receipt in a woken turn, background still pending → the stop poll decides; EOF, SIGTERM, lane-exit: completed", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, COMPLETE, PENDING, { wake: { ms: 1500, steps: [DONE, RELEASE] } }] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		expect(eventsOf(r, started.pid)).toContain("wake");
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	test("2a: receipt-free release in the owned turn (an open slice, released-open:) → decided at once: lane-exit: open-work with the released-open death", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, PENDING, RELEASE] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "open-work" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		const snap = laneSnapshot(r, wl);
		expect(snap.bodies.some((b) => b.includes("done-because:"))).toBe(false);
		expect(snap.deaths).toEqual([`lane-died: ${lane1}: released with 1 open slice(s), no done-because; background work was in flight`]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	test("2b: receipt-free release in a woken turn → the stop poll decides open-work the same way", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, PENDING, { wake: { ms: 1500, steps: [RELEASE] } }] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "open-work" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(laneSnapshot(r, wl).deaths).toEqual([`lane-died: ${lane1}: released with 1 open slice(s), no done-because; background work was in flight`]);
	}, 60_000);

	// PLAN wl-mw0ytmzi89d683 F2: no fixed waits. The runner writes nothing on a quiet poll, so the event is the idle check:
	// the release lands while the fake holds its turn at a gate (`awaiting-file`), the turn then ends unsettled, and the runner
	// waits (a self-release would decide at once) until the settle wait goes idle and it sends `idle-check` from a stop-poll
	// tick, which renews the lease in that same synchronous tick, after the release. That renewal and every one before it
	// wrote no holder change. ledger/test/ledger.test.ts ("renewLease … D2b") proves renewLease never re-claims on the Ledger.
	test("2c (R17): a third-party release while the runner's lane works is not a self-release: the runner waits to its idle check, and its lease renewals never re-claim", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_SETTLE_IDLE_MS: "1500" });
		const wl = openWorkload(r);
		const gate = join(r.root, "gate-2c");
		setScript(r, deferred({ steps: [{ awaitFile: gate }, PENDING] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		// the lane's own claim (lane-ready: follows it), then its one turn, held at the gate
		await until("lane 1's lane-ready:", () => laneSnapshot(r, wl).control.some((c) => c.prefix === "lane-ready" && c.laneId === lane1));
		await until("lane 1's turn at the gate", () => eventsOf(r, started.pid).includes("awaiting-file"));
		expect(laneSnapshot(r, wl).workload!.holder).toBe(lane1);
		const l = ledgerOf(r);
		try {
			expect(l.releaseWorkload(wl, { by: LANE_STARTER_BY, holder: lane1 })).toEqual({ released: true });
		} finally {
			l.close();
		}
		const at = holderChanges(r, wl).length;
		writeFileSync(gate, "open\n");
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		// the runner waited for the settle and asked omp once the wait went idle: it did not take the release as its own
		expect(fakeRecords(r).filter((x) => x.pid === started.pid && x.command === "get_state" && x.id === IDLE_CHECK)).toHaveLength(1);
		expect(holderChanges(r, wl).slice(at)).toEqual([]);
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	// Review r1 finding 3 (PLAN wl-mw0ytmzi89d683 F3, PLAN wl-mvr888nftz0vcl D3): the stop poll's own receipt read. A merge
	// train is permanent, so a legacy done-because: its held lane wrote straight to the ledger is no receipt there either. The
	// owned turn writes it and leaves a job pending; the turn ends unsettled and the runner waits. Were the poll's
	// `terminalNow` to read the receipt without the train flag, every 200 ms tick would re-decide `wait` and restart the
	// settle wait, so the idle check, the event this case waits for, would never come. After it the train's idle prompt
	// goes out; that turn is held at a gate, so the ledger stop request ends the lane with nothing else in flight.
	test("2d (F3): a held merge-train lane with a legacy done-because: and background pending → the stop poll waits to its idle check, then sends the train's idle prompt", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_SETTLE_IDLE_MS: "1500" });
		const wl = openTrain(r);
		const gate = join(r.root, "gate-2d");
		setScript(r, { steps: [{ awaitFile: gate }], prompts: [[{ ledger: { body: "done-because: every PR is merged" } }, PENDING]] });
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		await until("lane 1's idle check", () => fakeRecords(r).some((x) => x.pid === started.pid && x.command === "get_state" && x.id === IDLE_CHECK));
		const idlePrompt = await until("lane 1's idle prompt", () => promptsOf(r).filter((x) => x.pid === started.pid)[1]);
		expect(idlePrompt.message).toContain("this train is permanent");
		await until("lane 1's idle turn at the gate", () => eventsOf(r, started.pid).includes("awaiting-file"));
		const snap = laneSnapshot(r, wl);
		// the legacy receipt stands, written by the lane, and the lane still holds the train: nothing took it as done
		expect(snap.entries.filter((e) => e.body.startsWith("done-because:")).map((e) => e.created_by)).toEqual([lane1]);
		expect(snap.workload!.holder).toBe(lane1);
		expect(laneExit(snap.control, lane1)).toBeNull();
		expect(snap.deaths).toEqual([]);
		const l = ledgerOf(r);
		try {
			l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(lane1, "test-stop", "test") });
		} finally {
			l.close();
		}
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "stop" });
		expect(fakeRecords(r).filter((x) => x.pid === started.pid && x.command === "get_state" && x.id === IDLE_CHECK)).toHaveLength(1);
	}, 60_000);

	test("3: a receipt only, owned turn, background pending → completed at once: omp ended, the workload released, no idle prompt", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [DONE, PENDING] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		expect(shutdownEvents(r, started.pid)).toEqual(["eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
		expect(laneSnapshot(r, wl).workload!.holder).toBeNull();
	}, 60_000);

	test("4: a receipt only, written by a woken turn, background still pending → the stop poll decides completed; lane-exit: follows", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [PENDING, { wake: { ms: 1500, steps: [DONE] } }] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		expect(eventsOf(r, started.pid)).toContain("wake");
		expect(shutdownEvents(r, started.pid)).toEqual(["eof", "sigterm"]);
		expect(promptsOf(r)).toHaveLength(1);
	}, 60_000);

	test("5: case 1 with an omp that ignores SIGTERM → SIGKILL after the end grace, lane-exit: still written", async () => {
		const r = makeRoot();
		const wl = openWorkload(r);
		setScript(r, deferred({ ignoreTerm: true, steps: [ADD, COMPLETE, DONE, PENDING, RELEASE] }));
		launch(r, wl);
		const lane1 = laneIdOf(wl, 1);
		const started = (await startedOf(r, wl, lane1))!;
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed", signal: "SIGKILL" });
		expect(shutdownEvents(r, started.pid)).toEqual(["shutdown-requested", "eof", "sigterm"]);
		expect(alive(started.pid)).toBe(false);
	}, 60_000);
});

/**
 * Cases 6–8's setup: lane 1 releases itself (receipt, background pending) with an omp that ignores EOF and SIGTERM; its runner
 * holds a long shutdown grace and is SIGKILLed once it has sent EOF, so lane 1 has no lane-exit: and its omp lives on.
 */
async function staleLane(r: LaneRoot) {
	const wl = openWorkload(r);
	setScript(r, deferred({ ignoreTerm: true, steps: [ADD, COMPLETE, DONE, PENDING, RELEASE] }));
	const runner = launch(r, wl, { AGENT_SYSTEM_LANE_SHUTDOWN_GRACE_MS: "120000" });
	const lane1 = laneIdOf(wl, 1);
	const stale = (await startedOf(r, wl, lane1))!;
	leftovers.push({ pid: stale.pid, start: stale.start });
	await until("lane 1's EOF", () => eventsOf(r, stale.pid).includes("eof"));
	process.kill(runner, "SIGKILL");
	killedLanes.push({ r, wl, laneId: lane1 });
	await until("lane 1's runner gone", () => !alive(runner));
	expect(laneExit(laneSnapshot(r, wl).control, lane1)).toBeNull();
	expect(laneScript.startTime(stale.pid)).toBe(stale.start);
	expect(holderChanges(r, wl).at(-1)).toMatchObject({ from: lane1, to: null, by: lane1 });
	return { wl, lane1, stale };
}

/** Waits for `laneId`'s lane-started:, asserting at every sighting that the stale pid is already gone. */
const startedAfterGone = (r: LaneRoot, wl: string, laneId: string, stalePid: number) =>
	until(`lane-started: of ${laneId}`, () => {
		const s = laneStarted(laneSnapshot(r, wl).control, laneId);
		if (s) expect(gone(stalePid)).toBe(true);
		return s;
	}, 60_000);

describe("a self-released lane's stale omp at the next spawn (R5, R7, R15)", () => {
	// The order is held by the ps gate (`psGate`), not by the 5 s grace: the new runner's first probe of the stale omp, the one
	// its SIGTERM follows, waits at the gate until the starter has exited and the omp has been read alive.
	test("6: the starter exits 0 at once with the stale omp still alive; the new runner ends it (SIGTERM, SIGKILL after 5 s) before its own lane-started:", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_END_GRACE_MS: "5000" });
		const { wl, stale } = await staleLane(r);
		const gate = psGate(r, stale.pid, 1);
		request(r, wl);
		setScript(r, { steps: [RELEASE] });
		launch(r, wl, gate.env);
		// read right after the starter exits: the stale omp still runs as recorded, so the starter did not wait on it
		expect(laneScript.startTime(stale.pid)).toBe(stale.start);
		expect(gone(stale.pid)).toBe(false);
		await gate.waiting();
		expect(eventsOf(r, stale.pid)).not.toContain("sigterm");
		gate.open();
		const lane2 = laneIdOf(wl, 2);
		const s2 = (await startedAfterGone(r, wl, lane2, stale.pid))!;
		expect(s2.pid).not.toBe(stale.pid);
		expect(eventsOf(r, stale.pid)).toContain("sigterm");
		await exitOf(r, wl, lane2);
	}, 90_000);

	// PLAN wl-mw0ytmzi89d683 F4: both enders live at once. Lane 1's own runner sits in its EOF grace (a 120 s shutdown grace
	// for that runner alone, an omp that ignores EOF), and the next launch's runner ends the same omp with endStale. Whichever
	// signal lands first, the outcome is pinned, not who sent it: one lane-exit: for lane 1 (its intended outcome, no death),
	// the old omp gone to ps at every sighting of lane 2's lane-started:, and a starter that never refused `held`.
	test("6c: the next launch while lane 1's runner is in its EOF grace → one lane-exit: for lane 1, no lane-died:, the old omp gone before lane 2's lane-started:, never held", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_END_GRACE_MS: "5000" });
		const wl = openWorkload(r);
		setScript(r, deferred({ steps: [ADD, COMPLETE, DONE, PENDING, RELEASE] }));
		const runner1 = launch(r, wl, { AGENT_SYSTEM_LANE_SHUTDOWN_GRACE_MS: "120000" });
		const lane1 = laneIdOf(wl, 1);
		const old = (await startedOf(r, wl, lane1))!;
		leftovers.push({ pid: old.pid, start: old.start });
		await until("lane 1's EOF", () => eventsOf(r, old.pid).includes("eof"));
		expect(gone(old.pid)).toBe(false);
		expect(alive(runner1)).toBe(true);
		request(r, wl);
		setScript(r, { steps: [RELEASE] });
		const out = lane(r, ["launch", wl, "--requested-by", "test"]);
		expect(out.code).toBe(STARTER_EXIT.ok);
		expect(`${out.out}\n${out.err}`).not.toMatch(/\bheld:|still running/);
		const lane2 = laneIdOf(wl, 2);
		const s2 = (await startedAfterGone(r, wl, lane2, old.pid))!;
		expect(s2.pid).not.toBe(old.pid);
		expect(await exitOf(r, wl, lane1)).toMatchObject({ outcome: "completed" });
		await until("lane 1's runner gone", () => !alive(runner1));
		await exitOf(r, wl, lane2);
		const snap = laneSnapshot(r, wl);
		expect(snap.control.filter((c) => c.prefix === "lane-exit" && c.laneId === lane1)).toHaveLength(1);
		expect(snap.deaths).toEqual([]);
		expect(eventsOf(r, old.pid)).toContain("sigterm");
	}, 90_000);

	// The stop lands while the cleanup is mid-way, by the ps gate (`psGate`), not by the 5 s grace: the new runner's second
	// probe of the stale omp, after its SIGTERM and before any SIGKILL, waits at the gate until the stop is submitted.
	for (const how of ["signal", "ledger"] as const) {
		test(`7${how === "signal" ? "a" : "b"}: a stop (${how === "signal" ? "SIGTERM to the new runner" : "a ledger stop request, no lane.ts stop"}) during the cleanup → no omp spawned, lane-exit: outcome stop by lane-runner`, async () => {
			const r = makeRoot({ AGENT_SYSTEM_LANE_END_GRACE_MS: "5000" });
			const { wl, stale } = await staleLane(r);
			const gate = psGate(r, stale.pid, 2);
			request(r, wl);
			setScript(r, { steps: [RELEASE] });
			const runner = launch(r, wl, gate.env);
			const lane2 = laneIdOf(wl, 2);
			await gate.waiting();
			await until("the cleanup's SIGTERM to the stale omp", () => eventsOf(r, stale.pid).includes("sigterm"));
			expect(gone(stale.pid)).toBe(false);
			let req: string | null = null;
			if (how === "signal") process.kill(runner, "SIGTERM");
			else {
				const l = ledgerOf(r);
				req = l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStopRequestBody(lane2, "test-stop", "test") });
				l.close();
			}
			gate.open();
			expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "stop" });
			const snap = laneSnapshot(r, wl);
			expect(snap.control.find((c) => c.prefix === "lane-exit" && c.laneId === lane2)!.createdBy).toBe(LANE_RUNNER_BY);
			expect(laneStarted(snap.control, lane2)).toBeNull();
			expect(spawnedPids(r)).toEqual([stale.pid]);
			expect(snap.workload!.holder).toBeNull();
			if (req !== null) {
				const accepted = snap.entries.find((e) => e.body === laneStopAcceptedBody(lane2, req!));
				expect(accepted?.created_by).toBe(LANE_RUNNER_BY);
			}
		}, 90_000);
	}

	test("8: lane.ts interactive past a stale omp → SIGTERM, then gone after the 5 s grace, before the interactive lane-started:; closing Jo's terminal ends it with outcome interactive", async () => {
		const r = makeRoot({ AGENT_SYSTEM_LANE_END_GRACE_MS: "5000" });
		const { wl, stale } = await staleLane(r);
		const l = ledgerOf(r);
		l.flipMode(wl, { by: SURFACE_BY, mode: "user-driven", author: "jo", channel: "surface" });
		l.close();
		setScript(r, { steps: [{ hang: true }] });
		// The TUI's stdio is inherited from the wrapper: a pipe held open stands in for Jo's terminal.
		const tui = Bun.spawn(["bun", LANE_SCRIPT, "interactive", wl], { cwd: r.repo, env: r.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const lane2 = laneIdOf(wl, 2);
		const s2 = (await startedAfterGone(r, wl, lane2, stale.pid))!;
		expect(eventsOf(r, stale.pid)).toContain("sigterm");
		expect(s2.pid).not.toBe(stale.pid);
		await until("the interactive omp's spawn", () => spawnedPids(r).includes(s2.pid));
		tui.stdin.end();
		await tui.exited;
		expect(await exitOf(r, wl, lane2)).toMatchObject({ outcome: "interactive" });
	}, 90_000);
});
