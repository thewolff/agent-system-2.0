// The per-workload ceiling's pure half (DESIGN-workload-ceiling.md § 2, § 4): the stakes-sized
// ceiling, the `ceiling:` and `spend:` control bodies, the effective ceiling with the raise-needs-Jo
// rule, the spend scan over the workload's session files, wall time from the lane lifecycle
// entries, the threshold check and the question Jo answers. Nothing here opens the ledger: callers
// read the rows and hand them in, as with launch.ts. `scanSpend` reads session files and nothing else.
//
// Units (§ 1 C, § 2 item 3): dollars are nominal list price as OMP computes it
// (`usage.cost.total` on each assistant message); tokens are counted beside them and never
// compared; wall is lane run time in minutes.
import { closeSync, type Dirent, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { InstructionRow, RoutingKind, Stakes } from "../../ledger/src/index";
import { type ControlEntry, JO_HOLDER } from "./launch";
import { linkHeader, type Links } from "./question-links";
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
 * (`stakes: <s>`), the `ceiling` word (`ceiling: <usd> <hours>`), and the *extend* answer to the
 * runner's ceiling question (an `answer` whose body is `extend`). Any other surface-written
 * author-jo row — an `orchestrator_record_instruction` row, whose text the model composes — is not one.
 */
export function isRaiseInstruction(i: Pick<InstructionRow, "kind" | "body">): boolean {
	return i.body.startsWith("ceiling: ") || i.body.startsWith("stakes: ") || (i.kind === "answer" && i.body === "extend");
}

/**
 * The workload's effective ceiling (§ 2 item 1). The valid `ceiling:` entries, oldest first: the
 * first sets it; a later entry that raises neither half applies; one that raises either half applies
 * only when its `by <in-id>` names a Jo-authored instruction the surface wrote (every raise path is
 * a surface path, so a lane's "author jo" row never counts), in one of the raise shapes
 * (`isRaiseInstruction`), at or after the entry now in force; else it is ignored. `control` must come
 * from `controlEntries`, which already dropped every `ceiling:` not written by the surface. No entry
 * (a workload opened before the ceiling): the stakes size ×1.
 */
export function effectiveCeiling(control: readonly ControlEntry[], instructions: readonly InstructionRow[], stakes: Stakes): Ceiling {
	let cur: (Ceiling & { at: string }) | null = null;
	for (const c of control) {
		if (c.prefix !== "ceiling") continue;
		const p = parseCeiling(c.rest);
		if (p === null) continue;
		if (cur !== null && (p.usd > cur.usd || p.wallMin > cur.wallMin)) {
			const since = cur.at;
			if (!instructions.some((i) => i.id === p.by && i.author === JO_HOLDER && i.created_by === SURFACE_BY && i.created_at >= since && isRaiseInstruction(i))) continue;
		}
		cur = { usd: p.usd, wallMin: p.wallMin, at: c.createdAt };
	}
	return cur === null ? sizeFor(stakes, null) : { usd: cur.usd, wallMin: cur.wallMin };
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

function assistantUsage(line: string): { usd: number; tokens: number } {
	if (!line.includes('"assistant"')) return { usd: 0, tokens: 0 };
	let v: unknown;
	try {
		v = JSON.parse(line);
	} catch {
		return { usd: 0, tokens: 0 };
	}
	const rec = v as { type?: unknown; message?: { role?: unknown; usage?: { totalTokens?: unknown; cost?: { total?: unknown } } } } | null;
	if (rec === null || typeof rec !== "object" || rec.type !== "message" || rec.message?.role !== "assistant") return { usd: 0, tokens: 0 };
	const cost = rec.message.usage?.cost?.total;
	const total = rec.message.usage?.totalTokens;
	return { usd: typeof cost === "number" && Number.isFinite(cost) ? cost : 0, tokens: typeof total === "number" && Number.isFinite(total) ? total : 0 };
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

// ---- the question ------------------------------------------------------------------------------

/** The ceiling question's answers (§ 2 items 4, 5); stop is the default. */
export const CEILING_OPTIONS = ["stop", "extend", "split"] as const;
export type CeilingOption = (typeof CEILING_OPTIONS)[number];

/**
 * The body of the question raised at 80 % (§ 2 item 4): its link header comes first (PLAN
 * wl-mv66q5b148uznk § Question kinds; the spend has no file, so it stays in the text), then
 * where the spend stands, stop as the default, and what each answer does.
 */
export function ceilingQuestionBody(wl: string, s: Spend, c: Ceiling, stakes: Stakes, links: Links): string {
	if (!links) throw new Error(`the ceiling question of ${wl} offers extend, so it carries its links (plan file, review verdict files, PRs); none were given`);
	const pct = (a: number, b: number) => Math.floor((a / b) * 100);
	return [
		...linkHeader(links),
		`${wl} has used $${s.usd.toFixed(2)} of its $${c.usd} ceiling (${pct(s.usd, c.usd)} %) and ${Math.round(s.wallMin)} of ${c.wallMin} minutes (${pct(s.wallMin, c.wallMin)} %), ${stakes} stakes; ${s.tokens} tokens.`,
		`stop (the default): the lane keeps working and is stopped at the ceiling; nothing relaunches.`,
		`extend: the ceiling grows by one more block of this workload's own size and the lane goes on (a stopped lane relaunches); for an exact figure say \`ceiling <usd> [<hours>] ${wl}\` instead.`,
		`split: the lane is stopped at the ceiling like stop, and the remaining work is split into a new workload; nothing relaunches here.`,
	].join("\n");
}

// ---- helpers -----------------------------------------------------------------------------------

/** A body's number field: finite and not negative, else null. */
function count(s: string): number | null {
	const n = Number(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
}
