#!/usr/bin/env bun
// invariants: the ledger/process invariant report, ported from Plumb's watcher (the by-hand checker
// that ran beside the lanes on 2026-10-11 and caught an orphan review hand from a dead lane, two
// lanes dying on one provider refusal, an orchestrator silent for two hours, and a checkout behind
// main). Read-only: the ledger is opened `{ readonly: true }`, git runs with `--no-optional-locks`
// and only reads (rev-parse, rev-list, log, merge-base, status), and nothing is written anywhere.
// It is a report: the exit code is 0 whatever it finds or skips (2 only when it could not run at
// all: a bad argument, or no ledger to open).
//
//   bun surface/scripts/invariants.ts                 a table: one block per finding, skipped
//                                                     invariants and per-invariant counts at the end
//   bun surface/scripts/invariants.ts --json          one JSON object per finding per line, then one
//                                                     per skipped invariant ({ invariant, skipped });
//                                                     the summary line goes to stderr
//   bun surface/scripts/invariants.ts --as-of <ISO>   replay: ledger rows written after <ISO> are
//                                                     ignored (see "Replay" below)
//   bun surface/scripts/invariants.ts --reviews       one line: lanes alive and review hands in flight
//   bun surface/scripts/invariants.ts --repo <dir>    the checkout the git invariants read (default:
//                                                     the checkout this script is in)
//   bun surface/scripts/invariants.ts --backup-gap <hours>
//                                                     stale-backup's threshold (default 30: the job's 24 h
//                                                     copy interval plus 6 h): how far the newest ledger
//                                                     write may run ahead of the newest copy
//
// The ledger is the one the surface opens: $AGENT_SYSTEM_LEDGER_DB, else $HOME/.agent-system-2/ledger.db
// (ledger/src/locality.ts defaultLedgerPath). Lane rpc logs are read from the lane directory the
// launcher writes (surface/src/launch.ts laneDir). Live lanes are the `surface/scripts/lane.ts run
// <wl> <lane>` processes `pgrep -fl` lists.
//
// | Invariant | Fires when | Key |
// |---|---|---|
// | dead-lane | an open workload's newest `lane-started:` lane has no `lane-exit:`, no `lane.ts run <wl> <lane>` process, and the workload has no entry for 20 min | `dead-lane:<lane>` |
// | silent-lane | a lane with a live `lane.ts run <wl> <lane>` process that still holds its workload (`holder` is the lane and the lease has not lapsed) whose newest write anywhere — any file under the lane directory `~/.agent-system-2/lanes/<wl>/` (transcripts, rpc log, runner log) or any ledger entry on the workload — is more than 45 min old: hung, not dead (the lease renews from the runner, so it stays held). The live case, 2026-10-11: omp at 2 s of CPU after 4 h, transcript mtime at the launch minute. | `silent-lane:<lane>` |
// | orphan-hand | a `hand-spawn:` token has no `hand-settled:` and the lane that wrote it (`created_by`) has exited, been superseded by a later `lane-started:`, or is dead (no exit, no process, workload silent 20 min: the dead-lane case); the text lists the row `builderLabs` counts as builders | `orphan-hand:<token>` |
// | no-independent-lab | the classifier's own `builderLabs` (classifier/src/lab.ts) excludes all three labs; review tokens held by a live spawning lane are passed as `liveReviews`, as the classifier does | `no-independent-lab:<wl>` |
// | stale-reserved | a `reserved-request` entry older than 30 min that `reservedStates` (surface/src/errors.ts) still finds `waiting`: no `approve <id>` / `deny <id>` instruction, no `reserved-withdrawn: <id>`, its raising lane still holds the workload (a `lane-stopped` request is closed, not stale), and no later request repeats it | `stale-reserved:<entry>` |
// | stuck-question | a question open for more than 30 min | `stuck-question:<q>` |
// | stuck-review | a `hand-spawn: … review yes` with no `hand-settled:` after 45 min while any lane on the workload is alive | `stuck-review:<token>` |
// | provider-refusal-loop | 2+ `lane-exit:` on one workload within 30 min, each with refusal evidence (`usage polic`, `non-retryable`, `refusal`) in ledger entries/messages from 2 min before to 5 min after the exit (never past as-of), or, for `outcome error`, in the final `prompt_result` of the lane's rpc log `lane-<n>.jsonl` (read as it is now) | `provider-refusal-loop:<wl>:<first lane>` |
// | silent-orchestrator | no `wl-orchestrator` entry for 2 h while any lane process is alive | `silent-orchestrator:<last entry id>` |
// | checkout-behind-main | `git rev-parse HEAD` differs from `origin/main` in the checkout. Behind (HEAD is an ancestor of origin/main): `behind origin/main by <n>; fast-forward at a lull` (or `fast-forward would refuse` with the modified tracked files, or `git status failed` when cleanliness could not be read). Diverged (neither is an ancestor of the other): `DIVERGED … needs a person`. Ahead only (origin/main is an ancestor of HEAD: local commits not yet on main) is not a finding. It never fetches, so origin/main is whatever the checkout already has. | `checkout-behind-main:<head12>:<origin12>` (`…:diverged:…` when diverged) |
// | process-older-than-head | an `omp --cwd <checkout>` process (not a persistent seat: commands naming `/seat-sessions/` are skipped) started before HEAD arrived, where "arrived" is the later of HEAD's commit time and its newest reflog entry | `process-older-than-head:<pid>:<head12>` |
// | ff-lull | checkout-behind-main with tracked files clean (`git status --porcelain --untracked-files=no` succeeded and printed nothing) AND zero review hands in flight. In flight = a `hand-spawn: … review yes` token with no `hand-settled: <token>` whose spawning lane has a live `lane.ts run` process: the `liveReviews` set the classifier passes to `builderLabs`. Unsettled review hands whose lane is gone are listed, not counted. The text cites the fingerprint rule (classifier/src/fingerprint.ts header: a review's fingerprint covers its lane's worktree only) rather than asserting the fast-forward is safe. | `ff-lull:<origin12>:<id of the newest review hand-settled entry>`, so one notice per lull |
// | stale-backup | the ledger's newest write (max `created_at` across every table that has one, up to as-of) is newer than the newest scheduled copy (`ledger-<time>.db` in `backups/<backupNamespace>/` beside the ledger, the directory ledger/scripts/backup.ts writes; its time read from the name, copies named after as-of ignored; a copy counts only if the ledger's `copyProblem` accepts it as complete, so an empty, unreadable, corrupt or wrong-version file named like a copy is passed over for the next older one) by more than `--backup-gap` hours (default 30: the job's 24 h copy interval plus 6 h, so a finding means a daily copy was missed, not a busy day): writes no copy captured. Never the copy's wall-clock age: an old copy of a quiet ledger is not a finding (2026-10-09T18:03Z to 2026-10-11T18:10Z the ledger wrote nothing and every copy matched it). With no complete copy at all the gap runs from the ledger's first write. The text names the newest write, the newest complete copy, each newer file passed over with its problem, and the backup directory. | `stale-backup:<newest complete copy file name>` (`stale-backup:none` with no complete copy) |
// | ledger-health | the live ledger file itself, checked read-only as it is now (also under `--as-of`): `PRAGMA quick_check` reports anything but `ok` or fails; `PRAGMA foreign_key_check` lists a row whose parent does not exist; or the trigger set (names, and each statement's text by SHA-256, from `sqlite_master`) is not the one ledger/schema.sql gives the file's `user_version` (`triggerDrift`, ledger/src/index.ts: missing, changed, or not in schema.sql), or the version is one `Ledger.open` neither supports nor upgrades. One finding per failing check | `ledger-health:<quick-check\|foreign-keys\|triggers>:<sha256 of what failed, 12 hex>` |
//
// Skips. An invariant that cannot be judged here is reported as `skipped: <reason>` rather than
// silently passing: the three git/process invariants under `--as-of` (git state and the process
// table are read as they are now, not as of then), when the checkout is not a git repository or
// has no origin/main, when git, pgrep or ps are not on this machine, and process-older-than-head
// when no orchestrator process (`omp --cwd <checkout>`) runs here: on any other machine there is
// nothing to compare HEAD against. dead-lane, silent-lane, stuck-review, silent-orchestrator and
// ff-lull need the process table too and are skipped when it could not be read. A probe that
// fails is a skip, never "no process": pgrep exit 1 (no match) is an answer, any other failure
// carries its exit code and stderr into the reason; a `ps` call that fails for a process still
// alive is a skip too (only a pid that is gone reads as "exited between pgrep and ps"). silent-lane
// reads file mtimes as they are now, like the rpc logs; stale-backup reads the backup directory and
// its files as they are now and says so in its finding under `--as-of`.
//
// Replay (`--as-of`). "Alive" means a lane process alive now whose lane had already started by
// as-of; a lane alive then that has died since reads as dead, and rpc logs are read as they are now.
// stale-reserved's `lane-stopped` and `superseded` states carry no timestamp (the holder is read
// as it is now), so a request its lane has since stopped holding is not flagged even in replay.
//
// Each finding carries `key`, `invariant`, `workload`, `since`, `text` and `query` (the SQL with
// its parameters inlined, pasteable into `sqlite3 -readonly`); `--json` adds `asOf`.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { builderLabs, describeBuilders, excludedLabs, parseHandSpawn } from "../../classifier/src/lab";
import {
	BACKUP_DEFAULTS, BACKUP_NAME, backupNamespace, copyProblem, describeDrift, openableVersion, processAlive, SCHEMA_VERSION, triggerDrift,
} from "../../ledger/src/index";
import type { EntryKind, EntryRow, InstructionRow, WorkloadStatusRow } from "../../ledger/src/index";
import { assertNotLiveLedgerUnderTest, canonicalPath, defaultLedgerPath, homeDir } from "../../ledger/src/locality";
import { type ReservedLedgerView, reservedStates } from "../src/errors";
import { laneDir } from "../src/launch";
import { STANDING_WORKLOAD_ID } from "../src/types";

export const INVARIANTS = [
	"dead-lane", "silent-lane", "orphan-hand", "no-independent-lab", "stale-reserved", "stuck-question", "stuck-review",
	"provider-refusal-loop", "silent-orchestrator", "checkout-behind-main", "process-older-than-head", "ff-lull", "stale-backup", "ledger-health",
] as const;
export type Invariant = (typeof INVARIANTS)[number];

export interface Finding {
	key: string;
	invariant: Invariant;
	workload: string;
	since: string;
	text: string;
	query: string;
}
export interface Skip {
	invariant: Invariant;
	skipped: string;
}
export interface Report {
	asOf: string;
	replay: boolean;
	/** `<workload> <laneId>` per live lane process, or null when the process table could not be read. */
	liveLanes: string[] | null;
	reviewsInFlight: string[];
	orphanReviews: string[];
	findings: Finding[];
	skipped: Skip[];
	elapsedMs: number;
}

/** A read-only git in the checkout: `ok` is exit 0, `out` the trimmed stdout. */
export type Git = (...args: string[]) => { ok: boolean; out: string };
export interface OrchestratorProcess {
	pid: string;
	command: string;
	/** The process start time, or null when `ps` could not give one. */
	started: Date | null;
}

/** A process probe's answer: what it found, or why it could not look (a failed probe is never "nothing running"). */
export type Probe<T> = { found: T } | { skipped: string };

export interface Input {
	/** The ledger, opened read-only. */
	db: Database;
	asOf: string;
	replay: boolean;
	/** `<workload> <laneId>` per live `lane.ts run` process, or why the process table could not be read. */
	liveLanes: Probe<ReadonlySet<string>>;
	/** The directory holding a workload's lane rpc logs (`lane-<n>.jsonl`). */
	lanesDirOf: (workloadId: string) => string;
	/** The checkout the git invariants read. */
	repo: string;
	/** Read-only git in `repo`; null when git is unavailable. */
	git: Git | null;
	/** The `omp --cwd <repo>` processes on this machine, or why they could not be listed. */
	orchestrators: () => Probe<OrchestratorProcess[]>;
	/** The ledger's scheduled-copy directory, and how far the newest write may run ahead of the newest copy. */
	backups: { dir: string; gapMs: number };
}

const MIN = 60_000;
/** stale-backup's default gap between the newest ledger write and the newest copy: the job's copy interval plus 6 h, so a finding means a daily copy was missed. */
export const BACKUP_GAP_MS = BACKUP_DEFAULTS.intervalMs + 6 * 60 * MIN;
const LANE_STARTED = /^lane-started:\s+(\S+)/;
const LANE_EXIT = /^lane-exit:\s+(\S+)\s+code\s+(\S+)\s+signal\s+(\S+)\s+outcome\s+(\S+)/;
const HAND_SETTLED = /^hand-settled:\s+(\S+)/;
const REFUSAL = /usage polic|non-retryable|\brefusal\b/i;

type Entry = Pick<EntryRow, "id" | "workload_id" | "slice_id" | "kind" | "body" | "created_by" | "created_at">;
type Routing = { workload_id: string; kind: string; pull_up_to: string | null; probabilities: string; outcome: string; models: string; ran_models: string | null; created_at: string };

const OPEN_ENTRIES_SQL = `SELECT e.id, e.workload_id, e.slice_id, e.kind, e.body, e.created_by, e.created_at
  FROM entries e JOIN workloads w ON w.id = e.workload_id
  WHERE w.status = 'open' AND e.created_at <= :asOf ORDER BY e.created_at, e.rowid`;
const HAND_SQL = `SELECT e.id, e.workload_id, e.slice_id, e.kind, e.body, e.created_by, e.created_at FROM entries e JOIN workloads w ON w.id = e.workload_id
  WHERE w.status = 'open' AND e.created_at <= :asOf AND e.body LIKE 'hand-spawn:%'
    AND NOT EXISTS (SELECT 1 FROM entries s WHERE s.workload_id = e.workload_id AND s.created_at <= :asOf
                    AND s.body LIKE 'hand-settled: ' || substr(e.body, 13, instr(substr(e.body, 13), ' ') - 1) || ' %')
  ORDER BY e.created_at`;
const ROUTINGS_SQL = `SELECT r.workload_id, r.kind, r.pull_up_to, r.probabilities, r.outcome, r.models, r.ran_models, r.created_at
  FROM routings r JOIN workloads w ON w.id = r.workload_id WHERE w.status = 'open' AND r.created_at <= :asOf ORDER BY r.created_at`;
const RESERVED_SQL = `SELECT e.id, e.workload_id, e.created_by, e.created_at, e.body FROM entries e JOIN workloads w ON w.id = e.workload_id
  WHERE w.status = 'open' AND e.kind = 'reserved-request' AND e.created_at <= :cutoff ORDER BY e.created_at`;
const QUESTION_SQL = `SELECT q.id, q.workload_id, q.created_at, q.body FROM questions q
  WHERE q.created_at <= :cutoff
    AND (q.state = 'open' OR (SELECT i.created_at FROM instructions i WHERE i.id = q.resolved_by) > :asOf)
  ORDER BY q.created_at`;
const NEAR_SQL = `SELECT body FROM entries WHERE workload_id = :wl AND created_at BETWEEN :from AND :to
  UNION ALL SELECT body FROM messages WHERE workload_id = :wl AND created_at BETWEEN :from AND :to`;
const ORCH_SQL = `SELECT id, created_at FROM entries WHERE workload_id = :wl AND created_at <= :asOf ORDER BY created_at DESC LIMIT 1`;
const REVIEW_SQL = `SELECT id, workload_id, created_at, body FROM entries
  WHERE (body LIKE 'hand-spawn:% review yes %' OR body LIKE 'hand-settled: %') AND created_at <= :asOf ORDER BY created_at, rowid`;

/** The ledger reads `reservedStates` needs, over a read-only connection (the same SQL as `Ledger`'s own). */
export function reservedView(db: Database): ReservedLedgerView {
	return {
		entries: (workloadId: string, kind?: EntryKind) =>
			kind === undefined
				? db.query<EntryRow, [string]>("SELECT * FROM entries WHERE workload_id = ? ORDER BY created_at, rowid").all(workloadId)
				: db.query<EntryRow, [string, string]>("SELECT * FROM entries WHERE workload_id = ? AND kind = ? ORDER BY created_at, rowid").all(workloadId, kind),
		instructions: (workloadId: string) =>
			db.query<InstructionRow, [string]>("SELECT * FROM instructions WHERE workload_id = ? ORDER BY created_at, rowid").all(workloadId),
		workload: (id: string) => db.query<WorkloadStatusRow, [string]>("SELECT * FROM workload_status WHERE id = ?").get(id),
		holders: (workloadId: string) => {
			const rows = db.query<{ detail: string | null }, [string]>(
				"SELECT detail FROM provenance WHERE workload_id = ? AND tbl = 'workloads' AND action = 'update' ORDER BY seq").all(workloadId);
			const out: string[] = [];
			for (const r of rows) {
				const m = /(?:^|\s)holder \S+?->(\S+)/.exec(r.detail ?? "");
				if (m && m[1] !== "-" && !out.includes(m[1]!)) out.push(m[1]!);
			}
			return out;
		},
	};
}

/** The final prompt_result error message in a lane's rpc log (`<lanes dir>/lane-<n>.jsonl`), from its last 64 KB. */
export function laneLogError(dir: string, laneId: string): string | null {
	const n = /-(\d+)$/.exec(laneId)?.[1];
	if (!n) return null;
	const path = join(dir, `lane-${n}.jsonl`);
	if (!existsSync(path)) return null;
	const size = statSync(path).size;
	const len = Math.min(size, 65_536);
	const buf = Buffer.alloc(len);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, len, size - len);
	} finally {
		closeSync(fd);
	}
	for (const line of buf.toString("utf8").split("\n").reverse()) {
		if (!line.includes('"type":"prompt_result"')) continue;
		try {
			const r = JSON.parse(line);
			return r.status === "error" ? String(r.error?.message ?? "error") : null;
		} catch {
			return null;
		}
	}
	return null;
}

/** ISO time of the newest file write anywhere under `dir` (recursive), or null when the directory is missing or empty. */
export function newestWrite(dir: string): string | null {
	if (!existsSync(dir)) return null;
	let newest = 0;
	for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (!e.isFile()) continue;
		const mtime = statSync(join(e.parentPath, e.name)).mtimeMs;
		if (mtime > newest) newest = mtime;
	}
	return newest > 0 ? new Date(newest).toISOString() : null;
}

/** Per workload: lane id -> first start, exit entry (if any), in start order. */
function lanesOf(entries: Entry[]) {
	const lanes = new Map<string, { started: string; exit: Entry | null }>();
	for (const e of entries) {
		const s = LANE_STARTED.exec(e.body);
		if (s && !lanes.has(s[1]!)) lanes.set(s[1]!, { started: e.created_at, exit: null });
		const x = LANE_EXIT.exec(e.body);
		if (x && lanes.has(x[1]!)) lanes.get(x[1]!)!.exit = e;
	}
	return lanes;
}

export function check(input: Input): Report {
	const t0 = performance.now();
	const { db, asOf, replay } = input;
	const ago = (ms: number) => new Date(Date.parse(asOf) - ms).toISOString();
	const age = (iso: string) => {
		const m = Math.round((Date.parse(asOf) - Date.parse(iso)) / MIN);
		return m < 120 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
	};
	/** Run a query and return rows plus the query text with parameters inlined, pasteable into sqlite3. */
	const run = <T>(sql: string, params: Record<string, string> = {}): { rows: T[]; shown: string } => {
		const rows = db.query(sql).all(params as never) as T[];
		let shown = sql.replace(/\s+/g, " ").trim();
		for (const [k, v] of Object.entries(params)) shown = shown.replaceAll(k, `'${v.replaceAll("'", "''")}'`);
		return { rows, shown };
	};

	const findings: Finding[] = [];
	const skipped: Skip[] = [];
	const skip = (invariant: Invariant, reason: string) => skipped.push({ invariant, skipped: reason });

	// ---- shared reads ---------------------------------------------------------------------------
	const openEntries = run<Entry>(OPEN_ENTRIES_SQL, { ":asOf": asOf });
	const byWorkload = new Map<string, Entry[]>();
	for (const e of openEntries.rows) {
		if (!byWorkload.has(e.workload_id)) byWorkload.set(e.workload_id, []);
		byWorkload.get(e.workload_id)!.push(e);
	}

	// Replay: a process alive now was alive at as-of only if its lane had already started by then.
	const liveLanes = "found" in input.liveLanes ? new Set(input.liveLanes.found) : null;
	if (replay && liveLanes) {
		for (const l of liveLanes) {
			const [wl, lane] = l.split(" ");
			if (!lanesOf(byWorkload.get(wl!) ?? []).has(lane!)) liveLanes.delete(l);
		}
	}
	const isLive = (wl: string, lane: string) => liveLanes?.has(`${wl} ${lane}`) ?? false;
	const anyLive = (wl: string) => [...(liveLanes ?? [])].some(l => l.startsWith(`${wl} `));
	const NO_PGREP = `the process table could not be read (${"skipped" in input.liveLanes ? input.liveLanes.skipped : "pgrep unavailable"}), so lane liveness is unknown`;

	// ---- 1. dead-lane ---------------------------------------------------------------------------
	/** The newest lane of a workload when it is dead: no exit, no process, and the workload silent 20 min. */
	const deadLane = (wl: string, entries: Entry[]): { laneId: string; started: string; silentSince: string } | null => {
		if (!liveLanes) return null;
		const newest = [...lanesOf(entries)].at(-1);
		if (!newest) return null;
		const [laneId, lane] = newest;
		if (lane.exit || isLive(wl, laneId)) return null;
		const last = entries.at(-1)!;
		if (last.created_at > ago(20 * MIN)) return null;
		return { laneId, started: lane.started, silentSince: last.created_at };
	};
	if (!liveLanes) skip("dead-lane", NO_PGREP);
	else {
		for (const [wl, entries] of byWorkload) {
			const dead = deadLane(wl, entries);
			if (!dead) continue;
			findings.push({
				key: `dead-lane:${dead.laneId}`,
				invariant: "dead-lane",
				workload: wl,
				since: dead.silentSince,
				text: `${dead.laneId} started ${dead.started} has no lane-exit, no lane.ts process, and the workload has been silent ${age(dead.silentSince)}: the lane died without telling anyone.`,
				query: `${openEntries.shown} -- then: newest 'lane-started: <lane>' per workload with no 'lane-exit: <lane> ...'; pgrep -fl 'surface/scripts/lane.ts run <workload> <lane>'`,
			});
		}
	}

	// ---- 1b. silent-lane ------------------------------------------------------------------------
	// The lease is the runner's (it renews on a timer), so a hung omp keeps it: liveness plus a held
	// lease plus no write anywhere for 45 min is a hang, which no other invariant sees.
	const SILENT_LANE_SQL = `SELECT id, holder, holder_lease_until FROM workloads WHERE status = 'open' AND holder IS NOT NULL`;
	if (!liveLanes) skip("silent-lane", NO_PGREP);
	else {
		const held = run<{ id: string; holder: string; holder_lease_until: string | null }>(SILENT_LANE_SQL);
		for (const w of held.rows) {
			if (!isLive(w.id, w.holder)) continue;
			if (w.holder_lease_until !== null && w.holder_lease_until <= asOf) continue;
			const lastWrite = newestWrite(input.lanesDirOf(w.id));
			const lastEntry = byWorkload.get(w.id)?.at(-1)?.created_at ?? null;
			const last = [lastWrite, lastEntry].filter((t): t is string => t !== null).sort().at(-1);
			if (!last || last > ago(45 * MIN)) continue;
			const hours = ((Date.parse(asOf) - Date.parse(last)) / 3_600_000).toFixed(1);
			findings.push({
				key: `silent-lane:${w.holder}`,
				invariant: "silent-lane",
				workload: w.id,
				since: last,
				text: `lane ${w.holder} on ${w.id} silent ${hours}h (last transcript write ${lastWrite ?? "none"}); process alive, lease held — hung, not dead; stop + relaunch`,
				query: `${held.shown} -- then: pgrep -fl 'surface/scripts/lane.ts run ${w.id} ${w.holder}'; newest mtime under ${input.lanesDirOf(w.id)}; newest entry on ${w.id}`,
			});
		}
	}

	// ---- 2. orphan-hand and 6. stuck-review ----------------------------------------------------
	const unsettled = run<Entry>(HAND_SQL, { ":asOf": asOf });
	// Review tokens a live lane process still holds in flight: the classifier passes these to builderLabs as
	// liveReviews and does not count them as builders, so the reconstruction must not either.
	const liveReviews = new Map<string, Set<string>>();
	if (!liveLanes) skip("stuck-review", NO_PGREP);
	for (const e of unsettled.rows) {
		const spawn = parseHandSpawn(e.body);
		if (!spawn) continue;
		// The SQL settles by body prefix; re-check with the classifier's own parse so a malformed settle is not trusted.
		const entries = byWorkload.get(e.workload_id)!;
		if (entries.some(s => HAND_SETTLED.exec(s.body)?.[1] === spawn.token)) continue;
		const lanes = lanesOf(entries);
		const spawner = e.created_by;
		if (spawn.review && isLive(e.workload_id, spawner)) {
			if (!liveReviews.has(e.workload_id)) liveReviews.set(e.workload_id, new Set());
			liveReviews.get(e.workload_id)!.add(spawn.token);
		}
		const mine = lanes.get(spawner);
		let goneAt: string | null = null;
		let how = "";
		if (mine?.exit) {
			goneAt = mine.exit.created_at;
			how = `exited at ${goneAt}`;
		} else {
			const later = [...lanes].find(([id, l]) => id !== spawner && l.started > e.created_at);
			const dead = deadLane(e.workload_id, entries);
			if (later) {
				goneAt = later[1].started;
				how = `was superseded by ${later[0]} at ${goneAt} without a lane-exit`;
			} else if (dead && dead.laneId === spawner) {
				goneAt = dead.silentSince;
				how = `is dead: no lane-exit, no lane.ts process, and the workload has been silent since ${goneAt} (dead-lane)`;
			}
		}
		if (goneAt && spawner.startsWith("lane-")) {
			findings.push({
				key: `orphan-hand:${spawn.token}`,
				invariant: "orphan-hand",
				workload: e.workload_id,
				since: goneAt,
				text: `hand ${spawn.token} (review ${spawn.review ? "yes" : "no"}, slice ${spawn.spawnKey ?? "-"}) never settled and its lane ${spawner} ${how}; builderLabs counts its whole row as builders: ${spawn.row.join(", ")}.`,
				query: unsettled.shown,
			});
		}
		if (liveLanes && spawn.review && e.created_at <= ago(45 * MIN) && anyLive(e.workload_id)) {
			const round = entries.findLast(r => r.body.startsWith("review-round:") && r.body.includes(` token ${spawn.token} `));
			findings.push({
				key: `stuck-review:${spawn.token}`,
				invariant: "stuck-review",
				workload: e.workload_id,
				since: e.created_at,
				text: `review dispatch ${spawn.token} (spawned by ${spawner}, row ${spawn.row.join(", ")}) has had no hand-settled for ${age(e.created_at)} while a lane on the workload is alive; the classifier refuses further review rounds until it settles.${round ? ` A review-round entry names it (${round.id}: ${round.body.slice(0, 90)}) but that is not a settle.` : ""}`,
				query: unsettled.shown,
			});
		}
	}

	// ---- 3. no-independent-lab (the classifier's own builderLabs) ------------------------------
	const routings = run<Routing>(ROUTINGS_SQL, { ":asOf": asOf });
	for (const [wl, entries] of byWorkload) {
		const rts = routings.rows.filter(r => r.workload_id === wl);
		const at = (t: string) =>
			builderLabs({ entries: () => entries.filter(e => e.created_at <= t), routings: () => rts.filter(r => r.created_at <= t) }, wl, liveReviews.get(wl));
		const now = at(asOf);
		if (excludedLabs(now).length < 3) continue;
		// since = the last moment the workload went from having an independent lab to having none.
		const times = [...new Set([...entries.map(e => e.created_at), ...rts.map(r => r.created_at)])].sort();
		let since = times[0]!;
		let prev = false;
		for (const t of times) {
			const all = excludedLabs(at(t)).length === 3;
			if (all && !prev) since = t;
			prev = all;
		}
		findings.push({
			key: `no-independent-lab:${wl}`,
			invariant: "no-independent-lab",
			workload: wl,
			since,
			text: `builderLabs makes every lab a builder (${describeBuilders(now)}), so no review can run cross-lab and the next review parks.`,
			query: `${openEntries.shown} ; ${routings.shown} -- then classifier/src/lab.ts builderLabs(view, '${wl}')`,
		});
	}

	// ---- 4. stale-reserved (the surface's own reservedStates) ----------------------------------
	// A request whose lane stopped holding the workload is closed (surface/src/errors.ts `lane-stopped`),
	// not stale: the lane that would act on an approval is gone. Jo's decision and a withdrawal carry a
	// time and count only when they landed by as-of; lane-stopped and superseded are read as they are now.
	const reservedRows = run<Entry>(RESERVED_SQL, { ":cutoff": ago(30 * MIN) });
	const view = reservedView(db);
	for (const wl of new Set(reservedRows.rows.map(r => r.workload_id))) {
		for (const r of reservedStates(view, wl)) {
			if (r.created_at > ago(30 * MIN)) continue;
			const s = r.state;
			const waiting = s.kind === "waiting" || ((s.kind === "approved" || s.kind === "denied" || s.kind === "withdrawn") && s.at > asOf);
			if (!waiting) continue;
			findings.push({
				key: `stale-reserved:${r.id}`,
				invariant: "stale-reserved",
				workload: wl,
				since: r.created_at,
				text: `reserved-action request ${r.id} ("${r.body.split(":")[0]}") raised by ${r.created_by} has waited ${age(r.created_at)} with no approve/deny instruction and no withdrawal, and its lane still holds the workload.`,
				query: `${reservedRows.shown} -- then surface/src/errors.ts reservedStates(ledger, '${wl}'): state waiting (lane-stopped, superseded, approved, denied and withdrawn are not stale)`,
			});
		}
	}

	// ---- 5. stuck-question ----------------------------------------------------------------------
	const questions = run<{ id: string; workload_id: string; created_at: string; body: string }>(QUESTION_SQL, { ":asOf": asOf, ":cutoff": ago(30 * MIN) });
	for (const q of questions.rows) {
		findings.push({
			key: `stuck-question:${q.id}`,
			invariant: "stuck-question",
			workload: q.workload_id,
			since: q.created_at,
			text: `question ${q.id} has been open ${age(q.created_at)}: ${q.body.replace(/\s+/g, " ").slice(0, 100)}`,
			query: questions.shown,
		});
	}

	// ---- 7. provider-refusal-loop ---------------------------------------------------------------
	for (const [wl, entries] of byWorkload) {
		const refusals: { lane: string; at: string; why: string }[] = [];
		let lastShown = "";
		for (const e of entries) {
			const x = LANE_EXIT.exec(e.body);
			if (!x) continue;
			// Evidence is read up to 5 min after the exit, never past as-of: a replay sees only what had landed.
			const upTo = new Date(Math.min(Date.parse(e.created_at) + 5 * MIN, Date.parse(asOf))).toISOString();
			const near = run<{ body: string }>(NEAR_SQL, {
				":wl": wl,
				":from": new Date(Date.parse(e.created_at) - 2 * MIN).toISOString(),
				":to": upTo,
			});
			lastShown = near.shown;
			const ledgerHit = near.rows.find(r => REFUSAL.test(r.body));
			let why = ledgerHit ? `ledger: ${ledgerHit.body.slice(0, 80)}` : "";
			if (!why && x[4] === "error") {
				const msg = laneLogError(input.lanesDirOf(wl), x[1]!);
				if (msg && REFUSAL.test(msg)) why = `lane rpc log: ${msg.slice(0, 80)}`;
			}
			if (why) refusals.push({ lane: x[1]!, at: e.created_at, why });
		}
		for (let i = 0; i < refusals.length; i++) {
			const cluster = refusals.filter(r => r.at >= refusals[i]!.at && Date.parse(r.at) - Date.parse(refusals[i]!.at) <= 30 * MIN);
			if (cluster.length < 2) continue;
			if (i > 0 && Date.parse(refusals[i]!.at) - Date.parse(refusals[i - 1]!.at) <= 30 * MIN) continue; // already reported from its first member
			findings.push({
				key: `provider-refusal-loop:${wl}:${refusals[i]!.lane}`,
				invariant: "provider-refusal-loop",
				workload: wl,
				since: refusals[i]!.at,
				text: `${cluster.length} lanes died on a provider refusal within 30 min (${cluster.map(c => c.lane).join(", ")}); a relaunch on the same model will die again. Last: ${cluster.at(-1)!.why}`,
				query: `${lastShown.replace(/'[^']*'/g, "?")} -- per lane-exit, ±window; outcome error also reads the last prompt_result in ${input.lanesDirOf("<workload>")}/lane-<n>.jsonl`,
			});
		}
	}

	// ---- 8. silent-orchestrator -----------------------------------------------------------------
	const orch = run<{ id: string; created_at: string }>(ORCH_SQL, { ":wl": STANDING_WORKLOAD_ID, ":asOf": asOf });
	const lastOrch = orch.rows[0];
	if (!liveLanes) skip("silent-orchestrator", NO_PGREP);
	else if (liveLanes.size > 0 && (!lastOrch || lastOrch.created_at < ago(120 * MIN))) {
		findings.push({
			key: `silent-orchestrator:${lastOrch?.id ?? "none"}`,
			invariant: "silent-orchestrator",
			workload: STANDING_WORKLOAD_ID,
			since: lastOrch?.created_at ?? asOf,
			text: `the orchestrator has written nothing for ${lastOrch ? age(lastOrch.created_at) : "ever"} while ${liveLanes.size} lane(s) are alive.`,
			query: orch.shown,
		});
	}

	// ---- 9. checkout-behind-main, 10. process-older-than-head, 11. ff-lull ----------------------
	// Review hands in flight = the liveReviews built in section 2: a `hand-spawn: … review yes` token with
	// no `hand-settled: <token>` whose spawning lane process is alive (lab.ts builderLabs, liveReviews).
	const reviewsInFlight = [...liveReviews.values()].flatMap(s => [...s]);
	const orphanReviews = unsettled.rows.flatMap(e => {
		const s = parseHandSpawn(e.body);
		return s?.review && !reviewsInFlight.includes(s.token) && !byWorkload.get(e.workload_id)!.some(x => HAND_SETTLED.exec(x.body)?.[1] === s.token) ? [s.token] : [];
	});
	const repo = input.repo;
	const git = input.git;
	const gitSkip = replay
		? "replay (--as-of): git state and the process table are read as they are now, not as of then"
		: git === null
			? "git is not available on this machine"
			: !git("rev-parse", "--git-dir").ok
				? `${repo} is not a git checkout`
				: !git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main").ok
					? `${repo} has no origin/main`
					: null;
	if (gitSkip !== null || git === null) {
		const reason = gitSkip ?? "git is not available on this machine";
		skip("checkout-behind-main", reason);
		skip("process-older-than-head", reason);
		skip("ff-lull", reason);
	} else {
		/** ISO time of a ref's newest reflog entry (when it last moved here), or null. */
		const movedAt = (ref: string) => {
			const m = /@\{(\d+)\}/.exec(git("log", "-g", "-1", "--date=unix", "--format=%gd", ref).out);
			return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
		};
		const head = git("rev-parse", "HEAD").out;
		const origin = git("rev-parse", "origin/main").out;
		const h = head.slice(0, 12);
		const o = origin.slice(0, 12);
		const headAt = [git("log", "-1", "--format=%cI", "HEAD").out, movedAt("HEAD")].filter(Boolean).map(t => new Date(t!).toISOString()).sort().at(-1)!;
		const gitShown = `git -C ${repo} rev-parse HEAD origin/main; git -C ${repo} merge-base --is-ancestor HEAD origin/main; git -C ${repo} merge-base --is-ancestor origin/main HEAD; git -C ${repo} log --reverse --format='%cI %s' HEAD..origin/main`;
		// Tracked-file cleanliness needs the status call itself to have succeeded; an empty stdout from a
		// failed call is not "clean". Untracked files are not checked (a fast-forward leaves them alone).
		let ffClean = false;
		if (head && origin && head !== origin) {
			// Four shapes: behind (HEAD is an ancestor of origin/main), ahead (origin/main is an ancestor of
			// HEAD: local commits not yet on main, no finding), diverged (neither), equal (handled above).
			const behind = git("merge-base", "--is-ancestor", "HEAD", "origin/main").ok;
			const aheadOnly = !behind && git("merge-base", "--is-ancestor", "origin/main", "HEAD").ok;
			if (behind) {
				const ahead = git("log", "--reverse", "--format=%cI%x09%s", "HEAD..origin/main").out.split("\n").filter(Boolean);
				const status = git("status", "--porcelain", "--untracked-files=no");
				const dirty = status.out.split("\n").filter(Boolean);
				const [oldestAt, oldestSubject] = (ahead[0] ?? "\t").split("\t");
				ffClean = status.ok && dirty.length === 0;
				const why = !status.ok ? "git status failed, so tracked-file cleanliness is unknown" : dirty.length > 0 ? `fast-forward would refuse, tracked files modified: ${dirty.join("; ")}` : "fast-forward at a lull";
				findings.push({
					key: `checkout-behind-main:${h}:${o}`,
					invariant: "checkout-behind-main",
					workload: "checkout",
					since: movedAt("refs/remotes/origin/main") ?? new Date(oldestAt!).toISOString(),
					text: `checkout ${repo} is behind origin/main by ${ahead.length} (oldest: ${oldestSubject}); ${why} (reviews in flight now: ${reviewsInFlight.length}).`,
					query: gitShown,
				});
			} else if (!aheadOnly) {
				const behindBy = git("rev-list", "--count", "HEAD..origin/main").out;
				const aheadOfOrigin = git("rev-list", "--count", "origin/main..HEAD").out;
				findings.push({
					key: `checkout-behind-main:diverged:${h}:${o}`,
					invariant: "checkout-behind-main",
					workload: "checkout",
					since: movedAt("refs/remotes/origin/main") ?? asOf,
					text: `checkout HEAD ${h} has DIVERGED from origin/main ${o} (${aheadOfOrigin} local-only, ${behindBy} behind); a fast-forward is impossible. Needs a person.`,
					query: gitShown,
				});
			}
		}
		// The orchestrator runs the code its checkout held when it started; HEAD arriving later means stale code.
		// Persistent seats (`omp --cwd <this repo> --session-dir …/seat-sessions/<seat>`) are not the
		// orchestrator and do not load as2 code, so they are skipped.
		const procQuery = `pgrep -f 'omp --cwd ${repo}( |$)' (skipping commands containing /seat-sessions/); ps -o lstart= -p <pid>; git -C ${repo} log -1 --format=%cI HEAD; git -C ${repo} log -g -1 --date=unix --format=%gd HEAD`;
		const probe = input.orchestrators();
		if ("skipped" in probe) skip("process-older-than-head", probe.skipped);
		else if (probe.found.every(p => p.command.includes("/seat-sessions/"))) skip("process-older-than-head", `no orchestrator process (omp --cwd ${repo}) on this machine`);
		else {
			for (const p of probe.found.filter(p => !p.command.includes("/seat-sessions/"))) {
				if (!p.started || Number.isNaN(p.started.getTime()) || p.started.toISOString() >= headAt) continue;
				findings.push({
					key: `process-older-than-head:${p.pid}:${h}`,
					invariant: "process-older-than-head",
					workload: "checkout",
					since: headAt,
					text: `omp pid ${p.pid} (orchestrator, --cwd ${repo}) started ${p.started.toISOString()}, before HEAD ${h} arrived at ${headAt}: it is running older code than the checkout. Restart it (/exit, then as2).`,
					query: procQuery,
				});
			}
		}
		// A lull: behind, tracked files clean, and no review hand in flight. One notice per lull: the key names
		// origin/main and the newest review settle, so a review that spawns and settles opens a new lull.
		if (!liveLanes) skip("ff-lull", NO_PGREP);
		else if (ffClean && reviewsInFlight.length === 0) {
			const rv = run<Entry>(REVIEW_SQL, { ":asOf": asOf });
			const reviewTokens = new Set(rv.rows.flatMap(e => { const s = parseHandSpawn(e.body); return s?.review ? [s.token] : []; }));
			const lastSettle = rv.rows.findLast(e => reviewTokens.has(HAND_SETTLED.exec(e.body)?.[1] ?? ""));
			const since = [lastSettle?.created_at, movedAt("refs/remotes/origin/main")].filter(Boolean).sort().at(-1) ?? asOf;
			findings.push({
				key: `ff-lull:${o}:${lastSettle?.id ?? "none"}`,
				invariant: "ff-lull",
				workload: "checkout",
				since,
				text: `lull for a fast-forward of ${repo}: 0 review hands in flight (a review's fingerprint covers its lane's worktree only and leaves refs other than HEAD's out, classifier/src/fingerprint.ts header, so none is in flight to be changed), tracked files clean (untracked not checked), ${liveLanes.size} lanes alive${orphanReviews.length ? ` (unsettled review hands whose lane is gone, not counted: ${orphanReviews.join(", ")})` : ""}. Last review settled: ${lastSettle ? `${lastSettle.id} at ${lastSettle.created_at}` : "none"}.`,
				query: `${unsettled.shown} -- in flight = review yes and the spawning lane (created_by) is in pgrep -fl 'surface/scripts/lane.ts run'; last settle: ${rv.shown}`,
			});
		}
	}

	// ---- stale-backup -----------------------------------------------------------------------------
	// A finding only when the ledger's newest write is newer than the newest copy by more than the gap: writes no
	// copy captured. Never the copy's wall-clock age: 2026-10-09T18:03Z to 2026-10-11T18:10Z the ledger wrote
	// nothing, every copy matched it, and an age-of-copy rule read that as stale (wl-mv4gn9l7spcsg0 FINDINGS.md).
	const { dir: backupDir, gapMs } = input.backups;
	const replayNote = replay ? " (replay: the backup directory and its files are read as they are on disk now, not as of as-of: copies pruned since are missing, copies named after as-of are ignored)" : "";
	const hours = (ms: number) => `${(ms / (60 * MIN)).toFixed(1)}h`;
	let copies: { name: string; at: string }[] | null = null;
	try {
		copies = (existsSync(backupDir) ? readdirSync(backupDir) : []).flatMap(name => {
			const m = BACKUP_NAME.exec(name);
			return m ? [{ name, at: `${m[1]}T${m[2]}:${m[3]}:${m[4]}` }] : [];
		}).filter(c => c.at <= asOf).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	} catch (e) {
		skip("stale-backup", `the backup directory ${backupDir} could not be listed: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (copies) {
		// Every created_at across the tables that have one (the copy is the whole file, so these are the copied tables).
		const writesSql = db.query<{ name: string }, []>(
			"SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'created_at') ORDER BY m.name",
		).all().map(t => `SELECT created_at FROM "${t.name}"`).join(" UNION ALL ");
		const writes = run<{ oldest: string | null; newest: string | null }>(
			`SELECT min(created_at) AS oldest, max(created_at) AS newest FROM (${writesSql}) WHERE created_at <= :asOf`,
			{ ":asOf": asOf },
		);
		const { oldest, newest } = writes.rows[0]!;
		// The newest copy that is a complete ledger by the backup writer's own test (copyProblem: not empty, readable,
		// integrity_check ok, at a version Ledger.open opens). A newer file named like a copy that fails it captured nothing, so the
		// walk goes back past it; opening is read-only, and quarantining such a file stays the writer's job.
		const rejected: string[] = [];
		let newestCopy: { name: string; at: string } | undefined;
		for (const c of copies.toReversed()) {
			const problem = copyProblem(join(backupDir, c.name));
			if (problem === null) { newestCopy = c; break; }
			rejected.push(`${c.name} (${problem})`);
		}
		// With no complete copy at all, nothing since the ledger's first write is captured.
		const capturedAt = newestCopy?.at ?? oldest;
		const behindMs = newest && capturedAt ? Date.parse(newest) - Date.parse(capturedAt) : 0;
		if (behindMs > gapMs) {
			const copyText = (newestCopy
				? `newest ledger backup ${newestCopy.at} (${newestCopy.name})`
				: `no ledger backup at or before ${asOf} (first ledger write ${oldest})`)
				+ (rejected.length ? `; not counted, not a complete copy: ${rejected.join(", ")}` : "");
			findings.push({
				key: `stale-backup:${newestCopy?.name ?? "none"}`,
				invariant: "stale-backup",
				workload: "ledger",
				since: capturedAt!,
				text: `newest ledger write ${newest} is ${hours(behindMs)} newer than ${copyText} in ${backupDir} (gap ${hours(gapMs)})${replayNote}: writes since then are in no copy. The job is ledger/scripts/backup.ts (launchd agent com.agent-system-2.ledger-backup on macOS).`,
				query: `ls ${backupDir}/ledger-*.db; copyProblem() (ledger/src/index.ts) on each, newest first; ${writes.shown}`,
			});
		}
	}

	// ---- ledger-health ----------------------------------------------------------------------------
	// The live file itself (ledger audit A5-1, A5-2), read-only: page and index health (PRAGMA quick_check;
	// integrity_check otherwise runs only on copies), foreign keys (PRAGMA foreign_key_check: the sqlite3 CLI
	// writes with them off) and the trigger set against the one schema.sql gives the file's version (a missing
	// or rewritten trigger passes integrity_check and user_version alike; Ledger.open refuses such a file).
	// One finding per failing check; each key carries a digest of what failed, so a different failure is a new
	// finding.
	const healthNote = replay ? " (replay: the file is checked as it is now, not as of as-of)" : "";
	const health = (kind: string, detail: string, text: string, query: string) => findings.push({
		key: `ledger-health:${kind}:${createHash("sha256").update(detail).digest("hex").slice(0, 12)}`,
		invariant: "ledger-health", workload: "ledger", since: asOf, text: `${text}${healthNote}`, query,
	});
	const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
	try {
		const problems = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().map(r => r.quick_check);
		if (problems.join("\n") !== "ok") {
			health("quick-check", problems.join("\n"), `PRAGMA quick_check on the live ledger reports ${problems.length} problem(s): ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; …" : ""}. The newest complete copy is the restore point (stale-backup reads the copies).`, "PRAGMA quick_check;");
		}
	} catch (e) {
		health("quick-check", errText(e), `PRAGMA quick_check on the live ledger failed: ${errText(e)}.`, "PRAGMA quick_check;");
	}
	try {
		const orphans = db.query<{ table: string; rowid: number | null; parent: string }, []>("PRAGMA foreign_key_check").all();
		if (orphans.length) {
			const shown = orphans.map(r => `${r.table} rowid ${r.rowid} -> ${r.parent}`);
			health("foreign-keys", shown.join("\n"), `PRAGMA foreign_key_check: ${orphans.length} row(s) name a parent row that does not exist: ${shown.slice(0, 5).join(", ")}${orphans.length > 5 ? ", …" : ""}.`, "PRAGMA foreign_key_check;");
		}
	} catch (e) {
		health("foreign-keys", errText(e), `PRAGMA foreign_key_check on the live ledger failed: ${errText(e)}.`, "PRAGMA foreign_key_check;");
	}
	const triggersQuery = "PRAGMA user_version; SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name;";
	const fileVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
	if (!openableVersion(fileVersion)) {
		health("triggers", `version ${fileVersion}`, `the ledger is schema version ${fileVersion}, which Ledger.open neither supports (${SCHEMA_VERSION}) nor upgrades, so its trigger set has nothing to be compared with.`, triggersQuery);
	} else {
		const drift = triggerDrift(db);
		if (drift) {
			const described = describeDrift(drift);
			health("triggers", described, `the ledger's triggers are not the ones schema.sql gives schema version ${drift.version}: ${described}. Ledger.open refuses this file until they are; a rule the module relies on may be gone.`, triggersQuery);
		}
	}

	return {
		asOf, replay, liveLanes: liveLanes ? [...liveLanes] : null, reviewsInFlight, orphanReviews, findings, skipped,
		elapsedMs: Math.round(performance.now() - t0),
	};
}

// ---- the machine: what the CLI reads and the tests inject ----------------------------------------

/** What a process call returned. */
export interface RunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}
/** A process call; injectable so a test can make `pgrep` or `ps` fail. */
export type Run = (argv: string[]) => RunResult;
const spawnRun: Run = argv => {
	const p = Bun.spawnSync(argv, { env: { ...process.env, LC_ALL: "C" } });
	return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

/**
 * Runs a process-table probe. pgrep exits 0 with matches and 1 for "no match" (an answer: nothing is
 * running); any other exit, or a spawn failure, is "could not look" and comes back as a skip reason,
 * so a broken probe never reads as a dead lane or a lull.
 */
function pgrep(args: string[], run: Run = spawnRun): Probe<string[]> {
	try {
		const p = run(["pgrep", ...args]);
		const lines = p.stdout.split("\n").filter(Boolean);
		if (p.exitCode === 0 || p.exitCode === 1) return { found: lines };
		const err = p.stderr.trim();
		return { skipped: `pgrep ${args.join(" ")} exited ${p.exitCode}${err ? `: ${err}` : ""}` };
	} catch (e) {
		return { skipped: `pgrep failed to start: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** `<workload> <laneId>` per `surface/scripts/lane.ts run` process, or why the process table could not be read. */
export function liveLanesFromPgrep(): Probe<Set<string>> {
	if (!available("pgrep")) return { skipped: "pgrep is not available on this machine" };
	const p = pgrep(["-fl", "surface/scripts/lane\\.ts run "]);
	if ("skipped" in p) return p;
	const out = new Set<string>();
	for (const line of p.found) {
		const m = /surface\/scripts\/lane\.ts run (\S+) (\S+)/.exec(line);
		if (m) out.add(`${m[1]} ${m[2]}`);
	}
	return { found: out };
}

function available(cmd: string): boolean {
	return Bun.which(cmd) !== null;
}

export function gitIn(repo: string): Git {
	return (...a: string[]) => {
		const p = Bun.spawnSync(["git", "--no-optional-locks", "-C", repo, ...a]);
		return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
	};
}

/** What `orchestratorsFromPs` calls; the defaults are the real machine. */
export interface PsDeps {
	run: Run;
	/** Whether a pid still exists (ledger/src/index.ts processAlive: only ESRCH is gone). */
	alive: (pid: number) => boolean;
	available: (cmd: string) => boolean;
}

/**
 * Every `omp --cwd <repo>` process with its `ps` start time, or why they could not be listed. A `ps`
 * call that fails for a pid that is gone means the process exited between pgrep and ps and is left
 * out; one that fails for a pid still alive (or cannot start) is "could not look": a skip, never a
 * vanished process, so a broken ps cannot hide an orchestrator older than HEAD.
 */
export function orchestratorsFromPs(repo: string, deps: PsDeps = { run: spawnRun, alive: processAlive, available }): Probe<OrchestratorProcess[]> {
	if (!deps.available("ps")) return { skipped: "ps is not available on this machine" };
	if (!deps.available("pgrep")) return { skipped: "pgrep is not available on this machine" };
	const pids = pgrep(["-f", `omp --cwd ${repo.replaceAll(".", "\\.")}( |$)`], deps.run);
	if ("skipped" in pids) return pids;
	const ps = (field: string, pid: string): { out: string } | { gone: true } | { failed: string } => {
		const argv = ["ps", "-o", `${field}=`, "-p", pid];
		let p: RunResult;
		try {
			p = deps.run(argv);
		} catch (e) {
			return { failed: `${argv.join(" ")} could not start: ${e instanceof Error ? e.message : String(e)}` };
		}
		if (p.exitCode === 0) return { out: p.stdout.trim() };
		if (!deps.alive(Number(pid))) return { gone: true };
		const err = p.stderr.trim();
		return { failed: `${argv.join(" ")} exited ${p.exitCode} while pid ${pid} is alive${err ? `: ${err}` : ""}` };
	};
	const found: OrchestratorProcess[] = [];
	for (const pid of pids.found) {
		const lstart = ps("lstart", pid);
		if ("failed" in lstart) return { skipped: `ps failed: ${lstart.failed}` };
		const command = ps("command", pid);
		if ("failed" in command) return { skipped: `ps failed: ${command.failed}` };
		if ("gone" in lstart || "gone" in command) continue; // the process exited between pgrep and ps
		found.push({ pid, command: command.out, started: lstart.out ? new Date(lstart.out) : null });
	}
	return { found };
}

// ---- output -----------------------------------------------------------------------------------------

export function counts(report: Report): string {
	return INVARIANTS.map(i => `${i}=${report.findings.filter(f => f.invariant === i).length}`).join(" ");
}

export function summaryLine(report: Report): string {
	const replay = report.replay ? " (REPLAY: live lanes = processes alive now whose lane had started by as-of; lane rpc logs read as of now; git invariants skipped)" : "";
	const lanes = report.liveLanes === null ? "unknown" : String(report.liveLanes.length);
	return `as-of ${report.asOf}${replay}; live lanes ${lanes}; reviews in flight ${report.reviewsInFlight.length}`;
}

export function jsonLines(report: Report): string {
	return [
		...report.findings.map(f => JSON.stringify({ ...f, asOf: report.asOf })),
		...report.skipped.map(s => JSON.stringify({ invariant: s.invariant, skipped: s.skipped, asOf: report.asOf })),
	].join("\n");
}

export function renderTable(report: Report): string {
	const out = [summaryLine(report)];
	for (const f of report.findings) out.push(`\n[${f.invariant}] ${f.workload} since ${f.since}\n  ${f.text}\n  key: ${f.key}\n  query: ${f.query}`);
	if (report.skipped.length > 0) {
		out.push("");
		for (const s of report.skipped) out.push(`[${s.invariant}] skipped: ${s.skipped}`);
	}
	out.push(`\n${report.findings.length} finding(s): ${counts(report)}; ${report.skipped.length} skipped; ${report.elapsedMs} ms`);
	return out.join("\n");
}

export function reviewsLine(report: Report): string {
	const lanes = report.liveLanes === null ? "unknown" : String(report.liveLanes.length);
	return `lanes-alive ${lanes} reviews-in-flight ${report.reviewsInFlight.length}${report.reviewsInFlight.length ? ` tokens ${report.reviewsInFlight.join(",")}` : ""}${report.orphanReviews.length ? ` orphan-reviews ${report.orphanReviews.join(",")}` : ""}`;
}

export interface Args {
	json: boolean;
	reviews: boolean;
	asOf: string | null;
	repo: string;
	/** stale-backup's gap in ms (`--backup-gap <hours>`). */
	backupGapMs: number;
}

export function parseArgs(argv: string[], scriptDir: string): Args {
	const args: Args = { json: false, reviews: false, asOf: null, repo: resolve(scriptDir, "..", ".."), backupGapMs: BACKUP_GAP_MS };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const value = (): string => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === "--json") args.json = true;
		else if (a === "--reviews") args.reviews = true;
		else if (a === "--as-of") {
			const t = Date.parse(value());
			if (Number.isNaN(t)) throw new Error("--as-of takes an ISO-8601 time");
			args.asOf = new Date(t).toISOString();
		} else if (a === "--repo") args.repo = resolve(value());
		else if (a === "--backup-gap") {
			const h = Number(value());
			if (!Number.isFinite(h) || h <= 0) throw new Error("--backup-gap takes a positive number of hours");
			args.backupGapMs = h * 60 * MIN;
		}
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

export function main(argv: string[]): number {
	const args = parseArgs(argv, import.meta.dir);
	const ledgerPath = defaultLedgerPath();
	assertNotLiveLedgerUnderTest(ledgerPath);
	const db = new Database(ledgerPath, { readonly: true });
	try {
		const home = homeDir();
		// The directory Ledger.open's default backup policy writes: backups/<namespace of the canonical path> beside the ledger.
		const canonical = canonicalPath(ledgerPath);
		const report = check({
			db,
			asOf: args.asOf ?? new Date().toISOString(),
			replay: args.asOf !== null,
			liveLanes: liveLanesFromPgrep(),
			lanesDirOf: wl => laneDir(wl, home),
			repo: args.repo,
			git: available("git") ? gitIn(args.repo) : null,
			orchestrators: () => orchestratorsFromPs(args.repo),
			backups: { dir: join(dirname(canonical), "backups", backupNamespace(canonical)), gapMs: args.backupGapMs },
		});
		if (args.reviews) console.log(reviewsLine(report));
		else if (args.json) {
			const lines = jsonLines(report);
			if (lines) console.log(lines);
			console.error(`${summaryLine(report)}; ${counts(report)}; ${report.skipped.length} skipped; ${report.elapsedMs} ms`);
		} else console.log(renderTable(report));
	} finally {
		db.close();
	}
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(2);
	}
}
