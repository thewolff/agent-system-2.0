// The runner identity check one copy serves (review r2 R2-4): `lane.ts run`'s guard (one runner per lane id,
// surface/scripts/lane.ts `cmdRun`) and the relaunch's reading of a lapsed lease (`laneRunning`: surface/src/relaunch.ts
// `laneEnd`, and the lapse writer and its pure reader in surface/src/signals.ts). A lane is running while a pid its
// `lane-started:` recorded is still that lane's process: its omp by the start time the entry recorded, its runner by its
// command line (`lane.ts run <wl> <laneId>`; no entry records the runner's start time). A pid that is gone, a zombie (ps
// shows `<defunct>`, or no start time), or a reused pid (another process, another user's included) is not.
import { type ControlEntry, laneStarted } from "./launch";
import { ompPidState, type PidState, psAnswer, type PsRun, runPs } from "./omp-probe";

/** How the guard asks the machine about a `lane-started:` entry's two pids; the tests pass a fake. */
export interface RunnerProbe {
	/** The omp pid against the start time the entry recorded; with none recorded, `unknown` while the pid is alive (`gone` once it is not). */
	omp(pid: number, start: string): PidState;
	/** The runner pid, whose start time no entry records: `same` only while its command line is still `lane.ts run <wl> <laneId>` (`isRunnerCommand`). */
	runner(pid: number): PidState;
}

/**
 * The process a second `lane.ts run` on the same lane id would collide with: alive and this lane's, (`uninspected`) one
 * ps could not answer for, or (`unverified`) a live omp pid with no recorded start time.
 */
export interface LiveRunner {
	what: "omp" | "runner";
	pid: number;
	/** The probe answered `failed`: the pid may be this lane's live process, and the run is refused as retryable, not as running. */
	uninspected?: true;
	/** The probe answered `unknown`: a live pid no start time can tell from this lane's omp, refused as retryable until it exits. */
	unverified?: true;
}

/**
 * The live process of a lane id already running, or null when `lane.ts run` may start it (pure; the probe is the only
 * outside read). Every `lane-started:` for `laneId` after its newest `lane-exit:` is checked, newest first, so a pid that
 * a later start record superseded but that is still alive refuses too: a lane id with a live omp is running whichever
 * entry named it. An entry refuses when its omp pid is `same` (alive, and its start time matches the recorded one), or
 * when its runner pid is not `selfPid` and is `same` (still running `lane.ts run` on this workload and lane id: no start
 * time is recorded for the runner, so its command line is the identity check). `gone` and `other` (the pid was reused)
 * never refuse. `unknown` (the omp pid is alive and no start time was recorded for it) refuses as `unverified`: it cannot
 * be told apart from this lane's omp, so it is never permission to start (openai review r2 #1). `failed` (ps could not
 * answer for a recorded pid) refuses as `uninspected`: the owner was not shown gone, so a second runner could be a
 * duplicate and its finalizer could release the first one's workload (openai review r1 #4).
 * `selfPid` skips only the runner check, since this process matches its own command; an omp that entry names still counts.
 *
 * This is the second check, not the exclusion: `cmdRun` runs it while holding the lane id's run lock (`takeRunnerLock`),
 * which is what keeps two `run` calls on one lane id from both spawning omp. This check catches what the lock cannot
 * see: an omp still alive after its runner died (the lock was taken over from a dead pid), and a lane id an interactive
 * lane or a runner that predates the lock started.
 */
export function liveRunnerOf(control: readonly ControlEntry[], laneId: string, selfPid: number, probe: RunnerProbe): LiveRunner | null {
	const checked = new Set<string>();
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.laneId !== laneId) continue;
		if (c.prefix === "lane-exit") return null;
		if (c.prefix !== "lane-started") continue;
		const s = laneStarted([c], laneId);
		if (s === null) continue;
		// The runner re-records lane-started: once omp names its model and session; the pids repeat, so each pair is probed once.
		const key = `${s.pid} ${s.start} ${s.runnerPid}`;
		if (checked.has(key)) continue;
		checked.add(key);
		if (s.pid > 0) {
			const omp = probe.omp(s.pid, s.start);
			if (omp === "same") return { what: "omp", pid: s.pid };
			if (omp === "unknown") return { what: "omp", pid: s.pid, unverified: true };
			if (omp === "failed") return { what: "omp", pid: s.pid, uninspected: true };
		}
		if (s.runnerPid > 0 && s.runnerPid !== selfPid) {
			const runner = probe.runner(s.runnerPid);
			if (runner === "same") return { what: "runner", pid: s.runnerPid };
			if (runner === "failed") return { what: "runner", pid: s.runnerPid, uninspected: true };
		}
	}
	return null;
}

/** Whether a `ps -o command=` line is `lane.ts run <wl> <laneId>` (how `cmdLaunch` and chaos start a runner), whatever the path to lane.ts. */
export function isRunnerCommand(command: string, wl: string, laneId: string): boolean {
	const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[\\s/])lane\\.ts run ${esc(wl)} ${esc(laneId)}(?:\\s|$)`).test(command);
}

/**
 * The machine's probe for `liveRunnerOf`, over `run` (ps; the tests pass a fake). The omp pid is read by the shared
 * strict reader (`ompPidState`, surface/src/omp-probe.ts); the runner pid by its command line. A ps that cannot be
 * spawned or answers anything but a clean line or a clean "no such process" reads `failed`, its reason kept in
 * `failure` for the refusal.
 */
export function runnerProbe(wl: string, laneId: string, run: PsRun = runPs): RunnerProbe & { failure: string | null } {
	const p = {
		failure: null as string | null,
		omp: (pid: number, start: string): PidState =>
			ompPidState(pid, start, run, (reason) => {
				p.failure = reason;
			}),
		runner: (pid: number): PidState => {
			try {
				const command = psAnswer(run, pid, "command=");
				return command === null ? "gone" : isRunnerCommand(command, wl, laneId) ? "same" : "other";
			} catch (err) {
				p.failure = err instanceof Error ? err.message : String(err);
				return "failed";
			}
		},
	};
	return p;
}

/** The probe a reader that is not the runner asks about lane `laneId` of workload `wl`: `runnerProbe` over ps; the tests pass a fake. */
export type ProbeFor = (wl: string, laneId: string) => RunnerProbe;
export const psProbe: ProbeFor = (wl, laneId) => runnerProbe(wl, laneId);

/**
 * Whether lane `laneId` of workload `wl` is still running by the run guard's own check (`liveRunnerOf` over `probeFor`'s
 * probe, no pid skipped): a lapsed lease whose lane is running is the runner outliving its lease (a sleeping Mac), not a
 * death (review r1 M2, r2 R2-3). A pid ps could not inspect (`uninspected`) or a live omp with no recorded start time
 * (`unverified`) counts as running, as the guard refuses a second runner over it: the machinery never starts a successor
 * beside a runner it could not show gone. A lane with no `lane-started:` pid is not running.
 */
export function laneRunning(control: readonly ControlEntry[], wl: string, laneId: string, probeFor: ProbeFor = psProbe): boolean {
	return liveRunnerOf(control, laneId, 0, probeFor(wl, laneId)) !== null;
}
