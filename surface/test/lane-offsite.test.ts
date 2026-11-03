// `as2 lane restore` and the offsite launch refusals (PLAN wl-mw14khl4uf388q "Restore", "Offsite lock", "Launch guard",
// slice sl-lb-restore; R7, R8, R9, R11, R22). Everything runs on the real filesystem under a temp root: a temp HOME whose
// `.agent-system-2/lanes` is the lanes root, a fake Drive directory standing in for My Drive, a receipts dir and the
// lane-archive state dir, with real tar archives built here. Kills come from the restore's own kill hook
// (AS2_LANE_RESTORE_KILL_AT) in a real `lane.ts restore` child, and every rerun is a fresh process. The offsite lock is
// held by a real child process. The refusals go through `lane.ts launch|interactive|run|log` on a real ledger with a
// closed workload. No test sleeps: the hung copy's deadline and progress fire on the step runner's fake timers.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneDir, STARTER_EXIT } from "../src/launch";
import {
	acquireOffsiteLock, COPY_PROGRESS_MS, compareContent, contentManifest, LANE_ARCHIVE_STATE_ENV, logPathFor, markerPath, OFFSITE_LOCK_BUSY_EXIT, type OffsiteMarker,
	parseMarker, readMarker, RestoreError, restoreLane, type RestoreOptions, type Step, type StepRunner, type StepTimers, stepRunner, writeMarker,
} from "../src/lane-offsite";
import { SURFACE_BY } from "../src/types";
import { LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, sh, tmp } from "./helpers";

const REPO = join(import.meta.dir, "..", "..");
const MODULE = join(import.meta.dir, "..", "src", "lane-offsite.ts");
const DAY = "2026-11-03";
const roots: string[] = [];
const children: { kill: (sig?: number) => void }[] = [];
afterAll(() => {
	for (const c of children) c.kill(9);
	for (const r of roots) {
		// read-only directories a test made (the failed-rename case) would pin the removal
		sh(["chmod", "-R", "u+w", r], "/");
		rmSync(r, { recursive: true, force: true });
	}
});

interface World {
	root: string;
	home: string;
	lanes: string;
	drive: string;
	state: string;
	receipts: string;
}

function world(): World {
	const root = realpathSync(tmp("lane-offsite"));
	roots.push(root);
	const w = {
		root, home: join(root, "home"), lanes: join(root, "home", ".agent-system-2", "lanes"), drive: join(root, "My Drive"),
		state: join(root, "state", "lane-archives"), receipts: join(root, "state", "receipts"),
	};
	for (const d of [w.lanes, w.drive, w.state, w.receipts]) mkdirSync(d, { recursive: true });
	return w;
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" } as Record<string, string>;
function run(argv: string[], cwd = "/"): string {
	const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: tarEnv });
	if (r.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
	return r.stdout.toString();
}

/** A lane folder with nested dirs, modes, a read-only file, an executable and a symlink. */
function laneTree(dir: string, tag = "a"): void {
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
}

interface Offsite {
	wl: string;
	src: string;
	marker: OffsiteMarker;
	mpath: string;
	drivePath: string;
	receipt: string;
	record: string;
	envelope: string | null;
}

/**
 * The state a retire leaves: the lane's tar on the fake Drive (alone, or as a member of an envelope tar), its receipt,
 * the lane-archive record (pending) and the marker; the lane folder itself is absent. `src` keeps the original tree.
 */
function offsite(w: World, wl: string, o: { envelope?: boolean; state?: "retiring" | "offsite"; stranded?: string[] } = {}): Offsite {
	const src = join(w.root, "src", wl);
	mkdirSync(src, { recursive: true });
	laneTree(src);
	const archive = join(w.root, "archive", DAY, `${wl}.lane.tar.gz`);
	mkdirSync(dirname(archive), { recursive: true });
	run(["tar", "-czf", archive, "-C", src, "."]);
	const sha = sha256(archive);
	const dir = join(w.drive, "as2-backup", "scratch-archive", DAY);
	mkdirSync(dir, { recursive: true });
	let drivePath: string;
	let receipt: string;
	let envelope: string | null = null;
	const proof: Partial<OffsiteMarker> = {};
	if (o.envelope) {
		const build = join(w.root, "env-build");
		mkdirSync(join(build, DAY), { recursive: true });
		writeFileSync(join(build, "MANIFEST.tsv"), `${DAY}/${wl}.lane.tar.gz\t${sha}\n`);
		writeFileSync(join(build, "PAD"), Buffer.alloc(4096, 7));
		cpSync(archive, join(build, DAY, `${wl}.lane.tar.gz`));
		envelope = join(dir, `env-20261103T023000Z.${"0".repeat(16)}.20261103T023000Z.tar`);
		run(["tar", "-cf", envelope, "-C", build, "MANIFEST.tsv", "PAD", `${DAY}/${wl}.lane.tar.gz`]);
		drivePath = envelope;
		receipt = join(w.receipts, DAY, `${wl}.lane.tar.gz`, "receipt");
		mkdirSync(dirname(receipt), { recursive: true });
		writeFileSync(receipt, `envelope_drive_path=${envelope}\nenvelope_sha256=${sha256(envelope)}\nmember=${DAY}/${wl}.lane.tar.gz\nsha256=${sha}\nbytes=1\n`);
		Object.assign(proof, { envelope_drive_path: envelope, member: `${DAY}/${wl}.lane.tar.gz`, member_sha256: sha });
	} else {
		drivePath = join(dir, `${wl}.lane.${sha.slice(0, 16)}.20261103T023000Z.tar.gz`);
		cpSync(archive, drivePath);
		receipt = join(w.receipts, DAY, `${wl}.lane.tar.gz`, "receipt");
		mkdirSync(dirname(receipt), { recursive: true });
		writeFileSync(receipt, `drive_path=${drivePath}\ndrive_item_id=item-1\ndrive_revision=rev-1\nsha256=${sha}\nmd5=x\nbytes=1\n`);
		Object.assign(proof, { drive_path: drivePath, drive_item_id: "item-1", drive_revision: "rev-1" });
	}
	const marker: OffsiteMarker = {
		workload: wl, state: o.state ?? "offsite", lane_archive: archive, tar_sha256: sha, ...proof, receipt, content: contentManifest(src), stranded: o.stranded ?? [],
		...(o.state === "retiring" ? {} : { lane_deleted_at: "2026-11-04T10:00:00.000Z", restore: `as2 lane restore ${wl}` }),
	};
	const mpath = markerPath(wl, w.home);
	writeMarker(mpath, marker);
	const record = join(w.state, `${wl}.json`);
	writeFileSync(record, JSON.stringify({ state: "pending", workload: wl, archive, bytes: 1, sha256: sha, content: marker.content }));
	return { wl, src, marker, mpath, drivePath, receipt, record, envelope };
}

const opts = (w: World, wl: string, over: Partial<RestoreOptions> = {}): RestoreOptions & { lines: string[] } => {
	const lines: string[] = [];
	return { wl, home: w.home, stateDir: w.state, log: (l) => lines.push(l), lines, ...over };
};
async function failure(o: RestoreOptions): Promise<RestoreError> {
	try {
		await restoreLane(o);
	} catch (e) {
		if (e instanceof RestoreError) return e;
		throw e;
	}
	throw new Error("the restore succeeded; a failure was expected");
}
/** The lanes root as a content manifest: every entry, its mode and its bytes. */
const snapshot = (w: World) => contentManifest(w.lanes);
const retiredMarkers = (w: World, wl: string) => readdirSync(w.lanes).filter((n) => n.startsWith(`${wl}.offsite.restored-`));
const leftoversIn = (w: World, wl: string) => readdirSync(w.lanes).filter((n) => n.startsWith(`.${wl}.restore-leftover-`)).sort();
const stagingIn = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(".restore-"));
/** The restored folder holds exactly the original tree. */
function expectRestored(w: World, f: Offsite): void {
	expect(compareContent(f.marker.content, contentManifest(laneDir(f.wl, w.home)))).toEqual([]);
	expect(existsSync(f.mpath)).toBe(false);
	expect(retiredMarkers(w, f.wl)).toHaveLength(1);
	expect(existsSync(f.record)).toBe(false);
	expect(existsSync(join(w.state, "restored", `${f.wl}.json`))).toBe(true);
	expect(stagingIn(w.lanes)).toEqual([]);
}

describe("the marker, the content manifest and the log path", () => {
	test("writeMarker then readMarker round-trips; a marker without proof keys or with a bad sha256 is refused, naming the file", () => {
		const w = world();
		const f = offsite(w, "wl-roundtrip1");
		expect(readMarker(f.mpath)).toEqual(f.marker);
		const { drive_path: _d, drive_item_id: _i, drive_revision: _r, ...noProof } = f.marker;
		expect(() => parseMarker(JSON.stringify(noProof), "m.offsite")).toThrow("m.offsite: no proof keys");
		expect(() => parseMarker(JSON.stringify({ ...f.marker, tar_sha256: "abc" }), "m.offsite")).toThrow("tar_sha256 is not 64 lowercase hex digits");
		expect(() => parseMarker("{", "m.offsite")).toThrow("m.offsite is not JSON");
		expect(readdirSync(w.lanes).filter((n) => n.includes(".tmp-"))).toEqual([]);
	});

	test("compareContent names an extra entry, a changed mode and changed contents", () => {
		const w = world();
		const a = join(w.root, "a");
		laneTree(a);
		const before = contentManifest(a);
		writeFileSync(join(a, "extra.txt"), "x");
		chmodSync(join(a, "hook.sh"), 0o700);
		writeFileSync(join(a, "system.md"), "other prompt b\n");
		const d = compareContent(before, contentManifest(a), "the marker's manifest", "the tree", 10);
		expect(d).toContain("./extra.txt is in the tree, not in the marker's manifest");
		expect(d).toContain("./hook.sh has mode 755 in the marker's manifest, 700 in the tree");
		expect(d).toContain("./system.md is 16 bytes in the marker's manifest, 15 in the tree");
	});

	test("logPathFor: lanes/<wl>/<name>.log, and lanes/<wl>.<name>.log once the marker exists", () => {
		const w = world();
		expect(logPathFor("wl-logs1", "ctx-index", w.home)).toBe(join(w.lanes, "wl-logs1", "ctx-index.log"));
		const f = offsite(w, "wl-logs1");
		expect(logPathFor(f.wl, "ctx-index", w.home)).toBe(join(w.lanes, "wl-logs1.ctx-index.log"));
		expect(logPathFor(f.wl, "move-alert", w.home)).toBe(join(w.lanes, "wl-logs1.move-alert.log"));
	});
});

describe("restore: the Drive copy is verified before anything is published", () => {
	test("in place with no folder: the tar is copied, its sha256 matches the marker and the receipt, every entry matches; published, record to restored/, marker retired", async () => {
		const w = world();
		const f = offsite(w, "wl-plain1");
		const o = opts(w, f.wl);
		await restoreLane(o);
		expectRestored(w, f);
		expect(o.lines.join("\n")).toContain(`matches the marker and the receipt`);
		expect(o.lines.join("\n")).toContain(`the lane-archive record ${f.record} moved to ${join(w.state, "restored", `${f.wl}.json`)}`);
		const retired = readMarker(join(w.lanes, retiredMarkers(w, f.wl)[0]!));
		expect(retired.leftovers).toEqual([]);
	});

	test("a Drive copy whose sha256 is not the marker's: refused naming the step, the path and both hashes; nothing published, marker and record kept, staging removed", async () => {
		const w = world();
		const f = offsite(w, "wl-shamarker1");
		const wrong = "f".repeat(64);
		writeMarker(f.mpath, { ...f.marker, tar_sha256: wrong });
		const before = readFileSync(f.mpath, "utf8");
		const e = await failure(opts(w, f.wl));
		expect(e.code).toBe(1);
		expect(e.message).toContain(`sha256 check: `);
		expect(e.message).toContain(`has sha256 ${f.marker.tar_sha256}, the marker ${f.mpath} says tar_sha256 ${wrong}`);
		expect(existsSync(laneDir(f.wl, w.home))).toBe(false);
		expect(readFileSync(f.mpath, "utf8")).toBe(before);
		expect(existsSync(f.record)).toBe(true);
		expect(stagingIn(w.lanes)).toEqual([]);
	});

	test("a receipt whose sha256 differs: refused naming the receipt and both hashes", async () => {
		const w = world();
		const f = offsite(w, "wl-sharcpt1");
		const wrong = "e".repeat(64);
		writeFileSync(f.receipt, readFileSync(f.receipt, "utf8").replace(`sha256=${f.marker.tar_sha256}`, `sha256=${wrong}`));
		const e = await failure(opts(w, f.wl));
		expect(e.message).toContain(`has sha256 ${f.marker.tar_sha256}, the receipt ${f.receipt} says ${wrong}`);
		expect(existsSync(laneDir(f.wl, w.home))).toBe(false);
		expect(existsSync(f.mpath)).toBe(true);
	});

	test("a missing receipt is reported and the marker's sha256 still gates: a good copy restores, a bad one is refused", async () => {
		const w = world();
		const f = offsite(w, "wl-norcpt1");
		unlinkSync(f.receipt);
		const o = opts(w, f.wl);
		await restoreLane(o);
		expect(o.lines).toContain(`restore ${f.wl}: the receipt ${f.receipt} is missing; the marker's sha256 gates the copy`);
		expectRestored(w, f);

		const w2 = world();
		const g = offsite(w2, "wl-norcpt2");
		unlinkSync(g.receipt);
		writeFileSync(g.drivePath, "not the lane tar");
		const e = await failure(opts(w2, g.wl));
		expect(e.message).toContain(`the marker ${g.mpath} says tar_sha256 ${g.marker.tar_sha256}`);
		expect(existsSync(laneDir(g.wl, w2.home))).toBe(false);
	});

	test("a Drive copy whose content differs from the marker's manifest (an entry's sha256) is refused naming the entry", async () => {
		const w = world();
		const f = offsite(w, "wl-content1");
		writeMarker(f.mpath, { ...f.marker, content: f.marker.content.map((c) => (c.path === "system.md" ? { ...c, sha256: "a".repeat(64) } : c)) });
		const e = await failure(opts(w, f.wl));
		expect(e.message).toContain("content check: the Drive copy does not hold the marker's manifest: ./system.md has other contents in the Drive copy");
		expect(existsSync(laneDir(f.wl, w.home))).toBe(false);
		expect(stagingIn(w.lanes)).toEqual([]);
	});

	test("an extra file in the Drive copy that the manifest does not list is refused", async () => {
		const w = world();
		const f = offsite(w, "wl-extra1");
		writeMarker(f.mpath, { ...f.marker, content: f.marker.content.filter((c) => c.path !== "hook.sh") });
		const e = await failure(opts(w, f.wl));
		expect(e.message).toContain("./hook.sh is in the Drive copy, not in the marker's manifest");
		expect(existsSync(laneDir(f.wl, w.home))).toBe(false);
	});

	test("an envelope: the member is extracted and its sha256 checked (never the envelope's); a member sha256 the marker does not name is refused", async () => {
		const w = world();
		const f = offsite(w, "wl-envelope1", { envelope: true });
		expect(sha256(f.envelope!)).not.toBe(f.marker.tar_sha256);
		const o = opts(w, f.wl);
		await restoreLane(o);
		expectRestored(w, f);
		expect(o.lines.join("\n")).toContain(`member ${DAY}/${f.wl}.lane.tar.gz of the envelope ${f.envelope} matches the marker and the receipt`);

		const w2 = world();
		const g = offsite(w2, "wl-envelope2", { envelope: true });
		const envSha = sha256(g.envelope!);
		writeMarker(g.mpath, { ...g.marker, member_sha256: envSha });
		const e = await failure(opts(w2, g.wl));
		expect(e.message).toContain(`(from member ${DAY}/${g.wl}.lane.tar.gz of the envelope ${g.envelope}) has sha256 ${g.marker.tar_sha256}, the marker ${g.mpath} says member_sha256 ${envSha}`);
		expect(existsSync(laneDir(g.wl, w2.home))).toBe(false);
	});

	test("--to <dir>: the verified tree lands in <dir>/<wl>; no lock file, the lanes root, the marker and the record unchanged; inside the lanes root is refused", async () => {
		const w = world();
		const f = offsite(w, "wl-to1");
		const before = snapshot(w);
		const to = join(w.root, "elsewhere");
		const o = opts(w, f.wl, { to });
		await restoreLane(o);
		expect(compareContent(f.marker.content, contentManifest(join(to, f.wl)))).toEqual([]);
		expect(snapshot(w)).toEqual(before);
		expect(existsSync(join(w.lanes, ".offsite.lock"))).toBe(false);
		expect(readMarker(f.mpath)).toEqual(f.marker);
		expect(existsSync(f.record)).toBe(true);
		expect(stagingIn(to)).toEqual([]);
		const e = await failure(opts(w, f.wl, { to: join(w.lanes, "x") }));
		expect(e.message).toContain("is inside the lanes root");
		const again = await failure(opts(w, f.wl, { to }));
		expect(again.message).toContain(`${join(to, f.wl)} already exists; nothing restored`);
	});

	test("no marker: nothing to restore, exit 0 with the folder local, a failure without it", async () => {
		const w = world();
		mkdirSync(laneDir("wl-local1", w.home));
		const o = opts(w, "wl-local1");
		await restoreLane(o);
		expect(o.lines).toEqual([`restore wl-local1: nothing to restore: no marker ${markerPath("wl-local1", w.home)}; the lane folder ${laneDir("wl-local1", w.home)} is local`]);
		const e = await failure(opts(w, "wl-gone1"));
		expect(e.code).toBe(1);
		expect(e.message).toContain("nothing to restore: no marker");
	});
});

describe("restore in place: the reconciliation", () => {
	test("an equal folder already in place is kept (same inode), nothing moved, the marker retired", async () => {
		const w = world();
		const f = offsite(w, "wl-equal1");
		cpSync(f.src, laneDir(f.wl, w.home), { recursive: true, verbatimSymlinks: true });
		for (const c of f.marker.content) if (c.type !== "link") chmodSync(join(laneDir(f.wl, w.home), c.path), c.mode);
		const ino = lstatSync(laneDir(f.wl, w.home)).ino;
		const o = opts(w, f.wl);
		await restoreLane(o);
		expectRestored(w, f);
		expect(lstatSync(laneDir(f.wl, w.home)).ino).toBe(ino);
		expect(leftoversIn(w, f.wl)).toEqual([]);
		expect(o.lines.join("\n")).toContain("already holds the marker's manifest (published by an earlier run); kept");
	});

	test("a partial, different folder is moved to a restore-leftover and kept; the verified tree is published", async () => {
		const w = world();
		const f = offsite(w, "wl-partial1");
		mkdirSync(laneDir(f.wl, w.home));
		writeFileSync(join(laneDir(f.wl, w.home), "move-alert.log"), "written after the retire\n");
		const o = opts(w, f.wl);
		await restoreLane(o);
		expectRestored(w, f);
		const left = leftoversIn(w, f.wl);
		expect(left).toHaveLength(1);
		expect(readFileSync(join(w.lanes, left[0]!, "move-alert.log"), "utf8")).toBe("written after the retire\n");
		expect(o.lines.join("\n")).toContain(`leftovers kept for a person (never removed by as2): ${join(w.lanes, left[0]!)} (was ${laneDir(f.wl, w.home)})`);
	});

	test("a .removing-* tree that is also the stranded path is moved once; a retiring marker restores and its record goes to restored/", async () => {
		const w = world();
		const removing = join(w.lanes, ".removing-wl-stranded1-0a1b2c3d4e5f");
		mkdirSync(join(removing, "sessions"), { recursive: true });
		writeFileSync(join(removing, "sessions", "half.jsonl"), "half purged\n");
		const f = offsite(w, "wl-stranded1", { state: "retiring", stranded: [removing] });
		await restoreLane(opts(w, f.wl));
		expectRestored(w, f);
		const left = leftoversIn(w, f.wl);
		expect(left).toHaveLength(1);
		expect(readFileSync(join(w.lanes, left[0]!, "sessions", "half.jsonl"), "utf8")).toBe("half purged\n");
		expect(existsSync(removing)).toBe(false);
		const retired = readMarker(join(w.lanes, retiredMarkers(w, f.wl)[0]!));
		expect(retired.leftovers).toEqual([{ from: removing, to: join(w.lanes, left[0]!), done: true }]);
		// The folder is local again with no marker and no live record: the producer sees a new lane folder.
		expect(readdirSync(w.state).filter((n) => n.endsWith(".json"))).toEqual([]);
	});

	test("a rename that genuinely fails: refused with its own message, nothing published, the marker kept with its planned moves; a rerun after the fix completes", async () => {
		const w = world();
		const pinned = join(w.root, "pinned");
		const stuck = join(pinned, "stuck-tree");
		mkdirSync(stuck, { recursive: true });
		writeFileSync(join(stuck, "f"), "kept\n");
		const f = offsite(w, "wl-renamefail1", { state: "retiring", stranded: [stuck] });
		chmodSync(pinned, 0o555);
		const e = await failure(opts(w, f.wl));
		expect(e.message).toContain(`the rename of the leftover ${stuck} to `);
		expect(e.message).toContain(`failed (`);
		expect(e.message).toContain(`nothing was published and the marker ${f.mpath} is kept with its moves`);
		expect(existsSync(laneDir(f.wl, w.home))).toBe(false);
		const kept = readMarker(f.mpath);
		expect(kept.leftovers).toHaveLength(1);
		expect(kept.leftovers![0]).toMatchObject({ from: stuck, done: false });
		expect(stagingIn(w.lanes)).toEqual([]);
		chmodSync(pinned, 0o755);
		await restoreLane(opts(w, f.wl));
		expectRestored(w, f);
		expect(readFileSync(join(kept.leftovers![0]!.to, "f"), "utf8")).toBe("kept\n");
	});

	test("a folder written after the moves and differing from the manifest is never overwritten: refused, marker kept", async () => {
		const w = world();
		const f = offsite(w, "wl-racer1");
		// The recorded plan says every move is done, yet a writer made the folder again before the publish.
		writeMarker(f.mpath, { ...f.marker, leftovers: [] });
		mkdirSync(laneDir(f.wl, w.home));
		writeFileSync(join(laneDir(f.wl, w.home), "ctx-index.log"), "late writer\n");
		const e = await failure(opts(w, f.wl));
		expect(e.message).toContain(`was written after the leftover moves and differs from the marker's manifest`);
		expect(readFileSync(join(laneDir(f.wl, w.home), "ctx-index.log"), "utf8")).toBe("late writer\n");
		expect(existsSync(f.mpath)).toBe(true);
	});

	test("only the record carrying the marker's tar_sha256 moves; a done/ record moves too; another generation's record stays", async () => {
		const w = world();
		const f = offsite(w, "wl-records1");
		mkdirSync(join(w.state, "done"));
		renameSync(f.record, join(w.state, "done", `${f.wl}.json`));
		const other = join(w.state, `${f.wl}.2.json`);
		writeFileSync(other, JSON.stringify({ state: "pending", workload: f.wl, sha256: "b".repeat(64) }));
		await restoreLane(opts(w, f.wl));
		expect(existsSync(join(w.state, "restored", `${f.wl}.json`))).toBe(true);
		expect(existsSync(join(w.state, "done", `${f.wl}.json`))).toBe(false);
		expect(existsSync(other)).toBe(true);
	});
});

// ---- real processes ----------------------------------------------------------------------------------

const childEnv = (w: World, over: Record<string, string> = {}): Record<string, string> => ({
	PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: w.home, [LANE_ARCHIVE_STATE_ENV]: w.state, TMPDIR: w.root, ...over,
});
/** `lane.ts restore <wl> [...]` as its own process: its exit code, or the signal that ended it. */
function laneRestore(w: World, wl: string, over: Record<string, string> = {}, args: string[] = []) {
	const r = Bun.spawnSync(["bun", LANE_SCRIPT, "restore", wl, ...args], { cwd: w.root, env: childEnv(w, over), stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode, signal: r.signalCode ?? null, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("restore killed between steps, then a fresh process reruns it", () => {
	/** A recreated, different folder and a `.removing-*` tree: two leftover moves before the publish. */
	function twoLeftovers(w: World, wl: string): { f: Offsite; removing: string } {
		const removing = join(w.lanes, `.removing-${wl}-00ff00ff00ff`);
		mkdirSync(removing);
		writeFileSync(join(removing, "half.jsonl"), "half purged\n");
		const f = offsite(w, wl, { state: "retiring", stranded: [removing] });
		mkdirSync(laneDir(wl, w.home));
		writeFileSync(join(laneDir(wl, w.home), "move-alert.log"), "recreated\n");
		return { f, removing };
	}

	for (const point of ["leftovers-planned", "leftover-renamed@1", "leftover-marked@1", "leftover-renamed@2", "published", "record-settled"]) {
		test(`killed at ${point}: the rerun completes from the marker's leftovers list, keeps both leftovers once each and retires the marker`, () => {
			const w = world();
			const wl = `wl-kill${point.replace(/[^a-z0-9]/g, "")}`;
			const { f, removing } = twoLeftovers(w, wl);
			const killed = laneRestore(w, wl, { AS2_LANE_RESTORE_KILL_AT: point });
			expect({ signal: killed.signal, err: killed.err }).toEqual({ signal: "SIGKILL", err: "" });
			expect(existsSync(f.mpath)).toBe(true);
			const planned = readMarker(f.mpath).leftovers!;
			expect(planned.map((l) => l.from)).toEqual([laneDir(wl, w.home), removing]);
			const again = laneRestore(w, wl);
			expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: "" });
			expectRestored(w, f);
			// The same two moves the first run planned, both done, each tree kept once.
			const retired = readMarker(join(w.lanes, retiredMarkers(w, wl)[0]!));
			expect(retired.leftovers).toEqual(planned.map((l) => ({ ...l, done: true })));
			expect(leftoversIn(w, wl)).toHaveLength(2);
			expect(readFileSync(join(planned[0]!.to, "move-alert.log"), "utf8")).toBe("recreated\n");
			expect(readFileSync(join(planned[1]!.to, "half.jsonl"), "utf8")).toBe("half purged\n");
			if (point === "published" || point === "record-settled") expect(again.out).toContain("already holds the marker's manifest (published by an earlier run); kept");
			if (point === "record-settled") expect(again.out).toContain("no lane-archive record carries tar_sha256");
			if (point === "leftovers-planned" || point === "leftover-renamed@1") expect(again.out).toContain("removed an earlier restore's staging dir");
		}, 60_000);
	}
});

describe("the offsite lock", () => {
	test("a restore is refused with exit 75 while another process holds the lock, and takes it once that process is killed", async () => {
		const w = world();
		const f = offsite(w, "wl-lock1");
		// The holder takes the lock, says so, then waits on its stdin, which this test never closes: it holds until killed.
		const holder = Bun.spawn(["bun", "-e", `import { acquireOffsiteLock } from ${JSON.stringify(MODULE)}; console.log(acquireOffsiteLock(process.env.HOME).kind); for await (const _ of console) {}`], {
			env: childEnv(w), stdin: "pipe", stdout: "pipe", stderr: "pipe",
		});
		children.push(holder);
		const reader = holder.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("held\n");
		expect(acquireOffsiteLock(w.home).kind).toBe("busy");
		const refused = laneRestore(w, f.wl);
		expect(refused.code).toBe(OFFSITE_LOCK_BUSY_EXIT);
		expect(refused.err).toContain(`a retire or restore is running (${join(w.lanes, ".offsite.lock")} is locked); run again after it ends`);
		expect(existsSync(laneDir(f.wl, w.home))).toBe(false);
		expect(readMarker(f.mpath)).toEqual(f.marker);
		holder.kill(9);
		await holder.exited;
		const ok = laneRestore(w, f.wl);
		expect({ code: ok.code, err: ok.err }).toEqual({ code: 0, err: "" });
		expectRestored(w, f);
	}, 60_000);
});

/** Timers the test drives: the first progress tick and the deadline of the step the test names fire at once. */
function fakeTimers(fireDeadlineOf: (what: string) => boolean, current: { what: string }): StepTimers & { fired: string[] } {
	const fired: string[] = [];
	return {
		fired,
		after: (ms, fn) => {
			let live = true;
			const kind = ms === COPY_PROGRESS_MS ? "progress" : "deadline";
			if (fireDeadlineOf(current.what) && !fired.includes(`${kind} ${current.what}`)) {
				fired.push(`${kind} ${current.what}`);
				queueMicrotask(() => {
					if (live) fn();
				});
			}
			return () => {
				live = false;
			};
		},
	};
}

describe("deadlines on the step runner (fake timers)", () => {
	test("the runner: an ok step, a failing step named with its stderr, and a hung step killed as a group at its deadline with a progress line", async () => {
		const lines: string[] = [];
		const current = { what: "" };
		const timers = fakeTimers((what) => what === "hang", current);
		const runner = stepRunner({ log: (l) => lines.push(l), timers });
		const step = (s: Step) => {
			current.what = s.what;
			return runner(s);
		};
		expect(await step({ what: "echo", argv: ["/bin/echo", "hi"], deadlineMs: 1000 })).toEqual({ ok: true, stdout: "hi\n" });
		const bad = await step({ what: "list", argv: ["/bin/ls", "/no/such/path"], deadlineMs: 1000 });
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.reason).toContain("list: /bin/ls /no/such/path exited 1: ");
		const hung = await step({ what: "hang", argv: ["/usr/bin/tail", "-f", "/dev/null"], deadlineMs: 7_000, progress: () => "still waiting" });
		expect(hung.ok).toBe(false);
		expect(!hung.ok && hung.reason).toMatch(/^hang passed its 7 s deadline; its process group \d+ \(\/usr\/bin\/tail -f \/dev\/null\) was killed$/);
		expect(lines).toEqual(["hang: still waiting"]);
	});

	test("a hung Drive copy fails naming the step and its deadline; staging removed, nothing published, the marker kept", async () => {
		const w = world();
		const f = offsite(w, "wl-hung1");
		const lines: string[] = [];
		const current = { what: "" };
		const timers = fakeTimers((what) => what.startsWith("copying"), current);
		const real = stepRunner({ log: (l) => lines.push(l), timers });
		// The injected runner: the copy is a process that never ends (as cp on a Drive file that never arrives).
		const hungCopy: StepRunner = (s) => {
			current.what = s.what;
			return real(s.what.startsWith("copying") ? { ...s, argv: ["/usr/bin/tail", "-f", "/dev/null"] } : s);
		};
		const e = await failure({ ...opts(w, f.wl), run: hungCopy, log: (l) => lines.push(l), deadlineMs: 3_600_000 });
		expect(e.message).toContain(`copying ${f.drivePath} from Drive passed its 3600 s deadline; its process group `);
		expect(lines.some((l) => l.startsWith(`copying ${f.drivePath} from Drive: 0 bytes of `) && l.includes("copied to"))).toBe(true);
		expect(existsSync(laneDir(f.wl, w.home))).toBe(false);
		expect(readMarker(f.mpath)).toEqual(f.marker);
		expect(stagingIn(w.lanes)).toEqual([]);
	});
});

// ---- the launch refusals, on a real ledger -----------------------------------------------------------

describe("launch, interactive and run refuse an offsite lane; log names the restore", () => {
	const r: LaneRoot = laneRoot({}, "lane-offsite-launch");
	roots.push(r.root);
	const lane = (args: string[]) => sh(["bun", LANE_SCRIPT, ...args], r.repo, r.env);
	function workload(close: boolean): string {
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		try {
			const wl = l.openWorkload({ by: SURFACE_BY, brief: "offsite probe", stakes: "normal", mode: "autonomous" });
			recordRepo(l, wl, r.repo);
			l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("probed") });
			if (close) l.closeWorkload(wl, { by: SURFACE_BY });
			return wl;
		} finally {
			l.close();
		}
	}
	const w: World = { root: r.root, home: r.home, lanes: join(r.home, ".agent-system-2", "lanes"), drive: join(r.root, "My Drive"), state: join(r.root, "state", "lane-archives"), receipts: join(r.root, "state", "receipts") };
	for (const d of [w.lanes, w.drive, w.state, w.receipts]) mkdirSync(d, { recursive: true });
	const note = (wl: string) => `its lane folder is offsite on Drive: run as2 lane restore ${wl}`;

	test("a closed workload with a marker: launch and interactive refuse `closed` with the restore named; run refuses before its lock; nothing creates the folder", () => {
		const wl = workload(true);
		offsite(w, wl);
		const launch = lane(["launch", wl, "--requested-by", "test"]);
		expect(launch.code).toBe(STARTER_EXIT.closed!);
		expect(launch.err).toBe(`lane reserve: ${wl} not launched: closed; ${note(wl)}`);
		const interactive = lane(["interactive", wl]);
		expect(interactive.code).toBe(STARTER_EXIT.closed!);
		expect(interactive.err).toBe(`lane reserve: ${wl} not launched: closed; ${note(wl)}`);
		const runner = lane(["run", wl, laneIdOf(wl, 1)]);
		expect(runner.code).toBe(STARTER_EXIT.offsite!);
		expect(runner.err).toBe(`lane run: ${laneIdOf(wl, 1)} not started: ${wl}: ${note(wl)} (marker ${markerPath(wl, r.home)})`);
		expect(existsSync(laneDir(wl, r.home))).toBe(false);
		const log = lane(["log", wl]);
		expect(log.code).toBe(0);
		expect(log.out.split("\n")[0]).toBe(`${wl}: ${note(wl)} (marker ${markerPath(wl, r.home)})`);
		expect(existsSync(laneDir(wl, r.home))).toBe(false);
	}, 60_000);

	test("a closed workload without a marker is refused `closed` alone", () => {
		const wl = workload(true);
		const launch = lane(["launch", wl, "--requested-by", "test"]);
		expect(launch.code).toBe(STARTER_EXIT.closed!);
		expect(launch.err).toBe(`lane reserve: ${wl} not launched: closed`);
	}, 60_000);

	test("prepare() refuses a marker even after a reservation: exit 11, launch-failed recorded, the folder never made", () => {
		const wl = workload(false);
		offsite(w, wl);
		const launch = lane(["launch", wl, "--requested-by", "test"]);
		expect(launch.code).toBe(STARTER_EXIT.offsite!);
		expect(launch.err).toBe(`lane preflight: ${wl}: ${note(wl)} (marker ${markerPath(wl, r.home)})`);
		expect(existsSync(laneDir(wl, r.home))).toBe(false);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		try {
			expect(l.entries(wl).some((e) => e.body.startsWith(`launch-failed: ${laneIdOf(wl, 1)}`) && e.body.includes(note(wl)))).toBe(true);
			expect(l.workload(wl)!.holder).toBeNull();
		} finally {
			l.close();
		}
	}, 60_000);

	test("bin/as2 routes `lane restore <wl>` to lane.ts restore, never to an interactive lane", () => {
		const wl = "wl-asroute1";
		const res = Bun.spawnSync(["sh", join(REPO, "bin", "as2"), "lane", "restore", wl], { env: childEnv(w), stdout: "pipe", stderr: "pipe" });
		expect(res.exitCode).toBe(1);
		expect(res.stderr.toString().trim()).toBe(`lane restore: restore of ${wl}: nothing to restore: no marker ${markerPath(wl, r.home)} and no lane folder ${laneDir(wl, r.home)}`);
		const f = offsite(w, "wl-asroute2");
		const ok = Bun.spawnSync(["sh", join(REPO, "bin", "as2"), "lane", "restore", f.wl, "--deadline", "600"], { env: childEnv(w), stdout: "pipe", stderr: "pipe" });
		expect({ code: ok.exitCode, err: ok.stderr.toString() }).toEqual({ code: 0, err: "" });
		expectRestored(w, f);
	}, 60_000);
});
