// The suggest-only `pair` trigger (PLAN wl-mv67564rdkfvnk § 2 D1–D9, PR 1; PLAN wl-mvb9mw00ycfjeo D1–D3). Two existing
// raise sites — the classifier's round-limit question (classifier/extension.ts `roundSettled`) and the lane runner's
// ceiling question (surface/scripts/lane.ts `raiseCeilingQuestion`) — store the option `pair` last and write a
// `pair-offer:` entry when the installed profile's `pairSuggest` switch covers the workload and a signal fired
// (`pairOffer`). The body is never touched: it is byte-identical to the raise without this module, and every surface
// render shows the offer as its own line instead (`pairOfferLine`, `pairPendingLine`), reading the `pair-offer:` entry.
//
// Signals (D3), each computed from ledger rows only:
//   a  the slice's review loop is stalled: two or more complete rounds with a known blocking count, the last at least
//      the first (round-limit site only, from the count the raise read);
//   b  three or more long steers from Jo: surface-written instructions, author jo, channel surface, whose quoted words
//      (a relay `Jo: "<words>" — reading: …`) or whole body run past 80 characters; d2 adds one;
//   c  no slice done yet (the ceiling site only, and only with another signal);
//   d1 jev reads the brief as ambiguous, e jev reads it as UI/taste work: the newest classifier-stamped `pair-signal:`
//      with that answer `yes` at a confidence of 0.70 or more;
//   d2 two or more `revise` answers on the plan question (listed only with b, which it feeds).
// D5 caps the offers per workload: two at most, none within 60 minutes of the last, and after Jo answered an offered
// question with another word, none until a signal fires that was neither in that offer nor firing when Jo answered.
//
// The rows (D4, D7, D9): `pair-signal:` / `pair-signal-failed:` (the classifier's jev attempt), `pair-exposure:` (the
// lane's classifier, once per lane session, when the switch covers its workload), `pair-offer:` (the raise site's record
// that it offered pair: CLASSIFIER_BY at the round limit, LANE_RUNNER_BY at the ceiling) and `pair-taken:` (the surface,
// when Jo answers pair). The first four are classifier machinery prefixes and the last a surface control prefix
// (surface/src/launch.ts), so no lane tool writes any of them.
//
// D8: `mechanicalEligibility` is the ungated A/B/C read at a moment, `pairSuggestHealth` the per-lane number the report
// compares across switched-on and switched-off lanes (surface/scripts/pair-suggest.ts), and `pairLaneExposure` the
// group (on or off) a lane is counted in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countRounds, parseReviewRound, type RoundCount } from "../../classifier/src/rounds";
import { joAuthority } from "../../ledger/src/authority";
import {
	CLASSIFIER_BY, type EntryRow, type InstructionRow, LANE_RUNNER_BY, type Ledger, type SliceRow, type WorkloadRow,
} from "../../ledger/src/index";
import { homeDir } from "../../ledger/src/locality";
import { byHandLine, controlEntries, holdersOf, isPlanQuestionIn } from "./launch";

export const PAIR_OPTION = "pair";
export type PairSite = "round-limit" | "ceiling";
export const PAIR_SIGNALS = ["a", "b", "c", "d1", "d2", "e"] as const;
export type PairSignalId = (typeof PAIR_SIGNALS)[number];

/** D3: the jev answer counts at this confidence of the chosen answer or more. */
export const PAIR_CONFIDENCE = 0.7;
/** D3 B: a steer is long past this many characters of Jo's own words. */
export const LONG_STEER_CHARS = 80;
/** D3 B: long steers (plus one for D2) that fire B. */
export const LONG_STEERS = 3;
/** D3 D2: `revise` answers on the plan question that add one to B. */
export const PLAN_REVISES = 2;
/** D5: offers per workload. */
export const MAX_OFFERS = 2;
/** D5: no offer within this long of the last one. */
export const OFFER_GAP_MS = 60 * 60_000;

/** The reads every function here makes; `Ledger` satisfies it, and the classifier's ledger is a `Ledger` at run time. */
export type PairLedger = Pick<Ledger, "workload" | "entries" | "instructions" | "questions" | "question" | "slices" | "holders" | "now">;

// ---- the switch (D2) ------------------------------------------------------------------------------------------------

/** The installed profile's config, where bin/as2 `CONFIG` and lane.ts preflight look: `$HOME/.omp/profiles/<profile>/agent/config.yml`. */
export function installedConfigPath(env: Record<string, string | undefined> = process.env): string {
	const profile = env.AGENT_SYSTEM_PROFILE || env.OMP_PROFILE || "agent-system-2";
	return join(homeDir(env), ".omp", "profiles", profile, "agent", "config.yml");
}

/** The installed config parsed, read fresh at each call (a switch flipped mid-session holds at the next raise); null when missing or unreadable. */
export function readPairSuggestConfig(env: Record<string, string | undefined> = process.env): unknown {
	try {
		return Bun.YAML.parse(readFileSync(installedConfigPath(env), "utf8"));
	} catch {
		return null;
	}
}

/** D2: `pairSuggest: all`, or a list naming the workload. Anything else, a missing key or a malformed value included, is off. */
export function pairSuggestOn(config: unknown, workloadId: string): boolean {
	if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
	const value: unknown = Reflect.get(config, "pairSuggest");
	if (value === "all") return true;
	return Array.isArray(value) && value.every((x) => typeof x === "string") && value.includes(workloadId);
}

// ---- the rows -------------------------------------------------------------------------------------------------------

/** `0.0000481` from a dollar figure: fixed to ten places, trailing zeros dropped, never an exponent. */
function dollars(usd: number): string {
	const fixed = usd.toFixed(10);
	return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

const known = (n: number | null | undefined, show: (x: number) => string): string => (n === null || n === undefined ? "unknown" : show(n));

/**
 * `pair-signal: taste <yes|no> <conf> ambiguous <yes|no> <conf> judge <provider/model> tokens <n|unknown> cost <dollars|unknown>`:
 * the classifier's one successful jev answer on the brief (D4).
 */
export function pairSignalBody(
	answers: Record<"taste" | "ambiguous", { choice: string; confidence: number }>,
	judge: string,
	tokens: number | null | undefined,
	cost: number | null,
): string {
	// Confidences unrounded: the 0.70 cut reads the judge's own value back, so a written value never crosses it (0.69996 stays below).
	return `pair-signal: taste ${answers.taste.choice} ${String(answers.taste.confidence)} ambiguous ${answers.ambiguous.choice} ${String(answers.ambiguous.confidence)} judge ${judge} tokens ${known(tokens, String)} cost ${known(cost, dollars)}`;
}

/** `pair-signal-failed: attempt <n> <timeout|error|malformed> tokens <n|unknown> cost <dollars|unknown>`: one failed attempt of three. */
export function pairSignalFailedBody(attempt: number, failure: "timeout" | "error" | "malformed", tokens: number | null | undefined, cost: number | null): string {
	return `pair-signal-failed: attempt ${attempt} ${failure} tokens ${known(tokens, String)} cost ${known(cost, dollars)}`;
}

/** `pair-offer: <q> site <round-limit|ceiling> signals <a,b,…>`: the raise site offered pair on question q. */
export function pairOfferBody(questionId: string, site: PairSite, signals: readonly PairSignalId[]): string {
	return `pair-offer: ${questionId} site ${site} signals ${signals.join(",")}`;
}

/** `pair-exposure: <laneId> on`: the lane's classifier read the switch covering its workload (review round 2, D8's group). */
export function pairExposureBody(laneId: string): string {
	return `pair-exposure: ${laneId} on`;
}

/** `pair-taken: <q> by <answer> mode user-driven`: Jo answered pair (D7). */
export function pairTakenBody(questionId: string, answerId: string): string {
	return `pair-taken: ${questionId} by ${answerId} mode user-driven`;
}

export interface PairSignalEntry {
	taste: { yes: boolean; confidence: number; text: string };
	ambiguous: { yes: boolean; confidence: number; text: string };
	judge: string;
	tokens: number | null;
	cost: number | null;
}

// `tokens` is optional so entries written before the field (`… judge typesafe/jev-1.13.0 cost 0.0001`) still read.
const PAIR_SIGNAL = /^pair-signal: taste (yes|no) (\S+) ambiguous (yes|no) (\S+) judge (\S+)(?: tokens (\d+|unknown))? cost (\S+)$/;

/** A `pair-signal:` body parsed; null when malformed or a confidence is not a number in [0, 1]. */
export function parsePairSignal(body: string): PairSignalEntry | null {
	const m = PAIR_SIGNAL.exec(body.trim());
	if (!m) return null;
	const taste = Number(m[2]);
	const ambiguous = Number(m[4]);
	if (![taste, ambiguous].every((c) => Number.isFinite(c) && c >= 0 && c <= 1)) return null;
	const cost = m[7] === "unknown" ? null : Number(m[7]);
	return {
		taste: { yes: m[1] === "yes", confidence: taste, text: m[2]! },
		ambiguous: { yes: m[3] === "yes", confidence: ambiguous, text: m[4]! },
		judge: m[5]!,
		tokens: m[6] === undefined || m[6] === "unknown" ? null : Number(m[6]),
		cost: cost !== null && Number.isFinite(cost) ? cost : null,
	};
}

const PAIR_SIGNAL_FAILED = /^pair-signal-failed: attempt (\d+) (timeout|error|malformed)(?: tokens (\d+|unknown))? cost (\S+)$/;

/** A `pair-signal-failed:` body parsed; null when malformed. */
export function parsePairSignalFailed(body: string): { attempt: number; failure: string; tokens: number | null; cost: number | null } | null {
	const m = PAIR_SIGNAL_FAILED.exec(body.trim());
	if (!m) return null;
	const cost = m[4] === "unknown" ? null : Number(m[4]);
	return { attempt: Number(m[1]), failure: m[2]!, tokens: m[3] === undefined || m[3] === "unknown" ? null : Number(m[3]), cost: cost !== null && Number.isFinite(cost) ? cost : null };
}

const PAIR_OFFER = /^pair-offer: (\S+) site (round-limit|ceiling) signals ([a-z0-9]+(?:,[a-z0-9]+)*)$/;

/** A `pair-offer:` body parsed; null when malformed. */
export function parsePairOffer(body: string): { questionId: string; site: PairSite; signals: string[] } | null {
	const m = PAIR_OFFER.exec(body.trim());
	return m ? { questionId: m[1]!, site: m[2] as PairSite, signals: m[3]!.split(",") } : null;
}

/** The stamp a raise site writes its `pair-offer:` with: the classifier at the round limit, the runner at the ceiling. */
export function pairOfferStamp(site: PairSite): string {
	return site === "round-limit" ? CLASSIFIER_BY : LANE_RUNNER_BY;
}

// ---- signals --------------------------------------------------------------------------------------------------------

interface Fired {
	id: PairSignalId;
}

/** The workload's rows read once, cut by `upTo` to those written at or before `at`. */
interface Rows {
	workload: WorkloadRow;
	entries: EntryRow[];
	instructions: InstructionRow[];
	slices: SliceRow[];
	holders: string[];
}

function readRows(ledger: PairLedger, workload: WorkloadRow): Rows {
	const id = workload.id;
	return { workload, entries: ledger.entries(id), instructions: ledger.instructions(id), slices: ledger.slices(id), holders: ledger.holders(id) };
}

/** The rows as they stood at `at`: those written at or before it, and a slice done after `at` read as not done at `at`. */
function upTo(rows: Rows, at: string): Rows {
	return {
		...rows,
		entries: rows.entries.filter((e) => e.created_at <= at),
		instructions: rows.instructions.filter((i) => i.created_at <= at),
		slices: rows.slices.filter((s) => s.created_at <= at).map((s) => (s.state === "done" && s.changed_at > at ? { ...s, state: "open" } : s)),
	};
}

/** A: is the loop stalled — two or more complete rounds with a known blocking count, the last at least the first. */
function stalled(count: RoundCount): boolean {
	const rounds = count.rounds.filter((r) => r.complete && r.blocking !== null);
	if (rounds.length < 2) return false;
	return rounds[rounds.length - 1]!.blocking! >= rounds[0]!.blocking!;
}

/** A over every slice with review rounds in `rows`: is any loop stalled. */
function stalledAnywhere(rows: Rows): boolean {
	const slices = new Set<string>();
	for (const e of rows.entries) {
		const r = e.kind === "assumption" ? parseReviewRound(e.body) : null;
		if (r) slices.add(r.slice);
	}
	for (const sl of slices) if (stalled(countRounds(rows.entries, sl))) return true;
	return false;
}

/** Jo's own words in a surface instruction: the quoted words of a relay, else the whole body. */
const RELAY = /^Jo\b[^"]*"([\s\S]*)"\s+—\s+reading\b/;

/** B's count: Jo's long steers since open. */
function longSteers(rows: Rows): number {
	return rows.instructions.filter((i) => {
		if (i.kind !== "instruction" || !joAuthority(i) || i.channel !== "surface") return false;
		const words = RELAY.exec(i.body)?.[1] ?? i.body;
		return words.trim().length > LONG_STEER_CHARS;
	}).length;
}

/** D2's count: Jo's `revise` answers on the plan question. */
function planRevises(rows: Rows): number {
	const control = controlEntries(rows.entries, holdersOf(rows.entries, rows.workload.holder, rows.holders));
	return rows.instructions.filter((i) =>
		i.kind === "answer" && joAuthority(i) && i.question_id !== null && i.body.trim().split(/\s+/)[0]?.toLowerCase() === "revise"
		&& isPlanQuestionIn(control, { id: i.question_id })).length;
}

/** The newest classifier-stamped `pair-signal:` that parses. */
function jevSignal(rows: Rows): PairSignalEntry | null {
	for (let i = rows.entries.length - 1; i >= 0; i--) {
		const e = rows.entries[i]!;
		if (e.kind !== "assumption" || e.created_by !== CLASSIFIER_BY) continue;
		const s = parsePairSignal(e.body);
		if (s) return s;
	}
	return null;
}

/**
 * The signals firing over `rows`, in the canonical order. `a`: from `count` (the round-limit site), from every slice
 * (`"anywhere"`, the mechanical read), or not at all (`null`). `c`: only when `withC` and another signal fired.
 * `jev`: whether d1 and e are read.
 */
function signalsOf(rows: Rows, o: { a: RoundCount | "anywhere" | null; withC: boolean; jev: boolean }): Fired[] {
	const fired: Fired[] = [];
	const a = o.a === null ? false : o.a === "anywhere" ? stalledAnywhere(rows) : stalled(o.a);
	if (a) fired.push({ id: "a" });
	const steers = longSteers(rows);
	const d2 = planRevises(rows) >= PLAN_REVISES;
	if (steers + (d2 ? 1 : 0) >= LONG_STEERS) {
		fired.push({ id: "b" });
		if (d2) fired.push({ id: "d2" });
	}
	const signal = o.jev ? jevSignal(rows) : null;
	if (signal?.ambiguous.yes && signal.ambiguous.confidence >= PAIR_CONFIDENCE) fired.push({ id: "d1" });
	if (signal?.taste.yes && signal.taste.confidence >= PAIR_CONFIDENCE) fired.push({ id: "e" });
	const done = rows.slices.some((s) => !s.id.startsWith("sl-ceiling-") && s.state === "done");
	if (o.withC && fired.length > 0 && !done) fired.push({ id: "c" });
	return fired.sort((x, y) => PAIR_SIGNALS.indexOf(x.id) - PAIR_SIGNALS.indexOf(y.id));
}

/**
 * D8: the ungated mechanical read at `at` — A over every slice, B with D2's +1, C only with another; no jev, no
 * switch, no stakes or mode gate. Eligible when A or B fires. Reads only rows written at or before `at`.
 */
export function mechanicalEligibility(ledger: PairLedger, workloadId: string, at: string): { eligible: boolean; signals: PairSignalId[] } {
	const w = ledger.workload(workloadId);
	if (!w) return { eligible: false, signals: [] };
	return mechanicalAt(readRows(ledger, w), at);
}

function mechanicalAt(rows: Rows, at: string): { eligible: boolean; signals: PairSignalId[] } {
	const signals = signalsOf(upTo(rows, at), { a: "anywhere", withC: true, jev: false }).map((f) => f.id);
	return { eligible: signals.includes("a") || signals.includes("b"), signals };
}

// ---- the offer (D1, D5) ---------------------------------------------------------------------------------------------

/** D5: may the workload take another offer now, with `fired` firing? */
function capsAllow(ledger: PairLedger, rows: Rows, site: PairSite, fired: readonly Fired[], now: string): boolean {
	const offers = rows.entries.flatMap((e) => {
		if (e.kind !== "assumption" || (e.created_by !== CLASSIFIER_BY && e.created_by !== LANE_RUNNER_BY)) return [];
		const o = parsePairOffer(e.body);
		return o ? [{ ...o, at: e.created_at }] : [];
	});
	if (offers.length >= MAX_OFFERS) return false;
	const last = offers.at(-1);
	if (last && Date.parse(now) - Date.parse(last.at) < OFFER_GAP_MS) return false;
	for (let i = offers.length - 1; i >= 0; i--) {
		const o = offers[i]!;
		const q = ledger.question(o.questionId);
		if (!q || q.state !== "answered") continue;
		const answer = rows.instructions.find((x) => x.id === q.resolved_by);
		if (!answer || answer.body.trim().toLowerCase() === PAIR_OPTION) return true;
		const then = new Set<string>(signalsOf(upTo(rows, answer.created_at), { a: site === "round-limit" ? "anywhere" : null, withC: site === "ceiling", jev: true }).map((f) => f.id));
		return fired.some((f) => !o.signals.includes(f.id) && !then.has(f.id));
	}
	return true;
}

/**
 * D1: the `pair` offer for a question about to be raised at `site`, or null. Null unless the switch (`ctx.config`, the
 * parsed installed config) covers the workload, the stakes are not throwaway, the mode is autonomous, a signal fired
 * and D5's caps allow it. `ctx.count` is the round count the round-limit raise read (signal A). `signals` go in the
 * site's `pair-offer:` entry; the question's body is left as it is (PLAN wl-mvb9mw00ycfjeo D1).
 */
export function pairOffer(
	ledger: PairLedger,
	workloadId: string,
	site: PairSite,
	ctx: { config: unknown; count?: RoundCount },
): { signals: PairSignalId[] } | null {
	if (!pairSuggestOn(ctx.config, workloadId)) return null;
	const w = ledger.workload(workloadId);
	if (!w || w.stakes === "throwaway" || w.mode !== "autonomous") return null;
	const rows = readRows(ledger, w);
	const fired = signalsOf(rows, { a: site === "round-limit" ? (ctx.count ?? null) : null, withC: site === "ceiling", jev: true });
	if (fired.length === 0 || !capsAllow(ledger, rows, site, fired, ledger.now())) return null;
	return { signals: fired.map((f) => f.id) };
}

// ---- the text Jo reads (PLAN wl-mvb9mw00ycfjeo D2–D5) ---------------------------------------------------------------

/** D3: one phrase per signal id, short and fixed (no counts, so never wrong). */
export const PAIR_REASONS: Readonly<Record<PairSignalId, string>> = {
	a: "the review loop is not converging",
	b: "you sent several long steers",
	c: "no slice done yet",
	d1: "the brief reads as ambiguous",
	d2: "the plan was revised more than once",
	e: "it reads as UI or taste work",
};

/** The phrases of `signals` (a `pair-offer:` entry's ids, in its order) joined with `; `; an id this module does not know is skipped. */
export function pairReasons(signals: readonly string[]): string {
	return signals.flatMap((s) => ((PAIR_SIGNALS as readonly string[]).includes(s) ? [PAIR_REASONS[s as PairSignalId]] : [])).join("; ");
}

/** A question's options as Jo reads them: the stored `pair` left out (D2); the offer has its own line. */
export function shownOptions(options: readonly string[]): string[] {
	return options.filter((o) => o.toLowerCase() !== PAIR_OPTION);
}

/** D3: the needs-you and ledger-render offer line, `pair offer on <words> (q-…): <reasons>. Answer pair q-… to stop …`. */
export function pairOfferLine(words: string, questionId: string, workloadId: string, signals: readonly string[]): string {
	return `pair offer on ${words} (${questionId}): ${pairReasons(signals)}. Answer pair ${questionId} to stop the lane and drive it yourself (${byHandLine(workloadId)}).`;
}

/** D4: the pending block's offer line, indented under its question's answer line or overflow sentence, with D3's tail. */
export function pairPendingLine(questionId: string, workloadId: string, signals: readonly string[]): string {
	return `  ↳ pair offer: ${pairReasons(signals)}. Answer pair ${questionId} instead to stop the lane and drive it yourself (${byHandLine(workloadId)}).`;
}

/** D5: the taken line, its by-hand command on a line of its own. */
export function pairTakenLine(words: string, questionId: string, workloadId: string): string {
	return `you took pair on ${words} (${questionId}); its lane has ended. Continue it in another terminal:\n${byHandLine(workloadId)}`;
}

/** The question id a `pair-taken: <q> by <answer> mode user-driven` control entry's rest names, or null when malformed. */
export function pairTakenQuestion(rest: string): string | null {
	return /^(\S+) by \S+ mode user-driven$/.exec(rest)?.[1] ?? null;
}

// ---- the health number (D8) -----------------------------------------------------------------------------------------

/** Every review round in `entries` in the order it completed: its slice, the time of the entry that completed it, and whether it passed. */
export function completedRounds(entries: readonly EntryRow[]): { slice: string; at: string; passed: boolean }[] {
	const out: { slice: string; at: string; passed: boolean }[] = [];
	const settled = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		const r = e.kind === "assumption" ? parseReviewRound(e.body) : null;
		if (!r) continue;
		const key = `${r.slice} ${r.group}`;
		if (settled.has(key)) continue;
		const round = countRounds(entries.slice(0, i + 1), r.slice).rounds.find((x) => x.group === r.group);
		if (!round?.complete) continue;
		settled.add(key);
		out.push({ slice: r.slice, at: e.created_at, passed: round.passed });
	}
	return out;
}

/** One lane's D8 read: its window, its first mechanical eligibility moment (null when never eligible) and its score. */
export interface PairLane {
	workloadId: string;
	start: string;
	end: string;
	moment: string | null;
	score: number;
}

/**
 * D8 for one lane: on the lane's workload (`lane-<wl>-<n>`), between its `lane-started:` and its `lane-exit:` (or now),
 * the first moment the mechanical read is eligible, and the score `post-signal-failed-rounds`: the failed review rounds
 * completed after that moment plus Jo's `extend` answers on the runner's ceiling questions after it (0 when never
 * eligible). Null when the workload is unknown or the lane never started. The same whether the switch was on or off.
 */
export function pairSuggestLane(ledger: PairLedger, laneId: string): PairLane | null {
	const m = /^lane-(.+)-\d+$/.exec(laneId);
	const w = m ? ledger.workload(`wl-${m[1]}`) : null;
	if (!w) return null;
	const rows = readRows(ledger, w);
	const control = controlEntries(rows.entries);
	const start = control.find((c) => c.prefix === "lane-started" && c.laneId === laneId)?.createdAt;
	if (start === undefined) return null;
	const end = control.find((c) => c.prefix === "lane-exit" && c.laneId === laneId && c.createdAt >= start)?.createdAt ?? ledger.now();
	const times = [...new Set([start, ...[...rows.entries, ...rows.instructions].map((r) => r.created_at).filter((t) => t > start && t <= end)])].sort();
	const moment = times.find((t) => mechanicalAt(rows, t).eligible);
	if (moment === undefined) return { workloadId: w.id, start, end, moment: null, score: 0 };
	const failed = completedRounds(rows.entries).filter((r) => r.at > moment && r.at <= end && !r.passed).length;
	const ceilingQuestions = new Set(
		ledger.questions(w.id).filter((q) => q.created_by === LANE_RUNNER_BY && q.slice_id.startsWith("sl-ceiling-")).map((q) => q.id),
	);
	const extendAnswers = rows.instructions.filter((x) =>
		x.kind === "answer" && x.question_id !== null && ceilingQuestions.has(x.question_id) && x.body.trim().split(/\s+/)[0]?.toLowerCase() === "extend"
		&& x.created_at > moment && x.created_at <= end).length;
	return { workloadId: w.id, start, end, moment, score: failed + extendAnswers };
}

/** D8's registry number for one lane (`pairSuggestLane`'s score; 0 when the lane never started). */
export function pairSuggestHealth(ledger: PairLedger, laneId: string): number {
	return pairSuggestLane(ledger, laneId)?.score ?? 0;
}

/** D8's group for a lane in the report: whether the switch covered the workload while the lane ran, as far as the ledger says. */
export type PairExposure = "on" | "off";

/**
 * D8's group for one lane, from its workload's entries. The ledger keeps no history of the config; its record that the
 * switch covered a lane is the lane's own classifier-stamped `pair-exposure: <laneId> on` (written once per lane session
 * while the switch covers the workload), or a row only a switched-on workload gets within the lane's span [start, end]: a
 * classifier-stamped `pair-signal:` or `pair-signal-failed:` (the jev attempt), or a `pair-offer:` stamped by its raise
 * site's writer (classifier or lane runner). `on` with either; `off` otherwise, a lane from before the switch existed
 * included.
 */
export function pairLaneExposure(entries: readonly EntryRow[], laneId: string, lane: Pick<PairLane, "start" | "end">): PairExposure {
	const exposed = pairExposureBody(laneId);
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		if (e.created_by === CLASSIFIER_BY && e.body.trim() === exposed) return "on";
		if (e.created_at < lane.start || e.created_at > lane.end) continue;
		const switchRow = e.created_by === CLASSIFIER_BY
			? parsePairSignal(e.body) !== null || parsePairSignalFailed(e.body) !== null || parsePairOffer(e.body) !== null
			: e.created_by === LANE_RUNNER_BY && parsePairOffer(e.body) !== null;
		if (switchRow) return "on";
	}
	return "off";
}
