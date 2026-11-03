// as2 doctor's checks, episodes, popups and the train tick's isolated ctx step (PLAN wl-mvwks11ye3x9zu R1-R16), over
// injected deps: probes answered in memory (no process runs), an in-memory filesystem for the dependency and job reads,
// a temp ledger, and one fake clock `c.ms` that every threshold (2 h, 10 min, 12 h claims, the job windows) is driven by.
// The real-file reads (the ledger, its backup directory, the OMP logs) use temp directories.
import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { main as doctorMain } from "../scripts/doctor";
import { main as trainTickMain, type MainDeps } from "../scripts/train-tick";
import {
	backupDir, checkCtx, checkDeps, checkDisk, checkGh, checkJob, checkLedger, checkMailbox, checkMcp, checkParts, checkSeat, CLAIM_MS, type DoctorDeps, type DoctorFs, doctorControl, doctorTick, JOB_INVENTORY,
	type JobRow, ledgerDownPath, ledgerDownPopup, type PartResult, pendingDowns, popupLogPath, popupRun, type ProbeResult, realFs, runAfterRestart, runDefault, type RunOutcome, settleAndSpawn, settleClaims, spawnPopupProcess, thenClose,
} from "../src/doctor";
import { type DoctorRecord, formatDoctor, parseDoctor, POPUP_ATTEMPT_LIMIT, popupAttempts } from "../src/doctor-entries";
import { doctorLines } from "../src/errors";
import { DOCTOR_BY } from "../src/launch";
import { type AlarmOutcome, type AlarmRun, alarmPopup } from "../src/notify";
import { ensureStandingWorkload } from "../src/identity";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { tmp } from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const REPO = "/repo";
const OWN_PID = 5000;
const SEAT_PID = 4242;
const LSTART = "Mon Nov  2 09:00:00 2026";
const PLISTS = ["chaos", "daily-report", "drive-backup", "drive-backup-check", "ledger-backup", "phoenix", "scratch-sweep", "train-tick"].map((n) => `com.agent-system-2.${n}.plist`);

interface FakeFile {
	text: string;
	mtimeMs: number;
	exec: boolean;
}

interface Fake {
	c: { ms: number };
	deps: DoctorDeps;
	home: string;
	ledgerPath: string;
	files: Map<string, FakeFile>;
	dirs: Map<string, string[]>;
	calls: { argv: string[]; env?: Record<string, string | undefined> }[];
	/** Answers by tool: ctx, gh, df, pgrep (a ProbeResult). */
	answers: Map<string, ProbeResult>;
	/** launchctl print stdout per label; absent → not loaded. */
	launchctl: Map<string, string>;
	/** plutil's JSON per plist path. */
	plists: Map<string, Record<string, unknown>>;
	/** ps: pid → { lstart, command }. */
	ps: Map<number, { lstart: string; command: string }>;
	boot: { sec: number };
	ownHome: { home: string };
	out: string[];
	spawned: number[];
	alarms: { title: string; text: string; spoken: string; giveUpSecs: number }[];
	alarmAnswers: AlarmOutcome[];
	killed: number[];
	notified: string[];
}

const ok = (stdout: string): ProbeResult => ({ code: 0, stdout, stderr: "" });
const ctxJson = (o: { running?: boolean; lastMs?: number; supervisor?: string }): string =>
	JSON.stringify({ schema_version: 1, daemon: { running: o.running ?? true, supervisor: { status: o.supervisor ?? "installed" }, jobs: { core_refresh: { last_run_at_ms: o.lastMs } } } });
const plistPathOf = (home: string, name: string) => join(home, "Library", "LaunchAgents", `com.agent-system-2.${name}.plist`);
const row = (name: string): JobRow => JOB_INVENTORY.find((r) => r.name === name)!;
const print = (o: { path: string; log: string; runs: number; exit: number | "never"; state?: string; pid?: number }) =>
	[
		"gui/501/x = {",
		`\tpath = ${o.path}`,
		`\tstate = ${o.state ?? "not running"}`,
		`\tstdout path = ${o.log}`,
		...(o.pid !== undefined ? [`\tpid = ${o.pid}`] : []),
		`\truns = ${o.runs}`,
		`\tlast exit code = ${o.exit === "never" ? "(never exited)" : o.exit}`,
		"\tendpoints = {",
		"\t\tpath = /nested/should/not/count",
		"\t}",
		"}",
	].join("\n");

const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: "ENOENT" });

/** A machine where every part passes (ledger-backup installed and fresh, phoenix off, nothing opt-in, HOME not the user's home). */
function fake(): Fake {
	const home = tmp("doctor-home");
	const ledgerPath = join(tmp("doctor-ledger"), "ledger.db");
	const c = { ms: T0 };
	const iso = () => new Date(c.ms).toISOString();
	Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: iso }).close();
	const f: Fake = {
		c, home, ledgerPath, files: new Map(), dirs: new Map(), calls: [], answers: new Map(), launchctl: new Map(), plists: new Map(), ps: new Map(),
		boot: { sec: Math.floor((T0 - HOUR) / 1000) }, ownHome: { home: "/Users/other" }, out: [], spawned: [], alarms: [], alarmAnswers: [], killed: [], notified: [],
		deps: undefined as unknown as DoctorDeps,
	};
	const file = (path: string, text = "", o: { mtimeMs?: number; exec?: boolean } = {}) => f.files.set(path, { text, mtimeMs: o.mtimeMs ?? c.ms, exec: o.exec ?? false });
	file("/bin/bun", "", { exec: true });
	for (const tool of ["date", "dirname", "du", "mktemp", "pgrep", "ps", "sed", "tail", "grep", "tar", "gh", "git", "bun", "omp", "osascript", "ctx", "kill"]) file(`/usr/bin/${tool}`, "", { exec: true });
	f.dirs.set(join(REPO, "install"), [...PLISTS, "install.sh", "README.md"]);
	const lb = plistPathOf(home, "ledger-backup");
	const lbLog = join(home, ".agent-system-2", "logs", "ledger-backup.log");
	file(lb, "<plist/>", { mtimeMs: T0 - 30 * 24 * HOUR });
	file(lbLog, "ok", { mtimeMs: T0 - 5 * MIN });
	f.plists.set(lb, { Label: "com.agent-system-2.ledger-backup", ProgramArguments: ["/bin/bun", "run", lb], StartInterval: 3600, StandardOutPath: lbLog, EnvironmentVariables: { PATH: "/usr/bin:/bin" } });
	f.launchctl.set("com.agent-system-2.ledger-backup", print({ path: lb, log: lbLog, runs: 12, exit: 0 }));
	file(join(home, ".omp", "profiles", "agent-system-2", "agent", "config.yml"), "observability:\n  phoenix: off\n");
	f.answers.set("ctx", ok(ctxJson({ lastMs: T0 - MIN })));
	f.answers.set("gh", ok(JSON.stringify({ hosts: { "github.com": [{ login: "thewolff", state: "success", active: true }] } })));
	f.answers.set("df", ok("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 994662584 400000000 104857600 80% /System/Volumes/Data\n"));
	f.answers.set("pgrep", ok(`${SEAT_PID}\n`));
	f.ps.set(SEAT_PID, { lstart: LSTART, command: `omp --cwd ${REPO} --append-system-prompt ${REPO}/orchestrator/system.md` });
	f.ps.set(OWN_PID, { lstart: LSTART, command: "bun surface/scripts/doctor.ts" });
	const fs: DoctorFs = {
		exists: (p) => f.files.has(p) || f.dirs.has(p),
		executable: (p) => f.files.get(p)?.exec === true,
		mtimeMs: (p) => f.files.get(p)?.mtimeMs ?? null,
		readdir: (p) => {
			const d = f.dirs.get(p);
			if (!d) throw enoent(p);
			return [...d];
		},
		readText: (p) => {
			const x = f.files.get(p);
			if (!x) throw enoent(p);
			return x.text;
		},
		which: (name, path) => path.split(":").map((d) => join(d, name)).find((p) => f.files.get(p)?.exec === true) ?? null,
		writeAtomic: (p, text) => file(p, text),
	};
	const run = (argv: readonly string[], env?: Record<string, string | undefined>): ProbeResult => {
		f.calls.push({ argv: [...argv], ...(env ? { env } : {}) });
		const [tool, ...args] = argv;
		switch (tool) {
			case "launchctl": {
				const label = args[1]!.split("/").pop()!;
				const out = f.launchctl.get(label);
				return out === undefined ? { code: 113, stdout: "", stderr: `Could not find service "${label}" in domain for user gui: 501` } : ok(out);
			}
			case "plutil": {
				const p = f.plists.get(args.at(-1)!);
				return p ? ok(JSON.stringify(p)) : { code: 1, stdout: "", stderr: `${args.at(-1)}: file does not exist or is not readable` };
			}
			case "ps": {
				const pid = Number(args[args.indexOf("-p") + 1]);
				const fields = args[args.indexOf("-o") + 1]!;
				const p = f.ps.get(pid);
				if (!p) return { code: 1, stdout: "", stderr: "" };
				return ok(fields === "command=" ? `${p.command}\n` : fields === "stat=,lstart=" ? `S    ${p.lstart}\n` : `${p.lstart}\n`);
			}
			case "sysctl":
				return ok(`{ sec = ${f.boot.sec}, usec = 0 } Mon Nov  2 11:00:00 2026\n`);
			case "dscl":
				return ok(`NFSHomeDirectory: ${f.ownHome.home}\n`);
			default: {
				const a = f.answers.get(tool!);
				return a ?? { code: null, stdout: "", stderr: "", error: `could not start: ${tool} is not on PATH` };
			}
		}
	};
	f.deps = {
		run, fs, now: () => c.ms, env: { HOME: home, PATH: "/usr/bin:/bin", CI: "1" }, home, uid: 501, user: "jo", repo: REPO, ledgerPath, pid: OWN_PID,
		alive: (pid) => f.ps.has(pid),
		kill: (pid) => {
			f.killed.push(pid);
			f.ps.delete(pid);
		},
		spawnPopup: () => {
			f.spawned.push(c.ms);
			return "spawned (fake)";
		},
		alarm: (title, text, spoken, giveUpSecs) => {
			f.alarms.push({ title, text, spoken, giveUpSecs });
			return f.alarmAnswers.shift() ?? { state: "answered", detail: "Dismiss (no voice)", stderr: "", otherStderr: "" };
		},
		notify: (title, text) => {
			f.notified.push(`${title}: ${text}`);
			return true;
		},
		out: (l) => f.out.push(l),
	};
	return f;
}

const open = (f: Fake) => Ledger.open(f.ledgerPath, { backup: false, backupOnOpen: false, clock: () => new Date(f.c.ms).toISOString() });
const recordsOf = (ledger: Ledger): DoctorRecord[] => doctorControl(ledger).flatMap((c) => (parseDoctor(c) ? [parseDoctor(c)!] : []));
const kinds = (ledger: Ledger) => recordsOf(ledger).map((r) => (r.prefix === "doctor-popup" ? `popup ${r.outcome.state}` : `${r.prefix.slice(7)}${"part" in r ? ` ${r.part}` : ""}`));
const verdicts = (rs: readonly PartResult[]) => rs.map((r) => `${r.verdict} ${r.part}`);
const only = (rs: PartResult[], part: string) => rs.filter((r) => r.part === part);

describe("parts", () => {
	test("a healthy machine: every part passes or is not installed; ctx runs without CI in its environment", async () => {
		const f = fake();
		const rs = await checkParts(f.deps);
		expect(rs.filter((r) => r.verdict === "fail" || r.verdict === "warn")).toEqual([]);
		expect(verdicts(rs).filter((v) => v.startsWith("pass"))).toEqual(
			["job-inventory", "job:ledger-backup", "deps:ledger-backup", "ctx", "ledger", "backup", "seat", "mailbox", "gh", "disk", "mcp"].map((p) => `pass ${p}`),
		);
		expect(only(rs, "job:train-tick")[0]!.evidence).toBe("not installed (opt-in: install.sh --train-tick)");
		const ctx = f.calls.find((c) => c.argv[0] === "ctx")!;
		expect(ctx.argv).toEqual(["ctx", "daemon", "status", "--format", "json"]);
		expect(ctx.env).toBeDefined();
		expect("CI" in ctx.env!).toBe(false);
		expect(ctx.env!.HOME).toBe(f.home);
		// One probe call per probe: every argv distinct.
		const keys = f.calls.map((c) => c.argv.join(" "));
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("ctx: not running, refresh older than 2 h, a failed probe, non-JSON and an unknown shape each fail; a missing supervisor warns", () => {
		const f = fake();
		f.answers.set("ctx", ok(ctxJson({ running: false, lastMs: T0 })));
		expect(checkCtx(f.deps)).toEqual([{ part: "ctx", verdict: "fail", evidence: "the ctx daemon is not running (.daemon.running = false)", fix: expect.stringContaining("ctx daemon status") }]);
		// The 2 h line, driven by the fake clock c.ms.
		f.answers.set("ctx", ok(ctxJson({ lastMs: T0 - 2 * HOUR })));
		expect(verdicts(checkCtx(f.deps))).toEqual(["pass ctx"]);
		f.c.ms = T0 + 1;
		expect(checkCtx(f.deps)[0]!.evidence).toContain("core_refresh last ran 2.0 h ago");
		expect(verdicts(checkCtx(f.deps))).toEqual(["fail ctx"]);
		f.answers.set("ctx", { code: null, stdout: "", stderr: "", error: "timed out after 10 s and was killed" });
		expect(checkCtx(f.deps)[0]!.evidence).toBe("`ctx daemon status --format json` timed out after 10 s and was killed");
		f.answers.set("ctx", { code: 1, stdout: "", stderr: "boom" });
		expect(checkCtx(f.deps)[0]!.evidence).toBe("`ctx daemon status --format json` exited 1: boom; its output is not JSON: empty");
		f.answers.set("ctx", ok(JSON.stringify({ daemon: { running: true } })));
		expect(checkCtx(f.deps)[0]!.evidence).toContain("has no .daemon.jobs.core_refresh.last_run_at_ms");
		f.answers.set("ctx", ok(ctxJson({ lastMs: T0, supervisor: "not_installed" })));
		expect(verdicts(checkCtx(f.deps))).toEqual(["pass ctx", "warn ctx"]);
	});

	test("jobs: a required plist missing, unloaded, loaded from elsewhere, a bad exit or an unknown print shape fails, each with its fix", () => {
		const f = fake();
		const lb = plistPathOf(f.home, "ledger-backup");
		f.launchctl.delete("com.agent-system-2.ledger-backup");
		const unloaded = checkJob(f.deps, row("ledger-backup"));
		expect(verdicts(unloaded)).toEqual(["fail job:ledger-backup", "pass deps:ledger-backup"]);
		expect(unloaded[0]!.evidence).toBe(`com.agent-system-2.ledger-backup is not loaded (${lb} is installed)`);
		expect(unloaded[0]!.fix).toBe(`run in your own Terminal (agent shells get "Bootstrap failed: 5"): launchctl bootstrap gui/$(id -u) ${lb}`);
		f.launchctl.set("com.agent-system-2.ledger-backup", print({ path: "/elsewhere/x.plist", log: "/l", runs: 1, exit: 0 }));
		expect(checkJob(f.deps, row("ledger-backup"))[0]!.evidence).toBe(`com.agent-system-2.ledger-backup is loaded from /elsewhere/x.plist, not ${lb}`);
		const log = join(f.home, ".agent-system-2", "logs", "ledger-backup.log");
		f.launchctl.set("com.agent-system-2.ledger-backup", print({ path: lb, log, runs: 3, exit: 78 }));
		expect(checkJob(f.deps, row("ledger-backup"))[0]).toEqual({ part: "job:ledger-backup", verdict: "fail", evidence: "com.agent-system-2.ledger-backup last exit code 78", fix: `read its log: ${log}` });
		f.launchctl.set("com.agent-system-2.ledger-backup", "gui/501/x = {\n\tstate = running\n}");
		expect(checkJob(f.deps, row("ledger-backup"))[0]!.evidence).toContain("answered an unknown shape");
		f.files.delete(lb);
		expect(checkJob(f.deps, row("ledger-backup"))).toEqual([{ part: "job:ledger-backup", verdict: "fail", evidence: `${lb} is missing`, fix: `reinstall: bash ${REPO}/install/install.sh` }]);
	});

	test("jobs: the log's age against twice the interval plus 10 min; runs 0 passes only within the window of the plist's install (fake clock c.ms)", () => {
		const f = fake();
		const log = join(f.home, ".agent-system-2", "logs", "ledger-backup.log");
		f.files.get(log)!.mtimeMs = T0 - (2 * HOUR + 10 * MIN);
		expect(verdicts(checkJob(f.deps, row("ledger-backup")))[0]).toBe("pass job:ledger-backup");
		f.c.ms = T0 + 1;
		const stale = checkJob(f.deps, row("ledger-backup"))[0]!;
		expect(stale.verdict).toBe("fail");
		expect(stale.evidence).toContain("has not run recently");
		const lb = plistPathOf(f.home, "ledger-backup");
		f.launchctl.set("com.agent-system-2.ledger-backup", print({ path: lb, log, runs: 0, exit: "never" }));
		f.files.get(lb)!.mtimeMs = f.c.ms - HOUR;
		expect(checkJob(f.deps, row("ledger-backup"))[0]!.verdict).toBe("pass");
		f.files.get(lb)!.mtimeMs = f.c.ms - 3 * HOUR;
		expect(checkJob(f.deps, row("ledger-backup"))[0]!.evidence).toContain("never ran since");
	});

	test("the doctor job's own exit 1 (it found failures) passes; it is required only when HOME is this user's home", () => {
		const f = fake();
		const d = plistPathOf(f.home, "doctor");
		expect(checkJob(f.deps, row("doctor"))[0]!.verdict).toBe("not installed");
		f.ownHome.home = f.home;
		expect(checkJob(f.deps, row("doctor"))[0]).toMatchObject({ verdict: "fail", evidence: `${d} is missing` });
		const log = join(f.home, ".agent-system-2", "logs", "doctor.log");
		f.files.set(d, { text: "", mtimeMs: T0 - HOUR, exec: false });
		f.files.set(log, { text: "", mtimeMs: T0 - 5 * MIN, exec: false });
		for (const a of ["/bin/zsh", "/bin/rm", "/usr/bin/afplay", "/usr/bin/say", "/usr/bin/launchctl", "/usr/bin/plutil", "/usr/bin/df", "/usr/bin/sysctl", "/usr/bin/dscl"]) f.files.set(a, { text: "", mtimeMs: 0, exec: true });
		f.plists.set(d, { ProgramArguments: ["/bin/bun", "run", d], StartInterval: 600, RunAtLoad: true, StandardOutPath: log, EnvironmentVariables: { PATH: "/usr/bin:/bin" } });
		f.launchctl.set("com.agent-system-2.doctor", print({ path: d, log, runs: 4, exit: 1 }));
		expect(verdicts(checkJob(f.deps, row("doctor")))).toEqual(["pass job:doctor", "pass deps:doctor"]);
		f.launchctl.set("com.agent-system-2.doctor", print({ path: d, log, runs: 4, exit: 2 }));
		expect(checkJob(f.deps, row("doctor"))[0]!.verdict).toBe("fail");
	});

	test("phoenix in this user's own home: required unless observability.phoenix is off (unreadable config counts as required); KeepAlive is judged by running", () => {
		const f = fake();
		f.ownHome.home = f.home;
		const p = plistPathOf(f.home, "phoenix");
		const config = join(f.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml");
		expect(checkJob(f.deps, row("phoenix"))[0]!.verdict).toBe("not installed");
		f.files.get(config)!.text = "observability:\n  phoenix: [lanes]\n";
		expect(checkJob(f.deps, row("phoenix"))[0]).toMatchObject({ verdict: "fail", evidence: `${p} is missing` });
		f.files.delete(config);
		expect(checkJob(f.deps, row("phoenix"))[0]!.evidence).toContain("observability.phoenix unknown");
		f.files.set(p, { text: "", mtimeMs: T0, exec: false });
		f.plists.set(p, { ProgramArguments: ["/bin/bash", "/repo/install/phoenix-run.sh"], KeepAlive: true, StandardOutPath: "/l", EnvironmentVariables: { PATH: "/usr/bin:/bin", PHOENIX_PYTHON: "/py" } });
		f.launchctl.set("com.agent-system-2.phoenix", print({ path: p, log: "/l", runs: 1, exit: "never", state: "running", pid: 777 }));
		expect(checkJob(f.deps, row("phoenix"))[0]).toMatchObject({ verdict: "pass", evidence: `loaded from ${p}, running as pid 777, runs 1` });
		f.launchctl.set("com.agent-system-2.phoenix", print({ path: p, log: "/l", runs: 9, exit: 1, state: "not running" }));
		expect(checkJob(f.deps, row("phoenix"))[0]!.verdict).toBe("fail");
	});

	test("phoenix with HOME not this user's home is not installed, as install.sh never installs it there; an unreadable dscl answer fails closed", () => {
		const f = fake();
		const p = plistPathOf(f.home, "phoenix");
		const config = join(f.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml");
		f.files.get(config)!.text = "observability:\n  phoenix: all\n";
		expect(checkJob(f.deps, row("phoenix"))).toEqual([{
			part: "job:phoenix", verdict: "not installed", fix: "",
			evidence: `not installed: HOME (${f.home}) is not this user's home (/Users/other), so install.sh does not install Phoenix here (launchd has one domain per user)`,
		}]);
		f.files.delete(config);
		expect(checkJob(f.deps, row("phoenix"))[0]!.verdict).toBe("not installed");
		const run = f.deps.run;
		f.deps = { ...f.deps, run: (argv, env) => (argv[0] === "dscl" ? { code: 64, stdout: "", stderr: "dscl: no such user" } : run(argv, env)) };
		expect(checkJob(f.deps, row("phoenix"))[0]).toMatchObject({ verdict: "fail", evidence: expect.stringContaining(`${p} is missing (whether HOME is this user's home could not be read: `) });
	});

	test("deps: a name off the job's PATH, an unset or missing env executable and a missing ProgramArguments path fail deps:<job>", () => {
		const f = fake();
		const p = plistPathOf(f.home, "drive-backup");
		f.files.set(p, { text: "", mtimeMs: T0, exec: false });
		f.plists.set(p, { ProgramArguments: ["/bin/zsh", "/repo/install/drive-backup/backup-nightly.zsh"], StartCalendarInterval: { Hour: 3, Minute: 0 }, StandardOutPath: "/l", EnvironmentVariables: { PATH: "/opt/none" } });
		const d = checkJob(f.deps, row("drive-backup")).find((r) => r.part === "deps:drive-backup")!;
		expect(d.verdict).toBe("fail");
		expect(d.evidence).toContain("/bin/zsh (ProgramArguments[0]) is not an executable file");
		expect(d.evidence).toContain("/repo/install/drive-backup/backup-nightly.zsh (ProgramArguments[1]) does not exist");
		expect(d.evidence).toContain("EnvironmentVariables.AS2_BUN is not set");
		expect(d.evidence).toContain("mktemp is not on the job's PATH");
		expect(d.evidence).toContain("(job PATH /opt/none)");
		expect(d.fix).toBe(`reinstall (it rebuilds the PATH): bash ${REPO}/install/install.sh --drive-backup`);
	});

	test("job-inventory: an install/ plist the table does not classify fails", async () => {
		const f = fake();
		f.dirs.get(join(REPO, "install"))!.push("com.agent-system-2.newjob.plist");
		expect(only(await checkParts(f.deps, new Set(["jobs"])), "job-inventory")[0]).toMatchObject({ verdict: "fail", evidence: `com.agent-system-2.newjob in ${REPO}/install is not in the doctor's job inventory` });
	});

	test("one part's check that throws fails that part only; every other part still runs", async () => {
		const f = fake();
		const readdir = f.deps.fs.readdir;
		f.deps.fs.readdir = (p) => {
			if (p === join(REPO, "install")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			return readdir(p);
		};
		const rs = await checkParts(f.deps);
		expect(only(rs, "job-inventory")[0]).toMatchObject({ verdict: "fail", evidence: "the check itself failed: EACCES: permission denied" });
		expect(rs.filter((r) => r.verdict === "fail")).toHaveLength(1);
	});

	test("ledger: unopenable fails ledger and backup; a stale backup and an unlistable backup directory fail backup (fake clock c.ms)", () => {
		const f = fake();
		const missing = { ...f.deps, ledgerPath: join(tmp("doctor-none"), "ledger.db") };
		expect(verdicts(checkLedger(missing))).toEqual(["fail ledger", "fail backup"]);
		expect(verdicts(checkLedger(f.deps))).toEqual(["pass ledger", "pass backup"]);
		const l = standing(f);
		l.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "doctor-boot: 1" });
		f.c.ms = T0 + 31 * HOUR;
		l.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "doctor-boot: 2" });
		l.close();
		const stale = checkLedger(f.deps)[1]!;
		expect(stale.verdict).toBe("fail");
		expect(stale.evidence).toContain("writes since then are in no copy");
		const dir = backupDir(f.ledgerPath);
		mkdirSync(join(dir, ".."), { recursive: true });
		writeFileSync(dir, "not a directory");
		const unjudged = checkLedger(f.deps)[1]!;
		expect(unjudged.verdict).toBe("fail");
		expect(unjudged.evidence).toContain(`unjudged: the backup directory ${dir} could not be listed`);
	});

	test("seat: no orchestrator process fails; a failed probe fails with the probe's error", () => {
		const f = fake();
		expect(checkSeat(f.deps)).toEqual({ part: "seat", verdict: "pass", evidence: `pid ${SEAT_PID} since ${new Date(LSTART).toISOString()}`, fix: "" });
		f.answers.set("pgrep", { code: 1, stdout: "", stderr: "" });
		expect(checkSeat(f.deps)).toMatchObject({ verdict: "fail", fix: "run `as2` in your own Terminal" });
		f.answers.set("pgrep", { code: 3, stdout: "", stderr: "pgrep: bad" });
		expect(checkSeat(f.deps).evidence).toContain("the process probe failed: pgrep -f");
	});

	test("mailbox: a published envelope or a dead owner's claim over 10 min fails; a live owner's claim fails only past 30 min (fake clock c.ms)", () => {
		const f = fake();
		const inbox = join(f.home, ".omp", "agent", "seat-mailboxes", "inbox", "ilex");
		const env = "1762084800000-abcdef.json";
		f.dirs.set(inbox, [env]);
		f.files.set(join(inbox, env), { text: "{}", mtimeMs: T0 - 10 * MIN, exec: false });
		expect(checkMailbox(f.deps).verdict).toBe("pass");
		f.c.ms = T0 + 1;
		expect(checkMailbox(f.deps).evidence).toContain(`${env} published 10 min ago and not claimed`);
		const live = `${env}.claimed-ilex-${SEAT_PID}`;
		f.dirs.set(inbox, [live]);
		f.files.set(join(inbox, live), { text: "{}", mtimeMs: T0 - 20 * MIN, exec: false });
		expect(checkMailbox(f.deps).verdict).toBe("pass");
		f.c.ms = T0 + 11 * MIN;
		expect(checkMailbox(f.deps).evidence).toContain(`held 31 min by live pid ${SEAT_PID}`);
		const dead = `${env}.claimed-ilex-999`;
		f.dirs.set(inbox, [dead]);
		f.files.set(join(inbox, dead), { text: "{}", mtimeMs: f.c.ms - 11 * MIN, exec: false });
		expect(checkMailbox(f.deps).evidence).toContain("its owner pid 999 gone");
	});

	test("gh: thewolff logged in passes whatever account is active; missing, a bad state or an unknown shape fails", () => {
		const f = fake();
		const gh = (v: unknown) => f.answers.set("gh", ok(JSON.stringify(v)));
		gh({ hosts: { "github.com": [{ login: "other", state: "success", active: true }, { login: "thewolff", state: "success", active: false }] } });
		expect(checkGh(f.deps)).toMatchObject({ verdict: "pass", evidence: "thewolff logged in on github.com (active account: other)" });
		gh({ hosts: { "github.com": [{ login: "thewolff", state: "error", active: true }] } });
		expect(checkGh(f.deps).evidence).toBe('thewolff on github.com is in state "error" (active account: thewolff)');
		gh({ hosts: {} });
		expect(checkGh(f.deps).evidence).toBe("no github.com account is logged in");
		gh({ hosts: { "github.com": { login: "thewolff" } } });
		expect(checkGh(f.deps).evidence).toContain("answered an unknown shape");
	});

	test("disk: under 10 GiB free fails", () => {
		const f = fake();
		f.answers.set("df", ok("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 994662584 400000000 9437184 99% /System/Volumes/Data\n"));
		expect(checkDisk(f.deps)).toMatchObject({ verdict: "fail", evidence: "9.0 GiB free on /System/Volumes/Data (under 10 GiB)" });
	});

	test("mcp: a load failure in the last 2 h fails, and an unopenable log fails (never read as zero failures)", async () => {
		const f = fake();
		const dir = join(f.home, ".omp", "profiles", "agent-system-2", "logs");
		mkdirSync(dir, { recursive: true });
		const log = join(dir, "omp.2026-11-02.1.log");
		writeFileSync(log, `${JSON.stringify({ timestamp: new Date(T0 - 30 * MIN).toISOString(), message: "MCP tool load failed", path: "mcp:linear", error: "HTTP 401: no" })}\n`);
		const failed = await checkMcp(f.deps);
		expect(failed.verdict).toBe("fail");
		expect(failed.evidence).toContain("mcp-load: linear failed to load 1 time(s)");
		writeFileSync(log, "");
		chmodSync(log, 0o000);
		const unreadable = await checkMcp(f.deps);
		chmodSync(log, 0o644);
		expect(unreadable).toMatchObject({ verdict: "fail", evidence: `mcp-load: OMP logs unreadable (${log})` });
	});
});

describe("episodes", () => {
	test("the tick's ctx part: a strike on the first failure, a down on the second in a row, nothing more, an up on recovery; a lone strike clears too", () => {
		const f = fake();
		const l = open(f);
		const stopped = ok(ctxJson({ running: false, lastMs: T0 }));
		const healthy = ok(ctxJson({ lastMs: T0 }));
		const pass = (a: ProbeResult) => {
			f.answers.set("ctx", a);
			f.out.length = 0;
			doctorTick(l, f.deps);
			return f.out[0]!;
		};
		expect(pass(stopped)).toBe("doctor ctx: fail the ctx daemon is not running (.daemon.running = false)");
		expect(kinds(l)).toEqual(["strike ctx"]);
		expect(f.spawned).toEqual([]);
		pass(stopped);
		expect(kinds(l)).toEqual(["strike ctx", "down ctx"]);
		expect(f.spawned).toHaveLength(1);
		pass(stopped);
		expect(kinds(l)).toEqual(["strike ctx", "down ctx"]);
		expect(pass(healthy)).toBe("doctor ctx: pass daemon running, core_refresh 0 min ago");
		expect(kinds(l)).toEqual(["strike ctx", "down ctx", "up ctx"]);
		pass(healthy);
		pass(stopped);
		pass(healthy);
		expect(kinds(l)).toEqual(["strike ctx", "down ctx", "up ctx", "strike ctx", "up ctx"]);
		l.close();
	});

	test("after-restart: nothing before 10 min of uptime; then every part once per boot, a down per failure; later runs re-check open parts and clear them (fake clock c.ms)", async () => {
		const f = fake();
		f.boot.sec = Math.floor((T0 - 9 * MIN) / 1000);
		f.answers.set("ctx", ok(ctxJson({ running: false, lastMs: T0 })));
		f.launchctl.delete("com.agent-system-2.ledger-backup");
		const early = await runAfterRestart(f.deps);
		expect(early.results).toEqual([]);
		expect(early.notes[0]).toContain("uptime 9 min, under 10 min; the boot run waits");
		expect(early.exit).toBe(0);
		f.c.ms = T0 + MIN;
		const first = await runAfterRestart(f.deps);
		expect(first.exit).toBe(1);
		const l = open(f);
		expect(kinds(l)).toEqual(["down job:ledger-backup", "down ctx", "boot"]);
		expect(f.spawned).toHaveLength(1);
		f.calls.length = 0;
		const again = await runAfterRestart(f.deps);
		expect(verdicts(again.results)).toEqual(["fail job:ledger-backup", "fail ctx"]);
		expect(kinds(l)).toEqual(["down job:ledger-backup", "down ctx", "boot"]);
		expect(f.calls.some((c) => c.argv[0] === "gh")).toBe(false);
		f.answers.set("ctx", ok(ctxJson({ lastMs: f.c.ms })));
		await runAfterRestart(f.deps);
		expect(kinds(l)).toEqual(["down job:ledger-backup", "down ctx", "boot", "up ctx"]);
		f.boot.sec += 3600;
		f.c.ms += 2 * HOUR;
		f.answers.set("ctx", ok(ctxJson({ running: false, lastMs: f.c.ms })));
		await runAfterRestart(f.deps);
		expect(kinds(l).slice(4)).toEqual(["down ctx", "boot"]);
		l.close();
	});

	test("after-restart past the boot run keeps a sibling-named failure from re-checking an open part: printed, exit 1, no new down", async () => {
		const f = fake();
		const l = standing(f);
		const p = plistPathOf(f.home, "train-tick");
		f.files.set(p, { text: "<plist/>", mtimeMs: T0, exec: false });
		down(l, "deps:train-tick");
		l.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatDoctor({ prefix: "doctor-boot", boot: f.boot.sec }) });
		const r = await runAfterRestart(f.deps);
		expect(r.exit).toBe(1);
		expect(verdicts(r.results)).toContain("fail job:train-tick");
		expect(kinds(l).filter((k) => k.startsWith("down"))).toEqual(["down deps:train-tick"]);
		l.close();
	});

	test("a terminal run clears a part it sees pass and never opens a down", async () => {
		const f = fake();
		const l = open(f);
		f.answers.set("ctx", ok(ctxJson({ running: false, lastMs: T0 })));
		doctorTick(l, f.deps);
		doctorTick(l, f.deps);
		f.launchctl.delete("com.agent-system-2.ledger-backup");
		f.answers.set("ctx", ok(ctxJson({ lastMs: T0 })));
		const r = await runDefault(f.deps);
		expect(r.exit).toBe(1);
		expect(kinds(l)).toEqual(["strike ctx", "down ctx", "up ctx"]);
		l.close();
	});
});

/** Record a claim directly (as another popup process would have). */
function claim(l: Ledger, popupId: string, o: { pid: number; start: string; boot: number; until: string; downs: string[] }): void {
	l.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatDoctor({ prefix: "doctor-popup", popupId, outcome: { state: "claimed", ...o, after: null } }) });
}
function down(l: Ledger, part: string): string {
	return l.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatDoctor({ prefix: "doctor-down", part, evidence: `${part} is broken`, fix: `fix ${part}` }) });
}
function standing(f: Fake): Ledger {
	const l = open(f);
	ensureStandingWorkload(l);
	return l;
}

describe("popups", () => {
	test("one popup process claims every pending down, shows one popup naming each part and fix, and writes the answer", () => {
		const f = fake();
		const l = standing(f);
		const a = down(l, "ctx");
		const b = down(l, "gh");
		expect(popupRun(l, f.deps)).toBe(0);
		expect(f.alarms).toHaveLength(1);
		expect(f.alarms[0]!.title).toBe("as2 doctor: 2 parts are down");
		expect(f.alarms[0]!.text).toBe("ctx: ctx is broken\nFix: fix ctx\n\ngh: gh is broken\nFix: fix gh");
		expect(f.alarms[0]!.giveUpSecs).toBe(43_200);
		const popups = recordsOf(l).filter((r) => r.prefix === "doctor-popup");
		expect(popups.map((p) => (p.prefix === "doctor-popup" ? p.outcome : null))).toEqual([
			{ state: "claimed", pid: OWN_PID, start: new Date(LSTART).toISOString(), boot: f.boot.sec, until: new Date(T0 + CLAIM_MS).toISOString(), downs: [a, b], after: null },
			{ state: "answered", detail: "Dismiss (no voice)" },
		]);
		expect(pendingDowns(doctorControl(l))).toEqual([]);
		expect(popupRun(l, f.deps)).toBe(0);
		expect(f.alarms).toHaveLength(1);
		l.close();
	});

	test("two claimers: the second, starting while the first's popup is up, re-reads inside its write and claims nothing", () => {
		const f = fake();
		const l = standing(f);
		down(l, "ctx");
		// The second popup process exists for ps, so its own start time reads (a failed read now fails its run).
		f.ps.set(OWN_PID + 1, { lstart: LSTART, command: "bun surface/scripts/doctor.ts --popup" });
		const second: number[] = [];
		const alarm = f.deps.alarm;
		f.deps.alarm = (...args) => {
			second.push(popupRun(l, { ...f.deps, pid: OWN_PID + 1, alarm }));
			return alarm(...args);
		};
		expect(popupRun(l, f.deps)).toBe(0);
		expect(second).toEqual([0]);
		expect(f.alarms).toHaveLength(1);
		expect(recordsOf(l).filter((r) => r.prefix === "doctor-popup" && r.outcome.state === "claimed")).toHaveLength(1);
		l.close();
	});

	test("any run settles claims: prior boot, owner gone and reused pid are abandoned; a live owner past until is expired and killed (fake clock c.ms)", () => {
		const f = fake();
		const l = standing(f);
		const d = down(l, "ctx");
		const until = new Date(T0 + HOUR).toISOString();
		const start = new Date(LSTART).toISOString();
		f.ps.set(7001, { lstart: LSTART, command: "x" });
		f.ps.set(7002, { lstart: "Tue Nov  3 09:00:00 2026", command: "x" });
		f.ps.set(7003, { lstart: LSTART, command: "x" });
		claim(l, "pp-prior", { pid: 7001, start, boot: f.boot.sec - 100, until, downs: [d] });
		claim(l, "pp-gone", { pid: 7999, start, boot: f.boot.sec, until, downs: [d] });
		claim(l, "pp-reused", { pid: 7002, start, boot: f.boot.sec, until, downs: [d] });
		claim(l, "pp-live", { pid: 7003, start, boot: f.boot.sec, until, downs: [d] });
		settleClaims(l, f.deps, { failed: false });
		const outcomes = () => Object.fromEntries(recordsOf(l).flatMap((r) => (r.prefix === "doctor-popup" && r.outcome.state !== "claimed" ? [[r.popupId, `${r.outcome.state} ${r.outcome.detail}`]] : [])));
		expect(outcomes()).toEqual({
			"pp-prior": `abandoned prior boot ${f.boot.sec - 100} (now ${f.boot.sec})`,
			"pp-gone": "abandoned owner pid 7999 gone",
			"pp-reused": "abandoned pid 7002 reused by another process",
		});
		expect(f.killed).toEqual([]);
		f.c.ms = T0 + HOUR + 1;
		const flag = { failed: false };
		settleClaims(l, f.deps, flag);
		expect(flag.failed).toBe(false);
		expect(outcomes()["pp-live"]).toBe(`expired past until ${until}; owner pid 7003 killed`);
		expect(f.killed).toEqual([7003]);
		expect(popupAttempts(doctorControl(l), d)).toEqual({ spent: 4, last: `expired past until ${until}; owner pid 7003 killed`, answered: false });
		l.close();
	});

	test("a popup that fails spends one attempt and exits 1; after 3 unanswered attempts no 4th popup is spawned and the needs-you line says so", () => {
		const f = fake();
		const l = standing(f);
		const d = down(l, "ctx");
		f.deps.spawnPopup = () => {
			f.spawned.push(f.c.ms);
			return `popup exited ${popupRun(l, f.deps)}`;
		};
		f.alarmAnswers.push(
			{ state: "failed", detail: "zsh quiet-alarm.zsh exited 1: no window server", stderr: "" },
			{ state: "failed", detail: "zsh quiet-alarm.zsh exited 1: no window server", stderr: "" },
			{ state: "failed", detail: "zsh quiet-alarm.zsh exited 1: still none", stderr: "" },
		);
		// settleAndSpawn's own lines (the popup process's lines go to f.out through popupRun's deps).
		const flag = { failed: false };
		const spawnLines = () => {
			const lines: string[] = [];
			settleAndSpawn(l, { ...f.deps, out: (x) => lines.push(x) }, flag);
			return lines;
		};
		expect(spawnLines()).toEqual(["1 down(s) pending a popup (ctx): popup exited 1"]);
		expect(popupAttempts(doctorControl(l), d)).toEqual({ spent: 1, last: "failed zsh quiet-alarm.zsh exited 1: no window server", answered: false });
		expect(doctorLines(doctorControl(l))[0]!.line).not.toContain("popup failed");
		spawnLines();
		spawnLines();
		expect(spawnLines()).toEqual([]);
		expect(flag.failed).toBe(false);
		expect(f.spawned).toHaveLength(POPUP_ATTEMPT_LIMIT);
		expect(f.alarms).toHaveLength(3);
		const [line] = doctorLines(doctorControl(l));
		expect(line!.line).toEndWith("; popup failed 3 times: failed zsh quiet-alarm.zsh exited 1: still none");
		expect(line!.state).toBe("popup-failed");
		l.close();
	});

	test("owners killed after their dialog appeared: each death spends an attempt; a down gets at most 4 popups, then none, and the line says so", () => {
		const f = fake();
		const l = standing(f);
		const d = down(l, "ctx");
		let pid = 8000;
		// Each spawned popup process claims and shows its dialog, then dies before writing an outcome.
		f.deps.spawnPopup = () => {
			const me = ++pid;
			f.ps.set(me, { lstart: LSTART, command: "bun doctor.ts --popup" });
			popupRun(l, { ...f.deps, pid: me, alarm: (title, text, spoken, giveUpSecs) => {
				f.alarms.push({ title, text, spoken, giveUpSecs });
				f.ps.delete(me);
				throw new Error("killed");
			} });
			return "spawned";
		};
		// A spawn that throws is caught and logged by settleAndSpawn; the claim it wrote stays without an outcome.
		const flag = { failed: false };
		for (let i = 0; i < 6; i++) settleAndSpawn(l, f.deps, flag);
		expect(f.alarms.length).toBeLessThanOrEqual(4);
		expect(f.alarms).toHaveLength(3);
		expect(popupAttempts(doctorControl(l), d)).toEqual({ spent: 3, last: `abandoned owner pid ${pid} gone`, answered: false });
		expect(pendingDowns(doctorControl(l))).toEqual([]);
		expect(doctorLines(doctorControl(l))[0]!.line).toEndWith(`; popup failed 3 times: abandoned owner pid ${pid} gone`);
		l.close();
	});

	test("the ledger-down popup: one attempt at a time, at most 3 unanswered per boot, an answer ends it; an unreadable record fires the banner", () => {
		const f = fake();
		f.alarmAnswers.push({ state: "failed", detail: "a", stderr: "" }, { state: "failed", detail: "b", stderr: "" }, { state: "failed", detail: "c", stderr: "" });
		const flag = { failed: false };
		for (let i = 0; i < 4; i++) ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		expect(f.alarms).toHaveLength(3);
		expect(f.out.at(-1)).toBe("ledger-down popup failed 3 times this boot: failed c");
		f.boot.sec += 1000;
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		expect(f.alarms).toHaveLength(4);
		expect(f.out.at(-1)).toContain("the ledger-down popup was shown this boot");
		f.files.get(ledgerDownPath(f.home))!.text = "{not json";
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		expect(f.notified).toEqual(["as2 doctor: the ledger cannot be opened: SQLITE_CORRUPT"]);
		expect(f.alarms).toHaveLength(4);
	});

	test("the ledger-down popup's stalled owner is expired and killed by the next job run (fake clock c.ms)", () => {
		const f = fake();
		f.files.set(ledgerDownPath(f.home), { text: JSON.stringify({ boot: f.boot.sec, attempts: [{ pid: 7003, start: new Date(LSTART).toISOString(), began: new Date(T0).toISOString(), until: new Date(T0 + 70 * MIN).toISOString() }] }), mtimeMs: T0, exec: false });
		f.ps.set(7003, { lstart: LSTART, command: "x" });
		ledgerDownPopup(f.deps, "x", { failed: false });
		expect(f.alarms).toHaveLength(0);
		f.c.ms = T0 + 70 * MIN + 1;
		ledgerDownPopup(f.deps, "x", { failed: false });
		expect(f.killed).toEqual([7003]);
		expect(f.alarms).toHaveLength(1);
	});

	test("after-restart with an unopenable ledger checks every part and shows the ledger-down popup", async () => {
		const f = fake();
		const deps = { ...f.deps, ledgerPath: join(tmp("doctor-gone"), "ledger.db") };
		const r = await runAfterRestart(deps);
		expect(r.exit).toBe(1);
		expect(verdicts(r.results)).toContain("fail ledger");
		expect(f.alarms.map((a) => a.title)).toEqual(["as2 doctor: the ledger cannot be opened"]);
	});

	test("ledger-down popup: a failed owner probe is reported, never called 'showing'; a live attempt starts no new popup, an expired one records the probe failure and does not kill", () => {
		const f = fake();
		const rec = (until: number) => JSON.stringify({ boot: f.boot.sec, attempts: [{ pid: 7003, start: new Date(LSTART).toISOString(), began: new Date(T0).toISOString(), until: new Date(until).toISOString() }] });
		f.files.set(ledgerDownPath(f.home), { text: rec(T0 + 70 * MIN), mtimeMs: T0, exec: false });
		const base = f.deps.run;
		f.deps.run = (argv, env) => (argv[0] === "ps" && argv.includes("7003") ? { code: null, stdout: "", stderr: "", error: "could not start: ps is not on PATH" } : base(argv, env));
		const flag = { failed: false };
		ledgerDownPopup(f.deps, "x", flag);
		expect(flag.failed).toBe(true);
		expect(f.out.join("\n")).toContain("owner pid 7003 could not be checked");
		expect(f.out.join("\n")).toContain("could not start: ps is not on PATH");
		expect(f.out.join("\n")).not.toContain("popup is showing");
		expect(f.alarms).toHaveLength(0);
		f.out.length = 0;
		f.c.ms = T0 + 70 * MIN + 1;
		ledgerDownPopup(f.deps, "x", flag);
		expect(f.killed).toEqual([]);
		expect(f.alarms).toHaveLength(0);
		const saved = JSON.parse(f.files.get(ledgerDownPath(f.home))!.text) as { attempts: { outcome?: string; error?: string }[] };
		expect(saved.attempts[0]!.outcome).toContain("could not be read");
		expect(saved.attempts[0]!.outcome).toContain("could not start: ps is not on PATH");
		expect(saved.attempts[0]!.error).toContain("ps for owner pid 7003");
	});

	test("after-restart with an unopenable ledger and a failed owner probe exits 1 and names the failure", async () => {
		const f = fake();
		f.files.set(ledgerDownPath(f.home), { text: JSON.stringify({ boot: f.boot.sec, attempts: [{ pid: 7003, start: new Date(LSTART).toISOString(), began: new Date(T0).toISOString(), until: new Date(T0 + 70 * MIN).toISOString() }] }), mtimeMs: T0, exec: false });
		const base = f.deps.run;
		const deps = { ...f.deps, ledgerPath: join(tmp("doctor-gone"), "ledger.db"), run: (argv: readonly string[], env?: Record<string, string | undefined>) => (argv[0] === "ps" && argv.includes("7003") ? { code: null, stdout: "", stderr: "", error: "could not start: ps is not on PATH" } : base(argv, env)) };
		const r = await runAfterRestart(deps);
		expect(r.exit).toBe(1);
		expect(r.notes.join("\n")).toContain("could not start: ps is not on PATH");
		expect(r.notes.join("\n")).not.toContain("popup is showing");
	});

	test("a writable open that fails after the read-only check passed exits 1 and names the error", async () => {
		// The ledger path reads as the real ledger for the checks' reads and as a missing file after them, so the read-only
		// open passes and the writable open throws (no ledger at <path>).
		const f = fake();
		const missing = join(tmp("doctor-missing"), "ledger.db");
		const reads = { n: 0, limit: Number.POSITIVE_INFINITY };
		const deps: DoctorDeps = { ...f.deps };
		Object.defineProperty(deps, "ledgerPath", { get: () => (++reads.n > reads.limit ? missing : f.ledgerPath) });
		await checkParts(deps);
		reads.limit = reads.n;
		reads.n = 0;
		const d = await runDefault(deps);
		expect(verdicts(d.results)).toContain("pass ledger");
		expect(d.notes.join("\n")).toContain(`could not be opened for writing (no ledger at `);
		expect(d.exit).toBe(1);
	});

	// Review r5 F14: quiet-alarm.zsh can print a mktemp or rm failure and still exit 0 (or 3) after the dialog was
	// answered. These run the real alarmPopup over an injected runner, so the helper's exit and stderr reach the popup run.
	const helperAlarm = (f: Fake, run: AlarmRun): DoctorDeps["alarm"] => (title, text, spoken, giveUpSecs, timeoutMs) => {
		f.alarms.push({ title, text, spoken, giveUpSecs });
		return alarmPopup(title, text, spoken, { repo: REPO, giveUpSecs, env: {}, timeoutMs, spawn: () => run });
	};
	const popupOutcomes = (l: Ledger) => recordsOf(l).flatMap((r) => (r.prefix === "doctor-popup" && r.outcome.state !== "claimed" ? [r.outcome] : []));

	test("F14: quiet-alarm exits 0 answered but printed a mktemp failure: answered with the text kept, printed naming quiet-alarm.zsh, exit 1, no second popup", () => {
		const f = fake();
		const l = standing(f);
		const d = down(l, "ctx");
		f.deps.alarm = helperAlarm(f, { code: 0, stdout: "quiet-alarm: choice=Dismiss (no voice)\n", stderr: "mktemp: mkstemp failed\n" });
		expect(popupRun(l, f.deps)).toBe(1);
		expect(f.out.join("\n")).toContain("shown, but quiet-alarm.zsh reported an error on stderr: mktemp: mkstemp failed");
		expect(popupOutcomes(l)).toEqual([{ state: "answered", detail: "Dismiss (no voice); quiet-alarm.zsh stderr: mktemp: mkstemp failed" }]);
		expect(popupAttempts(doctorControl(l), d)).toEqual({ spent: 0, last: null, answered: true });
		expect(pendingDowns(doctorControl(l))).toEqual([]);
		expect(popupRun(l, f.deps)).toBe(0);
		expect(f.alarms).toHaveLength(1);
		l.close();
	});

	test("F14: quiet-alarm exits 0 with no stderr: exit 0 and nothing extra printed", () => {
		const f = fake();
		const l = standing(f);
		down(l, "ctx");
		f.deps.alarm = helperAlarm(f, { code: 0, stdout: "quiet-alarm: choice=Dismiss (no voice)\n", stderr: "" });
		expect(popupRun(l, f.deps)).toBe(0);
		expect(f.out).toHaveLength(3);
		expect(f.out[0]).toStartWith("wrote doctor-popup: ");
		expect(f.out[1]).toMatch(/^doctor popup pp-\S+: answered Dismiss \(no voice\)$/);
		expect(f.out[2]).toStartWith("wrote doctor-popup: ");
		expect(f.out.join("\n")).not.toContain("quiet-alarm");
		expect(popupOutcomes(l)).toEqual([{ state: "answered", detail: "Dismiss (no voice)" }]);
		l.close();
	});

	test("F14: quiet-alarm exits 3 with an audio line and an rm failure: both are kept, both printed, exit 1, no second popup", () => {
		const f = fake();
		const l = standing(f);
		down(l, "ctx");
		const audio = "quiet-alarm: audio FAILED: afplay rc 1 (x); say rc 0 (no error text)";
		f.deps.alarm = helperAlarm(f, { code: 3, stdout: "quiet-alarm: choice=Read it to me\n", stderr: `rm: /t/quiet-alarm.x: Permission denied\n${audio}\n` });
		expect(popupRun(l, f.deps)).toBe(1);
		const out = f.out.join("\n");
		expect(out).toContain(`shown, but the read-aloud failed: audio-failed ${audio}`);
		expect(out).toContain("shown, but quiet-alarm.zsh reported an error on stderr: rm: /t/quiet-alarm.x: Permission denied");
		expect(popupOutcomes(l)).toEqual([{ state: "answered", detail: `audio-failed ${audio}; quiet-alarm.zsh stderr: rm: /t/quiet-alarm.x: Permission denied` }]);
		expect(popupRun(l, f.deps)).toBe(0);
		expect(f.alarms).toHaveLength(1);
		l.close();
	});

	test("F14 residual (review r6): quiet-alarm exits 3 with only the audio line: answered with that line, printed, exit 1, no second popup", () => {
		const f = fake();
		const l = standing(f);
		const d = down(l, "ctx");
		const audio = "quiet-alarm: audio FAILED: afplay rc 1 (denied); say rc 0";
		f.deps.alarm = helperAlarm(f, { code: 3, stdout: "quiet-alarm: choice=Read it to me\n", stderr: `${audio}\n` });
		expect(popupRun(l, f.deps)).toBe(1);
		const out = f.out.join("\n");
		expect(out).toContain(`shown, but the read-aloud failed: audio-failed ${audio}; the popup counts as answered and is not shown again`);
		expect(out).not.toContain("reported an error on stderr");
		expect(popupOutcomes(l)).toEqual([{ state: "answered", detail: `audio-failed ${audio}` }]);
		expect(popupAttempts(doctorControl(l), d)).toEqual({ spent: 0, last: null, answered: true });
		expect(pendingDowns(doctorControl(l))).toEqual([]);
		expect(popupRun(l, f.deps)).toBe(0);
		expect(f.alarms).toHaveLength(1);
		l.close();
	});

	test("F14: the ledger-down popup answered beside a quiet-alarm mktemp failure keeps the text, prints it, fails the run, and is not shown again", () => {
		const f = fake();
		f.deps.alarm = helperAlarm(f, { code: 0, stdout: "quiet-alarm: choice=Dismiss (no voice)\n", stderr: "mktemp: mkstemp failed\n" });
		const flag = { failed: false };
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		expect(flag.failed).toBe(true);
		expect(f.out.join("\n")).toContain("the ledger-down popup was shown, but quiet-alarm.zsh reported an error on stderr: mktemp: mkstemp failed");
		const saved = JSON.parse(f.files.get(ledgerDownPath(f.home))!.text) as { attempts: { outcome?: string }[] };
		expect(saved.attempts.map((a) => a.outcome)).toEqual(["answered Dismiss (no voice); quiet-alarm.zsh stderr: mktemp: mkstemp failed"]);
		const again = { failed: false };
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", again);
		expect(f.alarms).toHaveLength(1);
		expect(f.out.at(-1)).toContain("the ledger-down popup was shown this boot");
	});

	test("F14 residual (review r6): the ledger-down popup answered with only quiet-alarm's audio line keeps it, prints it, fails the run, and is not shown again", () => {
		const f = fake();
		const audio = "quiet-alarm: audio FAILED: afplay rc 1 (denied); say rc 0";
		f.deps.alarm = helperAlarm(f, { code: 3, stdout: "quiet-alarm: choice=Read it to me\n", stderr: `${audio}\n` });
		const flag = { failed: false };
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		expect(flag.failed).toBe(true);
		const out = f.out.join("\n");
		expect(out).toContain(`the ledger-down popup was shown, but the read-aloud failed: audio-failed ${audio}; the popup counts as answered and is not shown again this boot`);
		expect(out).not.toContain("reported an error on stderr");
		const saved = JSON.parse(f.files.get(ledgerDownPath(f.home))!.text) as { attempts: { outcome?: string }[] };
		expect(saved.attempts.map((a) => a.outcome)).toEqual([`answered audio-failed ${audio}`]);
		const again = { failed: false };
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", again);
		expect(again.failed).toBe(false);
		expect(f.alarms).toHaveLength(1);
		expect(f.out.at(-1)).toContain("the ledger-down popup was shown this boot");
	});

	test("F14: after-restart with an unopenable ledger whose popup was answered beside a quiet-alarm stderr line names that line in its notes (exit 1)", async () => {
		const f = fake();
		f.deps.alarm = helperAlarm(f, { code: 0, stdout: "quiet-alarm: choice=Dismiss (no voice)\n", stderr: "rm: /t/quiet-alarm.x: Permission denied\n" });
		const r = await runAfterRestart({ ...f.deps, ledgerPath: join(tmp("doctor-gone"), "ledger.db") });
		expect(r.exit).toBe(1);
		expect(r.notes.join("\n")).toContain("quiet-alarm.zsh reported an error on stderr: rm: /t/quiet-alarm.x: Permission denied");
	});
});

describe("alarmPopup (quiet-alarm.zsh)", () => {
	const at = (r: AlarmRun) => alarmPopup("t", "x", "s", { repo: "/r", giveUpSecs: 43_200, env: { HOME: "/h" }, timeoutMs: 1000, spawn: (argv, env) => {
		expect(argv).toEqual(["/bin/zsh", "/r/install/drive-backup/quiet-alarm.zsh", "t", "x", "s"]);
		expect(env.QUIET_ALARM_GIVE_UP_SECS).toBe("43200");
		return r;
	} });
	test("exit 0 is answered with the button; 3 is answered with the audio failure; 1, a spawn error or a timeout is failed", () => {
		expect(at({ code: 0, stdout: "quiet-alarm: choice=Read it to me\n", stderr: "" })).toEqual({ state: "answered", detail: "Read it to me", stderr: "", otherStderr: "" });
		expect(at({ code: 3, stdout: "quiet-alarm: choice=Read it to me\n", stderr: "quiet-alarm: audio FAILED: afplay rc 1 (x); say rc 0 (no error text)\n" }))
			.toEqual({ state: "answered", detail: "audio-failed quiet-alarm: audio FAILED: afplay rc 1 (x); say rc 0 (no error text)", stderr: "quiet-alarm: audio FAILED: afplay rc 1 (x); say rc 0 (no error text)\n", otherStderr: "" });
		expect(at({ code: 1, stdout: "", stderr: "quiet-alarm: popup FAILED (osascript exit 1): no\n" }))
			.toEqual({ state: "failed", detail: "zsh /r/install/drive-backup/quiet-alarm.zsh exited 1: quiet-alarm: popup FAILED (osascript exit 1): no", stderr: "quiet-alarm: popup FAILED (osascript exit 1): no\n" });
		expect(at({ code: null, stdout: "", stderr: "", error: "timed out after 1 s and was killed" }))
			.toEqual({ state: "failed", detail: "zsh /r/install/drive-backup/quiet-alarm.zsh timed out after 1 s and was killed", stderr: "" });
	});

	test("F14: stderr beside an answered dialog is returned on exit 0, and on exit 3 every other line is kept beside the audio line", () => {
		expect(at({ code: 0, stdout: "quiet-alarm: choice=Dismiss (no voice)\n", stderr: "mktemp: mkstemp failed\n" }))
			.toEqual({ state: "answered", detail: "Dismiss (no voice)", stderr: "mktemp: mkstemp failed\n", otherStderr: "mktemp: mkstemp failed" });
		const audio = "quiet-alarm: audio FAILED: afplay rc 1 (x); say rc 0 (no error text)";
		const stderr = `mktemp: mkstemp failed\n${audio}\nrm: /t/quiet-alarm.x: Permission denied\n`;
		expect(at({ code: 3, stdout: "quiet-alarm: choice=Read it to me\n", stderr }))
			.toEqual({ state: "answered", detail: `audio-failed ${audio}`, stderr, otherStderr: "mktemp: mkstemp failed; rm: /t/quiet-alarm.x: Permission denied" });
		expect(at({ code: 3, stdout: "quiet-alarm: choice=Read it to me\n", stderr: "zsh: something else\n" }))
			.toEqual({ state: "answered", detail: `audio-failed (no "quiet-alarm: audio FAILED:" line on stderr)`, stderr: "zsh: something else\n", otherStderr: "zsh: something else" });
	});
});

describe("train-tick main: the ctx step is isolated from the train's work", () => {
	const fakeLedger = { tag: "ledger" } as unknown as Ledger;
	const steps = (o: { open?: () => Ledger; tick?: () => void; doctor?: () => boolean | void; close?: () => void } = {}) => {
		const seen: string[] = [];
		const deps: MainDeps = {
			open: o.open ?? (() => fakeLedger),
			tick: () => {
				seen.push("train");
				o.tick?.();
			},
			doctor: (ledger, openError) => {
				seen.push(`doctor ${ledger ? "ledger" : "null"} ${openError ?? "-"}`);
				return o.doctor?.() ?? false;
			},
			close: () => {
				seen.push("close");
				o.close?.();
			},
			err: (line) => seen.push(`err ${line}`),
		};
		return { seen, deps };
	};

	test("every step runs in order and main returns 0", () => {
		const s = steps();
		expect(trainTickMain([], s.deps)).toBe(0);
		expect(s.seen).toEqual(["train", "doctor ledger -", "close"]);
	});

	test("the doctor step reports a run failure and nothing throws: main returns 1", () => {
		const s = steps({ doctor: () => true });
		expect(trainTickMain([], s.deps)).toBe(1);
		expect(s.seen).toEqual(["train", "doctor ledger -", "close"]);
	});

	test("the train's work throws: the ctx step and the close still run, and the train's error is thrown as it is", () => {
		const boom = new Error("gh exploded");
		const s = steps({ tick: () => { throw boom; } });
		expect(() => trainTickMain([], s.deps)).toThrow(boom);
		expect(s.seen).toEqual(["train", "doctor ledger -", "close"]);
	});

	test("train, doctor and close all throw: one AggregateError names each step and keeps each error", () => {
		const s = steps({ tick: () => { throw new Error("t"); }, doctor: () => { throw new Error("d"); }, close: () => { throw new Error("c"); } });
		let caught: unknown;
		try {
			trainTickMain([], s.deps);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).message).toBe("train-tick: 3 steps failed: train: t; doctor: d; close: c");
		expect((caught as AggregateError).errors.map((e: Error) => e.message)).toEqual(["t", "d", "c"]);
	});

	test("an unopenable ledger: the ctx step still runs (with the open error), nothing else does, and main returns 1", () => {
		const s = steps({ open: () => { throw new Error("SQLITE_CANTOPEN"); } });
		expect(trainTickMain([], s.deps)).toBe(1);
		expect(s.seen).toEqual(["err train-tick: the ledger could not be opened: Error: SQLITE_CANTOPEN", "doctor null Error: SQLITE_CANTOPEN"]);
	});

	test("the doctor step with no ledger logs one ctx line naming the open error and writes nothing", () => {
		const f = fake();
		doctorTick(null, f.deps, "SQLITE_CANTOPEN");
		expect(f.out).toEqual(["doctor ctx: pass daemon running, core_refresh 1 min ago; the ledger could not be opened (SQLITE_CANTOPEN), so no episode is written"]);
	});
});

/** Make the `n`th Ledger close from now throw `message`, after really closing; returns the restore. */
function closeThrowsOn(n: number, message: string): () => void {
	const real = Ledger.prototype.close;
	let calls = 0;
	Ledger.prototype.close = function (this: Ledger) {
		real.call(this);
		if (++calls === n) throw new Error(message);
	};
	return () => {
		Ledger.prototype.close = real;
	};
}

/** A ledger-down record whose one attempt (pid 7003) runs until T0 + 70 min. */
const ledgerDownRecord = (f: Fake) => ({ text: JSON.stringify({ boot: f.boot.sec, attempts: [{ pid: 7003, start: new Date(LSTART).toISOString(), began: new Date(T0).toISOString(), until: new Date(T0 + 70 * MIN).toISOString() }] }), mtimeMs: T0, exec: false });

const psFailsFor = (f: Fake, pid: number) => {
	const base = f.deps.run;
	f.deps.run = (argv, env) => (argv[0] === "ps" && argv.includes(String(pid)) ? { code: null, stdout: "", stderr: "", error: "could not start: ps is not on PATH" } : base(argv, env));
};

describe("review r2: a failure is never hidden by a later one, and never exits 0", () => {
	test("F5: the writable ledger's close failing keeps the parts' failures, names the close error and exits 1 (default mode)", async () => {
		const f = fake();
		f.answers.set("ctx", ok(ctxJson({ running: false, lastMs: T0 })));
		// Close 1 is the ledger check's read-only handle; close 2 is the run's writable one.
		const restore = closeThrowsOn(2, "injected writable close failure");
		let code: number;
		try {
			code = await doctorMain([], f.deps);
		} finally {
			restore();
		}
		expect(code).toBe(1);
		const out = f.out.join("\n");
		expect(out).toContain("fail ctx: the ctx daemon is not running");
		expect(out).toContain(`doctor: the ledger ${f.ledgerPath} could not be closed after this run's writes: injected writable close failure`);
		expect(f.out.at(-1)).toBe("as2 doctor: 10 pass, 1 fail (ctx), 0 warn, 8 not installed");
	});

	test("F5: the same in --after-restart: the failing parts and the close error are both in the run's line, exit 1", async () => {
		const f = fake();
		f.answers.set("ctx", ok(ctxJson({ running: false, lastMs: T0 })));
		// The writable open comes first, then the boot run's ledger check opens and closes (close 1); close 2 is the writable one.
		const restore = closeThrowsOn(2, "injected writable close failure");
		let code: number;
		try {
			code = await doctorMain(["--after-restart"], f.deps);
		} finally {
			restore();
		}
		expect(code).toBe(1);
		expect(f.out).toHaveLength(1);
		expect(f.out[0]).toContain("1 failing: ctx (the ctx daemon is not running");
		expect(f.out[0]).toContain("could not be closed after this run's writes: injected writable close failure");
	});

	test("F5: a crash in --after-restart prints what the run collected (the boot probe's failure and the close's) before the crash", async () => {
		const f = fake();
		const l = standing(f);
		down(l, "bogus");
		l.close();
		const base = f.deps.run;
		f.deps.run = (argv, env) => (argv[0] === "sysctl" ? { code: 1, stdout: "", stderr: "sysctl: injected failure" } : base(argv, env));
		// The boot time is unreadable, so only open parts are re-checked; `bogus` is no part the doctor knows (a throw). The
		// writable close is the first close.
		const restore = closeThrowsOn(1, "injected writable close failure");
		let crash: unknown;
		try {
			await doctorMain(["--after-restart"], f.deps);
		} catch (e) {
			crash = e;
		} finally {
			restore();
		}
		expect((crash as Error).message).toBe("unknown doctor part bogus");
		expect(f.out).toHaveLength(1);
		expect(f.out[0]).toContain("doctor: the boot time could not be read");
		expect(f.out[0]).toContain("could not be closed after this run's writes: injected writable close failure");
		expect(f.out[0]).toEndWith("; crashed: unknown doctor part bogus");
	});

	test("F6: an expired ledger-down attempt whose owner probe fails and whose record cannot be written: both errors are printed (fake clock c.ms)", () => {
		const f = fake();
		f.files.set(ledgerDownPath(f.home), ledgerDownRecord(f));
		f.c.ms = T0 + 70 * MIN + 1;
		psFailsFor(f, 7003);
		f.deps.fs.writeAtomic = () => {
			throw new Error("injected record write denied");
		};
		const flag = { failed: false };
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		const out = f.out.join("\n");
		expect(out).toContain("the ledger-down popup's owner pid 7003 could not be checked (`ps");
		expect(out).toContain("could not start: ps is not on PATH");
		expect(out).toContain("could not be written (injected record write denied); the banner fires instead");
		expect(f.notified).toEqual(["as2 doctor: the ledger cannot be opened: SQLITE_CORRUPT"]);
		expect(flag.failed).toBe(true);
	});

	test("F7: a pending down, no failing part and a popup spawn that throws: the note is printed and the run exits 1; the tick step reports it too", async () => {
		const f = fake();
		const l = standing(f);
		down(l, "job:train-tick");
		f.deps.spawnPopup = () => {
			throw new Error("injected popup spawn refused");
		};
		const code = await doctorMain([], f.deps);
		expect(code).toBe(1);
		expect(f.out.join("\n")).toContain("doctor: spawning the popup process failed (injected popup spawn refused); this run claimed nothing, so the next run spawns it again");
		expect(f.out.at(-1)).toBe("as2 doctor: 11 pass, 0 fail, 0 warn, 8 not installed; the run failed: see the doctor: lines above");
		expect(doctorTick(l, f.deps).failed).toBe(true);
		l.close();
	});

	test("sweep: the read-only ledger check's close failing keeps the backup verdict and fails ledger with the close error", () => {
		const f = fake();
		const restore = closeThrowsOn(1, "injected read-only close failure");
		let rs: PartResult[];
		try {
			rs = checkLedger(f.deps);
		} finally {
			restore();
		}
		expect(verdicts(rs)).toEqual(["fail ledger", "pass backup"]);
		expect(rs[0]!.evidence).toBe(`${f.ledgerPath} could not be closed after its read: injected read-only close failure`);
	});

	test("sweep: thenClose keeps the value beside a close error, and joins a work error and a close error in one AggregateError", () => {
		const f = fake();
		const restore = closeThrowsOn(1, "close failed");
		try {
			expect(thenClose(open(f), "w", () => 7)).toEqual({ value: 7, closeError: "close failed" });
		} finally {
			restore();
		}
		const restore2 = closeThrowsOn(1, "close failed");
		let caught: unknown;
		try {
			thenClose(open(f), "the work", () => {
				throw new Error("work failed");
			});
		} catch (e) {
			caught = e;
		} finally {
			restore2();
		}
		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors.map((e: Error) => e.message)).toEqual(["work failed", "close failed"]);
		expect((caught as AggregateError).message).toBe("the work failed (work failed), and closing the ledger failed too (close failed)");
	});

	test("sweep: a settled claim whose owner cannot be killed fails the run (fake clock c.ms)", async () => {
		const f = fake();
		const l = standing(f);
		const d = down(l, "job:train-tick");
		f.ps.set(7003, { lstart: LSTART, command: "x" });
		claim(l, "pp-live", { pid: 7003, start: new Date(LSTART).toISOString(), boot: f.boot.sec, until: new Date(T0 + 10 * MIN).toISOString(), downs: [d] });
		l.close();
		f.c.ms = T0 + 10 * MIN + 1;
		f.deps.kill = () => {
			throw new Error("injected EPERM");
		};
		const r = await runDefault(f.deps);
		expect(r.exit).toBe(1);
		expect(r.notes.join("\n")).toContain("doctor: expired claim pp-live's owner pid 7003 could not be killed: injected EPERM");
	});

	test("sweep: a claim judged with the boot probe failing, or with its owner probe failing, fails the run", async () => {
		const seeded = () => {
			const f = fake();
			const l = standing(f);
			f.ps.set(7003, { lstart: LSTART, command: "x" });
			claim(l, "pp-live", { pid: 7003, start: new Date(LSTART).toISOString(), boot: f.boot.sec, until: new Date(T0 + HOUR).toISOString(), downs: [down(l, "job:train-tick")] });
			l.close();
			return f;
		};
		const noBoot = seeded();
		const base = noBoot.deps.run;
		noBoot.deps.run = (argv, env) => (argv[0] === "sysctl" ? { code: 1, stdout: "", stderr: "sysctl: injected failure" } : base(argv, env));
		const r1 = await runDefault(noBoot.deps);
		expect(r1.exit).toBe(1);
		expect(r1.notes.join("\n")).toContain("doctor: the boot time could not be read");
		const noOwner = seeded();
		psFailsFor(noOwner, 7003);
		const r2 = await runDefault(noOwner.deps);
		expect(r2.exit).toBe(1);
		expect(r2.notes.join("\n")).toContain("doctor: claim pp-live's owner pid 7003 could not be checked");
	});

	test("sweep: the popup process whose own start time cannot be read exits 1 after showing the popup", () => {
		const f = fake();
		const l = standing(f);
		down(l, "ctx");
		f.ps.delete(OWN_PID);
		expect(popupRun(l, f.deps)).toBe(1);
		expect(f.alarms).toHaveLength(1);
		expect(f.out.join("\n")).toContain("doctor: this process's start time could not be read");
		l.close();
	});

	test("sweep: the popup's outcome is printed even when its write fails, and the popup process exits 1", () => {
		const f = fake();
		const l = standing(f);
		down(l, "ctx");
		const realWrite = l.write.bind(l);
		// Every write after the popup was shown (the outcome's) fails.
		l.write = (<T>(fn: () => T): T => {
			if (f.alarms.length > 0) throw new Error("injected outcome write failure");
			return realWrite(fn);
		}) as Ledger["write"];
		expect(popupRun(l, f.deps)).toBe(1);
		const out = f.out.join("\n");
		expect(out).toMatch(/doctor popup pp-\S+: answered Dismiss \(no voice\)/);
		expect(out).toContain("its outcome could not be written (injected outcome write failure)");
		l.close();
	});

	test("sweep: the ledger-down popup's stalled owner that cannot be killed is printed, not only recorded (fake clock c.ms)", () => {
		const f = fake();
		f.files.set(ledgerDownPath(f.home), ledgerDownRecord(f));
		f.ps.set(7003, { lstart: LSTART, command: "x" });
		f.c.ms = T0 + 70 * MIN + 1;
		f.deps.kill = () => {
			throw new Error("injected EPERM");
		};
		const flag = { failed: false };
		ledgerDownPopup(f.deps, "x", flag);
		expect(f.out.join("\n")).toContain("doctor: the ledger-down popup's stalled owner pid 7003 could not be killed: injected EPERM");
		expect(flag.failed).toBe(true);
	});

	test("sweep: the ledger-down popup's outcome is printed even when the record write after it fails", () => {
		const f = fake();
		f.alarmAnswers.push({ state: "failed", detail: "injected dialog error", stderr: "" });
		let saves = 0;
		const write = f.deps.fs.writeAtomic;
		// Save 1 records the new attempt; save 2 its outcome.
		f.deps.fs.writeAtomic = (p, text) => {
			if (++saves === 2) throw new Error("injected record write denied");
			write(p, text);
		};
		const flag = { failed: false };
		ledgerDownPopup(f.deps, "x", flag);
		const out = f.out.join("\n");
		expect(out).toContain("doctor: ledger-down popup failed injected dialog error");
		expect(out).toContain("could not be written (injected record write denied); the banner fires instead");
		expect(flag.failed).toBe(true);
	});

	test("sweep: --tick and --popup with a ledger close that fails print it and exit 1, the step's own lines kept", async () => {
		const f = fake();
		const restore = closeThrowsOn(1, "injected close failure");
		let tick: number;
		try {
			tick = await doctorMain(["--tick"], f.deps);
		} finally {
			restore();
		}
		expect(tick).toBe(1);
		expect(f.out.join("\n")).toContain("doctor ctx: pass daemon running");
		expect(f.out.at(-1)).toEndWith(`doctor: the ledger ${f.ledgerPath} could not be closed after the ctx step: injected close failure`);
		f.out.length = 0;
		const restore2 = closeThrowsOn(1, "injected close failure");
		let popup: number;
		try {
			popup = await doctorMain(["--popup"], f.deps);
		} finally {
			restore2();
		}
		expect(popup).toBe(1);
		expect(f.out.join("\n")).toContain("doctor popup: nothing pending");
		expect(f.out.at(-1)).toEndWith(`doctor popup: the ledger ${f.ledgerPath} could not be closed: injected close failure`);
	});

	test("sweep: spawnPopupProcess joins a spawn error with a log-close error, and names the spawned process when only the close fails", () => {
		const home = tmp("doctor-spawn-home");
		// The fd is really closed, then the close reports a failure.
		const closeFails = (fd: number) => {
			closeSync(fd);
			throw new Error("injected EBADF");
		};
		// The script's directory does not exist, so the spawn (its cwd) fails.
		let caught: unknown;
		try {
			spawnPopupProcess({ AS2_DOCTOR_POPUP_WAIT: "1" }, home, join(home, "no-such-dir", "doctor.ts"), closeFails);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors.map((e: Error) => e.message).at(-1)).toBe("injected EBADF");
		// The script does not exist but its directory does: bun starts, exits 1 in the foreground (the WAIT seam), and only the close fails.
		caught = undefined;
		try {
			spawnPopupProcess({ AS2_DOCTOR_POPUP_WAIT: "1" }, home, join(home, "doctor.ts"), closeFails);
		} catch (e) {
			caught = e;
		}
		expect((caught as Error).message).toStartWith("popup process ran in the foreground (AS2_DOCTOR_POPUP_WAIT=1) and exited 1; output in ");
		expect((caught as Error).message).toEndWith(`, but closing the popup log ${popupLogPath(home)} after the spawn failed: injected EBADF`);
	});
});

/** pid's `ps -o stat=,lstart=` answers exit 0 with a start time that does not parse. */
const UNPARSABLE = "unexpected-start-format";

describe("review r3: an expired owner's probe failure, an unparsable start time and the audited PATH names are never silent", () => {
	test("F8: an expired claim whose owner probe fails and whose settlement write throws: the probe error and the write error are both printed, exit 1 (fake clock c.ms)", async () => {
		const f = fake();
		const l = standing(f);
		const until = new Date(T0 + 10 * MIN).toISOString();
		claim(l, "pp-live", { pid: 7003, start: new Date(LSTART).toISOString(), boot: f.boot.sec, until, downs: [down(l, "job:train-tick")] });
		l.close();
		f.c.ms = T0 + 10 * MIN + 1;
		psFailsFor(f, 7003);
		// Only settleClaims's write (it returns the settled { v, body } list) throws, inside its transaction.
		const real = Ledger.prototype.write;
		Ledger.prototype.write = function <T>(this: Ledger, fn: () => T): T {
			return real.call(this, () => {
				const r = fn();
				if (Array.isArray(r) && r.length > 0 && "body" in r[0] && "v" in r[0]) throw new Error("injected settlement write denied");
				return r;
			}) as T;
		};
		let r: RunOutcome;
		try {
			r = await runDefault(f.deps);
		} finally {
			Ledger.prototype.write = real;
		}
		expect(r.exit).toBe(1);
		const notes = r.notes.join("\n");
		expect(notes).toContain(`doctor: claim pp-live's owner pid 7003 could not be checked (\`ps -p 7003 -o stat=,lstart=\` could not start: ps is not on PATH); it is past until ${until}, so it is settled expired and pid 7003 is not killed`);
		expect(notes).toContain("doctor: settling popups failed: injected settlement write denied");
		// The probe line comes before the write's failure; the claim is still unsettled, so the next run settles it.
		expect(notes.indexOf("could not be checked")).toBeLessThan(notes.indexOf("settling popups failed"));
		const l2 = open(f);
		expect(kinds(l2).filter((k) => k.startsWith("popup"))).toEqual(["popup claimed"]);
		// The same, called directly: the run flag is failed whatever the write did.
		const flag = { failed: false };
		const out: string[] = [];
		l2.write = (() => {
			throw new Error("injected settlement write denied");
		}) as Ledger["write"];
		expect(() => settleClaims(l2, { ...f.deps, out: (x) => out.push(x) }, flag)).toThrow("injected settlement write denied");
		expect(flag.failed).toBe(true);
		expect(out.join("\n")).toContain("doctor: claim pp-live's owner pid 7003 could not be checked (`ps -p 7003 -o stat=,lstart=` could not start: ps is not on PATH)");
		l2.close();
	});

	test("F9: the popup process whose own ps start time does not parse names ps's answer and exits 1", () => {
		const f = fake();
		const l = standing(f);
		f.ps.set(OWN_PID, { lstart: UNPARSABLE, command: "bun surface/scripts/doctor.ts --popup" });
		expect(popupRun(l, f.deps)).toBe(1);
		expect(f.out.join("\n")).toContain(`doctor: this process's start time could not be read (\`ps -p ${OWN_PID} -o stat=,lstart=\` answered a start time that cannot be parsed: S ${UNPARSABLE}); the claim records start unknown`);
		// With a down pending, the claim records start unknown and the run still exits 1.
		f.out.length = 0;
		down(l, "ctx");
		expect(popupRun(l, f.deps)).toBe(1);
		expect(f.out.join("\n")).toContain(`answered a start time that cannot be parsed: S ${UNPARSABLE}`);
		const claimed = recordsOf(l).find((r) => r.prefix === "doctor-popup" && r.outcome.state === "claimed");
		expect(claimed?.prefix === "doctor-popup" && claimed.outcome.state === "claimed" ? claimed.outcome.start : null).toBe("unknown");
		l.close();
	});

	test("F9: a claim's owner whose ps start time does not parse is a failed probe, printed and failing the run, never 'reused'; a recorded start unknown stays unknown (fake clock c.ms)", () => {
		const f = fake();
		const l = standing(f);
		const d = down(l, "ctx");
		const until = new Date(T0 + HOUR).toISOString();
		f.ps.set(7003, { lstart: UNPARSABLE, command: "x" });
		f.ps.set(7004, { lstart: UNPARSABLE, command: "x" });
		claim(l, "pp-live", { pid: 7003, start: new Date(LSTART).toISOString(), boot: f.boot.sec, until, downs: [d] });
		claim(l, "pp-nostart", { pid: 7004, start: "unknown", boot: f.boot.sec, until, downs: [d] });
		const flag = { failed: false };
		settleClaims(l, f.deps, flag);
		expect(flag.failed).toBe(true);
		expect(f.out).toEqual([`doctor: claim pp-live's owner pid 7003 could not be checked (\`ps -p 7003 -o stat=,lstart=\` answered a start time that cannot be parsed: S ${UNPARSABLE}); it stands until ${until}`]);
		expect(kinds(l).filter((k) => k.startsWith("popup"))).toEqual(["popup claimed", "popup claimed"]);
		// Past until: both expire and neither is killed (no identity to tell either is the owner).
		f.c.ms = T0 + HOUR + 1;
		f.out.length = 0;
		settleClaims(l, f.deps, { failed: false });
		expect(f.out.join("\n")).toContain(`doctor: claim pp-live's owner pid 7003 could not be checked (\`ps -p 7003 -o stat=,lstart=\` answered a start time that cannot be parsed: S ${UNPARSABLE}); it is past until ${until}`);
		const outcomes = Object.fromEntries(recordsOf(l).flatMap((r) => (r.prefix === "doctor-popup" && r.outcome.state !== "claimed" ? [[r.popupId, `${r.outcome.state} ${r.outcome.detail}`]] : [])));
		expect(outcomes["pp-live"]).toStartWith(`expired past until ${until}; pid 7003 not killed (its identity could not be read: `);
		expect(outcomes["pp-nostart"]).toBe(`expired past until ${until}; pid 7004 not killed (no start time recorded to tell it is the owner)`);
		expect(f.killed).toEqual([]);
		l.close();
	});

	test("F9: the ledger-down popup's owner whose ps start time does not parse is reported, fails the run and starts no new popup", () => {
		const f = fake();
		f.files.set(ledgerDownPath(f.home), ledgerDownRecord(f));
		f.ps.set(7003, { lstart: UNPARSABLE, command: "x" });
		const flag = { failed: false };
		ledgerDownPopup(f.deps, "SQLITE_CORRUPT", flag);
		expect(flag.failed).toBe(true);
		expect(f.out.join("\n")).toContain(`the ledger-down popup's owner pid 7003 could not be checked (\`ps -p 7003 -o stat=,lstart=\` answered a start time that cannot be parsed: S ${UNPARSABLE}); no new popup this run`);
		expect(f.alarms).toEqual([]);
	});

	/** deps:<job> with every name of the row on /opt/job but `missing`, and every absolute tool present. */
	const depsWithout = (job: string, missing: string | null): PartResult => {
		const f = fake();
		const r = row(job);
		for (const a of r.absolute) f.files.set(a, { text: "", mtimeMs: 0, exec: true });
		for (const n of r.pathNames) if (n !== missing) f.files.set(`/opt/job/${n}`, { text: "", mtimeMs: 0, exec: true });
		return checkDeps(f.deps, r, { ProgramArguments: ["/bin/bun", "x"], EnvironmentVariables: { PATH: "/opt/job" } });
	};

	test("F10: the doctor job's PATH names include quiet-alarm.zsh's mktemp and rm: one missing fails deps:doctor, naming it", () => {
		for (const missing of ["mktemp", "rm", "sysctl"]) {
			expect(depsWithout("doctor", missing)).toMatchObject({ part: "deps:doctor", verdict: "fail", evidence: `${missing} is not on the job's PATH (job PATH /opt/job)` });
		}
		expect(depsWithout("doctor", null).verdict).toBe("pass");
	});

	test("F10: the train-tick job's PATH names include the doctor step's sysctl, the popup's mktemp and rm, and the test runner's sudo: one missing fails deps:train-tick, naming it", () => {
		for (const missing of ["sysctl", "mktemp", "rm", "sudo"]) {
			expect(depsWithout("train-tick", missing)).toMatchObject({ part: "deps:train-tick", verdict: "fail", evidence: `${missing} is not on the job's PATH (job PATH /opt/job)` });
		}
		expect(depsWithout("train-tick", null).verdict).toBe("pass");
		// The popup process the tick spawns runs quiet-alarm.zsh under /bin/zsh, with its absolute tools; the test runner it runs reads the _as2test account with /usr/bin/dscl.
		expect(row("train-tick").absolute).toEqual(["/bin/zsh", "/usr/bin/osascript", "/usr/bin/afplay", "/usr/bin/say", "/usr/bin/dscl"]);
	});
});

describe("review r4 F12: every executable a job reaches by call path is in its row, and one missing fails deps:<job> naming it", () => {
	/** deps:<job> with the row's names on /opt/job and its absolute tools present, except `name` (a PATH name) or `absolute` (a path, removed from the fake machine too). */
	const depsMissing = (job: string, gone: { name?: string; absolute?: string }): PartResult => {
		const f = fake();
		const r = row(job);
		for (const a of r.absolute) f.files.set(a, { text: "", mtimeMs: 0, exec: true });
		if (gone.absolute !== undefined) f.files.delete(gone.absolute);
		for (const n of r.pathNames) if (n !== gone.name) f.files.set(`/opt/job/${n}`, { text: "", mtimeMs: 0, exec: true });
		return checkDeps(f.deps, r, { ProgramArguments: ["/bin/bun", "x"], EnvironmentVariables: { PATH: "/opt/job", AS2_BUN: "/bin/bun", PHOENIX_PYTHON: "/bin/bun" } });
	};
	const expectNamed = (job: string, names: readonly string[], absolutes: readonly string[]) => {
		for (const name of names) {
			expect(depsMissing(job, { name })).toMatchObject({ part: `deps:${job}`, verdict: "fail", evidence: `${name} is not on the job's PATH (job PATH /opt/job)` });
		}
		for (const absolute of absolutes) {
			expect(depsMissing(job, { absolute })).toMatchObject({ part: `deps:${job}`, verdict: "fail", evidence: `${absolute} is not an executable file (job PATH /opt/job)` });
		}
		expect(depsMissing(job, {}).verdict).toBe("pass");
	};

	test("train-tick: the runner's ctx-index worker's id and dscl (ctx-index.ts passwdHome) and the test runner's /usr/bin/dscl (as2test.ts realDscl)", () => {
		expectNamed("train-tick", ["id", "dscl"], ["/usr/bin/dscl"]);
	});

	test("chaos: its cp and bash, the lane runner's ctx-index id and dscl, install.sh's tools, /bin/ps and install.sh's /usr/bin/plutil", () => {
		expectNamed("chaos", ["cp", "bash", "id", "dscl", "dirname", "uname", "awk", "grep", "tr", "find", "sort", "readlink", "mkdir", "mv", "rm", "ln", "sed"], ["/bin/ps", "/usr/bin/plutil"]);
	});

	test("drive-backup: the nightly's chmod (setup 4), rmdir (claim and envelope cleanup) and quiet-alarm.zsh's rm", () => {
		expectNamed("drive-backup", ["chmod", "rmdir", "rm"], []);
	});

	test("drive-backup-check: quiet-alarm.zsh's mktemp and rm, lib.zsh's /bin/mv, and the Sunday --verify-restore run's chmod and absolute tools", () => {
		expectNamed(
			"drive-backup-check",
			["mktemp", "rm", "chmod"],
			["/bin/mv", "/bin/rm", "/bin/test", "/usr/bin/gunzip", "/usr/bin/openssl", "/usr/bin/shasum", "/usr/bin/sqlite3", "/usr/bin/stat", "/usr/bin/tar", "/usr/bin/xxd"],
		);
	});

	test("scratch-sweep: its du, and the archive step's tar and lsof (surface/src/scratch-archive.ts)", () => {
		expectNamed("scratch-sweep", ["du", "tar", "lsof"], []);
	});
});

describe("review r7: an access error is never read as a missing file", () => {
	test("F17: an installed plist that cannot be stat'd fails job:<label> with the error, never 'missing' or 'not installed'", async () => {
		const f = fake();
		const exists = f.deps.fs.exists;
		const denied = join(f.home, "Library");
		f.deps.fs.exists = (p) => {
			if (p.startsWith(denied)) throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: "EACCES" });
			return exists(p);
		};
		const rs = await checkParts(f.deps, new Set(["jobs"]));
		for (const name of ["ledger-backup", "train-tick", "chaos"]) {
			const r = only(rs, `job:${name}`)[0]!;
			expect(r.verdict).toBe("fail");
			expect(r.evidence).toContain("EACCES");
			expect(r.evidence).not.toContain("is missing");
		}
	});

	test("F17: realFs.exists is false only for a path that is not there; a path under an unsearchable directory throws", () => {
		const parent = tmp("doctor-r7-access");
		const inner = join(parent, "Library");
		mkdirSync(inner);
		writeFileSync(join(inner, "x.plist"), "");
		expect(realFs.exists(join(inner, "x.plist"))).toBe(true);
		expect(realFs.exists(join(inner, "absent.plist"))).toBe(false);
		expect(realFs.exists(join(inner, "x.plist", "under-a-file"))).toBe(false);
		if (process.getuid?.() === 0) return; // root searches a mode-000 directory, so the denial cannot be made
		chmodSync(inner, 0o000);
		try {
			expect(() => realFs.exists(join(inner, "x.plist"))).toThrow("EACCES");
		} finally {
			chmodSync(inner, 0o755);
		}
	});

	test("F18: a ProgramArguments path that cannot be checked fails deps:<job> with the error, not 'does not exist'", () => {
		const f = fake();
		const r = row("train-tick");
		for (const a of r.absolute) f.files.set(a, { text: "", mtimeMs: 0, exec: true });
		for (const n of r.pathNames) f.files.set(`/opt/job/${n}`, { text: "", mtimeMs: 0, exec: true });
		const exists = f.deps.fs.exists;
		f.deps.fs.exists = (p) => {
			if (p === "/denied/train-tick.ts") throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: "EACCES" });
			return exists(p);
		};
		const d = checkDeps(f.deps, r, { ProgramArguments: ["/bin/bun", "/denied/train-tick.ts"], EnvironmentVariables: { PATH: "/opt/job" } });
		expect(d.verdict).toBe("fail");
		expect(d.evidence).toContain("/denied/train-tick.ts (ProgramArguments[1]) could not be checked: EACCES");
		expect(d.evidence).not.toContain("does not exist");
	});
});

describe("review r8 F20: a job that logs less often than launchd starts it is judged by how often it logs", () => {
	test("chaos (started every quarter hour, logs once a night) passes with a 10 h old log and fails past 26 h (fake clock c.ms)", () => {
		const f = fake();
		const p = plistPathOf(f.home, "chaos");
		const log = join(f.home, "agent-scratch", "chaos", "launchd.log");
		f.files.set(p, { text: "", mtimeMs: T0 - 30 * 24 * HOUR, exec: false });
		f.files.set(log, { text: "", mtimeMs: T0 - 10 * HOUR, exec: false });
		f.plists.set(p, { ProgramArguments: ["/bin/bun", "/repo/surface/scripts/chaos.ts", "--nightly"], StartCalendarInterval: [{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }], StandardOutPath: log });
		f.launchctl.set("com.agent-system-2.chaos", print({ path: p, log, runs: 40, exit: 0 }));
		expect(checkJob(f.deps, row("chaos"))[0]).toMatchObject({ part: "job:chaos", verdict: "pass" });
		f.c.ms = T0 + 16 * HOUR + 1;
		const stale = checkJob(f.deps, row("chaos"))[0]!;
		expect(stale.verdict).toBe("fail");
		expect(stale.evidence).toContain("was last written 26.0 h ago (window 26.0 h");
	});
});
