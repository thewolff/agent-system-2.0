// Ledger replay regression (PLAN wl-mv45yk9llwt3pc rev 5; MIGRATION.md item 96): builderLabs (D3),
// reviewPlan (D4–D6) and the needs-you render (§ B3 errorLines) replayed over every workload in a
// frozen, committed copy of the live ledger and its scheduled backups, one line per workload,
// compared with a committed golden file.
//
// Usage:
//   bun classifier/scripts/ledger-replay.ts             replay the fixture, print the diff against golden.txt (exit 1 on any)
//   bun classifier/scripts/ledger-replay.ts --update    rewrite golden.txt from the committed fixture; reads nothing under $HOME
//   bun classifier/scripts/ledger-replay.ts --refreeze  re-take the fixture from the live ledger and its backups, then golden.txt
//
// --refreeze is the only path that reads ~/.agent-system-2, and it never writes there: the live file
// is opened `readonly` and copied with VACUUM INTO (WAL content included); the backups are read as
// bytes. Every snapshot is scanned for credential shapes before anything is written; a hit names
// table, row id, column and pattern (never the text) and stops with exit 2.
// Exit: 0 ok · 1 replay differs from golden.txt, or a failure · 2 credential scan hit.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	assertNotLiveLedgerUnderTest,
	BACKUP_SOURCE_FILE,
	backupNamespace,
	canonicalPath,
	copyProblem,
	defaultLedgerPath,
	Ledger,
	migrateLedger,
	type Stakes,
} from "../../ledger/src/index";
import { errorLines } from "../../surface/src/errors";
import { builderLabs, labOf, providerOf, reviewPlan, reviewRow } from "../src/lab";
import { route } from "../src/route";
import { loadTierTable, type TierTable } from "../src/tier-table";

const REPO = join(import.meta.dir, "..", "..");
export const FIXTURE_DIR = join(REPO, "classifier", "test", "fixtures", "ledger-replay");
export const MANIFEST_PATH = join(FIXTURE_DIR, "manifest.json");
export const GOLDEN_PATH = join(FIXTURE_DIR, "golden.txt");
export const TIER_CONFIG_PATH = join(REPO, "profile", "config.yml");
export const UPDATE_COMMAND = "bun classifier/scripts/ledger-replay.ts --update";
/**
 * A scheduled backup copy's filename, `ledger-<ISO instant with : as ->.db`. Mirrors the
 * module-private `BACKUP_NAME` in ledger/src/index.ts, which the ledger does not export; the test
 * "the BACKUP_NAME mirror matches a copy the ledger's backupIfDue writes" pins the two together.
 */
export const BACKUP_NAME = /^ledger-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3}Z)\.db$/;

// ---- Fixture ------------------------------------------------------------------------------------

export interface SnapshotEntry {
	/** `backup-<copy instant>` or `live-<refreeze instant>`; the first field of its lines. */
	name: string;
	/** `<name>.db.gz` in FIXTURE_DIR, or an earlier snapshot's file when the live copy has its bytes. */
	file: string;
	/** Where the bytes came from (the backup copy's path, or the live path). */
	source: string;
	/**
	 * Further sources whose bytes are this snapshot's file: backup copies folded into it, and the
	 * live path when the live snapshot shares the file.
	 */
	sameAs: string[];
	/** SHA-256 of the unpacked database. */
	sha256: string;
	/** The fixed clock for this snapshot: the copy's filename instant, or the refreeze instant. */
	now: string;
}

export interface Manifest {
	refrozenAt: string;
	snapshots: SnapshotEntry[];
}

export function readManifest(path = MANIFEST_PATH): Manifest {
	return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** `2026-10-11T22:40:00.123Z` → `2026-10-11T22-40-00.123Z`, the scheduled copies' own spelling. */
const stamp = (iso: string) => iso.replace(/:/g, "-");

// ---- One line per workload ----------------------------------------------------------------------

export interface ReplayLine {
	snapshot: string;
	workload: string;
	status: string;
	stakes: string;
	builders: string;
	unknown: number;
	tier: string;
	rowLabs: string;
	decision: string;
	needsYou: string[];
}

const labName = (selector: string) => labOf(selector) ?? `unknown:${providerOf(selector)}`;

export function formatLine(l: ReplayLine): string {
	const unknown = l.unknown > 0 ? ` unknown=${l.unknown}` : "";
	const needs = l.needsYou.length > 0 ? ` ${l.needsYou.join(",")}` : "";
	return `${l.snapshot} ${l.workload} ${l.status} stakes=${l.stakes} builders=${l.builders}${unknown} review@${l.tier}[${l.rowLabs}]=${l.decision} needs-you=${l.needsYou.length}${needs}`;
}

const LINE = /^(\S+) (\S+) (\S+) stakes=(\S+) builders=(\S+)(?: unknown=(\d+))? review@([^[\s]+)\[([^\]]*)\]=(\S+) needs-you=(\d+)(?: (\S+))?$/;

export function parseLine(text: string): ReplayLine | null {
	const m = LINE.exec(text);
	if (!m) return null;
	const needsYou = m[11] ? m[11].split(",") : [];
	if (needsYou.length !== Number(m[10])) return null;
	return {
		snapshot: m[1]!, workload: m[2]!, status: m[3]!, stakes: m[4]!, builders: m[5]!, unknown: m[6] ? Number(m[6]) : 0,
		tier: m[7]!, rowLabs: m[8]!, decision: m[9]!, needsYou,
	};
}

/**
 * The lines of one snapshot. `ledger` is a temporary copy opened with the snapshot's fixed clock;
 * nothing here reads a wall clock (errorLines takes `now`; builderLabs and reviewPlan take none).
 */
export function replaySnapshot(ledger: Ledger, snapshot: string, now: string, table: TierTable): ReplayLine[] {
	const needs = new Map<string, string[]>();
	for (const line of errorLines(ledger, ledger.inFlight(), { now })) {
		needs.set(line.workloadId, [...(needs.get(line.workloadId) ?? []), line.kind]);
	}
	const workloads = ledger.db
		.query<{ id: string; status: string; stakes: Stakes }, []>("SELECT id, status, stakes FROM workloads ORDER BY created_at, id")
		.all();
	return workloads.map(({ id, status, stakes }) => {
		// The replay holds no hand in flight, so no review token is live. A dead hand's session file is not part of the
		// frozen fixture (it lives under $HOME), so the resolver is ledger-only: a dead hand counts nothing (MIGRATION.md item 86).
		const builders = builderLabs(ledger, id, new Set(), () => []);
		// The judge kind's tier through the real routing chain, capped by the workload's stakes.
		const tier = route({ choice: "judge", confidence: 1, probabilities: { judge: 1 } }, stakes).tier;
		// The row a review plans on (Jo's OpenAI-reviewer rule, in-mv5qfm8910ycjk), not the tier row itself.
		const row = reviewRow(table, tier);
		// Hypothetical dispatch: every row model usable, no grant, no pin, the workload's own stakes.
		const plan = reviewPlan({ row, usable: row, builders, stakes, grant: false });
		const decision =
			plan.kind === "park" ? "park"
			: plan.kind === "fanout" ? `fanout:${plan.members.map((m) => m.lab).join(",")}`
			: `single:${[...new Set(plan.models.map(labName))].join(",")}`;
		return {
			snapshot, workload: id, status, stakes,
			builders: builders.labs.length > 0 ? builders.labs.join(",") : "none",
			unknown: builders.unknown.length,
			tier, rowLabs: row.map(labName).join(","), decision,
			needsYou: needs.get(id) ?? [],
		};
	});
}

/** Unpack every manifest snapshot into its own temporary dir, replay it, and remove the dir. */
export function replayFixture(dir = FIXTURE_DIR, configPath = TIER_CONFIG_PATH): ReplayLine[] {
	const manifest = readManifest(join(dir, "manifest.json"));
	if (manifest.snapshots.length === 0) throw new Error(`${join(dir, "manifest.json")} lists no snapshots, so the replay covers nothing`);
	const table = loadTierTable(configPath);
	return manifest.snapshots.flatMap((s) => {
		const bytes = Bun.gunzipSync(readFileSync(join(dir, s.file)));
		const got = createHash("sha256").update(bytes).digest("hex");
		if (got !== s.sha256) throw new Error(`fixture ${s.file} unpacks to sha-256 ${got}, manifest.json says ${s.sha256}`);
		return replayBytes(bytes, s.name, s.now, table);
	});
}

function replayBytes(bytes: Uint8Array, name: string, now: string, table: TierTable): ReplayLine[] {
	const tmp = mkdtempSync(join(tmpdir(), "ledger-replay-"));
	try {
		const path = join(tmp, "ledger.db");
		writeFileSync(path, bytes);
		// skipLocalityCheck: a temporary copy; the check would read $HOME and spawn df/mount. Fixtures
		// frozen at an older schema are upgraded explicitly (Ledger.open never upgrades); the copy is
		// throwaway, so no snapshot, and its frozen leases are not live lanes.
		migrateLedger(path, { snapshot: false, force: true, skipLocalityCheck: true });
		const ledger = Ledger.open(path, { backupOnOpen: false, backup: false, clock: () => now, skipLocalityCheck: true });
		try {
			return replaySnapshot(ledger, name, now, table);
		} finally {
			ledger.close();
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

export function renderGolden(lines: ReplayLine[]): string {
	return lines.map(formatLine).join("\n") + "\n";
}

// ---- The diff -----------------------------------------------------------------------------------

export const RULES = {
	coverage: "fixture coverage (manifest.json / workloads table)",
	fixture: "fixture",
	builders: "D3 builderLabs (classifier/src/lab.ts)",
	tierRow: "tier row (STAKES_CAP in classifier/src/route.ts, profile/config.yml)",
	reviewPlan: "D4–D6 reviewPlan (classifier/src/lab.ts)",
	needsYou: "§ B3 errorLines (surface/src/errors.ts)",
} as const;

export interface LineDiff {
	snapshot: string;
	workload: string;
	field: string;
	rule: string;
	old: string;
	new: string;
}

const buildersOf = (l: ReplayLine) => `${l.builders}${l.unknown > 0 ? ` unknown=${l.unknown}` : ""}`;
const needsOf = (l: ReplayLine) => `${l.needsYou.length}${l.needsYou.length > 0 ? ` ${l.needsYou.join(",")}` : ""}`;

/** Kinds added and removed between two needs-you lists, as a multiset: `+question -held`. */
function kindChange(before: string[], after: string[]): string {
	const count = (xs: string[]) => xs.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
	const b = count(before);
	const a = count(after);
	const parts: string[] = [];
	for (const k of new Set([...before, ...after])) {
		const d = (a.get(k) ?? 0) - (b.get(k) ?? 0);
		for (let i = 0; i < Math.abs(d); i++) parts.push(`${d > 0 ? "+" : "-"}${k}`);
	}
	return parts.length > 0 ? parts.join(" ") : "order changed";
}

/**
 * The replay's own coverage faults: no line at all, a manifest snapshot with no line, or one
 * `<snapshot> <workload>` key twice. `snapshots` is the manifest's snapshot names.
 */
export function coverageDiffs(actual: ReplayLine[], snapshots: readonly string[]): LineDiff[] {
	const diffs: LineDiff[] = [];
	if (actual.length === 0) {
		diffs.push({ snapshot: "(every snapshot)", workload: "(every workload)", field: "line", rule: RULES.coverage, old: "at least one line", new: "the replay produced no lines" });
	}
	const covered = new Set(actual.map((l) => l.snapshot));
	for (const name of snapshots) {
		if (!covered.has(name)) diffs.push({ snapshot: name, workload: "(every workload)", field: "line", rule: RULES.coverage, old: "at least one line", new: "the replay produced no lines for this snapshot" });
	}
	const seen = new Set<string>();
	for (const l of actual) {
		const key = `${l.snapshot} ${l.workload}`;
		if (seen.has(key)) diffs.push({ snapshot: l.snapshot, workload: l.workload, field: "duplicate key", rule: RULES.coverage, old: "one line", new: "the replay produced this key twice" });
		seen.add(key);
	}
	return diffs;
}

/** Throws with every coverage fault of `lines`, before --update or --refreeze writes golden.txt. */
export function assertCoverage(lines: ReplayLine[], snapshots: readonly string[]): void {
	const faults = coverageDiffs(lines, snapshots);
	if (faults.length > 0) throw new Error(`replay coverage is broken; golden.txt not written:\n${faults.map((d) => `  ${formatDiff(d)}`).join("\n")}`);
}

/** --update: replay the fixture in `dir` and rewrite its golden.txt, refusing first on any coverage fault. */
export function updateGolden(dir = FIXTURE_DIR, configPath = TIER_CONFIG_PATH): number {
	const lines = replayFixture(dir, configPath);
	assertCoverage(lines, readManifest(join(dir, "manifest.json")).snapshots.map((s) => s.name));
	writeFileSync(join(dir, "golden.txt"), renderGolden(lines));
	return lines.length;
}

/** Every difference between the golden text and the replay, keyed by `<snapshot> <workload>`. */
export function diffLines(golden: string, actual: ReplayLine[], snapshots: readonly string[]): LineDiff[] {
	const diffs = coverageDiffs(actual, snapshots);
	const old = new Map<string, ReplayLine>();
	const oldLine = new Map<string, number>();
	for (const [i, text] of golden.split("\n").entries()) {
		if (text === "") continue;
		const parsed = parseLine(text);
		if (!parsed) {
			diffs.push({ snapshot: "golden.txt", workload: `line ${i + 1}`, field: "line", rule: RULES.coverage, old: text, new: "(unparseable)" });
			continue;
		}
		const key = `${parsed.snapshot} ${parsed.workload}`;
		const first = oldLine.get(key);
		if (first !== undefined) {
			diffs.push({ snapshot: parsed.snapshot, workload: parsed.workload, field: "duplicate key", rule: RULES.coverage, old: `golden.txt line ${first}`, new: `golden.txt line ${i + 1} repeats it` });
			continue;
		}
		old.set(key, parsed);
		oldLine.set(key, i + 1);
	}
	const seen = new Set<string>();
	for (const now of actual) {
		const key = `${now.snapshot} ${now.workload}`;
		// A repeated key is already reported by coverageDiffs.
		if (seen.has(key)) continue;
		seen.add(key);
		const was = old.get(key);
		const at = { snapshot: now.snapshot, workload: now.workload };
		if (!was) {
			diffs.push({ ...at, field: "line", rule: RULES.coverage, old: "(absent)", new: formatLine(now) });
			continue;
		}
		if (was.status !== now.status) diffs.push({ ...at, field: "status", rule: RULES.fixture, old: was.status, new: now.status });
		if (was.stakes !== now.stakes) diffs.push({ ...at, field: "stakes", rule: RULES.fixture, old: was.stakes, new: now.stakes });
		if (buildersOf(was) !== buildersOf(now)) diffs.push({ ...at, field: "builders", rule: RULES.builders, old: buildersOf(was), new: buildersOf(now) });
		const sameRow = was.tier === now.tier && was.rowLabs === now.rowLabs;
		if (!sameRow) {
			diffs.push({ ...at, field: "review tier", rule: RULES.tierRow, old: `${was.tier}[${was.rowLabs}]`, new: `${now.tier}[${now.rowLabs}]` });
		}
		if (was.decision !== now.decision) {
			// A decision that moved with its row is the row's change, already named above.
			const rule = sameRow ? RULES.reviewPlan : RULES.tierRow;
			diffs.push({ ...at, field: "review", rule, old: was.decision, new: now.decision });
		}
		if (needsOf(was) !== needsOf(now)) {
			diffs.push({ ...at, field: "needs-you", rule: `${RULES.needsYou}: ${kindChange(was.needsYou, now.needsYou)}`, old: needsOf(was), new: needsOf(now) });
		}
	}
	for (const [key, was] of old) {
		if (!seen.has(key)) diffs.push({ snapshot: was.snapshot, workload: was.workload, field: "line", rule: RULES.coverage, old: formatLine(was), new: "(absent)" });
	}
	return diffs;
}

export function formatDiff(d: LineDiff): string {
	return `${d.workload} @ ${d.snapshot}: ${d.field} — ${d.rule}: ${d.old} → ${d.new}`;
}

/** The failure message: every difference, then the accept path. Empty when nothing differs. */
export function diffReport(diffs: LineDiff[]): string {
	if (diffs.length === 0) return "";
	return [
		`ledger replay differs from ${join("classifier", "test", "fixtures", "ledger-replay", "golden.txt")} on ${diffs.length} field(s):`,
		...diffs.map((d) => `  ${formatDiff(d)}`),
		`If every change above is intended, accept it: ${UPDATE_COMMAND}`,
	].join("\n");
}

// ---- Refreeze -----------------------------------------------------------------------------------

/** Credential shapes the refreeze refuses to commit (PLAN § Size and privacy). */
export const CREDENTIAL_PATTERNS: readonly { name: string; re: RegExp }[] = [
	{ name: "sk- key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ name: "GitHub token", re: /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/ },
	{ name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "Slack token", re: /\bxox[bpa]-[A-Za-z0-9-]{10,}/ },
	{ name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
	{ name: "api key assignment", re: /api[_-]?key\s*[:=]/i },
	{ name: "password assignment", re: /password\s*[:=]/i },
];

export interface CredentialHit {
	snapshot: string;
	table: string;
	rowId: string;
	column: string;
	pattern: string;
}

/** Every TEXT value of every table in the database at `path`, matched against CREDENTIAL_PATTERNS. */
export function scanCredentials(path: string, snapshot: string): CredentialHit[] {
	assertNotLiveLedgerUnderTest(path);
	const db = new Database(path, { readonly: true });
	try {
		const hits: CredentialHit[] = [];
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
		for (const { name } of tables) {
			const cols = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${name.replace(/'/g, "''")}')`).all().map((c) => c.name);
			const hasId = cols.includes("id");
			const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
			const rows = db.query<Record<string, unknown>, []>(`SELECT ${hasId ? "id" : "rowid"} AS __row, ${cols.map(q).join(", ")} FROM ${q(name)}`).all();
			for (const row of rows) {
				for (const col of cols) {
					const v = row[col];
					if (typeof v !== "string") continue;
					for (const p of CREDENTIAL_PATTERNS) {
						if (p.re.test(v)) hits.push({ snapshot, table: name, rowId: String(row.__row), column: col, pattern: p.name });
					}
				}
			}
		}
		return hits;
	} finally {
		db.close();
	}
}

interface Taken {
	name: string;
	source: string;
	now: string;
	bytes: Uint8Array;
}

/** The live ledger's own scheduled copies, as bytes, oldest first (PLAN § Which backups count). */
function backupCopies(live: string): Taken[] {
	const dir = join(dirname(live), "backups", backupNamespace(live));
	// Under test, the namespace, its SOURCE and every copy (a symlink included) are refused inside a live root before they are read.
	assertNotLiveLedgerUnderTest(dir);
	const sourceFile = join(dir, BACKUP_SOURCE_FILE);
	assertNotLiveLedgerUnderTest(sourceFile);
	const owner = readFileSync(sourceFile, "utf8").trim();
	if (owner !== live) throw new Error(`${sourceFile} names ${owner}, not the live ledger ${live}`);
	return readdirSync(dir)
		.flatMap((name) => {
			const m = BACKUP_NAME.exec(name);
			if (!m) return [];
			const now = `${m[1]}T${m[2]}:${m[3]}:${m[4]}`;
			const source = join(dir, name);
			assertNotLiveLedgerUnderTest(source);
			return [{ name: `backup-${stamp(now)}`, source, now, bytes: new Uint8Array(readFileSync(source)) }];
		})
		.sort((a, b) => (a.now < b.now ? -1 : a.now > b.now ? 1 : 0));
}

/** VACUUM INTO from a `readonly` connection on the live file: a consistent snapshot, WAL included. */
function liveCopy(live: string, tmp: string): Taken {
	const dest = join(tmp, "live.db");
	assertNotLiveLedgerUnderTest(live);
	const db = new Database(live, { readonly: true });
	let now: string;
	try {
		db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
		now = new Date().toISOString();
	} finally {
		db.close();
	}
	return { name: `live-${stamp(now)}`, source: live, now, bytes: new Uint8Array(readFileSync(dest)) };
}

export interface RefreezeResult {
	manifest: Manifest;
	lines: number;
	liveNewestEntry: string | null;
	hits: CredentialHit[];
	/** The previous fixture, when the swap succeeded but it could not be removed whole. */
	leftover: Leftover | null;
}

/** The previous fixture's dir after the swap, kept because `remaining` is still in it. */
export interface Leftover {
	path: string;
	/** Every entry left in `path` (`name/` for a subdirectory): what refreeze does not own, or could not remove. */
	remaining: string[];
}

/** Every entry of `dir`, a subdirectory as `name/`. */
function entryNames(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

/**
 * Throws naming every entry of `dir` a refreeze does not own; returns the names it owns, which
 * swapIn later removes from the previous fixture and nothing else. It owns `manifest.json`,
 * `golden.txt` and the `file` of each snapshot in the dir's current manifest.json: any other name,
 * a `.db.gz` the manifest does not list included, and every subdirectory, is refused. A dir with no
 * manifest.json is a first refreeze and must be empty (it owns nothing in it); a manifest.json
 * that does not parse is refused.
 */
export function assertOwnedOnly(dir: string): ReadonlySet<string> {
	if (!existsSync(dir)) return new Set();
	const entries = readdirSync(dir, { withFileTypes: true });
	const named = (e: (typeof entries)[number]) => (e.isDirectory() ? `${e.name}/` : e.name);
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) {
		if (entries.length > 0) {
			throw new Error(`refreeze replaces ${dir} whole and it has no manifest.json, so refreeze owns nothing in it; nothing written. Move these out first: ${entries.map(named).join(", ")}`);
		}
		return new Set();
	}
	const files: string[] = [];
	try {
		const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		const snapshots = manifest && typeof manifest === "object" && "snapshots" in manifest ? manifest.snapshots : undefined;
		if (!Array.isArray(snapshots)) throw new Error("no snapshots list");
		for (const s of snapshots) {
			const file = s && typeof s === "object" && "file" in s ? s.file : undefined;
			if (typeof file !== "string") throw new Error("a snapshot has no file name");
			files.push(file);
		}
	} catch (e) {
		throw new Error(`refreeze cannot tell which files of ${dir} it owns: ${manifestPath} does not parse (${e instanceof Error ? e.message : String(e)}); nothing written`);
	}
	const owned = new Set(["manifest.json", "golden.txt", ...files]);
	const unowned = entries.filter((e) => !e.isFile() || !owned.has(e.name)).map(named);
	if (unowned.length > 0) {
		throw new Error(`refreeze replaces ${dir} whole and owns only manifest.json, golden.txt and the files its manifest.json lists; nothing written. Move these out first: ${unowned.join(", ")}`);
	}
	return owned;
}

/**
 * Re-take the fixture: the live copy and the backups, each checked with copyProblem and the
 * credential scan in a temporary dir, deduplicated by SHA-256 (the live copy always keeps its own
 * snapshot and clock, sharing an earlier file when its bytes match). It refuses first if `dir`
 * holds anything it does not own. The replacement fixture and golden.txt are built and replayed in
 * a staging dir beside `dir`, then swapped in by swapIn, whose failure window that comment states;
 * any failure before the swap, or a scan hit, leaves `dir` as it was. The backups are read from
 * `backups/` beside the live file. `beforeSwap` runs after staging, just before the swap (a test
 * seam for an entry that appears after the ownership check).
 */
export function refreeze(
	livePath = defaultLedgerPath(),
	dir = FIXTURE_DIR,
	configPath = TIER_CONFIG_PATH,
	opts: { beforeSwap?: () => void } = {},
): RefreezeResult {
	const owned = assertOwnedOnly(dir);
	const { result, stage } = stageFixture(canonicalPath(livePath), dir, configPath);
	if (!stage) return { ...result, leftover: null };
	try {
		opts.beforeSwap?.();
		return { ...result, leftover: swapIn(stage, dir, owned) };
	} catch (e) {
		// beforeSwap and swapIn throw only before the swap, so the stage is still beside `dir`.
		rmSync(stage, { recursive: true, force: true });
		throw e;
	}
}

/** Build and replay the replacement fixture in a staging dir beside `dir`; no stage on a scan hit. */
function stageFixture(live: string, dir: string, configPath: string): { result: Omit<RefreezeResult, "leftover">; stage: string | null } {
	const tmp = mkdtempSync(join(tmpdir(), "ledger-refreeze-"));
	let stage: string | null = null;
	try {
		const liveTaken = liveCopy(live, tmp);
		const taken = [...backupCopies(live), liveTaken];
		const snapshots: SnapshotEntry[] = [];
		/** File name → unpacked bytes, one per distinct SHA-256. */
		const files = new Map<string, Uint8Array>();
		const hits: CredentialHit[] = [];
		for (const t of taken) {
			const sha = createHash("sha256").update(t.bytes).digest("hex");
			const same = snapshots.find((s) => s.sha256 === sha);
			if (same) {
				same.sameAs.push(t.source);
				if (t === liveTaken) snapshots.push({ name: t.name, file: same.file, source: t.source, sameAs: [], sha256: sha, now: t.now });
				continue;
			}
			const path = join(tmp, `${t.name}.db`);
			writeFileSync(path, t.bytes);
			const problem = copyProblem(path);
			if (problem) throw new Error(`${t.source} is not a complete ledger copy: ${problem}`);
			hits.push(...scanCredentials(path, t.name));
			snapshots.push({ name: t.name, file: `${t.name}.db.gz`, source: t.source, sameAs: [], sha256: sha, now: t.now });
			files.set(`${t.name}.db.gz`, t.bytes);
		}
		// The live copy passed copyProblem above, itself or as the backup with its bytes.
		const liveNewestEntry = newestEntry(join(tmp, "live.db"));
		const manifest: Manifest = { refrozenAt: liveTaken.now, snapshots };
		if (hits.length > 0) return { result: { manifest, lines: 0, liveNewestEntry, hits }, stage: null };
		mkdirSync(dirname(dir), { recursive: true });
		stage = mkdtempSync(join(dirname(dir), `.${basename(dir)}-stage-`));
		for (const [file, bytes] of files) writeFileSync(join(stage, file), Bun.gzipSync(bytes, { level: 9 }));
		writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		const lines = replayFixture(stage, configPath);
		assertCoverage(lines, snapshots.map((s) => s.name));
		writeFileSync(join(stage, "golden.txt"), renderGolden(lines));
		return { result: { manifest, lines: lines.length, liveNewestEntry, hits }, stage };
	} catch (e) {
		if (stage) rmSync(stage, { recursive: true, force: true });
		throw e;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function newestEntry(path: string): string | null {
	assertNotLiveLedgerUnderTest(path);
	const db = new Database(path, { readonly: true });
	try {
		return db.query<{ m: string | null }, []>("SELECT max(created_at) AS m FROM entries").get()!.m;
	} finally {
		db.close();
	}
}

/**
 * Replace `dir` with `stage`, a sibling, by two renames (rename(2) will not replace a non-empty
 * dir). This is not atomic. A failure before the swap leaves `dir` untouched: the old dir moves back
 * if the stage cannot move in, and an error names where it is if it cannot. An interruption between
 * the two renames leaves `dir` absent with the previous fixture at `<dir>.old-<ms>`; the fixture is
 * git-tracked, so `git status` shows it and git restores it. Nothing throws after the swap. The old
 * dir is never removed recursively: only the files named in `owned` (assertOwnedOnly's names) are
 * unlinked from it, then the dir itself is rmdir'd. Anything else, such as a file added after the
 * ownership check, stays in place with the dir, and the dir and every entry left in it are returned.
 */
function swapIn(stage: string, dir: string, owned: ReadonlySet<string>): Leftover | null {
	if (!existsSync(dir)) {
		renameSync(stage, dir);
		return null;
	}
	const old = `${dir}.old-${Date.now()}`;
	renameSync(dir, old);
	try {
		renameSync(stage, dir);
	} catch (e) {
		try {
			renameSync(old, dir);
		} catch {
			throw new Error(`${stage} could not move to ${dir} (${e instanceof Error ? e.message : String(e)}) and the previous fixture could not move back; it is at ${old}`);
		}
		throw e;
	}
	try {
		for (const e of readdirSync(old, { withFileTypes: true })) {
			if (!e.isFile() || !owned.has(e.name)) continue;
			try {
				unlinkSync(join(old, e.name));
			} catch {
				// Left in place; listed below.
			}
		}
		const remaining = entryNames(old);
		if (remaining.length > 0) return { path: old, remaining };
		rmdirSync(old);
		return null;
	} catch {
		let remaining: string[] = [];
		try {
			remaining = entryNames(old);
		} catch {
			// The dir cannot be listed; report its path alone.
		}
		return { path: old, remaining };
	}
}

// ---- CLI ----------------------------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);
	try {
		if (args.includes("--refreeze")) {
			const r = refreeze();
			if (r.hits.length > 0) {
				console.error(`refreeze stopped: ${r.hits.length} credential-shape hit(s); nothing written. Row ids (text not shown):`);
				for (const h of r.hits) console.error(`  ${h.snapshot} ${h.table} ${h.rowId} ${h.column}: ${h.pattern}`);
				process.exit(2);
			}
			for (const s of r.manifest.snapshots) {
				console.log(`snapshot ${s.name} sha256 ${s.sha256.slice(0, 12)} from ${basename(s.source)}${s.sameAs.length > 0 ? ` (same bytes: ${s.sameAs.map((p) => basename(p)).join(", ")})` : ""}`);
			}
			console.log(`live copy newest entries.created_at ${r.liveNewestEntry}`);
			console.log(`refreeze ok: ${r.manifest.snapshots.length} snapshot(s), ${r.lines} line(s) in ${GOLDEN_PATH}`);
			if (r.leftover) {
				const kept = r.leftover.remaining.length > 0 ? ` because it still holds ${r.leftover.remaining.join(", ")}, which refreeze does not own or could not remove` : "";
				console.warn(`warning: the new fixture is in place, but the previous one at ${r.leftover.path} was not removed${kept}; check it and delete it by hand`);
			}
		} else if (args.includes("--update")) {
			const lines = updateGolden();
			console.log(`update ok: ${lines} line(s) in ${GOLDEN_PATH}`);
		} else {
			const names = readManifest().snapshots.map((s) => s.name);
			const report = diffReport(diffLines(readFileSync(GOLDEN_PATH, "utf8"), replayFixture(), names));
			if (report) {
				console.error(report);
				process.exit(1);
			}
			console.log("ledger replay matches golden.txt");
		}
	} catch (e) {
		console.error(`ledger replay failed: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}
