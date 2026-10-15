// Guard A regression (PLAN wl-mv4yf3zgf9lm2o § 2 "Guard A regression test"): a test can never reach
// the live ledger, and one that tries fails loudly. The live ledger here is a sentinel: a temp home
// holding a v5 ledger built by ledger/scripts/init.ts. Children run fixtures/live-guard/reach.fixture.ts
// with that home as HOME, the way the 2026-10-12 incident ran with the developer's: from the repo root,
// a module root and a test dir (each preloads ledger/test/isolate-preload.ts through its bunfig.toml),
// and from a cwd with no bunfig.toml, where the run must fail closed. Afterwards the sentinel must be
// byte-identical, with the same mtime, and nothing new beside it. No real home is named or opened.
// The sentinel keeps WAL mode, as the live ledger does; Bun's SQLite on macOS leaves an empty -wal and
// a -shm after the last close (observed), so those are part of the recorded state, hashed like the file.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupNamespace, Ledger, LiveLedgerUnderTestError, SCHEMA_VERSION } from "../src/index";
import { tmpDir } from "./tmp";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "live-guard", "reach.fixture.ts");

interface SentinelState {
	/** Every entry under `<home>/.agent-system-2`, recursively. */
	entries: string[];
	/** sha256, size and mtime of every file among them. */
	files: Record<string, { sha256: string; size: number; mtimeMs: number }>;
	/** Row count per table, read from a byte copy so the sentinel itself is never opened here. */
	rows: Record<string, number>;
}

let scratch = "";
let home = "";
let liveDir = "";
let liveDb = "";
let before: SentinelState;

function sentinelState(): SentinelState {
	const entries = (readdirSync(liveDir, { recursive: true }) as string[]).sort();
	const files: SentinelState["files"] = {};
	const copyDir = mkdtempSync(join(scratch, "copy-"));
	for (const name of entries) {
		const path = join(liveDir, name);
		const st = statSync(path);
		if (!st.isFile()) continue;
		const bytes = readFileSync(path);
		files[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), size: st.size, mtimeMs: st.mtimeMs };
		// The ledger and its WAL files go to the copy the rows are counted from; anything else is only hashed.
		if (/^ledger\.db(-wal|-shm)?$/.test(name)) writeFileSync(join(copyDir, name), bytes);
	}
	const db = new Database(join(copyDir, "ledger.db"));
	const rows: Record<string, number> = {};
	try {
		for (const { name } of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
			rows[name] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get()!.n;
		}
	} finally {
		db.close();
	}
	return { entries, files, rows };
}

/** `bun test <fixture>` from `cwd` with a scratch env whose HOME is the sentinel home. */
function runFixture(cwd: string, extra: Record<string, string>): { exitCode: number; out: string } {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...extra };
	// Temp files go where this run's go (the fence and the as2test runner both set TMPDIR).
	if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
	const r = Bun.spawnSync([process.execPath, "test", FIXTURE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	return { exitCode: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

beforeAll(() => {
	scratch = tmpDir("live-guard-");
	home = join(scratch, "sentinel-home");
	liveDir = join(home, ".agent-system-2");
	liveDb = join(liveDir, "ledger.db");
	mkdirSync(home);
	// Both run as their own process with a scratch env (no NODE_ENV, so no guard), as a live tool would.
	const sentinelEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
	const init = Bun.spawnSync([process.execPath, join(REPO, "ledger", "scripts", "init.ts"), liveDb], { env: sentinelEnv, stdout: "pipe", stderr: "pipe" });
	expect({ exitCode: init.exitCode, out: init.stdout.toString(), err: init.stderr.toString() }).toMatchObject({ exitCode: 0, out: expect.stringContaining(`schema_version=${SCHEMA_VERSION}`) });
	const write = Bun.spawnSync([process.execPath, "-e", `
		import { Ledger } from ${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))};
		const l = Ledger.open(${JSON.stringify(liveDb)}, { backup: false });
		const wl = l.openWorkload({ brief: "sentinel: the live ledger stand-in", stakes: "normal", mode: "autonomous", by: "live-guard" });
		l.addSlice({ workloadId: wl, task: "stay unchanged", doneCondition: "byte-identical", inputs: "none", by: "live-guard" });
		l.close();
	`], { env: sentinelEnv, stdout: "pipe", stderr: "pipe" });
	expect({ exitCode: write.exitCode, err: write.stderr.toString() }).toEqual({ exitCode: 0, err: "" });
	// Fold the WAL back in, so the main file holds every row and any -wal left behind is empty.
	const db = new Database(liveDb);
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
	before = sentinelState();
	expect(before.entries.filter((e) => e !== "ledger.db-wal" && e !== "ledger.db-shm")).toEqual(["ledger.db"]); // no backups/
	expect(before.files["ledger.db-wal"]?.size ?? 0).toBe(0);
	expect(before.rows.workloads).toBe(1);
	expect(before.rows.slices).toBe(1);
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("Guard A: a test run never reaches the live ledger", () => {
	for (const rel of [".", "ledger", join("ledger", "test")]) {
		test(`isolated from cwd ${rel}: the default ledger is a temp one and every live reach is refused`, () => {
			const r = runFixture(join(REPO, rel), { AS2_TEST_LIVE_ROOTS: liveDir });
			expect({ exitCode: r.exitCode, out: r.out }).toMatchObject({ exitCode: 0 });
			for (const want of [
				"live-guard mode=isolated",
				"(a) wrote wl-",
				"(c) refused: LiveLedgerUnderTestError",
				"(d) refused: LiveLedgerUnderTestError",
				"(e) refused: exit",
				"(f) refused: exit",
				" 0 fail",
			]) {
				expect(r.out).toContain(want);
			}
		}, 60_000);
	}

	test("from a cwd with no bunfig.toml the run is not isolated and fails closed on its own HOME", () => {
		const cwd = mkdtempSync(join(scratch, "no-bunfig-"));
		// No AS2_TEST_LIVE_ROOTS: only the fail-closed rule stands between this run and the sentinel.
		const r = runFixture(cwd, {});
		expect({ exitCode: r.exitCode, out: r.out }).toMatchObject({ exitCode: 0 });
		for (const want of [
			"live-guard mode=fail-closed",
			"(a) refused: LiveLedgerUnderTestError",
			"(b) refused: LiveLedgerUnderTestError",
			"(c) refused: LiveLedgerUnderTestError",
			"(d) refused: LiveLedgerUnderTestError",
			"(e) refused: exit",
			"(f) refused: exit",
			" 0 fail",
		]) {
			expect(r.out).toContain(want);
		}
	}, 60_000);

	test("not isolated, the process's own ledger override counts as live even outside its HOME", () => {
		// The sentinel ledger named by AGENT_SYSTEM_LEDGER_DB, with HOME elsewhere: NODE_ENV=test and no preload marker.
		const otherHome = mkdtempSync(join(scratch, "other-home-"));
		const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: otherHome, NODE_ENV: "test", AGENT_SYSTEM_LEDGER_DB: liveDb };
		if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
		const src = `import { defaultLedgerPath } from ${JSON.stringify(join(REPO, "ledger", "src", "locality.ts"))}; console.log(defaultLedgerPath());`;
		const r = Bun.spawnSync([process.execPath, "-e", src], { cwd: otherHome, env, stdout: "pipe", stderr: "pipe" });
		expect({ exitCode: r.exitCode, out: r.stdout.toString() }).toEqual({ exitCode: 1, out: "" });
		expect(r.stderr.toString()).toContain("LiveLedgerUnderTestError");
	});

	test("a backup directory or its SOURCE file linked into a live root fails the open, and a direct backup there is refused, before anything is written", () => {
		// Canonical, as Ledger.open names the namespace after the path it resolved (/var is /private/var on macOS).
		const src = join(realpathSync(mkdtempSync(join(scratch, "bk-src-"))), "ledger.db");
		Ledger.open(src, { create: true, backup: false }).close();
		const root = mkdtempSync(join(scratch, "bk-root-"));
		symlinkSync(liveDir, join(root, backupNamespace(src)));
		const was = process.env.AS2_TEST_LIVE_ROOTS;
		process.env.AS2_TEST_LIVE_ROOTS = liveDir;
		try {
			expect(() => Ledger.open(src, { backup: { dir: root } })).toThrow(LiveLedgerUnderTestError);
			// A real namespace whose SOURCE links into the live root: to a file there (read) and to a missing one (written).
			for (const linkTo of [liveDb, join(liveDir, "SOURCE")]) {
				const safeRoot = mkdtempSync(join(scratch, "bk-root-"));
				const ns = join(safeRoot, backupNamespace(src));
				mkdirSync(ns);
				symlinkSync(linkTo, join(ns, "SOURCE"));
				expect(() => Ledger.open(src, { backup: { dir: safeRoot } })).toThrow(LiveLedgerUnderTestError);
			}
			const l = Ledger.open(src, { backup: false });
			try {
				expect(() => l.backup(join(liveDir, "direct.db"))).toThrow(LiveLedgerUnderTestError);
			} finally {
				l.close();
			}
		} finally {
			if (was === undefined) delete process.env.AS2_TEST_LIVE_ROOTS;
			else process.env.AS2_TEST_LIVE_ROOTS = was;
		}
		// The next test checks the sentinel holds nothing new: no SOURCE, no snapshot, no temp file.
	});

	test("the sentinel is byte-identical, with the same mtime and nothing new beside it", () => {
		expect(existsSync(liveDb)).toBe(true);
		expect(sentinelState()).toEqual(before);
	});
});
