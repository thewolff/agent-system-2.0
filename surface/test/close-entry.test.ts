// The close tool's git path (MIGRATION.md § "M7 follow-ups" items 11, 12; surface/src/close-entry.ts):
// the decision-log entry is committed on the workload's lane branch wl/<id> (through the lane
// worktree, a temporary worktree, or a branch cut from origin/main), never on the checkout's main,
// then pushed with an open PR made sure of. Real git on a bare origin plus a clone; `pi.exec`
// spawns the real command with a fake `gh` first on PATH that records its argv. The pinned
// candidate (MIGRATION.md item 24, PLAN § 2.4 item 4) is driven through the commit and publish
// steps directly; the close check that sets the pin is surface/test/close-fresh.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { closeWorkloadWithEntry } from "../extensions/workload";
import { commitCloseEntry, publishEntry, TEST_RUNNER_CONFIG_ENV } from "../src/close-entry";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { branchName, worktreePath } from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY, type SurfaceAPI } from "../src/types";
import { LEDGER_DB_ENV } from "../../ledger/src/locality";
import { ISSUES_CONFIG_ENV } from "../src/issues/config";
import { closesFooter } from "../src/issues/footer";
import { Sidecar, sidecarPath } from "../src/issues/sidecar";
import { switchBody } from "../src/issues/switch";
import { trackerEntryBody } from "../src/issues/tracker";
import { clock, tempLedger, tmp } from "./helpers";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const PR_URL = "https://github.com/example/repo/pull/7";
const GH = `#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "\${*//$'\\n'/<NL>}" >> "$dir/gh.log"
case "$1 $2" in
  "pr list") if [ -f "$dir/open-pr" ]; then printf '[{"url":"%s"}]\\n' "$(cat "$dir/open-pr")"; else echo '[]'; fi ;;
  "pr create") echo "${PR_URL}" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`;

interface World {
	root: string;
	work: string;
	bin: string;
	env: Record<string, string>;
}

/** A canonical scratch root with a fake `gh`, and git isolated from the machine's config (no signing, no hooks but the repo's). */
function world(): World {
	const root = realpathSync(tmp("close"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), GH);
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(join(root, "gitconfig"), "");
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
	};
	return { root, work: join(root, "work"), bin, env };
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
	writeFileSync(join(cwd, file), `${msg}\n`);
	g(w, cwd, "add", file);
	g(w, cwd, "commit", "-q", "-m", msg);
	return g(w, cwd, "rev-parse", "HEAD");
}

/** A bare origin plus a clone on main with one pushed commit and origin/HEAD recorded (gates/test/helpers.ts `repoWithOrigin`). */
function withOrigin(w: World): string {
	const origin = join(w.root, "origin.git");
	g(w, w.root, "init", "-q", "--bare", "-b", "main", origin);
	mkdirSync(w.work);
	g(w, w.work, "init", "-q", "-b", "main");
	g(w, w.work, "remote", "add", "origin", origin);
	commitFile(w, w.work, "a.txt", "init");
	g(w, w.work, "push", "-q", "origin", "main");
	g(w, w.work, "fetch", "-q", "origin");
	g(w, w.work, "remote", "set-head", "origin", "main");
	return origin;
}

/** The surface's API as the close uses it: `exec` spawns the real command in the world's environment. */
function piOf(w: World, o: { exec?: boolean } = {}): SurfaceAPI {
	const exec = async (command: string, args: string[], opts?: { timeout?: number; cwd?: string }) => {
		const r = Bun.spawnSync([command, ...args], { cwd: opts?.cwd ?? w.root, env: w.env, stdout: "pipe", stderr: "pipe", ...(opts?.timeout ? { timeout: opts.timeout } : {}) });
		return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode ?? -1, killed: "exitedDueToTimeout" in r && r.exitedDueToTimeout === true };
	};
	return { appendEntry: () => {}, ...(o.exec === false ? {} : { exec }) } as unknown as SurfaceAPI;
}

/** A released workload ready to close (no done: line, no slices) on `repo`. */
function closable(repo: string): { ledger: Ledger; wl: string; now: () => string } {
	const c = clock("2026-10-01T10:00:00.000Z");
	const { ledger } = tempLedger(c.now);
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	recordRepo(ledger, wl, repo);
	return { ledger, wl, now: c.now };
}
const close = (pi: SurfaceAPI, x: { ledger: Ledger; wl: string; now: () => string }, cwd: string, env: Record<string, string> = {}) =>
	closeWorkloadWithEntry(pi, x.ledger, env, x.wl, { now: x.now(), cwd, receipt: null });
const ghCalls = (w: World): string[] => (existsSync(join(w.bin, "gh.log")) ? readFileSync(join(w.bin, "gh.log"), "utf8").trim().split("\n") : []);
const worktrees = (w: World): string[] => g(w, w.work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
const remoteSha = (w: World, branch: string): string => g(w, w.work, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] ?? "";
const subject = (w: World, ref: string): string => g(w, w.work, "log", "-1", "--format=%s", ref);

describe("close: the decision-log entry rides the lane branch wl/<id>, never the checkout's main", () => {
	test("(a) the lane worktree has wl/<id> checked out: committed there, pushed; an open PR is reused, none created; the checkout is untouched", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w.work);
		const branch = branchName(x.wl);
		const lane = worktreePath(w.work, x.wl);
		g(w, w.work, "worktree", "add", "-q", "-b", branch, lane, "origin/main");
		const laneWork = commitFile(w, lane, "b.txt", "the lane's change");
		g(w, lane, "push", "-q", "-u", "origin", branch);
		writeFileSync(join(w.bin, "open-pr"), PR_URL);
		const mainBefore = g(w, w.work, "rev-parse", "main");

		const r = await close(piOf(w), x, w.work);

		expect(r.closed).toBe(true);
		const d = r.details as { path: string; branch: string; commit: string | null; push: string | null; pr: string | null };
		expect(d.path.startsWith(join(lane, ".ai", "decision-log"))).toBe(true);
		expect(d).toMatchObject({ branch, commit: null, push: null, pr: PR_URL });
		expect(r.text).toBe(`Closed ${x.wl}. Decision-log entry ${d.path} committed on ${branch}; pushed to origin; PR open: ${PR_URL}.`);
		expect(g(w, lane, "ls-files", "--error-unmatch", d.path)).toBe(d.path.slice(lane.length + 1));
		expect(subject(w, branch)).toBe(`docs: decision-log entry ${d.path.replace(/^.*\//, "").replace(/\.md$/, "")} (workload ${x.wl})`);
		expect(g(w, w.work, "rev-parse", `${branch}~1`)).toBe(laneWork);
		expect(g(w, lane, "status", "--porcelain")).toBe("");
		expect(g(w, w.work, "rev-parse", "main")).toBe(mainBefore);
		expect(g(w, w.work, "status", "--porcelain")).toBe("");
		expect(remoteSha(w, branch)).toBe(g(w, w.work, "rev-parse", branch));
		expect(ghCalls(w)).toEqual([`pr list --head ${branch} --state open --json url`]);
	});

	test("(b) wl/<id> exists with no worktree: committed through a temporary worktree that is removed, pushed, and a PR created when gh lists none", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w.work);
		const branch = branchName(x.wl);
		g(w, w.work, "branch", branch, "origin/main");
		const base = g(w, w.work, "rev-parse", branch);

		const r = await close(piOf(w), x, w.work);

		expect(r.closed).toBe(true);
		const d = r.details as { path: string; commit: string | null; push: string | null; pr: string | null };
		expect(d.path).toMatch(new RegExp(`^${branch}:\\.ai/decision-log/2026-10-01--\\d{4}--orchestrator--fix-the-feed-header-offset\\.md$`));
		expect(d).toMatchObject({ commit: null, push: null, pr: PR_URL });
		expect(r.text).toContain(`committed on ${branch}; pushed to origin; PR opened: ${PR_URL}.`);
		expect(g(w, w.work, "show", d.path)).toContain(`workload: ${x.wl}`);
		expect(g(w, w.work, "rev-parse", `${branch}~1`)).toBe(base);
		expect(worktrees(w)).toEqual([`worktree ${w.work}`]);
		expect(g(w, w.work, "status", "--porcelain")).toBe("");
		expect(remoteSha(w, branch)).toBe(g(w, w.work, "rev-parse", branch));
		const calls = ghCalls(w);
		expect(calls).toHaveLength(2);
		expect(calls[1]!.startsWith(`pr create --head ${branch} --base main --title docs: decision-log entry `)).toBe(true);
		expect(calls[1]).toContain(`(workload ${x.wl}) --body `);
	});

	test("(c) no lane branch and local main holds an unpushed commit: wl/<id> is cut from origin/main, the entry committed and pushed, a PR created; main untouched", async () => {
		const w = world();
		withOrigin(w);
		const pushed = g(w, w.work, "rev-parse", "origin/main");
		const unpushed = commitFile(w, w.work, "local.txt", "Jo's local unpushed commit");
		const x = closable(w.work);
		const branch = branchName(x.wl);

		const r = await close(piOf(w), x, w.work);

		expect(r.closed).toBe(true);
		expect(r.details).toMatchObject({ commit: null, push: null, pr: PR_URL });
		expect(g(w, w.work, "rev-parse", `${branch}~1`)).toBe(pushed);
		expect(sh(w, w.work, ["git", "merge-base", "--is-ancestor", unpushed, branch]).code).toBe(1);
		expect(subject(w, branch)).toMatch(new RegExp(`^docs: decision-log entry .* \\(workload ${x.wl}\\)$`));
		expect(g(w, w.work, "rev-parse", "main")).toBe(unpushed);
		expect(g(w, w.work, "status", "--porcelain")).toBe("");
		expect(worktrees(w)).toEqual([`worktree ${w.work}`]);
		expect(remoteSha(w, branch)).toBe(g(w, w.work, "rev-parse", branch));
		// no upstream from origin/main: the push set it to the branch's own remote
		expect(g(w, w.work, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`)).toBe(`origin/${branch}`);
		expect(ghCalls(w).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["pr list", "pr create"]);
	});

	test("(d) the host has no exec: the close still closes, the entry is rendered untracked in the checkout and the reason named; nothing is committed", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w.work);
		const mainBefore = g(w, w.work, "rev-parse", "main");
		// A profile that serves no repo: with no exec, git cannot say whether a served repo's close check passes (close-fresh.test.ts).
		writeFileSync(join(w.root, "config.yml"), "setupVersion: 2\n");

		const r = await close(piOf(w, { exec: false }), x, w.work, { [TEST_RUNNER_CONFIG_ENV]: join(w.root, "config.yml") });

		expect(r.closed).toBe(true);
		const d = r.details as { path: string; commit: string | null; push: string | null; pr: string | null };
		expect(d.path.startsWith(join(w.work, ".ai", "decision-log"))).toBe(true);
		expect(existsSync(d.path)).toBe(true);
		expect(r.text).toBe(`Closed ${x.wl}. Decision-log entry rendered at ${d.path}; not committed: the host has no exec for extensions (the file is untracked; commit it on ${branchName(x.wl)} by hand).`);
		expect(g(w, w.work, "rev-parse", "main")).toBe(mainBefore);
		expect(sh(w, w.work, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName(x.wl)}`]).code).not.toBe(0);
		expect(x.ledger.workload(x.wl)!.status).toBe("closed");
	});

	test("(d) no origin and a commit that fails: the close still closes with the reason, the temporary worktree is gone, nothing lands on main or the branch, nothing is pushed", async () => {
		const w = world();
		mkdirSync(w.work);
		g(w, w.work, "init", "-q", "-b", "main");
		const mainBefore = commitFile(w, w.work, "a.txt", "init");
		writeFileSync(join(w.work, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho refused by the hook >&2\nexit 1\n");
		chmodSync(join(w.work, ".git", "hooks", "pre-commit"), 0o755);
		const x = closable(w.work);
		const branch = branchName(x.wl);

		const r = await close(piOf(w), x, w.work);

		expect(r.closed).toBe(true);
		const d = r.details as { path: string; commit: string | null; push: string | null; pr: string | null };
		expect(d.commit).toBe("git commit exited 1: refused by the hook");
		expect(r.text).toContain("not committed: git commit exited 1: refused by the hook (the file is untracked;");
		expect(existsSync(d.path)).toBe(true);
		expect(d.path.startsWith(join(w.work, ".ai", "decision-log"))).toBe(true);
		// the branch was cut from local main (no origin) and holds nothing new
		expect(g(w, w.work, "rev-parse", branch)).toBe(mainBefore);
		expect(g(w, w.work, "rev-parse", "main")).toBe(mainBefore);
		expect(worktrees(w)).toEqual([`worktree ${w.work}`]);
		expect(ghCalls(w)).toEqual([]);
	});

	test("(e) a re-close renders the identical entry: it is not committed twice (the stays-open path, driven through the commit step directly)", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w.work);
		const branch = branchName(x.wl);
		const pi = piOf(w);
		const first = await commitCloseEntry(pi, x.ledger, {}, x.wl, w.work);
		expect(first).toMatchObject({ commit: null, already: false });
		const tip = g(w, w.work, "rev-parse", branch);
		const again = await commitCloseEntry(pi, x.ledger, {}, x.wl, w.work);
		expect(again).toMatchObject({ commit: null, already: true, path: first.path });
		expect(g(w, w.work, "rev-parse", branch)).toBe(tip);
		expect(worktrees(w)).toEqual([`worktree ${w.work}`]);
	});

	test("PLAN wl-mv5i3lulwwbbi8 D2: an unserved repo's superseded workload closes without a receipt; the entry names the successor", async () => {
		const w = world();
		withOrigin(w);
		const x = closable(w.work);
		x.ledger.recordEntry({ by: SURFACE_BY, workloadId: x.wl, kind: "assumption", body: "done: the feed header sits at its offset" });
		const by = x.ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header offset, done over", stakes: "normal", mode: "autonomous" });
		const ins = x.ledger.recordInstruction({ by: SURFACE_BY, workloadId: x.wl, body: `supersede ${x.wl} ${by}`, author: "jo", channel: "surface" });
		x.ledger.recordEntry({ by: SURFACE_BY, workloadId: x.wl, kind: "assumption", body: `superseded: ${by} ${ins}` });

		const r = await close(piOf(w), x, w.work);

		expect(r.closed).toBe(true);
		const d = r.details as { path: string };
		expect(g(w, w.work, "show", d.path)).toContain(`- orchestrator (surface): close receipt: superseded by ${by} (Jo, ${ins})`);
		expect(x.ledger.instructions(x.wl).map((i) => i.body)).toContain(`close receipt: superseded by ${by} (Jo, ${ins})`);
	});
});

describe("close: the pinned candidate C (MIGRATION.md item 24, PLAN § 2.4 item 4)", () => {
	/** A lane worktree on wl/<id> with one commit pushed: the candidate a passed check pins. */
	function pinned(w: World) {
		withOrigin(w);
		const x = closable(w.work);
		const branch = branchName(x.wl);
		const lane = worktreePath(w.work, x.wl);
		g(w, w.work, "worktree", "add", "-q", "-b", branch, lane, "origin/main");
		const c = commitFile(w, lane, "b.txt", "the lane's change");
		g(w, lane, "push", "-q", "-u", "origin", branch);
		return { x, branch, lane, c, pin: { sha: c, ownerRepo: "example/repo" } };
	}

	test("(f) the tip is still C: D is committed with the single parent C, touching only .ai/decision-log/, and pushed as D:refs/heads/wl/<id> with gh naming the repo", async () => {
		const w = world();
		const { x, branch, c, pin } = pinned(w);
		const pi = piOf(w);

		const e = await commitCloseEntry(pi, x.ledger, {}, x.wl, w.work, pin);

		const d = g(w, w.work, "rev-parse", branch);
		expect(e).toMatchObject({ commit: null, refused: null, already: false, publish: { sha: d, ownerRepo: "example/repo" } });
		expect(g(w, w.work, "rev-list", "--parents", "-n", "1", d)).toBe(`${d} ${c}`);
		expect(g(w, w.work, "diff-tree", "-r", "--no-commit-id", "--name-only", c, d)).toMatch(/^\.ai\/decision-log\/[^\n]+\.md$/);
		const p = await publishEntry(pi, e, x.wl);
		expect(p).toMatchObject({ push: null, pr: PR_URL, prCreated: true });
		expect(remoteSha(w, branch)).toBe(d);
		expect(ghCalls(w).map((l) => l.split(" ").slice(0, 6).join(" "))).toEqual([`pr list -R example/repo --head ${branch}`, `pr create -R example/repo --head ${branch}`]);
	});

	test("(g) the branch moved after the check: the commit is refused, nothing is rendered or committed, the temporary worktree is gone", async () => {
		const w = world();
		const { x, branch, lane, c, pin } = pinned(w);
		const moved = commitFile(w, lane, "c.txt", "a commit after the check");

		const e = await commitCloseEntry(piOf(w), x.ledger, {}, x.wl, w.work, pin);

		expect(e).toMatchObject({ publish: null, refused: `${branch} moved after the close check: it is at ${moved.slice(0, 7)}, not the checked ${c.slice(0, 7)}; close again to re-check` });
		expect(g(w, w.work, "rev-parse", branch)).toBe(moved);
		expect(existsSync(join(lane, ".ai", "decision-log")) ? readdirSync(join(lane, ".ai", "decision-log")) : []).toEqual([]);
		expect(existsSync(join(w.work, ".ai", "decision-log"))).toBe(false);
		expect(g(w, lane, "status", "--porcelain")).toBe("");
		// with no worktree on the branch, the temporary one is removed on the refusal too
		g(w, w.work, "worktree", "remove", lane);
		const again = await commitCloseEntry(piOf(w), x.ledger, {}, x.wl, w.work, pin);
		expect(again.refused).toStartWith(`${branch} moved after the close check`);
		expect(worktrees(w)).toEqual([`worktree ${w.work}`]);
		expect(remoteSha(w, branch)).toBe(c);
	});

	test("(h) the remote moved after the check: the by-sha push is a plain fast-forward and is refused, named, never forced", async () => {
		const w = world();
		const { x, branch, c, pin } = pinned(w);
		const other = join(w.root, "other");
		g(w, w.root, "clone", "-q", join(w.root, "origin.git"), other);
		g(w, other, "checkout", "-q", branch);
		const theirs = commitFile(w, other, "z.txt", "pushed from elsewhere");
		g(w, other, "push", "-q", "origin", branch);
		const pi = piOf(w);

		const e = await commitCloseEntry(pi, x.ledger, {}, x.wl, w.work, pin);
		expect(e.refused).toBeNull();
		const p = await publishEntry(pi, e, x.wl);

		expect(p.push).toMatch(/^git push exited 1: /);
		expect(remoteSha(w, branch)).toBe(theirs);
		expect(g(w, w.work, "rev-parse", `${branch}~1`)).toBe(c);
	});

	test("(i) review r1, kimi note 2: under the pin a failed commit refuses; nothing is rendered untracked in the checkout and nothing is published", async () => {
		const w = world();
		const { x, branch, lane, c, pin } = pinned(w);
		g(w, w.work, "worktree", "remove", lane);
		writeFileSync(join(w.work, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
		chmodSync(join(w.work, ".git", "hooks", "pre-commit"), 0o755);

		const e = await commitCloseEntry(piOf(w), x.ledger, {}, x.wl, w.work, pin);

		expect(e).toMatchObject({ path: "", publish: null, refused: `the entry commit on ${branch} failed: git commit exited 1: hook says no` });
		expect(existsSync(join(w.work, ".ai", "decision-log"))).toBe(false);
		expect(g(w, w.work, "rev-parse", branch)).toBe(c);
		expect(worktrees(w)).toEqual([`worktree ${w.work}`]);
		// unpinned, the same failure still renders the entry untracked for a commit by hand (decision 13)
		const loose = await commitCloseEntry(piOf(w), x.ledger, {}, x.wl, w.work);
		expect(loose).toMatchObject({ commit: "git commit exited 1: hook says no", refused: null, publish: null });
		expect(existsSync(loose.path)).toBe(true);
	});

	test("(j) review r1, kimi note 1: the receipt is rendered into the entry and not recorded; the ledger gets it only from the close", async () => {
		const w = world();
		const { x, c, pin } = pinned(w);

		const e = await commitCloseEntry(piOf(w), x.ledger, {}, x.wl, w.work, pin, "shipped");

		expect(e.refused).toBeNull();
		expect(readFileSync(e.path, "utf8")).toContain("- orchestrator (surface): close receipt: shipped");
		expect(x.ledger.instructions(x.wl).map((i) => i.body)).toEqual([]);
		expect(g(w, w.work, "rev-parse", `${branchName(x.wl)}~1`)).toBe(c);
	});
});

describe("close: a decision-log PR the close creates carries the issue's Closes footer (PLAN wl-mv66ylim0gahog § 5, § 13.2 footer guard)", () => {
	const BODY = (wl: string) => `The decision-log entry rendered when workload ${wl} closed, committed on its lane branch ${branchName(wl)} by the orchestrator surface's close.`;
	const CONFIG = "issues:\n  trackers:\n    - match: example/repo\n      kind: github\n    - match: ContextPress/*\n      kind: linear\n      team: ENG\n  jo: jo\n";

	/**
	 * A committed entry on a lane branch whose origin reads `https://github.com/example/repo.git` (git rewrites it to the bare
	 * scratch origin with `insteadOf`, so pushes stay local), an issues config, a sidecar whose link for the workload has `issue`
	 * on `linkRepo` (tracker `github` unless `tracker` says otherwise), the switch as given, and a `tracker:` entry when `entry` names one.
	 */
	async function setup(o: { on: boolean; issue: number | null | "nolink" | "nosidecar"; config?: boolean; linkRepo?: string; tracker?: string; externalId?: string; entry?: "linear" }) {
		const w = world();
		const origin = withOrigin(w);
		writeFileSync(join(w.root, "gitconfig"), `[url "${origin}"]\n\tinsteadOf = https://github.com/example/repo.git\n`);
		g(w, w.work, "remote", "set-url", "origin", "https://github.com/example/repo.git");
		const x = closable(w.work);
		const branch = branchName(x.wl);
		g(w, w.work, "worktree", "add", "-q", "-b", branch, worktreePath(w.work, x.wl), "origin/main");
		const env: Record<string, string> = {
			[LEDGER_DB_ENV]: join(w.root, "ledger.db"),
			[ISSUES_CONFIG_ENV]: join(w.root, "config.yml"),
		};
		if (o.config !== false) writeFileSync(env[ISSUES_CONFIG_ENV]!, CONFIG);
		ensureStandingWorkload(x.ledger);
		x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(o.on, "in-sw1") });
		if (o.entry === "linear") x.ledger.recordEntry({ by: SURFACE_BY, workloadId: x.wl, kind: "assumption", body: trackerEntryBody(x.wl, { kind: "linear", team: "ENG" }, "in-tr1") });
		if (o.issue !== "nosidecar") {
			const sc = Sidecar.open(sidecarPath(env));
			if (o.issue !== "nolink") {
				sc.upsertLink(x.wl, { repo: o.linkRepo ?? "example/repo", dirty: false, lastSeq: 1 });
				sc.db.query("UPDATE links SET issue_number = ?, tracker = ?, external_id = ? WHERE workload_id = ?").run(o.issue, o.tracker ?? "github", o.externalId ?? null, x.wl);
			}
			sc.close();
		}
		const pi = piOf(w);
		const e = await commitCloseEntry(pi, x.ledger, env, x.wl, w.work);
		expect(e.commit).toBeNull();
		return { w, x, pi, e, env, sidecar: sidecarPath(env) };
	}
	const createBody = (w: World): string => {
		const line = ghCalls(w).find((l) => l.startsWith("pr create"));
		return (line ?? "").split(" --body ")[1]?.replaceAll("<NL>", "\n") ?? "";
	};
	const verbs = (w: World): string[] => ghCalls(w).map((l) => l.split(" ").slice(0, 2).join(" "));

	test("on with a linked issue: the created PR's body ends with the footer; the calls are pr list then pr create", async () => {
		const { w, x, pi, e } = await setup({ on: true, issue: 42 });
		const p = await publishEntry(pi, e, x.wl);
		expect(p).toMatchObject({ pr: PR_URL, prCreated: true });
		expect(createBody(w)).toBe(`${BODY(x.wl)}${closesFooter(42)}`);
		expect(createBody(w).endsWith("\n\n<!-- as2 -->\nCloses #42")).toBe(true);
		expect(verbs(w)).toEqual(["pr list", "pr create"]);
	});

	test("an open PR is found: no extra gh call and no sidecar write", async () => {
		const { w, x, pi, e, sidecar } = await setup({ on: true, issue: 42 });
		writeFileSync(join(w.bin, "open-pr"), PR_URL);
		const before = readFileSync(sidecar);
		const p = await publishEntry(pi, e, x.wl);
		expect(p).toMatchObject({ pr: PR_URL, prCreated: false });
		expect(verbs(w)).toEqual(["pr list"]);
		expect(readFileSync(sidecar).equals(before)).toBe(true);
	});

	test.each([
		["the switch is off", { on: false, issue: 42 as const }],
		["there is no issues config", { on: true, issue: 42 as const, config: false }],
		["there is no sidecar", { on: true, issue: "nosidecar" as const }],
		["the workload has no link", { on: true, issue: "nolink" as const }],
		["the link has no issue number yet", { on: true, issue: null }],
		["the link's repo is not the repo the PR is created in", { on: true, issue: 42 as const, linkRepo: "example/other" }],
		["a tracker word moved the workload to Linear and the move has not run yet (the link still holds #42)", { on: true, issue: 42 as const, entry: "linear" as const }],
		["after the move to Linear (number cleared, a Linear issue linked)", { on: true, issue: null, tracker: "linear:ENG", externalId: "iss-1", entry: "linear" as const }],
	])("%s: the body is exactly the plain body and the close proceeds", async (_name, o) => {
		const { w, x, pi, e } = await setup(o);
		const p = await publishEntry(pi, e, x.wl);
		expect(p).toMatchObject({ pr: PR_URL, prCreated: true });
		expect(createBody(w)).toBe(BODY(x.wl));
		expect(verbs(w)).toEqual(["pr list", "pr create"]);
	});

	test("a sidecar that cannot be read is not an error: the plain body", async () => {
		const { w, x, pi, e, sidecar } = await setup({ on: true, issue: 42 });
		writeFileSync(sidecar, "this is not a sqlite database, only text padding it out to be longer than a header");
		const p = await publishEntry(pi, e, x.wl);
		expect(p).toMatchObject({ pr: PR_URL, prCreated: true });
		expect(createBody(w)).toBe(BODY(x.wl));
	});
});
