// The runner's per-run lane-metrics: entry (PLAN wl-mvbcjageg7o2yo § 2.2, R1 and R2). The pure parts (the process-tree RSS
// sum, the meter's skip rules, the run delta and the body) are unit tests; the runner's write is exercised against the
// fake omp (surface/test/fake-omp.ts) with a fake `ps` first on the root's PATH as the injected sampler: it answers the
// sampler's `ps -A -o pid=,ppid=,rss=` with a fixed tree under the fake omp's pid and hands every other ps call to the
// real one. Those runner tests spawn real processes and need a working /bin/ps (lane.ts reads omp's start time), so
// inside a lane's fence they fail and only the full-suite runner checks them.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryRow, LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { parseSpend } from "../src/ceiling";
import { errorLines } from "../src/errors";
import { controlEntries, doneBody, exitClass, laneDecidedBody, laneDir, laneExit, laneExitBody, laneStopAcceptedBody } from "../src/launch";
import { recordRepo } from "../src/decision-log";
import { type LaneMetrics, laneMetrics, laneMetricsBody, runDelta, rssMeter, treeRssKb } from "../src/metrics";
import { SURFACE_BY } from "../src/types";
import { LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, settleDrains, sh, tempLedger, until, workloadWithSlice } from "./helpers";

// ---- pure: the process tree, the meter, the record ---------------------------------------------------

const PS = [
	"    1     0  999999",
	"  500     1   10240",
	"  501   500    2048",
	"  502   501    1024",
	"  503   500     512",
	"  600     1  777777",
	"  601   600    4096",
	"garbage line",
	"",
].join("\n");

describe("treeRssKb: the omp pid and everything below it, from ps -A -o pid=,ppid=,rss= text", () => {
	test("sums the root, its children and grandchildren, and nothing outside the tree", () => {
		expect(treeRssKb(PS, 500)).toBe(10240 + 2048 + 1024 + 512);
		expect(treeRssKb(PS, 501)).toBe(2048 + 1024);
		expect(treeRssKb(PS, 503)).toBe(512);
	});
	test("a pid not in the text (gone) is null; malformed lines are skipped", () => {
		expect(treeRssKb(PS, 4242)).toBeNull();
		expect(treeRssKb("", 500)).toBeNull();
		expect(treeRssKb("500 1 x\n", 500)).toBeNull();
	});
	test("a cycle in the ppid column ends: each pid counts once", () => {
		expect(treeRssKb("10 11 100\n11 10 200\n", 10)).toBe(300);
	});
});

describe("rssMeter: the injected sampler, at most every interval, a pending sample skips, failures skipped", () => {
	test("the peak over successful samples in MiB; the interval throttles", async () => {
		const texts = [`7 1 102400\n8 7 51200\n`, `7 1 409600\n`, `7 1 1024\n`];
		let calls = 0;
		const m = rssMeter(async () => texts[calls++]!, 15_000);
		expect(m.peakMb).toBeNull();
		await m.tick(7, 0);
		expect(m.tick(7, 14_999)).toBeNull();
		await m.tick(7, 15_000);
		await m.tick(7, 30_000);
		expect(calls).toBe(3);
		expect(m.samples).toBe(3);
		expect(m.peakMb).toBe(400);
	});
	test("a sample still pending makes the next tick skip, whatever the interval", async () => {
		let release: (s: string) => void = () => undefined;
		let calls = 0;
		const m = rssMeter(() => {
			calls += 1;
			return new Promise<string>((res) => {
				release = res;
			});
		}, 0);
		const first = m.tick(7, 0)!;
		expect(m.tick(7, 1)).toBeNull();
		expect(m.tick(7, 100_000)).toBeNull();
		expect(calls).toBe(1);
		release("7 1 2048\n");
		await first;
		expect(m.peakMb).toBe(2);
		expect(m.tick(7, 100_001)).not.toBeNull();
		expect(calls).toBe(2);
	});
	test("every sample failing (rejects, throws, or the pid gone) leaves peakMb null and no samples", async () => {
		let n = 0;
		const m = rssMeter(() => {
			n += 1;
			if (n === 1) return Promise.reject(new Error("EPERM"));
			if (n === 2) throw new Error("spawn failed");
			return Promise.resolve("1 0 999\n");
		}, 0);
		await m.tick(7, 0);
		await m.tick(7, 1);
		await m.tick(7, 2);
		expect(n).toBe(3);
		expect(m.peakMb).toBeNull();
		expect(m.samples).toBe(0);
	});
});

describe("the record: run delta and body", () => {
	test("runDelta is final minus baseline; null when either is missing", () => {
		expect(runDelta({ usd: 1.75, tokens: 3000, wallMin: 9 }, { usd: 1.5, tokens: 1000, wallMin: 1 })).toEqual({ usd: 0.25, tokens: 2000 });
		expect(runDelta(null, { usd: 1, tokens: 1, wallMin: 0 })).toBeNull();
		expect(runDelta({ usd: 1, tokens: 1, wallMin: 0 }, null)).toBeNull();
	});
	test("laneMetrics: ISO times, this run's wall, delta usd and tokens, cumulative workloadUsd; the body parses back", () => {
		const m = laneMetrics({
			runStartMs: Date.parse("2026-10-19T10:00:00.000Z"), runEndMs: Date.parse("2026-10-19T10:12:30.000Z"),
			final: { usd: 2.123456, tokens: 5000, wallMin: 40 }, baseline: { usd: 2, tokens: 1000, wallMin: 27 },
			model: "openai-codex/gpt-6-sol", ranModel: "openai-codex/gpt-6-sol", prompts: 3, continues: 2, outcome: "completed", peakRssMb: 812.5, rssSamples: 50,
		});
		expect(m).toEqual({
			runStart: "2026-10-19T10:00:00.000Z", runEnd: "2026-10-19T10:12:30.000Z", wallMin: 12.5, usd: 0.1235, tokens: 4000, workloadUsd: 2.1235,
			model: "openai-codex/gpt-6-sol", ranModel: "openai-codex/gpt-6-sol", prompts: 3, continues: 2, outcome: "completed", peakRssMb: 812.5, rssSamples: 50,
		});
		const body = laneMetricsBody("lane-a", m);
		const [c] = controlEntries([entry(body, LANE_RUNNER_BY)]);
		expect(c).toMatchObject({ prefix: "lane-metrics", laneId: "lane-a" });
		expect(JSON.parse(c!.rest)).toEqual(m);
	});
	test("an unmeasured spend leaves usd, tokens and workloadUsd null", () => {
		const m = laneMetrics({ runStartMs: 0, runEndMs: 60_000, final: null, baseline: null, model: null, ranModel: null, prompts: 1, continues: 0, outcome: "died", peakRssMb: null, rssSamples: 0 });
		expect(m).toMatchObject({ wallMin: 1, usd: null, tokens: null, workloadUsd: null, peakRssMb: null });
	});
});

// ---- R2: the prefix's writer and the exit readers ------------------------------------------------------

let seq = 0;
function entry(body: string, by: string): EntryRow {
	seq += 1;
	return { id: `en-${seq}`, workload_id: "wl-x", slice_id: null, kind: "assumption", body, created_by: by, created_at: `2026-10-19T10:00:${String(seq % 60).padStart(2, "0")}.000Z` } as EntryRow;
}

describe("R2: lane-metrics: is the runner's alone and never hides an exit", () => {
	test("controlEntries keeps lane-metrics: from lane-runner only; the lane and the surface as writers are dropped", () => {
		const body = `lane-metrics: lane-a ${JSON.stringify({ usd: 1 })}`;
		const kept = controlEntries([entry(body, "lane-a"), entry(body, SURFACE_BY), entry(body, LANE_STARTER_BY), entry(body, LANE_RUNNER_BY)], ["lane-a"]);
		expect(kept.map((c) => [c.prefix, c.createdBy])).toEqual([["lane-metrics", LANE_RUNNER_BY]]);
	});
	test("exitClass skips a trailing lane-metrics: (the runner's decision or acceptance before it still decides)", () => {
		const decided = controlEntries([entry(laneDecidedBody("lane-a", "completed"), LANE_RUNNER_BY), entry(laneMetricsBody("lane-a", sample()), LANE_RUNNER_BY)]);
		expect(exitClass(decided, "lane-a")).toBe("intended");
		const stopped = controlEntries([entry(laneStopAcceptedBody("lane-a", "en-1"), LANE_RUNNER_BY), entry(laneMetricsBody("lane-a", sample()), LANE_RUNNER_BY)]);
		expect(exitClass(stopped, "lane-a")).toBe("intended");
	});
	test("idleExit: a lane-metrics: landing after an intended lane-exit: (lane.ts stop's exit, the runner's row after it) leaves the idle line", () => {
		const { ledger } = tempLedger();
		try {
			const { wl } = workloadWithSlice(ledger);
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by surface" });
			expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
			ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-a", { code: 0, signal: null, outcome: "completed" }) });
			ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneMetricsBody("lane-a", sample()) });
			const idle = errorLines(ledger).filter((l) => l.kind === "idle");
			expect(idle).toHaveLength(1);
			expect(idle[0]!.line).toContain(`lane lane-a on ${wl} ended (completed) with 1 open slice(s)`);
		} finally {
			ledger.close();
		}
	});
});

function sample(): LaneMetrics {
	return laneMetrics({ runStartMs: 0, runEndMs: 60_000, final: null, baseline: null, model: null, ranModel: null, prompts: 1, continues: 0, outcome: "completed", peakRssMb: null, rssSamples: 0 });
}

// ---- R1: the runner writes it, against the fake omp ----------------------------------------------------

const roots: LaneRoot[] = [];
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

/**
 * A lane root whose PATH starts with a fake `ps`: `ps -A …` (the sampler) answers a tree under the fake omp's pid (read
 * from the fake's record), 350 MiB on the first call and 200 MiB after; any other ps call goes to the next ps on PATH.
 * The sample interval is shortened so every stop poll samples.
 */
function meteredRoot(): LaneRoot {
	const r = laneRoot({ AGENT_SYSTEM_LANE_RSS_SAMPLE_MS: "1" });
	roots.push(r);
	const calls = join(r.root, "ps-calls");
	writeFileSync(join(r.root, "bin", "ps"), [
		"#!/bin/sh",
		'if [ "$1" != "-A" ]; then',
		'  self=$(cd "$(dirname "$0")" && pwd)',
		"  IFS=:",
		'  for d in $PATH; do [ "$d" = "$self" ] && continue; [ -x "$d/ps" ] && exec "$d/ps" "$@"; done',
		"  exit 127",
		"fi",
		`n=$(cat '${calls}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${calls}'`,
		'pid=$(head -n 1 "$FAKE_OMP_RECORD" 2>/dev/null | cut -d, -f1 | cut -d: -f2)',
		'[ -n "$pid" ] || exit 1',
		'if [ "$n" = 1 ]; then top=204800; else top=51200; fi',
		`printf '1 0 999999\\n%s 1 %s\\n900001 %s 102400\\n900002 900001 51200\\n900003 1 777777\\n' "$pid" "$top" "$pid"`,
		"",
	].join("\n"));
	chmodSync(join(r.root, "bin", "ps"), 0o755);
	return r;
}

function openWorkload(r: LaneRoot): string {
	const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "lane metrics probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		return wl;
	} finally {
		l.close();
	}
}

/** An earlier run's usage in the workload's sessions dir: the cumulative spend: counts it, this run's delta must not. */
function earlierUsage(r: LaneRoot, wl: string, usd: number, tokens: number): void {
	const dir = join(laneDir(wl, r.home), "sessions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "earlier.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: tokens, cost: { total: usd } } } })}\n`);
}

const launch = (r: LaneRoot, wl: string) => sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "test"], r.repo, r.env);
const exitOf = (r: LaneRoot, wl: string, laneId: string) => until(`lane-exit: of ${laneId}`, () => laneExit(laneSnapshot(r, wl).control, laneId));

describe("R1: the runner's one lane-metrics: per run (fake omp, injected sampler)", () => {
	test("one lane-metrics: by lane-runner, after lane-decided: and before spend: and lane-exit:, with this run's delta (the baseline subtracted) and the sampler's peak", async () => {
		const r = meteredRoot();
		const wl = openWorkload(r);
		earlierUsage(r, wl, 0.5, 1000);
		// two stop polls (STOP_POLL_MS 5 s) land inside the 11 s: two samples, the first the larger
		writeFileSync(r.script, JSON.stringify({
			steps: [{ usage: { usd: 0.25, tokens: 300 } }, { sleepMs: 11_000 }, { tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }],
		}));
		expect(launch(r, wl).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "completed" });
		const snap = laneSnapshot(r, wl);
		const metrics = snap.control.filter((c) => c.prefix === "lane-metrics");
		expect(metrics).toHaveLength(1);
		expect(metrics[0]!).toMatchObject({ laneId, createdBy: LANE_RUNNER_BY });
		const order = snap.control.filter((c) => c.laneId === laneId && c.prefix !== "ctx-index").map((c) => c.prefix);
		expect(order.slice(-4)).toEqual(["lane-decided", "lane-metrics", "spend", "lane-exit"]);
		const m = JSON.parse(metrics[0]!.rest) as LaneMetrics;
		expect(m.usd).toBeCloseTo(0.25, 4);
		expect(m.tokens).toBe(300);
		expect(m.workloadUsd).toBeCloseTo(0.75, 4);
		const spend = parseSpend(snap.control.find((c) => c.prefix === "spend" && c.laneId === laneId)!.rest)!;
		expect(spend).toMatchObject({ tokens: 1300 });
		expect(m).toMatchObject({ outcome: "completed", prompts: 1, continues: 0, model: null, ranModel: null, peakRssMb: 350 });
		expect(m.rssSamples).toBeGreaterThanOrEqual(2);
		expect(m.wallMin).toBeGreaterThan(0);
		expect(Date.parse(m.runEnd)).toBeGreaterThan(Date.parse(m.runStart));
	}, 60_000);

	test("a failed lane-metrics: write goes to the runner log; the release, spend: and lane-exit: still land", async () => {
		const r = meteredRoot();
		const wl = openWorkload(r);
		const db = new Database(r.ledgerPath);
		try {
			db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON entries WHEN NEW.body LIKE 'lane-metrics:%' BEGIN SELECT RAISE(ABORT, 'injected metrics failure'); END;");
		} finally {
			db.close();
		}
		writeFileSync(r.script, JSON.stringify({ steps: [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }] }));
		expect(launch(r, wl).code).toBe(0);
		const laneId = laneIdOf(wl, 1);
		expect(await exitOf(r, wl, laneId)).toMatchObject({ outcome: "completed" });
		const snap = laneSnapshot(r, wl);
		expect(snap.workload!.holder).toBeNull();
		expect(snap.deaths).toEqual([]);
		expect(snap.control.filter((c) => c.prefix === "lane-metrics")).toEqual([]);
		expect(snap.control.filter((c) => c.laneId === laneId).map((c) => c.prefix)).toContain("spend");
		const log = join(laneDir(wl, r.home), "runner.log");
		await until("the runner log's metrics failure line", () => existsSync(log) && readFileSync(log, "utf8").includes("the lane-metrics: entry could not be written") && readFileSync(log, "utf8").includes("injected metrics failure"), 10_000);
	}, 60_000);
});
