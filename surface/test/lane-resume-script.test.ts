// jo-issues #206: real runner subprocesses, offline OMP boundary, workload-local sessions.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneDir, laneExit, laneModelBody, laneStarted, laneStartedBody } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { drainSettled, fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, type LaneRoot, laneSnapshot, type FakeRecord, type FakeScript, setScript, settleDrains, sh, until } from "./helpers";

// Keep HOME, ledger, git repositories and inherited helper processes inside the workload scratch root.
const X = "openai-codex/gpt-6-sol";
const A = "anthropic/claude-opus-5-5";
const roots: LaneRoot[] = [];
const gates: string[] = [];
afterAll(async () => {
	for (const gate of gates) writeFileSync(gate, "release");
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const result of settled) if (result.status === "rejected") throw result.reason;
}, 60_000);
function fixture(model: string | null = X, readyMs = "4000") {
	const r = laneRoot({ AGENT_SYSTEM_LANE_READY_MS: readyMs }, "resume", process.env.AS2_SCRATCH);
	roots.push(r);
	const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "resume regression", stakes: "normal", mode: "autonomous" });
	recordRepo(l, wl, r.repo);
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("resume regression completed") });
	if (model) l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody(model, l.now()) });
	l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "probe resume", doneCondition: "probed", inputs: "README.md" });
	const dir = join(laneDir(wl, r.home), "sessions");
	mkdirSync(dir, { recursive: true });
	let ordinal = 0;
	function origin(path: string, ran: string | null | "unknown" = model, parked = false, legacy = false) {
		const lane = laneIdOf(wl, ++ordinal);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `launch: ${lane} cause first requested-by test` });
		if (ran !== "unknown") l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(lane, { pid: 0, start: "", session: parked ? null : path, argv: [], runnerPid: 0, ...(legacy ? {} : { model: ran }) }) });
		if (parked || ran === "unknown") l.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `lane-parked: ${lane} questions q-probe session ${path}` });
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `lane-exit: ${lane} code 1 signal - outcome died` });
		return lane;
	}
	function file(name: string, time = 1000) {
		const path = join(dir, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ type: "session", id: crypto.randomUUID() })}\n`);
		utimesSync(path, time, time);
		return path;
	}
	async function run(script: FakeScript = { steps: [{ tool: "lane_record_entry", args: { body: "done-because: resume regression completed" } }] }) {
		if (ordinal > 0) l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `launch-requested: by jo at ${l.now()}` });
		l.close();
		setScript(r, script);
		const result = sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "jo"], r.repo, r.env);
		expect(result.code).toBe(0);
		const lane = laneIdOf(wl, ordinal + 1);
		const exit = await until("runner exit", () => laneExit(laneSnapshot(r, wl).control, lane), 12_000);
		await drainSettled(r, lane);
		const snap = laneSnapshot(r, wl);
		const rec = fakeRecords(r).find((x) => x.argv !== undefined);
		const log = readFileSync(join(laneDir(wl, r.home), "runner.log"), "utf8");
		return { lane, exit, snap, rec, log, records: fakeRecords(r), started: laneStarted(snap.control, lane) };
	}
	return { r, l, wl, dir, origin, file, run };
}
interface ResumeResult {
	exit: { outcome: string };
	rec: FakeRecord | undefined;
	started: { resumeSkipped: string | null } | null;
	records: FakeRecord[];
}
function resumed(result: ResumeResult, path: string | null) {
	expect(result.exit.outcome).toBe("completed");
	expect(result.rec).toBeDefined();
	expect(result.rec!.resumed).toBe(path);
	if (path === null) expect(result.started!.resumeSkipped).not.toBeNull();
	else expect(result.started!.resumeSkipped).toBeNull();
	const prompt = result.records.find((x) => x.event === "prompt");
	expect(prompt!.message).toContain("resume regression");
}

test("missing recorded file recovers newest top-level session, ignoring nested hands and directories", async () => {
	const f = fixture();
	const older = f.file("older.jsonl", 1000); f.origin(older);
	const newest = f.file("newest.jsonl", 2000); f.origin(newest, X, true);
	f.file("hand/child.jsonl", 9000); mkdirSync(join(f.dir, "directory.jsonl"));
	f.origin(join(f.dir, "missing.jsonl"));
	const result = await f.run(); resumed(result, newest);
	expect(result.log).toContain("missing"); expect(result.log).toContain(newest);
}, 20_000);

test("missing recorded file with no usable candidates starts fresh with a truthful reason", async () => {
	const f = fixture(); f.origin(join(f.dir, "missing.jsonl"));
	const result = await f.run(); resumed(result, null);
	expect(result.started!.resumeSkipped).toContain("missing");
}, 20_000);

test("existing compatible recorded session wins over newer disk files", async () => {
	const f = fixture(); const kept = f.file("kept.jsonl"); f.file("newer.jsonl", 9000); f.origin(kept);
	resumed(await f.run(), kept);
}, 20_000);

test("existing incompatible recorded session starts fresh without scanning", async () => {
	const f = fixture(); const alternative = f.file("alternative.jsonl", 9000); f.origin(alternative);
	const recorded = f.file("recorded.jsonl"); f.origin(recorded, A);
	const result = await f.run(); resumed(result, null); expect(result.started!.resumeSkipped).toContain(A);
}, 20_000);

test("missing mismatched origin still recovers compatible fallback; equal mtimes choose greatest pathname", async () => {
	const f = fixture(); const a = f.file("a.jsonl"); const z = f.file("z.jsonl"); f.origin(a); f.origin(z); f.origin(join(f.dir, "missing.jsonl"), A);
	resumed(await f.run(), z);
}, 20_000);

test("fallback provenance canonicalizes aliases and uses that lane's latest start model", async () => {
	const f = fixture(); const candidate = f.file("candidate.jsonl");
	const alias = join(f.r.root, "candidate-alias.jsonl"); symlinkSync(candidate, alias);
	const lane = f.origin(alias, A, true);
	f.l.recordEntry({ by: LANE_STARTER_BY, workloadId: f.wl, kind: "assumption", body: laneStartedBody(lane, { pid: 0, start: "", session: null, argv: [], runnerPid: 0, model: X }) });
	f.origin(join(f.dir, "missing.jsonl")); resumed(await f.run(), candidate);
}, 20_000);

for (const provenance of ["unknown", A] as const) test(`newest fallback with ${provenance} provenance starts fresh, not an older compatible file`, async () => {
	const f = fixture(); const older = f.file("older.jsonl"); f.origin(older);
	const newest = f.file("newest.jsonl", 2000); if (provenance !== "unknown") f.origin(newest, provenance);
	f.origin(join(f.dir, "missing.jsonl"));
	const result = await f.run(); resumed(result, null);
	expect(result.started!.resumeSkipped).toContain(provenance); expect(result.started!.resumeSkipped).toContain(newest);
}, 20_000);

test("legacy absent model means default for fallback provenance", async () => {
	const f = fixture(null); const candidate = f.file("legacy.jsonl"); f.origin(candidate, null, false, true);
	f.origin(join(f.dir, "missing.jsonl")); resumed(await f.run(), candidate);
}, 20_000);

test("no recorded origin does not opportunistically recover disk sessions", async () => {
	const f = fixture(); f.file("orphan.jsonl"); const result = await f.run();
	expect(result.exit.outcome).toBe("completed"); expect(result.rec!.resumed).toBeNull(); expect(result.started!.resumeSkipped).toBeNull();
}, 20_000);

const startupCases = [
	{ name: "final unterminated fragment", chunks: ["fatal startup fragment"], expected: "fatal startup fragment", code: 23 },
	{ name: "multiline chunk boundaries", chunks: ["Error: first\n sec", "ond\tline", " final"], expected: "Error: first second line final", code: 17 },
	{ name: "bounded byte and character tail", chunks: ["discarded-prefix" + "x".repeat(10_000), "\nlast crash detail"], expected: "last crash detail", code: 19 },
	{ name: "byte tail precedes whitespace normalization", chunks: ["discarded-prefix" + " ".repeat(9000), "last crash detail"], expected: "last crash detail", code: 29 },
	{ name: "empty stderr", chunks: [], expected: "no stderr", code: 1 },
	{ name: "signal", chunks: ["terminated during startup"], expected: "terminated during startup", signal: "SIGTERM" as const },
];
for (const row of startupCases) test(`early exit reports startup and actual status: ${row.name}`, async () => {
	const f = fixture(); const result = await f.run({ startup: row });
	expect(result.exit.outcome).toBe("never-ready"); expect(result.snap.workload!.holder).toBeNull();
	const failures = result.snap.control.filter((c) => c.prefix === "launch-failed" && c.laneId === result.lane);
	expect(failures).toHaveLength(1); expect(result.snap.deaths).toHaveLength(1);
	for (const body of [failures[0]!.rest, result.snap.deaths[0]!]) {
		expect(body).toContain("startup:"); expect(body).toContain(row.expected);
		expect(body.match(/omp exit code/g)).toHaveLength(1);
		if (row.signal) expect(body).toContain("signal SIGTERM"); else expect(body).toContain(`code ${row.code}`);
		expect(body.length).toBeLessThan(1300); expect(body).not.toContain("discarded-prefix");
		expect(body).not.toContain("\n");
	}
	if (row.name === "bounded byte and character tail") expect(failures[0]!.rest).toContain("…");
	expect(result.log).toContain(row.chunks.join(""));
}, 20_000);

test("inherited stderr held open does not delay holder release until EOF", async () => {
	const f = fixture(); const gate = join(f.r.root, "stderr-gate"); gates.push(gate);
	const result = await f.run({ startup: { code: 31, chunks: ["held stderr crash"] }, holdStderrUntil: gate });
	expect(existsSync(gate)).toBe(false);
	expect(result.snap.workload!.holder).toBeNull(); expect(result.snap.deaths[0]).toContain("held stderr crash");
	writeFileSync(gate, "release");
}, 20_000);

test("explicit model failure retains precedence over child termination", async () => {
	const f = fixture(); const result = await f.run({ stateModel: { provider: "anthropic", id: "claude-opus-5-5" }, steps: [] });
	const failures = result.snap.control.filter((c) => c.prefix === "launch-failed" && c.laneId === result.lane);
	expect(failures).toHaveLength(1); expect(result.snap.deaths).toHaveLength(1);
	expect(result.exit.outcome).toBe("never-ready"); expect(result.snap.workload!.holder).toBeNull();
	expect(failures[0]!.rest).toStartWith("model:");
	for (const body of [failures[0]!.rest, result.snap.deaths[0]!]) {
		expect(body).toContain("model:"); expect(body).toContain(X); expect(body).toContain(A);
	}
}, 20_000);

test("pre-ready read-loop ledger failure retains its run cause through child termination", async () => {
	const f = fixture(); const lane = laneIdOf(f.wl, 1);
	const cause = "injected session-start rerecord failure";
	const db = new Database(f.r.ledgerPath);
	try {
		// Let spawn/start commit; reject only the get_state read loop's second start record.
		db.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON entries
			WHEN NEW.body LIKE 'lane-started: ${lane} %'
			AND EXISTS (SELECT 1 FROM entries WHERE body LIKE 'lane-started: ${lane} %')
			BEGIN SELECT RAISE(ABORT, '${cause}'); END;`);
		db.exec(`CREATE TABLE release_audit (holder TEXT);
			CREATE TRIGGER audit_release AFTER UPDATE OF holder ON workloads
			WHEN OLD.id = '${f.wl}' AND OLD.holder IS NOT NULL AND NEW.holder IS NULL
			BEGIN INSERT INTO release_audit VALUES (OLD.holder); END;`);
	} finally {
		db.close();
	}
	const result = await f.run({ claim: false, steps: [] });
	expect(result.exit).toMatchObject({ signal: "SIGKILL", outcome: "never-ready" });
	expect(result.snap.workload!.holder).toBeNull();
	const failures = result.snap.control.filter((c) => c.prefix === "launch-failed" && c.laneId === lane);
	expect(failures).toHaveLength(1); expect(result.snap.deaths).toHaveLength(1);
	expect(failures[0]!.rest).toStartWith("run:");
	for (const body of [failures[0]!.rest, result.snap.deaths[0]!]) {
		expect(body).toContain("run:"); expect(body).toContain(cause);
	}
	expect(result.snap.control.filter((c) => c.prefix === "lane-exit" && c.laneId === lane)).toHaveLength(1);
	expect(result.snap.control.filter((c) => c.prefix === "lane-started" && c.laneId === lane)).toHaveLength(1);
	expect(result.snap.control.filter((c) => c.prefix === "lane-ready" && c.laneId === lane)).toHaveLength(0);
	expect(result.records.some((r) => r.command === "get_state")).toBe(true);
	expect(result.records.some((r) => r.event === "prompt")).toBe(false);
	const audit = new Database(f.r.ledgerPath);
	try {
		expect(audit.query("SELECT holder FROM release_audit").all()).toEqual([{ holder: lane }]);
	} finally {
		audit.close();
	}
}, 20_000);

test("genuinely elapsed no-claim readiness keeps readiness stage", async () => {
	const f = fixture(X, "1000"); const result = await f.run({ claim: false, steps: [] });
	expect(result.exit.outcome).toBe("never-ready"); expect(result.snap.deaths[0]).toContain("readiness:");
	expect(result.snap.control.find((c) => c.prefix === "launch-failed")!.rest).toStartWith("readiness:");
}, 20_000);

test("accepted pre-ready stop stays intended instead of becoming startup failure", async () => {
	const f = fixture();
	const stopping = (async () => {
		const started = await until("runner start for stop", () => laneStarted(laneSnapshot(f.r, f.wl).control), 10_000);
		process.kill(started.runnerPid, "SIGTERM");
	})();
	const result = await f.run({ startup: { delayMs: 1500, code: 7, chunks: ["pre-ready output"] } });
	await stopping;
	expect(result.exit.outcome).toBe("stop"); expect(result.snap.deaths).toEqual([]);
	expect(result.snap.control.filter((c) => c.prefix === "launch-failed")).toEqual([]);
}, 20_000);
