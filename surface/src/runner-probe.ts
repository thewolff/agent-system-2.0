// The runner probe and the identity lock (PLAN wl-mw0vs9uc3xqtka D2.3, D3): whether a lane id's runner or omp is still alive,
// asked of the machine through ps, and a lock file whose owner is a pid and its ps start time. Moved out of
// surface/scripts/lane.ts so readers outside the runner ask the same questions with the same identity rules: the alert
// sources (surface/src/alert-sources.ts: a released lane still alive 5 minutes later) use the probe, and the alert pass
// (surface/scripts/alert-tick.ts: one pass at a time) takes its lock with `takeRunnerLock` as the runner takes a lane id's.
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { type ControlEntry, laneStarted } from "./launch";
import { ompPidState, type PidState, psAnswer, type PsRun, runPs, statStart } from "./omp-probe";

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
 * A reader that is no runner (the alert sources) passes 0: no recorded runner pid is 0, so every runner pid is checked.
 *
 * In the run guard this is the second check, not the exclusion: `cmdRun` runs it while holding the lane id's run lock
 * (`takeRunnerLock`), which is what keeps two `run` calls on one lane id from both spawning omp. This check catches what the
 * lock cannot see: an omp still alive after its runner died (the lock was taken over from a dead pid), and a lane id an
 * interactive lane or a runner that predates the lock started.
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

// ---- the identity lock: one owner at a time --------------------------------------------------------

/** A runner's identity in its run lock: its pid and that pid's ps start time, so a reused pid never reads as the owner. */
export interface RunnerIdentity {
	pid: number;
	start: string;
}

/** The lock file's owner: null when there is no file, `unreadable` when its content is not a pid and a start time. */
function lockOwner(path: string): RunnerIdentity | null | "unreadable" {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		const o = JSON.parse(text) as { pid?: unknown; start?: unknown };
		if (typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0 && typeof o.start === "string") return { pid: o.pid, start: o.start };
	} catch {
		// not JSON: unreadable, below
	}
	return "unreadable";
}

/**
 * A run lock this runner took. `held` re-reads the file: true while no other runner holds the lane id, that is while the
 * file names `self`, or while it is gone (removed under the runner, as with its lane dir) and nobody has taken it since;
 * false once it names another runner or names none. `owns` is the strict read the spawn needs (`startAsOwner`): true only
 * while the file exists and names `self`. `release` removes the file only while it names `self`.
 */
export interface RunnerLock {
	path: string;
	self: RunnerIdentity;
	/** The stale owner this runner replaced (its pid gone, or reused by a process with another start time), or null. */
	tookOver: { owner: RunnerIdentity; state: "gone" | "other" } | null;
	held(): boolean;
	owns(): boolean;
	release(): void;
}

/**
 * Why `takeRunnerLock` refused: the owner is alive (`same`), alive with no start time to verify it by (`unknown`), ps
 * could not answer for it (`failed`), the file names no owner (`unreadable`), or a writer outside the protocol created
 * the file between the read and the link (`raced`). Every one is a refusal, never a takeover.
 */
export interface LockRefusal {
	owner: RunnerIdentity | null;
	state: "same" | "unknown" | "failed" | "unreadable" | "raced";
}

function heldLock(path: string, self: RunnerIdentity, tookOver: RunnerLock["tookOver"]): RunnerLock {
	/** Whether the file names this runner: null when there is no file, false when it names another runner or none. */
	const mine = (): boolean | null => {
		try {
			const o = lockOwner(path);
			return o === null ? null : o !== "unreadable" && o.pid === self.pid && o.start === self.start;
		} catch {
			return false;
		}
	};
	return {
		path, self, tookOver,
		held: () => mine() !== false,
		owns: () => mine() === true,
		// No other runner replaces a lock whose owner is alive, so the file read as this runner's is still this runner's at the rm.
		release: () => {
			if (mine() === true) rmSync(path, { force: true });
		},
	};
}

/**
 * Take a lane id's run lock at `path` for `self`, or refuse (openai review r2 #1). The file holds the owner's pid and ps
 * start time and is created exclusively: the identity is written to a file of this pid's own and hard-linked in, so the
 * lock never exists half-written, and the link fails EEXIST as an O_EXCL create does. An existing lock is taken over
 * only when `check` (the same pid-and-start-time check an omp gets) reads its owner `gone` or `other`; any other answer
 * refuses. The read, the check, the takeover and the create all run inside one ledger write: the ledger's BEGIN
 * IMMEDIATE is the cross-process mutex, so two runners that both find one stale owner cannot both replace it, and the
 * mutex is never left behind (SQLite drops it when its process dies). Nothing is written to the ledger. A lock that
 * already names `self` is held (a busy-retried transaction runs this body twice). `check` runs inside the write, so it
 * must be bounded: the runner's is `runnerProbe` over `runPs`, where a ps past PS_TIMEOUT_MS reads `failed` (a refusal).
 */
export function takeRunnerLock(ledger: Pick<Ledger, "write">, path: string, self: RunnerIdentity, check: (pid: number, start: string) => PidState): RunnerLock | LockRefusal {
	mkdirSync(dirname(path), { recursive: true });
	return ledger.write((): RunnerLock | LockRefusal => {
		const owner = lockOwner(path);
		if (owner === "unreadable") return { owner: null, state: "unreadable" };
		if (owner !== null && owner.pid === self.pid && owner.start === self.start) return heldLock(path, self, null);
		let tookOver: RunnerLock["tookOver"] = null;
		if (owner !== null) {
			const state = check(owner.pid, owner.start);
			if (state !== "gone" && state !== "other") return { owner, state };
			rmSync(path, { force: true });
			tookOver = { owner, state };
		}
		const tmp = `${path}.${self.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(self)}\n`, { mode: 0o600 });
		try {
			linkSync(tmp, path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const now = lockOwner(path);
			return { owner: now === "unreadable" ? null : now, state: "raced" };
		} finally {
			rmSync(tmp, { force: true });
		}
		return heldLock(path, self, tookOver);
	});
}

/** This process's identity for its run lock: its pid and its ps start time, read strictly (a ps failure throws). */
export function selfIdentity(run: PsRun = runPs, pid: number = process.pid): RunnerIdentity {
	const out = psAnswer(run, pid, "stat=,lstart=");
	const start = out === null ? "" : statStart(out).start;
	if (!start) throw new Error(`ps -p ${pid} -o stat=,lstart= answered ${out === null ? "no such process" : `no start time: ${out}`}`);
	return { pid, start };
}

