/**
 * The eight self-heal detectors (PLAN wl-mvbcjageg7o2yo § 2.3), pure: each one reads inputs
 * `read.ts` has already gathered and returns findings; nothing here touches a file, the ledger
 * or the clock. The thresholds are this plan's choice and every summary states the one it used.
 *
 * Two rules hold for every detector (R10):
 * - A finding takes the time of the event that completes it (the 20th compaction of a span, the
 *   second `test-run:` of the opposite verdict, the `lane-model:`, the routing row written at hand
 *   end), and `runDetectors` keeps it only when that time lies in the window `[from, to)`. So a
 *   pair straddling `from` is reported once, in the window holding its second event.
 * - One finding per subject: per burst (compaction-loop), per routing (hand-lab), per message
 *   (paste-drop), per question (ceiling-wall), per sha (flaky-test), per report (jetsam), per lane
 *   (model-start), per server and failure (mcp-load).
 */
import { labOf } from "../../../classifier/src/lab";
import type { DetectorId, Finding, Window } from "./types";

/** ≥ 20 compactions inside any 60-minute span is a loop. */
export const COMPACTION_LOOP = { count: 20, spanMs: 60 * 60_000 } as const;
/** A ceiling question is wall-led when minutes are ≥ 80 % used while dollars are < 30 % used. */
export const CEILING_WALL = { minuteShare: 0.8, dollarShare: 0.3 } as const;
/** A `lane-model:` within 10 minutes after a lane started races that lane's start. */
export const MODEL_START_MS = 10 * 60_000;
/** The summary of the one finding an unreadable Jetsam directory or report gives. */
export const JETSAM_UNREADABLE = "jetsam: unreadable";

// ---- inputs ------------------------------------------------------------------------------------

/** One session file's compaction times (any order), from `from − 60 min` on. */
export interface CompactionSession {
	path: string;
	/** The workload whose lane directory holds the file, or null. */
	workloadId: string | null;
	times: string[];
}

/** A user message or a surface input entry of an orchestrator session, in file order. */
export interface SessionEvent {
	/** 1-based line in the session file. */
	line: number;
	kind: "user" | "input";
	at: string;
	/** The entry's own id in the session, or null. */
	id: string | null;
}

export interface OrchestratorSession {
	path: string;
	events: SessionEvent[];
}

/** A `hand-spawn: <token> session <root> spawn <key> review <yes|no> …` entry. */
export interface HandSpawn {
	entryId: string;
	workloadId: string;
	/** The entry's writer (the spawning lane). */
	laneId: string;
	at: string;
	sessionRoot: string;
	spawnKey: string;
	review: boolean;
}

/** A `builder-lab: <lab> lane <laneId> model <m>` entry (the `hand` form is not a lane's lab). */
export interface BuilderLab {
	entryId: string;
	workloadId: string;
	laneId: string;
	at: string;
	lab: string;
}

/** A `routings` row whose hand ran (`ran_models` read); its time is the row's, written at hand end. */
export interface HandRouting {
	id: string;
	workloadId: string;
	sessionRoot: string;
	spawnKey: string | null;
	ranModels: string[];
	at: string;
}

/** A historical runner ceiling question: its id, workload, time and body. */
export interface CeilingQuestion {
	id: string;
	workloadId: string;
	at: string;
	body: string;
}

/** A valid `test-run:` (writer and body checked by the reader). */
export interface TestRunVerdict {
	entryId: string;
	workloadId: string;
	at: string;
	verdict: string;
	sha: string;
	pr: number;
}

/** One lane's start: the time of its first `lane-started:` and the model the runner read once OMP answered. */
export interface LaneStart {
	workloadId: string;
	laneId: string;
	/** The first `lane-started:` of the lane. */
	at: string;
	/** The entry carrying the non-null `ranModel`. */
	entryId: string;
	ranModel: string;
}

/** A valid `lane-model: <provider/model>` (a `default` is not a model and is left out by the reader). */
export interface LaneModelSet {
	entryId: string;
	workloadId: string;
	at: string;
	model: string;
}

/** A readable JetsamEvent report. */
export interface JetsamReport {
	path: string;
	at: string;
	pageSize: number;
	/** The process with the most resident pages, or null when the report lists none. */
	largest: { name: string; pages: number } | null;
}

/** One `MCP tool load failed` line from an OMP log of the profile: the server it names and its error. */
export interface McpLoadFailure {
	/** The log file and its 1-based line. */
	path: string;
	line: number;
	at: string;
	/** The server name, `mcp:` stripped. */
	server: string;
	error: string;
}

export interface DetectorInputs {
	compactionSessions: CompactionSession[];
	orchestratorSessions: OrchestratorSession[];
	handSpawns: HandSpawn[];
	builderLabs: BuilderLab[];
	handRoutings: HandRouting[];
	ceilingQuestions: CeilingQuestion[];
	testRuns: TestRunVerdict[];
	laneStarts: LaneStart[];
	laneModels: LaneModelSet[];
	/** `unreadable`: the directory or the report files that could not be read (each counted, never as zero events). */
	jetsam: { reports: JetsamReport[]; unreadable: string[] };
	/** `profile`: the OMP profile whose logs were read; `unreadable`: its logs directory or the logs that could not be read (never as zero failures). */
	mcpLoad: { profile: string; failures: McpLoadFailure[]; unreadable: string[] };
}

// ---- the detectors -----------------------------------------------------------------------------

const ms = (iso: string): number => Date.parse(iso);
const finding = (detector: DetectorId, at: string, workloadId: string | null, laneId: string | null, summary: string, evidence: string): Finding => ({
	detector, at, workloadId, laneId, summary, evidence,
});
const iso = (t: number): string => new Date(t).toISOString();

/** A run of overlapping qualifying spans: first event, last event, when it first reached the count, and when it first did inside the window. */
interface Burst {
	start: number;
	end: number;
	firstReached: number;
	reachedInWindow: number | null;
}

/**
 * compaction-loop, per session: a qualifying span ends at a compaction with ≥ 19 more inside the
 * 60 minutes before it; overlapping spans merge into one burst. A burst is reported in a window
 * where one of its spans completes, timed at the first such completion, `continuing` when it had
 * already reached 20 before `from`; its count is its compactions inside the window.
 */
export function compactionLoop(sessions: readonly CompactionSession[], w: Window): Finding[] {
	const out: Finding[] = [];
	const from = ms(w.from);
	const to = ms(w.to);
	for (const s of sessions) {
		const t = s.times.map(ms).filter((x) => Number.isFinite(x) && x >= from - COMPACTION_LOOP.spanMs && x < to).sort((a, b) => a - b);
		let burst: Burst | null = null;
		const emit = (b: Burst): void => {
			if (b.reachedInWindow === null) return;
			const count = t.filter((x) => x >= b.start && x <= b.end && x >= from).length;
			const continuing = b.firstReached < from;
			out.push(finding("compaction-loop", iso(b.reachedInWindow), s.workloadId, null,
				`compaction loop: ${count} compactions in the window, ${COMPACTION_LOOP.count} within ${COMPACTION_LOOP.spanMs / 60_000} min by ${iso(b.reachedInWindow)}${continuing ? " (continuing)" : ""}`,
				`${s.path} burst ${iso(b.start)}..${iso(b.end)}`));
		};
		let j = 0;
		for (let i = 0; i < t.length; i++) {
			while (t[i]! - t[j]! >= COMPACTION_LOOP.spanMs) j++;
			if (i - j + 1 < COMPACTION_LOOP.count) continue;
			const start = t[j]!;
			const end = t[i]!;
			if (burst !== null && start <= burst.end) {
				burst.end = end;
			} else {
				if (burst !== null) emit(burst);
				burst = { start, end, firstReached: end, reachedInWindow: null };
			}
			if (burst.reachedInWindow === null && end >= from) burst.reachedInWindow = end;
		}
		if (burst !== null) emit(burst);
	}
	return out;
}

/**
 * hand-lab: a `review no` hand whose routing ran on a lab other than its own lane's newest
 * `builder-lab:` before the spawn (another lane's builder lab says nothing about this hand). The spawn is the newest `hand-spawn:` on the routing's
 * workload with the routing's session root and spawn key, at or before the routing row. A model
 * on an unknown provider proves nothing and is not counted.
 */
export function handLab(spawns: readonly HandSpawn[], labs: readonly BuilderLab[], routings: readonly HandRouting[]): Finding[] {
	const out: Finding[] = [];
	for (const r of routings) {
		if (r.spawnKey === null) continue;
		const spawn = spawns
			.filter((s) => s.workloadId === r.workloadId && s.sessionRoot === r.sessionRoot && s.spawnKey === r.spawnKey && ms(s.at) <= ms(r.at))
			.reduce<HandSpawn | null>((a, s) => (a === null || ms(s.at) >= ms(a.at) ? s : a), null);
		if (spawn === null || spawn.review) continue;
		const lab = labs
			.filter((l) => l.workloadId === r.workloadId && l.laneId === spawn.laneId && ms(l.at) <= ms(spawn.at))
			.reduce<BuilderLab | null>((a, l) => (a === null || ms(l.at) >= ms(a.at) ? l : a), null);
		if (lab === null) continue;
		const off = r.ranModels.filter((m) => {
			const l = labOf(m);
			return l !== null && l !== lab.lab;
		});
		if (off.length === 0) continue;
		out.push(finding("hand-lab", r.at, r.workloadId, spawn.laneId,
			`hand-lab: build hand ${r.spawnKey} ran on ${off.join(", ")}, off the lane's builder-lab ${lab.lab}`,
			`routing ${r.id}, hand-spawn ${spawn.entryId}, builder-lab ${lab.entryId}`));
	}
	return out;
}

/**
 * paste-drop: in a session holding at least one `surface-input` / `surface-jo-input` entry, a user
 * message with no such entry since the previous user message (or the session start).
 */
export function pasteDrop(sessions: readonly OrchestratorSession[]): Finding[] {
	const out: Finding[] = [];
	for (const s of sessions) {
		if (!s.events.some((e) => e.kind === "input")) continue;
		let echoed = false;
		for (const e of s.events) {
			if (e.kind === "input") {
				echoed = true;
				continue;
			}
			if (!echoed) {
				out.push(finding("paste-drop", e.at, null, null,
					`paste-drop: a user message reached the session with no surface input entry before it`,
					`${s.path}:${e.line}${e.id === null ? "" : ` (id ${e.id})`}`));
			}
			echoed = false;
		}
	}
	return out;
}

/** The historical runner ceiling question's first line; the shares are its floored percentages of the unrounded figures. */
const CEILING_BODY = /has used \$(\d+(?:\.\d+)?) of its \$(\d+(?:\.\d+)?) ceiling \((\d+) %\) and (\d+) of (\d+) minutes \((\d+) %\)/;

/** ceiling-wall: a ceiling question whose minutes are ≥ 80 % used while its dollars are < 30 % used. */
export function ceilingWall(questions: readonly CeilingQuestion[]): Finding[] {
	const out: Finding[] = [];
	for (const q of questions) {
		const m = CEILING_BODY.exec(q.body);
		if (!m) continue;
		const [usd, usdCap, usdPct, min, minCap, minPct] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
		if (minPct < CEILING_WALL.minuteShare * 100 || usdPct >= CEILING_WALL.dollarShare * 100) continue;
		out.push(finding("ceiling-wall", q.at, q.workloadId, null,
			`ceiling-wall: ${min} of ${minCap} minutes (${minPct} %) against $${usd} of $${usdCap} (${usdPct} %); wall-led at ≥ ${CEILING_WALL.minuteShare * 100} % minutes and < ${CEILING_WALL.dollarShare * 100} % dollars`,
			`question ${q.id}`));
	}
	return out;
}

/** flaky-test: one sha with both a `green` and a `red` `test-run:`, timed at the first run that completes the pair. */
export function flakyTest(runs: readonly TestRunVerdict[]): Finding[] {
	const out: Finding[] = [];
	const bySha = new Map<string, TestRunVerdict[]>();
	for (const r of runs) {
		if (r.verdict !== "green" && r.verdict !== "red") continue;
		bySha.set(r.sha, [...(bySha.get(r.sha) ?? []), r]);
	}
	for (const [sha, list] of bySha) {
		const sorted = [...list].sort((a, b) => ms(a.at) - ms(b.at));
		const first: Partial<Record<"green" | "red", TestRunVerdict>> = {};
		for (const r of sorted) {
			const v = r.verdict as "green" | "red";
			first[v] ??= r;
			if (first.green && first.red) {
				const other = v === "green" ? first.red : first.green;
				out.push(finding("flaky-test", r.at, r.workloadId, null,
					`flaky-test: sha ${sha.slice(0, 7)} (PR #${r.pr}) ran ${other.verdict} then ${r.verdict}`,
					`test-run ${other.entryId} ${other.verdict}, ${r.entryId} ${r.verdict}`));
				break;
			}
		}
	}
	return out;
}

/** jetsam: one finding per report (its largest process in MB), and one `jetsam: unreadable` when anything could not be read. */
export function jetsam(input: DetectorInputs["jetsam"], w: Window): Finding[] {
	const out: Finding[] = input.reports.map((r) => {
		const summary = r.largest === null
			? "jetsam: a memory-pressure report with no process list"
			: `jetsam: largest process ${r.largest.name} ${Math.round((r.largest.pages * r.pageSize) / 1_048_576)} MB (${r.largest.pages} pages × ${r.pageSize} B)`;
		return finding("jetsam", r.at, null, null, summary, r.path);
	});
	if (input.unreadable.length > 0) out.push(finding("jetsam", w.from, null, null, JETSAM_UNREADABLE, input.unreadable.join(", ")));
	return out;
}

/**
 * model-start: a `lane-model: <m>` within 10 minutes after a lane's first `lane-started:` on the
 * same workload, when the model that lane started on differs from m; one finding per lane, at its
 * first such `lane-model:`.
 */
export function modelStart(starts: readonly LaneStart[], models: readonly LaneModelSet[]): Finding[] {
	const out: Finding[] = [];
	const sorted = [...models].sort((a, b) => ms(a.at) - ms(b.at));
	for (const s of starts) {
		const t0 = ms(s.at);
		const m = sorted.find((x) => x.workloadId === s.workloadId && ms(x.at) >= t0 && ms(x.at) - t0 <= MODEL_START_MS && x.model !== s.ranModel);
		if (m === undefined) continue;
		out.push(finding("model-start", m.at, s.workloadId, s.laneId,
			`model-start: ${s.laneId} started on ${s.ranModel}, then lane-model ${m.model} ${Math.round((ms(m.at) - t0) / 1000)} s later (≤ ${MODEL_START_MS / 60_000} min)`,
			`lane-started ${s.entryId}, lane-model ${m.entryId}`));
	}
	return out;
}

/** The failure an MCP load error names: `HTTP <status>` when it carries one, else its first 80 characters. */
export function mcpFailureKind(error: string): string {
	const http = /^HTTP (\d{3})\b/.exec(error);
	if (http) return `HTTP ${http[1]}`;
	const line = error.split("\n")[0]!.trim();
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** OMP's default profile: an empty name or `default` (pi-utils dirs.ts normalizeProfileName), kept in `~/.omp` rather than `~/.omp/profiles/<name>`. */
export function isDefaultOmpProfile(profile: string): boolean {
	const p = profile.trim();
	return p === "" || p === "default";
}

/** The command that starts OMP in `profile`: the default profile with OMP_PROFILE cleared, any other with it set. */
export function ompLaunch(profile: string): string {
	return isDefaultOmpProfile(profile) ? "env -u OMP_PROFILE omp" : `OMP_PROFILE=${profile.trim()} omp`;
}

/** The summary of the one finding unreadable OMP logs give. */
export const MCP_LOAD_UNREADABLE = "mcp-load: OMP logs unreadable";

/**
 * mcp-load: a server OMP could not load in the profile, so its tools were missing from every session
 * that started then. One finding per server and failure kind, at its last failure in the window,
 * counting the failures in the window. These are past events: a login that failed then may work now
 * (OMP refreshed it, or it was redone), so an HTTP 401 or 403 says the login's current health is
 * unknown and points at the check, never at reauthentication. And one `mcp-load: OMP logs unreadable`
 * when the logs directory or any log could not be read.
 */
export function mcpLoad(input: DetectorInputs["mcpLoad"], w: Window): Finding[] {
	const from = ms(w.from);
	const to = ms(w.to);
	const groups = new Map<string, McpLoadFailure[]>();
	for (const f of input.failures) {
		if (ms(f.at) < from || ms(f.at) >= to) continue;
		const key = `${f.server}\u0000${mcpFailureKind(f.error)}`;
		const list = groups.get(key);
		if (list) list.push(f);
		else groups.set(key, [f]);
	}
	const out: Finding[] = [];
	for (const list of groups.values()) {
		const sorted = [...list].sort((a, b) => ms(a.at) - ms(b.at));
		const first = sorted[0]!;
		const last = sorted[sorted.length - 1]!;
		const kind = mcpFailureKind(last.error);
		const login = kind === "HTTP 401" || kind === "HTTP 403"
			? `; current login health unknown until a live load: start \`${ompLaunch(input.profile)}\` and see whether ${last.server} loads`
			: "";
		out.push(finding("mcp-load", last.at, null, null,
			`mcp-load: ${last.server} failed to load ${sorted.length} time(s) in the window in profile ${input.profile}: ${kind}${login}`,
			sorted.length === 1 ? `${first.path}:${first.line}` : `${first.path}:${first.line} .. ${last.path}:${last.line}`));
	}
	if (input.unreadable.length > 0) out.push(finding("mcp-load", w.from, null, null, MCP_LOAD_UNREADABLE, input.unreadable.join(", ")));
	return out;
}

/** Every detector over `inputs`, the findings outside `[from, to)` dropped, oldest first. */
export function runDetectors(inputs: DetectorInputs, window: Window): Finding[] {
	const all = [
		...compactionLoop(inputs.compactionSessions, window),
		...handLab(inputs.handSpawns, inputs.builderLabs, inputs.handRoutings),
		...pasteDrop(inputs.orchestratorSessions),
		...ceilingWall(inputs.ceilingQuestions),
		...flakyTest(inputs.testRuns),
		...jetsam(inputs.jetsam, window),
		...modelStart(inputs.laneStarts, inputs.laneModels),
		...mcpLoad(inputs.mcpLoad, window),
	];
	const from = ms(window.from);
	const to = ms(window.to);
	return all.filter((f) => ms(f.at) >= from && ms(f.at) < to).sort((a, b) => ms(a.at) - ms(b.at) || a.detector.localeCompare(b.detector));
}
