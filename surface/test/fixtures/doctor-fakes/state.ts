// The as2 doctor's test fakes (the POSIX sh scripts beside this file) answer from files under $AS2_FAKE_STATE; this
// helper writes those files. `writeHealthyState` is a machine where every part the doctor checks passes: ctx fresh with
// its supervisor installed, ledger-backup installed and loaded with a fresh log, phoenix off, nothing opt-in installed,
// the seat's omp process, gh logged in as thewolff, 100 GiB free, HOME not the user's own home (so the doctor job is
// "not installed"), booted an hour ago.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FAKES_DIR = import.meta.dir;

export const LEDGER_BACKUP_LABEL = "com.agent-system-2.ledger-backup";

/** Write one state file (creating its directory). */
export function setFake(state: string, name: string, content: string): void {
	const path = join(state, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** Every fake call so far, one `<tool> <args>` line each. */
export function fakeCalls(state: string): string[] {
	try {
		return readFileSync(join(state, "calls.log"), "utf8").split("\n").filter(Boolean);
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
		throw e;
	}
}

/** The installed plist path for `label` under `home`. */
export const plistPath = (home: string, label: string): string => join(home, "Library", "LaunchAgents", `${label}.plist`);

/** `launchctl print`'s shape for a loaded, not-running job (the fields the doctor reads, one tab deep). */
export function launchctlPrint(o: { label: string; path: string; log: string; runs: number; exit: number | "never"; state?: string; pid?: number }): string {
	return [
		`gui/501/${o.label} = {`,
		"\tactive count = 0",
		`\tpath = ${o.path}`,
		`\ttype = LaunchAgent`,
		`\tstate = ${o.state ?? "not running"}`,
		"",
		`\tprogram = /usr/local/bin/bun`,
		`\tstdout path = ${o.log}`,
		`\tstderr path = ${o.log}`,
		...(o.pid !== undefined ? [`\tpid = ${o.pid}`] : []),
		`\truns = ${o.runs}`,
		`\tlast exit code = ${o.exit === "never" ? "(never exited)" : o.exit}`,
		"}",
		"",
	].join("\n");
}

export interface HealthyOptions {
	state: string;
	home: string;
	/** The repository the seat's omp runs in (`omp --cwd <repo>`). */
	repo: string;
	/** A pid the seat answers as (pgrep finds it; ps answers its command). */
	seatPid: number;
	/** An executable that exists (the job's ProgramArguments[0]). */
	bun: string;
}

/** A machine where every part passes (see the header). */
export function writeHealthyState(o: HealthyOptions): void {
	mkdirSync(o.state, { recursive: true });
	setFake(o.state, "ctx.mode", "fresh");
	setFake(o.state, "ctx.supervisor", "installed");
	setFake(o.state, "gh.json", JSON.stringify({ hosts: { "github.com": [{ login: "thewolff", state: "success", active: true, host: "github.com" }] } }));
	setFake(o.state, "df.out", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 994662584 400000000 104857600 80% /System/Volumes/Data\n");
	setFake(o.state, "pgrep.out", `${o.seatPid}\n`);
	setFake(o.state, `ps/${o.seatPid}.command`, `omp --cwd ${o.repo} --append-system-prompt ${o.repo}/orchestrator/system.md\n`);
	setFake(o.state, "sysctl.uptime", "3600");
	setFake(o.state, "dscl.home", "/Users/someone-else");
	// ledger-backup: installed, loaded from that file, ran, a fresh log.
	const plist = plistPath(o.home, LEDGER_BACKUP_LABEL);
	const log = join(o.home, ".agent-system-2", "logs", "ledger-backup.log");
	setFake(o.home, join("Library", "LaunchAgents", `${LEDGER_BACKUP_LABEL}.plist`), "<plist/>\n");
	setFake(o.home, join(".agent-system-2", "logs", "ledger-backup.log"), "backup ok\n");
	setFake(o.state, `plutil/${LEDGER_BACKUP_LABEL}.plist.json`, JSON.stringify({
		Label: LEDGER_BACKUP_LABEL,
		ProgramArguments: [o.bun, "run", plist],
		StartInterval: 3600,
		StandardOutPath: log,
		StandardErrorPath: log,
		EnvironmentVariables: { PATH: "/usr/bin:/bin" },
	}));
	setFake(o.state, `launchctl/${LEDGER_BACKUP_LABEL}`, launchctlPrint({ label: LEDGER_BACKUP_LABEL, path: plist, log, runs: 3, exit: 0 }));
	// phoenix off: its plist is not expected.
	setFake(o.home, join(".omp", "profiles", "agent-system-2", "agent", "config.yml"), "observability:\n  phoenix: off\n");
}
