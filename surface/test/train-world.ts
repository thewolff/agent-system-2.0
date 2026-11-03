// The merge train tick's test world, shared by train-tick.test.ts and train-escalation.test.ts: a fake gh (PR views, push
// activity, main's rules, compares, jo-issues issues), a train with its owner (`world`), and a boarding world on the standing
// workload with the test runner serving REPO (`boardWorld`, PLAN wl-mvbjiettjrfpxc D1-D7). Temp ledgers and temp git checkouts
// with a fake GitHub origin only.
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLoopEndBody, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { type GhResult, tick } from "../scripts/train-tick";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { applyTrain, interpret } from "../src/input";
import { decideLaunch, landFirstBody, landFirstInstructionBody, laneReadyBody, parseTrainBoard } from "../src/launch";
import { recordTrainTask, TRAIN_ALERT_REPO, type TrainTask } from "../src/merge-train";
import { type ExecCounts, makeRunId, testRequestedBody, type TestRun, testRunBody } from "../src/test-run";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

export const REPO = "thewolff/product";
export const TRAIN_LANE = "lane-train-1";
export const OWNER_LANE = "lane-owner-1";
export const JO = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
export const H0 = "a".repeat(40);
export const H1 = "b".repeat(40);
export const H2 = "c".repeat(40);

/** Jo's land-first instruction and the surface row that binds it. */
export function landFirst(ledger: Ledger, repo: string, on: boolean): void {
	ensureStandingWorkload(ledger);
	const id = ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(repo, on) });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(repo, on, id) });
}

/** A believable main verdict, matching lane-tools.test.ts's verified-root fixture. */
export function mainRun(ledger: Ledger, runId: string, sha: string, verdict: "green" | "red", o: { exec?: ExecCounts; by?: string } = {}): void {
	ensureStandingWorkload(ledger);
	const red = verdict === "red";
	ledger.recordEntry({
		by: o.by ?? TEST_RUNNER_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption",
		body: testRunBody({
			runId, verdict, sha, pr: 0, reason: null, headAtEnd: sha, base: null, mergeBase: null,
			full: { pass: 400, fail: red ? 1 : 0, skip: 0, exit: red ? 1 : 0, ms: 900, error: null }, solo: [],
			failures: red ? [{ part: "full", name: "x.test.ts > broken", firstError: "error: nope" }] : [], runDir: `/runs/${runId}`, preflight: "ok",
			scope: "full", main: true, host: "mac", exec: o.exec ?? { files: 40, tests: 400, treeFiles: 40 },
		}),
	});
}

export function checkout(): string {
	const dir = tmp("train-tick-repo");
	for (const args of [["init", "-q"], ["config", "remote.origin.url", `https://github.com/${REPO}.git`]]) {
		const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	}
	return dir;
}

export interface FakeIssue {
	number: number;
	url: string;
	title: string;
	body: string;
	state: "OPEN" | "CLOSED";
	labels: string[];
	comments: string[];
	/** The `--comment` the issue was closed with. */
	closedWith?: string | null;
}

/** One push to a branch as GitHub's repository activity lists it. */
interface FakeActivity {
	before: string;
	after: string;
	ref: string;
	timestamp: string;
	activity_type: string;
}

/** One file of a commit as GitHub's get-a-commit lists it (a diff entry); a rename carries the path it came from. */
export interface FakeDiffEntry {
	filename: string;
	status: string;
	previous_filename?: string;
}
/** Files per page of GitHub's get-a-commit listing, and the most it lists across pages. */
export const COMMIT_FILES_PER_PAGE = 300;
export const COMMIT_FILES_CAP = 3000;

/**
 * gh as the tick calls it: PR views from `prs`, GitHub's push activity per branch from `activity`, and an issue tracker for
 * jo-issues. Listings are newest first and paged as GitHub pages them: `gh issue list` stops at `--limit`, `gh api` returns the
 * first page of `per_page`, or every page with `--paginate` (an array of pages with `--slurp`). `fail` makes a matching call exit 1.
 * For boarding and main's protection (PLAN wl-mvbjiettjrfpxc D1, D6): a PR's state, base, draft flag and fork flag; main's rules
 * (`rules`, protected unless set; null answers 404) and ruleset 1's bypass; `compares`
 * by `<base>...<head>`, each commit a sha (one parent) or `{ sha, parents }` (a merge has two), and each commit's files (a path,
 * or a diff entry with `status` and `previous_filename`), listed as GitHub
 * lists them: COMMIT_FILES_PER_PAGE per page, each page the commit object again, at most COMMIT_FILES_CAP in all. `saved` answers a
 * `gh api <path>` with a saved GitHub answer as given (surface/test/fixtures/train-carry-305/), before any of the above.
 */
export function fakeGh() {
	const prs = new Map<number, { head: string; branch: string; state?: string; base?: string; draft?: boolean; fork?: boolean }>();
	const activity: FakeActivity[] = [];
	const issues: FakeIssue[] = [];
	const calls: string[][] = [];
	const compares = new Map<string, { status: string; commits: (string | { sha: string; parents: number })[] }>();
	const commitFiles = new Map<string, (string | FakeDiffEntry)[]>();
	const saved = new Map<string, unknown>();
	/** Issues on REPO itself (a holder's main-red issue), by number. */
	const repoIssues = new Map<number, "OPEN" | "CLOSED">();
	const main: { rules: unknown; bypass: string } = { rules: protectedRules(), bypass: "never" };
	let fail: ((args: string[]) => boolean) | null = null;
	const ok = (stdout: unknown): GhResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
	const flag = (args: string[], name: string) => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1]! : null;
	};
	/** `gh api`'s `-f key=value` fields. */
	const fields = (args: string[]) => new Map(args.flatMap((a, i) => (args[i - 1] === "-f" ? [a.split("=", 2) as [string, string]] : [])));
	const paged = (args: string[], items: unknown[]): GhResult => {
		const per = Number(fields(args).get("per_page") ?? 30);
		const pages: unknown[][] = [];
		for (let i = 0; i === 0 || i < items.length; i += per) pages.push(items.slice(i, i + per));
		if (!args.includes("--paginate")) return ok(pages[0]);
		return args.includes("--slurp") ? ok(pages) : ok(pages.map((p) => JSON.stringify(p)).join(""));
	};
	const issue = (args: string[]) => issues.find((i) => i.number === Number(args[2]))!;
	const gh = (args: string[]): GhResult => {
		calls.push(args);
		if (fail?.(args)) return { code: 1, stdout: "", stderr: "HTTP 502" };
		const [noun, verb] = args;
		if (noun === "api" && saved.has(verb!)) return ok(saved.get(verb!));
		if (noun === "pr" && verb === "view") {
			const n = Number(args[2]);
			const p = prs.get(n);
			if (!p) return { code: 1, stdout: "", stderr: `no pull request ${n}` };
			return ok({
				number: n, headRefName: p.branch, headRefOid: p.head, isCrossRepository: p.fork ?? false, headRepository: { name: "product" },
				headRepositoryOwner: { login: p.fork ? "someone" : "thewolff" }, state: p.state ?? "OPEN", body: "", mergedAt: null, baseRefName: p.base ?? "main", isDraft: p.draft ?? false,
			});
		}
		if (noun === "api" && verb === `repos/${REPO}/rules/branches/main`) {
			return main.rules === null ? { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" } : ok(main.rules);
		}
		if (noun === "api" && verb === `repos/${REPO}/rulesets/1`) return ok({ id: 1, current_user_can_bypass: main.bypass });
		if (noun === "api" && verb?.startsWith(`repos/${REPO}/compare/`)) {
			const c = compares.get(verb.slice(`repos/${REPO}/compare/`.length));
			if (!c) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
			const commits = c.commits.map((k) => (typeof k === "string" ? { sha: k, parents: 1 } : k));
			return ok({ status: c.status, total_commits: commits.length, commits: commits.map((k) => ({ sha: k.sha, parents: Array.from({ length: k.parents }, (_, i) => ({ sha: String(i).repeat(40) })) })) });
		}
		if (noun === "api" && verb?.startsWith(`repos/${REPO}/commits/`)) {
			const sha = verb.slice(`repos/${REPO}/commits/`.length);
			const files = commitFiles.get(sha);
			if (!files) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
			const entries = files.slice(0, COMMIT_FILES_CAP).map((f) => (typeof f === "string" ? { filename: f, status: "modified" } : f));
			const pages: unknown[] = [];
			for (let i = 0; i === 0 || i < entries.length; i += COMMIT_FILES_PER_PAGE) pages.push({ sha, files: entries.slice(i, i + COMMIT_FILES_PER_PAGE) });
			if (!args.includes("--paginate")) return ok(pages[0]);
			return args.includes("--slurp") ? ok(pages) : ok(pages.map((p) => JSON.stringify(p)).join(""));
		}
		if (noun === "api" && verb === `repos/${REPO}/activity`) {
			const ref = fields(args).get("ref");
			return paged(args, activity.filter((a) => a.ref === ref).reverse());
		}
		if (noun === "api" && verb === `repos/${TRAIN_ALERT_REPO}/issues`) {
			const label = fields(args).get("labels")!;
			return paged(args, [...issues].sort((a, b) => b.number - a.number).filter((i) => i.labels.includes(label)).map((i) => ({ number: i.number, html_url: i.url, body: i.body, labels: i.labels.map((name) => ({ name })) })));
		}
		if (noun === "issue" && verb === "list") {
			const listed = [...issues].sort((a, b) => b.number - a.number).filter((i) => i.labels.includes(flag(args, "--label")!)).slice(0, Number(flag(args, "--limit") ?? 30));
			return ok(listed.map((i) => ({ number: i.number, url: i.url, body: i.body })));
		}
		if (noun === "issue" && verb === "create") {
			const number = issues.length + 1;
			const url = `https://github.com/${TRAIN_ALERT_REPO}/issues/${number}`;
			issues.push({ number, url, title: flag(args, "--title")!, body: flag(args, "--body")!, state: "OPEN", labels: [flag(args, "--label")!], comments: [] });
			return ok(`${url}\n`);
		}
		if (noun === "issue" && verb === "view" && flag(args, "-R") === REPO) {
			const state = repoIssues.get(Number(args[2]));
			return state ? ok({ state }) : { code: 1, stdout: "", stderr: `no issue ${args[2]}` };
		}
		if (noun === "issue" && verb === "view") {
			const i = issue(args);
			return ok({ state: i.state, comments: i.comments.map((body) => ({ body })) });
		}
		if (noun === "issue" && verb === "comment") {
			issue(args).comments.push(flag(args, "--body")!);
			return ok("");
		}
		if (noun === "issue" && verb === "edit") {
			const i = issue(args);
			for (const l of flag(args, "--add-label")!.split(",")) if (!i.labels.includes(l)) i.labels.push(l);
			return ok("");
		}
		if (noun === "issue" && verb === "close") {
			const i = issue(args);
			i.state = "CLOSED";
			i.closedWith = flag(args, "--comment");
			return ok("");
		}
		return { code: 1, stdout: "", stderr: `fake gh: unexpected ${args.join(" ")}` };
	};
	/** GitHub records a push of `sha` to `branch` at `at`. */
	const pushed = (branch: string, sha: string, at: string) => {
		const before = activity.filter((a) => a.ref === `refs/heads/${branch}`).at(-1)?.after ?? "0".repeat(40);
		activity.push({ before, after: sha, ref: `refs/heads/${branch}`, timestamp: at, activity_type: "push" });
	};
	return { gh, prs, activity, pushed, issues, repoIssues, calls, compares, commitFiles, saved, main, failWhen: (f: ((args: string[]) => boolean) | null) => { fail = f; } };
}

/** Main's rules as `gh api repos/<repo>/rules/branches/main` answers for a protected main: a strict as2/full-suite check in ruleset 1. */
export function protectedRules(strict = true): unknown[] {
	return [{ type: "required_status_checks", ruleset_id: 1, parameters: { strict_required_status_checks_policy: strict, required_status_checks: [{ context: "as2/full-suite" }] } }];
}

/**
 * The fake launcher's reservation: lane.ts launch's (decideLaunch consumes the request), with no process behind the lane, and
 * the runner's `lane-ready:` at once, so the lane counts as having had its first prompt (PLAN wl-mvpsrr4tr0p1xc D2: only a
 * ready lane's exit ends the train's work, and only never-ready launches count toward the launch limit).
 */
export function launchReady(ledger: Ledger, wl: string): { code: number; line: string } {
	const r = ledger.reserveLane(wl, { by: LANE_STARTER_BY, cap: 10, leaseMs: 60_000, requestedBy: MERGE_TRAIN_BY, decide: decideLaunch });
	if (!r.ok) return { code: 1, line: r.reason };
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneReadyBody(r.laneId, ledger.now()) });
	return { code: 0, line: `launched ${r.laneId}` };
}

/** A train on `prs` (#101 and #106 by default) held by TRAIN_LANE, the autonomous owner of #101, a fake gh and launcher, on one ledger with a settable clock. */
export function world(prs: readonly number[] = [101, 106]) {
	const c = clock();
	const { ledger } = tempLedger(c.now);
	const trainCheckout = checkout();
	const cmd = interpret(ledger, `train ${prs.join(" ")}`);
	if (cmd?.kind !== "train") throw new Error("not a train");
	const train = applyTrain(ledger, cmd, trainCheckout).workloadId;
	expect(ledger.claimWorkload(train, { by: LANE_STARTER_BY, holder: TRAIN_LANE, leaseMs: 600_000 }).won).toBe(true);
	const owner = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
	recordRepo(ledger, owner, checkout());
	const branch = `wl/${owner}`;
	const g = fakeGh();
	g.prs.set(101, { head: H0, branch });
	g.prs.set(106, { head: H0, branch: "feature/other" });
	const launches: string[] = [];
	const notes: string[] = [];
	/** The fake launcher (`launchReady`). */
	const launch = (wl: string) => {
		launches.push(wl);
		return launchReady(ledger, wl);
	};
	const run = () => tick({ ledger, gh: g.gh, launch, notify: (_t, text) => { notes.push(text); return true; } });
	/** The train lane's lane_train_return for PR `pr` at the fake PR's current head. */
	const task = (pr: number, kind: TrainTask["kind"] = "red"): TrainTask => {
		const p = g.prs.get(pr)!;
		const view = { number: pr, headRefName: p.branch, headRefOid: p.head, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" } };
		const r = recordTrainTask(ledger, { train, by: TRAIN_LANE, pr, kind, detail: `run tr-x red at ${p.head}\nsrc/x.test.ts > case 1: boom`, view, trainRepo: REPO });
		if (!r.ok) throw new Error(r.reason);
		return r.task;
	};
	let seq = 0;
	/** A runner request and result on the owner for PR `pr` at `sha`. */
	const result = (pr: number, sha: string, verdict: TestRun["verdict"]) => {
		const slice = ledger.addSlice({ by: OWNER_LANE, workloadId: owner, task: `suite #${pr}`, doneCondition: "green", inputs: `#${pr}` });
		const runId = makeRunId(Date.parse(c.now()) + ++seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: owner, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice, by: OWNER_LANE }) });
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: owner, sliceId: slice, kind: "assumption",
			body: testRunBody({
				runId, verdict, sha, pr, reason: null, headAtEnd: sha, base: null, mergeBase: null,
				full: { pass: 1, fail: verdict === "red" ? 1 : 0, skip: 0, exit: verdict === "red" ? 1 : 0, ms: 10, error: null },
				solo: [], failures: verdict === "red" ? [{ part: "full", name: "src/x.test.ts > case 1", firstError: "boom" }] : [], runDir: null, preflight: null,
			}),
		});
	};
	/** The owner pushes `sha` to PR `pr` (GitHub records it now) and its run there comes back `verdict`. */
	const push = (pr: number, sha: string, verdict: TestRun["verdict"]) => {
		const p = g.prs.get(pr)!;
		p.head = sha;
		g.pushed(p.branch, sha, c.now());
		result(pr, sha, verdict);
	};
	const settles = () => ledger.entries(train).filter((e) => e.created_by === MERGE_TRAIN_BY && e.body.startsWith("train-task-settled:"));
	const creates = () => g.calls.filter((a) => a[0] === "issue" && a[1] === "create");
	/** Attempts 1 and 2 on #101 both settled failed: the tick has raised the alert and filed its issue. */
	const failTwice = () => {
		task(101);
		c.plusHours(0.05);
		push(101, H1, "red");
		run();
		task(101);
		c.plusHours(0.05);
		push(101, H2, "red");
		return run();
	};
	return { c, ledger, train, owner, g, launches, notes, run, task, push, settles, creates, failTwice };
}

/** The test runner's config serving REPO, as the tick reads `testRunner.repos`. */
export const SERVED = { repos: [{ origin: REPO, command: "bun test" }] };
/** A decision-log file, the only path a commit after the green sha may touch (D1). */
export const DECISION_LOG_FILE = ".ai/decision-log/2026-10-01--1000--jev--fix-the-header.md";

/**
 * The #305 shape (PLAN wl-mvpwkpqobyp20w § 1): the green at `green` (aebe37a4), one decision-log commit `head` (cde03460) on it,
 * and GitHub's compare and get-a-commit answers for the two as saved, trimmed to the fields read
 * (surface/test/fixtures/train-carry-305/), by `gh api` path on `repo`.
 */
export function carry305(repo = REPO) {
	const dir = join(import.meta.dir, "fixtures", "train-carry-305");
	const green = "aebe37a45247466e96a200974cecfc6662efa84d";
	const head = "cde03460fd84af134cf591abf7c6dcb0d27f86b6";
	const answers: Record<string, unknown> = {
		[`repos/${repo}/compare/${green}...${head}`]: JSON.parse(readFileSync(join(dir, "compare.json"), "utf8")),
		[`repos/${repo}/commits/${head}`]: JSON.parse(readFileSync(join(dir, "commit-cde03460.json"), "utf8")),
	};
	return { green, head, answers };
}

/**
 * The boarding world (PLAN wl-mvbjiettjrfpxc D1-D7): the standing workload, a served checkout of REPO, a fake gh and launcher,
 * and a first tick already run (the cutover). `landing(pr)` leaves a lane workload W as an autonomous normal lane finishes:
 * a green full suite at `o.sha` (H0 by default) on PR `pr`, a passed review, done-because, released and closed; its PR is OPEN
 * at that sha on `wl/<W>`.
 */
export function boardWorld() {
	const c = clock();
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	const repo = checkout();
	const g = fakeGh();
	const launches: string[] = [];
	const logs: string[] = [];
	const launch = (wl: string) => {
		launches.push(wl);
		return launchReady(ledger, wl);
	};
	const run = () => tick({ ledger, gh: g.gh, launch, notify: () => true, log: (l) => logs.push(l), config: SERVED });
	c.plusHours(0.01);
	run();
	c.plusHours(0.01);
	let seq = 0;
	/** `o.entries`: assumption entries written on W right after its `repo:`, while it is open (a `plan:` row, say). */
	const landing = (pr: number, o: { stakes?: "normal" | "production"; entries?: { by: string; body: string }[]; sha?: string } = {}): string => {
		const sha = o.sha ?? H0;
		const holder = `lane-l-${++seq}`;
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: `Fix the header (#${pr})`, stakes: o.stakes ?? "normal", mode: "autonomous" });
		recordRepo(ledger, wl, repo);
		for (const e of o.entries ?? []) ledger.recordEntry({ by: e.by, workloadId: wl, kind: "assumption", body: e.body });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder, leaseMs: 600_000 }).won).toBe(true);
		const sl = ledger.addSlice({ by: holder, workloadId: wl, task: "change", doneCondition: "tests pass", inputs: "src" });
		const runId = makeRunId(Date.parse(c.now()) + seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice: sl, by: holder }) });
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption",
			body: testRunBody({
				runId, verdict: "green", sha, pr, reason: null, headAtEnd: sha, base: null, mergeBase: null,
				full: { pass: 1, fail: 0, skip: 0, exit: 0, ms: 10, error: null }, solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
		ledger.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewRoundBody({ slice: sl, round: 1, token: `dt-${seq}`, group: `dg-${seq}`, verdict: "accepted", findings: UNKNOWN }) });
		ledger.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLoopEndBody(sl, "pass") });
		ledger.completeSlice(sl, { by: holder, artifact: "done" });
		c.plusHours(0.01);
		ledger.recordEntry({ by: holder, workloadId: wl, kind: "assumption", body: "done-because: the header is fixed" });
		ledger.releaseWorkload(wl, { by: holder, holder });
		ledger.closeWorkload(wl, { by: SURFACE_BY });
		g.prs.set(pr, { head: sha, branch: `wl/${wl}` });
		c.plusHours(0.01);
		return wl;
	};
	const standing = (prefix: string) => ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.created_by === MERGE_TRAIN_BY && e.body.startsWith(prefix)).map((e) => e.body);
	const skips = () => standing("train-board-skip:");
	/** Every board the tick wrote, in entry order: the train, the PR, W and the head. */
	const boards = () => ledger.db.query<{ workload_id: string; body: string }, []>(
		`SELECT workload_id, body FROM entries WHERE body LIKE 'train-board:%' ORDER BY created_at, rowid`,
	).all().map((r) => ({ train: r.workload_id, ...parseTrainBoard(r.body.slice("train-board:".length).trim())! }));
	/** The `gh pr view` calls for PR `pr` so far. */
	const views = (pr: number) => g.calls.filter((a) => a[0] === "pr" && a[1] === "view" && a[2] === String(pr)).length;
	const creates = () => g.calls.filter((a) => a[0] === "issue" && a[1] === "create");
	return { c, ledger, repo, g, launches, logs, run, landing, standing, skips, boards, views, creates };
}
