// The alarm-file needs-you lines in errorLines (PLAN wl-mvqwn80onq9hq8 D5 layer 1, D12): an AUTO-APPLY ALARM line for
// each latching alarm-file line newer than Jo's latest auto-routine (R9), and a CEILING ALARM <wl> line for each line of
// kind ceiling until Jo's next ceiling, extend or halt word on that workload, which never turns auto-apply off (R34).
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALARM_FILE_NAME, routineOn } from "../../gates/src/routine-switch";
import type { Ledger } from "../../ledger/src/index";
import { alarmLines, errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

/** Jo's word as the surface writes it: author jo, channel surface, created_by SURFACE_BY. */
const joSays = (ledger: Ledger, workloadId: string, body: string): string => ledger.recordInstruction({ by: SURFACE_BY, workloadId, body, author: "jo", channel: "surface" });

const alarm = (file: string, line: Record<string, unknown> | string): void => {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${typeof line === "string" ? line : JSON.stringify(line)}\n`);
};

function setup() {
	const c = clock("2026-10-27T10:00:00.000Z");
	const { ledger, path } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	const { wl, sl } = workloadWithSlice(ledger);
	return { c, ledger, wl, sl, alarmFile: join(dirname(path), ALARM_FILE_NAME) };
}

const alarmOf = (ledger: Ledger, alarmFile?: string) => errorLines(ledger, ledger.inFlight(), { reportJobInstalled: () => false, ...(alarmFile ? { alarmFile } : {}) }).filter((l) => l.kind === "alarm");

describe("alarm-file needs-you lines", () => {
	test("R9: a failed trip write's alarm line raises AUTO-APPLY ALARM beside the ledger, latches auto-apply, and clears only with Jo's newer auto-routine", () => {
		const { c, ledger, wl, alarmFile } = setup();
		expect(alarmOf(ledger)).toEqual([]);
		alarm(alarmFile, {
			kind: "trip", at: "2026-10-27T10:05:00.000Z", workload: wl, toolCallId: "tc-1", rule: "read-only", signal: "gh-write",
			evidence: "> PATCH /repos/o/r/pulls/1 HTTP/1.1", command: "gh pr view 1", error: "database is locked",
		});
		c.at("2026-10-27T10:06:00.000Z");
		// The default file is the one beside the ledger, which for the live ledger is alarmFilePath.
		const lines = alarmOf(ledger);
		expect(lines).toEqual([
			{
				kind: "alarm", workloadId: STANDING_WORKLOAD_ID, rowId: "alarm:1", next: "check the auto-applied call, then say auto-routine",
				line: `AUTO-APPLY ALARM ${wl} gh-write: > PATCH /repos/o/r/pulls/1 HTTP/1.1; auto-apply is off; ledger write failed: database is locked (alarm-file line 1; your auto-routine clears it)`,
			},
		]);
		expect(routineOn(ledger, Date.parse(c.now()), { alarmFile })).toBe(false);
		// A result-row-lost line reads the same way.
		alarm(alarmFile, { kind: "result", at: "2026-10-27T10:06:00.000Z", workload: wl, signal: "result-row-lost", evidence: "auto-applied-result: tc-2 exit 0", error: "disk I/O error" });
		expect(alarmOf(ledger).map((l) => l.rowId)).toEqual(["alarm:1", "alarm:2"]);
		// Jo's auto-routine after both clears them; the file is untouched.
		c.at("2026-10-27T10:10:00.000Z");
		joSays(ledger, STANDING_WORKLOAD_ID, "auto-routine");
		expect(alarmOf(ledger)).toEqual([]);
		expect(routineOn(ledger, Date.parse(c.now()), { alarmFile })).toBe(true);
		// A line written after it shows again.
		alarm(alarmFile, { kind: "trip", at: "2026-10-27T10:11:00.000Z", workload: wl, signal: "fence-denial", evidence: "rm: x: Operation not permitted", error: "e" });
		expect(alarmOf(ledger).map((l) => l.rowId)).toEqual(["alarm:3"]);
	});

	test("R34: a line of no kind, or a torn one, latches and shows; a lane's auto-routine look-alike does not clear it", () => {
		const { c, ledger, wl, alarmFile } = setup();
		alarm(alarmFile, { at: "2026-10-27T10:01:00.000Z", workload: wl });
		alarm(alarmFile, '{"kind":"trip","at":"2026-10-27T10:0');
		c.at("2026-10-27T10:02:00.000Z");
		ledger.recordInstruction({ by: "lane-a", workloadId: STANDING_WORKLOAD_ID, body: "auto-routine", author: "jo", channel: "surface" });
		const lines = alarmOf(ledger, alarmFile);
		expect(lines.map((l) => l.rowId)).toEqual(["alarm:1", "alarm:2"]);
		expect(lines[0]!.line).toStartWith(`AUTO-APPLY ALARM ${wl} kind none:`);
		expect(lines[1]!.line).toStartWith("AUTO-APPLY ALARM (no workload) kind none:");
		expect(lines[1]!.line).toContain("ledger write failed: not recorded");
		expect(routineOn(ledger, Date.parse(c.now()), { alarmFile })).toBe(false);
	});

	test("R34: a ceiling line raises CEILING ALARM <wl> without turning auto-apply off, until Jo's next ceiling, extend or halt word on that workload", () => {
		const { c, ledger, wl, alarmFile } = setup();
		const other = workloadWithSlice(ledger).wl;
		alarm(alarmFile, { kind: "ceiling", at: "2026-10-27T10:05:00.000Z", workload: wl, error: "ceiling auto-raise failed: SQLITE_BUSY; question write failed: SQLITE_BUSY" });
		alarm(alarmFile, { kind: "ceiling", at: "2026-10-27T10:05:00.000Z", workload: other, errors: ["raise failed: a", "question failed: b"] });
		c.at("2026-10-27T10:06:00.000Z");
		expect(routineOn(ledger, Date.parse(c.now()), { alarmFile })).toBe(true);
		expect(alarmOf(ledger, alarmFile)).toEqual([
			{ kind: "alarm", workloadId: wl, rowId: "alarm:1", next: `say ceiling, extend or halt for ${wl}`, line: `CEILING ALARM ${wl}: ceiling auto-raise failed: SQLITE_BUSY; question write failed: SQLITE_BUSY — shown until your next ceiling, extend or halt word on ${wl}` },
			{ kind: "alarm", workloadId: other, rowId: "alarm:2", next: `say ceiling, extend or halt for ${other}`, line: `CEILING ALARM ${other}: raise failed: a; question failed: b — shown until your next ceiling, extend or halt word on ${other}` },
		]);
		// auto-routine is not a ceiling word, and a word on another workload does not count.
		joSays(ledger, STANDING_WORKLOAD_ID, "auto-routine");
		joSays(ledger, other, `ceiling: 80 8`);
		expect(alarmOf(ledger, alarmFile).map((l) => l.workloadId)).toEqual([wl]);
		// A lane's look-alike is not Jo's word.
		ledger.recordInstruction({ by: "lane-a", workloadId: wl, body: "ceiling: 80 8", author: "jo", channel: "surface" });
		expect(alarmOf(ledger, alarmFile).map((l) => l.workloadId)).toEqual([wl]);
		c.at("2026-10-27T10:07:00.000Z");
		joSays(ledger, wl, `halt ${wl}`);
		expect(alarmOf(ledger, alarmFile)).toEqual([]);
	});

	test("R34: the extend answer clears a ceiling line; a word older than the line, or a lane's answer, does not", () => {
		const { c, ledger, wl, sl, alarmFile } = setup();
		joSays(ledger, wl, "ceiling: 60 8");
		c.at("2026-10-27T10:05:00.000Z");
		alarm(alarmFile, { kind: "ceiling", at: "2026-10-27T10:05:00.000Z", workload: wl, error: "both failed" });
		expect(alarmOf(ledger, alarmFile).map((l) => l.rowId)).toEqual(["alarm:1"]);
		c.at("2026-10-27T10:06:00.000Z");
		const lanes = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "ceiling reached", options: ["extend", "stop"] });
		ledger.answerQuestion(lanes, { by: "lane-a", answer: "extend", author: "jo", channel: "surface" });
		expect(alarmOf(ledger, alarmFile).map((l) => l.rowId)).toEqual(["alarm:1"]);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "ceiling reached again", options: ["extend", "stop"] });
		ledger.answerQuestion(q, { by: SURFACE_BY, answer: "extend", author: "jo", channel: "surface" });
		expect(alarmOf(ledger, alarmFile)).toEqual([]);
	});

	test("an alarm file that cannot be read is an AUTO-APPLY ALARM line of its own", () => {
		const { ledger } = setup();
		const dir = tmp("alarm-dir");
		mkdirSync(join(dir, ALARM_FILE_NAME));
		const lines = alarmLines(ledger, ledger.now(), join(dir, ALARM_FILE_NAME));
		expect(lines).toHaveLength(1);
		expect(lines[0]!.rowId).toBe("alarm:unreadable");
		expect(lines[0]!.line).toStartWith(`AUTO-APPLY ALARM: alarm file ${join(dir, ALARM_FILE_NAME)} cannot be read`);
	});
});
