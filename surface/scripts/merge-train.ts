#!/usr/bin/env bun
// merge-train: the merge train's resolver, its order and its stakes (workload wl-mv8s8srodefytc, PLAN § 3, § 1b and
// rev 17.1 D1; the logic is surface/src/merge-train-resolve.ts, surface/src/merge-train-stack.ts and `prStakes` in
// surface/src/merge-train.ts). Run by a train lane: resolve / convert / check from the PR head's worktree, order and
// stakes from anywhere.
//
//   bun surface/scripts/merge-train.ts resolve --pr <n> --workload <wl|none>
//   bun surface/scripts/merge-train.ts convert --pr <n> --workload <wl|none> --base <ref>
//   bun surface/scripts/merge-train.ts check --base <ref>
//   bun surface/scripts/merge-train.ts order --repo <owner/repo> --prs <n>[,<n>…]
//   bun surface/scripts/merge-train.ts stakes [--hold-ok] --repo <owner/repo> --pr <n>
//   bun surface/scripts/merge-train.ts list --workload <wl>
//
// resolve  a merge in progress: MIGRATION.md (the PR's new numbered items become
//          migration/items/<slug>.md, the rest merged 3-way with main), install/manifest.tsv (3-way,
//          add/add rows unioned) and migration/items/* (identical add/add taken), from the stage
//          blobs. Writes, `git add`s and prints each path; the lane commits.
// convert  no merge in progress: moves HEAD's new numbered items (new since `git merge-base HEAD
//          <ref>`) into item files; prints each path written, nothing when there is nothing to do.
// check    exit 0 when HEAD's MIGRATION.md has no numbered item the merge base lacks.
// order    the train's PRs (`trainPrs`, in Jo's order) in the order the train works them: one
//          `gh pr list --state open --limit 1000 --json number,headRefName,isCrossRepository` (a fork's
//          head never counts as a base branch), then one `gh pr view <n>
//          --json number,state,body,baseRefName,headRefName` per train PR and per dependency found.
//          Prints the chain line, then one line of JSON {order, waiting, cycles, chain, unrecorded}.
// stakes   one `gh pr view <n> -R <repo> --json number,headRefName,isCrossRepository,headRepository,headRepositoryOwner`,
//          then the ledger the surface opens ($AGENT_SYSTEM_LEDGER_DB, else $HOME/.agent-system-2/ledger.db), read-only;
//          for a normal PR, then `gh api repos/<repo>/rules/branches/main` (D2: an active rule requires `as2/full-suite`
//          strictly) and `gh api repos/<repo>/rulesets/<id>` per ruleset holding such a rule (one the merging account can
//          never bypass). Prints `normal`, `production: <reason>` or `hold: <reason> until <time|jo>` (`prStakes`,
//          `prStakesLine`; a plan hold, PLAN wl-mvfkv7llkp7nk0 § 3, is printed before main's protection is read: the PR does
//          not merge either way), and `production: main protection unverified (<why>)` when a read fails, the rule is
//          missing or bypassable (`protectionGap`); exit 0 in every case.
//          With --hold-ok (PLAN wl-mvbjiettjrfpxc D5, the brief of every train opened since), a PR whose own stakes are
//          normal prints `hold: main protection unverified (<why>)` instead, and the train passes it over with no question.
// list     the train's members (`trainMembers`: Jo's `train:` and the train tick's `train-board:`, PLAN wl-mvbjiettjrfpxc
//          D5) from the ledger opened read-only, in membership order, one line each: `<n> jo` or `<n> board`. No gh.
//
// --workload is the head branch's workload id when the branch is wl/<wl-…>, else none.
// Exit 0 done; 2 a usage error or a git or gh process failure (or no ledger to open); 3 an unmerged path outside
// MIGRATION.md, install/manifest.tsv and migration/items/*; 4 a conflict it cannot fix without losing an edit.
// Nothing is written on 2, 3 or 4. No push, no ledger write; only order and stakes read the network (gh), and they write nothing.
import { assertNotLiveLedgerUnderTest, defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { HOLD_PREFIX, type PrStakes, prStakes, prStakesLine, protectionGap, type StakesView, trainMembers } from "../src/merge-train";
import { checkItems, convertItems, EXIT_USAGE, type Outcome, resolveMerge, TrainExit, WORKLOAD_RE } from "../src/merge-train-resolve";
import { DEFAULT_BRANCH, headsByBranch, type OpenHead, orderReport, prDeps, type StackPr } from "../src/merge-train-stack";

const USAGE = [
	"usage: merge-train.ts resolve --pr <n> --workload <wl|none>",
	"       merge-train.ts convert --pr <n> --workload <wl|none> --base <ref>",
	"       merge-train.ts check --base <ref>",
	"       merge-train.ts order --repo <owner/repo> --prs <n>[,<n>…]",
	"       merge-train.ts stakes [--hold-ok] --repo <owner/repo> --pr <n>",
	"       merge-train.ts list --workload <wl>",
].join("\n");

const FLAGS: Record<string, string[]> = {
	resolve: ["--pr", "--workload"],
	convert: ["--pr", "--workload", "--base"],
	check: ["--base"],
	order: ["--repo", "--prs"],
	stakes: ["--repo", "--pr"],
	list: ["--workload"],
};
/** Flags that take no value, per command; absent unless given. */
const SWITCHES: Record<string, string[]> = { stakes: ["--hold-ok"] };

/** gh's open-PR page size for `order`: gh lists 30 by default (https://cli.github.com/manual/gh_pr_list), so a stack base could go unmapped. */
const OPEN_LIMIT = 1000;
const PRS_RE = /^#?[1-9][0-9]*(?:[ ,]+#?[1-9][0-9]*)*$/;

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
	const [cmd, ...rest] = argv;
	const allowed = cmd === undefined ? undefined : FLAGS[cmd];
	if (allowed === undefined) throw new TrainExit(USAGE, EXIT_USAGE);
	const flags: Record<string, string> = {};
	for (let i = 0; i < rest.length; i += 2) {
		const [flag, value] = [rest[i]!, rest[i + 1]];
		if (SWITCHES[cmd!]?.includes(flag)) {
			flags[flag] = "";
			i -= 1;
			continue;
		}
		if (!allowed.includes(flag)) throw new TrainExit(`${cmd}: unknown argument ${flag}\n${USAGE}`, EXIT_USAGE);
		if (value === undefined) throw new TrainExit(`${flag} needs a value`, EXIT_USAGE);
		flags[flag] = value;
	}
	const missing = allowed.filter((f) => flags[f] === undefined);
	if (missing.length) throw new TrainExit(`${cmd}: missing ${missing.join(", ")}\n${USAGE}`, EXIT_USAGE);
	if (cmd === "list" && !/^wl-[a-z0-9]+$/.test(flags["--workload"]!)) throw new TrainExit(`--workload must be wl-<id>, got \`${flags["--workload"]}\``, EXIT_USAGE);
	if (flags["--pr"] !== undefined && !/^[1-9][0-9]*$/.test(flags["--pr"])) throw new TrainExit(`--pr must be a PR number, got \`${flags["--pr"]}\``, EXIT_USAGE);
	if (flags["--workload"] !== undefined && !WORKLOAD_RE.test(flags["--workload"])) {
		throw new TrainExit(`--workload must be wl-<id> or none, got \`${flags["--workload"]}\``, EXIT_USAGE);
	}
	if (flags["--repo"] !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flags["--repo"])) throw new TrainExit(`--repo must be <owner>/<repo>, got \`${flags["--repo"]}\``, EXIT_USAGE);
	if (flags["--prs"] !== undefined && !PRS_RE.test(flags["--prs"].trim())) throw new TrainExit(`--prs must be PR numbers, comma-separated, got \`${flags["--prs"]}\``, EXIT_USAGE);
	return { cmd, flags };
}

/** `gh <args>`'s stdout parsed as JSON; a gh failure (a 404, a permission error, a timeout) or a non-JSON answer throws its reason. */
function ghRead(args: string[]): unknown {
	const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
	if (r.exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed: ${r.exitedDueToTimeout ? "timed out" : r.stderr.toString().trim().split("\n").at(-1) || `exit ${r.exitCode}`}`);
	try {
		return JSON.parse(r.stdout.toString());
	} catch {
		throw new Error(`gh ${args.join(" ")} did not return json`);
	}
}

/** `ghRead`, whose failure is exit 2. */
function ghJson(args: string[]): unknown {
	try {
		return ghRead(args);
	} catch (err) {
		throw new TrainExit((err as Error).message, EXIT_USAGE);
	}
}

/** `gh pr view <n> -R <repo> --json number,state,body,baseRefName,headRefName`, checked for shape. */
function viewPr(repo: string, n: number): StackPr & { state: string } {
	const args = ["pr", "view", String(n), "-R", repo, "--json", "number,state,body,baseRefName,headRefName"];
	const v = ghJson(args) as Record<string, unknown> | null;
	if (!v || v.number !== n || typeof v.state !== "string" || typeof v.body !== "string" || typeof v.baseRefName !== "string") {
		throw new TrainExit(`gh ${args.join(" ")} returned an unexpected shape`, EXIT_USAGE);
	}
	return { number: n, state: v.state, body: v.body, baseRefName: v.baseRefName };
}

/** `order` (§ 1b): the open PRs' heads once, each train PR and each dependency it declares once, then the chain line and the report. */
function order(repo: string, prs: number[]): Outcome {
	const listArgs = ["pr", "list", "-R", repo, "--state", "open", "--limit", String(OPEN_LIMIT), "--json", "number,headRefName,isCrossRepository"];
	const open = ghJson(listArgs);
	if (!Array.isArray(open) || open.some((p) => typeof p?.number !== "number" || typeof p?.headRefName !== "string" || typeof p?.isCrossRepository !== "boolean")) {
		throw new TrainExit(`gh ${listArgs.join(" ")} returned an unexpected shape`, EXIT_USAGE);
	}
	const heads = headsByBranch(open as OpenHead[]);
	const views = new Map<number, StackPr & { state: string }>();
	for (const n of prs) views.set(n, viewPr(repo, n));
	for (const n of prs) for (const d of prDeps(views.get(n)!, heads)) if (!views.has(d)) views.set(d, viewPr(repo, d));
	const report = orderReport(prs, views, heads);
	const err = open.length >= OPEN_LIMIT ? [`gh listed ${open.length} open PRs, its --limit: a base branch past them maps to no PR`] : [];
	return { out: [report.chain, JSON.stringify(report)], err };
}

/** The ledger the surface opens ($AGENT_SYSTEM_LEDGER_DB, else $HOME/.agent-system-2/ledger.db), read-only; a failed open is exit 2. */
function openReadOnly(): Ledger {
	const path = defaultLedgerPath(process.env);
	assertNotLiveLedgerUnderTest(path);
	try {
		return Ledger.open(path, { readonly: true });
	} catch (err) {
		throw new TrainExit(`could not open the ledger ${path} (${err instanceof Error ? err.message : String(err)})`, EXIT_USAGE);
	}
}

/**
 * `stakes` (D1, D2; PLAN wl-mvfkv7llkp7nk0 § 3): the PR's head, read once from gh, against the ledger opened read-only, then,
 * for a normal PR, main's protection; `normal`, `production: <reason>` (`production: main protection unverified (<why>)` when
 * it does not hold), or `hold: <reason> until <time|jo>` for a PR whose workload's plan holds it.
 * With `holdOk` (PLAN wl-mvbjiettjrfpxc D5) the unverified protection of a normal PR is `hold: main protection unverified (<why>)`.
 */
function stakes(repo: string, n: number, holdOk: boolean): Outcome {
	const args = ["pr", "view", String(n), "-R", repo, "--json", "number,headRefName,isCrossRepository,headRepository,headRepositoryOwner"];
	const v = ghJson(args) as Record<string, unknown> | null;
	const named = (o: unknown, key: string) => o === null || (typeof o === "object" && typeof (o as Record<string, unknown>)[key] === "string");
	if (!v || v.number !== n || typeof v.headRefName !== "string" || typeof v.isCrossRepository !== "boolean" ||
		!named(v.headRepository ?? null, "name") || !named(v.headRepositoryOwner ?? null, "login")) {
		throw new TrainExit(`gh ${args.join(" ")} returned an unexpected shape`, EXIT_USAGE);
	}
	const ledger = openReadOnly();
	let s: PrStakes;
	try {
		s = prStakes({ ...v, headRepository: v.headRepository ?? null, headRepositoryOwner: v.headRepositoryOwner ?? null } as StakesView, repo, ledger);
	} finally {
		ledger.close();
	}
	if (s.stakes !== "normal") return { out: [prStakesLine(s)], err: [] };
	// main's protection (D2, `protectionGap`, shared with the train tick): a failed read is a reason, never an exit.
	const p = protectionGap(repo, ghRead);
	if (p.state === "ok") return { out: ["normal"], err: [] };
	return { out: [holdOk ? `${HOLD_PREFIX} (${p.text})` : `production: ${DEFAULT_BRANCH} protection unverified (${p.text})`], err: [] };
}

/** `list` (PLAN wl-mvbjiettjrfpxc D5): workload `wl`'s train members, `<n> jo` or `<n> board`, from the ledger read-only; exit 2 for no such workload. */
function list(wl: string): Outcome {
	const ledger = openReadOnly();
	try {
		if (!ledger.workload(wl)) throw new TrainExit(`no workload ${wl}`, EXIT_USAGE);
		return { out: trainMembers(ledger.entries(wl), ledger.instructions(wl)).map((m) => `${m.pr} ${m.source}`), err: [] };
	} finally {
		ledger.close();
	}
}

function main(): number {
	try {
		const { cmd, flags } = parseArgs(process.argv.slice(2));
		let result: Outcome;
		if (cmd === "order") {
			const prs = [...new Set(flags["--prs"]!.trim().split(/[ ,]+/).map((s) => Number(s.replace(/^#/, ""))))];
			result = order(flags["--repo"]!, prs);
		} else if (cmd === "stakes") {
			result = stakes(flags["--repo"]!, Number(flags["--pr"]), flags["--hold-ok"] !== undefined);
		} else if (cmd === "list") {
			result = list(flags["--workload"]!);
		} else {
			const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
			if (top.exitCode !== 0) throw new TrainExit(`not inside a git work tree: ${top.stderr.toString().trim()}`, EXIT_USAGE);
			const repo = top.stdout.toString().trim();
			const pr = Number(flags["--pr"]);
			if (cmd === "resolve") result = resolveMerge(repo, pr, flags["--workload"]!);
			else if (cmd === "convert") result = convertItems(repo, pr, flags["--workload"]!, flags["--base"]!);
			else result = checkItems(repo, flags["--base"]!);
		}
		for (const line of result.err) console.error(line);
		for (const line of result.out) console.log(line);
		return 0;
	} catch (e) {
		if (!(e instanceof TrainExit)) throw e;
		console.error(e.message);
		return e.code;
	}
}

process.exit(main());
