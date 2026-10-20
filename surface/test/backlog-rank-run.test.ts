// sl-br-run of wl-mvh42n85yo0m4g (PLAN § 2 D2, D4–D7; Requirements R1, R3, R4, R5, R6, R7, R8, R14): the effects
// script surface/scripts/backlog-rank.ts, driven as a subprocess against fixtures/backlog-rank-fake-gh.ts first on PATH
// as `gh` (a stateful board, issue lists, comments and accounts in a JSON file) and as the injected judge. Nothing here
// reaches GitHub or a live judge. The waits are injected (pause 20 ms, backoff 5 ms) so the file runs in seconds.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishBackup } from "../scripts/backlog-rank";
import { type BoardItem, type BoardSnapshot, commentMarker, parseCache, parseLastRun, undoPlan } from "../src/backlog-rank";
import {
	AS2, type CallRecord, contentOf, type FakeState, issueId, JI, readCalls, readState, renderValues, seedState, THEWOLFF_TOKEN, writeState,
} from "./fixtures/backlog-rank-fake-gh";
import { tmp, until } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "backlog-rank.ts");
const FIXTURE = join(import.meta.dir, "fixtures", "backlog-rank-fake-gh.ts");
const AS2_BIN = join(import.meta.dir, "..", "..", "bin", "as2");
const COMMENT_KEY = "thewolff/jo-issues#153";
const D1 = "2026-10-20T19:10:00Z"; // 12:10 PM PDT Oct 20
const D2 = "2026-10-21T19:10:00Z";
const D3 = "2026-10-22T19:10:00Z";
const OPEN = ["jo-issues#1", "jo-issues#2", "jo-issues#3", "jo-issues#4", "jo-issues#5", "jo-issues#6", "as2#10", "as2#11", "as2#12", "as2#13", "as2#14"];

interface World {
	root: string;
	statePath: string;
	ghLog: string;
	judgeLog: string;
	dir: string;
	env: Record<string, string>;
}

/** A temp world: the fake gh first on PATH, its state seeded (then `tweak`ed), a state dir with goals.md, no ledger. */
function world(tweak: (s: FakeState) => void = () => {}): World {
	const root = tmp("backlog-rank");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
	chmodSync(join(bin, "gh"), 0o755);
	const state = seedState();
	tweak(state);
	const statePath = join(root, "gh-state.json");
	writeState(statePath, state);
	const dir = join(root, "state");
	mkdirSync(dir);
	writeFileSync(join(dir, "goals.md"), "# Goals\ngoal: Work flows to main.\ngoal: Spend less per unit of work.\n");
	const w = { root, statePath, ghLog: join(root, "gh-calls.jsonl"), judgeLog: join(root, "judge-calls.jsonl"), dir, env: {} as Record<string, string> };
	w.env = {
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		HOME: root,
		TZ: "America/Los_Angeles",
		AGENT_SYSTEM_BACKLOG_RANK_DIR: dir,
		AGENT_SYSTEM_LEDGER_DB: join(root, "no-ledger.db"),
		AGENT_SYSTEM_BACKLOG_RANK_JUDGE: FIXTURE,
		AGENT_SYSTEM_BACKLOG_RANK_PAUSE_MS: "20",
		AGENT_SYSTEM_BACKLOG_RANK_BACKOFF_MS: "5,5,5",
		AGENT_SYSTEM_BACKLOG_RANK_CLOCK: D1,
		FAKE_GH_STATE: statePath,
		FAKE_GH_LOG: w.ghLog,
		FAKE_JUDGE_LOG: w.judgeLog,
		// Inherited tokens: the script must strip them from every gh child and never use them for the board.
		GH_TOKEN: "env-gh-token",
		GITHUB_TOKEN: "env-github-token",
	};
	return w;
}

interface Result {
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
}

async function run(w: World, args: string[] = [], extra: Record<string, string> = {}, argv0: string[] = [process.execPath, SCRIPT]): Promise<Result> {
	const child = Bun.spawn([...argv0, ...args], { env: { ...w.env, ...extra }, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	return { code: child.signalCode ? null : child.exitCode, signal: child.signalCode ?? null, stdout, stderr };
}

const state = (w: World): FakeState => readState(w.statePath);
const calls = (w: World): CallRecord[] => readCalls(w.ghLog);
const judgeCalls = (w: World): { item: string; inFlight: number }[] => (existsSync(w.judgeLog) ? readFileSync(w.judgeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastRun = (w: World) => parseLastRun(JSON.parse(readFileSync(join(w.dir, "last-run.json"), "utf8")));
const runFile = (w: World, runId: string, name: string): string => join(w.dir, "runs", runId, name);
const orderOf = (w: World, runId: string): { id: string; rank: number; score: number }[] => JSON.parse(readFileSync(runFile(w, runId, "order.json"), "utf8")).order;
const comments = (w: World): { body: string }[] => state(w).comments[COMMENT_KEY] ?? [];
const runComments = (w: World, runId: string) => comments(w).filter((c) => c.body.includes(commentMarker(runId)));
const tweakState = (w: World, f: (s: FakeState) => void): void => {
	const s = state(w);
	f(s);
	writeState(w.statePath, s);
};

/** The fake board as the script reads it, for comparisons with a backup. */
function snapshotOf(s: FakeState): BoardSnapshot {
	return {
		projectId: s.project.id,
		fields: s.project.fields,
		items: s.project.items.map((i): BoardItem => {
			const c = contentOf(s, i.contentId);
			return { id: i.id, type: i.type, contentId: i.contentId, repo: c?.repo ?? null, number: c?.number ?? null, isArchived: i.isArchived, createdAt: i.createdAt, fieldValues: renderValues(s, i) as BoardItem["fieldValues"] };
		}),
	};
}

/** Cards per backlog key (`jo-issues#N` / `as2#N`) on the fake board. */
function cardsByKey(s: FakeState): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const item of s.project.items) {
		const c = contentOf(s, item.contentId);
		if (c?.__typename !== "Issue" || (c.repo !== JI && c.repo !== AS2)) continue;
		const key = `${c.repo === JI ? "jo-issues" : "as2"}#${c.number}`;
		out.set(key, [...(out.get(key) ?? []), item.id]);
	}
	return out;
}

/** The board holds exactly one card per open issue, with Rank, Jev score, Ranked at and Lane state as order.json has them. */
function expectBoardMatches(w: World, runId: string, stamp = "12:10 PM PDT Oct 20"): void {
	const s = state(w);
	const cards = cardsByKey(s);
	expect([...cards.keys()].sort()).toEqual([...OPEN].sort());
	for (const [key, ids] of cards) expect({ key, cards: ids.length }).toEqual({ key, cards: 1 });
	for (const o of orderOf(w, runId)) {
		const item = s.project.items.find((i) => i.id === cards.get(o.id)![0])!;
		expect({ id: o.id, rank: item.values.F_rank?.number, score: item.values.F_score?.number, at: item.values.F_at?.text, lane: item.values.F_lane?.optionId })
			.toEqual({ id: o.id, rank: o.rank, score: o.score, at: stamp, lane: "o_none" });
	}
}

const mutations = (w: World): CallRecord[] => calls(w).filter((c) => c.kind === "graphql mutation");

// ---- R1 and R8: one full run --------------------------------------------------------------------------------------

let standard: Promise<{ w: World; r: Result; runId: string }> | null = null;
/** The standard world run once (shared by R1, R5's batch checks and R8): pause 200 ms so the pause shows in the log. */
function standardRun() {
	standard ??= (async () => {
		const w = world();
		const r = await run(w, [], { AGENT_SYSTEM_BACKLOG_RANK_PAUSE_MS: "200" });
		return { w, r, runId: lastRun(w).runId };
	})();
	return standard;
}

describe("R1: both backlogs are ranked and an incomplete list is refused", () => {
	test("every open issue of jo-issues and agent-system-2.0 is ranked and gets one card; closed and other cards are handled", async () => {
		const { w, r, runId } = await standardRun();
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(orderOf(w, runId).map((o) => o.id).sort()).toEqual([...OPEN].sort());
		expect(orderOf(w, runId).map((o) => o.rank)).toEqual(OPEN.map((_, i) => i + 1));
		expectBoardMatches(w, runId);
		const ids = state(w).project.items.map((i) => i.id);
		expect(ids).not.toContain("PVTI_7"); // the closed issue's card is deleted
		expect(ids).toEqual(expect.arrayContaining(["PVTI_n5", "PVTI_pr", "PVTI_draft"])); // another repo, a PR, a draft: untouched
		expect(state(w).project.items.find((i) => i.id === "PVTI_2")!.isArchived).toBe(true);
		expect(lastRun(w)).toMatchObject({ runId, phase: "written", outcome: "succeeded", commented: true, attempts: 1 });
		expect(runComments(w, runId)).toHaveLength(1);
		const listed = calls(w).filter((c) => c.kind === "issue list").map((c) => c.argv);
		expect(listed).toEqual([JI, AS2].map((repo) => ["issue", "list", "--repo", repo, "--state", "open", "--limit", "1000", "--json", "id,number,title,body,createdAt"]));
	});

	test("a repo listing 1000 open issues refuses the attempt before any Jev call or board call", async () => {
		const w = world((s) => {
			s.listCount[AS2] = 1000;
		});
		const r = await run(w);
		expect(r.code).toBe(1);
		expect(r.stderr).toMatch(/attempt 1 of 3 failed in ranking: thewolff\/agent-system-2\.0: 1000 open issues listed, at the --limit 1000; the list may be incomplete/);
		expect(judgeCalls(w)).toHaveLength(0);
		expect(calls(w).filter((c) => c.kind.startsWith("graphql"))).toHaveLength(0);
		expect(lastRun(w)).toMatchObject({ phase: "ranking", outcome: "pending", attempts: 1, commented: false });
	});
});

describe("R8: thewolff's token reaches every board GraphQL call and nothing else", () => {
	test("board graphql children see thewolff's token; issue lists, comments and the token read see no GH_TOKEN or GITHUB_TOKEN; no auth switch", async () => {
		const { w } = await standardRun();
		const all = calls(w);
		const graphql = all.filter((c) => c.argv[0] === "api" && c.argv[1] === "graphql");
		const others = all.filter((c) => !(c.argv[0] === "api" && c.argv[1] === "graphql"));
		expect(graphql.filter((c) => c.kind === "graphql query").length).toBeGreaterThan(2);
		expect(graphql.filter((c) => c.kind === "graphql mutation").length).toBeGreaterThan(2);
		for (const c of graphql) expect({ kind: c.kind, gh: c.ghToken, github: c.githubToken }).toEqual({ kind: c.kind, gh: THEWOLFF_TOKEN, github: null });
		expect(new Set(others.map((c) => c.kind))).toEqual(new Set(["auth token", "issue list", "api comments", "issue comment"]));
		for (const c of others) expect({ argv: c.argv, gh: c.ghToken, github: c.githubToken }).toEqual({ argv: c.argv, gh: null, github: null });
		expect(all.filter((c) => c.argv[0] === "auth").map((c) => c.argv)).toEqual([["auth", "token", "-u", "thewolff"]]);
		expect(all.some((c) => c.argv[0] === "auth" && ["switch", "login", "logout"].includes(c.argv[1]!))).toBe(false);
	});
});

// ---- R3: the backup -----------------------------------------------------------------------------------------------

// These exercise the real subprocess/transport, not the query constants or a second copy of the parser.
describe("review regressions: complete typed snapshots and safe retries", () => {
	test("the transport rejects conflicting scalar and nullability shapes even on an empty board", async () => {
		const w = world((s) => { s.project.items = []; });
		for (const type of ["IssueFieldNumberValue", "IssueFieldMultiSelectValue"]) {
			const query = `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { fieldValues(first: 20) { nodes { ... on ProjectV2ItemIssueFieldValue { issueFieldValue { ... on IssueFieldTextValue { value } ... on ${type} { value } } } } } } } }`;
			const child = Bun.spawn([process.execPath, FIXTURE, "api", "graphql", "--input", "-"], {
				env: { ...w.env, GH_TOKEN: THEWOLFF_TOKEN }, stdin: new Blob([JSON.stringify({ query, variables: { id: "PVTI_1" } })]), stdout: "pipe", stderr: "pipe",
			});
			const output = await new Response(child.stdout).json();
			expect(await child.exited).toBe(0);
			expect(output.errors[0].message).toContain("Fields 'value' conflict");
		}
	});

	test("an interrupted backup publication exposes no partial file and a later publication never replaces the original", () => {
		const w = world();
		const path = join(w.dir, "backup.json");
		const original = snapshotOf(state(w));
		expect(() => publishBackup(path, original, (temporary) => {
			expect(existsSync(path)).toBe(false);
			expect(JSON.parse(readFileSync(temporary, "utf8")).items).toHaveLength(original.items.length);
			throw new Error("interrupted before publication");
		})).toThrow("interrupted before publication");
		expect(existsSync(path)).toBe(false);
		publishBackup(path, original);
		const bytes = readFileSync(path, "utf8");
		publishBackup(path, { ...original, items: [] });
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(readdirSync(w.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("all five issue-field variants survive the schema-aware transport and backup", async () => {
		const variants = [
			{ __typename: "IssueFieldTextValue", value: "hello" },
			{ __typename: "IssueFieldNumberValue", value: 12.5 },
			{ __typename: "IssueFieldDateValue", value: "2026-12-01" },
			{ __typename: "IssueFieldSingleSelectValue", value: "P1", optionId: "p1" },
			{ __typename: "IssueFieldMultiSelectValue", value: null },
		];
		const w = world((s) => {
			s.valuesPageSize = 2;
			variants.forEach((value, n) => {
				const id = `F_issue_${n}`;
				s.project.fields.push({ id, name: `Issue ${n}`, dataType: "TEXT" });
				s.derived[issueId(JI, 1)]![id] = { __typename: "ProjectV2ItemIssueFieldValue", issueFieldValue: value };
			});
		});
		const r = await run(w);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const backup = JSON.parse(readFileSync(runFile(w, lastRun(w).runId, "backup.json"), "utf8")) as BoardSnapshot;
		const values = backup.items.find((i) => i.id === "PVTI_1")!.fieldValues;
		expect(variants.map((_, n) => values.find((v) => v.field.id === `F_issue_${n}`)?.issueFieldValue)).toEqual(variants);
	});

	for (const broken of ['{"projectId":', '{"projectId":"PVT_fake1","fields":[]}', '{"projectId":"PVT_fake1","fields":[],"items":[{}]}', '{"projectId":"PVT_fake1","fields":[],"items":[]}']) {
		test(`a resumed attempt refuses a corrupt/incomplete existing backup: ${broken}`, async () => {
			const w = world((s) => { s.faults = ["fail-before", "fail-before", "fail-before"]; });
			expect((await run(w)).code).toBe(1);
			const id = lastRun(w).runId;
			const path = runFile(w, id, "backup.json");
			writeFileSync(path, broken);
			tweakState(w, (s) => { s.faults = []; });
			const prior = mutations(w).length;
			const retry = await run(w);
			expect(retry.code).toBe(1);
			expect(retry.stderr).toContain("backup");
			expect(mutations(w)).toHaveLength(prior);
			expect(readFileSync(path, "utf8")).toBe(broken);
		});
	}

	test("every nested connection is complete and undo detects changes beyond entry 25 without writing them", async () => {
		const specs = [
			["F_labels", "ProjectV2ItemFieldLabelValue", "labels", (n: number) => ({ name: `label-${n}` })],
			["F_assignees", "ProjectV2ItemFieldUserValue", "users", (n: number) => ({ login: `user-${n}` })],
			["F_prs", "ProjectV2ItemFieldPullRequestValue", "pullRequests", (n: number) => ({ number: n, repository: { nameWithOwner: JI } })],
			["F_reviewers", "ProjectV2ItemFieldReviewerValue", "reviewers", (n: number) => n % 2 ? ({ __typename: "Team", slug: `team-${n}` }) : ({ __typename: "User", login: `reviewer-${n}` })],
		] as const;
		const w = world((s) => {
			s.valuesPageSize = 3;
			for (const [id, type, key, node] of specs) s.derived[issueId(JI, 1)]![id] = { __typename: type, [key]: { nodes: Array.from({ length: 57 }, (_, n) => node(n)) } };
		});
		expect((await run(w)).code).toBe(0);
		const path = runFile(w, lastRun(w).runId, "backup.json");
		const backup = JSON.parse(readFileSync(path, "utf8")) as BoardSnapshot;
		for (const [id, , key, node] of specs) expect(backup.items.find((i) => i.id === "PVTI_1")!.fieldValues.find((v) => v.field.id === id)![key]).toEqual({ nodes: Array.from({ length: 57 }, (_, n) => node(n)) });
		tweakState(w, (s) => {
			for (const [id, , key, node] of specs) {
				const connection = s.derived[issueId(JI, 1)]![id]![key];
				if (!connection || typeof connection !== "object" || !("nodes" in connection) || !Array.isArray(connection.nodes)) throw new Error("missing fixture connection");
				connection.nodes[56] = node(999);
			}
		});
		const undo = await run(w, ["--undo", path]);
		expect(undo.code).toBe(0);
		for (const name of ["Labels", "Assignees", "Linked pull requests", "Reviewers"]) expect(undo.stdout).toContain(`content-derived, not written: jo-issues#1 ${name}`);
		expect(undo.stdout).toContain("999");
		for (const [id, , key, node] of specs) {
			const connection = state(w).derived[issueId(JI, 1)]![id]![key];
			if (!connection || typeof connection !== "object" || !("nodes" in connection) || !Array.isArray(connection.nodes)) throw new Error("missing fixture connection");
			expect(connection.nodes[56]).toEqual(node(999));
		}
	}, 30_000);
});

describe("R3: every value of every item is backed up before the first mutation", () => {
	test("all value types, archived items, paginated items, values and fields, written before the first mutation", async () => {
		const w = world((s) => {
			s.pageSize = 2;
			s.valuesPageSize = 3;
			s.fieldsPageSize = 5;
		});
		const before = state(w);
		const r = await run(w);
		expect(r.code).toBe(0);
		const runId = lastRun(w).runId;
		const backupPath = runFile(w, runId, "backup.json");
		const backup: BoardSnapshot = JSON.parse(readFileSync(backupPath, "utf8"));
		expect(backup.projectId).toBe(before.project.id);
		expect(backup.fields.map((f) => f.id)).toEqual(before.project.fields.map((f) => f.id));
		expect(backup.fields.find((f) => f.id === "F_sprint")!.configuration).toEqual(before.project.fields.find((f) => f.id === "F_sprint")!.configuration);
		expect(backup.fields.find((f) => f.id === "F_lane")!.options).toHaveLength(4);
		expect(backup.items.map((i) => i.id)).toEqual(before.project.items.map((i) => i.id));
		const sorted = (vs: unknown[]) => vs.map((v) => JSON.stringify(v)).sort();
		for (const item of before.project.items) {
			const b = backup.items.find((x) => x.id === item.id)!;
			expect({ id: item.id, archived: b.isArchived, values: sorted(b.fieldValues) }).toEqual({ id: item.id, archived: item.isArchived, values: sorted(renderValues(before, item)) });
		}
		expect(backup.items.find((i) => i.id === "PVTI_2")!.isArchived).toBe(true);
		expect(new Set(backup.items.flatMap((i) => i.fieldValues.map((v) => v.__typename)))).toEqual(new Set([
			"ProjectV2ItemFieldTextValue", "ProjectV2ItemFieldNumberValue", "ProjectV2ItemFieldDateValue", "ProjectV2ItemFieldSingleSelectValue",
			"ProjectV2ItemFieldIterationValue", "ProjectV2ItemFieldMultiSelectValue", "ProjectV2ItemFieldLabelValue", "ProjectV2ItemFieldUserValue",
			"ProjectV2ItemFieldMilestoneValue", "ProjectV2ItemFieldRepositoryValue", "ProjectV2ItemFieldPullRequestValue", "ProjectV2ItemFieldReviewerValue",
			"ProjectV2ItemIssueFieldValue",
		]));
		const queries = calls(w).filter((c) => c.kind === "graphql query");
		expect(queries.length).toBeGreaterThan(10); // items in pages of 2, values in pages of 3, fields in pages of 5
		const first = mutations(w)[0]!;
		expect(first.backupSeen).toBe(true);
		expect(statSync(backupPath).mtimeMs).toBeLessThanOrEqual(first.at);
		expectBoardMatches(w, runId);
	});
});

// ---- R4: undo -----------------------------------------------------------------------------------------------------

describe("R4: --undo restores the item set, writable values and archive state, and finishes after an interruption", () => {
	test("an undo cut off by three ambiguous outcomes exits non-zero; as2 backlog-rank --undo again restores the backup", async () => {
		const w = world();
		expect((await run(w)).code).toBe(0);
		const backupPath = runFile(w, lastRun(w).runId, "backup.json");
		const backup: BoardSnapshot = JSON.parse(readFileSync(backupPath, "utf8"));
		tweakState(w, (s) => {
			const p = s.project;
			p.items.find((i) => i.id === "PVTI_2")!.isArchived = false;
			const one = p.items.find((i) => i.id === "PVTI_1")!;
			one.values.F_status = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "s_done", name: "Done" };
			delete one.values.F_note;
			s.derived[issueId(JI, 1)]!.F_labels = { __typename: "ProjectV2ItemFieldLabelValue", labels: { nodes: [{ name: "bug" }, { name: "p1" }] } };
			s.faults = ["ok", "apply-502", "fail-before", "fail-before"];
		});
		const cut = await run(w, ["--undo", backupPath]);
		expect(cut.code).toBe(1);
		expect(cut.stderr).toMatch(/undo failed after 10 writes: 3 ambiguous outcomes in a row; .*run `as2 backlog-rank --undo .*backup\.json` again to finish/);
		expect(undoPlan(backup, snapshotOf(state(w)), { multiSelect: true }).ops.length).toBeGreaterThan(0);

		const again = await run(w, ["backlog-rank", "--undo", backupPath], {}, [AS2_BIN]);
		expect(again.stderr).toBe("");
		expect(again.code).toBe(0);
		expect(again.stdout).toContain("match");
		expect(again.stdout).toMatch(/content-derived, not written: jo-issues#1 Labels/);
		const s = state(w);
		expect(undoPlan(backup, snapshotOf(s), { multiSelect: true })).toMatchObject({ ops: [], unrestorable: [] });
		expect(s.project.items.map((i) => i.contentId).sort()).toEqual(backup.items.map((i) => i.contentId).sort());
		const seven = s.project.items.find((i) => i.contentId === issueId(JI, 7))!;
		expect(seven.id).not.toBe("PVTI_7"); // re-added under a new item id
		expect(seven.values).toEqual({ F_rank: { __typename: "ProjectV2ItemFieldNumberValue", number: 2 }, F_note: { __typename: "ProjectV2ItemFieldTextValue", text: "closed one" } });
		expect(s.project.items.find((i) => i.id === "PVTI_2")!.isArchived).toBe(true);
		const one = s.project.items.find((i) => i.id === "PVTI_1")!;
		expect([one.values.F_status?.optionId, one.values.F_note?.text, one.values.F_rank?.number, one.values.F_score?.number]).toEqual(["s_todo", "keep me", 3, 0.5]);
		expect(one.values.F_tags).toEqual({ __typename: "ProjectV2ItemFieldMultiSelectValue", options: [{ id: "t_a", name: "a" }] });
		expect(s.project.items.find((i) => i.id === "PVTI_3")!.values).toEqual({ F_rank: { __typename: "ProjectV2ItemFieldNumberValue", number: 5 } });
		for (const c of mutations(w)) expect(c.aliases!).toBeLessThanOrEqual(10);
	});
});

// ---- R5: batches and reconcile ------------------------------------------------------------------------------------

describe("R5: small batches, paused, and every ambiguous outcome reconciled without duplicates", () => {
	test("at most 10 mutations per request, with the pause between requests", async () => {
		const { w } = await standardRun();
		const m = mutations(w);
		expect(m.length).toBeGreaterThan(2);
		expect(Math.max(...m.map((c) => c.aliases!))).toBe(10);
		for (const c of m) expect(c.aliases!).toBeLessThanOrEqual(10);
		for (let i = 1; i < m.length; i++) expect(m[i]!.at - m[i - 1]!.at).toBeGreaterThanOrEqual(200);
	});

	for (const [name, fault] of [
		["(a) failing before any apply", "fail-before"],
		["(b) a partial apply answering errors with partial data", "partial:4"],
		["(c) a full apply answered by a 502", "apply-502"],
		["(d) a full apply whose response is lost", "apply-lost"],
		["a secondary rate limit", "rate-limit"],
	] as const) {
		test(`${name} is re-read and reconciled, never replayed: no duplicate cards, the board matches`, async () => {
			const w = world((s) => {
				s.faults = [fault];
			});
			const r = await run(w);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("ambiguous outcome 1 of 3");
			const runId = lastRun(w).runId;
			expectBoardMatches(w, runId);
			const all = calls(w);
			const at = all.findIndex((c) => c.fault === fault);
			expect(all[at + 1]!.kind).toBe("graphql query"); // the next call re-reads the board
			const adds = mutations(w).length;
			expect(adds).toBeGreaterThan(1);
			expect(runComments(w, runId)).toHaveLength(1);
		});
	}

	test("three ambiguous outcomes in a row end the attempt non-zero; the next invocation completes the board", async () => {
		const w = world((s) => {
			s.faults = ["apply-502", "fail-before", "apply-lost"];
		});
		const first = await run(w);
		expect(first.code).toBe(1);
		expect(first.stderr).toMatch(/attempt 1 of 3 failed in writing: 3 ambiguous outcomes in a row/);
		const runId = lastRun(w).runId;
		expect(lastRun(w)).toMatchObject({ phase: "writing", outcome: "pending", attempts: 1, commented: false });
		expect(comments(w)).toHaveLength(1); // only the older comment
		const second = await run(w);
		expect(second.code).toBe(0);
		expect(lastRun(w)).toMatchObject({ runId, phase: "written", outcome: "succeeded", attempts: 2, commented: true });
		expectBoardMatches(w, runId);
		const attempts = readFileSync(runFile(w, runId, "attempts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(attempts.map((a) => a.error === null)).toEqual([false, true]);
		expect(runComments(w, runId)).toHaveLength(1);
	});
});

// ---- R6: one comment per run id -----------------------------------------------------------------------------------

describe("R6: exactly one comment per run id across kills, lost responses and retries", () => {
	const killNext = (w: World, on: "mutation" | "comments" | "post") => tweakState(w, (s) => {
		s.kill = { on, nth: (s.counters[on] ?? 0) + 1 };
	});

	test("killed while ranking, while writing, after written before posting, and after posting before recording: one run, one comment", async () => {
		const w = world();
		// Four asks in flight, each 20 ms; the ask that starts after the fourth answer kills the script mid-ranking.
		const k1 = await run(w, [], { FAKE_JUDGE_KILL_AFTER: "4", FAKE_JUDGE_DELAY_MS: "20" });
		expect(k1.signal).toBe("SIGKILL");
		const runId = lastRun(w).runId;
		expect(lastRun(w)).toMatchObject({ phase: "ranking", outcome: "pending", commented: false });
		const cachedAfterKill = parseCache(readFileSync(join(w.dir, "cache.jsonl"), "utf8")).entries.size;
		expect(cachedAfterKill).toBeGreaterThan(0);
		expect(cachedAfterKill).toBeLessThan(OPEN.length);
		const judgedBefore = judgeCalls(w).length;

		killNext(w, "mutation");
		const k2 = await run(w);
		expect(k2.signal).toBe("SIGKILL");
		expect(judgeCalls(w).length - judgedBefore).toBe(OPEN.length - cachedAfterKill); // only the uncached items are asked
		expect(lastRun(w)).toMatchObject({ runId, phase: "writing", outcome: "pending" });

		killNext(w, "comments");
		const k3 = await run(w);
		expect(k3.signal).toBe("SIGKILL");
		expect(lastRun(w)).toMatchObject({ runId, phase: "written", outcome: "succeeded", commented: false });
		expect(runComments(w, runId)).toHaveLength(0);

		killNext(w, "post");
		const k4 = await run(w);
		expect(k4.signal).toBe("SIGKILL");
		expect(lastRun(w)).toMatchObject({ runId, outcome: "succeeded", commented: false });
		expect(runComments(w, runId)).toHaveLength(1);

		const done = await run(w);
		expect(done.code).toBe(0);
		expect(done.stdout).toContain("already on thewolff/jo-issues#153");
		expect(lastRun(w)).toMatchObject({ runId, commented: true });
		expect(runComments(w, runId)).toHaveLength(1);
		expect(calls(w).filter((c) => c.kind === "issue comment")).toHaveLength(1);
		expectBoardMatches(w, runId);
		const body = runComments(w, runId)[0]!.body;
		expect(body).toContain(`**Backlog re-rank ${runId}: done**`);
		expect(body).toContain("Ranked 11 open issues: 6 in jo-issues, 5 in agent-system-2.0.");
		expect(body).toContain(`as2 backlog-rank --undo ${runFile(w, runId, "backup.json")}`);
		expect(parseCache(readFileSync(join(w.dir, "cache.jsonl"), "utf8")).entries.size).toBe(OPEN.length);
	});

	test("a lost response on the success comment: the next fire finds the marker and posts nothing", async () => {
		const w = world((s) => {
			s.commentFaults = ["lost"];
		});
		const first = await run(w);
		expect(first.code).toBe(1);
		expect(first.stderr).toMatch(/posting run .* comment on thewolff\/jo-issues#153/);
		const runId = lastRun(w).runId;
		expect(lastRun(w)).toMatchObject({ outcome: "succeeded", commented: false });
		const second = await run(w);
		expect(second.code).toBe(0);
		expect(lastRun(w)).toMatchObject({ runId, commented: true });
		expect(runComments(w, runId)).toHaveLength(1);
		expect(calls(w).filter((c) => c.kind === "issue comment")).toHaveLength(1);
	});

	test("three refused attempts abandon the run; a lost abandon comment is found, not reposted, and never turns into success", async () => {
		const w = world((s) => {
			s.commentFaults = ["lost"];
		});
		writeFileSync(join(w.dir, "pins.json"), JSON.stringify([{ repo: "jo-issues", number: 1, position: 2, why: "Jo" }, { repo: "jo-issues", number: 4, position: 2, why: "Jo" }]));
		for (const n of [1, 2]) {
			const r = await run(w);
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(`attempt ${n} of 3 failed in ranking: pins refused: jo-issues#1 and jo-issues#4 are both pinned to position 2; the next fire resumes it`);
		}
		const third = await run(w);
		expect(third.code).toBe(1);
		expect(third.stderr).toContain("attempt 3 of 3 failed in ranking");
		const runId = lastRun(w).runId;
		expect(lastRun(w)).toMatchObject({ outcome: "abandoned", commented: false, attempts: 3 });
		const fourth = await run(w);
		expect(fourth.code).toBe(0);
		expect(lastRun(w)).toMatchObject({ runId, outcome: "abandoned", commented: true });
		const posted = runComments(w, runId);
		expect(posted).toHaveLength(1);
		expect(posted[0]!.body).toContain(`**Backlog re-rank ${runId}: failed after 3 attempts**`);
		expect(posted[0]!.body).toContain("It stopped in the ranking phase, with 0 of 0 board writes done. Last error: pins refused");
		expect(judgeCalls(w)).toHaveLength(0);
		expect(mutations(w)).toHaveLength(0);
		expect((await run(w)).stdout).toContain("not due: run");
	});

	test("an unfinished run when the next day starts is resumed under its own id, then the new day's run follows", async () => {
		const w = world();
		killNext(w, "mutation");
		expect((await run(w)).signal).toBe("SIGKILL");
		const first = lastRun(w);
		expect(first).toMatchObject({ day: "2026-10-20", phase: "writing" });
		const next = await run(w, [], { AGENT_SYSTEM_BACKLOG_RANK_CLOCK: D2 });
		expect(next.code).toBe(0);
		expect(next.stdout).toContain(`resuming run ${first.runId}`);
		const second = lastRun(w);
		expect(second).toMatchObject({ day: "2026-10-21", outcome: "succeeded", commented: true });
		expect(second.runId).not.toBe(first.runId);
		expect(runComments(w, first.runId)).toHaveLength(1);
		expect(runComments(w, second.runId)).toHaveLength(1);
		expectBoardMatches(w, second.runId, "12:10 PM PDT Oct 21");
		// One token read per process: the killed one, then one for the resumed run and the new run together.
		expect(calls(w).filter((c) => c.argv[0] === "auth").map((c) => c.argv.join(" "))).toEqual(["auth token -u thewolff", "auth token -u thewolff"]);
	});
});

// ---- R7: the Jev cache --------------------------------------------------------------------------------------------

describe("R7: cached answers are reused on later days; an edit costs one call", () => {
	test("day 1 asks every item (at most 4 at a time), day 2 asks none, an edited issue on day 3 costs exactly one", async () => {
		const w = world();
		const d1 = await run(w, [], { FAKE_JUDGE_DELAY_MS: "40" });
		expect(d1.code).toBe(0);
		const asked = judgeCalls(w);
		expect(asked).toHaveLength(OPEN.length);
		expect(Math.max(...asked.map((c) => c.inFlight))).toBe(4);
		const d2 = await run(w, [], { AGENT_SYSTEM_BACKLOG_RANK_CLOCK: D2 });
		expect(d2.code).toBe(0);
		expect(lastRun(w)).toMatchObject({ day: "2026-10-21", outcome: "succeeded" });
		expect(judgeCalls(w)).toHaveLength(OPEN.length);
		expect(runComments(w, lastRun(w).runId)[0]!.body).toContain("Jev: 0 new calls, $0.0000.");
		tweakState(w, (s) => {
			s.repos[AS2]!.find((i) => i.number === 12)!.body = "Resume lanes after sleep and on wake.";
		});
		const d3 = await run(w, [], { AGENT_SYSTEM_BACKLOG_RANK_CLOCK: D3 });
		expect(d3.code).toBe(0);
		expect(judgeCalls(w)).toHaveLength(OPEN.length + 1);
		expect(judgeCalls(w).at(-1)!.item).toBe("Lane restart on wake");
		expect(runComments(w, lastRun(w).runId)[0]!.body).toContain("Jev: 1 new call, $0.0000.");
		const same = await run(w, [], { AGENT_SYSTEM_BACKLOG_RANK_CLOCK: D3 });
		expect(same.stdout).toContain("not due: run");
	});
});

// ---- R14: failures say so; no overlap -----------------------------------------------------------------------------

describe("R14: a failed attempt says so and exits non-zero; invocations never overlap", () => {
	for (const [mode, why] of [["malformed", /Jev on .*: malformed: deadline_when/], ["wrong-model", /answered by anthropic\/claude-x, not typesafe\/jev-\*/]] as const) {
		test(`a ${mode} judge answer fails the attempt before any board call`, async () => {
			const w = world();
			const r = await run(w, [], { FAKE_JUDGE_MODE: mode });
			expect(r.code).toBe(1);
			expect(r.stderr).toMatch(/^backlog-rank: run \S+ attempt 1 of 3 failed in ranking: /);
			expect(r.stderr).toMatch(why);
			expect(r.stderr.trim().split("\n")).toHaveLength(1);
			expect(calls(w).filter((c) => c.kind.startsWith("graphql"))).toHaveLength(0);
			expect(existsSync(join(w.dir, "cache.jsonl"))).toBe(false);
		});
	}

	// Real competing processes share takeLock's actual SQLite transaction. Stdin is a deterministic barrier:
	// hold before JSON publication, or after acquiring, until the test kills the process.
	function contender(w: World, name: string, unpublished = false, gated = false) {
		const marker = join(w.root, name);
		const script = `
			import { takeLock } from ${JSON.stringify(SCRIPT)};
			import { readSync, writeFileSync } from "node:fs";
			const marker = ${JSON.stringify(marker)};
			const block = () => readSync(0, Buffer.alloc(1), 0, 1, null);
			if (${gated}) { writeFileSync(marker, "ready"); block(); }
			const release = takeLock(${JSON.stringify(join(w.dir, "lock"))}, ${unpublished ? '() => { writeFileSync(marker, "unpublished"); block(); }' : "undefined"});
			writeFileSync(marker, release ? "acquired" : "busy");
			if (release) { block(); release(); }
		`;
		const child = Bun.spawn([process.execPath, "--eval", script], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
		return { child, marker };
	}

	test("a live unpublished holder excludes runners; killing it releases the mutex without trusting JSON", async () => {
		const w = world();
		const held = contender(w, "holder", true);
		try {
			await until("holder paused before JSON publication", () => existsSync(held.marker), 10_000);
			expect(readFileSync(held.marker, "utf8")).toBe("unpublished");
			expect(existsSync(join(w.dir, "lock"))).toBe(false);
			const blocked = await run(w);
			expect(blocked.code).toBe(0);
			expect(blocked.stdout).toContain("already running");
			expect(calls(w)).toHaveLength(0);
		} finally {
			held.child.kill("SIGKILL");
			await held.child.exited;
		}
		expect((await run(w)).code).toBe(0);
		expect(lastRun(w)).toMatchObject({ outcome: "succeeded", commented: true });
	});

	test("contenders racing after a killed published holder admit exactly one owner, never unlink its replacement", async () => {
		const w = world();
		const stale = contender(w, "stale");
		await until("published stale holder", () => existsSync(stale.marker), 10_000);
		stale.child.kill("SIGKILL");
		await stale.child.exited;
		const a = contender(w, "a", false, true);
		const b = contender(w, "b", false, true);
		try {
			await until("both contenders ready", () => existsSync(a.marker) && existsSync(b.marker), 10_000);
			a.child.stdin.write("g");
			b.child.stdin.write("g");
			await until("both takeover contenders", () => readFileSync(a.marker, "utf8") !== "ready" && readFileSync(b.marker, "utf8") !== "ready", 10_000);
			expect([readFileSync(a.marker, "utf8"), readFileSync(b.marker, "utf8")].sort()).toEqual(["acquired", "busy"]);
			const blocked = await run(w);
			expect(blocked.code).toBe(0);
			expect(blocked.stdout).toContain("already running");
			expect(calls(w)).toHaveLength(0);
		} finally {
			a.child.kill("SIGKILL");
			b.child.kill("SIGKILL");
			await Promise.all([a.child.exited, b.child.exited]);
		}
		expect((await run(w)).code).toBe(0);
		expect(readdirSync(join(w.dir, "runs"))).toHaveLength(1);
	});

	test("two invocations at once: the second exits 0 `already running` while the first finishes", async () => {
		const w = world();
		const first = run(w, [], { FAKE_JUDGE_DELAY_MS: "300" });
		await until("the first invocation's lock", () => existsSync(join(w.dir, "lock")), 10_000);
		const second = await run(w);
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("already running");
		expect((await first).code).toBe(0);
		expect(readdirSync(join(w.dir, "runs"))).toHaveLength(1);
	});
});

// ---- the state dir, --dry-run --------------------------------------------------------------------------------------

describe("the state dir and --dry-run", () => {
	test("no goals.md, or none with a goal line, refuses with exit 2 naming the path", async () => {
		const w = world();
		writeFileSync(join(w.dir, "goals.md"), "# Goals\nnothing here\n");
		const none = await run(w);
		expect(none.code).toBe(2);
		expect(none.stderr).toContain(`${join(w.dir, "goals.md")} has no \`goal: \` line`);
		expect(existsSync(join(w.dir, "last-run.json"))).toBe(false);
		expect(calls(w)).toHaveLength(0);
	});

	test("--dry-run ranks and shows the diff with no GitHub write, no comment and no state but the cache", async () => {
		const w = world();
		const r = await run(w, ["--dry-run"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/board diff: 7 adds, 1 deletes, \d+ updates, in \d+ requests \(not written\)/);
		expect(r.stdout).toContain("delete jo-issues#7 (closed)");
		expect(mutations(w)).toHaveLength(0);
		expect(calls(w).filter((c) => c.kind === "issue comment" || c.kind === "api comments")).toHaveLength(0);
		expect(readdirSync(w.dir).sort()).toEqual(["cache.jsonl", "goals.md", "lock.sqlite"]);
	});
});
