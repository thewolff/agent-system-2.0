// The reconciler (PLAN wl-mv66ylim0gahog § 4, § 13.2): every `reconcileEveryMin` while the switch is
// on, the projector's `reconcile` phase compares every tracker item with the render of the ledger
// now, records one `issues-drift:` entry on wl-orchestrator, and marks what drifted so the next
// push repairs it. `surface/scripts/issues.ts check` runs the same comparison read-only.
//
// Per tracker:
// - GitHub, per repo (every exact GitHub rule's repo, each repo a link's issue or an open workload's
//   tracker puts on GitHub, and the own repo of each closed workload an `issues.overrides` key or a
//   `tracker:` entry routes to GitHub): one `gh issue list --label as2 --state all -L 1000` with
//   bodies; 1000 rows back is unknown, never a partial count. A linked issue missing from that list
//   (its `as2` label removed, or deleted) is read by number: found ⇒ compared like the rest; not
//   found ⇒ one line, and its number is cleared so the next push creates it again (the ledger is
//   the truth). An owner-glob GitHub rule names no repo: a closed workload it alone routes is not read.
// - Linear, per team a link or an open workload is on: every `as2`-labelled issue of the team
//   (`listLabelled`, 250 a page, every page), the team's workflow states, and each linked issue
//   missing from the list read by id (not found ⇒ cleared, as on GitHub). Each other team an
//   `issues.trackers` rule names, or a closed workload's override or `tracker:` entry routes to, is
//   listed the same way (its states are not read: it holds no linked item), so an orphan there is seen.
// Each linked item is compared field by field (title, the machine block, the projection's labels,
// state) with the render. Its PR facts never come from the remote alone: the PR lines of the item's
// own block are taken only when the link is not dirty, the sidecar's PR rows for the workload (the
// open PRs the scan mapped) are exactly the block's open PRs, and the render they give hashes to the
// link's `pushed_hash` (exactly the set the last push wrote, the ledger unchanged since); otherwise,
// and always for a closed workload whose issue was open (awaiting merge) or never pushed, the PR set
// is read from GitHub as the push reads it, and a set that cannot be read makes the run unknown. So a
// PR the scan found while the push backs off or is parked is drift, never a stale 0. Linear
// normalises description Markdown on write, so a Linear item's block is compared with the link's
// `remote_hash` (the block Linear returned from the last push) when the link is clean and the render
// hashes to its `pushed_hash`; else byte for byte with the render, as on GitHub. A Linear item
// with labels past the one page read (`labelsComplete` false) has its whole label set read
// (`labels`, every page) and compared; a failed label read is unknown. A difference is one line;
// the link gets `dirty = force = 1, fails = 0`, so the push
// re-reads the remote and edits it although the ledger did not change. Also one line each: an open
// item labelled `as2` whose `wl-` title names no ledger workload (reported, never closed); an open
// item labelled `as2` naming a closed workload with no item linked, on that workload's tracker (it
// is adopted: the phase links it, dirty and forced, so the next push closes it as the render says;
// elsewhere it is left as it is, uncounted); an open item labelled `as2` naming a closed workload
// that holds another item (left open); an open workload with no item on its tracker (its link
// marked dirty); an item on a tracker that is no
// longer the workload's (the push moves it); a PR footer
// still pending; each footer a tracker move left (`STATE.moveDrift`, reported once, then cleared).
// Jo reopening the item of a closed workload is drift repaired toward closed, with one comment.
// Listed below the drift lines and not counted: § 13.3 turn rows that got their notice
// (`turnDrift`, phase only; marked carried only after the entry carrying them is written, so a
// failed or interrupted write leaves them for the next entry) and `intake: <K> ignored (<reasons>)`
// since the last run.
//
// Never 0 when anything was unknown: a failed read, the GitHub rate limit under the floor, a PR set
// that could not be read, the projector's last open-PR scan incomplete (`PR_SCAN_UNKNOWN`: truncated
// or failed, recorded as `pr scan: <why>`), or a budget that ran out make the run `unknown (<why>)`.
// A tracker whose work the tick already stopped (`stopped`: budget or failed) is never called: a
// tracker the run would read is `<kind> <reason>` (and a PR set it would read from a stopped GitHub
// is unknown), the other tracker is still compared, and the run's cadence moves as for any run.
// A budget stop is recorded, then rethrown; a lost claim records nothing and propagates. Drift (or
// unknown) on two consecutive runs is one tick notice, told once until a run comes back 0.
import type { Ledger } from "../../../ledger/src/index";
import { ensureStandingWorkload } from "../identity";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../types";
import { type IssuesConfig, type Tracker, trackerKey } from "./config";
import { TickStop } from "./github";
import { type LinearIssue, type LinearTeam, LINEAR_LABELS, linearStateFor } from "./linear";
import { type PhaseContext, PR_SCAN_UNKNOWN, resolveRepo, RATE_FLOOR } from "./projector";
import { blockHash, type CloseReason, LABEL, machineBlock, mergeBody, type PrFact, type PrState, PROJECTION_LABELS, type Rendered, renderHash, stateText } from "./render";
import { INTAKE_IGNORED, type LinkRow, STATE, type Sidecar, type TrackerKind } from "./sidecar";
import { effectiveTracker, linkTracker, NO_REPO } from "./tracker";
import { markTurnDrift, turnDrift } from "./turnend";

const MIN = 60_000;
/** A label list this long may be cut short: the run is unknown (§ 4). */
export const ISSUE_LIST_LIMIT = 1000;
/** Lines the drift entry carries; the count is always the whole number. */
export const ENTRY_LINES = 20;
/** The drift entry's prefix on wl-orchestrator. */
export const DRIFT_PREFIX = "issues-drift:";

/** What `gh issue view` prints for a number the repo does not have, or an issue deleted. */
const GH_NOT_FOUND = /could not resolve to an? (issue|pull request)|this issue was deleted/i;
/** What Linear answers for an issue id it does not have (or one in the trash). */
const LINEAR_NOT_FOUND = /entity not found/i;
const TITLE_ID = /^(wl-[a-z0-9]+) —/;

/** The sidecar as the drift computation reads it: the tick's own, or the check script's read-only view. */
export type DriftSidecar = Pick<Sidecar, "db" | "links" | "link" | "prs" | "state">;

/** What the drift computation needs: the phase context, or the check script's read-only equivalent (no `stopped`: nothing stopped). */
export type DriftSource = Pick<PhaseContext, "config" | "ledger" | "gh" | "linear" | "exec" | "rateLow" | "prSet" | "renderOf"> & {
	sidecar: DriftSidecar;
	/** The trackers whose work ended this tick, with why: never called by the run. */
	stopped?: ReadonlyMap<TrackerKind, "budget" | "failed">;
};

export interface Drift {
	/** One line per difference, each naming its tracker. */
	lines: string[];
	/** Why the count is unknown, once each; empty when every read answered. */
	unknown: string[];
	/** Links to mark `dirty = force = 1, fails = 0` (their item differs from the render). */
	force: Set<string>;
	/** Links to mark dirty with `fails = 0` (no item where one belongs, or a move pending); `repo` for a workload with no link yet. */
	dirty: Map<string, { repo: string | null; lastSeq: number }>;
	/** Links whose item is gone from its tracker: the item ids are cleared, so the next push creates it again. */
	gone: Set<string>;
	/**
	 * Links to write for an open `as2` item that names a closed workload with no item linked, on that
	 * workload's tracker (one per workload): the item's ids, `dirty = force = 1, fails = 0`, so the
	 * next push reads the remote and closes it per the render. Applied by the phase, never by the check.
	 */
	adopt: Map<string, Adoption>;
	/** One comment each, posted by the phase: Jo reopened the item of a closed workload. */
	comments: { workloadId: string; post: () => Promise<{ ok: true } | { ok: false; error: string }> }[];
	/** `intake: <K> ignored (<reasons>)` for issues intake ignored since the last run, or null. */
	intake: string | null;
	/** § 13.3 turn rows that got their notice and no entry carried yet (`turnDrift`): listed, not counted. The phase fills it. */
	turns: string[];
	/** The tracker-move drift lines read from `STATE.moveDrift` (cleared once recorded). */
	moveDrift: number;
	/** The first budget stop the computation caught; the phase rethrows it after recording. */
	stop: TickStop | null;
}

/** An item the phase links to a closed workload that had none (`Drift.adopt`). */
export interface Adoption {
	repo: string | null;
	/** `github` or `linear:<TEAM>`. */
	tracker: string;
	issueNumber: number | null;
	externalId: string | null;
	issueRef: string | null;
	lastSeq: number;
}

/** The drift count, or null when the run is unknown (a dead instrument never reads 0). */
export function driftCount(d: Pick<Drift, "lines" | "unknown">): number | null {
	return d.unknown.length > 0 ? null : d.lines.length;
}

/** `<N>` or `unknown (<why>)`: the head of the entry and of the check's report. */
export function driftHead(d: Pick<Drift, "lines" | "unknown">): string {
	const n = driftCount(d);
	return n === null ? `unknown (${d.unknown.join("; ")})` : String(n);
}

/** The lines below the head: the first ENTRY_LINES drift lines, how many more, the turn lines and the intake line. */
export function driftDetail(d: Pick<Drift, "lines" | "intake" | "turns">): string[] {
	const out = d.lines.slice(0, ENTRY_LINES);
	if (d.lines.length > ENTRY_LINES) out.push(`… and ${d.lines.length - ENTRY_LINES} more`);
	out.push(...d.turns);
	if (d.intake !== null) out.push(d.intake);
	return out;
}

/** The entry body: `issues-drift: <N> at <iso>` (or `unknown (<why>)`), then the detail lines. */
export function driftEntryBody(d: Pick<Drift, "lines" | "unknown" | "intake" | "turns">, at: string): string {
	return [`${DRIFT_PREFIX} ${driftHead(d)} at ${at}`, ...driftDetail(d)].join("\n");
}

/**
 * The PRs a machine block lists (`- <url> <state>`, the render's own lines; Linear stores them as
 * `* [<url>](<<url>>) <state>`), as the push last wrote them; [] when the body has no complete block.
 * The base is not in the block and is not rendered.
 */
export function prsOfBlock(body: string): PrFact[] {
	const block = machineBlock(body);
	if (block === null) return [];
	const out: PrFact[] = [];
	for (const line of block.split("\n")) {
		const m = /^[-*] (?:(\S+\/pull\/(\d+))|\[(\S+\/pull\/(\d+))\]\(<\3>\)) (open|merged|closed)$/.exec(line.trim());
		if (m) out.push({ number: Number(m[2] ?? m[4]), url: (m[1] ?? m[3])!, state: m[5]!.toUpperCase() as PrState, base: "" });
	}
	return out;
}

interface RemoteGh {
	title: string;
	body: string;
	labels: string[];
	/** `OPEN` or `CLOSED`. */
	state: string;
	reason: CloseReason | null;
}

const at = (v: unknown, key: string): unknown => (v !== null && typeof v === "object" ? Reflect.get(v, key) : undefined);

/** `gh issue list|view --json title,body,labels,state,stateReason` (one issue), or null without that shape. */
function remoteGh(v: unknown): RemoteGh | null {
	const title = at(v, "title");
	const state = at(v, "state");
	if (typeof title !== "string" || typeof state !== "string") return null;
	const body = at(v, "body");
	const labels = at(v, "labels");
	const raw = at(v, "stateReason");
	const reason = typeof raw === "string" ? raw.toUpperCase() : "";
	return {
		title,
		body: typeof body === "string" ? body : "",
		labels: Array.isArray(labels) ? labels.flatMap((l: unknown) => (typeof at(l, "name") === "string" ? [at(l, "name") as string] : [])) : [],
		state: state.toUpperCase(),
		reason: reason === "COMPLETED" ? "completed" : reason === "NOT_PLANNED" ? "not planned" : null,
	};
}

const list = (xs: readonly string[]): string => `[${xs.join(", ")}]`;
const same = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const LINEAR_DONE: Record<string, true> = { completed: true, canceled: true };

/** A workload as the computation sees it: its link (or null), cached repo and effective tracker. */
interface Subject {
	id: string;
	open: boolean;
	link: LinkRow | null;
	repo: string | null;
	tracker: Tracker | null;
}

class Run {
	readonly d: Drift = { lines: [], unknown: [], force: new Set(), dirty: new Map(), gone: new Set(), adopt: new Map(), comments: [], intake: null, turns: [], moveDrift: 0, stop: null };
	/** Every link, and every open workload (with or without a link). */
	readonly subjects = new Map<string, Subject>();
	/** Closed workloads with no link (or an unresolved repo) an orphan named or a route names, resolved as `load` resolves an open workload. */
	readonly closed = new Map<string, Subject>();
	/** GitHub repos and Linear teams that no link or open workload names and an orphan may be on (`loadRouted`). */
	readonly routed = { repos: new Set<string>(), teams: new Set<string>() };

	constructor(readonly s: DriftSource) {}

	get ledger(): Ledger {
		return this.s.ledger;
	}
	get config(): IssuesConfig {
		return this.s.config;
	}

	unknown(why: string): void {
		if (!this.d.unknown.includes(why)) this.d.unknown.push(why);
	}

	/** `<kind> <reason>` when the tick stopped `kind`'s work (the run makes no call to it), else null. */
	stoppedWhy(kind: TrackerKind): string | null {
		const why = this.s.stopped?.get(kind);
		return why === undefined ? null : `${kind} ${why}`;
	}

	/** Run one tracker's reads; a budget stop makes the run unknown and ends that part; a lost claim propagates. */
	async guarded(fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (err) {
			if (!(err instanceof TickStop) || err.reason !== "budget") throw err;
			this.unknown(`the ${err.kind} call budget ran out (${err.detail})`);
			this.d.stop ??= err;
		}
	}

	async load(): Promise<void> {
		for (const link of this.s.sidecar.links()) {
			const w = this.ledger.workload(link.workload_id);
			if (!w) continue;
			this.subjects.set(link.workload_id, { id: link.workload_id, open: w.status === "open", link, repo: link.repo, tracker: linkTracker(this.ledger, this.config, link.workload_id, link.repo) });
		}
		const open = this.ledger.db
			.query<{ id: string }, [string]>("SELECT id FROM workloads WHERE status = 'open' AND id <> ? ORDER BY created_at, id")
			.all(STANDING_WORKLOAD_ID);
		for (const { id } of open) {
			if (this.subjects.has(id)) continue;
			const repo = await resolveRepo(this.s.exec, this.ledger, id);
			this.subjects.set(id, { id, open: true, link: null, repo, tracker: linkTracker(this.ledger, this.config, id, repo) });
		}
		await this.loadRouted();
	}

	/**
	 * The destinations an orphan of a closed workload can be adopted on that no link or open workload
	 * names (`routed`): each Linear team an `issues.trackers` rule names, and the effective tracker of
	 * each closed workload an `issues.overrides` key or a `tracker:` entry routes (its team, or its own
	 * GitHub repo resolved as `closedSubject` resolves it). An owner-glob GitHub rule names no repo and
	 * is not enumerated. Local reads only.
	 */
	async loadRouted(): Promise<void> {
		for (const r of this.config.trackers) if (r.tracker.kind === "linear") this.routed.teams.add(r.tracker.team);
		const ids = new Set(Object.keys(this.config.overrides));
		const entries = this.ledger.db
			.query<{ workload_id: string }, [string, string]>("SELECT DISTINCT workload_id FROM entries WHERE kind = 'assumption' AND created_by = ? AND body LIKE ?")
			.all(SURFACE_BY, "tracker: %");
		for (const { workload_id } of entries) ids.add(workload_id);
		for (const id of [...ids].sort()) {
			const w = this.ledger.workload(id);
			if (!w || w.status === "open") continue;
			// An entry or an override routes it: the tracker never depends on its repo.
			const t = effectiveTracker(this.ledger, this.config, id, null).tracker;
			if (t?.kind === "linear") this.routed.teams.add(t.team);
			else if (t?.kind === "github") {
				const x = await this.closedSubject(id);
				if (x.tracker?.kind === "github" && x.repo !== null && x.repo !== NO_REPO) this.routed.repos.add(x.repo);
			}
		}
	}

	/** The subject's item lives where its tracker says (no move pending). */
	settled(x: Subject): boolean {
		return x.link !== null && x.tracker !== null && x.link.tracker === trackerKey(x.tracker);
	}

	/**
	 * The remote block's PR lines when they are the set the last push wrote and still the current one:
	 * the link is not dirty (no PR change the scan saw waits on a push, nor a ledger change), the
	 * sidecar's PR rows for the workload (the open PRs the scan mapped) are exactly the block's open
	 * PRs, and the render they give hashes to the link's `pushed_hash` (the sidecar's record of that
	 * push). Else null: the remote's word alone is never the expected projection.
	 */
	pushedFacts(x: Subject, remoteBody: string): PrFact[] | null {
		const link = x.link!;
		if (link.pushed_hash === null || link.dirty !== 0) return null;
		const facts = prsOfBlock(remoteBody);
		const rows = this.s.sidecar
			.prs()
			.filter((p) => p.workload_id === x.id)
			.map((p) => p.number);
		const open = facts.filter((f) => f.state === "OPEN").map((f) => f.number);
		if (JSON.stringify(rows.sort((a, b) => a - b)) !== JSON.stringify(open.sort((a, b) => a - b))) return null;
		const r = this.s.renderOf(x.id, facts);
		return r !== null && renderHash(r) === link.pushed_hash ? facts : null;
	}

	/** The PR facts the expected render reads (see the header), or the reason they are unknown. */
	async factsFor(x: Subject, remoteBody: string): Promise<PrFact[] | { unknown: string }> {
		const fetch = !x.open && (x.link!.pushed_state === null || x.link!.pushed_state === "open");
		const pushed = fetch ? null : this.pushedFacts(x, remoteBody);
		if (pushed !== null) return pushed;
		if (x.repo === null || x.repo === NO_REPO) return [];
		const stopped = this.stoppedWhy("github");
		if (stopped !== null) return { unknown: `${x.id}: its PR set was not read (${stopped})` };
		if (this.s.rateLow) return { unknown: `${x.id}: its PR set was not read (GitHub rate limit under ${RATE_FLOOR})` };
		const set = await this.s.prSet(x.id);
		return set.known ? set.prs : { unknown: `${x.id}: PR set unknown: ${set.why}` };
	}

	/** The expected render of a subject against a remote body, or null (unknown, recorded). */
	async expected(x: Subject, remoteBody: string): Promise<Rendered | null> {
		const facts = await this.factsFor(x, remoteBody);
		if (!Array.isArray(facts)) {
			this.unknown(facts.unknown);
			return null;
		}
		return this.s.renderOf(x.id, facts);
	}

	/** Record a drifted item: one line, the link forced; a closed workload's item reopened by hand gets one comment. */
	drifted(x: Subject, where: string, diffs: string[], r: Rendered, remoteOpen: boolean, post: () => Promise<{ ok: true } | { ok: false; error: string }>): void {
		this.d.lines.push(`${where} ${x.id}: ${diffs.join("; ")}`);
		const link = x.link!;
		const reopened = !x.open && r.state === "closed" && remoteOpen && link.pushed_state !== null && link.pushed_state !== "open";
		// One comment per reopen: a link already forced was told at the run that forced it.
		if (reopened && link.force === 0) this.d.comments.push({ workloadId: x.id, post });
		this.d.force.add(x.id);
	}

	/** The workload a title names, when the ledger has it. */
	namedWorkload(title: string): { id: string; open: boolean } | null {
		const m = TITLE_ID.exec(title);
		const w = m === null ? null : this.ledger.workload(m[1]!);
		return w ? { id: w.id, open: w.status === "open" } : null;
	}

	/** The newest provenance seq of the workload (0 with none). */
	ledgerSeq(id: string): number {
		return this.ledger.db.query<{ seq: number | null }, [string]>("SELECT max(seq) AS seq FROM provenance WHERE workload_id = ?").get(id)?.seq ?? 0;
	}

	/** A closed workload's subject: its link's when its repo is known, else its repo resolved as `load` resolves an open workload's. */
	async closedSubject(id: string): Promise<Subject> {
		const known = this.closed.get(id) ?? this.subjects.get(id);
		if (known !== undefined && (known.repo !== null || this.closed.has(id))) return known;
		const repo = await resolveRepo(this.s.exec, this.ledger, id);
		const x: Subject = { id, open: false, link: known?.link ?? null, repo, tracker: linkTracker(this.ledger, this.config, id, repo) };
		this.closed.set(id, x);
		return x;
	}

	/**
	 * An open `as2` item, held by no link, whose title names closed workload `id`. That workload holds
	 * another item (or adopted one this run): one line, left open. Else, when the item is where the
	 * workload's tracker puts it (`onTracker`) and no other link holds it: one line and an adoption, so
	 * the next push closes it. Else (another place) nothing, as before.
	 */
	async orphan(id: string, where: string, onTracker: (x: Subject) => boolean, item: Omit<Adoption, "repo" | "lastSeq">): Promise<void> {
		const x = await this.closedSubject(id);
		const link = x.link;
		if ((link !== null && (link.issue_number !== null || link.external_id !== null)) || this.d.adopt.has(id)) {
			this.d.lines.push(`${where}: open, labelled ${LABEL.as2}, names ${id}, which holds another item; left open`);
			return;
		}
		if (!onTracker(x)) return;
		const taken = this.s.sidecar
			.links()
			.some((l) => (item.issueNumber !== null ? l.issue_number === item.issueNumber && l.repo === x.repo : l.external_id === item.externalId));
		if (taken) return;
		this.d.lines.push(`${where}: open, labelled ${LABEL.as2}, names closed workload ${id} with no item linked; the next push closes it`);
		this.d.adopt.set(id, { ...item, repo: x.repo, lastSeq: Math.max(link?.last_seq ?? 0, this.ledgerSeq(id)) });
	}

	// ---- GitHub ----

	githubRepos(): string[] {
		const repos = new Set<string>(this.routed.repos);
		for (const r of this.config.trackers) if (r.tracker.kind === "github" && !r.match.endsWith("/*")) repos.add(r.match.toLowerCase());
		for (const x of this.subjects.values()) {
			if (x.repo === null || x.repo === NO_REPO) continue;
			if (x.link?.tracker === "github" && x.link.issue_number !== null) repos.add(x.repo);
			if (x.tracker?.kind === "github" && x.open) repos.add(x.repo);
		}
		return [...repos].sort();
	}

	async github(repo: string): Promise<void> {
		const gh = this.s.gh;
		const where = (n: number) => `github ${repo} #${n}`;
		const listed = await gh.json(["issue", "list", "-R", repo, "--label", LABEL.as2, "--state", "all", "-L", String(ISSUE_LIST_LIMIT), "--json", "number,title,state,stateReason,labels,body"]);
		if (!listed.ok) return this.unknown(`github ${repo}: ${listed.error}`);
		if (!Array.isArray(listed.value)) return this.unknown(`github ${repo}: gh issue list printed no issue list`);
		if (listed.value.length >= ISSUE_LIST_LIMIT) return this.unknown(`github ${repo}: gh issue list returned ${listed.value.length} rows, the limit`);
		const byNumber = new Map<number, RemoteGh>();
		for (const v of listed.value) {
			const n = at(v, "number");
			const issue = remoteGh(v);
			if (typeof n !== "number" || issue === null) return this.unknown(`github ${repo}: gh issue list printed an issue without number, title and state`);
			byNumber.set(n, issue);
		}
		const held = new Set<number>();
		for (const x of this.subjects.values()) {
			const link = x.link;
			if (link === null || x.repo !== repo || link.tracker !== "github" || link.issue_number === null) continue;
			const n = link.issue_number;
			held.add(n);
			if (!this.settled(x)) continue;
			let remote = byNumber.get(n) ?? null;
			if (remote === null) {
				const view = await gh.json(["issue", "view", String(n), "-R", repo, "--json", "title,body,labels,state,stateReason"]);
				if (!view.ok) {
					if (GH_NOT_FOUND.test(view.error)) {
						this.d.lines.push(`${where(n)} ${x.id}: not found on GitHub; the next push creates its issue again`);
						this.d.gone.add(x.id);
					} else this.unknown(`github ${repo} #${n}: ${view.error}`);
					continue;
				}
				remote = remoteGh(view.value);
				if (remote === null) {
					this.unknown(`github ${repo} #${n}: gh issue view printed no issue`);
					continue;
				}
			}
			const r = await this.expected(x, remote.body);
			if (r === null) continue;
			const diffs: string[] = [];
			if (remote.title !== r.title) diffs.push(`title "${remote.title}" (ledger: "${r.title}")`);
			if (mergeBody(remote.body, r.block) !== remote.body) diffs.push("machine block differs");
			const labels = remote.labels.filter((l) => PROJECTION_LABELS.includes(l));
			if (!same(labels, r.labels)) diffs.push(`labels ${list(labels.sort())} (ledger: ${list(r.labels)})`);
			const state = remote.state === "OPEN" ? "open" : `closed ${remote.reason ?? "with no reason"}`;
			if (state !== stateText(r)) diffs.push(`state ${state} (ledger: ${stateText(r)})`);
			if (diffs.length === 0) continue;
			this.drifted(x, where(n), diffs, r, remote.state === "OPEN", () => this.s.gh.run(["issue", "comment", String(n), "-R", repo, "--body", reopenComment(x.id)]));
		}
		for (const [n, issue] of byNumber) {
			if (held.has(n) || issue.state !== "OPEN") continue;
			const named = this.namedWorkload(issue.title);
			if (named === null) this.d.lines.push(`${where(n)}: open, labelled ${LABEL.as2}, and its title names no workload in the ledger ("${issue.title}"); left open`);
			else if (!named.open) await this.orphan(named.id, where(n), (x) => x.tracker?.kind === "github" && x.repo === repo, { tracker: "github", issueNumber: n, externalId: null, issueRef: null });
		}
	}

	// ---- Linear ----

	/** The teams a linked item or an open workload is on (`inUse`: their states are read), and the routed teams no such item is on. */
	linearTeams(): { team: string; inUse: boolean }[] {
		const used = new Set<string>();
		for (const x of this.subjects.values()) {
			const t = x.link?.tracker;
			if (t?.startsWith("linear:") && x.link!.external_id !== null) used.add(t.slice("linear:".length));
			if (x.tracker?.kind === "linear" && x.open) used.add(x.tracker.team);
		}
		return [...new Set([...used, ...this.routed.teams])].sort().map((team) => ({ team, inUse: used.has(team) }));
	}

	/**
	 * One team's items. A team in use has its workflow states read first, as before; a routed team only
	 * a rule or a closed workload's route names holds no linked item, so it costs the one list (its
	 * states are read only if a linked item turns up after all).
	 */
	async linear(team: string, inUse: boolean): Promise<void> {
		const lin = this.s.linear;
		const key = `linear:${team}`;
		let read: LinearTeam | null = null;
		const states = async (): Promise<LinearTeam | null> => {
			if (read !== null) return read;
			const t = await lin.team(team);
			if (!t.ok) {
				this.unknown(`linear ${team}: ${t.error}`);
				return null;
			}
			return (read = t.value);
		};
		if (inUse && (await states()) === null) return;
		const listed = await lin.listLabelled(team, LABEL.as2);
		if (!listed.ok) return this.unknown(`linear ${team}: ${listed.error}`);
		const byId = new Map(listed.value.map((i) => [i.id, i]));
		const held = new Set<string>();
		for (const x of this.subjects.values()) {
			const link = x.link;
			if (link === null || link.tracker !== key || link.external_id === null) continue;
			const id = link.external_id;
			held.add(id);
			if (!this.settled(x)) continue;
			const where = `linear ${team} ${link.issue_ref ?? id}`;
			let remote: LinearIssue | null = byId.get(id) ?? null;
			if (remote === null) {
				const read = await lin.read(id);
				if (!read.ok) {
					if (LINEAR_NOT_FOUND.test(read.error)) {
						this.d.lines.push(`${where} ${x.id}: not found on Linear; the next push creates its issue again`);
						this.d.gone.add(x.id);
					} else this.unknown(`linear ${team} ${link.issue_ref ?? id}: ${read.error}`);
					continue;
				}
				remote = read.value;
			}
			const r = await this.expected(x, remote.description);
			if (r === null) continue;
			const t = await states();
			if (t === null) return;
			await this.compareLinear(x, where, remote, r, t);
		}
		for (const issue of listed.value) {
			if (held.has(issue.id) || (issue.state !== null && LINEAR_DONE[issue.state.type])) continue;
			const where = `linear ${team} ${issue.identifier}`;
			const named = this.namedWorkload(issue.title);
			if (named === null) this.d.lines.push(`${where}: open, labelled ${LABEL.as2}, and its title names no workload in the ledger ("${issue.title}"); left open`);
			else if (!named.open) await this.orphan(named.id, where, (x) => x.tracker !== null && trackerKey(x.tracker) === key, { tracker: key, issueNumber: null, externalId: issue.id, issueRef: issue.identifier });
		}
	}

	async compareLinear(x: Subject, where: string, remote: LinearIssue, r: Rendered, team: LinearTeam): Promise<void> {
		const diffs: string[] = [];
		if (remote.title !== r.title) diffs.push(`title "${remote.title}" (ledger: "${r.title}")`);
		// Linear normalises Markdown on write, so its block is never the render's bytes. When the render is
		// the one the clean link last pushed, the block is compared with the hash of what Linear returned for
		// that push; otherwise (or with no such hash) byte for byte, as on GitHub.
		const link = x.link!;
		const pushedBlock = link.dirty === 0 && link.force === 0 && link.remote_hash !== null && link.pushed_hash === renderHash(r);
		if (pushedBlock ? blockHash(remote.description) !== link.remote_hash : mergeBody(remote.description, r.block) !== remote.description) diffs.push("machine block differs");
		// Labels past the one page read: the whole set is read (every page) and compared; a failed read is unknown, not compared.
		let all: readonly { name: string }[] | null = remote.labels;
		if (!remote.labelsComplete) {
			const read = await this.s.linear.labels(remote.id);
			all = read.ok ? read.value : null;
			if (!read.ok) this.unknown(`${where} ${x.id}: ${read.error}`);
		}
		if (all !== null) {
			const labels = all.map((l) => l.name.toLowerCase()).filter((l) => LINEAR_LABELS.includes(l));
			if (!same(labels, r.labels)) diffs.push(`labels ${list(labels.sort())} (ledger: ${list(r.labels)})`);
		}
		const want = linearStateFor(r, team.states);
		if (want === null) diffs.push(`team ${team.key} has no workflow state for ${stateText(r)}`);
		else if (remote.state?.id !== want.id) diffs.push(`state ${remote.state?.name ?? "none"} (ledger: ${want.name})`);
		if (diffs.length === 0) return;
		const remoteOpen = remote.state === null || !LINEAR_DONE[remote.state.type];
		const issueId = remote.id;
		this.drifted(x, where, diffs, r, remoteOpen, () => this.s.linear.comment(issueId, reopenComment(x.id)));
	}

	// ---- local ----

	local(): void {
		for (const x of this.subjects.values()) {
			const link = x.link;
			const want = x.tracker === null ? null : trackerKey(x.tracker);
			const hasItem = link !== null && (link.issue_number !== null || link.external_id !== null);
			if (hasItem && link.tracker !== want) {
				const item = link.issue_number !== null ? `${link.repo} #${link.issue_number}` : (link.issue_ref ?? link.external_id);
				this.d.lines.push(`${link.tracker ?? "untracked"} ${item} ${x.id}: its tracker is now ${want ?? "none"}; the next push moves it`);
				this.d.dirty.set(x.id, { repo: x.repo, lastSeq: link.last_seq });
			} else if (!hasItem && x.open && x.tracker !== null) {
				const where = x.tracker.kind === "github" ? `github ${x.repo}` : `linear ${x.tracker.team}`;
				this.d.lines.push(`${where} ${x.id}: open and has no issue`);
				const lastSeq = link?.last_seq ?? this.ledgerSeq(x.id);
				this.d.dirty.set(x.id, { repo: x.repo, lastSeq });
			}
		}
		for (const pr of this.s.sidecar.prs()) {
			if (pr.footer !== "pending") continue;
			const link = this.s.sidecar.link(pr.workload_id);
			this.d.lines.push(`github ${link?.repo ?? "?"} PR #${pr.number} ${pr.workload_id}: its Closes #${link?.issue_number ?? "?"} footer is still pending`);
		}
		const moved: unknown = JSON.parse(this.s.sidecar.state(STATE.moveDrift) ?? "[]");
		if (Array.isArray(moved)) {
			for (const line of moved) this.d.lines.push(`github ${String(line)}`);
			this.d.moveDrift = moved.length;
		}
	}

	/** `intake: <K> ignored (<reason> <n>, …)` for issues intake judged not Jo's since the last run. */
	intakeLine(): void {
		const last = Number(this.s.sidecar.state(STATE.lastReconcile) ?? "0");
		const rows = this.s.sidecar.db
			.query<{ reason: string | null; n: number }, [string, string]>("SELECT reason, count(*) AS n FROM intake WHERE verdict = ? AND seen_at > ? GROUP BY reason ORDER BY reason")
			.all(INTAKE_IGNORED, new Date(last).toISOString());
		const total = rows.reduce((a, r) => a + r.n, 0);
		if (total > 0) this.d.intake = `intake: ${total} ignored (${rows.map((r) => `${r.reason ?? "no reason"} ${r.n}`).join(", ")})`;
	}
}

/** The comment on an item Jo reopened while its workload is closed (§ 4). */
export const reopenComment = (workloadId: string): string => `${workloadId} is closed and cannot reopen; file a new issue`;

/**
 * Compare every tracker item with the ledger now (see the header). Reads only: the counted callers
 * in `s` make the calls, and nothing is written; the phase applies `Drift`'s marks and adoptions.
 * A budget stop is caught (the run is unknown, `stop` set); a lost claim propagates.
 */
export async function computeDrift(s: DriftSource): Promise<Drift> {
	const run = new Run(s);
	await run.load();
	// The projector's last open-PR scan saw only part of the PRs: footers and PR states may be missed.
	const scan = s.sidecar.state(PR_SCAN_UNKNOWN);
	if (scan !== null) run.unknown(`pr scan: ${scan}`);
	const repos = run.githubRepos();
	const ghStopped = run.stoppedWhy("github");
	if (repos.length > 0 && ghStopped !== null) run.unknown(ghStopped);
	else if (repos.length > 0 && s.rateLow) run.unknown(`GitHub rate limit under ${RATE_FLOOR} at the hourly read; GitHub was not read`);
	else for (const repo of repos) await run.guarded(() => run.github(repo));
	const teams = run.linearTeams();
	const linStopped = run.stoppedWhy("linear");
	if (teams.length > 0 && linStopped !== null) run.unknown(linStopped);
	else for (const { team, inUse } of teams) await run.guarded(() => run.linear(team, inUse));
	run.local();
	run.intakeLine();
	return run.d;
}

/** The streak of drifted (or unknown) runs, as `STATE.lastDrift` keeps it. */
interface Streak {
	result: string;
	streak: number;
	told: boolean;
}

function streakOf(raw: string | null): Streak {
	try {
		const v: unknown = JSON.parse(raw ?? "null");
		const result = at(v, "result");
		const streak = at(v, "streak");
		if (typeof result === "string" && typeof streak === "number") return { result, streak, told: at(v, "told") === true };
	} catch {
		// An unreadable value starts a new streak.
	}
	return { result: "", streak: 0, told: false };
}

/**
 * The projector's `reconcile` phase (§ 4): every `reconcileEveryMin`, compute the drift, record
 * `issues-drift: …` on wl-orchestrator by the surface, mark the drifted links (and link the adopted
 * items) for the next push,
 * post the reopen comments, and tell Ilex once when two runs in a row drifted. A budget stop is
 * recorded as unknown and rethrown; a lost claim records nothing and leaves the schedule alone.
 */
export async function reconcile(ctx: PhaseContext): Promise<void> {
	const now = ctx.now();
	const last = Number(ctx.sidecar.state(STATE.lastReconcile) ?? "0");
	if (now - last < ctx.config.reconcileEveryMin * MIN) return;
	const d = await computeDrift(ctx);
	const count = driftCount(d);
	const result = count === null ? "unknown" : String(count);
	const prev = streakOf(ctx.sidecar.state(STATE.lastDrift));
	const bad = result !== "0";
	const streak = bad ? prev.streak + 1 : 0;
	const tell = bad && streak >= 2 && !prev.told;
	// The claim is re-checked before anything is written, as before a create (§ 3).
	ctx.gh.fence();
	// Turn rows the entry carries (§ 13.3): read now, marked carried only after the entry is written.
	const turns = turnDrift(ctx.sidecar);
	d.turns = turns.lines;
	// The ledger first: a crash before the sidecar write repeats the run (two entries, the turn lines in both), never loses one.
	ensureStandingWorkload(ctx.ledger);
	const entryId = ctx.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: driftEntryBody(d, new Date(now).toISOString()) });
	const sc = ctx.sidecar;
	sc.immediate(() => {
		for (const id of d.force) sc.db.query("UPDATE links SET dirty = 1, force = 1, fails = 0 WHERE workload_id = ?").run(id);
		for (const [id, o] of d.dirty) {
			if (sc.link(id)) sc.db.query("UPDATE links SET dirty = 1, fails = 0 WHERE workload_id = ?").run(id);
			else sc.upsertLink(id, { repo: o.repo, dirty: true, lastSeq: o.lastSeq });
		}
		for (const id of d.gone) {
			sc.db
				.query(
					`UPDATE links SET issue_number = NULL, external_id = NULL, issue_ref = NULL, pushed_hash = NULL, pushed_title = NULL, pushed_labels = NULL,
					        pushed_state = NULL, remote_hash = NULL, dirty = 1, force = 0, fails = 0, next_try_at = 0 WHERE workload_id = ?`,
				)
				.run(id);
			// Its PR rows named the old number: the next scan maps the PRs again and foots them with the new one.
			sc.db.query("DELETE FROM prs WHERE workload_id = ?").run(id);
		}
		for (const [id, a] of d.adopt) {
			sc.db
				.query(
					`INSERT INTO links (workload_id, repo, tracker, issue_number, external_id, issue_ref, dirty, force, fails, last_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, 0, ?7)
					 ON CONFLICT (workload_id) DO UPDATE SET repo = ?2, tracker = ?3, issue_number = ?4, external_id = ?5, issue_ref = ?6, dirty = 1, force = 1, fails = 0,
					        last_seq = max(last_seq, ?7)`,
				)
				.run(id, a.repo, a.tracker, a.issueNumber, a.externalId, a.issueRef, a.lastSeq);
		}
		if (d.moveDrift > 0) {
			const moved: unknown = JSON.parse(sc.state(STATE.moveDrift) ?? "[]");
			const rest = Array.isArray(moved) ? moved.slice(d.moveDrift) : [];
			sc.setState(STATE.moveDrift, rest.length > 0 ? JSON.stringify(rest) : null);
		}
		sc.setState(STATE.lastReconcile, String(now));
		markTurnDrift(sc, turns.ids);
		sc.setState(STATE.lastDrift, JSON.stringify({ result, streak, told: bad && (prev.told || tell) } satisfies Streak));
	});
	if (tell) ctx.notice(`issues drift on ${streak} reconciles in a row: ${count === null ? driftHead(d) : `${count} difference${count === 1 ? "" : "s"}`} (${entryId} on ${STANDING_WORKLOAD_ID})`);
	for (const c of d.comments) {
		try {
			const r = await c.post();
			if (!r.ok) ctx.notice(`the reopen comment on ${c.workloadId}'s issue failed: ${r.error}`);
		} catch (err) {
			if (!(err instanceof TickStop) || err.reason !== "budget") throw err;
			d.stop ??= err;
			break;
		}
	}
	if (d.stop) throw d.stop;
}
