// as2 doctor end to end (PLAN wl-mvwks11ye3x9zu "Proof", R15, R16, R18): the real CLI, the POSIX fakes first on PATH
// (surface/test/fixtures/doctor-fakes), a temp ledger and HOME, cwd outside the repository. Every run is awaited to its
// real exit (Bun.spawnSync); the popup process runs in the foreground through the AS2_DOCTOR_POPUP_WAIT=1 seam and shows
// its dialog through quiet-alarm.zsh's QUIET_ALARM_OSASCRIPT seam pointing at the fake, so no real dialog, sound,
// launchctl, ctx or gh ever runs.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { doctorControl } from "../src/doctor";
import { type DoctorRecord, parseDoctor } from "../src/doctor-entries";
import { FAKES_DIR, fakeCalls, LEDGER_BACKUP_LABEL, setFake, writeHealthyState } from "./fixtures/doctor-fakes/state";

const REPO = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "surface", "scripts", "doctor.ts");

interface Machine {
	root: string;
	home: string;
	state: string;
	ledgerPath: string;
}

function machine(): Machine {
	const root = mkdtempSync(join(tmpdir(), "as2-doctor-cli-"));
	const m = { root, home: join(root, "home"), state: join(root, "state"), ledgerPath: join(root, "ledger", "ledger.db") };
	mkdirSync(m.home, { recursive: true });
	writeHealthyState({ state: m.state, home: m.home, repo: REPO, seatPid: process.pid, bun: process.execPath });
	Ledger.open(m.ledgerPath, { create: true, backupOnOpen: false }).close();
	return m;
}

function cli(m: Machine, ...args: string[]): { code: number | null; out: string; err: string } {
	const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
		cwd: m.root,
		env: {
			HOME: m.home,
			PATH: `${FAKES_DIR}:/usr/bin:/bin`,
			AS2_FAKE_STATE: m.state,
			AGENT_SYSTEM_LEDGER_DB: m.ledgerPath,
			AS2_DOCTOR_POPUP_WAIT: "1",
			QUIET_ALARM_OSASCRIPT: join(FAKES_DIR, "osascript"),
			QUIET_ALARM_AFPLAY: "/usr/bin/false",
			QUIET_ALARM_SAY: "/usr/bin/false",
			...(process.env.AS2_TEST_LIVE_ROOTS ? { AS2_TEST_LIVE_ROOTS: process.env.AS2_TEST_LIVE_ROOTS } : {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** The doctor's records on the standing workload, oldest first. */
function records(m: Machine): DoctorRecord[] {
	const ledger = Ledger.open(m.ledgerPath, { readonly: true });
	try {
		return doctorControl(ledger).flatMap((c) => {
			const r = parseDoctor(c);
			return r ? [r] : [];
		});
	} finally {
		ledger.close();
	}
}

const osascriptCalls = (m: Machine) => fakeCalls(m.state).filter((l) => l.startsWith("osascript "));

describe("as2 doctor CLI", () => {
	test("--help and a bad flag exit 2 and check nothing", () => {
		const m = machine();
		for (const args of [["--help"], ["--bogus"], ["--json", "--tick"]]) {
			const r = cli(m, ...args);
			expect(r.code).toBe(2);
			expect(r.err).toContain("usage: bun surface/scripts/doctor.ts");
		}
		expect(fakeCalls(m.state)).toEqual([]);
	}, 60_000);

	test("a healthy machine: every part passes or is not installed, exit 0, nothing written", () => {
		const m = machine();
		const r = cli(m);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		// Darwin: ledger-backup is read from its plist and launchd. Off macOS every launchd job row is not installed, unread.
		const passes = process.platform === "darwin" ? ["job-inventory", "job:ledger-backup", "deps:ledger-backup", "ctx", "ledger", "backup", "seat", "mailbox", "gh", "disk", "mcp"] : ["job-inventory", "ctx", "ledger", "backup", "seat", "mailbox", "gh", "disk", "mcp"];
		for (const part of passes) {
			expect(r.out).toMatch(new RegExp(`^pass ${part.replace(/[.:-]/g, "\\$&")}: `, "m"));
		}
		if (process.platform === "darwin") {
			expect(r.out).toMatch(/^- {4}job:train-tick: not installed \(opt-in: install\.sh --train-tick\)/m);
			expect(r.out).toMatch(/^- {4}job:phoenix: not installed \(observability\.phoenix is off/m);
			expect(r.out).toMatch(/^- {4}job:doctor: not installed: HOME .* is not this user's home/m);
			expect(r.out).toMatch(/^as2 doctor: 11 pass, 0 fail, 0 warn, 8 not installed$/m);
		} else {
			for (const job of ["ledger-backup", "doctor", "phoenix", "train-tick", "daily-report", "scratch-sweep", "chaos", "drive-backup", "drive-backup-check"]) {
				expect(r.out).toMatch(new RegExp(`^- {4}job:${job}: not installed: not macOS \\(launchd jobs are macOS only; install\\.sh writes none here\\)$`, "m"));
			}
			expect(r.out).not.toMatch(/^pass (job|deps):/m);
			expect(r.out).toMatch(/^as2 doctor: 9 pass, 0 fail, 0 warn, 9 not installed$/m);
		}
		expect(records(m)).toEqual([]);
		const json = cli(m, "--json");
		expect(json.code).toBe(0);
		const parsed = JSON.parse(json.out) as { exit: number; parts: { part: string; verdict: string }[] };
		expect(parsed.exit).toBe(0);
		expect(parsed.parts.filter((p) => p.verdict === "fail")).toEqual([]);
	}, 60_000);

	describe("stopped ctx and an unloaded required job", () => {
		const m = {} as Machine;
		let first: ReturnType<typeof cli>;
		beforeAll(() => {
			Object.assign(m, machine());
			setFake(m.state, "ctx.mode", "stopped");
			unlinkSync(join(m.state, "launchctl", LEDGER_BACKUP_LABEL));
			first = cli(m, "--after-restart");
		});

		test("the after-restart run reports both, exits 1, opens two downs and one claim covering both, one popup, answered", () => {
			expect(first.err).toBe("");
			expect(first.code).toBe(1);
			if (process.platform === "darwin") {
				expect(first.out).toContain("2 failing: ");
				expect(first.out).toContain("ctx (the ctx daemon is not running");
				expect(first.out).toContain(`job:ledger-backup (${LEDGER_BACKUP_LABEL} is not loaded`);
			} else {
				// Off macOS the unloaded job is not installed (the not-macOS line), so ctx is the one failing part.
				expect(first.out).toContain("1 failing: ctx (the ctx daemon is not running");
				expect(first.out).not.toContain("job:ledger-backup (");
			}
			const rs = records(m);
			const downs = rs.filter((r) => r.prefix === "doctor-down");
			expect(downs.map((d) => d.part).sort()).toEqual(process.platform === "darwin" ? ["ctx", "job:ledger-backup"] : ["ctx"]);
			expect(rs.filter((r) => r.prefix === "doctor-boot")).toHaveLength(1);
			const popups = rs.filter((r) => r.prefix === "doctor-popup");
			expect(popups).toHaveLength(2);
			const [claim, outcome] = popups;
			expect(claim!.outcome.state).toBe("claimed");
			if (claim!.outcome.state === "claimed") expect(claim!.outcome.downs).toHaveLength(process.platform === "darwin" ? 2 : 1);
			expect(outcome).toEqual({ prefix: "doctor-popup", popupId: claim!.popupId, outcome: { state: "answered", detail: "Dismiss (no voice)" } });
			expect(osascriptCalls(m)).toHaveLength(1);
			expect(readFileSync(join(m.home, ".agent-system-2", "doctor", "popup.log"), "utf8")).toContain(`answered Dismiss (no voice)`);
		}, 60_000);

		test("two --tick passes and a second --after-restart add nothing", () => {
			const before = records(m).length;
			for (const args of [["--tick"], ["--tick"], ["--after-restart"]]) {
				const r = cli(m, ...args);
				expect(r.err).toBe("");
				expect(r.code).toBe(1);
			}
			expect(records(m).slice(before)).toEqual([]);
			expect(osascriptCalls(m)).toHaveLength(1);
		}, 60_000);

		test("ctx fresh again: the next --tick writes doctor-up: ctx and nothing else", () => {
			const before = records(m).length;
			setFake(m.state, "ctx.mode", "fresh");
			const r = cli(m, "--tick");
			expect(r.err).toBe("");
			expect(r.code).toBe(0);
			expect(r.out).toContain("doctor ctx: pass daemon running");
			const rs = records(m);
			expect(rs).toHaveLength(before + 1);
			expect(rs.at(-1)).toMatchObject({ prefix: "doctor-up", part: "ctx" });
		}, 60_000);
	});
});
