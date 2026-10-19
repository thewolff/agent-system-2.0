// The lane launcher's pure half (DESIGN-lane-launcher.md § 4, § 5): the reserved control entries
// and who may write each, the launch predicate, the resolutions a parked lane resumes on, the exit
// classification both end-of-lane writers share, and the renderers for the lane's argv, env, first
// prompt and every control-entry body. Nothing here touches the ledger: the callers read rows and
// hand them in, so the predicate is tested as a matrix without OMP (§ 8) and `reserveLane` runs the
// same function inside its transaction (decision 8) through `decideLaunch` / `decideInteractive`.
//
// Control entries are `assumption` entries whose body opens with a reserved prefix. Text inside a
// body is never authority: a reader honours an entry only when its `created_by` is the prefix's
// fixed writer (§ 5) and the body parses. A lane's own writes carry its lane id, so a lane cannot
// forge one, and the lane tools refuse the prefixes outright (surface/extensions/lane-tools.ts).
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	type EntryRow, homeDir, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, type QuestionRow, type ReserveRows, type ReserveVerdict,
	type SliceRow, TEST_RUNNER_BY, type WorkloadRow,
} from "../../ledger/src/index";
import { type CleanShellRead, cleanShellOn } from "../../gates/src/clean-shell";
import { SHELL_START_HOOK_NAMES } from "../../gates/src/shell-start";
import { LANE_ENV, WORKLOAD_ENV } from "../../gates/src/types";
import { SCRATCH_CAP_DEFAULT_MB, SCRATCH_CAP_ENV, SCRATCH_ENV, scratchRootFor } from "../../gates/src/scratch";
import { labOf } from "../../classifier/src/lab";
import {
	ARTIFACT_COMMAND_PREFIX, DUE_PREFIX, LANE_DIED_PREFIX, LANE_FULL_TEST_TOOL, MERGE_TRAIN_BY, RANK_BY, ROLE_ENV, STANDING_WORKLOAD_ID, SURFACE_BY, TRAIN_TASK_FAILED_PREFIX,
} from "./types";
import { type RelaunchRead, relaunchRead } from "./relaunch";

// ---- knobs -------------------------------------------------------------------------------------

/** At most this many autonomous lanes hold workloads at once (decision 8). */
export const LANE_CAP_ENV = "AGENT_SYSTEM_MAX_LANES";
export const DEFAULT_LANE_CAP = 3;
/** OMP's `--max-time` for a lane, a duration OMP parses (decision 12). */
export const LANE_MAX_TIME_ENV = "AGENT_SYSTEM_LANE_MAX_TIME";
export const DEFAULT_LANE_MAX_TIME = "2h";
/** The backstop past the ceiling's remaining wall (DESIGN-workload-ceiling.md § 2 item 4): the runner's own stop fires first. */
export const CEILING_MAX_TIME_MARGIN_MIN = 10;
/** The pre-claim lease: the launch readiness window (decisions 8 and 14). */
export const PRECLAIM_LEASE_MS = 3 * 60_000;
/** The runner's ledger poll for a `lane-stop:` request. */
export const STOP_POLL_MS = 5_000;
/** The holder a `lane_handoff` transfers to (§ B5). */
export const JO_HOLDER = "jo";

export function laneCap(env: Record<string, string | undefined>): number {
	const n = Number(env[LANE_CAP_ENV]);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_LANE_CAP;
}
/** The advisory size cap of a workload's scratch root, in MiB (PLAN wl-mv5oikd5jtquww § 1.5): `AGENT_SYSTEM_SCRATCH_CAP_MB`, else the default. */
export function scratchCapMb(env: Record<string, string | undefined>): number {
	const n = Number(env[SCRATCH_CAP_ENV]);
	return Number.isFinite(n) && n > 0 ? n : SCRATCH_CAP_DEFAULT_MB;
}
export function laneMaxTime(env: Record<string, string | undefined>): string {
	const v = env[LANE_MAX_TIME_ENV]?.trim();
	return v ? v : DEFAULT_LANE_MAX_TIME;
}
/** `--max-time` as OMP parses it (cli/flag-tables.ts:88-104: bare seconds, or `5s` / `10m` / `1h`), in ms; null when OMP would refuse it. */
export function maxTimeMs(spec: string): number | null {
	const m = /^(\d+(?:\.\d+)?)([smh])$/.exec(spec.trim());
	const seconds = m ? Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1) : Number(spec.trim());
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}
/** `--max-time` for a lane under a ceiling: the remaining wall (never below zero) plus the margin, in whole minutes. */
export function ceilingMaxTime(remainingWallMin: number): string {
	return `${Math.max(0, Math.ceil(remainingWallMin)) + CEILING_MAX_TIME_MARGIN_MIN}m`;
}

/** Lane state outside the repo (decision 3): sessions, logs, the system-prompt file, under `~/.agent-system-2/lanes/<wl>/`. */
export function laneDir(workloadId: string, home: string = homeDir()): string {
	return join(home, ".agent-system-2", "lanes", workloadId);
}
/** The worktree beside the checkout: `<parent>/<repo-basename>-lanes/<wl>/` (decision 3). */
export function worktreePath(repo: string, workloadId: string): string {
	return join(dirname(repo), `${basename(repo)}-lanes`, workloadId);
}
export function branchName(workloadId: string): string {
	return `wl/${workloadId}`;
}
/** The lane script the surface execs (`bun <script> launch <wl>`). */
export const LANE_SCRIPT = join(import.meta.dir, "..", "scripts", "lane.ts");

// ---- reserved control prefixes ------------------------------------------------------------------

export const CONTROL_PREFIXES = [
	"launch", "launch-failed", "launch-requested", "lane-started", "lane-ready", "lane-exit", "lane-parked", "lane-stop",
	"lane-decided", "worktree", "branch", "plan", "done", "done-because", "repo", "ceiling", "spend", "artifact-tree",
	"reserved-withdrawn", "ctx-index", "released-open", "plan-question",
	"test-requested", "test-run", "push-dest", "lane-model", "lane-headroom", "superseded", "pair-taken", "test-pr", "waive-pr", "train",
	"train-task", "train-task-settled", "train-fix", "train-alert",
	"scratch-over-cap", "scratch-under-cap", "scratch-disk", "scratch-disk-ok", "scratch-removed", "scratch-remove-failed",
	"priority-signal", "priority-signal-failed", "rank-shown", "rank-goals", "rank-override", "rank-unpin", "rank-audit",
] as const;
export type ControlPrefix = (typeof CONTROL_PREFIXES)[number];

/** Prefixes whose first token after the colon is the lane id the entry is about. */
const LANE_SCOPED: Record<string, true> = {
	launch: true, "launch-failed": true, "lane-started": true, "lane-ready": true, "lane-exit": true, "lane-parked": true, "lane-stop": true,
	"lane-decided": true, spend: true, "ctx-index": true, "released-open": true, "lane-headroom": true,
};
/** The daily scratch sweep's `created_by` (surface/scripts/scratch-sweep.ts). */
export const SCRATCH_SWEEP_BY = "scratch-sweep";
/**
 * Fixed writers per prefix (§ 5). `lane-stop` and `done-because` are refined in `validWriter`. The
 * starter writes `lane-started:` / `lane-exit:` for the interactive lane it runs in Jo's terminal
 * (decision 8) and for the by-hand `lane.ts stop`; the runner writes them for an autonomous lane.
 * `launch-failed:` comes from the starter (a failure before the spawn) and from the runner (a lane
 * that never became ready, or a readiness step that failed; Codex review 2, R4). A lane never writes it.
 * `repo:` is the open tool's record of the repository (decision-log.ts); a lane's note never routes git.
 * `ceiling:` is the surface's alone (open, Jo's words, the lowering tool) and `spend:` the runner's
 * alone (DESIGN-workload-ceiling.md § 2 item 1); the raise-needs-Jo rule lives in `effectiveCeiling`.
 * `artifact-tree:` is reserved so the lane tools refuse it; the lane's own artifact observer writes it
 * (surface/extensions/lane.ts) and `artifactTrees` (signals.ts) reads it, never as a lifecycle line here.
 * `reserved-withdrawn: <entry id>[ <reason>]` is written only by `lane_withdraw_reserved`, as the lane
 * holding the workload (MIGRATION.md item 31); like `done-because:` its writer is a holder (`validWriter`),
 * and `reservedStates` (surface/src/errors.ts) reads it as the request's withdrawal.
 * `ctx-index: <laneId> claimed <pid>` then `ctx-index: <laneId> <outcome> <sessionId|-> <detail>` come from
 * `lane.ts ctx-index` after the lane's exit, as the runner or the starter its `--by` names (MIGRATION.md
 * item 43, surface/src/ctx-index.ts); a lane cannot forge the claim or the outcome.
 * `released-open: <laneId> slices <k>` is written by `lane_release` in the transaction of the release, as
 * the lane it names, when open or paused slices remain and no holder `done-because:` stands (MIGRATION.md
 * item 40, surface/src/turn-end.ts); the lane tools refuse it from `lane_record_entry`, and a reader honours
 * it only from a holder writing about itself (`validWriter`).
 * `lane-decided: <laneId> <outcome>` is the runner's alone: it records an intended decision (`isIntendedOutcome`)
 * before it closes OMP's stdin, so the lane row's shutdown handler reads the end as intended through `exitClass`
 * (MIGRATION.md item 40, decision 14); a death outcome never writes one, its record is its `lane-died:` line (D5).
 * `plan-question: <question id>` is written only by `lane_raise_question`, as the lane holding the
 * workload, in the question's own transaction, when the question offers `approve` on the plan slice
 * while `plan: first` stands (PLAN wl-muq22rnjcfrrpc D9 part two); like `reserved-withdrawn:` its
 * writer is a holder (`validWriter`), and `isPlanQuestionIn` reads it as the plan question's role.
 * `test-requested:` and `test-run:` are the test runner's alone (MIGRATION.md item 24; surface/src/test-run.ts):
 * a lane asks through `lane_full_test`, never by writing either. `push-dest: <remote> <branch> <sha>` is
 * row 8's record of a push it let through, written as the lane holding the workload, so like
 * `done-because:` its writer is a holder (`validWriter`), and the lane tools refuse it as a body; the merge train's
 * `openTrainFix` (MERGE_TRAIN_BY) also writes one on a fix workload it opens, naming the PR's head branch (PLAN wl-mv8s8srodefytc D8).
 * `lane-model: <provider/model|default> by jo at <iso>` is the surface's alone: Jo's `model` on the open or launch tool
 * (MIGRATION.md item 85). It is not lane-scoped; `laneModel` reads the newest, and the runner and `as2 lane` read it at every spawn.
 * `lane-headroom: <laneId> <from> -> <to> (<reason>)` is the runner's alone (PLAN wl-mv71x5rwdu7eo0 § 4, Jo's in-mv8p5m2t005tts and
 * in-mv8qzqym1ihmv4): an unnamed lane whose first `get_state` model was projected out of quota was moved by `set_model` to the
 * strong row's first entry that is not, and OMP confirmed it. It is never Jo's word: `laneModel` reads `lane-model:` only.
 * `superseded: <wl-B> <instruction id>` is the surface's alone: Jo's `supersede <wl-A> <wl-B>` (surface/src/input.ts, PLAN
 * wl-mv5i3lulwwbbi8 D2), on A, naming Jo's instruction written first; `supersededBy` reads it and the close takes it in place of a receipt.
 * `pair-taken: <q> by <answer> mode user-driven` is the surface's alone: Jo's `pair` answer on an offered question
 * (PLAN wl-mv67564rdkfvnk D7, surface/src/pair-suggest.ts), written with the flip in the answer's transaction.
 * `test-pr: <N> [<N> …] <instruction id>` is the surface's alone: Jo's `test-pr <wl-…> <N> [<N> …]` (surface/src/input.ts,
 * PLAN wl-mv5qdfvv82ivwg § 2), on that workload, naming Jo's instruction written first in the same transaction; `boundPrs`
 * reads it and the test runner admits the named PRs for a run with no push (migration/items/test-pr-binds-named-prs.md).
 * `waive-pr: <N> [<N> …] <instruction id>` is the surface's alone too: Jo's `waive-pr <wl-…> <N> [<N> …]` (surface/src/input.ts,
 * PLAN wl-mvfjen3q5mqi2o D3), on that workload, naming Jo's instruction `waive-pr <wl> <N…>` written first in the same transaction;
 * `waivedPrs` reads it for the close check (a MERGED PR nothing covers passes on it). `boundPrs` never reads it: a waiver admits no test run.
 * `train: <N> [<N> …] <instruction id>` is the surface's alone too: Jo's `train <N…>` opening a merge train or `train <wl-…> <N…>`
 * adding to one (surface/src/input.ts, PLAN wl-mv8s8srodefytc § 1), naming Jo's instruction `train <wl> <N…>` written first in the
 * same transaction; `boundPrs` admits its PRs as it does `test-pr:`'s, and surface/src/merge-train.ts reads the train's order from it.
 * The merge train's return path (PLAN wl-mv8s8srodefytc rev 17.1 D6-D8, surface/src/merge-train.ts): `train-task: <tt-…> pr <n> attempt <a>
 * kind <k> head <sha> owner <wl-…|none>` (the detail on the lines after) is `lane_train_return`'s, written as the train lane holding the
 * train (a holder, `validWriter`); `train-task-settled: <tt-…> fixed|failed <evidence>` is the train tick's alone (MERGE_TRAIN_BY), as is
 * a fix workload's `train-fix: repo <owner/repo> pr <n> train <wl> train-entry <en-…>`, which `boundPrs` admits only when that entry is a
 * valid `train:` on that train listing n. The tick also writes a fix workload's `repo:` and `done:` and `launch-requested:` as MERGE_TRAIN_BY.
 * `train-alert: <q> level <n> sending|notified|sent [<url>]` and `train-alert: <q> acked|closed <why>` are the train tick's alone
 * (MERGE_TRAIN_BY, PLAN rev 17.1 D9): its send ladder for an alert question; surface/src/errors.ts reads them for the LOUD line.
 * The scratch lines (PLAN wl-mv5oikd5jtquww § 1.5, gates/src/scratch.ts SCRATCH_ENTRY) are machinery's alone, so a lane cannot
 * hide its own over-cap line with a forged `scratch-under-cap:`: `scratch-over-cap:` / `scratch-under-cap:` are the lane row's
 * turn-end measure, written as the lane holding the workload (a holder, `validWriter`); `scratch-disk:` / `scratch-disk-ok:` the
 * daily sweep's (SCRATCH_SWEEP_BY, on the standing workload); `scratch-removed:` / `scratch-remove-failed:` the close's (the surface).
 * Jev ranking's rows (PLAN wl-mv8k039gvogt8g D3, surface/src/rank.ts): `priority-signal:` / `priority-signal-failed:` (on the
 * ranked workload) and `rank-shown:` (on the standing workload) are the ranking machinery's (RANK_BY), whichever session ranked;
 * `rank-goals:`, `rank-override:`, `rank-unpin:` (Jo's words, bound to an input) and `rank-audit:` (the wake tick) are the surface's.
 */
const WRITERS: Record<ControlPrefix, readonly string[]> = {
	launch: [LANE_STARTER_BY],
	"launch-failed": [LANE_STARTER_BY, LANE_RUNNER_BY],
	worktree: [LANE_STARTER_BY],
	branch: [LANE_STARTER_BY],
	"launch-requested": [SURFACE_BY, MERGE_TRAIN_BY],
	plan: [SURFACE_BY],
	done: [SURFACE_BY, MERGE_TRAIN_BY],
	repo: [SURFACE_BY, MERGE_TRAIN_BY],
	"lane-started": [LANE_RUNNER_BY, LANE_STARTER_BY],
	"lane-ready": [LANE_RUNNER_BY, LANE_STARTER_BY],
	"lane-parked": [LANE_RUNNER_BY],
	"lane-exit": [LANE_RUNNER_BY, LANE_STARTER_BY],
	"lane-stop": [SURFACE_BY, LANE_STARTER_BY, LANE_RUNNER_BY],
	"lane-decided": [LANE_RUNNER_BY],
	"done-because": [],
	ceiling: [SURFACE_BY],
	spend: [LANE_RUNNER_BY],
	"artifact-tree": [],
	"reserved-withdrawn": [],
	"ctx-index": [LANE_RUNNER_BY, LANE_STARTER_BY],
	"released-open": [],
	"plan-question": [],
	"test-requested": [TEST_RUNNER_BY],
	"test-run": [TEST_RUNNER_BY],
	"push-dest": [],
	"lane-model": [SURFACE_BY],
	"lane-headroom": [LANE_RUNNER_BY],
	superseded: [SURFACE_BY],
	"pair-taken": [SURFACE_BY],
	"test-pr": [SURFACE_BY],
	"waive-pr": [SURFACE_BY],
	train: [SURFACE_BY],
	"train-task": [],
	"train-task-settled": [MERGE_TRAIN_BY],
	"train-fix": [MERGE_TRAIN_BY],
	"train-alert": [MERGE_TRAIN_BY],
	"scratch-over-cap": [],
	"scratch-under-cap": [],
	"scratch-disk": [SCRATCH_SWEEP_BY],
	"scratch-disk-ok": [SCRATCH_SWEEP_BY],
	"scratch-removed": [SURFACE_BY],
	"scratch-remove-failed": [SURFACE_BY],
	"priority-signal": [RANK_BY],
	"priority-signal-failed": [RANK_BY],
	"rank-shown": [RANK_BY],
	"rank-goals": [SURFACE_BY],
	"rank-override": [SURFACE_BY],
	"rank-unpin": [SURFACE_BY],
	"rank-audit": [SURFACE_BY],
};

export interface ControlEntry {
	id: string;
	prefix: ControlPrefix;
	/** The lane the entry is about, for lane-scoped prefixes. */
	laneId: string | null;
	/** The body after the prefix (and after the lane id when lane-scoped), trimmed. */
	rest: string;
	createdBy: string;
	createdAt: string;
	body: string;
}

const PREFIXED = /^([a-z-]+):(?:\s+([\s\S]*))?$/;

/** The reserved prefix a body opens with, or null. Used by the lane tools to refuse, not to interpret. */
export function reservedPrefix(body: string): ControlPrefix | null {
	const m = /^([a-z-]+):/.exec(body.trimStart());
	if (!m) return null;
	const p = m[1]!;
	return (CONTROL_PREFIXES as readonly string[]).includes(p) ? (p as ControlPrefix) : null;
}

function validWriter(prefix: ControlPrefix, rest: string, createdBy: string, holders: readonly string[], laneId: string | null): boolean {
	if (prefix === "push-dest" && createdBy === MERGE_TRAIN_BY) return true;
	if (prefix === "done-because" || prefix === "reserved-withdrawn" || prefix === "plan-question" || prefix === "push-dest" || prefix === "train-task" || prefix === "scratch-over-cap" || prefix === "scratch-under-cap") {
		return holders.includes(createdBy);
	}
	if (prefix === "released-open") return laneId === createdBy && holders.includes(createdBy);
	if (prefix === "lane-stop") {
		if (/^accepted\b/.test(rest)) return createdBy === LANE_RUNNER_BY || createdBy === LANE_STARTER_BY;
		if (/^requested\b/.test(rest)) return createdBy === SURFACE_BY || createdBy === LANE_STARTER_BY;
		return false;
	}
	return WRITERS[prefix].includes(createdBy);
}

/**
 * Who may write `done-because:` on a workload (decision 16: the holder): the current holder, every
 * lane a `launch:` attempt named, since the lane that wrote the receipt has released by close, and
 * every holder the ledger's provenance recorded (`Ledger.holders`), so a lane that claimed by hand,
 * with no `launch:` entry, still counts after its release.
 */
export function holdersOf(entries: readonly EntryRow[], current: string | null, recorded: readonly string[] = []): string[] {
	const out: string[] = current ? [current] : [];
	for (const h of recorded) if (!out.includes(h)) out.push(h);
	for (const e of entries) {
		if (e.kind !== "assumption" || e.created_by !== LANE_STARTER_BY) continue;
		const m = /^launch:\s+(lane-\S+)/.exec(e.body);
		if (m && !out.includes(m[1]!)) out.push(m[1]!);
	}
	return out;
}

/**
 * The valid control entries among a workload's entries, oldest first: reserved prefix, the prefix's
 * writer, and a parsable body. `holders` are the writers of `done-because:` (`holdersOf`); omit it
 * when the reader does not care about that prefix. Everything else — a lane note shaped like a
 * control line, a `launch-requested:` from a lane, a `plan: approved` from anyone but the surface —
 * is dropped here, so no reader sees it.
 */
export function controlEntries(entries: readonly EntryRow[], holders: readonly string[] = []): ControlEntry[] {
	const out: ControlEntry[] = [];
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const m = PREFIXED.exec(e.body.trim());
		if (!m || !(CONTROL_PREFIXES as readonly string[]).includes(m[1]!)) continue;
		const prefix = m[1] as ControlPrefix;
		let rest = (m[2] ?? "").trim();
		let laneId: string | null = null;
		if (LANE_SCOPED[prefix]) {
			const lane = /^(lane-\S+)(?:\s+([\s\S]*))?$/.exec(rest);
			if (!lane) continue;
			laneId = lane[1]!;
			rest = (lane[2] ?? "").trim();
		}
		if (!validWriter(prefix, rest, e.created_by, holders, laneId)) continue;
		out.push({ id: e.id, prefix, laneId, rest, createdBy: e.created_by, createdAt: e.created_at, body: e.body });
	}
	return out;
}

// ---- attempts and causes -----------------------------------------------------------------------

/**
 * A launch's cause. `relaunch` is the machinery's relaunch of the dead lane `lane` (PLAN wl-mvfqvd5hy8zv28 § 1.3): `n` is
 * this relaunch's own number, the retry counter as written, and `request` the train's `launch-requested:` it folds in and
 * consumes, when one was pending.
 */
export type Cause =
	| { kind: "first" }
	| { kind: "request"; id: string }
	| { kind: "resume"; ids: string[] }
	| { kind: "relaunch"; lane: string; n: number; request?: string }
	| { kind: "interactive" };

export interface Attempt {
	laneId: string;
	cause: Cause | null;
	requestedBy: string;
	entryId: string;
	createdAt: string;
}

/** `launch: <laneId> cause <kind> [ids…] requested-by <who>`, the body `reserveLane` writes; only its `cause …` part comes from here. */
export function causeText(cause: Cause): string {
	switch (cause.kind) {
		case "first": return "first";
		case "interactive": return "interactive";
		case "request": return `request ${cause.id}`;
		case "resume": return `resume ${cause.ids.join(" ")}`;
		case "relaunch": return `relaunch ${cause.lane} ${cause.n}${cause.request === undefined ? "" : ` ${cause.request}`}`;
	}
}

function parseCause(tokens: string[]): Cause | null {
	const [kind, ...ids] = tokens;
	if (kind === "first" && ids.length === 0) return { kind: "first" };
	if (kind === "interactive" && ids.length === 0) return { kind: "interactive" };
	if (kind === "request" && ids.length === 1) return { kind: "request", id: ids[0]! };
	if (kind === "resume" && ids.length >= 1) return { kind: "resume", ids };
	if (kind === "relaunch" && (ids.length === 2 || ids.length === 3) && /^lane-\S+$/.test(ids[0]!) && /^[1-9]\d*$/.test(ids[1]!)) {
		return ids.length === 3 ? { kind: "relaunch", lane: ids[0]!, n: Number(ids[1]), request: ids[2]! } : { kind: "relaunch", lane: ids[0]!, n: Number(ids[1]) };
	}
	return null;
}

/** Every valid launch attempt on the workload, oldest first. */
export function attempts(control: readonly ControlEntry[]): Attempt[] {
	const out: Attempt[] = [];
	for (const c of control) {
		if (c.prefix !== "launch" || c.laneId === null) continue;
		const m = /^cause\s+(.+?)\s+requested-by\s+(\S+)$/.exec(c.rest);
		if (!m) continue;
		out.push({ laneId: c.laneId, cause: parseCause(m[1]!.split(/\s+/)), requestedBy: m[2]!, entryId: c.id, createdAt: c.createdAt });
	}
	return out;
}

/** The entry and instruction ids some attempt already names (decision 7: a cause is consumed once). */
export function consumedIds(list: readonly Attempt[]): Set<string> {
	const out = new Set<string>();
	for (const a of list) {
		if (a.cause?.kind === "request") out.add(a.cause.id);
		if (a.cause?.kind === "resume") for (const id of a.cause.ids) out.add(id);
		if (a.cause?.kind === "relaunch" && a.cause.request !== undefined) out.add(a.cause.request);
	}
	return out;
}

// ---- resolutions -------------------------------------------------------------------------------

export interface Resolution {
	/** The `answer` or `replan` withdrawal instruction: the id the next attempt consumes. */
	instructionId: string;
	questionId: string;
	/** The lane that raised the question; its recorded session is what the relaunch resumes. */
	laneId: string;
	kind: "answer" | "replan";
	body: string;
	createdAt: string;
}

/**
 * Resolutions (decision 14): an `answer` or `replan` withdrawal on a question a launched lane
 * raised, whose slice it left open. Consumption is the predicate's concern, not this function's.
 */
export function resolutions(
	control: readonly ControlEntry[], questions: readonly QuestionRow[], instructions: readonly InstructionRow[], slices: readonly SliceRow[],
): Resolution[] {
	const launched = new Set(attempts(control).map((a) => a.laneId));
	const out: Resolution[] = [];
	for (const q of questions) {
		if (!launched.has(q.created_by) || q.resolved_by === null) continue;
		const ins = instructions.find((i) => i.id === q.resolved_by);
		if (!ins) continue;
		const kind = ins.kind === "answer" ? "answer" : ins.kind === "withdrawal" && ins.disposition === "replan" ? "replan" : null;
		if (kind === null) continue;
		const slice = slices.find((s) => s.id === q.slice_id);
		if (!slice || slice.state !== "open") continue;
		out.push({ instructionId: ins.id, questionId: q.id, laneId: q.created_by, kind, body: ins.body, createdAt: ins.created_at });
	}
	out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	return out;
}

// ---- Jo's instructions a lane is owed (MIGRATION.md § M7 follow-ups item 14) ---------------------

/**
 * When the lane before `laneId` was launched: the newest `launch:` attempt by another lane, older
 * than `laneId`'s own attempt (every attempt, when `laneId` has none — a lane that claimed by hand).
 * Null when no other lane was ever launched on the workload.
 */
export function previousLaneStart(control: readonly ControlEntry[], laneId: string): string | null {
	const list = attempts(control);
	const own = list.findIndex((a) => a.laneId === laneId);
	const before = own === -1 ? list : list.slice(0, own);
	for (let i = before.length - 1; i >= 0; i--) if (before[i]!.laneId !== laneId) return before[i]!.createdAt;
	return null;
}

/**
 * Every instruction row Jo wrote on the workload since the previous lane started (all of them for
 * the first lane), oldest first: what a lane that launches, relaunches or resumes reads before its
 * first action, and what a running lane is handed as it lands. Jo's words typed into `laneId`'s own
 * session (row 11's direct-channel record) are left out: that session already has them as input.
 */
export function joInstructionsFor(control: readonly ControlEntry[], instructions: readonly InstructionRow[], laneId: string): InstructionRow[] {
	const since = previousLaneStart(control, laneId);
	return instructions.filter((i) =>
		i.author === "jo" && (since === null || i.created_at >= since) && !(i.channel === "direct" && i.created_by === laneId));
}

/** One instruction row as a lane reads it: id, time, channel, kind (when not a plain instruction), the words. */
export function instructionLine(i: InstructionRow): string {
	const kind = i.kind === "instruction" ? "" : `, ${i.kind}${i.question_id ? ` to ${i.question_id}` : ""}`;
	return `- ${i.id} (${i.created_at}, ${i.channel}${kind}): ${oneLine(i.body)}`;
}

// ---- the predicate -----------------------------------------------------------------------------

/**
 * Jev ranking's gate refusals (PLAN wl-mv8k039gvogt8g D7, surface/src/rank-launch.ts): `ranked: below <wl>` when a
 * higher-ranked workload is launchable now, `parallel: <reason>` when the parallel rule holds. `launchable` never returns them.
 */
export type RankRefusal = `ranked: below ${string}` | `parallel: ${string}`;
/**
 * Why `launchable` refuses. The relaunch's (PLAN wl-mvfqvd5hy8zv28 § 1.3): `stopped`, the newest lane was stopped by Jo or
 * the ceiling and no word of Jo's is newer than the stop; `relaunch-exhausted`, its retry budget is spent (the incident's
 * state); `relaunch-backoff`, the next relaunch waits out its gap (`relaunchState` `waiting`).
 */
export type LaunchReason =
	| "closed" | "standing" | "due" | "user-driven" | "held" | "awaiting-close" | "cap" | "died-not-relaunched"
	| "stopped" | "relaunch-exhausted" | "relaunch-backoff" | RankRefusal;
export type LaunchVerdict = { launch: true; cause: Cause } | { launch: false; reason: LaunchReason };

/** A holder under a lease that is null or not yet lapsed at `now`. */
export function heldLive(w: { holder: string | null; holder_lease_until: string | null }, now: string): boolean {
	return w.holder !== null && (w.holder_lease_until === null || w.holder_lease_until >= now);
}

/**
 * The launch predicate (§ 4 pseudocode): plain values in, a cause or a reason out. Run by the
 * surface to decide whether to exec the starter and again by `reserveLane` inside its transaction,
 * the run that binds. `receipt` is the holder's standing `done-because:` (`doneBecause`), or null:
 * a finished workload is awaiting close, not a lane's next launch, unless an unconsumed
 * `launch-requested:` says otherwise (Jo's word to relaunch wins over the tick's close). `relaunch`
 * is the newest attempt's reading (`relaunchRead`, surface/src/relaunch.ts).
 *
 * After `held` and `awaiting-close`, in this order (PLAN wl-mvfqvd5hy8zv28 § 1.3): a stop by Jo or the ceiling on the newest
 * lane refuses every cause but Jo's word written after it (`stopped`); with no word of Jo's pending, a spent retry budget
 * refuses before the cap (`relaunch-exhausted`); the cap; `first`, Jo's request, a resume; the relaunch when due (folding in
 * and consuming a pending machinery request), or `relaunch-backoff` while it waits; a machinery request when the relaunch
 * owes the newest lane nothing (`relaunchState` none: a lane that ended as intended, or one the relaunch does not take on, such
 * as the merge train's, § 1.8); otherwise `died-not-relaunched`.
 */
export function launchable(
	w: WorkloadRow, control: readonly ControlEntry[], receipt: string | null, resolved: readonly Resolution[], now: string, liveLanes: number, cap: number,
	relaunch: RelaunchRead,
): LaunchVerdict {
	if (w.status !== "open") return { launch: false, reason: "closed" };
	if (w.id === STANDING_WORKLOAD_ID) return { launch: false, reason: "standing" };
	if (w.brief.startsWith(DUE_PREFIX)) return { launch: false, reason: "due" };
	if (w.mode !== "autonomous") return { launch: false, reason: "user-driven" };
	if (heldLive(w, now)) return { launch: false, reason: "held" };
	const tried = attempts(control);
	const consumed = consumedIds(tried);
	const requests = control.filter((c) => c.prefix === "launch-requested" && !consumed.has(c.id));
	if (receipt !== null && requests.length === 0) return { launch: false, reason: "awaiting-close" };
	// The veto (§ 1.1 step 2, review r2 F1): while a stop stands, only Jo's word written after it counts.
	const stop = relaunch.end?.kind === "stopped" ? relaunch.end : null;
	const stopAt = stop === null ? -1 : control.findIndex((c) => c.id === stop.entryId);
	const byJo = (c: ControlEntry): boolean => c.createdBy === SURFACE_BY && /^by jo(?:\s|$)/.test(c.rest);
	const joRequest = requests.find((c) => byJo(c) && control.indexOf(c) > stopAt);
	const machineRequest = stop === null ? requests.find((c) => !byJo(c)) : undefined;
	const res = resolved.filter((r) => !consumed.has(r.instructionId) && (stop === null || r.createdAt > stop.createdAt));
	const joPending = joRequest !== undefined || res.length > 0;
	if (stop !== null && !joPending) return { launch: false, reason: "stopped" };
	if (!joPending && relaunch.state.kind === "exhausted") return { launch: false, reason: "relaunch-exhausted" };
	if (liveLanes >= cap) return { launch: false, reason: "cap" };
	if (tried.length === 0) return { launch: true, cause: { kind: "first" } };
	if (joRequest) return { launch: true, cause: { kind: "request", id: joRequest.id } };
	if (res.length > 0) return { launch: true, cause: { kind: "resume", ids: res.map((r) => r.instructionId) } };
	const s = relaunch.state;
	if (s.kind === "due") {
		return { launch: true, cause: machineRequest ? { kind: "relaunch", lane: s.lane, n: s.n, request: machineRequest.id } : { kind: "relaunch", lane: s.lane, n: s.n } };
	}
	if (s.kind === "waiting") return { launch: false, reason: "relaunch-backoff" };
	// Step 7: a machinery request for a lane that is not dead (a train task for a parked or finished lane), or any on the
	// merge-train workload (§ 1.8), launches as a request, as before.
	if (machineRequest && (relaunch.end?.kind !== "died" || relaunch.train)) return { launch: true, cause: { kind: "request", id: machineRequest.id } };
	return { launch: false, reason: "died-not-relaunched" };
}

/** The predicate over the rows a launch decision reads (`Ledger.launchRows`): the surface's run and `reserveLane`'s. */
export function verdictOf(rows: ReserveRows): LaunchVerdict {
	const holders = holdersOf(rows.entries, rows.workload.holder, rows.holders);
	const control = controlEntries(rows.entries, holders);
	const receipt = doneBecause(rows.entries, holders);
	return launchable(
		rows.workload, control, receipt, resolutions(control, rows.questions, rows.instructions, rows.slices), rows.now, rows.liveLanes, rows.cap,
		relaunchRead(rows, { holders, control, receipt }),
	);
}

/** `reserveLane`'s policy for an autonomous launch: the predicate over the rows the transaction read. */
export function decideLaunch(rows: ReserveRows): ReserveVerdict {
	const v = verdictOf(rows);
	return v.launch ? { launch: true, cause: causeText(v.cause) } : v;
}

export type InteractiveReason = "closed" | "standing" | "due" | "autonomous" | "held";

/**
 * The interactive policy (decision 8): Jo's `as2 lane <wl>` is the authority, so the cap and the
 * cause rules do not apply; refused on an autonomous workload and while any holder's lease is live.
 */
export function interactiveVerdict(w: WorkloadRow, now: string): { launch: true } | { launch: false; reason: InteractiveReason } {
	if (w.status !== "open") return { launch: false, reason: "closed" };
	if (w.id === STANDING_WORKLOAD_ID) return { launch: false, reason: "standing" };
	if (w.brief.startsWith(DUE_PREFIX)) return { launch: false, reason: "due" };
	if (w.mode !== "user-driven") return { launch: false, reason: "autonomous" };
	if (heldLive(w, now)) return { launch: false, reason: "held" };
	return { launch: true };
}
export function decideInteractive(rows: ReserveRows): ReserveVerdict {
	const v = interactiveVerdict(rows.workload, rows.now);
	return v.launch ? { launch: true, cause: "interactive" } : v;
}

// ---- exit classification -----------------------------------------------------------------------

/**
 * One classification for both end-of-lane writers (decision 14): the end was intended when the
 * newest valid lifecycle entry about this lane is `lane-parked:`, an accepted `lane-stop:`, or the runner's
 * `lane-decided:` naming an intended outcome (`isIntendedOutcome`; MIGRATION.md item 40).
 * `lane-started:`, `lane-ready:`, `spend:` and `ctx-index:` are metadata, not intent: the runner records the session
 * when OMP reports it, which can land after an accepted stop (Codex review 2, R5), its meter writes `spend:` beside
 * a stop or a park (DESIGN-workload-ceiling.md § 2 item 4), and the ctx index lands after the exit, so they are skipped.
 * A `lane-stop:` request is skipped too: Jo's request is not the lane's end intent, the runner's acceptance is, and
 * a request alone still ends `unintended` because the scan falls through (it stays pending for `pendingStop`).
 */
export function exitClass(control: readonly ControlEntry[], laneId: string): "intended" | "unintended" {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.laneId !== laneId || c.prefix === "lane-started" || c.prefix === "lane-ready" || c.prefix === "spend" || c.prefix === "ctx-index") continue;
		if (c.prefix === "lane-stop" && !/^accepted\b/.test(c.rest)) continue;
		if (c.prefix === "lane-decided") return isIntendedOutcome(c.rest) ? "intended" : "unintended";
		if (c.prefix === "lane-parked" || c.prefix === "lane-stop") return "intended";
		return "unintended";
	}
	return "unintended";
}

// ---- lane-started, stop requests, parked, sessions -----------------------------------------------

export interface LaneStarted {
	pid: number;
	/** The process start time as `startTime(pid)` reports it; `lane.ts stop` compares it before signalling. */
	start: string;
	session: string | null;
	argv: string[];
	runnerPid: number;
	/** The model Jo named (`laneModel`) for this lane's spawn, or null (the profile default; a legacy entry has no field). */
	model?: string | null;
	/** `provider/id` from OMP's `get_state` answer, once it arrived. */
	ranModel?: string | null;
	/** Why the recorded session was not resumed: `<session> ran on <model|default|unknown>` (`resumePlan`). */
	resumeSkipped?: string | null;
}

const stringOrNull = (v: object, key: string): string | null => {
	const x: unknown = Reflect.get(v, key);
	return typeof x === "string" ? x : null;
};

/** The newest `lane-started:` for `laneId` (or for any lane when omitted), parsed. */
export function laneStarted(control: readonly ControlEntry[], laneId?: string): (LaneStarted & { laneId: string; model: string | null; ranModel: string | null; resumeSkipped: string | null }) | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "lane-started" || c.laneId === null || (laneId !== undefined && c.laneId !== laneId)) continue;
		try {
			const v: unknown = JSON.parse(c.rest);
			if (typeof v === "object" && v !== null && "pid" in v && typeof v.pid === "number" && "argv" in v && Array.isArray(v.argv)) {
				const start = "start" in v && typeof v.start === "string" ? v.start : "";
				const session = "session" in v && typeof v.session === "string" ? v.session : null;
				const runnerPid = "runnerPid" in v && typeof v.runnerPid === "number" ? v.runnerPid : 0;
				return {
					laneId: c.laneId, pid: v.pid, start, session, argv: v.argv.map(String), runnerPid,
					model: stringOrNull(v, "model"), ranModel: stringOrNull(v, "ranModel"), resumeSkipped: stringOrNull(v, "resumeSkipped"),
				};
			}
		} catch {
			// an unparsable payload is not a start record
		}
	}
	return null;
}

/**
 * The session a relaunch resumes: the newest session a `lane-started:` or `lane-parked:` recorded on
 * the workload (for `laneId` when given), or null when none was ever recorded. A start record with
 * no session (the runner writes one before OMP answers `get_state`, and a launch that fails before
 * that never writes another) does not hide an earlier session (Codex review B6).
 */
export function resumeSession(control: readonly ControlEntry[], laneId?: string): string | null {
	return sessionOrigin(control, laneId)?.session ?? null;
}

/** `resumeSession` with the lane whose `lane-started:` or `lane-parked:` entry holds the session (its origin lane). */
export function sessionOrigin(control: readonly ControlEntry[], laneId?: string): { session: string; laneId: string } | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.laneId === null || (laneId !== undefined && c.laneId !== laneId)) continue;
		if (c.prefix === "lane-started") {
			const session = laneStarted([c])?.session ?? null;
			if (session !== null) return { session, laneId: c.laneId };
		} else if (c.prefix === "lane-parked") {
			const m = /\ssession\s+(\S+)$/.exec(c.rest);
			if (m) return { session: m[1]!, laneId: c.laneId };
		}
	}
	return null;
}

/**
 * The session the attempt `laneId` resumes (decisions 6, 7, 14) and the lane that recorded it: for a
 * `resume` cause, the newest session of the lane that raised the questions the consumed resolutions
 * answer; for a request, a first launch after a death, or the interactive `as2 lane <wl>`, the newest
 * session on the workload. `resumePlan` decides whether it is resumed.
 */
function resumeOrigin(control: readonly ControlEntry[], laneId: string, resolved: readonly Resolution[]): { session: string; laneId: string } | null {
	const cause = attempts(control).find((a) => a.laneId === laneId)?.cause ?? null;
	if (cause?.kind === "resume") {
		const raised = new Set(resolved.filter((r) => cause.ids.includes(r.instructionId)).map((r) => r.laneId));
		const own = control.filter((c) => c.laneId !== null && raised.has(c.laneId));
		const origin = sessionOrigin(own);
		if (origin !== null) return origin;
	}
	return sessionOrigin(control);
}

/**
 * The session `resumeOrigin` picks, under Jo's named model (MIGRATION.md item 85): resumed only when the
 * model its origin lane ran on equals `model` (null = the profile default on both sides). The origin
 * lane's model is the `model` field of its own newest `lane-started:` (a legacy entry with no field
 * counts as null); an origin lane with no `lane-started:` at all is unknown provenance. Otherwise
 * OMP starts a fresh session in the same session dir and `skipped` says why.
 */
export function resumePlan(
	control: readonly ControlEntry[], laneId: string, resolved: readonly Resolution[], model: string | null,
): { resume: string | null; skipped: string | null } {
	const origin = resumeOrigin(control, laneId, resolved);
	if (origin === null) return { resume: null, skipped: null };
	const started = laneStarted(control, origin.laneId);
	const ran = started === null ? undefined : started.model;
	if (ran === model) return { resume: origin.session, skipped: null };
	return { resume: null, skipped: `${origin.session} ran on ${ran === undefined ? "unknown" : ran ?? "default"}` };
}

/**
 * Jo's named model for the workload's lanes (MIGRATION.md item 85): the newest valid `lane-model:` entry
 * (surface-written, `controlEntries` drops any other writer), as a `provider/model` selector, or null for
 * `default` or no entry. A body that does not parse is skipped.
 */
export function laneModel(control: readonly ControlEntry[]): string | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "lane-model") continue;
		const sel = c.rest.split(/\s+/, 1)[0] ?? "";
		if (sel === "default") return null;
		if (modelProblem(sel) === null) return sel;
	}
	return null;
}

const MODEL_SELECTOR = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Why `value` is not a model Jo can name, or null when it is (MIGRATION.md item 85): an exact `provider/model`
 * (OMP's `--model` fuzzy-matches anything looser), no `:level` suffix (its handling under `--model` is not
 * documented), and a provider `labOf` knows; or the word `default`, which clears a named model.
 */
export function modelProblem(value: string): string | null {
	if (value === "") return "no model was named; name an exact provider/model, e.g. openai-codex/gpt-6-sol (or `default`), or omit `model`";
	if (value === "default") return null;
	if (value.includes(":")) return `\`${value}\` carries a \`:level\` suffix; name the model alone, e.g. openai-codex/gpt-6-sol`;
	if (!MODEL_SELECTOR.test(value)) return `\`${value}\` is not an exact provider/model selector, e.g. openai-codex/gpt-6-sol (or \`default\`)`;
	if (labOf(value) === null) return `\`${value}\` names a provider with no known lab; add it to classifier/src/lab.ts first`;
	return null;
}

/**
 * The named model's check against OMP's first `get_state` answer (MIGRATION.md item 85): `provider/id` of
 * `data.model` must equal `named` exactly (`openai` and `openai-codex` are one lab and two providers). A failed
 * response, a missing or incomplete model, and a mismatch each fail the launch.
 */
export function stateModelCheck(named: string, response: Record<string, unknown>): { ok: true; ran: string } | { ok: false; reason: string } {
	if (response.success === false) return { ok: false, reason: `named ${named}, get_state failed: ${typeof response.error === "string" ? oneLine(response.error) : "no error given"}` };
	const ran = stateModelOf(response);
	if (ran === null) return { ok: false, reason: `named ${named}, get_state reported no provider/id model` };
	return ran === named ? { ok: true, ran } : { ok: false, reason: `named ${named}, omp started ${ran}` };
}

/** `provider/id` of a successful `get_state` response's `data.model`, or null when either is missing. */
export function stateModelOf(response: Record<string, unknown>): string | null {
	const data = response.data;
	if (response.success === false || typeof data !== "object" || data === null) return null;
	const model: unknown = Reflect.get(data, "model");
	if (typeof model !== "object" || model === null) return null;
	const provider: unknown = Reflect.get(model, "provider");
	const id: unknown = Reflect.get(model, "id");
	return typeof provider === "string" && provider && typeof id === "string" && id ? `${provider}/${id}` : null;
}

/**
 * The runner's outcomes (§ 5 pseudocode) plus the interactive lane's: an intended end writes no
 * `lane-died:` whatever the exit code (`released` is the lane's own lane_release / lane_handoff);
 * the rest are deaths. `open-work` is a turn that ended with work open after the continue prompts,
 * or a release that left open slices and no receipt (MIGRATION.md item 40, surface/src/turn-end.ts).
 */
export const LANE_OUTCOMES = ["completed", "parked", "resume-pending", "stop", "released", "interactive", "deadline", "aborted", "error", "open-work", "died", "never-ready"] as const;
export type LaneOutcome = (typeof LANE_OUTCOMES)[number];
export const INTENDED_OUTCOMES: Record<LaneOutcome, boolean> = {
	completed: true, parked: true, "resume-pending": true, stop: true, released: true, interactive: true,
	deadline: false, aborted: false, error: false, "open-work": false, died: false, "never-ready": false,
};
/**
 * Whether `rest` names an intended outcome: a `LANE_OUTCOMES` member whose own `INTENDED_OUTCOMES` value is true,
 * membership first, so `toString`, `__proto__`, `constructor` and an empty rest are never intended.
 */
export function isIntendedOutcome(rest: string): boolean {
	return (LANE_OUTCOMES as readonly string[]).includes(rest) && INTENDED_OUTCOMES[rest as LaneOutcome] === true;
}

export interface StopRequest {
	entryId: string;
	reason: string;
	by: string;
}

/** A valid `lane-stop: <laneId> requested <reason> by <who>` no acceptance names yet, oldest first. */
export function pendingStop(control: readonly ControlEntry[], laneId: string): StopRequest | null {
	const accepted = new Set<string>();
	for (const c of control) {
		if (c.prefix !== "lane-stop" || c.laneId !== laneId) continue;
		const a = /^accepted\s+(\S+)/.exec(c.rest);
		if (a) accepted.add(a[1]!);
	}
	for (const c of control) {
		if (c.prefix !== "lane-stop" || c.laneId !== laneId || accepted.has(c.id)) continue;
		const r = /^requested\s+(\S+)\s+by\s+(\S+)/.exec(c.rest);
		if (r) return { entryId: c.id, reason: r[1]!, by: r[2]! };
	}
	return null;
}

/** The `lane-exit:` for `laneId`, parsed, or null while the lane has not ended. */
export function laneExit(control: readonly ControlEntry[], laneId: string): { code: string; signal: string; outcome: string; reason: string | null } | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "lane-exit" || c.laneId !== laneId) continue;
		const m = /^code\s+(\S+)\s+signal\s+(\S+)\s+outcome\s+(\S+)(?:\s+reason\s+(\S+))?/.exec(c.rest);
		if (m) return { code: m[1]!, signal: m[2]!, outcome: m[3]!, reason: m[4] ?? null };
	}
	return null;
}

/** The `plan: first <trigger>` standing on a workload with no `plan: approved` after it, or null. */
export function planFirst(control: readonly ControlEntry[]): { trigger: string; entryId: string } | null {
	let flag: { trigger: string; entryId: string } | null = null;
	for (const c of control) {
		if (c.prefix !== "plan") continue;
		const first = /^first\s+([\s\S]+)$/.exec(c.rest);
		if (first) flag = { trigger: first[1]!.trim(), entryId: c.id };
		else if (/^approved\b/.test(c.rest)) flag = null;
	}
	return flag;
}

/**
 * The plan slice while `plan: first` stands (decision 15): every slice `lane_add_slice` accepts under
 * the flag is judge-kind, so the first slice still open or paused, in the order given (insertion
 * order, `Ledger.slices`), is the plan slice. A done plan slice hands the role to the next one, as a
 * cancelled one (Jo answered *cancel*) does (PLAN wl-muq22rnjcfrrpc D9). Null when none is active.
 */
export function planSlice(slices: readonly SliceRow[]): SliceRow | null {
	return slices.find((s) => s.state === "open" || s.state === "paused") ?? null;
}

/** The plan question's answers (decision 15): *approve* writes `plan: approved`, *cancel* withdraws, *revise* is an ordinary answer. */
export const PLAN_OPTIONS = ["approve", "revise", "cancel"] as const;

/**
 * Is `q` the plan question (PLAN wl-muq22rnjcfrrpc D8, D9 part two): `plan: first` stands and a
 * holder's `plan-question:` entry names it. The role is recorded when the question is raised, never
 * inferred later, so a question raised before its slice held the plan role never becomes it.
 */
export function isPlanQuestionIn(control: readonly ControlEntry[], q: { id: string }): boolean {
	return planFirst(control) !== null && control.some((c) => c.prefix === "plan-question" && c.rest.split(/\s/)[0] === q.id);
}

/** The longest line a plan question's body may hold (PLAN wl-muq22rnjcfrrpc D7). */
export const PLAN_QUESTION_LINE_MAX = 160;

/**
 * The body of a plan question offering approve, one item per line (D7): the lane tool's refusal and the lane's prompt show it.
 * The `prompt-only:` lines (PLAN wl-mv8vwb04cy18n4 D2) sit between the slice lines and the tradeoff lines and list, for Jo, every
 * requirement the plan file's `## Requirements` section marks prompt-only, or say `prompt-only: none`.
 */
export const PLAN_QUESTION_SHAPE = [
	"<absolute path to the plan file>",
	"- <slice id>: <what it does, one line>   (one line per slice, at least one; the id, the colon and the task are all required)",
	"prompt-only: <R id>: <the requirement, and why no code reaches it, one line>   (one line per prompt-only requirement of the plan file, ids matching its set exactly; or exactly `prompt-only: none` when it has none)",
	"tradeoff: <one line>   (1 to 3 lines)",
	"review: <verdict>, <model>, <absolute path to the verdict file>   (exactly these three fields)",
].join("\n");

/** The kinds an enforcer names in a plan file's requirement line (PLAN wl-mv8vwb04cy18n4 D1). */
export const ENFORCER_KINDS = ["test", "gate", "hook", "code"] as const;

/** The heading line of a plan file's requirements section (PLAN wl-mv8vwb04cy18n4 D1), exactly once in the file. */
export const PLAN_REQUIREMENTS_HEADING = "## Requirements";

/**
 * The plan file's requirements grammar (PLAN wl-mv8vwb04cy18n4 D1, D4: one source): a plan-first lane's first prompt,
 * `lane_raise_question`'s description and its refusal render it.
 */
export const PLAN_REQUIREMENTS_SHAPE = [
	`${PLAN_REQUIREMENTS_HEADING}   (exactly one such line in the plan file; the section runs to the next \`# \` or \`## \` heading, and every non-blank line in it is a requirement line)`,
	"- R<n>: <requirement> => <enforcer>[; <enforcer>]…",
	"- R<n>: <requirement> => prompt-only: <why no code can enforce it, at least two words>",
	`(R ids unique; the split is at the last \` => \`; an enforcer is a kind, ${ENFORCER_KINDS.join(" / ")}, exactly one space and a locator that starts with no whitespace and holds no \`;\`, enforcers separated by \`; \`, none twice; a prompt-only part is exactly \`prompt-only: \` then its reason and is never mixed with enforcers; at least one requirement)`,
].join("\n");

/** The literal start of a prompt-only enforcer part (PLAN wl-mv8vwb04cy18n4 D1): `prompt-only`, a colon and exactly one space. */
const PROMPT_ONLY_PREFIX = "prompt-only: ";

/**
 * PLAN wl-mv8vwb04cy18n4 D1: the plan file's `## Requirements` section read from `text` (CRLF normalized). `problem` names
 * every offender, joined with `; `, or is null when the section holds; `promptOnly` is the prompt-only requirement ids, in file
 * order (meaningful only when `problem` is null). Exactly one line that is exactly PLAN_REQUIREMENTS_HEADING; the section runs
 * to the next `^#{1,2} ` line or the end of the file; every non-blank line in it is a requirement line, PLAN_REQUIREMENTS_SHAPE,
 * and anything else is unparseable. The separators are literal: an enforcer is its kind, exactly one space and a locator whose
 * first character is not whitespace; a part starting with `prompt-only` is the whole part and must start `prompt-only: ` with
 * a reason whose first character is not whitespace. Only trailing whitespace at the end of the line is ignored. Locators are
 * syntax only: nothing here resolves one.
 */
export function requirementsProblem(text: string): { problem: string | null; promptOnly: string[] } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const headings = lines.flatMap((l, i) => (l === PLAN_REQUIREMENTS_HEADING ? [i] : []));
	if (headings.length === 0) return { problem: `the plan file has no \`${PLAN_REQUIREMENTS_HEADING}\` line`, promptOnly: [] };
	if (headings.length > 1) return { problem: `the plan file has ${headings.length} \`${PLAN_REQUIREMENTS_HEADING}\` lines (lines ${headings.map((i) => i + 1).join(", ")}), not exactly one`, promptOnly: [] };
	const problems: string[] = [];
	const promptOnly: string[] = [];
	const seen = new Map<string, number>();
	let count = 0;
	for (let i = headings[0]! + 1; i < lines.length && !/^#{1,2} /.test(lines[i]!); i++) {
		const l = lines[i]!;
		if (l.trim() === "") continue;
		const m = /^- (R\d+): (.*)$/.exec(l);
		if (m === null) {
			problems.push(`plan file line ${i + 1} is not a requirement line: "${l}"`);
			continue;
		}
		count++;
		const id = m[1]!;
		seen.set(id, (seen.get(id) ?? 0) + 1);
		const arrow = m[2]!.lastIndexOf(" => ");
		if (arrow < 0) {
			problems.push(`${id} names no enforcer (no \` => \`)`);
			continue;
		}
		if (m[2]!.slice(0, arrow).trim() === "") problems.push(`${id} states no requirement before \` => \``);
		// Trailing whitespace at the end of the line is ignored; every separator before it is literal (D1).
		const part = m[2]!.slice(arrow + " => ".length).trimEnd();
		if (part === "") {
			problems.push(`${id} names no enforcer after \` => \``);
			continue;
		}
		// D1: a part starting with prompt-only is the whole enforcer part, so its reason may hold `; `; only a locator may not.
		if (part.startsWith("prompt-only")) {
			const reason = part.slice(PROMPT_ONLY_PREFIX.length);
			if (!part.startsWith(PROMPT_ONLY_PREFIX) || /^\s/.test(reason)) {
				problems.push(`${id}'s prompt-only part "${part}" is not \`${PROMPT_ONLY_PREFIX}<reason>\`: \`prompt-only\`, a colon, exactly one space, then the reason`);
			} else if (reason.split(/\s+/).filter(Boolean).length < 2) problems.push(`${id}'s prompt-only reason is under two words`);
			else promptOnly.push(id);
			continue;
		}
		const enforcers = part.split("; ");
		if (enforcers.some((e) => e.trimStart().startsWith("prompt-only"))) {
			problems.push(`${id} mixes prompt-only with enforcers: a requirement with any enforcer is not prompt-only`);
			continue;
		}
		const named = new Set<string>();
		for (const e of enforcers) {
			const kind = /^\S*/.exec(e)![0];
			const rest = e.slice(kind.length);
			const locator = rest.slice(1);
			if (e === "") problems.push(`${id} has an empty enforcer between \`; \` separators`);
			else if (kind === "") problems.push(`${id}'s enforcer "${e}" must be \`<kind> <locator>\`: it starts with whitespace`);
			else if (!(ENFORCER_KINDS as readonly string[]).includes(kind)) problems.push(`${id}'s enforcer "${e}" has kind "${kind}", not one of ${ENFORCER_KINDS.join(", ")}`);
			else if (rest.trim() === "") problems.push(`${id}'s enforcer "${e}" has no locator`);
			else if (!/^ \S/.test(rest)) problems.push(`${id}'s enforcer "${e}" must be \`<kind> <locator>\`: exactly one space between the kind and the locator`);
			else if (locator.includes(";")) problems.push(`${id}'s enforcer "${e}" has \`;\` in its locator (\`; \` separates enforcers)`);
			else if (named.has(`${kind} ${locator}`)) problems.push(`${id} names the enforcer "${kind} ${locator}" twice`);
			named.add(`${kind} ${locator}`);
		}
	}
	for (const [id, n] of seen) if (n > 1) problems.push(`${id} is the id of ${n} requirement lines, not one`);
	if (count === 0 && problems.length === 0) problems.push(`the plan file's \`${PLAN_REQUIREMENTS_HEADING}\` section has no requirement line`);
	return { problem: problems.length > 0 ? problems.join("; ") : null, promptOnly: problems.length > 0 ? [] : promptOnly };
}

const PLAN_LINE_KINDS = ["slice", "prompt-only", "tradeoff", "review"] as const;

/** `prompt-only: none`, the one line a plan question carries when its plan file marks no requirement prompt-only (PLAN wl-mv8vwb04cy18n4 D2). */
export const PROMPT_ONLY_NONE = "prompt-only: none";

/**
 * The most bytes of a plan file `planQuestionProblem` judges (256 KiB). The caller's `readFile` reads at most one byte more,
 * never the whole file, so a lane-supplied path to a huge or growing file costs one bounded read; a plan over it is refused.
 */
export const PLAN_FILE_MAX_BYTES = 262144;

/**
 * D7: what is wrong with a plan question's body, or null when it has PLAN_QUESTION_SHAPE. Line 1 is
 * the absolute path of an existing file; then at least one `- <slice id>: <task>` slice line (an id
 * without spaces or colons, a colon, then nonempty text), the `prompt-only:` lines (PLAN wl-mv8vwb04cy18n4
 * D2: `prompt-only: <R id>: <text>`, or exactly PROMPT_ONLY_NONE), 1 to 3 `tradeoff:` lines and exactly one
 * `review: <verdict>, <model>, <path>` line of exactly three comma-separated fields whose path is
 * absolute and an existing file, in that order and nothing else; every line at most
 * PLAN_QUESTION_LINE_MAX characters. No total cap on the body. A slice id is not matched to a ledger slice and
 * the verdict is not judged. `isFile` and `readFile` are the caller's, so this stays pure: `readFile` returns
 * the plan file's text decoded as UTF-8 from at most PLAN_FILE_MAX_BYTES + 1 bytes of it, or null when it cannot
 * be read. PLAN wl-mv8vwb04cy18n4 D3: the structural problems come first, the first one wins; then an unreadable
 * plan file, or one whose text is over PLAN_FILE_MAX_BYTES bytes (so a longer file, cut at the extra byte, is
 * refused before any of it is parsed); then the plan file's requirements (`requirementsProblem`, every offender
 * named); then the prompt-only ids against the file's (missing, extra and duplicate ids each named), joined with `; `.
 */
export function planQuestionProblem(body: string, isFile: (path: string) => boolean, readFile: (path: string) => string | null): string | null {
	const lines = body.split("\n");
	const long = lines.findIndex((l) => l.length > PLAN_QUESTION_LINE_MAX);
	if (long >= 0) return `line ${long + 1} is ${lines[long]!.length} characters, over ${PLAN_QUESTION_LINE_MAX}`;
	const path = lines[0]!.trim();
	if (!isAbsolute(path) || !isFile(path)) return `line 1 is not the absolute path of an existing plan file: "${path}"`;
	const count = { slice: 0, "prompt-only": 0, tradeoff: 0, review: 0 };
	let rank = 0;
	let review = "";
	const listed: string[] = [];
	let none = 0;
	for (const [i, l] of lines.entries()) {
		if (i === 0) continue;
		if (/^- /.test(l) && !/^- [^\s:]+:\s*\S/.test(l)) return `line ${i + 1} is a slice line without a slice id, a colon and the task: "${l}"`;
		const promptOnly = /^prompt-only: (R\d+):\s*\S/.exec(l);
		if (/^prompt-only:/.test(l) && promptOnly === null && l !== PROMPT_ONLY_NONE) {
			return `line ${i + 1} is a prompt-only line that is neither \`prompt-only: <R id>: <text>\` nor exactly \`${PROMPT_ONLY_NONE}\`: "${l}"`;
		}
		const kind = /^- /.test(l) ? "slice" : /^prompt-only:/.test(l) ? "prompt-only" : /^tradeoff:\s*\S/.test(l) ? "tradeoff" : /^review:/.test(l) ? "review" : null;
		if (kind === null) return `line ${i + 1} is none of the line kinds: "${l}"`;
		if (PLAN_LINE_KINDS.indexOf(kind) < rank) return `line ${i + 1} (${kind}) is out of order: slice lines, then prompt-only lines, then tradeoff lines, then the review line`;
		rank = PLAN_LINE_KINDS.indexOf(kind);
		count[kind]++;
		if (kind === "review") review = l;
		if (promptOnly !== null) listed.push(promptOnly[1]!);
		else if (l === PROMPT_ONLY_NONE) none++;
	}
	if (count.slice === 0) return "it has no `- <slice id>: <what it does>` line";
	if (count.tradeoff < 1 || count.tradeoff > 3) return `it has ${count.tradeoff} \`tradeoff:\` lines, not 1 to 3`;
	if (count.review !== 1) return `it has ${count.review} \`review:\` lines, not exactly one`;
	const parts = review.slice("review:".length).split(",").map((p) => p.trim());
	const verdictFile = parts.at(-1) ?? "";
	if (parts.length !== 3 || parts.some((p) => p === "")) return `the review line has ${parts.length} comma-separated fields, not exactly three: a verdict, a model and the verdict file`;
	if (!isAbsolute(verdictFile) || !isFile(verdictFile)) return `the review line's verdict file is not the absolute path of an existing file: "${verdictFile}"`;
	// PLAN wl-mv8vwb04cy18n4 D1: the plan file's requirements, read once here at raise time.
	const text = readFile(path);
	if (text === null) return `the plan file could not be read: "${path}"`;
	if (Buffer.byteLength(text, "utf8") > PLAN_FILE_MAX_BYTES) return `the plan file is over ${PLAN_FILE_MAX_BYTES} bytes`;
	const req = requirementsProblem(text);
	if (req.problem !== null) return req.problem;
	// D2: the body's prompt-only ids equal the file's exactly, or the body is exactly PROMPT_ONLY_NONE when the file has none.
	const want = new Set(req.promptOnly);
	const problems: string[] = [];
	if (none > 0 && listed.length > 0) problems.push(`it mixes \`${PROMPT_ONLY_NONE}\` with prompt-only items`);
	if (none > 1) problems.push(`it has ${none} \`${PROMPT_ONLY_NONE}\` lines, not one`);
	const missing = req.promptOnly.filter((id) => !listed.includes(id));
	if (want.size === 0 && none === 0 && listed.length === 0) problems.push(`it has no prompt-only line: the plan file marks no requirement prompt-only, so the body carries exactly \`${PROMPT_ONLY_NONE}\``);
	else if (missing.length > 0 && none > 0 && listed.length === 0) problems.push(`it says \`${PROMPT_ONLY_NONE}\`, but the plan file marks ${missing.join(", ")} prompt-only`);
	else if (missing.length > 0) problems.push(`it has no prompt-only line for ${missing.join(", ")}, which the plan file marks prompt-only`);
	const extra = [...new Set(listed.filter((id) => !want.has(id)))];
	if (extra.length > 0) problems.push(`it has a prompt-only line for ${extra.join(", ")}, which the plan file does not mark prompt-only`);
	const twice = [...new Set(listed.filter((id, i) => listed.indexOf(id) !== i))];
	if (twice.length > 0) problems.push(`it has more than one prompt-only line for ${twice.join(", ")}`);
	return problems.length > 0 ? problems.join("; ") : null;
}

/** The newest `done:` line on a workload, or null. */
export function doneLine(control: readonly ControlEntry[]): string | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix === "done") return c.rest;
	}
	return null;
}

/**
 * The bodies the classifier records as `assumption` entries stamped with the lane id (classifier/extension.ts: a hand's
 * spawn and settle, its review round, group and park, a same-lab spend or Jo's Kimi-out rule (classifier/src/lab.ts
 * KIMI_OUT_RULE), the loop's end and limit, builder labs, provider refusals; a lost hand's settle is stamped
 * `classifier`, CLASSIFIER_BY). They are machinery, not the lane's word, so they never supersede a `done-because:`
 * (`doneBecause`), and `lane_record_entry` refuses a body opening with any of them (surface/extensions/lane-tools.ts,
 * PLAN wl-mv64rsqw2fcs1s D5). A closed list: any other line, prefixed or not, still does. The pair
 * trigger's `pair-signal:` / `pair-signal-failed:` (the classifier's jev attempt), `pair-exposure:` (the lane's
 * classifier reading the switch on) and `pair-offer:` (stamped by the classifier at the round limit, by the lane runner
 * at the ceiling) are listed here so no lane can forge them (PLAN wl-mv67564rdkfvnk D9, surface/src/pair-suggest.ts).
 * `headroom-skip: <selector> token <dt> <reason>` is the classifier's record of a tier-row entry it skipped as projected out of
 * quota (PLAN wl-mv71x5rwdu7eo0 § 3, classifier/src/headroom.ts), written beside `provider-refused:`.
 */
export const CLASSIFIER_MACHINERY_PREFIXES = [
	"hand-spawn", "hand-settled", "review-round", "review-group", "review-withheld", "review-park", "review-same-lab", "review-same-lab-rule", "review-limit",
	"review-loop-end", "builder-lab", "provider-refused", "headroom-skip", "pair-signal", "pair-signal-failed", "pair-offer", "pair-exposure",
] as const;

/**
 * The holder's `done-because:` receipt (decision 16): the workload's newest `assumption` entry by a
 * holder (`holdersOf`) or the surface, machinery lifecycle lines, the classifier's machinery lines
 * (`CLASSIFIER_MACHINERY_PREFIXES`) and the `repo:` / artifact records excluded, must be a
 * `done-because:` written by a holder. A later ordinary note by the lane or the surface ("acceptance
 * is no longer met") supersedes an older receipt: null then.
 */
export function doneBecause(entries: readonly EntryRow[], holders: readonly string[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.kind !== "assumption") continue;
		const holder = holders.includes(e.created_by);
		if (!holder && e.created_by !== SURFACE_BY) continue;
		const body = e.body.trim();
		if (body.startsWith(ARTIFACT_COMMAND_PREFIX)) continue;
		const word = /^([a-z-]+):/.exec(body)?.[1];
		if (word !== undefined && (CLASSIFIER_MACHINERY_PREFIXES as readonly string[]).includes(word)) continue;
		const prefix = reservedPrefix(body);
		if (prefix !== null && prefix !== "done-because") continue;
		if (prefix === "done-because" && holder) return body.slice(DONE_BECAUSE_PREFIX.length).trim();
		return null;
	}
	return null;
}

/** Jo's words for `supersede <wl-A> <wl-B>` (PLAN wl-mv5i3lulwwbbi8 D2): the instruction body on A that `superseded:` names. */
export function supersedeInstructionBody(workloadId: string, by: string): string {
	return `supersede ${workloadId} ${by}`;
}
/** `superseded: <wl-B> <instruction id>`: the surface's record on A, written after Jo's instruction in one transaction. */
export function supersededBody(by: string, instructionId: string): string {
	return `superseded: ${by} ${instructionId}`;
}

/**
 * Jo's standing word that this workload (A) is superseded by another (D2), or null: the newest
 * `superseded: <wl-B> <instruction id>` the surface wrote (`controlEntries` drops every other writer)
 * whose instruction is among `instructions`, on A, authored by jo and written by the surface, with
 * the body `supersede <A> <B>`. Pass A's entries and A's instructions. A lane cannot write either
 * row as the surface, so neither half can be forged; an entry naming any other instruction counts for nothing.
 */
export function supersededBy(entries: readonly EntryRow[], instructions: readonly InstructionRow[]): { by: string; instructionId: string } | null {
	const control = controlEntries(entries);
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "superseded") continue;
		const m = /^(wl-\S+)\s+(\S+)$/.exec(c.rest);
		const on = entries.find((e) => e.id === c.id)?.workload_id;
		if (!m || on === undefined) continue;
		const ins = instructions.find((x) => x.id === m[2]);
		if (ins && ins.workload_id === on && ins.kind === "instruction" && ins.author === "jo" && ins.created_by === SURFACE_BY && ins.body === supersedeInstructionBody(on, m[1]!)) {
			return { by: m[1]!, instructionId: ins.id };
		}
	}
	return null;
}

/**
 * The words Jo types to bind PRs to a workload: `test-pr` (a test run with no push), `train` (a merge train,
 * surface/src/merge-train.ts) and `waive-pr` (a merged PR the close check passes with no covering green, PLAN wl-mvfjen3q5mqi2o D3).
 */
export type PrBindingWord = "test-pr" | "train" | "waive-pr";
/** Jo's instruction body for a PR binding: `<word> <wl> <N…>`, the body its control entry names. */
export function prBindingInstructionBody(word: PrBindingWord, workloadId: string, prs: readonly number[]): string {
	return `${word} ${workloadId} ${prs.join(" ")}`;
}
/** Jo's words for `test-pr <wl-…> <N> [<N> …]` (PLAN wl-mv5qdfvv82ivwg § 2.1): the instruction body that `test-pr:` names. */
export function testPrInstructionBody(workloadId: string, prs: readonly number[]): string {
	return prBindingInstructionBody("test-pr", workloadId, prs);
}
/** `test-pr: <N> [<N> …] <instruction id>`: the surface's record on the workload, written after Jo's instruction in one transaction. */
export function testPrBody(prs: readonly number[], instructionId: string): string {
	return `test-pr: ${prs.join(" ")} ${instructionId}`;
}
/** Jo's words for `waive-pr <wl-…> <N> [<N> …]` (PLAN wl-mvfjen3q5mqi2o D3): the instruction body that `waive-pr:` names. */
export function waivePrInstructionBody(workloadId: string, prs: readonly number[]): string {
	return prBindingInstructionBody("waive-pr", workloadId, prs);
}
/** `waive-pr: <N> [<N> …] <instruction id>`: the surface's record on the workload, written after Jo's instruction in one transaction. */
export function waivePrBody(prs: readonly number[], instructionId: string): string {
	return `waive-pr: ${prs.join(" ")} ${instructionId}`;
}

/** One valid binding entry: the PR numbers in Jo's order, Jo's instruction it names, and the entry itself. */
export interface PrBinding {
	word: PrBindingWord;
	prs: number[];
	instructionId: string;
	entryId: string;
	createdAt: string;
}

/**
 * Every valid `<word>: <N…> <instruction id>` entry among `words`, oldest first: written by the surface
 * (`controlEntries` drops every other writer) and naming an instruction among `instructions` that is on the
 * entry's workload, kind `instruction`, authored by jo and written by the surface, with the body exactly
 * `<word> <wl> <the entry's numbers>` (`prBindingInstructionBody`). An entry naming any other instruction,
 * or one whose numbers differ from it, is no binding. Pass the workload's entries and its instructions.
 */
export function prBindings(entries: readonly EntryRow[], instructions: readonly InstructionRow[], words: readonly PrBindingWord[]): PrBinding[] {
	const out: PrBinding[] = [];
	for (const c of controlEntries(entries)) {
		if (c.prefix !== "test-pr" && c.prefix !== "train" && c.prefix !== "waive-pr") continue;
		const word: PrBindingWord = c.prefix;
		if (!words.includes(word)) continue;
		const tokens = c.rest.split(/\s+/);
		const instructionId = tokens.pop();
		const on = entries.find((e) => e.id === c.id)?.workload_id;
		if (instructionId === undefined || on === undefined || tokens.length === 0 || !tokens.every((t) => /^[1-9]\d*$/.test(t))) continue;
		const prs = tokens.map(Number);
		const ins = instructions.find((x) => x.id === instructionId);
		if (!ins || ins.workload_id !== on || ins.kind !== "instruction" || ins.author !== "jo" || ins.created_by !== SURFACE_BY || ins.body !== prBindingInstructionBody(word, on, prs)) continue;
		out.push({ word, prs, instructionId, entryId: c.id, createdAt: c.createdAt });
	}
	return out;
}

/** A fix workload's binding (PLAN wl-mv8s8srodefytc rev 17.1 D8): the train's repository, the PR, the train and the `train:` entry listing it. */
export interface TrainFix {
	repo: string;
	pr: number;
	train: string;
	trainEntry: string;
}
/** `train-fix: repo <owner/repo> pr <n> train <wl> train-entry <en-…>`, written by the train tick (`openTrainFix`) on the fix workload it opens. */
export function trainFixBody(f: TrainFix): string {
	return `train-fix: repo ${f.repo} pr ${f.pr} train ${f.train} train-entry ${f.trainEntry}`;
}
const TRAIN_FIX_RE = /^repo ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) pr ([1-9]\d*) train (wl-[a-z0-9-]+) train-entry (en-[a-z0-9]+)$/;
/** A valid `train-fix:` entry's rest, parsed; null when it is not that shape. */
export function parseTrainFix(rest: string): TrainFix | null {
	const m = TRAIN_FIX_RE.exec(rest);
	return m ? { repo: m[1]!, pr: Number(m[2]), train: m[3]!, trainEntry: m[4]! } : null;
}

/**
 * The PR numbers Jo bound to this workload for a run with no push (PLAN wl-mv5qdfvv82ivwg § 2.2), each
 * with the instruction that binds it: every valid `test-pr:` binding and, on a merge train (PLAN
 * wl-mv8s8srodefytc § 1), every valid `train:` binding (`prBindings`). Bindings accumulate, oldest first;
 * a number bound twice keeps its first instruction. Pass the workload's entries and its instructions.
 * With `trains` (the ledger), a fix workload's `train-fix:` binds its PR too (rev 17.1 D8), but only when the entry it names is a
 * valid `train:` binding on that train listing the PR; it carries that entry's instruction, Jo's own `train` word.
 */
export function boundPrs(
	entries: readonly EntryRow[], instructions: readonly InstructionRow[], trains?: { entries(id: string): EntryRow[]; instructions(id: string): InstructionRow[] },
): { pr: number; instructionId: string }[] {
	const out: { pr: number; instructionId: string }[] = [];
	for (const b of prBindings(entries, instructions, ["test-pr", "train"])) {
		for (const pr of b.prs) if (!out.some((x) => x.pr === pr)) out.push({ pr, instructionId: b.instructionId });
	}
	if (trains === undefined) return out;
	for (const c of controlEntries(entries)) {
		const f = c.prefix === "train-fix" ? parseTrainFix(c.rest) : null;
		if (f === null || out.some((x) => x.pr === f.pr)) continue;
		const b = prBindings(trains.entries(f.train), trains.instructions(f.train), ["train"]).find((x) => x.entryId === f.trainEntry);
		if (b?.prs.includes(f.pr)) out.push({ pr: f.pr, instructionId: b.instructionId });
	}
	return out;
}

/**
 * The PR numbers Jo waived on this workload for the close check (PLAN wl-mvfjen3q5mqi2o D3), each with the instruction that
 * waives it: every valid `waive-pr:` binding (`prBindings`), oldest first; a number waived twice keeps its first instruction.
 * The close check applies a waiver only to a PR gh reports MERGED. Never part of `boundPrs`: a waiver admits no test run.
 */
export function waivedPrs(entries: readonly EntryRow[], instructions: readonly InstructionRow[]): { pr: number; instructionId: string }[] {
	const out: { pr: number; instructionId: string }[] = [];
	for (const b of prBindings(entries, instructions, ["waive-pr"])) {
		for (const pr of b.prs) if (!out.some((x) => x.pr === pr)) out.push({ pr, instructionId: b.instructionId });
	}
	return out;
}

// ---- entry and message bodies -------------------------------------------------------------------

export function launchRequestedBody(who: string, at: string, reason?: string): string {
	return `launch-requested: by ${who} at ${at}${reason ? ` (${reason})` : ""}`;
}
/** `lane-model: <provider/model|default> by jo at <iso>`: Jo's named model for the workload's lanes (MIGRATION.md item 85). */
export function laneModelBody(selector: string, at: string): string {
	return `lane-model: ${selector} by jo at ${at}`;
}
/** `lane-headroom: <laneId> <from> -> <to> (<reason>)`: the runner moved an unnamed lane off a lab projected out (PLAN wl-mv71x5rwdu7eo0 § 4). */
export function laneHeadroomBody(laneId: string, from: string, to: string, reason: string): string {
	return `lane-headroom: ${laneId} ${from} -> ${to} (${oneLine(reason)})`;
}
export function launchFailedBody(laneId: string, stage: string, reason: string): string {
	return `launch-failed: ${laneId} ${stage}: ${oneLine(reason)}`;
}
export function laneStartedBody(laneId: string, started: LaneStarted): string {
	return `lane-started: ${laneId} ${JSON.stringify(started)}`;
}
export function laneReadyBody(laneId: string, at: string): string {
	return `lane-ready: ${laneId} at ${at}`;
}
export function laneExitBody(laneId: string, exit: { code: number | null; signal: string | null; outcome: string; reason?: string | null }): string {
	const reason = exit.reason ? ` reason ${exit.reason}` : "";
	return `lane-exit: ${laneId} code ${exit.code ?? "-"} signal ${exit.signal ?? "-"} outcome ${exit.outcome}${reason}`;
}
export function laneStopRequestBody(laneId: string, reason: string, who: string): string {
	return `lane-stop: ${laneId} requested ${reason} by ${who}`;
}
export function laneStopAcceptedBody(laneId: string, ref: string): string {
	return `lane-stop: ${laneId} accepted ${ref}`;
}
/** `lane-decided: <laneId> <outcome>`: the runner's intended decision, recorded before EOF (`exitClass`). */
export function laneDecidedBody(laneId: string, outcome: LaneOutcome): string {
	return `lane-decided: ${laneId} ${outcome}`;
}
export function worktreeBody(path: string): string {
	return `worktree: ${path}`;
}
/**
 * The branch entry. A branch the starter cut carries the base it was cut from (`base <ref> <sha>`)
 * and, when `git fetch` failed, the fetch's first error line: the base was chosen on stale remote refs.
 */
export function branchBody(name: string, base: { ref: string; sha: string; fetchFailed: string | null } | null): string {
	if (base === null) return `branch: ${name}`;
	const fetch = base.fetchFailed === null ? "" : `\nfetch: failed ${base.fetchFailed}`;
	return `branch: ${name} base ${base.ref} ${base.sha}${fetch}`;
}
export function planFirstBody(trigger: string): string {
	return `plan: first ${trigger}`;
}
export function planApprovedBody(instructionId: string): string {
	return `plan: approved ${instructionId}`;
}
export function planQuestionBody(questionId: string): string {
	return `plan-question: ${questionId}`;
}
export function doneBody(sentence: string): string {
	return `done: ${oneLine(sentence)}`;
}
export const DONE_BECAUSE_PREFIX = "done-because:";
/** `lane-died: <laneId>: launch failed at <stage>: <reason>` — the shape `laneDeaths` parses (signals.ts). */
export function laneDiedLaunchBody(laneId: string, stage: string, reason: string): string {
	return `${LANE_DIED_PREFIX} ${laneId}: launch failed at ${stage}: ${oneLine(reason)}`;
}
/** `lane-died: <laneId>: deadline <max-time> with <n> open slice(s)` (§ 6 `--max-time` row). */
export function laneDiedDeadlineBody(laneId: string, maxTime: string, inFlight: number): string {
	return `${LANE_DIED_PREFIX} ${laneId}: deadline ${maxTime} with ${inFlight} open slice(s)`;
}

/** The fence target that covers `path` (canonical), or null: `subpath` covers the path and everything under it, `literal` the path alone. */
export function fencedBy(path: string, targets: readonly { kind: "subpath" | "literal"; path: string }[]): string | null {
	for (const t of targets) {
		if (t.path === path) return t.path;
		if (t.kind === "subpath" && path.startsWith(t.path.endsWith("/") ? t.path : `${t.path}/`)) return t.path;
	}
	return null;
}
/** `lane-died: <laneId>: <outcome> (exit <code>)` from the runner. */
export function laneDiedExitBody(laneId: string, outcome: string, code: number | null, signal: string | null): string {
	const how = signal ? `signal ${signal}` : `exit ${code ?? "-"}`;
	return `${LANE_DIED_PREFIX} ${laneId}: ${outcome} (${how})`;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// ---- argv, env, prompt -------------------------------------------------------------------------

export interface LaunchSpec {
	worktree: string;
	sessionDir: string;
	systemPromptPath: string;
	maxTime: string;
	resume: string | null;
	/** Jo's named model (`laneModel`), or null for the profile default: `--model <it>` when set. */
	model?: string | null;
	/** The ceiling's remaining wall in minutes; when given, `--max-time` is `ceilingMaxTime(it)` instead of `maxTime`. */
	remainingWallMin?: number | null;
}

/** OMP's argv for a lane: exactly `--mode rpc --no-ui --cwd … --session-dir … --append-system-prompt … --max-time … [--model …] [--resume …]` (§ 8). */
export function laneArgv(spec: LaunchSpec): string[] {
	const argv = [
		"--mode", "rpc", "--no-ui", "--cwd", spec.worktree, "--session-dir", spec.sessionDir,
		"--append-system-prompt", spec.systemPromptPath, "--max-time", spec.remainingWallMin != null ? ceilingMaxTime(spec.remainingWallMin) : spec.maxTime,
	];
	if (spec.model != null) argv.push("--model", spec.model);
	if (spec.resume !== null) argv.push("--resume", spec.resume);
	return argv;
}

/** OMP's argv for `as2 lane <wl>` in the TUI: `--cwd … --session-dir … --append-system-prompt … [--model …] [--resume …]` (§ 8). */
export function interactiveArgv(spec: Pick<LaunchSpec, "worktree" | "sessionDir" | "systemPromptPath" | "resume" | "model">): string[] {
	const argv = ["--cwd", spec.worktree, "--session-dir", spec.sessionDir, "--append-system-prompt", spec.systemPromptPath];
	if (spec.model != null) argv.push("--model", spec.model);
	if (spec.resume !== null) argv.push("--resume", spec.resume);
	return argv;
}

/**
 * The lane's environment: the starter's, with the binding written over it (decision 11), and the workload's scratch root as
 * `AS2_SCRATCH` (PLAN wl-mv5oikd5jtquww § 1.1: HOME-derived, never taken from the starter's own value). Hands share the lane's
 * process env, so their bash calls see it too. `OMP_PROFILE` and the ledger path pass through. Where the clean-shell switch
 * `cleanShell` (the installed profile's, read by the caller) is on for this workload, the shell-start hooks are dropped, as
 * bin/as2 does for the orchestrator under "all": the lane's bash calls are refused otherwise (gates/src/shell-start.ts).
 * Off, unreadable or malformed, nothing is dropped: the env is main's.
 */
export function laneEnv(base: Record<string, string | undefined>, binding: { workloadId: string; laneId: string }, cleanShell: CleanShellRead): Record<string, string> {
	const out: Record<string, string> = {};
	const hooks: readonly string[] = cleanShellOn(cleanShell, binding.workloadId) ? SHELL_START_HOOK_NAMES : [];
	for (const [k, v] of Object.entries(base)) if (v !== undefined && !hooks.includes(k)) out[k] = v;
	out[ROLE_ENV] = "lane";
	out[WORKLOAD_ENV] = binding.workloadId;
	out[LANE_ENV] = binding.laneId;
	out[SCRATCH_ENV] = scratchRootFor(homeDir(out), binding.workloadId);
	return out;
}

export interface PromptInput {
	workload: WorkloadRow;
	laneId: string;
	repo: string;
	worktree: string;
	branch: string;
	done: string | null;
	planFirst: string | null;
	/** `decisionLogContext(...)` as the open tool renders it; empty when none. */
	decisionLog: string;
	/** `factsBlock(...)` (surface/src/facts.ts): the repo's M8 facts, budgeted; empty when the repo has none. */
	facts: string;
	/** For a resume: the resolutions this launch consumes, with their questions' bodies. */
	resolved: readonly (Resolution & { question: string })[];
	/** Jo's instruction rows this lane is owed (`joInstructionsFor`), oldest first; rows already in `resolved` are not repeated. */
	instructions: readonly InstructionRow[];
	/** This repository is the machinery repo (Jo integrates; decision 11): the lane never merges. A product repo follows the stakes table. */
	machinery: boolean;
	tools: readonly string[];
	/** The workload's scratch root and its advisory cap (PLAN wl-mv5oikd5jtquww § 1.5), named beside the worktree; the lane script always passes it. */
	scratch?: { root: string; capMb: number };
	/** The unsettled merge-train tasks this workload owns (PLAN wl-mv8s8srodefytc rev 17.1 D7; surface/src/merge-train.ts `ownerTasks`), oldest first. */
	trainTasks?: readonly OwnerTrainTask[];
}

/** A merge-train task as its owner lane reads it (D7): the task, its detail, and the PR's open full-suite slice on the owner, if any. */
export interface OwnerTrainTask {
	id: string;
	train: string;
	pr: number;
	attempt: number;
	kind: string;
	head: string;
	detail: string;
	/** The owner workload's open full-suite slice for this PR (the newest `test-requested:` on the PR naming an open slice), or null. */
	slice: string | null;
}

/**
 * One task for its owner (D7), shared by the first prompt and the lane's aside: the task line, the detail indented, then the owner's
 * rules: fix on the head branch with main merged in (never a rebase or a force-push), pass the artifact, push, run the suite on the
 * PR's open full-suite slice (or with no slice the first time, then reusing the one it creates); or record the failure and release.
 */
export function trainTaskLines(t: OwnerTrainTask): string[] {
	const run = t.slice !== null
		? `\`${LANE_FULL_TEST_TOOL} { pr: ${t.pr}, slice: ${t.slice} }\` (the PR's open full-suite slice: every rerun goes on it)`
		: `\`${LANE_FULL_TEST_TOOL} { pr: ${t.pr} }\` with no slice this first time, then every rerun on the slice it creates`;
	return [
		`- ${t.id}: merge train ${t.train} returned PR #${t.pr} (${t.kind}, attempt ${t.attempt}) at head ${t.head}. Detail:`,
		...t.detail.split("\n").map((l) => `    ${l}`),
		`  Fix it on the PR's head branch (\`gh pr view ${t.pr} --json headRefName\`); bring main in with \`git merge --no-ff origin/main\`, never a rebase and never a force-push.`,
		`  Pass your declared artifact, push, then ${run}. A green at the new head settles the task fixed; a red settles it failed.`,
		`  When you cannot fix it: \`lane_record_entry\` \`${TRAIN_TASK_FAILED_PREFIX} ${t.id} <why>\`, then release.`,
	];
}

/** Decision 11's completion policy: Jo integrates this machinery repo; a product repo merges per SPEC-2.0.md § stakes. */
function mergeLine(p: PromptInput): string {
	if (p.machinery) return "never merge on this repo: Jo integrates it. A merge-train lane merges other PRs only as its brief's self-merge step allows, never its own branch.";
	if (p.workload.stakes === "production") return "the merge is Jo's: a judge slice, then Jo approves the merge.";
	if (p.workload.stakes === "normal") return "merge proceeds on a judge slice's pass; tell Jo in one line after the merge.";
	return "merge when green; throwaway stakes need no judge.";
}

/**
 * The one prompt a lane gets (§ 7 item 3). The resume variant leads with the answer text and
 * instruction id so the § B3 item 5 round trip completes inside the lane's own conversation.
 */
export function firstPrompt(p: PromptInput): string {
	const w = p.workload;
	const out: string[] = [];
	if (p.resolved.length > 0) {
		out.push(`Jo resolved ${p.resolved.length === 1 ? "your question" : "your questions"} on workload ${w.id}; this session resumes where it parked.`);
		for (const r of p.resolved) {
			out.push(`- question ${r.questionId} (${r.kind === "answer" ? "answer" : "withdrawn, replan"}, instruction ${r.instructionId}): ${r.body}`);
			out.push(`  asked: ${r.question}`);
		}
		out.push("");
	}
	out.push(`You are lane ${p.laneId} on workload ${w.id}.`);
	out.push(`done: ${p.done ?? "(not stated; state it in your first entry and work to it)"}`);
	out.push(`brief: ${w.brief}`);
	out.push(`stakes: ${w.stakes} · mode: ${w.mode}`);
	out.push(`repo: ${p.repo}`);
	out.push(`worktree: ${p.worktree} (branch ${p.branch}); commit there, rebase onto the remote default, push with -u, open the PR; ${mergeLine(p)}`);
	if (p.scratch) out.push(`scratch: ${p.scratch.root} (cap ${p.scratch.capMb} MiB)`);
	if (p.planFirst !== null) {
		out.push(`plan first: ${p.planFirst}. Your first slice is the judge-kind plan slice: propose the slice cut against the done: line, then close it with \`lane_raise_question\`, options approve / revise / cancel, and a body that carries the plan short: one item per line, each line at most ${PLAN_QUESTION_LINE_MAX} characters, in this shape and nothing else (another shape is refused):`);
		out.push(PLAN_QUESTION_SHAPE);
		// PLAN wl-mv8vwb04cy18n4 D4: the requirements grammar reaches plan-first lanes only, from the one constant.
		out.push(`The plan file carries one \`${PLAN_REQUIREMENTS_HEADING}\` section that names, for each requirement, its enforcer or why it is prompt-only, in this grammar; a plan file without it, or with a line the check cannot parse, is refused:`);
		out.push(PLAN_REQUIREMENTS_SHAPE);
		out.push("Change slices are refused until Jo approves.");
	}
	const shown = new Set(p.resolved.map((r) => r.instructionId));
	const owed = p.instructions.filter((i) => !shown.has(i.id));
	if (owed.length > 0) {
		out.push("");
		out.push("Jo's instructions on this workload since the previous lane started (oldest first):");
		for (const i of owed) out.push(instructionLine(i));
		out.push("Read them before your first action. Where they conflict, the newest one that applies wins. Your `ledger_wake_read` names each by id and how you follow it. An instruction that routes something to someone (e.g. \"for Plumb, not Jo\") is followed as written, not re-asked.");
	}
	if (p.trainTasks && p.trainTasks.length > 0) {
		out.push("");
		out.push("Merge-train tasks returned to this workload, unsettled (oldest first); each is yours to fix before other work:");
		for (const t of p.trainTasks) out.push(...trainTaskLines(t));
	}
	out.push("");
	out.push(`Call \`ledger_wake_read\` first. Then: ${p.tools.map((t) => `\`${t}\``).join(", ")}. Write \`done-because: <receipt against the done: line>\` with \`lane_record_entry\` before \`lane_release\`; \`lane_handoff\` when Jo is taking the workload over.`);
	if (p.facts.trim()) {
		out.push("");
		out.push(p.facts.trim());
	}
	if (p.decisionLog.trim()) {
		out.push("");
		out.push("## Decision-log context");
		out.push(p.decisionLog.trim());
	}
	return out.join("\n");
}

// ---- one-line results for the surface ------------------------------------------------------------

/** Starter exit codes (§ 4, lane script row). */
export const STARTER_EXIT: Record<string, number> = {
	ok: 0,
	unknown: 1,
	"no-omp": 2,
	"no-profile": 3,
	"repo-or-fence": 4,
	worktree: 5,
	cap: 6,
	held: 7,
	ledger: 8,
	closed: 9,
	"not-launchable": 10,
};

/** The by-hand command for a user-driven workload (decision 14). */
export function byHandLine(workloadId: string): string {
	return `as2 lane ${workloadId}`;
}
