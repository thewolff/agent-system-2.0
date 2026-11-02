// The land-first merge hold in row 6 (PLAN wl-mvq4edbaf13vnk § 2 "The merge hold", D10, R20) and the verified control
// root's protection in row 10 and the fence (§ 2 "Integrity of the hold's and the verifier's inputs", R29).
// The hold reads the ledger through an injected reader (MergeHold), so these tests build the standing workload's rows
// in memory, shaped as the surface, the tick and the runner write them.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryRow, type InstructionRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import { landFirstBody, landFirstInstructionBody } from "../../surface/src/launch";
import { trainReconciledBody } from "../../surface/src/merge-train";
import { type ExecCounts, testRunBody, type TestVerdict } from "../../surface/src/test-run";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { fenceProfile, fenceTargets } from "../src/fence";
import { checkReserved, type MergeHold, reservedAction } from "../src/rows/r06-reserved";
import { checkRawLedgerWrite } from "../src/rows/r10-raw-ledger";
import type { CallContext, Refusal } from "../src/types";
import { tmp } from "./helpers";

const REPO = "thewolff/agent-system-2.0";
const OTHER = "thewolff/elsewhere";
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const sha = (c: string) => c.repeat(40);
const HEAD = sha("a");
const EXEC: ExecCounts = { files: 100, tests: 1000, treeFiles: 100 };

const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" };
const ctx: CallContext = { role: "lane", cwd: "/work/repo", env };

/** The standing workload's rows, oldest first, as each writer records them. */
class Standing {
	entries: EntryRow[] = [];
	instructions: InstructionRow[] = [];
	#n = 0;
	entry(body: string, by: string, minAgo: number): string {
		const id = `en-${++this.#n}`;
		this.entries.push({ id, workload_id: STANDING_WORKLOAD_ID, slice_id: null, kind: "assumption", body, created_by: by, created_at: at(minAgo) });
		return id;
	}
	/** Jo's `land-first <repo> on|off` and the surface's `land-first:` record of it. */
	landFirst(repo: string, on: boolean, minAgo = 600): this {
		const id = `in-${++this.#n}`;
		this.instructions.push({
			id, workload_id: STANDING_WORKLOAD_ID, slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "cli", author: "jo",
			body: landFirstInstructionBody(repo, on), created_by: SURFACE_BY, created_at: at(minAgo),
		} as InstructionRow);
		this.entry(landFirstBody(repo, on, id), SURFACE_BY, minAgo);
		return this;
	}
	/** The tick's `train-reconciled:` for `repo`, written `minAgo` minutes before now. */
	reconciled(minAgo: number, over: { repo?: string; open?: boolean; oldest?: number | null; repair?: string | null; by?: string } = {}): this {
		const body = trainReconciledBody({
			repo: over.repo ?? REPO, at: at(minAgo), tip: sha("b"), g: sha("c"), open: over.open ?? true,
			oldest: over.oldest === undefined || over.oldest === null ? null : at(over.oldest), repair: over.repair ?? null, read: null,
			reasons: over.open === false ? "main red at bbbbbbb" : "",
		});
		this.entry(body, over.by ?? MERGE_TRAIN_BY, minAgo);
		return this;
	}
	/** The runner's main-run settle at `commit`. */
	settle(commit: string, verdict: TestVerdict, minAgo: number, exec: ExecCounts | null = EXEC): this {
		const runId = `tr-0main${this.#n + 1}`;
		const body = testRunBody({
			runId, verdict, sha: commit, pr: 0, reason: verdict === "green" || verdict === "red" || verdict === "red-main" ? null : "runner died", headAtEnd: commit, base: null, mergeBase: null,
			full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: "full", main: true, host: "mac", exec,
			...(verdict === "red-main" ? { baseCompare: { sha: sha("f"), parts: [] } } : {}),
		});
		this.entry(body, TEST_RUNNER_BY, minAgo);
		return this;
	}
	/** A reader over these rows; `remotes` answers `git remote -v` for any directory; `calls` counts each read. */
	hold(remotes: string[] | Error = [REPO]): MergeHold & { calls: { standing: number; remotes: number } } {
		const calls = { standing: 0, remotes: 0 };
		return {
			calls,
			standing: () => {
				calls.standing++;
				return { entries: this.entries, instructions: this.instructions };
			},
			now: () => NOW,
			remoteRepos: () => {
				calls.remotes++;
				if (remotes instanceof Error) throw remotes;
				return remotes;
			},
		};
	}
}

const bash = (command: string, hold: MergeHold, input: Record<string, unknown> = {}, context: CallContext = ctx): Refusal =>
	checkReserved({ toolName: "bash", input: { command, ...input } }, context, hold);
const isHold = (r: Refusal) => r !== null && /land-first merge hold/.test(r.reason);
/** An open, fresh state for REPO: land-first on, reconciled a minute ago, landing open. */
const open = () => new Standing().landFirst(REPO, true).reconciled(1);

describe("the merge hold off land-first keeps today's behaviour (R20)", () => {
	test("no land-first entry: every merge spelling passes the hold, and git is never read", () => {
		const s = new Standing();
		const h = s.hold();
		for (const c of [`gh pr merge 5 --merge`, `gh pr merge 5 --auto`, `nohup gh pr merge 5 &`, `curl -X PUT https://api.github.com/repos/${REPO}/pulls/5/merge`]) {
			expect(isHold(bash(c, h))).toBe(false);
		}
		expect(h.calls.remotes).toBe(0);
	});

	test("land-first off after on, and on for another repository only, both pass a merge into this one", () => {
		const off = new Standing().landFirst(REPO, true, 60).landFirst(REPO, false, 30);
		expect(bash(`gh pr merge 5 -R ${REPO} --auto`, off.hold())).toBeNull();
		const other = new Standing().landFirst(OTHER, true).reconciled(1, { repo: OTHER, open: false });
		expect(bash(`gh pr merge 5 -R ${REPO} --auto`, other.hold())).toBeNull();
		// with no -R, the directory's remotes decide; a repo whose remotes are not land-first passes
		expect(bash(`gh pr merge 5 --auto`, other.hold([REPO]))).toBeNull();
	});

	test("a call naming no merge never reads the ledger", () => {
		const s = open();
		const h = s.hold();
		expect(bash("gh pr view 5 --json state", h)).toBeNull();
		expect(bash("git log --oneline -3", h)).toBeNull();
		expect(h.calls.standing).toBe(0);
	});

	test("a land-first entry a lane wrote, or one with no Jo instruction behind it, does not turn the hold on", () => {
		const s = new Standing();
		s.entry(landFirstBody(REPO, true, "in-forged"), "lane-x", 60);
		s.reconciled(1, { open: false });
		expect(bash(`gh pr merge 5 -R ${REPO} --merge`, s.hold())).toBeNull();
	});
});

describe("ledger state admits a lone foreground merge (R20)", () => {
	test("open and fresh: gh pr merge, the REST endpoint by curl, and a GraphQL mergePullRequest are admitted", () => {
		const h = open().hold();
		expect(bash(`gh pr merge 5 -R ${REPO} --merge --match-head-commit ${HEAD}`, h)).toBeNull();
		expect(bash(`gh pr merge 5 --squash`, h)).toBeNull();
		expect(bash(`curl -X PUT -H "Authorization: token x" https://api.github.com/repos/${REPO}/pulls/5/merge`, h)).toBeNull();
		expect(bash(`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }'`, h)).toBeNull();
		// the REST merge through gh api is an ordinary GitHub write under the § A4 floor (PLAN wl-mvqwn80onq9hq8 D11), so admitted too
		expect(bash(`gh api -X PUT repos/${REPO}/pulls/5/merge -f merge_method=merge`, h)).toBeNull();
		// a trailing `;` or newline is still one command
		expect(bash(`gh pr merge 5 --merge;\n`, h)).toBeNull();
	});

	test("train-reconciled under 10 minutes old admits; at 10 minutes and older it holds", () => {
		expect(bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).reconciled(9.99).hold())).toBeNull();
		const stale = bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).reconciled(10).hold());
		expect(isHold(stale)).toBe(true);
		expect(stale!.reason).toContain("not under 10 minutes ago");
		expect(reservedAction(stale)).not.toBeNull();
	});

	test("no train-reconciled for the repository, or only another repo's or another writer's, holds", () => {
		expect(isHold(bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).hold()))).toBe(true);
		expect(isHold(bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).reconciled(1, { repo: OTHER }).hold()))).toBe(true);
		const forged = bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).reconciled(1, { by: "lane-x" }).hold());
		expect(forged!.reason).toContain("no train-reconciled entry");
	});

	test("the newest train-reconciled wins: an older open entry does not outvote a newer stopped one", () => {
		const s = new Standing().landFirst(REPO, true).reconciled(6).reconciled(1, { open: false });
		expect(bash(`gh pr merge 5 --merge`, s.hold())!.reason).toContain("says landing stopped");
		const t = new Standing().landFirst(REPO, true).reconciled(6, { open: false }).reconciled(1);
		expect(bash(`gh pr merge 5 --merge`, t.hold())).toBeNull();
	});

	test("open with its oldest suspect under 40 minutes admits; at 40 minutes it holds", () => {
		expect(bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).reconciled(1, { oldest: 39.99 }).hold())).toBeNull();
		const old = bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).reconciled(1, { oldest: 40 }).hold());
		expect(old!.reason).toContain("oldest suspect");
	});

	test("stopped holds, except a merge pinning the head the entry names as the repair", () => {
		const s = new Standing().landFirst(REPO, true).reconciled(1, { open: false, repair: HEAD });
		expect(bash(`gh pr merge 9 --merge --match-head-commit ${HEAD}`, s.hold())).toBeNull();
		expect(bash(`gh pr merge 9 --merge --match-head-commit=${HEAD.toUpperCase()}`, s.hold())).toBeNull();
		expect(bash(`gh pr merge 9 --merge --match-head-commit ${sha("d")}`, s.hold())!.reason).toContain(`admits only the repair ${HEAD}`);
		expect(isHold(bash(`gh pr merge 9 --merge`, s.hold()))).toBe(true);
		const none = new Standing().landFirst(REPO, true).reconciled(1, { open: false });
		expect(isHold(bash(`gh pr merge 9 --merge --match-head-commit ${HEAD}`, none.hold()))).toBe(true);
	});

	test("a red, red-main, inconclusive or implausible main-run settle newer than the entry holds; one older does not", () => {
		for (const [v, exec, word] of [["red", EXEC, "red"], ["red-main", EXEC, "red"], ["error", EXEC, "inconclusive"], ["stale", EXEC, "inconclusive"], ["green", null, "implausible"]] as const) {
			const after = new Standing().landFirst(REPO, true).reconciled(2).settle(sha("e"), v, 1, exec);
			expect(bash(`gh pr merge 5 --merge`, after.hold())!.reason).toContain(`settled ${word}`);
			const before = new Standing().landFirst(REPO, true).settle(sha("e"), v, 2, exec).reconciled(1);
			expect(bash(`gh pr merge 5 --merge`, before.hold())).toBeNull();
		}
		// a believable green after the entry does not stop landing
		expect(bash(`gh pr merge 5 --merge`, new Standing().landFirst(REPO, true).reconciled(2).settle(sha("e"), "green", 1).hold())).toBeNull();
	});

	test("a settle newer than the entry stops even the named repair", () => {
		const s = new Standing().landFirst(REPO, true).reconciled(2, { open: false, repair: HEAD }).settle(sha("e"), "error", 1);
		expect(isHold(bash(`gh pr merge 9 --merge --match-head-commit ${HEAD}`, s.hold()))).toBe(true);
	});

	test("an unreadable ledger holds and names the error", () => {
		const h: MergeHold = { standing: () => { throw new Error("database is locked"); }, now: () => NOW, remoteRepos: () => [REPO] };
		const r = bash(`gh pr merge 5 --merge`, h);
		expect(r!.reason).toContain("database is locked");
		expect(reservedAction(r)).not.toBeNull();
	});
});

describe("every other merge-naming call is held always (R20)", () => {
	test("background, wrappers, loops, groups, subshells, functions, pipes, sequences and --auto hold even when landing is open", () => {
		const h = open().hold();
		for (const c of [
			`gh pr merge 5 --merge &`,
			`gh pr merge 5 --auto --merge`,
			`gh pr merge 5 --auto=true`,
			`nohup gh pr merge 5 --merge`,
			`timeout 60 gh pr merge 5 --merge`,
			`env gh pr merge 5 --merge`,
			`GH_REPO=${REPO} gh pr merge 5 --merge`,
			`(gh pr merge 5 --merge)`,
			`{ gh pr merge 5 --merge; }`,
			`for i in 5; do gh pr merge $i --merge; done`,
			`while true; do gh pr merge 5 --merge; done`,
			`m() { gh pr merge 5 --merge; }; m`,
			`gh pr merge 5 --merge | cat`,
			`git fetch && gh pr merge 5 --merge`,
			`sleep 1; gh pr merge 5 --merge`,
			`gh pr merge 5 --merge || true`,
			`sh -c 'gh pr merge 5 --merge'`,
			`echo 5 | xargs gh pr merge --merge`,
			`gh pr merge $(cat n) --merge`,
		]) {
			const r = bash(c, h);
			expect({ c, held: isHold(r) || r !== null }).toEqual({ c, held: true });
		}
	});

	test("a merge the hold sees in a word of another client, a heredoc or a here-string is held whatever the client", () => {
		const h = open().hold();
		for (const c of [
			`python3 -c "import urllib.request as u; u.urlopen(u.Request('https://api.github.com/repos/${REPO}/pulls/5/merge', method='PUT'))"`,
			`node -e "fetch('https://api.github.com/repos/${REPO}/merges', {method: 'POST'})"`,
			`U=https://api.github.com/repos/${REPO}/pulls/5/merge; curl -X PUT "$U"`,
			`cat <<'EOF' > q.json\n{"query":"mutation { mergeBranch(input: {}) { clientMutationId } }"}\nEOF`,
			`jq . <<< '{"query":"mutation { mergePullRequest(input: {}) { clientMutationId } }"}'`,
		]) {
			expect({ c, held: isHold(bash(c, h)) }).toEqual({ c, held: true });
		}
	});

	test("auto-merge and the merge queue mutations are held even as one lone gh api call", () => {
		const h = open().hold();
		expect(bash(`gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'`, h)!.reason).toContain("deferred");
		expect(bash(`gh api graphql -f query='mutation { enqueuePullRequest(input: {}) { clientMutationId } }'`, h)!.reason).toContain("deferred");
	});

	test("a percent-encoded endpoint is decoded before the match", () => {
		const h = new Standing().landFirst(REPO, true).reconciled(1, { open: false }).hold();
		expect(isHold(bash(`curl -X PUT https://api.github.com/repos/${REPO}/pulls/5/m%2565rge`, h))).toBe(true);
		expect(isHold(bash(`curl -X PUT https://api.github.com/repos/${REPO}/pulls/5/%6Derge`, h))).toBe(true);
		expect(isHold(bash(`curl -X POST https://api.github.com/repos/${REPO.replace("/", "%2F")}/merges`, h))).toBe(true);
	});

	test("a shell script the expander opens is read: its gh pr merge is held as not lone", () => {
		const dir = tmp("land-first");
		mkdirSync(join(dir, "bin"), { recursive: true });
		writeFileSync(join(dir, "bin", "land.sh"), "#!/bin/bash\ngh pr merge 5 --merge\n");
		const r = bash(`bash bin/land.sh`, open().hold(), {}, { ...ctx, cwd: dir });
		expect(r!.reason).toContain("not one lone foreground merge command");
	});
});

describe("which repository a merge lands in (R20)", () => {
	test("-R, a REST endpoint and a PR URL name it; a merge naming a non-land-first repository passes", () => {
		const s = new Standing().landFirst(REPO, true).reconciled(1, { open: false });
		expect(isHold(bash(`gh pr merge https://github.com/${REPO}/pull/5 --merge`, s.hold([OTHER])))).toBe(true);
		expect(isHold(bash(`gh pr merge 5 --repo=${REPO.toUpperCase()} --merge`, s.hold([OTHER])))).toBe(true);
		expect(bash(`gh pr merge 5 -R ${OTHER} --merge`, s.hold([REPO]))).toBeNull();
		expect(bash(`curl -X PUT https://api.github.com/repos/${OTHER}/pulls/5/merge`, s.hold())).toBeNull();
		expect(isHold(bash(`gh -R ${REPO} pr merge 5 --merge`, s.hold([OTHER])))).toBe(true);
	});

	test("with no -R, GH_REPO (tool env, exported) wins over the directory's remotes; any land-first remote counts", () => {
		const s = new Standing().landFirst(REPO, true).reconciled(1, { open: false });
		expect(bash(`gh pr merge 5 --merge`, s.hold([REPO]), { env: { GH_REPO: OTHER } })).toBeNull();
		expect(bash(`export GH_REPO=${OTHER}; gh pr merge 5 --merge`, s.hold([REPO]))).toBeNull();
		expect(isHold(bash(`gh pr merge 5 --merge`, s.hold([OTHER, REPO])))).toBe(true);
		expect(bash(`gh pr merge 5 --merge`, s.hold([OTHER]))).toBeNull();
	});

	test("unreadable or missing remotes hold while land-first is on anywhere, naming why", () => {
		const s = open();
		expect(bash(`gh pr merge 5 --merge`, s.hold(new Error("not a git repository")))!.reason).toContain("not a git repository");
		expect(bash(`gh pr merge 5 --merge`, s.hold([]))!.reason).toContain("no git remote");
	});

	test("a mutation naming no repository is checked against every land-first repository", () => {
		const s = new Standing().landFirst(REPO, true).landFirst(OTHER, true).reconciled(1).reconciled(1, { repo: OTHER, open: false });
		const r = bash(`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }'`, s.hold());
		expect(r!.reason).toContain(OTHER);
	});
});

describe("the verified control root is written only by the runner (R29)", () => {
	const home = "/Users/someone";
	const henv = { HOME: home, AGENT_SYSTEM_LEDGER_DB: `${home}/.agent-system-2/ledger.db` };
	const hctx: CallContext = { role: "lane", cwd: "/work/repo", env: henv };
	const VERIFIED = `${home}/.agent-system-2/verified`;

	test("row 10 refuses write, edit and ast_edit under ~/.agent-system-2/verified/, and passes a sibling path", () => {
		for (const toolName of ["write", "edit", "ast_edit"]) {
			expect(checkRawLedgerWrite({ toolName, input: { path: `${VERIFIED}/current/gates/src/rows/r06-reserved.ts`, content: "x" } }, hctx)).not.toBeNull();
			expect(checkRawLedgerWrite({ toolName, input: { path: `${VERIFIED}`, content: "x" } }, hctx)).not.toBeNull();
		}
		// `~` is the tool's own home, the one OMP expands it against
		const own = process.env.HOME!;
		const octx: CallContext = { role: "lane", cwd: "/work/repo", env: { HOME: own, AGENT_SYSTEM_LEDGER_DB: join(own, ".agent-system-2", "ledger.db") } };
		expect(checkRawLedgerWrite({ toolName: "write", input: { path: `~/.agent-system-2/verified/current/x.ts`, content: "x" } }, octx)).not.toBeNull();
		expect(checkRawLedgerWrite({ toolName: "ast_edit", input: { paths: ["/work/repo/a.ts", `${VERIFIED}/abc/b.ts`] } }, hctx)).not.toBeNull();
		// an ast_edit scope above the root reaches into it; an edit beside it does not
		expect(checkRawLedgerWrite({ toolName: "ast_edit", input: { paths: [`${home}/.agent-system-2/**/*.ts`] } }, hctx)).not.toBeNull();
		expect(checkRawLedgerWrite({ toolName: "edit", input: { path: `${home}/.agent-system-2/notes.md` } }, hctx)).toBeNull();
		expect(checkRawLedgerWrite({ toolName: "write", input: { path: `${home}/.agent-system-2/verified-notes.md`, content: "x" } }, hctx)).toBeNull();
		expect(checkRawLedgerWrite({ toolName: "write", input: { path: "/work/repo/verified/x.ts", content: "x" } }, hctx)).toBeNull();
	});

	test("row 10 refuses eval code naming the verified root with a write API, and passes a read of it", () => {
		const evalCall = (language: string, code: string) => checkRawLedgerWrite({ toolName: "eval", input: { language, code } }, hctx);
		expect(evalCall("js", `await Bun.write("${VERIFIED}/current/x.ts", "y")`)).not.toBeNull();
		expect(evalCall("js", `require("fs").writeFileSync(require("os").homedir() + "/.agent-system-2/verified/current/x", "y")`)).not.toBeNull();
		expect(evalCall("py", `open("${VERIFIED}/current/x.ts", "w").write("y")`)).not.toBeNull();
		expect(evalCall("py", `import shutil\nshutil.rmtree("${VERIFIED}")`)).not.toBeNull();
		expect(evalCall("js", `const t = await Bun.file("${VERIFIED}/current/SOURCE").text(); t`)).toBeNull();
		expect(evalCall("py", `print(open("${VERIFIED}/current/SOURCE").read())`)).toBeNull();
	});

	test("the fence denies bash writes under the verified root, also when the ledger lives elsewhere", () => {
		const defaults = fenceTargets("true", "/work/repo", henv);
		// the default layout: the fenced ledger directory already holds the root
		expect(defaults.some((t) => t.kind === "subpath" && `${VERIFIED}/current/x`.startsWith(`${t.path}/`))).toBe(true);
		const apart = fenceTargets("true", "/work/repo", { HOME: home, AGENT_SYSTEM_LEDGER_DB: "/Volumes/data/ledger.db" });
		expect(apart).toContainEqual({ kind: "subpath", path: VERIFIED });
		expect(fenceProfile(apart)).toContain(`(deny file-write* (subpath "${VERIFIED}"))`);
	});
});
