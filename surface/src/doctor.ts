// `as2 doctor` (PLAN wl-mvwks11ye3x9zu): whether as2's important parts are up, one result per part with its evidence and
// the fix, and the alerts that follow (episodes and popups on the ledger's standing workload, writer DOCTOR_BY, text forms
// in surface/src/doctor-entries.ts). surface/scripts/doctor.ts is the CLI; surface/scripts/train-tick.ts runs `doctorTick`
// every pass.
//
// Probes. Every probe is an external command resolved on the PATH the run sees (launchctl, plutil, ctx, gh, df, pgrep, ps,
// sysctl, dscl), run once per run through the one injectable `run` dep with a 10 s bound; ctx runs with CI removed from its
// environment. A probe that cannot start, times out, or answers in a shape this file does not know fails its part with
// the command, its exit status and its stderr: nothing is ever skipped into a pass. One part's check that throws fails
// that part with the error; every other part still runs.
//
// Parts: `job:<name>` and `deps:<name>` per row of JOB_INVENTORY, `job-inventory`, `ctx`, `ledger`, `backup`, `seat`,
// `mailbox`, `gh`, `disk`, `mcp`. The pass rules are PLAN.md's table ("Parts, probes and pass rules").
//
// Alerts (PLAN "Alerts"). Episodes: the tick's ctx part strikes once, then goes down on the second failing pass in a row;
// the after-restart run opens a down for each failing part once per boot; any run clears a part it sees pass with `up`.
// Every write is one `ledger.write` that re-reads the standing workload's control entries first, so two runs racing on
// one part write one entry. Popups: one popup process (`--popup`, spawned detached by absolute paths) claims every
// pending down with its pid, process start time (ISO instant from ps's lstart), boot and a deadline, shows the alarm
// rule's popup (surface/src/notify.ts alarmPopup), and writes the outcome. Every run settles every claim without an
// outcome from outside: prior boot, owner gone or pid reused → `abandoned`; past `until` → `expired` (and the owner is
// killed when it is still the same process). Each failed/abandoned/expired outcome spends one of a down's
// POPUP_ATTEMPT_LIMIT attempts, counted from the ledger.
//
// Ledger unopenable: the only alert whose state is outside the ledger. Only the doctor job (`--after-restart`) shows its
// popup, with a file record (`~/.agent-system-2/doctor/ledger-down.json`, keyed by boot) giving it the same lifecycle:
// owner, deadline, outcome, at most 3 unanswered attempts per boot; an unreadable or unwritable record falls back to the
// train's banner once per run.
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { backupNamespace, canonicalPath, Ledger, processAlive } from "../../ledger/src/index";
import { BACKUP_GAP_MS, backupState, orchestratorsFromPs, type Run as PsProbeRun } from "../scripts/invariants";
import { mailboxRoot } from "./channel";
import { type DoctorRecord, formatDoctor, type OpenDown, openDowns, openStrikes, POPUP_ATTEMPT_LIMIT, type PopupOutcome, popupAttempts, popupClaims, parseDoctor } from "./doctor-entries";
import { ensureStandingWorkload } from "./identity";
import { type ControlEntry, controlEntries, DOCTOR_BY } from "./launch";
import { type AlarmOutcome, alarmPopup, DOCTOR_GIVE_UP_SECS, realNotify } from "./notify";
import { psAnswer, type PsRun, statStart } from "./omp-probe";
import { isDefaultOmpProfile, mcpLoad } from "./selfheal/detectors";
import { readMcpLoadFailures } from "./selfheal/read";
import { STANDING_WORKLOAD_ID } from "./types";

// ---- constants ----------------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
/** The bound on one probe. */
export const PROBE_TIMEOUT_MS = 10_000;
/** ctx: core_refresh older than this fails. */
export const CTX_STALE_MS = 2 * HOUR;
/** A daily StartCalendarInterval job must have logged within this. */
export const DAILY_WINDOW_MS = 26 * HOUR;
/** Slack added to twice a StartInterval (and to an hourly calendar's two hours). */
export const INTERVAL_SLACK_MS = 10 * MIN;
/** disk: less free than this under $HOME fails. */
export const DISK_MIN_KIB = 10 * 1024 * 1024;
/** mcp: the window of OMP logs read. */
export const MCP_WINDOW_MS = 2 * HOUR;
/** mailbox: a published envelope or a dead owner's claim older than this fails. */
export const MAILBOX_STALE_MS = 10 * MIN;
/** mailbox: a live owner's claim (waiting for a turn) older than this fails. */
export const MAILBOX_LIVE_STALE_MS = 30 * MIN;
/** after-restart: a boot is processed only once uptime reaches this. */
export const BOOT_SETTLE_MS = 10 * MIN;
/** A popup claim's deadline: the dialog gives up after 12 h; 10 min more for the outcome to be written. */
export const CLAIM_MS = 12 * HOUR + 10 * MIN;
/** The popup process's own bound on the dialog run, inside the claim's deadline. */
export const POPUP_RUN_MS = 12 * HOUR + 5 * MIN;
/** The ledger-down popup: its attempt's deadline and its run's kill bound. */
export const LEDGER_DOWN_ATTEMPT_MS = 70 * MIN;
/** The ledger-down popup gives up after 1 h. */
export const LEDGER_DOWN_GIVE_UP_SECS = 3600;
const LAUNCHD_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const CTX_FIX = "run `ctx daemon status` in your own Terminal (a non-CI ctx call self-heals the daemon)";

// ---- the job inventory ---------------------------------------------------------------------------

/**
 * When a job's plist must be installed: always; when $HOME is this user's own home (launchd has one gui domain per
 * user); unless the installed profile's observability.phoenix is off; or only when installed (opt-in, its install flag).
 */
export type JobExpectation = { kind: "always" } | { kind: "own-home" } | { kind: "phoenix" } | { kind: "opt-in"; flag: string };

export interface JobRow {
	/** The part name's suffix: `job:<name>`, `deps:<name>`; the label is `com.agent-system-2.<name>`. */
	name: string;
	expected: JobExpectation;
	/** Names the job's entry point runs by PATH lookup; each must resolve on the installed plist's own PATH. */
	pathNames: readonly string[];
	/** Absolute executables the entry point runs (ProgramArguments' own paths are checked from the plist). */
	absolute: readonly string[];
	/** EnvironmentVariables entries naming an executable the job runs. */
	envExecutables: readonly string[];
	/** `{repo}` is this checkout. */
	reinstall: string;
	/** Last exit codes that pass; the doctor's own 1 means "ran and found failures". */
	okExits: readonly number[];
}

export const LABEL_PREFIX = "com.agent-system-2.";

/**
 * Every install/*.plist, classified (PLAN "job inventory", amendment A3). The dependency columns were audited per entry
 * point (its ProgramArguments script, install/*.sh and *.zsh wrappers, and the surface/scripts/*.ts it runs) for every
 * external executable called by PATH name or absolute path:
 * - ledger-backup: `bun run ledger/scripts/backup.ts`; the script spawns nothing.
 * - doctor: surface/scripts/doctor.ts → this file's probes, and /bin/zsh for install/drive-backup/quiet-alarm.zsh, which
 *   runs /usr/bin/osascript, /usr/bin/afplay and /usr/bin/say.
 * - phoenix: /bin/bash install/phoenix-run.sh: `dirname` by name; /bin/date, /bin/sleep, /usr/sbin/lsof, /usr/bin/sed;
 *   PHOENIX_PYTHON.
 * - train-tick: surface/scripts/train-tick.ts: gh, git, osascript (realNotify), ctx (the doctor's ctx step); bun and omp
 *   through the lane starter it spawns, and ps (surface/src/omp-probe.ts runPs) in that starter.
 * - daily-report: surface/scripts/daily-report.ts spawns nothing.
 * - scratch-sweep: surface/scripts/scratch-sweep.ts runs `du`.
 * - chaos: surface/scripts/chaos.ts runs bun, omp, git, pgrep, ps and kill.
 * - drive-backup: /bin/zsh install/drive-backup/backup-nightly.zsh, lib.zsh, server-read.zsh and quiet-alarm.zsh: the
 *   absolute tools below, AS2_BUN, and mktemp, pgrep, ps and date by name.
 * - drive-backup-check: /bin/zsh install/drive-backup/check-backup-fresh.zsh with lib.zsh and quiet-alarm.zsh.
 */
export const JOB_INVENTORY: readonly JobRow[] = [
	{ name: "ledger-backup", expected: { kind: "always" }, pathNames: [], absolute: [], envExecutables: [], reinstall: "bash {repo}/install/install.sh", okExits: [0] },
	{
		name: "doctor", expected: { kind: "own-home" },
		pathNames: ["ctx", "gh", "osascript", "launchctl", "plutil", "df", "pgrep", "ps", "sysctl", "dscl"],
		absolute: ["/bin/zsh", "/usr/bin/osascript", "/usr/bin/afplay", "/usr/bin/say"], envExecutables: [], reinstall: "bash {repo}/install/install.sh", okExits: [0, 1],
	},
	{
		name: "phoenix", expected: { kind: "phoenix" }, pathNames: ["dirname"],
		absolute: ["/bin/date", "/bin/sleep", "/usr/sbin/lsof", "/usr/bin/sed"], envExecutables: ["PHOENIX_PYTHON"], reinstall: "bash {repo}/install/phoenix-agent.sh on", okExits: [0],
	},
	{
		name: "train-tick", expected: { kind: "opt-in", flag: "--train-tick" }, pathNames: ["gh", "bun", "omp", "git", "osascript", "ctx", "ps"],
		absolute: [], envExecutables: [], reinstall: "bash {repo}/install/install.sh --train-tick", okExits: [0],
	},
	{ name: "daily-report", expected: { kind: "opt-in", flag: "--daily-report" }, pathNames: [], absolute: [], envExecutables: [], reinstall: "bash {repo}/install/install.sh --daily-report", okExits: [0] },
	{ name: "scratch-sweep", expected: { kind: "opt-in", flag: "--scratch-sweep" }, pathNames: ["du"], absolute: [], envExecutables: [], reinstall: "bash {repo}/install/install.sh --scratch-sweep", okExits: [0] },
	{
		name: "chaos", expected: { kind: "opt-in", flag: "--chaos-nightly" }, pathNames: ["bun", "omp", "git", "pgrep", "ps", "kill"], absolute: [], envExecutables: [],
		reinstall: "bash {repo}/install/install.sh --chaos-nightly", okExits: [0],
	},
	{
		name: "drive-backup", expected: { kind: "opt-in", flag: "--drive-backup" }, pathNames: ["mktemp", "pgrep", "ps", "date"],
		absolute: [
			"/bin/zsh", "/bin/cp", "/bin/mkdir", "/bin/mv", "/bin/rm", "/bin/test", "/sbin/md5", "/usr/bin/gunzip", "/usr/bin/gzip", "/usr/bin/head", "/usr/bin/jq", "/usr/bin/openssl",
			"/usr/bin/osascript", "/usr/bin/perl", "/usr/bin/shasum", "/usr/bin/sqlite3", "/usr/bin/stat", "/usr/bin/tar", "/usr/bin/xattr", "/usr/bin/xxd", "/usr/bin/afplay", "/usr/bin/say",
		],
		envExecutables: ["AS2_BUN"], reinstall: "bash {repo}/install/install.sh --drive-backup", okExits: [0],
	},
	{
		name: "drive-backup-check", expected: { kind: "opt-in", flag: "--drive-backup" }, pathNames: ["pgrep", "sed", "tail", "grep", "tar"],
		absolute: ["/bin/zsh", "/bin/mkdir", "/usr/bin/env", "/usr/bin/jq", "/usr/bin/perl", "/usr/bin/osascript", "/usr/bin/afplay", "/usr/bin/say"],
		envExecutables: ["AS2_BUN"], reinstall: "bash {repo}/install/install.sh --drive-backup", okExits: [0],
	},
];

// ---- deps -----------------------------------------------------------------------------------------

/** One probe as run: exit code (null on a signal), both streams, and why it did not finish when it did not. */
export interface ProbeResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Not found on PATH, could not start, or timed out (killed). */
	error?: string;
}
export type Run = (argv: readonly string[], env?: Record<string, string | undefined>) => ProbeResult;

/** The filesystem reads and the one write the doctor makes, injectable so dependency checks never touch system files in tests. */
export interface DoctorFs {
	exists(path: string): boolean;
	/** A regular file this user may execute. */
	executable(path: string): boolean;
	/** The file's mtime, null when it does not exist; any other error throws. */
	mtimeMs(path: string): number | null;
	readdir(path: string): string[];
	readText(path: string): string;
	/** `name` resolved on `path` (a PATH string), or null. */
	which(name: string, path: string): string | null;
	/** Write-temp-then-rename, creating the directory. */
	writeAtomic(path: string, text: string): void;
}

export interface DoctorDeps {
	run: Run;
	fs: DoctorFs;
	/** Milliseconds since the epoch. */
	now: () => number;
	env: Record<string, string | undefined>;
	home: string;
	uid: number;
	user: string;
	/** This checkout: install/*.plist and install/drive-backup/quiet-alarm.zsh. */
	repo: string;
	ledgerPath: string;
	/** This process. */
	pid: number;
	alive: (pid: number) => boolean;
	/** SIGKILL the process (and its group, the popup process's dialog with it). */
	kill: (pid: number) => void;
	/** Start the popup process; returns a line saying what was started, throws when it could not be. */
	spawnPopup: () => string;
	/** The alarm rule's popup (blocking until answered or given up). */
	alarm: (title: string, text: string, spoken: string, giveUpSecs: number, timeoutMs: number) => AlarmOutcome;
	/** The train's non-blocking banner (the ledger-down fallback). */
	notify: (title: string, text: string) => boolean;
	/** Where lines go (stdout for the CLI, the tick's log). */
	out: (line: string) => void;
}

// ---- results --------------------------------------------------------------------------------------

export type Verdict = "pass" | "fail" | "warn" | "not installed";
export interface PartResult {
	part: string;
	verdict: Verdict;
	evidence: string;
	/** What to do; empty on a pass. */
	fix: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** `v[key]` when `v` is a plain object (parsed JSON or YAML read field by field, never trusted as a whole shape). */
const field = (v: unknown, key: string): unknown => (v !== null && typeof v === "object" && !Array.isArray(v) && key in v ? (v as Record<string, unknown>)[key] : undefined);
const clip = (s: string, n = 400): string => {
	const one = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const age = (ms: number): string => (ms < 2 * HOUR ? `${Math.round(ms / MIN)} min` : `${(ms / HOUR).toFixed(1)} h`);
const pass = (part: string, evidence: string): PartResult => ({ part, verdict: "pass", evidence, fix: "" });
const fail = (part: string, evidence: string, fix: string): PartResult => ({ part, verdict: "fail", evidence, fix });

/** A probe's failure as one line: the command, its exit status or error, and its stderr. */
export function probeFailure(argv: readonly string[], r: ProbeResult): string {
	const how = r.error ?? `exited ${r.code ?? "on a signal"}`;
	const err = r.stderr.trim();
	return clip(`\`${argv.join(" ")}\` ${how}${err ? `: ${err}` : ""}`);
}

/** Run a probe; its stdout when it exited 0, else the failure line. */
function probe(deps: DoctorDeps, argv: readonly string[], env?: Record<string, string | undefined>): { ok: true; stdout: string } | { ok: false; why: string } {
	const r = deps.run(argv, env);
	if (r.error === undefined && r.code === 0) return { ok: true, stdout: r.stdout };
	return { ok: false, why: probeFailure(argv, r) };
}

/** ps through the run dep, for omp-probe's strict readers: a probe that did not finish throws. */
function psRun(deps: DoctorDeps): PsRun {
	return (args) => {
		const r = deps.run(["ps", ...args]);
		if (r.error !== undefined) throw new Error(probeFailure(["ps", ...args], r));
		return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
	};
}

// ---- jobs -------------------------------------------------------------------------------------------

/** A job's label and installed plist path. */
export const jobLabel = (row: JobRow): string => `${LABEL_PREFIX}${row.name}`;
export const installedPlist = (home: string, row: JobRow): string => join(home, "Library", "LaunchAgents", `${jobLabel(row)}.plist`);
const reinstallOf = (row: JobRow, repo: string): string => row.reinstall.replaceAll("{repo}", repo);

/** `launchctl print`'s top-level `key = value` lines (one tab deep; nested blocks are other services' state). */
export function parseLaunchctlPrint(out: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const m = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
		if (m && !(m[1]! in fields)) fields[m[1]!] = m[2]!.trim();
	}
	return fields;
}

type Plist = Record<string, unknown>;

function readPlist(deps: DoctorDeps, path: string): { ok: true; plist: Plist } | { ok: false; why: string } {
	const argv = ["plutil", "-convert", "json", "-o", "-", path];
	const p = probe(deps, argv);
	if (!p.ok) return p;
	try {
		const v: unknown = JSON.parse(p.stdout);
		if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, why: `\`${argv.join(" ")}\` answered no JSON object` };
		return { ok: true, plist: v as Plist };
	} catch (e) {
		return { ok: false, why: `\`${argv.join(" ")}\` answered unparsable JSON: ${clip(errText(e), 120)}` };
	}
}

/** How recently a job must have logged, from its installed plist; null for a KeepAlive job (judged by state) or no schedule. */
export function recencyWindowMs(plist: Plist): number | null {
	if (plist.KeepAlive) return null;
	const interval = plist.StartInterval;
	if (typeof interval === "number" && interval > 0) return 2 * interval * 1000 + INTERVAL_SLACK_MS;
	const cal = plist.StartCalendarInterval;
	if (cal !== undefined) {
		const entries = (Array.isArray(cal) ? cal : [cal]) as Record<string, unknown>[];
		// Only minutes named: it fires every hour. Any hour named: at least daily.
		return entries.some((e) => e && typeof e === "object" && ("Hour" in e || "Weekday" in e || "Day" in e)) ? DAILY_WINDOW_MS : 2 * HOUR + INTERVAL_SLACK_MS;
	}
	return null;
}

/** The current user's home from the user database (`dscl`), never from $HOME. */
function ownHome(deps: DoctorDeps): { ok: true; home: string } | { ok: false; why: string } {
	const argv = ["dscl", ".", "-read", `/Users/${deps.user}`, "NFSHomeDirectory"];
	const p = probe(deps, argv);
	if (!p.ok) return p;
	const m = /^NFSHomeDirectory:\s*(\S.*)$/m.exec(p.stdout);
	return m ? { ok: true, home: m[1]!.trim() } : { ok: false, why: `\`${argv.join(" ")}\` answered no NFSHomeDirectory line: ${clip(p.stdout, 120)}` };
}

const profileName = (env: Record<string, string | undefined>): string => env.AGENT_SYSTEM_PROFILE?.trim() || "agent-system-2";

/** The installed profile's observability.phoenix, or why it could not be read. */
function phoenixSetting(deps: DoctorDeps): { ok: true; value: string } | { ok: false; why: string } {
	const path = join(deps.home, ".omp", "profiles", profileName(deps.env), "agent", "config.yml");
	try {
		const p = field(field(Bun.YAML.parse(deps.fs.readText(path)), "observability"), "phoenix");
		return { ok: true, value: Array.isArray(p) ? `[${p.join(", ")}]` : String(p) };
	} catch (e) {
		return { ok: false, why: `${path} could not be read: ${clip(errText(e), 160)}` };
	}
}

/** Whether a missing plist fails: `required`, or the line a not-installed job prints. */
function expectation(deps: DoctorDeps, row: JobRow): { required: true; note: string } | { required: false; line: string } {
	const e = row.expected;
	if (e.kind === "always") return { required: true, note: "" };
	if (e.kind === "opt-in") return { required: false, line: `not installed (opt-in: install.sh ${e.flag})` };
	if (e.kind === "own-home") {
		const h = ownHome(deps);
		if (!h.ok) return { required: true, note: ` (whether HOME is this user's home could not be read: ${h.why})` };
		return h.home === deps.home ? { required: true, note: "" } : { required: false, line: `not installed: HOME (${deps.home}) is not this user's home (${h.home}), and launchd has one domain per user` };
	}
	const p = phoenixSetting(deps);
	if (!p.ok) return { required: true, note: ` (observability.phoenix unknown: ${p.why})` };
	return p.value === "off" ? { required: false, line: "not installed (observability.phoenix is off; to turn it on: as2 phoenix all, then bash install/phoenix-agent.sh on)" } : { required: true, note: "" };
}

/** `job:<name>` and, when its plist is installed, `deps:<name>`. */
export function checkJob(deps: DoctorDeps, row: JobRow): PartResult[] {
	const part = `job:${row.name}`;
	const label = jobLabel(row);
	const plistPath = installedPlist(deps.home, row);
	const reinstall = reinstallOf(row, deps.repo);
	const bootstrap = `run in your own Terminal (agent shells get "Bootstrap failed: 5"): launchctl bootstrap gui/$(id -u) ${plistPath}`;
	if (!deps.fs.exists(plistPath)) {
		const x = expectation(deps, row);
		if (!x.required) return [{ part, verdict: "not installed", evidence: x.line, fix: "" }];
		return [fail(part, `${plistPath} is missing${x.note}`, `reinstall: ${reinstall}`)];
	}
	const out: PartResult[] = [];
	const read = readPlist(deps, plistPath);
	if (!read.ok) return [fail(part, `the installed plist could not be read: ${read.why}`, `reinstall: ${reinstall}`)];
	const plist = read.plist;
	out.push(checkDeps(deps, row, plist));
	const argv = ["launchctl", "print", `gui/${deps.uid}/${label}`];
	const r = deps.run(argv);
	if (r.error === undefined && /Could not find service/i.test(`${r.stdout}\n${r.stderr}`)) {
		out.unshift(fail(part, `${label} is not loaded (${plistPath} is installed)`, bootstrap));
		return out;
	}
	if (r.error !== undefined || r.code !== 0) {
		out.unshift(fail(part, probeFailure(argv, r), bootstrap));
		return out;
	}
	out.unshift(judgeLoaded(deps, row, plist, plistPath, parseLaunchctlPrint(r.stdout), bootstrap));
	return out;
}

function judgeLoaded(deps: DoctorDeps, row: JobRow, plist: Plist, plistPath: string, f: Record<string, string>, bootstrap: string): PartResult {
	const part = `job:${row.name}`;
	const label = jobLabel(row);
	if (f.path === undefined || f.state === undefined || f.runs === undefined || f["last exit code"] === undefined) {
		return fail(part, `launchctl print gui/${deps.uid}/${label} answered an unknown shape (no path, state, runs or last exit code line)`, bootstrap);
	}
	if (f.path !== plistPath) {
		return fail(part, `${label} is loaded from ${f.path}, not ${plistPath}`, `run in your own Terminal: launchctl bootout gui/$(id -u)/${label}; launchctl bootstrap gui/$(id -u) ${plistPath}`);
	}
	const log = typeof plist.StandardOutPath === "string" ? plist.StandardOutPath : f["stdout path"];
	const exitText = f["last exit code"];
	const exit = /^-?\d+$/.test(exitText) ? Number(exitText) : null;
	if (exit === null && !/never exited/.test(exitText)) return fail(part, `launchctl print gui/${deps.uid}/${label}: last exit code "${exitText}" is not a number`, bootstrap);
	if (exit !== null && !row.okExits.includes(exit)) {
		return fail(part, `${label} last exit code ${exit}`, log ? `read its log: ${log}` : `read its log (the plist names no StandardOutPath)`);
	}
	const runs = Number(f.runs);
	if (!Number.isInteger(runs)) return fail(part, `launchctl print gui/${deps.uid}/${label}: runs "${f.runs}" is not a number`, bootstrap);
	const now = deps.now();
	if (plist.KeepAlive) {
		if (f.state === "running" && f.pid !== undefined) return pass(part, `loaded from ${plistPath}, running as pid ${f.pid}, runs ${runs}`);
		return fail(part, `${label} is loaded but not running (state ${f.state}, runs ${runs}, last exit code ${exitText})`, log ? `read its log: ${log}; then ${bootstrap}` : bootstrap);
	}
	const window = recencyWindowMs(plist);
	const exitPart = exit === null ? "not exited yet" : `last exit ${exit}`;
	if (window === null) return pass(part, `loaded from ${plistPath}, runs ${runs}, ${exitPart} (no schedule to judge recency by)`);
	if (runs === 0) {
		const installed = deps.fs.mtimeMs(plistPath);
		if (installed !== null && now - installed <= window) return pass(part, `loaded, not yet run (installed ${iso(installed)})`);
		return fail(part, `${label} never ran since ${installed === null ? "its plist vanished" : iso(installed)} (runs 0, window ${age(window)})`, `run in your own Terminal: launchctl kickstart gui/$(id -u)/${label}; if it stays at runs 0, ${bootstrap}`);
	}
	if (!log) return fail(part, `${label} names no stdout path, so whether it ran recently cannot be told`, `reinstall: ${reinstallOf(row, deps.repo)}`);
	const written = deps.fs.mtimeMs(log);
	if (written === null) return fail(part, `${label} ran ${runs} time(s) but its log ${log} is missing`, `read the job's stderr path and reinstall: ${reinstallOf(row, deps.repo)}`);
	if (now - written > window) {
		return fail(part, `${label} has not run recently: its log ${log} was last written ${age(now - written)} ago (window ${age(window)}; runs ${runs}, ${exitPart})`, `read its log: ${log}; then run in your own Terminal: launchctl kickstart gui/$(id -u)/${label}`);
	}
	return pass(part, `loaded from ${plistPath}, runs ${runs}, ${exitPart}, log written ${age(now - written)} ago`);
}

/** `deps:<name>`: every executable the installed job runs resolves for that plist (PLAN R9). */
export function checkDeps(deps: DoctorDeps, row: JobRow, plist: Plist): PartResult {
	const part = `deps:${row.name}`;
	const missing: string[] = [];
	let checked = 0;
	const args = plist.ProgramArguments;
	if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) missing.push("ProgramArguments is not a list of strings");
	else {
		args.forEach((a: string, i) => {
			if (!a.startsWith("/")) return;
			checked++;
			if (i === 0 ? !deps.fs.executable(a) : !deps.fs.exists(a)) missing.push(i === 0 ? `${a} (ProgramArguments[0]) is not an executable file` : `${a} (ProgramArguments[${i}]) does not exist`);
		});
	}
	const env = plist.EnvironmentVariables;
	const vars = env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
	const path = typeof vars.PATH === "string" ? vars.PATH : LAUNCHD_DEFAULT_PATH;
	for (const a of row.absolute) {
		checked++;
		if (!deps.fs.executable(a)) missing.push(`${a} is not an executable file`);
	}
	for (const name of row.envExecutables) {
		checked++;
		const v = vars[name];
		if (typeof v !== "string" || v === "") missing.push(`EnvironmentVariables.${name} is not set`);
		else if (!deps.fs.executable(v)) missing.push(`${name}=${v} is not an executable file`);
	}
	for (const name of row.pathNames) {
		checked++;
		if (deps.fs.which(name, path) === null) missing.push(`${name} is not on the job's PATH`);
	}
	if (missing.length > 0) return fail(part, `${missing.join("; ")} (job PATH ${path})`, `reinstall (it rebuilds the PATH): ${reinstallOf(row, deps.repo)}`);
	return pass(part, `${checked} executable(s) resolve (job PATH ${path})`);
}

/** `job-inventory`: every install/*.plist is a row of JOB_INVENTORY (PLAN R4). */
export function checkInventory(deps: DoctorDeps): PartResult {
	const dir = join(deps.repo, "install");
	const names = deps.fs.readdir(dir).filter((n) => n.startsWith(LABEL_PREFIX) && n.endsWith(".plist")).sort();
	const known = new Set(JOB_INVENTORY.map(jobLabel));
	const unknown = names.map((n) => n.slice(0, -".plist".length)).filter((l) => !known.has(l));
	if (unknown.length > 0) return fail("job-inventory", `${unknown.join(", ")} in ${dir} ${unknown.length === 1 ? "is" : "are"} not in the doctor's job inventory`, "add the job to JOB_INVENTORY in surface/src/doctor.ts");
	return pass("job-inventory", `${names.length} plist(s) in ${dir}, all classified`);
}

// ---- ctx, ledger, backup, seat, mailbox, gh, disk, mcp ------------------------------------------------

/** `ctx`, judged only from `.daemon.running` and `.daemon.jobs.core_refresh.last_run_at_ms`, CI removed (PLAN R5); plus a `warn` for a supervisor that is not installed. */
export function checkCtx(deps: DoctorDeps): PartResult[] {
	const argv = ["ctx", "daemon", "status", "--format", "json"];
	const { CI: _ci, ...env } = deps.env;
	const r = deps.run(argv, env);
	if (r.error !== undefined) return [fail("ctx", probeFailure(argv, r), CTX_FIX)];
	let j: unknown;
	try {
		j = JSON.parse(r.stdout);
	} catch {
		return [fail("ctx", `${probeFailure(argv, r)}; its output is not JSON: ${clip(r.stdout, 120) || "empty"}`, CTX_FIX)];
	}
	const d = field(j, "daemon");
	if (d === undefined || d === null || typeof d !== "object") return [fail("ctx", `\`${argv.join(" ")}\` answered no .daemon object`, CTX_FIX)];
	const running = field(d, "running");
	if (running !== true) return [fail("ctx", `the ctx daemon is not running (.daemon.running = ${JSON.stringify(running ?? null)})`, CTX_FIX)];
	const last = field(field(field(d, "jobs"), "core_refresh"), "last_run_at_ms");
	if (typeof last !== "number" || !Number.isFinite(last)) return [fail("ctx", `\`${argv.join(" ")}\` has no .daemon.jobs.core_refresh.last_run_at_ms`, CTX_FIX)];
	const ago = deps.now() - last;
	const out: PartResult[] = [];
	if (ago > CTX_STALE_MS) out.push(fail("ctx", `the ctx daemon runs but core_refresh last ran ${age(ago)} ago (${iso(last)}; over ${age(CTX_STALE_MS)})`, CTX_FIX));
	else out.push(pass("ctx", `daemon running, core_refresh ${age(Math.max(0, ago))} ago`));
	const sup = field(field(d, "supervisor"), "status");
	if (sup !== "installed") out.push({ part: "ctx", verdict: "warn", evidence: `ctx supervisor status is ${JSON.stringify(sup ?? null)}: the daemon is not restarted by launchd after a crash or a reboot`, fix: CTX_FIX });
	return out;
}

/** The scheduled-copy directory Ledger.open's backup policy writes: backups/<namespace> beside the canonical ledger path. */
export function backupDir(ledgerPath: string): string {
	const canonical = canonicalPath(ledgerPath);
	return join(dirname(canonical), "backups", backupNamespace(canonical));
}

/** `ledger` (open read-only and one read) and `backup` (invariants' backupState; PLAN R6). */
export function checkLedger(deps: DoctorDeps): PartResult[] {
	const kick = "run in your own Terminal: launchctl kickstart gui/$(id -u)/com.agent-system-2.ledger-backup";
	let ledger: Ledger;
	try {
		ledger = Ledger.open(deps.ledgerPath, { readonly: true });
	} catch (e) {
		return [
			fail("ledger", `${deps.ledgerPath} could not be opened: ${clip(errText(e))}`, `fix the ledger at ${deps.ledgerPath} (the error above)`),
			fail("backup", "the ledger could not be opened, so its backups could not be judged", `fix the ledger at ${deps.ledgerPath} first`),
		];
	}
	try {
		const out: PartResult[] = [];
		try {
			const standing = ledger.workload(STANDING_WORKLOAD_ID);
			out.push(pass("ledger", `${deps.ledgerPath} opened read-only and read (standing workload ${standing ? "present" : "not yet opened"})`));
		} catch (e) {
			out.push(fail("ledger", `${deps.ledgerPath} opened but a read failed: ${clip(errText(e))}`, `fix the ledger at ${deps.ledgerPath} (the error above)`));
			out.push(fail("backup", "the ledger could not be read, so its backups could not be judged", `fix the ledger at ${deps.ledgerPath} first`));
			return out;
		}
		let dir = "";
		try {
			dir = backupDir(deps.ledgerPath);
			const b = backupState(ledger.db, dir, BACKUP_GAP_MS, iso(deps.now()));
			if (b.state === "ok") out.push(pass("backup", b.copy ? `newest complete copy ${b.copy.name}; ledger writes ${age(b.behindMs)} past it (gap ${age(BACKUP_GAP_MS)})` : `no copy yet, and every write is within ${age(BACKUP_GAP_MS)} of the first`));
			else if (b.state === "stale") out.push(fail("backup", b.finding.text, kick));
			else out.push(fail("backup", `unjudged: ${b.why}`, `fix access to ${dir}, then ${kick}`));
		} catch (e) {
			out.push(fail("backup", `the backup state could not be read${dir ? ` (${dir})` : ""}: ${clip(errText(e))}`, kick));
		}
		return out;
	} finally {
		ledger.close();
	}
}

/** `seat`: Ilex's orchestrator process (`omp --cwd <repo> … --append-system-prompt …/orchestrator/system.md`; PLAN R7). */
export function checkSeat(deps: DoctorDeps): PartResult {
	const run: PsProbeRun = (argv) => {
		const r = deps.run(argv);
		if (r.error !== undefined) throw new Error(probeFailure(argv, r));
		return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
	};
	const path = deps.env.PATH ?? "";
	const probed = orchestratorsFromPs(deps.repo, { run, alive: deps.alive, available: (cmd) => deps.fs.which(cmd, path) !== null });
	if ("skipped" in probed) return fail("seat", `the process probe failed: ${clip(probed.skipped)}`, "fix the probe (the error above), then run as2 doctor again");
	const seat = probed.found.filter((p) => /--append-system-prompt\s+\S*\/orchestrator\/system\.md(\s|$)/.test(p.command));
	if (seat.length === 0) return fail("seat", `no orchestrator process (omp --cwd ${deps.repo} … --append-system-prompt …/orchestrator/system.md)`, "run `as2` in your own Terminal");
	return pass("seat", seat.map((p) => `pid ${p.pid}${p.started ? ` since ${p.started.toISOString()}` : ""}`).join(", "));
}

const CLAIMED_NAME = /^(.+\.json)\.claimed-ilex-([0-9]+)$/;
const PUBLISHED_NAME = /^[0-9]+-[0-9a-f-]+\.json$/i;

/** `mailbox`: Ilex's inbox drains (published envelopes, dead and live owners' claims; PLAN R7). */
export function checkMailbox(deps: DoctorDeps): PartResult {
	const inbox = join(mailboxRoot(deps.env), "inbox", "ilex");
	let names: string[];
	try {
		names = deps.fs.readdir(inbox);
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") return pass("mailbox", `no inbox yet at ${inbox}`);
		return fail("mailbox", `${inbox} could not be listed: ${clip(errText(e))}`, `fix access to ${inbox}`);
	}
	const now = deps.now();
	const stuck: string[] = [];
	let waiting = 0;
	for (const name of names.sort()) {
		const claim = CLAIMED_NAME.exec(name);
		if (!claim && !PUBLISHED_NAME.test(name)) continue;
		const mtime = deps.fs.mtimeMs(join(inbox, name));
		if (mtime === null) continue; // drained between the listing and the stat
		const old = now - mtime;
		if (!claim) {
			waiting++;
			if (old > MAILBOX_STALE_MS) stuck.push(`${name} published ${age(old)} ago and not claimed`);
		} else if (deps.alive(Number(claim[2]))) {
			waiting++;
			if (old > MAILBOX_LIVE_STALE_MS) stuck.push(`${name} held ${age(old)} by live pid ${claim[2]} (waiting for a turn)`);
		} else if (old > MAILBOX_STALE_MS) stuck.push(`${name} ${age(old)} old, its owner pid ${claim[2]} gone`);
	}
	if (stuck.length > 0) return fail("mailbox", `${inbox}: ${stuck.join("; ")}`, "restart the seat (`as2` in your own Terminal), or take a turn in the Ilex session");
	return pass("mailbox", `${inbox}: ${waiting} message(s) in flight, none stuck`);
}

/** `gh`: github.com has thewolff logged in (state success), active or not (PLAN R8). */
export function checkGh(deps: DoctorDeps): PartResult {
	const argv = ["gh", "auth", "status", "--json", "hosts"];
	const r = deps.run(argv);
	const fix = "run in your own Terminal: gh auth login -h github.com (as thewolff)";
	if (r.error !== undefined) return fail("gh", probeFailure(argv, r), fix);
	let accounts: unknown;
	try {
		accounts = field(field(JSON.parse(r.stdout), "hosts"), "github.com");
	} catch {
		return fail("gh", `${probeFailure(argv, r)}; its output is not JSON: ${clip(r.stdout, 120) || "empty"}`, fix);
	}
	if (accounts === undefined) return fail("gh", "no github.com account is logged in", fix);
	if (!Array.isArray(accounts)) return fail("gh", `\`${argv.join(" ")}\` answered an unknown shape: hosts["github.com"] is not a list`, fix);
	const list: unknown[] = accounts;
	const active = field(list.find((a) => field(a, "active") === true), "login");
	const activeText = `active account: ${typeof active === "string" ? active : "none"}`;
	const me = list.find((a) => field(a, "login") === "thewolff");
	const state = field(me, "state");
	if (state === "success") return pass("gh", `thewolff logged in on github.com (${activeText})`);
	return fail("gh", me ? `thewolff on github.com is in state ${JSON.stringify(state ?? null)} (${activeText})` : `thewolff is not logged in on github.com (${activeText})`, fix);
}

/** `disk`: at least 10 GiB free under $HOME (PLAN R10). */
export function checkDisk(deps: DoctorDeps): PartResult {
	const argv = ["df", "-Pk", deps.home];
	const p = probe(deps, argv);
	const fix = "free space on the disk that holds your home directory";
	if (!p.ok) return fail("disk", p.why, fix);
	const cols = p.stdout.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
	const kib = Number(cols[3]);
	if (cols.length < 6 || !Number.isFinite(kib)) return fail("disk", `\`${argv.join(" ")}\` answered an unknown shape: ${clip(p.stdout, 160)}`, fix);
	const gib = (kib / 1024 / 1024).toFixed(1);
	const mount = cols.slice(5).join(" ");
	if (kib < DISK_MIN_KIB) return fail("disk", `${gib} GiB free on ${mount} (under 10 GiB)`, `${fix}: ${gib} GiB free on ${mount}, 10 GiB needed`);
	return pass("disk", `${gib} GiB free on ${mount}`);
}

/** The as2 profile's OMP logs directory. */
export function ompLogsDir(home: string, profile: string): string {
	return join(home, ".omp", ...(isDefaultOmpProfile(profile) ? [] : ["profiles", profile.trim()]), "logs");
}

/** `mcp`: the self-heal mcp-load detector over the last 2 h of the profile's OMP logs; an unreadable log fails (PLAN R11). */
export async function checkMcp(deps: DoctorDeps): Promise<PartResult> {
	const profile = profileName(deps.env);
	const dir = ompLogsDir(deps.home, profile);
	const to = deps.now();
	const from = to - MCP_WINDOW_MS;
	const read = await readMcpLoadFailures(dir, from, to);
	const findings = mcpLoad({ profile, ...read }, { from: iso(from), to: iso(to) });
	if (findings.length > 0) return fail("mcp", findings.map((f) => `${f.summary} (${f.evidence})`).join("; "), `see the log lines named; the logs are in ${dir}`);
	return pass("mcp", `no MCP load failure in the last ${age(MCP_WINDOW_MS)} in ${dir}`);
}

// ---- running the parts -------------------------------------------------------------------------------

export const GROUPS = ["jobs", "ctx", "ledger", "seat", "mailbox", "gh", "disk", "mcp"] as const;
export type Group = (typeof GROUPS)[number];

/** The check a part's result comes from. */
export function groupOf(part: string): Group {
	if (part === "job-inventory" || part.startsWith("job:") || part.startsWith("deps:")) return "jobs";
	if (part === "backup") return "ledger";
	if ((GROUPS as readonly string[]).includes(part)) return part as Group;
	throw new Error(`unknown doctor part ${part}`);
}

/** One part's check, guarded: a throw fails that part with the error, and nothing else. */
function guarded(part: string, f: () => PartResult | PartResult[]): PartResult[] {
	try {
		const r = f();
		return Array.isArray(r) ? r : [r];
	} catch (e) {
		return [fail(part, `the check itself failed: ${clip(errText(e))}`, "fix the error above, then run as2 doctor again")];
	}
}

/** Every part of the named groups, in a fixed order. */
export async function checkParts(deps: DoctorDeps, groups: ReadonlySet<Group> = new Set(GROUPS)): Promise<PartResult[]> {
	const out: PartResult[] = [];
	if (groups.has("jobs")) {
		out.push(...guarded("job-inventory", () => checkInventory(deps)));
		for (const row of JOB_INVENTORY) out.push(...guarded(`job:${row.name}`, () => checkJob(deps, row)));
	}
	if (groups.has("ctx")) out.push(...guarded("ctx", () => checkCtx(deps)));
	if (groups.has("ledger")) out.push(...guarded("ledger", () => checkLedger(deps)));
	if (groups.has("seat")) out.push(...guarded("seat", () => checkSeat(deps)));
	if (groups.has("mailbox")) out.push(...guarded("mailbox", () => checkMailbox(deps)));
	if (groups.has("gh")) out.push(...guarded("gh", () => checkGh(deps)));
	if (groups.has("disk")) out.push(...guarded("disk", () => checkDisk(deps)));
	if (groups.has("mcp")) {
		try {
			out.push(await checkMcp(deps));
		} catch (e) {
			out.push(fail("mcp", `the check itself failed: ${clip(errText(e))}`, "fix the error above, then run as2 doctor again"));
		}
	}
	return out;
}

/** The judged parts (pass or fail): `warn` and `not installed` lines open and clear nothing. */
const judged = (results: readonly PartResult[]): PartResult[] => results.filter((r) => r.verdict === "pass" || r.verdict === "fail");

// ---- episodes ----------------------------------------------------------------------------------------

/** The standing workload's valid control entries (the reader surface/src/errors.ts uses), oldest first. */
export function doctorControl(ledger: Ledger): ControlEntry[] {
	return controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"));
}

function record(ledger: Ledger, r: DoctorRecord): string {
	const body = formatDoctor(r);
	ledger.recordEntry({ by: DOCTOR_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
	return body;
}

/**
 * How a run treats a judged part: `tick` (strike, then down on the second failure in a row; up on a pass), `boot`
 * (down for a failure with no open episode; up on a pass), `clear` (up on a pass only).
 */
export type EpisodeMode = "tick" | "boot" | "clear";

/** What one judged part writes given the open episode and strike: the record, or null. */
export function transition(mode: EpisodeMode, r: PartResult, down: OpenDown | undefined, strike: boolean): DoctorRecord | null {
	if (r.verdict === "pass") return down || strike ? { prefix: "doctor-up", part: r.part, evidence: r.evidence } : null;
	if (r.verdict !== "fail" || down) return null;
	if (mode === "clear") return null;
	if (mode === "tick" && !strike) return { prefix: "doctor-strike", part: r.part, evidence: r.evidence };
	return { prefix: "doctor-down", part: r.part, evidence: r.evidence, fix: r.fix };
}

/** Write each judged part's transition, one ledger write per part with a re-read; the bodies written. */
export function applyEpisodes(ledger: Ledger, results: readonly PartResult[], mode: EpisodeMode): string[] {
	const written: string[] = [];
	for (const r of judged(results)) {
		const body = ledger.write(() => {
			ensureStandingWorkload(ledger);
			const control = doctorControl(ledger);
			const down = openDowns(control).find((d) => d.part === r.part);
			const strike = openStrikes(control).some((s) => s.part === r.part);
			const next = transition(mode, r, down, strike);
			return next ? record(ledger, next) : null;
		});
		if (body) written.push(body);
	}
	return written;
}

/** Parts with an open down or strike: what the after-restart run re-checks. */
export function openParts(control: readonly ControlEntry[]): string[] {
	return [...new Set([...openDowns(control).map((d) => d.part), ...openStrikes(control).map((s) => s.part)])];
}

// ---- boot ---------------------------------------------------------------------------------------------

/** `sysctl -n kern.boottime`'s `sec`: the boot time in seconds. Throws naming the probe. */
export function currentBoot(deps: DoctorDeps): number {
	const argv = ["sysctl", "-n", "kern.boottime"];
	const p = probe(deps, argv);
	if (!p.ok) throw new Error(p.why);
	const m = /\bsec\s*=\s*(\d+)/.exec(p.stdout);
	if (!m) throw new Error(`\`${argv.join(" ")}\` answered an unknown shape: ${clip(p.stdout, 120)}`);
	return Number(m[1]);
}

const bootDone = (control: readonly ControlEntry[], boot: number): boolean =>
	control.some((c) => {
		const r = parseDoctor(c);
		return r?.prefix === "doctor-boot" && r.boot === boot;
	});

// ---- process identity ------------------------------------------------------------------------------------

/** A ps lstart as the one token a claim carries: its ISO instant, or `unknown`. */
export function startToken(lstart: string): string {
	const t = Date.parse(lstart.replace(/\s+/g, " "));
	return Number.isFinite(t) ? new Date(t).toISOString() : "unknown";
}

/** This process's start token (`unknown` when ps cannot tell, with the reason logged). */
function ownStart(deps: DoctorDeps): string {
	try {
		const out = psAnswer(psRun(deps), deps.pid, "stat=,lstart=");
		if (out === null) throw new Error(`ps -p ${deps.pid} says this process does not exist`);
		return startToken(statStart(out).start);
	} catch (e) {
		deps.out(`doctor: this process's start time could not be read (${clip(errText(e))}); the claim records start unknown, so a reused pid cannot be told from it`);
		return "unknown";
	}
}

/** A recorded owner now: the same process, gone, another process on the pid, alive with no start to compare, or ps failed. */
export type OwnerState = { state: "same" | "gone" | "other" | "unknown" } | { state: "failed"; why: string };

export function ownerState(deps: DoctorDeps, pid: number, start: string): OwnerState {
	try {
		const out = psAnswer(psRun(deps), pid, "stat=,lstart=");
		if (out === null) return { state: "gone" };
		const now = statStart(out);
		if (now.zombie) return { state: "gone" };
		if (start === "unknown") return { state: "unknown" };
		return { state: startToken(now.start) === start ? "same" : "other" };
	} catch (e) {
		return { state: "failed", why: clip(errText(e)) };
	}
}

// ---- popups -----------------------------------------------------------------------------------------------

/** Downs a new popup would cover: open, never answered, no claim in force naming them, fewer than the limit spent. */
export function pendingDowns(control: readonly ControlEntry[]): OpenDown[] {
	const claims = popupClaims(control);
	return openDowns(control).filter((d) => {
		const a = popupAttempts(control, d.entryId);
		if (a.answered || a.spent >= POPUP_ATTEMPT_LIMIT) return false;
		return !claims.some((c) => c.outcome === null && c.claim.downs.includes(d.entryId));
	});
}

/**
 * Settle every claim without an outcome, from outside (PLAN "Alerts"): a prior boot, a gone owner or a reused pid →
 * `abandoned <why>`; past `until` → `expired`, and the owner killed when it is still the same process. Identity is read
 * outside the write; the write re-reads and settles only claims still without an outcome. Returns the lines to log.
 */
export function settleClaims(ledger: Ledger, deps: DoctorDeps): string[] {
	const lines: string[] = [];
	const open = popupClaims(doctorControl(ledger)).filter((c) => c.outcome === null);
	if (open.length === 0) return lines;
	let boot: number | null = null;
	try {
		boot = currentBoot(deps);
	} catch (e) {
		lines.push(`doctor: the boot time could not be read (${clip(errText(e))}), so no claim is judged by boot this run`);
	}
	const now = deps.now();
	const verdicts: { popupId: string; outcome: Exclude<PopupOutcome, { state: "claimed" }>; kill: number | null }[] = [];
	for (const c of open) {
		const { pid, start, until } = c.claim;
		if (boot !== null && c.claim.boot !== boot) {
			verdicts.push({ popupId: c.popupId, outcome: { state: "abandoned", detail: `prior boot ${c.claim.boot} (now ${boot})` }, kill: null });
			continue;
		}
		const owner = ownerState(deps, pid, start);
		if (owner.state === "gone") verdicts.push({ popupId: c.popupId, outcome: { state: "abandoned", detail: `owner pid ${pid} gone` }, kill: null });
		else if (owner.state === "other") verdicts.push({ popupId: c.popupId, outcome: { state: "abandoned", detail: `pid ${pid} reused by another process` }, kill: null });
		else if (now > Date.parse(until)) {
			const note = owner.state === "failed" ? `past until ${until}; pid ${pid} not killed (its identity could not be read: ${owner.why})` : owner.state === "same" ? `past until ${until}; owner pid ${pid} killed` : `past until ${until}; pid ${pid} not killed (no start time recorded to tell it is the owner)`;
			verdicts.push({ popupId: c.popupId, outcome: { state: "expired", detail: note }, kill: owner.state === "same" ? pid : null });
		} else if (owner.state === "failed") lines.push(`doctor: claim ${c.popupId}'s owner pid ${pid} could not be checked (${owner.why}); it stands until ${until}`);
	}
	if (verdicts.length === 0) return lines;
	const settled = ledger.write(() => {
		const still = new Set(popupClaims(doctorControl(ledger)).filter((c) => c.outcome === null).map((c) => c.popupId));
		return verdicts.filter((v) => still.has(v.popupId)).map((v) => ({ v, body: record(ledger, { prefix: "doctor-popup", popupId: v.popupId, outcome: v.outcome }) }));
	});
	for (const { v, body } of settled) {
		lines.push(`wrote ${body}`);
		if (v.kill === null) continue;
		try {
			deps.kill(v.kill);
		} catch (e) {
			lines.push(`doctor: expired claim ${v.popupId}'s owner pid ${v.kill} could not be killed: ${clip(errText(e))}`);
		}
	}
	return lines;
}

/** After a run's writes: settle claims, then spawn the popup process when any down is pending. Lines to log. */
export function settleAndSpawn(ledger: Ledger, deps: DoctorDeps): string[] {
	const lines = settleClaims(ledger, deps);
	const pending = pendingDowns(doctorControl(ledger));
	if (pending.length === 0) return lines;
	try {
		lines.push(`${pending.length} down(s) pending a popup (${pending.map((d) => d.part).join(", ")}): ${deps.spawnPopup()}`);
	} catch (e) {
		lines.push(`doctor: the popup process could not be spawned (${clip(errText(e))}); nothing was claimed, so the next run spawns it again`);
	}
	return lines;
}

/** The popup's title, text (every part and its fix) and spoken text. */
export function popupWords(downs: readonly OpenDown[]): { title: string; text: string; spoken: string } {
	const parts = downs.map((d) => d.part);
	return {
		title: `as2 doctor: ${downs.length === 1 ? `${parts[0]} is down` : `${downs.length} parts are down`}`,
		text: downs.map((d) => `${d.part}: ${d.evidence}\nFix: ${d.fix}`).join("\n\n"),
		spoken: `as2 doctor. ${downs.map((d) => `${d.part} is down: ${d.evidence}`).join(". ")}`,
	};
}

/**
 * The popup process (`--popup`): settle claims, claim every pending down in one write with a re-read, show the popup,
 * write its outcome. Exit 0 nothing pending or answered, 1 the popup failed or its outcome could not be written.
 */
export function popupRun(ledger: Ledger, deps: DoctorDeps): number {
	for (const l of settleClaims(ledger, deps)) deps.out(l);
	const boot = currentBoot(deps);
	const start = ownStart(deps);
	const now = deps.now();
	// Unique per claim, even for two claims in one millisecond by one pid (a test, or a pid reused at once).
	const popupId = `pp-${now.toString(36)}-${deps.pid}-${randomBytes(3).toString("hex")}`;
	const claim = ledger.write(() => {
		ensureStandingWorkload(ledger);
		const downs = pendingDowns(doctorControl(ledger));
		if (downs.length === 0) return null;
		const body = record(ledger, { prefix: "doctor-popup", popupId, outcome: { state: "claimed", pid: deps.pid, start, boot, until: iso(now + CLAIM_MS), downs: downs.map((d) => d.entryId), after: null } });
		return { downs, body };
	});
	if (!claim) {
		deps.out("doctor popup: nothing pending");
		return 0;
	}
	deps.out(`wrote ${claim.body}`);
	const w = popupWords(claim.downs);
	const outcome = deps.alarm(w.title, w.text, w.spoken, DOCTOR_GIVE_UP_SECS, POPUP_RUN_MS);
	const written = ledger.write((): { kind: "already"; outcome: Exclude<PopupOutcome, { state: "claimed" }> } | { kind: "wrote"; body: string } => {
		const mine = popupClaims(doctorControl(ledger)).find((c) => c.popupId === popupId);
		if (mine?.outcome) return { kind: "already", outcome: mine.outcome };
		return { kind: "wrote", body: record(ledger, { prefix: "doctor-popup", popupId, outcome }) };
	});
	if (written.kind === "already") deps.out(`doctor popup ${popupId}: ${outcome.state} ${outcome.detail}, but another run settled the claim first (${written.outcome.state} ${written.outcome.detail}); nothing written`);
	else deps.out(`wrote ${written.body}`);
	if (outcome.state === "answered" && outcome.detail.startsWith("audio-failed")) deps.out(`doctor popup ${popupId}: shown, but the read-aloud failed: ${outcome.detail}`);
	return outcome.state === "answered" ? 0 : 1;
}

// ---- the ledger-down popup (file record; the doctor job only) -------------------------------------------------

export interface LedgerDownAttempt {
	pid: number;
	start: string;
	began: string;
	until: string;
	outcome?: string;
	error?: string;
}
export interface LedgerDownRecord {
	boot: number;
	attempts: LedgerDownAttempt[];
}

export const ledgerDownPath = (home: string): string => join(home, ".agent-system-2", "doctor", "ledger-down.json");

function parseRecord(text: string): LedgerDownRecord {
	const v = JSON.parse(text) as LedgerDownRecord;
	if (!v || typeof v.boot !== "number" || !Array.isArray(v.attempts) || !v.attempts.every((a) => a && typeof a.pid === "number" && typeof a.start === "string" && typeof a.until === "string")) {
		throw new Error("not a ledger-down record ({boot, attempts: [{pid, start, began, until, outcome?, error?}]})");
	}
	return v;
}

const unanswered = (r: LedgerDownRecord): LedgerDownAttempt[] => r.attempts.filter((a) => a.outcome !== undefined && !a.outcome.startsWith("answered"));

/** The record's state for a terminal run's line, or null when there is nothing to say. */
export function ledgerDownState(deps: DoctorDeps): string | null {
	const path = ledgerDownPath(deps.home);
	let text: string;
	try {
		text = deps.fs.readText(path);
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") return `ledger-down popup: no record at ${path} (the doctor job shows it on its next run)`;
		return `ledger-down popup: its record ${path} could not be read: ${clip(errText(e))}`;
	}
	try {
		const r = parseRecord(text);
		const bad = unanswered(r);
		if (bad.length >= POPUP_ATTEMPT_LIMIT) return `ledger-down popup failed ${POPUP_ATTEMPT_LIMIT} times this boot: ${bad.at(-1)!.outcome}`;
		const last = r.attempts.at(-1);
		return `ledger-down popup: ${r.attempts.length} attempt(s) for boot ${r.boot}${last ? `, last ${last.outcome ?? `in progress (pid ${last.pid}, until ${last.until})`}` : ""} (${path})`;
	} catch (e) {
		return `ledger-down popup: its record ${path} is unreadable: ${clip(errText(e))}`;
	}
}

/**
 * The doctor job's ledger-down popup (PLAN "Ledger unopenable"): settle the last attempt, then, unless this boot has an
 * answered attempt or POPUP_ATTEMPT_LIMIT unanswered ones, append an attempt and show the popup in the foreground under
 * its own kill bound. A record that cannot be read or written is logged and the banner fires once instead.
 */
export function ledgerDownPopup(deps: DoctorDeps, ledgerError: string): void {
	const path = ledgerDownPath(deps.home);
	const banner = (why: string) => {
		deps.out(`doctor: ledger-down record ${path}: ${why}; the banner fires instead`);
		const ok = deps.notify("as2 doctor: the ledger cannot be opened", clip(ledgerError, 200));
		if (!ok) deps.out("doctor: the ledger-down banner could not be shown either (osascript failed)");
	};
	let boot: number;
	try {
		boot = currentBoot(deps);
	} catch (e) {
		banner(`the boot time could not be read (${clip(errText(e))})`);
		return;
	}
	let rec: LedgerDownRecord;
	try {
		rec = parseRecord(deps.fs.readText(path));
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") rec = { boot, attempts: [] };
		else {
			banner(`unreadable (${clip(errText(e))})`);
			return;
		}
	}
	const save = (): boolean => {
		try {
			deps.fs.writeAtomic(path, `${JSON.stringify(rec, null, 2)}\n`);
			return true;
		} catch (e) {
			banner(`could not be written (${clip(errText(e))})`);
			return false;
		}
	};
	const now = deps.now();
	const last = rec.attempts.at(-1);
	if (last && last.outcome === undefined) {
		if (rec.boot !== boot) last.outcome = `abandoned prior boot ${rec.boot}`;
		else {
			const owner = ownerState(deps, last.pid, last.start);
			if (owner.state === "gone") last.outcome = `abandoned owner pid ${last.pid} gone`;
			else if (owner.state === "other") last.outcome = `abandoned pid ${last.pid} reused`;
			else if (now > Date.parse(last.until)) {
				last.outcome = `expired past until ${last.until}`;
				if (owner.state === "same") {
					try {
						deps.kill(last.pid);
					} catch (e) {
						last.error = `kill ${last.pid}: ${clip(errText(e))}`;
					}
				}
			} else {
				deps.out(`doctor: the ledger-down popup is showing (pid ${last.pid}, until ${last.until}); nothing more this run`);
				return;
			}
		}
		if (!save()) return;
	}
	if (rec.boot !== boot) rec = { boot, attempts: [] };
	if (rec.attempts.some((a) => a.outcome?.startsWith("answered"))) {
		deps.out(`doctor: the ledger-down popup was shown this boot; ledger still down: ${clip(ledgerError, 200)}`);
		return;
	}
	const bad = unanswered(rec);
	if (bad.length >= POPUP_ATTEMPT_LIMIT) {
		deps.out(`ledger-down popup failed ${POPUP_ATTEMPT_LIMIT} times this boot: ${bad.at(-1)!.outcome}`);
		return;
	}
	const attempt: LedgerDownAttempt = { pid: deps.pid, start: ownStart(deps), began: iso(now), until: iso(now + LEDGER_DOWN_ATTEMPT_MS) };
	rec.attempts.push(attempt);
	if (!save()) return;
	const outcome = deps.alarm("as2 doctor: the ledger cannot be opened", `${clip(ledgerError, 600)}\n\nFix: fix the ledger at ${deps.ledgerPath}; the next doctor run checks again.`, "as2 doctor. The ledger cannot be opened.", LEDGER_DOWN_GIVE_UP_SECS, LEDGER_DOWN_ATTEMPT_MS);
	attempt.outcome = `${outcome.state} ${outcome.detail}`;
	if (save()) deps.out(`doctor: ledger-down popup ${attempt.outcome}`);
}

// ---- modes ---------------------------------------------------------------------------------------------------

export function partLine(r: PartResult): string {
	const tag = r.verdict === "not installed" ? "-" : r.verdict;
	return `${tag.padEnd(4)} ${r.part}: ${r.evidence}${r.fix ? `\n     fix: ${r.fix}` : ""}`;
}

export interface RunOutcome {
	exit: 0 | 1;
	results: PartResult[];
	/** Entries written and alert lines. */
	notes: string[];
}

const exitOf = (results: readonly PartResult[], notes: { failed: boolean }): 0 | 1 => (notes.failed || results.some((r) => r.verdict === "fail") ? 1 : 0);

/** Open the ledger for writing; null and a note when it cannot be. */
function openRw(deps: DoctorDeps, notes: string[]): Ledger | null {
	try {
		return Ledger.open(deps.ledgerPath, { backupOnOpen: false, clock: () => iso(deps.now()) });
	} catch (e) {
		notes.push(`doctor: the ledger ${deps.ledgerPath} could not be opened for writing (${clip(errText(e))}); no alert written this run`);
		return null;
	}
}

/** Run `f` against the ledger; an error is a note and marks the run failed, never hides the parts' results. */
function withLedger(ledger: Ledger, notes: string[], flag: { failed: boolean }, what: string, f: () => string[]): void {
	try {
		notes.push(...f());
	} catch (e) {
		flag.failed = true;
		notes.push(`doctor: ${what} failed: ${clip(errText(e))}`);
	}
}

/** Default mode (`as2 doctor`, install's last step): every part; clears for parts that pass; pending popups. */
export async function runDefault(deps: DoctorDeps): Promise<RunOutcome> {
	const results = await checkParts(deps);
	const notes: string[] = [];
	const flag = { failed: false };
	const ledger = results.some((r) => r.part === "ledger" && r.verdict === "pass") ? openRw(deps, notes) : null;
	if (ledger) {
		try {
			withLedger(ledger, notes, flag, "clearing passed parts", () => applyEpisodes(ledger, results, "clear").map((b) => `wrote ${b}`));
			withLedger(ledger, notes, flag, "settling popups", () => settleAndSpawn(ledger, deps));
		} finally {
			ledger.close();
		}
	} else {
		const s = ledgerDownState(deps);
		if (s) notes.push(s);
	}
	return { exit: exitOf(results, flag), results, notes };
}

/**
 * `--after-restart` (the doctor job, every 600 s): re-check parts with an open episode and clear those that pass; once
 * per boot, after BOOT_SETTLE_MS of uptime, check every part, open a down for each failure, then write `doctor-boot:`;
 * settle and show pending popups. With the ledger unopenable, the ledger-down popup.
 */
export async function runAfterRestart(deps: DoctorDeps): Promise<RunOutcome> {
	const notes: string[] = [];
	const flag = { failed: false };
	let boot: number | null = null;
	try {
		boot = currentBoot(deps);
	} catch (e) {
		flag.failed = true;
		notes.push(`doctor: the boot time could not be read (${clip(errText(e))}); the boot run waits for a run that can read it`);
	}
	const ledger = openRw(deps, notes);
	if (!ledger) {
		const results = await checkParts(deps);
		const ledgerError = results.find((r) => r.part === "ledger" && r.verdict === "fail")?.evidence ?? notes.at(-1) ?? "the ledger could not be opened";
		ledgerDownPopup({ ...deps, out: (l) => notes.push(l) }, ledgerError);
		return { exit: 1, results, notes };
	}
	try {
		const control = doctorControl(ledger);
		const open = openParts(control);
		let bootDue = boot !== null && !bootDone(control, boot);
		if (bootDue && boot !== null) {
			const uptime = deps.now() - boot * 1000;
			if (uptime < BOOT_SETTLE_MS) {
				notes.push(`boot ${boot}: uptime ${age(uptime)}, under ${age(BOOT_SETTLE_MS)}; the boot run waits for the next run`);
				bootDue = false;
			}
		}
		const groups = new Set<Group>(bootDue ? GROUPS : open.map(groupOf));
		const results = groups.size > 0 ? await checkParts(deps, groups) : [];
		const relevant = bootDue ? results : results.filter((r) => open.includes(r.part));
		withLedger(ledger, notes, flag, "writing episodes", () => applyEpisodes(ledger, relevant, bootDue ? "boot" : "clear").map((b) => `wrote ${b}`));
		if (bootDue && boot !== null && !flag.failed) {
			const b = boot;
			withLedger(ledger, notes, flag, "writing the boot entry", () => {
				const body = ledger.write(() => (bootDone(doctorControl(ledger), b) ? null : record(ledger, { prefix: "doctor-boot", boot: b })));
				return body ? [`wrote ${body}`] : [];
			});
		}
		withLedger(ledger, notes, flag, "settling popups", () => settleAndSpawn(ledger, deps));
		return { exit: exitOf(relevant, flag), results: relevant, notes };
	} finally {
		ledger.close();
	}
}

/**
 * The tick's ctx step (train-tick.ts main, every pass; `--tick`): the ctx part only, its episode transition, then claims
 * and popups. `ledger` null (the tick could not open it): the probe and its line only. The ctx line is logged first,
 * whatever the writes then do; a write error is thrown after it.
 */
export function doctorTick(ledger: Ledger | null, deps: DoctorDeps, ledgerError: string | null = null): PartResult[] {
	const results = guarded("ctx", () => checkCtx(deps));
	const ctx = results.find((r) => r.verdict === "pass" || r.verdict === "fail")!;
	const warn = results.filter((r) => r.verdict === "warn").map((r) => `; warn: ${r.evidence}`).join("");
	if (!ledger) {
		deps.out(`doctor ctx: ${ctx.verdict} ${ctx.evidence}${warn}; the ledger could not be opened (${clip(ledgerError ?? "unknown error")}), so no episode is written`);
		return results;
	}
	deps.out(`doctor ctx: ${ctx.verdict} ${ctx.evidence}${warn}`);
	for (const b of applyEpisodes(ledger, [ctx], "tick")) deps.out(`doctor: wrote ${b}`);
	for (const l of settleAndSpawn(ledger, deps)) deps.out(l);
	return results;
}

// ---- the real machine -------------------------------------------------------------------------------------------

/** One probe on the real machine: resolved on the env's PATH, 10 s, SIGKILL past it. */
export function realRun(baseEnv: Record<string, string | undefined>): Run {
	return (argv, env = baseEnv) => {
		const bin = Bun.which(argv[0]!, { PATH: env.PATH ?? "" });
		if (bin === null) return { code: null, stdout: "", stderr: "", error: `could not start: ${argv[0]} is not on PATH (${env.PATH ?? "unset"})` };
		try {
			const r = Bun.spawnSync([bin, ...argv.slice(1)], { env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" });
			return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ...(r.exitedDueToTimeout ? { error: `timed out after ${PROBE_TIMEOUT_MS / 1000} s and was killed` } : {}) };
		} catch (e) {
			return { code: null, stdout: "", stderr: "", error: `could not start: ${errText(e)}` };
		}
	};
}

export const realFs: DoctorFs = {
	exists: (p) => existsSync(p),
	executable: (p) => {
		try {
			accessSync(p, constants.X_OK);
		} catch (e) {
			if (e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "EACCES" || e.code === "ENOTDIR")) return false;
			throw e;
		}
		return statSync(p).isFile();
	},
	mtimeMs: (p) => {
		try {
			return statSync(p).mtimeMs;
		} catch (e) {
			if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
			throw e;
		}
	},
	readdir: (p) => readdirSync(p),
	readText: (p) => readFileSync(p, "utf8"),
	which: (name, path) => Bun.which(name, { PATH: path }),
	writeAtomic: (path, text) => {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	},
};

/** The popup process's log: its output and errors, appended. */
export const popupLogPath = (home: string): string => join(home, ".agent-system-2", "doctor", "popup.log");

/**
 * Spawn `<bun> <abs doctor.ts> --popup` detached, by absolute paths (process.execPath and the script's own path, never the
 * caller's cwd), output appended to the popup log. Test seam: AS2_DOCTOR_POPUP_WAIT=1 runs the same process in the
 * foreground and waits for its exit, so a test waits on the real popup completion instead of sleeping.
 */
export function spawnPopupProcess(env: Record<string, string | undefined>, home: string, doctorScript: string): string {
	const log = popupLogPath(home);
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(log, "a");
	try {
		const argv = [process.execPath, doctorScript, "--popup"];
		const opts = { cwd: dirname(doctorScript), env: env as Record<string, string>, stdin: "ignore" as const, stdout: fd, stderr: fd };
		if (env.AS2_DOCTOR_POPUP_WAIT === "1") {
			const r = Bun.spawnSync(argv, opts);
			return `popup process ran in the foreground (AS2_DOCTOR_POPUP_WAIT=1) and exited ${r.exitCode ?? "on a signal"}; output in ${log}`;
		}
		const p = Bun.spawn(argv, { ...opts, detached: true });
		p.unref();
		return `popup process ${p.pid} spawned (${argv.join(" ")}); output in ${log}`;
	} finally {
		closeSync(fd);
	}
}

/** SIGKILL a popup owner and its process group (it was spawned detached, so its group is its own pid). */
function killOwner(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
		return;
	} catch (e) {
		if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e;
	}
	process.kill(pid, "SIGKILL");
}

export interface RealDepsOptions {
	env: Record<string, string | undefined>;
	repo: string;
	/** surface/scripts/doctor.ts, absolute. */
	doctorScript: string;
	ledgerPath: string;
	out: (line: string) => void;
}

export function realDeps(o: RealDepsOptions): DoctorDeps {
	const home = o.env.HOME;
	if (!home) throw new Error("HOME is not set: as2 doctor reads the LaunchAgents, logs and mailboxes under it");
	const info = userInfo();
	return {
		run: realRun(o.env),
		fs: realFs,
		now: () => Date.now(),
		env: o.env,
		home,
		uid: info.uid,
		user: info.username,
		repo: o.repo,
		ledgerPath: o.ledgerPath,
		pid: process.pid,
		alive: processAlive,
		kill: killOwner,
		spawnPopup: () => spawnPopupProcess(o.env, home, o.doctorScript),
		alarm: (title, text, spoken, giveUpSecs, timeoutMs) => alarmPopup(title, text, spoken, { repo: o.repo, giveUpSecs, env: o.env, timeoutMs }),
		notify: realNotify,
		out: o.out,
	};
}
