// The omp liveness probe one copy serves: the run guard (`runnerProbe`, `selfIdentity` in surface/src/runner-probe.ts, `startTime`
// in surface/scripts/lane.ts) and the classifier's lost-hand settle (classifier/extension.ts `handLost`, PLAN
// wl-mv64rsqw2fcs1s D2). Every ps call goes through `runPs`, bounded by PS_TIMEOUT_MS, and is read
// strictly (`psAnswer`): only ps's clean "no such process" reads as gone, never a failure.
import { spawnSync } from "bun";

/**
 * A recorded pid now: still that process (`same`), no such process (`gone`), another process on the reused pid (`other`),
 * alive but with no start time recorded to tell it from another process on that pid (`unknown`), or ps could not be asked
 * or did not answer cleanly (`failed`).
 */
export type PidState = "same" | "gone" | "other" | "unknown" | "failed";

/** One `ps <args>` as run: its exit code (null when killed by a signal) and both streams. */
export interface PsResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}
/** Runs ps; throws when ps cannot be spawned (inside a lane's fence /bin/ps is EPERM) or, as `runPs`, does not answer within PS_TIMEOUT_MS. */
export type PsRun = (args: string[]) => PsResult;

/**
 * The bound on one ps call; past it ps is SIGKILLed and the call throws, as it does when ps cannot be spawned. ps runs
 * inside ledger writes (the run lock's owner check in `takeRunnerLock`, omp's start time in the spawn's lane-started:
 * record, the classifier's lost-hand settle), whose BEGIN IMMEDIATE an unbounded stall would hold against every ledger
 * writer (review r4).
 * 10 s, not 2 s: the ps stand-in (surface/scripts/ps-shim/ps, a bun script using FFI) cold-starts slowly under load, and
 * in a loaded chaos run it overran 2 s on the runner's own start-time probe, refusing the run. 10 s is still bounded,
 * and below the ledger's write tolerance (ledger/src/index.ts `OpenOptions`: busy_timeout 5000 ms per attempt, 5 busy
 * retries, so about 30 s), so other writers waiting on a stalled probe still get through.
 */
const psTimeoutEnv = Number(process.env.AGENT_SYSTEM_LANE_PS_TIMEOUT_MS);
const PS_TIMEOUT_MS = Number.isFinite(psTimeoutEnv) && psTimeoutEnv > 0 ? psTimeoutEnv : 10_000;

/** One `ps <args>`, bounded by PS_TIMEOUT_MS; every ps the lane script and the classifier run goes through it. */
export const runPs: PsRun = (args) => {
	const r = spawnSync(["ps", ...args], { stdout: "pipe", stderr: "pipe", timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" });
	if (r.exitedDueToTimeout) throw new Error(`ps ${args.join(" ")} did not answer within ${PS_TIMEOUT_MS} ms and was killed`);
	return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

/** A `stat=,lstart=` line split: a zombie (state Z), and the start time with lstart's own spacing ("Oct  2") kept, so lane-started: entries recorded with `-o lstart=` still compare equal. */
export function statStart(out: string): { zombie: boolean; start: string } {
	const stat = out.split(/\s/, 1)[0]!;
	return { zombie: stat.startsWith("Z"), start: out.slice(stat.length).trim() };
}

/**
 * `ps -p <pid> -o <fields>` read strictly (a shape surface/scripts/ps-shim/ps answers): the output line; null only for
 * ps's clean "no such process", exit 1 with nothing on stdout or stderr; and a throw for anything else (ps could not be
 * spawned or did not answer in time, another exit code, an error message, or exit 0 with no output), so the guard never reads a failure as gone.
 */
export function psAnswer(run: PsRun, pid: number, fields: string): string | null {
	const r = run(["-p", String(pid), "-o", fields]);
	const out = r.stdout.trim();
	const err = r.stderr.trim();
	if (r.exitCode === 1 && !out && !err) return null;
	if (r.exitCode === 0 && out) return out;
	throw new Error(`ps -p ${pid} -o ${fields} exited ${r.exitCode ?? "by signal"}${err ? `: ${err}` : out ? "" : " with no output"}`);
}

/**
 * A `lane-started:` entry's omp pid against the start time it recorded, over `run` (ps; the tests pass a fake): `same`
 * while that process lives, `other` once the pid names a process with another start time, `gone` when no such process
 * or a zombie. With no start time recorded the pid is asked `-o stat=` only: alive reads `unknown`, absent or a zombie
 * `gone`. A ps that cannot be spawned or answers anything but a clean line or a clean "no such process" reads `failed`,
 * its reason passed to `failure`.
 */
export function ompPidState(pid: number, start: string, run: PsRun = runPs, failure?: (reason: string) => void): PidState {
	try {
		if (!start) {
			const stat = psAnswer(run, pid, "stat=");
			return stat === null || stat.startsWith("Z") ? "gone" : "unknown";
		}
		const out = psAnswer(run, pid, "stat=,lstart=");
		if (out === null) return "gone";
		const now = statStart(out);
		if (now.zombie) return "gone";
		if (!now.start) throw new Error(`ps -p ${pid} -o stat=,lstart= answered no start time: ${out}`);
		return now.start === start ? "same" : "other";
	} catch (err) {
		failure?.(err instanceof Error ? err.message : String(err));
		return "failed";
	}
}
