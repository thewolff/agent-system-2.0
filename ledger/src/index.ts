// agent-system 2.0 ledger: the single writer contract (SPEC-2.0.md § B2).
// Plain bun:sqlite; no OMP import, so a `bun run` script and an OMP extension use it alike.
// The rules live in ../schema.sql; this module adds ids, stamps, retries, the scheduled second
// copy and the read queries.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertLocalPath, assertNotLiveLedgerUnderTest, defaultLedgerPath, LiveLedgerUnderTestError } from "./locality";

export {
	assertLocalPath,
	assertNotLiveLedgerUnderTest,
	canonicalPath,
	DEFAULT_LEDGER_RELATIVE,
	defaultLedgerPath,
	homeDir,
	LEDGER_DB_ENV,
	LedgerLocationError,
	LiveLedgerUnderTestError,
	mountLocality,
} from "./locality";

export const SCHEMA_VERSION = 6;
export const SCHEMA_PATH = join(import.meta.dir, "..", "schema.sql");

/**
 * The upgrades `migrateLedger` applies (ledger/scripts/migrate.ts), keyed by the version each takes
 * a file from (ledger/SCHEMA.md, Versioning). `Ledger.open` never applies them: opening a ledger
 * never upgrades it (Jo's standing rule; a branch's test once upgraded the live file by opening it).
 * An upgrade only adds triggers, and takes each one's statement from schema.sql itself, so an
 * upgraded file and a new one carry the same trigger text, which the open-time trigger check compares.
 */
export const MIGRATIONS: Readonly<Record<number, { to: number; addsTriggers: readonly string[] }>> = {
	5: {
		to: 6,
		addsTriggers: [
			"workloads_stakes_needs_instruction", "workloads_standing_never_closes",
			"workloads_closed_final", "slices_final", "messages_acted_on_final",
		],
	},
};

/** Whether the module recognises a file at `version`: the supported one, or one `migrateLedger` upgrades from. */
export function openableVersion(version: number): boolean {
	for (let at = version; ; at = MIGRATIONS[at]!.to) {
		if (at === SCHEMA_VERSION) return true;
		if (!MIGRATIONS[at]) return false;
	}
}

/**
 * The file's `user_version` is one this module neither supports nor upgrades. Such a file (versions
 * 1 to 4 predate the oldest upgrade; any other number is unknown) is refused before the module
 * writes anything to it, so it is left exactly as found.
 */
export class LedgerSchemaVersionError extends Error {
	constructor(readonly path: string, readonly version: number) {
		super(version > 0 && version < SCHEMA_VERSION
			? `ledger at ${path} is schema version ${version}, which predates the supported schema (version ${SCHEMA_VERSION}) ` +
				"and every version this module upgrades; the file is refused unchanged: move it aside and install a new ledger (ledger/SCHEMA.md, Versioning)"
			: `ledger at ${path} is schema version ${version}, which is not the supported schema (version ${SCHEMA_VERSION}); ` +
				"the file is refused unchanged (ledger/SCHEMA.md, Versioning)");
	}
}

/** The command that upgrades a ledger, as `LedgerNeedsMigrationError` names it. */
export const MIGRATE_SCRIPT = join(import.meta.dir, "..", "scripts", "migrate.ts");

/**
 * The file is at a version `migrateLedger` upgrades from. `Ledger.open` refuses it before writing
 * anything and names the explicit command; opening never upgrades.
 */
export class LedgerNeedsMigrationError extends LedgerSchemaVersionError {
	constructor(path: string, version: number) {
		super(path, version);
		this.message = `ledger at ${path} is schema version ${version}; this module opens version ${SCHEMA_VERSION} and never upgrades on open: ` +
			`run \`bun run ${MIGRATE_SCRIPT} ${path}\` (ledger/SCHEMA.md, Versioning)`;
	}
}

/** A version-0 file that already holds schema objects: not an empty file, so it is never initialized. */
export class LedgerNotEmptyError extends LedgerSchemaVersionError {
	constructor(path: string, readonly objects: number) {
		super(path, 0);
		this.message = `ledger at ${path} is schema version 0 but already holds ${objects} schema object(s), so it is not an empty file ` +
			"this module may initialize; the file is refused unchanged: point the ledger path at a new file or move this one aside (ledger/SCHEMA.md, Versioning)";
	}
}

/** The version `migrateLedger` checked changed before its write lock was taken; nothing was upgraded. */
export class LedgerSchemaChangedError extends LedgerSchemaVersionError {
	constructor(path: string, readonly checked: number, version: number) {
		super(path, version);
		this.message = `ledger at ${path} was schema version ${checked} when checked and is ${version} under the migration's write lock; ` +
			"another process changed it, so this run upgraded nothing: stop every writer and run the migration again (ledger/SCHEMA.md, Versioning)";
	}
}

/**
 * A file whose committed state SQLite can only read by writing: a non-empty -wal with no -shm, which
 * a read-only connection cannot rebuild the WAL index for. Refused unchanged rather than opened
 * read-write, which would recover the WAL into the file before its version could be checked.
 */
export class LedgerUnreadableError extends Error {
	constructor(readonly path: string) {
		super(`ledger at ${path} has a write-ahead log (${path}-wal) and no shared-memory file (${path}-shm), so its schema version cannot be ` +
			"read without writing to it; the file is refused unchanged: recover it by hand with sqlite3 once you know which module version " +
			"should own it (ledger/SCHEMA.md, Versioning)");
	}
}

/** A lane holds a workload under a live lease, so `migrateLedger` refuses without `force`. */
export class LedgerHeldError extends Error {
	constructor(readonly path: string, readonly held: { id: string; holder: string; lease: string | null }[]) {
		super(`ledger at ${path} is held by ${held.length} live lane(s) (${held.map((h) => `${h.id} by ${h.holder}`).join(", ")}); ` +
			"the file is refused unchanged: stop the lanes, or pass --force");
	}
}

/** How a file's triggers differ from the set schema.sql gives its version (`triggerDrift`). */
export interface TriggerDrift {
	version: number;
	/** Triggers the version carries that the file lacks. */
	missing: string[];
	/** Triggers whose statement text differs: the first 12 hex digits of the SHA-256 of each text. */
	changed: { name: string; expected: string; found: string }[];
	/** Triggers in the file that schema.sql does not give the version. */
	unexpected: string[];
}

/** One line naming every difference in `d`. */
export function describeDrift(d: TriggerDrift): string {
	return [
		d.missing.length ? `missing ${d.missing.join(", ")}` : "",
		d.changed.length ? `changed ${d.changed.map((c) => `${c.name} (sha256 ${c.found}, schema.sql ${c.expected})`).join(", ")}` : "",
		d.unexpected.length ? `not in schema.sql ${d.unexpected.join(", ")}` : "",
	].filter(Boolean).join("; ");
}

/**
 * The file's triggers are not the ones schema.sql gives its version (ledger audit A5-1): a rule the
 * module and every reader rely on may be missing or rewritten. The file is refused; when an upgrade
 * found it, the upgrade was rolled back, so nothing was written either way.
 */
export class LedgerTriggerDriftError extends Error {
	constructor(readonly path: string, readonly drift: TriggerDrift) {
		super(`ledger at ${path} (schema version ${drift.version}) does not carry the triggers schema.sql gives that version, ` +
			`so the file is refused unchanged: ${describeDrift(drift)} (ledger/SCHEMA.md, Trigger check)`);
	}
}

/**
 * The schema statements the module runs inside its own BEGIN IMMEDIATE: the text between the
 * file's single `BEGIN;` line and its single `COMMIT;` line. schema.sql stays runnable on its own
 * (`sqlite3 ledger.db < ledger/schema.sql`); the module takes the transaction itself so it can
 * acquire it under the busy-retry policy before any dependent statement runs.
 */
export function schemaBody(sql: string = readFileSync(SCHEMA_PATH, "utf8")): string {
	const lines = sql.split("\n");
	const begin = lines.indexOf("BEGIN;");
	const commit = lines.indexOf("COMMIT;");
	if (begin < 0 || commit < begin || lines.lastIndexOf("BEGIN;") !== begin || lines.lastIndexOf("COMMIT;") !== commit) {
		throw new Error(`${SCHEMA_PATH} must contain exactly one "BEGIN;" line followed by exactly one "COMMIT;" line`);
	}
	return lines.slice(begin + 1, commit).join("\n");
}

/** The scheduled second copy (SPEC-2.0.md § B2 prior art e). */
export interface BackupPolicy {
	/**
	 * The backup root. Default: `backups/` beside the ledger file. Copies go in a subdirectory of it
	 * named for the source ledger (`backupNamespace`), so ledgers sharing a root never share copies.
	 */
	dir?: string;
	/** A copy is due when the newest is at least this old. Default 24 hours. */
	intervalMs?: number;
	/** Copies kept; older ones are removed after a new copy lands. Default 7. */
	keep?: number;
}
export const BACKUP_DEFAULTS = { intervalMs: 24 * 60 * 60 * 1000, keep: 7 } as const;
/** A scheduled copy's file name, `ledger-<ISO time with : as ->.db`; the groups rebuild the ISO time. */
export const BACKUP_NAME = /^ledger-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3}Z)\.db$/;
/** `backup()`'s temporary snapshot beside a scheduled copy: `.<copy name>.<writer pid>-<random>.tmp[-wal|-shm|-journal]`. */
const BACKUP_TEMP_NAME = /^\.ledger-[^/]*\.db\.(\d+)-[0-9a-z]*\.tmp(?:-wal|-shm|-journal)?$/;

/**
 * Whether process `pid` exists: `kill(pid, 0)` succeeds, or fails with EPERM (it exists but is not
 * ours to signal). Only ESRCH means gone; any other failure counts as alive, so nothing is removed.
 */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return !(e instanceof Error && "code" in e && e.code === "ESRCH");
	}
}

/** In each namespace directory: the canonical path of the ledger its copies are of. */
export const BACKUP_SOURCE_FILE = "SOURCE";

/**
 * The backup subdirectory for the ledger at canonical path `source`: its file name without the
 * extension, then the first 12 hex digits of the SHA-256 of the whole canonical path.
 */
export function backupNamespace(source: string): string {
	const stem = basename(source).replace(/\.[^.]*$/, "") || "ledger";
	return `${stem}-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
}

/**
 * Why the file at `path` is not a complete copy of a ledger (empty, unreadable, failing
 * `PRAGMA integrity_check`, or at a version `Ledger.open` does not open), or null when it is one.
 * A copy at a version `Ledger.open` upgrades is complete: it is upgraded when it is opened.
 */
export function copyProblem(path: string): string | null {
	assertNotLiveLedgerUnderTest(path);
	let size: number;
	try {
		size = statSync(path).size;
	} catch (e) {
		return `cannot stat: ${e instanceof Error ? e.message : String(e)}`;
	}
	if (size === 0) return "empty file";
	let db: Database | undefined;
	try {
		db = new Database(path, { readonly: true });
		const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all().map((r) => r.integrity_check);
		if (integrity.join("\n") !== "ok") return `integrity_check: ${integrity.slice(0, 3).join("; ")}`;
		const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
		if (!openableVersion(version)) return `user_version ${version}, not one this module opens (${SCHEMA_VERSION} or one it upgrades)`;
		return null;
	} catch (e) {
		return `unreadable: ${e instanceof Error ? e.message : String(e)}`;
	} finally {
		db?.close();
	}
}

/** Run `fn`, retrying it after SQLITE_BUSY up to `retries` extra times with capped backoff. */
function retryBusy<T>(retries: number, fn: () => T): T {
	for (let attempt = 0; ; attempt++) {
		try {
			return fn();
		} catch (e) {
			const busy = e instanceof Error && "code" in e && typeof e.code === "string" && e.code.startsWith("SQLITE_BUSY");
			if (!busy || attempt >= retries) throw e;
			Bun.sleepSync(Math.min(1000, 25 * 2 ** attempt));
		}
	}
}

const userVersion = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
const schemaObjects = (db: Database) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master").get()!.n;

/** `path` as a SQLite URI filename with `query` (RFC 3986: `%`, `?` and `#` escaped, as SQLite decodes them). */
const uriFilename = (path: string, query: string) => `file:${path.replace(/[%?#]/g, (c) => encodeURIComponent(c))}?${query}`;

/**
 * Run `read` on a connection that writes nothing: not the file, not its -wal, not its -shm, and
 * creates neither. Measured on SQLite 3.51 (bun:sqlite) with a crash-left WAL, recorded in
 * ledger/test/freeze.test.ts: a read-write connection checkpoints the WAL into the file and truncates
 * the -wal on close; a plain read-only one leaves both but rewrites the -shm (it rebuilds the WAL
 * index); `mode=ro&readonly_shm=1` changes none of the three and still reads the WAL's committed
 * frames. That connection cannot open a WAL-mode file that has no -wal and -shm to read; such a file
 * has no WAL content, so its main file is the whole committed state and `immutable=1` reads it
 * without locks or sidecars. A non-empty -wal with no -shm cannot be read without writing one:
 * LedgerUnreadableError.
 */
export function inspect<T>(path: string, retries: number, read: (db: Database) => T): T {
	const attempt = (query: string) => {
		const db = new Database(uriFilename(path, query), { readonly: true, strict: true });
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			return retryBusy(retries, () => read(db));
		} finally {
			db.close();
		}
	};
	try {
		return attempt("mode=ro&readonly_shm=1");
	} catch (e) {
		if (!(e instanceof Error && "code" in e && e.code === "SQLITE_CANTOPEN")) throw e;
		const wal = `${path}-wal`;
		if (existsSync(wal) && statSync(wal).size > 0) throw new LedgerUnreadableError(path);
		return attempt("immutable=1");
	}
}

/** The schema version of the ledger at `path`, read without writing anything (`inspect`). */
export const schemaVersionOf = (path: string): number => inspect(path, 5, userVersion);

/**
 * Apply the schema to a file that had none, inside BEGIN IMMEDIATE so the write lock is held
 * before any dependent statement runs. Re-reads the version under the lock: when another
 * connection initialized the file first, nothing is applied. A version-0 file that holds any schema
 * object is not empty and is refused under the same lock (LedgerNotEmptyError). Returns whether this
 * call applied the schema.
 */
function initialize(db: Database, path: string): boolean {
	db.exec("BEGIN IMMEDIATE");
	try {
		const version = userVersion(db);
		if (version === 0) {
			const objects = schemaObjects(db);
			if (objects > 0) throw new LedgerNotEmptyError(path, objects);
			db.exec(schemaBody());
		}
		db.exec("COMMIT");
		return version === 0;
	} catch (e) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw e;
	}
}

function ensureWal(db: Database): void {
	const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode;
	if (mode === "wal") return;
	const set = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()!.journal_mode;
	// SQLite reports the unchanged mode instead of an error when another connection blocks the switch.
	if (set !== "wal") throw Object.assign(new Error(`could not switch journal_mode to wal (still ${set})`), { code: "SQLITE_BUSY" });
}

let schemaTriggerCache: ReadonlyMap<string, string> | null = null;

/** schema.sql's triggers, name to statement text as sqlite_master stores it: schema.sql run once into an in-memory database. */
function schemaTriggers(): ReadonlyMap<string, string> {
	if (schemaTriggerCache) return schemaTriggerCache;
	const mem = new Database(":memory:");
	try {
		mem.exec(schemaBody());
		schemaTriggerCache = new Map(mem.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
			.all().map((r) => [r.name, r.sql]));
	} finally {
		mem.close();
	}
	return schemaTriggerCache;
}

/**
 * The triggers a ledger at `version` carries, name to statement text, or null for a version
 * `Ledger.open` does not open: schema.sql's, less those the upgrades from `version` on add.
 */
export function expectedTriggers(version: number): ReadonlyMap<string, string> | null {
	if (!openableVersion(version)) return null;
	const out = new Map(schemaTriggers());
	for (let at = version; at !== SCHEMA_VERSION; at = MIGRATIONS[at]!.to) {
		for (const name of MIGRATIONS[at]!.addsTriggers) out.delete(name);
	}
	return out;
}

const sqlHash = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0, 12);

/**
 * How the triggers in `db` differ from the set schema.sql gives the file's version (names, and each
 * statement's text by SHA-256), or null when they match. Reads `sqlite_master` and `user_version`
 * only. Throws LedgerSchemaVersionError for a version `Ledger.open` does not open.
 */
export function triggerDrift(db: Database): TriggerDrift | null {
	const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
	const want = expectedTriggers(version);
	if (!want) throw new LedgerSchemaVersionError(db.filename, version);
	const have = new Map(db.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
		.all().map((r) => [r.name, r.sql]));
	const drift: TriggerDrift = { version, missing: [], changed: [], unexpected: [] };
	for (const [name, sql] of want) {
		const found = have.get(name);
		if (found === undefined) drift.missing.push(name);
		else if (sqlHash(found) !== sqlHash(sql)) drift.changed.push({ name, expected: sqlHash(sql), found: sqlHash(found) });
	}
	for (const name of have.keys()) if (!want.has(name)) drift.unexpected.push(name);
	for (const list of [drift.missing, drift.unexpected]) list.sort();
	drift.changed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return drift.missing.length || drift.changed.length || drift.unexpected.length ? drift : null;
}

/**
 * Refuse a drifted file. One allowance, for tests that inject a failure into a ledger another
 * process then opens: triggers named in $AGENT_SYSTEM_LEDGER_FAULT_TRIGGERS (comma-separated) may be
 * present beyond schema.sql's set. It never excuses a missing or rewritten trigger, and
 * `triggerDrift` (so the ledger-health invariant) still reports them. Nothing in production sets it:
 * an extra trigger can drop a write silently (RAISE(IGNORE)), so an unnamed extra is refused.
 */
function assertTriggers(db: Database, path: string): void {
	const drift = triggerDrift(db);
	if (!drift) return;
	const allowed = new Set((process.env.AGENT_SYSTEM_LEDGER_FAULT_TRIGGERS ?? "").split(",").map((n) => n.trim()).filter(Boolean));
	const unexpected = drift.unexpected.filter((n) => !allowed.has(n));
	if (drift.missing.length || drift.changed.length || unexpected.length) throw new LedgerTriggerDriftError(path, { ...drift, unexpected });
}

/**
 * Upgrade a file from `from`, the version `migrateLedger` checked, to SCHEMA_VERSION, inside BEGIN
 * IMMEDIATE so the write lock is held before anything is read. Under the lock: the version must
 * still be `from` (else LedgerSchemaChangedError: another process changed it); unless `force`, no
 * lane may hold a workload under a live lease (else LedgerHeldError), since a lane can take one
 * after the early check; the trigger set is checked against `from`'s before anything is written
 * and against SCHEMA_VERSION before COMMIT (LedgerTriggerDriftError). Any refusal rolls back, so
 * the file stays at `from`, unchanged. Returns the version read under the lock just before COMMIT.
 * Only `migrateLedger` calls it.
 */
function upgrade(db: Database, path: string, from: number, force: boolean): number {
	db.exec("BEGIN IMMEDIATE");
	try {
		const locked = userVersion(db);
		if (locked !== from) throw new LedgerSchemaChangedError(path, from, locked);
		if (!force) {
			const held = liveHolds(db);
			if (held.length) throw new LedgerHeldError(path, held);
		}
		assertTriggers(db, path);
		const statements = schemaTriggers();
		for (let at = from; at !== SCHEMA_VERSION; at = MIGRATIONS[at]!.to) {
			for (const name of MIGRATIONS[at]!.addsTriggers) db.exec(statements.get(name)!);
			db.exec(`PRAGMA user_version = ${MIGRATIONS[at]!.to}`);
		}
		assertTriggers(db, path);
		const to = userVersion(db);
		db.exec("COMMIT");
		return to;
	} catch (e) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw e;
	}
}

export interface MigrateOptions {
	/** Upgrade even while a lane holds a workload under a live lease. Default false. */
	force?: boolean;
	/** Take a `VACUUM INTO` snapshot beside the file before writing. Default true; only throwaway copies turn it off. */
	snapshot?: boolean;
	/** As OpenOptions.skipLocalityCheck. */
	skipLocalityCheck?: boolean;
	/** Time for the snapshot's name. Default now. */
	now?: () => Date;
	/**
	 * Called once the snapshot is checked and before the upgrade's transaction begins, with the
	 * recovery facts, so they are recorded before anything in the file can change: migrate.ts prints
	 * them here. Not called when nothing is to be upgraded.
	 */
	beforeUpgrade?: (recovery: { path: string; from: number; snapshot: string | null; undo: string }) => void;
}

export interface MigrateResult {
	path: string;
	from: number;
	/** The version read under the upgrade's write lock just before COMMIT (`from` when nothing was upgraded). */
	to: number;
	/** The pre-upgrade snapshot, or null when nothing was upgraded or snapshots were off. */
	snapshot: string | null;
	/** SQL that takes the upgraded file back to `from` losslessly (drops the added triggers), or null when nothing was upgraded. */
	undo: string | null;
}

/** Workloads a lane holds under a live lease: the same test `workloads_holder_no_steal` applies. */
function liveHolds(db: Database): { id: string; holder: string; lease: string | null }[] {
	return db.query<{ id: string; holder: string; lease: string | null }, []>(`SELECT id, holder, holder_lease_until AS lease FROM workloads
		WHERE status = 'open' AND holder IS NOT NULL
		AND (holder_lease_until IS NULL OR holder_lease_until >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ORDER BY id`).all();
}

/** What `migrateLedger` would do to a file, read without writing anything (`planMigration`). */
export interface MigrationPlan {
	/** The canonical path the upgrade would open. */
	path: string;
	from: number;
	/** SCHEMA_VERSION; equal to `from` when the file is already current and nothing would be written. */
	to: number;
	/** Each upgrade step in the order it runs, with the triggers it creates. Empty when current. */
	steps: { from: number; to: number; addsTriggers: readonly string[] }[];
	/** Workloads held under a live lease. Non-empty only with `force`: without it they are refused (LedgerHeldError). */
	held: { id: string; holder: string; lease: string | null }[];
	/** SQL that takes the upgraded file back to `from` losslessly, or null when nothing would be upgraded. */
	undo: string | null;
}

/**
 * Every check `migrateLedger` makes before it writes, on a connection that writes nothing
 * (`inspect`), and the upgrade those checks lead to. Throws what the upgrade would throw before
 * its snapshot: LedgerSchemaVersionError for a version `MIGRATIONS` does not lead from,
 * LedgerTriggerDriftError for a file whose triggers are not its version's, and LedgerHeldError
 * for a live lease unless `force`. This is migrate.ts's `--dry-run` and its preview.
 */
export function planMigration(path: string, opts: Pick<MigrateOptions, "force" | "skipLocalityCheck"> = {}): MigrationPlan {
	assertNotLiveLedgerUnderTest(path);
	const target = opts.skipLocalityCheck ? path : assertLocalPath(path);
	if (!existsSync(target)) throw new Error(`no ledger at ${target}`);
	const { from, held } = inspect(target, 5, (r) => {
		const found = userVersion(r);
		if (found !== SCHEMA_VERSION && !MIGRATIONS[found]) throw new LedgerSchemaVersionError(target, found);
		assertTriggers(r, target);
		const holds = found === SCHEMA_VERSION ? [] : liveHolds(r);
		if (holds.length && !opts.force) throw new LedgerHeldError(target, holds);
		return { from: found, held: holds };
	});
	if (from === SCHEMA_VERSION) return { path: target, from, to: from, steps: [], held, undo: null };
	const steps: MigrationPlan["steps"] = [];
	for (let at = from; at !== SCHEMA_VERSION; at = MIGRATIONS[at]!.to) steps.push({ from: at, ...MIGRATIONS[at]! });
	const drops = [...steps].reverse().flatMap((s) => [...s.addsTriggers].reverse().map((name) => `DROP TRIGGER ${name};`));
	const undo = ["BEGIN IMMEDIATE;", ...drops, `PRAGMA user_version = ${from};`, "COMMIT;"].join(" ");
	return { path: target, from, to: SCHEMA_VERSION, steps, held, undo };
}

/**
 * The explicit upgrade (ledger/scripts/migrate.ts). Every check before the snapshot is
 * `planMigration`'s, on a connection that writes nothing: a file at SCHEMA_VERSION is checked and
 * left untouched, never opened read-write; a file at any version `MIGRATIONS` does not lead from is
 * refused (LedgerSchemaVersionError); a file whose triggers drift from its version's set is refused
 * (LedgerTriggerDriftError); a file a lane holds under a live lease is refused unless `force`
 * (LedgerHeldError, the early refusal). Then it is snapshotted with `VACUUM INTO` beside it, and the
 * snapshot checked to be a complete copy at `from`; then `beforeUpgrade` gets the snapshot and the
 * undo; then `upgrade` runs, which checks the version and the holders again under its write lock.
 * A throw means the upgrade did not commit; a snapshot already written stays where it was written.
 */
export function migrateLedger(path: string, opts: MigrateOptions = {}): MigrateResult {
	const plan = planMigration(path, opts);
	const { path: target, from } = plan;
	if (plan.undo === null) return { path: target, from, to: from, snapshot: null, undo: null };
	const undo = plan.undo;
	const db = new Database(target, { readwrite: true, create: false, strict: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA foreign_keys = ON");
		retryBusy(5, () => db.exec("PRAGMA synchronous = FULL"));
		let snapshot: string | null = null;
		if (opts.snapshot !== false) {
			snapshot = snapshotPath(target, opts.now?.() ?? new Date());
			if (existsSync(snapshot)) throw new Error(`snapshot ${snapshot} already exists; nothing was written`);
			retryBusy(5, () => db.exec(`VACUUM INTO '${snapshot!.replaceAll("'", "''")}'`));
			const problem = copyProblem(snapshot);
			const copy = new Database(snapshot, { readonly: true });
			const copyVersion = userVersion(copy);
			copy.close();
			if (problem || copyVersion !== from) throw new Error(`snapshot ${snapshot} is not a complete version-${from} copy (${problem ?? `version ${copyVersion}`}); the ledger was not upgraded`);
		}
		opts.beforeUpgrade?.({ path: target, from, snapshot, undo });
		const to = retryBusy(5, () => upgrade(db, target, from, !!opts.force));
		return { path: target, from, to, snapshot, undo };
	} finally {
		db.close();
	}
}

/** Where `migrateLedger` writes the pre-upgrade snapshot of `target` taken at `at`: beside it, `<stem>-pre-v<N>-<time>.db`. */
export function snapshotPath(target: string, at: Date): string {
	return join(dirname(target), `${basename(target).replace(/\.db$/, "")}-pre-v${SCHEMA_VERSION}-${at.toISOString().replaceAll(":", "-")}.db`);
}

export type Stakes = "throwaway" | "normal" | "production";
export type Mode = "autonomous" | "user-driven";
export type SliceState = "open" | "paused" | "done" | "cancelled";
export type MessageState = "held" | "delivered" | "consumed" | "acted-on";
export type QuestionState = "open" | "answered" | "withdrawn";
export type InstructionKind = "instruction" | "answer" | "withdrawal" | "mode-flip";
export type Channel = "surface" | "direct";
export type RoutingKind = "locate" | "understand" | "change-small" | "change-large" | "judge";
export type Tier = "fast" | "standard" | "strong" | "deep";
/** What happened to a dispatch (schema v4): `ran` on its row, or why its output never reached the lane. */
export type RoutingOutcome = "ran" | "refused-out-of-row" | "refused-no-usable-model" | "refused-model-unknown";
/** Lane-written entry kinds (P-11 rows 7, mode, question, 6). */
export type EntryKind = "wake-read" | "mode-effective" | "assumption" | "reserved-request";

/** `by` on every write is the lane instance doing the write: the provenance the file demands. */
export interface Stamp {
	by: string;
}

/** Stamps of the two launcher processes (DESIGN-lane-launcher.md § 5): the starter reserves, the runner reports. */
export const LANE_STARTER_BY = "lane-starter";
export const LANE_RUNNER_BY = "lane-runner";
/**
 * Stamp of the classifier's lost-hand settle (MIGRATION.md item 118, PLAN wl-mv64rsqw2fcs1s D3): the routing row,
 * `hand-settled:` and `review-round: … failed-dispatch` it writes for a review hand no recorded process can still run.
 * Lane tools stamp the lane's own id, so no lane writes it.
 */
export const CLASSIFIER_BY = "classifier";
/** Stamp of the outside-the-fence test runner (MIGRATION.md item 24): its starter and its detached run write `test-requested:` / `test-run:` and settle the full-suite slice. */
export const TEST_RUNNER_BY = "test-runner";
/** The body shape of a launch attempt; only `reserveLane` writes one, and the ordinal counts them. */
export const LAUNCH_ATTEMPT_GLOB = "launch: *";

export type ReleaseResult = { released: true } | { released: false; holder: string | null };
export type HandoffResult = { ok: true } | { ok: false; holder: string | null };
export type ParkResult = { parked: false } | { parked: true; open: number };
export type ReserveResult = { ok: true; laneId: string; cause: string } | { ok: false; reason: string };
/**
 * What `reserveLane` reads inside its transaction and hands to the caller's policy. The policy is
 * injected because the launch predicate and the interactive policy know the surface's constants
 * (the standing workload, `due:` briefs, the control prefixes) and this module does not.
 */
export interface ReserveRows {
	workload: WorkloadRow;
	entries: EntryRow[];
	questions: QuestionRow[];
	instructions: InstructionRow[];
	slices: SliceRow[];
	/** Every holder the workload ever had, oldest first (`holders`). */
	holders: string[];
	/** Open autonomous workloads held by a `lane-*` holder whose lease is null or not yet lapsed at `now`. */
	liveLanes: number;
	cap: number;
	now: string;
}
export type ReserveVerdict = { launch: true; cause: string } | { launch: false; reason: string };

export interface WorkloadRow {
	id: string;
	brief: string;
	stakes: Stakes;
	mode: Mode;
	status: "open" | "closed";
	holder: string | null;
	holder_lease_until: string | null;
	closed_at: string | null;
	created_by: string;
	created_at: string;
	changed_by: string;
	changed_at: string;
	rev: number;
}
export interface WorkloadStatusRow extends WorkloadRow {
	last_activity_at: string;
	open_slices: number;
	paused_slices: number;
	open_questions: number;
	held_messages: number;
	oldest_held_at: string | null;
}
export interface SliceRow {
	id: string;
	workload_id: string;
	task: string;
	done_condition: string;
	inputs: string;
	state: SliceState;
	artifact: string | null;
	created_by: string;
	created_at: string;
	changed_by: string;
	changed_at: string;
	rev: number;
}
export interface MessageRow {
	id: string;
	workload_id: string;
	slice_id: string | null;
	sender: string;
	recipient: string;
	body: string;
	state: MessageState;
	created_by: string;
	created_at: string;
	changed_by: string;
	changed_at: string;
	rev: number;
}
export interface QuestionRow {
	id: string;
	workload_id: string;
	slice_id: string;
	body: string;
	options: string;
	state: QuestionState;
	resolved_by: string | null;
	created_by: string;
	created_at: string;
	changed_by: string;
	changed_at: string;
	rev: number;
}
export interface InstructionRow {
	id: string;
	workload_id: string;
	slice_id: string | null;
	kind: InstructionKind;
	question_id: string | null;
	/** For a withdrawal: what happens to the paused slice once no question on it is open. */
	disposition: "cancel" | "replan" | null;
	channel: Channel;
	author: string;
	body: string;
	created_by: string;
	created_at: string;
}
export interface RoutingRow {
	id: string;
	workload_id: string;
	slice_id: string;
	/** The key the spawn event carried: the requested name for a blocking spawn, the allocated agent id for an async one. */
	spawn_key: string | null;
	/** The lane's session root (its session file without `.jsonl`): the directory its hands' session files are in. */
	session_root: string;
	/** The agent id OMP finally allocated to the hand (`<session_root>/<agent_id>.jsonl`); NULL exactly for `refused-no-usable-model`. */
	agent_id: string | null;
	kind: RoutingKind;
	confidence: number;
	/** JSON object: the judge's per-kind probabilities, as recorded. */
	probabilities: string;
	classified_tier: Tier;
	pull_up_to: Exclude<Tier, "fast"> | null;
	stakes: Stakes | null;
	pull_down_to: Exclude<Tier, "deep"> | null;
	tier: Tier;
	/** JSON array: the tier-row candidates usable at spawn, row order; empty exactly when the outcome is `refused-no-usable-model`. */
	models: string;
	/** The first entry of `models`: the spawn-time selection; NULL when `models` is empty. */
	model: string | null;
	judge_model: string;
	outcome: RoutingOutcome;
	/** JSON array: every model that answered, first-seen order; NULL exactly when none was read (outcome `refused-no-usable-model` or `refused-model-unknown`). */
	ran_models: string | null;
	created_by: string;
	created_at: string;
}
export interface EntryRow {
	id: string;
	workload_id: string;
	slice_id: string | null;
	kind: EntryKind;
	body: string;
	created_by: string;
	created_at: string;
}
export interface ProvenanceRow {
	seq: number;
	at: string;
	workload_id: string;
	lane_instance: string;
	tbl: string;
	row_id: string;
	action: "insert" | "update";
	detail: string | null;
}
/**
 * One M8 fact (MIGRATION.md row M8): an entry whose body is
 * `m8-fact #<n> [<tag>] repo=<repo> src=<path>:<a>-<b>[,…] :: <text>`, on any workload.
 * `src` is "" and `text` the trimmed rest when a contract row has no ` :: `.
 */
export interface FactRow {
	id: string;
	n: number;
	tag: string;
	repo: string;
	src: string;
	text: string;
	created_at: string;
}
export interface OldestHeld {
	id: string;
	workload_id: string;
	enqueued_at: string;
	age_seconds: number;
}
export interface InFlightWorkload {
	workload: WorkloadStatusRow;
	slices: SliceRow[];
	openQuestions: (Omit<QuestionRow, "options"> & { options: string[] })[];
	pendingMessages: MessageRow[];
}

export interface OpenOptions {
	/** Create the file and apply the schema when missing. Default false. */
	create?: boolean;
	/** busy_timeout in ms, set before anything else on the connection. Default 5000. */
	busyTimeoutMs?: number;
	/** Extra attempts after SQLITE_BUSY on a write, and on opening/initializing. Default 5. */
	busyRetries?: number;
	/** Clock for stamps; must return ISO-8601 UTC with milliseconds. Default Date#toISOString. */
	clock?: () => string;
	/** Skip the synced/network-folder refusal. Only for ":memory:"-like test paths; default false. */
	skipLocalityCheck?: boolean;
	/**
	 * The scheduled second copy's policy (where, how often, how many). `false` turns copies off
	 * for this connection.
	 */
	backup?: BackupPolicy | false;
	/**
	 * Take a due copy while opening an existing ledger: the opportunistic fallback to the periodic
	 * job. A failure is reported on stderr and does not fail the open. Default true. The backup job
	 * (ledger/scripts/backup.ts) turns it off and calls `backupIfDue` itself, so it sees failures.
	 */
	backupOnOpen?: boolean;
	/**
	 * Open a read-only SQLite connection: busy_timeout set and the schema version checked, but no
	 * foreign_keys or WAL pragma, no schema init and no backup, so the file is never written. Every
	 * write method then fails at SQLite (SQLITE_READONLY). Refused together with `create`. Default false.
	 */
	readonly?: boolean;
}

const ID_PREFIX = { workload: "wl", slice: "sl", message: "msg", question: "q", instruction: "in", routing: "rt", entry: "en" } as const;

/** `<prefix>-<ms since epoch, base36><6 random base36>`: sortable by creation, short enough to type. */
export function newId(kind: keyof typeof ID_PREFIX): string {
	const rand = crypto.getRandomValues(new Uint32Array(2));
	const tail = ((rand[0]! * 2 ** 32 + rand[1]!) % 36 ** 6).toString(36).padStart(6, "0");
	return `${ID_PREFIX[kind]}-${Date.now().toString(36)}${tail}`;
}

export class Ledger {
	readonly db: Database;
	/** The canonical path of the file (symlinks resolved): what was checked is what was opened. */
	readonly path: string;
	private readonly clock: () => string;
	private readonly busyRetries: number;
	private readonly backupPolicy: Required<BackupPolicy> | null;

	private constructor(db: Database, path: string, opts: OpenOptions) {
		this.db = db;
		this.path = path;
		this.clock = opts.clock ?? (() => new Date().toISOString());
		this.busyRetries = opts.busyRetries ?? 5;
		this.backupPolicy = opts.backup === false || opts.readonly ? null : {
			dir: join(opts.backup?.dir ?? join(dirname(path), "backups"), backupNamespace(path)),
			intervalMs: opts.backup?.intervalMs ?? BACKUP_DEFAULTS.intervalMs,
			keep: opts.backup?.keep ?? BACKUP_DEFAULTS.keep,
		};
	}

	/**
	 * Open the ledger at `path` (default: $AGENT_SYSTEM_LEDGER_DB or $HOME/.agent-system-2/ledger.db).
	 * The path is canonicalised and refused when synced or remote; the canonical path is opened.
	 * Before any read-write handle exists, an existing file's version is read through `inspect`, a
	 * connection that writes nothing (not the file, its -wal, or its -shm): opening never upgrades, so
	 * a file at a version `MIGRATIONS` leads from is refused with the command that upgrades it
	 * (LedgerNeedsMigrationError, `migrateLedger`), a file at any other version but the supported one
	 * or 0 is refused (LedgerSchemaVersionError), and a version-0 file that already holds schema
	 * objects is refused rather than initialized (LedgerNotEmptyError), all with the file, its -wal and
	 * its -shm byte-identical. A read-write handle would not be: SQLite's last connection checkpoints a
	 * crash-left WAL into the file on close. Then every read-write connection: busy_timeout first, then
	 * foreign_keys, then synchronous = FULL (a committed write survives power loss, not only a process
	 * crash; ledger audit A1-1), then WAL; initialization of a new file runs under the same busy-retry
	 * policy as every write. The version is checked again on that connection, and the file's triggers
	 * are compared with schema.sql's: a file whose set differs is refused (LedgerTriggerDriftError).
	 * Opening an existing ledger takes the scheduled backup when one is due, unless `backupOnOpen` is
	 * false. A `readonly` open sets busy_timeout and checks the version and triggers only: it writes no
	 * pragma. Under test, a path inside a live ledger root is refused before anything is opened
	 * (LiveLedgerUnderTestError; ledger/src/locality.ts, Guard A).
	 */
	static open(path: string = defaultLedgerPath(), opts: OpenOptions = {}): Ledger {
		if (opts.readonly && opts.create) throw new Error("a readonly ledger cannot be created: open with { readonly: true } or { create: true }, not both");
		// Under test, the target and the backup directory (the namespace under the root, the dir copies are written in) are refused inside a live root before anything is created or opened.
		assertNotLiveLedgerUnderTest(path);
		const target = opts.skipLocalityCheck ? path : assertLocalPath(path);
		if (opts.backup !== false && !opts.readonly) assertNotLiveLedgerUnderTest(join(opts.backup?.dir ?? join(dirname(target), "backups"), backupNamespace(target)));
		const fresh = !existsSync(target);
		if (fresh && !opts.create) throw new Error(`no ledger at ${target}; open with { create: true } or run the install script`);
		if (fresh) mkdirSync(dirname(target), { recursive: true });
		const retries = opts.busyRetries ?? 5;
		if (!fresh) {
			const { version: found, objects } = inspect(target, retries, (r) => ({ version: userVersion(r), objects: schemaObjects(r) }));
			if (MIGRATIONS[found]) throw new LedgerNeedsMigrationError(target, found);
			if (found === 0 && objects > 0) throw new LedgerNotEmptyError(target, objects);
			if (found !== 0 && found !== SCHEMA_VERSION) throw new LedgerSchemaVersionError(target, found);
		}
		const db = opts.readonly
			? new Database(target, { readonly: true, strict: true })
			: new Database(target, { readwrite: true, create: !!opts.create, strict: true });
		let initialized = false;
		try {
			db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 5000))}`);
			if (!opts.readonly) {
				db.exec("PRAGMA foreign_keys = ON");
				// Unlike foreign_keys, this pragma reads the schema, so it waits on a concurrent initializer.
				retryBusy(retries, () => db.exec("PRAGMA synchronous = FULL"));
			}
			if (!opts.readonly && retryBusy(retries, () => userVersion(db)) === 0) {
				if (!opts.create) throw new Error(`ledger at ${target} has no schema; open with { create: true }`);
				retryBusy(retries, () => ensureWal(db));
				initialized = retryBusy(retries, () => initialize(db, target));
			}
			const v = retryBusy(retries, () => userVersion(db));
			if (MIGRATIONS[v]) throw new LedgerNeedsMigrationError(target, v);
			if (v !== SCHEMA_VERSION) throw new LedgerSchemaVersionError(target, v);
			retryBusy(retries, () => assertTriggers(db, target));
			if (!opts.readonly) retryBusy(retries, () => ensureWal(db));
		} catch (e) {
			db.close();
			throw e;
		}
		const ledger = new Ledger(db, target, opts);
		if (!opts.readonly && !initialized && opts.backupOnOpen !== false) {
			try {
				ledger.backupIfDue();
			} catch (e) {
				// Under test a refused copy fails the open loudly; any other failed copy must not take the ledger down with it: it is reported, not swallowed.
				if (e instanceof LiveLedgerUnderTestError) {
					ledger.close();
					throw e;
				}
				console.error(`ledger: scheduled backup failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return ledger;
	}

	close(): void {
		this.db.close();
	}

	now(): string {
		return this.clock();
	}

	/** Run `fn` in BEGIN IMMEDIATE, retrying the whole transaction on SQLITE_BUSY (BEGIN or COMMIT). */
	write<T>(fn: () => T): T {
		return retryBusy(this.busyRetries, () => this.db.transaction(fn).immediate());
	}

	// ---- workloads -------------------------------------------------------------------------

	openWorkload(input: Stamp & { brief: string; stakes: Stakes; mode: Mode; id?: string }): string {
		const id = input.id ?? newId("workload");
		const t = this.now();
		this.write(() =>
			this.db.query(
				`INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(id, input.brief, input.stakes, input.mode, input.by, t, input.by, t),
		);
		return id;
	}

	/**
	 * Claim (or renew) the workload for `holder` with a lease of `leaseMs` (null: no expiry, e.g. Jo).
	 * Wins when the workload is open and unheld, already held by `holder`, or its lease has expired
	 * (reclaim). Otherwise returns the current holder; the file refuses a steal regardless.
	 */
	claimWorkload(id: string, input: Stamp & { holder: string; leaseMs: number | null }):
		{ won: true } | { won: false; holder: string | null; status: string | null } {
		const t = this.now();
		const until = input.leaseMs === null ? null : new Date(Date.parse(t) + input.leaseMs).toISOString();
		return this.write(() => {
			const won = this.db.query(
				`UPDATE workloads SET holder = ?, holder_lease_until = ?, changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1
				 WHERE id = ? AND status = 'open' AND (holder IS NULL OR holder = ?
				   OR (holder_lease_until IS NOT NULL AND holder_lease_until < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
				 RETURNING id`,
			).all(input.holder, until, input.by, t, id, input.holder);
			if (won.length === 1) return { won: true as const };
			const row = this.db.query<{ holder: string | null; status: string }, [string]>(
				"SELECT holder, status FROM workloads WHERE id = ?",
			).get(id);
			return { won: false as const, holder: row?.holder ?? null, status: row?.status ?? null };
		});
	}

	/**
	 * Release only when `holder` still holds the workload (DESIGN-lane-launcher.md decision 5): a
	 * stale lane cannot release a live one. Zero rows is the typed refusal, naming the current holder.
	 */
	releaseWorkload(id: string, input: Stamp & { holder: string }): ReleaseResult {
		const t = this.now();
		return this.write(() => {
			const rows = this.db.query(
				`UPDATE workloads SET holder = NULL, holder_lease_until = NULL, changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1
				 WHERE id = ? AND holder = ? RETURNING id`,
			).all(input.by, t, id, input.holder);
			if (rows.length === 1) return { released: true as const };
			const row = this.db.query<{ holder: string | null }, [string]>("SELECT holder FROM workloads WHERE id = ?").get(id);
			return { released: false as const, holder: row?.holder ?? null };
		});
	}

	/**
	 * What a launch decision reads (the surface's own predicate run, and `reserveLane` inside its
	 * transaction): the workload row, its entries, questions, instructions and slices, and the
	 * live-lane count at `now`. Null when there is no such workload.
	 */
	launchRows(workloadId: string, cap: number): ReserveRows | null {
		const now = this.now();
		const workload = this.db.query<WorkloadRow, [string]>("SELECT * FROM workloads WHERE id = ?").get(workloadId);
		if (!workload) return null;
		return {
			workload,
			entries: this.entries(workloadId),
			questions: this.questions(workloadId),
			instructions: this.instructions(workloadId),
			slices: this.slices(workloadId),
			holders: this.holders(workloadId),
			liveLanes: this.liveLaneHolders(now).length,
			cap,
			now,
		};
	}

	/** The `lane-*` holders of open autonomous workloads under a lease that is null or not yet lapsed at `now`, with their workload ids. */
	liveLaneHolders(now: string = this.now()): { workloadId: string; holder: string }[] {
		return this.db.query<{ id: string; holder: string }, [string]>(
			`SELECT id, holder FROM workloads
			 WHERE mode = 'autonomous' AND status = 'open' AND holder GLOB 'lane-*'
			   AND (holder_lease_until IS NULL OR holder_lease_until >= ?) ORDER BY created_at, id`,
		).all(now).map((r) => ({ workloadId: r.id, holder: r.holder }));
	}

	/**
	 * Reserve a lane on the workload (decision 8): one transaction reads the workload row, its entries,
	 * questions, instructions and slices and the live-lane count, hands them to `decide`, and on a
	 * launch verdict mints the ordinal, pre-claims for the lane id with `leaseMs` (stamped `by`, the
	 * starter, so the lane's own claim is a real readiness signal) and writes the attempt entry
	 * `launch: <laneId> cause <cause> requested-by <who>`. A refusal returns before any write.
	 */
	reserveLane(workloadId: string, input: Stamp & {
		cap: number; leaseMs: number; requestedBy: string; decide: (rows: ReserveRows) => ReserveVerdict;
	}): ReserveResult {
		return this.write(() => {
			const rows = this.launchRows(workloadId, input.cap);
			if (!rows) return { ok: false as const, reason: "no such workload" };
			const verdict = input.decide(rows);
			if (!verdict.launch) return { ok: false as const, reason: verdict.reason };
			const attempts = this.db.query<{ n: number }, [string, string]>(
				"SELECT count(*) AS n FROM entries WHERE workload_id = ? AND kind = 'assumption' AND body GLOB ?").get(workloadId, LAUNCH_ATTEMPT_GLOB);
			const laneId = `lane-${workloadId.replace(/^wl-/, "")}-${1 + (attempts?.n ?? 0)}`;
			const claim = this.claimWorkload(workloadId, { by: input.by, holder: laneId, leaseMs: input.leaseMs });
			if (!claim.won) return { ok: false as const, reason: "held" };
			this.recordEntry({ by: input.by, workloadId, kind: "assumption", body: `launch: ${laneId} cause ${verdict.cause} requested-by ${input.requestedBy}` });
			return { ok: true as const, laneId, cause: verdict.cause };
		});
	}

	/**
	 * The park decision (decision 14), in one transaction with the question read: when a question
	 * this lane raised is open, or resolved (answer or replan withdrawal) by an instruction no
	 * `launch:` attempt names, write `lane-parked: <laneId> questions <ids> session <path>`.
	 */
	parkLane(workloadId: string, input: Stamp & { laneId: string; session: string }): ParkResult {
		return this.write(() => {
			const questions = this.db.query<QuestionRow, [string, string]>(
				"SELECT * FROM questions WHERE workload_id = ? AND created_by = ? ORDER BY created_at, id").all(workloadId, input.laneId);
			const attempts = this.db.query<{ body: string }, [string, string, string]>(
				"SELECT body FROM entries WHERE workload_id = ? AND kind = 'assumption' AND created_by = ? AND body GLOB ?",
			).all(workloadId, LANE_STARTER_BY, LAUNCH_ATTEMPT_GLOB);
			const consumed = new Set(attempts.flatMap((a) => a.body.split(/\s+/)));
			const pending: string[] = [];
			let open = 0;
			for (const q of questions) {
				if (q.state === "open") {
					open += 1;
					pending.push(q.id);
					continue;
				}
				if (q.resolved_by === null || consumed.has(q.resolved_by)) continue;
				const resolution = this.db.query<InstructionRow, [string]>("SELECT * FROM instructions WHERE id = ?").get(q.resolved_by);
				if (resolution && (resolution.kind === "answer" || resolution.disposition === "replan")) pending.push(q.id);
			}
			if (pending.length === 0) return { parked: false as const };
			this.recordEntry({
				by: input.by, workloadId, kind: "assumption",
				body: `lane-parked: ${input.laneId} questions ${pending.join(",")} session ${input.session}`,
			});
			return { parked: true as const, open };
		});
	}

	/**
	 * § B5's "I've got X": the holder-checked release, then the claim for `to` with no lease, in one
	 * transaction. Two statements because a direct holder change under a live lease is what
	 * `workloads_holder_no_steal` refuses; zero rows on the release is the typed `not the holder`.
	 */
	handoffWorkload(id: string, input: Stamp & { holder: string; to: string }): HandoffResult {
		return this.write(() => {
			const released = this.releaseWorkload(id, { by: input.by, holder: input.holder });
			if (!released.released) return { ok: false as const, holder: released.holder };
			const claim = this.claimWorkload(id, { by: input.by, holder: input.to, leaseMs: null });
			if (!claim.won) throw new Error(`handoff of ${id} to ${input.to}: claim lost inside the transaction (holder ${claim.holder})`);
			return { ok: true as const };
		});
	}

	setStakes(id: string, input: Stamp & { stakes: Stakes }): void {
		const t = this.now();
		this.write(() => this.expectOne(
			`UPDATE workloads SET stakes = ?, changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1 WHERE id = ? RETURNING id`,
			[input.stakes, input.by, t, id], `workload ${id}`));
	}

	/** Flip mode: the mode-flip instruction and the flip land in one transaction (§ B13.1). */
	flipMode(id: string, input: Stamp & { mode: Mode; author: string; channel: Channel }): string {
		return this.write(() => {
			const instructionId = this.insertInstruction({
				workloadId: id, kind: "mode-flip", body: input.mode, author: input.author, channel: input.channel, by: input.by,
			});
			const t = this.now();
			this.expectOne(
				`UPDATE workloads SET mode = ?, changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1 WHERE id = ? RETURNING id`,
				[input.mode, input.by, t, id], `workload ${id}`);
			return instructionId;
		});
	}

	/**
	 * Close, in one transaction with the checks (Codex review S2): refused — nothing written — while a
	 * holder's lease is null or not yet lapsed, so a lane that reserved the workload while the close
	 * tool waited on git keeps it; the schema trigger refuses open slices and questions the same way.
	 */
	closeWorkload(id: string, input: Stamp): void {
		const t = this.now();
		this.write(() => {
			const held = this.db.query<{ holder: string }, [string, string]>(
				"SELECT holder FROM workloads WHERE id = ? AND holder IS NOT NULL AND (holder_lease_until IS NULL OR holder_lease_until >= ?)").get(id, t);
			if (held) throw new Error(`cannot close workload ${id}: held by ${held.holder} under a live lease`);
			this.expectOne(
				`UPDATE workloads SET status = 'closed', closed_at = max(changed_at, ?), holder = NULL, holder_lease_until = NULL,
				   changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1
				 WHERE id = ? RETURNING id`, [t, input.by, t, id], `workload ${id}`);
		});
	}

	workload(id: string): WorkloadStatusRow | null {
		return this.db.query<WorkloadStatusRow, [string]>("SELECT * FROM workload_status WHERE id = ?").get(id);
	}

	// ---- slices ----------------------------------------------------------------------------

	addSlice(input: Stamp & { workloadId: string; task: string; doneCondition: string; inputs: string; id?: string }): string {
		const id = input.id ?? newId("slice");
		const t = this.now();
		this.write(() => this.db.query(
			`INSERT INTO slices (id, workload_id, task, done_condition, inputs, created_by, created_at, changed_by, changed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, input.workloadId, input.task, input.doneCondition, input.inputs, input.by, t, input.by, t));
		return id;
	}

	/** Close a slice on its runtime artifact (§ B1). */
	completeSlice(id: string, input: Stamp & { artifact: string }): void {
		this.setSliceState(id, "done", input.by, input.artifact);
	}

	cancelSlice(id: string, input: Stamp): void {
		this.setSliceState(id, "cancelled", input.by, null);
	}

	slice(id: string): SliceRow | null {
		return this.db.query<SliceRow, [string]>("SELECT * FROM slices WHERE id = ?").get(id);
	}

	/** A workload's slices, oldest first; one millisecond's slices in insertion order (rowid), never by their random id. */
	slices(workloadId: string): SliceRow[] {
		return this.db.query<SliceRow, [string]>("SELECT * FROM slices WHERE workload_id = ? ORDER BY created_at, rowid").all(workloadId);
	}

	private setSliceState(id: string, state: SliceState, by: string, artifact: string | null): void {
		const t = this.now();
		this.write(() => this.expectOne(
			`UPDATE slices SET state = ?, artifact = ?, changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1
			 WHERE id = ? RETURNING id`, [state, artifact, by, t, id], `slice ${id}`));
	}

	// ---- messages --------------------------------------------------------------------------

	enqueue(input: Stamp & { workloadId: string; sliceId?: string | null; sender: string; recipient: string; body: string; id?: string }): string {
		const id = input.id ?? newId("message");
		const t = this.now();
		this.write(() => this.db.query(
			`INSERT INTO messages (id, workload_id, slice_id, sender, recipient, body, created_by, created_at, changed_by, changed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, input.workloadId, input.sliceId ?? null, input.sender, input.recipient, input.body, input.by, t, input.by, t));
		return id;
	}

	/** One step forward: held -> delivered -> consumed -> acted-on. The file refuses anything else. */
	advanceMessage(id: string, to: Exclude<MessageState, "held">, input: Stamp): void {
		const t = this.now();
		this.write(() => this.expectOne(
			`UPDATE messages SET state = ?, changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1 WHERE id = ? RETURNING id`,
			[to, input.by, t, id], `message ${id}`));
	}

	message(id: string): MessageRow | null {
		return this.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(id);
	}

	// ---- instructions ----------------------------------------------------------------------

	/** Jo's instruction to a lane (§ B5), from the surface or a direct session. */
	recordInstruction(input: Stamp & { workloadId: string; sliceId?: string | null; body: string; author: string; channel: Channel }): string {
		return this.write(() => this.insertInstruction({ ...input, kind: "instruction" }));
	}

	instructions(workloadId: string): InstructionRow[] {
		return this.db.query<InstructionRow, [string]>(
			"SELECT * FROM instructions WHERE workload_id = ? ORDER BY created_at, rowid").all(workloadId);
	}

	private insertInstruction(input: Stamp & {
		workloadId: string; sliceId?: string | null; kind: InstructionKind; questionId?: string | null;
		disposition?: "cancel" | "replan" | null; body: string; author: string; channel: Channel;
	}): string {
		const id = newId("instruction");
		const t = this.now();
		this.db.query(
			`INSERT INTO instructions (id, workload_id, slice_id, kind, question_id, disposition, channel, author, body, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, input.workloadId, input.sliceId ?? null, input.kind, input.questionId ?? null, input.disposition ?? null,
			input.channel, input.author, input.body, input.by, t);
		return id;
	}

	// ---- questions -------------------------------------------------------------------------

	/** A lane-raised question (§ B3 item 5). The file pauses its slice in the same statement. */
	raiseQuestion(input: Stamp & { workloadId: string; sliceId: string; body: string; options: string[]; id?: string }): string {
		const id = input.id ?? newId("question");
		const t = this.now();
		this.write(() => this.db.query(
			`INSERT INTO questions (id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, input.workloadId, input.sliceId, input.body, JSON.stringify(input.options), input.by, t, input.by, t));
		return id;
	}

	/** Jo's answer: an answer instruction, then the question resolved by it; the file settles the slice. */
	answerQuestion(questionId: string, input: Stamp & { answer: string; author: string; channel: Channel }): string {
		return this.resolveQuestion(questionId, "answer", input.answer, null, input);
	}

	/**
	 * Jo's answer to a question asked on another workload's behalf (the orchestrator's, raised on
	 * its standing slice): the answer instruction resolving the row, and in the same transaction a
	 * plain `instruction` on `mirror.workloadId` carrying the decision where that workload's lanes
	 * read it (an `instruction` row cannot name a question: schema.sql instructions CHECK). The
	 * mirror needs an open workload; a closed one aborts both writes.
	 */
	answerQuestionMirrored(questionId: string, input: Stamp & { answer: string; author: string; channel: Channel; mirror: { workloadId: string; body: string } }): { answerId: string; mirrorId: string } {
		return this.write(() => {
			const answerId = this.resolveQuestion(questionId, "answer", input.answer, null, input);
			const mirrorId = this.insertInstruction({
				workloadId: input.mirror.workloadId, kind: "instruction", body: input.mirror.body,
				author: input.author, channel: input.channel, by: input.by,
			});
			return { answerId, mirrorId };
		});
	}

	/**
	 * Jo's withdrawal: never counts as approval. `then` is recorded on the withdrawal instruction
	 * and the file honours it once no question on the slice is open: "cancel" cancels the slice
	 * (even if other questions are answered in between), "replan" lets it run again.
	 */
	withdrawQuestion(questionId: string, input: Stamp & { reason: string; author: string; channel: Channel; then: "cancel" | "replan" }): string {
		return this.resolveQuestion(questionId, "withdrawal", input.reason, input.then, input);
	}

	question(id: string): QuestionRow | null {
		return this.db.query<QuestionRow, [string]>("SELECT * FROM questions WHERE id = ?").get(id);
	}

	/** A workload's questions, oldest first. */
	questions(workloadId: string): QuestionRow[] {
		return this.db.query<QuestionRow, [string]>("SELECT * FROM questions WHERE workload_id = ? ORDER BY created_at, id").all(workloadId);
	}

	private resolveQuestion(questionId: string, kind: "answer" | "withdrawal", body: string,
		disposition: "cancel" | "replan" | null, input: Stamp & { author: string; channel: Channel }): string {
		return this.write(() => {
			const q = this.db.query<{ workload_id: string; slice_id: string }, [string]>(
				"SELECT workload_id, slice_id FROM questions WHERE id = ?").get(questionId);
			if (!q) throw new Error(`no question ${questionId}`);
			const instructionId = this.insertInstruction({
				workloadId: q.workload_id, sliceId: q.slice_id, kind, questionId, disposition, body,
				author: input.author, channel: input.channel, by: input.by,
			});
			const t = this.now();
			this.expectOne(
				`UPDATE questions SET state = ?, resolved_by = ?, changed_by = ?, changed_at = max(changed_at, ?), rev = rev + 1
				 WHERE id = ? RETURNING id`,
				[kind === "answer" ? "answered" : "withdrawn", instructionId, input.by, t, questionId], `question ${questionId}`);
			return instructionId;
		});
	}

	// ---- routings --------------------------------------------------------------------------

	/**
	 * One dispatch's routing (§ A1.3, § B4), written once its outcome is known. Append-only.
	 * `model` is stored as `models[0]` (NULL for an empty row); the file checks that agreement, that
	 * `models` is empty exactly for `refused-no-usable-model`, that `ranModels` is given exactly for
	 * `ran` and `refused-out-of-row`, that both model lists hold only non-blank strings with no model
	 * repeated in `ranModels` (trigger routings_model_lists), that `agentId` is given exactly when a
	 * hand ran (every outcome but `refused-no-usable-model`), that one session root holds one row per
	 * agent id (trigger routings_one_row_per_hand), and that the slice belongs to the open workload.
	 * The model lists are also checked here, before the write, with the same rule.
	 */
	recordRouting(input: Stamp & {
		workloadId: string; sliceId: string; spawnKey?: string | null; sessionRoot: string; agentId?: string | null;
		kind: RoutingKind; confidence: number; probabilities: Record<string, number>; classifiedTier: Tier;
		pullUpTo?: Exclude<Tier, "fast"> | null; stakes?: Stakes | null; pullDownTo?: Exclude<Tier, "deep"> | null;
		tier: Tier; models: string[]; judgeModel: string; outcome: RoutingOutcome; ranModels?: string[] | null;
	}): string {
		// The module's copy of the routings_model_lists element rule, with String#trim's whitespace set
		// (schema.sql spells out the same set, astra review 4 N1). A non-array is left to the column CHECKs.
		const ran = input.ranModels;
		const blank = [input.models, ran ?? []].some((list) => Array.isArray(list) && !list.every((name) => typeof name === "string" && name.trim() !== ""));
		if (blank || (Array.isArray(ran) && new Set(ran).size !== ran.length)) {
			throw new Error("routing models and ran_models must be JSON arrays of distinct non-blank model names");
		}
		const id = newId("routing");
		const t = this.now();
		this.write(() => this.db.query(
			`INSERT INTO routings (id, workload_id, slice_id, spawn_key, session_root, agent_id, kind, confidence, probabilities,
			   classified_tier, pull_up_to, stakes, pull_down_to, tier, models, model, judge_model, outcome, ran_models, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, input.workloadId, input.sliceId, input.spawnKey ?? null, input.sessionRoot, input.agentId ?? null,
			input.kind, input.confidence, JSON.stringify(input.probabilities), input.classifiedTier, input.pullUpTo ?? null,
			input.stakes ?? null, input.pullDownTo ?? null, input.tier, JSON.stringify(input.models), input.models[0] ?? null,
			input.judgeModel, input.outcome, input.ranModels ? JSON.stringify(input.ranModels) : null, input.by, t));
		return id;
	}

	routings(workloadId: string): RoutingRow[] {
		return this.db.query<RoutingRow, [string]>(
			"SELECT * FROM routings WHERE workload_id = ? ORDER BY created_at, rowid").all(workloadId);
	}

	/**
	 * The rows for one hand: exactly this session root and this allocated agent id, oldest first. The
	 * file holds at most one (routings_one_row_per_hand); a refused spawn's row has no agent id, so it
	 * never matches.
	 */
	routingsForHand(sessionRoot: string, agentId: string): RoutingRow[] {
		return this.db.query<RoutingRow, [string, string]>(
			"SELECT * FROM routings WHERE session_root = ? AND agent_id = ? ORDER BY created_at, rowid").all(sessionRoot, agentId);
	}

	// ---- entries ---------------------------------------------------------------------------

	/** A lane-written entry (P-11). Append-only. In the gates' port, `GateLedger` in gates/src/types.ts. */
	recordEntry(input: Stamp & { workloadId: string; sliceId?: string | null; kind: EntryKind; body: string }): string {
		const id = newId("entry");
		const t = this.now();
		this.write(() => this.db.query(
			`INSERT INTO entries (id, workload_id, slice_id, kind, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(id, input.workloadId, input.sliceId ?? null, input.kind, input.body, input.by, t));
		return id;
	}

	/** A workload's entries, of one kind when `kind` is given, oldest first. */
	entries(workloadId: string, kind?: EntryKind): EntryRow[] {
		return kind === undefined
			? this.db.query<EntryRow, [string]>("SELECT * FROM entries WHERE workload_id = ? ORDER BY created_at, rowid").all(workloadId)
			: this.db.query<EntryRow, [string, string]>(
				"SELECT * FROM entries WHERE workload_id = ? AND kind = ? ORDER BY created_at, rowid").all(workloadId, kind);
	}

	/** One entry by id, on any workload (open or closed), or null. */
	entry(id: string): EntryRow | null {
		return this.db.query<EntryRow, [string]>("SELECT * FROM entries WHERE id = ?").get(id);
	}

	/**
	 * The M8 facts for `repo` (MIGRATION.md row M8's reader contract, and the only reader of
	 * `m8-fact` bodies in the codebase): entries on any workload, open or closed, whose body matches
	 * `LIKE 'm8-fact #% [m8-%] repo=' || repo || ' src=%'` with `\`, `%` and `_` in `repo` escaped, so
	 * a repo path is a literal. Each is then parsed on fixed delimiters around the known repo (paths
	 * may hold spaces): the body must start `m8-fact #<digits> [<tag without ]>] repo=<repo> src=`,
	 * compared exactly and case-sensitively; `src` runs to the first ` :: ` and `text` is the rest.
	 * A contract row with no ` :: ` is kept with `src` "" and `text` the trimmed rest. Every batch
	 * named by an `m8-rollback [<tag>]` entry on any workload is dropped. Ordered by `n`, then
	 * created_at, then id. Read-only: no write, no transaction.
	 */
	facts(repo: string): FactRow[] {
		const pattern = repo.replace(/[\\%_]/g, (c) => `\\${c}`);
		const rows = this.db.query<{ id: string; body: string; created_at: string }, [string]>(
			`SELECT id, body, created_at FROM entries WHERE body LIKE 'm8-fact #% [m8-%] repo=' || ? || ' src=%' ESCAPE '\\'
			 ORDER BY created_at, id`,
		).all(pattern);
		const rolledBack = new Set<string>();
		for (const { body } of this.db.query<{ body: string }, []>("SELECT body FROM entries WHERE body LIKE 'm8-rollback [%'").all()) {
			const m = /^m8-rollback \[([^\]]+)\]/.exec(body);
			if (m) rolledBack.add(m[1]!);
		}
		const facts: FactRow[] = [];
		for (const { id, body, created_at } of rows) {
			const head = /^m8-fact #(\d+) \[(m8-[^\]]*)\] repo=/.exec(body);
			if (!head || rolledBack.has(head[2]!)) continue;
			const after = body.slice(head[0].length);
			if (!after.startsWith(`${repo} src=`)) continue;
			const rest = after.slice(repo.length + " src=".length);
			const cut = rest.indexOf(" :: ");
			facts.push({
				id, n: Number(head[1]), tag: head[2]!, repo,
				src: cut < 0 ? "" : rest.slice(0, cut),
				text: cut < 0 ? rest.trim() : rest.slice(cut + " :: ".length),
				created_at,
			});
		}
		// Array#sort is stable, so equal numbers keep the query's created_at, id order.
		return facts.sort((a, b) => a.n - b.n);
	}

	// ---- queries ---------------------------------------------------------------------------

	/**
	 * What is in flight (wake, § B7): every open workload with its open/paused slices, every open
	 * question (rendered regardless of any last-N window, § B3 item 5), and every message not yet
	 * acted on, oldest first.
	 */
	inFlight(): InFlightWorkload[] {
		const workloads = this.db.query<WorkloadStatusRow, []>(
			"SELECT * FROM workload_status WHERE status = 'open' ORDER BY created_at, id").all();
		return workloads.map((workload) => ({
			workload,
			slices: this.db.query<SliceRow, [string]>(
				"SELECT * FROM slices WHERE workload_id = ? AND state IN ('open', 'paused') ORDER BY created_at, rowid").all(workload.id),
			openQuestions: this.db.query<QuestionRow, [string]>(
				"SELECT * FROM questions WHERE workload_id = ? AND state = 'open' ORDER BY created_at, id").all(workload.id)
				.map((q) => ({ ...q, options: JSON.parse(q.options) as string[] })),
			pendingMessages: this.db.query<MessageRow, [string]>(
				"SELECT * FROM messages WHERE workload_id = ? AND state <> 'acted-on' ORDER BY created_at, id").all(workload.id),
		}));
	}

	/** The oldest held message and its age at `at` (§ B3), or null when nothing is held. */
	oldestHeld(at: string = this.now(), workloadId?: string): OldestHeld | null {
		const sql = `SELECT id, workload_id, created_at AS enqueued_at,
		               round((julianday(?1) - julianday(created_at)) * 86400.0, 3) AS age_seconds
		             FROM messages WHERE state = 'held' ${workloadId ? "AND workload_id = ?2" : ""}
		             ORDER BY created_at, id LIMIT 1`;
		const q = this.db.query<OldestHeld, [string] | [string, string]>(sql);
		return (workloadId ? q.get(at, workloadId) : q.get(at)) ?? null;
	}

	provenance(workloadId: string): ProvenanceRow[] {
		return this.db.query<ProvenanceRow, [string]>(
			"SELECT * FROM provenance WHERE workload_id = ? ORDER BY seq").all(workloadId);
	}

	/**
	 * Every holder the workload ever had, oldest first, once each: the new side of each `holder a->b`
	 * change the workloads provenance trigger records (schema.sql `workloads_log_update`). A lane that
	 * claimed by hand and released leaves no `launch:` entry; this is how its `done-because:` stays a
	 * holder's receipt after the release (DESIGN-lane-launcher.md decision 16, the `awaiting-close` row).
	 */
	holders(workloadId: string): string[] {
		const out: string[] = [];
		for (const c of this.holderChanges(workloadId)) if (c.to !== null && !out.includes(c.to)) out.push(c.to);
		return out;
	}

	/** Every `holder a->b` change the workloads provenance trigger recorded, oldest first; `from` / `to` null for no holder (`-`). */
	holderChanges(workloadId: string): { at: string; from: string | null; to: string | null }[] {
		const rows = this.db.query<{ at: string; detail: string | null }, [string]>(
			"SELECT at, detail FROM provenance WHERE workload_id = ? AND tbl = 'workloads' AND action = 'update' ORDER BY seq").all(workloadId);
		const out: { at: string; from: string | null; to: string | null }[] = [];
		for (const r of rows) {
			const m = /(?:^|\s)holder (\S+?)->(\S+)/.exec(r.detail ?? "");
			if (m) out.push({ at: r.at, from: m[1] === "-" ? null : m[1]!, to: m[2] === "-" ? null : m[2]! });
		}
		return out;
	}

	/**
	 * A consistent snapshot via VACUUM INTO (never `cp` a WAL file). The snapshot is written to a
	 * temporary dot-file beside `destPath` (`.<name>.<pid>-<random>.tmp`, the pid being this writer's),
	 * checked with `copyProblem`, and only then linked to `destPath`, which must not exist; the
	 * temporary file is removed whether or not that succeeds. So `destPath` either appears as a
	 * complete copy or not at all. A writer killed before its `finally` leaves the temporary file;
	 * `backupIfDue` reclaims it once that pid is gone.
	 */
	backup(destPath: string): void {
		// Under test, a destination inside a live root (through a symlinked directory too) is refused before anything is written.
		assertNotLiveLedgerUnderTest(destPath);
		if (existsSync(destPath)) throw new Error(`backup target ${destPath} exists`);
		mkdirSync(dirname(destPath), { recursive: true });
		const tmp = join(dirname(destPath), `.${basename(destPath)}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
		try {
			this.db.query("VACUUM INTO ?").run(tmp);
			const problem = copyProblem(tmp);
			if (problem) throw new Error(`snapshot of ${this.path} is not a complete copy (${problem})`);
			linkSync(tmp, destPath); // fails if destPath appeared meanwhile; never replaces a copy
		} finally {
			for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(tmp + suffix, { force: true });
		}
	}

	/** This ledger's backup directory (`<root>/<backupNamespace>`), or null when copies are off. */
	get backupDir(): string | null {
		return this.backupPolicy?.dir ?? null;
	}

	/**
	 * Existing scheduled copies of this ledger, oldest first, with the time each was taken. Throws
	 * when the namespace directory's SOURCE file names another ledger: those copies are not ours.
	 */
	backups(): { path: string; at: string }[] {
		const dir = this.backupPolicy?.dir;
		if (!dir || !existsSync(dir)) return [];
		const source = join(dir, BACKUP_SOURCE_FILE);
		// Under test, a SOURCE that resolves inside a live root (a symlink, dangling or not) is refused before it is read.
		assertNotLiveLedgerUnderTest(source);
		if (existsSync(source)) {
			const owner = readFileSync(source, "utf8").trim();
			if (owner !== this.path) throw new Error(`backup directory ${dir} holds copies of ${owner}, not of ${this.path}`);
		}
		return readdirSync(dir).flatMap((name) => {
			const m = BACKUP_NAME.exec(name);
			return m ? [{ path: join(dir, name), at: `${m[1]}T${m[2]}:${m[3]}:${m[4]}` }] : [];
		}).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	}

	/**
	 * The scheduled second copy (§ B2 prior art e): when this ledger's newest complete copy is older
	 * than the interval (or there is none), take one named `ledger-<time>.db` in its backup directory
	 * and remove its copies beyond `keep`, oldest first. A file with a copy name that is not a
	 * complete copy never satisfies the age check; it is set aside (`newestCompleteCopy`). Returns
	 * the new copy's path, or null when none was due (or another connection already published the
	 * copy for this same instant). `force` takes one regardless of age. Throws when a due copy could
	 * not be taken, even if an older copy exists: the caller decides whether that is fatal (the
	 * backup job) or reported (open).
	 */
	backupIfDue(force = false): string | null {
		const policy = this.backupPolicy;
		if (!policy) return null;
		// Under test, a backup directory inside a live root is refused before its copies are read, set aside or written.
		assertNotLiveLedgerUnderTest(policy.dir);
		const now = this.now();
		const newest = this.newestCompleteCopy();
		if (!force && newest && Date.parse(now) - Date.parse(newest.at) < policy.intervalMs) return null;
		const dest = join(policy.dir, `ledger-${now.replace(/:/g, "-")}.db`);
		mkdirSync(policy.dir, { recursive: true });
		const source = join(policy.dir, BACKUP_SOURCE_FILE);
		assertNotLiveLedgerUnderTest(source);
		if (!existsSync(source)) writeFileSync(source, `${this.path}\n`);
		try {
			this.backup(dest);
		} catch (e) {
			// Another connection published a complete copy for this same instant; that copy is the
			// scheduled one. Any other failure propagates, even when an older copy exists.
			if (existsSync(dest) && !copyProblem(dest)) return null;
			throw e;
		}
		const all = this.backups();
		for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, policy.keep)))) {
			for (const suffix of ["", "-wal", "-shm"]) rmSync(old.path + suffix, { force: true });
		}
		// A writer killed between VACUUM INTO and its `finally` leaves its temporary snapshot behind.
		// Reclaim those whose writer is gone; a live writer's (or a reused pid's) is left alone.
		for (const name of readdirSync(policy.dir)) {
			const m = BACKUP_TEMP_NAME.exec(name);
			if (m && !processAlive(Number(m[1]))) rmSync(join(policy.dir, name), { force: true });
		}
		return dest;
	}

	/**
	 * The newest scheduled copy that is a complete copy (`copyProblem`), or null. A newer file that
	 * only carries the copy name (an empty or partial file left by an earlier version of this
	 * module) is set aside as `<name>.invalid` (or `.invalid.2`, `.invalid.3`, … when that name is
	 * taken; an earlier set-aside file is never replaced), reported on stderr, and never counts.
	 */
	private newestCompleteCopy(): { path: string; at: string } | null {
		for (const copy of this.backups().reverse()) {
			const problem = copyProblem(copy.path);
			if (!problem) return copy;
			for (let n = 1; ; n++) {
				const aside = `${copy.path}.invalid${n === 1 ? "" : `.${n}`}`;
				try {
					linkSync(copy.path, aside); // fails if `aside` exists; never replaces one
				} catch (e) {
					const code = e instanceof Error && "code" in e ? e.code : null;
					if (code === "EEXIST") continue;
					if (code === "ENOENT") break; // another connection set it aside
					throw e;
				}
				// Drop the copy name only if it still names the file just set aside.
				try {
					if (statSync(copy.path).ino === statSync(aside).ino) rmSync(copy.path);
				} catch (e) {
					if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
				}
				console.error(`ledger: set aside ${copy.path} as ${aside}, not a complete copy (${problem})`);
				break;
			}
		}
		return null;
	}

	private expectOne(sql: string, params: (string | number | null)[], what: string): void {
		if (this.db.query(sql).all(...params).length !== 1) throw new Error(`no ${what}`);
	}
}
