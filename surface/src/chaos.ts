// The nightly chaos run's library (PLAN wl-mv45yxnkw2251c §§ 2.1, 2.4–2.6): the fault rotation and
// the 03:00 PT window, the per-poll judge and the verdict over its polls, the live-state isolation
// snapshot and its diff, and the report. surface/scripts/chaos.ts (the CLI) drives it.
//
// Reading and deciding are kept apart. Only these read anything: `judgePoll` (the throwaway ledger it
// is handed), `nightlyDue` / `reportPath` (a listing of the reports dir), `workloadRows`,
// `scratchWriteRefusal` (lstat of the scratch path it is handed), and `isolationSnapshot`, which
// gathers the live state read-only: the ledger opened `{ readonly: true }`, git run with
// `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks` so `git status` never rewrites the live
// `.git/index`, the linked worktrees' HEAD reflogs read as files, and lstat walks of the lanes
// roots. `verdict`, `killTargets`, `killRefusal`, `firstHolder`, `laneStarts`, `newStarts`,
// `secondRunnerJudgement`, `reflogBranchWrites`, `isolationDiff` and `renderReport` are pure
// functions of what they are handed. The only writers are the scratch writers (`writeScratchFile`,
// `copyIntoScratch`, `removeFromScratch`):
// they write under the scratch root they are handed and never through a symlink. Nothing here
// writes a ledger row.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Builders, builderLabs, parseHandSpawn, settledTokens } from "../../classifier/src/lab";
import type { HandSessionModels } from "../../classifier/src/hand-session";
import type { Ledger } from "../../ledger/src/index";
import { assertNotLiveLedgerUnderTest } from "../../ledger/src/locality";
import { type ErrorKind, errorLines } from "./errors";
import { STARTER_EXIT } from "./launch";

// ---- faults and the nightly rotation (§ 2.4 Rotation, § 2.6) ------------------------------------

/** The five faults, in rotation order: `--nightly` runs `FAULTS[daysSinceEpoch(PT date) % 5]`. */
export const FAULTS = ["lane-kill-mid-hand", "orchestrator-kill-mid-review", "network-block-60s", "provider-refusal", "duplicate-lane-runner"] as const;
export type FaultName = (typeof FAULTS)[number];

export function isFault(name: string): name is FaultName {
	return (FAULTS as readonly string[]).includes(name);
}

/** The zone the schedule and the report names are in, whatever the machine's own zone. */
export const PT_ZONE = "America/Los_Angeles";
/** `--nightly` proceeds only while the PT wall clock is in [03:00, 03:15): one quarter-hourly fire lands in it. */
export const NIGHTLY_START_MINUTE = 3 * 60;
export const NIGHTLY_END_MINUTE = 3 * 60 + 15;

const PT_FORMAT = new Intl.DateTimeFormat("en-US", {
	timeZone: PT_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The America/Los_Angeles wall-clock parts of an instant: `YYYY-MM-DD`, `HHMM`, and minutes since PT midnight. */
export function ptParts(at: Date): { day: string; hhmm: string; minuteOfDay: number } {
	const p: Record<string, string> = {};
	for (const part of PT_FORMAT.formatToParts(at)) p[part.type] = part.value;
	const hour = Number(p.hour) % 24;
	const minute = Number(p.minute);
	return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${String(hour).padStart(2, "0")}${p.minute}`, minuteOfDay: hour * 60 + minute };
}

/** Whole days from 1970-01-01 to a calendar date `YYYY-MM-DD`. */
export function daysSinceEpoch(day: string): number {
	const m = DAY.exec(day);
	if (!m) throw new Error(`not a YYYY-MM-DD date: ${day}`);
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/** The fault `--nightly` runs on a PT date (`YYYY-MM-DD`), or on the PT date of an instant. */
export function nightlyFault(date: Date | string): FaultName {
	const day = typeof date === "string" ? date : ptParts(date).day;
	const n = FAULTS.length;
	return FAULTS[((daysSinceEpoch(day) % n) + n) % n]!;
}

/** Whether the reports dir already holds a report for a PT date (`<date>-<fault>[-HHMM].md`). */
export function reportExists(reportsDir: string, day: string): boolean {
	if (!existsSync(reportsDir)) return false;
	return readdirSync(reportsDir).some((f) => f.startsWith(`${day}-`) && f.endsWith(".md"));
}

/**
 * Whether `--nightly` runs at `now` (§ 2.6): the America/Los_Angeles wall time is in [03:00, 03:15)
 * and that PT date has no report yet. Anything else exits 0 at once and writes nothing.
 */
export function nightlyDue(now: Date, reportsDir: string): boolean {
	const { day, minuteOfDay } = ptParts(now);
	if (minuteOfDay < NIGHTLY_START_MINUTE || minuteOfDay >= NIGHTLY_END_MINUTE) return false;
	return !reportExists(reportsDir, day);
}

/**
 * Where a run's report goes (§ 2.5): `<dir>/<PT date>-<fault>.md`; when that exists, `-<HHMM>` (PT)
 * is added instead of overwriting it, and `-<HHMM>-<n>` if a run already took that minute.
 */
export function reportPath(reportsDir: string, now: Date, fault: FaultName): string {
	const { day, hhmm } = ptParts(now);
	const base = join(reportsDir, `${day}-${fault}`);
	if (!existsSync(`${base}.md`)) return `${base}.md`;
	if (!existsSync(`${base}-${hhmm}.md`)) return `${base}-${hhmm}.md`;
	for (let n = 2; ; n++) if (!existsSync(`${base}-${hhmm}-${n}.md`)) return `${base}-${hhmm}-${n}.md`;
}

// ---- the judge (§ 2.4 Pass criterion) -----------------------------------------------------------

/** The judge polls every 5 s from injection; it decides within 300 s and re-checks 30 s after a pass. */
export const POLL_MS = 5_000;
export const WINDOW_MS = 300_000;
export const SETTLE_MS = 30_000;

/** A needs-you line as the judge keys it: `kind:rowId`. Its text is not identity (a death line's count changes). */
export function lineIdentity(line: { kind: string; rowId: string }): string {
	return `${line.kind}:${line.rowId}`;
}

export interface SeenLine {
	identity: string;
	kind: ErrorKind;
	rowId: string;
	/** The text at first sight and at the latest poll that showed it. */
	firstText: string;
	text: string;
	firstPoll: number;
	firstAt: string;
}

/** What the judge carries from poll to poll: how many polls ran and every line identity seen since injection. */
export interface Seen {
	polls: number;
	lines: ReadonlyMap<string, SeenLine>;
}

export function emptySeen(): Seen {
	return { polls: 0, lines: new Map() };
}

export interface Poll {
	/** 0 for the first poll after injection. */
	n: number;
	at: string;
	/** The needs-you lines naming the workload at this poll. */
	lines: { identity: string; kind: ErrorKind; rowId: string; text: string }[];
	/** `seen` with this poll merged in: pass it to the next poll. */
	seen: Seen;
	/** (a) one line: the identities unioned over every poll since injection number exactly one, and it is present now. */
	a: { ok: boolean; union: string[]; present: string[] };
	/** (b) no open slice that is both unheld and unsurfaced. */
	b: { ok: boolean; holder: string | null; liveHolder: boolean; openSlices: string[]; orphans: { sliceId: string; task: string }[] };
	/** (c) no hand of an exited lane whose fallback row `builderLabs` still counts. */
	c: { ok: boolean; exitedHands: string[]; counted: { token: string; lane: string; why: string }[] };
	/** `builderLabs(workload)` at this poll, for the report. */
	builders: Builders;
	ok: boolean;
}

const LANE_EXIT = /^lane-exit:\s+(lane-\S+)/;
const LANE_STARTED = /^lane-started:\s+(lane-\S+)/;
const BUILDER_LAB_ENTRY = /^builder-lab:/;
/**
 * Kinds whose single line accounts for open slices nobody holds: the death or the idle end was surfaced, or a taken pair
 * (the only `pair` line `judgePoll` keeps: an offer line rides its question's and is dropped; PLAN wl-mvb9mw00ycfjeo D5).
 */
const SURFACED_END: readonly ErrorKind[] = ["lane-died", "idle", "pair"];

/**
 * One judge poll of the throwaway ledger (§ 2.4): the needs-you lines naming `wl` from
 * `errorLines` (less offer-state `pair` lines, which add no line of their own to the one-line check),
 * merged into `seen`, and the three conditions.
 *
 * (c) does not re-decide which hands count: chaos reads only that a hand's spawning lane has exited
 * — a later `lane-exit:` naming that lane, or a later `lane-started:` of another lane, from any writer
 * — and asks `builderLabs` whether that hand's fallback row still contributes a lab. The hand is
 * isolated by asking `builderLabs` over the workload's entries without `builder-lab:` marks and
 * without the other spawns, with no routings and an empty session reader: anything it then counts
 * is that spawn's row, counted as live. A dead hand's answered models (read from its session file)
 * are legitimate builders and are not what (c) is about.
 */
export function judgePoll(
	ledger: Ledger,
	wl: string,
	seen: Seen,
	opts: { now?: string; sessionModels?: HandSessionModels } = {},
): Poll {
	const now = opts.now ?? ledger.now();
	const n = seen.polls;
	const lines = errorLines(ledger, ledger.inFlight(), { now })
		.filter((l) => l.workloadId === wl && !(l.kind === "pair" && l.state === "offer"))
		.map((l) => ({ identity: lineIdentity(l), kind: l.kind, rowId: l.rowId, text: l.line }));
	const merged = new Map(seen.lines);
	for (const l of lines) {
		const prior = merged.get(l.identity);
		merged.set(l.identity, prior ? { ...prior, text: l.text } : { identity: l.identity, kind: l.kind, rowId: l.rowId, firstText: l.text, text: l.text, firstPoll: n, firstAt: now });
	}
	// Both in one defined order, by identity (`kind:rowId`, so by kind first): neither depends on when a line was first seen
	// nor on errorLines' § B3 order, and the report's union and present lists read alike.
	const byIdentity = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
	const union = [...merged.keys()].sort(byIdentity);
	const present = lines.map((l) => l.identity).sort(byIdentity);
	const a = { ok: union.length === 1 && present.includes(union[0]!), union, present };

	const workload = ledger.workload(wl);
	const holder = workload?.holder ?? null;
	const liveHolder = holder !== null && (workload!.holder_lease_until === null || workload!.holder_lease_until >= now);
	const open = ledger.slices(wl).filter((s) => s.state === "open");
	const single = union.length === 1 ? merged.get(union[0]!)! : null;
	const surfaced = single !== null && SURFACED_END.includes(single.kind);
	const orphans = liveHolder || surfaced ? [] : open.map((s) => ({ sliceId: s.id, task: s.task }));
	const b = { ok: orphans.length === 0, holder, liveHolder, openSlices: open.map((s) => s.id), orphans };

	const entries = ledger.entries(wl);
	const settled = settledTokens(entries);
	const exitedHands: string[] = [];
	const counted: { token: string; lane: string; why: string }[] = [];
	entries.forEach((e, at) => {
		if (e.kind !== "assumption") return;
		const spawn = parseHandSpawn(e.body);
		if (!spawn || settled.has(spawn.token)) return;
		const lane = e.created_by;
		const exit = entries.slice(at + 1).find((x) => {
			if (x.kind !== "assumption") return false;
			const body = x.body.trim();
			return LANE_EXIT.exec(body)?.[1] === lane || (LANE_STARTED.exec(body)?.[1] ?? lane) !== lane;
		});
		if (!exit) return;
		exitedHands.push(spawn.token);
		const alone = entries.filter((x, i) => i === at || x.kind !== "assumption" || (!BUILDER_LAB_ENTRY.test(x.body.trim()) && parseHandSpawn(x.body) === null));
		const view = { entries: () => alone, routings: () => [] };
		const own = builderLabs(view, wl, new Set(), () => []);
		const unknown = own.unknown.filter((u) => u.startsWith(`unsettled hand ${spawn.token} `));
		if (own.labs.length > 0 || unknown.length > 0) {
			const what = [...own.labs, ...unknown].join("; ");
			counted.push({ token: spawn.token, lane, why: `lane ${lane} exited (${exit.body.trim().split(/\s+/).slice(0, 2).join(" ")}, entry ${exit.id}) and builderLabs still counts its row: ${what}` });
		}
	});
	const c = { ok: counted.length === 0, exitedHands, counted };
	const builders = opts.sessionModels ? builderLabs(ledger, wl, new Set(), opts.sessionModels) : builderLabs(ledger, wl);
	return { n, at: now, lines, seen: { polls: n + 1, lines: merged }, a, b, c, builders, ok: a.ok && b.ok && c.ok };
}

// ---- fault evidence and the verdict (§ 2.4 Decision) --------------------------------------------

/** Fault 5's evidence that `lane.ts run` on the live lane id refused: exit 7 "already running", no start record, no omp. */
export const SECOND_RUNNER_EVIDENCE = "second runner refused (exit 7, already running), wrote no lane-started and spawned no omp";

/**
 * The evidence each fault must show, by name: the CLI records one `EvidenceItem` per name, and a
 * name never recorded is a harness error. Items the plan calls a system FAIL rather than a harness
 * error when missed carry `systemFault` (fault 5's second runner and the single holder).
 */
export const FAULT_EVIDENCE: Readonly<Record<FaultName, readonly string[]>> = {
	"lane-kill-mid-hand": ["kill returned 0", "held hand connection dropped", "lane-exit or lane-died followed"],
	"orchestrator-kill-mid-review": ["old orchestrator pid gone", "new orchestrator wake read after restart", "review hand held at the kill", "review hand settled"],
	"network-block-60s": ["provider connection held in the window", "window lasted at least 60 s"],
	"provider-refusal": ["refusal served to a lane request", "lane-died body names Refusal (cyber) and retryable false"],
	"duplicate-lane-runner": ["second launch exited held", SECOND_RUNNER_EVIDENCE, "first lane held throughout, no second lane held or reserved"],
};

export interface EvidenceItem {
	name: string;
	/** What was observed, for the report. */
	observed: string;
	/** When it first held; null when never observed. */
	at: string | null;
	/** When a later observation contradicted it. */
	lostAt?: string | null;
	/** A miss is the system's FAIL, not a harness error. */
	systemFault?: boolean;
}

export interface Evidence {
	fault: FaultName;
	injectedAt: string;
	items: EvidenceItem[];
	/** Assistant messages that came back without the run nonce. */
	nonceMisses: string[];
	/** Egress-proxy attempts in the measured phase (workload open to the end of the settle re-check). */
	egress: string[];
	/** Other harness errors the CLI saw (an unrouted model id, no `/v1/systemone` before the first hand-spawn). */
	harness: string[];
}

export type VerdictKind = "PASS" | "FAIL" | "HARNESS-ERROR";

export interface Verdict {
	verdict: VerdictKind;
	reason: string;
	/** The first poll where (a), (b), (c) held with the evidence complete, if any. */
	deciding: Poll | null;
	/** The first poll at or after the deciding poll plus the settle. */
	settle: Poll | null;
	/** Milliseconds from injection to the poll that decided the run (pass, or the poll that failed it). */
	atMs: number | null;
	/** The last poll judged. */
	last: Poll | null;
}

const ms = (iso: string): number => Date.parse(iso);

function holdsAt(item: EvidenceItem, t: number): boolean {
	return item.at !== null && ms(item.at) <= t && (item.lostAt == null || ms(item.lostAt) > t);
}

export function describeA(p: Poll): string {
	return `${p.a.ok ? "holds" : "fails"}: ${p.a.union.length} line identit${p.a.union.length === 1 ? "y" : "ies"} since injection (${p.a.union.join(", ") || "none"}), present now: ${p.a.present.join(", ") || "none"}`;
}

export function describeB(p: Poll): string {
	const held = p.b.holder ? `holder ${p.b.holder}${p.b.liveHolder ? " (live lease)" : " (lease lapsed)"}` : "no holder";
	const orphans = p.b.orphans.length > 0 ? `, orphaned: ${p.b.orphans.map((o) => o.sliceId).join(", ")}` : "";
	return `${p.b.ok ? "holds" : "fails"}: ${held}, ${p.b.openSlices.length} open slice(s)${orphans}`;
}

export function describeC(p: Poll): string {
	const counted = p.c.counted.length > 0 ? `; ${p.c.counted.map((c) => c.why).join("; ")}` : "";
	return `${p.c.ok ? "holds" : "fails"}: ${p.c.exitedHands.length} unsettled hand(s) of exited lanes (${p.c.exitedHands.join(", ") || "none"})${counted}`;
}

/**
 * The run's verdict from its polls and its fault evidence (§ 2.4 Decision):
 * - egress in the measured phase, or an assistant message without the nonce: FAIL;
 * - a harness error the CLI saw, or a required evidence name never recorded: HARNESS-ERROR;
 * - (a)'s union reaching two identities: FAIL at that poll;
 * - the first poll within `windowMs` of injection where (a), (b), (c) hold and every evidence item
 *   holds decides; the first poll `settleMs` after it re-checks all three and the evidence, and any
 *   change is a FAIL, otherwise PASS;
 * - no deciding poll: a missed `systemFault` item is a FAIL, other missing evidence a HARNESS-ERROR
 *   (the fault did not happen as designed), otherwise FAIL with the last poll's state.
 */
export function verdict(polls: readonly Poll[], evidence: Evidence, windowMs: number = WINDOW_MS, settleMs: number = SETTLE_MS): Verdict {
	const t0 = ms(evidence.injectedAt);
	const sorted = polls.filter((p) => ms(p.at) >= t0).sort((x, y) => ms(x.at) - ms(y.at));
	const out = (v: VerdictKind, reason: string, o: Partial<Pick<Verdict, "deciding" | "settle" | "atMs" | "last">> = {}): Verdict => ({
		verdict: v, reason, deciding: o.deciding ?? null, settle: o.settle ?? null, atMs: o.atMs ?? null, last: o.last ?? sorted.at(-1) ?? null,
	});
	const plus = (p: Poll) => ms(p.at) - t0;
	if (evidence.egress.length > 0) return out("FAIL", `egress attempted in the measured phase: ${evidence.egress.join(", ")}`);
	if (evidence.nonceMisses.length > 0) return out("FAIL", `assistant message without the run nonce: ${evidence.nonceMisses.join("; ")}`);
	if (evidence.harness.length > 0) return out("HARNESS-ERROR", evidence.harness.join("; "));
	const missing = FAULT_EVIDENCE[evidence.fault].filter((name) => !evidence.items.some((i) => i.name === name));
	if (missing.length > 0) return out("HARNESS-ERROR", `fault evidence never recorded: ${missing.join(", ")}`);
	const lostSystem = evidence.items.find((i) => i.systemFault && i.lostAt != null);
	if (lostSystem) return out("FAIL", `${lostSystem.name}: ${lostSystem.observed}`);

	let deciding: Poll | null = null;
	let settle: Poll | null = null;
	let last: Poll | null = null;
	for (const p of sorted) {
		if (deciding === null && plus(p) > windowMs) break;
		last = p;
		if (p.a.union.length >= 2) return out("FAIL", `(a) reached ${p.a.union.length} needs-you lines at +${Math.round(plus(p) / 1000)} s: ${p.a.union.join(", ")}`, { deciding, atMs: plus(p), last: p });
		if (deciding === null) {
			if (p.ok && evidence.items.every((i) => holdsAt(i, ms(p.at)))) deciding = p;
		} else if (ms(p.at) >= ms(deciding.at) + settleMs) {
			settle = p;
			break;
		}
	}
	if (deciding !== null) {
		if (settle === null) return out("HARNESS-ERROR", `passed at +${Math.round(plus(deciding) / 1000)} s but no poll ran ${settleMs / 1000} s later for the settle re-check`, { deciding, atMs: plus(deciding), last });
		const changed: string[] = [];
		if (!settle.a.ok) changed.push(`(a) ${describeA(settle)}`);
		if (!settle.b.ok) changed.push(`(b) ${describeB(settle)}`);
		if (!settle.c.ok) changed.push(`(c) ${describeC(settle)}`);
		for (const i of evidence.items) if (!holdsAt(i, ms(settle.at))) changed.push(`evidence "${i.name}" no longer holds: ${i.observed}`);
		if (changed.length > 0) return out("FAIL", `passed at +${Math.round(plus(deciding) / 1000)} s, then changed by the settle re-check at +${Math.round(plus(settle) / 1000)} s: ${changed.join("; ")}`, { deciding, settle, atMs: plus(settle), last: settle });
		return out("PASS", `(a), (b), (c) and the fault evidence held at +${Math.round(plus(deciding) / 1000)} s and again at the settle re-check at +${Math.round(plus(settle) / 1000)} s`, { deciding, settle, atMs: plus(deciding), last: settle });
	}
	const end = last ? ms(last.at) : t0 + windowMs;
	const system = evidence.items.filter((i) => i.systemFault && !holdsAt(i, end));
	if (system.length > 0) return out("FAIL", system.map((i) => `${i.name}: ${i.observed}`).join("; "), { last });
	const absent = evidence.items.filter((i) => !holdsAt(i, end));
	if (absent.length > 0) return out("HARNESS-ERROR", `fault evidence not observed: ${absent.map((i) => `${i.name} (${i.observed})`).join("; ")}`, { last });
	if (!last) return out("HARNESS-ERROR", "no poll ran inside the window");
	return out("FAIL", `no passing poll within ${windowMs / 1000} s of injection; last poll at +${Math.round(plus(last) / 1000)} s: (a) ${describeA(last)}; (b) ${describeB(last)}; (c) ${describeC(last)}`, { atMs: plus(last), last });
}

// ---- run-owned processes (§ 2.1 cleanup, § 2.4 the kills) ---------------------------------------

/** The run could not be set up or driven as designed: exit 2, HARNESS-ERROR. */
export class HarnessError extends Error {}

/** An `omp` process, whatever the path to it (the pi-coding-agent package under bun). */
export const isOmpCommand = (command: string): boolean => /(^|\/)omp(\s|$)|pi-coding-agent/.test(command);

/** A path as a command line may spell it: as given, and with macOS's `/private/var` → `/var` alias (TMPDIR lives there). */
export function pathForms(path: string): string[] {
	const alias = path.replace(/^\/private\/var\//, "/var/");
	return alias === path ? [path] : [path, alias];
}

/** Whether a command line names `path` in either of its forms (`pathForms`). */
export function namesPath(command: string, path: string): boolean {
	return path !== "" && pathForms(path).some((f) => command.includes(f));
}

/** The same process start (`ps -o lstart=`): equal with whitespace collapsed (ps pads "Oct  2"). An empty start never matches. */
export function sameStart(a: string | null | undefined, b: string | null | undefined): boolean {
	const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
	return norm(a) !== "" && norm(a) === norm(b);
}

/**
 * A lane runner chaos may signal: a `lane.ts run <wl> <laneId>` command (`isRunner`: lane.ts `isRunnerCommand`, passed in so
 * this file does not import a script) whose path to lane.ts lies in the scratch repo `repo`.
 */
export function isScratchRunner(command: string, repo: string, wl: string, laneId: string, isRunner: (command: string, wl: string, laneId: string) => boolean): boolean {
	return namesPath(command, repo) && isRunner(command, wl, laneId);
}

/** One process as `killTargets` reads it: pid, parent pid, start time (`lstart`) and command. */
export interface ProcRow {
	pid: number;
	ppid: number;
	lstart: string;
	command: string;
}

/**
 * A process the run owns: one chaos spawned (it holds the handle), or one whose identity chaos verified when it learned the
 * pid (the runner a launch named, a `lane-started:` omp by its recorded start, a descendant of a process chaos was about to
 * kill), with the start time it had then.
 */
export interface OwnedProc {
	pid: number;
	lstart: string;
	what: string;
}

export interface KillTarget {
	pid: number;
	lstart: string;
	what: string;
}

/**
 * The processes chaos's cleanup may SIGKILL (pure): every owned process present in `table` with the start time it was owned
 * at, and every process below one of them by parent pid, parents first. A process that only names the scratch root in its
 * command, with no owned ancestor, is never selected (another user's `ls` of the scratch dir, a live lane reading a report);
 * neither is `self`, one of its `ancestors`, or pid 0 or 1, nor anything below them.
 */
export function killTargets(table: readonly ProcRow[], owned: readonly OwnedProc[], self: number, ancestors: ReadonlySet<number>): KillTarget[] {
	const shielded = new Set([...ancestors, self, 0, 1]);
	const children = new Map<number, ProcRow[]>();
	for (const r of table) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
	const out = new Map<number, KillTarget>();
	const queue: number[] = [];
	for (const o of owned) {
		const r = table.find((x) => x.pid === o.pid);
		if (!r || r.pid < 0 || shielded.has(r.pid) || out.has(r.pid) || !sameStart(r.lstart, o.lstart)) continue;
		out.set(r.pid, { pid: r.pid, lstart: r.lstart, what: o.what });
		queue.push(r.pid);
	}
	while (queue.length > 0) {
		const parent = queue.shift()!;
		for (const r of children.get(parent) ?? []) {
			if (shielded.has(r.pid) || out.has(r.pid)) continue;
			out.set(r.pid, { pid: r.pid, lstart: r.lstart, what: `below ${parent}` });
			queue.push(r.pid);
		}
	}
	return [...out.values()];
}

/** What a kill check reads of a pid (`ps -o lstart=,command=`), or null when there is no such process. */
export interface PsRead {
	lstart: string;
	command: string;
}

/**
 * Why the injection may not SIGKILL `t.pid` as `t.what`, or null when it may (pure): the pid must be alive, not `self` or an
 * ancestor, its command must pass `want`, and its start time must be the one recorded for it (`start`: the `lane-started:`
 * entry's for the lane omp, the one ps showed when chaos learned the pid for the runner and the orchestrator). An empty
 * `start` refuses: a process whose start was never recorded cannot be shown to be the run's.
 */
export function killRefusal(
	t: { pid: number; what: string; start: string; want: (command: string) => boolean },
	ps: PsRead | null,
	self: number,
	ancestors: ReadonlySet<number>,
): string | null {
	const recorded = `recorded start ${t.start || "(none)"}`;
	if (t.pid <= 1 || t.pid === self || ancestors.has(t.pid)) return `refusing to kill pid ${t.pid} (${t.what}): it is chaos itself, one of its ancestors, or not a user process`;
	if (ps === null) return `refusing to kill pid ${t.pid} (${t.what}): ps shows no such process; ${recorded}`;
	const shows = `ps shows ${ps.lstart}, ${ps.command.replace(/\s+/g, " ").slice(0, 160)}`;
	if (!t.want(ps.command)) return `refusing to kill pid ${t.pid} (${t.what}): its command is not the run's; ${shows}; ${recorded}`;
	if (!sameStart(ps.lstart, t.start)) return `refusing to kill pid ${t.pid} (${t.what}): its start time is not the recorded one; ${shows}; ${recorded}`;
	return null;
}

// ---- fault 5's single holder (§ 2.4 duplicate-lane-runner) ----------------------------------------

/** Fault 5's evidence "first lane held throughout, no second lane held or reserved" at one monitor check. */
export type FirstHolder = { state: "held" } | { state: "ended"; receipt: string } | { state: "lost"; observed: string };

const OTHER_LANE = /^(?:launch|lane-started):\s+(lane-\S+)/;
const END_RECEIPT = /^(lane-exit|lane-decided|lane-parked):\s+(lane-\S+)/;

/**
 * How far after the release an end receipt still counts as the same finalization (moonshot review r2 #1). lane.ts's runner
 * `finish()` releases the workload and then records `lane-exit:` inside one ledger transaction (and `lane.ts stop` does the
 * same), but the ledger stamps each write with its own clock read (`releaseWorkload` and `recordEntry` each call `now()`), so
 * the exit can land in the millisecond after the release's `changed_at`. Only a spend entry is written between the two, so
 * the real gap is a few milliseconds at most; 500 ms leaves room for a pause on a loaded machine and still reads an exit
 * written a second or more after a release as what it is: an end that came after the holding was already gone.
 */
export const END_RECEIPT_SKEW_MS = 500;

/**
 * Whether the first lane still holds the workload (pure). Lost: a `launch:` or `lane-started:` of another lane after the
 * injection, another holder, or no holder before the first lane's own end. The end is legitimate only through its ordered
 * ledger receipts, each written at or after the injection (moonshot review r3 #2: a stale receipt of the same lane id written
 * earlier is not this end): a `lane-exit:`, `lane-decided:` or `lane-parked:` entry naming the lane written no later than
 * `END_RECEIPT_SKEW_MS` after the release (the `changed_at` of the row that shows no holder), or an open question the lane
 * raised (the parked hold question) no later than the release itself.
 */
export function firstHolder(o: {
	laneId: string;
	injectedAt: string;
	workload: { holder: string | null; changed_at: string } | null;
	entries: readonly { id: string; body: string; created_at: string }[];
	questions: readonly { id: string; state: string; created_by: string; created_at: string }[];
}): FirstHolder {
	const short = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 160);
	const other = o.entries.find((e) => {
		const m = OTHER_LANE.exec(e.body.trim());
		return m !== null && m[1] !== o.laneId && e.created_at >= o.injectedAt;
	});
	if (other) return { state: "lost", observed: `entry ${other.id}: ${short(other.body)}` };
	if (o.workload === null) return { state: "lost", observed: "the workload row is gone" };
	const holder = o.workload.holder;
	if (holder === o.laneId) return { state: "held" };
	if (holder !== null) return { state: "lost", observed: `holder became ${holder}` };
	const releasedAt = o.workload.changed_at;
	const injected = ms(o.injectedAt);
	const receiptBy = ms(releasedAt) + END_RECEIPT_SKEW_MS;
	const entry = o.entries.find((e) => END_RECEIPT.exec(e.body.trim())?.[2] === o.laneId && ms(e.created_at) >= injected && ms(e.created_at) <= receiptBy);
	if (entry) return { state: "ended", receipt: `entry ${entry.id} (${short(entry.body).split(" ").slice(0, 2).join(" ")})` };
	const question = o.questions.find((q) => q.created_by === o.laneId && q.state === "open" && ms(q.created_at) >= injected && q.created_at <= releasedAt);
	if (question) return { state: "ended", receipt: `question ${question.id}, raised by ${o.laneId} and open` };
	return { state: "lost", observed: `holder became null at ${releasedAt}, before any lane-exit:, lane-decided: or lane-parked: of ${o.laneId} (from the injection at ${o.injectedAt} to ${END_RECEIPT_SKEW_MS} ms after the release) and before it raised a question after the injection` };
}

// ---- fault 5's second runner (§ 2.4 duplicate-lane-runner, part ii) ----------------------------------

/** The only refusal the second runner may give: lane.ts `cmdRun`'s guard, exit `STARTER_EXIT.held` (7) with "<lane> already running". */
export const SECOND_RUNNER_REFUSAL = { code: STARTER_EXIT.held!, text: /\balready running\b/ } as const;

const LANE_START_RECORD = /^lane-started:\s+(lane-\S+)\s+(\{[\s\S]*\})\s*$/;

/** A `lane-started:` record as chaos reads it: the lane, the omp pid and start time, the runner pid that wrote it, the entry. */
export interface LaneStart {
	laneId: string;
	pid: number;
	start: string;
	runnerPid: number;
	entryId: string;
	at: string;
}

/** Every parsable `lane-started:` entry, in entry order (pure); one without a numeric omp pid is not a start record. */
export function laneStarts(entries: readonly { id: string; body: string; created_at: string }[]): LaneStart[] {
	const out: LaneStart[] = [];
	for (const e of entries) {
		const m = LANE_START_RECORD.exec(e.body.trim());
		if (!m) continue;
		try {
			const v = JSON.parse(m[2]!) as { pid?: unknown; start?: unknown; runnerPid?: unknown };
			if (typeof v.pid !== "number") continue;
			out.push({ laneId: m[1]!, pid: v.pid, start: typeof v.start === "string" ? v.start : "", runnerPid: typeof v.runnerPid === "number" ? v.runnerPid : 0, entryId: e.id, at: e.created_at });
		} catch {
			// not a start record
		}
	}
	return out;
}

/**
 * The start records for `laneId` that are not in `before` (entry ids at the second runner's spawn), split by writer (pure):
 * `second` were written by `runnerPid`, the second runner chaos spawned; `others` by any other runner pid, such as the first
 * runner re-recording its start once omp names its model and session (lane.ts `startRecord`, `runnerPid: process.pid`).
 */
export function newStarts(starts: readonly LaneStart[], laneId: string, runnerPid: number, before: ReadonlySet<string>): { second: LaneStart[]; others: LaneStart[] } {
	const fresh = starts.filter((s) => s.laneId === laneId && !before.has(s.entryId));
	return { second: fresh.filter((s) => s.runnerPid === runnerPid), others: fresh.filter((s) => s.runnerPid !== runnerPid) };
}

/**
 * Fault 5's second-runner evidence (pure), judged once the runner has exited or been killed. `starts` is a ledger snapshot
 * taken after its exit, so a start record written and followed by exit between two watch polls is still seen; `omp` is a
 * process below the runner that a watch poll saw (or null). Held only when the runner exited by itself with
 * `SECOND_RUNNER_REFUSAL` and no start record of `runnerPid` and no omp appeared; anything else is the system's FAIL.
 */
export function secondRunnerJudgement(o: {
	laneId: string;
	runnerPid: number;
	before: ReadonlySet<string>;
	starts: readonly LaneStart[];
	omp: number | null;
	/** chaos killed it at the end of the watch. */
	killed: boolean;
	code: number | null;
	stderr: string;
	watchMs: number;
}): { held: boolean; observed: string } {
	const { second, others } = newStarts(o.starts, o.laneId, o.runnerPid, o.before);
	const othersNote = others.length === 0
		? ""
		: `; ${others.length} new lane-started: of ${o.laneId} by runner pid ${[...new Set(others.map((s) => s.runnerPid))].join(", ")} (not the second runner's), not counted`;
	const said = o.stderr.replace(/\s+/g, " ").trim().slice(0, 200);
	if (second.length > 0 || o.omp !== null) {
		const wrote = second.length > 0 ? `the second runner (pid ${o.runnerPid}) wrote lane-started: for ${o.laneId} (${second.map((s) => `entry ${s.entryId}, omp pid ${s.pid}`).join("; ")})` : "";
		const spawned = o.omp !== null ? `spawned omp pid ${o.omp}` : "";
		return { held: false, observed: `system defect: ${[wrote, spawned].filter(Boolean).join(" and ")}; cmdRun's guard did not refuse a lane id already running${othersNote}` };
	}
	if (o.killed) return { held: false, observed: `the second runner (pid ${o.runnerPid}) was still running after ${o.watchMs / 1000} s with no lane-started and no omp; killed${othersNote}` };
	const refused = o.code === SECOND_RUNNER_REFUSAL.code && SECOND_RUNNER_REFUSAL.text.test(o.stderr);
	if (!refused) return { held: false, observed: `the second runner (pid ${o.runnerPid}) exited ${o.code ?? "by a signal"}, not a refusal (only exit ${SECOND_RUNNER_REFUSAL.code} "already running" is): ${said}${othersNote}` };
	return { held: true, observed: `the second runner (pid ${o.runnerPid}) exited ${o.code} without writing lane-started: and without spawning omp: ${said}${othersNote}` };
}

// ---- scratch writes (§ 2.1 the repo copy) --------------------------------------------------------

function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

const linkNote = (path: string): string => {
	try {
		return ` (to ${readlinkSync(path)})`;
	} catch {
		return "";
	}
};

/**
 * Why `dest` may not be written as a path under the scratch root `root`, or null when it may. `root` must be its own realpath
 * and a real directory, `dest` strictly below it, every existing directory between them a real directory (lstat: a symlink
 * is refused, never followed), and the deepest of them must still resolve under `root`. `dest` itself must be absent or a
 * regular file; with `link: "unlink"` (a removal) it may also be a symlink, which is unlinked, not followed.
 */
export function scratchWriteRefusal(root: string, dest: string, opts: { link?: "refuse" | "unlink" } = {}): string | null {
	try {
		const real = realpathSync(root);
		if (real !== root) return `the scratch root ${root} is not its own realpath (${real})`;
		if (!lstatSync(root).isDirectory()) return `the scratch root ${root} is not a directory`;
		const target = resolve(dest);
		const rel = relative(root, target);
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${target} is not below the scratch root ${root}`;
		let deepest = root;
		for (const part of rel.split(sep).slice(0, -1)) {
			const at = join(deepest, part);
			const st = lstatOrNull(at);
			if (st === null) break;
			if (st.isSymbolicLink()) return `${at} is a symlink${linkNote(at)}; a scratch write never follows one`;
			if (!st.isDirectory()) return `${at} is not a directory`;
			deepest = at;
		}
		const resolved = realpathSync(deepest);
		if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return `${deepest} resolves to ${resolved}, outside the scratch root ${root}`;
		const st = lstatOrNull(target);
		if (st?.isSymbolicLink() && opts.link !== "unlink") return `${target} is a symlink${linkNote(target)}; a scratch write never follows one`;
		if (st && !st.isSymbolicLink() && !st.isFile()) return `${target} exists and is not a regular file`;
		return null;
	} catch (e) {
		return `${dest} could not be checked: ${e instanceof Error ? e.message : String(e)}`;
	}
}

function mustWrite(root: string, dest: string, opts: { link?: "refuse" | "unlink" } = {}): void {
	const why = scratchWriteRefusal(root, dest, opts);
	if (why !== null) throw new HarnessError(`refusing a scratch write: ${why}`);
}

/**
 * Write `data` to `dest` under `root`, or throw HarnessError when `scratchWriteRefusal` refuses. Missing directories are made;
 * a regular file already there is unlinked and the new one created with O_EXCL | O_NOFOLLOW, so nothing is written through
 * a link, even one made after the check.
 */
export function writeScratchFile(root: string, dest: string, data: string | Uint8Array, mode = 0o644): void {
	mustWrite(root, dest);
	mkdirSync(dirname(dest), { recursive: true });
	mustWrite(root, dest);
	if (lstatOrNull(dest) !== null) unlinkSync(dest);
	const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
	try {
		writeFileSync(fd, data);
		fchmodSync(fd, mode);
	} finally {
		closeSync(fd);
	}
}

/** Copy the regular file `from` (lstat: a symlink is refused) to `dest` under `root`, keeping its permission bits (`writeScratchFile`). */
export function copyIntoScratch(root: string, from: string, dest: string): void {
	const st = lstatSync(from);
	if (!st.isFile()) throw new HarnessError(`refusing a scratch copy: ${from} is not a regular file`);
	writeScratchFile(root, dest, readFileSync(from), st.mode & 0o7777);
}

/** Remove `dest` under `root` when present: a file or a symlink is unlinked (a link is never followed); anything else is a HarnessError. */
export function removeFromScratch(root: string, dest: string): void {
	mustWrite(root, dest, { link: "unlink" });
	if (lstatOrNull(dest) !== null) unlinkSync(dest);
}

/** Why `dest` may not be created fresh under `root` (`scratchWriteRefusal`, and it must not exist yet), or null. */
export function scratchNewPathRefusal(root: string, dest: string): string | null {
	const why = scratchWriteRefusal(root, dest);
	if (why !== null) return why;
	return lstatOrNull(dest) === null ? null : `${dest} already exists`;
}

// ---- isolation snapshot (§ 2.1 Isolation proof) -------------------------------------------------

export interface LivePaths {
	ledgerDb: string;
	checkout: string;
	lanesRoots: readonly string[];
}

export interface RowSnap {
	table: string;
	key: string;
	/** SHA-256 of every column of the row. */
	hash: string;
	/** Who wrote the row's current state: `changed_by`, else `created_by`, else `lane_instance`; null when it has none. */
	actor: string | null;
	workload: string | null;
	/** Every actor-like value on the row (writers, holder, sender, author): the before-snapshot's actors are the live ones. */
	actors: string[];
	/** The row as JSON, so a changed row can be searched for the run token. */
	text: string;
}

export interface FileMeta {
	size: number;
	mtimeMs: number;
}

export interface LedgerSnap {
	path: string;
	/** `<table>:<primary key>` → row. */
	rows: Record<string, RowSnap>;
	wal: FileMeta | null;
	shm: FileMeta | null;
	error: string | null;
}

export interface CheckoutSnap {
	path: string;
	/** `git status --porcelain=v2 -z --untracked-files=all`, one entry per path. */
	status: Record<string, string>;
	/** SHA-256 of every modified or untracked path the status lists (`absent`, `dir`, `link:<target>` otherwise). */
	files: Record<string, string>;
	head: string;
	worktrees: string;
	refs: string;
	/** When `git for-each-ref` ran (ms since epoch): a bound of the window worktree reflog evidence must fall in. */
	refsAtMs: number;
	/**
	 * Every linked worktree's HEAD reflog (`<git-common-dir>/worktrees/<name>/logs/HEAD`, read as a
	 * file after `for-each-ref`), keyed by the worktree's path as `git worktree list` prints it.
	 */
	reflogs: Record<string, string>;
	stash: string;
	indexMtimeMs: number | null;
	error: string | null;
}

export interface ListingEntry {
	type: "f" | "d" | "l" | "o";
	size: number;
	mtimeMs: number;
}

export interface ListingSnap {
	root: string;
	exists: boolean;
	/** Path relative to the root → entry. */
	entries: Record<string, ListingEntry>;
}

export interface IsolationSnapshot {
	at: string;
	ledger: LedgerSnap;
	checkout: CheckoutSnap;
	listings: ListingSnap[];
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const ACTOR_COLUMNS = ["created_by", "changed_by", "lane_instance", "holder", "sender", "author"] as const;
const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function fileMeta(path: string): FileMeta | null {
	try {
		const s = statSync(path);
		return { size: s.size, mtimeMs: s.mtimeMs };
	} catch {
		return null;
	}
}

/** Every row of every table of the ledger at `path`, opened read-only, hashed; and the -wal/-shm sizes and mtimes. */
export function ledgerSnapshot(path: string): LedgerSnap {
	// Under test, an explicit path inside a live ledger root throws here instead of reaching SQLite.
	assertNotLiveLedgerUnderTest(path);
	const rows: Record<string, RowSnap> = {};
	const wal = fileMeta(`${path}-wal`);
	const shm = fileMeta(`${path}-shm`);
	let db: Database | undefined;
	try {
		db = new Database(path, { readonly: true });
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
		for (const { name: table } of tables) {
			const pk = db.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${quoteIdent(table)})`).all().filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name);
			const sql = pk.length > 0 ? `SELECT * FROM ${quoteIdent(table)}` : `SELECT rowid AS "rowid", * FROM ${quoteIdent(table)}`;
			for (const row of db.query<Record<string, unknown>, []>(sql).all()) {
				const key = pk.length > 0 ? pk.map((c) => String(row[c])).join("|") : String(row.rowid);
				const text = JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : typeof v === "bigint" ? String(v) : v));
				const str = (c: string): string | null => {
					const v = row[c];
					return typeof v === "string" ? v : null;
				};
				const actors = [...new Set(ACTOR_COLUMNS.flatMap((c) => str(c) ?? []))];
				const workload = str("workload_id") ?? (table === "workloads" ? str("id") : null);
				rows[`${table}:${key}`] = { table, key, hash: sha256(text), actor: str("changed_by") ?? str("created_by") ?? str("lane_instance"), workload, actors, text };
			}
		}
		return { path, rows, wal, shm, error: null };
	} catch (e) {
		return { path, rows, wal, shm, error: e instanceof Error ? e.message : String(e) };
	} finally {
		db?.close();
	}
}

/** git, read-only: `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`, so no probe refreshes or rewrites the index. */
function gitRead(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
	const r = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], {
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		stdout: "pipe", stderr: "pipe", timeout: 60_000,
	});
	return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
}

/**
 * `git status --porcelain=v2 -z` output keyed by path: ordinary (`1`, 8 fields before the path),
 * renamed/copied (`2`, 9 fields, then the original path as the next NUL field), unmerged (`u`, 10
 * fields), untracked (`?`) and ignored (`!`). Header lines (`#`) are skipped.
 */
export function parsePorcelainV2(out: string): { entries: Record<string, string>; paths: string[] } {
	const tokens = out.split("\0");
	const entries: Record<string, string> = {};
	const paths: string[] = [];
	const fieldsBefore: Record<string, number> = { "1": 8, "2": 9, u: 10 };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === "" || t.startsWith("# ")) continue;
		if (t.startsWith("? ") || t.startsWith("! ")) {
			entries[t.slice(2)] = t;
			paths.push(t.slice(2));
			continue;
		}
		const n = fieldsBefore[t[0]!];
		if (n === undefined) continue;
		let cut = 0;
		for (let k = 0; k < n; k++) cut = t.indexOf(" ", cut) + 1;
		const path = t.slice(cut);
		if (t[0] === "2") {
			const orig = tokens[++i] ?? "";
			entries[path] = `${t}\0${orig}`;
			paths.push(path, orig);
		} else {
			entries[path] = t;
			paths.push(path);
		}
	}
	return { entries, paths };
}

function contentHash(path: string): string {
	try {
		const s = lstatSync(path);
		if (s.isSymbolicLink()) return `link:${readlinkSync(path)}`;
		if (s.isDirectory()) return "dir";
		return sha256(readFileSync(path));
	} catch {
		return "absent";
	}
}

/**
 * Each linked worktree's HEAD reflog, read as files (never through git): `<common>/worktrees/<name>/gitdir`
 * names `<worktree>/.git` (relative to the admin dir when git wrote it relative), and
 * `<common>/worktrees/<name>/logs/HEAD` is the reflog. A worktree with no reflog is left out.
 */
function worktreeReflogs(commonDir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const admin = join(commonDir, "worktrees");
	let names: string[];
	try {
		names = readdirSync(admin);
	} catch {
		return out;
	}
	for (const name of names) {
		try {
			const path = dirname(resolve(join(admin, name), readFileSync(join(admin, name, "gitdir"), "utf8").trim()));
			out[path] = readFileSync(join(admin, name, "logs", "HEAD"), "utf8");
		} catch {
			// no gitdir or no reflog: no evidence from this worktree
		}
	}
	return out;
}

/** The live checkout's git state (§ 2.1): status, hashes of the dirty and untracked files, HEAD, worktrees, refs, the linked worktrees' HEAD reflogs, stash, index mtime. */
export function checkoutSnapshot(checkout: string): CheckoutSnap {
	const empty: CheckoutSnap = { path: checkout, status: {}, files: {}, head: "", worktrees: "", refs: "", refsAtMs: Date.now(), reflogs: {}, stash: "", indexMtimeMs: null, error: null };
	const gitDir = gitRead(checkout, ["rev-parse", "--absolute-git-dir"]);
	if (!gitDir.ok) return { ...empty, error: `git rev-parse --absolute-git-dir: ${gitDir.err}` };
	const status = gitRead(checkout, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
	if (!status.ok) return { ...empty, error: `git status: ${status.err}` };
	const { entries, paths } = parsePorcelainV2(status.out);
	const files: Record<string, string> = {};
	for (const p of paths) if (p !== "") files[p] = contentHash(join(checkout, p));
	const head = gitRead(checkout, ["rev-parse", "HEAD"]);
	const worktrees = gitRead(checkout, ["worktree", "list", "--porcelain"]);
	const commonDir = gitRead(checkout, ["rev-parse", "--git-common-dir"]);
	const refsAtMs = Date.now();
	const refs = gitRead(checkout, ["for-each-ref"]);
	// After for-each-ref, so the after-snapshot's reflogs hold every write its refs show.
	const reflogs = commonDir.ok ? worktreeReflogs(resolve(checkout, commonDir.out.trim())) : {};
	const stash = gitRead(checkout, ["stash", "list"]);
	const failed = ([["worktree list", worktrees], ["rev-parse --git-common-dir", commonDir], ["for-each-ref", refs], ["stash list", stash]] as const).filter(([, r]) => !r.ok);
	return {
		path: checkout, status: entries, files,
		head: head.ok ? head.out.trim() : `(no HEAD: ${head.err})`,
		worktrees: worktrees.out, refs: refs.out, refsAtMs, reflogs, stash: stash.out,
		indexMtimeMs: fileMeta(join(gitDir.out.trim(), "index"))?.mtimeMs ?? null,
		error: failed.length > 0 ? failed.map(([name, r]) => `git ${name}: ${r.err}`).join("; ") : null,
	};
}

/** A recursive lstat listing of `root` (path, type, size, mtime); symlinks are listed, never followed. */
export function listingSnapshot(root: string): ListingSnap {
	const entries: Record<string, ListingEntry> = {};
	if (!existsSync(root)) return { root, exists: false, entries };
	const walk = (dir: string, rel: string) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const abs = join(dir, name);
			const r = rel ? `${rel}/${name}` : name;
			let s: Stats;
			try {
				s = lstatSync(abs);
			} catch {
				continue;
			}
			const type = s.isSymbolicLink() ? "l" : s.isDirectory() ? "d" : s.isFile() ? "f" : "o";
			entries[r] = { type, size: s.size, mtimeMs: s.mtimeMs };
			if (type === "d") walk(abs, r);
		}
	};
	walk(root, "");
	return { root, exists: true, entries };
}

/** Everything § 2.1 records about the live system, taken from outside the run, before and after it. */
export function isolationSnapshot(livePaths: LivePaths): IsolationSnapshot {
	return {
		at: new Date().toISOString(),
		ledger: ledgerSnapshot(livePaths.ledgerDb),
		checkout: checkoutSnapshot(livePaths.checkout),
		listings: livePaths.lanesRoots.map(listingSnapshot),
	};
}

/** The actors of the live ledger before the run: every writer, holder, sender and author on any row. */
export function liveActorsOf(snap: IsolationSnapshot): Set<string> {
	const out = new Set<string>();
	for (const row of Object.values(snap.ledger.rows)) for (const a of row.actors) out.add(a);
	return out;
}

// ---- isolation diff -----------------------------------------------------------------------------

/** The `--requested-by` values chaos launches under: a live row by one of them is the run's. */
export const CHAOS_ACTORS: readonly string[] = ["chaos", "chaos-dup"];
/** The attribution a `refs/remotes/**` move gets: listed, not failed (a live lane's fetch; chaos only clones the live repo). */
export const REMOTE_TRACKING = "remote-tracking ref (a live fetch; listed)";
/** How far outside [before for-each-ref, after for-each-ref] a worktree reflog entry may lie and still count: reflog times are whole seconds. */
export const REFLOG_SKEW_MS = 5_000;

/**
 * The branch writes one worktree's HEAD reflog shows in [fromMs, toMs], as `<branch>\0<new sha>`.
 * The entries are walked in order, tracking the branch HEAD is on: `checkout: moving from A to B`
 * puts it on B (and says it was on A before the first checkout), `rebase … (start)` detaches it, and
 * `rebase …: returning to refs/heads/B` puts it back on B. An entry made while HEAD is on a known
 * branch (a checkout, commit, merge, reset, rebase finish) left that branch at the entry's new sha.
 * Entries before any branch is known, and lines that do not parse, give nothing.
 */
export function reflogBranchWrites(text: string, fromMs: number, toMs: number): Set<string> {
	const checkoutMove = /^checkout: moving from (\S+) to (\S+)$/;
	const entries = text.split("\n").flatMap((line) => {
		const tab = line.indexOf("\t");
		const m = /^[0-9a-f]+ ([0-9a-f]+) .* (\d+) [+-]\d{4}$/.exec(tab < 0 ? line : line.slice(0, tab));
		return m ? [{ sha: m[1]!, ms: Number(m[2]) * 1000, message: tab < 0 ? "" : line.slice(tab + 1) }] : [];
	});
	let branch = entries.map((e) => checkoutMove.exec(e.message)?.[1]).find((b) => b !== undefined) ?? null;
	const out = new Set<string>();
	for (const e of entries) {
		const moved = checkoutMove.exec(e.message);
		const returned = /^rebase\b.*: returning to refs\/heads\/(\S+)$/.exec(e.message);
		if (moved) branch = moved[2]!;
		else if (returned) branch = returned[1]!;
		else if (/^rebase\b.*\(start\)/.test(e.message)) branch = null;
		if (branch !== null && !/^0+$/.test(e.sha) && e.ms >= fromMs && e.ms <= toMs) out.add(`${branch}\0${e.sha}`);
	}
	return out;
}

/** Stated in every report (§ 2.1 Known limit). */
export const ISOLATION_LIMIT =
	"Snapshots cannot see a write that was made and then undone between them. Against that, the run's design is the guard: env routing to the scratch root, the checks before start, a stub that scripts every model action, and every scripted bash command running under the scratch fence with its cwd in the scratch root. A separate OS user would rule out that limit at the OS level.";

export interface RowChange {
	table: string;
	key: string;
	change: "insert" | "update" | "delete";
	actor: string | null;
	workload: string | null;
	/** Why this change fails the run; null when it is only listed. */
	fail: string | null;
}

export interface CheckoutChange {
	field: "status" | "file" | "HEAD" | "worktree" | "ref" | "stash" | "index mtime" | "snapshot";
	detail: string;
	/**
	 * What the change is attributed to: the live lane worktree it belongs to by path; for a
	 * `refs/heads/<branch>` change, `<lane dir> (worktree reflog)` when a live lane worktree's HEAD
	 * reflog shows it putting that branch at that sha during the run (`reflogBranchWrites`); or
	 * `REMOTE_TRACKING` for a `refs/remotes/**` move (chaos clones the live repo and never fetches it,
	 * so a live lane's `git fetch` made it). Null fails the run.
	 */
	attributedTo: string | null;
}

export interface ListingChange {
	root: string;
	path: string;
	change: "added" | "removed" | "changed";
	/** The first path segment under the root: the workload dir the entry is in. */
	workload: string;
	detail: string;
	fail: boolean;
}

export interface IsolationDiff {
	ok: boolean;
	failures: string[];
	ledger: { rows: RowChange[]; files: string[] };
	checkout: CheckoutChange[];
	listings: ListingChange[];
}

const metaText = (m: FileMeta | null): string => (m ? `${m.size} bytes, mtime ${new Date(m.mtimeMs).toISOString()}` : "absent");

function splitBlocks(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const block of text.split(/\n\s*\n/)) {
		const first = block.trim().split("\n")[0] ?? "";
		if (first.startsWith("worktree ")) out.set(first.slice("worktree ".length), block.trim());
	}
	return out;
}

function refLines(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab > 0) out.set(line.slice(tab + 1), line.slice(0, tab));
	}
	return out;
}

function diffMaps<V>(a: ReadonlyMap<string, V> | Record<string, V>, b: ReadonlyMap<string, V> | Record<string, V>, same: (x: V, y: V) => boolean) {
	const am = a instanceof Map ? a : new Map(Object.entries(a));
	const bm = b instanceof Map ? b : new Map(Object.entries(b));
	const out: { key: string; before: V | undefined; after: V | undefined }[] = [];
	for (const [k, v] of am) if (!bm.has(k) || !same(v, bm.get(k)!)) out.push({ key: k, before: v, after: bm.get(k) });
	for (const [k, v] of bm) if (!am.has(k)) out.push({ key: k, before: undefined, after: v });
	return out;
}

/**
 * The live state before and after the run (§ 2.1), compared. `token` is the run's marker (or
 * several: the run id, the scratch root, the throwaway workload id); `liveActors` are the live
 * ledger's actors before the run (`liveActorsOf(before)`).
 *
 * Ledger rows: every insert, update and delete is listed with its table, id, actor and workload.
 * It FAILs when the row (any column) names a marker or its actor is a chaos actor, or when its actor
 * was not live before the run. An actor counts as live too when the run's own changes show a live
 * actor introducing it (a lane-starter `launch:` or a lane-runner `lane-started:` naming a new lane
 * id, i.e. Jo's lanes relaunching at 03:00), or when the row is on a workload a live actor opened
 * during the run. A row with no actor column is listed only. The -wal/-shm changes are listed only.
 *
 * Checkout: any difference FAILs unless it is a worktree or a `wl/<id>` ref attributable by path to a
 * live lane worktree under one of the lanes roots, a `refs/heads/<branch>` change whose new sha the
 * HEAD reflog of such a worktree shows it writing to that branch between the two `for-each-ref`
 * runs (± `REFLOG_SKEW_MS`; listed as `<dir> (worktree reflog)`), or a `refs/remotes/**` move
 * (`REMOTE_TRACKING`), which is listed. A deleted branch has no such evidence and FAILs; so does a
 * tag or a ref in any other namespace. A ref naming a marker always FAILs. Listings: an entry naming
 * a marker FAILs; every other change is listed with the workload dir it is in.
 */
export function isolationDiff(a: IsolationSnapshot, b: IsolationSnapshot, token: string | readonly string[], liveActors: ReadonlySet<string>): IsolationDiff {
	const markers = (typeof token === "string" ? [token] : [...token]).filter((m) => m.length > 0);
	const named = (text: string): string | null => markers.find((m) => text.includes(m)) ?? null;
	const failures: string[] = [];

	// Ledger rows.
	for (const [which, snap] of [["before", a], ["after", b]] as const) {
		if (snap.ledger.error) failures.push(`live ledger snapshot ${which} the run failed: ${snap.ledger.error}`);
	}
	const changed = diffMaps(a.ledger.rows, b.ledger.rows, (x, y) => x.hash === y.hash).map(({ key, before, after }) => ({
		key, row: (after ?? before)!, change: (before === undefined ? "insert" : after === undefined ? "delete" : "update") as RowChange["change"],
	}));
	const openedDuringRun = new Set(changed.filter((c) => c.change === "insert" && c.row.table === "workloads" && c.row.actor !== null && liveActors.has(c.row.actor)).map((c) => c.row.key));
	const byLive = changed.filter((c) => c.row.actor !== null && liveActors.has(c.row.actor));
	// A new actor id named as a whole id (not inside a longer `[\w.-]` run) by a live actor's change.
	const introduced = (actor: string): boolean => {
		const id = new RegExp(`(^|[^\\w.-])${actor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w.-])`);
		return byLive.some((c) => id.test(c.row.text));
	};
	const rows: RowChange[] = changed.map(({ row, change }) => {
		const marker = named(row.text);
		let fail: string | null = null;
		if (marker !== null) fail = `names the run (${marker})`;
		else if (row.actor !== null && CHAOS_ACTORS.includes(row.actor)) fail = `written by chaos actor ${row.actor}`;
		else if (row.actor !== null && !liveActors.has(row.actor) && !introduced(row.actor) && !(row.workload !== null && openedDuringRun.has(row.workload))) {
			fail = `actor ${row.actor} was not active on the live ledger before the run`;
		}
		return { table: row.table, key: row.key, change, actor: row.actor, workload: row.workload, fail };
	});
	for (const r of rows) if (r.fail) failures.push(`live ledger ${r.change} ${r.table} ${r.key} (by ${r.actor ?? "-"}, workload ${r.workload ?? "-"}): ${r.fail}`);
	const files: string[] = [];
	for (const [suffix, x, y] of [["-wal", a.ledger.wal, b.ledger.wal], ["-shm", a.ledger.shm, b.ledger.shm]] as const) {
		if (metaText(x) !== metaText(y)) files.push(`${suffix}: ${metaText(x)} → ${metaText(y)}`);
	}

	// Checkout.
	const roots = [...new Set([...a.listings, ...b.listings].map((l) => l.root))];
	const laneDirs = new Set([...a.listings, ...b.listings].flatMap((l) => Object.keys(l.entries).filter((k) => !k.includes("/"))));
	const underRoot = (path: string): string | null => {
		for (const root of roots) {
			const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
			if (path.startsWith(prefix)) return path.slice(prefix.length).split(sep)[0] ?? null;
		}
		return null;
	};
	const checkout: CheckoutChange[] = [];
	for (const [which, snap] of [["before", a], ["after", b]] as const) {
		if (snap.checkout.error) checkout.push({ field: "snapshot", detail: `checkout snapshot ${which} the run failed: ${snap.checkout.error}`, attributedTo: null });
	}
	for (const d of diffMaps(a.checkout.status, b.checkout.status, (x, y) => x === y)) {
		checkout.push({ field: "status", detail: `${d.key}: ${(d.before ?? "clean").replaceAll("\0", " ← ")} → ${(d.after ?? "clean").replaceAll("\0", " ← ")}`, attributedTo: null });
	}
	for (const d of diffMaps(a.checkout.files, b.checkout.files, (x, y) => x === y)) {
		checkout.push({ field: "file", detail: `${d.key}: ${d.before ?? "not listed"} → ${d.after ?? "not listed"}`, attributedTo: null });
	}
	if (a.checkout.head !== b.checkout.head) checkout.push({ field: "HEAD", detail: `${a.checkout.head} → ${b.checkout.head}`, attributedTo: null });
	for (const d of diffMaps(splitBlocks(a.checkout.worktrees), splitBlocks(b.checkout.worktrees), (x, y) => x === y)) {
		const dir = isAbsolute(d.key) ? underRoot(d.key) : null;
		const live = dir !== null && named(d.key) === null ? dir : null;
		checkout.push({ field: "worktree", detail: `${d.key}: ${d.before === undefined ? "added" : d.after === undefined ? "removed" : "changed"}`, attributedTo: live });
	}
	// `<branch>\0<sha>` → the live lane dir whose worktree HEAD reflog shows that write during the run.
	const reflogWrites = new Map<string, string>();
	const [fromMs, toMs] = [a.checkout.refsAtMs - REFLOG_SKEW_MS, b.checkout.refsAtMs + REFLOG_SKEW_MS];
	for (const [path, text] of Object.entries({ ...a.checkout.reflogs, ...b.checkout.reflogs })) {
		const dir = isAbsolute(path) && named(path) === null ? underRoot(path) : null;
		if (dir === null) continue;
		for (const write of reflogBranchWrites(text, fromMs, toMs)) if (!reflogWrites.has(write)) reflogWrites.set(write, dir);
	}
	for (const d of diffMaps(refLines(a.checkout.refs), refLines(b.checkout.refs), (x, y) => x === y)) {
		const wl = /^refs\/(?:heads|remotes\/[^/]+)\/wl\/([^/]+)$/.exec(d.key)?.[1] ?? null;
		const branch = /^refs\/heads\/(.+)$/.exec(d.key)?.[1] ?? null;
		const byReflog = branch !== null && d.after !== undefined ? reflogWrites.get(`${branch}\0${d.after.split(" ")[0]}`) ?? null : null;
		const unnamed = named(d.key) === null;
		const live = !unnamed ? null
			: wl !== null && laneDirs.has(wl) ? wl
			: d.key.startsWith("refs/remotes/") ? REMOTE_TRACKING
			: byReflog !== null ? `${byReflog} (worktree reflog)`
			: null;
		checkout.push({ field: "ref", detail: `${d.key}: ${d.before ?? "absent"} → ${d.after ?? "absent"}`, attributedTo: live });
	}
	if (a.checkout.stash !== b.checkout.stash) checkout.push({ field: "stash", detail: `stash list changed: ${JSON.stringify(a.checkout.stash)} → ${JSON.stringify(b.checkout.stash)}`, attributedTo: null });
	if (a.checkout.indexMtimeMs !== b.checkout.indexMtimeMs) {
		const t = (m: number | null) => (m === null ? "absent" : new Date(m).toISOString());
		checkout.push({ field: "index mtime", detail: `.git/index ${t(a.checkout.indexMtimeMs)} → ${t(b.checkout.indexMtimeMs)}`, attributedTo: null });
	}
	for (const c of checkout) if (c.attributedTo === null) failures.push(`live checkout ${c.field} changed: ${c.detail}`);

	// Lanes roots.
	const listings: ListingChange[] = [];
	for (const root of roots) {
		const la = a.listings.find((l) => l.root === root)?.entries ?? {};
		const lb = b.listings.find((l) => l.root === root)?.entries ?? {};
		for (const d of diffMaps(la, lb, (x, y) => x.type === y.type && x.size === y.size && x.mtimeMs === y.mtimeMs)) {
			const change = d.before === undefined ? "added" : d.after === undefined ? "removed" : "changed";
			const e = (x: ListingEntry | undefined) => (x ? `${x.type} ${x.size} bytes ${new Date(x.mtimeMs).toISOString()}` : "absent");
			const fail = named(join(root, d.key)) !== null;
			listings.push({ root, path: d.key, change, workload: d.key.split("/")[0]!, detail: `${e(d.before)} → ${e(d.after)}`, fail });
			if (fail) failures.push(`live lanes root ${root}: ${change} ${d.key} names the run`);
		}
	}
	return { ok: failures.length === 0, failures, ledger: { rows, files }, checkout, listings };
}

// ---- the report (§ 2.5) -------------------------------------------------------------------------

export interface WorkloadRows {
	workload: Record<string, unknown> | null;
	slices: Record<string, unknown>[];
	entries: Record<string, unknown>[];
	messages: Record<string, unknown>[];
	questions: Record<string, unknown>[];
	routings: Record<string, unknown>[];
}

/** The throwaway ledger's rows for the workload, for the report's tables. */
export function workloadRows(ledger: Ledger, wl: string): WorkloadRows {
	const workload = ledger.workload(wl);
	return {
		workload: workload ? { ...workload } : null,
		slices: ledger.slices(wl).map((r) => ({ ...r })),
		entries: ledger.entries(wl).map((r) => ({ ...r })),
		messages: ledger.db.query<Record<string, unknown>, [string]>("SELECT * FROM messages WHERE workload_id = ? ORDER BY created_at, rowid").all(wl),
		questions: ledger.questions(wl).map((r) => ({ ...r })),
		routings: ledger.routings(wl).map((r) => ({ ...r })),
	};
}

/** The ps stand-in surface/scripts/chaos.ts puts first on a scratch run's PATH when /bin/ps cannot be executed (Jo's "shim"). */
export const PS_SHIM = "surface/scripts/ps-shim/ps";

/**
 * Which ps the run used: the real /bin/ps; the stand-in, because the real one is blocked (a lane's fence makes the
 * setuid exec fail); neither (a HARNESS-ERROR); or not yet probed (setup stopped before the probe).
 */
export type PsSource =
	| { kind: "real" }
	| { kind: "stand-in"; blocked: string }
	| { kind: "none"; blocked: string; standIn: string }
	| { kind: "unchecked" };

/** The report's one `- ps:` header line. */
export function psLine(ps: PsSource): string {
	switch (ps.kind) {
		case "real": return "- ps: real /bin/ps";
		case "stand-in": return `- ps: stand-in ${PS_SHIM} (real ps blocked: ${ps.blocked})`;
		case "none": return `- ps: none (real ps blocked: ${ps.blocked}; stand-in ${PS_SHIM} failed: ${ps.standIn})`;
		case "unchecked": return "- ps: not checked (the run stopped before the ps probe)";
	}
}

export interface RunReport {
	fault: FaultName;
	/** `--kill runner` and the like; null for the plain fault. */
	variant: string | null;
	token: string;
	fence: "on" | "off (nested sandbox)";
	ps: PsSource;
	verdict: Verdict;
	timings: { startedAt: string; setupMs: number | null; triggerAt: string | null; injectedAt: string | null };
	evidence: Evidence;
	/** Every egress-proxy attempt, every phase (the preflight self-test included). */
	egressLog: readonly { phase: string; host: string; at?: string }[];
	rows: WorkloadRows | null;
	/** Fault 5's second launch and second runner. */
	runners: readonly { label: string; exitCode: number | null; stderr: string }[];
	stubCounts: Readonly<Record<string, number>>;
	isolation: IsolationDiff | null;
	scratch: { path: string; kept: boolean };
	notes: readonly string[];
}

const cell = (v: unknown, max = 500): string => {
	const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
	const cut = s.length > max ? `${s.slice(0, max - 1)}…` : s;
	return cut.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
};

/** A markdown table of rows, columns in first-seen order. */
export function mdTable(rows: readonly Record<string, unknown>[]): string {
	if (rows.length === 0) return "_none_";
	const cols: string[] = [];
	for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
	return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`)].join("\n");
}

const secs = (n: number | null): string => (n === null ? "-" : `+${Math.round(n / 1000)} s`);
const LISTING_PATHS_SHOWN = 20;

/** The run's report (§ 2.5), as markdown. */
export function renderReport(run: RunReport): string {
	const v = run.verdict;
	const out: string[] = [];
	out.push(`# chaos ${run.fault}${run.variant ? ` (${run.variant})` : ""}: ${v.verdict}`, "");
	out.push(`- verdict: **${v.verdict}** — ${v.reason}`);
	out.push(`- fault: ${run.fault}${run.variant ? `, variant ${run.variant}` : ""}`);
	out.push(`- run token: ${run.token}`);
	out.push(`- fence: ${run.fence}`);
	out.push(psLine(run.ps));
	out.push(`- started: ${run.timings.startedAt}; setup: ${run.timings.setupMs === null ? "-" : `${Math.round(run.timings.setupMs / 1000)} s`}; trigger: ${run.timings.triggerAt ?? "-"}; injection: ${run.timings.injectedAt ?? "-"}; ${v.verdict === "PASS" ? "pass" : "decided"} at ${secs(v.atMs)}`);
	out.push(`- scratch: ${run.scratch.path} (${run.scratch.kept ? "kept" : "deleted"})`);
	for (const n of run.notes) out.push(`- note: ${n}`);
	out.push("");

	out.push("## Fault evidence", "");
	if (run.evidence.items.length === 0) out.push("_none recorded_");
	for (const i of run.evidence.items) {
		const state = i.at === null ? "not observed" : `observed ${i.at}${i.lostAt ? `, lost ${i.lostAt}` : ""}`;
		out.push(`- ${i.name}${i.systemFault ? " (a miss is a system FAIL)" : ""}: ${state} — ${i.observed}`);
	}
	if (run.evidence.nonceMisses.length > 0) out.push(`- assistant messages without the nonce: ${run.evidence.nonceMisses.join("; ")}`);
	if (run.evidence.harness.length > 0) out.push(`- harness errors: ${run.evidence.harness.join("; ")}`);
	out.push("");

	out.push("## Criteria", "");
	const crit = (label: string, p: Poll | null) =>
		p ? [`- ${label} (poll ${p.n}, ${p.at}):`, `  - (a) ${describeA(p)}`, `  - (b) ${describeB(p)}`, `  - (c) ${describeC(p)}`, `  - builders: ${p.builders.labs.join(", ") || "none"}${p.builders.unknown.length > 0 ? `; unknown: ${p.builders.unknown.join("; ")}` : ""}`] : [`- ${label}: none`];
	out.push(...crit("deciding poll", v.deciding), ...crit("settle re-check", v.settle));
	if (!v.deciding && v.last) out.push(...crit("last poll", v.last));
	out.push("");

	out.push("## Needs-you lines seen", "");
	const seen = [...(v.last?.seen.lines.values() ?? [])];
	const kinds = seen.map((s) => s.kind);
	if (run.fault === "network-block-60s" && seen.length === 1) out.push(`The lane ended on ${kinds[0] === "question" ? "its question: OMP's retry carried it through" : `a ${kinds[0]} line: it did not survive the block`}.`, "");
	out.push(mdTable(seen.map((s) => ({ identity: s.identity, "first seen": `poll ${s.firstPoll} (${s.firstAt})`, text: s.text, "first text": s.firstText === s.text ? "" : s.firstText }))), "");

	out.push("## Egress proxy log", "");
	out.push(mdTable(run.egressLog.map((e) => ({ phase: e.phase, host: e.host, at: e.at ?? "" }))), "");

	if (run.runners.length > 0) {
		out.push("## Second runner", "");
		out.push(mdTable(run.runners.map((r) => ({ runner: r.label, exit: r.exitCode ?? "-", stderr: r.stderr }))), "");
	}

	out.push("## Stub requests per model", "");
	out.push(mdTable(Object.entries(run.stubCounts).map(([model, n]) => ({ model, requests: n }))), "");

	out.push("## Throwaway ledger rows", "");
	if (run.rows) {
		for (const [title, rows] of [["Workload", run.rows.workload ? [run.rows.workload] : []], ["Slices", run.rows.slices], ["Entries", run.rows.entries], ["Messages", run.rows.messages], ["Questions", run.rows.questions], ["Routings", run.rows.routings]] as const) {
			out.push(`### ${title}`, "", mdTable(rows), "");
		}
	} else out.push("_not read_", "");

	out.push("## Isolation", "");
	const iso = run.isolation;
	if (!iso) out.push("**No isolation proof**: the snapshots were not taken.");
	else {
		out.push(iso.ok ? "Live ledger, checkout and lanes roots: no change attributable to the run." : `**FAIL**: ${iso.failures.length} finding(s).`);
		for (const f of iso.failures) out.push(`- FAIL: ${f}`);
		out.push("", "### Live ledger rows changed", "");
		out.push(mdTable(iso.ledger.rows.map((r) => ({ change: r.change, table: r.table, id: r.key, by: r.actor ?? "", workload: r.workload ?? "", fail: r.fail ?? "" }))));
		if (iso.ledger.files.length > 0) out.push("", ...iso.ledger.files.map((f) => `- ledger${f} (listed, not failed)`));
		out.push("", "### Live checkout", "");
		out.push(iso.checkout.length === 0 ? "No difference in status, dirty-file hashes, HEAD, worktrees, refs, stash or the index mtime." : mdTable(iso.checkout.map((c) => ({ field: c.field, detail: c.detail, "attributed to": c.attributedTo ?? "(none: fails)" }))));
		out.push("", "### Live lanes roots", "");
		if (iso.listings.length === 0) out.push("No entry added, removed or changed.");
		const byDir = new Map<string, ListingChange[]>();
		for (const l of iso.listings) byDir.set(`${l.root}/${l.workload}`, [...(byDir.get(`${l.root}/${l.workload}`) ?? []), l]);
		for (const [dir, list] of byDir) {
			const wl = list[0]!.workload;
			const activity = iso.ledger.rows.filter((r) => r.workload === wl).length;
			out.push(`- ${dir}: ${list.length} change(s); live ledger rows changed on ${wl}: ${activity}`);
			for (const l of list.slice(0, LISTING_PATHS_SHOWN)) out.push(`  - ${l.fail ? "FAIL " : ""}${l.change} ${l.path}: ${l.detail}`);
			if (list.length > LISTING_PATHS_SHOWN) out.push(`  - … ${list.length - LISTING_PATHS_SHOWN} more`);
		}
	}
	out.push("", `Known limit: ${ISOLATION_LIMIT}`, "");
	return out.join("\n");
}
