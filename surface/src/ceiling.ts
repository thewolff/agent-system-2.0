// The per-workload ceiling's pure half (DESIGN-workload-ceiling.md § 2, § 4): the stakes-sized
// ceiling, the `ceiling:` and `spend:` control bodies, the effective ceiling with the raise-needs-Jo
// rule, the spend scan over the workload's session files, wall time from the lane lifecycle
// entries, the threshold check and the notices Jo is told (PLAN wl-mvfkv7llkp7nk0 § 4), and a by-hand (paired) lane's
// spend report (§ 4.1), which never stops it. Nothing here
// opens the ledger: callers read the rows and hand them in, as with launch.ts. `scanSpend` reads
// session files and nothing else.
//
// Units (§ 1 C, § 2 item 3): dollars are nominal list price as OMP computes it
// (`usage.cost.total` on each assistant message); tokens are counted beside them and never
// compared; wall is lane run time in minutes.
import { closeSync, type Dirent, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { type InstructionRow, LANE_RUNNER_BY, type RoutingKind, type Stakes } from "../../ledger/src/index";
import { attempts, type ControlEntry, heldLive, JO_HOLDER } from "./launch";
import { SURFACE_BY } from "./types";

export interface Ceiling {
	usd: number;
	wallMin: number;
}
export interface Spend {
	usd: number;
	tokens: number;
	wallMin: number;
}

// ---- sizing ------------------------------------------------------------------------------------

/** § 1 C: $5 / 1 h, $50 / 6 h, $150 / 12 h. */
export const CEILING_BY_STAKES: Record<Stakes, Ceiling> = {
	throwaway: { usd: 5, wallMin: 60 },
	normal: { usd: 50, wallMin: 360 },
	production: { usd: 150, wallMin: 720 },
};
/** § 1 B: a brief the open-time classifier judged change-large gets three blocks. */
export const CHANGE_LARGE_FACTOR = 3;

/** The stakes size, ×`CHANGE_LARGE_FACTOR` exactly when the brief was judged change-large. */
export function sizeFor(stakes: Stakes, judgedKind: RoutingKind | null): Ceiling {
	const base = CEILING_BY_STAKES[stakes];
	const f = judgedKind === "change-large" ? CHANGE_LARGE_FACTOR : 1;
	return { usd: base.usd * f, wallMin: base.wallMin * f };
}

// ---- ceiling: ----------------------------------------------------------------------------------

export interface CeilingEntry extends Ceiling {
	source: string;
	/** The Jo instruction a raise names, or null. */
	by: string | null;
}

/** `ceiling: usd <x> wall <min> source <text>[ by <in-id>]`. */
export function ceilingBody(c: Ceiling, source: string, byInstruction?: string): string {
	return `ceiling: usd ${c.usd} wall ${c.wallMin} source ${source.replace(/\s+/g, " ").trim()}${byInstruction ? ` by ${byInstruction}` : ""}`;
}

/** The `source` of the `ceiling:` entry a one-block raise writes: Jo's `extend <wl>` word, and before it the extend answer to the runner's ceiling question. */
export const EXTEND_SOURCE = "extend one block";

const CEILING_REST = /^usd\s+(\S+)\s+wall\s+(\S+)\s+source\s+(.+?)(?:\s+by\s+(in-\S+))?$/;

/** A `ceiling:` entry's `rest` (the body after the prefix), parsed; null when either half is not a positive number or the source is missing. */
export function parseCeiling(rest: string): CeilingEntry | null {
	const m = CEILING_REST.exec(rest.trim());
	if (!m) return null;
	const usd = count(m[1]!);
	const wallMin = count(m[2]!);
	if (usd === null || wallMin === null || usd === 0 || wallMin === 0) return null;
	return { usd, wallMin, source: m[3]!, by: m[4] ?? null };
}

/**
 * The Jo instructions the surface writes to license a raise (surface/src/input.ts): the stakes word
 * (`stakes: <s>`), the `ceiling` and `extend` words (both `ceiling: <usd> <hours>`), and the *extend*
 * answer to the runner's former ceiling question (an `answer` whose body is `extend`), which raised
 * ceilings written before PLAN wl-mvfkv7llkp7nk0 § 4 still name. Any other surface-written author-jo
 * row — an `orchestrator_record_instruction` row, whose text the model composes — is not one.
 */
export function isRaiseInstruction(i: Pick<InstructionRow, "kind" | "body">): boolean {
	return i.body.startsWith("ceiling: ") || i.body.startsWith("stakes: ") || (i.kind === "answer" && i.body === "extend");
}

/** The `source` the runner's one raise by half starts with (PLAN wl-mvqwn80onq9hq8 D12): `auto-raise half progress <kind> <evidence>…`. */
export const AUTO_RAISE_SOURCE = "auto-raise half";

/**
 * The runner's one raise by half (D12), rounded down and never above 150 %: dollars to the cent, `floor(usd × 150) / 100`, and
 * wall to the minute, `floor(wall × 1.5)`. $0.10 → $0.15, $5 → $7.50, 61 → 91 min. Null unless both halves come out strictly
 * above `c` ($0.001 → $0, $0.01 → $0.01, 1 → 1 min): a null is a failed raise, never announced as one. The arithmetic runs on
 * integer micro-dollars and milli-minutes, so binary noise (0.7 × 150 = 104.99…) never moves a cent or a minute either way; an
 * input finer than that unit is taken at the unit below it ($49.9999999 → 49.999999, so $74.99, never $75), so the cap holds.
 * Exact only while `3 × micro` and `3 × milli` stay safe integers (about $3 billion, 3 billion minutes); past that the raise is
 * null, so the runner asks Jo rather than write an inexact or infinite ceiling.
 */
export function halfRaise(c: Ceiling): Ceiling | null {
	// Nearest unit, then one unit down when that nearest is above the input: a decimal at the unit's precision maps to the
	// same double either way (`k / 1e6 === c.usd`), so only a finer input steps down.
	let micro = Math.round(c.usd * 1e6);
	if (micro / 1e6 > c.usd) micro -= 1;
	let milli = Math.round(c.wallMin * 1e3);
	if (milli / 1e3 > c.wallMin) milli -= 1;
	if (!Number.isSafeInteger(micro * 3) || !Number.isSafeInteger(milli * 3)) return null;
	const usd = Math.floor((micro * 3) / 20_000) / 100;
	const wallMin = Math.floor((milli * 3) / 2_000);
	return usd > c.usd && wallMin > c.wallMin ? { usd, wallMin } : null;
}

/** Whether the runner ever wrote a `ceiling:` row with source `auto-raise half` on the workload (D12: at most once), applied or not. */
export function autoRaiseUsed(control: readonly ControlEntry[]): boolean {
	return control.some((c) => c.prefix === "ceiling" && c.createdBy === LANE_RUNNER_BY && /(?:^|\s)source auto-raise half(?:\s|$)/.test(c.rest));
}

/**
 * The workload's effective ceiling (§ 2 item 1): `ceilingInForce`'s value.
 */
export function effectiveCeiling(control: readonly ControlEntry[], instructions: readonly InstructionRow[], stakes: Stakes): Ceiling {
	return ceilingInForce(control, instructions, stakes).ceiling;
}

/**
 * The workload's effective ceiling (§ 2 item 1) and the `ceiling:` entry in force's time (null with none). The valid
 * `ceiling:` entries, oldest first: the first sets it; a later entry that raises neither half applies; one that raises
 * either half applies only when its `by <in-id>` names a Jo-authored instruction the surface wrote (every Jo raise path is
 * a surface path, so a lane's "author jo" row never counts), in one of the raise shapes (`isRaiseInstruction`), at or
 * after the entry now in force; else it is ignored. A `ceiling:` written by the lane runner (PLAN wl-mvqwn80onq9hq8 D12)
 * applies only when its source starts `auto-raise half`, its two values equal `halfRaise` of the ceiling then in force,
 * and no earlier such row exists on the workload; any other runner row is ignored. `control` must come from
 * `controlEntries`, which already dropped every `ceiling:` not written by the surface or the runner. No entry (a workload
 * opened before the ceiling): the stakes size ×1.
 */
export function ceilingInForce(control: readonly ControlEntry[], instructions: readonly InstructionRow[], stakes: Stakes): { ceiling: Ceiling; at: string | null } {
	let cur: (Ceiling & { at: string }) | null = null;
	let autoRaised = false;
	for (const c of control) {
		if (c.prefix !== "ceiling") continue;
		const p = parseCeiling(c.rest);
		if (p === null) continue;
		if (c.createdBy === LANE_RUNNER_BY) {
			if (p.source !== AUTO_RAISE_SOURCE && !p.source.startsWith(`${AUTO_RAISE_SOURCE} `)) continue;
			const first = !autoRaised;
			autoRaised = true;
			const half = halfRaise(cur ?? sizeFor(stakes, null));
			if (first && half !== null && p.usd === half.usd && p.wallMin === half.wallMin) cur = { usd: p.usd, wallMin: p.wallMin, at: c.createdAt };
			continue;
		}
		if (cur !== null && (p.usd > cur.usd || p.wallMin > cur.wallMin)) {
			const since = cur.at;
			if (!instructions.some((i) => i.id === p.by && i.author === JO_HOLDER && i.created_by === SURFACE_BY && i.created_at >= since && isRaiseInstruction(i))) continue;
		}
		cur = { usd: p.usd, wallMin: p.wallMin, at: c.createdAt };
	}
	return cur === null ? { ceiling: sizeFor(stakes, null), at: null } : { ceiling: { usd: cur.usd, wallMin: cur.wallMin }, at: cur.at };
}

// ---- spend: ------------------------------------------------------------------------------------

/** `spend: <laneId> usd <x> tokens <n> wall <min>`: dollars to 4 places, wall to 0.1 min. */
export function spendBody(laneId: string, s: Spend): string {
	return `spend: ${laneId} usd ${Math.round(s.usd * 1e4) / 1e4} tokens ${Math.round(s.tokens)} wall ${Math.round(s.wallMin * 10) / 10}`;
}

const SPEND_REST = /^usd\s+(\S+)\s+tokens\s+(\S+)\s+wall\s+(\S+)$/;

/** A `spend:` entry's `rest` (after the prefix and the lane id, as `controlEntries` splits it), parsed; null when malformed. */
export function parseSpend(rest: string): Spend | null {
	const m = SPEND_REST.exec(rest.trim());
	if (!m) return null;
	const usd = count(m[1]!);
	const tokens = count(m[2]!);
	const wallMin = count(m[3]!);
	return usd === null || tokens === null || wallMin === null ? null : { usd, tokens, wallMin };
}

// ---- metering ----------------------------------------------------------------------------------

/**
 * Add the assistant usage OMP wrote since the last scan to `acc` (§ 2 item 4). Every `*.jsonl`
 * under `sessionsDir`, recursively (a hand's session file is `<session>/<agent>.jsonl`), is read from
 * its offset in `offsets` (keyed by path; absent = 0) to its last newline; `offsets` advances past
 * what was read, so a partial trailing line waits for the next scan and nothing is counted twice.
 * A line counts when it is `{"type":"message","message":{"role":"assistant","usage":…}}`: its
 * `usage.cost.total` in dollars and `usage.totalTokens`; a missing or non-numeric field counts 0.
 * `acc.wallMin` passes through. A missing directory adds nothing.
 */
export function scanSpend(sessionsDir: string, offsets: Map<string, number>, acc: Spend): Spend {
	let usd = acc.usd;
	let tokens = acc.tokens;
	for (const file of jsonlFiles(sessionsDir)) {
		const from = offsets.get(file) ?? 0;
		const chunk = readComplete(file, from);
		if (chunk === null) continue;
		offsets.set(file, from + chunk.bytes);
		for (const line of chunk.text.split("\n")) {
			const u = assistantUsage(line);
			usd += u.usd;
			tokens += u.tokens;
		}
	}
	return { usd, tokens, wallMin: acc.wallMin };
}

function jsonlFiles(dir: string): string[] {
	let items: Dirent[];
	try {
		items = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const d of items) {
		const p = join(dir, d.name);
		if (d.isDirectory()) out.push(...jsonlFiles(p));
		else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

/** The bytes of `file` from `from` through its last newline, decoded; null when there is no complete new line (or the file is gone). */
function readComplete(file: string, from: number): { text: string; bytes: number } | null {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		if (size <= from) return null;
		const buf = Buffer.alloc(size - from);
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, from + got);
			if (n === 0) break;
			got += n;
		}
		const end = buf.subarray(0, got).lastIndexOf(0x0a);
		if (end < 0) return null;
		return { text: buf.subarray(0, end).toString("utf8"), bytes: end + 1 };
	} finally {
		closeSync(fd);
	}
}

/**
 * One session-file line's assistant usage, the one per-message parser (`scanSpend` here, the routing
 * report's per-hand cost in surface/src/routing-report.ts): a `{"type":"message","message":{"role":
 * "assistant","usage":…}}` line gives its `usage.cost.total` in dollars and `usage.totalTokens`, a
 * missing or non-numeric field 0; any other line gives 0. `malformed` is true for a line that names
 * `"assistant"` but is not JSON (a torn or corrupt line): it counts 0. `costMissing` is true for an
 * assistant message whose `usage.cost.total` is not a finite number (absent, a string, null): its
 * dollars count 0 here, but they are unknown, not zero; an explicit numeric 0 is a known zero.
 * `scanSpend` sums `usd` and `tokens` only and accepts both flags; the routing report marks a hand
 * with either flag (or an unterminated last line) `incomplete`, its cost n/a, never summed as zero.
 */
export function assistantUsage(line: string): { usd: number; tokens: number; malformed: boolean; costMissing: boolean } {
	if (!line.includes('"assistant"')) return { usd: 0, tokens: 0, malformed: false, costMissing: false };
	let v: unknown;
	try {
		v = JSON.parse(line);
	} catch {
		return { usd: 0, tokens: 0, malformed: true, costMissing: false };
	}
	const rec = v as { type?: unknown; message?: { role?: unknown; usage?: { totalTokens?: unknown; cost?: { total?: unknown } } } } | null;
	if (rec === null || typeof rec !== "object" || rec.type !== "message" || rec.message?.role !== "assistant") return { usd: 0, tokens: 0, malformed: false, costMissing: false };
	const cost = rec.message.usage?.cost?.total;
	const total = rec.message.usage?.totalTokens;
	const costKnown = typeof cost === "number" && Number.isFinite(cost);
	return { usd: costKnown ? cost : 0, tokens: typeof total === "number" && Number.isFinite(total) ? total : 0, malformed: false, costMissing: !costKnown };
}

/**
 * Lane run time on the workload in minutes (§ 2 item 3): for each lane, its first `lane-started:`
 * to its `lane-exit:` (a lane with no exit contributes nothing here), plus `now − currentStart`
 * for the run in progress (null: none; a run whose `lane-exit:` is already written is not in
 * progress). Time parked on Jo falls between runs and is not counted.
 */
export function wallMinutes(control: readonly ControlEntry[], now: number, currentStart: number | null): number {
	const started = new Map<string, number>();
	const exited = new Map<string, number>();
	for (const c of control) {
		if (c.laneId === null) continue;
		const at = Date.parse(c.createdAt);
		if (!Number.isFinite(at)) continue;
		if (c.prefix === "lane-started" && !started.has(c.laneId)) started.set(c.laneId, at);
		else if (c.prefix === "lane-exit") exited.set(c.laneId, at);
	}
	let ms = 0;
	for (const [lane, start] of started) {
		const end = exited.get(lane);
		if (end !== undefined && end > start) ms += end - start;
	}
	if (currentStart !== null && now > currentStart) ms += now - currentStart;
	return ms / 60_000;
}

/** The threshold crossed by the higher half: 100 at or past the ceiling, 80 at or past 80 % of it, else 0. */
export function crossed(s: Spend, c: Ceiling): 0 | 80 | 100 {
	if (s.usd >= c.usd || s.wallMin >= c.wallMin) return 100;
	// ×5 against ×4 keeps "exactly 80 %" exact for whole-number ceilings.
	if (s.usd * 5 >= c.usd * 4 || s.wallMin * 5 >= c.wallMin * 4) return 80;
	return 0;
}

/**
 * Whether the workload is stopped at its ceiling (PLAN wl-mvgn310dpi5gcg D3): each half's maximum over its `spend:` rows
 * (workload-cumulative, but concurrent lanes can write them out of order) against `effectiveCeiling`, at `crossed` 100.
 * The spend and the ceiling when stopped, else null.
 */
export function ceilingStopped(control: readonly ControlEntry[], instructions: readonly InstructionRow[], stakes: Stakes): { spend: Spend; ceiling: Ceiling } | null {
	const spend: Spend = { usd: 0, tokens: 0, wallMin: 0 };
	for (const c of control) {
		const s = c.prefix === "spend" ? parseSpend(c.rest) : null;
		if (s === null) continue;
		spend.usd = Math.max(spend.usd, s.usd);
		spend.tokens = Math.max(spend.tokens, s.tokens);
		spend.wallMin = Math.max(spend.wallMin, s.wallMin);
	}
	const ceiling = effectiveCeiling(control, instructions, stakes);
	return crossed(spend, ceiling) === 100 ? { spend, ceiling } : null;
}

// ---- the notices -------------------------------------------------------------------------------

/** The meter's two notice levels (PLAN wl-mvfkv7llkp7nk0 § 4): 80 % of either half, and the stop at 100 %. */
export type CeilingNoticeLevel = 80 | 100;

/** A ceiling value as the meter keys it: an extend, a `ceiling` word or a lowering is a new value, which may notify again. */
export const ceilingKey = (c: Ceiling): string => `usd ${c.usd} wall ${c.wallMin}`;

/**
 * The text of the runner's ceiling notice (surface/src/notice.ts adds `notice: `). Its first line names the level and
 * the ceiling value it was sent for (`parseCeilingNotice` reads them back, so the runner sends one per level per value),
 * then where the spend stands; the second line says what happens and Jo's words: `extend <wl>` (one more block) and
 * `ceiling <usd> [<hours>] <wl>`, and at 100 % `user-driven <wl>` too. Nothing is asked and nothing extends on its own.
 */
export function ceilingNoticeBody(level: CeilingNoticeLevel, wl: string, s: Spend, c: Ceiling, stakes: Stakes): string {
	const pct = (a: number, b: number) => Math.floor((a / b) * 100);
	const raise = `\`extend ${wl}\` (one more block of its own size) or \`ceiling <usd> [<hours>] ${wl}\``;
	return [
		`ceiling ${level} % at ${ceilingKey(c)} on ${wl}: $${s.usd.toFixed(2)} of $${c.usd} (${pct(s.usd, c.usd)} %) and ${Math.round(s.wallMin)} of ${c.wallMin} minutes (${pct(s.wallMin, c.wallMin)} %), ${stakes} stakes; ${Math.round(s.tokens)} tokens.`,
		level === 80
			? `The lane goes on and is stopped at 100 %. For more room: ${raise}.`
			: `The lane is stopped at the ceiling and nothing relaunches on its own. To go on: ${raise}; either relaunches it. To drive it yourself: \`user-driven ${wl}\`.`,
	].join("\n");
}

const CEILING_NOTICE = /^notice: ceiling (80|100) % at (usd \S+ wall \S+) on (\S+):/;

/** A ceiling notice's message body (with its `notice: ` prefix) read back: its level, ceiling value (`ceilingKey`) and workload; null for any other body. */
export function parseCeilingNotice(body: string): { level: CeilingNoticeLevel; key: string; workloadId: string } | null {
	const m = CEILING_NOTICE.exec(body);
	return m ? { level: Number(m[1]) as CeilingNoticeLevel, key: m[2]!, workloadId: m[3]! } : null;
}

// ---- the hit at 100 % (PLAN wl-mvqwn80onq9hq8 D12) -------------------------------------------------------------

/** The one-line notice of the runner's raise by half: old and new value, the progress that earned it, and Jo's words. */
export function ceilingRaisedNoticeBody(wl: string, old: Ceiling, next: Ceiling, progress: string): string {
	return `ceiling raised once by half on ${wl}: $${old.usd}→$${next.usd}, ${old.wallMin}→${next.wallMin} min; progress: ${progress}. Next hit asks; \`ceiling <usd> [<hours>] ${wl}\` sets another figure, \`halt ${wl}\` stops it.`;
}

/** The two answers to the runner's ceiling question: `extend` (one block of the workload's own size and a relaunch) and `stop`. */
export const CEILING_QUESTION_OPTIONS = ["extend", "stop"] as const;

/**
 * The runner's question at a 100 % hit it did not raise (D12): `first` (`ceiling reached on <wl>: <why>` or `ceiling
 * auto-raise failed: <error>`), then the stop notice's first line (the spend and the ceiling, which `parseCeilingQuestion`
 * reads back), the progress found when there is any, and what each answer does.
 */
export function ceilingQuestionBody(first: string, wl: string, s: Spend, c: Ceiling, stakes: Stakes, progress: string | null): string {
	return [
		first.replace(/\s+/g, " ").trim(),
		ceilingNoticeBody(100, wl, s, c, stakes).split("\n")[0]!,
		...(progress === null ? [] : [`progress: ${progress}`]),
		`The lane is stopped. \`extend\`: one more block of ${wl}'s own size and a relaunch; \`stop\`: the stop stands and nothing relaunches.`,
	].join("\n");
}

const CEILING_QUESTION_FIRST = /^(?:ceiling reached on \S+: |ceiling auto-raise failed: )/;
const CEILING_STOP_LINE = /^ceiling 100 % at (usd \S+ wall \S+) on (\S+):/m;

/** A runner ceiling question's body read back: the ceiling value (`ceilingKey`) and workload of its stop line; null for any other body. */
export function parseCeilingQuestion(body: string): { key: string; workloadId: string } | null {
	if (!CEILING_QUESTION_FIRST.test(body)) return null;
	const m = CEILING_STOP_LINE.exec(body);
	return m ? { key: m[1]!, workloadId: m[2]! } : null;
}

/** A branch head as a ceiling mark records it: a sha, `none` (no such branch) or `unknown` (the read failed). */
export interface CeilingMark {
	remote: string;
	branch: string;
	/** The remote's push URL when the mark was taken, or `unknown`. */
	url: string;
	head: string;
}

/** `ceiling-mark: <remote> <branch> <push url> <sha|none|unknown>`: the runner's record of one workload branch's remote head (D12). */
export function ceilingMarkBody(m: CeilingMark): string {
	return `ceiling-mark: ${m.remote} ${m.branch} ${m.url} ${m.head}`;
}

/** A `ceiling-mark:` entry's `rest`, parsed; null unless it is exactly four tokens. */
export function parseCeilingMark(rest: string): CeilingMark | null {
	const t = rest.trim().split(/\s+/);
	return t.length === 4 ? { remote: t[0]!, branch: t[1]!, url: t[2]!, head: t[3]! } : null;
}

// ---- paired: a by-hand lane (PLAN wl-mvfkv7llkp7nk0 § 4.1, Jo's ruling in-mvfo7nphl9xn28) --------------------------

/** A by-hand lane: its `launch:` entry says `cause interactive` (`as2 lane <wl>`, surface/scripts/lane.ts cmdInteractive). */
export function isByHandLane(control: readonly ControlEntry[], laneId: string): boolean {
	return attempts(control).some((a) => a.laneId === laneId && a.cause?.kind === "interactive");
}

/**
 * A paired workload: its holder is a live by-hand lane (§ 4.1). A user-driven workload with no by-hand lane running is
 * not paired by itself: nothing spends and nobody is in a pane to tell.
 */
export function isPaired(w: { holder: string | null; holder_lease_until: string | null }, control: readonly ControlEntry[], now: string): boolean {
	return w.holder !== null && heldLive(w, now) && isByHandLane(control, w.holder);
}

/** The original ceiling (§ 4.1): the workload's first valid `ceiling:` entry not written by the runner's auto-raise (D12); with none, the effective ceiling (the stakes size). */
export function originalCeiling(control: readonly ControlEntry[], instructions: readonly InstructionRow[], stakes: Stakes): Ceiling {
	for (const c of control) {
		if (c.prefix !== "ceiling" || c.createdBy === LANE_RUNNER_BY) continue;
		const p = parseCeiling(c.rest);
		if (p !== null) return { usd: p.usd, wallMin: p.wallMin };
	}
	return effectiveCeiling(control, instructions, stakes);
}

/** The paired pane's memory in one lane session: the 25 % marks already accounted for, null before the first measure. */
export interface PairedState {
	shown: number | null;
}

/**
 * One measure of a by-hand lane's spend, pure (§ 4.1 (b)): one pane line for each 25 % mark of the original ceiling's
 * dollars reached since the last measure (37.50, 75, 112.50, 150, 187.50 … for $150), past 100 % without end. The
 * session's first measure only records where the spend stands: marks reached before this lane started are not "further".
 */
export function pairedSpendStep(state: PairedState, wl: string, s: Spend, original: Ceiling): { state: PairedState; lines: string[] } {
	// The 25 % marks of the original dollars reached; ×4 against the dollars keeps an exact mark exact.
	const at = Math.floor((s.usd * 4) / original.usd);
	if (state.shown === null) return { state: { shown: at }, lines: [] };
	if (at <= state.shown) return { state, lines: [] };
	const lines: string[] = [];
	for (let k = state.shown + 1; k <= at; k++) {
		lines.push(`spend on ${wl}: $${s.usd.toFixed(2)}, past $${((k * original.usd) / 4).toFixed(2)} (${k * 25} % of the original $${original.usd} ceiling), ${Math.round(s.wallMin)} min; paired: not stopped at the ceiling`);
	}
	return { state: { shown: at }, lines };
}

/** The context message a by-hand lane gets at every turn start (§ 4.1 (a)), against the ceiling in force. */
export function pairedSpendMessage(s: Spend, c: Ceiling): string {
	return `spend: $${s.usd.toFixed(2)} of $${c.usd} ceiling (${Math.floor((s.usd / c.usd) * 100)} %), ${Math.round(s.wallMin)} min; paired: not stopped at the ceiling`;
}

/** The by-hand first prompt's ceiling line (§ 4.1): the ceiling in force, the spend so far, and that the lane is never stopped at it. */
export function pairedCeilingPromptLine(c: Ceiling, original: Ceiling, s: Spend): string {
	return `ceiling: $${c.usd} / ${c.wallMin} min for the workload; spent so far $${s.usd.toFixed(2)} / ${Math.round(s.wallMin)} min (${Math.round(s.tokens)} tokens); you are paired with Jo; you are never stopped at the ceiling; the extension tells Jo the spend in the pane at every 25 % of the original ceiling ($${original.usd}, so every $${(original.usd / 4).toFixed(2)}).`;
}

// ---- helpers -----------------------------------------------------------------------------------

/** A body's number field: finite and not negative, else null. */
function count(s: string): number | null {
	const n = Number(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
}
