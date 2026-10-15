// The issues projector's tick (PLAN wl-mv66ylim0gahog §§ 3, 5, 13.2): the projection of the ledger
// onto each workload's tracker (GitHub issues on its own repo, or a Linear team), drained only by
// the orchestrator surface's issues row. A tick, in order:
//
// 1. Claim: take the sidecar claim (free, expired, or already ours) or do nothing. Every counted
//    call fences and renews it (surface/src/issues/github.ts); it is released at the end.
// 2. Seeding (switch on, `seeded_at` unset): one ledger read transaction gives `hw = max(seq)` and
//    the open workloads of that snapshot; one sidecar transaction writes a dirty link for each one a
//    tracker applies to (surface/src/issues/tracker.ts), `cursor = hw`, `intake_since` = the on
//    entry's `created_at`, `seeded_at`.
// 3. Ingest (on or off, local, no network call): every workload with provenance after the cursor
//    (lease-only renewals and wl-orchestrator excluded) is marked dirty; one without a link gets a
//    dirty link only when it is open and a tracker applies. Before seeding only the cursor moves.
// 4. Off ⇒ the tick ends here: no network call.
// 5. The hourly `gh api rate_limit` read (counted); under RATE_FLOOR remaining, GitHub work
//    (steps 6–8, and every push that needs a PR set from GitHub) pauses.
// 6. Per GitHub repo: the default branch (read once) and the projection's labels (created once).
// 7. PR scan: every open PR in each repo with links (a closed link's only within LATE_PR_WINDOW_MS of
//    its close and while no PR of its set merged: a PR opened after the close reopens an unmerged
//    item as awaiting-merge), mapped to a link by bound head branch or
//    test-requested number; a newly mapped PR, or a mapped PR gone from the open list, marks its link
//    dirty (a Linear link too: it closes by observing MERGED, § 13.2). A truncated or failed pass is
//    recorded in `pr_scan_unknown` (PR_SCAN_UNKNOWN) for the reconciler, cleared by a complete one.
// 8. Footers: each mapped default-base PR whose link is on GitHub with an issue gets `Closes #N`,
//    and gets it again when the scan sees it removed. Each scan recomputes a PR's base and footer
//    state, so a retarget onto the default branch owes one. A Linear link's PRs are never edited.
// 9. Push: dirty links, those a turn's receipt waits on first (`priority`, § 13.3), then by
//    `last_seq`, each routed to its effective tracker; a link whose tracker changed is moved first
//    (old item closed not planned with one comment, old footers stripped).
// 10. Phases (`TickPhases`), in the same claim and budget: reconcile always, told which trackers
//    stopped; intake only while GitHub's work was not stopped.
//
// GitHub and Linear have separate budgets (§ 13.2): a budget stop or a failed call on one ends that
// tracker's work for the tick and the other goes on. A Linear link whose repo is on GitHub reads its
// PR set from GitHub, so it waits while GitHub's work is stopped. A lost claim ends the tick.
// Errors reach the row as notice lines (the Linear key redacted); the row dedups them.
import { existsSync } from "node:fs";
import type { Ledger } from "../../../ledger/src/index";
import { parseSpend } from "../ceiling";
import { repoOf } from "../decision-log";
import { ceilingOf, ceilingText } from "../input";
import { controlEntries } from "../launch";
import { ownerRepoOf } from "../test-run";
import { STANDING_WORKLOAD_ID } from "../types";
import { intakeRepo, type IssuesConfig, parseTrackerKey, type Tracker, trackerKey } from "./config";
import { closesFooter, hasFooter, stripFooter } from "./footer";
import { type Exec, GitHub, TickStop } from "./github";
import { type FetchLike, Linear, LINEAR_LABELS, type LinearTeam, linearStateFor, redact } from "./linear";
import { type PrSet, prSources, readPrSet, scanOpenPrs } from "./prs";
import { blockHash, LABEL, type PrFact, PROJECTION_LABELS, type Rendered, mergeBody, render, renderHash, stateText } from "./render";
import { INTAKE_ACCEPTED, type LinkRow, type PrRow, STATE, type Sidecar, type TrackerKind } from "./sidecar";
import { readSwitch, type SwitchState } from "./switch";
import { linkTracker, NO_REPO } from "./tracker";

/** Pushes, the scan and footer edits pause while the hourly read says fewer core calls remain (§ 2). */
export const RATE_FLOOR = 500;
const HOUR_MS = 60 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const LOCAL_MS = 15_000;
/**
 * The sidecar `state` key the open-PR scan writes after every pass: why the pass did not see every
 * open PR (a truncated or failed scan), or absent after a complete one. The reconciler reads it and
 * records `issues-drift: unknown (pr scan: <why>)`, never 0, while it is set.
 */
export const PR_SCAN_UNKNOWN = "pr_scan_unknown";
/** `move_commented:<workload id>` = `<from> <comment>`: the move comment already posted on that old item; cleared when the move completes. */
const MOVE_COMMENTED = "move_commented";
/** `move_commenting:<workload id>` = `<from> <comment>`: written before that comment is posted; cleared with `move_commented`. */
const MOVE_COMMENTING = "move_commenting";
/**
 * How long after its workload's ledger close (`closed_at`) a closed link keeps its repo in the open-PR
 * scan, so a late PR (the decision-log publication) is still seen; past it, or once its PR set holds a
 * MERGED PR (first merge wins: final), the closed link adds no repo to the scan.
 */
export const LATE_PR_WINDOW_MS = 24 * HOUR_MS;
/** `pr_merged:<workload id>` = a MERGED PR's url: the push saw the link's PR set hold one (first merge wins, so it stays). */
const PR_MERGED = "pr_merged";

/** The backoff after `fails` consecutive failures: min(60 s · 2^fails, 1 h). */
export function backoffMs(fails: number): number {
	return Math.min(BACKOFF_BASE_MS * 2 ** fails, HOUR_MS);
}

/**
 * What a phase gets (the reconcile and intake slices implement against this; the row passes them in):
 *
 *   interface TickPhases {
 *     reconcile?: (ctx: PhaseContext) => Promise<void>;
 *     intake?: (ctx: PhaseContext) => Promise<void>;
 *   }
 *
 * Phases run after the push, only while the switch is on, reconcile first, inside the tick's claim
 * and with its counted callers (`gh`, `linear`), so they share the tick's `perTick` and the hour's
 * `perHour` per tracker. Reconcile always runs and is told which trackers' work ended this tick
 * (`stopped`): it calls none of them. Intake runs only while GitHub's work was not stopped. A phase
 * schedules itself (`reconcileEveryMin`, `intakeEveryMin`) from its own `state` keys, makes every
 * GitHub call through `ctx.gh` (never `ctx.exec` for gh), and lets `TickStop` propagate (catch,
 * record, rethrow when it must record "budget"). Any other throw is caught by the tick and becomes
 * one notice; the next phase still runs. `notice` lines reach Jo's surface once per distinct text.
 */
export interface PhaseContext {
	config: IssuesConfig;
	sidecar: Sidecar;
	/** The tick's counted gh caller. */
	gh: GitHub;
	/** The tick's counted Linear caller. */
	linear: Linear;
	ledger: Ledger;
	/** For local commands (git); every gh call goes through `gh`. */
	exec: Exec;
	/** Epoch ms. */
	now: () => number;
	notice: (line: string) => void;
	/** The trackers whose work ended this tick, with why; a phase calls none of them. */
	stopped: ReadonlyMap<TrackerKind, "budget" | "failed">;
	switchState: SwitchState;
	/** The GitHub repo issue intake reads (config.ts `intakeRepo`), or null when the config names none. */
	intakeRepo: string | null;
	/**
	 * `intakeRepo`'s default branch when this tick read it (the repo also holds projected issues),
	 * else null: a separate intake repo's is never read. Intake does not use it.
	 */
	defaultBranch: string | null;
	/** The hourly rate_limit read said fewer than RATE_FLOOR calls remain: GitHub pushes paused this tick. */
	rateLow: boolean;
	/** A workload's PR set through `gh` on its link's repo (unknown on a full branch list or any failure). */
	prSet: (workloadId: string) => Promise<PrSet>;
	/** The render of a workload from the ledger now with `prs`, or null when the ledger has no such workload. */
	renderOf: (workloadId: string, prs: readonly PrFact[]) => Rendered | null;
}

export interface TickPhases {
	reconcile?: (ctx: PhaseContext) => Promise<void>;
	intake?: (ctx: PhaseContext) => Promise<void>;
}

export interface TickOptions {
	exec: Exec;
	ledger: Ledger;
	sidecar: Sidecar;
	config: IssuesConfig;
	/** This drainer: pid + session (§ 3 claim). */
	holder: string;
	/** Epoch ms; tests move it. */
	now: () => number;
	/** One line per thing Jo should hear; the row dedups by text. */
	notice: (line: string) => void;
	phases?: TickPhases;
	/** Linear's key (`LINEAR_API_KEY`, null when unset) and fetch; omitted ⇒ no key, the global fetch. */
	linear?: { key: string | null; fetch: FetchLike };
}

export interface TickReport {
	claimed: boolean;
	on: boolean;
	/** This tick seeded. */
	seeded: boolean;
	/** Workloads ingest touched. */
	ingested: number;
	/** Links pushed (created, adopted, edited, or found clean). */
	pushed: number;
	/** The first stop this tick: a budget or claim stop, a failed call, or null when it ran through. */
	stopped: "budget" | "lost" | "failed" | null;
	/** Counted calls made, both trackers. */
	calls: number;
}

// ---- local reads ------------------------------------------------------------------------------

/**
 * The owner/repo (lower case) of the workload's `repo:` checkout's origin, NO_REPO when it has none
 * or it is not on GitHub, or null when git could not answer (resolved again later). Local only.
 */
export async function resolveRepo(exec: Exec, ledger: Ledger, workloadId: string): Promise<string | null> {
	const path = repoOf(ledger, workloadId);
	if (path === null || !existsSync(path)) return NO_REPO;
	let r: { stdout: string; code: number; killed: boolean };
	try {
		r = await exec("git", ["-C", path, "remote", "get-url", "origin"], { timeout: LOCAL_MS });
	} catch {
		return null;
	}
	if (r.killed) return null;
	// git exits 2 for "No such remote"; 128 for "not a git repository".
	if (r.code === 2 || r.code === 128) return NO_REPO;
	if (r.code !== 0) return null;
	return ownerRepoOf(r.stdout.trim())?.toLowerCase() ?? NO_REPO;
}

/** The ceiling line of the block: the ceiling in force and the newest `spend:` against it. */
function ceilingLine(ledger: Ledger, workloadId: string): string {
	const c = ceilingOf(ledger, workloadId);
	const spend = controlEntries(ledger.entries(workloadId, "assumption"))
		.flatMap((e) => {
			const p = e.prefix === "spend" ? parseSpend(e.rest) : null;
			return p ? [p] : [];
		})
		.at(-1);
	if (!spend) return `${ceilingText(c)}, nothing spent`;
	return `spent $${Number(spend.usd.toFixed(2))} of $${Number(c.usd.toFixed(2))} · ${Number(spend.wallMin.toFixed(1))} of ${c.wallMin} min`;
}

/** The render of a workload from the ledger now, or null when there is no such workload. */
export function renderWorkload(ledger: Ledger, workloadId: string, prs: readonly PrFact[], lastSeq: number): Rendered | null {
	const w = ledger.workload(workloadId);
	if (!w) return null;
	const slices = { open: 0, paused: 0, done: 0, cancelled: 0 };
	for (const s of ledger.slices(workloadId)) {
		if (s.state === "open") slices.open++;
		else if (s.state === "paused") slices.paused++;
		else if (s.state === "done") slices.done++;
		else slices.cancelled++;
	}
	const questions = ledger.questions(workloadId).filter((q) => q.state === "open").map((q) => ({ id: q.id, body: q.body }));
	return render({
		workload: { id: w.id, brief: w.brief, stakes: w.stakes, mode: w.mode, status: w.status, holder: w.holder },
		ceiling: ceilingLine(ledger, workloadId),
		slices,
		questions,
		prs,
		lastSeq,
	});
}

/** Where a tracker lives, in words: the move comment and notices name it. */
function placeOf(t: Tracker | null, repo: string | null): string {
	if (t === null) return "no tracker (no longer projected)";
	return t.kind === "github" ? `GitHub issues on ${repo}` : `Linear team ${t.team}`;
}

/**
 * Make `labels` exist on `repo` once: unless the sidecar's `key` state is set, one counted label list,
 * one counted create per missing label, then the key. Null when done, else the failed call's error
 * (the key stays unset, so the next try lists again). The tick ensures the projection's labels on
 * each issues repo (`labels_created:<repo>`); intake ensures its own on its repo before labelling.
 */
export async function ensureGithubLabels(gh: GitHub, sidecar: Sidecar, repo: string, labels: readonly string[], key: string): Promise<string | null> {
	if (sidecar.state(key) === "1") return null;
	const list = await gh.run(["label", "list", "-R", repo, "--json", "name", "-L", "1000"]);
	if (!list.ok) return list.error;
	let names: string[];
	try {
		const v: unknown = JSON.parse(list.out);
		names = Array.isArray(v) ? v.flatMap((x) => (x !== null && typeof x === "object" && "name" in x && typeof x.name === "string" ? [x.name.toLowerCase()] : [])) : [];
	} catch {
		names = [];
	}
	for (const label of labels) {
		if (names.includes(label)) continue;
		const created = await gh.run(["label", "create", label, "-R", repo]);
		if (!created.ok) return created.error;
	}
	sidecar.immediate(() => sidecar.setState(key, "1"));
	return null;
}

// ---- the tick ---------------------------------------------------------------------------------

/** A failed call: the tick ends that tracker's work after the caller backs off what it was for. */
class CallFailed extends Error {
	constructor(
		message: string,
		readonly kind: TrackerKind,
	) {
		super(message);
	}
}

/**
 * The item a successful push wrote: a GitHub issue number, or a Linear issue id and identifier with
 * `remoteHash`, the `blockHash` of the description Linear holds after the push (null when unknown).
 */
type Item = { issueNumber: number } | { externalId: string; issueRef: string; remoteHash: string | null };

class Tick {
	readonly gh: GitHub;
	readonly linear: Linear;
	readonly report: TickReport = { claimed: true, on: false, seeded: false, ingested: 0, pushed: 0, stopped: null, calls: 0 };
	/** Default branch per GitHub repo read this tick. */
	readonly defaultBranches = new Map<string, string>();
	/** Linear teams read this tick (their states and labels, the projection's labels ensured). */
	readonly teams = new Map<string, LinearTeam>();
	/** Tracker kinds whose work ended this tick, with the first reason. */
	readonly stops = new Map<TrackerKind, "budget" | "failed">();
	rateLow = false;
	readonly notice: (line: string) => void;

	constructor(readonly o: TickOptions) {
		const caller = { holder: o.holder, perTick: o.config.perTick, perHour: o.config.perHour, now: o.now };
		this.gh = new GitHub(o.exec, o.sidecar, caller);
		const key = o.linear?.key ?? null;
		this.linear = new Linear(o.linear?.fetch ?? ((url, init) => fetch(url, init)), key, o.sidecar, caller);
		this.notice = (line) => o.notice(redact(line, key));
	}

	get sidecar(): Sidecar {
		return this.o.sidecar;
	}
	get ledger(): Ledger {
		return this.o.ledger;
	}

	/** Record that `kind`'s work ended this tick; the first stop is the report's. */
	stop(kind: TrackerKind, why: "budget" | "failed"): void {
		if (!this.stops.has(kind)) this.stops.set(kind, why);
		this.report.stopped ??= why;
	}

	/** GitHub calls may be made now: not stopped this tick, rate limit not low. */
	get githubUp(): boolean {
		return !this.stops.has("github") && !this.rateLow;
	}

	/** The tracker a link projects to now. */
	trackerOf(workloadId: string, repo: string | null): Tracker | null {
		return linkTracker(this.ledger, this.o.config, workloadId, repo);
	}

	// ---- seeding and ingest (local) ----

	async seed(sw: SwitchState): Promise<void> {
		const snapshot = this.ledger.db.transaction(() => {
			const hw = this.ledger.db.query<{ hw: number | null }, []>("SELECT max(seq) AS hw FROM provenance").get()?.hw ?? 0;
			const open = this.ledger.db
				.query<{ id: string; seq: number | null }, [string]>(
					"SELECT w.id AS id, (SELECT max(p.seq) FROM provenance p WHERE p.workload_id = w.id) AS seq FROM workloads w WHERE w.status = 'open' AND w.id <> ? ORDER BY w.created_at, w.id",
				)
				.all(STANDING_WORKLOAD_ID);
			return { hw, open };
		})();
		const repos = new Map<string, string | null>();
		for (const w of snapshot.open) repos.set(w.id, await resolveRepo(this.o.exec, this.ledger, w.id));
		this.sidecar.immediate(() => {
			for (const w of snapshot.open) {
				const repo = repos.get(w.id) ?? null;
				this.sidecar.upsertLink(w.id, { repo, dirty: repo === null || this.trackerOf(w.id, repo) !== null, lastSeq: w.seq ?? 0 });
			}
			this.sidecar.setCursor(snapshot.hw);
			this.sidecar.setState(STATE.intakeSince, sw.at ?? new Date(this.o.now()).toISOString());
			this.sidecar.setState(STATE.seededAt, new Date(this.o.now()).toISOString());
		});
		this.report.seeded = true;
	}

	async ingest(seeded: boolean): Promise<void> {
		const db = this.ledger.db;
		const max = db.query<{ m: number | null }, []>("SELECT max(seq) AS m FROM provenance").get()?.m ?? 0;
		const cursor = this.sidecar.cursor();
		if (!seeded || cursor === null) {
			this.sidecar.immediate(() => this.sidecar.setCursor(max));
			return;
		}
		if (max <= cursor) return;
		const touched = db
			.query<{ workload_id: string; seq: number }, [number, number, string]>(
				`SELECT workload_id, max(seq) AS seq FROM provenance
				  WHERE seq > ? AND seq <= ? AND workload_id <> ?
				    AND NOT (tbl = 'workloads' AND action = 'update' AND detail LIKE 'lease %')
				  GROUP BY workload_id ORDER BY seq`,
			)
			.all(cursor, max, STANDING_WORKLOAD_ID);
		const fresh = new Map<string, string | null>();
		for (const t of touched) {
			if (this.sidecar.link(t.workload_id)) continue;
			if (this.ledger.workload(t.workload_id)?.status !== "open") continue;
			fresh.set(t.workload_id, await resolveRepo(this.o.exec, this.ledger, t.workload_id));
		}
		this.sidecar.immediate(() => {
			for (const t of touched) {
				if (this.sidecar.link(t.workload_id)) {
					this.sidecar.upsertLink(t.workload_id, { repo: null, dirty: true, lastSeq: t.seq });
				} else if (fresh.has(t.workload_id)) {
					const repo = fresh.get(t.workload_id) ?? null;
					// No tracker applies: cached as such, never dirty, never projected (a later `tracker:` entry re-marks it).
					this.sidecar.upsertLink(t.workload_id, { repo, dirty: repo === null || this.trackerOf(t.workload_id, repo) !== null, lastSeq: t.seq });
				}
			}
			this.sidecar.setCursor(max);
		});
		this.report.ingested = touched.length;
	}

	// ---- GitHub steps ----

	/** A counted gh call that must succeed for GitHub's work to go on. */
	async need(args: string[]): Promise<string> {
		const r = await this.gh.run(args);
		if (!r.ok) {
			this.notice(r.error);
			throw new CallFailed(r.error, "github");
		}
		return r.out;
	}

	async rateLimit(): Promise<void> {
		const now = this.o.now();
		const checked = Number(this.sidecar.state(STATE.rateCheckedAt) ?? "0");
		if (now - checked >= HOUR_MS) {
			const out = await this.need(["api", "rate_limit", "--jq", ".resources.core.remaining"]);
			const remaining = Number.parseInt(out.trim(), 10);
			this.sidecar.immediate(() => {
				this.sidecar.setState(STATE.rateCheckedAt, String(now));
				this.sidecar.setState(STATE.rateRemaining, Number.isFinite(remaining) ? String(remaining) : null);
			});
		}
		const remaining = this.sidecar.state(STATE.rateRemaining);
		this.rateLow = remaining !== null && Number(remaining) < RATE_FLOOR;
		if (this.rateLow) this.notice(`GitHub rate limit low (${remaining} core calls left at the hourly read): issue pushes paused`);
	}

	async readDefaultBranch(repo: string): Promise<void> {
		const key = `${STATE.defaultBranch}:${repo}`;
		const cached = this.sidecar.state(key);
		if (cached) {
			this.defaultBranches.set(repo, cached);
			return;
		}
		const out = await this.need(["repo", "view", repo, "--json", "defaultBranchRef"]);
		let name: unknown;
		try {
			const v: unknown = JSON.parse(out);
			name = v !== null && typeof v === "object" && "defaultBranchRef" in v && v.defaultBranchRef !== null && typeof v.defaultBranchRef === "object" && "name" in v.defaultBranchRef ? v.defaultBranchRef.name : undefined;
		} catch {
			name = undefined;
		}
		if (typeof name !== "string" || name === "") {
			const why = `gh repo view ${repo} printed no default branch`;
			this.notice(why);
			throw new CallFailed(why, "github");
		}
		this.defaultBranches.set(repo, name);
		this.sidecar.immediate(() => this.sidecar.setState(key, name));
	}

	async ensureLabels(repo: string): Promise<void> {
		const why = await ensureGithubLabels(this.gh, this.sidecar, repo, PROJECTION_LABELS, `${STATE.labelsCreated}:${repo}`);
		if (why !== null) {
			this.notice(why);
			throw new CallFailed(why, "github");
		}
	}

	/**
	 * The repos GitHub work covers this tick: `issues` = repos with GitHub issues (every exact GitHub
	 * rule's repo, and each repo a link's item or effective tracker puts on GitHub), `scan` = every
	 * exact GitHub rule's repo plus the repo of each link that `scans` (a Linear link's too: its PRs
	 * close it by observation).
	 */
	githubRepos(): { issues: string[]; scan: string[] } {
		const issues = new Set<string>();
		const scan = new Set<string>();
		for (const r of this.o.config.trackers) if (r.tracker.kind === "github" && !r.match.endsWith("/*")) issues.add(r.match.toLowerCase());
		for (const r of issues) scan.add(r);
		for (const l of this.sidecar.links()) {
			if (l.repo === null || l.repo === NO_REPO) continue;
			const onGithub = l.tracker === "github" && l.issue_number !== null;
			if (onGithub) issues.add(l.repo);
			const t = this.trackerOf(l.workload_id, l.repo);
			if (t?.kind === "github") issues.add(l.repo);
			if ((t !== null || onGithub) && this.scans(l)) scan.add(l.repo);
		}
		return { issues: [...issues].sort(), scan: [...scan].sort() };
	}

	/**
	 * Whether a link keeps its repo in the open-PR scan. An open link does: its workload is open, or its
	 * item is (an awaiting-merge item of a closed workload, or one not pushed since the close). A
	 * closed link (closed workload, closed item) does only while both hold: its PR set held no MERGED
	 * PR at the last push (`pr_merged:<id>`, first merge wins) and the ledger's `closed_at` of its
	 * workload is under LATE_PR_WINDOW_MS ago; a PR opened in that window reopens it as awaiting-merge.
	 */
	scans(l: LinkRow): boolean {
		const w = this.ledger.workload(l.workload_id);
		if (!w) return false;
		if (w.status === "open" || l.pushed_state === null || l.pushed_state === "open") return true;
		if (this.sidecar.state(`${PR_MERGED}:${l.workload_id}`) !== null) return false;
		return !(this.o.now() - Date.parse(w.closed_at ?? w.changed_at) >= LATE_PR_WINDOW_MS);
	}

	/**
	 * Every repo's scan, then the sidecar's `pr_scan_unknown` (PR_SCAN_UNKNOWN): why this pass did not
	 * see every open PR (a truncated or failed scan, or a stop before a repo was scanned), or null after
	 * a complete pass. The reconciler reads it: an incomplete scan never lets a run say 0.
	 */
	async scanAll(repos: readonly string[]): Promise<void> {
		const unknown: string[] = [];
		try {
			for (const repo of repos) {
				const why = await this.scan(repo);
				if (why !== null) unknown.push(why);
			}
		} catch (err) {
			unknown.push(err instanceof CallFailed ? err.message : err instanceof TickStop ? `the scan stopped (${err.reason})` : String(err instanceof Error ? err.message : err));
			throw err;
		} finally {
			this.sidecar.immediate(() => this.sidecar.setState(PR_SCAN_UNKNOWN, unknown.length > 0 ? unknown.join("; ") : null));
		}
	}

	/**
	 * § 5: map every open same-repo PR in `repo` to a link, mark what changed, settle footers already
	 * present and requeue a removed one. Returns why the scan saw only part of the open PRs, or null.
	 */
	async scan(repo: string): Promise<string | null> {
		const s = await scanOpenPrs(this.gh, repo);
		if (!s.ok) {
			this.notice(`PR scan: ${s.error}`);
			throw new CallFailed(s.error, "github");
		}
		if (s.truncated) {
			this.notice(`PR scan: ${s.prs.length} open PRs on ${repo}, the scan's limit; nothing was marked from it`);
			return `${s.prs.length} open PRs on ${repo}, the scan's limit`;
		}
		const defaultBranch = this.defaultBranches.get(repo) ?? null;
		const mapped: { pr: (typeof s.prs)[number]; link: LinkRow; github: boolean }[] = [];
		const taken = new Set<number>();
		// Open items first: a PR an open and a closed workload could both claim goes to the open one.
		const open: LinkRow[] = [];
		const closed: LinkRow[] = [];
		for (const l of this.sidecar.links()) if (l.repo === repo) (l.pushed_state === null || l.pushed_state === "open" ? open : closed).push(l);
		for (const link of [...open, ...closed]) {
			if (!this.ledger.workload(link.workload_id)) continue;
			const t = this.trackerOf(link.workload_id, link.repo);
			if (t === null) continue;
			const src = prSources(this.ledger, link.workload_id);
			for (const pr of s.prs) {
				if (pr.crossRepository || taken.has(pr.number)) continue;
				if (!src.branches.includes(pr.head) && !src.requested.includes(pr.number)) continue;
				taken.add(pr.number);
				mapped.push({ pr, link, github: t.kind === "github" });
			}
		}
		const openNumbers = new Set(s.prs.map((p) => p.number));
		this.sidecar.immediate(() => {
			const db = this.sidecar.db;
			for (const { pr, link, github } of mapped) {
				const row = db.query<PrRow, [string, number]>("SELECT * FROM prs WHERE workload_id = ? AND number = ?").get(link.workload_id, pr.number);
				const footable = github && link.tracker === "github" && link.issue_number !== null && pr.base === defaultBranch;
				const footed = footable && hasFooter(pr.body, link.issue_number!);
				// Recomputed on every scan, so a retarget onto or off the default branch is followed. A Linear
				// link's PRs, and any PR off the default branch, get no footer (§ 5, § 13.2); a footer
				// removed from the body is owed again, restored by `footers`.
				const footer = !github || pr.base !== defaultBranch ? "none" : footed ? "done" : "pending";
				if (!row) {
					db.query("INSERT INTO prs (workload_id, number, url, base, footer) VALUES (?, ?, ?, ?, ?)").run(link.workload_id, pr.number, pr.url, pr.base, footer);
					this.sidecar.markDirty(link.workload_id);
				} else if (row.footer !== footer) {
					db.query("UPDATE prs SET base = ?, footer = ?, fails = 0, next_try_at = 0 WHERE workload_id = ? AND number = ?").run(pr.base, footer, link.workload_id, pr.number);
				} else if (row.base !== pr.base) {
					db.query("UPDATE prs SET base = ? WHERE workload_id = ? AND number = ?").run(pr.base, link.workload_id, pr.number);
				}
			}
			for (const row of this.sidecar.prs()) {
				if (openNumbers.has(row.number) || this.sidecar.link(row.workload_id)?.repo !== repo) continue;
				// Merged or closed since the last scan: the push reads the PR set from GitHub's own state.
				db.query("DELETE FROM prs WHERE workload_id = ? AND number = ?").run(row.workload_id, row.number);
				this.sidecar.markDirty(row.workload_id);
			}
		});
		return null;
	}

	/** Back a PR footer off; parked at `parkAfterFails` (one notice). Ends GitHub's work. */
	failFooter(row: PrRow, n: number, why: string): never {
		const fails = row.fails + 1;
		this.sidecar.immediate(() =>
			this.sidecar.db.query("UPDATE prs SET fails = ?, next_try_at = ? WHERE workload_id = ? AND number = ?").run(fails, this.o.now() + backoffMs(fails), row.workload_id, row.number),
		);
		this.notice(why);
		if (fails >= this.o.config.parkAfterFails) this.notice(`the Closes #${n} footer on ${row.url} is parked after ${fails} failures: ${why}`);
		throw new CallFailed(why, "github");
	}

	/** § 5 footer edits: each pending default-base PR whose link is on GitHub with an issue number, re-read now so a body edit since the scan is kept. */
	async footers(): Promise<void> {
		const rows = this.sidecar.db
			.query<PrRow, [number, number]>("SELECT * FROM prs WHERE footer = 'pending' AND next_try_at <= ? AND fails < ? ORDER BY workload_id, number")
			.all(this.o.now(), this.o.config.parkAfterFails);
		for (const row of rows) {
			const link = this.sidecar.link(row.workload_id);
			if (!link || link.tracker !== "github" || link.issue_number === null) continue;
			if (this.trackerOf(link.workload_id, link.repo)?.kind !== "github") continue;
			const n = link.issue_number;
			const view = await this.gh.json(["pr", "view", row.url, "--json", "body"]);
			if (!view.ok) this.failFooter(row, n, view.error);
			const v = view.value;
			if (v === null || typeof v !== "object" || !("body" in v) || typeof v.body !== "string") this.failFooter(row, n, `gh pr view ${row.url} printed no body`);
			const body = v.body;
			if (!hasFooter(body, n)) {
				const edit = await this.gh.run(["pr", "edit", row.url, "--body", body + closesFooter(n)]);
				if (!edit.ok) this.failFooter(row, n, edit.error);
			}
			this.sidecar.immediate(() =>
				this.sidecar.db.query("UPDATE prs SET footer = 'done', fails = 0, next_try_at = 0 WHERE workload_id = ? AND number = ?").run(row.workload_id, row.number),
			);
		}
	}

	// ---- push ----

	/** Back a link off; parked at `parkAfterFails` (one notice). */
	failLink(link: LinkRow, why: string): void {
		const fails = link.fails + 1;
		this.sidecar.immediate(() =>
			this.sidecar.db.query("UPDATE links SET fails = ?, next_try_at = ? WHERE workload_id = ?").run(fails, this.o.now() + backoffMs(fails), link.workload_id),
		);
		this.notice(why);
		if (fails >= this.o.config.parkAfterFails) this.notice(`${link.workload_id}'s issue is parked after ${fails} failed pushes: ${why}`);
	}

	/** Back the link off and end `kind`'s work this tick. */
	failed(link: LinkRow, why: string, kind: TrackerKind): never {
		this.failLink(link, why);
		throw new CallFailed(why, kind);
	}

	/** Record a successful push: the pushed fields are the render's, `pushed_seq` the `last_seq` it rendered (§ 13.3), `remote_hash` the item's, the link clean. */
	pushed(link: LinkRow, r: Rendered, item: Item): void {
		const number = "issueNumber" in item ? item.issueNumber : null;
		const external = "externalId" in item ? item.externalId : null;
		const ref = "issueRef" in item ? item.issueRef : null;
		const remoteHash = "remoteHash" in item ? item.remoteHash : null;
		this.sidecar.immediate(() =>
			this.sidecar.db
				.query(
					`UPDATE links SET issue_number = ?, external_id = ?, issue_ref = ?, pushed_hash = ?, pushed_title = ?, pushed_labels = ?, pushed_state = ?,
					        pushed_seq = ?, remote_hash = ?, dirty = 0, force = 0, fails = 0, next_try_at = 0 WHERE workload_id = ?`,
				)
				.run(number, external, ref, renderHash(r), r.title, JSON.stringify(r.labels), stateText(r), link.last_seq, remoteHash, link.workload_id),
		);
		this.report.pushed++;
	}

	/** An accepted intake issue whose input id the brief quotes and no link on `repo` holds yet (§ 6.2 binding). */
	boundIntake(brief: string, repo: string): number | null {
		const rows = this.sidecar.db
			.query<{ issue_number: number; in_id: string }, [string, string]>(
				"SELECT i.issue_number, i.in_id FROM intake i WHERE i.verdict = ? AND i.in_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM links l WHERE l.issue_number = i.issue_number AND l.repo = ?) ORDER BY i.issue_number",
			)
			.all(INTAKE_ACCEPTED, repo);
		return rows.find((r) => new RegExp(`(^|[^\\w-])${r.in_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(brief))?.issue_number ?? null;
	}

	/** The lost-create search (§ 3): an as2 issue on `repo` whose title starts `<id> —`, or null. */
	async findByTitle(repo: string, workloadId: string): Promise<{ ok: true; number: number | null } | { ok: false; error: string }> {
		const r = await this.gh.json(["issue", "list", "-R", repo, "--label", LABEL.as2, "--state", "all", "--search", `"${workloadId} —" in:title`, "--json", "number,title", "-L", "100"]);
		if (!r.ok) return r;
		if (!Array.isArray(r.value)) return { ok: false, error: "gh issue list printed no issue list" };
		for (const x of r.value) {
			if (x !== null && typeof x === "object" && "number" in x && "title" in x && typeof x.number === "number" && typeof x.title === "string" && x.title.startsWith(`${workloadId} —`)) {
				return { ok: true, number: x.number };
			}
		}
		return { ok: true, number: null };
	}

	/** The Linear team `key` for this tick: read once, every projection label made to exist in it (§ 13.2). */
	async team(link: LinkRow, key: string): Promise<LinearTeam> {
		const cached = this.teams.get(key);
		if (cached) return cached;
		const t = await this.linear.team(key);
		if (!t.ok) this.failed(link, t.error, "linear");
		const team = t.value;
		for (const name of LINEAR_LABELS) {
			if (team.labels.some((l) => l.name.toLowerCase() === name)) continue;
			const made = await this.linear.createLabel(team.id, name);
			if (!made.ok) this.failed(link, made.error, "linear");
			team.labels.push(made.value);
		}
		this.teams.set(key, team);
		return team;
	}

	/**
	 * The move comment on the old item, posted once (§ 13.2). `move_commenting:<id>` is written before
	 * the post and `move_commented:<id>` after it. A retry that finds the first without the second
	 * (a crash or a failed sidecar write in between) reads the old item's comments first (`present`,
	 * one counted call) and posts only when the comment is not there.
	 */
	async commentOnce(
		link: LinkRow,
		note: string,
		kind: TrackerKind,
		present: () => Promise<{ ok: true; value: boolean } | { ok: false; error: string }>,
		post: () => Promise<{ ok: true } | { ok: false; error: string }>,
	): Promise<void> {
		const done = `${MOVE_COMMENTED}:${link.workload_id}`;
		const started = `${MOVE_COMMENTING}:${link.workload_id}`;
		if (this.sidecar.state(done) === note) return;
		if (this.sidecar.state(started) === note) {
			const p = await present();
			if (!p.ok) this.failed(link, p.error, kind);
			if (p.value) {
				this.sidecar.immediate(() => this.sidecar.setState(done, note));
				return;
			}
		} else {
			this.sidecar.immediate(() => this.sidecar.setState(started, note));
		}
		const c = await post();
		if (!c.ok) this.failed(link, c.error, kind);
		this.sidecar.immediate(() => this.sidecar.setState(done, note));
	}

	/**
	 * A tracker change (§ 13.2 move): the old item is closed not planned with one comment naming the
	 * new place; on GitHub, every open PR in the set whose body ends with exactly the machinery's
	 * `closesFooter(old)` gets that suffix stripped first (any other footer is left and counted as
	 * drift). Then, in one sidecar transaction, the link's tracker changes, its item ids are cleared
	 * (the old one kept in `moved_from`), its PR rows dropped, and it stays dirty: the next push
	 * creates the new item. The comment is posted once (`commentOnce`), so a retry after a later step
	 * failed, or after a crash between the post and its marker, does not post it again; the move
	 * clears both markers.
	 */
	async move(link: LinkRow, to: Tracker | null): Promise<void> {
		const id = link.workload_id;
		const comment = `${id} moved to ${placeOf(to, link.repo)}; this issue is no longer updated.`;
		const drift: string[] = [];
		let from: string;
		if (link.issue_number !== null && link.repo !== null) {
			const old = link.issue_number;
			const repo = link.repo;
			const set = await readPrSet(this.gh, repo, prSources(this.ledger, id));
			if (!set.known) this.failed(link, `${id}: PR set unknown: ${set.why}`, "github");
			for (const pr of set.prs.filter((p) => p.state === "OPEN")) {
				const view = await this.gh.json(["pr", "view", pr.url, "--json", "body"]);
				if (!view.ok) this.failed(link, view.error, "github");
				const v = view.value;
				const body = v !== null && typeof v === "object" && "body" in v && typeof v.body === "string" ? v.body : null;
				if (body === null) this.failed(link, `gh pr view ${pr.url} printed no body`, "github");
				const stripped = stripFooter(body, old);
				if (stripped !== null) {
					const edit = await this.gh.run(["pr", "edit", pr.url, "--body", stripped]);
					if (!edit.ok) this.failed(link, edit.error, "github");
				} else if (hasFooter(body, old)) {
					drift.push(`${id}: ${pr.url} still carries the Closes #${old} footer, not as its body's suffix; left as it is`);
				}
			}
			from = `github:${repo}#${old}`;
			const note = `${from} ${comment}`;
			await this.commentOnce(
				link,
				note,
				"github",
				async () => {
					const r = await this.gh.json(["issue", "view", String(old), "-R", repo, "--json", "comments"]);
					if (!r.ok) return r;
					const v = r.value;
					const list = v !== null && typeof v === "object" && "comments" in v && Array.isArray(v.comments) ? v.comments : null;
					if (list === null) return { ok: false, error: `gh issue view ${old} printed no comment list` };
					return { ok: true, value: list.some((c: unknown) => c !== null && typeof c === "object" && "body" in c && typeof c.body === "string" && c.body.trim() === comment) };
				},
				() => this.gh.run(["issue", "comment", String(old), "-R", repo, "--body", comment]),
			);
			const closed = await this.gh.run(["issue", "close", String(old), "-R", repo, "-r", "not planned"]);
			if (!closed.ok) this.failed(link, closed.error, "github");
		} else if (link.external_id !== null) {
			const old = parseTrackerKey(link.tracker ?? "");
			if (!old || old.kind !== "linear") this.failed(link, `${id}: its Linear issue has no team (tracker ${link.tracker})`, "linear");
			const team = await this.team(link, old.team);
			const canceled = linearStateFor({ state: "closed", reason: "not planned", labels: [] }, team.states);
			from = `linear:${link.issue_ref ?? link.external_id}`;
			const note = `${from} ${comment}`;
			const ext = link.external_id;
			await this.commentOnce(
				link,
				note,
				"linear",
				() => this.linear.hasComment(ext, comment),
				() => this.linear.comment(ext, comment),
			);
			if (canceled) {
				const u = await this.linear.update(link.external_id, { stateId: canceled.id });
				if (!u.ok) this.failed(link, u.error, "linear");
			}
		} else return;
		this.gh.fence();
		const key = to === null ? null : trackerKey(to);
		this.sidecar.immediate(() => {
			this.sidecar.db
				.query(
					`UPDATE links SET tracker = ?, issue_number = NULL, external_id = NULL, issue_ref = NULL, moved_from = ?,
					        pushed_hash = NULL, pushed_title = NULL, pushed_labels = NULL, pushed_state = NULL, pushed_seq = NULL, remote_hash = NULL,
					        dirty = 1, force = 0, fails = 0, next_try_at = 0 WHERE workload_id = ?`,
				)
				.run(key, from, id);
			this.sidecar.db.query("DELETE FROM prs WHERE workload_id = ?").run(id);
			this.sidecar.setState(`${MOVE_COMMENTED}:${id}`, null);
			this.sidecar.setState(`${MOVE_COMMENTING}:${id}`, null);
			if (drift.length > 0) {
				const prior: unknown = JSON.parse(this.sidecar.state(STATE.moveDrift) ?? "[]");
				this.sidecar.setState(STATE.moveDrift, JSON.stringify([...(Array.isArray(prior) ? prior : []), ...drift]));
			}
		});
		this.notice(`${id}'s issue moved from ${from} to ${placeOf(to, link.repo)}${drift.length > 0 ? ` (${drift.length} PR footer${drift.length === 1 ? "" : "s"} left as drift)` : ""}`);
	}

	async pushLink(start: LinkRow): Promise<void> {
		let link = start;
		const id = link.workload_id;
		if (link.repo === null) {
			const repo = await resolveRepo(this.o.exec, this.ledger, id);
			if (repo === null) {
				this.failLink(link, `${id}: git could not read its repo's origin`);
				return;
			}
			this.sidecar.immediate(() => this.sidecar.db.query("UPDATE links SET repo = ? WHERE workload_id = ?").run(repo, id));
			link = { ...link, repo };
		}
		const w = this.ledger.workload(id);
		if (!w) {
			this.sidecar.immediate(() => this.sidecar.deleteLink(id));
			return;
		}
		const repo = link.repo!;
		const onGithub = repo !== NO_REPO;
		const to = this.trackerOf(id, repo);
		const toKey = to === null ? null : trackerKey(to);
		if (link.tracker !== toKey) {
			if (link.issue_number !== null || link.external_id !== null) {
				// The old item's tracker must be up this tick: GitHub (closing and footer edits), or Linear.
				if (link.issue_number !== null ? !this.githubUp : this.stops.has("linear")) return;
				await this.move(link, to);
				link = this.sidecar.link(id)!;
			} else {
				this.sidecar.immediate(() => this.sidecar.db.query("UPDATE links SET tracker = ? WHERE workload_id = ?").run(toKey, id));
				link = { ...link, tracker: toKey };
			}
		}
		if (to === null) {
			// No tracker applies: nothing to push; a later `tracker:` entry (provenance on the workload) marks it again.
			this.sidecar.immediate(() => this.sidecar.db.query("UPDATE links SET dirty = 0 WHERE workload_id = ?").run(id));
			return;
		}
		if (this.stops.has(to.kind) || (onGithub && !this.githubUp)) return;
		const set: PrSet = onGithub ? await readPrSet(this.gh, repo, prSources(this.ledger, id)) : { known: true, prs: [] };
		// Unknown set: no render change at all; backed off like a failure.
		if (!set.known) this.failed(link, `${id}: PR set unknown: ${set.why}`, "github");
		const r = renderWorkload(this.ledger, id, set.prs, link.last_seq)!;
		if (link.issue_number === null && link.external_id === null && r.state === "closed") {
			// Opened and closed while never pushed: an issue is never created only to be closed.
			this.sidecar.immediate(() => this.sidecar.deleteLink(id));
			return;
		}
		const merged = set.prs.find((p) => p.state === "MERGED");
		const mergedKey = `${PR_MERGED}:${id}`;
		// First merge wins: once the set holds a MERGED PR it always will, and a closed link stops scanning (`scans`).
		if (merged && this.sidecar.state(mergedKey) === null) this.sidecar.immediate(() => this.sidecar.setState(mergedKey, merged.url));
		if (to.kind === "github") await this.pushGithub(link, w.brief, repo, r);
		else await this.pushLinear(link, to.team, r);
	}

	/** The push found nothing to change (§ 13.3: a no-diff push still writes its receipt). */
	clean(link: LinkRow): void {
		this.sidecar.immediate(() => this.sidecar.db.query("UPDATE links SET dirty = 0, pushed_seq = ? WHERE workload_id = ?").run(link.last_seq, link.workload_id));
		this.report.pushed++;
	}

	async pushGithub(start: LinkRow, brief: string, repo: string, r: Rendered): Promise<void> {
		let link = start;
		const id = link.workload_id;
		let number = link.issue_number;
		if (number === null) {
			const intake = intakeRepo(this.o.config);
			let found = intake !== null && intake.toLowerCase() === repo ? this.boundIntake(brief, repo) : null;
			if (found === null) {
				const search = await this.findByTitle(repo, id);
				if (!search.ok) this.failed(link, search.error, "github");
				found = search.number;
			}
			if (found === null) {
				this.gh.fence();
				const created = await this.gh.run(["issue", "create", "-R", repo, "--title", r.title, "--body", r.block, ...r.labels.flatMap((l) => ["--label", l])]);
				if (!created.ok) this.failed(link, created.error, "github");
				const m = /\/issues\/(\d+)\s*$/.exec(created.out.trim());
				// The issue may exist: the next push's title search adopts it.
				if (!m) this.failed(link, `gh issue create printed no issue url (${created.out.trim().split("\n")[0] || "no output"})`, "github");
				this.gh.fence();
				this.pushed(link, r, { issueNumber: Number(m[1]) });
				return;
			}
			this.gh.fence();
			const adopted = found;
			this.sidecar.immediate(() => this.sidecar.db.query("UPDATE links SET issue_number = ?, force = 1 WHERE workload_id = ?").run(adopted, id));
			number = adopted;
			link = { ...link, issue_number: adopted, force: 1 };
		}
		if (!link.force && renderHash(r) === link.pushed_hash) {
			this.clean(link);
			return;
		}
		await this.editGithub(link, repo, number, r);
	}

	/** Re-read the remote issue and make it match the render: one edit for fields, then the state. */
	async editGithub(link: LinkRow, repo: string, n: number, r: Rendered): Promise<void> {
		const step = async (args: string[]): Promise<unknown> => {
			const out = args[1] === "view" ? await this.gh.json(args) : await this.gh.run(args);
			if (!out.ok) this.failed(link, out.error, "github");
			return "value" in out ? out.value : out.out;
		};
		const view = await step(["issue", "view", String(n), "-R", repo, "--json", "title,body,labels,state,stateReason"]);
		const remote = remoteIssue(view);
		if (remote === null) this.failed(link, `gh issue view ${n} printed no issue`, "github");
		const edits: string[] = [];
		if (remote.title !== r.title) edits.push("--title", r.title);
		const body = mergeBody(remote.body, r.block);
		if (body !== remote.body) edits.push("--body", body);
		const add = r.labels.filter((l) => !remote.labels.includes(l));
		const remove = remote.labels.filter((l) => PROJECTION_LABELS.includes(l) && !r.labels.includes(l));
		if (add.length > 0) edits.push("--add-label", add.join(","));
		if (remove.length > 0) edits.push("--remove-label", remove.join(","));
		if (edits.length > 0) await step(["issue", "edit", String(n), "-R", repo, ...edits]);
		const close = ["issue", "close", String(n), "-R", repo, "-r", r.reason ?? "completed"];
		const reopen = ["issue", "reopen", String(n), "-R", repo];
		if (r.state === "open" && remote.state !== "OPEN") await step(reopen);
		else if (r.state === "closed" && remote.state === "OPEN") await step(close);
		else if (r.state === "closed" && remote.reason !== r.reason) {
			// Closed on both sides with another reason: reopen, then close with the rendered one (§ 3).
			await step(reopen);
			await step(close);
		}
		this.pushed(link, r, { issueNumber: n });
	}

	/**
	 * A Linear push (§ 13.2): the same title and block as GitHub, the same projection labels, and
	 * the workflow state the render maps to by type. No issue id ⇒ the lost-create search by title,
	 * else a create. With one: when forced or the render changed, the issue is read back and one
	 * update carries the fields that differ (Jo's description outside the markers kept, Jo's other
	 * labels kept).
	 */
	async pushLinear(start: LinkRow, teamKey: string, r: Rendered): Promise<void> {
		let link = start;
		const id = link.workload_id;
		if (!this.linear.hasKey) this.failed(link, `${id}: LINEAR_API_KEY is not set; its Linear issue cannot be pushed`, "linear");
		const team = await this.team(link, teamKey);
		const state = linearStateFor(r, team.states);
		if (state === null) this.failed(link, `Linear team ${teamKey} has no workflow state for ${stateText(r)}`, "linear");
		const labelIds = (names: readonly string[]) => team.labels.filter((l) => names.includes(l.name.toLowerCase())).map((l) => l.id);
		let issueId = link.external_id;
		if (issueId === null) {
			const search = await this.linear.findByTitle(teamKey, `${id} —`);
			if (!search.ok) this.failed(link, search.error, "linear");
			if (search.value === null) {
				this.linear.fence();
				const created = await this.linear.create(team.id, { title: r.title, description: r.block, labelIds: labelIds(r.labels), stateId: state.id });
				if (!created.ok) this.failed(link, created.error, "linear");
				this.linear.fence();
				const stored = created.value.description;
				this.pushed(link, r, { externalId: created.value.id, issueRef: created.value.identifier, remoteHash: stored === null ? null : blockHash(stored) });
				return;
			}
			this.linear.fence();
			const adopted = search.value;
			this.sidecar.immediate(() => this.sidecar.db.query("UPDATE links SET external_id = ?, issue_ref = ?, force = 1 WHERE workload_id = ?").run(adopted.id, adopted.identifier, id));
			issueId = adopted.id;
			link = { ...link, external_id: adopted.id, issue_ref: adopted.identifier, force: 1 };
		}
		if (!link.force && renderHash(r) === link.pushed_hash) {
			this.clean(link);
			return;
		}
		const remote = await this.linear.read(issueId);
		if (!remote.ok) this.failed(link, remote.error, "linear");
		let labels = remote.value.labels;
		if (!remote.value.labelsComplete) {
			// More labels than the read's page: the whole set is read before an update replaces it, so none of Jo's is dropped.
			const all = await this.linear.labels(issueId);
			if (!all.ok) this.failed(link, all.error, "linear");
			labels = all.value;
		}
		const input: { title?: string; description?: string; labelIds?: string[]; stateId?: string } = {};
		if (remote.value.title !== r.title) input.title = r.title;
		// The read-back description: Linear may normalise Markdown outside the block, and only the block is replaced.
		const description = mergeBody(remote.value.description, r.block);
		if (description !== remote.value.description) input.description = description;
		const keep = labels.filter((l) => !LINEAR_LABELS.includes(l.name.toLowerCase())).map((l) => l.id);
		const want = [...keep, ...labelIds(r.labels)].sort();
		if (JSON.stringify(want) !== JSON.stringify(labels.map((l) => l.id).sort())) input.labelIds = want;
		if (remote.value.state?.id !== state.id) input.stateId = state.id;
		// The block as Linear holds it after this push: the update's reply when it wrote the description, else the
		// read-back (its block is the render's already). The reconciler compares the remote block with this hash.
		let stored: string | null = remote.value.description;
		if (Object.keys(input).length > 0) {
			const u = await this.linear.update(issueId, input);
			if (!u.ok) this.failed(link, u.error, "linear");
			if (input.description !== undefined) stored = u.value.description;
		}
		this.pushed(link, r, { externalId: issueId, issueRef: link.issue_ref ?? remote.value.identifier, remoteHash: stored === null ? null : blockHash(stored) });
	}

	async push(): Promise<void> {
		const rows = this.sidecar.db
			.query<LinkRow, [number, number]>("SELECT * FROM links WHERE dirty = 1 AND next_try_at <= ? AND fails < ? ORDER BY priority DESC, last_seq, workload_id")
			.all(this.o.now(), this.o.config.parkAfterFails);
		for (const link of rows) {
			if (this.stops.has("github") && this.stops.has("linear")) return;
			try {
				await this.pushLink(link);
			} catch (err) {
				if (err instanceof TickStop && err.reason === "budget") this.stop(err.kind, "budget");
				else if (err instanceof CallFailed) this.stop(err.kind, "failed");
				else throw err;
			}
		}
	}

	phaseContext(sw: SwitchState): PhaseContext {
		const intake = intakeRepo(this.o.config);
		return {
			config: this.o.config,
			sidecar: this.sidecar,
			gh: this.gh,
			linear: this.linear,
			ledger: this.ledger,
			exec: this.o.exec,
			now: this.o.now,
			notice: this.notice,
			switchState: sw,
			intakeRepo: intake,
			defaultBranch: intake === null ? null : (this.defaultBranches.get(intake.toLowerCase()) ?? null),
			rateLow: this.rateLow,
			stopped: this.stops,
			prSet: async (workloadId) => {
				const repo = this.sidecar.link(workloadId)?.repo ?? null;
				return repo === null || repo === NO_REPO ? { known: true, prs: [] } : readPrSet(this.gh, repo, prSources(this.ledger, workloadId));
			},
			renderOf: (workloadId, prs) => renderWorkload(this.ledger, workloadId, prs, this.sidecar.link(workloadId)?.last_seq ?? 0),
		};
	}
}

interface RemoteIssue {
	title: string;
	body: string;
	labels: string[];
	state: string;
	reason: string | null;
}

/** `gh issue view --json title,body,labels,state,stateReason`, or null when it does not have that shape. */
function remoteIssue(v: unknown): RemoteIssue | null {
	if (v === null || typeof v !== "object" || !("title" in v) || !("state" in v)) return null;
	if (typeof v.title !== "string" || typeof v.state !== "string") return null;
	const body = "body" in v && typeof v.body === "string" ? v.body : "";
	const labels = "labels" in v && Array.isArray(v.labels) ? v.labels.flatMap((l: unknown) => (l !== null && typeof l === "object" && "name" in l && typeof l.name === "string" ? [l.name] : [])) : [];
	const raw = "stateReason" in v && typeof v.stateReason === "string" ? v.stateReason.toUpperCase() : "";
	const reason = raw === "COMPLETED" ? "completed" : raw === "NOT_PLANNED" ? "not planned" : null;
	return { title: v.title, body, labels, state: v.state.toUpperCase(), reason };
}

/**
 * One projector tick (header). Never throws for tracker trouble: a failed call backs off what it
 * was for and ends that tracker's work, a budget stop ends that tracker's work quietly, a claim stop
 * ends the tick. A ledger or sidecar error throws to the row, which turns it into one notice.
 */
export async function tick(o: TickOptions): Promise<TickReport> {
	if (!o.sidecar.claim(o.holder, o.now())) return { claimed: false, on: false, seeded: false, ingested: 0, pushed: 0, stopped: null, calls: 0 };
	const t = new Tick(o);
	try {
		const sw = readSwitch(o.ledger);
		t.report.on = sw.on;
		let seeded = o.sidecar.state(STATE.seededAt) !== null;
		if (sw.on && !seeded) {
			await t.seed(sw);
			seeded = true;
		}
		await t.ingest(seeded);
		if (!sw.on) return t.report;
		try {
			try {
				await t.rateLimit();
				const repos = t.githubRepos();
				for (const repo of repos.issues) {
					await t.readDefaultBranch(repo);
					await t.ensureLabels(repo);
				}
				if (!t.rateLow) {
					await t.scanAll(repos.scan);
					await t.footers();
				}
			} catch (err) {
				if (err instanceof TickStop && err.reason === "budget") t.stop("github", "budget");
				else if (err instanceof CallFailed) t.stop("github", "failed");
				else throw err;
			}
			await t.push();
			const ctx = t.phaseContext(sw);
			for (const [name, phase] of [["reconcile", o.phases?.reconcile], ["intake", t.stops.has("github") ? undefined : o.phases?.intake]] as const) {
				if (!phase) continue;
				try {
					await phase(ctx);
				} catch (err) {
					if (err instanceof TickStop || err instanceof CallFailed) throw err;
					t.notice(`the ${name} phase failed: ${String(err instanceof Error ? err.message : err)}`);
				}
			}
		} catch (err) {
			if (err instanceof TickStop) t.report.stopped ??= err.reason;
			else if (err instanceof CallFailed) t.report.stopped ??= "failed";
			else throw err;
		}
		return t.report;
	} finally {
		t.report.calls = t.gh.calls + t.linear.calls;
		o.sidecar.release(o.holder);
	}
}
