// ledger/scripts/restore.ts (audit finding A7-1): backup -> more writes -> restore -> inFlight() shows
// the copy's state, the live files are moved aside (never deleted), the writes lost are counted, and
// the printed undo puts the moved-aside ledger back. Refusals change nothing. A failure at any step
// prints an undo that, run, puts back exactly the original files; a holder probe that could not look
// everywhere refuses.
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/index";
import { holders, lossLines, restore, RestoreRefused, type HolderSys, type RestoreDeps } from "../scripts/restore";

const SQLITE3 = existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
const SCRIPT = join(import.meta.dir, "..", "scripts", "restore.ts");

const scratch = (label: string) => mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), `ledger-restore-${label}-`));
const NOW = new Date("2026-10-12T06:00:00.000Z");
const STAMP = "2026-10-12T06-00-00.000Z";

function deps(writers: RestoreDeps["writers"] = () => ({ found: [] })) {
	const lines: string[] = [];
	const ran: string[] = [];
	const d: RestoreDeps = { writers, invariants: (p) => (ran.push(p), 0), now: () => NOW, log: (l) => lines.push(l) };
	return { d, lines, ran };
}

/** A ledger with workload `kept`, a scheduled copy of it, then workload `lost` written after the copy. */
function ledgerWithCopy(label: string) {
	const dir = scratch(label);
	const path = join(dir, "ledger.db");
	const l = Ledger.open(path, { create: true });
	const kept = l.openWorkload({ brief: "in the copy", stakes: "normal", mode: "autonomous", by: "orch-1" });
	const copy = l.backupIfDue(true)!;
	const lost = l.openWorkload({ brief: "after the copy", stakes: "normal", mode: "autonomous", by: "orch-1" });
	l.close();
	return { dir, path, copy, kept, lost };
}

const ids = (path: string) => {
	const l = Ledger.open(path, { backupOnOpen: false });
	try {
		return l.inFlight().map((w) => w.workload.id).sort();
	} finally {
		l.close();
	}
};

describe("restore: round trip", () => {
	test("backup -> restore -> inFlight() is the copy's; the live files are moved aside; lost writes, invariants and undo are printed", () => {
		const { dir, path, copy, kept, lost } = ledgerWithCopy("round-trip");
		expect(ids(path)).toEqual([kept, lost].sort());
		const { d, lines, ran } = deps();
		const r = restore(copy, path, d);

		expect(ids(path)).toEqual([kept]);
		expect(r.target).toBe(realpathSync(path));
		expect(r.aside).toBe(`${r.target}.pre-restore-${STAMP}`);
		expect(r.moved).toContain("");
		expect(ids(r.aside)).toEqual([kept, lost].sort()); // moved aside, intact
		expect(lines.find((l) => l.startsWith("opened with Ledger.open:"))).toBe("opened with Ledger.open: journal_mode wal, 1 open workload(s)");
		expect(lines).toContain(`restored: ${realpathSync(copy)} -> ${r.target}`);
		expect(lines.find((l) => l.startsWith("  rows inserted after the copy"))).toBe("  rows inserted after the copy, missing from the restored ledger: workloads 1");
		expect(lines.find((l) => l.startsWith("  updates after the copy"))).toBe("  updates after the copy, reverted in the restored ledger: none");
		expect(ran).toEqual([r.target]);
		expect(existsSync(copy)).toBe(true); // the copy itself is untouched
		expect(readdirSync(dir).filter((n) => n.includes(".restore-"))).toEqual([]); // no temporary file left

		// The printed undo puts the moved-aside ledger back and keeps the restored one.
		const undo = lines.slice(lines.indexOf("undo:") + 1).join("\n");
		const sh = Bun.spawnSync(["sh", "-c", undo]);
		expect(sh.exitCode).toBe(0);
		expect(ids(path)).toEqual([kept, lost].sort());
		expect(ids(`${path}.restored-${STAMP}`)).toEqual([kept]);
	});

	test("a stopped ledger whose -wal and -shm are gone (smoke on a copy of the live ledger, 2026-10-12) still has its lost writes counted", () => {
		const { path, copy } = ledgerWithCopy("no-wal");
		// What a non-Bun last closer (the sqlite3 CLI) leaves: everything checkpointed, no -wal or -shm beside the file.
		expect(Bun.spawnSync([SQLITE3, path, "PRAGMA wal_checkpoint(TRUNCATE);"]).exitCode).toBe(0);
		for (const s of ["-wal", "-shm"]) renameSync(path + s, `${path}${s}.gone`);
		// A fresh process, as the CLI is: this process's own earlier connections can mask the failure.
		const run = (code: string) => Bun.spawnSync(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
		const plain = run(`import { Database } from "bun:sqlite"; new Database(${JSON.stringify(path)}, { readonly: true }).query("SELECT 1").get();`);
		expect(plain.stderr.toString()).toContain("unable to open database file");
		const r = run(`
			import { restore } from ${JSON.stringify(SCRIPT)};
			restore(${JSON.stringify(copy)}, ${JSON.stringify(path)}, { writers: () => ({ found: [] }), invariants: () => 0, now: () => new Date(), log: (l) => console.log(l) });
		`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.toString().split("\n");
		expect(lines.find((l) => l.startsWith("writes lost:"))).not.toContain("unknown");
		expect(lines.find((l) => l.startsWith("  rows inserted after the copy"))).toContain("workloads 1");
	});
});

describe("restore: refusals change nothing", () => {
	const unchanged = (dir: string, before: string[]) => expect(readdirSync(dir).sort()).toEqual(before);

	test("a running writer refuses and names it; a probe that could not look refuses too", () => {
		const { dir, path, copy, kept, lost } = ledgerWithCopy("writers");
		const before = readdirSync(dir).sort();
		expect(() => restore(copy, path, deps(() => ({ found: ["lane: surface/scripts/lane.ts run wl-x wl-x-lane-1"] })).d))
			.toThrow(/writers are running[^]*lane\.ts run wl-x wl-x-lane-1/);
		expect(() => restore(copy, path, deps(() => ({ skipped: "pgrep is not available on this machine" })).d))
			.toThrow("could not check for running writers (pgrep is not available on this machine)");
		unchanged(dir, before);
		expect(ids(path)).toEqual([kept, lost].sort());
	});

	test("a backup that is not a complete copy, or is the ledger itself, refuses before the process check", () => {
		const { dir, path } = ledgerWithCopy("bad-copy");
		const empty = join(dir, "empty.db");
		writeFileSync(empty, "");
		const before = readdirSync(dir).sort();
		let probed = false;
		const d = deps(() => ((probed = true), { found: [] })).d;
		expect(() => restore(empty, path, d)).toThrow(RestoreRefused);
		expect(() => restore(empty, path, d)).toThrow("is not a complete copy of a ledger (empty file)");
		expect(() => restore(path, path, d)).toThrow("is the ledger itself");
		expect(() => restore(join(dir, "missing.db"), path, d)).toThrow("no backup at");
		expect(probed).toBe(false);
		unchanged(dir, before);
	});

	test("the CLI: usage and a bad backup exit 2 with nothing changed", () => {
		const { dir, path } = ledgerWithCopy("cli");
		const empty = join(dir, "empty.db");
		writeFileSync(empty, "");
		const before = readdirSync(dir).sort();
		const script = join(import.meta.dir, "..", "scripts", "restore.ts");
		const usage = Bun.spawnSync(["bun", "run", script]);
		expect(usage.exitCode).toBe(2);
		expect(usage.stderr.toString()).toContain("usage: bun run ledger/scripts/restore.ts <backup> [ledger]");
		const bad = Bun.spawnSync(["bun", "run", script, empty, path]);
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr.toString()).toContain("ledger restore refused:");
		unchanged(dir, before);
		expect(readFileSync(empty, "utf8")).toBe("");
	});
});

const SUFFIXES = ["", "-wal", "-shm"] as const;
const brief = (b: string) => ({ brief: b, stakes: "normal" as const, mode: "autonomous" as const, by: "orch-1" });

/**
 * Like `ledgerWithCopy`, but `lost` is only in the ledger's -wal: the three files are copied while
 * the writer is still open (as a crash leaves them), so putting the main file back without its own
 * -wal loses `lost`.
 */
function ledgerWithWalOnlyWrite(label: string) {
	const src = join(scratch(`${label}-src`), "ledger.db");
	const l = Ledger.open(src, { create: true });
	l.db.run("PRAGMA wal_autocheckpoint = 0");
	const kept = l.openWorkload(brief("in the copy"));
	const copy = l.backupIfDue(true)!;
	const lost = l.openWorkload(brief("after the copy, only in the -wal"));
	const dir = scratch(label);
	const path = join(dir, "ledger.db");
	for (const s of SUFFIXES) copyFileSync(src + s, path + s);
	l.close();
	// The fixture is what it says: the main file alone does not hold `lost` (here it holds no schema at all).
	const mainOnly = join(scratch(`${label}-main-only`), "ledger.db");
	copyFileSync(path, mainOnly);
	const db = new Database(mainOnly);
	const table = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'workloads'").get()!.n;
	expect(table && db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM workloads WHERE id = ?").get(lost)!.n).toBe(0);
	db.close();
	return { dir, path, copy, kept, lost };
}

const errorOf = (f: () => unknown): Error => {
	try {
		f();
	} catch (e) {
		return e as Error;
	}
	throw new Error("expected a failure");
};

describe("restore: a failure partway prints an undo that puts back exactly the original files", () => {
	const cases = [
		{ step: 1, what: "moving the main file aside" },
		{ step: 2, what: "moving the -wal aside" },
		{ step: 3, what: "moving the -shm aside" },
		{ step: 4, what: "renaming the checked copy into place" },
	];
	for (const { step, what } of cases) {
		test(`a failure ${what} (rename ${step}): running the printed undo restores the original main file and its own -wal, data intact`, () => {
			const { dir, path, copy, kept, lost } = ledgerWithWalOnlyWrite(`fail-${step}`);
			const bytes = (p: string) => [readFileSync(p), readFileSync(`${p}-wal`)];
			const original = bytes(path);
			const names = readdirSync(dir).sort();
			let n = 0;
			const { d } = deps();
			d.rename = (from, to) => {
				if (++n === step) throw new Error(`injected failure at rename ${step}`);
				renameSync(from, to);
			};
			const err = errorOf(() => restore(copy, path, d));
			expect(err).not.toBeInstanceOf(RestoreRefused);
			expect(err.message).toContain(`injected failure at rename ${step}`);
			if (step === 1) expect(err.message).not.toContain("undo:"); // nothing moved, nothing to undo
			else {
				const undo = err.message.slice(err.message.indexOf("\nundo:\n") + "\nundo:\n".length);
				expect(undo).not.toContain(".restored-"); // nothing was installed, so nothing is set aside
				const sh = Bun.spawnSync(["sh", "-c", undo]);
				expect([sh.exitCode, sh.stderr.toString()]).toEqual([0, ""]);
			}
			expect(readdirSync(dir).sort()).toEqual(names); // no aside, restored-aside or temporary file left
			expect(bytes(path)).toEqual(original);
			expect(ids(path)).toEqual([kept, lost].sort());
		});
	}

	test("a failure after the copy is installed and opened: the undo sets the restored main, -wal and -shm aside and puts the originals back", () => {
		const { dir, path, copy, kept, lost } = ledgerWithWalOnlyWrite("fail-after-install");
		const original = [readFileSync(path), readFileSync(`${path}-wal`)];
		const { d } = deps();
		d.log = (line) => {
			if (line.startsWith("opened with Ledger.open")) throw new Error("injected failure after the install");
		};
		const err = errorOf(() => restore(copy, path, d));
		const undo = err.message.slice(err.message.indexOf("\nundo:\n") + "\nundo:\n".length);
		const sh = Bun.spawnSync(["sh", "-c", undo]);
		expect([sh.exitCode, sh.stderr.toString()]).toEqual([0, ""]);
		const target = realpathSync(path);
		for (const s of SUFFIXES) expect(existsSync(`${target}.restored-${STAMP}${s}`)).toBe(true);
		expect(readdirSync(dir).filter((n) => n.includes(".pre-restore-"))).toEqual([]);
		expect([readFileSync(path), readFileSync(`${path}-wal`)]).toEqual(original);
		expect(ids(path)).toEqual([kept, lost].sort());
		expect(ids(`${target}.restored-${STAMP}`)).toEqual([kept]);
	});

	test("the undo stops at a name that is taken and replaces nothing", () => {
		const { path, copy } = ledgerWithWalOnlyWrite("fail-taken");
		let n = 0;
		const { d } = deps();
		d.rename = (from, to) => {
			if (++n === 2) throw new Error("injected failure at rename 2");
			renameSync(from, to);
		};
		const err = errorOf(() => restore(copy, path, d));
		writeFileSync(path, "a writer started meanwhile");
		const sh = Bun.spawnSync(["sh", "-c", err.message.slice(err.message.indexOf("\nundo:\n") + "\nundo:\n".length)]);
		expect(sh.exitCode).toBe(1);
		expect(sh.stderr.toString()).toContain(`undo stopped: ${realpathSync(path)} exists`);
		expect(readFileSync(path, "utf8")).toBe("a writer started meanwhile");
		expect(existsSync(`${realpathSync(path)}.pre-restore-${STAMP}`)).toBe(true);
	});
});

describe("restore: the writes lost are every provenance row the restored copy lacks", () => {
	const lossOf = (lines: string[]) => lines.filter((l) => l.startsWith("writes lost:") || l.startsWith("  "));

	test("an update-only interval: the reverted update is counted, no insert is", () => {
		const { path } = ledgerWithCopy("update-only");
		const l = Ledger.open(path, { backupOnOpen: false });
		const w = l.openWorkload(brief("closed after the copy"));
		const copy = l.backupIfDue(true)!;
		l.closeWorkload(w, { by: "orch-1" });
		l.close();
		const { d, lines } = deps();
		restore(copy, path, d);
		expect(lossOf(lines)).toEqual([
			expect.stringMatching(/^writes lost: 1 of the moved-aside ledger's 4 provenance row\(s\) are not in the restored copy \(moved-aside newest seq 4 at .*; restored newest seq 3 at .*\)$/),
			"  rows inserted after the copy, missing from the restored ledger: none",
			"  updates after the copy, reverted in the restored ledger: workloads 1 row(s), 1 update(s)",
		]);
		expect(ids(path)).toContain(w);
	});

	test("an insert stamped the same instant as the copy's newest row is counted", () => {
		const dir = scratch("same-instant");
		const path = join(dir, "ledger.db");
		const l = Ledger.open(path, { create: true, clock: () => "2026-10-12T05:00:00.000Z" });
		l.openWorkload(brief("in the copy"));
		const copy = l.backupIfDue(true)!;
		const lost = l.openWorkload(brief("same instant, after the copy"));
		l.close();
		const { d, lines } = deps();
		restore(copy, path, d);
		expect(lines).toContain("  rows inserted after the copy, missing from the restored ledger: workloads 1");
		expect(ids(path)).not.toContain(lost);
	});

	test("an empty restored copy is named as one, and every write is counted lost", () => {
		const dir = scratch("empty-copy");
		const path = join(dir, "ledger.db");
		const l = Ledger.open(path, { create: true });
		const copy = l.backupIfDue(true)!;
		l.openWorkload(brief("one"));
		l.openWorkload(brief("two"));
		l.close();
		const { d, lines } = deps();
		restore(copy, path, d);
		expect(lossOf(lines)).toEqual([
			expect.stringMatching(/^writes lost: 2 of the moved-aside ledger's 2 provenance row\(s\) are not in the restored copy \(moved-aside newest seq 2 at \S+; restored newest none\)$/),
			"  the restored copy is empty: it holds no writes at all",
			"  rows inserted after the copy, missing from the restored ledger: workloads 2",
			"  updates after the copy, reverted in the restored ledger: none",
		]);
		expect(ids(path)).toEqual([]);
	});

	test("a copy holding writes the moved-aside ledger lacks is reported as not an earlier copy of it", () => {
		const w = (seq: number, row: string) => ({ seq, at: "2026-10-12T05:00:00.000Z", tbl: "workloads", row_id: row, action: "insert" });
		expect(lossLines([w(1, "a")], [w(1, "a"), w(2, "b")])).toEqual([
			"writes lost: 0 of the moved-aside ledger's 1 provenance row(s) are not in the restored copy (moved-aside newest seq 1 at 2026-10-12T05:00:00.000Z; restored newest seq 2 at 2026-10-12T05:00:00.000Z)",
			"  rows inserted after the copy, missing from the restored ledger: none",
			"  updates after the copy, reverted in the restored ledger: none",
			"  the restored copy holds 1 write(s) the moved-aside ledger does not: it is not an earlier copy of this ledger",
		]);
	});
});

describe("holders: only a complete look passes; anything not inspected refuses", () => {
	const FILE = "/ledger-dir/ledger.db";
	const fsError = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
	const lsof = (exitCode: number | null, stdout: string, stderr = "") => {
		const argv: string[][] = [];
		const sys: HolderSys = {
			which: (c) => (c === "lsof" ? "/usr/sbin/lsof" : null),
			run: (a) => (argv.push(a), { exitCode, stdout, stderr }),
			exists: () => false,
			readdir: () => [],
			readlink: () => "",
		};
		return { sys, argv };
	};
	/** A /proc with the given pids: `fd` gives each pid's fd listing (or throws), `link` each fd's target (or throws). */
	const proc = (pids: Record<string, { gone?: boolean; fd: () => string[]; link?: (fd: string) => string }>): HolderSys => ({
		which: () => null,
		run: () => {
			throw new Error("no command runs on the /proc path");
		},
		exists: (p) => p === "/proc/self/fd" || (p.startsWith("/proc/") && pids[p.slice(6)] !== undefined && !pids[p.slice(6)]!.gone),
		readdir: (p) => (p === "/proc" ? ["self", ...Object.keys(pids)] : pids[p.split("/")[2]!]!.fd()),
		readlink: (p) => pids[p.split("/")[2]!]!.link!(p.split("/")[4]!),
	});

	test("lsof: holders found, or exit 1 with nothing on stdout and stderr, are a complete look; warnings are asked for", () => {
		const held = lsof(0, "123\n456\n");
		expect(holders([FILE], held.sys)).toEqual({ found: ["pid 123 holds the ledger (lsof)", "pid 456 holds the ledger (lsof)"] });
		expect(held.argv).toEqual([["lsof", "-t", "+w", "--", FILE]]);
		expect(holders([FILE], lsof(1, "").sys)).toEqual({ found: [] });
	});

	test("lsof: a diagnostic on exit 1, exit 0 with no pid, or any other exit is a look that failed", () => {
		expect(holders([FILE], lsof(1, "", "lsof: WARNING: can't stat() nfs file system /net").sys))
			.toEqual({ skipped: "lsof exited 1 with 0 pid(s): lsof: WARNING: can't stat() nfs file system /net" });
		expect(holders([FILE], lsof(0, "").sys)).toEqual({ skipped: "lsof exited 0 with 0 pid(s): no diagnostic" });
		expect(holders([FILE], lsof(null, "", "killed").sys)).toEqual({ skipped: "lsof exited null with 0 pid(s): killed" });
	});

	test("/proc: a live process whose fds cannot be read refuses; one that is gone is passed over", () => {
		expect(holders([FILE], proc({ "1": { fd: () => { throw fsError("EACCES"); } } })))
			.toEqual({ skipped: "could not read /proc/1/fd (EACCES); that process may hold the ledger" });
		expect(holders([FILE], proc({ "42": { gone: true, fd: () => { throw fsError("ENOENT"); } } }))).toEqual({ found: [] });
		// ENOENT while /proc/<pid> is still there is not a confirmed exit.
		expect(holders([FILE], proc({ "42": { fd: () => { throw fsError("ENOENT"); } } })))
			.toEqual({ skipped: "could not read /proc/42/fd (ENOENT); that process may hold the ledger" });
	});

	test("/proc: an fd that closed after the listing is passed over; an fd that cannot be read refuses; a holder is found", () => {
		const fds = () => ["0", "3"];
		expect(holders([FILE], proc({ "7": { fd: fds, link: (fd) => { if (fd === "3") throw fsError("ENOENT"); return "/dev/null"; } } }))).toEqual({ found: [] });
		expect(holders([FILE], proc({ "7": { fd: fds, link: (fd) => { if (fd === "3") throw fsError("EACCES"); return "/dev/null"; } } })))
			.toEqual({ skipped: "could not read /proc/7/fd/3 (EACCES); that process may hold the ledger" });
		expect(holders([FILE], proc({ "7": { fd: fds, link: (fd) => (fd === "3" ? FILE : "/dev/null") } }))).toEqual({ found: ["pid 7 holds the ledger (/proc/7/fd)"] });
	});

	test("neither lsof nor /proc: refuses", () => {
		const none: HolderSys = { which: () => null, run: () => ({ exitCode: 0, stdout: "", stderr: "" }), exists: () => false, readdir: () => [], readlink: () => "" };
		expect(holders([FILE], none)).toEqual({ skipped: "neither lsof nor /proc is available to see which processes hold the ledger" });
	});

	test("restore refuses on an incomplete look before any ledger file moves", () => {
		const { dir, path, copy, kept, lost } = ledgerWithCopy("probe-refusal");
		const before = readdirSync(dir).sort();
		const unreadable = proc({ "1": { fd: () => { throw fsError("EACCES"); } } });
		expect(() => restore(copy, path, deps((p) => holders([p], unreadable)).d))
			.toThrow("could not check for running writers (could not read /proc/1/fd (EACCES); that process may hold the ledger); nothing changed");
		expect(() => restore(copy, path, deps((p) => holders([p], lsof(1, "", "lsof: WARNING: can't stat()").sys)).d)).toThrow(RestoreRefused);
		expect(readdirSync(dir).sort()).toEqual(before);
		expect(ids(path)).toEqual([kept, lost].sort());
	});

	test.skipIf(!Bun.which("lsof"))("the real lsof: a process holding the file is found; nothing holding it is a complete empty look", async () => {
		const dir = scratch("real-lsof");
		const file = join(dir, "held.db");
		const free = join(dir, "free.db");
		writeFileSync(file, "x");
		writeFileSync(free, "x");
		// The child opens the file on fd 3, says so, then becomes `sleep` (same pid, fd 3 still open).
		const child = Bun.spawn(["sh", "-c", 'exec 3<"$1"; echo ready; exec sleep 30', "sh", file], { stdout: "pipe" });
		try {
			const reader = child.stdout.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
			reader.releaseLock();
			expect(holders([realpathSync(file)])).toEqual({ found: [`pid ${child.pid} holds the ledger (lsof)`] });
			expect(holders([realpathSync(free)])).toEqual({ found: [] });
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
