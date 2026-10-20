#!/usr/bin/env bun
// backlog-rank: the daily Jev re-rank of both backlogs and the board sync, the effects (PLAN wl-mvh42n85yo0m4g § 2 D2,
// D4–D7). Every decision is surface/src/backlog-rank.ts's; this file reads and writes the state dir, runs gh, asks Jev
// and reads the ledger.
//
//   bun surface/scripts/backlog-rank.ts [--dry-run | --now | --undo <backup.json>]      (as2 backlog-rank …)
//
// State dir: $AGENT_SYSTEM_BACKLOG_RANK_DIR, else $HOME/.agent-system-2/backlog-rank/ (goals.md, pins.json, cache.jsonl,
// runs/<id>/{backup.json,order.json,attempts.jsonl,jev.jsonl}, last-run.json, lock.sqlite (permanent mutex), lock (diagnostic)).
// Board: thewolff's project $AGENT_SYSTEM_BACKLOG_RANK_PROJECT (default 1). Comment issue: $AGENT_SYSTEM_BACKLOG_RANK_COMMENT
// (owner/repo#N, default thewolff/jo-issues#153). Ledger: $AGENT_SYSTEM_LEDGER_DB, else ~/.agent-system-2/ledger.db.
//
// Tokens (Jo's `board-calls`, q-mvh4doyd63kqv4): `gh auth token -u thewolff` is read once per process into memory and
// passed as GH_TOKEN to `gh api graphql` children only; every other gh child runs as the active account, with
// GH_TOKEN and GITHUB_TOKEN removed. Nothing here runs `gh auth switch`, `login` or `logout`.
//
// Test hooks (never set in production): AGENT_SYSTEM_BACKLOG_RANK_JUDGE (a module whose `openJudge()` stands in for OMP's
// judge), AGENT_SYSTEM_BACKLOG_RANK_PAUSE_MS (the pause between mutation requests, default 1500),
// AGENT_SYSTEM_BACKLOG_RANK_BACKOFF_MS (the three waits after an ambiguous outcome, default 5000,10000,20000) and
// AGENT_SYSTEM_BACKLOG_RANK_CLOCK (an ISO instant used as now).
//
// Exit: 0 done, not due, or already running · 1 a failed attempt, comment, undo or read · 2 usage, or no goals.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { askJudgment, type JudgmentJudge } from "../../classifier/src/judge-ask";
import { defaultLedgerPath } from "../../ledger/src/locality";
import {
	advance, applyPins, BACKLOG_REPOS, type BacklogItem, type BacklogRepo, backlogQuestions, type BoardField, type BoardItem, type BoardOp, type BoardSnapshot,
	type BoardValue, beginAttempt, boardDiff, type CacheEntry, cacheKey, cacheLine, calendarDay, checkAnswers, checkPins, commentBody, dateCandidates,
	desiredItems, dueRule, failAttempt, hasRunComment, isJevJudge, itemLaneStates, itemsFromIssues, itemUrgency, ISSUE_LIST_LIMIT, jevRank, judgeState,
	type DesiredItem, type LaneInstruction, type LaneState, type LaneWorkload, type LastRun, MAX_ATTEMPTS, markCommented, MUTATION_PAUSE_MS, type MutationBatch,
	mutationBatches, newRunId, nextStep, parseCache, parseGoals, parseLastRun, type PlacedPin, previousRanks, type Ranked, rankedAt, rankMoves, type IssueFieldValue,
	type RunComment, type SkippedPin, startRun, undoCommand, undoPlan,
} from "../src/backlog-rank";
import { ompPackagesRoot } from "./chaos-stub";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const USAGE = "usage: as2 backlog-rank [--dry-run | --now | --undo <backup.json>]";
/** The board's owner and the account whose token every board call carries (D6). */
const BOARD_OWNER = "thewolff";
const JUDGE_CONCURRENCY = 4;
const JUDGE_TIMEOUT_MS = 120_000;
/** Consecutive ambiguous outcomes that end an attempt (D6). */
const MAX_AMBIGUOUS = 3;
const DEFAULT_BACKOFF_MS = [5_000, 10_000, 20_000];
/** Clean apply-and-reread rounds before a board that will not settle fails the attempt. */
const MAX_ROUNDS = 20;

// ---- configuration ------------------------------------------------------------------------------------------------

interface Config {
	stateDir: string;
	ledgerDb: string;
	projectNumber: number;
	comment: { repo: string; number: number };
	pauseMs: number;
	backoffMs: number[];
	now: () => Date;
	judgeModule: string | null;
}

class Refusal extends Error {}

function config(env: Record<string, string | undefined>): Config {
	const home = env.HOME ?? "";
	const project = env.AGENT_SYSTEM_BACKLOG_RANK_PROJECT?.trim() || "1";
	if (!/^[1-9]\d*$/.test(project)) throw new Refusal(`AGENT_SYSTEM_BACKLOG_RANK_PROJECT must be a project number, not "${project}"`);
	const comment = env.AGENT_SYSTEM_BACKLOG_RANK_COMMENT?.trim() || "thewolff/jo-issues#153";
	const m = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(comment);
	if (!m) throw new Refusal(`AGENT_SYSTEM_BACKLOG_RANK_COMMENT must be owner/repo#N, not "${comment}"`);
	const pause = env.AGENT_SYSTEM_BACKLOG_RANK_PAUSE_MS;
	const backoff = env.AGENT_SYSTEM_BACKLOG_RANK_BACKOFF_MS;
	const backoffMs = backoff ? backoff.split(",").map(Number) : DEFAULT_BACKOFF_MS;
	if (backoffMs.length !== MAX_AMBIGUOUS || backoffMs.some((n) => !Number.isFinite(n) || n < 0)) throw new Refusal(`AGENT_SYSTEM_BACKLOG_RANK_BACKOFF_MS must be ${MAX_AMBIGUOUS} waits in ms`);
	const clock = env.AGENT_SYSTEM_BACKLOG_RANK_CLOCK;
	if (clock !== undefined && Number.isNaN(Date.parse(clock))) throw new Refusal(`AGENT_SYSTEM_BACKLOG_RANK_CLOCK is not an instant: ${clock}`);
	return {
		stateDir: resolve(env.AGENT_SYSTEM_BACKLOG_RANK_DIR?.trim() || join(home, ".agent-system-2", "backlog-rank")),
		ledgerDb: defaultLedgerPath(env),
		projectNumber: Number(project),
		comment: { repo: m[1]!, number: Number(m[2]) },
		pauseMs: pause !== undefined && Number.isFinite(Number(pause)) ? Number(pause) : MUTATION_PAUSE_MS,
		backoffMs,
		now: clock === undefined ? () => new Date() : () => new Date(clock),
		judgeModule: env.AGENT_SYSTEM_BACKLOG_RANK_JUDGE?.trim() || null,
	};
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve: done } = Promise.withResolvers<void>();
	setTimeout(done, ms);
	return promise;
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const log = (line: string): void => console.log(`backlog-rank: ${line}`);
/** One key of parsed JSON, unknown until checked. */
const prop = (raw: unknown, key: string): unknown => (typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined);

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

// ---- the state dir (D2) -------------------------------------------------------------------------------------------

function statePaths(dir: string) {
	return { goals: join(dir, "goals.md"), pins: join(dir, "pins.json"), cache: join(dir, "cache.jsonl"), lastRun: join(dir, "last-run.json"), lock: join(dir, "lock") };
}
function runPaths(dir: string, runId: string) {
	const root = join(dir, "runs", runId);
	return { root, backup: join(root, "backup.json"), order: join(root, "order.json"), attempts: join(root, "attempts.jsonl"), jev: join(root, "jev.jsonl") };
}

/** goals.md's goal lines; a missing file or no `goal:` line refuses (exit 2), naming the path. */
function readGoals(dir: string): string[] {
	const path = statePaths(dir).goals;
	if (!existsSync(path)) throw new Refusal(`no goals file at ${path}; write one \`goal: …\` line per goal`);
	const goals = parseGoals(readFileSync(path, "utf8"));
	if (goals.length === 0) throw new Refusal(`${path} has no \`goal: \` line`);
	return goals;
}

function readLastRun(dir: string): LastRun | null {
	const path = statePaths(dir).lastRun;
	if (!existsSync(path)) return null;
	return parseLastRun(JSON.parse(readFileSync(path, "utf8")));
}
function saveRun(dir: string, run: LastRun): LastRun {
	writeAtomic(statePaths(dir).lastRun, `${JSON.stringify(run, null, 1)}\n`);
	return run;
}

// ---- the lock (D2) ------------------------------------------------------------------------------------------------

/** The lock holder's pid and start, or null when the lock is gone or unreadable (a torn write). */
function lockHolder(path: string): { pid: number; startedAt: string } | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		const pid = prop(raw, "pid");
		const startedAt = prop(raw, "startedAt");
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid, startedAt: typeof startedAt === "string" ? startedAt : "?" } : null;
	} catch {
		return null;
	}
}

/**
 * A SQLite write transaction is the process mutex, held until release or process death. Never unlink/replace its
 * database: every contender must lock the same inode. The JSON file is diagnostic only, not ownership authority.
 * This reuses the repository's BEGIN IMMEDIATE serialization without a platform-specific flock binary.
 */
export function takeLock(path: string, beforePublish?: () => void): (() => void) | null {
	const db = new Database(`${path}.sqlite`, { create: true });
	try {
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("BEGIN IMMEDIATE");
	} catch (e) {
		db.close();
		if (prop(e, "code") === "SQLITE_BUSY" || prop(e, "errno") === 5) return null;
		throw e;
	}
	try {
		beforePublish?.();
		writeAtomic(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
	} catch (e) {
		db.exec("ROLLBACK");
		db.close();
		throw e;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			try {
				unlinkSync(path);
			} catch (e) {
				if (prop(e, "code") !== "ENOENT") throw e;
			}
		} finally {
			db.exec("ROLLBACK");
			db.close();
		}
	};
}

// ---- gh ----------------------------------------------------------------------------------------------------------

interface Proc {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * One gh child. Its env is this process's minus GH_TOKEN and GITHUB_TOKEN, so it runs as the active account; `token`
 * (thewolff's, board GraphQL calls only) is set as GH_TOKEN. `auth` is allowed only as `auth token`.
 */
async function gh(args: string[], o: { input?: string; token?: string } = {}): Promise<Proc> {
	if (args[0] === "auth" && args[1] !== "token") throw new Error(`refused: gh ${args.join(" ")} (the run never switches or changes gh accounts)`);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "GH_TOKEN" && k !== "GITHUB_TOKEN") env[k] = v;
	if (o.token !== undefined) env.GH_TOKEN = o.token;
	const child = Bun.spawn(["gh", ...args], { env, stdin: o.input === undefined ? "ignore" : new Blob([o.input]), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

const ghFailure = (what: string, p: Proc): Error => new Error(`${what}: gh exit ${p.code}: ${oneLine(p.stderr || p.stdout).slice(0, 300) || "no output"}`);

let heldToken: string | null = null;
/** thewolff's token, read once per process and kept in memory only. */
async function boardToken(): Promise<string> {
	if (heldToken !== null) return heldToken;
	const p = await gh(["auth", "token", "-u", BOARD_OWNER]);
	const token = p.stdout.trim();
	if (p.code !== 0 || token === "") throw ghFailure(`gh auth token -u ${BOARD_OWNER}`, p);
	heldToken = token;
	return token;
}

/** Each backlog repo's open issues, as the active account; a list at the --limit refuses the run (itemsFromIssues). */
async function fetchItems(): Promise<{ items: BacklogItem[]; counts: Record<BacklogRepo, number> }> {
	const items: BacklogItem[] = [];
	const counts = {} as Record<BacklogRepo, number>;
	for (const r of BACKLOG_REPOS) {
		const p = await gh(["issue", "list", "--repo", r.nameWithOwner, "--state", "open", "--limit", String(ISSUE_LIST_LIMIT), "--json", "id,number,title,body,createdAt"]);
		if (p.code !== 0) throw ghFailure(`listing ${r.nameWithOwner}'s open issues`, p);
		const these = itemsFromIssues(r.repo, JSON.parse(p.stdout));
		counts[r.repo] = these.length;
		items.push(...these);
	}
	return { items, counts };
}

/** Whether a pinned issue that is not open exists closed (else it is not found). */
async function closedPins(skipped: readonly SkippedPin[]): Promise<Set<string>> {
	const closed = new Set<string>();
	for (const pin of skipped) {
		const [prefix, number] = pin.id.split("#");
		const repo = BACKLOG_REPOS.find((r) => r.prefix === prefix)!;
		const p = await gh(["issue", "view", number!, "--repo", repo.nameWithOwner, "--json", "state"]);
		if (p.code === 0 && prop(JSON.parse(p.stdout), "state") === "CLOSED") closed.add(pin.id);
	}
	return closed;
}

// ---- the board (D6) -----------------------------------------------------------------------------------------------

const PAGE = "pageInfo { hasNextPage endCursor }";
const NESTED = {
	ProjectV2ItemFieldLabelValue: { key: "labels", nodes: "name" },
	ProjectV2ItemFieldUserValue: { key: "users", nodes: "login" },
	ProjectV2ItemFieldPullRequestValue: { key: "pullRequests", nodes: "number repository { nameWithOwner }" },
	ProjectV2ItemFieldReviewerValue: { key: "reviewers", nodes: "__typename ... on User { login } ... on Team { slug } ... on Mannequin { login }" },
} as const;
const FIELD_REF = "field { ... on ProjectV2FieldCommon { id name dataType } }";
/** Every ProjectV2ItemFieldValue type with its content, verbatim. */
const VALUE_NODE = [
	"__typename",
	`... on ProjectV2ItemFieldTextValue { text ${FIELD_REF} }`,
	`... on ProjectV2ItemFieldNumberValue { number ${FIELD_REF} }`,
	`... on ProjectV2ItemFieldDateValue { date ${FIELD_REF} }`,
	`... on ProjectV2ItemFieldSingleSelectValue { optionId name ${FIELD_REF} }`,
	`... on ProjectV2ItemFieldIterationValue { iterationId title startDate duration ${FIELD_REF} }`,
	`... on ProjectV2ItemFieldMultiSelectValue { options { id name } ${FIELD_REF} }`,
	...Object.entries(NESTED).map(([type, { key, nodes }]) => `... on ${type} { ${key}(first: 25) { ${PAGE} nodes { ${nodes} } } ${FIELD_REF} }`),
	`... on ProjectV2ItemFieldMilestoneValue { milestone { title number } ${FIELD_REF} }`,
	`... on ProjectV2ItemFieldRepositoryValue { repository { nameWithOwner } ${FIELD_REF} }`,
	"... on ProjectV2ItemIssueFieldValue { issueFieldValue { __typename ... on IssueFieldTextValue { textValue: value } ... on IssueFieldNumberValue { numberValue: value } "
	+ `... on IssueFieldDateValue { dateValue: value } ... on IssueFieldSingleSelectValue { singleSelectValue: value optionId } ... on IssueFieldMultiSelectValue { multiSelectValue: value } } ${FIELD_REF} }`,
].join(" ");
/** Field values per item page: a project has a few dozen fields at most; the rest come by FIELD_VALUES_QUERY. */
const VALUES_FIRST = 20;
export const FIELDS_QUERY = `query($owner: String!, $number: Int!, $cursor: String) { user(login: $owner) { projectV2(number: $number) { id fields(first: 100, after: $cursor) { ${PAGE} nodes { __typename ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } ... on ProjectV2MultiSelectField { options: multiSelectOptions { id name } } ... on ProjectV2IterationField { configuration { duration startDay iterations { id title startDate duration } completedIterations { id title startDate duration } } } } } } } }`;
export const ITEMS_QUERY = `query($owner: String!, $number: Int!, $cursor: String) { user(login: $owner) { projectV2(number: $number) { id items(first: 100, after: $cursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) { ${PAGE} nodes { id type isArchived createdAt content { __typename ... on Issue { id number title repository { nameWithOwner } } ... on PullRequest { id number title repository { nameWithOwner } } ... on DraftIssue { id title } } fieldValues(first: ${VALUES_FIRST}) { ${PAGE} nodes { ${VALUE_NODE} } } } } } } }`;
export const FIELD_VALUES_QUERY = `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item { fieldValues(first: ${VALUES_FIRST}, after: $cursor) { ${PAGE} nodes { ${VALUE_NODE} } } } } }`;
export const MULTI_SELECT_QUERY = `query { __type(name: "ProjectV2FieldValue") { inputFields { name } } }`;

interface Page {
	nodes: unknown[];
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
function asPage(raw: unknown, what: string): Page {
	const nodes = prop(raw, "nodes");
	const info = prop(raw, "pageInfo");
	const more = prop(info, "hasNextPage");
	const end = prop(info, "endCursor");
	if (!Array.isArray(nodes) || typeof more !== "boolean") throw new Error(`${what}: not a page`);
	return { nodes, pageInfo: { hasNextPage: more, endCursor: typeof end === "string" ? end : null } };
}
async function allPages(what: string, load: (cursor: string | null) => Promise<Page>): Promise<unknown[]> {
	const all: unknown[] = [];
	let cursor: string | null = null;
	for (;;) {
		const page = await load(cursor);
		all.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) return all;
		if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error(`${what}: pagination stalled`);
		cursor = page.pageInfo.endCursor;
	}
}

type MutationOutcome = { ok: true } | { ok: false; why: string };

/** The board through `gh api graphql`, every call with thewolff's token; mutation requests at least `pauseMs` apart. */
class Board {
	private lastMutation = 0;
	constructor(private readonly token: string, private readonly cfg: Config) {}

	private async call(query: string, variables: Record<string, unknown>): Promise<Proc> {
		return gh(["api", "graphql", "--input", "-"], { input: JSON.stringify({ query, variables }), token: this.token });
	}

	/** A read: its `data`, or a throw on any failure. */
	async query(query: string, variables: Record<string, unknown>, what: string): Promise<unknown> {
		const p = await this.call(query, variables);
		if (p.code !== 0) throw ghFailure(what, p);
		const out: unknown = JSON.parse(p.stdout);
		const errors = prop(out, "errors");
		if (Array.isArray(errors) && errors.length > 0) throw new Error(`${what}: ${oneLine(JSON.stringify(errors)).slice(0, 300)}`);
		return prop(out, "data");
	}

	/**
	 * One batch. Anything but a clean reply with every alias answered is ambiguous (D6): a non-zero exit (a 5xx, a
	 * secondary rate limit, a lost response) or `errors`, with or without partial `data`. The caller never replays it.
	 */
	async mutate(batch: MutationBatch): Promise<MutationOutcome> {
		const wait = this.lastMutation + this.cfg.pauseMs - Date.now();
		if (this.lastMutation > 0 && wait > 0) await sleep(wait);
		let p: Proc;
		try {
			p = await this.call(batch.query, batch.variables);
		} finally {
			this.lastMutation = Date.now();
		}
		const head = oneLine(p.stderr || p.stdout).slice(0, 200);
		if (p.code !== 0) return { ok: false, why: `gh exit ${p.code}: ${head || "no response"}` };
		let out: unknown;
		try {
			out = JSON.parse(p.stdout);
		} catch {
			return { ok: false, why: `unreadable response: ${head}` };
		}
		const errors = prop(out, "errors");
		if (Array.isArray(errors) && errors.length > 0) return { ok: false, why: `errors: ${oneLine(JSON.stringify(errors)).slice(0, 200)}` };
		const data = prop(out, "data");
		const missing = batch.ops.findIndex((_, i) => prop(data, `m${i}`) == null);
		return missing === -1 ? { ok: true } : { ok: false, why: `no result for m${missing}` };
	}

	/** Whether `updateProjectV2ItemFieldValue` takes multi-select values on the live schema. */
	async multiSelect(): Promise<boolean> {
		const data = await this.query(MULTI_SELECT_QUERY, {}, "introspecting ProjectV2FieldValue");
		const fields = prop(prop(data, "__type"), "inputFields");
		return Array.isArray(fields) && fields.some((f) => prop(f, "name") === "multiSelectOptionIds");
	}

	/** Every item, archived included, with every field value (paginated), and every field with its options (D6). */
	async snapshot(): Promise<BoardSnapshot> {
		const vars = { owner: BOARD_OWNER, number: this.cfg.projectNumber };
		const where = `${BOARD_OWNER}'s project ${this.cfg.projectNumber}`;
		let projectId = "";
		const project = (data: unknown): unknown => {
			const p = prop(prop(data, "user"), "projectV2");
			const id = prop(p, "id");
			if (typeof id !== "string") throw new Error(`${where} was not found`);
			if (projectId !== "" && projectId !== id) throw new Error(`${where} changed id while reading`);
			projectId = id;
			return p;
		};
		const fields = await allPages("fields", async (cursor) => asPage(prop(project(await this.query(FIELDS_QUERY, { ...vars, cursor }, `reading ${where}'s fields`)), "fields"), "fields"));
		const nodes = await allPages("items", async (cursor) => asPage(prop(project(await this.query(ITEMS_QUERY, { ...vars, cursor }, `reading ${where}'s items`)), "items"), "items"));
		const items: BoardItem[] = [];
		for (const node of nodes) {
			const id = prop(node, "id");
			if (typeof id !== "string") throw new Error(`${where}: an item without an id`);
			const first = asPage(prop(node, "fieldValues"), `${id} field values`);
			let values = first.nodes;
			if (first.pageInfo.hasNextPage) {
				let cursor = first.pageInfo.endCursor;
				values = [...first.nodes];
				for (;;) {
					const page = asPage(prop(prop(await this.query(FIELD_VALUES_QUERY, { id, cursor }, `reading ${id}'s field values`), "node"), "fieldValues"), `${id} field values`);
					values.push(...page.nodes);
					if (!page.pageInfo.hasNextPage) break;
					if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error(`${id} field values: pagination stalled`);
					cursor = page.pageInfo.endCursor;
				}
			}
			for (const value of values) {
				const type = prop(value, "__typename");
				if (typeof type !== "string" || !Object.hasOwn(NESTED, type)) continue;
				const { key, nodes: selection } = NESTED[type as keyof typeof NESTED];
				const connection = prop(value, key);
				if (connection === null) continue;
				const initial = asPage(connection, `${id} ${key}`);
				let firstPage = true;
				const complete = await allPages(`${id} ${key}`, async (nestedCursor) => {
					if (firstPage) {
						firstPage = false;
						return initial;
					}
					// These value types are not Nodes. Locate by field ID, not fieldValueByName (names need not be unique).
					const query = `query($id: ID!, $cursor: String, $nestedCursor: String) { node(id: $id) { ... on ProjectV2Item { fieldValues(first: 100, after: $cursor) { ${PAGE} nodes { __typename ... on ${type} { ${FIELD_REF} ${key}(first: 25, after: $nestedCursor) { ${PAGE} nodes { ${selection} } } } } } } } }`;
					const candidates = await allPages(`${id} nested field values`, async (cursor) => asPage(prop(prop(await this.query(query, { id, cursor, nestedCursor }, `reading ${id} ${key}`), "node"), "fieldValues"), "nested field values"));
					const found = candidates.find((v) => prop(v, "__typename") === type && prop(prop(v, "field"), "id") === prop(prop(value, "field"), "id"));
					if (!found) throw new Error(`${id} ${key}: field disappeared while paginating`);
					return asPage(prop(found, key), `${id} ${key}`);
				});
				Reflect.set(value as object, key, { nodes: complete });
			}
			items.push(boardItem(node, id, values));
		}
		return { projectId, fields: fields.map(boardField), items };
	}
}

function boardField(raw: unknown): BoardField {
	const id = prop(raw, "id");
	const name = prop(raw, "name");
	const dataType = prop(raw, "dataType");
	if (typeof id !== "string" || typeof name !== "string" || typeof dataType !== "string") throw new Error(`a board field without id, name or dataType: ${JSON.stringify(raw)}`);
	return raw as BoardField;
}

function boardItem(node: unknown, id: string, values: unknown[]): BoardItem {
	const content = prop(node, "content");
	const contentId = prop(content, "id");
	const repo = prop(prop(content, "repository"), "nameWithOwner");
	const number = prop(content, "number");
	const title = prop(content, "title");
	const fieldValues = values.map((v): BoardValue => {
		const f = prop(v, "field");
		if (typeof prop(v, "__typename") !== "string" || typeof prop(f, "id") !== "string") throw new Error(`${id}: a field value without its type or field: ${JSON.stringify(v)}`);
		const issue = prop(v, "issueFieldValue");
		if (issue && typeof issue === "object") {
			const type = prop(issue, "__typename");
			let normalized: IssueFieldValue;
			switch (type) {
				case "IssueFieldTextValue":
				case "IssueFieldDateValue": {
					const value = prop(issue, type === "IssueFieldTextValue" ? "textValue" : "dateValue");
					if (typeof value !== "string") throw new Error(`${id}: incomplete ${type}`);
					normalized = { __typename: type, value };
					break;
				}
				case "IssueFieldNumberValue": {
					const value = prop(issue, "numberValue");
					if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${id}: incomplete ${type}`);
					normalized = { __typename: type, value };
					break;
				}
				case "IssueFieldSingleSelectValue": {
					const value = prop(issue, "singleSelectValue");
					const optionId = prop(issue, "optionId");
					if (typeof value !== "string" || !(optionId === null || typeof optionId === "string")) throw new Error(`${id}: incomplete ${type}`);
					normalized = { __typename: type, value, optionId };
					break;
				}
				case "IssueFieldMultiSelectValue": {
					const value = prop(issue, "multiSelectValue");
					if (!(value === null || typeof value === "string")) throw new Error(`${id}: incomplete ${type}`);
					normalized = { __typename: type, value };
					break;
				}
				default:
					throw new Error(`${id}: unknown issue field value ${String(type)}`);
			}
			return { ...v as BoardValue, issueFieldValue: normalized };
		}
		return v as BoardValue;
	});
	return {
		id,
		type: String(prop(node, "type")),
		contentId: typeof contentId === "string" ? contentId : null,
		repo: typeof repo === "string" ? repo : null,
		number: typeof number === "number" ? number : null,
		...(typeof title === "string" ? { title } : {}),
		isArchived: prop(node, "isArchived") === true,
		createdAt: String(prop(node, "createdAt")),
		fieldValues,
	};
}

interface WriteStats {
	done: number;
	planned: number | null;
}

/**
 * Apply `plan`'s ops until a fresh snapshot leaves nothing to do, and return that snapshot (the readback). Batches of
 * at most 10 aliased mutations, `pauseMs` apart. An ambiguous outcome is never replayed: wait (5, 10, 20 s), re-read the
 * board, recompute the plan, continue. The third ambiguous outcome in a row ends the attempt unless the board read after
 * its wait has nothing left to do; a failed re-read counts as one.
 */
async function converge(board: Board, start: BoardSnapshot, plan: (s: BoardSnapshot) => BoardOp[], stats: WriteStats, cfg: Config): Promise<BoardSnapshot> {
	let snap = start;
	let strikes = 0;
	for (let round = 0; ; round++) {
		const ops = plan(snap);
		stats.planned ??= ops.length;
		if (ops.length === 0) return snap;
		if (round >= MAX_ROUNDS) throw new Error(`the board still needs ${ops.length} writes after ${MAX_ROUNDS} rounds`);
		let why: string | null = null;
		for (const batch of mutationBatches(snap.projectId, ops)) {
			const r = await board.mutate(batch);
			if (!r.ok) {
				why = r.why;
				break;
			}
			stats.done += batch.ops.length;
			strikes = 0;
		}
		if (why === null) {
			snap = await board.snapshot();
			continue;
		}
		for (;;) {
			strikes++;
			const wait = cfg.backoffMs[strikes - 1]!;
			log(`ambiguous outcome ${strikes} of ${MAX_AMBIGUOUS} (${why}); re-reading the board in ${wait} ms`);
			await sleep(wait);
			try {
				snap = await board.snapshot();
				break;
			} catch (e) {
				why = message(e);
				if (strikes >= MAX_AMBIGUOUS) throw new Error(`${MAX_AMBIGUOUS} ambiguous outcomes in a row; last: ${why}`);
			}
		}
		if (strikes >= MAX_AMBIGUOUS && plan(snap).length > 0) throw new Error(`${MAX_AMBIGUOUS} ambiguous outcomes in a row; last: ${why}`);
	}
}

// ---- Jev (D4) -----------------------------------------------------------------------------------------------------

interface OpenJudge {
	judge: JudgmentJudge;
	close(): void;
}

/** OMP's standalone judge from the omp on PATH (as chaos-stub does), or the test hook's module. */
async function openJudge(cfg: Config): Promise<OpenJudge> {
	// Both modules are runtime-selected, so neither can be a static import: the hook's path comes from the env, and the
	// omp on PATH decides which install's judge client runs (no hard-coded home path, so Linux works the same).
	if (cfg.judgeModule) {
		const mod: { openJudge(): Promise<OpenJudge> } = await import(resolve(cfg.judgeModule));
		return mod.openJudge();
	}
	const standalone: { openStandaloneJudge(cwd: string, purpose: string): Promise<OpenJudge> } = await import(
		join(ompPackagesRoot(), "pi-coding-agent", "src", "judgment", "standalone.ts")
	);
	return standalone.openStandaloneJudge(REPO_ROOT, "backlog-rank");
}

interface Judged {
	item: BacklogItem;
	candidates: string[];
	answers: CacheEntry["answers"];
}

/**
 * Every item's answers: from cache.jsonl when a whole Jev answer is stored under its key, else asked (at most 4 at a
 * time), each answer appended to the cache (and to the run's jev.jsonl) as it arrives. A failed, malformed or non-Jev
 * answer fails the attempt, naming the item, after the asks in flight settle.
 */
async function judgeAll(cfg: Config, goals: string[], items: BacklogItem[], jevLog: string | null): Promise<{ judged: Judged[]; newCalls: number; cost: number }> {
	const cachePath = statePaths(cfg.stateDir).cache;
	const { entries } = parseCache(existsSync(cachePath) ? readFileSync(cachePath, "utf8") : "");
	const judged = new Map<string, Judged>();
	const asks: { item: BacklogItem; candidates: string[]; key: string }[] = [];
	for (const item of items) {
		const candidates = dateCandidates(item.text, item.filed);
		const key = cacheKey(item, goals);
		const hit = entries.get(key);
		const checked = hit && isJevJudge(hit.judge) ? checkAnswers(backlogQuestions(goals, item.filed, candidates), candidates, hit.answers) : null;
		if (checked?.ok) judged.set(item.id, { item, candidates, answers: checked.answers });
		else asks.push({ item, candidates, key });
	}
	let newCalls = 0;
	let cost = 0;
	if (asks.length > 0) {
		const open = await openJudge(cfg);
		let next = 0;
		let failure: Error | null = null;
		const worker = async (): Promise<void> => {
			while (failure === null && next < asks.length) {
				const a = asks[next++]!;
				const questions = backlogQuestions(goals, a.item.filed, a.candidates);
				const r = await askJudgment(open.judge, judgeState(goals, a.item, a.candidates), questions, { timeoutMs: JUDGE_TIMEOUT_MS });
				if (r.cost !== null) cost += r.cost;
				if (!r.ok) {
					failure ??= new Error(`Jev on ${a.item.id}: ${r.reason}`);
					continue;
				}
				newCalls++;
				const judge = `${r.provider}/${r.model}`;
				if (!isJevJudge(judge)) {
					failure ??= new Error(`Jev on ${a.item.id}: answered by ${judge}, not typesafe/jev-*`);
					continue;
				}
				const checked = checkAnswers(questions, a.candidates, r.answers);
				if (!checked.ok) {
					failure ??= new Error(`Jev on ${a.item.id}: ${checked.reason}`);
					continue;
				}
				const entry: CacheEntry = { key: a.key, id: a.item.id, answers: checked.answers, judge, tokens: r.tokens ?? null, cost: r.cost, at: new Date().toISOString() };
				appendFileSync(cachePath, cacheLine(entry));
				if (jevLog) appendFileSync(jevLog, `${JSON.stringify({ id: a.item.id, judge, tokens: entry.tokens, cost: entry.cost, at: entry.at })}\n`);
				judged.set(a.item.id, { item: a.item, candidates: a.candidates, answers: checked.answers });
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, asks.length) }, worker));
		} finally {
			open.close();
		}
		if (failure) throw failure;
	}
	return { judged: items.map((it) => judged.get(it.id)!), newCalls, cost };
}

// ---- the ledger ----------------------------------------------------------------------------------------------------

/** Lane state per item from the ledger, read-only, with plumb-rank/rank-issues.ts's queries; no ledger file is all `none`. */
function laneStatesFromLedger(path: string, items: BacklogItem[], now: number): Map<string, LaneState> {
	if (!existsSync(path)) return itemLaneStates(items, [], [], now);
	const db = new Database(path, { readonly: true });
	try {
		db.exec("BEGIN");
		const workloads = (db.query(`SELECT w.id,w.brief,w.status,w.created_at,
			(SELECT max(p.at) FROM provenance p WHERE p.workload_id=w.id AND p.tbl='workloads' AND p.action='update' AND p.detail LIKE 'lease%') lease_at,
			(SELECT json_object('state',m.state,'body',m.body) FROM messages m WHERE m.workload_id=w.id AND m.sender LIKE 'lane-%' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) message
			FROM workload_status w`).all() as (Omit<LaneWorkload, "message"> & { message: string | null })[]).map((w): LaneWorkload => ({ ...w, message: w.message ? JSON.parse(w.message) : null }));
		const instructions = db.query("SELECT workload_id,body FROM instructions").all() as LaneInstruction[];
		db.exec("COMMIT");
		return itemLaneStates(items, workloads, instructions, now);
	} finally {
		db.close();
	}
}

// ---- ranking (D3) -------------------------------------------------------------------------------------------------

interface Ranking {
	items: BacklogItem[];
	counts: Record<BacklogRepo, number>;
	order: string[];
	ranked: Map<string, Ranked>;
	pins: { placed: PlacedPin[]; skipped: SkippedPin[] };
	lanes: Map<string, LaneState>;
	newCalls: number;
	cost: number;
}

/** Fetch both backlogs, check the pins (before any Jev call), judge, score at `day`, place the pins, read lane states. */
async function rank(cfg: Config, goals: string[], day: string, jevLog: string | null): Promise<Ranking> {
	const { items, counts } = await fetchItems();
	const pinsPath = statePaths(cfg.stateDir).pins;
	let rawPins: unknown;
	if (existsSync(pinsPath)) {
		try {
			rawPins = JSON.parse(readFileSync(pinsPath, "utf8"));
		} catch (e) {
			throw new Error(`pins.json is not JSON: ${message(e)}`);
		}
	}
	const openIds = items.map((it) => it.id);
	let pins = checkPins(rawPins, openIds);
	if (!pins.ok) throw new Error(`pins refused: ${pins.reason}`);
	if (pins.skipped.length > 0) {
		pins = checkPins(rawPins, openIds, await closedPins(pins.skipped));
		if (!pins.ok) throw new Error(`pins refused: ${pins.reason}`);
	}
	const { judged, newCalls, cost } = await judgeAll(cfg, goals, items, jevLog);
	const ranked = jevRank(judged.map((j) => {
		const u = itemUrgency(j.answers, j.item.filed, j.candidates, day);
		return { id: j.item.id, createdAt: j.item.createdAt, answers: j.answers, urgency: u.urgency, urgencyDetail: u.detail };
	}), goals.length);
	const order = applyPins(ranked.map((r) => r.id), pins.placed);
	const lanes = laneStatesFromLedger(cfg.ledgerDb, items, cfg.now().getTime());
	return { items, counts, order, ranked: new Map(ranked.map((r) => [r.id, r])), pins: { placed: pins.placed, skipped: pins.skipped }, lanes, newCalls, cost };
}

/** order.json: what the run writes, and what its comment reads. */
interface OrderFile {
	runId: string;
	rankedAt: string;
	counts: Record<BacklogRepo, number>;
	pins: { placed: PlacedPin[]; skipped: SkippedPin[] };
	order: { id: string; rank: number; score: number; title: string; laneState: LaneState; reasons: string[]; flags: string[] }[];
}

function orderFile(runId: string, stamp: string, r: Ranking): OrderFile {
	const titles = new Map(r.items.map((it) => [it.id, it.title]));
	return {
		runId,
		rankedAt: stamp,
		counts: r.counts,
		pins: r.pins,
		order: r.order.map((id, i) => {
			const s = r.ranked.get(id)!;
			return { id, rank: i + 1, score: s.score, title: titles.get(id) ?? "", laneState: r.lanes.get(id) ?? "none", reasons: s.reasons, flags: s.flags };
		}),
	};
}

function desiredFrom(r: Ranking, stamp: string): DesiredItem[] {
	return desiredItems(r.order, r.items, new Map([...r.ranked].map(([id, s]) => [id, s.raw])), stamp, r.lanes);
}

function runPlan(desired: DesiredItem[]): (s: BoardSnapshot) => BoardOp[] {
	return (s) => {
		const d = boardDiff(s, desired);
		if (!d.ok) throw new Error(`board refused: ${d.reason}`);
		return [...d.diff.deletes, ...d.diff.adds, ...d.diff.updates];
	};
}

// ---- a run (D5, D5a) ----------------------------------------------------------------------------------------------

interface AttemptLine {
	attempt: number;
	startedAt: string;
	endedAt: string;
	phase: string;
	writesDone: number;
	writesPlanned: number | null;
	error: string | null;
}

/** One attempt of a pending run: rank, write order.json, then the board until its readback matches. */
async function attempt(cfg: Config, goals: string[], start: LastRun): Promise<{ run: LastRun; error: string | null }> {
	const rp = runPaths(cfg.stateDir, start.runId);
	mkdirSync(rp.root, { recursive: true });
	const startedAt = new Date().toISOString();
	const stats: WriteStats = { done: 0, planned: null };
	let run = start;
	let error: string | null = null;
	try {
		const ranking = await rank(cfg, goals, run.day, rp.jev);
		const stamp = existsSync(rp.order) ? (JSON.parse(readFileSync(rp.order, "utf8")) as OrderFile).rankedAt : rankedAt(cfg.now());
		writeAtomic(rp.order, `${JSON.stringify(orderFile(run.runId, stamp, ranking), null, 1)}\n`);
		if (run.phase === "ranking") run = saveRun(cfg.stateDir, advance(run, "writing"));
		const board = new Board(await boardToken(), cfg);
		const snap = await board.snapshot();
		const plan = runPlan(desiredFrom(ranking, stamp));
		plan(snap); // a refused board (fields) ends the attempt before the backup and any write
		publishBackup(rp.backup, snap);
		await converge(board, snap, plan, stats, cfg);
		run = saveRun(cfg.stateDir, advance(run, "written"));
		log(`run ${run.runId}: the board matches on readback (${stats.done} writes)`);
	} catch (e) {
		error = message(e);
	}
	const line: AttemptLine = { attempt: run.attempts, startedAt, endedAt: new Date().toISOString(), phase: run.phase, writesDone: stats.done, writesPlanned: stats.planned, error };
	appendFileSync(rp.attempts, `${JSON.stringify(line)}\n`);
	return { run, error };
}

function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
		try {
			return [JSON.parse(l) as T];
		} catch {
			return [];
		}
	});
}

/** The #153 comment for the run's stored outcome, from its files only (D7). */
function runComment(cfg: Config, run: LastRun): string {
	if (run.outcome === "pending") throw new Error(`run ${run.runId} has no outcome yet`);
	const rp = runPaths(cfg.stateDir, run.runId);
	const order = existsSync(rp.order) ? (JSON.parse(readFileSync(rp.order, "utf8")) as OrderFile) : null;
	const backup = existsSync(rp.backup) ? (JSON.parse(readFileSync(rp.backup, "utf8")) as BoardSnapshot) : null;
	const jev = readJsonl<{ cost: number | null }>(rp.jev);
	const c: RunComment = {
		runId: run.runId,
		outcome: run.outcome,
		jev: { newCalls: jev.length, cost: jev.reduce((s, j) => s + (j.cost ?? 0), 0) },
		backupPath: backup ? rp.backup : null,
	};
	if (order) {
		c.counts = order.counts;
		c.pins = order.pins;
		c.orderPath = rp.order;
		c.titles = new Map(order.order.map((o) => [o.id, o.title]));
	}
	if (run.outcome === "succeeded" && order && backup) c.moves = rankMoves(order.order.map((o) => o.id), previousRanks(backup));
	if (run.outcome === "abandoned") {
		const attempts = readJsonl<AttemptLine>(rp.attempts);
		const last = attempts.at(-1);
		const earlier = attempts.slice(0, -1).reduce((s, a) => s + a.writesDone, 0);
		c.failure = {
			phase: run.phase,
			attempts: run.attempts,
			writesDone: earlier + (last?.writesDone ?? 0),
			writesTotal: earlier + (last?.writesPlanned ?? last?.writesDone ?? 0),
			error: last?.error ?? "unknown",
		};
	}
	return commentBody(c);
}

/** Post the run's one comment unless its marker is already on the comment issue, then record it (D7). */
async function postComment(cfg: Config, start: LastRun): Promise<LastRun> {
	const { repo, number } = cfg.comment;
	const where = `${repo}#${number}`;
	const list = await gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/comments?per_page=100`]);
	if (list.code !== 0) throw ghFailure(`reading ${where}'s comments`, list);
	const pages: unknown = JSON.parse(list.stdout);
	if (!Array.isArray(pages)) throw new Error(`${where}'s comments are not a list`);
	const comments = pages.flat() as { body?: string | null }[];
	if (hasRunComment(comments, start.runId)) log(`run ${start.runId}: its comment is already on ${where}`);
	else {
		const post = await gh(["issue", "comment", String(number), "--repo", repo, "--body-file", "-"], { input: runComment(cfg, start) });
		if (post.code !== 0) throw ghFailure(`posting run ${start.runId}'s comment on ${where} (the next fire looks for it before posting again)`, post);
		log(`run ${start.runId}: commented on ${where}`);
	}
	return saveRun(cfg.stateDir, markCommented(start));
}

/** Drive one run until it is commented, or an attempt or the comment fails (exit 1). */
async function drive(cfg: Config, start: LastRun): Promise<number> {
	let run = start;
	for (;;) {
		const step = nextStep(run);
		if (step === "done") return 0;
		if (step === "comment") {
			try {
				run = await postComment(cfg, run);
			} catch (e) {
				console.error(`backlog-rank: run ${run.runId}: ${oneLine(message(e))}`);
				return 1;
			}
			continue;
		}
		const goals = readGoals(cfg.stateDir);
		run = saveRun(cfg.stateDir, beginAttempt(run));
		const r = await attempt(cfg, goals, run);
		run = r.run;
		if (r.error === null) continue;
		run = saveRun(cfg.stateDir, failAttempt(run));
		const fate = run.outcome === "abandoned" ? "abandoned after this failure" : "the next fire resumes it";
		console.error(`backlog-rank: run ${run.runId} attempt ${run.attempts} of ${MAX_ATTEMPTS} failed in ${run.phase}: ${oneLine(r.error)}; ${fate}`);
		if (run.outcome === "abandoned") {
			try {
				await postComment(cfg, run);
			} catch (e) {
				console.error(`backlog-rank: run ${run.runId}: ${oneLine(message(e))}`);
			}
		}
		return 1;
	}
}

/** A fire: the due rule, then the resumed or new run; after a resumed run, the rule is asked again (D5). */
async function fire(cfg: Config, now: boolean): Promise<number> {
	const today = calendarDay(cfg.now());
	let last = readLastRun(cfg.stateDir);
	let ran = false;
	for (;;) {
		const due = dueRule(last, today, now);
		if (due.action === "skip") {
			if (!ran) log(`not due: ${due.reason}`);
			return 0;
		}
		let run: LastRun;
		if (due.action === "resume") {
			run = due.run;
			log(`resuming run ${run.runId} (${run.phase}, ${run.outcome}, attempt ${run.attempts} done)`);
		} else {
			readGoals(cfg.stateDir); // no goals refuses before a run is recorded
			run = startRun(newRunId(cfg.now(), randomBytes(2).toString("hex")), today);
			mkdirSync(runPaths(cfg.stateDir, run.runId).root, { recursive: true });
			saveRun(cfg.stateDir, run);
			log(`run ${run.runId} started`);
		}
		const code = await drive(cfg, run);
		if (code !== 0 || due.action === "start") return code;
		ran = true;
		last = readLastRun(cfg.stateDir);
	}
}

// ---- --dry-run and --undo ----------------------------------------------------------------------------------------

function describeOp(op: BoardOp): string {
	switch (op.kind) {
		case "add":
			return `add ${op.key}`;
		case "delete":
			return `delete ${op.key} (${op.reason})`;
		case "set":
			return `set ${op.key} ${op.field} = ${JSON.stringify(Object.values(op.value)[0])}`;
		case "clear":
			return `clear ${op.key} ${op.field}`;
		default:
			return `${op.kind} ${op.key}`;
	}
}

/** Rank and show the order and the board diff; no GitHub write, no comment, no state but the cache. */
async function dryRun(cfg: Config): Promise<number> {
	const goals = readGoals(cfg.stateDir);
	const today = calendarDay(cfg.now());
	const r = await rank(cfg, goals, today, null);
	const stamp = rankedAt(cfg.now());
	const counts = BACKLOG_REPOS.map((x) => `${r.counts[x.repo]} ${x.repo}`).join(", ");
	log(`--dry-run: ${r.order.length} open issues (${counts}); Jev ${r.newCalls} new calls, $${r.cost.toFixed(4)}`);
	const titles = new Map(r.items.map((it) => [it.id, it.title]));
	const pinned = new Map(r.pins.placed.map((p) => [p.id, p.position]));
	r.order.forEach((id, i) => console.log(`${String(i + 1).padStart(4)}. ${titles.get(id)} (${id})  score ${r.ranked.get(id)!.score.toFixed(4)}${pinned.has(id) ? "  [pinned]" : ""}`));
	for (const p of r.pins.skipped) console.log(`pin skipped: ${p.id} (${p.reason}, was for ${p.position})`);
	const board = new Board(await boardToken(), cfg);
	const snap = await board.snapshot();
	const ops = runPlan(desiredFrom(r, stamp))(snap);
	const n = (k: BoardOp["kind"]) => ops.filter((o) => o.kind === k).length;
	log(`board diff: ${n("add")} adds, ${n("delete")} deletes, ${n("set")} updates, in ${mutationBatches(snap.projectId, ops).length} requests (not written)`);
	for (const op of ops) console.log(`  ${describeOp(op)}`);
	return 0;
}

/** Publish only a completed, flushed snapshot, with the channel protocol's no-replace hard link. */
export function publishBackup(path: string, snapshot: BoardSnapshot, beforePublish?: (temporary: string) => void): void {
	if (!existsSync(path)) {
		const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		const fd = openSync(tmp, "wx", 0o600);
		try {
			const checksum = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
			writeFileSync(fd, `${JSON.stringify({ ...snapshot, checksum }, null, 1)}\n`);
			fsyncSync(fd);
			beforePublish?.(tmp);
			try {
				linkSync(tmp, path);
			} catch (e) {
				if (prop(e, "code") !== "EEXIST") throw e;
			}
		} finally {
			closeSync(fd);
			unlinkSync(tmp);
		}
	}
	const original = readBackup(path);
	if (original.projectId !== snapshot.projectId) throw new Error(`${path}: backup project does not match ${snapshot.projectId}`);
}

function readBackup(path: string): BoardSnapshot {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		const fields = prop(raw, "fields");
		const items = prop(raw, "items");
		if (typeof prop(raw, "projectId") !== "string" || !Array.isArray(fields) || !Array.isArray(items)) throw new Error("missing project, fields or items");
		const payload = { projectId: prop(raw, "projectId"), fields, items };
		const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		if (prop(raw, "checksum") !== checksum) throw new Error("missing or mismatched snapshot checksum");
		for (const f of fields) boardField(f);
		for (const item of items) {
			if (typeof prop(item, "id") !== "string" || typeof prop(item, "type") !== "string" || typeof prop(item, "createdAt") !== "string"
				|| typeof prop(item, "isArchived") !== "boolean" || !Array.isArray(prop(item, "fieldValues"))
				|| !(typeof prop(item, "contentId") === "string" || prop(item, "contentId") === null)) throw new Error("incomplete item");
			for (const value of prop(item, "fieldValues") as unknown[]) {
				boardField(prop(value, "field"));
				if (typeof prop(value, "__typename") !== "string") throw new Error("untyped field value");
			}
		}
		return raw as BoardSnapshot;
	} catch (e) {
		throw new Error(`${path}: invalid board backup: ${message(e)}`);
	}
}

/** Make the board's item set, writable values and archive state match a backup; re-runnable after any failure (D6). */
async function undo(cfg: Config, backupArg: string): Promise<number> {
	const path = resolve(backupArg);
	const backup = readBackup(path);
	const board = new Board(await boardToken(), cfg);
	const multiSelect = await board.multiSelect();
	const live = await board.snapshot();
	if (live.projectId !== backup.projectId) throw new Error(`${path} is a backup of project ${backup.projectId}; the board read is ${live.projectId}`);
	const stats: WriteStats = { done: 0, planned: null };
	let final: BoardSnapshot;
	try {
		final = await converge(board, live, (s) => undoPlan(backup, s, { multiSelect }).ops, stats, cfg);
	} catch (e) {
		console.error(`backlog-rank: undo failed after ${stats.done} writes: ${oneLine(message(e))}; run \`${undoCommand(path)}\` again to finish`);
		return 1;
	}
	const rest = undoPlan(backup, final, { multiSelect });
	for (const d of rest.contentDiffs) console.log(`content-derived, not written: ${d}`);
	for (const u of rest.unrestorable) console.log(`not restored: ${u}`);
	if (rest.unrestorable.length > 0) {
		console.error(`backlog-rank: undo wrote ${stats.done} changes; ${rest.unrestorable.length} differences from ${path} remain`);
		return 1;
	}
	log(`undo: the board's items, writable values and archive state match ${path} (${stats.done} writes)`);
	return 0;
}

// ---- main ----------------------------------------------------------------------------------------------------------

function parseArgs(argv: string[]): { dryRun: boolean; now: boolean; undo: string | null } | null {
	const f = { dryRun: false, now: false, undo: null as string | null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") f.dryRun = true;
		else if (a === "--now") f.now = true;
		else if (a === "--undo" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) f.undo = argv[++i]!;
		else return null;
	}
	return Number(f.dryRun) + Number(f.now) + Number(f.undo !== null) > 1 ? null : f;
}

async function main(argv: string[]): Promise<number> {
	const flags = parseArgs(argv);
	if (!flags) {
		console.error(USAGE);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = config(process.env);
	} catch (e) {
		console.error(`backlog-rank: ${message(e)}`);
		return 2;
	}
	mkdirSync(cfg.stateDir, { recursive: true });
	const lock = statePaths(cfg.stateDir).lock;
	const release = takeLock(lock);
	if (!release) {
		const holder = lockHolder(lock);
		log(`already running (pid ${holder?.pid ?? "unpublished"}, since ${holder?.startedAt ?? "?"})`);
		return 0;
	}
	const onSignal = (signal: string, code: number) => process.on(signal, () => {
		release();
		process.exit(code);
	});
	onSignal("SIGINT", 130);
	onSignal("SIGTERM", 143);
	try {
		if (flags.undo !== null) return await undo(cfg, flags.undo);
		if (flags.dryRun) return await dryRun(cfg);
		return await fire(cfg, flags.now);
	} catch (e) {
		console.error(`backlog-rank: ${oneLine(message(e))}`);
		return e instanceof Refusal ? 2 : 1;
	} finally {
		release();
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
