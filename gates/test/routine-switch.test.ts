// The auto-apply switch (PLAN wl-mvqwn80onq9hq8 D1): R12 (Jo's ask-all turns it off and survives a restart; it is Jo's
// alone; auto-routine clears every older trip and latch) and R34's switch part (an alarm line of kind ceiling is no
// latch; a line of any other or no kind is one).
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../../surface/src/identity";
import { ESCALATION_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { ALARM_FILE_NAME, alarmFilePath, MISSING_RESULT_MS, offReasons, parseAlarmLine, routineOn, routineState } from "../src/routine-switch";
import { tempLedger, tmp } from "./helpers";

/** A ledger on a settable clock with the standing workload, and an alarm file path of its own (not yet written). */
function fixture(start = "2026-10-27T10:00:00.000Z") {
	let t = start;
	const { ledger, path } = tempLedger(() => t);
	ensureStandingWorkload(ledger);
	const alarmFile = join(tmp("alarms"), ALARM_FILE_NAME);
	const at = (iso: string) => {
		t = iso;
	};
	const now = () => Date.parse(t);
	const state = () => routineState(ledger, now(), { alarmFile });
	const on = () => routineOn(ledger, now(), { alarmFile });
	const jo = (body: string) => ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body });
	const escalation = (workloadId: string, body: string) => ledger.recordEntry({ by: ESCALATION_BY, workloadId, kind: "assumption", body });
	const alarm = (line: unknown) => appendFileSync(alarmFile, `${typeof line === "string" ? line : JSON.stringify(line)}\n`);
	return { ledger, path, alarmFile, at, now, state, on, jo, escalation, alarm };
}

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

describe("routineOn: Jo's words (R12)", () => {
	test("with no event it is on; ask-all turns it off and auto-routine back on, the last word standing", () => {
		const f = fixture();
		expect(f.on()).toBe(true);
		f.at("2026-10-27T10:01:00.000Z");
		const off = f.jo("ask-all");
		expect(f.state()).toMatchObject({ on: false, offs: [{ by: "ask-all", id: off }] });
		expect(offReasons(f.state())).toEqual([`your ask-all (instruction ${off})`]);
		f.at("2026-10-27T10:02:00.000Z");
		const back = f.jo("auto-routine");
		expect(f.state()).toMatchObject({ on: true, offs: [], latches: [], autoRoutine: { id: back } });
		// Two words in one millisecond: the instruction order decides, so the later ask-all stands.
		f.jo("ask-all");
		expect(f.on()).toBe(false);
	});

	test("the switch is ledger rows: a reopened ledger reads the same state (survives restart)", () => {
		const f = fixture();
		f.jo("ask-all");
		f.ledger.close();
		const reopened = Ledger.open(f.path, { backup: false, backupOnOpen: false });
		expect(routineOn(reopened, f.now(), { alarmFile: f.alarmFile })).toBe(false);
		reopened.close();
	});

	test("only Jo's instruction through the surface counts: a lane's, another channel's or another writer's ask-all is ignored", () => {
		const f = fixture();
		const base = { workloadId: STANDING_WORKLOAD_ID, body: "ask-all" };
		f.ledger.recordInstruction({ ...base, by: "lane-a", author: "jo", channel: "surface" });
		f.ledger.recordInstruction({ ...base, by: SURFACE_BY, author: "lane-a", channel: "surface" });
		f.ledger.recordInstruction({ ...base, by: SURFACE_BY, author: "jo", channel: "direct" });
		f.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "ask-all" });
		expect(f.on()).toBe(true);
	});

	test("end-ruling routine-calls turns it off, and auto-routine does not revive an ended ruling", () => {
		const f = fixture();
		const end = f.jo("end-ruling routine-calls");
		expect(f.state()).toMatchObject({ on: false, rulingEndedBy: end });
		f.at("2026-10-27T10:05:00.000Z");
		f.jo("auto-routine");
		expect(offReasons(f.state())).toEqual([`ruling routine-calls ended (instruction ${end})`]);
	});
});

describe("routineOn: trips and the missing-result latch (D1 (b) to (d))", () => {
	test("ESCALATION_BY's auto-apply-tripped: turns it off until a newer auto-routine; a look-alike by a lane is no trip", () => {
		const f = fixture();
		f.ledger.recordEntry({ by: "lane-a", workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "auto-apply-tripped: tc-1 write > PATCH /x" });
		expect(f.on()).toBe(true);
		const trip = f.escalation(STANDING_WORKLOAD_ID, "auto-apply-tripped: tc-1 write > PATCH /repos/o/r/issues/1 HTTP/1.1");
		expect(f.state()).toMatchObject({ on: false, offs: [{ by: "trip", id: trip }] });
		// A tie with the auto-routine fails closed: the trip still counts.
		f.jo("auto-routine");
		expect(f.on()).toBe(false);
		f.at("2026-10-27T10:00:00.001Z");
		f.jo("auto-routine");
		expect(f.on()).toBe(true);
		// The row is kept as evidence; only its effect ended.
		expect(f.ledger.entry(trip)?.body).toStartWith("auto-apply-tripped: tc-1");
		f.at("2026-10-27T10:03:00.000Z");
		f.escalation(STANDING_WORKLOAD_ID, "auto-apply-tripped: tc-2 seatbelt deny(1) file-write");
		expect(f.on()).toBe(false);
	});

	test("an auto-applied: row with no result latches after 10 minutes, on any workload; its result, by ESCALATION_BY only, clears it", () => {
		const f = fixture();
		const wl = f.ledger.openWorkload({ by: "lane-a", brief: "w", stakes: "normal", mode: "autonomous" });
		const t0 = "2026-10-27T10:00:00.000Z";
		const applied = f.escalation(wl, "auto-applied: read-only tc-9 by lane-a cwd /x net yes: gh pr view 1");
		f.at(plus(t0, MISSING_RESULT_MS));
		expect(f.on()).toBe(true);
		f.at(plus(t0, MISSING_RESULT_MS + 1));
		expect(f.state()).toMatchObject({ on: false, latches: [{ kind: "missing-result", id: applied, workloadId: wl, toolCallId: "tc-9" }] });
		f.ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: "auto-applied-result: tc-9 exit 0" });
		expect(f.on()).toBe(false);
		f.escalation(wl, "auto-applied-result: tc-9 exit 0");
		expect(f.on()).toBe(true);
		// A lane's look-alike auto-applied: is no row of the gate's: it never latches.
		f.ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: "auto-applied: scratch tc-10 by lane-a cwd /x net no: rm -rf a" });
		f.at(plus(t0, 3 * MISSING_RESULT_MS));
		expect(f.on()).toBe(true);
	});

	test("auto-routine clears a missing result older than it; a later lost result latches again", () => {
		const f = fixture();
		const wl = f.ledger.openWorkload({ by: "lane-a", brief: "w", stakes: "normal", mode: "autonomous" });
		const lost = f.escalation(wl, "auto-applied: read-only tc-1 by lane-a cwd /x net no: ls");
		f.at("2026-10-27T10:30:00.000Z");
		expect(f.state().latches).toMatchObject([{ id: lost }]);
		f.jo("auto-routine");
		expect(f.on()).toBe(true);
		f.at("2026-10-27T10:31:00.000Z");
		const again = f.escalation(wl, "auto-applied: read-only tc-2 by lane-a cwd /x net no: ls");
		f.at("2026-10-27T10:42:00.000Z");
		expect(f.state().latches).toMatchObject([{ kind: "missing-result", id: again }]);
	});
});

describe("routineOn: the alarm file (D1 (c), R34)", () => {
	test("a missing file is no latch; a ceiling line is no latch; trip, result, unknown and no kind latch, by line number", () => {
		const f = fixture();
		expect(f.on()).toBe(true);
		f.alarm({ kind: "ceiling", at: "2026-10-27T10:00:00.000Z", workload: "wl-x", error: "a; b" });
		expect(f.on()).toBe(true);
		f.alarm({ kind: "trip", at: "2026-10-27T10:00:00.000Z", workload: "wl-x" });
		f.alarm({ kind: "result", at: "2026-10-27T10:00:00.000Z" });
		f.alarm({ kind: "push-record", at: "2026-10-27T10:00:00.000Z" });
		f.alarm({ at: "2026-10-27T10:00:00.000Z" });
		f.alarm("");
		f.alarm("{\"kind\":\"tr");
		const s = f.state();
		expect(s.on).toBe(false);
		expect(s.latches.map((l) => (l.kind === "alarm" ? [l.line, l.alarmKind, l.timeFrom] : l.kind))).toEqual([
			[2, "trip", "line"], [3, "result", "line"], [4, "push-record", "line"], [5, null, "line"], [7, null, "file-mtime"],
		]);
		expect(offReasons(s)).toContain("alarm-file line 2 (kind trip)");
	});

	test("auto-routine clears every line older than it, an untimed line by the next timed line or the file's mtime; the lines stay in the file", () => {
		const f = fixture();
		f.alarm({ kind: "trip", at: "2026-10-27T09:00:00.000Z" });
		f.alarm("not json");
		utimesSync(f.alarmFile, new Date("2026-10-27T09:30:00.000Z"), new Date("2026-10-27T09:30:00.000Z"));
		expect(f.state().latches).toMatchObject([{ line: 1, timeFrom: "line" }, { line: 2, timeFrom: "file-mtime", at: "2026-10-27T09:30:00.000Z" }]);
		f.jo("auto-routine");
		expect(f.on()).toBe(true);
		expect(readFileSync(f.alarmFile, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(2);
		// A line newer than the auto-routine latches; the untimed line before it is dated by it, which fails closed.
		f.alarm({ kind: "result", at: "2026-10-27T10:00:00.001Z" });
		expect(f.state().latches).toMatchObject([
			{ kind: "alarm", line: 2, alarmKind: null, timeFrom: "next-line" },
			{ kind: "alarm", line: 3, alarmKind: "result", timeFrom: "line" },
		]);
		// Once a timed line follows, the untimed line's date is fixed: the next auto-routine clears both, and a ceiling line after it latches nothing.
		f.at("2026-10-27T10:05:00.000Z");
		f.jo("auto-routine");
		f.alarm({ kind: "ceiling", at: "2026-10-27T10:06:00.000Z" });
		expect(f.on()).toBe(true);
	});

	test("an alarm file that cannot be read latches with its error, and auto-routine cannot clear it", () => {
		const f = fixture();
		mkdirSync(f.alarmFile);
		const s = f.state();
		expect(s.on).toBe(false);
		expect(s.latches).toMatchObject([{ kind: "alarm-unreadable", path: f.alarmFile }]);
		f.at("2026-10-27T11:00:00.000Z");
		f.jo("auto-routine");
		expect(f.on()).toBe(false);
	});

	test("an unreadable file (no read permission) latches too", () => {
		const f = fixture();
		writeFileSync(f.alarmFile, "");
		chmodSync(f.alarmFile, 0o000);
		try {
			expect(f.state().latches).toMatchObject([{ kind: "alarm-unreadable" }]);
		} finally {
			chmodSync(f.alarmFile, 0o600);
		}
	});

	test("the default alarm file sits beside the default ledger; parseAlarmLine reads kind and at, or null", () => {
		expect(alarmFilePath({ HOME: "/h", AGENT_SYSTEM_LEDGER_DB: join(tmp("alarm-path"), "l.db") })).toEndWith(`/${ALARM_FILE_NAME}`);
		const dir = tmp("alarm-path-2");
		expect(alarmFilePath({ AGENT_SYSTEM_LEDGER_DB: join(dir, "ledger.db") })).toBe(join(dir, ALARM_FILE_NAME));
		expect(parseAlarmLine('{"kind":"trip","at":"2026-10-27T10:00:00.000Z"}')).toEqual({ kind: "trip", at: "2026-10-27T10:00:00.000Z" });
		expect(parseAlarmLine('{"kind":"","at":"nope"}')).toEqual({ kind: null, at: null });
		expect(parseAlarmLine("[1]")).toEqual({ kind: null, at: null });
		expect(parseAlarmLine("{")).toEqual({ kind: null, at: null });
	});
});
