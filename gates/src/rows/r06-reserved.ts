// P-11 row 6 (DESIGN-2.0.md:343; SPEC-2.0.md:224-242 § A4): the reserved actions are refused from
// any 2.0 agent — force-push, hard reset, branch or tag deletion, `rm -rf`, DROP/TRUNCATE,
// production database writes, infrastructure teardown, secret rotation, push to a protected branch,
// deploy. Build requirements on the gate: browser writes, and shell reached through `eval`. Also
// reserved (PLAN wl-mv66ylim0gahog § 6.3): switching the GitHub identity gh acts as — `gh auth
// switch|token|login|logout|refresh|setup-git`, a GH_TOKEN/GITHUB_TOKEN assignment, a keychain
// password read — so only Jo's own account can author an issue intake accepts.
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
	{ re: new RegExp(`${GH}api\\b[^\\n]*(?:-X[=\\s]*|--method[=\\s]+)(POST|PUT|PATCH|DELETE)(?![\\w-])`, "i"), why: "gh api with a mutating method" },
	// switching the GitHub identity gh acts as (PLAN wl-mv66ylim0gahog § 6.3): agents run gh as the
	// default account, so an issue only Jo's account can author proves Jo filed it. `gh auth status` stays free.
	{ re: new RegExp(`${GH}auth\\s+(switch|token|login|logout|refresh|setup-git)(?![\\w-])`, "i"), why: "gh auth switching or reading a GitHub account's credentials" },
	{ re: new RegExp(`${GH}auth\\s+status\\b[^\\n]*\\s(?:--show-token|-[a-z]*t[a-z]*)(?![\\w-])`), why: "gh auth status --show-token (prints every account's token)" },
	{ re: /\bsecurity\s+find-(generic|internet)-password\b/i, why: "reading a password from the keychain (security find-generic-password / find-internet-password)" },
];

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
/**
 * Temp paths § A4 exempts from the rm -rf reservation: something under /tmp, $TMPDIR (macOS keeps it
 * under /var/folders) or their /private spellings, with no `..` climbing back out.
 */
const TEMP_PATH = /^(?:\/private)?\/tmp\/[^/]|^(?:\/private)?\/var\/folders\/[^/]|^"?\$\{?TMPDIR\}?"?\/[^/]/;

/** One rm argument: its text, whether its value is unknown until it runs, and whether it is a path inside the own scratch root (scratchPath). */
export interface RmArg {
	text: string;
	unread: boolean;
	glob?: boolean;
	inside?: boolean;
}

/**
 * The rm model (M4 fix round 5): options only from rm's own lists, long ones resolved by GNU prefix
 * rules (`--recu` is `--recursive`), an unknown or ambiguous one refused as unmodeled; recursive plus
 * force on any path outside the temp directories is the § A4 reserved `rm -rf`. An operand inside the
 * own scratch root (`inside`, PLAN wl-mv5oikd5jtquww § 1.2 rule 1) is exempt too; when that exemption
 * is what lets the rm through, "rm" goes into `used`.
 */
export function rmModel(args: RmArg[], used?: Set<string>): { reserved: boolean; why: string } | null {
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
	const notTemp = (o: RmArg): boolean => o.unread || !TEMP_PATH.test(o.text) || o.text.split("/").includes("..");
	if (operands.some((o) => !o.inside && notTemp(o))) return { reserved: true, why: "rm -rf (recursive force-delete) of a path outside the temp directories" };
	if (operands.some((o) => o.inside && notTemp(o))) used?.add("rm");
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

/**
 * The reserved action a shell command text reaches, or null. Quote-blind; runs per `;`/`&`/`|`/newline
 * segment. `skipPrinters` passes segments that start with `echo`/`printf`: the caller has checked
 * their output reaches nothing that runs it (astra review round 2 false positive, `printf "git reset --hard\n"`).
 */
export function reservedInShell(cmd: string, skipPrinters = false, scratch?: Scratch): string | null {
	const c = cmd.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
	if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c)) return "fork bomb";
	for (const seg of c.split(/[;&|\n]+/).map((s) => s.trim()).filter(Boolean)) {
		if (skipPrinters && /^(echo|printf)(\s|$)/.test(seg)) continue;
		if (isRecursiveForceRm(seg, scratch)) return "rm -rf (recursive force-delete)";
		for (const { re, why } of RULES) if (re.test(seg)) return why;
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
 * git's own is unknown and the lexical one is inside the root, and the lifts that hold for it.
 */
function scratchGit(git: GitCall, s: Scratch): { call: GitCall; lift: ScratchLift } {
	const lexical = git.dir === "" && git.dirLexical !== "" && insideRoot(s.root, git.dirLexical);
	const call = lexical ? { ...git, dir: git.dirLexical } : git;
	if (lexical) s.used.add("dirLexical");
	return { call, lift: { repo: call.dir !== "" && repoInside(s.root, call.dir), push: call.dir !== "" && pushToScratch(git, s), used: [] } };
}

/** `lift`'s verdicts set aside, recorded on the call. */
function recordLifts(lift: ScratchLift | undefined, s: Scratch | undefined): void {
	if (lift && s) for (const why of lift.used) s.used.add(`git: ${why}`);
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
	helm: true, npm: true, pnpm: true, yarn: true, bun: true, dd: true, security: true,
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
 * The reserved action one parsed command reaches, or null. `data` are words left out of the final
 * rules match (dataWords). `scratch` turns on the scratch rules 1–3 for a bash call (scratchFor).
 */
function reservedInExec(e: Exec, data?: Set<Word>, scratch?: Scratch): string | null {
	const name = basename(e.argv[0]!.text);
	// A word the shell expands when it runs (a substitution or a glob): its value is not known here.
	const unread = (w: Word): boolean => w.opaque || w.glob === true;
	if (name === "rm") {
		const rm = rmModel(e.argv.slice(1).map((w) => ({ text: w.text, unread: w.opaque, glob: w.glob, inside: scratch !== undefined && scratchPath(w, scratch) !== null })), scratch?.used);
		if (rm?.reserved) return rm.why;
	}
	if (name === "psql") {
		const why = checkProductionPsql(e);
		if (why) return why;
	}
	const git = gitCall(e);
	if (git) {
		if (git.sub === null) return "git with a subcommand not known until it runs";
		if (GIT_ARG_SENSITIVE[git.sub] && git.args.some(unread)) return `git ${git.sub} with an argument not known until it runs`;
		const sg = scratch ? scratchGit(git, scratch) : null;
		const call = sg?.call ?? git;
		if (call.sub === "push" && call.dir === "") return "git push from a directory not known until it runs";
		const v = gitModel(call, sg?.lift);
		if (v?.reserved) return v.why;
		recordLifts(sg?.lift, scratch);
	} else if (HEAD_SENSITIVE[name] && e.argv.slice(1, 4).some(unread)) {
		return `${name} with a subcommand or target not known until it runs`;
	}
	// An infrastructure CLI's verb past its global options (astra-8 B3); an unknown one is refused as unmodeled.
	const infra = infraArgs(e);
	if (infra && "rest" in infra) {
		const bare = execText({ ...e, argv: [e.argv[0]!, ...infra.rest] }).replace(/\n/g, " ");
		for (const { re, why } of RULES) if (re.test(bare)) return why;
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
		if (dotGit) return "writing inside a .git directory (a ref move, or config and hooks git runs later)";
	}
	// A printer's arguments are text. What it feeds (a pipe, a file) the raw pass over the whole
	// command still reads, and a shell reading its output is expanded on its own (src/exec.ts).
	if (OUTPUT_ONLY[name]) return null;
	const text = execText(data ? { ...e, argv: e.argv.filter((w) => !data.has(w)) } : e).replace(/\n/g, " ");
	for (const { re, why } of RULES) if (re.test(text)) return why;
	return null;
}

/** The variables that pick the GitHub account gh acts as (PLAN wl-mv66ylim0gahog § 6.3). */
const GH_IDENTITY_ENV = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/** An assignment of GH_TOKEN or GITHUB_TOKEN anywhere in the command or the tool's env (a bare `export NAME` re-exports what is already there and passes). */
function ghIdentityAssignment(assigned: Map<string, Word[]>): string | null {
	for (const name of GH_IDENTITY_ENV) {
		if ((assigned.get(name) ?? []).some((w) => w.opaque || w.text.includes("="))) return `setting ${name}, which picks the GitHub account gh acts as`;
	}
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
function unmodeledInExec(e: Exec, assigned: Map<string, Word[]>, env: Record<string, string | undefined>, scratch?: Scratch): { what: string; spelling: string } | null {
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
	const sg = call && scratch ? scratchGit(call, scratch) : null;
	const model = call ? gitModel(sg?.call ?? call, sg?.lift) : null;
	recordLifts(sg?.lift, scratch);
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
 * what it spawns. With `spawns` false (the eval tool, once D1 found no process start), only the
 * quote-blind phrase pass and the browser pass run: no process pass can raise a request for eval.
 */
function reservedInCode(code: string, family: CodeFamily | undefined, cwd: string, env: Record<string, string | undefined>, spawns = true): CodeHit | null {
	const facts = codeFacts(code, family);
	for (const t of [facts.folded, facts.folded.replace(/["'`]\s*,\s*["'`]/g, " "), ...facts.literals, ...facts.argvLists]) {
		const why = reservedInShell(t);
		if (why) return { why, detail: "Reached through eval code; eval runs shell and subprocesses the bash gate would otherwise miss." };
	}
	const hit = spawns ? reservedInProcesses(code, facts, family, cwd, env) : null;
	if (hit) return hit;
	const bw = BROWSER_WRITE_CALL.exec(code);
	if (bw) return { why: `a browser write (${bw[1]})`, detail: "Reached through eval's browser API." };
	return null;
}

/** reservedInCode's process passes: the commands the code's processes run, their environment, and their readability. */
function reservedInProcesses(code: string, facts: CodeFacts, family: CodeFamily | undefined, cwd: string, env: Record<string, string | undefined>): CodeHit | null {
	// Literal text that is shell, read the way the shell reads it (`Bun.$\`git "reset" --hard\``), only
	// where the code starts a process: code that starts none cannot run a literal, and a literal that is
	// a file path was being opened and parsed as a script (a MIGRATION.md quoting `kubectl --context X
	// delete` held a read-only eval, MIGRATION.md follow-up 29). The quote-blind pass above still reads it.
	const commands = codeCommands(facts, family);
	const shells = commands === null ? [] : [...facts.literals, ...facts.argvLists].map((t) => ({ t, x: expandShell(t, cwd, env) }));
	for (const { t, x } of shells) {
		for (const e of x.commands) {
			const why = reservedInExec(e);
			if (why) return { why, detail: `Reached through eval code (the string ${JSON.stringify(t.slice(0, 120))}).` };
		}
	}
	// The environment the code gives the processes it starts (astra-8 B2), judged as the bash branch
	// judges it, before the per-literal forms below so its reason names the variable.
	const ienv = codeInterpreterEnv(code, family, cwd, env);
	for (const w of ienv.writes) {
		if (insideDotGit(resolve(cwd, w.text))) return { why: "an interpreter told by its environment to write inside a .git directory (a ref move, or config and hooks git runs later)", detail: "Reached through eval code: a process it starts." };
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

/** Refusals that name a § A4 reserved action, with the action: what a `reserved-request` entry records. */
const RESERVED_ACTION = new WeakMap<object, string>();

/** The § A4 reserved action a row 6 refusal names; null for an unmodeled form, an unreadable command or a process started from eval (respell, not Jo's call). */
export function reservedAction(r: Refusal): string | null {
	return (r && RESERVED_ACTION.get(r)) ?? null;
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

/** A refusal naming a § A4 reserved action: always reserved, so it becomes a `reserved-request` for Jo. */
function refuse(why: string, detail: string): Refusal {
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
	const hit = reservedInCode(code, family, ctx.cwd, ctx.env, false);
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
 * Row 6 over one tool call. A bash call the scratch rules (scratchFor) let through is marked confined
 * for the fence (session.ts markConfined).
 */
export function checkReserved(call: ToolCall, ctx: CallContext): Refusal {
	const { toolName, input } = call;
	if (toolName === "bash") {
		const cmd = bashCommand(input);
		const cwd = typeof input.cwd === "string" ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
		const x = expandShell(cmd, cwd, ctx.env, input.env);
		const scratch = scratchFor(ctx, cmd, x, input.env) ?? undefined;
		const data = dataWords(cmd, x, cwd, ctx.env);
		const raw = reservedInShell(data?.masked ?? cmd, printersOnlyPrint(cmd, cwd, ctx.env), scratch);
		if (raw) return refuse(raw, `Command: ${cmd}`);
		for (const e of x.commands) {
			const why = reservedInExec(e, data?.words, scratch) ?? barePushOfProtected(e, scratch);
			if (why) return refuse(why, `Command: ${cmd}`);
		}
		const identity = ghIdentityAssignment(x.assigned);
		if (identity) return refuse(identity, `Command: ${cmd}`);
		// Files an interpreter writes because of its environment (astra-7 B3): none inside .git.
		const ienv = interpreterEnv(x, cwd);
		for (const w of ienv.writes) {
			if (insideDotGit(resolve(cwd, w.text))) return refuse("an interpreter told by its environment to write inside a .git directory (a ref move, or config and hooks git runs later)", `Command: ${cmd}`);
		}
		if (definesFunction(cmd)) {
			return refuseUnmodeled({ what: "a shell function definition (its body runs later under the function's name, which the gate does not follow)", spelling: "the commands typed out where they run, without a function" }, `Command: ${cmd}`);
		}
		// Item 81 (PLAN wl-mv0n5r9cbafe9s § 2): every alias definition, then every switch that turns alias expansion on.
		const alias = definesAlias(cmd, x) ?? namesAliasSwitch(cmd, input.env, x);
		if (alias) return refuseUnmodeled(alias, `Command: ${cmd}`);
		for (const e of x.commands) {
			const u = unmodeledInExec(e, x.assigned, ctx.env, scratch);
			if (u) return refuseUnmodeled(u, `Command: ${cmd}`);
		}
		if (ienv.unmodeled) return refuseUnmodeled({ what: `${ienv.unmodeled} (an interpreter or loader setting)`, spelling: INTERPRETER_ENV_SPELLING }, `Command: ${cmd}`);
		for (const c of x.code) {
			const hit = reservedInCode(c.text, c.family, c.dir, ctx.env);
			if (!hit) continue;
			const detail = `${hit.detail} Command: ${cmd}`;
			// An unreadable launch in inline code is a respelling, not Jo's call (PLAN wl-muzs0ytnaet1v4 D2).
			return hit.unmodeled ? refuseUnmodeled(hit.unmodeled, detail) : hit.respell ? refuseRespell(hit.why, detail) : refuse(hit.why, detail);
		}
		if (x.blind.length > 0) {
			return refuseRespell("a command the gate cannot read to the end", `${x.blind[0]}. The gate refuses what it cannot see rather than pass it; spell the command out literally. Command: ${cmd}`);
		}
		if (scratch && scratch.used.size > 0) markConfined(call);
		return null;
	}
	if (toolName === "eval") {
		// The eval tool runs JavaScript or Python. Its `language` picks the comment syntax, as in row 10,
		// so a comment is never a command (astra-9 R1).
		const lang = input.language;
		const family = lang === "py" || lang === "python" ? "python" : lang === "js" || lang === "ts" ? "js" : undefined;
		return checkEvalCode(String(input.code ?? input.cell ?? ""), family, ctx, false);
	}
	if (toolName === "browser" || toolName.startsWith("mcp__chrome_devtools_") || toolName.startsWith("mcp__playwright")) {
		const action = String(input.action ?? toolName.replace(/^mcp__(chrome_devtools|playwright)_+/, ""));
		if (BROWSER_WRITE_ACTION.test(action)) return refuse(`a browser write (${action})`, `Tool: ${toolName}.`);
		return null;
	}
	if (toolName === "write" || toolName === "edit" || toolName === "ast_edit") {
		// git's own files (refs, HEAD, config, hooks) written directly skip every git spelling above.
		for (const p of [input.path, ...(Array.isArray(input.paths) ? input.paths : [])]) {
			if (typeof p === "string" && insideDotGit(resolve(ctx.cwd, p))) return refuse("writing inside a .git directory (a ref move, or config and hooks git runs later)", `Path: ${p}`);
		}
		return null;
	}
	return null;
}
