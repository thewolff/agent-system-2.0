// R21 (PLAN wl-mw0vs9uc3xqtka, "What stays outside the path"): the doctor popup and the CEILING ALARM alarm-file line stay
// outside the alert path. A doctor down is no alert subject and gets no ALERT line; the doctor's own popup still shows from
// its own `doctor-` rows whatever the alert rows say. The CEILING ALARM line still renders from the alarm file alone, as
// it did before the path: beside an ALERT line of the same workload, and when the ledger's alert rows cannot be read.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CEILING_ALARM_KIND } from "../../gates/src/routine-switch";
import type { Ledger } from "../../ledger/src/index";
import { alertWords } from "../src/alert-path";
import { alertSources, fsReportFiles, type SourceSeams } from "../src/alert-sources";
import { type DoctorDeps, type ProbeResult, pendingDowns, doctorControl, popupRun } from "../src/doctor";
import { formatDoctor } from "../src/doctor-entries";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { ALERT_BY, alertBody, alertPopupBody, DOCTOR_BY } from "../src/launch";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

const T0 = "2026-11-03T10:00:00.000Z";
const OWN_PID = 5000;
const LSTART = "Tue Nov  3 09:00:00 2026";

function fixture() {
	const c = clock(T0);
	const { ledger, path } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	return { c, ledger, path };
}

/** The alert sources' seams with nothing outside the ledger to read: an empty alarm file and no chaos reports. */
function seams(now: string, alarmFile = join(tmp("alarm"), "alarm.jsonl")): SourceSeams {
	return {
		now, urgent: () => false, alarmFile, reportsDir: join(tmp("reports"), "none"), files: fsReportFiles,
		probe: () => ({ failure: null, omp: () => "gone", runner: () => "gone" }),
		trainRepo: () => "thewolff/agent-system-2.0", popupAnsweredAt: () => null,
	};
}

/** An open alert episode on the path, with a popup at level 1: rows the doctor must neither read nor need. */
function alertEpisode(ledger: Ledger, wl: string): void {
	const key = `ceiling:${wl}`;
	const ep = ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertBody(key, { row: "raised", kind: "ceiling", start: 1, digest: "0123456789ab", words: alertWords({ title: `${wl} stopped at its ceiling`, text: "spent $153.83 of $150", next: `extend ${wl}`, workloadId: wl }) }) });
	ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertBody(key, { row: "level", level: 1, step: "sent", url: "https://github.com/thewolff/jo-issues/issues/7" }) });
	ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertPopupBody(key, ep, 1, "showing") });
}

/** The popup process's deps over a ledger at `ledgerPath`: boot and ps answered in memory, the dialog recorded; nothing else may run. */
function popupDeps(ledgerPath: string, now: () => number) {
	const alarms: { title: string; text: string }[] = [];
	const ran: string[] = [];
	const run = (argv: readonly string[]): ProbeResult => {
		ran.push(argv.join(" "));
		if (argv[0] === "sysctl") return { code: 0, stdout: "{ sec = 1793000000, usec = 0 } Tue Nov  3 08:00:00 2026\n", stderr: "" };
		if (argv[0] === "ps" && argv.includes(String(OWN_PID))) return { code: 0, stdout: `S    ${LSTART}\n`, stderr: "" };
		return { code: null, stdout: "", stderr: "", error: `not expected in this test: ${argv.join(" ")}` };
	};
	const refuse = (what: string) => () => {
		throw new Error(`the popup process must not ${what} here`);
	};
	const deps: DoctorDeps = {
		run,
		fs: { exists: () => false, executable: () => false, mtimeMs: () => null, readdir: refuse("read a directory"), readText: refuse("read a file"), which: () => null, writeAtomic: refuse("write a file") },
		now, env: { HOME: tmp("home"), PATH: "/usr/bin:/bin" }, home: tmp("home"), uid: 501, user: "jo", repo: "/repo", ledgerPath, pid: OWN_PID,
		alive: () => false, kill: refuse("kill"), spawnPopup: refuse("spawn"), notify: refuse("notify"),
		alarm: (title, text) => {
			alarms.push({ title, text });
			return { state: "answered", detail: "Dismiss (no voice)", stderr: "", otherStderr: "" };
		},
		out: () => {},
	};
	return { deps, alarms, ran };
}

describe("R21: the doctor popup stays outside the alert path", () => {
	test("a doctor down is no alert subject and no ALERT line; it keeps its own needs-you line", () => {
		const { c, ledger } = fixture();
		const down = ledger.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatDoctor({ prefix: "doctor-down", part: "ctx", evidence: "ctx daemon not running", fix: "run ctx daemon start" }) });
		const { subjects, problems } = alertSources(ledger, seams(c.now()));
		expect(problems).toEqual([]);
		expect(subjects).toEqual([]);
		const lines = errorLines(ledger, ledger.inFlight(), { reportJobInstalled: () => false });
		expect(lines.filter((l) => l.kind === "alert")).toEqual([]);
		expect(lines.find((l) => l.rowId === down)).toMatchObject({ kind: "report", next: "run ctx daemon start" });
	});

	test("the doctor's popup shows from its own rows alone, with an alert episode and its popup open on the path, and writes no alert row", () => {
		const { c, ledger, path } = fixture();
		const { wl } = workloadWithSlice(ledger);
		alertEpisode(ledger, wl);
		const before = ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("alert")).map((e) => e.id);
		ledger.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatDoctor({ prefix: "doctor-down", part: "gh", evidence: "gh auth expired", fix: "gh auth login" }) });
		const p = popupDeps(path, () => Date.parse(c.now()));
		expect(popupRun(ledger, p.deps)).toBe(0);
		expect(p.alarms).toEqual([{ title: "as2 doctor: gh is down", text: "gh: gh auth expired\nFix: gh auth login" }]);
		expect(pendingDowns(doctorControl(ledger))).toEqual([]);
		expect(ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith("alert")).map((e) => e.id)).toEqual(before);
		// the alert episode's own line is untouched by the doctor's popup
		expect(errorLines(ledger, ledger.inFlight(), { reportJobInstalled: () => false }).filter((l) => l.kind === "alert").map((l) => l.line)).toEqual([
			`ALERT ${wl} stopped at its ceiling: spent $153.83 of $150 — extend ${wl} (issue https://github.com/thewolff/jo-issues/issues/7; popup shown)`,
		]);
	});
});

describe("R21: the CEILING ALARM line renders from the alarm file alone", () => {
	const ceilingAlarm = (file: string, wl: string) => {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ kind: CEILING_ALARM_KIND, at: T0, workload: wl, error: "ceiling auto-raise failed: SQLITE_BUSY" })}\n`);
	};
	const expected = (wl: string) => ({
		kind: "alarm", workloadId: wl, rowId: "alarm:1", next: `say ceiling, extend or halt for ${wl}`,
		line: `CEILING ALARM ${wl}: ceiling auto-raise failed: SQLITE_BUSY — shown until your next ceiling, extend or halt word on ${wl}`,
	});

	test("beside an open ALERT line of the same workload, the CEILING ALARM line is its own alarm line, as before the path", () => {
		const { c, ledger, path } = fixture();
		const { wl } = workloadWithSlice(ledger);
		const alarmFile = join(dirname(path), "alarm.jsonl");
		ceilingAlarm(alarmFile, wl);
		alertEpisode(ledger, wl);
		c.plusHours(0.01);
		const lines = errorLines(ledger, ledger.inFlight(), { reportJobInstalled: () => false, alarmFile });
		expect(lines.filter((l) => l.kind === "alarm")).toEqual([expected(wl)]);
		expect(lines.filter((l) => l.kind === "alert").map((l) => l.workloadId)).toEqual([wl]);
	});

	test("with the ledger's alert rows unreadable, the CEILING ALARM line still renders and the failed read is an ALERT line of its own", () => {
		const { c, ledger, path } = fixture();
		const { wl } = workloadWithSlice(ledger);
		const alarmFile = join(dirname(path), "alarm.jsonl");
		ceilingAlarm(alarmFile, wl);
		c.plusHours(0.01);
		const inFlight = ledger.inFlight();
		// The first read of the standing workload's entries in errorLines is the alert rows' read; it throws, every later read works.
		let thrown = false;
		const broken = new Proxy(ledger, {
			get(target, prop) {
				const v = Reflect.get(target, prop, target);
				if (prop !== "entries" || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
				return (wl: string, ...rest: unknown[]) => {
					if (!thrown && wl === STANDING_WORKLOAD_ID) {
						thrown = true;
						throw new Error("SQLITE_IOERR: disk I/O error");
					}
					return (v as (...a: unknown[]) => unknown).call(target, wl, ...rest);
				};
			},
		});
		const lines = errorLines(broken, inFlight, { reportJobInstalled: () => false, alarmFile });
		expect(thrown).toBe(true);
		expect(lines.filter((l) => l.kind === "alarm")).toEqual([expected(wl)]);
		expect(lines[0]).toMatchObject({ kind: "alert", rowId: "alert:unreadable" });
		expect(lines[0]!.line).toContain("SQLITE_IOERR: disk I/O error");
	});
});
