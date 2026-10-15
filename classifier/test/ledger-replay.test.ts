// Ledger replay regression (PLAN wl-mv45yk9llwt3pc rev 5; MIGRATION.md item 96): builderLabs,
// reviewPlan and the needs-you render replayed over every workload of the frozen fixture under
// fixtures/ledger-replay/, compared line by line with its golden.txt. Reads nothing under $HOME, so
// the outside-the-fence runner can run it. One test holds the whole run (unpack, open, replay,
// compare) so Bun's per-test timeout fails it past 60 s.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BACKUP_SOURCE_FILE, backupNamespace, canonicalPath, Ledger, LiveLedgerUnderTestError } from "../../ledger/src/index";
import { assertOwnedOnly, BACKUP_NAME, diffLines, diffReport, FIXTURE_DIR, GOLDEN_PATH, readManifest, refreeze, replayFixture, replaySnapshot, TIER_CONFIG_PATH, updateGolden } from "../scripts/ledger-replay";
import { labOf } from "../src/lab";
import { loadTierTable } from "../src/tier-table";
import { tmpDir } from "../../ledger/test/tmp";

test("the ledger replay matches golden.txt line for line", () => {
	const names = readManifest().snapshots.map((s) => s.name);
	// diffLines reports a snapshot that replays to nothing; the live one must also be there.
	expect(names.filter((n) => n.startsWith("live-"))).toHaveLength(1);
	const report = diffReport(diffLines(readFileSync(GOLDEN_PATH, "utf8"), replayFixture(), names));
	if (report) throw new Error(report);
	expect(report).toBe("");
}, 60_000);

/** Every entry of `dir` with its bytes (`dir/` for a subdirectory), for an unchanged-dir check. */
function contents(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		out[e.isDirectory() ? `${e.name}/` : e.name] = e.isDirectory() ? "" : readFileSync(join(dir, e.name), "base64");
	}
	return out;
}

/**
 * A synthetic live ledger at `<root>/live/ledger.db` with `workloads` workloads, and the backups
 * namespace dir refreeze reads beside it (`backups/<namespace>/SOURCE`, no copies), all under
 * `root`: refreeze is passed this path, so nothing reads $HOME or $AGENT_SYSTEM_LEDGER_DB.
 */
function syntheticLive(root: string, workloads: number): string {
	const live = join(root, "live", "ledger.db");
	mkdirSync(dirname(live));
	const ledger = Ledger.open(live, { create: true, backupOnOpen: false, backup: false, skipLocalityCheck: true });
	for (let i = 0; i < workloads; i++) ledger.openWorkload({ id: `wl-synthetic${i}`, brief: "replay test", stakes: "normal", mode: "autonomous", by: "orch-test" });
	ledger.close();
	const canonical = canonicalPath(live);
	const backups = join(dirname(canonical), "backups", backupNamespace(canonical));
	mkdirSync(backups, { recursive: true });
	writeFileSync(join(backups, BACKUP_SOURCE_FILE), `${canonical}\n`);
	return live;
}

/** A previous fixture at `<root>/fixture` holding only what refreeze owns: manifest.json, its one file, golden.txt. */
function syntheticFixture(root: string): string {
	const dir = join(root, "fixture");
	mkdirSync(dir);
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ refrozenAt: "2026-10-11T00:00:00.000Z", snapshots: [{ name: "a", file: "a.db.gz" }] }));
	writeFileSync(join(dir, "a.db.gz"), "a");
	writeFileSync(join(dir, "golden.txt"), "g\n");
	return dir;
}

test("refreeze refuses a fixture dir holding a .db.gz its manifest does not list, naming it, and changes nothing", () => {
	const root = tmpDir("ledger-replay-owned-");
	try {
		const live = syntheticLive(root, 1);
		const dir = syntheticFixture(root);
		writeFileSync(join(dir, "notes.db.gz"), "not the fixture's");
		const before = contents(dir);
		expect(() => refreeze(live, dir, TIER_CONFIG_PATH)).toThrow("Move these out first: notes.db.gz");
		expect(contents(dir)).toEqual(before);
		// No stage and no `.old` sibling.
		expect(readdirSync(root).sort()).toEqual(["fixture", "live"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("refreeze refuses on coverage when the live ledger has no workload and no backups, and changes nothing", () => {
	const root = tmpDir("ledger-replay-coverage-");
	try {
		const live = syntheticLive(root, 0);
		const dir = syntheticFixture(root);
		const before = contents(dir);
		expect(() => refreeze(live, dir, TIER_CONFIG_PATH)).toThrow("replay coverage is broken; golden.txt not written");
		expect(contents(dir)).toEqual(before);
		expect(readdirSync(root).sort()).toEqual(["fixture", "live"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("refreeze refuses a backup SOURCE or a backup copy linked into a live root before reading it (Guard A, MIGRATION.md item 114)", () => {
	const root = tmpDir("ledger-replay-live-link-");
	const was = process.env.AS2_TEST_LIVE_ROOTS;
	try {
		const liveRoot = join(root, "marked-live");
		mkdirSync(liveRoot);
		writeFileSync(join(liveRoot, "target"), "live bytes\n");
		process.env.AS2_TEST_LIVE_ROOTS = liveRoot;
		for (const shape of ["SOURCE", "copy"] as const) {
			const caseRoot = mkdtempSync(join(root, `${shape}-`));
			const live = syntheticLive(caseRoot, 1);
			const dir = syntheticFixture(caseRoot);
			const canonical = canonicalPath(live);
			const backups = join(dirname(canonical), "backups", backupNamespace(canonical));
			if (shape === "SOURCE") {
				rmSync(join(backups, BACKUP_SOURCE_FILE));
				symlinkSync(join(liveRoot, "target"), join(backups, BACKUP_SOURCE_FILE));
			} else {
				symlinkSync(join(liveRoot, "target"), join(backups, "ledger-2026-10-01T00-00-00.000Z.db"));
			}
			expect(() => refreeze(live, dir, TIER_CONFIG_PATH)).toThrow(LiveLedgerUnderTestError);
		}
	} finally {
		if (was === undefined) delete process.env.AS2_TEST_LIVE_ROOTS;
		else process.env.AS2_TEST_LIVE_ROOTS = was;
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("refreeze keeps and reports a file that appears in the old fixture after its ownership check, and removes only what it owns", () => {
	const root = tmpDir("ledger-replay-swap-");
	try {
		const live = syntheticLive(root, 1);
		const dir = syntheticFixture(root);
		const r = refreeze(live, dir, TIER_CONFIG_PATH, { beforeSwap: () => writeFileSync(join(dir, "foreign.txt"), "added after the check") });
		expect(r.lines).toBe(1);
		expect(r.leftover?.remaining).toEqual(["foreign.txt"]);
		const old = r.leftover!.path;
		expect(dirname(old)).toBe(root);
		expect(contents(old)).toEqual({ "foreign.txt": Buffer.from("added after the check").toString("base64") });
		expect(readdirSync(root).sort()).toEqual(["fixture", basename(old), "live"].sort());
		const liveFile = r.manifest.snapshots.find((s) => s.name.startsWith("live-"))!.file;
		expect(readdirSync(dir).sort()).toEqual(["golden.txt", liveFile, "manifest.json"].sort());

		// With nothing foreign, the old dir is emptied of what refreeze owns and removed.
		expect(refreeze(live, dir, TIER_CONFIG_PATH).leftover).toBeNull();
		expect(readdirSync(root).sort()).toEqual(["fixture", basename(old), "live"].sort());
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("the BACKUP_NAME mirror matches a copy the ledger's backupIfDue writes, and refreeze takes that copy", () => {
	const root = tmpDir("ledger-replay-backup-name-");
	try {
		// The ledger's own scheduled copy, in its default backups dir beside a live ledger under root.
		const live = canonicalPath(join(root, "live", "ledger.db"));
		const ledger = Ledger.open(live, { create: true, backupOnOpen: false, skipLocalityCheck: true });
		let copy: string;
		let at: string;
		try {
			ledger.openWorkload({ id: "wl-backupname0", brief: "replay test", stakes: "normal", mode: "autonomous", by: "orch-test" });
			copy = ledger.backupIfDue(true)!;
			// The ledger lists the copy through its private BACKUP_NAME; the mirror must read the same instant.
			const listed = ledger.backups();
			expect(listed.map((b) => b.path)).toEqual([copy]);
			at = listed[0]!.at;
			// A second workload, so the live snapshot is not folded into the copy's bytes.
			ledger.openWorkload({ id: "wl-backupname1", brief: "replay test", stakes: "normal", mode: "autonomous", by: "orch-test" });
		} finally {
			ledger.close();
		}
		const m = BACKUP_NAME.exec(basename(copy));
		expect(m).not.toBeNull();
		expect(`${m![1]}T${m![2]}:${m![3]}:${m![4]}`).toBe(at);

		// The replay's backup selection (refreeze → backupCopies) takes the copy as its own snapshot.
		const r = refreeze(live, syntheticFixture(root), TIER_CONFIG_PATH);
		const taken = r.manifest.snapshots.filter((s) => s.name.startsWith("backup-"));
		expect(taken.map((s) => [s.source, s.now])).toEqual([[copy, at]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("assertOwnedOnly returns the names it owns, and refuses a subdirectory, an unparsable manifest, and entries with no manifest", () => {
	const dir = tmpDir("ledger-replay-owned-");
	try {
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ refrozenAt: "2026-10-11T00:00:00.000Z", snapshots: [{ name: "a", file: "a.db.gz" }] }));
		writeFileSync(join(dir, "a.db.gz"), "a");
		expect([...assertOwnedOnly(dir)].sort()).toEqual(["a.db.gz", "golden.txt", "manifest.json"]);

		mkdirSync(join(dir, "sub"));
		const before = contents(dir);
		expect(() => assertOwnedOnly(dir)).toThrow("Move these out first: sub/");
		expect(contents(dir)).toEqual(before);
		rmSync(join(dir, "sub"), { recursive: true });

		// An unparsable manifest refuses; with no manifest the dir must be empty, and refreeze owns nothing in it.
		writeFileSync(join(dir, "manifest.json"), "{");
		expect(() => assertOwnedOnly(dir)).toThrow("does not parse");
		rmSync(join(dir, "manifest.json"));
		expect(() => assertOwnedOnly(dir)).toThrow("has no manifest.json");
		rmSync(dir, { recursive: true });
		mkdirSync(dir);
		expect(assertOwnedOnly(dir).size).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--update refuses, naming it, when one manifest snapshot replays to no line, and writes no golden.txt", () => {
	const dir = tmpDir("ledger-replay-update-");
	try {
		// One real snapshot (it has workloads) and an empty ledger built here (it has none).
		const real = readManifest().snapshots[0]!;
		copyFileSync(join(FIXTURE_DIR, real.file), join(dir, real.file));
		const emptyPath = join(dir, "empty.db");
		Ledger.open(emptyPath, { create: true, backupOnOpen: false, backup: false, skipLocalityCheck: true }).close();
		const bytes = readFileSync(emptyPath);
		for (const f of readdirSync(dir)) if (f.startsWith("empty.db")) rmSync(join(dir, f));
		writeFileSync(join(dir, "empty-snapshot.db.gz"), Bun.gzipSync(bytes));
		const empty = { name: "empty-snapshot", file: "empty-snapshot.db.gz", source: "test", sameAs: [], sha256: createHash("sha256").update(bytes).digest("hex"), now: real.now };
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ refrozenAt: real.now, snapshots: [real, empty] }));

		expect(() => updateGolden(dir)).toThrow("(every workload) @ empty-snapshot: line");
		expect(existsSync(join(dir, "golden.txt"))).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

test("a production review replays on the deep row with its OpenAI entry from the strong row (Jo, in-mv5qfm8910ycjk): with no strong OpenAI entry the openai lab drops out", () => {
	const dir = tmpDir("ledger-replay-review-row-");
	try {
		const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backupOnOpen: false, backup: false, skipLocalityCheck: true });
		try {
			ledger.openWorkload({ id: "wl-prod", brief: "replay test", stakes: "production", mode: "autonomous", by: "orch-test" });
			ledger.openWorkload({ id: "wl-normal", brief: "replay test", stakes: "normal", mode: "autonomous", by: "orch-test" });
			const table = loadTierTable(TIER_CONFIG_PATH);
			// The two workloads may open in one millisecond, which makes the replay's created_at order unfixed: compare by workload id.
			const lines = (t: typeof table) =>
				replaySnapshot(ledger, "snap", "2026-10-12T00:00:00.000Z", t)
					.map(l => [l.workload, l.tier, l.rowLabs, l.decision])
					.sort((a, b) => a[0]!.localeCompare(b[0]!));
			// The profile's strong row has an OpenAI entry: the deep review row keeps all three labs.
			expect(lines(table)).toEqual([
				["wl-normal", "strong", "anthropic,openai,kimi", "single:anthropic,openai,kimi"],
				["wl-prod", "deep", "anthropic,openai,kimi", "fanout:anthropic,openai,kimi"],
			]);
			// No strong OpenAI entry: the production review row loses openai and never falls back to the deep row's; the normal review plans on the strong row as given.
			const noOpenai = { ...table, strong: table.strong.filter(s => labOf(s) !== "openai") };
			expect(lines(noOpenai)).toEqual([
				["wl-normal", "strong", "anthropic,kimi", "single:anthropic,kimi"],
				["wl-prod", "deep", "anthropic,kimi", "fanout:anthropic,kimi"],
			]);
		} finally {
			ledger.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
