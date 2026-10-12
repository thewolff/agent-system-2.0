// The nightly chaos alert (PLAN wl-mv5lpzqacbe5ts §§ 2.1–2.3, sl-alert-surface): the nightly file
// formats (arming.log, the attempt marker, the atomically published report and its verdict line as
// surface/src/chaos.ts `renderReport` writes it), the `chaos-failed:` body, the pure obligations over
// a multi-night table, the reconciler against temp ledgers and a temp HOME (once per night, nothing
// without arming.log and no write lock when nothing is owed), the needs-you line and its delivery,
// forged bodies, and the isolation guard: the real write between two real isolation snapshots.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import {
	type ArmedInterval, attemptPath, chaosFailedBody, chaosObligations, chaosRoot, judgedAt, launchInstant, type NightlyListing, type NightlyReport, nightlyDir, parseArmingLog, parseChaosFailed,
	parseReportVerdict, publishReport, readNightly, recordChaosAlerts, writeAttemptMarker,
} from "../src/chaos-alert";
import { isolationDiff, isolationSnapshot, liveActorsOf, nightlyFault, renderReport, reportPath, type VerdictKind } from "../src/chaos";
import { consumeAllToOrchestrator, consumeLines } from "../src/delivery";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { doneBody } from "../src/launch";
import { type TestRun, testRequestedBody, testRunBody, testRunFailedBody, testRunFailedOf } from "../src/test-run";
import { ARTIFACT_FAILED_PREFIX, CHAOS_GRACE_MS, ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger, tempRepo, tmp } from "./helpers";

// October 2026 is PDT (UTC-7): a night's 03:00 PT launch is 10:00Z, and it is judged from 05:15 PT, 12:15Z.
const launchZ = (day: string) => `${day}T10:00:00Z`;
const judgedZ = (day: string) => `${day}T12:15:00.000Z`;

/** A temp HOME with an empty `R/nightly`, and the writers a night leaves there. */
function home() {
	const dir = realpathSync(tmp("chaos-home"));
	const root = chaosRoot(dir);
	mkdirSync(nightlyDir(root), { recursive: true });
	const env = { HOME: dir };
	return {
		dir, root, env,
		arm: (...lines: string[]) => writeFileSync(join(nightlyDir(root), "arming.log"), lines.map((l) => `${l}\n`).join("")),
		/** A nightly report as `renderReport` writes it, published at `reportPath` (a `-HHMM` suffix on a clash); `mtime` orders several. */
		report: (day: string, verdict: VerdictKind, reason: string, o: { at?: string; mtime?: string; scratch?: string; token?: string } = {}) => {
			const fault = nightlyFault(day);
			const path = reportPath(nightlyDir(root), new Date(o.at ?? `${day}T10:05:00Z`), fault);
			publishReport(path, renderReport({
				fault, variant: null, token: o.token ?? "run0tok", fence: "on", ps: { kind: "real" },
				verdict: { verdict, reason, deciding: null, settle: null, atMs: null, last: null },
				timings: { startedAt: launchZ(day), setupMs: 1000, triggerAt: null, injectedAt: null },
				evidence: { fault, injectedAt: launchZ(day), items: [], nonceMisses: [], egress: [], harness: [] },
				egressLog: [], rows: null, runners: [], stubCounts: {}, isolation: null, scratch: { path: o.scratch ?? "/tmp/as2-chaos-run0tok", kept: false }, notes: [],
			}));
			if (o.mtime) utimesSync(path, new Date(o.mtime), new Date(o.mtime));
			return path;
		},
		/** A report file with no verdict line. */
		garbled: (day: string) => {
			const path = join(nightlyDir(root), `${day}-${nightlyFault(day)}.md`);
			writeFileSync(path, "# chaos: the run died while writing this\n");
			return path;
		},
		attempt: (day: string, pid = 4242) => writeAttemptMarker(root, day, { startedAt: `${day}T10:00:07.000Z`, fault: nightlyFault(day), pid }),
		launchd: join(root, "launchd.log"),
	};
}

/** A temp ledger whose standing workload exists, with the chaos lines and the held chaos-failed: bodies. */
function world() {
	const { ledger } = tempLedger();
	const chaosLines = (now = "2026-10-12T00:00:00.000Z") => errorLines(ledger, undefined, { now }).filter((l) => l.kind === "chaos");
	const bodies = () => ledger.db.query<{ body: string }, []>("SELECT body FROM messages ORDER BY created_at, rowid").all().map((r) => r.body);
	return { ledger, chaosLines, bodies };
}

describe("formats: arming.log, the attempt marker, the report and the body", () => {
	test("arming.log is parsed strictly: malformed lines are skipped and returned, a second on keeps the first, an orphan off is ignored, a last on stays open", () => {
		const text = [
			"off 2026-09-01T00:00:00Z", // orphan off
			"on 2026-09-02T00:00:00Z",
			"on 2026-09-03T00:00:00Z", // second on: the first stands
			"off 2026-09-04T00:00:00Z",
			"off 2026-09-05T00:00:00Z", // off with nothing open
			"on 2026-09-06 00:00:00", // not ISO
			"ON 2026-09-06T00:00:00Z", // case
			"on 2026-09-06T00:00:00.000Z", // milliseconds
			"on 2026-02-30T00:00:00Z", // no such day
			"on 2026-09-06T00:00:00Z ", // trailing space
			"",
			"on 2026-09-07T00:00:00Z",
		].join("\n");
		const parsed = parseArmingLog(`${text}\n`);
		expect(parsed.intervals).toEqual([{ on: "2026-09-02T00:00:00Z", off: "2026-09-04T00:00:00Z" }, { on: "2026-09-07T00:00:00Z", off: null }]);
		expect(parsed.malformed.map((m) => m.line)).toEqual([6, 7, 8, 9, 10, 11]);
		expect(parsed.malformed[0]).toEqual({ line: 6, text: "on 2026-09-06 00:00:00" });
		expect(parseArmingLog("")).toEqual({ intervals: [], malformed: [] });
	});

	test("the attempt marker and the report are published by temp file and rename; the listing reads only *.md and *.attempt", () => {
		const h = home();
		const marker = h.attempt("2026-10-03", 77);
		expect(marker).toBe(attemptPath(h.root, "2026-10-03"));
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ startedAt: "2026-10-03T10:00:07.000Z", fault: nightlyFault("2026-10-03"), pid: 77 });
		const path = h.report("2026-10-03", "FAIL", "two lines seen");
		expect(readdirSync(nightlyDir(h.root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		// a report or marker still being written (its temp file) is never listed
		writeFileSync(join(nightlyDir(h.root), `2026-10-04-${nightlyFault("2026-10-04")}.md.tmp`), "- verdict: **PASS** — half");
		writeFileSync(join(nightlyDir(h.root), "2026-10-04.attempt.tmp"), "{}");
		writeFileSync(join(nightlyDir(h.root), "notes.txt"), "x");
		const listing = readNightly(h.root);
		expect(listing.launchdLog).toBe(h.launchd);
		expect(listing.reports.map((r) => [r.day, r.fault, r.path, r.verdict])).toEqual([["2026-10-03", nightlyFault("2026-10-03"), path, { verdict: "FAIL", reason: "two lines seen" }]]);
		expect(listing.attempts).toEqual([{ day: "2026-10-03", path: marker, startedAt: "2026-10-03T10:00:07.000Z", fault: nightlyFault("2026-10-03"), pid: 77 }]);
		// a skipped (already alerted) day is listed without being opened
		expect(readNightly(h.root, new Set(["2026-10-03"])).reports[0]!.verdict).toBeNull();
		expect(() => publishReport(join(h.root, "x.txt"), "x")).toThrow();
		expect(readNightly(join(h.dir, "no-such-root"))).toEqual({ launchdLog: join(h.dir, "no-such-root", "launchd.log"), reports: [], attempts: [] });
	});

	test("the verdict line is the one renderReport writes; a report without it has no verdict", () => {
		const h = home();
		for (const v of ["PASS", "FAIL", "HARNESS-ERROR"] as const) {
			const path = h.report("2026-10-05", v, `reason for ${v} — with a dash`);
			expect(parseReportVerdict(readFileSync(path, "utf8"))).toEqual({ verdict: v, reason: `reason for ${v} — with a dash` });
		}
		expect(parseReportVerdict(readFileSync(h.garbled("2026-10-06"), "utf8"))).toBeNull();
		expect(parseReportVerdict("- verdict: **MAYBE** — x")).toBeNull();
	});

	test("the 03:00 PT launch instant holds across both DST changes", () => {
		expect(new Date(launchInstant("2026-03-08")).toISOString()).toBe("2026-03-08T10:00:00.000Z"); // spring forward: 03:00 PDT
		expect(new Date(launchInstant("2026-11-01")).toISOString()).toBe("2026-11-01T11:00:00.000Z"); // fall back: 03:00 PST
		expect(new Date(launchInstant("2026-01-15")).toISOString()).toBe("2026-01-15T11:00:00.000Z");
		expect(new Date(judgedAt("2026-10-05")).toISOString()).toBe(judgedZ("2026-10-05"));
		expect(CHAOS_GRACE_MS).toBe(2 * 3_600_000);
	});

	test("the chaos-failed: body round-trips; the reason is one line of at most 300; anything else does not parse", () => {
		const a = { day: "2026-10-05", fault: "provider-refusal", verdict: "FAIL" as const, report: "/h/agent-scratch/agent-system-2.0/chaos/nightly/2026-10-05-provider-refusal.md", reason: "two needs-you lines: a: b" };
		const body = chaosFailedBody(a);
		expect(body).toBe(`chaos-failed: 2026-10-05 provider-refusal FAIL report ${a.report}: two needs-you lines: a: b`);
		expect(parseChaosFailed(body)).toEqual(a);
		const missed = { day: "2026-10-06", fault: null, verdict: "MISSED" as const, report: null, reason: "did not\n  start" };
		expect(chaosFailedBody(missed)).toBe("chaos-failed: 2026-10-06 - MISSED report -: did not start");
		expect(parseChaosFailed(chaosFailedBody(missed))).toEqual({ ...missed, reason: "did not start" });
		const long = parseChaosFailed(chaosFailedBody({ ...a, reason: "x".repeat(400) }))!;
		expect(long.reason).toHaveLength(300);
		expect(long.reason.endsWith("…")).toBe(true);
		for (const bad of [body.replace(" FAIL ", " PASS "), body.replace("2026-10-05", "2026-13-05"), body.replace(" report ", " "), `${body}\nsecond line`, `x ${body}`, body.replace("chaos-failed:", "chaos-failed")]) {
			expect(parseChaosFailed(bad)).toBeNull();
		}
	});
});

describe("chaosObligations: which nights are owed and what they resolve to", () => {
	const listing = (over: Partial<NightlyListing> = {}): NightlyListing => ({ launchdLog: "/h/launchd.log", reports: [], attempts: [], ...over });
	const owed = (intervals: ArmedInterval[], now: string, nightly = listing(), alerted: string[] = []) =>
		chaosObligations({ now, intervals, nightly, alerted: new Set(alerted) }).map((a) => `${a.day} ${a.verdict}`);

	test("nights are judged from 03:15 PT plus the grace, never before", () => {
		const iv = [{ on: "2026-10-04T12:00:00Z", off: null }];
		expect(owed(iv, "2026-10-05T12:14:59.999Z")).toEqual([]);
		expect(owed(iv, judgedZ("2026-10-05"))).toEqual(["2026-10-05 MISSED"]);
	});

	test("a night whose 03:00 PT launch lies outside every armed interval owes nothing; closed intervals stay owed after off and after a re-arm", () => {
		// armed after Oct 2's launch, disarmed before Oct 3's: no night inside
		expect(owed([{ on: "2026-10-02T10:00:01Z", off: "2026-10-03T09:59:59Z" }], judgedZ("2026-10-08"))).toEqual([]);
		// on at the launch instant counts (on ≤ t); off at the launch instant does not (t < off)
		expect(owed([{ on: launchZ("2026-10-02"), off: launchZ("2026-10-03") }], judgedZ("2026-10-08"))).toEqual(["2026-10-02 MISSED"]);
		const iv = [{ on: "2026-09-30T12:00:00Z", off: "2026-10-02T12:00:00Z" }, { on: "2026-10-04T12:00:00Z", off: null }];
		expect(owed(iv, "2026-10-06T13:00:00.000Z")).toEqual(["2026-10-01 MISSED", "2026-10-02 MISSED", "2026-10-05 MISSED", "2026-10-06 MISSED"]);
		// already alerted nights are not owed again
		expect(owed(iv, "2026-10-06T13:00:00.000Z", listing(), ["2026-10-01", "2026-10-05"])).toEqual(["2026-10-02 MISSED", "2026-10-06 MISSED"]);
	});

	test("several reports for one night: any non-PASS fails it, naming the newest non-PASS; all PASS is nothing", () => {
		const r = (name: string, mtimeMs: number, verdict: VerdictKind | null) => ({ day: "2026-10-05", fault: "provider-refusal", name, path: `/n/${name}`, mtimeMs, verdict: verdict && { verdict, reason: `${verdict} ${name}` } });
		const iv = [{ on: "2026-10-01T00:00:00Z", off: "2026-10-05T12:00:00Z" }];
		const at = "2026-10-05T13:00:00.000Z";
		const one = (reports: NightlyReport[]) => chaosObligations({ now: at, intervals: iv, nightly: listing({ reports }), alerted: new Set(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) });
		expect(one([r("a.md", 1, "PASS"), r("b.md", 2, "PASS")])).toEqual([]);
		expect(one([r("a.md", 1, "FAIL"), r("b.md", 2, "PASS")]).map((a) => [a.verdict, a.report])).toEqual([["FAIL", "/n/a.md"]]);
		expect(one([r("a.md", 1, "FAIL"), r("b.md", 3, "HARNESS-ERROR"), r("c.md", 2, "PASS")]).map((a) => [a.verdict, a.report, a.reason])).toEqual([["HARNESS-ERROR", "/n/b.md", "HARNESS-ERROR b.md"]]);
		expect(one([r("a.md", 1, "PASS"), r("b.md", 2, null)]).map((a) => [a.verdict, a.report])).toEqual([["UNREADABLE", "/n/b.md"]]);
	});
});

describe("recordChaosAlerts: the reconciler and the needs-you line", () => {
	test("a multi-night table gives one line per failed, harness-error, unreadable, crashed or missed night, and none for a pass", () => {
		const h = home();
		const w = world();
		h.arm("on 2026-09-30T12:00:00Z");
		const fail = h.report("2026-10-02", "FAIL", "two needs-you lines for one death");
		h.report("2026-10-01", "PASS", "one line, nothing orphaned");
		const harness = h.report("2026-10-03", "HARNESS-ERROR", "no lane-started: entry at the trigger");
		const garbled = h.garbled("2026-10-04");
		h.attempt("2026-10-05", 5150);
		const now = "2026-10-06T13:00:00.000Z";
		const ids = recordChaosAlerts(w.ledger, SURFACE_BY, now, h.env);
		expect(ids).toHaveLength(5);
		expect(w.bodies().map((b) => parseChaosFailed(b)!.verdict)).toEqual(["FAIL", "HARNESS-ERROR", "UNREADABLE", "CRASHED", "MISSED"]);
		const lines = w.chaosLines(now);
		expect(lines.map((l) => [l.workloadId, l.rowId, l.messageIds])).toEqual(ids.map((id) => [STANDING_WORKLOAD_ID, id, [id]]));
		const missedReason = `did not start: no attempt marker and no report; newest nightly report seen: ${garbled}`;
		expect(lines.map((l) => l.line)).toEqual([
			`nightly chaos run 2026-10-02 (${nightlyFault("2026-10-02")}): FAIL — two needs-you lines for one death — report ${fail}`,
			`nightly chaos run 2026-10-03 (${nightlyFault("2026-10-03")}): HARNESS-ERROR — no lane-started: entry at the trigger — report ${harness}`,
			`nightly chaos run 2026-10-04 (${nightlyFault("2026-10-04")}): UNREADABLE — no \`- verdict: **X** — reason\` line parses in the report — report ${garbled}`,
			`nightly chaos run 2026-10-05 (${nightlyFault("2026-10-05")}): CRASHED — started 2026-10-05T10:00:07.000Z, pid 5150, no report after 2 h — report ${h.launchd}`,
			// the line cuts the reason to 120; the body keeps up to 300
			`nightly chaos run 2026-10-06 (${nightlyFault("2026-10-06")}): MISSED — ${missedReason.length > 120 ? `${missedReason.slice(0, 119)}…` : missedReason} — report ${h.launchd}`,
		]);
		expect(parseChaosFailed(w.bodies()[4]!)!.reason).toBe(missedReason);
		expect(lines.some((l) => l.line.includes("2026-10-01"))).toBe(false);
	});

	test("a second reconcile writes nothing; the line shows once and is gone after consumeLines, and the delivered message still dedups", () => {
		const h = home();
		const w = world();
		h.arm("on 2026-10-04T12:00:00Z");
		h.report("2026-10-05", "FAIL", "orphaned slice");
		const now = "2026-10-05T13:00:00.000Z";
		const [id] = recordChaosAlerts(w.ledger, SURFACE_BY, now, h.env);
		expect(recordChaosAlerts(w.ledger, SURFACE_BY, now, h.env)).toEqual([]);
		expect(w.bodies()).toHaveLength(1);
		const shown = w.chaosLines(now);
		expect(shown.map((l) => l.rowId)).toEqual([id!]);
		expect(consumeLines(w.ledger, shown)).toBe(1);
		expect(w.ledger.message(id!)!.state).toBe("delivered");
		expect(w.chaosLines(now)).toEqual([]);
		expect(recordChaosAlerts(w.ledger, SURFACE_BY, "2026-10-05T23:00:00.000Z", h.env)).toEqual([]);
		expect(w.chaosLines(now)).toEqual([]);
		// the next night is its own line
		expect(recordChaosAlerts(w.ledger, SURFACE_BY, "2026-10-06T13:00:00.000Z", h.env)).toHaveLength(1);
		expect(w.chaosLines().map((l) => l.line.split(":")[0])).toEqual(["nightly chaos run 2026-10-06 (" + nightlyFault("2026-10-06") + ")"]);
	});

	test("=off at 03:05 with a FAIL report gives a line, and with an attempt but no report a CRASHED line; =off at 02:59 with neither gives none", () => {
		const now = "2026-10-08T13:00:00.000Z";
		const failed = home();
		failed.arm("on 2026-10-04T12:00:00Z", "off 2026-10-05T10:05:00Z");
		failed.attempt("2026-10-05");
		failed.report("2026-10-05", "FAIL", "booted out mid-run");
		const w1 = world();
		recordChaosAlerts(w1.ledger, SURFACE_BY, now, failed.env);
		expect(w1.chaosLines(now).map((l) => l.line.split(" — ")[0])).toEqual([`nightly chaos run 2026-10-05 (${nightlyFault("2026-10-05")}): FAIL`]);

		const crashed = home();
		crashed.arm("on 2026-10-04T12:00:00Z", "off 2026-10-05T10:05:00Z");
		crashed.attempt("2026-10-05", 9001);
		const w2 = world();
		recordChaosAlerts(w2.ledger, SURFACE_BY, now, crashed.env);
		expect(w2.chaosLines(now).map((l) => l.line.split(" — ")[0])).toEqual([`nightly chaos run 2026-10-05 (${nightlyFault("2026-10-05")}): CRASHED`]);

		const disarmed = home();
		disarmed.arm("on 2026-10-04T12:00:00Z", "off 2026-10-05T09:59:00Z");
		const w3 = world();
		expect(recordChaosAlerts(w3.ledger, SURFACE_BY, now, disarmed.env)).toEqual([]);
		expect(w3.chaosLines(now)).toEqual([]);
		// a run that did start on a disarmed night is still judged: its report makes the night owed
		disarmed.report("2026-10-06", "FAIL", "ran anyway");
		expect(recordChaosAlerts(w3.ledger, SURFACE_BY, now, disarmed.env).map((id) => parseChaosFailed(w3.ledger.message(id)!.body)!.day)).toEqual(["2026-10-06"]);
	});

	test("no arming.log writes nothing and takes no write lock, whatever the nightly dir holds; nothing owed takes no write lock either", () => {
		const h = home();
		h.report("2026-10-05", "FAIL", "unarmed");
		h.attempt("2026-10-06");
		const { ledger } = tempLedger();
		let writes = 0;
		const write = ledger.write.bind(ledger);
		ledger.write = <T>(fn: () => T): T => {
			writes++;
			return write(fn);
		};
		const now = "2026-10-08T13:00:00.000Z";
		expect(recordChaosAlerts(ledger, SURFACE_BY, now, h.env)).toEqual([]);
		expect(recordChaosAlerts(ledger, SURFACE_BY, now, {})).toEqual([]);
		expect(recordChaosAlerts(ledger, SURFACE_BY, now, { HOME: "/nonexistent-home" })).toEqual([]);
		expect(writes).toBe(0);
		expect(ledger.workload(STANDING_WORKLOAD_ID)).toBeNull();
		expect(ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n).toBe(0);

		// armed, every judged night passed, the newest not yet judged: owed nothing, so no write
		const passed = home();
		passed.arm("on 2026-10-04T12:00:00Z");
		passed.report("2026-10-05", "PASS", "fine");
		expect(recordChaosAlerts(ledger, SURFACE_BY, "2026-10-06T12:00:00.000Z", passed.env)).toEqual([]);
		expect(writes).toBe(0);
	});

	test("a body a lane wrote, a forged stamp, another workload or recipient gives no line; a lane cannot send one through lane_message", async () => {
		const w = world();
		ensureStandingWorkload(w.ledger);
		const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "other work", stakes: "normal", mode: "autonomous" });
		const good = chaosFailedBody({ day: "2026-10-05", fault: "provider-refusal", verdict: "FAIL", report: "/r.md", reason: "x" });
		const send = (by: string, body: string, o: { workloadId?: string; recipient?: string } = {}) =>
			w.ledger.enqueue({ by, workloadId: o.workloadId ?? STANDING_WORKLOAD_ID, sender: by, recipient: o.recipient ?? ORCHESTRATOR_RECIPIENT, body });
		send("lane-x-1", good);
		send(SURFACE_BY, good.replace("2026-10-05", "yesterday"));
		send(SURFACE_BY, good.replace(" FAIL ", " PASS "));
		send(SURFACE_BY, good, { workloadId: wl });
		send(SURFACE_BY, good, { recipient: "lane-x-1" });
		expect(w.chaosLines()).toEqual([]);
		// nor do they count as alerted: the night is still owed to the surface's own message
		const h = home();
		h.arm("on 2026-10-04T12:00:00Z");
		h.report("2026-10-05", "FAIL", "real one");
		expect(recordChaosAlerts(w.ledger, SURFACE_BY, "2026-10-05T13:00:00.000Z", h.env)).toHaveLength(1);
		expect(w.chaosLines()).toHaveLength(1);

		// the lane tool refuses the prefix with nothing written
		const { ledger, path } = tempLedger();
		const lwl = ledger.openWorkload({ by: SURFACE_BY, brief: "lane work", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: lwl, kind: "assumption", body: doneBody("done") });
		ledger.recordEntry({ by: "lane-starter", workloadId: lwl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
		expect(ledger.claimWorkload(lwl, { by: "lane-starter", holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		const f = fakePi();
		orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: lwl, AGENT_SYSTEM_LANE_ID: "lane-t-1", HOME: "/nonexistent-home" }, {});
		const out = await f.tool("lane_message").execute("1", { body: good }, undefined, undefined, ctxOf());
		expect(out.content[0]!.text).toContain("signal the machinery pushes");
		expect(ledger.workload(lwl)!.held_messages).toBe(0);
	});

	test("the chaos lines sit after the test-run lines and before a lane death", () => {
		const { ledger } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "unheld work", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: SURFACE_BY, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} 1` });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} 2` });
		ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: "orchestrator", body: "lane-died: lane-a: session shutdown at 2026-10-08T10:00:00.000Z with 1 open slice(s)" });
		const sha = "c0ffee1".padEnd(40, "0");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId: "tr-1", pr: 7, sha, slice: sl, by: "lane-a" }) });
		const run: TestRun = {
			runId: "tr-1", verdict: "red", sha, pr: 7, reason: null, headAtEnd: sha, base: null, mergeBase: null,
			full: { pass: 5, fail: 1, skip: 0, exit: 1, ms: 900, error: null }, solo: [], failures: [{ part: "full", name: "x.test.ts > broken", firstError: "nope" }], runDir: "/runs/tr-1", preflight: "ok",
		};
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRunBody(run) });
		ledger.enqueue({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, sender: TEST_RUNNER_BY, recipient: "orchestrator", body: testRunFailedBody(testRunFailedOf(wl, sl, run)!) });
		const h = home();
		h.arm("on 2026-10-04T12:00:00Z");
		recordChaosAlerts(ledger, SURFACE_BY, "2026-10-05T13:00:00.000Z", h.env);
		expect(errorLines(ledger).map((l) => l.kind)).toEqual(["artifact", "test-run", "chaos", "lane-died"]);
	});

	test("never throws into the read: a ledger error and a malformed arming.log line go to the log, each malformed line once", () => {
		const h = home();
		h.arm("on 2026-10-04T12:00:00Z", "on someday");
		const logged: string[] = [];
		const log = (line: string) => logged.push(line);
		const { ledger } = tempLedger();
		expect(recordChaosAlerts(ledger, SURFACE_BY, "2026-10-04T13:00:00.000Z", h.env, { log })).toEqual([]);
		expect(recordChaosAlerts(ledger, SURFACE_BY, "2026-10-04T13:00:00.000Z", h.env, { log })).toEqual([]);
		expect(logged).toEqual([`surface: chaos alerts: ${join(nightlyDir(h.root), "arming.log")} line 2 is not "on|off <UTC ISO Z>" and was skipped: "on someday"`]);
		ledger.close();
		expect(recordChaosAlerts(ledger, SURFACE_BY, "2026-10-06T13:00:00.000Z", h.env, { log })).toEqual([]);
		expect(logged).toHaveLength(2);
		expect(logged[1]).toStartWith("surface: chaos alerts could not be reconciled: ");
	});
});

describe("isolation (§ 2.3): the surface's alert write passes the next run's isolation diff", () => {
	const EARLIER = "run1earlier";
	const CURRENT = ["run2current", "/tmp/as2-chaos-run2current", "wl-chaos-run2current"];
	/** A "live" system: a ledger with the standing workload, a git checkout, a lanes root; a HOME armed, with a FAIL report naming an earlier run's scratch path. */
	function live() {
		const root = realpathSync(tmp("chaos-alert-live"));
		const ledgerDb = join(root, "ledger.db");
		const ledger = Ledger.open(ledgerDb, { create: true, backup: false, backupOnOpen: false });
		ensureStandingWorkload(ledger);
		const checkout = tempRepo();
		const lanes = join(root, "lanes");
		mkdirSync(join(lanes, "wl-live", "sessions"), { recursive: true });
		const h = home();
		h.arm("on 2026-10-04T12:00:00Z");
		h.report("2026-10-05", "FAIL", `lane lane-chaos-${EARLIER}-1 left /tmp/as2-chaos-${EARLIER}/home/x.log behind`, { token: EARLIER, scratch: `/tmp/as2-chaos-${EARLIER}` });
		const paths = { ledgerDb, checkout, lanesRoots: [lanes] };
		return { ledger, h, snap: () => isolationSnapshot(paths) };
	}

	test("the reconciler's insert: the messages and provenance rows are listed by orchestrator-surface, and nothing fails", () => {
		const l = live();
		const before = l.snap();
		expect([before.ledger.error, before.checkout.error]).toEqual([null, null]);
		const ids = recordChaosAlerts(l.ledger, SURFACE_BY, "2026-10-05T13:00:00.000Z", l.h.env);
		expect(ids).toHaveLength(1);
		expect(l.ledger.message(ids[0]!)!.body).toContain(`/tmp/as2-chaos-${EARLIER}`);
		const after = l.snap();
		const d = isolationDiff(before, after, CURRENT, liveActorsOf(before));
		expect(d.failures).toEqual([]);
		expect(d.ok).toBe(true);
		expect(d.ledger.rows).toContainEqual({ table: "messages", key: ids[0]!, change: "insert", actor: SURFACE_BY, workload: STANDING_WORKLOAD_ID, fail: null });
		const provenance = d.ledger.rows.filter((r) => r.table === "provenance");
		expect(provenance.length).toBeGreaterThan(0);
		expect(provenance.every((r) => r.change === "insert" && r.actor === SURFACE_BY && r.fail === null)).toBe(true);
		// the guard has teeth: had the earlier run been the current one, its marker in the body would fail
		expect(isolationDiff(before, after, EARLIER, liveActorsOf(before)).ok).toBe(false);
	});

	test("the delivery update in the same position passes too", () => {
		const l = live();
		const [id] = recordChaosAlerts(l.ledger, SURFACE_BY, "2026-10-05T13:00:00.000Z", l.h.env);
		const before = l.snap();
		expect(consumeAllToOrchestrator(l.ledger)).toBe(1);
		expect(l.ledger.message(id!)!.state).toBe("delivered");
		const after = l.snap();
		const d = isolationDiff(before, after, CURRENT, liveActorsOf(before));
		expect(d.failures).toEqual([]);
		expect(d.ok).toBe(true);
		expect(d.ledger.rows).toContainEqual({ table: "messages", key: id!, change: "update", actor: SURFACE_BY, workload: STANDING_WORKLOAD_ID, fail: null });
		// every row with a writer is the surface's (sqlite_sequence has none and is only listed)
		expect(d.ledger.rows.filter((r) => r.actor !== null).every((r) => r.actor === SURFACE_BY)).toBe(true);
		expect(existsSync(l.h.launchd)).toBe(false);
	});
});
