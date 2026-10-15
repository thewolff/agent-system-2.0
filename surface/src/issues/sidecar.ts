// The issues projection's own state (PLAN wl-mv66ylim0gahog § 2, § 3): `issues.db` beside the
// ledger, so a scratch ledger gets a scratch sidecar. The ledger stays the truth; this file is the
// outbox (cursor, links and their dirty set), the PR footers, intake verdicts, the hourly call count,
// small state and the drainer claim. Only the orchestrator surface's issues row writes it.
//
// Every time column the projector compares (`next_try_at`, `calls.at`, `claim.until`) is epoch ms.
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { assertNotLiveLedgerUnderTest, defaultLedgerPath } from "../../../ledger/src/locality";

export const SIDECAR_FILE = "issues.db";
/** How long a claim lasts without a renewal; every counted call renews it (§ 3 fencing). */
export const CLAIM_MS = 5 * 60_000;
const BUSY_MS = 5_000;
const HOUR_MS = 60 * 60_000;

/** `dirname(defaultLedgerPath(env))/issues.db`. */
export function sidecarPath(env: Record<string, string | undefined>): string {
	return join(dirname(defaultLedgerPath(env)), SIDECAR_FILE);
}

/** The `state` keys (§ 2). `defaultBranch` and `labelsCreated` are per GitHub repo (`<key>:<owner/repo>`). */
export const STATE = {
	seededAt: "seeded_at",
	intakeSince: "intake_since",
	/** The GraphQL edge cursor intake resumes after (§ 6.1). */
	intakeAfter: "intake_after",
	defaultBranch: "default_branch",
	lastReconcile: "last_reconcile",
	lastDrift: "last_drift",
	lastSwitch: "last_switch",
	/** Set once every projection label exists on the repo (§ 3 Labels). */
	labelsCreated: "labels_created",
	/** Epoch ms of the last counted `gh api rate_limit` read, and what it said (§ 2 github.ts). */
	rateCheckedAt: "rate_checked_at",
	rateRemaining: "rate_remaining",
	/**
	 * JSON array of drift lines a tracker move left (§ 13.2): an open PR whose old machinery footer is
	 * not the body's exact suffix, so it was not stripped. The reconciler's drift entry reads it.
	 */
	moveDrift: "move_drift",
	/** Prefix of `turn_mark:<session id>` (`turnMarkKey`): `<seq> <iso>`, one session's provenance `max(seq)` at its previous turn end (at session start for its first turn) and when it was set; that session's next turn range starts after it (§ 13.3). */
	turnMark: "turn_mark",
} as const;

/** The tracker kinds the caps count separately (§ 13.2): each has its own 20/tick and 300/h. */
export type TrackerKind = "github" | "linear";

/** An intake verdict (§ 6.2): a Jo input was written, or the issue was judged not Jo's. */
export const INTAKE_ACCEPTED = "accepted";
export const INTAKE_IGNORED = "ignored";

export type FooterState = "pending" | "done" | "none";

export interface LinkRow {
	workload_id: string;
	/** The issue on GitHub, or null before the first create (or after the reconciler cleared a deleted one, or a move). */
	issue_number: number | null;
	/** The workload's GitHub owner/repo, or `-` for a workload on no GitHub repo; null while unresolved. */
	repo: string | null;
	/** The tracker the link's item lives on: `github` or `linear:<TEAM>`; null before one was resolved (or none applies). */
	tracker: string | null;
	/** The Linear issue id (a link on Linear), else null. */
	external_id: string | null;
	/** The Linear identifier (`ENG-123`) of `external_id`, else null. */
	issue_ref: string | null;
	/** Where the item lived before the last tracker move (`github:<owner/repo>#<n>` or `linear:<ENG-123>`), else null. */
	moved_from: string | null;
	dirty: number;
	/** Re-read the remote and edit even when the render hash matches (the reconciler sets it). */
	force: number;
	/** The newest provenance seq ingested for this workload. */
	last_seq: number;
	pushed_hash: string | null;
	pushed_title: string | null;
	/** JSON array of the labels pushed, sorted. */
	pushed_labels: string | null;
	/** `open`, `closed completed` or `closed not planned`. */
	pushed_state: string | null;
	/**
	 * sha256 of the machine block as Linear returned it from the push that wrote `pushed_hash`
	 * (`blockHash`; Linear normalises Markdown on write); null on GitHub, before one, or when the reply
	 * carried no description.
	 */
	remote_hash: string | null;
	/** The `last_seq` the last successful push (create, edit, or no-diff) rendered (§ 13.3 receipt); null before one. */
	pushed_seq: number | null;
	/** 1 while a turn's receipt is owed (§ 13.3): pushed before `last_seq` order. */
	priority: number;
	fails: number;
	next_try_at: number;
}

/** A turn's receipt for one workload (§ 13.3): `pending` until the link's `pushed_seq` reaches `seq`. */
export type TurnOutcome = "pending" | "updated" | "not-projected";

export interface TurnRow {
	id: number;
	/** Epoch ms of the turn end. */
	turn_end_at: number;
	workload_id: string;
	/** The workload's own highest provenance seq inside the turn's range. */
	seq: number;
	outcome: TurnOutcome;
	/** Ticks that ran since the turn end with the row still pending. */
	ticks: number;
	/** Why it is still pending, set when the notice is recorded. */
	reason: string | null;
	/** 1 once its one tick notice was recorded. */
	noticed: number;
	/** 1 once a drift entry carried its line. */
	drifted: number;
}

export interface PrRow {
	workload_id: string;
	number: number;
	url: string;
	base: string;
	/** `pending`: the footer is owed; `done`: the body carries it; `none`: not the default base, so no footer (§ 5). */
	footer: FooterState;
	fails: number;
	next_try_at: number;
}

export interface IntakeRow {
	issue_number: number;
	verdict: string;
	reason: string | null;
	in_id: string | null;
	acked: number;
	seen_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS links (
  workload_id   TEXT PRIMARY KEY,
  issue_number  INTEGER,
  repo          TEXT,
  tracker       TEXT,
  external_id   TEXT,
  issue_ref     TEXT,
  moved_from    TEXT,
  dirty         INTEGER NOT NULL DEFAULT 0,
  force         INTEGER NOT NULL DEFAULT 0,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  pushed_hash   TEXT,
  pushed_title  TEXT,
  pushed_labels TEXT,
  pushed_state  TEXT,
  pushed_seq    INTEGER,
  remote_hash   TEXT,
  priority      INTEGER NOT NULL DEFAULT 0,
  fails         INTEGER NOT NULL DEFAULT 0,
  next_try_at   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prs (
  workload_id TEXT NOT NULL,
  number      INTEGER NOT NULL,
  url         TEXT NOT NULL,
  base        TEXT NOT NULL,
  footer      TEXT NOT NULL CHECK (footer IN ('pending', 'done', 'none')),
  fails       INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workload_id, number)
);
CREATE TABLE IF NOT EXISTS intake (
  issue_number INTEGER PRIMARY KEY,
  verdict      TEXT NOT NULL,
  reason       TEXT,
  in_id        TEXT,
  acked        INTEGER NOT NULL DEFAULT 0,
  seen_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (at INTEGER NOT NULL, tracker TEXT NOT NULL DEFAULT 'github');
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim (holder TEXT NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY,
  turn_end_at INTEGER NOT NULL,
  workload_id TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('pending', 'updated', 'not-projected')),
  ticks       INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  noticed     INTEGER NOT NULL DEFAULT 0,
  drifted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_outcome ON turns (outcome, workload_id);
`;

/** Columns an older sidecar lacks (written before § 13, or before `remote_hash`), added on open (an older file keeps every row). */
const ADDED: readonly [table: string, column: string, decl: string][] = [
	["links", "tracker", "TEXT"],
	["links", "external_id", "TEXT"],
	["links", "issue_ref", "TEXT"],
	["links", "moved_from", "TEXT"],
	["links", "pushed_seq", "INTEGER"],
	["links", "priority", "INTEGER NOT NULL DEFAULT 0"],
	["links", "remote_hash", "TEXT"],
	["calls", "tracker", "TEXT NOT NULL DEFAULT 'github'"],
];

/** After ADDED: an issue number is unique per repo (several GitHub repos), a Linear id once; every pre-§ 13 issue was on GitHub. */
const INDEXES = `
DROP INDEX IF EXISTS links_issue;
CREATE UNIQUE INDEX IF NOT EXISTS links_repo_issue ON links (repo, issue_number) WHERE issue_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS links_external ON links (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_tracker_at ON calls (tracker, at);
UPDATE links SET tracker = 'github' WHERE tracker IS NULL AND issue_number IS NOT NULL;
`;

/**
 * Whether the sidecar behind `db` (any connection, a read-only one included) already has every
 * table, column and index `Sidecar.open` creates or adds: true means its migration would change
 * nothing in the schema. Compared against the schema built in memory, so it follows SCHEMA and ADDED.
 */
export function schemaCurrent(db: Database): boolean {
	const ref = new Database(":memory:");
	try {
		ref.run(SCHEMA);
		ref.run(INDEXES);
		const objects = "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'";
		const have = new Set(db.query<{ type: string; name: string }, []>(objects).all().map((o) => `${o.type} ${o.name}`));
		for (const o of ref.query<{ type: string; name: string }, []>(objects).all()) {
			if (!have.has(`${o.type} ${o.name}`)) return false;
			if (o.type !== "table") continue;
			const columns = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${o.name})`).all().map((c) => c.name));
			if (ref.query<{ name: string }, []>(`PRAGMA table_info(${o.name})`).all().some((c) => !columns.has(c.name))) return false;
		}
		return true;
	} finally {
		ref.close();
	}
}

export class Sidecar {
	private constructor(
		readonly db: Database,
		readonly path: string,
	) {}

	/** Open (creating when missing) the sidecar at `path`; under test a path inside a live ledger root is refused first. */
	static open(path: string): Sidecar {
		assertNotLiveLedgerUnderTest(path);
		const db = new Database(path, { create: true });
		db.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
		db.run("PRAGMA journal_mode = WAL");
		const s = new Sidecar(db, path);
		s.immediate(() => {
			db.run(SCHEMA);
			for (const [table, column, decl] of ADDED) {
				const has = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
				if (!has) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
			}
			db.run(INDEXES);
		});
		return s;
	}

	/**
	 * Open an existing sidecar read-write without its migration (`surface/scripts/issues.ts check`'s
	 * call meter): no schema statement and no journal-mode change runs. Throws when the file is
	 * missing or its schema is not current (`schemaCurrent`), so nothing here ever migrates it.
	 */
	static openNoMigrate(path: string): Sidecar {
		assertNotLiveLedgerUnderTest(path);
		const db = new Database(path, { readwrite: true, create: false });
		db.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
		if (!schemaCurrent(db)) {
			db.close();
			throw new Error(`the sidecar at ${path} is not migrated; start the surface first`);
		}
		return new Sidecar(db, path);
	}

	close(): void {
		this.db.close();
	}

	/** Run `fn` inside BEGIN IMMEDIATE (the write lock taken first); rolled back when it throws. */
	immediate<T>(fn: () => T): T {
		this.db.run("BEGIN IMMEDIATE");
		try {
			const out = fn();
			this.db.run("COMMIT");
			return out;
		} catch (err) {
			this.db.run("ROLLBACK");
			throw err;
		}
	}

	// ---- state and cursor ------------------------------------------------------------------------

	state(key: string): string | null {
		return this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value ?? null;
	}

	setState(key: string, value: string | null): void {
		if (value === null) this.db.query("DELETE FROM state WHERE key = ?").run(key);
		else this.db.query("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	/** The provenance seq ingest has read through, or null before the first ingest. */
	cursor(): number | null {
		return this.db.query<{ seq: number }, []>("SELECT seq FROM cursor LIMIT 1").get()?.seq ?? null;
	}

	setCursor(seq: number): void {
		this.db.run("DELETE FROM cursor");
		this.db.query("INSERT INTO cursor (seq) VALUES (?)").run(seq);
	}

	// ---- links -----------------------------------------------------------------------------------

	link(workloadId: string): LinkRow | null {
		return this.db.query<LinkRow, [string]>("SELECT * FROM links WHERE workload_id = ?").get(workloadId);
	}

	links(): LinkRow[] {
		return this.db.query<LinkRow, []>("SELECT * FROM links ORDER BY last_seq, workload_id").all();
	}

	/** Insert a link, or mark an existing one dirty; `last_seq` only grows. */
	upsertLink(workloadId: string, o: { repo: string | null; dirty: boolean; lastSeq: number }): void {
		this.db
			.query(
				`INSERT INTO links (workload_id, repo, dirty, last_seq) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT (workload_id) DO UPDATE SET dirty = max(dirty, ?3), last_seq = max(last_seq, ?4)`,
			)
			.run(workloadId, o.repo, o.dirty ? 1 : 0, o.lastSeq);
	}

	markDirty(workloadId: string): void {
		this.db.query("UPDATE links SET dirty = 1 WHERE workload_id = ?").run(workloadId);
	}

	deleteLink(workloadId: string): void {
		this.db.query("DELETE FROM links WHERE workload_id = ?").run(workloadId);
	}

	// ---- turns (§ 13.3) --------------------------------------------------------------------------

	/** Every turn row, oldest first. */
	turns(): TurnRow[] {
		return this.db.query<TurnRow, []>("SELECT * FROM turns ORDER BY id").all();
	}

	// ---- PR footers ------------------------------------------------------------------------------

	prs(): PrRow[] {
		return this.db.query<PrRow, []>("SELECT * FROM prs ORDER BY workload_id, number").all();
	}

	// ---- the claim (§ 3) -------------------------------------------------------------------------

	/** Take the claim when it is free, expired, or already this holder's; false when another holder has it live. */
	claim(holder: string, nowMs: number): boolean {
		return this.immediate(() => {
			const row = this.db.query<{ holder: string; until: number }, []>("SELECT holder, until FROM claim LIMIT 1").get();
			if (row && row.holder !== holder && row.until >= nowMs) return false;
			this.db.run("DELETE FROM claim");
			this.db.query("INSERT INTO claim (holder, until) VALUES (?, ?)").run(holder, nowMs + CLAIM_MS);
			return true;
		});
	}

	/** Inside a transaction: whether `holder` still holds the claim, renewing it to now + CLAIM_MS when it does. */
	private renewIn(holder: string, nowMs: number): boolean {
		return this.db.query("UPDATE claim SET until = ? WHERE holder = ? RETURNING holder").all(nowMs + CLAIM_MS, holder).length > 0;
	}

	/** Check and renew the claim in its own IMMEDIATE transaction (before a create, before writing an issue number). */
	fence(holder: string, nowMs: number): boolean {
		return this.immediate(() => this.renewIn(holder, nowMs));
	}

	/** Release the claim when this holder still has it. */
	release(holder: string): void {
		this.immediate(() => this.db.query("DELETE FROM claim WHERE holder = ?").run(holder));
	}

	/**
	 * Count one call of tracker `kind` against its hour (§ 2 github.ts, § 13.2: each kind has its own
	 * cap), in one IMMEDIATE transaction that first fences the claim: `lost` when `holder` no longer
	 * holds it, `hour` when `perHour` calls of that kind were made in the last hour, else the call row
	 * is inserted, the claim renewed, and `ok`.
	 */
	countCall(holder: string, nowMs: number, perHour: number, kind: TrackerKind = "github"): "ok" | "lost" | "hour" {
		return this.immediate(() => {
			if (!this.renewIn(holder, nowMs)) return "lost";
			this.db.query("DELETE FROM calls WHERE at <= ?").run(nowMs - 2 * HOUR_MS);
			if (this.callsInHour(nowMs, kind) >= perHour) return "hour";
			this.db.query("INSERT INTO calls (at, tracker) VALUES (?, ?)").run(nowMs, kind);
			return "ok";
		});
	}

	/** Calls of tracker `kind` counted in the hour before `nowMs`. */
	callsInHour(nowMs: number, kind: TrackerKind = "github"): number {
		return this.db.query<{ n: number }, [string, number]>("SELECT count(*) AS n FROM calls WHERE tracker = ? AND at > ?").get(kind, nowMs - HOUR_MS)?.n ?? 0;
	}
}
