// The one switch for auto-apply (PLAN wl-mvqwn80onq9hq8 D1). `routineState` is the only reader, and `routineOn` is its
// boolean: the gate (gates/extensions/r06-reserved.ts), ruling `routine-calls` (gates/src/rulings.ts), the plan auto-start,
// the review auto-extend and the ceiling's auto-raise all read it, inside the `ledger.write` that writes their rows, and
// never cache it. Auto-apply is on when all of these hold:
//
// (a) ruling `routine-calls` is active: no `end-ruling routine-calls` by Jo;
// (b) the newest switch event is not an off: Jo's `ask-all` (off) or `auto-routine` (on) on the standing workload, or
//     ESCALATION_BY's `auto-apply-tripped:` there (off, D5); with no event it is on (in-mvqwmr95k54feo);
// (c) no latch is set: an ESCALATION_BY `auto-applied:` row older than 10 minutes whose tool call has no
//     `auto-applied-result:` row, or a line in the alarm file (`alarmFilePath`) of any kind but `ceiling` (D12's needs-you
//     line, never a latch); a line with no or an unknown kind latches;
// (d) every trip and latch counts only when it is not older than Jo's latest `auto-routine`, so that word is the one
//     auditable recovery from every off state. Rows and alarm lines are never deleted; only their effect ends.
//
// Jo's words count only as Jo's instruction through the surface (author jo, channel surface, created_by SURFACE_BY), the
// check `endedRulings` makes; the machinery rows only through `controlEntries` (ESCALATION_BY's alone). Times compare in
// ms; a trip or latch at the same millisecond as the `auto-routine` still counts, so a tie fails closed. An alarm line
// with no readable `at` (a torn append) takes the `at` of the next timed line, else the file's mtime: appends are in
// order, so neither predates it. An alarm file that exists but cannot be read is itself a latch that `auto-routine`
// cannot clear, named in the state.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EntryRow, Ledger } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";
import { controlEntries } from "../../surface/src/launch";
import { ESCALATION_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { END_RULING_WORD } from "./rulings";

/** The ruling whose end turns auto-apply off (D6). */
export const ROUTINE_RULING = "routine-calls";
/** Jo's word that turns auto-apply off: the instruction body on the standing workload. */
export const ASK_ALL_WORD = "ask-all";
/** Jo's word that turns it back on and clears every older trip and latch. */
export const AUTO_ROUTINE_WORD = "auto-routine";
export type RoutineWord = typeof ASK_ALL_WORD | typeof AUTO_ROUTINE_WORD;
/** An `auto-applied:` row with no result this long latches (D1 (c)). */
export const MISSING_RESULT_MS = 10 * 60_000;
/** The alarm file's name, beside the default ledger (D5): never a lane's scratch. */
export const ALARM_FILE_NAME = "auto-apply-alarms.jsonl";
/** The alarm kind that is D12's needs-you line and never a latch. */
export const CEILING_ALARM_KIND = "ceiling";

/**
 * One alarm-file line: a JSON object on its own line, appended with O_APPEND. Every writer sets `kind` (`trip`, `result`
 * or `ceiling`) and `at` (ISO-8601); the rest (workload, tool call id, rule, signal, evidence, command, errors) is the
 * writer's (D5, D12).
 */
export interface AlarmLineHead {
	kind: string;
	at: string;
	[field: string]: unknown;
}

/** `~/.agent-system-2/auto-apply-alarms.jsonl`: the directory of `defaultLedgerPath(env)`. */
export function alarmFilePath(env: Record<string, string | undefined> = process.env): string {
	return join(dirname(defaultLedgerPath(env)), ALARM_FILE_NAME);
}

/** The ledger reads the switch needs; `Ledger` satisfies it. `db` reads the `auto-applied:` rows of every workload. */
export type RoutineLedger = Pick<Ledger, "instructions" | "entries" | "db">;

export interface RoutineOptions {
	/** The alarm file to read; default `alarmFilePath(process.env)`. */
	alarmFile?: string;
}

/** What turned the switch off: Jo's `ask-all` in force, or a trip that counts. */
export type SwitchOff = { by: "ask-all"; id: string; at: string } | { by: "trip"; id: string; at: string; rest: string };

/** A latch that counts (D1 (c), (d)). */
export type Latch =
	| { kind: "missing-result"; id: string; workloadId: string; toolCallId: string | null; at: string }
	| { kind: "alarm"; line: number; alarmKind: string | null; at: string; timeFrom: "line" | "next-line" | "file-mtime" }
	| { kind: "alarm-unreadable"; path: string; error: string };

export interface RoutineState {
	on: boolean;
	/** Jo's `end-ruling routine-calls` instruction id, or null while the ruling is active. */
	rulingEndedBy: string | null;
	/** The offs that count, oldest first. */
	offs: SwitchOff[];
	/** The latches that count, ledger rows first, then alarm lines in file order. */
	latches: Latch[];
	/** Jo's latest `auto-routine`, or null. */
	autoRoutine: { id: string; at: string } | null;
	/** The alarm file read. */
	alarmFile: string;
}

/** A time that counts against Jo's latest `auto-routine` at `since`: not older than it (a tie, or an unparseable time, counts). */
const counts = (t: number, since: number): boolean => !(t < since);

/**
 * The switch's whole state at `now` (ms since the epoch), read from the ledger and the alarm file each call. Throws only
 * when the default alarm path cannot be resolved (no HOME), so a caller's decision fails rather than defaulting to on.
 */
export function routineState(ledger: RoutineLedger, now: number, opts: RoutineOptions = {}): RoutineState {
	const alarmFile = opts.alarmFile ?? alarmFilePath(process.env);
	// Jo's own instructions through the surface: the only writer of Jo's words the switch reads (the check `endedRulings` makes).
	const words = ledger.instructions(STANDING_WORKLOAD_ID).filter(
		(i) => i.kind === "instruction" && i.author === "jo" && i.channel === "surface" && i.created_by === SURFACE_BY,
	);
	const ended = words.find((i) => i.body.trim() === `${END_RULING_WORD} ${ROUTINE_RULING}`) ?? null;
	const switches = words.filter((i) => i.body.trim() === ASK_ALL_WORD || i.body.trim() === AUTO_ROUTINE_WORD);
	const lastAuto = switches.findLast((i) => i.body.trim() === AUTO_ROUTINE_WORD) ?? null;
	const last = switches.at(-1) ?? null;
	const since = lastAuto === null ? Number.NEGATIVE_INFINITY : Date.parse(lastAuto.created_at);

	const offs: SwitchOff[] = [];
	// Both words are instructions, ordered (created_at, rowid): the last one stands.
	if (last !== null && last.body.trim() === ASK_ALL_WORD) offs.push({ by: "ask-all", id: last.id, at: last.created_at });
	for (const c of controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"))) {
		if (c.prefix === "auto-apply-tripped" && counts(Date.parse(c.createdAt), since)) offs.push({ by: "trip", id: c.id, at: c.createdAt, rest: c.rest });
	}
	offs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

	const latches: Latch[] = [...missingResults(ledger, now, since, lastAuto?.created_at ?? ""), ...alarmLatches(alarmFile, since)];
	return {
		on: ended === null && offs.length === 0 && latches.length === 0,
		rulingEndedBy: ended?.id ?? null,
		offs,
		latches,
		autoRoutine: lastAuto === null ? null : { id: lastAuto.id, at: lastAuto.created_at },
		alarmFile,
	};
}

/** Is auto-apply on at `now` (ms): `routineState(…).on`. Read inside the deciding `ledger.write`, never cached. */
export function routineOn(ledger: RoutineLedger, now: number, opts: RoutineOptions = {}): boolean {
	return routineState(ledger, now, opts).on;
}

/** ESCALATION_BY's `auto-applied:` rows, on any workload, not older than `sinceIso`, whose result is missing past `MISSING_RESULT_MS`. */
function missingResults(ledger: RoutineLedger, now: number, since: number, sinceIso: string): Latch[] {
	// Results follow their rows, so the same lower bound keeps both; `controlEntries` then checks prefix and writer.
	const rows = ledger.db.query<EntryRow, [string, string]>(
		"SELECT * FROM entries WHERE kind = 'assumption' AND created_by = ? AND substr(body, 1, 12) = 'auto-applied' AND created_at >= ? ORDER BY created_at, rowid",
	).all(ESCALATION_BY, sinceIso);
	const control = controlEntries(rows);
	const workloadOf = new Map(rows.map((r) => [r.id, r.workload_id]));
	const results = new Set(control.filter((c) => c.prefix === "auto-applied-result").map((c) => c.rest.split(/\s+/)[0]!).filter((t) => t !== ""));
	const out: Latch[] = [];
	for (const c of control) {
		if (c.prefix !== "auto-applied") continue;
		const t = Date.parse(c.createdAt);
		if (!counts(t, since)) continue;
		const toolCallId = c.rest.split(/\s+/)[1] ?? null;
		if (toolCallId !== null && results.has(toolCallId)) continue;
		// Past the window (an unparseable time is past it): the result was lost, so the switch is off everywhere.
		if (!(now - t <= MISSING_RESULT_MS)) out.push({ kind: "missing-result", id: c.id, workloadId: workloadOf.get(c.id)!, toolCallId, at: c.createdAt });
	}
	return out;
}

/**
 * The alarm-file lines that latch: every line not of kind `ceiling` and not older than `since`. A missing file is no line.
 * A line with no usable `at` takes the `at` of the first timed line after it (appends are in order), else the file's
 * mtime; while it is the file's untimed tail, any later append re-dates it, which fails closed until the next `auto-routine`.
 */
function alarmLatches(path: string, since: number): Latch[] {
	let text: string;
	let mtimeMs: number;
	try {
		// Read, then stat: the mtime is then an upper bound on every line read.
		text = readFileSync(path, "utf8");
		mtimeMs = statSync(path).mtimeMs;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [{ kind: "alarm-unreadable", path, error: err instanceof Error ? err.message : String(err) }];
	}
	const lines = text.split("\n").map((raw, i) => ({ n: i + 1, blank: raw.trim() === "", ...parseAlarmLine(raw) }));
	const out: Latch[] = [];
	let next: { at: string; from: "next-line" | "file-mtime" } = { at: new Date(Math.ceil(mtimeMs)).toISOString(), from: "file-mtime" };
	for (const line of lines.toReversed()) {
		if (line.blank) continue;
		const dated = line.at === null ? next : { at: line.at, from: "line" as const };
		if (line.at !== null) next = { at: line.at, from: "next-line" };
		if (line.kind === CEILING_ALARM_KIND || !counts(Date.parse(dated.at), since)) continue;
		out.push({ kind: "alarm", line: line.n, alarmKind: line.kind, at: dated.at, timeFrom: dated.from });
	}
	return out.reverse();
}

/** A line's `kind` and `at`, each null when the line is not a JSON object or lacks a usable one (such a line latches). */
export function parseAlarmLine(raw: string): { kind: string | null; at: string | null } {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		// Not JSON (a torn append): no kind, so it latches; the caller names its line number.
		return { kind: null, at: null };
	}
	if (v === null || typeof v !== "object" || Array.isArray(v)) return { kind: null, at: null };
	const o = v as Record<string, unknown>;
	const kind = typeof o.kind === "string" && o.kind !== "" ? o.kind : null;
	const at = typeof o.at === "string" && !Number.isNaN(Date.parse(o.at)) ? o.at : null;
	return { kind, at };
}

/** One latch or off in words, naming its row id or alarm-file line number. */
export function describeOff(x: SwitchOff | Latch): string {
	if ("by" in x) return x.by === "ask-all" ? `your ask-all (instruction ${x.id})` : `trip ${x.id} (${x.rest})`;
	switch (x.kind) {
		case "missing-result":
			return `auto-applied ${x.id} on ${x.workloadId} (tool call ${x.toolCallId ?? "unnamed"}) has no result after ${MISSING_RESULT_MS / 60_000} minutes`;
		case "alarm":
			return `alarm-file line ${x.line} (kind ${x.alarmKind ?? "none"})`;
		case "alarm-unreadable":
			return `alarm file ${x.path} cannot be read (${x.error}); fix the file's permissions, auto-routine cannot clear it`;
	}
}

/** Every reason the switch is off, in words; empty when it is on. */
export function offReasons(s: RoutineState): string[] {
	return [...(s.rulingEndedBy === null ? [] : [`ruling ${ROUTINE_RULING} ended (instruction ${s.rulingEndedBy})`]), ...s.offs.map(describeOff), ...s.latches.map(describeOff)];
}
