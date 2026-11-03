// Jev ranking's launch gate (PLAN wl-mv8k039gvogt8g § 2 D7) and Jo's pick snapshot (D6). The profile key `jevRank`
// (raw layer, like `pairSuggest`) is read fresh at each decision: `order` (the default since PLAN wl-mv8wzytml878b4 D2;
// missing or malformed reads as order) admits a workload only when no higher-ranked workload (`rankOpen`, Jo's pins
// first) is launchable now, `show` changes no launch, and `parallel` adds the parallel rule (`parallelVerdict`) while
// any other lane runs. In `order` alone, `preemptFor` (PLAN wl-mv8wzytml878b4 D3) pauses the lowest-ranked running lane
// for a Jo-ruled workload waiting at cap. The intake queue (PLAN wl-mvbcjadqgblr7k D1-D7) is gated in every mode,
// `show` included: a queued workload takes a slot only when no queued workload ranked above it is launchable now
// (`queueGate`), and the drain walks the queue in rank order (`drainCandidates`, `drainPick`).
//
// `rankGate` is composed into the starter's `decideLaunch` (surface/scripts/lane.ts `reserveOrExit`), so it runs inside
// `reserveLane`'s transaction for the drain, the open tool and the wake tick alike; the surface runs it again as its own
// pre-check (surface/extensions/launch.ts). Jo's word is never gated: an unconsumed `launch-requested:` admits at once,
// with cause `request <id>` so the reservation consumes it, and `decideInteractive` never calls the gate.
//
// Every function here reads ledger rows and, for the parallel rule's file check, asks git for a repository's identity.
// Nothing here writes, except `writePickSnapshot`, which its callers run inside their own pick transaction, and
// `preemptFor`, which writes one priority stop in its own transaction.
import { realpathSync } from "node:fs";
import type { Ledger, ReserveRows, ReserveVerdict } from "../../ledger/src/index";
import { type Ceiling, crossed, effectiveCeiling, parseSpend, type Spend } from "./ceiling";
import { repoOf } from "./decision-log";
import { ensureStandingWorkload } from "./identity";
import {
	attempts, boundPrs, causeText, consumedIds, controlEntries, heldLive, holdersOf, laneStopRequestBody, launchRowsFor,
	type LaunchVerdict, PRIORITY_REASON_PREFIX, priorityPausingOf, queuedOf, verdictOf,
} from "./launch";
import { openTrains } from "./merge-train";
import { readPairSuggestConfig } from "./pair-suggest";
import { currentGoals, formatShown, rankOpen, type RankItem, rankPick } from "./rank";
import { parseTestRequested } from "./test-run";
import { DUE_PREFIX, RANK_BY, STANDING_WORKLOAD_ID } from "./types";

// ---- the switch (D7) -----------------------------------------------------------------------------------------------

export const RANK_MODES = ["show", "order", "parallel"] as const;
export type RankMode = (typeof RANK_MODES)[number];
export interface RankConfig {
	mode: RankMode;
	/** `parallel` only: the most the running lanes and the candidate may still spend together; 0 = unknown = no parallel start. */
	parallelBudgetUsd: number;
}
/** The profile key (raw layer). */
export const JEV_RANK_KEY = "jevRank";
export const DEFAULT_RANK_CONFIG: RankConfig = { mode: "order", parallelBudgetUsd: 0 };

const isMode = (x: unknown): x is RankMode => typeof x === "string" && (RANK_MODES as readonly string[]).includes(x);
const isBudget = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/**
 * The `jevRank` block of a parsed profile config. A missing key, a value that is not a mapping, or an unknown mode reads
 * as `order` with budget 0; a valid mode with a missing or malformed budget keeps the mode with budget 0 (unknown).
 */
export function parseRankConfig(config: unknown): RankConfig {
	if (typeof config !== "object" || config === null || Array.isArray(config)) return { ...DEFAULT_RANK_CONFIG };
	const block: unknown = Reflect.get(config, JEV_RANK_KEY);
	if (typeof block !== "object" || block === null || Array.isArray(block)) return { ...DEFAULT_RANK_CONFIG };
	const mode: unknown = Reflect.get(block, "mode");
	if (!isMode(mode)) return { ...DEFAULT_RANK_CONFIG };
	const budget: unknown = Reflect.get(block, "parallelBudgetUsd");
	return { mode, parallelBudgetUsd: isBudget(budget) ? budget : 0 };
}

/** The installed profile's `jevRank`, read fresh at each call where `pairSuggest` is read (`installedConfigPath`). */
export function readRankConfig(env: Record<string, string | undefined> = process.env): RankConfig {
	return parseRankConfig(readPairSuggestConfig(env));
}

// ---- the gate (D7) -------------------------------------------------------------------------------------------------

/** Jo's `launch-requested:` on the workload that no `launch:` attempt names yet (the consumption rule `launchable` uses), or null. */
export function pendingRequest(rows: ReserveRows): string | null {
	const control = controlEntries(rows.entries, holdersOf(rows.entries, rows.workload.holder, rows.holders));
	const consumed = consumedIds(attempts(control));
	return control.find((c) => c.prefix === "launch-requested" && !consumed.has(c.id))?.id ?? null;
}

/**
 * The launch decision with the rank gate applied, over the rows `reserveLane` (or the surface's pre-check) read.
 * A refusal stays a refusal. In every mode the intake queue's gate (`queueGate`, PLAN wl-mvbcjadqgblr7k D5) refuses a
 * queued workload `queued: position <n>` while a queued workload ranked above it is launchable now and not in `tried`
 * (the drain's tried set, which a drain's starter reads from `DRAIN_TRIED_ENV`; every other path passes none); Jo's
 * pending request is never gated (D6). `show`: otherwise `launchable`'s decision unchanged. `order` / `parallel`: a
 * pending Jo request admits at once with cause `request <id>` (even when `launchable` reports `first`, so the
 * reservation consumes it); otherwise the workload is refused `ranked: below <wl>` while a higher-ranked workload is
 * launchable now (`tried` does not change this), and under `parallel` refused `parallel: <reason>` when
 * `parallelVerdict` holds it.
 * A cap-exempt workload (an open merge train, PLAN wl-mvpsrr4tr0p1xc D1) takes no slot, so it is admitted on
 * `launchable`'s verdict alone in every mode, `show` included, before the queue gate, with a pending request promoted to
 * its cause so the reservation consumes it.
 */
export function rankGate(ledger: Ledger, rows: ReserveRows, config: RankConfig, tried: ReadonlySet<string> = NO_IDS): LaunchVerdict {
	const v = verdictOf(rows);
	if (!v.launch) return v;
	if (rows.capExempt) {
		const request = pendingRequest(rows);
		return request !== null ? { launch: true, cause: { kind: "request", id: request } } : v;
	}
	const request = pendingRequest(rows);
	if (config.mode === "show") return request !== null ? v : (queueGate(ledger, rows, config, tried) ?? v);
	if (request !== null) return { launch: true, cause: { kind: "request", id: request } };
	const queued = queueGate(ledger, rows, config, tried);
	if (queued !== null) return queued;
	const above = higherLaunchable(ledger, rows.workload.id, rows.now, rows.cap, config);
	if (above !== null) return { launch: false, reason: `ranked: below ${above}` };
	if (config.mode === "parallel") {
		const p = parallelVerdict(ledger, rows.workload.id, rows.now, config);
		if (p.verdict === "hold") return { launch: false, reason: `parallel: ${p.reason}` };
	}
	return v;
}

/**
 * `rankGate` in `reserveLane`'s verdict shape: what the starter composes into `decideLaunch` (in `show`, `decideLaunch`
 * plus the queue gate; a cap-exempt request promoted). `tried` is the drain's tried set (`readDrainTried`), so the
 * reservation agrees with `drainPick`.
 */
export function decideRanked(ledger: Ledger, rows: ReserveRows, config: RankConfig, tried: ReadonlySet<string> = NO_IDS): ReserveVerdict {
	const v = rankGate(ledger, rows, config, tried);
	return v.launch ? { launch: true, cause: causeText(v.cause) } : v;
}

/**
 * The first workload ranked above `workloadId` that is launchable now (`launchRowsFor` + `verdictOf`), or null. Under
 * `parallel` a higher workload the parallel rule holds does not block the ones below it: the drain tries the next. A
 * cap-exempt workload never blocks one below it: it takes no slot (PLAN wl-mvpsrr4tr0p1xc D1).
 */
function higherLaunchable(ledger: Ledger, workloadId: string, now: string, cap: number, config: RankConfig): string | null {
	for (const item of rankOpen(ledger, now)) {
		if (item.workloadId === workloadId) return null;
		if (item.state === "running" || item.mode !== "autonomous") continue;
		const rows = launchRowsFor(ledger, item.workloadId, cap);
		if (!rows || rows.capExempt || !verdictOf(rows).launch) continue;
		if (config.mode === "parallel" && parallelVerdict(ledger, item.workloadId, now, config).verdict === "hold") continue;
		return item.workloadId;
	}
	return null;
}

/** The order the drain walks in `order` / `parallel` (D7): `rankOpen`'s, pins first. */
export function drainOrder(ledger: Ledger, now: string): string[] {
	return rankOpen(ledger, now).map((i) => i.workloadId);
}

// ---- the intake queue (PLAN wl-mvbcjadqgblr7k D1-D7) -----------------------------------------------------------------

/** The drain's tried set, handed to each starter it runs (`cmdDrain` → `runStarter`): comma-separated workload ids. */
export const DRAIN_TRIED_ENV = "AGENT_SYSTEM_DRAIN_TRIED";
/** A workload id as the ledger and the harnesses mint it (gates/src/scratch.ts's shape: `wl-mv5…`, chaos's `wl-chaos-<run>`). */
const WORKLOAD_ID = /^wl-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_IDS: ReadonlySet<string> = new Set();

/** `DRAIN_TRIED_ENV`'s value for a drain's tried set: its workload ids, comma-separated (anything not a `wl-` id dropped). */
export function formatDrainTried(tried: Iterable<string>): string {
	return [...tried].filter((id) => WORKLOAD_ID.test(id)).join(",");
}

/** The tried set a drain handed this starter (`DRAIN_TRIED_ENV`): the `wl-` ids in it, anything else ignored; empty when unset. */
export function readDrainTried(env: Record<string, string | undefined>): ReadonlySet<string> {
	const raw = env[DRAIN_TRIED_ENV];
	if (!raw) return NO_IDS;
	return new Set(raw.split(",").map((s) => s.trim()).filter((s) => WORKLOAD_ID.test(s)));
}

/** Whether the workload is in the intake queue now (`queuedOf` over its control entries). */
export function isQueued(ledger: Ledger, workloadId: string): boolean {
	return queuedOf(controlEntries(ledger.entries(workloadId, "assumption"))) !== null;
}

/**
 * Started-but-idle workloads (D2), oldest first: open, not the standing workload, not a `due:` row, not queued, with at
 * least one valid `launch:` attempt or at least one slice, and no live holder. The open tool queues an ask while there
 * are more of them than lane slots.
 */
export function startedIdle(ledger: Ledger, now: string): string[] {
	const out: string[] = [];
	for (const { workload: w } of ledger.inFlight()) {
		if (w.id === STANDING_WORKLOAD_ID || w.brief.startsWith(DUE_PREFIX) || heldLive(w, now)) continue;
		const control = controlEntries(ledger.entries(w.id, "assumption"));
		if (queuedOf(control) !== null) continue;
		if (attempts(control).length > 0 || ledger.slices(w.id).length > 0) out.push(w.id);
	}
	return out;
}

/**
 * The intake queue in D4 order: `rankOpen` filtered to queued workloads (Jo's pins, then Jev score, then unscored oldest
 * first). `ranked` is a `rankOpen(ledger, now)` the caller already holds, so one pick ranks once.
 */
export function queueOrder(ledger: Ledger, now: string, ranked: readonly RankItem[] = rankOpen(ledger, now)): RankItem[] {
	return ranked.filter((i) => isQueued(ledger, i.workloadId));
}

/**
 * A queued workload's place (D4): 1 + the queued workloads before it in `queueOrder`, of all queued, with its rank item
 * (score or unscored reason); null when it is not queued.
 */
export function queuePosition(ledger: Ledger, workloadId: string, now: string): { position: number; of: number; item: RankItem } | null {
	const queue = queueOrder(ledger, now);
	const at = queue.findIndex((i) => i.workloadId === workloadId);
	return at === -1 ? null : { position: at + 1, of: queue.length, item: queue[at]! };
}

/**
 * The queue gate (D5, D6, D7), over the rows a launch decision read: null admits, a refusal `queued: position <n>` holds.
 * Only a queued autonomous workload with no pending Jo request is gated; it is refused while a queued autonomous
 * workload ranked above it in `queueOrder` is launchable now (`verdictOf` at `rows.cap`; under `parallel` one the
 * parallel rule holds does not block, as in `higherLaunchable`). A workload in `tried` never blocks: the drain tried it
 * this drain and its starter wrote no `launch:`, so holding the queue behind it would idle a free slot (D5); the drain's
 * pick and its starter's reservation pass the same set, every other caller none. `<n>` is the gated workload's own
 * position. User-driven queued workloads keep a position but never block a slot (D7). `ranked` is a
 * `rankOpen(ledger, rows.now)` the caller already holds (`drainPick`); without it the gate ranks once. Reads only; no write.
 */
export function queueGate(ledger: Ledger, rows: ReserveRows, config: RankConfig, tried: ReadonlySet<string> = NO_IDS, ranked?: readonly RankItem[]): LaunchVerdict | null {
	const w = rows.workload;
	if (w.mode !== "autonomous" || pendingRequest(rows) !== null) return null;
	if (queuedOf(controlEntries(rows.entries, holdersOf(rows.entries, w.holder, rows.holders))) === null) return null;
	const queue = queueOrder(ledger, rows.now, ranked);
	const at = queue.findIndex((i) => i.workloadId === w.id);
	for (const item of queue.slice(0, Math.max(0, at))) {
		if (tried.has(item.workloadId) || item.mode !== "autonomous" || item.state === "running") continue;
		const above = launchRowsFor(ledger, item.workloadId, rows.cap);
		// a cap-exempt workload (an open merge train, PLAN wl-mvpsrr4tr0p1xc D1) takes no slot, so it never holds the queue
		if (!above || above.capExempt || !verdictOf(above).launch) continue;
		if (config.mode === "parallel" && parallelVerdict(ledger, item.workloadId, rows.now, config).verdict === "hold") continue;
		return { launch: false, reason: `queued: position ${at + 1}` };
	}
	return null;
}

/**
 * The drain's candidates this round (D5): oldest first (`inFlight`, the tick's order) in `show`, `drainOrder` in `order` /
 * `parallel`, with the queued workloads put in `queueOrder` into the positions queued workloads occupy, so the queue top
 * is always tried before any queue member below it. `ranked` is a `rankOpen(ledger, now)` the caller already holds.
 */
export function drainCandidates(ledger: Ledger, now: string, config: RankConfig, ranked: readonly RankItem[] = rankOpen(ledger, now)): string[] {
	const base = config.mode === "show" ? ledger.inFlight().map((w) => w.workload.id) : ranked.map((i) => i.workloadId);
	const queue = queueOrder(ledger, now, ranked).map((i) => i.workloadId);
	const queued = new Set(queue);
	let k = 0;
	return base.map((id) => (queued.has(id) && k < queue.length ? queue[k++]! : id));
}

/**
 * The drain's next pick (D5): the first of `drainCandidates` not in `tried` whose predicate says launch and that the
 * queue gate admits with `tried` passed (a tried workload above never holds the queue), or null. `rankOpen` is computed
 * once per pick and shared by the candidates and every gate call. Two free slots therefore go to the top two queued
 * workloads in one drain, and a queue top whose starter wrote no `launch:` does not idle the slot for the ones below.
 */
export function drainPick(ledger: Ledger, tried: ReadonlySet<string>, cap: number, config: RankConfig): string | null {
	const now = ledger.now();
	const ranked = rankOpen(ledger, now);
	return drainCandidates(ledger, now, config, ranked).find((id) => {
		if (tried.has(id)) return false;
		const rows = launchRowsFor(ledger, id, cap);
		return rows !== null && verdictOf(rows).launch && queueGate(ledger, rows, config, tried, ranked) === null;
	}) ?? null;
}

// ---- priority pause (PLAN wl-mv8wzytml878b4 D3) ----------------------------------------------------------------------

export interface PreemptResult {
	/** The lane asked to stop, its workload, and the ruled workload it makes room for; null when nothing was written. */
	paused: { laneId: string; workloadId: string; forWl: string } | null;
	/** One line: what was written, or why nothing was. */
	reason: string;
}

/**
 * Make room at cap for a Jo-ruled workload (D3), in one transaction that reads everything it decides on. Only in mode
 * `order`. `waiting` = the ruled (pinned) autonomous workloads not running whose own `verdictOf` with the cap lifted
 * launches and that the intake queue's gate admits (PLAN wl-mvbcjadqgblr7k D6: a pinned queued workload waits only as
 * the queue's launchable top), in rank order; `pending` = the live lanes whose priority stop is requested and not yet
 * exited (slots on their way). Pauses only for `waiting[pending.length]`: the lowest-ranked workload below it held by a
 * live autonomous `lane-*` with a `lane-ready:` and no `lane-stop:` of any reason, by writing `lane-stop: <L> requested
 * priority-for-<X> by rank` stamped `by`. The runner's stop path does the rest; the drain gives the freed slot to the
 * top-ranked launchable workload.
 */
export function preemptFor(ledger: Ledger, now: string, cap: number, config: RankConfig, by: string): PreemptResult {
	if (config.mode !== "order") return { paused: null, reason: `jevRank mode ${config.mode}: priority pause is off` };
	return ledger.write((): PreemptResult => {
		// only the lanes the cap counts: an open merge train's lane takes no slot and is never paused (PLAN wl-mvpsrr4tr0p1xc D1)
		const live = ledger.liveLaneHolders(now, new Set(openTrains(ledger)));
		if (live.length < cap) return { paused: null, reason: `below cap (${live.length} of ${cap} lanes)` };
		const ranked = rankOpen(ledger, now);
		const waiting = ranked.filter((i) => {
			if (i.pinned === undefined || i.mode !== "autonomous" || i.state === "running") return false;
			const rows = launchRowsFor(ledger, i.workloadId, Infinity);
			return rows !== null && !rows.capExempt && verdictOf(rows).launch && queueGate(ledger, rows, config) === null;
		});
		const pending = live.filter((l) => priorityPausingOf(controlEntries(ledger.entries(l.workloadId, "assumption")))?.laneId === l.holder).length;
		const x = waiting[pending];
		if (x === undefined) {
			return { paused: null, reason: waiting.length === 0 ? "no ruled workload waiting" : `${pending} priority stop(s) already on their way for ${waiting.length} ruled workload(s)` };
		}
		const xAt = ranked.findIndex((i) => i.workloadId === x.workloadId);
		for (let i = ranked.length - 1; i > xAt; i--) {
			const item = ranked[i]!;
			const laneId = live.find((l) => l.workloadId === item.workloadId)?.holder;
			if (laneId === undefined) continue;
			const c = controlEntries(ledger.entries(item.workloadId, "assumption"));
			if (!c.some((e) => e.prefix === "lane-ready" && e.laneId === laneId)) continue;
			if (c.some((e) => e.prefix === "lane-stop" && e.laneId === laneId)) continue;
			ledger.recordEntry({ by, workloadId: item.workloadId, kind: "assumption", body: laneStopRequestBody(laneId, `${PRIORITY_REASON_PREFIX}${x.workloadId}`, "rank") });
			return { paused: { laneId, workloadId: item.workloadId, forWl: x.workloadId }, reason: `priority-pausing ${laneId} on ${item.workloadId} for ${x.workloadId}` };
		}
		return { paused: null, reason: `no running lane ranked below ${x.workloadId} to pause` };
	});
}

// ---- the parallel rule (D7) ----------------------------------------------------------------------------------------

export interface ParallelVerdict {
	verdict: "start" | "hold";
	reason: string;
}

/** Two scores this close leave the merge order unclear (D7). */
export const MERGE_TIE = 0.02;
const GIT_TIMEOUT_MS = 5_000;

/**
 * A repository's canonical identity (D7 files): `realpath` of `git -C <repo> rev-parse --path-format=absolute
 * --git-common-dir`, so every worktree and every spelling of one repository share it; an error string when the
 * workload has no `repo:` row or git cannot resolve it.
 */
export function repoIdentity(ledger: Ledger, workloadId: string): { identity: string } | { error: string } {
	const repo = repoOf(ledger, workloadId);
	if (repo === null) return { error: `${workloadId} records no repository` };
	try {
		const r = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
		const out = r.stdout.toString().trim();
		if (r.exitCode !== 0 || !out) return { error: `${workloadId}'s repository ${repo} does not resolve (git exit ${r.exitCode ?? "killed"})` };
		return { identity: realpathSync(out) };
	} catch (err) {
		return { error: `${workloadId}'s repository ${repo} does not resolve (${err instanceof Error ? err.message : String(err)})` };
	}
}

/** The ceiling now in force and the newest metered `spend:` (the runner's running total; zero when none). */
export function meter(ledger: Ledger, workloadId: string): { ceiling: Ceiling; spend: Spend } {
	const w = ledger.workload(workloadId)!;
	const control = controlEntries(ledger.entries(workloadId, "assumption"));
	const ceiling = effectiveCeiling(control, ledger.instructions(workloadId), w.stakes);
	let spend: Spend = { usd: 0, tokens: 0, wallMin: 0 };
	for (const c of control) {
		const s = c.prefix === "spend" ? parseSpend(c.rest) : null;
		if (s) spend = s;
	}
	return { ceiling, spend };
}

/** The workload's PR numbers: its `test-requested:` runs and Jo's `test-pr:` bindings. */
function prsOf(ledger: Ledger, workloadId: string): number[] {
	const entries = ledger.entries(workloadId, "assumption");
	const out = new Set<number>(boundPrs(entries, ledger.instructions(workloadId)).map((b) => b.pr));
	for (const c of controlEntries(entries)) {
		const t = c.prefix === "test-requested" ? parseTestRequested(c.body) : null;
		if (t) out.add(t.pr);
	}
	return [...out];
}

/** The brief names the workload id or one of its PR numbers (`PR 17`, `PR #17`, `#17`, `pull/17`, `pr://17`). */
function namesIn(brief: string, workloadId: string, prs: readonly number[]): string | null {
	if (new RegExp(`(^|[^a-z0-9-])${workloadId}(?![a-z0-9])`).test(brief)) return workloadId;
	for (const n of prs) if (new RegExp(`(?:\\bPR\\s*#?\\s*|#|\\bpull/|\\bpr://)${n}(?!\\d)`, "i").test(brief)) return `PR ${n} of ${workloadId}`;
	return null;
}

const usd = (x: number): string => `$${Number(x.toFixed(2))}`;

/**
 * Whether `workloadId` may start beside every other `lane-*` holder under a live lease (either mode), D7:
 * - files: a different canonical repository from each of them; equal, missing or unresolvable holds;
 * - budget: the sum of (ceiling − metered spend) over them and the candidate within `parallelBudgetUsd` (0 holds), and
 *   the candidate under 80 % of its ceiling;
 * - merge order: rank order, clear when no two unpinned ones score within `MERGE_TIE` (an unscored one has no order)
 *   and no higher-ranked brief names a lower-ranked one's id or PR.
 * With no other lane running it starts.
 */
export function parallelVerdict(ledger: Ledger, workloadId: string, now: string, config: RankConfig): ParallelVerdict {
	const ranked = rankOpen(ledger, now);
	const running = ranked.filter((i) => i.state === "running" && i.workloadId !== workloadId);
	if (running.length === 0) return { verdict: "start", reason: "no other lane running" };
	const names = running.map((i) => i.workloadId).join(", ");
	if (!(config.parallelBudgetUsd > 0)) return { verdict: "hold", reason: "budget unknown (parallelBudgetUsd 0; set it with as2 rank-mode parallel --budget <usd>)" };

	const mine = repoIdentity(ledger, workloadId);
	if ("error" in mine) return { verdict: "hold", reason: `files: ${mine.error}` };
	for (const r of running) {
		const theirs = repoIdentity(ledger, r.workloadId);
		if ("error" in theirs) return { verdict: "hold", reason: `files: ${theirs.error}` };
		if (theirs.identity === mine.identity) return { verdict: "hold", reason: `files: same repository as ${r.workloadId} (${mine.identity})` };
	}

	const own = meter(ledger, workloadId);
	if (crossed(own.spend, own.ceiling) !== 0) return { verdict: "hold", reason: `budget: ${workloadId} is at or past 80 % of its ${usd(own.ceiling.usd)} ceiling` };
	let left = Math.max(0, own.ceiling.usd - own.spend.usd);
	for (const r of running) {
		const m = meter(ledger, r.workloadId);
		left += Math.max(0, m.ceiling.usd - m.spend.usd);
	}
	if (left > config.parallelBudgetUsd) return { verdict: "hold", reason: `budget: ${usd(left)} left on ${names} and ${workloadId} is over ${usd(config.parallelBudgetUsd)}` };

	const set = ranked.filter((i) => i.workloadId === workloadId || running.includes(i));
	for (let a = 0; a < set.length; a++) {
		for (let b = a + 1; b < set.length; b++) {
			const hi = set[a]!;
			const lo = set[b]!;
			if (!hi.pinned && !lo.pinned) {
				const unscored = [hi, lo].find((i) => i.score === undefined);
				if (unscored) return { verdict: "hold", reason: `merge order: ${unscored.workloadId} is unscored` };
				if (Math.abs(hi.score! - lo.score!) <= MERGE_TIE + 1e-9) return { verdict: "hold", reason: `merge order: ${hi.workloadId} and ${lo.workloadId} score within ${MERGE_TIE}` };
			}
			const named = namesIn(ledger.workload(hi.workloadId)!.brief, lo.workloadId, prsOf(ledger, lo.workloadId));
			if (named !== null) return { verdict: "hold", reason: `merge order: ${hi.workloadId}'s brief names ${named}` };
		}
	}
	return { verdict: "start", reason: `clear of ${names}` };
}

/**
 * The parallel verdict for the top `top` items (default 3) against the lanes running now, for display in every mode
 * (D7: Jo sees what `parallel` would do before saying the word). A running item reads `hold` (`running`).
 */
export function parallelRead(ledger: Ledger, now: string, items: readonly RankItem[], config: RankConfig, top = 3): Array<{ workloadId: string; verdict: "start" | "hold"; reason: string }> {
	return items.slice(0, top).map((i) => i.state === "running"
		? { workloadId: i.workloadId, verdict: "hold" as const, reason: "running" }
		: { workloadId: i.workloadId, ...parallelVerdict(ledger, i.workloadId, now, config) });
}

/**
 * The drain's shadow line in `show` (D7), written after its own pick and before that pick is marked tried: what `order`
 * would have tried first among the workloads not yet tried (`rankOpen` order, the first one `launchable` admits) and
 * its parallel verdict. `rank-shadow <pid> picked <wl> ranked-would <wl|none> parallel <start|hold (<reason>)|->`.
 */
export function rankShadowLine(ledger: Ledger, pid: number, picked: string, tried: ReadonlySet<string>, cap: number, config: RankConfig): string {
	const now = ledger.now();
	const would = drainOrder(ledger, now).find((id) => {
		if (tried.has(id)) return false;
		const rows = launchRowsFor(ledger, id, cap);
		return rows !== null && verdictOf(rows).launch;
	}) ?? null;
	let parallel = "-";
	if (would !== null) {
		const p = parallelVerdict(ledger, would, now, config);
		parallel = p.verdict === "start" ? "start" : `hold (${p.reason})`;
	}
	return `rank-shadow ${pid} picked ${picked} ranked-would ${would ?? "none"} parallel ${parallel}`;
}

// ---- Jo's pick snapshot (D6) ---------------------------------------------------------------------------------------

/**
 * `rank-shown: … by pick` from `rankPick` (the open workloads not running now, Jev order, pins ignored) on the standing
 * workload, as the ranking machinery. Callers run it inside the transaction of their own pick row, before that row.
 */
export function writePickSnapshot(ledger: Ledger, now: string): string {
	return ledger.write(() => {
		ensureStandingWorkload(ledger);
		const body = formatShown({ by: "pick", goals: currentGoals(ledger, now).hash, items: rankPick(ledger, now) });
		return ledger.recordEntry({ by: RANK_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
	});
}
