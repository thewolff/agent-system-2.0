// surface/scripts/invariants.ts over the fixture ledger (surface/test/fixtures/invariants/build.ts):
// the four scenarios the port had to get right — an orphan review hand whose lane is dead (dead-lane
// and orphan-hand), a reserved request whose lane stopped holding (stale-reserved must NOT fire:
// the false positive Plumb's watcher raised), a question open past 30 min (fires) and an orchestrator
// silent 3 h (fires with a lane alive, not without); replay semantics; a hung lane with and without a
// process; refusal evidence landing after as-of; failed process probes (a skip, never a dead lane or
// a lull); the git invariants over a real temp checkout behind, ahead of, level with and diverged from
// its origin; and the CLI (--json, --reviews, a bad argument, the checked-in fixture from the repo).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { backupNamespace, copyProblem, Ledger } from "../../ledger/src/index";
import { canonicalPath } from "../../ledger/src/locality";
import { laneExitBody } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { reservedStates } from "../src/errors";
import { BACKUP_GAP_MS, check, gitIn, type Git, type Input, jsonLines, newestWrite, orchestratorsFromPs, parseArgs, type Probe, type PsDeps, renderTable, type Report, reservedView, reviewsLine, type Run } from "../scripts/invariants";
import { AS_OF, buildFixture, LANE_RUNNER } from "./fixtures/invariants/build";

const SCRIPT = join(import.meta.dir, "..", "scripts", "invariants.ts");
const CHECKED_IN = join(import.meta.dir, "fixtures", "invariants", "ledger.db");

const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `invariants-${tag}-`));
const fixture = buildFixture(join(tmp("ledger"), "ledger.db"));
const db = new Database(fixture.path, { readonly: true });
/** A backup directory holding complete copies of the fixture ledger named like the job's copies: stale-backup reads a copy's time from its name and counts it only if copyProblem accepts it. */
const copiesIn = (tag: string, ...names: string[]) => {
	const dir = tmp(tag);
	for (const n of names) copyFileSync(fixture.path, join(dir, n));
	return dir;
};
/** A SQLite file that opens and passes integrity_check but is not at the ledger's schema version: copyProblem rejects it. */
const wrongVersion = (path: string) => {
	const d = new Database(path);
	d.run("CREATE TABLE t (x)");
	d.close();
};
// The fixture writes from 18:00 to 20:50. run() reads a directory whose newest copy (20:55) follows every write.
const freshBackups = copiesIn("backups-fresh", "ledger-2026-10-10T12-00-00.000Z.db", "ledger-2026-10-11T20-55-00.000Z.db");
afterAll(() => db.close());

const live = (...lanes: string[]): Probe<Set<string>> => ({ found: new Set(lanes) });
const noProbe: Probe<never> = { skipped: "the probe was not run in this test" };
const noProcs: Input["orchestrators"] = () => ({ found: [] });
const noGit: Pick<Input, "repo" | "git" | "orchestrators"> = { repo: "/nonexistent/checkout", git: null, orchestrators: () => noProbe };
function run(over: Partial<Input> = {}): Report {
	return check({
		db, asOf: AS_OF, replay: true, liveLanes: live(`${fixture.waiting.wl} ${fixture.waiting.lane}`), lanesDirOf: () => "/nonexistent/lanes", ...noGit,
		backups: { dir: freshBackups, gapMs: BACKUP_GAP_MS }, ...over,
	});
}
const keys = (r: Report) => r.findings.map((f) => f.key);
const skipsOf = (r: Report, invariant: string) => r.skipped.filter((s) => s.invariant === invariant).map((s) => s.skipped);

describe("the ledger invariants over the fixture (as-of, one lane alive)", () => {
	const r = run();

	test("a lane with no exit, no process and 20 min of silence is a dead lane, and its unsettled review hand is an orphan (the dead-lane case)", () => {
		expect(keys(r)).toContain(`dead-lane:${fixture.deadLane.lane}`);
		const orphan = r.findings.find((f) => f.key === `orphan-hand:${fixture.deadLane.token}`)!;
		expect(orphan.workload).toBe(fixture.deadLane.wl);
		expect(orphan.text).toContain("is dead: no lane-exit, no lane.ts process");
		expect(orphan.text).toContain("builderLabs counts its whole row as builders: openai/gpt-6-astra");
		// A lane with a lane-exit is not dead, and a lane that is alive is not dead.
		expect(keys(r).filter((k) => k.startsWith("dead-lane:"))).toEqual([`dead-lane:${fixture.deadLane.lane}`]);
	});

	test("a reserved request whose lane released the workload is lane-stopped (surface/src/errors.ts reservedStates), not stale", () => {
		const states = reservedStates(reservedView(db), fixture.stopped.wl);
		expect(states.map((s) => [s.id, s.state.kind])).toEqual([[fixture.stopped.request, "lane-stopped"]]);
		expect(keys(r)).not.toContain(`stale-reserved:${fixture.stopped.request}`);
	});

	test("a reserved request older than 30 min whose lane still holds the workload is stale", () => {
		expect(reservedStates(reservedView(db), fixture.waiting.wl).map((s) => s.state.kind)).toEqual(["waiting"]);
		const f = r.findings.find((x) => x.key === `stale-reserved:${fixture.waiting.request}`)!;
		expect(f.workload).toBe(fixture.waiting.wl);
		expect(f.since).toBe("2026-10-11T19:00:00.000Z");
		expect(f.text).toContain("has waited 2.0 h");
		expect(f.query).toContain("reservedStates");
	});

	test("a question open for more than 30 min is stuck; an answered one is not", () => {
		const f = r.findings.find((x) => x.key === `stuck-question:${fixture.waiting.question}`)!;
		expect(f.text).toContain("has been open 90 min");
		expect(keys(r)).not.toContain(`stuck-question:${fixture.waiting.answered}`);
	});

	test("an orchestrator silent for 2 h while a lane is alive is flagged; with no lane alive it is not", () => {
		const f = r.findings.find((x) => x.invariant === "silent-orchestrator")!;
		expect(f.workload).toBe("wl-orchestrator");
		expect(f.text).toContain("has written nothing for 3.0 h while 1 lane(s) are alive");
		expect(run({ liveLanes: live() }).findings.some((x) => x.invariant === "silent-orchestrator")).toBe(false);
	});

	test("two lanes dying on a provider refusal within 30 min are one loop finding", () => {
		const f = r.findings.find((x) => x.invariant === "provider-refusal-loop")!;
		expect(f.key).toBe(`provider-refusal-loop:${fixture.refusal.wl}:${fixture.refusal.lanes[0]}`);
		expect(f.text).toContain(`(${fixture.refusal.lanes.join(", ")})`);
		expect(r.findings.filter((x) => x.invariant === "provider-refusal-loop")).toHaveLength(1);
	});

	test("every lane carries a builder-lab entry and the hand row leaves a lab free, so no workload loses its independent lab", () => {
		expect(keys(r).filter((k) => k.startsWith("no-independent-lab:"))).toEqual([]);
	});

	test("replay skips the three git/process invariants with the reason, and the report says so", () => {
		for (const i of ["checkout-behind-main", "process-older-than-head", "ff-lull"]) expect(skipsOf(r, i)).toEqual([expect.stringContaining("replay (--as-of)")]);
		expect(renderTable(r)).toContain("[checkout-behind-main] skipped: replay");
		expect(renderTable(r)).toContain("6 finding(s): dead-lane=1 silent-lane=0 leaked-runner=0 orphan-hand=1"); // + stale-reserved, stuck-question, provider-refusal-loop, silent-orchestrator
	});
});

describe("liveness", () => {
	test("in replay a process alive now counts only when its lane had started by as-of", () => {
		const r = run({ liveLanes: live(`${fixture.waiting.wl} ${fixture.waiting.lane}`, "wl-fixture-waiting lane-fixture-waiting-9") });
		expect(r.liveLanes).toEqual([`${fixture.waiting.wl} ${fixture.waiting.lane}`]);
	});

	test("a live dead-lane candidate is not dead, and its review hand is in flight", () => {
		const r = run({ liveLanes: live(`${fixture.deadLane.wl} ${fixture.deadLane.lane}`) });
		expect(keys(r)).not.toContain(`dead-lane:${fixture.deadLane.lane}`);
		expect(keys(r)).not.toContain(`orphan-hand:${fixture.deadLane.token}`);
		expect(r.reviewsInFlight).toEqual([fixture.deadLane.token]);
		expect(reviewsLine(r)).toBe(`lanes-alive 1 reviews-in-flight 1 tokens ${fixture.deadLane.token}`);
		// The review hand spawned at 18:30 is 2.5 h unsettled while its lane is alive: stuck.
		expect(keys(r)).toContain(`stuck-review:${fixture.deadLane.token}`);
	});

	test("with no process table, dead-lane, silent-lane, stuck-review and silent-orchestrator are skipped with the probe's reason, orphan review hands are listed", () => {
		const r = run({ liveLanes: { skipped: "pgrep -fl … exited 2: pgrep: cannot read /proc" } });
		for (const i of ["dead-lane", "silent-lane", "stuck-review", "silent-orchestrator"]) expect(skipsOf(r, i)).toEqual([expect.stringContaining("pgrep: cannot read /proc")]);
		expect(keys(r).some((k) => k.startsWith("dead-lane:") || k.startsWith("stuck-review:") || k.startsWith("silent-orchestrator:"))).toBe(false);
		expect(r.liveLanes).toBeNull();
		expect(r.orphanReviews).toEqual([fixture.deadLane.token]);
		expect(reviewsLine(r)).toBe(`lanes-alive unknown reviews-in-flight 0 orphan-reviews ${fixture.deadLane.token}`);
	});

	test("refusal evidence that landed after as-of is not read: two exits before the cutoff with their evidence after it are quiet", () => {
		// Two lanes exit on error at 19:30 and 19:50; each refusal note lands one minute after its exit.
		const copy = buildFixture(join(tmp("late"), "ledger.db"));
		let now = "2026-10-11T19:20:00.000Z";
		const w = Ledger.open(copy.path, { backup: false, backupOnOpen: false, clock: () => now, skipLocalityCheck: true });
		const wl = w.openWorkload({ by: "orchestrator", brief: "late evidence", stakes: "normal", mode: "autonomous", id: "wl-fixture-late" });
		for (const [lane, exitAt, noteAt] of [["lane-fixture-late-1", "19:30", "19:31"], ["lane-fixture-late-2", "19:50", "19:51"]] as const) {
			now = `2026-10-11T${exitAt}:00.000Z`;
			w.recordEntry({ by: LANE_RUNNER, workloadId: wl, kind: "assumption", body: laneExitBody(lane, { code: 1, signal: null, outcome: "error" }) });
			now = `2026-10-11T${noteAt}:00.000Z`;
			w.recordEntry({ by: lane, workloadId: wl, kind: "assumption", body: "prompt error: non-retryable: the request violates the usage policy" });
		}
		w.close();
		const ro = new Database(copy.path, { readonly: true });
		try {
			const loop = (asOf: string) => run({ db: ro, asOf }).findings.filter((f) => f.key === "provider-refusal-loop:wl-fixture-late:lane-fixture-late-1");
			expect(loop("2026-10-11T19:50:30.000Z")).toHaveLength(0); // the second exit is in, its evidence is not
			expect(loop("2026-10-11T19:51:00.000Z")).toHaveLength(1); // the moment the evidence lands, the loop shows
		} finally {
			ro.close();
		}
	});
});

describe("silent-lane: alive, lease held, nothing written for 45 min", () => {
	/** A lane directory whose newest file was written at `iso` (a transcript under sessions/, like the launcher's). */
	const laneDirWrittenAt = (iso: string): string => {
		const dir = tmp("lanes");
		mkdirSync(join(dir, "sessions"), { recursive: true });
		for (const [name, at] of [["system.md", "2026-10-11T18:06:00.000Z"], ["sessions/s1.jsonl", iso]] as const) {
			const p = join(dir, name);
			writeFileSync(p, "x\n");
			utimesSync(p, new Date(at), new Date(at));
		}
		return dir;
	};
	const alive = live(`${fixture.deadLane.wl} ${fixture.deadLane.lane}`);

	test("newestWrite is the newest mtime under the directory, recursive; null for a missing one", () => {
		expect(newestWrite(laneDirWrittenAt("2026-10-11T18:53:10.000Z"))).toBe("2026-10-11T18:53:10.000Z");
		expect(newestWrite("/nonexistent/lanes")).toBeNull();
	});

	test("a live lane holding its workload with an old transcript and old ledger entries is hung, and the text says what to do", () => {
		const r = run({ liveLanes: alive, lanesDirOf: () => laneDirWrittenAt("2026-10-11T18:35:00.000Z") });
		const f = r.findings.find((x) => x.invariant === "silent-lane")!;
		expect(f.key).toBe(`silent-lane:${fixture.deadLane.lane}`);
		expect(f.workload).toBe(fixture.deadLane.wl);
		expect(f.since).toBe("2026-10-11T18:35:00.000Z");
		expect(f.text).toBe(`lane ${fixture.deadLane.lane} on ${fixture.deadLane.wl} silent 2.4h (last transcript write 2026-10-11T18:35:00.000Z); process alive, lease held — hung, not dead; stop + relaunch`);
		expect(keys(r)).not.toContain(`dead-lane:${fixture.deadLane.lane}`);
	});

	test("the same lane with no process is the dead-lane/orphan case, not a silent lane", () => {
		const r = run({ liveLanes: live(), lanesDirOf: () => laneDirWrittenAt("2026-10-11T18:35:00.000Z") });
		expect(r.findings.some((x) => x.invariant === "silent-lane")).toBe(false);
		expect(keys(r)).toContain(`dead-lane:${fixture.deadLane.lane}`);
		expect(keys(r)).toContain(`orphan-hand:${fixture.deadLane.token}`);
	});

	test("a transcript written within 45 min, or a lease that lapsed, or a lane that no longer holds the workload, is not a silent lane", () => {
		expect(run({ liveLanes: alive, lanesDirOf: () => laneDirWrittenAt("2026-10-11T20:30:00.000Z") }).findings.some((x) => x.invariant === "silent-lane")).toBe(false);
		// The lease lapsed before as-of (re-claimed at 19:00 for an hour): the lane does not hold the workload any more.
		const copy = buildFixture(join(tmp("copy"), "ledger.db"));
		const w = Ledger.open(copy.path, { backup: false, backupOnOpen: false, clock: () => "2026-10-11T19:00:00.000Z", skipLocalityCheck: true });
		w.releaseWorkload(copy.deadLane.wl, { by: copy.deadLane.lane, holder: copy.deadLane.lane });
		expect(w.claimWorkload(copy.deadLane.wl, { by: copy.deadLane.lane, holder: copy.deadLane.lane, leaseMs: 3_600_000 })).toEqual({ won: true });
		w.close();
		const ro = new Database(copy.path, { readonly: true });
		try {
			expect(run({ db: ro, liveLanes: live(`${copy.deadLane.wl} ${copy.deadLane.lane}`), lanesDirOf: () => laneDirWrittenAt("2026-10-11T18:35:00.000Z") }).findings.some((x) => x.invariant === "silent-lane")).toBe(false);
		} finally {
			ro.close();
		}
		// wl-fixture-stopped's lane released: no holder, so a live process on it is not a silent lane either.
		expect(run({ liveLanes: live(`${fixture.stopped.wl} ${fixture.stopped.lane}`), lanesDirOf: () => laneDirWrittenAt("2026-10-11T18:35:00.000Z") }).findings.some((x) => x.invariant === "silent-lane")).toBe(false);
	});

	test("with no lane directory the ledger alone decides, and the text says no transcript", () => {
		const r = run({ liveLanes: alive, lanesDirOf: () => "/nonexistent/lanes" });
		expect(r.findings.find((x) => x.invariant === "silent-lane")!.text).toContain("silent 2.5h (last transcript write none)");
	});
});

describe("leaked-runner: a runner alive more than 10 min after its lane ended (MIGRATION.md item 112)", () => {
	const copy = buildFixture(join(tmp("leak"), "ledger.db"));
	let now = "2026-10-11T19:00:00.000Z";
	const w = Ledger.open(copy.path, { backup: false, backupOnOpen: false, clock: () => now, skipLocalityCheck: true });
	const at = (hm: string, write: () => void) => {
		now = `2026-10-11T${hm}:00.000Z`;
		write();
	};
	const started = (wl: string, lane: string) => w.recordEntry({ by: LANE_RUNNER, workloadId: wl, kind: "assumption", body: `lane-started: ${lane} {"pid":1,"start":"","session":null,"argv":[],"runnerPid":2}` });
	const open = (id: string) => w.openWorkload({ by: "orchestrator", brief: id, stakes: "normal", mode: "autonomous", id });
	// Closed 60 min before as-of; closed 5 min before; closed after as-of; superseded at 19:30; started after as-of.
	const closed = open("wl-fixture-leak-closed");
	const recent = open("wl-fixture-leak-recent");
	const later = open("wl-fixture-leak-later");
	const superseded = open("wl-fixture-leak-superseded");
	const future = open("wl-fixture-leak-future");
	// A starts, B supersedes it, then A's metadata rerecord lands after B's start (PR #75 review B1).
	const rerecord = open("wl-fixture-leak-rerecord");
	at("19:10", () => {
		started(closed, "lane-fixture-leak-closed-1");
		started(recent, "lane-fixture-leak-recent-1");
		started(later, "lane-fixture-leak-later-1");
		started(superseded, "lane-fixture-leak-superseded-1");
		started(rerecord, "lane-fixture-leak-rerecord-a");
	});
	at("19:20", () => started(superseded, "lane-fixture-leak-superseded-1")); // the runner's second record (with the session): not a successor
	at("19:30", () => {
		started(superseded, "lane-fixture-leak-superseded-2");
		started(rerecord, "lane-fixture-leak-rerecord-b");
	});
	at("19:40", () => started(rerecord, "lane-fixture-leak-rerecord-a")); // A's metadata rerecord, after B started: still not B's successor
	at("20:00", () => w.closeWorkload(closed, { by: SURFACE_BY }));
	at("20:55", () => w.closeWorkload(recent, { by: SURFACE_BY }));
	at("21:30", () => {
		w.closeWorkload(later, { by: SURFACE_BY });
		started(future, "lane-fixture-leak-future-1");
	});
	w.close();
	const ro = new Database(copy.path, { readonly: true });
	afterAll(() => ro.close());
	const all = live(
		`${closed} lane-fixture-leak-closed-1`, `${recent} lane-fixture-leak-recent-1`, `${later} lane-fixture-leak-later-1`,
		`${superseded} lane-fixture-leak-superseded-1`, `${superseded} lane-fixture-leak-superseded-2`, `${future} lane-fixture-leak-future-1`,
	);
	const leaks = (r: Report) => r.findings.filter((f) => f.invariant === "leaked-runner");

	test("a runner on a workload closed 60 min ago and a runner superseded by a later lane 90 min ago fire; one closed 5 min ago, one closed after as-of, the superseding lane and one started after as-of do not", () => {
		const found = leaks(run({ db: ro, liveLanes: all }));
		expect(found.map((f) => [f.key, f.workload, f.since])).toEqual([
			["leaked-runner:lane-fixture-leak-closed-1", closed, "2026-10-11T20:00:00.000Z"],
			["leaked-runner:lane-fixture-leak-superseded-1", superseded, "2026-10-11T19:30:00.000Z"],
		]);
		expect(found[0]!.text).toBe(`the runner of lane-fixture-leak-closed-1 is alive 60 min after its lane ended (${closed} closed at 2026-10-11T20:00:00.000Z), holding its omp for nothing; stop it with \`as2 lane stop ${closed} lane-fixture-leak-closed-1\``);
		expect(found[1]!.text).toContain("(lane-fixture-leak-superseded-2 started at 2026-10-11T19:30:00.000Z)");
		expect(found[0]!.query).toContain(`pgrep -fl 'surface/scripts/lane.ts run ${closed} lane-fixture-leak-closed-1'`);
	});

	test("an old lane's metadata rerecord landing after its successor started does not make the successor leaked: only the old lane fires, ended at the successor's first start", () => {
		const found = leaks(run({ db: ro, liveLanes: live(`${rerecord} lane-fixture-leak-rerecord-a`, `${rerecord} lane-fixture-leak-rerecord-b`) }));
		expect(found.map((f) => [f.key, f.workload, f.since])).toEqual([["leaked-runner:lane-fixture-leak-rerecord-a", rerecord, "2026-10-11T19:30:00.000Z"]]);
		expect(found[0]!.text).toContain("(lane-fixture-leak-rerecord-b started at 2026-10-11T19:30:00.000Z)");
	});

	test("past the later close, the closed-after-as-of runner fires too; with no process table the invariant is skipped with the probe's reason", () => {
		expect(leaks(run({ db: ro, liveLanes: all, asOf: "2026-10-11T22:00:00.000Z" })).map((f) => f.key)).toContain("leaked-runner:lane-fixture-leak-later-1");
		const r = run({ db: ro, liveLanes: { skipped: "pgrep -fl … exited 2: pgrep: cannot read /proc" } });
		expect(skipsOf(r, "leaked-runner")).toEqual([expect.stringContaining("pgrep: cannot read /proc")]);
		expect(leaks(r)).toEqual([]);
	});
});

describe("the git and process invariants", () => {
	const git = (dir: string, ...a: string[]) => {
		const p = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent-home" } });
		if (p.status !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
		return p.stdout.trim();
	};
	/** A checkout two commits behind its origin's main. */
	function behindCheckout(): string {
		const root = tmp("git");
		const bare = join(root, "origin.git");
		git(root, "init", "--bare", "-b", "main", bare);
		const other = join(root, "other");
		git(root, "clone", "-q", bare, other);
		writeFileSync(join(other, "a"), "1\n");
		git(other, "add", "a");
		git(other, "commit", "-q", "-m", "first");
		git(other, "push", "-q", "origin", "HEAD:main");
		const checkout = join(root, "checkout");
		git(root, "clone", "-q", bare, checkout);
		for (const n of ["second", "third"]) {
			writeFileSync(join(other, "a"), `${n}\n`);
			git(other, "commit", "-q", "-am", n);
		}
		git(other, "push", "-q", "origin", "HEAD:main");
		git(checkout, "fetch", "-q", "origin");
		return checkout;
	}
	const now = "2026-10-11T23:00:00.000Z";
	const notReplay = { asOf: now, replay: false };

	test("a clean checkout behind origin/main is reported with the count, 'fast-forward at a lull', and a lull citing the fingerprint rule when no review is in flight", () => {
		const repo = behindCheckout();
		const r = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: live() });
		const behind = r.findings.find((f) => f.invariant === "checkout-behind-main")!;
		expect(behind.key).toMatch(/^checkout-behind-main:[0-9a-f]{12}:[0-9a-f]{12}$/);
		expect(behind.text).toContain("behind origin/main by 2 (oldest: second)");
		expect(behind.text).toContain("fast-forward at a lull");
		expect(behind.text).not.toContain("ff-main-and-restart");
		const lull = r.findings.find((f) => f.invariant === "ff-lull")!;
		expect(lull.text).toContain(`lull for a fast-forward of ${repo}: 0 review hands in flight (a review's fingerprint covers its lane's worktree only and leaves refs other than HEAD's out, classifier/src/fingerprint.ts header`);
		expect(lull.text).toContain("tracked files clean (untracked not checked), 0 lanes alive");
		expect(lull.text).not.toContain("safe");
		expect(lull.text).toContain(`not counted: ${fixture.deadLane.token}`);
		expect(skipsOf(r, "process-older-than-head")).toEqual([`no orchestrator process (omp --cwd ${repo}) on this machine`]);
	});

	test("a modified tracked file makes the fast-forward refuse and there is no lull; an untracked file changes nothing", () => {
		const repo = behindCheckout();
		writeFileSync(join(repo, "untracked"), "left alone\n");
		const clean = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: live() });
		expect(clean.findings.find((f) => f.invariant === "checkout-behind-main")!.text).toContain("fast-forward at a lull");
		expect(clean.findings.some((f) => f.invariant === "ff-lull")).toBe(true);
		writeFileSync(join(repo, "a"), "edited\n");
		const r = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: live() });
		expect(r.findings.find((f) => f.invariant === "checkout-behind-main")!.text).toContain("fast-forward would refuse, tracked files modified: M a");
		expect(r.findings.some((f) => f.invariant === "ff-lull")).toBe(false);
	});

	test("a failed git status is unknown cleanliness, not clean: the finding says so and there is no lull", () => {
		const repo = behindCheckout();
		const real = gitIn(repo);
		const failingStatus: Git = (...a) => (a[0] === "status" ? { ok: false, out: "" } : real(...a));
		const r = run({ ...notReplay, repo, git: failingStatus, orchestrators: noProcs, liveLanes: live() });
		expect(r.findings.find((f) => f.invariant === "checkout-behind-main")!.text).toContain("git status failed, so tracked-file cleanliness is unknown");
		expect(r.findings.some((f) => f.invariant === "ff-lull")).toBe(false);
	});

	test("a checkout ahead of origin/main (local commits, none behind) is not a finding", () => {
		const repo = behindCheckout();
		git(repo, "merge", "-q", "--ff-only", "origin/main");
		writeFileSync(join(repo, "b"), "local\n");
		git(repo, "add", "b");
		git(repo, "commit", "-q", "-m", "local-only");
		const r = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: live() });
		expect(r.findings.some((f) => f.invariant === "checkout-behind-main" || f.invariant === "ff-lull")).toBe(false);
		expect(skipsOf(r, "checkout-behind-main")).toEqual([]);
	});

	test("a review hand in flight holds the lull back", () => {
		const repo = behindCheckout();
		const r = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: live(`${fixture.deadLane.wl} ${fixture.deadLane.lane}`) });
		expect(r.reviewsInFlight).toEqual([fixture.deadLane.token]);
		expect(r.findings.some((f) => f.invariant === "ff-lull")).toBe(false);
		expect(r.findings.find((f) => f.invariant === "checkout-behind-main")!.text).toContain("reviews in flight now: 1");
	});

	test("a diverged checkout needs a person", () => {
		const repo = behindCheckout();
		writeFileSync(join(repo, "b"), "local\n");
		git(repo, "add", "b");
		git(repo, "commit", "-q", "-m", "local-only");
		const r = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: live() });
		const f = r.findings.find((x) => x.invariant === "checkout-behind-main")!;
		expect(f.key).toMatch(/^checkout-behind-main:diverged:/);
		expect(f.text).toContain("has DIVERGED from origin/main");
		expect(f.text).toContain("(1 local-only, 2 behind)");
		expect(f.text).toContain("Needs a person");
	});

	test("an orchestrator process older than HEAD is flagged; a persistent seat and a newer process are not", () => {
		const repo = behindCheckout();
		const r = run({
			...notReplay, repo, git: gitIn(repo), liveLanes: live(),
			orchestrators: () => ({ found: [
				{ pid: "100", command: `omp --cwd ${repo}`, started: new Date("2020-01-01T00:00:00Z") },
				{ pid: "101", command: `omp --cwd ${repo} --session-dir /h/.omp/agent/seat-sessions/plumb`, started: new Date("2020-01-01T00:00:00Z") },
				{ pid: "102", command: `omp --cwd ${repo}`, started: new Date("2999-01-01T00:00:00Z") },
				{ pid: "103", command: `omp --cwd ${repo}`, started: null },
			] }),
		});
		const stale = r.findings.filter((f) => f.invariant === "process-older-than-head");
		expect(stale.map((f) => f.key)).toEqual([expect.stringMatching(/^process-older-than-head:100:[0-9a-f]{12}$/)]);
		expect(stale[0]!.text).toContain("omp pid 100 (orchestrator");
		expect(stale[0]!.text).toContain("Restart it (/exit, then as2)");
	});

	test("an up-to-date checkout has no finding and nothing skipped for git", () => {
		const repo = behindCheckout();
		git(repo, "merge", "-q", "--ff-only", "origin/main");
		const r = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: live() });
		expect(r.findings.some((f) => f.invariant === "checkout-behind-main" || f.invariant === "ff-lull")).toBe(false);
		expect(skipsOf(r, "checkout-behind-main")).toEqual([]);
	});

	test("skips: no git, not a checkout, no origin/main, a failed process probe", () => {
		expect(skipsOf(run({ ...notReplay, repo: "/x", git: null }), "checkout-behind-main")).toEqual(["git is not available on this machine"]);
		const plain = tmp("plain");
		expect(skipsOf(run({ ...notReplay, repo: plain, git: gitIn(plain) }), "ff-lull")).toEqual([`${plain} is not a git checkout`]);
		const local = tmp("local");
		git(local, "init", "-q", "-b", "main");
		expect(skipsOf(run({ ...notReplay, repo: local, git: gitIn(local) }), "process-older-than-head")).toEqual([`${local} has no origin/main`]);
		const repo = behindCheckout();
		expect(skipsOf(run({ ...notReplay, repo, git: gitIn(repo), orchestrators: () => ({ skipped: "ps is not available on this machine" }), liveLanes: live() }), "process-older-than-head")).toEqual(["ps is not available on this machine"]);
	});

	test("a failed lane-process probe skips ff-lull with the probe's reason: a probe failure is never a lull or a dead lane", () => {
		const repo = behindCheckout();
		const r = run({ ...notReplay, repo, git: gitIn(repo), orchestrators: noProcs, liveLanes: { skipped: "pgrep -fl … exited 2: pgrep: cannot read /proc" } });
		expect(r.findings.some((f) => f.invariant === "ff-lull" || f.invariant === "dead-lane")).toBe(false);
		expect(r.findings.find((f) => f.invariant === "checkout-behind-main")!.text).toContain("fast-forward at a lull");
		expect(skipsOf(r, "ff-lull")).toEqual(["the process table could not be read (pgrep -fl … exited 2: pgrep: cannot read /proc), so lane liveness is unknown"]);
		expect(skipsOf(r, "dead-lane")).toEqual(["the process table could not be read (pgrep -fl … exited 2: pgrep: cannot read /proc), so lane liveness is unknown"]);
	});
});

describe("stale-backup: the newest write runs ahead of the newest copy by more than the gap", () => {
	const oldCopy = "ledger-2026-10-10T12-00-00.000Z.db";
	const backupFinding = (r: Report) => r.findings.find((x) => x.invariant === "stale-backup");

	test("recent writes and an old copy: the 20:50 write is 32.8 h past the previous day's 12:00 copy, over the default 30 h (the 24 h copy interval plus 6 h); the text names both times and the directory", () => {
		expect(BACKUP_GAP_MS).toBe(30 * 60 * 60_000);
		const dir = copiesIn("backups-old", oldCopy);
		const f = backupFinding(run({ replay: false, backups: { dir, gapMs: BACKUP_GAP_MS } }))!;
		expect(f.key).toBe(`stale-backup:${oldCopy}`);
		expect(f.workload).toBe("ledger");
		expect(f.since).toBe("2026-10-10T12:00:00.000Z");
		expect(f.text).toStartWith(`newest ledger write 2026-10-11T20:50:00.000Z is 32.8h newer than newest ledger backup 2026-10-10T12:00:00.000Z (${oldCopy}) in ${dir} (gap 30.0h): writes since then are in no copy.`);
		expect(f.text).not.toContain("replay");
		expect(f.query).toContain(`ls ${dir}/ledger-*.db; `);
	});

	test("a quiet ledger and an old copy: three days after a 17:00 copy, the newest write (20:50) is 3.8 h past it, inside 30 h: no finding", () => {
		const dir = copiesIn("backups-quiet", "ledger-2026-10-11T17-00-00.000Z.db");
		expect(backupFinding(run({ asOf: "2026-10-14T21:00:00.000Z", backups: { dir, gapMs: BACKUP_GAP_MS } }))).toBeUndefined();
		// A copy after every write is never behind, whatever the gap.
		expect(backupFinding(run({ asOf: "2026-10-14T21:00:00.000Z", backups: { dir: freshBackups, gapMs: 60_000 } }))).toBeUndefined();
	});

	test("in replay copies named after as-of and writes after as-of are ignored, and the text says the directory is read as it is now", () => {
		const f = backupFinding(run({ asOf: "2026-10-11T20:00:00.000Z", backups: { dir: freshBackups, gapMs: BACKUP_GAP_MS } }))!;
		expect(f.key).toBe(`stale-backup:${oldCopy}`);
		expect(f.text).toStartWith("newest ledger write 2026-10-11T19:30:00.000Z is 31.5h newer than newest ledger backup 2026-10-10T12:00:00.000Z");
		expect(f.text).toContain("replay: the backup directory and its files are read as they are on disk now, not as of as-of");
	});

	test("no copy, or no directory: the gap runs from the first write (18:00 to 20:50, 2.8 h)", () => {
		const empty = copiesIn("backups-empty");
		const twoHours = 2 * 60 * 60_000;
		const f = backupFinding(run({ backups: { dir: empty, gapMs: twoHours } }))!;
		expect(f.key).toBe("stale-backup:none");
		expect(f.text).toContain("no ledger backup at or before 2026-10-11T21:00:00.000Z (first ledger write 2026-10-11T18:00:00.000Z)");
		expect(backupFinding(run({ backups: { dir: join(empty, "missing"), gapMs: twoHours } }))!.key).toBe("stale-backup:none");
		expect(backupFinding(run({ backups: { dir: empty, gapMs: BACKUP_GAP_MS } }))).toBeUndefined();
	});

	test("the fixture copies are complete by the ledger's own test, so the cases above exercise real backups", () => {
		expect(copyProblem(join(freshBackups, "ledger-2026-10-11T20-55-00.000Z.db"))).toBeNull();
	});

	test("an empty file named like the newest copy is not a backup (PR #45 review reproduction): with no complete copy the gap runs from the first write and the text names each file and its problem", () => {
		const newestName = "ledger-2026-10-11T20-55-00.000Z.db";
		const dir = tmp("backups-repro");
		for (const n of [oldCopy, newestName]) writeFileSync(join(dir, n), "");
		expect(copyProblem(join(dir, newestName))).toBe("empty file");
		const r = run({ asOf: "2026-10-14T21:00:00.000Z", replay: false, backups: { dir, gapMs: 60_000 } });
		expect(skipsOf(r, "stale-backup")).toEqual([]);
		const f = backupFinding(r)!;
		expect(f.key).toBe("stale-backup:none");
		expect(f.since).toBe("2026-10-11T18:00:00.000Z");
		expect(f.text).toContain(`no ledger backup at or before 2026-10-14T21:00:00.000Z (first ledger write 2026-10-11T18:00:00.000Z); not counted, not a complete copy: ${newestName} (empty file), ${oldCopy} (empty file) in ${dir}`);
	});

	test("a newer file ending .invalid (the writer's quarantine) is never a candidate, even when its contents are a complete copy", () => {
		const dir = copiesIn("backups-invalid", oldCopy, "ledger-2026-10-11T20-55-00.000Z.db.invalid");
		const f = backupFinding(run({ replay: false, backups: { dir, gapMs: BACKUP_GAP_MS } }))!;
		expect(f.key).toBe(`stale-backup:${oldCopy}`);
		expect(f.text).not.toContain(".invalid");
		expect(f.text).not.toContain("not counted");
	});

	test("a newest copy the validator rejects falls back to an older complete copy: inside the gap no finding, and the fallback is the copy measured", () => {
		const rejected = "ledger-2026-10-11T20-55-00.000Z.db";
		const older = "ledger-2026-10-11T17-00-00.000Z.db";
		const dir = copiesIn("backups-fallback-in", older);
		wrongVersion(join(dir, rejected));
		expect(copyProblem(join(dir, rejected))).toBe("user_version 0, not 5");
		expect(backupFinding(run({ replay: false, backups: { dir, gapMs: BACKUP_GAP_MS } }))).toBeUndefined();
		// With a one-minute gap the 20:50 write is 3.8 h past the 17:00 copy, not 5 min before the rejected 20:55 one.
		const f = backupFinding(run({ replay: false, backups: { dir, gapMs: 60_000 } }))!;
		expect(f.key).toBe(`stale-backup:${older}`);
		expect(f.since).toBe("2026-10-11T17:00:00.000Z");
		expect(f.text).toContain(`3.8h newer than newest ledger backup 2026-10-11T17:00:00.000Z (${older}); not counted, not a complete copy: ${rejected} (user_version 0, not 5) in ${dir}`);
	});

	test("a newest copy that is not a database falls back to an older complete copy outside the gap: the finding fires on the older copy and names the rejected file", () => {
		const rejected = "ledger-2026-10-11T20-55-00.000Z.db";
		const dir = copiesIn("backups-fallback-out", oldCopy);
		writeFileSync(join(dir, rejected), "this is not a SQLite database, just bytes with a copy's name ".repeat(100));
		const problem = copyProblem(join(dir, rejected));
		expect(problem).not.toBeNull();
		const f = backupFinding(run({ replay: false, backups: { dir, gapMs: BACKUP_GAP_MS } }))!;
		expect(f.key).toBe(`stale-backup:${oldCopy}`);
		expect(f.since).toBe("2026-10-10T12:00:00.000Z");
		expect(f.text).toStartWith(`newest ledger write 2026-10-11T20:50:00.000Z is 32.8h newer than newest ledger backup 2026-10-10T12:00:00.000Z (${oldCopy}); not counted, not a complete copy: ${rejected} (${problem}) in ${dir} (gap 30.0h)`);
	});

	test("the CLI reads backups/<namespace> beside the ledger and takes --backup-gap in hours", () => {
		const dir = tmp("cli-backups");
		const ledgerPath = join(dir, "ledger.db");
		copyFileSync(fixture.path, ledgerPath);
		const canonical = canonicalPath(ledgerPath);
		const ns = join(dirname(canonical), "backups", backupNamespace(canonical));
		mkdirSync(ns, { recursive: true });
		const copy = "ledger-2026-10-11T18-30-00.000Z.db";
		copyFileSync(fixture.path, join(ns, copy));
		const env = { ...process.env, AGENT_SYSTEM_LEDGER_DB: ledgerPath };
		const keysOf = (extra: string[]) => {
			const p = spawnSync("bun", [SCRIPT, "--json", "--as-of", AS_OF, ...extra], { encoding: "utf8", env });
			expect(p.status).toBe(0);
			return p.stdout.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.invariant === "stale-backup").map((l) => l.key);
		};
		expect(keysOf(["--backup-gap", "2"])).toEqual([`stale-backup:${copy}`]);
		expect(keysOf([])).toEqual([]);
		expect(() => parseArgs(["--backup-gap", "0"], "/r")).toThrow("positive number of hours");
		expect(parseArgs(["--backup-gap", "6"], "/r").backupGapMs).toBe(6 * 60 * 60_000);
	});
});

describe("orchestratorsFromPs: a failed ps is a skip, a vanished pid is not", () => {
	const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
	const deps = (ps: Run, alive: boolean): PsDeps => ({
		available: () => true,
		alive: () => alive,
		run: (argv) => (argv[0] === "pgrep" ? ok("4242\n") : ps(argv)),
	});
	const lstart = "Sun Oct 11 10:00:00 2026";

	test("ps succeeding lists the process", () => {
		const p = orchestratorsFromPs("/r", deps((argv) => ok(argv[2] === "lstart=" ? lstart : "omp --cwd /r"), true));
		expect("found" in p && p.found.map((x) => [x.pid, x.command])).toEqual([["4242", "omp --cwd /r"]]);
	});

	test("ps failing for a pid that is gone means it exited between pgrep and ps: left out, not a skip", () => {
		expect(orchestratorsFromPs("/r", deps(() => ({ exitCode: 1, stdout: "", stderr: "" }), false))).toEqual({ found: [] });
	});

	test("ps failing for a pid still alive, or failing to start, is a skip with the reason", () => {
		expect(orchestratorsFromPs("/r", deps(() => ({ exitCode: 1, stdout: "", stderr: "ps: kvm_getprocs: Operation not permitted" }), true)))
			.toEqual({ skipped: "ps failed: ps -o lstart= -p 4242 exited 1 while pid 4242 is alive: ps: kvm_getprocs: Operation not permitted" });
		const p = orchestratorsFromPs("/r", deps(() => { throw new Error("spawn EAGAIN"); }, true));
		expect(p).toEqual({ skipped: "ps failed: ps -o lstart= -p 4242 could not start: spawn EAGAIN" });
	});
});

describe("output and the CLI", () => {
	test("--json is one object per finding, then one per skipped invariant, each carrying asOf", () => {
		const r = run();
		const lines = jsonLines(r).split("\n").map((l) => JSON.parse(l));
		expect(lines).toHaveLength(r.findings.length + r.skipped.length);
		for (const l of lines) expect(l.asOf).toBe(AS_OF);
		expect(lines.slice(r.findings.length).map((l) => l.invariant)).toEqual(["checkout-behind-main", "process-older-than-head", "ff-lull"]);
		expect(lines.slice(r.findings.length).every((l) => typeof l.skipped === "string")).toBe(true);
	});

	test("parseArgs: --as-of normalises to ISO, --repo resolves, the default repo is the checkout holding the script, a bad argument throws", () => {
		const a = parseArgs(["--json", "--as-of", "2026-10-11T21:00:00Z", "--repo", "surface/.."], "/r/surface/scripts");
		expect(a).toMatchObject({ json: true, reviews: false, asOf: AS_OF });
		expect(a.repo).toBe(process.cwd());
		expect(parseArgs([], "/r/surface/scripts").repo).toBe("/r");
		expect(() => parseArgs(["--days"], "/r")).toThrow("unknown argument --days");
		expect(() => parseArgs(["--as-of", "yesterday"], "/r")).toThrow("ISO-8601");
	});

	const env = { ...process.env, AGENT_SYSTEM_LEDGER_DB: fixture.path };
	test("the script over the fixture: --json exits 0 with the fixture's findings and the replay skips, the summary on stderr", () => {
		const p = spawnSync("bun", [SCRIPT, "--json", "--as-of", AS_OF], { encoding: "utf8", env });
		expect(p.status).toBe(0);
		const lines = p.stdout.trim().split("\n").map((l) => JSON.parse(l));
		const byInvariant: Record<string, string[]> = {};
		for (const l of lines.filter((l) => l.key)) (byInvariant[l.invariant as string] ??= []).push(l.key as string);
		// No backups/ beside the temp ledger: the gap runs from the first write (18:00 to 20:50), inside the default 30 h.
		expect(Object.keys(byInvariant).sort()).toEqual(["dead-lane", "orphan-hand", "provider-refusal-loop", "stale-reserved", "stuck-question"]);
		expect(byInvariant["stale-reserved"]).toEqual([`stale-reserved:${fixture.waiting.request}`]);
		expect(lines.filter((l) => l.skipped).map((l) => l.invariant)).toEqual(["checkout-behind-main", "process-older-than-head", "ff-lull"]);
		expect(p.stderr).toContain(`as-of ${AS_OF} (REPLAY`);
		expect(p.stderr).toContain("stale-reserved=1 stuck-question=1");
	});

	test("the script without --as-of runs the git invariants against this checkout and still exits 0", () => {
		const p = spawnSync("bun", [SCRIPT, "--json"], { encoding: "utf8", env });
		expect(p.status).toBe(0);
		for (const l of p.stdout.trim().split("\n")) expect(() => JSON.parse(l)).not.toThrow();
		expect(p.stderr).toMatch(/^as-of \d{4}-/);
	});

	test("--reviews is one line; the table ends with the counts", () => {
		const reviews = spawnSync("bun", [SCRIPT, "--reviews", "--as-of", AS_OF], { encoding: "utf8", env });
		expect(reviews.status).toBe(0);
		expect(reviews.stdout.trim().split("\n")).toEqual([expect.stringMatching(/^lanes-alive \d+ reviews-in-flight \d+/)]);
		const table = spawnSync("bun", [SCRIPT, "--as-of", AS_OF], { encoding: "utf8", env });
		expect(table.status).toBe(0);
		expect(table.stdout).toMatch(/\n\d+ finding\(s\): dead-lane=1 silent-lane=0 leaked-runner=0 orphan-hand=1 .* 3 skipped; \d+ ms\n$/);
	});

	test("a bad argument or a missing ledger exits 2 with the message", () => {
		const bad = spawnSync("bun", [SCRIPT, "--nope"], { encoding: "utf8", env });
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain("unknown argument --nope");
		const none = spawnSync("bun", [SCRIPT, "--json"], { encoding: "utf8", env: { ...process.env, AGENT_SYSTEM_LEDGER_DB: join(tmp("none"), "ledger.db") } });
		expect(none.status).toBe(2);
		expect(none.stdout).toBe("");
	});

	test("the checked-in fixture (surface/test/fixtures/invariants/ledger.db) reproduces the builder's scenario (same invariants fire; ids differ per build, so it is not byte-identical), read-only from the repo", () => {
		const p = spawnSync("bun", [SCRIPT, "--json", "--as-of", AS_OF], { encoding: "utf8", env: { ...process.env, AGENT_SYSTEM_LEDGER_DB: CHECKED_IN } });
		expect(p.status).toBe(0);
		const invariants = p.stdout.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.key).map((l) => l.invariant).sort();
		expect(invariants).toEqual(["dead-lane", "orphan-hand", "provider-refusal-loop", "stale-reserved", "stuck-question"]);
	});
});
