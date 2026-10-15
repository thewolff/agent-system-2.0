// Fakes for the issues projection's tests (PLAN wl-mv66ylim0gahog § 9.2, § 13.4): GitHub as the
// projector's gh argv see it behind the exec seam (`FakeGh`; git answers `remote get-url origin`
// from a map), and Linear's GraphQL API behind the injected fetch (`FakeLinear`). Neither makes a
// network call.
import type { PrState } from "../src/issues/render";
import { PROJECTION_LABELS } from "../src/issues/render";
import type { ExecResult } from "../src/types";

export const REPO = "o/r";

export const out = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
export const json = (v: unknown): ExecResult => out(JSON.stringify(v));
export const arg = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1] ?? "";

export interface FakeIssue {
	number: number;
	title: string;
	body: string;
	labels: Set<string>;
	state: "OPEN" | "CLOSED";
	stateReason: string | null;
	comments: string[];
}
export interface FakePr {
	number: number;
	url: string;
	head: string;
	base: string;
	state: PrState;
	body: string;
}

/** GitHub as the projector's gh argv see it: issues and PRs share one number space, like GitHub's (`-R` is not told apart). */
export class FakeGh {
	next = 1;
	readonly issues = new Map<number, FakeIssue>();
	readonly prs = new Map<number, FakePr>();
	readonly labels = new Set<string>(PROJECTION_LABELS);
	/** Every gh argv, in order (git calls are not here). */
	readonly calls: string[][] = [];
	fail: (args: readonly string[]) => boolean = () => false;
	/** Runs before a gh call is answered. */
	onCall: ((args: readonly string[]) => void) | null = null;
	/** Runs before a git call is answered. */
	onGit: (() => void) | null = null;
	remaining = 5000;
	readonly origins = new Map<string, string>();
	/** Extra open PRs in the scan (to reach its limit). */
	scanPad = 0;
	/** Extra rows in a branch's `--state all` list (to reach its limit). */
	readonly branchPad = new Map<string, number>();

	addIssue(o: Partial<FakeIssue> & { title: string }): FakeIssue {
		const issue: FakeIssue = { number: this.next++, body: "", labels: new Set(), state: "OPEN", stateReason: null, comments: [], ...o };
		this.issues.set(issue.number, issue);
		return issue;
	}

	addPr(head: string, o: { base?: string; state?: PrState; body?: string } = {}): FakePr {
		const n = this.next++;
		const pr: FakePr = { number: n, url: `https://github.com/${REPO}/pull/${n}`, head, base: o.base ?? "main", state: o.state ?? "OPEN", body: o.body ?? "lane body" };
		this.prs.set(n, pr);
		return pr;
	}

	/** The gh calls whose first two words are `verb`. */
	made(verb: string): string[][] {
		return this.calls.filter((a) => `${a[0]} ${a[1]}` === verb);
	}

	readonly exec = async (command: string, args: string[]): Promise<ExecResult> => {
		if (command === "git") {
			this.onGit?.();
			const url = this.origins.get(args[1] ?? "");
			return url === undefined ? { stdout: "", stderr: "error: No such remote 'origin'", code: 2, killed: false } : out(`${url}\n`);
		}
		this.calls.push(args);
		this.onCall?.(args);
		if (this.fail(args)) return { stdout: "", stderr: "HTTP 502: Bad Gateway", code: 1, killed: false };
		return this.answer(args);
	};

	private prByRef(ref: string): FakePr | undefined {
		return [...this.prs.values()].find((p) => p.url === ref || String(p.number) === ref);
	}

	private answer(a: readonly string[]): ExecResult {
		const verb = `${a[0]} ${a[1]}`;
		switch (verb) {
			case "api rate_limit":
				return out(`${this.remaining}\n`);
			case "repo view":
				return json({ defaultBranchRef: { name: "main" } });
			case "label list":
				return json([...this.labels].map((name) => ({ name })));
			case "label create":
				this.labels.add(a[2]!);
				return out("");
			case "pr list": {
				if (arg(a, "--state") === "open") {
					const open = [...this.prs.values()].filter((p) => p.state === "OPEN");
					const rows = open.map((p) => ({ number: p.number, url: p.url, headRefName: p.head, baseRefName: p.base, isCrossRepository: false, body: p.body }));
					for (let i = 0; i < this.scanPad; i++) rows.push({ number: 90_000 + i, url: `https://github.com/${REPO}/pull/${90_000 + i}`, headRefName: `pad-${i}`, baseRefName: "main", isCrossRepository: false, body: "" });
					return json(rows.slice(0, Number(arg(a, "-L"))));
				}
				const head = arg(a, "--head");
				const rows = [...this.prs.values()].filter((p) => p.head === head).map((p) => ({ number: p.number, state: p.state, url: p.url, baseRefName: p.base }));
				for (let i = 0; i < (this.branchPad.get(head) ?? 0); i++) rows.push({ number: 80_000 + i, state: "CLOSED", url: `https://github.com/${REPO}/pull/${80_000 + i}`, baseRefName: "main" });
				return json(rows.slice(0, Number(arg(a, "-L"))));
			}
			case "pr view": {
				const pr = this.prByRef(a[2]!);
				if (!pr) return { stdout: "", stderr: "no pull requests found", code: 1, killed: false };
				return arg(a, "--json") === "body" ? json({ body: pr.body }) : json({ number: pr.number, state: pr.state, url: pr.url, baseRefName: pr.base });
			}
			case "pr edit":
				this.prByRef(a[2]!)!.body = arg(a, "--body");
				return out(a[2]!);
			case "issue list": {
				const quoted = /^"(.*)" in:title$/.exec(arg(a, "--search"))?.[1] ?? "";
				const rows = [...this.issues.values()].filter((i) => i.labels.has(arg(a, "--label")) && i.title.includes(quoted)).map((i) => ({ number: i.number, title: i.title }));
				return json(rows);
			}
			case "issue create": {
				const labels = new Set<string>();
				a.forEach((x, i) => {
					if (x === "--label") labels.add(a[i + 1]!);
				});
				const issue = this.addIssue({ title: arg(a, "--title"), body: arg(a, "--body"), labels });
				return out(`https://github.com/${REPO}/issues/${issue.number}\n`);
			}
			case "issue view": {
				const i = this.issues.get(Number(a[2]))!;
				if (arg(a, "--json") === "comments") return json({ comments: i.comments.map((body) => ({ body })) });
				return json({ title: i.title, body: i.body, labels: [...i.labels].map((name) => ({ name })), state: i.state, stateReason: i.stateReason });
			}
			case "issue edit": {
				const i = this.issues.get(Number(a[2]))!;
				if (a.includes("--title")) i.title = arg(a, "--title");
				if (a.includes("--body")) i.body = arg(a, "--body");
				if (a.includes("--add-label")) for (const l of arg(a, "--add-label").split(",")) i.labels.add(l);
				if (a.includes("--remove-label")) for (const l of arg(a, "--remove-label").split(",")) i.labels.delete(l);
				return out(`https://github.com/${REPO}/issues/${i.number}\n`);
			}
			case "issue comment": {
				this.issues.get(Number(a[2]))!.comments.push(arg(a, "--body"));
				return out(`https://github.com/${REPO}/issues/${a[2]}#issuecomment-1\n`);
			}
			case "issue reopen": {
				const i = this.issues.get(Number(a[2]))!;
				i.state = "OPEN";
				i.stateReason = "REOPENED";
				return out("");
			}
			case "issue close": {
				const i = this.issues.get(Number(a[2]))!;
				i.state = "CLOSED";
				i.stateReason = arg(a, "-r") === "not planned" ? "NOT_PLANNED" : "COMPLETED";
				return out("");
			}
			default:
				return { stdout: "", stderr: `fake gh: unknown ${a.join(" ")}`, code: 1, killed: false };
		}
	}
}

export interface FakeLinearIssue {
	id: string;
	identifier: string;
	teamId: string;
	title: string;
	description: string;
	stateId: string;
	labelIds: Set<string>;
	comments: string[];
}

/** Team ENG's workflow states as Linear reported them (PLAN § 13.1; the lane's live check, ENG-2282). */
export const ENG_STATES = [
	{ id: "st-backlog", name: "Backlog", type: "backlog" },
	{ id: "st-todo", name: "Todo", type: "unstarted" },
	{ id: "st-progress", name: "In Progress", type: "started" },
	{ id: "st-review", name: "In Review", type: "started" },
	{ id: "st-done", name: "Done", type: "completed" },
	{ id: "st-canceled", name: "Canceled", type: "canceled" },
	{ id: "st-duplicate", name: "Duplicate", type: "canceled" },
];

/** One GraphQL request the fake answered: which operation, its variables, and the Authorization header it carried. */
export interface LinearRequest {
	op: string;
	variables: Record<string, unknown>;
	auth: string | undefined;
}

/** A bare http(s) URL: not already a link's text (`[`) or target (`(<` / `<`). */
const BARE_URL = /(?<![[<(])https?:\/\/[^\s<>()[\]]+/g;

/**
 * Description Markdown as Linear stores and returns it (seen live on ENG-2284): `- ` items become
 * `* `, a bare URL becomes `[u](<u>)`, a list gets a blank line before it, and a non-blank line
 * after an item with no blank line between (a lazy continuation) is indented two spaces. Idempotent.
 */
export function linearMarkdown(md: string): string {
	const out: string[] = [];
	let inList = false;
	for (const line of md.replace(BARE_URL, (u) => `[${u}](<${u}>)`).split("\n")) {
		const item = /^[-*] (.*)$/.exec(line);
		if (item) {
			if (!inList && out.length > 0 && out.at(-1) !== "") out.push("");
			inList = true;
			out.push(`* ${item[1]}`);
		} else if (inList && line.trim() !== "") out.push(`  ${line.trimStart()}`);
		else {
			inList = false;
			out.push(line);
		}
	}
	return out.join("\n");
}

/** The block pushed to ENG-2284 (wl-mv5jz4vewt8mbk) and the description Linear returned for it, live. */
export const ENG_2284 = {
	pushed: [
		"<!-- as2:begin -->",
		"**wl-mv5jz4vewt8mbk** · open · stakes production · mode autonomous",
		"holder: nobody — waiting",
		"ceiling: spent $190.53 of $225 · 720.1 of 720 min",
		"slices: 0 open · 0 paused · 25 done · 2 cancelled",
		"open questions: none",
		"PRs:",
		"- https://github.com/thewolff/agent-system-2.0/pull/114 merged",
		"ledger seq: 297760",
		"<!-- as2:end -->",
	].join("\n"),
	returned:
		"<!-- as2:begin -->\n**wl-mv5jz4vewt8mbk** · open · stakes production · mode autonomous\nholder: nobody — waiting\nceiling: spent $190.53 of $225 · 720.1 of 720 min\nslices: 0 open · 0 paused · 25 done · 2 cancelled\nopen questions: none\nPRs:\n\n* [https://github.com/thewolff/agent-system-2.0/pull/114](<https://github.com/thewolff/agent-system-2.0/pull/114>) merged\n  ledger seq: 297760\n  <!-- as2:end -->",
};

/** A mutation whose returned issue selects `description`: only then does the fake's answer carry it, as GraphQL's does. */
const SELECTS_DESCRIPTION = /\bissue\s*\{[^}]*\bdescription\b/;

/**
 * Linear's GraphQL API behind the injected fetch: one team per key, its states and labels, and its
 * issues. `reply` replaces the answer for a request (an HTTP error, `errors` on 200, a throw).
 */
export class FakeLinear {
	readonly teams = new Map<string, { id: string; key: string; states: typeof ENG_STATES; labels: { id: string; name: string }[] }>();
	readonly issues = new Map<string, FakeLinearIssue>();
	readonly requests: LinearRequest[] = [];
	reply: ((r: LinearRequest) => Response | null) | null = null;
	/** Store descriptions on create and update as Linear does (`linearMarkdown`), and return the stored text. */
	normalise = false;
	/** Page size the fake answers a labelled list with (the client asks for 250). */
	pageSize = 250;
	private seq = 0;

	constructor(teamKeys: readonly string[] = ["ENG"]) {
		for (const key of teamKeys) this.teams.set(key, { id: `team-${key}`, key, states: ENG_STATES.map((s) => ({ ...s, id: `${s.id}-${key}` })), labels: [] });
	}

	team(key = "ENG") {
		return this.teams.get(key)!;
	}

	stateName(issue: FakeLinearIssue): string {
		return [...this.teams.values()].flatMap((t) => t.states).find((s) => s.id === issue.stateId)?.name ?? "?";
	}

	labelNames(issue: FakeLinearIssue): string[] {
		const all = [...this.teams.values()].flatMap((t) => t.labels);
		return [...issue.labelIds].map((id) => all.find((l) => l.id === id)?.name ?? id).sort();
	}

	/** The requests whose operation is `op`. */
	made(op: string): LinearRequest[] {
		return this.requests.filter((r) => r.op === op);
	}

	addIssue(o: { title: string; description?: string; team?: string; labels?: string[]; state?: string }): FakeLinearIssue {
		const team = this.team(o.team);
		const n = ++this.seq;
		const labelIds = new Set((o.labels ?? []).map((name) => {
			let l = team.labels.find((x) => x.name === name);
			if (!l) {
				l = { id: `lbl-${name}-${team.key}`, name };
				team.labels.push(l);
			}
			return l.id;
		}));
		const issue: FakeLinearIssue = { id: `iss-${n}`, identifier: `${team.key}-${100 + n}`, teamId: team.id, title: o.title, description: o.description ?? "", stateId: team.states.find((s) => s.name === (o.state ?? "In Progress"))!.id, labelIds, comments: [] };
		this.issues.set(issue.id, issue);
		return issue;
	}

	/** An issue as Linear answers it: its labels cut to the query's `labels(first: N)`, `hasNextPage` saying whether more exist. */
	private node(i: FakeLinearIssue, labelsFirst: number) {
		const states = [...this.teams.values()].flatMap((t) => t.states);
		const labels = [...this.teams.values()].flatMap((t) => t.labels);
		const all = [...i.labelIds].map((id) => labels.find((l) => l.id === id)!).filter(Boolean);
		return {
			id: i.id,
			identifier: i.identifier,
			title: i.title,
			description: i.description,
			state: states.find((s) => s.id === i.stateId) ?? null,
			labels: { nodes: all.slice(0, labelsFirst), pageInfo: { hasNextPage: all.length > labelsFirst } },
		};
	}

	readonly fetch = async (_url: string, init: { headers: Record<string, string>; body: string }): Promise<Response> => {
		const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
		const op =
			query.includes("issueLabelCreate") ? "labelCreate"
			: query.includes("issueCreate") ? "create"
			: query.includes("issueUpdate") ? "update"
			: query.includes("commentCreate") ? "comment"
			: query.includes("teams(") ? "team"
			: query.includes("startsWith") ? "search"
			: query.includes("issue(id") && query.includes("comments(") ? "comments"
			: query.includes("issue(id") && query.includes("endCursor") ? "labels"
			: query.includes("issue(id") ? "read"
			: query.includes("issues(") ? "list"
			: "unknown";
		const req: LinearRequest = { op, variables, auth: init.headers.Authorization };
		this.requests.push(req);
		const replaced = this.reply?.(req);
		if (replaced) return replaced;
		const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
		const labelsFirst = Number(/labels\(first: (\d+)\)/.exec(query)?.[1] ?? Number.POSITIVE_INFINITY);
		const v = variables;
		switch (op) {
			case "team": {
				const t = this.teams.get(String(v.key));
				return ok({ teams: { nodes: t ? [{ id: t.id, key: t.key, states: { nodes: t.states }, labels: { nodes: t.labels } }] : [] } });
			}
			case "labelCreate": {
				const t = [...this.teams.values()].find((x) => x.id === v.teamId)!;
				const l = { id: `lbl-${String(v.name)}-${t.key}`, name: String(v.name) };
				t.labels.push(l);
				return ok({ issueLabelCreate: { success: true, issueLabel: l } });
			}
			case "search": {
				const t = this.teams.get(String(v.team))!;
				const label = t.labels.find((l) => l.name === v.label)?.id;
				const hits = [...this.issues.values()].filter((i) => i.teamId === t.id && i.title.startsWith(String(v.prefix)) && label !== undefined && i.labelIds.has(label));
				return ok({ issues: { nodes: hits.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title })) } });
			}
			case "list": {
				const t = this.teams.get(String(v.team))!;
				const label = t.labels.find((l) => l.name === v.label)?.id;
				const all = [...this.issues.values()].filter((i) => i.teamId === t.id && label !== undefined && i.labelIds.has(label));
				const start = v.after === null || v.after === undefined ? 0 : Number(v.after);
				const page = all.slice(start, start + this.pageSize);
				const end = start + page.length;
				return ok({ issues: { nodes: page.map((i) => this.node(i, labelsFirst)), pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } });
			}
			case "create": {
				const input = v.input as { teamId: string; title: string; description: string; labelIds: string[]; stateId: string };
				const team = [...this.teams.values()].find((t) => t.id === input.teamId)!;
				const n = ++this.seq;
				const description = this.normalise ? linearMarkdown(input.description) : input.description;
				const issue: FakeLinearIssue = { id: `iss-${n}`, identifier: `${team.key}-${100 + n}`, teamId: team.id, title: input.title, description, stateId: input.stateId, labelIds: new Set(input.labelIds), comments: [] };
				this.issues.set(issue.id, issue);
				return ok({ issueCreate: { success: true, issue: { id: issue.id, identifier: issue.identifier, ...(SELECTS_DESCRIPTION.test(query) ? { description: issue.description } : {}) } } });
			}
			case "read": {
				const i = this.issues.get(String(v.id));
				if (!i) return new Response(JSON.stringify({ data: null, errors: [{ message: "Entity not found: Issue" }] }), { status: 200 });
				return ok({ issue: this.node(i, labelsFirst) });
			}
			case "labels": {
				// One page of an issue's labels: `labels(first: N, after: $after)`, the cursor an index.
				const i = this.issues.get(String(v.id));
				if (!i) return new Response(JSON.stringify({ data: null, errors: [{ message: "Entity not found: Issue" }] }), { status: 200 });
				const first = Number(/labels\(first: (\d+), after: \$after\)/.exec(query)?.[1]);
				const all = [...this.teams.values()].flatMap((t) => t.labels);
				const mine = [...i.labelIds].map((id) => all.find((l) => l.id === id)!).filter(Boolean);
				const start = v.after === null || v.after === undefined ? 0 : Number(v.after);
				const page = mine.slice(start, start + first);
				const end = start + page.length;
				return ok({ issue: { labels: { nodes: page, pageInfo: { hasNextPage: end < mine.length, endCursor: String(end) } } } });
			}
			case "comments": {
				// The comments whose body contains `$body` (`comments(filter: { body: { contains: $body } })`).
				const i = this.issues.get(String(v.id));
				if (!i) return new Response(JSON.stringify({ data: null, errors: [{ message: "Entity not found: Issue" }] }), { status: 200 });
				return ok({ issue: { comments: { nodes: i.comments.filter((c) => c.includes(String(v.body))).map((_, n) => ({ id: `cmt-${n}` })) } } });
			}
			case "update": {
				const i = this.issues.get(String(v.id))!;
				const input = v.input as { title?: string; description?: string; labelIds?: string[]; stateId?: string };
				if (input.title !== undefined) i.title = input.title;
				if (input.description !== undefined) i.description = this.normalise ? linearMarkdown(input.description) : input.description;
				if (input.labelIds !== undefined) i.labelIds = new Set(input.labelIds);
				if (input.stateId !== undefined) i.stateId = input.stateId;
				return ok({ issueUpdate: { success: true, issue: { id: i.id, ...(SELECTS_DESCRIPTION.test(query) ? { description: i.description } : {}) } } });
			}
			case "comment": {
				this.issues.get(String(v.issueId))!.comments.push(String(v.body));
				return ok({ commentCreate: { success: true } });
			}
			default:
				return new Response(JSON.stringify({ errors: [{ message: `fake linear: unknown query ${query.slice(0, 60)}` }] }), { status: 200 });
		}
	};
}
