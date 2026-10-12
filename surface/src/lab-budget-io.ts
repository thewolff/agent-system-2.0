// The per-lab token budget's I/O half (MIGRATION.md item 113): the profile config, the quota cache and
// its probe (`omp usage --json`), the ledger reads, the question raise, and the release of a lab Jo
// lifted or whose window rolled off. The rules are in surface/src/lab-budget.ts.
//
// Every read here is lazy and degrades: a missing or unreadable config keeps the defaults, a missing or
// unreadable quota cache is no report (quota unknown for the labs it covers, which never holds them), and
// nothing here opens a ledger of its own: callers hand in the one they already hold.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Lab, LABS } from "../../classifier/src/lab";
import type { InstructionRow, Ledger, QuestionRow, ReserveRows } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";
import {
	type LabBudgetConfig, type LabDecision, type LabState, labBudgetConfig, labBudgetQuestionBody, labBudgetQuestionLab, labDecisions, labSlicePrefix,
	LAB_BUDGET_OPTIONS, mayRaise, nextLaneLab, parseQuotaCache, type QuotaSnapshot, type UsageRow, usageEvents, labStates,
} from "./lab-budget";
import {
	attempts, consumedIds, type ControlEntry, controlEntries, heldLive, holdersOf, launchRequestedBody, type LaunchVerdict, verdictOf,
} from "./launch";
import { SURFACE_BY } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Replaces the checkout's profile/config.yml as the source of the `labBudget:` block. */
export const LAB_BUDGET_CONFIG_ENV = "AGENT_SYSTEM_LAB_BUDGET_CONFIG";
/** Replaces `<ledger dir>/lab-quota.json` as the quota cache. */
export const LAB_QUOTA_FILE_ENV = "AGENT_SYSTEM_LAB_QUOTA_FILE";
/** `on` or `off`: whether this process may run `omp usage`. Unset: on, except under `bun test` (NODE_ENV=test). */
export const LAB_QUOTA_PROBE_ENV = "AGENT_SYSTEM_LAB_QUOTA_PROBE";
/** A cache younger than this is not probed again. */
export const QUOTA_PROBE_EVERY_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_ARGV = ["omp", "usage", "--json", "--no-extensions"];

type Env = Record<string, string | undefined>;

/** The `labBudget:` config: the checkout's profile/config.yml (or `$AGENT_SYSTEM_LAB_BUDGET_CONFIG`), then the env; errors name what was kept at its default. */
export function loadLabBudgetConfig(env: Env): { config: LabBudgetConfig; errors: string[] } {
	const path = env[LAB_BUDGET_CONFIG_ENV]?.trim() || join(REPO_ROOT, "profile", "config.yml");
	let doc: unknown;
	const errors: string[] = [];
	try {
		doc = Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (err) {
		errors.push(`${path}: ${String(err instanceof Error ? err.message : err).split("\n")[0]}; the defaults stand`);
	}
	const r = labBudgetConfig(doc, env);
	return { config: r.config, errors: [...errors, ...r.errors] };
}

export function quotaCachePath(env: Env): string {
	return env[LAB_QUOTA_FILE_ENV]?.trim() || join(dirname(defaultLedgerPath(env)), "lab-quota.json");
}

/** The cached quota snapshot, or null when there is none or it cannot be read. */
export function readQuota(env: Env): QuotaSnapshot | null {
	try {
		return parseQuotaCache(readFileSync(quotaCachePath(env), "utf8"));
	} catch {
		return null;
	}
}

export function probeEnabled(env: Env): boolean {
	const v = env[LAB_QUOTA_PROBE_ENV]?.trim().toLowerCase();
	return v === "on" || (v !== "off" && env.NODE_ENV !== "test");
}

/**
 * Write `{ probedAt, report, carried }` beside the ledger when `stdout` is OMP's usage JSON (a `reports` array); false
 * otherwise. A provider the previous cache reported (newest first: its `report`, then its `carried`) and this report
 * does not is carried forward with its own `probedAt` (PR #79 review B4): an empty or partial report never erases a
 * known limit, and `labStates` judges each limit by its own age and reset.
 */
export function writeQuota(env: Env, stdout: string, now: number): boolean {
	let report: unknown;
	try {
		report = JSON.parse(stdout);
	} catch {
		return false;
	}
	if (report === null || typeof report !== "object" || !("reports" in report) || !Array.isArray(report.reports)) return false;
	const path = quotaCachePath(env);
	const reported = new Set(report.reports.map((r: unknown) => Reflect.get(Object(r), "provider")));
	const carried: { probedAt: number; report: unknown }[] = [];
	let prev: unknown = null;
	try {
		prev = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// no previous cache, or an unreadable one: nothing to carry
	}
	const prevAt = Reflect.get(Object(prev), "probedAt");
	const prevReports = Reflect.get(Object(Reflect.get(Object(prev), "report")), "reports");
	const prevCarried = Reflect.get(Object(prev), "carried");
	const older = [
		...(typeof prevAt === "number" && Array.isArray(prevReports) ? prevReports.map((r: unknown) => ({ probedAt: prevAt, report: r })) : []),
		...(Array.isArray(prevCarried) ? prevCarried.map((c: unknown) => ({ probedAt: Reflect.get(Object(c), "probedAt"), report: Reflect.get(Object(c), "report") })) : []),
	];
	for (const o of older) {
		const provider = Reflect.get(Object(o.report), "provider");
		if (typeof provider !== "string" || typeof o.probedAt !== "number" || reported.has(provider)) continue;
		reported.add(provider);
		carried.push({ probedAt: o.probedAt, report: o.report });
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ probedAt: now, report, carried }));
	renameSync(tmp, path);
	return true;
}

/** The last probe this process started (ms): a failing probe is not retried on every call. */
let lastProbe = 0;

function probeDue(env: Env, now: number): boolean {
	if (!probeEnabled(env) || now - lastProbe < QUOTA_PROBE_EVERY_MS) return false;
	const q = readQuota(env);
	return q === null || now - q.probedAt >= QUOTA_PROBE_EVERY_MS;
}

/** Refresh the cache with `omp usage --json` under `profile` when it is older than five minutes, waiting at most 15 s. Never throws. */
export function refreshQuotaSync(env: Env, profile: string, now: number = Date.now()): void {
	if (!probeDue(env, now)) return;
	lastProbe = now;
	try {
		const r = Bun.spawnSync(PROBE_ARGV, { env: { ...env, OMP_PROFILE: profile }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS });
		if (r.exitCode === 0) writeQuota(env, r.stdout.toString(), Date.now());
	} catch {
		// no omp, or the probe failed: the token budgets alone decide until a probe lands
	}
}

/** `refreshQuotaSync` without blocking the caller's event loop. Never rejects. */
export async function refreshQuota(env: Env, profile: string, now: number = Date.now()): Promise<void> {
	if (!probeDue(env, now)) return;
	lastProbe = now;
	try {
		const p = Bun.spawn(PROBE_ARGV, { env: { ...env, OMP_PROFILE: profile }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => p.kill("SIGKILL"), PROBE_TIMEOUT_MS);
		const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
		clearTimeout(timer);
		if (code === 0) writeQuota(env, out, Date.now());
	} catch {
		// as above
	}
}

// ---- ledger reads -----------------------------------------------------------------------------------

/** The rows the usage count reads, ledger-wide, oldest first (`usageRows`; the `lab-budget` invariant shows it as its query). */
export const USAGE_SQL = "SELECT workload_id, body, created_by, created_at FROM entries WHERE kind = 'assumption' AND (" +
	"body LIKE 'spend:%' OR body LIKE 'orchestrator-spend:%' OR body LIKE 'builder-lab:%' OR body LIKE 'lane-started:%'" +
	") ORDER BY created_at, rowid";

/** Every row the usage count reads, ledger-wide, oldest first. */
export function usageRows(ledger: Pick<Ledger, "db">): UsageRow[] {
	return ledger.db.query<UsageRow, []>(USAGE_SQL).all();
}

/** Every lab-budget question ledger-wide, and the instructions that resolved them. */
export function labQuestionRows(ledger: Pick<Ledger, "db">): { questions: QuestionRow[]; instructions: InstructionRow[] } {
	const questions = ledger.db.query<QuestionRow, []>("SELECT * FROM questions WHERE slice_id LIKE 'sl-lab-budget-%' ORDER BY created_at, id").all();
	const instructions = ledger.db.query<InstructionRow, []>(
		"SELECT * FROM instructions WHERE question_id IN (SELECT id FROM questions WHERE slice_id LIKE 'sl-lab-budget-%') ORDER BY created_at, id",
	).all();
	return { questions, instructions };
}

/**
 * The predicate, then the lab budget on a launch: a launch onto a held lab is `lab-budget`, with the lab's state (the surface's
 * tick and tool, the drain). `coverage` is the lab's state when its coverage is unknown: the launch goes ahead and the receipt names it.
 */
export function gatedVerdict(ledger: Pick<Ledger, "db">, env: Env, rows: ReserveRows, now: number = Date.now()): { verdict: LaunchVerdict; hold: LabState | null; coverage: LabState | null } {
	const verdict = verdictOf(rows);
	if (!verdict.launch) return { verdict, hold: null, coverage: null };
	const s = nextLabState(ledger, env, controlEntries(rows.entries, holdersOf(rows.entries, rows.workload.holder, rows.holders)), now);
	if (s?.status === "held") return { verdict: { launch: false, reason: "lab-budget" }, hold: s, coverage: null };
	return { verdict, hold: null, coverage: s?.status === "unknown" ? s : null };
}

export interface LabView {
	states: Record<Lab, LabState>;
	decisions: LabDecision[];
	questions: QuestionRow[];
	/** Config problems: each kept its default. */
	errors: string[];
}

/**
 * Every lab's state now, from the ledger, the config and the quota cache. `extra` rows join the ledger's: the runner's
 * own current `spend:` line, measured but not yet flushed (PR #79 review B2), which counts once because `spend:` is cumulative.
 */
export function readLabView(ledger: Pick<Ledger, "db">, env: Env, now: number = Date.now(), extra: readonly UsageRow[] = []): LabView {
	const { config, errors } = loadLabBudgetConfig(env);
	const { questions, instructions } = labQuestionRows(ledger);
	const decisions = labDecisions(questions, instructions);
	const states = labStates({ events: usageEvents([...usageRows(ledger), ...extra]), decisions, quota: readQuota(env), config, now });
	return { states, decisions, questions, errors };
}

/** The state of the lab `control`'s workload launches on next (`nextLaneLab`), or null when that lab is not known yet (the runner checks once OMP names its model). */
export function nextLabState(ledger: Pick<Ledger, "db">, env: Env, control: readonly ControlEntry[], now: number = Date.now()): LabState | null {
	const lab = nextLaneLab(control);
	return lab === null ? null : readLabView(ledger, env, now).states[lab];
}

/** The held labs, each with the reason a dispatch on it is refused (the classifier's view). An unknown lab is not held. */
export function heldLabs(ledger: Pick<Ledger, "db">, env: Env, now: number = Date.now()): Map<string, string> {
	const out = new Map<string, string>();
	for (const s of Object.values(readLabView(ledger, env, now).states)) {
		if (s.status === "held") out.set(s.lab, `lab budget held: ${s.reasons.join("; ")}; Jo lifts it with lift on the lab-budget question`);
	}
	return out;
}

/**
 * Raise the lab-budget question for `state.lab` on `workloadId`, as `by`, in one write: a slice of its own
 * (`sl-lab-budget-<lab>-<wl suffix>-<n>`) and the question on it, unless one is open for the lab anywhere or Jo
 * answered `keep` in the last five hours (`mayRaise`). Returns the question id, or null when nothing was raised.
 */
export function raiseLabBudgetQuestion(ledger: Ledger, r: { by: string; workloadId: string; state: LabState; now?: number }): string | null {
	return ledger.write(() => {
		const { questions, instructions } = labQuestionRows(ledger);
		if (!mayRaise(r.state.lab, questions, labDecisions(questions, instructions), r.now ?? Date.now())) return null;
		const w = ledger.workload(r.workloadId);
		if (!w || w.status !== "open") return null;
		const prefix = labSlicePrefix(r.state.lab, r.workloadId);
		let n = 1 + ledger.slices(r.workloadId).filter((s) => s.id.startsWith(prefix)).length;
		while (ledger.slice(`${prefix}${n}`) !== null) n += 1;
		const sliceId = ledger.addSlice({
			by: r.by, workloadId: r.workloadId, id: `${prefix}${n}`, task: `Jo decides the ${r.state.lab} lab budget hold`,
			doneCondition: `Jo answers lift or keep for the ${r.state.lab} lab budget`, inputs: "lab-budget",
		});
		return ledger.raiseQuestion({ by: r.by, workloadId: r.workloadId, sliceId, body: labBudgetQuestionBody(r.state), options: [...LAB_BUDGET_OPTIONS] });
	});
}

const STOPPED_BY = /^accepted\s+lab-budget-(anthropic|openai|kimi)\b/;

/** The lab whose hold stopped the workload's newest lane (`lane-stop: <lane> accepted lab-budget-<lab>`), or null. */
export function stoppedByLab(control: readonly ControlEntry[]): Lab | null {
	const last = attempts(control).at(-1);
	if (!last) return null;
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "lane-stop" || c.laneId !== last.laneId) continue;
		const m = STOPPED_BY.exec(c.rest);
		if (m) return m[1] as Lab;
	}
	return null;
}

/**
 * The open autonomous workloads a lab's hold stopped and nothing relaunched yet: the newest lane was stopped by
 * that hold, no lane holds the workload under a live lease, and no unconsumed `launch-requested:` stands.
 */
export function labStopped(ledger: Ledger): { workloadId: string; lab: Lab }[] {
	const out: { workloadId: string; lab: Lab }[] = [];
	for (const f of ledger.inFlight()) {
		const w = f.workload;
		if (w.mode !== "autonomous" || heldLive(w, ledger.now())) continue;
		const entries = ledger.entries(w.id);
		const control = controlEntries(entries, holdersOf(entries, w.holder, ledger.holders(w.id)));
		const lab = stoppedByLab(control);
		if (lab === null) continue;
		const consumed = consumedIds(attempts(control));
		if (control.some((c) => c.prefix === "launch-requested" && !consumed.has(c.id))) continue;
		out.push({ workloadId: w.id, lab });
	}
	return out;
}

/**
 * Relaunch the workloads `lab`'s hold stopped (`labStopped`), inside the caller's write: one `launch-requested:` each,
 * as `who` names (`jo` for Jo's lift, `lab-budget` for a hold that cleared). Returns the workload ids.
 */
export function relaunchStopped(ledger: Ledger, lab: Lab, who: string, reason: string): string[] {
	const out: string[] = [];
	for (const s of labStopped(ledger)) {
		if (s.lab !== lab) continue;
		ledger.recordEntry({ by: SURFACE_BY, workloadId: s.workloadId, kind: "assumption", body: launchRequestedBody(who, ledger.now(), reason) });
		out.push(s.workloadId);
	}
	return out;
}

/**
 * The surface's tick for the lab budget: for each lab no longer held, withdraw its open lab-budget question (`then:
 * cancel`) and relaunch what its hold stopped, in one write. The relaunch does not wait on the question (PR #79 review
 * S1): after Jo's `keep` the question is answered, and the hold clearing still restarts the workloads it stopped.
 * Returns one line per lab released.
 */
export function releaseClearedLabs(ledger: Ledger, view: LabView): string[] {
	const cleared = new Set(LABS.filter((lab) => view.states[lab].status !== "held"));
	const open = view.questions.filter((q) => {
		const lab = labBudgetQuestionLab(q);
		return q.state === "open" && lab !== null && cleared.has(lab);
	});
	const relaunched = ledger.write(() => {
		for (const q of open) {
			ledger.withdrawQuestion(q.id, { by: SURFACE_BY, reason: `the ${labBudgetQuestionLab(q)} lab budget is no longer held`, author: SURFACE_BY, channel: "direct", then: "cancel" });
		}
		const out = labStopped(ledger).filter((s) => cleared.has(s.lab));
		for (const s of out) {
			ledger.recordEntry({ by: SURFACE_BY, workloadId: s.workloadId, kind: "assumption", body: launchRequestedBody("lab-budget", ledger.now(), `${s.lab} lab budget clear`) });
		}
		return out;
	});
	const lines: string[] = [];
	for (const lab of LABS) {
		const withdrew = open.filter((q) => labBudgetQuestionLab(q) === lab).map((q) => q.id);
		const ids = relaunched.filter((s) => s.lab === lab).map((s) => s.workloadId);
		const did = [...(withdrew.length > 0 ? [`withdrew ${withdrew.join(", ")}`] : []), ...(ids.length > 0 ? [`requested a relaunch of ${ids.join(", ")}`] : [])];
		if (did.length > 0) lines.push(`lab budget: ${lab} is no longer held; ${did.join(" and ")}`);
	}
	return lines;
}
