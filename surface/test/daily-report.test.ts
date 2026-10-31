// The daily self-heal report (PLAN wl-mvbcjageg7o2yo § 2.4, § 2.6), driven through surface/scripts/daily-report.ts's
// `dailyReport` against a temp HOME and a temp ledger under it, with fake detectors (the real readers and detectors
// have their own tests): one run writes its report file and exactly one `daily-report:` entry on the standing workload
// (R11); a same-date rerun writes neither and deletes its own file; the window starts at the previous report's `to`,
// and is capped at 7 days; a failed entry write removes the file; --dry-run writes nothing. `errorLines` renders only
// the newest entry, as one line, then the missed line from 30 h to 7 days only while the job's plist exists, then
// nothing (R12). The counts are right by cause (R13), and `daily-report:` is valid only from its writer (R20).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryRow, LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { dailyReport, parseArgs, readCountRows, type ReportArgs, type ReportDeps, reportDir } from "../scripts/daily-report";
import { errorLines, reportPlistInstalled } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, DAILY_REPORT_BY, laneDiedDeadlineBody, laneDiedExitBody, laneDiedLaunchBody } from "../src/launch";
import { laneMetrics, laneMetricsBody } from "../src/metrics";
import type { DetectorInputs } from "../src/selfheal/detectors";
import { computeCounts, type CountRows, deathCause, inWindow } from "../src/selfheal/counts";
import type { Finding, Window } from "../src/selfheal/types";
import { laneDiedShutdownBody, recordLapsedLease } from "../src/signals";
import { releasedOpenDeathBody } from "../src/turn-end";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tmp } from "./helpers";

const HOUR = 3_600_000;
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface World {
	home: string;
	ledgerPath: string;
	ledger: Ledger;
	at: (iso: string) => void;
}

function world(start = "2026-10-19T12:00:00.000Z"): World {
	const home = realpathSync(tmp("daily-report-home"));
	dirs.push(home);
	const ledgerPath = join(home, ".agent-system-2", "ledger.db");
	const c = clock(start);
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: c.now });
	return { home, ledgerPath, ledger, at: c.at };
}

const plus = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR).toISOString();
const localDate = (iso: string): string => {
	const t = new Date(iso);
	return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

const finding = (detector: Finding["detector"], at: string): Finding => ({ detector, at, workloadId: "wl-x", laneId: null, summary: `${detector} fired`, evidence: "fixture" });

/** Fake detectors: every finding inside the window, and each window the reader was asked for. */
function fakeDeps(findings: Finding[] = [], seen: Window[] = []): ReportDeps {
	return {
		readDetectorInputs: async (o) => {
			seen.push(o.window);
			return {} as DetectorInputs;
		},
		runDetectors: (_inputs, w) => findings.filter((f) => inWindow(f.at, w)),
	};
}

const args = (w: World, now: string, over: Partial<ReportArgs> = {}): ReportArgs => ({ dryRun: false, home: w.home, now: new Date(now), ...over });

/** The standing workload's entries by the report's writer, read on a fresh handle. */
function reportRows(w: World): EntryRow[] {
	const l = Ledger.open(w.ledgerPath, { readonly: true });
	try {
		return l.workload(STANDING_WORKLOAD_ID) ? l.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.created_by === DAILY_REPORT_BY) : [];
	} finally {
		l.close();
	}
}

const filesIn = (w: World): string[] => (existsSync(reportDir(w.home)) ? readdirSync(reportDir(w.home)).sort() : []);

/** A `daily-report:` body as the script writes it, for seeding. */
const seededBody = (date: string, from: string, to: string): string => `daily-report: ${date} window ${from}..${to} findings 0 deaths 0 lapsed 0 held-closed 0 — /seeded/${date}.md`;

describe("daily report: one run, one file, one entry (R11)", () => {
	test("one run writes the report file and exactly one daily-report: entry naming it", async () => {
		const w = world();
		const now = "2026-10-19T14:00:00.000Z";
		const findings = [finding("jetsam", plus(now, -2)), finding("paste-drop", plus(now, -3)), finding("paste-drop", plus(now, -30))];
		const r = await dailyReport(args(w, now), {}, fakeDeps(findings));
		expect(r.exit).toBe(0);
		const date = localDate(now);
		expect(r.reportPath).not.toBeNull();
		expect(r.reportPath!.startsWith(`${reportDir(w.home)}/${date}-`)).toBe(true);
		expect(filesIn(w)).toHaveLength(1);
		expect(filesIn(w)[0]).toMatch(new RegExp(`^${date}-\\d{6}-${process.pid}\\.md$`));
		const text = readFileSync(r.reportPath!, "utf8");
		expect(text).toContain(`# daily self-heal report ${date}`);
		expect(text).toContain("- by detector: paste-drop 1, jetsam 1");
		const rows = reportRows(w);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe(r.entry!);
		expect(rows[0]!.body).toBe(`daily-report: ${date} window ${plus(now, -24)}..${now} findings 2 (paste-drop 1, jetsam 1) deaths 0 lapsed 0 held-closed 0 — ${r.reportPath}`);
	});

	test("a same-date rerun writes no entry and deletes its own file; the first file stays", async () => {
		const w = world();
		const now = "2026-10-19T14:00:00.000Z";
		const first = await dailyReport(args(w, now), {}, fakeDeps());
		expect(first.exit).toBe(0);
		const again = await dailyReport(args(w, plus(now, 1 / 60)), {}, fakeDeps());
		expect(again.exit).toBe(0);
		expect(again.entry).toBeNull();
		expect(again.reportPath).toBeNull();
		expect(again.ledgerLine).toContain(`already has its entry (${first.entry})`);
		expect(filesIn(w)).toEqual([first.reportPath!.slice(reportDir(w.home).length + 1)]);
		expect(reportRows(w).map((e) => e.id)).toEqual([first.entry!]);
	});

	test("the window starts at the previous report's to; with none, 24 h back", async () => {
		const w = world();
		const seen: Window[] = [];
		const day1 = "2026-10-19T14:00:00.000Z";
		await dailyReport(args(w, day1), {}, fakeDeps([], seen));
		const day2 = plus(day1, 25);
		const r = await dailyReport(args(w, day2), {}, fakeDeps([], seen));
		expect(seen).toEqual([{ from: plus(day1, -24), to: day1 }, { from: day1, to: day2 }]);
		expect(r.body).toContain(`window ${day1}..${day2} `);
		expect(reportRows(w)).toHaveLength(2);
	});

	test("a previous report older than 7 days caps the window at 7 days and says so", async () => {
		const w = world("2026-10-05T07:00:00.000Z");
		ensureStandingWorkload(w.ledger);
		w.ledger.recordEntry({ by: DAILY_REPORT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: seededBody("2026-10-05", "2026-10-04T07:00:00.000Z", "2026-10-05T07:00:00.000Z") });
		const seen: Window[] = [];
		const now = "2026-10-19T14:00:00.000Z";
		const r = await dailyReport(args(w, now), {}, fakeDeps([], seen));
		expect(seen).toEqual([{ from: plus(now, -7 * 24), to: now }]);
		expect(r.report).toContain("capped at 7 days before the run");
		expect(r.report).toContain("the previous report's window ended 2026-10-05T07:00:00.000Z");
	});

	test("a failed entry write removes the report file and leaves no entry (exit 1)", async () => {
		const w = world();
		const r = await dailyReport(args(w, "2026-10-19T14:00:00.000Z"), {}, fakeDeps(), {
			inLock: () => {
				throw new Error("disk I/O error (injected)");
			},
		});
		expect(r.exit).toBe(1);
		expect(r.reportPath).toBeNull();
		expect(r.ledgerLine).toContain("the entry could not be written (disk I/O error (injected))");
		expect(filesIn(w)).toEqual([]);
		expect(reportRows(w)).toEqual([]);
	});

	test("--dry-run prints the report and the entry it would write, and writes nothing", async () => {
		const w = world();
		const r = await dailyReport(args(w, "2026-10-19T14:00:00.000Z", { dryRun: true }), {}, fakeDeps([finding("flaky-test", "2026-10-19T13:00:00.000Z")]));
		expect(r.exit).toBe(0);
		expect(r.report).toContain("(dry run: nothing written)");
		expect(r.ledgerLine).toStartWith(`would write on ${STANDING_WORKLOAD_ID}: daily-report: `);
		expect(r.ledgerLine).toContain("findings 1 (flaky-test 1)");
		expect(existsSync(reportDir(w.home))).toBe(false);
		expect(reportRows(w)).toEqual([]);
	});

	test("an unreadable ledger writes nothing (exit 1); a bad argument is refused", async () => {
		const home = realpathSync(tmp("daily-report-noledger"));
		dirs.push(home);
		const r = await dailyReport({ dryRun: false, home, now: new Date("2026-10-19T14:00:00.000Z") }, {}, fakeDeps());
		expect(r.exit).toBe(1);
		expect(r.ledgerLine).toContain("could not be read");
		expect(existsSync(reportDir(home))).toBe(false);
		expect(parseArgs(["--now", "yesterday"])).toBe("--now needs an ISO-8601 time");
		expect(parseArgs(["--home", "relative"])).toBe("--home needs an absolute directory");
		expect(parseArgs(["--bogus"])).toBe('unknown argument "--bogus"');
		expect(parseArgs(["--dry-run", "--home", "/h", "--now", "2026-10-19T14:00:00.000Z"], "/x")).toEqual({ dryRun: true, home: "/h", now: new Date("2026-10-19T14:00:00.000Z") });
	});
});

describe("daily report: the needs-you line (R12)", () => {
	const reportLines = (l: Ledger, now: string, installed: () => boolean) => errorLines(l, l.inFlight(), { now, reportJobInstalled: installed }).filter((x) => x.kind === "report");

	test("two entries: exactly one line, the newest's", () => {
		const w = world("2026-10-18T07:00:00.000Z");
		ensureStandingWorkload(w.ledger);
		w.ledger.recordEntry({ by: DAILY_REPORT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: seededBody("2026-10-18", "2026-10-17T07:00:00.000Z", "2026-10-18T07:00:00.000Z") });
		w.at("2026-10-19T07:00:00.000Z");
		const newest = seededBody("2026-10-19", "2026-10-18T07:00:00.000Z", "2026-10-19T07:00:00.000Z");
		const id = w.ledger.recordEntry({ by: DAILY_REPORT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: newest });
		const lines = reportLines(w.ledger, "2026-10-19T08:00:00.000Z", () => true);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.rowId).toBe(id);
		expect(lines[0]!.workloadId).toBe(STANDING_WORKLOAD_ID);
		expect(lines[0]!.line).toBe(`daily self-heal report ${newest.slice("daily-report: ".length)}`);
	});

	test("the missed line from 30 h, only while the plist exists; nothing from 7 days; nothing with no entry", () => {
		const t = "2026-10-19T07:00:00.000Z";
		const w = world(t);
		ensureStandingWorkload(w.ledger);
		expect(reportLines(w.ledger, t, () => true)).toEqual([]);
		const id = w.ledger.recordEntry({ by: DAILY_REPORT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: seededBody("2026-10-19", "2026-10-18T07:00:00.000Z", t) });
		const plist = join(w.home, "Library", "LaunchAgents", "com.agent-system-2.daily-report.plist");
		const installed = () => reportPlistInstalled(w.home);
		expect(installed()).toBe(false);
		// Under 30 h: the report line, plist or not.
		expect(reportLines(w.ledger, plus(t, 29.9), installed).map((l) => l.line)).toEqual([`daily self-heal report ${seededBody("2026-10-19", "2026-10-18T07:00:00.000Z", t).slice(14)}`]);
		// 30 h with no plist: nothing.
		expect(reportLines(w.ledger, plus(t, 30), installed)).toEqual([]);
		mkdirSync(join(w.home, "Library", "LaunchAgents"), { recursive: true });
		writeFileSync(plist, "<plist/>\n");
		expect(installed()).toBe(true);
		const missed = reportLines(w.ledger, plus(t, 30), installed);
		expect(missed).toEqual([{ kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: id, state: "missed", next: "check com.agent-system-2.daily-report", line: "daily self-heal report missed: the newest is 2026-10-19 (30 h); check com.agent-system-2.daily-report" }]);
		expect(reportLines(w.ledger, plus(t, 7 * 24 - 0.1), installed)).toHaveLength(1);
		// 7 days and later: nothing, plist or not.
		expect(reportLines(w.ledger, plus(t, 7 * 24), installed)).toEqual([]);
		expect(reportLines(w.ledger, plus(t, 30 * 24), installed)).toEqual([]);
	});
});

describe("daily report: counts (R13)", () => {
	const w: Window = { from: "2026-10-18T14:00:00.000Z", to: "2026-10-19T14:00:00.000Z" };
	const inside = "2026-10-19T10:00:00.000Z";
	const outside = "2026-10-17T10:00:00.000Z";

	test("each lane-died: body gets its cause; unknown ones are other: <first words>", () => {
		expect(deathCause("lane-died: lane-a-1: lease lapsed 2026-10-19T09:00:00.000Z")).toBe("lease lapsed");
		expect(deathCause(laneDiedShutdownBody("lane-a-1", inside, 2))).toBe("session shutdown");
		expect(deathCause(laneDiedExitBody("lane-a-1", "error", 1, null))).toBe("runner exit");
		expect(deathCause(laneDiedExitBody("lane-a-1", "died", null, "SIGKILL"))).toBe("runner exit");
		expect(deathCause(laneDiedDeadlineBody("lane-a-1", "370m", 3))).toBe("deadline");
		expect(deathCause(laneDiedLaunchBody("lane-a-1", "readiness", "no claim in 5m"))).toBe("never-ready");
		expect(deathCause(releasedOpenDeathBody("lane-a-1", 1))).toBe("other: released with");
		expect(deathCause("lane-died: lane-a-1: prompt ended error: provider/model: 429 (retryable true)")).toBe("other: prompt ended error");
	});

	test("deaths in the window by cause, lapsed leases recorded and unrecorded, held messages on closed workloads, lane runs", () => {
		const death = (id: string, body: string, createdAt = inside) => ({ id, workloadId: "wl-a", body, createdAt });
		const entry = (id: string, body: string, by: string, createdAt = inside): EntryRow => ({ id, workload_id: "wl-a", slice_id: null, kind: "assumption", body, created_by: by, created_at: createdAt });
		const metrics = (peak: number | null, usd: number, ranModel: string) =>
			laneMetricsBody("lane-m-1", laneMetrics({ runStartMs: Date.parse(inside) - 30 * 60_000, runEndMs: Date.parse(inside), final: { usd: usd + 1, tokens: 10 }, baseline: { usd: 1, tokens: 0 }, model: null, ranModel, prompts: 1, continues: 0, outcome: "completed", peakRssMb: peak, rssSamples: 3 }));
		const rows: CountRows = {
			deaths: [
				death("m1", "lane-died: lane-a-1: lease lapsed 2026-10-19T09:00:00.000Z"),
				death("m2", "lane-died: lane-a-2: lease lapsed 2026-10-19T09:30:00.000Z"),
				death("m3", laneDiedShutdownBody("lane-a-3", inside, 1)),
				death("m4", laneDiedExitBody("lane-u-1", "error", 1, null)),
				death("m5", laneDiedDeadlineBody("lane-a-5", "370m", 3)),
				death("m6", laneDiedLaunchBody("lane-a-6", "worktree", "lock")),
				death("m7", releasedOpenDeathBody("lane-a-7", 1)),
				death("m8", laneDiedShutdownBody("lane-a-8", outside, 1), outside),
			],
			unrecordedLapses: [{ workloadId: "wl-b", holder: "lane-b-1", leaseUntil: "2026-10-19T13:00:00.000Z" }],
			heldClosed: [{ id: "h1", workloadId: "wl-c", createdAt: outside }, { id: "h2", workloadId: "wl-c", createdAt: inside }, { id: "h3", workloadId: "wl-d", createdAt: inside }],
			lanes: controlEntries([
				entry("e1", "lane-started: lane-m-1 {}", LANE_RUNNER_BY),
				entry("e2", metrics(400, 2, "anthropic/claude-opus-5-5"), LANE_RUNNER_BY),
				entry("e3", "lane-started: lane-m-2 {}", LANE_RUNNER_BY),
				entry("e4", metrics(200, 1, "openai-codex/gpt-6.1-sol").replace("lane-m-1", "lane-m-2"), LANE_RUNNER_BY),
				entry("e5", "lane-started: lane-x-1 {}", LANE_RUNNER_BY),
				entry("e6", "lane-exit: lane-x-1 code 1 signal - outcome error", LANE_RUNNER_BY),
				entry("e7", "lane-started: lane-u-1 {}", LANE_RUNNER_BY, outside),
				entry("e8", "lane-started: lane-i-1 {}", LANE_STARTER_BY),
				entry("e9", "lane-exit: lane-i-1 code 0 signal - outcome interactive", LANE_STARTER_BY),
				// A forged metrics row (not the runner's) is dropped by controlEntries.
				entry("e10", metrics(9999, 50, "forged/model").replace("lane-m-1", "lane-f-1"), "lane-f-1"),
			]),
		};
		const c = computeCounts(rows, w);
		expect(c.deaths).toEqual({
			total: 7,
			byCause: [["lease lapsed", 2], ["session shutdown", 1], ["runner exit", 1], ["deadline", 1], ["never-ready", 1], ["other: released with", 1]],
		});
		expect(c.lapsed).toEqual({ total: 3, recorded: 2, unrecorded: rows.unrecordedLapses as never });
		expect(c.heldClosed).toEqual({ total: 3, inWindow: 2, workloads: 2 });
		expect(c.lanes).toEqual({
			runs: 2,
			wallMin: 60,
			usdByModel: [["anthropic/claude-opus-5-5", 2], ["openai-codex/gpt-6.1-sol", 1]],
			peakRssMb: { p50: 200, max: 400, samples: 2 },
			unmetered: ["lane-u-1", "lane-x-1"],
			interactive: ["lane-i-1"],
		});
	});

	test("the reader finds held messages on closed workloads and a lapse no lane-died: row records yet", () => {
		const t = "2026-10-19T10:00:00.000Z";
		const wd = world(t);
		const l = wd.ledger;
		const closed = l.openWorkload({ by: SURFACE_BY, brief: "closed one", stakes: "normal", mode: "autonomous" });
		l.enqueue({ by: "lane-c-1", workloadId: closed, sender: "lane-c-1", recipient: ORCHESTRATOR_RECIPIENT, body: "placeholder message" });
		l.closeWorkload(closed, { by: SURFACE_BY });
		const open = l.openWorkload({ by: SURFACE_BY, brief: "open one", stakes: "normal", mode: "autonomous" });
		l.enqueue({ by: "lane-o-1", workloadId: open, sender: "lane-o-1", recipient: ORCHESTRATOR_RECIPIENT, body: "placeholder message" });
		const lapsed = l.openWorkload({ by: SURFACE_BY, brief: "lapsed one", stakes: "normal", mode: "autonomous" });
		expect(l.claimWorkload(lapsed, { by: "lane-l-1", holder: "lane-l-1", leaseMs: HOUR }).won).toBe(true);
		const recorded = l.openWorkload({ by: SURFACE_BY, brief: "recorded one", stakes: "normal", mode: "autonomous" });
		expect(l.claimWorkload(recorded, { by: "lane-r-1", holder: "lane-r-1", leaseMs: HOUR }).won).toBe(true);
		const now = plus(t, 2);
		expect(recordLapsedLease(l, l.workload(recorded)!, SURFACE_BY, now)).not.toBeNull();
		const rows = readCountRows(l, now);
		expect(rows.heldClosed.map((m) => m.workloadId)).toEqual([closed]);
		expect(rows.unrecordedLapses).toEqual([{ workloadId: lapsed, holder: "lane-l-1", leaseUntil: plus(t, 1) }]);
		expect(rows.deaths.map((d) => d.workloadId)).toEqual([recorded]);
		const c = computeCounts(rows, { from: t, to: plus(now, 1) });
		expect(c.lapsed).toEqual({ total: 2, recorded: 1, unrecorded: rows.unrecordedLapses as never });
	});
});

describe("daily report: the control prefix (R20)", () => {
	test("controlEntries keeps a daily-report: entry only from the daily-report writer, and errorLines ignores a forged one", () => {
		const t = "2026-10-19T07:00:00.000Z";
		const w = world(t);
		ensureStandingWorkload(w.ledger);
		const body = seededBody("2026-10-19", "2026-10-18T07:00:00.000Z", t);
		for (const by of [SURFACE_BY, "lane-x-1", LANE_RUNNER_BY, "scratch-sweep"]) w.ledger.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		expect(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID)).filter((c) => c.prefix === "daily-report")).toEqual([]);
		expect(errorLines(w.ledger, w.ledger.inFlight(), { now: t, reportJobInstalled: () => true }).filter((x) => x.kind === "report")).toEqual([]);
		const id = w.ledger.recordEntry({ by: DAILY_REPORT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		expect(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID)).filter((c) => c.prefix === "daily-report").map((c) => c.id)).toEqual([id]);
	});
});
