// PLAN wl-mvqwn80onq9hq8 D11 (Jo's floor): every row 6 hold and git-model reservation is in exactly one class of
// src/rows/r06-reserved.ts FLOOR — A4 (a reserved request), deploy (today's verdict byte for byte), guard (refused with
// no reserved request, naming the owner and the spelling to use instead) or own-root (a work-tree discard in the own
// worktree or a scratch repository) — and the ordinary class (the gh api allow-list, non-admin gh pr and gh issue
// writes, feature-branch pushes) runs. Requirements: R15, R25, R26, R28 and the floor part of R32.
//
// The verdicts D11 changes on purpose (R15: with no options bag row 6 behaves as origin/main except these), each a
// legacy expectation updated in place or a new verdict this file pins:
// - gates/test/r06-reserved.test.ts, "nowReserved over real refusals": `gh api -X DELETE repos/o/r/labels/x` waited
//   as "gh api with a mutating method"; it is on the ordinary list and now runs (its own test there). The NOW row in
//   that table is now an off-list ref DELETE.
// - gates/test/review-round5.test.ts, the leg-c and leg-a rows "rm -rf on a /tmp path…" (`rm -rf /tmp/not-real-cache`,
//   `rm -rf /tmp/not-real-x`): ALLOW → REFUSE (rulings; the ruling count goes from six to eight).
// - gates/test/review-round5.test.ts, "row 6: rm through the same option model": `rm -rf /tmp/not-real-cache` and
//   `rm --recursive --force /private/tmp/not-real` moved from `allowed` to `refused` (TEMP_PATH is gone).
// - gates/test/review-round6.test.ts, astra-6 PROBES.md P09 `rm --recu --forc /tmp/not-real`: ALLOW → REFUSE (TEMP_PATH is gone).
// - gates/test/review-round7-git.test.ts: no expectation changed (its probes assert a refusal, not its class).
// - New verdicts with no legacy expectation, pinned below: the ordinary gh api writes and graphql mutations run;
//   an off-list graphql mutation (deleteRef) now asks (it ran before); status, check, branch-protection and ruleset
//   writes, local ref rewrites (update-ref without -d, symbolic-ref writes, filter-branch, replace, pull --force), .git
//   writes, docker volume rm and the work-tree discards outside the own worktree and every scratch repository are
//   refused with no reserved request; `git update-ref -d`/`--stdin` keep a request under a branch-deletion name;
//   `reset --merge --hard` names the hard reset.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkReserved, FLOOR, type FloorClass, floorRow, ORDINARY_GH_API, ORDINARY_GRAPHQL, type ReservedContext, refusalClass, reservedAction } from "../src/rows/r06-reserved";
import { SCRATCH_ENV, scratchRootFor } from "../src/scratch";
import { WORKLOAD_ENV } from "../src/types";
import { commit, git, tmp } from "./helpers";

const SRC = join(import.meta.dir, "..", "src");
const NO_LEDGER = { AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" };

/** A repository on a feature branch with a dirty tracked file `f`: the checkout the class tests run in. */
function dirtyRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	commit(dir, "f", "one\n");
	git(dir, "switch", "-q", "-c", "topic");
	writeFileSync(join(dir, "f"), "dirty\n");
	return dir;
}

const OTHER = dirtyRepo(join(realpathSync(tmp("floor-other")), "r"));
const LANE: ReservedContext = { role: "lane", cwd: OTHER, env: { HOME: "/nonexistent-home", ...NO_LEDGER } };

interface Seen {
	block: boolean;
	action: string | null;
	cls: FloorClass | null;
	reason: string;
}

function run(command: string, ctx: ReservedContext = LANE): Seen {
	const r = checkReserved({ toolName: "bash", input: { command } }, ctx);
	return { block: r?.block === true, action: reservedAction(r), cls: refusalClass(r), reason: r?.reason ?? "" };
}

// The deploy rules' reason on origin/main (4312a0a), byte for byte: the § A4 wording with the rule's why.
const ORIGIN_REASON = (why: string, command: string): string =>
	`P-11 row 6 refused this: ${why} is on the § A4 reserved list (SPEC-2.0.md:224-242), which no 2.0 agent runs. ` +
	"Do not reword, script or route around it. A hand reports what it would have run and why, and stops; the lane raises it to Jo as a P-7b reserved item. " +
	`Once the lane has gone past it, it withdraws the request with \`lane_withdraw_reserved\`. Command: ${command}`;

describe("FLOOR: every hold the rule table names is in exactly one class (R25)", () => {
	const r06 = readFileSync(join(SRC, "rows", "r06-reserved.ts"), "utf8");
	const model = readFileSync(join(SRC, "git-model.ts"), "utf8");
	const rules = r06.slice(r06.indexOf("const RULES"), r06.indexOf("\n];", r06.indexOf("const RULES")));
	const opts = model.slice(model.indexOf("const RESERVED_OPTS"), model.indexOf("\n};", model.indexOf("const RESERVED_OPTS")));
	const literal = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1]!);
	const whys = new Set([
		...literal(rules, /why: "([^"]+)"/g),
		...literal(r06, /reserved: true, why: "([^"]+)"/g),
		...literal(opts, /: "([^"]+)"/g),
		...literal(model, /\b(?:reserved|discard)\("([^"]+)"\)/g),
	]);
	test("the scan found the rule table", () => {
		expect(rules.length).toBeGreaterThan(0);
		expect(opts.length).toBeGreaterThan(0);
		expect(whys.size).toBeGreaterThan(60);
	});
	for (const why of whys) {
		test(`"${why}" matches one FLOOR row`, () => expect(FLOOR.filter((r) => r.match.test(why)).length).toBe(1));
	}
	const discards = [...literal(model, /\bdiscard\("([^"]+)"\)/g), "git reset --merge (discards working changes)", "git checkout --patch (discards working hunks)", "git switch --discard-changes"];
	for (const why of discards) {
		test(`discard "${why}": own-root as named, guard in another checkout`, () => {
			expect(floorRow(why)?.class).toBe("own-root");
			const other = `${why}, in a checkout that is neither the own worktree nor a scratch repository`;
			expect(FLOOR.filter((r) => r.match.test(other)).map((r) => r.class)).toEqual(["guard"]);
		});
	}
	test("every row cites § A4 and every guard row names an owner and a spelling to use instead", () => {
		for (const row of FLOOR) {
			expect(row.a4).toContain("§ A4");
			if (row.class === "guard") {
				expect(row.owner?.length).toBeGreaterThan(0);
				expect(row.instead?.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("class A4: a reserved request, as before the floor (R25, R26)", () => {
	const SHA = "a".repeat(40);
	const a4 = [
		"rm -rf build",
		"rm -rf $X",
		"mysql -e 'DROP TABLE users'",
		"psql -h prod.db -c 'delete from x'",
		"kubectl delete pod x",
		"terraform destroy",
		"gh secret set TOKEN",
		"gh repo delete o/r",
		"git reset --hard",
		"git reset --merge --hard",
		"git branch -D x",
		"git tag -d v1",
		"git update-ref -d refs/heads/x",
		"git update-ref -dm why refs/heads/x",
		"git update-ref --stdin",
		"git update-ref --std",
		"git push --force origin topic",
		"git push origin :old",
		"git push --mirror origin",
		"git push origin topic:main",
		"gh pr merge 5 --admin",
		// gh api writes off the ordinary list: unknown endpoints and methods, encoded endpoints, unreadable graphql
		"gh api -X DELETE repos/o/r/git/refs/heads/x",
		"gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc",
		"gh api -X PUT repos/o/r/dependabot/secrets/X",
		"gh api -X PUT repos/o/r/actions/secrets/X",
		"gh api -X POST repos/o/r/merges -f base=main -f head=x",
		"gh api -X POST repos/o/r/pages",
		"gh api -X PUT repos/o/r/environments/prod",
		"gh api -X DELETE repos/o/r",
		"gh api -X DELETE repos/o/r/git/refs/heads%2Fmain",
		"gh api -X DELETE repos/o/r/labels%2Fx",
		"gh api -X POST repos/o/r/issue%73",
		"gh api repos/o/r/%zz/7 -f state=x",
		"gh api -X $M repos/o/r/issues",
		'gh api -X POST "$EP"',
		"gh api -X FOO repos/o/r/issues",
		"gh api -X",
		"gh api -X POST repos/o/r/issues repos/o/r/pulls",
		"gh api -X POST repos/o/r/issues?x=1",
		"gh api graphql -f query='mutation { deleteRef(input: {refId: \"x\"}) { clientMutationId } }'",
		"gh api graphql -f query='mutation { x: deleteRef(input: {refId: \"x\"}) { clientMutationId } }'",
		"gh api graphql -f query='mutation { ...F } fragment F on Mutation { deleteRef(input: {}) { clientMutationId } }'",
		"gh api graphql -F query=@q.graphql",
		"gh api graphql -f query='mutation { %61ddComment(input: {}) { clientMutationId } }'",
		"gh api graphql --input - <<'EOF'\nnot json\nEOF",
		"git with-$(echo x)",
	];
	for (const command of a4) {
		test(`requests: ${command}`, () => {
			const s = run(command);
			expect(s.block).toBe(true);
			expect(s.action).not.toBeNull();
			expect(s.cls).toBe("A4");
			expect(s.reason).toContain("is on the § A4 reserved list");
		});
	}
	test(`the merge gate's status endpoint stays readable: gh api repos/o/r/statuses/${SHA}`, () => expect(run(`gh api repos/o/r/statuses/${SHA}`).block).toBe(false));
});

describe("class guard: refused with no reserved request, naming the owner and the spelling to use (R25, R26)", () => {
	const SHA = "a".repeat(40);
	const guard: [string, string][] = [
		[`gh api repos/o/r/statuses/${SHA} -f state=success`, "the test runner"],
		["gh api -X POST repos/o/r/check-runs -f name=as2/full-suite", "the test runner"],
		["gh api -X POST repos/o/r/check-suites/5/rerequest", "the test runner"],
		[`gh api repos/o/r/%73tatuses/${SHA} -f state=success`, "the test runner"],
		["gh api graphql -f query='mutation { createCheckRun(input: {}) { checkRun { id } } }'", "the test runner"],
		["gh api -X PUT repos/o/r/branches/main/protection", "the merge gate"],
		["gh api -X DELETE repos/o/r/branches/main/protection/required_status_checks", "the merge gate"],
		["gh api -X POST repos/o/r/rulesets", "the merge gate"],
		["gh api -X DELETE repos/o/r/rulesets/1", "the merge gate"],
		["gh api -X PUT repos/o/r/branches/main/%70rotection", "the merge gate"],
		["gh api graphql -f query='mutation { deleteBranchProtectionRule(input: {}) { clientMutationId } }'", "the merge gate"],
		["gh api graphql -f query='mutation { updateRepositoryRuleset(input: {}) { clientMutationId } }'", "the merge gate"],
		["git update-ref refs/heads/x HEAD", "the shared repository's refs"],
		["git update-ref -m why refs/heads/x HEAD", "the shared repository's refs"],
		["git update-ref -md refs/heads/x HEAD", "the shared repository's refs"],
		["git symbolic-ref HEAD refs/heads/x", "the shared repository's refs"],
		["git symbolic-ref -d HEAD", "the shared repository's refs"],
		["git filter-branch --tree-filter true", "the shared repository's refs"],
		["git replace a b", "the shared repository's refs"],
		["git pull --force origin topic", "the shared repository's refs"],
		["echo x > .git/HEAD", "git (its refs"],
		["docker volume rm v1", "the service whose data"],
		["git restore f", "that checkout's owner"],
		["git clean -fd", "that checkout's owner"],
		["git checkout -- f", "that checkout's owner"],
		["git checkout HEAD f", "that checkout's owner"],
		["git checkout f", "that checkout's owner"],
		["git checkout --force topic", "that checkout's owner"],
		["git checkout --patch", "that checkout's owner"],
		["git switch --discard-changes topic", "that checkout's owner"],
		["git switch --force topic", "that checkout's owner"],
		["git reset --merge", "that checkout's owner"],
		["git reset --keep", "that checkout's owner"],
		// guard precedence: a guard hold anywhere in the call wins over deploy and A4, so no request is written
		[`git reset --hard; gh api -X POST repos/o/r/statuses/${SHA}`, "the test runner"],
		["vercel --prod; git update-ref refs/heads/x HEAD", "the shared repository's refs"],
	];
	for (const [command, owner] of guard) {
		test(`refuses with no request: ${command}`, () => {
			const s = run(command);
			expect(s.block).toBe(true);
			expect(s.action).toBeNull();
			expect(s.cls).toBe("guard");
			expect(s.reason).toContain(owner);
			expect(s.reason).toContain("no request is written");
			expect(s.reason).toContain("Use instead: ");
			expect(s.reason).not.toContain("is on the § A4 reserved list");
		});
	}
	test("the write tool's .git path is guard too", () => {
		const r = checkReserved({ toolName: "write", input: { path: "/r/.git/hooks/pre-commit", content: "x" } }, LANE);
		expect(r?.block).toBe(true);
		expect(reservedAction(r)).toBeNull();
		expect(refusalClass(r)).toBe("guard");
	});
});

describe("class ordinary: the allow-list runs, and its off-list neighbour asks (R26)", () => {
	// One concrete endpoint per ORDINARY_GH_API line, and an off-list neighbour of it.
	const lines: Record<string, { ok: string; neighbour: [string, string] }> = {
		"POST issues": { ok: "repos/o/r/issues", neighbour: ["POST", "repos/o/r/merges"] },
		"PATCH issues/<n>": { ok: "repos/o/r/issues/7", neighbour: ["PUT", "repos/o/r/issues/7/lock"] },
		"POST issues/<n>/comments": { ok: "repos/o/r/issues/7/comments", neighbour: ["POST", "repos/o/r/commits/abc/comments"] },
		"PATCH|DELETE issues/comments/<id>": { ok: "repos/o/r/issues/comments/9", neighbour: ["DELETE", "repos/o/r/comments/9"] },
		"POST issues/<n>/labels": { ok: "repos/o/r/issues/7/labels", neighbour: ["PUT", "repos/o/r/issues/7/labels"] },
		"DELETE issues/<n>/labels/<name>": { ok: "repos/o/r/issues/7/labels/bug", neighbour: ["DELETE", "repos/o/r/issues/7/labels"] },
		"POST labels": { ok: "repos/o/r/labels", neighbour: ["POST", "repos/o/r/milestones"] },
		"PATCH|DELETE labels/<name>": { ok: "repos/o/r/labels/x", neighbour: ["DELETE", "repos/o/r/labels/.."] },
		"POST pulls": { ok: "repos/o/r/pulls", neighbour: ["PUT", "repos/o/r/pulls/7/update-branch"] },
		"PATCH pulls/<n>": { ok: "repos/o/r/pulls/7", neighbour: ["PATCH", "repos/o/r/git/refs/heads/main"] },
		"POST pulls/<n>/comments": { ok: "repos/o/r/pulls/7/comments", neighbour: ["POST", "repos/o/r/pulls/7/comments/9/replies"] },
		"PATCH|DELETE pulls/comments/<id>": { ok: "repos/o/r/pulls/comments/9", neighbour: ["PUT", "repos/o/r/pulls/comments/9"] },
		"POST pulls/<n>/reviews": { ok: "repos/o/r/pulls/7/reviews", neighbour: ["PUT", "repos/o/r/pulls/7/reviews/3/dismissals"] },
		"POST|DELETE pulls/<n>/requested_reviewers": { ok: "repos/o/r/pulls/7/requested_reviewers", neighbour: ["PUT", "repos/o/r/pulls/7/requested_reviewers"] },
		"PUT pulls/<n>/merge": { ok: "repos/o/r/pulls/7/merge", neighbour: ["POST", "repos/o/r/pulls/7/merge"] },
	};
	test("the table walks every ORDINARY_GH_API line", () => expect(Object.keys(lines).sort()).toEqual(ORDINARY_GH_API.map(([m, p]) => `${m} ${p}`).sort()));
	for (const [methods, path] of ORDINARY_GH_API) {
		const line = lines[`${methods} ${path}`]!;
		for (const method of methods.split("|")) {
			const command = `gh api -X ${method} ${line.ok}`;
			test(`runs: ${command}`, () => expect(run(command).block).toBe(false));
		}
		const neighbour = `gh api -X ${line.neighbour[0]} ${line.neighbour[1]}`;
		test(`asks: ${neighbour} (off-list neighbour of ${methods} ${path})`, () => {
			const s = run(neighbour);
			expect(s.action).not.toBeNull();
			expect(s.cls).toBe("A4");
		});
	}
	test("runs: gh api -X POST markdown; asks: its neighbour markdown/raw", () => {
		expect(run("gh api -X POST markdown -f text=x").block).toBe(false);
		expect(run("gh api -X POST markdown/raw -f text=x").cls).toBe("A4");
	});
	const spellings = [
		"gh api repos/o/r/issues -f title=x",
		"gh api --method PATCH /repos/o/r/pulls/7 -f title=x",
		"gh api -XPOST 'repos/{owner}/{repo}/issues/7/comments' -f body=x",
		"gh api repos/o/r/issues/7/comments -F body=@note.md",
	];
	for (const command of spellings) test(`runs: ${command}`, () => expect(run(command).block).toBe(false));
	for (const name of ORDINARY_GRAPHQL) {
		const command = `gh api graphql -f query='mutation { ${name}(input: {}) { clientMutationId } }'`;
		test(`runs: graphql ${name}`, () => expect(run(command).block).toBe(false));
	}
	test("graphql: a readable --input - body with a listed mutation runs; a neighbour of a listed name asks", () => {
		expect(run("gh api graphql --input - <<'EOF'\n{\"query\": \"mutation { addComment(input: {}) { clientMutationId } }\"}\nEOF").block).toBe(false);
		expect(run("gh api graphql -f query='mutation { deleteIssue(input: {}) { clientMutationId } }'").cls).toBe("A4");
		expect(run("gh api graphql -f query='mutation { addComment(input: {}) { x } deleteRef(input: {}) { x } }'").cls).toBe("A4");
		expect(run("gh api graphql -f query='query { viewer { login } }'").block).toBe(false);
	});
	const subcommands = ["gh pr create --fill", "gh pr edit 5 --title x", "gh pr comment 5 -b x", "gh pr merge 5 --squash", "gh issue create -t x -b y", "gh issue edit 5 --add-label bug", "gh issue comment 5 -b x", "gh issue close 5", "git push origin topic", "git push -u origin topic"];
	for (const command of subcommands) test(`runs: ${command}`, () => expect(run(command).block).toBe(false));
});

describe("class deploy: every deploy and publishing rule gives its origin/main verdict, byte for byte (R28)", () => {
	// [command, the reserved action origin/main 4312a0a names], from probing origin/main's checkReserved in this repo's lane context.
	const pinned: [string, string][] = [
		["vercel --prod", "deploy (vercel)"],
		["vercel deploy", "deploy (vercel)"],
		["netlify deploy --dir dist", "deploy (netlify)"],
		["fly deploy", "deploy (fly)"],
		["flyctl deploy", "deploy (fly)"],
		["doctl apps create-deployment app-1", "deploy (DigitalOcean App Platform)"],
		["doctl apps update app-1 --spec app.yaml", "deploy (DigitalOcean App Platform)"],
		["wrangler deploy", "deploy (wrangler)"],
		["wrangler publish", "deploy (wrangler)"],
		["firebase deploy", "deploy (firebase)"],
		["serverless deploy", "deploy"],
		["sls deploy", "deploy"],
		["cdk deploy", "deploy"],
		["eb deploy", "deploy"],
		["gcloud app deploy", "deploy (gcloud)"],
		["gcloud run deploy svc", "deploy (gcloud)"],
		["gcloud functions deploy fn", "deploy (gcloud)"],
		["helm install rel chart", "deploy (helm)"],
		["helm upgrade rel chart", "deploy (helm)"],
		["helm uninstall rel", "deploy (helm)"],
		["kubectl apply -f k.yaml", "deploy (kubectl)"],
		["kubectl rollout restart deploy/x", "deploy (kubectl)"],
		["kubectl rollout undo deploy/x", "deploy (kubectl)"],
		["kubectl rollout pause deploy/x", "deploy (kubectl)"],
		["kubectl rollout resume deploy/x", "deploy (kubectl)"],
		["kubectl set image deploy/x x=img:2", "deploy (kubectl)"],
		["kubectl scale deploy/x --replicas=2", "deploy (kubectl)"],
		["kubectl drain node-1", "deploy (kubectl)"],
		["kubectl cordon node-1", "deploy (kubectl)"],
		["kubectl uncordon node-1", "deploy (kubectl)"],
		["terraform apply", "infrastructure change (apply/up)"],
		["tofu apply", "infrastructure change (apply/up)"],
		["pulumi up", "infrastructure change (apply/up)"],
		["git push heroku topic", "deploy (git push to a deploy remote)"],
		["git push dokku topic", "deploy (git push to a deploy remote)"],
		["npm publish", "publishes a package"],
		["pnpm publish", "publishes a package"],
		["yarn publish", "publishes a package"],
		["bun publish", "publishes a package"],
		["gh workflow run ci.yml", "gh workflow run triggers a workflow (deploy path)"],
		["gh workflow enable ci.yml", "gh workflow run triggers a workflow (deploy path)"],
		["gh workflow disable ci.yml", "gh workflow run triggers a workflow (deploy path)"],
		["gh -R o/r workflow run ci.yml", "gh workflow run triggers a workflow (deploy path)"],
		["gh release create v1", "gh release publishes or destroys a release"],
		["gh release delete v1", "gh release publishes or destroys a release"],
		["gh release edit v1 --notes x", "gh release publishes or destroys a release"],
		["gh -R o/r release create v1", "gh release publishes or destroys a release"],
	];
	for (const [command, action] of pinned) {
		test(`${command} → ${action}`, () => {
			const s = run(command);
			expect(s.action).toBe(action);
			expect(s.reason).toBe(ORIGIN_REASON(action, command));
			expect(s.cls).toBe("deploy");
		});
	}
	test("a deploy and an A4 hold in one call: the deploy names the request (the raw pass reads first), as on origin/main", () => {
		expect(run("vercel --prod; git reset --hard").action).toBe("deploy (vercel)");
		expect(run("git reset --hard; vercel --prod").action).toBe("deploy (vercel)");
	});
});

describe("own-root, other checkouts and temp paths (R32, floor part)", () => {
	const ID = "wl-fl00rtest";
	const HOME = realpathSync(tmp("floor-home"));
	const ROOT = scratchRootFor(HOME, ID);
	const SCRATCH_REPO = dirtyRepo(join(ROOT, "r"));
	const env = { HOME, PATH: process.env.PATH, [WORKLOAD_ENV]: ID, [SCRATCH_ENV]: ROOT, ...NO_LEDGER };
	const MAIN = dirtyRepo(join(realpathSync(tmp("floor-main")), "m"));
	git(MAIN, "stash", "-q");
	const WT = join(realpathSync(tmp("floor-wt")), "wt");
	git(MAIN, "worktree", "add", "-q", WT, "-b", `wl/${ID}`);
	writeFileSync(join(WT, "f"), "dirty\n");
	const WT2 = join(realpathSync(tmp("floor-wt2")), "wt");
	git(MAIN, "worktree", "add", "-q", WT2, "-b", "other");
	writeFileSync(join(WT2, "f"), "dirty\n");
	const own: ReservedContext = { role: "lane", cwd: WT, env, worktreeRoot: WT };
	const discards = ["git restore f", "git checkout -- f", "git checkout HEAD f", "git checkout f", "git clean -fd", "git reset --merge", "git reset --keep", "git checkout --force topic", "git checkout --patch", "git switch --discard-changes main", "git switch --force main"];
	for (const command of discards) {
		test(`own worktree: ${command} is own-root (a request on the default path; the classifier auto-applies it)`, () => {
			const s = run(command, own);
			expect(s.action).not.toBeNull();
			expect(s.cls).toBe("own-root");
		});
		test(`a sibling worktree of the same repository: ${command} is guard`, () => {
			const s = run(command, { ...own, cwd: WT2 });
			expect(s.action).toBeNull();
			expect(s.cls).toBe("guard");
		});
		test(`another checkout with no own worktree recorded: ${command} is guard`, () => {
			const s = run(command, { role: "lane", cwd: OTHER, env });
			expect(s.action).toBeNull();
			expect(s.cls).toBe("guard");
		});
	}
	test("git -C reaches the own worktree from elsewhere: own-root; -C to another checkout from the own worktree: guard", () => {
		expect(run(`git -C ${WT} restore f`, { ...own, cwd: HOME }).cls).toBe("own-root");
		expect(run(`git -C ${OTHER} restore f`, own).cls).toBe("guard");
	});
	test("a scratch repository: reset --merge is own-root; clean and restore pass under the scratch rules as before", () => {
		const ctx: ReservedContext = { role: "lane", cwd: SCRATCH_REPO, env };
		expect(run("git reset --merge", ctx).cls).toBe("own-root");
		expect(run("git clean -fd", ctx).block).toBe(false);
		expect(run("git restore f", ctx).block).toBe(false);
	});
	test("a hard reset is A4 in every checkout, the own worktree included", () => {
		expect(run("git reset --hard", own).cls).toBe("A4");
		expect(run("git reset --hard", { ...own, cwd: WT2 }).cls).toBe("A4");
	});
	const temps = ["rm -rf /tmp/x", "rm -rf /private/tmp/x", "rm -rf /var/folders/ab/x", 'rm -rf "$TMPDIR/x"', "rm --recursive --force /tmp/x"];
	for (const command of temps) {
		test(`a temp path outside the own roots writes a request: ${command}`, () => {
			const s = run(command, { role: "lane", cwd: OTHER, env: { ...env, TMPDIR: "/tmp" } });
			expect(s.action).not.toBeNull();
			expect(s.cls).toBe("A4");
		});
	}
	test("rm -rf inside the own scratch root still runs", () => expect(run(`rm -rf "$AS2_SCRATCH/x"`, { role: "lane", cwd: HOME, env }).block).toBe(false));
});
