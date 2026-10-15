// Intake (PLAN wl-mv66ylim0gahog § 6): an issue proven to be Jo's becomes a Jo input on
// wl-orchestrator. The projector runs it as its `intake` phase (`TickPhases.intake`), after the push,
// only while the switch is on, inside the tick's claim and counted budget. It reads one GitHub repo,
// `issues.intakeRepo` (thewolff/jo-issues for the profile, Jo's choice in q-mv92ac7xt75v5s), else the
// first exact GitHub tracker rule's repo (config.ts `intakeRepo`). A run, every `intakeEveryMin`:
//
// 1. Acknowledgements first: every accepted row with `acked = 0` gets the `intake` label and one
//    comment `recorded as <in-…> on wl-orchestrator` (skipped when the issue's comments already hold
//    that line, so a lost reply does not double-post), then `acked = 1`. A failed call ends the acks.
//    The label is made on the repo first, once (`intake_labels_created:<repo>`; nothing to do when
//    the tick already made the projection's labels there): a separate intake repo never got them.
// 2. Discovery (§ 6.1): one read-only GraphQL page of the repo's issues created by `issues.jo`,
//    oldest first, 100 edges after the persisted `intake_after` edge cursor. Each edge is settled in
//    order and the cursor moves to it once settled: a number already linked or judged is a skip; any
//    other gets a fresh verdict persisted. `hasNextPage` waits for the next run. An edge carrying an
//    `intakeSkipLabels` label (`plumb`, `as2-train`: Plumb and the merge train file on the intake
//    repo as Jo's own account) is ignored with no proof call and never touched: no label, no comment.
// 3. Proof (§ 6.2), one read-only GraphQL query per candidate, every rule must hold: author login is
//    Jo and `authorAssociation` OWNER; no skip label (again, for one put on after discovery); filed
//    at or after `intake_since`; no projection block in the body; no TransferredEvent; every body
//    edit's editor and every rename's actor is Jo, with no second page of either (nor of labels).
//    Comments are never read for the proof. Anything else is `ignored` with its reason, and the
//    ledger gets nothing.
// 4. Write: the ledger is the dedup authority. One ledger transaction finds a Jo-input instruction
//    on wl-orchestrator whose body starts `github-issue #<N> ` (a crash after the ledger write) or
//    records one in the shape `isJoInput` accepts; then the sidecar row, then a notice to Ilex.
//
// An issue on a separate intake repo is never a projected issue: no tracker rule files projected
// issues there, and the projector adopts an accepted issue for a workload (`boundIntake`) only when
// that workload's own issues repo is the intake repo. The linked-number skip and the
// projection-block rule stay; on such a repo they are harmless (no link names it; a machine block
// pasted by Jo is still not an ask).
//
// A budget or claim stop (`TickStop`) propagates and leaves the schedule alone, so the next tick
// resumes after the last settled edge. A failed call is one notice and ends the run.
import { ensureStandingWorkload, standingSlice } from "../identity";
import { isJoInput } from "../orchestrator-question";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../types";
import { TickStop } from "./github";
import { ensureGithubLabels, type PhaseContext } from "./projector";
import { BLOCK_BEGIN, LABEL } from "./render";
import { INTAKE_ACCEPTED, INTAKE_IGNORED, STATE } from "./sidecar";

/** The `state` key holding the epoch ms of the last intake run that was not stopped by the budget or the claim. */
export const LAST_INTAKE = "last_intake";
/** The `state` key (`<key>:<owner/repo>`, lower case) set once the `intake` label exists on the intake repo. */
export const INTAKE_LABELS_CREATED = "intake_labels_created";
/** Edges per discovery page and nodes per proof connection (§ 6.1, § 6.2 rule 3). */
export const PAGE = 100;

/** Why an issue was ignored: the `intake.reason` column, counted by the hourly drift entry. */
export const REASON = {
	notJo: "not Jo",
	notOwner: "author association not OWNER",
	tooOld: "filed before issues on",
	projection: "carries the projection block",
	transferred: "transferred in",
	tooMany: "too many edits or labels to prove",
	foreignEdit: "edited by another account",
	foreignRename: "renamed by another account",
	gone: "not found",
} as const;

/** The reason an issue carrying the skip label `label` was ignored, e.g. `labelled plumb`. */
export const labelledReason = (label: string): string => `labelled ${label}`;

export const DISCOVERY_QUERY =
	"query($owner: String!, $name: String!, $jo: String!, $after: String) { repository(owner: $owner, name: $name) { " +
	`issues(filterBy: {createdBy: $jo}, orderBy: {field: CREATED_AT, direction: ASC}, first: ${PAGE}, after: $after) { ` +
	`edges { cursor node { number title createdAt labels(first: ${PAGE}) { nodes { name } } } } pageInfo { hasNextPage } } } }`;

export const PROOF_QUERY =
	"query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { " +
	"number title body createdAt authorAssociation author { login } " +
	`labels(first: ${PAGE}) { totalCount nodes { name } } ` +
	`userContentEdits(first: ${PAGE}) { totalCount pageInfo { hasNextPage } nodes { editor { login } } } ` +
	`timelineItems(itemTypes: [TRANSFERRED_EVENT, RENAMED_TITLE_EVENT], first: ${PAGE}) { totalCount pageInfo { hasNextPage } ` +
	"nodes { __typename ... on RenamedTitleEvent { actor { login } } ... on TransferredEvent { actor { login } } } } } } }";

/** What `gh api graphql` prints for an issue number the repo does not have (read 2026-10-14). */
const NOT_FOUND = /Could not resolve to an Issue/;

/** The prefix that names issue N's Jo input on wl-orchestrator: the ledger's dedup key. */
export const intakePrefix = (n: number): string => `github-issue #${n} `;

/** The Jo-input body for issue N (§ 6.2 Write). */
export function intakeBody(n: number, jo: string, createdAt: string, title: string, body: string): string {
	return `${intakePrefix(n)}by ${jo} ${createdAt}: ${title}\n\n${body}`;
}

/** The acknowledgement comment for an accepted issue. */
export const ackLine = (inId: string): string => `recorded as ${inId} on wl-orchestrator`;

export interface DiscoveryEdge {
	cursor: string;
	number: number;
	title: string;
	createdAt: string;
	/** Its label names, lower case (the first PAGE). */
	labels: string[];
}

export interface ProofIssue {
	number: number;
	title: string;
	body: string;
	createdAt: string;
	authorAssociation: string;
	/** null for a deleted account (ghost). */
	author: string | null;
	/** Label names, lower case (the first PAGE), and how many it has. */
	labels: { totalCount: number; names: string[] };
	edits: { totalCount: number; hasNextPage: boolean; editors: (string | null)[] };
	timeline: { totalCount: number; hasNextPage: boolean; events: { type: string; actor: string | null }[] };
}

/** The value at `path` in gh's parsed JSON, or undefined where an object along it is missing. */
function at(v: unknown, ...path: string[]): unknown {
	let cur = v;
	for (const key of path) cur = cur !== null && typeof cur === "object" ? Reflect.get(cur, key) : undefined;
	return cur;
}

/** `{login}` of an actor, author or editor; null for a deleted account (ghost). */
function loginOf(actor: unknown): string | null {
	const login = at(actor, "login");
	return typeof login === "string" ? login : null;
}

/** The lower-case `name` of each label node, or null when `nodes` is not a list. */
function labelNames(nodes: unknown): string[] | null {
	if (!Array.isArray(nodes)) return null;
	return nodes.flatMap((n: unknown) => {
		const name = at(n, "name");
		return typeof name === "string" ? [name.toLowerCase()] : [];
	});
}

/** A discovery page from `gh api graphql`, or null when it does not have that shape. */
export function parseDiscovery(v: unknown): { edges: DiscoveryEdge[]; hasNextPage: boolean } | null {
	const edges = at(v, "data", "repository", "issues", "edges");
	const hasNextPage = at(v, "data", "repository", "issues", "pageInfo", "hasNextPage");
	if (!Array.isArray(edges) || typeof hasNextPage !== "boolean") return null;
	const out: DiscoveryEdge[] = [];
	for (const e of edges) {
		const cursor = at(e, "cursor");
		const number = at(e, "node", "number");
		const title = at(e, "node", "title");
		const createdAt = at(e, "node", "createdAt");
		const labels = labelNames(at(e, "node", "labels", "nodes"));
		if (typeof cursor !== "string" || typeof number !== "number" || typeof title !== "string" || typeof createdAt !== "string" || labels === null) return null;
		out.push({ cursor, number, title, createdAt, labels });
	}
	return { edges: out, hasNextPage };
}

/** The proof read from `gh api graphql`: the issue, null when the repo has no such issue, undefined when the reply has no such shape. */
export function parseProof(v: unknown): ProofIssue | null | undefined {
	const repo = at(v, "data", "repository");
	if (repo === null || typeof repo !== "object" || !("issue" in repo)) return undefined;
	const i = repo.issue;
	if (i === null) return null;
	const number = at(i, "number");
	const title = at(i, "title");
	const body = at(i, "body");
	const createdAt = at(i, "createdAt");
	const association = at(i, "authorAssociation");
	const labelCount = at(i, "labels", "totalCount");
	const labels = labelNames(at(i, "labels", "nodes"));
	const editCount = at(i, "userContentEdits", "totalCount");
	const editMore = at(i, "userContentEdits", "pageInfo", "hasNextPage");
	const editNodes = at(i, "userContentEdits", "nodes");
	const eventCount = at(i, "timelineItems", "totalCount");
	const eventMore = at(i, "timelineItems", "pageInfo", "hasNextPage");
	const eventNodes = at(i, "timelineItems", "nodes");
	if (
		typeof number !== "number" || typeof title !== "string" || typeof body !== "string" || typeof createdAt !== "string" || typeof association !== "string" ||
		typeof labelCount !== "number" || labels === null ||
		typeof editCount !== "number" || typeof editMore !== "boolean" || !Array.isArray(editNodes) ||
		typeof eventCount !== "number" || typeof eventMore !== "boolean" || !Array.isArray(eventNodes)
	) {
		return undefined;
	}
	return {
		number,
		title,
		body,
		createdAt,
		authorAssociation: association,
		author: loginOf(at(i, "author")),
		labels: { totalCount: labelCount, names: labels },
		edits: { totalCount: editCount, hasNextPage: editMore, editors: editNodes.map((n: unknown) => loginOf(at(n, "editor"))) },
		timeline: {
			totalCount: eventCount,
			hasNextPage: eventMore,
			events: eventNodes.map((n: unknown) => ({ type: String(at(n, "__typename") ?? ""), actor: loginOf(at(n, "actor")) })),
		},
	};
}

/** Filed before `since` (the `issues on` entry's time): no backfill of old issues (§ 6.2 rule 6). */
export const filedBefore = (createdAt: string, since: string): boolean => Date.parse(createdAt) < Date.parse(since);

/**
 * The § 6.2 proof: null when every rule holds (the issue is Jo's), else the reason it is ignored.
 * The author is checked first, so nothing past it is read for an issue that is not Jo's. An issue
 * carrying one of `skipLabels` (lower case; `issues.intakeSkipLabels`) is not an ask of Jo's.
 */
export function judge(issue: ProofIssue, jo: string, since: string, skipLabels: readonly string[]): string | null {
	const isJo = (login: string | null): boolean => login !== null && login.toLowerCase() === jo.toLowerCase();
	if (!isJo(issue.author)) return REASON.notJo;
	if (issue.authorAssociation !== "OWNER") return REASON.notOwner;
	const skip = skipLabels.find((l) => issue.labels.names.includes(l));
	if (skip !== undefined) return labelledReason(skip);
	if (filedBefore(issue.createdAt, since)) return REASON.tooOld;
	if (issue.body.includes(BLOCK_BEGIN)) return REASON.projection;
	if (issue.timeline.events.some((e) => e.type === "TransferredEvent")) return REASON.transferred;
	if (
		issue.edits.hasNextPage || issue.timeline.hasNextPage || issue.edits.totalCount > issue.edits.editors.length || issue.timeline.totalCount > issue.timeline.events.length ||
		// A skip label past the first page could not be seen.
		issue.labels.totalCount > issue.labels.names.length
	) {
		return REASON.tooMany;
	}
	if (!issue.edits.editors.every(isJo)) return REASON.foreignEdit;
	if (!issue.timeline.events.every((e) => e.type !== "RenamedTitleEvent" || isJo(e.actor))) return REASON.foreignRename;
	return null;
}

/**
 * Jo's input for issue N on wl-orchestrator, in one ledger transaction: the one already there (a
 * Jo-input row whose body starts `github-issue #<N> `, left by a crash before the sidecar write), or
 * a new instruction by the surface, author jo, channel surface, on the standing slice.
 */
export function recordIntake(ctx: Pick<PhaseContext, "ledger">, n: number, body: string): { id: string; recovered: boolean } {
	const ledger = ctx.ledger;
	return ledger.write(() => {
		const prior = ledger.instructions(STANDING_WORKLOAD_ID).find((i) => isJoInput(i) && i.body.startsWith(intakePrefix(n)));
		if (prior) return { id: prior.id, recovered: true };
		ensureStandingWorkload(ledger);
		const id = ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(ledger)?.id ?? null, body, author: "jo", channel: "surface" });
		return { id, recovered: false };
	});
}

class Run {
	readonly owner: string;
	readonly name: string;
	readonly repo: string;
	/** `repo` as `links.repo` caches it (lower case). */
	readonly repoKey: string;

	constructor(
		readonly ctx: PhaseContext,
		readonly since: string,
		repo: string,
	) {
		this.repo = repo;
		this.repoKey = repo.toLowerCase();
		const [owner, name] = this.repo.split("/");
		this.owner = owner!;
		this.name = name!;
	}

	/** Issue N of the intake repo is linked to a workload's GitHub issue. */
	linked(n: number): boolean {
		return this.ctx.sidecar.db.query<{ one: number }, [number, string]>("SELECT 1 AS one FROM links WHERE issue_number = ? AND repo = ?").get(n, this.repoKey) !== null;
	}

	/** Issue N is linked to a workload or already judged: a skip. */
	known(n: number): boolean {
		return this.linked(n) || this.ctx.sidecar.db.query<{ one: number }, [number]>("SELECT 1 AS one FROM intake WHERE issue_number = ?").get(n) !== null;
	}

	ignore(n: number, reason: string, cursor: string): void {
		const s = this.ctx.sidecar;
		s.immediate(() => {
			s.db
				.query("INSERT INTO intake (issue_number, verdict, reason, in_id, acked, seen_at) VALUES (?, ?, ?, NULL, 0, ?)")
				.run(n, INTAKE_IGNORED, reason, new Date(this.ctx.now()).toISOString());
			s.setState(STATE.intakeAfter, cursor);
		});
	}

	/** A failed call: one notice; the caller ends what it was doing. */
	failed(error: string): false {
		this.ctx.notice(`issue intake: ${error}`);
		return false;
	}

	/**
	 * The `intake` label exists on the repo, so `--add-label` cannot fail for want of it: nothing to do
	 * when the tick made the projection's labels there (`labels_created:<repo>`, which include it),
	 * else made once, with counted calls, under INTAKE_LABELS_CREATED. False when a call failed.
	 */
	async ensureLabel(): Promise<boolean> {
		if (this.ctx.sidecar.state(`${STATE.labelsCreated}:${this.repoKey}`) === "1") return true;
		const why = await ensureGithubLabels(this.ctx.gh, this.ctx.sidecar, this.repo, [LABEL.intake], `${INTAKE_LABELS_CREATED}:${this.repoKey}`);
		return why === null || this.failed(why);
	}

	/** Label, check the comments, comment once, mark acked. False when a call failed (the row stays pending). */
	async ack(n: number, inId: string): Promise<boolean> {
		const gh = this.ctx.gh;
		const linked = this.linked(n);
		// A bound issue already carries the projection's labels; `intake` would only be removed again.
		if (!linked) {
			if (!(await this.ensureLabel())) return false;
			const label = await gh.run(["issue", "edit", String(n), "-R", this.repo, "--add-label", LABEL.intake]);
			if (!label.ok) return this.failed(label.error);
		}
		const line = ackLine(inId);
		const view = await gh.json(["issue", "view", String(n), "-R", this.repo, "--json", "comments"]);
		if (!view.ok) return this.failed(view.error);
		const comments = at(view.value, "comments");
		if (!Array.isArray(comments)) return this.failed(`gh issue view ${n} printed no comments`);
		const posted = comments.some((c: unknown) => {
			const body = at(c, "body");
			return typeof body === "string" && body.trim() === line;
		});
		if (!posted) {
			const comment = await gh.run(["issue", "comment", String(n), "-R", this.repo, "--body", line]);
			if (!comment.ok) return this.failed(comment.error);
		}
		this.ctx.sidecar.immediate(() => this.ctx.sidecar.db.query("UPDATE intake SET acked = 1 WHERE issue_number = ?").run(n));
		return true;
	}

	async ackPending(): Promise<void> {
		const rows = this.ctx.sidecar.db
			.query<{ issue_number: number; in_id: string }, [string]>("SELECT issue_number, in_id FROM intake WHERE verdict = ? AND acked = 0 AND in_id IS NOT NULL ORDER BY issue_number")
			.all(INTAKE_ACCEPTED);
		for (const r of rows) if (!(await this.ack(r.issue_number, r.in_id))) return;
	}

	/** Settle one edge; false when a call failed and the run must end with the edge unsettled. */
	async settle(edge: DiscoveryEdge): Promise<boolean> {
		const n = edge.number;
		if (this.known(n)) {
			this.ctx.sidecar.immediate(() => this.ctx.sidecar.setState(STATE.intakeAfter, edge.cursor));
			return true;
		}
		// A skip label needs no call either: Plumb's issues are not Jo's asks and are left untouched.
		const skip = this.ctx.config.intakeSkipLabels.find((l) => edge.labels.includes(l));
		if (skip !== undefined) {
			this.ignore(n, labelledReason(skip), edge.cursor);
			return true;
		}
		// Rule 6 needs no call: the discovery node carries createdAt.
		if (filedBefore(edge.createdAt, this.since)) {
			this.ignore(n, REASON.tooOld, edge.cursor);
			return true;
		}
		const r = await this.ctx.gh.json(["api", "graphql", "-f", `query=${PROOF_QUERY}`, "-f", `owner=${this.owner}`, "-f", `name=${this.name}`, "-F", `number=${n}`]);
		if (!r.ok) {
			if (NOT_FOUND.test(r.error)) {
				this.ignore(n, REASON.gone, edge.cursor);
				return true;
			}
			return this.failed(r.error);
		}
		const issue = parseProof(r.value);
		if (issue === undefined) return this.failed(`gh api graphql printed no issue for #${n}`);
		if (issue === null) {
			this.ignore(n, REASON.gone, edge.cursor);
			return true;
		}
		const why = judge(issue, this.ctx.config.jo, this.since, this.ctx.config.intakeSkipLabels);
		if (why !== null) {
			this.ignore(n, why, edge.cursor);
			return true;
		}
		// The claim is re-checked before the ledger write, as before a create (§ 3): a lost claim writes nothing.
		this.ctx.gh.fence();
		const { id } = recordIntake(this.ctx, n, intakeBody(n, this.ctx.config.jo, issue.createdAt, issue.title, issue.body));
		const s = this.ctx.sidecar;
		s.immediate(() => {
			s.db
				.query("INSERT INTO intake (issue_number, verdict, reason, in_id, acked, seen_at) VALUES (?, ?, NULL, ?, 0, ?)")
				.run(n, INTAKE_ACCEPTED, id, new Date(this.ctx.now()).toISOString());
			s.setState(STATE.intakeAfter, edge.cursor);
		});
		this.ctx.notice(`Jo filed issue #${n} → input ${id}: ${issue.title}`);
		// Acknowledged now; a failure leaves it pending for the next run's acks.
		await this.ack(n, id);
		return true;
	}

	async discover(): Promise<void> {
		const after = this.ctx.sidecar.state(STATE.intakeAfter);
		const r = await this.ctx.gh.json([
			"api", "graphql", "-f", `query=${DISCOVERY_QUERY}`, "-f", `owner=${this.owner}`, "-f", `name=${this.name}`, "-f", `jo=${this.ctx.config.jo}`,
			...(after === null ? [] : ["-f", `after=${after}`]),
		]);
		if (!r.ok) {
			this.failed(r.error);
			return;
		}
		const page = parseDiscovery(r.value);
		if (page === null) {
			this.failed("gh api graphql printed no issue page");
			return;
		}
		for (const edge of page.edges) if (!(await this.settle(edge))) return;
	}
}

/**
 * The projector's `intake` phase (§ 6), on the GitHub repo `ctx.intakeRepo` names (none ⇒ nothing).
 * Runs every `intakeEveryMin` once seeding set `intake_since`; paused while the hourly rate-limit
 * read is low, like the push. Throws only `TickStop` (and ledger or sidecar errors, which the tick
 * turns into one notice).
 */
export async function intake(ctx: PhaseContext): Promise<void> {
	if (ctx.rateLow || ctx.intakeRepo === null) return;
	const since = ctx.sidecar.state(STATE.intakeSince);
	if (since === null) return;
	const now = ctx.now();
	const last = Number(ctx.sidecar.state(LAST_INTAKE) ?? "0");
	if (now - last < ctx.config.intakeEveryMin * 60_000) return;
	let stopped = false;
	try {
		const run = new Run(ctx, since, ctx.intakeRepo);
		await run.ackPending();
		await run.discover();
	} catch (err) {
		stopped = err instanceof TickStop;
		throw err;
	} finally {
		if (!stopped) ctx.sidecar.immediate(() => ctx.sidecar.setState(LAST_INTAKE, String(now)));
	}
}
