// The routing report (PLAN wl-mv71x5rwdu7eo0 rev 4 § 2.1): what the `routings` table says about the tier mix, read-only.
//
// `routingReport` is pure over rows: the caller reads the routings and the `headroom-skip:` entries through the ledger
// module (surface/scripts/routing-report.ts, `as2 routing`) and hands in a per-hand usage reader. `readHandUsage` is
// that reader: it reads the one session file of a hand, `<session_root>/<agent_id>.jsonl`, with the ceiling meter's own
// per-message parser (`assistantUsage`, surface/src/ceiling.ts), so the report's dollars are the meter's dollars.
//
// Counting rules, per kind × tier (the row's final `tier`):
// - rows, and each outcome;
// - the model of a row: `ran_models[0]`, else `model`, else `(none)` (a spawn that found no usable model);
// - pull-ups by `pull_up_to`, pull-downs by `pull_down_to`;
// - review vs build: `isReviewRouting` (classifier/src/lab.ts), the D2 read-back the plan gate uses;
// - USD and tokens: summed over the hands whose session file was read whole; unknown cost is `n/a`, never zero, and
//   never summed or averaged. A hand whose file is gone is `missing`; a file that exists but cannot be read is
//   `unreadable` with its error; a read file with an assistant message lacking a finite `usage.cost.total`, an
//   `"assistant"` line that is not JSON, or an unterminated last line is `incomplete`, listed with its file and the
//   counts of each. An explicit numeric cost of 0 is a known zero. A refused spawn with no agent id has no hand.
// - jev: rows whose `judge_model` starts `typesafe/jev`; code rows: change-small + change-large.
// - headroom-skip entries (`headroom-skip: <selector> token <dt> <reason>`, classifier/extension.ts) per selector; a
//   body without a selector is listed by entry id, never dropped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReviewRouting } from "../../classifier/src/lab";
import { KINDS, TIERS } from "../../classifier/src/route";
import type { EntryRow, RoutingKind, RoutingRow, Tier } from "../../ledger/src/index";
import { assistantUsage } from "./ceiling";

/** The body prefix of the classifier's headroom-skip entries. */
export const HEADROOM_SKIP_PREFIX = "headroom-skip: ";
/** The judge-model prefix the header's `jev` counts. */
export const JEV_PREFIX = "typesafe/jev";

/** What makes a read session file's cost unknown: its counts of each defect, and the part that was known, for display only. */
export interface IncompleteUsage {
	/** Assistant messages with no finite `usage.cost.total`. */
	costMissing: number;
	/** `"assistant"` lines that are not JSON. */
	malformed: number;
	/** The file does not end in a newline and its last line is not empty. */
	unterminated: boolean;
	/** The dollars and tokens of the lines that had them; never summed into a report total. */
	usd: number;
	tokens: number;
}

/** One hand's cost as its session file gives it. */
export type HandUsage =
	| { state: "read"; file: string; usd: number; tokens: number }
	/** Read, but its cost is unknown: n/a, out of every sum and average. */
	| ({ state: "incomplete"; file: string } & IncompleteUsage)
	| { state: "missing"; file: string }
	| { state: "unreadable"; file: string; error: string }
	/** A refused spawn (`refused-no-usable-model`): no agent id, no hand, no file. */
	| { state: "no-hand" };

/** A hand's session file, `<session_root>/<agent_id>.jsonl`; null for a row with no agent id. */
export function sessionFile(row: Pick<RoutingRow, "session_root" | "agent_id">): string | null {
	return row.agent_id === null ? null : join(row.session_root, `${row.agent_id}.jsonl`);
}

/**
 * One hand's USD and tokens from its single session file, every line through `assistantUsage`. A file that does not
 * exist (ENOENT) is `missing`; any other read error is `unreadable` with its code and message. A file with any
 * assistant message lacking a finite cost, any non-empty line that is not JSON, or an unterminated last line is
 * `incomplete`: its cost is unknown, and the known part rides along for display only. `assistantUsage` parses only
 * lines naming `"assistant"` (the ceiling meter's fast path); every other line is parsed here, so a line torn before
 * that marker is still caught (code review r2 F1).
 */
export function readHandUsage(row: Pick<RoutingRow, "session_root" | "agent_id">): HandUsage {
	const file = sessionFile(row);
	if (file === null) return { state: "no-hand" };
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		const code = e instanceof Error && "code" in e ? String(e.code) : null;
		if (code === "ENOENT") return { state: "missing", file };
		return { state: "unreadable", file, error: e instanceof Error ? e.message : String(e) };
	}
	let usd = 0;
	let tokens = 0;
	let malformed = 0;
	let costMissing = 0;
	const lines = text.split("\n");
	for (const line of lines) {
		if (line === "") continue;
		const u = assistantUsage(line);
		usd += u.usd;
		tokens += u.tokens;
		if (u.malformed) malformed++;
		else if (!line.includes('"assistant"') && !parses(line)) malformed++;
		if (u.costMissing) costMissing++;
	}
	const unterminated = lines[lines.length - 1] !== "";
	if (malformed > 0 || costMissing > 0 || unterminated) return { state: "incomplete", file, costMissing, malformed, unterminated, usd, tokens };
	return { state: "read", file, usd, tokens };
}

/** True when `line` is JSON. A session file is JSON lines, so a line that does not parse is torn or corrupt. */
function parses(line: string): boolean {
	try {
		JSON.parse(line);
		return true;
	} catch {
		return false;
	}
}

export interface CostTotals {
	/** Rows with an agent id. */
	hands: number;
	/** Hands whose cost is known; the only ones in `usd`, `tokens` and the per-hand averages. */
	read: number;
	missing: number;
	unreadable: number;
	/** Hands whose file was read but whose cost is unknown (`incomplete`); n/a, never summed. */
	incomplete: number;
	usd: number;
	tokens: number;
}

export interface Cell {
	kind: RoutingKind;
	tier: Tier;
	rows: number;
	review: number;
	build: number;
	outcomes: Record<string, number>;
	models: Record<string, number>;
	pullUps: Record<string, number>;
	pullDowns: Record<string, number>;
	cost: CostTotals;
}

export interface Cohort {
	/** `all`, or `before <iso>` / `after <iso>` for a split. */
	label: string;
	rows: number;
	jev: number;
	codeRows: number;
	changeSmall: number;
	changeLarge: number;
	/** change-small of code rows, 0..1; null with no code rows. */
	changeSmallShare: number | null;
	review: number;
	build: number;
	/** Rows with no agent id (no hand ran). */
	noHand: number;
	judgeModels: Record<string, number>;
	outcomes: Record<string, number>;
	cost: CostTotals;
	/** Non-empty kind × tier cells, in KINDS then TIERS order. */
	cells: Cell[];
	/** headroom-skip entries per selector. */
	headroomSkips: Record<string, number>;
	/** headroom-skip entries whose body names no selector, by entry id. */
	headroomUnparsed: string[];
}

/** One hand's line: its routing, where its cost came from, and the cost (null when n/a: missing, unreadable or incomplete). */
export interface HandLine {
	routingId: string;
	workloadId: string;
	kind: RoutingKind;
	tier: Tier;
	model: string;
	createdAt: string;
	state: "read" | "incomplete" | "missing" | "unreadable";
	file: string;
	usd: number | null;
	tokens: number | null;
	/** For an `incomplete` hand: why its cost is unknown, and the known part (display only); else null. */
	incomplete: IncompleteUsage | null;
	error: string | null;
}

export interface RoutingReport {
	range: { since: string | null; until: string | null; workload: string | null };
	all: Cohort;
	split: { at: string; before: Cohort; after: Cohort } | null;
	/** Every hand (rows with an agent id), oldest first. */
	hands: HandLine[];
}

export interface ReportOptions {
	/** The per-hand reader; `readHandUsage` outside tests. Called once per row. */
	usage: (row: RoutingRow) => HandUsage;
	/** The `headroom-skip:` entries in the same window (other bodies are refused). */
	entries?: readonly EntryRow[];
	/** Split instant in the column's form: rows before it, then rows at or after it. */
	split?: string | null;
	/** The window the rows were read in, echoed in the report. */
	range?: { since?: string | null; until?: string | null; workload?: string | null };
}

/** The model a row ran on: `ran_models[0]`, else `model`, else `(none)`. A `ran_models` that is not a JSON array throws, naming the row. */
export function modelOf(row: Pick<RoutingRow, "id" | "ran_models" | "model">): string {
	if (row.ran_models !== null) {
		let ran: unknown;
		try {
			ran = JSON.parse(row.ran_models);
		} catch (e) {
			throw new Error(`routing ${row.id}: ran_models is not JSON (${e instanceof Error ? e.message : String(e)})`);
		}
		if (!Array.isArray(ran)) throw new Error(`routing ${row.id}: ran_models is not a JSON array`);
		if (typeof ran[0] === "string") return ran[0];
	}
	return row.model ?? "(none)";
}

/** The selector of a `headroom-skip:` body, or null when it names none. */
export function headroomSelector(body: string): string | null {
	if (!body.startsWith(HEADROOM_SKIP_PREFIX)) return null;
	const m = /^(\S+)\s+token\s/.exec(body.slice(HEADROOM_SKIP_PREFIX.length));
	return m ? m[1]! : null;
}

const bump = (m: Record<string, number>, key: string) => {
	m[key] = (m[key] ?? 0) + 1;
};

const zeroCost = (): CostTotals => ({ hands: 0, read: 0, missing: 0, unreadable: 0, incomplete: 0, usd: 0, tokens: 0 });

/** Count one hand; only a hand whose cost is known (`read`) adds to `usd`, `tokens` and `read`. */
function addCost(c: CostTotals, u: HandUsage): void {
	if (u.state === "no-hand") return;
	c.hands++;
	if (u.state === "missing") c.missing++;
	else if (u.state === "unreadable") c.unreadable++;
	else if (u.state === "incomplete") c.incomplete++;
	else {
		c.read++;
		c.usd += u.usd;
		c.tokens += u.tokens;
	}
}

interface Joined {
	row: RoutingRow;
	usage: HandUsage;
	model: string;
	review: boolean;
}

function cohort(label: string, rows: readonly Joined[], entries: readonly EntryRow[]): Cohort {
	const c: Cohort = {
		label, rows: rows.length, jev: 0, codeRows: 0, changeSmall: 0, changeLarge: 0, changeSmallShare: null, review: 0, build: 0, noHand: 0,
		judgeModels: {}, outcomes: {}, cost: zeroCost(), cells: [], headroomSkips: {}, headroomUnparsed: [],
	};
	const cells = new Map<string, Cell>();
	for (const j of rows) {
		const { row } = j;
		if (row.judge_model.startsWith(JEV_PREFIX)) c.jev++;
		if (row.kind === "change-small") c.changeSmall++;
		if (row.kind === "change-large") c.changeLarge++;
		if (j.review) c.review++;
		else c.build++;
		if (j.usage.state === "no-hand") c.noHand++;
		bump(c.judgeModels, row.judge_model);
		bump(c.outcomes, row.outcome);
		addCost(c.cost, j.usage);
		const key = `${row.kind}\u0000${row.tier}`;
		let cell = cells.get(key);
		if (!cell) {
			cell = { kind: row.kind, tier: row.tier, rows: 0, review: 0, build: 0, outcomes: {}, models: {}, pullUps: {}, pullDowns: {}, cost: zeroCost() };
			cells.set(key, cell);
		}
		cell.rows++;
		if (j.review) cell.review++;
		else cell.build++;
		bump(cell.outcomes, row.outcome);
		bump(cell.models, j.model);
		if (row.pull_up_to !== null) bump(cell.pullUps, row.pull_up_to);
		if (row.pull_down_to !== null) bump(cell.pullDowns, row.pull_down_to);
		addCost(cell.cost, j.usage);
	}
	c.codeRows = c.changeSmall + c.changeLarge;
	c.changeSmallShare = c.codeRows === 0 ? null : c.changeSmall / c.codeRows;
	const order = (cell: Cell) => KINDS.indexOf(cell.kind) * TIERS.length + TIERS.indexOf(cell.tier);
	c.cells = [...cells.values()].sort((a, b) => order(a) - order(b));
	for (const e of entries) {
		const selector = headroomSelector(e.body);
		if (selector === null) c.headroomUnparsed.push(e.id);
		else bump(c.headroomSkips, selector);
	}
	return c;
}

/** The report over `rows` (any order; reported oldest first). Throws on an entry that is not a `headroom-skip:` entry. */
export function routingReport(rows: readonly RoutingRow[], opts: ReportOptions): RoutingReport {
	const entries = opts.entries ?? [];
	for (const e of entries) {
		if (!e.body.startsWith(HEADROOM_SKIP_PREFIX)) throw new Error(`routingReport: entry ${e.id} is not a headroom-skip entry`);
	}
	const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
	const joined: Joined[] = sorted.map((row) => ({ row, usage: opts.usage(row), model: modelOf(row), review: isReviewRouting(row) }));
	const hands: HandLine[] = [];
	for (const j of joined) {
		const u = j.usage;
		if (u.state === "no-hand") continue;
		hands.push({
			routingId: j.row.id, workloadId: j.row.workload_id, kind: j.row.kind, tier: j.row.tier, model: j.model, createdAt: j.row.created_at,
			state: u.state, file: u.file,
			usd: u.state === "read" ? u.usd : null, tokens: u.state === "read" ? u.tokens : null,
			incomplete: u.state === "incomplete" ? { costMissing: u.costMissing, malformed: u.malformed, unterminated: u.unterminated, usd: u.usd, tokens: u.tokens } : null,
			error: u.state === "unreadable" ? u.error : null,
		});
	}
	const split = opts.split ?? null;
	const range = { since: opts.range?.since ?? null, until: opts.range?.until ?? null, workload: opts.range?.workload ?? null };
	return {
		range,
		all: cohort("all", joined, entries),
		split: split === null ? null : {
			at: split,
			before: cohort(`before ${split}`, joined.filter((j) => j.row.created_at < split), entries.filter((e) => e.created_at < split)),
			after: cohort(`after ${split}`, joined.filter((j) => j.row.created_at >= split), entries.filter((e) => e.created_at >= split)),
		},
		hands,
	};
}

// ---- text --------------------------------------------------------------------------------------

/** The header line: `<N> rows · jev <J> · change-large <L> of <C> code rows`. */
export function headerLine(c: Cohort): string {
	return `${c.rows} rows · jev ${c.jev} · change-large ${c.changeLarge} of ${c.codeRows} code rows`;
}

/** The n/a count and its reasons: `n/a <N> (session file missing <M>, unreadable <U>, incomplete <I>)`. */
const naText = (c: CostTotals) =>
	`n/a ${c.missing + c.unreadable + c.incomplete} (session file missing ${c.missing}, unreadable ${c.unreadable}, incomplete ${c.incomplete})`;

/** The hands line under the header: how many hands' cost was read, and how many are n/a and why. */
export function handsLine(c: Cohort): string {
	return `hands ${c.cost.hands} · cost read ${c.cost.read} · ${naText(c.cost)} · no hand ${c.noHand}`;
}

const usdText = (usd: number) => usd.toFixed(4);
const counts = (m: Record<string, number>) => {
	const items = Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	return items.length === 0 ? "none" : items.map(([k, n]) => `${k} ${n}`).join(" · ");
};

/** Sums and per-hand averages over the `read` hands only; every n/a hand is counted in `n/a`, never as a zero. */
function costText(c: CostTotals): string {
	const per = c.read === 0 ? "per hand n/a" : `per hand usd ${usdText(c.usd / c.read)} tokens ${Math.round(c.tokens / c.read)}`;
	const sum = c.read === 0 ? "usd n/a · tokens n/a" : `usd ${usdText(c.usd)} · tokens ${c.tokens}`;
	return `${sum} · read ${c.read} of ${c.hands} hands · ${per} · ${naText(c)}`;
}

/** Why an incomplete hand's cost is unknown, then its known part: `1 assistant line(s) without cost, unterminated last line; partial usd 0.2500 tokens 100`. */
function incompleteText(i: IncompleteUsage): string {
	const why = [
		...(i.costMissing > 0 ? [`${i.costMissing} assistant line(s) without cost`] : []),
		...(i.malformed > 0 ? [`${i.malformed} unparsed line(s)`] : []),
		...(i.unterminated ? ["unterminated last line"] : []),
	];
	return `${why.join(", ")}; partial usd ${usdText(i.usd)} tokens ${i.tokens}`;
}

/** Why a hand's cost is n/a, for the per-hand listing. */
function naReason(h: HandLine): string {
	if (h.state === "missing") return "session file missing";
	if (h.state === "unreadable") return `unreadable (${h.error})`;
	if (h.state === "incomplete" && h.incomplete !== null) return `incomplete (${incompleteText(h.incomplete)})`;
	throw new Error(`renderRoutingReport: hand ${h.routingId} is ${h.state}, not an n/a state with its reason`);
}

function cohortLines(c: Cohort): string[] {
	const lines = [
		headerLine(c),
		handsLine(c),
		`change-small ${c.changeSmall} of ${c.codeRows} code rows (${c.changeSmallShare === null ? "n/a" : `${(c.changeSmallShare * 100).toFixed(1)} %`}) · review ${c.review} · build ${c.build}`,
		`cost ${costText(c.cost)}`,
		`judge models: ${counts(c.judgeModels)}`,
		`outcomes: ${counts(c.outcomes)}`,
		"",
		"kind × tier",
	];
	if (c.cells.length === 0) lines.push("  (no rows)");
	for (const cell of c.cells) {
		lines.push(
			`${cell.kind} · ${cell.tier}: ${cell.rows} rows · build ${cell.build} · review ${cell.review}`,
			`  outcomes   ${counts(cell.outcomes)}`,
			`  models     ${counts(cell.models)}`,
			`  pull-ups   ${counts(cell.pullUps)} · pull-downs ${counts(cell.pullDowns)}`,
			`  cost       ${costText(cell.cost)}`,
		);
	}
	const skips = Object.values(c.headroomSkips).reduce((a, b) => a + b, 0) + c.headroomUnparsed.length;
	lines.push("", `headroom-skip entries: ${skips}`);
	for (const [selector, n] of Object.entries(c.headroomSkips).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) lines.push(`  ${selector} ${n}`);
	if (c.headroomUnparsed.length > 0) lines.push(`  no selector in ${c.headroomUnparsed.length}: ${c.headroomUnparsed.join(" ")}`);
	return lines;
}

/** The report as text: the header line first, the cohort's figures, any split's two cohorts, then every n/a hand with its reason and file. */
export function renderRoutingReport(r: RoutingReport): string {
	const lines = cohortLines(r.all);
	lines.splice(2, 0, `window: since ${r.range.since ?? "(start)"} · until ${r.range.until ?? "(now)"} · workload ${r.range.workload ?? "all"}`);
	if (r.split !== null) {
		for (const c of [r.split.before, r.split.after]) lines.push("", `== ${c.label} ==`, ...cohortLines(c));
	}
	const na = r.hands.filter((h) => h.state !== "read");
	if (na.length > 0) {
		lines.push("", `hands with cost n/a: ${na.length}`);
		for (const h of na) lines.push(`  n/a ${h.routingId} ${h.workloadId} ${h.kind}/${h.tier} ${naReason(h)}: ${h.file}`);
	}
	return lines.join("\n");
}
