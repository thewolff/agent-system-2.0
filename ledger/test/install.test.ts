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
// or a failed bootout exits 1 with the plist kept.
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
let installPath: string;

/** Run the scratch copy's installer the way a fresh machine would: PATH, a temp HOME, and `env`. */
function install(label: string, env: Record<string, string> = {}): { exitCode: number; out: string; db: string; home: string } {
	const home = join(root, `home-${label}`);
	mkdirSync(home, { recursive: true });
	const db = env.AGENT_SYSTEM_LEDGER_DB ?? join(home, ".agent-system-2", "ledger.db");
	const r = Bun.spawnSync(["bash", join(copy, "install", "install.sh")], {
		env: { PATH: installPath, HOME: home, ...env }, stdout: "pipe", stderr: "pipe",
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
const MANIFEST_DIRS = ["ledger", "install", "profile", "tiers", "classifier", "gates", "skills", "plugins", "bin", "surface", "contract", "voice"];

beforeAll(() => {
	root = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "ledger-install-"));
	// Do not inherit herdr/ctx from the developer's PATH: installer runs must never register a real
	// plugin. Only Bun and system utilities are needed for these ledger/manifest tests.
	const bin = join(root, "bin");
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "bun"));
	installPath = `${bin}:/usr/bin:/bin`;
	expect(Bun.which("herdr", { PATH: installPath })).toBeNull();
	expect(Bun.which("ctx", { PATH: installPath })).toBeNull();
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

describe("install: the tracing switch (wl-mv65t5d34lts00 PLAN.md § 8.1)", () => {
	const configOf = (home: string) => join(home, ".omp", "profiles", "agent-system-2", "agent", "config.yml");
	const phoenixOf = (home: string): unknown => {
		const doc: unknown = Bun.YAML.parse(readFileSync(configOf(home), "utf8"));
		const block = doc && typeof doc === "object" && "observability" in doc ? doc.observability : undefined;
		return block && typeof block === "object" && "phoenix" in block ? block.phoenix : undefined;
	};
	const linesOf = (out: string, re: RegExp) => out.split("\n").filter((l) => re.test(l));

	test("a fresh profile starts at all; a re-install keeps an installed off; a temp HOME never installs the Phoenix LaunchAgent", () => {
		const first = install("tracing");
		expect(first.exitCode).toBe(0);
		expect(linesOf(first.out, /^tracing:/)).toEqual([expect.stringMatching(/^tracing: no installed config at .*; the template's all is used$/)]);
		expect(phoenixOf(first.home)).toBe("all");
		// launchd has one gui/<uid> domain per user: an install into a temp HOME must not replace the real job.
		if (process.platform === "darwin") expect(linesOf(first.out, /Phoenix/)).toEqual([expect.stringContaining(`==> Phoenix: HOME (${first.home}) is not this user's home directory`)]);
		expect(existsSync(join(first.home, "Library", "LaunchAgents", "com.agent-system-2.phoenix.plist"))).toBe(false);

		const config = configOf(first.home);
		writeFileSync(config, readFileSync(config, "utf8").replace(/^ {2}phoenix: all/m, "  phoenix: off"));
		const again = install("tracing");
		expect(again.exitCode).toBe(0);
		expect(again.out).toContain(`tracing: observability.phoenix: off kept from ${config}`);
		expect(phoenixOf(again.home)).toBe("off");
		if (process.platform === "darwin") expect(again.out).toContain("==> Phoenix: observability.phoenix is off");
	});

	test.skipIf(process.platform !== "darwin")("phoenix-agent.sh on|off from a temp HOME with the real launchctl: refused with exit 2 before launchctl runs", () => {
		const home = join(root, "home-agent-guard");
		mkdirSync(home, { recursive: true });
		for (const word of ["on", "off"]) {
			const r = Bun.spawnSync(["bash", join(copy, "install", "phoenix-agent.sh"), word], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe" });
			expect({ word, code: r.exitCode, err: r.stderr.toString() }).toEqual({ word, code: 2, err: expect.stringContaining(`HOME (${home}) is not this user's home directory`) });
		}
		expect(readdirSync(home)).toEqual([]);
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

	test("membership is literal for spaces, backslashes and glob characters, not a pattern match", () => {
		const listed = "ledger/src/manifest literal-\\[ab]*?.md";
		const unlisted = "ledger/src/manifest literal-\\a-expanded.md";
		writeFileSync(join(copy, listed), "listed\n");
		writeFileSync(join(copy, unlisted), "unlisted\n");
		writeFileSync(manifest, `${original}${listed}${T}doc${T}-\n`);
		try {
			const r = install("literal-membership");
			expect(r.out).toContain(`have no manifest row:\n  ${unlisted}\n`);
			expect(r.out).not.toContain(`\n  ${listed}\n`);
			expect(r.exitCode).toBe(2);
			expect(existsSync(r.db)).toBe(false);
		} finally {
			writeFileSync(manifest, original);
			rmSync(join(copy, listed));
			rmSync(join(copy, unlisted));
		}
	});

	test("membership is case-sensitive even when BASH_ENV enables nocasematch", () => {
		const lower = join(copy, "ledger", "schema.md");
		// On a case-sensitive filesystem both files exist; on a case-insensitive one this is
		// already SCHEMA.md. Either way, the lowercase row must not own the uppercase path.
		const created = !existsSync(lower);
		if (created) cpSync(join(copy, "ledger", "SCHEMA.md"), lower);
		const bashEnv = join(root, "nocasematch.sh");
		writeFileSync(bashEnv, "shopt -s nocasematch\n");
		manifestWith([DOC_ROW, `ledger/schema.md${T}doc${T}-`]);
		try {
			const r = install("case-membership", { BASH_ENV: bashEnv });
			expect(r.out).toContain("have no manifest row:\n  ledger/SCHEMA.md\n");
			expect(r.exitCode).toBe(2);
			expect(existsSync(r.db)).toBe(false);
		} finally {
			writeFileSync(manifest, original);
			if (created) rmSync(lower);
		}
	});

	test("a duplicated manifest row is refused, nothing written", () => {
		writeFileSync(manifest, `${original}${DOC_ROW}\n`);
		const r = install("duplicate-row");
		writeFileSync(manifest, original);
		expect(r.out).toContain(`duplicate row for ledger/SCHEMA.md`);
		expect(r.exitCode).toBe(2);
		expect(existsSync(r.db)).toBe(false);
	});

	test("a malformed leading-TAB duplicate is refused before ledger or profile writes", () => {
		writeFileSync(manifest, `${original}${T}${DOC_ROW}\n`);
		try {
			const r = install("leading-tab-duplicate");
			expect(r.exitCode).toBe(2);
			expect(r.out).toContain("need exactly three TAB-separated fields");
			expect(existsSync(dirname(r.db))).toBe(false);
			expect(existsSync(join(r.home, ".omp"))).toBe(false);
		} finally {
			writeFileSync(manifest, original);
		}
	});

	test("a coverage awk failure refuses installation before ledger or profile writes", () => {
		const bin = join(root, "coverage-awk-bin");
		mkdirSync(bin);
		const awk = Bun.which("awk", { PATH: installPath });
		expect(awk).not.toBeNull();
		writeFileSync(join(bin, "awk"), [
			"#!/bin/bash",
			'if [ "${@: -1}" = "-" ]; then',
			"\tprintf '%s\\n' 'injected coverage awk failure' >&2",
			"\texit 42",
			"fi",
			`exec ${JSON.stringify(awk)} "$@"`,
			"",
		].join("\n"));
		chmodSync(join(bin, "awk"), 0o755);
		const file = join(copy, "ledger", "src", "coverage-awk-unmanifested.ts");
		writeFileSync(file, "export {};\n");
		try {
			const r = install("coverage-awk-failure", { PATH: `${bin}:${installPath}` });
			expect(r.exitCode).toBe(2);
			expect(r.out).toContain("manifest ok:");
			expect(r.out).toContain("injected coverage awk failure");
			expect(r.out).toContain("could not check manifest coverage under ledger");
			expect(existsSync(dirname(r.db))).toBe(false);
			expect(existsSync(join(r.home, ".omp"))).toBe(false);
		} finally {
			rmSync(file);
		}
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

describe("install: the vendored plugins' skills and loader (plugins/VENDOR.md)", () => {
	const rendered = (home: string) => join(home, ".omp", "profiles", "agent-system-2", "agent", "config.yml");

	test("the render lists <repo>/skills then the three plugin skill dirs, sorted, names exactly the 25 manifest skills, and loads plugins/index.ts last", () => {
		const r = install("plugins-baseline");
		expect(r.exitCode).toBe(0);
		const doc = Bun.YAML.parse(readFileSync(rendered(r.home), "utf8")) as { extensions: string[]; skills: { customDirectories: string[]; includeSkills: string[] } };
		expect(doc.skills.customDirectories).toEqual([`${copy}/skills`, `${copy}/plugins/ask-graham/skills`, `${copy}/plugins/i-have-audhd/skills`, `${copy}/plugins/paired-coding/skills`]);
		const skillRows = original
			.split("\n")
			.filter((l) => l.split(T)[1] === "skill")
			.map((l) => l.split(T)[0]!.replace(/\/SKILL\.md$/, "").replace(/^.*\//, ""));
		expect(skillRows).toHaveLength(25);
		expect([...doc.skills.includeSkills].sort()).toEqual(skillRows.sort());
		for (const name of ["ask-graham", "i-have-audhd", "paired-coding"]) expect(doc.skills.includeSkills).toContain(name);
		expect(doc.extensions.at(-1)).toBe(`${copy}/plugins/index.ts`);
	});

	// Which modules OMP's discovery then skips, with a seeded control plugin still loading, is in
	// plugins/test/loader.test.ts and install/fresh-machine-test.sh step 3c.
	test("disabledExtensions names exactly each vendored adapter's module, from its package.json omp.extensions", () => {
		const r = install("plugins-disabled");
		expect(r.exitCode).toBe(0);
		const doc = Bun.YAML.parse(readFileSync(rendered(r.home), "utf8")) as { disabledExtensions: string[] };
		const adapters = ["ask-graham", "i-have-audhd", "paired-coding"].flatMap((p) => {
			const pkg: { omp: { extensions: string[] } } = JSON.parse(readFileSync(join(copy, "plugins", p, "package.json"), "utf8"));
			return pkg.omp.extensions.map((e) => `extension-module:${e.replace(/^.*\//, "").replace(/\.ts$/, "")}`);
		});
		expect(adapters).toEqual(["extension-module:ask-graham-omp", "extension-module:i-have-audhd-omp", "extension-module:paired-coding-omp"]);
		expect([...doc.disabledExtensions].sort()).toEqual(adapters);
	});

	test("a plugin skill row whose skills dir the config does not list is refused, nothing written", () => {
		const path = join(copy, "profile", "config.yml");
		const text = readFileSync(path, "utf8");
		const line = `    - "{repo}/plugins/ask-graham/skills"\n`;
		expect(text).toContain(line);
		writeFileSync(path, text.replace(line, ""));
		const r = install("plugins-dir-unlisted");
		writeFileSync(path, text);
		expect(r.out).toContain("skills.customDirectories must be exactly");
		expect(r.out).toContain(`${copy}/plugins/ask-graham/skills`);
		expect(r.exitCode).toBe(2);
		expect(existsSync(rendered(r.home))).toBe(false);
		expect(existsSync(r.db)).toBe(false);
	});

	test("a plugin skill whose name another skill row already has is refused, nothing written", () => {
		const from = `plugins/ask-graham/skills/ask-graham/SKILL.md${T}skill${T}-`;
		const dir = join(copy, "plugins", "ask-graham", "skills", "humanizer");
		mkdirSync(dir);
		cpSync(join(copy, "skills", "humanizer", "SKILL.md"), join(dir, "SKILL.md"));
		writeFileSync(manifest, original.replace(`${from}\n`, `${from}\nplugins/ask-graham/skills/humanizer/SKILL.md${T}skill${T}-\n`));
		const r = install("plugins-dup-name");
		writeFileSync(manifest, original);
		rmSync(dir, { recursive: true });
		expect(r.out).toContain("skill name humanizer is provided twice: plugins/ask-graham/skills/humanizer and skills/humanizer");
		expect(r.exitCode).toBe(2);
		expect(existsSync(rendered(r.home))).toBe(false);
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

	/**
	 * A fake launchctl that logs its argv. `print` answers from a flag file as launchd does (0 loaded;
	 * 113 with "Could not find service" on stderr not), as fresh-machine-test.sh step 13's does, unless
	 * `printFails` gives it another exit and stderr; `bootout` clears the flag, or exits `bootoutExit`.
	 */
	function fakeLaunchctl(name: string, loaded: boolean, opts: { printFails?: [number, string]; bootoutExit?: number } = {}): { bin: string; calls: () => string[] } {
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

	test("--train-tick=off boots out the merge train's tick by its template's label and deletes its plist, before any install step", () => {
		const tickLabel = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(REPO, "install", "com.agent-system-2.train-tick.plist"), "utf8"))?.[1] ?? "";
		expect(tickLabel).toBe("com.agent-system-2.train-tick");
		const tickService = `gui/${process.getuid?.() ?? 0}/${tickLabel}`;
		const home = join(root, "home-train-tick-off");
		const plist = join(home, "Library", "LaunchAgents", `${tickLabel}.plist`);
		mkdirSync(dirname(plist), { recursive: true });
		writeFileSync(plist, "<plist/>\n");
		const launchctl = fakeLaunchctl("train-tick-off", true);
		const r = Bun.spawnSync(["/bin/bash", join(copy, "install", "install.sh"), "--train-tick=off"], {
			env: { PATH: `${launchctl.bin}:${systemPath}`, HOME: home }, stdout: "pipe", stderr: "pipe",
		});
		const out = r.stdout.toString() + r.stderr.toString();
		expect(out).toContain(`train tick booted out: ${tickService}`);
		expect(out).toContain(`train tick removed: ${plist}`);
		expect(out).not.toContain("reading manifest");
		expect(r.exitCode).toBe(0);
		expect(existsSync(plist)).toBe(false);
	});

	test("--train-tick=off with an installing flag, or --train-tick twice, is refused with exit 2 and writes nothing", () => {
		const home = join(root, "home-train-tick-refused");
		mkdirSync(home, { recursive: true });
		for (const args of [["--train-tick=off", "--scratch-sweep"], ["--train-tick", "--train-tick=off"]]) {
			const r = Bun.spawnSync(["/bin/bash", join(copy, "install", "install.sh"), ...args], { env: { PATH: systemPath, HOME: home }, stdout: "pipe", stderr: "pipe" });
			expect(r.exitCode).toBe(2);
		}
		expect(tree(home)).toEqual([]);
	});

	test("--flow-signals=off boots out the flow-signals fallback by its template's label and deletes its plist, before any install step", () => {
		const flowLabel = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(REPO, "install", "com.agent-system-2.flow-signals.plist"), "utf8"))?.[1] ?? "";
		expect(flowLabel).toBe("com.agent-system-2.flow-signals");
		const flowService = `gui/${process.getuid?.() ?? 0}/${flowLabel}`;
		const home = join(root, "home-flow-signals-off");
		const plist = join(home, "Library", "LaunchAgents", `${flowLabel}.plist`);
		mkdirSync(dirname(plist), { recursive: true });
		writeFileSync(plist, "<plist/>\n");
		const launchctl = fakeLaunchctl("flow-signals-off", true);
		const r = Bun.spawnSync(["/bin/bash", join(copy, "install", "install.sh"), "--flow-signals=off"], {
			env: { PATH: `${launchctl.bin}:${systemPath}`, HOME: home }, stdout: "pipe", stderr: "pipe",
		});
		const out = r.stdout.toString() + r.stderr.toString();
		expect(out).toContain(`flow signals booted out: ${flowService}`);
		expect(out).toContain(`flow signals removed: ${plist}`);
		expect(out).not.toContain("reading manifest");
		expect(r.exitCode).toBe(0);
		expect(existsSync(plist)).toBe(false);
	});

	test("--flow-signals=off with an installing flag, or --flow-signals twice, is refused with exit 2 and writes nothing", () => {
		const home = join(root, "home-flow-signals-refused");
		mkdirSync(home, { recursive: true });
		for (const args of [["--flow-signals=off", "--train-tick"], ["--flow-signals", "--flow-signals=off"], ["--flow-signals", "--flow-signals"]]) {
			const r = Bun.spawnSync(["/bin/bash", join(copy, "install", "install.sh"), ...args], { env: { PATH: systemPath, HOME: home }, stdout: "pipe", stderr: "pipe" });
			expect(r.exitCode).toBe(2);
		}
		expect(tree(home)).toEqual([]);
	});
});
