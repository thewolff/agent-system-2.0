// `as2 doctor`'s control entries and needs-you lines (PLAN wl-mvwks11ye3x9zu § Alerts, amendment A2; R15, R16):
// surface/src/doctor-entries.ts formats and reads the `doctor-*` bodies, surface/src/launch.ts admits them only from DOCTOR_BY,
// and surface/src/errors.ts `doctorLines` renders one `report` line per open down through `errorLines`. Every entry here goes
// through a temp ledger made by the ledger module and back through the real control reader (`controlEntries`), so a prefix or
// writer missing from launch.ts drops the entry and fails the round trip. The ledger's clock is injected (no wall time);
// nothing here depends on timing.
import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { lineWithNext } from "../src/delivery";
import { type DoctorRecord, formatDoctor, localMinute, openDowns, openStrikes, parseDoctor, POPUP_ATTEMPT_LIMIT, type PopupOutcome, popupAttempts, popupClaims } from "../src/doctor-entries";
import { type ErrorLine, errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { type ControlEntry, controlEntries, DOCTOR_BY, DRIVE_BACKUP_BY, reservedPrefix } from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tmp } from "./helpers";

const T0 = "2026-11-02T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * MIN).toISOString();
/** Jo's local minute, written out here rather than through `localMinute`, so the line's time is checked independently. */
const local = (iso: string): string => {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const CTX_EVIDENCE = "ctx daemon not running (.daemon.running false; ctx daemon status --format json exited 0)";
const CTX_FIX = "run `ctx daemon status` in your own Terminal";
const GH_EVIDENCE = "no github.com account thewolff in state success (active: thewolff-engineer)";
const GH_FIX = "gh auth login -h github.com as thewolff";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface World {
	ledger: Ledger;
	at: (iso: string) => void;
}

function world(): World {
	const dir = realpathSync(tmp("doctor-lines"));
	dirs.push(dir);
	const c = clock(T0);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false, backupOnOpen: false, clock: c.now });
	ensureStandingWorkload(ledger);
	return { ledger, at: c.at };
}

/** Writes `body` on the standing workload as `by`, stamped `iso`; returns the entry id. */
function writeBody(w: World, iso: string, body: string, by = DOCTOR_BY): string {
	w.at(iso);
	return w.ledger.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
}

const write = (w: World, iso: string, r: DoctorRecord, by = DOCTOR_BY): string => writeBody(w, iso, formatDoctor(r), by);
const down = (part: string, evidence: string, fix: string): DoctorRecord => ({ prefix: "doctor-down", part, evidence, fix });
const up = (part: string): DoctorRecord => ({ prefix: "doctor-up", part, evidence: "pass" });
const claim = (popupId: string, downs: string[], after: string | null = null): DoctorRecord => ({
	prefix: "doctor-popup", popupId, outcome: { state: "claimed", pid: 4242, start: "2026-11-02T09:05:00Z", boot: 1762070000, until: "2026-11-02T21:15:00.000Z", downs, after },
});
const ended = (popupId: string, state: Exclude<PopupOutcome, { state: "claimed" }>["state"], detail: string): DoctorRecord => ({ prefix: "doctor-popup", popupId, outcome: { state, detail } });

/** The standing workload's control entries, through the reader errors.ts uses. */
const control = (w: World): ControlEntry[] => controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID, "assumption"));

/** The doctor lines errorLines renders. */
function lines(w: World): ErrorLine[] {
	return errorLines(w.ledger, w.ledger.inFlight(), { now: at(24 * 60), reportJobInstalled: () => false, driveBackupCheckPlist: () => null }).filter((l) => l.line.startsWith("as2 doctor:"));
}

function hand(prefix: string, rest: string, createdBy: string): ControlEntry {
	return { id: "en-hand", prefix: prefix as ControlEntry["prefix"], laneId: null, rest, createdBy, createdAt: T0, body: `${prefix}: ${rest}` };
}

describe("doctor entries: the text forms (R16)", () => {
	test("every record kind round-trips through a real ledger and the control reader", () => {
		const w = world();
		const records: DoctorRecord[] = [
			{ prefix: "doctor-strike", part: "ctx", evidence: CTX_EVIDENCE },
			down("ctx", CTX_EVIDENCE, CTX_FIX),
			down("job:com.agent-system-2.train-tick", "not loaded (launchctl print: Could not find service)", "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-system-2.train-tick.plist"),
			{ prefix: "doctor-up", part: "deps:com.agent-system-2.phoenix", evidence: "every dependency resolves" },
			claim("pp-1", ["en-a"]),
			claim("pp-2", ["en-a", "en-b"], "pp-1"),
			ended("pp-1", "answered", "Dismiss (no voice)"),
			ended("pp-2", "answered", "audio-failed say exited 1: no voice"),
			ended("pp-3", "failed", "quiet-alarm.zsh exited 1: execution error: -1743"),
			ended("pp-4", "abandoned", "owner gone (pid 4242)"),
			ended("pp-5", "expired", ""),
			{ prefix: "doctor-boot", boot: 1762070000 },
		];
		const ids = records.map((r, i) => write(w, at(i), r));
		const byId = new Map(control(w).map((c) => [c.id, c]));
		for (const [i, r] of records.entries()) {
			const c = byId.get(ids[i]!);
			expect({ r, admitted: c !== undefined }).toEqual({ r, admitted: true });
			expect(c!.body).toBe(formatDoctor(r));
			expect(parseDoctor(c!)).toEqual(r);
		}
		expect(formatDoctor(records[1]!)).toBe(`doctor-down: ctx ${CTX_EVIDENCE} — fix: ${CTX_FIX}`);
		expect(formatDoctor(records[5]!)).toBe("doctor-popup: pp-2 claimed pid 4242 start 2026-11-02T09:05:00Z boot 1762070000 until 2026-11-02T21:15:00.000Z downs en-a,en-b after pp-1");
		expect(formatDoctor(records[10]!)).toBe("doctor-popup: pp-5 expired");
		expect(formatDoctor(records[11]!)).toBe("doctor-boot: 1762070000");
		for (const p of ["doctor-strike", "doctor-down", "doctor-up", "doctor-popup", "doctor-boot"]) expect(reservedPrefix(`${p}: x`)).toBe(p);
	});

	test("evidence and fix become one line with no ` — `; a detail becomes one line", () => {
		const w = world();
		const id = write(w, at(1), down("disk", "free\n 9.2 GiB\tof — 460 GiB \x07 — — left", "free space — then rerun"));
		const r = parseDoctor(control(w).find((c) => c.id === id)!);
		expect(r).toEqual(down("disk", "free 9.2 GiB of - 460 GiB - - left", "free space - then rerun"));
		const out = formatDoctor(r!);
		expect(out.split(" — ")).toHaveLength(2);
		expect(formatDoctor(r!)).toBe(formatDoctor(down("disk", "free\n 9.2 GiB\tof — 460 GiB \x07 — — left", "free space — then rerun")));
		expect(formatDoctor(ended("pp-1", "failed", "line one\nline two\r\n"))).toBe("doctor-popup: pp-1 failed line one line two");
	});

	test("a value its form cannot hold throws, naming the record and the field; nothing unparsable is written", () => {
		expect(() => formatDoctor(down("a b", "x", "y"))).toThrow('formatDoctor(doctor-down): part "a b" is not one token');
		expect(() => formatDoctor({ prefix: "doctor-strike", part: "", evidence: "x" })).toThrow('part "" is not one token');
		expect(() => formatDoctor(down("ctx", "\n\t", "y"))).toThrow("formatDoctor(doctor-down): evidence is empty");
		expect(() => formatDoctor(down("ctx", "x", " "))).toThrow("formatDoctor(doctor-down): fix is empty");
		expect(() => formatDoctor(claim("pp-1", []))).toThrow("claim pp-1 names no down");
		expect(() => formatDoctor(claim("pp 1", ["en-a"]))).toThrow('popupId "pp 1" is not one token');
		expect(() => formatDoctor(claim("pp-1", ["en-a,en-b"]))).toThrow("holds a comma");
		const bad = (o: Partial<Extract<PopupOutcome, { state: "claimed" }>>): DoctorRecord => {
			const r = claim("pp-1", ["en-a"]) as Extract<DoctorRecord, { prefix: "doctor-popup" }>;
			return { ...r, outcome: { ...(r.outcome as Extract<PopupOutcome, { state: "claimed" }>), ...o } };
		};
		expect(() => formatDoctor(bad({ start: "Sun Nov  2 09:05:00 2026" }))).toThrow('start "Sun Nov  2 09:05:00 2026" is not one token');
		expect(() => formatDoctor(bad({ until: "tomorrow" }))).toThrow('until "tomorrow" is not an instant');
		expect(() => formatDoctor(bad({ pid: 0 }))).toThrow("pid 0 is not a whole number of at least 1");
		expect(() => formatDoctor({ prefix: "doctor-boot", boot: 1.5 })).toThrow("boot 1.5 is not a whole number");
	});

	test("parseDoctor: null for another writer, another prefix, or text that does not parse", () => {
		const body = formatDoctor(down("ctx", CTX_EVIDENCE, CTX_FIX)).slice("doctor-down: ".length);
		expect(parseDoctor(hand("doctor-down", body, DOCTOR_BY))).toEqual(down("ctx", CTX_EVIDENCE, CTX_FIX));
		expect(parseDoctor(hand("doctor-down", body, SURFACE_BY))).toBeNull();
		expect(parseDoctor(hand("drive-backup", body, DOCTOR_BY))).toBeNull();
		for (const [prefix, rest] of [
			["doctor-down", "ctx no separator"],
			["doctor-down", "ctx evidence — fix: "],
			["doctor-strike", "ctx"],
			["doctor-up", "ctx\nsecond line"],
			["doctor-boot", "soon"],
			["doctor-popup", "pp-1 claimed pid x start s boot 1 until 2026-11-02T00:00:00Z downs en-a"],
			["doctor-popup", "pp-1 claimed pid 1 start s boot 1 until never downs en-a"],
			["doctor-popup", "pp-1 claimed pid 1 start s boot 1 until 2026-11-02T00:00:00Z downs en-a,,en-b"],
			["doctor-popup", "pp-1 shown"],
		] as const) {
			expect({ prefix, rest, r: parseDoctor(hand(prefix, rest, DOCTOR_BY)) }).toEqual({ prefix, rest, r: null });
		}
	});
});

describe("doctor needs-you lines (R15, R16)", () => {
	test("a down renders one report line on the standing workload, keyed by the down, its next the fix", () => {
		const w = world();
		const id = write(w, at(5), down("ctx", CTX_EVIDENCE, CTX_FIX));
		const shown = lines(w);
		expect(shown).toEqual([
			{ kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: id, next: CTX_FIX, line: `as2 doctor: ctx down since ${local(at(5))}: ${CTX_EVIDENCE} — ${CTX_FIX}; clears itself when it passes` },
		]);
		expect(localMinute(at(5))).toBe(local(at(5)));
		// The line already says its step, so delivery shows it as is.
		expect(lineWithNext(shown[0]!)).toBe(shown[0]!.line);
	});

	test("a later up for the same part clears the line; an up for another part does not; a new down opens a new line", () => {
		const w = world();
		const ctx = write(w, at(1), down("ctx", CTX_EVIDENCE, CTX_FIX));
		const gh = write(w, at(2), down("gh", GH_EVIDENCE, GH_FIX));
		expect(lines(w).map((l) => l.rowId)).toEqual([ctx, gh]);
		write(w, at(3), up("gh"));
		expect(lines(w).map((l) => l.rowId)).toEqual([ctx]);
		write(w, at(4), up("ctx"));
		expect(lines(w)).toEqual([]);
		const again = write(w, at(5), down("ctx", CTX_EVIDENCE, CTX_FIX));
		expect(lines(w).map((l) => l.rowId)).toEqual([again]);
		expect(openDowns(control(w)).map((d) => [d.part, d.entryId, d.createdAt])).toEqual([["ctx", again, at(5)]]);
	});

	test("a doctor-down or doctor-up by any other writer is not a control entry: it opens nothing and clears nothing", () => {
		const w = world();
		for (const by of [SURFACE_BY, "lane-x-1", DRIVE_BACKUP_BY]) write(w, at(1), down("gh", "forged", "forged"), by);
		expect(control(w).filter((c) => c.prefix.startsWith("doctor-"))).toEqual([]);
		expect(lines(w)).toEqual([]);
		const ctx = write(w, at(2), down("ctx", CTX_EVIDENCE, CTX_FIX));
		write(w, at(3), up("ctx"), SURFACE_BY);
		expect(lines(w).map((l) => l.rowId)).toEqual([ctx]);
	});

	test("a strike alone renders nothing", () => {
		const w = world();
		const s = write(w, at(1), { prefix: "doctor-strike", part: "ctx", evidence: CTX_EVIDENCE });
		expect(lines(w)).toEqual([]);
		expect(openStrikes(control(w)).map((x) => x.entryId)).toEqual([s]);
	});

	test(`${POPUP_ATTEMPT_LIMIT} failed, abandoned or expired popups naming a down add the popup-failed text and change the line's state`, () => {
		const w = world();
		const d = write(w, at(1), down("ctx", CTX_EVIDENCE, CTX_FIX));
		const other = write(w, at(2), down("gh", GH_EVIDENCE, GH_FIX));
		const base = `as2 doctor: ctx down since ${local(at(1))}: ${CTX_EVIDENCE} — ${CTX_FIX}; clears itself when it passes`;
		write(w, at(3), claim("pp-1", [d, other]));
		write(w, at(4), ended("pp-1", "failed", "quiet-alarm.zsh exited 1: execution error"));
		write(w, at(5), claim("pp-2", [d], "pp-1"));
		write(w, at(6), ended("pp-2", "abandoned", "owner gone (pid 4242)"));
		// A claim naming only the other down spends nothing on this one.
		write(w, at(7), claim("pp-x", [other]));
		write(w, at(8), ended("pp-x", "failed", "not this one"));
		expect(popupAttempts(control(w), d)).toEqual({ spent: 2, last: "abandoned owner gone (pid 4242)", answered: false });
		const two = lines(w).find((l) => l.rowId === d)!;
		expect([two.line, two.state]).toEqual([base, undefined]);
		// A claim still in force (no outcome) spends nothing.
		write(w, at(9), claim("pp-3", [d], "pp-2"));
		expect(popupAttempts(control(w), d).spent).toBe(2);
		write(w, at(10), ended("pp-3", "expired", ""));
		expect(popupAttempts(control(w), d)).toEqual({ spent: 3, last: "expired", answered: false });
		const three = lines(w).find((l) => l.rowId === d)!;
		expect(three).toEqual({ kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: d, next: CTX_FIX, state: "popup-failed", line: `${base}; popup failed 3 times: expired` });
		// The other down has two spent (pp-1, pp-x): no popup text.
		expect(popupAttempts(control(w), other)).toEqual({ spent: 2, last: "failed not this one", answered: false });
		expect(lines(w).find((l) => l.rowId === other)!.state).toBeUndefined();
	});

	test("an answered popup stops the down counting as pending: no popup-failed text whatever fails after it", () => {
		const w = world();
		const d = write(w, at(1), down("ctx", CTX_EVIDENCE, CTX_FIX));
		write(w, at(2), claim("pp-1", [d]));
		write(w, at(3), ended("pp-1", "answered", "Dismiss (no voice)"));
		expect(popupAttempts(control(w), d)).toEqual({ spent: 0, last: null, answered: true });
		for (const [i, id] of ["pp-2", "pp-3", "pp-4"].entries()) {
			write(w, at(4 + 2 * i), claim(id, [d]));
			write(w, at(5 + 2 * i), ended(id, "failed", `try ${i}`));
		}
		expect(popupAttempts(control(w), d)).toEqual({ spent: 3, last: "failed try 2", answered: true });
		const l = lines(w);
		expect(l.map((x) => [x.rowId, x.state])).toEqual([[d, undefined]]);
		expect(l[0]!.line).not.toContain("popup failed");
	});
});

describe("doctor entries: claims and strikes", () => {
	test("popupClaims pairs each claim with the first outcome written after it for its id", () => {
		const w = world();
		write(w, at(0), ended("pp-0", "failed", "before its claim"));
		const c0 = write(w, at(1), claim("pp-0", ["en-a"]));
		const c1 = write(w, at(2), claim("pp-1", ["en-a"]));
		write(w, at(3), ended("pp-1", "failed", "first"));
		write(w, at(4), ended("pp-1", "answered", "second, ignored"));
		write(w, at(5), ended("pp-9", "abandoned", "no such claim"));
		const c2 = write(w, at(6), claim("pp-2", ["en-a", "en-b"], "pp-1"));
		write(w, at(7), claim("pp-2", ["en-c"]));
		const got = popupClaims(control(w));
		expect(got.map((p) => [p.popupId, p.entryId, p.createdAt, p.claim.downs, p.claim.after, p.outcome])).toEqual([
			["pp-0", c0, at(1), ["en-a"], null, null],
			["pp-1", c1, at(2), ["en-a"], null, { state: "failed", detail: "first" }],
			["pp-2", c2, at(6), ["en-a", "en-b"], "pp-1", null],
		]);
		expect(popupAttempts(control(w), "en-a")).toEqual({ spent: 1, last: "failed first", answered: false });
	});

	test("openStrikes drops a strike once a down or an up for its part follows", () => {
		const w = world();
		write(w, at(1), { prefix: "doctor-strike", part: "ctx", evidence: CTX_EVIDENCE });
		const gh = write(w, at(2), { prefix: "doctor-strike", part: "gh", evidence: GH_EVIDENCE });
		const disk = write(w, at(3), { prefix: "doctor-strike", part: "disk", evidence: "9 GiB free" });
		write(w, at(4), down("ctx", CTX_EVIDENCE, CTX_FIX));
		expect(openStrikes(control(w)).map((s) => [s.part, s.entryId, s.createdAt])).toEqual([["gh", gh, at(2)], ["disk", disk, at(3)]]);
		write(w, at(5), up("gh"));
		// A forged up clears nothing.
		write(w, at(6), up("disk"), SURFACE_BY);
		expect(openStrikes(control(w)).map((s) => s.part)).toEqual(["disk"]);
		write(w, at(7), up("disk"));
		expect(openStrikes(control(w))).toEqual([]);
	});
});
