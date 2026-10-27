// P-11 row 6 (DESIGN-2.0.md:343; SPEC-2.0.md:224-242 § A4): the reserved actions are refused from
// any 2.0 agent — force-push, hard reset, branch or tag deletion, `rm -rf`, DROP/TRUNCATE,
// production database writes, infrastructure teardown, secret rotation, push to a protected branch,
// deploy. Build requirements on the gate: browser writes, and shell reached through `eval`.
// Patterns ported from the 1.x `careful-guard.mjs` DENY/ASK tables (newdle plugin 0.2.172).
//
// Two passes over a shell command, and a refusal from either wins. The raw pass matches the rules
// against the command text, quote-blind as 1.x was, except `echo`/`printf` segments whose output
// nothing runs. The parsed pass (astra review B1) matches them
// against what the shell would actually run — quotes removed, variables expanded, wrappers
// stripped, and every command reached through `sh -c`, `eval`, heredocs, pipes into a shell,
// `xargs`, `find -exec` and scripts (src/exec.ts) — and refuses what it cannot see.
// Words that are only data to the command that reads them (DATA_OPTIONS: git log/show search
// patterns) are left out of both passes' rule match, when one eligibility decision per call holds
// (dataWords, PLAN wl-mupzpidbb3ksg0 § 1); every other check still reads the full argv.
//
// No process from eval (Jo, 2026-10-08; PLAN wl-muzs0ytnaet1v4 D1): eval code that starts a process
// (evalProcessStart: a spawn API, an imported process module, a magic, the nested bash tool) is
// refused outright with "use the bash tool", never as a reserved action, so nothing reaches Jo; the
// bash gate reads the command there. Eval code that starts none runs only the quote-blind phrase pass
// and the browser pass. A `%load` is read and judged as the cell's code, or refused for a respelling.
// Inline interpreter code in bash keeps every pass; its unreadable launches are respellings (D2).
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { BROWSER_WRITE_CALL, type CodeFacts, codeFacts, evalLoads, evalProcessStart, opaqueSpawn } from "../eval-code";
import { bashCommand, type CodeFamily, codeCommands, codeInterpreterEnv, type Exec, type Expansion, execText, expandShell, type GitCall, gitCall, gitUnmodeled, interpreterEnv, interpreterFamily, OUTPUT_ONLY, physicalPath, readHeadUnmodeled, type ScratchWords, SHELLS, writeDestinations } from "../exec";
import { gitModel, gitOptionValueWords, insideDotGit, pushDestinationOperand, type ScratchLift } from "../git-model";
import { SCRATCH_ENV, insideRoot, ownScratchRoot, scratchSpelling } from "../scratch";
import { markConfined } from "../session";
import { parseShell, type Word } from "../shell-parse";
import { type CallContext, PROTECTED_BRANCH, type Refusal, type ToolCall } from "../types";
import { currentBranch } from "./r09-protected-edit";

interface Rule {
	re: RegExp;
	why: string;
}

/** `gh` plus any global flags up to the subcommand. */
const GH = String.raw`\bgh(?:\s+-{1,2}\S+(?:\s+[^\s-]\S*)?)*\s+`;

/**
 * Matched per segment of the raw text (quote-blind, careful-guard.mjs:33-42) and per parsed command.
 * git is not here: its reserved forms come from the positive model over the parsed words
 * (src/git-model.ts, M4 fix round 5), which reads options the way git does (`--har` is `--hard`)
 * instead of matching spellings.
 */
const RULES: Rule[] = [
	// destructive SQL
	{ re: /\bDROP\s+(DATABASE|SCHEMA|TABLE|INDEX|VIEW)\b/i, why: "destructive SQL (DROP)" },
	{ re: /\bTRUNCATE\s+TABLE\b/i, why: "destructive SQL (TRUNCATE)" },
	{ re: /\bTRUNCATE\s+["'`]?[A-Za-z_]\w*(\.[A-Za-z_]\w*)?["'`]?\s*(;|$)/i, why: "destructive SQL (TRUNCATE)" },
	// production database writes: a database client pointed at something named prod/production.
	// psql is judged on its parsed argv instead (checkProductionPsql): a single read-only query passes (astra review S3).
	{ re: /\b(mysql|mongosh|mongo|redis-cli|pg_restore|pg_dump\s[^\n]*--clean)\b[^\n]*\b(prod|production)\b/i, why: "a database client against a production target" },
	{ re: /\bsupabase\b[^\n]*\b(db\s+(reset|push)|delete)\b/i, why: "writes, resets or deletes a Supabase database" },
	// infrastructure teardown
	{ re: /\bdoctl\b[^\n]*\bdelete\b/i, why: "deletes a DigitalOcean resource" },
	{ re: /\bkubectl\s+delete\b/i, why: "kubectl delete" },
	{ re: /\b(terraform|tofu|pulumi)\s+destroy\b/i, why: "infrastructure teardown (destroy)" },
	{ re: /\baws\b[^\n]*\s(delete-[\w-]+|terminate-instances|rb|rm\s[^\n]*--recursive)\b/i, why: "deletes AWS resources" },
	{ re: /\bgcloud\b[^\n]*\sdelete\b/i, why: "deletes a Google Cloud resource" },
	{ re: /\b(flyctl|fly)\s+(apps\s+)?destroy\b/i, why: "destroys a Fly app" },
	{ re: /\bheroku\s+apps:destroy\b/i, why: "destroys a Heroku app" },
	{ re: /\bdocker\s+volume\s+rm\b/i, why: "removes a docker volume (data loss)" },
	{ re: new RegExp(`${GH}repo\\s+(delete|archive|rename)(?![\\w-])`, "i"), why: "gh repo delete/archive/rename" },
	{ re: /\bmkfs[.\w]*\b/i, why: "formats a filesystem" },
	{ re: /\bdd\b[^\n]*\bof=\/dev\//i, why: "dd onto a block device" },
	// secret rotation
	{ re: new RegExp(`${GH}secret\\s+(set|delete|remove)(?![\\w-])`, "i"), why: "sets or deletes a GitHub Actions secret" },
	{ re: new RegExp(`${GH}repo\\s+deploy-key\\s+(add|delete)(?![\\w-])`, "i"), why: "adds or deletes a deploy key" },
	{ re: /\baws\s+secretsmanager\s+(rotate-secret|put-secret-value|update-secret|delete-secret)\b/i, why: "rotates or rewrites an AWS secret" },
	{ re: /\bgcloud\s+secrets\s+(versions\s+(add|destroy|disable)|delete|update)\b/i, why: "rotates a Google Cloud secret" },
	{ re: /\bvault\s+(kv\s+(put|delete|destroy|patch)|write|delete)\b/i, why: "writes or deletes a Vault secret" },
	{ re: /\b(flyctl|fly|heroku|doctl)\b[^\n]*\bsecrets?\s*[:\s](set|unset|import|update|delete)\b/i, why: "rotates a platform secret" },
	{ re: /\b(vercel|netlify)\s+env\s+(add|rm|remove|pull\s+--force)\b/i, why: "rewrites a deploy environment secret" },
	// deploy (and publishing, which is a deploy of a package)
	{ re: /\bvercel\b[^\n]*(--prod\b|\bdeploy\b)/i, why: "deploy (vercel)" },
	{ re: /\bnetlify\s+deploy\b/i, why: "deploy (netlify)" },
	{ re: /\b(flyctl|fly)\s+deploy\b/i, why: "deploy (fly)" },
	{ re: /\bdoctl\s+apps\s+(create-deployment|update)\b/i, why: "deploy (DigitalOcean App Platform)" },
	{ re: /\b(wrangler)\s+(deploy|publish)\b/i, why: "deploy (wrangler)" },
	{ re: /\bfirebase\s+deploy\b/i, why: "deploy (firebase)" },
	{ re: /\b(serverless|sls|cdk|eb)\s+deploy\b/i, why: "deploy" },
	{ re: /\bgcloud\s+(app|run|functions)\s+deploy\b/i, why: "deploy (gcloud)" },
	{ re: /\bhelm\s+(install|upgrade|uninstall)\b/i, why: "deploy (helm)" },
	{ re: /\bkubectl\s+(apply|rollout\s+(restart|undo|pause|resume)|set\s+image|scale|drain|cordon|uncordon)\b/i, why: "deploy (kubectl)" },
	{ re: /\b(terraform|tofu)\s+apply\b|\bpulumi\s+up\b/i, why: "infrastructure change (apply/up)" },
	{ re: /\bgit(?:\s+-{1,2}\S+(?:\s+[^\s-]\S*)?)*\s+push\s+(heroku|dokku)\b/i, why: "deploy (git push to a deploy remote)" },
	{ re: /\b(npm|pnpm|yarn|bun)\s+publish\b/i, why: "publishes a package" },
	{ re: new RegExp(`${GH}workflow\\s+(run|enable|disable)(?![\\w-])`, "i"), why: "gh workflow run triggers a workflow (deploy path)" },
	{ re: new RegExp(`${GH}release\\s+(create|delete|edit)(?![\\w-])`, "i"), why: "gh release publishes or destroys a release" },
	{ re: new RegExp(`${GH}pr\\s+merge(?![\\w-])[^\\n]*--admin\\b`, "i"), why: "gh pr merge --admin bypasses branch protection" },
	// `gh api` writes are judged by ghApiModel on the method and endpoint together (PLAN wl-mvqwn80onq9hq8 D11).
];

/**
 * The reserved actions that interrupt Jo (PLAN wl-mvg1vs0rhnu3gg § 1.2, § 1.3, open question 1 (b)): the `why`
 * strings of the guard bypasses and the irreversible or shared-state rules — destructive SQL, a production database,
 * infrastructure teardown, secret rotation, deploy, publish, workflow run, release, the `--admin` merge, push to a
 * protected branch, remote ref deletion and force-push. surface/src/errors.ts gives a
 * waiting reserved request whose body opens with one of them `state: "now"`, and surface/src/batch.ts `onFire` pushes
 * it at once. Blind "not known until it runs" requests, `rm`, local discards and local branch or tag deletion are not
 * here: they wait for the window. A guard-class hold (FLOOR) writes no request, so none is here. Each string occurs
 * literally in RULES, gitModel's tables (src/git-model.ts) or checkPush; gates/test/r06-reserved.test.ts fails when a
 * rule is renamed out from under this list.
 */
export const NOW_RESERVED: readonly string[] = [
	// destructive SQL
	"destructive SQL (DROP)",
	"destructive SQL (TRUNCATE)",
	// production database (psql's own why extends this one)
	"a database client against a production target",
	"writes, resets or deletes a Supabase database",
	// infrastructure teardown
	"deletes a DigitalOcean resource",
	"kubectl delete",
	"infrastructure teardown (destroy)",
	"deletes AWS resources",
	"deletes a Google Cloud resource",
	"destroys a Fly app",
	"destroys a Heroku app",
	"gh repo delete/archive/rename",
	"formats a filesystem",
	"dd onto a block device",
	// secret rotation
	"sets or deletes a GitHub Actions secret",
	"adds or deletes a deploy key",
	"rotates or rewrites an AWS secret",
	"rotates a Google Cloud secret",
	"writes or deletes a Vault secret",
	"rotates a platform secret",
	"rewrites a deploy environment secret",
	// deploy (the bare "deploy" also opens every "deploy (…)")
	"deploy",
	"infrastructure change (apply/up)",
	// publish, workflow run, release
	"publishes a package",
	"gh workflow run triggers a workflow (deploy path)",
	"gh release publishes or destroys a release",
	// guard bypass: the --admin merge and a push to a protected branch (barePushOfProtected extends the latter)
	"gh pr merge --admin bypasses branch protection",
	"push to a protected branch",
	"git push --all (pushes every branch, protected ones included)",
	"git push --branches (pushes every branch, protected ones included)",
	// remote ref deletion
	"remote ref deletion (git push --delete / -d)",
	"remote ref deletion (git push :ref)",
	"git push --mirror (force-updates and deletes every remote ref)",
	"git push --prune (deletes remote branches)",
	// history rewrite
	"force-push",
];

/** The NOW_RESERVED entries that bypass a guard (§ 1.2): NOW (guard). Every other entry is NOW (irreversible) (§ 1.3). */
const NOW_RESERVED_GUARD: Record<string, true> = {
	"gh pr merge --admin bypasses branch protection": true,
	"push to a protected branch": true,
	"git push --all (pushes every branch, protected ones included)": true,
	"git push --branches (pushes every branch, protected ones included)": true,
};

/**
 * The NOW_RESERVED entry a reserved action (or a `reserved-request` body, `<action>: <call> (P-11 row 6 …)`) opens
 * with and its NOW category (a word of gates/src/rulings.ts NOW_CATEGORIES), or null. An entry counts only whole: the
 * text is it, or goes on with `:` or ` (` (`deploy (vercel)`, `push to a protected branch (current branch main)`,
 * `force-push (+refspec)`), never a longer word or phrase.
 */
export function nowReserved(text: string): { why: string; category: "guard" | "irreversible" } | null {
	const why = NOW_RESERVED.find((s) => text === s || text.startsWith(`${s}:`) || text.startsWith(`${s} (`));
	return why === undefined ? null : { why, category: NOW_RESERVED_GUARD[why] ? "guard" : "irreversible" };
}

/**
 * Jo's floor (PLAN wl-mvqwn80onq9hq8 D11): every row 6 hold and git-model reservation is in exactly one class.
 * - `A4`: a § A4 reserved action (or a form the gate cannot read, which fails closed under § A4's threat model):
 *   refused with a reserved request to Jo, as before the floor.
 * - `deploy`: § A4's "plus deploy", and publishing: today's verdict byte for byte (wl-mvgorfqqbuyyo0 owns these rules).
 * - `own-root`: a work-tree discard in the own worktree or a scratch repository. Row 6 still holds it with a reserved
 *   request; the routine classifier's case 2 (src/routine.ts, D2b) auto-applies it.
 * - `guard`: not on § A4 and not Jo's call: refused outright, with no reserved request and nothing to Jo; the refusal
 *   names the owner and the spelling to use instead.
 * The `ordinary` class holds nothing, so it has no row here: the gh api allow-list (ORDINARY_GH_API, ORDINARY_GRAPHQL),
 * non-admin `gh pr create|edit|comment|merge`, `gh issue` writes and feature-branch pushes run. Class precedence is
 * guard, deploy, ordinary, then A4 (pickHit): a guard hold anywhere in a call wins, so a call holding one writes no
 * request; deploy and A4 holds both write a request, named by the first hit as before the floor. Each row's `match`
 * reads a hold's `why` (the string RULES, gitModel, checkPush, rmModel, ghApiModel or the .git checks name);
 * gates/test/r06-floor.test.ts fails when a hold matches no row or more than one.
 */
export type FloorClass = "A4" | "deploy" | "own-root" | "guard";

export interface FloorRow {
	class: FloorClass;
	/** The SPEC-2.0.md § A4 item the row stands on (for a guard row: why it is off the list). */
	a4: string;
	match: RegExp;
	/** Guard rows: who owns what the call would change. */
	owner?: string;
	/** Guard rows: the spelling to use instead. */
	instead?: string;
}

/** The guard-class name of a work-tree discard outside the own worktree and every scratch repository (D11). */
const OTHER_CHECKOUT = "in a checkout that is neither the own worktree nor a scratch repository";
const DOT_GIT_WRITE = "writing inside a .git directory (a ref move, or config and hooks git runs later)";
const DOT_GIT_ENV_WRITE = "an interpreter told by its environment to write inside a .git directory (a ref move, or config and hooks git runs later)";
const DISCARD = String.raw`git (?:reset --merge|reset --keep|checkout --force|checkout --patch|switch --discard-changes|switch --force|clean|restore of the work tree|checkout -- <path>|checkout <commit> <path>|checkout \S+ \(a path: discards working changes\))`;

export const FLOOR: readonly FloorRow[] = [
	// guard
	{
		class: "guard",
		a4: "§ A4: not on the list; the merge gate's required as2/full-suite status (SPEC-2.0.md § B4) is the test runner's",
		match: /^gh api (?:graphql with a mutation that )?writes a commit status, a check run or a check suite/,
		owner: "the test runner (it alone posts as2/full-suite)",
		instead: "push the branch and let the runner post its result; read statuses and checks with a GET (`gh api repos/<o>/<r>/commits/<sha>/status`, `gh pr checks`)",
	},
	{
		class: "guard",
		a4: "§ A4: not on the list; main's branch protection and rulesets are the merge gate's",
		match: /^gh api (?:graphql with a mutation that )?writes branch protection or a ruleset/,
		owner: "the merge gate (main's branch protection and rulesets)",
		instead: "leave protection and rulesets as they are; read them with a GET (`gh api repos/<o>/<r>/branches/main/protection`)",
	},
	{
		class: "guard",
		a4: "§ A4: not on the list (no ref deleted, nothing pushed); a local ref rewrite of the shared repository",
		match: /^git (?:update-ref moves a ref directly|symbolic-ref writing or deleting HEAD|filter-branch rewrites history|replace substitutes objects|pull --force)/,
		owner: "the shared repository's refs",
		instead: "commit on your branch instead (`git commit`, `git switch -c <branch>`, `git pull` without --force)",
	},
	{
		class: "guard",
		a4: "§ A4: not on the list; git's own files are written only through git commands the gate models",
		match: /^(?:writing inside|an interpreter told by its environment to write inside) a \.git directory/,
		owner: "git (its refs, config and hooks)",
		instead: "the git command that makes the change (`git commit`, `git branch <name>`, `git switch`), run with the bash tool",
	},
	{
		class: "guard",
		a4: "§ A4: not on the list; a docker volume holds another service's data",
		match: /^removes a docker volume/,
		owner: "the service whose data the volume holds",
		instead: "stop or remove the container only (`docker stop`, `docker rm`), and leave the volume",
	},
	{
		class: "guard",
		a4: "§ A4: not on the list; another checkout's changes are its owner's",
		match: new RegExp(`^${DISCARD}.*, ${OTHER_CHECKOUT}$`),
		owner: "that checkout's owner (another checkout's changes are its owner's)",
		instead: 'the same command in your own worktree, or in a scratch clone under "$AS2_SCRATCH/…"',
	},
	// deploy
	{ class: "deploy", a4: "§ A4 plus deploy", match: /^deploy(?: \(|$)/ },
	{ class: "deploy", a4: "§ A4 plus deploy (publishing a package)", match: /^publishes a package$/ },
	{ class: "deploy", a4: "§ A4 plus deploy (a workflow run is the deploy path)", match: /^gh workflow run triggers a workflow/ },
	{ class: "deploy", a4: "§ A4 plus deploy (a release publishes)", match: /^gh release publishes or destroys a release$/ },
	{ class: "deploy", a4: "§ A4 plus deploy (an infrastructure apply deploys it)", match: /^infrastructure change \(apply\/up\)$/ },
	// own-root
	{ class: "own-root", a4: "§ A4: hard reset family; case 2 auto-applies it in the own worktree or a scratch repository (D2b)", match: new RegExp(`^${DISCARD}(?!.*, ${OTHER_CHECKOUT}$)`) },
	// A4
	{ class: "A4", a4: "§ A4 rm -rf", match: /^rm (?:-rf|with )/ },
	{ class: "A4", a4: "§ A4 DROP / TRUNCATE", match: /^destructive SQL/ },
	{ class: "A4", a4: "§ A4 production database writes", match: /^(?:a database client against a production target|writes, resets or deletes a Supabase database)/ },
	{
		class: "A4",
		a4: "§ A4 infrastructure teardown",
		match: /^(?:deletes a DigitalOcean resource|kubectl delete|infrastructure teardown \(destroy\)|deletes AWS resources|deletes a Google Cloud resource|destroys a (?:Fly|Heroku) app|gh repo delete\/archive\/rename|formats a filesystem|dd onto a block device|fork bomb)$/,
	},
	{
		class: "A4",
		a4: "§ A4 secret rotation",
		match: /^(?:sets or deletes a GitHub Actions secret|adds or deletes a deploy key|rotates or rewrites an AWS secret|rotates a Google Cloud secret|writes or deletes a Vault secret|rotates a platform secret|rewrites a deploy environment secret)$/,
	},
	{ class: "A4", a4: "§ A4 hard reset", match: /^git reset --hard$/ },
	{ class: "A4", a4: "§ A4 branch or tag deletion", match: /^(?:branch deletion|tag deletion|git update-ref -d |git update-ref --stdin )/ },
	{ class: "A4", a4: "§ A4 force-push", match: /^(?:force-push|git push --mirror )/ },
	{ class: "A4", a4: "§ A4 force-push (remote ref deletion)", match: /^(?:remote ref deletion|git push --prune )/ },
	{ class: "A4", a4: "§ A4 push to a protected branch", match: /^(?:push to a protected branch|git push --(?:all|branches) )/ },
	{ class: "A4", a4: "§ A4 push to a protected branch (bypassing its protection)", match: /^gh pr merge --admin bypasses branch protection$/ },
	{
		class: "A4",
		a4: "§ A4 (an unmodeled gh api write asks: it may delete a ref, rotate a secret or deploy)",
		match: /^gh api (?:with a mutating method|with a word (?:not known until it runs|whose percent-encoding does not decode)|graphql with a (?:body the gate cannot read|mutation not on the ordinary allow-list|query read from a file|word whose percent-encoding does not decode))/,
	},
	{
		class: "A4",
		a4: "§ A4 threat model (ruled 2026-09-29): a form not known until it runs fails closed",
		match: /^(?:git with a subcommand not known until it runs|git \S+ with an argument not known until it runs|git push from a directory not known until it runs|\S+ with a subcommand or target not known until it runs)$/,
	},
	{ class: "A4", a4: "§ A4 build requirement: browser writes", match: /^a browser write \(/ },
];

/** The FLOOR row a hold's `why` falls in; a why no row matches is the A4 catch-all (a hold the table does not name asks). */
export function floorRow(why: string): FloorRow | null {
	return FLOOR.find((r) => r.match.test(why)) ?? null;
}

/** The hold row 6 names for a call (D11 precedence): the first guard-class hit, else the first hit; null for none. */
function pickHit(hits: readonly string[]): string | null {
	return hits.find((h) => floorRow(h)?.class === "guard") ?? hits[0] ?? null;
}

// The merge gate (PLAN wl-mv8s8srodefytc rev 17.1 D2): main's branch protection requires the `as2/full-suite` status only the test
// runner posts, outside the fence. A lane that wrote a commit status, a check run or a check suite could forge that green, so ghApiModel
// reads every `gh api` call, in the raw pass (quote-blind words) and the parsed pass (expanded words), where RULES would read a spelling.
// Jo's floor (PLAN wl-mvqwn80onq9hq8 D11): a status, check, branch-protection or ruleset write is the guard class (refused, no request);
// a write on the ordinary allow-list (ORDINARY_GH_API, ORDINARY_GRAPHQL) runs; every other write is § A4 (a reserved request).
const GH_API_WHY = "(the merge gate's as2/full-suite is the test runner's alone)";
const GH_API_PROTECTION_WHY = "(main's branch protection and rulesets are the merge gate's)";
/** gh api's options that take a value, short and long (https://cli.github.com/manual/gh_api, Options, read 2026-10-14); `-i` and `-h` take none. */
const GH_API_SHORT_VALUE = "XfFHqtp";
const GH_API_LONG_VALUE = ["method", "raw-field", "field", "header", "jq", "template", "preview", "input", "cache", "hostname"];
const GH_API_SHORT_LONG: Record<string, string> = { X: "method", f: "raw-field", F: "field", H: "header", q: "jq", t: "template", p: "preview" };
const STATUS_ENDPOINT = /statuses|check-runs|check-suites/;
const STATUS_MUTATION = /createCommitStatus|createCheckRun|updateCheckRun|createCheckSuite|rerequestCheckSuite/i;
const PROTECTION_ENDPOINT = /branches\/.*\/protection|rulesets/;
const PROTECTION_MUTATION = /(?:create|update|delete)BranchProtectionRule|(?:create|update|delete)RepositoryRuleset/i;

/**
 * The ordinary `gh api` REST writes (D11, an allow-list): a method and an endpoint under a literal
 * `repos/<owner>/<repo>/` (`<n>` and `<id>` are digits, `<name>` one plain path segment), and `POST
 * markdown` outside `repos/`. Exported for gates/test/r06-floor.test.ts, which walks each line.
 */
export const ORDINARY_GH_API: readonly (readonly [string, string])[] = [
	["POST", "issues"],
	["PATCH", "issues/<n>"],
	["POST", "issues/<n>/comments"],
	["PATCH|DELETE", "issues/comments/<id>"],
	["POST", "issues/<n>/labels"],
	["DELETE", "issues/<n>/labels/<name>"],
	["POST", "labels"],
	["PATCH|DELETE", "labels/<name>"],
	["POST", "pulls"],
	["PATCH", "pulls/<n>"],
	["POST", "pulls/<n>/comments"],
	["PATCH|DELETE", "pulls/comments/<id>"],
	["POST", "pulls/<n>/reviews"],
	["POST|DELETE", "pulls/<n>/requested_reviewers"],
	["PUT", "pulls/<n>/merge"],
];
/** The GraphQL mutations a readable body may run (D11), and only those. */
export const ORDINARY_GRAPHQL: readonly string[] = [
	"addComment", "updateIssueComment", "deleteIssueComment", "createPullRequest", "updatePullRequest", "addLabelsToLabelable",
	"removeLabelsFromLabelable", "requestReviews", "addPullRequestReview", "submitPullRequestReview", "mergePullRequest",
];
/** One plain path segment: no encoding, never `.` or `..`, nothing GitHub or gh would read as more than a name. */
const SEGMENT = String.raw`(?!\.\.?(?:/|$))[a-z0-9._-]+`;
/** An owner or repository segment, gh's `{owner}`/`{repo}` placeholders included. */
const REPO_SEGMENT = String.raw`(?!\.\.?/)[a-z0-9._{}-]+`;
const ORDINARY_REST: readonly { methods: string[]; re: RegExp }[] = ORDINARY_GH_API.map(([methods, path]) => ({
	methods: methods.split("|"),
	re: new RegExp(`^repos/${REPO_SEGMENT}/${REPO_SEGMENT}/${path.replace(/<n>|<id>/g, "[0-9]+").replace(/<name>/g, SEGMENT)}$`),
}));

/**
 * Whether a REST write is on the ordinary list: the endpoint word is plain (no percent-encoding, query or
 * fragment, which could spell another path), read without a scheme and host and a leading `/`.
 */
function ordinaryRest(method: string, endpoint: string): boolean {
	if (/[%?#\\]/.test(endpoint)) return false;
	const ep = ghApiWord(endpoint)?.replace(/^\/+/, "");
	if (method === "POST" && ep === "markdown") return true;
	return ep !== undefined && ORDINARY_REST.some((r) => r.methods.includes(method) && r.re.test(ep));
}

/**
 * A gh api word as GitHub reads it in a path: percent-decoded until stable (`%2573` is `%73` is `s`),
 * lowercased, and without a scheme and host prefix. Null when a percent sequence does not decode,
 * since the gate cannot say what GitHub will make of it.
 */
function ghApiWord(text: string): string | null {
	let word = text;
	for (;;) {
		let next: string;
		try {
			next = decodeURIComponent(word);
		} catch {
			return null;
		}
		if (next === word) break;
		word = next;
	}
	return word.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/, "");
}

/** One gh api argument: its text, and whether its value is unknown until it runs (an opaque word or a glob). */
interface GhApiArg {
	text: string;
	unread: boolean;
}

/**
 * The words after `api` in a `gh` argv, or null when the subcommand is not `api`. Words before it are
 * global options and their values, as GH reads them.
 */
function ghApiArgs<T extends { text: string }>(argv: T[]): T[] | null {
	for (let i = 1; i < argv.length; i++) {
		const t = argv[i]!.text;
		if (t === "api") return argv.slice(i + 1);
		if (t.startsWith("-") || (i > 1 && argv[i - 1]!.text.startsWith("-"))) continue;
		return null;
	}
	return null;
}

/**
 * The write model over gh api's arguments (D11), or null when the call reads or is an ordinary write.
 * The effective method is the last explicit -X/--method; without one, a field or --input makes it POST,
 * as gh does, and otherwise it is GET. An unread word is § A4 outright: the expander does not record
 * whether it was quoted, so it may split into several words and be the endpoint, a method, or shift a
 * literal endpoint into an option's value. In class order (guard, then ordinary, then § A4):
 * - guard: any method but GET with `statuses`, `check-runs` or `check-suites`, or `branches/…/protection` or
 *   `rulesets`, in any word read as GitHub reads a path (ghApiWord); a graphql request with a status, check,
 *   branch-protection or ruleset mutation in any word or in what it reads on stdin.
 * - § A4: a graphql query or body read from a file, or from stdin the gate cannot see; a graphql body the
 *   gate cannot read, or one with a mutation off ORDINARY_GRAPHQL; a REST write off ORDINARY_GH_API.
 * `stdin` is the heredoc or here-string text the command reads, null when it reads a pipe or a file. The
 * raw pass (`raw`) reads quote-blind words, where a quoted body splits into pieces: it applies the guard
 * and unread checks and leaves the ordinary-or-§ A4 decision to the parsed pass, which every bash call
 * also gets. `tolerateUnread` (the routine classifier's read-only rule, PLAN wl-mvqwn80onq9hq8 D2a (i))
 * skips the unread-word refusal, and with an unread word the ordinary-or-§ A4 decision too (the guard
 * checks still run); the classifier then judges the call itself, and passes only a GET.
 */
function ghApiModel(args: GhApiArg[], stdin?: string | null, tolerateUnread = false, raw = false): string | null {
	if (!tolerateUnread && args.some((a) => a.unread)) return `gh api with a word not known until it runs, which could be a status or check-run endpoint or a method that writes one ${GH_API_WHY}`;
	let method: string | null | undefined;
	let writes = false;
	let input: string | undefined;
	const files: string[] = [];
	const queries: string[] = [];
	const positionals: string[] = [];
	const apply = (name: string, value: string | undefined): void => {
		if (name === "method") method = value ?? null;
		else if (name === "raw-field" || name === "field") {
			writes = true;
			const at = value === undefined ? -1 : value.indexOf("=@");
			if (name === "field" && at >= 0 && value!.slice(0, at) === "query") files.push(value!.slice(at + 2));
			else if (value?.startsWith("query=")) queries.push(value.slice("query=".length));
		} else if (name === "input") {
			writes = true;
			input = value ?? "";
		}
	};
	let options = true;
	for (let i = 0; i < args.length; i++) {
		const t = args[i]!.text;
		if (!options || t === "-" || !t.startsWith("-")) positionals.push(t);
		else if (t === "--") options = false;
		else if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const name = t.slice(2, eq < 0 ? undefined : eq);
			if (GH_API_LONG_VALUE.includes(name)) apply(name, eq >= 0 ? t.slice(eq + 1) : args[++i]?.text);
		} else {
			for (let j = 1; j < t.length; j++) {
				const c = t[j]!;
				if (!GH_API_SHORT_VALUE.includes(c)) continue;
				const rest = t.slice(j + 1).replace(/^=/, "");
				apply(GH_API_SHORT_LONG[c]!, rest !== "" ? rest : args[++i]?.text);
				break;
			}
		}
	}
	const effective = method !== undefined ? method : writes ? "POST" : "GET";
	const verb = effective === null ? "a method not given" : effective.toUpperCase();
	const words = args.map((a) => ghApiWord(a.text));
	if (verb !== "GET") {
		if (words.some((w) => w !== null && STATUS_ENDPOINT.test(w))) return `gh api writes a commit status, a check run or a check suite ${GH_API_WHY}`;
		if (words.some((w) => w !== null && PROTECTION_ENDPOINT.test(w))) return `gh api writes branch protection or a ruleset ${GH_API_PROTECTION_WHY}`;
		if (words.includes(null)) return `gh api with a word whose percent-encoding does not decode, which could spell a status or check-run endpoint ${GH_API_WHY}`;
	}
	if (positionals.some((p) => /graphql/i.test(p))) {
		const scanned = [...words, ghApiWord(stdin ?? "")];
		if (scanned.some((w) => w !== null && STATUS_MUTATION.test(w))) return `gh api graphql with a mutation that writes a commit status, a check run or a check suite ${GH_API_WHY}`;
		if (scanned.some((w) => w !== null && PROTECTION_MUTATION.test(w))) return `gh api graphql with a mutation that writes branch protection or a ruleset ${GH_API_PROTECTION_WHY}`;
		if (scanned.includes(null)) return `gh api graphql with a word whose percent-encoding does not decode, which could hide a status or check mutation ${GH_API_WHY}`;
		const reads = input !== undefined ? [...files, input] : files;
		if (reads.some((f) => f !== "-") || (stdin === null && reads.includes("-"))) {
			return `gh api graphql with a query read from a file or stdin the gate cannot see, which could write a commit status or a check run ${GH_API_WHY}`;
		}
	}
	if (raw || (tolerateUnread && args.some((a) => a.unread))) return null;
	if (positionals.length === 1 && ghApiWord(positionals[0]!)?.replace(/^\/+/, "") === "graphql") return graphqlVerdict(queries, files, input, stdin);
	if (verb === "GET") return null;
	if (positionals.length !== 1) return `gh api with a mutating method (${verb} with ${positionals.length} endpoint words, not one the gate can read)`;
	return ordinaryRest(verb, positionals[0]!) ? null : `gh api with a mutating method (${verb} ${positionals[0]} is not on the ordinary allow-list)`;
}

/**
 * A graphql request's § A4 verdict once its status and protection checks passed (D11): null when every body
 * it sends reads or runs only ORDINARY_GRAPHQL mutations. The bodies are the `query=` fields, a `-F
 * query=@-` stdin text, and the `query` of an `--input -` JSON body on stdin; anything else unreadable asks.
 */
function graphqlVerdict(queries: string[], files: string[], input: string | undefined, stdin: string | null | undefined): string | null {
	const bodies = [...queries];
	if (files.includes("-")) bodies.push(stdin ?? "");
	if (input === "-") {
		let body: unknown;
		try {
			body = JSON.parse(stdin ?? "");
		} catch (err) {
			return `gh api graphql with a body the gate cannot read (the --input stdin is not JSON: ${err instanceof Error ? err.message : String(err)})`;
		}
		const query = body !== null && typeof body === "object" && "query" in body ? body.query : undefined;
		if (typeof query !== "string") return "gh api graphql with a body the gate cannot read (the --input JSON has no string query)";
		bodies.push(query);
	}
	for (const body of bodies) {
		const fields = graphqlMutationFields(body);
		if (fields === null) return "gh api graphql with a body the gate cannot read (a query that does not parse as plain operations)";
		const off = fields.find((f) => !ORDINARY_GRAPHQL.includes(f));
		if (off !== undefined) return `gh api graphql with a mutation not on the ordinary allow-list (${off})`;
	}
	return null;
}

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * A GraphQL document's tokens (spec § 2.1: punctuators, names, numbers, strings and block strings; blanks,
 * commas and comments dropped, every string one `""` token), or null on a character the lexer does not take.
 */
function graphqlTokens(s: string): string[] | null {
	const out: string[] = [];
	const name = /[_A-Za-z][_0-9A-Za-z]*/y;
	const num = /-?[0-9][0-9.eE+-]*/y;
	let i = 0;
	while (i < s.length) {
		const c = s[i]!;
		if (/[\s,\ufeff]/.test(c)) i++;
		else if (c === "#") while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
		else if (s.startsWith('"""', i)) {
			let j = i + 3;
			while (j < s.length && !(s.startsWith('"""', j) && s[j - 1] !== "\\")) j++;
			if (j >= s.length) return null;
			out.push('""');
			i = j + 3;
		} else if (c === '"') {
			let j = i + 1;
			while (j < s.length && s[j] !== '"' && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
			if (j >= s.length || s[j] !== '"') return null;
			out.push('""');
			i = j + 1;
		} else if (s.startsWith("...", i)) {
			out.push("...");
			i += 3;
		} else if ("{}()[]:=!$@|&".includes(c)) {
			out.push(c);
			i++;
		} else {
			name.lastIndex = i;
			num.lastIndex = i;
			const m = name.exec(s) ?? num.exec(s);
			if (!m) return null;
			out.push(m[0]);
			i += m[0].length;
		}
	}
	return out;
}

/**
 * The root fields of every mutation in a GraphQL document (aliases resolved), [] when it holds only queries,
 * subscriptions and fragments, or null when it does not read as plain operations: a fragment spread or
 * inline fragment in a mutation's root selection (whose fields the gate would have to resolve), an
 * unbalanced bracket, or a token out of place.
 */
function graphqlMutationFields(body: string): string[] | null {
	const t = graphqlTokens(body);
	if (t === null) return null;
	const fields: string[] = [];
	let i = 0;
	/** Past the bracket group opening at `t[i]`; false when it never closes. */
	const skip = (open: string, close: string): boolean => {
		for (let depth = 0; i < t.length; i++) {
			if (t[i] === open) depth++;
			else if (t[i] === close && --depth === 0) {
				i++;
				return true;
			}
		}
		return false;
	};
	/** Past an operation's or fragment's header (name, variables, type condition, directives) to its `{`. */
	const header = (): boolean => {
		while (i < t.length && t[i] !== "{") {
			if (t[i] === "(") {
				if (!skip("(", ")")) return false;
			} else i++;
		}
		return t[i] === "{";
	};
	while (i < t.length) {
		const word = t[i]!;
		if (word === "{") {
			if (!skip("{", "}")) return null;
			continue;
		}
		if (word !== "query" && word !== "subscription" && word !== "fragment" && word !== "mutation") return null;
		i++;
		if (!header()) return null;
		if (word !== "mutation") {
			if (!skip("{", "}")) return null;
			continue;
		}
		i++;
		for (;;) {
			const f = t[i];
			if (f === undefined) return null;
			if (f === "}") {
				i++;
				break;
			}
			if (!GRAPHQL_NAME.test(f)) return null;
			i++;
			let field = f;
			if (t[i] === ":") {
				const real = t[i + 1];
				if (real === undefined || !GRAPHQL_NAME.test(real)) return null;
				field = real;
				i += 2;
			}
			fields.push(field);
			if (t[i] === "(" && !skip("(", ")")) return null;
			while (t[i] === "@") {
				if (!GRAPHQL_NAME.test(t[i + 1] ?? "")) return null;
				i += 2;
				if (t[i] === "(" && !skip("(", ")")) return null;
			}
			if (t[i] === "{" && !skip("{", "}")) return null;
		}
	}
	return fields;
}

/** The heredoc and here-string text a parsed command reads on stdin; null when it reads a pipe, a file, or a body not known until it runs. */
function stdinText(e: Exec): string | null {
	if (e.source.stdinFrom) return null;
	const reads = e.redirects.filter((r) => r.op.startsWith("<") && r.op !== "<&");
	if (reads.some((r) => r.body === null || r.bodyOpaque)) return null;
	return reads.map((r) => r.body).join("\n");
}

/**
 * Global options of the infrastructure CLIs whose reserved verbs RULES matches next to the program
 * name (M4 fix round 8, astra-8 B3: `kubectl --context production delete …` hid `kubectl delete`).
 * Each option's arity (0 a flag, 1 takes a value: `--context x`, `--context=x`, `-nx`, `-n=x`), and
 * whether the CLI also accepts them after the subcommand (cobra persistent flags; aws and gcloud
 * global options), where they are stripped too. The prefix is modeled positively: an option before
 * the subcommand outside the table is refused as unmodeled, since the verb after it cannot be found.
 * Sources, read 2026-09-29: `kubectl options` (v1.36.1), `doctl --help` Flags, `docker --help`
 * Global Options, `aws help` GLOBAL OPTIONS, `gcloud help` GCLOUD WIDE FLAGS (all installed here);
 * https://helm.sh/docs/helm/helm/ Options (helm 4.3.0, not installed); terraform main.go
 * extractChdirOption (`-chdir=DIR` only, before the subcommand; tofu shares it).
 */
interface GlobalOptions {
	options: Record<string, 0 | 1>;
	anywhere: boolean;
}
const arity = (values: string, flags: string): Record<string, 0 | 1> =>
	Object.fromEntries([...values.split(" ").map((o) => [o, 1] as const), ...flags.split(" ").map((o) => [o, 0] as const)]);
const TERRAFORM: GlobalOptions = { options: arity("-chdir", "-help -version -v --help --version -h"), anywhere: false };
const INFRA_GLOBALS: Record<string, GlobalOptions> = {
	kubectl: {
		options: arity(
			"--as --as-group --as-uid --as-user-extra --cache-dir --certificate-authority --client-certificate --client-key --cluster --context --kubeconfig --kuberc --log-flush-frequency -n --namespace --password --profile --profile-output --request-timeout -s --server --tls-server-name --token --user --username -v --v --vmodule",
			"--disable-compression --insecure-skip-tls-verify --match-server-version --warnings-as-errors -h --help",
		),
		anywhere: true,
	},
	doctl: { options: arity("-t --access-token -u --api-url -c --config --context --http-retry-max -o --output", "-h --help --interactive --trace -v --verbose"), anywhere: true },
	helm: {
		options: arity(
			"--burst-limit --color --colour --content-cache --kube-apiserver --kube-as-group --kube-as-user --kube-ca-file --kube-context --kube-tls-server-name --kube-token --kubeconfig -n --namespace --qps --registry-config --repository-cache --repository-config",
			"--debug -h --help --kube-insecure-skip-tls-verify",
		),
		anywhere: true,
	},
	docker: { options: arity("--config -c --context -H --host -l --log-level --tlscacert --tlscert --tlskey", "-D --debug --tls --tlsverify -v --version -h --help"), anywhere: false },
	aws: {
		options: arity(
			"--endpoint-url --output --query --profile --region --color --ca-bundle --cli-read-timeout --cli-connect-timeout --cli-binary-format --cli-error-format",
			"--debug --no-verify-ssl --no-paginate --version --no-sign-request --no-cli-pager --cli-auto-prompt --no-cli-auto-prompt",
		),
		anywhere: true,
	},
	gcloud: {
		options: arity(
			"--account --billing-project --configuration --flags-file --flatten --format --project --verbosity --access-token-file --impersonate-service-account --trace-token",
			"--help -h --quiet -q --version -v --log-http --no-log-http --user-output-enabled --no-user-output-enabled",
		),
		anywhere: true,
	},
	terraform: TERRAFORM,
	tofu: TERRAFORM,
};

/** How many words the global option at `args[i]` spans (1 or 2), or 0 when it is not one of `g`'s. */
function globalOptionSpan(g: GlobalOptions, args: Word[], i: number): number {
	const w = args[i]!;
	if (w.opaque || w.expanded || !w.text.startsWith("-")) return 0;
	const t = w.text;
	const eq = t.indexOf("=");
	const name = eq < 0 ? t : t.slice(0, eq);
	const n = g.options[name];
	if (g === TERRAFORM) return name === "-chdir" ? (eq > 0 && eq < t.length - 1 ? 1 : 0) : n === 0 && eq < 0 ? 1 : 0;
	if (n !== undefined) {
		if (eq >= 0) return 1; // `--context=x`, `-n=x`, a flag's `--debug=true`
		return n === 1 ? (i + 1 < args.length ? 2 : 0) : 1;
	}
	// A short option with its value attached (`-nkube-system`, `-v6`), as pflag reads it.
	return /^-[A-Za-z]./.test(t) && g.options[t.slice(0, 2)] === 1 ? 1 : 0;
}

/**
 * An infrastructure CLI's argv with its global options removed, so its verb sits next to the program
 * name for RULES (`kubectl --context prod delete deploy x` → `kubectl delete deploy x`); `unknown` when
 * an option before the verb is not one the table models; null for any other program.
 */
function infraArgs(e: Exec): { rest: Word[] } | { unknown: string } | null {
	const g = INFRA_GLOBALS[basename(e.argv[0]!.text)];
	if (!g) return null;
	const args = e.argv.slice(1);
	let i = 0;
	while (i < args.length && (args[i]!.opaque || args[i]!.text.startsWith("-")) && args[i]!.text !== "--") {
		const span = globalOptionSpan(g, args, i);
		if (span === 0) return { unknown: args[i]!.text || "…" };
		i += span;
	}
	const rest: Word[] = [];
	for (let k = i; k < args.length; k++) {
		const span = g.anywhere ? globalOptionSpan(g, args, k) : 0;
		if (span === 0) rest.push(args[k]!);
		else k += span - 1;
	}
	return { rest };
}

/** GNU coreutils rm long options (`rm --help`): a unique prefix of one is that option, as getopt_long reads it. */
const RM_LONG = ["force", "interactive", "one-file-system", "no-preserve-root", "preserve-root", "recursive", "dir", "verbose", "help", "version"];
/** Short options across GNU rm and BSD rm (macOS rm(1): -d -f -i -I -P -R -r -v -W -x). */
const RM_SHORT = /^-[dfiIPRrvWx]+$/;

/** One rm argument: its text, whether its value is unknown until it runs, and whether it is a path inside the own scratch root (scratchPath) or the own worktree (treePath). */
export interface RmArg {
	text: string;
	unread: boolean;
	glob?: boolean;
	inside?: boolean;
	tree?: boolean;
}

/**
 * The rm model (M4 fix round 5): options only from rm's own lists, long ones resolved by GNU prefix
 * rules (`--recu` is `--recursive`), an unknown or ambiguous one refused as unmodeled; recursive plus
 * force on any path is the § A4 reserved `rm -rf`. The only exemptions are the owned roots (Jo,
 * in-mvqyt4a8gezvgg; PLAN wl-mvqwn80onq9hq8 D11 removed the temp-directory one): an operand inside the
 * own scratch root (`inside`, PLAN wl-mv5oikd5jtquww § 1.2 rule 1), and when that exemption is what lets
 * the rm through, "rm" goes into `used`; an operand inside the own worktree (`tree`, the routine
 * classifier's rule, PLAN wl-mvqwn80onq9hq8 D2b), which records into `treeUsed`.
 */
export function rmModel(args: RmArg[], used?: Set<string>, treeUsed?: Set<string>): { reserved: boolean; why: string } | null {
	let r = false;
	let f = false;
	let dashdash = false;
	const operands: RmArg[] = [];
	for (const a of args) {
		if (a.unread && (a.text === "" || a.text.startsWith("-"))) return { reserved: true, why: "rm with an argument not known until it runs (it could be -rf)" };
		if (!a.unread && a.glob && globCouldBeRmFlag(a.text)) return { reserved: true, why: "rm with a glob that could expand to -rf" };
		if (dashdash || a.text === "-" || !a.text.startsWith("-")) {
			operands.push(a);
			continue;
		}
		if (a.text === "--") {
			dashdash = true;
			continue;
		}
		if (a.text.startsWith("--")) {
			const name = a.text.slice(2).split("=")[0]!;
			const hits = RM_LONG.filter((o) => o.startsWith(name));
			const opt = RM_LONG.includes(name) ? name : hits.length === 1 ? hits[0]! : null;
			if (!opt) return { reserved: false, why: hits.length > 1 ? `rm ${a.text}, an abbreviation rm reads as ambiguous (${hits.map((h) => `--${h}`).join(", ")})` : `rm ${a.text}, an option rm does not have` };
			if (opt === "recursive") r = true;
			if (opt === "force") f = true;
			continue;
		}
		if (!RM_SHORT.test(a.text)) return { reserved: false, why: `rm ${a.text}, an option rm does not have` };
		if (/[rR]/.test(a.text)) r = true;
		if (a.text.includes("f")) f = true;
	}
	if (!r || !f) return null;
	if (operands.some((o) => !o.inside && !o.tree)) return { reserved: true, why: "rm -rf (recursive force-delete) of a path outside the own scratch root" };
	if (operands.some((o) => o.inside)) used?.add("rm");
	if (operands.some((o) => o.tree)) treeUsed?.add("rm");
	return null;
}

/**
 * True when an `rm` in raw text is the reserved recursive force-delete (careful-guard.mjs
 * isRecursiveForceRm, now through rmModel). Surrounding quotes come off a word that is quoted
 * whole (`'-rf'`, `"/home/x"`); a word that only ends in a quote (`-rf"` in `rg "rm -rf" README.md`)
 * is the end of a quoted string, not a flag, and rmModel does not read it as one. With `scratch`, an
 * operand whose text spells a path inside the own root (scratchSpelling: literal, or
 * `"$AS2_SCRATCH/…"`) is exempt (rule 1's raw half).
 */
export function isRecursiveForceRm(seg: string, scratch?: Scratch): boolean {
	for (const m of seg.matchAll(/\brm\b([^\n;|&]*)/g)) {
		const args = m[1]!
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((t) => {
				const spelled = scratch ? scratchSpelling(t, scratch.root) : null;
				return { text: t.startsWith("-") ? t : t.replace(/^(['"])(.*)\1$/, "$2"), unread: /`|\$\(/.test(t), inside: spelled !== null && insideRoot(scratch!.root, spelled) };
			});
		if (rmModel(args, scratch?.used)?.reserved) return true;
	}
	return false;
}

/** What the routine classifier's options (ReservedOptions) change in the raw pass. */
interface RawOptions {
	/** Skip the `rm` check: the parsed pass judges every `rm` on its argv (a clean parse in a confining mode). */
	skipRm: boolean;
	tolerateUnread: boolean;
}

/**
 * The hold a shell command text reaches, or null: shellHits' pick under the floor's precedence (pickHit). Quote-blind; runs per
 * `;`/`&`/`|`/newline segment. `skipPrinters` passes segments that start with `echo`/`printf`: the
 * caller has checked their output reaches nothing that runs it (astra review round 2 false positive,
 * `printf "git reset --hard\n"`).
 */
export function reservedInShell(cmd: string, skipPrinters = false, scratch?: Scratch, raw?: RawOptions): string | null {
	return pickHit(shellHits(cmd, skipPrinters, scratch, raw));
}

/** Every row 6 hold in a shell command text, in text order (a segment's rm, then its gh api, then each RULES match), for the class precedence (pickHit). */
function shellHits(cmd: string, skipPrinters = false, scratch?: Scratch, raw?: RawOptions): string[] {
	const hits: string[] = [];
	const c = cmd.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
	if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c)) hits.push("fork bomb");
	for (const seg of c.split(/[;&|\n]+/).map((s) => s.trim()).filter(Boolean)) {
		if (skipPrinters && /^(echo|printf)(\s|$)/.test(seg)) continue;
		if (!raw?.skipRm && isRecursiveForceRm(seg, scratch)) hits.push("rm -rf (recursive force-delete)");
		const gh = ghApiInText(seg, raw?.tolerateUnread === true);
		if (gh) hits.push(gh);
		for (const { re, why } of RULES) if (re.test(seg)) hits.push(why);
	}
	return hits;
}

/**
 * ghApiModel's raw reading (`raw`: guard and unread checks only) over each `gh … api` in a raw segment:
 * its words split on spaces, quote-blind, with the quotes off a word quoted whole, and a word holding a
 * substitution unread (isRecursiveForceRm's reading).
 */
function ghApiInText(seg: string, tolerateUnread: boolean): string | null {
	for (const m of seg.matchAll(new RegExp(`${GH}api(?=\\s|$)`, "gi"))) {
		const args = seg
			.slice(m.index + m[0].length)
			.split(" ")
			.filter(Boolean)
			.map((t) => ({ text: t.replace(/^(['"])(.*)\1$/, "$2"), unread: /`|\$\(/.test(t) }));
		const why = ghApiModel(args, undefined, tolerateUnread, true);
		if (why) return why;
	}
	return null;
}

// The own scratch root (PLAN wl-mv5oikd5jtquww § 1.2). For a lane or hand whose process env names its
// workload, a target strictly inside `<base>/<workload id>/` (gates/src/scratch.ts ownScratchRoot,
// computed from HOME and the id, never taken from the variable) is housekeeping, not a reserved
// action: rm -rf there (rule 1), git's discard verdicts on a repository there (rule 2), any push
// whose destination is a path there (rule 3), git init/clone into it (rule 4, through rule 6), and
// `"$AS2_SCRATCH/…"` spelled where git wants literal text (rule 6). Rule 5: `.git` writes and hooks stay
// refused everywhere. Every call one of them lets through is marked confined (session.ts
// markConfined), and the fence runs it with writes only inside the root and no network, or refuses it.

/** The scratch rules' state for one bash call: the own root (physical), the command text word spans index, and each rule that changed a verdict. */
export interface Scratch {
	root: string;
	source: string;
	used: Set<string>;
}

/** The two ways to read the variable the rules accept (`$AS2_SCRATCH`, `${AS2_SCRATCH}`). */
const SCRATCH_READ = new RegExp(String.raw`\$${SCRATCH_ENV}\b|\$\{${SCRATCH_ENV}\}`, "g");
const SCRATCH_NAME = new RegExp(String.raw`\b${SCRATCH_ENV}\b`);

/**
 * The scratch rules for a bash call, or null when they are off: a role other than lane or hand, no own
 * root (ownScratchRoot: unbound, no such directory, or AS2_SCRATCH in the process env naming another
 * path), or the variable set or named in the call any way but a plain read: the bash tool's `env`, an
 * assignment, export or `env NAME=` (the expansion's `assigned`), and `for`/`read`/`unset`/`${…:=…}` or
 * any other mention of the name, which the expander may not follow.
 */
export function scratchFor(ctx: CallContext, cmd: string, x: Expansion, toolEnv?: unknown): Scratch | null {
	if (ctx.role !== "lane" && ctx.role !== "hand") return null;
	if (x.assigned.has(SCRATCH_ENV) || SCRATCH_NAME.test(cmd.replace(SCRATCH_READ, ""))) return null;
	if (toolEnv && typeof toolEnv === "object" && SCRATCH_ENV in toolEnv) return null;
	const root = ownScratchRoot(ctx.env);
	return root === null ? null : { root, source: cmd, used: new Set() };
}

/**
 * The path a parsed word names when it counts as inside the own root (§ 1.2): typed as an absolute
 * literal path, or spelled `"$AS2_SCRATCH/…"` (its text in the command, through the word's span), and
 * strictly below the root physically (scratch.ts insideRoot). Null for anything else: another variable,
 * a substitution, a glob, a relative path, a word the expander built (no span).
 */
function scratchPath(w: Word, s: Scratch): string | null {
	if (w.opaque || w.glob) return null;
	if (w.expanded) {
		if (!w.span || scratchSpelling(s.source.slice(w.span[0], w.span[1]), s.root) === null) return null;
	} else if (!w.text.startsWith("/")) return null;
	return insideRoot(s.root, w.text) ? w.text : null;
}

/** The git directory git finds at `dir`: its `.git` entry (a `gitdir:` file's target), or `dir` itself when it is a bare repository; null when neither. */
function gitDirAt(dir: string): string | null {
	const dotGit = resolve(dir, ".git");
	try {
		lstatSync(dotGit);
		try {
			if (statSync(dotGit).isFile()) {
				const m = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
				if (m) return resolve(dir, m[1]!.trim());
			}
		} catch {
			// a dangling link: judged by its own path below
		}
		return dotGit;
	} catch {
		// no .git entry here
	}
	return existsSync(resolve(dir, "HEAD")) && existsSync(resolve(dir, "objects")) && existsSync(resolve(dir, "refs")) ? dir : null;
}

/**
 * Rule 2's repository test: `dir` is inside the own root, and the repository git discovers from it
 * (walking up from its physical path) sits strictly inside the root with its gitdir and commondir. A
 * repository found at the root or above it is not inside; none at all (the call creates one, or git
 * fails) is.
 */
function repoInside(root: string, dir: string): boolean {
	if (!insideRoot(root, dir)) return false;
	for (let p = physicalPath(dir); ; p = dirname(p)) {
		const gd = gitDirAt(p);
		if (gd !== null) {
			if (!p.startsWith(`${root}/`) || !insideRoot(root, gd)) return false;
			let common: string | null = null;
			try {
				common = resolve(gd, readFileSync(resolve(gd, "commondir"), "utf8").trim());
			} catch {
				// no commondir: the gitdir is its own
			}
			return common === null || insideRoot(root, common);
		}
		if (p === "/") return true;
	}
}

/**
 * Rule 3's destination test: a `git push` whose destination operand is a plain path inside the own
 * root (scratchPath). A named remote, a URL, `file://`, `--repo`, a bare push, or any word unknown until
 * it runs is not.
 */
export function pushToScratch(git: GitCall, s: Scratch): boolean {
	if (git.args.some((w) => w.opaque || w.glob)) return false;
	const d = pushDestinationOperand(git);
	if (!d || d.repoOption || d.remote === null) return false;
	const w = git.args.find((a) => a.text === d.remote);
	return w !== undefined && scratchPath(w, s) !== null;
}

/**
 * Rule 6's hooks into gitUnmodeled for one command (exec.ts ScratchWords). A clone with a URL operand
 * (anything with a colon before its first slash: `https://`, `file://`, `host:path`) gets none: its
 * source must be a path (rule 4).
 */
function scratchWords(e: Exec, s: Scratch): ScratchWords | undefined {
	const g = gitCall(e);
	if (g?.sub === "clone" && g.args.some((w) => !w.text.startsWith("-") && /^[^/]*:/.test(w.text))) return undefined;
	return {
		word: (w) => {
			const ok = scratchPath(w, s) !== null;
			if (ok) s.used.add("spelling");
			return ok;
		},
		dir: (p) => {
			const ok = p !== "" && insideRoot(s.root, p);
			if (ok) s.used.add("dirLexical");
			return ok;
		},
	};
}

/**
 * Rules 2 and 3 for one git command: the command with its lexical directory (exec.ts dirLexical) when
 * git's own is unknown and the lexical one is inside the root, and the lifts that hold for it. In a
 * routine mode (`mode`): with `relative`, the scratch lifts hold only for a directory reached through
 * trusted `cd` hops (trustedDir); with `tree`, the own-worktree lift holds when the repository git
 * works on is the own worktree (treeRepo), reached the same way. Null when no lift can hold.
 */
function scratchGit(git: GitCall, e: Exec, s: Scratch | undefined, mode?: Mode): { call: GitCall; lift: ScratchLift } | null {
	if (!s) {
		if (!mode?.tree) return null;
		const tree = git.dir !== "" && trustedDir(e, mode.source, undefined) && treeRepo(mode.tree.root, git.dir);
		return { call: git, lift: { repo: false, push: false, used: [], ...(tree ? { worktree: [] } : {}) } };
	}
	const trusted = !mode?.relative || trustedDir(e, s.source, s.root);
	const lexical = git.dir === "" && git.dirLexical !== "" && insideRoot(s.root, git.dirLexical) && trusted;
	const call = lexical ? { ...git, dir: git.dirLexical } : git;
	if (lexical) s.used.add("dirLexical");
	// D11 own-root: in a routine mode the repo lift also sets aside reset --merge|--keep, checkout --force|--patch and switch --force|--discard-changes.
	const lift: ScratchLift = { repo: call.dir !== "" && trusted && repoInside(s.root, call.dir), push: call.dir !== "" && pushToScratch(git, s), used: [], ...(mode ? { discards: true } : {}) };
	if (mode?.tree && call.dir !== "" && trustedDir(e, mode.source, s.root) && treeRepo(mode.tree.root, call.dir)) lift.worktree = [];
	return { call, lift };
}

/** `lift`'s verdicts set aside, recorded on the call: the scratch lifts in `s.used`, the own-worktree lift in `tree.used`. */
function recordLifts(lift: ScratchLift | undefined, s: Scratch | undefined, tree?: Worktree): void {
	if (lift && s) for (const why of lift.used) s.used.add(`git: ${why}`);
	if (lift?.worktree && tree) for (const why of lift.worktree) tree.used.add(`git: ${why}`);
}

/** The workload's own worktree for the routine classifier (ReservedOptions.worktreeRoot): its physical root, and each rule that changed a verdict. */
interface Worktree {
	root: string;
	used: Set<string>;
}

/** The routine classifier's options for one bash call (ReservedOptions), resolved. */
interface Mode {
	tolerateUnread: boolean;
	/** scratchRelative: an rm operand reached through trusted `cd` hops counts inside the scratch root. */
	relative: boolean;
	tree?: Worktree;
	/** The command text the words' spans index. */
	source: string;
}

/**
 * The own worktree from `root`, or undefined (then nothing is confined to it): an absolute path to a
 * directory that exists, taken at its physical path (scratch.ts insideRoot compares physical paths).
 */
function worktreeFor(root: string | undefined): Worktree | undefined {
	if (!root || !root.startsWith("/") || root === "/" || !existsSync(root)) return undefined;
	return { root: physicalPath(resolve(root)), used: new Set() };
}

/**
 * Whether a command's directory can be trusted for a relative path (PLAN wl-mvqwn80onq9hq8 D2b): it is
 * known, and every `cd` hop that set it (SimpleCommand.hops) is literal text or a `"$AS2_SCRATCH/…"`
 * spelling of the scratch root (through the word's span in `source`), with no `..` component, which
 * chdir(2) takes from wherever a symlink before it led.
 */
function trustedDir(e: Exec, source: string, scratchRoot: string | undefined): boolean {
	if (!e.dirKnown) return false;
	return e.source.hops.every((h) => !h.opaque && !h.glob && !h.text.split("/").includes("..") && (!h.expanded || spelledInScratch(h, source, scratchRoot)));
}

function spelledInScratch(w: Word, source: string, scratchRoot: string | undefined): boolean {
	return w.span !== undefined && scratchRoot !== undefined && scratchSpelling(source.slice(w.span[0], w.span[1]), scratchRoot) !== null;
}

/**
 * The path an operand names when it is confined to `root` (D2b): neither opaque nor a glob, no `..`
 * component, literal text or a `"$AS2_SCRATCH/…"` spelling, relative only from a trusted directory
 * (trustedDir), and strictly below `root` physically (scratch.ts insideRoot). Null otherwise.
 */
function confinedOperand(root: string, e: Exec, w: Word, source: string, scratchRoot: string | undefined): string | null {
	if (w.opaque || w.glob || w.text === "" || w.text.split("/").includes("..")) return null;
	if (w.expanded && !spelledInScratch(w, source, scratchRoot)) return null;
	if (!w.text.startsWith("/") && !trustedDir(e, source, scratchRoot)) return null;
	const path = resolve(e.dir, w.text);
	return insideRoot(root, path) ? path : null;
}

/** An rm operand confined to the own worktree: confinedOperand, and no `.git` component in its spelled or physical path (the worktree's `.git` file and anything a link reaches inside a gitdir). */
function treePath(tree: Worktree, e: Exec, w: Word, source: string, scratchRoot: string | undefined): boolean {
	const path = confinedOperand(tree.root, e, w, source, scratchRoot);
	return path !== null && !insideDotGit(path) && !insideDotGit(physicalPath(path));
}

/**
 * Whether the repository git works on from `dir` is the own worktree: `dir` is the worktree root or
 * strictly below it (no `.git` component), and the first repository found walking up from it is the
 * worktree root's own (a nested repository inside the worktree is not).
 */
function treeRepo(root: string, dir: string): boolean {
	const start = physicalPath(dir);
	if (start !== root && !insideRoot(root, dir)) return false;
	if (insideDotGit(start.slice(root.length))) return false;
	for (let p = start; ; p = dirname(p)) {
		if (gitDirAt(p) !== null) return p === root;
		if (p === root || p === "/") return false;
	}
}

/**
 * True when every `echo`/`printf` in the command only prints: the command parses cleanly, has no pipe,
 * and no printer redirects its output into a file something could run later.
 */
function printersOnlyPrint(cmd: string, cwd: string, env: Record<string, string | undefined>): boolean {
	const p = parseShell(cmd, { cwd, env });
	if (p.failures.length > 0 || p.ops.some((o) => o.startsWith("|"))) return false;
	return p.commands.every((c) => {
		const head = c.words[0];
		if (!head || head.opaque || !OUTPUT_ONLY[basename(head.text)]) return true;
		return !c.redirects.some((r) => r.op.includes(">") && r.op !== ">&");
	});
}

/** git subcommands whose reserved spellings depend on their arguments. */
const GIT_ARG_SENSITIVE: Record<string, true> = { push: true, reset: true, clean: true, checkout: true, restore: true, branch: true, tag: true, "update-ref": true };
/** Commands whose reserved spellings sit in their first words (subcommand, target). */
const HEAD_SENSITIVE: Record<string, true> = {
	gh: true, psql: true, mysql: true, mongosh: true, mongo: true, "redis-cli": true, pg_restore: true, pg_dump: true, supabase: true,
	doctl: true, kubectl: true, terraform: true, tofu: true, pulumi: true, aws: true, gcloud: true, fly: true, flyctl: true, heroku: true,
	docker: true, vault: true, vercel: true, netlify: true, wrangler: true, firebase: true, serverless: true, sls: true, cdk: true, eb: true,
	helm: true, npm: true, pnpm: true, yarn: true, bun: true, dd: true,
};

/** SQL that only reads: one SELECT/SHOW/EXPLAIN/WITH/VALUES/TABLE statement with no writing keyword or side-effecting function. */
function readOnlySql(sql: string): boolean {
	const s = sql.trim().replace(/;\s*$/, "");
	if (!s || s.includes(";") || s.includes("\\")) return false;
	if (!/^(SELECT|SHOW|EXPLAIN|WITH|VALUES|TABLE)\b/i.test(s)) return false;
	if (/\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|LOCK|SET|RESET|COMMENT|SECURITY|REFRESH|IMPORT|NOTIFY|PREPARE|EXECUTE|DISCARD|INTO)\b/i.test(s)) return false;
	return !/\b(pg_\w+|nextval|setval|lo_\w+|dblink\w*|set_config)\s*\(/i.test(s);
}

/**
 * psql against a production target: refused unless it runs only `-c` queries that read (astra review
 * S3: the accepted rule is production database *writes*). A script (`-f`), stdin, or an interactive
 * session could write, so each is refused.
 */
function checkProductionPsql(e: Exec): string | null {
	const args = e.argv.slice(1);
	if (!args.some((w) => w.opaque || /\b(prod|production)\b/i.test(w.text))) return null;
	const refused = "a database client against a production target (psql runs only single read-only -c queries against production)";
	if (e.source.stdinFrom || e.redirects.some((r) => r.op.startsWith("<"))) return refused;
	const queries: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const w = args[i]!;
		if (w.opaque) return refused;
		const t = w.text;
		if (t === "-c" || t === "--command") {
			const q = args[++i];
			if (!q || q.opaque) return refused;
			queries.push(q.text);
		} else if (t.startsWith("--command=")) queries.push(t.slice("--command=".length));
		else if (/^-c./.test(t)) queries.push(t.slice(2));
		else if (t === "-f" || t === "--file" || t.startsWith("--file=") || /^-f./.test(t)) return refused;
	}
	return queries.length > 0 && queries.every(readOnlySql) ? null : refused;
}

/** rm flag words a glob could expand to that make an rm recursive or forced. */
const RM_FLAG_NAMES = ["-r", "-f", "-R", "-rf", "-fr", "-Rf", "-fR", "-rfv", "-vrf", "-rF", "--recursive", "--force"];

/** True when a glob could expand to an `rm` flag (`-[r]f`, `-?f`, a bare `*` over a file named `-rf`). */
function globCouldBeRmFlag(text: string): boolean {
	let re = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[") {
			const end = text.indexOf("]", i + 2);
			if (end < 0) re += "\\[";
			else {
				re += `[${text.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
				i = end;
			}
		} else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(`^${re}$`);
	} catch {
		return true;
	}
	return RM_FLAG_NAMES.some((n) => pattern.test(n));
}

/**
 * Options whose value git reads as text and never runs (PLAN wl-mupzpidbb3ksg0 § 1, a closed table):
 * the search patterns of `git log` and `git show`, keyed as git-model's tables key them. `git commit
 * -m` is not here (Jo, "log only"): a hook or editor can run a message.
 */
const DATA_OPTIONS: Record<string, readonly string[]> = { log: ["-S", "-G", "grep"], show: ["-S", "-G", "grep"] };

/**
 * The data words of a bash call, and the command with each one's span replaced by `_` for the raw
 * pass; null when any condition fails, and then neither pass masks anything. One decision per call:
 * no CR anywhere (the parser joins a backslash-CRLF line bash ends), a clean parse with nothing
 * blind, and for every git log/show Exec with a data option value: parsed at the top level of the
 * tool's own command (a span, and `source.top`), no wrappers or command-local assignments, only
 * `-C <literal>` before a literal subcommand, and each value word literal (not opaque, glob or
 * expanded). Each span, re-parsed alone, must be one word with the same text and no newline.
 */
function dataWords(cmd: string, x: Expansion, cwd: string, env: Record<string, string | undefined>): { words: Set<Word>; masked: string } | null {
	if (cmd.includes("\r") || x.blind.length > 0) return null;
	const words = new Set<Word>();
	const spans: [number, number][] = [];
	for (const e of x.commands) {
		const g = gitCall(e);
		const names = g?.sub ? DATA_OPTIONS[g.sub] : undefined;
		if (!g || !names) continue;
		const values = gitOptionValueWords(g, names);
		if (values.length === 0) continue;
		if (!e.source.top || e.mods.assigns.length > 0 || e.mods.wrappers.length > 0) return null;
		// `git`, its globals and the subcommand, then each value word: literal, and from the depth-0 parse (a span).
		const read = [...e.argv.slice(0, g.globals.length + 2), ...values.map((i) => g.args[i]!)];
		if (read.some((w) => w.opaque || w.glob || w.expanded)) return null;
		for (let k = 0; k < g.globals.length; k += 2) if (g.globals[k]!.text !== "-C" || g.globals[k + 1] === undefined) return null;
		for (const i of values) {
			const w = g.args[i]!;
			if (!w.span) return null;
			words.add(w);
			spans.push(w.span);
		}
	}
	if (words.size === 0) return null;
	for (const w of words) {
		const [start, end] = w.span!;
		const slice = cmd.slice(start, end);
		if (slice.includes("\n")) return null;
		const p = parseShell(slice, { cwd, env });
		const [only] = p.commands;
		if (p.failures.length > 0 || p.commands.length !== 1 || !only || only.redirects.length > 0 || only.words.length !== 1 || only.words[0]!.text !== w.text) return null;
	}
	// Right to left, so each replacement leaves the offsets before it unchanged; spans never overlap.
	spans.sort((a, b) => b[0] - a[0]);
	let masked = cmd;
	let limit = cmd.length;
	for (const [start, end] of spans) {
		if (end > limit) return null;
		masked = `${masked.slice(0, start)}_${masked.slice(end)}`;
		limit = start;
	}
	return { words, masked };
}

/**
 * Every hold one parsed command reaches, in today's order (its first is what row 6 named before the
 * floor's class precedence, pickHit). `data` are words left out of the final rules match (dataWords).
 * `scratch` turns on the scratch rules 1–3 for a bash call (scratchFor). `mode` carries the routine
 * classifier's options (ReservedOptions, PLAN wl-mvqwn80onq9hq8 D2a, D2b). `owned` says whether a
 * repository directory is the own worktree or a scratch repository: a work-tree discard anywhere else is
 * named with OTHER_CHECKOUT, the guard class (D11).
 */
function reservedInExec(e: Exec, owned: (dir: string) => boolean, data?: Set<Word>, scratch?: Scratch, mode?: Mode): string[] {
	const hits: string[] = [];
	const name = basename(e.argv[0]!.text);
	// A word the shell expands when it runs (a substitution or a glob): its value is not known here.
	const unread = (w: Word): boolean => w.opaque || w.glob === true;
	if (name === "rm") {
		const inside = (w: Word): boolean =>
			scratch !== undefined && (scratchPath(w, scratch) !== null || (mode?.relative === true && confinedOperand(scratch.root, e, w, scratch.source, scratch.root) !== null));
		const tree = mode?.tree;
		const args = e.argv.slice(1).map((w) => ({ text: w.text, unread: w.opaque, glob: w.glob, inside: inside(w), ...(tree ? { tree: treePath(tree, e, w, mode!.source, scratch?.root) } : {}) }));
		const rm = rmModel(args, scratch?.used, tree?.used);
		if (rm?.reserved) hits.push(rm.why);
	}
	if (name === "psql") {
		const why = checkProductionPsql(e);
		if (why) hits.push(why);
	}
	if (name === "gh") {
		const api = ghApiArgs(e.argv);
		const why = api ? ghApiModel(api.map((w) => ({ text: w.text, unread: unread(w) })), stdinText(e), mode?.tolerateUnread === true) : null;
		if (why) hits.push(why);
	}
	const git = gitCall(e);
	if (git) {
		const why = gitHold(git, e, owned, scratch, mode);
		if (why) hits.push(why);
	} else if (HEAD_SENSITIVE[name] && e.argv.slice(1, 4).some(unread) && !mode?.tolerateUnread) {
		hits.push(`${name} with a subcommand or target not known until it runs`);
	}
	// An infrastructure CLI's verb past its global options (astra-8 B3); an unknown one is refused as unmodeled.
	const infra = infraArgs(e);
	if (infra && "rest" in infra) {
		const bare = execText({ ...e, argv: [e.argv[0]!, ...infra.rest] }).replace(/\n/g, " ");
		for (const { re, why } of RULES) if (re.test(bare)) hits.push(why);
	}
	// git's own files (refs, packed-refs, HEAD, config, hooks) under any case spelling: a write there
	// moves a ref or installs a program git runs later, past every git spelling (M4 fix round 5). A
	// destination a `case` left is judged on each candidate, and one with an unknown part on the known
	// text on either side of it: a `.git` component there may put the write inside .git (item 102).
	for (const w of writeDestinations(e)) {
		const dotGit =
			insideDotGit(resolve(e.dir, w.text)) ||
			(w.candidates ?? []).some((c) => insideDotGit(resolve(e.dir, c))) ||
			(w.fragments ?? []).some((f) => insideDotGit(f.head) || insideDotGit(f.tail));
		if (dotGit) hits.push(DOT_GIT_WRITE);
	}
	// A printer's arguments are text. What it feeds (a pipe, a file) the raw pass over the whole
	// command still reads, and a shell reading its output is expanded on its own (src/exec.ts).
	if (OUTPUT_ONLY[name]) return hits;
	const text = execText(data ? { ...e, argv: e.argv.filter((w) => !data.has(w)) } : e).replace(/\n/g, " ");
	for (const { re, why } of RULES) if (re.test(text)) hits.push(why);
	return hits;
}

/** The hold one git command reaches (gitModel over the scratch lifts), or null; a discard outside every owned repository carries OTHER_CHECKOUT. */
function gitHold(git: GitCall, e: Exec, owned: (dir: string) => boolean, scratch?: Scratch, mode?: Mode): string | null {
	if (git.sub === null) return "git with a subcommand not known until it runs";
	if (GIT_ARG_SENSITIVE[git.sub] && git.args.some((w) => w.opaque || w.glob === true) && !mode?.tolerateUnread) return `git ${git.sub} with an argument not known until it runs`;
	const sg = scratchGit(git, e, scratch, mode);
	const call = sg?.call ?? git;
	if (call.sub === "push" && call.dir === "") return "git push from a directory not known until it runs";
	const v = gitModel(call, sg?.lift);
	if (v?.reserved) return v.discard && !owned(call.dir) ? `${v.why}, ${OTHER_CHECKOUT}` : v.why;
	recordLifts(sg?.lift, scratch, mode?.tree);
	return null;
}

/**
 * A bare push (`git push`, `git push origin`, `git push origin HEAD`) whose source is the current,
 * protected branch. With `scratch`, a push whose destination is a path inside the own root is not one
 * (rule 3: the destination is a scratch repository).
 */
function barePushOfProtected(e: Exec, scratch?: Scratch): string | null {
	const git = gitCall(e);
	if (!git || git.sub !== "push" || !git.dir) return null;
	const refspecs = git.args.filter((w) => !w.text.startsWith("-")).slice(1);
	if (!refspecs.every((s) => s.text === "HEAD" || s.text === "@")) return null;
	const branch = currentBranch(git.dir);
	if (!branch || !PROTECTED_BRANCH.test(branch)) return null;
	if (scratch && pushToScratch(git, scratch)) {
		scratch.used.add("git: push of a protected branch into the scratch root");
		return null;
	}
	return `push to a protected branch (current branch ${branch})`;
}

/**
 * Commands that reach a reserved action or run other commands: their names are modeled only as
 * literal text. Provenance (M4 fix round 4, S7): hand-derived from this gate's own code, not from an
 * external list. It is the union of (1) the names a row reads specially: `rm` and `find` here, `git`
 * in exec.ts gitUnmodeled, `sqlite3` in r10-raw-ledger.ts, `mkfs` in RULES; (2) every key of
 * exec.ts WRAPPERS, which run their arguments as a command; (3) the names the expander follows into
 * other commands: `eval`, `source`, `.`, `xargs`, `find`. Shells and interpreters are covered by
 * SHELLS and interpreterFamily beside it. Refresh: whenever a name is added to one of those three
 * places, add it here. The expanded-name check that reads this set is a second line: an expanded
 * name is still unwrapped and matched on its resolved text (probe `$'stdbuf' -o0 rm -rf …` refused
 * as rm -rf, M4 fix round 4).
 */
const RUNNERS: Record<string, true> = {
	git: true, rm: true, eval: true, exec: true, source: true, ".": true, xargs: true, find: true, env: true, sudo: true, doas: true,
	command: true, builtin: true, sqlite3: true, mkfs: true, nohup: true, timeout: true, nice: true, time: true,
	stdbuf: true, caffeinate: true, ionice: true, chronic: true,
};
/** Dash look-alikes (hyphen, en/em dash, minus, fullwidth): an `rm` operand spelled with one is not what it looks like. */
const NON_ASCII_DASH = /^[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/;

/** Programs that run a command line in a second shell somewhere the gate does not read (a remote host, a pty recorder). */
const REMOTE_SHELLS: Record<string, true> = { ssh: true, rsh: true, slogin: true, mosh: true, script: true };
/** Database clients whose target the § A4 production rule reads from their arguments. */
const DB_CLIENTS: Record<string, true> = { psql: true, mysql: true, mariadb: true, mongosh: true, mongo: true, "redis-cli": true, pg_dump: true, pg_restore: true };
/**
 * Variables a database client reads its target from (libpq PGHOST and kin, the MySQL client's
 * MYSQL_HOST, and the DATABASE_URL/MONGODB_URI convention scripts pass as an argument): a target from
 * the environment is one the gate cannot see is production.
 */
const DB_TARGET_ENV = /^(?:PG(?:HOST|HOSTADDR|SERVICE|SERVICEFILE|DATABASE|PORT)|DATABASE_URL|MYSQL_(?:HOST|TCP_PORT|UNIX_PORT)|MONGODB_URI|REDISCLI_\w+)$/;
/** Of those, the ones the clients read from the process environment on their own. */
const DB_CLIENT_ENV = /^(?:PGHOST|PGHOSTADDR|PGSERVICE|MYSQL_HOST)$/;

/** The allowed spelling for any git form the positive model or gitUnmodeled refuses without a narrower one. */
const GIT_FORM_SPELLING =
	"the git command without it: literal words, one of git's own subcommands (no alias), `-C <literal path to an existing directory>` (never with `-c`), `-c` only for user.name, user.email, color.*, advice.*, core.quotepath, init.defaultBranch, commit.gpgsign, tag.gpgsign or gc.auto (never `alias.*`), and no GIT_* variables, --git-dir, --work-tree or --config-env";

/**
 * A form the gate does not model, one command at a time, with the literal spelling to use instead
 * (M4 fix round 3: the default inverts, Jo 2026-09-29). The command may be harmless; the gate
 * cannot tell, so it refuses and names what it can read. `scratch`: the scratch rules (scratchFor).
 */
function unmodeledInExec(e: Exec, assigned: Map<string, Word[]>, env: Record<string, string | undefined>, scratch?: Scratch, mode?: Mode): { what: string; spelling: string } | null {
	const head = e.argv[0]!;
	const name = basename(head.text);
	if (/[^\x00-\x7f]/.test(head.text)) return { what: `the command name \`${head.text}\` has characters outside ASCII`, spelling: "the command name in plain ASCII" };
	if (head.expanded && (RUNNERS[name] || SHELLS[name] || HEAD_SENSITIVE[name] || interpreterFamily(name))) {
		return { what: `the command name \`${name}\` is spelled through an expansion (a variable, \`$'…'\`, braces or a substitution)`, spelling: `\`${name}\` typed out as literal text` };
	}
	// Wrapped forms are refused (§ A4 contract; M4 fix round 5, Plumb's call under Jo's "extend"):
	// sudo, doas, nice, nohup, timeout, time, exec, stdbuf, caffeinate, ionice, chronic, builtin, a
	// bare `env cmd`. Two spellings run nothing new and stay modeled: `env NAME=value… cmd` with only
	// assignments, judged as a `NAME=value cmd` prefix, and the `command -v`/`-V` lookup. xargs and
	// find -exec are judged on what they run.
	for (const w of e.mods.wrappers) {
		const [wrapper, ...flags] = w.split(" ");
		if (wrapper === "env" && flags.length === 0 && e.mods.assigns.length > 0) continue;
		if (wrapper === "command" && flags.some((f) => /^-[pvV]*[vV]/.test(f))) continue;
		if (wrapper === "xargs" || wrapper === "find") continue;
		// A sandbox-exec the fence did not write (its own copy is taken off before the rows read the
		// command, exec.ts bashCommand): the M4b fence adds sandbox-exec itself (item 65 review B1).
		if (wrapper === "sandbox-exec") {
			return { what: `\`${w}\` wraps the command in a Seatbelt profile of the model's own`, spelling: "the plain command without the sandbox-exec wrapper and without /bin/bash -c; the M4b OS fence adds sandbox-exec itself" };
		}
		return {
			what: `\`${w}\` wraps the command, and the gate refuses every wrapped form (it runs the command under another user, priority, time limit or environment)`,
			spelling: `the command without \`${wrapper}\`${wrapper === "env" ? " (`env NAME=value cmd` with only assignments is modeled)" : ""}`,
		};
	}
	if (e.argv[0]!.text === "function" || (!OUTPUT_ONLY[name] && e.argv.length > 1 && e.argv[1]!.text === "{" && !e.argv[1]!.expanded)) {
		return { what: "a shell function definition (its body runs later under the function's name, which the gate does not follow)", spelling: "the commands typed out where they run, without a function" };
	}
	// The switches that make bash expand an alias (PLAN wl-mv0n5r9cbafe9s § 2 C): posix mode (`set -o posix`,
	// `shopt -s -o posix`) and expand_aliases, which namesAliasSwitch refuses by name. A word bash may
	// read as either is refused too, since the gate cannot tell which it is.
	if (name === "set") {
		const end = e.argv.findIndex((w, i) => i > 0 && w.text === "--");
		const w = e.argv.slice(1, end < 0 ? undefined : end).find((a) => a.text === "posix" || a.opaque || a.expanded || a.glob);
		if (w) {
			return {
				what: w.text === "posix" && !w.opaque && !w.glob ? "`set` naming `posix` (posix mode turns bash alias expansion on)" : `\`set\` with an option word not typed out as literal text (\`${w.text || "…"}\`), which could be \`posix\` (posix mode turns bash alias expansion on)`,
				spelling: "`set` with literal options other than posix (`set -euo pipefail`), or positional words after `--` (`set -- \"$@\"`)",
			};
		}
	}
	if (name === "shopt") {
		const args = e.argv.slice(1);
		const w = args.find((a) => a.opaque || a.expanded || a.glob);
		if (w) return { what: `\`shopt\` with a word not typed out as literal text (\`${w.text || "…"}\`), which could turn on \`expand_aliases\` or \`posix\` (each turns bash alias expansion on)`, spelling: "`shopt` with literal option names other than expand_aliases and posix" };
		const flags = args.filter((a) => a.text.startsWith("-")).map((a) => a.text.slice(1)).join("");
		if (flags.includes("s") && args.some((a) => a.text === "posix")) return { what: "`shopt -s` naming `posix` (posix mode turns bash alias expansion on)", spelling: "`shopt` with literal option names other than expand_aliases and posix" };
	}
	if (SHELLS[name] && (e.argv.slice(1).some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text)) || e.mods.wrappers.some((w) => /^(?:xargs|find)\b/.test(w)))) {
		return { what: `\`${name}\` started as a second shell to run a command line`, spelling: "the command line run directly with the bash tool" };
	}
	if (REMOTE_SHELLS[name]) return { what: `\`${name}\` runs a shell (on another host or under a recorder) the gate cannot read`, spelling: "the command run directly on this machine with the bash tool" };
	if (DB_CLIENTS[name]) {
		const fromEnv = [...assigned.keys()].find((n) => DB_TARGET_ENV.test(n)) ?? Object.keys(env).find((n) => DB_CLIENT_ENV.test(n) && env[n]);
		const target = `\`${name}\` with the host, port and database typed out as literal arguments`;
		if (fromEnv) return { what: `${name} with its target taken from ${fromEnv} in the environment, which the gate cannot resolve (it could be production)`, spelling: target };
		const w = e.argv.slice(1).find((a) => a.opaque || a.expanded);
		if (w) return { what: `${name} with an argument not typed out as literal text (\`${w.text || "…"}\`): its target or query is unresolved`, spelling: target };
	}
	const git = gitUnmodeled(e, assigned, scratch ? scratchWords(e, scratch) : undefined);
	if (git) return { what: `${git}: a git form the gate does not model`, spelling: GIT_FORM_SPELLING };
	const call = gitCall(e);
	const sg = call ? scratchGit(call, e, scratch, mode) : null;
	const model = call ? gitModel(sg?.call ?? call, sg?.lift) : null;
	recordLifts(sg?.lift, scratch, mode?.tree);
	if (model && !model.reserved) return { what: `${model.why}: a git form the gate does not model`, spelling: model.spelling ?? GIT_FORM_SPELLING };
	if (name === "rm") {
		if (e.argv.slice(1).some((w) => NON_ASCII_DASH.test(w.text))) return { what: "rm with an operand that starts with a dash look-alike outside ASCII", spelling: "rm with ASCII flags" };
		const rm = rmModel(e.argv.slice(1).map((w) => ({ text: w.text, unread: w.opaque, glob: w.glob })));
		if (rm && !rm.reserved) return { what: rm.why, spelling: "rm with its own options (-r, -R, -f, -i, -d, -v, or a whole or uniquely abbreviated --recursive, --force, --interactive, --dir, --verbose)" };
	}
	if (name === "find" && e.argv.some((w) => w.text === "-delete")) {
		return { what: "find -delete, a recursive delete the gate cannot bound", spelling: "`find … -print` to list the files, then `rm` on the listed paths (never `rm -rf`)" };
	}
	const infra = infraArgs(e);
	if (infra && "unknown" in infra) {
		return { what: `${name} with the global option \`${infra.unknown}\` before its subcommand, which the gate does not model (so it cannot find the verb after it)`, spelling: `\`${name}\` with only its documented global options (\`--context\`, \`--namespace\`, \`--profile\`, \`--region\`, \`--project\`, \`-chdir=\`, …) before the subcommand` };
	}
	// A read-only command's output options (astra-7 B5): file -C derives its .mgc output; anything else output-shaped is refused.
	const out = readHeadUnmodeled(e);
	if (out) return { what: out, spelling: `\`${name}\` with only the options it documents that write nothing (\`file -C\` with a literal \`-m\` magic path)` };
	return null;
}

function refuseUnmodeled(u: { what: string; spelling: string }, detail: string): Refusal {
	return {
		block: true,
		reason:
			`P-11 row 6 refused this: ${u.what}. The gate refuses every form it does not model rather than guess whether it reaches a § A4 reserved action (SPEC-2.0.md:224-242). ` +
			`Spell it as ${u.spelling}. ${detail}`,
	};
}

/** A row 6 finding in code: a reserved action, an unmodeled form (`unmodeled`), or an unreadable launch to respell (`respell`, D2). */
interface CodeHit {
	why: string;
	detail: string;
	unmodeled?: { what: string; spelling: string };
	respell?: true;
}

/**
 * Reserved actions in eval (or inline interpreter) code: its literal text, its literal argv lists, and
 * what it spawns. With `processes` null (the eval tool, once D1 found no process start), only the
 * quote-blind phrase pass and the browser pass run: no process pass can raise a request for eval.
 * Otherwise `processes` is reservedInExec's `owned` (a work-tree discard outside it is guard class, D11).
 */
function reservedInCode(code: string, family: CodeFamily | undefined, cwd: string, env: Record<string, string | undefined>, processes: ((dir: string) => boolean) | null): CodeHit | null {
	const facts = codeFacts(code, family);
	const texts = [facts.folded, facts.folded.replace(/["'`]\s*,\s*["'`]/g, " "), ...facts.literals, ...facts.argvLists];
	const why = pickHit(texts.map((t) => reservedInShell(t)).filter((w): w is string => w !== null));
	if (why) return { why, detail: "Reached through eval code; eval runs shell and subprocesses the bash gate would otherwise miss." };
	const hit = processes ? reservedInProcesses(code, facts, family, cwd, env, processes) : null;
	if (hit) return hit;
	const bw = BROWSER_WRITE_CALL.exec(code);
	if (bw) return { why: `a browser write (${bw[1]})`, detail: "Reached through eval's browser API." };
	return null;
}

/** reservedInCode's process passes: the commands the code's processes run, their environment, and their readability. */
function reservedInProcesses(code: string, facts: CodeFacts, family: CodeFamily | undefined, cwd: string, env: Record<string, string | undefined>, owned: (dir: string) => boolean): CodeHit | null {
	// Literal text that is shell, read the way the shell reads it (`Bun.$\`git "reset" --hard\``), only
	// where the code starts a process: code that starts none cannot run a literal, and a literal that is
	// a file path was being opened and parsed as a script (a MIGRATION.md quoting `kubectl --context X
	// delete` held a read-only eval, MIGRATION.md follow-up 29). The quote-blind pass above still reads it.
	const commands = codeCommands(facts, family);
	const shells = commands === null ? [] : [...facts.literals, ...facts.argvLists].map((t) => ({ t, x: expandShell(t, cwd, env) }));
	const found = shells.flatMap(({ t, x }) => x.commands.flatMap((e) => reservedInExec(e, owned).map((why) => ({ why, t }))));
	const why = pickHit(found.map((f) => f.why));
	if (why) return { why, detail: `Reached through eval code (the string ${JSON.stringify(found.find((f) => f.why === why)!.t.slice(0, 120))}).` };
	// The environment the code gives the processes it starts (astra-8 B2), judged as the bash branch
	// judges it, before the per-literal forms below so its reason names the variable.
	const ienv = codeInterpreterEnv(code, family, cwd, env);
	for (const w of ienv.writes) {
		if (insideDotGit(resolve(cwd, w.text))) return { why: DOT_GIT_ENV_WRITE, detail: "Reached through eval code: a process it starts." };
	}
	if (ienv.unmodeled) {
		const u = { what: `${ienv.unmodeled} (an interpreter or loader setting)`, spelling: INTERPRETER_ENV_SPELLING };
		return { why: u.what, detail: "Reached through eval code: a process it starts.", unmodeled: u };
	}
	// Where the code starts processes, a command it may run (codeCommands: never a comment, and only
	// the tagged templates when Bun's shell tag is its only process start, astra-9 R1) is judged: an
	// unmodeled form or a command the gate cannot read to its end refuses (M4 fix round 3; a parse
	// failure is left out, since most literals are not shell at all).
	for (const t of commands ?? []) {
		const x = expandShell(t, cwd, env);
		for (const e of x.commands) {
			const u = unmodeledInExec(e, x.assigned, env);
			if (u) return { why: u.what, detail: `Reached through eval code (the string ${JSON.stringify(t.slice(0, 120))}).`, unmodeled: u };
		}
		const blind = x.blind.find((b) => !b.startsWith("the command could not be parsed"));
		if (blind) {
			return {
				why: "a process started by inline interpreter code with a command the gate cannot read to the end",
				detail: `${blind} (the string ${JSON.stringify(t.slice(0, 120))}). Spell the command as literal text, or run it with the bash tool, so the gate can read it.`,
				respell: true,
			};
		}
	}
	const spawn = opaqueSpawn(facts, family);
	if (spawn) {
		return {
			why: "a process started by inline interpreter code with arguments the gate cannot read",
			detail: `The code has ${spawn}. Spell the command as literal text, or run it with the bash tool, so the gate can read it.`,
			respell: true,
		};
	}
	return null;
}

/** Browser actions that change state outside the machine (A4 build requirement: browser writes). */
const BROWSER_WRITE_ACTION = /^(click|dblclick|type|fill|fill_form|press|press_key|type_text|select|select_option|check|uncheck|upload|upload_file|drag|submit|handle_dialog|evaluate|evaluate_script|run)$/i;

/** Refusals that name a reserved action (FLOOR classes A4, deploy, own-root), with the action: what a `reserved-request` entry records. */
const RESERVED_ACTION = new WeakMap<object, string>();
/** Guard-class refusals (FLOOR), with the hold they name: no reserved request. */
const GUARD_HOLD = new WeakMap<object, string>();

/** The reserved action a row 6 refusal names; null for a guard-class hold (D11), an unmodeled form, an unreadable command or a process started from eval (respell, not Jo's call). */
export function reservedAction(r: Refusal): string | null {
	return (r && RESERVED_ACTION.get(r)) ?? null;
}

/** The FLOOR class of a row 6 refusal's hold, or null when it names none (an unmodeled form, a respelling, no refusal). */
export function refusalClass(r: Refusal): FloorClass | null {
	if (!r) return null;
	if (GUARD_HOLD.has(r)) return "guard";
	const why = RESERVED_ACTION.get(r);
	return why === undefined ? null : (floorRow(why)?.class ?? "A4");
}

/** The refused call, as a `reserved-request` entry body names it: its command, code, browser action or path. */
function refusedVerb(call: ToolCall): string {
	const { toolName, input } = call;
	if (toolName === "bash") return bashCommand(input);
	if (toolName === "eval") return `eval: ${String(input.code ?? input.cell ?? "")}`;
	if (typeof input.path === "string") return `${toolName} ${input.path}`;
	return typeof input.action === "string" ? `${toolName} ${input.action}` : toolName;
}

/** The body of the `reserved-request` entry for a refusal of `call` (surface/src/errors.ts renders it after "reserved action waiting on you"). */
export function reservedRequestBody(call: ToolCall, action: string, toolCallId: string | undefined): string {
	return `${action}: ${refusedVerb(call).trim()} (P-11 row 6 refused tool call ${toolCallId ?? "unknown"})`;
}

/**
 * A refusal naming a hold. A guard-class hold (FLOOR, D11) is refused outright: no reserved request, nothing to Jo,
 * and the reason names the owner and the spelling to use instead. Any other is a § A4 reserved action, which
 * becomes a `reserved-request` for Jo, worded as before the floor.
 */
function refuse(why: string, detail: string): Refusal {
	const row = floorRow(why);
	if (row?.class === "guard") {
		const g = {
			block: true as const,
			reason:
				`P-11 row 6 refused this: ${why}. It is guarded for ${row.owner} (Jo's floor, PLAN wl-mvqwn80onq9hq8 D11; ${row.a4}): ` +
				`it is not a reserved action, so no request is written and nothing is raised to Jo. Use instead: ${row.instead}. ${detail}`,
		};
		GUARD_HOLD.set(g, why);
		return g;
	}
	const r = {
		block: true as const,
		reason:
			`P-11 row 6 refused this: ${why} is on the § A4 reserved list (SPEC-2.0.md:224-242), which no 2.0 agent runs. ` +
			`Do not reword, script or route around it. A hand reports what it would have run and why, and stops; ` +
			`the lane raises it to Jo as a P-7b reserved item. Once the lane has gone past it, it withdraws the request with \`lane_withdraw_reserved\`. ${detail}`,
	};
	RESERVED_ACTION.set(r, why);
	return r;
}

/** A refusal for a respelling (PLAN wl-muzs0ytnaet1v4 D3): not a reserved action, so nothing reaches Jo. */
function refuseRespell(why: string, detail: string): Refusal {
	return { block: true, reason: `P-11 row 6 refused this: ${why}. It is not a reserved action and nothing is raised to Jo; ${detail}` };
}

/** A `%load` argument as the file it names, or null: a literal path (quoted or bare, no variables or URL) to a file the gate can read. */
function loadedFile(arg: string, cwd: string): string | null {
	const path = /^(["'])([^"'$`{}]+)\1$/.exec(arg)?.[2] ?? (/^[^\s"'$`{}~-][^\s"'$`{}]*$/.test(arg) ? arg : null);
	if (path === null || /^[a-z][\w+.-]*:\/\//i.test(path)) return null;
	try {
		const p = resolve(cwd, path);
		return statSync(p).isFile() ? readFileSync(p, "utf8") : null;
	} catch {
		return null;
	}
}

/**
 * Row 6 over eval code (PLAN wl-muzs0ytnaet1v4 D1): a process start is refused outright with "use the
 * bash tool" and is never reserved; each `%load` is read and judged as the cell's code (a load the gate
 * cannot read, or one inside a loaded file, is refused for a respelling); code with no process start
 * runs reservedInCode with its process passes off.
 */
function checkEvalCode(code: string, family: CodeFamily | undefined, ctx: CallContext, loaded: boolean): Refusal {
	const facts = codeFacts(code, family);
	const start = evalProcessStart(facts, family);
	if (start) {
		return {
			block: true,
			reason:
				`P-11 row 6 refused this: eval code that starts a process (\`${start}\`). Commands run through the bash tool, where the gate reads them; this is not a reserved action and nothing is raised to Jo. ` +
				"Run the command with the bash tool. Do not start it from eval by another API, a subprocess, a magic or an interpreter's `-e`/`-c`.",
		};
	}
	for (const arg of evalLoads(facts, family)) {
		if (loaded) return refuseRespell(`a \`%load ${arg}\` inside a file another \`%load\` runs`, "the gate reads one level of `%load`. Paste the code into the cell.");
		const text = loadedFile(arg, ctx.cwd);
		if (text === null) return refuseRespell(`a \`%load ${arg}\` the gate cannot read (a literal absolute or cwd-relative path to a readable file, with no variables or internal URL, is read)`, "paste the code into the cell, or %load a file by its literal path.");
		const r = checkEvalCode(text, family, ctx, true);
		if (r) return r;
	}
	const hit = reservedInCode(code, family, ctx.cwd, ctx.env, null);
	if (!hit) return null;
	return hit.unmodeled ? refuseUnmodeled(hit.unmodeled, hit.detail) : refuse(hit.why, hit.detail);
}

/**
 * Whether a command defines a shell function (`f() { …; }`, `f () ( … )`, `function f { …; }`). The
 * parser reads a definition as an ordinary command named `f` (its body words become `f`'s
 * arguments), so a body would run later under a name the gate does not follow: refused (M4 fix
 * round 5, fable's function-body probe). Quoted text, comments and heredoc bodies are not definitions.
 */
export function definesFunction(cmd: string): boolean {
	const lines = cmd.replace(/\r\n?/g, "\n").split("\n");
	const kept: string[] = [];
	let delimiter: string | null = null;
	for (const line of lines) {
		if (delimiter !== null) {
			if (line.replace(/^\t+/, "") === delimiter) delimiter = null;
			continue;
		}
		kept.push(line);
		const h = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
		if (h) delimiter = h[2]!;
	}
	const bare = kept
		.join("\n")
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
		.replace(/(^|\s)#[^\n]*/g, "$1");
	return /(?:^|[;&|\n({}]|\b(?:then|do|else))\s*(?:function\s+[^\s;&|()<>]+|[^\s;&|()<>=$'"`]+\s*\(\s*\)\s*[{(]|[^\s;&|()<>=$'"`]+\s*\(\s*\)\s*$)/m.test(bare);
}

/** The refusal for an alias definition (PLAN wl-mv0n5r9cbafe9s § 2, Jo's "every alias"). */
const ALIAS_DEFINITION = { what: "an alias definition (the alias runs its value under its own name, which the gate does not expand)", spelling: "the command typed out where it runs, without an alias" };
/** The refusal for a trap action outside t3's allowlist. */
const TRAP_ACTION = {
	what: "a trap action the gate does not model (bash runs it later inside the shell itself, where an alias or function it defines would hide what later commands run)",
	spelling: `the commands run explicitly at the end of the command line instead of in a trap, or a trap whose action only runs rm, rmdir, echo, kill, :, true, false or exit, typed out literally, with redirects only to /dev/null, using only letters, digits, blanks and _ . / : = @ % + , ' " $ ; & | > -, and without the word \`function\``,
};
/** Trap-action heads that cannot define an alias or a function, read code, set a trap or assign a variable (§ 2 D t3, condition 3). */
const TRAP_HEADS: Record<string, true> = { rm: true, rmdir: true, echo: true, kill: true, ":": true, true: true, false: true, exit: true };

/** Text as bash joins and unquotes it for the text passes: backslash-newline pairs removed, then every `'`, `"` and `\` deleted. */
function unquoted(text: string): string {
	return text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
}

/** Every decoded word of an expansion: each command's argv, prefix assignments and redirect targets, and every assigned value. */
function decodedWords(x: Expansion): Word[] {
	const words: Word[] = [];
	for (const e of x.commands) {
		words.push(...e.argv, ...e.mods.assigns);
		for (const r of e.redirects) if (r.target) words.push(r.target);
	}
	for (const values of x.assigned.values()) words.push(...values);
	return words;
}

/** t1 and t2 over a command text and its expansion. */
function aliasDefinitionIn(text: string, x: Expansion): boolean {
	if (x.commands.some((e) => e.argv[0]!.text === "alias" && e.argv.slice(1).some((w) => w.text.includes("=") || w.opaque || w.expanded || w.glob))) return true;
	return [text, ...decodedWords(x).map((w) => w.text)].map(unquoted).some((t) => /\balias\b/.test(t) && /[=$`]/.test(t));
}

/**
 * t3: whether the action a `trap` command installs could define an alias. It runs later inside the
 * shell itself, so the action passes only on a fixed allowlist with no recursion (§ 2 D t3,
 * conditions 1-6); `-p`/`-l`, a literal empty action and `-` install nothing the gate must read.
 * The action is parsed and expanded against an empty environment: its variables take their values
 * when it runs, not at gate time, so every `$VAR` in it is unknown and an unknown head is refused.
 */
function trapActionUnmodeled(e: Exec): boolean {
	const args = e.argv.slice(1);
	let i = 0;
	for (; i < args.length; i++) {
		const w = args[i]!;
		if (w.opaque || w.glob || !/^-./.test(w.text)) break;
		if (w.text === "--") {
			i++;
			break;
		}
		if (/[pl]/.test(w.text)) return false;
	}
	const action = args[i];
	if (!action) return false;
	if (action.opaque || action.glob) return true;
	if (action.text === "" || action.text === "-") return false;
	// Condition 6: the action holds only ASCII letters, digits, space, tab, newline and
	// `_ . / : = @ % + , ' " $ ; & | > -`, and not the word `function`. An allowlist closes the
	// escapes and normalizations inside the decoded action at once: a `$'…\r'` CR the parser would
	// turn into a newline where bash runs a command named `echo\r` (a raw CR in the outer command is
	// normalized before this text exists; definesAlias refuses it), and a backslash, glob, `#` or `~`
	// is an escape or expansion the text passes would have to model. Nothing left has a nested parse.
	// The excluded `( ) { } < `` ` keep
	// their earlier reasons: `(` covers a `name()` definition, `$(` and `<(`; `{` covers `${` and a
	// function body; `<` covers heredocs and herestrings; and a backquote body is parsed below top
	// level, where a keyword the parser drops is never recorded in `keywords`.
	if (/[^A-Za-z0-9 \t\n_.\/:=@%+,'"$;&|>-]/.test(action.text) || /\bfunction\b/.test(unquoted(action.text))) return true;
	// Conditions 3-5 on the raw parse first: expansion drops a bare `exec` (a wrapper unwrap strips)
	// and any statement with no argv, with its redirects (`exec >f`, `exec 3>f`, `>f`). The head must
	// be a literal TRAP_HEADS name, which also refuses `exec`, `command`, `builtin`, `env` and a
	// leading NAME=value word (no allowlisted name contains `=`). The parser drops every word it reads
	// as a keyword in command position and lists it in `keywords`: shell syntax (`if`, `time`, `!`), a
	// quoted keyword bash runs as a command (`"time" echo x`) and an Object.prototype name
	// (`constructor`), so any dropped word refuses the action.
	const raw = parseShell(action.text, { cwd: e.dir, env: {} });
	if (raw.failures.length > 0 || raw.keywords.length > 0) return true;
	const rawUnmodeled = raw.commands.some((c) => {
		const head = c.words[0];
		if (!head || head.opaque || head.expanded || head.glob || !TRAP_HEADS[head.text]) return true;
		return c.redirects.some((r) => !r.target || r.target.opaque || r.target.expanded || r.target.glob || r.target.text !== "/dev/null" || r.body !== null);
	});
	if (rawUnmodeled) return true;
	const ax = expandShell(action.text, e.dir, {});
	if (ax.blind.length > 0 || ax.code.length > 0 || ax.assigned.size > 0 || aliasDefinitionIn(action.text, ax)) return true;
	return ax.commands.some((c) => {
		const head = c.argv[0]!;
		if (head.opaque || head.expanded || head.glob || !TRAP_HEADS[head.text] || c.mods.wrappers.length > 0 || c.mods.assigns.length > 0) return true;
		return c.redirects.some((r) => !r.target || r.target.opaque || r.target.glob || r.target.text !== "/dev/null" || r.body !== null);
	});
}

/**
 * Whether a command defines a bash alias (PLAN wl-mv0n5r9cbafe9s § 2 D; MIGRATION.md item 81): an
 * alias runs its value under its own name, which no row expands, so every definition is refused.
 * t1, a parsed `alias` head (any spelling the parser resolves, any wrapper) with an operand that has
 * `=` or is not typed out; t2, the whole word `alias` beside `=`, `$` or a backquote in the unquoted
 * raw text or any decoded word, which catches a head the variable model computes wrongly; t3, a trap
 * action off the allowlist. Returns the refusal's what and spelling, or null.
 */
export function definesAlias(cmd: string, x: Expansion): { what: string; spelling: string } | null {
	if (aliasDefinitionIn(cmd, x)) return ALIAS_DEFINITION;
	const traps = x.commands.filter((e) => e.argv[0]!.text === "trap");
	// parseShell turns every CR and CRLF in the whole command into LF before any row sees it, so a
	// CR inside a quoted action reaches t3 as a newline, where bash keeps it and runs `echo\r`.
	// It also decodes $'…' itself, and some escapes (\u, \U and others) decode differently from
	// bash 3.2's, so the action t3 checks is not the one bash runs. Condition 6 never sees the raw
	// text, so any CR or $' in a command that sets a trap is refused here. That check reads only the
	// tool's own command: a trap parsed from any other text (eval, a sourced file, a script run by
	// path, `bash <file>`, xargs, find -exec, a `bash -c` string, a heredoc fed to a shell) was
	// normalized and decoded where no raw check can reach. Only the depth-0 parse of the tool's own
	// command records Word.span (Expander.shell's `spans`), so a trap whose head has no span is
	// refused, and so is any trap beside an eval, source or `.`.
	if (traps.some((e) => e.argv[0]!.span === undefined)) return TRAP_ACTION;
	if (traps.length > 0 && (/\r|\$'/.test(cmd) || x.commands.some((e) => ["eval", "source", "."].includes(e.argv[0]!.text)))) return TRAP_ACTION;
	return traps.some(trapActionUnmodeled) ? TRAP_ACTION : null;
}

/** The names that turn bash alias expansion or posix mode on, or preset the shell's options or aliases (§ 2 C). */
const ALIAS_SWITCH_NAMES = ["expand_aliases", "POSIXLY_CORRECT", "BASH_ALIASES", "SHELLOPTS", "BASHOPTS"];
const ALIAS_SWITCH = new RegExp(String.raw`\b(?:${ALIAS_SWITCH_NAMES.join("|")})\b`);

/**
 * A switch that turns bash alias expansion on, named anywhere (§ 2 C, defence in depth beside
 * definesAlias): one of ALIAS_SWITCH's names as a whole word in the raw text (quotes and heredoc
 * bodies included), in the unquoted raw text or in a decoded word; or the bash tool's `env` setting
 * one of them, POSIX_PEDANTIC, or an imported `BASH_FUNC_` function. Returns the refusal, or null.
 */
export function namesAliasSwitch(cmd: string, env: unknown, x: Expansion): { what: string; spelling: string } | null {
	if (env && typeof env === "object") {
		const key = Object.keys(env).find((k) => ALIAS_SWITCH_NAMES.includes(k) || k === "POSIX_PEDANTIC" || k.startsWith("BASH_FUNC_"));
		if (key) return { what: `the bash tool's env sets \`${key}\`, which presets bash's posix mode, options, aliases or functions before the command runs`, spelling: "the call without that env entry" };
	}
	for (const text of [cmd, unquoted(cmd), ...decodedWords(x).map((w) => w.text)]) {
		const m = ALIAS_SWITCH.exec(text);
		if (m) return { what: `\`${m[0]}\` named in the command (it turns bash alias expansion or posix mode on, or presets the shell's options or aliases)`, spelling: "the command without naming it; for text that names it, the grep or write tool, or `git commit -F <file>`" };
	}
	return null;
}

/** The allowed spelling for an interpreter environment interpreterEnv does not model. */
const INTERPRETER_ENV_SPELLING =
	"the command without that variable: code in a script or `-e` the gate reads, NODE_OPTIONS/BUN_OPTIONS of reporting and memory options only, and a warnings file only as a literal absolute path";

/**
 * The routine classifier's options for row 6 (PLAN wl-mvqwn80onq9hq8 D2a (i), D2b). Without them row 6
 * judges a call as it always has.
 */
export interface ReservedOptions {
	/**
	 * Skip exactly three whys, in the raw and the parsed pass: ghApiModel's "word not known until it runs",
	 * `<name> with a subcommand or target not known until it runs` and `git <sub> with an argument not
	 * known until it runs`. The classifier then judges every unread word itself.
	 */
	tolerateUnread?: boolean;
	/**
	 * In the parsed pass, an rm operand relative to a directory reached through trusted `cd` hops counts
	 * inside the own scratch root when it is (confinedOperand), and the scratch git lifts need those hops
	 * too (scratchGit). The raw pass's rm check is skipped when the parse is clean (empty `x.blind`), so
	 * every rm is judged on its argv.
	 */
	scratchRelative?: boolean;
	/**
	 * The workload's own worktree (its `worktree:` control entry): an rm operand confined to it (treePath)
	 * and git's work-tree discards on it (git-model.ts ScratchLift.worktree) are set aside, recorded in
	 * ReservedVerdict.worktree. The raw pass's rm check is skipped as for scratchRelative.
	 */
	worktreeRoot?: string;
}

/** Row 6's verdict with what let it through: each scratch rule (`scratch`) and each own-worktree rule (`worktree`) that changed a verdict. */
export interface ReservedVerdict {
	refusal: Refusal;
	scratch: string[];
	worktree: string[];
}

/**
 * Row 6's call context: the session's, plus the workload's own worktree (its `worktree:` control entry, lanes only),
 * which classes a work-tree discard there as own-root rather than guard (FLOOR, D11).
 */
export interface ReservedContext extends CallContext {
	worktreeRoot?: string;
}

/**
 * Whether a repository directory is owned (D11): the own worktree (treeRepo) or a repository inside the own scratch
 * root (repoInside, the scratch root from scratchFor or, for a lane or hand, ownScratchRoot). An unknown directory
 * ("") is not: a discard there is refused as guard, and the agent can spell the directory.
 */
function ownedRepos(ctx: ReservedContext, worktreeRoot: string | undefined, scratch: Scratch | undefined): (dir: string) => boolean {
	const tree = worktreeFor(worktreeRoot);
	const root = scratch?.root ?? (ctx.role === "lane" || ctx.role === "hand" ? ownScratchRoot(ctx.env) : null);
	return (dir) => dir !== "" && ((tree !== undefined && treeRepo(tree.root, dir)) || (root !== null && repoInside(root, dir)));
}

/**
 * Row 6 over one tool call. A bash call the scratch rules (scratchFor) let through is marked confined
 * for the fence (session.ts markConfined). With `opts` (the routine classifier's options) nothing is
 * marked: the classifier reads reservedVerdict, and the gate marks the call after it records the
 * auto-apply (PLAN wl-mvqwn80onq9hq8 D3).
 */
export function checkReserved(call: ToolCall, ctx: ReservedContext, opts?: ReservedOptions): Refusal {
	const v = reservedVerdict(call, ctx, opts);
	if (!opts && v.refusal === null && v.scratch.length > 0) markConfined(call);
	return v.refusal;
}

/**
 * checkReserved's judgement, without marking the call: the refusal, and the scratch and own-worktree rules that
 * changed a verdict. The bash branch collects every hold of the raw pass, the parsed pass and the interpreter
 * environment, and names one by the floor's precedence (pickHit).
 */
export function reservedVerdict(call: ToolCall, ctx: ReservedContext, opts?: ReservedOptions): ReservedVerdict {
	const { toolName, input } = call;
	const none = (refusal: Refusal): ReservedVerdict => ({ refusal, scratch: [], worktree: [] });
	if (toolName === "bash") {
		const cmd = bashCommand(input);
		const cwd = typeof input.cwd === "string" ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
		const x = expandShell(cmd, cwd, ctx.env, input.env);
		const scratch = scratchFor(ctx, cmd, x, input.env) ?? undefined;
		const tree = worktreeFor(opts?.worktreeRoot);
		const mode: Mode | undefined = opts && { tolerateUnread: opts.tolerateUnread === true, relative: opts.scratchRelative === true, ...(tree ? { tree } : {}), source: cmd };
		const bash = (refusal: Refusal): ReservedVerdict => ({ refusal, scratch: [...(scratch?.used ?? [])], worktree: [...(tree?.used ?? [])] });
		const owned = ownedRepos(ctx, opts?.worktreeRoot ?? ctx.worktreeRoot, scratch);
		const data = dataWords(cmd, x, cwd, ctx.env);
		const rawOpts = mode && { skipRm: (mode.relative || tree !== undefined) && x.blind.length === 0, tolerateUnread: mode.tolerateUnread };
		const hits = shellHits(data?.masked ?? cmd, printersOnlyPrint(cmd, cwd, ctx.env), scratch, rawOpts);
		for (const e of x.commands) {
			const exec = reservedInExec(e, owned, data?.words, scratch, mode);
			const bare = barePushOfProtected(e, scratch);
			hits.push(...exec, ...(bare ? [bare] : []));
		}
		// Files an interpreter writes because of its environment (astra-7 B3): none inside .git.
		const ienv = interpreterEnv(x, cwd);
		if (ienv.writes.some((w) => insideDotGit(resolve(cwd, w.text)))) hits.push(DOT_GIT_ENV_WRITE);
		const held = pickHit(hits);
		if (held) return bash(refuse(held, `Command: ${cmd}`));
		if (definesFunction(cmd)) {
			return bash(refuseUnmodeled({ what: "a shell function definition (its body runs later under the function's name, which the gate does not follow)", spelling: "the commands typed out where they run, without a function" }, `Command: ${cmd}`));
		}
		// Item 81 (PLAN wl-mv0n5r9cbafe9s § 2): every alias definition, then every switch that turns alias expansion on.
		const alias = definesAlias(cmd, x) ?? namesAliasSwitch(cmd, input.env, x);
		if (alias) return bash(refuseUnmodeled(alias, `Command: ${cmd}`));
		for (const e of x.commands) {
			const u = unmodeledInExec(e, x.assigned, ctx.env, scratch, mode);
			if (u) return bash(refuseUnmodeled(u, `Command: ${cmd}`));
		}
		if (ienv.unmodeled) return bash(refuseUnmodeled({ what: `${ienv.unmodeled} (an interpreter or loader setting)`, spelling: INTERPRETER_ENV_SPELLING }, `Command: ${cmd}`));
		for (const c of x.code) {
			const hit = reservedInCode(c.text, c.family, c.dir, ctx.env, owned);
			if (!hit) continue;
			const detail = `${hit.detail} Command: ${cmd}`;
			// An unreadable launch in inline code is a respelling, not Jo's call (PLAN wl-muzs0ytnaet1v4 D2).
			return bash(hit.unmodeled ? refuseUnmodeled(hit.unmodeled, detail) : hit.respell ? refuseRespell(hit.why, detail) : refuse(hit.why, detail));
		}
		if (x.blind.length > 0) {
			return bash(refuseRespell("a command the gate cannot read to the end", `${x.blind[0]}. The gate refuses what it cannot see rather than pass it; spell the command out literally. Command: ${cmd}`));
		}
		return bash(null);
	}
	if (toolName === "eval") {
		// The eval tool runs JavaScript or Python. Its `language` picks the comment syntax, as in row 10,
		// so a comment is never a command (astra-9 R1).
		const lang = input.language;
		const family = lang === "py" || lang === "python" ? "python" : lang === "js" || lang === "ts" ? "js" : undefined;
		return none(checkEvalCode(String(input.code ?? input.cell ?? ""), family, ctx, false));
	}
	if (toolName === "browser" || toolName.startsWith("mcp__chrome_devtools_") || toolName.startsWith("mcp__playwright")) {
		const action = String(input.action ?? toolName.replace(/^mcp__(chrome_devtools|playwright)_+/, ""));
		if (BROWSER_WRITE_ACTION.test(action)) return none(refuse(`a browser write (${action})`, `Tool: ${toolName}.`));
		return none(null);
	}
	if (toolName === "write" || toolName === "edit" || toolName === "ast_edit") {
		// git's own files (refs, HEAD, config, hooks) written directly skip every git spelling above.
		for (const p of [input.path, ...(Array.isArray(input.paths) ? input.paths : [])]) {
			if (typeof p === "string" && insideDotGit(resolve(ctx.cwd, p))) return none(refuse(DOT_GIT_WRITE, `Path: ${p}`));
		}
		return none(null);
	}
	return none(null);
}
