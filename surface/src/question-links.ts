// Links on every question that asks Jo to approve, accept or extend (PLAN wl-mv66q5b148uznk § The rule,
// § New ledger records). A question is linked when one of its options is one of those three words; its
// links — the plan file, the newest complete review round's verdict files, the PRs of `wl/<wl>` — are
// computed here from the ledger (and one `gh pr list` read), never chosen by a model, and recorded with
// the question as `question-links: <q-id> <json>` (newest wins). Machinery questions (round limit,
// ceiling) prepend `linkHeader`; model-authored ones must start with it exactly (`linkProblem`), the plan
// question keeps its D7 shape and is checked by `planLinkProblem`.
//
// Ledger records read and written here:
// - `plan-file: <path>` (the classifier, at a plan-slice review dispatch): the workload's plan, newest wins.
// - `review-verdict: <token> <path>` (the classifier at settle; `materializeVerdicts` for legacy rounds):
//   one verdict file per member of a complete round, `<dir of the ledger file>/reviews/<wl>/<token>.md`.
// - `pr-seen: <n> <url>` (control entry): a PR once seen, at `gh pr create` or by any successful read.
// - `test-requested:` (the test runner's): the PR a full-suite run was asked for.
// - `question-links: <q-id> <json>` (control entry): the links a question was raised with.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { handSpawns, parseHandSpawn, settledTokens } from "../../classifier/src/lab";
import { blockingOf, countRounds, type FindingsOrUnknown, parseReviewGroup, parseReviewLoopEnd, parseReviewRound, type ReviewRoundEntry, severityLine, UNKNOWN } from "../../classifier/src/rounds";
import { type EntryRow, type Ledger, type QuestionRow } from "../../ledger/src/index";
import { repoOf } from "./decision-log";
import { branchName, classifierMachineryWriter, type ControlEntry, controlEntries, holdersOf } from "./launch";
import { ownerRepoOf, parseTestRequested } from "./test-run";
import type { SurfaceAPI } from "./types";

// ---- the rule ------------------------------------------------------------------------------------

/** The options that make a question linked: Jo's three words that approve, accept or extend something. */
export const LINKED_OPTIONS = ["approve", "accept", "extend"] as const;

/** Is a question with these options linked: one of them is `approve`, `accept` or `extend`, case-insensitive. */
export function isLinkedQuestion(options: readonly string[]): boolean {
	return options.some((o) => (LINKED_OPTIONS as readonly string[]).includes(o.trim().toLowerCase()));
}

/** A question row's options (stored as a JSON array), or none when the column does not hold one. */
export function questionOptions(q: Pick<QuestionRow, "options">): string[] {
	try {
		const v: unknown = JSON.parse(q.options);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

// ---- links ---------------------------------------------------------------------------------------

export interface Pr {
	number: number;
	url: string;
}

/**
 * The plan link: the recorded plan file; `none` only when the workload was never plan-first (a fixed
 * reason); `missing` when it is plan-first and neither a `plan-file:` nor a plan question names one.
 */
export type PlanLink = { kind: "path"; path: string } | { kind: "none"; reason: string } | { kind: "missing"; reason: string };

/** One member's verdict file of a complete review round. */
export interface ReviewFile {
	slice: string;
	/** The round number its `review-round:` entries carry. */
	round: number;
	token: string;
	path: string;
}

/**
 * The review links: `slice` — the question's own slice's newest complete round, one `review:` line per
 * member; `workload` — the question's slice has none, so the newest complete round of every reviewed
 * slice, each line labelled with slice and round; `none` — no round has completed on the workload.
 */
export type ReviewLinks = { kind: "slice"; files: ReviewFile[] } | { kind: "workload"; files: ReviewFile[] } | { kind: "none"; reason: string };

/** The PRs: every open PR read plus every PR the ledger records; `unverified` is the reason the read failed, else null. */
export interface PrLinks {
	prs: Pr[];
	unverified: string | null;
}

export interface Links {
	plan: PlanLink;
	reviews: ReviewLinks;
	prs: PrLinks;
}

/** The outcome of `readPrs`: on a failed read, `prs` still holds every PR the ledger records. */
export type PrRead = { ok: true; prs: Pr[] } | { ok: false; reason: string; prs: Pr[] };

export const planNoneReason = (workloadId: string) => `${workloadId} is not plan-first: it has no plan slice`;
export const reviewNoneReason = (workloadId: string) => `no review round has completed on ${workloadId}`;
/** The refusal for a plan-first workload whose plan file is not recorded (PLAN § The rule). */
export const PLAN_MISSING_REASON = "record the plan file: dispatch the plan review with a `plan file:` line";

/** The verdict file a member's `review-verdict:` names by default: `<dir of the ledger file>/reviews/<wl>/<token>.md`. */
export function verdictPath(ledgerPath: string, workloadId: string, token: string): string {
	return join(dirname(ledgerPath), "reviews", workloadId, `${token}.md`);
}

export const reviewVerdictBody = (token: string, path: string) => `review-verdict: ${token} ${path}`;
export const planFileBody = (path: string) => `plan-file: ${path}`;
export const prSeenBody = (pr: Pr) => `pr-seen: ${pr.number} ${pr.url}`;
export const questionLinksBody = (questionId: string, links: Links) => `question-links: ${questionId} ${JSON.stringify(links)}`;

const REVIEW_VERDICT = /^review-verdict:\s+(\S+)\s+(\/.*)$/;
const PLAN_FILE = /^plan-file:\s+(\/.*)$/;
const PR_SEEN = /^([1-9]\d*)\s+(https?:\/\/\S+)$/;
const QUESTION_LINKS = /^(q-\S+)\s+(\{[\s\S]*\})$/;

/** A classifier machinery line's capture, from a writer `classifierMachineryWriter` admits. */
function machinery(e: Pick<EntryRow, "kind" | "body" | "created_by">, prefix: "review-verdict" | "plan-file", re: RegExp): RegExpExecArray | null {
	if (e.kind !== "assumption" || !classifierMachineryWriter(prefix, e.created_by)) return null;
	return re.exec(e.body.trim());
}

/** token → verdict file, from `review-verdict:` entries (newest wins). */
export function verdictFiles(entries: readonly EntryRow[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of entries) {
		const m = machinery(e, "review-verdict", REVIEW_VERDICT);
		if (m) out.set(m[1]!, m[2]!.trim());
	}
	return out;
}

/** The newest `plan-file:` path, or null. */
export function recordedPlanFile(entries: readonly EntryRow[]): string | null {
	let out: string | null = null;
	for (const e of entries) {
		const m = machinery(e, "plan-file", PLAN_FILE);
		if (m) out = m[1]!.trim();
	}
	return out;
}

/** The workload's valid control entries, `question-links:` and `pr-seen:` admitted from its holders. */
function controlOf(ledger: Ledger, workloadId: string, entries: readonly EntryRow[]): ControlEntry[] {
	return controlEntries(entries, holdersOf(entries, ledger.workload(workloadId)?.holder ?? null, ledger.holders(workloadId)));
}

// ---- review rounds ------------------------------------------------------------------------------

/** A complete review round of one slice: its members that count (not `stopped`, not `failed-dispatch`), each with its `review-round:` entry. */
interface CompleteRound {
	slice: string;
	group: string;
	round: number;
	members: ReviewRoundEntry[];
}

/**
 * Every complete review round on the workload, per slice, in the order its group first appears. The
 * membership is `countRounds`' (classifier/src/rounds.ts): the tokens a `review-group:` lists, the
 * slice's `hand-spawn: … review yes` tokens, and the tokens of the `review-round:` entries naming the
 * group; complete when each has its `review-round:`, and no round when every member that ran is a failed
 * dispatch. Unlike `countRounds`, which counts the current loop only, every loop is read here: the plan
 * question follows a review loop that ended `pass`, and its verdict files are that loop's.
 */
function completeRounds(entries: readonly EntryRow[]): Map<string, CompleteRound[]> {
	interface Group { slice: string; tokens: Map<string, ReviewRoundEntry | null>; ran: Set<string> }
	const groups = new Map<string, Group>();
	const groupOf = (slice: string, id: string): Group => {
		let g = groups.get(id);
		if (!g) groups.set(id, (g = { slice, tokens: new Map(), ran: new Set() }));
		return g;
	};
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const body = e.body.trim();
		const listed = parseReviewGroup(body);
		if (listed) {
			const g = groupOf(listed.slice, listed.group);
			for (const token of listed.tokens) if (!g.tokens.has(token)) g.tokens.set(token, null);
			continue;
		}
		const spawn = parseHandSpawn(body);
		if (spawn) {
			if (e.slice_id === null || !spawn.review) continue;
			const g = groupOf(e.slice_id, spawn.group);
			g.ran.add(spawn.token);
			if (!g.tokens.has(spawn.token)) g.tokens.set(spawn.token, null);
			continue;
		}
		const r = parseReviewRound(body);
		if (r) {
			const g = groupOf(r.slice, r.group);
			if (r.verdict === "accepted" || r.verdict === "withheld") g.ran.add(r.token);
			if (!g.tokens.get(r.token)) g.tokens.set(r.token, r);
		}
	}
	const out = new Map<string, CompleteRound[]>();
	for (const [group, g] of groups) {
		if ([...g.ran].every((t) => g.tokens.get(t)?.verdict === "failed-dispatch")) continue;
		const settled = [...g.tokens.values()].filter((r): r is ReviewRoundEntry => r !== null);
		if (settled.length !== g.tokens.size) continue;
		const members = settled.filter((r) => r.verdict !== "stopped" && r.verdict !== "failed-dispatch");
		if (members.length === 0) continue;
		const round = Math.max(...members.map((m) => m.round));
		const list = out.get(g.slice) ?? [];
		list.push({ slice: g.slice, group, round, members });
		out.set(g.slice, list);
	}
	return out;
}

/** The newest complete round of every reviewed slice, slices in the workload's slice order. */
function newestRounds(ledger: Ledger, workloadId: string, entries: readonly EntryRow[]): CompleteRound[] {
	const rounds = completeRounds(entries);
	const order = ledger.slices(workloadId).map((s) => s.id);
	const at = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
	const slices = [...rounds.keys()].sort((a, b) => at(a) - at(b));
	return slices.map((s) => rounds.get(s)!.at(-1)!);
}

// ---- expected links -----------------------------------------------------------------------------

export interface ExpectedLinksInput {
	workloadId: string;
	/** The question's slice; an orchestrator question's is the standing slice (or null), which has no round. */
	sliceId: string | null;
	/** The PR read (`readPrs`); without network, `{ ok: true, prs: recordedPrs(…) }`. */
	prs: PrRead;
}

/**
 * The links a linked question on `workloadId` must carry (PLAN § The rule). plan: the newest `plan-file:`,
 * else line 1 of the newest plan question; none (fixed reason) when the workload was never plan-first;
 * missing when it is and neither exists. review: the question slice's newest complete round, else every
 * reviewed slice's newest; none (fixed reason) when no round has completed. Each member's file is its
 * `review-verdict:` path, else the path `materializeVerdicts` writes it to. pr: the read's PRs, with the
 * failure reason when the read failed.
 */
export function expectedLinks(ledger: Ledger, input: ExpectedLinksInput): Links {
	const { workloadId: wl } = input;
	const entries = ledger.entries(wl);
	const control = controlOf(ledger, wl, entries);
	return { plan: planLink(ledger, wl, entries, control), reviews: reviewLinks(ledger, wl, entries, input.sliceId), prs: { prs: input.prs.prs, unverified: input.prs.ok ? null : input.prs.reason } };
}

function planLink(ledger: Ledger, wl: string, entries: readonly EntryRow[], control: readonly ControlEntry[]): PlanLink {
	const file = recordedPlanFile(entries);
	if (file !== null) return { kind: "path", path: file };
	const planQuestions = new Set(control.filter((c) => c.prefix === "plan-question").map((c) => c.rest.split(/\s/)[0]!));
	const newest = ledger.questions(wl).filter((q) => planQuestions.has(q.id)).at(-1);
	const line1 = newest?.body.split("\n")[0]?.trim();
	if (line1 && isAbsolute(line1)) return { kind: "path", path: line1 };
	const everPlanFirst = control.some((c) => c.prefix === "plan" && /^first\b/.test(c.rest));
	return everPlanFirst ? { kind: "missing", reason: PLAN_MISSING_REASON } : { kind: "none", reason: planNoneReason(wl) };
}

function reviewLinks(ledger: Ledger, wl: string, entries: readonly EntryRow[], sliceId: string | null): ReviewLinks {
	const newest = newestRounds(ledger, wl, entries);
	if (newest.length === 0) return { kind: "none", reason: reviewNoneReason(wl) };
	const verdicts = verdictFiles(entries);
	const filesOf = (r: CompleteRound): ReviewFile[] =>
		r.members.map((m) => ({ slice: r.slice, round: r.round, token: m.token, path: verdicts.get(m.token) ?? verdictPath(ledger.path, wl, m.token) }));
	const own = newest.find((r) => r.slice === sliceId);
	return own ? { kind: "slice", files: filesOf(own) } : { kind: "workload", files: newest.flatMap(filesOf) };
}

// ---- the header ---------------------------------------------------------------------------------

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The header lines of a linked question, in order: `plan: <path>` | `plan: none — <reason>` |
 * `plan: missing — <reason>`; one `review: <path>` per member of the question slice's round, or one
 * `review (<sl>, round <n>): <path>` per member of every reviewed slice's newest round, or
 * `review: none — <reason>`; one `pr: <url>` per PR (no line when there is none), then
 * `pr: unverified — gh pr list failed: <reason>` when the read failed.
 */
export function linkHeader(links: Links): string[] {
	const out: string[] = [];
	const p = links.plan;
	out.push(p.kind === "path" ? `plan: ${p.path}` : `plan: ${p.kind} — ${p.reason}`);
	const r = links.reviews;
	if (r.kind === "none") out.push(`review: none — ${r.reason}`);
	else for (const f of r.files) out.push(r.kind === "slice" ? `review: ${f.path}` : `review (${f.slice}, round ${f.round}): ${f.path}`);
	for (const pr of links.prs.prs) out.push(`pr: ${pr.url}`);
	if (links.prs.unverified !== null) out.push(`pr: unverified — gh pr list failed: ${flat(links.prs.unverified)}`);
	return out;
}

const LINK_LINE = /^(plan|review|pr)(\s\([^)]*\))?:/;

/**
 * Why a model-authored linked question's body does not start with exactly `linkHeader(links)`, or null
 * when it does. Fails closed: a plan-first workload with no recorded plan file, or a PR read that failed,
 * is refused whatever the body says. The reason names the missing or wrong line and prints the header to
 * paste; the caller adds that nothing was asked.
 */
export function linkProblem(body: string, links: Links): string | null {
	if (links.plan.kind === "missing") return `the workload is plan-first and no plan file is recorded: ${links.plan.reason}`;
	if (links.prs.unverified !== null) {
		return `the open PRs could not be read (gh pr list failed: ${flat(links.prs.unverified)}); retry once gh answers`;
	}
	const header = linkHeader(links);
	const lines = body.split("\n").map((l) => l.trimEnd());
	const paste = `A question offering approve, accept or extend starts with exactly these lines, computed from the ledger (paste them as they are):\n${header.join("\n")}`;
	for (let i = 0; i < header.length; i++) {
		const got = lines[i];
		if (got === header[i]) continue;
		const what = got === undefined || !LINK_LINE.test(got)
			? `line ${i + 1} must be \`${header[i]}\`; it is missing`
			: `line ${i + 1} is \`${got}\`, not \`${header[i]}\``;
		return `${what}. ${paste}`;
	}
	const extra = lines[header.length];
	if (extra !== undefined && LINK_LINE.test(extra)) return `line ${header.length + 1} \`${extra}\` is not one of the links. ${paste}`;
	return null;
}

/**
 * The plan question's link checks (PLAN § Question kinds, plan approve), run after D7's
 * `planQuestionProblem` passed: line 1 is the recorded plan file, the latest plan review round
 * has settled every member, and the `review:` line's verdict file is one of that round's files.
 */
export function planLinkProblem(body: string, links: Links, ledger: Ledger, workloadId: string, sliceId: string): string | null {
	const lines = body.split("\n").map((l) => l.trim());
	if (links.plan.kind === "missing") return `the workload is plan-first and no plan file is recorded: ${links.plan.reason}`;
	if (links.plan.kind === "none") return `the plan slice ${sliceId} has no recorded plan file; ${PLAN_MISSING_REASON}`;
	if (links.plan.kind === "path" && lines[0] !== links.plan.path) {
		return `line 1 is "${lines[0] ?? ""}", not the workload's recorded plan file: put ${links.plan.path} on line 1`;
	}
	// A passing loop can end before the plan question. Keep its rounds, but never let a completed
	// round from an older loop stand in for a newer, still-running fan-out.
	const entries = ledger.entries(workloadId);
	const rounds = countRounds(entries.filter((e) => e.kind !== "assumption" || parseReviewLoopEnd(e.body)?.slice !== sliceId), sliceId).rounds;
	const latest = rounds.at(-1);
	if (!latest) return `the plan slice ${sliceId} has no completed review round; wait for a review round with authoritative verdict files and retry`;
	if (!latest.complete) {
		const settled = latest.members.filter((m) => m.verdict !== null).length;
		return `the plan slice ${sliceId}'s latest review round (${latest.group}) has not completed (${settled} of ${latest.members.length} members settled); wait for all members and retry`;
	}
	if (links.reviews.kind !== "slice") {
		return `the plan slice ${sliceId}'s latest completed review round has no authoritative verdict links; wait for its verdict files and retry`;
	}
	const reviewFiles = links.reviews.files;
	if (reviewFiles.length !== latest.members.length || !latest.members.every((m) => reviewFiles.some((f) => f.token === m.token))) {
		return `the plan slice ${sliceId}'s latest completed review round has no authoritative verdict links; wait for its verdict files and retry`;
	}
	const files = reviewFiles.map((f) => f.path);
	const review = lines.find((l) => l.startsWith("review:"));
	const verdict = review?.slice("review:".length).split(",").at(-1)?.trim() ?? "";
	if (files.includes(verdict)) return null;
	return `the review line's verdict file "${verdict}" is not one of the plan slice's newest review round's verdict files: name ${files.length === 1 ? files[0] : `one of ${files.join(", ")}`}`;
}

// ---- `question-links:` --------------------------------------------------------------------------

function isLinks(v: unknown): v is Links {
	if (v === null || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	const plan = o.plan as Record<string, unknown> | null | undefined;
	const reviews = o.reviews as Record<string, unknown> | null | undefined;
	const prs = o.prs as Record<string, unknown> | null | undefined;
	return typeof plan?.kind === "string" && typeof reviews?.kind === "string" && prs != null && Array.isArray(prs.prs) && (prs.unverified === null || typeof prs.unverified === "string");
}

/** A `question-links:` control entry's rest, parsed: the question id and its links; null when malformed. */
export function parseQuestionLinks(rest: string): { questionId: string; links: Links } | null {
	const m = QUESTION_LINKS.exec(rest.trim());
	if (!m) return null;
	try {
		const v: unknown = JSON.parse(m[2]!);
		return isLinks(v) ? { questionId: m[1]!, links: v } : null;
	} catch {
		return null;
	}
}

/** A question's recorded links and when they were recorded (the tick re-reads a question's PRs at most every 10 minutes unless unverified). */
export interface RecordedLinks {
	links: Links;
	createdAt: string;
}

/** The newest recorded links of question `questionId` among `control` (a workload's valid control entries), or null. */
export function questionLinksIn(control: readonly ControlEntry[], questionId: string): RecordedLinks | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.prefix !== "question-links") continue;
		const parsed = parseQuestionLinks(c.rest);
		if (parsed?.questionId === questionId) return { links: parsed.links, createdAt: c.createdAt };
	}
	return null;
}

/** The newest recorded links of question `questionId`, read from the entries of `workloadId` (where the entry was written), or null. */
export function questionLinks(ledger: Ledger, workloadId: string, questionId: string): RecordedLinks | null {
	return questionLinksIn(controlOf(ledger, workloadId, ledger.entries(workloadId)), questionId);
}

/** Record `links` for question `questionId` on `workloadId` as `by`; call inside the question's write transaction. */
export function recordQuestionLinks(ledger: Ledger, o: { by: string; workloadId: string; sliceId?: string | null; questionId: string; links: Links }): string {
	return ledger.recordEntry({ by: o.by, workloadId: o.workloadId, sliceId: o.sliceId ?? null, kind: "assumption", body: questionLinksBody(o.questionId, o.links) });
}

/** Do two link sets name the same lines (the tick records a new entry only when they differ)? */
export function sameLinks(a: Links, b: Links): boolean {
	return linkHeader(a).join("\n") === linkHeader(b).join("\n");
}

// ---- PRs ----------------------------------------------------------------------------------------

/** The `pr-seen:` rest parsed, or null. */
export function parsePrSeen(rest: string): Pr | null {
	const m = PR_SEEN.exec(rest.trim());
	return m ? { number: Number(m[1]), url: m[2]! } : null;
}

/**
 * Every PR the ledger records for `workloadId`, by number: its `pr-seen:` entries, and the PRs its
 * `test-requested:` entries name (their URL built on `ownerRepo` when given; without it a PR no
 * `pr-seen:` names has no URL to show and is left out).
 */
export function recordedPrs(ledger: Ledger, workloadId: string, ownerRepo: string | null = null): Pr[] {
	const control = controlOf(ledger, workloadId, ledger.entries(workloadId));
	const out = new Map<number, Pr>();
	for (const c of control) {
		if (c.prefix === "pr-seen") {
			const pr = parsePrSeen(c.rest);
			if (pr) out.set(pr.number, pr);
		} else if (c.prefix === "test-requested" && ownerRepo !== null) {
			const req = parseTestRequested(c.body);
			if (req && !out.has(req.pr)) out.set(req.pr, { number: req.pr, url: `https://github.com/${ownerRepo}/pull/${req.pr}` });
		}
	}
	return [...out.values()].sort((a, b) => a.number - b.number);
}

/** Record `pr-seen:` for each of `prs` no valid `pr-seen:` on the workload names yet (number and url), as `by`; returns how many it wrote. */
export function recordPrsSeen(ledger: Ledger, workloadId: string, by: string, prs: readonly Pr[]): number {
	return ledger.write(() => {
		const seen = new Set(
			controlOf(ledger, workloadId, ledger.entries(workloadId)).flatMap((c) => {
				const pr = c.prefix === "pr-seen" ? parsePrSeen(c.rest) : null;
				return pr ? [`${pr.number} ${pr.url}`] : [];
			}),
		);
		let n = 0;
		for (const pr of prs) {
			if (seen.has(`${pr.number} ${pr.url}`)) continue;
			seen.add(`${pr.number} ${pr.url}`);
			ledger.recordEntry({ by, workloadId, kind: "assumption", body: prSeenBody(pr) });
			n++;
		}
		return n;
	});
}

/** The PR a `gh pr create` printed: the URL its output ends with, or null. */
export function createdPr(output: string): Pr | null {
	const last = output.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
	const m = /^(https?:\/\/\S+\/pull\/([1-9]\d*))\/?$/.exec(last);
	return m ? { number: Number(m[2]), url: m[1]! } : null;
}

/** Does a bash command run `gh pr create` (alone or as one step of a compound command)? */
export function runsGhPrCreate(command: string): boolean {
	return /(?:^|[\s;&|(])gh\s+pr\s+create\b/.test(command);
}

export type Exec = NonNullable<SurfaceAPI["exec"]>;
const READ_MS = 30_000;

/** The `owner/repo` of the workload's `repo:` origin; null when there is no GitHub origin to read (no repo, no origin, another host); a string reason when git failed. */
async function originOwnerRepo(exec: Exec, ledger: Ledger, workloadId: string): Promise<{ ownerRepo: string | null } | { error: string }> {
	const repo = repoOf(ledger, workloadId);
	if (repo === null) return { ownerRepo: null };
	const r = await exec("git", ["-C", repo, "config", "--get", "remote.origin.url"], { timeout: READ_MS });
	if (r.code === 1 && !r.stderr.trim()) return { ownerRepo: null };
	if (r.code !== 0) return { error: `git config --get remote.origin.url exited ${r.code}: ${flat(r.stderr || r.stdout)}` };
	return { ownerRepo: ownerRepoOf(r.stdout.trim()) };
}

/**
 * The PRs of `workloadId`'s branch `wl/<wl>` (PLAN § The rule, pr): `gh pr list --repo <owner/repo> --head
 * wl/<wl> --state open --json number,url` through `exec` (OMP's `pi.exec` shape), plus every PR the ledger
 * records. Each PR read that no `pr-seen:` names is recorded as `by`. A workload with no GitHub origin has
 * nothing to read: its recorded PRs, ok. A failed read returns the reason and the recorded PRs.
 */
export async function readPrs(exec: Exec, ledger: Ledger, workloadId: string, by: string): Promise<PrRead> {
	let ownerRepo: string | null = null;
	try {
		const origin = await originOwnerRepo(exec, ledger, workloadId);
		if ("error" in origin) return { ok: false, reason: origin.error, prs: recordedPrs(ledger, workloadId) };
		ownerRepo = origin.ownerRepo;
		if (ownerRepo === null) return { ok: true, prs: recordedPrs(ledger, workloadId) };
		const r = await exec("gh", ["pr", "list", "--repo", ownerRepo, "--head", branchName(workloadId), "--state", "open", "--json", "number,url"], { timeout: READ_MS });
		if (r.code !== 0) return { ok: false, reason: flat(r.stderr || r.stdout) || `exit ${r.code}${r.killed ? " (killed)" : ""}`, prs: recordedPrs(ledger, workloadId, ownerRepo) };
		const read = parsePrList(r.stdout);
		if (read === null) return { ok: false, reason: `printed no PR list: ${flat(r.stdout).slice(0, 200)}`, prs: recordedPrs(ledger, workloadId, ownerRepo) };
		recordPrsSeen(ledger, workloadId, by, read);
		return { ok: true, prs: recordedPrs(ledger, workloadId, ownerRepo) };
	} catch (err) {
		return { ok: false, reason: flat(String(err)), prs: recordedPrs(ledger, workloadId, ownerRepo) };
	}
}

function parsePrList(stdout: string): Pr[] | null {
	let v: unknown;
	try {
		v = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(v)) return null;
	const out: Pr[] = [];
	for (const x of v) {
		const o = x !== null && typeof x === "object" ? (x as Record<string, unknown>) : {};
		if (typeof o.number !== "number" || !Number.isInteger(o.number) || o.number < 1 || typeof o.url !== "string" || !/^https?:\/\/\S+$/.test(o.url)) return null;
		out.push({ number: o.number, url: o.url });
	}
	return out;
}

// ---- legacy rounds -------------------------------------------------------------------------------

/** The hand's own reply for `token`: `<session root>/<agentId>.md`, from its settle's routing row (else its `hand-spawn:` root); null when there is none. */
function handReply(ledger: Ledger, workloadId: string, entries: readonly EntryRow[], token: string): { path: string; text: string } | null {
	const routingId = settledTokens(entries).get(token);
	if (routingId === undefined) return null;
	const root = handSpawns(entries).findLast((s) => s.token === token)?.root ?? null;
	const row = ledger.routings(workloadId).find((r) => r.id === routingId);
	const dir = row?.session_root || root;
	if (!row?.agent_id || !dir) return null;
	const path = join(dir, `${row.agent_id}.md`);
	try {
		return { path, text: readFileSync(path, "utf8") };
	} catch {
		return null;
	}
}

function findingsText(f: FindingsOrUnknown): string[] {
	if (f === UNKNOWN) return ["counts: unknown (the hand's findings block was missing or malformed, or it never ran)"];
	return [`counts: ${severityLine(f)}`, ...(f.titles.length === 0 ? [] : ["findings:", ...f.titles.map((t) => `- [${t.severity}/${t.kind}] ${t.title}`)])];
}

const NO_REPLY: Partial<Record<ReviewRoundEntry["verdict"], string>> = {
	dropped: "the hand never replied: it was dropped (its job ended before it spawned, or it was lost)",
	refused: "the hand never replied: its spawn was refused",
};

/**
 * Write a verdict file, and record its `review-verdict:`, for every member of the rounds `expectedLinks`
 * links (the newest complete round of every reviewed slice) that has no `review-verdict:` yet: a round
 * settled before verdict files existed (PLAN § The rule, legacy rounds). The file holds the member's
 * `review-round:` record (verdict, blocking, counts, finding titles) and the hand's own reply
 * `<session dir>/<agentId>.md` when its settle names one and the file exists. Idempotent: a token with an
 * entry is skipped. Returns the tokens it materialized.
 */
export function materializeVerdicts(ledger: Ledger, workloadId: string, by: string): string[] {
	const entries = ledger.entries(workloadId);
	const verdicts = verdictFiles(entries);
	const todo: { token: string; path: string }[] = [];
	for (const round of newestRounds(ledger, workloadId, entries)) {
		for (const m of round.members) {
			if (verdicts.has(m.token)) continue;
			const path = verdictPath(ledger.path, workloadId, m.token);
			const reply = handReply(ledger, workloadId, entries, m.token);
			const lines = [
				`# Review verdict ${m.token}`,
				"",
				`workload: ${workloadId}`,
				`slice: ${m.slice}`,
				`round: ${m.round}`,
				`group: ${m.group}`,
				`verdict: ${m.verdict}`,
				`blocking: ${m.findings === UNKNOWN ? UNKNOWN : blockingOf(m.findings)}`,
				...findingsText(m.findings),
				"",
				`Materialized from the ledger's \`review-round:\` entry for ${m.token}: this round settled before verdict files were written.`,
			];
			if (reply) lines.push("", `## The hand's reply (${reply.path})`, "", reply.text.trimEnd());
			else lines.push("", NO_REPLY[m.verdict] ?? `No reply file of the hand was found (verdict ${m.verdict}).`);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${lines.join("\n")}\n`);
			todo.push({ token: m.token, path });
		}
	}
	if (todo.length === 0) return [];
	return ledger.write(() => {
		const now = verdictFiles(ledger.entries(workloadId));
		const done: string[] = [];
		for (const t of todo) {
			if (now.has(t.token)) continue;
			ledger.recordEntry({ by, workloadId, kind: "assumption", body: reviewVerdictBody(t.token, t.path) });
			done.push(t.token);
		}
		return done;
	});
}

// ---- at raise time -------------------------------------------------------------------------------

/**
 * The links of a linked question about to be raised on `workloadId` (slice `sliceId`, null or the standing
 * slice for an orchestrator question): legacy rounds materialized first (`materializeVerdicts`), so every
 * review link is a verdict file with its `review-verdict:`; then the PRs read (`readPrs`, which records
 * each new one as `pr-seen:`); then `expectedLinks`. Writes as `by`. A model-authored question passes the
 * result to `linkProblem` (or `planLinkProblem`) and is refused on a reason; a machinery one prepends
 * `linkHeader`. Either records it with `recordQuestionLinks` in the question's write.
 */
export async function linksAtRaise(exec: Exec, ledger: Ledger, o: { workloadId: string; sliceId: string | null; by: string }): Promise<Links> {
	materializeVerdicts(ledger, o.workloadId, o.by);
	const prs = await readPrs(exec, ledger, o.workloadId, o.by);
	return expectedLinks(ledger, { workloadId: o.workloadId, sliceId: o.sliceId, prs });
}
