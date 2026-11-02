// The permanent merge train's daily dollar budget (PLAN wl-mvr888nftz0vcl D4, D5, D7, D13): $150 per America/Los_Angeles
// day, no wall. A train lane's runner (surface/scripts/lane.ts) meters its session files with `scanTrainDays`, a strict
// reader of its own (surface/src/ceiling.ts `scanSpend` stays the lenient reader every other workload's ceiling uses, R10):
// each assistant line's dollars land on the PDT day of its own timestamp, and any defect is an error that stops the lane.
// At the day's limit (`trainDayLimit`: $150 plus Jo's raises for that exact day) the runner writes `train-paused:`, asks Jo
// one raise/wait question on the pause's budget slice (`askTrainPause`) and stops the lane; `trainBudgetGate` then refuses
// every launch path (the predicate, the reservation, the tick) until midnight PDT, a raise for that day, or Jo's answer
// to a two-day or meter-error episode. Everything here is a pure function of ledger rows and the clock, except the
// question helper, which writes in the caller's transaction.
import { closeSync, type Dirent, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { EntryRow, InstructionRow, Ledger, QuestionRow, SliceRow } from "../../ledger/src/index";
import { askJo, raisedId } from "../../gates/src/rulings";
import { type ControlEntry, controlEntries, LANE_MAX_TIME_ENV, maxTimeMs } from "./launch";
import { trainSlicePr } from "./merge-train";
import { MERGE_TRAIN_BY, SURFACE_BY } from "./types";

// ---- the fixed rule ------------------------------------------------------------------------------

/** A train's dollars per PDT day before any raise. */
export const TRAIN_DAILY_USD = 150;
/** The day a train's budget renews in: midnight here starts a new day at TRAIN_DAILY_USD. */
export const TRAIN_TZ = "America/Los_Angeles";
/** A train run's `--max-time`, in minutes: a per-run hang backstop, not a wall (a shorter AGENT_SYSTEM_LANE_MAX_TIME wins). */
export const TRAIN_RUN_MAX_TIME_MIN = 1440;

// ---- PDT days ------------------------------------------------------------------------------------

const LA = new Intl.DateTimeFormat("en-US", {
	timeZone: TRAIN_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** The wall clock in TRAIN_TZ at `ms`, to the second. Throws on a non-finite instant: no day is ever guessed. */
function laWall(ms: number): { y: number; m: number; d: number; h: number; mi: number; s: number } {
	if (!Number.isFinite(ms)) throw new Error(`train-budget: the instant ${ms} is not a finite time; no PDT day can be read from it`);
	const part: Record<string, number> = {};
	for (const p of LA.formatToParts(new Date(ms))) if (p.type !== "literal") part[p.type] = Number(p.value);
	return { y: part.year!, m: part.month!, d: part.day!, h: part.hour!, mi: part.minute!, s: part.second! };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const dayOf = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** `YYYY-MM-DD`, the America/Los_Angeles calendar day of instant `ms`. */
export function pdtDay(ms: number): string {
	const w = laWall(ms);
	return dayOf(w.y, w.m, w.d);
}

/** TRAIN_TZ's offset from UTC at `ms`, in ms (wall clock minus UTC): -7 h in PDT, -8 h in PST. */
function offsetAt(ms: number): number {
	const t = Math.floor(ms / 1000) * 1000;
	const w = laWall(t);
	return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - t;
}

/**
 * The first instant of the America/Los_Angeles day after the one holding `ms`, in ms. The next day's wall midnight is
 * mapped to UTC by stepping the offset twice (the offset at a guess, then at the result), which lands exactly because LA
 * midnight is never inside a DST gap or overlap (both are at 02:00); the result is checked to be that midnight, so
 * 2026-11-01 (25 h) and 2027-03-14 (23 h) come out right and a wrong answer throws instead of renewing at the wrong time.
 */
export function nextPdtMidnight(ms: number): number {
	const w = laWall(ms);
	const wall = Date.UTC(w.y, w.m - 1, w.d + 1);
	let at = wall - offsetAt(wall);
	at = wall - offsetAt(at);
	const want = new Date(wall).toISOString().slice(0, 10);
	const got = laWall(at);
	if (dayOf(got.y, got.m, got.d) !== want || got.h !== 0 || got.mi !== 0 || got.s !== 0 || pdtDay(at - 1) !== pdtDay(ms)) {
		throw new Error(`train-budget: nextPdtMidnight(${new Date(ms).toISOString()}) computed ${new Date(at).toISOString()}, which is not midnight of ${want} in ${TRAIN_TZ}`);
	}
	return at;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The PDT day before `day` (`YYYY-MM-DD`); throws on a malformed day. */
export function prevPdtDay(day: string): string {
	const m = DAY_RE.exec(day);
	if (!m) throw new Error(`train-budget: ${JSON.stringify(day)} is not a YYYY-MM-DD day`);
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1)).toISOString().slice(0, 10);
}

/** Dollars as rows and Jo read them: whole dollars bare (`150`), anything else to the cent (`150.12`). */
export function usdText(usd: number): string {
	const cents = Math.round(usd * 100) / 100;
	return Number.isInteger(cents) ? String(cents) : cents.toFixed(2);
}

// ---- the strict meter ----------------------------------------------------------------------------

/** One session file's scan position: the bytes and the complete lines read so far. */
export interface TrainScanFile {
	offset: number;
	lines: number;
}
/** What a runner's scans have read: each file's position, and dollars per PDT day (`pdtDay` of each line's own timestamp). */
export interface TrainScan {
	files: ReadonlyMap<string, TrainScanFile>;
	days: ReadonlyMap<string, number>;
}
/** A defect the strict scan refuses to count past: the file (or directory), the 1-based line (0 for no line), and why. */
export interface TrainScanError {
	file: string;
	line: number;
	reason: string;
}
/** One scan's result: the new position and totals, and every defect it found. */
export interface TrainScanResult {
	scan: TrainScan;
	errors: TrainScanError[];
}

/** A runner's scan before its first read: every file starts at byte 0, so a restarted runner rescans everything. */
export const emptyTrainScan = (): TrainScan => ({ files: new Map(), days: new Map() });

/** `v[key]` when `v` is an object carrying `key`, else undefined: the one guarded read of parsed JSON and thrown errors here. */
const field = (v: unknown, key: string): unknown => (v !== null && typeof v === "object" && key in v ? Reflect.get(v, key) : undefined);
const errText = (err: unknown): string => {
	const code = field(err, "code");
	return `${code === undefined ? "" : `${String(code)}: `}${err instanceof Error ? err.message : String(err)}`.replace(/\s+/g, " ").trim();
};

/** Every `*.jsonl` under `dir`, recursively (a hand's file is `<session>/<agent>.jsonl`); a vanished directory has none, any other read error is reported. */
function sessionFiles(dir: string, errors: TrainScanError[]): string[] {
	let items: Dirent[];
	try {
		items = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		if (field(err, "code") !== "ENOENT") errors.push({ file: dir, line: 0, reason: `the directory could not be read (${errText(err)})` });
		return [];
	}
	const out: string[] = [];
	for (const d of items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		const p = join(dir, d.name);
		if (d.isDirectory()) out.push(...sessionFiles(p, errors));
		else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

/** The bytes of `file` from `from` through its last newline; null when the file is gone; throws any other read error. */
function completeBytes(file: string, from: number): { text: string; bytes: number } | null {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch (err) {
		if (field(err, "code") === "ENOENT") return null;
		throw err;
	}
	try {
		const size = fstatSync(fd).size;
		if (size < from) throw new Error(`the file shrank to ${size} bytes, below the ${from} already counted`);
		if (size === from) return { text: "", bytes: 0 };
		const buf = Buffer.alloc(size - from);
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, from + got);
			if (n === 0) break;
			got += n;
		}
		const end = buf.subarray(0, got).lastIndexOf(0x0a);
		return end < 0 ? { text: "", bytes: 0 } : { text: buf.subarray(0, end).toString("utf8"), bytes: end + 1 };
	} finally {
		closeSync(fd);
	}
}

/** One complete line's dollars and PDT day, null for a line that is not an assistant message, or the defect. */
function lineCost(line: string): { usd: number; day: string } | null | { reason: string } {
	let v: unknown;
	try {
		v = JSON.parse(line);
	} catch {
		return { reason: "the line is not JSON" };
	}
	if (field(v, "type") !== "message" || field(field(v, "message"), "role") !== "assistant") return null;
	const stamp = field(v, "timestamp");
	const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
	if (!Number.isFinite(at)) return { reason: "an assistant line with no parseable top-level timestamp" };
	const total = field(field(field(field(v, "message"), "usage"), "cost"), "total");
	if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return { reason: "an assistant line with no finite non-negative message.usage.cost.total" };
	return { usd: total, day: pdtDay(at) };
}

/**
 * The strict incremental scan (D4): every `*.jsonl` under `dir`, recursively, read from `prev`'s position through its last
 * newline, each complete assistant line's `message.usage.cost.total` added to `pdtDay(timestamp)`. A trailing partial line
 * waits for the next scan. Every other defect is an error, never a zero or a re-dated line: a directory or file read error
 * other than "not there", a file that shrank, a complete line that is not JSON, an assistant line with no parseable
 * top-level `timestamp` or no finite non-negative cost. The scan goes on past a defect so every one is reported; the caller
 * stops the lane on any. `prev` is not changed.
 */
export function scanTrainDays(dir: string, prev: TrainScan): TrainScanResult {
	const errors: TrainScanError[] = [];
	const files = new Map(prev.files);
	const days = new Map(prev.days);
	for (const file of sessionFiles(dir, errors)) {
		const at = files.get(file) ?? { offset: 0, lines: 0 };
		let chunk: { text: string; bytes: number } | null;
		try {
			chunk = completeBytes(file, at.offset);
		} catch (err) {
			errors.push({ file, line: at.lines, reason: `the file could not be read (${errText(err)})` });
			continue;
		}
		if (chunk === null || chunk.bytes === 0) continue;
		const lines = chunk.text.split("\n");
		lines.forEach((line, i) => {
			const c = lineCost(line);
			if (c === null) return;
			if ("reason" in c) errors.push({ file, line: at.lines + i + 1, reason: c.reason });
			else days.set(c.day, (days.get(c.day) ?? 0) + c.usd);
		});
		files.set(file, { offset: at.offset + chunk.bytes, lines: at.lines + lines.length });
	}
	return { scan: { files, days }, errors };
}

/** A train run's `--max-time`: TRAIN_RUN_MAX_TIME_MIN, or AGENT_SYSTEM_LANE_MAX_TIME when that is set, OMP-parsable and shorter. */
export function trainMaxTime(env: Record<string, string | undefined>): string {
	const backstop = `${TRAIN_RUN_MAX_TIME_MIN}m`;
	const v = env[LANE_MAX_TIME_ENV]?.trim();
	const ms = v ? maxTimeMs(v) : null;
	return v && ms !== null && ms < TRAIN_RUN_MAX_TIME_MIN * 60_000 ? v : backstop;
}

// ---- rows ----------------------------------------------------------------------------------------

/** `train-paused: <lane> day <YYYY-MM-DD> usd <x> limit <L> pr <N|none> until <iso>`: the runner's alone (LANE_RUNNER_BY). */
export interface TrainPause {
	entryId: string;
	laneId: string;
	day: string;
	usd: number;
	limit: number;
	pr: number | null;
	until: string;
	createdAt: string;
}
export function trainPausedBody(p: Omit<TrainPause, "entryId" | "createdAt">): string {
	return `train-paused: ${p.laneId} day ${p.day} usd ${usdText(p.usd)} limit ${usdText(p.limit)} pr ${p.pr ?? "none"} until ${p.until}`;
}
const PAUSED_RE = /^(lane-\S+) day (\d{4}-\d{2}-\d{2}) usd (\S+) limit (\S+) pr ([1-9]\d*|none) until (\S+)$/;
const money = (s: string): number | null => {
	const n = Number(s);
	return /^\d+(?:\.\d+)?$/.test(s) && Number.isFinite(n) ? n : null;
};
/** Every valid `train-paused:` among `control` (`controlEntries`, so only the runner's), oldest first. */
export function trainPauses(control: readonly ControlEntry[]): TrainPause[] {
	const out: TrainPause[] = [];
	for (const c of control) {
		if (c.prefix !== "train-paused") continue;
		const m = PAUSED_RE.exec(c.rest);
		const usd = m ? money(m[3]!) : null;
		const limit = m ? money(m[4]!) : null;
		if (!m || usd === null || limit === null || !Number.isFinite(Date.parse(m[6]!))) continue;
		out.push({ entryId: c.id, laneId: m[1]!, day: m[2]!, usd, limit, pr: m[5] === "none" ? null : Number(m[5]), until: m[6]!, createdAt: c.createdAt });
	}
	return out;
}

/** `train-raise: day <YYYY-MM-DD> usd <x> answer <id>`: the surface's alone, Jo's `raise <usd>` answer written in the same transaction. */
export interface TrainRaise {
	entryId: string;
	day: string;
	usd: number;
	answerId: string;
	createdAt: string;
}
export function trainRaiseBody(day: string, usd: number, answerId: string): string {
	return `train-raise: day ${day} usd ${usdText(usd)} answer ${answerId}`;
}
const RAISE_RE = /^day (\d{4}-\d{2}-\d{2}) usd (\S+) answer (\S+)$/;
/** Every valid `train-raise:` among `control`, oldest first; a non-positive amount raises nothing. */
export function trainRaises(control: readonly ControlEntry[]): TrainRaise[] {
	const out: TrainRaise[] = [];
	for (const c of control) {
		if (c.prefix !== "train-raise") continue;
		const m = RAISE_RE.exec(c.rest);
		const usd = m ? money(m[2]!) : null;
		if (!m || usd === null || usd <= 0) continue;
		out.push({ entryId: c.id, day: m[1]!, usd, answerId: m[3]!, createdAt: c.createdAt });
	}
	return out;
}

/** `train-meter-error: <lane> <file>:<line> <reason>`: the runner's alone; the episode is the entry (D5, D9). */
export function trainMeterErrorBody(laneId: string, e: TrainScanError): string {
	return `train-meter-error: ${laneId} ${e.file}:${e.line} ${e.reason}`.replace(/\s*\n\s*/g, " ");
}
/** Every valid `train-meter-error:` among `control`, oldest first; each is one episode whatever its text says. */
export function trainMeterErrors(control: readonly ControlEntry[]): { entryId: string; laneId: string; detail: string; createdAt: string }[] {
	const out: { entryId: string; laneId: string; detail: string; createdAt: string }[] = [];
	for (const c of control) {
		if (c.prefix !== "train-meter-error") continue;
		const m = /^(lane-\S+)\s+([\s\S]+)$/.exec(c.rest);
		if (m) out.push({ entryId: c.id, laneId: m[1]!, detail: m[2]!, createdAt: c.createdAt });
	}
	return out;
}

/** `train-rule: <lane> permanent budget 150 per PDT day max-time <spec>`: the runner's live receipt at every train lane start (D10, R22). */
export function trainRuleBody(laneId: string, maxTime: string): string {
	return `train-rule: ${laneId} permanent budget ${TRAIN_DAILY_USD} per PDT day max-time ${maxTime}`;
}

/** D4: the day's dollar limit, TRAIN_DAILY_USD plus every `train-raise:` for exactly `day`; a raise never moves another day. */
export function trainDayLimit(control: readonly ControlEntry[], day: string): number {
	return trainRaises(control).filter((r) => r.day === day).reduce((sum, r) => sum + r.usd, TRAIN_DAILY_USD);
}

/** D4: the runner's prompt line for a train, in place of the ceiling line. */
export function trainBudgetPromptLine(limit: number, spentToday: number, renews: string): string {
	return `budget: $${usdText(limit)} for today (${TRAIN_TZ}; $${TRAIN_DAILY_USD} base); spent today $${spentToday.toFixed(2)}; renews ${renews}; no wall ceiling. At the limit the runner stops this lane and Jo is asked raise or wait.`;
}

// ---- the budget slice and its question (D7, D9) --------------------------------------------------

/** The budget slice of train `wl` for the pause or meter error `entryId`: `sl-train-<k>-budget-<entry id without en->`, never a PR's slice. */
export function trainBudgetSliceId(wl: string, entryId: string): string {
	return `sl-train-${wl.replace(/^wl-/, "")}-budget-${entryId.replace(/^en-/, "")}`;
}

/** Add the budget slice for `entryId` as the tick when it is not there; its id either way. */
export function ensureTrainBudgetSlice(ledger: Ledger, wl: string, entryId: string, what: string): string {
	const sl = trainBudgetSliceId(wl, entryId);
	if (!ledger.slice(sl)) {
		ledger.addSlice({ by: MERGE_TRAIN_BY, workloadId: wl, id: sl, task: `${what} on merge train ${wl}`, doneCondition: `Jo answered, or the episode of ${entryId} is over`, inputs: entryId });
	}
	return sl;
}

/** The merge-train questions keyed to `entryId` (on its budget slice), oldest first. */
export function budgetQuestions(wl: string, questions: readonly QuestionRow[], entryId: string): QuestionRow[] {
	const sl = trainBudgetSliceId(wl, entryId);
	return questions.filter((q) => q.slice_id === sl && q.created_by === MERGE_TRAIN_BY);
}

/** Jo's answer that resolved `q`: an `answer` instruction, author jo, written by the surface; null for an open or withdrawn question or another writer. */
export function joAnswerTo(q: QuestionRow, instructions: readonly InstructionRow[]): InstructionRow | null {
	if (q.state !== "answered" || q.resolved_by === null) return null;
	const ins = instructions.find((i) => i.id === q.resolved_by);
	return ins && ins.kind === "answer" && ins.question_id === q.id && ins.author === "jo" && ins.created_by === SURFACE_BY ? ins : null;
}

/** The pause question's options (D7): Jo raises the day's limit or waits for midnight. */
export const TRAIN_PAUSE_OPTIONS = ["raise", "wait"] as const;

/** D5's two-day predicate: `p`'s PDT day and the day before it both have a pause. */
export function twoDayPause(pauses: readonly TrainPause[], p: TrainPause): boolean {
	const before = prevPdtDay(p.day);
	return pauses.some((q) => q.day === before);
}

/** D7: the pause question; its first line is the one line Jo reads, the tail says what `wait` and no answer do. */
export function trainPauseQuestionBody(wl: string, p: TrainPause, twoDay: boolean): string {
	const on = p.pr === null ? "no PR" : `PR #${p.pr}`;
	const first = `merge train ${wl} spent $${p.usd.toFixed(2)} of its $${usdText(p.limit)} for ${p.day} (PDT) while on ${on}; paused until midnight PDT (${p.until})`;
	const raise = `Answer \`raise <usd>\` (for example \`raise 50\`): the limit for ${p.day} (PDT) grows by that amount for that day only, and the train relaunches now.`;
	const tail = twoDay
		? `This is the second full PDT day in a row at the limit: \`wait\` resumes it at midnight (at once if answered after midnight); no answer keeps it paused past midnight until you answer.`
		: `Answer \`wait\`, or do not answer: it resumes at midnight PDT on its own, at $${TRAIN_DAILY_USD} for the new day.`;
	return `${first}\n${raise}\n${tail}`;
}

/**
 * D7: the one raise/wait question of pause `pauseEntryId` on train `wl`, as the tick (MERGE_TRAIN_BY), in the caller's
 * transaction (or its own): ensure-or-reuse, so a question already keyed to this pause (open or not) is returned and
 * nothing is written. Throws, asking nothing, when the entry is no valid `train-paused:` of `wl`.
 */
export function askTrainPause(ledger: Ledger, wl: string, pauseEntryId: string): string {
	return ledger.write(() => {
		const pauses = trainPauses(controlEntries(ledger.entries(wl, "assumption")));
		const p = pauses.find((x) => x.entryId === pauseEntryId);
		if (!p) throw new Error(`askTrainPause: ${pauseEntryId} is no runner-written train-paused: entry on ${wl}; nothing asked`);
		const asked = budgetQuestions(wl, ledger.questions(wl), pauseEntryId)[0];
		if (asked !== undefined) return asked.id;
		const sl = ensureTrainBudgetSlice(ledger, wl, pauseEntryId, `budget pause ${pauseEntryId} (${p.day})`);
		const r = askJo(ledger, { by: MERGE_TRAIN_BY, workloadId: wl, sliceId: sl, body: trainPauseQuestionBody(wl, p, twoDayPause(pauses, p)), options: [...TRAIN_PAUSE_OPTIONS] }, { asker: "train" });
		return raisedId(r, `the budget pause question ${pauseEntryId} of ${wl}`);
	});
}

// ---- the gate (D5) -------------------------------------------------------------------------------

export type TrainBudgetReason = "budget-paused" | "budget-decision" | "meter-error";
/** A refusal: the reason, the episode's entry (the pause or the meter error), and a line naming what clears it. */
export interface TrainBudgetRefusal {
	reason: TrainBudgetReason;
	entryId: string;
	detail: string;
}
/** The rows the gate reads: the train's valid control entries (`controlEntries`) and its questions and instructions. */
export interface TrainBudgetRows {
	workloadId: string;
	control: readonly ControlEntry[];
	questions: readonly QuestionRow[];
	instructions: readonly InstructionRow[];
}

/**
 * D5, pure (rows and the clock): why no launch path may start train `rows.workloadId` at `now`, or null. Checked in this
 * order, each an episode Jo can see by its entry id:
 * - `meter-error`: a `train-meter-error:` Jo has not cleared: his `relaunch` answer to the question keyed to that entry, or
 *   a `launch-requested: by jo` written after it. An open question, `hold`, or another episode's answer keeps refusing.
 * - `budget-paused`: the newest `train-paused:` P has `until` after `now` and no `train-raise:` for P's day after P.
 * - `budget-decision`: P's day and the PDT day before it both paused, `now` is at or past P's `until`, and Jo has not
 *   cleared it: any answer of his to P's question, or a `launch-requested: by jo` written at or after `until`.
 */
export function trainBudgetGate(rows: TrainBudgetRows, now: string): TrainBudgetRefusal | null {
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) throw new Error(`trainBudgetGate: now ${JSON.stringify(now)} is not a time; the gate cannot decide ${rows.workloadId}`);
	const index = new Map(rows.control.map((c, i) => [c.id, i]));
	const requests = rows.control.filter((c) => c.prefix === "launch-requested" && c.createdBy === SURFACE_BY && /^by jo\b/.test(c.rest));
	for (const e of trainMeterErrors(rows.control)) {
		const at = index.get(e.entryId)!;
		const relaunched = budgetQuestions(rows.workloadId, rows.questions, e.entryId)
			.some((q) => joAnswerTo(q, rows.instructions)?.body.trim().toLowerCase() === "relaunch");
		if (relaunched || requests.some((r) => index.get(r.id)! > at)) continue;
		return { reason: "meter-error", entryId: e.entryId, detail: `the train's meter failed (${e.detail}); Jo's \`relaunch\` answer or launch word clears it` };
	}
	const pauses = trainPauses(rows.control);
	const p = pauses.at(-1);
	if (p === undefined) return null;
	const untilMs = Date.parse(p.until);
	if (nowMs < untilMs) {
		const at = index.get(p.entryId)!;
		const raised = trainRaises(rows.control).some((r) => r.day === p.day && index.get(r.entryId)! > at);
		if (!raised) return { reason: "budget-paused", entryId: p.entryId, detail: `paused at $${p.usd.toFixed(2)} of $${usdText(p.limit)} for ${p.day} (PDT) until ${p.until}; a raise for ${p.day} lifts it` };
		return null;
	}
	if (!twoDayPause(pauses, p)) return null;
	const answered = budgetQuestions(rows.workloadId, rows.questions, p.entryId).some((q) => joAnswerTo(q, rows.instructions) !== null);
	if (answered || requests.some((r) => Date.parse(r.createdAt) >= untilMs)) return null;
	return { reason: "budget-decision", entryId: p.entryId, detail: `paused on ${prevPdtDay(p.day)} and ${p.day} (PDT); held past ${p.until} until Jo answers wait or raise, or gives a launch word` };
}

/** The gate's rows out of a reservation's or predicate's raw rows. */
export function trainBudgetRows(r: { workload: { id: string }; entries: readonly EntryRow[]; questions: readonly QuestionRow[]; instructions: readonly InstructionRow[] }): TrainBudgetRows {
	return { workloadId: r.workload.id, control: controlEntries(r.entries), questions: r.questions, instructions: r.instructions };
}

// ---- the PR a stopping lane was on (D4, D13) -----------------------------------------------------

const PR_MARKER = /^train-pr:\s+([1-9]\d*)\s+start\b/;

/**
 * The PR lane `laneId` of train `workloadId` was working when it stopped: its newest `train-pr: <n> start` marker (its own
 * write) first; else the PR whose disposition or full-suite slice carries the lane's newest row (an entry on that slice,
 * or the slice's add or completion by the lane); else null (`pr none`), never a PR the lane did not touch.
 */
export function activeTrainPr(rows: { workloadId: string; entries: readonly EntryRow[]; slices: readonly SliceRow[] }, laneId: string): number | null {
	for (let i = rows.entries.length - 1; i >= 0; i--) {
		const e = rows.entries[i]!;
		if (e.created_by !== laneId) continue;
		const m = PR_MARKER.exec(e.body.trim());
		if (m) return Number(m[1]);
	}
	// Every row the lane wrote on one of this train's PR slices, as [time, slice]; the newest (the later row on a tie) names the PR.
	const rowsOf: [string, string | null][] = [];
	for (const s of rows.slices) {
		if (s.created_by === laneId) rowsOf.push([s.created_at, s.id]);
		if (s.state === "done" && s.changed_by === laneId) rowsOf.push([s.changed_at, s.id]);
	}
	for (const e of rows.entries) if (e.created_by === laneId) rowsOf.push([e.created_at, e.slice_id]);
	let best: { at: string; pr: number } | null = null;
	for (const [at, sliceId] of rowsOf) {
		const pr = sliceId === null ? null : trainSlicePr(sliceId, rows.workloadId);
		if (pr !== null && (best === null || at >= best.at)) best = { at, pr };
	}
	return best?.pr ?? null;
}
