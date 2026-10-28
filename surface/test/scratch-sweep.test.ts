// The daily scratch sweep (PLAN wl-mv5oikd5jtquww § 1.6), driven through its CLI
// (surface/scripts/scratch-sweep.ts) against a fake HOME, a temp ledger under it, and a fake /tmp:
// closed, unknown and idle-unheld (no holder, or a lapsed lease) roots are archived and then removed; a held
// root and a root with anything changed in 3 days are kept; a symlinked child and a plain file are refused and
// left alone, and a link inside a removed root is never followed. A root whose archive fails is kept. Archives
// past scratchArchive.expireDays are expired (with requireOffsite, only those with an `.offsite` marker). The
// report names every root, the archives, the remaining total, the free space and the legacy places, which are
// sized and never deleted. Over the threshold, or under scratchArchive.minFreeGib free, one `scratch-disk:`
// entry lands on the standing workload, once while open; back within bounds, `scratch-disk-ok:`.
// --dry-run removes and writes nothing; a missing ledger or a bad threshold removes nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_ENTRY, scratchBase } from "../../gates/src/scratch";
import { DEFAULT_SCRATCH_ARCHIVE, type ScratchArchiveConfig, scratchArchiveBase } from "../src/scratch-archive";
import { Ledger } from "../../ledger/src/index";
import { reportDir, sweep as runSweep } from "../scripts/scratch-sweep";
import { SCRATCH_SWEEP_BY } from "../src/launch";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { sh, tmp } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "scratch-sweep.ts");
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The one clock of this file: the ledger handles write with it, every lease and age is set from it, and every sweep runs at it
 * (--now, or the `now` argument). Nothing here depends on the wall clock.
 */
const FIXTURE_NOW = new Date("2026-10-28T04:30:00.000Z");
const FIXTURE_ISO = FIXTURE_NOW.toISOString();
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface World {
	home: string;
	base: string;
	outside: string;
	legacyTmp: string;
	ledgerPath: string;
	ledger: Ledger;
	/** The `scratchArchive:` config the CLI reads ($AGENT_SYSTEM_SCRATCH_CONFIG): no disk guard, so the machine's free space never decides a test. */
	config: string;
}

function world(): World {
	const home = realpathSync(tmp("sweep-home"));
	const outside = realpathSync(tmp("sweep-outside"));
	const legacyTmp = realpathSync(tmp("sweep-tmp"));
	dirs.push(home, outside, legacyTmp);
	const base = scratchBase(home);
	mkdirSync(base, { recursive: true });
	const ledgerPath = join(home, ".agent-system-2", "ledger.db");
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: () => FIXTURE_ISO });
	const config = join(home, "sweep-config.yml");
	writeFileSync(config, "scratchArchive:\n  expireDays: 14\n  requireOffsite: false\n  minFreeGib: 0\n");
	return { home, base, outside, legacyTmp, ledgerPath, ledger, config };
}

/** Direct-call args: the defaults but no disk guard (see World.config). */
const argsOf = (w: World, archive: Partial<ScratchArchiveConfig> = {}) => ({ dryRun: false, home: w.home, legacyTmp: w.legacyTmp, archive: { ...DEFAULT_SCRATCH_ARCHIVE, minFreeGib: 0, ...archive }, configNotes: [], now: FIXTURE_NOW });

/** A root with one file (and a nested one) under the base. */
function root(w: World, name: string): string {
	const r = join(w.base, name);
	mkdirSync(join(r, "repo", "src"), { recursive: true });
	writeFileSync(join(r, "repo", "src", "a.ts"), "x".repeat(4096));
	writeFileSync(join(r, "notes.md"), "notes");
	return r;
}

/** Every entry under `path` (itself included) set to `days` days before FIXTURE_NOW, deepest first (a directory's mtime moves when a child is written). */
function age(path: string, days: number): void {
	const t = new Date(FIXTURE_NOW.getTime() - days * DAY_MS);
	const walk = (p: string): void => {
		for (const e of readdirSync(p, { withFileTypes: true })) {
			if (e.isDirectory()) walk(join(p, e.name));
			else utimesSync(join(p, e.name), t, t);
		}
		utimesSync(p, t, t);
	};
	walk(path);
}

function sweep(w: World, args: string[] = [], env: Record<string, string | undefined> = {}) {
	const merged: Record<string, string | undefined> = { ...process.env, AGENT_SYSTEM_SCRATCH_TOTAL_MB: undefined, AGENT_SYSTEM_SCRATCH_CONFIG: w.config, ...env, AGENT_SYSTEM_LEDGER_DB: w.ledgerPath };
	const clean: Record<string, string> = {};
	for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
	return sh([process.execPath, SCRIPT, "--home", w.home, "--legacy-tmp", w.legacyTmp, "--now", FIXTURE_ISO, ...args], w.home, clean);
}

/** The disk entries the sweep wrote on the standing workload, oldest first. */
function diskEntries(w: World): string[] {
	if (!w.ledger.workload(STANDING_WORKLOAD_ID)) return [];
	return w.ledger.entries(STANDING_WORKLOAD_ID, "assumption")
		.filter((e) => e.created_by === SCRATCH_SWEEP_BY && (e.body.startsWith(SCRATCH_ENTRY.disk) || e.body.startsWith(SCRATCH_ENTRY.diskOk)))
		.map((e) => e.body);
}

const open = (w: World): string => w.ledger.openWorkload({ by: "lane-a", brief: "a lane's work", stakes: "normal", mode: "autonomous" });

describe("scratch sweep: which roots go", () => {
	const w = world();
	const closed = open(w);
	w.ledger.closeWorkload(closed, { by: "orchestrator-surface" });
	const idle = open(w);
	const lapsed = open(w);
	// Claimed through a handle whose clock is in the past: the lease lapsed long before the run.
	const past = Ledger.open(w.ledgerPath, { backup: false, backupOnOpen: false, clock: () => "2026-01-01T00:00:00.000Z" });
	past.claimWorkload(lapsed, { by: "lane-l", holder: "lane-l", leaseMs: 3_600_000 });
	past.close();
	const held = open(w);
	w.ledger.claimWorkload(held, { by: "lane-h", holder: "lane-h", leaseMs: 3_600_000 });
	const fresh = open(w);
	const unknown = "wl-zzznoworkload";

	const closedRoot = root(w, closed);
	// A link inside a removed root, pointing outside the base: removed as a link, never followed.
	writeFileSync(join(w.outside, "secret"), "keep");
	symlinkSync(w.outside, join(closedRoot, "escape"));
	root(w, unknown);
	age(root(w, idle), 4);
	age(root(w, lapsed), 4);
	age(root(w, held), 10);
	const freshRoot = root(w, fresh);
	age(freshRoot, 10);
	writeFileSync(join(freshRoot, "repo", "src", "new.ts"), "changed today"); // one deep change keeps the whole root
	const changed = new Date(FIXTURE_NOW.getTime() - 60 * 60 * 1000);
	utimesSync(join(freshRoot, "repo", "src", "new.ts"), changed, changed);
	// A symlinked child (named like a root of a closed workload) and a plain file: refused, left alone.
	mkdirSync(join(w.outside, "target"));
	writeFileSync(join(w.outside, "target", "data"), "keep");
	symlinkSync(join(w.outside, "target"), join(w.base, `${closed}x`));
	writeFileSync(join(w.base, "stray.txt"), "stray");
	// Legacy places: sized, never deleted.
	mkdirSync(join(w.legacyTmp, "wl-oldcopy"));
	writeFileSync(join(w.legacyTmp, "wl-oldcopy", "f"), "x".repeat(8192));
	mkdirSync(join(w.legacyTmp, "quorum-legs-7"));
	mkdirSync(join(w.legacyTmp, "unrelated"));
	mkdirSync(join(w.home, ".agent-system-2", "test-runs", "run-1"), { recursive: true });
	writeFileSync(join(w.home, ".agent-system-2", "test-runs", "run-1", "log"), "log");

	test("the lapsed claim's lease ended before the run; the held one's lease runs past it", () => {
		expect(w.ledger.workload(lapsed)!.holder_lease_until).toBe("2026-01-01T01:00:00.000Z");
		expect(w.ledger.workload(held)!.holder_lease_until).toBe("2026-10-28T05:30:00.000Z");
	});

	test("closed, unknown, idle-unheld and lapsed roots are removed; held and fresh kept; symlink and file refused", () => {
		const r = sweep(w, [], { AGENT_SYSTEM_SCRATCH_TOTAL_MB: "0" });
		expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
		const left = readdirSync(w.base).sort();
		expect(left).toEqual([`${closed}x`, fresh, held, "stray.txt"].sort());
		// nothing outside the base was touched, through either link
		expect(readFileSync(join(w.outside, "secret"), "utf8")).toBe("keep");
		expect(readFileSync(join(w.outside, "target", "data"), "utf8")).toBe("keep");
		expect(existsSync(join(freshRoot, "repo", "src", "new.ts"))).toBe(true);
		// legacy places stay
		expect([existsSync(join(w.legacyTmp, "wl-oldcopy", "f")), existsSync(join(w.home, ".agent-system-2", "test-runs", "run-1", "log"))]).toEqual([true, true]);
	});

	test("each removed root was archived first, outside the base, and recorded as scratch-archived: on the standing workload", () => {
		const archives = readdirSync(scratchArchiveBase(w.home)).flatMap((day) => readdirSync(join(scratchArchiveBase(w.home), day)).map((n) => join(scratchArchiveBase(w.home), day, n)));
		expect(archives.map((p) => p.split("/").at(-1)!).sort()).toEqual([closed, unknown, idle, lapsed].map((n) => `${n}.tar.gz`).sort());
		const recorded = w.ledger.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.body.startsWith(SCRATCH_ENTRY.archived));
		expect(recorded.map((e) => e.created_by)).toEqual([SCRATCH_SWEEP_BY, SCRATCH_SWEEP_BY, SCRATCH_SWEEP_BY, SCRATCH_SWEEP_BY]);
		for (const p of archives) expect(recorded.some((e) => e.body.includes(` ${p} `))).toBe(true);
		const closedArchive = archives.find((p) => p.endsWith(`/${closed}.tar.gz`))!;
		const listed = Bun.spawnSync(["tar", "-tzf", closedArchive], { stdout: "pipe" }).stdout.toString();
		expect(listed).toContain("./repo/src/a.ts");
		expect(listed).toContain("./escape");
		// the link inside was archived as a link: the file it points at is not in the archive
		expect(listed).not.toContain("secret");
	});

	test("the report names every root with its size and action, the remaining total and the legacy places", () => {
		// The sweep names its report by the date in its own process's zone; bun test runs in UTC, so read what it wrote.
		const reports = readdirSync(reportDir(w.home)).filter((n) => n.endsWith(".md"));
		expect(reports.length).toBe(1);
		const path = join(reportDir(w.home), reports[0]!);
		const report = readFileSync(path, "utf8");
		const rows = report.split("\n");
		const row = (name: string): string => rows.find((l) => l.startsWith(`| ${name} |`)) ?? `no row for ${name}`;
		expect(row(closed)).toMatch(/^\| wl-\S+ \| \d+ \| removed \| workload closed at /);
		expect(row(unknown)).toMatch(/\| \d+ \| removed \| no workload has this id \|$/);
		expect(row(idle)).toMatch(/\| \d+ \| removed \| open, no holder, nothing changed since .* \(over 3 days\) \|$/);
		expect(row(lapsed)).toMatch(/\| removed \| open, lease of lane-l lapsed at /);
		expect(row(held)).toMatch(/\| \d+ \| kept \| open, held by lane-h \(lease until /);
		expect(row(fresh)).toMatch(/\| \d+ \| kept \| open, no holder, changed within 3 days /);
		expect(row(`${closed}x`)).toMatch(/\| - \| refused \| a symlink \(→ .*target\); never followed, never removed \|$/);
		expect(row("stray.txt")).toBe("| stray.txt | - | refused | not a directory; left alone |");
		expect(rows.some((l) => /^- total under the base: \d+ KiB \(\d+\.\d MiB\), over 0 MiB$/.test(l))).toBe(true);
		expect(row(join(w.legacyTmp, "wl-oldcopy"))).toMatch(/^\| \S+wl-oldcopy \| \d+ \|$/);
		expect(row(join(w.legacyTmp, "quorum-legs-7"))).toMatch(/\| \d+ \|$/);
		expect(row(join(w.home, ".agent-system-2", "test-runs"))).toMatch(/\| \d+ \|$/);
		expect(report).not.toContain("unrelated");
	});

	test("over the threshold: one scratch-disk: entry on the standing workload, and only one while it is open", () => {
		const first = diskEntries(w);
		expect(first.length).toBe(1);
		expect(first[0]!).toMatch(new RegExp(`^scratch-disk: \\d+\\.\\d MiB under ${w.base} passes 0 MiB \\(AGENT_SYSTEM_SCRATCH_TOTAL_MB\\); report \\S+\\.md$`));
		const again = sweep(w, [], { AGENT_SYSTEM_SCRATCH_TOTAL_MB: "0" });
		expect(again.code).toBe(0);
		expect(again.out).toContain("already open");
		expect(diskEntries(w)).toEqual(first);
	});

	test("under the threshold (the default): scratch-disk-ok: clears it, once", () => {
		const r = sweep(w);
		expect(r.code).toBe(0);
		const after = diskEntries(w);
		expect(after.length).toBe(2);
		expect(after[1]!).toMatch(new RegExp(`^scratch-disk-ok: \\d+\\.\\d MiB under ${w.base}, at or under 10240 MiB; report `));
		expect(sweep(w).code).toBe(0);
		expect(diskEntries(w)).toEqual(after);
		// the kept roots are still kept on every later run
		expect(readdirSync(w.base).sort()).toEqual([`${closed}x`, fresh, held, "stray.txt"].sort());
	});
});

describe("scratch sweep: what it never does", () => {
	test("--dry-run removes nothing and writes no report and no entry", () => {
		const w = world();
		const closed = open(w);
		w.ledger.closeWorkload(closed, { by: "orchestrator-surface" });
		root(w, closed);
		const r = sweep(w, ["--dry-run"], { AGENT_SYSTEM_SCRATCH_TOTAL_MB: "0" });
		expect(r.code).toBe(0);
		expect(existsSync(join(w.base, closed, "notes.md"))).toBe(true);
		expect(r.out).toContain(`| ${closed} |`);
		expect(r.out).toContain("would remove");
		expect(existsSync(reportDir(w.home))).toBe(false);
		expect(w.ledger.workload(STANDING_WORKLOAD_ID)).toBeNull();
		expect(existsSync(scratchArchiveBase(w.home))).toBe(false);
	});

	test("an unreadable ledger removes nothing: no root's fate is guessed", () => {
		const w = world();
		w.ledger.close();
		rmSync(w.ledgerPath);
		root(w, "wl-zzzgone");
		const r = sweep(w);
		expect(r.code).toBe(1);
		expect(existsSync(join(w.base, "wl-zzzgone", "notes.md"))).toBe(true);
		expect(r.out).toContain("could not be read");
	});

	test("a bad threshold or an unknown argument is refused with exit 2 before anything runs", () => {
		const w = world();
		root(w, "wl-zzzunknown");
		expect(sweep(w, [], { AGENT_SYSTEM_SCRATCH_TOTAL_MB: "lots" }).code).toBe(2);
		expect(sweep(w, ["--everything"]).code).toBe(2);
		expect(existsSync(join(w.base, "wl-zzzunknown", "notes.md"))).toBe(true);
		expect(existsSync(reportDir(w.home))).toBe(false);
	});

	test("R2: a claim committed before the sweep's removal transaction keeps the root", () => {
		const w = world();
		const wl = open(w);
		age(root(w, wl), 4);
		const r = runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, FIXTURE_NOW, {
			beforeRemove: (name) => {
				if (name === wl) w.ledger.claimWorkload(wl, { by: "lane-r", holder: "lane-r", leaseMs: 3_600_000 });
			},
		});
		expect(existsSync(join(w.base, wl, "notes.md"))).toBe(true);
		const line = r.roots.find((x) => x.name === wl);
		expect(line?.action).toBe("kept");
		expect(line?.why).toContain("now held by lane-r");
		expect(r.exit).toBe(0);
	});

	test("R2: a claim attempted inside the sweep's removal transaction cannot take the write lock (SQLITE_BUSY with no wait), and wins once the sweep returns", () => {
		const w = world();
		const wl = open(w);
		age(root(w, wl), 4);
		// A lane's handle that neither waits nor retries on a busy ledger: a claim that cannot take the write lock fails at once.
		const lane = Ledger.open(w.ledgerPath, { backup: false, backupOnOpen: false, busyTimeoutMs: 0, busyRetries: 0 });
		const claim = () => lane.claimWorkload(wl, { by: "lane-r", holder: "lane-r", leaseMs: 3_600_000 });
		let during = "the seam was not reached";
		try {
			const r = runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, FIXTURE_NOW, {
				inLock: (name) => {
					if (name !== wl) return;
					try {
						during = `the claim ran: ${JSON.stringify(claim())}`;
					} catch (e) {
						during = e instanceof Error && "code" in e ? String(e.code) : String(e);
					}
				},
			});
			expect(during).toBe("SQLITE_BUSY");
			expect(r.roots.find((x) => x.name === wl)?.action).toBe("removed");
			expect(existsSync(join(w.base, wl))).toBe(false);
			expect(r.exit).toBe(0);
			// After the sweep's transaction: the claim takes the lock and wins (the claiming side re-creates the root).
			expect(claim()).toEqual({ won: true });
		} finally {
			lane.close();
		}
	});

	test("a leftover .removing-* idle for 3 days is archived like a root (its name proves nothing) and then removed; a fresh one is left alone", () => {
		const w = world();
		const oldLeft = join(w.base, ".removing-wl-gone-0123456789abcdef");
		mkdirSync(join(oldLeft, "deep"), { recursive: true });
		writeFileSync(join(oldLeft, "deep", "f"), "x");
		age(oldLeft, 4);
		const freshLeft = join(w.base, ".removing-wl-busy-fedcba9876543210");
		mkdirSync(freshLeft);
		writeFileSync(join(freshLeft, "f"), "x");
		age(freshLeft, 0.05);
		const r = sweep(w);
		expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
		expect(readdirSync(w.base)).toEqual([".removing-wl-busy-fedcba9876543210"]);
		expect(r.out).toMatch(/\| \.removing-wl-gone-0123456789abcdef \| \d+ \| removed \| a removal leftover, nothing changed since .* \(over 3 days\) \|/);
		expect(r.out).toMatch(/\| \.removing-wl-busy-fedcba9876543210 \| \d+ \| kept \| a removal leftover or in progress, changed within 3 days /);
		const archive = join(scratchArchiveBase(w.home), "2026-10-28", "removing-wl-gone-0123456789abcdef.tar.gz");
		const listed = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe" }).stdout.toString();
		expect(listed).toContain("./deep/f");
		expect(w.ledger.entries(STANDING_WORKLOAD_ID, "assumption").some((e) => e.body.startsWith(`${SCRATCH_ENTRY.archived} .removing-wl-gone-0123456789abcdef ${archive} `))).toBe(true);
	});

	test("a write into the detached tree before the final check fails that root's archive: it is renamed back, kept, and the other roots still go", () => {
		const w = world();
		const a = open(w);
		const b = open(w);
		w.ledger.closeWorkload(a, { by: "orchestrator-surface" });
		w.ledger.closeWorkload(b, { by: "orchestrator-surface" });
		root(w, a);
		root(w, b);
		const r = runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, FIXTURE_NOW, {
			archive: (name) =>
				name !== a
					? {}
					: {
							beforeFinalCheck: () => {
								const d = readdirSync(w.base).find((n) => n.startsWith(".removing-"))!;
								writeFileSync(join(w.base, d, "notes.md"), "NOTES");
							},
						},
		});
		expect(r.exit).toBe(1);
		expect(readFileSync(join(w.base, a, "notes.md"), "utf8")).toBe("NOTES");
		const line = r.roots.find((x) => x.name === a)!;
		expect(line.action).toBe("archive failed");
		expect(line.why).toContain("changed while it was archived: ./notes.md ");
		expect(line.why).toContain(`kept, renamed back to ${join(w.base, a)}`);
		expect(existsSync(join(w.base, b))).toBe(false);
		expect(r.roots.find((x) => x.name === b)!.action).toBe("removed");
		expect(readdirSync(join(scratchArchiveBase(w.home), "2026-10-28"))).toEqual([`${b}.tar.gz`]);
	});
});

describe("scratch sweep: archives (expiry, offsite gate, failures) and the disk guard", () => {
	/** The file's clock: every age below is set relative to it, never to the wall clock. */
	const NOW = FIXTURE_NOW;
	/** An archive file `days` days older than NOW, under the archive base's date directory `day`. */
	function archiveAt(w: World, day: string, name: string, days: number): string {
		const dir = join(scratchArchiveBase(w.home), day);
		mkdirSync(dir, { recursive: true });
		const p = join(dir, name);
		writeFileSync(p, "gz");
		const t = new Date(NOW.getTime() - days * DAY_MS);
		utimesSync(p, t, t);
		return p;
	}
	const expiredEntries = (w: World): string[] =>
		w.ledger.workload(STANDING_WORKLOAD_ID) ? w.ledger.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.body.startsWith(SCRATCH_ENTRY.archiveExpired)).map((e) => `${e.created_by} ${e.body}`) : [];

	test("expiry removes only archives older than expireDays, records each, and removes a date directory it emptied", () => {
		const w = world();
		const old1 = archiveAt(w, "2026-10-01", "wl-aaold.tar.gz", 27);
		const old2 = archiveAt(w, "2026-10-13", "wl-bbold.tar.gz", 15);
		const young = archiveAt(w, "2026-10-13", "wl-ccyoung.tar.gz", 13);
		const today = archiveAt(w, "2026-10-28", "wl-ddtoday.tar.gz", 0);
		const stray = archiveAt(w, "2026-10-01", "notes.txt", 40);
		const r = runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(r.exit).toBe(0);
		expect([existsSync(old1), existsSync(old2), existsSync(young), existsSync(today), existsSync(stray)]).toEqual([false, false, true, true, true]);
		expect(r.expired.filter((l) => l.action === "expired").map((l) => l.path)).toEqual([old1, old2]);
		expect(expiredEntries(w)).toEqual([`${SCRATCH_SWEEP_BY} ${SCRATCH_ENTRY.archiveExpired} ${old1} 2`, `${SCRATCH_SWEEP_BY} ${SCRATCH_ENTRY.archiveExpired} ${old2} 2`]);
		// 2026-10-01 still holds the stray file (never an archive, never touched); 2026-10-13 still holds the young one.
		expect(readdirSync(scratchArchiveBase(w.home)).sort()).toEqual(["2026-10-01", "2026-10-13", "2026-10-28"]);
		expect(r.report).toMatch(new RegExp(`\\| ${old1.replace(/[.]/g, "\\.")} \\| 2 \\| expired \\| 27\\.0 days old, over 14 \\|`));
		// A shorter expireDays reaches the younger ones; an emptied date directory goes.
		const again = runSweep(argsOf(w, { expireDays: 10 }), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(again.expired.filter((l) => l.action === "expired").map((l) => l.path)).toEqual([young]);
		expect(readdirSync(scratchArchiveBase(w.home)).sort()).toEqual(["2026-10-01", "2026-10-28"]);
	});

	test("the cutoff: an archive exactly expireDays old is kept, one a second older expires", () => {
		const w = world();
		const at = archiveAt(w, "2026-10-14", "wl-aaat.tar.gz", 14);
		const over = archiveAt(w, "2026-10-14", "wl-bbover.tar.gz", 14 + 1 / 86_400);
		runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect([existsSync(at), existsSync(over)]).toEqual([true, false]);
	});

	test("names are classified exactly: a final whose name holds `.tar.gz.partial-` keeps its offsite gate, only the writer's exact partial suffix is a partial, other names are never touched", () => {
		const w = world();
		const trickyFinal = archiveAt(w, "2026-10-01", "analysis.tar.gz.partial-notes.tar.gz", 27);
		const realPartial = archiveAt(w, "2026-10-01", "wl-aa.tar.gz.partial-abcdef012345", 27);
		const notPartial = archiveAt(w, "2026-10-01", "notes.tar.gz.partial-draft.txt", 27);
		const upperHex = archiveAt(w, "2026-10-01", "wl-bb.tar.gz.partial-ABCDEF012345", 27);
		const marker = archiveAt(w, "2026-10-01", "wl-cc.tar.gz.partial-abcdef012345.offsite", 27);
		const r = runSweep(argsOf(w, { requireOffsite: true }), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(r.exit).toBe(0);
		expect([existsSync(trickyFinal), existsSync(realPartial), existsSync(notPartial), existsSync(upperHex), existsSync(marker)]).toEqual([true, false, true, true, true]);
		expect(r.expired.find((l) => l.path === trickyFinal)?.why).toContain("no .offsite marker (requireOffsite)");
		expect(r.expired.find((l) => l.path === realPartial)?.why).toContain("(a partial archive)");
	});

	test("an expired archive takes its offsite sidecars (.offsite, .attempts, .stuck) with it; a sidecar whose archive is gone is never touched", () => {
		const w = world();
		const a = archiveAt(w, "2026-10-01", "wl-aa.tar.gz", 27);
		for (const s of [".offsite", ".attempts", ".stuck"]) writeFileSync(`${a}${s}`, "x");
		const orphan = archiveAt(w, "2026-10-01", "wl-gone.tar.gz.offsite", 27);
		runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(readdirSync(join(scratchArchiveBase(w.home), "2026-10-01"))).toEqual(["wl-gone.tar.gz.offsite"]);
		expect(existsSync(orphan)).toBe(true);
	});

	test("a verification copy left behind is reported, never removed by expiry", () => {
		const w = world();
		const copy = join(scratchArchiveBase(w.home), "2026-10-01", ".verify-0123456789abcdef");
		mkdirSync(copy, { recursive: true });
		writeFileSync(join(copy, "f"), "x");
		const r = runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(existsSync(join(copy, "f"))).toBe(true);
		expect(r.report).toContain(`${copy} is a verification copy an archive run left behind; not removed (remove it by hand)`);
	});

	test("too little free space for an archive refuses before tar runs: the root is kept, renamed back", () => {
		const w = world();
		const closed = open(w);
		w.ledger.closeWorkload(closed, { by: "orchestrator-surface" });
		root(w, closed);
		const r = runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW, { archive: () => ({ freeBytes: () => 1024 }) });
		expect(r.exit).toBe(1);
		const line = r.roots.find((x) => x.name === closed)!;
		expect(line.action).toBe("archive failed");
		expect(line.why).toContain("so the archive was not started");
		expect(existsSync(join(w.base, closed, "repo", "src", "a.ts"))).toBe(true);
	});

	test("requireOffsite: an old archive without its .offsite marker is kept; one with it is expired with its marker", () => {
		const w = world();
		const unconfirmed = archiveAt(w, "2026-10-01", "wl-aanomark.tar.gz", 27);
		const confirmed = archiveAt(w, "2026-10-01", "wl-bbmark.tar.gz", 27);
		writeFileSync(`${confirmed}.offsite`, "drive:/as2/wl-bbmark.tar.gz");
		const r = runSweep(argsOf(w, { requireOffsite: true }), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(r.exit).toBe(0);
		expect([existsSync(unconfirmed), existsSync(confirmed), existsSync(`${confirmed}.offsite`)]).toEqual([true, false, false]);
		expect(r.expired.find((l) => l.path === unconfirmed)?.why).toContain("no .offsite marker (requireOffsite)");
		expect(expiredEntries(w)).toEqual([`${SCRATCH_SWEEP_BY} ${SCRATCH_ENTRY.archiveExpired} ${confirmed} 2`]);
		// Off (the default), plain age expiry takes the unconfirmed one too.
		runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(existsSync(unconfirmed)).toBe(false);
	});

	test("a root whose archive fails is kept, whole, and the run exits 1", () => {
		const w = world();
		const closed = open(w);
		w.ledger.closeWorkload(closed, { by: "orchestrator-surface" });
		root(w, closed);
		writeFileSync(scratchArchiveBase(w.home), "not a directory");
		const r = runSweep(argsOf(w), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW);
		expect(r.exit).toBe(1);
		expect(existsSync(join(w.base, closed, "repo", "src", "a.ts"))).toBe(true);
		const line = r.roots.find((x) => x.name === closed)!;
		expect(line.action).toBe("archive failed");
		expect(line.why).toMatch(/^workload closed at .*; not archived \(.+\); kept, renamed back to \S+$/);
		expect(r.archived).toEqual([]);
	});

	test("the disk guard: free space under minFreeGib opens one scratch-disk: naming it; back over, scratch-disk-ok: clears it", () => {
		const w = world();
		const GIB = 1024 ** 3;
		const low = runSweep(argsOf(w, { minFreeGib: 20 }), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW, { freeBytes: () => 5 * GIB });
		expect(low.exit).toBe(0);
		expect(diskEntries(w)).toHaveLength(1);
		expect(diskEntries(w)[0]!).toMatch(new RegExp(`^scratch-disk: 5\\.0 GiB free on the volume of ${w.base}, under 20 GiB \\(scratchArchive\\.minFreeGib\\); report \\S+\\.md$`));
		expect(low.report).toContain("- free on the scratch volume: 5.0 GiB, under 20 GiB");
		runSweep(argsOf(w, { minFreeGib: 20 }), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW, { freeBytes: () => 6 * GIB });
		expect(diskEntries(w)).toHaveLength(1);
		const ok = runSweep(argsOf(w, { minFreeGib: 20 }), { AGENT_SYSTEM_LEDGER_DB: w.ledgerPath }, 10240, NOW, { freeBytes: () => 25 * GIB });
		expect(ok.exit).toBe(0);
		expect(diskEntries(w)).toHaveLength(2);
		expect(diskEntries(w)[1]!).toStartWith("scratch-disk-ok: ");
	});

	test("the CLI reads scratchArchive from $AGENT_SYSTEM_SCRATCH_CONFIG; a malformed key falls back to its default with a report note", () => {
		const w = world();
		writeFileSync(w.config, "scratchArchive:\n  expireDays: soon\n  minFreeGib: 0\n");
		const r = sweep(w);
		expect(r.code).toBe(0);
		expect(r.out).toContain('- note: scratchArchive.expireDays "soon" is not a non-negative number; 14 used');
		expect(r.out).toContain(`- archives: ${scratchArchiveBase(w.home)}; expire after 14 days; disk guard under 0 GiB free`);
	});
});
