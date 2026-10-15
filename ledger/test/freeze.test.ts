// Schema version 6 (migration/items/ledger-freeze-and-drift.md, ledger audit A3-1, A2-3, A2-4, A5-1, A1-1): final states
// are final, a stakes change needs its instruction, the standing workload never closes, a file whose
// trigger set drifted is refused at open, connections run at synchronous = FULL, and a version-5
// file is upgraded only by the explicit migrate command, never by opening it. Every probe shape runs
// twice: against the version-5 module and schema (commit V5, read out of git) where the gap was real,
// and against this checkout's, where it is shut.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	copyProblem, expectedTriggers, Ledger, LedgerNeedsMigrationError, LedgerTriggerDriftError, migrateLedger, MIGRATIONS, SCHEMA_PATH,
	SCHEMA_VERSION, schemaBody, triggerDrift,
} from "../src/index";

const REPO = join(import.meta.dir, "..", "..");
const SQLITE3 = "/usr/bin/sqlite3";
/** origin/main when version 6 was written: the module and schema at version 5. */
const V5 = "e472070";
const scratch = (label: string) => mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), `ledger-freeze-${label}-`));

function sqlite(path: string, sql: string): { exitCode: number | null; out: string; err: string } {
	const r = Bun.spawnSync([SQLITE3, "-batch", "-bail", path], { stdin: Buffer.from(sql), stdout: "pipe", stderr: "pipe" });
	return { exitCode: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

function gitShow(path: string): string {
	const r = Bun.spawnSync(["git", "-C", REPO, "show", `${V5}:${path}`], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git show ${V5}:${path}: ${r.stderr.toString()}`);
	return r.stdout.toString();
}

/** The version-5 ledger module (index.ts, locality.ts, schema.sql at V5) laid out in a scratch directory; returns its index.ts. */
function v5Module(): string {
	const root = scratch("v5-module");
	mkdirSync(join(root, "ledger", "src"), { recursive: true });
	for (const f of ["ledger/src/index.ts", "ledger/src/locality.ts", "ledger/schema.sql"]) writeFileSync(join(root, f), gitShow(f));
	return join(root, "ledger", "src", "index.ts");
}

function runProbes(modulePath: string): Record<string, string> {
	const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "final-state-probes.ts"), modulePath, scratch("probes")], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`probes exited ${r.exitCode}: ${r.stderr.toString()}`);
	return JSON.parse(r.stdout.toString());
}

/** The upgrade with no snapshot, for files the test made and throws away. */
const migrated = (path: string) => migrateLedger(path, { snapshot: false, skipLocalityCheck: true });

/** `bun run ledger/scripts/<name> ...args`, with the environment as given. */
function script(name: string, ...args: string[]): { exitCode: number | null; out: string; err: string } {
	const r = Bun.spawnSync(["bun", "run", join(REPO, "ledger", "scripts", name), ...args], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/**
 * `bun run ledger/scripts/migrate.ts <path> ...flags` with `typed` on stdin: by default the
 * confirmation word a real run waits for; null gives it no input at all (end of input at once).
 */
function migrateScript(path: string, { flags = [], typed = "MIGRATE\n", env = process.env }: { flags?: string[]; typed?: string | null; env?: Record<string, string | undefined> } = {}): { exitCode: number | null; out: string; err: string } {
	const r = Bun.spawnSync(["bun", "run", join(REPO, "ledger", "scripts", "migrate.ts"), path, ...flags], {
		stdin: typed === null ? "ignore" : new Blob([typed]), stdout: "pipe", stderr: "pipe", env,
	});
	return { exitCode: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** The ledger file's bytes plus every name in its directory: what a refusal must leave exactly as found. */
const bytes = (path: string) => `${readdirSync(dirname(path)).sort().join(",")}:${Bun.hash(readFileSync(path))}`;

/** Run the undo line migrate.ts printed, exactly as printed, through `shell`. */
function runUndo(out: string, shell = "/bin/zsh"): { exitCode: number | null; err: string } {
	const line = out.match(/^undo, lossless \(keeps every row written since\): (sqlite3 .+)$/m)?.[1];
	expect(line).toBeDefined();
	const r = Bun.spawnSync([shell, "-c", line!], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: r.exitCode, err: r.stderr.toString().trim() };
}

const T0 = "'2026-10-12T00:00:00.000Z'";
const STAMPS = `'seed', ${T0}, 'seed', ${T0}`;
/** Rows in every final state, plus the standing workload, written as raw SQL so the same seed fits version 5 and 6. */
const SEED = `
INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES
  ('wl-orchestrator', 'standing', 'throwaway', 'autonomous', ${STAMPS}),
  ('wl-a', 'a', 'normal', 'autonomous', ${STAMPS}),
  ('wl-closed', 'closed', 'normal', 'autonomous', ${STAMPS});
INSERT INTO slices (id, workload_id, task, done_condition, inputs, created_by, created_at, changed_by, changed_at) VALUES
  ('sl-done', 'wl-a', 't', 'd', 'i', ${STAMPS}), ('sl-cancelled', 'wl-a', 't', 'd', 'i', ${STAMPS});
UPDATE slices SET state = 'done', artifact = 'bun test exit 0 (real run)', changed_by = 'lane-x', rev = rev + 1 WHERE id = 'sl-done';
UPDATE slices SET state = 'cancelled', changed_by = 'lane-x', rev = rev + 1 WHERE id = 'sl-cancelled';
INSERT INTO messages (id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) VALUES
  ('msg-a', 'wl-a', 'lane-x', 'orchestrator', 'hi', ${STAMPS});
UPDATE messages SET state = 'delivered', changed_by = 'surface', rev = rev + 1 WHERE id = 'msg-a';
UPDATE messages SET state = 'consumed', changed_by = 'surface', rev = rev + 1 WHERE id = 'msg-a';
UPDATE messages SET state = 'acted-on', changed_by = 'surface', rev = rev + 1 WHERE id = 'msg-a';
UPDATE workloads SET status = 'closed', closed_at = ${T0}, changed_by = 'seed', rev = rev + 1 WHERE id = 'wl-closed';
`;
const T1 = "'2026-10-12T01:00:00.000Z'";
/** The audit's probe shapes as the exact UPDATE each module method runs (ledger/src/index.ts), on the seeded rows. */
const SHAPES: [string, string][] = [
	["complete a done slice again", `UPDATE slices SET state = 'done', artifact = 'forged: tests passed', changed_by = 'lane-y', changed_at = max(changed_at, ${T1}), rev = rev + 1 WHERE id = 'sl-done';`],
	["cancel a cancelled slice again", `UPDATE slices SET state = 'cancelled', artifact = NULL, changed_by = 'lane-y', changed_at = max(changed_at, ${T1}), rev = rev + 1 WHERE id = 'sl-cancelled';`],
	["re-advance an acted-on message", `UPDATE messages SET state = 'acted-on', changed_by = 'lane-z', changed_at = max(changed_at, ${T1}), rev = rev + 1 WHERE id = 'msg-a';`],
	["set stakes on a closed workload", `UPDATE workloads SET stakes = 'throwaway', changed_by = 'lane-z', changed_at = max(changed_at, ${T1}), rev = rev + 1 WHERE id = 'wl-closed';`],
	["set stakes with no instruction", `UPDATE workloads SET stakes = 'production', changed_by = 'lane-x', changed_at = max(changed_at, ${T1}), rev = rev + 1 WHERE id = 'wl-a';`],
	["close the standing workload", `UPDATE workloads SET status = 'closed', closed_at = max(changed_at, ${T1}), holder = NULL, holder_lease_until = NULL, changed_by = 'lane-z', changed_at = max(changed_at, ${T1}), rev = rev + 1 WHERE id = 'wl-orchestrator';`],
];
const REFUSALS: Record<string, string> = {
	"complete a done slice again": "a done or cancelled slice is final: nothing on it changes, its artifact included",
	"cancel a cancelled slice again": "a done or cancelled slice is final: nothing on it changes, its artifact included",
	"re-advance an acted-on message": "an acted-on message is final: nothing on it changes",
	"set stakes on a closed workload": "a closed workload is final: nothing on it changes",
	"set stakes with no instruction": 'a stakes change needs a "stakes: <stakes>" instruction recorded since the last workload change',
	"close the standing workload": "the standing workload wl-orchestrator is never closed",
};

/** A version-5 ledger built from V5's schema.sql with the sqlite3 CLI, seeded with SEED. */
function v5Ledger(label: string): string {
	const path = join(scratch(label), "ledger.db");
	const built = sqlite(path, gitShow("ledger/schema.sql"));
	expect(built.err).toBe("");
	expect(sqlite(path, SEED).err).toBe("");
	expect(sqlite(path, "PRAGMA user_version;").out).toBe("5");
	return path;
}

/** user_version, every schema object with its text, and every row the seed wrote: what an untouched file keeps. */
const state = (path: string) => sqlite(path, `PRAGMA user_version; SELECT type, name, sql FROM sqlite_master ORDER BY name;
	SELECT * FROM workloads ORDER BY id; SELECT * FROM slices ORDER BY id; SELECT * FROM messages ORDER BY id; SELECT count(*) FROM provenance;`).out;

describe("the audit's probe shapes: accepted at version 5, refused at version 6", () => {
	test("through the module: every probe the version-5 module accepts, this module refuses with the rule it broke", () => {
		const before = runProbes(v5Module());
		const after = runProbes(join(REPO, "ledger", "src", "index.ts"));
		const names = [...Object.keys(REFUSALS), "open a ledger with dropped triggers", "commit at synchronous below FULL"];
		expect(Object.keys(before).sort()).toEqual([...names].sort());
		for (const name of names) expect({ name, outcome: before[name] }).toEqual({ name, outcome: "accepted" });
		for (const [name, message] of Object.entries(REFUSALS)) expect({ name, outcome: after[name] }).toEqual({ name, outcome: `refused: ${message}` });
		expect(after["open a ledger with dropped triggers"]).toMatch(
			/^refused: ledger at .*drift\.db \(schema version 6\) does not carry the triggers schema\.sql gives that version, so the file is refused unchanged: missing entries_no_delete, instructions_no_update \(ledger\/SCHEMA\.md, Trigger check\)$/);
		expect(after["commit at synchronous below FULL"]).toBe("refused: synchronous = 2 (FULL)");
	});

	test("on the file: the module's own UPDATEs pass a version-5 file and are refused once Ledger.open has upgraded it", () => {
		const path = v5Ledger("shapes");
		for (const [name, sql] of SHAPES) {
			const copy = join(scratch("shape-v5"), "ledger.db");
			copyFileSync(path, copy);
			expect({ name, ...sqlite(copy, sql) }).toEqual({ name, exitCode: 0, out: "", err: "" });
		}
		migrated(path);
		expect(sqlite(path, "PRAGMA user_version;").out).toBe("6");
		for (const [name, sql] of SHAPES) {
			const r = sqlite(path, sql);
			expect({ name, exitCode: r.exitCode, refused: r.err.includes(REFUSALS[name]!) }).toEqual({ name, exitCode: 1, refused: true });
		}
	});

	test("a done slice keeps its artifact, an acted-on message its stamp, a closed workload its stakes: one refusal, no write", () => {
		const path = v5Ledger("rows");
		migrated(path);
		const l = Ledger.open(path, { backup: false, skipLocalityCheck: true });
		const rows = () => [l.slice("sl-done"), l.slice("sl-cancelled"), l.message("msg-a"), l.workload("wl-closed"), l.workload("wl-orchestrator")];
		const provenance = () => l.db.query<{ n: number }, []>("SELECT count(*) n FROM provenance").get()!.n;
		const [rowsBefore, provBefore] = [rows(), provenance()];
		expect(() => l.completeSlice("sl-done", { by: "lane-y", artifact: "forged: tests passed" })).toThrow(REFUSALS["complete a done slice again"]);
		expect(() => l.cancelSlice("sl-cancelled", { by: "lane-y" })).toThrow(REFUSALS["cancel a cancelled slice again"]);
		expect(() => l.advanceMessage("msg-a", "acted-on", { by: "lane-z" })).toThrow(REFUSALS["re-advance an acted-on message"]);
		expect(() => l.setStakes("wl-closed", { by: "lane-z", stakes: "throwaway" })).toThrow(REFUSALS["set stakes on a closed workload"]);
		expect(() => l.closeWorkload("wl-orchestrator", { by: "lane-z" })).toThrow(REFUSALS["close the standing workload"]);
		expect(() => l.setStakes("wl-a", { by: "lane-x", stakes: "production" })).toThrow(REFUSALS["set stakes with no instruction"]);
		expect([rows(), provenance()]).toEqual([rowsBefore, provBefore]);
		expect(l.slice("sl-done")!.artifact).toBe("bun test exit 0 (real run)");
		l.close();
	});
});

describe("what stays legal at version 6", () => {
	test("stakes change in the transaction that records its `stakes: <stakes>` instruction, as the surface does; an instruction for other stakes, or one older than the last change, does not count", () => {
		let t = Date.parse("2026-10-12T00:00:00.000Z");
		const clock = () => new Date((t += 1)).toISOString();
		const l = Ledger.open(join(scratch("stakes"), "ledger.db"), { create: true, backup: false, skipLocalityCheck: true, clock });
		const wl = l.openWorkload({ by: "orchestrator-surface", brief: "b", stakes: "normal", mode: "autonomous" });
		const stamp = { by: "orchestrator-surface", workloadId: wl, author: "jo", channel: "surface" as const };
		l.write(() => {
			l.recordInstruction({ ...stamp, body: "stakes: production" });
			l.setStakes(wl, { by: "orchestrator-surface", stakes: "production" });
		});
		expect(l.workload(wl)!.stakes).toBe("production");
		l.recordInstruction({ ...stamp, body: "stakes: normal" });
		expect(() => l.setStakes(wl, { by: "orchestrator-surface", stakes: "throwaway" })).toThrow(REFUSALS["set stakes with no instruction"]);
		l.claimWorkload(wl, { by: "lane-1", holder: "lane-1", leaseMs: 60_000 });
		expect(() => l.setStakes(wl, { by: "orchestrator-surface", stakes: "normal" })).toThrow(REFUSALS["set stakes with no instruction"]);
		expect(l.workload(wl)!.stakes).toBe("production");
		l.close();
	});

	test("the lifecycle into each final state still runs: complete, cancel, acted-on, close; any other workload closes", () => {
		const l = Ledger.open(join(scratch("legal"), "ledger.db"), { create: true, backup: false, skipLocalityCheck: true });
		const wl = l.openWorkload({ by: "o", brief: "b", stakes: "normal", mode: "autonomous" });
		const [a, b] = [0, 1].map(() => l.addSlice({ by: "lane-1", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" }));
		l.completeSlice(a!, { by: "lane-1", artifact: "x" });
		l.cancelSlice(b!, { by: "lane-1" });
		const m = l.enqueue({ by: "lane-1", workloadId: wl, sender: "lane-1", recipient: "orchestrator", body: "hi" });
		for (const s of ["delivered", "consumed", "acted-on"] as const) l.advanceMessage(m, s, { by: "surface" });
		l.closeWorkload(wl, { by: "o" });
		expect([l.slice(a!)!.state, l.slice(b!)!.state, l.message(m)!.state, l.workload(wl)!.status]).toEqual(["done", "cancelled", "acted-on", "closed"]);
		l.close();
	});
});

describe("version 5 to 6: opening never upgrades; ledger/scripts/migrate.ts does", () => {
	test("Ledger.open refuses a version-5 file with the migrate command, and leaves the file byte-identical; init.ts exits 4 and the backup job 4 the same way", () => {
		const path = v5Ledger("open-refuses");
		const [before, rows] = [bytes(path), state(path)];
		let error: unknown;
		try {
			Ledger.open(path, { backup: false, skipLocalityCheck: true }).close();
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(LedgerNeedsMigrationError);
		expect(String(error)).toContain(`is schema version 5; this module opens version ${SCHEMA_VERSION} and never upgrades on open: run \`bun run ${join(REPO, "ledger", "scripts", "migrate.ts")} ${path}\``);
		expect(bytes(path)).toBe(before);
		for (const name of ["init.ts", "backup.ts"]) {
			const r = script(name, path);
			expect({ name, exitCode: r.exitCode, names: r.err.includes("migrate.ts") }).toEqual({ name, exitCode: 4, names: true });
		}
		expect(state(path)).toBe(rows);
	});

	test("migrate.ts takes version 5 to 6: snapshot first (a complete version-5 copy of the rows), rows untouched, the trigger set a new ledger's, and its printed undo returns the file to version 5 exactly", () => {
		const path = v5Ledger("migrate");
		const before = state(path);
		const r = migrateScript(path);
		expect(r.exitCode).toBe(0);
		const snapshot = r.out.match(/^snapshot \(version 5, taken before any write\): (.+)$/m)?.[1];
		expect(snapshot && existsSync(snapshot)).toBeTruthy();
		expect(copyProblem(snapshot!)).toBeNull();
		expect(state(snapshot!)).toBe(before);
		const fresh = Ledger.open(join(scratch("fresh"), "ledger.db"), { create: true, backup: false, skipLocalityCheck: true });
		const triggers = (db: Database) => db.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
		const upgraded = new Database(path);
		expect(triggers(upgraded)).toEqual(triggers(fresh.db));
		expect(upgraded.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(SCHEMA_VERSION);
		upgraded.close();
		fresh.close();
		const rowsOf = (p: string) => sqlite(p, "SELECT * FROM workloads ORDER BY id; SELECT * FROM slices ORDER BY id; SELECT * FROM messages ORDER BY id; SELECT * FROM provenance ORDER BY seq;").out;
		expect(rowsOf(path)).toBe(rowsOf(snapshot!));
		Ledger.open(path, { backup: false, skipLocalityCheck: true }).close();
		expect(runUndo(r.out)).toEqual({ exitCode: 0, err: "" });
		expect(state(path)).toBe(before);
	});

	test("migrate.ts is idempotent on a version-6 file: checked, nothing written, no snapshot", () => {
		const path = v5Ledger("idempotent");
		expect(migrateScript(path).exitCode).toBe(0);
		const [once, files] = [state(path), readdirSync(dirname(path)).filter((n) => n.includes("-pre-v")).length];
		const again = script("migrate.ts", path);
		expect(again.exitCode).toBe(0);
		expect(again.out).toContain(`schema_version=${SCHEMA_VERSION} (already current; nothing written)`);
		expect(state(path)).toBe(once);
		expect(readdirSync(dirname(path)).filter((n) => n.includes("-pre-v")).length).toBe(files);
	});

	test("migrate.ts refuses a file a live lane holds (exit 6), writing nothing, snapshot included; --force upgrades it", () => {
		const path = v5Ledger("held");
		expect(sqlite(path, "UPDATE workloads SET holder = 'lane-a-1', holder_lease_until = '2999-01-01T00:00:00.000Z', changed_by = 'lane-a-1', rev = rev + 1 WHERE id = 'wl-a';").err).toBe("");
		const before = bytes(path);
		const held = script("migrate.ts", path);
		expect({ exitCode: held.exitCode, named: held.err.includes("held by 1 live lane(s) (wl-a by lane-a-1)") }).toEqual({ exitCode: 6, named: true });
		expect(bytes(path)).toBe(before);
		expect(migrateScript(path, { flags: ["--force"] }).exitCode).toBe(0);
		expect(sqlite(path, "PRAGMA user_version;").out).toBe(String(SCHEMA_VERSION));
	});

	test("--dry-run previews version 5 -> 6 and the triggers it adds, and writes nothing: the file, its directory and its rows are byte-identical (MIGRATION.md item 114, step 4)", () => {
		const path = v5Ledger("dry-run");
		const [before, rows] = [bytes(path), state(path)];
		const r = migrateScript(path, { flags: ["--dry-run"], typed: null });
		expect(r.exitCode).toBe(0);
		expect(r.out).toContain(`schema version: 5 -> ${SCHEMA_VERSION}`);
		expect(r.out).toContain(`adds ${MIGRATIONS[5]!.addsTriggers.length} trigger(s), no column and no table: ${MIGRATIONS[5]!.addsTriggers.join(", ")}`);
		expect(r.out).toContain("dry run: nothing written");
		expect(r.out).not.toContain("Type MIGRATE");
		expect(bytes(path)).toBe(before);
		expect(state(path)).toBe(rows);
		expect(sqlite(path, "PRAGMA user_version;").out).toBe("5");
		// A dry run makes the real run's checks: a live lease is refused the same way, exit 6, without --force.
		expect(sqlite(path, "UPDATE workloads SET holder = 'lane-a-1', holder_lease_until = '2999-01-01T00:00:00.000Z', changed_by = 'lane-a-1', rev = rev + 1 WHERE id = 'wl-a';").err).toBe("");
		const heldBefore = bytes(path);
		expect(migrateScript(path, { flags: ["--dry-run"], typed: null }).exitCode).toBe(6);
		const forced = migrateScript(path, { flags: ["--dry-run", "--force"], typed: null });
		expect({ exitCode: forced.exitCode, leases: forced.out.includes("live leases: 1, overridden by --force (wl-a by lane-a-1)") }).toEqual({ exitCode: 0, leases: true });
		expect(bytes(path)).toBe(heldBefore);
	});

	test("a real run without the typed confirmation refuses (exit 7) after the preview and writes nothing, snapshot included (MIGRATION.md item 114, step 4)", () => {
		const path = v5Ledger("unconfirmed");
		const [before, rows] = [bytes(path), state(path)];
		for (const typed of [null, "", "yes\n", "migrate\n", "MIGRATE please\n"]) {
			const r = migrateScript(path, { typed });
			expect({ typed, exitCode: r.exitCode, previewed: r.out.includes(`schema version: 5 -> ${SCHEMA_VERSION}`), asked: r.out.includes("Type MIGRATE"), refused: r.err.includes("nothing written") })
				.toEqual({ typed, exitCode: 7, previewed: true, asked: true, refused: true });
			expect(r.out).not.toContain("snapshot (version 5");
			expect(bytes(path)).toBe(before);
		}
		expect(state(path)).toBe(rows);
		expect(sqlite(path, "PRAGMA user_version;").out).toBe("5");
		expect(migrateScript(path).exitCode).toBe(0);
		expect(sqlite(path, "PRAGMA user_version;").out).toBe(String(SCHEMA_VERSION));
	});

	test("the version-5 module (main before this change) refuses a version-6 file cleanly and leaves it unchanged", () => {
		const path = join(scratch("v6-under-v5"), "ledger.db");
		Ledger.open(path, { create: true, backup: false, skipLocalityCheck: true }).close();
		const before = state(path);
		const r = Bun.spawnSync(["bun", "-e", `
			import { Ledger } from ${JSON.stringify(v5Module())};
			try { Ledger.open(${JSON.stringify(path)}, { backup: false, skipLocalityCheck: true }).close(); console.log("opened"); }
			catch (e) { console.log(String(e)); }
		`], { stdout: "pipe", stderr: "pipe" });
		expect(r.stdout.toString()).toContain(`is schema version ${SCHEMA_VERSION}, which is not the supported schema (version 5); the file is refused unchanged`);
		expect(state(path)).toBe(before);
	});

	test("migrate.ts prints the snapshot and the undo before it upgrades; a failure after that line exits non-zero, reads the version back, and keeps the snapshot (review S2)", () => {
		const ok = migrateScript(v5Ledger("order"));
		const lines = ok.out.split("\n");
		const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
		expect(at("snapshot (version 5") >= 0 && at("undo, lossless") > at("snapshot (version 5") && at("ledger migrated:") > at("undo, lossless")).toBe(true);
		// A fault the upgrade meets only inside its transaction: the file already carries one of the triggers
		// version 6 adds (let past the early check by name), so CREATE TRIGGER fails and the transaction rolls back.
		const path = v5Ledger("fails-after-snapshot");
		expect(sqlite(path, `${[...schemaBody().matchAll(/CREATE TRIGGER slices_final[\s\S]*?END;/g)][0]![0]}`).err).toBe("");
		const env = { ...process.env, AGENT_SYSTEM_LEDGER_FAULT_TRIGGERS: "slices_final" };
		const r = migrateScript(path, { env });
		const { out, err } = r;
		const snapshot = out.match(/^snapshot \(version 5, taken before any write\): (.+)$/m)?.[1];
		expect({ exitCode: r.exitCode, snapshotKept: !!snapshot && existsSync(snapshot), undoPrinted: out.includes("undo, lossless") })
			.toEqual({ exitCode: 1, snapshotKept: true, undoPrinted: true });
		expect(err).toContain("schema version read back now: 5: the upgrade did not commit; the snapshot printed above is kept");
		expect(sqlite(path, "PRAGMA user_version;").out).toBe("5");
	});

	test("the printed undo is shell-quoted: run as printed by zsh and by sh, it reaches a path holding a quote, $HOME, a backtick and $( ) (review S1)", () => {
		for (const shell of ["/bin/zsh", "/bin/sh"]) {
			const dir = join(scratch("quoting"), "it's $HOME `echo tick` $(echo sub)");
			mkdirSync(dir);
			const path = join(dir, "ledger.db");
			copyFileSync(v5Ledger("quoting-src"), path);
			const before = state(path);
			const r = migrateScript(path);
			expect(r.exitCode).toBe(0);
			expect({ shell, ...runUndo(r.out, shell) }).toEqual({ shell, exitCode: 0, err: "" });
			expect(state(path)).toBe(before);
			expect(readdirSync(dirname(dir)).sort()).toEqual([basename(dir)]);
		}
	});

	test("a lane that takes a live lease after the early check is caught under the upgrade's write lock: refused, still version 5, snapshot kept (review B1)", () => {
		const path = v5Ledger("held-late");
		let snapshot: string | null = null;
		expect(() => migrateLedger(path, {
			skipLocalityCheck: true,
			beforeUpgrade: (recovery) => {
				snapshot = recovery.snapshot;
				expect(sqlite(path, "UPDATE workloads SET holder = 'lane-late-1', holder_lease_until = '2999-01-01T00:00:00.000Z', changed_by = 'lane-late-1', rev = rev + 1 WHERE id = 'wl-a';").err).toBe("");
			},
		})).toThrow("held by 1 live lane(s) (wl-a by lane-late-1)");
		expect(sqlite(path, "PRAGMA user_version;").out).toBe("5");
		expect(snapshot && existsSync(snapshot)).toBeTruthy();
		expect(migrateLedger(path, { skipLocalityCheck: true, force: true, snapshot: false }).to).toBe(SCHEMA_VERSION);
	});

	test("a file another process upgraded between the check and the write lock is refused, not reported as this run's upgrade with a version-5 undo (review S3)", () => {
		const path = v5Ledger("changed-under-lock");
		let result: unknown = null;
		let error: unknown = null;
		try {
			result = migrateLedger(path, { skipLocalityCheck: true, snapshot: false, beforeUpgrade: () => void migrated(path) });
		} catch (e) {
			error = e;
		}
		expect({ result, error: String(error) }).toEqual({
			result: null,
			error: expect.stringContaining(`was schema version 5 when checked and is ${SCHEMA_VERSION} under the migration's write lock`),
		});
		expect(sqlite(path, "PRAGMA user_version;").out).toBe(String(SCHEMA_VERSION));
	});
});

/** The main file, its -wal and -shm (bytes or absent), and every name in the directory. */
function sidecars(path: string): Record<string, string> {
	const out: Record<string, string> = { dir: readdirSync(dirname(path)).sort().join(",") };
	for (const f of [path, `${path}-wal`, `${path}-shm`]) out[basename(f)] = existsSync(f) ? `${statSync(f).size}:${Bun.hash(readFileSync(f))}` : "absent";
	return out;
}

/**
 * A version-5 file whose last writer died with committed frames still in the WAL: a raw write (a
 * live lease on wl-a) with checkpoints off, then SIGKILL, so the -wal holds the commit and the -shm
 * the dead writer's index. With `keepShm` false the -shm is removed too.
 */
function crashLeftWal(label: string, keepShm = true): string {
	const path = v5Ledger(label);
	const r = Bun.spawnSync(["bun", "-e", `
		import { Database } from "bun:sqlite";
		const db = new Database(${JSON.stringify(path)}, { readwrite: true });
		db.exec("PRAGMA wal_autocheckpoint = 0");
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		db.exec("UPDATE workloads SET holder = 'lane-crashed-1', holder_lease_until = '2999-01-01T00:00:00.000Z', changed_by = 'lane-crashed-1', rev = rev + 1 WHERE id = 'wl-a'");
		process.kill(process.pid, "SIGKILL");
	`], { stdout: "pipe", stderr: "pipe" });
	expect(r.signalCode).toBe("SIGKILL");
	if (!keepShm) rmSync(`${path}-shm`);
	expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
	return path;
}

describe("refusing a file writes nothing to it, its -wal or its -shm (review B2)", () => {
	test("what this SQLite does to a crash-left WAL, by connection kind: read-write checkpoints and truncates it, plain read-only rewrites the -shm, mode=ro&readonly_shm=1 changes nothing and still reads the WAL's commit", () => {
		const seen: Record<string, unknown> = {};
		for (const [kind, open] of [
			["read-write", (p: string) => new Database(p, { readwrite: true })],
			["read-only", (p: string) => new Database(p, { readonly: true })],
			["mode=ro&readonly_shm=1", (p: string) => new Database(`file:${p}?mode=ro&readonly_shm=1`, { readonly: true })],
		] as const) {
			const path = crashLeftWal(`sqlite-${kind.replace(/\W/g, "")}`);
			const before = sidecars(path);
			const db = open(path);
			const holder = db.query<{ holder: string | null }, []>("SELECT holder FROM workloads WHERE id = 'wl-a'").get()!.holder;
			db.close();
			const after = sidecars(path);
			seen[kind] = { holder, file: after["ledger.db"] === before["ledger.db"], wal: after["ledger.db-wal"] === before["ledger.db-wal"], shm: after["ledger.db-shm"] === before["ledger.db-shm"] };
		}
		expect(seen).toEqual({
			"read-write": { holder: "lane-crashed-1", file: false, wal: false, shm: false },
			"read-only": { holder: "lane-crashed-1", file: true, wal: true, shm: false },
			"mode=ro&readonly_shm=1": { holder: "lane-crashed-1", file: true, wal: true, shm: true },
		});
	});

	test("a version-5 file with a crash-left WAL is refused by Ledger.open, init.ts and backup.ts with the file, -wal and -shm byte-identical", () => {
		const path = crashLeftWal("crash-v5");
		const before = sidecars(path);
		expect(() => Ledger.open(path, { backup: false, skipLocalityCheck: true })).toThrow("never upgrades on open");
		expect(sidecars(path)).toEqual(before);
		for (const name of ["init.ts", "backup.ts"]) expect({ name, exitCode: script(name, path).exitCode, files: sidecars(path) }).toEqual({ name, exitCode: 4, files: before });
	});

	test("a crash-left WAL with no -shm cannot be read without writing one, so it is refused as unreadable, byte-identical, with no -shm created", () => {
		const path = crashLeftWal("crash-no-shm", false);
		const before = sidecars(path);
		expect(() => Ledger.open(path, { backup: false, skipLocalityCheck: true })).toThrow("so its schema version cannot be read without writing to it");
		expect(sidecars(path)).toEqual(before);
	});

	test("a version-6 file closed cleanly, with no -wal or -shm left, still opens (its main file is its whole state)", () => {
		const path = join(scratch("clean-v6"), "ledger.db");
		Ledger.open(path, { create: true, backup: false, skipLocalityCheck: true }).close();
		expect(sqlite(path, "PRAGMA wal_checkpoint(TRUNCATE);").exitCode).toBe(0);
		for (const f of [`${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
		const l = Ledger.open(path, { backup: false, skipLocalityCheck: true });
		expect(l.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(SCHEMA_VERSION);
		l.close();
	});

	test("a version-0 file that already holds tables is refused, never initialized: open with create throws, init.ts exits 4, the file is byte-identical (review S4)", () => {
		const path = join(scratch("not-empty"), "ledger.db");
		expect(sqlite(path, "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine');").err).toBe("");
		const before = sidecars(path);
		expect(() => Ledger.open(path, { create: true, backup: false, skipLocalityCheck: true })).toThrow("is schema version 0 but already holds 1 schema object(s)");
		expect(sidecars(path)).toEqual(before);
		const init = script("init.ts", path);
		expect({ exitCode: init.exitCode, said: init.err.includes("already holds 1 schema object(s)"), files: sidecars(path) }).toEqual({ exitCode: 4, said: true, files: before });
	});
});

describe("the version 5 to 6 upgrade itself", () => {
	test("the upgrade adds exactly the triggers schema.sql has and version 5's did not", () => {
		const v5 = new Database(":memory:");
		v5.exec(gitShow("ledger/schema.sql").replace(/^PRAGMA journal_mode = WAL;$/m, ""));
		const v5Names = new Set(v5.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));
		const now = new Database(":memory:");
		now.exec(schemaBody());
		const added = now.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name).filter((n) => !v5Names.has(n));
		expect(added.sort()).toEqual([...MIGRATIONS[5]!.addsTriggers].sort());
		expect(MIGRATIONS[5]!.to).toBe(SCHEMA_VERSION);
		expect([...expectedTriggers(5)!.keys()].sort()).toEqual([...v5Names].sort());
	});

	test("every committed version-5 ledger (the classifier's replay fixtures, copies of the live file) carries version 5's trigger set and upgrades cleanly", () => {
		const fixtures = join(REPO, "classifier", "test", "fixtures", "ledger-replay");
		const files = readdirSync(fixtures).filter((n) => n.endsWith(".db.gz"));
		expect(files.length).toBeGreaterThan(0);
		for (const name of files) {
			const path = join(scratch("replay"), "ledger.db");
			writeFileSync(path, gunzipSync(readFileSync(join(fixtures, name))));
			const db = new Database(path);
			expect({ name, version: db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version, drift: triggerDrift(db) }).toEqual({ name, version: 5, drift: null });
			db.close();
			migrateLedger(path, { snapshot: false, force: true, skipLocalityCheck: true });
			const after = new Database(path);
			expect({ name, version: after.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version, drift: triggerDrift(after) }).toEqual({ name, version: 6, drift: null });
			after.close();
		}
	});

	test("a version-5 copy is a complete copy (copyProblem), so an upgrade never sets the existing backups aside", () => {
		expect(copyProblem(v5Ledger("copy"))).toBeNull();
		const v4 = join(scratch("v4"), "ledger.db");
		expect(sqlite(v4, "CREATE TABLE t (x); PRAGMA user_version = 4;").err).toBe("");
		expect(copyProblem(v4)).toBe(`user_version 4, not one this module opens (${SCHEMA_VERSION} or one it upgrades)`);
	});

	test("a drifted version-5 file is refused unchanged, not upgraded: migrate.ts exits 5 naming the drift; open, init and the backup job refuse it as needing migration", () => {
		const path = v5Ledger("drift-v5");
		expect(sqlite(path, "DROP TRIGGER entries_no_delete;").err).toBe("");
		const before = state(path);
		const m = script("migrate.ts", path);
		expect({ exitCode: m.exitCode, missing: m.err.includes("(schema version 5) does not carry the triggers schema.sql gives that version, so the file is refused unchanged: missing entries_no_delete") })
			.toEqual({ exitCode: 5, missing: true });
		expect(readdirSync(dirname(path)).filter((n) => n.includes("-pre-v"))).toEqual([]);
		expect(() => Ledger.open(path, { backup: false, skipLocalityCheck: true })).toThrow(LedgerNeedsMigrationError);
		for (const name of ["init.ts", "backup.ts"]) expect({ name, exitCode: script(name, path).exitCode }).toEqual({ name, exitCode: 4 });
		expect(state(path)).toBe(before);
	});
});

describe("the trigger set is checked at every open (A5-1)", () => {
	test("a dropped, a rewritten and an extra trigger are each named, and the file is refused", () => {
		const path = join(scratch("drift-v6"), "ledger.db");
		Ledger.open(path, { create: true, backup: false, skipLocalityCheck: true }).close();
		const raw = new Database(path);
		raw.exec(`DROP TRIGGER slices_final;
			DROP TRIGGER messages_acted_on_final;
			CREATE TRIGGER messages_acted_on_final BEFORE UPDATE ON messages WHEN 0 BEGIN SELECT 1; END;
			CREATE TRIGGER zz_extra AFTER INSERT ON entries BEGIN SELECT 1; END;`);
		const drift = triggerDrift(raw)!;
		raw.close();
		expect({ version: drift.version, missing: drift.missing, changed: drift.changed.map((c) => c.name), unexpected: drift.unexpected })
			.toEqual({ version: 6, missing: ["slices_final"], changed: ["messages_acted_on_final"], unexpected: ["zz_extra"] });
		expect(() => Ledger.open(path, { backup: false, skipLocalityCheck: true })).toThrow(
			/missing slices_final; changed messages_acted_on_final \(sha256 [0-9a-f]{12}, schema\.sql [0-9a-f]{12}\); not in schema\.sql zz_extra/);
	});

	test("AGENT_SYSTEM_LEDGER_FAULT_TRIGGERS lets a test's named extra trigger through, never an unnamed extra nor a missing one", () => {
		const path = join(scratch("fault"), "ledger.db");
		Ledger.open(path, { create: true, backup: false, skipLocalityCheck: true }).close();
		const open = (faults: string) => Bun.spawnSync(["bun", "-e", `
			import { Ledger } from ${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))};
			Ledger.open(${JSON.stringify(path)}, { backup: false, skipLocalityCheck: true }).close();
		`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT_SYSTEM_LEDGER_FAULT_TRIGGERS: faults } });
		const raw = (sql: string) => {
			const db = new Database(path);
			db.exec(sql);
			db.close();
		};
		raw("CREATE TRIGGER inject_failure BEFORE INSERT ON entries WHEN NEW.body LIKE 'x%' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
		expect(open("inject_failure").exitCode).toBe(0);
		expect(open("").stderr.toString()).toContain("not in schema.sql inject_failure");
		// A trigger that drops provenance rows silently: refused unless named, whatever else is named.
		raw("CREATE TRIGGER drop_log BEFORE INSERT ON provenance BEGIN SELECT RAISE(IGNORE); END;");
		expect(open("inject_failure").stderr.toString()).toContain("not in schema.sql drop_log");
		raw("DROP TRIGGER drop_log; DROP TRIGGER slices_final;");
		const missing = open("inject_failure,slices_final");
		expect(missing.exitCode).not.toBe(0);
		expect(missing.stderr.toString()).toContain("missing slices_final");
		expect(missing.stderr.toString()).not.toContain("inject_failure");
	});

	test("the expected set is schema.sql's: every CREATE TRIGGER in the file, by name", () => {
		const names = [...readFileSync(SCHEMA_PATH, "utf8").matchAll(/^CREATE TRIGGER (\w+)/gm)].map((m) => m[1]!);
		expect([...expectedTriggers(SCHEMA_VERSION)!.keys()].sort()).toEqual(names.sort());
	});
});
