// Jev ranking's tool, `as2_rank` (PLAN wl-mv8k039gvogt8g § 2 D4), registered on every session — the orchestrator, every
// lane, every hand — and not role-gated: any order of workloads an agent gives Jo or acts on comes from here, never from
// its own judgment. One call: (1) Jo's parameters (`goals`, `first`, `unpin`, orchestrator session only) are checked
// against the unspent input row of his words before anything else, and a refusal writes nothing and asks no judge;
// (2) every open workload without a current signal is asked through the session's judge (`askJudgment`, concurrency 4,
// 30 s each), answers held in memory; (3) one ledger transaction re-checks the input, writes `rank-goals:`, the signal
// and failure rows, the `rank-shown: … by pick` snapshot and the pin change (a ruled list `first: [A, B, …]` writes one
// `rank-override: … pos <k>` per item and unpins every standing pin not in it: PLAN wl-mv8wzytml878b4 D1), then the
// call's own `rank-shown:` from `rankOpen` and the reading entry that spends the input; (4) after a `first` ruling
// commits, `preemptFor` (surface/src/rank-launch.ts, D3) may pause the lowest running lane for a ruled waiter at cap;
// (5) the table is step 3's `rankOpen`, so `first` shows its workload at #1 in the same reply. `fillSignals` is also the
// open-time background ask (surface/extensions/workload.ts). The order itself is computed only in surface/src/rank.ts
// (`rankOpen`, D1); the wake line (surface/src/render.ts) and `as2 rank` (surface/scripts/rank.ts) read the same rows
// without a judge or a write.
import { basename } from "node:path";
import type { KindJudge } from "../../classifier/src/classify";
import { askJudgment, type JudgmentJudge } from "../../classifier/src/judge-ask";
import { gateSession } from "../../gates/src/session";
import type { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../src/identity";
import { inputSpent, joInput, readingBody } from "../src/orchestrator-question";
import { controlEntries, laneCap, priorityPausedOf, priorityPausingOf } from "../src/launch";
import {
	briefHash, currentGoals, formatGoals, formatOverride, formatShown, formatSignal, formatSignalFailed, formatUnpin, goalsHash, goalsProblem, livePins,
	MAX_SIGNAL_FAILURES, RANK_WEIGHTS, rankDay, rankOpen, rankPick, rankQuestions, rankState, readSignal, type RankItem, type RankTermName,
} from "../src/rank";
import { parallelRead, preemptFor, type PreemptResult, type RankConfig, readRankConfig } from "../src/rank-launch";
import { surfaceSession } from "../src/session";
import { type Ctx, DUE_PREFIX, RANK_BY, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY, type ToolResult } from "../src/types";

export const RANK_TOOL = "as2_rank";
/** D4: one ask's limit, the judge's own resolution excluded. */
export const RANK_ASK_TIMEOUT_MS = 30_000;
/** D4: asks in flight at once. */
export const RANK_ASK_CONCURRENCY = 4;
/** D4: rows the table shows by default. */
export const RANK_TOP = 8;

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });

export interface RankDeps {
	/** OMP's `judge` role (surface/index.ts hostJudge); absent: nothing is asked and the table says so. */
	judge?(ctx: Ctx): Promise<KindJudge>;
	/** One ask's limit; RANK_ASK_TIMEOUT_MS unless a test sets it. */
	askTimeoutMs?: number;
}

/** The session's judge as askJudgment takes it, or why there is none. OMP's judge answers any typed question map; KindJudge types only the kind question. */
export async function sessionJudge(deps: RankDeps, ctx: Ctx): Promise<JudgmentJudge | string> {
	if (!deps.judge) return "no judge is wired into this session";
	try {
		return (await deps.judge(ctx)) as unknown as JudgmentJudge;
	} catch (err) {
		return `the judge was unavailable (${String(err).split("\n")[0]})`;
	}
}

export interface FillOptions {
	/** Jo's proposed goal lines: asked against them (and hashed with them) instead of the goals in force. */
	goals?: readonly string[];
	/** Re-ask every item, current signal or not (an item with three failures on its pair stays skipped). */
	refresh?: boolean;
	/** Ask only these workloads (the open-time ask). */
	only?: readonly string[];
	timeoutMs?: number;
	concurrency?: number;
}

/** One ask's outcome, held in memory until the caller writes `body` (stamped RANK_BY) on `workloadId`. */
export interface Filled {
	workloadId: string;
	body: string;
	ok: boolean;
	/** The failure's reason (`timeout …`, `error: …`, `malformed: …`), null on success. */
	reason: string | null;
}

/**
 * D4 step 2: ask Jev about every open workload with no current signal on (its brief, the goals) and fewer than three
 * failed asks on that pair, `concurrency` at a time, each limited to `timeoutMs`. Writes nothing: each outcome comes
 * back as the `priority-signal:` or `priority-signal-failed:` body to write. Jev is asked the seed goals and Jo's lines
 * in force (`currentGoals(…).asked`: none once stale), and the signal is stamped with goalsHash of exactly those.
 */
export async function fillSignals(ledger: Ledger, now: string, judge: JudgmentJudge, o: FillOptions = {}): Promise<Filled[]> {
	const inForce = currentGoals(ledger, now);
	const asked = o.goals ? o.goals.map((g) => g.trim()) : inForce.asked;
	const hash = goalsHash(asked);
	const today = rankDay(now);
	const questions = rankQuestions(asked, today);
	const due: { workloadId: string; brief: string; attempt: number }[] = [];
	for (const item of rankOpen(ledger, now, { pins: false })) {
		if (o.only && !o.only.includes(item.workloadId)) continue;
		const w = ledger.workload(item.workloadId)!;
		const read = readSignal(ledger.entries(w.id, "assumption"), w.brief, hash, now);
		if (read.failed >= MAX_SIGNAL_FAILURES || (read.current && !o.refresh)) continue;
		due.push({ workloadId: w.id, brief: w.brief, attempt: read.failed + 1 });
	}
	const timeoutMs = o.timeoutMs ?? RANK_ASK_TIMEOUT_MS;
	const out: Filled[] = new Array(due.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < due.length) {
			const i = next++;
			const d = due[i]!;
			const r = await askJudgment(judge, rankState(asked, d.brief, today), questions, { timeoutMs });
			const spend = { brief: briefHash(d.brief), goals: hash, tokens: r.tokens ?? null, cost: r.cost };
			out[i] = r.ok
				? { workloadId: d.workloadId, ok: true, reason: null, body: formatSignal({ ...spend, askedOn: today, judge: `${r.provider}/${r.model}`, answers: r.answers }) }
				: { workloadId: d.workloadId, ok: false, reason: r.reason, body: formatSignalFailed({ ...spend, attempt: d.attempt, failure: r.failure }) };
		}
	};
	await Promise.all(Array.from({ length: Math.min(o.concurrency ?? RANK_ASK_CONCURRENCY, due.length) }, worker));
	return out;
}

/**
 * The open-time ask (D4): the new workload's signal, asked in the background and written on its own, as the
 * classifier's pair-signal attempt is. Never throws; the caller does not await it.
 */
export async function askAtOpen(ledger: Ledger, workloadId: string, deps: RankDeps, ctx: Ctx, log: (line: string) => void): Promise<void> {
	try {
		const judge = await sessionJudge(deps, ctx);
		if (typeof judge === "string") return log(`as2_rank: ${workloadId} was not asked at open: ${judge}`);
		const filled = await fillSignals(ledger, ledger.now(), judge, { only: [workloadId], timeoutMs: deps.askTimeoutMs });
		for (const f of filled) {
			if (ledger.workload(f.workloadId)?.status !== "open") continue;
			ledger.recordEntry({ by: RANK_BY, workloadId: f.workloadId, kind: "assumption", body: f.body });
			if (!f.ok) log(`as2_rank: the open-time ask on ${f.workloadId} failed (${f.reason})`);
		}
	} catch (err) {
		log(`as2_rank: the open-time ask on ${workloadId} could not run (${String(err).split("\n")[0]})`);
	}
}

const cell = (n: number): string => n.toFixed(2);
const TERM_HEADS: Record<RankTermName, string> = { goal_max: "goal", unblocks_jo: "unblocks", fixes_breakage: "fixes", urgency: "urgency", cuts_spend: "spend" };

/**
 * One table row: rank, id, mode/state (with `priority-paused for <X>` / `priority-pausing for <X>` from the workload's
 * stop rows, PLAN wl-mv8wzytml878b4 D4), Jo's ruling (`ruled #k`), score, the five terms with `?` marks, flags, title.
 */
function row(ledger: Ledger, n: number, i: RankItem): string {
	const control = controlEntries(ledger.entries(i.workloadId, "assumption"));
	const paused = priorityPausedOf(control);
	const pausing = paused ? null : priorityPausingOf(control);
	const state = `${i.mode}/${i.state}${paused ? `; priority-paused for ${paused.forWl}` : pausing ? `; priority-pausing for ${pausing.forWl}` : ""}`;
	const pin = i.pinned ? `ruled #${i.pinPos} (Jo, ${i.pinned.input})` : "-";
	const score = i.score === undefined ? `unscored (${i.unscored})` : cell(i.score);
	const terms = (Object.keys(RANK_WEIGHTS) as RankTermName[]).map((k) => {
		const t = i.terms?.[k];
		if (!t) return "-";
		return `${cell(t.value)}${t.mark}${k === "urgency" && t.detail.startsWith("due ") ? ` (${t.detail})` : ""}`;
	});
	return [String(n), i.workloadId, state, pin, score, ...terms, i.flags.length > 0 ? i.flags.join(", ") : "-", i.title].join(" · ");
}

/**
 * The table every full view prints (D4 step 4; `as2 rank` without the fill): the top rows in `items`' order, the
 * unscored list with reasons, the goals line, the weights, the parallel read for the top items, and the launch-order
 * line (`show-only: …` only while the mode is show).
 */
export function rankTable(ledger: Ledger, now: string, items: readonly RankItem[], o: { top: number; heading: string; fill: string; config: RankConfig }): string {
	const shown = items.slice(0, o.top);
	const lines = [o.heading, o.fill, "", `# · workload · mode/state · ruled · score · ${(Object.keys(RANK_WEIGHTS) as RankTermName[]).map((k) => TERM_HEADS[k]).join(" · ")} · flags · title`];
	if (items.length === 0) lines.push("no open workload to rank");
	shown.forEach((i, n) => lines.push(row(ledger, n + 1, i)));
	if (items.length > shown.length) lines.push(`(${items.length - shown.length} more not shown; a larger top shows them)`);
	lines.push("");
	const unscored = items.filter((i) => i.score === undefined);
	lines.push(`unscored: ${unscored.length === 0 ? "none" : unscored.map((i) => `${i.workloadId} (${i.unscored})`).join(", ")}`);
	lines.push(currentGoals(ledger, now).line);
	lines.push(`weights: ${(Object.keys(RANK_WEIGHTS) as RankTermName[]).map((k) => `${k} ${RANK_WEIGHTS[k]}`).join(" · ")}`);
	let parallel: string;
	try {
		const read = parallelRead(ledger, now, items, o.config);
		parallel = read.length === 0 ? "none to read" : read.map((p) => `${p.workloadId} ${p.verdict}${p.reason ? ` (${p.reason})` : ""}`).join(" · ");
	} catch (err) {
		parallel = `could not be read (${String(err).split("\n")[0]})`;
	}
	lines.push(`parallel read (what \`parallel\` would do now): ${parallel}`);
	lines.push(o.config.mode === "show" ? "show-only: launch order is unchanged (as2 rank-mode)" : `launch order: ${o.config.mode} (as2 rank-mode)`);
	return lines.join("\n");
}

/** Who ranks (D3 `rank-shown: … by`), on which ledger handle and clock. */
function caller(ctx: Ctx, env: Record<string, string | undefined>): { role: "orchestrator" | "lane" | "hand"; by: string; ledger: Ledger; now: string } {
	const s = surfaceSession(ctx, env);
	if (s.active) return { role: "orchestrator", by: "orchestrator", ledger: s.ledger(), now: s.now() };
	const g = gateSession(ctx, env);
	const ledger = g.ledger();
	if (g.role === "hand") {
		// A hand's agent id is its session file's name (OMP task/executor.ts `<artifactsDir>/<id>.jsonl`), as the classifier reads it.
		const sm: object = ctx.sessionManager;
		const file: unknown = "getSessionFile" in sm && typeof sm.getSessionFile === "function" ? sm.getSessionFile() : null;
		const agent = typeof file === "string" ? basename(file, ".jsonl") : "";
		return { role: "hand", by: `hand:${/^\S+$/.test(agent) ? agent : "unknown"}`, ledger, now: ledger.now() };
	}
	return { role: "lane", by: g.laneId, ledger, now: ledger.now() };
}

class InputSpent extends Error {}

export default function rankRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env, deps: RankDeps = {}): void {
	const z = pi.zod;
	pi.registerTool({
		name: RANK_TOOL,
		loadMode: "essential",
		label: "Rank Open Workloads (Jev)",
		description:
			"The one order of open workloads (Jev ranking): any order of workloads, PRs or next steps you give Jo or act on comes from this tool, never your own judgment. " +
			"Asks Jev about workloads with no current signal first, then returns the table: rank, mode/state (with priority-paused / priority-pausing for <wl>), Jo's ruling (ruled #k), score, each term with ? where Jev was unsure, flags, the unscored list, the goals line, the weights and the parallel read. " +
			"Orchestrator only, each with inputId (the input row of Jo's words): `goals` records Jo's stated priorities (1-6 lines); `first` pins Jo's \"X first\" above every unpinned workload, or, given a list [A, B, C], rules that order (A #1, B #2, C #3) and replaces Jo's previous ruling (pins not in the list are dropped); `unpin` drops that pin. " +
			"After a `first` ruling, a ruled workload waiting at the lane cap may pause the lowest-ranked running lane (launch order `order` only); the reply names the pause. Without an unspent input nothing is written and nothing is asked.",
		parameters: z.object({
			top: z.string().optional().describe(`Rows to show, a number (default ${RANK_TOP}).`),
			refresh: z.string().optional().describe("'yes' to re-ask Jev about every open workload, current signal or not."),
			goals: z.array(z.string()).optional().describe("Orchestrator only: Jo's stated priorities, 1-6 lines, with inputId."),
			first: z.union([z.string(), z.array(z.string())]).optional().describe("Orchestrator only, with inputId: the workload (wl-…) Jo said goes first (a pin), or Jo's ordered list [wl-…, wl-…] (his ruled order, replacing the previous one)."),
			unpin: z.string().optional().describe("Orchestrator only: the workload (wl-…) whose pin Jo dropped, with inputId."),
			inputId: z.string().optional().describe("The input row (in-…) the surface named for Jo's words; required with goals, first or unpin."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const c = caller(ctx, env);
			const { ledger, now } = c;
			const topRaw = Number(params.top);
			const top = Number.isInteger(topRaw) && topRaw > 0 ? topRaw : RANK_TOP;
			const word = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
			const goals: unknown[] | undefined = params.goals === undefined ? undefined : Array.isArray(params.goals) ? params.goals : [params.goals];
			// `first` is one workload (a pin, no pos) or Jo's ruled list (one pin per item with its pos; it replaces his previous ruling).
			const ruled = Array.isArray(params.first);
			const firsts: string[] = Array.isArray(params.first) ? params.first.map(word) : word(params.first) ? [word(params.first)] : [];
			const first = firsts[0] ?? "";
			const unpin = word(params.unpin);
			const inputId = word(params.inputId);
			const jo = goals !== undefined || ruled || first !== "" || unpin !== "";
			const refuse = (why: string) => text(`Refused: ${why}. Nothing was written and Jev was not asked.`);

			// Step 1: Jo's parameters and their receipt, before anything is asked or written.
			let inputSlice: string | null = null;
			if (jo || inputId) {
				if (c.role !== "orchestrator") return refuse(`goals, first and unpin are Jo's words, recorded only by the orchestrator with the input row of them (this session is ${c.by})`);
				if (!jo) return refuse("inputId spends Jo's input on goals, first or unpin, and none was given");
				if ((ruled || first) && unpin) return refuse("one call pins or unpins, not both");
				if (ruled && firsts.length === 0) return refuse("first is an empty list; name the workloads in Jo's order");
				const blank = firsts.indexOf("");
				if (blank !== -1) return refuse(`first's item ${blank + 1} is not a workload id`);
				const twice = firsts.find((wl, k) => firsts.indexOf(wl) !== k);
				if (twice) return refuse(`${twice} is listed twice in first`);
				if (!inputId) return refuse("Jo's words are the input row the surface named (`Jo's words above are input in-…`): pass inputId; with none named there is no receipt");
				const input = joInput(ledger, inputId);
				if (!input) return refuse(`${inputId} is not an input Jo typed at the surface`);
				const spent = inputSpent(ledger, inputId);
				if (spent) return refuse(`${inputId} already ${spent.startsWith("q-") ? "answered" : "instructed"} ${spent}, and one input is recorded once`);
				inputSlice = input.slice_id;
				if (goals !== undefined) {
					const problem = goalsProblem(goals);
					if (problem) return refuse(problem);
				}
				for (const wl of [...firsts, unpin].filter(Boolean)) {
					const w = ledger.workload(wl);
					if (!w) return refuse(`no workload ${wl}`);
					if (w.status !== "open") return refuse(`${wl} is ${w.status}`);
					if (wl === STANDING_WORKLOAD_ID || w.brief.startsWith(DUE_PREFIX)) return refuse(`${wl} is not ranked (the standing workload and scheduled rows never are)`);
				}
				if (unpin && !livePins(ledger).some((p) => p.workloadId === unpin)) return refuse(`${unpin} has no live pin to drop`);
			}
			const proposed = goals?.map((g) => String(g).trim());

			// Step 2: the fill, held in memory.
			const judge = await sessionJudge(deps, ctx);
			const filled = typeof judge === "string" ? [] : await fillSignals(ledger, now, judge, { goals: proposed, refresh: /^(yes|true|1)$/i.test(String(params.refresh ?? "")), timeoutMs: deps.askTimeoutMs });
			const failed = filled.filter((f) => !f.ok);
			const fill = typeof judge === "string"
				? `fill skipped: ${judge}; stored signals only`
				: `fill: asked ${filled.length} (${filled.length - failed.length} answered, ${failed.length} failed${failed.length > 0 ? `: ${failed.map((f) => `${f.workloadId} ${f.reason}`).join("; ")}` : ""})`;

			// Step 3: one transaction.
			let committed: { items: RankItem[]; shown: string; pick: string | null; reading: string | null; dropped: string[] };
			try {
				committed = ledger.write(() => {
					const spentNow = inputId ? inputSpent(ledger, inputId) : null;
					if (spentNow) throw new InputSpent(`${inputId} was spent on ${spentNow} while Jev was asked`);
					ensureStandingWorkload(ledger);
					if (proposed) ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatGoals({ input: inputId, goals: proposed }) });
					for (const f of filled) {
						if (ledger.workload(f.workloadId)?.status === "open") ledger.recordEntry({ by: RANK_BY, workloadId: f.workloadId, kind: "assumption", body: f.body });
					}
					let pick: string | null = null;
					const dropped: string[] = [];
					if (first || unpin) {
						const shownId = ledger.recordEntry({ by: RANK_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatShown({ by: "pick", goals: currentGoals(ledger, now).hash, items: rankPick(ledger, now) }) });
						pick = shownId;
						const bodies: string[] = [];
						if (!ruled) bodies.push(first ? formatOverride({ workloadId: first, input: inputId, shown: shownId }) : formatUnpin({ workloadId: unpin, input: inputId }));
						else {
							// Jo's new ruled list replaces his previous ruling: every standing pin not in it is dropped.
							for (const p of livePins(ledger)) if (!firsts.includes(p.workloadId)) dropped.push(p.workloadId);
							bodies.push(...dropped.map((wl) => formatUnpin({ workloadId: wl, input: inputId })));
							bodies.push(...firsts.map((wl, k) => formatOverride({ workloadId: wl, input: inputId, shown: shownId, pos: k + 1 })));
						}
						for (const body of bodies) ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
					}
					const items = rankOpen(ledger, now);
					const shown = ledger.recordEntry({ by: RANK_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatShown({ by: c.by, goals: currentGoals(ledger, now).hash, items }) });
					let reading: string | null = null;
					if (jo) {
						const said = [
							...(proposed ? [`rank goals: ${proposed.map((g) => `"${g}"`).join(" | ")}`] : []),
							...(ruled ? [`ruled order ${firsts.join(" > ")} (pins #1-#${firsts.length}${dropped.length > 0 ? `; dropped the pins on ${dropped.join(", ")}` : ""})`] : first ? [`${first} first (a pin)`] : []),
							...(unpin ? [`drop the pin on ${unpin}`] : []),
						];
						reading = ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: inputSlice, kind: "assumption", body: readingBody(`as2_rank ${said.join("; ")}`, inputId, first || unpin || STANDING_WORKLOAD_ID) });
					}
					return { items, shown, pick, reading, dropped };
				});
			} catch (err) {
				if (err instanceof InputSpent) return text(`Refused: ${err.message}, and one input is recorded once. Nothing was written; Jev's answers were dropped.`);
				throw err;
			}

			// Step 4: a `first` ruling may pause the lowest running lane for a ruled waiter at cap (D3; writes only in `order`).
			const config = readRankConfig(env);
			let pause: string | null = null;
			let paused: PreemptResult["paused"] = null;
			if (first) {
				try {
					paused = preemptFor(ledger, now, laneCap(env), config, SURFACE_BY).paused;
					if (paused) pause = `priority-pausing ${paused.laneId} on ${paused.workloadId} for ${paused.forWl}`;
				} catch (err) {
					pause = `priority pause could not run (${String(err).split("\n")[0]}); the ruling above is recorded`;
				}
			}

			// Step 5: the table from step 3's order, its marks read now (a pause just written shows as priority-pausing).
			const heading = `Jev rank (${RANK_TOOL}, by ${c.by}, ${now}; rank-shown ${committed.shown}${committed.reading ? `; Jo's input ${inputId} spent, reading ${committed.reading}` : ""})`;
			const table = rankTable(ledger, now, committed.items, { top, heading, fill, config });
			return text(pause ? `${table}\n${pause}` : table, {
				items: committed.items.map((i) => i.workloadId), shown: committed.shown, pick: committed.pick, reading: committed.reading, dropped: committed.dropped, paused,
				asked: filled.length, failed: failed.length,
			});
		},
	});
}
