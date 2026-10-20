// The fakes surface/test/backlog-rank-run.test.ts drives surface/scripts/backlog-rank.ts with (PLAN wl-mvh42n85yo0m4g § 3).
//
// Run as `gh` (the test puts a `gh` wrapper that execs `bun <this file>` first on PATH), it is a stateful GitHub: the
// two backlogs' issues, thewolff's project board with its fields and items, the comment issue's comments, and the
// accounts' tokens, all in the JSON file at $FAKE_GH_STATE. Every call appends its argv, the GH_TOKEN and GITHUB_TOKEN
// it saw, and its time to $FAKE_GH_LOG. Per mutation request it can (a) fail before applying anything, (b) apply some
// aliases then answer `errors` with partial `data`, (c) apply all then exit as a 502, (d) apply all and lose the
// response, or hit a secondary rate limit; it can SIGKILL the script at a mutation, at the comment read, or right after
// a comment post. It adds a second card when an issue already on the board is added again, so a blind replay shows up
// as a duplicate.
//
// Imported, it is the fake judge (AGENT_SYSTEM_BACKLOG_RANK_JUDGE): `openJudge()` answers every question from a hash of
// the item text, logs each call to $FAKE_JUDGE_LOG, and reads FAKE_JUDGE_MODE (ok | malformed | wrong-model),
// FAKE_JUDGE_DELAY_MS and FAKE_JUDGE_KILL_AFTER (SIGKILL the process instead of answering once that many calls are
// answered).
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- the state ----------------------------------------------------------------------------------------------------

export interface FakeIssue {
	id: string;
	number: number;
	title: string;
	body: string;
	createdAt: string;
	state: "OPEN" | "CLOSED";
}
export interface FakeField {
	id: string;
	name: string;
	dataType: string;
	options?: { id: string; name: string }[];
	configuration?: { duration: number; startDay: number; iterations: { id: string; title: string; startDate: string; duration: number }[]; completedIterations: [] };
}
export type Node = Record<string, unknown>;
export interface FakeItem {
	id: string;
	/** An issue's node id, a pull request's id, or a draft's id. */
	contentId: string;
	type: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE";
	isArchived: boolean;
	createdAt: string;
	/** Writable values set on the card, as the API returns them (without `field`, which is rendered from the field id). */
	values: Record<string, Node>;
}
export interface FakeState {
	tokens: Record<string, string>;
	/** nameWithOwner → issues (open and closed). */
	repos: Record<string, FakeIssue[]>;
	/** A synthetic open-issue count for a repo's list (R1's 1000). */
	listCount: Record<string, number>;
	prs: Record<string, { repo: string; number: number; title: string }>;
	drafts: Record<string, { title: string }>;
	/** Content-derived value nodes per content id (labels, assignees, milestone, …), keyed by field id. */
	derived: Record<string, Record<string, Node>>;
	project: { owner: string; number: number; id: string; fields: FakeField[]; items: FakeItem[]; nextItem: number };
	pageSize: number;
	valuesPageSize: number;
	fieldsPageSize: number;
	commentsPageSize: number;
	multiSelect: boolean;
	comments: Record<string, { id: number; body: string }[]>;
	/** Consumed one per mutation request: ok | fail-before | partial:<k> | apply-502 | apply-lost | rate-limit. */
	faults: string[];
	/** Consumed one per comment post: ok | lost (stored, then no response) | fail (not stored). */
	commentFaults: string[];
	/** SIGKILL the calling script at the nth call of a kind: mutation (after applying), comments (the comment read), post (after storing). */
	kill: { on: "mutation" | "comments" | "post"; nth: number } | null;
	counters: Record<string, number>;
	/** Minutes past 2026-10-20T00:00Z for the next added card's createdAt. */
	clock: number;
}

export interface CallRecord {
	argv: string[];
	ghToken: string | null;
	githubToken: string | null;
	at: number;
	kind: string;
	aliases?: number;
	fault?: string;
	/** On a mutation: whether a runs/<id>/backup.json already existed in the state dir. */
	backupSeen?: boolean;
}

export const THEWOLFF_TOKEN = "tok-thewolff-board";
export const ACTIVE_TOKEN = "tok-engineer";
export const JI = "thewolff/jo-issues";
export const AS2 = "thewolff/agent-system-2.0";
export const PROJECT_ID = "PVT_fake1";

export function readState(path: string): FakeState {
	return JSON.parse(readFileSync(path, "utf8"));
}
export function writeState(path: string, state: FakeState): void {
	writeFileSync(`${path}.tmp`, JSON.stringify(state));
	renameSync(`${path}.tmp`, path);
}
export function readCalls(path: string): CallRecord[] {
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const LANE_OPTIONS = [{ id: "o_run", name: "running" }, { id: "o_park", name: "parked" }, { id: "o_block", name: "blocked" }, { id: "o_none", name: "none" }];
export const FIELDS: FakeField[] = [
	{ id: "F_title", name: "Title", dataType: "TITLE" },
	{ id: "F_rank", name: "Rank", dataType: "NUMBER" },
	{ id: "F_score", name: "Jev score", dataType: "NUMBER" },
	{ id: "F_at", name: "Ranked at", dataType: "TEXT" },
	{ id: "F_lane", name: "Lane state", dataType: "SINGLE_SELECT", options: LANE_OPTIONS },
	{ id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "s_todo", name: "Todo" }, { id: "s_done", name: "Done" }] },
	{ id: "F_note", name: "Note", dataType: "TEXT" },
	{ id: "F_due", name: "Due", dataType: "DATE" },
	{ id: "F_sprint", name: "Sprint", dataType: "ITERATION", configuration: { duration: 14, startDay: 1, iterations: [{ id: "it1", title: "Sprint 1", startDate: "2026-10-19", duration: 14 }], completedIterations: [] } },
	{ id: "F_tags", name: "Tags", dataType: "MULTI_SELECT", options: [{ id: "t_a", name: "a" }, { id: "t_b", name: "b" }] },
	{ id: "F_labels", name: "Labels", dataType: "LABELS" },
	{ id: "F_assignees", name: "Assignees", dataType: "ASSIGNEES" },
	{ id: "F_milestone", name: "Milestone", dataType: "MILESTONE" },
	{ id: "F_repo", name: "Repository", dataType: "REPOSITORY" },
	{ id: "F_prs", name: "Linked pull requests", dataType: "LINKED_PULL_REQUESTS" },
	{ id: "F_reviewers", name: "Reviewers", dataType: "REVIEWERS" },
	{ id: "F_prio", name: "Priority", dataType: "SINGLE_SELECT" },
];

const issue = (repo: string, number: number, title: string, body = "", state: "OPEN" | "CLOSED" = "OPEN", day = 10): FakeIssue => ({
	id: `I_${repo.split("/")[1]}_${number}`,
	number,
	title,
	body,
	createdAt: `2026-10-${String(day).padStart(2, "0")}T18:00:00Z`,
	state,
});
export const issueId = (repo: string, number: number): string => `I_${repo.split("/")[1]}_${number}`;
const card = (id: string, contentId: string, values: Record<string, Node> = {}, over: Partial<FakeItem> = {}): FakeItem => ({
	id, contentId, type: "ISSUE", isArchived: false, createdAt: "2026-10-15T00:00:00Z", values, ...over,
});

/**
 * The standard world: six open jo-issues (#1–#6) and a closed #7; five open as2 issues (#10–#14); a newdle issue on
 * the board. The board holds every value type on jo-issues#1, an archived jo-issues#2, the closed #7's card,
 * jo-issues#3, as2#10, another repo's card, a pull request and a draft. (No issue has two cards: a project holds one card
 * per issue, so a duplicate here would make the backup's undo unrestorable; undoPlan says so.)
 */
export function seedState(): FakeState {
	const ji = [
		issue(JI, 1, "Make the merge train land green PRs", "Work flows to main without Jo."),
		issue(JI, 2, "Cut lane spend", "Spend less per lane run."),
		issue(JI, 3, "Fix the broken deploy", "Deploy fails since 2026-10-18."),
		issue(JI, 4, "Renew the cert", "Due 2026-10-22."),
		issue(JI, 5, "Write the guide", "Docs for the board."),
		issue(JI, 6, "Tidy the scratch root", "Old files."),
		issue(JI, 7, "Old closed thing", "done", "CLOSED"),
	];
	const as2 = [
		issue(AS2, 10, "Ledger compaction", "Smaller ledger."),
		issue(AS2, 11, "Gate speedups", "Faster gates."),
		issue(AS2, 12, "Lane restart on wake", "Resume lanes."),
		issue(AS2, 13, "Ceiling meter", "Spend meter."),
		issue(AS2, 14, "Orchestrator prompt trim", "Cheaper prompt."),
	];
	const newdle = [issue("thewolff/newdle", 5, "Feed header", "", "OPEN")];
	const one = issueId(JI, 1);
	return {
		tokens: { thewolff: THEWOLFF_TOKEN, "thewolff-engineer": ACTIVE_TOKEN },
		repos: { [JI]: ji, [AS2]: as2, "thewolff/newdle": newdle },
		listCount: {},
		prs: { PR_ji_50: { repo: JI, number: 50, title: "A pull request" } },
		drafts: { DI_1: { title: "A draft" } },
		derived: {
			[one]: {
				F_labels: { __typename: "ProjectV2ItemFieldLabelValue", labels: { nodes: [{ name: "bug" }] } },
				F_assignees: { __typename: "ProjectV2ItemFieldUserValue", users: { nodes: [{ login: "thewolff" }] } },
				F_milestone: { __typename: "ProjectV2ItemFieldMilestoneValue", milestone: { title: "M1", number: 1 } },
				F_repo: { __typename: "ProjectV2ItemFieldRepositoryValue", repository: { nameWithOwner: JI } },
				F_prs: { __typename: "ProjectV2ItemFieldPullRequestValue", pullRequests: { nodes: [{ number: 50, repository: { nameWithOwner: JI } }] } },
				F_reviewers: { __typename: "ProjectV2ItemFieldReviewerValue", reviewers: { nodes: [{ __typename: "User", login: "thewolff" }] } },
				F_prio: { __typename: "ProjectV2ItemIssueFieldValue", issueFieldValue: { __typename: "IssueFieldSingleSelectValue", value: "P1", optionId: "p1" } },
			},
		},
		project: {
			owner: "thewolff",
			number: 1,
			id: PROJECT_ID,
			fields: FIELDS,
			nextItem: 100,
			items: [
				card("PVTI_1", one, {
					F_rank: num(3), F_score: num(0.5), F_at: text("9:00 AM PDT Oct 19"), F_lane: select("o_none", "none"), F_status: select("s_todo", "Todo"),
					F_note: text("keep me"), F_due: { __typename: "ProjectV2ItemFieldDateValue", date: "2026-11-01" },
					F_sprint: { __typename: "ProjectV2ItemFieldIterationValue", iterationId: "it1", title: "Sprint 1", startDate: "2026-10-19", duration: 14 },
					F_tags: { __typename: "ProjectV2ItemFieldMultiSelectValue", options: [{ id: "t_a", name: "a" }] },
				}),
				card("PVTI_2", issueId(JI, 2), { F_rank: num(1), F_status: select("s_done", "Done") }, { isArchived: true }),
				card("PVTI_7", issueId(JI, 7), { F_rank: num(2), F_note: text("closed one") }),
				card("PVTI_3", issueId(JI, 3), { F_rank: num(5) }, { createdAt: "2026-10-14T00:00:00Z" }),
				card("PVTI_10", issueId(AS2, 10), { F_rank: num(4) }),
				card("PVTI_n5", issueId("thewolff/newdle", 5), { F_note: text("other repo") }),
				card("PVTI_pr", "PR_ji_50", { F_status: select("s_todo", "Todo") }, { type: "PULL_REQUEST" }),
				card("PVTI_draft", "DI_1", { F_note: text("draft note") }, { type: "DRAFT_ISSUE" }),
			],
		},
		pageSize: 100,
		valuesPageSize: 100,
		fieldsPageSize: 100,
		commentsPageSize: 100,
		multiSelect: true,
		comments: { "thewolff/jo-issues#153": [{ id: 1, body: "an older comment" }] },
		faults: [],
		commentFaults: [],
		kill: null,
		counters: {},
		clock: 0,
	};
}
function num(n: number): Node {
	return { __typename: "ProjectV2ItemFieldNumberValue", number: n };
}
function text(t: string): Node {
	return { __typename: "ProjectV2ItemFieldTextValue", text: t };
}
function select(optionId: string, name: string): Node {
	return { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId, name };
}

// ---- rendering, as the API answers --------------------------------------------------------------------------------

function fieldRef(state: FakeState, id: string): Node {
	const f = state.project.fields.find((x) => x.id === id)!;
	return { id: f.id, name: f.name, dataType: f.dataType };
}

/** An item's content: issue, pull request or draft. */
export function contentOf(state: FakeState, contentId: string): { __typename: string; id: string; number?: number; title: string; repo?: string } | null {
	for (const [repo, list] of Object.entries(state.repos)) {
		const i = list.find((x) => x.id === contentId);
		if (i) return { __typename: "Issue", id: i.id, number: i.number, title: i.title, repo };
	}
	const pr = state.prs[contentId];
	if (pr) return { __typename: "PullRequest", id: contentId, number: pr.number, title: pr.title, repo: pr.repo };
	const d = state.drafts[contentId];
	return d ? { __typename: "DraftIssue", id: contentId, title: d.title } : null;
}

/** Every field value of an item, as fieldValues nodes: the title, the content-derived values, then the card's own. */
export function renderValues(state: FakeState, item: FakeItem): Node[] {
	const c = contentOf(state, item.contentId);
	const out: Node[] = [];
	if (c) out.push({ __typename: "ProjectV2ItemFieldTextValue", text: c.title, field: fieldRef(state, "F_title") });
	for (const [fieldId, node] of Object.entries(state.derived[item.contentId] ?? {})) out.push({ ...node, field: fieldRef(state, fieldId) });
	for (const [fieldId, node] of Object.entries(item.values)) out.push({ ...node, field: fieldRef(state, fieldId) });
	return out;
}

function renderContent(state: FakeState, contentId: string): Node | null {
	const c = contentOf(state, contentId);
	if (!c) return null;
	if (c.__typename === "DraftIssue") return { __typename: c.__typename, id: c.id, title: c.title };
	return { __typename: c.__typename, id: c.id, number: c.number, title: c.title, repository: { nameWithOwner: c.repo } };
}

function page<T>(all: T[], cursor: unknown, size: number): { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] } {
	const from = typeof cursor === "string" ? Number(cursor) : 0;
	const nodes = all.slice(from, from + size);
	const end = from + nodes.length;
	return { pageInfo: { hasNextPage: end < all.length, endCursor: nodes.length > 0 ? String(end) : null }, nodes };
}

/**
 * A deliberately bounded GraphQL selection interpreter for the value subgraph exercised by this transport.
 * Unlike substring routing alone, it projects actual aliases/fragments, honors connection arguments, and checks
 * scalar response-name merging against GitHub's IssueFieldValue schema (reference/issues, value object headings).
 * No GraphQL runtime dependency is needed to model this subgraph.
 */
interface Selection {
	name: string;
	response: string;
	type?: string;
	args: Record<string, unknown>;
	children: Selection[];
}
function selections(query: string, variables: Record<string, unknown>): Selection[] {
	const tokens = query.match(/\.\.\.|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[!$():{},\[\]]/g) ?? [];
	let at = tokens.indexOf("{");
	function set(): Selection[] {
		if (tokens[at++] !== "{") throw new Error("expected selection set");
		const result: Selection[] = [];
		while (tokens[at] !== "}") {
			const name = tokens[at++];
			if (!name) throw new Error("unterminated selection");
			if (name === "...") {
				if (tokens[at++] !== "on") throw new Error("only inline fragments are supported");
				const type = tokens[at++];
				result.push({ name, response: name, type, args: {}, children: set() });
				continue;
			}
			let field = name;
			if (tokens[at] === ":") { at++; field = tokens[at++]!; }
			const args: Record<string, unknown> = {};
			if (tokens[at] === "(") {
				at++;
				while (tokens[at] !== ")") {
					if (tokens[at] === ",") { at++; continue; }
					const key = tokens[at++]!;
					if (tokens[at++] !== ":") throw new Error("expected argument");
					const value = tokens[at++];
					if (value === "$") args[key] = variables[tokens[at++]!];
					else if (value === "[") {
						while (tokens[at] !== "]") {
							if (!tokens[at++]) throw new Error("unterminated argument");
						}
						at++;
					} else args[key] = value?.startsWith('"') ? JSON.parse(value) : Number(value);
				}
				at++;
			}
			result.push({ name: field, response: name, args, children: tokens[at] === "{" ? set() : [] });
		}
		at++;
		return result;
	}
	return set();
}
function findSelection(set: Selection[], name: string): Selection | undefined {
	for (const s of set) {
		if (s.name === name) return s;
		const found = findSelection(s.children, name);
		if (found) return found;
	}
}
// Verified from https://docs.github.com/en/graphql/reference/issues, fetched 2026-10-20.
const ISSUE_VALUE_SCHEMA: Record<string, Record<string, string>> = {
	IssueFieldTextValue: { value: "String!" },
	IssueFieldNumberValue: { value: "Float!" },
	IssueFieldDateValue: { value: "String!" },
	IssueFieldSingleSelectValue: { value: "String!", optionId: "String" },
	IssueFieldMultiSelectValue: { value: "String" },
};
function validateIssueValues(set: Selection[]): void {
	for (const selection of set) {
		if (selection.name === "issueFieldValue") {
			const shapes = new Map<string, string>();
			for (const fragment of selection.children) {
				if (fragment.name === "__typename") continue;
				const schema = ISSUE_VALUE_SCHEMA[fragment.type ?? ""];
				if (!schema) throw new Error(`unknown IssueFieldValue type ${fragment.type}`);
				for (const field of fragment.children) {
					const shape = field.name === "__typename" ? "String!" : schema[field.name];
					if (!shape) throw new Error(`unknown ${fragment.type}.${field.name}`);
					const previous = shapes.get(field.response);
					if (previous && previous !== shape) throw new Error(`Fields '${field.response}' conflict: ${previous} and ${shape}`);
					shapes.set(field.response, shape);
				}
			}
		}
		validateIssueValues(selection.children);
	}
}
function projectValue(raw: unknown, set: Selection[]): unknown {
	if (raw === null || raw === undefined) return null;
	if (Array.isArray(raw)) return raw.map((node) => projectValue(node, set));
	if (typeof raw !== "object") return raw;
	const result: Node = {};
	for (const s of set) {
		if (s.name === "...") {
			if (s.type === Reflect.get(raw, "__typename") || s.type === "ProjectV2FieldCommon") Object.assign(result, projectValue(raw, s.children));
			continue;
		}
		let value = Reflect.get(raw, s.name);
		if (value && typeof value === "object" && "nodes" in value && Array.isArray(value.nodes) && typeof s.args.first === "number") {
			value = page(value.nodes, s.args.after, s.args.first);
		}
		result[s.response] = s.children.length ? projectValue(value, s.children) : value;
	}
	return result;
}

// ---- mutations ----------------------------------------------------------------------------------------------------

/** One aliased mutation of mutationBatches' shape, applied to the state: its result, or an error message. */
function applyOne(state: FakeState, name: string, args: Record<string, unknown>): { result: Node } | { error: string } {
	const p = state.project;
	if (args.projectId !== p.id) return { error: `Could not resolve to a ProjectV2 with the global id of '${String(args.projectId)}'` };
	const item = typeof args.itemId === "string" ? p.items.find((i) => i.id === args.itemId) : undefined;
	if (name !== "addProjectV2ItemById" && !item) return { error: `Could not resolve to a node with the global id of '${String(args.itemId)}'` };
	switch (name) {
		case "addProjectV2ItemById": {
			const c = contentOf(state, String(args.contentId));
			if (!c || c.__typename === "DraftIssue") return { error: `Could not resolve to a node with the global id of '${String(args.contentId)}'` };
			const id = `PVTI_${p.nextItem++}`;
			const createdAt = new Date(Date.parse("2026-10-20T00:00:00Z") + state.clock++ * 60_000).toISOString();
			p.items.push({ id, contentId: c.id, type: c.__typename === "Issue" ? "ISSUE" : "PULL_REQUEST", isArchived: false, createdAt, values: {} });
			return { result: { item: { id } } };
		}
		case "deleteProjectV2Item":
			p.items = p.items.filter((i) => i !== item);
			return { result: { deletedItemId: item!.id } };
		case "archiveProjectV2Item":
		case "unarchiveProjectV2Item":
			item!.isArchived = name === "archiveProjectV2Item";
			return { result: { item: { id: item!.id } } };
		case "clearProjectV2ItemFieldValue":
			delete item!.values[String(args.fieldId)];
			return { result: { projectV2Item: { id: item!.id } } };
		case "updateProjectV2ItemFieldValue": {
			const field = p.fields.find((f) => f.id === args.fieldId);
			const v = (args.value ?? {}) as Record<string, unknown>;
			if (!field) return { error: `Could not resolve to a field with the global id of '${String(args.fieldId)}'` };
			const keys = Object.keys(v);
			if (keys.length !== 1) return { error: "value must have exactly one key" };
			let node: Node | null = null;
			if (field.dataType === "TEXT" && typeof v.text === "string") node = text(v.text);
			if (field.dataType === "NUMBER" && typeof v.number === "number") node = num(v.number);
			if (field.dataType === "DATE" && typeof v.date === "string") node = { __typename: "ProjectV2ItemFieldDateValue", date: v.date };
			if (field.dataType === "SINGLE_SELECT" && field.options && typeof v.singleSelectOptionId === "string") {
				const o = field.options.find((x) => x.id === v.singleSelectOptionId);
				if (o) node = select(o.id, o.name);
			}
			if (field.dataType === "ITERATION" && typeof v.iterationId === "string") {
				const it = field.configuration?.iterations.find((x) => x.id === v.iterationId);
				if (it) node = { __typename: "ProjectV2ItemFieldIterationValue", iterationId: it.id, title: it.title, startDate: it.startDate, duration: it.duration };
			}
			if (field.dataType === "MULTI_SELECT" && state.multiSelect && Array.isArray(v.multiSelectOptionIds)) {
				const options = (v.multiSelectOptionIds as string[]).map((id) => field.options?.find((o) => o.id === id));
				if (options.every(Boolean)) node = { __typename: "ProjectV2ItemFieldMultiSelectValue", options };
			}
			if (!node) return { error: `The field ${field.name} (${field.dataType}) does not take ${JSON.stringify(v)}` };
			item!.values[field.id] = node;
			return { result: { projectV2Item: { id: item!.id } } };
		}
		default:
			return { error: `unknown mutation ${name}` };
	}
}

/** The aliases of a mutationBatches request, in order, with their variables resolved. */
function parseMutation(query: string, variables: Record<string, unknown>): { alias: string; name: string; args: Record<string, unknown> }[] {
	return [...query.matchAll(/(m\d+): (\w+)\(input: \{([^}]*)\}\)/g)].map((m) => ({
		alias: m[1]!,
		name: m[2]!,
		args: Object.fromEntries(m[3]!.split(",").map((kv) => {
			const [k, v] = kv.split(":").map((s) => s.trim());
			return [k!, variables[v!.replace(/^\$/, "")]];
		})),
	}));
}

// ---- the gh command -----------------------------------------------------------------------------------------------

const out = (s: unknown): void => {
	process.stdout.write(typeof s === "string" ? s : `${JSON.stringify(s)}\n`);
};
const fail = (stderr: string, code = 1): never => {
	process.stderr.write(`${stderr}\n`);
	process.exit(code);
};
const flag = (argv: string[], name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

function killScript(): never {
	process.kill(process.ppid, "SIGKILL");
	process.exit(1);
}

function backupExists(): boolean {
	const dir = process.env.AGENT_SYSTEM_BACKLOG_RANK_DIR;
	if (!dir || !existsSync(join(dir, "runs"))) return false;
	return readdirSync(join(dir, "runs")).some((id) => existsSync(join(dir, "runs", id, "backup.json")));
}

async function ghMain(argv: string[]): Promise<void> {
	const statePath = process.env.FAKE_GH_STATE!;
	const logPath = process.env.FAKE_GH_LOG!;
	const state = readState(statePath);
	const record: CallRecord = { argv, ghToken: process.env.GH_TOKEN ?? null, githubToken: process.env.GITHUB_TOKEN ?? null, at: Date.now(), kind: argv.slice(0, 2).join(" ") };
	const save = () => writeState(statePath, state);
	const logCall = () => appendFileSync(logPath, `${JSON.stringify(record)}\n`);
	const count = (k: string): number => {
		state.counters[k] = (state.counters[k] ?? 0) + 1;
		return state.counters[k]!;
	};
	const [a, b] = argv;

	if (a === "auth") {
		logCall();
		if (b !== "token") fail(`fake gh: gh auth ${b} is never allowed here`);
		if (process.env.GH_TOKEN) return out(`${process.env.GH_TOKEN}\n`); // gh prints the env token when one is set
		const user = flag(argv, "-u") ?? flag(argv, "--user") ?? "thewolff-engineer";
		const token = state.tokens[user];
		if (!token) fail(`fake gh: no account ${user}`);
		return out(`${token}\n`);
	}

	if (a === "issue" && b === "list") {
		logCall();
		const repo = flag(argv, "--repo")!;
		const limit = Number(flag(argv, "--limit") ?? 30);
		if (flag(argv, "--state") !== "open") fail("fake gh: only --state open is modelled");
		const synthetic = state.listCount[repo];
		const list = synthetic !== undefined
			? Array.from({ length: synthetic }, (_, i) => issue(repo, i + 1, `Synthetic ${i + 1}`))
			: (state.repos[repo] ?? []).filter((i) => i.state === "OPEN");
		return out(list.slice(0, limit).map(({ id, number, title, body, createdAt }) => ({ id, number, title, body, createdAt })));
	}

	if (a === "issue" && b === "view") {
		logCall();
		const i = (state.repos[flag(argv, "--repo")!] ?? []).find((x) => x.number === Number(argv[2]));
		if (!i) fail(`GraphQL: Could not resolve to an issue or pull request with the number of ${argv[2]}. (repository.issue)`);
		return out({ state: i!.state });
	}

	if (a === "api" && b !== "graphql") {
		record.kind = "api comments";
		logCall();
		const path = argv.find((x) => x.startsWith("repos/"));
		const m = path ? /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments/.exec(path) : null;
		if (!m || !argv.includes("--paginate") || !argv.includes("--slurp")) fail(`fake gh: unsupported api call ${argv.join(" ")}`);
		const n = count("comments");
		if (state.kill?.on === "comments" && state.kill.nth === n) {
			save();
			killScript();
		}
		save();
		const all = state.comments[`${m![1]}#${m![2]}`] ?? [];
		const pages: unknown[] = [];
		for (let i = 0; i < all.length; i += state.commentsPageSize) pages.push(all.slice(i, i + state.commentsPageSize));
		return out(pages.length > 0 ? pages : [[]]);
	}

	if (a === "issue" && b === "comment") {
		logCall();
		const repo = flag(argv, "--repo")!;
		if (flag(argv, "--body-file") !== "-") fail("fake gh: the body comes on stdin");
		const body = await new Response(Bun.stdin.stream()).text();
		const fault = state.commentFaults.shift() ?? "ok";
		const key = `${repo}#${argv[2]}`;
		if (fault !== "fail") (state.comments[key] ??= []).push({ id: Date.now(), body });
		const n = count("post");
		save();
		if (state.kill?.on === "post" && state.kill.nth === n) killScript();
		if (fault === "lost") fail("Post \"https://api.github.com/repos/x/issues/153/comments\": read: connection reset by peer");
		if (fault === "fail") fail("HTTP 502: Bad Gateway");
		return out(`https://github.com/${repo}/issues/${argv[2]}#issuecomment-1\n`);
	}

	if (a === "api" && b === "graphql") {
		if (flag(argv, "--input") !== "-") fail("fake gh: graphql comes as --input -");
		const req = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { query: string; variables: Record<string, unknown> };
		const q = req.query;
		const vars = req.variables ?? {};
		if (q.includes('__type(name: "ProjectV2FieldValue")')) {
			record.kind = "graphql introspect";
			logCall();
			const names = ["text", "number", "date", "singleSelectOptionId", "iterationId", ...(state.multiSelect ? ["multiSelectOptionIds"] : [])];
			return out({ data: { __type: { inputFields: names.map((name) => ({ name })) } } });
		}
		if (process.env.GH_TOKEN !== THEWOLFF_TOKEN) {
			record.kind = "graphql refused";
			logCall();
			out({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project']" }] });
			fail("gh: Your token has not been granted the required scopes");
		}
		const p = state.project;
		const isProject = vars.owner === p.owner && vars.number === p.number;
		if (q.trimStart().startsWith("mutation")) {
			record.kind = "graphql mutation";
			const ops = parseMutation(q, vars);
			record.aliases = ops.length;
			record.backupSeen = backupExists();
			const fault = state.faults.shift() ?? "ok";
			record.fault = fault;
			logCall();
			const n = count("mutation");
			if (fault === "fail-before") {
				save();
				fail("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
			}
			if (fault === "rate-limit") {
				save();
				fail("HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.");
			}
			const upTo = fault.startsWith("partial:") ? Number(fault.slice("partial:".length)) : ops.length;
			const data: Record<string, unknown> = {};
			const errors: Node[] = [];
			ops.forEach((op, i) => {
				if (i >= upTo) {
					data[op.alias] = null;
					errors.push({ type: "INTERNAL", path: [op.alias], message: "Something went wrong while executing your query." });
					return;
				}
				const r = applyOne(state, op.name, op.args);
				if ("error" in r) {
					data[op.alias] = null;
					errors.push({ type: "NOT_FOUND", path: [op.alias], message: r.error });
				} else data[op.alias] = r.result;
			});
			save();
			if (state.kill?.on === "mutation" && state.kill.nth === n) killScript();
			if (fault === "apply-502") fail("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
			if (fault === "apply-lost") fail("Post \"https://api.github.com/graphql\": read tcp 10.0.0.2:51234->140.82.112.6:443: read: connection reset by peer");
			if (errors.length > 0) {
				out({ data, errors });
				fail("gh: Something went wrong while executing your query.");
			}
			return out({ data });
		}
		record.kind = "graphql query";
		logCall();
		const selection = selections(q, vars);
		try {
			validateIssueValues(selection);
		} catch (e) {
			return out({ errors: [{ message: e instanceof Error ? e.message : String(e) }] });
		}
		const valueSelection = findSelection(selection, "fieldValues");
		const valueNodes = valueSelection?.children.find((s) => s.name === "nodes")?.children ?? [];
		if (q.includes("fields(first: 100")) {
			const fields = state.project.fields.map((f) => ({ __typename: f.dataType === "SINGLE_SELECT" ? "ProjectV2SingleSelectField" : f.dataType === "ITERATION" ? "ProjectV2IterationField" : f.dataType === "MULTI_SELECT" ? "ProjectV2MultiSelectField" : "ProjectV2Field", ...f }));
			return out({ data: { user: { projectV2: isProject ? { id: p.id, fields: page(fields, vars.cursor, state.fieldsPageSize) } : null } } });
		}
		if (q.includes("items(first: 100")) {
			const archived = q.includes("archivedStates: [ARCHIVED, NOT_ARCHIVED]");
			const items = p.items.filter((i) => archived || !i.isArchived).map((i) => ({
				id: i.id,
				type: i.type,
				isArchived: i.isArchived,
				createdAt: i.createdAt,
				content: renderContent(state, i.contentId),
				fieldValues: page(renderValues(state, i).map((v) => projectValue(v, valueNodes)), null, Math.min(state.valuesPageSize, Number(valueSelection?.args.first))),
			}));
			return out({ data: { user: { projectV2: isProject ? { id: p.id, items: page(items, vars.cursor, state.pageSize) } : null } } });
		}
		if (q.includes("node(id: $id)")) {
			const item = p.items.find((i) => i.id === vars.id);
			return out({ data: { node: item ? { fieldValues: page(renderValues(state, item).map((v) => projectValue(v, valueNodes)), vars.cursor, Math.min(state.valuesPageSize, Number(valueSelection?.args.first))) } : null } });
		}
		fail(`fake gh: unmodelled graphql query: ${q.slice(0, 80)}`);
	}

	logCall();
	fail(`fake gh: unsupported: gh ${argv.join(" ")}`);
}

if (import.meta.main) await ghMain(process.argv.slice(2));

// ---- the fake judge -----------------------------------------------------------------------------------------------

let answered = 0;
let inFlight = 0;

function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
	return h;
}

/** Answers on OMP's wire for every question asked, derived from the item text so each item scores apart. */
function wireAnswers(questions: Record<string, { type: string; criteria?: unknown }>, item: string): Record<string, unknown> {
	const h = hash(item);
	const answers: Record<string, unknown> = {};
	let bit = 0;
	for (const [name, q] of Object.entries(questions)) {
		bit++;
		if (q.type === "noul") answers[name] = { noul: name === "states_deadline" || name === "irreversible" ? 0.05 : (h >>> bit) & 1 ? 0.9 : 0.1 };
		else if (q.type === "score") {
			const levels = (q.criteria as string[]).length;
			const score = (h >>> (bit * 2)) % levels;
			answers[name] = { score, confidence: 0.9, probabilities: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === score ? 1 : 0])) };
		} else {
			const labels = Object.keys(q.criteria as Record<string, string>);
			answers[name] = { choice: "none", confidence: 0.95, probabilities: Object.fromEntries(labels.map((l) => [l, l === "none" ? 1 : 0])) };
		}
	}
	return answers;
}

export async function openJudge(): Promise<{ judge: { judge(req: { state: unknown; questions: Record<string, { type: string; criteria?: unknown }> }): Promise<unknown> }; close(): void }> {
	const mode = process.env.FAKE_JUDGE_MODE ?? "ok";
	const delay = Number(process.env.FAKE_JUDGE_DELAY_MS ?? 0);
	const killAfter = process.env.FAKE_JUDGE_KILL_AFTER === undefined ? null : Number(process.env.FAKE_JUDGE_KILL_AFTER);
	const logPath = process.env.FAKE_JUDGE_LOG;
	return {
		judge: {
			async judge(req) {
				if (killAfter !== null && answered >= killAfter) process.kill(process.pid, "SIGKILL");
				inFlight++;
				const asked = req.state;
				const item = typeof asked === "object" && asked !== null && "item" in asked ? String(asked.item) : "";
				if (logPath) appendFileSync(logPath, `${JSON.stringify({ item: item.split("\n")[0], inFlight, at: Date.now() })}\n`);
				// A slow judge in real time on purpose: the script under test runs in another process, so its asks overlap
				// (R7's at-most-4) and its lock is held (R14's second invocation) only while a real delay elapses.
				if (delay > 0) await Bun.sleep(delay);
				inFlight--;
				answered++;
				const answers = wireAnswers(req.questions, item);
				if (mode === "malformed") delete answers.deadline_when;
				return { answers, model: mode === "wrong-model" ? "claude-x" : "jev-1.13.0", provider: mode === "wrong-model" ? "anthropic" : "typesafe", usage: { input: 1000 } };
			},
		},
		close() {},
	};
}
