// The installer's manifest checks (SPEC-2.0.md § B8), run against a scratch copy of every directory
// the manifest names, with a temp HOME: the real HOME and this checkout are never written. Regressions from
// the M2 reviews: S1 (the ledger-schema row is authoritative-or-refused), S5 (symbolic links
// under a machinery directory are refused, not skipped), N1 (an older schema is refused with exit
// 4, nothing written) and S2 (the periodic backup job is written as a launchd plist under the temp
// HOME, never loaded; its exact command runs against an open writer and fails when a due copy
// does). install/fresh-machine-test.sh repeats these against a real clone. And --chaos-nightly=off
// (wl-mv45yxnkw2251c review r1, openai #5): against a fake `launchctl` first on PATH, it boots the
// job out and deletes its plist before any install step, with no bun on PATH and an unreadable
// ledger path, and writes nothing else; and it fails closed (review r2, openai #3): only exit 113
// with "Could not find service" counts as absent, and a missing launchctl, any other print failure
// or a failed bootout exits 1 with the plist kept. And arming.log (PLAN wl-mv5lpzqacbe5ts § 2.1):
// =off appends one `off` line to an armed log after a confirmed bootout or absence and writes
// nothing else, creates no log where there is none, and leaves the log alone on a launchctl
// failure; --chaos-nightly appends `on` once across a re-install. Both judge the state by the log's
// last VALID `on|off <UTC ISO Z>` line, skipping malformed ones and ones whose time is not a real
// instant as the surface's parser does, and an append to a log with no trailing newline writes one
// first (review r1 of wl-mv5lpzqacbe5ts; the impossible instants, review r2).
import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const T = "\t";
const DOC_ROW = `ledger/SCHEMA.md${T}doc${T}-`;
const SCHEMA_ROW = `ledger/schema.sql${T}ledger-schema${T}{ledger_db}`;

let root: string;
let copy: string;
let manifest: string;
let original: string;

/** Run the scratch copy's installer the way a fresh machine would: PATH, a temp HOME, and `env`. */
function install(label: string, env: Record<string, string> = {}): { exitCode: number; out: string; db: string; home: string } {
	const home = join(root, `home-${label}`);
	mkdirSync(home, { recursive: true });
	const db = env.AGENT_SYSTEM_LEDGER_DB ?? join(home, ".agent-system-2", "ledger.db");
	const r = Bun.spawnSync(["bash", join(copy, "install", "install.sh")], {
		env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, stdout: "pipe", stderr: "pipe",
	});
	return { exitCode: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), db, home };
}

/** Every scheduled copy under the ledger's backups/ root, whatever its namespace directory. */
const copiesOf = (db: string) => {
	const root = join(dirname(db), "backups");
	return existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).filter((n) => /ledger-[^/]*\.db$/.test(n)).map((n) => join(root, n)) : [];
};

/** The original manifest with whole rows replaced. */
function manifestWith(...pairs: [string, string][]): void {
	let text = original;
	for (const [from, to] of pairs) {
		expect(text.split("\n")).toContain(from);
		text = text.split("\n").map((line) => (line === from ? to : line)).join("\n");
	}
	writeFileSync(manifest, text);
}

/** Every top-level directory install/manifest.tsv has rows under (b3e06bb added the M3/M4 ones; M6 added skills/ and bin/). */
const MANIFEST_DIRS = ["ledger", "install", "profile", "tiers", "classifier", "gates", "skills", "bin", "surface", "contract", "voice"];

beforeAll(() => {
	root = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "ledger-install-"));
	copy = join(root, "repo");
	for (const dir of MANIFEST_DIRS) cpSync(join(REPO, dir), join(copy, dir), { recursive: true });
	for (const d of MANIFEST_DIRS) {
		for (const name of readdirSync(join(copy, d), { recursive: true }) as string[]) {
			if (name.endsWith(".DS_Store")) rmSync(join(copy, d, name));
		}
	}
	manifest = join(copy, "install", "manifest.tsv");
	original = readFileSync(manifest, "utf8");
});

describe("install: the baseline copy installs", () => {
	test("exit 0; ledger created; the first scheduled copy is taken by install (S2 ownership)", () => {
		const r = install("baseline");
		expect(r.out).toContain("install complete");
		expect(r.exitCode).toBe(0);
		expect(existsSync(r.db)).toBe(true);
		expect(copiesOf(r.db).length).toBe(1);
	});
});

describe("install: a ledger at an older schema version is refused with exit 4, nothing written (N1)", () => {
	// The first schema (94f06b9, version 1) and the last before the hand's identity columns (1fe1b6e, version 4).
	for (const [rev, version] of [["94f06b9", 1], ["1fe1b6e", 4]] as const) {
		test(`review probe: a version-${version} ledger built from ${rev}:ledger/schema.sql`, () => {
			const db = join(root, `old-schema-${rev}`, "ledger.db");
			mkdirSync(dirname(db), { recursive: true });
			const schema = Bun.spawnSync(["git", "-C", REPO, "show", `${rev}:ledger/schema.sql`], { stdout: "pipe" });
			const sqlite3 = existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
			expect(Bun.spawnSync([sqlite3, db], { stdin: schema.stdout }).exitCode).toBe(0);
			const r = install(`old-schema-${rev}`, { AGENT_SYSTEM_LEDGER_DB: db });
			expect(r.out).toContain(`is schema version ${version}, which predates the supported schema (version 5)`);
			expect(r.out).not.toContain("install complete");
			expect(r.exitCode).toBe(4);
			expect(Bun.spawnSync([sqlite3, db, "PRAGMA user_version;"]).stdout.toString().trim()).toBe(String(version));
			expect(copiesOf(db)).toEqual([]);
			expect(existsSync(join(r.home, "Library", "LaunchAgents"))).toBe(false);
		});
	}
});

describe.if(process.platform === "darwin")("install: the periodic backup job is a launchd plist, written and never loaded (S2)", () => {
	test("the plist lints; its exact command takes a due copy while a writer holds the ledger open, and exits 1 when the copy fails", async () => {
		const r = install("launchd");
		expect(r.exitCode).toBe(0);
		expect(r.out).toContain("backup job written, not loaded");
		const plist = join(r.home, "Library", "LaunchAgents", "com.agent-system-2.ledger-backup.plist");
		const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", plist], { stdout: "pipe" });
		expect(lint.exitCode).toBe(0);
		const job = JSON.parse(Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", plist], { stdout: "pipe" }).stdout.toString()) as {
			Label: string; ProgramArguments: string[]; EnvironmentVariables: Record<string, string>; WorkingDirectory: string;
			StartInterval: number; RunAtLoad: boolean;
		};
		expect(structuredClone(job)).toMatchObject({ // a copy: bun's toMatchObject wrote its matchers into the received object
			Label: "com.agent-system-2.ledger-backup", StartInterval: 3600, RunAtLoad: true, WorkingDirectory: copy,
			ProgramArguments: [expect.stringMatching(/^\/.*bun$/), "run", join(copy, "ledger", "scripts", "backup.ts")],
			EnvironmentVariables: { AGENT_SYSTEM_LEDGER_DB: r.db, HOME: r.home },
		});
		const runJob = () => {
			const p = Bun.spawnSync(job.ProgramArguments, { env: job.EnvironmentVariables, cwd: job.WorkingDirectory, stdout: "pipe", stderr: "pipe" });
			return { exitCode: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
		};

		// Rename the install's copy to an old time, so the job's copy is due.
		const [installed] = copiesOf(r.db);
		const aged = join(dirname(installed!), "ledger-2026-01-01T00-00-00.000Z.db");
		renameSync(installed!, aged);
		const writer = Bun.spawn(["bun", "-e", `
			import { Ledger } from ${JSON.stringify(join(copy, "ledger", "src", "index.ts"))};
			const l = Ledger.open(${JSON.stringify(r.db)}, { backupOnOpen: false });
			l.openWorkload({ brief: "written by the open writer", stakes: "normal", mode: "autonomous", by: "writer", id: "wl-writer" });
			console.log("ready");
			await Bun.stdin.text(); // hold the connection open until the test closes stdin
			l.close();
		`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		try {
			const reader = writer.stdout.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
			const took = runJob();
			expect([took.exitCode, took.err]).toEqual([0, ""]);
			expect(took.out).toMatch(/^backup ok: took /);
			const fresh = took.out.replace(/^backup ok: took /, "").trim();
			const sqlite3 = existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
			expect(Bun.spawnSync([sqlite3, fresh, "SELECT brief FROM workloads WHERE id = 'wl-writer';"]).stdout.toString().trim()).toBe("written by the open writer");

			// N3 through the job: the older copy is there, the directory is not writable, the copy is due.
			rmSync(fresh);
			chmodSync(dirname(aged), 0o555);
			try {
				const failed = runJob();
				expect({ exitCode: failed.exitCode, out: failed.out }).toEqual({ exitCode: 1, out: "" });
				expect(failed.err).toContain("ledger backup failed");
			} finally {
				chmodSync(dirname(aged), 0o755);
			}
		} finally {
			writer.stdin.end();
			await writer.exited;
		}
	});

	test("M2 third review, S1: a HOME and a ledger path holding @REPO@, @HOME@ and XML characters are written as given", () => {
		const db = join(root, "db-@REPO@ & @HOME@", "<'@LOG@'> \"&\".db");
		const r = install("@REPO@ & @HOME@", { AGENT_SYSTEM_LEDGER_DB: db });
		expect(r.out).toContain("install complete");
		expect(r.exitCode).toBe(0);
		const plist = join(r.home, "Library", "LaunchAgents", "com.agent-system-2.ledger-backup.plist");
		expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", plist]).exitCode).toBe(0);
		const job = JSON.parse(Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", plist], { stdout: "pipe" }).stdout.toString()) as {
			ProgramArguments: string[]; EnvironmentVariables: Record<string, string>; WorkingDirectory: string; StandardOutPath: string;
		};
		expect({ ...job.EnvironmentVariables, WorkingDirectory: job.WorkingDirectory, StandardOutPath: job.StandardOutPath }).toEqual({
			AGENT_SYSTEM_LEDGER_DB: db, HOME: r.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			WorkingDirectory: copy, StandardOutPath: join(dirname(db), "ledger-backup.log"),
		});
		const p = Bun.spawnSync(job.ProgramArguments, { env: job.EnvironmentVariables, cwd: job.WorkingDirectory, stdout: "pipe", stderr: "pipe" });
		expect([p.exitCode, p.stderr.toString()]).toEqual([0, ""]);
		expect(p.stdout.toString()).toStartWith("backup ok: none due; newest ");
		expect(p.stdout.toString()).toContain(`/db-@REPO@ & @HOME@/backups/<'@LOG@'> "&"-`); // this ledger's own namespace
	});
});

describe("install: the manifest's ledger-schema row is strict (S1)", () => {
	const refused = (label: string, why: string) => {
		const r = install(label);
		writeFileSync(manifest, original);
		expect(r.out).toContain(why);
		expect(r.exitCode).toBe(2);
		expect(existsSync(join(r.db, ".."))).toBe(false);
	};

	test("review probe E4: SCHEMA.md filed as the schema and schema.sql as a doc is refused, nothing written", () => {
		manifestWith([DOC_ROW, `ledger/SCHEMA.md${T}ledger-schema${T}{ledger_db}`], [SCHEMA_ROW, `ledger/schema.sql${T}doc${T}-`]);
		refused("swapped", "the ledger module applies ledger/schema.sql and nothing else");
	});

	test("no ledger-schema row at all is refused", () => {
		manifestWith([SCHEMA_ROW, `ledger/schema.sql${T}doc${T}-`]);
		refused("missing", "manifest needs exactly one ledger-schema row; found 0");
	});

	test("two ledger-schema rows are refused", () => {
		manifestWith([DOC_ROW, `ledger/SCHEMA.md${T}ledger-schema${T}{ledger_db}`]);
		refused("duplicate", "manifest needs exactly one ledger-schema row; found 2");
	});

	test("the init script itself refuses a --schema that is not the module's schema, before creating anything", () => {
		const db = join(root, "init-wrong-schema", "ledger.db");
		const r = Bun.spawnSync(["bun", "run", join(copy, "ledger", "scripts", "init.ts"), db, "--schema", join(copy, "ledger", "SCHEMA.md")], { stdout: "pipe", stderr: "pipe" });
		expect(r.stderr.toString()).toContain("is not the schema this module applies");
		expect(r.exitCode).toBe(2);
		expect(existsSync(db)).toBe(false);
	});
});

describe("install: every machinery file has exactly one manifest row (P-11 manifest-or-fail)", () => {
	test("an unmanifested regular file under a machinery directory is refused and named, nothing written", () => {
		const file = "ledger/src/unmanifested-probe.ts";
		writeFileSync(join(copy, file), "export {};\n");
		const r = install("unmanifested");
		rmSync(join(copy, file));
		expect(r.out).toContain(`have no manifest row:\n  ${file}\n`);
		expect(r.exitCode).toBe(2);
		expect(existsSync(r.db)).toBe(false);
	});

	test("a duplicated manifest row is refused, nothing written", () => {
		writeFileSync(manifest, `${original}${DOC_ROW}\n`);
		const r = install("duplicate-row");
		writeFileSync(manifest, original);
		expect(r.out).toContain(`duplicate row for ledger/SCHEMA.md`);
		expect(r.exitCode).toBe(2);
		expect(existsSync(r.db)).toBe(false);
	});
});

describe("install: symbolic links under a machinery directory are refused (S5)", () => {
	const refusedWithLink = (label: string, link: string, target: string, row?: string) => {
		symlinkSync(target, join(copy, link));
		if (row) writeFileSync(manifest, `${original}${row}\n`);
		const r = install(label);
		rmSync(join(copy, link));
		writeFileSync(manifest, original);
		expect(r.out).toContain(row ? `${link} is a symbolic link` : `${link} -> ${target}`);
		expect(r.exitCode).toBe(2);
		expect(existsSync(r.db)).toBe(false);
	};

	test("review probe E3: an unmanifested ledger/unmanifested.ts -> src/index.ts", () => {
		refusedWithLink("link-file", "ledger/unmanifested.ts", "src/index.ts");
	});

	test("a dangling link and a link to a directory outside the repo", () => {
		refusedWithLink("link-dangling", "ledger/src/dangling.ts", "../../nowhere.ts");
		refusedWithLink("link-dir", "install/outside", root);
	});

	test("a link that has its own manifest row is still refused", () => {
		refusedWithLink("link-row", "ledger/linked.ts", "src/index.ts", `ledger/linked.ts${T}ledger-module${T}-`);
	});

	test("after every refusal the untouched copy installs again", () => {
		expect(install("after").exitCode).toBe(0);
	});
});

describe("install: --chaos-nightly=off stops the chaos job before any install step (review r1 openai #5, r2 openai #3)", () => {
	// The label install.sh boots out is the template's own Label.
	const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(REPO, "install", "com.agent-system-2.chaos.plist"), "utf8"))?.[1] ?? "";
	const service = `gui/${process.getuid?.() ?? 0}/${label}`;
	// Only the fake launchctl and the system directories: no bun, no omp, no git, no ctx.
	const systemPath = "/usr/bin:/bin";
	// The real launchctl is /bin/launchctl on macOS; /usr/bin alone has dirname but no launchctl and no bun.
	const noLaunchctlPath = "/usr/bin";

	/** Every path under `dir`, relative, sorted. */
	const tree = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).sort();

	/** A fake launchctl's bin directory (for PATH) and the argv lines it was called with. */
	interface FakeLaunchctl {
		bin: string;
		calls: () => string[];
	}

	/**
	 * A fake launchctl that logs its argv. `print` answers from a flag file as launchd does (0 loaded;
	 * 113 with "Could not find service" on stderr not), as fresh-machine-test.sh step 13's does, unless
	 * `printFails` gives it another exit and stderr; `bootout` clears the flag, or exits `bootoutExit`;
	 * `bootstrap` sets it.
	 */
	function fakeLaunchctl(name: string, loaded: boolean, opts: { printFails?: [number, string]; bootoutExit?: number } = {}): FakeLaunchctl {
		const dir = join(root, `chaos-off-${name}`);
		const bin = join(dir, "bin");
		const log = join(dir, "launchctl.log");
		const flag = join(dir, "launchctl.loaded");
		mkdirSync(bin, { recursive: true });
		if (loaded) writeFileSync(flag, "");
		const print = opts.printFails
			? `printf '%s\\n' '${opts.printFails[1]}' >&2; exit ${opts.printFails[0]}`
			: `[ -e '${flag}' ] || { printf '%s\\n' 'Bad request.' 'Could not find service "${label}" in domain for user gui: 501' >&2; exit 113; }`;
		const bootout = opts.bootoutExit ? `echo "Boot-out failed: ${opts.bootoutExit}" >&2; exit ${opts.bootoutExit}` : `rm -f '${flag}'`;
		writeFileSync(join(bin, "launchctl"), [
			"#!/bin/bash",
			`printf '%s\\n' "$*" >>'${log}'`,
			'case "$1" in',
			`\tprint) ${print} ;;`,
			`\tbootout) ${bootout} ;;`,
			`\tbootstrap) : >'${flag}' ;;`,
			"esac",
			"",
		].join("\n"));
		chmodSync(join(bin, "launchctl"), 0o755);
		return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : []) };
	}

	/** Run the scratch copy's installer with --chaos-nightly=off under `home`, with exactly `path` as PATH. */
	function off(home: string, path: string, env: Record<string, string> = {}) {
		const r = Bun.spawnSync(["/bin/bash", join(copy, "install", "install.sh"), "--chaos-nightly=off"], {
			env: { PATH: path, HOME: home, ...env }, stdout: "pipe", stderr: "pipe",
		});
		return { exitCode: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
	}

	/** A temp HOME holding a chaos plist with known content. */
	function homeWithPlist(name: string): { home: string; plist: string } {
		const home = join(root, `home-chaos-off-${name}`);
		const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
		mkdirSync(dirname(plist), { recursive: true });
		writeFileSync(plist, "<plist/>\n");
		return { home, plist };
	}

	/** The plist is still there, unchanged, and nothing else was written under `home`. */
	function plistKept(home: string, plist: string): void {
		expect(readFileSync(plist, "utf8")).toBe("<plist/>\n");
		expect(tree(home)).toEqual(["Library", join("Library", "LaunchAgents"), join("Library", "LaunchAgents", `${label}.plist`)]);
	}

	test("test setup: the template has a label, bun is not on the off run's PATH, and launchctl is not on the no-launchctl PATH", () => {
		expect(label).toBe("com.agent-system-2.chaos");
		expect(Bun.spawnSync(["/bin/bash", "-c", "type -P bun"], { env: { PATH: systemPath } }).exitCode).not.toBe(0);
		expect(Bun.spawnSync(["/bin/bash", "-c", "type -P launchctl"], { env: { PATH: noLaunchctlPath } }).exitCode).not.toBe(0);
		expect(Bun.spawnSync(["/bin/bash", "-c", "type -P dirname"], { env: { PATH: noLaunchctlPath } }).exitCode).toBe(0);
	});

	test("a loaded job and its plist, no bun on PATH, an unreadable ledger path: booted out, plist deleted, nothing else written", () => {
		const home = join(root, "home-chaos-off-loaded");
		const agents = join(home, "Library", "LaunchAgents");
		const plist = join(agents, `${label}.plist`);
		mkdirSync(agents, { recursive: true });
		writeFileSync(plist, "<plist/>\n");
		const locked = join(root, "chaos-off-locked");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		const launchctl = fakeLaunchctl("loaded", true);
		try {
			const r = off(home, `${launchctl.bin}:${systemPath}`, { AGENT_SYSTEM_LEDGER_DB: join(locked, "ledger.db") });
			expect(r.out).toContain(`chaos nightly booted out: ${service}`);
			expect(r.out).toContain(`chaos nightly removed: ${plist}`);
			expect(r.out).not.toContain("bun not found");
			expect(r.out).not.toContain("reading manifest");
			expect(r.out).not.toContain("install complete");
			expect(r.exitCode).toBe(0);
			expect(launchctl.calls()).toEqual([`print ${service}`, `bootout ${service}`]);
			expect(existsSync(plist)).toBe(false);
			expect(tree(home)).toEqual(["Library", join("Library", "LaunchAgents")]);
		} finally {
			chmodSync(locked, 0o755);
		}
		expect(readdirSync(locked)).toEqual([]);
	});

	test("nothing loaded and no plist: says so, only asks launchctl, exit 0, writes nothing", () => {
		const home = join(root, "home-chaos-off-absent");
		mkdirSync(home, { recursive: true });
		const launchctl = fakeLaunchctl("absent", false);
		const r = off(home, `${launchctl.bin}:${systemPath}`);
		expect(r.out).toContain(`chaos nightly: no job loaded at ${service}`);
		expect(r.out).toContain(`chaos nightly: no plist at ${join(home, "Library", "LaunchAgents", `${label}.plist`)}`);
		expect(r.out).not.toContain("reading manifest");
		expect(r.exitCode).toBe(0);
		expect(launchctl.calls()).toEqual([`print ${service}`]);
		expect(tree(home)).toEqual([]);
	});

	test("confirmed absent (113, \"Could not find service\") with a stale plist: plist deleted, no bootout, exit 0", () => {
		const { home, plist } = homeWithPlist("absent-stale");
		const launchctl = fakeLaunchctl("absent-stale", false);
		const r = off(home, `${launchctl.bin}:${systemPath}`);
		expect(r.out).toContain(`chaos nightly: no job loaded at ${service}`);
		expect(r.out).toContain(`chaos nightly removed: ${plist}`);
		expect(r.exitCode).toBe(0);
		expect(launchctl.calls()).toEqual([`print ${service}`]);
		expect(existsSync(plist)).toBe(false);
	});

	for (const [name, code, stderr] of [
		["print-error", 5, "Bad request."],
		["print-113-other", 113, "Bad request."],
	] as const) {
		test(`inspection fails (${name}: print exits ${code}, stderr "${stderr}" without "Could not find service"): says why, plist kept, no bootout, exit 1`, () => {
			const { home, plist } = homeWithPlist(name);
			const launchctl = fakeLaunchctl(name, true, { printFails: [code, stderr] });
			const r = off(home, `${launchctl.bin}:${systemPath}`);
			expect(r.out).toContain(`install: FAIL: launchctl print ${service} exited ${code} (${stderr}), so whether the job is loaded is unknown; ${plist} is kept`);
			expect(r.out).not.toContain("no job loaded");
			expect(r.out).not.toContain("removed");
			expect(r.exitCode).toBe(1);
			expect(launchctl.calls()).toEqual([`print ${service}`]);
			plistKept(home, plist);
		});
	}

	test("launchctl not on PATH: says why, plist kept, exit 1", () => {
		const { home, plist } = homeWithPlist("no-launchctl");
		const r = off(home, noLaunchctlPath);
		expect(r.out).toContain(`install: FAIL: launchctl not found on PATH, so whether ${service} is loaded is unknown; ${plist} is kept`);
		expect(r.out).not.toContain("removed");
		expect(r.exitCode).toBe(1);
		plistKept(home, plist);
	});

	test("a loaded job whose bootout fails: says why, plist kept, exit 1", () => {
		const { home, plist } = homeWithPlist("bootout-fails");
		const launchctl = fakeLaunchctl("bootout-fails", true, { bootoutExit: 5 });
		const r = off(home, `${launchctl.bin}:${systemPath}`);
		expect(r.out).toContain(`install: FAIL: launchctl bootout ${service} exited 5; ${plist} is kept`);
		expect(r.out).not.toContain("booted out:");
		expect(r.out).not.toContain("removed");
		expect(r.exitCode).toBe(1);
		expect(launchctl.calls()).toEqual([`print ${service}`, `bootout ${service}`]);
		plistKept(home, plist);
	});

	// arming.log (PLAN wl-mv5lpzqacbe5ts § 2.1): the append-only `on|off <UTC ISO Z>` history under
	// $HOME/agent-scratch/agent-system-2.0/chaos/nightly. Literal paths and lines, no repo imports.
	const NIGHTLY = join("agent-scratch", "agent-system-2.0", "chaos", "nightly");
	const ARMING = join(NIGHTLY, "arming.log");
	const ARMED = "on 2026-10-01T10:00:00Z\n";
	const OFF_LINE = /^off \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
	const ON_LINE = /^on \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
	/** The directories from $HOME down to the nightly dir, as `tree` lists them. */
	const nightlyDirs = NIGHTLY.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));

	/** A temp HOME holding a chaos plist and, when `log` is a string, `arming.log` with that text. */
	function homeWithLog(name: string, log: string | null): { home: string; plist: string; log: string } {
		const { home, plist } = homeWithPlist(name);
		const path = join(home, ARMING);
		if (log !== null) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, log);
		}
		return { home, plist, log: path };
	}

	test("--chaos-nightly=off appends off to an armed arming.log", () => {
		const { home, plist, log } = homeWithLog("armed-loaded", ARMED);
		const launchctl = fakeLaunchctl("armed-loaded", true);
		const from = Math.floor(Date.now() / 1000);
		const r = off(home, `${launchctl.bin}:${systemPath}`);
		const to = Math.ceil(Date.now() / 1000);
		expect(r.out).toContain(`chaos nightly booted out: ${service}`);
		expect(r.exitCode).toBe(0);
		expect(existsSync(plist)).toBe(false);
		const lines = readFileSync(log, "utf8").split("\n");
		expect(lines.length).toBe(3);
		expect(lines[0]).toBe(ARMED.trimEnd());
		expect(lines[1]).toMatch(OFF_LINE);
		expect(lines[2]).toBe("");
		const offAt = Date.parse(lines[1]!.slice("off ".length)) / 1000;
		expect(offAt).toBeGreaterThanOrEqual(from);
		expect(offAt).toBeLessThanOrEqual(to);
		expect(tree(home)).toEqual(["Library", join("Library", "LaunchAgents"), ...nightlyDirs, ARMING].sort());
	});

	test("=off with the job confirmed absent (113) appends off to an armed log too; nothing else is written", () => {
		const { home, log } = homeWithLog("armed-absent", "on 2026-09-01T10:00:00Z\noff 2026-09-02T10:00:00Z\non 2026-10-01T10:00:00Z\n");
		const launchctl = fakeLaunchctl("armed-absent", false);
		const r = off(home, `${launchctl.bin}:${systemPath}`);
		expect(r.out).toContain(`chaos nightly: no job loaded at ${service}`);
		expect(r.exitCode).toBe(0);
		expect(launchctl.calls()).toEqual([`print ${service}`]);
		const lines = readFileSync(log, "utf8").split("\n");
		expect(lines.slice(0, 3)).toEqual(["on 2026-09-01T10:00:00Z", "off 2026-09-02T10:00:00Z", "on 2026-10-01T10:00:00Z"]);
		expect(lines[3]).toMatch(OFF_LINE);
		expect(lines.slice(4)).toEqual([""]);
		expect(tree(home)).toEqual(["Library", join("Library", "LaunchAgents"), ...nightlyDirs, ARMING].sort());
	});

	test("=off with no arming.log creates none: neither the file nor its directory, and with the directory present still no file", () => {
		const bare = homeWithLog("no-log", null);
		const r1 = off(bare.home, `${fakeLaunchctl("no-log", true).bin}:${systemPath}`);
		expect(r1.exitCode).toBe(0);
		expect(tree(bare.home)).toEqual(["Library", join("Library", "LaunchAgents")]);
		const withDir = homeWithLog("no-log-dir", null);
		mkdirSync(join(withDir.home, NIGHTLY), { recursive: true });
		const r2 = off(withDir.home, `${fakeLaunchctl("no-log-dir", true).bin}:${systemPath}`);
		expect(r2.exitCode).toBe(0);
		expect(tree(withDir.home)).toEqual(["Library", join("Library", "LaunchAgents"), ...nightlyDirs].sort());
	});

	test("=off appends nothing when arming.log is already off, and a second =off adds nothing", () => {
		const disarmed = "on 2026-10-01T10:00:00Z\noff 2026-10-02T10:00:00Z\n";
		const { home, log } = homeWithLog("already-off", disarmed);
		const launchctl = fakeLaunchctl("already-off", true);
		expect(off(home, `${launchctl.bin}:${systemPath}`).exitCode).toBe(0);
		expect(readFileSync(log, "utf8")).toBe(disarmed);
		expect(off(home, `${launchctl.bin}:${systemPath}`).exitCode).toBe(0);
		expect(readFileSync(log, "utf8")).toBe(disarmed);
	});

	for (const [name, path, opts] of [
		["print-fails", true, { printFails: [5, "Bad request."] }],
		["bootout-fails", true, { bootoutExit: 5 }],
		["no-launchctl", false, {}],
	] as const) {
		test(`a launchctl failure (${name}) leaves arming.log untouched, exit 1`, () => {
			const { home, plist, log } = homeWithLog(`armed-${name}`, ARMED);
			const r = off(home, path ? `${fakeLaunchctl(`armed-${name}`, true, opts as { printFails?: [number, string]; bootoutExit?: number }).bin}:${systemPath}` : noLaunchctlPath);
			expect(r.out).toContain("install: FAIL:");
			expect(r.exitCode).toBe(1);
			expect(readFileSync(log, "utf8")).toBe(ARMED);
			expect(readFileSync(plist, "utf8")).toBe("<plist/>\n");
			expect(tree(home)).toEqual(["Library", join("Library", "LaunchAgents"), join("Library", "LaunchAgents", `${label}.plist`), ...nightlyDirs, ARMING].sort());
		});
	}

	/**
	 * A fake launchctl with nothing loaded and an `omp` stand-in beside it (the job's PATH needs omp's
	 * directory; the stand-in answers `type -P omp` whoever runs the test), and a function that runs
	 * the scratch copy's full installer with --chaos-nightly under `home` and expects it to succeed.
	 */
	function chaosNightly(name: string, home: string): { launchctl: FakeLaunchctl; arm: () => string } {
		const launchctl = fakeLaunchctl(name, false);
		writeFileSync(join(launchctl.bin, "omp"), "#!/bin/bash\nexit 0\n");
		chmodSync(join(launchctl.bin, "omp"), 0o755);
		const arm = () => {
			const r = Bun.spawnSync(["bash", join(copy, "install", "install.sh"), "--chaos-nightly"], {
				env: { PATH: `${launchctl.bin}:${process.env.PATH ?? ""}`, HOME: home }, stdout: "pipe", stderr: "pipe",
			});
			const out = r.stdout.toString() + r.stderr.toString();
			expect(out).toContain("install complete");
			expect(r.exitCode).toBe(0);
			return out;
		};
		return { launchctl, arm };
	}

	test.if(process.platform === "darwin")("--chaos-nightly appends on once across a re-install, and again only after an off", () => {
		const home = join(root, "home-chaos-arm");
		mkdirSync(home, { recursive: true });
		const { launchctl, arm } = chaosNightly("arm", home);
		const log = join(home, ARMING);
		arm();
		const first = readFileSync(log, "utf8");
		expect(first.split("\n")).toEqual([expect.stringMatching(ON_LINE), ""]);
		arm();
		expect(readFileSync(log, "utf8")).toBe(first);
		expect(launchctl.calls().filter((c) => c.startsWith("bootstrap"))).toHaveLength(2);
		expect(off(home, `${launchctl.bin}:${systemPath}`).exitCode).toBe(0);
		const disarmed = readFileSync(log, "utf8").split("\n");
		expect(disarmed).toEqual([first.trimEnd(), expect.stringMatching(OFF_LINE), ""]);
		arm();
		expect(readFileSync(log, "utf8").split("\n")).toEqual([...disarmed.slice(0, 2), expect.stringMatching(ON_LINE), ""]);
	});

	// The state is the last VALID line (review r1 of wl-mv5lpzqacbe5ts): a line that is not exactly
	// `on|off <UTC ISO Z>` is skipped, as the surface's parseArmingLog skips it, and never rewritten.
	const VALID_LINE = /^(on|off) \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

	test.if(process.platform === "darwin")("last valid line: an empty arming.log and --chaos-nightly gives exactly one on line", () => {
		const home = join(root, "home-chaos-arm-empty");
		mkdirSync(join(home, NIGHTLY), { recursive: true });
		writeFileSync(join(home, ARMING), "");
		const { arm } = chaosNightly("arm-empty", home);
		expect(arm()).toContain("chaos nightly armed: on appended to");
		expect(readFileSync(join(home, ARMING), "utf8").split("\n")).toEqual([expect.stringMatching(ON_LINE), ""]);
	});

	test("last valid line: a valid on, then a malformed `off truncated`, then =off appends a valid off; earlier lines byte-identical", () => {
		const before = "on 2026-10-01T10:00:00Z\noff truncated\n";
		const { home, log } = homeWithLog("armed-malformed-off", before);
		const r = off(home, `${fakeLaunchctl("armed-malformed-off", true).bin}:${systemPath}`);
		expect(r.out).toContain("chaos nightly disarmed: off appended to");
		expect(r.exitCode).toBe(0);
		const after = readFileSync(log, "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(after.slice(before.length)).toMatch(/^off \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
	});

	test.if(process.platform === "darwin")("last valid line: a valid on and a valid off, then junk, then --chaos-nightly appends on; earlier lines byte-identical", () => {
		const before = "on 2026-09-01T10:00:00Z\noff 2026-09-02T10:00:00Z\non 2026-10-0\n";
		const home = join(root, "home-chaos-arm-junk");
		mkdirSync(join(home, NIGHTLY), { recursive: true });
		writeFileSync(join(home, ARMING), before);
		const { arm } = chaosNightly("arm-junk", home);
		expect(arm()).toContain("chaos nightly armed: on appended to");
		const after = readFileSync(join(home, ARMING), "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(after.slice(before.length)).toMatch(/^on \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
	});

	test("last valid line: an unterminated last valid on, then =off writes a newline then off, and every line parses", () => {
		const before = "on 2026-09-01T10:00:00Z\noff 2026-09-02T10:00:00Z\non 2026-10-01T10:00:00Z";
		const { home, log } = homeWithLog("armed-unterminated", before);
		const r = off(home, `${fakeLaunchctl("armed-unterminated", true).bin}:${systemPath}`);
		expect(r.out).toContain("chaos nightly disarmed: off appended to");
		expect(r.exitCode).toBe(0);
		const after = readFileSync(log, "utf8");
		expect(after.startsWith(`${before}\n`)).toBe(true);
		const lines = after.split("\n");
		expect(lines.at(-1)).toBe("");
		expect(lines.slice(0, -1)).toEqual([...before.split("\n"), expect.stringMatching(OFF_LINE)]);
		for (const line of lines.slice(0, -1)) expect(line).toMatch(VALID_LINE);
	});

	// A line of the right shape whose time is not a real instant is skipped too, as parseArmingLog
	// skips it (review r2 of wl-mv5lpzqacbe5ts): February has no 30th and October no 32nd.
	test.if(process.platform === "darwin")("last valid line: only `on 2026-02-30T00:00:00Z`, then --chaos-nightly appends on; the line is byte-identical", () => {
		const before = "on 2026-02-30T00:00:00Z\n";
		const home = join(root, "home-chaos-arm-impossible");
		mkdirSync(join(home, NIGHTLY), { recursive: true });
		writeFileSync(join(home, ARMING), before);
		const { arm } = chaosNightly("arm-impossible", home);
		expect(arm()).toContain("chaos nightly armed: on appended to");
		const after = readFileSync(join(home, ARMING), "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(after.slice(before.length)).toMatch(/^on \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
	});

	test("last valid line: a valid on, then `off 2026-10-32T10:00:00Z`, then =off appends a valid off; earlier lines byte-identical", () => {
		const before = "on 2026-10-01T10:00:00Z\noff 2026-10-32T10:00:00Z\n";
		const { home, log } = homeWithLog("armed-impossible-off", before);
		const r = off(home, `${fakeLaunchctl("armed-impossible-off", true).bin}:${systemPath}`);
		expect(r.out).toContain("chaos nightly disarmed: off appended to");
		expect(r.exitCode).toBe(0);
		const after = readFileSync(log, "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(after.slice(before.length)).toMatch(/^off \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
	});
});
