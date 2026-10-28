/**
 * The self-heal detectors' readers (PLAN wl-mvbcjageg7o2yo § 2.3): every piece of I/O the eight
 * detectors need, so `detectors.ts` stays pure. Nothing here writes.
 *
 * - The ledger is queried read-only (the caller opens it `{ readonly: true }`); control lines go
 *   through `controlEntries`, so a body from the wrong writer is dropped as everywhere else.
 * - Session files are opened only when their mtime is at or after the window start (an hour
 *   before it for compactions, whose spans reach back that far), then streamed line by line; a
 *   substring prefilter runs before any JSON.parse, because one recorded loop session is 176 MB
 *   with lines up to 465,389 chars, and a whole-corpus reader was failure 6 itself.
 * - Jetsam reports are small (≤ 2 MB) and read whole; a directory or report that cannot be read
 *   is returned as unreadable, never as zero events.
 * - The profile's OMP logs (`<home>/.omp/profiles/<profile>/logs/omp.*.log` and their size rotations
 *   `.log.1`, `.log.2`, …; one JSON object a line) are streamed like session files, mtime at or after
 *   the window start, prefiltered on `MCP tool load failed`. A profile with no logs directory yet has
 *   had no session, so no failure; a directory or log that cannot be read is returned as unreadable.
 */
import { accessSync, constants, createReadStream, type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { type EntryRow, LANE_RUNNER_BY, type Ledger, type QuestionRow } from "../../../ledger/src/index";
import { controlEntries, laneStarted, modelProblem } from "../launch";
import { parseTestRun } from "../test-run";
import {
	type BuilderLab, COMPACTION_LOOP, type CompactionSession, type DetectorInputs, type HandRouting, type HandSpawn, type JetsamReport,
	type LaneModelSet, type LaneStart, type McpLoadFailure, type OrchestratorSession, type SessionEvent, type TestRunVerdict,
} from "./detectors";
import type { Window } from "./types";

export const JETSAM_DIR = "/Library/Logs/DiagnosticReports";

export interface ReadOptions {
	/** Opened `Ledger.open(path, { readonly: true })` by the caller. */
	ledger: Ledger;
	home: string;
	profile: string;
	window: Window;
	/** Default `/Library/Logs/DiagnosticReports`. */
	jetsamDir?: string;
	/** Default `<home>/.agent-system-2/lanes`. */
	lanesDir?: string;
}

export async function readDetectorInputs(opts: ReadOptions): Promise<DetectorInputs> {
	const from = new Date(opts.window.from).toISOString();
	const to = new Date(opts.window.to).toISOString();
	const fromMs = Date.parse(from);
	const toMs = Date.parse(to);
	const lanesDir = opts.lanesDir ?? join(opts.home, ".agent-system-2", "lanes");
	const sessionsDir = join(opts.home, ".omp", "profiles", opts.profile, "agent", "sessions");
	const { ledger } = opts;
	return {
		compactionSessions: await readCompactions(lanesDir, fromMs - COMPACTION_LOOP.spanMs, toMs),
		orchestratorSessions: await readOrchestratorSessions(sessionsDir, fromMs),
		handSpawns: readHandSpawns(ledger, to),
		builderLabs: readBuilderLabs(ledger, to),
		handRoutings: readHandRoutings(ledger, from, to),
		ceilingQuestions: readCeilingQuestions(ledger, from, to),
		testRuns: readTestRuns(ledger, to),
		...readLaneStartsAndModels(ledger, to),
		jetsam: readJetsam(opts.jetsamDir ?? JETSAM_DIR, fromMs),
		mcpLoad: { profile: opts.profile, ...(await readMcpLoadFailures(join(opts.home, ".omp", "profiles", opts.profile, "logs"), fromMs, toMs)) },
	};
}

// ---- session files -----------------------------------------------------------------------------

/** Every `*.jsonl` under `root` (recursively, name order) whose mtime is at or after `sinceMs`; an unreadable directory holds none. */
export function jsonlFilesSince(root: string, sinceMs: number): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && e.name.endsWith(".jsonl")) {
				try {
					if (statSync(p).mtimeMs >= sinceMs) out.push(p);
				} catch {
					// vanished between the listing and the stat
				}
			}
		}
	};
	walk(root);
	return out;
}

/** Stream `path` one line at a time (1-based numbers); a file that cannot be opened yields nothing. */
async function eachLine(path: string, f: (line: string, n: number) => void): Promise<void> {
	try {
		accessSync(path, constants.R_OK);
	} catch {
		return;
	}
	const input = createReadStream(path, { encoding: "utf8" });
	const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	let n = 0;
	try {
		for await (const line of rl) f(line, ++n);
	} finally {
		rl.close();
		input.destroy();
	}
}

const parse = (line: string): Record<string, unknown> | null => {
	try {
		const v: unknown = JSON.parse(line);
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

const COMPACTION = '"type":"compaction"';

/** Compaction times in `[sinceMs, toMs)` per lane and hand session under `<lanesDir>/<wl>/sessions/**`. */
async function readCompactions(lanesDir: string, sinceMs: number, toMs: number): Promise<CompactionSession[]> {
	const out: CompactionSession[] = [];
	let workloads: string[];
	try {
		workloads = readdirSync(lanesDir).filter((n) => n.startsWith("wl-")).sort();
	} catch {
		return out;
	}
	for (const wl of workloads) {
		for (const path of jsonlFilesSince(join(lanesDir, wl, "sessions"), sinceMs)) {
			const times: string[] = [];
			await eachLine(path, (line) => {
				if (!line.includes(COMPACTION)) return;
				const v = parse(line);
				if (v === null || v.type !== "compaction" || typeof v.timestamp !== "string") return;
				const t = Date.parse(v.timestamp);
				if (t >= sinceMs && t < toMs) times.push(v.timestamp);
			});
			if (times.length > 0) out.push({ path, workloadId: workloadOfLanePath(lanesDir, path), times });
		}
	}
	return out;
}

/** The workload a file under `<lanesDir>/<wl>/sessions/` belongs to, from its path. */
function workloadOfLanePath(lanesDir: string, path: string): string | null {
	const [wl, sessions] = relative(lanesDir, path).split(sep);
	return wl !== undefined && wl.startsWith("wl-") && sessions === "sessions" ? wl : null;
}

const USER = '"role":"user"';
const INPUT_TYPES = ["surface-input", "surface-jo-input"] as const;
const INPUT_MARKS = INPUT_TYPES.map((t) => `"customType":"${t}"`);

/** User messages and surface input entries, in file order, of every orchestrator session changed since `sinceMs`. */
async function readOrchestratorSessions(sessionsDir: string, sinceMs: number): Promise<OrchestratorSession[]> {
	const out: OrchestratorSession[] = [];
	for (const path of jsonlFilesSince(sessionsDir, sinceMs)) {
		const events: SessionEvent[] = [];
		await eachLine(path, (line, n) => {
			if (!line.includes(USER) && !INPUT_MARKS.some((m) => line.includes(m))) return;
			const v = parse(line);
			if (v === null) return;
			const at = typeof v.timestamp === "string" ? v.timestamp : "";
			const id = typeof v.id === "string" ? v.id : null;
			const message = v.message;
			if (v.type === "message" && message !== null && typeof message === "object" && "role" in message && message.role === "user") {
				events.push({ line: n, kind: "user", at, id });
			} else if (v.type === "custom" && (INPUT_TYPES as readonly unknown[]).includes(v.customType)) {
				events.push({ line: n, kind: "input", at, id });
			}
		});
		if (events.length > 0) out.push({ path, events });
	}
	return out;
}

// ---- ledger ------------------------------------------------------------------------------------

function entriesLike(ledger: Ledger, prefix: string, to: string): EntryRow[] {
	return ledger.db.query<EntryRow, [string, string]>(
		"SELECT * FROM entries WHERE kind = 'assumption' AND body LIKE ? AND created_at < ? ORDER BY created_at, rowid",
	).all(`${prefix}%`, to);
}

const HAND_SPAWN = /^hand-spawn: (\S+) session (.+?) spawn (\S+) review (yes|no)(?:\s|$)/;

function readHandSpawns(ledger: Ledger, to: string): HandSpawn[] {
	const out: HandSpawn[] = [];
	for (const e of entriesLike(ledger, "hand-spawn: ", to)) {
		const m = HAND_SPAWN.exec(e.body.trim());
		if (!m) continue;
		out.push({ entryId: e.id, workloadId: e.workload_id, laneId: e.created_by, at: e.created_at, sessionRoot: m[2]!, spawnKey: m[3]!, review: m[4] === "yes" });
	}
	return out;
}

const BUILDER_LAB = /^builder-lab: (\S+) lane (lane-\S+) model \S+/;

function readBuilderLabs(ledger: Ledger, to: string): BuilderLab[] {
	const out: BuilderLab[] = [];
	for (const e of entriesLike(ledger, "builder-lab: ", to)) {
		const m = BUILDER_LAB.exec(e.body.trim());
		if (m) out.push({ entryId: e.id, workloadId: e.workload_id, laneId: m[2]!, at: e.created_at, lab: m[1]! });
	}
	return out;
}

function readHandRoutings(ledger: Ledger, from: string, to: string): HandRouting[] {
	const rows = ledger.db.query<{ id: string; workload_id: string; session_root: string; spawn_key: string | null; ran_models: string; created_at: string }, [string, string]>(
		"SELECT id, workload_id, session_root, spawn_key, ran_models, created_at FROM routings WHERE ran_models IS NOT NULL AND created_at >= ? AND created_at < ? ORDER BY created_at, rowid",
	).all(from, to);
	const out: HandRouting[] = [];
	for (const r of rows) {
		let ran: unknown;
		try {
			ran = JSON.parse(r.ran_models);
		} catch {
			continue;
		}
		if (!Array.isArray(ran) || !ran.every((m) => typeof m === "string")) continue;
		out.push({ id: r.id, workloadId: r.workload_id, sessionRoot: r.session_root, spawnKey: r.spawn_key, ranModels: ran as string[], at: r.created_at });
	}
	return out;
}

/** Historical runner ceiling questions remain in the ledger after the ceiling-notice cutover. */
function readCeilingQuestions(ledger: Ledger, from: string, to: string): DetectorInputs["ceilingQuestions"] {
	const rows = ledger.db.query<QuestionRow, [string, string]>(
		"SELECT * FROM questions WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid",
	).all(from, to);
	return rows
		.filter((q) => q.created_by === LANE_RUNNER_BY && q.slice_id.startsWith("sl-ceiling-") && ledger.slice(q.slice_id) !== null)
		.map((q) => ({ id: q.id, workloadId: q.workload_id, at: q.created_at, body: q.body }));
}

function readTestRuns(ledger: Ledger, to: string): TestRunVerdict[] {
	const rows = entriesLike(ledger, "test-run: ", to);
	const workloadOf = new Map(rows.map((r) => [r.id, r.workload_id]));
	const out: TestRunVerdict[] = [];
	for (const c of controlEntries(rows)) {
		if (c.prefix !== "test-run") continue;
		const r = parseTestRun(c.body);
		if (r !== null) out.push({ entryId: c.id, workloadId: workloadOf.get(c.id)!, at: c.createdAt, verdict: r.verdict, sha: r.sha, pr: r.pr });
	}
	return out;
}

/**
 * Per lane, the first `lane-started:` time and the `ranModel` of the row carrying it (each lane has
 * two rows, the first with `ranModel: null`); and every `lane-model:` naming a model (not `default`).
 */
function readLaneStartsAndModels(ledger: Ledger, to: string): { laneStarts: LaneStart[]; laneModels: LaneModelSet[] } {
	const rows = ledger.db.query<EntryRow, [string]>(
		"SELECT * FROM entries WHERE kind = 'assumption' AND (body LIKE 'lane-started: %' OR body LIKE 'lane-model: %') AND created_at < ? ORDER BY created_at, rowid",
	).all(to);
	const workloadOf = new Map(rows.map((r) => [r.id, r.workload_id]));
	const starts = new Map<string, { workloadId: string; laneId: string; at: string; entryId: string | null; ranModel: string | null }>();
	const laneModels: LaneModelSet[] = [];
	for (const c of controlEntries(rows)) {
		const workloadId = workloadOf.get(c.id)!;
		if (c.prefix === "lane-started" && c.laneId !== null) {
			const key = `${workloadId} ${c.laneId}`;
			const s = starts.get(key) ?? { workloadId, laneId: c.laneId, at: c.createdAt, entryId: null, ranModel: null };
			starts.set(key, s);
			const ran = laneStarted([c])?.ranModel ?? null;
			if (s.ranModel === null && ran !== null) {
				s.ranModel = ran;
				s.entryId = c.id;
			}
		} else if (c.prefix === "lane-model") {
			const sel = c.rest.split(/\s+/, 1)[0] ?? "";
			if (sel !== "default" && modelProblem(sel) === null) laneModels.push({ entryId: c.id, workloadId, at: c.createdAt, model: sel });
		}
	}
	const laneStarts: LaneStart[] = [];
	for (const s of starts.values()) {
		if (s.ranModel !== null && s.entryId !== null) laneStarts.push({ workloadId: s.workloadId, laneId: s.laneId, at: s.at, entryId: s.entryId, ranModel: s.ranModel });
	}
	return { laneStarts, laneModels };
}

// ---- Jetsam reports ----------------------------------------------------------------------------

const JETSAM_NAME = /^JetsamEvent-.*\.ips$/;

/** Every `JetsamEvent-*.ips` in `dir` changed since `sinceMs`, parsed; what cannot be read or parsed is listed as unreadable. */
function readJetsam(dir: string, sinceMs: number): DetectorInputs["jetsam"] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => JETSAM_NAME.test(n)).sort();
	} catch {
		return { reports: [], unreadable: [dir] };
	}
	const reports: JetsamReport[] = [];
	const unreadable: string[] = [];
	for (const name of names) {
		const path = join(dir, name);
		let text: string;
		try {
			if (statSync(path).mtimeMs < sinceMs) continue;
			text = readFileSync(path, "utf8");
		} catch {
			unreadable.push(path);
			continue;
		}
		const r = parseJetsam(path, text);
		if (r === null) unreadable.push(path);
		else reports.push(r);
	}
	return { reports, unreadable };
}

/** A report's header line carries `timestamp` (`2026-10-14 05:30:54.00 -0700`); the body carries `memoryStatus.pageSize` and `processes[]` with `name` and `rpages`. */
export function parseJetsam(path: string, text: string): JetsamReport | null {
	const nl = text.indexOf("\n");
	if (nl < 0) return null;
	const header = parse(text.slice(0, nl));
	const body = parse(text.slice(nl + 1));
	if (header === null || body === null) return null;
	const at = typeof header.timestamp === "string" ? jetsamTime(header.timestamp) : null;
	const status = body.memoryStatus;
	const pageSize = status !== null && typeof status === "object" && "pageSize" in status ? status.pageSize : body.pageSize;
	if (at === null || typeof pageSize !== "number" || !(pageSize > 0)) return null;
	let largest: JetsamReport["largest"] = null;
	for (const p of Array.isArray(body.processes) ? body.processes : []) {
		if (p === null || typeof p !== "object" || !("name" in p) || !("rpages" in p)) continue;
		const { name, rpages } = p;
		if (typeof name !== "string" || typeof rpages !== "number") continue;
		if (largest === null || rpages > largest.pages) largest = { name, pages: rpages };
	}
	return { path, at, pageSize, largest };
}

/** `YYYY-MM-DD HH:MM:SS[.ff] ±HHMM` as an ISO instant, or null. */
function jetsamTime(s: string): string | null {
	const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))? ([+-])(\d\d)(\d\d)$/.exec(s.trim());
	if (!m) return null;
	const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
	const frac = m[7] === undefined ? 0 : Math.round(Number(`0.${m[7]}`) * 1000);
	const offset = (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
	const t = Date.UTC(y, mo - 1, d, h, mi, sec, frac) - offset * 60_000;
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ---- OMP logs ------------------------------------------------------------------------------------

const MCP_LOAD_FAILED = "MCP tool load failed";
/** OMP's process logs, `omp.<day>.<pid>.log`, and their size rotations `.log.1`, `.log.2`, … (pi-utils logger/rotating-file.ts). */
const OMP_LOG_NAME = /^omp\..*\.log(?:\.\d+)?$/;

const isMissing = (e: unknown): boolean => e instanceof Error && "code" in e && e.code === "ENOENT";

/**
 * Every `MCP tool load failed` line in `[sinceMs, toMs)` from the OMP logs in `dir` (name order), rotations
 * included, whose mtime is at or after `sinceMs`. A missing `dir` (no session has run under the profile) or a
 * log that vanished after the listing holds none; a `dir` or a log that cannot be read is listed in
 * `unreadable`, never read as zero failures.
 */
export async function readMcpLoadFailures(dir: string, sinceMs: number, toMs: number): Promise<{ failures: McpLoadFailure[]; unreadable: string[] }> {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => OMP_LOG_NAME.test(n)).sort();
	} catch (e) {
		return { failures: [], unreadable: isMissing(e) ? [] : [dir] };
	}
	const failures: McpLoadFailure[] = [];
	const unreadable: string[] = [];
	for (const name of names) {
		const path = join(dir, name);
		try {
			if (statSync(path).mtimeMs < sinceMs) continue;
			accessSync(path, constants.R_OK);
		} catch (e) {
			if (!isMissing(e)) unreadable.push(path);
			continue;
		}
		await eachLine(path, (text, line) => {
			if (!text.includes(MCP_LOAD_FAILED)) return;
			const o = parse(text);
			if (o === null || o.message !== MCP_LOAD_FAILED || typeof o.timestamp !== "string" || typeof o.path !== "string") return;
			const t = Date.parse(o.timestamp);
			if (!Number.isFinite(t) || t < sinceMs || t >= toMs) return;
			failures.push({ path, line, at: new Date(t).toISOString(), server: o.path.replace(/^mcp:/, ""), error: typeof o.error === "string" ? o.error : String(o.error) });
		});
	}
	return { failures, unreadable };
}
