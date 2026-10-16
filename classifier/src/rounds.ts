/**
 * The review round limit's pure half (PLAN wl-mupu0sx2o046io D9; SPEC-2.0.md § B4, *Amended
 * 2026-10-01 — review round limit*): the stakes defaults, the `review-findings` block parser, the
 * `review-round:` / `review-rounds:` / `review-rounds-extend:` / `review-limit:` /
 * `review-loop-end:` entry bodies, round counting, the effective limit, the estimate and the
 * question Jo answers at the limit. Shaped on the spend ceiling (surface/src/ceiling.ts). No OMP
 * import, no I/O: callers read the rows and hand them in; the classifier and the surface both
 * import it, so they cannot disagree on a count.
 */
import type { EntryRow, InstructionRow } from "../../ledger/src/index";
import { JO_HOLDER } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import type { Stakes } from "./route";

// ---- defaults ----------------------------------------------------------------------------------

/** D9: failed rounds a review loop may take before Jo decides; throwaway takes normal's. */
export const REVIEW_ROUND_DEFAULTS: Readonly<Record<Stakes, number>> = {
	throwaway: 3,
	normal: 3,
	production: 5,
};

// ---- the findings block ------------------------------------------------------------------------

export const SEVERITIES = ["blocking", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const FINDING_KINDS = ["correctness", "security", "tests", "design", "docs", "other"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
	severity: Severity;
	kind: FindingKind;
	title: string;
}

/** One hand's findings: counts by severity × kind (zero cells omitted), and the titles, capped. */
export interface Findings {
	counts: Record<Severity, Partial<Record<FindingKind, number>>>;
	titles: Finding[];
}

/** A hand whose block was missing or malformed, or that never ran. */
export const UNKNOWN = "unknown";
export type FindingsOrUnknown = Findings | typeof UNKNOWN;

/** Titles kept per hand, and per round in the question (D9: capped at 40 per round). */
export const TITLE_CAP = 40;
/** One title's length cap, so a runaway title cannot bloat an entry body. */
const TITLE_CHARS = 200;

/** One `review-findings` block from its opening line to its closing fence, matched at a given offset. */
const FENCE = /^[ \t]*```[ \t]*review-findings[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/my;
/** A `review-findings` opening line, closed or not. */
const OPENING = /^[ \t]*```[ \t]*review-findings[ \t]*\r?$/gm;

/**
 * The reply's LAST fenced `review-findings` block, parsed: counts by severity × kind and the titles
 * (the first `TITLE_CAP`). `unknown` when there is no block, the last opening line has no closing
 * fence, its JSON does not parse, or any finding has a severity or kind outside the lists or no
 * title — an earlier valid block never stands in for a malformed or unterminated last one.
 */
export function parseFindings(text: string): FindingsOrUnknown {
	let start = -1;
	for (const m of text.matchAll(OPENING)) start = m.index;
	if (start < 0) return UNKNOWN;
	FENCE.lastIndex = start;
	const last = FENCE.exec(text)?.[1];
	if (last === undefined) return UNKNOWN;
	let json: unknown;
	try {
		json = JSON.parse(last);
	} catch {
		return UNKNOWN;
	}
	if (!isObject(json) || !Array.isArray(json.findings)) return UNKNOWN;
	const out = emptyFindings();
	for (const f of json.findings) {
		const finding = asFinding(f);
		if (finding === null) return UNKNOWN;
		addFinding(out, finding);
	}
	return out;
}

/** The blocking findings a hand reported. */
export function blockingOf(f: Findings): number {
	return sum(f.counts.blocking);
}

function emptyFindings(): Findings {
	return { counts: { blocking: {}, major: {}, minor: {} }, titles: [] };
}

function addFinding(into: Findings, f: Finding): void {
	const row = into.counts[f.severity];
	row[f.kind] = (row[f.kind] ?? 0) + 1;
	if (into.titles.length < TITLE_CAP) into.titles.push(f);
}

function asFinding(x: unknown): Finding | null {
	if (!isObject(x)) return null;
	const { severity, kind, title } = x;
	if (typeof severity !== "string" || !(SEVERITIES as readonly string[]).includes(severity)) return null;
	if (typeof kind !== "string" || !(FINDING_KINDS as readonly string[]).includes(kind)) return null;
	if (typeof title !== "string") return null;
	const t = title.replace(/\s+/g, " ").trim();
	if (t === "") return null;
	return { severity: severity as Severity, kind: kind as FindingKind, title: t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1)}…` : t };
}

/** A stored `counts` JSON, validated back into `Findings`; null when it is not one. */
function asFindings(x: unknown): Findings | null {
	if (!isObject(x) || !isObject(x.counts) || !Array.isArray(x.titles) || x.titles.length > TITLE_CAP) return null;
	const out = emptyFindings();
	for (const s of SEVERITIES) {
		const row = x.counts[s];
		if (!isObject(row)) return null;
		for (const [k, n] of Object.entries(row)) {
			if (!(FINDING_KINDS as readonly string[]).includes(k) || !Number.isInteger(n) || (n as number) < 1) return null;
			out.counts[s][k as FindingKind] = n as number;
		}
	}
	for (const t of x.titles) {
		const f = asFinding(t);
		if (f === null) return null;
		out.titles.push(f);
	}
	return out;
}

// ---- entry bodies ------------------------------------------------------------------------------

/**
 * What happened to one review hand of a round: ran and accepted, ran and withheld (D2–D6), refused at
 * spawn, dropped unspawned, stopped: refused at spawn because Jo stopped the loop or its limit
 * question was open (D10: terminal, and the round counts only the members that spawned), or a failed
 * dispatch: it spawned and no model answered on it, every turn ended on a provider error (PLAN
 * wl-muq13bkdghblmo step 8). Like `stopped` it is terminal and not counted, so a round of only
 * failed dispatches is no round and the next dispatch takes its number.
 */
export const REVIEW_VERDICTS = ["accepted", "withheld", "refused", "dropped", "stopped", "failed-dispatch"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface ReviewRoundEntry {
	slice: string;
	round: number;
	token: string;
	/** The dispatch group (`hand-spawn: … group <dg-id>`): a production fan-out's members share one. */
	group: string;
	verdict: ReviewVerdict;
	findings: FindingsOrUnknown;
}

/** `review-round: <sl> round <n> token <dt> group <dg> verdict <v> blocking <b|unknown> counts <json|unknown>`, one per review hand at settle. */
export function reviewRoundBody(r: ReviewRoundEntry): string {
	const blocking = r.findings === UNKNOWN ? UNKNOWN : String(blockingOf(r.findings));
	const counts = r.findings === UNKNOWN ? UNKNOWN : JSON.stringify(r.findings);
	return `review-round: ${r.slice} round ${r.round} token ${r.token} group ${r.group} verdict ${r.verdict} blocking ${blocking} counts ${counts}`;
}

/**
 * `review-group: <sl> group <fg> members <dt>,<dt>…`: a production fan-out's whole membership (D5),
 * written when the call is published, before any member spawns, so a round's completion can wait for
 * every member across a restart.
 */
export function reviewGroupBody(slice: string, group: string, tokens: readonly string[]): string {
	return `review-group: ${slice} group ${group} members ${tokens.join(",")}`;
}

const REVIEW_GROUP = /^review-group:\s+(\S+)\s+group\s+(\S+)\s+members\s+(\S+)$/;

export function parseReviewGroup(body: string): { slice: string; group: string; tokens: string[] } | null {
	const m = REVIEW_GROUP.exec(body.trim());
	return m ? { slice: m[1]!, group: m[2]!, tokens: m[3]!.split(",").filter(Boolean) } : null;
}

const REVIEW_ROUND = /^review-round:\s+(\S+)\s+round\s+(\d+)\s+token\s+(\S+)\s+group\s+(\S+)\s+verdict\s+(\S+)\s+blocking\s+(\d+|unknown)\s+counts\s+(.+)$/s;

/** A `review-round:` body parsed; null when malformed, including a `blocking` that disagrees with its counts. */
export function parseReviewRound(body: string): ReviewRoundEntry | null {
	const m = REVIEW_ROUND.exec(body.trim());
	if (!m) return null;
	const verdict = m[5]!;
	if (!(REVIEW_VERDICTS as readonly string[]).includes(verdict)) return null;
	let findings: FindingsOrUnknown;
	if (m[7] === UNKNOWN) {
		if (m[6] !== UNKNOWN) return null;
		findings = UNKNOWN;
	} else {
		let json: unknown;
		try {
			json = JSON.parse(m[7]!);
		} catch {
			return null;
		}
		const f = asFindings(json);
		if (f === null || m[6] !== String(blockingOf(f))) return null;
		findings = f;
	}
	return { slice: m[1]!, round: Number(m[2]), token: m[3]!, group: m[4]!, verdict: verdict as ReviewVerdict, findings };
}

export interface ReviewRoundsEntry {
	rounds: number;
	source: string;
	by: string;
}

/** `review-rounds: <n> source <text> by <in-id>`: the workload's limit, set by the Jo instruction it names. */
export function reviewRoundsBody(rounds: number, source: string, by: string): string {
	return `review-rounds: ${rounds} source ${source.replace(/\s+/g, " ").trim()} by ${by}`;
}

const REVIEW_ROUNDS = /^review-rounds:\s+(\d+)\s+source\s+(.+?)\s+by\s+(in-\S+)$/;

export function parseReviewRounds(body: string): ReviewRoundsEntry | null {
	const m = REVIEW_ROUNDS.exec(body.trim());
	if (!m) return null;
	const rounds = Number(m[1]);
	return rounds >= 1 ? { rounds, source: m[2]!, by: m[3]! } : null;
}

export interface ReviewRoundsExtendEntry {
	slice: string;
	rounds: number;
	by: string;
}

/** `review-rounds-extend: <sl> +<n> by <answer id>`: one more block of rounds for one slice. */
export function reviewRoundsExtendBody(slice: string, rounds: number, by: string): string {
	return `review-rounds-extend: ${slice} +${rounds} by ${by}`;
}

const REVIEW_ROUNDS_EXTEND = /^review-rounds-extend:\s+(\S+)\s+\+(\d+)\s+by\s+(in-\S+)$/;

export function parseReviewRoundsExtend(body: string): ReviewRoundsExtendEntry | null {
	const m = REVIEW_ROUNDS_EXTEND.exec(body.trim());
	if (!m) return null;
	const rounds = Number(m[2]);
	return rounds >= 1 ? { slice: m[1]!, rounds, by: m[3]! } : null;
}

/** `review-limit: <q-id> slice <sl>`: marks the round-limit question as the classifier's. */
export function reviewLimitBody(questionId: string, slice: string): string {
	return `review-limit: ${questionId} slice ${slice}`;
}

const REVIEW_LIMIT = /^review-limit:\s+(q-\S+)\s+slice\s+(\S+)$/;

export function parseReviewLimit(body: string): { questionId: string; slice: string } | null {
	const m = REVIEW_LIMIT.exec(body.trim());
	return m ? { questionId: m[1]!, slice: m[2]! } : null;
}

export const LOOP_END_REASONS = ["pass", "accept", "stop", "stop-reviews"] as const;
export type LoopEndReason = (typeof LOOP_END_REASONS)[number];

/** `review-loop-end: <sl> reason <pass|accept|stop|stop-reviews>`: the slice's next review starts a fresh loop. */
export function reviewLoopEndBody(slice: string, reason: LoopEndReason): string {
	return `review-loop-end: ${slice} reason ${reason}`;
}

const REVIEW_LOOP_END = /^review-loop-end:\s+(\S+)\s+reason\s+(\S+)$/;

export function parseReviewLoopEnd(body: string): { slice: string; reason: LoopEndReason } | null {
	const m = REVIEW_LOOP_END.exec(body.trim());
	if (!m || !(LOOP_END_REASONS as readonly string[]).includes(m[2]!)) return null;
	return { slice: m[1]!, reason: m[2] as LoopEndReason };
}

/**
 * `slice`'s current review loop, as `countRounds` numbers it: the count of its `review-loop-end:`
 * entries (any reason). A dispatch published in an earlier loop no longer belongs to the current one.
 */
export function reviewLoop(entries: readonly EntryInput[], slice: string): number {
	let loop = 0;
	for (const e of entries) if (e.kind === "assumption" && parseReviewLoopEnd(e.body.trim())?.slice === slice) loop++;
	return loop;
}

/** The Jo instruction the surface's `rounds <n>` word writes. */
export function roundsInstructionBody(rounds: number): string {
	return `rounds: ${rounds}`;
}

const ROUNDS_INSTRUCTION = /^rounds:\s+(\d+)$/;

// The two entries rounds.ts reads but does not write (sl-lab-route, PLAN D3 / D2).
const HAND_SPAWN = /^hand-spawn:\s+(\S+)\s+session\s+(.+?)\s+spawn\s+(\S+)\s+review\s+(yes|no)\s+group\s+(\S+)\s+row\s+(.*)$/s;
const REVIEW_WITHHELD = /^review-withheld:\s+(\S+)$/;

// ---- counting ----------------------------------------------------------------------------------

export type EntryInput = Pick<EntryRow, "kind" | "slice_id" | "body" | "created_at">;
export type InstructionInput = Pick<InstructionRow, "id" | "kind" | "question_id" | "author" | "body" | "created_by" | "created_at">;

export interface RoundMember {
	token: string;
	/** Null while the hand is listed or spawned and not terminal (no `review-round:` entry yet). */
	verdict: ReviewVerdict | null;
	findings: FindingsOrUnknown;
	/** Settled with its output accepted: verdict `accepted` and no `review-withheld:` for its token. */
	accepted: boolean;
	/** A `hand-spawn:` names it, or it settled having run (`accepted` / `withheld`). */
	spawned: boolean;
}

export interface Round {
	/** 1-based position in its loop. */
	n: number;
	group: string;
	/** The members that count: every listed or spawned hand but those `stopped` at spawn. */
	members: RoundMember[];
	/** Every member, `stopped` ones included, is terminal (a `review-round:` entry). */
	complete: boolean;
	/** Complete, every member accepted with a known block, and none reports a blocking finding. */
	passed: boolean;
	/**
	 * Complete, not passed, and no member reports a known blocking finding or was not accepted with a
	 * known block: the round failed only for want of a readable block (PLAN wl-mv5i3lulwwbbi8 D9).
	 */
	unread: boolean;
	/** The blocking findings of the members whose block is known, summed; null when no member's is. */
	blocking: number | null;
	/** The members whose block is unknown, beside `blocking`. */
	unknown: number;
}

export interface RoundCount {
	/** This loop's rounds, oldest first. */
	rounds: Round[];
	/** Complete rounds counted against the limit: `failedKnown + max(0, unread − 1)`, the loop's first unread round free. */
	failed: number;
	/** Complete rounds that failed on a known block: a blocking finding, or a member not accepted. */
	failedKnown: number;
	/** Complete rounds that are `unread`. */
	unread: number;
	/** The newest complete round passed. */
	passed: boolean;
	/** The position the next round of this loop takes. */
	next: number;
}

/**
 * The review rounds of `slice`'s current loop. A round is one dispatch group (a production fan-out
 * is one): its members are the tokens a `review-group:` entry lists (a fan-out's whole membership,
 * durable before any member spawns), the `hand-spawn: … review yes group <dg>` tokens on the slice,
 * and the tokens of the `review-round:` entries naming the group. It is complete only when every one
 * of them has its `review-round:`, so a listed member that never spawned holds it open until it is
 * known dropped. A group with no member that spawned (only `refused`, `dropped` or `stopped`
 * verdicts, no `hand-spawn:`), or whose spawned members are all `failed-dispatch`, is not a round.
 * A `stopped` or `failed-dispatch` member is terminal and does not count toward the round's result
 * (D10; PLAN wl-muq13bkdghblmo step 8). A group belongs to the loop open when its first entry was
 * written; each `review-loop-end:` of the slice opens the next loop, so a round still running when
 * its loop ended does not count toward the new one. A complete round fails when a counted member
 * reports a known blocking finding or is not accepted (withheld, refused, dropped, or named by
 * `review-withheld:`) with a known block; it passes when every counted member is accepted with a
 * known block and no blocking finding; otherwise it is unread (PLAN wl-mv5i3lulwwbbi8 D9: a member's
 * block is unknown and nothing known failed it). The loop's first unread round is free, every
 * further one counts as failed. A `pg-` group (a three-lab panel, classifier/src/panel.ts) is no
 * round: panels are bounded by their own count. `entries` are the workload's, oldest first.
 */
export function countRounds(entries: readonly EntryInput[], slice: string): RoundCount {
	interface Group { loop: number; tokens: Map<string, ReviewRoundEntry | null>; ran: Set<string> }
	const groups = new Map<string, Group>();
	const withheld = new Set<string>();
	let loop = 0;
	const groupOf = (id: string): Group => {
		let g = groups.get(id);
		if (!g) groups.set(id, (g = { loop, tokens: new Map(), ran: new Set() }));
		return g;
	};
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const body = e.body.trim();
		const w = REVIEW_WITHHELD.exec(body);
		if (w) {
			withheld.add(w[1]!);
			continue;
		}
		const end = parseReviewLoopEnd(body);
		if (end) {
			if (end.slice === slice) loop++;
			continue;
		}
		const listed = parseReviewGroup(body);
		if (listed) {
			if (listed.slice !== slice) continue;
			const g = groupOf(listed.group);
			for (const token of listed.tokens) if (!g.tokens.has(token)) g.tokens.set(token, null);
			continue;
		}
		const s = HAND_SPAWN.exec(body);
		if (s) {
			if (e.slice_id !== slice || s[4] !== "yes" || s[5]!.startsWith("pg-")) continue;
			const g = groupOf(s[5]!);
			g.ran.add(s[1]!);
			if (!g.tokens.has(s[1]!)) g.tokens.set(s[1]!, null);
			continue;
		}
		const r = parseReviewRound(body);
		if (r && r.slice === slice) {
			const g = groupOf(r.group);
			if (r.verdict === "accepted" || r.verdict === "withheld") g.ran.add(r.token);
			if (!g.tokens.get(r.token)) g.tokens.set(r.token, r);
		}
	}
	const rounds: Round[] = [];
	for (const [id, g] of groups) {
		if (g.loop !== loop || [...g.ran].every((token) => g.tokens.get(token)?.verdict === "failed-dispatch")) continue;
		const complete = [...g.tokens.values()].every((r) => r !== null);
		const members: RoundMember[] = [...g.tokens].flatMap(([token, r]) =>
			r?.verdict === "stopped" || r?.verdict === "failed-dispatch"
				? []
				: [{ token, verdict: r?.verdict ?? null, findings: r?.findings ?? UNKNOWN, accepted: r?.verdict === "accepted" && !withheld.has(token), spawned: g.ran.has(token) }],
		);
		const known = members.flatMap((m) => (m.findings === UNKNOWN ? [] : [m.findings]));
		const blocking = known.length > 0 ? known.reduce((n, f) => n + blockingOf(f), 0) : null;
		const passed = complete && members.every((m) => m.accepted && m.findings !== UNKNOWN && blockingOf(m.findings) === 0);
		const unread = complete && !passed && !members.some((m) => m.findings !== UNKNOWN && (!m.accepted || blockingOf(m.findings) > 0));
		rounds.push({ n: rounds.length + 1, group: id, members, complete, passed, unread, blocking, unknown: members.length - known.length });
	}
	const done = rounds.filter((r) => r.complete);
	const failedKnown = done.filter((r) => !r.passed && !r.unread).length;
	const unread = done.filter((r) => r.unread).length;
	return {
		rounds,
		failed: failedKnown + Math.max(0, unread - 1),
		failedKnown,
		unread,
		passed: done.length > 0 && done[done.length - 1]!.passed,
		next: rounds.length + 1,
	};
}

/** A round's blocking count as the question and the stop message word it: `2`, `2 (+1 unknown)`, or `unknown`. */
export function roundBlockingText(r: Pick<Round, "blocking" | "unknown">): string {
	if (r.blocking === null) return UNKNOWN;
	return r.unknown > 0 ? `${r.blocking} (+${r.unknown} unknown)` : String(r.blocking);
}

// ---- the limit ---------------------------------------------------------------------------------

export interface RoundLimit {
	/** The workload's limit: the newest valid `review-rounds:` entry, else the stakes default. */
	workload: number;
	/** Rounds added to this slice's current loop by `review-rounds-extend:` entries. */
	extend: number;
	/** What the slice's loop may take: `workload + extend`. */
	total: number;
}

/**
 * The effective round limit for `slice` (D9), shaped like `effectiveCeiling`. A `review-rounds:`
 * entry applies only when its `by` names a Jo instruction the surface wrote (author `jo`, written
 * by the surface) in a raise shape: `rounds: <n>` with the same n, a `stakes: <s>` flip, or an
 * `extend` answer to a `review-limit:` question; any other entry is ignored. A Jo stakes flip newer
 * than the newest valid entry re-sizes the limit to the current stakes' default, as the stakes word
 * re-sizes the ceiling. Each valid `review-rounds-extend:` of the slice since its latest
 * `review-loop-end:` adds its block once per answer; a valid extend is an `extend` answer to a
 * `review-limit:` question on that slice.
 */
export function effectiveRoundLimit(entries: readonly EntryInput[], instructions: readonly InstructionInput[], stakes: Stakes, slice: string): RoundLimit {
	const limitQuestions = new Map<string, string>();
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const l = parseReviewLimit(e.body);
		if (l) limitQuestions.set(l.questionId, l.slice);
	}
	const fromJo = (id: string): InstructionInput | null =>
		instructions.find((i) => i.id === id && i.author === JO_HOLDER && i.created_by === SURFACE_BY) ?? null;
	const isExtendAnswer = (i: InstructionInput, onSlice?: string): boolean =>
		i.kind === "answer" && i.body.trim() === "extend" && i.question_id !== null && limitQuestions.has(i.question_id)
		&& (onSlice === undefined || limitQuestions.get(i.question_id) === onSlice);

	let cur: { rounds: number; at: string } | null = null;
	let extends_ = new Map<string, number>();
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const r = parseReviewRounds(e.body);
		if (r) {
			const i = fromJo(r.by);
			if (i === null) continue;
			const n = ROUNDS_INSTRUCTION.exec(i.body.trim());
			const ok = n ? Number(n[1]) === r.rounds : i.body.startsWith("stakes: ") || isExtendAnswer(i);
			if (ok) cur = { rounds: r.rounds, at: e.created_at };
			continue;
		}
		const x = parseReviewRoundsExtend(e.body);
		if (x) {
			if (x.slice !== slice) continue;
			const i = fromJo(x.by);
			if (i !== null && isExtendAnswer(i, slice) && !extends_.has(x.by)) extends_.set(x.by, x.rounds);
			continue;
		}
		const end = parseReviewLoopEnd(e.body);
		if (end && end.slice === slice) extends_ = new Map();
	}
	const flip = instructions
		.filter((i) => i.author === JO_HOLDER && i.created_by === SURFACE_BY && i.body.startsWith("stakes: "))
		.reduce<string | null>((at, i) => (at === null || i.created_at > at ? i.created_at : at), null);
	const workload = cur !== null && (flip === null || cur.at >= flip) ? cur.rounds : REVIEW_ROUND_DEFAULTS[stakes];
	const extend = [...extends_.values()].reduce((a, b) => a + b, 0);
	return { workload, extend, total: workload + extend };
}

// ---- the estimate ------------------------------------------------------------------------------

export type RoundsEstimate =
	| { kind: "estimate"; rounds: number; meanFall: number; last: number }
	| { kind: "none"; reason: string };

/**
 * Rounds still needed, from the blocking count per round (null = unknown, skipped): `ceil(last /
 * mean fall)`, where the mean fall is `(first − last) / (known − 1)` over the known rounds; at least
 * one, since a round that failed with no blocking finding still needs a clean one. No estimate with
 * fewer than two known rounds, or when the count is flat or rising.
 */
export function roundsEstimate(blocking: readonly (number | null)[]): RoundsEstimate {
	const known = blocking.filter((b): b is number => b !== null);
	if (known.length < 2) return { kind: "none", reason: "no estimate: fewer than two rounds with a known blocking count" };
	const first = known[0]!;
	const last = known[known.length - 1]!;
	const meanFall = (first - last) / (known.length - 1);
	if (meanFall <= 0) return { kind: "none", reason: "no estimate: the blocking count is not falling" };
	return { kind: "estimate", rounds: Math.max(1, Math.ceil(last / meanFall)), meanFall, last };
}

// ---- the question ------------------------------------------------------------------------------

/** The round-limit question's answers (D9). */
export const ROUND_LIMIT_OPTIONS = ["extend", "accept", "stop"] as const;
export type RoundLimitOption = (typeof ROUND_LIMIT_OPTIONS)[number];

/** `blocking 2 (correctness 1, tests 1) · major 3 · minor 0`. */
export function severityLine(f: Findings): string {
	return SEVERITIES.map((s) => {
		const row = f.counts[s];
		const total = sum(row);
		const kinds = FINDING_KINDS.filter((k) => row[k]).map((k) => `${k} ${row[k]}`);
		return total === 0 ? `${s} 0` : `${s} ${total} (${kinds.join(", ")})`;
	}).join(" · ");
}

/**
 * The body of the question raised when the round that reaches the limit settles (D9): the failed
 * rounds counted, split into those that failed with findings and the unread ones (the first free,
 * PLAN wl-mv5i3lulwwbbi8 D9) when any is unread; the final round's remaining findings by severity ×
 * kind with their titles (the members' blocks merged, titles capped at `TITLE_CAP`), the hands that
 * were unknown or not accepted, the blocking count per round (`roundBlockingText`), the estimate
 * labelled as one, and what extend / accept / stop do.
 */
export function roundLimitQuestionBody(slice: string, count: RoundCount, limit: RoundLimit, stakes: Stakes): string {
	const done = count.rounds.filter((r) => r.complete);
	const final = done[done.length - 1];
	const split = count.unread > 0 ? `: ${count.failedKnown} failed with findings, ${count.unread} unread (1 free)` : "";
	const lines = [`The review of ${slice} reached its round limit: ${count.failed} failed round${count.failed === 1 ? "" : "s"} of ${limit.total} allowed (${stakes} stakes)${split}.`];
	if (final) {
		const merged = emptyFindings();
		let titles = 0;
		for (const m of final.members) {
			if (m.findings === UNKNOWN) continue;
			for (const s of SEVERITIES) for (const [k, n] of Object.entries(m.findings.counts[s])) {
				merged.counts[s][k as FindingKind] = (merged.counts[s][k as FindingKind] ?? 0) + n!;
			}
			for (const t of m.findings.titles) if (titles++ < TITLE_CAP) merged.titles.push(t);
		}
		const unknown = final.members.filter((m) => m.findings === UNKNOWN).map((m) => m.token);
		const rejected = final.members.filter((m) => !m.accepted).map((m) => `${m.token} (${m.verdict === "accepted" ? "withheld" : m.verdict})`);
		const known = final.members.length - unknown.length;
		let head = `Final round (round ${final.n}), remaining findings: `;
		head += known === 0 ? UNKNOWN : severityLine(merged);
		if (unknown.length > 0) head += ` · unknown: ${unknown.length} hand${unknown.length === 1 ? "" : "s"} with no readable findings block (${unknown.join(", ")})`;
		lines.push(head);
		if (rejected.length > 0) lines.push(`Output not accepted: ${rejected.join(", ")}.`);
		for (const s of SEVERITIES) for (const t of merged.titles) if (t.severity === s) lines.push(`- ${t.severity} ${t.kind}: ${t.title}`);
	}
	lines.push(`Blocking per round: ${done.map((r) => `round ${r.n}: ${roundBlockingText(r)}`).join(" · ")}`);
	lines.push(`Estimate (not a measurement): ${estimateText(roundsEstimate(done.map((r) => r.blocking)))}`);
	lines.push(
		`extend: one more block of ${REVIEW_ROUND_DEFAULTS[stakes]} rounds for ${slice}; the lane may dispatch the next review.`,
		`accept: the review counts as passed with these findings left; the lane may close ${slice} and go on, and the final round's finding titles ride the slice artifact and the PR (a plan slice may then be raised to Jo).`,
		`stop: no further round; the review does not count as passed; the lane reports and holds ${slice} for Jo.`,
	);
	return lines.join("\n");
}

/** The estimate as the question words it. */
export function estimateText(e: RoundsEstimate): string {
	if (e.kind === "none") return e.reason;
	const fall = Math.round(e.meanFall * 100) / 100;
	return `about ${e.rounds} more round${e.rounds === 1 ? "" : "s"}, ceil(last ${e.last} / mean fall ${fall} per round)`;
}

// ---- helpers -----------------------------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

function sum(row: Partial<Record<FindingKind, number>>): number {
	let n = 0;
	for (const k of FINDING_KINDS) n += row[k] ?? 0;
	return n;
}
