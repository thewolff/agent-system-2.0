/**
 * Headroom signal: base quota refusals plus the approved week-only budget comparison (policies A/B).
 * Reads the quota watcher's poll file once and uses labOf only for identity, never ledger access.
 * Admission never changes a dispatch's kind, tier, effort, model pin or permitted spawn row.
 *
 * - One clock unit, milliseconds: a poll's `t` is epoch seconds (watch.py) and is converted on read; `resetsAt`
 *   (`omp usage --json`) and `now` are epoch ms.
 * - A limit is `(provider, windowId, tier|null)`, read from the newest poll: use `u` and `resetsAt`.
 * - Projection is the window's own pace (Jo, in-mv8spn0cssasjk, answering q-mv8sl9vnex4zr4 "pace"): the window's
 *   length comes from `windowId` (`5h`, `7d`, …), elapsed = length − (resetsAt − now), and the projected use at reset
 *   is `u / elapsed · length`. Projection starts at max(60min, length/5); unknown length/reset cannot project.
 * - A week-pace-only refusal may be retained against the first configured other-lab budget only when its
 *   measured pressure is strictly higher over the same recent 15–60min endpoints. Pressure is the maximum
 *   binding-meter rate, in quota points/hour, not token-equivalent capacity. Hard/exhausted limits never relax.
 * - A limit binds a selector when the provider matches and its tier is null or the model id contains the tier
 *   (`fable` binds `anthropic/claude-fable-*` only; Fable's meter never takes Opus out).
 * - Out: a binding limit with a pace projection ≥ 1.0, a binding 5h limit with `u > FIVE_HOUR_CEILING`, or an
 *   exhausted known week with a future reset even before warm-up. A passed reset binds nothing.
 * - Old poll lines (no `limits`) read their `rows` keys as limits with no reset time, so only the 5h rule applies.
 *   A third key segment is a tier unless it is a meter name in `METERS` (`openai-codex/7d/chat` is the shared meter).
 *   An unknown third segment read as a tier binds only models whose id contains it, so a misread fails open.
 * - Stale (newest poll older than `STALE_MIN`), missing, unreadable or empty polls: nothing is out, and `note` says why.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { labOf } from "./lab";

export const STALE_MIN = 15;
/** Fixed floor and window fraction of elapsed time required for pace projection. */
export const PACE_FLOOR_MIN = 60;
export const PACE_WINDOW_FRACTION = 0.2;
export const FIVE_HOUR_CEILING = 0.8;
/** `windowId` unit → ms. */
const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
/** Third `rows` key segments that name a meter, not a model tier (old poll lines only). */
const METERS: Readonly<Record<string, true>> = { chat: true };
const MIN_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * MIN_MS;

/** Length in ms of a window named like `5h` or `7d`; null when the id is not of that shape. */
function windowMs(windowId: string): number | null {
	const m = /^(\d+)([mhdw])$/.exec(windowId);
	return m ? Number(m[1]) * UNIT_MS[m[2]!]! : null;
}

export const DEFAULT_POLLS = join(homedir(), "agent-scratch", "agent-system-2.0", "quota-watch", "polls.jsonl");

interface Limit {
	provider: string;
	windowId: string;
	tier: string | null;
	used: number;
	resetsAt: number | null;
}

interface Poll {
	t: number; // ms
	limits: Limit[];
}

export interface HeadroomDecision {
	out: string | null;
	/** Exceptional admission explanation, never a destination or spawn authorization. */
	retained: string | null;
}

export interface Headroom {
	/** Base refusal, or exceptional retention against ordered configured budget comparators. */
	decisionFor(selector: string, comparators?: readonly string[]): HeadroomDecision;
	/** Why nothing can be out (fail-open), or null when the polls were read. */
	note: string | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parsePoll(line: string): Poll | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const { t, rows, limits } = raw as { t?: unknown; rows?: unknown; limits?: unknown };
	if (!isNum(t)) return null;
	const found: Limit[] = [];
	if (Array.isArray(limits)) {
		for (const l of limits) {
			if (!l || typeof l !== "object") continue;
			const { provider, windowId, tier, resetsAt, usedFraction } = l as Record<string, unknown>;
			if (typeof provider !== "string" || typeof windowId !== "string" || !isNum(usedFraction)) continue;
			found.push({ provider, windowId, tier: typeof tier === "string" && tier ? tier : null, used: usedFraction, resetsAt: isNum(resetsAt) ? resetsAt : null });
		}
	} else if (rows && typeof rows === "object") {
		for (const [key, used] of Object.entries(rows as Record<string, unknown>)) {
			const [provider, windowId, third] = key.split("/");
			if (!provider || !windowId || !isNum(used)) continue;
			found.push({ provider, windowId, tier: third && !METERS[third] ? third : null, used, resetsAt: null });
		}
	} else return null;
	return { t: t * 1000, limits: found };
}

const pct = (n: number) => n.toFixed(2);

/** A reported decimal usage delta, kept exact until comparative admission has been decided. */
interface UsageDelta {
	units: bigint;
	places: number;
}

function decimalUsage(used: number): UsageDelta {
	const [mantissa, exponent = "0"] = used.toString().split("e");
	const [whole, fraction = ""] = mantissa!.split(".");
	return { units: BigInt(whole! + fraction), places: fraction.length - Number(exponent) };
}

function usageDelta(newer: number, older: number): UsageDelta {
	const a = decimalUsage(newer);
	const b = decimalUsage(older);
	const places = Math.max(a.places, b.places);
	return { units: a.units * 10n ** BigInt(places - a.places) - b.units * 10n ** BigInt(places - b.places), places };
}

function greaterDelta(a: UsageDelta, b: UsageDelta): boolean {
	// The common sample span cancels. Binary subtraction must not turn .21-.20 versus .05-.04 into a win.
	const places = Math.max(a.places, b.places);
	return a.units * 10n ** BigInt(places - a.places) > b.units * 10n ** BigInt(places - b.places);
}

function bindingLimits(poll: Poll, selector: string): Limit[] {
	const bare = selector.trim().replace(/:[^/]*$/, "");
	const slash = bare.indexOf("/");
	if (slash < 0) return [];
	const provider = bare.slice(0, slash);
	const model = bare.slice(slash + 1).toLowerCase();
	return poll.limits.filter(l => l.provider === provider && (l.tier === null || model.includes(l.tier.toLowerCase())));
}

/** Read/parse once and keep the snapshot plus common rate evidence. `lines` replaces the file read (tests). */
export function headroom(opts: { path?: string; now?: number; lines?: string[] } = {}): Headroom {
	const now = opts.now ?? Date.now();
	const path = opts.path ?? (process.env.AS2_HEADROOM_POLLS || DEFAULT_POLLS);
	const open = (note: string): Headroom => ({ decisionFor: () => ({ out: null, retained: null }), note });

	let lines = opts.lines;
	if (!lines) {
		try {
			lines = readFileSync(path, "utf8").split("\n");
		} catch (e) {
			return open(`headroom polls unreadable: ${path} (${(e as NodeJS.ErrnoException).code ?? String(e)})`);
		}
	}
	const source = opts.lines ? "inline lines" : path;
	const polls = lines.flatMap(l => (l.trim() ? (parsePoll(l) ?? []) : [])).sort((a, b) => a.t - b.t);
	const newest = polls.at(-1);
	if (!newest) return open(`headroom polls empty: ${source}`);
	const age = now - newest.t;
	if (age > STALE_MIN * MIN_MS) return open(`headroom polls stale: newest ${Math.round(age / MIN_MS)} min old in ${source}`);
	// Oldest eligible endpoint, anchored at the newest poll, shared by every budget. Future polls cannot compare.
	const older = age < 0 ? undefined : polls.find(p => newest.t - p.t >= 15 * MIN_MS && newest.t - p.t <= 60 * MIN_MS);
	const spanMin = older ? (newest.t - older.t) / MIN_MS : null;

	const pressureOf = (selector: string): UsageDelta | null => {
		if (!older) return null;
		let pressure: UsageDelta | null = null;
		for (const l of bindingLimits(newest, selector)) {
			const previous = older.limits.find(p => p.provider === l.provider && p.windowId === l.windowId && p.tier === l.tier);
			if (!previous || l.resetsAt === null || previous.resetsAt === null
				|| l.resetsAt <= newest.t || previous.resetsAt <= newest.t || Math.abs(l.resetsAt - previous.resetsAt) > MIN_MS
				|| l.used < 0 || l.used > 1 || previous.used < 0 || previous.used > 1 || l.used < previous.used) continue;
			const delta = usageDelta(l.used, previous.used);
			if (pressure === null || greaterDelta(delta, pressure)) pressure = delta;
		}
		return pressure;
	};

	/** Use projected at reset from the window's pace so far; null when it cannot be projected yet. */
	const paceAtReset = (l: Limit): { projected: number; perHour: number } | null => {
		const length = l.resetsAt === null ? null : windowMs(l.windowId);
		if (length === null || l.resetsAt === null) return null;
		const elapsed = length - (l.resetsAt - now);
		if (elapsed < Math.max(PACE_FLOOR_MIN * MIN_MS, length * PACE_WINDOW_FRACTION) || elapsed > length) return null;
		const perMs = l.used / elapsed;
		return { projected: perMs * length, perHour: perMs * 3_600_000 };
	};

	const refusalOf = (l: Limit): { reason: string; weekPaceOnly: boolean } | null => {
		if (l.resetsAt !== null && l.resetsAt <= now) return null;
		const name = `${l.provider} ${l.windowId}${l.tier ? ` ${l.tier}` : ""} ${pct(l.used)} used`;
		const ceiling = l.windowId === "5h" && l.used > FIVE_HOUR_CEILING;
		const pace = paceAtReset(l);
		if (pace && pace.projected >= 1.0) {
			const reset = `${new Date(l.resetsAt!).toISOString().slice(0, 16)}Z`;
			return {
				reason: `${name}, window pace +${(pace.perHour * 100).toFixed(1)} pts/h, projected ${pct(pace.projected)} at reset ${reset}`,
				weekPaceOnly: windowMs(l.windowId) === WEEK_MS && l.used < 1 && !ceiling,
			};
		}
		if (ceiling) return { reason: `${name} > ${pct(FIVE_HOUR_CEILING)}${l.resetsAt === null ? " (no reset time)" : ""}`, weekPaceOnly: false };
		return null;
	};

	return {
		note: null,
		decisionFor(selector: string, comparators: readonly string[] = []): HeadroomDecision {
			let out: string | null = null;
			let exhausted: Limit | null = null;
			let weekPaceOnly = true;
			for (const l of bindingLimits(newest, selector)) {
				if (l.resetsAt !== null && l.resetsAt <= now) continue;
				if (l.used >= 1) {
					weekPaceOnly = false;
					if (l.resetsAt !== null && windowMs(l.windowId) === WEEK_MS) exhausted ??= l;
				}
				const refusal = refusalOf(l);
				if (!refusal) continue;
				out ??= refusal.reason;
				if (!refusal.weekPaceOnly) weekPaceOnly = false;
			}
			// Exhaustion closes only the week warm-up gap; keep the first existing ordinary refusal and its wording.
			if (out === null && exhausted !== null) {
				out = `${exhausted.provider} ${exhausted.windowId}${exhausted.tier ? ` ${exhausted.tier}` : ""} ${pct(exhausted.used)} used, quota exhausted`;
			}
			const base = { out, retained: null };
			if (out === null || !weekPaceOnly || !older) return base;
			const sourceLab = labOf(selector);
			if (sourceLab === null) return base;
			// Stopping at the first known other lab also preserves its first occurrence across aliases.
			const comparator = comparators.find(s => {
				const lab = labOf(s);
				return lab !== null && lab !== sourceLab;
			});
			if (comparator === undefined) return base;
			const sourcePressure = pressureOf(selector);
			const comparatorPressure = pressureOf(comparator);
			if (sourcePressure === null || comparatorPressure === null || !greaterDelta(comparatorPressure, sourcePressure)) return base;
			const pointsPerHour = (delta: UsageDelta) => (Number(`${delta.units}e-${delta.places}`) * 6000 / spanMin!).toFixed(2);
			return {
				out: null,
				retained: `retained ${selector}: ${out}; ${comparator} recent pressure ${pointsPerHour(comparatorPressure)} pts/h > source ${pointsPerHour(sourcePressure)} pts/h over ${spanMin} min`,
			};
		},
	};
}
