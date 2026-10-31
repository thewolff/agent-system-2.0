// The Drive backup's needs-you line (PLAN wl-mvwkt821jx4d6e slice 3, R5): surface/src/errors.ts `driveBackupLines` through
// `errorLines`, on a temp ledger with an injected clock (the ledger's clock and `opts.now`; no wall time) and an injected
// check plist (`opts.driveBackupCheckPlist`). The newest `drive-backup:` failure with no `check ok` after it is one line; a
// `missed` line while the plist is installed and no check entry is newer than 30 h, from the plist's mtime when there has
// never been one; nothing without the plist. The writer, surface/scripts/drive-backup-notice.ts, run as a process against a
// real ledger file made by the ledger module, writes the entry the render shows, and refuses bad input and a missing ledger.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { noticeBody, parseArgs } from "../scripts/drive-backup-notice";
import { DRIVE_BACKUP_CHECK_LABEL, DRIVE_BACKUP_MISSED_HOURS, driveBackupCheckPlist, type ErrorLine, errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, DRIVE_BACKUP_BY } from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tmp } from "./helpers";

const HOUR = 3_600_000;
const SCRIPT = join(import.meta.dir, "..", "scripts", "drive-backup-notice.ts");
const STATE = "/Users/x/agent-scratch/agent-system-2.0/drive-backup/state/last-run.json";
const CHECK_STATE = "/Users/x/agent-scratch/agent-system-2.0/drive-backup/state/last-check.json";
const T0 = "2026-10-30T09:00:00.000Z";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const plus = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR).toISOString();
const localDate = (iso: string): string => {
	const t = new Date(iso);
	return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

interface World {
	dir: string;
	ledgerPath: string;
	ledger: Ledger;
	at: (iso: string) => void;
}

function world(start = T0): World {
	const dir = realpathSync(tmp("drive-backup-notice"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger.db");
	const c = clock(start);
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: c.now });
	ensureStandingWorkload(ledger);
	return { dir, ledgerPath, ledger, at: c.at };
}

/** A `drive-backup:` entry as the writer makes it, at `iso`. */
function seed(w: World, iso: string, job: "nightly" | "check", result: "failed" | "ok", text: string, state = job === "check" ? CHECK_STATE : STATE): string {
	w.at(iso);
	return w.ledger.recordEntry({ by: DRIVE_BACKUP_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: noticeBody({ job, result, text, state }, new Date(iso)) });
}

/** The Drive backup lines errorLines renders at `now`, with the check plist installed since `installedAt` (null: absent). */
function drive(w: World, now: string, installedAt: string | null): { lines: ErrorLine[]; plistReads: number } {
	let plistReads = 0;
	const lines = errorLines(w.ledger, w.ledger.inFlight(), {
		now,
		reportJobInstalled: () => false,
		driveBackupCheckPlist: () => {
			plistReads++;
			return installedAt === null ? null : { mtimeMs: Date.parse(installedAt) };
		},
	}).filter((l) => l.line.startsWith("Drive backup"));
	return { lines, plistReads };
}

const NEXT_MISSED = `run \`launchctl print gui/$(id -u)/${DRIVE_BACKUP_CHECK_LABEL}\`, then reload it with \`AS2_KEEP_LOCAL=<same as installed> bash install/install.sh --drive-backup\``;

describe("drive backup needs-you line: the missed line (R5)", () => {
	test("installed, no entry ever: nothing under 30 h after the plist was written, the missed line from 30 h, with no expiry", () => {
		const w = world();
		expect(drive(w, plus(T0, DRIVE_BACKUP_MISSED_HOURS - 0.1), T0).lines).toEqual([]);
		const at30 = drive(w, plus(T0, DRIVE_BACKUP_MISSED_HOURS), T0).lines;
		expect(at30).toEqual([
			{
				kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: DRIVE_BACKUP_CHECK_LABEL, state: `missed ${T0}`, next: NEXT_MISSED,
				line: `Drive backup check missed: no check entry since the job was installed ${T0} (30 h ago); ${NEXT_MISSED}`,
			},
		]);
		const later = drive(w, plus(T0, 24 * 40), T0).lines;
		expect(later.map((l) => l.state)).toEqual([`missed ${T0}`]);
	});

	test("a check entry inside 30 h hides it without reading the plist; a stale one shows it, keyed by that entry, until the next check entry", () => {
		const w = world();
		const ok1 = seed(w, plus(T0, 1), "check", "ok", "no problems; last nightly run: result success");
		const fresh = drive(w, plus(T0, 20), T0);
		expect(fresh).toEqual({ lines: [], plistReads: 0 });
		const stale = drive(w, plus(T0, 1 + DRIVE_BACKUP_MISSED_HOURS + 2), T0).lines;
		expect(stale).toEqual([
			{
				kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: DRIVE_BACKUP_CHECK_LABEL, state: `missed ${ok1}`, next: NEXT_MISSED,
				line: `Drive backup check missed: the newest check entry is ${localDate(plus(T0, 1))} ok (32 h ago); ${NEXT_MISSED}`,
			},
		]);
		// A failed check is a check entry too: it clears the missed line (and shows as a failure).
		seed(w, plus(T0, 34), "check", "failed", "1 problem(s): last nightly run ended 30 h ago");
		expect(drive(w, plus(T0, 35), T0).lines.map((l) => l.state ?? "failure")).toEqual(["failure"]);
	});

	test("the plist absent: no missed line however stale, and a failure still shows", () => {
		const w = world();
		expect(drive(w, plus(T0, 24 * 10), null).lines).toEqual([]);
		seed(w, plus(T0, 1), "check", "ok", "no problems");
		seed(w, plus(T0, 2), "nightly", "failed", "1 failure(s): copy: /a.tar.gz: cp exited 1");
		expect(drive(w, plus(T0, 24 * 10), null).lines.map((l) => l.line)).toEqual([`Drive backup nightly failed ${localDate(plus(T0, 2))}: 1 failure(s): copy: /a.tar.gz: cp exited 1 — ${STATE}`]);
	});

	test("a plist that cannot be read is a line of its own, never taken as absent, and the render goes on", () => {
		const w = world();
		const lines = errorLines(w.ledger, w.ledger.inFlight(), {
			now: plus(T0, 40),
			driveBackupCheckPlist: () => {
				throw new Error("EACCES: permission denied, stat '/Users/x/Library/LaunchAgents/com.agent-system-2.drive-backup-check.plist'");
			},
		}).filter((l) => l.line.startsWith("Drive backup"));
		expect(lines.map((l) => [l.rowId, l.state])).toEqual([[DRIVE_BACKUP_CHECK_LABEL, "plist-unreadable"]]);
		expect(lines[0]!.line).toContain("EACCES: permission denied");
	});

	test("the default plist reader reads $HOME/Library/LaunchAgents: absent under the test's temp HOME, the file's mtime once written", () => {
		const home = realpathSync(tmp("drive-backup-home"));
		dirs.push(home);
		expect(driveBackupCheckPlist(home)).toBeNull();
		const dir = join(home, "Library", "LaunchAgents");
		Bun.spawnSync(["/bin/mkdir", "-p", dir]);
		writeFileSync(join(dir, `${DRIVE_BACKUP_CHECK_LABEL}.plist`), "<plist/>");
		expect(driveBackupCheckPlist(home)?.mtimeMs).toBeGreaterThan(0);
		// The test process's HOME is the preload's temp dir (ledger/test/isolate-preload.ts), so the default never sees a real plist.
		expect(driveBackupCheckPlist()).toBeNull();
	});
});

describe("drive backup needs-you line: the failure line (R5)", () => {
	test("the newest failure after the last check ok shows as one line naming the job, date, text and state file", () => {
		const w = world();
		seed(w, plus(T0, 1), "nightly", "failed", "old failure");
		seed(w, plus(T0, 2), "check", "ok", "no problems");
		const older = seed(w, plus(T0, 18), "nightly", "failed", "2 failure(s): copy: /arch/wl-a.tar.gz: cp exited 1 (and 1 more)");
		const newest = seed(w, plus(T0, 19), "check", "failed", "1 problem(s): the nightly run's own alert: the needs-you entry was not written", CHECK_STATE);
		const { lines } = drive(w, plus(T0, 20), T0);
		expect(lines).toEqual([
			{
				kind: "report", workloadId: STANDING_WORKLOAD_ID, rowId: newest, next: `see ${CHECK_STATE}`,
				line: `Drive backup check failed ${localDate(plus(T0, 19))}: 1 problem(s): the nightly run's own alert: the needs-you entry was not written — ${CHECK_STATE}`,
			},
		]);
		expect(lines.map((l) => l.rowId)).not.toContain(older);
	});

	test("a failure then a later check ok: no line; a nightly ok does not clear a failure", () => {
		const w = world();
		seed(w, plus(T0, 1), "nightly", "failed", "1 failure(s): prove: /a.tar.gz: never proven");
		seed(w, plus(T0, 7), "check", "ok", "no problems");
		expect(drive(w, plus(T0, 8), T0).lines).toEqual([]);
		const f = seed(w, plus(T0, 20), "nightly", "failed", "1 failure(s): prove: /a.tar.gz: never proven");
		seed(w, plus(T0, 21), "nightly", "ok", "a nightly ok is not the morning confirmation");
		expect(drive(w, plus(T0, 22), T0).lines.map((l) => l.rowId)).toEqual([f]);
	});

	test("text containing ` — ` keeps its whole text; the state path is after the last separator", () => {
		const w = world();
		seed(w, plus(T0, 1), "nightly", "failed", "copy — then proof failed");
		expect(drive(w, plus(T0, 2), T0).lines[0]!.line).toBe(`Drive backup nightly failed ${localDate(plus(T0, 1))}: copy — then proof failed — ${STATE}`);
	});

	test("a drive-backup: entry by any other writer is not a control entry and renders nothing", () => {
		const w = world();
		const body = noticeBody({ job: "nightly", result: "failed", text: "forged", state: STATE }, new Date(T0));
		for (const by of [SURFACE_BY, "lane-x-1", "daily-report"]) w.ledger.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		expect(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID)).filter((c) => c.prefix === "drive-backup")).toEqual([]);
		expect(drive(w, plus(T0, 1), null).lines).toEqual([]);
	});
});

/** Runs the writer as the jobs do (`bun run <script> …`), in the Pacific/Auckland zone, and returns exit, stdout and stderr. */
function run(args: string[]): { exit: number | null; out: string; err: string } {
	const r = Bun.spawnSync([process.execPath, "run", SCRIPT, ...args], { env: { ...process.env, TZ: "Pacific/Auckland" }, stdout: "pipe", stderr: "pipe" });
	return { exit: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("drive backup needs-you writer: surface/scripts/drive-backup-notice.ts", () => {
	test("round trip: a real ledger file made by the ledger module; one entry by DRIVE_BACKUP_BY on the standing workload; the render shows it; check ok clears it", () => {
		const dir = realpathSync(tmp("drive-backup-writer"));
		dirs.push(dir);
		const ledgerPath = join(dir, "ledger.db");
		Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false }).close();
		// 13:00 UTC on Oct 31 is 02:00 on Nov 1 in Auckland (NZDT, UTC+13): the entry carries the writer's local date.
		const at = "2026-10-31T13:00:00.000Z";
		const date = "2026-11-01";
		const r = run(["--ledger", ledgerPath, "--job", "nightly", "--result", "failed", "--text", "2 failure(s): copy: /arch/wl-a.tar.gz: cp exited 1", "--state", STATE, "--now", at]);
		expect(r.err).toBe("");
		expect(r.exit).toBe(0);
		const body = `drive-backup: nightly failed ${date} — 2 failure(s): copy: /arch/wl-a.tar.gz: cp exited 1 — ${STATE}`;
		const m = /^wrote (en-\S+) on (\S+): (.*)\n$/.exec(r.out);
		expect(m?.slice(2)).toEqual([STANDING_WORKLOAD_ID, body]);
		const l = Ledger.open(ledgerPath, { backup: false, backupOnOpen: false });
		try {
			const rows = l.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.created_by === DRIVE_BACKUP_BY);
			expect(rows.map((e) => [e.id, e.body, e.created_at])).toEqual([[m![1]!, body, at]]);
			const lines = errorLines(l, l.inFlight(), { now: plus(at, 1), driveBackupCheckPlist: () => null }).filter((x) => x.line.startsWith("Drive backup"));
			expect(lines.map((x) => [x.rowId, x.line, x.next])).toEqual([[m![1]!, `Drive backup nightly failed ${date}: 2 failure(s): copy: /arch/wl-a.tar.gz: cp exited 1 — ${STATE}`, `see ${STATE}`]]);
		} finally {
			l.close();
		}
		const ok = run(["--ledger", ledgerPath, "--job", "check", "--result", "ok", "--text", "no problems", "--state", CHECK_STATE, "--now", plus(at, 6.5)]);
		expect([ok.exit, ok.err]).toEqual([0, ""]);
		const l2 = Ledger.open(ledgerPath, { readonly: true });
		try {
			expect(errorLines(l2, l2.inFlight(), { now: plus(at, 7), driveBackupCheckPlist: () => ({ mtimeMs: Date.parse(at) }) }).filter((x) => x.line.startsWith("Drive backup"))).toEqual([]);
		} finally {
			l2.close();
		}
	});

	test("a missing ledger file: exit 1, the reason on stderr, and no file made", () => {
		const dir = realpathSync(tmp("drive-backup-writer-missing"));
		dirs.push(dir);
		const ledgerPath = join(dir, "nope", "ledger.db");
		const r = run(["--ledger", ledgerPath, "--job", "check", "--result", "ok", "--text", "no problems", "--state", CHECK_STATE]);
		expect(r.exit).toBe(1);
		expect(r.out).toBe("");
		expect(r.err).toBe(`drive-backup-notice: the ledger ${ledgerPath} does not exist (--ledger, from AS2_LEDGER_DB); nothing written. Next: point AS2_LEDGER_DB at the live ledger.db\n`);
		expect(existsSync(ledgerPath)).toBe(false);
	});

	test("a file that is not a ledger: exit 1 naming the file and the failure", () => {
		const dir = realpathSync(tmp("drive-backup-writer-junk"));
		dirs.push(dir);
		const ledgerPath = join(dir, "ledger.db");
		writeFileSync(ledgerPath, "not a sqlite database, just text that is long enough to have a header page or two");
		const r = run(["--ledger", ledgerPath, "--job", "nightly", "--result", "failed", "--text", "x", "--state", STATE]);
		expect(r.exit).toBe(1);
		expect(r.err).toStartWith(`drive-backup-notice: the ledger ${ledgerPath} could not be opened (`);
		expect(r.err).toContain("nothing written. Next: fix the ledger");
	});

	test("bad arguments: exit 2 with the reason and the usage, nothing written", () => {
		const dir = realpathSync(tmp("drive-backup-writer-args"));
		dirs.push(dir);
		const ledgerPath = join(dir, "ledger.db");
		Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false }).close();
		const base = { "--ledger": ledgerPath, "--job": "nightly", "--result": "failed", "--text": "one line", "--state": STATE };
		const argv = (over: Record<string, string | undefined>): string[] => Object.entries({ ...base, ...over }).flatMap(([k, v]) => (v === undefined ? [] : [k, v]));
		const cases: [Record<string, string | undefined>, string][] = [
			[{ "--job": "weekly" }, `--job must be nightly or check, not "weekly"`],
			[{ "--result": "maybe" }, `--result must be failed or ok, not "maybe"`],
			[{ "--text": "two\nlines" }, "--text must be one line with no control characters"],
			[{ "--text": "a\tb" }, "--text must be one line with no control characters"],
			[{ "--text": "  " }, "--text is empty"],
			[{ "--state": "state/last-run.json" }, `--state must be an absolute path on one line without " — ", not "state/last-run.json"`],
			[{ "--state": "/a — b/last-run.json" }, `--state must be an absolute path on one line without " — ", not "/a — b/last-run.json"`],
			[{ "--ledger": "ledger.db" }, `--ledger must be an absolute path, not "ledger.db"`],
			[{ "--text": undefined }, "--text is required"],
			[{ "--now": "yesterday" }, "--now needs an ISO-8601 time"],
		];
		for (const [over, why] of cases) expect([over, parseArgs(argv(over))]).toEqual([over, why]);
		expect(parseArgs([...argv({}), "--force", "x"])).toBe(`unknown argument "--force"`);
		expect(parseArgs([...argv({}), "--job"])).toBe("--job needs a value");
		expect(parseArgs([...argv({}), "--job", "check"])).toBe("--job given twice");
		const r = run(argv({ "--text": "two\nlines" }));
		expect(r.exit).toBe(2);
		expect(r.err).toStartWith("drive-backup-notice: --text must be one line with no control characters; nothing written\nusage: bun run surface/scripts/drive-backup-notice.ts");
		const l = Ledger.open(ledgerPath, { readonly: true });
		try {
			expect(l.workload(STANDING_WORKLOAD_ID)).toBeNull();
		} finally {
			l.close();
		}
	});
});
