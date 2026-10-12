// Restore the ledger from a scheduled copy (audit finding A7-1).
// Usage: bun run ledger/scripts/restore.ts <backup> [ledger]
// (ledger default: $AGENT_SYSTEM_LEDGER_DB, else $HOME/.agent-system-2/ledger.db.)
// In order, stopping at the first refusal with nothing changed:
//   1. the backup must be a complete copy (`copyProblem`: non-empty, integrity_check ok, at the
//      supported schema version) and must not be the ledger itself;
//   2. no writer may be running: no `surface/scripts/lane.ts run` process and no `omp --cwd <this
//      checkout>` process (the invariant report's own probes, surface/scripts/invariants.ts), and no
//      process holding the ledger or its -wal/-shm (lsof, or /proc/<pid>/fd where lsof is absent).
//      A probe that cannot look refuses too: "could not check" is never "nothing running". That
//      includes a look that was incomplete: an lsof diagnostic, or a process whose fds could not be
//      read while it still exists.
// Then: the ledger and its -wal/-shm are renamed to `<ledger>.pre-restore-<time>{,-wal,-shm}` (never
// deleted, never over an existing file); the backup is copied to a temporary file beside the
// ledger, checked again, and renamed into place; `Ledger.open` opens it once, which switches the
// copy's `delete` journal back to WAL; the writes lost are printed (every provenance row of the
// moved-aside ledger that the restored copy does not hold, per table, inserts apart from updates);
// the invariant report runs over the restored ledger; and the commands that undo the restore are
// printed. The undo touches only what this run moved: the originals it moved aside go back, and
// the replacement files at the ledger's names are set aside only once the replacement was installed.
// Platform-neutral: the same commands on macOS and Linux.
// Exit: 0 restored · 1 failed (the undo is printed if anything was moved) · 2 refused or usage
// · 3 ledger path refused as synced or network.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { liveLanesFromPgrep, orchestratorsFromPs, type Probe } from "../../surface/scripts/invariants";
import { assertLocalPath, copyProblem, defaultLedgerPath, Ledger, LedgerLocationError } from "../src/index";

const SUFFIXES = ["", "-wal", "-shm"] as const;
const REPO = resolve(import.meta.dir, "..", "..");

export interface RestoreDeps {
	/** Every process that could write the ledger at this canonical path, or why they could not be listed. */
	writers: (ledgerPath: string) => Probe<string[]>;
	/** Run the invariant report over the restored ledger; its exit code. */
	invariants: (ledgerPath: string) => number;
	now: () => Date;
	log: (line: string) => void;
	/** Rename one file (default `renameSync`); a test injects a failure at a chosen step. */
	rename?: (from: string, to: string) => void;
}

/** A refusal: nothing was changed. */
export class RestoreRefused extends Error {}

/** One provenance row. Every insert and update of a logged table appends one (schema.sql, the `*_log_*` triggers). */
interface Write {
	seq: number;
	at: string;
	tbl: string;
	row_id: string;
	action: string;
}

const writeKey = (w: Write) => [w.seq, w.at, w.tbl, w.row_id, w.action].join("\u0000");

function writes(db: Database): Write[] {
	return db.query<Write, []>("SELECT seq, at, tbl, row_id, action FROM provenance ORDER BY seq").all();
}

/**
 * The writes lost: every provenance row of the moved-aside ledger that the restored copy does not
 * hold, by membership rather than by a newest timestamp, so an update (whose row keeps its
 * created_at), an insert stamped the same instant as the copy's newest row, and a restore to an
 * empty copy are all counted.
 */
export function lossLines(before: Write[], after: Write[]): string[] {
	const kept = new Set(after.map(writeKey));
	const lost = before.filter((w) => !kept.has(writeKey(w)));
	const had = new Set(before.map(writeKey));
	const foreign = after.filter((w) => !had.has(writeKey(w))).length;
	const newest = (ws: Write[]) => (ws.length ? `seq ${ws.at(-1)!.seq} at ${ws.at(-1)!.at}` : "none");
	const byTable = (action: string, describe: (rows: number, ws: number) => string) => {
		const tables = new Map<string, Write[]>();
		for (const w of lost.filter((l) => l.action === action)) tables.set(w.tbl, [...(tables.get(w.tbl) ?? []), w]);
		return [...tables].sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([t, ws]) => `${t} ${describe(new Set(ws.map((w) => w.row_id)).size, ws.length)}`).join(", ") || "none";
	};
	return [
		`writes lost: ${lost.length} of the moved-aside ledger's ${before.length} provenance row(s) are not in the restored copy (moved-aside newest ${newest(before)}; restored newest ${newest(after)})`,
		...(after.length === 0 ? ["  the restored copy is empty: it holds no writes at all"] : []),
		`  rows inserted after the copy, missing from the restored ledger: ${byTable("insert", (rows) => `${rows}`)}`,
		`  updates after the copy, reverted in the restored ledger: ${byTable("update", (rows, n) => `${rows} row(s), ${n} update(s)`)}`,
		...(foreign ? [`  the restored copy holds ${foreign} write(s) the moved-aside ledger does not: it is not an earlier copy of this ledger`] : []),
	];
}

/**
 * Open a ledger file read-only. A WAL-mode file whose -wal and -shm are gone (every writer closed, the
 * last through a client that removes them, as the sqlite3 CLI does) fails Bun's plain read-only open
 * with "unable to open database file", at construction or at the first read, so the probe reads;
 * with no -wal there is nothing outside the main file, so it is opened `immutable` instead, which
 * creates no file beside it.
 */
function openReadonly(path: string): Database {
	let db: Database | undefined;
	try {
		db = new Database(path, { readonly: true });
		db.query("SELECT count(*) FROM sqlite_master").get();
		return db;
	} catch (e) {
		db?.close();
		if (existsSync(`${path}-wal`)) throw e;
		return new Database(`file:${path.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}?immutable=1`, { readonly: true });
	}
}

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The shell lines that undo exactly what this run did. `installed`: the replacement is at the
 * ledger's names, so every file there is one this run put there (all the originals were moved first);
 * those are set aside as `.restored-<time>`. Before that, nothing at the ledger's names is touched:
 * an original that was never moved stays where it is. Then each original in `moved` goes back. One
 * subshell under `set -e`, so the first move that cannot be made stops the rest (an original main
 * file must never be put back beside a WAL that is not its own); a name that is taken is never
 * replaced.
 */
function undoLines(target: string, aside: string, moved: readonly string[], installed: boolean, stamp: string): string[] {
	const restoredAside = `${target}.restored-${stamp}`;
	const move = (from: string, to: string) =>
		`if [ -e ${shellQuote(to)} ]; then echo ${shellQuote(`undo stopped: ${to} exists`)} >&2; exit 1; fi; mv ${shellQuote(from)} ${shellQuote(to)}`;
	return [
		"# stop every lane and orchestrator first, then:",
		"(",
		"set -e",
		...(installed ? SUFFIXES.map((s) => `if [ -e ${shellQuote(target + s)} ]; then ${move(target + s, restoredAside + s)}; fi`) : []),
		...moved.map((s) => move(aside + s, target + s)),
		")",
	];
}

/** Restore `backupArg` over the ledger at `ledgerArg`. Throws RestoreRefused before changing anything. */
export function restore(backupArg: string, ledgerArg: string, deps: RestoreDeps): { aside: string; moved: string[]; target: string } {
	const rename = deps.rename ?? renameSync;
	const target = assertLocalPath(ledgerArg);
	if (!existsSync(backupArg)) throw new RestoreRefused(`no backup at ${resolve(backupArg)}`);
	// Canonical, like the ledger's path: a symlinked tmp or home must not hide that the two are one file.
	const backup = realpathSync(backupArg);
	if (backup === target) throw new RestoreRefused(`${backup} is the ledger itself, not a copy of it`);
	const problem = copyProblem(backup);
	if (problem) throw new RestoreRefused(`${backup} is not a complete copy of a ledger (${problem}); nothing changed`);

	const writers = deps.writers(target);
	if ("skipped" in writers) throw new RestoreRefused(`could not check for running writers (${writers.skipped}); nothing changed`);
	if (writers.found.length) {
		throw new RestoreRefused(`writers are running; stop them and run this again (nothing changed):\n${writers.found.map((w) => `  ${w}`).join("\n")}`);
	}

	const stamp = deps.now().toISOString().replace(/:/g, "-");
	const aside = `${target}.pre-restore-${stamp}`;
	const present = SUFFIXES.filter((s) => existsSync(target + s));
	for (const s of present) if (existsSync(aside + s)) throw new RestoreRefused(`${aside + s} exists; nothing changed`);

	// What the live file holds, read before it moves. A file that cannot be read is reported, not a refusal:
	// restoring over a damaged ledger is what this script is for.
	let before: Write[] | string | null = null;
	if (present.includes("")) {
		let db: Database | undefined;
		try {
			db = openReadonly(target);
			before = writes(db);
		} catch (e) {
			before = `unreadable: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			db?.close();
		}
	}

	// `moved`: originals now at `aside`. `installed`: the replacement is at the ledger's name. The undo
	// is built from these two alone, so it reverses exactly what happened, wherever this stopped.
	const moved: string[] = [];
	let installed = false;
	const undo = () => undoLines(target, aside, moved, installed, stamp);
	try {
		for (const s of present) {
			rename(target + s, aside + s);
			moved.push(s);
			deps.log(`moved aside: ${target + s} -> ${aside + s}`);
		}
		const tmp = join(dirname(target), `.${basename(target)}.restore-${process.pid}.tmp`);
		try {
			copyFileSync(backup, tmp);
			const again = copyProblem(tmp);
			if (again) throw new Error(`the copy of ${backup} at ${tmp} is not complete (${again})`);
			if (existsSync(target)) throw new Error(`${target} appeared while restoring; a writer started`);
			rename(tmp, target);
			installed = true;
		} finally {
			rmSync(tmp, { force: true });
		}
		deps.log(`restored: ${backup} -> ${target}`);

		const ledger = Ledger.open(target, { backupOnOpen: false });
		let after: Write[];
		try {
			const mode = ledger.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode;
			after = writes(ledger.db);
			deps.log(`opened with Ledger.open: journal_mode ${mode}, ${ledger.inFlight().length} open workload(s)`);
		} finally {
			ledger.close();
		}

		if (before === null) deps.log("writes lost: none known (there was no ledger file to move aside)");
		else if (typeof before === "string") deps.log(`writes lost: unknown, the moved-aside ledger is ${before}`);
		else for (const line of lossLines(before, after)) deps.log(line);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (moved.length) throw new Error(`${message}\nundo:\n${undo().join("\n")}`);
		throw e;
	}

	deps.log("invariant report over the restored ledger:");
	const code = deps.invariants(target);
	if (code !== 0) deps.log(`the invariant report exited ${code}; the restore itself is done`);
	deps.log("undo:");
	for (const line of undo()) deps.log(line);
	return { aside, moved, target };
}

/** What `holders` asks of the machine; a test supplies its own. */
export interface HolderSys {
	which: (command: string) => string | null;
	run: (argv: string[]) => { exitCode: number | null; stdout: string; stderr: string };
	exists: (path: string) => boolean;
	readdir: (path: string) => string[];
	readlink: (path: string) => string;
}

const machine: HolderSys = {
	which: (command) => Bun.which(command),
	run: (argv) => {
		const p = Bun.spawnSync(argv);
		return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
	},
	exists: existsSync,
	readdir: (path) => readdirSync(path),
	readlink: (path) => readlinkSync(path),
};

const errorCode = (e: unknown) => (e && typeof e === "object" && "code" in e ? String(e.code) : e instanceof Error ? e.message : String(e));

/**
 * Pids holding any of `files` open: lsof where present, else /proc/<pid>/fd (Linux). Only a complete
 * look returns `found`; anything it could not inspect is `skipped`, which refuses the restore.
 */
export function holders(files: string[], sys: HolderSys = machine): Probe<string[]> {
	if (files.length === 0) return { found: [] };
	if (sys.which("lsof")) {
		// `-t` turns warnings off (lsof(8): "The -t option selects the -w option"); `+w` turns them back
		// on, so a file or process lsof could not inspect shows on stderr instead of passing silently.
		const p = sys.run(["lsof", "-t", "+w", "--", ...files]);
		const pids = p.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
		const diagnostic = p.stderr.trim();
		if (p.exitCode === 0 && pids.length) return { found: pids.map((pid) => `pid ${pid} holds the ledger (lsof)`) };
		// No holder: exit 1, nothing on stdout, and nothing on stderr. Exit 1 with a diagnostic is a failed look.
		if (p.exitCode === 1 && pids.length === 0 && diagnostic === "") return { found: [] };
		return { skipped: `lsof exited ${p.exitCode} with ${pids.length} pid(s): ${diagnostic || "no diagnostic"}` };
	}
	if (sys.exists("/proc/self/fd")) {
		const wanted = new Set(files);
		const found: string[] = [];
		let pids: string[];
		try {
			pids = sys.readdir("/proc").filter((n) => /^\d+$/.test(n));
		} catch (e) {
			return { skipped: `could not list /proc (${errorCode(e)})` };
		}
		for (const pid of pids) {
			let fds: string[];
			try {
				fds = sys.readdir(`/proc/${pid}/fd`);
			} catch (e) {
				// Passed over only when the process is gone; a live process whose fds cannot be read
				// (another user's) is a process nobody inspected.
				if (errorCode(e) === "ENOENT" && !sys.exists(`/proc/${pid}`)) continue;
				return { skipped: `could not read /proc/${pid}/fd (${errorCode(e)}); that process may hold the ledger` };
			}
			for (const fd of fds) {
				let link: string;
				try {
					link = sys.readlink(`/proc/${pid}/fd/${fd}`);
				} catch (e) {
					if (errorCode(e) === "ENOENT") continue; // that fd closed after the listing
					return { skipped: `could not read /proc/${pid}/fd/${fd} (${errorCode(e)}); that process may hold the ledger` };
				}
				if (wanted.has(link)) {
					found.push(`pid ${pid} holds the ledger (/proc/${pid}/fd)`);
					break;
				}
			}
		}
		return { found };
	}
	return { skipped: "neither lsof nor /proc is available to see which processes hold the ledger" };
}

/** Lane runs, orchestrators on this checkout, and holders of the file: the real machine. */
export function liveWriters(ledgerPath: string): Probe<string[]> {
	const lanes = liveLanesFromPgrep();
	if ("skipped" in lanes) return { skipped: `lane processes: ${lanes.skipped}` };
	const orchestrators = orchestratorsFromPs(REPO);
	if ("skipped" in orchestrators) return { skipped: `orchestrator processes: ${orchestrators.skipped}` };
	const held = holders(SUFFIXES.map((s) => ledgerPath + s).filter(existsSync));
	if ("skipped" in held) return { skipped: `file holders: ${held.skipped}` };
	return {
		found: [
			...[...lanes.found].map((l) => `lane: surface/scripts/lane.ts run ${l}`),
			...orchestrators.found.map((o) => `orchestrator: pid ${o.pid} ${o.command}`),
			...held.found,
		],
	};
}

if (import.meta.main) {
	const [backupArg, ledgerArg, ...extra] = process.argv.slice(2);
	if (!backupArg || extra.length) {
		console.error("usage: bun run ledger/scripts/restore.ts <backup> [ledger]");
		process.exit(2);
	}
	try {
		restore(backupArg, ledgerArg ?? defaultLedgerPath(), {
			writers: liveWriters,
			invariants: (ledgerPath) => Bun.spawnSync(["bun", join(REPO, "surface", "scripts", "invariants.ts")], {
				env: { ...process.env, AGENT_SYSTEM_LEDGER_DB: ledgerPath },
				stdout: "inherit",
				stderr: "inherit",
			}).exitCode ?? 1,
			now: () => new Date(),
			log: (line) => console.log(line),
		});
	} catch (e) {
		console.error(`ledger restore ${e instanceof RestoreRefused ? "refused" : "failed"}: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(e instanceof RestoreRefused ? 2 : e instanceof LedgerLocationError ? 3 : 1);
	}
}
