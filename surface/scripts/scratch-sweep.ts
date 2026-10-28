#!/usr/bin/env bun
// scratch-sweep: the daily sweep of the per-workload scratch roots (PLAN wl-mv5oikd5jtquww § 1.6), run by
// launchd at 04:30 (install/com.agent-system-2.scratch-sweep.plist, written by install.sh --scratch-sweep).
//
//   bun surface/scripts/scratch-sweep.ts [--dry-run] [--home <dir>] [--legacy-tmp <dir>] [--now <ISO time>]
//
// One run, in order:
//  1. The ledger ($AGENT_SYSTEM_LEDGER_DB, else <home>/.agent-system-2/ledger.db) is opened read-only for
//     workload state. When it cannot be read nothing is removed (a root's fate is never guessed).
//  2. Each child of the base (gates/src/scratch.ts scratchBase(<home>)): a symlink or a non-directory is
//     refused (left alone, one report line). A directory goes when no workload has its name as id,
//     when its workload is closed, or when its workload is open with no live holder (launch.ts heldLive:
//     no holder, or a lapsed lease) and nothing under it (lstat mtime, links not followed) changed for 3
//     days: the lane died, and a relaunch re-creates the root empty. Everything else is kept. A `.removing-*`
//     directory (a removal's rename target, left by a remove that failed part-way, before or after archives existed)
//     goes once nothing in it changed for 3 days; its name is never taken as proof that it was archived. A root that
//     goes is first renamed aside under the ledger's write lock (BEGIN IMMEDIATE on a read-write handle opened at the
//     first removal; nothing is written under it): under it the workload row is read again (a root whose workload is
//     now held live, or whose row changed since the first read, is kept) and the root is renamed through
//     surface/src/scratch-remove.ts detachChild (same dev/ino as when judged, renamed in the base, checked again). A
//     claim is a write transaction, so it lands either before that transaction (the root is kept) or after the rename
//     (the claiming side re-creates the root). After the lock is released the detached tree is archived and verified
//     (surface/src/scratch-archive.ts archiveDetached: one `.tar.gz` under the archive base, scratchArchiveBase(<home>),
//     a sibling of the scratch base; capacity checked first, the extraction compared entry by entry with the tree, the
//     tree read again after), and only a verified archive lets the recursive remove (purgeDetached) run. A tree whose
//     archive fails is renamed back and kept ("archive failed"). One root's failure never stops the others; every one is
//     reported. Outside the base only expired archives (step 3) are removed.
//  3. Archives under the archive base older than `scratchArchive.expireDays` (profile config, default 14) are removed,
//     with their `<archive>.offsite` marker and the offsite job's `.attempts` / `.stuck` sidecars; with
//     `scratchArchive.requireOffsite: true`, only those that have the marker (an offsite copy job writes it once its copy
//     is confirmed). A name is a final archive only when it ends in `.tar.gz`, a partial only when it ends in exactly
//     `.tar.gz.partial-<12 hex>`; anything else is never touched. Each root archived and each archive expired is one
//     entry on the standing workload: `scratch-archived: <name> <archive> <bytes> <sha256>`,
//     `scratch-archive-expired: <archive> <bytes>`.
//  4. The report <home>/agent-scratch/agent-system-2.0/scratch-sweep/<local YYYY-MM-DD>.md (also printed):
//     size per root (du -sk) and its action, the archives written and expired, the remaining total under the base, the
//     free space on its volume, and the sizes of the legacy places (/tmp/wl-*, /tmp/quorum-legs-*,
//     <home>/.agent-system-2/test-runs), which are never deleted.
//  5. When the remaining total passes AGENT_SYSTEM_SCRATCH_TOTAL_MB (default SCRATCH_TOTAL_DEFAULT_MB), or the free
//     space on the scratch volume is under `scratchArchive.minFreeGib` (default 20), one `scratch-disk:` entry on the
//     standing workload (a needs-you line), at most one while it is open: the newest `scratch-disk:` /
//     `scratch-disk-ok:` entry this sweep wrote is the state. A later run with both back within bounds writes
//     `scratch-disk-ok:`, which clears the line.
//
// The `scratchArchive:` block is read from $AGENT_SYSTEM_SCRATCH_CONFIG, else the installed profile config under
// <home> (surface/src/scratch-archive.ts readScratchArchiveConfig); a missing block or key is its default.
//
// --dry-run removes nothing, writes no report file and no ledger entry; it prints what the run would do.
// --home, --legacy-tmp and --now exist for tests (a fake HOME, a fake /tmp, a fixed clock for every age and lease).
// Exit: 0 swept (refusals included), 1 the ledger could not be read, a removal failed, or the entry or the
// report could not be written, an archive or an expiry failed, 2 bad arguments or a bad AGENT_SYSTEM_SCRATCH_TOTAL_MB
// (nothing done).
import { type BigIntStats, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SCRATCH_ENTRY, SCRATCH_TOTAL_DEFAULT_MB, SCRATCH_TOTAL_ENV, scratchBase } from "../../gates/src/scratch";
import { type Archived, type ArchiveSeams, archiveDetached, archivePathFor, DEFAULT_SCRATCH_ARCHIVE, type ExpiryLine, expireArchives, freeBytes, GIB, gib, readScratchArchiveConfig, SCRATCH_ARCHIVE_KEY, type ScratchArchiveConfig, scratchArchiveBase } from "../src/scratch-archive";
import { defaultLedgerPath, type EntryRow, Ledger, type WorkloadStatusRow } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../src/identity";
import { heldLive, SCRATCH_SWEEP_BY } from "../src/launch";
import { type Detach, detachChild, newestChange, purgeDetached, REMOVING_PREFIX, restoreDetached } from "../src/scratch-remove";
import { STANDING_WORKLOAD_ID } from "../src/types";

/** An open workload's root with no live holder is removed after this long with nothing changed in it. */
export const IDLE_MS = 3 * 24 * 60 * 60 * 1000;
/** Upper bound on one `du -sk`; a root it cannot size in time is reported with an unknown size. */
const DU_TIMEOUT_MS = 300_000;
const LEGACY_TMP_PREFIXES = ["wl-", "quorum-legs-"];

const USAGE = "usage: bun surface/scripts/scratch-sweep.ts [--dry-run] [--home <dir>] [--legacy-tmp <dir>] [--now <ISO time>]";

export interface SweepArgs {
	dryRun: boolean;
	home: string;
	legacyTmp: string;
	/** The `scratchArchive:` settings (main reads them; parseArgs gives the defaults). */
	archive: ScratchArchiveConfig;
	/** What reading those settings found wrong (a malformed key falls back to its default); each is a report note. */
	configNotes: readonly string[];
	/** The run's clock (--now); null is the wall clock at the start of the run. */
	now: Date | null;
}

export function parseArgs(argv: readonly string[], home: string = homedir()): SweepArgs | string {
	const args: SweepArgs = { dryRun: false, home, legacyTmp: "/tmp", archive: { ...DEFAULT_SCRATCH_ARCHIVE }, configNotes: [], now: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--home" || a === "--legacy-tmp") {
			const v = argv[++i];
			if (v === undefined || !isAbsolute(v)) return `${a} needs an absolute directory`;
			if (a === "--home") args.home = v;
			else args.legacyTmp = v;
		} else if (a === "--now") {
			const v = argv[++i];
			const t = v === undefined ? Number.NaN : Date.parse(v);
			if (!Number.isFinite(t)) return "--now needs an ISO time";
			args.now = new Date(t);
		} else return `unknown argument ${JSON.stringify(a)}`;
	}
	if (!isAbsolute(args.home)) return `HOME is not absolute: ${JSON.stringify(args.home)}`;
	return args;
}

/** The threshold in MiB: the variable when it is a non-negative number, the default when unset or empty; else why not. */
export function totalThresholdMb(env: Readonly<Record<string, string | undefined>>): number | string {
	const raw = env[SCRATCH_TOTAL_ENV];
	if (raw === undefined || raw.trim() === "") return SCRATCH_TOTAL_DEFAULT_MB;
	if (!/^\d+(\.\d+)?$/.test(raw.trim())) return `${SCRATCH_TOTAL_ENV}=${JSON.stringify(raw)} is not a non-negative number of MiB`;
	return Number(raw.trim());
}

type Action = "removed" | "would remove" | "kept" | "refused" | "remove failed" | "archive failed";

export interface RootLine {
	name: string;
	sizeKib: number | null;
	action: Action;
	why: string;
}

export interface LegacyLine {
	path: string;
	sizeKib: number | null;
}

/** `du -sk <path>` in KiB (du does not follow symlinks by default on macOS); null when it gives no number. */
function duKib(path: string): number | null {
	const r = Bun.spawnSync(["du", "-sk", path], { stdout: "pipe", stderr: "pipe", timeout: DU_TIMEOUT_MS });
	const m = /^(\d+)\s/.exec(r.stdout.toString());
	return m ? Number(m[1]) : null;
}

/**
 * Why the row read again right before a removal no longer allows it, or null: the workload is now held live, a row
 * appeared or went, or its status, holder or lease changed since the first read.
 */
function rowChange(first: WorkloadStatusRow | null, again: WorkloadStatusRow | null, nowIso: string): string | null {
	if (again && again.status !== "closed" && heldLive(again, nowIso)) return `now held by ${again.holder}`;
	if (first === null && again !== null) return `a workload with this id now exists (${again.status})`;
	if (first !== null && again === null) return "its workload row is gone";
	if (first && again && (first.status !== again.status || first.holder !== again.holder || first.holder_lease_until !== again.holder_lease_until)) {
		return `its workload row changed (now ${again.status}, holder ${again.holder ?? "none"})`;
	}
	return null;
}

/** The newest disk entry this sweep wrote on the standing workload: open (`scratch-disk:`), cleared, or none yet. */
export function diskState(entries: readonly EntryRow[]): "open" | "clear" {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.created_by !== SCRATCH_SWEEP_BY) continue;
		if (e.body.startsWith(SCRATCH_ENTRY.diskOk)) return "clear";
		if (e.body.startsWith(SCRATCH_ENTRY.disk)) return "open";
	}
	return "clear";
}

const mib = (kib: number): string => (kib / 1024).toFixed(1);
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const localDate = (t: Date): string =>
	`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

export function reportDir(home: string): string {
	return join(home, "agent-scratch", "agent-system-2.0", "scratch-sweep");
}

/**
 * Test seams: `beforeRemove` runs after the scan of a root, before the removal's transaction; `inLock` inside it, after the
 * row was read again and right before the rename; `archive` is passed to each root's archiveDetached (its free-space
 * read, and points after tar and before the final check).
 */
export interface SweepHooks {
	beforeRemove?: (name: string) => void;
	inLock?: (name: string) => void;
	/** Replaces the statfs read of free bytes on the scratch volume. */
	freeBytes?: (path: string) => number | null;
	archive?: (name: string) => ArchiveSeams;
}

export interface SweepResult {
	exit: number;
	report: string;
	reportPath: string | null;
	roots: RootLine[];
	/** Each root archived before it was removed, by name. */
	archived: { name: string; archive: Archived }[];
	expired: ExpiryLine[];
	entry: string | null;
}

export function sweep(args: SweepArgs, env: Readonly<Record<string, string | undefined>>, thresholdMb: number, now: Date = args.now ?? new Date(), hooks: SweepHooks = {}): SweepResult {
	const nowIso = now.toISOString();
	const notes: string[] = [...args.configNotes];
	let failed = false;
	const ledgerPath = defaultLedgerPath({ ...env, HOME: args.home });
	const base = scratchBase(args.home);
	const roots: RootLine[] = [];
	const archived: { name: string; archive: Archived }[] = [];

	let baseReal: string | null = null;
	try {
		baseReal = realpathSync.native(base);
		if (!lstatSync(baseReal).isDirectory()) {
			notes.push(`the base ${base} is not a directory; nothing swept`);
			baseReal = null;
		}
	} catch {
		notes.push(`no base at ${base}; nothing to sweep`);
	}

	let ledger: Ledger | null = null;
	try {
		ledger = Ledger.open(ledgerPath, { readonly: true });
	} catch (e) {
		failed = true;
		notes.push(`the ledger ${ledgerPath} could not be read (${e instanceof Error ? e.message : String(e)}); nothing removed`);
	}

	let state: "open" | "clear" = "clear";
	/** The read-write handle whose write lock each removal's re-check and rename take, opened at the first removal. */
	let lock: Ledger | null = null;
	try {
		if (ledger && baseReal) {
			const parent = baseReal;
			for (const name of readdirSync(parent).sort()) {
				try {
					const r = sweepRoot(name);
					if (r) roots.push(r);
				} catch (e) {
					// One root's failure never stops the others.
					failed = true;
					roots.push({ name, sizeKib: null, action: "remove failed", why: `the sweep of this root failed (${e instanceof Error ? e.message : String(e)}); what is there is left as it is` });
				}
			}
		}
		function sweepRoot(name: string): RootLine | null {
			const parent = baseReal!;
			const ledgerRo = ledger!;
			const child = join(parent, name);
			let st: BigIntStats;
			try {
				st = lstatSync(child, { bigint: true });
			} catch (e) {
				return { name, sizeKib: null, action: "refused", why: `cannot be read (${e instanceof Error ? e.message : String(e)}); left alone` };
			}
			if (st.isSymbolicLink()) {
				let target = "?";
				try {
					target = readlinkSync(child);
				} catch {}
				return { name, sizeKib: null, action: "refused", why: `a symlink (→ ${target}); never followed, never removed` };
			}
			if (!st.isDirectory()) return { name, sizeKib: null, action: "refused", why: "not a directory; left alone" };
			const sizeKib = duKib(child);
			const idleSince = now.getTime() - IDLE_MS;
			const w = ledgerRo.workload(name);
			let why: string;
			if (name.startsWith(REMOVING_PREFIX)) {
				// A removal's rename target (surface/src/scratch-remove.ts): in progress now, or left by a remove that failed.
				// Its name says nothing about whether it was archived (it may predate archives), so it is archived like a root.
				const newest = newestChange(child, idleSince);
				if (newest > idleSince) return { name, sizeKib, action: "kept", why: `a removal leftover or in progress, changed within 3 days (${new Date(newest).toISOString()})` };
				why = `a removal leftover, nothing changed since ${new Date(newest).toISOString()} (over 3 days)`;
			} else if (!w) why = "no workload has this id";
			else if (w.status === "closed") why = `workload closed at ${w.closed_at ?? "?"}`;
			else if (heldLive(w, nowIso)) {
				return { name, sizeKib, action: "kept", why: `open, held by ${w.holder}${w.holder_lease_until ? ` (lease until ${w.holder_lease_until})` : ""}` };
			} else {
				const holder = w.holder ? `lease of ${w.holder} lapsed at ${w.holder_lease_until}` : "no holder";
				const newest = newestChange(child, idleSince);
				if (newest > idleSince) return { name, sizeKib, action: "kept", why: `open, ${holder}, changed within 3 days (${new Date(newest).toISOString()})` };
				why = `open, ${holder}, nothing changed since ${new Date(newest).toISOString()} (over 3 days)`;
			}
			if (args.dryRun) return { name, sizeKib, action: "would remove", why: `${why}; would be archived first` };
			hooks.beforeRemove?.(name);
			// The row read again and the root renamed aside (detachChild) in one BEGIN IMMEDIATE transaction that writes
			// nothing: a claim (Ledger.claimWorkload, reserveLane) is a write transaction too, so the two are serialized. A claim
			// committed first shows in the row read here and the root is kept; a claim that comes after finds the root renamed
			// away and its side re-creates it (the launcher's prepare, the lane extension after a won claim). The archive and the
			// recursive remove run on the detached tree after the lock is released.
			const identity = { dev: st.dev, ino: st.ino };
			let d: Detach | { kind: "kept"; change: string };
			try {
				lock ??= Ledger.open(ledgerPath, { backupOnOpen: false });
				const rw = lock;
				d = rw.write(() => {
					const change = rowChange(w, rw.workload(name), nowIso);
					if (change !== null) return { kind: "kept" as const, change };
					hooks.inLock?.(name);
					return detachChild(parent, name, identity);
				});
			} catch (e) {
				failed = true;
				return { name, sizeKib, action: "remove failed", why: `${why}; the ledger's write lock could not be taken (${e instanceof Error ? e.message : String(e)}); nothing archived or removed` };
			}
			if (d.kind === "kept") return { name, sizeKib, action: "kept", why: `was to go (${why}), but ${d.change} when read again before removal` };
			if (d.kind !== "detached") {
				failed = true;
				return { name, sizeKib, action: "remove failed", why: `${why}; ${d.kind === "refused" ? `refused at removal: ${d.reason}` : d.error}; nothing archived or removed` };
			}
			const a = archiveDetached(d.doomed, archivePathFor(args.home, name, now), hooks.archive?.(name) ?? {});
			if (a.kind === "failed") {
				failed = true;
				const back = restoreDetached(d);
				return { name, sizeKib, action: "archive failed", why: `${why}; not archived (${a.reason}); kept, ${back.said}` };
			}
			archived.push({ name, archive: a });
			const r = purgeDetached(d);
			if (r.kind === "removed") return { name, sizeKib, action: "removed", why: a.warnings.length ? `${why}; ${a.warnings.join("; ")}` : why };
			failed = true;
			return { name, sizeKib, action: "remove failed", why: `${why}; archived to ${a.path}, then ${r.kind === "refused" ? `refused at removal: ${r.reason}` : r.error}; what is left is at ${d.doomed}` };
		}
		if (ledger) state = diskState(ledger.workload(STANDING_WORKLOAD_ID) ? ledger.entries(STANDING_WORKLOAD_ID, "assumption") : []);
	} finally {
		ledger?.close();
		lock?.close();
	}

	// Archive expiry (step 3): only with a readable ledger, so each removal can be recorded.
	let expired: ExpiryLine[] = [];
	if (ledger) {
		const x = expireArchives(args.home, args.archive, now, args.dryRun);
		expired = x.lines;
		notes.push(...x.notes);
		if (expired.some((l) => l.action === "expire failed")) failed = true;
	} else notes.push("no archive expired: the ledger could not be read");

	// One entry per root archived and per archive expired, on the standing workload, in one transaction.
	const events = [
		...archived.map(({ name, archive }) => `${SCRATCH_ENTRY.archived} ${name} ${archive.path} ${archive.bytes} ${archive.sha256}`),
		...expired.filter((l) => l.action === "expired").map((l) => `${SCRATCH_ENTRY.archiveExpired} ${l.path} ${l.bytes ?? "?"}`),
	];
	// A dry run archives and expires nothing, so it has no events.
	let eventLine = "none";
	if (events.length > 0) {
		try {
			const rw = Ledger.open(ledgerPath, { backupOnOpen: false });
			try {
				const ids = rw.write(() => {
					ensureStandingWorkload(rw);
					return events.map((body) => rw.recordEntry({ by: SCRATCH_SWEEP_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body }));
				});
				eventLine = `wrote ${ids.join(", ")} on ${STANDING_WORKLOAD_ID}`;
			} finally {
				rw.close();
			}
		} catch (e) {
			failed = true;
			eventLine = `${events.length} entries could not be written (${e instanceof Error ? e.message : String(e)})`;
		}
	}

	// The remaining total: du of the base after the removals (a dry run subtracts what it would have removed).
	let totalKib: number | null = 0;
	if (baseReal) {
		totalKib = duKib(baseReal);
		if (totalKib !== null && args.dryRun) {
			for (const r of roots) if (r.action === "would remove") totalKib -= r.sizeKib ?? 0;
		}
	}

	const legacy: LegacyLine[] = [];
	try {
		for (const name of readdirSync(args.legacyTmp).sort()) {
			if (LEGACY_TMP_PREFIXES.some((p) => name.startsWith(p))) legacy.push({ path: join(args.legacyTmp, name), sizeKib: duKib(join(args.legacyTmp, name)) });
		}
	} catch (e) {
		notes.push(`${args.legacyTmp} could not be listed: ${e instanceof Error ? e.message : String(e)}`);
	}
	const testRuns = join(args.home, ".agent-system-2", "test-runs");
	try {
		lstatSync(testRuns);
		legacy.push({ path: testRuns, sizeKib: duKib(testRuns) });
	} catch {
		legacy.push({ path: testRuns, sizeKib: 0 });
	}

	const reportPath = join(reportDir(args.home), `${localDate(now)}.md`);
	const thresholdKib = thresholdMb * 1024;
	const totalOver = totalKib !== null && totalKib > thresholdKib;
	// The disk guard: free space on the scratch volume (statfs of the base, else HOME) under scratchArchive.minFreeGib.
	const freeAt = baseReal ?? args.home;
	const free = (hooks.freeBytes ?? freeBytes)(freeAt);
	const low = free !== null && free < args.archive.minFreeGib * GIB;
	const over = totalOver || low;
	let entry: string | null = null;
	let entryLine: string;
	if (totalKib === null && !low) entryLine = "the remaining total could not be measured; no entry written";
	else if (!ledger) entryLine = "the ledger could not be read; no entry written";
	else if (over === (state === "open")) entryLine = over ? "already open (one `scratch-disk:` entry while open); nothing written" : "nothing to write";
	else {
		const why: string[] = [];
		if (totalOver) why.push(`${mib(totalKib ?? 0)} MiB under ${baseReal ?? base} passes ${thresholdMb} MiB (${SCRATCH_TOTAL_ENV})`);
		if (low) why.push(`${gib(free ?? 0)} GiB free on the volume of ${freeAt}, under ${args.archive.minFreeGib} GiB (${SCRATCH_ARCHIVE_KEY}.minFreeGib)`);
		const body = over
			? `${SCRATCH_ENTRY.disk} ${why.join("; ")}; report ${reportPath}`
			: `${SCRATCH_ENTRY.diskOk} ${mib(totalKib ?? 0)} MiB under ${baseReal ?? base}, at or under ${thresholdMb} MiB; report ${reportPath}`;
		if (args.dryRun) entryLine = `would write on ${STANDING_WORKLOAD_ID}: ${body}`;
		else {
			try {
				const rw = Ledger.open(ledgerPath, { backupOnOpen: false });
				try {
					entry = rw.write(() => {
						ensureStandingWorkload(rw);
						// Re-read under the write lock: a second sweep running at the same time writes nothing twice.
						if ((diskState(rw.entries(STANDING_WORKLOAD_ID, "assumption")) === "open") === over) return null;
						return rw.recordEntry({ by: SCRATCH_SWEEP_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
					});
				} finally {
					rw.close();
				}
				entryLine = entry ? `wrote ${entry} on ${STANDING_WORKLOAD_ID}: ${body}` : "another sweep wrote the same state first; nothing written";
			} catch (e) {
				failed = true;
				entryLine = `the entry could not be written (${e instanceof Error ? e.message : String(e)}): ${body}`;
			}
		}
	}

	const out: string[] = [
		`# scratch sweep ${localDate(now)}${args.dryRun ? " (dry run: nothing removed or written)" : ""}`,
		"",
		`- run: ${nowIso}`,
		`- base: ${baseReal ?? base}`,
		`- ledger: ${ledgerPath}`,
		`- threshold: ${thresholdMb} MiB (${SCRATCH_TOTAL_ENV})`,
		`- archives: ${scratchArchiveBase(args.home)}; expire after ${args.archive.expireDays} days${args.archive.requireOffsite ? ", only with an offsite marker" : ""}; disk guard under ${args.archive.minFreeGib} GiB free`,
		...notes.map((n) => `- note: ${n}`),
		"",
		"## roots",
		"",
	];
	if (roots.length === 0) out.push("none");
	else {
		out.push("| root | size (KiB) | action | why |", "|---|---|---|---|");
		for (const r of roots) out.push(`| ${cell(r.name)} | ${r.sizeKib ?? "-"} | ${r.action} | ${cell(r.why)} |`);
	}
	out.push("", "## archives", "");
	if (archived.length === 0 && expired.length === 0) out.push("none");
	else {
		out.push("| archive | bytes | action | why |", "|---|---|---|---|");
		for (const { name, archive } of archived) out.push(`| ${cell(archive.path)} | ${archive.bytes} | written | root ${cell(name)} removed; ${archive.entries} members, sha256 ${archive.sha256} |`);
		for (const l of expired) out.push(`| ${cell(l.path)} | ${l.bytes ?? "-"} | ${l.action} | ${cell(l.why)} |`);
	}
	out.push(
		"",
		`- ledger: ${eventLine}`,
		"",
		"## remaining",
		"",
		`- total under the base: ${totalKib === null ? "unknown" : `${totalKib} KiB (${mib(totalKib)} MiB), ${totalOver ? "over" : "at or under"} ${thresholdMb} MiB`}`,
		`- free on the scratch volume: ${free === null ? "unknown" : `${gib(free)} GiB, ${low ? "under" : "at or over"} ${args.archive.minFreeGib} GiB`}`,
		`- ledger: ${entryLine}`,
		"",
		"## legacy places (sized, never deleted)",
		"",
		"| path | size (KiB) |",
		"|---|---|",
		...legacy.map((l) => `| ${cell(l.path)} | ${l.sizeKib ?? "unknown"} |`),
		"",
	);
	const report = out.join("\n");

	let written: string | null = null;
	if (!args.dryRun) {
		try {
			mkdirSync(reportDir(args.home), { recursive: true });
			writeFileSync(reportPath, report);
			written = reportPath;
		} catch (e) {
			failed = true;
			process.stderr.write(`scratch-sweep: the report ${reportPath} could not be written: ${e instanceof Error ? e.message : String(e)}\n`);
		}
	}
	return { exit: failed ? 1 : 0, report, reportPath: written, roots, archived, expired, entry };
}

function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const args = parseArgs(argv);
	if (typeof args === "string") {
		process.stderr.write(`scratch-sweep: ${args}\n${USAGE}\n`);
		return 2;
	}
	const threshold = totalThresholdMb(process.env);
	if (typeof threshold === "string") {
		process.stderr.write(`scratch-sweep: ${threshold}\n`);
		return 2;
	}
	const home = resolve(args.home);
	const config = readScratchArchiveConfig(process.env, home);
	const r = sweep({ ...args, home, archive: config.config, configNotes: config.notes }, process.env, threshold, args.now ?? new Date());
	process.stdout.write(r.report);
	if (r.reportPath) process.stdout.write(`report: ${r.reportPath}\n`);
	return r.exit;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
