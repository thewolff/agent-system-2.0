// The close check (MIGRATION.md item 24, PLAN § 2.4 item 4; surface/src/close-entry.ts `closeCheck`,
// surface/extensions/workload.ts): for a repo the test runner serves, the close needs an
// authoritative green at every open or merged PR head in the workload's set, the local wl/<id> tip
// (the pinned candidate C) covered by a green from wl/<id> when it carries code, and it fails closed
// when git or gh cannot answer; a doc-merge green holds only when its basis, its parents and the
// merged main re-check (plan wl-mv615mkeaf1yio § 3). Real git on a bare origin that
// `https://github.com/example/repo.git` resolves to through `url.<bare>.insteadOf` (so the origin URL
// names a served `owner/repo` while every fetch and push stays local), a fake `gh` first on PATH that
// records its argv and answers `pr list --state all` per head branch from `prs/<branch>.json`, and a
// testRunner config through `$AGENT_SYSTEM_TEST_RUNNER_CONFIG`.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { closeWorkloadWithEntry } from "../extensions/workload";
import { landedChain, TEST_RUNNER_CONFIG_ENV } from "../src/close-entry";
import { testBatchCreditBody, testBatchRunBody } from "../src/test-batch";
import { recordRepo } from "../src/decision-log";
import { branchName, worktreePath } from "../src/launch";
import { type RunBasis, testRequestedBody, type TestRun, testRunBody, type TestVerdict } from "../src/test-run";
import { SURFACE_BY, type SurfaceAPI } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const ORIGIN_URL = "https://github.com/example/repo.git";
const OWNER_REPO = "example/repo";
const PR_URL = "https://github.com/example/repo/pull/7";
const GH = `#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$*" >> "$dir/gh.log"
if [ -f "$dir/fail" ]; then echo "gh: not logged in" >&2; exit 1; fi
head=""; state=""; prev=""
for a in "$@"; do
  case "$prev" in --head) head="$a" ;; --state) state="$a" ;; esac
  prev="$a"
done
case "$1 $2" in
  "pr list")
    if [ "$state" = "all" ]; then
      f="$dir/prs/$(printf '%s' "$head" | tr '/' '_').json"
      if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi
    elif [ -f "$dir/open-pr" ]; then printf '[{"url":"%s"}]\\n' "$(cat "$dir/open-pr")"; else echo '[]'; fi ;;
  "pr view") f="$dir/view-$3.json"; if [ -f "$f" ]; then cat "$f"; else echo "no pull requests found" >&2; exit 1; fi ;;
  "pr create") echo "${PR_URL}" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`;

interface World {
	root: string;
	work: string;
	origin: string;
	bin: string;
	config: string;
	env: Record<string, string>;
}

/** A canonical scratch root with the fake `gh`, a served config, and git isolated from the machine's config. */
function world(served = OWNER_REPO): World {
	const root = realpathSync(tmp("close-fresh"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(join(bin, "prs"), { recursive: true });
	writeFileSync(join(bin, "gh"), GH);
	chmodSync(join(bin, "gh"), 0o755);
	const origin = join(root, "origin.git");
	writeFileSync(join(root, "gitconfig"), `[url "${origin}"]\n\tinsteadOf = ${ORIGIN_URL}\n`);
	const config = join(root, "config.yml");
	writeFileSync(config, `setupVersion: 2\ntestRunner:\n  repos:\n    - origin: ${served}\n      command: bun test\n`);
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
	};
	return { root, work: join(root, "work"), origin, bin, config, env };
}

function sh(w: World, cwd: string, cmd: string[]): { code: number; out: string; err: string } {
	const r = Bun.spawnSync(cmd, { cwd, env: w.env, stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
/** git in `cwd`; throws on failure. */
function g(w: World, cwd: string, ...args: string[]): string {
	const r = sh(w, cwd, ["git", ...args]);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.err}`);
	return r.out;
}
function commitFile(w: World, cwd: string, file: string, msg: string): string {
	mkdirSync(join(cwd, file, ".."), { recursive: true });
	writeFileSync(join(cwd, file), `${msg}\n`);
	g(w, cwd, "add", file);
	g(w, cwd, "commit", "-q", "-m", msg);
	return g(w, cwd, "rev-parse", "HEAD");
}

/** The bare origin plus a clone on main whose origin URL is the served GitHub URL; origin/HEAD recorded. */
function withOrigin(w: World): void {
	g(w, w.root, "init", "-q", "--bare", "-b", "main", w.origin);
	mkdirSync(w.work);
	g(w, w.work, "init", "-q", "-b", "main");
	g(w, w.work, "remote", "add", "origin", ORIGIN_URL);
	commitFile(w, w.work, "a.txt", "init");
	g(w, w.work, "push", "-q", "origin", "main");
	g(w, w.work, "fetch", "-q", "origin");
	g(w, w.work, "remote", "set-head", "origin", "main");
}

/** The surface's API as the close uses it; `before` sees every call first (a race injected mid-close). */
function piOf(w: World, o: { exec?: boolean; before?: (command: string, args: string[]) => void } = {}): SurfaceAPI {
	const exec = async (command: string, args: string[], opts?: { timeout?: number; cwd?: string }) => {
		o.before?.(command, args);
		const r = Bun.spawnSync([command, ...args], { cwd: opts?.cwd ?? w.root, env: w.env, stdout: "pipe", stderr: "pipe", ...(opts?.timeout ? { timeout: opts.timeout } : {}) });
		return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode ?? -1, killed: "exitedDueToTimeout" in r && r.exitedDueToTimeout === true };
	};
	return { appendEntry: () => {}, ...(o.exec === false ? {} : { exec }) } as unknown as SurfaceAPI;
}

interface Closable {
	ledger: Ledger;
	wl: string;
	branch: string;
	now: () => string;
	tick: () => void;
}
/** A released workload ready to close (no done: line, no slices) on the world's clone. */
function closable(w: World): Closable {
	const c = clock("2026-10-08T10:00:00.000Z");
	const { ledger } = tempLedger(c.now);
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	recordRepo(ledger, wl, w.work);
	return { ledger, wl, branch: branchName(wl), now: c.now, tick: () => c.plusHours(0.01) };
}
const close = (w: World, x: Closable, pi: SurfaceAPI = piOf(w), receipt: string | null = null) =>
	closeWorkloadWithEntry(pi, x.ledger, { [TEST_RUNNER_CONFIG_ENV]: w.config }, x.wl, { now: x.now(), cwd: w.work, receipt });
const receipts = (x: Closable): string[] => x.ledger.instructions(x.wl).map((i) => i.body).filter((b) => b.startsWith("close receipt:"));
/** A commit in `cwd` that undoes `file`'s last commit (a revert by hand: the file is removed). */
function removeFile(w: World, cwd: string, file: string, msg: string): string {
	g(w, cwd, "rm", "-q", file);
	g(w, cwd, "commit", "-q", "-m", msg);
	return g(w, cwd, "rev-parse", "HEAD");
}

/** The lane's worktree on wl/<id>, cut from origin/main, with one code commit pushed. */
function laneWithCode(w: World, x: Closable): { lane: string; sha: string } {
	const lane = worktreePath(w.work, x.wl);
	g(w, w.work, "worktree", "add", "-q", "-b", x.branch, lane, "origin/main");
	const sha = commitFile(w, lane, "b.txt", "the lane's change");
	g(w, lane, "push", "-q", "-u", "origin", x.branch);
	return { lane, sha };
}

/** What `gh pr list -R example/repo --head <branch> --state all` prints. */
function prs(w: World, branch: string, list: { number: number; state: "OPEN" | "MERGED" | "CLOSED"; headRefOid: string }[]): void {
	writeFileSync(join(w.bin, "prs", `${branch.replaceAll("/", "_")}.json`), JSON.stringify(list));
}
/** The runner's `test-requested:` entry, as the starter writes it. */
function requested(x: Closable, runId: string, pr: number, sha: string): void {
	x.tick();
	x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: x.wl, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice: "sl-full-1", by: "lane-a" }) });
}
/** The runner's `test-run:` entry for a request; `over` makes it, for one, a doc-merge run. */
function ran(x: Closable, runId: string, pr: number, sha: string, verdict: TestVerdict, over: Partial<TestRun> = {}): void {
	x.tick();
	const red = verdict === "red";
	x.ledger.recordEntry({
		by: TEST_RUNNER_BY, workloadId: x.wl, kind: "assumption",
		body: testRunBody({
			runId, verdict, sha, pr, reason: verdict === "superseded" ? "a newer request owns the slice" : null, headAtEnd: sha, base: null, mergeBase: null,
			full: { pass: 3, fail: red ? 1 : 0, skip: 0, exit: red ? 1 : 0, ms: 900, error: null }, solo: [],
			failures: red ? [{ part: "full", name: "x.test.ts > broken", firstError: "error: nope" }] : [], runDir: `/runs/${runId}`, preflight: "ok",
			mode: "full", basis: null, merge: null, ...over,
		}),
	});
}

const ghCalls = (w: World): string[] => (existsSync(join(w.bin, "gh.log")) ? readFileSync(join(w.bin, "gh.log"), "utf8").trim().split("\n") : []);
const listAll = (branch: string) => `pr list -R ${OWNER_REPO} --head ${branch} --state all --json number,state,headRefOid`;
const remoteSha = (w: World, branch: string): string => g(w, w.work, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] ?? "";
const s7 = (sha: string) => sha.slice(0, 7);
/** What the red-run refusal adds for an open PR (PLAN wl-mv5i3lulwwbbi8 D3: it names the waive path). */
const OPEN_RED = ": fix it and call lane_full_test (a waiver passes only a merged PR)";

/** The close was refused: the row is open, nothing was committed on the branch or pushed. */
function expectRefused(w: World, x: Closable, r: { closed: boolean; text: string }, reason: string, tip: string | null): void {
	expect(r.closed).toBe(false);
	expect(r.text).toBe(`${x.wl} cannot close: ${reason}`);
	expect(x.ledger.workload(x.wl)!.status).toBe("open");
	if (tip !== null) expect(g(w, w.work, "rev-parse", x.branch)).toBe(tip);
	expect(ghCalls(w).some((c) => c.startsWith("pr create") || c.includes("--state open"))).toBe(false);
}

/** The close published D on C: D's only parent is C, it touches only .ai/decision-log/, and origin's wl/<id> is D. */
function expectPublishedOn(w: World, x: Closable, c: string): string {
	const d = g(w, w.work, "rev-parse", x.branch);
	expect(g(w, w.work, "rev-list", "--parents", "-n", "1", d)).toBe(`${d} ${c}`);
	expect(g(w, w.work, "diff-tree", "-r", "--no-commit-id", "--name-only", c, d)).toMatch(/^\.ai\/decision-log\/[^\n]+\.md$/);
	expect(remoteSha(w, x.branch)).toBe(d);
	return d;
}

describe("close check: a served repo's close needs a green at every PR head and on the candidate (PLAN § 2.4 item 4)", () => {
	test("green at head closes: D is committed on the pinned C and pushed by sha; every gh call names the repo", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		writeFileSync(join(w.bin, "open-pr"), PR_URL);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toEndWith(`; pushed to origin; PR open: ${PR_URL}. Close check: every PR in the set is green at its head and covers ${s7(s)}.`);
		expect(r.details).toMatchObject({ commit: null, push: null, pr: PR_URL, check: `every PR in the set is green at its head and covers ${s7(s)}` });
		expectPublishedOn(w, x, s);
		expect(ghCalls(w)).toEqual([listAll(x.branch), `pr list -R ${OWNER_REPO} --head ${x.branch} --state open --json url`]);
		expect(x.ledger.workload(x.wl)!.status).toBe("closed");
	});

	test("head ahead of the green only by .ai/decision-log/ closes", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { lane, sha: s } = laneWithCode(w, x);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		const y = commitFile(w, lane, ".ai/decision-log/2026-10-08--0900--lane--note.md", "a decision-log note");
		g(w, lane, "push", "-q", "origin", x.branch);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: y }]);

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain(`Close check: every PR in the set is green at its head and covers ${s7(y)}.`);
		expectPublishedOn(w, x, y);
	});

	test("head ahead of the green by code refuses, naming the file", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { lane, sha: s } = laneWithCode(w, x);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		const z = commitFile(w, lane, "c.txt", "more code after the green");
		g(w, lane, "push", "-q", "origin", x.branch);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: z }]);

		const r = await close(w, x);

		expectRefused(w, x, r, `PR #7's head ${s7(z)} is not the green ${s7(s)}: commit ${s7(z)} changes c.txt; call lane_full_test`, z);
		expect(remoteSha(w, x.branch)).toBe(z);
	});

	test("review r1 B3: a code commit and its revert after the green refuse, though the head's tree equals the green's", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { lane, sha: s } = laneWithCode(w, x);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		commitFile(w, lane, "c.txt", "code after the green");
		const v = removeFile(w, lane, "c.txt", "revert the code");
		expect(g(w, lane, "rev-parse", `${v}^{tree}`)).toBe(g(w, lane, "rev-parse", `${s}^{tree}`));
		g(w, lane, "push", "-q", "origin", x.branch);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: v }]);

		const r = await close(w, x, piOf(w), "shipped");

		expectRefused(w, x, r, `PR #7's head ${s7(v)} is not the green ${s7(s)}: commit ${s7(v)} changes c.txt; call lane_full_test`, v);
		expect(remoteSha(w, x.branch)).toBe(v);
		expect(receipts(x)).toEqual([]);
	});

	test("review r1 B3: the same revert pair on the local candidate only is an untested commit", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { lane, sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		commitFile(w, lane, "c.txt", "local code after the green");
		const v = removeFile(w, lane, "c.txt", "revert the local code");

		expectRefused(w, x, await close(w, x), `local ${x.branch} has untested commit ${s7(v)}`, v);
		expect(remoteSha(w, x.branch)).toBe(s);
	});

	test("a chain of decision-log-only commits after the green closes, an empty commit included; the entry carries the receipt", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { lane, sha: s } = laneWithCode(w, x);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		commitFile(w, lane, ".ai/decision-log/2026-10-08--0900--lane--one.md", "a decision-log note");
		g(w, lane, "commit", "-q", "--allow-empty", "-m", "an empty commit");
		const y = commitFile(w, lane, ".ai/decision-log/2026-10-08--0910--lane--two.md", "another decision-log note");
		g(w, lane, "push", "-q", "origin", x.branch);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: y }]);

		const r = await close(w, x, piOf(w), "shipped");

		expect(r.closed).toBe(true);
		const d = expectPublishedOn(w, x, y);
		const file = g(w, w.work, "diff-tree", "-r", "--no-commit-id", "--name-only", y, d);
		expect(g(w, w.work, "show", `${d}:${file}`)).toContain("- orchestrator (surface): close receipt: shipped");
		expect(receipts(x)).toEqual(["close receipt: shipped"]);
	});

	test("a newer red supersedes an older green", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		requested(x, "tr-2", 7, s);
		ran(x, "tr-2", 7, s, "red");

		expectRefused(w, x, await close(w, x), `PR #7's newest test-run tr-2 is red${OPEN_RED}`, s);
	});

	test("a late superseded from a displaced run does not override the newer green", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		requested(x, "tr-2", 7, s);
		ran(x, "tr-2", 7, s, "green");
		ran(x, "tr-1", 7, s, "superseded");

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expectPublishedOn(w, x, s);
	});

	test("no PR with a code delta refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);

		expectRefused(w, x, await close(w, x), `${x.branch} changes b.txt but has no PR: push and open the PR, then lane_full_test`, s);
		expect(ghCalls(w)).toEqual([listAll(x.branch)]);
	});

	test("a PR closed without merge, with a code delta, refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "CLOSED", headRefOid: s }]);

		expectRefused(w, x, await close(w, x), "PR #7 is closed; reopen it, or reset the branch", s);
	});

	test("an empty PR set with no code delta closes (an investigation): the branch is cut from origin/main and D pushed on it", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const main = g(w, w.work, "rev-parse", "origin/main");

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toEndWith(`PR opened: ${PR_URL}. Close check: no PR and no code delta.`);
		expectPublishedOn(w, x, main);
		const calls = ghCalls(w);
		expect(calls.slice(0, 2)).toEqual([listAll(x.branch), `pr list -R ${OWNER_REPO} --head ${x.branch} --state open --json url`]);
		expect(calls[2]!.startsWith(`pr create -R ${OWNER_REPO} --head ${x.branch} --base main --title `)).toBe(true);
	});

	test("a merged PR is checked at its final head, fetched through refs/pull/<N>/head when the clone lacks it", async () => {
		for (const [file, closes] of [[".ai/decision-log/2026-10-08--0930--lane--merged.md", true], ["d.txt", false]] as const) {
			const w = world();
			withOrigin(w);
			const x = closable(w);
			const { sha: s } = laneWithCode(w, x);
			requested(x, "tr-1", 7, s);
			ran(x, "tr-1", 7, s, "green");
			// the final head exists only on GitHub's PR ref: made in another clone, pushed to refs/pull/7/head alone
			const other = join(w.root, "other");
			g(w, w.root, "clone", "-q", ORIGIN_URL, other);
			g(w, other, "checkout", "-q", s);
			const m = commitFile(w, other, file, "the PR's last commit before merge");
			g(w, other, "push", "-q", "origin", `${m}:refs/pull/7/head`);
			expect(sh(w, w.work, ["git", "cat-file", "-e", `${m}^{commit}`]).code).not.toBe(0);
			prs(w, x.branch, [{ number: 7, state: "MERGED", headRefOid: m }]);

			const r = await close(w, x);

			if (closes) {
				expect(r.closed).toBe(true);
				expectPublishedOn(w, x, s);
			} else {
				expectRefused(w, x, r, `PR #7's head ${s7(m)} is not the green ${s7(s)}: commit ${s7(m)} changes d.txt; call lane_full_test`, s);
			}
			expect(sh(w, w.work, ["git", "cat-file", "-e", `${m}^{commit}`]).code).toBe(0);
		}
	});

	test("an untested local commit refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { lane, sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		const u = commitFile(w, lane, "e.txt", "a local commit never pushed or tested");

		expectRefused(w, x, await close(w, x), `local ${x.branch} has untested commit ${s7(u)}`, u);
		expect(remoteSha(w, x.branch)).toBe(s);
	});

	test("a branch moved after the check refuses the commit: nothing rendered on it, nothing pushed, the row stays open", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { lane, sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		let moved = "";
		// the check reads C before it asks gh; a commit lands on the branch while gh answers
		const pi = piOf(w, {
			before: (command, args) => {
				if (command === "gh" && args.includes("all") && moved === "") moved = commitFile(w, lane, "f.txt", "a commit racing the close");
			},
		});

		const r = await close(w, x, pi, "shipped");

		expectRefused(w, x, r, `${x.branch} moved after the close check: it is at ${s7(moved)}, not the checked ${s7(s)}; close again to re-check`, moved);
		expect(g(w, lane, "status", "--porcelain")).toBe("");
		expect(remoteSha(w, x.branch)).toBe(s);
		// review r1, kimi note 1: a refused close records no receipt
		expect(receipts(x)).toEqual([]);
	});

	test("review r1, kimi note 2: under the pin a failed entry commit refuses, with no receipt and nothing published, never an untracked close", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		const pi = piOf(w, {
			before: (command, args) => {
				if (command === "git" && args.includes("commit")) throw new Error("a pre-commit hook said no");
			},
		});

		const r = await close(w, x, pi, "shipped");

		expect(r.closed).toBe(false);
		expect(r.text).toStartWith(`${x.wl} cannot close: the entry commit on ${x.branch} failed: git commit exited -1: a pre-commit hook said no; the rendered entry is left at `);
		expect(x.ledger.workload(x.wl)!.status).toBe("open");
		expect(g(w, w.work, "rev-parse", x.branch)).toBe(s);
		expect(remoteSha(w, x.branch)).toBe(s);
		expect(ghCalls(w).some((c) => c.startsWith("pr create") || c.includes("--state open"))).toBe(false);
		expect(receipts(x)).toEqual([]);
	});

	test("gh failing refuses: the check fails closed", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);
		writeFileSync(join(w.bin, "fail"), "");

		expectRefused(w, x, await close(w, x), `the close check could not answer: gh pr list --head ${x.branch} exited 1: gh: not logged in`, s);
	});

	test("the set takes in a push-dest: branch of a holder and a PR a test-requested: names, found with gh pr view", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const main = g(w, w.work, "rev-parse", "origin/main");
		expect(x.ledger.claimWorkload(x.wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 }).won).toBe(true);
		x.ledger.recordEntry({ by: "lane-a", workloadId: x.wl, kind: "assumption", body: `push-dest: origin feature-x ${main}` });
		x.ledger.recordEntry({ by: "lane-b", workloadId: x.wl, kind: "assumption", body: `push-dest: origin not-a-holder ${main}` });
		x.ledger.releaseWorkload(x.wl, { by: "lane-a", holder: "lane-a" });
		prs(w, "feature-x", [{ number: 9, state: "OPEN", headRefOid: main }]);

		expectRefused(w, x, await close(w, x), "PR #9 has no test-run result: call lane_full_test", null);
		expect(ghCalls(w)).toEqual([listAll(x.branch), listAll("feature-x")]);

		// a green on #9, and a request on #12 that no bound branch lists: gh pr view finds it, and its red refuses
		requested(x, "tr-1", 9, main);
		ran(x, "tr-1", 9, main, "green");
		requested(x, "tr-2", 12, main);
		ran(x, "tr-2", 12, main, "red");
		writeFileSync(join(w.bin, "view-12.json"), JSON.stringify({ number: 12, state: "OPEN", headRefOid: main, headRefName: "elsewhere" }));
		rmSync(join(w.bin, "gh.log"));

		expectRefused(w, x, await close(w, x), `PR #12's newest test-run tr-2 is red${OPEN_RED}`, null);
		expect(ghCalls(w)).toEqual([listAll(x.branch), listAll("feature-x"), `pr view 12 -R ${OWNER_REPO} --json number,state,headRefOid,headRefName`]);
	});

	test("a host with no exec cannot run the check in a git checkout: refused", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);

		expectRefused(w, x, await close(w, x, piOf(w, { exec: false })), `the close check could not answer: the host has no exec for extensions, so git cannot say whether ${w.work} is a repo the test runner serves`, null);
	});

	test("a repo the runner does not serve is not checked: a code delta with no PR closes as before", async () => {
		const w = world("someone/else");
		withOrigin(w);
		const x = closable(w);
		const { sha: s } = laneWithCode(w, x);

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).not.toContain("Close check");
		expect(g(w, w.work, "rev-parse", `${x.branch}~1`)).toBe(s);
		expect(ghCalls(w).some((c) => c.includes("--state all"))).toBe(false);
	});
});

describe("close check: a doc-merge green re-checks its basis, its parents and the merged main (plan wl-mv615mkeaf1yio § 3)", () => {
	/**
	 * P1, the lane's head, has a full green tr-1 (written on `basisOn`, this workload unless given); main
	 * then moves to P2 (a MIGRATION.md change), pushed; the lane runs `git merge <mergeRef>` (origin/main
	 * unless given) and pushes the merge H as PR #7's head. `init` is main's first commit.
	 */
	function merged(w: World, x: Closable, o: { mergeRef?: string; basisOn?: Closable } = {}): { p1: string; p2: string; h: string; init: string } {
		const init = g(w, w.work, "rev-parse", "main");
		const { lane, sha: p1 } = laneWithCode(w, x);
		const p2 = commitFile(w, w.work, "MIGRATION.md", "main's item");
		g(w, w.work, "push", "-q", "origin", "main");
		g(w, lane, "fetch", "-q", "origin");
		g(w, lane, "merge", "-q", "--no-edit", o.mergeRef ?? "origin/main");
		const h = g(w, lane, "rev-parse", "HEAD");
		g(w, lane, "push", "-q", "origin", x.branch);
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: h }]);
		requested(o.basisOn ?? x, "tr-1", 7, p1);
		ran(o.basisOn ?? x, "tr-1", 7, p1, "green");
		return { p1, p2, h, init };
	}
	/** The doc-merge green tr-2 at H, as the runner writes it. */
	function docMergeGreen(x: Closable, h: string, basis: RunBasis, main: string): void {
		requested(x, "tr-2", 7, h);
		ran(x, "tr-2", 7, h, "green", { full: null, mode: "doc-merge", basis, merge: { main, tip: main, docs: [] } });
	}
	const refusal = (why: string) => `PR #7's doc-merge green tr-2 does not hold: ${why}; call lane_full_test`;

	test("a doc-merge green at the merge of the green head and a main state closes, and the close check names it", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { p1, p2, h } = merged(w, x);
		expect(g(w, w.work, "rev-list", "--parents", "-n", "1", h)).toBe(`${h} ${p1} ${p2}`);
		docMergeGreen(x, h, { runId: "tr-1", sha: p1 }, p2);
		writeFileSync(join(w.bin, "open-pr"), PR_URL);

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain(`Close check: every PR in the set is green at its head (PR #7: doc-merge tr-2 on basis tr-1 at ${s7(p1)}, main ${s7(p2)}) and covers ${s7(h)}.`);
		expectPublishedOn(w, x, h);
	});

	test("a forged basis id refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { p1, p2, h } = merged(w, x);
		docMergeGreen(x, h, { runId: "tr-9", sha: p1 }, p2);

		expectRefused(w, x, await close(w, x), refusal("its basis tr-9 is not a finished run on this workload"), h);
	});

	test("a basis that is a full green on another workload refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const other: Closable = { ...x, wl: x.ledger.openWorkload({ by: SURFACE_BY, brief: "another workload", stakes: "normal", mode: "autonomous" }) };
		const { p1, p2, h } = merged(w, x, { basisOn: other });
		docMergeGreen(x, h, { runId: "tr-1", sha: p1 }, p2);

		expectRefused(w, x, await close(w, x), refusal("its basis tr-1 is not a finished run on this workload"), h);
	});

	test("a merge.main that is not H's second parent refuses, though it is on main's first-parent chain", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { p1, p2, h, init } = merged(w, x);
		docMergeGreen(x, h, { runId: "tr-1", sha: p1 }, init);

		expectRefused(w, x, await close(w, x), refusal(`${s7(h)}'s parents are ${s7(p1)} ${s7(p2)}, not the basis ${s7(p1)} and main ${s7(init)}`), h);
	});

	test("a merged P2 that main never was (a side-branch commit) refuses: it is off origin's first-parent chain", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		g(w, w.work, "checkout", "-q", "-b", "side");
		const side = commitFile(w, w.work, "side.txt", "a side-branch commit");
		g(w, w.work, "checkout", "-q", "main");
		const { p1, h } = merged(w, x, { mergeRef: "side" });
		expect(g(w, w.work, "rev-list", "--parents", "-n", "1", h)).toBe(`${h} ${p1} ${side}`);
		docMergeGreen(x, h, { runId: "tr-1", sha: p1 }, side);

		expectRefused(w, x, await close(w, x), refusal(`the merged main ${s7(side)} is not on origin's first-parent chain`), h);
	});
});

describe("close check: a merged PR's batch credit (plan wl-mv615mkeaf1yio § 4)", () => {
	const BATCH = "tr-0mvbatch01abcd";
	/**
	 * PR #7 (the lane's head S, no green of its own) and PR #8 (P8, made in another clone) were batched
	 * by Jo on a workload of Jo's own: a green test-batch-run there, the credit on this workload. With
	 * `land`, main then merged them in that order with --no-ff and pushed: L1 = merge(M0, S), L2 =
	 * merge(L1, P8), L2's tree being the batch's final tree.
	 */
	function batched(w: World, x: Closable, land: boolean): { s: string; m0: string; l1: string; l2: string | null; finalTree: string } {
		const { sha: s } = laneWithCode(w, x);
		const other = join(w.root, "other");
		g(w, w.root, "clone", "-q", ORIGIN_URL, other);
		const m0 = g(w, other, "rev-parse", "origin/main");
		g(w, other, "checkout", "-q", "-b", "pr8", m0);
		const p8 = commitFile(w, other, "c.txt", "PR 8's change");
		g(w, other, "checkout", "-q", "main");
		g(w, other, "merge", "-q", "--no-ff", "--no-edit", s);
		const l1 = g(w, other, "rev-parse", "HEAD");
		g(w, other, "merge", "-q", "--no-ff", "--no-edit", p8);
		const l2 = g(w, other, "rev-parse", "HEAD");
		const finalTree = g(w, other, "rev-parse", "HEAD^{tree}");
		if (land) g(w, other, "push", "-q", "origin", "main");
		const jo = x.ledger.openWorkload({ by: SURFACE_BY, brief: "Jo's batch", stakes: "normal", mode: "autonomous" });
		x.tick();
		x.ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: jo, kind: "assumption",
			body: testBatchRunBody({
				runId: BATCH, verdict: "green", base: m0, prs: [{ pr: 7, sha: s }, { pr: 8, sha: p8 }],
				steps: [m0, l1, l2].map((c) => ({ commit: c, tree: g(w, other, "rev-parse", `${c}^{tree}`) })), full: { pass: 3, fail: 0, skip: 0, exit: 0, ms: 900, error: null },
				failures: [], attribution: null, reason: null, headsAtEnd: [s, p8], runDir: `/runs/${BATCH}`, preflight: "ok",
			}),
		});
		x.tick();
		x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: x.wl, kind: "assumption", body: testBatchCreditBody({ runId: BATCH, pr: 7, sha: s, base: m0, step: 1, n: 2, finalTree }) });
		prs(w, x.branch, [{ number: 7, state: "MERGED", headRefOid: s }]);
		return { s, m0, l1, l2: land ? l2 : null, finalTree };
	}

	test("a credit whose batch landed as tested closes the merged PR with no green of its own, and the close check names it", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { s, m0 } = batched(w, x, true);
		const r = await close(w, x);
		expect(r.closed).toBe(true);
		// main merged S, so the candidate has no code delta left against origin/main: nothing to cover
		expect(r.text).toContain(`Close check: every PR in the set is green at its head (PR #7: batch ${BATCH} green at ${s7(s)}, step 1 of 2 onto ${s7(m0)}, landed).`);
		expectPublishedOn(w, x, s);
	});

	test("a credit whose batch never landed refuses, naming the chain it read", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { s, m0 } = batched(w, x, false);
		expectRefused(w, x, await close(w, x),
			`PR #7 has no test-run result: call lane_full_test; its batch credit ${BATCH} does not hold: the batch did not land: origin's first-parent chain has 0 commit(s) after its base ${s7(m0)}, not 2`, s);
	});

	test("a newer credit at the same head that does not hold never shadows the older one that landed (review r1 finding 2)", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { s, m0, finalTree } = batched(w, x, true);
		// a later batch of the same PR at the same head, whose test-batch-run: row is not in the ledger
		x.tick();
		x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: x.wl, kind: "assumption", body: testBatchCreditBody({ runId: "tr-0mvbatch02abcd", pr: 7, sha: s, base: m0, step: 1, n: 2, finalTree }) });
		const r = await close(w, x);
		expect(r.closed).toBe(true);
		expect(r.text).toContain(`Close check: every PR in the set is green at its head (PR #7: batch ${BATCH} green at ${s7(s)}, step 1 of 2 onto ${s7(m0)}, landed).`);
		expectPublishedOn(w, x, s);
	});

	test("landedChain reads up to n first-parent commits after the base, oldest first, with tree and parents; a base the clone lacks is no landing", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const { s, m0, l1, l2 } = batched(w, x, true);
		g(w, w.work, "fetch", "-q", "origin");
		const exec = piOf(w).exec!;
		const chain = await landedChain(exec, w.work, m0, "origin/main", 2);
		expect(chain.map((c) => [c.sha, c.parents])).toEqual([[l1, [m0, s]], [l2!, [l1, expect.any(String)]]]);
		expect(chain[1]!.tree).toBe(g(w, w.work, "rev-parse", `${l2}^{tree}`));
		expect(await landedChain(exec, w.work, m0, "origin/main", 1)).toHaveLength(1);
		expect(await landedChain(exec, w.work, "f".repeat(40), "origin/main", 2)).toEqual([]);
	});
});

// ---- PLAN wl-mv5i3lulwwbbi8 D3: Jo's waiver of a merged PR's red run ------------------------------------

const SLICE = "sl-full-1";
/** What the red-run refusal adds for a merged PR with no waiver that binds its run. */
const MERGED_RED = ": a merged PR passes only on Jo's `waive` answering a question that offers waive on the run's slice, asked after the result";

/** The lane's change on origin/main (merged by fast-forward), and PR #7 from wl/<id> MERGED at that head. */
function merged(w: World, x: Closable, state: "OPEN" | "MERGED" = "MERGED"): string {
	const { lane, sha } = laneWithCode(w, x);
	g(w, lane, "push", "-q", "origin", `${sha}:main`);
	prs(w, x.branch, [{ number: 7, state, headRefOid: sha }]);
	return sha;
}
/** The full-suite slice the runner's requests name. */
function fullSlice(x: Closable): void {
	x.ledger.addSlice({ by: TEST_RUNNER_BY, workloadId: x.wl, id: SLICE, task: "full suite outside the fence at PR #7", doneCondition: "a green test-run at the PR head", inputs: "PR #7" });
}
/** A lane's question on the full-suite slice. */
function ask(x: Closable, options: string[] = ["waive", "hold"]): string {
	x.tick();
	return x.ledger.raiseQuestion({ by: "lane-a", workloadId: x.wl, sliceId: SLICE, body: "PR #7 is merged and its run is red: waive or hold?", options });
}
/** An answer: Jo's through the surface unless `by`/`author` say otherwise. */
function answer(x: Closable, q: string, body = "waive", o: { by?: string; author?: string } = {}): void {
	x.tick();
	const by = o.by ?? SURFACE_BY;
	x.ledger.answerQuestion(q, { by, answer: body, author: o.author ?? "jo", channel: by === SURFACE_BY ? "surface" : "direct" });
}
/** G1: the full-suite slice is out of the way (Jo's cancel-slice, D1). */
const settled = (x: Closable) => x.ledger.cancelSlice(SLICE, { by: SURFACE_BY });

describe("PLAN wl-mv5i3lulwwbbi8 D3: a merged PR's red run Jo waived passes the close check; nothing else does", () => {
	test("Tinker's shape: red on a merged PR, Jo's surface `waive` on its slice after the result → closes; the same on an open PR refuses", async () => {
		for (const state of ["MERGED", "OPEN"] as const) {
			const w = world();
			withOrigin(w);
			const x = closable(w);
			fullSlice(x);
			const s = merged(w, x, state);
			requested(x, "tr-1", 7, s);
			ran(x, "tr-1", 7, s, "red");
			answer(x, ask(x));
			settled(x);

			const r = await close(w, x);

			if (state === "OPEN") {
				expectRefused(w, x, r, `PR #7's newest test-run tr-1 is red${OPEN_RED}`, s);
				continue;
			}
			expect(r.closed).toBe(true);
			expect(r.text).toContain("Close check: every PR in the set is green at its head or merged with a waived run (#7 (tr-1)).");
			expectPublishedOn(w, x, s);
		}
	}, 20_000);

	test("a forged or misplaced waiver is refused: lane-written, not Jo's, `hold`, no waive option, asked or answered before the result, a newer request", async () => {
		const shapes: { name: string; run: (x: Closable, s: string) => void; reason?: string }[] = [
			{ name: "written by a lane claiming author jo", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x), "waive", { by: "lane-a" }); } },
			{ name: "written by the surface, not authored by jo", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x), "waive", { author: "orchestrator" }); } },
			{ name: "the answer is hold", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x), "hold"); } },
			{ name: "the question offers no waive", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x, ["accept", "hold"]), "waive"); } },
			{ name: "the question precedes the result", run: (x, s) => { requested(x, "tr-1", 7, s); const q = ask(x); ran(x, "tr-1", 7, s, "red"); answer(x, q); } },
			{ name: "question and answer precede the result", run: (x, s) => { requested(x, "tr-1", 7, s); answer(x, ask(x)); ran(x, "tr-1", 7, s, "red"); } },
			{
				name: "a newer request for the PR after the waiver", reason: `PR #7's newest test-run tr-2 is red${MERGED_RED}`,
				run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x)); requested(x, "tr-2", 7, s); ran(x, "tr-2", 7, s, "red"); },
			},
		];
		for (const shape of shapes) {
			const w = world();
			withOrigin(w);
			const x = closable(w);
			fullSlice(x);
			const s = merged(w, x);
			shape.run(x, s);
			settled(x);

			const r = await close(w, x);

			expect({ shape: shape.name, text: r.text }).toEqual({ shape: shape.name, text: `${x.wl} cannot close: ${shape.reason ?? `PR #7's newest test-run tr-1 is red${MERGED_RED}`}` });
			expectRefused(w, x, r, shape.reason ?? `PR #7's newest test-run tr-1 is red${MERGED_RED}`, s);
		}
	}, 60_000);

	test("two red runs on one slice (PR #9, then PR #8), one waived question: only the newest, #8's, is waived; #9 still refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		fullSlice(x);
		const main = g(w, w.work, "rev-parse", "origin/main");
		writeFileSync(join(w.bin, "view-9.json"), JSON.stringify({ number: 9, state: "MERGED", headRefOid: main, headRefName: "feature-a" }));
		writeFileSync(join(w.bin, "view-8.json"), JSON.stringify({ number: 8, state: "MERGED", headRefOid: main, headRefName: "feature-b" }));
		requested(x, "tr-1", 9, main);
		ran(x, "tr-1", 9, main, "red");
		requested(x, "tr-2", 8, main);
		ran(x, "tr-2", 8, main, "red");
		answer(x, ask(x));
		settled(x);

		// The PRs are checked in number order: #8 passes on the waiver, so the refusal names #9.
		expectRefused(w, x, await close(w, x), `PR #9's newest test-run tr-1 is red${MERGED_RED}`, null);
	});
});

// ---- PLAN wl-mv5i3lulwwbbi8 D2: a workload Jo superseded closes without a receipt -------------------------

const DONE = "the feed header sits at its offset";
const NO_RECEIPT = `no \`done-because:\` receipt from its holder against the done: line (${DONE}), or a later note by the lane or the surface supersedes it. The lane writes it with lane_record_entry before it releases.`;

/** A `done:` line on the workload, so G3 asks for a receipt. */
function withDone(x: Closable): void {
	x.ledger.recordEntry({ by: SURFACE_BY, workloadId: x.wl, kind: "assumption", body: `done: ${DONE}` });
}
/** Jo's `supersede <A> <B>` as the surface writes it: the instruction on A, then `superseded: <B> <in-…>` naming it. */
function supersede(x: Closable, o: { entryBy?: string; author?: string } = {}): string {
	const by = x.ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header offset, done over", stakes: "normal", mode: "autonomous" });
	const ins = x.ledger.recordInstruction({ by: SURFACE_BY, workloadId: x.wl, body: `supersede ${x.wl} ${by}`, author: o.author ?? "jo", channel: "surface" });
	x.ledger.recordEntry({ by: o.entryBy ?? SURFACE_BY, workloadId: x.wl, kind: "assumption", body: `superseded: ${by} ${ins}` });
	return `superseded by ${by} (Jo, ${ins})`;
}

describe("PLAN wl-mv5i3lulwwbbi8 D2: a superseded workload closes with no open PR and no unmerged commit, its entry naming the successor", () => {
	test("every PR merged and no commit outside main: closes without a receipt; the entry and the close receipt name the successor", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const s = merged(w, x);
		withDone(x);
		const by = supersede(x);

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain(`Close check: ${by}: no open PR in the set and no unmerged commit on a bound branch.`);
		const d = expectPublishedOn(w, x, s);
		const file = g(w, w.work, "diff-tree", "-r", "--no-commit-id", "--name-only", s, d);
		expect(g(w, w.work, "show", `${d}:${file}`)).toContain(`- orchestrator (surface): close receipt: ${by}`);
		expect(receipts(x)).toEqual([`close receipt: ${by}`]);
	});

	test("an open PR from wl/<id> refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const s = merged(w, x, "OPEN");
		withDone(x);
		const by = supersede(x);

		expectRefused(w, x, await close(w, x), `${by}, but PR #7 from ${x.branch} is open: merge or close it first`, s);
		expect(receipts(x)).toEqual([]);
	});

	test("an open PR from a holder's push-dest: branch refuses", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w);
		const main = g(w, w.work, "rev-parse", "origin/main");
		expect(x.ledger.claimWorkload(x.wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 }).won).toBe(true);
		x.ledger.recordEntry({ by: "lane-a", workloadId: x.wl, kind: "assumption", body: `push-dest: origin feature-x ${main}` });
		x.ledger.releaseWorkload(x.wl, { by: "lane-a", holder: "lane-a" });
		prs(w, "feature-x", [{ number: 9, state: "OPEN", headRefOid: main }]);
		withDone(x);
		const by = supersede(x);

		expectRefused(w, x, await close(w, x), `${by}, but PR #9 from feature-x is open: merge or close it first`, null);
	});

	test("an unmerged commit on wl/<id>, or on a push-dest: branch only on origin, refuses", async () => {
		{
			const w = world();
			withOrigin(w);
			const x = closable(w);
			const { sha: s } = laneWithCode(w, x);
			withDone(x);
			const by = supersede(x);

			expectRefused(w, x, await close(w, x), `${by}, but refs/heads/${x.branch} has 1 commit(s) not in origin/main, first ${s7(s)}: merge them, or delete the branch`, s);
		}
		{
			const w = world();
			withOrigin(w);
			const x = closable(w);
			const other = join(w.root, "other");
			g(w, w.root, "clone", "-q", ORIGIN_URL, other);
			const y = commitFile(w, other, "y.txt", "work left on a push-dest branch");
			g(w, other, "push", "-q", "origin", "HEAD:refs/heads/feature-y");
			expect(x.ledger.claimWorkload(x.wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 }).won).toBe(true);
			x.ledger.recordEntry({ by: "lane-a", workloadId: x.wl, kind: "assumption", body: `push-dest: origin feature-y ${y}` });
			x.ledger.releaseWorkload(x.wl, { by: "lane-a", holder: "lane-a" });
			withDone(x);
			const by = supersede(x);

			expectRefused(w, x, await close(w, x), `${by}, but refs/remotes/origin/feature-y has 1 commit(s) not in origin/main, first ${s7(y)}: merge them, or delete the branch`, null);
		}
	}, 20_000);

	test("a superseded: entry a lane wrote, or one naming an instruction not Jo's, counts for nothing; with none, G3 still asks for the receipt", async () => {
		for (const o of [{ entryBy: "lane-a" }, { author: "orchestrator" }, null]) {
			const w = world();
			withOrigin(w);
			const x = closable(w);
			const s = merged(w, x);
			withDone(x);
			if (o) supersede(x, o);

			expectRefused(w, x, await close(w, x), NO_RECEIPT, s);
			expect(ghCalls(w)).toEqual([]);
		}
	}, 30_000);
});
