// The runner's per-run metrics (PLAN wl-mvbcjageg7o2yo § 2.2): one `lane-metrics: <laneId> {json}` per run, written by
// the lane runner (surface/scripts/lane.ts `finish`) in its own write just before the finalization. Everything here is
// pure except `psSampler`, the default RSS sampler the runner injects into `rssMeter`.
import type { Spend } from "./ceiling";

/** The least time between two RSS samples; the runner samples on its stop poll, so never more often than that either. */
export const RSS_SAMPLE_MS = 15_000;
/** The bound on one sampling `ps`; past it ps is SIGKILLed and the sample counts as failed. */
export const RSS_PS_TIMEOUT_MS = 5_000;
/** The sampler's ps arguments: every process with its parent and resident size in KiB, no header. */
export const RSS_PS_ARGS: readonly string[] = ["-A", "-o", "pid=,ppid=,rss="];

/** One sample: the stdout of `ps -A -o pid=,ppid=,rss=`; rejects when ps cannot be spawned, fails or times out. */
export type RssSampler = () => Promise<string>;

/**
 * The default sampler: an async `ps` (never `spawnSync`, so the runner's event loop keeps running under the memory pressure
 * being measured), SIGKILLed past RSS_PS_TIMEOUT_MS. Inside a lane's fence `ps -A` is EPERM: every sample fails and the run
 * records `peakRssMb: null`.
 */
export const psSampler: RssSampler = async () => {
	const p = Bun.spawn(["ps", ...RSS_PS_ARGS], { stdout: "pipe", stderr: "ignore" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		p.kill("SIGKILL");
	}, RSS_PS_TIMEOUT_MS);
	try {
		const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
		if (timedOut) throw new Error(`ps ${RSS_PS_ARGS.join(" ")} did not answer within ${RSS_PS_TIMEOUT_MS} ms and was killed`);
		if (code !== 0) throw new Error(`ps ${RSS_PS_ARGS.join(" ")} exited ${code}`);
		return out;
	} finally {
		clearTimeout(timer);
	}
};

/**
 * The resident size in KiB of `root` and every process below it, from `ps -A -o pid=,ppid=,rss=` text; null when `root` is
 * not in it (gone). An upper bound: a page shared between processes counts once per process. Lines that are not three
 * integers are skipped.
 */
export function treeRssKb(psText: string, root: number): number | null {
	const rss = new Map<number, number>();
	const children = new Map<number, number[]>();
	for (const line of psText.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
		if (!m) continue;
		const pid = Number(m[1]);
		const ppid = Number(m[2]);
		rss.set(pid, Number(m[3]));
		const kids = children.get(ppid);
		if (kids) kids.push(pid);
		else children.set(ppid, [pid]);
	}
	if (!rss.has(root)) return null;
	let total = 0;
	const seen = new Set<number>();
	const queue = [root];
	while (queue.length > 0) {
		const pid = queue.pop()!;
		if (seen.has(pid)) continue;
		seen.add(pid);
		total += rss.get(pid) ?? 0;
		for (const k of children.get(pid) ?? []) queue.push(k);
	}
	return total;
}

/** The runner's peak-RSS meter over one omp process tree. */
export interface RssMeter {
	/**
	 * One poll at `now`: starts a sample of `pid`'s tree unless one is still pending or the last one started less than the
	 * interval ago. Returns the started sample (settled once it is folded in, never rejected), or null when skipped.
	 */
	tick(pid: number, now: number): Promise<void> | null;
	/** The highest tree RSS of any successful sample, in MiB; null when no sample succeeded. */
	readonly peakMb: number | null;
	/** The successful samples so far. */
	readonly samples: number;
}

/** A meter over `sample` (the runner injects `psSampler`; tests a fake). A failed sample, or one without the pid, is skipped. */
export function rssMeter(sample: RssSampler, intervalMs: number = RSS_SAMPLE_MS): RssMeter {
	let pending = false;
	let lastAt = Number.NEGATIVE_INFINITY;
	let peakKb: number | null = null;
	let samples = 0;
	return {
		tick(pid, now) {
			if (pending || now - lastAt < intervalMs) return null;
			lastAt = now;
			pending = true;
			let started: Promise<string>;
			try {
				started = sample();
			} catch (err) {
				started = Promise.reject(err);
			}
			return started.then(
				(text) => {
					const kb = treeRssKb(text, pid);
					if (kb === null) return;
					samples += 1;
					peakKb = peakKb === null ? kb : Math.max(peakKb, kb);
				},
				() => undefined,
			).finally(() => {
				pending = false;
			});
		},
		get peakMb() {
			return peakKb === null ? null : Math.round((peakKb / 1024) * 10) / 10;
		},
		get samples() {
			return samples;
		},
	};
}

/** This run's dollars and tokens: the final `measure()` minus the baseline taken right after the spawn; null when either is missing. */
export function runDelta(final: Spend | null, baseline: Spend | null): { usd: number; tokens: number } | null {
	if (final === null || baseline === null) return null;
	return { usd: Math.max(0, final.usd - baseline.usd), tokens: Math.max(0, final.tokens - baseline.tokens) };
}

/** The `lane-metrics:` record, field for field (PLAN § 2.2). */
export interface LaneMetrics {
	runStart: string;
	runEnd: string;
	/** This run's wall, spawn to finish, to 0.1 min. */
	wallMin: number;
	/** This run's dollars (4 places) and tokens; null when the spend could not be measured. */
	usd: number | null;
	tokens: number | null;
	/** The workload's cumulative dollars at this run's end (the `spend:` figure); null when unmeasured. */
	workloadUsd: number | null;
	model: string | null;
	ranModel: string | null;
	prompts: number;
	continues: number;
	outcome: string;
	peakRssMb: number | null;
	rssSamples: number;
}

/** The record from the runner's state at finish: times in ms, the final and baseline spends as measured (null when not). */
export function laneMetrics(r: {
	runStartMs: number;
	runEndMs: number;
	final: Spend | null;
	baseline: Spend | null;
	model: string | null;
	ranModel: string | null;
	prompts: number;
	continues: number;
	outcome: string;
	peakRssMb: number | null;
	rssSamples: number;
}): LaneMetrics {
	const delta = runDelta(r.final, r.baseline);
	return {
		runStart: new Date(r.runStartMs).toISOString(),
		runEnd: new Date(r.runEndMs).toISOString(),
		wallMin: Math.round(Math.max(0, r.runEndMs - r.runStartMs) / 6_000) / 10,
		usd: delta === null ? null : Math.round(delta.usd * 1e4) / 1e4,
		tokens: delta === null ? null : Math.round(delta.tokens),
		workloadUsd: r.final === null ? null : Math.round(r.final.usd * 1e4) / 1e4,
		model: r.model,
		ranModel: r.ranModel,
		prompts: r.prompts,
		continues: r.continues,
		outcome: r.outcome,
		peakRssMb: r.peakRssMb,
		rssSamples: r.rssSamples,
	};
}

/** `lane-metrics: <laneId> {json}`, the body the runner writes as `lane-runner`. */
export function laneMetricsBody(laneId: string, m: LaneMetrics): string {
	return `lane-metrics: ${laneId} ${JSON.stringify(m)}`;
}
