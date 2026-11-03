// The lane-archive producer and retire (PLAN wl-mw14khl4uf388q "Archive and records", "Producer", "Offsite lock",
// "Retire", "Writers that can recreate the folder"; slice sl-lb-producer; R1-R4, R6, R7, R10-R12, R18, R20, R22).
// Everything runs on the real filesystem under a temp root: a temp HOME whose `.agent-system-2/lanes` is the lanes root,
// an archive root, the lane-archive state dir, a receipts dir and a claims dir, with real tar, lsof and the unchanged
// scratch-remove/scratch-archive helpers. The producer's ledger, quota, clock and free disk are injected in process; the
// CLI runs against a real temp ledger and a DriveFS-shaped sqlite fixture. Kills come from the script's own kill hook
// (AS2_LANE_ARCHIVE_KILL_AT) in a real child, and every rerun is a fresh process. Writers and lock holders are real child
// processes released by events (their ready line, their exit), never a sleep. Quiet and closed ages run on an injected
// clock against mtimes the test sets.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync, closeSync, existsSync, lstatSync, lutimesSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LANE_RUNNER_BY, Ledger } from "../../ledger/src/index";
import {
	CLOSED_FOR_MS, decodeDrivewayAccount, type DriveQuota, formatLine, laneArchivePath, type LaneArchiveRecord, type Line, produce, type ProduceCounts, type ProduceOptions, QUIET_MS,
	QuotaError, readDriveQuota, readRecord, retire, type RetireCounts, type RetireOptions, type WorkloadInfo,
} from "../scripts/lane-archive";
import { spawnCtxIndex } from "../scripts/lane";
import { compareContent, contentManifest, LANE_ARCHIVE_STATE_ENV, markerPath, readMarker, restoreCommand, stepRunner, writeMarker } from "../src/lane-offsite";
import { laneDir, laneHeadroomBody } from "../src/launch";
import { recordQuotaMove, spawnDetached, spawnMoveAlert } from "../src/quota-move-alert";
import { SURFACE_BY } from "../src/types";
import { sh, tmp } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "lane-archive.ts");
const OFFSITE_MODULE = join(import.meta.dir, "..", "src", "lane-offsite.ts");
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const DAY = "2026-11-03";
/** Every lane folder's mtimes are set here: more than QUIET_MS before NOW. */
const OLD = new Date(NOW - 2 * QUIET_MS);
const CLOSED_LONG: WorkloadInfo = { status: "closed", closed_at: new Date(NOW - CLOSED_FOR_MS - 60_000).toISOString() };
const GIB = 1024 ** 3;
const PLENTY = () => 500 * GIB;
const ACCOUNT = "104857600000000000001";

const roots: string[] = [];
const children: { kill: (sig?: number) => void }[] = [];
afterAll(() => {
	for (const c of children) c.kill(9);
	for (const r of roots) {
		// immutable files and frozen directories a test made would pin the removal
		Bun.spawnSync(["chflags", "-R", "nouchg", r]);
		sh(["chmod", "-R", "u+w", r], "/");
		rmSync(r, { recursive: true, force: true });
	}
});

interface World {
	root: string;
	home: string;
	lanes: string;
	state: string;
	receipts: string;
	claims: string;
	archive: string;
}

function world(): World {
	const root = realpathSync(tmp("lane-archive"));
	roots.push(root);
	const w = {
		root, home: join(root, "home"), lanes: join(root, "home", ".agent-system-2", "lanes"), state: join(root, "state", "lane-archives"),
		receipts: join(root, "state", "receipts"), claims: join(root, "claims"), archive: join(root, "archive"),
	};
	for (const d of [w.lanes, w.state, w.receipts, w.claims, w.archive]) mkdirSync(d, { recursive: true });
	return w;
}

/** Every entry under `dir` (itself included) gets `at` as its mtime; links are not followed. */
function age(dir: string, at = OLD): void {
	const stack = [dir];
	while (stack.length > 0) {
		const p = stack.pop()!;
		const st = lstatSync(p);
		if (st.isDirectory()) for (const n of readdirSync(p)) stack.push(join(p, n));
		lutimesSync(p, at, at);
	}
}

/** A lane folder with nested dirs, modes, a read-only file, an executable and a symlink; `pad` bytes make it bigger. */
function lane(w: World, wl: string, o: { tag?: string; pad?: number } = {}): string {
	const dir = join(w.lanes, wl);
	const tag = o.tag ?? "a";
	mkdirSync(join(dir, "sessions", "sub"), { recursive: true });
	writeFileSync(join(dir, "runner.log"), `runner log ${tag}\n`.repeat(50));
	writeFileSync(join(dir, "system.md"), `system prompt ${tag}\n`);
	writeFileSync(join(dir, "sessions", "s1.jsonl"), `{"n":1,"tag":"${tag}"}\n`.repeat(200));
	writeFileSync(join(dir, "sessions", "sub", "deep.json"), `{"deep":"${tag}"}\n`);
	chmodSync(join(dir, "sessions", "sub", "deep.json"), 0o640);
	writeFileSync(join(dir, "frozen.txt"), "read only\n");
	chmodSync(join(dir, "frozen.txt"), 0o444);
	writeFileSync(join(dir, "hook.sh"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(dir, "hook.sh"), 0o755);
	symlinkSync("sessions/s1.jsonl", join(dir, "latest"));
	if (o.pad) writeFileSync(join(dir, "pad.bin"), Buffer.alloc(o.pad, 1));
	age(dir);
	return dir;
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const tarList = (archive: string): string[] => sh(["tar", "-tzf", archive], "/").out.trim().split("\n").sort();

// ---- the quota fixtures -----------------------------------------------------------------------------

const vint = (v: bigint): number[] => {
	const out: number[] = [];
	let n = v;
	do {
		let b = Number(n & 0x7fn);
		n >>= 7n;
		if (n > 0n) b |= 0x80;
		out.push(b);
	} while (n > 0n);
	return out;
};
const fV = (num: number, v: number | bigint): number[] => [...vint(BigInt(num * 8)), ...vint(BigInt(v))];
const fB = (num: number, b: number[]): number[] => [...vint(BigInt(num * 8 + 2)), ...vint(BigInt(b.length)), ...b];
const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];
const TOTAL = 2_203_318_222_848;
const USED = 353_495_584_604;

/**
 * A `driveway_account` blob in the layout measured on 2026-11-03: 1 = 1; 2 = { 1 = { 3 = name, 11 = account id },
 * 3 = { 1 = { 1 = total, 3 = used, 6 = 1, 8 = remaining } }, 13 = 1 }. `quota` replaces the 2/3/1 message.
 */
function accountBlob(o: { id?: string; total?: number; used?: number; remaining?: number; quota?: number[] } = {}): Uint8Array {
	const total = o.total ?? TOTAL;
	const used = o.used ?? USED;
	const q = o.quota ?? [...fV(1, total), ...fV(3, used), ...fV(6, 1), ...fV(8, o.remaining ?? total - used)];
	return Uint8Array.from([...fV(1, 1), ...fB(2, [...fB(1, [...fB(3, utf8("Test User")), ...fB(11, utf8(o.id ?? ACCOUNT))]), ...fB(3, [...fB(1, q)]), ...fV(13, 1)])]);
}

/** `<root>/DriveFS/<account>/metadata_sqlite_db` holding a properties table with `blob` as driveway_account. */
function driveDb(w: World, blob: Uint8Array | null, account = ACCOUNT): string {
	const path = join(w.root, "DriveFS", account, "metadata_sqlite_db");
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	try {
		db.run("CREATE TABLE IF NOT EXISTS properties (property TEXT PRIMARY KEY, value BLOB)");
		db.run("DELETE FROM properties");
		db.run("INSERT INTO properties VALUES ('max_pinning_bytes', x'00')");
		if (blob) db.query("INSERT INTO properties VALUES ('driveway_account', ?)").run(blob);
	} finally {
		db.close();
	}
	return path;
}

const quotaOf = (remaining: number): DriveQuota => ({ account: ACCOUNT, total: TOTAL, used: TOTAL - remaining, remaining });

// ---- in-process runs --------------------------------------------------------------------------------

type Ran<C> = { counts: C; lines: Line[]; text: string[] };

async function produceIn(w: World, workloads: Record<string, WorkloadInfo>, over: Partial<ProduceOptions> = {}): Promise<Ran<ProduceCounts>> {
	const lines: Line[] = [];
	const counts = await produce({
		home: w.home, stateDir: w.state, archiveRoot: w.archive, workload: (wl) => workloads[wl] ?? null, quota: () => quotaOf(1000 * GIB), emit: (l) => lines.push(l),
		clock: () => NOW, freeBytes: PLENTY, ...over,
	});
	return { counts, lines, text: lines.map(formatLine) };
}

function retireIn(w: World, over: Partial<RetireOptions> = {}): Ran<RetireCounts> {
	const lines: Line[] = [];
	const counts = retire({ home: w.home, stateDir: w.state, receipts: w.receipts, claims: w.claims, keepLocal: false, emit: (l) => lines.push(l), freeBytes: PLENTY, ...over });
	return { counts, lines, text: lines.map(formatLine) };
}

/** A lane folder tarred by the real producer: its folder, record path and record. */
async function produced(w: World, wl: string, o: { pad?: number } = {}): Promise<{ folder: string; rpath: string; rec: LaneArchiveRecord }> {
	const folder = lane(w, wl, o);
	const r = await produceIn(w, { [wl]: CLOSED_LONG }, { only: wl });
	expect(r.counts.tarred).toBe(1);
	const rpath = join(w.state, `${wl}.json`);
	return { folder, rpath, rec: readRecord(rpath) };
}

/** The nightly's proof for a record: a single-upload receipt in the receipts dir, or an envelope member's `<origin>.offsite`. */
function prove(w: World, rec: LaneArchiveRecord, how: "receipt" | "offsite" = "receipt"): string {
	const name = rec.archive.split("/").pop()!;
	const day = dirname(rec.archive).split("/").pop()!;
	if (how === "receipt") {
		const r = join(w.receipts, day, name, "receipt");
		mkdirSync(dirname(r), { recursive: true });
		writeFileSync(r, `drive_path=/Drive/as2-backup/${day}/${name}\ndrive_item_id=item-1\ndrive_revision=rev-1\nsha256=${rec.sha256}\nmd5=x\nbytes=${rec.bytes}\nproven_at=2026-11-03T02:30:00Z\n`);
		return r;
	}
	const off = `${rec.archive}.offsite`;
	writeFileSync(off, `envelope_drive_path=/Drive/as2-backup/env-1.tar\nenvelope_item_id=e-1\nenvelope_revision=r-1\nenvelope_sha256=${"e".repeat(64)}\nmember=${day}/${name}\nsha256=${rec.sha256}\nbytes=${rec.bytes}\nreceipt=${join(w.receipts, day, name, "receipt")}\n`);
	return off;
}

const removingOf = (w: World, wl: string): string[] => readdirSync(w.lanes).filter((n) => n.startsWith(`.removing-${wl}-`)).map((n) => join(w.lanes, n));
const attemptsOf = (w: World): string[] => (existsSync(join(w.state, "tmp")) ? readdirSync(join(w.state, "tmp")) : []);
const modesOf = (dir: string): Record<string, number> => Object.fromEntries(contentManifest(dir).map((e) => [e.path, e.mode]));

// ---- the quota --------------------------------------------------------------------------------------

describe("the Drive quota from properties.driveway_account", () => {
	test("the pinned layout decodes: total, used and remaining, the account pinned to its DriveFS directory; a changed quota reads the new numbers", () => {
		const w = world();
		expect(decodeDrivewayAccount(accountBlob(), ACCOUNT)).toEqual({ account: ACCOUNT, total: TOTAL, used: USED, remaining: TOTAL - USED });
		expect(readDriveQuota(driveDb(w, accountBlob()))).toEqual({ account: ACCOUNT, total: TOTAL, used: USED, remaining: TOTAL - USED });
		const used = TOTAL - 3 * GIB;
		expect(readDriveQuota(driveDb(w, accountBlob({ used })))).toEqual({ account: ACCOUNT, total: TOTAL, used, remaining: 3 * GIB });
	});

	test("malformed, a duplicate field, another account, 1 - 3 != 8, a missing row: each a QuotaError naming what differed", () => {
		const w = world();
		const err = (f: () => unknown): string => {
			try {
				f();
			} catch (e) {
				expect(e).toBeInstanceOf(QuotaError);
				return (e as Error).message;
			}
			throw new Error("decoded; a QuotaError was expected");
		};
		const blob = accountBlob();
		expect(err(() => decodeDrivewayAccount(blob.subarray(0, blob.length - 20), ACCOUNT))).toContain("only");
		expect(err(() => decodeDrivewayAccount(Uint8Array.from([0x08, 0x80]), ACCOUNT))).toContain("a varint runs past the end of the message");
		const dup = accountBlob({ quota: [...fV(1, TOTAL), ...fV(3, USED), ...fV(8, TOTAL - USED), ...fV(8, TOTAL - USED)] });
		expect(err(() => decodeDrivewayAccount(dup, ACCOUNT))).toBe("driveway_account 2/3/1: field 8 appears 2 times");
		expect(err(() => decodeDrivewayAccount(accountBlob({ id: "999" }), ACCOUNT))).toBe(`driveway_account 2/1 field 11 names the account "999", not ${ACCOUNT} (its DriveFS account directory)`);
		expect(err(() => decodeDrivewayAccount(accountBlob({ remaining: 5 }), ACCOUNT))).toBe(
			`driveway_account 2/3/1: field 1 (total ${TOTAL}) - field 3 (used ${USED}) = ${TOTAL - USED}, not field 8 (remaining 5); the layout may have changed`,
		);
		const noUsed = accountBlob({ quota: [...fV(1, TOTAL), ...fV(8, TOTAL)] });
		expect(err(() => decodeDrivewayAccount(noUsed, ACCOUNT))).toBe("driveway_account 2/3/1: field 3 is missing");
		const asBytes = accountBlob({ quota: [...fV(1, TOTAL), ...fB(3, [1]), ...fV(8, TOTAL)] });
		expect(err(() => decodeDrivewayAccount(asBytes, ACCOUNT))).toBe("driveway_account 2/3/1: field 3 has wire type 2, not 0");
		const db = driveDb(w, null);
		expect(err(() => readDriveQuota(db))).toBe(`${db}: properties holds 0 driveway_account rows, not 1`);
		expect(err(() => readDriveQuota(join(w.root, "elsewhere", "metadata_sqlite_db")))).toContain("is not in a DriveFS account directory");
		const missing = join(w.root, "DriveFS", "42", "metadata_sqlite_db");
		expect(err(() => readDriveQuota(missing))).toContain(`${missing} cannot be opened read-only`);
	});

	test("an unreadable quota, or remaining under 2 x tonight's raw bytes + 1 GiB, tars no lane that night: one fail line", async () => {
		const w = world();
		lane(w, "wl-q1");
		lane(w, "wl-q2", { pad: 10_000 });
		const workloads = { "wl-q1": CLOSED_LONG, "wl-q2": CLOSED_LONG };
		const broken = await produceIn(w, workloads, {
			quota: () => {
				throw new QuotaError("x: properties holds 0 driveway_account rows, not 1");
			},
		});
		expect(broken.text).toEqual(["fail\t-\tDrive quota: x: properties holds 0 driveway_account rows, not 1; no lane tarred tonight (2 eligible)"]);
		const raw = contentManifest(join(w.lanes, "wl-q1")).reduce((n, e) => n + e.size, 0) + contentManifest(join(w.lanes, "wl-q2")).reduce((n, e) => n + e.size, 0);
		const need = 2 * raw + GIB;
		const short = await produceIn(w, workloads, { quota: () => quotaOf(need - 1) });
		expect(short.text).toEqual([`fail\t-\tDrive quota: ${need - 1} bytes remain on account ${ACCOUNT}, under 2 x ${raw} raw bytes of tonight's 2 eligible lanes + 1 GiB (${need}); no lane tarred tonight`]);
		expect(short.counts).toEqual({ tarred: 0, recovered: 0, skipped: 0, failed: 1, eligible: 2 });
		expect(readdirSync(w.archive)).toEqual([]);
		expect(readdirSync(w.state)).toEqual([]);
		const enough = await produceIn(w, workloads, { quota: () => quotaOf(need) });
		expect(enough.counts.tarred).toBe(2);
	});
});

// ---- produce ----------------------------------------------------------------------------------------

describe("produce", () => {
	test("tars only lanes closed more than 24 h, quiet 1 h, with no marker or record, smallest first; the tar holds the folder and the folder is untouched", async () => {
		const w = world();
		const big = lane(w, "wl-big", { pad: 50_000 });
		const small = lane(w, "wl-small");
		lane(w, "wl-recent");
		lane(w, "wl-open");
		lane(w, "wl-unknown");
		lane(w, "wl-marked");
		lane(w, "wl-recorded");
		const busy = lane(w, "wl-busy");
		writeFileSync(join(busy, "runner.log"), "still writing\n");
		const recently = new Date(NOW - QUIET_MS + 60_000);
		lutimesSync(join(busy, "runner.log"), recently, recently);
		writeFileSync(markerPath("wl-marked", w.home), "{}");
		writeFileSync(join(w.state, "wl-recorded.json"), JSON.stringify({
			state: "pending", workload: "wl-recorded", archive: join(w.archive, "2026-11-01", "wl-recorded.lane.tar.gz"), bytes: 1, sha256: "a".repeat(64),
			content: [{ path: "", type: "dir", size: 0, mode: 0o755, sha256: null, target: null }],
		} satisfies LaneArchiveRecord));
		const before = { big: contentManifest(big), small: contentManifest(small) };
		const stat = { big: statSync(join(big, "runner.log")), small: statSync(small) };
		const r = await produceIn(w, {
			"wl-big": CLOSED_LONG, "wl-small": CLOSED_LONG, "wl-recent": { status: "closed", closed_at: new Date(NOW - CLOSED_FOR_MS + 60_000).toISOString() },
			"wl-open": { status: "open", closed_at: null }, "wl-marked": CLOSED_LONG, "wl-recorded": CLOSED_LONG, "wl-busy": CLOSED_LONG,
		});
		expect(r.counts).toEqual({ tarred: 2, recovered: 0, skipped: 0, failed: 0, eligible: 2 });
		expect(r.lines.map((l) => [l.kind, l.subject])).toEqual([["ok", "wl-small"], ["ok", "wl-big"]]);
		for (const [wl, dir, man] of [["wl-small", small, before.small], ["wl-big", big, before.big]] as const) {
			const archive = join(w.archive, DAY, `${wl}.lane.tar.gz`);
			const rec = readRecord(join(w.state, `${wl}.json`));
			expect(rec).toEqual({ state: "pending", workload: wl, archive, bytes: statSync(archive).size, sha256: sha256(archive), content: man });
			expect(statSync(archive).mode & 0o777).toBe(0o600);
			expect(tarList(archive)).toContain("./sessions/sub/deep.json");
			expect(compareContent(man, contentManifest(dir))).toEqual([]);
			expect(r.lines.find((l) => l.subject === wl)!.text).toContain(`to ${archive} (`);
		}
		// Only reads: the folder's entries keep their times and modes.
		expect(statSync(join(big, "runner.log")).mtimeMs).toBe(stat.big.mtimeMs);
		expect(statSync(small).mtimeMs).toBe(stat.small.mtimeMs);
		expect(modesOf(small)).toEqual(Object.fromEntries(before.small.map((e) => [e.path, e.mode])));
		// Nothing but the finals is left in the archive root.
		expect(readdirSync(join(w.archive, DAY)).sort()).toEqual(["wl-big.lane.tar.gz", "wl-small.lane.tar.gz"]);
		// A second run finds nothing new: each lane has its record.
		const again = await produceIn(w, { "wl-big": CLOSED_LONG, "wl-small": CLOSED_LONG });
		expect(again.counts.eligible).toBe(0);
	});

	test("the name collision rule: a name, a sidecar or a partial in any date directory moves the archive to <wl>.lane.<n>.tar.gz", () => {
		const w = world();
		expect(laneArchivePath(w.archive, NOW, "wl-n1")).toBe(join(w.archive, DAY, "wl-n1.lane.tar.gz"));
		mkdirSync(join(w.archive, "2026-10-01"), { recursive: true });
		writeFileSync(join(w.archive, "2026-10-01", "wl-n1.lane.tar.gz.offsite"), "");
		expect(laneArchivePath(w.archive, NOW, "wl-n1")).toBe(join(w.archive, DAY, "wl-n1.lane.2.tar.gz"));
		writeFileSync(join(w.archive, "2026-10-01", "wl-n1.lane.2.tar.gz.partial-0123456789ab"), "");
		expect(laneArchivePath(w.archive, NOW, "wl-n1")).toBe(join(w.archive, DAY, "wl-n1.lane.3.tar.gz"));
		writeFileSync(join(w.archive, "2026-10-01", "wl-n1.lane.3.tar.gz.stuck"), "");
		expect(laneArchivePath(w.archive, NOW, "wl-n1")).toBe(join(w.archive, DAY, "wl-n1.lane.4.tar.gz"));
		// A scratch archive of another id never collides.
		writeFileSync(join(w.archive, "2026-10-01", "wl-n2.tar.gz"), "");
		expect(laneArchivePath(w.archive, NOW, "wl-n2")).toBe(join(w.archive, DAY, "wl-n2.lane.tar.gz"));
	});

	test("a lane larger than half the free disk is skipped with one fail line naming it, its size and the free space; the run carries on", async () => {
		const w = world();
		const small = lane(w, "wl-fits");
		const big = lane(w, "wl-toolarge", { pad: 200_000 });
		const bigBytes = contentManifest(big).reduce((n, e) => n + e.size, 0);
		const free = 2 * bigBytes - 2;
		const r = await produceIn(w, { "wl-fits": CLOSED_LONG, "wl-toolarge": CLOSED_LONG }, { freeBytes: () => free });
		expect(r.text[1]).toBe(`fail\twl-toolarge\t${big} is ${bigBytes} bytes, more than half of the ${free} bytes free on ${w.archive}; skipped, the run carries on`);
		expect(r.counts).toEqual({ tarred: 1, recovered: 0, skipped: 0, failed: 1, eligible: 2 });
		expect(existsSync(join(w.state, "wl-fits.json"))).toBe(true);
		expect(existsSync(join(w.state, "wl-toolarge.json"))).toBe(false);
		expect(existsSync(small)).toBe(true);
	});

	test("a folder changed during the tar: the tar is discarded (partial, copy, record) with a fail line; a later night tars it", async () => {
		const w = world();
		const folder = lane(w, "wl-changing");
		const real = stepRunner({ log: () => {} });
		const r = await produceIn(w, { "wl-changing": CLOSED_LONG }, {
			run: async (s) => {
				const res = await real(s);
				if (s.what.startsWith("tarring")) writeFileSync(join(folder, "late.log"), "a late writer\n");
				return res;
			},
		});
		expect(r.counts).toEqual({ tarred: 0, recovered: 0, skipped: 0, failed: 1, eligible: 1 });
		expect(r.text[0]).toStartWith("fail\twl-changing\tthe folder changed during the tar: ./late.log is in the folder after it, not in the folder before the tar; ");
		expect(r.text[0]).toContain("the partial, the copy were removed and a later night tries again");
		expect(readdirSync(join(w.archive, DAY))).toEqual([]);
		expect(readdirSync(w.state)).toEqual([]);
		expect(readFileSync(join(folder, "late.log"), "utf8")).toBe("a late writer\n");
		age(folder);
		expect((await produceIn(w, { "wl-changing": CLOSED_LONG })).counts.tarred).toBe(1);
	});

	test("the budget: once spent, every lane left is a skip line for a later night", async () => {
		const w = world();
		lane(w, "wl-b1");
		lane(w, "wl-b2", { pad: 1000 });
		let t = NOW;
		const r = await produceIn(w, { "wl-b1": CLOSED_LONG, "wl-b2": CLOSED_LONG }, {
			budgetMs: 1000,
			// The injected clock moves one second per tarred lane, so the 1 s budget is spent after the first.
			clock: () => t,
			run: async (s) => {
				if (s.what.startsWith("tarring")) t += 1000;
				return stepRunner({ log: () => {} })(s);
			},
		});
		expect(r.counts).toEqual({ tarred: 1, recovered: 0, skipped: 1, failed: 0, eligible: 2 });
		expect(r.text[1]).toBe(`skip\twl-b2\tthe 1 s budget is spent; a later night tars ${join(w.lanes, "wl-b2")} (${contentManifest(join(w.lanes, "wl-b2")).reduce((n, e) => n + e.size, 0)} bytes)`);
	});
});

// ---- the CLI ----------------------------------------------------------------------------------------

/** A real temp ledger whose workloads closed `daysAgo` days before the real now (the CLI runs on the real clock). */
function realLedger(w: World, count: number, daysAgo = 3): { path: string; wls: string[] } {
	const path = join(w.root, "ledger", "ledger.db");
	mkdirSync(dirname(path), { recursive: true });
	const at = new Date(Date.now() - daysAgo * 24 * 3_600_000).toISOString();
	const l = Ledger.open(path, { create: true, backup: false, backupOnOpen: false, clock: () => at });
	try {
		const wls: string[] = [];
		for (let i = 0; i < count; i++) {
			const wl = l.openWorkload({ by: SURFACE_BY, brief: `lane archive probe ${i}`, stakes: "normal", mode: "autonomous" });
			l.closeWorkload(wl, { by: SURFACE_BY });
			wls.push(wl);
		}
		return { path, wls };
	} finally {
		l.close();
	}
}

const cliEnv = (w: World, over: Record<string, string> = {}): Record<string, string> => ({
	PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: w.home, [LANE_ARCHIVE_STATE_ENV]: w.state, TMPDIR: w.root, ...over,
});
function cli(w: World, args: string[], over: Record<string, string> = {}) {
	const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: w.root, env: cliEnv(w, over), stdout: "pipe", stderr: "pipe" });
	const out = r.stdout.toString();
	return { code: r.exitCode, signal: r.signalCode ?? null, out, lines: out.split("\n").filter(Boolean), err: r.stderr.toString() };
}
const produceArgs = (w: World, ledger: string, db: string): string[] => ["produce", "--ledger", ledger, "--archive-root", w.archive, "--drivefs-db", db];
const retireArgs = (w: World, k: 0 | 1): string[] => ["retire", "--keep-local", String(k), "--receipts", w.receipts, "--claims", w.claims];

describe("the CLI", () => {
	test("usage errors exit 2 on stderr; a run ends with its counts line", () => {
		const w = world();
		const bad = cli(w, ["retire", "--keep-local", "2", "--receipts", w.receipts, "--claims", w.claims]);
		expect(bad.code).toBe(2);
		expect(bad.out).toBe("");
		expect(bad.err).toStartWith('lane-archive: --keep-local is "2", not 0 or 1\nusage: lane-archive.ts produce');
		expect(cli(w, ["sweep"]).code).toBe(2);
		expect(cli(w, ["produce", "--ledger", "x"]).err).toStartWith("lane-archive: --archive-root is required");
		const ok = cli(w, retireArgs(w, 1));
		expect({ code: ok.code, out: ok.out, err: ok.err }).toEqual({ code: 0, out: "counts\tretire\tretired=0 held=0 requeued=0 finished=0 failed=0\n", err: "" });
	});

	test("the ledger, the quota fixture and the real clock: produce tars the closed lane; an unreadable ledger breaks the run with exit 1", () => {
		const w = world();
		const { path, wls } = realLedger(w, 1);
		lane(w, wls[0]!);
		const db = driveDb(w, accountBlob());
		const r = cli(w, produceArgs(w, path, db));
		expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
		expect(r.lines[0]).toStartWith(`ok\t${wls[0]}\ttarred ${join(w.lanes, wls[0]!)} (`);
		expect(r.lines.at(-1)).toBe("counts\tproduce\ttarred=1 recovered=0 skipped=0 failed=0 eligible=1");
		const broke = cli(w, produceArgs(w, join(w.root, "no-ledger.db"), db));
		expect(broke.code).toBe(1);
		expect(broke.lines).toHaveLength(1);
		expect(broke.lines[0]).toStartWith("fail\t-\tlane-archive produce broke: ");
	});

	test("the publishing-record restart: killed after the record, the rerun drops it and its partial and tars again; killed after the link, the rerun turns it pending; stale lane partials and copies are removed", () => {
		const w = world();
		const { path, wls } = realLedger(w, 2);
		const [a, b] = wls as [string, string];
		lane(w, a);
		lane(w, b);
		const db = driveDb(w, accountBlob());
		const killed = cli(w, produceArgs(w, path, db), { AS2_LANE_ONLY: a, AS2_LANE_ARCHIVE_KILL_AT: "publishing" });
		expect({ signal: killed.signal, err: killed.err }).toEqual({ signal: "SIGKILL", err: "" });
		const pub = readRecord(join(w.state, `${a}.json`));
		expect(pub.state).toBe("publishing");
		expect(existsSync(pub.partial!)).toBe(true);
		expect(existsSync(pub.verify!)).toBe(true);
		expect(existsSync(pub.archive)).toBe(false);
		// A stale partial and copy of an earlier run that no record names.
		const day = dirname(pub.archive);
		writeFileSync(join(day, `${b}.lane.tar.gz.partial-00aa00aa00aa`), "half");
		mkdirSync(join(day, `.verify-lane-${b}-00bb00bb00bb`, "sub"), { recursive: true });
		chmodSync(join(day, `.verify-lane-${b}-00bb00bb00bb`, "sub"), 0o500);
		const linked = cli(w, produceArgs(w, path, db), { AS2_LANE_ONLY: b, AS2_LANE_ARCHIVE_KILL_AT: "linked" });
		expect(linked.signal).toBe("SIGKILL");
		expect(linked.out).toContain(`skip\t${a}\tan earlier run stopped before publishing ${pub.archive}; its record ${join(w.state, `${a}.json`)} and its partial were dropped, and the folder is tarred again`);
		expect(linked.out).toContain(`ok\t${b}\tremoved the stale lane partial ${join(day, `${b}.lane.tar.gz.partial-00aa00aa00aa`)} an interrupted run left`);
		expect(linked.out).toContain(`ok\t${b}\tremoved the stale lane copy ${join(day, `.verify-lane-${b}-00bb00bb00bb`)} an interrupted run left`);
		expect(existsSync(pub.partial!)).toBe(false);
		expect(existsSync(pub.verify!)).toBe(false);
		const half = readRecord(join(w.state, `${b}.json`));
		expect(half.state).toBe("publishing");
		expect(sha256(half.archive)).toBe(half.sha256);
		const rerun = cli(w, produceArgs(w, path, db));
		expect({ code: rerun.code, err: rerun.err }).toEqual({ code: 0, err: "" });
		expect(rerun.lines[0]).toBe(`ok\t${b}\tan earlier run stopped after linking ${half.archive}; its sha256 ${half.sha256} matches, so the record ${join(w.state, `${b}.json`)} is now pending`);
		expect(rerun.lines.at(-1)).toBe("counts\tproduce\ttarred=1 recovered=1 skipped=0 failed=0 eligible=1");
		for (const wl of [a, b]) {
			const rec = readRecord(join(w.state, `${wl}.json`));
			expect(rec.state).toBe("pending");
			expect(rec.partial).toBeUndefined();
			expect(sha256(rec.archive)).toBe(rec.sha256);
		}
		expect(readdirSync(day).sort()).toEqual([`${a}.lane.tar.gz`, `${b}.lane.tar.gz`].sort());
	}, 60_000);
});

// ---- retire -----------------------------------------------------------------------------------------

describe("retire: offsite proof", () => {
	test("proof from the receipts dir: K1 keeps the folder; K0 detaches, archives, purges and marks the lane offsite; the record goes to done/", async () => {
		const w = world();
		const { folder, rpath, rec } = await produced(w, "wl-r1");
		const receipt = prove(w, rec);
		const k1 = retireIn(w, { keepLocal: true });
		expect(k1.text).toEqual([`skip\twl-r1\tproven offsite (${receipt}); --keep-local 1 keeps the folder`]);
		expect(compareContent(rec.content, contentManifest(folder))).toEqual([]);
		expect(existsSync(markerPath("wl-r1", w.home))).toBe(false);
		const k0 = retireIn(w);
		expect(k0.counts).toEqual({ retired: 1, held: 0, requeued: 0, finished: 0, failed: 0 });
		expect(k0.text[0]).toStartWith(`ok\twl-r1\tretired ${folder}: its content equals the proven tar ${rec.archive} (sha256 ${rec.sha256}, proof ${receipt}), purged; the marker `);
		expect(existsSync(folder)).toBe(false);
		expect(removingOf(w, "wl-r1")).toEqual([]);
		expect(attemptsOf(w)).toEqual([]);
		const m = readMarker(markerPath("wl-r1", w.home));
		expect(m).toMatchObject({
			workload: "wl-r1", state: "offsite", lane_archive: rec.archive, tar_sha256: rec.sha256, drive_path: `/Drive/as2-backup/${DAY}/wl-r1.lane.tar.gz`, drive_item_id: "item-1",
			drive_revision: "rev-1", receipt, content: rec.content, stranded: [], restore: restoreCommand("wl-r1"),
		});
		expect(Number.isFinite(Date.parse(m.lane_deleted_at!))).toBe(true);
		expect(existsSync(rpath)).toBe(false);
		expect(readRecord(join(w.state, "done", "wl-r1.json")).sha256).toBe(rec.sha256);
		// The producer never tars a lane with a marker, and a rerun of retire finds nothing.
		expect(retireIn(w).text).toEqual([]);
	});

	test("proof from <origin>.offsite (an envelope member): the marker carries the envelope keys", async () => {
		const w = world();
		const { rec } = await produced(w, "wl-r2");
		const off = prove(w, rec, "offsite");
		const r = retireIn(w);
		expect(r.counts.retired).toBe(1);
		expect(r.text[0]).toContain(`proof ${off})`);
		expect(readMarker(markerPath("wl-r2", w.home))).toMatchObject({
			envelope_drive_path: "/Drive/as2-backup/env-1.tar", member: `${DAY}/wl-r2.lane.tar.gz`, member_sha256: rec.sha256, receipt: join(w.receipts, DAY, "wl-r2.lane.tar.gz", "receipt"),
		});
	});

	test("a receipt or .offsite naming another sha256 is no proof; a claim dir without a receipt waits", async () => {
		const w = world();
		const { folder, rec } = await produced(w, "wl-r3");
		prove(w, { ...rec, sha256: "f".repeat(64) });
		const claim = join(w.claims, DAY, "wl-r3.lane.tar.gz.d");
		mkdirSync(claim, { recursive: true });
		const r = retireIn(w);
		expect(r.counts).toEqual({ retired: 0, held: 1, requeued: 0, finished: 0, failed: 0 });
		expect(r.text[0]).toStartWith(`skip\twl-r3\twaiting for the offsite proof of ${rec.archive}: no receipt or .offsite names sha256 ${rec.sha256} yet (present: ${rec.archive}, ${claim}, `);
		expect(existsSync(folder)).toBe(true);
	});

	test("the lost-tar requeue: no archive, claim, receipt or .offsite: the record moves to lost/, the folder untouched, and the producer tars it again", async () => {
		const w = world();
		const { folder, rpath, rec } = await produced(w, "wl-lost1");
		rmSync(rec.archive);
		const r = retireIn(w, { keepLocal: true });
		expect(r.counts).toEqual({ retired: 0, held: 0, requeued: 1, finished: 0, failed: 0 });
		expect(r.text[0]).toBe(`ok\twl-lost1\tthe tar was lost before upload (no public archive ${rec.archive}, claim dir ${join(w.claims, DAY, "wl-lost1.lane.tar.gz.d")}, receipt dir ${join(w.receipts, DAY, "wl-lost1.lane.tar.gz")} or ${rec.archive}.offsite); the folder was never touched; the record moved to ${join(w.state, "lost", "wl-lost1.json")} and the producer tars the folder again`);
		expect(existsSync(rpath)).toBe(false);
		expect(compareContent(rec.content, contentManifest(folder))).toEqual([]);
		const again = await produceIn(w, { "wl-lost1": CLOSED_LONG });
		expect(again.counts.tarred).toBe(1);
		expect(readRecord(rpath).state).toBe("pending");
	});

	test("a lane larger than half the free disk is not retired: one fail line, nothing touched", async () => {
		const w = world();
		const { folder, rec } = await produced(w, "wl-r4");
		prove(w, rec);
		const bytes = rec.content.reduce((n, e) => n + e.size, 0);
		const r = retireIn(w, { freeBytes: () => 2 * bytes - 2 });
		expect(r.text).toEqual([`fail\twl-r4\t${folder} is ${bytes} bytes, more than half of the ${2 * bytes - 2} bytes free on ${w.state}; not retired, the run carries on`]);
		expect(existsSync(markerPath("wl-r4", w.home))).toBe(false);
		expect(compareContent(rec.content, contentManifest(folder))).toEqual([]);
	});

	test("retire while another process holds the offsite lock (a restore): refused with one fail line, nothing done", async () => {
		const w = world();
		const { folder, rec } = await produced(w, "wl-lock2");
		prove(w, rec);
		const holder = Bun.spawn([process.execPath, "-e", `import { acquireOffsiteLock } from ${JSON.stringify(OFFSITE_MODULE)}; console.log(acquireOffsiteLock(process.env.HOME).kind); for await (const _ of console) {}`], {
			env: cliEnv(w), stdin: "pipe", stdout: "pipe", stderr: "pipe",
		});
		children.push(holder);
		const first = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(first.value)).toBe("held\n");
		const r = retireIn(w);
		expect(r.text).toEqual([`fail\t-\ta retire or restore is running (${join(w.lanes, ".offsite.lock")} is locked); nothing done, the next night retries`]);
		expect(existsSync(folder)).toBe(true);
		holder.kill(9);
		await holder.exited;
		expect(retireIn(w).counts.retired).toBe(1);
	}, 60_000);
});

describe("retire: F3 and F4", () => {
	test("archiveDetached failing on a file held open by a real child process: F3, the tree back with its modes, the marker removed, the record pending", async () => {
		const w = world();
		const { folder, rpath, rec } = await produced(w, "wl-held1");
		prove(w, rec);
		const modes = modesOf(folder);
		const holder = Bun.spawn(["/bin/sh", "-c", 'exec 3<"$1"; echo ready; read x', "sh", join(folder, "system.md")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		children.push(holder);
		const first = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(first.value)).toBe("ready\n");
		let r: Ran<RetireCounts>;
		try {
			r = retireIn(w);
		} finally {
			holder.kill(9);
			await holder.exited;
		}
		expect(r.counts).toEqual({ retired: 0, held: 0, requeued: 0, finished: 0, failed: 1 });
		expect(r.text[0]).toStartWith("fail\twl-held1\tstep 3 (archive): ");
		expect(r.text[0]).toContain(`is not proven quiet: a process still has files open in it (pid ${holder.pid} has `);
		expect(r.text[0]).toContain(`; nothing removed: the tree is back at ${folder} with its original modes, the marker removed, the record ${rpath} stays pending and the next night retries; ${restoreCommand("wl-held1")} is not needed`);
		expect(compareContent(rec.content, contentManifest(folder))).toEqual([]);
		expect(modesOf(folder)).toEqual(modes);
		expect(existsSync(markerPath("wl-held1", w.home))).toBe(false);
		expect(readRecord(rpath).state).toBe("pending");
		expect(removingOf(w, "wl-held1")).toEqual([]);
		expect(attemptsOf(w)).toEqual([]);
		expect(retireIn(w).counts.retired).toBe(1);
	}, 60_000);

	test("a nested file and its mode changed after production, retired against the old proof: thawed, F3, every byte and mode back, the record superseded; the next producer archives the changed folder with its modes", async () => {
		const w = world();
		const { folder, rpath, rec } = await produced(w, "wl-changed1");
		prove(w, rec);
		// The same size as before, so the mode is the first difference the check names.
		writeFileSync(join(folder, "sessions", "sub", "deep.json"), '{"deep":"b"}\n');
		chmodSync(join(folder, "sessions", "sub", "deep.json"), 0o600);
		age(folder);
		const now = contentManifest(folder);
		const r = retireIn(w);
		expect(r.counts.failed).toBe(1);
		expect(r.text[0]).toStartWith("fail\twl-changed1\tstep 3 (content check): the folder differs from the proven tar (./sessions/sub/deep.json has mode 640 in the proven tar, 600 in the folder); nothing removed: the tree is back at ");
		expect(r.text[0]).toContain(`the record moved to ${join(w.state, "superseded", "wl-changed1.json")}, so a later night tars the changed folder`);
		expect(compareContent(now, contentManifest(folder))).toEqual([]);
		expect(modesOf(folder)).toEqual(Object.fromEntries(now.map((e) => [e.path, e.mode])));
		expect(lstatSync(folder).mode & 0o7777).toBe(now.find((e) => e.path === "")!.mode);
		expect(existsSync(markerPath("wl-changed1", w.home))).toBe(false);
		expect(existsSync(rpath)).toBe(false);
		const again = await produceIn(w, { "wl-changed1": CLOSED_LONG });
		expect(again.counts.tarred).toBe(1);
		const next = readRecord(rpath);
		expect(next.archive).toBe(join(w.archive, DAY, "wl-changed1.lane.2.tar.gz"));
		expect(next.content).toEqual(now);
		expect(next.content.find((e) => e.path === "sessions/sub/deep.json")!.mode).toBe(0o600);
	});

	test("a content difference whose thaw fails goes to F4: the tree kept detached, never republished, the marker retiring with it stranded, reported every night", async () => {
		const w = world();
		const { folder, rpath, rec } = await produced(w, "wl-thawfail1");
		prove(w, rec);
		writeFileSync(join(folder, "system.md"), "changed after production\n");
		age(folder);
		const r = retireIn(w, { beforeThaw: (dir) => sh(["chflags", "uchg", join(dir, "runner.log")], "/") });
		const [doomed] = removingOf(w, "wl-thawfail1");
		expect(doomed).toBeDefined();
		expect(r.text[0]).toStartWith("fail\twl-thawfail1\tstep 3 (content check): the folder differs from the proven tar (./system.md is ");
		expect(r.text[0]).toContain("and thawing it failed: the modes of 1 entries could not be given back: ./runner.log (");
		expect(r.text[0]).toContain(`; the tree is kept at ${doomed} and never republished; the marker ${markerPath("wl-thawfail1", w.home)} stays retiring with it as stranded, the record ${rpath} stays; run ${restoreCommand("wl-thawfail1")} to put the whole lane back from Drive`);
		expect(existsSync(folder)).toBe(false);
		expect(readMarker(markerPath("wl-thawfail1", w.home))).toMatchObject({ state: "retiring", stranded: [doomed] });
		expect(readRecord(rpath).state).toBe("pending");
		expect(attemptsOf(w)).toEqual([]);
		for (const keepLocal of [false, true]) {
			const next = retireIn(w, { keepLocal });
			expect(next.text).toEqual([`fail\twl-thawfail1\tan interrupted retire left ${doomed}; kept and never resumed; the marker ${markerPath("wl-thawfail1", w.home)} (retiring) lists them; run ${restoreCommand("wl-thawfail1")} to put the whole lane back from Drive`]);
			expect(existsSync(doomed!)).toBe(true);
			expect(existsSync(folder)).toBe(false);
		}
	});

	test("an archive failure whose helper thaw failed: the modes differ from this attempt's snapshot, so F4, never republished", async () => {
		const w = world();
		const { folder, rec } = await produced(w, "wl-helperthaw1");
		prove(w, rec);
		const r = retireIn(w, {
			seams: {
				afterFreeze: (dir) => sh(["chflags", "uchg", join(dir, "runner.log")], "/"),
				openFiles: () => ({ kind: "open", holders: ["pid 1 has x open"] }),
			},
		});
		const [doomed] = removingOf(w, "wl-helperthaw1");
		expect(r.text[0]).toStartWith("fail\twl-helperthaw1\tstep 3 (archive): ");
		expect(r.text[0]).toContain("is not proven quiet: a process still has files open in it (pid 1 has x open)");
		expect(r.text[0]).toContain("after the helper's rollback the tree differs from this attempt's snapshot (./runner.log has mode 444, not 644)");
		expect(r.text[0]).toContain(`the tree is kept at ${doomed} and never republished`);
		expect(existsSync(folder)).toBe(false);
		expect(readMarker(markerPath("wl-helperthaw1", w.home)).stranded).toEqual([doomed]);
	});

	test("purgeArchived keeping a file written through a pre-freeze descriptor: F4, the tree left stranded with the write, never republished", async () => {
		const w = world();
		const { folder, rpath, rec } = await produced(w, "wl-purgekeep1");
		prove(w, rec);
		const fd = openSync(join(folder, "system.md"), "r+");
		let r: Ran<RetireCounts>;
		try {
			r = retireIn(w, {
				seams: {
					// The descriptor predates the freeze; lsof is told nothing is open, so only the purge's own check stands.
					openFiles: () => ({ kind: "none" }),
					beforeStage: (path) => {
						if (path.endsWith("/system.md")) writeSync(fd, "X", 0);
					},
				},
			});
		} finally {
			closeSync(fd);
		}
		const [doomed] = removingOf(w, "wl-purgekeep1");
		expect(r.text[0]).toStartWith("fail\twl-purgekeep1\tstep 4 (purge): ");
		expect(r.text[0]).toContain(`; the tree is kept at ${doomed} and never republished; the marker ${markerPath("wl-purgekeep1", w.home)} stays retiring with it as stranded, the record ${rpath} stays`);
		expect(readFileSync(join(doomed!, "system.md"), "utf8")).toStartWith("X");
		expect(existsSync(folder)).toBe(false);
		expect(readMarker(markerPath("wl-purgekeep1", w.home))).toMatchObject({ state: "retiring", stranded: [doomed] });
		expect(attemptsOf(w)).toEqual([]);
	});
});

describe("retire: the next run after a kill (a real child killed by the hook, then a fresh process at K0 and K1)", () => {
	async function killedAt(point: string, wl: string): Promise<{ w: World; folder: string; rpath: string; rec: LaneArchiveRecord }> {
		const w = world();
		const { folder, rpath, rec } = await produced(w, wl);
		prove(w, rec);
		const killed = cli(w, retireArgs(w, 0), { AS2_LANE_ARCHIVE_KILL_AT: point });
		expect({ signal: killed.signal, err: killed.err }).toEqual({ signal: "SIGKILL", err: "" });
		return { w, folder, rpath, rec };
	}

	for (const k of [0, 1] as const) {
		test(`K${k}: killed after the retiring marker, before the detach: the marker is removed (the folder is whole); ${k === 0 ? "the lane is then retired normally" : "nothing more"}`, async () => {
			const wl = `wl-kmarker${k}`;
			const { w, folder, rec } = await killedAt("marker-retiring", wl);
			expect(readMarker(markerPath(wl, w.home)).state).toBe("retiring");
			const r = cli(w, retireArgs(w, k));
			expect(r.code).toBe(0);
			expect(r.lines[0]).toBe(`ok\t${wl}\ta retire killed before its detach left the marker ${markerPath(wl, w.home)}; ${folder} is whole and in place with its modes, so the marker was removed and the lane is retired normally`);
			if (k === 1) {
				expect(r.lines.at(-1)).toBe("counts\tretire\tretired=0 held=1 requeued=0 finished=1 failed=0");
				expect(compareContent(rec.content, contentManifest(folder))).toEqual([]);
				expect(existsSync(markerPath(wl, w.home))).toBe(false);
			} else {
				expect(r.lines.at(-1)).toBe("counts\tretire\tretired=1 held=0 requeued=0 finished=1 failed=0");
				expect(existsSync(folder)).toBe(false);
				expect(readMarker(markerPath(wl, w.home)).state).toBe("offsite");
			}
		}, 60_000);

		for (const point of ["detached", "archive-tar", "archive-frozen"]) {
			test(`K${k}: killed at ${point}: the .removing tree is kept, never resumed, listed as stranded and reported; the attempt dir is removed`, async () => {
				const wl = `wl-k${point.replace(/[^a-z]/g, "")}${k}`;
				const { w, folder, rec } = await killedAt(point, wl);
				const [doomed] = removingOf(w, wl);
				expect(doomed).toBeDefined();
				const attempts = attemptsOf(w);
				expect(attempts).toHaveLength(point === "detached" ? 0 : 1);
				for (let run = 0; run < 2; run++) {
					const r = cli(w, retireArgs(w, k));
					expect(r.code).toBe(0);
					const expected = [
						...(run === 0 ? attempts.map((a) => `ok\t${wl}\tremoved the attempt dir ${join(w.state, "tmp", a)} an interrupted retire left (copies only)`) : []),
						`fail\t${wl}\tan interrupted retire left ${doomed}; kept and never resumed; the marker ${markerPath(wl, w.home)} (retiring) lists them; run ${restoreCommand(wl)} to put the whole lane back from Drive`,
						"counts\tretire\tretired=0 held=0 requeued=0 finished=0 failed=1",
					];
					expect(r.lines).toEqual(expected);
				}
				expect(attemptsOf(w)).toEqual([]);
				expect(readMarker(markerPath(wl, w.home))).toMatchObject({ state: "retiring", stranded: [doomed] });
				expect(existsSync(folder)).toBe(false);
				// No lane data deleted: the detached tree still holds every byte the tar holds.
				expect(compareContent(rec.content.filter((e) => e.path !== ""), contentManifest(doomed!).filter((e) => e.path !== "").map((e) => ({ ...e, mode: rec.content.find((c) => c.path === e.path)?.mode ?? e.mode })))).toEqual([]);
			}, 60_000);
		}

		test(`K${k}: killed after the purge: the next run finishes step 5 (marker offsite, record to done/)`, async () => {
			const wl = `wl-kpurged${k}`;
			const { w, folder, rpath } = await killedAt("purged", wl);
			expect(existsSync(folder)).toBe(false);
			expect(readMarker(markerPath(wl, w.home)).state).toBe("retiring");
			const [attempt] = attemptsOf(w);
			const r = cli(w, retireArgs(w, k));
			expect(r.lines[0]).toBe(`ok\t${wl}\tremoved the attempt dir ${join(w.state, "tmp", attempt!)} an interrupted retire left (copies only)`);
			expect(r.lines[1]).toBe(`ok\t${wl}\ta retire killed after its purge removed the folder: finished; the marker ${markerPath(wl, w.home)} is offsite, the record moved to ${join(w.state, "done", `${wl}.json`)}`);
			expect(r.lines.at(-1)).toBe("counts\tretire\tretired=0 held=0 requeued=0 finished=1 failed=0");
			expect(readMarker(markerPath(wl, w.home))).toMatchObject({ state: "offsite", restore: restoreCommand(wl) });
			expect(existsSync(rpath)).toBe(false);
			expect(attemptsOf(w)).toEqual([]);
		}, 60_000);

		test(`K${k}: killed between the offsite marker and the record move: the next run moves the record to done/`, async () => {
			const wl = `wl-koffsite${k}`;
			const { w, rpath } = await killedAt("marker-offsite", wl);
			expect(readMarker(markerPath(wl, w.home)).state).toBe("offsite");
			expect(readRecord(rpath).state).toBe("pending");
			const r = cli(w, retireArgs(w, k));
			expect(r.lines).toEqual([
				`ok\t${wl}\ta retire killed after its offsite marker left the record pending; moved to ${join(w.state, "done", `${wl}.json`)}`,
				"counts\tretire\tretired=0 held=0 requeued=0 finished=1 failed=0",
			]);
			expect(existsSync(rpath)).toBe(false);
		}, 60_000);
	}

	test("attempt dirs left by kills during the tar and during the extraction are removed whole; one that cannot be removed is a fail line naming it", async () => {
		const w = world();
		const tmpDir = join(w.state, "tmp");
		// As a kill mid-tar leaves it: a partial archive alone.
		const midTar = join(tmpDir, "wl-a1-0123456789ab");
		mkdirSync(midTar, { recursive: true });
		writeFileSync(join(midTar, "wl-a1.tar.gz.partial-0a0b0c0d0e0f"), "half a tar");
		// As a kill mid-extraction leaves it: the partial and part of the verification copy, read-only dirs included.
		const midExtract = join(tmpDir, "wl-a2-0123456789ab");
		mkdirSync(join(midExtract, ".verify-00aa00aa00aa00aa", "sessions"), { recursive: true });
		writeFileSync(join(midExtract, "wl-a2.tar.gz.partial-0a0b0c0d0e0f"), "a tar");
		writeFileSync(join(midExtract, ".verify-00aa00aa00aa00aa", "sessions", "s1.jsonl"), "half");
		chmodSync(join(midExtract, ".verify-00aa00aa00aa00aa", "sessions"), 0o500);
		// One whose file cannot be unlinked.
		const pinned = join(tmpDir, "wl-a3-0123456789ab");
		mkdirSync(join(pinned, ".verify-00bb00bb00bb00bb"), { recursive: true });
		writeFileSync(join(pinned, ".verify-00bb00bb00bb00bb", "pinned"), "x");
		sh(["chflags", "uchg", join(pinned, ".verify-00bb00bb00bb00bb", "pinned")], "/");
		const r = retireIn(w, { keepLocal: true });
		expect(r.text[0]).toBe(`ok\twl-a1\tremoved the attempt dir ${midTar} an interrupted retire left (copies only)`);
		expect(r.text[1]).toBe(`ok\twl-a2\tremoved the attempt dir ${midExtract} an interrupted retire left (copies only)`);
		expect(r.text[2]).toStartWith(`fail\twl-a3\tthe attempt dir ${pinned} an interrupted retire left could not be removed: the verification copy ${pinned} could not be removed (`);
		expect(r.counts.failed).toBe(1);
		expect(attemptsOf(w)).toEqual(["wl-a3-0123456789ab"]);
		sh(["chflags", "nouchg", join(pinned, ".verify-00bb00bb00bb00bb", "pinned")], "/");
		expect(retireIn(w).text).toEqual([`ok\twl-a3\tremoved the attempt dir ${pinned} an interrupted retire left (copies only)`]);
	});

	test("a folder recreated beside an offsite marker is never overwritten: one fail line naming both", async () => {
		const w = world();
		const { folder, rec } = await produced(w, "wl-recreated1");
		prove(w, rec);
		expect(retireIn(w).counts.retired).toBe(1);
		mkdirSync(folder);
		writeFileSync(join(folder, "move-alert.log"), "a late writer\n");
		const r = retireIn(w, { keepLocal: false });
		expect(r.text).toEqual([`fail\twl-recreated1\t${folder} was recreated beside the offsite marker ${markerPath("wl-recreated1", w.home)}; never overwritten; ${restoreCommand("wl-recreated1")} moves it aside before putting the lane back`]);
		expect(readFileSync(join(folder, "move-alert.log"), "utf8")).toBe("a late writer\n");
	});
});

// ---- the post-exit log writers ----------------------------------------------------------------------

describe("the move-alert and ctx-index log writers never recreate an offsite lane's folder", () => {
	function withHome<T>(home: string, f: () => T): T {
		const saved = process.env.HOME;
		process.env.HOME = home;
		try {
			return f();
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
	}

	test("spawnMoveAlert (the real spawner): lanes/<wl>/move-alert.log normally, lanes/<wl>.move-alert.log with a marker; the folder is never made", () => {
		const w = world();
		const ledger = Ledger.open(join(w.root, "ledger.db"), { create: true, backup: false, backupOnOpen: false });
		try {
			const run = (wl: string): string => {
				const id = recordQuotaMove(ledger, {
					workloadId: wl, laneId: "lane-la-1", kind: "lane", from: "a/x", to: "b/y", reason: "probe", by: LANE_RUNNER_BY, eventBody: laneHeadroomBody("lane-la-1", "a/x", "b/y", "probe"),
				});
				let log = "";
				const pid = withHome(w.home, () => spawnMoveAlert(ledger, wl, id, (_argv, env, at) => {
					log = at;
					return spawnDetached(["/usr/bin/true"], env, at);
				}, () => false));
				expect(pid).toBeGreaterThan(0);
				return log;
			};
			const plain = ledger.openWorkload({ by: SURFACE_BY, brief: "move alert probe", stakes: "normal", mode: "autonomous" });
			expect(run(plain)).toBe(join(w.lanes, plain, "move-alert.log"));
			expect(existsSync(join(w.lanes, plain, "move-alert.log"))).toBe(true);
			const offsite = ledger.openWorkload({ by: SURFACE_BY, brief: "move alert offsite probe", stakes: "normal", mode: "autonomous" });
			writeMarker(markerPath(offsite, w.home), {
				workload: offsite, state: "offsite", lane_archive: "/a.tar.gz", tar_sha256: "a".repeat(64), drive_path: "/d", receipt: null, content: [{ path: "", type: "dir", size: 0, mode: 0o755, sha256: null, target: null }], stranded: [],
			});
			expect(run(offsite)).toBe(join(w.lanes, `${offsite}.move-alert.log`));
			expect(existsSync(join(w.lanes, `${offsite}.move-alert.log`))).toBe(true);
			expect(existsSync(laneDir(offsite, w.home))).toBe(false);
		} finally {
			ledger.close();
		}
	});

	test("spawnCtxIndex (the real spawner): lanes/<wl>.ctx-index.log with a marker; the folder is never made", () => {
		const w = world();
		const wl = "wl-ctxoffsite1";
		writeFileSync(markerPath(wl, w.home), "{}");
		withHome(w.home, () => spawnCtxIndex(wl, "lane-ctxoffsite1-1", "runner", ["/usr/bin/true"]));
		expect(existsSync(join(w.lanes, `${wl}.ctx-index.log`))).toBe(true);
		expect(existsSync(laneDir(wl, w.home))).toBe(false);
		const plain = "wl-ctxlocal1";
		withHome(w.home, () => spawnCtxIndex(plain, "lane-ctxlocal1-1", "runner", ["/usr/bin/true"]));
		expect(existsSync(join(w.lanes, plain, "ctx-index.log"))).toBe(true);
	});
});
