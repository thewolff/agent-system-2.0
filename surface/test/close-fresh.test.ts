// The close check (MIGRATION.md item 24, PLAN § 2.4 item 4; surface/src/close-entry.ts `closeCheck`,
// surface/extensions/workload.ts): for a repo the test runner serves, the close needs an
// authoritative green at every open or merged PR head in the workload's set, the local wl/<id> tip
// (the pinned candidate C) covered by a green from wl/<id> when it carries code, and it fails closed
// when git or gh cannot answer. Real git on a bare origin that `https://github.com/example/repo.git`
// resolves to through `url.<bare>.insteadOf` (so the origin URL names a served `owner/repo` while every
// fetch and push stays local), a fake `gh` first on PATH that records its argv and answers
// `pr list --state all` per head branch from `prs/<branch>.json`, and a testRunner config through
// `$AGENT_SYSTEM_TEST_RUNNER_CONFIG`.
//
// Each git world is built once per file, in `beforeAll`: a template per shape (the bare origin and the clone, the lane's
// change, a train's or a merge's commits on a second clone), none of whose commits name a workload id. A test copies
// its template's directory (no process) and starts at most FIXTURE_SPAWNS git processes of its own fixture: the lane
// worktree on wl/<id> and its push. `fixture` counts every process started while it builds and asserts the bound in
// every test, so the file keeps bun's default 5 s per test (PLAN wl-mvqu69tjvpy96o § 2 C7, R7).
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { closeWorkloadWithEntry } from "../extensions/workload";
import { TEST_RUNNER_CONFIG_ENV } from "../src/close-entry";
import { recordRepo } from "../src/decision-log";
import { applyTrain } from "../src/input";
import { branchName, worktreePath } from "../src/launch";
import { testRequestedBody, testRunBody, type TestVerdict } from "../src/test-run";
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

/** The world rooted at `root`: git isolated from the machine's config, the fake `gh` first on PATH. */
function worldAt(root: string): World {
	const bin = join(root, "bin");
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
	};
	return { root, work: join(root, "work"), origin: join(root, "origin.git"), bin, config: join(root, "config.yml"), env };
}
/** A new canonical scratch root, removed after the file. */
function scratchRoot(tag: string): string {
	const root = realpathSync(tmp(tag));
	roots.push(root);
	return root;
}
/** The world's gitconfig: the served GitHub URL resolves to this world's own bare origin. */
function writeGitconfig(w: World): void {
	writeFileSync(join(w.root, "gitconfig"), `[url "${w.origin}"]\n\tinsteadOf = ${ORIGIN_URL}\n`);
}
/** A template's start: a canonical scratch root with the fake `gh` and the gitconfig, no repository yet. */
function blankWorld(): World {
	const w = worldAt(scratchRoot("close-fresh-template"));
	mkdirSync(join(w.bin, "prs"), { recursive: true });
	writeFileSync(join(w.bin, "gh"), GH);
	chmodSync(join(w.bin, "gh"), 0o755);
	writeGitconfig(w);
	return w;
}
/**
 * A copy of world `t` in a new root, made with no process: the gitconfig re-pointed at the copy's own origin (the
 * clones' origin URL is the served GitHub URL, so nothing else in them names a path), and a served testRunner config.
 */
function copyOf(t: World, tag: string, served = OWNER_REPO): World {
	const w = worldAt(scratchRoot(tag));
	cpSync(t.root, w.root, { recursive: true });
	writeGitconfig(w);
	writeFileSync(w.config, `setupVersion: 2\ntestRunner:\n  repos:\n    - origin: ${served}\n      command: bun test\n`);
	return w;
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

// ---- the templates: each built once per file in a beforeAll, copied by every test --------------------------------

/** The processes a test's fixture may start (R7): the lane worktree on wl/<id> and its push. */
const FIXTURE_SPAWNS = 2;
/** Holds the lane's change in the template clone: outside refs/heads/ and refs/remotes/, so no listing, fetch or push of branches sees it. */
const LANE_REF = "refs/fixture/lane";
type Shape = "origin" | "merged" | "pastGreen" | "train-OPEN" | "train-MERGED";
/** Each shape's template world, and the commit a test's wl/<id> starts at (null: the shape has no lane). */
const templates: Partial<Record<Shape, { w: World; lane: string | null }>> = {};
/** The templates' commits: s the lane's change; mergedPastGreen's o, h and m; trainShape's b1, b2 and p. */
const T = { s: "", o: "", h: "", m: "", b1: "", b2: "", p: "" };

// origin: the bare origin and the clone on main, with the lane's change s (b.txt on origin/main) held by LANE_REF alone.
// merged: the same with s fast-forwarded onto origin's main, as the lane's PR merging does.
beforeAll(() => {
	const w = blankWorld();
	withOrigin(w);
	g(w, w.work, "checkout", "-q", "--detach");
	T.s = commitFile(w, w.work, "b.txt", "the lane's change");
	g(w, w.work, "update-ref", LANE_REF, T.s);
	g(w, w.work, "checkout", "-q", "main");
	templates.origin = { w, lane: T.s };
	const m = copyOf(w, "close-fresh-template");
	g(m, m.work, "push", "-q", "origin", `${T.s}:main`);
	templates.merged = { w: m, lane: T.s };
});

function template(shape: Shape): { w: World; lane: string | null } {
	const t = templates[shape];
	if (!t) throw new Error(`close-fresh: no ${shape} template; the beforeAll that builds it (in this test's describe, or at the top of the file) did not run`);
	return t;
}
function argvOf(a: unknown): string {
	if (Array.isArray(a)) return a.join(" ");
	if (a && typeof a === "object" && "cmd" in a && Array.isArray(a.cmd)) return a.cmd.join(" ");
	return String(a);
}

interface Fixture {
	w: World;
	x: Closable;
	/** The lane's worktree path (created only with `lane`). */
	lane: string;
	/** The commit wl/<id> is at ("" without `lane`). */
	sha: string;
}
/**
 * A test's world: a copy of the `shape` template (no process) and a closable workload on it; with `lane`, the lane's
 * worktree on wl/<id> at the template's lane commit, pushed with its upstream (the two processes). Every process
 * started while it builds is counted (Bun.spawnSync and Bun.spawn), and more than FIXTURE_SPAWNS fails the test,
 * naming each one (PLAN wl-mvqu69tjvpy96o R7: on a loaded runner a bigger fixture outran bun's 5 s).
 */
function fixture(shape: Shape, o: { lane?: boolean; served?: string } = {}): Fixture {
	const t = template(shape);
	const at = o.lane ? t.lane : "";
	if (at === null) throw new Error(`close-fresh: the ${shape} template has no lane commit, so it cannot give a test a lane`);
	const spawnSync = spyOn(Bun, "spawnSync");
	const spawn = spyOn(Bun, "spawn");
	try {
		const w = copyOf(t.w, "close-fresh", o.served);
		const x = closable(w);
		const lane = worktreePath(w.work, x.wl);
		if (o.lane) {
			g(w, w.work, "worktree", "add", "-q", "-b", x.branch, lane, at);
			g(w, lane, "push", "-q", "-u", "origin", x.branch);
		}
		const started = [...spawnSync.mock.calls, ...spawn.mock.calls].map(([cmd]) => argvOf(cmd));
		expect({ shape, started }).toEqual({ shape, started: started.slice(0, FIXTURE_SPAWNS) });
		return { w, x, lane, sha: at };
	} finally {
		spawnSync.mockRestore();
		spawn.mockRestore();
	}
}

/** What `gh pr list -R example/repo --head <branch> --state all` prints; a merged PR's merge commit is its head (a fast-forward) unless given. */
function prs(w: World, branch: string, list: { number: number; state: "OPEN" | "MERGED" | "CLOSED"; headRefOid: string; mergeCommit?: string }[]): void {
	const json = list.map((p) => ({ ...p, mergeCommit: p.state === "MERGED" ? { oid: p.mergeCommit ?? p.headRefOid } : null }));
	writeFileSync(join(w.bin, "prs", `${branch.replaceAll("/", "_")}.json`), JSON.stringify(json));
}
/** The runner's `test-requested:` entry, as the starter writes it (on `o.wl`, another workload, when given). */
function requested(x: Closable, runId: string, pr: number, sha: string, o: { wl?: string } = {}): void {
	x.tick();
	x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: o.wl ?? x.wl, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice: "sl-full-1", by: "lane-a" }) });
}
/** The runner's `test-run:` entry for a request; a red-main carries the base comparison it rests on. `o.wl` writes it on another workload, `o.by` forges the writer. */
function ran(x: Closable, runId: string, pr: number, sha: string, verdict: TestVerdict, o: { wl?: string; by?: string } = {}): void {
	x.tick();
	const red = verdict === "red" || verdict === "red-main";
	const broken = "x.test.ts > broken";
	x.ledger.recordEntry({
		by: o.by ?? TEST_RUNNER_BY, workloadId: o.wl ?? x.wl, kind: "assumption",
		body: testRunBody({
			runId, verdict, sha, pr, reason: verdict === "superseded" ? "a newer request owns the slice" : null, headAtEnd: sha, base: null, mergeBase: null,
			full: { pass: 3, fail: red ? 1 : 0, skip: 0, exit: red ? 1 : 0, ms: 900, error: null }, solo: [],
			failures: red ? [{ part: "full", name: broken, firstError: "error: nope" }] : [], runDir: `/runs/${runId}`, preflight: "ok",
			...(verdict === "red-main" ? { baseCompare: { sha: "b".repeat(40), parts: [{ part: "full", failing: [broken], baseFailing: [broken], baseError: null }] } } : {}),
		}),
	});
}

const ghCalls = (w: World): string[] => (existsSync(join(w.bin, "gh.log")) ? readFileSync(join(w.bin, "gh.log"), "utf8").trim().split("\n") : []);
const listAll = (branch: string) => `pr list -R ${OWNER_REPO} --head ${branch} --state all --json number,state,headRefOid,mergeCommit`;
const remoteSha = (w: World, branch: string): string => g(w, w.work, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] ?? "";
const s7 = (sha: string) => sha.slice(0, 7);
/** What the red-run refusal adds for an open PR (PLAN wl-mv5i3lulwwbbi8 D3: it names the waive path). */
const OPEN_RED = ": fix it and call lane_full_test (a waiver passes only a merged PR)";
/** PLAN wl-mvfjen3q5mqi2o D4: the two ways through for a merged PR nothing covers. */
const waysThrough = (x: Closable, n: number, merge: string) =>
	`once a green run's commit that contains ${s7(merge)} is on main (for example, the next green PR that merges main in, once it has merged), or on Jo's \`waive-pr ${x.wl} ${n}\``;
/** PLAN wl-mvfjen3q5mqi2o D4: the refusal for a merged PR no green holds, naming its merge commit and both ways through. */
const uncoveredReason = (x: Closable, n: number, head: string, merge: string) =>
	`PR #${n} merged at ${s7(head)} (merge commit ${s7(merge)}) and no test-runner green on main holds it: it passes ${waysThrough(x, n, merge)}`;

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
		const { w, x, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, lane, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, lane, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, lane, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, lane, sha: s } = fixture("origin", { lane: true });
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		commitFile(w, lane, "c.txt", "local code after the green");
		const v = removeFile(w, lane, "c.txt", "revert the local code");

		expectRefused(w, x, await close(w, x), `local ${x.branch} has untested commit ${s7(v)}`, v);
		expect(remoteSha(w, x.branch)).toBe(s);
	});

	test("a chain of decision-log-only commits after the green closes, an empty commit included; the entry carries the receipt", async () => {
		const { w, x, lane, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, sha: s } = fixture("origin", { lane: true });
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		requested(x, "tr-2", 7, s);
		ran(x, "tr-2", 7, s, "red");

		expectRefused(w, x, await close(w, x), `PR #7's newest test-run tr-2 is red${OPEN_RED}`, s);
	});

	test("a late superseded from a displaced run does not override the newer green", async () => {
		const { w, x, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, sha: s } = fixture("origin", { lane: true });

		expectRefused(w, x, await close(w, x), `${x.branch} changes b.txt but has no PR: push and open the PR, then lane_full_test`, s);
		expect(ghCalls(w)).toEqual([listAll(x.branch)]);
	});

	test("a PR closed without merge, with a code delta, refuses", async () => {
		const { w, x, sha: s } = fixture("origin", { lane: true });
		prs(w, x.branch, [{ number: 7, state: "CLOSED", headRefOid: s }]);

		expectRefused(w, x, await close(w, x), "PR #7 is closed; reopen it, or reset the branch", s);
	});

	test("an empty PR set with no code delta closes (an investigation): the branch is cut from origin/main and D pushed on it", async () => {
		const { w, x } = fixture("origin");
		const main = g(w, w.work, "rev-parse", "origin/main");

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toEndWith(`PR opened: ${PR_URL}. Close check: no PR and no code delta.`);
		expectPublishedOn(w, x, main);
		const calls = ghCalls(w);
		expect(calls.slice(0, 2)).toEqual([listAll(x.branch), `pr list -R ${OWNER_REPO} --head ${x.branch} --state open --json url`]);
		expect(calls[2]!.startsWith(`pr create -R ${OWNER_REPO} --head ${x.branch} --base main --title `)).toBe(true);
	});

	for (const [label, file, closes] of [
		["metadata-only changes", ".ai/decision-log/2026-10-08--0930--lane--merged.md", true],
		["code changes", "d.txt", false],
	] as const) {
		test(`a merged PR with ${label} is checked at its final head, fetched through refs/pull/<N>/head when the clone lacks it`, async () => {
			const { w, x, sha: s } = fixture("origin", { lane: true });
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
				expectRefused(w, x, r, uncoveredReason(x, 7, m, m), s);
			}
			expect(sh(w, w.work, ["git", "cat-file", "-e", `${m}^{commit}`]).code).toBe(0);
		});
	}

	test("an untested local commit refuses", async () => {
		const { w, x, lane, sha: s } = fixture("origin", { lane: true });
		prs(w, x.branch, [{ number: 7, state: "OPEN", headRefOid: s }]);
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "green");
		const u = commitFile(w, lane, "e.txt", "a local commit never pushed or tested");

		expectRefused(w, x, await close(w, x), `local ${x.branch} has untested commit ${s7(u)}`, u);
		expect(remoteSha(w, x.branch)).toBe(s);
	});

	test("a branch moved after the check refuses the commit: nothing rendered on it, nothing pushed, the row stays open", async () => {
		const { w, x, lane, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, sha: s } = fixture("origin", { lane: true });
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
		const { w, x, sha: s } = fixture("origin", { lane: true });
		writeFileSync(join(w.bin, "fail"), "");

		expectRefused(w, x, await close(w, x), `the close check could not answer: gh pr list --head ${x.branch} exited 1: gh: not logged in`, s);
	});

	test("the set takes in a push-dest: branch of a holder and a PR a test-requested: names, found with gh pr view", async () => {
		const { w, x } = fixture("origin");
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
		expect(ghCalls(w)).toEqual([listAll(x.branch), listAll("feature-x"), `pr view 12 -R ${OWNER_REPO} --json number,state,headRefOid,mergeCommit,headRefName`]);
	});

	test("a host with no exec cannot run the check in a git checkout: refused", async () => {
		const { w, x } = fixture("origin");

		expectRefused(w, x, await close(w, x, piOf(w, { exec: false })), `the close check could not answer: the host has no exec for extensions, so git cannot say whether ${w.work} is a repo the test runner serves`, null);
	});

	test("a repo the runner does not serve is not checked: a code delta with no PR closes as before", async () => {
		const { w, x, sha: s } = fixture("origin", { lane: true, served: "someone/else" });

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).not.toContain("Close check");
		expect(g(w, w.work, "rev-parse", `${x.branch}~1`)).toBe(s);
		expect(ghCalls(w).some((c) => c.includes("--state all"))).toBe(false);
	});
});

// ---- PLAN wl-mv5i3lulwwbbi8 D3: Jo's waiver of a merged PR's red run ------------------------------------

const SLICE = "sl-full-1";
/** What the red-run refusal adds for a merged PR with no waiver that binds its run, then D4's two ways through (PLAN wl-mvfjen3q5mqi2o). */
const mergedRed = (x: Closable, n: number, merge: string) =>
	`: a merged PR passes only on Jo's \`waive\` answering a question that offers waive on the run's slice, asked after the result; it also passes ${waysThrough(x, n, merge)}`;

/** The lane's change on origin/main (merged by fast-forward: the merged template), and PR #7 from wl/<id> MERGED (or `state`) at that head. */
function merged(state: "OPEN" | "MERGED" = "MERGED"): Fixture {
	const f = fixture("merged", { lane: true });
	prs(f.w, f.x.branch, [{ number: 7, state, headRefOid: f.sha }]);
	return f;
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
			const { w, x, sha: s } = merged(state);
			fullSlice(x);
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
		const shapes: { name: string; run: (x: Closable, s: string) => void; reason?: (x: Closable, s: string) => string }[] = [
			{ name: "written by a lane claiming author jo", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x), "waive", { by: "lane-a" }); } },
			{ name: "written by the surface, not authored by jo", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x), "waive", { author: "orchestrator" }); } },
			{ name: "the answer is hold", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x), "hold"); } },
			{ name: "the question offers no waive", run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x, ["accept", "hold"]), "waive"); } },
			{ name: "the question precedes the result", run: (x, s) => { requested(x, "tr-1", 7, s); const q = ask(x); ran(x, "tr-1", 7, s, "red"); answer(x, q); } },
			{ name: "question and answer precede the result", run: (x, s) => { requested(x, "tr-1", 7, s); answer(x, ask(x)); ran(x, "tr-1", 7, s, "red"); } },
			{
				name: "a newer request for the PR after the waiver", reason: (x, s) => `PR #7's newest test-run tr-2 is red${mergedRed(x, 7, s)}`,
				run: (x, s) => { requested(x, "tr-1", 7, s); ran(x, "tr-1", 7, s, "red"); answer(x, ask(x)); requested(x, "tr-2", 7, s); ran(x, "tr-2", 7, s, "red"); },
			},
		];
		for (const shape of shapes) {
			const { w, x, sha: s } = merged();
			fullSlice(x);
			shape.run(x, s);
			settled(x);

			const r = await close(w, x);

			const reason = shape.reason?.(x, s) ?? `PR #7's newest test-run tr-1 is red${mergedRed(x, 7, s)}`;
			expect({ shape: shape.name, text: r.text }).toEqual({ shape: shape.name, text: `${x.wl} cannot close: ${reason}` });
			expectRefused(w, x, r, reason, s);
		}
	}, 60_000);

	test("two red runs on one slice (PR #9, then PR #8), one waived question: only the newest, #8's, is waived; #9 still refuses", async () => {
		const { w, x } = fixture("origin");
		fullSlice(x);
		const main = g(w, w.work, "rev-parse", "origin/main");
		writeFileSync(join(w.bin, "view-9.json"), JSON.stringify({ number: 9, state: "MERGED", headRefOid: main, headRefName: "feature-a", mergeCommit: { oid: main } }));
		writeFileSync(join(w.bin, "view-8.json"), JSON.stringify({ number: 8, state: "MERGED", headRefOid: main, headRefName: "feature-b", mergeCommit: { oid: main } }));
		requested(x, "tr-1", 9, main);
		ran(x, "tr-1", 9, main, "red");
		requested(x, "tr-2", 8, main);
		ran(x, "tr-2", 8, main, "red");
		answer(x, ask(x));
		settled(x);

		// The PRs are checked in number order: #8 passes on the waiver, so the refusal names #9.
		expectRefused(w, x, await close(w, x), `PR #9's newest test-run tr-1 is red${mergedRed(x, 9, main)}`, null);
	});
});

// ---- PLAN wl-mv5i3lulwwbbi8 D2: a workload Jo superseded closes without a receipt -------------------------

const DONE = "the feed header sits at its offset";
const NO_RECEIPT = `no \`done-because:\` receipt from its holder against the done: line (${DONE}), or a later note by the lane or the surface supersedes it. The lane writes it with lane_record_entry before it releases.`;

/** A `done:` line on the workload, so G3 asks for a receipt. */
function withDone(x: Closable): void {
	x.ledger.recordEntry({ by: SURFACE_BY, workloadId: x.wl, kind: "assumption", body: `done: ${DONE}` });
}

describe("PLAN wl-mv8s8srodefytc rev 17.1 D8: a red-main result passes the close check only on a merged PR a merge train of this repo lists", () => {
	test("red-main at the merged head: refused off a train and on another repo's train; closes once Jo's train on this repo lists the PR", async () => {
		for (const on of ["no train", "another repo", "this repo"] as const) {
			const { w, x, sha: s } = merged();
			requested(x, "tr-1", 7, s);
			ran(x, "tr-1", 7, s, "red-main");
			if (on !== "no train") applyTrain(x.ledger, { kind: "train", prs: [7] }, on === "this repo" ? w.work : join(w.root, "elsewhere"));

			const r = await close(w, x);

			if (on !== "this repo") {
				expect(r.closed).toBe(false);
				expect(r.text).toContain("tr-1");
				expect(x.ledger.workload(x.wl)!.status).toBe("open");
				continue;
			}
			expect(r.closed).toBe(true);
			expectPublishedOn(w, x, s);
		}
	}, 20_000);

	test("red-main at the merged head: a train opened from a subdirectory or another checkout of this GitHub repository lists the PR", async () => {
		for (const from of ["subdirectory", "another checkout"] as const) {
			const { w, x, sha: s } = merged();
			requested(x, "tr-1", 7, s);
			ran(x, "tr-1", 7, s, "red-main");
			let where = join(w.work, "surface");
			if (from === "subdirectory") mkdirSync(where);
			else {
				where = join(w.root, "clone");
				mkdirSync(where);
				g(w, where, "init", "-q", "-b", "main");
				g(w, where, "remote", "add", "origin", ORIGIN_URL);
			}
			applyTrain(x.ledger, { kind: "train", prs: [7] }, where);

			const r = await close(w, x);

			expect(r.closed).toBe(true);
			expectPublishedOn(w, x, s);
		}
	}, 20_000);
});

/** Jo's `supersede <A> <B>` as the surface writes it: the instruction on A, then `superseded: <B> <in-…>` naming it. */
function supersede(x: Closable, o: { entryBy?: string; author?: string } = {}): string {
	const by = x.ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header offset, done over", stakes: "normal", mode: "autonomous" });
	const ins = x.ledger.recordInstruction({ by: SURFACE_BY, workloadId: x.wl, body: `supersede ${x.wl} ${by}`, author: o.author ?? "jo", channel: "surface" });
	x.ledger.recordEntry({ by: o.entryBy ?? SURFACE_BY, workloadId: x.wl, kind: "assumption", body: `superseded: ${by} ${ins}` });
	return `superseded by ${by} (Jo, ${ins})`;
}

describe("PLAN wl-mv5i3lulwwbbi8 D2: a superseded workload closes with no open PR and no unmerged commit, its entry naming the successor", () => {
	test("every PR merged and no commit outside main: closes without a receipt; the entry and the close receipt name the successor", async () => {
		const { w, x, sha: s } = merged();
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
		const { w, x, sha: s } = merged("OPEN");
		withDone(x);
		const by = supersede(x);

		expectRefused(w, x, await close(w, x), `${by}, but PR #7 from ${x.branch} is open: merge or close it first`, s);
		expect(receipts(x)).toEqual([]);
	});

	test("an open PR from a holder's push-dest: branch refuses", async () => {
		const { w, x } = fixture("origin");
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
			const { w, x, sha: s } = fixture("origin", { lane: true });
			withDone(x);
			const by = supersede(x);

			expectRefused(w, x, await close(w, x), `${by}, but refs/heads/${x.branch} has 1 commit(s) not in origin/main, first ${s7(s)}: merge them, or delete the branch`, s);
		}
		{
			const { w, x } = fixture("origin");
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
			const { w, x, sha: s } = merged();
			withDone(x);
			if (o) supersede(x, o);

			expectRefused(w, x, await close(w, x), NO_RECEIPT, s);
			expect(ghCalls(w)).toEqual([]);
		}
	}, 30_000);
});

// ---- PLAN wl-mvfjen3q5mqi2o: the push-dest PRs in the set (D1), a covering green on main (D2), Jo's waive-pr (D3), the refusal (D4) ----

/** Another workload's branch a train pushed to (issue #223's wl/wl-mv8s8srodefytc). */
const SHARED = "wl/wl-other";

/** Lane `lane-a` holds the workload while it writes `push-dest: <remote> <branch> <sha>`, then releases it. */
function pushDest(x: Closable, remote: string, branch: string, sha: string): void {
	expect(x.ledger.claimWorkload(x.wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 }).won).toBe(true);
	x.ledger.recordEntry({ by: "lane-a", workloadId: x.wl, kind: "assumption", body: `push-dest: ${remote} ${branch} ${sha}` });
	x.ledger.releaseWorkload(x.wl, { by: "lane-a", holder: "lane-a" });
}

/** Another workload whose `repo:` is `repo` (this clone unless given), with the runner's green (or `o.by`'s imitation) at `sha` for PR `pr`; its id. */
function foreignGreen(w: World, x: Closable, runId: string, pr: number, sha: string, o: { repo?: string; by?: string } = {}): string {
	const wl = x.ledger.openWorkload({ by: SURFACE_BY, brief: `Another workload's change, run ${runId}`, stakes: "normal", mode: "autonomous" });
	recordRepo(x.ledger, wl, o.repo ?? w.work);
	requested(x, runId, pr, sha, { wl });
	ran(x, runId, pr, sha, "green", { wl, ...(o.by ? { by: o.by } : {}) });
	return wl;
}

/** Jo's `waive-pr <wl> <N…>` as literal rows: the surface's instruction, then `waive-pr: <N…> <in-…>` naming it, written by `entryBy` (the surface unless given). */
function waivePr(x: Closable, numbers: number[], entryBy: string = SURFACE_BY): string {
	const ins = x.ledger.recordInstruction({ by: SURFACE_BY, workloadId: x.wl, body: `waive-pr ${x.wl} ${numbers.join(" ")}`, author: "jo", channel: "surface" });
	x.ledger.recordEntry({ by: entryBy, workloadId: x.wl, kind: "assumption", body: `waive-pr: ${numbers.join(" ")} ${ins}` });
	return ins;
}

/** A second clone of origin on main, where other workloads and Jo's side make their commits. */
function otherClone(w: World): string {
	const other = join(w.root, "other");
	g(w, w.root, "clone", "-q", ORIGIN_URL, other);
	return other;
}

/**
 * Issue #223's shape on the shared branch: #156 (b1) and #220 (b2), another workload's PRs merged before the train pushed, each
 * green only on that workload `y`; then the train's push p, PR #221, merged too. Every merge is a fast-forward of main. `state` is #221's.
 * The commits are the train-<state> template's (buildTrain); the PR list and y's greens are the test's own.
 */
function trainShape(state: "OPEN" | "MERGED" = "MERGED"): Fixture & { b1: string; b2: string; p: string; y: string } {
	const f = fixture(`train-${state}`);
	const { w, x } = f;
	prs(w, SHARED, [{ number: 156, state: "MERGED", headRefOid: T.b1 }, { number: 220, state: "MERGED", headRefOid: T.b2 }, { number: 221, state, headRefOid: T.p }]);
	const y = foreignGreen(w, x, "tr-156", 156, T.b1);
	requested(x, "tr-220", 220, T.b2, { wl: y });
	ran(x, "tr-220", 220, T.b2, "green", { wl: y });
	return { ...f, b1: T.b1, b2: T.b2, p: T.p, y };
}
/** The train-OPEN template: a second clone ("other") pushes b1 and b2 to the shared branch and main, then p to the shared branch and refs/pull/221/head; train-MERGED also merges p into main. */
function buildTrain(): void {
	const t = copyOf(template("origin").w, "close-fresh-template");
	const other = otherClone(t);
	g(t, other, "checkout", "-q", "-b", SHARED);
	T.b1 = commitFile(t, other, "f156.txt", "PR #156");
	g(t, other, "push", "-q", "origin", `${SHARED}:${SHARED}`, `${T.b1}:main`);
	T.b2 = commitFile(t, other, "f220.txt", "PR #220");
	g(t, other, "push", "-q", "origin", `${SHARED}:${SHARED}`, `${T.b2}:main`);
	T.p = commitFile(t, other, "f221.txt", "the train's PR #221");
	g(t, other, "push", "-q", "origin", `${SHARED}:${SHARED}`, `${T.p}:refs/pull/221/head`);
	templates["train-OPEN"] = { w: t, lane: null };
	const m = copyOf(t, "close-fresh-template");
	g(m, join(m.root, "other"), "push", "-q", "origin", `${T.p}:main`);
	templates["train-MERGED"] = { w: m, lane: null };
}

/**
 * Bindfix's shape (PR #104): the lane's commit s, green on this workload; main moves on (o); Jo's side merges main into wl/<id>
 * (h, a merge) and PR #7 merges at h through merge commit m (--no-ff). The lane's local branch follows to h, so there is no code delta.
 * The commits are the pastGreen template's (buildPastGreen); the fixture puts wl/<id> at h, here and on origin.
 */
function mergedPastGreen(): Fixture & { s: string; o: string; h: string; m: string; other: string } {
	const f = fixture("pastGreen", { lane: true });
	requested(f.x, "tr-1", 7, T.s);
	ran(f.x, "tr-1", 7, T.s, "green");
	prs(f.w, f.x.branch, [{ number: 7, state: "MERGED", headRefOid: T.h, mergeCommit: T.m }]);
	return { ...f, s: T.s, o: T.o, h: T.h, m: T.m, other: join(f.w.root, "other") };
}
/** The pastGreen template: in a second clone ("other"), o on main, h merging main into s, m merging h into main (pushed); the clone fetched. */
function buildPastGreen(): void {
	const t = copyOf(template("origin").w, "close-fresh-template");
	const other = otherClone(t);
	g(t, other, "fetch", "-q", t.work, LANE_REF);
	T.o = commitFile(t, other, "o.txt", "main moves on");
	g(t, other, "push", "-q", "origin", "main");
	g(t, other, "checkout", "-q", "-b", "jo-merge", T.s);
	g(t, other, "merge", "-q", "--no-ff", "--no-edit", "main");
	T.h = g(t, other, "rev-parse", "HEAD");
	g(t, other, "checkout", "-q", "main");
	g(t, other, "merge", "-q", "--no-ff", "--no-edit", T.h);
	T.m = g(t, other, "rev-parse", "HEAD");
	g(t, other, "push", "-q", "origin", "main");
	g(t, t.work, "fetch", "-q", "origin");
	templates.pastGreen = { w: t, lane: T.h };
}

describe("PLAN wl-mvfjen3q5mqi2o D1: a push-dest: branch's PR is in the close set only when its head carries this workload's push (issue #223)", () => {
	beforeAll(buildTrain);

	test("(a) #223: two older merged PRs on the shared branch, green only on another workload, stay out; the train's PR on its own green closes", async () => {
		const { w, x, p } = trainShape();
		pushDest(x, "origin", SHARED, p);
		requested(x, "tr-1", 221, p);
		ran(x, "tr-1", 221, p, "green");

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain("Close check: every PR in the set is green at its head.");
		expectPublishedOn(w, x, p);
		expect(ghCalls(w).slice(0, 2)).toEqual([listAll(x.branch), listAll(SHARED)]);
	}, 20_000);

	test("(b) a push recorded through another remote name (`push-dest: upstream …`) still keeps its PR, which needs its green", async () => {
		const { w, x, p } = trainShape("OPEN");
		pushDest(x, "upstream", SHARED, p);

		expectRefused(w, x, await close(w, x), "PR #221 has no test-run result: call lane_full_test", null);
		requested(x, "tr-1", 221, p);
		ran(x, "tr-1", 221, p, "green");

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain("Close check: every PR in the set is green at its head.");
	}, 20_000);

	test("(b) a pushed sha the full clone lacks even after fetching refs/pull/<N>/head is an answered no: every PR on the branch drops", async () => {
		const { w, x } = trainShape("OPEN");
		g(w, join(w.root, "other"), "push", "-q", "origin", `${SHARED}~2:refs/pull/156/head`, `${SHARED}~1:refs/pull/220/head`);
		pushDest(x, "origin", SHARED, "e".repeat(40));
		const calls: string[] = [];
		const pi = piOf(w, { before: (command, args) => calls.push([command, ...args].join(" ")) });

		const r = await close(w, x, pi);

		expect(r.closed).toBe(true);
		expect(r.text).toContain("Close check: no PR and no code delta.");
		expect(calls).toContain(`git -C ${w.work} fetch --quiet origin refs/pull/221/head`);
		expect(calls).toContain(`git -C ${w.work} rev-parse --is-shallow-repository`);
	}, 20_000);

	test("(b) in a shallow clone a pushed sha that is missing cannot be answered: the close refuses (fails closed)", async () => {
		const { w, x } = trainShape("OPEN");
		const other = join(w.root, "other");
		g(w, other, "push", "-q", "origin", `${SHARED}~2:refs/pull/156/head`);
		writeFileSync(join(w.work, ".git", "shallow"), `${g(w, w.work, "rev-list", "--max-parents=0", "HEAD")}\n`);
		expect(g(w, w.work, "rev-parse", "--is-shallow-repository")).toBe("true");
		pushDest(x, "origin", SHARED, "e".repeat(40));

		expectRefused(w, x, await close(w, x), `the close check could not answer: ${w.work} is a shallow clone, so git cannot say whether PR #156 on ${SHARED} carries the pushed eeeeeee`, null);
	}, 20_000);

	test("(b) in a shallow clone a no from merge-base is not an answer either: a boundary between the pushed sha and a PR head refuses", async () => {
		const { w, x, b1, b2 } = trainShape("OPEN");
		// This workload pushed b1; #220 (b2) and #221 (p) both descend from it. A shallow boundary at b2 hides that from git.
		pushDest(x, "origin", SHARED, b1);
		g(w, w.work, "fetch", "-q", "origin", SHARED);
		writeFileSync(join(w.work, ".git", "shallow"), `${b2}\n`);
		expect(g(w, w.work, "rev-parse", "--is-shallow-repository")).toBe("true");

		expectRefused(w, x, await close(w, x), `the close check could not answer: ${w.work} is a shallow clone, so git cannot say whether PR #220 on ${SHARED} carries the pushed ${s7(b1)}`, null);
	}, 20_000);

	test("(d) a push-dest PR that carries the pushed sha is in the set and still needs its own green; a test-requested: still brings in a dropped PR", async () => {
		const { w, x, b1, b2, p, y } = trainShape("OPEN");
		pushDest(x, "origin", SHARED, p);

		expectRefused(w, x, await close(w, x), "PR #221 has no test-run result: call lane_full_test", null);

		// #156 does not carry the push, but this workload's own red request on it brings it in, from the listed record (no gh pr view);
		// merged with a red own run, it passes on the other workload's newest runner green on main that contains its merge commit (D2)
		requested(x, "tr-1", 221, p);
		ran(x, "tr-1", 221, p, "green");
		requested(x, "tr-2", 156, b1);
		ran(x, "tr-2", 156, b1, "red");
		rmSync(join(w.bin, "gh.log"));

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain(`Close check: every other PR in the set is green at its head; PR #156 merged; covered by test-run tr-220 green at ${s7(b2)} (${y}), which contains merge commit ${s7(b1)}.`);
		expect(ghCalls(w).slice(0, 2)).toEqual([listAll(x.branch), listAll(SHARED)]);
		expect(ghCalls(w).some((c) => c.startsWith("pr view"))).toBe(false);
	}, 20_000);
});

describe("PLAN wl-mvfjen3q5mqi2o D2-D4: a merged PR no green of its own holds passes on a runner green on main that contains it, or on Jo's waive-pr", () => {
	beforeAll(buildPastGreen);

	test("(c) merged-never-run refuses with the D4 text, naming the merge commit, and no longer says lane_full_test", async () => {
		const { w, x, h, m } = mergedPastGreen();

		const r = await close(w, x);

		expectRefused(w, x, r, uncoveredReason(x, 7, h, m), h);
		expect(r.text).not.toContain("lane_full_test");
	}, 20_000);

	test("(c) it passes on another workload's runner green on main: one containing the merge commit, at the merged head, or after a revert (the integration-snapshot policy)", async () => {
		const shapes: { name: string; at: (w: World, k: { h: string; other: string }) => string; holds: (k: { m: string }) => string }[] = [
			{
				name: "the next PR on main",
				at: (w, k) => {
					const n = commitFile(w, k.other, "n.txt", "the next PR, merged");
					g(w, k.other, "push", "-q", "origin", "main");
					return n;
				},
				holds: (k) => `which contains merge commit ${s7(k.m)}`,
			},
			{ name: "the merged head itself", at: (_w, k) => k.h, holds: () => "at its merged head" },
			{
				name: "main after a revert of the PR's change",
				at: (w, k) => {
					const v = removeFile(w, k.other, "b.txt", "revert the PR's change");
					g(w, k.other, "push", "-q", "origin", "main");
					return v;
				},
				holds: (k) => `which contains merge commit ${s7(k.m)}`,
			},
		];
		for (const shape of shapes) {
			const k = mergedPastGreen();
			const { w, x } = k;
			const sha = shape.at(w, k);
			const y = foreignGreen(w, x, "tr-9", 8, sha);

			const r = await close(w, x);

			expect({ shape: shape.name, closed: r.closed }).toEqual({ shape: shape.name, closed: true });
			expect(r.text).toContain(`Close check: every other PR in the set is green at its head; PR #7 merged; covered by test-run tr-9 green at ${s7(sha)} (${y}), ${shape.holds(k)}.`);
			expectPublishedOn(w, x, k.h);
		}
	}, 60_000);

	test("(c) it passes on Jo's surface-written waive-pr, named in the why", async () => {
		const { w, x, h } = mergedPastGreen();
		const ins = waivePr(x, [7]);

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain(`Close check: every other PR in the set is green at its head; waived by Jo: #7 (${ins}).`);
		expectPublishedOn(w, x, h);
	}, 20_000);

	test("(c) still refused: a green off main, one that does not contain the merge, a lane's imitation, another repo's, one the clone lacks, a lane-written waive-pr", async () => {
		const shapes: { name: string; make: (w: World, x: Closable, k: { o: string; m: string; other: string }) => void }[] = [
			{
				name: "a green whose commit is on a side branch, not on main",
				make: (w, x, k) => {
					g(w, k.other, "checkout", "-q", "-b", "side");
					const q = commitFile(w, k.other, "q.txt", "a commit off main");
					g(w, k.other, "push", "-q", "origin", "side");
					foreignGreen(w, x, "tr-9", 8, q);
				},
			},
			{ name: "a green on main before the merge", make: (w, x, k) => void foreignGreen(w, x, "tr-9", 8, k.o) },
			{ name: "a lane-written green imitation", make: (w, x, k) => void foreignGreen(w, x, "tr-9", 8, onMain(w, k.other), { by: "lane-b" }) },
			{ name: "a green on a workload of another repository", make: (w, x, k) => void foreignGreen(w, x, "tr-9", 8, onMain(w, k.other), { repo: join(w.root, "elsewhere") }) },
			{ name: "a green at a commit the clone does not have", make: (w, x) => void foreignGreen(w, x, "tr-9", 8, "c".repeat(40)) },
			{ name: "a lane-written waive-pr", make: (_w, x) => void waivePr(x, [7], "lane-a") },
		];
		for (const shape of shapes) {
			const k = mergedPastGreen();
			const { w, x } = k;
			shape.make(w, x, k);

			const r = await close(w, x);

			expect({ shape: shape.name, text: r.text }).toEqual({ shape: shape.name, text: `${x.wl} cannot close: ${uncoveredReason(x, 7, k.h, k.m)}` });
			expectRefused(w, x, r, uncoveredReason(x, 7, k.h, k.m), k.h);
		}
	}, 90_000);

	test("D2: two merged PRs and one green on main that contains only one merge commit: only that PR is covered", async () => {
		const { w, x } = fixture("origin");
		const other = otherClone(w);
		const c1 = commitFile(w, other, "c1.txt", "PR #7, merged");
		const c2 = commitFile(w, other, "c2.txt", "another workload's PR, merged");
		const c3 = commitFile(w, other, "c3.txt", "PR #8, merged");
		g(w, other, "push", "-q", "origin", "main");
		prs(w, x.branch, [{ number: 7, state: "MERGED", headRefOid: c1 }, { number: 8, state: "MERGED", headRefOid: c3 }]);
		foreignGreen(w, x, "tr-9", 9, c2);

		expectRefused(w, x, await close(w, x), uncoveredReason(x, 8, c3, c3), null);

		// a newer green at c3 holds both: #8 at its merged head, #7 through its merge commit
		const z = foreignGreen(w, x, "tr-10", 10, c3);
		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain(
			`Close check: every other PR in the set is green at its head; PR #7 merged; covered by test-run tr-10 green at ${s7(c3)} (${z}), which contains merge commit ${s7(c1)}; PR #8 merged; covered by test-run tr-10 green at ${s7(c3)} (${z}), at its merged head.`,
		);
	}, 20_000);

	test("(d) an open PR never passes on another workload's green or on Jo's waive-pr", async () => {
		const { w, x, sha: s } = merged("OPEN");
		foreignGreen(w, x, "tr-9", 8, s);
		waivePr(x, [7]);

		expectRefused(w, x, await close(w, x), "PR #7 has no test-run result: call lane_full_test", s);
	}, 20_000);

	test("(e) a merged PR whose own newest run is red, error or red-main off a train passes on another workload's runner green on main that contains its merge commit", async () => {
		for (const verdict of ["red", "error", "red-main"] as const) {
			const { w, x, sha: s } = merged();
			requested(x, "tr-1", 7, s);
			ran(x, "tr-1", 7, s, verdict);
			const n = onMain(w, otherClone(w));
			const y = foreignGreen(w, x, "tr-9", 8, n);

			const r = await close(w, x);

			expect({ verdict, closed: r.closed }).toEqual({ verdict, closed: true });
			expect(r.text).toContain(`Close check: every other PR in the set is green at its head; PR #7 merged; covered by test-run tr-9 green at ${s7(n)} (${y}), which contains merge commit ${s7(s)}.`);
			expectPublishedOn(w, x, s);
		}
	}, 30_000);

	test("(e) a merged PR whose own newest run is red passes on Jo's surface-written waive-pr, named in the why", async () => {
		const { w, x, sha: s } = merged();
		requested(x, "tr-1", 7, s);
		ran(x, "tr-1", 7, s, "red");
		const ins = waivePr(x, [7]);

		const r = await close(w, x);

		expect(r.closed).toBe(true);
		expect(r.text).toContain(`Close check: every other PR in the set is green at its head; waived by Jo: #7 (${ins}).`);
		expectPublishedOn(w, x, s);
	}, 20_000);

	test("(e) with neither a cover nor a waiver a merged red, stale or off-train red-main PR keeps its refusal with D4's two ways appended; an open red PR is unchanged", async () => {
		const shapes: { name: string; state: "OPEN" | "MERGED"; verdict: TestVerdict; make?: (w: World, x: Closable, s: string) => void; reason: (x: Closable, s: string) => string }[] = [
			{ name: "merged, red", state: "MERGED", verdict: "red", reason: (x, s) => `PR #7's newest test-run tr-1 is red${mergedRed(x, 7, s)}` },
			{ name: "merged, stale", state: "MERGED", verdict: "stale", reason: (x, s) => `PR #7's newest test-run tr-1 is stale${mergedRed(x, 7, s)}` },
			{
				name: "merged, red, a lane-written waive-pr", state: "MERGED", verdict: "red", make: (_w, x) => void waivePr(x, [7], "lane-a"),
				reason: (x, s) => `PR #7's newest test-run tr-1 is red${mergedRed(x, 7, s)}`,
			},
			{
				name: "merged, red-main off a train", state: "MERGED", verdict: "red-main",
				reason: (x, s) => `PR #7's newest test-run tr-1 is red-main: it passes only a train PR the train merged at that head; it also passes ${waysThrough(x, 7, s)}`,
			},
			{
				name: "open, red, with a green on main and Jo's waive-pr", state: "OPEN", verdict: "red",
				make: (w, x) => {
					foreignGreen(w, x, "tr-9", 8, onMain(w, otherClone(w)));
					waivePr(x, [7]);
				},
				reason: () => `PR #7's newest test-run tr-1 is red${OPEN_RED}`,
			},
		];
		for (const shape of shapes) {
			const { w, x, sha: s } = merged(shape.state);
			requested(x, "tr-1", 7, s);
			ran(x, "tr-1", 7, s, shape.verdict);
			shape.make?.(w, x, s);

			const r = await close(w, x);

			expect({ shape: shape.name, text: r.text }).toEqual({ shape: shape.name, text: `${x.wl} cannot close: ${shape.reason(x, s)}` });
			expectRefused(w, x, r, shape.reason(x, s), s);
		}
	}, 45_000);
});

/** A new commit on main in `other`, pushed; its sha. */
function onMain(w: World, other: string): string {
	const n = commitFile(w, other, "n.txt", "the next PR, merged");
	g(w, other, "push", "-q", "origin", "main");
	return n;
}
