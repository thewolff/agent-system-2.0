// Closed lane folders go offsite through the nightly Drive backup (PLAN wl-mw14khl4uf388q, "Archive and records",
// "Producer", "Offsite lock", "Retire"): `produce` tars a closed, quiet lane folder into the archive root the nightly
// claims, uploads and proves; `retire` removes a folder whose exact tar is proven on Drive.
//
// CLI (the nightly, install/drive-backup/backup-nightly.zsh, runs both under `bounded` with $AS2_BUN):
//   bun surface/scripts/lane-archive.ts produce --ledger <db> --archive-root <dir> --drivefs-db <metadata_sqlite_db> [--dry-run]
//   bun surface/scripts/lane-archive.ts retire --keep-local 0|1 --receipts <dir> --claims <dir> [--dry-run]
// Environment: HOME (the lanes root is $HOME/.agent-system-2/lanes); AS2_LANE_ARCHIVE_STATE (the records' dir, default
// $HOME/agent-scratch/agent-system-2.0/drive-backup/state/lane-archives, lane-offsite.ts laneArchiveStateDir, the one
// restore reads); AS2_LANE_BUDGET (produce: seconds of tarring per run, default 3600); AS2_LANE_ONLY (one workload id:
// both commands consider that lane alone); AS2_LANE_ARCHIVE_KILL_AT (test seam: `<point>[@<n>]`, KILL_POINTS).
// Stdout: one line per event, three TAB-separated fields, `ok|skip|fail<TAB><wl or -><TAB><text>` (no TAB or newline in
// the text), then one last `counts<TAB>produce|retire<TAB><key>=<n> …` line: produce `tarred recovered skipped failed
// eligible`, retire `retired held requeued finished failed`. Exit 0 when the run completed, whatever its lines say; 1 when
// the command broke (the ledger or the state dir unreadable, a bug): one `fail<TAB>-<TAB>…` line and no counts line; 2 on
// a usage error (stderr only).
//
// Records: `<state>/<wl>.json` (temp + fsync + rename), `state` publishing | pending, with the workload, the final
// archive path, its bytes and sha256 and the content manifest read from the tar's extracted verification copy. Moved
// to `done/` once the lane is offsite, `superseded/` when the folder changed since its tar, `lost/` when the tar was lost
// before upload; restore moves one to `restored/`. Only `<state>/<wl>.json` counts as a live record.
//
// produce (reads the live folder only; never renames, chmods or writes inside it):
//   1. each `publishing` record: its final archive present with the recorded sha256 -> `pending`; else the record and
//      the partial and copy it names are dropped (a final with another sha256 is left for a person, with a fail line).
//      Lane partials (`<wl>.lane[.<n>].tar.gz.partial-<12 hex>`) and copies (`.verify-lane-<wl>-<12 hex>`) under the
//      archive root that no record names are removed.
//   2. candidates: `wl-*` folders whose workload is closed (ledger, read-only) with closed_at more than 24 h ago, with no
//      lane marker, no live record and nothing changed for 1 h (scratch-remove.ts newestChange); smallest first.
//   3. the Drive quota from Drive for desktop's `properties.driveway_account` (readDriveQuota): unreadable, another
//      account, a layout that does not decode, or remaining under 2 x tonight's candidates' raw bytes + 1 GiB: one fail
//      line and no lane tarred tonight.
//   4. per lane until the budget: free disk re-read; lane bytes > free / 2: a fail line naming the lane, its size and
//      the free space, and the run carries on. Else the folder's content manifest; `tar -czf <final>.partial-<12 hex>`;
//      extracted into a private `.verify-lane-*` copy whose manifest must equal the folder's; the folder's manifest read
//      again, equal again; record `publishing`; chmod 600; link the partial to the final name (a link never replaces a
//      name); unlink the partial; record `pending`; remove the copy. Any difference or failure removes the partial, the
//      final, the copy and the record, with a fail line; a later night tries again. The final name is
//      `<archive root>/<UTC date>/<wl>.lane.tar.gz`, or `<wl>.lane.<n>.tar.gz` when that name or one of its sidecars
//      (`.offsite`, `.attempts`, `.stuck`) or partials exists in any date directory of the root.
//
// retire (one process, under the offsite lock, lane-offsite.ts acquireOffsiteLock; busy -> one fail line):
//   - every attempt dir `<state>/tmp/<wl>-<12 hex>/` an earlier run left is removed (copies only); a failure is a line.
//   - each lane marker, next-run rows (never resuming another process's freeze or purge): `stranded` set or any
//     `.removing-<wl>-*` -> keep everything, `stranded` lists every leftover, a fail line every night naming them and
//     `as2 lane restore <wl>`; `retiring` with the folder absent -> finish step 5; `retiring` with the folder in place,
//     equal to the manifest with its modes -> the marker removed (killed before the detach); `retiring` otherwise ->
//     kept and reported; `offsite` with the folder absent -> a pending record carrying its tar_sha256 moves to done/;
//     `offsite` with a folder recreated -> never overwritten, a fail line. None of these deletes lane data, at K0 or K1.
//   - each pending record without a marker, smallest first: offsite proof from `<receipts>/<day>/<name>/receipt` whose
//     sha256 (single, or the envelope member's) is the record's, else `<archive>.offsite` naming it; no archive, claim
//     dir, receipt or `.offsite` at all -> the tar was lost before upload: the record moves to lost/ and the producer
//     tars the folder again; otherwise it waits. With proof and --keep-local 1 nothing more. With --keep-local 0, while
//     lane bytes <= free / 2: (1) marker `retiring` with the proof keys, tar_sha256 and the content manifest;
//     (2) scratch-remove.ts detachChild, then this attempt's snapshot readManifest(detached, false); (3) scratch-archive.ts
//     archiveDetached into the attempt dir, unchanged; a failure -> the tree's path set, types and modes against the
//     snapshot: equal -> F3, else F4. Success: its members' content must equal the record's (the proven tar's), else
//     thawTree back to the original modes and F3 with the record moved to superseded/ (a thaw failure -> F4);
//     (4) purgeArchived, unchanged: anything kept -> F4; (5) the attempt dir removed, marker `offsite` with
//     lane_deleted_at and the restore command, the record to done/.
//     F3: restoreDetached; published at lanes/<wl> -> the marker removed; not published -> F4. F4: the tree kept where it
//     is, never republished, the marker stays `retiring` with `stranded`, the record stays. Each with a fail line naming
//     the step, what differed or was kept, where the tree is, and `as2 lane restore <wl>`.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../../ledger/src/index";
import {
	acquireOffsiteLock, type ContentEntry, compareContent, contentManifest, hasMarker, laneArchiveStateDir, lanesRoot, markerPath, type OffsiteMarker, readMarker,
	restoreCommand, type StepRunner, stepRunner, writeMarker,
} from "../src/lane-offsite";
import {
	ARCHIVE_DEADLINE_MS, type ArchiveSeams, archiveDetached, freeBytes as statfsFreeBytes, GIB, type Manifest, OFFSITE_SIDECARS, OFFSITE_SUFFIX, type ProgressCheck,
	purgeArchived, readManifest, removeCopy, thawTree, utcDate,
} from "../src/scratch-archive";
import { type Detached, detachChild, fileIdentity, newestChange, REMOVING_PREFIX, restoreDetached } from "../src/scratch-remove";

/** Seconds of tarring one produce run may start lanes in (the nightly's `bounded` cap is this plus its T_LONG). */
export const BUDGET_ENV = "AS2_LANE_BUDGET";
export const DEFAULT_BUDGET_S = 3600;
/** Both commands consider this one workload's lane alone (the real round trip's seam). */
export const ONLY_ENV = "AS2_LANE_ONLY";
/** Test seam: `<point>[@<n>]` makes the run SIGKILL itself right after the n-th (default first) time it passes <point>. */
export const KILL_ENV = "AS2_LANE_ARCHIVE_KILL_AT";
export const KILL_POINTS = ["publishing", "linked", "marker-retiring", "detached", "archive-tar", "archive-frozen", "purged", "marker-offsite"] as const;
export type KillPoint = (typeof KILL_POINTS)[number];
/** A lane is a candidate once its workload was closed this long ago… */
export const CLOSED_FOR_MS = 24 * 60 * 60 * 1000;
/** …and nothing in its folder changed for this long. */
export const QUIET_MS = 60 * 60 * 1000;
/** The Drive account record's property in Drive for desktop's metadata_sqlite_db. */
export const DRIVEWAY_PROPERTY = "driveway_account";

const WL_RE = /^wl-[0-9a-z]+$/;
const RECORD_RE = /^(wl-[0-9a-z]+)\.json$/;
const MARKER_RE = /^(wl-[0-9a-z]+)\.offsite$/;
const LANE_PARTIAL_RE = /^wl-[0-9a-z]+\.lane(?:\.\d+)?\.tar\.gz\.partial-[0-9a-f]{12}$/;
const LANE_VERIFY_RE = /^\.verify-lane-wl-[0-9a-z]+-[0-9a-f]{12}$/;
const ATTEMPT_RE = /^(wl-[0-9a-z]+)-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const hex12 = (): string => randomBytes(6).toString("hex");

// ---- output -----------------------------------------------------------------------------------------

export type LineKind = "ok" | "skip" | "fail";
/** One stdout event: `<kind>\t<subject>\t<text>`. */
export interface Line {
	kind: LineKind;
	/** The workload id, or `-` for the run as a whole. */
	subject: string;
	text: string;
}
/** A line as the nightly reads it: three TAB-separated fields, no TAB or newline inside the text. */
export const formatLine = (l: Line): string => `${l.kind}\t${l.subject}\t${l.text.replace(/[\t\r\n]+/g, " ")}`;

// ---- small file helpers -----------------------------------------------------------------------------

/** Whether something (a link included, never followed) is at `path`; any error but ENOENT is thrown. */
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}

function fsyncDir(dir: string): void {
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write JSON at `path`: a sibling temp file, fsync, rename over `path`, fsync the directory. */
function writeJson(path: string, value: unknown): void {
	const tmp = `${path}.tmp-${hex12()}`;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(value, null, "\t")}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (e) {
		let also = "";
		try {
			if (present(tmp)) unlinkSync(tmp);
		} catch (e2) {
			also = `; its temp file ${tmp} is left (${message(e2)})`;
		}
		throw new Error(`${path} could not be written (${message(e)})${also}`);
	}
	fsyncDir(dirname(path));
}

/** Unlink `path` and fsync its directory, so the removal is durable. */
function unlinkDurable(path: string): void {
	unlinkSync(path);
	fsyncDir(dirname(path));
}

/** SHA-256 of a file in 1 MiB chunks, `check` after each. */
function sha256File(path: string, check: ProgressCheck = () => {}): string {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n === 0) break;
			hash.update(buf.subarray(0, n));
			check(`hashing ${path}`);
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** `key=value` lines (the nightly's receipts and `.offsite` markers): the first value of each key; null when absent. */
function readKv(path: string): Record<string, string> | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`${path} cannot be read (${message(e)})`);
	}
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const i = line.indexOf("=");
		if (i <= 0) continue;
		const k = line.slice(0, i).trim();
		if (!(k in out)) out[k] = line.slice(i + 1).trim();
	}
	return out;
}

/** `20261103T201500Z`. */
const stampOf = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** A progress check failing once `ms` has passed on `clock` since it was made. */
function deadlineCheck(clock: () => number, ms: number, what: string): ProgressCheck {
	const end = clock() + ms;
	return (step) => {
		if (clock() > end) throw new Error(`${what} passed its ${Number((ms / 1000).toFixed(3))} s deadline at ${step}`);
	};
}

/** Raw bytes of the regular files under `dir` (readManifest without hashes; throws on what it cannot read). */
function rawBytes(dir: string): number {
	let n = 0;
	for (const e of readManifest(dir, false).values()) n += e.size;
	return n;
}

const contentBytes = (content: readonly ContentEntry[]): number => content.reduce((n, e) => n + e.size, 0);

/** A manifest reduced to its content fields, sorted by path (lane-offsite.ts contentManifest's shape). */
function contentOf(m: Manifest): ContentEntry[] {
	const out: ContentEntry[] = [];
	for (const [path, e] of m) out.push({ path, type: e.type, size: e.size, mode: e.mode, sha256: e.sha256, target: e.target });
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---- the kill hook ----------------------------------------------------------------------------------

/** The kill hook a `<point>[@<n>]` value names (KILL_ENV), or a no-op when unset; a bad value throws. */
export function killHook(value: string | undefined): (point: KillPoint) => void {
	if (value === undefined || value === "") return () => {};
	const m = /^([a-z-]+)(?:@([1-9]\d*))?$/.exec(value);
	if (!m || !(KILL_POINTS as readonly string[]).includes(m[1]!)) throw new Error(`${KILL_ENV}=${value} is not <point>[@<n>] with a point among ${KILL_POINTS.join(", ")}`);
	const want = Number(m[2] ?? "1");
	let seen = 0;
	return (point) => {
		if (point !== m[1]) return;
		seen += 1;
		if (seen === want) process.kill(process.pid, "SIGKILL");
	};
}

// ---- the Drive quota --------------------------------------------------------------------------------

/** Drive for desktop's record of the account's storage quota, in bytes. */
export interface DriveQuota {
	account: string;
	total: number;
	used: number;
	remaining: number;
}

/** The quota could not be read or did not decode as pinned; no lane is tarred that night. */
export class QuotaError extends Error {}

interface PbField {
	num: number;
	wire: number;
	varint?: bigint;
	bytes?: Uint8Array;
}

/** The fields of one protobuf message; malformed input (a varint or length past the end, a group, field 0) throws. */
function pbFields(buf: Uint8Array, where: string): PbField[] {
	const out: PbField[] = [];
	let i = 0;
	const varint = (): bigint => {
		let r = 0n;
		let shift = 0n;
		for (let n = 0; n < 10; n++) {
			if (i >= buf.length) throw new QuotaError(`${where}: a varint runs past the end of the message (byte ${i} of ${buf.length})`);
			const c = buf[i++]!;
			r |= BigInt(c & 0x7f) << shift;
			shift += 7n;
			if (c < 0x80) return r;
		}
		throw new QuotaError(`${where}: a varint longer than 10 bytes ends at byte ${i}`);
	};
	while (i < buf.length) {
		const at = i;
		const key = varint();
		const num = Number(key >> 3n);
		const wire = Number(key & 7n);
		if (num === 0) throw new QuotaError(`${where}: field number 0 at byte ${at}`);
		if (wire === 0) out.push({ num, wire, varint: varint() });
		else if (wire === 2) {
			const len = varint();
			if (len > BigInt(buf.length - i)) throw new QuotaError(`${where}: field ${num} at byte ${at} says ${len} bytes, only ${buf.length - i} remain`);
			out.push({ num, wire, bytes: buf.subarray(i, i + Number(len)) });
			i += Number(len);
		} else if (wire === 1 || wire === 5) {
			const w = wire === 1 ? 8 : 4;
			if (i + w > buf.length) throw new QuotaError(`${where}: fixed field ${num} at byte ${at} runs past the end`);
			out.push({ num, wire });
			i += w;
		} else throw new QuotaError(`${where}: field ${num} at byte ${at} has wire type ${wire} (a group or an unknown type)`);
	}
	return out;
}

/** The one field `num` of wire type `wire`: missing, repeated or another type throws. */
function only(fields: PbField[], num: number, wire: number, where: string): PbField {
	const f = fields.filter((x) => x.num === num);
	if (f.length === 0) throw new QuotaError(`${where}: field ${num} is missing`);
	if (f.length > 1) throw new QuotaError(`${where}: field ${num} appears ${f.length} times`);
	if (f[0]!.wire !== wire) throw new QuotaError(`${where}: field ${num} has wire type ${f[0]!.wire}, not ${wire}`);
	return f[0]!;
}

/**
 * Decode `properties.driveway_account` (measured 2026-11-03, PLAN "Facts"): message 2/1 field 11 is the account id, which
 * must be `account`; message 2/3/1 holds field 1 = total, field 3 = used, field 8 = remaining bytes, and 1 - 3 must equal 8.
 * Each pinned field must appear exactly once with its wire type. Anything else throws QuotaError naming what differed.
 */
export function decodeDrivewayAccount(value: Uint8Array, account: string): DriveQuota {
	const top = pbFields(value, DRIVEWAY_PROPERTY);
	const m2 = pbFields(only(top, 2, 2, DRIVEWAY_PROPERTY).bytes!, `${DRIVEWAY_PROPERTY} 2`);
	const who = pbFields(only(m2, 1, 2, `${DRIVEWAY_PROPERTY} 2`).bytes!, `${DRIVEWAY_PROPERTY} 2/1`);
	let id: string;
	try {
		id = new TextDecoder("utf-8", { fatal: true }).decode(only(who, 11, 2, `${DRIVEWAY_PROPERTY} 2/1`).bytes!);
	} catch (e) {
		if (e instanceof QuotaError) throw e;
		throw new QuotaError(`${DRIVEWAY_PROPERTY} 2/1 field 11 (the account id) is not UTF-8 (${message(e)})`);
	}
	if (id !== account) throw new QuotaError(`${DRIVEWAY_PROPERTY} 2/1 field 11 names the account ${JSON.stringify(id)}, not ${account} (its DriveFS account directory)`);
	const m3 = pbFields(only(m2, 3, 2, `${DRIVEWAY_PROPERTY} 2`).bytes!, `${DRIVEWAY_PROPERTY} 2/3`);
	const q = pbFields(only(m3, 1, 2, `${DRIVEWAY_PROPERTY} 2/3`).bytes!, `${DRIVEWAY_PROPERTY} 2/3/1`);
	const n = (num: number, name: string): number => {
		const v = only(q, num, 0, `${DRIVEWAY_PROPERTY} 2/3/1`).varint!;
		if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new QuotaError(`${DRIVEWAY_PROPERTY} 2/3/1 field ${num} (${name}) is ${v}, past 2^53`);
		return Number(v);
	};
	const total = n(1, "total");
	const used = n(3, "used");
	const remaining = n(8, "remaining");
	if (total - used !== remaining) {
		throw new QuotaError(`${DRIVEWAY_PROPERTY} 2/3/1: field 1 (total ${total}) - field 3 (used ${used}) = ${total - used}, not field 8 (remaining ${remaining}); the layout may have changed`);
	}
	return { account: id, total, used, remaining };
}

/**
 * The quota from Drive for desktop's `<DriveFS>/<account id>/metadata_sqlite_db`, opened read-only: the one
 * `driveway_account` row of `properties`, decoded for the account its directory names. Throws QuotaError naming the file.
 */
export function readDriveQuota(dbPath: string): DriveQuota {
	const account = basename(dirname(dbPath));
	if (!/^\d+$/.test(account)) throw new QuotaError(`${dbPath} is not in a DriveFS account directory (<digits>/metadata_sqlite_db), so its account cannot be pinned`);
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch (e) {
		throw new QuotaError(`${dbPath} cannot be opened read-only (${message(e)})`);
	}
	try {
		const rows = db.query<{ value: unknown }, [string]>("SELECT value FROM properties WHERE property = ?").all(DRIVEWAY_PROPERTY);
		if (rows.length !== 1) throw new QuotaError(`properties holds ${rows.length} ${DRIVEWAY_PROPERTY} rows, not 1`);
		const v = rows[0]!.value;
		if (!(v instanceof Uint8Array)) throw new QuotaError(`properties.${DRIVEWAY_PROPERTY} is a ${typeof v}, not a blob`);
		return decodeDrivewayAccount(v, account);
	} catch (e) {
		throw new QuotaError(`${dbPath}: ${message(e)}`);
	} finally {
		db.close();
	}
}

// ---- records ----------------------------------------------------------------------------------------

export type RecordState = "publishing" | "pending";

/** `<state>/<wl>.json`: one tar of one lane folder. */
export interface LaneArchiveRecord {
	state: RecordState;
	workload: string;
	/** The final archive path (`<archive root>/<date>/<wl>.lane[.<n>].tar.gz`). */
	archive: string;
	bytes: number;
	sha256: string;
	/** The content manifest of the tar's extracted copy. */
	content: ContentEntry[];
	/** While publishing: the partial and the verification copy the producer is working on. */
	partial?: string;
	verify?: string;
}

export const recordPath = (stateDir: string, wl: string): string => join(stateDir, `${wl}.json`);

/** Parse and check a record; throws naming `where` and what is wrong. */
export function parseRecord(text: string, where: string): LaneArchiveRecord {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		throw new Error(`${where} is not JSON (${message(e)})`);
	}
	const bad = (what: string): Error => new Error(`${where}: ${what}`);
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad("not a JSON object");
	const o = v as Record<string, unknown>;
	if (o.state !== "publishing" && o.state !== "pending") throw bad(`state is ${JSON.stringify(o.state)}, not publishing or pending`);
	if (typeof o.workload !== "string" || !WL_RE.test(o.workload)) throw bad("workload is not a workload id");
	if (typeof o.archive !== "string" || o.archive === "") throw bad("archive is not a path");
	if (typeof o.bytes !== "number" || !(o.bytes >= 0)) throw bad("bytes is not a non-negative number");
	if (typeof o.sha256 !== "string" || !SHA_RE.test(o.sha256)) throw bad("sha256 is not 64 lowercase hex digits");
	if (!Array.isArray(o.content) || o.content.length === 0) throw bad("content is not a non-empty array");
	const content = o.content.map((c, i): ContentEntry => {
		const e = c as Record<string, unknown>;
		const ok = typeof e === "object" && e !== null && typeof e.path === "string" && (e.type === "file" || e.type === "dir" || e.type === "link")
			&& typeof e.size === "number" && typeof e.mode === "number" && (e.sha256 === null || typeof e.sha256 === "string") && (e.target === null || typeof e.target === "string");
		if (!ok) throw bad(`content[${i}] is not {path, type, size, mode, sha256, target}`);
		return { path: e.path as string, type: e.type as ContentEntry["type"], size: e.size as number, mode: e.mode as number, sha256: e.sha256 as string | null, target: e.target as string | null };
	});
	const rec: LaneArchiveRecord = { state: o.state, workload: o.workload, archive: o.archive, bytes: o.bytes, sha256: o.sha256, content };
	for (const k of ["partial", "verify"] as const) {
		if (o[k] === undefined) continue;
		if (typeof o[k] !== "string" || o[k] === "") throw bad(`${k} is not a path`);
		rec[k] = o[k] as string;
	}
	return rec;
}

export function readRecord(path: string): LaneArchiveRecord {
	return parseRecord(readFileSync(path, "utf8"), path);
}

/** Move the record at `path` into `<stateDir>/<sub>/` under `<wl>.json`, or `<wl>.<stamp>[-<n>].json` when taken; its new path. */
function moveRecord(stateDir: string, path: string, sub: "done" | "superseded" | "lost", wl: string, now: number): string {
	const dir = join(stateDir, sub);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let dest = join(dir, `${wl}.json`);
	for (let n = 1; present(dest); n++) dest = join(dir, `${wl}.${stampOf(now)}${n === 1 ? "" : `-${n}`}.json`);
	renameSync(path, dest);
	fsyncDir(dir);
	fsyncDir(dirname(path));
	return dest;
}

/** Every live record (`<state>/wl-*.json`), parsed; one that cannot be read is a fail line. */
function liveRecords(stateDir: string, emit: (l: Line) => void, counts: { failed: number }): { path: string; rec: LaneArchiveRecord }[] {
	if (!present(stateDir)) return [];
	const out: { path: string; rec: LaneArchiveRecord }[] = [];
	for (const name of readdirSync(stateDir).sort()) {
		const m = RECORD_RE.exec(name);
		if (!m) continue;
		const path = join(stateDir, name);
		try {
			const rec = readRecord(path);
			if (rec.workload !== m[1]) throw new Error(`${path} names the workload ${rec.workload}, not ${m[1]}`);
			out.push({ path, rec });
		} catch (e) {
			counts.failed += 1;
			emit({ kind: "fail", subject: m[1]!, text: `the lane-archive record cannot be used: ${message(e)}; left as it is for a person` });
		}
	}
	return out;
}

// ---- the archive name -------------------------------------------------------------------------------

/** Every name in every directory directly under `root`. */
function namesUnder(root: string): Set<string> {
	const names = new Set<string>();
	if (!present(root)) return names;
	for (const d of readdirSync(root)) {
		const p = join(root, d);
		if (!lstatSync(p).isDirectory()) continue;
		for (const n of readdirSync(p)) names.add(n);
	}
	return names;
}

/**
 * `<root>/<UTC date of now>/<wl>.lane.tar.gz`, or `<wl>.lane.<n>.tar.gz` (n = 2, 3, …): the first name that neither an
 * archive, an offsite sidecar (`.offsite`, `.attempts`, `.stuck`) nor a partial holds in any date directory of the root.
 */
export function laneArchivePath(root: string, now: number, wl: string): string {
	const names = namesUnder(root);
	const all = [...names];
	for (let n = 1; ; n++) {
		const name = n === 1 ? `${wl}.lane.tar.gz` : `${wl}.lane.${n}.tar.gz`;
		const held = [name, ...[OFFSITE_SUFFIX, ...OFFSITE_SIDECARS].map((s) => `${name}${s}`)].some((x) => names.has(x)) || all.some((x) => x.startsWith(`${name}.partial-`));
		if (!held) return join(root, utcDate(new Date(now)), name);
	}
}

// ---- produce ----------------------------------------------------------------------------------------

/** What the producer reads of a workload: its status and close time (ledger `workload_status`). */
export interface WorkloadInfo {
	status: string;
	closed_at: string | null;
}

export interface ProduceOptions {
	home: string;
	/** The records' directory (lane-offsite.ts laneArchiveStateDir). */
	stateDir: string;
	/** The nightly's archive root. */
	archiveRoot: string;
	/** The ledger's row for a workload id (null when there is none). */
	workload: (wl: string) => WorkloadInfo | null;
	/** Tonight's Drive quota (readDriveQuota); throws when it cannot be read. */
	quota: () => DriveQuota;
	emit: (l: Line) => void;
	clock?: () => number;
	freeBytes?: (path: string) => number | null;
	/** Lanes are started only while this much time has passed since the run began (default DEFAULT_BUDGET_S). */
	budgetMs?: number;
	/** Consider this workload's lane alone. */
	only?: string | null;
	/** The tar steps' runner (default lane-offsite.ts stepRunner). */
	run?: StepRunner;
	/** Each tar step's and each hashing pass's deadline (default ARCHIVE_DEADLINE_MS). */
	stepDeadlineMs?: number;
	kill?: (point: KillPoint) => void;
	dryRun?: boolean;
}

export interface ProduceCounts {
	tarred: number;
	recovered: number;
	skipped: number;
	failed: number;
	eligible: number;
}

interface Candidate {
	wl: string;
	folder: string;
	bytes: number;
}

/** Remove a verification copy or attempt dir (scratch-archive.ts removeCopy); what was left, or null. */
function dropTree(dir: string): string | null {
	if (!present(dir)) return null;
	return removeCopy(dir);
}

/** Start step 1: settle each publishing record, then remove stale lane partials and copies no record names. */
function settlePublishing(o: ProduceOptions, counts: ProduceCounts): void {
	const named = new Set<string>();
	for (const { path, rec } of liveRecords(o.stateDir, o.emit, counts)) {
		if (rec.state !== "publishing") continue;
		const wl = rec.workload;
		let finalSha: string | null = null;
		try {
			if (present(rec.archive)) finalSha = sha256File(rec.archive);
		} catch (e) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: wl, text: `the publishing record ${path} names ${rec.archive}, which cannot be read (${message(e)}); left for a person` });
			for (const p of [rec.partial, rec.verify]) if (p) named.add(p);
			continue;
		}
		const problems: string[] = [];
		if (finalSha === rec.sha256) {
			try {
				if (rec.partial && present(rec.partial)) unlinkSync(rec.partial);
			} catch (e) {
				problems.push(`its partial ${rec.partial} could not be removed (${message(e)})`);
			}
			const { partial: _p, verify, ...rest } = rec;
			writeJson(path, { ...rest, state: "pending" });
			if (verify) {
				const left = dropTree(verify);
				if (left) problems.push(left);
			}
			counts.recovered += 1;
			o.emit({ kind: "ok", subject: wl, text: `an earlier run stopped after linking ${rec.archive}; its sha256 ${rec.sha256} matches, so the record ${path} is now pending` });
		} else {
			for (const p of [rec.partial, rec.verify]) {
				if (!p) continue;
				const left = p === rec.verify ? dropTree(p) : (() => {
					try {
						if (present(p)) unlinkSync(p);
						return null;
					} catch (e) {
						return `the partial ${p} could not be removed (${message(e)})`;
					}
				})();
				if (left) problems.push(left);
			}
			unlinkDurable(path);
			if (finalSha !== null) {
				counts.failed += 1;
				o.emit({ kind: "fail", subject: wl, text: `the publishing record ${path} said sha256 ${rec.sha256}, but ${rec.archive} has ${finalSha}; the record was dropped and that archive left for a person; the folder is tarred again under a new name` });
			} else {
				o.emit({ kind: "skip", subject: wl, text: `an earlier run stopped before publishing ${rec.archive}; its record ${path} and its partial were dropped, and the folder is tarred again` });
			}
		}
		if (problems.length > 0) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: wl, text: problems.join("; ") });
		}
	}
	if (!present(o.archiveRoot)) return;
	for (const d of readdirSync(o.archiveRoot).sort()) {
		const day = join(o.archiveRoot, d);
		if (!lstatSync(day).isDirectory()) continue;
		for (const name of readdirSync(day).sort()) {
			const p = join(day, name);
			const kind = LANE_PARTIAL_RE.test(name) ? "partial" : LANE_VERIFY_RE.test(name) ? "copy" : null;
			if (kind === null || named.has(p)) continue;
			const wl = /^\.?(?:verify-lane-)?(wl-[0-9a-z]+)/.exec(name)?.[1] ?? "-";
			let left: string | null;
			try {
				if (kind === "copy") left = dropTree(p);
				else {
					unlinkSync(p);
					left = null;
				}
			} catch (e) {
				left = `${p} could not be removed (${message(e)})`;
			}
			if (left) {
				counts.failed += 1;
				o.emit({ kind: "fail", subject: wl, text: `a stale lane ${kind} an interrupted run left: ${left}` });
			} else o.emit({ kind: "ok", subject: wl, text: `removed the stale lane ${kind} ${p} an interrupted run left` });
		}
	}
}

/** Start step 2: the eligible folders, smallest first. */
function candidatesOf(o: ProduceOptions, now: number, counts: ProduceCounts): Candidate[] {
	const root = lanesRoot(o.home);
	if (!present(root)) return [];
	const out: Candidate[] = [];
	for (const wl of readdirSync(root).filter((n) => WL_RE.test(n)).sort()) {
		if (o.only && wl !== o.only) continue;
		const folder = join(root, wl);
		if (!lstatSync(folder).isDirectory()) continue;
		const w = o.workload(wl);
		if (!w || w.status !== "closed" || w.closed_at === null) continue;
		const closed = Date.parse(w.closed_at);
		if (!Number.isFinite(closed)) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: wl, text: `the ledger's closed_at ${JSON.stringify(w.closed_at)} is not a time; not tarred` });
			continue;
		}
		if (now - closed <= CLOSED_FOR_MS) continue;
		if (hasMarker(wl, o.home) || present(recordPath(o.stateDir, wl))) continue;
		if (newestChange(folder, now - QUIET_MS) > now - QUIET_MS) continue;
		try {
			out.push({ wl, folder, bytes: rawBytes(folder) });
		} catch (e) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: wl, text: `${folder} cannot be read (${message(e)}); not tarred` });
		}
	}
	return out.sort((a, b) => a.bytes - b.bytes || (a.wl < b.wl ? -1 : 1));
}

/** Tar one lane (step 4 after the disk check); a line either way. */
async function tarLane(o: ProduceOptions, c: Candidate, counts: ProduceCounts): Promise<void> {
	const clock = o.clock ?? Date.now;
	const ms = o.stepDeadlineMs ?? ARCHIVE_DEADLINE_MS;
	const run = o.run ?? stepRunner({ log: (l) => o.emit({ kind: "skip", subject: c.wl, text: l }) });
	const kill = o.kill ?? (() => {});
	const rp = recordPath(o.stateDir, c.wl);
	const final = laneArchivePath(o.archiveRoot, clock(), c.wl);
	const partial = `${final}.partial-${hex12()}`;
	const verify = join(dirname(final), `.verify-lane-${c.wl}-${hex12()}`);
	let linked = false;
	let recorded = false;
	try {
		const before = contentManifest(c.folder, deadlineCheck(clock, ms, `hashing ${c.folder}`));
		mkdirSync(dirname(final), { recursive: true, mode: 0o700 });
		const t = await run({ what: `tarring ${c.folder}`, argv: ["tar", "-czf", partial, "-C", c.folder, "."], deadlineMs: ms });
		if (!t.ok) throw new Error(t.reason);
		mkdirSync(verify, { mode: 0o700 });
		const x = await run({ what: `extracting ${partial}`, argv: ["tar", "-xzpf", partial, "-C", verify], deadlineMs: ms });
		if (!x.ok) throw new Error(x.reason);
		const copy = contentManifest(verify, deadlineCheck(clock, ms, `hashing the copy ${verify}`));
		const d1 = compareContent(before, copy, "the folder", "the tar");
		if (d1.length > 0) throw new Error(`the tar does not hold the folder as it was read before the tar: ${d1.join("; ")}`);
		const after = contentManifest(c.folder, deadlineCheck(clock, ms, `hashing ${c.folder} again`));
		const d2 = compareContent(before, after, "the folder before the tar", "the folder after it");
		if (d2.length > 0) throw new Error(`the folder changed during the tar: ${d2.join("; ")}`);
		const bytes = statSync(partial).size;
		const sha256 = sha256File(partial, deadlineCheck(clock, ms, `hashing ${partial}`));
		const rec: LaneArchiveRecord = { state: "publishing", workload: c.wl, archive: final, bytes, sha256, content: copy, partial, verify };
		mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
		recorded = true;
		writeJson(rp, rec);
		kill("publishing");
		chmodSync(partial, 0o600);
		linkSync(partial, final);
		linked = true;
		unlinkSync(partial);
		kill("linked");
		writeJson(rp, { state: "pending", workload: c.wl, archive: final, bytes, sha256, content: copy } satisfies LaneArchiveRecord);
		counts.tarred += 1;
		o.emit({ kind: "ok", subject: c.wl, text: `tarred ${c.folder} (${c.bytes} bytes in ${copy.length} entries) to ${final} (${bytes} bytes, sha256 ${sha256}); record ${rp} pending` });
		const left = dropTree(verify);
		if (left) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: c.wl, text: `${left}; the next run removes it` });
		}
	} catch (e) {
		const also: string[] = [];
		const left = dropTree(verify);
		if (left) also.push(left);
		for (const [what, p, mine] of [["partial", partial, true], ["archive", final, linked], ["record", rp, recorded]] as const) {
			if (!mine) continue;
			try {
				if (present(p)) unlinkSync(p);
			} catch (e2) {
				also.push(`the ${what} ${p} could not be removed (${message(e2)})`);
			}
		}
		counts.failed += 1;
		o.emit({ kind: "fail", subject: c.wl, text: `${message(e)}; the partial, the copy${linked ? ", the archive" : ""}${recorded ? " and the record" : ""} were removed and a later night tries again${also.length ? `; also, ${also.join("; ")}` : ""}` });
	}
}

/** `produce` (the header): settle, choose, check the quota, tar smallest first within the budget. */
export async function produce(o: ProduceOptions): Promise<ProduceCounts> {
	const clock = o.clock ?? Date.now;
	const free = o.freeBytes ?? statfsFreeBytes;
	const budget = o.budgetMs ?? DEFAULT_BUDGET_S * 1000;
	const counts: ProduceCounts = { tarred: 0, recovered: 0, skipped: 0, failed: 0, eligible: 0 };
	if (!o.dryRun) settlePublishing(o, counts);
	const start = clock();
	const cands = candidatesOf(o, start, counts);
	counts.eligible = cands.length;
	if (cands.length === 0) return counts;
	const raw = cands.reduce((n, c) => n + c.bytes, 0);
	let q: DriveQuota;
	try {
		q = o.quota();
	} catch (e) {
		counts.failed += 1;
		o.emit({ kind: "fail", subject: "-", text: `Drive quota: ${message(e)}; no lane tarred tonight (${cands.length} eligible)` });
		return counts;
	}
	const need = 2 * raw + GIB;
	if (q.remaining < need) {
		counts.failed += 1;
		o.emit({ kind: "fail", subject: "-", text: `Drive quota: ${q.remaining} bytes remain on account ${q.account}, under 2 x ${raw} raw bytes of tonight's ${cands.length} eligible lanes + 1 GiB (${need}); no lane tarred tonight` });
		return counts;
	}
	for (const c of cands) {
		if (o.dryRun) {
			counts.skipped += 1;
			o.emit({ kind: "skip", subject: c.wl, text: `DRY RUN: would tar ${c.folder} (${c.bytes} bytes)` });
			continue;
		}
		if (clock() - start >= budget) {
			counts.skipped += 1;
			o.emit({ kind: "skip", subject: c.wl, text: `the ${Number((budget / 1000).toFixed(3))} s budget is spent; a later night tars ${c.folder} (${c.bytes} bytes)` });
			continue;
		}
		mkdirSync(o.archiveRoot, { recursive: true, mode: 0o700 });
		const f = free(o.archiveRoot);
		if (f === null) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: c.wl, text: `the free space on ${o.archiveRoot} cannot be read; ${c.folder} not tarred` });
			continue;
		}
		if (c.bytes > f / 2) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: c.wl, text: `${c.folder} is ${c.bytes} bytes, more than half of the ${f} bytes free on ${o.archiveRoot}; skipped, the run carries on` });
			continue;
		}
		await tarLane(o, c, counts);
	}
	return counts;
}

// ---- retire -----------------------------------------------------------------------------------------

export interface RetireOptions {
	home: string;
	stateDir: string;
	/** The nightly's receipts dir (`$STATE/receipts`). */
	receipts: string;
	/** The nightly's claims dir. */
	claims: string;
	/** --keep-local 1: delete no lane data in any state. */
	keepLocal: boolean;
	emit: (l: Line) => void;
	clock?: () => number;
	freeBytes?: (path: string) => number | null;
	only?: string | null;
	kill?: (point: KillPoint) => void;
	dryRun?: boolean;
	/** Passed unchanged to archiveDetached and purgeArchived (tests; the scratch sweep's own seams). */
	seams?: ArchiveSeams;
	/** Runs on the detached tree right before a content-difference thaw (tests). */
	beforeThaw?: (dir: string) => void;
}

export interface RetireCounts {
	retired: number;
	held: number;
	requeued: number;
	finished: number;
	failed: number;
}

type ProofKeys = Pick<OffsiteMarker, "drive_path" | "drive_item_id" | "drive_revision" | "envelope_drive_path" | "member" | "member_sha256">;
type Proof = { kind: "proof"; keys: ProofKeys; receipt: string | null; from: string } | { kind: "lost"; why: string } | { kind: "wait"; why: string };

/** The proof keys a receipt or `.offsite` marker names for the tar with `sha`; null when it names another tar or none. */
function keysOf(kv: Record<string, string>, sha: string): ProofKeys | null {
	if (kv.sha256 !== sha) return null;
	if (kv.drive_path) {
		const keys: ProofKeys = { drive_path: kv.drive_path };
		if (kv.drive_item_id) keys.drive_item_id = kv.drive_item_id;
		if (kv.drive_revision) keys.drive_revision = kv.drive_revision;
		return keys;
	}
	if (kv.envelope_drive_path && kv.member) return { envelope_drive_path: kv.envelope_drive_path, member: kv.member, member_sha256: sha };
	return null;
}

/** Offsite proof for a pending record (the header): the receipts dir first, then `<archive>.offsite`; else lost or wait. */
function proofOf(o: RetireOptions, rec: LaneArchiveRecord): Proof {
	const name = basename(rec.archive);
	const day = basename(dirname(rec.archive));
	const rdir = join(o.receipts, day, name);
	const receipt = join(rdir, "receipt");
	const r = readKv(receipt);
	if (r) {
		const keys = keysOf(r, rec.sha256);
		if (keys) return { kind: "proof", keys, receipt, from: receipt };
	}
	const off = `${rec.archive}${OFFSITE_SUFFIX}`;
	const m = readKv(off);
	if (m) {
		const keys = keysOf(m, rec.sha256);
		if (keys) return { kind: "proof", keys, receipt: m.receipt || null, from: off };
	}
	const claim = join(o.claims, day, `${name}.d`);
	const seen = [rec.archive, claim, rdir, off].filter(present);
	if (seen.length === 0) return { kind: "lost", why: `no public archive ${rec.archive}, claim dir ${claim}, receipt dir ${rdir} or ${off}` };
	return { kind: "wait", why: `no receipt or ${OFFSITE_SUFFIX} names sha256 ${rec.sha256} yet (present: ${seen.join(", ")})` };
}

/** `lanes/.removing-<wl>-<hex>` entries. */
function removingOf(root: string, wl: string): string[] {
	if (!present(root)) return [];
	return readdirSync(root).filter((n) => n.startsWith(`${REMOVING_PREFIX}${wl}-`)).map((n) => join(root, n));
}

const shownRel = (rel: string): string => (rel === "" ? "the top directory" : `./${rel}`);

/** What differs between two reads of a tree in its path set, types and permission bits (top included); empty when equal. */
function shapeDiff(snapshot: Manifest, now: Manifest, limit = 3): string[] {
	const out: string[] = [];
	for (const [rel, x] of snapshot) {
		const y = now.get(rel);
		if (!y) out.push(`${shownRel(rel)} is gone`);
		else if (x.type !== y.type) out.push(`${shownRel(rel)} was a ${x.type}, is a ${y.type}`);
		else if (x.mode !== y.mode) out.push(`${shownRel(rel)} has mode ${y.mode.toString(8)}, not ${x.mode.toString(8)}`);
	}
	for (const rel of now.keys()) if (!snapshot.has(rel)) out.push(`${shownRel(rel)} is new`);
	return out.slice(0, limit);
}

/** Remove every attempt dir under `<state>/tmp/` (copies of a tree still on disk or on Drive); a line for each. */
function cleanAttempts(o: RetireOptions, counts: RetireCounts): void {
	const tmp = join(o.stateDir, "tmp");
	if (!present(tmp)) return;
	for (const name of readdirSync(tmp).sort()) {
		const p = join(tmp, name);
		const wl = ATTEMPT_RE.exec(name)?.[1] ?? "-";
		const left = dropTree(p);
		if (left) {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: wl, text: `the attempt dir ${p} an interrupted retire left could not be removed: ${left}` });
		} else o.emit({ kind: "ok", subject: wl, text: `removed the attempt dir ${p} an interrupted retire left (copies only)` });
	}
}

/** The pending record in `<state>/<wl>.json` carrying `sha`, or null. */
function pendingWith(stateDir: string, wl: string, sha: string): string | null {
	const p = recordPath(stateDir, wl);
	if (!present(p)) return null;
	const rec = readRecord(p);
	return rec.state === "pending" && rec.sha256 === sha ? p : null;
}

/** Next-run rows over every lane marker (the header); no row deletes lane data. */
function nextRunRows(o: RetireOptions, counts: RetireCounts): void {
	const clock = o.clock ?? Date.now;
	const root = lanesRoot(o.home);
	if (!present(root)) return;
	for (const name of readdirSync(root).sort()) {
		const mm = MARKER_RE.exec(name);
		if (!mm) continue;
		const wl = mm[1]!;
		if (o.only && wl !== o.only) continue;
		const mpath = join(root, name);
		const fail = (text: string): void => {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: wl, text });
		};
		try {
			const m = readMarker(mpath);
			const folder = join(root, wl);
			const removing = removingOf(root, wl);
			const folderNote = present(folder) ? `; ${folder} is present too` : "";
			if (m.stranded.length > 0 || removing.length > 0) {
				const stranded = [...new Set([...m.stranded, ...removing])];
				if (stranded.length !== m.stranded.length || stranded.some((s, i) => s !== m.stranded[i])) {
					if (o.dryRun) o.emit({ kind: "skip", subject: wl, text: `DRY RUN: would record ${stranded.join(", ")} as stranded in ${mpath}` });
					else writeMarker(mpath, { ...m, stranded });
				}
				fail(`an interrupted retire left ${stranded.join(", ")}${folderNote}; kept and never resumed; the marker ${mpath} (${m.state}) lists them; run ${restoreCommand(wl)} to put the whole lane back from Drive`);
				continue;
			}
			if (m.state === "retiring") {
				if (!present(folder)) {
					if (o.dryRun) {
						o.emit({ kind: "skip", subject: wl, text: `DRY RUN: would finish the retire a kill stopped after its purge` });
						continue;
					}
					finishOffsite(o, wl, mpath, m, clock(), counts, "a retire killed after its purge removed the folder: finished");
					continue;
				}
				const diff = lstatSync(folder).isDirectory() ? compareContent(m.content, contentManifest(folder), "the marker's manifest", folder) : [`${folder} is not a directory`];
				if (diff.length === 0) {
					if (o.dryRun) {
						o.emit({ kind: "skip", subject: wl, text: `DRY RUN: would remove the marker ${mpath} a retire killed before its detach left` });
						continue;
					}
					unlinkDurable(mpath);
					counts.finished += 1;
					o.emit({ kind: "ok", subject: wl, text: `a retire killed before its detach left the marker ${mpath}; ${folder} is whole and in place with its modes, so the marker was removed and the lane is retired normally` });
					continue;
				}
				fail(`the marker ${mpath} says retiring, but ${folder} differs from its manifest (${diff.join("; ")}); kept and never resumed; run ${restoreCommand(wl)} to put the whole lane back from Drive`);
				continue;
			}
			if (present(folder)) {
				fail(`${folder} was recreated beside the offsite marker ${mpath}; never overwritten; ${restoreCommand(wl)} moves it aside before putting the lane back`);
				continue;
			}
			const rp = pendingWith(o.stateDir, wl, m.tar_sha256);
			if (rp === null) continue;
			if (o.dryRun) {
				o.emit({ kind: "skip", subject: wl, text: `DRY RUN: would move the record ${rp} to done/` });
				continue;
			}
			const dest = moveRecord(o.stateDir, rp, "done", wl, clock());
			counts.finished += 1;
			o.emit({ kind: "ok", subject: wl, text: `a retire killed after its offsite marker left the record pending; moved to ${dest}` });
		} catch (e) {
			fail(`the marker ${mpath} could not be handled (${message(e)}); nothing changed`);
		}
	}
}

/** Step 5 (or its finish on a later run): marker `offsite` with lane_deleted_at and the restore command, the record to done/. */
function finishOffsite(o: RetireOptions, wl: string, mpath: string, m: OffsiteMarker, now: number, counts: RetireCounts, said: string): void {
	writeMarker(mpath, { ...m, state: "offsite", lane_deleted_at: m.lane_deleted_at ?? new Date(now).toISOString(), restore: restoreCommand(wl) });
	(o.kill ?? (() => {}))("marker-offsite");
	const rp = pendingWith(o.stateDir, wl, m.tar_sha256);
	const dest = rp === null ? null : moveRecord(o.stateDir, rp, "done", wl, now);
	counts.finished += 1;
	o.emit({ kind: "ok", subject: wl, text: `${said}; the marker ${mpath} is offsite${dest ? `, the record moved to ${dest}` : ", no pending record carried its sha256"}` });
}

/** Retire one lane with proof, at K0 (steps 1–5, F3, F4). */
function retireLane(o: RetireOptions, path: string, rec: LaneArchiveRecord, proof: Extract<Proof, { kind: "proof" }>, counts: RetireCounts): void {
	const clock = o.clock ?? Date.now;
	const kill = o.kill ?? (() => {});
	const wl = rec.workload;
	const root = lanesRoot(o.home);
	const folder = join(root, wl);
	const mpath = markerPath(wl, o.home);
	const restore = restoreCommand(wl);
	const fail = (text: string): void => {
		counts.failed += 1;
		o.emit({ kind: "fail", subject: wl, text });
	};
	if (!present(folder) || !lstatSync(folder).isDirectory()) {
		fail(`${folder} is missing or not a directory, yet its record ${path} is pending with offsite proof (${proof.from}); nothing done; a person checks`);
		return;
	}
	const bytes = contentBytes(rec.content);
	const free = (o.freeBytes ?? statfsFreeBytes)(o.stateDir);
	if (free === null) {
		fail(`the free space on ${o.stateDir} cannot be read; ${folder} not retired`);
		return;
	}
	if (bytes > free / 2) {
		fail(`${folder} is ${bytes} bytes, more than half of the ${free} bytes free on ${o.stateDir}; not retired, the run carries on`);
		return;
	}
	// (1) the marker
	let marker: OffsiteMarker = {
		workload: wl, state: "retiring", lane_archive: rec.archive, tar_sha256: rec.sha256, ...proof.keys, receipt: proof.receipt, content: rec.content, stranded: [],
	};
	try {
		writeMarker(mpath, marker);
	} catch (e) {
		fail(`step 1: ${message(e)}; nothing removed`);
		return;
	}
	kill("marker-retiring");
	// (2) detach
	let d: Detached;
	try {
		const det = detachChild(realpathSync.native(root), wl, fileIdentity(folder));
		if (det.kind !== "detached") throw new Error(det.kind === "refused" ? det.reason : det.error);
		d = det;
	} catch (e) {
		if (present(folder)) {
			try {
				unlinkDurable(mpath);
				fail(`step 2 (detach): ${message(e)}; nothing removed, ${folder} is in place and the marker removed; the record stays pending and the next night retries; ${restore} is not needed`);
			} catch (e2) {
				fail(`step 2 (detach): ${message(e)}; nothing removed, ${folder} is in place, but the marker ${mpath} could not be removed (${message(e2)}); the next run sees it and removes it`);
			}
		} else {
			const stranded = removingOf(root, wl);
			try {
				writeMarker(mpath, { ...marker, stranded });
			} catch (e2) {
				fail(`step 2 (detach): ${message(e)}; ${folder} is gone and the marker could not record ${stranded.join(", ") || "where it went"} (${message(e2)}); run ${restore}`);
				return;
			}
			fail(`step 2 (detach): ${message(e)}; ${folder} is gone (${stranded.join(", ") || "not found"}); kept and never republished; run ${restore} to put the whole lane back from Drive`);
		}
		return;
	}
	kill("detached");
	const attempt = join(o.stateDir, "tmp", `${wl}-${hex12()}`);
	const dropAttempt = (): string => {
		const left = dropTree(attempt);
		return left ? `; also, the attempt dir ${attempt} could not be removed (${left})` : "";
	};
	// F4: the tree may be partial or frozen: kept where it is, never republished.
	const f4 = (step: string, why: string, at: string): void => {
		const also = dropAttempt();
		marker = { ...marker, stranded: [...new Set([...marker.stranded, at])] };
		let mark = "";
		try {
			writeMarker(mpath, marker);
		} catch (e) {
			mark = `; the marker could not record it (${message(e)}), the next run finds the .removing tree`;
		}
		fail(`${step}: ${why}; the tree is kept at ${at} and never republished; the marker ${mpath} stays retiring with it as stranded, the record ${path} stays${mark}${also}; run ${restore} to put the whole lane back from Drive`);
	};
	// F3: nothing removed: put the tree back.
	const f3 = (step: string, why: string, superseded: boolean): void => {
		const also = dropAttempt();
		const back = restoreDetached(d);
		if (back.at !== d.path) {
			f4(step, `${why}; putting the tree back failed: ${back.said}`, back.at);
			return;
		}
		const notes: string[] = [];
		try {
			unlinkDurable(mpath);
			notes.push("the marker removed");
		} catch (e) {
			notes.push(`the marker ${mpath} could not be removed (${message(e)}); the next run sees the folder whole and removes it`);
		}
		if (superseded) {
			try {
				notes.push(`the record moved to ${moveRecord(o.stateDir, path, "superseded", wl, clock())}, so a later night tars the changed folder`);
			} catch (e) {
				notes.push(`the record ${path} could not be moved to superseded/ (${message(e)})`);
			}
		} else notes.push(`the record ${path} stays pending and the next night retries`);
		fail(`${step}: ${why}; nothing removed: the tree is back at ${folder} with its original modes, ${notes.join(", ")}${also}; ${restore} is not needed`);
	};
	let snapshot: Manifest;
	try {
		snapshot = readManifest(d.doomed, false);
		mkdirSync(attempt, { recursive: true, mode: 0o700 });
	} catch (e) {
		f3("step 2 (snapshot)", message(e), false);
		return;
	}
	// (3) archive, the scratch sweep's call, unchanged
	const seams: ArchiveSeams = {
		...o.seams,
		...(o.freeBytes ? { freeBytes: o.freeBytes } : {}),
		afterTar: () => {
			o.seams?.afterTar?.();
			kill("archive-tar");
		},
		afterFreeze: (dir) => {
			o.seams?.afterFreeze?.(dir);
			kill("archive-frozen");
		},
	};
	const a = archiveDetached(d.doomed, join(attempt, `${wl}.tar.gz`), seams);
	if (a.kind === "failed") {
		let now: Manifest;
		try {
			now = readManifest(d.doomed, false);
		} catch (e) {
			f4("step 3 (archive)", `${a.reason}; the tree could not be read back after the helper's rollback (${message(e)})`, d.doomed);
			return;
		}
		const diff = shapeDiff(snapshot, now);
		if (diff.length > 0) f4("step 3 (archive)", `${a.reason}; after the helper's rollback the tree differs from this attempt's snapshot (${diff.join("; ")})`, d.doomed);
		else f3("step 3 (archive)", a.reason, false);
		return;
	}
	const warned = a.warnings.length ? `; ${a.warnings.join("; ")}` : "";
	const cdiff = compareContent(rec.content, contentOf(a.members), "the proven tar", "the folder");
	if (cdiff.length > 0) {
		o.beforeThaw?.(d.doomed);
		const changed: [string, number][] = [];
		for (const [rel, f] of a.frozen) {
			const m = a.members.get(rel);
			if (m && m.type !== "link" && f.mode !== m.mode) changed.push([rel, m.mode]);
		}
		const t = thawTree(d.doomed, changed);
		if (t) f4("step 3 (content check)", `the folder differs from the proven tar (${cdiff.join("; ")}) and thawing it failed: ${t}${warned}`, d.doomed);
		else f3("step 3 (content check)", `the folder differs from the proven tar (${cdiff.join("; ")})${warned}`, true);
		return;
	}
	// (4) purge, unchanged
	const r = purgeArchived(d, a, o.seams ?? {});
	if (r.kind !== "removed") {
		f4("step 4 (purge)", `${r.kind === "failed" ? r.error : r.reason}${warned}`, d.doomed);
		return;
	}
	kill("purged");
	// (5)
	const also = dropAttempt();
	try {
		finishOffsite(o, wl, mpath, marker, clock(), counts, `retired ${folder}: its content equals the proven tar ${rec.archive} (sha256 ${rec.sha256}, proof ${proof.from}), purged${warned}${also}`);
		counts.finished -= 1;
		counts.retired += 1;
	} catch (e) {
		fail(`step 5: ${folder} is purged (its tar is proven on Drive), but ${message(e)}; the next run finishes it${also}`);
	}
}

/** `retire --keep-local 0|1` (the header). */
export function retire(o: RetireOptions): RetireCounts {
	const counts: RetireCounts = { retired: 0, held: 0, requeued: 0, finished: 0, failed: 0 };
	const clock = o.clock ?? Date.now;
	let release = (): void => {};
	if (!o.dryRun) {
		const lock = acquireOffsiteLock(o.home);
		if (lock.kind === "busy") {
			counts.failed += 1;
			o.emit({ kind: "fail", subject: "-", text: `a retire or restore is running (${lock.path} is locked); nothing done, the next night retries` });
			return counts;
		}
		release = lock.release;
	}
	try {
		if (!o.dryRun) cleanAttempts(o, counts);
		nextRunRows(o, counts);
		const recs = liveRecords(o.stateDir, o.emit, counts)
			.filter(({ rec }) => rec.state === "pending" && (!o.only || rec.workload === o.only) && !hasMarker(rec.workload, o.home))
			.sort((a, b) => contentBytes(a.rec.content) - contentBytes(b.rec.content) || (a.rec.workload < b.rec.workload ? -1 : 1));
		for (const { path, rec } of recs) {
			const wl = rec.workload;
			let proof: Proof;
			try {
				proof = proofOf(o, rec);
			} catch (e) {
				counts.failed += 1;
				o.emit({ kind: "fail", subject: wl, text: `the offsite proof of ${rec.archive} cannot be read (${message(e)}); nothing done` });
				continue;
			}
			if (proof.kind === "wait") {
				counts.held += 1;
				o.emit({ kind: "skip", subject: wl, text: `waiting for the offsite proof of ${rec.archive}: ${proof.why}` });
				continue;
			}
			if (proof.kind === "lost") {
				if (o.dryRun) {
					o.emit({ kind: "skip", subject: wl, text: `DRY RUN: would requeue: ${proof.why}` });
					continue;
				}
				const dest = moveRecord(o.stateDir, path, "lost", wl, clock());
				counts.requeued += 1;
				o.emit({ kind: "ok", subject: wl, text: `the tar was lost before upload (${proof.why}); the folder was never touched; the record moved to ${dest} and the producer tars the folder again` });
				continue;
			}
			if (o.keepLocal) {
				counts.held += 1;
				o.emit({ kind: "skip", subject: wl, text: `proven offsite (${proof.from}); --keep-local 1 keeps the folder` });
				continue;
			}
			if (o.dryRun) {
				counts.held += 1;
				o.emit({ kind: "skip", subject: wl, text: `DRY RUN: would retire ${join(lanesRoot(o.home), wl)} (proof ${proof.from})` });
				continue;
			}
			retireLane(o, path, rec, proof, counts);
		}
	} finally {
		release();
	}
	return counts;
}

// ---- the CLI ----------------------------------------------------------------------------------------

const USAGE = [
	"usage: lane-archive.ts produce --ledger <db> --archive-root <dir> --drivefs-db <metadata_sqlite_db> [--dry-run]",
	"       lane-archive.ts retire --keep-local 0|1 --receipts <dir> --claims <dir> [--dry-run]",
].join("\n");

class Usage extends Error {}

function flags(argv: string[], known: readonly string[]): { values: Record<string, string>; dryRun: boolean } {
	const values: Record<string, string> = {};
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (!known.includes(a)) throw new Usage(`unknown argument ${JSON.stringify(a)}`);
		const v = argv[i + 1];
		if (v === undefined || v === "") throw new Usage(`${a} needs a value`);
		values[a] = v;
		i++;
	}
	for (const k of known) if (values[k] === undefined) throw new Usage(`${k} is required`);
	return { values, dryRun };
}

async function main(argv: string[]): Promise<number> {
	const cmd = argv[0];
	const home = process.env.HOME;
	const out = (l: Line): void => {
		process.stdout.write(`${formatLine(l)}\n`);
	};
	let body: () => Promise<string>;
	try {
		if (!home) throw new Usage("HOME is not set");
		const only = process.env[ONLY_ENV]?.trim() || null;
		if (only !== null && !WL_RE.test(only)) throw new Usage(`${ONLY_ENV}=${only} is not a workload id`);
		const kill = killHook(process.env[KILL_ENV]);
		const stateDir = laneArchiveStateDir(process.env, home);
		if (cmd === "produce") {
			const { values, dryRun } = flags(argv.slice(1), ["--ledger", "--archive-root", "--drivefs-db"]);
			const b = process.env[BUDGET_ENV]?.trim();
			if (b !== undefined && b !== "" && !/^[1-9]\d*$/.test(b)) throw new Usage(`${BUDGET_ENV}=${b} is not a positive number of seconds`);
			const budgetMs = b ? Number(b) * 1000 : DEFAULT_BUDGET_S * 1000;
			body = async () => {
				const ledger = Ledger.open(values["--ledger"]!, { readonly: true });
				try {
					const c = await produce({
						home, stateDir, archiveRoot: values["--archive-root"]!, workload: (wl) => ledger.workload(wl), quota: () => readDriveQuota(values["--drivefs-db"]!),
						emit: out, budgetMs, only, kill, dryRun,
					});
					return `counts\tproduce\ttarred=${c.tarred} recovered=${c.recovered} skipped=${c.skipped} failed=${c.failed} eligible=${c.eligible}`;
				} finally {
					ledger.close();
				}
			};
		} else if (cmd === "retire") {
			const { values, dryRun } = flags(argv.slice(1), ["--keep-local", "--receipts", "--claims"]);
			const k = values["--keep-local"];
			if (k !== "0" && k !== "1") throw new Usage(`--keep-local is ${JSON.stringify(k)}, not 0 or 1`);
			body = async () => {
				const c = retire({ home, stateDir, receipts: values["--receipts"]!, claims: values["--claims"]!, keepLocal: k === "1", emit: out, only, kill, dryRun });
				return `counts\tretire\tretired=${c.retired} held=${c.held} requeued=${c.requeued} finished=${c.finished} failed=${c.failed}`;
			};
		} else throw new Usage(cmd === undefined ? "no command" : `unknown command ${JSON.stringify(cmd)}`);
	} catch (e) {
		if (!(e instanceof Usage)) throw e;
		process.stderr.write(`lane-archive: ${e.message}\n${USAGE}\n`);
		return 2;
	}
	try {
		process.stdout.write(`${await body()}\n`);
		return 0;
	} catch (e) {
		const text = `lane-archive ${cmd} broke: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
		out({ kind: "fail", subject: "-", text });
		process.stderr.write(`${text}\n`);
		return 1;
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			process.stderr.write(`lane-archive: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		},
	);
}
