// PR-F red tests (PLAN.md § 3a, row F1): the flow signals over a seeded scratch ledger.
//
// Interfaces this file fixes for sl-flow-build:
//  * Time injection: `surface/scripts/flow-signals.ts` reads the clock from the env var `AS2_NOW` (an ISO-8601
//    UTC instant) when it is set, else the real clock. The test sets AS2_NOW=2026-10-14T19:45:00.000Z, which is
//    12:45 America/Los_Angeles (PDT, UTC-7) on 2026-10-14. 12:45, not 12:00, because the fallback script writes
//    only when it is past 12:30 Pacific (§ 3a, "Fallback when the orchestrator is down").
//  * `check()` in surface/scripts/invariants.ts gains `Input.cap: number` (the live lane cap); the flow findings
//    carry `invariant: "flow-open"` etc. The test passes `cap: 3`.
//  * The script's entry on `wl-orchestrator` starts `flow-signals: 2026-10-14` (the Pacific date) and carries
//    `open 7/6` (open workloads besides wl-orchestrator / 2 x cap) and `cap 3`.
// No module that did not exist yet was imported statically there; the script is spawned.
//
// PR-F's own tests (row F2) follow the two red ones: each signal red/green at its threshold ±1 (signal 5 red on
// headroom skips alone), net flow over the previous full Pacific day across the 2026-11-01 DST change, the fallback's
// 12:30 gate and its copied cap, the timer and the fallback racing on a date, and the streak. The timer's own noon write
// is tested in surface/test/invariant-timer.test.ts.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../../ledger/src/index";
import { check, type Input } from "../scripts/invariants";
import { main } from "../scripts/flow-signals";
import { addDays, type FlowSignals, flowSignals, pacificDate, pacificMidnight, pacificSeconds, writeFlowSignals } from "../src/flow";
import { ensureStandingWorkload } from "../src/identity";
import { FLOW_SIGNALS_BY } from "../src/launch";
import { STANDING_BRIEF, STANDING_WORKLOAD_ID } from "../src/types";
import { clock, tempLedger } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "flow-signals.ts");
const NOW = "2026-10-14T19:45:00.000Z"; // 12:45 America/Los_Angeles
const DATE = "2026-10-14";
const OPENED = "2026-10-13T17:00:00.000Z";

const dir = mkdtempSync(join(tmpdir(), "flow-signals-"));
const ledgerPath = join(dir, "ledger.db");

function seed(): void {
	const now = OPENED;
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: () => now, skipLocalityCheck: true });
	ledger.openWorkload({ by: "orchestrator-surface", brief: STANDING_BRIEF, stakes: "normal", mode: "autonomous", id: STANDING_WORKLOAD_ID });
	for (let i = 1; i <= 7; i++) {
		ledger.openWorkload({ by: "orchestrator", brief: `flow fixture ${i}`, stakes: "normal", mode: "autonomous", id: `wl-flow-${i}` });
	}
	ledger.close();
}
seed();

describe("flow signals over 7 open workloads, cap 3, 12:45 Pacific", () => {
	test("the fallback script writes exactly one flow-signals entry on wl-orchestrator with open 7/6 and cap 3", () => {
		const r = spawnSync("bun", [SCRIPT], {
			cwd: join(import.meta.dir, "..", ".."),
			encoding: "utf8",
			env: { ...process.env, HOME: dir, AGENT_SYSTEM_LEDGER_DB: ledgerPath, AGENT_SYSTEM_MAX_LANES: "3", AS2_NOW: NOW },
		});
		const db = new Database(ledgerPath, { readonly: true });
		const rows = db.query<{ body: string }, [string]>("SELECT body FROM entries WHERE workload_id = ? AND body LIKE 'flow-signals:%'").all(STANDING_WORKLOAD_ID);
		db.close();
		expect({ status: r.status, entries: rows.length }, `stderr: ${r.stderr}`).toEqual({ status: 0, entries: 1 });
		const body = rows[0]!.body;
		expect(body.startsWith(`flow-signals: ${DATE}`)).toBe(true);
		expect(body).toContain("open 7/6");
		expect(body).toContain("cap 3");
	});

	test("check() reports flow-open for the same state", () => {
		const db = new Database(ledgerPath, { readonly: true });
		try {
			const input = {
				db, asOf: NOW, replay: false, liveLanes: { found: new Set<string>() }, lanesDirOf: () => "/nonexistent/lanes",
				repo: "/nonexistent/checkout", git: null, orchestrators: () => ({ skipped: "not probed in this test" }),
				backups: { dir: "/nonexistent/backups", gapMs: 1 }, cap: 3,
			} as Input;
			const report = check(input);
			expect(report.findings.map((f) => f.invariant)).toContain("flow-open");
		} finally {
			db.close();
		}
	});
});

// ---- F2 ---------------------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const at = (iso: string, deltaH: number) => new Date(Date.parse(iso) + deltaH * HOUR).toISOString();

/** A fresh ledger with the standing workload, seeded by `seed` on a clock it may move; the signals at `asOf`, cap `cap`. */
function signalsOver(seed: (l: Ledger, c: { at(iso: string): void; plusHours(h: number): void }) => void, asOf = NOW, cap = 3): FlowSignals {
	const c = clock(at(asOf, -1));
	const { ledger, path } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	seed(ledger, c);
	ledger.close();
	const db = new Database(path, { readonly: true });
	try {
		return flowSignals(db, asOf, cap);
	} finally {
		db.close();
	}
}
const open = (l: Ledger, n: number, tag = "w") => Array.from({ length: n }, (_, i) => l.openWorkload({ by: "orchestrator", brief: `${tag} ${i}`, stakes: "normal", mode: "autonomous" }));

describe("each signal at its threshold ±1 (cap 3)", () => {
	test("open: red above 2 × cap", () => {
		for (const [n, red] of [[5, false], [6, false], [7, true]] as const) {
			const f = signalsOver((l) => void open(l, n));
			expect({ n, open: f.open }).toEqual({ n, open: { n, t: 6, red } });
		}
	});

	test("quiet: red at or over the cap (no real progress for 24 h)", () => {
		for (const [n, red] of [[2, false], [3, true], [4, true]] as const) {
			const f = signalsOver((l, c) => {
				c.at(at(NOW, -25));
				open(l, n, "quiet");
				c.at(at(NOW, -23));
				open(l, 2, "busy");
			});
			expect({ n, quiet: f.quiet }).toEqual({ n, quiet: { n, t: 3, red } });
		}
	});

	test("dead: red at or over the cap (a lane-died at or after the last launch)", () => {
		for (const [n, red] of [[2, false], [3, true], [4, true]] as const) {
			const f = signalsOver((l, c) => {
				const ids = open(l, n + 1, "dead");
				for (const wl of ids) {
					l.recordEntry({ by: "orchestrator-surface", workloadId: wl, kind: "assumption", body: "launch: lane-1 pid 1" });
					c.plusHours(0.01);
					l.enqueue({ by: "orchestrator-surface", workloadId: wl, sender: "orchestrator-surface", recipient: "orchestrator", body: "lane-died: lane-1 exit 1" });
				}
				// The last one was relaunched after its death: not dead.
				c.plusHours(0.01);
				l.recordEntry({ by: "orchestrator-surface", workloadId: ids.at(-1)!, kind: "assumption", body: "launch: lane-2 pid 2" });
			});
			expect({ n, dead: f.dead }).toEqual({ n, dead: { n, t: 3, red } });
		}
	});

	test("questions: red above 20 in the 24 h to as-of", () => {
		for (const [n, red] of [[19, false], [20, false], [21, true]] as const) {
			const f = signalsOver((l, c) => {
				const [wl] = open(l, 1);
				const sl = l.addSlice({ by: "lane-a", workloadId: wl!, task: "t", doneCondition: "d", inputs: "i" });
				c.at(at(NOW, -25));
				l.raiseQuestion({ by: "lane-a", workloadId: wl!, sliceId: sl, body: "older than the window", options: ["a", "b"] });
				c.at(at(NOW, -2));
				for (let i = 0; i < n; i++) l.raiseQuestion({ by: "lane-a", workloadId: wl!, sliceId: sl, body: `q ${i}`, options: ["a", "b"] });
			});
			expect({ n, questions: f.questions }).toEqual({ n, questions: { n, t: 20, red } });
		}
	});

	test("provider: red on any provider-error message, or on more than 5 headroom skips alone", () => {
		const provider = (errors: number, skips: number) => signalsOver((l, c) => {
			const [wl] = open(l, 1);
			c.at(at(NOW, -25));
			l.enqueue({ by: "lane-a", workloadId: wl!, sender: "lane-a", recipient: "orchestrator", body: "HTTP 429 outside the window" });
			c.at(at(NOW, -2));
			for (let i = 0; i < errors; i++) l.enqueue({ by: "lane-a", workloadId: wl!, sender: "lane-a", recipient: "orchestrator", body: `provider said: insufficient balance ${i}` });
			for (let i = 0; i < skips; i++) l.recordEntry({ by: "orchestrator-surface", workloadId: wl!, kind: "assumption", body: `headroom-skip: lab ${i}` });
		}).provider;
		expect(provider(0, 0)).toEqual({ errors: 0, skips: 0, red: false });
		expect(provider(1, 0)).toEqual({ errors: 1, skips: 0, red: true });
		expect(provider(0, 5)).toEqual({ errors: 0, skips: 5, red: false });
		expect(provider(0, 6)).toEqual({ errors: 0, skips: 6, red: true });
	});

	test("green counts the five; net flow is shown and never counted", () => {
		const f = signalsOver((l, c) => {
			c.at(at(NOW, -20)); // 2026-10-13 23:45 PDT: the previous full Pacific day
			const ids = open(l, 3, "yesterday");
			l.closeWorkload(ids[0]!, { by: "orchestrator" });
		});
		expect(f.green).toBe(5);
		expect(f.net).toEqual({ day: "2026-10-13", opened: 3, closed: 1 });
		expect(signalsOver((l) => void open(l, 7)).green).toBe(4);
	});
});

describe("Pacific days come from the zone database", () => {
	test("2026-11-01 (the DST change) is 25 hours, and net flow counts it by Pacific wall clock", () => {
		expect(pacificMidnight("2026-11-01")).toBe("2026-11-01T07:00:00.000Z");
		expect(pacificMidnight("2026-11-02")).toBe("2026-11-02T08:00:00.000Z");
		expect(pacificMidnight("2026-03-08")).toBe("2026-03-08T08:00:00.000Z");
		expect(pacificMidnight("2026-03-09")).toBe("2026-03-09T07:00:00.000Z");
		expect(pacificDate("2026-11-02T07:30:00.000Z")).toBe("2026-11-01"); // 23:30 PST
		expect(pacificSeconds("2026-11-02T20:00:00.000Z")).toBe(12 * 3600); // noon PST
		expect(pacificSeconds("2026-10-31T19:00:00.000Z")).toBe(12 * 3600); // noon PDT
		expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
		const f = signalsOver((l, c) => {
			for (const t of ["2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z", "2026-11-02T07:30:00.000Z", "2026-11-02T08:30:00.000Z"]) {
				c.at(t);
				open(l, 1, t);
			}
		}, "2026-11-02T20:00:00.000Z");
		// 23:30 PDT Oct 31 and 00:30 PST Nov 2 are outside; 00:30 PDT and 23:30 PST on Nov 1 are in (a fixed -7 h would drop the second).
		expect(f.net).toEqual({ day: "2026-11-01", opened: 2, closed: 0 });
		expect(f.date).toBe("2026-11-02");
	});
});

/** A fresh ledger file with only the standing workload (every signal green), opened at 2026-10-10. */
function greenLedger(): string {
	const { ledger, path } = tempLedger(() => "2026-10-10T17:00:00.000Z");
	ledger.openWorkload({ by: "orchestrator-surface", brief: STANDING_BRIEF, stakes: "normal", mode: "autonomous", id: STANDING_WORKLOAD_ID });
	ledger.close();
	return path;
}
const flowBodies = (path: string): string[] => {
	const db = new Database(path, { readonly: true });
	try {
		return db.query<{ body: string }, [string, string]>("SELECT body FROM entries WHERE workload_id = ? AND created_by = ? AND body LIKE 'flow-signals:%' ORDER BY created_at, rowid").all(STANDING_WORKLOAD_ID, FLOW_SIGNALS_BY).map((r) => r.body);
	} finally {
		db.close();
	}
};
/** The fallback, in-process, at the Pacific wall time `hhmm` on `date` (PDT dates only), over `path`. */
const fallback = (path: string, date: string, hhmm: string, extra: Record<string, string> = {}) =>
	main([], { HOME: tmpdir(), AGENT_SYSTEM_LEDGER_DB: path, AS2_NOW: new Date(`${date}T${hhmm}:00-07:00`).toISOString(), ...extra });

describe("the fallback job", () => {
	test("writes only past 12:30 Pacific, once a date", () => {
		const path = greenLedger();
		expect(fallback(path, "2026-10-14", "12:15")).toBe(0);
		expect(fallback(path, "2026-10-14", "12:30")).toBe(0);
		expect(flowBodies(path)).toEqual([]);
		expect(fallback(path, "2026-10-14", "12:31")).toBe(0);
		expect(fallback(path, "2026-10-14", "14:00")).toBe(0);
		expect(flowBodies(path)).toEqual([
			"flow-signals: 2026-10-14 open 0/6 quiet 0/3 dead 0/3 questions 0/20 provider 0,0/0,5 net 0-0 green 5/5 streak 1 cap 3 cap-source default source fallback",
		]);
	});

	test("with no earlier line the cap is laneCap of its own env, cap-source default; then it copies the newest line's cap", () => {
		const path = greenLedger();
		expect(fallback(path, "2026-10-12", "12:45", { AGENT_SYSTEM_MAX_LANES: "4" })).toBe(0);
		expect(flowBodies(path)[0]).toContain(" cap 4 cap-source default source fallback");
		// The timer's line on the next date carries the orchestrator's cap.
		const l = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => "2026-10-13T19:05:00.000Z" });
		const db = new Database(path, { readonly: true });
		writeFlowSignals(l, flowSignals(db, "2026-10-13T19:05:00.000Z", 5), { capSource: "env", source: "timer" });
		db.close();
		l.close();
		expect(fallback(path, "2026-10-14", "12:45", { AGENT_SYSTEM_MAX_LANES: "4" })).toBe(0);
		expect(flowBodies(path).map((b) => b.replace(/^.* (cap .*)$/, "$1"))).toEqual([
			"cap 4 cap-source default source fallback",
			"cap 5 cap-source env source timer",
			"cap 5 cap-source env source fallback",
		]);
	});

	test("--dry-run prints the line and writes nothing; --cap judges against that cap, cap-source flag", () => {
		const path = greenLedger();
		const r = spawnSync("bun", [SCRIPT, "--dry-run", "--cap", "1"], {
			encoding: "utf8", env: { ...process.env, HOME: dir, AGENT_SYSTEM_LEDGER_DB: path, AS2_NOW: "2026-10-14T16:00:00.000Z" },
		});
		expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
		expect(r.stdout.trim()).toBe("flow-signals: 2026-10-14 open 0/2 quiet 0/1 dead 0/1 questions 0/20 provider 0,0/0,5 net 0-0 green 5/5 streak 1 cap 1 cap-source flag source fallback");
		expect(flowBodies(path)).toEqual([]);
	});

	test("a line written after 13:00 Pacific is marked late", () => {
		const path = greenLedger();
		expect(fallback(path, "2026-10-14", "13:01")).toBe(0);
		expect(flowBodies(path)[0]!.endsWith(" source fallback late")).toBe(true);
	});
});

describe("the timer and the fallback racing on a date write one line", () => {
	test("a second writer calling writeFlowSignals after the first committed finds that line in its transaction and writes nothing", () => {
		const path = greenLedger();
		const asOf = "2026-10-14T19:45:00.000Z";
		const db = new Database(path, { readonly: true });
		const f = flowSignals(db, asOf, 5);
		db.close();
		const timer = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => asOf });
		const late = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => asOf });
		expect(writeFlowSignals(timer, f, { capSource: "env", source: "timer" }).entry).not.toBeNull();
		expect(writeFlowSignals(late, f, { capSource: "default", source: "fallback" }).entry).toBeNull();
		timer.close();
		late.close();
		expect(flowBodies(path)).toHaveLength(1);
	});

	test("a fallback that pre-checked while the timer's write transaction was open, past its date check, writes nothing once it commits", async () => {
		// The timer's transaction is held open at its insert (after its in-transaction date check) until a spawned fallback has
		// passed its own pre-check outside the transaction (no line yet) and called ledger.write. The fallback's line is then
		// kept out only by the date check inside its own transaction, which runs after the timer commits.
		const path = greenLedger();
		const asOf = "2026-10-14T19:45:00.000Z"; // 12:45 Pacific: past the fallback's 12:30 gate
		const marker = join(mkdtempSync(join(dir, "race-")), "fallback-in-write");
		const child = join(dirname(marker), "fallback.ts");
		writeFileSync(child, [
			`import { writeFileSync } from "node:fs";`,
			`import { Ledger } from ${JSON.stringify(join(import.meta.dir, "..", "..", "ledger", "src", "index"))};`,
			`import { main } from ${JSON.stringify(SCRIPT)};`,
			`const write = Ledger.prototype.write;`,
			`Ledger.prototype.write = function (fn) { writeFileSync(${JSON.stringify(marker)}, ""); return write.call(this, fn); };`,
			`process.exit(main([], process.env));`,
		].join("\n"));
		const db = new Database(path, { readonly: true });
		const f = flowSignals(db, asOf, 5);
		db.close();
		const timer = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => asOf });
		const record = timer.recordEntry.bind(timer);
		const runs: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
		timer.recordEntry = (input) => {
			runs.push(Bun.spawn(["bun", child], { env: { ...process.env, HOME: dir, AGENT_SYSTEM_LEDGER_DB: path, AS2_NOW: asOf }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
			for (const deadline = Date.now() + 20_000; !existsSync(marker); Bun.sleepSync(10)) {
				if (Date.now() > deadline) throw new Error("the fallback never reached ledger.write");
			}
			Bun.sleepSync(200); // let it block on BEGIN IMMEDIATE
			return record(input);
		};
		expect(writeFlowSignals(timer, f, { capSource: "env", source: "timer" }).entry).not.toBeNull();
		timer.close();
		expect(runs).toHaveLength(1);
		const run = runs[0]!;
		expect({ code: await run.exited, stdout: (await new Response(run.stdout).text()).trim(), stderr: await new Response(run.stderr).text() })
			.toEqual({ code: 0, stdout: "flow-signals: 2026-10-14 already has a line; nothing written", stderr: "" });
		expect(flowBodies(path).map((b) => b.replace(/^.* (source .*)$/, "$1"))).toEqual(["source timer"]);
	});

	test("four fallback processes and the timer started together write one line", async () => {
		const path = greenLedger();
		const asOf = "2026-10-14T19:45:00.000Z";
		const env = { ...process.env, HOME: dir, AGENT_SYSTEM_LEDGER_DB: path, AS2_NOW: asOf };
		const exits = Array.from({ length: 4 }, () => new Promise<number | null>((done) => spawn("bun", [SCRIPT], { env, stdio: "ignore" }).on("exit", done)));
		const timer = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => asOf });
		const db = new Database(path, { readonly: true });
		writeFlowSignals(timer, flowSignals(db, asOf, 5), { capSource: "env", source: "timer" });
		db.close();
		timer.close();
		expect(await Promise.all(exits)).toEqual([0, 0, 0, 0]);
		expect(flowBodies(path)).toHaveLength(1);
	});
});

describe("the streak", () => {
	const streakOf = (body: string) => Number(/ streak (\d+) /.exec(body)![1]);

	test("1 on the first green line, 3 over three green dates", () => {
		const path = greenLedger();
		for (const d of ["2026-10-12", "2026-10-13", "2026-10-14"]) expect(fallback(path, d, "12:45")).toBe(0);
		expect(flowBodies(path).map(streakOf)).toEqual([1, 2, 3]);
	});

	test("a date with no line breaks it, and a red date reads 0 and breaks it", () => {
		const path = greenLedger();
		for (const d of ["2026-10-11", "2026-10-12", "2026-10-14"]) expect(fallback(path, d, "12:45")).toBe(0);
		expect(flowBodies(path).map(streakOf)).toEqual([1, 2, 1]);
		const l = Ledger.open(path, { backup: false, backupOnOpen: false, clock: () => "2026-10-15T08:00:00.000Z" });
		open(l, 7, "pile");
		l.close();
		expect(fallback(path, "2026-10-15", "12:45")).toBe(0);
		expect(fallback(path, "2026-10-16", "12:45", { AGENT_SYSTEM_MAX_LANES: "9" })).toBe(0);
		const bodies = flowBodies(path);
		expect(bodies[3]).toContain(" green 4/5 streak 0 ");
		// cap 3 is copied (not the job's own 9), so the pile stays red on 10-16, now quiet for 24 h as well.
		expect(bodies[4]).toContain(" green 3/5 streak 0 cap 3 cap-source default ");
	});
});
